"""Etykiety PDF w Supabase Storage (prywatny bucket).

Plik leży w prywatnym buckecie i nigdy nie ma publicznego adresu. Na zewnątrz
(portal, Magazyn, pole etykiety w Sellasist) idzie stały link z losowym tokenem:
    https://<portal>/drop/v1/labels/<token>
który przy każdym kliknięciu wystawia świeży podpisany adres ważny kilka minut.
Dzięki temu link w Sellasist działa, a sam plik nie wisi publicznie.

DOSTĘP — celowo BEZ klucza service_role:
  · logujemy się do Supabase Auth technicznym kontem (DROPY_STORAGE_EMAIL / _PASSWORD)
    z publicznym kluczem anon,
  · polityki RLS na storage.objects wpuszczają to konto WYŁĄCZNIE do bucketu
    `dropy-etykiety` (odczyt, zapis nowych plików, usuwanie),
  · wyciek tych danych = dostęp do etykiet, nic więcej. Baza, inne buckety
    i reszta projektu zostają poza zasięgiem.
Token sesji trzymamy w pamięci i odnawiamy logowaniem, gdy zbliża się jego koniec.

Bez zależności: czyste urllib w wątku, żeby nie dokładać paczek do serwisu.
Bliźniak portalu: dropy_service/storage.py (serwisy nic ze sobą nie dzielą).
Magazyn używa go tylko do czyszczenia starych plików.
"""

import asyncio
import json
import os
import time
import urllib.error
import urllib.request
from typing import List, Optional

BASE = os.getenv("DROPY_STORAGE_URL", "").rstrip("/")          # https://<projekt>.supabase.co
ANON = os.getenv("DROPY_STORAGE_ANON_KEY", "")                 # publiczny klucz anon
EMAIL = os.getenv("DROPY_STORAGE_EMAIL", "")                   # techniczne konto tylko do bucketu
PASSWORD = os.getenv("DROPY_STORAGE_PASSWORD", "")
BUCKET = os.getenv("DROPY_LABEL_BUCKET", "dropy-etykiety")
SIGN_SECONDS = int(os.getenv("DROPY_LABEL_LINK_SECONDS", "300"))
MAX_BYTES = 5 * 1024 * 1024

_session = {"token": "", "until": 0.0}
_lock = asyncio.Lock()


class StorageError(Exception):
    pass


def enabled() -> bool:
    return bool(BASE and ANON and EMAIL and PASSWORD)


def _http(method: str, url: str, body: Optional[bytes], headers: dict) -> tuple:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
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


async def _call(method: str, path: str, body: Optional[bytes] = None, ctype: str = "application/json") -> dict:
    for attempt in (0, 1):
        tok = await _token(force=attempt == 1)
        code, raw = await asyncio.to_thread(_http, method, f"{BASE}/storage/v1{path}", body, {
            "Authorization": f"Bearer {tok}", "apikey": ANON, "Content-Type": ctype,
        })
        if code in (400, 401, 403) and attempt == 0 and b"jwt" in raw.lower():
            continue                                  # token wygasł albo unieważniony — logujemy się ponownie, raz
        if code >= 300:
            raise StorageError(f"Storage {code}: {raw[:300].decode('utf-8', 'replace')}")
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}
    raise StorageError("Storage odrzucił token")


async def upload(path: str, data: bytes) -> None:
    # Bez x-upsert: każda etykieta ma własną, unikalną ścieżkę, więc wystarcza prawo do INSERT.
    await _call("POST", f"/object/{BUCKET}/{path}", data, "application/pdf")


async def signed_url(path: str) -> str:
    r = await _call("POST", f"/object/sign/{BUCKET}/{path}", json.dumps({"expiresIn": SIGN_SECONDS}).encode())
    url = r.get("signedURL") or r.get("signedUrl")
    if not url:
        raise StorageError(f"Storage nie zwrócił podpisanego linku: {r}")
    return f"{BASE}/storage/v1{url}" if url.startswith("/") else url


async def remove(paths: List[str]) -> None:
    if paths:
        await _call("DELETE", f"/object/{BUCKET}", json.dumps({"prefixes": paths}).encode())
