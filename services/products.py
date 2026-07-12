"""
Logika produktowa: klasyfikacja statusu, prognoza wyczerpania zapasu,
pobieranie listy produktów z naliczonymi metrykami.
"""

from datetime import date, timedelta
from typing import List

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from sql import SALES_QUERY, INCOMING_QUERY
from models import ProductSummary, IncomingDelivery


def classify_product(row: dict) -> str:
    """Status produktu. Ręczne wymuszenie (forced_status) ma najwyższy priorytet.

    SAMPLE to etykieta, nie wynik obliczeń: produkt oznaczony is_sample dostaje status SAMPLE
    niezależnie od stanu i sprzedaży. Dzięki temu wypada z auto-sugestii, listy zakupów i anomalii
    (te czytają wyłącznie ACTIVE / ACTIVE_NO_STOCK) i nie zaśmieca dead stocku zerową sprzedażą.
    Gdy sample się przyjmie — odznaczasz etykietę i produkt wraca do normalnej klasyfikacji.
    """
    forced = row.get("forced_status")
    if forced and forced in ("ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"):
        return forced

    if row.get("is_sample", False):
        return "SAMPLE"

    # Status liczony GLOBALNIE (ze wszystkich sklepów), niezależnie od wybranej zakładki:
    # produkt aktywny gdziekolwiek jest aktywny wszędzie. Liczby per-sklep (stock, sales_*)
    # zostają do wyświetlania i prognozy — status to osobna oś widoczności.
    stock = row.get("stock_global", row["stock"])
    sales_12m = row.get("sales_12m_global", row["sales_12m_total"])
    if row.get("force_visible", False):
        return "ACTIVE"
    if stock > 0 and sales_12m > 0:
        return "ACTIVE"
    if stock == 0 and sales_12m > 0:
        return "ACTIVE_NO_STOCK"
    if stock > 0 and sales_12m == 0:
        return "DEAD_STOCK"
    return "INACTIVE"


