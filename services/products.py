"""
Logika produktowa: klasyfikacja statusu, prognoza wyczerpania zapasu,
pobieranie listy produktów z naliczonymi metrykami.
"""

from datetime import date, timedelta
from typing import List, Dict

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from sql import SALES_QUERY, INCOMING_QUERY, TRANSFER_STOCK_QUERY
from models import ProductSummary, IncomingDelivery
from services.containers import compute_effective_status


def _arrival_and_source(inc: dict):
    """Data wejścia na magazyn dla dostawy z kontenera + skąd pochodzi.

    Kolejność (jak warehouse_delivery_date przy kontenerach):
      1. delivered_date         — potwierdzona dostawa (ręczna),
      2. expected_delivery_date — „u nas": umówiony odbiór znany w trakcie odprawy,
      3. eta_date + odprawa     — automat (domyślnie ETA + CONTAINER_CUSTOMS_DAYS).
    """
    if inc.get("delivered_date"):
        return inc["delivered_date"], "delivered"
    if inc.get("expected_delivery_date"):
        return inc["expected_delivery_date"], "expected"
    n = max(0, int(settings.CONTAINER_CUSTOMS_DAYS))
    return inc["eta_date"] + timedelta(days=n), "estimate"


def classify_product(row: dict) -> str:
    """Status produktu. Ręczne wymuszenie (forced_status) ma najwyższy priorytet.

    SAMPLE to etykieta, nie wynik obliczeń: produkt oznaczony is_sample dostaje status SAMPLE
    niezależnie od stanu i sprzedaży. Dzięki temu wypada z auto-sugestii, listy zakupów i anomalii
    (te czytają wyłącznie ACTIVE / ACTIVE_NO_STOCK) i nie zaśmieca dead stocku zerową sprzedażą.
    Gdy sample się przyjmie — odznaczasz etykietę i produkt wraca do normalnej klasyfikacji.
    """
    forced = row.get("forced_status")
    if forced and forced in ("ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"):
        return forced

    if row.get("is_sample", False):
        return "SAMPLE"

    # Status liczony GLOBALNIE (ze wszystkich sklepów), niezależnie od wybranej zakładki:
    # produkt aktywny gdziekolwiek jest aktywny wszędzie. Liczby per-sklep (stock, sales_*)
    # zostają do wyświetlania i prognozy — status to osobna oś widoczności.
    stock = row.get("stock_global", row["stock"])
    sales_12m = row.get("sales_12m_global", row["sales_12m_total"])
    if row.get("force_visible", False):
        return "ACTIVE"
    if stock > 0 and sales_12m > 0:
        return "ACTIVE"
    if stock == 0 and sales_12m > 0:
        return "ACTIVE_NO_STOCK"
    if stock > 0 and sales_12m == 0:
        return "DEAD_STOCK"
    return "INACTIVE"


# Kod sklepu (magazynu) → etykieta wyświetlana w znaczniku „↔ z [magazyn]".
_SHOP_LABEL = {"amh": "AMH", "acti": "Acti", "veluxa": "Veluxa"}


