"""Chińskie SKU — zarządzana lista mapowań SKU → kod fabryczny (CN-SKU).

Osobna tabela (app_cn_sku), niezależna od syncu produktów: dodawanie/edycja/usuwanie
wpisów NIE rusza bazy produktów ani stanów. Nazwa produktu i dostawca są dociągane
po SKU (LEFT JOIN attrs + subquery na tabelę Subiekta) tylko do wyświetlenia.

Zasila wersję EN generatora PO (kod fabryczny zamiast wewnętrznego SKU).
"""

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import CnSkuIn, CnSkuOut, CnSkuBulkIn, CnSkuBulkResult, CurrentUser
from security import get_current_user, require_perm

router = APIRouter(prefix="/api", tags=["cn_sku"])

# Dostęp: to samo uprawnienie co generowanie PO (ADMIN + IMPORT). VIEWER nie widzi.
require_generate_po = require_perm("generatePO")

# Wzbogacony odczyt: nazwa z name_override lub tabeli Subiekta (subquery — bez mnożenia wierszy),
# dostawca z app_product_attrs. SKU spoza bazy produktów pokażą się bez nazwy/dostawcy.
_SELECT = f"""
    SELECT cs.id, cs.sku, cs.cn_sku, cs.en_name,
           COALESCE(
               pa.name_override,
               (SELECT t.{settings.COL_PRODUCT_NAME}
                  FROM {settings.TABLE_PRODUCTS} t
                 WHERE LOWER(TRIM(t.{settings.COL_PRODUCT_SKU})) = LOWER(TRIM(cs.sku))
                 LIMIT 1)
           ) AS product_name,
           pa.manufacturer_id,
           m.name  AS manufacturer_name,
           m.color AS manufacturer_color
    FROM {settings.TABLE_CN_SKU} cs
    LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa ON LOWER(TRIM(pa.sku)) = LOWER(TRIM(cs.sku))
    LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = pa.manufacturer_id
"""


async def _fetch_one(db: AsyncSession, row_id: int) -> Optional[CnSkuOut]:
    r = await db.execute(text(_SELECT + " WHERE cs.id = :id"), {"id": row_id})
    row = r.mappings().first()
    return CnSkuOut(**dict(row)) if row else None


async def _upsert(db: AsyncSession, sku: str, cn_sku: str, en_name: Optional[str] = None) -> str:
    """Wstaw lub zaktualizuj po znormalizowanym SKU (LOWER(TRIM)). Zwraca 'inserted' | 'updated'.
    en_name = None nie kasuje istniejącej wartości (COALESCE); "" (pusty string) czyści."""
    sku = sku.strip()
    cn_sku = cn_sku.strip()
    en = en_name.strip() if en_name is not None else None
    existing = await db.execute(
        text(f"SELECT id FROM {settings.TABLE_CN_SKU} WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku))"),
        {"sku": sku},
    )
    hit = existing.scalar_one_or_none()
    if hit is not None:
        await db.execute(
            text(f"""UPDATE {settings.TABLE_CN_SKU}
                        SET cn_sku = :cn,
                            en_name = COALESCE(:en, en_name),
                            updated_at = CURRENT_TIMESTAMP
                      WHERE id = :id"""),
            {"cn": cn_sku, "en": (en or None) if en is not None else None, "id": hit},
        )
        return "updated"
    await db.execute(
        text(f"INSERT INTO {settings.TABLE_CN_SKU} (sku, cn_sku, en_name) VALUES (:sku, :cn, :en)"),
        {"sku": sku, "cn": cn_sku, "en": (en or None)},
    )
    return "inserted"


@router.get("/cn-sku", response_model=List[CnSkuOut])
async def list_cn_sku(
    q: Optional[str] = Query(None),
    manufacturer_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_generate_po),
):
    conds = []
    params: dict = {}
    if q and q.strip():
        conds.append("(cs.sku ILIKE :q OR cs.cn_sku ILIKE :q OR cs.en_name ILIKE :q OR pa.name_override ILIKE :q)")
        params["q"] = f"%{q.strip()}%"
    if manufacturer_id:
        conds.append("pa.manufacturer_id = :mfr")
        params["mfr"] = manufacturer_id
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    r = await db.execute(text(_SELECT + where + " ORDER BY cs.sku"), params)
    return [CnSkuOut(**dict(row)) for row in r.mappings()]


@router.post("/cn-sku", response_model=CnSkuOut, status_code=201)
async def create_cn_sku(payload: CnSkuIn, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_generate_po)):
    await _upsert(db, payload.sku, payload.cn_sku, payload.en_name)
    await db.commit()
    r = await db.execute(
        text(f"SELECT id FROM {settings.TABLE_CN_SKU} WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku))"),
        {"sku": payload.sku.strip()},
    )
    row_id = r.scalar_one()
    out = await _fetch_one(db, row_id)
    if out is None:
        raise HTTPException(500, "Zapis nie powiódł się")
    return out


@router.patch("/cn-sku/{row_id}", response_model=CnSkuOut)
async def update_cn_sku(row_id: int, payload: CnSkuIn, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_generate_po)):
    r = await db.execute(
        text(f"""UPDATE {settings.TABLE_CN_SKU}
                    SET sku = :sku, cn_sku = :cn, en_name = :en, updated_at = CURRENT_TIMESTAMP
                  WHERE id = :id"""),
        {"sku": payload.sku.strip(), "cn": payload.cn_sku.strip(),
         "en": ((payload.en_name or "").strip() or None), "id": row_id},
    )
    if r.rowcount == 0:
        raise HTTPException(404)
    await db.commit()
    out = await _fetch_one(db, row_id)
    if out is None:
        raise HTTPException(404)
    return out


@router.delete("/cn-sku/{row_id}", status_code=204)
async def delete_cn_sku(row_id: int, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_generate_po)):
    r = await db.execute(text(f"DELETE FROM {settings.TABLE_CN_SKU} WHERE id = :id"), {"id": row_id})
    await db.commit()
    if r.rowcount == 0:
        raise HTTPException(404)


@router.post("/cn-sku/bulk", response_model=CnSkuBulkResult)
async def bulk_cn_sku(payload: CnSkuBulkIn, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(require_generate_po)):
    """Masowy upsert (wklejka z Excela). Duplikaty SKU w obrębie wsadu: ostatni wygrywa."""
    inserted = updated = 0
    for row in payload.rows:
        sku = (row.sku or "").strip()
        cn = (row.cn_sku or "").strip()
        if not sku or not cn:
            continue
        res = await _upsert(db, sku, cn, row.en_name)
        if res == "inserted":
            inserted += 1
        else:
            updated += 1
    await db.commit()
    return CnSkuBulkResult(inserted=inserted, updated=updated)
