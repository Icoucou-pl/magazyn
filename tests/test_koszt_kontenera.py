"""Testy kosztu jednostkowego „metodą szefa” (services/koszt_kontenera.py).

Liczby dobrane tak, żeby dało się je sprawdzić w pamięci: kurs 4,00, okrągłe CBM.

Uruchomienie:  python3 -m pytest tests/test_koszt_kontenera.py -q
"""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.koszt_kontenera import (  # noqa: E402
    LENMAR_KONTENER, LENMAR_ZGLOSZENIE, Grupa, Kontener, Platnosc, Pozycja, policz,
)


def zap(kwota, kurs, typ="zaliczka", dzien=date(2026, 6, 15), waluta="USD"):
    return Platnosc(typ=typ, kwota=kwota, waluta=waluta, data=dzien, kurs=kurs)


def poz(item, szt, unit_cost, cbm=1.0, **kw):
    return Pozycja(item_id=item, sku=f"SKU{item}", szt=szt, unit_cost=unit_cost, cbm_szt=cbm,
                   stawka_slownik=kw.pop("stawka", 0.0), **kw)


def tylko_towar(pozycje, platnosci, **kw):
    """Kontener bez frachtu, Lenmara i transportu — sam towar."""
    k = Kontener(lenmar_pln=0.0, **kw)
    return policz(k, [Grupa(id=0, platnosci=platnosci, kurs_ostatni=4.0)], pozycje)


# ── 1. kurs towaru ──────────────────────────────────────────

def test_kurs_to_srednia_wazona_kwota_platnosci():
    w = tylko_towar([poz(1, 100, 10)], [zap(8400, 3.7215), zap(19600, 3.6480, "balance")])
    g = w.grupy[0]
    assert g.kurs == pytest.approx((8400 * 3.7215 + 19600 * 3.6480) / 28000, abs=1e-6)
    assert g.wartosc_waluta == 28000
    assert not g.szacunek and not w.szacunek
    assert w.towar == pytest.approx(8400 * 3.7215 + 19600 * 3.6480, abs=0.01)


def test_niezaplacony_balance_liczy_sie_do_wartosci_ale_daje_szacunek():
    balance = Platnosc(typ="balance", kwota=700, waluta="USD", data=None, kurs=3.9)
    w = tylko_towar([poz(1, 100, 10)], [zap(300, 4.0), balance])
    g = w.grupy[0]
    assert g.wartosc_waluta == 1000
    assert g.kurs == pytest.approx((300 * 4.0 + 700 * 3.9) / 1000)
    assert g.szacunek and w.pozycje[0].szacunek


def test_bez_platnosci_wartosc_z_cen_planowanych_jako_szacunek():
    # unit_cost to PLN: 100 szt × 40 zł = 4 000 zł, niezależnie od kursu
    w = tylko_towar([poz(1, 100, 40)], [])
    assert w.towar == 4000
    assert w.grupy[0].wartosc_zrodlo == "plan" and w.szacunek
    assert w.grupy[0].wartosc_waluta == 1000   # 4 000 zł / kurs 4


def test_sama_zaliczka_bez_balance_nie_zaniza_wartosci():
    # zaliczka 30% to nie cała wartość towaru — bierzemy ceny planowane
    w = tylko_towar([poz(1, 100, 40)], [zap(300, 4.0)])
    assert w.towar == 4000 and w.grupy[0].wartosc_zrodlo == "plan"
    assert any("nie ma balance" in u.tresc for u in w.uwagi)


def test_reczny_kurs_wygrywa():
    w = tylko_towar([poz(1, 100, 10)], [zap(1000, 4.0, "balance")], kurs_towaru=4.5)
    assert w.grupy[0].kurs == 4.5 and w.grupy[0].kurs_reczny
    assert w.towar == 4500


# ── 2. wartość towaru per pozycja ───────────────────────────

def test_wartosc_rozlozona_po_cenach_planowanych():
    w = tylko_towar([poz(1, 100, 10), poz(2, 100, 30)], [zap(1000, 4.0, "balance")])
    p = w.po_item()
    assert p[1].cena_waluta == 2.5 and p[2].cena_waluta == 7.5
    assert (p[1].towar, p[2].towar) == (1000, 3000)


def test_reczna_cena_jednej_pozycji_reszta_dzieli_pozostala_kwote():
    # płatności 1 000 USD; pozycja 2 ręcznie 8 USD × 100 = 800 → pozycji 1 zostaje 200
    w = tylko_towar([poz(1, 100, 10), poz(2, 100, 30, cena_reczna=8.0)], [zap(1000, 4.0, "balance")])
    p = w.po_item()
    assert p[2].cena_reczna and p[2].towar == 3200
    assert not p[1].cena_reczna and p[1].towar == 800
    assert w.towar == 4000, "suma dalej równa sumie płatności"


def test_wszystkie_reczne_i_suma_sie_nie_zgadza_to_ostrzezenie():
    w = tylko_towar([poz(1, 100, 10, cena_reczna=3.0), poz(2, 100, 30, cena_reczna=6.0)],
                    [zap(1000, 4.0, "balance")])
    assert w.towar == 3600
    assert any("różnica -100,00 USD" in u.tresc for u in w.uwagi)


# ── 3–6. fracht, Lenmar, transport, cło ─────────────────────

def test_fracht_lenmar_i_transport_po_cbm():
    k = Kontener(fracht_usd=1000, kurs_frachtu=4.0, transport_pln=400)
    pozycje = [poz(1, 100, 10, cbm=0.01), poz(2, 100, 10, cbm=0.03)]   # 1 i 3 m³
    w = policz(k, [Grupa(id=0, platnosci=[zap(2000, 4.0, "balance")])], pozycje)
    p = w.po_item()
    assert (p[1].fracht, p[2].fracht) == (1000, 3000)
    assert (p[1].lenmar, p[2].lenmar) == (LENMAR_KONTENER / 4, LENMAR_KONTENER * 3 / 4)
    assert (p[1].transport, p[2].transport) == (100, 300)
    assert w.podzial == "cbm"


