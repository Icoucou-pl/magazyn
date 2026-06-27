"""Firmy (sklepy: AMH / Acti / Veluxa) — odczyt + konfiguracja.

Każda firma = jeden Sellasist. AMH jest hubem (is_self, stan z Subiektu).
Klucze API trzymane są w zmiennych środowiskowych (Railway) — w bazie jest tylko
NAZWA zmiennej (api_key_env), nigdy sam klucz. `configured` = gotowa do ingestu.

Guard: odczyt = zalogowany; edycja = ADMIN (to konfiguracja).
"""

import os
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import CurrentUser, FirmaOut, FirmaUpdate
from security import get_current_user, require_admin

router = APIRouter(prefix="/api", tags=["firmy"])

_COLS = "id, slug, name, color, is_self, base_url, api_key_env, sort_order"


def _to_out(r) -> FirmaOut:
    key_present = bool(os.getenv(r["api_key_env"])) if r["api_key_env"] else False
    configured = bool(r["is_self"]) or (bool(r["base_url"]) and key_present)
    return FirmaOut(
        id=r["id"], slug=r["slug"], name=r["name"], color=r["color"],
        is_self=bool(r["is_self"]), base_url=r["base_url"], api_key_env=r["api_key_env"],
        key_present=key_present, configured=configured, sort_order=r["sort_order"] or 0,
    )


@router.get("/firmy", response_model=List[FirmaOut])
async def list_firmy(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    r = await db.execute(text(f"SELECT {_COLS} FROM {settings.TABLE_FIRMY} ORDER BY sort_order, id"))
    return [_to_out(row) for row in r.mappings()]


@router.patch("/firmy/{fid}", response_model=FirmaOut)
async def update_firma(fid: int, payload: FirmaUpdate, db: AsyncSession = Depends(get_db), admin: CurrentUser = Depends(require_admin)):
    fields, params = [], {"id": fid}
    for col in ("name", "color", "base_url", "sort_order"):
        val = getattr(payload, col)
        if val is not None:
            fields.append(f"{col} = :{col}")
            params[col] = val
    if fields:
        await db.execute(text(f"UPDATE {settings.TABLE_FIRMY} SET {', '.join(fields)} WHERE id = :id"), params)
        await db.commit()
    row = (await db.execute(text(f"SELECT {_COLS} FROM {settings.TABLE_FIRMY} WHERE id = :id"), {"id": fid})).mappings().first()
    if not row:
        raise HTTPException(404, "Firma nie znaleziona")
    return _to_out(row)
