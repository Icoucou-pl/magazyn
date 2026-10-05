"""Zakładka „Cena" na pełnej karcie produktu.

  GET /api/products/{sku}/cena?shop=…   koszt zakupu z kontenerów, rozkład stanu na dostawy,
                                         koszt z ERP do porównania i zapisane ceny sprzedaży
  PUT /api/products/{sku}/cena           zapis sugerowanej ceny (sklepy albo dropy)
  GET /api/cena/lista?shop=…            VAT, FIFO i średnia ważona hurtem — kolumny listy „Produkty"
  GET /api/products/{sku}/koszt?shop=…  sama średnia ważona + cena z ERP do nagłówka karty
                                         (uprawnienie „Cena zakupu produktu" albo finanse)

Rachunek siedzi w services/cena.py (czysty, z testami). Tu tylko zbieramy dane.

Zapisana cena żyje WYŁĄCZNIE na tej zakładce — nie trafia do nagłówka karty, list
ani Dropów. Jedna cena na SKU i kanał; ponowny zapis nadpisuje poprzednią
(ślad zmian zostaje w audycie mutacji).

Tabela app_product_ceny powstaje migracją SQL puszczaną ręcznie przed wdrożeniem
(sql/2026-10-cena-produktu.sql) — tak jak tabele odpraw.
"""

from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

import audit
from audit_opisy import f_map, f_proc, f_zl
from config import settings
from database import get_db
from models import (
    CenaDostawaOut, CenaProduktuOut, CenaZapisanaOut, CenaZapisIn, CurrentUser, CenaListaPozycja, KosztNaglowekOut,
)
from routers.odprawy import _koszt_erp
from security import (
    allowed_shops, can_edit_product_price, can_view_purchase_price, get_current_user,
    require_product_price_edit,
    require_product_price_view, require_purchase_price_view, resolve_shop,
)
from services.cena import (
    VAT_DOMYSLNY, BladCeny, Dostawa, policz_koszty, vat_produktow, vat_produktu, wylicz_cene,
)
from services.containers import compute_effective_status
from services.products import _arrival_and_source, fetch_products, get_product

router = APIRouter(prefix="/api", tags=["cena"])

TABELA = "app_product_ceny"
WSZYSTKIE_STATUSY = ("ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE", "SAMPLE")

# Dziennik audytu: co z zapisanej ceny pokazujemy w „było → jest”.
_BAZY = {"fifo": "FIFO", "srednia": "średnia", "ostatnia": "ostatnia dostawa", "reczna": "ręczna"}
POLA_CENY = {
    "cena_brutto": ("Cena brutto", f_zl),
    "cena_netto": ("Cena netto", f_zl),
    "baza": ("Baza kosztu", f_map(_BAZY)),
    "koszt_bazy": ("Koszt / szt.", f_zl),
    "tryb": ("Tryb", f_map({"marza": "marża", "narzut": "narzut"})),
    "procent": ("Procent", f_proc),
    "wysylka": ("Wysyłka", f_zl),
    "prowizja": ("Prowizja", f_proc),
    "vat": ("VAT", f_proc),
}


# Pozycje kontenerów z tym, czego potrzebuje rachunek kosztu. Bez WHERE — karta produktu
# dokleja filtr po SKU, lista produktów bierze całość jednym zapytaniem.
_DOSTAWY_SQL = f"""
            SELECT ci.id AS item_id, ci.sku, ci.container_id, ci.quantity, ci.unit_cost,
                   ci.cena_zakupu_pln, ci.cena_zakupu_waluta, ci.koszt_jednostkowy, ci.koszt_zrodlo,
                   c.container_number, c.order_number, c.status, c.eta_date,
                   c.delivered_date, c.expected_delivery_date,
                   COALESCE(l.subiekt_wbite, c.subiekt_wbite, FALSE) AS wbite,
                   l.order_number AS lot_order_number,
                   COALESCE(lm.name, m.name) AS manufacturer_name,
                   o.waluta AS waluta
              FROM {settings.TABLE_CONTAINER_ITEMS} ci
              JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
              LEFT JOIN {settings.TABLE_CONTAINER_LOTS} l ON l.id = ci.lot_id
              LEFT JOIN {settings.TABLE_MANUFACTURERS} lm ON lm.id = l.manufacturer_id
              LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = c.manufacturer_id
              LEFT JOIN app_odprawy o ON o.id = ci.koszt_odprawa_id
"""


