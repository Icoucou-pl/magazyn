"""
Finanse — przychody, marże i kanały sprzedaży.

Jeden zbiorczy endpoint GET /api/finance/overview?period=ytd|365|90|30|prev_year
zwraca komplet pod moduł Finanse: KPI, rozbicie po kanałach, top producenci i trend
miesięczny. Wszystko w PLN — przewalutowanie kursem średnim NBP (app_fx_rates) z
ostatniego dnia roboczego PRZED datą zamówienia (konwencja księgowa, jak w _sales_season).

Sprzedaż „zrealizowana" = whitelist statusów z config (INCLUDED_STATUS_FILTER, zgodnie z Power BI).
Kanał sprzedaży = SALES_CHANNEL_CASE z creator (Allegro/Erli/Studio-Bay/Klaudia/I-CC.PL).
Koszt do marży = ilość × cena_zakupu_netto z Subiekta (bieżący koszt, nie historyczny z dnia sprzedaży).

Guard: oba endpointy wymagają uprawnienia viewFinancials (require_view_financials),
odwzorowanie frontowego can(user, "viewFinancials"). Override per-user wygrywa nad rolą.
"""

from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, INCLUDED_STATUS_FILTER, SALES_CHANNEL_CASE, to_float
from database import get_db
from models import (
    CurrentUser,
    FinanceOverview, FinanceKpi, FinanceChannelRow, FinanceMfrRow, FinanceMonthlyPoint,
    FinanceProduct, FinanceProductInfo, FinanceProductKpi, FinanceProductRotation,
    FinanceProductChannelRow, FinanceProductMonthly,
)
from security import require_view_financials

router = APIRouter(prefix="/api", tags=["finance"])

ALLOWED_PERIODS = {"ytd", "365", "90", "30", "prev_year"}


def _period(period: str):
    """Zwraca (label, sql_clause, date_from, date_to) dla okresu. Nieznany → ytd.
    sql_clause używa aliasu o i NIE ma wiodącego AND (jest pierwszym warunkiem WHERE)."""
    d = settings.COL_ORDER_DATE
    today = date.today()
    if period == "365":
        return ("Ostatnie 365 dni", f"o.{d} >= NOW() - INTERVAL '365 days'", today - timedelta(days=365), today)
    if period == "90":
        return ("Ostatnie 90 dni", f"o.{d} >= NOW() - INTERVAL '90 days'", today - timedelta(days=90), today)
    if period == "30":
        return ("Ostatnie 30 dni", f"o.{d} >= NOW() - INTERVAL '30 days'", today - timedelta(days=30), today)
    if period == "prev_year":
        fr = date(today.year - 1, 1, 1)
        to = date(today.year - 1, 12, 31)
        clause = (f"o.{d} >= date_trunc('year', CURRENT_DATE) - INTERVAL '1 year' "
                  f"AND o.{d} < date_trunc('year', CURRENT_DATE)")
        return ("Zeszły rok", clause, fr, to)
    # ytd (domyślnie)
    return ("Ten rok", f"o.{d} >= date_trunc('year', CURRENT_DATE)", date(today.year, 1, 1), today)


