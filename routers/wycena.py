"""Zakładki „test-wycena” i „test-cena” na pełnej karcie produktu.

Na razie obok istniejącej zakładki „Cena” (nic w niej nie zmieniamy) i TYLKO dla superadmina
(zależność na całym routerze) — właściciel testuje,
potem „test-wycena” zastąpi „Cenę”, a „test-cena” zostanie zakładką dla zespołu.

  GET    /api/ceny-produktu?sku=…&shop=…   „test-cena”: same wyniki dla zespołu (viewPriceSummary)
  GET    /api/wycena?sku=…&shop=…          „test-wycena”: koszty, ceny minimalne z historią,
                                            konkurencja, szablony (jak zakładka „Cena”)
  PUT    /api/wycena/cena                   zapis ceny z kalkulatora: minimalna albo sugerowana
                                            (detal, dropy/hurt, allegro — services/wycena.py → KANALY)
  POST   /api/wycena/konkurencja            cena u konkurencji (ten sam sklep = nowa cena, stara do historii)
  DELETE /api/wycena/konkurencja/{id}       usunięcie sklepu z listy
  POST   /api/wycena/szablony               nowy szablon kalkulatora
  PUT    /api/wycena/szablony/{id}          zmiana szablonu
  DELETE /api/wycena/szablony/{id}          usunięcie szablonu

SKU idzie w parametrze / treści, nie w ścieżce: trasa /products/{sku:path}/… łapie wszystko
po ukośniku, a tu nie potrzebujemy żadnej magii z kolejnością routerów.

Rachunek ceny: services/wycena.py (czysty, z testami). Serwer przy zapisie ceny minimalnej
sam bierze koszt FIFO / średni i sam liczy cenę — do bazy nie wchodzi liczba z przeglądarki.
"""

import json
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

import audit
from audit_opisy import etykieta_kontenera, f_zl
from config import INCLUDED_STATUS_FILTER, SALES_CHANNEL_CASE, settings
from database import get_db
from models import (
    KosztBazyOut, CenaMinimalnaIn, CenaMinimalnaKrotkoOut, CenaMinimalnaOut, CenyProduktuOut, CurrentUser,
    KonkurencjaHistoriaOut, KonkurencjaIn, KonkurencjaOut, KosztZespolOut, SprzedazKanaluOut,
    SprzedazPonizejOut, WycenaKoszt, WycenaOut, WycenaSzablonIn, WycenaSzablonOut,
)
from routers.cena import _policz, _zapisane
from security import (
    allowed_shops, can_edit_product_price, can_use_sales_calculator, can_view_purchase_price,
    has_perm, require_price_summary_view, require_product_price_edit, require_product_price_view,
    require_super_admin_403, resolve_shop,
)
from services.cena import vat_produktu
from services.products import get_product
from services.cena import Wynik as WynikKosztow
from services.wycena import KANAL_NAZWA, KANALY_BRUTTO, BladWyceny, Koszt, baza_do_wyceny, wylicz_wycene

# Na czas testów obie zakładki i wszystkie ich endpointy widzi WYŁĄCZNIE superadmin (decyzja
# właściciela). Uprawnienia niżej (viewPriceSummary, useSalesCalculator, Cena) zostają —
# po testach wystarczy zdjąć tę jedną zależność, żeby zadziałały dla zespołu.
router = APIRouter(prefix="/api", tags=["wycena"], dependencies=[Depends(require_super_admin_403)])

T_MIN = "app_cena_minimalna"
T_KONK = "app_konkurencja_ceny"
T_SZABLONY = "app_wycena_szablony"

OKRES_DNI = 30            # średnie ceny sprzedaży: ostatnie 30 dni
MAX_WSTECZ_DNI = 365      # porównanie z ceną minimalną: najdalej rok wstecz
PRZYKLADOW = 5            # ile sprzedaży poniżej minimum pokazujemy z nazwy


def _kto(user: CurrentUser) -> str:
    return user.full_name or user.email


def _koszty(raw) -> List[WycenaKoszt]:
    if isinstance(raw, str):
        raw = json.loads(raw or "[]")
    return [WycenaKoszt(**k) for k in (raw or [])]


