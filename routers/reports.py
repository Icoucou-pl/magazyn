"""Raporty: snapshoty KPI/stanów + raport miesięczny (dane + XLSX).

Snapshoty zbierane są automatycznie 2× dziennie (patrz lifespan._snapshot_loop).
Tu tylko odczyt + ręczne wywołanie zapisu i eksport do Excela.
"""
from datetime import date, datetime
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import CurrentUser
from security import get_current_user, has_perm
from services.snapshots import store_snapshot, SLOTS

router = APIRouter(prefix="/api", tags=["reports"])

KPI_FIELDS = [
    ("kapital_pln", "Kapitał w towarze"),
    ("magazyn_pln", "Wartość magazynu"),
    ("magazyn_w_drodze_pln", "Magazyn w drodze"),
    ("kontenery_pln", "Kontenery w drodze"),
]


def _require_reports(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not has_perm(user, "viewReports"):
        raise HTTPException(403, "Brak uprawnienia do raportów")
    return user


def _month_bounds(month: str) -> tuple:
    """'2026-07' → (2026-07-01, 2026-07-31)."""
    try:
        y, m = month.split("-")
        first = date(int(y), int(m), 1)
    except Exception:
        raise HTTPException(400, "Miesiąc w formacie RRRR-MM")
    last = date(first.year + (first.month == 12), (first.month % 12) + 1, 1)
    return first, last


def _prev_month(month: str) -> str:
    first, _ = _month_bounds(month)
    p = date(first.year - (first.month == 1), 12 if first.month == 1 else first.month - 1, 1)
    return f"{p.year:04d}-{p.month:02d}"


async def _month_kpi(db: AsyncSession, month: str, scope: str) -> Optional[dict]:
    """Ostatni snapshot miesiąca dla danego zakresu = „stan na koniec miesiąca”."""
    first, nxt = _month_bounds(month)
    r = await db.execute(text(f"""
        SELECT snap_date, snap_slot, kapital_pln, magazyn_pln, magazyn_w_drodze_pln, kontenery_pln
        FROM {settings.TABLE_KPI_SNAPSHOTS}
        WHERE firma_slug = :f AND snap_date >= :a AND snap_date < :b
        ORDER BY snap_date DESC, CASE snap_slot WHEN 'wieczor' THEN 0 ELSE 1 END
        LIMIT 1
    """), {"f": scope, "a": first, "b": nxt})
    row = r.first()
    if not row:
        return None
    d = dict(row._mapping)
    d["snap_date"] = d["snap_date"].isoformat()
    for k, _ in KPI_FIELDS:
        d[k] = float(d[k] or 0)
    return d


@router.post("/reports/snapshot")
async def make_snapshot(slot: str = Query("wieczor"), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports)):
    """Ręczne wywołanie snapshotu (dorobienie/test). Idempotentne — nadpisuje wpis tej pory."""
    if slot not in SLOTS:
        raise HTTPException(400, f"Pora musi być jedną z: {', '.join(SLOTS)}")
    return await store_snapshot(db, slot)


@router.get("/reports/kpi")
async def kpi_series(
    date_from: str = Query("", alias="from"), date_to: str = Query("", alias="to"),
    scope: str = Query("all"), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports),
):
    """Seria snapshotów KPI (do wykresów i tabeli historii)."""
    where = ["firma_slug = :f"]
    params: dict = {"f": scope}
    if date_from:
        where.append("snap_date >= :a"); params["a"] = date_from
    if date_to:
        where.append("snap_date <= :b"); params["b"] = date_to
    r = await db.execute(text(f"""
        SELECT snap_date, snap_slot, kapital_pln, magazyn_pln, magazyn_w_drodze_pln, kontenery_pln, captured_at
        FROM {settings.TABLE_KPI_SNAPSHOTS}
        WHERE {' AND '.join(where)}
        ORDER BY snap_date ASC, CASE snap_slot WHEN 'rano' THEN 0 ELSE 1 END
    """), params)
    out = []
    for row in r:
        d = dict(row._mapping)
        d["snap_date"] = d["snap_date"].isoformat()
        d["captured_at"] = d["captured_at"].isoformat() if d["captured_at"] else None
        for k, _ in KPI_FIELDS:
            d[k] = float(d[k] or 0)
        out.append(d)
    return out


@router.get("/reports/monthly")
async def monthly(
    month: str = Query(...), scope: str = Query("all"), compare: bool = Query(True),
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports),
):
    """Raport miesięczny: KPI na koniec miesiąca (+ opcjonalne porównanie z poprzednim)."""
    cur = await _month_kpi(db, month, scope)
    prev = await _month_kpi(db, _prev_month(month), scope) if compare else None
    rows = []
    for key, label in KPI_FIELDS:
        c = cur[key] if cur else None
        p = prev[key] if prev else None
        delta = round(((c - p) / p) * 100, 1) if (c is not None and p) else None
        rows.append({"key": key, "label": label, "value": c, "prev": p, "delta_pct": delta})
    return {
        "month": month, "scope": scope, "compare": compare,
        "snapshot_date": cur["snap_date"] if cur else None,
        "has_data": cur is not None,
        "rows": rows,
    }


@router.get("/reports/monthly/xlsx")
async def monthly_xlsx(
    month: str = Query(...), scope: str = Query("all"), compare: bool = Query(True),
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports),
):
    """Raport miesięczny jako .xlsx (ten sam wzorzec co eksport produktów)."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    data = await monthly(month=month, scope=scope, compare=compare, db=db, user=user)
    wb = Workbook()
    ws = wb.active
    ws.title = f"Raport {month}"

    ws["A1"] = f"Raport miesięczny — {month}"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = f"Zakres: {scope.upper()}"
    ws["A2"].font = Font(color="808080")
    if data["snapshot_date"]:
        ws["A3"] = f"Stan na: {data['snapshot_date']}"
        ws["A3"].font = Font(color="808080")

    head = ["KPI", "Wartość (PLN)"] + (["Poprzedni miesiąc", "Zmiana %"] if compare else [])
    hrow = 5
    fill = PatternFill("solid", fgColor="1F3864")
    for i, h in enumerate(head, start=1):
        c = ws.cell(row=hrow, column=i, value=h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = fill
        c.alignment = Alignment(horizontal="center")

    for j, row in enumerate(data["rows"], start=hrow + 1):
        ws.cell(row=j, column=1, value=row["label"])
        ws.cell(row=j, column=2, value=row["value"]).number_format = "#,##0.00"
        if compare:
            ws.cell(row=j, column=3, value=row["prev"]).number_format = "#,##0.00"
            ws.cell(row=j, column=4, value=row["delta_pct"]).number_format = "0.0"

    ws.column_dimensions["A"].width = 26
    for col in ("B", "C", "D"):
        ws.column_dimensions[col].width = 18

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = f"raport_{month}_{scope}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
