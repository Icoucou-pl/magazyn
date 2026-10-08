"""Produkty: lista z prognozą, edycja lead-time/atrybutów, projekcja stanu,
import atrybutów, eksport do XLSX, ulubione."""

import io
from datetime import date, timedelta
from typing import List

from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import (
    ProductSummary, LeadTimeUpdate, ProductAttrsUpdate,
    StockProjectionPoint, ImportRow, ImportResult, CurrentUser, TopSellerOut, SampleCreate, SkuZmiana, CenaZSku, ManualNewUpdate, VatOut, VatUpdate,
)
from security import get_current_user, has_perm, require_perm, resolve_shop, allowed_shops
from services.products import fetch_products, get_product
import audit
from audit import log_audit
from audit_opisy import etykieta_kontenera, f_bool, f_data, f_num, f_status_produktu, f_txt, f_zl
from routers.product_history import require_super_admin   # ten sam guard co historia produktu

router = APIRouter(prefix="/api", tags=["products"])


# Pola karty produktu w dzienniku audytu: kolumna → (etykieta jak w UI, formater).
POLA_ATRYBUTOW = {
    "name_override": ("Nazwa", f_txt),
    "manufacturer": ("Producent", f_txt),
    "firma": ("Firma", f_txt),
    "forced_status": ("Status", f_status_produktu),
    "cena_zakupu": ("Cena zakupu", f_zl),
    "ean": ("EAN", f_txt),
    "kod_cn": ("Kod CN", f_txt),
    "cbm_per_unit": ("CBM / szt.", f_num("m³", 7)),
    "dlugosc_cm": ("Długość", f_num("cm", 1)),
    "szerokosc_cm": ("Szerokość", f_num("cm", 1)),
    "wysokosc_cm": ("Wysokość", f_num("cm", 1)),
    "waga_brutto_kg": ("Waga brutto", f_num("kg", 3)),
    "szt_w_kartonie": ("Szt. w kartonie", f_num("", 0)),
    "moq": ("MOQ", f_num("szt.", 0)),
    "zaokraglaj_karton": ("Zaokrąglaj do kartonu", f_bool),
    "seasonality_enabled": ("Sezonowość", f_bool),
    "is_sample": ("Sample", f_bool),
    "sample_stock": ("Stan sampla", f_num("szt.", 0)),
}


async def _nazwy_atrybutow(db: AsyncSession, d: dict) -> dict:
    """Do dziennika: id producenta/firmy → nazwa (w zdaniu ma być „Foshan Huayi”, nie „7”)."""
    d = dict(d)
    mid, fid = d.get("manufacturer_id"), d.get("firma_id")
    d["manufacturer"] = (await db.execute(
        text(f"SELECT name FROM {settings.TABLE_MANUFACTURERS} WHERE id = :id"), {"id": mid}
    )).scalar() if mid else None
    d["firma"] = (await db.execute(
        text(f"SELECT name FROM {settings.TABLE_FIRMY} WHERE id = :id"), {"id": fid}
    )).scalar() if fid else None
    return d


async def _sku_atrybutow(db: AsyncSession, sku: str) -> str:
    """Pisownia SKU, pod którą zapisujemy do app_product_attrs.

    Atrybuty są unikalne po `sku` DOSŁOWNIE, a cała reszta aplikacji łączy je
    po LOWER(TRIM(sku)). Zapis pod inną wielkością liter nie trafiał więc
    w istniejący wiersz, tylko zakładał drugi — tak powstały duble typu
    SZP1_Outlet / szp1_outlet (modal „brak ceny zakupu" w Finansach podaje
    SKU małymi literami) i MKP1 / Mkp1 / „Mkp1 " ze spacją.

    Kolejność:
      1. istniejący wiersz atrybutów pod tym SKU w dowolnej pisowni,
      2. pisownia ze źródła: Subiekt (oba), Fakturownia, stany Sellasista,
         pozycje zamówień — kolejność jak w katalogu (sql.py),
      3. to, co przyszło, obcięte ze spacji.
    """
    s = (sku or "").strip()
    if not s:
        return s
    r = await db.execute(text(f"""
        SELECT sku FROM (
            SELECT sku, 0 AS pri, updated_at AS ts
              FROM {settings.TABLE_PRODUCT_ATTRS}
             WHERE LOWER(TRIM(sku)) = LOWER(:s)
            UNION ALL
            SELECT TRIM({settings.COL_PRODUCT_SKU}), 1, NULL
              FROM {settings.TABLE_PRODUCTS}
             WHERE LOWER(TRIM({settings.COL_PRODUCT_SKU})) = LOWER(:s)
            UNION ALL
            SELECT TRIM(sku), 2, NULL
              FROM {settings.TABLE_SUBIEKT_DWA}
             WHERE LOWER(TRIM(sku)) = LOWER(:s)
            UNION ALL
            SELECT TRIM(sku), 3, NULL
              FROM {settings.TABLE_FAKTUROWNIA_STOCK}
             WHERE sku_canon = LOWER(:s) AND sku IS NOT NULL
            UNION ALL
            SELECT TRIM(symbol), 4, NULL
              FROM {settings.TABLE_EXTERNAL_STOCK}
             WHERE sku_canon = LOWER(:s) AND symbol IS NOT NULL
            UNION ALL
            SELECT TRIM({settings.COL_ITEM_SKU}), 5, NULL
              FROM {settings.TABLE_ORDER_ITEMS}
             WHERE LOWER(TRIM({settings.COL_ITEM_SKU})) = LOWER(:s)
        ) k
        WHERE sku IS NOT NULL AND sku <> ''
        ORDER BY pri, ts DESC NULLS LAST
        LIMIT 1
    """), {"s": s})
    hit = r.scalar_one_or_none()
    return hit or s


def _mask_financials(products, user):
    """Serwerowe ukrycie cen: zeruje pola finansowe dla usera bez viewFinancials.
    Front i tak maskuje wizualnie — to zamyka wyciek wartości w payloadzie (zakładka Network).

    viewPurchasePrice: osoba bez finansów, która musi znać cenę jednostkową —
    cena zakupu (i jej źródło) zostaje, wartość stanu dalej jest zerowana."""
    if has_perm(user, "viewFinancials"):
        return products
    widzi_cene = has_perm(user, "viewPurchasePrice")
    for p in products:
        p.stock_value = 0.0
        if not widzi_cene:
            p.purchase_price = 0.0
            p.cena_zakupu_manual = None
            p.price_source = None   # cena wyzerowana → etykieta źródła nie ma czego opisywać
    return products


