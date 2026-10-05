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
        w = SimpleNamespace(fifo=1814.48, srednia=1850.01)
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
    assert r.json() == {"fifo": 1814.48, "srednia": 1850.01, "erp_cena": 1700.0, "erp_zrodlo": "fakturownia"}


def test_finanse_bez_ptaszka_tez_widza(klient):
    r = klient({**BEZ_FINANSOW, "viewFinancials": True}).get("/api/products/SZP3/koszt")
    assert r.status_code == 200


def test_bez_finansow_i_bez_ptaszka_403(klient):
    r = klient(BEZ_FINANSOW).get("/api/products/SZP3/koszt")
    assert r.status_code == 403


def test_zakladka_cena_dalej_wymaga_swojego_ptaszka(klient):
    r = klient({**BEZ_FINANSOW, "viewPurchasePrice": True}).get("/api/products/SZP3/cena")
    assert r.status_code == 403


# ── Lista „Produkty": GET /cena/lista ────────────────────────
@pytest.fixture
def lista(monkeypatch):
    from datetime import date
    from services.cena import Dostawa

    async def produkty(db, include, shop):
        return [SimpleNamespace(sku="SZP3", stock=154, stock_in_transit_wbite=0),
                SimpleNamespace(sku="BEZ", stock=5, stock_in_transit_wbite=0)]

    async def vaty(db, shop):
        return {"szp3": 8.0}

    async def dostawy(db):
        d = lambda i, m, szt, koszt: Dostawa(  # noqa: E731
            item_id=i, container_id=i, container_number=f"K{i}", data=date(2026, m, 1),
            data_zrodlo="delivered", szt=szt, u_nas=True, cena_fv_pln=1600, koszt_jednostkowy=koszt)
        return {"szp3": [d(1, 4, 45, 1798.54), d(2, 8, 84, 1814.48), d(3, 9, 84, 1879.62)]}

    async def narzut(db):
        return None

    monkeypatch.setattr(cena, "fetch_products", produkty)
    monkeypatch.setattr(cena, "vat_produktow", vaty)
    monkeypatch.setattr(cena, "_dostawy_wszystkie", dostawy)
    monkeypatch.setattr(cena, "_narzut_globalny", narzut)

    async def db():
        yield None
    app.dependency_overrides[get_db] = db
    yield lambda perms: (app.dependency_overrides.__setitem__(
        get_current_user, lambda: CurrentUser(id=1, email="a@b.pl", role="VIEWER", perms=perms)),
        TestClient(app))[1]
    app.dependency_overrides.clear()


def test_lista_liczy_fifo_i_srednia_jak_karta(lista):
    r = lista({**BEZ_FINANSOW, "viewPurchasePrice": True}).get("/api/cena/lista")
    assert r.status_code == 200
    po_sku = {x["sku"]: x for x in r.json()}
    assert po_sku["SZP3"] == {"sku": "SZP3", "vat": 8.0, "fifo": 1814.48,
                              "srednia": round((84 * 1879.62 + 70 * 1814.48) / 154, 2)}
    assert po_sku["BEZ"] == {"sku": "BEZ", "vat": 23.0, "fifo": None, "srednia": None}


def test_lista_bez_uprawnien_daje_sam_vat(lista):
    r = lista(BEZ_FINANSOW).get("/api/cena/lista")
    assert r.status_code == 200
    assert {x["sku"]: (x["vat"], x["fifo"], x["srednia"]) for x in r.json()} == {
        "SZP3": (8.0, None, None), "BEZ": (23.0, None, None)}
