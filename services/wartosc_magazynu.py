"""Wartość magazynu w czasie (wykres i KPI na pulpicie) — odtwarzana wstecz od dzisiejszego stanu.

DLACZEGO WSTECZ
---------------
Ani Subiekt, ani Sellasist nie trzymają historii stanu. Bierzemy więc stan na dziś i cofamy
się dzień po dniu o ruch z danego dnia: stan(d−1) = stan(d) − ruch(d), gdzie ruch to
przyjęcia na plus i rozchody na minus. „Dziś" jest dokładne z definicji, błąd rośnie im
dalej wstecz.

SKĄD RUCH — ZALEŻNIE OD FIRMY
-----------------------------
· AMH         → sprzedaż z Sellasista (whitelista statusów) na minus, kontenery na plus
                (dzień wejścia na magazyn: delivered_date albo ETA + odprawa), a na zakładce
                AMH dodatkowo zakupy od naszych firm (Veluxa, Acti) z Subiekta.
· Acti/Veluxa → dziennik ruchów Fakturowni (`fakturownia_ruchy`), tylko magazyn główny
                (bez „Towarów w drodze"). Tam jest WSZYSTKO, co zmienia stan: WZ i korekty,
                hurt spoza Sellasista, przekazania do AMH, RW, PZ i przesunięcia z magazynu
                „w drodze" — więc kontenerów tych firm już osobno nie doliczamy (dubel).

Dlaczego nie Sellasist dla Acti/Veluxy: sprawdzone na produkcji (10.2026) — wykres widział
tylko ~50% rozchodu Veluxy (lipiec 339 szt wobec 861 w Fakturowni) i ~60–70% Acti. Brakowało
hurtu, przekazań do AMH i zamówień w statusach spoza whitelisty („Oczekujące", „PFRON"…).
AMH świadomie zostaje na starym liczeniu — tam rozjazd z Subiektem to kilka procent.

PRZEKAZANIA WEWNĄTRZ GRUPY
--------------------------
Na zakładce Acti/Veluxy przekazanie do AMH to normalny rozchód (towar wyjechał z ich
magazynu). W widoku „wszystkie firmy" pomijamy ruchy `is_internal`: druga strona (przyjęcie
w AMH) nie jest w modelu AMH, więc liczenie tylko jednej strony zawyżałoby przeszłość grupy
o każdą przekazaną sztukę.

Odwrotnie na zakładce AMH: tam ZAKUP od Veluxy/Acti (Subiekt, `subiekt_przyjecia`, dostawca
z NIP-em naszej firmy) liczymy jako przyjęcie. Bez tego wykres AMH widział sprzedaż towaru
kupionego od Veluxy, ale nie jego wejście — przeszłość wychodziła zawyżona, a „Kapitał
łącznie" (konto + magazyn) spadał, bo zapłata Veluxie schodziła z konta, a towar „był" już
wcześniej. Sprawdzone 10.2026: od lutego ~2,5 tys. szt. za ~740 tys. zł; po doliczeniu
kapitał AMH od lutego wychodzi płasko zamiast −560 tys. W widoku „wszystkie firmy" te
zakupy pomijamy — tak jak drugą stronę (wydanie w Fakturowni Veluxy), więc się znoszą.
"""

from datetime import date, timedelta
from typing import Dict, List

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, INCLUDED_STATUS_FILTER
from services.fakturownia_history import TABELA as TABELA_RUCHY
from services.products import fetch_products

AMH = "amh"

# Subiekt (ERP AMH): tabela przyjęć i magazyn podstawowy. Dostawy z Chin idą przez magazyn
# „w drodze" (100001) i są już policzone jako kontenery; zakupy od naszych firm wpadają
# prosto na podstawowy. Te same numery co w routers/product_history.py.
TABELA_PRZYJECIA_SUBIEKT = "subiekt_przyjecia"
MAGAZYN_PODSTAWOWY_AMH = 100000

# {data: {sku_norm: ruch}} — ruch dodatni = przyjęcie, ujemny = rozchód.
Ruch = Dict[date, Dict[str, float]]


def _dodaj(ruch: Ruch, d: date, sku_norm: str, qty: float) -> None:
    kubelek = ruch.setdefault(d, {})
    kubelek[sku_norm] = kubelek.get(sku_norm, 0) + qty


