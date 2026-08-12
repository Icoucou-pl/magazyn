"""Świeżość danych: ostatnie pobranie Sellasista/Subiekta + dziennik synchronizacji.

- /api/data-freshness — MAX(data_pobrania) i liczność z tabel źródłowych (odzwierciedla
  realny stan niezależnie od tego, gdzie chodzi ingesta; przeżywa redeploye).
- /api/sync-log — ostatnie wiersze dziennika (app_sync_log) do zakładki w Ustawieniach.
- /api/backup-status — stan nocnego backupu Supabase (kafelek + historia).

Guard: wymaga zalogowania (get_current_user). Oba endpointy to tylko odczyt,
widoczne dla każdego zalogowanego (pasek świeżości ładuje się wszystkim).
"""

import re
from datetime import datetime, timedelta, timezone

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

    # Fakturownia (Acti/Veluxa) — osobny kafelek. Tabela ma `updated_at` (nie `data_pobrania`),
    # a dziennik loguje per sklep (fakturownia:acti, …), więc obsługujemy ją poza pętlą.
    fakt_data, fakt_cnt = None, 0
    try:
        r = await db.execute(text(
            f"SELECT MAX(updated_at) AS last, COUNT(*) AS cnt FROM {settings.TABLE_FAKTUROWNIA_STOCK}"))
        row = r.mappings().first()
        if row:
            fakt_data = row["last"]
            fakt_cnt = int(row["cnt"]) if row["cnt"] is not None else 0
    except Exception:
        pass
    fakt_log = [v for k, v in log_last.items()
                if v is not None and (k == "fakturownia" or k.startswith("fakturownia:"))]
    fakt_candidates = [d for d in (fakt_data, (max(fakt_log) if fakt_log else None)) if d is not None]
    fakt_last = max(fakt_candidates) if fakt_candidates else None
    out["fakturownia"] = {"last": fakt_last.isoformat() if fakt_last is not None else None, "count": fakt_cnt}
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
            # Wiersze backupu przychodzą w UTC, reszta źródeł w czasie warszawskim —
            # wyrównujemy tutaj, inaczej w jednej tabeli sąsiadują stemple z dwóch stref.
            is_backup = row.get("source") == BACKUP_SOURCE
            for k in ("started_at", "finished_at"):
                if row.get(k) is not None:
                    v = _backup_local(row[k]) if is_backup else row[k]
                    row[k] = v.isoformat()
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


# ── Backup Supabase ─────────────────────────────────────────
# Wiersze pisze GitHub Actions (scripts/log_backup_status.py) przez Data REST API.
BACKUP_SOURCE = "supabase_backup"
# Backup chodzi raz na dobę o 07:00. Próg z zapasem na opóźnienia harmonogramu GitHuba
# (crony potrafią ruszyć z kilkudziesięciominutowym poślizgiem) — po tym czasie mówimy
# „nieaktualny" nawet jeśli ostatni znany bieg był udany.
BACKUP_STALE_HOURS = 26


def _backup_local(dt: datetime | None) -> datetime | None:
    """UTC → czas warszawski (naive).

    OBEJŚCIE, docelowo do usunięcia. Cała aplikacja zapisuje do app_sync_log czas
    LOKALNY jako naive (patrz _now_local() w services/sellasist.py), a front renderuje
    go surowo. log_backup_status.py zapisuje UTC, więc bez tej konwersji backup z 13:42
    pokazywał się w dzienniku jako 11:42 — obok wierszy Sellasista z tej samej minuty.
    Gdy skrypt zacznie zapisywać czas warszawski, TĘ FUNKCJĘ TRZEBA USUNĄĆ,
    inaczej stemple pojadą o dwie godziny w drugą stronę.
    """
    if dt is None:
        return None
    try:
        from zoneinfo import ZoneInfo
        return dt.replace(tzinfo=timezone.utc).astimezone(ZoneInfo("Europe/Warsaw")).replace(tzinfo=None)
    except Exception:
        return dt


