"""Fakturownia — ingesta sprzedaży spoza Sellasista (hurt + przesunięcia do AMH).

Bieg pobiera faktury BEZ pola `oid` z każdej skonfigurowanej Fakturowni i zapisuje
do fakturownia_invoices / fakturownia_invoice_items (patrz services/fakturownia_sales.py).
To NOWE tabele — żadne istniejące zapytanie ich jeszcze nie czyta. Wpięcie do
Finansów i Prognozy to osobny etap, po weryfikacji liczb.

Endpointy:
  GET  /api/fakturownia-sales/status   — stan biegu (do pollowania)
  POST /api/fakturownia-sales/sync     — uruchamia bieg w tle (ADMIN)
  GET  /api/fakturownia-sales/braki    — pozycje bez rozpoznanego SKU (ADMIN)

Pierwszy bieg jest DŁUGI: uczy mapy product_id → SKU ze wszystkich faktur
detalicznych (u Veluxy ~560 requestów, kilka minut). Kolejne biegi uczą się
tylko z nowych faktur, więc schodzą do kilkunastu sekund.
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import CurrentUser
from security import get_current_user, require_admin
from services.fakturownia_sales import (
    get_status, is_running, mark_started, run_sync,
)

router = APIRouter(prefix="/api/fakturownia-sales", tags=["fakturownia-sales"])


@router.get("/status")
async def sales_status(user: CurrentUser = Depends(get_current_user)):
    """Stan ostatniego/bieżącego biegu."""
    return get_status()


@router.post("/sync")
async def sales_sync(user: CurrentUser = Depends(require_admin)):
    """Uruchamia ingestę w tle. Zwraca natychmiast, front polluje /status."""
    st = get_status()
    if not st["configured"]:
        raise HTTPException(
            status_code=400,
            detail="Fakturownia nie jest skonfigurowana — ustaw FAKTUROWNIA_<SKLEP>_URL "
                   "i _TOKEN w zmiennych środowiskowych Railway.",
        )
    if is_running():
        return {"status": "already_running", **get_status()}

    mark_started()
    asyncio.create_task(run_sync())
    return {"status": "started", **get_status()}


@router.get("/braki")
async def sales_braki(user: CurrentUser = Depends(require_admin),
                      db: AsyncSession = Depends(get_db)):
    """Pozycje, których nie udało się zmapować na SKU.

    Nie wyrzucamy ich przy ingeście — leżą w bazie z sku_source = 'BRAK', żeby
    brakujący towar był widocznym problemem, a nie cichym ubytkiem w obrocie.
    Typowa przyczyna: karta produktu w Fakturowni bez wypełnionego pola „kod",
    albo pozycja wpisana na fakturę z ręki, bez odwołania do produktu.
    """
    r = await db.execute(text(
        "SELECT i.shop, i.product_id, MAX(i.product_name) AS nazwa, "
        "       COUNT(*) AS pozycji, SUM(i.quantity) AS sztuk, "
        "       SUM(i.total_net) AS netto, MAX(f.number) AS przyklad_faktury "
        "FROM fakturownia_invoice_items i "
        "JOIN fakturownia_invoices f "
        "  ON f.firma_id = i.firma_id AND f.invoice_id = i.invoice_id "
        "WHERE i.sku_source = 'BRAK' AND f.skip_reason IS NULL "
        "GROUP BY i.shop, i.product_id "
        "ORDER BY SUM(i.total_net) DESC"
    ))
    braki = [dict(x) for x in r.mappings()]
    return {
        "pozycji": sum(b["pozycji"] for b in braki),
        "netto": round(sum(float(b["netto"] or 0) for b in braki), 2),
        "produkty": braki,
    }
