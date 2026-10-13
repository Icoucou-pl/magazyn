"""Zakładki „test-wycena” i „Cena” na karcie produktu: kalkulator z kosztami „+”.

Moduł jest CZYSTY (bez bazy) — router (routers/wycena.py) zbiera dane i woła stąd
`wylicz_wycene`. Ta sama formuła żyje we froncie (frontend/lib/wycena.ts); serwer przy
zapisie ceny minimalnej liczy ją jeszcze raz sam, z kosztu, który sam pobrał.

JAK LICZYMY (ustalone z właścicielem)
  1. cena po marży = koszt ÷ (1 − marża)     — marża liczona od ceny po marży, jak dziś
  2. koszty „+” doliczamy PO marży, tak żeby marża została nietknięta:
       · koszt w zł (wysyłka, karton)          → dodajemy wprost
       · koszt w % od ceny końcowej (prowizja) → dzielimy, nie mnożymy
     Przykład: po marży 4000 zł, prowizja Erli 5%. 4000 + 5% = 4200 byłoby źle — Erli weźmie
     5% od 4200, czyli 210 zł, i zostanie 3990. Poprawnie: 4000 ÷ 0,95 = 4210,53; Erli bierze
     210,53, zostaje dokładnie 4000.
  3. procent może być od NETTO albo od BRUTTO (Allegro i Erli liczą prowizję od ceny z VAT).
     Prowizja od brutto zabiera p × netto × (1 + VAT), dlatego w mianowniku stoi p × (1 + VAT).

     netto = (cena po marży + Σ koszty zł) ÷ (1 − Σ p_netto − Σ p_brutto × (1 + VAT))
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

# Ceny zapisywane z kalkulatora (jeden dziennik, kolumna kanal). Hurt = dropy.
KANALY = ("detal", "hurt", "sug_detal", "sug_hurt", "min_allegro", "sug_allegro")
KANAL_NAZWA = {
    "detal": "Cena minimalna detal",
    "hurt": "Cena minimalna dropy/hurt",
    "sug_detal": "Cena sugerowana detal",
    "sug_hurt": "Cena sugerowana dropy/hurt",
    "min_allegro": "Cena minimalna allegro",   # wyższa niż detal — prowizja Allegro jest większa
    "sug_allegro": "Cena sugerowana allegro",
}
# Każdą cenę pokazujemy (i opisujemy w dzienniku) głównie brutto, netto w opisie — decyzja właściciela.
KANALY_BRUTTO = KANALY
BAZY = ("fifo", "srednia", "najblizsza", "ostatnia", "wlasna")

# KOSZT DO WYCENY — od czego liczymy cenę, gdy nikt nie wybrał inaczej (ustalone z właścicielem):
#   1. FIFO               — towar leży na magazynie (z tej partii zejdzie następna sprzedaż)
#   2. najbliższa dostawa — na stanie nic, ale towar płynie (np. sample sprowadzany pierwszy raz)
#   3. ostatnia dostawa   — towar się wyprzedał; koszt z importem, NIE cena z faktury z ERP
# Ceny z ERP z doliczonym narzutem celowo nie ma: towar w kontenerze ma swój koszt, a bez
# żadnej dostawy w aplikacji uczciwiej jest poprosić o koszt wpisany ręcznie niż zgadywać.
KOLEJNOSC_DO_WYCENY = ("fifo", "najblizsza", "ostatnia")


def baza_do_wyceny(koszty: dict) -> Optional[str]:
    """{'fifo': 182.4, 'najblizsza': None, …} → pierwsza baza z KOLEJNOSC_DO_WYCENY, która ma koszt."""
    return next((b for b in KOLEJNOSC_DO_WYCENY if koszty.get(b)), None)
TYPY_KOSZTU = ("zl", "proc")
OD = ("netto", "brutto")
MAX_KOSZTOW = 20


class BladWyceny(ValueError):
    """Parametry, z których nie da się policzyć ceny (komunikat po polsku, idzie do użytkownika)."""


@dataclass
class Koszt:
    nazwa: str
    typ: str                 # 'zl' | 'proc'
    wartosc: float
    od: str = "brutto"       # tylko dla 'proc': 'netto' | 'brutto'


@dataclass
class PozycjaRozpisu:
    nazwa: str
    typ: str
    wartosc: float
    od: Optional[str]
    kwota: float             # ile ten koszt zabiera z ceny, w zł


@dataclass
class Wycena:
    koszt_bazy: float
    marza_proc: float
    po_marzy: float          # cena po marży, przed kosztami „+”
    marza_zl: float          # tyle zostaje firmie po zapłaceniu wszystkich kosztów
    netto: float
    brutto: float
    vat: float
    koszty: List[PozycjaRozpisu] = field(default_factory=list)


def wylicz_wycene(koszt_bazy: float, marza_proc: float, koszty: List[Koszt], vat_proc: float) -> Wycena:
    if not (koszt_bazy and koszt_bazy > 0):
        raise BladWyceny("Brak kosztu bazowego — wybierz inny albo wpisz własny")
    if marza_proc < 0 or marza_proc >= 100:
        raise BladWyceny("Marża musi być od 0 do 100%")
    if len(koszty) > MAX_KOSZTOW:
        raise BladWyceny(f"Najwyżej {MAX_KOSZTOW} kosztów")
    v = vat_proc / 100
    suma_zl = 0.0
    mian = 1.0
    for k in koszty:
        if k.typ not in TYPY_KOSZTU:
            raise BladWyceny(f"Nieznany rodzaj kosztu: {k.typ}")
        if k.wartosc < 0:
            raise BladWyceny(f"Koszt „{k.nazwa or 'bez nazwy'}” nie może być ujemny")
        if k.typ == "zl":
            suma_zl += k.wartosc
        else:
            if k.od not in OD:
                raise BladWyceny(f"Procent kosztu „{k.nazwa or 'bez nazwy'}” musi być od netto albo od brutto")
            mian -= k.wartosc / 100 * (1 + v if k.od == "brutto" else 1)
    if mian <= 0:
        raise BladWyceny("Koszty procentowe razem zabierają całą cenę — zmniejsz je")

    po_marzy = koszt_bazy / (1 - marza_proc / 100)
    netto = round((po_marzy + suma_zl) / mian, 2)
    brutto = round(netto * (1 + v), 2)
    rozpis = []
    for k in koszty:
        if k.typ == "zl":
            kwota = k.wartosc
        else:
            kwota = k.wartosc / 100 * (brutto if k.od == "brutto" else netto)
        rozpis.append(PozycjaRozpisu(k.nazwa, k.typ, k.wartosc, k.od if k.typ == "proc" else None, round(kwota, 2)))
    return Wycena(
        koszt_bazy=round(koszt_bazy, 2), marza_proc=marza_proc,
        po_marzy=round(po_marzy, 2), marza_zl=round(po_marzy - koszt_bazy, 2),
        netto=netto, brutto=brutto, vat=vat_proc, koszty=rozpis,
    )


# Szablony kalkulatora wstawiane przy pierwszym starcie (tabela pusta) — po jednym na każdą
# cenę z KANALY, w tej kolejności. Stawki prowizji celowo 0 — właściciel wpisuje swoje;
# zmyślona stawka dawałaby fałszywie pewną cenę.
_WYSYLKA = {"nazwa": "Wysyłka", "typ": "zl", "wartosc": 0}
DOMYSLNE_SZABLONY = [
    {"nazwa": KANAL_NAZWA["detal"], "cel": "detal", "marza": 20,
     "koszty": [_WYSYLKA, {"nazwa": "Prowizja kanału (średnio)", "typ": "proc", "od": "brutto", "wartosc": 0}]},
    {"nazwa": KANAL_NAZWA["hurt"], "cel": "hurt", "marza": 15, "koszty": []},
    {"nazwa": KANAL_NAZWA["sug_detal"], "cel": "sug_detal", "marza": 30,
     "koszty": [_WYSYLKA, {"nazwa": "Prowizja kanału (średnio)", "typ": "proc", "od": "brutto", "wartosc": 0}]},
    {"nazwa": KANAL_NAZWA["sug_hurt"], "cel": "sug_hurt", "marza": 20, "koszty": []},
    {"nazwa": KANAL_NAZWA["min_allegro"], "cel": "min_allegro", "marza": 20,
     "koszty": [_WYSYLKA, {"nazwa": "Prowizja Allegro", "typ": "proc", "od": "brutto", "wartosc": 0}]},
    {"nazwa": KANAL_NAZWA["sug_allegro"], "cel": "sug_allegro", "marza": 30,
     "koszty": [_WYSYLKA, {"nazwa": "Prowizja Allegro", "typ": "proc", "od": "brutto", "wartosc": 0}]},
]

# Pierwsza wersja szablonów (stare nazwy) → nowe: (stara nazwa, nowa nazwa, cel, kolejność).
# Zmieniamy tylko nazwę, cel i kolejność — marża i koszty wpisane przez właściciela zostają.
# Szablony dodane po pierwszym wdrożeniu: (cel, kolejność). Start aplikacji dokłada brakujący
# szablon RAZ — znacznik w app_wycena_dodane, żeby szablon usunięty przez właściciela nie wracał.
DOSZLE_SZABLONY = [("min_allegro", 4)]

STARE_SZABLONY = [
    ("Cena minimalna — detal", KANAL_NAZWA["detal"], "detal", 0),
    ("Cena minimalna — hurt / dropy", KANAL_NAZWA["hurt"], "hurt", 1),
    ("Cena dla dropów", KANAL_NAZWA["sug_hurt"], "sug_hurt", 3),
    ("Cena detal — Allegro", KANAL_NAZWA["sug_allegro"], "sug_allegro", 4),
]
STARY_ERLI = "Cena detal — Erli"     # nie ma go na nowej liście — znika, o ile nikt go nie zmieniał
