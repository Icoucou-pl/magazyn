"""Audit log - odczyt tylko dla super-administratora (email z SUPER_ADMIN_EMAIL)."""

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from security import require_admin
from models import CurrentUser, AuditLogOut

router = APIRouter(prefix="/api", tags=["audit"])


@router.get("/audit-log", response_model=List[AuditLogOut])
async def get_audit_log(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: Optional[int] = None,
    action: Optional[str] = None,
    admin: CurrentUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Audit log - tylko super-admin (konkretny email z SUPER_ADMIN_EMAIL)."""
    super_email = settings.SUPER_ADMIN_EMAIL.strip().lower()
    if super_email and admin.email.lower() != super_email:
        raise HTTPException(403, "Audit log dostępny tylko dla super-administratora")

    where = []
    params = {"limit": limit, "offset": offset}
    if user_id:
        where.append("user_id = :uid")
        params["uid"] = user_id
    if action:
        where.append("action = :action")
        params["action"] = action

    where_clause = "WHERE " + " AND ".join(where) if where else ""

    r = await db.execute(text(f"""
        SELECT id, user_id, user_email, action, resource_type, resource_id, details, created_at
        FROM {settings.TABLE_AUDIT_LOG}
        {where_clause}
        ORDER BY created_at DESC
        LIMIT :limit OFFSET :offset
    """), params)

    return [AuditLogOut(**dict(row._mapping)) for row in r]
