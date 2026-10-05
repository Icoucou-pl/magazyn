"""Nagłówek karty produktu: GET /products/{sku}/koszt.

Ptaszek „Cena zakupu produktu" (viewPurchasePrice) ma wystarczyć BEZ danych finansowych —
po to istnieje. Bez niego i bez finansów: 403. Rachunek (_policz) podmieniamy atrapą, bo
testy chodzą bez bazy.

Uruchomienie:  python3 -m pytest tests/test_koszt_naglowek.py -q
"""

import os
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import routers.cena as cena  # noqa: E402
from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CurrentUser  # noqa: E402
from security import get_current_user  # noqa: E402

BEZ_FINANSOW = {"viewFinancials": False, "viewPurchasePrice": False, "viewProductPrice": False}


@pytest.fixture
def klient(monkeypatch):
    async def atrapa(db, sku, shop, user):
        p = SimpleNamespace(sku="SZP3")
        w = SimpleNamespace(srednia=1850.01)
        return p, 154, w, {}, "acti", "fakturownia", {"szp3": 1700.0}
    monkeypatch.setattr(cena, "_policz", atrapa)

    async def db():
        yield None
    app.dependency_overrides[get_db] = db
    yield lambda perms: (app.dependency_overrides.__setitem__(
        get_current_user, lambda: CurrentUser(id=1, email="a@b.pl", role="VIEWER", perms=perms)),
        TestClient(app))[1]
    app.dependency_overrides.clear()


def test_sam_ptaszek_ceny_zakupu_wystarcza(klient):
    r = klient({**BEZ_FINANSOW, "viewPurchasePrice": True}).get("/api/products/SZP3/koszt")
    assert r.status_code == 200
    assert r.json() == {"srednia": 1850.01, "erp_cena": 1700.0, "erp_zrodlo": "fakturownia"}


def test_finanse_bez_ptaszka_tez_widza(klient):
    r = klient({**BEZ_FINANSOW, "viewFinancials": True}).get("/api/products/SZP3/koszt")
    assert r.status_code == 200


def test_bez_finansow_i_bez_ptaszka_403(klient):
    r = klient(BEZ_FINANSOW).get("/api/products/SZP3/koszt")
    assert r.status_code == 403


def test_zakladka_cena_dalej_wymaga_swojego_ptaszka(klient):
    r = klient({**BEZ_FINANSOW, "viewPurchasePrice": True}).get("/api/products/SZP3/cena")
    assert r.status_code == 403
