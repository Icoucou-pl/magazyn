"""„Podsumowanie sprzedaży” na pulpicie: GET /api/sales-summary.

Liczymy jak panel Sellasista — wszystkie statusy, dzień po dniu, per firma + „razem”.
Baza jest podmieniona atrapą, która oddaje gotowe wiersze i zapamiętuje zapytanie.

Uruchomienie:  python3 -m pytest tests/test_podsumowanie_sprzedazy.py -q
"""

import asyncio
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import services.podsumowanie_sprzedazy as ps  # noqa: E402
from config import settings  # noqa: E402
from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CurrentUser  # noqa: E402
from security import get_current_user  # noqa: E402

D1, D2, D3 = date(2026, 10, 10), date(2026, 10, 11), date(2026, 10, 12)


class _Wynik:
    def __init__(self, wiersze):
        self._w = wiersze

    def mappings(self):
        return self

    def all(self):
        return self._w


class _Db:
    def __init__(self, wiersze):
        self.wiersze, self.sql, self.params = wiersze, None, None

    async def execute(self, sql, params=None):
        self.sql, self.params = str(sql), params
        return _Wynik(self.wiersze)


WIERSZE = [
    {"shop": "amh", "dzien": D1, "zamowien": 3, "wartosc": 300.0, "bez_kursu": 0},
    {"shop": "acti", "dzien": D1, "zamowien": 2, "wartosc": 150.5, "bez_kursu": 1},
    {"shop": "veluxa", "dzien": D3, "zamowien": 1, "wartosc": 99.99, "bez_kursu": 0},
]


def test_dni_bez_zamowien_maja_zera_a_razem_to_suma_firm():
    w = ps.zbuduj_serie(WIERSZE, ["amh", "acti", "veluxa"], D1, D3)
    assert [s["shop"] for s in w["series"]] == ["amh", "acti", "veluxa", ""]
    amh = w["series"][0]["points"]
    assert [p["date"] for p in amh] == ["2026-10-10", "2026-10-11", "2026-10-12"]
    assert [p["orders"] for p in amh] == [3, 0, 0]
    razem = w["series"][3]
    assert [p["orders"] for p in razem["points"]] == [5, 0, 1]
    assert [p["value"] for p in razem["points"]] == [450.5, 0, 99.99]
    assert razem["missing_rates"] == 1


def test_jedna_firma_bez_serii_razem():
    w = ps.zbuduj_serie(WIERSZE, ["veluxa"], D1, D3)
    assert [s["shop"] for s in w["series"]] == ["veluxa"]


def test_wszystkie_statusy_bez_whitelisty_finansow(monkeypatch):
    """Sellasist liczy też „nowe” i „za pobraniem” — whitelista zrealizowanych tu nie wchodzi."""
    monkeypatch.setattr(settings, "PODSUMOWANIE_POMIJANE_STATUSY", "")
    db = _Db([])
    asyncio.run(ps.podsumowanie(db, ["amh"], 30, dzis=D3))
    assert "Doręczone" not in db.sql and "Wysłane" not in db.sql
    assert "pomijane" not in db.params
    assert db.params["od"] == date(2026, 9, 13) and db.params["do_"] == date(2026, 10, 13)


def test_pomijane_statusy_ida_jako_parametr(monkeypatch):
    monkeypatch.setattr(settings, "PODSUMOWANIE_POMIJANE_STATUSY", "Anulowane, Usunięte ")
    db = _Db([])
    asyncio.run(ps.podsumowanie(db, ["amh"], 30, dzis=D3))
    assert db.params["pomijane"] == ["Anulowane", "Usunięte"]
    assert "Anulowane" not in db.sql


@pytest.fixture
def klient():
    db = _Db(WIERSZE)

    async def get():
        yield db
    app.dependency_overrides[get_db] = get

    def zrob(perms=None, scope=None):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id=1, email="a@b.pl", role="ADMIN", perms=perms, company_scope=scope)
        return TestClient(app), db
    yield zrob
    app.dependency_overrides.clear()


def test_endpoint_oddaje_wszystkie_firmy_i_razem(klient):
    c, db = klient()
    r = c.get("/api/sales-summary?days=30")
    assert r.status_code == 200
    assert [s["shop"] for s in r.json()["series"]] == ["amh", "acti", "veluxa", ""]
    assert db.params["firmy"] == ["amh", "acti", "veluxa"]


def test_zakres_firm_zaweza_serie(klient):
    c, db = klient(scope=["acti"])
    r = c.get("/api/sales-summary")
    assert [s["shop"] for s in r.json()["series"]] == ["acti"]
    assert db.params["firmy"] == ["acti"]


def test_bez_finansow_kwoty_sa_ukryte(klient):
    c, _ = klient(perms={"viewFinancials": False})
    s = c.get("/api/sales-summary").json()["series"]
    assert all(p["value"] is None for x in s for p in x["points"])
    assert sum(p["orders"] for x in s if x["shop"] == "" for p in x["points"]) == 6


def test_za_dlugie_okno_odrzucone(klient):
    c, _ = klient()
    assert c.get("/api/sales-summary?days=999").status_code == 422
