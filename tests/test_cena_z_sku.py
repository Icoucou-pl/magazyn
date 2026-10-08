"""Powiązanie „cena z SKU": Szp3_szpital nie istnieje w Fakturowni, bierze koszt z Szp3.

Sam SQL (SALES_QUERY, prod_prices) sprawdzony na lokalnym Postgresie; tu bez bazy pilnujemy
mapowania w _koszt_erp (nagłówek karty „Fakturownia: X zł" i zakładka „Cena").

Uruchomienie:  python3 -m pytest tests/test_cena_z_sku.py -q
"""

import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import routers.odprawy as odprawy  # noqa: E402


class Sesja:
    """Atrapa: zapytanie o powiązania zwraca szp3_szpital → szp3."""
    async def execute(self, stmt, params=None):
        wiersze = [{"k": "szp3_szpital", "z": "szp3"}] if "szp3_szpital" in params["k"] else []
        return SimpleNamespace(mappings=lambda: SimpleNamespace(all=lambda: wiersze))


def test_powiazane_sku_dostaje_cene_wzorca(monkeypatch):
    pytane = {}

    async def wlasny(db, slug, skus):
        pytane["skus"] = list(skus)
        return "fakturownia", {"szp3": 1700.0}
    monkeypatch.setattr(odprawy, "_koszt_erp_wlasny", wlasny)

    zrodlo, ceny = asyncio.run(odprawy._koszt_erp(Sesja(), "acti", ["SZP3_szpital"]))
    assert pytane["skus"] == ["szp3", "szp3_szpital"]       # ERP pytany też o wzorzec
    assert (zrodlo, ceny["szp3_szpital"]) == ("fakturownia", 1700.0)


def test_bez_powiazania_bez_zmian(monkeypatch):
    async def wlasny(db, slug, skus):
        return "fakturownia", {"szp3": 1700.0}
    monkeypatch.setattr(odprawy, "_koszt_erp_wlasny", wlasny)
    assert asyncio.run(odprawy._koszt_erp(Sesja(), "acti", ["Szp3"])) == ("fakturownia", {"szp3": 1700.0})
