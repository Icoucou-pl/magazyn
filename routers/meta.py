"""Endpointy meta: health check, statystyki ogólne, klasyfikacja produktów."""

from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from sql import SALES_QUERY
from services.products import classify_product

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health")
async def health():
    return {"status": "ok", "time": datetime.now().isoformat(), "version": "5.0"}


@router.get("/stats")
async def stats(db: AsyncSession = Depends(get_db)):
    r1 = await db.execute(text(f"SELECT COUNT(*) FROM {settings.TABLE_PRODUCTS}"))
    r2 = await db.execute(text(f"SELECT COUNT(*) FROM {settings.TABLE_PRODUCTS} WHERE {settings.COL_PRODUCT_STOCK} > 0"))
    r3 = await db.execute(text(f"SELECT COUNT(*) FROM {settings.TABLE_ORDERS} WHERE {settings.COL_ORDER_DATE} >= NOW() - INTERVAL '365 days'"))
    return {"total_products": r1.scalar(), "products_with_stock": r2.scalar(), "orders_last_12m": r3.scalar()}


@router.get("/classification")
async def classification(db: AsyncSession = Depends(get_db)):
    products_result = await db.execute(text(SALES_QUERY), {"default_lead_time": settings.DEFAULT_LEAD_TIME_DAYS})
    counts = {"ACTIVE": 0, "ACTIVE_NO_STOCK": 0, "DEAD_STOCK": 0, "INACTIVE": 0}
    dead_stock_value = 0.0
    for r in products_result:
        row = dict(r._mapping)
        s = classify_product(row)
        counts[s] += 1
        if s == "DEAD_STOCK":
            dead_stock_value += row["stock"] * row.get("price", 0)
    return {"counts": counts, "dead_stock_value_pln": round(dead_stock_value, 2), "total": sum(counts.values())}
