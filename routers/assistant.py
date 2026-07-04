"""Asystent AI — endpointy. Czat działa tylko dla zalogowanych; jeśli dostawca LLM
nie jest skonfigurowany (brak klucza), zwraca 503 z czytelnym komunikatem.

Wersja samodiagnozująca: każdy wyjątek w trakcie rozmowy jest łapany i zwracany jako
zwykła odpowiedź 200 (z treścią błędu) — dzięki temu przeglądarka nie blokuje go na CORS,
a w dymku czatu widać dokładną przyczynę. Pełny traceback leci też do logów Railway.
"""
import traceback

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import AssistantChatRequest, AssistantChatResponse, CurrentUser
from security import get_current_user
from services.assistant import run_chat
from services.usage import get_stats

router = APIRouter(prefix="/api", tags=["assistant"])


def _configured() -> bool:
    return bool(settings.LLM_BASE_URL and settings.LLM_API_KEY)


@router.get("/assistant/status")
async def assistant_status(user: CurrentUser = Depends(get_current_user)):
    return {"configured": _configured(), "model": settings.LLM_MODEL if _configured() else None}


@router.post("/assistant/chat", response_model=AssistantChatResponse)
async def assistant_chat(
    payload: AssistantChatRequest,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    if not _configured():
        raise HTTPException(503, "Asystent nie jest skonfigurowany (brak LLM_BASE_URL / LLM_API_KEY).")
    if not payload.messages:
        raise HTTPException(400, "Pusta rozmowa.")
    history = [{"role": m.role, "content": m.content} for m in payload.messages]
    try:
        result = await run_chat(db, user, history)
        return AssistantChatResponse(answer=result["answer"], tools=result.get("tools", []))
    except Exception:
        print("[assistant] BLAD /assistant/chat:\n" + traceback.format_exc())   # traceback w logach Railway
        return AssistantChatResponse(answer="Asystent napotkał błąd po stronie serwera. Spróbuj ponownie za chwilę.", tools=[])


@router.get("/usage/stats")
async def usage_stats(
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """Saldo + rozkład input/output + ostatnie zapytania (dla strony licznika)."""
    return await get_stats(db, settings.STARTING_BALANCE_USD)
