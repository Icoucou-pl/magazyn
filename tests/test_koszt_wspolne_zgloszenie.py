"""Wspólne zgłoszenie celne w policz_kontenery — z atrapą bazy (bez Postgresa).

  · kontenery jednej zapisanej odprawy liczą fracht z puli,
  · dostawa krajowa (PLN) z tej samej odprawy do puli nie wchodzi,
  · wynik kontenera nie zależy od tego, o jakie kontenery pytamy — dlatego kolumna
    „Nowa metoda” w zakładce SAD (pyta o wszystkie kontenery odprawy) = zakładka
    „Koszt jednostkowy” (pyta o jeden).

Uruchomienie:  python3 -m pytest tests/test_koszt_wspolne_zgloszenie.py -q
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

import services.koszt_kontenera_dane as dane  # noqa: E402


def _kontener(cid, numer, fracht_usd, waluta="USD", balance=None):
    return {"id": cid, "skonsolidowany": False, "koszt_transportu": fracht_usd, "koszt_transportu_magazyn": 800,
            "delivered_date": date(2026, 9, 20), "eta_date": None, "waluta_towaru": waluta,
            "balance_kwota": balance, "balance_waluta": waluta, "zaplacono_data": date(2026, 8, 1),
            "rozliczenie_grupa": None, "etykieta": numer}


def _pozycja(item, cid, sku, szt, cbm, cena):
    return {"item_id": item, "container_id": cid, "lot_id": None, "sku": sku, "quantity": szt, "unit_cost": 1,
            "cena_kontener": cena, "cbm_per_unit": cbm, "dlugosc_cm": None, "szerokosc_cm": None,
            "wysokosc_cm": None, "szt_w_kartonie": None, "kod_cn": "94042190", "firma": "acti",
            "cena_waluta": None, "stawka_cla": None, "gratis": False}


KONTENERY = [
    _kontener(1, "UETU8695821", 5400, balance=2000),
    _kontener(2, "UETU8696129", 5400, balance=1500),
    _kontener(3, "FV: 12/2026", 0, waluta="PLN", balance=3000),   # krajowa — ta sama odprawa
    _kontener(4, "FFAU5338035", 4000, balance=1000),              # własny SAD
]
POZYCJE = [
    _pozycja(11, 1, "Mc_YSzp1", 20, 1.0, 100.0),
    _pozycja(21, 2, "Mc_YSzp1", 15, 1.0, 100.0),
    _pozycja(31, 3, "Krajowy", 10, 1.0, None),
    _pozycja(41, 4, "YFg1", 10, 1.0, 100.0),
]
ODPRAWY = [(100, 1), (100, 2), (100, 3), (200, 4)]


class _R:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows

    def mappings(self):
        return self

    def scalars(self):
        return self


class _Baza:
    async def execute(self, sql, params=None):
        q = str(sql)
        ids = set((params or {}).get("ids") or [])
        if "FROM app_odprawa_kontenery" in q:
            return _R(ODPRAWY)
        if "rozliczenie_grupa IN" in q:
            return _R([])
        if "AS skonsolidowany" in q:
            return _R([k for k in KONTENERY if not ids or k["id"] in ids])
        if "ci.cena_waluta AS cena_kontener" in q:
            return _R([p for p in POZYCJE if p["container_id"] in ids])
        return _R([])   # loty, zaliczki, nadpisania, dodatkowe koszty


@pytest.fixture(autouse=True)
def _bez_nbp(monkeypatch):
    async def kursy(db, pary):
        return {(w.upper(), d): (d, 4.0) for w, d in pary}

    async def stawki(db):
        return {"94042190": 2.7}
    monkeypatch.setattr(dane, "kursy_przed", kursy)
    monkeypatch.setattr(dane, "slownik_stawek", stawki)


def _licz(ids):
    return asyncio.run(dane.policz_kontenery(_Baza(), ids))[0]


def test_kontenery_jednej_odprawy_licza_fracht_z_puli():
    w = _licz([1])
    assert set(w) == {1}   # partner tylko do rachunku, nie w wyniku
    pula = w[1].pula
    assert [k.etykieta for k in pula.kontenery] == ["UETU8695821", "UETU8696129"]
    assert pula.fracht == 2 * 5400 * 4.0 and pula.cbm == 35
    assert w[1].po_item()[11].fracht == pytest.approx(pula.fracht * 20 / 35, abs=0.01)


def test_dostawa_krajowa_nie_wchodzi_do_puli():
    w = _licz([1, 3])
    assert w[3].pula is None and w[3].krajowa
    assert any("nie wchodzi do wspólnego rozliczenia" in u.tresc for u in w[3].uwagi)
    assert any("FV: 12/2026 to dostawa krajowa" in u.tresc for u in w[1].uwagi)


def test_kontener_z_wlasnym_sad_bez_puli():
    w = _licz([4])
    assert w[4].pula is None and w[4].fracht_udzial == 4000 * 4.0


def test_kolumna_sad_rowna_zakladce_koszt_jednostkowy():
    zakladka = {cid: _licz([cid])[cid] for cid in (1, 2)}
    sad = _licz([1, 2])   # _dolicz_nowa_metode pyta o wszystkie kontenery odprawy naraz
    for cid in (1, 2):
        assert ([(p.item_id, p.koszt_jednostkowy) for p in sad[cid].pozycje]
                == [(p.item_id, p.koszt_jednostkowy) for p in zakladka[cid].pozycje])
    # ten sam SKU, ten sam fracht/szt w obu kontenerach
    assert sad[1].po_item()[11].fracht / 20 == pytest.approx(sad[2].po_item()[21].fracht / 15, abs=0.01)