def odtworz_wstecz(stock_map: Dict[str, float], price_map: Dict[str, float],
                   ruch: Ruch, today: date, days: int) -> List[dict]:
    """Punkty wykresu od najstarszego do dziś. Czysta funkcja — bez bazy, do testów.

    O(dni × produkty + zdarzenia): trzymamy bieżący stan per SKU i przesuwamy go tylko
    o ruch z danego dnia. Ruch SKU spoza katalogu (stock_map) jest ignorowany — nie mamy
    dla niego ceny ani stanu początkowego."""
    raw = {sku_norm: stock_map[sku_norm] for sku_norm in stock_map}
    # Ruch z datą > dziś (np. zamówienie z przyszłą datą) cofamy od razu — „dziś" go już zawiera.
    for d, per_sku in ruch.items():
        if d > today:
            for sku_norm, qty in per_sku.items():
                if sku_norm in raw:
                    raw[sku_norm] -= qty

    points = []
    for offset in range(0, days + 1):
        d = today - timedelta(days=offset)
        total_value = 0
        total_units = 0
        # clamp do 0 per-SKU tylko przy sumowaniu; `raw` zostaje bez clampu, żeby krok wstecz był poprawny
        for sku_norm, stock_at_d in raw.items():
            if stock_at_d <= 0:
                continue
            total_value += stock_at_d * price_map.get(sku_norm, 0)
            total_units += stock_at_d
        points.append({"date": d.isoformat(), "value": round(total_value, 2), "units": round(total_units)})
        # przejście do dnia d−1: cofamy ruch z dnia d (sprzedaż wraca na półkę, dostawa znika)
        for sku_norm, qty in ruch.get(d, {}).items():
            if sku_norm in raw:
                raw[sku_norm] -= qty

    points.reverse()  # chronologicznie (najstarszy → najnowszy)
    return points


async def _ruch_amh(db: AsyncSession, days: int, ruch: Ruch) -> None:
    """AMH: sprzedaż Sellasista na minus, kontenery firmy AMH na plus (jak dotąd)."""
    sales_query = f"""
        SELECT
            LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS sku_norm,
            DATE(o.{settings.COL_ORDER_DATE}) AS sale_date,
            SUM(oi.{settings.COL_ITEM_QTY}) AS qty
        FROM {settings.TABLE_ORDER_ITEMS} oi
        JOIN {settings.TABLE_ORDERS} o
            ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID}
           AND o.shop = oi.shop
        WHERE o.{settings.COL_ORDER_DATE} >= NOW() - INTERVAL '{int(days)} days'
            AND o.shop = :shop
            {INCLUDED_STATUS_FILTER}
        GROUP BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU})), DATE(o.{settings.COL_ORDER_DATE})
    """
    for r in (await db.execute(text(sales_query), {"shop": AMH})).mappings():
        _dodaj(ruch, r["sale_date"], r["sku_norm"], -float(r["qty"] or 0))

    # Towar wchodzi do magazynu PO odprawie celnej = ETA + CONTAINER_CUSTOMS_DAYS,
    # albo w ręcznej dacie dostawy (c.delivered_date). Firma = właściciel produktu
    # (firma_id; brak = AMH). Kontenery Acti/Veluxy są już w dzienniku Fakturowni.
    customs = int(settings.CONTAINER_CUSTOMS_DAYS)
    deliveries_query = f"""
        SELECT
            LOWER(TRIM(ci.sku)) AS sku_norm,
            DATE(COALESCE(c.delivered_date, c.eta_date + {customs})) AS deliv_date,
            SUM(ci.quantity) AS qty
        FROM {settings.TABLE_CONTAINER_ITEMS} ci
        JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
        -- DISTINCT ON: pa sluzy tu tylko do ustalenia firmy, ale SKU zduplikowane
        -- wielkoscia liter mnozylo wiersze, a nizej jest SUM(ci.quantity) —
        -- dostawy z kontenerow liczyly sie wielokrotnie i szly tak do prognozy.
        LEFT JOIN (SELECT DISTINCT ON (LOWER(TRIM(sku)))
                          LOWER(TRIM(sku)) AS sku_canon, firma_id
                   FROM {settings.TABLE_PRODUCT_ATTRS} WHERE sku IS NOT NULL
                   ORDER BY LOWER(TRIM(sku)), firma_id NULLS LAST,
                            updated_at DESC NULLS LAST) pa
               ON pa.sku_canon = LOWER(TRIM(ci.sku))
        WHERE c.eta_date IS NOT NULL
            AND COALESCE(c.delivered_date, c.eta_date + {customs}) >= (NOW() - INTERVAL '{int(days)} days')::date
            AND COALESCE(c.delivered_date, c.eta_date + {customs}) <= NOW()::date
            AND COALESCE((SELECT LOWER(af.slug) FROM {settings.TABLE_FIRMY} af WHERE af.id = pa.firma_id), 'amh') = :shop
        GROUP BY LOWER(TRIM(ci.sku)), DATE(COALESCE(c.delivered_date, c.eta_date + {customs}))
    """
    for r in (await db.execute(text(deliveries_query), {"shop": AMH})).mappings():
        _dodaj(ruch, r["deliv_date"], r["sku_norm"], float(r["qty"] or 0))


