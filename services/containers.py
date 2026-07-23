"""
Logika kontenerów: pobieranie kontenerów z pozycjami, załącznikami i wyliczeniami
(total_units, total_cbm, fill_percentage, total_value).
"""

from typing import List, Optional, Tuple
from datetime import date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from models import ContainerOut, ContainerItemOut, ContainerLotOut, ContainerAdvanceOut, AttachmentOut

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


def compute_effective_status(
    stored: str,
    eta: Optional[date],
    expected: Optional[date] = None,
) -> Tuple[str, bool, Optional[int]]:
    """Zwraca (effective_status, is_auto, customs_days_left).

    Reguły (CONTAINER_CUSTOMS_DAYS = okno odprawy, domyślnie 7 dni):
      - ręczny DELIVERED zawsze wygrywa → ('DELIVERED', False, None);
      - dzień <= ETA → status ręczny, bez automatu;
      - ETA+1 .. ETA+N → 'CUSTOMS' (Odprawa celna), z licznikiem dni do auto-dostawy;
      - dzień >= ETA+N+1 → 'DELIVERED' automatycznie.

    `expected` = ręcznie wpisana data „u nas" (umówiony odbiór, znana w trakcie odprawy).
    Gdy jest podana, ZASTĘPUJE szacowane okno odprawy: do dnia poprzedzającego kontener
    jest w 'CUSTOMS' z licznikiem liczonym do tej daty, a od niej wchodzi auto-dostawa.
    Sama data NIE domyka statusu (to robi dopiero delivered_date) — data jutrzejsza nie
    zapala „Dostarczono".
    """
    if stored == "DELIVERED":
        return "DELIVERED", False, None
    if eta is None:
        return stored, False, None

    today = _today_pl()

    if expected is not None:
        days_left = (expected - today).days
        if days_left > 0:
            # przed umówionym odbiorem: odprawa dopiero po ETA, wcześniej status ręczny
            if (today - eta).days <= 0:
                return stored, False, None
            return "CUSTOMS", True, days_left
        return "DELIVERED", True, None

    n = max(0, int(settings.CONTAINER_CUSTOMS_DAYS))
    days_after = (today - eta).days

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
               l.waluta_towaru, l.zaliczka_procent, l.zaliczka_kwota, l.zaliczka_waluta, l.zaliczka_data,
               l.balance_kwota, l.balance_waluta, l.zaplacono_data,
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
            zaliczka_waluta=(d["zaliczka_waluta"] or d["waluta_towaru"] or "USD"),
            zaliczka_data=d["zaliczka_data"],
            balance_kwota=(float(d["balance_kwota"]) if d["balance_kwota"] is not None else None),
            balance_waluta=(d["balance_waluta"] or d["waluta_towaru"] or "USD"),
            zaplacono_data=d["zaplacono_data"],
            total_units=t["u"], total_cbm=round(t["cbm"], 3), total_value=round(t["val"], 2),
        ))
    return out


async def fetch_attachments_bulk(db: AsyncSession, container_ids: List[int]) -> dict:
    """Załączniki dla wielu kontenerów jednym zapytaniem (zamiast N× fetch_attachments).
    Zwraca {container_id: [AttachmentOut,...]}; kolejność w obrębie kontenera jak w wersji per-kontener (uploaded_at DESC)."""
    if not container_ids:
        return {}
    r = await db.execute(
        text(f"SELECT container_id, id, filename, file_type, file_size, uploaded_at "
             f"FROM {settings.TABLE_ATTACHMENTS} WHERE container_id = ANY(:ids) "
             f"ORDER BY container_id, uploaded_at DESC"),
        {"ids": list(container_ids)},
    )
    out: dict = {}
    for row in r:
        d = dict(row._mapping)
        cid = d.pop("container_id")
        out.setdefault(cid, []).append(AttachmentOut(**d))
    return out


async def fetch_advances_bulk(db: AsyncSession, container_ids: List[int], lot_ids: List[int]):
    """Zaliczki (raty) dla wielu kontenerów i lotów jednym zapytaniem.
    Zwraca (by_container, by_lot): {parent_id: [ContainerAdvanceOut,...]} w kolejności position."""
    by_container: dict = {}
    by_lot: dict = {}
    ids_c = list(container_ids or [])
    ids_l = list(lot_ids or [])
    if not ids_c and not ids_l:
        return by_container, by_lot
    r = await db.execute(text(f"""
        SELECT id, container_id, lot_id, position, procent, kwota, waluta, data
        FROM {settings.TABLE_CONTAINER_ADVANCES}
        WHERE container_id = ANY(:cids) OR lot_id = ANY(:lids)
        ORDER BY position ASC, id ASC
    """), {"cids": (ids_c or [0]), "lids": (ids_l or [0])})
    for row in r:
        d = dict(row._mapping)
        adv = ContainerAdvanceOut(
            id=d["id"],
            procent=(float(d["procent"]) if d["procent"] is not None else None),
            kwota=(float(d["kwota"]) if d["kwota"] is not None else None),
            waluta=(d["waluta"] or "USD"),
            data=d["data"],
        )
        if d["container_id"] is not None:
            by_container.setdefault(d["container_id"], []).append(adv)
        elif d["lot_id"] is not None:
            by_lot.setdefault(d["lot_id"], []).append(adv)
    return by_container, by_lot


