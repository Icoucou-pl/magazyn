"""Rachunek odprawy celnej: dopasowanie pozycji SAD do towaru z kontenerów
i rozbicie kosztów importu na sztukę.

Moduł jest CZYSTY — bierze odczyt z services/sad.py oraz zwykłe słowniki pozycji
kontenera, zwraca wynik. Bazy nie zna, dzięki czemu cały rachunek da się przeliczyć
w testach bez stawiania aplikacji (patrz scripts/sprawdz_odprawe.py).

Dlaczego dopasowanie w ogóle jest potrzebne
-------------------------------------------
Pozycja SAD to KOD CN, a nie SKU. Jedna potrafi obejmować łóżka i fotele naraz
(„Meble lekarskie…: łóżka szpitalne elektryczne, fotel geriatryczny"), a sztuk
zgłoszenie w ogóle nie podaje. Rozbicie na SKU żyje więc po stronie kontenera,
a my musimy powiedzieć, która pozycja kontenera należy do której pozycji SAD.

Kolejność źródeł dopasowania, od najpewniejszego:
  1. KOD CN zapisany w karcie produktu (app_product_attrs.kod_cn) — po pierwszym
     potwierdzeniu odprawy kolejne dostawy tego SKU trafiają na miejsce same.
  2. NAZWA TOWARU zestawiona z opisem pozycji celnej („POKROWCE PVC" vs „Pokrowiec PVC
     70L") — mówi, CZYM towar jest, więc bije wartość, która przy cenach planowanych
     sprzed dostawy potrafi rozstawić towar zupełnie wbrew rzeczywistości.
  3. WARTOŚĆ: grupujemy SKU tak, żeby suma ilość × cena planowana zgadzała się
     z wartością pozycji. Uwaga nauczona na odprawie Acti: ten sam SKU MUSI trafić
     w całości do jednej pozycji, choćby leżał w dwóch kontenerach. Bez tego
     dopasowanie po wartości rozbija Mc_YSzp1 na dwie pozycje i wychodzi bzdura,
     która na dodatek sumuje się lepiej niż prawda.

Jak liczy się koszt
-------------------
  towar        cena z SAD (wartość pozycji ÷ sztuki) × kurs zapłaty dostawcy
  logistyka    każda linia kosztu swoim kluczem: fracht i THC po kluczu fizycznym
               (waga brutto albo CBM), ubezpieczenie zawsze po wartości
  cło          z SAD, kwota ZAPŁACONA, rozdzielona wewnątrz pozycji po wartości
  gratisy      pozycje SAD bez towaru na kontenerze (części zamienne podane tylko
               do wartości celnej) — ich cło i logistyka idą na wskazany produkt
  VAT          nie wchodzi. Metoda G to rozliczenie w JPK (art. 33a), bez wypływu gotówki.
"""

from __future__ import annotations

import random
import re
import unicodedata
from dataclasses import dataclass, field
from itertools import product as iloczyn
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from services.sad import Odprawa, PozycjaSAD

KLUCZ_WAGA = "waga"
KLUCZ_CBM = "cbm"
KLUCZ_WARTOSC = "wartosc"

# Powyżej tylu kombinacji nie liczymy wszystkich układów, tylko dokładamy SKU
# od najdroższego. Przy 7 pozycjach i 10 SKU pełny przegląd to 280 mln układów.
LIMIT_PRZEGLADU = 300_000


@dataclass
class PozycjaTowaru:
    """Pozycja kontenera w postaci, jakiej potrzebuje rachunek."""
    item_id: int
    container_id: int
    sku: str
    ilosc: int
    cena_planowana: float          # PLN, app_container_items.unit_cost
    waga_brutto_kg: Optional[float] = None   # z karty produktu, na sztukę
    cbm: Optional[float] = None              # z karty produktu, na sztukę
    kod_cn: Optional[str] = None             # z karty produktu
    nazwa: Optional[str] = None              # nazwa z katalogu — do dopasowania po opisie pozycji


@dataclass
class WynikPozycji:
    item_id: int
    container_id: int
    sku: str
    ilosc: int
    cena_planowana: float
    cena_zakupu_waluta: float = 0.0   # na sztukę, w walucie odprawy
    towar: float = 0.0                # PLN, cała pozycja
    logistyka: float = 0.0
    clo: float = 0.0
    gratisy: float = 0.0              # doliczone koszty pozycji SAD bez towaru
    transport_krajowy: float = 0.0
    szacunek: bool = False            # cena rozdzielona proporcją, nie wprost z SAD
    reczna: bool = False              # cena wpisana z faktury dostawcy, nie wyliczona

    @property
    def razem(self) -> float:
        return self.towar + self.logistyka + self.clo + self.gratisy + self.transport_krajowy

    @property
    def koszt_jednostkowy(self) -> float:
        return round(self.razem / self.ilosc, 2) if self.ilosc else 0.0

    @property
    def zmiana_proc(self) -> Optional[float]:
        if not self.cena_planowana:
            return None
        return round((self.koszt_jednostkowy / self.cena_planowana - 1) * 100, 1)


@dataclass
class LiniaKosztu:
    nazwa: str
    kwota: float
    waluta: str = "USD"
    klucz: str = "fizyczny"          # "fizyczny" (waga/CBM) | "wartosc"
    container_id: Optional[int] = None   # ustawione dla transportu krajowego
    lp: Optional[int] = None


@dataclass
class Uwaga:
    poziom: str      # "blad" | "ostrzezenie" | "info"
    tresc: str
    szczegol: str = ""


