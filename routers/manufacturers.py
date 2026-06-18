"""Producenci - CRUD."""

from typing import List

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, EXCLUDED_STATUS_FILTER
from database import get_db
from models import ManufacturerIn, ManufacturerOut, SeasonPoint

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


@router.get("/manufacturers/{mid}/sales-season", response_model=List[SeasonPoint])
async def manufacturer_sales_season(mid: int, db: AsyncSession = Depends(get_db)):
    """Sprzedaż miesięczna SKU producenta: od 1 stycznia ZESZŁEGO roku do dziś
    (pokrywa cały zeszły rok + bieżący rok do teraz — pod wykres kalendarzowy Sty–Gru).
    Zwraca po jednym punkcie na miesiąc z danymi (qty + przychód netto).
    value = SUM(quantity × price_netto) z pozycji zamówień (rzeczywista cena sprzedaży).
    Uwaga: kwoty sumowane w wartości nominalnej waluty pozycji (głównie PLN) — przeliczenie
    EUR/CZK→PLN (NBP) to osobny krok. month 0-11. Dopasowanie SKU LOWER(TRIM(...))."""
    sql = f"""
        SELECT
            EXTRACT(YEAR  FROM o.{settings.COL_ORDER_DATE})::int                                      AS yr,
            EXTRACT(MONTH FROM o.{settings.COL_ORDER_DATE})::int                                      AS mo,
            COALESCE(SUM(i.{settings.COL_ITEM_QTY}), 0)::int                                           AS qty,
            COALESCE(SUM(i.{settings.COL_ITEM_QTY} * COALESCE(i.{settings.COL_ITEM_PRICE_NETTO}, 0)), 0)::float AS val
        FROM {settings.TABLE_ORDER_ITEMS} i
        JOIN {settings.TABLE_ORDERS} o
            ON o.{settings.COL_ORDER_ID} = i.{settings.COL_ITEM_ORDER_ID}
        WHERE LOWER(TRIM(i.{settings.COL_ITEM_SKU})) IN (
                SELECT LOWER(TRIM(pa.sku))
                FROM {settings.TABLE_PRODUCT_ATTRS} pa
                WHERE pa.manufacturer_id = :mid
            )
            AND o.{settings.COL_ORDER_DATE} >= (date_trunc('year', CURRENT_DATE) - INTERVAL '1 year')
            {EXCLUDED_STATUS_FILTER}
        GROUP BY EXTRACT(YEAR FROM o.{settings.COL_ORDER_DATE}), EXTRACT(MONTH FROM o.{settings.COL_ORDER_DATE})
        ORDER BY yr, mo
    """
    r = await db.execute(text(sql), {"mid": mid})
    return [
        SeasonPoint(
            year=int(row._mapping["yr"]),
            month=int(row._mapping["mo"]) - 1,  # 0-based dla frontu
            qty=int(row._mapping["qty"] or 0),
            value=float(row._mapping["val"] or 0.0),
        )
        for row in r
    ]


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
