"""Dziennik audytu: zdania ze ścieżek, pomijane żądania, stare wpisy, formatery.

Uruchomienie:  python3 -m pytest tests/test_audyt.py -q
"""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import audit_opisy as o  # noqa: E402


def test_sciezki_produktu_z_ukosnikiem_w_sku():
    op = o.opis_sciezki("PUT", "/api/products/AB/12/attrs")
    assert (op.obszar, op.orzeczenie, op.id) == ("Produkty", "zmienił atrybuty produktu AB/12", "AB/12")
    assert o.opis_sciezki("PUT", "/api/products/MKp1/cena").obszar == "Ceny"
    assert o.opis_sciezki("DELETE", "/api/products/MKp1").orzeczenie == "usunął produkt MKp1"


def test_kontener_i_odprawa():
    assert o.opis_sciezki("POST", "/api/containers/27/deliver").orzeczenie == "oznaczył kontener #27 jako dostarczony"
    op = o.opis_sciezki("POST", "/api/kontenery/28/odprawa")
    assert (op.obszar, op.orzeczenie) == ("Odprawy", "zapisał odprawę kontenera #28")


def test_podglady_synchronizacje_i_dropy_nie_trafiaja_do_dziennika():
    for m, p in [("POST", "/api/kontenery/28/odprawa/podglad"), ("POST", "/api/assistant/chat"),
                 ("POST", "/api/sellasist/refresh"), ("POST", "/api/fakturownia-sales/sync"),
                 ("POST", "/api/admin/fx/topup"), ("POST", "/api/reports/snapshot"),
                 ("PATCH", "/api/auth/me/onboarding"), ("POST", "/api/dropy/orders"),
                 ("POST", "/api/order-pdf-data"), ("POST", "/api/auth/login")]:
        assert o.opis_sciezki(m, p) is None, p


def test_nieznana_trasa_tez_zostawia_wpis():
    op = o.opis_sciezki("POST", "/api/cos-nowego/5")
    assert op.obszar == "Inne" and "POST /api/cos-nowego/5" in op.orzeczenie


def test_stare_wpisy_po_ludzku():
    assert o.orzeczenie_legacy("PRODUCTS_UPDATED", "MKch1", "PUT /api/products/MKch1/attrs") == \
        "zmienił atrybuty produktu MKch1"
    assert o.orzeczenie_legacy("LOGIN", "1", None) == "zalogował się"
    s = o.orzeczenie_legacy("USER_UPDATED", "4", "{'perms': {'viewFinancials': False}, 'show_onboarding': False}")
    assert s == "zmienił użytkownika #4: wyłączono „Dane finansowe (PLN)”; wyłączono onboarding"
    assert o.obszar_akcji("KONTENERY_CREATED", "kontenery") == "Odprawy"
    assert o.obszar_akcji("LOGIN_FAILED") == "Logowania"


def test_formatery():
    assert o.f_num("cm", 1)(180.0) == "180 cm"
    assert o.f_num("kg", 3)(0.406) == "0,406 kg"
    assert o.f_num("m³", 2)(1234.5) == "1 234,5 m³"
    assert o.f_proc(90) == "90%"
    assert o.f_zl(1199) == "1 199,00 zł"
    assert o.f_kwota("USD")(12000) == "12 000,00 USD"
    assert o.f_data(date(2026, 10, 15)) == "15.10.2026" and o.f_data("2026-10-15") == "15.10.2026"
    assert o.f_txt("  ") == o.f_txt(None) == "—"
    assert o.f_status("IN_TRANSIT") == "w drodze"
    assert o.plural(1, "pole", "pola", "pól") == "pole"
    assert o.plural(3, "pole", "pola", "pól") == "pola"
    assert o.plural(12, "pole", "pola", "pól") == "pól"


def test_kontener_bez_numeru_to_nr_fv_nigdy_draft():
    assert o.etykieta_kontenera("MSKU7345120", "SK2605042", 7) == "MSKU7345120"
    assert o.etykieta_kontenera("Draft-Youngcoln3", "SK2605042", 7) == "FV: SK2605042"
    assert o.etykieta_kontenera("Draft-Youngcoln3", None, 7) == "#7"
    assert o.f_nr_kontenera("Draft-Youngcoln3") == "—"
    assert o.f_nr_kontenera("MSKU7345120") == "MSKU7345120"


def test_zmiana_masowa_userow_ma_wlasne_zdanie():
    op = o.opis_sciezki("POST", "/api/users/bulk")
    assert (op.obszar, op.orzeczenie) == ("Użytkownicy", "zmienił kilku użytkowników naraz")
