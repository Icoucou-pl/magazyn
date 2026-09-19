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

from activity import log, plural, who, zl
from auth import Partner, create_token, current_partner, verify_password
from config import settings
from db import get_db

router = APIRouter(prefix="/drop/v1", tags=["portal"])
VAT = Decimal(str(settings.VAT))
FIRMA_LABEL = {"amh": "AMH", "acti": "Acti4med", "veluxa": "Veluxa"}
STATUS_INFO = {
    "platnosc": "Czeka na wpłatę",
    "etykieta": "Czeka na etykietę",
}


class LoginIn(BaseModel):
    email: str
    password: str


class LineIn(BaseModel):
    sku: str
    qty: int = Field(..., gt=0)


class OrderIn(BaseModel):
    firma: str
    typ: str = "klient"                      # klient | zbiorcze
    shipping_mode: str = "wlasna"            # wlasna = etykieta partnera | nasza = wysyłamy my
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


def _clean_label(url: Optional[str]) -> Optional[str]:
    """Etykieta to link do pliku — przyjmujemy tylko http(s), żeby nikt nie wkleił
    czegoś, co po kliknięciu w Magazynie odpali skrypt zamiast pobrać PDF."""
    if url is None:
        return None
    url = url.strip()
    if not url:
        return None
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "Etykieta musi być linkiem zaczynającym się od http:// albo https://")
    return url


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
        "SELECT c.sku, c.name, c.stock, c.in_transit, c.photo_id, c.photo_hash, c.vat, pr.price_net "
        "FROM dropy.prices pr "
        "JOIN dropy.catalog_cache c ON LOWER(TRIM(c.sku)) = LOWER(TRIM(pr.sku)) AND c.firma = :f "
        "WHERE pr.partner_id = :p ORDER BY c.name"
    ), {"f": firma, "p": p.id})
    out = []
    for x in r.mappings():
        stock = int(x["stock"] or 0)
        photo = None
        if settings.PHOTO_BASE and x["photo_id"] and x["photo_hash"]:
            photo = f"{settings.PHOTO_BASE}/product-photos/{x['photo_id']}/{x['photo_hash']}"
        vat = float(x["vat"] or 23)
        out.append({
            "sku": x["sku"], "name": x["name"], "firma": firma,
            "photo_thumb": f"{photo}/thumb" if photo else None,
            "photo_full": f"{photo}/full" if photo else None,
            "price_net": float(x["price_net"]), "vat": vat,
            "price_gross": float(round(Decimal(str(x["price_net"])) * (1 + Decimal(str(vat)) / 100), 2)),
            "availability": "ok" if stock > settings.LOW_STOCK_AT else ("low" if stock > 0 else "out"),
            "incoming": int(x["in_transit"] or 0) > 0,
        })
    return out


# ===== LIMIT KUPIECKI =====
async def _credit_used(db: AsyncSession, pid: int) -> Decimal:
    """Ile limitu jest zajęte = zamówienia jeszcze bez faktury + niezapłacona część faktur.

    Wcześniej liczyliśmy sumę WSZYSTKICH zamówień od początku, więc limit tylko rósł
    i po kilku miesiącach blokowałby partnera, który płaci w terminie.
    Liczymy tylko wpłaty potwierdzone — zgłoszenie partnera limitu nie zwalnia.
    """
    r = await db.execute(text(
        "SELECT "
        "  COALESCE((SELECT SUM(total_gross) FROM dropy.orders "
        "            WHERE partner_id = :p AND invoice_id IS NULL AND status <> 'anulowane'), 0) "
        "+ COALESCE((SELECT SUM(GREATEST(i.total_gross - COALESCE(pm.paid, 0), 0)) "
        "            FROM dropy.invoices i "
        "            LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM dropy.payments "
        "                       WHERE confirmed GROUP BY invoice_id) pm ON pm.invoice_id = i.id "
        "            WHERE i.partner_id = :p AND NOT i.is_canceled), 0)"
    ), {"p": pid})
    return Decimal(str(r.scalar() or 0))