def _cena_min(r) -> CenaMinimalnaOut:
    return CenaMinimalnaOut(
        id=r["id"], kanal=r["kanal"], cena_netto=float(r["cena_netto"]), cena_brutto=float(r["cena_brutto"]),
        vat=float(r["vat"]), baza=r["baza"], koszt_bazy=float(r["koszt_bazy"]), marza=float(r["marza"]),
        koszty=_koszty(r["koszty"]), szablon=r["szablon"], ustawil=r["ustawil"], ustawiono=r["ustawiono"],
    )


async def _ceny_min(db: AsyncSession, sku: str) -> List[CenaMinimalnaOut]:
    rows = (await db.execute(
        text(f"SELECT * FROM {T_MIN} WHERE sku_canon = LOWER(TRIM(:s)) ORDER BY ustawiono DESC, id DESC LIMIT 100"),
        {"s": sku},
    )).mappings().all()
    return [_cena_min(r) for r in rows]


def _aktualna(ceny: List[CenaMinimalnaOut], kanal: str) -> Optional[CenaMinimalnaOut]:
    return next((c for c in ceny if c.kanal == kanal), None)


async def _konkurencja(db: AsyncSession, sku: str) -> List[KonkurencjaOut]:
    """Aktywne sklepy: najnowszy wpis = aktualna cena, starsze = historia."""
    rows = (await db.execute(
        text(f"""SELECT * FROM {T_KONK} WHERE sku_canon = LOWER(TRIM(:s)) AND usunieto IS NULL
                  ORDER BY sklep_canon, dodano DESC, id DESC"""),
        {"s": sku},
    )).mappings().all()
    po_sklepie: dict = {}
    for r in rows:
        k = po_sklepie.get(r["sklep_canon"])
        if k is None:
            po_sklepie[r["sklep_canon"]] = KonkurencjaOut(
                id=r["id"], sklep=r["sklep"], cena_brutto=float(r["cena_brutto"]), link=r["link"],
                dodal=r["dodal"], dodano=r["dodano"],
            )
        else:
            k.historia.append(KonkurencjaHistoriaOut(cena_brutto=float(r["cena_brutto"]), dodal=r["dodal"], dodano=r["dodano"]))
    return sorted(po_sklepie.values(), key=lambda k: k.cena_brutto)


async def _szablony(db: AsyncSession) -> List[WycenaSzablonOut]:
    rows = (await db.execute(text(f"SELECT * FROM {T_SZABLONY} ORDER BY kolejnosc, id"))).mappings().all()
    return [WycenaSzablonOut(id=r["id"], nazwa=r["nazwa"], cel=r["cel"], marza=float(r["marza"]),
                             koszty=_koszty(r["koszty"]), zmienil=r["zmienil"], zmieniono=r["zmieniono"])
            for r in rows]


# ── Sprzedaż: średnie z 30 dni i porównanie z ceną minimalną ──────────────
def _kanal_sprzedazy(wiersze: list, cena_klucz: str, minimum: Optional[CenaMinimalnaOut],
                     prog: Optional[float]) -> SprzedazKanaluOut:
    """wiersze: dict(data, kanal, szt, netto, brutto) — ceny za sztukę, od najnowszej."""
    od30 = date.today() - timedelta(days=OKRES_DNI)
    ost = [w for w in wiersze if w["data"] and w["data"] >= od30]
    szt = sum(w["szt"] for w in ost)
    out = SprzedazKanaluOut(
        szt=szt,
        srednia_netto=round(sum(w["szt"] * w["netto"] for w in ost) / szt, 2) if szt else None,
        srednia_brutto=round(sum(w["szt"] * w["brutto"] for w in ost) / szt, 2) if szt and all(w["brutto"] for w in ost) else None,
        ostatnia_data=wiersze[0]["data"] if wiersze else None,
    )
    if minimum and prog:
        od = minimum.ustawiono.date() if minimum.ustawiono else od30
        po = [w for w in wiersze if w["data"] and w["data"] >= od]
        ponizej = [w for w in po if w[cena_klucz] < prog - 0.005]
        out.ponizej_od = minimum.ustawiono
        out.ponizej_z = len(po)
        out.ponizej_ile = len(ponizej)
        out.ponizej = [SprzedazPonizejOut(data=w["data"], kanal=w["kanal"], cena=round(w[cena_klucz], 2), szt=w["szt"])
                       for w in ponizej[:PRZYKLADOW]]
    return out


