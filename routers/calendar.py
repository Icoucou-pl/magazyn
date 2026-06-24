"""Kalendarz zdarzeń (zamówienia/wyczerpania/dostawy), cashflow, historia wartości magazynu."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, INCLUDED_STATUS_FILTER
from database import get_db
from services.products import fetch_products
from services.containers import fetch_containers

router = APIRouter(prefix="/api", tags=["calendar"])


@router.get("/calendar")
async def calendar_events(db: AsyncSession = Depends(get_db)):
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"})
    containers = await fetch_containers(db)

    events = []
    for p in products:
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
        if c.status != "DELIVERED":
            events.append({
                "date": c.eta_date.isoformat(), "type": "DELIVERY",
                "container_id": c.id, "container_number": c.container_number,
                "order_number": c.order_number, "manufacturer_name": c.manufacturer_name,
                "manufacturer_color": c.manufacturer_color, "total_units": c.total_units,
                "container_status": c.status,
            })

    return events


@router.get("/cashflow")
async def cashflow(months: int = 6, db: AsyncSession = Depends(get_db)):
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
        if c.status == "DELIVERED":
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
async def stock_value_history(days: int = 90, db: AsyncSession = Depends(get_db)):
    """
    Symulacja wartości magazynu w czasie - bazuje na obecnym stanie + sprzedaży.
    To jest aproksymacja, bo Subiekt nie trzyma historii stanu - rekonstruujemy z danych zamówień.
    """
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"})

    today = date.today()

    sales_query = f"""
        SELECT
            LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_norm,
            DATE(o.{settings.COL_ORDER_DATE}) AS sale_date,
            SUM(oi.{settings.COL_ITEM_QTY}) AS qty
        FROM {settings.TABLE_ORDER_ITEMS} oi
        JOIN {settings.TABLE_ORDERS} o ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID}
        WHERE o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '{days} days'
            {INCLUDED_STATUS_FILTER}
        GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU})), DATE(o.{settings.COL_ORDER_DATE})
    """
    sales_result = await db.execute(text(sales_query))

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

    # Dostawy: kontenery, których ETA już minęła (towar wszedł do magazynu ~w dacie ETA).
    # Cofając się w czasie MUSIMY je odjąć — przed dostawą stan był niższy. Bez tego wykres
    # był gładką linią rosnącą wstecz (tylko sprzedaż), bez realnych skoków od dostaw.
    deliveries_query = f"""
        SELECT
            LOWER(TRIM(ci.sku)) AS sku_norm,
            DATE(c.eta_date) AS deliv_date,
            SUM(ci.quantity) AS qty
        FROM {settings.TABLE_CONTAINER_ITEMS} ci
        JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
        WHERE c.eta_date IS NOT NULL
            AND c.eta_date >= NOW() - INTERVAL '{days} days'
            AND c.eta_date <= NOW()
        GROUP BY LOWER(TRIM(ci.sku)), DATE(c.eta_date)
    """
    deliveries_result = await db.execute(text(deliveries_query))

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
        points.append({"date": d.isoformat(), "value": round(total_value, 2)})

    return {"points": points, "current_value": points[-1]["value"] if points else 0}
