"""Zakładka „Cena" na karcie produktu: koszt zakupu z kontenerów i kalkulator ceny.

Moduł jest CZYSTY (bez bazy), żeby dało się go przetestować na zmyślonych dostawach.
Router (routers/cena.py) zbiera dane z bazy i woła tylko dwie funkcje stąd:
`policz_koszty` i `wylicz_cene`.

SKĄD BIERZE SIĘ KOSZT SZTUKI W DOSTAWIE
  · kontener rozliczony odprawą → app_container_items.koszt_jednostkowy (landed cost),
  · kontener bez odprawy        → SZACUNEK: cena z FV × (1 + średni narzut importu).
    Narzut bierzemy z rozliczonych dostaw TEGO SKU; gdy żadnej nie ma — średni narzut
    wszystkich rozliczonych pozycji (podaje go router). Szacunek zawsze niesie flagę,
    żeby front mógł go podpisać „SZAC.", a nie udawać policzonego kosztu.

DOSTAWA KRAJOWA (towar kupiony w Polsce, kontener/lot w PLN)
Nie ma odprawy ani narzutu importu, więc nie szacujemy: koszt = cena z FV + transport do
magazynu rozłożony na sztuki. Taki koszt jest pewny — wchodzi do średniej, ostatniej,
min i max tak samo jak koszt z odprawy, ale NIE do średniego narzutu importu.

KTÓRE SZTUKI SĄ JESZCZE NA STANIE
W systemie nie ma powiązania PZ ↔ kontener, więc stan rozkładamy WSTECZ: zaczynamy od
najnowszej dostawy, która już jest u nas (dostarczona albo wbita do magazynu „w drodze"),
i bierzemy z niej tyle sztuk, ile ma, potem z kolejnej starszej — aż wyczerpie się stan.
To jest dokładnie założenie FIFO: najstarsze sztuki zeszły pierwsze, więc zostały najnowsze.
Kontenery, które jeszcze płyną i nie są wbite, nie biorą udziału w rozkładzie.
Gdy stanu jest więcej niż sztuk w znanych dostawach, nadwyżka to towar sprzed aplikacji
(`poza_dostawami`) — liczymy ją osobno i nie zgadujemy jej kosztu.

FIFO = koszt najstarszej partii, z której jeszcze coś zostało (z niej zejdzie następna sprzedaż).
Średnia ważona = koszt partii na stanie ważony liczbą pozostałych sztuk (tak liczy Subiekt).
Do średniej, ostatniej, najniższej i najwyższej wchodzą TYLKO dostawy rozliczone odprawą
albo krajowe (koszt z faktury, bez szacunku).
Kontener „bez SAD” ma koszt szacowany — pokazujemy go w tabeli informacyjnie, ale nie miesza
w tych kaflach (jego sztuki na stanie liczymy osobno: `srednia_pominieto_szt`).
Średnia bierze wyłącznie partie, z których coś jeszcze jest na stanie — wyprzedane nie.

KONTENER DO SPRAWDZENIA
Narzut importu (koszt ÷ cena z FV − 1) bywa różny między dostawami, ale w wąskim paśmie.
Dostawa, której narzut odbiega od mediany pozostałych rozliczonych dostaw tego SKU o więcej
niż PROG_ODSTAJE_PP punktów procentowych, dostaje flagę `odstaje`. Potrzebne są co najmniej
3 rozliczone dostawy — przy dwóch nie wiadomo, która jest zła. Odstająca dostawa nie wchodzi
do średniego narzutu używanego do szacunków (żeby jeden błąd nie psuł reszty).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from statistics import median
from typing import Dict, List, Optional

# Ile punktów procentowych narzutu od mediany uznajemy za podejrzane.
PROG_ODSTAJE_PP = 10.0
# Minimalna liczba rozliczonych dostaw, żeby w ogóle szukać odstających.
MIN_DO_ODSTAJACYCH = 3

BAZY = ("fifo", "srednia", "ostatnia", "reczna")
TRYBY = ("marza", "narzut")
KANALY = ("sklepy", "dropy")
VAT_DOMYSLNY = 23.0


@dataclass
class Dostawa:
    """Jedna pozycja kontenera z tym SKU (wejście z bazy)."""
    item_id: int
    container_id: int
    container_number: str
    data: Optional[date]               # wejście na magazyn: dostarczono → umówiono → ETA + odprawa
    data_zrodlo: str                    # 'delivered' | 'expected' | 'estimate'
    szt: int
    u_nas: bool                         # dostarczona albo wbita do „w drodze" — bierze udział w rozkładzie stanu
    cena_fv_pln: Optional[float]        # cena z faktury dostawcy / szt w PLN
    cena_fv_waluta: Optional[float] = None
    waluta: Optional[str] = None
    koszt_jednostkowy: Optional[float] = None   # landed cost z odprawy (None = brak odprawy)
    krajowa: bool = False               # zakup w Polsce (PLN) — bez odprawy i bez narzutu importu
    transport_szt: float = 0.0          # transport do magazynu / szt (dostawa krajowa)
    # wypełniane przez policz_koszty:
    koszt: Optional[float] = None
    szacunek: bool = False
    narzut_proc: Optional[float] = None
    na_stanie: int = 0
    odstaje: bool = False
    fifo: bool = False

    @property
    def rozliczona(self) -> bool:
        return self.koszt_jednostkowy is not None and self.koszt_jednostkowy > 0

    @property
    def pewna(self) -> bool:
        """Koszt policzony, nie szacowany: z odprawy albo z faktury krajowej."""
        return self.rozliczona or (self.krajowa and bool(self.cena_fv_pln) and self.cena_fv_pln > 0)


@dataclass
class Wynik:
    dostawy: List[Dostawa]
    stan: int
    poza_dostawami: int = 0             # sztuki stanu, których nie pokryła żadna znana dostawa
    sredni_narzut_proc: Optional[float] = None
    narzut_zrodlo: Optional[str] = None # 'sku' | 'wszystkie' | None
    fifo: Optional[float] = None
    fifo_item_id: Optional[int] = None
    srednia: Optional[float] = None
    srednia_szt: int = 0                # z ilu sztuk liczona średnia
    srednia_pominieto_szt: int = 0      # sztuki na stanie z partii bez SAD — poza średnią
    ostatnia: Optional[float] = None
    ostatnia_item_id: Optional[int] = None
    min: Optional[float] = None
    min_item_id: Optional[int] = None
    max: Optional[float] = None
    max_item_id: Optional[int] = None
    uwagi: List[str] = field(default_factory=list)


def _klucz_daty(d: Dostawa):
    # Brak daty traktujemy jak „najstarsze" — nie wiemy, kiedy weszło.
    return (d.data or date.min, d.container_id, d.item_id)


def _narzut(koszt: Optional[float], fv: Optional[float]) -> Optional[float]:
    if not koszt or not fv or fv <= 0:
        return None
    return round((koszt / fv - 1) * 100, 2)


def policz_koszty(dostawy: List[Dostawa], stan: int,
                  narzut_globalny_proc: Optional[float] = None) -> Wynik:
    """Koszt każdej dostawy, rozkład stanu i wskaźniki do kafli zakładki „Cena".

    `stan` = sztuki u nas (magazyn główny + wbite do „w drodze") w wybranej firmie.
    `narzut_globalny_proc` = średni narzut wszystkich rozliczonych pozycji (zapas, gdy
    ten SKU nie ma żadnej rozliczonej dostawy).
    """
    stan = max(0, int(stan or 0))
    ds = sorted(dostawy, key=_klucz_daty, reverse=True)   # od najnowszej
    w = Wynik(dostawy=ds, stan=stan)

    # 1) Narzut rozliczonych dostaw i odstające
    rozl = [d for d in ds if d.rozliczona]
    for d in rozl:
        d.narzut_proc = _narzut(d.koszt_jednostkowy, d.cena_fv_pln)
    z_narzutem = [d for d in rozl if d.narzut_proc is not None]
    if len(z_narzutem) >= MIN_DO_ODSTAJACYCH:
        for d in z_narzutem:
            inne = [x.narzut_proc for x in z_narzutem if x is not d]
            if abs(d.narzut_proc - median(inne)) > PROG_ODSTAJE_PP:
                d.odstaje = True

    # 2) Średni narzut do szacunków (ważony wartością FV, bez odstających)
    baza = [d for d in z_narzutem if not d.odstaje]
    if baza:
        fv = sum(d.cena_fv_pln * d.szt for d in baza)
        kos = sum(d.koszt_jednostkowy * d.szt for d in baza)
        if fv > 0:
            w.sredni_narzut_proc = round((kos / fv - 1) * 100, 2)
            w.narzut_zrodlo = "sku"
    if w.sredni_narzut_proc is None and narzut_globalny_proc is not None:
        w.sredni_narzut_proc = round(narzut_globalny_proc, 2)
        w.narzut_zrodlo = "wszystkie"

    # 3) Koszt każdej dostawy (rozliczony albo szacunek)
    for d in ds:
        if d.rozliczona:
            d.koszt = round(d.koszt_jednostkowy, 2)
        elif d.krajowa and d.cena_fv_pln and d.cena_fv_pln > 0:
            d.koszt = round(d.cena_fv_pln + (d.transport_szt or 0.0), 2)
            d.narzut_proc = _narzut(d.koszt, d.cena_fv_pln)
        elif d.cena_fv_pln and d.cena_fv_pln > 0:
            mnoznik = 1 + (w.sredni_narzut_proc or 0) / 100
            d.koszt = round(d.cena_fv_pln * mnoznik, 2)
            d.szacunek = True
            d.narzut_proc = w.sredni_narzut_proc
        else:
            d.koszt = None   # ani odprawy, ani ceny z FV — nie ma z czego liczyć

    # 4) Rozkład stanu wstecz od najnowszej dostawy, która jest u nas
    zostalo = stan
    for d in ds:
        if not d.u_nas or zostalo <= 0:
            continue
        d.na_stanie = min(d.szt, zostalo)
        zostalo -= d.na_stanie
    w.poza_dostawami = zostalo
    if zostalo > 0:
        w.uwagi.append(f"{zostalo} szt na stanie nie pochodzi z żadnego kontenera w aplikacji")

    # 5) FIFO i średnia z partii na stanie
    na_stanie = [d for d in ds if d.na_stanie > 0 and d.koszt is not None]
    if na_stanie:
        najstarsza = na_stanie[-1]           # ds jest od najnowszej, więc ostatnia = najstarsza
        najstarsza.fifo = True
        w.fifo, w.fifo_item_id = najstarsza.koszt, najstarsza.item_id
        # Średnia tylko z partii o pewnym koszcie (odprawa albo zakup krajowy) — szacunek
        # „bez SAD” jest informacyjny.
        rozl_na_stanie = [d for d in na_stanie if d.pewna]
        szt = sum(d.na_stanie for d in rozl_na_stanie)
        if szt:
            w.srednia = round(sum(d.koszt * d.na_stanie for d in rozl_na_stanie) / szt, 2)
        w.srednia_szt = szt
        w.srednia_pominieto_szt = sum(d.na_stanie for d in na_stanie if not d.pewna)
    bez_kosztu = [d for d in ds if d.na_stanie > 0 and d.koszt is None]
    if bez_kosztu:
        w.uwagi.append("Część stanu pochodzi z dostaw bez ceny z faktury — pominięta w FIFO i średniej")

    # 6) Ostatnia dostawa (najnowsza rozliczona, która jest u nas) oraz min / max z rozliczonych.
    #    Kontener bez SAD pomijamy — jego koszt to tylko szacunek.
    ostatnia = next((d for d in ds if d.u_nas and d.pewna), None)
    if ostatnia:
        w.ostatnia, w.ostatnia_item_id = ostatnia.koszt, ostatnia.item_id
    pewne = [d for d in ds if d.pewna]
    if pewne:
        lo = min(pewne, key=lambda d: d.koszt)
        hi = max(pewne, key=lambda d: d.koszt)
        w.min, w.min_item_id = lo.koszt, lo.item_id
        w.max, w.max_item_id = hi.koszt, hi.item_id
    return w


@dataclass
class Cena:
    koszt_bazy: float
    koszt_calkowity: float     # baza + wysyłka
    prowizja_zl: float
    netto: float
    brutto: float
    zysk: float
    marza_proc: float
    narzut_proc: float


class BladCeny(ValueError):
    pass


def wylicz_cene(koszt_bazy: float, tryb: str, proc: float, wysylka: float = 0.0,
                prowizja_proc: float = 0.0, vat_proc: float = VAT_DOMYSLNY) -> Cena:
    """Sugerowana cena sprzedaży. TA SAMA formuła jest na froncie (zakładka „Cena").

    tryb 'marza'  — procent liczony od ceny netto:  netto = koszt ÷ (1 − marża − prowizja)
    tryb 'narzut' — procent liczony od kosztu:      netto = koszt × (1 + narzut) ÷ (1 − prowizja)
    Prowizja kanału (np. Allegro) liczona od ceny netto, więc siedzi w mianowniku.
    Koszt = koszt bazowy + wysyłka po Polsce.
    """
    if tryb not in TRYBY:
        raise BladCeny("Nieznany sposób liczenia (marza / narzut)")
    for nazwa, v in (("koszt bazowy", koszt_bazy), ("procent", proc), ("wysyłka", wysylka),
                     ("prowizja", prowizja_proc), ("VAT", vat_proc)):
        if v is None or v < 0:
            raise BladCeny(f"{nazwa.capitalize()} nie może być ujemny")
    if koszt_bazy <= 0:
        raise BladCeny("Koszt bazowy musi być większy od zera")
    p, c = proc / 100, prowizja_proc / 100
    koszt = koszt_bazy + wysylka
    if tryb == "marza":
        mian = 1 - p - c
        if mian <= 0:
            raise BladCeny("Marża i prowizja razem muszą być mniejsze niż 100%")
        netto = koszt / mian
    else:
        if 1 - c <= 0:
            raise BladCeny("Prowizja musi być mniejsza niż 100%")
        netto = koszt * (1 + p) / (1 - c)
    netto = round(netto, 2)
    prow_zl = round(netto * c, 2)
    zysk = round(netto - koszt - prow_zl, 2)
    return Cena(
        koszt_bazy=round(koszt_bazy, 2), koszt_calkowity=round(koszt, 2), prowizja_zl=prow_zl,
        netto=netto, brutto=round(netto * (1 + vat_proc / 100), 2), zysk=zysk,
        marza_proc=round(zysk / netto * 100, 2) if netto else 0.0,
        narzut_proc=round(zysk / koszt * 100, 2) if koszt else 0.0,
    )


# ── Stawka VAT produktu ──────────────────────────────────────
# Ręczna stawka z zakładki Dane (app_product_attrs.vat_manual) WYGRYWA. Bez niej bierzemy
# stawkę z najświeższej KRAJOWEJ sprzedaży tego SKU w Sellasiście — najpierw w wybranej
# firmie, potem w dowolnej (Acti ma głównie 8%). Stawki zagraniczne (np. 21%) pomijamy,
# tak jak przy katalogu dropów: jedna sprzedaż za granicę nie może zmienić VAT produktu.
VAT_KRAJOWE = (23, 8, 5)
VAT_RECZNE = (23, 8, 5, 0)


async def vat_produktu(db, sku: str, shop: str = "") -> dict:
    from sqlalchemy import text
    from config import settings

    manual = (await db.execute(
        text(f"""SELECT vat_manual FROM {settings.TABLE_PRODUCT_ATTRS}
                  WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:s)) AND vat_manual IS NOT NULL
                  ORDER BY updated_at DESC NULLS LAST LIMIT 1"""),
        {"s": sku},
    )).scalar_one_or_none()
    auto = (await db.execute(
        text(f"""SELECT tax_rate FROM {settings.TABLE_ORDER_ITEMS}
                  WHERE LOWER(TRIM(symbol)) = LOWER(TRIM(:s)) AND tax_rate IN ({", ".join(map(str, VAT_KRAJOWE))})
                  ORDER BY (shop = :shop) DESC, order_date DESC NULLS LAST LIMIT 1"""),
        {"s": sku, "shop": (shop or "").strip().lower()},
    )).scalar_one_or_none()
    vat_manual = float(manual) if manual is not None else None
    vat_auto = float(auto) if auto is not None else None
    if vat_manual is not None:
        vat, zrodlo = vat_manual, "reczna"
    elif vat_auto is not None:
        vat, zrodlo = vat_auto, "sprzedaz"
    else:
        vat, zrodlo = VAT_DOMYSLNY, "domyslna"
    return {"vat": vat, "zrodlo": zrodlo, "vat_auto": vat_auto, "vat_manual": vat_manual}


async def vat_produktow(db, shop: str = "") -> Dict[str, float]:
    """VAT wszystkich SKU naraz (lista produktów). Te same zasady co vat_produktu:
    ręczna stawka wygrywa, potem najświeższa krajowa sprzedaż (najpierw w tej firmie).
    Klucz: LOWER(TRIM(sku)). SKU bez żadnej stawki nie ma w słowniku — wołający
    bierze wtedy VAT_DOMYSLNY.
    """
    from sqlalchemy import text
    from config import settings

    auto = (await db.execute(
        text(f"""SELECT DISTINCT ON (LOWER(TRIM(symbol))) LOWER(TRIM(symbol)) AS k, tax_rate
                   FROM {settings.TABLE_ORDER_ITEMS}
                  WHERE tax_rate IN ({", ".join(map(str, VAT_KRAJOWE))}) AND symbol IS NOT NULL
                  ORDER BY LOWER(TRIM(symbol)), (shop = :shop) DESC, order_date DESC NULLS LAST"""),
        {"shop": (shop or "").strip().lower()},
    )).all()
    manual = (await db.execute(
        text(f"""SELECT DISTINCT ON (LOWER(TRIM(sku))) LOWER(TRIM(sku)) AS k, vat_manual
                   FROM {settings.TABLE_PRODUCT_ATTRS}
                  WHERE vat_manual IS NOT NULL
                  ORDER BY LOWER(TRIM(sku)), updated_at DESC NULLS LAST"""),
    )).all()
    out = {k: float(v) for k, v in auto}
    out.update({k: float(v) for k, v in manual})   # ręczna nadpisuje
    return out
