"""Koszt jednostkowy kontenera „metodą szefa” — bez SAD-u, z danych z karty kontenera.

Moduł jest CZYSTY (bez bazy), jak services/cena.py: router składa wejście, tu tylko liczymy.
Wszystko na bieżąco — zapisujemy wyłącznie ręczne poprawki, więc kontener bez żadnej
edycji też ma koszt i wpada do FIFO.

RACHUNEK (wszystkie kwoty w PLN)
  1. Kurs towaru = średnia ważona kwotą z płatności (zaliczki + balance). Każda zapłacona
     płatność ma kurs NBP (tabela A) z dnia roboczego PRZED zapłatą; niezapłacona — ostatni
     znany kurs, a cały kurs jest wtedy SZACUNKIEM. Kontener skonsolidowany: osobno per lot.
  2. Wartość towaru w walucie = suma płatności (także niezapłaconego balance), rozłożona na
     pozycje proporcjonalnie do unit_cost × szt. Cena w walucie / szt — ręczna z zakładki albo
     wpisana na pozycji kontenera (z proformy/FV dostawcy) — zostaje, a reszta pozycji dzieli
     to, co zostało z płatności. Bez płatności: wartość = ceny w walucie tam, gdzie są, a dla
     reszty ceny planowane (unit_cost to PLN) — SZACUNEK.
     Gdy WSZYSTKIE pozycje mają ceny, a płatności są inne niż ich suma, różnica to gratisy
     z faktury (części, próbki) albo rabat: rozkładamy ją na całą fakturę (grupę) po wartości
     pozycji, a gdy pozycja ma znacznik `gratis` — w całości na nią. Wchodzi do wartości celnej.
  3. Fracht morski = koszt_transportu (USD) × kurs NBP sprzed dostawy (albo ETA), po CBM.
  4. Lenmar = ryczałt LENMAR_KONTENER + LENMAR_ZGLOSZENIE za każde dodatkowe zgłoszenie
     (jedno zgłoszenie na spółkę w kontenerze), po CBM.
  5. Cło = (towar + udział frachtu) × stawka z kodu CN — per pozycja, nie po CBM.
     Brak stawki → 0% z ostrzeżeniem.
  6. Transport do magazynu (PLN z karty) po CBM.
  7. Koszt jednostkowy = suma / sztuki. VAT importowy nie jest kosztem.

WSPÓLNA FAKTURA (kontenery rozliczane razem)
Faktura dostawcy bywa rozłożona na kilka kontenerów, a płatności wpisane na kartach według
faktur — wtedy jeden kontener ma pieniądze za towar, który jedzie w drugim. Połączone
kontenery liczą towar wspólnie: płatności wszystkich idą na towar wszystkich (`policz_razem`),
a fracht, Lenmar i transport zostają na każdej karcie osobno.

DOSTAWA KRAJOWA (kontener albo lot w PLN): cena z FV (unit_cost albo ręczna) + transport do
magazynu — bez frachtu, Lenmara i cła. Gdy CAŁY kontener jest krajowy, transport dzielimy po
wartości pozycji, tak jak dotąd w zakładce „Cena”.

Pozycje bez CBM psułyby podział po kubaturze (dostałyby zero), więc jeśli którejkolwiek
pozycji importowej brakuje CBM, fracht, Lenmar i transport dzielimy po wartości towaru
i mówimy o tym w uwagach.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional

# Ryczałt opłat Lenmara bez frachtu (mediana z 23 zgłoszeń 02–09.2026: 1 597 zł na kontener,
# drugie zgłoszenie w tym samym kontenerze 660–1 230 zł). Zmiana tutaj = zmiana wszędzie.
LENMAR_KONTENER = 1600.0
LENMAR_ZGLOSZENIE = 600.0

# Lot/kontener bez wpisanego balance, którego zaliczki pokrywają mniej niż ten ułamek
# wartości planowanej, to prawie na pewno płatności wpisane w połowie (sama zaliczka 30%).
# Wtedy wartość bierzemy z cen planowanych, żeby nie zaniżyć kosztu trzykrotnie.
PROG_NIEPELNE_PLATNOSCI = 0.7

# Tolerancja różnicy, gdy wszystkie pozycje mają ręczne ceny (grosze z zaokrągleń to nie błąd).
TOLERANCJA_WALUTA = 0.5


@dataclass
class Platnosc:
    """Zaliczka albo balance (wejście z bazy). kurs ustawia router z tabeli NBP."""
    typ: str                          # 'zaliczka' | 'balance'
    kwota: float
    waluta: str
    data: Optional[date] = None       # data zapłaty; None = jeszcze niezapłacona
    kurs: Optional[float] = None      # NBP z dnia roboczego przed `data` (niezapłacona: ostatni)
    data_kursu: Optional[date] = None

    @property
    def zaplacona(self) -> bool:
        return self.data is not None


@dataclass
class Grupa:
    """Część kontenera rozliczana jednym zestawem płatności: lot albo cały kontener (id 0)."""
    id: int
    platnosci: List[Platnosc] = field(default_factory=list)
    krajowa: bool = False
    waluta: str = "USD"               # waluta, gdy płatności nie ma (z karty kontenera/lotu)
    kurs_ostatni: Optional[float] = None   # ostatni kurs NBP tej waluty — szacunki
    data_kursu_ostatniego: Optional[date] = None
    nazwa: str = ""                   # do uwag: dostawca / nr zamówienia lotu


@dataclass
class Pozycja:
    item_id: int
    sku: str
    szt: int
    unit_cost: float                  # cena planowana z pozycji kontenera (PLN)
    cbm_szt: float = 0.0
    grupa: int = 0                    # Grupa.id
    firma: str = "amh"
    kod_cn: Optional[str] = None
    stawka_slownik: Optional[float] = None   # % ze słownika kodów CN
    cena_reczna: Optional[float] = None      # ręczna cena w walucie / szt (krajowa: PLN / szt)
    cena_kontener: Optional[float] = None    # cena w walucie / szt wpisana na pozycji kontenera
    stawka_reczna: Optional[float] = None    # ręczna stawka cła % dla tej pozycji
    gratis: bool = False                     # ta pozycja przejmuje całą różnicę płatności grupy


@dataclass
class Kontener:
    fracht_usd: float = 0.0
    kurs_frachtu: Optional[float] = None
    data_kursu_frachtu: Optional[date] = None
    transport_pln: float = 0.0
    # ręczne nadpisania z app_koszt_kontenera (None = automat)
    kurs_towaru: Optional[float] = None
    fracht_pln: Optional[float] = None
    lenmar_pln: Optional[float] = None
    transport_reczny: Optional[float] = None


@dataclass
class WynikGrupy:
    id: int
    nazwa: str
    krajowa: bool
    waluta: str
    kurs: Optional[float]
    kurs_auto: Optional[float]
    kurs_reczny: bool
    szacunek: bool
    wartosc_waluta: float
    wartosc_zrodlo: str               # 'platnosci' | 'plan' | 'faktura'
    platnosci: List[Platnosc]


@dataclass
class WynikPozycji:
    item_id: int
    sku: str
    szt: int
    grupa: int
    krajowa: bool
    cena_waluta: float                # wartość w walucie / szt (krajowa: PLN / szt)
    cena_reczna: bool
    cena_zrodlo: str                  # 'reczna' | 'kontener' | 'auto' (rozłożone z płatności / plan)
    cena_planowana: float
    towar: float
    gratisy: float                    # PLN — udział w różnicy płatności (gratisy z faktury / rabat)
    gratis_przypiety: bool            # różnica grupy przypięta do tej pozycji
    fracht: float
    lenmar: float
    clo: float
    transport: float
    stawka: float
    stawka_zrodlo: str                # 'slownik' | 'reczna' | 'brak' | 'krajowa'
    kod_cn: Optional[str]
    suma: float
    koszt_jednostkowy: Optional[float]
    szacunek: bool


@dataclass
class Uwaga:
    poziom: str                       # 'blad' | 'ostrzezenie' | 'info'
    tresc: str


@dataclass
class Wynik:
    pozycje: List[WynikPozycji]
    grupy: List[WynikGrupy]
    krajowa: bool                     # cały kontener to dostawa krajowa
    fracht_auto: float
    fracht: float
    lenmar_auto: float
    lenmar: float
    transport_auto: float
    transport: float
    zgloszen: int
    podzial: str                      # 'cbm' | 'wartosc'
    towar: float = 0.0
    gratisy: float = 0.0
    clo: float = 0.0
    suma: float = 0.0
    narzut_proc: Optional[float] = None
    szacunek: bool = False
    uwagi: List[Uwaga] = field(default_factory=list)
    kontener: Optional[Kontener] = None     # wejście (fracht w USD, kurs frachtu) — do ekranu
    razem_z: List[int] = field(default_factory=list)   # kontenery rozliczane wspólnie (bez tego)
    data_frachtu: Optional[date] = None     # dostawa albo ETA, od której liczy się kurs frachtu

    def po_item(self) -> Dict[int, WynikPozycji]:
        return {p.item_id: p for p in self.pozycje}


def _pl(x: float, znak: bool = False) -> str:
    """Kwota po polsku do uwag: 1 234,50 (opcjonalnie ze znakiem)."""
    t = f"{x:{'+' if znak else ''},.2f}"
    return t.replace(",", " ").replace(".", ",")


def lenmar_ryczalt(zgloszen: int) -> float:
    """1 600 zł za kontener + 600 zł za każde dodatkowe zgłoszenie."""
    if zgloszen <= 0:
        return 0.0
    return LENMAR_KONTENER + LENMAR_ZGLOSZENIE * (zgloszen - 1)


def _waluta_glowna(platnosci: List[Platnosc], domyslna: str) -> str:
    """Waluta z największą kwotą — w niej pokazujemy kurs i wpisuje się ręczne ceny."""
    sumy: Dict[str, float] = {}
    for p in platnosci:
        sumy[p.waluta] = sumy.get(p.waluta, 0.0) + p.kwota
    return max(sumy, key=sumy.get) if sumy else (domyslna or "USD")


def _rozloz(kwota: float, wagi: Dict[int, float]) -> Dict[int, float]:
    """Kwota na pozycje proporcjonalnie do wag (wagi zerowe → po równo)."""
    if not wagi:
        return {}
    suma = sum(wagi.values())
    if suma <= 0:
        return {k: kwota / len(wagi) for k in wagi}
    return {k: kwota * w / suma for k, w in wagi.items()}


def _policz_grupe(g: Grupa, pozycje: List[Pozycja], kurs_reczny: Optional[float],
                  uwagi: List[Uwaga]) -> "tuple[WynikGrupy, Dict[int, float], Dict[int, float], set, Dict[int, float]]":
    """Towar w PLN i cena w walucie / szt dla pozycji jednej grupy.

    Zwraca (wynik grupy, {item_id: towar PLN}, {item_id: cena waluta/szt}, {item_id z ręczną ceną},
    {item_id: gratisy PLN}).
    """
    plan = {p.item_id: p.unit_cost * p.szt for p in pozycje}
    reczne = {p.item_id for p in pozycje if p.cena_reczna is not None}
    # Cena stała w walucie / szt: ręczna z zakładki wygrywa z wpisaną na pozycji kontenera.
    stala = {p.item_id: p.cena_reczna if p.cena_reczna is not None else p.cena_kontener for p in pozycje}
    etykieta = f" ({g.nazwa})" if g.nazwa else ""

    if g.krajowa:
        towar = {p.item_id: (p.cena_reczna if p.cena_reczna is not None else p.unit_cost) * p.szt
                 for p in pozycje}
        cena = {p.item_id: towar[p.item_id] / p.szt if p.szt else 0.0 for p in pozycje}
        wg = WynikGrupy(id=g.id, nazwa=g.nazwa, krajowa=True, waluta="PLN", kurs=1.0, kurs_auto=1.0,
                        kurs_reczny=False, szacunek=False, wartosc_waluta=sum(towar.values()),
                        wartosc_zrodlo="faktura", platnosci=g.platnosci)
        return wg, towar, cena, reczne, {}

    waluta = _waluta_glowna(g.platnosci, g.waluta)
    # Płatność bez kursu (NBP nie odpowiedział) liczymy po ostatnim znanym kursie — lepszy
    # szacunek niż zero; uwaga mówi, której brakuje.
    for p in g.platnosci:
        if p.waluta == "PLN":
            p.kurs = 1.0
        elif p.kurs is None and p.waluta == waluta and g.kurs_ostatni:
            p.kurs, p.data_kursu = g.kurs_ostatni, g.data_kursu_ostatniego
            uwagi.append(Uwaga("ostrzezenie", f"Brak kursu NBP dla płatności {_pl(p.kwota)} {p.waluta}"
                                              f"{etykieta} — liczona po ostatnim znanym kursie"))
    z_kursem = [p for p in g.platnosci if p.kurs]
    bez_kursu = [p for p in g.platnosci if not p.kurs]
    for p in bez_kursu:
        uwagi.append(Uwaga("blad", f"Brak kursu NBP dla płatności {_pl(p.kwota)} {p.waluta}{etykieta} "
                                   f"— pominięta w wartości towaru"))

    pln_platnosci = sum(p.kwota * p.kurs for p in z_kursem)
    w_walucie = [p for p in z_kursem if p.waluta == waluta]
    kurs_ref = (sum(p.kwota * p.kurs for p in w_walucie) / sum(p.kwota for p in w_walucie)
                if w_walucie and sum(p.kwota for p in w_walucie) > 0 else g.kurs_ostatni)
    ma_balance = any(p.typ == "balance" for p in g.platnosci)

    szacunek = any(not p.zaplacona for p in z_kursem)
    zrodlo = "platnosci"
    # Spodziewana wartość w PLN: ceny w walucie tam, gdzie są, reszta z cen planowanych.
    kurs_est = kurs_ref or g.kurs_ostatni
    oczekiwane_pln = sum((stala[p.item_id] * p.szt * kurs_est) if stala[p.item_id] is not None and kurs_est
                         else plan[p.item_id] for p in pozycje)
    if not z_kursem or (not ma_balance and oczekiwane_pln > 0
                        and pln_platnosci < PROG_NIEPELNE_PLATNOSCI * oczekiwane_pln):
        # Brak płatności (albo same zaliczki bez balance) → wartość z cen planowanych.
        if z_kursem:
            uwagi.append(Uwaga("ostrzezenie", f"Na karcie{etykieta} nie ma balance, a zaliczki pokrywają "
                                              f"mniej niż {PROG_NIEPELNE_PLATNOSCI:.0%} wartości planowanej "
                                              f"— wartość towaru z cen pozycji"))
        else:
            uwagi.append(Uwaga("ostrzezenie", f"Kontener{etykieta} nie ma płatności — wartość towaru "
                                              f"z cen pozycji, kurs to ostatni kurs NBP"))
        zrodlo, szacunek = "plan", True
        kurs_auto = kurs_ref or g.kurs_ostatni
        if not kurs_auto:
            # Bez żadnego kursu ceny planowane (PLN) zostają w złotówkach.
            waluta, kurs_auto = "PLN", 1.0
        wartosc_waluta = 0.0   # liczona niżej z pozycji — bez płatności nie ma czego rozkładać
    else:
        # Płatności w innej walucie niż główna przeliczamy na główną przez PLN.
        wartosc_waluta = sum(p.kwota if p.waluta == waluta else (p.kwota * p.kurs / kurs_ref if kurs_ref else 0.0)
                             for p in z_kursem)
        kurs_auto = pln_platnosci / wartosc_waluta if wartosc_waluta else kurs_ref

    if kurs_auto is None and waluta != "PLN":
        uwagi.append(Uwaga("blad", f"Brak kursu NBP dla {waluta}{etykieta} — towar liczony jako 0"))
    kurs = kurs_reczny if kurs_reczny else kurs_auto
    if kurs_reczny:
        szacunek = szacunek and zrodlo == "plan"   # ręczny kurs zdejmuje szacunek z kursu, nie z wartości

    # Wartość w walucie na pozycje: ceny stałe (ręczne i z kontenera) zostają, reszta dzieli
    # pozostałą kwotę płatności. Bez płatności reszta to ceny planowane przeliczone kursem.
    wartosc_poz: Dict[int, float] = {}
    suma_reczna = 0.0
    for p in pozycje:
        if stala[p.item_id] is not None:
            wartosc_poz[p.item_id] = stala[p.item_id] * p.szt
            suma_reczna += wartosc_poz[p.item_id]
    auto = [p for p in pozycje if stala[p.item_id] is None]
    if zrodlo == "plan":
        for p in auto:
            wartosc_poz[p.item_id] = plan[p.item_id] / kurs_auto
        wartosc_waluta = sum(wartosc_poz.values())
        auto = []
    reszta = wartosc_waluta - suma_reczna
    if auto:
        if reszta < 0:
            uwagi.append(Uwaga("blad", f"Wpisane ceny{etykieta} dają {_pl(suma_reczna)} {waluta}, więcej niż "
                                       f"płatności ({_pl(wartosc_waluta)} {waluta}) — pozostałe pozycje mają 0"))
            reszta = 0.0
        wagi = {p.item_id: plan[p.item_id] for p in auto}
        if sum(wagi.values()) <= 0:
            wagi = {p.item_id: float(p.szt) for p in auto}
        wartosc_poz.update(_rozloz(reszta, wagi))
    gratis_waluta: Dict[int, float] = {}
    if not auto and pozycje and abs(reszta) > TOLERANCJA_WALUTA and zrodlo == "platnosci":
        # Wszystkie pozycje mają ceny, a zapłacono inaczej: różnica to gratisy z faktury (albo
        # rabat). Zapłacone pieniądze muszą trafić do kosztu — domyślnie na całą fakturę po
        # wartości pozycji, a przypięte do pozycji ze znacznikiem `gratis` — w całości na nią.
        przypiete = [p for p in pozycje if p.gratis]
        if przypiete:
            wagi = {p.item_id: wartosc_poz[p.item_id] or float(p.szt) for p in przypiete}
            gdzie = "przypięta do " + ", ".join(p.sku for p in przypiete)
        else:
            wagi = {p.item_id: wartosc_poz[p.item_id] for p in pozycje}
            if sum(wagi.values()) <= 0:
                wagi = {p.item_id: float(p.szt) for p in pozycje}
            gdzie = "rozłożona na całą fakturę po wartości pozycji"
        gratis_waluta = _rozloz(reszta, wagi)
        if reszta > 0:
            uwagi.append(Uwaga("info", f"Gratisy / różnica z płatności{etykieta}: {_pl(reszta)} {waluta} "
                                       f"(płatności {_pl(wartosc_waluta)}, ceny pozycji {_pl(suma_reczna)}) — {gdzie}"))
        else:
            uwagi.append(Uwaga("ostrzezenie", f"Płatności{etykieta} są mniejsze niż ceny pozycji o {_pl(-reszta)} {waluta} "
                                              f"(rabat albo literówka w cenie) — różnica {gdzie}"))

    towar = {k: v * (kurs or 0.0) for k, v in wartosc_poz.items()}
    gratisy = {k: v * (kurs or 0.0) for k, v in gratis_waluta.items()}
    cena = {p.item_id: (wartosc_poz[p.item_id] / p.szt if p.szt else 0.0) for p in pozycje}
    wg = WynikGrupy(id=g.id, nazwa=g.nazwa, krajowa=False, waluta=waluta,
                    kurs=round(kurs, 6) if kurs else None, kurs_auto=round(kurs_auto, 6) if kurs_auto else None,
                    kurs_reczny=bool(kurs_reczny), szacunek=szacunek,
                    wartosc_waluta=round(wartosc_waluta, 2), wartosc_zrodlo=zrodlo, platnosci=g.platnosci)
    return wg, towar, cena, reczne, gratisy


def policz(kontener: Kontener, grupy: List[Grupa], pozycje: List[Pozycja],
           gotowe: Optional[Dict[int, tuple]] = None) -> Wynik:
    """Pełny rachunek jednego kontenera.

    `gotowe` = {id grupy: wynik _policz_grupe} policzony wcześniej dla wspólnej faktury kilku
    kontenerów (policz_razem) — wtedy towar tej grupy bierzemy stamtąd, zamiast liczyć go
    z płatności samego kontenera.
    """
    uwagi: List[Uwaga] = []
    po_grupie: Dict[int, List[Pozycja]] = {}
    for p in pozycje:
        po_grupie.setdefault(p.grupa, []).append(p)
    znane = {g.id: g for g in grupy}
    for gid in po_grupie:
        if gid not in znane:   # pozycja bez lotu w kontenerze skonsolidowanym — liczona jak cały kontener
            znane[gid] = Grupa(id=gid, waluta="USD")

    wyniki_grup: List[WynikGrupy] = []
    towar: Dict[int, float] = {}
    cena: Dict[int, float] = {}
    reczne: set = set()
    gratisy: Dict[int, float] = {}
    krajowe_grupy = set()
    for gid, lista in po_grupie.items():
        g = znane[gid]
        if gotowe and gid in gotowe:
            wg, t, c, r, gr, uw = gotowe[gid]
            uwagi.extend(uw)
        else:
            wg, t, c, r, gr = _policz_grupe(g, lista, kontener.kurs_towaru if not g.krajowa else None, uwagi)
        wyniki_grup.append(wg)
        towar.update(t)
        gratisy.update(gr)
        cena.update(c)
        reczne |= r
        if g.krajowa:
            krajowe_grupy.add(gid)

    importowe = [p for p in pozycje if p.grupa not in krajowe_grupy]
    caly_krajowy = not importowe and bool(pozycje)

    # Fracht i Lenmar — tylko gdy jest towar z importu.
    fracht_auto = 0.0
    if importowe and kontener.fracht_usd:
        if kontener.kurs_frachtu:
            fracht_auto = kontener.fracht_usd * kontener.kurs_frachtu
        else:
            uwagi.append(Uwaga("blad", "Brak kursu NBP USD do frachtu — fracht liczony jako 0"))
    zgloszen = len({p.firma for p in importowe}) if importowe else 0
    lenmar_auto = lenmar_ryczalt(zgloszen)
    fracht = kontener.fracht_pln if kontener.fracht_pln is not None else fracht_auto
    lenmar = kontener.lenmar_pln if kontener.lenmar_pln is not None else lenmar_auto
    if not importowe:
        fracht = lenmar = 0.0
    transport_auto = kontener.transport_pln or 0.0
    transport = kontener.transport_reczny if kontener.transport_reczny is not None else transport_auto

    # Klucz podziału kosztów wspólnych.
    bez_cbm = sorted({p.sku for p in importowe if not p.cbm_szt})
    podzial = "cbm"
    if caly_krajowy or bez_cbm:
        podzial = "wartosc"
        if bez_cbm and importowe:
            uwagi.append(Uwaga("ostrzezenie", f"Brak CBM dla SKU {', '.join(bez_cbm)} — fracht, Lenmar i transport "
                                              f"dzielone po wartości towaru, nie po kubaturze"))
    if podzial == "cbm":
        wagi_imp = {p.item_id: p.cbm_szt * p.szt for p in importowe}
        wagi_all = {p.item_id: p.cbm_szt * p.szt for p in pozycje}
    else:
        wagi_imp = {p.item_id: towar.get(p.item_id, 0.0) + gratisy.get(p.item_id, 0.0) for p in importowe}
        wagi_all = {p.item_id: towar.get(p.item_id, 0.0) + gratisy.get(p.item_id, 0.0) for p in pozycje}
    fr = _rozloz(fracht, wagi_imp) if importowe else {}
    le = _rozloz(lenmar, wagi_imp) if importowe else {}
    tr = _rozloz(transport, wagi_all)

    out: List[WynikPozycji] = []
    szac_grup = {w.id: w.szacunek for w in wyniki_grup}
    for p in pozycje:
        kraj = p.grupa in krajowe_grupy
        t = towar.get(p.item_id, 0.0)
        gr = gratisy.get(p.item_id, 0.0)
        f = fr.get(p.item_id, 0.0)
        if kraj:
            stawka, zrodlo = 0.0, "krajowa"
        elif p.stawka_reczna is not None:
            stawka, zrodlo = float(p.stawka_reczna), "reczna"
        elif p.stawka_slownik is not None:
            stawka, zrodlo = float(p.stawka_slownik), "slownik"
        else:
            stawka, zrodlo = 0.0, "brak"
            powod = f"kod CN {p.kod_cn} nie ma stawki w słowniku" if p.kod_cn else "produkt nie ma kodu CN"
            uwagi.append(Uwaga("blad", f"Brak stawki cła dla SKU {p.sku} ({powod}) — liczymy 0%"))
        clo = (t + gr + f) * stawka / 100
        l_ = le.get(p.item_id, 0.0)
        tt = tr.get(p.item_id, 0.0)
        suma = t + gr + f + l_ + clo + tt
        out.append(WynikPozycji(
            item_id=p.item_id, sku=p.sku, szt=p.szt, grupa=p.grupa, krajowa=kraj,
            cena_waluta=round(cena.get(p.item_id, 0.0), 4), cena_reczna=p.item_id in reczne,
            cena_zrodlo=("reczna" if p.item_id in reczne
                         else "kontener" if p.cena_kontener is not None and not kraj else "auto"),
            cena_planowana=p.unit_cost,
            towar=round(t, 2), gratisy=round(gr, 2), gratis_przypiety=p.gratis and not kraj, fracht=round(f, 2), lenmar=round(l_, 2), clo=round(clo, 2),
            transport=round(tt, 2), stawka=stawka, stawka_zrodlo=zrodlo, kod_cn=p.kod_cn,
            suma=round(suma, 2),
            koszt_jednostkowy=round(suma / p.szt, 2) if p.szt and suma > 0 else None,
            szacunek=bool(szac_grup.get(p.grupa)),
        ))

    w = Wynik(pozycje=out, grupy=wyniki_grup, krajowa=caly_krajowy,
              fracht_auto=round(fracht_auto, 2), fracht=round(fracht, 2),
              lenmar_auto=round(lenmar_auto, 2), lenmar=round(lenmar, 2),
              transport_auto=round(transport_auto, 2), transport=round(transport, 2),
              zgloszen=zgloszen, podzial=podzial, uwagi=uwagi, kontener=kontener)
    w.towar = round(sum(p.towar for p in out), 2)
    w.gratisy = round(sum(p.gratisy for p in out), 2)
    w.clo = round(sum(p.clo for p in out), 2)
    w.suma = round(sum(p.suma for p in out), 2)
    # Gratisy to zapłacony towar, nie koszt importu — narzut liczymy od towaru razem z nimi.
    baza = w.towar + w.gratisy
    w.narzut_proc = round((w.suma - baza) / baza * 100, 2) if baza > 0 else None
    w.szacunek = any(g.szacunek for g in wyniki_grup)
    return w


def policz_razem(kontenery: Dict[int, "tuple[Kontener, Grupa, List[Pozycja]]"]) -> Dict[int, Wynik]:
    """Kilka kontenerów z jedną fakturą dostawcy: {container_id: (Kontener, Grupa, pozycje)}.

    Towar liczymy raz dla wszystkich — płatności wszystkich kart idą na towar wszystkich,
    po cenach pozycji — a potem każdy kontener liczy swój fracht, Lenmara, cło i transport.
    Ręczny kurs towaru: z pierwszego kontenera, który go ma (jeden kurs dla wspólnej faktury).
    """
    ids = sorted(kontenery)
    wspolna = Grupa(
        id=0,
        platnosci=[p for cid in ids for p in kontenery[cid][1].platnosci],
        krajowa=False,
        waluta=kontenery[ids[0]][1].waluta,
        kurs_ostatni=next((kontenery[c][1].kurs_ostatni for c in ids if kontenery[c][1].kurs_ostatni), None),
        data_kursu_ostatniego=next((kontenery[c][1].data_kursu_ostatniego for c in ids
                                    if kontenery[c][1].data_kursu_ostatniego), None),
        nazwa="wspólna faktura",
    )
    pozycje = [p for cid in ids for p in kontenery[cid][2]]
    kurs_reczny = next((kontenery[c][0].kurs_towaru for c in ids if kontenery[c][0].kurs_towaru), None)
    uwagi: List[Uwaga] = []
    wg, t, c, r, gr = _policz_grupe(wspolna, pozycje, kurs_reczny, uwagi)
    out: Dict[int, Wynik] = {}
    for cid in ids:
        k, _, lista = kontenery[cid]
        moje = {p.item_id for p in lista}
        gotowe = {0: (wg, {i: v for i, v in t.items() if i in moje}, {i: v for i, v in c.items() if i in moje},
                      r & moje, {i: v for i, v in gr.items() if i in moje}, list(uwagi))}
        w = policz(k, [kontenery[cid][1]], lista, gotowe)
        w.razem_z = [x for x in ids if x != cid]
        out[cid] = w
    return out
