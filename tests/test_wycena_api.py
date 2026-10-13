"""Zakładki „Cena” / „test-wycena” — uprawnienia i walidacja, bez bazy.

  · „Cena” (GET /api/ceny-produktu) — viewPriceSummary,
  · „test-wycena” i wszystkie zapisy — jak zakładka „Cena” (viewProductPrice + viewFinancials,
    zapis: editProductPrice),
  · kalkulator handlowca — useSalesCalculator ORAZ cena zakupu,
  · link do konkurencji tylko http(s),
  · po testach zakładki są dla zespołu: zwykły admin przechodzi, role bez uprawnień — 403.

Uruchomienie:  python3 -m pytest tests/test_wycena_api.py -q
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from config import settings  # noqa: E402
from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CenaAktualnaIn, CurrentUser, KonkurencjaIn  # noqa: E402
from security import (  # noqa: E402
    can_use_sales_calculator, can_view_price_summary, can_view_price_summary_competition,
    can_view_price_summary_cost, get_current_user,
)


class _Baza:
    async def execute(self, *a, **k):
        raise AssertionError("Bez uprawnień nie wolno nawet zajrzeć do bazy")


SZEF = "szef@firma.pl"


@pytest.fixture
def klient(monkeypatch):
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAIL", SZEF)

    async def db():
        yield _Baza()
    app.dependency_overrides[get_db] = db

    def jako(role="VIEWER", perms=None, email="x@firma.pl"):
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(id=1, email=email, role=role, perms=perms)
        return TestClient(app)
    yield jako
    app.dependency_overrides.clear()


MIN = {"sku": "ABC", "kanal": "hurt", "baza": "fifo", "marza": 20, "koszty": []}
KONK = {"sku": "ABC", "sklep": "Sklep", "cena_brutto": 100}
SZABLON = {"nazwa": "X", "marza": 20, "koszty": []}
AKT = {"sku": "ABC", "cena_brutto": 5999}


@pytest.mark.parametrize("metoda,adres,body", [
    ("get", "/api/ceny-produktu?sku=ABC", None),
    ("get", "/api/wycena?sku=ABC", None),
    ("put", "/api/wycena/cena", MIN),
    ("put", "/api/wycena/cena-aktualna", AKT),
    ("post", "/api/wycena/konkurencja", KONK),
    ("delete", "/api/wycena/konkurencja/1", None),
    ("post", "/api/wycena/szablony", SZABLON),
    ("put", "/api/wycena/szablony/1", SZABLON),
    ("delete", "/api/wycena/szablony/1", None),
])
@pytest.mark.parametrize("role", ["VIEWER", "IMPORT"])
def test_role_bez_uprawnien_403(klient, metoda, adres, body, role):
    kw = {"json": body} if body is not None else {}
    assert getattr(klient(role), metoda)(adres, **kw).status_code == 403


class _DoszloDoBazy(Exception):
    pass


@pytest.mark.parametrize("metoda,adres,body", [
    ("get", "/api/ceny-produktu?sku=ABC", None),
    ("get", "/api/wycena?sku=ABC", None),
    ("put", "/api/wycena/cena", MIN),
    ("put", "/api/wycena/cena-aktualna", AKT),
])
def test_zwykly_admin_przechodzi(klient, metoda, adres, body):
    """Koniec okresu „tylko superadmin”: admin (nie super) mija uprawnienia i dochodzi do bazy."""
    class Baza:
        async def execute(self, *a, **k):
            raise _DoszloDoBazy()

    async def db():
        yield Baza()
    k = klient("ADMIN")
    app.dependency_overrides[get_db] = db
    kw = {"json": body} if body is not None else {}
    with pytest.raises(_DoszloDoBazy):
        getattr(k, metoda)(adres, **kw)


@pytest.mark.parametrize("cena", [0, -5, 10_000_000])
def test_aktualna_cena_walidacja(cena):
    with pytest.raises(ValueError):
        CenaAktualnaIn(sku="A", cena_brutto=cena)


@pytest.mark.parametrize("metoda,adres,body", [
    ("get", "/api/wycena?sku=ABC", None),
    ("put", "/api/wycena/cena", MIN),
    ("post", "/api/wycena/konkurencja", KONK),
])
def test_ptaszek_test_ceny_nie_otwiera_wyceny(klient, metoda, adres, body):
    kw = {"json": body} if body is not None else {}
    k = klient("VIEWER", {"viewPriceSummary": True, "useSalesCalculator": True})
    assert getattr(k, metoda)(adres, **kw).status_code == 403


def test_kalkulator_wymaga_ceny_zakupu():
    bez_finansow = CurrentUser(id=1, email="s@f.pl", role="VIEWER",
                               perms={"viewFinancials": False, "viewPriceSummary": True, "useSalesCalculator": True})
    assert can_view_price_summary(bez_finansow)
    assert not can_use_sales_calculator(bez_finansow)
    z_cena_zakupu = CurrentUser(id=1, email="s@f.pl", role="VIEWER",
                                perms={"viewFinancials": False, "viewPurchasePrice": True,
                                       "viewPriceSummary": True, "useSalesCalculator": True})
    assert can_use_sales_calculator(z_cena_zakupu)
    # Sam kalkulator bez zakładki nic nie daje.
    bez_zakladki = CurrentUser(id=1, email="s@f.pl", role="VIEWER", perms={"useSalesCalculator": True})
    assert not can_use_sales_calculator(bez_zakladki)


def test_admin_ma_obie_zakladki_domyslnie():
    admin = CurrentUser(id=1, email="a@f.pl", role="ADMIN")
    assert can_view_price_summary(admin) and can_use_sales_calculator(admin)


def test_boksy_ceny_domyslnie_tylko_admin():
    admin = CurrentUser(id=1, email="a@f.pl", role="ADMIN")
    assert can_view_price_summary_cost(admin) and can_view_price_summary_competition(admin)
    # Zespół z samą zakładką nie widzi boksów, dopóki admin nie postawi ptaszków.
    zespol = CurrentUser(id=1, email="z@f.pl", role="VIEWER", perms={"viewPriceSummary": True})
    assert not can_view_price_summary_cost(zespol)
    assert not can_view_price_summary_competition(zespol)
    z_ptaszkami = CurrentUser(id=1, email="z@f.pl", role="VIEWER",
                              perms={"viewPriceSummary": True, "priceSummaryCost": True, "priceSummaryCompetition": True})
    assert can_view_price_summary_cost(z_ptaszkami)     # VIEWER ma viewFinancials → cena zakupu
    assert can_view_price_summary_competition(z_ptaszkami)


def test_boksy_ceny_mozna_zdjac():
    u = CurrentUser(id=1, email="z@f.pl", role="VIEWER",
                    perms={"viewPriceSummary": True, "useSalesCalculator": True,
                           "priceSummaryCost": False, "priceSummaryCompetition": False})
    assert not can_view_price_summary_cost(u)
    assert not can_view_price_summary_competition(u)
    # Kalkulator to osobny ptaszek — zdjęcie boksu kosztu go nie wyłącza.
    assert can_use_sales_calculator(u)


def test_boksy_ceny_wymagaja_zakladki_i_ceny_zakupu():
    bez_zakladki = CurrentUser(id=1, email="z@f.pl", role="ADMIN", perms={"viewPriceSummary": False})
    assert not can_view_price_summary_cost(bez_zakladki)
    assert not can_view_price_summary_competition(bez_zakladki)
    bez_ceny_zakupu = CurrentUser(id=1, email="z@f.pl", role="VIEWER",
                                  perms={"viewFinancials": False, "viewPriceSummary": True,
                                         "priceSummaryCost": True, "priceSummaryCompetition": True})
    assert not can_view_price_summary_cost(bez_ceny_zakupu)
    assert can_view_price_summary_competition(bez_ceny_zakupu)


@pytest.mark.parametrize("link", ["javascript:alert(1)", "ftp://x", "www.sklep.pl"])
def test_link_konkurencji_tylko_http(link):
    with pytest.raises(ValueError):
        KonkurencjaIn(sku="A", sklep="S", cena_brutto=10, link=link)


def test_link_i_nazwa_sklepu_sprzatane():
    k = KonkurencjaIn(sku="A", sklep="  Allegro   medsport ", cena_brutto=10, link="  ")
    assert k.sklep == "Allegro medsport" and k.link is None
    assert KonkurencjaIn(sku="A", sklep="S", cena_brutto=10, link="https://x.pl/a").link == "https://x.pl/a"


def test_uprawnienia_zgodne_z_frontem():
    """Nowe klucze ROLE_PERMS muszą być 1:1 w frontend/lib/permissions.js."""
    import re
    from security import ROLE_PERMS
    js = (Path(__file__).resolve().parents[1] / "frontend/lib/permissions.js").read_text()
    for rola, perms in ROLE_PERMS.items():
        linia = re.search(rf"^\s*{rola}:\s*\{{(.*)\}},?\s*$", js, re.M).group(1)
        front = {k: v == "true" for k, v in re.findall(r"(\w+):\s*(true|false)", linia)}
        assert front == perms, f"Rola {rola}: security.py i permissions.js się różnią"


def test_superadmin_przechodzi_przez_bramke(klient):
    # Zły link odrzuca walidacja (422), a nie bramka (403) — superadmin jest wpuszczony.
    r = klient("ADMIN", email=SZEF).post("/api/wycena/konkurencja", json={**KONK, "link": "javascript:alert(1)"})
    assert r.status_code == 422


def test_allegro_porownujemy_z_minimum_allegro():
    """Sprzedaż z Allegro poniżej minimum Allegro (wyższego) to alarm, choć jest nad minimum detalu."""
    from datetime import date, datetime, timedelta, timezone
    from models import CenaMinimalnaOut
    from routers.wycena import _kanal_sprzedazy
    ustaw = datetime.now(timezone.utc) - timedelta(days=10)
    cm = lambda kanal, brutto: CenaMinimalnaOut(id=1, kanal=kanal, cena_netto=brutto / 1.23, cena_brutto=brutto,  # noqa: E731
                                                vat=23, baza="fifo", koszt_bazy=1, marza=1, ustawiono=ustaw)
    dzis = date.today()
    wiersze = [
        {"data": dzis, "kanal": "Allegro", "szt": 1, "netto": 0, "brutto": 3300},   # < 3500 (min Allegro) → alarm
        {"data": dzis, "kanal": "Erli", "szt": 1, "netto": 0, "brutto": 3100},      # > 3000 (min detal) → OK
        {"data": dzis, "kanal": "Klaudia", "szt": 1, "netto": 0, "brutto": 2900},   # < 3000 → alarm
    ]
    out = _kanal_sprzedazy(wiersze, "brutto", cm("detal", 3000), 3000, cm("min_allegro", 3500))
    assert out.ponizej_z == 3 and out.ponizej_ile == 2
    assert [p.kanal for p in out.ponizej] == ["Allegro", "Klaudia"]
    # Bez minimum Allegro — Allegro liczy się jak reszta detalu.
    out = _kanal_sprzedazy(wiersze, "brutto", cm("detal", 3000), 3000)
    assert out.ponizej_ile == 1


def test_zapis_aktualnej_ceny_liczy_netto(klient, monkeypatch):
    """Brutto z formularza, netto z VAT produktu; nowy wiersz w dzienniku, nic nie nadpisujemy."""
    import routers.wycena as wyc
    from types import SimpleNamespace

    async def produkt(db, sku, shop="", allowed=None):
        return SimpleNamespace(sku="SZP3")

    async def vat(db, sku, shop=""):
        return {"vat": 8.0, "zrodlo": "test"}
    monkeypatch.setattr(wyc, "get_product", produkt)
    monkeypatch.setattr(wyc, "vat_produktu", vat)

    zapytania = []

    class Wynik:
        def mappings(self):
            return self

        def all(self):
            return []

    class Baza:
        async def execute(self, sql, params=None):
            zapytania.append((str(sql), params or {}))
            return Wynik()

        async def commit(self):
            pass

    async def db():
        yield Baza()
    k = klient("ADMIN")
    app.dependency_overrides[get_db] = db
    r = k.put("/api/wycena/cena-aktualna", json={"sku": "szp3", "cena_brutto": 5999})
    assert r.status_code == 200
    (_, p), = [(q, p) for q, p in zapytania if "INSERT INTO app_cena_aktualna" in q]
    assert p["sku"] == "SZP3" and p["brutto"] == 5999 and p["vat"] == 8.0
    assert p["netto"] == round(5999 / 1.08, 2)
