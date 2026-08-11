"""
Surowe zapytania SQL budowane z nazw tabel/kolumn z konfiguracji.
SALES_QUERY liczy sprzedaż w oknach 1-4m, 12m oraz YoY (rok temu, te same 30 dni).

Katalog produktów jest WARSTWOWY (kolumna `pri`, niższa wygrywa w catalog_dedup):
  0 — subiekt_dwa_magazyny  (AMH: świeże ceny + stan magazynu podstawowego)
  1 — subiekt_towary        (stara tabela: tylko dla SKU nieobecnych w nowej)
  2 — sellasist_order_items (produkty znane wyłącznie ze sprzedaży)
  3 — sellasist_stock       (produkty tylko w magazynach Acti/Veluxa)
  4 — app_product_attrs     (SAMPLE — nieobecne nigdzie indziej)
Nowa tabela nie pokrywa całego asortymentu AMH (SKU wyprzedane do zera potrafią z niej
zniknąć), dlatego stara zostaje jako zapchajdziura nazwy i ceny — bez niej takie SKU
wypadały z zakładki AMH i wyceniały się na zero.
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
stare_subiekt AS (
    -- Stara tabela subiektowa zdeduplikowana po sku_canon. Używana w DWÓCH rolach:
    -- (a) uzupełnianie nazwy/ceny dla SKU obecnych w nowej tabeli (pri 0),
    -- (b) samodzielne źródło dla SKU, których w nowej tabeli w ogóle nie ma (pri 1).
    -- DISTINCT ON, bo case-warianty symbolu (Subiekt vs Sellasist) potrafią dać >1 wiersz.
    SELECT DISTINCT ON (LOWER(TRIM({settings.COL_PRODUCT_SKU})))
           LOWER(TRIM({settings.COL_PRODUCT_SKU})) AS sku_canon,
           {settings.COL_PRODUCT_SKU}   AS sku_raw,
           {settings.COL_PRODUCT_NAME}  AS nazwa,
           {settings.COL_PRODUCT_STOCK} AS stan,
           {settings.COL_PRODUCT_PRICE} AS cena
    FROM {settings.TABLE_PRODUCTS}
    WHERE {settings.COL_PRODUCT_SKU} IS NOT NULL AND TRIM({settings.COL_PRODUCT_SKU}) <> ''
    ORDER BY LOWER(TRIM({settings.COL_PRODUCT_SKU})),
             {settings.COL_PRODUCT_PRICE} DESC NULLS LAST,
             {settings.COL_PRODUCT_SKU}
),
catalog AS (
    -- 0. źródło GŁÓWNE dla AMH: druga tabela subiektowa — świeże ceny (cena_jednostkowa)
    --    i stan magazynu podstawowego. Kolumna `nazwa` została tu dorobiona później, a ceny
    --    nowych SKU bywają jeszcze zerowe, więc oba pola podpieramy starą tabelą przez
    --    LEFT JOIN (zdeduplikowaną → jeden wiersz na SKU, bez fan-outu).
    --    UWAGA: dedup w catalog_dedup wybiera CAŁY wiersz, nie kolumnę po kolumnie —
    --    dlatego fallback musi siedzieć tutaj, a nie w finalnym COALESCE.
    SELECT LOWER(TRIM(dwa.sku)) AS sku_canon,
           dwa.sku AS sku_raw,
           COALESCE(NULLIF(TRIM(dwa.nazwa), ''), stare.nazwa) AS nazwa,
           COALESCE(dwa.stan_magazyn_podstawowy, 0)::numeric  AS stan,
           COALESCE(NULLIF(dwa.cena_jednostkowa, 0), stare.cena, 0)::numeric AS cena,
           0 AS pri
    FROM {settings.TABLE_SUBIEKT_DWA} dwa
    LEFT JOIN stare_subiekt stare ON stare.sku_canon = LOWER(TRIM(dwa.sku))
    WHERE dwa.sku IS NOT NULL AND TRIM(dwa.sku) <> ''
    UNION ALL
    -- 1. źródło: STARA tabela subiektowa jako zapchajdziura dla SKU, których nowa nie zna
    --    (sieroty: zerowy stan, ale żywa sprzedaż i realna cena). Bez tego wypadały
    --    z zakładki AMH (warunek na src_pri) i traciły nazwę oraz cenę.
    --    Dla SKU obecnych w obu wygrywa pri 0, więc ten wiersz jest wtedy ignorowany.
    SELECT sku_canon, sku_raw, nazwa, stan, cena, 1 AS pri
    FROM stare_subiekt
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
fakturownia_data AS (
    -- Cena zakupu (z PZ) i nazwa z Fakturowni Acti/Veluxa, po sku_canon (SKU globalnie unikalne 1:1;
    -- MAX tylko na wypadek gdyby ten sam symbol trafił do >1 Fakturowni). Bez filtra na cenę,
    -- bo produkt może mieć nazwę przy zerowej cenie. Filtrowanie zer robimy dopiero przy użyciu:
    -- cena przez NULLIF(fd.ppn,0), nazwa przez NULLIF(TRIM(fd.nazwa),'').
    -- AMH nie ma tu wierszy → jego cena/nazwa zostają bez zmian (Subiekt).
    SELECT sku_canon,
           MAX(purchase_price_net) AS ppn,
           MAX(nazwa)              AS nazwa
    FROM {settings.TABLE_FAKTUROWNIA_STOCK}
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
    COALESCE(NULLIF(TRIM(pa.name_override), ''), NULLIF(TRIM(fd.nazwa), ''), p.{settings.COL_PRODUCT_NAME}) AS name,
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
    -- Priorytet ceny: 1) ręczna (świadomy override — musi być na szczycie, inaczej każdy
    -- sync po cichu ją kasuje), 2) Fakturownia (jedyne źródło dla Acti/Veluxa), 3) katalog,
    -- czyli nowa tabela subiektowa z fallbackiem na starą (rozstrzygnięte w CTE `catalog`).
    -- Fakturownia stoi nad Subiektem bez konfliktu — dotyczą rozłącznych firm.
    COALESCE(NULLIF(pa.cena_zakupu, 0), NULLIF(fd.ppn, 0), p.{settings.COL_PRODUCT_PRICE}, 0)::float AS price,
    -- Które z trzech źródeł wyżej faktycznie zadziałało. Front pokazywał na sztywno
    -- „(Subiekt)", więc dla Acti/Veluxa kłamał — ich cena idzie z Fakturowni.
    -- Kolejność CASE musi być identyczna jak w COALESCE powyżej.
    CASE
        WHEN NULLIF(pa.cena_zakupu, 0) IS NOT NULL              THEN 'manual'
        WHEN NULLIF(fd.ppn, 0) IS NOT NULL                      THEN 'fakturownia'
        WHEN NULLIF(p.{settings.COL_PRODUCT_PRICE}, 0) IS NOT NULL THEN 'subiekt'
        ELSE NULL
    END AS price_source,
    pa.cena_zakupu::float AS cena_zakupu_manual,
    COALESCE(lt.lead_time_days, :default_lead_time)::int AS lead_time_days,
    COALESCE(pa.cbm_per_unit, 0)::float AS cbm_per_unit,
    pa.manufacturer_id,
    m.name AS manufacturer_name,
    m.color AS manufacturer_color,
    pa.firma_id,
    f.name AS firma_name,
    f.color AS firma_color,
    LOWER(COALESCE(f.slug, 'amh')) AS firma_slug,
    COALESCE(pa.seasonality_enabled, FALSE) AS seasonality_enabled,
    COALESCE(pa.is_favorite, FALSE) AS is_favorite,
    COALESCE(pa.no_reorder, FALSE) AS no_reorder,
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
LEFT JOIN fakturownia_data fd ON fd.sku_canon = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN sales_periods sp ON sp.sku_normalized = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN sales_global sg ON sg.sku_normalized = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN sales_yoy sy ON sy.sku_normalized = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN (
    SELECT DISTINCT ON (LOWER(TRIM(sku)))
           *, LOWER(TRIM(sku)) AS sku_canon
    FROM {settings.TABLE_LEAD_TIMES}
    WHERE sku IS NOT NULL AND TRIM(sku) <> ''
    ORDER BY LOWER(TRIM(sku)), updated_at DESC NULLS LAST
) lt ON lt.sku_canon = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN (
    SELECT DISTINCT ON (LOWER(TRIM(sku)))
           *, LOWER(TRIM(sku)) AS sku_canon
    FROM {settings.TABLE_PRODUCT_ATTRS}
    WHERE sku IS NOT NULL AND TRIM(sku) <> ''
    ORDER BY LOWER(TRIM(sku)), updated_at DESC NULLS LAST
) pa ON pa.sku_canon = LOWER(TRIM(p.{settings.COL_PRODUCT_SKU}))
LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = pa.manufacturer_id
LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = pa.firma_id
WHERE (
    :shop = ''
    -- Zakładka AMH = obie tabele subiektowe: nowa (0) i stara jako zapchajdziura (1).
    -- Samo `= 0` wywaliłoby stąd sieroty żyjące tylko w starej tabeli.
    OR (:shop = 'amh' AND p.src_pri IN (0, 1))
    OR (:shop <> '' AND :shop <> 'amh' AND (es.qty IS NOT NULL OR sp.sku_normalized IS NOT NULL))
    -- Czysty sample (pri 4) nie ma ani stanu w Sellasiście, ani sprzedaży, więc wypadłby
    -- z każdej zakładki sklepu. Pokazujemy go w zakładce jego firmy (brak firmy → AMH).
    OR (p.src_pri = 4 AND :shop = LOWER(COALESCE(f.slug, 'amh')))
)
ORDER BY p.{settings.COL_PRODUCT_SKU};
"""


