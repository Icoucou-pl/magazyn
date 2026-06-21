"""Kursy walut NBP — administracja (status / top-up / backfill).

UWAGA bezpieczeństwo: te endpointy nie mają jeszcze guardu auth (spójnie z sąsiednimi
routerami — patrz pkt D8 w HANDOFF). backfill/topup biją do zewnętrznego API i piszą
do bazy, więc docelowo powinny być ADMIN-only — guard dopinamy razem z przeglądem auth.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from services.fx import backfill_history, fx_status, topup_recent

router = APIRouter(prefix="/api/admin/fx", tags=["fx"])


@router.get("/status")
async def get_fx_status(db: AsyncSession = Depends(get_db)):
    """Zakres pokrytych kursów per waluta + waluty obecne w zamówieniach (luki)."""
    return await fx_status(db)


@router.post("/topup")
async def post_fx_topup(db: AsyncSession = Depends(get_db)):
    """Dociąga kursy z ostatnich ~14 dni (idempotentnie)."""
    return await topup_recent(db)


@router.post("/backfill")
async def post_fx_backfill(db: AsyncSession = Depends(get_db)):
    """Jednorazowo: pobiera kursy dla całej historii zamówień. Może chwilę potrwać."""
    return await backfill_history(db)
