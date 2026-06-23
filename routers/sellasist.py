"""Sellasist — ręczne odświeżanie danych (przycisk w headerze) + status.

UWAGA bezpieczeństwo: spójnie z sąsiednimi routerami (fx, containers) te endpointy
nie mają jeszcze guardu auth — przycisk i tak leci z aplikacji z tokenem usera
(audit middleware zaloguje akcję). Twardy guard ADMIN-only dopinamy w czacie AUTH.

Bieg pobiera dane bezpośrednio z API Sellasista i upsertuje do Supabase (te same
tabele co skrypty z Task Schedulera) — patrz services/sellasist.py.
"""

import asyncio

from fastapi import APIRouter, HTTPException

from services.sellasist import get_status, is_running, mark_started, run_refresh

router = APIRouter(prefix="/api/sellasist", tags=["sellasist"])


@router.get("/status")
async def sellasist_status():
    """Stan ostatniego/bieżącego odświeżania (do pollowania z frontu)."""
    return get_status()


@router.post("/refresh")
async def sellasist_refresh():
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
