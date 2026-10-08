"""Zmiana SKU sampla: POST /products/{sku}/zmien-sku (tylko super-admin).

Bazy nie ma — sprawdzamy, jakie zapytania endpoint wysyła i kiedy odmawia. Atrapa sesji
zapamiętuje SQL; „zajęte” tabele udają, że nowe SKU ma już tam dane.

Uruchomienie:  python3 -m pytest tests/test_zmiana_sku.py -q
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

import routers.products as products  # noqa: E402
from config import settings  # noqa: E402
from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CurrentUser  # noqa: E402
from security import get_current_user  # noqa: E402

SUPER = "szef@firma.pl"
TABELE = [("app_container_items", "sku"), ("app_product_attrs", "sku"),
          ("app_product_ceny", "sku"), ("app_product_ceny", "sku_canon")]


class Sesja:
    def __init__(self, zajete=()):
        self.sql, self.zajete, self.commit_ok = [], set(zajete), False

    async def execute(self, stmt, params=None):
        q = str(stmt)
        self.sql.append((q, params or {}))
        trafienie = q.startswith("SELECT 1") and any(f'"{t}"' in q for t in self.zajete)
        return SimpleNamespace(first=lambda: (1,) if trafienie else None, rowcount=2)

    async def commit(self):
        self.commit_ok = True


@pytest.fixture
def uruchom(monkeypatch):
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAIL", SUPER)

    async def tabele(db):
        return TABELE
    monkeypatch.setattr(products, "_tabele_z_sku", tabele)

    def start(*, zrodla=(), w_aplikacji=True, zajete=(), email=SUPER):
        async def check(db, sku):
            return {"external_sources": list(zrodla), "exists_in_app": w_aplikacji}
        monkeypatch.setattr(products, "_delete_check", check)
        sesja = Sesja(zajete)

        async def db():
            yield sesja
        app.dependency_overrides[get_db] = db
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(id=1, email=email, role="ADMIN")
        return TestClient(app), sesja
    yield start
    app.dependency_overrides.clear()


def test_przepisuje_sku_we_wszystkich_tabelach(uruchom):
    c, s = uruchom()
    r = c.post("/api/products/Lxs1g/zmien-sku", json={"nowe_sku": " Lxs1cz_g "})
    assert r.status_code == 200, r.text
    assert r.json()["sku"] == "Lxs1cz_g" and r.json()["stare_sku"] == "Lxs1g"
    update = [(q, p) for q, p in s.sql if q.startswith("UPDATE")]
    assert len(update) == len(TABELE)
    assert all(p == {"nowe": "Lxs1cz_g", "stare": "Lxs1g"} for _, p in update)
    # sku_canon dostaje postać kanoniczną, zwykłe sku — pisownię wpisaną przez użytkownika
    canon = next(q for q, _ in update if "SET sku_canon" in q)
    assert "LOWER(TRIM(:nowe))" in canon and "sku_canon = LOWER(TRIM(:stare))" in canon
    assert s.commit_ok


def test_odmawia_gdy_nowe_sku_ma_juz_dane(uruchom):
    c, s = uruchom(zajete={"app_product_attrs"})
    r = c.post("/api/products/Lxs1g/zmien-sku", json={"nowe_sku": "Lxs1cz_g"})
    assert r.status_code == 409 and "app_product_attrs" in r.json()["detail"]
    assert not any(q.startswith("UPDATE") for q, _ in s.sql) and not s.commit_ok


def test_sama_wielkosc_liter_nie_jest_kolizja(uruchom):
    c, s = uruchom(zajete={"app_product_attrs"})   # stare SKU „zajmuje” tę samą tabelę
    r = c.post("/api/products/Lxs1g/zmien-sku", json={"nowe_sku": "LXS1G"})
    assert r.status_code == 200


def test_sku_z_subiekta_nie_do_zmiany(uruchom):
    c, s = uruchom(zrodla=["Subiekt"])
    r = c.post("/api/products/YREH1/zmien-sku", json={"nowe_sku": "YREH2"})
    assert r.status_code == 409 and "Subiekt" in r.json()["detail"]
    assert not s.commit_ok


def test_tylko_super_admin(uruchom):
    c, s = uruchom(email="ktos@firma.pl")
    r = c.post("/api/products/Lxs1g/zmien-sku", json={"nowe_sku": "Lxs1cz_g"})
    assert r.status_code == 404 and not s.sql
