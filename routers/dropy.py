"""Dropy — strona NASZA (zakładka w Magazynie).

Rejestr partnerów, cennik, konta i klucze API, podgląd zamówień, odświeżanie
migawki katalogu. Wszystko siedzi w schemacie `dropy`.

CO JEST GDZIE:
  · ten router  → Magazyn, pełne prawa do bazy, tylko dla nas
  · serwis portalu (osobny katalog `dropy_service/`, osobny serwis na Railway,
    użytkownik bazy `dropy_app`) → partner: katalog, składanie zamówień, API dla
    jego sklepu. Nie importuje NICZEGO z tego repo i nie widzi schematu `public`.

Styk z waszymi danymi jest dokładnie jeden: `dropy.catalog_cache`, migawka SKU,
nazw i stanów, którą odświeża stąd endpoint /api/dropy/catalog/refresh.

Guard: na razie CAŁA zakładka tylko dla super-admina (SUPER_ADMIN_EMAIL).
Gdy dojrzeje, podmieniamy samo `require_dropy` na uprawnienie w ROLE_PERMS.
"""

import hashlib
import secrets
from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import CurrentUser
from security import (
    get_current_user, hash_password, validate_password_strength,
    ALL_SHOPS, parse_company_scope, serialize_company_scope,
)
from services.products import fetch_products

router = APIRouter(prefix="/api", tags=["dropy"])

SCHEMA = "dropy"
VAT = Decimal("1.23")

STATUSES = ("platnosc", "etykieta", "nowe", "przyjete", "spakowane", "wyslane", "anulowane")
PAYMENT_MODES = ("zbiorcza", "przedplata")


# ===== GUARD =====
async def require_dropy(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """Na razie wyłącznie super-admin. Jedno miejsce do poluzowania później."""
    su = (settings.SUPER_ADMIN_EMAIL or "").strip().lower()
    if not su or (user.email or "").strip().lower() != su:
        raise HTTPException(403, "Zakładka Dropy jest na razie dostępna tylko dla super-admina")
    return user


# ===== MODELE =====
class PartnerIn(BaseModel):
    code: str = Field(..., min_length=2, max_length=32)
    name: str = Field(..., min_length=2, max_length=255)
    nip: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    firmy: List[str] = Field(default_factory=list)
    payment_mode: str = "zbiorcza"
    allow_installments: bool = False
    credit_limit: Optional[float] = None
    notes: Optional[str] = None


class PartnerUpdate(BaseModel):
    name: Optional[str] = None
    nip: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    firmy: Optional[List[str]] = None
    payment_mode: Optional[str] = None
    allow_installments: Optional[bool] = None
    credit_limit: Optional[float] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None


class PriceIn(BaseModel):
    sku: str
    price_net: Optional[float] = None    # None = usuń z cennika


class TemplateIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    firma: str
    note: Optional[str] = None
    partner_id: Optional[int] = None              # zapisz cennik tego partnera jako szablon
    with_prices: bool = True                      # False = sam zestaw SKU, bez cen
    items: Optional[List[PriceIn]] = None         # albo wprost lista pozycji


class TemplateRename(BaseModel):
    name: Optional[str] = None
    note: Optional[str] = None


class ApplyIn(BaseModel):
    firma: str
    template_id: Optional[int] = None
    from_partner_id: Optional[int] = None         # kopiuj cennik innego partnera
    mode: str = "fill"                            # replace | fill | update
    adjust_pct: float = 0                         # modyfikator cen z szablonu, np. -3
    markup_pct: Optional[float] = None            # dla pozycji bez ceny: narzut od ceny zakupu


class PortalUserIn(BaseModel):
    email: str = Field(..., min_length=5, max_length=255)
    password: str = Field(..., min_length=8)
    full_name: Optional[str] = None


class PortalUserPatch(BaseModel):
    password: Optional[str] = None
    full_name: Optional[str] = None
    is_active: Optional[bool] = None


class ApiKeyIn(BaseModel):
    label: str = Field(..., min_length=2, max_length=120)


class OrderPatch(BaseModel):
    status: Optional[str] = None
    tracking: Optional[str] = None
    sellasist_order_id: Optional[str] = None
    label_url: Optional[str] = None
    note: Optional[str] = None


# ===== POMOCNICZE =====
def _firmy_out(raw) -> List[str]:
    return parse_company_scope(raw) or []


def _firmy_in(firmy: Optional[List[str]]) -> Optional[str]:
    if firmy is None:
        return None
    picked = parse_company_scope(firmy)
    if not picked:
        raise HTTPException(400, f"Podaj przynajmniej jedną firmę spośród: {', '.join(ALL_SHOPS)}")
    return serialize_company_scope(picked)


def _partner_out(p: dict) -> dict:
    out = dict(p)
    out["firmy"] = _firmy_out(p.get("firmy"))
    out["credit_limit"] = float(p["credit_limit"]) if p.get("credit_limit") is not None else None
    return out


async def _get_partner(db: AsyncSession, pid: int) -> dict:
    r = await db.execute(text(f"SELECT * FROM {SCHEMA}.partners WHERE id = :id"), {"id": pid})
    row = r.mappings().first()
    if not row:
        raise HTTPException(404, "Nie ma takiego partnera")
    return dict(row)


def _month_range(month: str):
    if month:
        try:
            first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, "month musi być w formacie RRRR-MM")
    else:
        today = date.today()
        first = date(today.year, today.month, 1)
    return first, date(first.year + (first.month == 12), (first.month % 12) + 1, 1)


