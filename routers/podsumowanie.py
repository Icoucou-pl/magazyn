"""„Podsumowanie sprzedaży” na pulpicie (jak panel Sellasista). Logika: services/podsumowanie_sprzedazy.py."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import CurrentUser
from security import ALL_SHOPS, allowed_shops, get_current_user, has_perm
from services.podsumowanie_sprzedazy import MAX_DNI, podsumowanie

router = APIRouter(prefix="/api", tags=["podsumowanie"])


@router.get("/sales-summary")
async def sales_summary(days: int = Query(MAX_DNI, ge=1, le=MAX_DNI),
                        db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Serie dzienne per firma z zakresu usera + „razem” (shop="") — front sam tnie okna
    dziś / 7 / 30 dni i wykres 30 / 60 / 180, więc jeden fetch wystarcza na całą kartę."""
    firmy = [f for f in ALL_SHOPS if f in (allowed_shops(user) or ALL_SHOPS)]
    wynik = await podsumowanie(db, firmy, days)
    # Liczba zamówień to nie finanse — zostaje; kwoty tylko z viewFinancials (zakładka Network).
    if not has_perm(user, "viewFinancials"):
        for s in wynik["series"]:
            s["missing_rates"] = 0
            for p in s["points"]:
                p["value"] = None
    return wynik
