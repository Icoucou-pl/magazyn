"""Stan konta w kilku walutach (services/stan_konta.py, routers/bank.py).

Reguły właściciela:
- suma w zł = Σ kwota × kurs NBP z dnia roboczego przed datą stanu,
- kurs zamrożony: ta sama data → kurs zapisany wcześniej, nowy tylko dla nowej waluty,
- debet na subkoncie odejmuje się od sumy (do zera przycina dopiero wykres),
- stary wpis bez linijek = jedna linijka w zł.

Uruchomienie:  python3 -m pytest tests/test_stan_konta.py -q
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
from pydantic import ValidationError  # noqa: E402

import services.stan_konta as sk  # noqa: E402
from models import BankBalanceIn, BankBalanceLineIn  # noqa: E402
from routers.bank import _bal_out, _opis_kwoty  # noqa: E402

PT = date(2026, 1, 9)    # piątek — notowanie dla stanu z soboty 10.01


def linia(cur, amount, label=None):
    return BankBalanceLineIn(currency=cur, amount=amount, label=label)


def test_suma_w_zlotych_z_kilku_subkont():
    kursy = {"EUR": (4.2650, PT), "USD": (3.9120, PT)}
    wiersze, suma = sk.przelicz(
        [linia("PLN", 120000), linia("EUR", 15000, "EUR 1"), linia("EUR", 2300, "EUR 2"), linia("USD", 8000)],
        kursy,
    )
    assert [w["amount_pln"] for w in wiersze] == [120000.0, 63975.0, 9809.5, 31296.0]
    assert suma == 225080.5
    assert wiersze[0]["rate"] == 1.0 and wiersze[0]["rate_date"] is None
    assert wiersze[1]["rate_date"] == PT and wiersze[2]["position"] == 2


def test_debet_odejmuje_sie_od_sumy():
    _, suma = sk.przelicz([linia("PLN", 1000), linia("EUR", -1000)], {"EUR": (4.265, PT)})
    assert suma == -3265.0


def test_brak_kursu_to_blad_nie_zero():
    with pytest.raises(sk.BrakKursu):
        sk.przelicz([linia("CZK", 100)], {})


def test_zamrozony_kurs_wygrywa_a_nowa_waluta_idzie_do_nbp(monkeypatch):
    pytania = []

    async def kursy_przed(db, pary):
        pary = list(pary)
        pytania.extend(pary)
        return {(w, d): (date(2026, 1, 9), 0.17) for w, d in pary}

    monkeypatch.setattr(sk.fx, "kursy_przed", kursy_przed)
    dzien = date(2026, 1, 10)
    kursy = asyncio.run(sk.kursy_dla(None, ["PLN", "EUR", "CZK"], dzien, {"EUR": (4.1, date(2026, 1, 9))}))
    assert kursy["EUR"] == (4.1, date(2026, 1, 9))      # zamrożony, NBP nie pytany
    assert kursy["CZK"] == (0.17, date(2026, 1, 9))
    assert pytania == [("CZK", dzien)]


def test_nbp_bez_kursu_zglasza_walute(monkeypatch):
    async def kursy_przed(db, pary):
        return {}

    monkeypatch.setattr(sk.fx, "kursy_przed", kursy_przed)
    with pytest.raises(sk.BrakKursu, match="USD"):
        asyncio.run(sk.kursy_dla(None, ["USD"], date(2026, 1, 10)))


def test_walidacja_wpisu():
    assert BankBalanceLineIn(currency=" czk ", amount=1).currency == "CZK"
    with pytest.raises(ValidationError):
        BankBalanceLineIn(currency="GBP", amount=1)
    with pytest.raises(ValidationError):
        BankBalanceIn(firma_slug="acti", balance_date=date(2026, 1, 10))
    # Stary kształt (sama kwota w zł) dalej przechodzi.
    assert BankBalanceIn(firma_slug="AMH", balance_date=date(2026, 1, 10), amount_pln=5).firma_slug == "amh"


def test_stary_wpis_bez_linijek_to_jedna_linijka_w_zlotych():
    r = {"id": 1, "firma_slug": "amh", "balance_date": date(2026, 1, 10), "amount_pln": 5000,
         "note": None, "created_at": None, "updated_at": None}
    out = _bal_out(r)
    assert len(out.lines) == 1
    assert out.lines[0].currency == "PLN" and out.lines[0].amount == 5000 and out.amount_pln == 5000


def test_opis_w_dzienniku():
    w, s = sk.przelicz([linia("PLN", 100)], {})
    assert _opis_kwoty(w, s) == "100,00 zł"
    w, s = sk.przelicz([linia("PLN", 100), linia("EUR", 10, "EUR 1")], {"EUR": (4.0, PT)})
    assert _opis_kwoty(w, s) == "140,00 zł (100,00 PLN, EUR 1: 10,00 EUR)"