def _base_cte(period_clause: str, extra_where: str = "") -> str:
    """Wspólne CTE `base`: po jednej pozycji zamówienia z kanałem, przewalutowaniem i kosztem.
    Przewalutowanie: PLN/puste → 1.0; waluta obca → kurs NBP < order_date; brak kursu → mult NULL
    (pozycja wypada z przychodu I kosztu — spójnie, żeby nie psuć marży).
    cost liczony tylko gdy mult IS NOT NULL (ten sam zbiór wierszy co przychód).
    cost_missing = brak dopasowania SKU w Subiekcie (koszt nieznany → marża zawyżona).
    extra_where — opcjonalny dodatkowy warunek WHERE (np. filtr po jednym symbolu),
    musi zaczynać się od 'AND '."""
    return f"""
WITH base AS (
    SELECT
        o.{settings.COL_ORDER_ID}                                                          AS order_id,
        {SALES_CHANNEL_CASE}                                                               AS channel,
        EXTRACT(YEAR  FROM o.{settings.COL_ORDER_DATE})::int                                AS yr,
        EXTRACT(MONTH FROM o.{settings.COL_ORDER_DATE})::int                                AS mo,
        pa.manufacturer_id                                                                 AS manufacturer_id,
        m.name                                                                             AS mfr_name,
        m.color                                                                            AS mfr_color,
        i.{settings.COL_ITEM_QTY}                                                          AS qty,
        (i.{settings.COL_ITEM_QTY} * COALESCE(i.{settings.COL_ITEM_PRICE_NETTO}, 0) * fx.mult) AS net,
        (i.{settings.COL_ITEM_QTY} * COALESCE(i.{settings.COL_ITEM_PRICE},       0) * fx.mult) AS gross,
        (CASE WHEN fx.mult IS NOT NULL
              THEN i.{settings.COL_ITEM_QTY} * COALESCE(pr.{settings.COL_PRODUCT_PRICE}, 0)
              ELSE 0 END)                                                                  AS cost,
        (pr.{settings.COL_PRODUCT_SKU} IS NULL)                                            AS cost_missing
    FROM {settings.TABLE_ORDER_ITEMS} i
    JOIN {settings.TABLE_ORDERS} o
        ON o.{settings.COL_ORDER_ID} = i.{settings.COL_ITEM_ORDER_ID}
    LEFT JOIN LATERAL (
        SELECT CASE
            WHEN UPPER(TRIM(COALESCE(i.{settings.COL_ITEM_CURRENCY}, '{settings.FX_BASE_CURRENCY}'))) IN ('{settings.FX_BASE_CURRENCY}', '')
                THEN 1.0
            ELSE (
                SELECT r.mid
                FROM {settings.TABLE_FX_RATES} r
                WHERE r.currency = UPPER(TRIM(i.{settings.COL_ITEM_CURRENCY}))
                  AND r.rate_date < o.{settings.COL_ORDER_DATE}::date
                ORDER BY r.rate_date DESC
                LIMIT 1
            )
        END AS mult
    ) fx ON TRUE
    LEFT JOIN {settings.TABLE_PRODUCTS} pr
        ON LOWER(TRIM(pr.{settings.COL_PRODUCT_SKU})) = LOWER(TRIM(i.{settings.COL_ITEM_SKU}))
    LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa
        ON LOWER(TRIM(pa.sku)) = LOWER(TRIM(i.{settings.COL_ITEM_SKU}))
    LEFT JOIN {settings.TABLE_MANUFACTURERS} m
        ON m.id = pa.manufacturer_id
    WHERE {period_clause}
        {INCLUDED_STATUS_FILTER}
        {extra_where}
)
"""


def _margin(net: float, cost: float) -> tuple:
    margin = net - cost
    pct = (margin / net * 100.0) if net > 0 else 0.0
    return margin, pct


_MONTHS_PL = ["", "styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec",
              "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"]


def _month_clause(rok: int, miesiac: int):
    """(period_clause, date_from, date_to, label) dla jednego miesiąca kalendarzowego.
    Filtr po zakresie dat [1. dnia miesiąca; 1. dnia kolejnego) — indeksowalny.
    rok/miesiac są już zwalidowane do int, więc interpolacja literałów DATE jest bezpieczna."""
    d = settings.COL_ORDER_DATE
    date_from = date(rok, miesiac, 1)
    date_to = date(rok + 1, 1, 1) if miesiac == 12 else date(rok, miesiac + 1, 1)
    clause = f"o.{d} >= DATE '{date_from.isoformat()}' AND o.{d} < DATE '{date_to.isoformat()}'"
    return clause, date_from, date_to, f"{_MONTHS_PL[miesiac]} {rok}"


