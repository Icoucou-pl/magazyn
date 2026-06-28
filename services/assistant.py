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

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from models import CurrentUser
from services.products import fetch_products, get_product

MAX_ROUNDS = 5            # ile razy max model może poprosić o narzędzie w jednej turze
LLM_TIMEOUT = 45          # sekundy na pojedyncze wywołanie LLM

SYSTEM_PROMPT = (
    "Jesteś asystentem magazynowym aplikacji „Magazyn” firmy i-coucou. "
    "Odpowiadasz wyłącznie po polsku, krótko i konkretnie — jak kolega z pracy. "
    "ZAWSZE używaj narzędzi, żeby pobrać liczby z bazy: stany, prognozy, sprzedaż, listę do zamówienia. "
    "Nigdy nie zmyślaj stanów, dat ani liczb — jeśli nie masz danych z narzędzia, powiedz to wprost. "
    "Jeśli produkt nie został znaleziony, powiedz to jasno i nie wymyślaj. "
    "SKU zapisuj wielkimi literami. Daty podawaj po ludzku (np. „14 lipca”). "
    "Gdy pytanie dotyczy konkretnego SKU, użyj właściwego narzędzia dla tego SKU."
)

TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "pobierz_stan",
            "description": "Aktualny stan magazynowy produktu po SKU: ile sztuk na stanie, ile w drodze, status, producent.",
            "parameters": {
                "type": "object",
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. D2B"}},
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
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. D2B"}},
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
                "properties": {"sku": {"type": "string", "description": "SKU produktu, np. D2B"}},
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
                "properties": {"producent": {"type": "string", "description": "opcjonalna nazwa producenta do filtra"}},
                "required": [],
            },
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


async def _tool_pobierz_stan(db: AsyncSession, user: CurrentUser, sku: str) -> Dict[str, Any]:
    try:
        p = await get_product(db, (sku or "").strip())
    except HTTPException:
        return {"znaleziono": False, "sku": sku}
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name,
        "stan": p.stock, "w_drodze": p.stock_in_transit,
        "status": p.status, "producent": p.manufacturer_name,
    }


async def _tool_prognoza(db: AsyncSession, user: CurrentUser, sku: str) -> Dict[str, Any]:
    try:
        p = await get_product(db, (sku or "").strip())
    except HTTPException:
        return {"znaleziono": False, "sku": sku}
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name,
        "stan": p.stock, "w_drodze": p.stock_in_transit,
        "dni_do_wyczerpania": p.days_until_empty,
        "data_wyczerpania": _fmt_date(p.empty_date),
        "srednia_dzienna_sprzedaz": round((p.avg_monthly_weighted or 0) / 30.0, 2),
        "dni_do_zamowienia": p.days_until_order,
        "data_zamowienia": _fmt_date(p.order_date),
        "lead_time_dni": p.lead_time_days,
        "w_drodze_dostawy": _deliveries(p),
    }


async def _tool_sprzedaz(db: AsyncSession, user: CurrentUser, sku: str) -> Dict[str, Any]:
    try:
        p = await get_product(db, (sku or "").strip())
    except HTTPException:
        return {"znaleziono": False, "sku": sku}
    return {
        "znaleziono": True, "sku": p.sku, "nazwa": p.name,
        "sprzedaz_30dni": p.sales_1m, "sprzedaz_60dni": p.sales_2m, "sprzedaz_90dni": p.sales_3m,
        "srednia_miesieczna_wazona": round(p.avg_monthly_weighted or 0, 1),
    }


async def _tool_lista_do_zamowienia(db: AsyncSession, user: CurrentUser, producent: Optional[str] = None) -> Dict[str, Any]:
    prods = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"})
    items = [p for p in prods if p.days_until_order is not None and p.days_until_order <= 0]
    if producent:
        needle = producent.strip().lower()
        items = [p for p in items if needle in (p.manufacturer_name or "").lower()]
    items.sort(key=lambda p: (p.days_until_empty if p.days_until_empty is not None else 9999))
    rows = [{
        "sku": p.sku, "nazwa": p.name, "stan": p.stock,
        "dni_do_wyczerpania": p.days_until_empty, "producent": p.manufacturer_name,
    } for p in items[:30]]
    return {"liczba": len(items), "pozycje": rows, "filtr_producent": producent}


_DISPATCH = {
    "pobierz_stan": _tool_pobierz_stan,
    "prognoza_wyczerpania": _tool_prognoza,
    "sprzedaz": _tool_sprzedaz,
    "lista_do_zamowienia": _tool_lista_do_zamowienia,
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
    with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def _llm_call(messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    payload = {
        "model": settings.LLM_MODEL,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0.2,
        "max_tokens": 700,
    }
    return await asyncio.to_thread(_llm_request, payload)


async def run_chat(db: AsyncSession, user: CurrentUser, history: List[Dict[str, str]]) -> Dict[str, Any]:
    """Pełna tura: system prompt + historia → pętla tool-callingu → odpowiedź po polsku.
    Zwraca {answer, tools} gdzie tools to lista odpalonych narzędzi (do chipów w UI)."""
    messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history:
        role = m.get("role")
        if role in ("user", "assistant") and m.get("content"):
            messages.append({"role": role, "content": m["content"]})

    tools_used: List[Dict[str, Any]] = []
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
            result = await _dispatch_tool(db, user, name, args)
            tools_used.append({"name": name, "args": args})
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id"),
                "content": json.dumps(result, ensure_ascii=False, default=str),
            })

    return {"answer": "Za dużo kroków — przerwałem, żeby nie zapętlić. Spróbuj zapytać prościej.", "tools": tools_used}