def calculate_forecast(row: dict, incoming: List[dict],
                       transfer_stock: List[dict] = None, shop: str = "",
                       erp_transit: int = 0, skip_wbite: bool = True) -> ProductSummary:
    """Liczy prognozę: średnia ważona sprzedaż, dzień wyczerpania, data zamówienia, status."""
    sales_1m = row["sales_1m_total"]
    sales_2m_avg = row["sales_2m_total"] / 2
    sales_3m_avg = row["sales_3m_total"] / 3
    sales_4m_avg = row["sales_4m_total"] / 4

    avg_monthly = sales_1m * 0.4 + sales_2m_avg * 0.3 + sales_3m_avg * 0.2 + sales_4m_avg * 0.1
    base_daily_sales = avg_monthly / 30 if avg_monthly > 0 else 0

    today = date.today()
    eta_map = {}
    stock_in_transit = 0
    transit_wbite = 0
    transit_containers = 0
    nearest_date = None
    nearest_source = None
    incoming_deliveries = []

    for inc in incoming:
        arrival, src = _arrival_and_source(inc)
        # Towar wchodzi na magazyn dnia `arrival`. Póki arrival jest dziś/w przyszłości —
        # jest „w drodze" i NIE ma go jeszcze w stan_dostepny (to magazyn fizyczny, potwierdzone).
        # Gdy arrival już minął — wleciał do Subiektu i nie liczymy go drugi raz.
        # (Dawniej filtr szedł po surowej ETA i zjadał dostawę w oknie odprawy.)
        if arrival < today:
            continue
        # Wbite loty są już w magazynie „w drodze" ERP (Subiekt/Fakturownia) — liczymy je
        # z erp_transit, NIE z kontenera, żeby nie było dubla. Veluxa (skip_wbite=False,
        # brak wpiętej Fakturowni) liczy wszystko z kontenerów po staremu.
        if skip_wbite and inc.get("wbite"):
            continue
        qty = inc["quantity"]
        eta_map.setdefault(arrival, 0)
        eta_map[arrival] += qty
        stock_in_transit += qty
        transit_containers += qty
        if nearest_date is None or arrival < nearest_date:
            nearest_date, nearest_source = arrival, src
        eff, _is_auto, _days_left = compute_effective_status(
            inc["status"], inc["eta_date"], inc.get("expected_delivery_date"))
        incoming_deliveries.append(IncomingDelivery(
            container_id=inc["container_id"],
            container_number=inc["container_number"],
            eta_date=inc["eta_date"],
            quantity=qty,
            status=inc["status"],
            warehouse_delivery_date=arrival,
            date_source=src,
            effective_status=eff,
            wbite=bool(inc.get("wbite")),
            is_consolidated=bool(inc.get("is_consolidated")),
            lot_order_number=inc.get("lot_order_number"),
            manufacturer_name=inc.get("manufacturer_name"),
        ))

    # Magazyn „w drodze" z ERP firmy (AMH→Subiekt drugi magazyn, Acti→Fakturownia).
    # Zastępuje dawne liczenie „wbite" z kontenera — jedno źródło prawdy, spójne z Raportami.
    # Bez daty ETA (towar już fizycznie leży w magazynie „w drodze") → dostępny od dziś.
    transit_wbite = int(erp_transit or 0)
    if transit_wbite > 0:
        eta_map[today] = eta_map.get(today, 0) + transit_wbite
        stock_in_transit += transit_wbite

    current_stock = float(row["stock"])
    days_until_empty = 9999

    if base_daily_sales > 0:
        for offset in range(0, 730):
            check_date = today + timedelta(days=offset)
            if check_date in eta_map:
                current_stock += eta_map[check_date]
            current_stock -= base_daily_sales
            if current_stock <= 0:
                days_until_empty = offset
                break

    empty_date = today + timedelta(days=days_until_empty)
    order_date = empty_date - timedelta(days=row["lead_time_days"])
    days_until_order = (order_date - today).days

    if days_until_order <= 0 and days_until_empty < row["lead_time_days"]:
        status = "KRYTYCZNY"
    elif days_until_order <= 7:
        status = "ZAMOW_TERAZ"
    elif days_until_order <= 30:
        status = "ZAMOW_WKROTCE"
    else:
        status = "OK"

    # „W drodze" — pożar ugaszony zamówieniem. Produkt, który normalnie byłby do zamówienia
    # (KRYTYCZNY/ZAMOW_TERAZ/ZAMOW_WKROTCE), ale ma dość towaru w drodze, by pokryć min. 1 miesiąc
    # popytu, dostaje osobny status W_DRODZE → wypada z pożarów i z listy zakupów (nic nie zamawiamy).
    # Jeśli w drodze jedzie ZA MAŁO (nie pokrywa miesiąca) — zostaje pożarem, a front dokłada „+N w drodze".
    # Próg = 1× avg_monthly; łatwo podbić do ×2, gdyby okno odprawy/lead time wymagało zapasu.
    if status in ("KRYTYCZNY", "ZAMOW_TERAZ", "ZAMOW_WKROTCE") and stock_in_transit > 0 \
            and (row["stock"] + stock_in_transit) >= avg_monthly:
        status = "W_DRODZE"

    # „Zaciągnij z [magazynu]" — gdy produkt jest lokalnie krótki, ale magazyn siostry
    # (Acti/Veluxa z Sellasista) ma jego stan, to NIE jest zamówienie z Chin, tylko przesunięcie.
    # Pokazujemy tylko gdy realnie gasi pożar: dociągnięcie z największej siostry daje lokalnie
    # ≥ 1 miesiąc popytu (row.stock + qty_siostry ≥ avg_monthly). Wykluczamy aktualnie wybrany
    # magazyn (na zakładce Veluxy nie proponujemy „z Veluxy"). Surowy stan, nie nadwyżka — v1.
    # Uwaga: liczymy TYLKO dla konkretnej zakładki sklepu. Na „Wszystkich" (shop="") row.stock
    # jest już pulą grupy (zawiera stany sióstr), więc transfer nie ma sensu — pożar tam = cała
    # grupa krótka. Ograniczenie do shop != "" zapobiega podwójnemu liczeniu i fałszywym znacznikom.
    transfer_source_shop = None
    transfer_source_qty = 0
    if transfer_stock and avg_monthly > 0 and shop:
        siblings = sorted(
            ((t["shop"], int(t["qty"])) for t in transfer_stock
             if t.get("qty") and t.get("shop") and (not shop or t["shop"] != shop)),
            key=lambda s: s[1], reverse=True)
        if siblings:
            top_shop, top_qty = siblings[0]
            if (row["stock"] + top_qty) >= avg_monthly:
                transfer_source_shop = _SHOP_LABEL.get(top_shop, top_shop)
                transfer_source_qty = top_qty

    total_available = row["stock"] + stock_in_transit
    months_of_stock = (total_available / avg_monthly) if avg_monthly > 0 else 999.0
    price = float(row.get("price") or 0)

    return ProductSummary(
        sku=row["sku"],
        name=row["name"] or "",
        name_override_manual=row.get("name_override_manual"),
        stock=float(row["stock"] or 0),
        stock_value=round(row["stock"] * price, 2),
        purchase_price=round(price, 2),
        cena_zakupu_manual=(round(float(row["cena_zakupu_manual"]), 2) if row.get("cena_zakupu_manual") is not None else None),
        stock_in_transit=stock_in_transit,
        stock_in_transit_wbite=transit_wbite,
        stock_in_transit_containers=transit_containers,
        nearest_delivery_date=nearest_date,
        nearest_delivery_source=nearest_source,
        product_status=classify_product(row),
        cbm_per_unit=row.get("cbm_per_unit", 0),
        manufacturer_id=row.get("manufacturer_id"),
        manufacturer_name=row.get("manufacturer_name"),
        manufacturer_color=row.get("manufacturer_color"),
        firma_id=row.get("firma_id"),
        firma_name=row.get("firma_name"),
        firma_color=row.get("firma_color"),
        seasonality_enabled=row.get("seasonality_enabled", False),
        is_favorite=row.get("is_favorite", False),
        is_sample=bool(row.get("is_sample", False)),
        sample_stock=int(row.get("sample_stock") or 0),
        ean=row.get("ean"),
        forced_status=row.get("forced_status"),
        lead_time_days=row["lead_time_days"],
        sales_1m=sales_1m,
        sales_2m=round(sales_2m_avg),
        sales_3m=round(sales_3m_avg),
        sales_4m=round(sales_4m_avg),
        sales_yoy_30d=row.get("sales_yoy_30d", 0),
        sales_yoy_next_30d=row.get("sales_yoy_next_30d", 0),
        avg_monthly_weighted=round(avg_monthly, 1),
        months_of_stock=round(months_of_stock, 1),
        days_until_empty=days_until_empty,
        days_until_order=days_until_order,
        empty_date=empty_date,
        order_date=order_date,
        status=status,
        no_reorder=bool(row.get("no_reorder", False)),
        transfer_source_shop=transfer_source_shop,
        transfer_source_qty=transfer_source_qty,
        incoming_deliveries=sorted(incoming_deliveries, key=lambda d: d.warehouse_delivery_date),
    )


