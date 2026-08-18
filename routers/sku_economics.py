"""Raporty ekonomiczne per SKU: koszt magazynowania i SKU do wykluczenia.

Oba raporty jadą na jednym silniku (`_economics`), bo liczą to samo z różnym
akcentem: ile dany towar zarabia i ile kosztuje jego miejsce w hali.

ŹRÓDŁA I ICH OGRANICZENIA — czytaj, zanim zaufasz liczbom:

1. Przychód — `sellasist_order_items.price_netto` × ilość, przeliczone na PLN
   kursem NBP z dnia POPRZEDZAJĄCEGO zamówienie (konwencja D-1, ta sama co
   w Finansach i kontenerach). Filtr statusów wspólny z resztą systemu.

2. Koszt zakupu — pełny łańcuch `sql.PRODUCT_PRICES_CTE` (ręczna nadpiska →
   Fakturownia → nowy Subiekt → stary Subiekt). UWAGA: moduł Finanse liczy koszt
   wyłącznie ze starego Subiekta, przez co dla Acti/Veluxa pokazuje zero kosztu
   i zawyżoną marżę. Dopóki tamto nie zostanie poprawione (patrz
   docs/FINANSE_KOSZT_ZAKUPU_TODO.md), marże TU i TAM się nie zgodzą.
   Ten raport pokazuje wartość prawdziwą.
   Druga rzecz: cena zakupu jest BIEŻĄCA, nie z momentu sprzedaży. Przy SKU,
   którego cena mocno skoczyła między kontenerami, marża historyczna jest
   przybliżeniem.

3. Sprzedaż liczona GLOBALNIE, bez filtra po sklepie — towar Acti/Veluxa
   sprzedany przez Sellasist AMH to realny rozchód z magazynu firmy będącej
   właścicielem SKU. Firma bierze się z `app_product_attrs.firma_id`, tak samo
   jak w zajętości i Prognozie. Filtrowanie po sklepie zaniżałoby popyt.

4. Koszt magazynu — czynsz firmy rozłożony po ZAJĘTEJ objętości:
   stawka = czynsz / suma m³ towaru stojącego w hali. Cały czynsz ląduje więc na
   towarze i suma zgadza się z fakturą; pusta przestrzeń raportowana jest osobno
   (`empty_cost_pln`), a nie rozmywana po produktach.
   SKU bez `cbm_per_unit` dostaje koszt None, NIE zero — zero robiłoby z niego
   najbardziej rentowną pozycję w zestawieniu.

5. Tryb okresu (`mode`):
   · `runrate` (domyślny) — koszt miejsca w skali roku z dzisiejszej zajętości,
     marża YTD zannualizowana. Nie udaje wiedzy o przeszłości; decyzja „czy dalej
     to ściągać" jest i tak decyzją o przyszłości.
   · `ytd`     — koszt miejsca × liczba miesięcy od stycznia. Wygląda dokładniej,
     ale zakłada, że dzisiejszy stan stał w hali cały rok. Snapshoty sięgają
     dopiero 2026-07-24, więc wcześniejszych miesięcy NIE MA z czego policzyć —
     stąd `estimated: true` w odpowiedzi.

6. Stockout liczony z `app_stock_snapshots` — udział dni z zerowym stanem.
   Okno = tyle, ile mamy snapshotów. Chroni bestsellery wyprzedane między
   kontenerami przed etykietą „do wykluczenia": brak sprzedaży z braku towaru to
   nie brak popytu.
"""
from datetime import date, timedelta
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, INCLUDED_STATUS_FILTER
from sql import PRODUCT_NAMES_QUERY, PRODUCT_PRICES_QUERY
from database import get_db
from models import CurrentUser
from security import get_current_user, has_perm, resolve_scope
from services.snapshots import build_stock_rows
from audit import log_audit

router = APIRouter(prefix="/api", tags=["reports"])

FIRMA_LABELS = {"amh": "AMH", "acti": "Acti", "veluxa": "Veluxa"}

# Werdykt: poniżej progu → czerwony, poniżej dwukrotności → żółty, wyżej → zielony.
WATCH_MULTIPLIER = 2.0


