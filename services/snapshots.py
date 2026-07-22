"""Snapshoty KPI i stanów magazynowych.

Zapisywane 2× dziennie (7:05 i 20:05 czasu warszawskiego) — po synchronizacji
z Subiektem, żeby liczby były świeże. Dwie tabele:

  · app_kpi_snapshots   — 4 KPI × firma × pora (mała, szybkie raporty)
  · app_stock_snapshots — per SKU × pora (cena, stan główny, w drodze, w kontenerze)

Historii NIE DA SIĘ odtworzyć wstecz (Subiekt nie trzyma historii stanu), dlatego
zapis jest idempotentny (ON CONFLICT DO UPDATE) i uzupełniany przy starcie apki,
gdy proces nie żył o właściwej godzinie.

Rozłączność ilości (żeby nic nie liczyło się podwójnie):
  stan_glowny    — magazyn główny w Subiekcie
  stan_w_drodze  — drugi magazyn subiektowy (towar już wbity, płynie)
  w_kontenerze   — TYLKO czerwone loty (jeszcze niewbite do Subiektu)
"""
from datetime import date
from typing import Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from services.products import fetch_products
from services.containers import fetch_containers

# Kapitał w towarze to CAŁY stan, niezależnie od klasyfikacji sprzedażowej.
ALL_STATUSES = {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE", "SAMPLE"}
SLOTS = ("rano", "wieczor")
DEFAULT_FIRMA_SLUG = "amh"


# ── pomocnicze ───────────────────────────────────────────────

async def _firma_slugs(db: AsyncSession) -> List[str]:
    """Slugi firm z bazy; AMH zawsze obecny (NULL firma_id = AMH)."""
    try:
        r = await db.execute(text(f"SELECT slug FROM {settings.TABLE_FIRMY} ORDER BY id"))
        slugs = [(row[0] or "").strip().lower() for row in r if row[0]]
    except Exception:
        slugs = []
    if DEFAULT_FIRMA_SLUG not in slugs:
        slugs.insert(0, DEFAULT_FIRMA_SLUG)
    return slugs


def _red_container_value(containers, shop: str) -> float:
    """Wartość CZERWONEJ części (jeszcze nie w Subiekcie) niedostarczonych kontenerów.

    shop="" → całość; shop=slug → tylko towar tej firmy (per lot, z firma_breakdown).
    Lustro frontowego splitSubiekt() — te same reguły, żeby KPI się zgadzało z pulpitem.
    """
    total = 0.0
    for c in containers:
        if (c.effective_status or c.status) == "DELIVERED":
            continue
        lots = c.lots or []
        consolidated = bool(c.is_consolidated) and len(lots) > 0
        if consolidated:
            for l in lots:
                if l.subiekt_wbite:
                    continue                      # zielony → liczony z magazynu subiektowego
                if shop:
                    share = (l.firma_breakdown or {}).get(shop)
                    total += float(getattr(share, "value", 0.0) or 0.0) if share else 0.0
                else:
                    total += float(l.total_value or 0.0)
        else:
            if c.subiekt_wbite:
                continue
            if shop:
                share = (c.firma_breakdown or {}).get(shop)
                total += float(getattr(share, "value", 0.0) or 0.0) if share else 0.0
            else:
                total += float(c.total_value or 0.0)
    return round(total, 2)


async def _transit_warehouse_value(db: AsyncSession) -> float:
    """Magazyn w drodze = Σ stan_magazyn_w_drodze × cena_jednostkowa (tabela subiektowa, AMH)."""
    try:
        r = await db.execute(text(f"""
            SELECT COALESCE(SUM(stan_magazyn_w_drodze * cena_jednostkowa), 0)
            FROM {settings.TABLE_SUBIEKT_DWA}
            WHERE stan_magazyn_w_drodze IS NOT NULL AND stan_magazyn_w_drodze > 0
        """))
        return round(float(r.scalar() or 0), 2)
    except Exception:
        return 0.0


# ── KPI ──────────────────────────────────────────────────────

async def build_kpi_rows(db: AsyncSession) -> List[dict]:
    """4 KPI dla zakresu globalnego ('all') i każdej firmy.

    magazyn_pln     — Σ stock_value z katalogu (ten sam co pulpit, wszystkie statusy)
    w_drodze_pln    — z drugiego magazynu subiektowego; AMH-owy, więc 0 poza AMH/all
    kontenery_pln   — czerwone loty, zawężone do firmy
    kapital_pln     — magazyn + w drodze
    """
    containers = await fetch_containers(db)
    transit_all = await _transit_warehouse_value(db)
    rows: List[dict] = []

    for scope in ["all"] + await _firma_slugs(db):
        shop = "" if scope == "all" else scope
        products = await fetch_products(db, ALL_STATUSES, shop)
        magazyn = round(sum(float(p.stock_value or 0.0) for p in products), 2)
        # magazyn w drodze jest AMH-owy: dla Acti/Veluxa zostaje 0, aż dostaną własny
        # drugi magazyn w Subiekcie — wtedy liczby wskoczą same, bez zmian w kodzie.
        w_drodze = transit_all if scope in ("all", DEFAULT_FIRMA_SLUG) else 0.0
        kontenery = _red_container_value(containers, shop)
        rows.append({
            "firma_slug": scope,
            "magazyn_pln": magazyn,
            "magazyn_w_drodze_pln": w_drodze,
            "kontenery_pln": kontenery,
            "kapital_pln": round(magazyn + w_drodze, 2),
        })
    return rows


# ── per SKU ──────────────────────────────────────────────────

async def build_stock_rows(db: AsyncSession) -> List[dict]:
    """Stany per SKU × FIRMA — semantyka identyczna jak w zakładce Produkty.

      AMH         → magazyn główny + magazyn „w drodze" z Subiektu (subiekt_dwa_magazyny)
      Acti/Veluxa → stan z Sellasista tego sklepu (magazyn „w drodze" = 0, aż dostaną własny)
      w_kontenerze→ sztuki z kontenerów, przypisane po firmie PRODUKTU (app_product_attrs)

    Dla AMH liczymy tylko CZERWONE loty (zielone są już w magazynie „w drodze" w Subiekcie,
    więc doliczanie ich drugi raz byłoby dublem). Dla pozostałych firm — wszystko, co płynie,
    bo ich stan aktualizuje się dopiero po dostawie.
    """
    rows: Dict[tuple, dict] = {}

    def slot(sku_raw: str, firma: str) -> dict:
        key = ((sku_raw or "").strip().upper(), firma)
        if key not in rows:
            rows[key] = {"sku": (sku_raw or "").strip(), "nazwa": None, "firma_slug": firma,
                         "cena_jednostkowa": 0.0, "stan_glowny": 0, "stan_w_drodze": 0, "w_kontenerze": 0}
        return rows[key]

    # 1) AMH — magazyn główny i „w drodze" z tabeli subiektowej (to magazyn AMH)
    r = await db.execute(text(f"""
        SELECT sku, nazwa,
               COALESCE(stan_magazyn_podstawowy, 0) AS gl,
               COALESCE(stan_magazyn_w_drodze, 0)   AS wd,
               COALESCE(cena_jednostkowa, 0)        AS cena
        FROM {settings.TABLE_SUBIEKT_DWA}
        WHERE sku IS NOT NULL AND TRIM(sku) <> ''
    """))
    price_by_sku: Dict[str, float] = {}
    name_by_sku: Dict[str, str] = {}
    for row in r:
        d = dict(row._mapping)
        t = slot(d["sku"], DEFAULT_FIRMA_SLUG)
        t["nazwa"] = d.get("nazwa") or None
        t["cena_jednostkowa"] = round(float(d["cena"] or 0), 2)
        t["stan_glowny"] += int(d["gl"] or 0)
        t["stan_w_drodze"] += int(d["wd"] or 0)
        key = (d["sku"] or "").strip().upper()
        price_by_sku[key] = t["cena_jednostkowa"]
        if d.get("nazwa"):
            name_by_sku[key] = d["nazwa"]

    # 2) Acti/Veluxa — stany z Sellasista (tabela trzyma wyłącznie sklepy nie-AMH)
    r = await db.execute(text(f"""
        SELECT MAX(es.symbol) AS sku, LOWER(TRIM(es.shop)) AS shop,
               SUM(es.quantity) AS qty, MAX(sk.nazwa) AS nazwa
        FROM {settings.TABLE_EXTERNAL_STOCK} es
        LEFT JOIN sellasist_skus sk ON sk.sku_canon = es.sku_canon
        WHERE es.symbol IS NOT NULL AND TRIM(es.symbol) <> ''
        GROUP BY es.sku_canon, LOWER(TRIM(es.shop))
    """))
    for row in r:
        d = dict(row._mapping)
        firma = (d["shop"] or "").strip().lower() or DEFAULT_FIRMA_SLUG
        t = slot(d["sku"], firma)
        t["stan_glowny"] += int(d["qty"] or 0)
        key = (d["sku"] or "").strip().upper()
        if not t["nazwa"]:
            t["nazwa"] = d.get("nazwa") or name_by_sku.get(key)
        if not t["cena_jednostkowa"]:
            t["cena_jednostkowa"] = price_by_sku.get(key, 0.0)

    # 3) Kontenery — firma z przypisania produktu (jak firma_breakdown)
    rf = await db.execute(text(f"""
        SELECT UPPER(TRIM(a.sku)) AS sku, LOWER(COALESCE(f.slug, '{DEFAULT_FIRMA_SLUG}')) AS slug
        FROM {settings.TABLE_PRODUCT_ATTRS} a
        LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = a.firma_id
        WHERE a.sku IS NOT NULL
    """))
    firma_of = {row[0]: (row[1] or DEFAULT_FIRMA_SLUG) for row in rf if row[0]}

    for c in await fetch_containers(db):
        if (c.effective_status or c.status) == "DELIVERED":
            continue
        lots = c.lots or []
        consolidated = bool(c.is_consolidated) and len(lots) > 0
        wbite_lot = {l.id: bool(l.subiekt_wbite) for l in lots} if consolidated else {}
        for it in (c.items or []):
            key = (getattr(it, "sku", "") or "").strip().upper()
            if not key:
                continue
            firma = firma_of.get(key, DEFAULT_FIRMA_SLUG)
            # AMH: zielone (już w Subiekcie) pomijamy — inaczej dubel z magazynem „w drodze"
            if firma == DEFAULT_FIRMA_SLUG:
                wbite = wbite_lot.get(getattr(it, "lot_id", None), False) if consolidated else bool(c.subiekt_wbite)
                if wbite:
                    continue
            t = slot(getattr(it, "sku", key), firma)
            t["w_kontenerze"] += int(getattr(it, "quantity", 0) or 0)
            if not t["nazwa"]:
                t["nazwa"] = name_by_sku.get(key)
            if not t["cena_jednostkowa"]:
                t["cena_jednostkowa"] = price_by_sku.get(key, 0.0)

    return [v for v in rows.values()
            if v["stan_glowny"] or v["stan_w_drodze"] or v["w_kontenerze"]]


# ── zapis ────────────────────────────────────────────────────

async def store_snapshot(db: AsyncSession, slot: str, snap_date: Optional[date] = None) -> dict:
    """Liczy i zapisuje oba snapshoty. Idempotentnie — powtórka nadpisuje, nie duplikuje."""
    if slot not in SLOTS:
        raise ValueError(f"Nieznana pora: {slot}")
    d = snap_date or date.today()

    kpi_rows = await build_kpi_rows(db)
    for row in kpi_rows:
        await db.execute(text(f"""
            INSERT INTO {settings.TABLE_KPI_SNAPSHOTS}
                (snap_date, snap_slot, firma_slug, kapital_pln, magazyn_pln, magazyn_w_drodze_pln, kontenery_pln, captured_at)
            VALUES (:d, :s, :f, :kap, :mag, :wdr, :kon, CURRENT_TIMESTAMP)
            ON CONFLICT (snap_date, snap_slot, firma_slug) DO UPDATE SET
                kapital_pln = EXCLUDED.kapital_pln,
                magazyn_pln = EXCLUDED.magazyn_pln,
                magazyn_w_drodze_pln = EXCLUDED.magazyn_w_drodze_pln,
                kontenery_pln = EXCLUDED.kontenery_pln,
                captured_at = CURRENT_TIMESTAMP
        """), {"d": d, "s": slot, "f": row["firma_slug"], "kap": row["kapital_pln"],
               "mag": row["magazyn_pln"], "wdr": row["magazyn_w_drodze_pln"], "kon": row["kontenery_pln"]})

    stock_rows = await build_stock_rows(db)
    for row in stock_rows:
        await db.execute(text(f"""
            INSERT INTO {settings.TABLE_STOCK_SNAPSHOTS}
                (snap_date, snap_slot, sku, nazwa, firma_slug, cena_jednostkowa, stan_glowny, stan_w_drodze, w_kontenerze, captured_at)
            VALUES (:d, :s, :sku, :nz, :f, :cena, :gl, :wdr, :kon, CURRENT_TIMESTAMP)
            ON CONFLICT (snap_date, snap_slot, sku, firma_slug) DO UPDATE SET
                nazwa = EXCLUDED.nazwa,
                cena_jednostkowa = EXCLUDED.cena_jednostkowa,
                stan_glowny = EXCLUDED.stan_glowny,
                stan_w_drodze = EXCLUDED.stan_w_drodze,
                w_kontenerze = EXCLUDED.w_kontenerze,
                captured_at = CURRENT_TIMESTAMP
        """), {"d": d, "s": slot, "sku": row["sku"], "nz": row.get("nazwa"), "f": row["firma_slug"],
               "cena": row["cena_jednostkowa"], "gl": row["stan_glowny"],
               "wdr": row["stan_w_drodze"], "kon": row["w_kontenerze"]})

    await db.commit()
    return {"date": d.isoformat(), "slot": slot, "kpi_rows": len(kpi_rows), "sku_rows": len(stock_rows)}


async def missing_slots(db: AsyncSession, snap_date: date, due: List[str]) -> List[str]:
    """Które z należnych pór nie mają jeszcze wpisu (do uzupełnienia po restarcie apki)."""
    if not due:
        return []
    r = await db.execute(text(f"""
        SELECT DISTINCT snap_slot FROM {settings.TABLE_KPI_SNAPSHOTS} WHERE snap_date = :d
    """), {"d": snap_date})
    have = {row[0] for row in r}
    return [s for s in due if s not in have]
