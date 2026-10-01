"""
Dziennik audytu Magazynu — każda udana zmiana zostawia wpis jako GOTOWE ZDANIE
(„goacik@i-cc.pl zmienił atrybuty produktu MKch1 (2 pola)”), tak jak logi dropów.

Jak to działa:
  · audit_middleware łapie każdą udaną mutację (POST/PUT/PATCH/DELETE) i zapisuje JEDEN wpis,
  · endpoint może ten wpis opisać dokładniej: audit.note("zmienił …", changes=[…]) —
    zdanie i lista zmian „było → jest” trafiają do wpisu zamiast opisu ze ścieżki,
  · endpoint bez note() dostaje zdanie złożone ze ścieżki (audit_opisy.opis_sciezki),
  · podglądy, synchronizacje i czat asystenta nie są zmianami — nie zostawiają wpisu
    (świeżość synchronizacji pokazuje zakładka „Świeżość danych”),
  · log_audit() zostaje do zdarzeń spoza middleware (logowania) i do zapisu po commicie;
    wywołany w trakcie żądania zastępuje wpis middleware, więc nic się nie dubluje.

Zdanie składamy w chwili zdarzenia: późniejsza zmiana nazwy czy loginu nie przepisuje historii.
Wpisy starsze niż 12 miesięcy kasuje pętla w lifespan.py (RETENCJA_MIESIECY).
"""

import json
from contextvars import ContextVar
from decimal import Decimal
from typing import Iterable, List, Optional

from sqlalchemy import text

from config import settings
from database import SessionLocal
from security import decode_jwt_token
from models import CurrentUser
import audit_opisy as opisy

RETENCJA_MIESIECY = 12

# Skrzynka na opis bieżącego żądania. Middleware wkłada pusty słownik przed call_next,
# endpoint dopisuje do niego (ten sam obiekt — kontekst zadania jest kopiowany, słownik nie).
_skrzynka: ContextVar[Optional[dict]] = ContextVar("audit_skrzynka", default=None)


# ============================================================
# API dla endpointów
# ============================================================

def note(message: str, *, changes: Optional[Iterable[dict]] = None, area: Optional[str] = None,
         resource_type: Optional[str] = None, resource_id=None, action: Optional[str] = None) -> None:
    """Opisuje zmianę bieżącego żądania. `message` to orzeczenie bez podmiotu
    („zmienił cenę produktu X”) — middleware dokleja e-mail użytkownika.
    Poza żądaniem HTTP (testy, pętle w tle) nic nie robi."""
    box = _skrzynka.get()
    if box is None:
        return
    box["message"] = message
    if changes is not None:
        box["changes"] = list(changes)
    for k, v in (("area", area), ("resource_type", resource_type), ("action", action)):
        if v:
            box[k] = v
    if resource_id is not None:
        box["resource_id"] = str(resource_id)


def skip() -> None:
    """To żądanie niczego nie zmienia (podgląd) — bez wpisu w dzienniku."""
    box = _skrzynka.get()
    if box is not None:
        box["skip"] = True


def zdanie(email: Optional[str], orzeczenie: str) -> str:
    """('ania@x.pl', 'zmieniła …') → 'ania@x.pl zmieniła …'; bez usera — z wielkiej litery."""
    orzeczenie = (orzeczenie or "").strip()
    if email:
        return f"{email} {orzeczenie}"
    return orzeczenie[:1].upper() + orzeczenie[1:]


def _json(changes) -> Optional[str]:
    if not changes:
        return None
    return json.dumps(list(changes), ensure_ascii=False,
                      default=lambda v: float(v) if isinstance(v, Decimal) else str(v))


_INSERT = f"""
    INSERT INTO {settings.TABLE_AUDIT_LOG}
        (user_id, user_email, action, resource_type, resource_id, details, message, changes, area)
    VALUES (:uid, :email, :action, :rtype, :rid, :details, :msg, CAST(:ch AS JSONB), :area)
"""


async def log_audit(db, user: Optional[CurrentUser], action: str,
                    resource_type: Optional[str] = None, resource_id: Optional[str] = None,
                    details: Optional[str] = None, *, message: Optional[str] = None,
                    changes: Optional[Iterable[dict]] = None, area: Optional[str] = None):
    """Zapisuje wpis od razu (z commitem). Errory ignorowane — nie blokują głównej operacji.
    `message` to orzeczenie, jak w note(). Wołany w trakcie żądania wyłącza wpis middleware."""
    box = _skrzynka.get()
    if box is not None:
        box["zapisane"] = True
    email = user.email if user else None
    try:
        await db.execute(text(_INSERT), {
            "uid": user.id if user else None,
            "email": email,
            "action": action,
            "rtype": resource_type,
            "rid": str(resource_id) if resource_id else None,
            "details": details,
            "msg": zdanie(email, message) if message else None,
            "ch": _json(changes),
            "area": area or opisy.obszar_akcji(action, resource_type),
        })
        await db.commit()
    except Exception as e:
        print(f"[audit] {e}")


