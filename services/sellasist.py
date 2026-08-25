"""
Sellasist → PostgreSQL (Supabase) — ingesta w aplikacji.

Robi dokładnie to, co dwa skrypty z Task Schedulera, tylko z poziomu backendu
(Railway), więc nie wymaga Windowsa:

1) Nagłówki: GET /orders (stronicowane po offset), filtr po dacie (ostatnie
   SELLASIST_DAYS_BACK dni), upsert do `sellasist_orders` + log zmian do
   `sellasist_orders_log` (kolumny śledzone: status_name, payment_status, total,
   currency) — wzorzec ze skryptu nagłówków.
2) Pozycje: dla zamówień, których jeszcze NIE ma w `sellasist_order_items`,
   pobiera GET /orders/{id} i wstawia pozycje (carts) — wzorzec "insert-once"
   ze skryptu pozycji. price_netto = price / (1 + tax_rate/100).

Schemat tabel nietknięty — wstawiamy te same kolumny, które produkują skrypty.

HTTP: urllib (stdlib) + asyncio.to_thread (jak services/fx.py — bez httpx, bez
blokowania pętli zdarzeń). Nagłówek autoryzacji: apiKey (jak w skryptach).

Status biegu trzymany w pamięci procesu (bez nowych tabel). Po redeployu Railway
"ostatnie odświeżenie" się zeruje — sama funkcja działa dalej. Bieg uruchamiany
jako zadanie w tle (asyncio.create_task) z własną sesją bazy (jak _fx_refresh_loop).
"""

from __future__ import annotations

import asyncio
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import SessionLocal


@dataclass
class Firma:
    """Kontekst jednego sklepu Sellasista (z app_firmy + klucz ze zmiennej środowiskowej)."""
    slug: str
    base_url: str
    api_key: str
    is_self: bool = False    # AMH (hub) — stan z Subiektu, NIE ciągniemy stanów z jego Sellasista


async def _load_firmy() -> List["Firma"]:
    """Wczytuje skonfigurowane firmy z app_firmy (base_url ustawiony + klucz w env).
    Fallback: jeśli tabela pusta/niewypełniona, a legacy SELLASIST_* jest ustawione,
    syntetyzuje 'amh' — żeby zachowanie nie zmieniło się dopóki nie skonfigurujesz firm."""
    out: List[Firma] = []
    try:
        async with SessionLocal() as session:
            r = await session.execute(text(
                f"SELECT slug, base_url, api_key_env, is_self FROM {settings.TABLE_FIRMY} ORDER BY sort_order, id"
            ))
            for row in r.mappings():
                base = (row["base_url"] or "").strip()
                key = os.getenv(row["api_key_env"]) if row["api_key_env"] else None
                if base and key:
                    out.append(Firma(slug=row["slug"], base_url=base, api_key=key, is_self=bool(row["is_self"])))
    except Exception as e:
        print(f"[sellasist] _load_firmy błąd (fallback do legacy): {e}")

    if not out and settings.SELLASIST_API_KEY and settings.SELLASIST_BASE_URL:
        out.append(Firma(slug="amh", base_url=settings.SELLASIST_BASE_URL, api_key=settings.SELLASIST_API_KEY, is_self=True))
    return out

# Kolumny zapisywane do sellasist_orders (1:1 ze skryptem nagłówków) + data_pobrania.
_ORDER_COLS = [
    "order_id", "order_date", "status_name", "creator", "email", "total",
    "payment_name", "payment_status", "city", "country_code", "currency",
]
# Zmiana którejkolwiek z tych wartości = UPDATE + wpis do logu.
_TRACKED_COLS = ["status_name", "payment_status", "total", "currency"]

_PAGE_SAFETY_LIMIT = 300          # twardy limit stron (ochrona przed pętlą)

# ---- Status biegu (w pamięci procesu) ----
_status: Dict[str, Any] = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "orders_inserted": 0,
    "orders_updated": 0,
    "items_added": 0,
    "items_reconciled": 0,
    "error": None,
    "message": None,
}


def is_configured() -> bool:
    return bool(settings.SELLASIST_API_KEY and settings.SELLASIST_BASE_URL)


