"""Anomalie sprzedaży (spike/drop/stock_drain) oraz lista zakupów grupowana per producent."""

from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import Anomaly, ShoppingListGroup
from services.products import fetch_products

router = APIRouter(prefix="/api", tags=["anomalies"])


@router.get("/anomalies", response_model=List[Anomaly])
async def detect_anomalies(shop: str = "", db: AsyncSession = Depends(get_db)):
    """
    Wykrywanie anomalii - rozsądna czułość:
    - sales_spike: 1m > 1.5x średniej z poprzednich 3m, ALE 1m >= 5 (żeby nie spam dla małych)
    - sales_drop: 1m < 0.4x średniej z poprzednich 3m, ALE poprzedni miesiąc był >= 5
    - stock_drain: stan = 0 i sprzedaż 1m >= 10
    """
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, shop)
    anomalies = []

    for p in products:
        prev_3m_total = p.sales_2m * 2 + p.sales_3m * 3 + p.sales_4m * 4 - p.sales_1m
        prev_avg = max(p.sales_3m, 1)

        # SPIKE
        if p.sales_1m >= 5 and p.sales_1m > prev_avg * 1.5:
            change_pct = ((p.sales_1m / prev_avg) - 1) * 100
            sev = "high" if change_pct > 100 else "medium"
            anomalies.append(Anomaly(
                sku=p.sku, name=p.name, severity=sev, type="sales_spike",
                message=f"Sprzedaż wzrosła z {prev_avg}/mies do {p.sales_1m}/mies (+{change_pct:.0f}%)",
                sales_1m=p.sales_1m, sales_3m_avg=prev_avg, change_pct=round(change_pct, 1),
            ))
        # DROP
        elif prev_avg >= 5 and p.sales_1m < prev_avg * 0.4:
            change_pct = ((p.sales_1m / prev_avg) - 1) * 100
            sev = "high" if change_pct < -70 else "medium"
            anomalies.append(Anomaly(
                sku=p.sku, name=p.name, severity=sev, type="sales_drop",
                message=f"Sprzedaż spadła z {prev_avg}/mies do {p.sales_1m}/mies ({change_pct:.0f}%)",
                sales_1m=p.sales_1m, sales_3m_avg=prev_avg, change_pct=round(change_pct, 1),
            ))
        # STOCK DRAIN
        elif p.stock == 0 and p.sales_1m >= 10 and p.stock_in_transit == 0:
            anomalies.append(Anomaly(
                sku=p.sku, name=p.name, severity="high", type="stock_drain",
                message=f"Zero stanu, sprzedaż {p.sales_1m}/mies, brak kontenera w drodze!",
                sales_1m=p.sales_1m, sales_3m_avg=prev_avg, change_pct=0,
            ))

    sev_order = {"high": 0, "medium": 1, "low": 2}
    anomalies.sort(key=lambda a: (sev_order[a.severity], -a.sales_1m))
    return anomalies[:20]


@router.get("/shopping-list", response_model=List[ShoppingListGroup])
async def shopping_list(shop: str = "", db: AsyncSession = Depends(get_db)):
    """Grupy produktów do zamówienia per producent."""
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, shop)
    needing = [p for p in products if p.status in ("KRYTYCZNY", "ZAMOW_TERAZ", "ZAMOW_WKROTCE") and p.avg_monthly_weighted >= 1]

    mfr_result = await db.execute(text(f"SELECT id, name, color, email FROM {settings.TABLE_MANUFACTURERS}"))
    mfr_emails = {r._mapping["id"]: r._mapping["email"] for r in mfr_result}

    groups = {}
    for p in needing:
        key = p.manufacturer_id or 0
        if key not in groups:
            groups[key] = {
                "manufacturer_id": p.manufacturer_id,
                "manufacturer_name": p.manufacturer_name,
                "manufacturer_color": p.manufacturer_color,
                "manufacturer_email": mfr_emails.get(p.manufacturer_id) if p.manufacturer_id else None,
                "products": [],
                "total_skus": 0,
            }
        recommended = max(1, int(p.avg_monthly_weighted * 6 - p.stock - p.stock_in_transit))
        groups[key]["products"].append({
            "sku": p.sku, "name": p.name,
            "stock": p.stock, "stock_in_transit": p.stock_in_transit,
            "avg_monthly": p.avg_monthly_weighted,
            "recommended_quantity": recommended,
            "purchase_price": p.purchase_price,
            "cbm_per_unit": p.cbm_per_unit,
            "status": p.status,
            "days_until_empty": p.days_until_empty,
        })
        groups[key]["total_skus"] += 1

    return list(groups.values())