# ===== ZAMÓWIENIA =====
def _out(o: dict, items: List[dict]) -> dict:
    return {
        "nr": o["nr"], "firma": o["firma"], "typ": o["typ"], "status": o["status"],
        "external_id": o["external_id"], "cod": o["cod"], "tracking": o["tracking"],
        "shipping_mode": o["shipping_mode"], "label_url": o["label_url"],
        "recipient": {
            "name": o["recipient_name"], "phone": o["recipient_phone"], "street": o["recipient_street"],
            "zip": o["recipient_zip"], "city": o["recipient_city"],
        },
        "total_net": float(o["total_net"] or 0), "total_gross": float(o["total_gross"] or 0),
        "created_at": o["created_at"],
        "items": [{"sku": i["sku"], "name": i["name"], "qty": int(i["qty"]),
                    "price_net": float(i["price_net"]), "vat": float(i["vat"] or 23)}
                   for i in items],
    }


def _range(od: str, do: str, month: str):
    """Zakres dat: od/do mają pierwszeństwo, month zostaje dla zgodności ze starym API."""
    if od or do:
        try:
            start = datetime.strptime(od, "%Y-%m-%d").date() if od else date(2000, 1, 1)
            end = datetime.strptime(do, "%Y-%m-%d").date() if do else date.today()
        except ValueError:
            raise HTTPException(400, "Daty muszą być w formacie RRRR-MM-DD")
        if end < start:
            raise HTTPException(400, "Data „do” jest wcześniejsza niż „od”")
        return start, date.fromordinal(end.toordinal() + 1)      # „do” włącznie
    if month:
        try:
            first = datetime.strptime(month + "-01", "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, "month musi być w formacie RRRR-MM")
    else:
        today = date.today()
        first = date(today.year, today.month, 1)
    return first, date(first.year + (first.month == 12), (first.month % 12) + 1, 1)


@router.get("/orders")
async def list_orders(
    month: str = Query("", description="RRRR-MM (zgodność wstecz)"),
    od: str = Query("", description="RRRR-MM-DD"),
    do: str = Query("", description="RRRR-MM-DD, włącznie"),
    p: Partner = Depends(current_partner),
    db: AsyncSession = Depends(get_db),
):
    first, nxt = _range(od, do, month)

    r = await db.execute(text(
        "SELECT * FROM dropy.orders WHERE partner_id = :p AND created_at >= :od AND created_at < :do_ "
        "ORDER BY created_at DESC, id DESC"
    ), {"p": p.id, "od": first, "do_": nxt})
    orders = [dict(x) for x in r.mappings()]
    if not orders:
        return {"od": first.isoformat(), "do": (nxt.toordinal() - 1 and date.fromordinal(nxt.toordinal() - 1)).isoformat(),
                "orders": [], "summary": {"count": 0, "net": 0, "gross": 0, "waiting": 0}}

    ri = await db.execute(
        text("SELECT * FROM dropy.order_items WHERE order_id = ANY(:ids) ORDER BY id"),
        {"ids": [o["id"] for o in orders]},
    )
    by_order: dict = {}
    for it in ri.mappings():
        by_order.setdefault(it["order_id"], []).append(dict(it))

    live = [o for o in orders if o["status"] != "anulowane"]
    return {
        "od": first.isoformat(), "do": date.fromordinal(nxt.toordinal() - 1).isoformat(),
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
    if payload.shipping_mode not in ("wlasna", "nasza"):
        raise HTTPException(400, "shipping_mode musi być 'wlasna' albo 'nasza'")
    if not payload.lines:
        raise HTTPException(400, "Zamówienie bez pozycji")
    payload.label_url = _clean_label(payload.label_url)
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
        "SELECT LOWER(TRIM(c.sku)) AS key, c.sku, c.name, c.vat, pr.price_net "
        "FROM dropy.prices pr "
        "JOIN dropy.catalog_cache c ON LOWER(TRIM(c.sku)) = LOWER(TRIM(pr.sku)) AND c.firma = :f "
        "WHERE pr.partner_id = :p"
    ), {"f": firma, "p": p.id})
    available = {x["key"]: dict(x) for x in r.mappings()}

    # Brutto liczymy per pozycja, bo stawki bywają różne w jednym koszyku
    # (Acti: łóżko 8%, akcesoria 23%).
    items, total, gross = [], Decimal("0"), Decimal("0")
    for ln in payload.lines:
        row = available.get(ln.sku.strip().lower())
        if not row:
            raise HTTPException(400, f"{ln.sku}: nie ma tego produktu w Twoim katalogu dla firmy {firma}")
        cena = Decimal(str(row["price_net"]))
        vat = Decimal(str(row["vat"] or 23))
        net_line = cena * ln.qty
        total += net_line
        gross += (net_line * (1 + vat / 100)).quantize(Decimal("0.01"))
        items.append({"sku": row["sku"], "name": row["name"], "qty": ln.qty,
                      "price_net": float(cena), "vat": float(vat)})
    gross = gross.quantize(Decimal("0.01"))

    if p.credit_limit is not None and p.payment_mode == "zbiorcza":
        already = await _credit_used(db, p.id)
        if already + gross > Decimal(str(p.credit_limit)):
            raise HTTPException(409, "Limit kupiecki przekroczony. Opłać zaległe faktury albo napisz do opiekuna.")

    # Kolejność blokad: najpierw pieniądze, potem etykieta. Etykiety wymagamy tylko wtedy,
    # gdy partner deklaruje własną — jeśli wysyłamy my, nadajemy zwykłą przesyłkę.
    if p.payment_mode == "przedplata":
        status = "platnosc"
    elif payload.shipping_mode == "wlasna" and not payload.label_url:
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
        "  cod, shipping_mode, label_url, note, total_net, total_gross) "
        "VALUES (:nr, :pid, :firma, :typ, :status, :src, :ext, :rn, :rp, :rs, :rz, :rc, "
        "        :cod, :mode, :label, :note, :net, :gross) RETURNING id"
    ), {
        "nr": nr, "pid": p.id, "firma": firma, "typ": payload.typ, "status": status,
        "src": "api" if p.via == "api" else "portal", "ext": payload.external_id,
        "rn": payload.recipient_name, "rp": payload.recipient_phone, "rs": payload.recipient_street,
        "rz": payload.recipient_zip, "rc": payload.recipient_city, "cod": payload.cod,
        "mode": payload.shipping_mode,
        "label": payload.label_url, "note": payload.note, "net": float(total), "gross": float(gross),
    })
    oid = r.scalar()
    for it in items:
        await db.execute(text(
            "INSERT INTO dropy.order_items (order_id, sku, name, qty, price_net, vat) "
            "VALUES (:o, :s, :n, :q, :c, :v)"
        ), {"o": oid, "s": it["sku"], "n": it["name"], "q": it["qty"],
            "c": it["price_net"], "v": it["vat"]})

    _, kto = await who(db, p)
    n = len(items)
    tekst = (f"{kto} złożył zamówienie {nr} ({FIRMA_LABEL.get(firma, firma)}, "
             f"{n} {plural(n, 'pozycja', 'pozycje', 'pozycji')}, {zl(total)} netto)")
    if payload.external_id:
        tekst += f", nr w sklepie partnera: {payload.external_id}"
    if status in STATUS_INFO:
        tekst += f". {STATUS_INFO[status]}"
    await log(db, p, "order_created", tekst, order_nr=nr, changes={
        "status": status, "typ": payload.typ, "shipping_mode": payload.shipping_mode, "cod": payload.cod,
        "total_net": float(total), "total_gross": float(gross),
        "items": [{"sku": i["sku"], "qty": i["qty"], "price_net": i["price_net"]} for i in items],
    })
    await db.commit()
    return await get_order(nr, p, db)


