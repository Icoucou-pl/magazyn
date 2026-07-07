"""Autoryzacja: logowanie (JWT), dane bieżącego użytkownika, zmiana własnego hasła, sesje."""

import json
from datetime import datetime
from typing import List

from fastapi import APIRouter, HTTPException, Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from security import (
    verify_password, hash_password, validate_password_strength,
    create_jwt_token, get_current_user,
)
from models import CurrentUser, LoginRequest, LoginResponse, UserOut, PasswordChange, SessionOut, OnboardingSet
from audit import log_audit

router = APIRouter(prefix="/api", tags=["auth"])


def _parse_perms(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def _client_ip(request: Request) -> str:
    """Realne IP zza proxy Railway (X-Forwarded-For), z fallbackiem na adres klienta."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else ""


@router.post("/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Logowanie - zwraca JWT token + dane użytkownika."""
    r = await db.execute(
        text(f"SELECT id, email, password_hash, full_name, role, is_active, created_at, last_login, permissions, show_onboarding FROM {settings.TABLE_USERS} WHERE LOWER(email) = LOWER(:email)"),
        {"email": payload.email.strip()}
    )
    u = r.first()
    if not u or not verify_password(payload.password, u.password_hash):
        await log_audit(db, None, "LOGIN_FAILED", "user", payload.email, "Nieprawidłowy email lub hasło")
        raise HTTPException(401, "Nieprawidłowy email lub hasło")

    if not u.is_active:
        await log_audit(db, None, "LOGIN_BLOCKED", "user", payload.email, "Konto deaktywowane")
        raise HTTPException(403, "Konto zostało deaktywowane")

    # Update last_login
    await db.execute(
        text(f"UPDATE {settings.TABLE_USERS} SET last_login = CURRENT_TIMESTAMP WHERE id = :id"),
        {"id": u.id}
    )

    # Zapis sesji logowania (urządzenie/IP) - do podglądu w „Moje konto"
    device = (request.headers.get("user-agent") or "")[:400]
    ip = _client_ip(request)
    await db.execute(
        text(f"INSERT INTO {settings.TABLE_SESSIONS} (user_id, device, ip) VALUES (:uid, :d, :ip)"),
        {"uid": u.id, "d": device, "ip": ip}
    )
    await db.commit()

    token = create_jwt_token(u.id, u.email, u.role)

    user_out = UserOut(
        id=u.id, email=u.email, full_name=u.full_name, role=u.role,
        is_active=u.is_active, created_at=u.created_at, last_login=datetime.now(),
        perms=_parse_perms(u.permissions), show_onboarding=bool(u.show_onboarding),
        is_super_admin=bool(settings.SUPER_ADMIN_EMAIL and u.email.lower() == settings.SUPER_ADMIN_EMAIL.strip().lower())
    )

    fake_user = CurrentUser(id=u.id, email=u.email, role=u.role, full_name=u.full_name)
    await log_audit(db, fake_user, "LOGIN", "user", str(u.id))

    return LoginResponse(access_token=token, user=user_out)


@router.get("/auth/me", response_model=UserOut)
async def get_me(user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Zwraca dane zalogowanego użytkownika."""
    r = await db.execute(
        text(f"SELECT id, email, full_name, role, is_active, created_at, last_login, permissions, show_onboarding FROM {settings.TABLE_USERS} WHERE id = :id"),
        {"id": user.id}
    )
    u = r.first()
    if not u:
        raise HTTPException(404, "Użytkownik nie istnieje")

    data = dict(u._mapping)
    super_email = settings.SUPER_ADMIN_EMAIL.strip().lower()
    return UserOut(
        id=data["id"], email=data["email"], full_name=data.get("full_name"), role=data["role"],
        is_active=data["is_active"], created_at=data["created_at"], last_login=data.get("last_login"),
        perms=_parse_perms(data.get("permissions")), show_onboarding=bool(data.get("show_onboarding")),
        is_super_admin=bool(super_email and data["email"].lower() == super_email),
    )


@router.patch("/auth/me/onboarding", status_code=204)
async def set_my_onboarding(payload: OnboardingSet, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Bieżący użytkownik sam ustawia swoją flagę wprowadzenia.
    Front woła to z show_onboarding=false po obejrzeniu/pominięciu, albo =true dla powtórki."""
    await db.execute(
        text(f"UPDATE {settings.TABLE_USERS} SET show_onboarding = :v WHERE id = :id"),
        {"v": payload.show_onboarding, "id": user.id},
    )
    await db.commit()
    return None


@router.put("/auth/me/password", status_code=204)
async def change_my_password(payload: PasswordChange, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Zmiana własnego hasła - wymaga obecnego hasła."""
    err = validate_password_strength(payload.new_password)
    if err:
        raise HTTPException(400, err)

    r = await db.execute(text(f"SELECT password_hash FROM {settings.TABLE_USERS} WHERE id = :id"), {"id": user.id})
    u = r.first()
    if not verify_password(payload.current_password, u.password_hash):
        raise HTTPException(400, "Aktualne hasło jest nieprawidłowe")

    new_hash = hash_password(payload.new_password)
    await db.execute(text(f"UPDATE {settings.TABLE_USERS} SET password_hash = :h WHERE id = :id"), {"h": new_hash, "id": user.id})
    await db.commit()

    await log_audit(db, user, "PASSWORD_CHANGED", "user", str(user.id))


@router.get("/auth/me/sessions", response_model=List[SessionOut])
async def my_sessions(request: Request, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Lista sesji logowania bieżącego użytkownika (urządzenie/IP/czas)."""
    r = await db.execute(
        text(f"SELECT id, device, ip, created_at FROM {settings.TABLE_SESSIONS} WHERE user_id = :uid ORDER BY created_at DESC"),
        {"uid": user.id}
    )
    rows = [dict(x._mapping) for x in r]

    # Heurystyka „bieżąca sesja": najnowszy wpis pasujący do tego urządzenia + IP
    cur_device = (request.headers.get("user-agent") or "")[:400]
    cur_ip = _client_ip(request)
    marked = False
    out = []
    for m in rows:
        is_current = (not marked and m.get("device") == cur_device and m.get("ip") == cur_ip)
        if is_current:
            marked = True
        out.append(SessionOut(id=m["id"], device=m.get("device"), ip=m.get("ip"), created_at=m["created_at"], current=is_current))
    return out


@router.delete("/auth/me/sessions/{sid}", status_code=204)
async def delete_my_session(sid: int, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Usuwa wpis sesji z listy (nie unieważnia tokena JWT - to bezstanowe)."""
    await db.execute(
        text(f"DELETE FROM {settings.TABLE_SESSIONS} WHERE id = :sid AND user_id = :uid"),
        {"sid": sid, "uid": user.id}
    )
    await db.commit()
