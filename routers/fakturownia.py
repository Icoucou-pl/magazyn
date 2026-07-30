"""Fakturownia — ręczne odświeżanie stanów „w drodze" + cen zakupu (Acti/Veluxa).

Bieg pobiera dane z API każdej skonfigurowanej Fakturowni i upsertuje do
`fakturownia_stock` (patrz services/fakturownia.py). Jedna Fakturownia = jeden
sklep; konfiguracja (URL/TOKEN/WH_*) w zmiennych środowiskowych Railway.

Guard: wymaga zalogowania (get_current_user) — tak jak /api/sellasist/refresh.
Bieg leci w tle, front polluje /status (albo pasek świeżości czyta app_sync_log).
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from models import CurrentUser
from security import get_current_user
from services.fakturownia import get_status, is_running, mark_started, run_refresh

router = APIRouter(prefix="/api/fakturownia", tags=["fakturownia"])


@router.get("/status")
async def fakturownia_status(user: CurrentUser = Depends(get_current_user)):
    """Stan ostatniego/bieżącego odświeżania (do pollowania z frontu)."""
    return get_status()


@router.post("/refresh")
async def fakturownia_refresh(user: CurrentUser = Depends(get_current_user)):
    """Uruchamia odświeżanie w tle. Zwraca natychmiast, front polluje /status."""
    st = get_status()
    if not st["configured"]:
        raise HTTPException(
            status_code=400,
            detail="Fakturownia nie jest skonfigurowana — ustaw FAKTUROWNIA_<SKLEP>_URL, "
                   "_TOKEN i _WH_DRODZE w zmiennych środowiskowych Railway.",
        )
    if is_running():
        return {"status": "already_running", **get_status()}

    mark_started()                       # synchronicznie, zanim wystartuje zadanie
    asyncio.create_task(run_refresh())   # bieg w tle, własna sesja bazy
    return {"status": "started", **get_status()}
