"""
Fakturownia → PostgreSQL (Supabase) — ingesta stanów „w drodze" + ceny zakupu.

KAŻDY sklep ma OSOBNĄ Fakturownię (Acti, Veluxa). Z każdej ciągniemy:

1) /products.json (stronicowane) → mapa product_id → {code, purchase_price_net,
   stock_level_global}. `stock_level` na karcie jest GLOBALNY (suma wszystkich
   magazynów), więc sam w sobie nie mówi ile jest „w drodze".
2) /warehouse_actions.json?warehouse_id=<W_DRODZE> (stronicowane) → ruchy z
   magazynu „Towary w drodze". in_transit_qty = Σ (quantity × sign) po
   niewykasowanych akcjach. Potwierdzone reconem: net == Σ left_quantity.

Wyliczenia zapisywane do `fakturownia_stock` (upsert po firma_id + sku_canon):
  - purchase_price_net  → cena zakupu z karty (najnowszy PZ; jedna na SKU),
  - in_transit_qty      → ilość na magazynie „w drodze",
  - stan_podstawowy     → stock_level_global − in_transit (magazyn główny;
                          PODGLĄD — stan Acti/Veluxa i tak leci z Sellasista).

Konfiguracja per sklep w ENV (Railway), ID magazynów to NIE sekrety — jawne,
bo przy Veluxie będą inne (osobna Fakturownia, własna numeracja):
  FAKTUROWNIA_ACTI_URL, FAKTUROWNIA_ACTI_TOKEN,
  FAKTUROWNIA_ACTI_WH_MAIN, FAKTUROWNIA_ACTI_WH_DRODZE   (analogicznie _VELUXA_)

Sklep = wiersz z app_firmy (is_self = false → nie-AMH). Slug (np. „acti") daje
nazwę zmiennych: FAKTUROWNIA_<SLUG_UPPER>_*. firma_id bierzemy z app_firmy, żeby
wpięło się w resztę apki (kolory/nazwy/rozbicia per sklep za darmo).

HTTP: urllib (stdlib) + asyncio.to_thread (jak services/sellasist.py). Status
biegu trzymany w pamięci procesu (bez nowych tabel poza fakturownia_stock).
Bieg jako zadanie w tle z własną sesją bazy. Do dziennika app_sync_log trafia
OSOBNY wiersz na sklep (source = fakturownia:<slug>) → pasek świeżości danych.
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
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import SessionLocal

_PAGE_SIZE = 100
_PAGE_SAFETY_LIMIT = 500          # twardy limit stron (ochrona przed pętlą)
_TIMEOUT = 60                     # sekundy na pojedynczy request


@dataclass
class Firma:
    """Kontekst jednej Fakturowni (jeden sklep)."""
    slug: str
    firma_id: int
    url: str
    token: str
    wh_main: str
    wh_drodze: str


# ---- Status biegu (w pamięci procesu) ----
_status: Dict[str, Any] = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "rows_upserted": 0,
    "error": None,
    "message": None,
}


def _env(slug: str, key: str) -> str:
    return (os.getenv(f"FAKTUROWNIA_{slug.upper()}_{key}") or "").strip()


async def _load_firmy() -> List["Firma"]:
    """Sklepy nie-AMH z app_firmy, które mają w ENV komplet URL+TOKEN+WH_DRODZE.
    Brak kompletu = sklep pomijamy (nieskonfigurowany), bez błędu."""
    out: List[Firma] = []
    try:
        async with SessionLocal() as session:
            r = await session.execute(text(
                f"SELECT id, slug FROM {settings.TABLE_FIRMY} "
                f"WHERE COALESCE(is_self, FALSE) = FALSE ORDER BY sort_order, id"
            ))
            rows = list(r.mappings())
    except Exception as e:
        print(f"[fakturownia] _load_firmy błąd: {e}")
        return out

    for row in rows:
        slug = (row["slug"] or "").strip()
        if not slug:
            continue
        url, token = _env(slug, "URL"), _env(slug, "TOKEN")
        wh_drodze = _env(slug, "WH_DRODZE")
        if url and token and wh_drodze:
            out.append(Firma(
                slug=slug, firma_id=int(row["id"]),
                url=url.rstrip("/"), token=token,
                wh_main=_env(slug, "WH_MAIN"), wh_drodze=wh_drodze,
            ))
    return out


def is_configured() -> bool:
    """Czy JAKAKOLWIEK Fakturownia ma w ENV komplet URL+TOKEN+WH_DRODZE.
    Skanujemy typowe slugi + cokolwiek z FAKTUROWNIA_*_URL, bez sięgania do bazy."""
    slugs = {"acti", "veluxa"}
    for k in os.environ:
        if k.startswith("FAKTUROWNIA_") and k.endswith("_URL"):
            slugs.add(k[len("FAKTUROWNIA_"):-len("_URL")].lower())
    return any(_env(s, "URL") and _env(s, "TOKEN") and _env(s, "WH_DRODZE") for s in slugs)


def get_status() -> Dict[str, Any]:
    return {**_status, "configured": is_configured()}


def is_running() -> bool:
    return bool(_status["running"])


def mark_started() -> None:
    """Synchronicznie oznacza start (wołane w endpoincie tuż po is_running())."""
    _status.update({
        "running": True,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "finished_at": None,
        "rows_upserted": 0,
        "error": None,
        "message": None,
    })


def _now_local() -> datetime:
    """Czas warszawski jako naive — spójnie ze stemplami Sellasista/Subiektu."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Warsaw")).replace(tzinfo=None)
    except Exception:
        return datetime.now()