# ===== FINANSE =====
class PaymentIn(BaseModel):
    paid_date: str                     # RRRR-MM-DD
    amount: float = Field(..., gt=0)
    confirmation_url: Optional[str] = None
    note: Optional[str] = None


@router.get("/finanse")
async def finanse(
    year: str = Query("", description="RRRR; puste = wszystko"),
    p: Partner = Depends(current_partner),
    db: AsyncSession = Depends(get_db),
):
    """Faktury partnera z rozliczeniem wpłat. Saldo liczymy tylko z wpłat POTWIERDZONYCH."""
    params = {"p": p.id, "y": year}
    r = await db.execute(text(
        "SELECT i.*, "
        "  COALESCE((SELECT SUM(amount) FROM dropy.payments pm "
        "            WHERE pm.invoice_id = i.id AND pm.confirmed), 0) AS paid, "
        "  COALESCE((SELECT SUM(amount) FROM dropy.payments pm "
        "            WHERE pm.invoice_id = i.id AND NOT pm.confirmed), 0) AS pending "
        "FROM dropy.invoices i "
        "WHERE i.partner_id = :p AND NOT i.is_canceled "
        "  AND (:y = '' OR TO_CHAR(i.issued_at, 'YYYY') = :y) "
        "ORDER BY i.due_date DESC NULLS LAST, i.id DESC"
    ), params)

    today = date.today()
    invoices, due_total, overdue_total = [], 0.0, 0.0
    for x in r.mappings():
        total = float(x["total_gross"] or 0)
        paid = float(x["paid"] or 0)
        left = round(total - paid, 2)
        overdue = left > 0 and x["due_date"] is not None and x["due_date"] < today
        due_total += max(left, 0)
        if overdue:
            overdue_total += left
        invoices.append({
            "id": x["id"], "nr": x["nr"], "firma": x["firma"], "okres": x["okres"],
            "issued_at": x["issued_at"], "due_date": x["due_date"],
            "total_gross": total, "paid": paid, "pending": float(x["pending"] or 0),
            "left": left, "overdue": overdue, "pdf_url": x["pdf_url"],
            "status": "zaplacona" if left <= 0 else ("po_terminie" if overdue else "do_zaplaty"),
        })

    # Zamówienia wpięte na każdą fakturę — to jest ten sam widok co linie w arkuszu.
    ro = await db.execute(text(
        "SELECT o.invoice_id, o.nr, o.created_at, o.recipient_name, o.total_gross "
        "FROM dropy.orders o WHERE o.partner_id = :p AND o.invoice_id IS NOT NULL "
        "ORDER BY o.created_at, o.id"
    ), {"p": p.id})
    by_inv: dict = {}
    for x in ro.mappings():
        by_inv.setdefault(x["invoice_id"], []).append({
            "nr": x["nr"], "created_at": x["created_at"],
            "recipient": x["recipient_name"], "total_gross": float(x["total_gross"] or 0),
        })
    for inv in invoices:
        inv["orders"] = by_inv.get(inv["id"], [])

    # Zamówienia jeszcze bez faktury — u was to dopisek „na koniec miesiąca”.
    ru = await db.execute(text(
        "SELECT firma, COUNT(*) AS cnt, SUM(total_gross) AS gross FROM dropy.orders "
        "WHERE partner_id = :p AND invoice_id IS NULL AND status <> 'anulowane' GROUP BY firma"
    ), {"p": p.id})
    unbilled = [{"firma": x["firma"], "count": int(x["cnt"]), "gross": float(x["gross"] or 0)}
                for x in ru.mappings()]

    rp = await db.execute(text(
        "SELECT pm.id, pm.paid_date, pm.amount, pm.confirmed, pm.confirmation_url, pm.note, "
        "       i.nr AS invoice_nr "
        "FROM dropy.payments pm LEFT JOIN dropy.invoices i ON i.id = pm.invoice_id "
        "WHERE pm.partner_id = :p ORDER BY pm.paid_date DESC, pm.id DESC LIMIT 100"
    ), {"p": p.id})
    payments = [{
        "id": x["id"], "paid_date": x["paid_date"], "amount": float(x["amount"]),
        "confirmed": x["confirmed"], "confirmation_url": x["confirmation_url"],
        "note": x["note"], "invoice_nr": x["invoice_nr"],
    } for x in rp.mappings()]

    return {
        "summary": {
            "due": round(due_total, 2),
            "overdue": round(overdue_total, 2),
            "pending": round(sum(p_["amount"] for p_ in payments if not p_["confirmed"]), 2),
            "invoices": len(invoices),
            "unbilled": round(sum(u["gross"] for u in unbilled), 2),
        },
        "invoices": invoices,
        "unbilled": unbilled,
        "payments": payments,
    }