async def fetch_payments_pln(db: AsyncSession, container_ids: List[int], lot_ids: List[int]):
    """Faktycznie zapłacone kwoty w PLN — per kontener i per lot.

    Liczymy TYLKO wpłaty, które naprawdę wyszły: zaliczka musi mieć wypełnioną datę,
    balance — `zaplacono_data`, i obie nie mogą być z przyszłości (rata wpisana z
    wyprzedzeniem to plan, nie płatność).

    Przewalutowanie: średni kurs NBP z ostatniego dnia notowań POPRZEDZAJĄCEGO wpłatę
    (`rate_date < data`), zgodnie z regułą podatkową — LATERAL sam przeskakuje weekendy
    i święta. Brak kursu nie zeruje wpłaty po cichu: wiersz nie wchodzi do sumy (SUM
    pomija NULL-e), ale ląduje w liczniku `brak_kursu`, który front pokazuje jako
    ostrzeżenie z możliwością dociągnięcia kursów.

    Zwraca (by_container, by_lot): {id: {"pln": float, "brak_kursu": int}}.
    """
    by_container: dict = {}
    by_lot: dict = {}
    ids_c = list(container_ids or [])
    ids_l = list(lot_ids or [])
    if not ids_c and not ids_l:
        return by_container, by_lot

    r = await db.execute(text(f"""
        WITH pay AS (
            SELECT a.container_id, a.lot_id, a.kwota AS kwota, UPPER(a.waluta) AS waluta, a.data AS data
            FROM {settings.TABLE_CONTAINER_ADVANCES} a
            WHERE (a.container_id = ANY(:cids) OR a.lot_id = ANY(:lids))
              AND a.kwota IS NOT NULL AND a.data IS NOT NULL AND a.data <= CURRENT_DATE
            UNION ALL
            SELECT c.id, NULL, c.balance_kwota, UPPER(c.balance_waluta), c.zaplacono_data
            FROM {settings.TABLE_CONTAINERS} c
            WHERE c.id = ANY(:cids)
              AND c.balance_kwota IS NOT NULL AND c.zaplacono_data IS NOT NULL
              AND c.zaplacono_data <= CURRENT_DATE
            UNION ALL
            SELECT NULL, l.id, l.balance_kwota, UPPER(l.balance_waluta), l.zaplacono_data
            FROM {settings.TABLE_CONTAINER_LOTS} l
            WHERE l.id = ANY(:lids)
              AND l.balance_kwota IS NOT NULL AND l.zaplacono_data IS NOT NULL
              AND l.zaplacono_data <= CURRENT_DATE
        )
        SELECT p.container_id, p.lot_id,
               COALESCE(SUM(CASE WHEN COALESCE(p.waluta, 'PLN') = 'PLN'
                                 THEN p.kwota ELSE p.kwota * fx.mid END), 0) AS pln,
               COUNT(*) FILTER (WHERE COALESCE(p.waluta, 'PLN') <> 'PLN' AND fx.mid IS NULL) AS brak_kursu
        FROM pay p
        LEFT JOIN LATERAL (
            SELECT r.mid
            FROM {settings.TABLE_FX_RATES} r
            WHERE r.currency = p.waluta AND r.rate_date < p.data
            ORDER BY r.rate_date DESC
            LIMIT 1
        ) fx ON TRUE
        GROUP BY p.container_id, p.lot_id
    """), {"cids": (ids_c or [0]), "lids": (ids_l or [0])})

    for row in r:
        d = dict(row._mapping)
        entry = {"pln": round(float(d["pln"] or 0), 2), "brak_kursu": int(d["brak_kursu"] or 0)}
        if d["container_id"] is not None:
            tgt = by_container.setdefault(d["container_id"], {"pln": 0.0, "brak_kursu": 0})
        elif d["lot_id"] is not None:
            tgt = by_lot.setdefault(d["lot_id"], {"pln": 0.0, "brak_kursu": 0})
        else:
            continue
        tgt["pln"] = round(tgt["pln"] + entry["pln"], 2)
        tgt["brak_kursu"] += entry["brak_kursu"]

    return by_container, by_lot


