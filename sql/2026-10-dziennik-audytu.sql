-- Dziennik audytu po ludzku: gotowe zdanie, zmiany „było → jest”, obszar do filtra.
-- Puścić w Supabase (Session Pooler, port 5432) PRZED wdrożeniem backendu.
-- Idempotentne — można puścić drugi raz bez szkody.

ALTER TABLE app_audit_log ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE app_audit_log ADD COLUMN IF NOT EXISTS changes JSONB;
ALTER TABLE app_audit_log ADD COLUMN IF NOT EXISTS area VARCHAR(30);

-- Szum ze starych wpisów: podglądy odprawy, czat asystenta, PDF/auto-sugestia, onboarding
-- i synchronizacje (te pokazuje „Świeżość danych”). Nowy kod ich już nie zapisuje.
DELETE FROM app_audit_log
WHERE details ~ '^(POST|PUT|PATCH|DELETE) /api/(kontenery/[0-9]+/odprawa/podglad$|assistant/chat$|order-pdf-data$|auto-suggest$|reports/snapshot$|auth/me/onboarding$|sellasist/|fakturownia|admin/fx/)';

-- Obszar dla starych wpisów (nowe dostają go przy zapisie).
UPDATE app_audit_log SET area = CASE
    WHEN action IN ('LOGIN', 'LOGIN_FAILED', 'LOGIN_BLOCKED', 'PASSWORD_CHANGED') THEN 'Logowania'
    WHEN action IN ('USER_CREATED', 'USER_UPDATED', 'USER_DELETED', 'PASSWORD_RESET_BY_ADMIN') THEN 'Użytkownicy'
    WHEN action = 'PRODUCT_DELETED' THEN 'Produkty'
    WHEN action = 'MOVE_PAYMENT_TERMIN' THEN 'Finanse'
    WHEN action IN ('OCCUPANCY_CONFIG_SAVED', 'ECONOMICS_CONFIG_SAVED') THEN 'Ustawienia'
    WHEN details ~ '^\S+ /api/products/.+/cena$' THEN 'Ceny'
    WHEN resource_type IN ('products', 'samples', 'product-photos', 'cn-sku') THEN 'Produkty'
    WHEN resource_type IN ('containers', 'attachments') THEN 'Kontenery'
    WHEN resource_type IN ('kontenery', 'odprawy') THEN 'Odprawy'
    WHEN resource_type = 'manufacturers' THEN 'Producenci'
    WHEN resource_type = 'container-types' THEN 'Ustawienia'
    WHEN resource_type = 'firmy' THEN 'Firmy'
    WHEN resource_type = 'users' THEN 'Użytkownicy'
    WHEN resource_type = 'auth' THEN 'Logowania'
    WHEN resource_type IN ('bank-balances', 'owner-loans', 'cashflow') THEN 'Finanse'
    WHEN resource_type IN ('reports', 'usage') THEN 'Ustawienia'
    WHEN resource_type = 'dropy' THEN 'Dropy'
    ELSE 'Inne'
END
WHERE area IS NULL;

-- Stary middleware logował zmiany userów drugi raz (USERS_UPDATED obok USER_UPDATED) — zostaje jeden.
DELETE FROM app_audit_log
WHERE action IN ('USERS_CREATED', 'USERS_UPDATED', 'USERS_DELETED')
  AND details ~ '^(POST|PATCH|DELETE|PUT) /api/users';

-- Retencja 12 miesięcy (dalej pilnuje jej pętla w lifespan.py).
DELETE FROM app_audit_log WHERE created_at < NOW() - INTERVAL '12 months';

CREATE INDEX IF NOT EXISTS idx_audit_log_area ON app_audit_log (area, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_email ON app_audit_log (LOWER(user_email));

-- Kontrola: ile wpisów w którym obszarze.
SELECT area, COUNT(*) AS wpisow, MIN(created_at)::date AS od, MAX(created_at)::date AS do
FROM app_audit_log GROUP BY area ORDER BY wpisow DESC;