@router.get("/products", response_model=List[ProductSummary])
async def list_products(include: str = Query("ACTIVE,ACTIVE_NO_STOCK"), shop: str = Query(""), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    # shop="" = wszystkie sklepy (suma); "amh"/"acti"/"veluxa" = sprzedaż i stan tylko danego sklepu (Faza 3).
    # resolve_shop: dla usera z company_scope "" NIE znaczy „wszystkie" — klamruje do jego firmy.
    shop = resolve_shop(shop, user)
    allowed = set(s.strip().upper() for s in include.split(",") if s.strip())
    return _mask_financials(await fetch_products(db, allowed, shop), user)


@router.get("/products/{sku}", response_model=ProductSummary)
async def get_product_endpoint(sku: str, shop: str = Query(""), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    p = await get_product(db, sku, shop, allowed=allowed_shops(user))
    _mask_financials([p], user)
    return p


@router.put("/products/{sku:path}/lead-time", response_model=ProductSummary)
async def update_lead_time(sku: str, payload: LeadTimeUpdate, db: AsyncSession = Depends(get_db),
                           user: CurrentUser = Depends(require_perm("editProducts"))):
    stary = (await db.execute(
        text(f"SELECT lead_time_days FROM {settings.TABLE_LEAD_TIMES} WHERE sku = :sku"), {"sku": sku}
    )).scalar()
    await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_LEAD_TIMES} (sku, lead_time_days, updated_at)
            VALUES (:sku, :lt, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET lead_time_days = EXCLUDED.lead_time_days, updated_at = CURRENT_TIMESTAMP
        """),
        {"sku": sku, "lt": payload.lead_time_days}
    )
    await db.commit()
    audit.note_zmiany(f"produktu {sku}", audit.zmiany(
        {"lt": stary}, {"lt": payload.lead_time_days}, {"lt": ("Czas dostawy", f_num("dni", 0))}),
        resource_id=sku)
    return _mask_financials([await get_product(db, sku, allowed=allowed_shops(user))], user)[0]


@router.put("/products/{sku:path}/attrs", response_model=ProductSummary)
async def update_attrs(sku: str, payload: ProductAttrsUpdate, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    sku = await _sku_atrybutow(db, sku)
    existing = await db.execute(text(f"SELECT cbm_per_unit, manufacturer_id, firma_id, seasonality_enabled, ean, forced_status, cena_zakupu, name_override, is_sample, sample_stock, dlugosc_cm, szerokosc_cm, wysokosc_cm, szt_w_kartonie, moq, zaokraglaj_karton, waga_brutto_kg, kod_cn FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku = :sku"), {"sku": sku})
    e = existing.first()
    cbm = payload.cbm_per_unit if payload.cbm_per_unit is not None else (float(e.cbm_per_unit) if e else 0)
    # manufacturer_id: 0 = odepnij producenta; None = nie zmieniaj; >0 = ustaw
    if payload.manufacturer_id is not None:
        mfr = None if payload.manufacturer_id == 0 else payload.manufacturer_id
    else:
        mfr = e.manufacturer_id if e else None
    # firma_id: 0 = odepnij (→ domyślnie AMH); None = nie zmieniaj; >0 = ustaw
    if payload.firma_id is not None:
        firma = None if payload.firma_id == 0 else payload.firma_id
    else:
        firma = e.firma_id if e else None
    seas = payload.seasonality_enabled if payload.seasonality_enabled is not None else (e.seasonality_enabled if e else False)
    ean = payload.ean if payload.ean is not None else (e.ean if e else None)
    if ean is not None and not ean.strip():
        ean = None

    # Forced status: "AUTO" lub "" lub null = wyczyść
    forced = payload.forced_status if payload.forced_status is not None else (e.forced_status if e else None)
    if forced in ("", "AUTO", "auto", None):
        forced = None
    elif forced not in ("ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"):
        raise HTTPException(400, f"Niepoprawny status: {forced}. Dozwolone: ACTIVE, ACTIVE_NO_STOCK, DEAD_STOCK, INACTIVE, AUTO")

    # Cena zakupu (ręczna): None = nie zmieniaj; <=0 = wyczyść override; >0 = ustaw.
    # Dane finansowe — zapis TYLKO z uprawnieniem viewFinancials (guard po stronie serwera).
    if payload.cena_zakupu is not None:
        if not has_perm(user, "viewFinancials"):
            raise HTTPException(403, "Brak uprawnień do edycji ceny zakupu (viewFinancials)")
        cena = None if payload.cena_zakupu <= 0 else round(float(payload.cena_zakupu), 2)
    else:
        cena = (float(e.cena_zakupu) if (e and e.cena_zakupu is not None) else None)

    # Nazwa ręczna: None = nie zmieniaj; "" (po strip) = wyczyść (→ nazwa z Subiektu/zamówień); tekst = ustaw.
    if payload.name_override is not None:
        name_ov = payload.name_override.strip()[:255] or None
    else:
        name_ov = (e.name_override if e else None)

    # Etykieta SAMPLE: produkt wprowadzony próbnie. Status SAMPLE (poza
    # auto-sugestią, listą zakupów i anomaliami) do wejścia do magazynu w drodze, potem NOWOŚĆ
    # do 6 mies. po dostawie — services/products.py.
    is_sample = payload.is_sample if payload.is_sample is not None else (bool(e.is_sample) if e else False)
    # Zabezpieczenie: SKU obecny WYŁĄCZNIE dzięki etykiecie (brak w Subiekcie i Sellasiście) po
    # odznaczeniu wypadłby z katalogu całkowicie — także z nieaktywnych — i nie dałoby się go znaleźć.
    if e and bool(e.is_sample) and not is_sample and not await _found_in(db, sku, _CATALOG_SOURCES):
        raise HTTPException(
            409,
            f"{sku} nie istnieje w Subiekcie ani Sellasiście — po odznaczeniu etykiety Sample zniknąłby "
            "z aplikacji. Najpierw załóż go w ERP.",
        )
    # Ręczny stan sampla — liczy się tylko dla SKU bez innego źródła stanu (patrz SALES_QUERY, src_pri = 4).
    sample_stock = payload.sample_stock if payload.sample_stock is not None else (int(e.sample_stock or 0) if e else 0)

    # Wymiary kartonu + logistyka zamawiania.
    # Konwencja spójna z ceną i nazwą: None = nie zmieniaj, <=0 = wyczyść, >0 = ustaw.
    def _num(nowa, stara, precyzja=1):
        if nowa is None:
            return (float(stara) if stara is not None else None)
        return None if nowa <= 0 else round(float(nowa), precyzja)

    def _int(nowa, stara):
        if nowa is None:
            return (int(stara) if stara is not None else None)
        return None if nowa <= 0 else int(nowa)

    dlugosc   = _num(payload.dlugosc_cm,   e.dlugosc_cm   if e else None)
    szerokosc = _num(payload.szerokosc_cm, e.szerokosc_cm if e else None)
    wysokosc  = _num(payload.wysokosc_cm,  e.wysokosc_cm  if e else None)
    szt_kart  = _int(payload.szt_w_kartonie, e.szt_w_kartonie if e else None)
    moq       = _int(payload.moq,            e.moq            if e else None)
    zaokr     = payload.zaokraglaj_karton if payload.zaokraglaj_karton is not None else (bool(e.zaokraglaj_karton) if e else False)

    # Dane odprawy celnej. Waga brutto trzyma 3 miejsca (grama widać przy drobnicy typu filtr 0,406 kg).
    waga = _num(payload.waga_brutto_kg, e.waga_brutto_kg if e else None, precyzja=3)
    # Kod CN: same cyfry. Agencja pisze go w SAD bez spacji (94029000), na wydruku ze spacjami
    # (9402 90 00) — normalizujemy, żeby dopasowanie pozycji odprawy do SKU nie zależało od zapisu.
    if payload.kod_cn is not None:
        cyfry = "".join(ch for ch in payload.kod_cn if ch.isdigit())[:10]
        kod_cn = cyfry or None
    else:
        kod_cn = (e.kod_cn if e else None)

    await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, cbm_per_unit, manufacturer_id, firma_id, seasonality_enabled, ean, forced_status, cena_zakupu, name_override, is_sample, sample_stock, dlugosc_cm, szerokosc_cm, wysokosc_cm, szt_w_kartonie, moq, zaokraglaj_karton, waga_brutto_kg, kod_cn, updated_at)
            VALUES (:sku, :cbm, :mfr, :firma, :seas, :ean, :forced, :cena, :name_ov, :is_sample, :sample_stock, :dl, :sz, :wy, :szt_kart, :moq, :zaokr, :waga, :kod_cn, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET
                cbm_per_unit = EXCLUDED.cbm_per_unit,
                manufacturer_id = EXCLUDED.manufacturer_id,
                firma_id = EXCLUDED.firma_id,
                seasonality_enabled = EXCLUDED.seasonality_enabled,
                ean = EXCLUDED.ean,
                forced_status = EXCLUDED.forced_status,
                cena_zakupu = EXCLUDED.cena_zakupu,
                name_override = EXCLUDED.name_override,
                is_sample = EXCLUDED.is_sample,
                sample_stock = EXCLUDED.sample_stock,
                dlugosc_cm = EXCLUDED.dlugosc_cm,
                szerokosc_cm = EXCLUDED.szerokosc_cm,
                wysokosc_cm = EXCLUDED.wysokosc_cm,
                szt_w_kartonie = EXCLUDED.szt_w_kartonie,
                moq = EXCLUDED.moq,
                zaokraglaj_karton = EXCLUDED.zaokraglaj_karton,
                waga_brutto_kg = EXCLUDED.waga_brutto_kg,
                kod_cn = EXCLUDED.kod_cn,
                updated_at = CURRENT_TIMESTAMP
        """),
        {"sku": sku, "cbm": cbm, "mfr": mfr, "firma": firma, "seas": seas, "ean": ean, "forced": forced,
         "cena": cena, "name_ov": name_ov, "is_sample": is_sample, "sample_stock": sample_stock,
         "dl": dlugosc, "sz": szerokosc, "wy": wysokosc, "szt_kart": szt_kart, "moq": moq, "zaokr": zaokr,
         "waga": waga, "kod_cn": kod_cn}
    )
    await db.commit()

    nowe = {"cbm_per_unit": cbm, "manufacturer_id": mfr, "firma_id": firma, "seasonality_enabled": seas,
            "ean": ean, "forced_status": forced, "cena_zakupu": cena, "name_override": name_ov,
            "is_sample": is_sample, "sample_stock": sample_stock, "dlugosc_cm": dlugosc,
            "szerokosc_cm": szerokosc, "wysokosc_cm": wysokosc, "szt_w_kartonie": szt_kart, "moq": moq,
            "zaokraglaj_karton": zaokr, "waga_brutto_kg": waga, "kod_cn": kod_cn}
    pola = dict(POLA_ATRYBUTOW)
    if not has_perm(user, "viewFinancials"):
        pola.pop("cena_zakupu")      # bez uprawnienia cena nie mogła się zmienić — nie pokazujemy jej
    audit.note_zmiany(
        f"produktu {sku}",
        audit.zmiany(await _nazwy_atrybutow(db, dict(e._mapping)) if e else None,
                     await _nazwy_atrybutow(db, nowe), pola),
        resource_id=sku,
    )
    return _mask_financials([await get_product(db, sku)], user)[0]