@dataclass
class Rachunek:
    pozycje: List[WynikPozycji]
    przypisanie: Dict[int, int]            # item_id → nr pozycji SAD
    gratisy: Dict[int, int]                # nr pozycji SAD bez towaru → item_id, który je przejmuje
    uwagi: List[Uwaga] = field(default_factory=list)
    suma_towar: float = 0.0
    suma_logistyka: float = 0.0
    suma_clo: float = 0.0

    @property
    def narzut_proc(self) -> Optional[float]:
        if not self.suma_towar:
            return None
        return round((self.suma_logistyka + self.suma_clo) / self.suma_towar * 100, 1)


# ===== dopasowanie po nazwie =====

PROG_NAZWY = 0.15
"""Poniżej tego podobieństwa nie rozstrzygamy nazwą — jedno przypadkowe słowo
w dziesięciowyrazowym opisie celnym to za mało, żeby przesądzić o pozycji."""


def _slowa(tekst: str) -> List[str]:
    """Rdzenie słów z tekstu: bez ogonków, od 4 liter, przycięte do 6 znaków, bez powtórzeń.

    Przycięcie zastępuje odmianę: „materac”, „materace” i „materaca” dają ten sam rdzeń,
    a „przescieradlo” i „przescieradla” — „przesc”. Wystarczy, żeby opis pozycji celnej
    spotkał się z nazwą z katalogu, a jest odporniejsze niż porównywanie całych słów.

    Zwracamy listę, nie zbiór, bo długość opisu jest potem częścią miary podobieństwa,
    a zachowana kolejność ułatwia podejrzenie, co właściwie dostaliśmy.
    """
    if not tekst:
        return []
    bez = unicodedata.normalize("NFKD", tekst.lower()).replace("ł", "l")
    bez = "".join(c for c in bez if not unicodedata.combining(c))
    return list(dict.fromkeys(w[:6] for w in re.findall(r"[a-z]{4,}", bez)))


def _zbiezne(a: str, b: str) -> bool:
    """Czy dwa rdzenie mówią o tym samym słowie — z tolerancją na krótszy zapis.

    Symbol „PRZE5S” daje rdzeń „prze”, a opis celny „PRZEŚCIERADŁO” daje „przesc”.
    Przy porównaniu całych rdzeni nigdy by się nie spotkały, choć dla człowieka to
    oczywista para. Wystarczy, że jeden jest początkiem drugiego.
    """
    return a.startswith(b) or b.startswith(a)


def _podobienstwo(opis: Sequence[str], nazwa: Sequence[str]) -> float:
    """Miara Dice'a na rdzeniach: 2 × wspólne ÷ (długość opisu + długość nazwy).

    Symetria jest tu sednem sprawy. Gdybyśmy patrzyli tylko, JAKA CZĘŚĆ OPISU CELNEGO
    się pokryła, wygrywałby zawsze opis najkrótszy: „POKROWCE PVC” zgarniałoby wszystko,
    w czym stoi słowo „pokrowiec”. Gdybyśmy patrzyli tylko na część nazwy z katalogu,
    wygrywałby opis najdłuższy, bo w dziewięciu słowach zawsze coś się trafi. Dice karze
    obie rozbieżności naraz, więc „Pokrowiec PVC 70L” idzie do „POKROWCE PVC”, a
    „Poszewka na poduszkę welurowa” do pozycji zbiorczej o poszewkach — mimo że słowo
    „poduszka” stoi również w pozycji z poduszkami kosmetycznymi.
    """
    if not opis or not nazwa:
        return 0.0
    trafione = sum(1 for w in nazwa if any(_zbiezne(w, o) for o in opis))
    return 2.0 * trafione / (len(opis) + len(nazwa))


def _dopasuj_po_nazwie(odprawa: Odprawa, grupy: Dict[str, List[PozycjaTowaru]],
                       do_ulozenia: List[str],
                       dozwolone: Optional[Dict[str, Set[int]]] = None) -> Dict[str, int]:
    """SKU → nr pozycji SAD, tam gdzie nazwa towaru jednoznacznie wskazuje pozycję.

    Agencja opisuje pozycję po polsku („PODUSZKA KOSMETYCZNA WYKONANA Z PIANKI”),
    a katalog ma swoją nazwę („Poduszka kosmetyczna czarna”) — wspólne słowa mówią
    o przynależności DUŻO więcej niż sama wartość. Dopasowanie po wartości potrafi
    rozstawić towar zupełnie wbrew temu, czym on jest: przy odprawie AMH 1797 wsadziło
    materace do poduszek, a prześcieradła do pokrowców PVC, bo ceny planowane pochodziły
    sprzed dostawy i sumy „wychodziły” lepiej.

    Decydujemy tylko przy ŚCISŁEJ przewadze jednej pozycji i powyżej PROG_NAZWY.
    Remis zostawiamy wartości — lepiej nie zgadywać niż zgadnąć pewnym siebie tonem.
    Zostaje wtedy jedna ręczna poprawka, ale jednorazowa: po zapisie odprawy kod CN
    wraca na kartę produktu i następna dostawa tego SKU trafia na miejsce sama.
    """
    opisy = {p.nr: _slowa(p.opis) for p in odprawa.pozycje}
    wynik: Dict[str, int] = {}
    for sku in do_ulozenia:
        # Symbol dokładamy do nazwy, bo sam bywa mówiący („PRZE5S” → prześcieradło),
        # a w katalogu zdarzają się pozycje nazwane jednym słowem albo wcale.
        moje = _slowa(" ".join(filter(None, [grupy[sku][0].nazwa, sku])))
        if not moje:
            continue
        dozw = (dozwolone or {}).get(sku)
        punkty = sorted(((_podobienstwo(opisy[p.nr], moje), p.nr) for p in odprawa.pozycje
                         if dozw is None or p.nr in dozw),
                        reverse=True)
        if not punkty:
            continue
        if punkty[0][0] < PROG_NAZWY:
            continue
        if len(punkty) == 1 or punkty[0][0] > punkty[1][0]:
            wynik[sku] = punkty[0][1]
    return wynik


