"""Kontenery: CRUD, oznaczanie dostarczenia, załączniki (metadane), eksport do XLSX."""

import io
import asyncio
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import OperationalError, InterfaceError

from config import settings
from database import get_db, SessionLocal
from models import (
    ContainerStatus, ContainerOut, ContainerCreate, ContainerUpdate,
    AttachmentOut, AttachmentCreate, CurrentUser,
)
from security import get_current_user, require_edit_containers, require_export, has_perm
from services.containers import fetch_containers, get_container_by_id

router = APIRouter(prefix="/api", tags=["containers"])


def _mask_container_financials(containers, user):
    """Serwerowe ukrycie cen w kontenerach dla usera bez viewFinancials."""
    if has_perm(user, "viewFinancials"):
        return containers
    for c in containers:
        c.total_value = 0.0
        for it in c.items:
            it.unit_cost = None
        for lot in c.lots:
            lot.total_value = 0.0
    return containers


async def _replace_lots(db: AsyncSession, cid: int, lots) -> List[int]:
    """Usuwa loty kontenera i wstawia nowe (po kolei). Zwraca listę nowych id w kolejności."""
    await db.execute(text(f"DELETE FROM {settings.TABLE_CONTAINER_LOTS} WHERE container_id = :c"), {"c": cid})
    ids: List[int] = []
    for pos, lot in enumerate(lots or []):
        rr = await db.execute(
            text(f"INSERT INTO {settings.TABLE_CONTAINER_LOTS} (container_id, manufacturer_id, order_number, position) VALUES (:c, :m, :o, :p) RETURNING id"),
            {"c": cid, "m": lot.manufacturer_id, "o": (lot.order_number or None), "p": pos},
        )
        ids.append(rr.scalar_one())
    return ids


def _resolve_lot(lot_ref: Optional[int], lot_ids: List[int]) -> Optional[int]:
    if lot_ref is None:
        return None
    if 0 <= lot_ref < len(lot_ids):
        return lot_ids[lot_ref]
    return None


@router.get("/containers/export/csv")
async def export_containers_xlsx(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_export)):
    """Eksport kontenerów do Excela (XLSX)."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    containers = await fetch_containers(db)

    wb = Workbook()
    ws = wb.active
    ws.title = "Kontenery"

    headers = [
        "Nr kontenera", "Nr zamówienia", "Producent", "Typ", "Status",
        "Data zamówienia", "ETA", "SKU", "Nazwa produktu",
        "Ilość", "Cena jednostkowa", "Wartość", "CBM total",
    ]
    ws.append(headers)

    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1c1917", end_color="1c1917", fill_type="solid")
    for col_idx, _ in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")

    status_label = {"ORDERED": "Zamówione", "IN_PRODUCTION": "W produkcji", "IN_TRANSIT": "W drodze", "CUSTOMS": "Odprawa celna", "DELIVERED": "Dostarczone"}

    for c in containers:
        lot_map = {l.id: (l.order_number, l.manufacturer_name) for l in c.lots}
        for it in c.items:
            cena = float(it.unit_cost) if it.unit_cost else 0
            wartosc = cena * it.quantity
            po, mfr = c.order_number, c.manufacturer_name
            if c.is_consolidated and it.lot_id in lot_map:
                po, mfr = lot_map[it.lot_id]
            ws.append([
                c.container_number, po or "",
                mfr or "", c.container_type_name or "",
                status_label.get(c.effective_status, c.effective_status),
                c.order_date.isoformat(), c.eta_date.isoformat(),
                it.sku, it.product_name or "",
                it.quantity, cena, wartosc, it.total_cbm,
            ])

    column_widths = [16, 16, 18, 8, 14, 14, 14, 12, 35, 8, 14, 14, 10]
    for i, width in enumerate(column_widths, 1):
        ws.column_dimensions[chr(64 + i)].width = width
    ws.freeze_panes = "A2"

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    filename = f"kontenery_{date.today().isoformat()}.xlsx"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@router.get("/containers", response_model=List[ContainerOut])
async def list_containers(status: Optional[ContainerStatus] = None, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    return _mask_container_financials(await fetch_containers(db, status), user)


@router.get("/containers/{cid}", response_model=ContainerOut)
async def get_container(cid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    c = await get_container_by_id(db, cid)
    _mask_container_financials([c], user)
    return c


@router.post("/containers", response_model=ContainerOut, status_code=201)
async def create_container(payload: ContainerCreate, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_edit_containers)):
    if payload.eta_date < payload.order_date:
        raise HTTPException(400, "ETA nie może być przed datą zamówienia")

    r = await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_CONTAINERS}
            (container_number, order_number, container_type_id, manufacturer_id, order_date, eta_date, status, notes, is_consolidated)
            VALUES (:n, :on, :tid, :mid, :od, :eta, :st, :no, :cons)
            RETURNING id
        """),
        {"n": payload.container_number,
         "on": (None if payload.is_consolidated else payload.order_number),
         "tid": payload.container_type_id,
         "mid": (None if payload.is_consolidated else payload.manufacturer_id),
         "od": payload.order_date, "eta": payload.eta_date,
         "st": payload.status, "no": payload.notes, "cons": payload.is_consolidated}
    )
    cid = r.scalar_one()

    lot_ids = await _replace_lots(db, cid, payload.lots) if payload.is_consolidated else []

    for item in payload.items:
        lid = _resolve_lot(item.lot_ref, lot_ids) if payload.is_consolidated else None
        await db.execute(
            text(f"INSERT INTO {settings.TABLE_CONTAINER_ITEMS} (container_id, sku, quantity, unit_cost, lot_id) VALUES (:c, :s, :q, :u, :l)"),
            {"c": cid, "s": item.sku, "q": item.quantity, "u": item.unit_cost, "l": lid}
        )

    await db.commit()
    return await get_container_by_id(db, cid)