async def fetch_products(db: AsyncSession, include_set: set, shop: str = "") -> List[ProductSummary]:
    """Pobiera produkty z metrykami, filtrowane po statusie (include_set).
    shop="" = wszystkie sklepy; "amh"/"acti"/"veluxa" = sprzedaż i stan tylko danego sklepu (Faza 3).

    Uwaga: status dostawy kontenerów liczy się WYŁĄCZNIE miękko przez
    compute_effective_status (ETA → odprawa celna → auto-dostawa). Nie ruszamy
    tu kolumny `status` w bazie — dawny auto_deliver_containers przepisywał
    IN_TRANSIT→DELIVERED w dniu ETA i tym samym zjadał okno odprawy."""
    products_result = await db.execute(text(SALES_QUERY), {"default_lead_time": settings.DEFAULT_LEAD_TIME_DAYS, "shop": shop})
    products = [dict(r._mapping) for r in products_result]

    incoming_result = await db.execute(text(INCOMING_QUERY))
    incoming_all = [dict(r._mapping) for r in incoming_result]

    incoming_by_sku = {}
    for inc in incoming_all:
        key = inc["sku"].strip().lower() if inc["sku"] else ""
        incoming_by_sku.setdefault(key, []).append(inc)

    # Magazyn „w drodze" z ERP — źródło zależne od firmy (identycznie jak w Raportach):
    #   AMH  → drugi magazyn Subiektu (subiekt_dwa_magazyny.stan_magazyn_w_drodze)
    #   Acti → Fakturownia „Towary w drodze" (fakturownia_stock.in_transit_qty)
    # Klucz LOWER(TRIM(sku)) — spójnie z resztą sklejania po SKU.
    subiekt_transit: Dict[str, int] = {}
    r = await db.execute(text(f"""
        SELECT LOWER(TRIM(sku)) AS k, COALESCE(SUM(stan_magazyn_w_drodze), 0) AS q
        FROM {settings.TABLE_SUBIEKT_DWA}
        WHERE sku IS NOT NULL AND stan_magazyn_w_drodze IS NOT NULL AND stan_magazyn_w_drodze > 0
        GROUP BY LOWER(TRIM(sku))
    """))
    for m in r.mappings():
        subiekt_transit[m["k"]] = int(m["q"] or 0)

    fakturownia_transit: Dict[str, int] = {}
    r = await db.execute(text(f"""
        SELECT LOWER(TRIM(fs.sku)) AS k, COALESCE(SUM(fs.in_transit_qty), 0) AS q
        FROM {settings.TABLE_FAKTUROWNIA_STOCK} fs
        JOIN {settings.TABLE_FIRMY} f ON f.id = fs.firma_id
        WHERE LOWER(f.slug) = 'acti' AND fs.sku IS NOT NULL AND fs.in_transit_qty > 0
        GROUP BY LOWER(TRIM(fs.sku))
    """))
    for m in r.mappings():
        fakturownia_transit[m["k"]] = int(m["q"] or 0)

    # Stan sióstr (Sellasist) per SKU — osobne lekkie zapytanie, mergowane po SKU (jak incoming).
    # Bez parametru :shop — filtr „inny magazyn niż wybrany" robimy w calculate_forecast.
    transfer_result = await db.execute(text(TRANSFER_STOCK_QUERY))
    transfer_by_sku = {}
    for t in transfer_result.mappings():
        key = (t["sku_canon"] or "").strip().lower()
        if key:
            transfer_by_sku.setdefault(key, []).append({"shop": t["shop"], "qty": t["qty"]})

    results = []
    for p in products:
        if classify_product(p) not in include_set:
            continue
        sku_key = p["sku"].strip().lower() if p["sku"] else ""
        p_firma = (p.get("firma_slug") or "amh").strip().lower()
        # Kontekst magazynu: konkretna zakładka → jej firma; „Wszyscy" → firma produktu.
        cf = shop if shop else p_firma
        # Magazyn „w drodze" z ERP właściwego dla kontekstu (Subiekt / Fakturownia / 0).
        if cf == "amh":
            erp = subiekt_transit.get(sku_key, 0)
        elif cf == "acti":
            erp = fakturownia_transit.get(sku_key, 0)
        else:
            erp = 0
        # Kontenery pokazujemy tylko na zakładce firmy produktu — bez przecieku na obcą
        # firmę (np. kontener Acti nie doklei się do zakładki AMH dla produktu dwufirmowego).
        inc_lines = incoming_by_sku.get(sku_key, [])
        if shop and p_firma != shop:
            inc_lines = []
        # Wbite wykluczamy tylko dla firm z wpiętym ERP (AMH, Acti); Veluxa liczy wszystko.
        skip_wbite = cf in ("amh", "acti")
        results.append(calculate_forecast(
            p, inc_lines,
            transfer_stock=transfer_by_sku.get(sku_key, []), shop=shop,
            erp_transit=erp, skip_wbite=skip_wbite))
    return results


async def get_product(db: AsyncSession, sku: str) -> ProductSummary:
    """Pojedynczy produkt po SKU (szuka we wszystkich statusach). Rzuca 404."""
    from fastapi import HTTPException
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE", "SAMPLE"})
    for p in products:
        if p.sku == sku:
            return p
    raise HTTPException(404, f"Produkt {sku} nie znaleziony")
