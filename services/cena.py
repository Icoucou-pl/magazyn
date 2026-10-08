"""Zakładka „Cena" na karcie produktu: koszt zakupu z kontenerów i kalkulator ceny.

Moduł jest CZYSTY (bez bazy), żeby dało się go przetestować na zmyślonych dostawach.
Router (routers/cena.py) zbiera dane z bazy i woła tylko dwie funkcje stąd:
`policz_koszty` i `wylicz_cene`.

SKĄD BIERZE SIĘ KOSZT SZTUKI W DOSTAWIE
  · koszt jednostkowy „metodą szefa” (services/koszt_kontenera.py) — liczony na bieżąco
    z karty kontenera i płatności dla KAŻDEGO kontenera, także przed przypłynięciem.
    Gdy nie wszystko jest zapłacone (albo wartość wzięta z cen planowanych), koszt niesie
    flagę `koszt_szacunek` — front podpisuje go „SZAC.”, a kafle go pomijają.
  · pozycja bez kosztu (brak ceny i płatności) → SZACUNEK: cena z FV × (1 + średni narzut
    importu). Narzut bierzemy z policzonych dostaw TEGO SKU; gdy żadnej nie ma — średni
    narzut wszystkich policzonych pozycji (podaje go router).
Koszt z SAD-u nie jest tu używany — zostaje tylko jako kontrola w zakładce „SAD”.

DOSTAWA KRAJOWA (towar kupiony w Polsce, kontener/lot w PLN)
Nie ma odprawy ani narzutu importu: koszt = cena z FV + transport do magazynu rozłożony
na sztuki (liczy to ta sama metoda). Taki koszt jest pewny — wchodzi do średniej, ostatniej,
min i max, ale NIE do średniego narzutu importu.

KTÓRE SZTUKI SĄ JESZCZE NA STANIE
W systemie nie ma powiązania PZ ↔ kontener, więc stan rozkładamy WSTECZ: zaczynamy od
najnowszej dostawy, która już jest u nas (dostarczona albo wbita do magazynu „w drodze"),
i bierzemy z niej tyle sztuk, ile ma, potem z kolejnej starszej — aż wyczerpie się stan.
To jest dokładnie założenie FIFO: najstarsze sztuki zeszły pierwsze, więc zostały najnowsze.
Kontenery, które jeszcze płyną i nie są wbite, nie biorą udziału w rozkładzie.
Kontener wbity do „w drodze”, ale z datą wejścia na magazyn w PRZYSZŁOŚCI (np. towar jeszcze
w produkcji, a już wpisany do ERP) bierze ze stanu swoje sztuki — to one leżą w „w drodze” —
ale nie wchodzi do FIFO, średniej, ostatniej, najniższej ani najwyższej: tych sztuk jeszcze
nie sprzedajemy (`przyszla`, sztuki w `przyszle_szt`).
NAJBLIŻSZA DOSTAWA = koszt z kontenera, który wejdzie na magazyn najwcześniej z tych, które
jeszcze nie weszły — podpowiedź do ceny przedsprzedaży, gdy na stanie nic nie ma. Osobny kafel,
nie miesza się z FIFO ani średnią (te są tylko z towaru na stanie).
Gdy stanu jest więcej niż sztuk w znanych dostawach, nadwyżka to towar sprzed aplikacji
(`poza_dostawami`) — liczymy ją osobno i nie zgadujemy jej kosztu.

FIFO = koszt najstarszej partii, z której jeszcze coś zostało (z niej zejdzie następna sprzedaż).
Średnia ważona = koszt partii na stanie ważony liczbą pozostałych sztuk (tak liczy Subiekt).
Do średniej, ostatniej, najniższej i najwyższej wchodzą TYLKO dostawy o pewnym koszcie
(policzone z zapłaconych płatności albo krajowe).
Kontener z szacunkiem pokazujemy w tabeli informacyjnie, ale nie miesza w tych kaflach
(jego sztuki na stanie liczymy osobno: `srednia_pominieto_szt`).
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
    koszt_jednostkowy: Optional[float] = None   # koszt z metody szefa (None = nie ma z czego liczyć)
    koszt_szacunek: bool = False        # metoda szefa: nie wszystko zapłacone / wartość z cen planowanych
    krajowa: bool = False               # zakup w Polsce (PLN) — bez odprawy i bez narzutu importu
    transport_szt: float = 0.0          # transport do magazynu / szt (dostawa krajowa)
    # wypełniane przez policz_koszty:
    koszt: Optional[float] = None
    szacunek: bool = False
    narzut_proc: Optional[float] = None
    na_stanie: int = 0
    odstaje: bool = False
    fifo: bool = False
    przyszla: bool = False              # wbita, ale wejście na magazyn dopiero w przyszłości

    @property
    def policzona(self) -> bool:
        """Ma koszt z metody szefa (pewny albo szacunek)."""
        return self.koszt_jednostkowy is not None and self.koszt_jednostkowy > 0

    @property
    def rozliczona(self) -> bool:
        """Pewny koszt importu — z niego liczymy narzut i odstające dostawy."""
        return self.policzona and not self.koszt_szacunek and not self.krajowa

    @property
    def pewna(self) -> bool:
        """Koszt policzony, nie szacowany: import z zapłaconych płatności albo zakup krajowy."""
        if self.policzona:
            return not self.koszt_szacunek
        return self.krajowa and bool(self.cena_fv_pln) and self.cena_fv_pln > 0


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
    przyszle_szt: int = 0               # sztuki stanu w dostawach z przyszłą datą wejścia — poza kaflami
    ostatnia: Optional[float] = None
    ostatnia_item_id: Optional[int] = None
    min: Optional[float] = None
    min_item_id: Optional[int] = None
    max: Optional[float] = None
    max_item_id: Optional[int] = None
    najblizsza: Optional[float] = None  # koszt z najbliższej dostawy, która jeszcze nie weszła
    najblizsza_item_id: Optional[int] = None
    uwagi: List[str] = field(default_factory=list)


def _klucz_daty(d: Dostawa):
    # Brak daty traktujemy jak „najstarsze" — nie wiemy, kiedy weszło.
    return (d.data or date.min, d.container_id, d.item_id)


def _narzut(koszt: Optional[float], fv: Optional[float]) -> Optional[float]:
    if not koszt or not fv or fv <= 0:
        return None
    return round((koszt / fv - 1) * 100, 2)


def policz_koszty(dostawy: List[Dostawa], stan: int,
                  narzut_globalny_proc: Optional[float] = None, dzis: Optional[date] = None) -> Wynik:
    """Koszt każdej dostawy, rozkład stanu i wskaźniki do kafli zakładki „Cena".

    `stan` = sztuki u nas (magazyn główny + wbite do „w drodze") w wybranej firmie.
    `narzut_globalny_proc` = średni narzut wszystkich rozliczonych pozycji (zapas, gdy
    ten SKU nie ma żadnej rozliczonej dostawy).
    """
    stan = max(0, int(stan or 0))
    dzis = dzis or date.today()
    ds = sorted(dostawy, key=_klucz_daty, reverse=True)   # od najnowszej
    # Wejście na magazyn dopiero w przyszłości (niedostarczona, data > dziś) — tej dostawy jeszcze
    # nie sprzedajemy, więc nie wchodzi do żadnego kafla. Wbita bierze jednak swoje sztuki ze stanu.
    jeszcze_nie = {d.item_id for d in ds if d.data_zrodlo != "delivered" and d.data is not None and d.data > dzis}
    for d in ds:
        d.przyszla = d.u_nas and d.item_id in jeszcze_nie
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

    # 3) Koszt każdej dostawy (z metody szefa albo szacunek z narzutu)
    for d in ds:
        if d.policzona:
            d.koszt = round(d.koszt_jednostkowy, 2)
            d.szacunek = d.koszt_szacunek
            if not d.rozliczona:
                d.narzut_proc = _narzut(d.koszt, d.cena_fv_pln)
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
    w.przyszle_szt = sum(d.na_stanie for d in ds if d.przyszla)
    if zostalo > 0:
        w.uwagi.append(f"{zostalo} szt na stanie nie pochodzi z żadnego kontenera w aplikacji")

    # 5) FIFO i średnia z partii na stanie
    na_stanie = [d for d in ds if d.na_stanie > 0 and d.koszt is not None and not d.przyszla]
    if na_stanie:
        najstarsza = na_stanie[-1]           # ds jest od najnowszej, więc ostatnia = najstarsza
        najstarsza.fifo = True
        w.fifo, w.fifo_item_id = najstarsza.koszt, najstarsza.item_id
        # Średnia tylko z partii o pewnym koszcie — szacunek jest informacyjny.
        rozl_na_stanie = [d for d in na_stanie if d.pewna]
        szt = sum(d.na_stanie for d in rozl_na_stanie)
        if szt:
            w.srednia = round(sum(d.koszt * d.na_stanie for d in rozl_na_stanie) / szt, 2)
        w.srednia_szt = szt
        w.srednia_pominieto_szt = sum(d.na_stanie for d in na_stanie if not d.pewna)
    bez_kosztu = [d for d in ds if d.na_stanie > 0 and d.koszt is None and not d.przyszla]
    if bez_kosztu:
        w.uwagi.append("Część stanu pochodzi z dostaw bez ceny z faktury — pominięta w FIFO i średniej")

    # 6) Ostatnia dostawa (najnowsza pewna, która jest u nas) oraz min / max z pewnych.
    #    Szacunek pomijamy.
    #    Dostawy z przyszłą datą wejścia (i niewbite, które jeszcze płyną) też — nie sprzedajemy ich.
    ostatnia = next((d for d in ds if d.u_nas and d.pewna and not d.przyszla), None)
    if ostatnia:
        w.ostatnia, w.ostatnia_item_id = ostatnia.koszt, ostatnia.item_id
    pewne = [d for d in ds if d.pewna and d.item_id not in jeszcze_nie]
    if pewne:
        lo = min(pewne, key=lambda d: d.koszt)
        hi = max(pewne, key=lambda d: d.koszt)
        w.min, w.min_item_id = lo.koszt, lo.item_id
        w.max, w.max_item_id = hi.koszt, hi.item_id

    # 7) Najbliższa dostawa: jeszcze nie na magazynie (płynie albo wbita z przyszłą datą), z kosztem —
    #    także szacunkowym (dostawa w drodze rzadko ma wszystko zapłacone). Najwcześniejsza data wejścia.
    w_drodze = [d for d in ds if d.koszt is not None and d.data_zrodlo != "delivered"
                and (not d.u_nas or d.przyszla)]
    if w_drodze:
        nb = min(w_drodze, key=lambda d: (d.data or date.max, d.container_id, d.item_id))
        w.najblizsza, w.najblizsza_item_id = nb.koszt, nb.item_id
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
# Liczą się tylko zamówienia ze statusów sprzedaży (INCLUDED_STATUS_FILTER, jak zakładka
# „Sprzedaż”) — anulowane czy testowe zamówienie z błędną stawką podpowiadało „w ostatniej
# sprzedaży 23%” przy produkcie, który jeszcze się nie sprzedał (SZP3_Szpital).
VAT_KRAJOWE = (23, 8, 5)


def _vat_sprzedaz_sql() -> str:
    """FROM + warunki „krajowa stawka z prawdziwej sprzedaży” (alias pozycji oi, zamówienia o)."""
    from config import settings, INCLUDED_STATUS_FILTER
    return f"""
        FROM {settings.TABLE_ORDER_ITEMS} oi
        JOIN {settings.TABLE_ORDERS} o
          ON o.{settings.COL_ORDER_ID} = oi.{settings.COL_ITEM_ORDER_ID} AND o.shop = oi.shop
       WHERE oi.tax_rate IN ({", ".join(map(str, VAT_KRAJOWE))}) AND oi.{settings.COL_ITEM_SKU} IS NOT NULL
         {INCLUDED_STATUS_FILTER}"""
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
        text(f"""SELECT oi.tax_rate {_vat_sprzedaz_sql()}
                    AND LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) = LOWER(TRIM(:s))
                  ORDER BY (oi.shop = :shop) DESC, o.{settings.COL_ORDER_DATE} DESC NULLS LAST LIMIT 1"""),
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
        text(f"""SELECT DISTINCT ON (LOWER(TRIM(oi.{settings.COL_ITEM_SKU})))
                        LOWER(TRIM(oi.{settings.COL_ITEM_SKU})) AS k, oi.tax_rate {_vat_sprzedaz_sql()}
                  ORDER BY LOWER(TRIM(oi.{settings.COL_ITEM_SKU})), (oi.shop = :shop) DESC,
                           o.{settings.COL_ORDER_DATE} DESC NULLS LAST"""),
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