# ===== dopasowanie =====

def _dozwolone(odprawa: Odprawa, grupy: Dict[str, List[PozycjaTowaru]],
               faktury_sku: Optional[Dict[str, Set[str]]]) -> Dict[str, Set[int]]:
    """SKU → numery pozycji SAD, do których wolno je przypisać.

    Każda pozycja zgłoszenia podaje fakturę dostawcy (dokument N935), a lot kontenera to
    jeden dostawca. Gdy wiemy, z której faktury pochodzi SKU, może ono trafić wyłącznie do
    pozycji tej faktury. Na konsolidacji Acti CORU2068476 bez tego ograniczenia wózek
    od KS Medical potrafił wylądować w łóżkach od MEDI, bo wartości „pasowały".

    Pozycja bez numeru faktury jest dostępna dla wszystkich, a SKU bez znanej faktury
    (albo z fakturą, której nie ma w zgłoszeniu) nie dostaje ograniczeń — nie ma czego
    zawężać, a pusty zbiór zablokowałby dopasowanie zamiast mu pomóc.
    """
    if not faktury_sku:
        return {}
    wynik: Dict[str, Set[int]] = {}
    for sku in grupy:
        fv = faktury_sku.get(sku)
        if not fv:
            continue
        nr = {p.nr for p in odprawa.pozycje
              if not p.faktury_dostawcy or set(p.faktury_dostawcy) & fv}
        if nr and len(nr) < len(odprawa.pozycje):
            wynik[sku] = nr
    return wynik


def dopasuj(odprawa: Odprawa, towar: Sequence[PozycjaTowaru],
            slady: Optional[Dict[str, Any]] = None,
            faktury_sku: Optional[Dict[str, Set[str]]] = None,
            ustalone: Optional[Dict[int, int]] = None) -> Dict[int, int]:
    """Zwraca {item_id: nr pozycji SAD}. Kolejno: ręcznie, faktura, kod CN, nazwa, wartość.

    `slady` (opcjonalny słownik) dostaje informacje o tym, CZYM rozstrzygnięto każde SKU
    i jak pewne było dopasowanie po wartości — `policz` zamienia to na ostrzeżenia.

    `faktury_sku` (SKU → numery faktur dostawcy) zawęża każde SKU do pozycji jego faktury.
    `ustalone` (item_id → nr) to przypisania zmienione ręcznie na liście „Pozycja SAD":
    zostają nietknięte, a reszta układa się wokół nich.
    """
    if not towar or not odprawa.pozycje:
        return {}

    nr_po_cn: Dict[str, int] = {}
    for p in odprawa.pozycje:
        if p.kod_cn:
            nr_po_cn.setdefault(p.kod_cn, p.nr)

    # SKU jest jednostką dopasowania — ten sam symbol z dwóch kontenerów idzie razem.
    grupy: Dict[str, List[PozycjaTowaru]] = {}
    for t in towar:
        grupy.setdefault(t.sku, []).append(t)
    dozwolone = _dozwolone(odprawa, grupy, faktury_sku)

    wynik: Dict[int, int] = {}
    nierozstrzygniete: List[str] = []
    zrodlo: Dict[str, str] = {}
    ustalone = {k: v for k, v in (ustalone or {}).items() if v is not None}
    for sku, sztuki in grupy.items():
        if all(s.item_id in ustalone for s in sztuki):
            for s in sztuki:
                wynik[s.item_id] = ustalone[s.item_id]
            zrodlo[sku] = "recznie"
            continue
        dozw = dozwolone.get(sku)
        kod = next((s.kod_cn for s in sztuki if s.kod_cn), None)
        if kod and kod in nr_po_cn and (dozw is None or nr_po_cn[kod] in dozw):
            for s in sztuki:
                wynik[s.item_id] = nr_po_cn[kod]
            zrodlo[sku] = "cn"
        elif dozw is not None and len(dozw) == 1:
            # Faktura tego dostawcy ma w zgłoszeniu tylko jedną pozycję — nie ma czego zgadywać.
            nr = next(iter(dozw))
            for s in sztuki:
                wynik[s.item_id] = nr
            zrodlo[sku] = "faktura"
        else:
            nierozstrzygniete.append(sku)

    # Nazwa przed wartością: mówi, CZYM towar jest, a nie tylko ile kosztował.
    if nierozstrzygniete:
        po_nazwie = _dopasuj_po_nazwie(odprawa, grupy, nierozstrzygniete, dozwolone)
        for sku, nr in po_nazwie.items():
            for s in grupy[sku]:
                wynik[s.item_id] = nr
            zrodlo[sku] = "nazwa"
        nierozstrzygniete = [s for s in nierozstrzygniete if s not in po_nazwie]

    pewnosc: Optional[float] = None
    zachlannie = False
    if nierozstrzygniete:
        pomoc: Dict[str, Any] = {}
        wynik.update(_dopasuj_po_wartosci(odprawa, grupy, nierozstrzygniete, wynik, pomoc, dozwolone))
        for sku in nierozstrzygniete:
            zrodlo[sku] = "wartosc"
        pewnosc = pomoc.get("margines")
        zachlannie = bool(pomoc.get("zachlannie"))

    if slady is not None:
        slady["zrodlo"] = zrodlo
        slady["margines"] = pewnosc
        slady["zachlannie"] = zachlannie
        slady["po_wartosci"] = list(nierozstrzygniete)
    return wynik


