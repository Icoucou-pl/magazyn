#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "ok"}


def main() -> int:
    token = (os.getenv("SUPABASE_ACCESS_TOKEN") or "").strip()
    project_ref = (os.getenv("SUPABASE_PROJECT_REF") or "").strip()

    if not token:
        raise RuntimeError("Brak SUPABASE_ACCESS_TOKEN")
    if not project_ref:
        raise RuntimeError("Brak SUPABASE_PROJECT_REF")

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

    # Korzystamy z Management API, więc nie potrzebujemy osobnego DB URL ani psycopg.
    # Endpoint przyjmuje SQL i tablicę parametrów.
    sql = """
        INSERT INTO public.app_sync_log
            (source, started_at, finished_at, ok, inserted, updated, items_added, message, error)
        VALUES
            ($1, NOW(), NOW(), $2, 0, 0, 0, $3, $4)
    """

    payload = {
        "query": sql,
        "parameters": [
            "supabase_backup",
            ok,
            message,
            error_value,
        ],
        "read_only": False,
    }

    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status not in (200, 201):
                raise RuntimeError(f"Management API HTTP {resp.status}: {body}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Management API HTTP {exc.code}: {body}") from exc

    print(f"app_sync_log zapisany przez Management API: ok={ok}, artifact={artifact}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR app_sync_log: {exc}", file=sys.stderr)
        raise SystemExit(1)
