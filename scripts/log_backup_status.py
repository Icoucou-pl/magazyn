#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "ok"}


def main() -> int:
    project_ref = (os.getenv("SUPABASE_PROJECT_REF") or "").strip()
    secret_key = (os.getenv("SUPABASE_SECRET_KEY") or "").strip()

    if not project_ref:
        raise RuntimeError("Brak SUPABASE_PROJECT_REF")
    if not secret_key:
        raise RuntimeError("Brak SUPABASE_SECRET_KEY")

    ok = truthy(os.getenv("BACKUP_OK"))
    artifact = os.getenv("BACKUP_ARTIFACT") or ""
    size_mb = os.getenv("BACKUP_SIZE_MB") or "0"
    public_tables = os.getenv("BACKUP_PUBLIC_TABLES") or "0"
    auth_users = os.getenv("BACKUP_AUTH_USERS") or "0"
    attachments = os.getenv("BACKUP_ATTACHMENTS") or "0"
    attachments_with_data = os.getenv("BACKUP_ATTACHMENTS_WITH_DATA") or "0"
    storage_objects = os.getenv("BACKUP_STORAGE_OBJECTS") or "0"
    error = (os.getenv("BACKUP_ERROR") or "").strip()

    if ok:
        message = (
            f"Backup gotowy: {artifact}; {size_mb} MB; "
            f"public={public_tables}; auth_users={auth_users}; "
            f"attachments={attachments}/{attachments_with_data}; "
            f"storage_objects={storage_objects}"
        )
        error_value = None
    else:
        message = "Backup Supabase nie powiodl sie"
        error_value = error or f"GitHub Actions exit code: {os.getenv('BACKUP_EXIT_CODE', '?')}"

    payload = {
        "source": "supabase_backup",
        "started_at": "now()",
        "finished_at": "now()",
        "ok": ok,
        "inserted": 0,
        "updated": 0,
        "items_added": 0,
        "message": message,
        "error": error_value,
    }

    # Nie wysyłamy "now()" jako tekstu do timestampów.
    # PostgREST nie interpretuje SQL w JSON, więc timestampy pomijamy,
    # jeśli tabela ma default; jeśli nie ma, używamy czasu UTC z Pythona.
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    payload["started_at"] = now
    payload["finished_at"] = now

    url = f"https://{project_ref}.supabase.co/rest/v1/app_sync_log"

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "apikey": secret_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Prefer": "return=minimal",
            "User-Agent": "magazyn-backup-github-action/1.0",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status not in (200, 201, 204):
                raise RuntimeError(f"Data API HTTP {resp.status}: {body}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Data API HTTP {exc.code}: {body}") from exc

    print(f"app_sync_log zapisany przez Supabase Data API: ok={ok}, artifact={artifact}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR app_sync_log: {exc}", file=sys.stderr)
        raise SystemExit(1)