def _to_float(v: Any, default: float = 0.0) -> float:
    if v is None:
        return default
    if isinstance(v, str):
        v = v.replace(" ", "").replace(",", ".").strip()
        if v == "":
            return default
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


def _to_int_sign(v: Any) -> int:
    try:
        return int(v)
    except (ValueError, TypeError):
        return 1


# ============================================================
# HTTP
# ============================================================
def _ssl_context() -> Optional[ssl.SSLContext]:
    try:
        return ssl.create_default_context()
    except Exception:
        return None


def _http_get_sync(firma: "Firma", path: str, params: Optional[dict] = None) -> Any:
    """Synchroniczny GET do Fakturowni. api_token idzie w query (jak w API Fakturowni)."""
    q = dict(params or {})
    q["api_token"] = firma.token
    url = f"{firma.url}/{path}?{urllib.parse.urlencode(q)}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=_TIMEOUT, context=_ssl_context()) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw) if raw else None
    # Fakturownia zwraca goły array; wrapper {"value": [...]} to artefakt niektórych klientów.
    if isinstance(data, dict) and isinstance(data.get("value"), list):
        return data["value"]
    return data


async def _http_get(firma: "Firma", path: str, params: Optional[dict] = None) -> Any:
    return await asyncio.to_thread(_http_get_sync, firma, path, params)


async def _fetch_all(firma: "Firma", path: str, params: Optional[dict] = None) -> List[dict]:
    """Stronicowanie po ?page=; stop gdy pusto albo mniej niż _PAGE_SIZE."""
    out: List[dict] = []
    base = dict(params or {})
    for page in range(1, _PAGE_SAFETY_LIMIT + 1):
        batch = await _http_get(firma, path, {**base, "page": page, "per_page": _PAGE_SIZE})
        if not batch:
            break
        if not isinstance(batch, list):
            break
        out.extend(batch)
        if len(batch) < _PAGE_SIZE:
            break
        await asyncio.sleep(0.15)
    return out


# ============================================================
# SCHEMA + UPSERT
# ============================================================
async def _ensure_schema(session: AsyncSession) -> None:
    """Siatka bezpieczeństwa: tworzy fakturownia_stock, gdyby migracja nie była puszczona.
    Idempotentne (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS)."""
    await session.execute(text(
        f"CREATE TABLE IF NOT EXISTS {settings.TABLE_FAKTUROWNIA_STOCK} ("
        " firma_id INTEGER NOT NULL,"
        " sku VARCHAR NOT NULL,"
        " sku_canon VARCHAR NOT NULL,"
        " nazwa VARCHAR,"
        " stan_podstawowy NUMERIC DEFAULT 0,"
        " in_transit_qty NUMERIC DEFAULT 0,"
        " purchase_price_net NUMERIC DEFAULT 0,"
        " updated_at TIMESTAMP DEFAULT now(),"
        " PRIMARY KEY (firma_id, sku_canon)"
        ")"
    ))
    await session.commit()
    await session.execute(text(
        f"CREATE INDEX IF NOT EXISTS idx_fakturownia_stock_canon "
        f"ON {settings.TABLE_FAKTUROWNIA_STOCK} (sku_canon)"
    ))
    await session.commit()


async def _upsert(session: AsyncSession, firma: "Firma", rows: List[dict], sync_time: datetime) -> int:
    """Pełna podmiana danych sklepu: kasuje stare wiersze firmy i wstawia bieżące.
    (Kasowanie zamiast czystego upsertu — SKU zniknięte z Fakturowni nie zostaje jako zombie.)"""
    await session.execute(
        text(f"DELETE FROM {settings.TABLE_FAKTUROWNIA_STOCK} WHERE firma_id = :fid"),
        {"fid": firma.firma_id},
    )
    n = 0
    for row in rows:
        await session.execute(text(
            f"INSERT INTO {settings.TABLE_FAKTUROWNIA_STOCK} "
            "(firma_id, sku, sku_canon, nazwa, stan_podstawowy, in_transit_qty, purchase_price_net, updated_at) "
            "VALUES (:fid, :sku, :canon, :nazwa, :main, :transit, :ppn, :ts) "
            "ON CONFLICT (firma_id, sku_canon) DO UPDATE SET "
            "sku = EXCLUDED.sku, nazwa = EXCLUDED.nazwa, "
            "stan_podstawowy = EXCLUDED.stan_podstawowy, in_transit_qty = EXCLUDED.in_transit_qty, "
            "purchase_price_net = EXCLUDED.purchase_price_net, updated_at = EXCLUDED.updated_at"
        ), {
            "fid": firma.firma_id, "sku": row["sku"], "canon": row["sku_canon"],
            "nazwa": row["nazwa"], "main": row["stan_podstawowy"],
            "transit": row["in_transit_qty"], "ppn": row["purchase_price_net"],
            "ts": sync_time,
        })
        n += 1
    await session.commit()
    return n


