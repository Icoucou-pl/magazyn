-- Koszt jednostkowy v2 („metoda szefa”): ręczne poprawki rachunku i słownik stawek cła.
-- Puścić w Supabase (Session Pooler, port 5432) PRZED wdrożeniem backendu.
-- Idempotentne — można puścić drugi raz bez szkody.
--
-- Rachunek liczy się na bieżąco z karty kontenera i płatności. W bazie trzymamy TYLKO
-- poprawki wpisane ręcznie; NULL w kolumnie = wartość automatyczna.
-- Kursy NBP: bez nowej tabeli — korzystamy z istniejącej app_fx_rates (tabela A, kurs średni).

CREATE TABLE IF NOT EXISTS app_koszt_kontenera (
    container_id   INTEGER PRIMARY KEY REFERENCES app_containers(id) ON DELETE CASCADE,
    kurs_towaru    NUMERIC(12,6),        -- PLN za 1 jednostkę waluty towaru
    fracht_pln     NUMERIC(12,2),
    lenmar_pln     NUMERIC(12,2),
    transport_pln  NUMERIC(12,2),
    zapisal        TEXT,
    zapisano       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_koszt_pozycji (
    item_id        INTEGER PRIMARY KEY REFERENCES app_container_items(id) ON DELETE CASCADE,
    cena_waluta    NUMERIC(14,4),        -- cena w walucie płatności / szt (dostawa krajowa: PLN / szt)
    stawka_cla     NUMERIC(5,2),         -- % — wyjątek tylko dla tej pozycji, słownika nie zmienia
    zapisal        TEXT,
    zapisano       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Słownik kod CN → stawka cła (%). Zasilany z zapisanych odpraw (najnowsza stawka dla kodu),
-- poprawiany ręcznie przez superadmina. Ręczna stawka nie jest nadpisywana przez SAD.
CREATE TABLE IF NOT EXISTS app_stawki_cn (
    kod_cn         VARCHAR(10) PRIMARY KEY,   -- same cyfry, jak app_product_attrs.kod_cn
    stawka         NUMERIC(5,2) NOT NULL CHECK (stawka >= 0 AND stawka <= 100),
    zrodlo         TEXT NOT NULL DEFAULT 'sad' CHECK (zrodlo IN ('sad', 'reczna')),
    zmienil        TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Zasilenie słownika z już zapisanych odpraw: dla każdego kodu stawka z najnowszego zgłoszenia.
INSERT INTO app_stawki_cn (kod_cn, stawka, zrodlo, zmienil, updated_at)
SELECT DISTINCT ON (p.kod_cn) p.kod_cn, p.clo_stawka, 'sad', 'SAD ' || COALESCE(o.mrn, ''), NOW()
  FROM app_odprawa_pozycje p
  JOIN app_odprawy o ON o.id = p.odprawa_id
 WHERE p.kod_cn IS NOT NULL AND p.kod_cn <> '' AND p.clo_stawka IS NOT NULL
 ORDER BY p.kod_cn, o.data_zgloszenia DESC NULLS LAST, o.id DESC
ON CONFLICT (kod_cn) DO UPDATE
   SET stawka = EXCLUDED.stawka, zmienil = EXCLUDED.zmienil, updated_at = NOW()
 WHERE app_stawki_cn.zrodlo = 'sad';
