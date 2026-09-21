"""Uwierzytelnianie partnera. Dwie drogi, jeden wynik.

  · Bearer JWT   — człowiek zalogowany w portalu (dropy.users)
  · X-Drop-Key   — maszyna, czyli sklep partnera strzelający do API

W obu wypadkach partnera bierzemy z poświadczenia, NIGDY z treści żądania.
Nie ma więc parametru „czyje zamówienie" — nie da się podać cudzego id.
"""

import hashlib
from datetime import datetime, timedelta
from typing import Dict, Optional

from fastapi import Depends, Header, HTTPException
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from db import get_db

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_token(user_id: int, partner_id: int, email: str) -> str:
    payload = {
        "sub": str(user_id),
        "pid": partner_id,
        "email": email,
        "aud": settings.JWT_AUDIENCE,
        "exp": datetime.utcnow() + timedelta(hours=settings.JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


class Partner:
    """Partner rozpoznany z poświadczenia."""

    def __init__(self, row: dict, via: str, user_id: Optional[int] = None,
                 key_label: Optional[str] = None, key_hint: Optional[str] = None,
                 terms: Optional[Dict[str, str]] = None):
        self.id = row["id"]
        self.code = row["code"]
        self.name = row["name"]
        self.firmy = [f.strip().lower() for f in (row["firmy"] or "").split(",") if f.strip()]
        # Tryb płatności jest per firma (dropy.partner_terms). payment_mode partnera
        # to tylko wartość domyślna dla firmy, która nie ma jeszcze własnego wpisu.
        self.default_mode = row["payment_mode"] or "zbiorcza"
        self.terms = {f: (terms or {}).get(f, self.default_mode) for f in self.firmy}
        self.credit_limit = float(row["credit_limit"]) if row["credit_limit"] is not None else None
        self.address = row["address"]
        self.via = via                     # 'portal' albo 'api'
        self.user_id = user_id
        self.key_label = key_label         # przy API: nazwa i końcówka klucza — do logów
        self.key_hint = key_hint

    def mode(self, firma: str) -> str:
        return self.terms.get(firma, self.default_mode)

    @property
    def payment_mode(self) -> str:
        """Wspólny tryb, gdy wszystkie firmy mają ten sam — inaczej „mieszana”."""
        modes = set(self.terms.values()) or {self.default_mode}
        return modes.pop() if len(modes) == 1 else "mieszana"

    @property
    def has_credit(self) -> bool:
        """Limit kupiecki ma sens tylko tam, gdzie kupuje na fakturę zbiorczą."""
        return self.credit_limit is not None and "zbiorcza" in self.terms.values()


async def _partner_row(db: AsyncSession, pid: int) -> dict:
    r = await db.execute(text("SELECT * FROM dropy.partners WHERE id = :id AND is_active"), {"id": pid})
    row = r.mappings().first()
    if not row:
        raise HTTPException(403, "Konto partnera jest nieaktywne")
    return dict(row)


async def _partner_terms(db: AsyncSession, pid: int) -> Dict[str, str]:
    r = await db.execute(text("SELECT firma, payment_mode FROM dropy.partner_terms WHERE partner_id = :id"), {"id": pid})
    return {x["firma"]: x["payment_mode"] for x in r.mappings()}


async def current_partner(
    authorization: Optional[str] = Header(None),
    x_drop_key: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> Partner:
    if x_drop_key:
        digest = hashlib.sha256(x_drop_key.strip().encode()).hexdigest()
        r = await db.execute(
            text("SELECT partner_id, label, key_hint FROM dropy.api_keys WHERE key_hash = :h AND is_active"),
            {"h": digest},
        )
        row = r.first()
        if not row:
            raise HTTPException(401, "Nieprawidłowy klucz API")
        await db.execute(
            text("UPDATE dropy.api_keys SET last_used = CURRENT_TIMESTAMP WHERE key_hash = :h"),
            {"h": digest},
        )
        await db.commit()
        return Partner(await _partner_row(db, row[0]), via="api", key_label=row[1], key_hint=row[2],
                       terms=await _partner_terms(db, row[0]))

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Wymagane logowanie")
    try:
        payload = jwt.decode(
            authorization.split(" ", 1)[1],
            settings.JWT_SECRET,
            algorithms=[settings.JWT_ALGORITHM],
            audience=settings.JWT_AUDIENCE,
        )
    except JWTError:
        raise HTTPException(401, "Sesja wygasła, zaloguj się ponownie")

    uid = int(payload.get("sub", 0))
    r = await db.execute(
        text("SELECT id, partner_id FROM dropy.users WHERE id = :id AND is_active"),
        {"id": uid},
    )
    u = r.mappings().first()
    if not u:
        raise HTTPException(401, "Konto nie istnieje albo jest wyłączone")
    return Partner(await _partner_row(db, u["partner_id"]), via="portal", user_id=u["id"],
                   terms=await _partner_terms(db, u["partner_id"]))