@router.get("/products/{sku:path}/projection", response_model=List[StockProjectionPoint])
async def projection(sku: str, days: int = 180, db: AsyncSession = Depends(get_db),
                     user: CurrentUser = Depends(get_current_user)):
    product = await get_product(db, sku, allowed=allowed_shops(user))
    today = date.today()
    base_daily = product.avg_monthly_weighted / 30
    # Dostawa wchodzi na dzień wejścia na magazyn (warehouse_delivery_date), nie na surową ETA.
    # incoming_deliveries są już przefiltrowane (arrival >= dziś) w calculate_forecast.
    eta_map: dict = {}
    eta_names: dict = {}
    for d in product.incoming_deliveries:
        wd = d.warehouse_delivery_date
        eta_map[wd] = eta_map.get(wd, 0) + d.quantity
        nazwa = etykieta_kontenera(d.container_number, d.container_order_number or d.lot_order_number,
                                   d.container_id)
        lbl = f"{nazwa if nazwa.startswith(('FV', '#')) else '#' + nazwa} +{d.quantity}"
        eta_names[wd] = (eta_names[wd] + ", " + lbl) if wd in eta_names else lbl
    points = []
    current = float(product.stock)
    for offset in range(0, days + 1):
        cd = today + timedelta(days=offset)
        ev = None
        if cd in eta_map:
            current += eta_map[cd]
            ev = eta_names[cd]
        if offset > 0:
            # Podłoga na zerze — patrz forecast.tsx. Bez niej stan schodził pod zero,
            # a dostawa dopisywana do ujemnego salda była zaniżona o sprzedaż z okresu,
            # w którym magazyn i tak był pusty.
            current = max(0.0, current - base_daily)
        points.append(StockProjectionPoint(date=cd, stock=int(current), event=ev))
    return points


