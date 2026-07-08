"""Asystent AI magazynu — provider-agnostyczny (endpoint zgodny z OpenAI).

Zasada: model NIGDY nie wymyśla liczb. Na pytanie po polsku wybiera narzędzie
(tool calling), nasz backend liczy realne dane z Supabase, a model tylko ubiera
wynik w zdanie. Dostawcę (Groq / Gemini / Ollama / Anthropic) ustawiamy zmiennymi
LLM_BASE_URL / LLM_API_KEY / LLM_MODEL — bez ruszania kodu.

Narzędzia są TYLKO-DO-ODCZYTU i nie zwracają pól finansowych (zero ryzyka wycieku
marż/kosztów przez asystenta). Pod przyszłe narzędzia finansowe respektowalibyśmy
uprawnienie viewFinancials.
"""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from datetime import date
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from models import CurrentUser
from security import has_perm
from services.products import fetch_products
from services.containers import fetch_containers
from services.usage import log_usage

MAX_ROUNDS = 4            # ile razy max model może poprosić o narzędzie w jednej turze
LLM_TIMEOUT = 30          # sekundy na pojedyncze wywołanie LLM

SYSTEM_PROMPT = (
    "Jesteś asystentem magazynowym aplikacji „Magazyn” firmy i-coucou. "
    "Odpowiadasz wyłącznie po polsku, krótko i konkretnie — jak kolega z pracy. "
    "ZAWSZE używaj narzędzi, żeby pobrać liczby z bazy: stany, prognozy, sprzedaż, listę do zamówienia, kontenery. "
    "Nigdy nie zmyślaj stanów, dat, liczb ani SKU — jeśli nie masz danych z narzędzia, powiedz to wprost. "
    "Do pytań o kontenery, dostawy, ETA i „kiedy coś przypłynie/dotrze” użyj narzędzia kontenery_w_drodze — "
    "NIE używaj do tego narzędzi produktowych. "
    "Co jest w środku konkretnego kontenera (jakie produkty, jaki towar) sprawdzaj narzędziem zawartosc_kontenera "
    "po numerze kontenera — nigdy nie zgaduj zawartości. "
    "Nie wywołuj tego samego narzędzia kilka razy z tymi samymi argumentami. "
    "Do pytań o konkretny produkt (stan, prognoza, sprzedaż) potrzebujesz SKU — jeśli użytkownik go nie podał, dopytaj, nie zgaduj. "
    "Jeśli produkt nie został znaleziony, powiedz to jasno i nie wymyślaj danych. "
    "Do pytań „co pilne / czym się dziś zająć / podsumuj sytuację” użyj co_wymaga_uwagi_dzis. "
    "Listy produktów (martwy stan, tracona sprzedaż, top sprzedaż, wolno rotujące) bierz z dedykowanych narzędzi — nie zgaduj. "
    "Do „ile zamówić X” użyj ile_zamowic, do „kiedy przypłynie X” — dostawy_produktu, do „co przypłynie w danym miesiącu” — kontenery_w_oknie. "
    "Firmy/sklepy to AMH (i-coucou), Acti i Veluxa. Gdy pytanie dotyczy jednego sklepu (np. „sprzedaż Veluxy”, „co domówić dla Acti”, „martwy stan Acti”, „stan SZP0 w Acti”), "
    "podaj parametr sklep = amh|acti|veluxa do narzędzi, które go przyjmują. Bez wskazania sklepu liczby są sumą wszystkich. "
    "Gdy użytkownik chce ROZBICIE stanu jednego produktu na firmy naraz („ile SZP0 w Acti a ile w AMH”, „rozdziel stan X per firma”), użyj stan_per_firma. "
    "Do pytań o wartość magazynu, przychód, marżę, koszty i kanały sprzedaży użyj narzędzi finansowych (wartosc_magazynu, finanse_ogolne, finanse_produktu, sprzedaz_wg_kanalu, cashflow). "
    "Do pytań o KONKRETNY miesiąc kalendarzowy (np. „sprzedaż w maju 2026”, „ile zrobiliśmy w lipcu”) użyj finanse_miesiac, a do porównań miesięcy („lipiec vs czerwiec”, „porównaj maj do kwietnia”) — porownaj_miesiace; NIE licz tego z okresów 30/90/365. "
    "Oba przyjmują opcjonalnie sku (jeden produkt) albo producent (jedna marka, np. „sprzedaż Veluxy w lipcu”). "
    "Gdy w pytaniu o miesiąc brakuje roku, przyjmij bieżący rok. "
    "Jeśli narzędzie finansowe zwróci „brak_uprawnien”, powiedz krótko, że użytkownik nie ma dostępu do danych finansowych — nie podawaj żadnych kwot. "
    "Do „czy X sezonowy / kiedy szczyt” użyj sezonowosc, do skoków/spadków sprzedaży — anomalie, do kursu waluty — kurs_waluty. "
    "SKU zapisuj wielkimi literami. Daty podawaj po ludzku (np. „14 lipca”)."
)

TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "pobierz_stan",
            "description": "Aktualny stan magazynowy produktu po SKU: ile sztuk na stanie, ile w drodze, status, producent.",
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. D2B"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": ["sku"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prognoza_wyczerpania",
            "description": ("Prognoza wyczerpania produktu po SKU: za ile dni się skończy, data wyczerpania, "
                            "średnia dzienna sprzedaż, za ile dni i na kiedy trzeba złożyć zamówienie "
                            "(z lead time) oraz co jest już w drodze."),
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. D2B"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": ["sku"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sprzedaz",
            "description": "Sprzedaż produktu po SKU: ostatni miesiąc, 2 i 3 miesiące wstecz oraz średnia miesięczna ważona.",
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. D2B"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": ["sku"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lista_do_zamowienia",
            "description": ("Lista produktów, dla których osiągnięto już punkt zamówienia (trzeba teraz zamówić). "
                            "Opcjonalnie filtruj po nazwie producenta."),
            "parameters": {
                "type": "object",
                "properties": {"producent": {"type": "string", "description": "opcjonalna nazwa producenta do filtra"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kontenery_w_drodze",
            "description": ("Kontenery jeszcze niedostarczone (w drodze / w odprawie celnej), posortowane od najbliższej "
                            "daty ETA. Użyj do pytań: kiedy przypłynie najbliższy kontener, co jest w drodze, kiedy dotrze "
                            "dostawa. Opcjonalnie filtruj po nazwie producenta."),
            "parameters": {
                "type": "object",
                "properties": {"producent": {"type": "string", "description": "opcjonalna nazwa producenta do filtra"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "zawartosc_kontenera",
            "description": ("Zawartość konkretnego kontenera po numerze: lista produktów w środku (SKU, nazwa, ilość). "
                            "Użyj do pytań: co jest w kontenerze, jaki towar/produkty w dostawie."),
            "parameters": {
                "type": "object",
                "properties": {"numer": {"type": "string", "description": "numer kontenera, np. TCKU7064646"}},
                "required": ["numer"],
            },
        },
    },
    # --- PACZKA 1: produkty, dostawy, kontenery (read-only, na gotowych danych) ---
    {
        "type": "function",
        "function": {
            "name": "martwy_stan",
            "description": ("Produkty z martwym stanem (DEAD_STOCK): mają stan magazynowy, ale zero sprzedaży przez ostatnie "
                            "12 miesięcy. Opcjonalnie filtruj po producencie."),
            "parameters": {
                "type": "object",
                "properties": {"producent": {"type": "string", "description": "opcjonalna nazwa producenta do filtra"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "tracone_sprzedaze",
            "description": ("Produkty, które się sprzedają, ale mają zerowy stan (ACTIVE_NO_STOCK) — tracona sprzedaż. "
                            "Pokazuje też najbliższą dostawę, jeśli coś jest w drodze. Opcjonalnie filtruj po producencie."),
            "parameters": {
                "type": "object",
                "properties": {"producent": {"type": "string", "description": "opcjonalna nazwa producenta do filtra"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "top_sprzedaz",
            "description": "Najlepiej sprzedające się produkty (ranking po sprzedaży z ostatnich 30 dni). Domyślnie 10 pozycji.",
            "parameters": {
                "type": "object",
                "properties": {"ile": {"type": "integer", "description": "ile pozycji zwrócić (1-30, domyślnie 10)"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "wolno_rotujace",
            "description": ("Produkty wolno rotujące: mają jakąś sprzedaż, ale bardzo dużo miesięcy zapasu "
                            "(ranking po miesiącach zapasu, malejąco). Domyślnie 10 pozycji."),
            "parameters": {
                "type": "object",
                "properties": {"ile": {"type": "integer", "description": "ile pozycji zwrócić (1-30, domyślnie 10)"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "dostawy_produktu",
            "description": ("Co jest w drodze dla konkretnego produktu (po SKU): w jakich kontenerach, ile sztuk, kiedy ETA. "
                            "Użyj do pytań „kiedy przypłynie X”, „czy X jest w jakimś kontenerze”."),
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. D2B"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": ["sku"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ile_zamowic",
            "description": ("Sugerowana ilość do zamówienia dla produktu (po SKU): pokrycie zapotrzebowania na czas lead time "
                            "minus stan i to, co już w drodze. Mini-PO."),
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. D2B"}, "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}},
                "required": ["sku"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kontenery_w_oknie",
            "description": ("Kontenery z ETA w danym miesiącu (np. „co przypłynie w lipcu”): lista, suma CBM i sztuk w drodze, "
                            "ile w odprawie celnej. Bez podania miesiąca zwraca wszystkie niedostarczone."),
            "parameters": {
                "type": "object",
                "properties": {
                    "miesiac": {"type": "string", "description": "miesiąc: numer 1-12 lub nazwa po polsku, np. „lipiec”"},
                    "rok": {"type": "integer", "description": "opcjonalny rok, np. 2025"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "co_wymaga_uwagi_dzis",
            "description": ("Briefing na dziś: produkty po punkcie zamówienia (trzeba zamówić teraz), produkty kończące się "
                            "w najbliższym czasie oraz kontenery w odprawie celnej. "
                            "Użyj do pytań „czym się dziś zająć”, „co pilne”, „podsumuj sytuację”."),
            "parameters": {"type": "object", "properties": {"sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa — liczby tylko tego sklepu"}}, "required": []},
        },
    },
    # --- PACZKA 3: firmy / sklepy (AMH / Acti / Veluxa) ---
    {
        "type": "function",
        "function": {
            "name": "firmy",
            "description": ("Lista firm/sklepów (AMH = i-coucou, Acti, Veluxa) wraz z liczbą przypisanych produktów. "
                            "Użyj do pytań „jakie mamy sklepy”, „ile towarów ma Veluxa”."),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stan_per_firma",
            "description": ("Rozbicie stanu magazynowego produktu (po SKU) na poszczególne firmy/sklepy: ile sztuk w AMH, ile w Acti, "
                            "ile w Veluxa, oraz razem. Użyj do pytań typu „ile SZP0 jest w Acti a ile w AMH”, „rozdziel stan X per firma”."),
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. SZP0"}},
                "required": ["sku"],
            },
        },
    },
    # --- PACZKA 2: finanse (wymagają uprawnienia viewFinancials) ---
    {
        "type": "function",
        "function": {
            "name": "wartosc_magazynu",
            "description": ("Wartość magazynu w PLN (suma wartości stanu) oraz wartość martwego stanu. "
                            "Opcjonalnie dla jednego sklepu. Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {"sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finanse_ogolne",
            "description": ("Zbiorcze finanse za okres: przychód netto/brutto, koszt, marża, liczba zamówień i sztuk, średnia wartość "
                            "zamówienia, top kanały i top producenci. Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {"okres": {"type": "string", "description": "ytd | 365 | 90 | 30 | prev_year (domyślnie ytd)"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finanse_produktu",
            "description": ("Finanse pojedynczego produktu po SKU za okres: przychód, koszt, marża, sztuki, rotacja/pokrycie stanu, "
                            "podział na kanały. Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {
                    "sku": {"type": "string", "description": "SKU produktu"},
                    "okres": {"type": "string", "description": "ytd | 365 | 90 | 30 | prev_year (domyślnie ytd)"},
                },
                "required": ["sku"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finanse_miesiac",
            "description": ("Finanse za KONKRETNY miesiąc kalendarzowy (np. „sprzedaż w maju 2026”, „ile zrobiliśmy w lipcu”): "
                            "przychód netto/brutto, koszt, marża, sztuki, zamówienia i rozbicie na kanały. "
                            "Bez SKU — całość biznesu; z SKU — jeden produkt. Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {
                    "rok": {"type": "integer", "description": "rok, np. 2026"},
                    "miesiac": {"type": "integer", "description": "miesiąc 1-12 (lub nazwa po polsku, np. „lipiec”)"},
                    "sku": {"type": "string", "description": "opcjonalne SKU — finanse tylko tego produktu"},
                    "producent": {"type": "string", "description": "opcjonalny producent (np. „Veluxa”) — finanse tylko tej marki"},
                },
                "required": ["rok", "miesiac"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "porownaj_miesiace",
            "description": ("Porównuje DWA miesiące kalendarzowe obok siebie z różnicami (Δ zł i %): przychód, marża, koszt, "
                            "sztuki, zamówienia. Do pytań typu „lipiec vs czerwiec”, „porównaj maj do kwietnia”. "
                            "Bez SKU — całość; z SKU — jeden produkt. Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {
                    "rok_a": {"type": "integer", "description": "rok pierwszego (nowszego) miesiąca"},
                    "miesiac_a": {"type": "integer", "description": "pierwszy (nowszy) miesiąc 1-12 lub nazwa po polsku"},
                    "rok_b": {"type": "integer", "description": "rok drugiego (odniesienia) miesiąca"},
                    "miesiac_b": {"type": "integer", "description": "drugi (odniesienia) miesiąc 1-12 lub nazwa po polsku"},
                    "sku": {"type": "string", "description": "opcjonalne SKU — porównanie tylko tego produktu"},
                    "producent": {"type": "string", "description": "opcjonalny producent (np. „Veluxa”) — porównanie tylko tej marki"},
                },
                "required": ["rok_a", "miesiac_a", "rok_b", "miesiac_b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sprzedaz_wg_kanalu",
            "description": ("Udział kanałów sprzedaży (Allegro / Erli / Studio-Bay / Klaudia / I-CC.PL): przychód i sztuki. "
                            "Bez SKU — całość; z SKU — dla jednego produktu. Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {
                    "sku": {"type": "string", "description": "opcjonalne SKU produktu"},
                    "okres": {"type": "string", "description": "ytd | 365 | 90 | 30 | prev_year (domyślnie ytd)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cashflow",
            "description": ("Nadchodzące płatności za kontenery w najbliższych miesiącach (wartość dostaw wg miesiąca ETA). "
                            "Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {"miesiace": {"type": "integer", "description": "ile miesięcy do przodu (domyślnie 6)"}},
                "required": [],
            },
        },
    },
    # --- PACZKA 4: dodatki (anomalie, sezonowość, kursy) ---
    {
        "type": "function",
        "function": {
            "name": "anomalie",
            "description": ("Wykryte anomalie sprzedaży: nagłe skoki, spadki oraz szybki drenaż stanu. "
                            "Opcjonalnie dla jednego sklepu."),
            "parameters": {
                "type": "object",
                "properties": {"sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sezonowosc",
            "description": ("Sezonowość produktu po SKU: sprzedaż w podziale na miesiące (sztuki) i miesiąc szczytu. "
                            "Użyj do pytań „czy X jest sezonowy”, „kiedy szczyt sprzedaży X”."),
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string", "description": "SKU produktu"}},
                "required": ["sku"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kurs_waluty",
            "description": ("Ostatni kurs średni NBP dla waluty (EUR, USD, CZK, HUF) w PLN wraz z datą notowania."),
            "parameters": {
                "type": "object",
                "properties": {"kod": {"type": "string", "description": "kod waluty, np. EUR"}},
                "required": ["kod"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lista_zakupow",
            "description": ("Gotowa lista zakupów pogrupowana po producentach: co i ile zamówić (rekomendowane ilości). "
                            "Opcjonalnie dla jednego sklepu. Ceny zakupu widoczne tylko z uprawnieniem finansowym."),
            "parameters": {
                "type": "object",
                "properties": {"sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa"}},
                "required": [],
            },
        },
    },
    # --- funkcje przekrojowe ---
    {
        "type": "function",
        "function": {
            "name": "szukaj",
            "description": ("Wyszukiwarka produktów po fragmencie nazwy, SKU lub EAN. Użyj gdy użytkownik nie zna dokładnego SKU "
                            "(„znajdź krzesło biurowe”, „produkty z nazwą X”)."),
            "parameters": {
                "type": "object",
                "properties": {"fraza": {"type": "string", "description": "szukany tekst (min. 2 znaki)"}},
                "required": ["fraza"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "swiezosc_danych",
            "description": ("Kiedy ostatnio odświeżono dane (Subiekt, Sellasist itd.) — do pytań „czy dane są aktualne”, "
                            "„kiedy był ostatni sync”."),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "statystyki",
            "description": ("Ogólne liczby magazynu: liczba produktów, produkty ze stanem, liczba zamówień z 12 miesięcy."),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


def _fmt_date(d: Optional[date]) -> Optional[str]:
    return d.strftime("%d.%m.%Y") if isinstance(d, date) else None


def _deliveries(p) -> List[Dict[str, Any]]:
    out = []
    for d in (p.incoming_deliveries or []):
        out.append({
            "data": _fmt_date(getattr(d, "eta_date", None)),
            "ilosc": getattr(d, "quantity", None),
            "kontener": getattr(d, "container_number", None),
        })
    return out


async def _find_product(db: AsyncSession, sku: str, shop: str = ""):
    """Szuka produktu po SKU BEZ względu na wielkość liter. shop='' = wszystkie sklepy (suma);
    'amh'/'acti'/'veluxa' = stan i sprzedaż tylko tego sklepu. Zwraca ProductSummary lub None."""
    target = (sku or "").strip().upper()
    if not target:
        return None
    prods = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"}, shop)
    for p in prods:
        if (p.sku or "").upper() == target:
            return p
    return None


async def _tool_pobierz_stan(db: AsyncSession, user: CurrentUser, sku: str, sklep: Any = None) -> Dict[str, Any]:
    shop = _norm_shop(sklep)
    p = await _find_product(db, sku, shop)
    if not p:
        return {"znaleziono": False, "sku": sku, "sklep": shop or "wszystkie"}
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name,
        "stan": p.stock, "w_drodze": p.stock_in_transit,
        "status": p.status, "producent": p.manufacturer_name,
        "firma_wlasciciel": p.firma_name, "sklep": shop or "wszystkie",
    }


async def _tool_prognoza(db: AsyncSession, user: CurrentUser, sku: str, sklep: Any = None) -> Dict[str, Any]:
    shop = _norm_shop(sklep)
    p = await _find_product(db, sku, shop)
    if not p:
        return {"znaleziono": False, "sku": sku, "sklep": shop or "wszystkie"}
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name, "sklep": shop or "wszystkie",
        "stan": p.stock, "w_drodze": p.stock_in_transit,
        "dni_do_wyczerpania": p.days_until_empty,
        "data_wyczerpania": _fmt_date(p.empty_date),
        "srednia_dzienna_sprzedaz": round((p.avg_monthly_weighted or 0) / 30.0, 2),
        "dni_do_zamowienia": p.days_until_order,
        "data_zamowienia": _fmt_date(p.order_date),
        "lead_time_dni": p.lead_time_days,
        "w_drodze_dostawy": _deliveries(p),
    }


async def _tool_sprzedaz(db: AsyncSession, user: CurrentUser, sku: str, sklep: Any = None) -> Dict[str, Any]:
    shop = _norm_shop(sklep)
    p = await _find_product(db, sku, shop)
    if not p:
        return {"znaleziono": False, "sku": sku, "sklep": shop or "wszystkie"}
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name, "sklep": shop or "wszystkie",
        "sprzedaz_30dni": p.sales_1m, "sprzedaz_60dni": p.sales_2m, "sprzedaz_90dni": p.sales_3m,
        "srednia_miesieczna_wazona": round(p.avg_monthly_weighted or 0, 1),
    }


async def _tool_lista_do_zamowienia(db: AsyncSession, user: CurrentUser, producent: Optional[str] = None, sklep: Any = None) -> Dict[str, Any]:
    prods = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, _norm_shop(sklep))
    items = [p for p in prods if p.days_until_order is not None and p.days_until_order <= 0]
    if producent:
        needle = producent.strip().lower()
        items = [p for p in items if needle in (p.manufacturer_name or "").lower()]
    items.sort(key=lambda p: (p.days_until_empty if p.days_until_empty is not None else 9999))
    rows = [{
        "sku": p.sku, "nazwa": p.name, "stan": p.stock,
        "dni_do_wyczerpania": p.days_until_empty, "producent": p.manufacturer_name,
    } for p in items[:15]]
    return {"liczba": len(items), "pozycje": rows, "filtr_producent": producent}


async def _tool_kontenery_w_drodze(db: AsyncSession, user: CurrentUser, producent: Optional[str] = None) -> Dict[str, Any]:
    conts = await fetch_containers(db)
    upcoming = [c for c in conts if (c.effective_status or "").upper() != "DELIVERED"]
    if producent:
        needle = producent.strip().lower()
        upcoming = [c for c in upcoming if needle in (c.manufacturer_name or "").lower()]
    upcoming.sort(key=lambda c: c.eta_date or date.max)
    rows = [{
        "kontener": c.container_number, "producent": c.manufacturer_name,
        "eta": _fmt_date(c.eta_date), "status": c.effective_status,
        "dni_do_odprawy": c.customs_days_left, "sztuk": c.total_units,
        "cbm": round(c.total_cbm or 0, 2),
    } for c in upcoming[:12]]
    return {"liczba": len(upcoming), "kontenery": rows, "filtr_producent": producent}


async def _tool_zawartosc_kontenera(db: AsyncSession, user: CurrentUser, numer: str) -> Dict[str, Any]:
    target = (numer or "").strip().upper()
    if not target:
        return {"znaleziono": False}
    conts = await fetch_containers(db)
    match = next((c for c in conts if (c.container_number or "").upper() == target), None)
    if not match:
        return {"znaleziono": False, "numer": numer}
    items = [{"sku": it.sku, "nazwa": it.product_name, "ilosc": it.quantity} for it in (match.items or [])]
    return {
        "znaleziono": True, "numer": match.container_number, "producent": match.manufacturer_name,
        "eta": _fmt_date(match.eta_date), "status": match.effective_status,
        "razem_sztuk": match.total_units, "pozycje": items,
    }


# --- PACZKA 1: implementacje ---

def _prod_row(p) -> Dict[str, Any]:
    return {
        "sku": p.sku, "nazwa": p.name, "stan": p.stock,
        "w_drodze": p.stock_in_transit, "producent": p.manufacturer_name,
    }


_SHOP_SLUGS = {
    "amh": "amh", "i-coucou": "amh", "icoucou": "amh", "i coucou": "amh", "i-cc": "amh",
    "acti": "acti", "acti4med": "acti",
    "veluxa": "veluxa",
}


def _norm_shop(val: Any) -> str:
    """Normalizuje nazwę sklepu na slug 'amh'/'acti'/'veluxa'. Puste/nieznane → '' (wszystkie sklepy, suma)."""
    if not val:
        return ""
    return _SHOP_SLUGS.get(str(val).strip().lower(), "")


async def _tool_martwy_stan(db: AsyncSession, user: CurrentUser, producent: Optional[str] = None, sklep: Any = None) -> Dict[str, Any]:
    prods = await fetch_products(db, {"DEAD_STOCK"}, _norm_shop(sklep))
    if producent:
        needle = producent.strip().lower()
        prods = [p for p in prods if needle in (p.manufacturer_name or "").lower()]
    prods.sort(key=lambda p: (p.stock or 0), reverse=True)
    rows = [_prod_row(p) for p in prods[:20]]
    return {"liczba": len(prods), "pozycje": rows, "filtr_producent": producent}


async def _tool_tracone_sprzedaze(db: AsyncSession, user: CurrentUser, producent: Optional[str] = None, sklep: Any = None) -> Dict[str, Any]:
    prods = await fetch_products(db, {"ACTIVE_NO_STOCK"}, _norm_shop(sklep))
    if producent:
        needle = producent.strip().lower()
        prods = [p for p in prods if needle in (p.manufacturer_name or "").lower()]
    prods.sort(key=lambda p: (p.avg_monthly_weighted or 0), reverse=True)
    rows = [{
        "sku": p.sku, "nazwa": p.name, "producent": p.manufacturer_name,
        "srednia_miesieczna": round(p.avg_monthly_weighted or 0, 1),
        "sprzedaz_30dni": p.sales_1m, "w_drodze": p.stock_in_transit,
        "najblizsza_dostawa": (_deliveries(p)[0] if p.incoming_deliveries else None),
    } for p in prods[:20]]
    return {"liczba": len(prods), "pozycje": rows, "filtr_producent": producent}


async def _tool_top_sprzedaz(db: AsyncSession, user: CurrentUser, ile: Any = 10, sklep: Any = None) -> Dict[str, Any]:
    try:
        n = max(1, min(int(ile), 30))
    except (TypeError, ValueError):
        n = 10
    prods = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, _norm_shop(sklep))
    prods.sort(key=lambda p: (p.sales_1m or 0), reverse=True)
    rows = [{
        "sku": p.sku, "nazwa": p.name, "sprzedaz_30dni": p.sales_1m,
        "srednia_miesieczna": round(p.avg_monthly_weighted or 0, 1),
        "stan": p.stock, "miesiecy_zapasu": p.months_of_stock,
    } for p in prods[:n]]
    return {"pozycje": rows}


async def _tool_wolno_rotujace(db: AsyncSession, user: CurrentUser, ile: Any = 10, sklep: Any = None) -> Dict[str, Any]:
    try:
        n = max(1, min(int(ile), 30))
    except (TypeError, ValueError):
        n = 10
    prods = await fetch_products(db, {"ACTIVE"}, _norm_shop(sklep))
    cand = [p for p in prods if (p.avg_monthly_weighted or 0) > 0 and (p.stock or 0) > 0]
    cand.sort(key=lambda p: (p.months_of_stock or 0), reverse=True)
    rows = [{
        "sku": p.sku, "nazwa": p.name, "miesiecy_zapasu": p.months_of_stock,
        "stan": p.stock, "srednia_miesieczna": round(p.avg_monthly_weighted or 0, 1),
        "producent": p.manufacturer_name,
    } for p in cand[:n]]
    return {"pozycje": rows}


async def _tool_dostawy_produktu(db: AsyncSession, user: CurrentUser, sku: str, sklep: Any = None) -> Dict[str, Any]:
    shop = _norm_shop(sklep)
    p = await _find_product(db, sku, shop)
    if not p:
        return {"znaleziono": False, "sku": sku, "sklep": shop or "wszystkie"}
    dost = _deliveries(p)
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name, "sklep": shop or "wszystkie",
        "stan": p.stock, "w_drodze_razem": p.stock_in_transit,
        "liczba_dostaw": len(dost), "dostawy": dost,
    }


async def _tool_ile_zamowic(db: AsyncSession, user: CurrentUser, sku: str, sklep: Any = None) -> Dict[str, Any]:
    shop = _norm_shop(sklep)
    p = await _find_product(db, sku, shop)
    if not p:
        return {"znaleziono": False, "sku": sku, "sklep": shop or "wszystkie"}
    daily = (p.avg_monthly_weighted or 0) / 30.0
    lead = p.lead_time_days or 0
    potrzeba = daily * lead
    dostepne = (p.stock or 0) + (p.stock_in_transit or 0)
    sugestia = max(0, round(potrzeba - dostepne))
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name, "sklep": shop or "wszystkie",
        "stan": p.stock, "w_drodze": p.stock_in_transit,
        "srednia_dzienna_sprzedaz": round(daily, 2), "lead_time_dni": lead,
        "zapotrzebowanie_na_lead_time": round(potrzeba),
        "sugerowana_ilosc": sugestia, "dni_do_zamowienia": p.days_until_order,
    }


_PL_MIES = {
    "stycz": 1, "lut": 2, "mar": 3, "kwie": 4, "maj": 5, "czerw": 6,
    "lip": 7, "sierp": 8, "wrzes": 9, "wrześ": 9, "paźdz": 10, "pazdz": 10,
    "listop": 11, "grud": 12,
}


def _parse_miesiac(val: Any) -> Optional[int]:
    if val is None:
        return None
    s = str(val).strip().lower()
    if not s:
        return None
    if s.isdigit():
        n = int(s)
        return n if 1 <= n <= 12 else None
    for k, n in _PL_MIES.items():
        if s.startswith(k):
            return n
    return None


async def _tool_kontenery_w_oknie(db: AsyncSession, user: CurrentUser, miesiac: Any = None, rok: Any = None) -> Dict[str, Any]:
    conts = await fetch_containers(db)
    upcoming = [c for c in conts if (c.effective_status or "").upper() != "DELIVERED"]
    m = _parse_miesiac(miesiac)
    try:
        y = int(rok) if rok else None
    except (TypeError, ValueError):
        y = None
    if m:
        upcoming = [c for c in upcoming
                    if c.eta_date and c.eta_date.month == m and (y is None or c.eta_date.year == y)]
    upcoming.sort(key=lambda c: c.eta_date or date.max)
    rows = [{
        "kontener": c.container_number, "producent": c.manufacturer_name,
        "eta": _fmt_date(c.eta_date), "status": c.effective_status,
        "sztuk": c.total_units, "cbm": round(c.total_cbm or 0, 2),
    } for c in upcoming[:15]]
    return {
        "liczba": len(upcoming),
        "suma_sztuk": sum((c.total_units or 0) for c in upcoming),
        "suma_cbm": round(sum((c.total_cbm or 0) for c in upcoming), 2),
        "w_odprawie": sum(1 for c in upcoming if (c.effective_status or "").upper() == "CUSTOMS"),
        "filtr_miesiac": m, "filtr_rok": y, "kontenery": rows,
    }


async def _tool_co_wymaga_uwagi_dzis(db: AsyncSession, user: CurrentUser, sklep: Any = None) -> Dict[str, Any]:
    shop = _norm_shop(sklep)
    prods = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, shop)
    do_zamowienia = [p for p in prods if p.days_until_order is not None and p.days_until_order <= 0]
    do_zamowienia.sort(key=lambda p: (p.days_until_empty if p.days_until_empty is not None else 9999))
    konczace = [p for p in prods
                if p.days_until_empty is not None and 0 <= p.days_until_empty <= 14
                and not (p.days_until_order is not None and p.days_until_order <= 0)]
    konczace.sort(key=lambda p: p.days_until_empty)

    conts = await fetch_containers(db)
    w_odprawie = [c for c in conts if (c.effective_status or "").upper() == "CUSTOMS"]
    w_odprawie.sort(key=lambda c: c.eta_date or date.max)

    return {
        "do_zamowienia_teraz": {
            "liczba": len(do_zamowienia),
            "pozycje": [{"sku": p.sku, "nazwa": p.name, "stan": p.stock,
                         "dni_do_wyczerpania": p.days_until_empty} for p in do_zamowienia[:10]],
        },
        "konczy_sie_wkrotce": {
            "liczba": len(konczace),
            "pozycje": [{"sku": p.sku, "nazwa": p.name, "stan": p.stock,
                         "dni_do_wyczerpania": p.days_until_empty} for p in konczace[:10]],
        },
        "kontenery_w_odprawie": {
            "liczba": len(w_odprawie),
            "pozycje": [{"kontener": c.container_number, "producent": c.manufacturer_name,
                         "eta": _fmt_date(c.eta_date), "dni_do_odprawy": c.customs_days_left}
                        for c in w_odprawie[:10]],
        },
    }


# --- PACZKA 2/3/4: firmy, finanse, dodatki, funkcje przekrojowe ---

_FIN_OKRESY = {"ytd", "365", "90", "30", "prev_year"}
_MIES_PL = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec",
            "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"]


def _brak_uprawnien() -> Dict[str, Any]:
    return {"brak_uprawnien": True, "komunikat": "Użytkownik nie ma uprawnień do danych finansowych (viewFinancials)."}


def _okres(val: Any) -> str:
    p = str(val).strip().lower() if val else "ytd"
    return p if p in _FIN_OKRESY else "ytd"


async def _tool_firmy(db: AsyncSession, user: CurrentUser) -> Dict[str, Any]:
    from routers.firmy import list_firmy
    firmy = await list_firmy(db=db, user=user)
    return {"firmy": [{
        "nazwa": f.name, "slug": f.slug, "liczba_produktow": f.product_count,
        "skonfigurowana": f.configured,
    } for f in firmy]}


async def _tool_stan_per_firma(db: AsyncSession, user: CurrentUser, sku: str) -> Dict[str, Any]:
    """Rozbija stan SKU po firmach. Uwaga: 'w drodze' (kontenery/import) nie jest per-sklep —
    liczone tak samo w każdym wywołaniu (import = AMH), więc pokazujemy je raz, nie per firma."""
    symbol = (sku or "").strip().upper()
    if not symbol:
        return {"znaleziono": False}
    rows = (await db.execute(text(
        f"SELECT slug, name FROM {settings.TABLE_FIRMY} ORDER BY sort_order, id"
    ))).mappings().all()
    firmy_list = [(r["slug"], r["name"]) for r in rows if r["slug"]] or \
                 [("amh", "AMH"), ("acti", "Acti"), ("veluxa", "Veluxa")]
    nazwa = None
    w_drodze = 0
    rozklad = []
    razem = 0
    for slug, fname in firmy_list:
        p = await _find_product(db, symbol, slug)
        stan = (p.stock if p else 0) or 0
        if p:
            if nazwa is None:
                nazwa = p.name
            w_drodze = p.stock_in_transit or 0   # ta sama wartość w każdym wywołaniu (nie sumujemy)
        rozklad.append({"firma": fname, "slug": slug, "stan": stan})
        razem += stan
    if nazwa is None:
        return {"znaleziono": False, "sku": symbol}
    return {
        "znaleziono": True, "sku": symbol, "nazwa": nazwa,
        "rozklad_per_firma": rozklad, "razem_stan": razem, "w_drodze_razem": w_drodze,
    }


async def _tool_wartosc_magazynu(db: AsyncSession, user: CurrentUser, sklep: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "viewFinancials"):
        return _brak_uprawnien()
    shop = _norm_shop(sklep)
    prods = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"}, shop)
    total = round(sum((p.stock_value or 0) for p in prods), 2)
    dead = round(sum((p.stock_value or 0) for p in prods if p.product_status == "DEAD_STOCK"), 2)
    return {"waluta": "PLN", "wartosc_magazynu": total, "wartosc_martwego_stanu": dead,
            "sklep": shop or "wszystkie"}


async def _tool_finanse_ogolne(db: AsyncSession, user: CurrentUser, okres: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "viewFinancials"):
        return _brak_uprawnien()
    from routers.finance import finance_overview
    ov = (await finance_overview(period=_okres(okres), db=db, user=user)).model_dump(mode="json")
    k = ov.get("kpi", {})
    return {
        "okres": ov.get("period_label"), "waluta": ov.get("currency"),
        "przychod_netto": k.get("revenue_net"), "przychod_brutto": k.get("revenue_gross"),
        "koszt": k.get("cost"), "marza": k.get("margin"), "marza_proc": k.get("margin_pct"),
        "zamowienia": k.get("orders"), "sztuki": k.get("units"), "srednia_wartosc_zamowienia": k.get("aov_net"),
        "top_kanaly": [{"kanal": c["channel"], "przychod_netto": c["revenue_net"], "udzial_proc": c["share_pct"]}
                       for c in ov.get("channels", [])[:6]],
        "top_producenci": [{"producent": m["name"], "przychod_netto": m["revenue_net"], "marza_proc": m["margin_pct"]}
                           for m in ov.get("manufacturers", [])[:6]],
        "pozycje_bez_kosztu": ov.get("items_without_cost"),
    }


async def _tool_finanse_produktu(db: AsyncSession, user: CurrentUser, sku: str, okres: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "viewFinancials"):
        return _brak_uprawnien()
    from fastapi import HTTPException
    from routers.finance import finance_product
    symbol = (sku or "").strip().upper()
    if not symbol:
        return {"znaleziono": False}
    try:
        fp = (await finance_product(symbol=symbol, period=_okres(okres), db=db, user=user)).model_dump(mode="json")
    except HTTPException as e:
        if getattr(e, "status_code", None) == 404:
            return {"znaleziono": False, "sku": symbol}
        raise
    info, k, rot = fp.get("info", {}), fp.get("kpi", {}), fp.get("rotation", {})
    return {
        "znaleziono": True, "sku": info.get("symbol"), "nazwa": info.get("name"), "okres": fp.get("period_label"),
        "przychod_netto": k.get("revenue_net"), "koszt": k.get("cost"), "marza": k.get("margin"),
        "marza_proc": k.get("margin_pct"), "sztuki": k.get("units"), "zamowienia": k.get("orders"),
        "srednia_cena_netto": k.get("avg_price_net"), "koszt_jedn": k.get("unit_cost"), "marza_jedn": k.get("unit_margin"),
        "pokrycie_dni": rot.get("days_of_cover"), "srednio_mies_szt": rot.get("avg_monthly_units"),
        "kanaly": [{"kanal": c["channel"], "sztuki": c["units"], "przychod_netto": c["revenue_net"], "udzial_proc": c["share_pct"]}
                   for c in fp.get("channels", [])[:6]],
    }


async def _tool_sprzedaz_wg_kanalu(db: AsyncSession, user: CurrentUser, sku: Optional[str] = None, okres: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "viewFinancials"):
        return _brak_uprawnien()
    period = _okres(okres)
    if sku:
        fp = await _tool_finanse_produktu(db, user, sku, period)
        if not fp.get("znaleziono", True):
            return fp
        return {"sku": fp.get("sku"), "okres": fp.get("okres"), "kanaly": fp.get("kanaly", [])}
    from routers.finance import finance_overview
    ov = (await finance_overview(period=period, db=db, user=user)).model_dump(mode="json")
    return {"okres": ov.get("period_label"),
            "kanaly": [{"kanal": c["channel"], "przychod_netto": c["revenue_net"], "sztuki": c["units"], "udzial_proc": c["share_pct"]}
                       for c in ov.get("channels", [])]}


async def _tool_cashflow(db: AsyncSession, user: CurrentUser, miesiace: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "viewFinancials"):
        return _brak_uprawnien()
    from routers.calendar import cashflow
    try:
        m = max(1, min(int(miesiace), 24)) if miesiace else 6
    except (TypeError, ValueError):
        m = 6
    cf = await cashflow(months=m, db=db, user=user)
    months = cf.get("months", []) if isinstance(cf, dict) else []
    return {
        "waluta": "PLN",
        "razem": (cf.get("total") if isinstance(cf, dict) else None),
        "miesiace": [{"miesiac": mm.get("label"), "kwota": mm.get("total"),
                      "liczba_kontenerow": len(mm.get("containers", []))} for mm in months],
    }


async def _tool_anomalie(db: AsyncSession, user: CurrentUser, sklep: Any = None) -> Dict[str, Any]:
    from routers.anomalies import detect_anomalies
    shop = _norm_shop(sklep)
    an = await detect_anomalies(shop=shop, db=db)
    rows = [a.model_dump(mode="json") for a in an]
    out = [{"sku": a["sku"], "nazwa": a["name"], "waga": a["severity"], "typ": a["type"],
            "opis": a["message"], "zmiana_proc": a["change_pct"]} for a in rows]
    return {"liczba": len(out), "anomalie": out, "sklep": shop or "wszystkie"}


async def _tool_sezonowosc(db: AsyncSession, user: CurrentUser, sku: str) -> Dict[str, Any]:
    from routers.manufacturers import product_sales_season
    symbol = (sku or "").strip()
    if not symbol:
        return {"znaleziono": False}
    pts = await product_sales_season(sku=symbol, db=db, user=user)
    if not pts:
        return {"znaleziono": False, "sku": symbol.upper()}
    agg: Dict[int, int] = {}
    for p in pts:
        d = p.model_dump()
        m = int(d.get("month") or 0)
        agg[m] = agg.get(m, 0) + int(d.get("qty") or 0)
    total = sum(agg.values())
    szczyt = max(range(12), key=lambda m: agg.get(m, 0)) if total > 0 else None
    return {
        "znaleziono": True, "sku": symbol.upper(), "razem_sztuk": total,
        "miesiac_szczytu": (_MIES_PL[szczyt] if szczyt is not None else None),
        "wg_miesiaca": [{"miesiac": _MIES_PL[m], "sztuki": agg.get(m, 0)} for m in range(12)],
    }


async def _tool_kurs_waluty(db: AsyncSession, user: CurrentUser, kod: str) -> Dict[str, Any]:
    cur = (kod or "").strip().upper()
    if not cur:
        return {"znaleziono": False}
    row = (await db.execute(text(
        f"SELECT rate_date, mid FROM {settings.TABLE_FX_RATES} WHERE currency = :c ORDER BY rate_date DESC LIMIT 1"
    ), {"c": cur})).mappings().first()
    if not row:
        return {"znaleziono": False, "waluta": cur}
    return {"znaleziono": True, "waluta": cur, "kurs_pln": float(row["mid"]),
            "data": row["rate_date"].isoformat() if row["rate_date"] else None}


async def _tool_lista_zakupow(db: AsyncSession, user: CurrentUser, sklep: Any = None) -> Dict[str, Any]:
    from routers.anomalies import shopping_list
    shop = _norm_shop(sklep)
    groups = await shopping_list(shop=shop, db=db)
    can_fin = has_perm(user, "viewFinancials")
    out = []
    for g in groups:
        gd = g if isinstance(g, dict) else {}
        prods = []
        for p in gd.get("products", []):
            row = {"sku": p.get("sku"), "nazwa": p.get("name"), "stan": p.get("stock"),
                   "rekomendowana_ilosc": p.get("recommended_quantity"), "dni_do_wyczerpania": p.get("days_until_empty")}
            if can_fin:
                row["cena_zakupu"] = p.get("purchase_price")
            prods.append(row)
        out.append({"producent": gd.get("manufacturer_name"), "liczba_pozycji": len(prods), "produkty": prods[:15]})
    return {"grupy": out, "sklep": shop or "wszystkie", "ceny_ukryte": (not can_fin)}


async def _tool_szukaj(db: AsyncSession, user: CurrentUser, fraza: str) -> Dict[str, Any]:
    from routers.tools import search_global
    q = (fraza or "").strip()
    if len(q) < 2:
        return {"wyniki": [], "komunikat": "Podaj co najmniej 2 znaki."}
    res = await search_global(q=q, include_inactive=False, db=db)
    prod = [{"sku": r.get("sku"), "nazwa": r.get("name"), "stan": r.get("stock"),
             "producent": r.get("manufacturer_name")} for r in (res.get("products") or [])[:15]]
    ean = [{"sku": r.get("sku"), "nazwa": r.get("name"), "ean": r.get("ean")}
           for r in (res.get("ean") or [])[:10]]
    return {"liczba": len(prod) + len(ean), "produkty": prod, "po_ean": ean}


async def _tool_swiezosc_danych(db: AsyncSession, user: CurrentUser) -> Dict[str, Any]:
    from routers.sync import data_freshness
    fresh = await data_freshness(db=db, user=user)
    src = fresh if isinstance(fresh, dict) else {}
    return {"zrodla": {k: {"ostatnia_aktualizacja": v.get("last"), "liczba": v.get("count")}
                       for k, v in src.items() if isinstance(v, dict)}}


async def _tool_statystyki(db: AsyncSession, user: CurrentUser) -> Dict[str, Any]:
    from routers.meta import stats
    s = await stats(db=db)
    s = s if isinstance(s, dict) else {}
    return {
        "liczba_produktow": s.get("total_products"),
        "produkty_ze_stanem": s.get("products_with_stock"),
        "zamowienia_12m": s.get("orders_last_12m"),
    }


def _parse_rok(val: Any) -> Optional[int]:
    try:
        n = int(str(val).strip())
    except (TypeError, ValueError):
        return None
    return n if 2000 <= n <= 2100 else None


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


async def _tool_finanse_miesiac(db: AsyncSession, user: CurrentUser, rok: Any = None,
                                miesiac: Any = None, sku: Optional[str] = None,
                                producent: Optional[str] = None) -> Dict[str, Any]:
    if not has_perm(user, "viewFinancials"):
        return _brak_uprawnien()
    from routers.finance import month_finance
    r, m = _parse_rok(rok), _parse_miesiac(miesiac)
    if r is None or m is None:
        return {"blad": "podaj rok (np. 2026) i miesiąc (1-12 lub nazwa po polsku, np. „lipiec”)"}
    sym = (str(sku).strip().upper() or None) if sku else None
    prod = (str(producent).strip() or None) if producent else None
    return await month_finance(db, r, m, symbol=sym, producent=prod)


async def _tool_porownaj_miesiace(db: AsyncSession, user: CurrentUser, rok_a: Any = None, miesiac_a: Any = None,
                                  rok_b: Any = None, miesiac_b: Any = None, sku: Optional[str] = None,
                                  producent: Optional[str] = None) -> Dict[str, Any]:
    if not has_perm(user, "viewFinancials"):
        return _brak_uprawnien()
    from routers.finance import month_finance
    ra, ma = _parse_rok(rok_a), _parse_miesiac(miesiac_a)
    rb, mb = _parse_rok(rok_b), _parse_miesiac(miesiac_b)
    if None in (ra, ma, rb, mb):
        return {"blad": "podaj oba miesiące: rok_a+miesiac_a oraz rok_b+miesiac_b (miesiąc 1-12 lub nazwa)"}
    sym = (str(sku).strip().upper() or None) if sku else None
    prod = (str(producent).strip() or None) if producent else None
    a = await month_finance(db, ra, ma, symbol=sym, producent=prod)
    b = await month_finance(db, rb, mb, symbol=sym, producent=prod)

    def diff(key: str) -> Dict[str, Any]:
        va, vb = _num(a.get(key)), _num(b.get(key))
        d = round(va - vb, 2)
        return {"a": va, "b": vb, "roznica": d, "zmiana_proc": (round(d / vb * 100.0, 1) if vb else None)}

    return {
        "a": a, "b": b,
        "roznica": {
            "przychod_netto": diff("przychod_netto"),
            "marza": diff("marza"),
            "marza_proc": diff("marza_proc"),
            "koszt": diff("koszt"),
            "sztuki": diff("sztuki"),
            "zamowienia": diff("zamowienia"),
        },
    }


_DISPATCH = {
    "pobierz_stan": _tool_pobierz_stan,
    "prognoza_wyczerpania": _tool_prognoza,
    "sprzedaz": _tool_sprzedaz,
    "lista_do_zamowienia": _tool_lista_do_zamowienia,
    "kontenery_w_drodze": _tool_kontenery_w_drodze,
    "zawartosc_kontenera": _tool_zawartosc_kontenera,
    # PACZKA 1
    "martwy_stan": _tool_martwy_stan,
    "tracone_sprzedaze": _tool_tracone_sprzedaze,
    "top_sprzedaz": _tool_top_sprzedaz,
    "wolno_rotujace": _tool_wolno_rotujace,
    "dostawy_produktu": _tool_dostawy_produktu,
    "ile_zamowic": _tool_ile_zamowic,
    "kontenery_w_oknie": _tool_kontenery_w_oknie,
    "co_wymaga_uwagi_dzis": _tool_co_wymaga_uwagi_dzis,
    # PACZKA 3 — firmy/sklepy
    "firmy": _tool_firmy,
    "stan_per_firma": _tool_stan_per_firma,
    # PACZKA 2 — finanse (viewFinancials)
    "wartosc_magazynu": _tool_wartosc_magazynu,
    "finanse_ogolne": _tool_finanse_ogolne,
    "finanse_produktu": _tool_finanse_produktu,
    "finanse_miesiac": _tool_finanse_miesiac,
    "porownaj_miesiace": _tool_porownaj_miesiace,
    "sprzedaz_wg_kanalu": _tool_sprzedaz_wg_kanalu,
    "cashflow": _tool_cashflow,
    # PACZKA 4 — dodatki
    "anomalie": _tool_anomalie,
    "sezonowosc": _tool_sezonowosc,
    "kurs_waluty": _tool_kurs_waluty,
    "lista_zakupow": _tool_lista_zakupow,
    # przekrojowe
    "szukaj": _tool_szukaj,
    "swiezosc_danych": _tool_swiezosc_danych,
    "statystyki": _tool_statystyki,
}


async def _dispatch_tool(db: AsyncSession, user: CurrentUser, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    fn = _DISPATCH.get(name)
    if not fn:
        return {"blad": f"nieznane narzędzie: {name}"}
    try:
        return await fn(db, user, **(args or {}))
    except TypeError:
        return {"blad": f"złe argumenty dla {name}: {args}"}
    except Exception as e:  # narzędzie nie może wywalić całej tury
        return {"blad": f"narzędzie {name} nie zadziałało: {e}"}


def _llm_request(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Synchroniczne wywołanie endpointu /chat/completions (zgodny z OpenAI).
    Uruchamiane w wątku przez asyncio.to_thread, żeby nie blokować pętli zdarzeń."""
    url = settings.LLM_BASE_URL.rstrip("/") + "/chat/completions"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {settings.LLM_API_KEY}")
    # Cloudflare przed api.groq.com blokuje domyślne UA urllib (błąd 1010) — podajemy przeglądarkowe.
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def _llm_call(messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    payload = {
        "model": settings.LLM_MODEL,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0.2,
        "max_tokens": 600,
    }
    try:
        return await asyncio.to_thread(_llm_request, payload)
    except urllib.error.HTTPError as e:
        if e.code == 429:                       # limit darmowego tieru — jedna próba ponowienia
            await asyncio.sleep(2.5)
            return await asyncio.to_thread(_llm_request, payload)
        raise


async def run_chat(db: AsyncSession, user: CurrentUser, history: List[Dict[str, str]]) -> Dict[str, Any]:
    """Pełna tura: system prompt + historia → pętla tool-callingu → odpowiedź po polsku.
    Zwraca {answer, tools} gdzie tools to lista odpalonych narzędzi (do chipów w UI)."""
    messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history:
        role = m.get("role")
        if role in ("user", "assistant") and m.get("content"):
            messages.append({"role": role, "content": m["content"]})

    # treść ostatniego pytania użytkownika + akumulatory tokenów (do licznika kosztów)
    user_q = next((m.get("content", "") for m in reversed(history)
                   if m.get("role") == "user"), "")
    usage_in = usage_out = rounds = 0

    tools_used: List[Dict[str, Any]] = []
    try:
        for _ in range(MAX_ROUNDS):
            try:
                data = await _llm_call(messages)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    return {"answer": "Asystent jest chwilowo przeciążony (limit zapytań) — spróbuj za chwilę.", "tools": tools_used}
                detail = ""
                try:
                    detail = e.read().decode("utf-8")[:300]
                except Exception:
                    pass
                return {"answer": f"Błąd modelu (HTTP {e.code}). {detail}", "tools": tools_used}
            except urllib.error.URLError as e:
                return {"answer": f"Nie mogę połączyć się z modelem ({e.reason}).", "tools": tools_used}
            except Exception as e:
                return {"answer": f"Asystent napotkał problem: {e}", "tools": tools_used}

            u = data.get("usage") or {}
            usage_in  += u.get("prompt_tokens", 0) or 0
            usage_out += u.get("completion_tokens", 0) or 0
            rounds    += 1

            choices = data.get("choices") or []
            if not choices:
                return {"answer": "Model nie zwrócił odpowiedzi.", "tools": tools_used}
            msg = choices[0].get("message") or {}
            tool_calls = msg.get("tool_calls") or []

            if not tool_calls:
                return {"answer": (msg.get("content") or "").strip() or "(brak odpowiedzi)", "tools": tools_used}

            # dołącz wiadomość asystenta z żądaniami narzędzi (round-trip wymaga jej obecności)
            messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": tool_calls})
            for tc in tool_calls:
                fn = (tc.get("function") or {})
                name = fn.get("name") or ""
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                if not isinstance(args, dict):    # Llama bywa wysyła arguments: "null" → None; narzędzia i odpowiedź wymagają dict
                    args = {}
                result = await _dispatch_tool(db, user, name, args)
                tools_used.append({"name": name, "args": args})
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id"),
                    "content": json.dumps(result, ensure_ascii=False, default=str),
                })

        return {"answer": "Za dużo kroków — przerwałem, żeby nie zapętlić. Spróbuj zapytać prościej.", "tools": tools_used}
    finally:
        # Log zużycia na KAŻDEJ ścieżce wyjścia (sukces, błąd modelu/sieci, wyczerpanie rundek),
        # o ile jakiekolwiek tokeny zostały zużyte — żeby licznik nie rozjeżdżał się z realnym kontem.
        # Logowanie nie może wywalić odpowiedzi, więc łapiemy wszystko.
        if rounds > 0:
            try:
                await log_usage(db, query=user_q, model=settings.LLM_MODEL,
                                tin=usage_in, tout=usage_out, rounds=rounds)
            except Exception:
                pass