# „Backup gotowy: NAZWA; 32.32 MB; public=34; auth_users=0; attachments=84/84; storage_objects=0"
# Skrypt pakuje szczegóły w jeden string, więc rozbieramy go regexpami — każdy kawałek
# osobno i opcjonalnie, żeby zmiana formatu komunikatu nie wywaliła całego kafelka,
# tylko wygasiła brakujące pole. Docelowo skrypt mógłby pisać JSON do osobnej kolumny.
def _parse_backup_message(msg: str | None) -> dict:
    out: dict = {}
    if not msg:
        return out
    if (m := re.search(r"Backup gotowy:\s*([^;]+)", msg)):
        out["artifact"] = m.group(1).strip()
    if (m := re.search(r"([\d.]+)\s*MB", msg)):
        out["size_mb"] = float(m.group(1))
    if (m := re.search(r"public=(\d+)", msg)):
        out["public_tables"] = int(m.group(1))
    if (m := re.search(r"auth_users=(\d+)", msg)):
        out["auth_users"] = int(m.group(1))
    if (m := re.search(r"attachments=(\d+)/(\d+)", msg)):
        out["attachments_with_data"] = int(m.group(1))
        out["attachments_total"] = int(m.group(2))
    if (m := re.search(r"storage_objects=(\d+)", msg)):
        out["storage_objects"] = int(m.group(1))
    return out


@router.get("/backup-status")
async def backup_status(limit: int = 10, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(get_current_user)):
    """Stan nocnego backupu bazy + historia ostatnich prób.

    Status liczymy TUTAJ, nie na froncie, żeby próg świeżości siedział w jednym miejscu.
    """
    limit = max(1, min(50, limit))
    try:
        r = await db.execute(text(
            "SELECT id, started_at, finished_at, ok, message, error "
            f"FROM {settings.TABLE_SYNC_LOG} WHERE source = :src "
            "ORDER BY COALESCE(finished_at, started_at) DESC LIMIT :lim"
        ), {"src": BACKUP_SOURCE, "lim": limit})
        rows = [dict(m) for m in r.mappings().all()]
    except Exception:
        return {"status": "unknown", "last_attempt": None, "last_ok": None,
                "details": {}, "history": [], "stale_hours": BACKUP_STALE_HOURS}

    for row in rows:
        for k in ("started_at", "finished_at"):
            row[k] = _backup_local(row.get(k))
        row["details"] = _parse_backup_message(row.get("message"))

    last = rows[0] if rows else None
    last_ok = next((x for x in rows if x.get("ok") is True and not x.get("error")), None)

    # Kolejność reguł ma znaczenie: świeży błąd bije wszystko, bo znaczy że dziś nie mamy
    # kopii. Dopiero potem sprawdzamy wiek ostatniej udanej — to łapie także przypadek,
    # w którym workflow w ogóle nie wystartował i nie zostawił żadnego wiersza.
    now_local = _backup_local(datetime.now(timezone.utc).replace(tzinfo=None))
    if last is None:
        status = "unknown"
    elif last.get("ok") is not True or last.get("error"):
        status = "error"
    elif last_ok is None:
        status = "unknown"
    else:
        ts = last_ok.get("finished_at") or last_ok.get("started_at")
        status = "stale" if (ts is None or now_local - ts > timedelta(hours=BACKUP_STALE_HOURS)) else "ok"

    def _ser(row: dict | None) -> dict | None:
        if row is None:
            return None
        out = dict(row)
        for k in ("started_at", "finished_at"):
            out[k] = out[k].isoformat() if out.get(k) is not None else None
        return out

    return {
        "status": status,
        "stale_hours": BACKUP_STALE_HOURS,
        "last_attempt": _ser(last),
        "last_ok": _ser(last_ok),
        # Szczegóły z OSTATNIEGO UDANEGO — po nieudanej próbie kafelek dalej pokazuje,
        # co realnie leży w ostatniej dobrej kopii, zamiast pustych pól.
        "details": (last_ok or {}).get("details", {}),
        "history": [_ser(x) for x in rows],
    }
