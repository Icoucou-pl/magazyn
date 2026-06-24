"""Kursy walut NBP — administracja (status / top-up / backfill).

Guard: wszystkie endpointy ADMIN-only (require_admin). To narzędzia admina pod
/api/admin/fx; backfill/topup biją do zewnętrznego API NBP i piszą do bazy.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import CurrentUser
from security import require_admin
from services.fx import backfill_history, fx_status, topup_recent

router = APIRouter(prefix="/api/admin/fx", tags=["fx"])


@router.get("/status")
async def get_fx_status(db: AsyncSession = Depends(get_db), admin: CurrentUser = Depends(require_admin)):
    """Zakres pokrytych kursów per waluta + waluty obecne w zamówieniach (luki)."""
    return await fx_status(db)


@router.post("/topup")
async def post_fx_topup(db: AsyncSession = Depends(get_db), admin: CurrentUser = Depends(require_admin)):
    """Dociąga kursy z ostatnich ~14 dni (idempotentnie)."""
    return await topup_recent(db)


@router.post("/backfill")
async def post_fx_backfill(db: AsyncSession = Depends(get_db), admin: CurrentUser = Depends(require_admin)):
    """Jednorazowo: pobiera kursy dla całej historii zamówień. Może chwilę potrwać."""
    return await backfill_history(db)
