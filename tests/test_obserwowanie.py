"""Obserwowanie produktu osobno w każdej firmie (services/obserwowanie.py).

Produkt Veluxy sprzedawany też w AMH ma dać się zdjąć z obserwowanych w AMH,
a w Veluxie zostać. Stare gwiazdki (pusta lista wyłączeń) działają wszędzie.

Uruchomienie:  python3 -m pytest tests/test_obserwowanie.py -q
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

for k, v in {"DB_HOST": "localhost", "DB_PORT": "5432", "DB_NAME": "test",
             "DB_USER": "test", "DB_PASSWORD": "test", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

from services.obserwowanie import nowy_stan, obserwowany_w, ustaw_obserwowanie  # noqa: E402
from sql import SALES_QUERY  # noqa: E402


def test_stara_gwiazdka_obserwowana_wszedzie():
    for shop in ("", "amh", "acti", "veluxa"):
        assert obserwowany_w(True, None, shop)
    assert not obserwowany_w(False, None, "amh")


def test_odobserwowanie_w_jednej_firmie_zostawia_inne():
    fav, wyl = nowy_stan(True, None, "amh", on=False)
    assert (fav, wyl) == (True, ["amh"])
    assert not obserwowany_w(fav, wyl, "amh")
    assert obserwowany_w(fav, wyl, "veluxa")
    assert obserwowany_w(fav, wyl, "acti")
    assert obserwowany_w(fav, wyl, "")          # „Wszyscy” = obserwowany gdziekolwiek


def test_ponowne_obserwowanie_zdejmuje_wylaczenie():
    assert nowy_stan(True, ["amh", "acti"], "amh", on=True) == (True, ["acti"])
    assert nowy_stan(True, ["amh"], "amh", on=True) == (True, None)


def test_obserwowanie_nowego_tylko_w_tej_firmie():
    fav, wyl = nowy_stan(False, None, "acti", on=True)
    assert fav and obserwowany_w(fav, wyl, "acti")
    assert not obserwowany_w(fav, wyl, "amh")
    assert not obserwowany_w(fav, wyl, "veluxa")


def test_wylaczony_wszedzie_to_nieobserwowany():
    assert nowy_stan(True, ["amh", "acti"], "veluxa", on=False) == (False, None)


def test_wszyscy_wlacza_i_wylacza_globalnie():
    assert nowy_stan(True, ["amh"], "", on=True) == (True, None)
    assert nowy_stan(True, ["amh"], "", on=False) == (False, None)


def test_sales_query_liczy_obserwowanie_per_firma():
    assert "unwatched_shops" in SALES_QUERY
    assert ":shop = ANY(COALESCE(pa.unwatched_shops" in SALES_QUERY


class _Wynik:
    def __init__(self, wiersze):
        self._w = wiersze

    def mappings(self):
        return self._w


class _Db:
    def __init__(self, wiersze):
        self.wiersze = wiersze
        self.zapisy = []

    async def execute(self, stmt, params=None):
        if "INSERT INTO" in str(stmt):
            self.zapisy.append(params)
        return _Wynik(self.wiersze)


def test_ustaw_zapisuje_tylko_zmienione():
    db = _Db([{"sku": "A", "fav": True, "unwatched_shops": None},
              {"sku": "B", "fav": True, "unwatched_shops": ["amh"]}])
    zm = asyncio.run(ustaw_obserwowanie(db, ["A", "B", "C"], "amh", on=False))
    # B już nie był obserwowany w AMH, C nie istnieje i nie był obserwowany — bez zapisu.
    assert zm == ["A"]
    assert db.zapisy == [{"sku": "A", "fav": True, "wyl": ["amh"]}]
