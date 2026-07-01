"""Narzędzia: auto-sugestia składu kontenera, wyszukiwarka EAN/SKU, globalna wyszukiwarka, dane do PDF zamówienia."""

from datetime import date

from fastapi import APIRouter, HTTPException, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, included_status_clause
from database import get_db
from models import AutoSuggestRequest, AutoSuggestItem, AutoSuggestResponse, OrderPdfRequest
from services.products import fetch_products

router = APIRouter(prefix="/api", tags=["tools"])


@router.post("/auto-suggest", response_model=AutoSuggestResponse)
async def auto_suggest(payload: AutoSuggestRequest, db: AsyncSession = Depends(get_db)):
    """Algorytm proponuje skład kontenera dla danego producenta."""
    type_result = await db.execute(text(f"SELECT capacity_cbm FROM {settings.TABLE_CONTAINER_TYPES} WHERE id = :id"), {"id": payload.container_type_id})
    capacity_row = type_result.first()
    if not capacity_row:
        raise HTTPException(404, "Typ kontenera nie znaleziony")
    capacity = float(capacity_row.capacity_cbm)

    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"})
    mfr_products = [p for p in products if p.manufacturer_id == payload.manufacturer_id]
    mfr_products.sort(key=lambda p: (p.days_until_order, -p.avg_monthly_weighted))

    items = []
    used_cbm = 0.0

    for p in mfr_products:
        needed = int(p.avg_monthly_weighted * payload.months_horizon - p.stock - p.stock_in_transit)
        if needed <= 0:
            continue
        cbm = p.cbm_per_unit * needed
        if used_cbm + cbm > capacity:
            remaining = capacity - used_cbm
            if p.cbm_per_unit > 0:
                fit_qty = int(remaining / p.cbm_per_unit)
                if fit_qty > 0:
                    items.append(AutoSuggestItem(
                        sku=p.sku, name=p.name, quantity=fit_qty,
                        unit_cost=p.purchase_price,
                        cbm_total=round(fit_qty * p.cbm_per_unit, 3),
                        is_partial=True,
                    ))
                    used_cbm += fit_qty * p.cbm_per_unit
            break
        items.append(AutoSuggestItem(
            sku=p.sku, name=p.name, quantity=needed,
            unit_cost=p.purchase_price,
            cbm_total=round(cbm, 3),
        ))
        used_cbm += cbm

    fill_pct = (used_cbm / capacity * 100) if capacity > 0 else 0
    total_value = sum(i.unit_cost * i.quantity for i in items)
    total_units = sum(i.quantity for i in items)

    return AutoSuggestResponse(
        items=items, total_cbm=round(used_cbm, 3),
        capacity_cbm=capacity, fill_pct=round(fill_pct, 1),
        total_value=round(total_value, 2), total_units=total_units,
    )


@router.get("/search/ean")
async def search_ean(q: str = Query(..., min_length=2), db: AsyncSession = Depends(get_db)):
    """Wyszukiwanie produktu po EAN lub SKU. Sprawdza zapisane EANy w app_product_attrs oraz historyczne w sellasist_order_items."""
    r = await db.execute(text(f"""
        SELECT DISTINCT
            p.{settings.COL_PRODUCT_SKU} AS sku,
            p.{settings.COL_PRODUCT_NAME} AS name,
            p.{settings.COL_PRODUCT_STOCK} AS stock,
            COALESCE(pa.ean, (SELECT MAX(oi.{settings.COL_ITEM_EAN})
             FROM {settings.TABLE_ORDER_ITEMS} oi
             WHERE LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
             AND oi.{settings.COL_ITEM_EAN} IS NOT NULL
             LIMIT 1)) AS ean
        FROM {settings.TABLE_PRODUCTS} p
        LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa ON pa.sku = p.{settings.COL_PRODUCT_SKU}
        WHERE LOWER(p.{settings.COL_PRODUCT_SKU}) LIKE LOWER(:q)
           OR pa.ean LIKE :q
           OR EXISTS (
                SELECT 1 FROM {settings.TABLE_ORDER_ITEMS} oi
                WHERE LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
                  AND oi.{settings.COL_ITEM_EAN} LIKE :q
           )
        LIMIT 10
    """), {"q": f"%{q}%"})
    return [{"sku": row._mapping["sku"], "name": row._mapping["name"], "stock": row._mapping["stock"], "ean": row._mapping["ean"]} for row in r]