async def fetch_lots_bulk(db: AsyncSession, container_ids: List[int], lot_totals_by_cid: dict) -> dict:
    """Loty dla wielu kontenerów jednym zapytaniem (zamiast N× fetch_lots).
    Zwraca {container_id: [ContainerLotOut,...]}; kolejność w obrębie kontenera jak wcześniej (position ASC, id ASC)."""
    if not container_ids:
        return {}
    r = await db.execute(text(f"""
        SELECT l.container_id, l.id, l.manufacturer_id, l.order_number, l.position,
               l.waluta_towaru, l.zaliczka_procent, l.zaliczka_kwota, l.zaliczka_waluta, l.zaliczka_data,
               l.balance_kwota, l.balance_waluta, l.zaplacono_data,
               l.subiekt_wbite, l.subiekt_wbite_at,
               m.name AS manufacturer_name, m.color AS manufacturer_color
        FROM {settings.TABLE_CONTAINER_LOTS} l
        LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = l.manufacturer_id
        WHERE l.container_id = ANY(:ids)
        ORDER BY l.container_id, l.position ASC, l.id ASC
    """), {"ids": list(container_ids)})
    out: dict = {}
    lot_by_id: dict = {}
    for row in r:
        d = dict(row._mapping)
        cid = d["container_id"]
        t = lot_totals_by_cid.get(cid, {}).get(d["id"], {"u": 0, "cbm": 0.0, "val": 0.0})
        lot = ContainerLotOut(
            id=d["id"], manufacturer_id=d["manufacturer_id"],
            manufacturer_name=d["manufacturer_name"], manufacturer_color=d["manufacturer_color"],
            order_number=d["order_number"],
            waluta_towaru=(d["waluta_towaru"] or "USD"),
            zaliczka_procent=(float(d["zaliczka_procent"]) if d["zaliczka_procent"] is not None else None),
            zaliczka_kwota=(float(d["zaliczka_kwota"]) if d["zaliczka_kwota"] is not None else None),
            zaliczka_waluta=(d["zaliczka_waluta"] or d["waluta_towaru"] or "USD"),
            zaliczka_data=d["zaliczka_data"],
            balance_kwota=(float(d["balance_kwota"]) if d["balance_kwota"] is not None else None),
            balance_waluta=(d["balance_waluta"] or d["waluta_towaru"] or "USD"),
            zaplacono_data=d["zaplacono_data"],
            subiekt_wbite=bool(d.get("subiekt_wbite")),
            subiekt_wbite_at=d.get("subiekt_wbite_at"),
            total_units=t["u"], total_cbm=round(t["cbm"], 3), total_value=round(t["val"], 2),
        )
        out.setdefault(cid, []).append(lot)
        lot_by_id[lot.id] = lot
    # Zaliczki lotów — jedno zapytanie, doklejenie po lot_id.
    if lot_by_id:
        _, adv_by_lot = await fetch_advances_bulk(db, [], list(lot_by_id.keys()))
        for lid, advs in adv_by_lot.items():
            if lid in lot_by_id:
                lot_by_id[lid].advances = advs
    return out


