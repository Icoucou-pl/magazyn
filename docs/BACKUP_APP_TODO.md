# TODO: pokazanie statusu backupu w aplikacji

Ten plik jest informacją dla osoby / AI rozwijającej aplikację po wrzuceniu mechanizmu backupu.

## Stan obecny

Automatyczny backup Supabase jest wykonywany przez GitHub Actions. Po każdym runie skrypt `scripts/log_backup_status.py` zapisuje rekord do istniejącej tabeli:

`public.app_sync_log`

z:

- `source = 'supabase_backup'`,
- `ok = true/false`,
- `started_at`,
- `finished_at`,
- `message`,
- `error`.

Przykładowy `message` po sukcesie:

`Backup gotowy: supabase-magazyn-prod-2026-08-13_07-00-00; 81.4 MB; public=34; auth_users=...; attachments=84/84; storage_objects=0`

## Co trzeba zrobić w aplikacji

### 1. Backend

Dodać endpoint administracyjny, np.:

`GET /api/admin/backup-status`

Powinien pobierać najnowszy rekord:

```sql
SELECT id, source, started_at, finished_at, ok, message, error
FROM public.app_sync_log
WHERE source = 'supabase_backup'
ORDER BY finished_at DESC NULLS LAST, started_at DESC
LIMIT 1;
```

Opcjonalnie dodać historię:

`GET /api/admin/backup-history?limit=30`

### 2. Frontend

W panelu administracyjnym dodać kartę **Backup bazy**:

- zielony status `OK`, jeśli ostatni `ok = true`,
- czerwony status `BŁĄD`, jeśli `ok = false`,
- data i godzina ostatniego backupu,
- tekst `message`,
- `error` przy błędzie.

Przykład:

```
Backup bazy                 ● OK
Ostatni backup: 13.08.2026 07:04
Rozmiar: 81.4 MB
Tabele: 34
Załączniki: 84/84
```

### 3. Ostrzeżenie o starym backupie

Jeśli ostatni poprawny backup jest starszy niż np. **26 godzin**, karta powinna pokazać ostrzeżenie:

`Backup jest nieaktualny — ostatnia poprawna kopia ma ponad 26 godzin.`

### 4. Uprawnienia

Status backupu powinien być widoczny tylko dla administratora / superadmina.

### 5. Nie pobieramy ZIP przez aplikację

Na pierwszym etapie aplikacja tylko pokazuje status. Sam backup ZIP pozostaje w GitHub Actions Artifacts. Nie dodawać tokenu GitHub do frontendu.

## Kryteria zakończenia

- [ ] Endpoint najnowszego backupu działa.
- [ ] Karta w panelu admin pokazuje OK/BŁĄD.
- [ ] Widać datę ostatniego backupu.
- [ ] Widać komunikat i błąd.
- [ ] Jest ostrzeżenie, jeśli brak poprawnego backupu przez >26 h.
- [ ] Widok jest dostępny tylko dla administratora.
