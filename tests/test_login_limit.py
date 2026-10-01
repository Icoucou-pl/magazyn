"""Limit nieudanych logowań (services/login_limit.py).

Uruchomienie:  python3 -m pytest tests/test_login_limit.py -q
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services import login_limit as ll  # noqa: E402


@pytest.fixture(autouse=True)
def czysto(monkeypatch):
    ll.reset()
    teraz = [1000.0]
    monkeypatch.setattr(ll.time, "monotonic", lambda: teraz[0])
    yield teraz
    ll.reset()


def test_piec_zlych_hasel_blokuje_konto_do_konca_okna(czysto):
    for _ in range(ll.MAX_PER_EMAIL - 1):
        ll.register_failure("Jan@Firma.pl", "1.1.1.1")
    assert ll.retry_after("jan@firma.pl", "1.1.1.1") == 0
    ll.register_failure("jan@firma.pl ", "1.1.1.1")
    assert ll.retry_after("JAN@firma.pl", "2.2.2.2") > 0       # inny adres, to samo konto
    czysto[0] += ll.WINDOW_S
    assert ll.retry_after("jan@firma.pl", "1.1.1.1") == 0      # okno minęło


def test_udane_logowanie_zeruje_licznik_konta():
    for _ in range(ll.MAX_PER_EMAIL - 1):
        ll.register_failure("a@b.pl", "1.1.1.1")
    ll.register_success("a@b.pl")
    ll.register_failure("a@b.pl", "1.1.1.1")
    assert ll.retry_after("a@b.pl", "1.1.1.1") == 0


def test_jeden_adres_ip_nie_przeczesze_wielu_kont():
    for i in range(ll.MAX_PER_IP):
        ll.register_failure(f"konto{i}@b.pl", "6.6.6.6")
    assert ll.retry_after("nowe@b.pl", "6.6.6.6") > 0
    assert ll.retry_after("nowe@b.pl", "7.7.7.7") == 0