def _dopasuj_po_wartosci(
    odprawa: Odprawa,
    grupy: Dict[str, List[PozycjaTowaru]],
    do_ulozenia: List[str],
    juz: Dict[int, int],
    pomoc: Optional[Dict[str, Any]] = None,
    dozwolone: Optional[Dict[str, Set[int]]] = None,
) -> Dict[int, int]:
    kurs = odprawa.kurs_celny or 1.0
    poz = odprawa.pozycje
    # Dla każdego SKU lista indeksów pozycji, które w ogóle wchodzą w grę.
    opcje = [
        [k for k, p in enumerate(poz) if (dozwolone or {}).get(sku) is None or p.nr in dozwolone[sku]]
        or list(range(len(poz)))
        for sku in do_ulozenia
    ]

    # Ile wartości każda pozycja SAD ma już zajęte przez SKU dopasowane po kodzie CN.
    zajete = {p.nr: 0.0 for p in poz}
    for sku, sztuki in grupy.items():
        for s in sztuki:
            if s.item_id in juz:
                zajete[juz[s.item_id]] += s.ilosc * s.cena_planowana / kurs

    wartosci = [sum(s.ilosc * s.cena_planowana / kurs for s in grupy[sku]) for sku in do_ulozenia]

    def blad(uklad: Sequence[int]) -> float:
        """Suma odchyleń WZGLĘDNYCH — każde liczone do wartości swojej pozycji.

        Odchylenie bezwzględne daje remisy i wybiera wtedy byle co. Odprawa Acti 1782:
        pozycja 1 (łóżka, 36 938 USD) jest niedopełniona, bo ceny planowane bywają stare,
        więc dorzucenie do niej wysięgnika za 646 USD zbijało jej odchyłkę dokładnie o tyle,
        ile dokładało pozycji 3 zostawionej pustej — remis co do centa, a o wyniku decydowała
        kolejność pętli. Wysięgniki lądowały wtedy przy łóżkach, a ich własna pozycja szła
        w gratisy razem ze swoim cłem 6,5%.

        Miara względna wycenia pustą pozycję na całe 1,0 jej wartości, więc zostawienie
        pozycji bez towaru musi się opłacić naprawdę mocno. Jednocześnie nie wciąga towaru
        na siłę do drobnych pozycji: dorzucenie dużego SKU do pozycji za 100 USD kosztuje
        wielokrotność tej setki.
        """
        sumy = dict(zajete)
        for i, idx in enumerate(uklad):
            if idx is not None:          # SKU jeszcze nieułożone nie obciążają żadnej pozycji
                sumy[poz[idx].nr] += wartosci[i]
        return sum(abs(sumy[p.nr] - p.wartosc) / max(p.wartosc, 1.0) for p in poz)

    n = len(do_ulozenia)
    najlepszy: Optional[List[int]] = None
    ile_ukladow = 1
    for o in opcje:
        ile_ukladow *= len(o)
    if ile_ukladow <= LIMIT_PRZEGLADU:
        naj, drugi = float("inf"), float("inf")
        for uklad in iloczyn(*opcje):
            b = blad(uklad)
            if b < naj:
                naj, drugi, najlepszy = b, naj, list(uklad)
            elif b < drugi:
                drugi = b
        # Odstęp do drugiego najlepszego układu. Blisko zera znaczy, że wartości pozycji
        # NIE rozstrzygają dopasowania — ceny planowane bywają stare i dwa układy wychodzą
        # prawie tak samo. Wtedy nie udajemy pewności, tylko prosimy o sprawdzenie.
        if pomoc is not None:
            pomoc["margines"] = drugi - naj if drugi < float("inf") else 1.0
    else:
        # Zachłannie: najdroższe SKU sadzamy pierwsze, bo one decydują o dopasowaniu.
        # Ta ścieżka NIE daje gwarancji optimum, więc zawsze prosimy o sprawdzenie —
        # wcześniej milczała, bo margines liczył się wyłącznie przy pełnym przeglądzie,
        # a to właśnie duże odprawy trafiają tutaj i najbardziej potrzebują kontroli.
        if pomoc is not None:
            pomoc["zachlannie"] = True
        # Start od „nic nie ułożone". Wcześniej startowało od [0] * n, czyli każde SKU,
        # którego pętla jeszcze nie doszła, liczyło się tak, jakby leżało w pozycji 1.
        # Pozycja 1 była przez to na starcie przepełniona i pierwsze decyzje szły pod
        # ten sztuczny nadmiar. Na konsolidacji Acti CORU2068476 (13 SKU, 7 pozycji)
        # trafiało 3 z 13, choć ceny planowane zgadzały się z fakturą co do kilku procent.
        def uloz(kolejnosc: Sequence[int]) -> "tuple[float, List[Optional[int]]]":
            uklad: List[Optional[int]] = [None] * n
            for i in kolejnosc:
                naj, wybor = float("inf"), opcje[i][0]
                for k in opcje[i]:
                    uklad[i] = k
                    b = blad(uklad)
                    if b < naj:
                        naj, wybor = b, k
                uklad[i] = wybor
            # Poprawki lokalne: przenosimy pojedyncze SKU i zamieniamy pary, dopóki błąd
            # maleje. Jedno przejście zachłanne nie cofa wczesnych decyzji, a to one bywają
            # złe — dwa SKU o podobnej wartości potrafią wylądować na krzyż.
            obecny = blad(uklad)
            for _ in range(50):
                poprawa = False
                for i in range(n):
                    for k in opcje[i]:
                        if k == uklad[i]:
                            continue
                        stare, uklad[i] = uklad[i], k
                        b = blad(uklad)
                        if b < obecny - 1e-12:
                            obecny, poprawa = b, True
                        else:
                            uklad[i] = stare
                for i in range(n):
                    for j in range(i + 1, n):
                        if uklad[i] == uklad[j] or uklad[j] not in opcje[i] or uklad[i] not in opcje[j]:
                            continue
                        uklad[i], uklad[j] = uklad[j], uklad[i]
                        b = blad(uklad)
                        if b < obecny - 1e-12:
                            obecny, poprawa = b, True
                        else:
                            uklad[i], uklad[j] = uklad[j], uklad[i]
                if not poprawa:
                    break
            return obecny, uklad

        najblad, uklad = uloz(sorted(range(n), key=lambda i: -wartosci[i]))
        if najblad > 1e-9:
            najblad, uklad = _wyzarzanie(uklad, opcje, wartosci, poz, zajete)
        najlepszy = [int(x) for x in uklad]

    wynik: Dict[int, int] = {}
    for i, sku in enumerate(do_ulozenia):
        nr = poz[najlepszy[i]].nr
        for s in grupy[sku]:
            wynik[s.item_id] = nr
    return wynik