async def _sprzedaz_detal(db: AsyncSession, sku: str, shop: str, od: date) -> list:
    """Sprzedaż detaliczna z Sellasista (tylko PLN, statusy sprzedaży) — cena za sztukę."""
    filtr_sklepu = "AND oi.shop = :shop" if shop else ""
    rows = (await db.execute(
        text(f"""
            SELECT o.{settings.COL_ORDER_DATE}::date AS data, {SALES_CHANNEL_CASE} AS kanal,
                   oi.{settings.COL_ITEM_QTY} AS szt, oi.{settings.COL_ITEM_PRICE_NETTO} AS netto,
                   oi.{settings.COL_ITEM_PRICE} AS brutto
              FROM {settings.TABLE_ORDER_ITEMS} oi
              JOIN {settings.TABLE_ORDERS} o
                ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID} AND o.shop = oi.shop
             WHERE LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) = LOWER(TRIM(:s))
               AND UPPER(TRIM(COALESCE(oi.{settings.COL_ITEM_CURRENCY}, '{settings.FX_BASE_CURRENCY}'))) IN ('{settings.FX_BASE_CURRENCY}', '')
               AND oi.{settings.COL_ITEM_QTY} > 0 AND oi.{settings.COL_ITEM_PRICE} > 0
               AND o.{settings.COL_ORDER_DATE}::date >= :od
               {INCLUDED_STATUS_FILTER}
               {filtr_sklepu}
             ORDER BY o.{settings.COL_ORDER_DATE} DESC
             LIMIT 3000
        """),
        {"s": sku, "od": od, "shop": shop},
    )).mappings().all()
    return [{"data": r["data"], "kanal": r["kanal"], "szt": float(r["szt"]),
             "netto": float(r["netto"] if r["netto"] is not None else 0), "brutto": float(r["brutto"])}
            for r in rows]


async def _sprzedaz_hurt(db: AsyncSession, sku: str, shop: str, od: date) -> list:
    """Hurt z Fakturowni: faktury spoza Sellasista, bez przesunięć do AMH i bez korekt."""
    filtr_sklepu = "AND inv.shop = :shop" if shop else ""
    rows = (await db.execute(
        text(f"""
            SELECT inv.issue_date::date AS data, inv.buyer_name AS kanal, i.quantity AS szt,
                   i.total_net AS netto_suma, i.total_gross AS brutto_suma
              FROM {settings.TABLE_FAKTUROWNIA_INVOICE_ITEMS} i
              JOIN {settings.TABLE_FAKTUROWNIA_INVOICES} inv
                ON inv.firma_id = i.firma_id AND inv.invoice_id = i.invoice_id
             WHERE i.sku_canon = LOWER(TRIM(:s))
               AND inv.skip_reason IS NULL AND NOT COALESCE(inv.is_internal, FALSE)
               AND NOT COALESCE(inv.is_correction, FALSE)
               AND i.quantity > 0 AND i.total_net > 0
               AND UPPER(TRIM(COALESCE(i.currency, '{settings.FX_BASE_CURRENCY}'))) IN ('{settings.FX_BASE_CURRENCY}', '')
               AND inv.issue_date::date >= :od
               {filtr_sklepu}
             ORDER BY inv.issue_date DESC, inv.invoice_id DESC
             LIMIT 3000
        """),
        {"s": sku, "od": od, "shop": shop},
    )).mappings().all()
    out = []
    for r in rows:
        szt = float(r["szt"])
        out.append({"data": r["data"], "kanal": r["kanal"], "szt": szt,
                    "netto": float(r["netto_suma"]) / szt,
                    "brutto": float(r["brutto_suma"]) / szt if r["brutto_suma"] is not None else 0.0})
    return out


