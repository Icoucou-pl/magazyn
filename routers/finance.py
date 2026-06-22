"""
Finanse — przychody, marże i kanały sprzedaży.

Jeden zbiorczy endpoint GET /api/finance/overview?period=ytd|365|90|30|prev_year
zwraca komplet pod moduł Finanse: KPI, rozbicie po kanałach, top producenci i trend
miesięczny. Wszystko w PLN — przewalutowanie kursem średnim NBP (app_fx_rates) z
ostatniego dnia roboczego PRZED datą zamówienia (konwencja księgowa, jak w _sales_season).

Sprzedaż „zrealizowana" = whitelist statusów z config (INCLUDED_STATUS_FILTER, zgodnie z Power BI).
Kanał sprzedaży = SALES_CHANNEL_CASE z creator (Allegro/Erli/Studio-Bay/Klaudia/I-CC.PL).
Koszt do marży = ilość × cena_zakupu_netto z Subiekta (bieżący koszt, nie historyczny z dnia sprzedaży).

Uwaga (auth): endpoint bez twardego guardu — spójnie z resztą routerów; pełne zabezpieczenie
backendu to osobny temat. Na froncie zakładka jest pod uprawnieniem viewFinancials.
"""

from datetime import date, timedelta
from typing import List

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, INCLUDED_STATUS_FILTER, SALES_CHANNEL_CASE, to_float
from database import get_db
from models import (
    FinanceOverview, FinanceKpi, FinanceChannelRow, FinanceMfrRow, FinanceMonthlyPoint,
)

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


def _base_cte(period_clause: str) -> str:
    """Wspólne CTE `base`: po jednej pozycji zamówienia z kanałem, przewalutowaniem i kosztem.
    Przewalutowanie: PLN/puste → 1.0; waluta obca → kurs NBP < order_date; brak kursu → mult NULL
    (pozycja wypada z przychodu I kosztu — spójnie, żeby nie psuć marży).
    cost liczony tylko gdy mult IS NOT NULL (ten sam zbiór wierszy co przychód).
    cost_missing = brak dopasowania SKU w Subiekcie (koszt nieznany → marża zawyżona)."""
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
)
"""


def _margin(net: float, cost: float) -> tuple:
    margin = net - cost
    pct = (margin / net * 100.0) if net > 0 else 0.0
    return margin, pct


@router.get("/finance/overview", response_model=FinanceOverview)
async def finance_overview(
    period: str = Query("ytd"),
    db: AsyncSession = Depends(get_db),
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