async def month_finance(db: AsyncSession, rok: int, miesiac: int, symbol: Optional[str] = None,
                        producent: Optional[str] = None) -> dict:
    """Finanse jednego miesiąca kalendarzowego — ten sam silnik co /finance/overview
    (przewalutowanie NBP, whitelist statusów INCLUDED_STATUS_FILTER, koszt z Subiekta).
    symbol → tylko jeden SKU. producent → tylko dany producent (dopasowanie ILIKE po nazwie).
    Zwraca czysty dict (nie Pydantic) — pod asystenta.
    UWAGA: koszt/marża dla Acti/Veluxa nadal z cen Subiektu (znany TODO) — dlatego zwracamy
    pozycje_bez_kosztu, żeby marżę można było zastrzec. Przychód i sztuki są dokładne."""
    try:
        rok = int(rok)
        miesiac = int(miesiac)
    except (TypeError, ValueError):
        return {"blad": "rok/miesiąc muszą być liczbami", "rok": rok, "miesiac": miesiac}
    if not (2000 <= rok <= 2100) or not (1 <= miesiac <= 12):
        return {"blad": "zły rok (2000-2100) lub miesiąc (1-12)", "rok": rok, "miesiac": miesiac}

    clause, date_from, date_to, label = _month_clause(rok, miesiac)
    params: dict = {}
    parts: list = []
    sym = (symbol or "").strip()
    if sym:
        parts.append(f"LOWER(TRIM(i.{settings.COL_ITEM_SKU})) = LOWER(TRIM(:sym))")
        params["sym"] = sym
    prod = (producent or "").strip()
    if prod:
        parts.append("m.name ILIKE :prod")
        params["prod"] = f"%{prod}%"
    extra = ("AND " + " AND ".join(parts)) if parts else ""

    base = _base_cte(clause, extra)
    rows = (await db.execute(text(base + """
        SELECT channel,
            COALESCE(SUM(net),   0)::float                                    AS net,
            COALESCE(SUM(gross), 0)::float                                    AS gross,
            COALESCE(SUM(cost),  0)::float                                    AS cost,
            COALESCE(SUM(qty),   0)::int                                      AS units,
            COUNT(DISTINCT order_id)::int                                     AS orders,
            COALESCE(SUM(CASE WHEN cost_missing THEN qty ELSE 0 END), 0)::int AS units_no_cost
        FROM base
        GROUP BY channel
        ORDER BY net DESC
    """), params)).mappings().all()

    total_net = sum(to_float(r["net"]) for r in rows)
    total_gross = sum(to_float(r["gross"]) for r in rows)
    total_cost = sum(to_float(r["cost"]) for r in rows)
    total_units = sum(int(r["units"]) for r in rows)
    total_orders = sum(int(r["orders"]) for r in rows)
    items_no_cost = sum(int(r["units_no_cost"]) for r in rows)
    margin, mpct = _margin(total_net, total_cost)
    aov = (total_net / total_orders) if total_orders else 0.0

    channels = [{
        "channel": r["channel"],
        "revenue_net": round(to_float(r["net"]), 2),
        "units": int(r["units"]),
        "share_pct": round(to_float(r["net"]) / total_net * 100.0, 1) if total_net > 0 else 0.0,
    } for r in rows]

    out = {
        "rok": rok, "miesiac": miesiac, "etykieta": label, "waluta": "PLN",
        "od": date_from.isoformat(), "do_wyl": date_to.isoformat(),
        "przychod_netto": round(total_net, 2), "przychod_brutto": round(total_gross, 2),
        "koszt": round(total_cost, 2), "marza": round(margin, 2), "marza_proc": round(mpct, 1),
        "zamowienia": total_orders, "sztuki": total_units,
        "srednia_wartosc_zamowienia": round(aov, 2),
        "pozycje_bez_kosztu": items_no_cost,
        "kanaly": channels,
    }
    if sym:
        out["sku"] = sym.upper()
    if prod:
        out["producent"] = prod
    return out