INCOMING_QUERY = f"""
SELECT
    ci.sku,
    c.id AS container_id,
    c.container_number,
    c.eta_date,
    c.status,
    c.is_consolidated,
    c.delivered_date,
    c.expected_delivery_date,
    ci.quantity,
    ci.lot_id,
    -- „wbite" (zielona kropka) = towar wjechany do subiektowego magazynu „w drodze".
    -- Dla skonsolidowanych flaga siedzi na locie, dla zwykłych na kontenerze.
    COALESCE(l.subiekt_wbite, c.subiekt_wbite, FALSE) AS wbite,
    l.order_number AS lot_order_number,
    -- PO kontenera (nieskonsolidowany). Front pokazuje je zamiast numeru roboczego
    -- „Draft-…", który jest wyłącznie wewnętrznym gwarantem unikalności.
    c.order_number AS container_order_number,
    COALESCE(lm.name, m.name) AS manufacturer_name
FROM {settings.TABLE_CONTAINER_ITEMS} ci
JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
LEFT JOIN {settings.TABLE_CONTAINER_LOTS} l ON l.id = ci.lot_id
LEFT JOIN {settings.TABLE_MANUFACTURERS} lm ON lm.id = l.manufacturer_id
LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = c.manufacturer_id
WHERE c.status != 'DELIVERED'
ORDER BY c.eta_date ASC;
"""