def _dostawa(r) -> Dostawa:
    """Wiersz pozycji kontenera → Dostawa do rachunku w services/cena.py."""
    data, zrodlo = _arrival_and_source(dict(r))
    eff, _, _ = compute_effective_status(r["status"], r["eta_date"], r["expected_delivery_date"])
    u_nas = bool(r["wbite"]) or eff == "DELIVERED" or r["delivered_date"] is not None
    rozliczona = r["koszt_zrodlo"] == "odprawa" and r["koszt_jednostkowy"]
    # Cena z FV: przy rozliczonej dostawie ta z odprawy (wartość z SAD × kurs zapłaty),
    # przy nierozliczonej — cena wpisana na pozycji kontenera (PLN z Fakturowni).
    fv = r["cena_zakupu_pln"] if rozliczona and r["cena_zakupu_pln"] else r["unit_cost"]
    return Dostawa(
        item_id=r["item_id"], container_id=r["container_id"],
        container_number=(r["container_number"] or "").strip(),
        data=data, data_zrodlo=zrodlo, szt=int(r["quantity"] or 0), u_nas=u_nas,
        cena_fv_pln=float(fv) if fv else None,
        cena_fv_waluta=float(r["cena_zakupu_waluta"]) if rozliczona and r["cena_zakupu_waluta"] else None,
        waluta=r["waluta"] if rozliczona else None,
        koszt_jednostkowy=float(r["koszt_jednostkowy"]) if rozliczona else None,
    )


async def _dostawy(db: AsyncSession, sku: str) -> "tuple[List[Dostawa], Dict[int, dict]]":
    """Wszystkie pozycje kontenerów z tym SKU (+ metadane do odpowiedzi)."""
    rows = (await db.execute(
        text(_DOSTAWY_SQL + " WHERE LOWER(TRIM(ci.sku)) = LOWER(TRIM(:s))"), {"s": sku},
    )).mappings().all()

    out: List[Dostawa] = []
    meta: Dict[int, dict] = {}
    for r in rows:
        out.append(_dostawa(r))
        meta[r["item_id"]] = {
            "order_number": r["order_number"], "lot_order_number": r["lot_order_number"],
            "manufacturer_name": r["manufacturer_name"],
        }
    return out, meta


async def _dostawy_wszystkie(db: AsyncSession) -> Dict[str, List[Dostawa]]:
    """Pozycje WSZYSTKICH kontenerów, pogrupowane po SKU (klucz LOWER(TRIM)) — do listy produktów."""
    rows = (await db.execute(text(_DOSTAWY_SQL))).mappings().all()
    out: Dict[str, List[Dostawa]] = {}
    for r in rows:
        klucz = (r["sku"] or "").strip().lower()
        if klucz:
            out.setdefault(klucz, []).append(_dostawa(r))
    return out


async def _narzut_globalny(db: AsyncSession) -> Optional[float]:
    """Średni narzut importu wszystkich rozliczonych pozycji (ważony wartością z FV)."""
    row = (await db.execute(
        text(f"""
            SELECT SUM(koszt_jednostkowy * quantity)::float AS koszt,
                   SUM(cena_zakupu_pln * quantity)::float AS fv
              FROM {settings.TABLE_CONTAINER_ITEMS}
             WHERE koszt_zrodlo = 'odprawa' AND koszt_jednostkowy > 0 AND cena_zakupu_pln > 0
        """),
    )).mappings().first()
    if not row or not row["fv"]:
        return None
    return (row["koszt"] / row["fv"] - 1) * 100


async def _slug_firmy(db: AsyncSession, firma_id: Optional[int]) -> str:
    if not firma_id:
        return "amh"    # NULL = AMH, jak w całej aplikacji
    s = (await db.execute(
        text(f"SELECT LOWER(slug) FROM {settings.TABLE_FIRMY} WHERE id = :id"), {"id": firma_id},
    )).scalar_one_or_none()
    return s or "amh"


def _zapisana(r) -> CenaZapisanaOut:
    f = lambda v: float(v) if v is not None else 0.0   # noqa: E731
    return CenaZapisanaOut(
        kanal=r["kanal"], baza=r["baza"], koszt_bazy=f(r["koszt_bazy"]), tryb=r["tryb"],
        procent=f(r["procent"]), wysylka=f(r["wysylka"]), prowizja=f(r["prowizja"]), vat=f(r["vat"]),
        cena_netto=f(r["cena_netto"]), cena_brutto=f(r["cena_brutto"]), shop=r["shop"],
        zapisal=r["zapisal"], zapisano=r["zapisano"],
    )


async def _zapisane(db: AsyncSession, sku: str) -> List[CenaZapisanaOut]:
    rows = (await db.execute(
        text(f"SELECT * FROM {TABELA} WHERE sku_canon = LOWER(TRIM(:s)) ORDER BY kanal"),
        {"s": sku},
    )).mappings().all()
    return [_zapisana(r) for r in rows]