async def fetch_containers(db: AsyncSession, status: Optional[str] = None) -> List[ContainerOut]:
    """Lista kontenerów z pozycjami + załącznikami + wyliczeniami wypełnienia/wartości."""
    where = "WHERE c.status = :status" if status else ""
    r = await db.execute(text(f"""
        SELECT
            c.id, c.container_number, c.order_number, c.container_type_id, c.manufacturer_id,
            c.order_date, c.eta_date, c.status, c.notes, c.is_consolidated,
            c.koszt_transportu, c.koszt_spedycji, c.koszt_transportu_magazyn, c.folder, c.subiekt_nr,
            c.waluta_towaru, c.zaliczka_procent, c.zaliczka_kwota, c.zaliczka_waluta, c.zaliczka_data,
            c.balance_kwota, c.balance_waluta, c.zaplacono_data, c.delivered_date, c.expected_delivery_date,
            c.subiekt_wbite, c.subiekt_wbite_at,
            ct.name AS container_type_name, ct.capacity_cbm AS container_capacity_cbm,
            m.name AS manufacturer_name, m.color AS manufacturer_color,
            ci.id AS item_id, ci.sku, ci.quantity, ci.unit_cost, ci.lot_id,
            COALESCE(
                NULLIF(TRIM(p.{settings.COL_PRODUCT_NAME}), ''),
                NULLIF(TRIM(sell.product_name), ''),
                NULLIF(TRIM(pa.name_override), '')
            ) AS product_name,
            COALESCE(NULLIF(pa.cena_zakupu, 0), p.{settings.COL_PRODUCT_PRICE}, 0) AS purchase_price,
            COALESCE(pa.cbm_per_unit, 0) AS cbm_per_unit,
            pa.firma_id,
            f.slug AS firma_slug, f.name AS firma_name, f.color AS firma_color
        FROM {settings.TABLE_CONTAINERS} c
        LEFT JOIN {settings.TABLE_CONTAINER_TYPES} ct ON ct.id = c.container_type_id
        LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = c.manufacturer_id
        LEFT JOIN {settings.TABLE_CONTAINER_ITEMS} ci ON ci.container_id = c.id
        LEFT JOIN {settings.TABLE_PRODUCTS} p ON p.{settings.COL_PRODUCT_SKU} = ci.sku
        LEFT JOIN (
            SELECT LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_canon,
                   MAX(oi.product_name) AS product_name
            FROM {settings.TABLE_ORDER_ITEMS} oi
            WHERE oi.product_name IS NOT NULL AND TRIM(oi.product_name) <> ''
            GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU}))
        ) sell ON sell.sku_canon = LOWER(TRIM(ci.sku))
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
                "lots": [], "_lot_totals": {}, "_lot_firma": {},
                "koszt_transportu": (float(row["koszt_transportu"]) if row["koszt_transportu"] is not None else None),
                "koszt_spedycji": (float(row["koszt_spedycji"]) if row["koszt_spedycji"] is not None else None),
                "oplata_spedycji": None,   # liczone niżej: koszt_spedycji − koszt_transportu
                "koszt_transportu_magazyn": (float(row["koszt_transportu_magazyn"]) if row["koszt_transportu_magazyn"] is not None else None),
                "folder": row["folder"],
                "subiekt_nr": row["subiekt_nr"],
                "waluta_towaru": row["waluta_towaru"] or "USD",
                "zaliczka_procent": (float(row["zaliczka_procent"]) if row["zaliczka_procent"] is not None else None),
                "zaliczka_kwota": (float(row["zaliczka_kwota"]) if row["zaliczka_kwota"] is not None else None),
                "zaliczka_waluta": (row["zaliczka_waluta"] or row["waluta_towaru"] or "USD"),
                "zaliczka_data": row["zaliczka_data"],
                "balance_kwota": (float(row["balance_kwota"]) if row["balance_kwota"] is not None else None),
                "balance_waluta": (row["balance_waluta"] or row["waluta_towaru"] or "USD"),
                "zaplacono_data": row["zaplacono_data"],
                "delivered_date": row["delivered_date"],
                "expected_delivery_date": row["expected_delivery_date"],
                "subiekt_wbite": bool(row["subiekt_wbite"]),
                "subiekt_wbite_at": row["subiekt_wbite_at"],
                "warehouse_delivery_date": None,   # liczone niżej: delivered_date lub ETA + odprawa
                "notes": row["notes"],
                "items": [], "attachments": [], "advances": [],
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
                # Rozbicie per firma także NA POZIOMIE LOTU — potrzebne, by KPI „Kontenery w drodze"
                # zawężone do sklepu liczyło udział firmy tylko z czerwonych (niewbitych) lotów.
                lfb_lot = containers_dict[cid]["_lot_firma"].setdefault(lid, {})
                lfb = lfb_lot.setdefault(slug, {
                    "slug": slug,
                    "name": row["firma_name"] or (DEFAULT_FIRMA_NAME if slug == DEFAULT_FIRMA_SLUG else slug.upper()),
                    "color": row["firma_color"],
                    "items": 0, "units": 0, "value": 0.0,
                })
                if lfb["color"] is None and row["firma_color"]:
                    lfb["color"] = row["firma_color"]
                lfb["items"] += 1
                lfb["units"] += row["quantity"]
                lfb["value"] += eff_cost * row["quantity"]

    # Załączniki + loty: dwa zbiorcze zapytania zamiast 2× (liczba kontenerów) round-tripów do bazy (był N+1).
    cids = list(containers_dict.keys())
    attachments_by_cid = await fetch_attachments_bulk(db, cids)
    lot_totals_by_cid = {cid: containers_dict[cid]["_lot_totals"] for cid in cids}
    lots_by_cid = await fetch_lots_bulk(db, cids, lot_totals_by_cid)
    # Zaliczki na poziomie kontenera (wariant nieskonsolidowany) — jedno zapytanie.
    adv_by_container, _ = await fetch_advances_bulk(db, cids, [])
    # Faktycznie zapłacone (PLN) — jedno zapytanie na kontenery i wszystkie ich loty.
    all_lot_ids = [lot.id for lots in lots_by_cid.values() for lot in lots]
    paid_by_cid, paid_by_lot = await fetch_payments_pln(db, cids, all_lot_ids)
    for cid in containers_dict:
        containers_dict[cid]["attachments"] = attachments_by_cid.get(cid, [])
        containers_dict[cid]["lots"] = lots_by_cid.get(cid, [])
        containers_dict[cid]["advances"] = adv_by_container.get(cid, [])

        # Kontener zbiera własne wpłaty + wpłaty swoich lotów (skonsolidowany płaci per lot).
        own = paid_by_cid.get(cid, {"pln": 0.0, "brak_kursu": 0})
        paid = own["pln"]
        missing = own["brak_kursu"]
        for lot in containers_dict[cid]["lots"]:
            lp = paid_by_lot.get(lot.id, {"pln": 0.0, "brak_kursu": 0})
            lot.zaplacono_pln = lp["pln"]
            lot.pozostalo_pln = round(max((lot.total_value or 0.0) - lp["pln"], 0.0), 2)
            lot.brak_kursu = lp["brak_kursu"]
            paid += lp["pln"]
            missing += lp["brak_kursu"]
        containers_dict[cid]["zaplacono_pln"] = round(paid, 2)
        containers_dict[cid]["brak_kursu"] = missing
        # doklej rozbicie firm per lot (z ContainerFirmaShare-friendly dict-ów)
        lot_firma = containers_dict[cid]["_lot_firma"]
        for lot in containers_dict[cid]["lots"]:
            fb = lot_firma.get(lot.id, {})
            for share in fb.values():
                share["value"] = round(share["value"], 2)
            lot.firma_breakdown = fb

    for c in containers_dict.values():
        c.pop("_lot_totals", None)
        c.pop("_lot_firma", None)
        c["total_cbm"] = round(c["total_cbm"], 3)
        c["total_value"] = round(c["total_value"], 2)
        # Ile jeszcze wypłynie za ten kontener. Podstawą jest wartość towaru w PLN
        # (ilość × cena jednostkowa), która ma już w sobie transport, cło i odprawę —
        # więc różnica to realna reszta do zapłaty, nie tylko dopłata do dostawcy.
        # Clamp na zerze: nadpłata (np. korekta ceny po fakcie) nie może zejść poniżej 0.
        c["pozostalo_pln"] = round(max(c["total_value"] - c.get("zaplacono_pln", 0.0), 0.0), 2)
        for fb in c["firma_breakdown"].values():
            fb["value"] = round(fb["value"], 2)
        # opłata dla spedycji = cały rachunek spedytora − sam koszt transportu (fracht)
        if c["koszt_spedycji"] is not None and c["koszt_transportu"] is not None:
            c["oplata_spedycji"] = round(c["koszt_spedycji"] - c["koszt_transportu"], 2)
        if c["container_capacity_cbm"] and c["container_capacity_cbm"] > 0:
            c["fill_percentage"] = round((c["total_cbm"] / c["container_capacity_cbm"]) * 100, 1)
        eff, is_auto, days_left = compute_effective_status(c["status"], c["eta_date"], c["expected_delivery_date"])
        c["effective_status"] = eff
        c["is_auto"] = is_auto
        c["customs_days_left"] = days_left
        # Data wejścia do magazynu (KPI „Dostawa na magazyn"), w kolejności pewności:
        #   1. delivered_date            — potwierdzona dostawa (ręczna),
        #   2. expected_delivery_date    — „u nas": umówiony odbiór, znany w trakcie odprawy,
        #   3. ETA + okno odprawy celnej — szacunek automatu.
        if c["delivered_date"] is not None:
            c["warehouse_delivery_date"] = c["delivered_date"]
        elif c["expected_delivery_date"] is not None:
            c["warehouse_delivery_date"] = c["expected_delivery_date"]
        elif c["eta_date"] is not None:
            c["warehouse_delivery_date"] = c["eta_date"] + timedelta(days=max(0, int(settings.CONTAINER_CUSTOMS_DAYS)))

    return [ContainerOut(**c) for c in containers_dict.values()]


async def get_container_by_id(db: AsyncSession, cid: int) -> ContainerOut:
    cs = await fetch_containers(db)
    for c in cs:
        if c.id == cid:
            return c
    raise HTTPException(404)