def test_bez_cbm_podzial_po_wartosci_z_ostrzezeniem():
    k = Kontener(fracht_usd=1000, kurs_frachtu=4.0)
    pozycje = [poz(1, 100, 10, cbm=0.0), poz(2, 100, 30, cbm=0.03)]
    w = policz(k, [Grupa(id=0, platnosci=[zap(4000, 4.0, "balance")])], pozycje)
    p = w.po_item()
    assert w.podzial == "wartosc"
    assert (p[1].fracht, p[2].fracht) == (1000, 3000)   # towar 4 000 i 12 000 zł
    assert any("Brak CBM dla SKU SKU1" in u.tresc for u in w.uwagi)


def test_clo_liczone_od_towaru_razem_z_frachtem():
    k = Kontener(fracht_usd=50, kurs_frachtu=4.0, lenmar_pln=0)
    w = policz(k, [Grupa(id=0, platnosci=[zap(250, 4.0, "balance")])], [poz(1, 100, 10, stawka=2.7)])
    p = w.pozycje[0]
    assert (p.towar, p.fracht) == (1000, 200)
    assert p.clo == pytest.approx(1200 * 0.027)
    assert p.stawka_zrodlo == "slownik"


def test_brak_stawki_to_zero_procent_i_ostrzezenie():
    p = Pozycja(item_id=1, sku="PODK", szt=10, unit_cost=5, cbm_szt=0.01, stawka_slownik=None)
    w = tylko_towar([p], [zap(100, 4.0, "balance")])
    assert w.pozycje[0].clo == 0 and w.pozycje[0].stawka_zrodlo == "brak"
    assert any("Brak stawki cła dla SKU PODK" in u.tresc for u in w.uwagi)


def test_reczna_stawka_pozycji_wygrywa_ze_slownikiem():
    w = tylko_towar([poz(1, 100, 10, stawka=6.5, stawka_reczna=0.0)], [zap(250, 4.0, "balance")])
    assert w.pozycje[0].clo == 0 and w.pozycje[0].stawka_zrodlo == "reczna"


def test_lenmar_ryczalt_jedno_i_dwa_zgloszenia():
    pl = [zap(1000, 4.0, "balance")]
    jedna = policz(Kontener(), [Grupa(id=0, platnosci=pl)], [poz(1, 10, 10), poz(2, 10, 10)])
    assert jedna.zgloszen == 1 and jedna.lenmar == LENMAR_KONTENER
    dwie = policz(Kontener(), [Grupa(id=0, platnosci=pl)],
                  [poz(1, 10, 10, firma="acti"), poz(2, 10, 10, firma="veluxa")])
    assert dwie.zgloszen == 2 and dwie.lenmar == LENMAR_KONTENER + LENMAR_ZGLOSZENIE


def test_koszt_jednostkowy_i_narzut():
    k = Kontener(fracht_usd=100, kurs_frachtu=4.0, transport_pln=200, lenmar_pln=400)
    w = policz(k, [Grupa(id=0, platnosci=[zap(1000, 4.0, "balance")])], [poz(1, 100, 10, stawka=5)])
    p = w.pozycje[0]
    # towar 4 000 + fracht 400 + Lenmar 400 + cło (4 400 × 5% = 220) + transport 200 = 5 220
    assert p.suma == 5220 and p.koszt_jednostkowy == 52.2
    assert w.narzut_proc == pytest.approx(30.5)


# ── konsolidacja ────────────────────────────────────────────

def test_konsolidacja_kurs_per_lot_a_fracht_na_caly_kontener():
    k = Kontener(fracht_usd=1000, kurs_frachtu=4.0, lenmar_pln=0)
    grupy = [Grupa(id=1, platnosci=[zap(1000, 4.0, "balance")]),
             Grupa(id=2, platnosci=[zap(1000, 3.0, "balance")])]
    pozycje = [poz(1, 100, 10, cbm=0.01, grupa=1), poz(2, 100, 10, cbm=0.01, grupa=2)]
    w = policz(k, grupy, pozycje)
    p = w.po_item()
    assert (p[1].towar, p[2].towar) == (4000, 3000)
    assert p[1].fracht == p[2].fracht == 2000


# ── dostawa krajowa ─────────────────────────────────────────

def test_kontener_w_pln_bez_cla_frachtu_i_lenmara():
    k = Kontener(fracht_usd=1000, kurs_frachtu=4.0, transport_pln=450)
    g = Grupa(id=0, krajowa=True, platnosci=[zap(20000, 1.0, "balance", waluta="PLN")])
    pozycje = [poz(1, 40, 312.0, stawka=2.7), poz(2, 200, 18.4)]
    w = policz(k, [g], pozycje)
    p = w.po_item()
    assert w.krajowa and w.fracht == 0 and w.lenmar == 0 and w.clo == 0
    assert w.podzial == "wartosc"
    # towar 12 480 i 3 680 zł → transport 450 dzielony po wartości
    assert p[1].transport == pytest.approx(450 * 12480 / 16160, abs=0.01)
    assert p[1].koszt_jednostkowy == pytest.approx(round((12480 + 450 * 12480 / 16160) / 40, 2))
    assert not w.szacunek


def test_krajowa_reczna_cena_z_fv():
    g = Grupa(id=0, krajowa=True)
    w = policz(Kontener(), [g], [poz(1, 10, 100, cena_reczna=120.0)])
    assert w.pozycje[0].koszt_jednostkowy == 120.0 and w.pozycje[0].cena_reczna
