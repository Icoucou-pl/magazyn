"""Sellasist — ręczne odświeżanie danych (przycisk w headerze) + status + rekoncyliacja koszyków.

Guard: wymaga zalogowania (get_current_user). Przycisk „Odśwież" jest widoczny
w headerze dla każdego zalogowanego, więc bramkujemy tylko logowaniem — nie rolą
(audit middleware zaloguje akcję). Ewentualne zacieśnienie do IMPORT/ADMIN —
osobno, po potwierdzeniu kto widzi przycisk.

Endpointy rekoncyliacji (/reconcile, /reconcile/scan) są ADMIN-only — kasują
i wstawiają dane, więc nie mogą wisieć na samym logowaniu.

Bieg pobiera dane bezpośrednio z API Sellasista i upsertuje do Supabase (te same
tabele co skrypty z Task Schedulera) — patrz services/sellasist.py.
"""

from typing import Optional

import asyncio

from fastapi import APIRouter, HTTPException, Depends, Query

from models import CurrentUser
from security import get_current_user, require_admin
from services.sellasist import (get_status, is_running, mark_started, run_refresh,
                                reconcile_order, reconcile_scan)
from services import fakturownia as fakt

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

    # Fakturownia (Acti/Veluxa) — odświeżamy TĄ SAMĄ ikonką „Odśwież", ale NIEZALEŻNIE:
    # brak konfiguracji lub błąd Fakturowni nie wpływa na wynik Sellasista (osobny status,
    # osobny wpis w app_sync_log jako fakturownia:<slug>). Fire-and-forget w tle.
    if fakt.is_configured() and not fakt.is_running():
        fakt.mark_started()
        asyncio.create_task(fakt.run_refresh())

    return {"status": "started", **get_status()}


# ============================================================
# REKONCYLIACJA KOSZYKÓW (naprawa "insert-once") — ADMIN
# ============================================================
@router.post("/reconcile")
async def sellasist_reconcile_one(
    shop: str = Query(..., description="Slug sklepu, np. amh"),
    order_id: str = Query(..., description="Numer zamówienia w Sellasiście"),
    dry_run: bool = Query(True, description="True = tylko podgląd różnicy, zero zapisów"),
    admin: CurrentUser = Depends(require_admin),
):
    """Pobiera koszyk zamówienia z API i podmienia go w bazie (DELETE+INSERT w transakcji).

    dry_run=True (domyślnie) NIC nie zapisuje — zwraca różnicę i pełną listę pozycji
    z API, żeby dało się ocenić skutek przed zapisem. Pusty koszyk z API jest
    ignorowany (nie kasujemy danych na podstawie pustej odpowiedzi)."""
    res = await reconcile_order(shop, order_id, dry_run=dry_run)
    if res.get("error") and res.get("status") is None:
        raise HTTPException(status_code=400, detail=res["error"])
    return res


@router.post("/reconcile/scan")
async def sellasist_reconcile_scan(
    shop: str = Query(..., description="Slug sklepu, np. amh"),
    mode: str = Query("log", description="log | mismatch | all"),
    since: Optional[str] = Query(None, description="Data od (YYYY-MM-DD); domyślnie z configu"),
    limit: int = Query(50, ge=1, le=500, description="Maks. liczba zamówień"),
    dry_run: bool = Query(True, description="True = sama lista kandydatów, bez odpytywania API"),
    admin: CurrentUser = Depends(require_admin),
):
    """Skan zamówień do naprawy.

    · mode=log      — zmiana `total` po pobraniu koszyka (pewniak, wąskie sito)
    · mode=mismatch — total nagłówka > suma pozycji (łapie edycje sprzed okna nagłówków)
    · mode=all      — wszystko od `since` (młot; używać świadomie)

    dry_run=True nie dotyka API — służy do zmierzenia skali przed zapisem."""
    try:
        res = await reconcile_scan(shop, since=since, mode=mode, limit=limit, dry_run=dry_run)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Bez tego wyjątek leci poza CORS middleware i w przeglądarce udaje błąd CORS,
        # skutecznie chowając prawdziwą przyczynę. Zwracamy ją jako czytelny 500.
        raise HTTPException(status_code=500, detail=f"Skan nieudany: {type(e).__name__}: {e}")
    if res.get("error"):
        raise HTTPException(status_code=400, detail=res["error"])
    return res
