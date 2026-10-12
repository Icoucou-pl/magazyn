"""Kalkulator wyceny (services/wycena.py): marża, potem koszty „+” w zł i w %."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.wycena import BladWyceny, Koszt, wylicz_wycene  # noqa: E402


def test_sama_marza():
    w = wylicz_wycene(60, 40, [], 23)
    assert w.po_marzy == 100
    assert w.netto == 100
    assert w.brutto == 123
    assert w.marza_zl == 40


def test_przyklad_erli_marza_zostaje_nietknieta():
    # Po marży 4000 zł, prowizja 5% od netto: 4000 ÷ 0,95, a nie 4000 + 5%.
    w = wylicz_wycene(3000, 25, [Koszt("Prowizja Erli", "proc", 5, "netto")], 23)
    assert w.po_marzy == 4000
    assert w.netto == 4210.53
    assert w.koszty[0].kwota == 210.53
    assert round(w.netto - w.koszty[0].kwota, 2) == 4000


def test_prowizja_od_brutto_zabiera_wiecej():
    w = wylicz_wycene(100, 0, [Koszt("Allegro", "proc", 10, "brutto")], 23)
    # netto = 100 ÷ (1 − 0,1 × 1,23)
    assert w.netto == round(100 / (1 - 0.123), 2)
    assert w.koszty[0].kwota == round(0.10 * w.brutto, 2)
    # Po odjęciu prowizji od brutto zostaje koszt (± zaokrąglenie)
    assert abs(w.netto - w.koszty[0].kwota - 100) < 0.02


def test_koszty_zl_i_procent_razem():
    w = wylicz_wycene(182.40, 25, [Koszt("Wysyłka", "zl", 18), Koszt("Prowizja", "proc", 8, "brutto")], 23)
    assert w.po_marzy == 243.2
    assert w.netto == round((243.2 + 18) / (1 - 0.08 * 1.23), 2)
    zostaje = w.netto - sum(k.kwota for k in w.koszty)
    assert abs(zostaje - 243.2) < 0.02


@pytest.mark.parametrize("koszt,marza,koszty", [
    (0, 20, []),
    (100, 100, []),
    (100, -1, []),
    (100, 20, [Koszt("x", "proc", 90, "brutto")]),
    (100, 20, [Koszt("x", "zl", -5)]),
    (100, 20, [Koszt("x", "kg", 5)]),
])
def test_bledne_dane(koszt, marza, koszty):
    with pytest.raises(BladWyceny):
        wylicz_wycene(koszt, marza, koszty, 23)


def test_koszt_do_wyceny_kolejnosc():
    from services.wycena import baza_do_wyceny
    # Na stanie — FIFO, nawet gdy coś płynie i była starsza dostawa.
    assert baza_do_wyceny({"fifo": 182.4, "srednia": 176.9, "najblizsza": 193.3, "ostatnia": 180}) == "fifo"
    # Sample sprowadzany pierwszy raz: nic na stanie, płynie (EFK1_cz).
    assert baza_do_wyceny({"najblizsza": 2012.11}) == "najblizsza"
    # Wyprzedany (KPn1): ostatnia dostawa z importem, nie cena z faktury.
    assert baza_do_wyceny({"ostatnia": 1420.67}) == "ostatnia"
    # Sama średnia nie jest domyślną bazą; bez żadnej dostawy — koszt ręczny.
    assert baza_do_wyceny({"srednia": 100}) is None
    assert baza_do_wyceny({}) is None
