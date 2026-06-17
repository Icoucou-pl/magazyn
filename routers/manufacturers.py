"""Producenci - CRUD."""

from typing import List

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import ManufacturerIn, ManufacturerOut

router = APIRouter(prefix="/api", tags=["manufacturers"])


@router.get("/manufacturers", response_model=List[ManufacturerOut])
async def list_manufacturers(db: AsyncSession = Depends(get_db)):
    r = await db.execute(text(f"""
        SELECT m.id, m.name, m.color, m.notes, m.email, m.contact,
            (SELECT COUNT(*) FROM {settings.TABLE_PRODUCT_ATTRS} pa WHERE pa.manufacturer_id = m.id) AS sku_count,
            (SELECT COUNT(*) FROM {settings.TABLE_CONTAINERS} c WHERE c.manufacturer_id = m.id AND c.status <> 'DELIVERED') AS open_orders
        FROM {settings.TABLE_MANUFACTURERS} m
        ORDER BY m.name
    """))
    return [ManufacturerOut(**dict(row._mapping)) for row in r]


@router.post("/manufacturers", response_model=ManufacturerOut, status_code=201)
async def create_manufacturer(payload: ManufacturerIn, db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        text(f"INSERT INTO {settings.TABLE_MANUFACTURERS} (name, color, notes, email, contact) VALUES (:n, :c, :no, :e, :ct) RETURNING id"),
        {"n": payload.name, "c": payload.color, "no": payload.notes, "e": payload.email, "ct": payload.contact}
    )
    new_id = r.scalar_one()
    await db.commit()
    return ManufacturerOut(id=new_id, **payload.model_dump())


@router.patch("/manufacturers/{mid}", response_model=ManufacturerOut)
async def update_manufacturer(mid: int, payload: ManufacturerIn, db: AsyncSession = Depends(get_db)):
    await db.execute(
        text(f"UPDATE {settings.TABLE_MANUFACTURERS} SET name=:n, color=:c, notes=:no, email=:e, contact=:ct WHERE id=:id"),
        {"n": payload.name, "c": payload.color, "no": payload.notes, "e": payload.email, "ct": payload.contact, "id": mid}
    )
    await db.commit()
    return ManufacturerOut(id=mid, **payload.model_dump())


@router.delete("/manufacturers/{mid}", status_code=204)
async def delete_manufacturer(mid: int, db: AsyncSession = Depends(get_db)):
    r = await db.execute(text(f"DELETE FROM {settings.TABLE_MANUFACTURERS} WHERE id=:id"), {"id": mid})
    await db.commit()
    if r.rowcount == 0:
        raise HTTPException(404)
