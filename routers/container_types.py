"""Typy kontenerów - CRUD."""

from typing import List

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import ContainerTypeIn, ContainerTypeOut

router = APIRouter(prefix="/api", tags=["container-types"])


@router.get("/container-types", response_model=List[ContainerTypeOut])
async def list_container_types(db: AsyncSession = Depends(get_db)):
    r = await db.execute(text(f"SELECT id, name, capacity_cbm, sort_order FROM {settings.TABLE_CONTAINER_TYPES} ORDER BY sort_order, name"))
    return [ContainerTypeOut(id=row._mapping["id"], name=row._mapping["name"],
                             capacity_cbm=float(row._mapping["capacity_cbm"]),
                             sort_order=row._mapping["sort_order"]) for row in r]


@router.post("/container-types", response_model=ContainerTypeOut, status_code=201)
async def create_container_type(payload: ContainerTypeIn, db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        text(f"INSERT INTO {settings.TABLE_CONTAINER_TYPES} (name, capacity_cbm, sort_order) VALUES (:n, :c, :s) RETURNING id"),
        {"n": payload.name, "c": payload.capacity_cbm, "s": payload.sort_order}
    )
    new_id = r.scalar_one()
    await db.commit()
    return ContainerTypeOut(id=new_id, **payload.model_dump())


@router.patch("/container-types/{tid}", response_model=ContainerTypeOut)
async def update_container_type(tid: int, payload: ContainerTypeIn, db: AsyncSession = Depends(get_db)):
    await db.execute(
        text(f"UPDATE {settings.TABLE_CONTAINER_TYPES} SET name=:n, capacity_cbm=:c, sort_order=:s WHERE id=:id"),
        {"n": payload.name, "c": payload.capacity_cbm, "s": payload.sort_order, "id": tid}
    )
    await db.commit()
    return ContainerTypeOut(id=tid, **payload.model_dump())


@router.delete("/container-types/{tid}", status_code=204)
async def delete_container_type(tid: int, db: AsyncSession = Depends(get_db)):
    r = await db.execute(text(f"DELETE FROM {settings.TABLE_CONTAINER_TYPES} WHERE id=:id"), {"id": tid})
    await db.commit()
    if r.rowcount == 0:
        raise HTTPException(404)
