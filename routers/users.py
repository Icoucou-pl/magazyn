"""Zarządzanie użytkownikami - wszystkie endpointy tylko dla ADMIN."""

from typing import List

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from security import hash_password, validate_password_strength, require_admin
from models import CurrentUser, UserCreate, UserUpdate, UserOut, AdminPasswordReset
from audit import log_audit

router = APIRouter(prefix="/api", tags=["users"])


@router.get("/users", response_model=List[UserOut])
async def list_users(admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Lista wszystkich użytkowników - tylko admin."""
    r = await db.execute(text(f"SELECT id, email, full_name, role, is_active, created_at, last_login FROM {settings.TABLE_USERS} ORDER BY created_at DESC"))
    return [UserOut(**dict(row._mapping)) for row in r]


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(payload: UserCreate, admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Tworzy nowego użytkownika - tylko admin."""
    err = validate_password_strength(payload.password)
    if err:
        raise HTTPException(400, err)

    r = await db.execute(text(f"SELECT id FROM {settings.TABLE_USERS} WHERE LOWER(email) = LOWER(:email)"), {"email": payload.email.strip()})
    if r.first():
        raise HTTPException(409, "Użytkownik z tym emailem już istnieje")

    pwd_hash = hash_password(payload.password)
    r = await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_USERS} (email, password_hash, full_name, role, is_active)
            VALUES (:e, :h, :n, :r, TRUE) RETURNING id, email, full_name, role, is_active, created_at, last_login
        """),
        {"e": payload.email.strip(), "h": pwd_hash, "n": payload.full_name, "r": payload.role}
    )
    u = r.first()
    await db.commit()

    await log_audit(db, admin, "USER_CREATED", "user", str(u.id), f"{payload.email} ({payload.role})")
    return UserOut(**dict(u._mapping))


@router.patch("/users/{uid}", response_model=UserOut)
async def update_user(uid: int, payload: UserUpdate, admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Aktualizuje użytkownika - tylko admin."""
    if uid == admin.id and payload.role and payload.role != "ADMIN":
        raise HTTPException(400, "Nie możesz odebrać sobie roli admina!")
    if uid == admin.id and payload.is_active is False:
        raise HTTPException(400, "Nie możesz deaktywować własnego konta!")

    updates = []
    params = {"id": uid}
    if payload.full_name is not None:
        updates.append("full_name = :name")
        params["name"] = payload.full_name
    if payload.role is not None:
        updates.append("role = :role")
        params["role"] = payload.role
    if payload.is_active is not None:
        updates.append("is_active = :active")
        params["active"] = payload.is_active

    if updates:
        await db.execute(text(f"UPDATE {settings.TABLE_USERS} SET {', '.join(updates)} WHERE id = :id"), params)
        await db.commit()

    r = await db.execute(text(f"SELECT id, email, full_name, role, is_active, created_at, last_login FROM {settings.TABLE_USERS} WHERE id = :id"), {"id": uid})
    u = r.first()
    if not u:
        raise HTTPException(404, "Użytkownik nie znaleziony")

    await log_audit(db, admin, "USER_UPDATED", "user", str(uid), str(payload.model_dump(exclude_none=True)))
    return UserOut(**dict(u._mapping))


@router.put("/users/{uid}/password", status_code=204)
async def reset_user_password(uid: int, payload: AdminPasswordReset, admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Reset hasła użytkownika przez admina - bez wymagania starego hasła."""
    err = validate_password_strength(payload.new_password)
    if err:
        raise HTTPException(400, err)

    new_hash = hash_password(payload.new_password)
    r = await db.execute(text(f"UPDATE {settings.TABLE_USERS} SET password_hash = :h WHERE id = :id RETURNING email"), {"h": new_hash, "id": uid})
    u = r.first()
    await db.commit()
    if not u:
        raise HTTPException(404, "Użytkownik nie znaleziony")

    await log_audit(db, admin, "PASSWORD_RESET_BY_ADMIN", "user", str(uid), f"reset hasła dla: {u.email}")


@router.delete("/users/{uid}", status_code=204)
async def delete_user(uid: int, admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Usuwa użytkownika - tylko admin (nie może usunąć siebie)."""
    if uid == admin.id:
        raise HTTPException(400, "Nie możesz usunąć własnego konta!")

    r = await db.execute(text(f"DELETE FROM {settings.TABLE_USERS} WHERE id = :id RETURNING email"), {"id": uid})
    u = r.first()
    await db.commit()
    if not u:
        raise HTTPException(404, "Użytkownik nie znaleziony")

    await log_audit(db, admin, "USER_DELETED", "user", str(uid), f"usunięto: {u.email}")
