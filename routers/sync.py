"""Świeżość danych: ostatnie pobranie Sellasista/Subiekta + dziennik synchronizacji.

- /api/data-freshness — MAX(data_pobrania) i liczność z tabel źródłowych (odzwierciedla
  realny stan niezależnie od tego, gdzie chodzi ingesta; przeżywa redeploye).
- /api/sync-log — ostatnie wiersze dziennika (app_sync_log) do zakładki w Ustawieniach.

Guard: wymaga zalogowania (get_current_user). Oba endpointy to tylko odczyt,
widoczne dla każdego zalogowanego (pasek świeżości ładuje się wszystkim).
"""

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import CurrentUser
from security import get_current_user

router = APIRouter(prefix="/api", tags=["sync"])


@router.get("/data-freshness")
async def data_freshness(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
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
        # Ostatni bieg z dziennika: dopasowanie po prefiksie, bo Sellasist loguje per sklep
        # (sellasist:amh, sellasist:acti, …) — bierzemy najnowszy z wszystkich pasujących.
        log_candidates = [v for k, v in log_last.items()
                          if v is not None and (k == logsrc or k.startswith(logsrc + ":"))]
        last_log = max(log_candidates) if log_candidates else None
        # "Ostatnie pobranie" = najnowszy z: ostatni bieg (dziennik) i ostatnia zmiana danych.
        candidates = [d for d in (last_data, last_log) if d is not None]
        last = max(candidates) if candidates else None
        out[key] = {"last": last.isoformat() if last is not None else None, "count": cnt}
    return out


@router.get("/sync-log")
async def sync_log(limit: int = 100, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
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


@router.get("/sellasist/items-debug")
async def items_debug(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Diagnostyka: czy pozycje Sellasista mają wypełniony symbol (SKU), per sklep + próbka Acti."""
    out = {}
    r = await db.execute(text(
        f"SELECT shop, COUNT(*) AS items, "
        f"COUNT(*) FILTER (WHERE symbol IS NOT NULL AND TRIM(symbol) <> '') AS with_symbol, "
        f"COUNT(DISTINCT NULLIF(TRIM(symbol), '')) AS distinct_symbols "
        f"FROM {settings.TABLE_ORDER_ITEMS} GROUP BY shop ORDER BY shop"
    ))
    out["per_shop"] = [dict(row) for row in r.mappings()]
    s = await db.execute(text(
        f"SELECT symbol, product_name, ean, quantity FROM {settings.TABLE_ORDER_ITEMS} "
        f"WHERE shop = 'acti' ORDER BY order_id DESC LIMIT 15"
    ))
    out["acti_sample"] = [dict(row) for row in s.mappings()]
    return out


@router.get("/sellasist/products-probe")
async def products_probe(shop: str = "acti", path: str = "/products",
                         db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Próbnik 2b: pobiera 1-2 produkty z Sellasista danego sklepu i pokazuje realne klucze
    (gdzie SKU, gdzie stan). Tylko do odkrycia kształtu API — potem usuwamy."""
    from services.sellasist import _load_firmy, _http_get
    firmy = await _load_firmy()
    firma = next((f for f in firmy if f.slug == shop), None)
    if not firma:
        return {"error": f"Sklep '{shop}' nieskonfigurowany", "dostepne": [f.slug for f in firmy]}
    try:
        data = await _http_get(firma, path, {"offset": 0})
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "proba_path": path}
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return {"ksztalt_top": type(data).__name__,
                "klucze_top": sorted(data.keys()) if isinstance(data, dict) else None,
                "raw": str(data)[:1500]}
    sample = items[:2]
    keys = sorted(sample[0].keys()) if sample and isinstance(sample[0], dict) else []
    return {"liczba_na_stronie": len(items), "klucze_produktu": keys, "probka": sample}


@router.get("/sellasist/stock-debug")
async def stock_debug(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """2b: podgląd zaciągniętych stanów zewnętrznych (per sklep + próbka)."""
    from config import settings as _s
    out = {}
    r = await db.execute(text(
        f"SELECT shop, COUNT(*) AS pozycje, SUM(quantity) AS suma_stanu "
        f"FROM {_s.TABLE_EXTERNAL_STOCK} GROUP BY shop ORDER BY shop"
    ))
    out["per_shop"] = [dict(x) for x in r.mappings()]
    s = await db.execute(text(
        f"SELECT shop, symbol, sku_canon, quantity, reserved FROM {_s.TABLE_EXTERNAL_STOCK} "
        f"ORDER BY shop, sku_canon LIMIT 20"
    ))
    out["probka"] = [dict(x) for x in s.mappings()]
    return out
