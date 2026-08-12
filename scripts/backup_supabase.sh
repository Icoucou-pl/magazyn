#!/usr/bin/env bash
set -Eeuo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Brak wymaganej zmiennej: $name" >&2
    exit 2
  fi
}

for var in SUPABASE_DB_URL SUPABASE_DB_PASSWORD SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF; do
  require_env "$var"
done

STAMP="$(TZ=Europe/Warsaw date +'%Y-%m-%d_%H-%M-%S')"
ARTIFACT_NAME="supabase-magazyn-prod-${STAMP}"
WORK_ROOT="${RUNNER_TEMP:-/tmp}/$ARTIFACT_NAME"
BACKUP_DIR="$WORK_ROOT/backup"
LINK_DIR="$WORK_ROOT/link"
ZIP_PATH="${RUNNER_TEMP:-/tmp}/${ARTIFACT_NAME}.zip"
ERROR_FILE="$WORK_ROOT/error.txt"

mkdir -p "$BACKUP_DIR" "$LINK_DIR"

write_output() {
  local key="$1"
  local value="${2:-}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    value="${value//$'\n'/ }"
    value="${value//$'\r'/ }"
    echo "$key=$value" >> "$GITHUB_OUTPUT"
  fi
}

on_error() {
  local rc=$?
  local line="${BASH_LINENO[0]:-?}"
  local msg="Backup failed (exit=$rc, line=$line)"
  echo "$msg" | tee "$ERROR_FILE" >&2
  write_output "error_message" "$msg"
  exit "$rc"
}
trap on_error ERR

write_output "artifact_name" "$ARTIFACT_NAME"
write_output "zip_path" "$ZIP_PATH"
write_output "error_message" ""

{
  echo "Backup start: $(TZ=Europe/Warsaw date --iso-8601=seconds)"
  echo "Project ref: $SUPABASE_PROJECT_REF"
  echo "Supabase CLI: $(supabase --version)"
  echo "Docker: $(docker --version)"
} | tee "$BACKUP_DIR/RUN_INFO.txt"

# 1. Core logical backup - taki sam zestaw, który został ręcznie przetestowany przy restore.
echo "[1/8] roles.sql"
supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  -f "$BACKUP_DIR/roles.sql" \
  --role-only

echo "[2/8] schema.sql"
supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  -f "$BACKUP_DIR/schema.sql"

echo "[3/8] data.sql"
supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  -f "$BACKUP_DIR/data.sql" \
  --data-only \
  --use-copy \
  -x "storage.buckets_vectors" \
  -x "storage.vector_indexes"

# 2. Historia migracji - może być pusta, ale zachowujemy ją w paczce.
echo "[4/8] supabase_migrations"
supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  -f "$BACKUP_DIR/history_schema.sql" \
  --schema supabase_migrations || true

supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  -f "$BACKUP_DIR/history_data.sql" \
  --schema supabase_migrations \
  --data-only \
  --use-copy || true

# 3. Weryfikacja dumpa i wyciągnięcie liczników/bucketów.
echo "[5/8] verify"
python3 "${GITHUB_WORKSPACE:-$(pwd)}/scripts/verify_supabase_backup.py" \
  --backup-dir "$BACKUP_DIR"

PUBLIC_TABLES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_copy_sections"])' "$BACKUP_DIR/VERIFY.json")"
AUTH_USERS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["auth_users"])' "$BACKUP_DIR/VERIFY.json")"
ATTACHMENTS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["attachments"])' "$BACKUP_DIR/VERIFY.json")"
ATTACHMENTS_WITH_DATA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["attachments_with_file_data"])' "$BACKUP_DIR/VERIFY.json")"
STORAGE_OBJECTS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["storage_objects"])' "$BACKUP_DIR/VERIFY.json")"

write_output "public_tables" "$PUBLIC_TABLES"
write_output "auth_users" "$AUTH_USERS"
write_output "attachments" "$ATTACHMENTS"
write_output "attachments_with_data" "$ATTACHMENTS_WITH_DATA"
write_output "storage_objects" "$STORAGE_OBJECTS"

# 4. Link do projektu - potrzebny do auth/storage diff, Functions i Storage API.
echo "[6/8] platform extras"
pushd "$LINK_DIR" >/dev/null
supabase init >/dev/null
supabase link --project-ref "$SUPABASE_PROJECT_REF" >/dev/null

# Custom zmiany managed schemas. W obecnym projekcie wynik był pusty,
# ale zapisujemy go codziennie, żeby przyszła zmiana nie zginęła.
if ! supabase db diff --linked --schema auth,storage > "$BACKUP_DIR/auth_storage_changes.sql"; then
  echo "WARNING: db diff auth/storage nie powiódł się" | tee -a "$BACKUP_DIR/WARNINGS.txt"
  : > "$BACKUP_DIR/auth_storage_changes.sql"
fi

