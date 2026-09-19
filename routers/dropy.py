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

Logi: każda zmiana (nasza i partnera) zostawia gotowe zdanie w dropy.activity_log,
w tej samej transakcji co zmiana. Czytamy je endpointem /api/dropy/activity.

Guard: na razie CAŁA zakładka tylko dla super-admina (SUPER_ADMIN_EMAIL).
Gdy dojrzeje, podmieniamy samo `require_dropy` na uprawnienie w ROLE_PERMS.
"""

import hashlib
import json
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
from services.sellasist import push_drop_order, SellasistError

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
    bill_street: Optional[str] = None          # adres na fakturę — leci jako płatnik do Sellasista
    bill_home_number: Optional[str] = None
    bill_postcode: Optional[str] = None
    bill_city: Optional[str] = None
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
    bill_street: Optional[str] = None
    bill_home_number: Optional[str] = None
    bill_postcode: Optional[str] = None
    bill_city: Optional[str] = None
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


class InvoiceIn(BaseModel):
    partner_id: int
    firma: str
    nr: str
    okres: Optional[str] = None
    issued_at: Optional[str] = None          # RRRR-MM-DD
    due_date: Optional[str] = None
    total_gross: float
    pdf_url: Optional[str] = None
    note: Optional[str] = None


class InvoiceAttach(BaseModel):
    order_ids: List[int]


class PaymentIn(BaseModel):
    partner_id: int
    invoice_id: Optional[int] = None
    paid_date: str
    amount: float
    note: Optional[str] = None


class OrderPatch(BaseModel):
    status: Optional[str] = None
    tracking: Optional[str] = None
    sellasist_order_id: Optional[str] = None
    label_url: Optional[str] = None
    remove_label: bool = False                # True = usuń etykietę partnera
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


# ===== LOGI =====
# Zdanie składamy w chwili zdarzenia, podmiot zawsze rodzaju męskiego
# („Użytkownik …”, „System …”), więc forma czasownika pasuje niezależnie od osoby.
FIRMA_LABEL = {"amh": "AMH", "acti": "Acti4med", "veluxa": "Veluxa"}
STATUS_LABEL = {
    "platnosc": "Czeka na płatność", "etykieta": "Czeka na etykietę", "nowe": "Nowe",
    "przyjete": "Przyjęte", "spakowane": "Spakowane", "wyslane": "Wysłane", "anulowane": "Anulowane",
}
PARTNER_FIELDS = {
    "name": "nazwa", "nip": "NIP", "email": "e-mail", "phone": "telefon", "address": "adres",
    "bill_street": "ulica (faktura)", "bill_home_number": "nr domu (faktura)",
    "bill_postcode": "kod (faktura)", "bill_city": "miasto (faktura)", "firmy": "firmy",
    "payment_mode": "tryb płatności", "allow_installments": "raty", "credit_limit": "limit kupiecki",
    "is_active": "aktywny", "notes": "notatki",
}
MODE_LABEL = {"replace": "zastąp wszystko", "fill": "dołóż brakujące", "update": "zmień istniejące"}


def _zl(v) -> str:
    s = f"{float(v or 0):,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} zł"


def _plural(n: int, one: str, few: str, many: str) -> str:
    if n == 1:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def _actor(user: Optional[CurrentUser]) -> str:
    if not user:
        return "System"
    return (user.full_name or "").strip() or user.email


def _kto(user: Optional[CurrentUser]) -> str:
    return f"Użytkownik {_actor(user)}" if user else "System"


def _fmt(col: str, v) -> str:
    if v is None or v == "":
        return "—"
    if col == "credit_limit":
        return _zl(v)
    if col == "firmy":
        return ", ".join(FIRMA_LABEL.get(f, f) for f in _firmy_out(v)) or "—"
    if isinstance(v, bool):
        return "tak" if v else "nie"
    if col == "status":
        return STATUS_LABEL.get(v, v)
    return str(v)


async def _log(db: AsyncSession, user: Optional[CurrentUser], action: str, message: str, *,
               partner_id: Optional[int] = None, order_nr: Optional[str] = None,
               changes: Optional[dict] = None):
    """Wpis do logów dropów. BEZ commita — idzie razem ze zmianą."""
    ch = json.dumps(changes, ensure_ascii=False,
                    default=lambda v: float(v) if isinstance(v, Decimal) else str(v)) if changes else None
    await db.execute(text(
        f"INSERT INTO {SCHEMA}.activity_log (partner_id, source, actor, actor_user_id, action, order_nr, message, changes) "
        f"VALUES (:p, :src, :actor, :uid, :action, :nr, :msg, CAST(:ch AS JSONB))"
    ), {"p": partner_id, "src": "magazyn" if user else "system", "actor": _actor(user)[:255],
        "uid": user.id if user else None, "action": action, "nr": order_nr, "msg": message, "ch": ch})


def _plabel(p: dict) -> str:
    return f"{p['code']} ({p['name']})"


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
        f"INSERT INTO {SCHEMA}.partners (code, name, nip, email, phone, address, bill_street, "
        f"                               bill_home_number, bill_postcode, bill_city, firmy, payment_mode, "
        f"                               allow_installments, credit_limit, notes) "
        f"VALUES (:code, :name, :nip, :email, :phone, :address, :bstreet, :bhome, :bpost, :bcity, "
        f"        :firmy, :mode, :inst, :lim, :notes) RETURNING *"
    ), {
        "code": code, "name": payload.name.strip(), "nip": payload.nip, "email": payload.email,
        "phone": payload.phone, "address": payload.address,
        "bstreet": payload.bill_street, "bhome": payload.bill_home_number,
        "bpost": payload.bill_postcode, "bcity": payload.bill_city,
        "firmy": _firmy_in(payload.firmy),
        "mode": payload.payment_mode, "inst": payload.allow_installments,
        "lim": payload.credit_limit, "notes": payload.notes,
    })
    row = dict(r.mappings().first())
    await _log(db, user, "partner_created", f"{_kto(user)} dodał partnera {_plabel(row)}", partner_id=row["id"])
    await db.commit()
    return _partner_out(row)


@router.patch("/dropy/partners/{pid}")
async def update_partner(pid: int, payload: PartnerUpdate, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    before = await _get_partner(db, pid)
    fields, params = [], {"id": pid}
    for col in ("name", "nip", "email", "phone", "address", "notes", "is_active", "allow_installments",
                "bill_street", "bill_home_number", "bill_postcode", "bill_city"):
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

    # Tylko to, co faktycznie się zmieniło — zapis tego samego nie robi wpisu.
    diff = {}
    for col in PARTNER_FIELDS:
        old, new = before.get(col), row.get(col)
        if col == "credit_limit":
            old = float(old) if old is not None else None
            new = float(new) if new is not None else None
        if col == "firmy":
            old, new = _firmy_out(old), _firmy_out(new)
        if old != new:
            diff[col] = [old, new]
    if diff:
        if list(diff) == ["is_active"]:
            tekst = f"{_kto(user)} {'aktywował' if row['is_active'] else 'dezaktywował'} partnera {_plabel(row)}"
        else:
            zmiany = "; ".join(f"{PARTNER_FIELDS[c]}: {_fmt(c, o)} → {_fmt(c, n)}"
                               for c, (o, n) in diff.items() if c != "notes")
            if "notes" in diff:
                zmiany = (zmiany + "; " if zmiany else "") + "notatki"
            tekst = f"{_kto(user)} zmienił dane partnera {_plabel(row)}: {zmiany}"
        await _log(db, user, "partner_updated", tekst, partner_id=pid, changes=diff)
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
    partner = await _get_partner(db, pid)
    upserts = [p for p in payload if p.price_net is not None]
    deletes = [p.sku.strip() for p in payload if p.price_net is None]

    r = await db.execute(text(f"SELECT sku, price_net FROM {SCHEMA}.prices WHERE partner_id = :p"), {"p": pid})
    old = {x["sku"]: float(x["price_net"]) for x in r.mappings()}

    for p in upserts:
        if p.price_net < 0:
            raise HTTPException(400, f"Ujemna cena dla {p.sku}")
        await db.execute(text(
            f"INSERT INTO {SCHEMA}.prices (partner_id, sku, price_net) VALUES (:p, :sku, :cena) "
            f"ON CONFLICT (partner_id, sku) DO UPDATE SET price_net = EXCLUDED.price_net, updated_at = CURRENT_TIMESTAMP"
        ), {"p": pid, "sku": p.sku.strip(), "cena": p.price_net})
    for sku in deletes:
        await db.execute(text(f"DELETE FROM {SCHEMA}.prices WHERE partner_id = :p AND sku = :sku"), {"p": pid, "sku": sku})

    diff = {}
    for p in upserts:
        sku = p.sku.strip()
        if old.get(sku) != round(float(p.price_net), 2):
            diff[sku] = [old.get(sku), round(float(p.price_net), 2)]
    for sku in deletes:
        if sku in old:
            diff[sku] = [old[sku], None]
    if diff:
        n = len(diff)
        if n <= 3:
            opis = "; ".join(f"{sku}: {_zl(o) if o is not None else 'brak'} → {_zl(nw) if nw is not None else 'usunięty'}"
                             for sku, (o, nw) in diff.items())
        else:
            dod = sum(1 for o, _ in diff.values() if o is None)
            usu = sum(1 for _, nw in diff.values() if nw is None)
            zm = n - dod - usu
            czesci = [f"{x} {w}" for x, w in ((dod, "nowych"), (zm, "zmienionych"), (usu, "usuniętych")) if x]
            opis = f"{n} {_plural(n, 'pozycja', 'pozycje', 'pozycji')} ({', '.join(czesci)})"
        await _log(db, user, "prices_changed", f"{_kto(user)} zmienił cennik partnera {_plabel(partner)}: {opis}",
                   partner_id=pid, changes=diff)
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
    zrodlo = ""
    if payload.partner_id:
        zrodlo = f" z cennika partnera {_plabel(p)}"
    await _log(db, user, "template_created",
               f"{_kto(user)} zapisał szablon cennika „{payload.name.strip()}” ({FIRMA_LABEL.get(firma, firma)}, "
               f"{len(rows)} {_plural(len(rows), 'pozycja', 'pozycje', 'pozycji')}){zrodlo}",
               partner_id=payload.partner_id)
    await db.commit()
    return {"id": tid, "name": payload.name.strip(), "firma": firma, "items": len(rows)}


@router.patch("/dropy/templates/{tid}")
async def rename_template(tid: int, payload: TemplateRename, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(f"SELECT name, note FROM {SCHEMA}.price_templates WHERE id = :id"), {"id": tid})
    before = r.mappings().first()
    if not before:
        raise HTTPException(404, "Nie ma takiego szablonu")
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
    if row["name"] != before["name"]:
        await _log(db, user, "template_updated",
                   f"{_kto(user)} zmienił nazwę szablonu „{before['name']}” na „{row['name']}”",
                   changes={"name": [before["name"], row["name"]]})
    elif row["note"] != before["note"]:
        await _log(db, user, "template_updated", f"{_kto(user)} zmienił opis szablonu „{row['name']}”",
                   changes={"note": [before["note"], row["note"]]})
    await db.commit()
    return dict(row)


@router.delete("/dropy/templates/{tid}")
async def delete_template(tid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(f"DELETE FROM {SCHEMA}.price_templates WHERE id = :id RETURNING name, firma"), {"id": tid})
    t = r.mappings().first()
    if not t:
        raise HTTPException(404, "Nie ma takiego szablonu")
    await _log(db, user, "template_deleted",
               f"{_kto(user)} usunął szablon cennika „{t['name']}” ({FIRMA_LABEL.get(t['firma'], t['firma'])})")
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
        r = await db.execute(text(f"SELECT firma, name FROM {SCHEMA}.price_templates WHERE id = :id"), {"id": payload.template_id})
        t = r.first()
        if not t:
            raise HTTPException(404, "Nie ma takiego szablonu")
        zrodlo = f"szablon „{t[1]}”"
        if t[0] != firma:
            raise HTTPException(400, f"Szablon jest dla firmy {t[0]}, a wczytujesz do {firma}")
        r = await db.execute(text(
            f"SELECT sku, price_net FROM {SCHEMA}.price_template_items WHERE template_id = :id"
        ), {"id": payload.template_id})
    elif payload.from_partner_id:
        src = await _get_partner(db, payload.from_partner_id)
        zrodlo = f"cennik partnera {_plabel(src)}"
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

    dodatki = []
    if payload.adjust_pct:
        dodatki.append(f"korekta {payload.adjust_pct:+g}%")
    if need_cost:
        dodatki.append(f"narzut {payload.markup_pct:g}% dla pozycji bez ceny")
    await _log(db, user, "prices_applied",
               f"{_kto(user)} wczytał {zrodlo} do cennika partnera {_plabel(p)} "
               f"({FIRMA_LABEL.get(firma, firma)}, tryb: {MODE_LABEL[payload.mode]}"
               f"{', ' + ', '.join(dodatki) if dodatki else ''}): zapisano {written}, pominięto {skipped}",
               partner_id=pid, changes={"firma": firma, "mode": payload.mode, "written": written, "skipped": skipped,
                                        "adjust_pct": payload.adjust_pct, "markup_pct": payload.markup_pct})
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
    partner = await _get_partner(db, pid)
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
    await _log(db, user, "portal_user_created",
               f"{_kto(user)} założył konto portalu {row['email']} dla partnera {_plabel(partner)}", partner_id=pid)
    await db.commit()
    return row


@router.patch("/dropy/users/{uid}")
async def patch_portal_user(uid: int, payload: PortalUserPatch, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(
        f"SELECT u.email, u.full_name, u.is_active, u.partner_id, p.code, p.name "
        f"FROM {SCHEMA}.users u JOIN {SCHEMA}.partners p ON p.id = u.partner_id WHERE u.id = :id"
    ), {"id": uid})
    before = r.mappings().first()
    if not before:
        raise HTTPException(404, "Nie ma takiego konta")
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

    konto = f"konta portalu {before['email']} (partner {before['code']})"
    zdania = []
    if payload.password is not None:
        zdania.append(f"zmienił hasło do {konto}")
    if payload.is_active is not None and payload.is_active != before["is_active"]:
        zdania.append(f"{'odblokował' if payload.is_active else 'zablokował'} dostęp do {konto}")
    if payload.full_name is not None and payload.full_name != before["full_name"]:
        zdania.append(f"zmienił nazwę {konto}: {before['full_name'] or '—'} → {payload.full_name or '—'}")
    if zdania:
        await _log(db, user, "portal_user_updated", f"{_kto(user)} " + ", ".join(zdania),
                   partner_id=before["partner_id"],
                   changes={"password_changed": payload.password is not None,
                            "is_active": [before["is_active"], row["is_active"]],
                            "full_name": [before["full_name"], row["full_name"]]})
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
    await _log(db, user, "api_key_created",
               f"{_kto(user)} wygenerował klucz API „{row['label']}” (…{row['key_hint']}) dla partnera {_plabel(p)}",
               partner_id=pid)
    await db.commit()
    return {**row, "key": raw, "uwaga": "Skopiuj teraz — drugi raz tego klucza nie pokażemy"}


@router.delete("/dropy/keys/{kid}")
async def revoke_key(kid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(
        f"UPDATE {SCHEMA}.api_keys k SET is_active = FALSE FROM {SCHEMA}.partners p "
        f"WHERE k.id = :id AND p.id = k.partner_id RETURNING k.partner_id, k.label, k.key_hint, p.code, p.name"
    ), {"id": kid})
    k = r.mappings().first()
    if not k:
        raise HTTPException(404, "Nie ma takiego klucza")
    await _log(db, user, "api_key_revoked",
               f"{_kto(user)} unieważnił klucz API „{k['label']}” (…{k['key_hint']}) partnera {k['code']} ({k['name']})",
               partner_id=k["partner_id"])
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
        # Stawka VAT per SKU — z najświeższej pozycji zamówienia w tym sklepie.
        # To jedyne miejsce, gdzie mamy prawdziwy VAT (Acti ma głównie 8%).
        rv = await db.execute(text(
            f"SELECT DISTINCT ON (LOWER(TRIM(symbol))) LOWER(TRIM(symbol)) AS k, tax_rate "
            f"FROM {settings.TABLE_ORDER_ITEMS} "
            f"WHERE shop = :shop AND symbol IS NOT NULL AND tax_rate IS NOT NULL "
            f"ORDER BY LOWER(TRIM(symbol)), order_date DESC NULLS LAST"
        ), {"shop": slug})
        vats = {x["k"]: float(x["tax_rate"]) for x in rv.mappings()}

        products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, slug)
        for pr in products:
            await db.execute(text(
                f"INSERT INTO {SCHEMA}.catalog_cache (sku, firma, name, stock, in_transit, photo_id, photo_hash, vat, updated_at) "
                f"VALUES (:sku, :firma, :name, :stock, :transit, :pid, :phash, :vat, CURRENT_TIMESTAMP) "
                f"ON CONFLICT (sku, firma) DO UPDATE SET name = EXCLUDED.name, stock = EXCLUDED.stock, "
                f"  in_transit = EXCLUDED.in_transit, photo_id = EXCLUDED.photo_id, "
                f"  photo_hash = EXCLUDED.photo_hash, vat = EXCLUDED.vat, updated_at = CURRENT_TIMESTAMP"
            ), {
                "sku": pr.sku, "firma": slug, "name": pr.name,
                "stock": int(pr.stock or 0), "transit": int(pr.stock_in_transit or 0),
                "pid": pr.photo_id, "phash": pr.photo_hash,
                "vat": vats.get(pr.sku.strip().lower(), 23),
            })
            total += 1
    await _log(db, user, "catalog_refreshed",
               f"{_kto(user)} odświeżył katalog partnerów ({total} {_plural(total, 'pozycja', 'pozycje', 'pozycji')})")
    await db.commit()
    return {"refreshed": total, "firmy": list(ALL_SHOPS)}


# ===== ZAMÓWIENIA (podgląd i obsługa po naszej stronie) =====
def _order_out(o: dict, items: List[dict]) -> dict:
    return {
        **{k: v for k, v in o.items() if k not in ("total_net", "total_gross")},
        "total_net": float(o["total_net"] or 0),
        "total_gross": float(o["total_gross"] or 0),
        "items": [
            {"sku": i["sku"], "name": i["name"], "qty": int(i["qty"]),
             "price_net": float(i["price_net"]), "vat": float(i["vat"] or 23)}
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
    r = await db.execute(text(
        f"SELECT nr, partner_id, status, tracking, sellasist_order_id, label_url, note FROM {SCHEMA}.orders WHERE id = :id"
    ), {"id": oid})
    cur = r.mappings().first()
    if not cur:
        raise HTTPException(404, "Nie ma takiego zamówienia")

    if payload.label_url is not None:
        payload.label_url = payload.label_url.strip() or None
        if payload.label_url and not payload.label_url.lower().startswith(("http://", "https://")):
            raise HTTPException(400, "Etykieta musi być linkiem zaczynającym się od http:// albo https://")
    if payload.remove_label and payload.label_url:
        raise HTTPException(400, "Albo usuń etykietę, albo podaj nową — nie oba naraz")

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
    # Usunięcie etykiety: zamówienie jeszcze niewysłane do Sellasista wraca do
    # „czeka na etykietę”, żeby magazyn nie pakował czegoś bez dokumentu przewozowego.
    # Po wysłaniu do Sellasista status zostaje — tam trzeba poprawić ręcznie.
    if payload.remove_label and cur["label_url"]:
        fields.append("label_url = :label_url")
        params["label_url"] = None
        if payload.status is None and cur["status"] == "nowe" and not cur["sellasist_order_id"]:
            fields.append("status = :status")
            params["status"] = "etykieta"
    if not fields:
        return await get_order(oid, db, user)

    fields.append("updated_at = CURRENT_TIMESTAMP")
    await db.execute(text(f"UPDATE {SCHEMA}.orders SET {', '.join(fields)} WHERE id = :id"), params)

    labels = {"status": "status", "tracking": "numer przesyłki", "sellasist_order_id": "ID w Sellasist",
              "note": "notatka"}
    diff, zmiany = {}, []
    for col in ("status", "tracking", "sellasist_order_id", "label_url", "note"):
        if col in params and params[col] != cur[col]:
            diff[col] = [cur[col], params[col]]
            if col == "label_url":
                if params[col] is None:
                    zmiany.append("usunął etykietę")
                else:
                    zmiany.append("zmienił etykietę" if cur[col] else "dodał etykietę")
            elif col == "note":
                zmiany.append("zmienił notatkę")
            else:
                zmiany.append(f"{labels[col]}: {_fmt(col, cur[col])} → {_fmt(col, params[col])}")
    if diff:
        await _log(db, user, "order_updated", f"{_kto(user)} zmienił zamówienie {cur['nr']}: " + "; ".join(zmiany),
                   partner_id=cur["partner_id"], order_nr=cur["nr"], changes=diff)
    await db.commit()

    # Odblokowanie (wpłata albo etykieta) samo wypycha zamówienie do Sellasista.
    # Błąd pusha nie może wywrócić zapisu statusu — ląduje w push_error i czeka na ponowienie.
    new_status = params.get("status", cur["status"])
    if new_status in PUSHABLE:
        try:
            await _do_push(oid, db, None)
        except HTTPException:
            pass
    return await get_order(oid, db, user)


# ===== FINANSE =====
# Saldo liczymy TYLKO z wpłat potwierdzonych. Zgłoszenie partnera jest sygnałem,
# nie księgowaniem — inaczej każdy mógłby wyzerować sobie fakturę.
def _d(v: Optional[str], label: str):
    if not v:
        return None
    try:
        return datetime.strptime(v, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, f"{label} musi być w formacie RRRR-MM-DD")


@router.get("/dropy/invoices")
async def list_invoices(
    partner_id: Optional[int] = None,
    only_open: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_dropy),
):
    r = await db.execute(text(
        f"SELECT i.*, p.code AS partner_code, p.name AS partner_name, "
        f"  COALESCE((SELECT SUM(amount) FROM {SCHEMA}.payments pm WHERE pm.invoice_id = i.id AND pm.confirmed), 0) AS paid, "
        f"  COALESCE((SELECT SUM(amount) FROM {SCHEMA}.payments pm WHERE pm.invoice_id = i.id AND NOT pm.confirmed), 0) AS pending "
        f"FROM {SCHEMA}.invoices i JOIN {SCHEMA}.partners p ON p.id = i.partner_id "
        f"WHERE NOT i.is_canceled AND (CAST(:pid AS INTEGER) IS NULL OR i.partner_id = CAST(:pid AS INTEGER)) "
        f"ORDER BY i.due_date DESC NULLS LAST, i.id DESC"
    ), {"pid": partner_id})
    out = []
    for x in r.mappings():
        left = round(float(x["total_gross"] or 0) - float(x["paid"] or 0), 2)
        if only_open and left <= 0:
            continue
        out.append({**{k: v for k, v in x.items() if k not in ("total_gross", "paid", "pending")},
                    "total_gross": float(x["total_gross"] or 0), "paid": float(x["paid"] or 0),
                    "pending": float(x["pending"] or 0), "left": left})
    return out


@router.post("/dropy/invoices", status_code=201)
async def create_invoice(payload: InvoiceIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    partner = await _get_partner(db, payload.partner_id)
    firma = payload.firma.strip().lower()
    if firma not in ALL_SHOPS:
        raise HTTPException(400, f"firma musi być jedną z: {', '.join(ALL_SHOPS)}")
    dup = await db.execute(text(f"SELECT id FROM {SCHEMA}.invoices WHERE firma = :f AND nr = :n"),
                           {"f": firma, "n": payload.nr.strip()})
    if dup.first():
        raise HTTPException(409, f"Faktura {payload.nr} dla {firma} już jest")
    r = await db.execute(text(
        f"INSERT INTO {SCHEMA}.invoices (partner_id, firma, nr, okres, issued_at, due_date, total_gross, pdf_url, note) "
        f"VALUES (:p, :f, :nr, :ok, :iss, :due, :tot, :pdf, :note) RETURNING *"
    ), {"p": payload.partner_id, "f": firma, "nr": payload.nr.strip(), "ok": payload.okres,
        "iss": _d(payload.issued_at, "Data wystawienia"), "due": _d(payload.due_date, "Termin"),
        "tot": payload.total_gross, "pdf": payload.pdf_url, "note": payload.note})
    row = dict(r.mappings().first())
    termin = f", termin {row['due_date'].strftime('%d.%m.%Y')}" if row.get("due_date") else ""
    await _log(db, user, "invoice_created",
               f"{_kto(user)} dodał fakturę {row['nr']} dla partnera {_plabel(partner)} "
               f"({FIRMA_LABEL.get(firma, firma)}, {_zl(row['total_gross'])}{termin})",
               partner_id=payload.partner_id)
    await db.commit()
    return {**row, "total_gross": float(row["total_gross"])}


@router.get("/dropy/invoices/{iid}/orders")
async def invoice_orders(iid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Zamówienia wpięte na fakturę — odpowiednik jednej linii w arkuszu."""
    r = await db.execute(text(
        f"SELECT id, nr, firma, created_at, recipient_name, total_net, total_gross, status, sellasist_order_id "
        f"FROM {SCHEMA}.orders WHERE invoice_id = :i ORDER BY created_at, id"
    ), {"i": iid})
    return [{**dict(x), "total_net": float(x["total_net"]), "total_gross": float(x["total_gross"])}
            for x in r.mappings()]


