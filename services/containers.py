"""
Logika kontenerów: pobieranie kontenerów z pozycjami, załącznikami i wyliczeniami
(total_units, total_cbm, fill_percentage, total_value).
"""

from typing import List, Optional, Tuple
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from models import ContainerOut, ContainerItemOut, ContainerLotOut, AttachmentOut

# Strefa PL — żeby status liczony z ETA przeskakiwał o północy w Polsce, nie w UTC.
try:
    from zoneinfo import ZoneInfo
    _TZ_PL = ZoneInfo("Europe/Warsaw")
except Exception:  # brak bazy tzdata na obrazie — fallback do czasu serwera
    _TZ_PL = None


# Slug firmy przypisywany pozycjom bez firma_id (NULL = AMH, hub/reseller).
DEFAULT_FIRMA_SLUG = "amh"
DEFAULT_FIRMA_NAME = "AMH"


def _today_pl() -> date:
    if _TZ_PL is not None:
        try:
            return datetime.now(_TZ_PL).date()
        except Exception:
            pass
    return datetime.utcnow().date()


def compute_effective_status(stored: str, eta: Optional[date]) -> Tuple[str, bool, Optional[int]]:
    """Zwraca (effective_status, is_auto, customs_days_left).

    Reguły (CONTAINER_CUSTOMS_DAYS = okno odprawy, domyślnie 7 dni):
      - ręczny DELIVERED zawsze wygrywa → ('DELIVERED', False, None);
      - dzień <= ETA → status ręczny, bez automatu;
      - ETA+1 .. ETA+N → 'CUSTOMS' (Odprawa celna), z licznikiem dni do auto-dostawy;
      - dzień >= ETA+N+1 → 'DELIVERED' automatycznie.
    """
    if stored == "DELIVERED":
        return "DELIVERED", False, None
    if eta is None:
        return stored, False, None

    n = max(0, int(settings.CONTAINER_CUSTOMS_DAYS))
    days_after = (_today_pl() - eta).days

    if days_after <= 0:
        return stored, False, None
    if n > 0 and days_after <= n:
        # na ETA+1 zostaje N dni, na ETA+N zostaje 1 dzień
        return "CUSTOMS", True, (n - days_after + 1)
    return "DELIVERED", True, None


async def fetch_attachments(db: AsyncSession, container_id: int) -> List[AttachmentOut]:
    r = await db.execute(
        text(f"SELECT id, filename, file_type, file_size, uploaded_at FROM {settings.TABLE_ATTACHMENTS} WHERE container_id = :c ORDER BY uploaded_at DESC"),
        {"c": container_id},
    )
    return [AttachmentOut(**dict(row._mapping)) for row in r]


async def fetch_lots(db: AsyncSession, container_id: int, lot_totals: dict) -> List[ContainerLotOut]:
    r = await db.execute(text(f"""
        SELECT l.id, l.manufacturer_id, l.order_number, l.position,
               l.waluta_towaru, l.zaliczka_procent, l.zaliczka_kwota, l.zaliczka_data,
               l.balance_kwota, l.zaplacono_data,
               m.name AS manufacturer_name, m.color AS manufacturer_color
        FROM {settings.TABLE_CONTAINER_LOTS} l
        LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = l.manufacturer_id
        WHERE l.container_id = :c
        ORDER BY l.position ASC, l.id ASC
    """), {"c": container_id})
    out = []
    for row in r:
        d = dict(row._mapping)
        t = lot_totals.get(d["id"], {"u": 0, "cbm": 0.0, "val": 0.0})
        out.append(ContainerLotOut(
            id=d["id"], manufacturer_id=d["manufacturer_id"],
            manufacturer_name=d["manufacturer_name"], manufacturer_color=d["manufacturer_color"],
            order_number=d["order_number"],
            waluta_towaru=(d["waluta_towaru"] or "USD"),
            zaliczka_procent=(float(d["zaliczka_procent"]) if d["zaliczka_procent"] is not None else None),
            zaliczka_kwota=(float(d["zaliczka_kwota"]) if d["zaliczka_kwota"] is not None else None),
            zaliczka_data=d["zaliczka_data"],
            balance_kwota=(float(d["balance_kwota"]) if d["balance_kwota"] is not None else None),
            zaplacono_data=d["zaplacono_data"],
            total_units=t["u"], total_cbm=round(t["cbm"], 3), total_value=round(t["val"], 2),
        ))
    return out