def _od_kiedy(minimum: Optional[CenaMinimalnaOut]) -> date:
    """Skąd czytać sprzedaż: 30 dni na średnie, a gdy jest cena minimalna — od jej ustawienia (max rok)."""
    od = date.today() - timedelta(days=OKRES_DNI)
    if minimum and minimum.ustawiono:
        od = min(od, max(minimum.ustawiono.date(), date.today() - timedelta(days=MAX_WSTECZ_DNI)))
    return od


# ── Koszt bazowy: co da się policzyć i od czego liczymy domyślnie ─────────
def _koszty_bazy(w: WynikKosztow, meta: dict) -> "tuple[List[KosztBazyOut], Optional[str]]":
    """Tylko policzalne koszty (FIFO, średnia, najbliższa, ostatnia) z opisem skąd, i domyślna baza
    wg services/wycena.py → baza_do_wyceny. Pusta lista = żadnej dostawy w aplikacji → koszt ręczny."""
    po_id = {d.item_id: d for d in w.dostawy}
    nr = lambda d: etykieta_kontenera(d.container_number, meta[d.item_id]["lot_order_number"] or meta[d.item_id]["order_number"], d.container_id)  # noqa: E731
    dz = lambda d: d.data.strftime("%d.%m.%Y") if d and d.data else None  # noqa: E731
    out: List[KosztBazyOut] = []
    if w.fifo:
        d = po_id.get(w.fifo_item_id)
        out.append(KosztBazyOut(baza="fifo", koszt=w.fifo, opis=(
            f"FIFO · z dostawy {nr(d)}" + (f", na magazynie od {dz(d)}" if dz(d) else "")) if d else "FIFO · z towaru na stanie"))
    if w.srednia:
        out.append(KosztBazyOut(baza="srednia", koszt=w.srednia, opis="średnia ważona z towaru na stanie"))
    if w.najblizsza:
        d = po_id.get(w.najblizsza_item_id)
        szac = bool(d and d.szacunek)
        out.append(KosztBazyOut(baza="najblizsza", koszt=w.najblizsza, szacunek=szac, opis=(
            "najbliższa dostawa" + (f" {nr(d)}" if d else "") + (f" · ok. {dz(d)}" if dz(d) else "")
            + (" · szacunek" if szac else ""))))
    if w.ostatnia:
        d = po_id.get(w.ostatnia_item_id)
        out.append(KosztBazyOut(baza="ostatnia", koszt=w.ostatnia, opis=(
            "ostatnia dostawa" + (f" {nr(d)}" if d else "") + (f" · {dz(d)}" if dz(d) else "")
            + (" · brak na stanie" if not w.fifo else ""))))
    return out, baza_do_wyceny({k.baza: k.koszt for k in out})