@router.get("/dropy/orders/unbilled")
async def unbilled_orders(
    partner_id: Optional[int] = None,
    firma: str = Query(""),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_dropy),
):
    """Zamówienia bez faktury — podstawa do wystawienia zbiorczej („na koniec miesiąca”)."""
    r = await db.execute(text(
        f"SELECT o.id, o.nr, o.firma, o.created_at, o.recipient_name, o.total_net, o.total_gross, o.status, "
        f"       p.code AS partner_code, p.name AS partner_name, o.partner_id "
        f"FROM {SCHEMA}.orders o JOIN {SCHEMA}.partners p ON p.id = o.partner_id "
        f"WHERE o.invoice_id IS NULL AND o.status NOT IN ('anulowane') "
        f"  AND (CAST(:pid AS INTEGER) IS NULL OR o.partner_id = CAST(:pid AS INTEGER)) "
        f"  AND (:firma = '' OR o.firma = :firma) "
        f"ORDER BY p.name, o.firma, o.created_at"
    ), {"pid": partner_id, "firma": firma.strip().lower()})
    return [{**dict(x), "total_net": float(x["total_net"]), "total_gross": float(x["total_gross"])}
            for x in r.mappings()]


@router.post("/dropy/invoices/{iid}/orders")
async def attach_orders(iid: int, payload: InvoiceAttach, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Wpina zamówienia na fakturę. Pilnujemy, żeby były tego samego partnera i tej samej
    firmy co faktura — inaczej rozliczenie przestałoby się zgadzać z podmiotem."""
    r = await db.execute(text(f"SELECT partner_id, firma, nr FROM {SCHEMA}.invoices WHERE id = :i AND NOT is_canceled"), {"i": iid})
    inv = r.mappings().first()
    if not inv:
        raise HTTPException(404, "Nie ma takiej faktury")
    if not payload.order_ids:
        raise HTTPException(400, "Nie podano zamówień")

    r = await db.execute(text(
        f"SELECT id, nr, partner_id, firma, invoice_id FROM {SCHEMA}.orders WHERE id = ANY(:ids)"
    ), {"ids": payload.order_ids})
    rows = [dict(x) for x in r.mappings()]
    for o in rows:
        if o["partner_id"] != inv["partner_id"] or o["firma"] != inv["firma"]:
            raise HTTPException(400, f"{o['nr']} jest innego partnera albo innej firmy niż faktura")
        if o["invoice_id"] and o["invoice_id"] != iid:
            raise HTTPException(409, f"{o['nr']} jest już na innej fakturze")

    await db.execute(text(f"UPDATE {SCHEMA}.orders SET invoice_id = :i, updated_at = CURRENT_TIMESTAMP WHERE id = ANY(:ids)"),
                     {"i": iid, "ids": payload.order_ids})
    nowe = [o["nr"] for o in rows if o["invoice_id"] != iid]
    if nowe:
        lista = ", ".join(nowe[:5]) + (f" i {len(nowe) - 5} więcej" if len(nowe) > 5 else "")
        await _log(db, user, "invoice_orders_attached",
                   f"{_kto(user)} wpiął {len(nowe)} {_plural(len(nowe), 'zamówienie', 'zamówienia', 'zamówień')} "
                   f"na fakturę {inv['nr']}: {lista}",
                   partner_id=inv["partner_id"], changes={"invoice_nr": inv["nr"], "orders": nowe})
    await db.commit()
    return {"attached": len(rows)}


@router.delete("/dropy/invoices/{iid}")
async def cancel_invoice(iid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    r = await db.execute(text(
        f"UPDATE {SCHEMA}.invoices SET is_canceled = TRUE WHERE id = :id AND NOT is_canceled "
        f"RETURNING id, nr, partner_id"
    ), {"id": iid})
    inv = r.mappings().first()
    if not inv:
        raise HTTPException(404, "Nie ma takiej faktury")
    # Zamówienia wracają do puli niezafakturowanych — inaczej zniknęłyby z rozliczeń.
    r = await db.execute(text(f"UPDATE {SCHEMA}.orders SET invoice_id = NULL WHERE invoice_id = :id RETURNING nr"), {"id": iid})
    wrocily = [x[0] for x in r.fetchall()]
    await _log(db, user, "invoice_canceled",
               f"{_kto(user)} anulował fakturę {inv['nr']}; {len(wrocily)} "
               f"{_plural(len(wrocily), 'zamówienie wróciło', 'zamówienia wróciły', 'zamówień wróciło')} do niezafakturowanych",
               partner_id=inv["partner_id"], changes={"orders": wrocily})
    await db.commit()
    return {"ok": True}


@router.get("/dropy/payments")
async def list_payments(
    partner_id: Optional[int] = None,
    only_pending: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_dropy),
):
    r = await db.execute(text(
        f"SELECT pm.*, p.code AS partner_code, p.name AS partner_name, i.nr AS invoice_nr, i.firma "
        f"FROM {SCHEMA}.payments pm JOIN {SCHEMA}.partners p ON p.id = pm.partner_id "
        f"LEFT JOIN {SCHEMA}.invoices i ON i.id = pm.invoice_id "
        f"WHERE (CAST(:pid AS INTEGER) IS NULL OR pm.partner_id = CAST(:pid AS INTEGER)) "
        f"  AND (:pend = FALSE OR pm.confirmed = FALSE) "
        f"ORDER BY pm.confirmed, pm.paid_date DESC, pm.id DESC"
    ), {"pid": partner_id, "pend": only_pending})
    return [{**dict(x), "amount": float(x["amount"])} for x in r.mappings()]


@router.post("/dropy/payments", status_code=201)
async def add_payment(payload: PaymentIn, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Wpłata księgowana przez nas — od razu potwierdzona."""
    partner = await _get_partner(db, payload.partner_id)
    r = await db.execute(text(
        f"INSERT INTO {SCHEMA}.payments (partner_id, invoice_id, paid_date, amount, note, source, confirmed, confirmed_at) "
        f"VALUES (:p, :i, :d, :a, :n, 'my', TRUE, CURRENT_TIMESTAMP) RETURNING id"
    ), {"p": payload.partner_id, "i": payload.invoice_id, "d": _d(payload.paid_date, "Data wpłaty"),
        "a": payload.amount, "n": payload.note})
    pid = r.scalar()
    inv_nr = None
    if payload.invoice_id:
        ri = await db.execute(text(f"SELECT nr FROM {SCHEMA}.invoices WHERE id = :i"), {"i": payload.invoice_id})
        inv_nr = ri.scalar()
    await _log(db, user, "payment_added",
               f"{_kto(user)} zaksięgował wpłatę {_zl(payload.amount)} od partnera {_plabel(partner)} "
               f"({'do faktury ' + inv_nr if inv_nr else 'bez faktury'})",
               partner_id=payload.partner_id,
               changes={"amount": payload.amount, "paid_date": payload.paid_date, "invoice_nr": inv_nr})
    await db.commit()
    return {"id": pid, "ok": True}


@router.post("/dropy/payments/{pmid}/confirm")
async def confirm_payment(pmid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Potwierdzenie wpłaty zgłoszonej przez partnera — dopiero to zmienia saldo."""
    r = await db.execute(text(
        f"UPDATE {SCHEMA}.payments SET confirmed = TRUE, confirmed_at = CURRENT_TIMESTAMP "
        f"WHERE id = :id AND NOT confirmed RETURNING partner_id, invoice_id, amount, paid_date"
    ), {"id": pmid})
    pm = r.mappings().first()
    if not pm:
        raise HTTPException(404, "Nie ma takiej wpłaty albo jest już potwierdzona")
    ri = await db.execute(text(
        f"SELECT p.code, p.name, i.nr FROM {SCHEMA}.partners p "
        f"LEFT JOIN {SCHEMA}.invoices i ON i.id = CAST(:i AS INTEGER) WHERE p.id = :p"
    ), {"p": pm["partner_id"], "i": pm["invoice_id"]})
    x = ri.mappings().first()
    await _log(db, user, "payment_confirmed",
               f"{_kto(user)} potwierdził wpłatę {_zl(pm['amount'])} z {pm['paid_date'].strftime('%d.%m.%Y')} "
               f"od partnera {x['code']} ({x['name']})" + (f" do faktury {x['nr']}" if x["nr"] else ""),
               partner_id=pm["partner_id"], changes={"amount": pm["amount"], "invoice_nr": x["nr"]})
    await db.commit()
    return {"ok": True}


# ===== PUSH DO SELLASISTA =====
# Zamówienie idzie do Sellasista DOPIERO, gdy nic go nie blokuje: przy przedpłacie
# po wpłacie, przy pobraniu po wgraniu etykiety. Inaczej magazyn pakowałby coś,
# za co nie ma pieniędzy ani etykiety.
PUSHABLE = ("nowe", "przyjete", "spakowane")


async def _do_push(oid: int, db: AsyncSession, user: Optional[CurrentUser] = None) -> dict:
    """user=None → push automatyczny po odblokowaniu (w logu jako „System”)."""
    r = await db.execute(text(
        f"SELECT o.*, p.code AS partner_code, p.name AS partner_name, p.email AS partner_email, "
        f"       p.nip AS partner_nip, p.phone AS partner_phone, p.bill_street, p.bill_home_number, "
        f"       p.bill_postcode, p.bill_city, p.payment_mode "
        f"FROM {SCHEMA}.orders o JOIN {SCHEMA}.partners p ON p.id = o.partner_id WHERE o.id = :id"
    ), {"id": oid})
    o = r.mappings().first()
    if not o:
        raise HTTPException(404, "Nie ma takiego zamówienia")
    if o["sellasist_order_id"]:
        return {"ok": True, "already": True, "sellasist_order_id": o["sellasist_order_id"]}
    if o["status"] not in PUSHABLE:
        raise HTTPException(409, f"Zamówienie jest w statusie „{o['status']}” — najpierw je odblokuj")

    ri = await db.execute(text(f"SELECT * FROM {SCHEMA}.order_items WHERE order_id = :id ORDER BY id"), {"id": oid})
    items = [{"sku": x["sku"], "name": x["name"], "qty": int(x["qty"]),
              "price_net": float(x["price_net"]), "vat": float(x["vat"] or 23)}
             for x in ri.mappings()]

    payload = {
        "nr": o["nr"], "external_id": o["external_id"],
        "partner_code": o["partner_code"], "partner_name": o["partner_name"],
        "partner_email": o["partner_email"] or "", "partner_nip": o["partner_nip"] or "",
        "partner_phone": o["partner_phone"] or "",
        "partner_street": o["bill_street"] or "", "partner_home_number": o["bill_home_number"] or "",
        "partner_postcode": o["bill_postcode"] or "", "partner_city": o["bill_city"] or "",
        "payment_mode": o["payment_mode"],
        "recipient_name": o["recipient_name"], "recipient_street": o["recipient_street"],
        "recipient_zip": o["recipient_zip"], "recipient_city": o["recipient_city"],
        "recipient_phone": o["recipient_phone"], "label_url": o["label_url"],
        "shipping_mode": o["shipping_mode"],
        "items": items,
    }
    try:
        sid = await push_drop_order(o["firma"], payload)
    except SellasistError as e:
        # Treść odpowiedzi API zostaje na zamówieniu — bez niej nie ma jak poprawić mapowania.
        await db.execute(text(
            f"UPDATE {SCHEMA}.orders SET push_error = :err, updated_at = CURRENT_TIMESTAMP WHERE id = :id"
        ), {"err": str(e), "id": oid})
        await _log(db, user, "sellasist_push_failed",
                   f"{_kto(user)} próbował wysłać zamówienie {o['nr']} do Sellasista — odrzucone: {str(e)[:300]}",
                   partner_id=o["partner_id"], order_nr=o["nr"], changes={"error": str(e)})
        await db.commit()
        raise HTTPException(502, f"Sellasist odrzucił zamówienie: {e}")

    await db.execute(text(
        f"UPDATE {SCHEMA}.orders SET sellasist_order_id = :sid, pushed_at = CURRENT_TIMESTAMP, "
        f"push_error = NULL, status = CASE WHEN status = 'nowe' THEN 'przyjete' ELSE status END, "
        f"updated_at = CURRENT_TIMESTAMP WHERE id = :id"
    ), {"sid": sid, "id": oid})
    await _log(db, user, "sellasist_pushed",
               f"{_kto(user)} wysłał zamówienie {o['nr']} do Sellasista (nr {sid})",
               partner_id=o["partner_id"], order_nr=o["nr"], changes={"sellasist_order_id": sid})
    await db.commit()
    return {"ok": True, "sellasist_order_id": sid}


@router.post("/dropy/orders/{oid}/push")
async def push_order(oid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_dropy)):
    """Ręczne wysłanie zamówienia do Sellasista (ponowienie po błędzie)."""
    return await _do_push(oid, db, user)


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


# ===== LOGI (odczyt) =====
SOURCES = ("portal", "api", "magazyn", "system")


@router.get("/dropy/activity")
async def activity(
    partner_id: Optional[int] = None,
    source: str = Query(""),
    order_nr: str = Query(""),
    q: str = Query("", description="szukaj w treści wpisu"),
    od: str = Query("", description="RRRR-MM-DD"),
    do: str = Query("", description="RRRR-MM-DD, włącznie"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_dropy),
):
    """Historia zmian dropów, od najnowszych. Zwraca też `more`, czy jest co doczytać."""
    src = source.strip().lower()
    if src and src not in SOURCES:
        raise HTTPException(400, f"source musi być jednym z: {', '.join(SOURCES)}")
    start, end = _d(od, "Data od"), _d(do, "Data do")
    r = await db.execute(text(
        f"SELECT a.id, a.created_at, a.partner_id, a.source, a.actor, a.action, a.order_nr, a.message, a.changes, "
        f"       p.code AS partner_code, p.name AS partner_name "
        f"FROM {SCHEMA}.activity_log a LEFT JOIN {SCHEMA}.partners p ON p.id = a.partner_id "
        f"WHERE (CAST(:pid AS INTEGER) IS NULL OR a.partner_id = CAST(:pid AS INTEGER)) "
        f"  AND (:src = '' OR a.source = :src) "
        f"  AND (:nr = '' OR a.order_nr ILIKE :nr_like) "
        f"  AND (:q = '' OR a.message ILIKE :q_like) "
        f"  AND (CAST(:od AS DATE) IS NULL OR a.created_at >= CAST(:od AS DATE)) "
        f"  AND (CAST(:do_ AS DATE) IS NULL OR a.created_at < CAST(:do_ AS DATE) + 1) "
        f"ORDER BY a.created_at DESC, a.id DESC LIMIT :lim OFFSET :off"
    ), {"pid": partner_id, "src": src, "nr": order_nr.strip(), "nr_like": f"%{order_nr.strip()}%",
        "q": q.strip(), "q_like": f"%{q.strip()}%", "od": start, "do_": end,
        "lim": limit + 1, "off": offset})
    rows = [dict(x) for x in r.mappings()]
    for x in rows:
        # asyncpg oddaje JSONB jako tekst — front dostaje gotowy obiekt.
        if isinstance(x["changes"], str):
            try:
                x["changes"] = json.loads(x["changes"])
            except ValueError:
                pass
    return {"rows": rows[:limit], "more": len(rows) > limit}