@router.post("/products/import", response_model=ImportResult)
async def import_products(rows: List[ImportRow], db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Import atrybutów dla produktów - z UI lub bezpośrednio JSON-em."""
    can_fin = has_perm(user, "viewFinancials")  # cena zakupu tylko dla uprawnionych
    products_result = await db.execute(text(f"SELECT {settings.COL_PRODUCT_SKU} as sku FROM {settings.TABLE_PRODUCTS}"))
    valid_skus = {r._mapping["sku"].strip().lower(): r._mapping["sku"] for r in products_result}

    mfr_result = await db.execute(text(f"SELECT id, name FROM {settings.TABLE_MANUFACTURERS}"))
    mfr_map = {r._mapping["name"].strip().lower(): r._mapping["id"] for r in mfr_result}

    # Raz na import zamiast _sku_atrybutow() na każdy wiersz: ten helper przeszukuje
    # też pozycje zamówień, a import potrafi mieć setki wierszy.
    attrs_res = await db.execute(text(
        f"SELECT DISTINCT ON (LOWER(TRIM(sku))) LOWER(TRIM(sku)) AS k, sku "
        f"FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku IS NOT NULL "
        f"ORDER BY LOWER(TRIM(sku)), updated_at DESC NULLS LAST"
    ))
    attrs_pisownia = {r._mapping["k"]: r._mapping["sku"] for r in attrs_res}

    updated = 0
    skipped = 0
    errors = []

    for row in rows:
        sku_key = row.sku.strip().lower()
        if sku_key not in valid_skus:
            skipped += 1
            errors.append(f"{row.sku}: nie znaleziono w bazie")
            continue
        # Istniejący wiersz atrybutów w dowolnej pisowni wygrywa z pisownią Subiekta —
        # inaczej import zakładałby drugi wiersz obok już istniejącego.
        real_sku = attrs_pisownia.get(sku_key, valid_skus[sku_key])

        mfr_id = None
        if row.manufacturer_name:
            mfr_id = mfr_map.get(row.manufacturer_name.strip().lower())
            if mfr_id is None and row.manufacturer_name.strip():
                r = await db.execute(
                    text(f"INSERT INTO {settings.TABLE_MANUFACTURERS} (name, color) VALUES (:n, :c) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id"),
                    {"n": row.manufacturer_name.strip(), "c": "#6b7280"}
                )
                mfr_id = r.scalar_one()
                mfr_map[row.manufacturer_name.strip().lower()] = mfr_id

        try:
            existing = await db.execute(text(f"SELECT cbm_per_unit, manufacturer_id, seasonality_enabled, cena_zakupu FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku = :sku"), {"sku": real_sku})
            e = existing.first()
            cbm = row.cbm if row.cbm is not None else (float(e.cbm_per_unit) if e else 0)
            new_mfr = mfr_id if mfr_id is not None else (e.manufacturer_id if e else None)
            new_seas = row.seasonality_enabled if row.seasonality_enabled is not None else (e.seasonality_enabled if e else False)
            # Cena zakupu: tylko z uprawnieniem; puste = zostaw; <=0 = wyczyść; >0 = ustaw
            prev_cena = float(e.cena_zakupu) if (e and e.cena_zakupu is not None) else None
            if can_fin and row.cena_zakupu is not None:
                new_cena = None if row.cena_zakupu <= 0 else round(float(row.cena_zakupu), 2)
            else:
                new_cena = prev_cena

            await db.execute(text(f"""
                INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, cbm_per_unit, manufacturer_id, seasonality_enabled, cena_zakupu, updated_at)
                VALUES (:sku, :cbm, :mfr, :seas, :cena, CURRENT_TIMESTAMP)
                ON CONFLICT (sku) DO UPDATE SET cbm_per_unit=EXCLUDED.cbm_per_unit, manufacturer_id=EXCLUDED.manufacturer_id, seasonality_enabled=EXCLUDED.seasonality_enabled, cena_zakupu=EXCLUDED.cena_zakupu, updated_at=CURRENT_TIMESTAMP
            """), {"sku": real_sku, "cbm": cbm, "mfr": new_mfr, "seas": new_seas, "cena": new_cena})

            if row.lead_time_days is not None and 1 <= row.lead_time_days <= 365:
                await db.execute(text(f"""
                    INSERT INTO {settings.TABLE_LEAD_TIMES} (sku, lead_time_days, updated_at)
                    VALUES (:sku, :lt, CURRENT_TIMESTAMP)
                    ON CONFLICT (sku) DO UPDATE SET lead_time_days=EXCLUDED.lead_time_days, updated_at=CURRENT_TIMESTAMP
                """), {"sku": real_sku, "lt": row.lead_time_days})

            updated += 1
        except Exception as ex:
            errors.append(f"{row.sku}: {str(ex)[:100]}")
            skipped += 1

    await db.commit()
    audit.note(
        f"zaimportował atrybuty {updated} {audit.opisy.plural(updated, 'produktu', 'produktów', 'produktów')} z pliku"
        + (f" (pominięto {skipped})" if skipped else ""),
    )
    return ImportResult(total=len(rows), updated=updated, skipped=skipped, errors=errors[:20])


@router.get("/products/export/csv")
async def export_xlsx(include: str = Query("ACTIVE,ACTIVE_NO_STOCK"), favorites_only: bool = Query(False), shop: str = Query(""), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Eksport produktów do Excela (XLSX) - polskie znaki zawsze działają.
    shop="" = wszystkie sklepy; "amh"/"acti"/"veluxa" = liczby danego sklepu (zgodnie z wybraną zakładką)."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    allowed = set(s.strip().upper() for s in include.split(",") if s.strip())
    products = await fetch_products(db, allowed, resolve_shop(shop, user))

    if favorites_only:
        products = [p for p in products if p.is_favorite]

    wb = Workbook()
    ws = wb.active
    ws.title = "Produkty"

    headers = [
        "SKU", "Nazwa", "EAN", "Producent", "Stan", "Cena zakupu", "Wartość PLN",
        "W drodze", "CBM", "Lead time (dni)",
        "Sprzedaż 1m", "Sprzedaż 2m", "Sprzedaż 3m", "Sprzedaż 4m",
        "YoY 30d", "YoY +30d", "Średnia miesięczna", "Miesiące zapasu",
        "Status prognozy", "Status produktu", "Sezonowy", "Obserwowany",
        "Data zamówienia", "Data końca zapasu",
    ]
    ws.append(headers)

    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1c1917", end_color="1c1917", fill_type="solid")
    for col_idx, _ in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")

    for p in products:
        ws.append([
            p.sku, p.name, p.ean or "", p.manufacturer_name or "", p.stock,
            p.purchase_price, p.stock_value, p.stock_in_transit, p.cbm_per_unit, p.lead_time_days,
            p.sales_1m, p.sales_2m, p.sales_3m, p.sales_4m,
            p.sales_yoy_30d, p.sales_yoy_next_30d,
            p.avg_monthly_weighted, p.months_of_stock,
            p.status, p.product_status,
            "tak" if p.seasonality_enabled else "nie",
            "tak" if p.is_favorite else "nie",
            p.order_date.isoformat(), p.empty_date.isoformat(),
        ])

    column_widths = [12, 35, 16, 15, 8, 12, 14, 10, 8, 8, 10, 10, 10, 10, 10, 10, 12, 10, 14, 14, 8, 10, 12, 12]
    for i, width in enumerate(column_widths, 1):
        ws.column_dimensions[chr(64 + i) if i <= 26 else 'A' + chr(64 + i - 26)].width = width

    ws.freeze_panes = "A2"

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    filename = f"produkty_{date.today().isoformat()}.xlsx"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@router.put("/products/{sku:path}/favorite", response_model=ProductSummary)
async def toggle_favorite(sku: str, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_perm("editProducts"))):
    """Przełącza status ulubione - jeśli był true, robi false i odwrotnie.
    Wymaga editProducts (VIEWER nie może zmieniać obserwowania)."""
    sku = await _sku_atrybutow(db, sku)
    existing = await db.execute(text(f"SELECT is_favorite FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku = :sku"), {"sku": sku})
    e = existing.first()
    new_val = not e.is_favorite if e else True

    await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, is_favorite, updated_at)
            VALUES (:sku, :fav, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET is_favorite = EXCLUDED.is_favorite, updated_at = CURRENT_TIMESTAMP
        """),
        {"sku": sku, "fav": new_val}
    )
    await db.commit()
    audit.note(f"dodał produkt {sku} do obserwowanych" if new_val else f"usunął produkt {sku} z obserwowanych",
               resource_id=sku)
    return await get_product(db, sku)


