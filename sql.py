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
    JOIN {settings.TABLE_ORDERS} o ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID} AND o.shop = oi.shop
    WHERE o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days'
      {INCLUDED_STATUS_FILTER}
      AND (:shop = '' OR o.shop = :shop)
    GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU}))
),
sales_yoy AS (
    SELECT
        LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_normalized,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '395 days' AND o.{settings.COL_ORDER_DATE} < NOW() - INTERVAL '365 days' THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_yoy_30d,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days' AND o.{settings.COL_ORDER_DATE} < NOW() - INTERVAL '335 days' THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_yoy_next_30d
    FROM {settings.TABLE_ORDER_ITEMS} oi
    JOIN {settings.TABLE_ORDERS} o ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID} AND o.shop = oi.shop
    WHERE o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '395 days'
      AND o.{settings.COL_ORDER_DATE} < NOW() - INTERVAL '335 days'
      {INCLUDED_STATUS_FILTER}
      AND (:shop = '' OR o.shop = :shop)
    GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU}))
),
sellasist_skus AS (
    SELECT LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_canon,
           MAX(oi.{settings.COL_ITEM_SKU}) AS sku_raw,
           MAX(oi.product_name) AS nazwa
    FROM {settings.TABLE_ORDER_ITEMS} oi
    WHERE oi.{settings.COL_ITEM_SKU} IS NOT NULL AND TRIM(oi.{settings.COL_ITEM_SKU}) <> ''
    GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU}))
),
catalog AS (
    SELECT LOWER(TRIM({settings.COL_PRODUCT_SKU})) AS sku_canon,
           {settings.COL_PRODUCT_SKU} AS sku_raw,
           {settings.COL_PRODUCT_NAME} AS nazwa,
           {settings.COL_PRODUCT_STOCK} AS stan,
           {settings.COL_PRODUCT_PRICE} AS cena,
           1 AS pri
    FROM {settings.TABLE_PRODUCTS}
    WHERE {settings.COL_PRODUCT_SKU} IS NOT NULL AND TRIM({settings.COL_PRODUCT_SKU}) <> ''
    UNION ALL
    SELECT sku_canon, sku_raw, nazwa, 0::numeric AS stan, 0::numeric AS cena, 2 AS pri
    FROM sellasist_skus
    UNION ALL
    -- 3. źródło: produkty istniejące TYLKO w magazynach Sellasist (Acti/Veluxa) — nigdy nie sprzedane
    --    i nieobecne w Subiekcie. Bez tego wypadały z katalogu (nie było ich nawet we „Wszystkich").
    --    Nazwa: brak w sellasist_stock → podkładamy surowy symbol (realna nazwa z Subiektu/zamówień wygra przez niższe pri).
    SELECT sku_canon,
           MAX(symbol) AS sku_raw,
           MAX(symbol) AS nazwa,
           0::numeric AS stan,
           0::numeric AS cena,
           3 AS pri
    FROM {settings.TABLE_EXTERNAL_STOCK}
    WHERE symbol IS NOT NULL AND TRIM(symbol) <> ''
    GROUP BY sku_canon
    UNION ALL
    -- 4. źródło: SAMPLE — produkty zamawiane próbnie, nieobecne ani w Subiekcie, ani w Sellasiście.
    --    Bez tego SKU nie istnieje w katalogu, więc nie da się mu nadać CBM ani producenta,
    --    a w kontenerze zajmuje 0 m³ (zaniżone wypełnienie).
    --    Uwaga: to źródło ma NAJWYŻSZE pri, więc gdy sample kiedyś wejdzie do Subiektu (pri 1)
    --    albo się sprzeda w Sellasiście (pri 2), dedup automatycznie weźmie prawdziwe źródło.
    SELECT LOWER(TRIM(pas.sku)) AS sku_canon,
           pas.sku AS sku_raw,
           COALESCE(NULLIF(TRIM(pas.name_override), ''), pas.sku) AS nazwa,
           0::numeric AS stan,
           0::numeric AS cena,
           4 AS pri
    FROM {settings.TABLE_PRODUCT_ATTRS} pas
    WHERE COALESCE(pas.is_sample, FALSE) AND pas.sku IS NOT NULL AND TRIM(pas.sku) <> ''
),
catalog_dedup AS (
    SELECT DISTINCT ON (sku_canon)
           sku_raw AS {settings.COL_PRODUCT_SKU},
           nazwa  AS {settings.COL_PRODUCT_NAME},
           stan   AS {settings.COL_PRODUCT_STOCK},
           cena   AS {settings.COL_PRODUCT_PRICE},
           pri    AS src_pri
    FROM catalog
    ORDER BY sku_canon, pri, stan DESC NULLS LAST, sku_raw
),
ext_stock AS (
    SELECT sku_canon, SUM(quantity) AS qty
    FROM {settings.TABLE_EXTERNAL_STOCK}
    WHERE (:shop = '' OR shop = :shop)
    GROUP BY sku_canon
),
ext_stock_global AS (
    SELECT sku_canon, SUM(quantity) AS qty
    FROM {settings.TABLE_EXTERNAL_STOCK}
    GROUP BY sku_canon
),
sales_global AS (
    SELECT
        LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_normalized,
        SUM(CASE WHEN o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days' THEN oi.{settings.COL_ITEM_QTY} ELSE 0 END) AS qty_12m
    FROM {settings.TABLE_ORDER_ITEMS} oi
    JOIN {settings.TABLE_ORDERS} o ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID} AND o.shop = oi.shop
    WHERE o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days'
      {INCLUDED_STATUS_FILTER}
    GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU}))
)
SELECT
    p.{settings.COL_PRODUCT_SKU} AS sku,
    COALESCE(NULLIF(TRIM(pa.name_override), ''), p.{settings.COL_PRODUCT_NAME}) AS name,
    pa.name_override AS name_override_manual,
    -- Sample istniejący TYLKO w app_product_attrs (src_pri = 4) nie ma źródła stanu
    -- (nie zna go ani Subiekt, ani Sellasist) — stan bierze się z ręcznego licznika sample_stock.
    -- Sample, który JEST w Subiekcie/Sellasiście (pri 1-3), ma stan z prawdziwego źródła.
    (CASE WHEN p.src_pri = 4
          THEN COALESCE(pa.sample_stock, 0)
          ELSE (CASE WHEN :shop IN ('', 'amh') THEN COALESCE(p.{settings.COL_PRODUCT_STOCK}, 0) ELSE 0 END + COALESCE(es.qty, 0))
     END)::int AS stock,
    (CASE WHEN p.src_pri = 4
          THEN COALESCE(pa.sample_stock, 0)
          ELSE (COALESCE(p.{settings.COL_PRODUCT_STOCK}, 0) + COALESCE(esg.qty, 0))
     END)::int AS stock_global,
    COALESCE(NULLIF(pa.cena_zakupu, 0), p.{settings.COL_PRODUCT_PRICE}, 0)::float AS price,
    pa.cena_zakupu::float AS cena_zakupu_manual,
    COALESCE(lt.lead_time_days, :default_lead_time)::int AS lead_time_days,
    COALESCE(pa.cbm_per_unit, 0)::float AS cbm_per_unit,
    pa.manufacturer_id,
    m.name AS manufacturer_name,
    m.color AS manufacturer_color,
    pa.firma_id,
    f.name AS firma_name,
    f.color AS firma_color,
    COALESCE(pa.seasonality_enabled, FALSE) AS seasonality_enabled,
    COALESCE(pa.is_favorite, FALSE) AS is_favorite,
    pa.ean AS ean,
    pa.forced_status AS forced_status,
    COALESCE(pa.force_visible, FALSE) AS force_visible,
    COALESCE(pa.is_sample, FALSE) AS is_sample,
    COALESCE(pa.sample_stock, 0)::int AS sample_stock,
    p.src_pri::int AS src_pri,
    COALESCE(sp.qty_1m, 0)::int AS sales_1m_total,
    COALESCE(sp.qty_2m, 0)::int AS sales_2m_total,
    COALESCE(sp.qty_3m, 0)::int AS sales_3m_total,
    COALESCE(sp.qty_4m, 0)::int AS sales_4m_total,
    COALESCE(sp.qty_12m, 0)::int AS sales_12m_total,
    COALESCE(sg.qty_12m, 0)::int AS sales_12m_global,
    COALESCE(sy.qty_yoy_30d, 0)::int AS sales_yoy_30d,
    COALESCE(sy.qty_yoy_next_30d, 0)::int AS sales_yoy_next_30d
