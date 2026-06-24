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
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import SessionLocal

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


def _http_get_sync(path: str, params: Optional[dict] = None) -> Any:
    """Synchroniczny GET do API Sellasista. Zwraca sparsowany JSON.
    Nagłówek apiKey jak w skryptach. Rzuca wyjątek przy błędzie HTTP."""
    base = settings.SELLASIST_BASE_URL.rstrip("/")
    url = f"{base}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("apiKey", settings.SELLASIST_API_KEY)
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=settings.SELLASIST_TIMEOUT, context=_ssl_context()) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw else None


async def _http_get(path: str, params: Optional[dict] = None) -> Any:
    return await asyncio.to_thread(_http_get_sync, path, params)


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
async def _fetch_headers(date_from: str) -> List[dict]:
    """Pobiera nagłówki zamówień z ostatnich DAYS_BACK dni (offset += page_size),
    zatrzymuje się gdy partia jest starsza niż date_from albo niepełna."""
    page = settings.SELLASIST_PAGE_SIZE
    offset = 0
    seen: set = set()
    out: List[dict] = []

    for _ in range(_PAGE_SAFETY_LIMIT):
        payload = await _http_get("/orders", {"offset": offset})
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
async def _upsert_headers(session: AsyncSession, headers: List[dict], sync_time: datetime) -> set:
    if not headers:
        return set()

    ids = [h["order_id"] for h in headers]
    res = await session.execute(
        text(f"SELECT * FROM {settings.TABLE_ORDERS} WHERE order_id = ANY(:ids)"),
        {"ids": ids},
    )
    existing = {row["order_id"]: dict(row) for row in res.mappings().all()}

    insert_cols = _ORDER_COLS + ["data_pobrania"]
    insert_sql = text(
        f"INSERT INTO {settings.TABLE_ORDERS} ({', '.join(insert_cols)}) "
        f"VALUES ({', '.join(':' + c for c in insert_cols)})"
    )
    set_clause = ", ".join(f"{c} = :{c}" for c in _ORDER_COLS if c != "order_id")
    update_sql = text(
        f"UPDATE {settings.TABLE_ORDERS} SET {set_clause}, data_pobrania = :data_pobrania "
        f"WHERE order_id = :order_id"
    )
    log_sql = text(
        f"INSERT INTO {settings.TABLE_ORDERS}_log "
        "(sync_time, order_id, change_type, column_name, old_value, new_value) "
        "VALUES (:sync_time, :order_id, :change_type, :column_name, :old_value, :new_value)"
    )

    inserted_ids: set = set()
    for h in headers:
        oid = h["order_id"]
        row = {**h, "data_pobrania": sync_time}

        if oid not in existing:
            await session.execute(insert_sql, row)
            await session.execute(log_sql, {
                "sync_time": sync_time, "order_id": str(oid), "change_type": "INSERT",
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
                    "sync_time": sync_time, "order_id": str(oid), "change_type": "UPDATE",
                    "column_name": col,
                    "old_value": None if old_v is None else str(old_v),
                    "new_value": None if new_v is None else str(new_v),
                })
            _status["orders_updated"] += 1

    await session.commit()
    return inserted_ids


