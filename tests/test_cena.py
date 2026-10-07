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
    # partia bez SAD jest informacyjna — nie wchodzi do średniej
    assert w.srednia is None and w.srednia_pominieto_szt == 40


def test_srednia_tylko_z_rozliczonych_partii_na_stanie():
    # na stanie: 40 szt bez SAD (najnowsza) + 60 szt rozliczonych po 120 i 20 szt po 130
    ds = [d(1, 1, 50, 100, 130), d(2, 4, 60, 100, 120), d(3, 8, 40, 95)]
    w = policz_koszty(ds, stan=120)
    assert w.srednia == round((60 * 120 + 20 * 130) / 80, 2)
    assert w.srednia_szt == 80 and w.srednia_pominieto_szt == 40
    assert (w.min, w.max) == (120, 130), "min/max bez szacunku"
    assert w.ostatnia == 120 and w.ostatnia_item_id == 2, "ostatnia = najnowsza rozliczona"


def test_srednia_pomija_rozliczone_partie_juz_wyprzedane():
    # jak SZP3: na stanie 154 = 84 z najnowszej + 70 z kolejnej; kwietniowa partia wyprzedana
    ds = [d(1, 4, 45, 100, 1798.54), d(2, 8, 84, 100, 1814.48), d(3, 9, 84, 100, 1879.62)]
    w = policz_koszty(ds, stan=154)
    assert w.srednia == round((84 * 1879.62 + 70 * 1814.48) / 154, 2)
    assert w.srednia_szt == 154


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


def test_dostawa_krajowa_bez_narzutu_importu_i_liczona_do_sredniej():
    """Materac z Rehanu (PLN): koszt = cena z FV + transport/szt, bez +10% importu,
    i wchodzi do FIFO, średniej, ostatniej, min i max — jak dostawa z odprawą."""
    kraj = d(1, 4, 100, 310)
    kraj.krajowa, kraj.transport_szt = True, 8.0
    w = policz_koszty([kraj, d(2, 1, 50, 100, 130)], stan=80, narzut_globalny_proc=10.3)
    x = {y.item_id: y for y in w.dostawy}
    assert x[1].koszt == 318.0 and not x[1].szacunek
    assert w.fifo == 318.0 and w.srednia == 318.0 and w.ostatnia == 318.0
    assert w.max == 318.0 and w.min == 130
    assert w.srednia_pominieto_szt == 0


def test_dostawa_krajowa_nie_psuje_narzutu_importu():
    kraj = d(1, 6, 100, 310)
    kraj.krajowa = True
    w = policz_koszty([kraj, d(2, 3, 100, 100, 120), d(3, 9, 10, 100, None, u_nas=False)], stan=0)
    assert w.sredni_narzut_proc == 20.0 and w.narzut_zrodlo == "sku"
    assert {y.item_id: y.koszt for y in w.dostawy}[3] == 120.0


# ── koszt z metody szefa (services/koszt_kontenera.py) ──────

def test_koszt_z_nowej_metody_i_szacunek_z_niezaplaconego_balance():
    # najstarsza partia ma pewny koszt 120, najnowsza — szacunek 115 (balance niezapłacony)
    ds = [d(1, 2, 100, 100, 120),
          Dostawa(item_id=2, container_id=2, container_number="TEST0000002", data=date(2026, 8, 1),
                  data_zrodlo="delivered", szt=50, u_nas=True, cena_fv_pln=95, koszt_jednostkowy=115,
                  koszt_szacunek=True)]
    w = policz_koszty(ds, stan=120)
    szac = next(x for x in w.dostawy if x.item_id == 2)
    assert szac.koszt == 115 and szac.szacunek, "koszt z nowej metody, ale podpisany jako szacunek"
    assert w.fifo == 120, "FIFO bierze najstarszą partię na stanie, także obok szacunku"
    assert w.srednia == 120 and w.srednia_pominieto_szt == 50, "szacunek nie miesza w średniej"
    assert w.ostatnia == 120 and (w.min, w.max) == (120, 120)
    assert w.sredni_narzut_proc == 20.0, "narzut tylko z pewnych dostaw importu"


def test_wbita_dostawa_z_przyszla_data_zajmuje_stan_ale_nie_wchodzi_do_kafli():
    # Jak F1: stary kontener (295 szt, koszt 274,03, zostało 69) i nowy policzony 261,83 —
    # wbity do „w drodze”, ale wejście na magazyn dopiero w grudniu (towar w produkcji).
    stary = Dostawa(item_id=1, container_id=1, container_number="MEDU5327848", data=date(2026, 5, 22),
                    data_zrodlo="delivered", szt=295, u_nas=True, cena_fv_pln=247.37, koszt_jednostkowy=274.03)
    nowy = Dostawa(item_id=2, container_id=2, container_number="QCM2260902", data=date(2026, 12, 21),
                   data_zrodlo="estimate", szt=300, u_nas=True, cena_fv_pln=253.21, koszt_jednostkowy=261.83)
    w = policz_koszty([stary, nowy], stan=369, dzis=date(2026, 10, 7))
    na = {x.item_id: x.na_stanie for x in w.dostawy}
    assert na == {2: 300, 1: 69}, "nowy zabiera swoje sztuki z „w drodze”"
    assert nowy.przyszla and not stary.przyszla
    assert w.srednia == 274.03 and w.srednia_szt == 69
    assert w.fifo == 274.03 and w.ostatnia == 274.03
    assert (w.min, w.max) == (274.03, 274.03), "przyszła dostawa nie wchodzi do najniższej / najwyższej"
    assert w.przyszle_szt == 300


def test_po_dacie_wejscia_dostawa_wraca_do_wyliczen():
    nowy = Dostawa(item_id=2, container_id=2, container_number="X", data=date(2026, 12, 21),
                   data_zrodlo="estimate", szt=300, u_nas=True, cena_fv_pln=253.21, koszt_jednostkowy=261.83)
    w = policz_koszty([nowy], stan=300, dzis=date(2026, 12, 22))
    assert not nowy.przyszla and w.srednia == 261.83 and w.przyszle_szt == 0