@router.put("/products/{sku:path}/no-reorder", response_model=ProductSummary)
async def toggle_no_reorder(sku: str, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_perm("editProducts"))):
    """Przełącza „nie dozamawiamy" — produkt znika z pożarów i całego flow zamawiania
    (lista zakupów, auto-sugestia, lista AI), ale zostaje żywy w Produktach/sprzedaży/wyprzedaży.
    Nie rusza statusu ani klasyfikacji — to nie INACTIVE/DEAD_STOCK."""
    sku = await _sku_atrybutow(db, sku)
    existing = await db.execute(text(f"SELECT no_reorder FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku = :sku"), {"sku": sku})
    e = existing.first()
    new_val = not e.no_reorder if e else True

    await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, no_reorder, updated_at)
            VALUES (:sku, :nr, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET no_reorder = EXCLUDED.no_reorder, updated_at = CURRENT_TIMESTAMP
        """),
        {"sku": sku, "nr": new_val}
    )
    await db.commit()
    audit.note(f"oznaczył produkt {sku} jako „nie dozamawiamy”" if new_val
               else f"zdjął z produktu {sku} oznaczenie „nie dozamawiamy”",
               changes=[{"pole": "Nie dozamawiamy", "bylo": f_bool(not new_val), "jest": f_bool(new_val)}],
               resource_id=sku)
    return await get_product(db, sku)


@router.put("/products/{sku:path}/new-until", response_model=ProductSummary)
async def set_manual_new(sku: str, body: ManualNewUpdate, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_perm("editProducts"))):
    """Nowość ustawiona ręcznie (app_product_attrs.manual_new_until).
    Tylko znacznik NOWOŚĆ i filtr „Nowości" — status produktu liczy się normalnie.
    Nowości sampla stąd nie ruszamy: kończy się ją odznaczeniem Sample."""
    if body.until is not None and body.until <= date.today():
        raise HTTPException(status_code=400, detail="Data końca nowości musi być w przyszłości")
    if body.until is not None and body.until > date.today() + timedelta(days=731):
        raise HTTPException(status_code=400, detail="Nowość można ustawić najwyżej na 2 lata")
    sku = await _sku_atrybutow(db, sku)
    stara = (await db.execute(
        text(f"SELECT manual_new_until FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku = :sku"), {"sku": sku}
    )).scalar()
    await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, manual_new_until, updated_at)
            VALUES (:sku, :until, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET manual_new_until = EXCLUDED.manual_new_until, updated_at = CURRENT_TIMESTAMP
        """),
        {"sku": sku, "until": body.until}
    )
    await db.commit()
    ch = audit.zmiany({"u": stara}, {"u": body.until}, {"u": ("Nowość do", f_data)})
    if not ch:
        audit.skip()
    else:
        audit.note(f"oznaczył produkt {sku} jako nowość do {f_data(body.until)}" if body.until
                   else f"zdjął ręczną nowość z produktu {sku}", changes=ch, resource_id=sku)
    return await get_product(db, sku)


@router.get("/products/{sku:path}/vat", response_model=VatOut)
async def get_vat(sku: str, shop: str = Query(""), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Stawka VAT produktu: ręczna (zakładka Dane) wygrywa nad stawką z ostatniej krajowej sprzedaży."""
    from services.cena import vat_produktu
    return VatOut(**await vat_produktu(db, sku, resolve_shop(shop, user)))


@router.put("/products/{sku:path}/vat", response_model=VatOut)
async def set_vat(sku: str, body: VatUpdate, shop: str = Query(""), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_perm("editProducts"))):
    """Ręczna stawka VAT. None = wróć do automatu (ostatnia krajowa sprzedaż)."""
    from services.cena import vat_produktu
    sku = await _sku_atrybutow(db, sku)
    stara = (await db.execute(
        text(f"SELECT vat_manual FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku = :sku"), {"sku": sku}
    )).scalar()
    await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, vat_manual, updated_at)
            VALUES (:sku, :vat, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET vat_manual = EXCLUDED.vat_manual, updated_at = CURRENT_TIMESTAMP
        """),
        {"sku": sku, "vat": body.vat},
    )
    await db.commit()
    fmt = lambda v: "automatycznie" if v is None else f"{float(v):g}%"   # noqa: E731
    ch = audit.zmiany({"v": stara}, {"v": body.vat}, {"v": ("Stawka VAT", fmt)})
    if not ch:
        audit.skip()
    else:
        audit.note(f"ustawił stawkę VAT produktu {sku}: {fmt(body.vat)}", changes=ch, resource_id=sku)
    return VatOut(**await vat_produktu(db, sku, resolve_shop(shop, user)))