# ===== PARTNERZY =====
@router.get("/dropy/partners")
async def list_partners(
    include_inactive: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_dropy),
):
    """Rejestr partnerów + licznik zamówień z bieżącego miesiąca."""
    where = "" if include_inactive else "WHERE p.is_active = TRUE"
    r = await db.execute(text(
        f"SELECT p.*, COALESCE(o.cnt, 0) AS orders_month, COALESCE(o.net, 0) AS net_month, "
        f"       COALESCE(u.cnt, 0) AS users_count, COALESCE(k.cnt, 0) AS keys_count "
        f"FROM {SCHEMA}.partners p "
        f"LEFT JOIN (SELECT partner_id, COUNT(*) AS cnt, SUM(total_net) AS net FROM {SCHEMA}.orders "
        f"           WHERE status <> 'anulowane' "
        f"             AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE) "
        f"           GROUP BY partner_id) o ON o.partner_id = p.id "
        f"LEFT JOIN (SELECT partner_id, COUNT(*) AS cnt FROM {SCHEMA}.users WHERE is_active GROUP BY partner_id) u "
        f"       ON u.partner_id = p.id "
        f"LEFT JOIN (SELECT partner_id, COUNT(*) AS cnt FROM {SCHEMA}.api_keys WHERE is_active GROUP BY partner_id) k "
        f"       ON k.partner_id = p.id "
        f"{where} ORDER BY p.name"
    ))
    return [{
        **_partner_out(dict(row)),
        "orders_month": int(row["orders_month"]), "net_month": float(row["net_month"]),
        "users_count": int(row["users_count"]), "keys_count": int(row["keys_count"]),
    } for row in r.mappings()]