def _visible_products_clause(sku_raw_sql: str) -> str:
    """Zwraca predykat SQL (bool): TRUE gdy produkt o danym SKU NIE jest INACTIVE.
    Definicja 1:1 z classify_product / SALES_QUERY: force_visible oraz forced_status
    (ACTIVE/ACTIVE_NO_STOCK/DEAD_STOCK) wymuszają widoczność; forced_status='INACTIVE'
    ukrywa zawsze; inaczej produkt jest widoczny gdy ma stan (Subiekt lub zewnętrzny
    Sellasist) albo zrealizowaną sprzedaż (whitelist statusów) w ostatnich 365 dniach.
    Użyte w globalnej wyszukiwarce (Ctrl+K / skaner EAN), żeby nieaktywne SKU nie wypływały."""
    canon = f"LOWER(TRIM({sku_raw_sql}))"
    status_ext = included_status_clause("o2")
    return f"""(
        EXISTS (SELECT 1 FROM {settings.TABLE_PRODUCT_ATTRS} pav
                WHERE LOWER(TRIM(pav.sku)) = {canon}
                  AND (COALESCE(pav.force_visible, FALSE) = TRUE
                       OR pav.forced_status IN ('ACTIVE', 'ACTIVE_NO_STOCK', 'DEAD_STOCK')))
        OR (
            NOT EXISTS (SELECT 1 FROM {settings.TABLE_PRODUCT_ATTRS} pai
                        WHERE LOWER(TRIM(pai.sku)) = {canon} AND pai.forced_status = 'INACTIVE')
            AND (
                EXISTS (SELECT 1 FROM {settings.TABLE_PRODUCTS} sub
                        WHERE LOWER(TRIM(sub.{settings.COL_PRODUCT_SKU})) = {canon}
                          AND COALESCE(sub.{settings.COL_PRODUCT_STOCK}, 0) > 0)
                OR EXISTS (SELECT 1 FROM {settings.TABLE_EXTERNAL_STOCK} ss
                           WHERE ss.sku_canon = {canon} AND COALESCE(ss.quantity, 0) > 0)
                OR EXISTS (SELECT 1 FROM {settings.TABLE_ORDER_ITEMS} oi2
                           JOIN {settings.TABLE_ORDERS} o2
                             ON o2.{settings.COL_ORDER_ID} = oi2.{settings.COL_ITEM_ORDER_ID}
                            AND o2.shop = oi2.shop
                           WHERE LOWER(TRIM(oi2.{settings.COL_ITEM_SKU})) = {canon}
                             AND o2.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days'
                             {status_ext})
            )
        )
    )"""