@router.get("/finance/overview", response_model=FinanceOverview)
async def finance_overview(
    period: str = Query("ytd"),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_view_financials),
):
    if period not in ALLOWED_PERIODS:
        period = "ytd"
    label, period_clause, date_from, date_to = _period(period)
    base = _base_cte(period_clause)

    # --- Kanały (z tego wyliczamy też KPI: order=jeden kanał, więc sumy się sumują) ---
    ch_rows = (await db.execute(text(base + """
        SELECT channel,
            COALESCE(SUM(net),   0)::float                         AS net,
            COALESCE(SUM(gross), 0)::float                         AS gross,
            COALESCE(SUM(cost),  0)::float                         AS cost,
            COALESCE(SUM(qty),   0)::int                           AS units,
            COUNT(DISTINCT order_id)::int                          AS orders,
            COALESCE(SUM(CASE WHEN cost_missing THEN qty ELSE 0 END), 0)::int AS units_no_cost
        FROM base
        GROUP BY channel
        ORDER BY net DESC
    """))).mappings().all()

    total_net = sum(to_float(r["net"]) for r in ch_rows)
    total_gross = sum(to_float(r["gross"]) for r in ch_rows)
    total_cost = sum(to_float(r["cost"]) for r in ch_rows)
    total_units = sum(int(r["units"]) for r in ch_rows)
    total_orders = sum(int(r["orders"]) for r in ch_rows)
    items_without_cost = sum(int(r["units_no_cost"]) for r in ch_rows)

    channels: List[FinanceChannelRow] = []
    for r in ch_rows:
        net = to_float(r["net"])
        cost = to_float(r["cost"])
        margin, mpct = _margin(net, cost)
        channels.append(FinanceChannelRow(
            channel=r["channel"],
            revenue_net=net,
            revenue_gross=to_float(r["gross"]),
            cost=cost,
            margin=margin,
            margin_pct=mpct,
            orders=int(r["orders"]),
            units=int(r["units"]),
            share_pct=(net / total_net * 100.0) if total_net > 0 else 0.0,
        ))

    kpi_margin, kpi_mpct = _margin(total_net, total_cost)
    kpi = FinanceKpi(
        revenue_net=total_net,
        revenue_gross=total_gross,
        cost=total_cost,
        margin=kpi_margin,
        margin_pct=kpi_mpct,
        orders=total_orders,
        units=total_units,
        aov_net=(total_net / total_orders) if total_orders > 0 else 0.0,
    )

    # --- Producenci (top wg przychodu netto) ---
    mfr_rows = (await db.execute(text(base + """
        SELECT manufacturer_id, mfr_name, mfr_color,
            COALESCE(SUM(net),  0)::float AS net,
            COALESCE(SUM(cost), 0)::float AS cost,
            COALESCE(SUM(qty),  0)::int   AS units
        FROM base
        GROUP BY manufacturer_id, mfr_name, mfr_color
        ORDER BY net DESC
    """))).mappings().all()

    manufacturers: List[FinanceMfrRow] = []
    for r in mfr_rows:
        net = to_float(r["net"])
        cost = to_float(r["cost"])
        margin, mpct = _margin(net, cost)
        manufacturers.append(FinanceMfrRow(
            manufacturer_id=r["manufacturer_id"],
            name=r["mfr_name"] or "Bez producenta",
            color=r["mfr_color"],
            revenue_net=net,
            cost=cost,
            margin=margin,
            margin_pct=mpct,
            units=int(r["units"]),
        ))

    # --- Trend miesięczny (przychód netto per miesiąc × kanał) ---
    mo_rows = (await db.execute(text(base + """
        SELECT yr, mo, channel, COALESCE(SUM(net), 0)::float AS net
        FROM base
        GROUP BY yr, mo, channel
        ORDER BY yr, mo
    """))).mappings().all()

    monthly = [
        FinanceMonthlyPoint(
            year=int(r["yr"]),
            month=int(r["mo"]) - 1,  # 0-based dla frontu
            channel=r["channel"],
            revenue_net=to_float(r["net"]),
        )
        for r in mo_rows
    ]

    return FinanceOverview(
        period=period,
        period_label=label,
        date_from=date_from,
        date_to=date_to,
        currency=settings.FX_BASE_CURRENCY,
        kpi=kpi,
        channels=channels,
        manufacturers=manufacturers,
        monthly=monthly,
        items_without_cost=items_without_cost,
    )


