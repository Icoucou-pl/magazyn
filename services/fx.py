"""
Kursy walut NBP (tabela A) → PLN.

Trzymamy kurs średni (mid) per 1 jednostka waluty, per dzień roboczy, w app_fx_rates.
Konwencja księgowa: w zapytaniach bierzemy kurs z ostatniego dnia roboczego PRZED datą
zamówienia (rate_date < order_date), więc tutaj zapisujemy po prostu effectiveDate = rate_date.
Brak publikacji (weekend/święto) = brak wiersza; "forward-fill" robi samo zapytanie sezonowe
(MAX(rate_date) < order_date).

Fakty NBP (potwierdzone):
- EUR, CZK, HUF są wszystkie w tabeli A, publikowane codziennie (pon–pt, ~11:00).
- mid jest znormalizowany per 1 jednostkę (HUF ~0.012648, CZK ~0.176, EUR ~4.48) —
  wartość_PLN = wartość_waluty × mid (bez dzielenia przez 100).
- Zakres ≤ 367 dni na jeden request. Brak danych w oknie → HTTP 404.

Bez zewnętrznych zależności: urllib (stdlib) + asyncio.to_thread, żeby nie dokładać
httpx do requirements i nie blokować pętli zdarzeń. Ruch jest śladowy.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from datetime import date, timedelta
from typing import List, Optional, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings

NBP_MAX_RANGE_DAYS = 367   # limit API na pojedynczy request (tabela A)
_HTTP_TIMEOUT = 20         # sekundy


def _fx_currencies() -> List[str]:
    """Lista walut obcych do śledzenia (z env FX_CURRENCIES), wielkimi literami."""
    return [c.strip().upper() for c in settings.FX_CURRENCIES.split(",") if c.strip()]


def _fetch_range_sync(code: str, start: date, end: date) -> List[Tuple[str, float]]:
    """Synchroniczny strzał do NBP po zakres kursów tabeli A.
    Zwraca [(effectiveDate 'YYYY-MM-DD', mid)]. HTTP 404 (brak danych w oknie,
    np. same weekendy) → pusta lista. Inne błędy → wyjątek."""
    url = (
        f"{settings.NBP_API_BASE.rstrip('/')}"
        f"/exchangerates/rates/a/{code.lower()}/{start.isoformat()}/{end.isoformat()}/?format=json"
    )
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "magazyn-fx/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    out: List[Tuple[str, float]] = []
    for row in data.get("rates", []):
        ed = row.get("effectiveDate")
        mid = row.get("mid")
        if ed and mid is not None:
            out.append((ed, float(mid)))
    return out


async def _fetch_range(code: str, start: date, end: date) -> List[Tuple[str, float]]:
    """Asynchroniczna otoczka — blokujący urllib idzie do threadpoola."""
    return await asyncio.to_thread(_fetch_range_sync, code, start, end)


def _chunk_ranges(start: date, end: date, max_days: int = NBP_MAX_RANGE_DAYS):
    """Dzieli [start, end] na okna ≤ max_days (limit API)."""
    cur = start
    while cur <= end:
        chunk_end = min(cur + timedelta(days=max_days - 1), end)
        yield cur, chunk_end
        cur = chunk_end + timedelta(days=1)


async def _upsert_rates(session: AsyncSession, currency: str, rows: List[Tuple[str, float]]) -> int:
    """Idempotentny zapis kursów. ON CONFLICT DO NOTHING — kursy historyczne się nie zmieniają."""
    if not rows:
        return 0
    sql = text(f"""
        INSERT INTO {settings.TABLE_FX_RATES} (currency, rate_date, mid)
        VALUES (:cur, :d, :mid)
        ON CONFLICT (currency, rate_date) DO NOTHING
    """)
    params = [{"cur": currency, "d": ed, "mid": mid} for ed, mid in rows]
    await session.execute(sql, params)
    await session.commit()
    return len(params)


async def _orders_date_span(session: AsyncSession) -> Tuple[Optional[date], Optional[date]]:
    """Zakres dat zamówień (min, max) — pod backfill historii kursów."""
    r = await session.execute(text(f"""
        SELECT MIN({settings.COL_ORDER_DATE})::date AS dmin,
               MAX({settings.COL_ORDER_DATE})::date AS dmax
        FROM {settings.TABLE_ORDERS}
    """))
    row = r.mappings().first()
    if not row or row["dmin"] is None:
        return None, None
    return row["dmin"], row["dmax"]


async def backfill_history(session: AsyncSession) -> dict:
    """Jednorazowo: pobiera kursy NBP dla całej historii zamówień (z buforem na dni
    robocze przed pierwszym zamówieniem) i zapisuje do app_fx_rates. Idempotentne —
    można puszczać wielokrotnie, dołoży tylko brakujące dni."""
    dmin, dmax = await _orders_date_span(session)
    if dmin is None:
        return {"status": "no_orders", "inserted": 0}

    start = dmin - timedelta(days=7)          # bufor: kurs sprzed pierwszego zamówienia
    end = min(dmax, date.today())
    by_currency: dict = {}
    total = 0
    for cur in _fx_currencies():
        cur_total = 0
        for cstart, cend in _chunk_ranges(start, end):
            rows = await _fetch_range(cur, cstart, cend)
            cur_total += await _upsert_rates(session, cur, rows)
        by_currency[cur] = cur_total
        total += cur_total
    return {
        "status": "ok",
        "from": start.isoformat(),
        "to": end.isoformat(),
        "inserted": total,
        "by_currency": by_currency,
    }


async def topup_recent(session: AsyncSession, lookback_days: int = 14) -> dict:
    """Idempotentnie dociąga kursy z ostatnich ~lookback_days dni (łapie nowe dni
    robocze od ostatniego uruchomienia). Wołane przy starcie aplikacji."""
    end = date.today()
    start = end - timedelta(days=lookback_days)
    by_currency: dict = {}
    total = 0
    for cur in _fx_currencies():
        rows = await _fetch_range(cur, start, end)
        n = await _upsert_rates(session, cur, rows)
        by_currency[cur] = n
        total += n
    return {
        "status": "ok",
        "from": start.isoformat(),
        "to": end.isoformat(),
        "inserted": total,
        "by_currency": by_currency,
    }


async def fx_status(session: AsyncSession) -> dict:
    """Diagnostyka: zakres pokrytych kursów per waluta + waluty obecne w zamówieniach
    (żeby wyłapać luki — np. waluta w danych, której nie pobieramy)."""
    r = await session.execute(text(f"""
        SELECT currency,
               MIN(rate_date) AS date_from,
               MAX(rate_date) AS date_to,
               COUNT(*)       AS days
        FROM {settings.TABLE_FX_RATES}
        GROUP BY currency
        ORDER BY currency
    """))
    coverage = [dict(row._mapping) for row in r]

    r2 = await session.execute(text(f"""
        SELECT UPPER(TRIM(COALESCE({settings.COL_ITEM_CURRENCY}, 'PLN'))) AS currency,
               COUNT(*) AS items
        FROM {settings.TABLE_ORDER_ITEMS}
        GROUP BY 1
        ORDER BY 2 DESC
    """))
    in_orders = [dict(row._mapping) for row in r2]

    base = settings.FX_BASE_CURRENCY.upper()
    tracked = set(_fx_currencies()) | {base}
    gaps = [row["currency"] for row in in_orders if row["currency"] not in tracked]

    return {
        "base_currency": base,
        "tracked": _fx_currencies(),
        "coverage": coverage,
        "currencies_in_orders": in_orders,
        "untracked_currencies_in_orders": gaps,
    }