FROM catalog_dedup p
LEFT JOIN ext_stock es ON es.sku_canon = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN ext_stock_global esg ON esg.sku_canon = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN sales_periods sp ON sp.sku_normalized = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN sales_global sg ON sg.sku_normalized = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN sales_yoy sy ON sy.sku_normalized = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN {settings.TABLE_LEAD_TIMES} lt ON lt.sku = p.{settings.COL_PRODUCT_SKU}
LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa ON pa.sku = p.{settings.COL_PRODUCT_SKU}
LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = pa.manufacturer_id
LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = pa.firma_id
WHERE (
    :shop = ''
    OR (:shop = 'amh' AND p.src_pri = 1)
    OR (:shop <> '' AND :shop <> 'amh' AND (es.qty IS NOT NULL OR sp.sku_normalized IS NOT NULL))
    -- Czysty sample (pri 4) nie ma ani stanu w Sellasiście, ani sprzedaży, więc wypadłby
    -- z każdej zakładki sklepu. Pokazujemy go w zakładce jego firmy (brak firmy → AMH).
    OR (p.src_pri = 4 AND :shop = LOWER(COALESCE(f.slug, 'amh')))
)
ORDER BY p.{settings.COL_PRODUCT_SKU};
"""


INCOMING_QUERY = f"""
SELECT ci.sku, c.id AS container_id, c.container_number, c.eta_date, c.status, ci.quantity
FROM {settings.TABLE_CONTAINER_ITEMS} ci
JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
WHERE c.status != 'DELIVERED'
ORDER BY c.eta_date ASC;
"""
