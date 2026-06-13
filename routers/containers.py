"""Kontenery: CRUD, oznaczanie dostarczenia, załączniki (metadane), eksport do XLSX."""

import io
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import (
    ContainerStatus, ContainerOut, ContainerCreate, ContainerUpdate,
    AttachmentOut, AttachmentCreate,
)
from services.containers import fetch_containers, get_container_by_id

router = APIRouter(prefix="/api", tags=["containers"])


@router.get("/containers/export/csv")
async def export_containers_xlsx(db: AsyncSession = Depends(get_db)):
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

    status_label = {"ORDERED": "Zamówione", "IN_PRODUCTION": "W produkcji", "IN_TRANSIT": "W drodze", "DELIVERED": "Dostarczone"}

    for c in containers:
        for it in c.items:
            cena = float(it.unit_cost) if it.unit_cost else 0
            wartosc = cena * it.quantity
            ws.append([
                c.container_number, c.order_number or "",
                c.manufacturer_name or "", c.container_type_name or "",
                status_label.get(c.status, c.status),
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
async def list_containers(status: Optional[ContainerStatus] = None, db: AsyncSession = Depends(get_db)):
    return await fetch_containers(db, status)


@router.get("/containers/{cid}", response_model=ContainerOut)
async def get_container(cid: int, db: AsyncSession = Depends(get_db)):
    return await get_container_by_id(db, cid)


@router.post("/containers", response_model=ContainerOut, status_code=201)
async def create_container(payload: ContainerCreate, db: AsyncSession = Depends(get_db)):
    if payload.eta_date < payload.order_date:
        raise HTTPException(400, "ETA nie może być przed datą zamówienia")

    r = await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_CONTAINERS}
            (container_number, order_number, container_type_id, manufacturer_id, order_date, eta_date, status, notes)
            VALUES (:n, :on, :tid, :mid, :od, :eta, :st, :no)
            RETURNING id
        """),
        {"n": payload.container_number, "on": payload.order_number,
         "tid": payload.container_type_id, "mid": payload.manufacturer_id,
         "od": payload.order_date, "eta": payload.eta_date,
         "st": payload.status, "no": payload.notes}
    )
    cid = r.scalar_one()

    for item in payload.items:
        await db.execute(
            text(f"INSERT INTO {settings.TABLE_CONTAINER_ITEMS} (container_id, sku, quantity, unit_cost) VALUES (:c, :s, :q, :u)"),
            {"c": cid, "s": item.sku, "q": item.quantity, "u": item.unit_cost}
        )

    await db.commit()
    return await get_container_by_id(db, cid)


@router.patch("/containers/{cid}", response_model=ContainerOut)
async def update_container(cid: int, payload: ContainerUpdate, db: AsyncSession = Depends(get_db)):
    updates = []
    params = {"id": cid}
    for field in ["container_number", "order_number", "container_type_id", "manufacturer_id", "order_date", "eta_date", "status", "notes"]:
        v = getattr(payload, field)
        if v is not None:
            updates.append(f"{field} = :{field}")
            params[field] = v

    if updates:
        updates.append("updated_at = CURRENT_TIMESTAMP")
        await db.execute(text(f"UPDATE {settings.TABLE_CONTAINERS} SET {', '.join(updates)} WHERE id = :id"), params)

    if payload.items is not None:
        await db.execute(text(f"DELETE FROM {settings.TABLE_CONTAINER_ITEMS} WHERE container_id = :cid"), {"cid": cid})
        for item in payload.items:
            await db.execute(
                text(f"INSERT INTO {settings.TABLE_CONTAINER_ITEMS} (container_id, sku, quantity, unit_cost) VALUES (:c, :s, :q, :u)"),
                {"c": cid, "s": item.sku, "q": item.quantity, "u": item.unit_cost}
            )

    await db.commit()
    return await get_container_by_id(db, cid)


@router.delete("/containers/{cid}", status_code=204)
async def delete_container(cid: int, db: AsyncSession = Depends(get_db)):
    r = await db.execute(text(f"DELETE FROM {settings.TABLE_CONTAINERS} WHERE id = :id"), {"id": cid})
    await db.commit()
    if r.rowcount == 0:
        raise HTTPException(404)


@router.post("/containers/{cid}/deliver", response_model=ContainerOut)
async def deliver_container(cid: int, db: AsyncSession = Depends(get_db)):
    await db.execute(text(f"UPDATE {settings.TABLE_CONTAINERS} SET status = 'DELIVERED', updated_at = CURRENT_TIMESTAMP WHERE id = :id"), {"id": cid})
    await db.commit()
    return await get_container_by_id(db, cid)


@router.post("/containers/{cid}/attachments", response_model=AttachmentOut, status_code=201)
async def add_attachment(cid: int, payload: AttachmentCreate, db: AsyncSession = Depends(get_db)):
    """Dodaje metadane załącznika - bez prawdziwego uploadu pliku (lokalnie nie ma sensu)."""
    r = await db.execute(text(f"""
        INSERT INTO {settings.TABLE_ATTACHMENTS} (container_id, filename, file_type, file_size)
        VALUES (:c, :n, :t, :s) RETURNING id, uploaded_at
    """), {"c": cid, "n": payload.filename, "t": payload.file_type, "s": payload.file_size})
    row = r.first()
    await db.commit()
    return AttachmentOut(id=row.id, filename=payload.filename, file_type=payload.file_type, file_size=payload.file_size, uploaded_at=row.uploaded_at)


@router.delete("/attachments/{aid}", status_code=204)
async def delete_attachment(aid: int, db: AsyncSession = Depends(get_db)):
    r = await db.execute(text(f"DELETE FROM {settings.TABLE_ATTACHMENTS} WHERE id = :id"), {"id": aid})
    await db.commit()
    if r.rowcount == 0:
        raise HTTPException(404)