def _require_economics(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """Te raporty pokazują marże per SKU — samo `viewReports` to za mało."""
    if not has_perm(user, "viewReports"):
        raise HTTPException(403, "Brak uprawnienia do raportów")
    if not has_perm(user, "viewFinancials"):
        raise HTTPException(403, "Brak uprawnienia do danych finansowych")
    return user


# ── konfiguracja ─────────────────────────────────────────────

class CostIn(BaseModel):
    firma_slug: str = Field(min_length=1, max_length=40)
    monthly_cost_pln: float = 0.0
    note: Optional[str] = None


class EconConfigIn(BaseModel):
    costs: List[CostIn] = []
    profit_threshold_pln: Optional[float] = None
    min_history_months: Optional[int] = None
    stockout_tolerance_pct: Optional[float] = None
    excluded_skus: Optional[List[str]] = None


async def _load_costs(db: AsyncSession) -> Dict[str, dict]:
    """Czynsz per firma. Brak tabeli → pusto, raport pokaże baner zamiast zer."""
    out: Dict[str, dict] = {}
    try:
        r = await db.execute(text("""
            SELECT LOWER(TRIM(firma_slug)) AS slug, monthly_cost_pln, note
            FROM app_warehouse_cost
        """))
        for m in r.mappings():
            if m["slug"]:
                out[m["slug"]] = {"monthly_cost_pln": float(m["monthly_cost_pln"] or 0),
                                  "note": m["note"]}
    except Exception:
        pass
    return out


async def _load_caps(db: AsyncSession) -> Dict[str, float]:
    """Pojemność hal — potrzebna wyłącznie do wyliczenia kosztu pustej przestrzeni."""
    out: Dict[str, float] = {}
    try:
        r = await db.execute(text("SELECT LOWER(firma_slug) AS slug, capacity_m3 FROM app_warehouse_capacity"))
        for m in r.mappings():
            if m["slug"]:
                out[m["slug"]] = float(m["capacity_m3"] or 0)
    except Exception:
        pass
    return out


async def _load_econ_config(db: AsyncSession) -> dict:
    cfg = {"profit_threshold_pln": 10000.0, "min_history_months": 3,
           "stockout_tolerance_pct": 40.0, "excluded_skus": []}
    try:
        r = await db.execute(text("""
            SELECT profit_threshold_pln, min_history_months,
                   stockout_tolerance_pct, excluded_skus
            FROM app_sku_exclusion_config WHERE id = 1
        """))
        m = r.mappings().first()
        if m:
            cfg["profit_threshold_pln"] = float(m["profit_threshold_pln"] or 0)
            cfg["min_history_months"] = int(m["min_history_months"] or 0)
            cfg["stockout_tolerance_pct"] = float(m["stockout_tolerance_pct"] or 0)
            cfg["excluded_skus"] = [s.strip().upper() for s in (m["excluded_skus"] or []) if s and s.strip()]
    except Exception:
        pass
    return cfg


# ── silnik ───────────────────────────────────────────────────

async def _economics(db: AsyncSession, scope: str, mode: str, year: Optional[int] = None) -> dict:
    scope = (scope or "all").strip().lower()
    mode = mode if mode in ("runrate", "ytd") else "runrate"
    today = date.today()
    yr = year or today.year
    period_start = date(yr, 1, 1)

    # Ułamek roku, który już minął — do annualizacji marży i do trybu YTD.
    # Dla lat zamkniętych pełne 12 miesięcy.
    if yr < today.year:
        months_elapsed = 12.0
        period_end = date(yr, 12, 31)
    else:
        months_elapsed = max(0.5, ((today - period_start).days + 1) / 365.0 * 12.0)
        period_end = today

    costs = await _load_costs(db)
    caps = await _load_caps(db)
    cfg = await _load_econ_config(db)
    excluded = set(cfg["excluded_skus"])

    # ── kubatura + właściciel SKU ────────────────────────────
    cbm_by_sku: Dict[str, float] = {}
    firma_of: Dict[str, str] = {}
    r = await db.execute(text(f"""
        SELECT UPPER(TRIM(a.sku)) AS sku,
               COALESCE(a.cbm_per_unit, 0) AS cbm,
               LOWER(COALESCE(f.slug, 'amh')) AS slug
        FROM {settings.TABLE_PRODUCT_ATTRS} a
        LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = a.firma_id
        WHERE a.sku IS NOT NULL AND TRIM(a.sku) <> ''
    """))
    for m in r.mappings():
        cbm_by_sku[m["sku"]] = float(m["cbm"] or 0)
        firma_of[m["sku"]] = m["slug"] or "amh"

    # ── nazwy i ceny zakupu — wspólne źródła dla całego systemu ──
    names: Dict[str, str] = {}
    try:
        r = await db.execute(text(PRODUCT_NAMES_QUERY))
        for m in r.mappings():
            if m["sku"] and m["n"]:
                names[m["sku"]] = m["n"]
    except Exception:
        pass

    prices: Dict[str, float] = {}
    try:
        r = await db.execute(text(PRODUCT_PRICES_QUERY))
        for m in r.mappings():
            if m["sku"]:
                prices[m["sku"]] = float(m["cena"] or 0)
    except Exception:
        pass

    # ── sprzedaż: przychód netto w PLN + historia ────────────
    # MIN/MAX po całej historii (do oceny „czy SKU jest nowe"), sumy tylko za okres.
    sales: Dict[str, dict] = {}
    r = await db.execute(text(f"""
        SELECT LOWER(TRIM(i.{settings.COL_ITEM_SKU})) AS sku_canon,
               MIN(o.{settings.COL_ORDER_DATE})::date AS first_sale,
               MAX(o.{settings.COL_ORDER_DATE})::date AS last_sale,
               COALESCE(SUM(i.{settings.COL_ITEM_QTY})
                        FILTER (WHERE o.{settings.COL_ORDER_DATE} >= :a
                                  AND o.{settings.COL_ORDER_DATE} < :b), 0) AS qty,
               COALESCE(SUM(i.{settings.COL_ITEM_QTY}
                            * COALESCE(i.{settings.COL_ITEM_PRICE_NETTO}, 0) * fx.mult)
                        FILTER (WHERE o.{settings.COL_ORDER_DATE} >= :a
                                  AND o.{settings.COL_ORDER_DATE} < :b), 0) AS net_pln
        FROM {settings.TABLE_ORDER_ITEMS} i
        JOIN {settings.TABLE_ORDERS} o
          ON o.{settings.COL_ORDER_ID} = i.{settings.COL_ITEM_ORDER_ID} AND o.shop = i.shop
        LEFT JOIN LATERAL (
            SELECT CASE
                WHEN UPPER(TRIM(COALESCE(i.{settings.COL_ITEM_CURRENCY}, '{settings.FX_BASE_CURRENCY}')))
                     IN ('{settings.FX_BASE_CURRENCY}', '') THEN 1.0
                ELSE (
                    SELECT r2.mid FROM {settings.TABLE_FX_RATES} r2
                    WHERE r2.currency = UPPER(TRIM(i.{settings.COL_ITEM_CURRENCY}))
                      AND r2.rate_date < o.{settings.COL_ORDER_DATE}::date
                    ORDER BY r2.rate_date DESC LIMIT 1
                )
            END AS mult
        ) fx ON TRUE
        WHERE i.{settings.COL_ITEM_SKU} IS NOT NULL AND TRIM(i.{settings.COL_ITEM_SKU}) <> ''
          {INCLUDED_STATUS_FILTER}
        GROUP BY 1
    """), {"a": period_start, "b": period_end + timedelta(days=1)})
    for m in r.mappings():
        sales[(m["sku_canon"] or "").upper()] = {
            "qty": int(m["qty"] or 0),
            "net_pln": float(m["net_pln"] or 0),
            "first_sale": m["first_sale"],
            "last_sale": m["last_sale"],
        }

    # ── stockout: udział dni z zerowym stanem ────────────────
    stockout: Dict[tuple, dict] = {}
    try:
        r = await db.execute(text("""
            WITH per_day AS (
                SELECT UPPER(TRIM(sku)) AS sku, firma_slug, snap_date,
                       MAX(stan_glowny) AS st
                FROM app_stock_snapshots
                GROUP BY 1, 2, 3
            )
            SELECT sku, firma_slug,
                   COUNT(*) AS dni,
                   COUNT(*) FILTER (WHERE COALESCE(st, 0) <= 0) AS dni_zero
            FROM per_day GROUP BY 1, 2
        """))
        for m in r.mappings():
            stockout[(m["sku"], m["firma_slug"] or "amh")] = {
                "dni": int(m["dni"] or 0), "dni_zero": int(m["dni_zero"] or 0)}
    except Exception:
        pass

    # ── stan fizyczny (magazyn główny, na żywo) ──────────────
    acc: Dict[tuple, dict] = {}
    for e in await build_stock_rows(db):
        key = (e.get("sku") or "").strip().upper()
        if not key or key in excluded:
            continue
        firma = (e.get("firma_slug") or "amh").strip().lower()
        cell = acc.setdefault((key, firma), {
            "sku": (e.get("sku") or "").strip(), "nazwa": e.get("nazwa") or "",
            "firma_slug": firma, "stock_qty": 0,
        })
        cell["stock_qty"] += int(e.get("stan_glowny") or 0)
        if not cell["nazwa"]:
            cell["nazwa"] = e.get("nazwa") or ""

    # SKU sprzedawane, ale bez stanu — muszą być w raporcie rentowności
    # (zarobiły coś i nie zajmują miejsca), inaczej znikłyby z zestawienia.
    for key, s in sales.items():
        if key in excluded or s["qty"] <= 0:
            continue
        firma = firma_of.get(key, "amh")
        acc.setdefault((key, firma), {
            "sku": key, "nazwa": "", "firma_slug": firma, "stock_qty": 0,
        })

    # ── stawka za m³ per firma ───────────────────────────────
    occupied: Dict[str, float] = {}
    for (key, firma), c in acc.items():
        cbm = cbm_by_sku.get(key, 0.0)
        if cbm > 0 and c["stock_qty"] > 0:
            occupied[firma] = occupied.get(firma, 0.0) + cbm * c["stock_qty"]

    rate: Dict[str, float] = {}
    for firma, occ in occupied.items():
        monthly = costs.get(firma, {}).get("monthly_cost_pln", 0.0)
        rate[firma] = (monthly / occ) if occ > 0 else 0.0

    # ── wiersze ──────────────────────────────────────────────
    rows: List[dict] = []
    for (key, firma), c in acc.items():
        if scope != "all" and firma != scope:
            continue

        s = sales.get(key, {"qty": 0, "net_pln": 0.0, "first_sale": None, "last_sale": None})
        qty_sold = s["qty"]
        revenue = round(s["net_pln"], 2)
        unit_cost = prices.get(key, 0.0)
        cogs = round(qty_sold * unit_cost, 2)
        gross = round(revenue - cogs, 2)

        cbm = cbm_by_sku.get(key, 0.0)
        no_cbm = cbm <= 0
        stock_m3 = round(cbm * c["stock_qty"], 3) if not no_cbm else None

        # Koszt miejsca. Bez kubatury → None (nie zero — zero kłamie na korzyść SKU).
        monthly_cost = None if no_cbm else round(cbm * c["stock_qty"] * rate.get(firma, 0.0), 2)
        if mode == "runrate":
            warehouse_cost = None if monthly_cost is None else round(monthly_cost * 12, 2)
            # Marża zannualizowana, żeby porównywać jabłka z jabłkami:
            # koszt miejsca jest roczny, więc zysk też musi być roczny.
            profit_base = round(gross / months_elapsed * 12, 2)
        else:
            warehouse_cost = None if monthly_cost is None else round(monthly_cost * months_elapsed, 2)
            profit_base = gross

        result = None if warehouse_cost is None else round(profit_base - warehouse_cost, 2)

        # historia sprzedaży w miesiącach
        first = s["first_sale"]
        history_months = None
        if first:
            history_months = round(((period_end - first).days + 1) / 365.0 * 12.0, 1)

        so = stockout.get((key, firma), {"dni": 0, "dni_zero": 0})
        stockout_pct = round(100.0 * so["dni_zero"] / so["dni"], 1) if so["dni"] else None

        # ── werdykt ──
        # Kolejność ma znaczenie: powody „nie oceniam" biją werdykt liczbowy.
        if no_cbm:
            verdict, reason = "unknown", "Brak kubatury — koszt miejsca nieznany"
        elif history_months is not None and history_months < cfg["min_history_months"]:
            verdict, reason = "new", f"Za krótka historia ({history_months} mies.)"
        elif qty_sold == 0 and c["stock_qty"] > 0 and not first:
            verdict, reason = "new", "Brak sprzedaży w historii"
        elif stockout_pct is not None and stockout_pct > cfg["stockout_tolerance_pct"]:
            verdict, reason = "stockout", f"Brak towaru przez {stockout_pct}% dni"
        elif result is None:
            verdict, reason = "unknown", "Niepełne dane"
        elif result < cfg["profit_threshold_pln"]:
            verdict, reason = "exclude", "Poniżej progu rentowności"
        elif result < cfg["profit_threshold_pln"] * WATCH_MULTIPLIER:
            verdict, reason = "watch", "Blisko progu"
        else:
            verdict, reason = "keep", "Zarabia"

        rows.append({
            "sku": c["sku"], "nazwa": names.get(key) or c["nazwa"] or "",
            "firma_slug": firma, "no_cbm": no_cbm,
            "stock_qty": c["stock_qty"],
            "cbm_per_unit": round(cbm, 4) if not no_cbm else None,
            "stock_m3": stock_m3,
            "share_pct": (round(100.0 * stock_m3 / occupied[firma], 2)
                          if stock_m3 and occupied.get(firma) else None),
            "qty_sold": qty_sold,
            "revenue_pln": revenue,
            "unit_cost_pln": round(unit_cost, 2),
            "cogs_pln": cogs,
            "gross_margin_pln": gross,
            "gross_margin_pct": round(100.0 * gross / revenue, 1) if revenue > 0 else None,
            "profit_base_pln": profit_base,
            "warehouse_cost_monthly_pln": monthly_cost,
            "warehouse_cost_pln": warehouse_cost,
            "warehouse_cost_share_pct": (round(100.0 * warehouse_cost / profit_base, 1)
                                         if warehouse_cost and profit_base > 0 else None),
            "result_pln": result,
            "stock_value_pln": round(c["stock_qty"] * unit_cost, 2),
            "months_of_stock": (round(c["stock_qty"] / (qty_sold / months_elapsed), 1)
                                if qty_sold > 0 else None),
            "first_sale": first.isoformat() if first else None,
            "last_sale": s["last_sale"].isoformat() if s["last_sale"] else None,
            "history_months": history_months,
            "stockout_pct": stockout_pct,
            "verdict": verdict,
            "reason": reason,
        })

    # ── podsumowanie per firma ───────────────────────────────
    summary: List[dict] = []
    for firma in sorted(set(list(occupied.keys()) + list(costs.keys()))):
        if scope != "all" and firma != scope:
            continue
        occ = occupied.get(firma, 0.0)
        cap = caps.get(firma, 0.0)
        monthly = costs.get(firma, {}).get("monthly_cost_pln", 0.0)
        # Koszt pustej przestrzeni liczony inną stawką (czynsz/pojemność) — pokazuje,
        # ile płacisz za powietrze. Nie miesza się z alokacją na produkty.
        empty_m3 = max(0.0, cap - occ)
        empty_cost = round(empty_m3 * (monthly / cap), 2) if cap > 0 else None
        summary.append({
            "firma_slug": firma, "label": FIRMA_LABELS.get(firma, firma.upper()),
            "monthly_cost_pln": round(monthly, 2),
            "capacity_m3": round(cap, 2),
            "occupied_m3": round(occ, 2),
            "empty_m3": round(empty_m3, 2),
            "empty_cost_pln": empty_cost,
            "rate_pln_per_m3": round(rate.get(firma, 0.0), 2),
            "cost_configured": monthly > 0,
        })

    no_cbm_rows = [r for r in rows if r["no_cbm"]]
    return {
        "mode": mode,
        "period": {"year": yr, "from": period_start.isoformat(), "to": period_end.isoformat(),
                   "months_elapsed": round(months_elapsed, 2)},
        "estimated": mode == "ytd",
        "config": cfg,
        "summary": summary,
        "rows": rows,
        "meta": {
            "no_cbm_count": len(no_cbm_rows),
            "no_cbm_units": sum(r["stock_qty"] for r in no_cbm_rows),
            "excluded_skus": sorted(excluded),
            "missing_cost_firms": [s["firma_slug"] for s in summary if not s["cost_configured"]],
        },
    }


# ── endpointy ────────────────────────────────────────────────

@router.get("/reports/warehouse-cost")
async def warehouse_cost(
    scope: str = Query("all"), mode: str = Query("runrate"), year: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_economics),
):
    """Koszt magazynowania per SKU — czynsz rozłożony po zajętej objętości."""
    data = await _economics(db, resolve_scope(scope, user), mode, year)
    data["rows"].sort(key=lambda r: (r["warehouse_cost_pln"] is None, -(r["warehouse_cost_pln"] or 0)))
    return data


