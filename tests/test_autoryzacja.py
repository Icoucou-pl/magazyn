"""Strażnik autoryzacji: każdy endpoint API wymaga zalogowania, poza jawną listą wyjątków.

Test nie łączy się z bazą — przechodzi po drzewie zależności FastAPI każdej trasy
i sprawdza, czy gdzieś w nim siedzi get_current_user (require_perm, require_admin
i pozostałe strażniki też na nim stoją). Nowy endpoint bez autoryzacji wywali test,
zanim trafi na produkcję. Świadomie publiczny endpoint dopisz do PUBLICZNE z powodem.

Uruchomienie:  python3 -m pytest tests/test_autoryzacja.py -q
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# config.py wymaga konfiguracji bazy przy imporcie; połączenie i tak nie powstaje.
for k, v in {"DB_HOST": "localhost", "DB_PORT": "5432", "DB_NAME": "test",
             "DB_USER": "test", "DB_PASSWORD": "test", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

from fastapi.routing import APIRoute  # noqa: E402

from main import app  # noqa: E402
from security import get_current_user  # noqa: E402


# (metoda, ścieżka) → dlaczego bez logowania
PUBLICZNE = {
    ("GET", "/api/health"): "health-check Railwaya",
    ("POST", "/api/auth/login"): "logowanie",
    ("GET", "/api/product-photos/{pid}/{content_hash}/thumb"): "zdjęcia w <img>, adres z hashem treści",
    ("GET", "/api/product-photos/{pid}/{content_hash}/full"): "zdjęcia w <img>, adres z hashem treści",
}


def _wymaga_logowania(dependant) -> bool:
    if dependant.call is get_current_user:
        return True
    return any(_wymaga_logowania(d) for d in dependant.dependencies)


def _trasy():
    for r in app.routes:
        if isinstance(r, APIRoute) and r.path.startswith("/api"):
            for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
                yield m, r.path, r


def test_kazdy_endpoint_api_wymaga_logowania():
    bez_auth = [f"{m} {p}" for m, p, r in _trasy()
                if (m, p) not in PUBLICZNE and not _wymaga_logowania(r.dependant)]
    assert not bez_auth, "Endpointy bez logowania (dodaj Depends(get_current_user) " \
                         "albo wpisz do PUBLICZNE z powodem):\n" + "\n".join(bez_auth)


def test_lista_wyjatkow_jest_aktualna():
    istniejace = {(m, p) for m, p, _ in _trasy()}
    nieaktualne = [f"{m} {p}" for m, p in PUBLICZNE if (m, p) not in istniejace]
    assert not nieaktualne, "PUBLICZNE wskazuje nieistniejące trasy:\n" + "\n".join(nieaktualne)
