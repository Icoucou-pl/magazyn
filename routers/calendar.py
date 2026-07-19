"""Kalendarz zdarzeń (zamówienia/wyczerpania/dostawy), cashflow, historia wartości magazynu."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, INCLUDED_STATUS_FILTER
from database import get_db
from models import CurrentUser
from security import get_current_user, require_view_financials, has_perm
from services.products import fetch_products
from services.containers import fetch_containers

router = APIRouter(prefix="/api", tags=["calendar"])


@router.get("/calendar")
async def calendar_events(
    favorites_only: bool = False,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """Zdarzenia kalendarza: ORDER/EMPTY (z produktów) + DELIVERY (z kontenerów).

    favorites_only=True → zdarzenia ORDER/EMPTY tylko dla obserwowanych SKU (is_favorite);
    dostawy są ZAWSZE widoczne, niezależnie od tego przełącznika.

    Data dostawy = data wejścia do magazynu, czyli ręczne „dostarczono" (delivered_date),
    a gdy go brak — ETA + odprawa celna (CONTAINER_CUSTOMS_DAYS). Kontenery auto-domknięte
    po ETA+N (bez ręcznej daty) już fizycznie weszły do magazynu, więc nie zaśmiecają kalendarza.
    """
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"})
    containers = await fetch_containers(db)

    # Ręczne daty dostawy (ustawiane tylko przy ręcznym DELIVERED; auto-dostawa ma NULL).
    deliv_rows = await db.execute(
        text(f"SELECT id, delivered_date FROM {settings.TABLE_CONTAINERS} WHERE delivered_date IS NOT NULL")
    )
    delivered_map = {r._mapping["id"]: r._mapping["delivered_date"] for r in deliv_rows}
    customs = int(settings.CONTAINER_CUSTOMS_DAYS)

    events = []
    for p in products:
        if favorites_only and not p.is_favorite:
            continue
        if p.status in ("KRYTYCZNY", "ZAMOW_TERAZ", "ZAMOW_WKROTCE") and p.avg_monthly_weighted >= 1:
            # Sugerowana ilość zamówienia — ta sama reguła co /shopping-list
            # (pokrycie na 6 miesięcy minus stan i to, co już w drodze).
            recommended = max(1, int(p.avg_monthly_weighted * 6 - p.stock - p.stock_in_transit))
            events.append({
                "date": p.order_date.isoformat(), "type": "ORDER",
                "sku": p.sku, "name": p.name, "status": p.status,
                "manufacturer_name": p.manufacturer_name,
                "manufacturer_color": p.manufacturer_color,
                "qty": recommended,
            })
            events.append({
                "date": p.empty_date.isoformat(), "type": "EMPTY",
                "sku": p.sku, "name": p.name, "status": p.status,
                "manufacturer_name": p.manufacturer_name,
                "manufacturer_color": p.manufacturer_color,
            })

    for c in containers:
        eff = c.effective_status or c.status
        manual = delivered_map.get(c.id)
        if manual is not None:
            deliv_date = manual                                   # ręczne „dostarczono"
        elif eff != "DELIVERED":
            deliv_date = c.eta_date + timedelta(days=customs)     # ETA + odprawa celna
        else:
            continue                                             # auto-domknięte po ETA+N — już w magazynie
        events.append({
            "date": deliv_date.isoformat(), "type": "DELIVERY",
            "container_id": c.id, "container_number": c.container_number,
            "order_number": c.order_number, "manufacturer_name": c.manufacturer_name,
            "manufacturer_color": c.manufacturer_color, "total_units": c.total_units,
            "container_status": eff,
        })

    return events


@router.get("/cashflow")
async def cashflow(months: int = 6, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_view_financials)):
    containers = await fetch_containers(db)
    today = date.today()

    result = []
    for i in range(months):
        year = today.year + (today.month - 1 + i) // 12
        month = (today.month - 1 + i) % 12 + 1
        result.append({
            "year": year, "month": month,
            "label": date(year, month, 1).strftime("%Y-%m"),
            "containers": [], "total": 0.0,
        })

    for c in containers:
        if (c.effective_status or c.status) == "DELIVERED":
            continue
        eta = c.eta_date
        idx = (eta.year - today.year) * 12 + (eta.month - today.month)
        if 0 <= idx < months:
            result[idx]["containers"].append({
                "id": c.id, "container_number": c.container_number,
                "order_number": c.order_number,
                "manufacturer_name": c.manufacturer_name,
                "manufacturer_color": c.manufacturer_color,
                "eta_date": c.eta_date.isoformat(),
                "total_value": c.total_value,
            })
            result[idx]["total"] += c.total_value

    return {"months": result, "total": round(sum(m["total"] for m in result), 2)}


@router.get("/stock-value-history")
async def stock_value_history(days: int = 90, shop: str = "", favorites_only: bool = False, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """
    Symulacja wartości magazynu w czasie - bazuje na obecnym stanie + sprzedaży.
    To jest aproksymacja, bo Subiekt nie trzyma historii stanu - rekonstruujemy z danych zamówień.
    shop="" = wszystkie sklepy; "amh"/"acti"/"veluxa" = wartość i stan tylko danego magazynu
    (sprzedaż wstecz filtrowana po sklepie; dostawy doliczane tylko dla magazynu, który fizycznie ma dany SKU).

    favorites_only=True → wartość i sztuki liczone TYLKO dla obserwowanych SKU (is_favorite).
    Dashboard woła z True: KPI „Wartość magazynu" i wykres pokazują żywy, sprzedawany asortyment,
    a nie cały magazyn (price_map/stock_map budowane są z przefiltrowanej listy, więc reszta odpada sama).
    """
    # DEAD_STOCK też ma stan (i wartość!), więc wchodzi do wykresu — inaczej świeży import bez sprzedaży
    # (klasyfikowany jako DEAD_STOCK) byłby niewidoczny, a jego dostawa nigdy by się nie doliczyła.
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK"}, shop)
    if favorites_only:
        products = [p for p in products if p.is_favorite]

    today = date.today()

    sales_query = f"""
        SELECT
            LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_norm,
            DATE(o.{settings.COL_ORDER_DATE}) AS sale_date,
            SUM(oi.{settings.COL_ITEM_QTY}) AS qty
        FROM {settings.TABLE_ORDER_ITEMS} oi
        JOIN {settings.TABLE_ORDERS} o ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID}
        WHERE o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '{days} days'
            AND (:shop = '' OR o.shop = :shop)
            {INCLUDED_STATUS_FILTER}
        GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU})), DATE(o.{settings.COL_ORDER_DATE})
    """
    sales_result = await db.execute(text(sales_query), {"shop": shop})

    sales_by_sku = {}
    for r in sales_result:
        sku_norm = r._mapping["sku_norm"]
        sale_date = r._mapping["sale_date"]
        qty = float(r._mapping["qty"] or 0)
        if sku_norm not in sales_by_sku:
            sales_by_sku[sku_norm] = {}
        sales_by_sku[sku_norm][sale_date] = qty

    price_map = {p.sku.strip().lower(): float(p.purchase_price or 0) for p in products}
    stock_map = {p.sku.strip().lower(): float(p.stock or 0) for p in products}

    # Dostawy: towar wchodzi do magazynu PO odprawie celnej = ETA + CONTAINER_CUSTOMS_DAYS,
    # albo w ręcznej dacie dostawy (c.delivered_date), jeśli ktoś oznaczył DELIVERED wcześniej.
    # Przypisanie do sklepu po WŁAŚCICIELSTWIE produktu (firma_id; brak = AMH) — import z Chin
    # zaopatruje magazyn firmy-właściciela (AMH ma większość importów, Acti/Veluxa tylko część).
    # Cofając się w czasie odejmujemy dostawy — przed wejściem do magazynu stan był niższy.
    customs = int(settings.CONTAINER_CUSTOMS_DAYS)
    deliveries_query = f"""
        SELECT
            LOWER(TRIM(ci.sku)) AS sku_norm,
            DATE(COALESCE(c.delivered_date, c.eta_date + {customs})) AS deliv_date,
            SUM(ci.quantity) AS qty
        FROM {settings.TABLE_CONTAINER_ITEMS} ci
        JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
        LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa ON LOWER(TRIM(pa.sku)) = LOWER(TRIM(ci.sku))
        WHERE c.eta_date IS NOT NULL
            AND COALESCE(c.delivered_date, c.eta_date + {customs}) >= (NOW() - INTERVAL '{days} days')::date
            AND COALESCE(c.delivered_date, c.eta_date + {customs}) <= NOW()::date
            AND (:shop = '' OR COALESCE((SELECT LOWER(af.slug) FROM {settings.TABLE_FIRMY} af WHERE af.id = pa.firma_id), 'amh') = :shop)
        GROUP BY LOWER(TRIM(ci.sku)), DATE(COALESCE(c.delivered_date, c.eta_date + {customs}))
    """
    deliveries_result = await db.execute(text(deliveries_query), {"shop": shop})

    deliveries_by_sku = {}
    for r in deliveries_result:
        sku_norm = r._mapping["sku_norm"]
        deliv_date = r._mapping["deliv_date"]
        qty = float(r._mapping["qty"] or 0)
        deliveries_by_sku.setdefault(sku_norm, {})[deliv_date] = qty

    points = []
    for offset in range(days, -1, -1):
        d = today - timedelta(days=offset)
        total_value = 0
        total_units = 0
        for sku_norm in stock_map:
            stock_today = stock_map[sku_norm]
            price = price_map.get(sku_norm, 0)
            sold_between = 0
            if sku_norm in sales_by_sku:
                for sale_d, qty in sales_by_sku[sku_norm].items():
                    if sale_d > d:
                        sold_between += qty
            delivered_between = 0
            if sku_norm in deliveries_by_sku:
                for deliv_d, qty in deliveries_by_sku[sku_norm].items():
                    if deliv_d > d:
                        delivered_between += qty
            # stan(d) = dzisiaj + sprzedaż(d→dziś) − dostawy(d→dziś); clamp do 0
            # (nowy SKU / niespójność danych nie może dać ujemnego stanu i wartości).
            stock_at_d = stock_today + sold_between - delivered_between
            if stock_at_d < 0:
                stock_at_d = 0
            total_value += stock_at_d * price
            total_units += stock_at_d
        points.append({"date": d.isoformat(), "value": round(total_value, 2), "units": round(total_units)})

    if not has_perm(user, "viewFinancials"):
        for pt in points:
            pt["value"] = 0

    return {
        "points": points,
        "current_value": points[-1]["value"] if points else 0,
        "current_units": points[-1]["units"] if points else 0,
    }