async def _ensure_log_table(session: AsyncSession) -> None:
    await session.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {settings.TABLE_ORDERS}_log (
            log_id      SERIAL PRIMARY KEY,
            sync_time   TIMESTAMP NOT NULL,
            order_id    VARCHAR NOT NULL,
            change_type VARCHAR NOT NULL,
            column_name VARCHAR,
            old_value   VARCHAR,
            new_value   VARCHAR
        )
    """))
    await session.commit()


async def _insert_new_items(session: AsyncSession, headers: List[dict], sync_time: datetime,
                            newly_inserted: set) -> None:
    """Dociąga pozycje (GET /orders/{id}) i wstawia carts (insert-once, jak skrypt).
    Żeby hourly nie odpytywał w kółko zamówień z pustym koszykiem, ogranicza się do:
    zamówień świeżo dodanych w tym biegu + krótkiego okna SELLASIST_ITEMS_DAYS_BACK
    (samonaprawa po przerwanym biegu). Membership po stringu — odporne na typ kolumny."""
    if not headers:
        return

    res = await session.execute(text(f"SELECT DISTINCT order_id FROM {settings.TABLE_ORDER_ITEMS}"))
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
        "quantity", "price", "price_netto", "tax_rate", "currency", "data_pobrania",
    ]
    insert_sql = text(
        f"INSERT INTO {settings.TABLE_ORDER_ITEMS} ({', '.join(item_cols)}) "
        f"VALUES ({', '.join(':' + c for c in item_cols)})"
    )

    for oid in targets:
        try:
            detail = await _http_get(f"/orders/{oid}")
        except Exception as e:  # pojedyncze zamówienie nie wywala całego biegu
            print(f"[sellasist] detail {oid} błąd (pomijam): {e}")
            continue
        if not detail:
            continue
        carts = detail.get("carts", []) if isinstance(detail, dict) else []
        if not carts:
            continue

        hdr = by_id[oid]
        rows = _normalize_items(oid, hdr.get("order_date"), hdr.get("currency"), carts)
        for r in rows:
            await session.execute(insert_sql, {**r, "data_pobrania": sync_time})
        _status["items_added"] += len(rows)
        await session.commit()
        await asyncio.sleep(0.1)


# ============================================================
# BIEG (zadanie w tle)
# ============================================================
async def run_refresh() -> None:
    """Pełny bieg: nagłówki (upsert+log) + pozycje (insert-once). Zakłada, że
    mark_started() zostało już wywołane. Zawsze kończy się ustawieniem finished/error."""
    sync_time = _now_local()
    date_from = (sync_time - timedelta(days=settings.SELLASIST_DAYS_BACK)).strftime("%Y-%m-%d")
    try:
        headers = await _fetch_headers(date_from)
        async with SessionLocal() as session:
            await _ensure_log_table(session)
            inserted_ids = await _upsert_headers(session, headers, sync_time)
            await _insert_new_items(session, headers, sync_time, inserted_ids)
        _status["message"] = (
            f"+{_status['orders_inserted']} nowych, "
            f"{_status['orders_updated']} zmienionych, "
            f"+{_status['items_added']} pozycji"
        )
    except urllib.error.HTTPError as e:
        _status["error"] = f"HTTP {e.code} z Sellasista"
    except urllib.error.URLError as e:
        _status["error"] = f"Brak połączenia z Sellasistem: {e.reason}"
    except Exception as e:
        _status["error"] = str(e)
    finally:
        _status["running"] = False
        _status["finished_at"] = datetime.now().isoformat(timespec="seconds")
        await _write_sync_log(sync_time, _now_local())


async def _write_sync_log(started: datetime, finished: datetime) -> None:
    """Dopisuje wiersz do dziennika synchronizacji (świeżość danych w Ustawieniach).
    Własna sesja; nigdy nie wywala biegu — log to dodatek, nie krytyczna ścieżka."""
    try:
        async with SessionLocal() as session:
            await session.execute(text(
                f"INSERT INTO {settings.TABLE_SYNC_LOG} "
                "(source, started_at, finished_at, ok, inserted, updated, items_added, message, error) "
                "VALUES ('sellasist', :s, :f, :ok, :ins, :upd, :items, :msg, :err)"
            ), {
                "s": started, "f": finished, "ok": _status["error"] is None,
                "ins": _status["orders_inserted"], "upd": _status["orders_updated"],
                "items": _status["items_added"],
                "msg": _status["message"], "err": _status["error"],
            })
            await session.commit()
    except Exception as e:
        print(f"[sellasist] zapis dziennika pominięty: {e}")