# ── GET: „test-cena” ─────────────────────────────────────────────────────
@router.get("/ceny-produktu", response_model=CenyProduktuOut)
async def ceny_produktu(sku: str = Query(..., min_length=1), shop: str = Query(""),
                        db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_price_summary_view)):
    shop = resolve_shop(shop, user)
    koszt = None
    if can_view_purchase_price(user):
        p, _, w, meta, slug, _, _ = await _policz(db, sku, shop, user)
        po_id = {d.item_id: d for d in w.dostawy}
        fifo_d, nb = po_id.get(w.fifo_item_id), po_id.get(w.najblizsza_item_id)
        # Kontener roboczy („Draft-…”) nie ma numeru — pokazujemy wtedy „FV: nr faktury”, jak wszędzie.
        nr = lambda d: etykieta_kontenera(d.container_number, meta[d.item_id]["lot_order_number"] or meta[d.item_id]["order_number"], d.container_id) if d else None  # noqa: E731
        kb, domyslna = _koszty_bazy(w, meta)
        koszt = KosztZespolOut(
            koszty_bazy=kb, baza_domyslna=domyslna,
            fifo=w.fifo, fifo_kontener=nr(fifo_d), fifo_data=fifo_d.data if fifo_d else None,
            srednia=w.srednia, najblizsza=w.najblizsza, najblizsza_kontener=nr(nb),
            najblizsza_data=nb.data if nb else None, najblizsza_szacunek=bool(nb and nb.szacunek),
        )
    else:
        p = await get_product(db, sku, shop, allowed=allowed_shops(user))
        slug = shop
    vat = (await vat_produktu(db, p.sku, shop or slug))["vat"]

    ceny = await _ceny_min(db, p.sku)
    md, mh = _aktualna(ceny, "detal"), _aktualna(ceny, "hurt")
    krotko = lambda c: CenaMinimalnaKrotkoOut(cena_netto=c.cena_netto, cena_brutto=c.cena_brutto,  # noqa: E731
                                              ustawil=c.ustawil, ustawiono=c.ustawiono) if c else None
    # Ceny sugerowane: z kalkulatora wyceny, a dopóki tam ich nie ma — zapisane starą zakładką „Cena”.
    stare = {z.kanal: z for z in await _zapisane(db, p.sku)}
    sd, sh, sa = _aktualna(ceny, "sug_detal"), _aktualna(ceny, "sug_hurt"), _aktualna(ceny, "sug_allegro")
    sug_detal = sd.cena_brutto if sd else (stare["sklepy"].cena_brutto if "sklepy" in stare else None)
    sug_hurt = sh.cena_netto if sh else (stare["dropy"].cena_netto if "dropy" in stare else None)

    detal = await _sprzedaz_detal(db, p.sku, shop, _od_kiedy(md))
    hurt = await _sprzedaz_hurt(db, p.sku, shop, _od_kiedy(mh))
    return CenyProduktuOut(
        sku=p.sku, shop=shop, vat=vat, min_detal=krotko(md), min_hurt=krotko(mh),
        sugerowana_sklepy_brutto=sug_detal, sugerowana_dropy_netto=sug_hurt,
        sugerowana_allegro_brutto=sa.cena_brutto if sa else None,
        okres_dni=OKRES_DNI,
        detal=_kanal_sprzedazy(detal, "brutto", md, md.cena_brutto if md else None),
        hurt=_kanal_sprzedazy(hurt, "netto", mh, mh.cena_netto if mh else None),
        konkurencja=await _konkurencja(db, p.sku),
        koszt=koszt,
        kalkulator=can_use_sales_calculator(user),
        prowizja_tryb="A" if has_perm(user, "prowizjaOdCeny") else "B",
    )


# ── GET: „test-wycena” ───────────────────────────────────────────────────
@router.get("/wycena", response_model=WycenaOut)
async def wycena(sku: str = Query(..., min_length=1), shop: str = Query(""),
                 db: AsyncSession = Depends(get_db),
                 user: CurrentUser = Depends(require_product_price_view)):
    shop = resolve_shop(shop, user)
    p, _, w, meta, slug, _, _ = await _policz(db, sku, shop, user)
    vat = await vat_produktu(db, p.sku, shop or slug)
    kb, domyslna = _koszty_bazy(w, meta)
    return WycenaOut(
        sku=p.sku, shop=shop, vat=vat["vat"], vat_zrodlo=vat["zrodlo"], fifo=w.fifo, srednia=w.srednia,
        koszty_bazy=kb, baza_domyslna=domyslna,
        ceny_min=await _ceny_min(db, p.sku), konkurencja=await _konkurencja(db, p.sku),
        szablony=await _szablony(db), moze_zapisac=can_edit_product_price(user),
    )


