"""Kurs NBP „z dnia roboczego przed płatnością” — cofanie się przez weekendy i święta.

HTTP do NBP podmieniamy atrapą, która udaje API tabeli A: zwraca notowania tylko z dni
roboczych (bez weekendów i świąt), a dla okna bez żadnego notowania — 404, jak prawdziwe NBP.

Uruchomienie:  python3 -m pytest tests/test_kursy_nbp.py -q
"""

import asyncio
import io
import json
import os
import sys
import urllib.error
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import pytest  # noqa: E402

import services.fx as fx  # noqa: E402

SWIETA = {date(2025, 12, 25), date(2025, 12, 26), date(2026, 1, 1), date(2026, 1, 6),
          date(2026, 4, 6), date(2026, 5, 1)}


def notowanie(d: date) -> float:
    return round(3.6 + d.toordinal() % 100 / 1000, 4)   # każdy dzień inny kurs


@pytest.fixture
def nbp(monkeypatch):
    """Atrapa urlopen: /rates/a/usd/OD/DO/ → notowania z dni roboczych w oknie."""
    zapytania = []

    def urlopen(req, timeout=None, context=None):
        url = req.full_url
        zapytania.append(url)
        od, do = [date.fromisoformat(x) for x in url.split("/usd/")[1].split("/")[:2]]
        dni = [od + timedelta(days=i) for i in range((do - od).days + 1)]
        rates = [{"effectiveDate": d.isoformat(), "mid": notowanie(d)}
                 for d in dni if d.weekday() < 5 and d not in SWIETA]
        if not rates:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b"404 NotFound"))
        return io.BytesIO(json.dumps({"rates": rates}).encode())

    monkeypatch.setattr(fx.urllib.request, "urlopen", urlopen)
    return zapytania


def kurs(d):
    return asyncio.run(fx.kurs_nbp_przed("USD", d))


def test_zwykly_dzien_to_kurs_z_dnia_poprzedniego(nbp):
    assert kurs(date(2026, 6, 17)) == (date(2026, 6, 16), notowanie(date(2026, 6, 16)))


def test_poniedzialek_bierze_piatek(nbp):
    assert kurs(date(2026, 6, 15))[0] == date(2026, 6, 12)


def test_po_wielkanocy_cofamy_sie_przez_poniedzialek_wielkanocny_i_weekend(nbp):
    # wtorek 7.04.2026: poniedziałek 6.04 to święto, 4–5.04 weekend → piątek 3.04
    assert kurs(date(2026, 4, 7))[0] == date(2026, 4, 3)


def test_po_nowym_roku_bierze_ostatni_dzien_starego_roku(nbp):
    # piątek 2.01.2026: 1.01 święto → środa 31.12.2025
    assert kurs(date(2026, 1, 2))[0] == date(2025, 12, 31)


def test_wybor_z_listy_notowan_pomija_dzien_platnosci():
    n = [(date(2026, 6, 12), 3.70), (date(2026, 6, 15), 3.71)]
    assert fx.wybierz_kurs_przed(n, date(2026, 6, 15)) == (date(2026, 6, 12), 3.70)
    assert fx.wybierz_kurs_przed(n, date(2026, 6, 12)) is None
