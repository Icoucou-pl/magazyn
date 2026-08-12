#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path

COPY_RE = re.compile(r'^COPY "([^"]+)"\."([^"]+)" \((.*)\) FROM stdin;$')
COL_RE = re.compile(r'"([^"]+)"')


def parse_copy_sections(path: Path):
    sections = {}
    current = None
    columns = []

    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.rstrip("\n\r")
            if current is None:
                match = COPY_RE.match(line)
                if match:
                    schema, table, cols = match.groups()
                    current = (schema, table)
                    columns = COL_RE.findall(cols)
                    sections.setdefault(current, {"columns": columns, "rows": 0, "sample": [], "bucket_names": []})
                continue

            if line == r"\.":
                current = None
                columns = []
                continue

            sec = sections[current]
            sec["rows"] += 1

            values = line.split("\t")
            if len(sec["sample"]) < 2:
                sec["sample"].append(values[: min(4, len(values))])

            if current == ("storage", "buckets"):
                try:
                    name_idx = columns.index("name")
                    if name_idx < len(values) and values[name_idx] not in (r"\N", ""):
                        sec["bucket_names"].append(values[name_idx])
                except ValueError:
                    pass

            if current == ("public", "app_container_attachments"):
                try:
                    data_idx = columns.index("file_data")
                    if data_idx < len(values) and values[data_idx] not in (r"\N", ""):
                        sec["with_file_data"] = sec.get("with_file_data", 0) + 1
                except ValueError:
                    pass

    return sections


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backup-dir", required=True)
    args = ap.parse_args()

    root = Path(args.backup_dir)
    roles = root / "roles.sql"
    schema = root / "schema.sql"
    data = root / "data.sql"

    missing = [str(p.name) for p in (roles, schema, data) if not p.exists()]
    if missing:
        raise SystemExit(f"Brak plikow backupu: {', '.join(missing)}")

    if schema.stat().st_size == 0:
        raise SystemExit("schema.sql jest pusty")
    if data.stat().st_size == 0:
        raise SystemExit("data.sql jest pusty")

    sections = parse_copy_sections(data)
    public_sections = sorted([table for (schema_name, table) in sections if schema_name == "public"])

    auth_users = sections.get(("auth", "users"), {}).get("rows", 0)
    attachments = sections.get(("public", "app_container_attachments"), {}).get("rows", 0)
    attachments_with_data = sections.get(("public", "app_container_attachments"), {}).get("with_file_data", 0)
    storage_objects = sections.get(("storage", "objects"), {}).get("rows", 0)
    storage_buckets = sorted(set(sections.get(("storage", "buckets"), {}).get("bucket_names", [])))

    errors = []
    if len(public_sections) == 0:
        errors.append("Brak tabel public w data.sql")
    if ("auth", "users") not in sections:
        errors.append("Brak sekcji auth.users w data.sql")
    if ("public", "app_container_attachments") not in sections:
        errors.append("Brak sekcji app_container_attachments w data.sql")
    if attachments > 0 and attachments_with_data != attachments:
        errors.append(
            f"Nie wszystkie attachmenty maja file_data: {attachments_with_data}/{attachments}"
        )

    report = {
        "roles_bytes": roles.stat().st_size,
        "schema_bytes": schema.stat().st_size,
        "data_bytes": data.stat().st_size,
        "public_copy_sections": len(public_sections),
        "public_tables": public_sections,
        "auth_users": auth_users,
        "attachments": attachments,
        "attachments_with_file_data": attachments_with_data,
        "storage_objects": storage_objects,
        "storage_buckets": storage_buckets,
        "errors": errors,
        "ok": not errors,
    }

    (root / "VERIFY.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    txt = [
        "SUPABASE BACKUP VERIFY",
        "",
        f"OK: {report['ok']}",
        f"roles.sql: {report['roles_bytes']} bytes",
        f"schema.sql: {report['schema_bytes']} bytes",
        f"data.sql: {report['data_bytes']} bytes",
        f"PUBLIC COPY sections: {report['public_copy_sections']}",
        f"auth.users rows: {report['auth_users']}",
        f"attachments rows: {report['attachments']}",
        f"attachments with file_data: {report['attachments_with_file_data']}",
        f"storage.objects rows: {report['storage_objects']}",
        f"storage buckets: {', '.join(report['storage_buckets']) if report['storage_buckets'] else '(none)'}",
    ]
    if errors:
        txt += ["", "ERRORS:"] + [f"- {e}" for e in errors]
    (root / "VERIFY.txt").write_text("\n".join(txt) + "\n", encoding="utf-8")

    print("\n".join(txt))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