# ============================================================
# Middleware
# ============================================================

def _uzytkownik(request):
    token_str = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token_str = auth_header[7:]
    if not token_str:  # fallback: token w query param (download)
        token_str = request.query_params.get("token")
    if token_str:
        payload = decode_jwt_token(token_str)
        if payload:
            return (int(payload.get("sub", 0)) or None), payload.get("email")
    return None, None


async def audit_middleware(request, call_next):
    """Jeden wpis na udaną mutację. Zapis po odpowiedzi, w osobnej sesji."""
    method = request.method
    if method not in ("POST", "PUT", "PATCH", "DELETE"):
        return await call_next(request)

    box: dict = {}
    token = _skrzynka.set(box)
    try:
        response = await call_next(request)
    finally:
        _skrzynka.reset(token)

    if not (200 <= response.status_code < 300) or box.get("skip") or box.get("zapisane"):
        return response

    path = request.url.path
    opis = opisy.opis_sciezki(method, path)
    if opis is None:          # podgląd, synchronizacja, czat, auth — nie loguj
        return response

    user_id, user_email = _uzytkownik(request)
    orzeczenie = box.get("message") or opis.orzeczenie
    try:
        async with SessionLocal() as db:
            await db.execute(text(_INSERT), {
                "uid": user_id,
                "email": user_email,
                "action": box.get("action") or opis.akcja,
                "rtype": box.get("resource_type") or opis.typ,
                "rid": box.get("resource_id") or opis.id,
                "details": f"{method} {path}",
                "msg": zdanie(user_email, orzeczenie),
                "ch": _json(box.get("changes")),
                "area": box.get("area") or opis.obszar,
            })
            await db.commit()
    except Exception as e:
        print(f"[audit_middleware] {e}")
    return response


async def usun_stare_wpisy() -> int:
    """Retencja: kasuje wpisy starsze niż RETENCJA_MIESIECY. Zwraca liczbę usuniętych."""
    async with SessionLocal() as db:
        r = await db.execute(text(
            f"DELETE FROM {settings.TABLE_AUDIT_LOG} "
            f"WHERE created_at < NOW() - make_interval(months => :m)"
        ), {"m": RETENCJA_MIESIECY})
        await db.commit()
        return r.rowcount or 0


# ============================================================
# Pomocniki do list zmian „było → jest”
# ============================================================

def zmiany(stare: Optional[dict], nowe: dict, pola: dict) -> List[dict]:
    """Porównuje dwa słowniki po polach z `pola` = {klucz: (etykieta, formater)}.
    Zwraca [{"pole", "bylo", "jest"}] tylko dla pól, których WIDOCZNA wartość się zmieniła
    (1.0 vs 1 albo None vs "" to nie zmiana)."""
    stare = stare or {}
    out = []
    for k, (etykieta, fmt) in pola.items():
        a, b = fmt(stare.get(k)), fmt(nowe.get(k))
        if a != b:
            out.append({"pole": etykieta, "bylo": a, "jest": b})
    return out


def ile_pol(lista: List[dict]) -> str:
    n = len(lista)
    return f"{n} {opisy.plural(n, 'pole', 'pola', 'pól')}"


def _krotko(s: str, n: int = 60) -> str:
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def note_zmiany(obiekt: str, lista: List[dict], **kw) -> None:
    """Edycja z listą zmian. `obiekt` w dopełniaczu: „produktu MKch1”, „kontenera #28”.
       1 zmiana  → „zmienił „Szerokość” produktu MKch1: 180 cm → 200 cm”
       n zmian   → „zmienił 3 pola produktu MKch1” (szczegóły w rozwijanej tabelce)
       0 zmian   → bez wpisu (zapis tego samego to nie zmiana)."""
    if not lista:
        skip()
        return
    if len(lista) == 1:
        c = lista[0]
        msg = f"zmienił „{c['pole']}” {obiekt}: {_krotko(c['bylo'])} → {_krotko(c['jest'])}"
    else:
        msg = f"zmienił {ile_pol(lista)} {obiekt}"
    note(msg, changes=lista, **kw)
