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
from models import CurrentUser, FirmaOut, FirmaUpdate, FirmaAssignRequest
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
        product_count=int(r["product_count"]) if "product_count" in r and r["product_count"] is not None else 0,
    )


@router.get("/firmy", response_model=List[FirmaOut])
async def list_firmy(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    r = await db.execute(text(
        f"SELECT f.id, f.slug, f.name, f.color, f.is_self, f.base_url, f.api_key_env, f.sort_order, "
        f"COALESCE(pc.cnt, 0) AS product_count "
        f"FROM {settings.TABLE_FIRMY} f "
        f"LEFT JOIN (SELECT firma_id, COUNT(*) AS cnt FROM {settings.TABLE_PRODUCT_ATTRS} "
        f"          WHERE firma_id IS NOT NULL GROUP BY firma_id) pc ON pc.firma_id = f.id "
        f"ORDER BY f.sort_order, f.id"
    ))
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


@router.post("/firmy/{fid}/assign-products")
async def assign_products(fid: int, payload: FirmaAssignRequest, db: AsyncSession = Depends(get_db), admin: CurrentUser = Depends(require_admin)):
    """Masowo: wszystkie produkty danego producenta dostają firmę macierzystą = fid.
    Bootstrap pod multi-sklep — uruchom ZANIM wyczyścisz producentów Acti/Veluxa."""
    f = (await db.execute(text(f"SELECT id FROM {settings.TABLE_FIRMY} WHERE id = :id"), {"id": fid})).first()
    if not f:
        raise HTTPException(404, "Firma nie znaleziona")
    r = await db.execute(
        text(f"UPDATE {settings.TABLE_PRODUCT_ATTRS} SET firma_id = :fid, updated_at = CURRENT_TIMESTAMP "
             f"WHERE manufacturer_id = :mfr"),
        {"fid": fid, "mfr": payload.manufacturer_id},
    )
    await db.commit()
    return {"assigned": r.rowcount or 0}
