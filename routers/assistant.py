"""Asystent AI — endpointy. Czat działa tylko dla zalogowanych; jeśli dostawca LLM
nie jest skonfigurowany (brak klucza), zwraca 503 z czytelnym komunikatem."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import AssistantChatRequest, AssistantChatResponse, CurrentUser
from security import get_current_user
from services.assistant import run_chat

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
    result = await run_chat(db, user, history)
    return AssistantChatResponse(answer=result["answer"], tools=result.get("tools", []))