@router.get("/reports/sku-exclusion")
async def sku_exclusion(
    scope: str = Query("all"), mode: str = Query("runrate"), year: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_economics),
):
    """SKU do wykluczenia — wynik po koszcie zakupu i koszcie miejsca."""
    data = await _economics(db, resolve_scope(scope, user), mode, year)
    # Najgorsze na górze; pozycje bez werdyktu na koniec, żeby nie zaśmiecały czoła listy.
    order = {"exclude": 0, "watch": 1, "stockout": 2, "new": 3, "keep": 4, "unknown": 5}
    data["rows"].sort(key=lambda r: (order.get(r["verdict"], 9), r["result_pln"] if r["result_pln"] is not None else 0))
    return data


@router.get("/reports/economics/config")
async def economics_config(
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_economics),
):
    costs = await _load_costs(db)
    caps = await _load_caps(db)
    slugs = sorted(set(list(costs.keys()) + list(caps.keys()) + list(FIRMA_LABELS.keys())))
    return {
        "costs": [{"firma_slug": s, "label": FIRMA_LABELS.get(s, s.upper()),
                   "monthly_cost_pln": costs.get(s, {}).get("monthly_cost_pln", 0.0),
                   "note": costs.get(s, {}).get("note")} for s in slugs],
        **await _load_econ_config(db),
    }


