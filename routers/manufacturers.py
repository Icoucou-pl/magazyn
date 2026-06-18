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
    """Szereg sezonowy 24 miesięcy (sprzedaż ilościowa wszystkich SKU producenta).
    Zwraca dokładnie 24 punkty (najstarszy→najnowszy), bieżący miesiąc jako ostatni;
    brakujące miesiące wypełnione zerami. Dopasowanie SKU jak w kalendarzu —
    LOWER(TRIM(...)) po obu stronach. Uwzględnia wykluczone statusy zamówień."""
    sql = f"""
        SELECT
            EXTRACT(YEAR  FROM o.{settings.COL_ORDER_DATE})::int AS yr,
            EXTRACT(MONTH FROM o.{settings.COL_ORDER_DATE})::int AS mo,
            COALESCE(SUM(i.{settings.COL_ITEM_QTY}), 0)::int       AS qty
        FROM {settings.TABLE_ORDER_ITEMS} i
        JOIN {settings.TABLE_ORDERS} o
            ON o.{settings.COL_ORDER_ID} = i.{settings.COL_ITEM_ORDER_ID}
        WHERE LOWER(TRIM(i.{settings.COL_ITEM_SKU})) IN (
                SELECT LOWER(TRIM(pa.sku))
                FROM {settings.TABLE_PRODUCT_ATTRS} pa
                WHERE pa.manufacturer_id = :mid
            )
            AND o.{settings.COL_ORDER_DATE} >= (date_trunc('month', CURRENT_DATE) - INTERVAL '23 months')
            {EXCLUDED_STATUS_FILTER}
        GROUP BY EXTRACT(YEAR FROM o.{settings.COL_ORDER_DATE}), EXTRACT(MONTH FROM o.{settings.COL_ORDER_DATE})
    """
    r = await db.execute(text(sql), {"mid": mid})
    by_key = {(row._mapping["yr"], row._mapping["mo"]): row._mapping["qty"] for row in r}

    # Stała oś 24 miesięcy kończąca się na bieżącym miesiącu (month 0-11 dla frontu)
    from datetime import date as _date
    today = _date.today()
    base_year, base_month0 = today.year, today.month - 1  # 0-based
    points: List[SeasonPoint] = []
    for off in range(23, -1, -1):
        total_m = base_year * 12 + base_month0 - off
        y = total_m // 12
        m0 = total_m % 12
        qty = by_key.get((y, m0 + 1), 0)  # klucz z bazy: miesiąc 1-12
        points.append(SeasonPoint(year=y, month=m0, value=int(qty or 0)))
    return points


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