# Stan sióstr (magazyny Sellasist: Acti/Veluxa) per SKU i per sklep — do komunikatu
# „zaciągnij z [magazynu]" na pożarach. Osobne, lekkie zapytanie mergowane po SKU w Pythonie
# (wzorzec INCOMING_QUERY) — NIE dotykamy SALES_QUERY, żeby nie zrobić fan-outu wierszy
# (SALES_QUERY karmi cały dashboard/finanse/forecast; zdublowanie wierszy zawyżyłoby stany).
# AMH (Subiekt) nie ma tu wierszy — źródłem transferu naturalnie są Acti/Veluxa.
TRANSFER_STOCK_QUERY = f"""
SELECT sku_canon, shop, SUM(quantity)::int AS qty
FROM {settings.TABLE_EXTERNAL_STOCK}
WHERE quantity > 0 AND shop IS NOT NULL AND TRIM(shop) <> ''
GROUP BY sku_canon, shop;
"""


# ─────────────────────────────────────────────────────────────────────────────
# JEDNO ŹRÓDŁO NAZW PRODUKTÓW
# ─────────────────────────────────────────────────────────────────────────────
# Nazwa produktu żyje w pięciu tabelach i żadna nie zna całego asortymentu.
# Wcześniej każdy moduł (kontenery, wyszukiwarka globalna, raport zajętości)
# miał WŁASNĄ, uboższą kopię tej kolejności — i każda gubiła inne SKU:
#   • kontenery i wyszukiwarka nie znały Fakturowni,
#   • raport zajętości nie znał starego Subiektu,
#   • wyszukiwarka nie znała nowego Subiektu ani ręcznych nadpisek.
# Fakturownia jest tu kluczowa: dla towaru Acti/Veluxa, który nigdy się nie sprzedał,
# to JEDYNE miejsce z prawdziwą nazwą — bez niej SKU zostawało puste albo pokazywało
# własny symbol podstawiony jako zapchajdziura w sellasist_stock.
#
# Kolejność (niższe pri wygrywa) jest ta sama, co w finalnym SELECT katalogu wyżej:
#   0. app_product_attrs.name_override — ręczna nadpiska, zawsze wygrywa
#   1. fakturownia_stock               — Acti/Veluxa
#   2. subiekt_dwa_magazyny            — nowy Subiekt (AMH)
#   3. subiekt_towary                  — stary Subiekt (zapchajdziura dla sierot)
#   4. sellasist_order_items           — nazwa ze sprzedaży, ostatnia deska ratunku
#
# Klucz to sku_canon = LOWER(TRIM(sku)) — joinować WYŁĄCZNIE po nim. Join po surowym
# symbolu nie trafia, bo warianty wielkości liter między Subiektem a Sellasistem
# są w tych danych normalne. DISTINCT ON gwarantuje 1 wiersz na SKU — bez niego
# join rozmnożyłby wiersze po stronie wywołującego (np. pozycje kontenera).
PRODUCT_NAMES_CTE = f"""
prod_names AS (
    SELECT DISTINCT ON (sku_canon) sku_canon, nazwa
    FROM (
        SELECT LOWER(TRIM(sku)) AS sku_canon, NULLIF(TRIM(name_override), '') AS nazwa, 0 AS pri
        FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku IS NOT NULL
        UNION ALL
        SELECT sku_canon, NULLIF(TRIM(nazwa), ''), 1
        FROM {settings.TABLE_FAKTUROWNIA_STOCK}
        UNION ALL
        SELECT LOWER(TRIM(sku)), NULLIF(TRIM(nazwa), ''), 2
        FROM {settings.TABLE_SUBIEKT_DWA} WHERE sku IS NOT NULL
        UNION ALL
        SELECT LOWER(TRIM({settings.COL_PRODUCT_SKU})), NULLIF(TRIM({settings.COL_PRODUCT_NAME}), ''), 3
        FROM {settings.TABLE_PRODUCTS} WHERE {settings.COL_PRODUCT_SKU} IS NOT NULL
        UNION ALL
        SELECT LOWER(TRIM({settings.COL_ITEM_SKU})), NULLIF(TRIM(product_name), ''), 4
        FROM {settings.TABLE_ORDER_ITEMS} WHERE {settings.COL_ITEM_SKU} IS NOT NULL
    ) n
    WHERE n.nazwa IS NOT NULL
    ORDER BY sku_canon, pri
)
"""

# Wariant samodzielny dla kodu, który buduje słownik nazw w Pythonie (raport zajętości).
# Klucz UPPER, bo tamten moduł indeksuje po UPPER(TRIM(sku)).
PRODUCT_NAMES_QUERY = f"""
WITH {PRODUCT_NAMES_CTE}
SELECT UPPER(sku_canon) AS sku, nazwa AS n FROM prod_names;
"""
