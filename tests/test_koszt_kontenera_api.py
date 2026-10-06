"""Uprawnienia kosztu jednostkowego v2, zakładki SAD i słownika stawek cła — bez bazy.

  · zakładka „Koszt jednostkowy” — jak dotąd: viewLandedCost + viewFinancials,
  · zakładka „SAD” i jej endpointy — tylko superadmin (403 dla admina),
  · ręczna stawka w słowniku — superadmin; kod CN produktu — editProducts,
  · lista Ustawienia → Stawki cła — tylko obserwowane, nowości i sample.

Uruchomienie:  python3 -m pytest tests/test_koszt_kontenera_api.py -q
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

from config import settings  # noqa: E402
from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CurrentUser  # noqa: E402
from routers.containers import _mask_sad  # noqa: E402
from security import get_current_user  # noqa: E402

SZEF = "szef@firma.pl"


class _Wynik:
    def all(self):
        return [("94035000", 0.0, "sad"), ("94052190", 2.7, "reczna")]


class _Baza:
    """Atrapa sesji: słownik stawek i nic więcej."""
    async def execute(self, *a, **k):
        return _Wynik()


@pytest.fixture
def klient(monkeypatch):
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAIL", SZEF)

    async def db():
        yield _Baza()
    app.dependency_overrides[get_db] = db

    def jako(email="admin@firma.pl", role="ADMIN", perms=None):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(id=1, email=email, role=role, perms=perms)
        return TestClient(app)
    yield jako
    app.dependency_overrides.clear()


# ── zakładka SAD: tylko superadmin ──────────────────────────

@pytest.mark.parametrize("metoda,adres", [
    ("get", "/api/kontenery/1/odprawa"),
    ("delete", "/api/odprawy/1"),
])
def test_endpointy_sad_zamkniete_dla_admina(klient, metoda, adres):
    r = getattr(klient(), metoda)(adres)
    assert r.status_code == 403


def test_przeliczenie_kursu_sad_zamkniete_dla_admina(klient):
    assert klient().post("/api/odprawy/1/kurs-towaru", json={"kurs": 3.6}).status_code == 403


def test_podglad_sad_zamkniety_dla_admina(klient):
    r = klient().post("/api/kontenery/1/odprawa/podglad", files={"plik": ("a.xml", b"<x/>", "text/xml")})
    assert r.status_code == 403


def test_stan_sad_na_liscie_kontenerow_widzi_tylko_superadmin(monkeypatch):
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAIL", SZEF)
    k = SimpleNamespace(koszt_status="zapisana")
    _mask_sad([k], CurrentUser(id=1, email="admin@firma.pl", role="ADMIN"))
    assert k.koszt_status is None
    k = SimpleNamespace(koszt_status="zapisana")
    _mask_sad([k], CurrentUser(id=2, email=SZEF, role="ADMIN"))
    assert k.koszt_status == "zapisana"


# ── zakładka „Koszt jednostkowy” ────────────────────────────

def test_koszt_kontenera_wymaga_uprawnienia(klient):
    assert klient(role="VIEWER").get("/api/kontenery/1/koszt").status_code == 403
    assert klient(role="IMPORT").put("/api/kontenery/1/koszt", json={}).status_code == 403
    assert klient(role="VIEWER").post("/api/kontenery/1/koszt/podglad", json={}).status_code == 403


def test_poprawka_z_ujemna_liczba_odrzucona(klient):
    r = klient().put("/api/kontenery/1/koszt", json={"fracht_pln": -5})
    assert r.status_code == 422


# ── słownik stawek i kod CN ─────────────────────────────────

def test_reczna_stawka_tylko_superadmin(klient):
    assert klient().put("/api/stawki-cn/94035000", json={"stawka": 1}).status_code == 403


def test_kod_cn_wymaga_edycji_produktow(klient):
    r = klient(role="VIEWER").put("/api/products/SZP3/kod-cn", json={"kod_cn": "9402 90 00"})
    assert r.status_code == 403


def test_lista_stawek_to_obserwowane_nowosci_i_sample(klient, monkeypatch):
    def p(sku, fav=False, new=False, sample=False, cn=None):
        return SimpleNamespace(sku=sku, name=sku.lower(), firma_slug="amh", is_favorite=fav, is_new=new,
                               is_sample=sample, kod_cn=cn)

    async def produkty(db, include, shop):
        return [p("OBS", fav=True, cn="9403500000"), p("NOWY", new=True), p("PROBKA", sample=True, cn="94052190"),
                p("OUTLET", cn="94035000")]
    import services.products
    monkeypatch.setattr(services.products, "fetch_products", produkty)

    r = klient().get("/api/stawki-cn")
    assert r.status_code == 200
    po = {x["sku"]: x for x in r.json()}
    assert set(po) == {"OBS", "NOWY", "PROBKA"}, "outlet i reszta katalogu nie trafiają na listę"
    assert (po["OBS"]["stawka"], po["OBS"]["zrodlo"]) == (0.0, "sad"), "kod TARIC (10 cyfr) bierze stawkę z 8 cyfr CN"
    assert (po["PROBKA"]["stawka"], po["PROBKA"]["zrodlo"]) == (2.7, "reczna")
    assert po["NOWY"]["kod_cn"] is None and po["NOWY"]["stawka"] is None
    assert [x["sku"] for x in r.json()][0] == "NOWY", "braki na górze listy"


# ── plakietki na liście kontenerów ──────────────────────────

def test_dokumenty_wyslane_klika_tylko_edycja_kontenerow(klient):
    r = klient(role="VIEWER").post("/api/containers/1/dokumenty", json={"value": True})
    assert r.status_code == 403


def test_plakietka_kosztu_tylko_dla_widzacych_koszt():
    import asyncio
    from routers.containers import _dolicz_koszt
    k = SimpleNamespace(id=1, koszt_v2=None)
    # bez uprawnienia nawet nie liczymy (db=None nie jest dotykane)
    asyncio.run(_dolicz_koszt(None, [k], CurrentUser(id=1, email="v@firma.pl", role="VIEWER")))
    assert k.koszt_v2 is None


def test_wspolna_faktura_wymaga_uprawnien_kosztu(klient):
    assert klient(role="VIEWER").get("/api/kontenery/1/rozliczenie-razem").status_code == 403
    assert klient(role="IMPORT").put("/api/kontenery/1/rozliczenie-razem", json={"kontenery": [2]}).status_code == 403