# ── Zapis ceny z kalkulatora (minimalna / sugerowana) ───────────────────
@router.put("/wycena/cena", response_model=CenaMinimalnaOut)
async def zapisz_cene(body: CenaMinimalnaIn, db: AsyncSession = Depends(get_db),
                               user: CurrentUser = Depends(require_product_price_edit)):
    shop = resolve_shop(body.shop or "", user)
    p, _, w, _, slug, _, _ = await _policz(db, body.sku, shop, user)
    if body.baza == "wlasna":
        koszt = body.koszt_wlasny
    else:
        koszt = {"fifo": w.fifo, "srednia": w.srednia, "najblizsza": w.najblizsza, "ostatnia": w.ostatnia}[body.baza]
    if not koszt:
        raise HTTPException(422, "Brak kosztu bazowego — wybierz inny albo wpisz własny")
    vat = (await vat_produktu(db, p.sku, shop or slug))["vat"]
    try:
        wy = wylicz_wycene(koszt, body.marza, [Koszt(k.nazwa, k.typ, k.wartosc, k.od) for k in body.koszty], vat)
    except BladWyceny as e:
        raise HTTPException(422, str(e))

    stara = _aktualna(await _ceny_min(db, p.sku), body.kanal)
    row = (await db.execute(
        text(f"""
            INSERT INTO {T_MIN} (sku_canon, sku, kanal, cena_netto, cena_brutto, vat, baza, koszt_bazy,
                                 marza, koszty, szablon, ustawil_id, ustawil, ustawiono)
            VALUES (LOWER(TRIM(:sku)), TRIM(:sku), :kanal, :netto, :brutto, :vat, :baza, :koszt,
                    :marza, CAST(:koszty AS JSONB), :szablon, :uid, :kto, :teraz)
            RETURNING *
        """),
        {"sku": p.sku, "kanal": body.kanal, "netto": wy.netto, "brutto": wy.brutto, "vat": vat,
         "baza": body.baza, "koszt": wy.koszt_bazy, "marza": body.marza,
         "koszty": json.dumps([k.model_dump() for k in body.koszty], ensure_ascii=False),
         "szablon": body.szablon, "uid": user.id, "kto": _kto(user), "teraz": datetime.now(timezone.utc)},
    )).mappings().first()
    await db.commit()
    nowa = _cena_min(row)
    jak = "brutto" if body.kanal in KANALY_BRUTTO else "netto"
    kw = lambda c: c.cena_brutto if jak == "brutto" else c.cena_netto  # noqa: E731
    bylo = f" (było {f_zl(kw(stara))})" if stara else ""
    audit.note(f"zapisał „{KANAL_NAZWA[body.kanal]}” produktu {p.sku}: {f_zl(kw(nowa))} {jak}{bylo}",
               changes=[{"pole": f"{KANAL_NAZWA[body.kanal]} ({jak})", "bylo": f_zl(kw(stara)) if stara else "—",
                         "jest": f_zl(kw(nowa))}],
               area="Ceny", resource_type="product", resource_id=p.sku)
    return nowa


# ── Konkurencja ──────────────────────────────────────────────────────────
@router.post("/wycena/konkurencja", response_model=List[KonkurencjaOut])
async def dodaj_konkurencje(body: KonkurencjaIn, db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(require_product_price_edit)):
    """Nowa cena sklepu. Ten sam sklep (bez względu na wielkość liter) = nowa cena, stara do historii."""
    shop = resolve_shop(body.shop or "", user)
    p = await get_product(db, body.sku, shop, allowed=allowed_shops(user))
    przed = {k.sklep.lower(): k for k in await _konkurencja(db, p.sku)}
    await db.execute(
        text(f"""INSERT INTO {T_KONK} (sku_canon, sku, sklep, sklep_canon, cena_brutto, link, dodal_id, dodal, dodano)
                 VALUES (LOWER(TRIM(:sku)), TRIM(:sku), :sklep, LOWER(:sklep), :cena, :link, :uid, :kto, :teraz)"""),
        {"sku": p.sku, "sklep": body.sklep, "cena": body.cena_brutto,
         # Bez nowego linku zostaje ten, który już był przy tym sklepie.
         "link": body.link or (przed[body.sklep.lower()].link if body.sklep.lower() in przed else None),
         "uid": user.id, "kto": _kto(user), "teraz": datetime.now(timezone.utc)},
    )
    await db.commit()
    stary = przed.get(body.sklep.lower())
    bylo = f" (było {f_zl(stary.cena_brutto)})" if stary else ""
    audit.note(f"wpisał cenę konkurencji „{body.sklep}” dla produktu {p.sku}: {f_zl(body.cena_brutto)} brutto{bylo}",
               area="Ceny", resource_type="product", resource_id=p.sku)
    return await _konkurencja(db, p.sku)


