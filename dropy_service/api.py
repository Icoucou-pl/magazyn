"""API portalu partnera. Jedyne endpointy, jakie drop w ogóle widzi.

Reguły, które trzymamy tutaj, bo to one chronią magazyn i pieniądze:
  · jedno zamówienie = jedna firma,
  · produkt bez ceny w cenniku partnera nie istnieje,
  · przedpłata → zamówienie czeka na wpłatę,
  · pobranie bez etykiety → zamówienie czeka na etykietę,
  · limit kupiecki liczony per partner, ze wszystkich firm razem.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from auth import Partner, create_token, current_partner, verify_password
from config import settings
from db import get_db

router = APIRouter(prefix="/drop/v1", tags=["portal"])
VAT = Decimal(str(settings.VAT))


class LoginIn(BaseModel):
    email: str
    password: str


class LineIn(BaseModel):
    sku: str
    qty: int = Field(..., gt=0)


class OrderIn(BaseModel):
    firma: str
    typ: str = "klient"                      # klient | zbiorcze
    lines: List[LineIn]
    external_id: Optional[str] = None        # numer u partnera — klucz idempotencji
    recipient_name: Optional[str] = None
    recipient_phone: Optional[str] = None
    recipient_street: Optional[str] = None
    recipient_zip: Optional[str] = None
    recipient_city: Optional[str] = None
    cod: bool = False
    label_url: Optional[str] = None
    note: Optional[str] = None


class LabelIn(BaseModel):
    label_url: str


# ===== LOGOWANIE =====
@router.post("/auth/login")
async def login(payload: LoginIn, db: AsyncSession = Depends(get_db)):
    r = await db.execute(text(
        "SELECT u.id, u.email, u.password_hash, u.full_name, u.partner_id, p.name AS partner_name, p.code "
        "FROM dropy.users u JOIN dropy.partners p ON p.id = u.partner_id "
        "WHERE LOWER(u.email) = LOWER(:e) AND u.is_active AND p.is_active"
    ), {"e": payload.email.strip()})
    u = r.mappings().first()
    if not u or not verify_password(payload.password, u["password_hash"]):
        raise HTTPException(401, "Nieprawidłowy email lub hasło")
    await db.execute(text("UPDATE dropy.users SET last_login = CURRENT_TIMESTAMP WHERE id = :id"), {"id": u["id"]})
    await db.commit()
    return {
        "access_token": create_token(u["id"], u["partner_id"], u["email"]),
        "token_type": "bearer",
        "partner": {"code": u["code"], "name": u["partner_name"]},
        "user": {"email": u["email"], "full_name": u["full_name"]},
    }


@router.get("/me")
async def me(p: Partner = Depends(current_partner)):
    return {
        "code": p.code, "name": p.name, "firmy": p.firmy,
        "payment_mode": p.payment_mode, "credit_limit": p.credit_limit, "address": p.address,
    }


# ===== KATALOG =====
@router.get("/catalog")
async def catalog(firma: str = Query(...), p: Partner = Depends(current_partner), db: AsyncSession = Depends(get_db)):
    """Katalog jednej firmy. Partner widzi pasmo dostępności, nie liczby."""
    firma = firma.strip().lower()
    if firma not in p.firmy:
        raise HTTPException(403, f"Nie kupujesz od firmy {firma}")

    r = await db.execute(text(
        "SELECT c.sku, c.name, c.stock, c.in_transit, pr.price_net "
        "FROM dropy.prices pr "
        "JOIN dropy.catalog_cache c ON LOWER(TRIM(c.sku)) = LOWER(TRIM(pr.sku)) AND c.firma = :f "
        "WHERE pr.partner_id = :p ORDER BY c.name"
    ), {"f": firma, "p": p.id})
    out = []
    for x in r.mappings():
        stock = int(x["stock"] or 0)
        out.append({
            "sku": x["sku"], "name": x["name"], "firma": firma,
            "price_net": float(x["price_net"]),
            "price_gross": float(round(Decimal(str(x["price_net"])) * VAT, 2)),
            "availability": "ok" if stock > settings.LOW_STOCK_AT else ("low" if stock > 0 else "out"),
            "incoming": int(x["in_transit"] or 0) > 0,
        })
    return out


# ===== ZAMÓWIENIA =====
def _out(o: dict, items: List[dict]) -> dict:
    return {
        "nr": o["nr"], "firma": o["firma"], "typ": o["typ"], "status": o["status"],
        "external_id": o["external_id"], "cod": o["cod"], "tracking": o["tracking"],
        "recipient": {
            "name": o["recipient_name"], "phone": o["recipient_phone"], "street": o["recipient_street"],
            "zip": o["recipient_zip"], "city": o["recipient_city"],
        },
        "total_net": float(o["total_net"] or 0), "total_gross": float(o["total_gross"] or 0),
        "created_at": o["created_at"],
        "items": [{"sku": i["sku"], "name": i["name"], "qty": int(i["qty"]), "price_net": float(i["price_net"])}
                  for i in items],
    }


@router.get("/orders")
async def list_orders(
    month: str = Query("", description="RRRR-MM; puste = bieżący miesiąc"),
    p: Partner = Depends(current_partner),
    db: AsyncSession = Depends(get_db),
):
    if month:
        try:
            first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, "month musi być w formacie RRRR-MM")
    else:
        today = date.today()
        first = date(today.year, today.month, 1)
    nxt = date(first.year + (first.month == 12), (first.month % 12) + 1, 1)

    r = await db.execute(text(
        "SELECT * FROM dropy.orders WHERE partner_id = :p AND created_at >= :od AND created_at < :do_ "
        "ORDER BY created_at DESC, id DESC"
    ), {"p": p.id, "od": first, "do_": nxt})
    orders = [dict(x) for x in r.mappings()]
    if not orders:
        return {"month": first.strftime("%Y-%m"), "orders": [], "summary": {"count": 0, "net": 0, "gross": 0}}

    ri = await db.execute(
        text("SELECT * FROM dropy.order_items WHERE order_id = ANY(:ids) ORDER BY id"),
        {"ids": [o["id"] for o in orders]},
    )
    by_order: dict = {}
    for it in ri.mappings():
        by_order.setdefault(it["order_id"], []).append(dict(it))

    live = [o for o in orders if o["status"] != "anulowane"]
    return {
        "month": first.strftime("%Y-%m"),
        "orders": [_out(o, by_order.get(o["id"], [])) for o in orders],
        "summary": {
            "count": len(live),
            "net": float(sum(o["total_net"] for o in live)),
            "gross": float(sum(o["total_gross"] for o in live)),
            "waiting": len([o for o in live if o["status"] in ("platnosc", "etykieta")]),
        },
    }


@router.get("/orders/{nr:path}")
async def get_order(nr: str, p: Partner = Depends(current_partner), db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        text("SELECT * FROM dropy.orders WHERE nr = :nr AND partner_id = :p"),
        {"nr": nr, "p": p.id},
    )
    o = r.mappings().first()
    if not o:
        raise HTTPException(404, "Nie ma takiego zamówienia")
    ri = await db.execute(text("SELECT * FROM dropy.order_items WHERE order_id = :id ORDER BY id"), {"id": o["id"]})
    return _out(dict(o), [dict(x) for x in ri.mappings()])


@router.post("/orders", status_code=201)
async def create_order(payload: OrderIn, p: Partner = Depends(current_partner), db: AsyncSession = Depends(get_db)):
    firma = payload.firma.strip().lower()
    if firma not in p.firmy:
        raise HTTPException(403, f"Nie kupujesz od firmy {firma}")
    if payload.typ not in ("klient", "zbiorcze"):
        raise HTTPException(400, "typ musi być 'klient' albo 'zbiorcze'")
    if not payload.lines:
        raise HTTPException(400, "Zamówienie bez pozycji")
    if payload.typ == "klient" and not (payload.recipient_name and payload.recipient_city):
        raise HTTPException(400, "Wysyłka do klienta wymaga nazwiska i miasta odbiorcy")

    # Idempotencja: ten sam numer ze sklepu partnera zwraca istniejące zamówienie,
    # więc powtórzony webhook nie tworzy duplikatu.
    if payload.external_id:
        r = await db.execute(
            text("SELECT nr FROM dropy.orders WHERE partner_id = :p AND external_id = :e"),
            {"p": p.id, "e": payload.external_id},
        )
        dup = r.first()
        if dup:
            return await get_order(dup[0], p, db)

    r = await db.execute(text(
        "SELECT LOWER(TRIM(c.sku)) AS key, c.sku, c.name, pr.price_net "
        "FROM dropy.prices pr "
        "JOIN dropy.catalog_cache c ON LOWER(TRIM(c.sku)) = LOWER(TRIM(pr.sku)) AND c.firma = :f "
        "WHERE pr.partner_id = :p"
    ), {"f": firma, "p": p.id})
    available = {x["key"]: dict(x) for x in r.mappings()}

    items, total = [], Decimal("0")
    for ln in payload.lines:
        row = available.get(ln.sku.strip().lower())
        if not row:
            raise HTTPException(400, f"{ln.sku}: nie ma tego produktu w Twoim katalogu dla firmy {firma}")
        cena = Decimal(str(row["price_net"]))
        total += cena * ln.qty
        items.append({"sku": row["sku"], "name": row["name"], "qty": ln.qty, "price_net": float(cena)})
    gross = (total * VAT).quantize(Decimal("0.01"))

    if p.credit_limit is not None and p.payment_mode == "zbiorcza":
        r = await db.execute(text(
            "SELECT COALESCE(SUM(total_gross), 0) FROM dropy.orders "
            "WHERE partner_id = :p AND status <> 'anulowane'"
        ), {"p": p.id})
        already = Decimal(str(r.scalar() or 0))
        if already + gross > Decimal(str(p.credit_limit)):
            raise HTTPException(409, "Limit kupiecki przekroczony. Opłać zaległe faktury albo napisz do opiekuna.")

    if p.payment_mode == "przedplata":
        status = "platnosc"
    elif payload.cod and not payload.label_url:
        status = "etykieta"
    else:
        status = "nowe"

    today = date.today()
    prefix = f"{p.code}/{today.strftime('%Y%m')}/"
    r = await db.execute(
        text("SELECT nr FROM dropy.orders WHERE nr LIKE :pref ORDER BY nr DESC LIMIT 1"),
        {"pref": prefix + "%"},
    )
    last = r.scalar()
    nr = f"{prefix}{(int(last.rsplit('/', 1)[1]) + 1 if last else 1):04d}"

    r = await db.execute(text(
        "INSERT INTO dropy.orders (nr, partner_id, firma, typ, status, source, external_id, "
        "  recipient_name, recipient_phone, recipient_street, recipient_zip, recipient_city, "
        "  cod, label_url, note, total_net, total_gross) "
        "VALUES (:nr, :pid, :firma, :typ, :status, :src, :ext, :rn, :rp, :rs, :rz, :rc, "
        "        :cod, :label, :note, :net, :gross) RETURNING id"
    ), {
        "nr": nr, "pid": p.id, "firma": firma, "typ": payload.typ, "status": status,
        "src": "api" if p.via == "api" else "portal", "ext": payload.external_id,
        "rn": payload.recipient_name, "rp": payload.recipient_phone, "rs": payload.recipient_street,
        "rz": payload.recipient_zip, "rc": payload.recipient_city, "cod": payload.cod,
        "label": payload.label_url, "note": payload.note, "net": float(total), "gross": float(gross),
    })
    oid = r.scalar()
    for it in items:
        await db.execute(text(
            "INSERT INTO dropy.order_items (order_id, sku, name, qty, price_net) VALUES (:o, :s, :n, :q, :c)"
        ), {"o": oid, "s": it["sku"], "n": it["name"], "q": it["qty"], "c": it["price_net"]})
    await db.commit()
    return await get_order(nr, p, db)


@router.post("/orders/{nr:path}/label")
async def set_label(nr: str, payload: LabelIn, p: Partner = Depends(current_partner), db: AsyncSession = Depends(get_db)):
    """Etykieta partnera przy pobraniu. Odblokowuje zamówienie do pakowania."""
    r = await db.execute(
        text("SELECT id, status FROM dropy.orders WHERE nr = :nr AND partner_id = :p"),
        {"nr": nr, "p": p.id},
    )
    o = r.mappings().first()
    if not o:
        raise HTTPException(404, "Nie ma takiego zamówienia")
    if o["status"] not in ("etykieta", "platnosc", "nowe"):
        raise HTTPException(409, "Zamówienie jest już w realizacji — etykietę wyślij opiekunowi")

    new_status = "nowe" if o["status"] == "etykieta" else o["status"]
    await db.execute(text(
        "UPDATE dropy.orders SET label_url = :l, status = :s, updated_at = CURRENT_TIMESTAMP WHERE id = :id"
    ), {"l": payload.label_url, "s": new_status, "id": o["id"]})
    await db.commit()
    return await get_order(nr, p, db)