@router.get("/finance/product", response_model=FinanceProduct)
async def finance_product(
    symbol: str = Query(..., min_length=1),
    period: str = Query("ytd"),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_view_financials),
):
    """Karta produktu: info + KPI finansowe + rotacja/pokrycie stanu + kanały + trend miesięczny.
    Koszt = cena_zakupu_netto z Subiekta (bieżący, jednolity per szt.) → koszt całkowity = sztuki × koszt jedn."""
    if period not in ALLOWED_PERIODS:
        period = "ytd"
    label, period_clause, date_from, date_to = _period(period)

    # --- Info o produkcie (Subiekt + atrybuty + lead-time) ---
    info_row = (await db.execute(text(f"""
        SELECT
            p.{settings.COL_PRODUCT_NAME}                          AS name,
            COALESCE(p.{settings.COL_PRODUCT_STOCK}, 0)            AS stock,
            COALESCE(p.{settings.COL_PRODUCT_PRICE}, 0)::float     AS unit_cost,
            pa.cbm_per_unit                                        AS cbm_per_unit,
            pa.ean                                                 AS ean,
            pa.manufacturer_id                                     AS manufacturer_id,
            m.name                                                 AS mfr_name,
            m.color                                                AS mfr_color,
            lt.lead_time_days                                      AS lead_time_days
        FROM {settings.TABLE_PRODUCTS} p
        LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa
            ON LOWER(TRIM(pa.sku)) = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
        LEFT JOIN {settings.TABLE_MANUFACTURERS} m
            ON m.id = pa.manufacturer_id
        LEFT JOIN {settings.TABLE_LEAD_TIMES} lt
            ON LOWER(TRIM(lt.sku)) = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
        WHERE LOWER(TRIM(p.{settings.COL_PRODUCT_SKU})) = LOWER(TRIM(:symbol))
        LIMIT 1
    """), {"symbol": symbol})).mappings().first()

    if info_row is None:
        raise HTTPException(status_code=404, detail=f"Nie znaleziono produktu o symbolu '{symbol}'")

    unit_cost = to_float(info_row["unit_cost"])
    stock = int(info_row["stock"] or 0)

    info = FinanceProductInfo(
        symbol=symbol,
        name=info_row["name"],
        manufacturer_id=info_row["manufacturer_id"],
        manufacturer_name=info_row["mfr_name"],
        manufacturer_color=info_row["mfr_color"],
        ean=info_row["ean"],
        stock=stock,
        unit_cost=unit_cost,
        cbm_per_unit=to_float(info_row["cbm_per_unit"]) if info_row["cbm_per_unit"] is not None else None,
        lead_time_days=info_row["lead_time_days"],
    )

    sym_where = f"AND LOWER(TRIM(i.{settings.COL_ITEM_SKU})) = LOWER(TRIM(:symbol))"
    base = _base_cte(period_clause, sym_where)

    # --- Sumy sprzedaży (KPI) ---
    tot = (await db.execute(text(base + """
        SELECT
            COALESCE(SUM(net),   0)::float AS net,
            COALESCE(SUM(gross), 0)::float AS gross,
            COALESCE(SUM(qty),   0)::int   AS units,
            COUNT(DISTINCT order_id)::int  AS orders
        FROM base
    """), {"symbol": symbol})).mappings().first()

    units = int(tot["units"] or 0)
    orders = int(tot["orders"] or 0)
    revenue_net = to_float(tot["net"])
    revenue_gross = to_float(tot["gross"])
    cost = units * unit_cost
    margin = revenue_net - cost
    margin_pct = (margin / revenue_net * 100.0) if revenue_net > 0 else 0.0
    avg_price_net = (revenue_net / units) if units > 0 else 0.0
    unit_margin = avg_price_net - unit_cost

    kpi = FinanceProductKpi(
        revenue_net=revenue_net,
        revenue_gross=revenue_gross,
        cost=cost,
        margin=margin,
        margin_pct=margin_pct,
        units=units,
        orders=orders,
        avg_price_net=avg_price_net,
        unit_cost=unit_cost,
        unit_margin=unit_margin,
    )

    # --- Rotacja / pokrycie stanu ---
    days_in_period = max(1, (date_to - date_from).days + 1)
    avg_daily = units / days_in_period
    rotation = FinanceProductRotation(
        days_in_period=days_in_period,
        avg_daily_units=avg_daily,
        avg_monthly_units=avg_daily * 30.0,
        days_of_cover=(stock / avg_daily) if avg_daily > 0 else None,
        stock=stock,
    )

    # --- Kanały (dla tego produktu) ---
    ch_rows = (await db.execute(text(base + """
        SELECT channel,
            COALESCE(SUM(qty), 0)::int   AS units,
            COALESCE(SUM(net), 0)::float AS net
        FROM base
        GROUP BY channel
        ORDER BY net DESC
    """), {"symbol": symbol})).mappings().all()

    channels = [
        FinanceProductChannelRow(
            channel=r["channel"],
            units=int(r["units"]),
            revenue_net=to_float(r["net"]),
            share_pct=(to_float(r["net"]) / revenue_net * 100.0) if revenue_net > 0 else 0.0,
        )
        for r in ch_rows
    ]

    # --- Trend miesięczny (sztuki + przychód netto) ---
    mo_rows = (await db.execute(text(base + """
        SELECT yr, mo,
            COALESCE(SUM(qty), 0)::int   AS units,
            COALESCE(SUM(net), 0)::float AS net
        FROM base
        GROUP BY yr, mo
        ORDER BY yr, mo
    """), {"symbol": symbol})).mappings().all()

    monthly = [
        FinanceProductMonthly(
            year=int(r["yr"]),
            month=int(r["mo"]) - 1,
            units=int(r["units"]),
            revenue_net=to_float(r["net"]),
        )
        for r in mo_rows
    ]

    return FinanceProduct(
        period=period,
        period_label=label,
        date_from=date_from,
        date_to=date_to,
        currency=settings.FX_BASE_CURRENCY,
        info=info,
        kpi=kpi,
        rotation=rotation,
        channels=channels,
        monthly=monthly,
    )
