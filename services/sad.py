"""Parser zgłoszenia celnego (SAD) z eksportu XML programu WinSAD.

Plik dostajemy mailem od agencji celnej razem z PDF-em. NIE jest to urzędowy
komunikat ZC429 — to własny format WinSAD-a, ale stały między zgłoszeniami:
wartości siedzą w atrybutach z kropką dziesiętną, więc nic nie zależy od układu
wydruku.

Moduł jest CZYSTY: żadnego dostępu do bazy, żadnego FastAPI. Wejście to bajty
albo tekst XML, wyjście to dataclass. Dzięki temu da się go odpalić na pliku
z dysku (patrz scripts/sad_check.py) bez stawiania aplikacji.

Czego w SAD NIE MA, choć bywa szukane:
  · objętości (CBM) — jest tylko masa brutto/netto i liczba kartonów;
    kubatura mieszka na packing liście (dokument N271) i w karcie produktu,
  · ilości sztuk — poza rzadkim przypadkiem kodu CN z jednostką uzupełniającą
    (P41IloscUzupJm), więc rozbicie pozycji na SKU bierzemy z pozycji kontenera.

Pułapki wyłapane na dwóch prawdziwych zgłoszeniach (Acti 26PL32208D009GYVR6
i Veluxa 26PL32208D009KIVR3). UWAGA: samych plików nie wrzucamy do repozytorium —
jest publiczne, a zgłoszenie niesie dostawcę, ceny i NIP-y. Trzymaj je lokalnie.
  · KILKA KURSÓW w jednym pliku (SAD 1790 ma EUR i USD). Kurs bierzemy po
    walucie zgłoszenia (P22WalutaSADu), nie pierwszy z brzegu — inaczej wartości
    celne wychodzą o 16% za wysoko.
  · CŁO jest w dwóch wariantach: P47Oplaty@Kwota to kwota ZAPŁACONA (zaokrąglona
    do pełnych złotych) i to ona wchodzi do kosztu; Skladowe@KwotaOplaty to
    wyliczenie co do grosza i służy tylko kontroli.
  · DOLICZENIA mają jawnie podany klucz podziału: RozbijWg="2" to masa brutto
    (fracht, THC), RozbijWg="1" to wartość (ubezpieczenie). Nie zgadujemy go.
  · POLA CZASU niosą datę 1899-12-30 (artefakt Delphi) — czytamy wyłącznie
    atrybuty z datą.
  · TrescDoDruku* to tekst wydruku z przecinkami dziesiętnymi — ignorujemy.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional

# Klucz podziału doliczeń, tak jak zapisuje go WinSAD w RozbijWg.
KLUCZ_ROZBICIA = {"1": "wartosc", "2": "waga_brutto"}

# Kody doliczeń z pola 44. 031W/032W wchodzą do wartości celnej (a więc do podstawy
# cła), 071V dolicza się dopiero do podstawy VAT — to koszt już po wejściu do UE.
KOD_FRACHT = "031W"
KOD_UBEZPIECZENIE = "032W"
KOD_PO_GRANICY = "071V"
KODY_DO_WARTOSCI_CELNEJ = (KOD_FRACHT, KOD_UBEZPIECZENIE)


class BladSAD(ValueError):
    """Plik nie jest tym, za co się podaje, albo brakuje w nim danych do rachunku."""


@dataclass
class Doliczenie:
    kod: str
    kwota: float          # w walucie zgłoszenia
    klucz: str            # "waga_brutto" | "wartosc"
    do_wartosci_celnej: bool


@dataclass
class PozycjaSAD:
    nr: int
    kod_cn: str
    opis: str
    wartosc: float                 # w walucie zgłoszenia
    masa_brutto: float
    masa_netto: float
    wartosc_celna_pln: float
    clo_stawka: float
    clo_pln: float                 # ZAPŁACONE (zaokrąglone) — to wchodzi do kosztu
    clo_wyliczone: float           # co do grosza — tylko kontrola
    vat_stawka: float
    vat_pln: float
    vat_metoda: Optional[str]      # "G" = rozliczenie w JPK (art. 33a), bez wypływu gotówki
    doliczenia: Dict[str, float]   # kod → kwota w walucie zgłoszenia
    kontenery: List[str]
    faktury_dostawcy: List[str]
    liczba_opakowan: Optional[int]
    szt_uzup: Optional[float]      # jednostka uzupełniająca, gdy kod CN jej wymaga


@dataclass
class Kontrola:
    nazwa: str
    ok: bool
    wyliczone: float
    z_pliku: float

    @property
    def roznica(self) -> float:
        return round(self.wyliczone - self.z_pliku, 2)


@dataclass
class Odprawa:
    mrn: Optional[str]
    data_zgloszenia: Optional[date]
    dostawca: Optional[str]
    nip_importera: Optional[str]
    importer: Optional[str]
    incoterms: Optional[str]
    waluta: str
    kurs_celny: float
    kursy: Dict[str, float]
    wartosc_faktur: float
    masa_brutto: float
    clo_suma: float
    vat_suma: float
    doliczenia: List[Doliczenie]
    pozycje: List[PozycjaSAD] = field(default_factory=list)
    kontenery: List[str] = field(default_factory=list)
    faktury_dostawcy: List[str] = field(default_factory=list)

    @property
    def clo_do_zaplaty(self) -> float:
        return round(sum(p.clo_pln for p in self.pozycje), 2)


# ===== pomocnicze =====

def _f(v: Any) -> float:
    if v in (None, ""):
        return 0.0
    try:
        return float(str(v).replace(",", "."))
    except ValueError:
        return 0.0


def _i(v: Any) -> Optional[int]:
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def _data(v: Any) -> Optional[date]:
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def normalizuj_cn(v: Optional[str]) -> Optional[str]:
    """„9402 90 00", „9402.90.00" i „94029000" to ten sam kod — zostawiamy cyfry.

    Ta sama reguła siedzi w routers/products.py przy zapisie kodu CN produktu,
    żeby dopasowanie pozycji odprawy do SKU nie zależało od sposobu zapisu.
    """
    if not v:
        return None
    cyfry = "".join(ch for ch in str(v) if ch.isdigit())[:10]
    return cyfry or None


def _dzieci(el: ET.Element, tag: str) -> List[ET.Element]:
    """Bezpośrednie dzieci danego tagu. ElementTree nie ma XPath-a na „tylko dzieci",
    a KorektyZrodlowe siedzą i w pozycji, i zbiorczo — nie wolno ich pomieszać."""
    return [c for c in el if c.tag == tag]


# ===== parser =====

def parsuj(zrodlo: Any) -> Odprawa:
    """Zamienia XML z WinSAD-a na Odprawę. `zrodlo` to bajty, tekst albo ścieżka."""
    if isinstance(zrodlo, (bytes, bytearray)) and not zrodlo.strip():
        raise BladSAD("Plik jest pusty.")
    if isinstance(zrodlo, str) and not zrodlo.strip():
        raise BladSAD("Plik jest pusty.")
    try:
        if isinstance(zrodlo, (bytes, bytearray)):
            root = ET.fromstring(zrodlo)
        elif isinstance(zrodlo, str) and zrodlo.lstrip().startswith("<"):
            root = ET.fromstring(zrodlo)
        else:
            # Ścieżka na dysku — wygodne przy testach; endpoint podaje bajty uploadu.
            root = ET.parse(zrodlo).getroot()
    except ET.ParseError as e:
        raise BladSAD(f"Plik nie jest poprawnym XML-em: {e}") from e
    except OSError as e:
        # Tekst, który nie zaczyna się od „<", trafia tu jako nieistniejąca ścieżka.
        raise BladSAD("Plik nie jest poprawnym XML-em (nie zaczyna się od znacznika).") from e

    if root.tag != "SADUE":
        raise BladSAD(
            f"To nie jest eksport SAD z programu WinSAD (element główny: {root.tag}, oczekiwany: SADUE)."
        )

    waluta = root.get("P22WalutaSADu") or "PLN"
    kursy: Dict[str, float] = {}
    for k in _dzieci(root, "P22KursyWalut"):
        mnoznik = _f(k.get("Mnoznik")) or 1.0
        kursy[k.get("Waluta")] = _f(k.get("Kurs")) / mnoznik
    kurs = kursy.get(waluta)
    if not kurs:
        raise BladSAD(
            f"Brak kursu dla waluty zgłoszenia {waluta}. W pliku są: {', '.join(kursy) or 'żadne'}."
        )

    zestaw = next(iter(_dzieci(root, "ZestawySADu")), None)
    ais = next(iter(_dzieci(zestaw, "StatusCelnyAIS")), None) if zestaw is not None else None
    celina = next(iter(_dzieci(zestaw, "DaneCeliny")), None) if zestaw is not None else None
    mrn = (ais.get("MRNAIS") if ais is not None else None) or (
        celina.get("CelinaOGL") if celina is not None else None
    )

    nadawca = root.find("P2Nadawca/Firmy")
    odbiorca = root.find("P8Odbiorca/Firmy")
    warunki = next(iter(_dzieci(root, "P20WarDostawy")), None)
    kontekst = next(iter(_dzieci(root, "P1Kontekst")), None)

    dolicz_zbiorcze = [
        Doliczenie(
            kod=d.get("KodKorekty"),
            kwota=_f(d.get("WartKorekty")),
            klucz=KLUCZ_ROZBICIA.get(d.get("RozbijWg"), "wartosc"),
            do_wartosci_celnej=d.get("KodKorekty") in KODY_DO_WARTOSCI_CELNEJ,
        )
        for d in _dzieci(root, "KorektyZbiorcze")
    ]

    pozycje: List[PozycjaSAD] = []
    for nr, p in enumerate(_dzieci(root, "PozycjeSADu"), start=1):
        oplaty = {o.get("Typ"): o for o in _dzieci(p, "P47Oplaty")}
        a00, b00 = oplaty.get("A00"), oplaty.get("B00")
        skladowa = next(iter(_dzieci(a00, "Skladowe")), None) if a00 is not None else None

        znaki = next(iter(_dzieci(p, "P31ZnakiINumery")), None)
        opak = next(iter(_dzieci(znaki, "Opakowania")), None) if znaki is not None else None
        kont = (
            [k.get("Numer", "").strip().upper() for k in _dzieci(znaki, "Kontenery")]
            if znaki is not None else []
        )
        kod = next(iter(_dzieci(p, "P33KodTowaru")), None)

        dod = next(iter(_dzieci(p, "P44DodInfo")), None)
        kor = {}
        faktury: List[str] = []
        if dod is not None:
            for k in _dzieci(dod, "KorektyZrodlowe"):
                kor[k.get("KodKorekty")] = _f(k.get("WartKorekty"))
            for d in _dzieci(dod, "DokumWymag"):
                if d.get("KodDokum") == "N935" and (d.get("NrDokum") or "").strip():
                    faktury.append(d.get("NrDokum").strip())

        pozycje.append(PozycjaSAD(
            nr=nr,
            kod_cn=normalizuj_cn(kod.get("KodCN") if kod is not None else None) or "",
            opis=" ".join((znaki.get("OpisTowaru") or "").split()) if znaki is not None else "",
            wartosc=_f(p.get("P42WartoscPozycji")),
            masa_brutto=_f(p.get("P35MasaBrutto")),
            masa_netto=_f(p.get("P38MasaNetto")),
            wartosc_celna_pln=_f(p.get("P47WartCelna")),
            clo_stawka=_f(a00.get("Stawka")) if a00 is not None else 0.0,
            clo_pln=_f(a00.get("Kwota")) if a00 is not None else 0.0,
            clo_wyliczone=_f(skladowa.get("KwotaOplaty")) if skladowa is not None else 0.0,
            vat_stawka=_f(b00.get("Stawka")) if b00 is not None else 0.0,
            vat_pln=_f(b00.get("Kwota")) if b00 is not None else 0.0,
            vat_metoda=b00.get("MP") if b00 is not None else None,
            doliczenia=kor,
            kontenery=sorted(set(filter(None, kont))),
            faktury_dostawcy=sorted(set(faktury)),
            liczba_opakowan=_i(opak.get("LiczbaOpak")) if opak is not None else None,
            szt_uzup=_f(p.get("P41IloscUzupJm")) or None,
        ))

    if not pozycje:
        raise BladSAD("Zgłoszenie nie ma ani jednej pozycji towarowej.")

    return Odprawa(
        mrn=mrn,
        data_zgloszenia=_data(kontekst.get("DataDekl") if kontekst is not None else None),
        dostawca=nadawca.get("Nazwa") if nadawca is not None else None,
        nip_importera=odbiorca.get("NIP") if odbiorca is not None else None,
        importer=odbiorca.get("Nazwa") if odbiorca is not None else None,
        incoterms=(
            f"{warunki.get('Kod')} {warunki.get('Miejsce')}".strip()
            if warunki is not None else None
        ),
        waluta=waluta,
        kurs_celny=kurs,
        kursy=kursy,
        wartosc_faktur=_f(zestaw.get("P22WartoscZestawu")) if zestaw is not None else 0.0,
        masa_brutto=_f(zestaw.get("P35BruttoZestawu")) if zestaw is not None else 0.0,
        clo_suma=_f(zestaw.get("SumaClaZestawu")) if zestaw is not None else 0.0,
        vat_suma=_f(zestaw.get("SumaVATZestawu")) if zestaw is not None else 0.0,
        doliczenia=dolicz_zbiorcze,
        pozycje=pozycje,
        kontenery=sorted({c for p in pozycje for c in p.kontenery}),
        faktury_dostawcy=sorted({f for p in pozycje for f in p.faktury_dostawcy}),
    )


# ===== kontrole krzyżowe =====

def kontrole(o: Odprawa) -> List[Kontrola]:
    """Liczby w SAD muszą się spinać między sobą. Jeśli się nie spinają, plik został
    odczytany źle albo zgłoszenie jest nietypowe — w obu wypadkach kosztu nie zapisujemy.

    Tolerancje: doliczenia i wartości celne co do grosza (agencja liczy je tym samym
    wzorem), cło z tolerancją 1 zł na pozycję, bo SAD zaokrągla je do pełnych złotych.
    """
    w: List[Kontrola] = []

    def chk(nazwa: str, wyliczone: float, z_pliku: float, tol: float = 0.01) -> None:
        w.append(Kontrola(nazwa, abs(wyliczone - z_pliku) <= tol, round(wyliczone, 2), round(z_pliku, 2)))

    chk("Suma wartości pozycji = wartość faktur",
        sum(p.wartosc for p in o.pozycje), o.wartosc_faktur)
    chk("Suma mas brutto pozycji = masa zgłoszenia",
        sum(p.masa_brutto for p in o.pozycje), o.masa_brutto)
    chk("Suma cła z pozycji = cło zgłoszenia",
        o.clo_do_zaplaty, o.clo_suma, tol=max(1.0, len(o.pozycje)))

    for d in o.doliczenia:
        chk(f"Doliczenie {d.kod}: suma po pozycjach",
            sum(p.doliczenia.get(d.kod, 0.0) for p in o.pozycje), d.kwota)
        baza = (lambda p: p.masa_brutto) if d.klucz == "waga_brutto" else (lambda p: p.wartosc)
        suma_bazy = sum(baza(p) for p in o.pozycje)
        if suma_bazy <= 0:
            continue
        for p in o.pozycje:
            chk(f"Doliczenie {d.kod} poz. {p.nr} wg {d.klucz}",
                d.kwota * baza(p) / suma_bazy, p.doliczenia.get(d.kod, 0.0), tol=0.02)

    for p in o.pozycje:
        podstawa = p.wartosc + sum(p.doliczenia.get(k, 0.0) for k in KODY_DO_WARTOSCI_CELNEJ)
        chk(f"Wartość celna poz. {p.nr} odtworzona z pozycji i doliczeń",
            podstawa * o.kurs_celny, p.wartosc_celna_pln, tol=0.5)
        chk(f"Cło poz. {p.nr} = stawka × wartość celna",
            p.wartosc_celna_pln * p.clo_stawka / 100, p.clo_wyliczone, tol=0.05)

    return w


def podzial_kosztu(o: Odprawa, kwota: float, klucz: str) -> Dict[int, float]:
    """Rozbija kwotę na pozycje odprawy wskazanym kluczem: „waga_brutto" albo „wartosc".

    Zwraca {nr pozycji: kwota}. Gdy klucz nie ma na czym się oprzeć (zerowe masy),
    spada na wartość — lepiej podzielić po wartości niż wywalić się na dzieleniu przez zero.
    """
    baza = {p.nr: (p.masa_brutto if klucz == "waga_brutto" else p.wartosc) for p in o.pozycje}
    if sum(baza.values()) <= 0:
        baza = {p.nr: p.wartosc for p in o.pozycje}
    suma = sum(baza.values())
    if suma <= 0:
        return {p.nr: 0.0 for p in o.pozycje}
    return {nr: kwota * v / suma for nr, v in baza.items()}
