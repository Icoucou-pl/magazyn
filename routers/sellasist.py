"""Sellasist — ręczne odświeżanie danych (przycisk w headerze) + status.

Guard: wymaga zalogowania (get_current_user). Przycisk „Odśwież" jest widoczny
w headerze dla każdego zalogowanego, więc bramkujemy tylko logowaniem — nie rolą
(audit middleware zaloguje akcję). Ewentualne zacieśnienie do IMPORT/ADMIN —
osobno, po potwierdzeniu kto widzi przycisk.

Bieg pobiera dane bezpośrednio z API Sellasista i upsertuje do Supabase (te same
tabele co skrypty z Task Schedulera) — patrz services/sellasist.py.
"""

import asyncio

from fastapi import APIRouter, HTTPException, Depends

from models import CurrentUser
from security import get_current_user
from services.sellasist import get_status, is_running, mark_started, run_refresh

router = APIRouter(prefix="/api/sellasist", tags=["sellasist"])


@router.get("/status")
async def sellasist_status(user: CurrentUser = Depends(get_current_user)):
    """Stan ostatniego/bieżącego odświeżania (do pollowania z frontu)."""
    return get_status()


@router.post("/refresh")
async def sellasist_refresh(user: CurrentUser = Depends(get_current_user)):
    """Uruchamia odświeżanie w tle. Zwraca natychmiast, front polluje /status."""
    st = get_status()
    if not st["configured"]:
        raise HTTPException(
            status_code=400,
            detail="Sellasist nie jest skonfigurowany — ustaw SELLASIST_API_KEY i "
                   "SELLASIST_BASE_URL w zmiennych środowiskowych Railway.",
        )
    if is_running():
        return {"status": "already_running", **get_status()}

    mark_started()                       # synchronicznie, zanim wystartuje zadanie
    asyncio.create_task(run_refresh())   # bieg w tle, własna sesja bazy
    return {"status": "started", **get_status()}
