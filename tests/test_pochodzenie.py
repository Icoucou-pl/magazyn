"""Pasek „Ten towar sprowadziło i opłaciło AMH": GET /products/{sku}/pochodzenie.

Zapytanie do bazy podmieniamy atrapą (testy chodzą bez bazy) — sprawdzamy, kiedy
endpoint w ogóle pyta i że oddaje samą nazwę spółki, bez żadnych kwot.

Uruchomienie:  python3 -m pytest tests/test_pochodzenie.py -q
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import services.fakturownia_history as fh  # noqa: E402
from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CurrentUser  # noqa: E402
from security import get_current_user  # noqa: E402


@pytest.fixture
def klient(monkeypatch):
    pytania = []

    async def atrapa(db, slug, sku):
        pytania.append((slug, sku))
        return "AMH" if slug == "acti" else None
    monkeypatch.setattr(fh, "od_spolki_z_grupy", atrapa)

    async def db():
        yield None
    app.dependency_overrides[get_db] = db
    # Zwykły viewer bez żadnych uprawnień finansowych — pasek ma widzieć każdy.
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id=1, email="a@b.pl", role="VIEWER", perms={"viewFinancials": False, "viewPurchasePrice": False})
    yield TestClient(app), pytania
    app.dependency_overrides.clear()


def test_acti_od_amh_bez_kwot(klient):
    c, pytania = klient
    r = c.get("/api/products/MSzp_s1/pochodzenie?shop=acti")
    assert r.status_code == 200
    assert r.json() == {"od_spolki": "AMH"}
    assert pytania == [("acti", "MSzp_s1")]


@pytest.mark.parametrize("shop", ["", "amh", "nieznana"])
def test_amh_i_wszystkie_nie_pytaja_bazy(klient, shop):
    c, pytania = klient
    r = c.get(f"/api/products/MSzp_s1/pochodzenie?shop={shop}")
    assert r.status_code == 200
    assert r.json() == {"od_spolki": None}
    assert pytania == []
