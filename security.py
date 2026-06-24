"""
Bezpieczeństwo: hashowanie haseł (bcrypt), tokeny JWT, zależności autoryzacji.

Granularne uprawnienia (require_perm) są AKTYWNE i odwzorowują frontowy can():
override per-user z kolumny `permissions` (JSON) wygrywa nad domyślnym z roli (ROLE_PERMS).
Domyślne zestawy ról są 1:1 z frontend/lib/permissions.js.
"""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import HTTPException, Depends
from fastapi.security import OAuth2PasswordBearer
from passlib.context import CryptContext
from jose import jwt, JWTError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
import re
import json

from config import settings
from database import get_db
from models import CurrentUser


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


# ===== HASŁA =====
def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def validate_password_strength(password: str) -> Optional[str]:
    """Zwraca komunikat o błędzie lub None jeśli OK."""
    if len(password) < 8:
        return "Hasło musi mieć minimum 8 znaków"
    if not re.search(r"[A-Z]", password):
        return "Hasło musi zawierać przynajmniej jedną wielką literę"
    if not re.search(r"[0-9]", password):
        return "Hasło musi zawierać przynajmniej jedną cyfrę"
    return None


# ===== JWT =====
def create_jwt_token(user_id: int, email: str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(days=settings.JWT_EXPIRE_DAYS)
    payload = {"sub": str(user_id), "email": email, "role": role, "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_jwt_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
        return None


# ===== ZALEŻNOŚCI AUTORYZACJI =====
async def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> CurrentUser:
    """Wymusza zalogowanego użytkownika - zwraca CurrentUser lub rzuca 401."""
    if not token:
        raise HTTPException(status_code=401, detail="Wymagane logowanie", headers={"WWW-Authenticate": "Bearer"})

    payload = decode_jwt_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Token wygasł lub nieprawidłowy", headers={"WWW-Authenticate": "Bearer"})

    user_id = int(payload.get("sub", 0))
    if not user_id:
        raise HTTPException(status_code=401, detail="Nieprawidłowy token")

    # Sprawdź czy user nadal istnieje i jest aktywny
    r = await db.execute(
        text(f"SELECT id, email, role, full_name, is_active, permissions FROM {settings.TABLE_USERS} WHERE id = :id"),
        {"id": user_id},
    )
    u = r.first()
    if not u:
        raise HTTPException(status_code=401, detail="Użytkownik nie istnieje")
    if not u.is_active:
        raise HTTPException(status_code=403, detail="Konto deaktywowane")

    perms = None
    raw_perms = getattr(u, "permissions", None)
    if raw_perms:
        if isinstance(raw_perms, dict):
            perms = raw_perms
        else:
            try:
                perms = json.loads(raw_perms)
            except Exception:
                perms = None

    return CurrentUser(id=u.id, email=u.email, role=u.role, full_name=u.full_name, perms=perms)


def require_role(*allowed_roles):
    """Dependency factory: wymusza określoną rolę."""
    async def checker(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.role not in allowed_roles:
            raise HTTPException(403, f"Wymagana rola: {' lub '.join(allowed_roles)}. Twoja rola: {user.role}")
        return user
    return checker


require_admin = require_role("ADMIN")
require_import_or_admin = require_role("ADMIN", "IMPORT")


# ===== GRANULARNE UPRAWNIENIA (1:1 z frontend/lib/permissions.js) =====
# Domyślne uprawnienia per rola. Override per-user (kolumna `permissions`) je nadpisuje.
ROLE_PERMS = {
    "ADMIN":  {"editProducts": True,  "editContainers": True,  "import": True,  "export": True,  "generatePO": True,  "viewFinancials": True,  "viewForecast": True,  "manageUsers": True,  "viewAudit": True},
    "IMPORT": {"editProducts": True,  "editContainers": True,  "import": True,  "export": True,  "generatePO": True,  "viewFinancials": True,  "viewForecast": True,  "manageUsers": False, "viewAudit": False},
    "VIEWER": {"editProducts": False, "editContainers": False, "import": False, "export": True,  "generatePO": False, "viewFinancials": True,  "viewForecast": True,  "manageUsers": False, "viewAudit": False},
}


def has_perm(user: CurrentUser, perm: str) -> bool:
    """Odwzorowanie frontowego can(): override per-user wygrywa, inaczej domyślne z roli."""
    if user is None:
        return False
    if user.perms is not None and perm in user.perms:
        return bool(user.perms[perm])
    return bool(ROLE_PERMS.get(user.role, {}).get(perm, False))


def require_perm(perm: str):
    """
    Dependency factory: wymusza granularne uprawnienie.
    Override per-user (kolumna `permissions`) wygrywa nad domyślnym zestawem roli.
    """
    async def checker(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not has_perm(user, perm):
            raise HTTPException(403, f"Brak uprawnienia: {perm}")
        return user
    return checker


# Nazwane skróty (czytelność importów w routerach)
require_view_financials = require_perm("viewFinancials")
require_edit_containers = require_perm("editContainers")
require_export = require_perm("export")
