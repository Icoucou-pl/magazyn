-- Ręczna stawka VAT produktu (zakładka Dane). NULL = stawka z ostatniej krajowej sprzedaży.
-- Puścić w Supabase (Session Pooler, port 5432) PRZED wdrożeniem. Idempotentne.
ALTER TABLE app_product_attrs ADD COLUMN IF NOT EXISTS vat_manual NUMERIC(4,1);