def calculate_forecast(row: dict, incoming: List[dict]) -> ProductSummary:
    """Liczy prognozę: średnia ważona sprzedaż, dzień wyczerpania, data zamówienia, status."""
    sales_1m = row["sales_1m_total"]
    sales_2m_avg = row["sales_2m_total"] / 2
    sales_3m_avg = row["sales_3m_total"] / 3
    sales_4m_avg = row["sales_4m_total"] / 4

    avg_monthly = sales_1m * 0.4 + sales_2m_avg * 0.3 + sales_3m_avg * 0.2 + sales_4m_avg * 0.1
    base_daily_sales = avg_monthly / 30 if avg_monthly > 0 else 0

    today = date.today()
    eta_map = {}
    stock_in_transit = 0
    incoming_deliveries = []

    for inc in incoming:
        if inc["eta_date"] >= today:
            eta_map.setdefault(inc["eta_date"], 0)
            eta_map[inc["eta_date"]] += inc["quantity"]
            stock_in_transit += inc["quantity"]
            incoming_deliveries.append(IncomingDelivery(
                container_id=inc["container_id"],
                container_number=inc["container_number"],
                eta_date=inc["eta_date"],
                quantity=inc["quantity"],
                status=inc["status"],
            ))

    current_stock = float(row["stock"])
    days_until_empty = 9999

    if base_daily_sales > 0:
        for offset in range(0, 730):
            check_date = today + timedelta(days=offset)
            if check_date in eta_map:
                current_stock += eta_map[check_date]
            current_stock -= base_daily_sales
            if current_stock <= 0:
                days_until_empty = offset
                break

    empty_date = today + timedelta(days=days_until_empty)
    order_date = empty_date - timedelta(days=row["lead_time_days"])
    days_until_order = (order_date - today).days

    if days_until_order <= 0 and days_until_empty < row["lead_time_days"]:
        status = "KRYTYCZNY"
    elif days_until_order <= 7:
        status = "ZAMOW_TERAZ"
    elif days_until_order <= 30:
        status = "ZAMOW_WKROTCE"
    else:
        status = "OK"

    total_available = row["stock"] + stock_in_transit
    months_of_stock = (total_available / avg_monthly) if avg_monthly > 0 else 999.0
    price = float(row.get("price") or 0)

    return ProductSummary(
        sku=row["sku"],
        name=row["name"] or "",
        name_override_manual=row.get("name_override_manual"),
        stock=float(row["stock"] or 0),
        stock_value=round(row["stock"] * price, 2),
        purchase_price=round(price, 2),
        cena_zakupu_manual=(round(float(row["cena_zakupu_manual"]), 2) if row.get("cena_zakupu_manual") is not None else None),
        stock_in_transit=stock_in_transit,
        product_status=classify_product(row),
        cbm_per_unit=row.get("cbm_per_unit", 0),
        manufacturer_id=row.get("manufacturer_id"),
        manufacturer_name=row.get("manufacturer_name"),
        manufacturer_color=row.get("manufacturer_color"),
        firma_id=row.get("firma_id"),
        firma_name=row.get("firma_name"),
        firma_color=row.get("firma_color"),
        seasonality_enabled=row.get("seasonality_enabled", False),
        is_favorite=row.get("is_favorite", False),
        is_sample=bool(row.get("is_sample", False)),
        sample_stock=int(row.get("sample_stock") or 0),
        ean=row.get("ean"),
        forced_status=row.get("forced_status"),
        lead_time_days=row["lead_time_days"],
        sales_1m=sales_1m,
        sales_2m=round(sales_2m_avg),
        sales_3m=round(sales_3m_avg),
        sales_4m=round(sales_4m_avg),
        sales_yoy_30d=row.get("sales_yoy_30d", 0),
        sales_yoy_next_30d=row.get("sales_yoy_next_30d", 0),
        avg_monthly_weighted=round(avg_monthly, 1),
        months_of_stock=round(months_of_stock, 1),
        days_until_empty=days_until_empty,
        days_until_order=days_until_order,
        empty_date=empty_date,
        order_date=order_date,
        status=status,
        incoming_deliveries=sorted(incoming_deliveries, key=lambda d: d.eta_date),
    )


async def auto_deliver_containers(db: AsyncSession):
    """Automatycznie oznacza kontenery IN_TRANSIT jako DELIVERED gdy ETA minęła."""
    await db.execute(text(f"""
        UPDATE {settings.TABLE_CONTAINERS}
        SET status = 'DELIVERED', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'IN_TRANSIT' AND eta_date <= CURRENT_DATE
    """))
    await db.commit()


async def fetch_products(db: AsyncSession, include_set: set, shop: str = "") -> List[ProductSummary]:
    """Pobiera produkty z metrykami, filtrowane po statusie (include_set).
    shop="" = wszystkie sklepy; "amh"/"acti"/"veluxa" = sprzedaż i stan tylko danego sklepu (Faza 3)."""
    await auto_deliver_containers(db)
    products_result = await db.execute(text(SALES_QUERY), {"default_lead_time": settings.DEFAULT_LEAD_TIME_DAYS, "shop": shop})
    products = [dict(r._mapping) for r in products_result]

    incoming_result = await db.execute(text(INCOMING_QUERY))
    incoming_all = [dict(r._mapping) for r in incoming_result]

    incoming_by_sku = {}
    for inc in incoming_all:
        key = inc["sku"].strip().lower() if inc["sku"] else ""
        incoming_by_sku.setdefault(key, []).append(inc)

    results = []
    for p in products:
        if classify_product(p) not in include_set:
            continue
        sku_key = p["sku"].strip().lower() if p["sku"] else ""
        results.append(calculate_forecast(p, incoming_by_sku.get(sku_key, [])))
    return results


async def get_product(db: AsyncSession, sku: str) -> ProductSummary:
    """Pojedynczy produkt po SKU (szuka we wszystkich statusach). Rzuca 404."""
    from fastapi import HTTPException
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"})
    for p in products:
        if p.sku == sku:
            return p
    raise HTTPException(404, f"Produkt {sku} nie znaleziony")