def _wyzarzanie(start: List[Optional[int]], opcje: List[List[int]], wartosci: List[float],
                poz: Sequence[PozycjaSAD], zajete: Dict[int, float]) -> "tuple[float, List[Optional[int]]]":
    """Symulowane wyżarzanie nad układem SKU → pozycja, z błędem liczonym przyrostowo.

    Przenoszenie jednego SKU i zamiana pary potrafią utknąć w układzie, z którego wyjście
    wymaga przestawienia trzech SKU naraz (test z 12 SKU w 6 pozycjach: 0,45 zamiast 0,0).
    Wyżarzanie przyjmuje czasem ruch na gorsze i tym wychodzi z takich pułapek. Każdy ruch
    zmienia sumy tylko dwóch pozycji, więc ocena kosztuje stały czas — 30 tys. ruchów to
    kilkadziesiąt milisekund nawet przy dużej odprawie. Ziarno losowania jest stałe:
    ten sam plik daje zawsze ten sam układ.
    """
    los = random.Random(0)
    n, m = len(start), len(poz)
    cel = [max(p.wartosc, 1.0) for p in poz]
    wart = [p.wartosc for p in poz]
    sumy = [zajete[p.nr] for p in poz]
    uklad = list(start)
    for i, k in enumerate(uklad):
        sumy[k] += wartosci[i]

    def e(k: int, s_: float) -> float:
        return abs(s_ - wart[k]) / cel[k]

    obecny = sum(e(k, sumy[k]) for k in range(m))
    najblad, najlepszy = obecny, list(uklad)
    ruchome = [i for i in range(n) if len(opcje[i]) > 1]
    if not ruchome:
        return najblad, najlepszy
    KROKI, T0, T1 = 30000, 0.2, 0.0005
    for krok in range(KROKI):
        t = T0 * (T1 / T0) ** (krok / KROKI)
        i = ruchome[los.randrange(len(ruchome))]
        a = uklad[i]
        if los.random() < 0.5:
            b = opcje[i][los.randrange(len(opcje[i]))]
            if b == a:
                continue
            na, nb = sumy[a] - wartosci[i], sumy[b] + wartosci[i]
            delta = e(a, na) + e(b, nb) - e(a, sumy[a]) - e(b, sumy[b])
            if delta <= 0 or los.random() < pow(2.718281828, -delta / t):
                sumy[a], sumy[b], uklad[i] = na, nb, b
                obecny += delta
        else:
            j = ruchome[los.randrange(len(ruchome))]
            b = uklad[j]
            if a == b or b not in opcje[i] or a not in opcje[j]:
                continue
            d = wartosci[j] - wartosci[i]
            na, nb = sumy[a] + d, sumy[b] - d
            delta = e(a, na) + e(b, nb) - e(a, sumy[a]) - e(b, sumy[b])
            if delta <= 0 or los.random() < pow(2.718281828, -delta / t):
                sumy[a], sumy[b] = na, nb
                uklad[i], uklad[j] = b, a
                obecny += delta
        if obecny < najblad - 1e-12:
            najblad, najlepszy = obecny, list(uklad)
            if najblad < 1e-9:
                break
    return najblad, najlepszy


# ===== rachunek =====

