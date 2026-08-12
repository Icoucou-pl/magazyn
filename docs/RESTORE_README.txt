MAGAZYN-PROD - DISASTER RECOVERY

CO JEST W PACZCE
================

Najważniejsze:
- roles.sql
- schema.sql
- data.sql

Dodatkowo:
- history_schema.sql / history_data.sql
- auth_storage_changes.sql
- platform_config/*.json
- functions-list.txt
- edge_functions/ (jeśli istnieją)
- edge-function-secrets-list.txt (TYLKO nazwy/digesty, bez wartości secretów)
- storage-list.txt
- storage_files/ (jeżeli wykryto fizyczne pliki Supabase Storage)
- VERIFY.txt / VERIFY.json
- SHA256SUMS.txt

W obecnej aplikacji załączniki kontenerów są zapisane bezpośrednio
w PostgreSQL w public.app_container_attachments.file_data (bytea),
więc wracają razem z data.sql.

SZYBKI RESTORE
==============

1. Utwórz nowy pusty projekt Supabase.
2. W Supabase -> Connect skopiuj Session Pooler connection string.
3. Pobierz ZIP z GitHub Actions i rozpakuj katalog backup.
4. Na Windows z działającym Docker Desktop uruchom:

   powershell -ExecutionPolicy Bypass -File scripts/restore_supabase.ps1 `
     -BackupDir "C:\sciezka\do\backup" `
     -NewDbUrl "postgresql://..."

5. Zweryfikuj w nowym Supabase:
   - tabele public,
   - auth.users,
   - public.app_container_attachments,
   - sellasist_*, fakturownia_stock, subiekt_dwa_magazyny.

6. W nowym Railway podłącz repo GitHub aplikacji.
7. Skopiuj Railway Variables i podmień DB_HOST / DB_NAME / DB_USER /
   DB_PASSWORD / DB_PORT na dane nowego Supabase.
8. Start Command Railway:

   uvicorn main:app --host 0.0.0.0 --port $PORT

9. Wygeneruj nową domenę Railway i zaktualizuj ALLOWED_ORIGINS, jeśli trzeba.

UWAGI
=====

- Wartości Edge Function secrets nie są możliwe do pobrania przez `supabase secrets list`.
  Jeżeli w przyszłości pojawią się Edge Functions, ich sekretne wartości trzeba mieć
  również w osobnym bezpiecznym miejscu.
- platform_config/*.json jest snapshotem konfiguracji do weryfikacji przy odtwarzaniu.
- Nie commituj żadnego backup ZIP ani plików SQL z danymi produkcyjnymi do repozytorium.
