"""Dziennik audytu — odczyt tylko dla super-administratora (email z SUPER_ADMIN_EMAIL).

Wpisy mają gotowe zdanie (kolumna message) i listę zmian „było → jest” (changes).
Wpisom sprzed przebudowy zdanie składamy przy odczycie z akcji/ścieżki — flaga legacy.
"""

import json
from datetime import date
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

import audit_opisy as opisy
from audit import zdanie
from config import settings
from database import get_db
from security import require_admin
from models import CurrentUser, AuditLogOut, AuditLogPage

router = APIRouter(prefix="/api", tags=["audit"])


def _data(s: str, pole: str) -> Optional[date]:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"{pole}: oczekiwany format RRRR-MM-DD")


def _wiersz(m) -> AuditLogOut:
    d = dict(m)
    ch = d.get("changes")
    if isinstance(ch, str):          # asyncpg oddaje JSONB jako tekst
        try:
            ch = json.loads(ch)
        except ValueError:
            ch = None
    d["changes"] = ch if isinstance(ch, list) else []
    legacy = not d.get("message")
    if legacy:
        d["message"] = zdanie(d.get("user_email"),
                              opisy.orzeczenie_legacy(d["action"], d.get("resource_id"), d.get("details")))
    d["area"] = d.get("area") or opisy.obszar_akcji(d["action"], d.get("resource_type"))
    d["legacy"] = legacy
    return AuditLogOut(**d)


@router.get("/audit-log", response_model=AuditLogPage)
async def get_audit_log(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_email: str = Query("", description="filtr: e-mail użytkownika"),
    area: str = Query("", description="filtr: obszar (Produkty, Kontenery, …)"),
    q: str = Query("", description="szukaj w zdaniu, obiekcie i ścieżce"),
    od: str = Query("", description="RRRR-MM-DD"),
    do: str = Query("", description="RRRR-MM-DD, włącznie"),
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Dziennik od najnowszych. `more` mówi, czy jest co doczytać."""
    super_email = settings.SUPER_ADMIN_EMAIL.strip().lower()
    if super_email and admin.email.lower() != super_email:
        raise HTTPException(403, "Dziennik audytu dostępny tylko dla super-administratora")
    start, end = _data(od, "Data od"), _data(do, "Data do")
    q = q.strip()

    r = await db.execute(text(f"""
        SELECT id, user_id, user_email, action, resource_type, resource_id, details,
               created_at, message, changes, area
        FROM {settings.TABLE_AUDIT_LOG}
        WHERE (:email = '' OR LOWER(user_email) = LOWER(:email))
          AND (:area = '' OR area = :area)
          AND (:q = '' OR message ILIKE :q_like OR resource_id ILIKE :q_like
               OR details ILIKE :q_like OR user_email ILIKE :q_like)
          AND (CAST(:od AS DATE) IS NULL OR created_at >= CAST(:od AS DATE))
          AND (CAST(:do_ AS DATE) IS NULL OR created_at < CAST(:do_ AS DATE) + 1)
        ORDER BY created_at DESC, id DESC
        LIMIT :lim OFFSET :off
    """), {"email": user_email.strip(), "area": area.strip(), "q": q, "q_like": f"%{q}%",
           "od": start, "do_": end, "lim": limit + 1, "off": offset})
    rows = [_wiersz(m) for m in r.mappings()]

    users = (await db.execute(text(
        f"SELECT DISTINCT user_email FROM {settings.TABLE_AUDIT_LOG} "
        f"WHERE user_email IS NOT NULL ORDER BY user_email"
    ))).scalars().all()

    return AuditLogPage(rows=rows[:limit], more=len(rows) > limit,
                        users=list(users), obszary=opisy.OBSZARY)