def _now_local() -> datetime:
    """Czas warszawski jako naive datetime — żeby data_pobrania Sellasista zgadzała się
    ze stemplem Subiekta (skrypt na Windows zapisuje czas lokalny). Front pokazuje surowo."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Warsaw")).replace(tzinfo=None)
    except Exception:
        return datetime.now()


def get_status() -> Dict[str, Any]:
    return {**_status, "configured": is_configured()}


def is_running() -> bool:
    return bool(_status["running"])


def mark_started() -> None:
    """Synchronicznie (bez await) oznacza start — wołane w endpoincie tuż po
    sprawdzeniu is_running(), żeby uniknąć podwójnego uruchomienia."""
    _status.update({
        "running": True,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "finished_at": None,
        "orders_inserted": 0,
        "orders_updated": 0,
        "items_added": 0,
        "items_reconciled": 0,
        "error": None,
        "message": None,
    })


# ============================================================
# HTTP
# ============================================================
def _ssl_context() -> Optional[ssl.SSLContext]:
    try:
        return ssl.create_default_context()
    except Exception:
        return None


def _http_get_sync(firma: "Firma", path: str, params: Optional[dict] = None) -> Any:
    """Synchroniczny GET do API Sellasista danego sklepu. Zwraca sparsowany JSON.
    Nagłówek apiKey jak w skryptach. Rzuca wyjątek przy błędzie HTTP."""
    base = firma.base_url.rstrip("/")
    url = f"{base}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("apiKey", firma.api_key)
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=settings.SELLASIST_TIMEOUT, context=_ssl_context()) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw else None


async def _http_get(firma: "Firma", path: str, params: Optional[dict] = None) -> Any:
    return await asyncio.to_thread(_http_get_sync, firma, path, params)


# ============================================================
# NORMALIZACJA (mapowanie pól API → kolumny, 1:1 ze skryptami)
# ============================================================
def _to_float(v: Any, default: Optional[float] = None) -> Optional[float]:
    if v is None:
        return default
    if isinstance(v, str):
        v = v.replace("%", "").replace(" ", "").replace(",", ".").strip()
        if v == "":
            return default
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


def _to_int(v: Any, default: Optional[int] = None) -> Optional[int]:
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return default


def _dig(d: Any, *keys: str) -> Any:
    """Bezpieczne wejście w zagnieżdżony słownik (status.name, payment.currency...)."""
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _parse_dt(v: Any) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v
    s = str(v).strip().replace("T", " ")
    if not s:
        return None
    for fmt, length in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d %H:%M", 16), ("%Y-%m-%d", 10)):
        try:
            return datetime.strptime(s[:length], fmt)
        except ValueError:
            continue
    return None


def _values_differ(old: Any, new: Any) -> bool:
    """Czy wartość się zmieniła. Liczby porównujemy jako liczby (DB zwraca Decimal,
    API float → str('199.00') != str('199.0') dawało fałszywe zmiany). Resztę po tekście."""
    if old is None and new is None:
        return False
    fo = _to_float(old)
    fn = _to_float(new)
    if fo is not None and fn is not None:
        return abs(fo - fn) > 1e-9
    return str(old) != str(new)


def _normalize_order_header(raw: dict) -> dict:
    """Surowe zamówienie z listy → wiersz sellasist_orders."""
    return {
        "order_id":       _to_int(raw.get("id")),
        "order_date":     _parse_dt(raw.get("date")),
        "status_name":    _dig(raw, "status", "name"),
        "creator":        raw.get("creator"),
        "email":          raw.get("email"),
        "total":          _to_float(raw.get("total")),
        "payment_name":   _dig(raw, "payment", "name"),
        "payment_status": _dig(raw, "payment", "status"),
        "city":           _dig(raw, "bill_address", "city"),
        "country_code":   _dig(raw, "bill_address", "country", "code"),
        "currency":       _dig(raw, "payment", "currency"),
    }


def _normalize_items(order_id: int, order_date: Optional[datetime],
                     currency: Optional[str], carts: list) -> List[dict]:
    rows: List[dict] = []
    for item in carts or []:
        price = _to_float(item.get("price"), 0.0) or 0.0
        tax_rate = _to_float(item.get("tax_rate"), 0.0) or 0.0
        quantity = _to_float(item.get("quantity"), 0.0) or 0.0
        price_netto = round(price / (1 + tax_rate / 100), 2) if tax_rate > 0 else price
        rows.append({
            "order_id":     order_id,
            "order_date":   order_date,
            "product_id":   _to_int(item.get("id")),
            "product_name": str(item.get("name", "") or ""),
            "symbol":       str(item.get("symbol", "") or ""),
            "ean":          str(item.get("ean", "") or ""),
            "quantity":     quantity,
            "price":        price,
            "price_netto":  price_netto,
            "tax_rate":     tax_rate,
            "currency":     currency or "PLN",
        })
    return rows


# ============================================================
# POBIERANIE NAGŁÓWKÓW (lista, stronicowana)
# ============================================================
async def _fetch_headers(firma: "Firma", date_from: str) -> List[dict]:
    """Pobiera nagłówki zamówień z ostatnich DAYS_BACK dni (offset += page_size),
    zatrzymuje się gdy partia jest starsza niż date_from albo niepełna."""
    page = settings.SELLASIST_PAGE_SIZE
    offset = 0
    seen: set = set()
    out: List[dict] = []

    for _ in range(_PAGE_SAFETY_LIMIT):
        payload = await _http_get(firma, "/orders", {"offset": offset})
        rows = payload if isinstance(payload, list) else (payload or {}).get("data", [])
        if not rows:
            break

        in_window = [r for r in rows if str(r.get("date", "")) >= date_from]
        older = [r for r in rows if str(r.get("date", "")) < date_from]

        for r in in_window:
            oid = str(r.get("id", ""))
            if oid and oid not in seen:
                seen.add(oid)
                out.append(_normalize_order_header(r))

        if len(older) == len(rows):
            break
        if len(rows) < page:
            break

        offset += page
        await asyncio.sleep(0.2)

    # tylko poprawne id, dedupe
    out = [r for r in out if r.get("order_id") is not None]
    return out


# ============================================================
# ZAPIS: nagłówki (upsert + log) i pozycje (insert-once)
# ============================================================
async def _upsert_headers(session: AsyncSession, firma: "Firma", headers: List[dict], sync_time: datetime) -> set:
    if not headers:
        return set()

    shop = firma.slug
    ids = [h["order_id"] for h in headers]
    res = await session.execute(
        text(f"SELECT * FROM {settings.TABLE_ORDERS} WHERE shop = :shop AND order_id = ANY(:ids)"),
        {"ids": ids, "shop": shop},
    )
    existing = {row["order_id"]: dict(row) for row in res.mappings().all()}

    insert_cols = _ORDER_COLS + ["data_pobrania", "shop"]
    insert_sql = text(
        f"INSERT INTO {settings.TABLE_ORDERS} ({', '.join(insert_cols)}) "
        f"VALUES ({', '.join(':' + c for c in insert_cols)})"
    )
    set_clause = ", ".join(f"{c} = :{c}" for c in _ORDER_COLS if c != "order_id")
    update_sql = text(
        f"UPDATE {settings.TABLE_ORDERS} SET {set_clause}, data_pobrania = :data_pobrania "
        f"WHERE shop = :shop AND order_id = :order_id"
    )
    log_sql = text(
        f"INSERT INTO {settings.TABLE_ORDERS}_log "
        "(sync_time, order_id, shop, change_type, column_name, old_value, new_value) "
        "VALUES (:sync_time, :order_id, :shop, :change_type, :column_name, :old_value, :new_value)"
    )

    inserted_ids: set = set()
    for h in headers:
        oid = h["order_id"]
        row = {**h, "data_pobrania": sync_time, "shop": shop}

        if oid not in existing:
            await session.execute(insert_sql, row)
            await session.execute(log_sql, {
                "sync_time": sync_time, "order_id": str(oid), "shop": shop, "change_type": "INSERT",
                "column_name": None, "old_value": None, "new_value": None,
            })
            _status["orders_inserted"] += 1
            inserted_ids.add(oid)
            continue

        old = existing[oid]
        changes = []
        for col in _TRACKED_COLS:
            new_v = h.get(col)
            old_v = old.get(col)
            if _values_differ(old_v, new_v):
                changes.append((col, old_v, new_v))

        if changes:
            await session.execute(update_sql, row)
            for col, old_v, new_v in changes:
                await session.execute(log_sql, {
                    "sync_time": sync_time, "order_id": str(oid), "shop": shop, "change_type": "UPDATE",
                    "column_name": col,
                    "old_value": None if old_v is None else str(old_v),
                    "new_value": None if new_v is None else str(new_v),
                })
            _status["orders_updated"] += 1

    await session.commit()
    return inserted_ids


async def _ensure_schema(session: AsyncSession) -> None:
    """Tworzy tabelę logu (jeśli brak) i dokłada kolumnę `shop` do zamówień/pozycji/logu.
    Idempotentne. Istniejące wiersze (tylko AMH) dostają DEFAULT 'amh' (backfill).
    Każdy ALTER izolowany własnym commitem — błąd jednego nie psuje pozostałych."""
    await session.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {settings.TABLE_ORDERS}_log (
            log_id      SERIAL PRIMARY KEY,
            sync_time   TIMESTAMP NOT NULL,
            order_id    VARCHAR NOT NULL,
            shop        VARCHAR NOT NULL DEFAULT 'amh',
            change_type VARCHAR NOT NULL,
            column_name VARCHAR,
            old_value   VARCHAR,
            new_value   VARCHAR
        )
    """))
    await session.commit()

    # 2b: stany zewnętrzne (Acti/Veluxa) — stan + rezerwacje per sklep i SKU (kanon bez wielkości liter).
    await session.execute(text(
        "CREATE TABLE IF NOT EXISTS sellasist_stock ("
        " shop VARCHAR NOT NULL,"
        " symbol VARCHAR NOT NULL,"
        " sku_canon VARCHAR NOT NULL,"
        " quantity NUMERIC DEFAULT 0,"
        " reserved NUMERIC DEFAULT 0,"
        " updated_at TIMESTAMP DEFAULT now(),"
        " PRIMARY KEY (shop, sku_canon)"
        ")"
    ))
    await session.commit()

    for tbl in (settings.TABLE_ORDERS, settings.TABLE_ORDER_ITEMS, f"{settings.TABLE_ORDERS}_log"):
        try:
            await session.execute(text(f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS shop VARCHAR NOT NULL DEFAULT 'amh'"))
            await session.commit()
        except Exception as e:
            await session.rollback()
            print(f"[sellasist] migracja {tbl}.shop pominięta: {e}")

    # Unikalność: stary indeks po samym order_id blokuje multi-sklep (ten sam order_id
    # w dwóch sklepach). Zamieniamy na (shop, order_id). Każdy krok izolowany commitem —
    # próbujemy i jako indeks, i jako constraint (zależnie jak był założony).
    for stmt in (
        "DROP INDEX IF EXISTS idx_sellasist_orders_id",
        f"ALTER TABLE {settings.TABLE_ORDERS} DROP CONSTRAINT IF EXISTS idx_sellasist_orders_id",
        f"CREATE UNIQUE INDEX IF NOT EXISTS idx_sellasist_orders_shop_id ON {settings.TABLE_ORDERS} (shop, order_id)",
    ):
        try:
            await session.execute(text(stmt))
            await session.commit()
        except Exception as e:
            await session.rollback()
            print(f"[sellasist] migracja indeksu pominięta ({stmt[:40]}…): {e}")


async def _insert_new_items(session: AsyncSession, firma: "Firma", headers: List[dict], sync_time: datetime,
                            newly_inserted: set) -> None:
    """Dociąga pozycje (GET /orders/{id}) i wstawia carts (insert-once, jak skrypt).
    Żeby hourly nie odpytywał w kółko zamówień z pustym koszykiem, ogranicza się do:
    zamówień świeżo dodanych w tym biegu + krótkiego okna SELLASIST_ITEMS_DAYS_BACK
    (samonaprawa po przerwanym biegu). Membership po stringu — odporne na typ kolumny.
    Zakres istniejących pozycji ograniczony do tego sklepu (shop) — bez kolizji order_id."""
    if not headers:
        return

    shop = firma.slug
    res = await session.execute(
        text(f"SELECT DISTINCT order_id FROM {settings.TABLE_ORDER_ITEMS} WHERE shop = :shop"),
        {"shop": shop},
    )
    existing_ids = {str(r[0]) for r in res.all()}

    cutoff = sync_time - timedelta(days=settings.SELLASIST_ITEMS_DAYS_BACK)
    by_id = {h["order_id"]: h for h in headers}
    targets = []
    for oid, h in by_id.items():
        if str(oid) in existing_ids:
            continue
        od = h.get("order_date")
        recent = od is not None and od >= cutoff
        if oid in newly_inserted or recent:
            targets.append(oid)
    if not targets:
        return

    item_cols = [
        "order_id", "order_date", "product_id", "product_name", "symbol", "ean",
        "quantity", "price", "price_netto", "tax_rate", "currency", "data_pobrania", "shop",
    ]
    insert_sql = text(
        f"INSERT INTO {settings.TABLE_ORDER_ITEMS} ({', '.join(item_cols)}) "
        f"VALUES ({', '.join(':' + c for c in item_cols)})"
    )

    for oid in targets:
        try:
            detail = await _http_get(firma, f"/orders/{oid}")
        except Exception as e:  # pojedyncze zamówienie nie wywala całego biegu
            print(f"[sellasist] detail {shop}/{oid} błąd (pomijam): {e}")
            continue
        if not detail:
            continue
        carts = detail.get("carts", []) if isinstance(detail, dict) else []
        if not carts:
            continue

        hdr = by_id[oid]
        rows = _normalize_items(oid, hdr.get("order_date"), hdr.get("currency"), carts)
        for r in rows:
            await session.execute(insert_sql, {**r, "data_pobrania": sync_time, "shop": shop})
        _status["items_added"] += len(rows)
        await session.commit()
        await asyncio.sleep(0.1)


# ============================================================
# REKONCYLIACJA KOSZYKÓW (naprawa "insert-once")
# ============================================================
# Problem: _insert_new_items pomija zamówienie, które ma JAKIEKOLWIEK pozycje.
# Edycja koszyka w Sellasiście (dopisana pozycja, zmiana ilości, przecena) nigdy
# nie trafiała do bazy → zaniżone sztuki i błędny przychód.
#
# Wyzwalacz (tryb "log"): wpis UPDATE kolumny `total` w sellasist_orders_log ze
# stemplem PÓŹNIEJSZYM niż najstarsze data_pobrania pozycji tego zamówienia.
# Zmiana statusu NIE rusza `total`, więc sygnał jest wąski. Warunek jest samogaszący:
# po podmianie koszyka data_pobrania pozycji przeskakuje do przodu, więc zamówienie
# wypada z kolejki — i wraca dopiero przy KOLEJNEJ edycji.
#
# Tryb "mismatch": total nagłówka > suma pozycji. Łapie edycje sprzed okna nagłówków
# (log o nich nie wie). Kierunek istotny — braki dają różnicę dodatnią, a zestawy
# (linia-rodzic + składowe) zawsze ujemną, więc same się odfiltrowują.
#
# Tryb "all": wszystko od podanej daty — młot, do świadomego użycia.

_RECONCILE_MODES = ("log", "mismatch", "all")


async def _load_firma(shop: str) -> Optional["Firma"]:
    """Jedna firma po slugu (do operacji punktowych spoza biegu)."""
    for f in await _load_firmy():
        if f.slug == shop:
            return f
    return None


async def _items_summary(session: AsyncSession, shop: str, oid: str) -> Dict[str, Any]:
    """Stan koszyka w bazie: liczba linii, sztuk i wartość brutto."""
    r = await session.execute(text(
        f"SELECT COUNT(*) AS linii, COALESCE(SUM(quantity), 0) AS sztuk, "
        f"COALESCE(SUM(quantity * COALESCE(price, 0)), 0) AS wartosc "
        f"FROM {settings.TABLE_ORDER_ITEMS} WHERE shop = :shop AND order_id::varchar = :oid"
    ), {"shop": shop, "oid": str(oid)})
    m = r.mappings().first() or {}
    return {
        "linii": int(m.get("linii") or 0),
        "sztuk": round(float(m.get("sztuk") or 0), 2),
        "wartosc": round(float(m.get("wartosc") or 0), 2),
    }


def _rows_summary(rows: List[dict]) -> Dict[str, Any]:
    """To samo co _items_summary, ale dla świeżo znormalizowanych wierszy z API."""
    return {
        "linii": len(rows),
        "sztuk": round(sum(float(r["quantity"] or 0) for r in rows), 2),
        "wartosc": round(sum(float(r["quantity"] or 0) * float(r["price"] or 0) for r in rows), 2),
    }


async def find_reconcile_candidates(session: AsyncSession, shop: str, since: str,
                                    mode: str = "log", limit: int = 50) -> List[Dict[str, Any]]:
    """Lista zamówień do naprawy. NIE dotyka API — czysty odczyt z bazy."""
    if mode not in _RECONCILE_MODES:
        raise ValueError(f"Nieznany tryb: {mode} (dozwolone: {', '.join(_RECONCILE_MODES)})")
    # asyncpg jest rygorystyczny typowo: string w porównaniu z kolumną timestamp rzuca
    # błędem (a ten, przechodząc obok CORS middleware, objawia się w przeglądarce jako
    # rzekomy problem z CORS). Parsujemy datę tutaj i dodatkowo rzutujemy ją w SQL.
    since_dt = _parse_dt(since)
    if since_dt is None:
        raise ValueError(f"Nieprawidłowa data 'since': {since} (oczekiwany format YYYY-MM-DD)")
    params = {"shop": shop, "since": since_dt, "limit": int(limit)}

    if mode == "log":
        sql = f"""
            WITH poz AS (
                SELECT order_id::varchar AS oid, MIN(data_pobrania) AS pierwsze
                FROM {settings.TABLE_ORDER_ITEMS}
                WHERE shop = :shop
                GROUP BY 1
            )
            SELECT DISTINCT o.order_id::varchar AS oid, o.order_date, o.status_name,
                   o.creator, o.total
            FROM {settings.TABLE_ORDERS} o
            JOIN poz p ON p.oid = o.order_id::varchar
            JOIN {settings.TABLE_ORDERS}_log l
                 ON l.shop = o.shop
                AND l.order_id::varchar = o.order_id::varchar
                AND l.change_type = 'UPDATE'
                AND l.column_name = 'total'
                AND l.sync_time > p.pierwsze
            WHERE o.shop = :shop AND o.order_date >= CAST(:since AS timestamp)
            ORDER BY o.order_date DESC
            LIMIT :limit
        """
    elif mode == "mismatch":
        sql = f"""
            WITH poz AS (
                SELECT order_id::varchar AS oid,
                       SUM(quantity * COALESCE(price, 0)) AS wartosc
                FROM {settings.TABLE_ORDER_ITEMS}
                WHERE shop = :shop
                GROUP BY 1
            )
            SELECT o.order_id::varchar AS oid, o.order_date, o.status_name,
                   o.creator, o.total
            FROM {settings.TABLE_ORDERS} o
            JOIN poz p ON p.oid = o.order_id::varchar
            WHERE o.shop = :shop AND o.order_date >= CAST(:since AS timestamp)
              AND COALESCE(o.total, 0)::numeric - p.wartosc::numeric > 1
            ORDER BY (COALESCE(o.total, 0)::numeric - p.wartosc::numeric) DESC
            LIMIT :limit
        """
    else:  # all
        sql = f"""
            SELECT o.order_id::varchar AS oid, o.order_date, o.status_name,
                   o.creator, o.total
            FROM {settings.TABLE_ORDERS} o
            WHERE o.shop = :shop AND o.order_date >= CAST(:since AS timestamp)
            ORDER BY o.order_date DESC
            LIMIT :limit
        """

    res = await session.execute(text(sql), params)
    return [dict(m) for m in res.mappings().all()]


async def reconcile_one(session: AsyncSession, firma: "Firma", oid: str,
                        sync_time: datetime, dry_run: bool = False) -> Dict[str, Any]:
    """Podmienia koszyk JEDNEGO zamówienia. Zwraca różnicę (przed/po).

    Bezpieczniki:
    · pusta odpowiedź API lub puste `carts` → NIC nie ruszamy (pusty wynik nie może
      wyczyścić danych — to najczęstszy sposób, w jaki taka naprawa niszczy bazę),
    · DELETE i INSERT w JEDNEJ transakcji (brak stanu pośredniego z pustym koszykiem),
    · dry_run → wyłącznie odczyt + policzona różnica, zero zapisów.
    """
    shop = firma.slug
    oid_s = str(oid)
    before = await _items_summary(session, shop, oid_s)

    h = (await session.execute(text(
        f"SELECT order_date, currency FROM {settings.TABLE_ORDERS} "
        f"WHERE shop = :shop AND order_id::varchar = :oid"
    ), {"shop": shop, "oid": oid_s})).mappings().first()
    if not h:
        return {"order_id": oid_s, "shop": shop, "status": "brak_naglowka", "before": before}

    try:
        detail = await _http_get(firma, f"/orders/{oid_s}")
    except Exception as e:
        return {"order_id": oid_s, "shop": shop, "status": "blad_api", "error": str(e), "before": before}

    carts = detail.get("carts", []) if isinstance(detail, dict) else []
    if not carts:
        return {"order_id": oid_s, "shop": shop, "status": "pusty_koszyk_pominieto", "before": before}

    rows = _normalize_items(_to_int(oid_s), h.get("order_date"), h.get("currency"), carts)
    after = _rows_summary(rows)
    diff = {
        "linii": after["linii"] - before["linii"],
        "sztuk": round(after["sztuk"] - before["sztuk"], 2),
        "wartosc": round(after["wartosc"] - before["wartosc"], 2),
    }
    out = {"order_id": oid_s, "shop": shop, "before": before, "after": after, "diff": diff}

    if dry_run:
        out["status"] = "dry_run"
        out["pozycje"] = [
            {"symbol": r["symbol"], "nazwa": r["product_name"],
             "ilosc": r["quantity"], "cena": r["price"]}
            for r in rows
        ]
        return out

    if diff["linii"] == 0 and abs(diff["sztuk"]) < 1e-9 and abs(diff["wartosc"]) < 0.01:
        out["status"] = "bez_zmian"
        return out

    item_cols = [
        "order_id", "order_date", "product_id", "product_name", "symbol", "ean",
        "quantity", "price", "price_netto", "tax_rate", "currency", "data_pobrania", "shop",
    ]
    insert_sql = text(
        f"INSERT INTO {settings.TABLE_ORDER_ITEMS} ({', '.join(item_cols)}) "
        f"VALUES ({', '.join(':' + c for c in item_cols)})"
    )
    try:
        await session.execute(text(
            f"DELETE FROM {settings.TABLE_ORDER_ITEMS} "
            f"WHERE shop = :shop AND order_id::varchar = :oid"
        ), {"shop": shop, "oid": oid_s})
        for r in rows:
            await session.execute(insert_sql, {**r, "data_pobrania": sync_time, "shop": shop})
        await session.execute(text(
            f"INSERT INTO {settings.TABLE_ORDERS}_log "
            "(sync_time, order_id, shop, change_type, column_name, old_value, new_value) "
            "VALUES (:sync_time, :order_id, :shop, 'ITEMS_RECONCILED', 'items', :old, :new)"
        ), {
            "sync_time": sync_time, "order_id": oid_s, "shop": shop,
            "old": f"{before['linii']} lin / {before['sztuk']} szt / {before['wartosc']} zł",
            "new": f"{after['linii']} lin / {after['sztuk']} szt / {after['wartosc']} zł",
        })
        await session.commit()
    except Exception as e:
        await session.rollback()
        out["status"] = "blad_zapisu"
        out["error"] = str(e)
        return out

    _status["items_reconciled"] += 1
    out["status"] = "naprawione"
    return out


async def reconcile_scan(shop: str, since: Optional[str] = None, mode: str = "log",
                         limit: int = 50, dry_run: bool = True) -> Dict[str, Any]:
    """Znajduje kandydatów i (jeśli dry_run=False) naprawia ich po kolei.

    dry_run=True NIE odpytuje API w ogóle — zwraca samą listę kandydatów. To jest
    właściwy sposób na zmierzenie skali przed jakimkolwiek zapisem."""
    since = since or settings.SELLASIST_RECONCILE_SINCE
    firma = await _load_firma(shop)
    if firma is None:
        return {"shop": shop, "error": f"Sklep '{shop}' nie jest skonfigurowany"}

    sync_time = _now_local()
    async with SessionLocal() as session:
        kandydaci = await find_reconcile_candidates(session, shop, since, mode, limit)

        if dry_run:
            return {
                "shop": shop, "mode": mode, "since": since, "dry_run": True,
                "kandydatow": len(kandydaci),
                "limit": limit,
                "zamowienia": kandydaci,
            }

        wyniki: List[Dict[str, Any]] = []
        for k in kandydaci:
            wyniki.append(await reconcile_one(session, firma, k["oid"], sync_time, dry_run=False))
            await asyncio.sleep(0.1)      # ten sam throttling co przy pobieraniu pozycji

    naprawione = [w for w in wyniki if w.get("status") == "naprawione"]
    return {
        "shop": shop, "mode": mode, "since": since, "dry_run": False,
        "kandydatow": len(kandydaci),
        "naprawionych": len(naprawione),
        "sztuk_roznica": round(sum(w["diff"]["sztuk"] for w in naprawione), 2),
        "wartosc_roznica": round(sum(w["diff"]["wartosc"] for w in naprawione), 2),
        "wyniki": wyniki,
    }


async def reconcile_order(shop: str, order_id: str, dry_run: bool = True) -> Dict[str, Any]:
    """Punktowa naprawa jednego zamówienia (endpoint administracyjny)."""
    firma = await _load_firma(shop)
    if firma is None:
        return {"shop": shop, "error": f"Sklep '{shop}' nie jest skonfigurowany"}
    async with SessionLocal() as session:
        return await reconcile_one(session, firma, str(order_id), _now_local(), dry_run=dry_run)


async def _reconcile_pass(session: AsyncSession, firma: "Firma", sync_time: datetime) -> int:
    """Automatyczny pass w biegu: naprawia do SELLASIST_RECONCILE_MAX zamówień
    wykrytych trybem "log". Błąd rekoncyliacji NIE przerywa biegu."""
    if not settings.SELLASIST_RECONCILE_ENABLED:
        return 0
    try:
        kandydaci = await find_reconcile_candidates(
            session, firma.slug, settings.SELLASIST_RECONCILE_SINCE,
            "log", settings.SELLASIST_RECONCILE_MAX,
        )
        n = 0
        for k in kandydaci:
            r = await reconcile_one(session, firma, k["oid"], sync_time, dry_run=False)
            if r.get("status") == "naprawione":
                n += 1
            await asyncio.sleep(0.1)
        return n
    except Exception as e:
        print(f"[sellasist] rekoncyliacja {firma.slug} pominięta: {e}")
        return 0


# ============================================================
# BIEG (zadanie w tle)
async def _fetch_stock(firma: "Firma") -> List[dict]:
    """Pobiera produkty (ze stanami) z Sellasista danego sklepu, stronicowane po offset.
    Zwraca listę surowych produktów (symbol + quantity + reserved)."""
    page = settings.SELLASIST_PAGE_SIZE
    offset = 0
    out: List[dict] = []
    for _ in range(_PAGE_SAFETY_LIMIT):
        payload = await _http_get(firma, "/products", {"offset": offset})
        rows = payload if isinstance(payload, list) else (payload or {}).get("data", [])
        if not rows:
            break
        out.extend(rows)
        if len(rows) < page:
            break
        offset += page
        await asyncio.sleep(0.2)
    return out


async def _upsert_external_stock(session: AsyncSession, firma: "Firma", products: List[dict]) -> int:
    """Pełna podmiana stanów sklepu: kasuje stare wiersze sklepu i wstawia bieżące.
    Klucz kanoniczny = LOWER(TRIM(symbol)), żeby pasował do katalogu (case-insensitive)."""
    await session.execute(text(f"DELETE FROM {settings.TABLE_EXTERNAL_STOCK} WHERE shop = :shop"), {"shop": firma.slug})
    n = 0
    for p in products:
        sku = str(p.get("symbol") or "").strip()
        if not sku:
            continue
        await session.execute(text(
            f"INSERT INTO {settings.TABLE_EXTERNAL_STOCK} (shop, symbol, sku_canon, quantity, reserved, updated_at) "
            "VALUES (:shop, :sku, :canon, :qty, :res, :ts) "
            "ON CONFLICT (shop, sku_canon) DO UPDATE SET symbol = EXCLUDED.symbol, "
            "quantity = EXCLUDED.quantity, reserved = EXCLUDED.reserved, updated_at = EXCLUDED.updated_at"
        ), {"shop": firma.slug, "sku": sku, "canon": sku.lower(),
            "qty": _to_float(p.get("quantity"), 0.0) or 0.0,
            "res": (_to_float(p.get("reserved"), 0.0) or 0.0) if p.get("reserved") not in (None, "") else 0.0,
            "ts": _now_local()})
        n += 1
    await session.commit()
    return n


# ============================================================
async def _refresh_one(firma: "Firma", sync_time: datetime, date_from: str) -> dict:
    """Jeden sklep. Łapie własne błędy — awaria jednej firmy nie ubija pozostałych.
    Zwraca słownik wyniku: slug, ok, ins/upd/items + stany zewnętrzne (dla sklepów nie-AMH)."""
    before = (_status["orders_inserted"], _status["orders_updated"], _status["items_added"],
              _status["items_reconciled"])
    err: Optional[str] = None
    try:
        headers = await _fetch_headers(firma, date_from)
        async with SessionLocal() as session:
            inserted_ids = await _upsert_headers(session, firma, headers, sync_time)
            await _insert_new_items(session, firma, headers, sync_time, inserted_ids)
            # Rekoncyliacja PO wstawieniu nowych pozycji — świeżo dodane koszyki mają
            # data_pobrania = sync_time, więc nie zapalą wyzwalacza w tym samym biegu.
            await _reconcile_pass(session, firma, sync_time)
    except urllib.error.HTTPError as e:
        err = f"HTTP {e.code}"
    except urllib.error.URLError as e:
        err = f"brak połączenia ({e.reason})"
    except Exception as e:
        err = str(e)
    a = (_status["orders_inserted"], _status["orders_updated"], _status["items_added"],
         _status["items_reconciled"])

    # 2b: stany zewnętrzne — tylko sklepy nie-AMH (AMH ma stan z Subiektu, nie dublujemy).
    stock_rows: Optional[int] = None
    stock_err: Optional[str] = None
    if not firma.is_self:
        try:
            products = await _fetch_stock(firma)
            async with SessionLocal() as session:
                stock_rows = await _upsert_external_stock(session, firma, products)
        except urllib.error.HTTPError as e:
            stock_err = f"HTTP {e.code}"
        except urllib.error.URLError as e:
            stock_err = f"brak połączenia ({e.reason})"
        except Exception as e:
            stock_err = str(e)

    return {
        "slug": firma.slug, "ok": err is None, "error": err,
        "ins": a[0] - before[0], "upd": a[1] - before[1], "items": a[2] - before[2],
        "reconciled": a[3] - before[3],
        "stock_rows": stock_rows, "stock_err": stock_err,
    }


def _result_desc(r: dict) -> str:
    if not r["ok"]:
        return f"błąd {r['error']}"
    base = f"+{r['ins']} nowych, {r['upd']} zm., +{r['items']} poz."
    if r.get("reconciled"):
        base += f" · koszyki naprawione: {r['reconciled']}"
    if r.get("stock_err"):
        base += f" · stan: błąd {r['stock_err']}"
    elif r.get("stock_rows") is not None:
        base += f" · stan: {r['stock_rows']} poz."
    return base


async def run_refresh() -> None:
    """Pełny bieg po WSZYSTKICH skonfigurowanych firmach (sklepach). Zakłada, że
    mark_started() zostało już wywołane. Zawsze kończy się ustawieniem finished/error.
    Komunikat to rozbicie per sklep — błąd jednego sklepu NIE chowa wyniku pozostałych.
    Do dziennika trafia OSOBNY wiersz na każdy sklep (source = sellasist:<slug>)."""
    sync_time = _now_local()
    date_from = (sync_time - timedelta(days=settings.SELLASIST_DAYS_BACK)).strftime("%Y-%m-%d")
    results: List[dict] = []
    try:
        firmy = await _load_firmy()
        if not firmy:
            _status["error"] = "Brak skonfigurowanych firm (base_url + klucz API)"
        else:
            async with SessionLocal() as session:
                await _ensure_schema(session)
            results = [await _refresh_one(f, sync_time, date_from) for f in firmy]

            _status["message"] = " · ".join(f"{r['slug']}: {_result_desc(r)}" for r in results)
            failed = [r for r in results if not r["ok"]]
            if failed and len(failed) == len(results):     # wszystkie padły → realny błąd biegu
                _status["error"] = "; ".join(f"{r['slug']}: {r['error']}" for r in failed)
    except Exception as e:
        _status["error"] = str(e)
    finally:
        _status["running"] = False
        finished = _now_local()
        _status["finished_at"] = datetime.now().isoformat(timespec="seconds")
        if results:
            for r in results:
                await _write_sync_log(
                    f"sellasist:{r['slug']}", sync_time, finished, r["ok"],
                    r["ins"], r["upd"], r["items"],
                    _result_desc(r) if r["ok"] else None, r["error"],
                )
        else:
            # brak firm / wyjątek przed pętlą — jeden wpis informacyjny, żeby ślad był
            await _write_sync_log("sellasist", sync_time, finished, _status["error"] is None,
                                  0, 0, 0, _status.get("message"), _status.get("error"))


async def _write_sync_log(source: str, started: datetime, finished: datetime, ok: bool,
                          ins: int, upd: int, items: int,
                          message: Optional[str], error: Optional[str]) -> None:
    """Dopisuje JEDEN wiersz do dziennika synchronizacji (świeżość danych w Ustawieniach).
    Własna sesja; nigdy nie wywala biegu — log to dodatek, nie krytyczna ścieżka."""
    try:
        async with SessionLocal() as session:
            await session.execute(text(
                f"INSERT INTO {settings.TABLE_SYNC_LOG} "
                "(source, started_at, finished_at, ok, inserted, updated, items_added, message, error) "
                "VALUES (:src, :s, :f, :ok, :ins, :upd, :items, :msg, :err)"
            ), {
                "src": source, "s": started, "f": finished, "ok": ok,
                "ins": ins, "upd": upd, "items": items, "msg": message, "err": error,
            })
            await session.commit()
    except Exception as e:
        print(f"[sellasist] zapis dziennika pominięty: {e}")
