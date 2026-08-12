#!/usr/bin/env python3
import os
from datetime import datetime, timezone

import psycopg


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "ok"}


def main():
    db_url = os.environ["SUPABASE_DB_URL"]
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

    now = datetime.now(timezone.utc)

    sql = """
        INSERT INTO public.app_sync_log
            (source, started_at, finished_at, ok, inserted, updated, items_added, message, error)
        VALUES
            (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """

    with psycopg.connect(db_url, connect_timeout=20) as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                (
                    "supabase_backup",
                    now,
                    now,
                    ok,
                    0,
                    0,
                    0,
                    message,
                    error_value,
                ),
            )
        conn.commit()

    print(f"app_sync_log zapisany: ok={ok}, artifact={artifact}")


if __name__ == "__main__":
    main()