@router.get("/favorites", response_model=List[ProductSummary])
async def list_favorites(shop: str = "", db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    shop = resolve_shop(shop, user)
    """Zwraca tylko ulubione produkty."""
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"}, shop)
    return _mask_financials([p for p in products if p.is_favorite], user)


@router.get("/top-sellers", response_model=List[TopSellerOut])
async def top_sellers(
    shop: str = Query(""),
    limit: int = Query(20, ge=1, le=100),
    favorites_only: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """Top sprzedaży wg SZTUK z ostatnich 30 dni (sales_1m), malejąco.

    shop="" = suma wszystkich sklepów; "amh"/"acti"/"veluxa" = sprzedaz danego sklepu.
    favorites_only=True → tylko obserwowane SKU (is_favorite); Dashboard woła z True.
    Model wyjsciowy nie zawiera zadnych pol finansowych, wiec endpoint jest dostepny
    dla kazdego zalogowanego uzytkownika (bez viewFinancials) i nie wymaga maskowania.
    """
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"}, resolve_shop(shop, user))
    if favorites_only:
        products = [p for p in products if p.is_favorite]
    ranked = sorted(
        (p for p in products if p.sales_1m > 0),
        key=lambda p: (p.sales_1m, p.avg_monthly_weighted),
        reverse=True,
    )[:limit]
    return [
        TopSellerOut(
            sku=p.sku,
            name=p.name,
            status=p.status,
            stock=p.stock,
            days_until_empty=p.days_until_empty,
            sales_1m=p.sales_1m,
            sales_yoy_30d=p.sales_yoy_30d,
            avg_monthly=p.avg_monthly_weighted,
            manufacturer_name=p.manufacturer_name,
            manufacturer_color=p.manufacturer_color,
        )
        for p in ranked
    ]


@router.post("/samples", response_model=ProductSummary, status_code=201)
async def create_sample(payload: SampleCreate, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Tworzy SAMPLE — produkt, którego nie ma ani w Subiekcie, ani w Sellasiscie.

    Wiersz laduje w app_product_attrs z is_sample=TRUE; katalog (SALES_QUERY, zrodlo pri 4)
    podnosi go wtedy do rangi normalnego produktu: mozna mu nadac CBM, producenta i cene,
    a w kontenerze przestaje zajmowac 0 m3.

    Jesli SKU juz istnieje w katalogu (np. sprzedawany na Acti), NIE uzywaj tego endpointu —
    wystarczy PUT /products/{sku}/attrs z is_sample=true (etykieta na istniejacym produkcie).
    """
    if not has_perm(user, "editProducts"):
        raise HTTPException(403, "Brak uprawnienia: editProducts")

    sku = payload.sku.strip()
    if not sku:
        raise HTTPException(400, "SKU nie moze byc puste")
    sku = await _sku_atrybutow(db, sku)

    dup = await db.execute(
        text(f"SELECT 1 FROM {settings.TABLE_PRODUCT_ATTRS} WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku)) AND COALESCE(is_sample, FALSE)"),
        {"sku": sku},
    )
    if dup.first():
        raise HTTPException(409, f"Sample {sku} juz istnieje")

    cena = None
    if payload.cena_zakupu is not None and payload.cena_zakupu > 0:
        if not has_perm(user, "viewFinancials"):
            raise HTTPException(403, "Brak uprawnien do ustawiania ceny zakupu (viewFinancials)")
        cena = round(float(payload.cena_zakupu), 2)

    ean = payload.ean.strip() if payload.ean and payload.ean.strip() else None

    await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS}
                (sku, cbm_per_unit, manufacturer_id, firma_id, seasonality_enabled, ean,
                 cena_zakupu, name_override, is_sample, sample_stock, updated_at)
            VALUES (:sku, :cbm, :mfr, :firma, FALSE, :ean, :cena, :name, TRUE, :stock, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET
                cbm_per_unit = EXCLUDED.cbm_per_unit,
                manufacturer_id = EXCLUDED.manufacturer_id,
                firma_id = EXCLUDED.firma_id,
                ean = EXCLUDED.ean,
                cena_zakupu = EXCLUDED.cena_zakupu,
                name_override = EXCLUDED.name_override,
                is_sample = TRUE,
                sample_stock = EXCLUDED.sample_stock,
                updated_at = CURRENT_TIMESTAMP
        """),
        {
            "sku": sku,
            "cbm": payload.cbm_per_unit,
            "mfr": payload.manufacturer_id or None,
            "firma": payload.firma_id or None,
            "ean": ean,
            "cena": cena,
            "name": payload.name.strip()[:255],
            "stock": payload.sample_stock,
        },
    )
    await db.commit()
    audit.note(f"dodał sample {sku}", resource_id=sku)
    return _mask_financials([await get_product(db, sku)], user)[0]


# ============================================================
# Ręczne usuwanie produktu — WYŁĄCZNIE super-admin
# ============================================================
# Katalog produktów budowany jest na żywo z tabel syncu (Subiekt, Sellasist, Fakturownia).
# SKU obecnego w którymkolwiek z nich NIE DA SIĘ usunąć: produkt wróciłby od razu (nie przy
# następnym syncu — przy następnym odczycie listy), tylko bez ręcznych danych (CBM, producent,
# EAN, zdjęcia, cena). Takie usunięcie niszczy pracę, a produktu nie usuwa. Do chowania
# prawdziwych SKU służy forced_status = INACTIVE.
# Usuwać można więc tylko SKU żyjące WYŁĄCZNIE w aplikacji (w praktyce: ręczne sample,
# np. testowe). Dodatkowa blokada: SKU dopisany do kontenera — usunięcie zmieniłoby kubaturę
# i wypełnienie kontenera, więc najpierw trzeba go stamtąd zdjąć.


# (etykieta, tabela, kolumna z symbolem). Kolumna porównywana po LOWER(TRIM()).
# _CATALOG_SOURCES = źródła katalogu z SALES_QUERY (src_pri 0–3). SKU spoza nich żyje w katalogu
# tylko dzięki etykiecie sample (src_pri 4) — pilnuje tego update_attrs przy odznaczaniu etykiety.
_CATALOG_SOURCES = (
    ("Subiekt", settings.TABLE_SUBIEKT_DWA, "sku"),
    ("Subiekt (stara tabela)", settings.TABLE_PRODUCTS, settings.COL_PRODUCT_SKU),
    ("Sellasist — sprzedaż", settings.TABLE_ORDER_ITEMS, settings.COL_ITEM_SKU),
    ("Sellasist — magazyn", settings.TABLE_EXTERNAL_STOCK, "sku_canon"),
)
# Usuwanie jest ostrzejsze: Fakturownia nie buduje katalogu, ale SKU z jej stanami to prawdziwy towar.
_DELETE_EXTERNAL_SOURCES = _CATALOG_SOURCES + (
    ("Fakturownia", settings.TABLE_FAKTUROWNIA_STOCK, "sku_canon"),
)

# Dane aplikacji podpięte pod SKU — kasowane razem z produktem (klucz, tabela).
_DELETE_APP_TABLES = (
    ("atrybuty", settings.TABLE_PRODUCT_ATTRS),
    ("lead_time", settings.TABLE_LEAD_TIMES),
    ("zdjecia", settings.TABLE_PRODUCT_PHOTOS),
    ("cn_sku", settings.TABLE_CN_SKU),
    ("snapshoty", settings.TABLE_STOCK_SNAPSHOTS),
)


async def _has_column(db: AsyncSession, table: str, column: str) -> bool:
    """Część tabel (zdjęcia, CN-SKU, Fakturownia) zakładana jest poza lifespanem. Zapytanie do
    nieistniejącej tabeli zrywa całą transakcję asyncpg, więc sprawdzamy schemat najpierw."""
    r = await db.execute(
        text("""
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = :t AND column_name = :c
             LIMIT 1
        """),
        {"t": table, "c": column},
    )
    return r.first() is not None


async def _found_in(db: AsyncSession, sku: str, sources: tuple) -> list:
    """Etykiety źródeł z `sources`, w których SKU występuje (pusta lista = nigdzie)."""
    found: list = []
    for label, table, col in sources:
        if not await _has_column(db, table, col):
            continue
        r = await db.execute(
            text(f"SELECT 1 FROM {table} WHERE LOWER(TRIM({col})) = LOWER(TRIM(:sku)) LIMIT 1"),
            {"sku": sku},
        )
        if r.first():
            found.append(label)
    return found


async def _delete_check(db: AsyncSession, sku: str) -> dict:
    sources = await _found_in(db, sku, _DELETE_EXTERNAL_SOURCES)

    r = await db.execute(
        text(f"""
            SELECT c.id, c.container_number, c.order_number, c.status, c.eta_date,
                   m.name AS manufacturer_name, SUM(i.quantity)::int AS quantity
              FROM {settings.TABLE_CONTAINER_ITEMS} i
              JOIN {settings.TABLE_CONTAINERS} c ON c.id = i.container_id
              LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = c.manufacturer_id
             WHERE LOWER(TRIM(i.sku)) = LOWER(TRIM(:sku))
             GROUP BY c.id, c.container_number, c.order_number, c.status, c.eta_date, m.name
             ORDER BY c.eta_date DESC, c.id DESC
        """),
        {"sku": sku},
    )
    containers = [
        {
            "id": row.id,
            "container_number": row.container_number,
            "order_number": row.order_number,
            "status": row.status,
            "eta_date": row.eta_date.isoformat() if row.eta_date else None,
            "manufacturer_name": row.manufacturer_name,
            "quantity": row.quantity,
        }
        for row in r
    ]

    attached: dict = {}
    for key, table in _DELETE_APP_TABLES:
        if not await _has_column(db, table, "sku"):
            continue
        r = await db.execute(
            text(f"SELECT COUNT(*) FROM {table} WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku))"),
            {"sku": sku},
        )
        attached[key] = int(r.scalar() or 0)

    return {
        "sku": sku,
        "external_sources": sources,
        "containers": containers,
        "attached": attached,
        "exists_in_app": any(v > 0 for v in attached.values()),
        "can_delete": not sources and not containers and any(v > 0 for v in attached.values()),
    }


@router.get("/products/{sku:path}/delete-check")
async def product_delete_check(sku: str, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_super_admin)):
    """Czy SKU da się usunąć i co go blokuje. Karta produktu odpytuje to przy otwarciu
    (tylko super-admin) i na tej podstawie pokazuje przycisk albo listę kontenerów."""
    return await _delete_check(db, sku.strip())