@router.post("/dropy/partners", status_code=201)
async def create_partner(payload: PartnerIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    if payload.payment_mode not in PAYMENT_MODES:
        raise HTTPException(400, f"payment_mode musi być jednym z: {', '.join(PAYMENT_MODES)}")
    code = payload.code.strip().upper()
    dup = await db.execute(text(f"SELECT id FROM {SCHEMA}.partners WHERE UPPER(code) = :c"), {"c": code})
    if dup.first():
        raise HTTPException(409, f"Partner o kodzie {code} już istnieje")

    r = await db.execute(text(
        f"INSERT INTO {SCHEMA}.partners (code, name, nip, email, phone, address, firmy, payment_mode, "
        f"                               allow_installments, credit_limit, notes) "
        f"VALUES (:code, :name, :nip, :email, :phone, :address, :firmy, :mode, :inst, :lim, :notes) RETURNING *"
    ), {
        "code": code, "name": payload.name.strip(), "nip": payload.nip, "email": payload.email,
        "phone": payload.phone, "address": payload.address, "firmy": _firmy_in(payload.firmy),
        "mode": payload.payment_mode, "inst": payload.allow_installments,
        "lim": payload.credit_limit, "notes": payload.notes,
    })
    row = dict(r.mappings().first())
    await db.commit()
    return _partner_out(row)


@router.patch("/dropy/partners/{pid}")
async def update_partner(pid: int, payload: PartnerUpdate, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    await _get_partner(db, pid)
    fields, params = [], {"id": pid}
    for col in ("name", "nip", "email", "phone", "address", "notes", "is_active", "allow_installments"):
        val = getattr(payload, col)
        if val is not None:
            fields.append(f"{col} = :{col}")
            params[col] = val
    if payload.payment_mode is not None:
        if payload.payment_mode not in PAYMENT_MODES:
            raise HTTPException(400, f"payment_mode musi być jednym z: {', '.join(PAYMENT_MODES)}")
        fields.append("payment_mode = :mode")
        params["mode"] = payload.payment_mode
    if payload.firmy is not None:
        fields.append("firmy = :firmy")
        params["firmy"] = _firmy_in(payload.firmy)
    if "credit_limit" in payload.model_fields_set:
        fields.append("credit_limit = :lim")
        params["lim"] = payload.credit_limit          # None = zdejmij limit
    if not fields:
        return _partner_out(await _get_partner(db, pid))

    fields.append("updated_at = CURRENT_TIMESTAMP")
    r = await db.execute(text(f"UPDATE {SCHEMA}.partners SET {', '.join(fields)} WHERE id = :id RETURNING *"), params)
    row = dict(r.mappings().first())
    await db.commit()
    return _partner_out(row)


# ===== CENNIK =====
@router.get("/dropy/partners/{pid}/prices")
async def get_prices(pid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    await _get_partner(db, pid)
    r = await db.execute(text(
        f"SELECT sku, price_net, updated_at FROM {SCHEMA}.prices WHERE partner_id = :p ORDER BY sku"
    ), {"p": pid})
    return [{"sku": x["sku"], "price_net": float(x["price_net"]), "updated_at": x["updated_at"]} for x in r.mappings()]


@router.put("/dropy/partners/{pid}/prices")
async def set_prices(pid: int, payload: List[PriceIn], db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Wsad cennika. price_net = null usuwa pozycję, czyli produkt znika z katalogu partnera."""
    await _get_partner(db, pid)
    upserts = [p for p in payload if p.price_net is not None]
    deletes = [p.sku.strip() for p in payload if p.price_net is None]

    for p in upserts:
        if p.price_net < 0:
            raise HTTPException(400, f"Ujemna cena dla {p.sku}")
        await db.execute(text(
            f"INSERT INTO {SCHEMA}.prices (partner_id, sku, price_net) VALUES (:p, :sku, :cena) "
            f"ON CONFLICT (partner_id, sku) DO UPDATE SET price_net = EXCLUDED.price_net, updated_at = CURRENT_TIMESTAMP"
        ), {"p": pid, "sku": p.sku.strip(), "cena": p.price_net})
    for sku in deletes:
        await db.execute(text(f"DELETE FROM {SCHEMA}.prices WHERE partner_id = :p AND sku = :sku"), {"p": pid, "sku": sku})
    await db.commit()
    return {"updated": len(upserts), "deleted": len(deletes)}


@router.get("/dropy/partners/{pid}/pricing")
async def pricing_sheet(
    pid: int,
    firma: str = Query(..., description="slug jednej firmy partnera"),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_dropy),
):
    """Arkusz do ustawiania cen: WSZYSTKIE produkty firmy + cena partnera, jeśli już jest.

    Cena zakupu leci z kanonicznego łańcucha (PRODUCT_PRICES_CTE przez fetch_products),
    więc narzut procentowy liczy się od tej samej podstawy co marże w Produktach.
    """
    p = await _get_partner(db, pid)
    firma = (firma or "").strip().lower()
    if firma not in _firmy_out(p.get("firmy")):
        raise HTTPException(403, f"Partner {p['code']} nie kupuje od firmy {firma}")

    r = await db.execute(
        text(f"SELECT LOWER(TRIM(sku)) AS k, price_net FROM {SCHEMA}.prices WHERE partner_id = :p"),
        {"p": pid},
    )
    prices = {x["k"]: float(x["price_net"]) for x in r.mappings()}

    out = []
    for pr in await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, firma):
        cena = prices.get(pr.sku.strip().lower())
        zakup = float(pr.purchase_price or 0)
        out.append({
            "sku": pr.sku, "name": pr.name, "stock": int(pr.stock or 0),
            "purchase_price": zakup, "price_net": cena,
            "markup": round((cena / zakup - 1) * 100, 1) if cena and zakup else None,
        })
    out.sort(key=lambda x: (x["price_net"] is None, x["name"]))
    return {"firma": firma, "rows": out}


# ===== SZABLONY CENNIKÓW =====
# Cennik jest jednocześnie bazą produktów partnera (SKU bez ceny nie istnieje
# w jego katalogu), więc szablon załatwia i „zapisz bazę", i „wczytaj kolejnemu".
# Szablon jest PER FIRMA — SKU trzech firm to rozłączne pule.
@router.get("/dropy/templates")
async def list_templates(firma: str = Query(""), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(
        f"SELECT t.*, COUNT(i.id) AS items, COUNT(i.price_net) AS priced "
        f"FROM {SCHEMA}.price_templates t "
        f"LEFT JOIN {SCHEMA}.price_template_items i ON i.template_id = t.id "
        f"WHERE (:f = '' OR t.firma = :f) "
        f"GROUP BY t.id ORDER BY t.firma, t.name"
    ), {"f": firma.strip().lower()})
    return [{**dict(x), "items": int(x["items"]), "priced": int(x["priced"])} for x in r.mappings()]


@router.get("/dropy/templates/{tid}")
async def get_template(tid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(f"SELECT * FROM {SCHEMA}.price_templates WHERE id = :id"), {"id": tid})
    t = r.mappings().first()
    if not t:
        raise HTTPException(404, "Nie ma takiego szablonu")
    ri = await db.execute(text(
        f"SELECT sku, price_net FROM {SCHEMA}.price_template_items WHERE template_id = :id ORDER BY sku"
    ), {"id": tid})
    return {**dict(t), "items": [
        {"sku": x["sku"], "price_net": float(x["price_net"]) if x["price_net"] is not None else None}
        for x in ri.mappings()
    ]}


@router.post("/dropy/templates", status_code=201)
async def create_template(payload: TemplateIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Zapisuje szablon z cennika partnera albo z podanej listy pozycji."""
    firma = payload.firma.strip().lower()
    if firma not in ALL_SHOPS:
        raise HTTPException(400, f"firma musi być jedną z: {', '.join(ALL_SHOPS)}")

    rows: List[dict] = []
    if payload.partner_id:
        p = await _get_partner(db, payload.partner_id)
        if firma not in _firmy_out(p.get("firmy")):
            raise HTTPException(400, f"Partner {p['code']} nie kupuje od firmy {firma}")
        # Tylko SKU tej firmy — cennik partnera bywa wspólny dla kilku firm.
        r = await db.execute(text(
            f"SELECT pr.sku, pr.price_net FROM {SCHEMA}.prices pr "
            f"JOIN {SCHEMA}.catalog_cache c ON LOWER(TRIM(c.sku)) = LOWER(TRIM(pr.sku)) AND c.firma = :f "
            f"WHERE pr.partner_id = :p"
        ), {"f": firma, "p": payload.partner_id})
        rows = [{"sku": x["sku"], "price_net": float(x["price_net"])} for x in r.mappings()]
    elif payload.items:
        rows = [{"sku": i.sku.strip(), "price_net": i.price_net} for i in payload.items if i.sku.strip()]
    if not rows:
        raise HTTPException(400, "Nie ma czego zapisać — pusty cennik")

    dup = await db.execute(text(
        f"SELECT id FROM {SCHEMA}.price_templates WHERE firma = :f AND LOWER(name) = LOWER(:n)"
    ), {"f": firma, "n": payload.name.strip()})
    if dup.first():
        raise HTTPException(409, f"Szablon „{payload.name.strip()}” dla firmy {firma} już istnieje")

    r = await db.execute(text(
        f"INSERT INTO {SCHEMA}.price_templates (name, firma, note) VALUES (:n, :f, :note) RETURNING id"
    ), {"n": payload.name.strip(), "f": firma, "note": payload.note})
    tid = r.scalar()
    for row in rows:
        await db.execute(text(
            f"INSERT INTO {SCHEMA}.price_template_items (template_id, sku, price_net) VALUES (:t, :s, :c)"
        ), {"t": tid, "s": row["sku"], "c": row["price_net"] if payload.with_prices else None})
    await db.commit()
    return {"id": tid, "name": payload.name.strip(), "firma": firma, "items": len(rows)}


@router.patch("/dropy/templates/{tid}")
async def rename_template(tid: int, payload: TemplateRename, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    fields, params = [], {"id": tid}
    for col in ("name", "note"):
        val = getattr(payload, col)
        if val is not None:
            fields.append(f"{col} = :{col}")
            params[col] = val
    if not fields:
        raise HTTPException(400, "Nie ma czego zmienić")
    fields.append("updated_at = CURRENT_TIMESTAMP")
    r = await db.execute(text(f"UPDATE {SCHEMA}.price_templates SET {', '.join(fields)} WHERE id = :id RETURNING *"), params)
    row = r.mappings().first()
    if not row:
        raise HTTPException(404, "Nie ma takiego szablonu")
    await db.commit()
    return dict(row)


@router.delete("/dropy/templates/{tid}")
async def delete_template(tid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(f"DELETE FROM {SCHEMA}.price_templates WHERE id = :id RETURNING id"), {"id": tid})
    if not r.first():
        raise HTTPException(404, "Nie ma takiego szablonu")
    await db.commit()
    return {"ok": True}


@router.post("/dropy/partners/{pid}/prices/apply")
async def apply_template(pid: int, payload: ApplyIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Wczytuje szablon (albo cennik innego partnera) do cennika partnera.

    Tryby — o nie chodzi, żeby nie skasować komuś wynegocjowanych cen:
      · replace — wyczyść cennik tej firmy i wstaw wszystko z szablonu
      · fill    — dołóż tylko brakujące SKU, istniejące zostaw bez zmian
      · update  — zmień tylko te SKU, które partner już ma
    """
    p = await _get_partner(db, pid)
    firma = payload.firma.strip().lower()
    if firma not in _firmy_out(p.get("firmy")):
        raise HTTPException(403, f"Partner {p['code']} nie kupuje od firmy {firma}")
    if payload.mode not in ("replace", "fill", "update"):
        raise HTTPException(400, "mode musi być jednym z: replace, fill, update")

    if payload.template_id:
        r = await db.execute(text(f"SELECT firma FROM {SCHEMA}.price_templates WHERE id = :id"), {"id": payload.template_id})
        t = r.first()
        if not t:
            raise HTTPException(404, "Nie ma takiego szablonu")
        if t[0] != firma:
            raise HTTPException(400, f"Szablon jest dla firmy {t[0]}, a wczytujesz do {firma}")
        r = await db.execute(text(
            f"SELECT sku, price_net FROM {SCHEMA}.price_template_items WHERE template_id = :id"
        ), {"id": payload.template_id})
    elif payload.from_partner_id:
        src = await _get_partner(db, payload.from_partner_id)
        if firma not in _firmy_out(src.get("firmy")):
            raise HTTPException(400, f"Partner {src['code']} nie kupuje od firmy {firma}")
        r = await db.execute(text(
            f"SELECT pr.sku, pr.price_net FROM {SCHEMA}.prices pr "
            f"JOIN {SCHEMA}.catalog_cache c ON LOWER(TRIM(c.sku)) = LOWER(TRIM(pr.sku)) AND c.firma = :f "
            f"WHERE pr.partner_id = :p"
        ), {"f": firma, "p": payload.from_partner_id})
    else:
        raise HTTPException(400, "Podaj template_id albo from_partner_id")

    src_rows = [{"sku": x["sku"], "price_net": float(x["price_net"]) if x["price_net"] is not None else None}
                for x in r.mappings()]
    if not src_rows:
        raise HTTPException(400, "Źródło jest puste")

    # Pozycje bez ceny (szablon-baza) wyceniamy narzutem od ceny zakupu.
    need_cost = any(row["price_net"] is None for row in src_rows)
    costs: dict = {}
    if need_cost:
        if payload.markup_pct is None:
            raise HTTPException(400, "Szablon nie ma cen — podaj markup_pct, żeby je wyliczyć")
        for pr in await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, firma):
            costs[pr.sku.strip().lower()] = float(pr.purchase_price or 0)

    r = await db.execute(text(f"SELECT LOWER(TRIM(sku)) AS k FROM {SCHEMA}.prices WHERE partner_id = :p"), {"p": pid})
    existing = {x["k"] for x in r.mappings()}

    if payload.mode == "replace":
        await db.execute(text(
            f"DELETE FROM {SCHEMA}.prices WHERE partner_id = :p AND LOWER(TRIM(sku)) IN "
            f"(SELECT LOWER(TRIM(sku)) FROM {SCHEMA}.catalog_cache WHERE firma = :f)"
        ), {"p": pid, "f": firma})
        existing = set()

    factor = 1 + (payload.adjust_pct or 0) / 100
    written, skipped = 0, 0
    for row in src_rows:
        key = row["sku"].strip().lower()
        if payload.mode == "fill" and key in existing:
            skipped += 1
            continue
        if payload.mode == "update" and key not in existing:
            skipped += 1
            continue
        cena = row["price_net"]
        if cena is None:
            zakup = costs.get(key, 0)
            if zakup <= 0:
                skipped += 1
                continue
            cena = zakup * (1 + (payload.markup_pct or 0) / 100)
        cena = round(cena * factor, 2)
        await db.execute(text(
            f"INSERT INTO {SCHEMA}.prices (partner_id, sku, price_net) VALUES (:p, :s, :c) "
            f"ON CONFLICT (partner_id, sku) DO UPDATE SET price_net = EXCLUDED.price_net, updated_at = CURRENT_TIMESTAMP"
        ), {"p": pid, "s": row["sku"].strip(), "c": cena})
        written += 1
    await db.commit()
    return {"written": written, "skipped": skipped, "mode": payload.mode, "firma": firma}


# ===== KONTA PORTALU =====
@router.get("/dropy/partners/{pid}/users")
async def list_portal_users(pid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    await _get_partner(db, pid)
    r = await db.execute(text(
        f"SELECT id, email, full_name, is_active, last_login, created_at FROM {SCHEMA}.users "
        f"WHERE partner_id = :p ORDER BY email"
    ), {"p": pid})
    return [dict(x) for x in r.mappings()]


@router.post("/dropy/partners/{pid}/users", status_code=201)
async def create_portal_user(pid: int, payload: PortalUserIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Konto dropa do portalu. Osobna tabela, osobny serwis — nie ma wstępu do Magazynu."""
    await _get_partner(db, pid)
    err = validate_password_strength(payload.password)
    if err:
        raise HTTPException(400, err)
    dup = await db.execute(text(f"SELECT id FROM {SCHEMA}.users WHERE LOWER(email) = LOWER(:e)"), {"e": payload.email.strip()})
    if dup.first():
        raise HTTPException(409, "Takie konto już istnieje")

    r = await db.execute(text(
        f"INSERT INTO {SCHEMA}.users (partner_id, email, password_hash, full_name) "
        f"VALUES (:p, :e, :h, :n) RETURNING id, email, full_name, is_active, created_at"
    ), {"p": pid, "e": payload.email.strip().lower(), "h": hash_password(payload.password), "n": payload.full_name})
    row = dict(r.mappings().first())
    await db.commit()
    return row


@router.patch("/dropy/users/{uid}")
async def patch_portal_user(uid: int, payload: PortalUserPatch, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    fields, params = [], {"id": uid}
    if payload.password is not None:
        err = validate_password_strength(payload.password)
        if err:
            raise HTTPException(400, err)
        fields.append("password_hash = :h")
        params["h"] = hash_password(payload.password)
    for col in ("full_name", "is_active"):
        val = getattr(payload, col)
        if val is not None:
            fields.append(f"{col} = :{col}")
            params[col] = val
    if not fields:
        raise HTTPException(400, "Nie ma czego zmienić")
    r = await db.execute(text(
        f"UPDATE {SCHEMA}.users SET {', '.join(fields)} WHERE id = :id "
        f"RETURNING id, email, full_name, is_active, last_login"
    ), params)
    row = r.mappings().first()
    if not row:
        raise HTTPException(404, "Nie ma takiego konta")
    await db.commit()
    return dict(row)


# ===== KLUCZE API =====
@router.get("/dropy/partners/{pid}/keys")
async def list_keys(pid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    await _get_partner(db, pid)
    r = await db.execute(text(
        f"SELECT id, label, key_hint, is_active, last_used, created_at FROM {SCHEMA}.api_keys "
        f"WHERE partner_id = :p ORDER BY created_at DESC"
    ), {"p": pid})
    return [dict(x) for x in r.mappings()]


@router.post("/dropy/partners/{pid}/keys", status_code=201)
async def create_key(pid: int, payload: ApiKeyIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Nowy klucz dla sklepu partnera. Sam klucz pokazujemy RAZ — w bazie zostaje tylko hash."""
    p = await _get_partner(db, pid)
    raw = f"drp_{p['code'].lower().replace('-', '')}_{secrets.token_urlsafe(32)}"
    digest = hashlib.sha256(raw.encode()).hexdigest()
    r = await db.execute(text(
        f"INSERT INTO {SCHEMA}.api_keys (partner_id, label, key_hash, key_hint) "
        f"VALUES (:p, :l, :h, :hint) RETURNING id, label, key_hint, created_at"
    ), {"p": pid, "l": payload.label.strip(), "h": digest, "hint": raw[-4:]})
    row = dict(r.mappings().first())
    await db.commit()
    return {**row, "key": raw, "uwaga": "Skopiuj teraz — drugi raz tego klucza nie pokażemy"}


@router.delete("/dropy/keys/{kid}")
async def revoke_key(kid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(f"UPDATE {SCHEMA}.api_keys SET is_active = FALSE WHERE id = :id RETURNING id"), {"id": kid})
    if not r.first():
        raise HTTPException(404, "Nie ma takiego klucza")
    await db.commit()
    return {"ok": True}


# ===== MIGAWKA KATALOGU =====
@router.post("/dropy/catalog/refresh")
async def refresh_catalog(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Przelicza dropy.catalog_cache dla wszystkich trzech firm.

    To JEDYNE miejsce, w którym dane Magazynu wchodzą do świata dropów. Serwis portalu
    czyta wyłącznie tę migawkę i nie ma praw do schematu public.
    Docelowo wołane z crona, na razie ręcznie przyciskiem w zakładce.
    """
    total = 0
    for slug in ALL_SHOPS:
        products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, slug)
        for pr in products:
            await db.execute(text(
                f"INSERT INTO {SCHEMA}.catalog_cache (sku, firma, name, stock, in_transit, updated_at) "
                f"VALUES (:sku, :firma, :name, :stock, :transit, CURRENT_TIMESTAMP) "
                f"ON CONFLICT (sku, firma) DO UPDATE SET name = EXCLUDED.name, stock = EXCLUDED.stock, "
                f"  in_transit = EXCLUDED.in_transit, updated_at = CURRENT_TIMESTAMP"
            ), {
                "sku": pr.sku, "firma": slug, "name": pr.name,
                "stock": int(pr.stock or 0), "transit": int(pr.stock_in_transit or 0),
            })
            total += 1
    await db.commit()
    return {"refreshed": total, "firmy": list(ALL_SHOPS)}


# ===== ZAMÓWIENIA (podgląd i obsługa po naszej stronie) =====
def _order_out(o: dict, items: List[dict]) -> dict:
    return {
        **{k: v for k, v in o.items() if k not in ("total_net", "total_gross")},
        "total_net": float(o["total_net"] or 0),
        "total_gross": float(o["total_gross"] or 0),
        "items": [
            {"sku": i["sku"], "name": i["name"], "qty": int(i["qty"]), "price_net": float(i["price_net"])}
            for i in items
        ],
    }


@router.get("/dropy/orders")
async def list_orders(
    partner_id: Optional[int] = None,
    firma: str = Query(""),
    status: str = Query(""),
    month: str = Query("", description="RRRR-MM; puste = bieżący miesiąc"),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_dropy),
):
    first, nxt = _month_range(month)
    r = await db.execute(text(
        f"SELECT o.*, p.code AS partner_code, p.name AS partner_name "
        f"FROM {SCHEMA}.orders o JOIN {SCHEMA}.partners p ON p.id = o.partner_id "
        f"WHERE o.created_at >= :od AND o.created_at < :do_ "
        f"  AND (CAST(:pid AS INTEGER) IS NULL OR o.partner_id = CAST(:pid AS INTEGER)) "
        f"  AND (:firma = '' OR o.firma = :firma) "
        f"  AND (:status = '' OR o.status = :status) "
        f"ORDER BY o.created_at DESC, o.id DESC"
    ), {"od": first, "do_": nxt, "pid": partner_id, "firma": firma.strip().lower(), "status": status.strip()})
    orders = [dict(x) for x in r.mappings()]
    if not orders:
        return []

    ri = await db.execute(
        text(f"SELECT * FROM {SCHEMA}.order_items WHERE order_id = ANY(:ids) ORDER BY id"),
        {"ids": [o["id"] for o in orders]},
    )
    by_order: dict = {}
    for it in ri.mappings():
        by_order.setdefault(it["order_id"], []).append(dict(it))
    return [_order_out(o, by_order.get(o["id"], [])) for o in orders]


@router.get("/dropy/orders/{oid}")
async def get_order(oid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(
        f"SELECT o.*, p.code AS partner_code, p.name AS partner_name "
        f"FROM {SCHEMA}.orders o JOIN {SCHEMA}.partners p ON p.id = o.partner_id WHERE o.id = :id"
    ), {"id": oid})
    o = r.mappings().first()
    if not o:
        raise HTTPException(404, "Nie ma takiego zamówienia")
    ri = await db.execute(text(f"SELECT * FROM {SCHEMA}.order_items WHERE order_id = :id ORDER BY id"), {"id": oid})
    return _order_out(dict(o), [dict(x) for x in ri.mappings()])


@router.patch("/dropy/orders/{oid}")
async def patch_order(oid: int, payload: OrderPatch, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Ręczna zmiana statusu, przesyłki, ID w Sellasist albo etykiety.

    Wgranie etykiety do zamówienia czekającego na etykietę samo je odblokowuje.
    """
    r = await db.execute(text(f"SELECT status FROM {SCHEMA}.orders WHERE id = :id"), {"id": oid})
    cur = r.mappings().first()
    if not cur:
        raise HTTPException(404, "Nie ma takiego zamówienia")

    fields, params = [], {"id": oid}
    if payload.status is not None:
        if payload.status not in STATUSES:
            raise HTTPException(400, f"status musi być jednym z: {', '.join(STATUSES)}")
        fields.append("status = :status")
        params["status"] = payload.status
    for col, val in (("tracking", payload.tracking), ("sellasist_order_id", payload.sellasist_order_id),
                     ("label_url", payload.label_url), ("note", payload.note)):
        if val is not None:
            fields.append(f"{col} = :{col}")
            params[col] = val
    if payload.label_url and payload.status is None and cur["status"] == "etykieta":
        fields.append("status = :status")
        params["status"] = "nowe"
    if not fields:
        return await get_order(oid, db, user)

    fields.append("updated_at = CURRENT_TIMESTAMP")
    await db.execute(text(f"UPDATE {SCHEMA}.orders SET {', '.join(fields)} WHERE id = :id"), params)
    await db.commit()
    return await get_order(oid, db, user)


# ===== PODSUMOWANIE MIESIĄCA =====
@router.get("/dropy/summary")
async def summary(
    partner_id: Optional[int] = None,
    month: str = Query(""),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_dropy),
):
    """Miesiąc per partner i firma — podstawa faktur zbiorczych."""
    first, nxt = _month_range(month)
    r = await db.execute(text(
        f"SELECT o.partner_id, p.code AS partner_code, p.name AS partner_name, o.firma, "
        f"       COUNT(*) AS orders, SUM(o.total_net) AS net, SUM(o.total_gross) AS gross, "
        f"       COUNT(*) FILTER (WHERE o.cod) AS cod_orders, "
        f"       COUNT(*) FILTER (WHERE o.status IN ('platnosc', 'etykieta')) AS blocked, "
        f"       COUNT(*) FILTER (WHERE o.sellasist_order_id IS NULL AND o.status NOT IN ('platnosc', 'etykieta')) AS to_push "
        f"FROM {SCHEMA}.orders o JOIN {SCHEMA}.partners p ON p.id = o.partner_id "
        f"WHERE o.created_at >= :od AND o.created_at < :do_ AND o.status <> 'anulowane' "
        f"  AND (CAST(:pid AS INTEGER) IS NULL OR o.partner_id = CAST(:pid AS INTEGER)) "
        f"GROUP BY o.partner_id, p.code, p.name, o.firma ORDER BY p.name, o.firma"
    ), {"od": first, "do_": nxt, "pid": partner_id})
    return {
        "month": first.strftime("%Y-%m"),
        "rows": [{
            "partner_id": x["partner_id"], "partner_code": x["partner_code"], "partner_name": x["partner_name"],
            "firma": x["firma"], "orders": int(x["orders"]), "net": float(x["net"] or 0),
            "gross": float(x["gross"] or 0), "cod_orders": int(x["cod_orders"]),
            "blocked": int(x["blocked"]), "to_push": int(x["to_push"]),
        } for x in r.mappings()],
    }