# ============================================================
# WYLICZENIE
# ============================================================
def _build_rows(products: List[dict], drodze_actions: List[dict]) -> List[dict]:
    """products → mapa id→(code, ppn, global_stock); akcje „w drodze" → Σ qty*sign per id.
    stan_podstawowy = global − in_transit (są dokładnie 2 magazyny: główny + w drodze)."""
    pmap: Dict[Any, dict] = {}
    for p in products:
        pid = p.get("id")
        if pid is None:
            continue
        pmap[pid] = {
            "code": (p.get("code") or "").strip(),
            "name": (p.get("name") or "").strip(),
            "ppn": _to_float(p.get("purchase_price_net")),
            "global": _to_float(p.get("stock_level")),
        }

    transit: Dict[Any, float] = {}
    for a in drodze_actions:
        if a.get("deleted"):
            continue
        pid = a.get("product_id")
        transit[pid] = transit.get(pid, 0.0) + _to_float(a.get("quantity")) * _to_int_sign(a.get("sign"))

    # Zbiór SKU = wszystko z Fakturowni (produkty). Ilość w drodze doklejamy po product_id.
    rows: List[dict] = []
    for pid, info in pmap.items():
        sku = info["code"]
        if not sku:
            continue
        in_transit = transit.get(pid, 0.0)
        stan_main = info["global"] - in_transit
        if stan_main < 0:
            stan_main = 0.0
        rows.append({
            "sku": sku,
            "sku_canon": sku.lower(),
            "nazwa": info["name"],
            "stan_podstawowy": round(stan_main, 3),
            "in_transit_qty": round(in_transit, 3),
            "purchase_price_net": round(info["ppn"], 2),
        })
    return rows


async def _refresh_one(firma: "Firma", sync_time: datetime) -> dict:
    """Jeden sklep. Łapie własne błędy — awaria jednej Fakturowni nie ubija pozostałych."""
    err: Optional[str] = None
    rows_n = 0
    try:
        products = await _fetch_all(firma, "products.json")
        drodze = await _fetch_all(firma, "warehouse_actions.json", {"warehouse_id": firma.wh_drodze})
        rows = _build_rows(products, drodze)
        async with SessionLocal() as session:
            rows_n = await _upsert(session, firma, rows, sync_time)
        _status["rows_upserted"] += rows_n
    except urllib.error.HTTPError as e:
        err = f"HTTP {e.code}"
    except urllib.error.URLError as e:
        err = f"brak połączenia ({e.reason})"
    except Exception as e:
        err = str(e)
    return {"slug": firma.slug, "ok": err is None, "error": err, "rows": rows_n}


def _result_desc(r: dict) -> str:
    return f"błąd {r['error']}" if not r["ok"] else f"{r['rows']} SKU"


async def run_refresh() -> None:
    """Pełny bieg po WSZYSTKICH skonfigurowanych Fakturowniach. Zakłada mark_started().
    Zawsze kończy się finished/error. Osobny wiersz w dzienniku na sklep."""
    sync_time = _now_local()
    results: List[dict] = []
    try:
        firmy = await _load_firmy()
        if not firmy:
            _status["error"] = "Brak skonfigurowanych Fakturowni (URL + TOKEN + WH_DRODZE w ENV)"
        else:
            async with SessionLocal() as session:
                await _ensure_schema(session)
            results = [await _refresh_one(f, sync_time) for f in firmy]
            _status["message"] = " · ".join(f"{r['slug']}: {_result_desc(r)}" for r in results)
            failed = [r for r in results if not r["ok"]]
            if failed and len(failed) == len(results):
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
                    f"fakturownia:{r['slug']}", sync_time, finished, r["ok"],
                    r["rows"], 0, 0, _result_desc(r) if r["ok"] else None, r["error"],
                )
        else:
            await _write_sync_log("fakturownia", sync_time, finished, _status["error"] is None,
                                  0, 0, 0, _status.get("message"), _status.get("error"))


async def _write_sync_log(source: str, started: datetime, finished: datetime, ok: bool,
                          ins: int, upd: int, items: int,
                          message: Optional[str], error: Optional[str]) -> None:
    """Jeden wiersz do dziennika synchronizacji (świeżość danych). Nigdy nie wywala biegu."""
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
        print(f"[fakturownia] zapis dziennika pominięty: {e}")