def policz(
    odprawa: Odprawa,
    towar: Sequence[PozycjaTowaru],
    koszty: Sequence[LiniaKosztu],
    *,
    przypisanie: Optional[Dict[int, int]] = None,
    gratisy: Optional[Dict[int, int]] = None,
    klucz: str = KLUCZ_WAGA,
    kurs_towaru: Optional[float] = None,
    kurs_kosztow: Optional[float] = None,
    ceny_reczne: Optional[Dict[int, float]] = None,
    faktury_sku: Optional[Dict[str, Set[str]]] = None,
    udzial_kontenera: Optional[Dict[int, float]] = None,
) -> Rachunek:
    """Liczy koszt jednostkowy dla każdej pozycji kontenera.

    `ceny_reczne` to {item_id: cena na sztukę w walucie odprawy} — wpisywane z faktury
    dostawcy tam, gdzie jedna pozycja SAD obejmuje kilka SKU i podział jest szacunkiem.

    `przypisanie` to ręczne zmiany z listy „Pozycja SAD" — NADPISUJĄ automat, a nie go
    zastępują. Front wysyła wyłącznie pozycje, które ktoś przestawił; traktowanie tego
    jako kompletnego przypisania zostawiało całą resztę towaru bez pozycji, czyli bez
    ceny zakupu, a pozycje SAD szły w gratisy.

    `faktury_sku` (SKU → numery faktur dostawcy) zawęża dopasowanie do pozycji faktury
    i wskazuje, komu przypada gratis. `udzial_kontenera` (container_id → ułamek) mówi,
    jaka część kontenera należy do TEJ odprawy — transport krajowy to jedna ciężarówka
    na cały kontener, więc przy kilku odprawach każda bierze tylko swoją część.
    """
    slady: Dict[str, Any] = {}
    auto = True
    przypisanie = dopasuj(odprawa, towar, slady, faktury_sku=faktury_sku, ustalone=przypisanie)
    fx_t = kurs_towaru or odprawa.kurs_celny
    fx_k = kurs_kosztow or odprawa.kurs_celny
    ceny_reczne = ceny_reczne or {}
    uwagi: List[Uwaga] = []

    wg_item = {t.item_id: t for t in towar}
    wyniki = {
        t.item_id: WynikPozycji(
            item_id=t.item_id, container_id=t.container_id, sku=t.sku, ilosc=t.ilosc,
            cena_planowana=t.cena_planowana,
        )
        for t in towar
    }
    w_pozycji: Dict[int, List[PozycjaTowaru]] = {p.nr: [] for p in odprawa.pozycje}
    for t in towar:
        nr = przypisanie.get(t.item_id)
        if nr in w_pozycji:
            w_pozycji[nr].append(t)

    # ── 1. Towar ──────────────────────────────────────────────────────────────
    for p in odprawa.pozycje:
        lista = w_pozycji[p.nr]
        if not lista:
            continue
        mieszana = len({t.sku for t in lista}) > 1
        plan = sum(t.ilosc * t.cena_planowana for t in lista) or 1.0
        suma_recznych = 0.0
        wszystkie_reczne = True
        for t in lista:
            reczna = ceny_reczne.get(t.item_id)
            if reczna is not None:
                wartosc = reczna * t.ilosc
            else:
                wartosc = p.wartosc * (t.ilosc * t.cena_planowana) / plan
                if mieszana:
                    wszystkie_reczne = False
            suma_recznych += wartosc
            w = wyniki[t.item_id]
            w.cena_zakupu_waluta = round(wartosc / t.ilosc, 4) if t.ilosc else 0.0
            w.towar = wartosc * fx_t
            w.szacunek = mieszana and reczna is None
            w.reczna = reczna is not None
        if mieszana and not wszystkie_reczne:
            uwagi.append(Uwaga(
                "ostrzezenie",
                f"Pozycja {p.nr} obejmuje kilka SKU — ceny rozdzielone proporcją cen planowanych",
                ", ".join(sorted({t.sku for t in lista})),
            ))
        if abs(suma_recznych - p.wartosc) > 0.5:
            uwagi.append(Uwaga(
                "blad",
                f"Pozycja {p.nr}: ceny nie sumują się do wartości w SAD",
                f"{suma_recznych:.2f} vs {p.wartosc:.2f} {odprawa.waluta}",
            ))

    # ── 2. Logistyka ──────────────────────────────────────────────────────────
    pula_gratisow: Dict[int, float] = {}
    # Cło pozycji bez towaru trzymamy osobno, choć na sztuce ląduje w tej samej kolumnie:
    # kafelek CŁO ma pokazywać to, co zgłoszenie każe zapłacić, a nie tylko tę część,
    # która trafiła na pozycje z towarem.
    pula_gratisow_clo: Dict[int, float] = {}
    brak_klucza: set[str] = set()

    # Gęstość odprawy: ile m³ przypada na kilogram w pozycjach, które mają komplet CBM.
    # Potrzebna dla pozycji BEZ towaru na kontenerze (części gratis) — objętości nie ma
    # ani w SAD, ani w kartach produktu, a bez niej cały podział po CBM spadłby na wartość.
    _znane = [p for p in odprawa.pozycje
              if w_pozycji[p.nr] and p.masa_brutto and all(t.cbm is not None for t in w_pozycji[p.nr])]
    gestosc = (
        sum(sum((t.cbm or 0) * t.ilosc for t in w_pozycji[p.nr]) for p in _znane)
        / sum(p.masa_brutto for p in _znane)
    ) if _znane else 0.0
    cbm_szacowany: List[int] = []

    def klucz_pozycji(p: PozycjaSAD, rodzaj: str) -> Optional[float]:
        """Wielkość, po której dzielimy koszt na pozycję SAD."""
        if rodzaj == KLUCZ_WARTOSC:
            return p.wartosc
        if rodzaj == KLUCZ_WAGA:
            return p.masa_brutto
        lista = w_pozycji[p.nr]
        if not lista:
            if gestosc and p.masa_brutto:
                if p.nr not in cbm_szacowany:
                    cbm_szacowany.append(p.nr)
                return p.masa_brutto * gestosc
            return None
        if any(t.cbm is None for t in lista):
            brak_klucza.update(t.sku for t in lista if t.cbm is None)
            return None
        return sum((t.cbm or 0) * t.ilosc for t in lista)

    for linia in koszty:
        if not linia.kwota:
            continue
        pln = linia.kwota * (1.0 if linia.waluta == "PLN" else fx_k)
        if linia.container_id is not None:
            udzial = (udzial_kontenera or {}).get(linia.container_id, 1.0)
            _rozdziel_w_kontenerze(pln * udzial, linia.container_id, towar, wyniki, klucz)
            continue
        rodzaj = KLUCZ_WARTOSC if linia.klucz == KLUCZ_WARTOSC else klucz
        wagi = {p.nr: klucz_pozycji(p, rodzaj) for p in odprawa.pozycje}
        if any(v is None for v in wagi.values()):
            # Choć jedna pozycja nie ma czym się podzielić — cała linia idzie po wartości,
            # bo mieszanie dwóch kluczy w jednym koszcie dałoby sumę inną niż faktura.
            zdegradowany = rodzaj
            rodzaj = KLUCZ_WARTOSC
            wagi = {p.nr: p.wartosc for p in odprawa.pozycje}
            if zdegradowany == KLUCZ_CBM:
                brak_klucza.add("(pozycje bez CBM)")
        suma = sum(wagi.values()) or 1.0
        for p in odprawa.pozycje:
            kwota = pln * wagi[p.nr] / suma
            if w_pozycji[p.nr]:
                _rozdziel_w_pozycji(kwota, w_pozycji[p.nr], wyniki, rodzaj, "logistyka")
            else:
                pula_gratisow[p.nr] = pula_gratisow.get(p.nr, 0.0) + kwota

    if brak_klucza:
        uwagi.append(Uwaga(
            "ostrzezenie",
            "Brak CBM w karcie produktu — koszt rozdzielony po wartości",
            ", ".join(sorted(brak_klucza)),
        ))
    if cbm_szacowany:
        uwagi.append(Uwaga(
            "info",
            "Objętość pozycji bez towaru oszacowana z gęstości reszty odprawy",
            ", ".join(f"poz. {n}" for n in sorted(cbm_szacowany)),
        ))

    # ── 3. Cło ────────────────────────────────────────────────────────────────
    for p in odprawa.pozycje:
        lista = w_pozycji[p.nr]
        if not lista:
            pula_gratisow_clo[p.nr] = pula_gratisow_clo.get(p.nr, 0.0) + p.clo_pln
            continue
        suma = sum(wyniki[t.item_id].towar for t in lista) or 1.0
        for t in lista:
            wyniki[t.item_id].clo += p.clo_pln * wyniki[t.item_id].towar / suma

    # ── 4. Gratisy ────────────────────────────────────────────────────────────
    gratisy = dict(gratisy or {})
    wszystkie = {nr: pula_gratisow.get(nr, 0.0) + pula_gratisow_clo.get(nr, 0.0)
                 for nr in set(pula_gratisow) | set(pula_gratisow_clo)}
    if wszystkie and towar:
        # Gratis przejmuje najdroższy towar Z TEJ SAMEJ FAKTURY dostawcy — próbka od
        # KS Medical ma obciążyć towar KS Medical, a nie najdroższy towar całego kontenera,
        # który przy konsolidacji pochodzi od zupełnie innego dostawcy. Bez znanej faktury
        # zostaje dawna reguła: najdroższy towar odprawy.
        poz_po_nr = {p.nr: p for p in odprawa.pozycje}
        for nr in wszystkie:
            fv = set(poz_po_nr[nr].faktury_dostawcy) if nr in poz_po_nr else set()
            kandydaci = [t for t in towar if fv and (faktury_sku or {}).get(t.sku, set()) & fv] or list(towar)
            gratisy.setdefault(nr, max(kandydaci, key=lambda t: t.ilosc * t.cena_planowana).item_id)
    clo_gratisow = 0.0
    for nr, kwota in wszystkie.items():
        cel = gratisy.get(nr)
        if cel in wyniki:
            wyniki[cel].gratisy += kwota
            clo_gratisow += pula_gratisow_clo.get(nr, 0.0)
        else:
            uwagi.append(Uwaga("blad", f"Pozycja {nr} bez towaru nie ma wskazanego produktu", ""))

    if auto:
        uwagi.extend(_uwagi_o_dopasowaniu(slady, odprawa, w_pozycji, wyniki))

    pozycje = list(wyniki.values())
    r = Rachunek(
        pozycje=pozycje,
        przypisanie=przypisanie,
        gratisy=gratisy,
        uwagi=uwagi,
        suma_towar=round(sum(w.towar for w in pozycje), 2),
        suma_logistyka=round(
            sum(w.logistyka + w.gratisy + w.transport_krajowy for w in pozycje) - clo_gratisow, 2),
        suma_clo=round(sum(w.clo for w in pozycje) + clo_gratisow, 2),
    )
    _dopisz_uwagi_ogolne(r, odprawa, wg_item)
    return r