async def _ruch_zakupy_od_siostr(db: AsyncSession, od: date, ruch: Ruch) -> None:
    """AMH: zakupy od Veluxy/Acti (faktura w Subiekcie) na plus, w dniu przyjęcia.

    „Nasza firma" = NIP dostawcy równy NIP-owi którejś firmy z app_firmy poza AMH
    (porównanie po samych cyfrach — w Subiekcie i w app_firmy bywają myślniki/spacje)."""
    q = f"""
        SELECT LOWER(TRIM(p.sku)) AS sku_norm, p.data AS d, SUM(p.ilosc) AS qty
        FROM {TABELA_PRZYJECIA_SUBIEKT} p
        WHERE p.sku IS NOT NULL
            AND p.data >= :od
            AND p.magazyn_id = :magazyn
            AND p.typ = 'ZAKUP'
            AND regexp_replace(COALESCE(p.dostawca_nip, ''), '\\D', '', 'g') IN (
                SELECT regexp_replace(COALESCE(f.nip, ''), '\\D', '', 'g')
                FROM {settings.TABLE_FIRMY} f
                WHERE LOWER(f.slug) <> :amh AND COALESCE(f.nip, '') <> '')
        GROUP BY LOWER(TRIM(p.sku)), p.data
    """
    params = {"od": od, "magazyn": MAGAZYN_PODSTAWOWY_AMH, "amh": AMH}
    for r in (await db.execute(text(q), params)).mappings():
        _dodaj(ruch, r["d"], r["sku_norm"], float(r["qty"] or 0))


async def _ruch_fakturownia(db: AsyncSession, shop: str, od: date, ruch: Ruch) -> None:
    """Acti/Veluxa: ruch magazynu głównego z dziennika Fakturowni (znak = znak ilości).

    shop="" → wszystkie firmy z Fakturownią, bez przekazań wewnątrz grupy (patrz docstring modułu).
    Ruchy bez rozpoznanego SKU (sku_canon NULL) odpadają — nie wiemy, któremu produktowi je przypisać."""
    q = f"""
        SELECT r.sku_canon AS sku_norm, r.data AS d, SUM(r.ilosc) AS qty
        FROM {TABELA_RUCHY} r
        JOIN {settings.TABLE_FIRMY} f ON f.id = r.firma_id
        WHERE r.sku_canon IS NOT NULL
            AND NOT COALESCE(r.w_drodze, FALSE)
            AND r.data >= :od
            AND LOWER(f.slug) <> :amh
            AND (:shop = '' OR LOWER(f.slug) = :shop)
            AND (:shop <> '' OR NOT COALESCE(r.is_internal, FALSE))
        GROUP BY r.sku_canon, r.data
    """
    for r in (await db.execute(text(q), {"od": od, "shop": shop, "amh": AMH})).mappings():
        _dodaj(ruch, r["d"], r["sku_norm"], float(r["qty"] or 0))


async def historia_wartosci(db: AsyncSession, shop: str, days: int, favorites_only: bool) -> dict:
    """shop już przepuszczony przez resolve_shop: "" = wszystkie firmy, inaczej slug jednej firmy."""
    # DEAD_STOCK też ma stan (i wartość!), więc wchodzi do wykresu — inaczej świeży import bez sprzedaży
    # (klasyfikowany jako DEAD_STOCK) byłby niewidoczny, a jego dostawa nigdy by się nie doliczyła.
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK"}, shop)
    if favorites_only:
        products = [p for p in products if p.is_favorite]

    today = date.today()
    ruch: Ruch = {}
    if shop in ("", AMH):
        await _ruch_amh(db, days, ruch)
    if shop == AMH:
        await _ruch_zakupy_od_siostr(db, today - timedelta(days=days), ruch)
    if shop != AMH:
        await _ruch_fakturownia(db, shop, today - timedelta(days=days), ruch)

    price_map = {p.sku.strip().lower(): float(p.purchase_price or 0) for p in products}
    stock_map = {p.sku.strip().lower(): float(p.stock or 0) for p in products}
    points = odtworz_wstecz(stock_map, price_map, ruch, today, days)
    return {
        "points": points,
        "current_value": points[-1]["value"] if points else 0,
        "current_units": points[-1]["units"] if points else 0,
    }