@router.delete("/products/{sku:path}")
async def delete_product(sku: str, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_super_admin)):
    """Usuwa SKU żyjący wyłącznie w aplikacji razem ze wszystkimi danymi aplikacji.
    Warunki sprawdzane ponownie po stronie serwera — karta mogła być otwarta długo."""
    sku = sku.strip()
    if not sku:
        raise HTTPException(400, "SKU nie może być puste")

    chk = await _delete_check(db, sku)
    if chk["external_sources"]:
        raise HTTPException(
            409,
            f"{sku} istnieje w: {', '.join(chk['external_sources'])} — po usunięciu wróciłby bez ręcznych danych. "
            "Żeby go schować, ustaw klasyfikację na Nieaktywny.",
        )
    if chk["containers"]:
        nr = ", ".join((c["container_number"] or f"#{c['id']}") for c in chk["containers"])
        raise HTTPException(409, f"{sku} jest w kontenerach: {nr}. Najpierw usuń go z kontenerów.")
    if not chk["exists_in_app"]:
        raise HTTPException(404, f"Produkt {sku} nie istnieje")

    deleted: dict = {}
    for key, table in _DELETE_APP_TABLES:
        if key not in chk["attached"]:
            continue
        r = await db.execute(
            text(f"DELETE FROM {table} WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku))"),
            {"sku": sku},
        )
        deleted[key] = r.rowcount or 0

    await db.commit()
    # Audyt PO commicie: log_audit łapie własne błędy, ale nieudany INSERT zostawiłby
    # transakcję zerwaną i usunięcie by przepadło.
    await log_audit(
        db, user, "PRODUCT_DELETED", "product", sku,
        "usunięto: " + ", ".join(f"{k}={v}" for k, v in deleted.items() if v),
        message=f"usunął produkt {sku} razem z danymi aplikacji",
        area="Produkty",
    )
    return {"sku": sku, "deleted": deleted}


