"""Asystent AI magazynu — provider-agnostyczny (endpoint zgodny z OpenAI).

Zasada: model NIGDY nie wymyśla liczb. Na pytanie po polsku wybiera narzędzie
(tool calling), nasz backend liczy realne dane z Supabase, a model tylko ubiera
wynik w zdanie. Dostawcę (Groq / Gemini / Ollama / Anthropic) ustawiamy zmiennymi
LLM_BASE_URL / LLM_API_KEY / LLM_MODEL — bez ruszania kodu.

Narzędzia finansowe respektują uprawnienie assistantFinancials (osobne od viewFinancials,
które steruje widocznością finansów w UI) — dzięki temu ktoś może widzieć PLN w interfejsie,
a mimo to nie pytać o finanse asystenta.
"""
from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from config import included_status_clause
from config import sales_channel_case
from models import CurrentUser
from security import has_perm
from services.products import fetch_products
from services.containers import fetch_containers
from services.usage import log_usage

MAX_ROUNDS = 4            # ile razy max model może poprosić o narzędzie w jednej turze
LLM_TIMEOUT = 30          # sekundy na pojedyncze wywołanie LLM

# Prompt rozbity na 3 części: BAZA (magazyn — dla wszystkich), FINANSE (tylko assistantFinancials — nie
# doklejamy osobom bez uprawnień, oszczędza tokeny) i OGON (formatowanie). Montaż w run_chat.
_PROMPT_BASE = (
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
    "Do „czy X sezonowy / kiedy szczyt” użyj sezonowosc, do skoków/spadków sprzedaży — anomalie, do kursu waluty — kurs_waluty. "
    "PYTANIE O STAN („ile mamy X”, „stan X”, „ile jest X”): NATYCHMIAST wywołaj pobierz_stan z podanym tokenem jako sku (dokładne SKU, wielkość liter bez znaczenia). "
    "NIE pytaj „co to jest / czy to fragment / które chodzi”, NIE używaj najpierw szukaj — nawet gdy token jest krótki. Dopiero gdy pobierz_stan zwróci znaleziono=false, użyj szukaj lub dopytaj. "
    "STAN PRODUKTU ma TRZY osobne liczby — rozróżniaj je i nigdy nie myl. Prezentuj je jako trzy osobne, wyraźnie nazwane pozycje: "
    "„Na stanie” (fizycznie w magazynie), „Magazyn w drodze” (wbite do drugiego magazynu w ERP, już w transporcie) oraz „W kontenerach” "
    "(jeszcze niewbite, płyną w kontenerach). Pole w_drodze_razem to suma dwóch ostatnich — NIE jest to osobna czwarta liczba. "
    "NIGDY nie wrzucaj sztuk „w kontenerach” pod etykietę „w drodze” — to DWIE różne rzeczy (magazyn w drodze vs kontenery). "
    "NIE twórz pozycji „razem dostępne” sumującej stan z kontenerami — towar w kontenerach jeszcze nie dotarł, więc nie jest dostępny. "
    "Jeśli magazyn_w_drodze = 0, a w_kontenerach > 0, powiedz wprost: w magazynie w drodze nic nie ma, sztuki płyną w kontenerach (podaj najbliższą dostawę). "
    "STAN A FIRMA: gdy użytkownik pyta o stan i NIE wskazał sklepu, NIE dodawaj parametru sklep — pobierz_stan zwróci na_stanie_razem, per_firma (on-hand rozbity po firmach) oraz firma_wlasciciel. "
    "firma_wlasciciel to firma-matka produktu; magazyn w drodze i kontenery NALEŻĄ do właściciela, nawet jeśli więcej sztuk on-hand leży w innej firmie (np. produkt Veluxy z zapasem w AMH — kontenery i tak są Veluxy). "
    "Podaj stan razem z rozbiciem per firma, wskaż właściciela, a magazyn w drodze i kontenery pokaż z jego danych. Nie zakładaj, że produkt jest w AMH — właściciel wynika z firma_wlasciciel. "
)

_PROMPT_FINANCE = (
    "Do pytań o wartość magazynu, przychód, marżę, koszty i kanały sprzedaży użyj narzędzi finansowych (wartosc_magazynu, finanse_ogolne, finanse_produktu, sprzedaz_wg_kanalu). "
    "PŁATNOŚCI ZA KONTENERY to INNY temat niż sprzedaż — nie licz ich z narzędzi sprzedażowych. „Ile do zapłaty / ile jeszcze zostało do zapłacenia” (otwarte zaliczki i balance, bucket po TERMINIE płatności, np. „ile do zapłaty w sierpniu i za jakich producentów”) → do_zaplaty. "
    "„Ile już zapłaciliśmy / ile wypłaciliśmy w danym miesiącu / ile zapłaciliśmy producentowi X” (realny wypływ kasy, bucket po dacie wpłaty) → zaplacono_kontenery. Płatności JEDNEGO kontenera lub zamówienia (PO) — „ile zostało za kontener TCKU…” → platnosci_kontenera. "
    "Zbiorczy stan „ile mam zamrożone w towarze / wartość magazynu / ile zostało do zapłaty za cały magazyn w drodze” → kapital_w_towarze. "
    "do_zaplaty i zaplacono_kontenery zwracają też pole kontenery (numer, PO, producent, termin/data, kwota) — na pytania „lista/które kontenery do opłacenia w sierpniu” podaj numery z tej listy, NIE odmawiaj i nie odsyłaj do sprawdzania po jednym. "
    "Do pytań o KONKRETNY miesiąc kalendarzowy (np. „sprzedaż w maju 2026”, „ile zrobiliśmy w lipcu”) użyj finanse_miesiac, a do porównań miesięcy („lipiec vs czerwiec”, „porównaj maj do kwietnia”) — porownaj_miesiace; NIE licz tego z okresów 30/90/365. "
    "Do sprzedaży za KONKRETNY DZIEŃ, TYDZIEŃ lub dowolny przedział dat („wczoraj”, „ten tydzień”, „od 1 do 7 lipca”) użyj finanse_zakres(od, do) w formacie RRRR-MM-DD — dla jednego dnia „do” pomiń. "
    "Gdy finanse_zakres zwróci swieze=true, ZAWSZE prowadź odpowiedź LICZBĄ WSZYSTKICH zamówień (pole zamowien_razem) i wartością brutto wszystkich, a przychód netto/marżę podaj jako "
    "„zrealizowane do tej pory” z jednym zdaniem, że reszta paczek jest jeszcze w drodze i kwoty urosną. NIGDY nie podawaj zamowienia_zrealizowane jako „liczby zamówień” — to tylko doręczone. "
    "Narzędzia finansowe za okres mają opcjonalne filtry: sklep (amh|acti|veluxa), producent (marka mebli) i sku (jeden produkt). "
    "AMH, Acti i Veluxa to SKLEPY — podawaj je w parametrze sklep, NIGDY w producent. Bez sklepu = suma wszystkich sklepów (cała firma). "
    "„Sprzedaż AMH za maj” → finanse_miesiac(rok=2026, miesiac=5, sklep='amh'). „Porównaj Acti lipiec do czerwca” → porownaj_miesiace(..., sklep='acti'). "
    "UWAGA — sprzedaż z narzędzi finansowych to ZREALIZOWANA sprzedaż (tylko statusy doręczone). Do LICZBY zamówień danego dnia, podziału po statusie, "
    "opłacone/nieopłacone i liczby pobrań (COD) użyj zamowienia_wg_statusu(data_od, sklep). Różnica między liczbą zamówień a „sprzedażą” jest normalna (statusy). "
    "PORÓWNYWANIE/PODSUMOWANIE DNI: dla dni/zakresów z ostatnich 14 dni (pole swieze=true) prowadź po LICZBIE zamówień i wartości brutto wszystkich, "
    "NIGDY nie mów „X razy więcej” na podstawie zrealizowanych — bo świeże dni mają jeszcze paczki w trasie, statusy się nie ustały. Dodaj krótką notkę: "
    "„do 14 dni wstecz porównuję po liczbie zamówień, powyżej — kwotowo”. Dla zakresów starszych niż 14 dni (swieze=false) podsumowuj kwotowo (zrealizowane netto/marża). "
    "Płatności z zamowienia_wg_statusu są już rozłączne i poprawne: opłacone (z Klaudią jako opłaconą), nieopłacone (bez Klaudii i bez pobrań), pobrania_cod osobno — używaj tych pól wprost. "
    "FORMAT PORÓWNAŃ (WAŻNE): NIGDY nie używaj tabel markdown ani układów wielokolumnowych — okno czatu jest wąskie (telefon) i tabele są nieczytelne. "
    "Zamiast tego podaj najpierw WSZYSTKIE liczby pierwszego okresu (nagłówek + każda metryka w osobnej linii), potem osobnym blokiem drugi okres, a NA KOŃCU krótki blok „Różnice” "
    "z wartością i procentem zmiany na metrykę. Krótkie linie, bez pionowych kresek i bez poziomych linii oddzielających. "
    "Gdy wynik ma koszt_niepewny=true (Acti/Veluxa), zastrzeż, że marża i koszt mogą być zawyżone (ceny zakupu z Subiektu AMH). "
    "Jeśli narzędzie zwróci producent_nieznany, nie mów „zero sprzedaży” — powiedz, że nie znasz takiej marki i policz bez tego filtra. "
    "Gdy w pytaniu o miesiąc/okres brakuje roku, przyjmij bieżący rok. "
)