@router.put("/reports/economics/config")
async def economics_config_save(
    payload: EconConfigIn, db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(_require_economics),
):
    """Zapis czynszów i progów. Pola pominięte w payloadzie zostają bez zmian."""
    for c in (payload.costs or []):
        slug = (c.firma_slug or "").strip().lower()
        if not slug:
            continue
        if c.monthly_cost_pln is None or c.monthly_cost_pln < 0:
            raise HTTPException(400, f"Koszt magazynu dla {slug} nie może być ujemny")
        await db.execute(text("""
            INSERT INTO app_warehouse_cost (firma_slug, monthly_cost_pln, note, updated_at)
            VALUES (:slug, :cost, :note, CURRENT_TIMESTAMP)
            ON CONFLICT (firma_slug) DO UPDATE
            SET monthly_cost_pln = EXCLUDED.monthly_cost_pln,
                note = EXCLUDED.note,
                updated_at = CURRENT_TIMESTAMP
        """), {"slug": slug, "cost": float(c.monthly_cost_pln), "note": (c.note or "").strip() or None})

    sets, params = [], {}
    if payload.profit_threshold_pln is not None:
        if payload.profit_threshold_pln < 0:
            raise HTTPException(400, "Próg rentowności nie może być ujemny")
        sets.append("profit_threshold_pln = :thr")
        params["thr"] = float(payload.profit_threshold_pln)
    if payload.min_history_months is not None:
        sets.append("min_history_months = :mh")
        params["mh"] = max(0, min(int(payload.min_history_months), 60))
    if payload.stockout_tolerance_pct is not None:
        sets.append("stockout_tolerance_pct = :st")
        params["st"] = max(0.0, min(float(payload.stockout_tolerance_pct), 100.0))
    if payload.excluded_skus is not None:
        sets.append("excluded_skus = :ex")
        params["ex"] = sorted({s.strip().upper() for s in payload.excluded_skus if s and s.strip()})

    if sets:
        await db.execute(text(f"""
            UPDATE app_sku_exclusion_config
            SET {', '.join(sets)}, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        """), params)

    await db.commit()
    await log_audit(db, user, "ECONOMICS_CONFIG_SAVED", "reports", "economics",
                    f"costs={[(c.firma_slug, c.monthly_cost_pln) for c in (payload.costs or [])]}")
    return await economics_config(db, user)