# ============================================================
# Cena zakupu z innego SKU — WYŁĄCZNIE super-admin
# ============================================================
# Ten sam towar bywa sprzedawany pod dwoma symbolami (Szp3 i Szp3_szpital: dwie aukcje,
# z Fakturowni schodzi to samo łóżko). Ceny z ERP są tylko pod jednym z nich, więc drugi
# miał zero albo ręcznie przepisywaną cenę. Powiązanie każe drugiemu brać cenę zakupu
# (sql.py: SALES_QUERY i prod_prices, routers/odprawy.py::_koszt_erp) oraz koszt FIFO
# i średnią (routers/cena.py) od wzorca. Sprzedaż i prognoza zostają osobno — świadomie.
# Bez łańcuchów: wzorzec sam nie może mieć wzorca, a SKU będące wzorcem — dostać go.
@router.put("/products/{sku:path}/cena-z-sku", response_model=ProductSummary)
async def set_cena_z_sku(sku: str, payload: CenaZSku, shop: str = Query(""),
                         db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_super_admin)):
    sku = await _sku_atrybutow(db, sku)
    wzor = (payload.sku_wzorcowe or "").strip() or None
    przed = (await db.execute(
        text(f"SELECT cena_z_sku, cena_zakupu FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku = :sku"), {"sku": sku},
    )).first()

    if wzor:
        if wzor.lower() == sku.strip().lower():
            raise HTTPException(400, "Produkt nie może brać ceny sam od siebie")
        if not await _found_in(db, wzor, _DELETE_EXTERNAL_SOURCES):
            raise HTTPException(404, f"{wzor} nie ma w Subiekcie, Sellasiście ani Fakturowni — sprawdź pisownię")
        r = await db.execute(text(f"""
            SELECT sku, cena_z_sku FROM {settings.TABLE_PRODUCT_ATTRS}
             WHERE (LOWER(TRIM(sku)) = LOWER(TRIM(:wzor)) AND NULLIF(TRIM(cena_z_sku), '') IS NOT NULL)
                OR LOWER(TRIM(cena_z_sku)) = LOWER(TRIM(:sku))
             LIMIT 1
        """), {"wzor": wzor, "sku": sku})
        konflikt = r.first()
        if konflikt:
            if konflikt.sku.strip().lower() == wzor.lower():
                if konflikt.cena_z_sku.strip().lower() == sku.strip().lower():
                    raise HTTPException(409, f"{wzor} już bierze cenę z {sku} — powiązanie w drugą stronę nie ma sensu")
                raise HTTPException(409, f"{wzor} sam bierze cenę z {konflikt.cena_z_sku} — wskaż od razu {konflikt.cena_z_sku}")
            raise HTTPException(409, f"{sku} jest wzorcem ceny dla {konflikt.sku} — nie może brać ceny z innego SKU")

    # Ustawienie powiązania kasuje własną ręczną cenę: ręczna stoi w łańcuchu na szczycie,
    # więc inaczej dalej by wygrywała, a po to jest powiązanie, żeby jej nie przepisywać.
    await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, cena_z_sku, updated_at)
            VALUES (:sku, :wzor, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET
                cena_z_sku = EXCLUDED.cena_z_sku,
                cena_zakupu = CASE WHEN EXCLUDED.cena_z_sku IS NULL
                                   THEN {settings.TABLE_PRODUCT_ATTRS}.cena_zakupu ELSE NULL END,
                updated_at = CURRENT_TIMESTAMP
        """),
        {"sku": sku, "wzor": wzor},
    )
    await db.commit()

    zmiany = [{"pole": "Cena zakupu z SKU", "bylo": (przed.cena_z_sku if przed else None) or "—", "jest": wzor or "—"}]
    if wzor and przed is not None and przed.cena_zakupu:
        zmiany.append({"pole": "Cena zakupu (ręczna)", "bylo": f_zl(przed.cena_zakupu), "jest": "—"})
    audit.note(f"powiązał cenę zakupu {sku} z {wzor}" if wzor else f"zdjął powiązanie ceny zakupu {sku}",
               changes=zmiany, resource_id=sku)
    shop = resolve_shop(shop, user)
    return _mask_financials([await get_product(db, sku, shop, allowed=allowed_shops(user))], user)[0]

# ============================================================
# Zmiana SKU sampla — WYŁĄCZNIE super-admin
# ============================================================
# Sample dodaje się ręcznie, zanim towar trafi do Subiekta/Sellasista. Gdy tam dostanie inny
# symbol (Lxs1g → Lxs1cz_g), aplikacja go nie połączy: katalog łączy wszystko po SKU.
# Zmiana przepisuje SKU we WSZYSTKICH tabelach aplikacji naraz (atrybuty, kontenery, zdjęcia,
# ceny, lead time, snapshoty…), więc nic nie zostaje pod starym symbolem.
#
# Tabele bierzemy z information_schema, a nie z ręcznej listy: część zakłada lifespan, część
# pliki sql/ i serwisy — ręczna lista przy następnej nowej tabeli cicho by się rozjechała.
# Nazwy pochodzą z katalogu bazy (nie od użytkownika), wartości idą parametrami.
# Dziennik audytu zostaje nietknięty — to historia, ma pokazywać SKU z tamtej chwili.
_RENAME_POMIN = {settings.TABLE_AUDIT_LOG}


async def _tabele_z_sku(db: AsyncSession) -> list:
    """(tabela, kolumna) — tabele aplikacji (app_*) z kolumną `sku` albo `sku_canon`."""
    r = await db.execute(text(r"""
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name LIKE 'app\_%'
           AND column_name IN ('sku', 'sku_canon')
         ORDER BY table_name, column_name
    """))
    return [(t, c) for t, c in r.all() if t not in _RENAME_POMIN]


def _warunek_sku(kolumna: str, param: str) -> str:
    # sku_canon trzyma już LOWER(TRIM(sku)); zwykłe `sku` porównujemy jak w całej aplikacji.
    if kolumna == "sku_canon":
        return f"sku_canon = LOWER(TRIM(:{param}))"
    return f"LOWER(TRIM(sku)) = LOWER(TRIM(:{param}))"


@router.post("/products/{sku:path}/zmien-sku")
async def rename_product_sku(sku: str, payload: SkuZmiana, db: AsyncSession = Depends(get_db),
                             user: CurrentUser = Depends(require_super_admin)):
    """Przepisuje SKU sampla (produktu żyjącego tylko w aplikacji) na nowy symbol."""
    stare = sku.strip()
    nowe = payload.nowe_sku.strip()
    if not stare or not nowe:
        raise HTTPException(400, "SKU nie może być puste")
    if stare == nowe:
        raise HTTPException(400, "Nowe SKU jest takie samo jak obecne")

    chk = await _delete_check(db, stare)
    if chk["external_sources"]:
        # SKU z Subiekta/Sellasista wróciłby od razu pod starym symbolem — zmieniać trzeba tam.
        raise HTTPException(
            409,
            f"{stare} jest w: {', '.join(chk['external_sources'])}. SKU zmienia się tam, nie w aplikacji.",
        )
    if not chk["exists_in_app"]:
        raise HTTPException(404, f"Produkt {stare} nie istnieje")

    tabele = await _tabele_z_sku(db)

    # Nowe SKU nie może mieć już własnych danych w aplikacji — zlałyby się dwa produkty
    # (a atrybuty i lead time mają SKU jako klucz). Sama zmiana wielkości liter to ten sam SKU.
    if nowe.lower() != stare.lower():
        zajete = []
        for t, c in tabele:
            r = await db.execute(text(f'SELECT 1 FROM "{t}" WHERE {_warunek_sku(c, "nowe")} LIMIT 1'),
                                 {"nowe": nowe})
            if r.first():
                zajete.append(t)
        if zajete:
            raise HTTPException(
                409,
                f"{nowe} ma już dane w aplikacji ({', '.join(sorted(set(zajete)))}). "
                "Wybierz inne SKU albo najpierw usuń tamten produkt.",
            )

    zmienione: dict = {}
    for t, c in tabele:
        nowa_wartosc = "LOWER(TRIM(:nowe))" if c == "sku_canon" else ":nowe"
        r = await db.execute(
            text(f'UPDATE "{t}" SET {c} = {nowa_wartosc} WHERE {_warunek_sku(c, "stare")}'),
            {"nowe": nowe, "stare": stare},
        )
        if r.rowcount:
            zmienione[t] = zmienione.get(t, 0) + r.rowcount

    await db.commit()
    audit.note(f"zmienił SKU sampla {stare} → {nowe}", resource_id=nowe,
               changes=[{"pole": "SKU", "bylo": stare, "jest": nowe}])
    return {"sku": nowe, "stare_sku": stare, "zmienione": zmienione}