# Snapshot konfiguracji platformy przez Management API.
mkdir -p "$BACKUP_DIR/platform_config"
api_get() {
  local endpoint="$1"
  local output="$2"
  local code
  code="$(curl -sS -o "$output" -w '%{http_code}' \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com${endpoint}" || true)"
  if [[ "$code" != "200" ]]; then
    echo "WARNING: Management API ${endpoint} -> HTTP ${code}" | tee -a "$BACKUP_DIR/WARNINGS.txt"
  fi
}

api_get "/v1/projects/${SUPABASE_PROJECT_REF}/config/auth" "$BACKUP_DIR/platform_config/auth.json"
api_get "/v1/projects/${SUPABASE_PROJECT_REF}/config/storage" "$BACKUP_DIR/platform_config/storage.json"
api_get "/v1/projects/${SUPABASE_PROJECT_REF}/postgrest" "$BACKUP_DIR/platform_config/postgrest.json"
api_get "/v1/projects/${SUPABASE_PROJECT_REF}/config/database/postgres" "$BACKUP_DIR/platform_config/postgres.json"

# Edge Functions: kod + lista. Obecnie projekt nie ma Functions, ale backup jest future-proof.
supabase functions list --project-ref "$SUPABASE_PROJECT_REF" > "$BACKUP_DIR/functions-list.txt" 2>&1 || true
mkdir -p "$BACKUP_DIR/edge_functions"
pushd "$BACKUP_DIR/edge_functions" >/dev/null
supabase init >/dev/null
supabase functions download --project-ref "$SUPABASE_PROJECT_REF" --use-api \
  > "$BACKUP_DIR/functions-download.log" 2>&1 || true
popd >/dev/null

# Supabase nie zwraca wartości Edge Function secrets; zapisujemy nazwy/digesty.
supabase secrets list --project-ref "$SUPABASE_PROJECT_REF" \
  > "$BACKUP_DIR/edge-function-secrets-list.txt" 2>&1 || true
cat > "$BACKUP_DIR/EDGE_FUNCTION_SECRETS_NOTE.txt" <<'TXT'
Supabase CLI listuje nazwy/digesty Edge Function secrets, ale nie zwraca ich wartości.
Jeżeli kiedykolwiek pojawią się tu sekrety, ich wartości trzeba przechowywać osobno
(np. w bezpiecznym password managerze / GitHub Secrets) i odtworzyć ręcznie.
W momencie wdrożenia tego backupu projekt magazyn-prod nie posiadał Edge Functions ani ich secrets.
TXT

# Storage: metadane są w data.sql. Jeśli pojawią się fizyczne obiekty,
# pobieramy każdy bucket do paczki.
supabase storage ls -r --linked --experimental \
  > "$BACKUP_DIR/storage-list.txt" 2>&1 || true

if [[ "$STORAGE_OBJECTS" -gt 0 ]]; then
  echo "Wykryto $STORAGE_OBJECTS obiektów Supabase Storage - pobieram buckety."
  mkdir -p "$BACKUP_DIR/storage_files"
  while IFS= read -r bucket; do
    [[ -z "$bucket" ]] && continue
    mkdir -p "$BACKUP_DIR/storage_files/$bucket"
    supabase storage cp -r "ss://$bucket" "$BACKUP_DIR/storage_files/$bucket" \
      --linked --experimental
  done < <(python3 -c 'import json,sys; [print(x) for x in json.load(open(sys.argv[1])).get("storage_buckets", [])]' "$BACKUP_DIR/VERIFY.json")
fi

popd >/dev/null

# 5. Instrukcja restore jest kopiowana do każdej paczki.
cp "${GITHUB_WORKSPACE:-$(pwd)}/docs/RESTORE_README.txt" "$BACKUP_DIR/RESTORE_README.txt"

# 6. Sumy kontrolne.
echo "[7/8] checksums"
pushd "$BACKUP_DIR" >/dev/null
find . -type f ! -name 'SHA256SUMS.txt' -print0 \
  | sort -z \
  | xargs -0 sha256sum > SHA256SUMS.txt
popd >/dev/null

# 7. ZIP - jeden plik do pobrania z GitHub Actions.
echo "[8/8] zip"
pushd "$WORK_ROOT" >/dev/null
zip -q -r "$ZIP_PATH" backup
popd >/dev/null

SIZE_BYTES="$(stat -c%s "$ZIP_PATH")"
SIZE_MB="$(python3 -c 'import sys; print(round(int(sys.argv[1])/1024/1024, 2))' "$SIZE_BYTES")"

write_output "size_mb" "$SIZE_MB"
write_output "error_message" ""

{
  echo "Backup end: $(TZ=Europe/Warsaw date --iso-8601=seconds)"
  echo "Artifact: $ARTIFACT_NAME"
  echo "ZIP size MB: $SIZE_MB"
} >> "$BACKUP_DIR/RUN_INFO.txt"

echo "BACKUP OK: $ARTIFACT_NAME ($SIZE_MB MB)"