@router.delete("/wycena/konkurencja/{wpis_id}", response_model=List[KonkurencjaOut])
async def usun_konkurencje(wpis_id: int, shop: str = Query(""), db: AsyncSession = Depends(get_db),
                           user: CurrentUser = Depends(require_product_price_edit)):
    """Usuwa sklep z listy produktu (wszystkie jego wpisy dostają datę usunięcia, nic nie kasujemy)."""
    r = (await db.execute(text(f"SELECT * FROM {T_KONK} WHERE id = :id AND usunieto IS NULL"),
                          {"id": wpis_id})).mappings().first()
    if not r:
        raise HTTPException(404, "Nie ma takiego wpisu")
    p = await get_product(db, r["sku"], resolve_shop(shop, user), allowed=allowed_shops(user))
    await db.execute(
        text(f"""UPDATE {T_KONK} SET usunieto = :teraz, usunal = :kto
                  WHERE sku_canon = :sku AND sklep_canon = :sklep AND usunieto IS NULL"""),
        {"teraz": datetime.now(timezone.utc), "kto": _kto(user), "sku": r["sku_canon"], "sklep": r["sklep_canon"]},
    )
    await db.commit()
    audit.note(f"usunął sklep „{r['sklep']}” z cen konkurencji produktu {p.sku}",
               area="Ceny", resource_type="product", resource_id=p.sku)
    return await _konkurencja(db, p.sku)


# ── Szablony kalkulatora ─────────────────────────────────────────────────
def _parametry_szablonu(body: WycenaSzablonIn, user: CurrentUser) -> dict:
    return {"n": body.nazwa.strip(), "c": body.cel, "m": body.marza,
            "k": json.dumps([k.model_dump() for k in body.koszty], ensure_ascii=False),
            "kto": _kto(user), "teraz": datetime.now(timezone.utc)}


@router.post("/wycena/szablony", response_model=List[WycenaSzablonOut])
async def dodaj_szablon(body: WycenaSzablonIn, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_product_price_edit)):
    await db.execute(
        text(f"""INSERT INTO {T_SZABLONY} (nazwa, cel, marza, koszty, kolejnosc, zmienil, zmieniono)
                 VALUES (:n, :c, :m, CAST(:k AS JSONB),
                         (SELECT COALESCE(MAX(kolejnosc), 0) + 1 FROM {T_SZABLONY}), :kto, :teraz)"""),
        _parametry_szablonu(body, user),
    )
    await db.commit()
    audit.note(f"dodał szablon kalkulatora wyceny „{body.nazwa.strip()}”", area="Ceny", resource_type="wycena")
    return await _szablony(db)


@router.put("/wycena/szablony/{sid}", response_model=List[WycenaSzablonOut])
async def zmien_szablon(sid: int, body: WycenaSzablonIn, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_product_price_edit)):
    res = await db.execute(
        text(f"""UPDATE {T_SZABLONY} SET nazwa = :n, cel = :c, marza = :m, koszty = CAST(:k AS JSONB),
                        zmienil = :kto, zmieniono = :teraz WHERE id = :id"""),
        {**_parametry_szablonu(body, user), "id": sid},
    )
    if not res.rowcount:
        raise HTTPException(404, "Nie ma takiego szablonu")
    await db.commit()
    audit.note(f"zmienił szablon kalkulatora wyceny „{body.nazwa.strip()}”", area="Ceny",
               resource_type="wycena", resource_id=sid)
    return await _szablony(db)


@router.delete("/wycena/szablony/{sid}", response_model=List[WycenaSzablonOut])
async def usun_szablon(sid: int, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(require_product_price_edit)):
    nazwa = (await db.execute(text(f"DELETE FROM {T_SZABLONY} WHERE id = :id RETURNING nazwa"),
                              {"id": sid})).scalar_one_or_none()
    if nazwa is None:
        raise HTTPException(404, "Nie ma takiego szablonu")
    await db.commit()
    audit.note(f"usunął szablon kalkulatora wyceny „{nazwa}”", area="Ceny", resource_type="wycena", resource_id=sid)
    return await _szablony(db)