@router.patch("/containers/{cid}", response_model=ContainerOut)
async def update_container(cid: int, payload: ContainerUpdate, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_edit_containers)):
    updates = []
    params = {"id": cid}
    for field in ["container_number", "container_type_id", "order_date", "eta_date", "status", "notes"]:
        v = getattr(payload, field)
        if v is not None:
            updates.append(f"{field} = :{field}")
            params[field] = v

    cons = payload.is_consolidated
    if cons is None:
        # częściowa aktualizacja bez informacji o konsolidacji — stare zachowanie
        for field in ["manufacturer_id", "order_number"]:
            v = getattr(payload, field)
            if v is not None:
                updates.append(f"{field} = :{field}")
                params[field] = v
    else:
        updates.append("is_consolidated = :cons")
        params["cons"] = cons
        if cons:
            updates.append("manufacturer_id = NULL")
            updates.append("order_number = NULL")
        else:
            updates.append("manufacturer_id = :mid")
            params["mid"] = payload.manufacturer_id
            updates.append("order_number = :onum")
            params["onum"] = payload.order_number

    if updates:
        updates.append("updated_at = CURRENT_TIMESTAMP")
        await db.execute(text(f"UPDATE {settings.TABLE_CONTAINERS} SET {', '.join(updates)} WHERE id = :id"), params)

    if payload.items is not None:
        await db.execute(text(f"DELETE FROM {settings.TABLE_CONTAINER_ITEMS} WHERE container_id = :cid"), {"cid": cid})
        # cons=True → wstaw przysłane loty; cons=False → wyczyść loty (sieroty nie zostają);
        # cons=None (częściowa aktualizacja) → ruszamy loty tylko gdy front je przysłał.
        use_lots = bool(cons) if cons is not None else (payload.lots is not None)
        rebuild = (cons is not None) or (payload.lots is not None)
        lot_ids = await _replace_lots(db, cid, payload.lots if use_lots else []) if rebuild else []
        for item in payload.items:
            lid = _resolve_lot(item.lot_ref, lot_ids) if use_lots else None
            await db.execute(
                text(f"INSERT INTO {settings.TABLE_CONTAINER_ITEMS} (container_id, sku, quantity, unit_cost, lot_id) VALUES (:c, :s, :q, :u, :l)"),
                {"c": cid, "s": item.sku, "q": item.quantity, "u": item.unit_cost, "l": lid}
            )
    elif payload.lots is not None:
        await _replace_lots(db, cid, payload.lots)

    await db.commit()
    return await get_container_by_id(db, cid)


