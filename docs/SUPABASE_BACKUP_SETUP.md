# Automatyczny backup Supabase — konfiguracja

## Co zostało wdrożone

Repo zawiera workflow GitHub Actions uruchamiany codziennie o **07:00 Europe/Warsaw** oraz ręcznie przez `workflow_dispatch`.

Workflow:

1. wykonuje `roles.sql`, `schema.sql`, `data.sql`,
2. zapisuje historię `supabase_migrations`,
3. weryfikuje dump,
4. kontroluje `auth.users`, `app_container_attachments.file_data` i Storage,
5. zapisuje diff niestandardowych zmian `auth/storage`,
6. pobiera Edge Functions, jeśli się pojawią,
7. zapisuje snapshot wybranej konfiguracji Supabase Management API,
8. pobiera fizyczne pliki Storage, jeśli kiedyś pojawią się obiekty,
9. tworzy jeden ZIP,
10. publikuje ZIP jako prywatny GitHub Actions Artifact przez 30 dni,
11. zapisuje wynik do `public.app_sync_log` z `source = 'supabase_backup'`.

## Wymagane GitHub Secrets

Repozytorium powinno być **prywatne**.

Wejdź:

`GitHub -> repo -> Settings -> Secrets and variables -> Actions`

Dodaj sekrety:

### `SUPABASE_DB_URL`

Connection string produkcyjnego Supabase. Zalecany **Session Pooler** z `Connect` w Dashboardzie.

Hasło w URL musi być poprawnie URL-encoded, jeżeli zawiera znaki specjalne.

### `SUPABASE_DB_PASSWORD`

Samo hasło bazy produkcyjnego Supabase. Jest potrzebne do `supabase link` w CI.

### `SUPABASE_ACCESS_TOKEN`

Personal Access Token konta Supabase z dostępem do projektu. Potrzebny do Management API, Functions i Storage CLI.

## Wymagana GitHub Variable

W tej samej sekcji przejdź do **Variables** i dodaj:

`SUPABASE_PROJECT_REF = gpsnmfncsigofnnwiuxq`

Project ref nie jest hasłem.

## Pierwszy test

1. GitHub -> **Actions**.
2. Wybierz **Daily Supabase Disaster Recovery Backup**.
3. Kliknij **Run workflow**.
4. Poczekaj na zielony status.
5. Na stronie runa powinien pojawić się Artifact o nazwie podobnej do:

   `supabase-magazyn-prod-2026-08-12_12-00-00`

6. Pobierz go i sprawdź `VERIFY.txt`.
7. W bazie sprawdź:

```sql
select *
from public.app_sync_log
where source = 'supabase_backup'
order by finished_at desc
limit 10;
```

## Harmonogram

Workflow ma:

```yaml
schedule:
  - cron: "0 7 * * *"
    timezone: "Europe/Warsaw"
```

Czyli odpala się codziennie o 07:00 czasu polskiego, z uwzględnieniem zmiany czasu.

## Bezpieczeństwo

Nie dodawaj do repo:

- backupów `.zip`,
- `data.sql`,
- connection stringów,
- tokenów Supabase,
- Railway Variables,
- plików `.env` z sekretami.

Backup zawiera dane produkcyjne, dane Auth i binarne załączniki, dlatego dostęp do repo i GitHub Actions powinien być ograniczony.
