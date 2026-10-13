-- Zakładka „Pliki”: prywatny bucket w Supabase Storage + dostęp tylko dla technicznego konta.
-- Puścić w Supabase (SQL Editor) PRZED wdrożeniem albo zaraz po — bez tego zakładka działa,
-- ale nie da się wgrywać plików (a karta kontenera zapisuje po staremu do bazy).
-- Idempotentny: można puścić drugi raz.
--
-- Tabele app_pliki_foldery / app_pliki zakłada sama aplikacja przy starcie (lifespan.py).
--
-- KROK 1 (ręcznie, przed tym plikiem): Supabase → Authentication → Users → „Add user”
--   e-mail:  pliki@magazyn.local      (nie musi istnieć naprawdę)
--   hasło:   długie, losowe
--   zaznacz „Auto Confirm User”.
-- KROK 2: ten plik.
-- KROK 3: Railway → usługa backendu → Variables:
--   PLIKI_STORAGE_EMAIL=pliki@magazyn.local
--   PLIKI_STORAGE_PASSWORD=<hasło z kroku 1>
--   (adres projektu i klucz anon są już ustawione dla etykiet dropów — DROPY_STORAGE_URL/_ANON_KEY)
--
-- Dlaczego osobne konto, a nie klucz service_role: wyciek tych danych daje dostęp tylko do tego
-- jednego bucketu, a nie do całej bazy i reszty projektu (tak samo zrobione są etykiety dropów).

-- Bucket: prywatny (bez publicznych linków), limit 50 MB na plik.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('magazyn-pliki', 'magazyn-pliki', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;

-- Reguły: techniczne konto czyta, dodaje i kasuje pliki — wyłącznie w tym buckecie.
DROP POLICY IF EXISTS "magazyn-pliki odczyt" ON storage.objects;
CREATE POLICY "magazyn-pliki odczyt" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'magazyn-pliki' AND auth.jwt() ->> 'email' = 'pliki@magazyn.local');

DROP POLICY IF EXISTS "magazyn-pliki zapis" ON storage.objects;
CREATE POLICY "magazyn-pliki zapis" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'magazyn-pliki' AND auth.jwt() ->> 'email' = 'pliki@magazyn.local');

DROP POLICY IF EXISTS "magazyn-pliki usuwanie" ON storage.objects;
CREATE POLICY "magazyn-pliki usuwanie" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'magazyn-pliki' AND auth.jwt() ->> 'email' = 'pliki@magazyn.local');