@router.post("/invoices/{iid}/payments", status_code=201)
async def declare_payment(
    iid: int, payload: PaymentIn,
    p: Partner = Depends(current_partner),
    db: AsyncSession = Depends(get_db),
):
    """Partner zgłasza wpłatę. Trafia jako niepotwierdzona — saldo zmienia się dopiero,
    gdy my ją potwierdzimy. Dzięki temu zgłoszenie niczego nie zeruje na siłę."""
    r = await db.execute(
        text("SELECT id, nr FROM dropy.invoices WHERE id = :i AND partner_id = :p AND NOT is_canceled"),
        {"i": iid, "p": p.id},
    )
    inv = r.mappings().first()
    if not inv:
        raise HTTPException(404, "Nie ma takiej faktury")
    try:
        when = datetime.strptime(payload.paid_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "Data wpłaty musi być w formacie RRRR-MM-DD")
    if when > date.today():
        raise HTTPException(400, "Data wpłaty nie może być z przyszłości")

    await db.execute(text(
        "INSERT INTO dropy.payments (partner_id, invoice_id, paid_date, amount, confirmation_url, note, source) "
        "VALUES (:p, :i, :d, :a, :u, :n, 'partner')"
    ), {"p": p.id, "i": iid, "d": when, "a": payload.amount,
        "u": payload.confirmation_url, "n": payload.note})
    _, kto = await who(db, p)
    await log(db, p, "payment_declared",
              f"{kto} zgłosił wpłatę {zl(payload.amount)} z {when.strftime('%d.%m.%Y')} do faktury {inv['nr']}",
              changes={"invoice_nr": inv["nr"], "amount": payload.amount, "paid_date": when,
                       "confirmation_url": payload.confirmation_url, "note": payload.note})
    await db.commit()
    return {"ok": True, "info": "Zgłoszenie przyjęte, potwierdzimy po zaksięgowaniu"}