@router.get("/search/global")
async def search_global(q: str = Query(..., min_length=2), include_inactive: bool = False, db: AsyncSession = Depends(get_db)):
    """Globalna wyszukiwarka po: SKU, nazwie produktu, EAN, producencie, numerze kontenera.
    Produkty INACTIVE (zero stanu i zero sprzedaży 12m) są domyślnie pomijane
    (_visible_products_clause). include_inactive=1 (z preferencji "Nieaktywne" we froncie)
    wyłącza filtr, żeby dało się je odnaleźć."""
    query_lower = f"%{q.lower()}%"
    # Pusty fragment = brak filtra (pokaż też nieaktywne); inaczej dokładamy predykat widoczności.
    vis_prod = "" if include_inactive else f"AND {_visible_products_clause(f'p.{settings.COL_PRODUCT_SKU}')}"
    vis_ean = "" if include_inactive else f"AND {_visible_products_clause(f'oi.{settings.COL_ITEM_SKU}')}"

    # 1. Produkty (SKU + nazwa)
    products_result = await db.execute(text(f"""
        SELECT
            p.{settings.COL_PRODUCT_SKU} AS sku,
            p.{settings.COL_PRODUCT_NAME} AS name,
            COALESCE(p.{settings.COL_PRODUCT_STOCK}, 0) AS stock,
            m.name AS manufacturer_name,
            m.color AS manufacturer_color
        FROM {settings.TABLE_PRODUCTS} p
        LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa ON pa.sku = p.{settings.COL_PRODUCT_SKU}
        LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = pa.manufacturer_id
        WHERE (LOWER(p.{settings.COL_PRODUCT_SKU}) LIKE :q
           OR LOWER(p.{settings.COL_PRODUCT_NAME}) LIKE :q)
          {vis_prod}
        ORDER BY
            CASE WHEN LOWER(p.{settings.COL_PRODUCT_SKU}) = LOWER(:exact) THEN 0 ELSE 1 END,
            p.{settings.COL_PRODUCT_SKU}
        LIMIT 15
    """), {"q": query_lower, "exact": q})
    products = [dict(r._mapping) for r in products_result]

    # 2. Wyszukiwanie po EAN (jeśli zapytanie wygląda jak liczba)
    ean_products = []
    if q.replace(" ", "").isdigit() or any(c.isdigit() for c in q):
        ean_result = await db.execute(text(f"""
            SELECT DISTINCT
                oi.{settings.COL_ITEM_SKU} AS sku,
                oi.{settings.COL_ITEM_EAN} AS ean,
                MAX(p.{settings.COL_PRODUCT_NAME}) AS name
            FROM {settings.TABLE_ORDER_ITEMS} oi
            LEFT JOIN {settings.TABLE_PRODUCTS} p
                ON LOWER(TRIM(p.{settings.COL_PRODUCT_SKU})) = LOWER(TRIM(oi.{settings.COL_ITEM_SKU}))
            WHERE oi.{settings.COL_ITEM_EAN} LIKE :q
              {vis_ean}
            GROUP BY oi.{settings.COL_ITEM_SKU}, oi.{settings.COL_ITEM_EAN}
            LIMIT 10
        """), {"q": query_lower})
        ean_products = [dict(r._mapping) for r in ean_result]

    # 3. Producenci
    mfrs_result = await db.execute(text(f"""
        SELECT id, name, color, email, notes
        FROM {settings.TABLE_MANUFACTURERS}
        WHERE LOWER(name) LIKE :q OR LOWER(COALESCE(notes, '')) LIKE :q OR LOWER(COALESCE(email, '')) LIKE :q
        LIMIT 10
    """), {"q": query_lower})
    manufacturers = [dict(r._mapping) for r in mfrs_result]

    # 4. Kontenery
    containers_result = await db.execute(text(f"""
        SELECT
            c.id, c.container_number, c.order_number, c.eta_date, c.status,
            m.name AS manufacturer_name, m.color AS manufacturer_color
        FROM {settings.TABLE_CONTAINERS} c
        LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = c.manufacturer_id
        WHERE LOWER(c.container_number) LIKE :q
           OR LOWER(COALESCE(c.order_number, '')) LIKE :q
           OR LOWER(COALESCE(c.notes, '')) LIKE :q
        ORDER BY c.eta_date DESC
        LIMIT 10
    """), {"q": query_lower})
    containers = [dict(r._mapping) for r in containers_result]

    return {
        "products": products,
        "ean": ean_products,
        "manufacturers": manufacturers,
        "containers": containers,
        "total": len(products) + len(ean_products) + len(manufacturers) + len(containers),
    }


@router.post("/order-pdf-data")
async def order_pdf_data(payload: OrderPdfRequest, db: AsyncSession = Depends(get_db)):
    """
    Zwraca dane do wygenerowania PDF zamówienia.
    PDF generujemy po stronie frontendu (jsPDF) bo łatwiej kontrolować layout.
    """
    mfr = await db.execute(text(f"SELECT id, name, email, notes, color FROM {settings.TABLE_MANUFACTURERS} WHERE id = :id"), {"id": payload.manufacturer_id})
    m = mfr.first()
    if not m:
        raise HTTPException(404, "Producent nie znaleziony")

    total_value = sum(i.get("quantity", 0) * i.get("unit_cost", 0) for i in payload.items)
    total_units = sum(i.get("quantity", 0) for i in payload.items)

    return {
        "manufacturer": {"id": m.id, "name": m.name, "email": m.email, "notes": m.notes, "color": m.color},
        "order_number": payload.custom_order_number or f"PO-{date.today().strftime('%Y%m%d')}-{m.id:03d}",
        "order_date": date.today().isoformat(),
        "items": payload.items,
        "total_value": round(total_value, 2),
        "total_units": total_units,
        "notes": payload.notes,
    }
