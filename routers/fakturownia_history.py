"""Fakturownia — ręczne odświeżanie dziennika ruchów magazynowych (Acti/Veluxa).

Bieg pobiera `/warehouse_actions.json` z każdej skonfigurowanej Fakturowni i
przepisuje do `fakturownia_ruchy` (patrz services/fakturownia_history.py). To
źródło zakładki „Historia produktu" dla firm spoza Subiekta.

Guard: wymaga zalogowania — jak /api/fakturownia/refresh. Sama zakładka
historii jest superadminowa, ale ingesta ma chodzić niezależnie od tego, kto
patrzy: ledger musi się budować od dziś, żeby miał głębię, gdy funkcja
wyjdzie szerzej.

Bieg leci w tle, front polluje /status.
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from models import CurrentUser
from security import get_current_user
from services.fakturownia_history import (
    get_status,
    is_configured,
    is_running,
    mark_started,
    run_sync,
)

router = APIRouter(prefix="/api/fakturownia-history", tags=["fakturownia"])


@router.get("/status")
async def status(user: CurrentUser = Depends(get_current_user)):
    """Stan ostatniego/bieżącego biegu — liczba ruchów, zakres dat, błędy."""
    return {"configured": is_configured(), **get_status()}


@router.post("/run")
async def run(user: CurrentUser = Depends(get_current_user)):
    """Uruchamia ingestę w tle. Zwraca natychmiast, front polluje /status."""
    if not is_configured():
        raise HTTPException(
            status_code=400,
            detail="Fakturownia nie jest skonfigurowana — ustaw "
                   "FAKTUROWNIA_<SKLEP>_URL i _TOKEN w zmiennych Railway.",
        )
    if is_running():
        return {"status": "already_running", **get_status()}

    mark_started()                    # synchronicznie, zanim wystartuje zadanie
    asyncio.create_task(run_sync())   # bieg w tle, własna sesja bazy
    return {"status": "started", **get_status()}