_PROMPT_TAIL = "SKU zapisuj wielkimi literami. Daty podawaj po ludzku (np. „14 lipca”)."

TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "pobierz_stan",
            "description": ("Aktualny stan magazynowy produktu po DOKŁADNYM SKU (1:1, bez względu na wielkość liter): na stanie (razem + per firma), "
                            "magazyn w drodze, w kontenerach, najbliższa dostawa, właściciel, status, producent. Krótki token typu „szp1”, „d2b” to SKU — "
                            "podaj go tu wprost. To PIERWSZE narzędzie przy pytaniu „ile mamy X / stan X”. Nie dopytuj i nie używaj szukaj, dopóki to nie zwróci znaleziono=false."),
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
    # --- PACZKA 2: finanse (wymagają uprawnienia assistantFinancials) ---
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
                    "sklep": {"type": "string", "description": "opcjonalny sklep: amh | acti | veluxa (bez tego = wszystkie sklepy razem)"},
                    "producent": {"type": "string", "description": "opcjonalna marka/producent mebli (to NIE sklep) — finanse tylko tej marki"},
                    "sku": {"type": "string", "description": "opcjonalne SKU — finanse tylko tego produktu"},
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
                    "sklep": {"type": "string", "description": "opcjonalny sklep: amh | acti | veluxa (bez tego = wszystkie sklepy razem)"},
                    "producent": {"type": "string", "description": "opcjonalna marka/producent mebli (to NIE sklep) — porównanie tylko tej marki"},
                    "sku": {"type": "string", "description": "opcjonalne SKU — porównanie tylko tego produktu"},
                },
                "required": ["rok_a", "miesiac_a", "rok_b", "miesiac_b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "finanse_zakres",
            "description": ("Finanse za KONKRETNY DZIEŃ, TYDZIEŃ lub dowolny przedział dat (np. „sprzedaż wczoraj”, "
                            "„ten tydzień”, „od 1 do 7 lipca”): przychód, koszt, marża, sztuki, zamówienia, kanały. "
                            "Daty w formacie RRRR-MM-DD; dla jednego dnia „do” pomiń. Te same filtry sklep/producent/sku. "
                            "Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {
                    "od": {"type": "string", "description": "data początkowa RRRR-MM-DD (włącznie)"},
                    "do": {"type": "string", "description": "data końcowa RRRR-MM-DD (włącznie); pomiń dla pojedynczego dnia"},
                    "sklep": {"type": "string", "description": "opcjonalny sklep: amh | acti | veluxa (bez tego = wszystkie razem)"},
                    "producent": {"type": "string", "description": "opcjonalna marka/producent mebli (to NIE sklep)"},
                    "sku": {"type": "string", "description": "opcjonalne SKU — tylko ten produkt"},
                },
                "required": ["od"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sprzedaz_wg_kanalu",
            "description": ("Udział kanałów sprzedaży (Allegro / Erli / Studio-Bay / Klaudia / własny sklep: I-CC.PL dla AMH, Veluxa.eu dla Veluxa, Acti4med.pl dla Acti): przychód i sztuki. "
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
            "name": "do_zaplaty",
            "description": ("Ile ZOSTAŁO DO ZAPŁATY za kontenery: otwarte (niezapłacone) zaliczki i balance. Zwraca sumy per producent "
                            "i per miesiąc ORAZ listę konkretnych KONTENERÓW (numer, PO, producent, termin, kwota) — użyj jej do pytań "
                            "„lista/które kontenery do opłacenia w sierpniu”. Bucket po TERMINIE płatności. Do pytań „ile do zapłaty w sierpniu "
                            "i za jakich producentów”, „co mamy otwarte bez ustalonego terminu”, „ile do zapłaty w najbliższych 30 dniach”. "
                            "Kwoty w walutach obcych to szacunek po dzisiejszym kursie (dokładny kurs będzie znany dopiero w dniu wpłaty). "
                            "Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {
                    "miesiac": {"type": "string", "description": "opcjonalny miesiąc terminu płatności: 1-12 lub nazwa po polsku, np. „sierpień”"},
                    "rok": {"type": "integer", "description": "opcjonalny rok terminu, np. 2026 (domyślnie bieżący, gdy podano miesiąc)"},
                    "producent": {"type": "string", "description": "opcjonalna marka/producent — tylko jego płatności"},
                    "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "zaplacono_kontenery",
            "description": ("Ile już ZAPŁACONO za kontenery — realny wypływ kasy (wpłaty z datą ≤ dziś). Zwraca sumy per producent i per "
                            "miesiąc ORAZ listę konkretnych KONTENERÓW (numer, PO, producent, data, kwota). Bucket po MIESIĄCU faktycznej "
                            "płatności. Do pytań „ile wypłaciliśmy w lipcu”, „które kontenery opłaciliśmy w lipcu”, „ile zapłaciliśmy "
                            "producentowi X w tym roku”. PLN po kursie historycznym NBP z dnia wpłaty (dokładny). Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {
                    "miesiac": {"type": "string", "description": "opcjonalny miesiąc wpłaty: 1-12 lub nazwa po polsku, np. „lipiec”"},
                    "rok": {"type": "integer", "description": "opcjonalny rok wpłaty, np. 2026 (domyślnie bieżący, gdy podano miesiąc)"},
                    "producent": {"type": "string", "description": "opcjonalna marka/producent — tylko jego wpłaty"},
                    "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "platnosci_kontenera",
            "description": ("Płatności KONKRETNEGO kontenera po numerze kontenera LUB numerze zamówienia (PO): zaliczki, balance, "
                            "ile już zapłacono, ile zostało do zapłaty i terminy. Do pytań „ile zostało za kontener TCKU7064646”, "
                            "„co zapłacone dla PO 123”. Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {"numer": {"type": "string", "description": "numer kontenera (np. TCKU7064646) albo numer zamówienia/PO"}},
                "required": ["numer"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kapital_w_towarze",
            "description": ("Zbiorczy stan finansowy magazynu NA DZIŚ: kapitał zamrożony w towarze, wartość magazynu, magazyn w drodze, "
                            "kontenery w drodze, ile zapłacono za magazyn w drodze i ile pozostało do zapłaty. Opcjonalnie dla jednego "
                            "sklepu. Do pytań „ile mam zamrożone w towarze”, „ile zostało do zapłaty za cały magazyn w drodze”. "
                            "Dane finansowe — wymaga uprawnień."),
            "parameters": {
                "type": "object",
                "properties": {"sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa"}},
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
            "description": ("Wyszukiwarka rozmyta po FRAGMENCIE nazwy/SKU/EAN — używaj TYLKO gdy nie znasz SKU („znajdź krzesło biurowe”) "
                            "albo gdy pobierz_stan zwrócił znaleziono=false. NIE używaj jej do „ile mamy <SKU>” — od tego jest pobierz_stan. "
                            "Jeśli fraza pokrywa się dokładnie z jakimś SKU, zwraca dokladne_trafienie — użyj go 1:1, nie pokazuj listy podobnych."),
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
    {
        "type": "function",
        "function": {
            "name": "zamowienia_wg_statusu",
            "description": ("Rozbicie zamówień dla dnia lub zakresu dat: liczba wszystkich zamówień, ile zrealizowanych (statusy "
                            "doręczone, jak w finansach), ile opłaconych/nieopłaconych (payment_status paid/unpaid), ile za pobraniem "
                            "(COD), oraz pełny podział po statusie i po statusie płatności. Opcjonalnie per sklep. Do pytań „ile zamówień "
                            "wczoraj”, „ile anulowanych/nieopłaconych”, „ile za pobraniem”, „ile zrealizowanych”. Wymaga assistantFinancials."),
            "parameters": {
                "type": "object",
                "properties": {
                    "data_od": {"type": "string", "description": "data (RRRR-MM-DD lub DD.MM.RRRR); można też 'wczoraj'/'dzisiaj'"},
                    "data_do": {"type": "string", "description": "opcjonalna data końcowa; brak = ten sam dzień co data_od"},
                    "sklep": {"type": "string", "description": "opcjonalnie: amh, acti lub veluxa"},
                },
                "required": ["data_od"],
            },
        },
    },
]


def _fmt_date(d: Optional[date]) -> Optional[str]:
    return d.strftime("%d.%m.%Y") if isinstance(d, date) else None


def _dostawa_typ(src: Optional[str]) -> Optional[str]:
    """Etykieta źródła najbliższej dostawy: delivered→dostarczona, expected→potwierdzona, estimate→szacowana."""
    return {"delivered": "dostarczona", "expected": "potwierdzona", "estimate": "szacowana"}.get(src)


def _deliveries(p) -> List[Dict[str, Any]]:
    out = []
    for d in (p.incoming_deliveries or []):
        out.append({
            "data": _fmt_date(getattr(d, "eta_date", None)),
            "ilosc": getattr(d, "quantity", None),
            "kontener": getattr(d, "container_number", None),
        })
    return out


_FIND_STATUSES = {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE", "SAMPLE"}


async def _find_product(db: AsyncSession, sku: str, shop: str = "", fallback: bool = True):
    """Szuka produktu po SKU BEZ względu na wielkość liter. shop='' = wszystkie sklepy;
    'amh'/'acti'/'veluxa' = stan i sprzedaż tylko tego sklepu. Zwraca ProductSummary lub None.

    fallback=True i shop podany: gdy w tym sklepie nie ma produktu, szuka globalnie (produkt może
    należeć do innej firmy). fallback=False: ściśle w danym sklepie — używane w rozbiciu per firma,
    żeby firmie bez tego produktu NIE przypisać cudzego (globalnego) stanu.
    """
    target = (sku or "").strip().upper()
    if not target:
        return None
    prods = await fetch_products(db, _FIND_STATUSES, shop)
    for p in prods:
        if (p.sku or "").strip().upper() == target:
            return p
    if shop and fallback:  # nie znaleziono w tym sklepie — spróbuj globalnie
        for p in await fetch_products(db, _FIND_STATUSES, ""):
            if (p.sku or "").strip().upper() == target:
                return p
    return None


async def _firma_maps(db: AsyncSession):
    """Zwraca (lista [(slug, nazwa)], mapa {firma_id: slug}). Fallback: AMH/Acti/Veluxa."""
    rows = (await db.execute(text(
        f"SELECT id, slug, name FROM {settings.TABLE_FIRMY} ORDER BY sort_order, id"
    ))).mappings().all()
    firmy = [(r["slug"], r["name"]) for r in rows if r["slug"]]
    id2slug = {r["id"]: r["slug"] for r in rows if r["slug"]}
    if not firmy:
        firmy = [("amh", "AMH"), ("acti", "Acti"), ("veluxa", "Veluxa")]
    return firmy, id2slug


async def _resolve_product(db: AsyncSession, sku: str, shop: str):
    """Zwraca (produkt_właściciela, rozklad_per_firma).

    shop podany → ŚCIŚLE ta firma (bez globalnego fallbacku); rozklad = [].
    shop pusty → sweep ściśle po firmach. „Produkt” = wiersz FIRMY-WŁAŚCICIELA (przypisana firma
    produktu z firma_id; NULL = AMH), a NIE firmy z największym stanem — bo transit, kontenery i
    najbliższa dostawa wiszą przy firmie-matce, nawet gdy on-hand jest większy w innej firmie.
    Rozklad = stan on-hand per firma (tylko firmy, które realnie mają ten produkt).
    """
    if shop:
        return await _find_product(db, sku, shop, fallback=False), []

    firmy, id2slug = await _firma_maps(db)
    per: Dict[str, Any] = {}          # slug -> (nazwa, produkt)
    firma_id = None
    for slug, fname in firmy:
        p = await _find_product(db, sku, slug, fallback=False)
        if not p:
            continue
        per[slug] = (fname, p)
        if firma_id is None and p.firma_id is not None:
            firma_id = p.firma_id     # firma-właściciel (stała niezależnie od scope)

    if not per:                        # brak stanu w żadnej firmie (np. sample) — wiersz globalny
        g = await _find_product(db, sku, "", fallback=False)
        return g, []

    owner_slug = id2slug.get(firma_id, "amh") if firma_id else "amh"
    if owner_slug in per:
        owner = per[owner_slug][1]
    else:
        # Firma-matka nie wpadła do sweepu (np. 0 on-hand i brak sprzedaży w jej scope) —
        # dociągamy jej wiersz osobno, bo to z niego biorą się kontenery i magazyn w drodze.
        owner = await _find_product(db, sku, owner_slug, fallback=False) or next(iter(per.values()))[1]

    rozklad = [{"firma": fn, "slug": s, "na_stanie": p.stock or 0}
               for s, (fn, p) in per.items() if (p.stock or 0) != 0]
    return owner, rozklad


async def _tool_pobierz_stan(db: AsyncSession, user: CurrentUser, sku: str, sklep: Any = None) -> Dict[str, Any]:
    shop = _norm_shop(sklep)
    p, rozklad = await _resolve_product(db, sku, shop)
    if not p:
        return {"znaleziono": False, "sku": sku, "sklep": shop or "wszystkie"}
    out = {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name,
        "magazyn_w_drodze": p.stock_in_transit_wbite,        # wbite do drugiego magazynu Subiektu
        "w_kontenerach": p.stock_in_transit_containers,      # jeszcze niewbite, płyną w kontenerach
        "w_drodze_razem": p.stock_in_transit,                # suma: magazyn_w_drodze + w_kontenerach
        "najblizsza_dostawa": _fmt_date(p.nearest_delivery_date),
        "najblizsza_dostawa_typ": _dostawa_typ(p.nearest_delivery_source),
        "status": p.status, "producent": p.manufacturer_name,
        "firma_wlasciciel": p.firma_name,
    }
    if shop:
        out["na_stanie"] = p.stock
        out["sklep"] = shop
    else:
        out["na_stanie_razem"] = sum(r["na_stanie"] for r in rozklad) if rozklad else (p.stock or 0)
        out["per_firma"] = rozklad or [{"firma": p.firma_name or "AMH", "slug": "amh", "na_stanie": p.stock or 0}]
        out["sklep"] = "wszystkie"
    return out


async def _tool_prognoza(db: AsyncSession, user: CurrentUser, sku: str, sklep: Any = None) -> Dict[str, Any]:
    shop = _norm_shop(sklep)
    p, _ = await _resolve_product(db, sku, shop)
    if not p:
        return {"znaleziono": False, "sku": sku, "sklep": shop or "wszystkie"}
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name, "sklep": shop or "wszystkie",
        "na_stanie": p.stock, "w_drodze_razem": p.stock_in_transit,
        "magazyn_w_drodze": p.stock_in_transit_wbite, "w_kontenerach": p.stock_in_transit_containers,
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
    items = [p for p in prods if p.days_until_order is not None and p.days_until_order <= 0 and p.status != "W_DRODZE" and not p.no_reorder]
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


def _parse_date(val: Any) -> Optional[date]:
    """Parsuje datę z: RRRR-MM-DD, DD.MM.RRRR, DD.MM (bieżący rok) oraz 'wczoraj'/'dzisiaj'."""
    if not val:
        return None
    s = str(val).strip().lower()
    if s in ("dzisiaj", "dziś", "dzis", "today"):
        return date.today()
    if s in ("wczoraj", "yesterday"):
        return date.today() - timedelta(days=1)
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    m = re.match(r"^(\d{1,2})[.\-/](\d{1,2})$", s)   # DD.MM → bieżący rok
    if m:
        try:
            return date(date.today().year, int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    return None


async def _orders_context(db: AsyncSession, od: date, do: date, shop: str) -> Dict[str, Any]:
    """Liczba WSZYSTKICH zamówień + wartość brutto + świeżość (<14 dni) dla dnia/zakresu i sklepu.
    Używane, by sprzedaż za świeży dzień pokazywać z liczbą wszystkich zamówień, a nie tylko zrealizowanych."""
    o = settings.TABLE_ORDERS
    dcol = settings.COL_ORDER_DATE
    params: Dict[str, Any] = {"od": od, "do": do}
    where = f"WHERE ord.{dcol}::date BETWEEN :od AND :do"
    if shop:
        where += " AND ord.shop = :shop"
        params["shop"] = shop
    row = (await db.execute(text(
        f"SELECT COUNT(*) AS c, COALESCE(SUM(ord.total), 0)::float AS s FROM {o} ord {where}"
    ), params)).mappings().first()
    dni = (date.today() - do).days
    swieze = dni < 14
    return {
        "zamowien_razem": int(row["c"]),
        "wartosc_brutto_wszystkich": round(row["s"] or 0, 2),
        "dni_od_konca_zakresu": dni,
        "swieze": swieze,
        "podsumuj_po": ("liczba_zamowien" if swieze else "kwotowo"),
    }


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
    return {"brak_uprawnien": True, "komunikat": "Użytkownik nie ma uprawnień do danych finansowych w asystencie (assistantFinancials)."}


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
    """Rozbija stan SKU po firmach (ściśle — firma bez produktu wypada, nie dostaje cudzego stanu).
    Magazyn w drodze i kontenery bierzemy od firmy-właściciela (największy stan)."""
    symbol = (sku or "").strip().upper()
    if not symbol:
        return {"znaleziono": False}
    p, rozklad = await _resolve_product(db, symbol, "")
    if not p:
        return {"znaleziono": False, "sku": symbol}
    razem = sum(r["na_stanie"] for r in rozklad) if rozklad else (p.stock or 0)
    return {
        "znaleziono": True, "sku": symbol, "nazwa": p.name,
        "firma_wlasciciel": p.firma_name,
        "rozklad_per_firma": rozklad or [{"firma": p.firma_name or "AMH", "slug": "amh", "na_stanie": p.stock or 0}],
        "razem_stan": razem,
        "magazyn_w_drodze": p.stock_in_transit_wbite, "w_kontenerach": p.stock_in_transit_containers,
        "w_drodze_razem": p.stock_in_transit,
    }


async def _tool_wartosc_magazynu(db: AsyncSession, user: CurrentUser, sklep: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    shop = _norm_shop(sklep)
    prods = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"}, shop)
    total = round(sum((p.stock_value or 0) for p in prods), 2)
    dead = round(sum((p.stock_value or 0) for p in prods if p.product_status == "DEAD_STOCK"), 2)
    return {"waluta": "PLN", "wartosc_magazynu": total, "wartosc_martwego_stanu": dead,
            "sklep": shop or "wszystkie"}


async def _tool_finanse_ogolne(db: AsyncSession, user: CurrentUser, okres: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
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
    if not has_perm(user, "assistantFinancials"):
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
    if not has_perm(user, "assistantFinancials"):
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


async def _ledger(db: AsyncSession, user: CurrentUser):
    """Wspólne źródło: płaski rejestr płatności za kontenery + kursy „na dziś”."""
    from routers.calendar import cashflow_ledger
    led = await cashflow_ledger(db=db, user=user)
    if not isinstance(led, dict):
        return [], {}
    return led.get("events", []) or [], led.get("rate_today", {}) or {}


def _ev_pln(e: Dict[str, Any], rt: Dict[str, float]):
    """PLN pojedynczego zdarzenia. Zwraca (pln, szacowany).

    paid → kwota_pln (kurs historyczny, dokładny). plan/open w PLN → kwota wprost.
    plan/open w obcej walucie → kwota × kurs „na dziś” (szacunek). Brak kursu → (None, False).
    """
    if e.get("kwota_pln") is not None:
        return float(e["kwota_pln"]), False
    cur = (e.get("waluta") or "PLN").upper()
    kwota = float(e.get("kwota") or 0)
    if cur == "PLN":
        return round(kwota, 2), False
    r = rt.get(cur)
    if r is None:
        return None, False
    return round(kwota * r, 2), True


def _ym(s: Optional[str]):
    """'YYYY-MM-DD' → (rok, miesiac) albo None."""
    if not s or len(s) < 7:
        return None
    try:
        return int(s[:4]), int(s[5:7])
    except ValueError:
        return None


def _iso(s: Optional[str]) -> Optional[date]:
    """'YYYY-MM-DD' → date albo None (odporne na null/śmieci)."""
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def _per_producent(events: List[Dict[str, Any]], rt: Dict[str, float]) -> List[Dict[str, Any]]:
    agg: Dict[str, Dict[str, Any]] = {}
    for e in events:
        pln, _ = _ev_pln(e, rt)
        if pln is None:
            continue
        key = e.get("mfr_name") or "Bez producenta"
        a = agg.setdefault(key, {"producent": key, "kwota_pln": 0.0, "liczba_zdarzen": 0})
        a["kwota_pln"] = round(a["kwota_pln"] + pln, 2)
        a["liczba_zdarzen"] += 1
    return sorted(agg.values(), key=lambda x: x["kwota_pln"], reverse=True)


def _per_miesiac(events: List[Dict[str, Any]], rt: Dict[str, float], field: str) -> List[Dict[str, Any]]:
    agg: Dict[str, Dict[str, Any]] = {}
    for e in events:
        pln, _ = _ev_pln(e, rt)
        if pln is None:
            continue
        d = e.get(field)
        key = d[:7] if (d and len(d) >= 7) else "bez_terminu"
        a = agg.setdefault(key, {"miesiac": key, "kwota_pln": 0.0, "liczba_zdarzen": 0})
        a["kwota_pln"] = round(a["kwota_pln"] + pln, 2)
        a["liczba_zdarzen"] += 1
    return sorted(agg.values(), key=lambda x: x["miesiac"])


def _per_kontener(events: List[Dict[str, Any]], rt: Dict[str, float], date_field: str, limit: int = 60) -> List[Dict[str, Any]]:
    """Grupuje płatności po kontenerze (fallback: numer PO). date_field: 'termin' (do zapłaty) lub 'data' (zapłacono)."""
    agg: Dict[str, Dict[str, Any]] = {}
    for e in events:
        pln, szac = _ev_pln(e, rt)
        if pln is None:
            continue
        key = e.get("kontener") or e.get("po") or "?"
        a = agg.get(key)
        if a is None:
            a = agg[key] = {"kontener": e.get("kontener"), "po": e.get("po"), "sklep": e.get("shop"),
                            "_prod": set(), "kwota_pln": 0.0, "_daty": [], "szacunek": False}
        a["kwota_pln"] = round(a["kwota_pln"] + pln, 2)
        if e.get("mfr_name"):
            a["_prod"].add(e["mfr_name"])
        if szac:
            a["szacunek"] = True
        d = e.get(date_field)
        if d:
            a["_daty"].append(d)
    out = []
    for a in agg.values():
        row = {"kontener": a["kontener"], "po": a["po"],
               "producent": ", ".join(sorted(a["_prod"])) or None,
               "sklep": a["sklep"], "kwota_pln": a["kwota_pln"], "szacunek": a["szacunek"],
               date_field: (min(a["_daty"]) if a["_daty"] else None)}
        out.append(row)
    out.sort(key=lambda r: (r.get(date_field) or "9999-99", -r["kwota_pln"]))
    return out[:limit]


def _sum_pln(events: List[Dict[str, Any]], rt: Dict[str, float]):
    total = 0.0
    brak = 0
    for e in events:
        pln, _ = _ev_pln(e, rt)
        if pln is None:
            brak += 1
        else:
            total += pln
    return round(total, 2), brak


async def _tool_do_zaplaty(db: AsyncSession, user: CurrentUser, miesiac: Any = None, rok: Any = None,
                           producent: Optional[str] = None, sklep: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    events, rt = await _ledger(db, user)
    shop = _norm_shop(sklep)
    mm = _parse_miesiac(miesiac)
    yy = _parse_rok(rok)
    if mm and not yy:
        yy = date.today().year

    # Do zapłaty = zdarzenia jeszcze nieopłacone (status plan/open).
    ev = [e for e in events if e.get("status") != "paid"]
    if shop:
        ev = [e for e in ev if e.get("shop") == shop]
    if producent:
        needle = producent.strip().lower()
        ev = [e for e in ev if needle in (e.get("mfr_name") or "").lower()]

    today = date.today()
    d30 = today + timedelta(days=30)

    # Kontekst niezależny od filtra okresu (liczony na zbiorze po sklepie/producencie).
    bez_terminu = [e for e in ev if not e.get("termin")]
    bt_pln, _ = _sum_pln(bez_terminu, rt)
    next30 = [e for e in ev if (t := _iso(e.get("termin"))) and today <= t <= d30]
    n30_pln, _ = _sum_pln(next30, rt)

    # Filtr okresu po TERMINIE płatności (zdarzenia bez terminu wypadają — raportujemy je osobno).
    if mm or yy:
        def _keep(e):
            ym = _ym(e.get("termin"))
            if not ym:
                return False
            y, mo = ym
            if yy and y != yy:
                return False
            if mm and mo != mm:
                return False
            return True
        ev = [e for e in ev if _keep(e)]

    total, brak = _sum_pln(ev, rt)
    if mm:
        okres = f"{_MIES_PL[mm - 1]} {yy}"
    elif yy:
        okres = str(yy)
    else:
        okres = "wszystkie otwarte terminy"

    out = {
        "waluta": "PLN",
        "szacunek": True,
        "okres": okres,
        "razem_pln": total,
        "liczba_zdarzen": len(ev),
        "per_producent": _per_producent(ev, rt),
        "najblizsze_30_dni_pln": n30_pln,
        "bez_terminu_pln": bt_pln,
        "bez_terminu_zdarzen": len(bez_terminu),
        "kontenery": _per_kontener(ev, rt, "termin"),
        "sklep": shop or "wszystkie",
        "filtr_producent": producent,
    }
    if not mm:
        out["per_miesiac"] = _per_miesiac(ev, rt, "termin")
    if brak:
        out["brak_kursu_zdarzen"] = brak
    return out


async def _tool_zaplacono_kontenery(db: AsyncSession, user: CurrentUser, miesiac: Any = None, rok: Any = None,
                                    producent: Optional[str] = None, sklep: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    events, rt = await _ledger(db, user)
    shop = _norm_shop(sklep)
    mm = _parse_miesiac(miesiac)
    yy = _parse_rok(rok)
    if mm and not yy:
        yy = date.today().year

    # Zapłacono = faktyczne wpłaty (status paid), bucket po dacie płatności.
    ev = [e for e in events if e.get("status") == "paid"]
    if shop:
        ev = [e for e in ev if e.get("shop") == shop]
    if producent:
        needle = producent.strip().lower()
        ev = [e for e in ev if needle in (e.get("mfr_name") or "").lower()]
    if mm or yy:
        def _keep(e):
            ym = _ym(e.get("data"))
            if not ym:
                return False
            y, mo = ym
            if yy and y != yy:
                return False
            if mm and mo != mm:
                return False
            return True
        ev = [e for e in ev if _keep(e)]

    total, brak = _sum_pln(ev, rt)
    if mm:
        okres = f"{_MIES_PL[mm - 1]} {yy}"
    elif yy:
        okres = str(yy)
    else:
        okres = "wszystkie wpłaty"

    out = {
        "waluta": "PLN",
        "okres": okres,
        "razem_pln": total,
        "liczba_wplat": len(ev),
        "per_producent": _per_producent(ev, rt),
        "kontenery": _per_kontener(ev, rt, "data"),
        "sklep": shop or "wszystkie",
        "filtr_producent": producent,
    }
    if not mm:
        out["per_miesiac"] = _per_miesiac(ev, rt, "data")
    if brak:
        out["brak_kursu_wplat"] = brak
    return out


async def _tool_platnosci_kontenera(db: AsyncSession, user: CurrentUser, numer: str) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    target = (numer or "").strip().upper()
    if not target:
        return {"znaleziono": False}
    events, rt = await _ledger(db, user)
    ev = [e for e in events
          if (e.get("kontener") or "").upper() == target or (e.get("po") or "").upper() == target]
    if not ev:
        return {"znaleziono": False, "szukano": numer}

    paid = [e for e in ev if e.get("status") == "paid"]
    otwarte = [e for e in ev if e.get("status") != "paid"]
    zaplacono, _ = _sum_pln(paid, rt)
    pozostalo, brak = _sum_pln(otwarte, rt)

    producenci = sorted({e.get("mfr_name") for e in ev if e.get("mfr_name")})
    sklepy = sorted({e.get("shop") for e in ev if e.get("shop")})
    etas = [e.get("eta") for e in ev if e.get("eta")]

    def _row(e):
        pln, szac = _ev_pln(e, rt)
        return {
            "typ": e.get("typ"), "status": e.get("status"),
            "kwota": e.get("kwota"), "waluta": e.get("waluta"),
            "kwota_pln": pln, "szacowany_pln": szac,
            "data": e.get("data"), "termin": e.get("termin"),
        }

    out = {
        "znaleziono": True,
        "kontener": ev[0].get("kontener"),
        "po": ev[0].get("po"),
        "producent": ", ".join(producenci) if producenci else None,
        "sklep": ", ".join(sklepy) if sklepy else None,
        "eta": min(etas) if etas else None,
        "zaplacono_pln": zaplacono,
        "pozostalo_pln": pozostalo,
        "pozostalo_szacunek": any(e.get("kwota_pln") is None and e.get("waluta") != "PLN" for e in otwarte),
        "zdarzenia": [_row(e) for e in ev],
    }
    if brak:
        out["brak_kursu_zdarzen"] = brak
    return out


async def _tool_kapital_w_towarze(db: AsyncSession, user: CurrentUser, sklep: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    from services.snapshots import build_kpi_rows
    rows = await build_kpi_rows(db)
    scope = _norm_shop(sklep) or "all"
    row = next((r for r in rows if r.get("firma_slug") == scope), None)
    if not row:
        return {"znaleziono": False, "sklep": scope}
    return {
        "znaleziono": True,
        "sklep": ("wszystkie" if scope == "all" else scope),
        "kapital_w_towarze_pln": row.get("kapital_pln"),
        "wartosc_magazynu_pln": row.get("magazyn_pln"),
        "magazyn_w_drodze_pln": row.get("magazyn_w_drodze_pln"),
        "kontenery_w_drodze_pln": row.get("kontenery_pln"),
        "zaplacono_za_w_drodze_pln": row.get("zaplacono_pln"),
        "pozostalo_do_zaplaty_pln": row.get("pozostalo_pln"),
        "uwaga": "kapitał w towarze = wartość magazynu + magazyn w drodze; „pozostało do zapłaty” dotyczy niedostarczonych kontenerów.",
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
    can_fin = has_perm(user, "assistantFinancials")
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
    products = res.get("products") or []
    prod = [{"sku": r.get("sku"), "nazwa": r.get("name"), "stan": r.get("stock"),
             "producent": r.get("manufacturer_name")} for r in products[:15]]
    ean = [{"sku": r.get("sku"), "nazwa": r.get("name"), "ean": r.get("ean")}
           for r in (res.get("ean") or [])[:10]]
    out = {"liczba": len(prod) + len(ean), "produkty": prod, "po_ean": ean}
    # Dokładne trafienie po SKU (1:1, case-insensitive) — priorytet nad listą podobnych.
    qn = q.upper()
    exact = next((r for r in products if (r.get("sku") or "").strip().upper() == qn), None)
    if exact:
        out["dokladne_trafienie"] = {"sku": exact.get("sku"), "nazwa": exact.get("name"),
                                     "producent": exact.get("manufacturer_name")}
        out["komunikat"] = (f"Dokładne trafienie SKU {exact.get('sku')} — użyj go 1:1 (po stan wywołaj pobierz_stan), "
                            f"nie pytaj o doprecyzowanie.")
    return out


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
                                producent: Optional[str] = None, sklep: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    from routers.finance import month_finance
    r, m = _parse_rok(rok), _parse_miesiac(miesiac)
    if r is None or m is None:
        return {"blad": "podaj rok (np. 2026) i miesiąc (1-12 lub nazwa po polsku, np. „lipiec”)"}
    sym = (str(sku).strip().upper() or None) if sku else None
    prod = (str(producent).strip() or None) if producent else None
    return await month_finance(db, r, m, symbol=sym, producent=prod, shop=_norm_shop(sklep))


async def _tool_porownaj_miesiace(db: AsyncSession, user: CurrentUser, rok_a: Any = None, miesiac_a: Any = None,
                                  rok_b: Any = None, miesiac_b: Any = None, sku: Optional[str] = None,
                                  producent: Optional[str] = None, sklep: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    from routers.finance import month_finance
    ra, ma = _parse_rok(rok_a), _parse_miesiac(miesiac_a)
    rb, mb = _parse_rok(rok_b), _parse_miesiac(miesiac_b)
    if None in (ra, ma, rb, mb):
        return {"blad": "podaj oba miesiące: rok_a+miesiac_a oraz rok_b+miesiac_b (miesiąc 1-12 lub nazwa)"}
    sym = (str(sku).strip().upper() or None) if sku else None
    prod = (str(producent).strip() or None) if producent else None
    shp = _norm_shop(sklep)
    a = await month_finance(db, ra, ma, symbol=sym, producent=prod, shop=shp)
    b = await month_finance(db, rb, mb, symbol=sym, producent=prod, shop=shp)

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


async def _tool_finanse_zakres(db: AsyncSession, user: CurrentUser, od: Any = None, do: Any = None,
                               sku: Optional[str] = None, producent: Optional[str] = None,
                               sklep: Any = None) -> Dict[str, Any]:
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    from routers.finance import range_finance
    if not od:
        return {"blad": "podaj datę „od” (RRRR-MM-DD); dla jednego dnia „do” pomiń"}
    sym = (str(sku).strip().upper() or None) if sku else None
    prod = (str(producent).strip() or None) if producent else None
    shop = _norm_shop(sklep)
    res = await range_finance(db, str(od).strip(), (str(do).strip() if do else None),
                              symbol=sym, producent=prod, shop=shop)
    if not isinstance(res, dict) or "blad" in res:
        return res
    # Doklej liczbę WSZYSTKICH zamówień + świeżość, żeby sprzedaż za świeży dzień nie była mylona
    # z liczbą zrealizowanych. Bez filtra sku/producent (kontekst dotyczy całego dnia/sklepu).
    if not sym and not prod:
        od_d = _parse_date(od)
        do_d = _parse_date(do) or od_d
        if od_d:
            if do_d < od_d:
                od_d, do_d = do_d, od_d
            ctx = await _orders_context(db, od_d, do_d, shop)
            res["zamowienia_zrealizowane"] = res.pop("zamowienia", None)   # 45 = tylko doręczone
            res.update(ctx)                                                # zamowien_razem = 115 (wszystkie)
            if ctx["swieze"]:
                res["uwaga"] = (
                    "ŚWIEŻY zakres (<14 dni): przychód netto/brutto/marża to TYLKO zamówienia już zrealizowane "
                    f"({res.get('zamowienia_zrealizowane')} z {ctx['zamowien_razem']}). Reszta paczek jest jeszcze w drodze, "
                    "statusy się nie ustały, więc kwoty urosną. W odpowiedzi PODAJ jako główną liczbę WSZYSTKICH zamówień "
                    "(zamowien_razem) i wartość brutto wszystkich, a przychód/marżę opisz jako 'zrealizowane do tej pory'. "
                    "NIE przedstawiaj zamowienia_zrealizowane jako 'liczby zamówień'."
                )
            else:
                res["uwaga"] = "Zakres domknięty (>14 dni) — sprzedaż zrealizowana jest miarodajna."
    return res


async def _tool_zamowienia_wg_statusu(db: AsyncSession, user: CurrentUser,
                                      data_od: str, data_do: Any = None, sklep: Any = None) -> Dict[str, Any]:
    """Rozbicie zamówień z sellasist_orders po statusie i płatności, dla dnia/zakresu, opcjonalnie per sklep."""
    if not has_perm(user, "assistantFinancials"):
        return _brak_uprawnien()
    od = _parse_date(data_od)
    if not od:
        return {"blad": "Podaj datę w formacie RRRR-MM-DD (np. 2026-07-14) lub DD.MM.RRRR."}
    do = _parse_date(data_do) or od
    if do < od:
        od, do = do, od
    shop = _norm_shop(sklep)

    o = settings.TABLE_ORDERS
    dcol = settings.COL_ORDER_DATE
    scol = settings.COL_ORDER_STATUS
    params: Dict[str, Any] = {"od": od, "do": do}
    where = f"WHERE ord.{dcol}::date BETWEEN :od AND :do"
    if shop:
        where += " AND ord.shop = :shop"
        params["shop"] = shop

    total = (await db.execute(text(
        f"SELECT COUNT(*) AS c, COALESCE(SUM(ord.total), 0)::float AS s FROM {o} ord {where}"
    ), params)).mappings().first()
    st = (await db.execute(text(
        f"SELECT COALESCE(NULLIF(TRIM(ord.{scol}), ''), '(brak)') AS k, COUNT(*) AS c "
        f"FROM {o} ord {where} GROUP BY 1 ORDER BY c DESC"
    ), params)).mappings().all()

    # Rozłączne kubełki płatności. Reguły ustalone z użytkownikiem:
    #  - kanał Klaudia (drop/Klaudia) traktujemy ZAWSZE jak opłacone (płacą z dużym opóźnieniem, w bazie unpaid),
    #  - pobranie (COD) jest osobnym kubełkiem i NIE wlicza się do nieopłaconych,
    #  - nieopłacone = unpaid, ale bez Klaudii i bez COD.
    klaudia = f"({sales_channel_case('ord')}) = 'Klaudia'"
    cod = "ord.payment_name ILIKE '%pobran%'"
    buckets = (await db.execute(text(
        f"SELECT "
        f"  COUNT(*) FILTER (WHERE {klaudia}) AS klaudia, "
        f"  COUNT(*) FILTER (WHERE {cod} AND NOT ({klaudia})) AS cod, "
        f"  COUNT(*) FILTER (WHERE ord.payment_status = 'paid' AND NOT ({klaudia}) AND NOT ({cod})) AS paid, "
        f"  COUNT(*) FILTER (WHERE ord.payment_status = 'unpaid' AND NOT ({klaudia}) AND NOT ({cod})) AS unpaid "
        f"FROM {o} ord {where}"
    ), params)).mappings().first()
    oplacone = int(buckets["paid"]) + int(buckets["klaudia"])   # Klaudia liczona jako opłacona
    nieoplacone = int(buckets["unpaid"])
    pobrania = int(buckets["cod"])

    pay = (await db.execute(text(
        f"SELECT COALESCE(NULLIF(TRIM(ord.payment_status), ''), '(brak)') AS k, COUNT(*) AS c "
        f"FROM {o} ord {where} GROUP BY 1 ORDER BY c DESC"
    ), params)).mappings().all()

    realized_clause = included_status_clause("ord")   # ta sama whitelista statusów co finanse (per-sklep)
    zrealizowane = None
    if realized_clause:
        zr = (await db.execute(text(
            f"SELECT COUNT(*) AS c FROM {o} ord {where} {realized_clause}"
        ), params)).mappings().first()
        zrealizowane = int(zr["c"])

    # Świeżość: dzień/zakres krótszy niż 14 dni wstecz jeszcze się „realizuje” (statusy się nie ustały)
    dni_od_konca = (date.today() - do).days
    swieze = dni_od_konca < 14

    return {
        "od": od.isoformat(), "do": do.isoformat(), "sklep": shop or "wszystkie",
        "zamowien_razem": int(total["c"]),
        "zrealizowane_sprzedaz": zrealizowane,
        "oplacone": oplacone,
        "nieoplacone": nieoplacone,
        "pobrania_cod": pobrania,
        "wartosc_brutto_wszystkich": round(total["s"] or 0, 2),
        "dni_od_konca_zakresu": dni_od_konca,
        "swieze": swieze,
        "podsumuj_po": ("liczba_zamowien" if swieze else "kwotowo"),
        "wg_statusu": [{"status": r["k"], "liczba": int(r["c"])} for r in st],
        "wg_platnosci": [{"platnosc": r["k"], "liczba": int(r["c"])} for r in pay],
        "uwaga": ("Płatności rozłączne: opłacone = paid + kanał Klaudia (Klaudia zawsze jako opłacona); "
                  "nieopłacone = unpaid bez Klaudii i bez pobrań; pobrania_cod osobno. "
                  "Gdy swieze=true (koniec zakresu <14 dni temu) porównuj/podsumowuj po LICZBIE zamówień, nie po zrealizowanych — statusy jeszcze się nie ustały."),
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
    # PACZKA 2 — finanse (assistantFinancials)
    "wartosc_magazynu": _tool_wartosc_magazynu,
    "finanse_ogolne": _tool_finanse_ogolne,
    "finanse_produktu": _tool_finanse_produktu,
    "finanse_miesiac": _tool_finanse_miesiac,
    "porownaj_miesiace": _tool_porownaj_miesiace,
    "finanse_zakres": _tool_finanse_zakres,
    "sprzedaz_wg_kanalu": _tool_sprzedaz_wg_kanalu,
    "do_zaplaty": _tool_do_zaplaty,
    "zaplacono_kontenery": _tool_zaplacono_kontenery,
    "platnosci_kontenera": _tool_platnosci_kontenera,
    "kapital_w_towarze": _tool_kapital_w_towarze,
    # PACZKA 4 — dodatki
    "anomalie": _tool_anomalie,
    "sezonowosc": _tool_sezonowosc,
    "kurs_waluty": _tool_kurs_waluty,
    "lista_zakupow": _tool_lista_zakupow,
    # przekrojowe
    "szukaj": _tool_szukaj,
    "swiezosc_danych": _tool_swiezosc_danych,
    "statystyki": _tool_statystyki,
    "zamowienia_wg_statusu": _tool_zamowienia_wg_statusu,
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


# Narzędzia finansowe — ładowane do modelu TYLKO dla użytkowników z assistantFinancials.
# Reszta dostaje mniejszy zestaw (magazyn/logistyka) → mniej tokenów wejściowych i zero rund „brak uprawnień”.
_FINANCE_TOOL_NAMES = frozenset({
    "wartosc_magazynu", "finanse_ogolne", "finanse_produktu",
    "finanse_miesiac", "porownaj_miesiace", "finanse_zakres",
    "sprzedaz_wg_kanalu",
    "do_zaplaty", "zaplacono_kontenery", "platnosci_kontenera", "kapital_w_towarze",
})


def _tools_for(user: CurrentUser) -> List[Dict[str, Any]]:
    """Zestaw narzędzi wysyłany do modelu zależnie od uprawnień."""
    if has_perm(user, "assistantFinancials"):
        return TOOLS
    return [t for t in TOOLS if (t.get("function") or {}).get("name") not in _FINANCE_TOOL_NAMES]


def _system_prompt_for(user: CurrentUser) -> str:
    """Prompt składany per-user: baza zawsze, dodatek finansowy tylko z assistantFinancials,
    plus dzisiejsza data (do „wczoraj/ten tydzień”)."""
    parts = [_PROMPT_BASE]
    if has_perm(user, "assistantFinancials"):
        parts.append(_PROMPT_FINANCE)
    parts.append(_PROMPT_TAIL)
    parts.append(f" Dzisiejsza data: {date.today().isoformat()}. "
                 "„Wczoraj”, „dziś”, „ten tydzień”, „w tym miesiącu”, „bieżący rok” licz względem niej.")
    return "".join(parts)


async def _llm_call(messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Dict[str, Any]:
    payload = {
        "model": settings.LLM_MODEL,
        "messages": messages,
        "tools": tools,
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
    tools_for_user = _tools_for(user)
    messages: List[Dict[str, Any]] = [{"role": "system", "content": _system_prompt_for(user)}]
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
                data = await _llm_call(messages, tools_for_user)
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
