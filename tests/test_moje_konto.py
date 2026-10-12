"""Moje konto: PATCH /auth/me/name (własne imię i nazwisko) i walidacja nazwy w PATCH /users/{id}.

Bazę podmieniamy atrapą, która zapamiętuje zapytania — sprawdzamy, że zapisujemy
przycięte imię, tylko swoje konto, i że pustej nazwy nie da się zapisać.

Uruchomienie:  python3 -m pytest tests/test_moje_konto.py -q
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CurrentUser  # noqa: E402
from security import get_current_user  # noqa: E402


class _Wynik:
    def __init__(self, wartosc):
        self.wartosc = wartosc

    def scalar(self):
        return self.wartosc

    def mappings(self):
        return self

    def first(self):
        return None


class AtrapaDb:
    def __init__(self, stare):
        self.stare = stare
        self.zapytania = []

    async def execute(self, sql, params=None):
        self.zapytania.append((str(sql), params or {}))
        return _Wynik(self.stare)

    async def commit(self):
        pass

    async def rollback(self):
        pass

    def updaty(self):
        return [(q, p) for q, p in self.zapytania if q.lstrip().upper().startswith("UPDATE") and "full_name" in q]


@pytest.fixture
def klient():
    def zrob(stare, user=None):
        db = AtrapaDb(stare)

        async def get():
            yield db
        app.dependency_overrides[get_db] = get
        app.dependency_overrides[get_current_user] = lambda: user or CurrentUser(id=7, email="a@b.pl", role="VIEWER")
        return TestClient(app), db
    yield zrob
    app.dependency_overrides.clear()


def test_zmiana_wlasnej_nazwy_zapisuje_przycieta(klient):
    c, db = klient("Szymon")
    r = c.patch("/api/auth/me/name", json={"full_name": "  Szymon Iwanczuk "})
    assert r.status_code == 204
    (q, p), = db.updaty()
    assert p == {"n": "Szymon Iwanczuk", "id": 7}


def test_ta_sama_nazwa_bez_zapisu(klient):
    c, db = klient("Szymon Iwanczuk")
    assert c.patch("/api/auth/me/name", json={"full_name": "Szymon Iwanczuk"}).status_code == 204
    assert db.updaty() == []


@pytest.mark.parametrize("nazwa", ["", "   "])
def test_pusta_nazwa_odrzucona(klient, nazwa):
    c, db = klient("Szymon")
    assert c.patch("/api/auth/me/name", json={"full_name": nazwa}).status_code in (400, 422)
    assert db.updaty() == []


def test_admin_nie_ustawi_innemu_pustej_nazwy(klient, monkeypatch):
    import routers.users as users

    async def guard(db, uid, admin, **kw):
        return "x@b.pl", "VIEWER"
    monkeypatch.setattr(users, "_guard_target", guard)
    c, db = klient(None, CurrentUser(id=1, email="admin@b.pl", role="ADMIN"))
    assert c.patch("/api/users/5", json={"full_name": "   "}).status_code == 400
    assert db.updaty() == []
