"""
Surowe zapytania SQL budowane z nazw tabel/kolumn z konfiguracji.
SALES_QUERY liczy sprzedaż w oknach 1-4m, 12m oraz YoY (rok temu, te same 30 dni).
"""

from config import settings, INCLUDED_STATUS_FILTER


SALES_QUERY = f"""
WITH sales_periods AS (
    SELECT
        LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_normalized,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '30 days'  THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_1m,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '60 days'  THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_2m,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '90 days'  THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_3m,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '120 days' THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_4m,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days' THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_12m
    FROM {settings.TABLE_ORDER_ITEMS} oi
    JOIN {settings.TABLE_ORDERS} o ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID}
    WHERE o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days'
      {INCLUDED_STATUS_FILTER}
    GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU}))
),
sales_yoy AS (
    SELECT
        LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_normalized,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '395 days' AND o.{settings.COL_ORDER_DATE} < NOW() - INTERVAL '365 days' THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_yoy_30d,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days' AND o.{settings.COL_ORDER_DATE} < NOW() - INTERVAL '335 days' THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_yoy_next_30d
    FROM {settings.TABLE_ORDER_ITEMS} oi
    JOIN {settings.TABLE_ORDERS} o ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID}
    WHERE o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '395 days'
      AND o.{settings.COL_ORDER_DATE} < NOW() - INTERVAL '335 days'
      {INCLUDED_STATUS_FILTER}
    GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU}))
)
SELECT
    p.{settings.COL_PRODUCT_SKU} AS sku,
    p.{settings.COL_PRODUCT_NAME} AS name,
    COALESCE(p.{settings.COL_PRODUCT_STOCK}, 0)::int AS stock,
    COALESCE(p.{settings.COL_PRODUCT_PRICE}, 0)::float AS price,
    COALESCE(lt.lead_time_days, :default_lead_time)::int AS lead_time_days,
    COALESCE(pa.cbm_per_unit, 0)::float AS cbm_per_unit,
    pa.manufacturer_id,
    m.name AS manufacturer_name,
    m.color AS manufacturer_color,
    COALESCE(pa.seasonality_enabled, FALSE) AS seasonality_enabled,
    COALESCE(pa.is_favorite, FALSE) AS is_favorite,
    pa.ean AS ean,
    pa.forced_status AS forced_status,
    COALESCE(pa.force_visible, FALSE) AS force_visible,
    COALESCE(sp.qty_1m, 0)::int AS sales_1m_total,
    COALESCE(sp.qty_2m, 0)::int AS sales_2m_total,
    COALESCE(sp.qty_3m, 0)::int AS sales_3m_total,
    COALESCE(sp.qty_4m, 0)::int AS sales_4m_total,
    COALESCE(sp.qty_12m, 0)::int AS sales_12m_total,
    COALESCE(sy.qty_yoy_30d, 0)::int AS sales_yoy_30d,
    COALESCE(sy.qty_yoy_next_30d, 0)::int AS sales_yoy_next_30d
FROM {settings.TABLE_PRODUCTS} p
LEFT JOIN sales_periods sp ON sp.sku_normalized = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN sales_yoy sy ON sy.sku_normalized = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN {settings.TABLE_LEAD_TIMES} lt ON lt.sku = p.{settings.COL_PRODUCT_SKU}
LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa ON pa.sku = p.{settings.COL_PRODUCT_SKU}
LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = pa.manufacturer_id
ORDER BY p.{settings.COL_PRODUCT_SKU};
"""


INCOMING_QUERY = f"""
SELECT ci.sku, c.id AS container_id, c.container_number, c.eta_date, c.status, ci.quantity
FROM {settings.TABLE_CONTAINER_ITEMS} ci
JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
WHERE c.status != 'DELIVERED'
ORDER BY c.eta_date ASC;
"""
