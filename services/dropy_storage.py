"""Etykiety PDF w Supabase Storage (prywatny bucket).

Plik leży w prywatnym buckecie i nigdy nie ma publicznego adresu. Na zewnątrz
(portal, Magazyn, pole etykiety w Sellasist) idzie stały link z losowym tokenem:
    https://<portal>/drop/v1/labels/<token>
który przy każdym kliknięciu wystawia świeży podpisany adres ważny kilka minut.
Dzięki temu link w Sellasist działa, a sam plik nie wisi publicznie.

Bez zależności: czyste urllib w wątku, żeby nie dokładać paczek do serwisu.
Bliźniak portalu: dropy_service/storage.py (serwisy nic ze sobą nie dzielą).
Magazyn używa go tylko do czyszczenia starych plików.
"""

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import List, Optional

BASE = os.getenv("DROPY_STORAGE_URL", "").rstrip("/")          # https://<projekt>.supabase.co
KEY = os.getenv("DROPY_STORAGE_KEY", "")                       # klucz service_role
BUCKET = os.getenv("DROPY_LABEL_BUCKET", "dropy-etykiety")
SIGN_SECONDS = int(os.getenv("DROPY_LABEL_LINK_SECONDS", "300"))
MAX_BYTES = 5 * 1024 * 1024


class StorageError(Exception):
    pass


def enabled() -> bool:
    return bool(BASE and KEY)


def _call(method: str, path: str, body: Optional[bytes] = None, ctype: str = "application/json",
          extra: Optional[dict] = None) -> dict:
    req = urllib.request.Request(f"{BASE}/storage/v1{path}", data=body, method=method, headers={
        "Authorization": f"Bearer {KEY}", "apikey": KEY, "Content-Type": ctype, **(extra or {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise StorageError(f"Storage {e.code}: {e.read()[:300].decode('utf-8', 'replace')}")
    except urllib.error.URLError as e:
        raise StorageError(f"Storage niedostępny: {e.reason}")
    try:
        return json.loads(raw or b"{}")
    except ValueError:
        return {}


async def upload(path: str, data: bytes) -> None:
    await asyncio.to_thread(_call, "POST", f"/object/{BUCKET}/{path}", data, "application/pdf",
                            {"x-upsert": "true", "Cache-Control": "no-store"})


async def signed_url(path: str) -> str:
    r = await asyncio.to_thread(_call, "POST", f"/object/sign/{BUCKET}/{path}",
                                json.dumps({"expiresIn": SIGN_SECONDS}).encode())
    url = r.get("signedURL") or r.get("signedUrl")
    if not url:
        raise StorageError(f"Storage nie zwrócił podpisanego linku: {r}")
    return f"{BASE}/storage/v1{url}" if url.startswith("/") else url


async def remove(paths: List[str]) -> None:
    if paths:
        await asyncio.to_thread(_call, "DELETE", f"/object/{BUCKET}", json.dumps({"prefixes": paths}).encode())