async def _policz(db: AsyncSession, sku: str, shop: str, user: CurrentUser):
    """Wspólny rachunek zakładki „Cena" i nagłówka karty: produkt, koszty dostaw, cena z ERP."""
    p = await get_product(db, sku, shop, allowed=allowed_shops(user))
    # Stan do rozkładu: magazyn główny + to, co już wbite do „w drodze" (towar kupiony,
    # w ERP, tylko jeszcze nie przesunięty MM-ką). Kontenery niewbite nie liczą się do stanu.
    stan = int(p.stock or 0) + int(p.stock_in_transit_wbite or 0)

    dostawy, meta = await _dostawy(db, p.sku)
    w = policz_koszty(dostawy, stan, await _narzut_globalny(db))

    # Koszt z ERP: firmy z przełącznika, a na „Wszystkich" — firmy, która ten towar importuje.
    slug = shop or await _slug_firmy(db, p.firma_id)
    zrodlo, ceny = await _koszt_erp(db, slug, [p.sku])
    return p, stan, w, meta, slug, zrodlo, ceny


@router.get("/cena/lista", response_model=List[CenaListaPozycja])
async def cena_lista(shop: str = Query(""), db: AsyncSession = Depends(get_db),
                     user: CurrentUser = Depends(get_current_user)):
    """VAT, koszt FIFO i średnia ważona dla wszystkich produktów — kolumny listy „Produkty".

    Ten sam rachunek co zakładka „Cena", tylko hurtem: jedno zapytanie o wszystkie pozycje
    kontenerów i jedno o VAT, stan z tej samej listy produktów co tabela (ta sama firma).
    VAT nie jest tajemnicą — widzi go każdy. FIFO i średnia jak koszt w nagłówku karty:
    finanse ALBO „Cena zakupu produktu"; bez tego pola wracają puste.
    """
    shop = resolve_shop(shop, user)
    widzi_koszt = can_view_purchase_price(user)
    produkty = await fetch_products(db, set(WSZYSTKIE_STATUSY), shop)
    vaty = await vat_produktow(db, shop)
    dostawy = await _dostawy_wszystkie(db) if widzi_koszt else {}
    narzut = await _narzut_globalny(db) if widzi_koszt else None
    out: List[CenaListaPozycja] = []
    for p in produkty:
        klucz = p.sku.strip().lower()
        fifo = srednia = None
        if widzi_koszt and klucz in dostawy:
            stan = int(p.stock or 0) + int(p.stock_in_transit_wbite or 0)
            w = policz_koszty(dostawy[klucz], stan, narzut)
            fifo, srednia = w.fifo, w.srednia
        out.append(CenaListaPozycja(sku=p.sku, vat=vaty.get(klucz, VAT_DOMYSLNY), fifo=fifo, srednia=srednia))
    return out


@router.get("/products/{sku:path}/koszt", response_model=KosztNaglowekOut)
async def koszt_naglowek(sku: str, shop: str = Query(""), db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_purchase_price_view)):
    """Koszt do nagłówka karty: średnia ważona z kontenerów + cena z ERP do porównania.

    Osobny, chudy endpoint, bo nagłówek widzi każdy z „Ceną zakupu produktu" — także bez
    danych finansowych i bez zakładki „Cena". Nie oddajemy tu dostaw, FIFO ani zapisanych cen.
    """
    shop = resolve_shop(shop, user)
    p, _, w, _, _, zrodlo, ceny = await _policz(db, sku, shop, user)
    return KosztNaglowekOut(srednia=w.srednia, erp_zrodlo=zrodlo,
                            erp_cena=ceny.get(p.sku.strip().lower()))