@router.delete("/containers/{cid}", status_code=204)
async def delete_container(cid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_edit_containers)):
    r = await db.execute(text(f"DELETE FROM {settings.TABLE_CONTAINERS} WHERE id = :id"), {"id": cid})
    await db.commit()
    if r.rowcount == 0:
        raise HTTPException(404)


@router.post("/containers/{cid}/deliver", response_model=ContainerOut)
async def deliver_container(cid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_edit_containers)):
    await db.execute(text(f"UPDATE {settings.TABLE_CONTAINERS} SET status = 'DELIVERED', updated_at = CURRENT_TIMESTAMP WHERE id = :id"), {"id": cid})
    await db.commit()
    return await get_container_by_id(db, cid)


MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10 MB


def _human_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n} B"


def _guess_type(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "pdf":
        return "pdf"
    if ext in ("xlsx", "xls"):
        return "excel"
    if ext in ("png", "jpg", "jpeg", "webp", "gif"):
        return "image"
    return ext or "other"


@router.post("/containers/{cid}/attachments", response_model=AttachmentOut, status_code=201)
async def add_attachment(cid: int, file: UploadFile = File(...), user: CurrentUser = Depends(require_edit_containers)):
    """Wgrywa plik (zawartość w bazie jako BYTEA). Ponawia zapis na świeżym
    połączeniu przy chwilowych błędach poolера Supabase (działa za 1. razem)."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "Pusty plik")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(413, "Plik za duży (max 10 MB)")
    fname = file.filename or "plik"
    ftype = _guess_type(fname)
    fsize = _human_size(len(data))
    ctype = file.content_type or "application/octet-stream"
    params = {"c": cid, "n": fname, "t": ftype, "s": fsize, "ct": ctype, "d": data}
    sql = text(f"""
        INSERT INTO {settings.TABLE_ATTACHMENTS} (container_id, filename, file_type, file_size, content_type, file_data)
        VALUES (:c, :n, :t, :s, :ct, :d) RETURNING id, uploaded_at
    """)
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            async with SessionLocal() as db:
                r = await db.execute(sql, params)
                row = r.first()
                await db.commit()
                return AttachmentOut(id=row.id, filename=fname, file_type=ftype, file_size=fsize, uploaded_at=row.uploaded_at)
        except (OperationalError, InterfaceError) as e:
            last_err = e
            await asyncio.sleep(0.4 * (attempt + 1))
    raise HTTPException(503, f"Zapis załącznika nieudany po kilku próbach: {last_err}")


@router.get("/attachments/{aid}/download")
async def download_attachment(aid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Zwraca zawartość pliku załącznika."""
    r = await db.execute(text(f"SELECT filename, content_type, file_data FROM {settings.TABLE_ATTACHMENTS} WHERE id = :id"), {"id": aid})
    row = r.first()
    if not row or row.file_data is None:
        raise HTTPException(404, "Plik nie znaleziony (mógł być dodany przed włączeniem przechowywania)")
    data = bytes(row.file_data)
    ctype = row.content_type or "application/octet-stream"
    return StreamingResponse(io.BytesIO(data), media_type=ctype, headers={"Content-Disposition": f'attachment; filename="{row.filename}"'})


@router.delete("/attachments/{aid}", status_code=204)
async def delete_attachment(aid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_edit_containers)):
    r = await db.execute(text(f"DELETE FROM {settings.TABLE_ATTACHMENTS} WHERE id = :id"), {"id": aid})
    await db.commit()
    if r.rowcount == 0:
        raise HTTPException(404)
