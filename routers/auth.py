"""Autoryzacja: logowanie (JWT), dane bieżącego użytkownika, zmiana własnego hasła."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from security import (
    verify_password, hash_password, validate_password_strength,
    create_jwt_token, get_current_user,
)
from models import CurrentUser, LoginRequest, LoginResponse, UserOut, PasswordChange
from audit import log_audit

router = APIRouter(prefix="/api", tags=["auth"])


@router.post("/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Logowanie - zwraca JWT token + dane użytkownika."""
    r = await db.execute(
        text(f"SELECT id, email, password_hash, full_name, role, is_active, created_at, last_login FROM {settings.TABLE_USERS} WHERE LOWER(email) = LOWER(:email)"),
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
    await db.commit()

    token = create_jwt_token(u.id, u.email, u.role)

    user_out = UserOut(
        id=u.id, email=u.email, full_name=u.full_name, role=u.role,
        is_active=u.is_active, created_at=u.created_at, last_login=datetime.now(),
        is_super_admin=bool(settings.SUPER_ADMIN_EMAIL and u.email.lower() == settings.SUPER_ADMIN_EMAIL.strip().lower())
    )

    fake_user = CurrentUser(id=u.id, email=u.email, role=u.role, full_name=u.full_name)
    await log_audit(db, fake_user, "LOGIN", "user", str(u.id))

    return LoginResponse(access_token=token, user=user_out)


@router.get("/auth/me", response_model=UserOut)
async def get_me(user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Zwraca dane zalogowanego użytkownika."""
    r = await db.execute(
        text(f"SELECT id, email, full_name, role, is_active, created_at, last_login FROM {settings.TABLE_USERS} WHERE id = :id"),
        {"id": user.id}
    )
    u = r.first()
    if not u:
        raise HTTPException(404, "Użytkownik nie istnieje")

    data = dict(u._mapping)
    super_email = settings.SUPER_ADMIN_EMAIL.strip().lower()
    data["is_super_admin"] = bool(super_email and data["email"].lower() == super_email)
    return UserOut(**data)


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