@router.get("/products/{sku:path}/cena", response_model=CenaProduktuOut)
async def cena_produktu(sku: str, shop: str = Query(""), db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_product_price_view)):
    shop = resolve_shop(shop, user)
    p, stan, w, meta, slug, zrodlo, ceny = await _policz(db, sku, shop, user)

    vat = await vat_produktu(db, p.sku, shop or slug)

    return CenaProduktuOut(
        vat=vat["vat"], vat_zrodlo=vat["zrodlo"],
        sku=p.sku, shop=shop, stan=stan, poza_dostawami=w.poza_dostawami,
        erp_zrodlo=zrodlo, erp_cena=ceny.get(p.sku.strip().lower()),
        fifo=w.fifo, fifo_item_id=w.fifo_item_id,
        srednia=w.srednia, srednia_szt=w.srednia_szt, srednia_pominieto_szt=w.srednia_pominieto_szt,
        ostatnia=w.ostatnia, ostatnia_item_id=w.ostatnia_item_id,
        min=w.min, min_item_id=w.min_item_id, max=w.max, max_item_id=w.max_item_id,
        sredni_narzut_proc=w.sredni_narzut_proc, narzut_zrodlo=w.narzut_zrodlo,
        dostawy=[CenaDostawaOut(
            item_id=d.item_id, container_id=d.container_id, container_number=d.container_number,
            order_number=meta[d.item_id]["order_number"],
            lot_order_number=meta[d.item_id]["lot_order_number"],
            manufacturer_name=meta[d.item_id]["manufacturer_name"],
            data=d.data, data_zrodlo=d.data_zrodlo, status="u_nas" if d.u_nas else "w_drodze",
            szt=d.szt, na_stanie=d.na_stanie, cena_fv_pln=d.cena_fv_pln,
            cena_fv_waluta=d.cena_fv_waluta, waluta=d.waluta, koszt=d.koszt, szacunek=d.szacunek,
            narzut_proc=d.narzut_proc, rozliczenie="odprawa" if d.rozliczona else "brak",
            odstaje=d.odstaje, fifo=d.fifo,
        ) for d in w.dostawy],
        zapisane=await _zapisane(db, p.sku),
        uwagi=w.uwagi,
        moze_zapisac=can_edit_product_price(user),
    )


@router.put("/products/{sku:path}/cena", response_model=CenaZapisanaOut)
async def zapisz_cene(sku: str, body: CenaZapisIn, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(require_product_price_edit)):
    # Cenę liczymy po stronie serwera z parametrów — front pokazuje to samo tą samą formułą,
    # ale do bazy nie wpuszczamy liczby, której nie da się odtworzyć z zapisanych ustawień.
    try:
        c = wylicz_cene(body.koszt_bazy, body.tryb, body.procent, body.wysylka, body.prowizja, body.vat)
    except BladCeny as e:
        raise HTTPException(422, str(e))
    shop = resolve_shop(body.shop or "", user)
    stara = (await db.execute(
        text(f"SELECT * FROM {TABELA} WHERE sku_canon = LOWER(TRIM(:sku)) AND kanal = :kanal"),
        {"sku": sku, "kanal": body.kanal},
    )).mappings().first()
    row = (await db.execute(
        text(f"""
            INSERT INTO {TABELA}
                (sku_canon, sku, kanal, baza, koszt_bazy, tryb, procent, wysylka, prowizja, vat,
                 cena_netto, cena_brutto, shop, zapisal_user_id, zapisal, zapisano)
            VALUES (LOWER(TRIM(:sku)), TRIM(:sku), :kanal, :baza, :koszt, :tryb, :proc, :wys, :prow, :vat,
                    :netto, :brutto, :shop, :uid, :kto, :teraz)
            ON CONFLICT (sku_canon, kanal) DO UPDATE SET
                sku = EXCLUDED.sku, baza = EXCLUDED.baza, koszt_bazy = EXCLUDED.koszt_bazy,
                tryb = EXCLUDED.tryb, procent = EXCLUDED.procent, wysylka = EXCLUDED.wysylka,
                prowizja = EXCLUDED.prowizja, vat = EXCLUDED.vat, cena_netto = EXCLUDED.cena_netto,
                cena_brutto = EXCLUDED.cena_brutto, shop = EXCLUDED.shop,
                zapisal_user_id = EXCLUDED.zapisal_user_id, zapisal = EXCLUDED.zapisal,
                zapisano = EXCLUDED.zapisano
            RETURNING *
        """),
        {
            "sku": sku, "kanal": body.kanal, "baza": body.baza, "koszt": c.koszt_bazy,
            "tryb": body.tryb, "proc": body.procent, "wys": body.wysylka, "prow": body.prowizja,
            "vat": body.vat, "netto": c.netto, "brutto": c.brutto, "shop": shop,
            "uid": user.id, "kto": user.full_name or user.email,
            "teraz": datetime.now(timezone.utc),
        },
    )).mappings().first()
    await db.commit()
    ch = audit.zmiany(dict(stara) if stara else None, dict(row), POLA_CENY)
    if not ch:
        audit.skip()
    else:
        bylo = f" (było {f_zl(stara['cena_brutto'])})" if stara and stara["cena_brutto"] != row["cena_brutto"] else ""
        audit.note(f"zapisał cenę „{body.kanal}” produktu {sku.strip()}: {f_zl(row['cena_brutto'])} brutto{bylo}",
                   changes=ch, resource_id=sku.strip())
    return _zapisana(row)
