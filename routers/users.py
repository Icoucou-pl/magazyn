"""Zarządzanie użytkownikami - wszystkie endpointy tylko dla ADMIN."""

import json
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from security import hash_password, validate_password_strength, require_admin
from models import CurrentUser, UserCreate, UserUpdate, UserOut, AdminPasswordReset
from audit import log_audit

router = APIRouter(prefix="/api", tags=["users"])

# Kolumny wspólne dla odczytu użytkownika
USER_COLS = "id, email, full_name, role, is_active, created_at, last_login, updated_at, permissions, show_onboarding"


def _super_email() -> str:
    return settings.SUPER_ADMIN_EMAIL.strip().lower()


def _is_super(email: Optional[str]) -> bool:
    se = _super_email()
    return bool(se and email and email.lower() == se)


def _row_to_user_out(m: dict, reveal_super: bool = False) -> UserOut:
    """Buduje UserOut z wiersza. is_super_admin ujawniamy TYLKO super-adminowi
    (inni administratorzy nie powinni wiedzieć, kto jest super-adminem)."""
    raw_perms = m.get("permissions")
    perms = None
    if raw_perms:
        try:
            perms = json.loads(raw_perms)
        except (ValueError, TypeError):
            perms = None
    return UserOut(
        id=m["id"], email=m["email"], full_name=m.get("full_name"), role=m["role"],
        is_active=m["is_active"], created_at=m["created_at"], last_login=m.get("last_login"),
        updated_at=m.get("updated_at"),
        perms=perms, show_onboarding=bool(m.get("show_onboarding")),
        is_super_admin=bool(reveal_super and _is_super(m["email"])),
    )


async def _guard_super_target(db: AsyncSession, uid: int, admin: CurrentUser, *, allow_self_super: bool):
    """Zwraca email celu i blokuje modyfikacje konta super-admina przez nie-super-adminów.
    allow_self_super=True pozwala super-adminowi modyfikować własne konto (poza usunięciem)."""
    r = await db.execute(text(f"SELECT email FROM {settings.TABLE_USERS} WHERE id = :id"), {"id": uid})
    row = r.first()
    if not row:
        raise HTTPException(404, "Użytkownik nie znaleziony")
    target_email = row.email
    if _is_super(target_email):
        requester_is_super = _is_super(admin.email)
        if not requester_is_super or not allow_self_super:
            raise HTTPException(403, "Konto super-administratora jest chronione")
    return target_email


@router.get("/users", response_model=List[UserOut])
async def list_users(admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Lista wszystkich użytkowników - tylko admin."""
    reveal = _is_super(admin.email)
    r = await db.execute(text(f"SELECT {USER_COLS} FROM {settings.TABLE_USERS} ORDER BY created_at DESC"))
    return [_row_to_user_out(dict(row._mapping), reveal_super=reveal) for row in r]


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
            VALUES (:e, :h, :n, :r, TRUE) RETURNING {USER_COLS}
        """),
        {"e": payload.email.strip(), "h": pwd_hash, "n": payload.full_name, "r": payload.role}
    )
    u = r.first()
    await db.commit()

    await log_audit(db, admin, "USER_CREATED", "user", str(u.id), f"{payload.email} ({payload.role})")
    return _row_to_user_out(dict(u._mapping), reveal_super=_is_super(admin.email))


@router.patch("/users/{uid}", response_model=UserOut)
async def update_user(uid: int, payload: UserUpdate, admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Aktualizuje użytkownika - tylko admin."""
    if uid == admin.id and payload.role and payload.role != "ADMIN":
        raise HTTPException(400, "Nie możesz odebrać sobie roli admina!")
    if uid == admin.id and payload.is_active is False:
        raise HTTPException(400, "Nie możesz deaktywować własnego konta!")

    # Ochrona konta super-administratora (tylko super-admin może edytować swoje konto)
    await _guard_super_target(db, uid, admin, allow_self_super=True)

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
    if payload.perms is not None:
        # pusty słownik = brak wyjątków (czyść override → NULL)
        updates.append("permissions = :perms")
        params["perms"] = json.dumps(payload.perms) if payload.perms else None
    if payload.show_onboarding is not None:
        updates.append("show_onboarding = :onb")
        params["onb"] = payload.show_onboarding

    if updates:
        updates.append("updated_at = CURRENT_TIMESTAMP")
        await db.execute(text(f"UPDATE {settings.TABLE_USERS} SET {', '.join(updates)} WHERE id = :id"), params)
        await db.commit()

    r = await db.execute(text(f"SELECT {USER_COLS} FROM {settings.TABLE_USERS} WHERE id = :id"), {"id": uid})
    u = r.first()
    if not u:
        raise HTTPException(404, "Użytkownik nie znaleziony")

    await log_audit(db, admin, "USER_UPDATED", "user", str(uid), str(payload.model_dump(exclude_none=True)))
    return _row_to_user_out(dict(u._mapping), reveal_super=_is_super(admin.email))


@router.put("/users/{uid}/password", status_code=204)
async def reset_user_password(uid: int, payload: AdminPasswordReset, admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Reset hasła użytkownika przez admina - bez wymagania starego hasła."""
    err = validate_password_strength(payload.new_password)
    if err:
        raise HTTPException(400, err)

    # Ochrona konta super-administratora
    target_email = await _guard_super_target(db, uid, admin, allow_self_super=True)

    new_hash = hash_password(payload.new_password)
    await db.execute(
        text(f"UPDATE {settings.TABLE_USERS} SET password_hash = :h, updated_at = CURRENT_TIMESTAMP WHERE id = :id"),
        {"h": new_hash, "id": uid}
    )
    await db.commit()

    await log_audit(db, admin, "PASSWORD_RESET_BY_ADMIN", "user", str(uid), f"reset hasła dla: {target_email}")


@router.delete("/users/{uid}", status_code=204)
async def delete_user(uid: int, admin: CurrentUser = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Usuwa użytkownika - tylko admin (nie może usunąć siebie ani super-admina)."""
    if uid == admin.id:
        raise HTTPException(400, "Nie możesz usunąć własnego konta!")

    # Konta super-administratora nie można usunąć (przez nikogo)
    await _guard_super_target(db, uid, admin, allow_self_super=False)

    r = await db.execute(text(f"DELETE FROM {settings.TABLE_USERS} WHERE id = :id RETURNING email"), {"id": uid})
    u = r.first()
    await db.commit()
    if not u:
        raise HTTPException(404, "Użytkownik nie znaleziony")

    await log_audit(db, admin, "USER_DELETED", "user", str(uid), f"usunięto: {u.email}")
