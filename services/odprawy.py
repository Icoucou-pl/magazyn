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
  2. WARTOŚĆ: grupujemy SKU tak, żeby suma ilość × cena planowana zgadzała się
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

from dataclasses import dataclass, field
from itertools import product as iloczyn
from typing import Any, Dict, List, Optional, Sequence

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


# ===== dopasowanie =====

def dopasuj(odprawa: Odprawa, towar: Sequence[PozycjaTowaru]) -> Dict[int, int]:
    """Zwraca {item_id: nr pozycji SAD}. Najpierw po kodzie CN, reszta po wartości."""
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

    wynik: Dict[int, int] = {}
    nierozstrzygniete: List[str] = []
    for sku, sztuki in grupy.items():
        kod = next((s.kod_cn for s in sztuki if s.kod_cn), None)
        if kod and kod in nr_po_cn:
            for s in sztuki:
                wynik[s.item_id] = nr_po_cn[kod]
        else:
            nierozstrzygniete.append(sku)

    if nierozstrzygniete:
        wynik.update(_dopasuj_po_wartosci(odprawa, grupy, nierozstrzygniete, wynik))
    return wynik


def _dopasuj_po_wartosci(
    odprawa: Odprawa,
    grupy: Dict[str, List[PozycjaTowaru]],
    do_ulozenia: List[str],
    juz: Dict[int, int],
) -> Dict[int, int]:
    kurs = odprawa.kurs_celny or 1.0
    poz = odprawa.pozycje
    calosc = odprawa.wartosc_faktur or 1.0

    # Ile wartości każda pozycja SAD ma już zajęte przez SKU dopasowane po kodzie CN.
    zajete = {p.nr: 0.0 for p in poz}
    for sku, sztuki in grupy.items():
        for s in sztuki:
            if s.item_id in juz:
                zajete[juz[s.item_id]] += s.ilosc * s.cena_planowana / kurs

    wartosci = [sum(s.ilosc * s.cena_planowana / kurs for s in grupy[sku]) for sku in do_ulozenia]

    def blad(uklad: Sequence[int]) -> float:
        sumy = dict(zajete)
        for i, idx in enumerate(uklad):
            sumy[poz[idx].nr] += wartosci[i]
        return sum(abs(sumy[p.nr] - p.wartosc) for p in poz) / calosc

    n, m = len(do_ulozenia), len(poz)
    najlepszy: Optional[List[int]] = None
    if m ** n <= LIMIT_PRZEGLADU:
        naj = float("inf")
        for uklad in iloczyn(range(m), repeat=n):
            b = blad(uklad)
            if b < naj:
                naj, najlepszy = b, list(uklad)
    else:
        # Zachłannie: najdroższe SKU sadzamy pierwsze, bo one decydują o dopasowaniu.
        najlepszy = [0] * n
        for i in sorted(range(n), key=lambda i: -wartosci[i]):
            naj, wybor = float("inf"), 0
            for k in range(m):
                najlepszy[i] = k
                b = blad(najlepszy)
                if b < naj:
                    naj, wybor = b, k
            najlepszy[i] = wybor

    wynik: Dict[int, int] = {}
    for i, sku in enumerate(do_ulozenia):
        nr = poz[najlepszy[i]].nr
        for s in grupy[sku]:
            wynik[s.item_id] = nr
    return wynik


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
) -> Rachunek:
    """Liczy koszt jednostkowy dla każdej pozycji kontenera.

    `ceny_reczne` to {item_id: cena na sztukę w walucie odprawy} — wpisywane z faktury
    dostawcy tam, gdzie jedna pozycja SAD obejmuje kilka SKU i podział jest szacunkiem.
    """
    przypisanie = dict(przypisanie or dopasuj(odprawa, towar))
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
            _rozdziel_w_kontenerze(pln, linia.container_id, towar, wyniki, klucz)
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
            pula_gratisow[p.nr] = pula_gratisow.get(p.nr, 0.0) + p.clo_pln
            continue
        suma = sum(wyniki[t.item_id].towar for t in lista) or 1.0
        for t in lista:
            wyniki[t.item_id].clo += p.clo_pln * wyniki[t.item_id].towar / suma

    # ── 4. Gratisy ────────────────────────────────────────────────────────────
    gratisy = dict(gratisy or {})
    if pula_gratisow and towar:
        domyslny = max(towar, key=lambda t: t.ilosc * t.cena_planowana).item_id
        for nr in pula_gratisow:
            gratisy.setdefault(nr, domyslny)
    for nr, kwota in pula_gratisow.items():
        cel = gratisy.get(nr)
        if cel in wyniki:
            wyniki[cel].gratisy += kwota
        else:
            uwagi.append(Uwaga("blad", f"Pozycja {nr} bez towaru nie ma wskazanego produktu", ""))

    pozycje = list(wyniki.values())
    r = Rachunek(
        pozycje=pozycje,
        przypisanie=przypisanie,
        gratisy=gratisy,
        uwagi=uwagi,
        suma_towar=round(sum(w.towar for w in pozycje), 2),
        suma_logistyka=round(sum(w.logistyka + w.gratisy + w.transport_krajowy for w in pozycje), 2),
        suma_clo=round(sum(w.clo for w in pozycje), 2),
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
    bez_wagi = sorted({t.sku for t in wg_item.values() if t.waga_brutto_kg is None})
    if bez_wagi:
        r.uwagi.append(Uwaga(
            "info", "Brak wagi w karcie produktu — uzupełni się przy zapisie odprawy",
            ", ".join(bez_wagi),
        ))