def _rozdziel_w_pozycji(kwota, lista, wyniki, rodzaj, pole):
    """Rozbicie kwoty MIĘDZY SKU jednej pozycji SAD.

    Gdy wszystkie SKU mają atrybut fizyczny, dzielimy nim; inaczej po wartości towaru —
    jedno SKU bez wagi nie może zepsuć podziału pozostałym.
    """
    atrybut = "waga_brutto_kg" if rodzaj == KLUCZ_WAGA else ("cbm" if rodzaj == KLUCZ_CBM else None)
    komplet = atrybut and all(getattr(t, atrybut) is not None for t in lista)
    def waga(t):
        return (getattr(t, atrybut) or 0) * t.ilosc if komplet else wyniki[t.item_id].towar
    suma = sum(waga(t) for t in lista) or 1.0
    for t in lista:
        setattr(wyniki[t.item_id], pole, getattr(wyniki[t.item_id], pole) + kwota * waga(t) / suma)


def _rozdziel_w_kontenerze(kwota, container_id, towar, wyniki, klucz):
    """Transport krajowy dotyczy JEDNEGO kontenera — dzielimy tylko jego pozycje."""
    lista = [t for t in towar if t.container_id == container_id]
    if not lista:
        return
    atrybut = "waga_brutto_kg" if klucz == KLUCZ_WAGA else "cbm"
    komplet = all(getattr(t, atrybut) is not None for t in lista)
    def waga(t):
        return (getattr(t, atrybut) or 0) * t.ilosc if komplet else wyniki[t.item_id].towar
    suma = sum(waga(t) for t in lista) or 1.0
    for t in lista:
        wyniki[t.item_id].transport_krajowy += kwota * waga(t) / suma