@router.post("/orders/{nr:path}/label")
async def set_label(nr: str, payload: LabelIn, p: Partner = Depends(current_partner), db: AsyncSession = Depends(get_db)):
    """Etykieta partnera przy pobraniu. Odblokowuje zamówienie do pakowania."""
    payload.label_url = _clean_label(payload.label_url)
    if not payload.label_url:
        raise HTTPException(400, "Wklej link do pliku z etykietą")
    r = await db.execute(
        text("SELECT id, status, shipping_mode, label_url FROM dropy.orders WHERE nr = :nr AND partner_id = :p"),
        {"nr": nr, "p": p.id},
    )
    o = r.mappings().first()
    if not o:
        raise HTTPException(404, "Nie ma takiego zamówienia")
    if o["shipping_mode"] != "wlasna":
        raise HTTPException(409, "To zamówienie wysyłamy my — etykieta partnera nie jest potrzebna")
    if o["status"] not in ("etykieta", "platnosc", "nowe"):
        raise HTTPException(409, "Zamówienie jest już w realizacji — etykietę wyślij opiekunowi")

    new_status = "nowe" if o["status"] == "etykieta" else o["status"]
    await db.execute(text(
        "UPDATE dropy.orders SET label_url = :l, status = :s, updated_at = CURRENT_TIMESTAMP WHERE id = :id"
    ), {"l": payload.label_url, "s": new_status, "id": o["id"]})

    _, kto = await who(db, p)
    if o["label_url"]:
        tekst = f"{kto} zmienił etykietę w zamówieniu {nr}"
    else:
        tekst = f"{kto} dodał etykietę do zamówienia {nr}"
    if new_status != o["status"]:
        tekst += " — zamówienie przeszło do realizacji"
    changes = {"label_url": [o["label_url"], payload.label_url]}
    if new_status != o["status"]:
        changes["status"] = [o["status"], new_status]
    await log(db, p, "label_changed" if o["label_url"] else "label_added", tekst, order_nr=nr, changes=changes)
    await db.commit()
    return await get_order(nr, p, db)


