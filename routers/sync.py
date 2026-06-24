"""Świeżość danych: ostatnie pobranie Sellasista/Subiekta + dziennik synchronizacji.

- /api/data-freshness — MAX(data_pobrania) i liczność z tabel źródłowych (odzwierciedla
  realny stan niezależnie od tego, gdzie chodzi ingesta; przeżywa redeploye).
- /api/sync-log — ostatnie wiersze dziennika (app_sync_log) do zakładki w Ustawieniach.

Bez guardu auth (spójnie z resztą — domknięcie w czacie AUTH). Tylko odczyt.
"""

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db

router = APIRouter(prefix="/api", tags=["sync"])


@router.get("/data-freshness")
async def data_freshness(db: AsyncSession = Depends(get_db)):
    # Ostatni bieg per źródło z dziennika (że SPRAWDZILIŚMY, nie że dane się zmieniły).
    log_last = {}
    try:
        r = await db.execute(text(
            f"SELECT source, MAX(finished_at) AS last FROM {settings.TABLE_SYNC_LOG} GROUP BY source"))
        for m in r.mappings().all():
            log_last[m["source"]] = m["last"]
    except Exception:
        pass

    out = {}
    for key, table, logsrc in (
        ("sellasist", settings.TABLE_ORDERS, "sellasist"),
        ("subiekt", settings.TABLE_PRODUCTS, "subiekt"),
    ):
        last_data, cnt = None, 0
        try:
            r = await db.execute(text(f"SELECT MAX(data_pobrania) AS last, COUNT(*) AS cnt FROM {table}"))
            row = r.mappings().first()
            if row:
                last_data = row["last"]
                cnt = int(row["cnt"]) if row["cnt"] is not None else 0
        except Exception:
            pass
        # "Ostatnie pobranie" = najnowszy z: ostatni bieg (dziennik) i ostatnia zmiana danych.
        candidates = [d for d in (last_data, log_last.get(logsrc)) if d is not None]
        last = max(candidates) if candidates else None
        out[key] = {"last": last.isoformat() if last is not None else None, "count": cnt}
    return out


@router.get("/sync-log")
async def sync_log(limit: int = 100, db: AsyncSession = Depends(get_db)):
    limit = max(1, min(500, limit))
    try:
        r = await db.execute(text(
            "SELECT id, source, started_at, finished_at, ok, inserted, updated, "
            "items_added, message, error "
            f"FROM {settings.TABLE_SYNC_LOG} ORDER BY id DESC LIMIT :lim"
        ), {"lim": limit})
        rows = [dict(m) for m in r.mappings().all()]
        for row in rows:
            for k in ("started_at", "finished_at"):
                if row.get(k) is not None:
                    row[k] = row[k].isoformat()
        return rows
    except Exception:
        return []
