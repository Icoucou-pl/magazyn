-- Zakładka „Cena" na karcie produktu: zapisane sugerowane ceny sprzedaży.
-- Puścić w Supabase (Session Pooler, port 5432) PRZED wdrożeniem backendu.
-- Idempotentne — można puścić drugi raz bez szkody.

CREATE TABLE IF NOT EXISTS app_product_ceny (
    id               SERIAL PRIMARY KEY,
    sku_canon        TEXT        NOT NULL,              -- LOWER(TRIM(sku)) — klucz łączenia
    sku              TEXT        NOT NULL,              -- pisownia z karty, do podglądu
    kanal            TEXT        NOT NULL CHECK (kanal IN ('sklepy', 'dropy')),
    baza             TEXT        NOT NULL CHECK (baza IN ('fifo', 'srednia', 'ostatnia', 'reczna')),
    koszt_bazy       NUMERIC(12,2) NOT NULL,            -- koszt / szt w chwili zapisu
    tryb             TEXT        NOT NULL CHECK (tryb IN ('marza', 'narzut')),
    procent          NUMERIC(7,2)  NOT NULL,
    wysylka          NUMERIC(10,2) NOT NULL DEFAULT 0,
    prowizja         NUMERIC(5,2)  NOT NULL DEFAULT 0,
    vat              NUMERIC(5,2)  NOT NULL DEFAULT 23,
    cena_netto       NUMERIC(12,2) NOT NULL,
    cena_brutto      NUMERIC(12,2) NOT NULL,
    shop             TEXT,                              -- firma z przełącznika w chwili zapisu ('' = wszystkie)
    zapisal_user_id  INTEGER,
    zapisal          TEXT,
    zapisano         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT app_product_ceny_sku_kanal UNIQUE (sku_canon, kanal)
);