# ===== START (pulpit partnera) =====
@router.get("/dashboard")
async def dashboard(p: Partner = Depends(current_partner), db: AsyncSession = Depends(get_db)):
    """Wszystko na ekran Start jednym strzałem: miesiąc, zadania, limit, firmy, ostatnie zamówienia."""
    today = date.today()
    first = date(today.year, today.month, 1)
    nxt = date(first.year + (first.month == 12), (first.month % 12) + 1, 1)
    prev = date(first.year - (first.month == 1), ((first.month - 2) % 12) + 1, 1)

    # Ten miesiąc per status i firma — z tego liczymy kafelki i obrót.
    r = await db.execute(text(
        "SELECT firma, status, COUNT(*) AS cnt, SUM(total_net) AS net, SUM(total_gross) AS gross "
        "FROM dropy.orders WHERE partner_id = :p AND created_at >= :od AND created_at < :do_ "
        "  AND status <> 'anulowane' GROUP BY firma, status"
    ), {"p": p.id, "od": first, "do_": nxt})
    rows = [dict(x) for x in r.mappings()]
    count = sum(int(x["cnt"]) for x in rows)
    net = sum(float(x["net"] or 0) for x in rows)
    by_status: dict = {}
    by_firma: dict = {}
    for x in rows:
        by_status[x["status"]] = by_status.get(x["status"], 0) + int(x["cnt"])
        by_firma[x["firma"]] = by_firma.get(x["firma"], 0) + float(x["net"] or 0)

    # Poprzedni miesiąc do tej samej daty — żeby trend nie straszył na początku miesiąca.
    same_day = date.fromordinal(min(prev.toordinal() + (today - first).days + 1, first.toordinal()))
    r = await db.execute(text(
        "SELECT COUNT(*) FROM dropy.orders WHERE partner_id = :p AND created_at >= :od AND created_at < :do_ "
        "  AND status <> 'anulowane'"
    ), {"p": p.id, "od": prev, "do_": same_day})
    prev_count = int(r.scalar() or 0)

    # Zamówienia czekające na partnera — niezależnie od miesiąca.
    r = await db.execute(text(
        "SELECT nr, status FROM dropy.orders WHERE partner_id = :p AND status IN ('platnosc', 'etykieta') "
        "ORDER BY created_at"
    ), {"p": p.id})
    waiting = [dict(x) for x in r.mappings()]
    need_label = [w["nr"] for w in waiting if w["status"] == "etykieta"]
    need_pay = [w["nr"] for w in waiting if w["status"] == "platnosc"]

    # Faktury otwarte.
    r = await db.execute(text(
        "SELECT i.id, i.nr, i.firma, i.due_date, i.total_gross, "
        "  COALESCE((SELECT SUM(amount) FROM dropy.payments pm WHERE pm.invoice_id = i.id AND pm.confirmed), 0) AS paid, "
        "  COALESCE((SELECT SUM(amount) FROM dropy.payments pm WHERE pm.invoice_id = i.id AND NOT pm.confirmed), 0) AS pending "
        "FROM dropy.invoices i WHERE i.partner_id = :p AND NOT i.is_canceled ORDER BY i.due_date NULLS LAST, i.id"
    ), {"p": p.id})
    open_inv = []
    for x in r.mappings():
        left = round(float(x["total_gross"] or 0) - float(x["paid"] or 0), 2)
        if left <= 0:
            continue
        open_inv.append({
            "id": x["id"], "nr": x["nr"], "firma": x["firma"], "due_date": x["due_date"], "left": left,
            "pending": float(x["pending"] or 0),
            "overdue": x["due_date"] is not None and x["due_date"] < today,
            "days": (x["due_date"] - today).days if x["due_date"] else None,
        })
    due = round(sum(i["left"] for i in open_inv), 2)
    overdue = round(sum(i["left"] for i in open_inv if i["overdue"]), 2)
    upcoming = next((i for i in open_inv if not i["overdue"] and i["due_date"]), None)

    # Zadania dla partnera — kolejność = ważność.
    tasks = []
    for i in open_inv:
        if i["overdue"] and not i["pending"]:
            tasks.append({"kind": "invoice_overdue", "level": "bad", "invoice_id": i["id"],
                          "title": f"Faktura {i['nr']} jest po terminie",
                          "text": f"{float(i['left']):,.2f} zł".replace(",", " ").replace(".", ",")
                                  + f" · termin minął {i['due_date'].strftime('%d.%m')}"})
    if need_label:
        n = len(need_label)
        tasks.append({"kind": "need_label", "level": "warn", "orders": need_label,
                      "title": f"{n} {'zamówienie czeka' if n == 1 else ('zamówienia czekają' if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else 'zamówień czeka')} na etykietę",
                      "text": "Bez etykiety magazyn nie rozpocznie realizacji."})
    if need_pay:
        n = len(need_pay)
        tasks.append({"kind": "need_payment", "level": "warn", "orders": need_pay,
                      "title": f"{n} {'zamówienie czeka' if n == 1 else ('zamówienia czekają' if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else 'zamówień czeka')} na wpłatę",
                      "text": "Realizację zaczniemy po zaksięgowaniu przelewu."})
    for i in open_inv:
        if not i["overdue"] and i["days"] is not None and i["days"] <= 7 and not i["pending"]:
            kiedy = "dziś" if i["days"] == 0 else ("jutro" if i["days"] == 1 else f"za {i['days']} dni")
            tasks.append({"kind": "invoice_due", "level": "info", "invoice_id": i["id"],
                          "title": f"Faktura {i['nr']} do zapłaty",
                          "text": f"{float(i['left']):,.2f} zł".replace(",", " ").replace(".", ",") + f" · termin {kiedy}"})

    credit = None
    if p.credit_limit is not None and p.payment_mode == "zbiorcza":
        used = float(await _credit_used(db, p.id))
        credit = {"limit": p.credit_limit, "used": round(used, 2), "free": round(p.credit_limit - used, 2)}

    # Wiek liczymy w bazie: updated_at jest bez strefy, więc w przeglądarce łatwo o 2 h różnicy.
    r = await db.execute(text(
        "SELECT FLOOR(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - MAX(updated_at))) / 60) "
        "FROM dropy.catalog_cache WHERE firma = ANY(:f)"
    ), {"f": p.firmy})
    age = r.scalar()
    catalog_age_min = int(age) if age is not None else None

    # Ostatnie zamówienia w pełnym kształcie — z Startu otwierają się te same szczegóły co z listy.
    r = await db.execute(text(
        "SELECT * FROM dropy.orders WHERE partner_id = :p ORDER BY created_at DESC, id DESC LIMIT 5"
    ), {"p": p.id})
    recent = [dict(x) for x in r.mappings()]
    items: dict = {}
    if recent:
        ri = await db.execute(text("SELECT * FROM dropy.order_items WHERE order_id = ANY(:ids) ORDER BY id"),
                              {"ids": [o["id"] for o in recent]})
        for it in ri.mappings():
            items.setdefault(it["order_id"], []).append(dict(it))

    return {
        "month": first.strftime("%Y-%m"),
        "orders": {
            "count": count, "prev_count": prev_count, "net": round(net, 2),
            "avg_net": round(net / count, 2) if count else 0,
            "sent": by_status.get("wyslane", 0),
            "in_progress": sum(by_status.get(s_, 0) for s_ in ("nowe", "przyjete", "spakowane")),
            "waiting": sum(by_status.get(s_, 0) for s_ in ("platnosc", "etykieta")),
        },
        "finance": {
            "due": due, "overdue": overdue, "open_invoices": len(open_inv),
            "next_due": {"nr": upcoming["nr"], "date": upcoming["due_date"]} if upcoming else None,
        },
        "credit": credit,
        "by_firma": [{"firma": f, "net": round(by_firma.get(f, 0.0), 2)} for f in p.firmy],
        "tasks": tasks,
        "recent": [_out(o, items.get(o["id"], [])) for o in recent],
        "catalog_age_min": catalog_age_min,
    }
