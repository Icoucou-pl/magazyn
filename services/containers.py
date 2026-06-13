"""
Logika kontenerów: pobieranie kontenerów z pozycjami, załącznikami i wyliczeniami
(total_units, total_cbm, fill_percentage, total_value).
"""

from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from models import ContainerOut, ContainerItemOut, AttachmentOut


async def fetch_attachments(db: AsyncSession, container_id: int) -> List[AttachmentOut]:
    r = await db.execute(
        text(f"SELECT id, filename, file_type, file_size, uploaded_at FROM {settings.TABLE_ATTACHMENTS} WHERE container_id = :c ORDER BY uploaded_at DESC"),
        {"c": container_id},
    )
    return [AttachmentOut(**dict(row._mapping)) for row in r]


async def fetch_containers(db: AsyncSession, status: Optional[str] = None) -> List[ContainerOut]:
    """Lista kontenerów z pozycjami + załącznikami + wyliczeniami wypełnienia/wartości."""
    where = "WHERE c.status = :status" if status else ""
    r = await db.execute(text(f"""
        SELECT
            c.id, c.container_number, c.order_number, c.container_type_id, c.manufacturer_id,
            c.order_date, c.eta_date, c.status, c.notes,
            ct.name AS container_type_name, ct.capacity_cbm AS container_capacity_cbm,
            m.name AS manufacturer_name, m.color AS manufacturer_color,
            ci.id AS item_id, ci.sku, ci.quantity, ci.unit_cost,
            p.{settings.COL_PRODUCT_NAME} AS product_name,
            COALESCE(pa.cbm_per_unit, 0) AS cbm_per_unit
        FROM {settings.TABLE_CONTAINERS} c
        LEFT JOIN {settings.TABLE_CONTAINER_TYPES} ct ON ct.id = c.container_type_id
        LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = c.manufacturer_id
        LEFT JOIN {settings.TABLE_CONTAINER_ITEMS} ci ON ci.container_id = c.id
        LEFT JOIN {settings.TABLE_PRODUCTS} p ON p.{settings.COL_PRODUCT_SKU} = ci.sku
        LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa ON pa.sku = ci.sku
        {where}
        ORDER BY c.eta_date DESC, c.id DESC, ci.id ASC
    """), {"status": status} if status else {})

    rows = [dict(row._mapping) for row in r]
    containers_dict = {}
    for row in rows:
        cid = row["id"]
        if cid not in containers_dict:
            cap = float(row["container_capacity_cbm"]) if row["container_capacity_cbm"] else None
            containers_dict[cid] = {
                "id": cid, "container_number": row["container_number"],
                "order_number": row["order_number"],
                "container_type_id": row["container_type_id"],
                "container_type_name": row["container_type_name"],
                "container_capacity_cbm": cap,
                "manufacturer_id": row["manufacturer_id"],
                "manufacturer_name": row["manufacturer_name"],
                "manufacturer_color": row["manufacturer_color"],
                "order_date": row["order_date"], "eta_date": row["eta_date"],
                "status": row["status"], "notes": row["notes"],
                "items": [], "attachments": [],
                "total_units": 0, "total_cbm": 0.0, "fill_percentage": None, "total_value": 0.0,
            }
        if row["item_id"] is not None:
            cbm_pu = float(row["cbm_per_unit"]) if row["cbm_per_unit"] else 0
            tcb = cbm_pu * row["quantity"]
            cost = float(row["unit_cost"]) if row["unit_cost"] else 0
            containers_dict[cid]["items"].append(ContainerItemOut(
                id=row["item_id"], sku=row["sku"], quantity=row["quantity"],
                unit_cost=cost if cost else None, product_name=row["product_name"],
                cbm_per_unit=cbm_pu, total_cbm=round(tcb, 3),
            ))
            containers_dict[cid]["total_units"] += row["quantity"]
            containers_dict[cid]["total_cbm"] += tcb
            containers_dict[cid]["total_value"] += cost * row["quantity"]

    # Załączniki dla każdego kontenera
    for cid in containers_dict:
        containers_dict[cid]["attachments"] = await fetch_attachments(db, cid)

    for c in containers_dict.values():
        c["total_cbm"] = round(c["total_cbm"], 3)
        c["total_value"] = round(c["total_value"], 2)
        if c["container_capacity_cbm"] and c["container_capacity_cbm"] > 0:
            c["fill_percentage"] = round((c["total_cbm"] / c["container_capacity_cbm"]) * 100, 1)

    return [ContainerOut(**c) for c in containers_dict.values()]


async def get_container_by_id(db: AsyncSession, cid: int) -> ContainerOut:
    cs = await fetch_containers(db)
    for c in cs:
        if c.id == cid:
            return c
    raise HTTPException(404)
