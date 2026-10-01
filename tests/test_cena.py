"""Testy zakładki „Cena": rozkład stanu, FIFO, średnia, szacunki, odstające kontenery, kalkulator.

Dostawy są zmyślone, liczby dobrane tak, żeby dało się je sprawdzić w pamięci.

Uruchomienie:  python3 -m pytest tests/test_cena.py -q
"""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.cena import BladCeny, Dostawa, policz_koszty, wylicz_cene  # noqa: E402


def d(item, dzien, szt, fv, koszt=None, u_nas=True):
    return Dostawa(item_id=item, container_id=item, container_number=f"TEST{item:07d}",
                   data=date(2026, 1, 1).replace(month=dzien), data_zrodlo="delivered",
                   szt=szt, u_nas=u_nas, cena_fv_pln=fv, koszt_jednostkowy=koszt)


def test_stan_rozkladany_od_najnowszej_i_fifo_to_najstarsza_z_pozostalych():
    ds = [d(1, 1, 100, 100, 130), d(2, 4, 100, 100, 120), d(3, 7, 50, 100, 110)]
    w = policz_koszty(ds, stan=120)
    na = {x.item_id: x.na_stanie for x in w.dostawy}
    assert na == {3: 50, 2: 70, 1: 0}
    assert w.fifo == 120 and w.fifo_item_id == 2
    assert w.srednia == round((50 * 110 + 70 * 120) / 120, 2)
    assert w.ostatnia == 110
    assert (w.min, w.max) == (110, 130)
    assert w.poza_dostawami == 0


def test_kontener_w_drodze_nie_bierze_udzialu_w_rozkladzie():
    ds = [d(1, 3, 100, 100, 120), d(2, 9, 80, 100, None, u_nas=False)]
    w = policz_koszty(ds, stan=60)
    assert {x.item_id: x.na_stanie for x in w.dostawy} == {2: 0, 1: 60}
    assert w.ostatnia == 120, "ostatnia dostawa to ostatnia, która już jest u nas"


def test_szacunek_z_narzutu_rozliczonych_dostaw_tego_sku():
    # rozliczone: 100 → 130 (+30%) i 100 → 134 (+34%), po 100 szt → średni narzut 32%
    ds = [d(1, 1, 100, 100, 130), d(2, 3, 100, 100, 134), d(3, 8, 40, 90)]
    w = policz_koszty(ds, stan=40)
    nowa = next(x for x in w.dostawy if x.item_id == 3)
    assert nowa.szacunek and w.narzut_zrodlo == "sku"
    assert w.sredni_narzut_proc == 32.0
    assert nowa.koszt == round(90 * 1.32, 2)
    assert w.srednia_szacunek


def test_bez_rozliczonych_dostaw_szacunek_z_narzutu_globalnego():
    w = policz_koszty([d(1, 5, 10, 200)], stan=10, narzut_globalny_proc=25)
    assert w.narzut_zrodlo == "wszystkie" and w.dostawy[0].koszt == 250.0
    assert w.min is None and w.max is None, "min/max tylko z rozliczonych"


def test_odstajacy_kontener_oznaczony_i_pominiety_w_srednim_narzucie():
    ds = [d(1, 1, 100, 100, 148), d(2, 3, 100, 100, 132), d(3, 5, 100, 100, 134),
          d(4, 7, 100, 100, 131), d(5, 9, 50, 100)]
    w = policz_koszty(ds, stan=50)
    odst = [x.item_id for x in w.dostawy if x.odstaje]
    assert odst == [1]
    assert w.sredni_narzut_proc == round((132 + 134 + 131) / 300 * 100 - 100, 2)
    assert w.max == 148, "odstający dalej widoczny w min/max — ma rzucać się w oczy"


def test_przy_dwoch_dostawach_nie_szukamy_odstajacych():
    w = policz_koszty([d(1, 1, 10, 100, 150), d(2, 3, 10, 100, 120)], stan=5)
    assert not any(x.odstaje for x in w.dostawy)


def test_stan_wiekszy_niz_dostawy_daje_nadwyzke_i_uwage():
    w = policz_koszty([d(1, 2, 30, 100, 125)], stan=50)
    assert w.poza_dostawami == 20 and w.uwagi
    assert w.fifo == 125


def test_zerowy_stan_nie_ma_fifo_ani_sredniej():
    w = policz_koszty([d(1, 2, 30, 100, 125)], stan=0)
    assert w.fifo is None and w.srednia is None
    assert w.ostatnia == 125


def test_kalkulator_marza_od_ceny():
    c = wylicz_cene(100, "marza", 35, wysylka=30)
    assert c.netto == 200.0 and c.brutto == 246.0
    assert c.zysk == 70.0 and c.marza_proc == 35.0


def test_kalkulator_narzut_od_kosztu_z_prowizja():
    c = wylicz_cene(100, "narzut", 30, prowizja_proc=10)
    # netto = 130 / 0,9 = 144,44; prowizja 14,44; zysk = 144,44 − 100 − 14,44 = 30
    assert c.netto == 144.44 and c.prowizja_zl == 14.44
    assert c.zysk == 30.0


def test_kalkulator_odrzuca_marze_100_proc():
    with pytest.raises(BladCeny):
        wylicz_cene(100, "marza", 90, prowizja_proc=10)
    with pytest.raises(BladCeny):
        wylicz_cene(0, "narzut", 10)