async def fetch_containers(db: AsyncSession, status: Optional[str] = None) -> List[ContainerOut]:
    """Lista kontenerów z pozycjami + załącznikami + wyliczeniami wypełnienia/wartości."""
    where = "WHERE c.status = :status" if status else ""
    r = await db.execute(text(f"""
        SELECT
            c.id, c.container_number, c.order_number, c.container_type_id, c.manufacturer_id,
            c.order_date, c.eta_date, c.status, c.notes, c.is_consolidated,
            c.koszt_transportu, c.koszt_spedycji, c.folder, c.subiekt_nr,
            c.waluta_towaru, c.zaliczka_procent, c.zaliczka_kwota, c.zaliczka_data,
            c.balance_kwota, c.zaplacono_data,
            ct.name AS container_type_name, ct.capacity_cbm AS container_capacity_cbm,
            m.name AS manufacturer_name, m.color AS manufacturer_color,
            ci.id AS item_id, ci.sku, ci.quantity, ci.unit_cost, ci.lot_id,
            p.{settings.COL_PRODUCT_NAME} AS product_name,
            COALESCE(p.{settings.COL_PRODUCT_PRICE}, 0) AS purchase_price,
            COALESCE(pa.cbm_per_unit, 0) AS cbm_per_unit,
            pa.firma_id,
            f.slug AS firma_slug, f.name AS firma_name, f.color AS firma_color
        FROM {settings.TABLE_CONTAINERS} c
        LEFT JOIN {settings.TABLE_CONTAINER_TYPES} ct ON ct.id = c.container_type_id
        LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = c.manufacturer_id
        LEFT JOIN {settings.TABLE_CONTAINER_ITEMS} ci ON ci.container_id = c.id
        LEFT JOIN {settings.TABLE_PRODUCTS} p ON p.{settings.COL_PRODUCT_SKU} = ci.sku
        LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa ON pa.sku = ci.sku
        LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = pa.firma_id
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
                "status": row["status"],
                "effective_status": row["status"], "is_auto": False, "customs_days_left": None,
                "is_consolidated": bool(row["is_consolidated"]),
                "lots": [], "_lot_totals": {},
                "koszt_transportu": (float(row["koszt_transportu"]) if row["koszt_transportu"] is not None else None),
                "koszt_spedycji": (float(row["koszt_spedycji"]) if row["koszt_spedycji"] is not None else None),
                "oplata_spedycji": None,   # liczone niżej: koszt_spedycji − koszt_transportu
                "folder": row["folder"],
                "subiekt_nr": row["subiekt_nr"],
                "waluta_towaru": row["waluta_towaru"] or "USD",
                "zaliczka_procent": (float(row["zaliczka_procent"]) if row["zaliczka_procent"] is not None else None),
                "zaliczka_kwota": (float(row["zaliczka_kwota"]) if row["zaliczka_kwota"] is not None else None),
                "zaliczka_data": row["zaliczka_data"],
                "balance_kwota": (float(row["balance_kwota"]) if row["balance_kwota"] is not None else None),
                "zaplacono_data": row["zaplacono_data"],
                "notes": row["notes"],
                "items": [], "attachments": [],
                "total_units": 0, "total_cbm": 0.0, "fill_percentage": None, "total_value": 0.0,
                "firma_breakdown": {},
            }
        if row["item_id"] is not None:
            cbm_pu = float(row["cbm_per_unit"]) if row["cbm_per_unit"] else 0
            tcb = cbm_pu * row["quantity"]
            # Koszt jednostkowy: jeśli pozycja nie ma własnego unit_cost,
            # podstaw cenę zakupu produktu (cena_zakupu_netto) — tak jak liczona jest wartość magazynu.
            unit = float(row["unit_cost"]) if row["unit_cost"] else 0
            eff_cost = unit if unit else float(row["purchase_price"] or 0)
            containers_dict[cid]["items"].append(ContainerItemOut(
                id=row["item_id"], sku=row["sku"], quantity=row["quantity"],
                unit_cost=unit if unit else None, lot_id=row["lot_id"], product_name=row["product_name"],
                cbm_per_unit=cbm_pu, total_cbm=round(tcb, 3),
            ))
            containers_dict[cid]["total_units"] += row["quantity"]
            containers_dict[cid]["total_cbm"] += tcb
            containers_dict[cid]["total_value"] += eff_cost * row["quantity"]
            # Rozbicie per firma (sklep). Kontener nie ma własnej firmy — wynika ona
            # z właściciela SKU. SKU bez firma_id => AMH (NULL = AMH).
            slug = (row["firma_slug"] or DEFAULT_FIRMA_SLUG).strip().lower()
            fb = containers_dict[cid]["firma_breakdown"].setdefault(slug, {
                "slug": slug,
                "name": row["firma_name"] or (DEFAULT_FIRMA_NAME if slug == DEFAULT_FIRMA_SLUG else slug.upper()),
                "color": row["firma_color"],
                "items": 0, "units": 0, "value": 0.0,
            })
            if fb["color"] is None and row["firma_color"]:
                fb["color"] = row["firma_color"]
            fb["items"] += 1
            fb["units"] += row["quantity"]
            fb["value"] += eff_cost * row["quantity"]

            lid = row["lot_id"]
            if lid is not None:
                lt = containers_dict[cid]["_lot_totals"].setdefault(lid, {"u": 0, "cbm": 0.0, "val": 0.0})
                lt["u"] += row["quantity"]
                lt["cbm"] += tcb
                lt["val"] += eff_cost * row["quantity"]

    # Załączniki + loty dla każdego kontenera
    for cid in containers_dict:
        containers_dict[cid]["attachments"] = await fetch_attachments(db, cid)
        containers_dict[cid]["lots"] = await fetch_lots(db, cid, containers_dict[cid]["_lot_totals"])

    for c in containers_dict.values():
        c.pop("_lot_totals", None)
        c["total_cbm"] = round(c["total_cbm"], 3)
        c["total_value"] = round(c["total_value"], 2)
        for fb in c["firma_breakdown"].values():
            fb["value"] = round(fb["value"], 2)
        # opłata dla spedycji = cały rachunek spedytora − sam koszt transportu (fracht)
        if c["koszt_spedycji"] is not None and c["koszt_transportu"] is not None:
            c["oplata_spedycji"] = round(c["koszt_spedycji"] - c["koszt_transportu"], 2)
        if c["container_capacity_cbm"] and c["container_capacity_cbm"] > 0:
            c["fill_percentage"] = round((c["total_cbm"] / c["container_capacity_cbm"]) * 100, 1)
        eff, is_auto, days_left = compute_effective_status(c["status"], c["eta_date"])
        c["effective_status"] = eff
        c["is_auto"] = is_auto
        c["customs_days_left"] = days_left

    return [ContainerOut(**c) for c in containers_dict.values()]


async def get_container_by_id(db: AsyncSession, cid: int) -> ContainerOut:
    cs = await fetch_containers(db)
    for c in cs:
        if c.id == cid:
            return c
    raise HTTPException(404)
