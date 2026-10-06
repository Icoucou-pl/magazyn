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


def test_wszystkie_ceny_wpisane_a_zaplacono_wiecej_to_gratisy_na_cala_fakture():
    # ceny 300 + 600 = 900 USD, zapłacono 1 000 → 100 USD gratisów, po wartości 1 : 2
    w = tylko_towar([poz(1, 100, 10, cena_reczna=3.0), poz(2, 100, 30, cena_reczna=6.0)],
                    [zap(1000, 4.0, "balance")])
    p = w.po_item()
    assert w.towar == 3600 and w.gratisy == 400, "zapłacone gratisy wchodzą do kosztu"
    assert p[1].gratisy == pytest.approx(133.33, abs=0.01) and p[2].gratisy == pytest.approx(266.67, abs=0.01)
    assert p[1].koszt_jednostkowy == pytest.approx((1200 + 133.33) / 100, abs=0.01)
    assert any("Gratisy / różnica z płatności: 100,00 USD" in u.tresc and "całą fakturę" in u.tresc for u in w.uwagi)


def test_gratisy_przypiete_do_jednej_pozycji():
    w = tylko_towar([poz(1, 100, 10, cena_reczna=3.0), poz(2, 100, 30, cena_reczna=6.0, gratis=True)],
                    [zap(1000, 4.0, "balance")])
    p = w.po_item()
    assert p[1].gratisy == 0 and p[2].gratisy == 400 and p[2].gratis_przypiety
    assert any("przypięta do SKU2" in u.tresc for u in w.uwagi)


def test_zaplacono_mniej_niz_ceny_to_rabat_z_ostrzezeniem():
    w = tylko_towar([poz(1, 100, 10, cena_kontener=5.0)], [zap(450, 4.0, "balance")])
    assert w.towar == 2000 and w.gratisy == -200
    assert w.pozycje[0].koszt_jednostkowy == 18.0
    assert any(u.poziom == "ostrzezenie" and "mniejsze niż ceny pozycji o 50,00 USD" in u.tresc for u in w.uwagi)


def test_clo_liczone_takze_od_gratisow():
    w = tylko_towar([poz(1, 100, 10, cena_kontener=2.0, stawka=10)], [zap(250, 4.0, "balance")])
    p = w.pozycje[0]
    assert (p.towar, p.gratisy) == (800, 200)
    assert p.clo == pytest.approx(100.0)


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


# ── cena w walucie wpisana na pozycji kontenera (proforma / FV dostawcy) ──

def test_cena_z_kontenera_zostaje_a_reszta_dzieli_pozostale_platnosci():
    # płatności 1 000 USD; pozycja 2 ma z proformy 7 USD × 100 = 700 → pozycji 1 zostaje 300
    w = tylko_towar([poz(1, 100, 10), poz(2, 100, 30, cena_kontener=7.0)], [zap(1000, 4.0, "balance")])
    p = w.po_item()
    assert p[2].cena_waluta == 7.0 and p[2].cena_zrodlo == "kontener" and not p[2].cena_reczna
    assert p[1].cena_waluta == 3.0 and p[1].cena_zrodlo == "auto"
    assert w.towar == 4000


def test_reczna_cena_z_zakladki_wygrywa_z_cena_z_kontenera():
    w = tylko_towar([poz(1, 100, 10), poz(2, 100, 30, cena_kontener=7.0, cena_reczna=8.0)],
                    [zap(1000, 4.0, "balance")])
    p = w.po_item()
    assert p[2].cena_waluta == 8.0 and p[2].cena_zrodlo == "reczna"
    assert p[1].cena_waluta == 2.0


def test_bez_platnosci_cena_z_kontenera_po_ostatnim_kursie_reszta_z_planu():
    # kurs ostatni 4,0: pozycja 1 = 5 USD × 100 × 4 = 2 000 zł, pozycja 2 bez ceny = plan 100 × 30 zł
    w = tylko_towar([poz(1, 100, 10, cena_kontener=5.0), poz(2, 100, 30)], [])
    p = w.po_item()
    assert (p[1].towar, p[2].towar) == (2000, 3000)
    assert w.szacunek and w.grupy[0].wartosc_zrodlo == "plan"
    assert w.grupy[0].wartosc_waluta == 1250


def test_wszystkie_ceny_z_kontenera_zgodne_z_platnosciami_bez_ostrzezenia():
    w = tylko_towar([poz(1, 100, 10, cena_kontener=4.0), poz(2, 100, 30, cena_kontener=6.0)],
                    [zap(1000, 4.0, "balance")])
    assert w.towar == 4000
    assert not any("różnica" in u.tresc for u in w.uwagi)


def test_sama_zaliczka_porownana_z_wartoscia_z_cen_w_walucie():
    # zaliczka 300 USD wobec 1 000 USD z proformy to 30% — za mało, bierzemy ceny z kontenera
    w = tylko_towar([poz(1, 100, 1, cena_kontener=10.0)], [zap(300, 4.0)])
    assert w.towar == 4000 and w.grupy[0].wartosc_zrodlo == "plan"


# ── wspólna faktura kilku kontenerów ────────────────────────

def test_kontenery_rozliczane_razem_dziela_platnosci_na_caly_towar():
    """Jak UETU8695821 + UETU8696129: na jednej karcie płatności za materace, na drugiej
    za łóżka, a łóżka jadą w obu kontenerach. Osobno łóżko wychodzi raz tanio, raz drogo;
    razem — tak samo w obu, a suma towaru = wszystkie płatności × kurs."""
    from services.koszt_kontenera import policz_razem

    def kontener(cid, platnosci, pozycje, fracht_usd):
        return (Kontener(fracht_usd=fracht_usd, kurs_frachtu=4.0, lenmar_pln=0),
                Grupa(id=0, platnosci=platnosci, kurs_ostatni=4.0), pozycje)

    a = kontener(1, [zap(1400, 4.0, "balance")],                     # same materace na karcie A
                 [poz(11, 16, 7000, cbm=1.0), poz(12, 120, 280, cbm=0.07)], 1000)
    b = kontener(2, [zap(12000, 4.0, "balance")],                    # łóżka na karcie B
                 [poz(21, 44, 7000, cbm=1.0)], 2000)
    osobno_a = policz(a[0], [a[1]], a[2]).po_item()
    osobno_b = policz(b[0], [b[1]], b[2]).po_item()
    assert osobno_a[11].cena_waluta != pytest.approx(osobno_b[21].cena_waluta, abs=1), "osobno — rozjazd"

    razem = policz_razem({1: a, 2: b})
    pa, pb = razem[1].po_item(), razem[2].po_item()
    assert pa[11].cena_waluta == pytest.approx(pb[21].cena_waluta), "to samo łóżko, ta sama cena"
    assert razem[1].towar + razem[2].towar == pytest.approx(13400 * 4.0, abs=0.05)
    # fracht zostaje na swojej karcie
    assert razem[1].fracht == 4000 and razem[2].fracht == 8000
    assert razem[1].razem_z == [2] and razem[2].razem_z == [1]
