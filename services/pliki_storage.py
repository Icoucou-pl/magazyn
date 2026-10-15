"""Zakładka „Pliki” — pliki w Supabase Storage (prywatny bucket).

Dlaczego Storage, a nie baza: stare załączniki kontenerów siedzą w bazie (BYTEA). Przy
kilkudziesięciu plikach to nie boli, ale „Pliki” mają ich mieć dużo (ZIP-y, skany, XML) —
baza by puchła, a z nią każdy backup i każde zapytanie. Storage to zwykły dysk na pliki;
w bazie zostaje tylko opis (nazwa, folder, kto dodał) w app_pliki.

Plik nigdy nie ma publicznego adresu. Pobieranie idzie przez nasz backend
(GET /api/pliki/{id}/pobierz), który sprawdza uprawnienia i dopiero wtedy czyta plik z bucketu.

DOSTĘP — jak w services/dropy_storage.py, celowo BEZ klucza service_role:
  · logujemy się do Supabase Auth OSOBNYM technicznym kontem (PLIKI_STORAGE_EMAIL / _PASSWORD)
    z publicznym kluczem anon,
  · polityki RLS (sql/2026-10-pliki.sql) wpuszczają to konto WYŁĄCZNIE do bucketu
    `magazyn-pliki`. Wyciek tych danych = dostęp do plików, nic więcej.
Adres projektu i klucz anon są te same co dla etykiet dropów, więc domyślnie bierzemy je stamtąd.
"""

import asyncio
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import List, Optional

BASE = (os.getenv("PLIKI_STORAGE_URL") or os.getenv("DROPY_STORAGE_URL", "")).rstrip("/")
ANON = os.getenv("PLIKI_STORAGE_ANON_KEY") or os.getenv("DROPY_STORAGE_ANON_KEY", "")
EMAIL = os.getenv("PLIKI_STORAGE_EMAIL", "")
PASSWORD = os.getenv("PLIKI_STORAGE_PASSWORD", "")
BUCKET = os.getenv("PLIKI_BUCKET", "magazyn-pliki")

_session = {"token": "", "until": 0.0}
_lock = asyncio.Lock()


class StorageError(Exception):
    pass


def enabled() -> bool:
    return bool(BASE and ANON and EMAIL and PASSWORD)


def _http(method: str, url: str, body: Optional[bytes], headers: dict) -> tuple:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        # Długi limit czasu: plik do 50 MB idzie w jedną stronę jednym żądaniem.
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        raise StorageError(f"Storage niedostępny: {e.reason}")


def _login() -> dict:
    code, raw = _http("POST", f"{BASE}/auth/v1/token?grant_type=password",
                      json.dumps({"email": EMAIL, "password": PASSWORD}).encode(),
                      {"apikey": ANON, "Content-Type": "application/json"})
    if code != 200:
        raise StorageError(f"Logowanie do Storage nieudane ({code}): {raw[:200].decode('utf-8', 'replace')}")
    return json.loads(raw)


async def _token(force: bool = False) -> str:
    async with _lock:
        if force or not _session["token"] or time.time() > _session["until"]:
            s = await asyncio.to_thread(_login)
            _session["token"] = s["access_token"]
            # Odnawiamy minutę przed końcem, żeby żądanie nie trafiło w wygasły token.
            _session["until"] = time.time() + max(int(s.get("expires_in", 3600)) - 60, 30)
        return _session["token"]


async def _call(method: str, path: str, body: Optional[bytes] = None,
                ctype: str = "application/json") -> bytes:
    """Surowa odpowiedź Storage (bajty). Wygasły token → jedno ponowne logowanie."""
    if not enabled():
        raise StorageError("Przechowywanie plików nie jest skonfigurowane (zmienne PLIKI_STORAGE_*)")
    for attempt in (0, 1):
        tok = await _token(force=attempt == 1)
        code, raw = await asyncio.to_thread(_http, method, f"{BASE}/storage/v1{path}", body, {
            "Authorization": f"Bearer {tok}", "apikey": ANON, "Content-Type": ctype,
        })
        if code in (400, 401, 403) and attempt == 0 and b"jwt" in raw.lower():
            continue
        if code >= 300:
            raise StorageError(f"Storage {code}: {raw[:300].decode('utf-8', 'replace')}")
        return raw
    raise StorageError("Storage odrzucił token")


def _sciezka(path: str) -> str:
    return urllib.parse.quote(path, safe="/")


async def upload(path: str, data: bytes, content_type: str) -> None:
    # Bez x-upsert: każdy plik dostaje własną, losową ścieżkę, więc wystarcza prawo do INSERT.
    await _call("POST", f"/object/{BUCKET}/{_sciezka(path)}", data, content_type or "application/octet-stream")


async def download(path: str) -> bytes:
    return await _call("GET", f"/object/authenticated/{BUCKET}/{_sciezka(path)}")


async def signed_url(path: str, *, pobierz_jako: Optional[str] = None, sekundy: int = 300) -> str:
    """Krótko ważny link prosto do pliku w Supabase. Przeglądarka ściąga plik bezpośrednio,
    bez przechodzenia bajtów przez nasz backend (szybciej, zwłaszcza przy dużych ZIP-ach).
    `pobierz_jako` = nazwa pliku do zapisania; bez niej przeglądarka otwiera plik (podgląd PDF)."""
    raw = await _call("POST", f"/object/sign/{BUCKET}/{_sciezka(path)}", json.dumps({"expiresIn": sekundy}).encode())
    try:
        r = json.loads(raw or b"{}")
    except ValueError:
        r = {}
    url = r.get("signedURL") or r.get("signedUrl")
    if not url:
        raise StorageError(f"Storage nie zwrócił podpisanego linku: {raw[:200]!r}")
    url = f"{BASE}/storage/v1{url}" if url.startswith("/") else url
    if pobierz_jako:
        url += ("&" if "?" in url else "?") + "download=" + urllib.parse.quote(pobierz_jako)
    return url


async def remove(paths: List[str]) -> None:
    # Storage przyjmuje listę naraz; dzielimy na paczki, żeby duży kosz nie zrobił gigantycznego żądania.
    for i in range(0, len(paths), 500):
        part = paths[i:i + 500]
        if part:
            await _call("DELETE", f"/object/{BUCKET}", json.dumps({"prefixes": part}).encode())
