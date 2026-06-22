"""Producenci - CRUD."""

from typing import List

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, INCLUDED_STATUS_FILTER
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
    """Sprzedaż miesięczna wszystkich SKU producenta (qty + przychód netto/brutto w PLN),
    od 1 stycznia zeszłego roku do dziś — pod wykres kalendarzowy Sty–Gru."""
    where = f"""LOWER(TRIM(i.{settings.COL_ITEM_SKU})) IN (
                SELECT LOWER(TRIM(pa.sku))
                FROM {settings.TABLE_PRODUCT_ATTRS} pa
                WHERE pa.manufacturer_id = :mid)"""
    return await _sales_season(db, where, {"mid": mid})


@router.get("/products/{sku}/sales-season", response_model=List[SeasonPoint])
async def product_sales_season(sku: str, db: AsyncSession = Depends(get_db)):
    """Sprzedaż miesięczna pojedynczego SKU (qty + przychód netto/brutto w PLN),
    od 1 stycznia zeszłego roku do dziś — pod wykres w karcie produktu."""
    where = f"LOWER(TRIM(i.{settings.COL_ITEM_SKU})) = LOWER(TRIM(:sku))"
    return await _sales_season(db, where, {"sku": sku})


async def _sales_season(db: AsyncSession, where_clause: str, params: dict) -> List[SeasonPoint]:
    """Wspólne zapytanie sezonowe. Zakres: od 1 stycznia ZESZŁEGO roku do dziś
    (pokrywa cały zeszły rok + bieżący rok do teraz). Po jednym punkcie na miesiąc.

    Przewalutowanie na PLN w SQL: dla każdej pozycji bierzemy kurs średni NBP z
    ostatniego dnia roboczego PRZED datą zamówienia (rate_date < order_date::date —
    konwencja księgowa; weekend/święto „cofa się" samo, bo w tabeli są tylko dni robocze).
    PLN (oraz puste/NULL) → mnożnik 1.0. Waluta obca bez kursu w bazie → mnożnik NULL →
    pozycja wypada z sumy (lepsze niż zawyżanie sumą nominalną; luki widać w /api/admin/fx/status).

    value_net = SUM(qty × price_netto × kurs), value_gross = SUM(qty × price × kurs).
    month 0-11. Dopasowanie SKU LOWER(TRIM(...))."""
    sql = f"""
        SELECT
            EXTRACT(YEAR  FROM o.{settings.COL_ORDER_DATE})::int                                                           AS yr,
            EXTRACT(MONTH FROM o.{settings.COL_ORDER_DATE})::int                                                           AS mo,
            COALESCE(SUM(i.{settings.COL_ITEM_QTY}), 0)::int                                                               AS qty,
            COALESCE(SUM(i.{settings.COL_ITEM_QTY} * COALESCE(i.{settings.COL_ITEM_PRICE_NETTO}, 0) * fx.mult), 0)::float  AS val_net,
            COALESCE(SUM(i.{settings.COL_ITEM_QTY} * COALESCE(i.{settings.COL_ITEM_PRICE},       0) * fx.mult), 0)::float  AS val_gross
        FROM {settings.TABLE_ORDER_ITEMS} i
        JOIN {settings.TABLE_ORDERS} o
            ON o.{settings.COL_ORDER_ID} = i.{settings.COL_ITEM_ORDER_ID}
        LEFT JOIN LATERAL (
            SELECT CASE
                WHEN UPPER(TRIM(COALESCE(i.{settings.COL_ITEM_CURRENCY}, '{settings.FX_BASE_CURRENCY}'))) IN ('{settings.FX_BASE_CURRENCY}', '')
                    THEN 1.0
                ELSE (
                    SELECT r.mid
                    FROM {settings.TABLE_FX_RATES} r
                    WHERE r.currency = UPPER(TRIM(i.{settings.COL_ITEM_CURRENCY}))
                      AND r.rate_date < o.{settings.COL_ORDER_DATE}::date
                    ORDER BY r.rate_date DESC
                    LIMIT 1
                )
            END AS mult
        ) fx ON TRUE
        WHERE {where_clause}
            AND o.{settings.COL_ORDER_DATE} >= (date_trunc('year', CURRENT_DATE) - INTERVAL '1 year')
            {INCLUDED_STATUS_FILTER}
        GROUP BY EXTRACT(YEAR FROM o.{settings.COL_ORDER_DATE}), EXTRACT(MONTH FROM o.{settings.COL_ORDER_DATE})
        ORDER BY yr, mo
    """
    r = await db.execute(text(sql), params)
    return [
        SeasonPoint(
            year=int(row._mapping["yr"]),
            month=int(row._mapping["mo"]) - 1,  # 0-based dla frontu
            qty=int(row._mapping["qty"] or 0),
            value_net=float(row._mapping["val_net"] or 0.0),
            value_gross=float(row._mapping["val_gross"] or 0.0),
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
