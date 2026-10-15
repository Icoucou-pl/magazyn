"""Wartość magazynu w czasie (GET /api/stock-value-history, services/wartosc_magazynu.py).

Sprawdzamy dwie rzeczy: samo cofanie się w czasie (czysta funkcja) i to, skąd bierze się
ruch dla której firmy — AMH z Sellasista i kontenerów, Acti/Veluxa z dziennika Fakturowni.
Baza jest atrapą: rozpoznaje zapytanie po tabeli i oddaje przygotowane wiersze.

Uruchomienie:  python3 -m pytest tests/test_wartosc_magazynu.py -q
"""

import asyncio
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import services.wartosc_magazynu as wm  # noqa: E402
from config import settings  # noqa: E402

DZIS = date(2026, 10, 15)


def _d(n):
    return DZIS - timedelta(days=n)


# ── odtworz_wstecz ─────────────────────────────────────────

def test_sprzedaz_wraca_na_polke_a_dostawa_znika():
    # Dziś 10 szt. Wczoraj sprzedano 3 (ruch −3), przedwczoraj przyszła dostawa 5 (ruch +5).
    ruch = {_d(1): {"a": -3.0}, _d(2): {"a": 5.0}}
    pkt = wm.odtworz_wstecz({"a": 10.0}, {"a": 2.0}, ruch, DZIS, 3)
    assert [p["date"] for p in pkt] == [_d(3).isoformat(), _d(2).isoformat(), _d(1).isoformat(), DZIS.isoformat()]
    # stan na koniec dnia: d0=10, d1=10 (ruch z d1 cofamy dopiero przy przejściu na d2), d2=13, d3=8
    assert [p["units"] for p in pkt] == [8, 13, 10, 10]
    assert pkt[-1]["value"] == 20.0 and pkt[0]["value"] == 16.0


def test_ujemny_stan_liczy_sie_jako_zero_ale_nie_psuje_kroku_wstecz():
    # Dostawa 10 szt wczoraj przy dzisiejszym stanie 4 → przedwczoraj −6 (pokazujemy 0),
    # a sprzedaż 8 szt z dnia −2 wraca → dzień −3 ma 2 szt, nie 8.
    ruch = {_d(1): {"a": 10.0}, _d(2): {"a": -8.0}}
    pkt = wm.odtworz_wstecz({"a": 4.0}, {"a": 1.0}, ruch, DZIS, 3)
    assert [p["units"] for p in pkt] == [2, 0, 4, 4]


def test_ruch_spoza_katalogu_i_z_przyszlosci():
    ruch = {DZIS + timedelta(days=2): {"a": -1.0}, _d(1): {"obcy": -100.0}}
    pkt = wm.odtworz_wstecz({"a": 5.0}, {"a": 1.0}, ruch, DZIS, 1)
    # przyszła sprzedaż 1 szt jest już „w dzisiejszym stanie" → cofamy ją od razu
    assert [p["units"] for p in pkt] == [6, 6]


# ── wybór źródeł per firma ────────────────────────────────

class _Db:
    """Atrapa bazy: zapamiętuje zapytania i oddaje wiersze wg tabeli w zapytaniu."""

    def __init__(self, sprzedaz=(), kontenery=(), fakturownia=()):
        self.wiersze = {"sprzedaz": list(sprzedaz), "kontenery": list(kontenery), "fakturownia": list(fakturownia)}
        self.zapytania = []

    async def execute(self, sql, params=None):
        s = str(sql)
        if wm.TABELA_RUCHY in s:
            rodzaj = "fakturownia"
        elif settings.TABLE_CONTAINER_ITEMS in s:
            rodzaj = "kontenery"
        else:
            rodzaj = "sprzedaz"
        self.zapytania.append((rodzaj, s, dict(params or {})))
        w = self.wiersze[rodzaj]
        return SimpleNamespace(mappings=lambda: w)


def _uruchom(monkeypatch, db, shop, produkty):
    async def fake_fetch(_db, _statusy, _shop):
        return produkty
    monkeypatch.setattr(wm, "fetch_products", fake_fetch)
    monkeypatch.setattr(wm, "date", SimpleNamespace(today=lambda: DZIS))
    return asyncio.run(wm.historia_wartosci(db, shop, 2, False))


def _p(sku, stock, cena=1.0):
    return SimpleNamespace(sku=sku, stock=stock, purchase_price=cena, is_favorite=False)


def test_veluxa_tylko_z_fakturowni(monkeypatch):
    db = _Db(fakturownia=[{"sku_norm": "a", "d": _d(1), "qty": -7}])
    w = _uruchom(monkeypatch, db, "veluxa", [_p("A", 3)])
    assert [z[0] for z in db.zapytania] == ["fakturownia"]
    _, sql, params = db.zapytania[0]
    assert params["shop"] == "veluxa" and params["od"] == _d(2)
    assert "w_drodze" in sql and "is_internal" in sql
    assert [p["units"] for p in w["points"]] == [10, 3, 3]


def test_amh_bez_zmian_bez_fakturowni(monkeypatch):
    db = _Db(sprzedaz=[{"sku_norm": "a", "sale_date": _d(1), "qty": 2}],
             kontenery=[{"sku_norm": "a", "deliv_date": _d(2), "qty": 5}])
    w = _uruchom(monkeypatch, db, "amh", [_p("A", 3)])
    assert [z[0] for z in db.zapytania] == ["sprzedaz", "kontenery"]
    assert all(z[2]["shop"] == "amh" for z in db.zapytania)
    assert [p["units"] for p in w["points"]] == [5, 3, 3]  # d−2: 3 + 2 (sprzedaż z d−1 wraca); dostawa z d−2 cofa się dopiero na d−3


def test_wszystkie_firmy_amh_z_sellasista_reszta_z_fakturowni(monkeypatch):
    db = _Db(sprzedaz=[{"sku_norm": "a", "sale_date": _d(1), "qty": 1}],
             fakturownia=[{"sku_norm": "b", "d": _d(1), "qty": -4}])
    w = _uruchom(monkeypatch, db, "", [_p("A", 1), _p("B", 1)])
    rodzaje = [z[0] for z in db.zapytania]
    assert rodzaje == ["sprzedaz", "kontenery", "fakturownia"]
    # Sellasist i kontenery zawężone do AMH (Acti/Veluxa idą z Fakturowni — bez dubla)
    assert db.zapytania[0][2]["shop"] == "amh" and db.zapytania[1][2]["shop"] == "amh"
    # Fakturownia: wszystkie firmy poza AMH; przekazania w grupie odfiltrowuje warunek na :shop = ''
    assert db.zapytania[2][2]["shop"] == ""
    assert [p["units"] for p in w["points"]] == [7, 2, 2]