def _dopisz_uwagi_ogolne(r: Rachunek, odprawa: Odprawa, wg_item: Dict[int, PozycjaTowaru]) -> None:
    puste = [p.nr for p in odprawa.pozycje
             if not any(nr == p.nr for nr in r.przypisanie.values())]
    if puste:
        r.uwagi.append(Uwaga(
            "info", "Pozycje SAD bez towaru na kontenerach — rozliczone jako gratis",
            ", ".join(f"poz. {n}" for n in puste),
        ))
    bez_wagi = {t.sku for t in wg_item.values() if t.waga_brutto_kg is None}
    if bez_wagi:
        # Zapis dopisze wagę TYLKO z pozycji obejmującej jedno SKU — bo tylko tam wiadomo,
        # ile z masy pozycji przypada na sztukę. Obiecywanie tego przy pozycji mieszanej
        # byłoby nieprawdą, a właśnie tam brak wagi boli: logistyka dzieli się wtedy
        # wewnątrz pozycji po wartości, czyli droższa sztuka płaci wyższy fracht,
        # choćby ważyła tyle samo.
        sku_pozycji: Dict[int, Set[str]] = {}
        for item_id, nr in r.przypisanie.items():
            t = wg_item.get(item_id)
            if t is not None:
                sku_pozycji.setdefault(nr, set()).add(t.sku)
        samotne = {s for komplet in sku_pozycji.values() if len(komplet) == 1 for s in komplet}
        uzupelni = sorted(bez_wagi & samotne)
        recznie = sorted(bez_wagi - samotne)
        if uzupelni:
            r.uwagi.append(Uwaga(
                "info", "Brak wagi w karcie produktu — uzupełni się przy zapisie odprawy",
                ", ".join(uzupelni),
            ))
        if recznie:
            r.uwagi.append(Uwaga(
                "info",
                "Brak wagi w karcie produktu — pozycja obejmuje kilka SKU, więc wpisz ją ręcznie; "
                "do tego czasu logistyka dzieli się w pozycji po wartości",
                ", ".join(recznie),
            ))


def _uwagi_o_dopasowaniu(slady: Dict[str, Any], odprawa: Odprawa,
                         w_pozycji: Dict[int, List[PozycjaTowaru]],
                         wyniki: Dict[int, WynikPozycji]) -> List[Uwaga]:
    """Mówi wprost, czym rozstrzygnięto dopasowanie i gdzie warto je sprawdzić.

    Bez tego rachunek wygląda tak samo pewnie niezależnie od tego, czy SKU trafiło na
    miejsce po kodzie CN (pewne), po nazwie (prawdopodobne) czy po samej wartości
    (zgadywanie na starych cenach planowanych).
    """
    uwagi: List[Uwaga] = []
    zrodlo: Dict[str, str] = slady.get("zrodlo") or {}
    po_wartosci = [s for s, z in zrodlo.items() if z == "wartosc"]
    po_nazwie = [s for s, z in zrodlo.items() if z == "nazwa"]
    po_fakturze = [s for s, z in zrodlo.items() if z == "faktura"]

    if po_fakturze:
        uwagi.append(Uwaga(
            "info", "Dopasowane po fakturze dostawcy — jej jedyna pozycja w zgłoszeniu",
            ", ".join(sorted(po_fakturze)),
        ))

    if po_nazwie:
        uwagi.append(Uwaga(
            "info", "Dopasowane po nazwie towaru i opisie pozycji zgłoszenia",
            ", ".join(sorted(po_nazwie)),
        ))

    if po_wartosci:
        # Zachłanna ścieżka nie gwarantuje najlepszego układu, a mały margines znaczy,
        # że drugi układ był niemal równie dobry — w obu wypadkach prosimy o sprawdzenie.
        margines = slady.get("margines")
        niepewne = bool(slady.get("zachlannie")) or (margines is not None and margines < 0.05)
        uwagi.append(Uwaga(
            "ostrzezenie" if niepewne else "info",
            ("Dopasowanie po samej wartości — sprawdź je przed zapisem"
             if niepewne else "Dopasowane po wartości pozycji"),
            ", ".join(sorted(po_wartosci)),
        ))

    # Rozjazd wartości to najczytelniejszy sygnał, że coś stoi w złej pozycji albo że
    # ceny planowane są nieaktualne. 25% to próg, poniżej którego stare ceny same z siebie
    # potrafią się rozjechać i alarm byłby szumem.
    kurs = odprawa.kurs_celny or 1.0
    for p in odprawa.pozycje:
        lista = w_pozycji.get(p.nr) or []
        if not lista or not p.wartosc:
            continue
        plan = sum(t.ilosc * t.cena_planowana for t in lista) / kurs
        odchylka = (plan - p.wartosc) / p.wartosc
        if abs(odchylka) > 0.25:
            uwagi.append(Uwaga(
                "ostrzezenie",
                f"Poz. {p.nr}: towar wyceniony na {plan / p.wartosc * 100:.0f}% wartości ze zgłoszenia",
                f"{', '.join(sorted({t.sku for t in lista}))} — złe dopasowanie albo stare ceny planowane",
            ))
    return uwagi
