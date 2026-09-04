"""
Bezpieczeństwo: hashowanie haseł (bcrypt), tokeny JWT, zależności autoryzacji.

Granularne uprawnienia (require_perm) są AKTYWNE i odwzorowują frontowy can():
override per-user z kolumny `permissions` (JSON) wygrywa nad domyślnym z roli (ROLE_PERMS).
Domyślne zestawy ról są 1:1 z frontend/lib/permissions.js.
"""

from datetime import datetime, timedelta
from typing import List, Optional

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
        text(f"SELECT id, email, role, full_name, is_active, permissions, company_scope FROM {settings.TABLE_USERS} WHERE id = :id"),
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

    return CurrentUser(
        id=u.id, email=u.email, role=u.role, full_name=u.full_name, perms=perms,
        company_scope=parse_company_scope(getattr(u, "company_scope", None)),
    )


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
#
# UWAGA — klucze CELOWO nieobecne poniżej (has_perm zwróci dla nich False dla KAŻDEJ roli,
# łącznie z ADMIN; dostęp daje wyłącznie wpis w kolumnie `permissions` konkretnego usera):
#   · viewOccupancy — Zajętość magazynu (raport + kafelek na pulpicie).
#
# viewBankBalances / editBankBalances — saldo rachunku firmy i pożyczki wspólników.
# Domyślnie TYLKO ADMIN. Oba są KONIUNKCYJNE z viewFinancials (patrz can_view_bank):
# wykres i listy niosą kwoty, więc ktoś z zamaskowanymi finansami nie zobaczy ich tędy.
# editBankBalances bez viewBankBalances nic nie daje — nie ma czego edytować.
# Dopisanie takiego klucza do ROLE_PERMS otworzy go całej roli — rób to świadomie.
#
# viewCalendarPayments — płatności „Do zapłaty" jako zdarzenia kalendarza. Domyślnie TYLKO ADMIN;
# IMPORT/VIEWER dostają dostęp wyłącznie ręcznym ptaszkiem. Uprawnienie jest KONIUNKCYJNE
# z viewFinancials (patrz can_see_calendar_payments) — kalendarz pokazuje kwoty zobowiązań,
# więc ktoś z zamaskowanymi finansami nie zobaczy ich tędy tylnymi drzwiami.
ROLE_PERMS = {
    "ADMIN":  {"editProducts": True,  "editContainers": True,  "import": True,  "export": True,  "generatePO": True,  "viewFinancials": True,  "assistantFinancials": True,  "viewForecast": True,  "manageUsers": True,  "viewAudit": True,  "viewReports": True,  "viewAttachments": True,  "viewCalendarPayments": True,  "viewBankBalances": True,  "editBankBalances": True},
    "IMPORT": {"editProducts": True,  "editContainers": True,  "import": True,  "export": True,  "generatePO": True,  "viewFinancials": True,  "assistantFinancials": False, "viewForecast": True,  "manageUsers": False, "viewAudit": False, "viewReports": False, "viewAttachments": True,  "viewCalendarPayments": False, "viewBankBalances": False, "editBankBalances": False},
    "VIEWER": {"editProducts": False, "editContainers": False, "import": False, "export": True,  "generatePO": False, "viewFinancials": True,  "assistantFinancials": False, "viewForecast": True,  "manageUsers": False, "viewAudit": False, "viewReports": False, "viewAttachments": False, "viewCalendarPayments": False, "viewBankBalances": False, "editBankBalances": False},
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
require_occupancy = require_perm("viewOccupancy")
# Załączniki kontenerów to faktury, proformy i BL — pilnujemy ich osobnym uprawnieniem,
# niezależnym od viewFinancials (viewer widzi wartości w PLN, ale nie ma wglądu w dokumenty).
require_attachments = require_perm("viewAttachments")


def can_view_bank(user: CurrentUser) -> bool:
    """Pieniądze firmy = viewBankBalances ORAZ viewFinancials.

    Koniunkcja, nie alternatywa — dokładnie jak przy płatnościach w kalendarzu.
    Saldo rachunku to kwota, więc bez viewFinancials nie ma prawa się pokazać.
    """
    return has_perm(user, "viewBankBalances") and has_perm(user, "viewFinancials")


def can_edit_bank(user: CurrentUser) -> bool:
    """Edycja wpisów wymaga jeszcze editBankBalances ponad prawo do oglądania."""
    return can_view_bank(user) and has_perm(user, "editBankBalances")


async def require_bank_view(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not can_view_bank(user):
        raise HTTPException(403, "Brak uprawnienia: viewBankBalances")
    return user


async def require_bank_edit(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not can_edit_bank(user):
        raise HTTPException(403, "Brak uprawnienia: editBankBalances")
    return user


def can_see_calendar_payments(user: CurrentUser) -> bool:
    """Płatności w kalendarzu = viewCalendarPayments ORAZ viewFinancials.

    Koniunkcja, nie alternatywa: chip w kalendarzu niesie kwotę i walutę zobowiązania,
    więc bez viewFinancials nie ma prawa się pojawić, choćby ptaszek był postawiony.
    Lustro tej samej reguły siedzi na froncie (permissions.js → canSeeCalendarPayments).
    """
    return has_perm(user, "viewCalendarPayments") and has_perm(user, "viewFinancials")


# ===== ZAKRES FIRMOWY (company_scope) =====
# Ortogonalny do uprawnień: `perms` mówią CO wolno, `company_scope` — CZYJE dane.
#
# Przechowywanie: kolumna TEXT na userze, slugi po przecinku ("acti,veluxa").
# NULL/puste = brak ograniczenia = wszystkie firmy = dzisiejsze zachowanie (zero regresji).
#
# DLACZEGO SERWEROWO: `shop` to parametr z frontu. Bez tego klamrowania każdy zalogowany
# user może wpisać ?shop=amh albo ?shop= (puste = suma wszystkich firm) i zobaczyć cudze dane.
# Przełącznik firm w UI jest tylko lustrem tej reguły, nie zabezpieczeniem.

ALL_SHOPS = ("amh", "acti", "veluxa")


def parse_company_scope(raw) -> Optional[List[str]]:
    """Kolumna → lista slugów albo None (= wszystkie firmy).

    Przyjmuje TEXT po przecinku, listę albo None. Nieznane slugi wypadają po cichu,
    a gdy nic sensownego nie zostanie — zwracamy None, czyli brak ograniczenia.
    Kolejność z ALL_SHOPS, żeby "pierwsza dozwolona firma" była deterministyczna
    niezależnie od tego, w jakiej kolejności admin zaznaczył checkboxy.
    """
    if not raw:
        return None
    if isinstance(raw, (list, tuple, set)):
        items = [str(x) for x in raw]
    else:
        items = str(raw).split(",")
    picked = {i.strip().lower() for i in items if i and i.strip()}
    out = [s for s in ALL_SHOPS if s in picked]
    return out or None


def serialize_company_scope(scope: Optional[List[str]]) -> Optional[str]:
    """Lista slugów → wartość do kolumny. Pusta lista/None → NULL (wszystkie firmy)."""
    parsed = parse_company_scope(scope)
    return ",".join(parsed) if parsed else None


def allowed_shops(user: Optional[CurrentUser]) -> Optional[List[str]]:
    """Dozwolone firmy usera albo None = bez ograniczeń."""
    return getattr(user, "company_scope", None) or None


def resolve_shop(requested: Optional[str], user: Optional[CurrentUser]) -> str:
    """Klamruje parametr `shop` do zakresu usera. Konwencja: "" = wszystkie firmy.

    User bez zakresu → zwracamy `requested` bez zmian (zero regresji).
    User z zakresem  → firma spoza zakresu ORAZ "" (wszystkie) lecą po cichu
    na pierwszą dozwoloną firmę. Cichy override zamiast 403: UI i tak nie pokaże
    zakazanej zakładki, a stary wpis w localStorage nie ma prawa wywalić widoku.
    """
    scope = allowed_shops(user)
    if not scope:
        return requested or ""
    req = (requested or "").strip().lower()
    return req if req in scope else scope[0]


def resolve_scope(requested: Optional[str], user: Optional[CurrentUser]) -> str:
    """To samo dla raportów, które jadą na własnej konwencji: "all" zamiast "".

    Scoped user nigdy nie dostanie "all" — nawet przy dostępie do dwóch firm
    dostaje pierwszą z nich (raporty filtrują po jednym slugu: firma_slug == scope,
    a przełącznik w UI i tak podaje konkretną firmę).
    """
    scope = allowed_shops(user)
    req = (requested or "all").strip().lower()
    if not scope:
        return req
    return req if req in scope else scope[0]
