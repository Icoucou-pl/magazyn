"""Zakładka „Pliki”: kto ją widzi, nazwy plików, foldery automatyczne, dziennik.

Bez bazy — logikę SQL (foldery producentów/kontenerów, kosz, przenoszenie) sprawdzono na
lokalnym PostgreSQL przy budowie; tu pilnujemy rzeczy, które łatwo zepsuć przy zmianach obok:
dostęp tylko dla superadmina, wyjątek „pobierz plik pokazany na kontenerze”, czyszczenie nazw.

Uruchomienie:  python3 -m pytest tests/test_pliki.py -q
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import audit_opisy  # noqa: E402
from config import settings  # noqa: E402
from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CurrentUser  # noqa: E402
from security import get_current_user  # noqa: E402
from services import pliki as svc  # noqa: E402

SZEF = CurrentUser(id=1, email="szef@firma.pl", role="ADMIN")
ADMIN = CurrentUser(id=2, email="admin@firma.pl", role="ADMIN")
# Bez żadnego ptaszka Plików — rola IMPORT ich z automatu nie dostaje (ADMIN dostaje).
BEZ_PLIKOW = CurrentUser(id=4, email="import@firma.pl", role="IMPORT")


class _Wynik:
    def __init__(self, wiersz=None):
        self.wiersz = wiersz

    def mappings(self):
        return self

    def first(self):
        return self.wiersz

    def all(self):
        return []

    def scalar(self):
        return None

    def __iter__(self):
        return iter([])


class AtrapaDb:
    """Zwraca jeden wiersz pliku na każde zapytanie o plik — wystarczy do sprawdzenia uprawnień."""

    def __init__(self, plik=None):
        self.plik = plik
        self.zapytania = []

    async def execute(self, sql, params=None):
        self.zapytania.append(str(sql))
        return _Wynik(self.plik if "sciezka" in str(sql) else None)

    async def commit(self):
        pass


@pytest.fixture
def klient(monkeypatch):
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAIL", "szef@firma.pl")
    stan = {"user": SZEF, "db": AtrapaDb()}

    async def _db():
        yield stan["db"]

    app.dependency_overrides[get_current_user] = lambda: stan["user"]
    app.dependency_overrides[get_db] = _db
    yield TestClient(app), stan
    app.dependency_overrides.clear()


# ── Dostęp ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("metoda,sciezka", [
    ("GET", "/api/pliki/status"),
    ("GET", "/api/pliki/lista"),
    ("GET", "/api/pliki/drzewo"),
    ("GET", "/api/pliki/szukaj?q=fv"),
    ("POST", "/api/pliki/folder"),
    ("PATCH", "/api/pliki/folder/1"),
    ("DELETE", "/api/pliki/folder/1"),
    ("PATCH", "/api/pliki/plik/1"),
    ("DELETE", "/api/pliki/plik/1"),
    ("GET", "/api/pliki/kosz"),
    ("POST", "/api/pliki/kosz/przywroc"),
    ("POST", "/api/pliki/kosz/usun"),
    ("DELETE", "/api/pliki/kosz"),
    ("GET", "/api/pliki/stare-zalaczniki.zip"),
])
def test_zakladka_bez_ptaszka_niedostepna(klient, metoda, sciezka):
    c, stan = klient
    stan["user"] = BEZ_PLIKOW
    r = c.request(metoda, sciezka, json={"nazwa": "x"} if metoda in ("POST", "PATCH") else None)
    assert r.status_code == 403, (sciezka, r.status_code, r.text)
    assert not stan["db"].zapytania, "strażnik ma odbić żądanie, zanim cokolwiek pójdzie do bazy"


def test_superadmin_widzi_status(klient):
    c, _ = klient
    r = c.get("/api/pliki/status")
    assert r.status_code == 200
    assert set(r.json()) == {"storage", "max_mb", "kosz_dni"}


def _plik(**kw):
    p = {"id": 7, "folder_id": None, "nazwa": "FV.pdf", "content_type": "application/pdf", "rozmiar": 3,
         "container_id": 5, "pokaz_na_kontenerze": True, "dodano_z_kontenera": True, "dodano": None,
         "dodal": "x", "sciezka": "pliki/a.pdf", "usuniety_at": None}
    p.update(kw)
    return p


@pytest.mark.parametrize("plik,perms,kod", [
    (_plik(), {"viewAttachments": True}, 200),                                  # pokazany na kontenerze
    (_plik(pokaz_na_kontenerze=False), {"viewAttachments": True}, 404),         # tylko w zakładce
    (_plik(), {"viewAttachments": False}, 404),                                 # bez prawa do załączników
    (_plik(usuniety_at="2026-10-01"), {"viewAttachments": True}, 404),          # w koszu
])
def test_pobranie_przez_zwyklego_usera(klient, monkeypatch, plik, perms, kod):
    c, stan = klient
    stan["user"] = CurrentUser(id=3, email="ola@firma.pl", role="VIEWER", perms=perms)
    stan["db"] = AtrapaDb(plik)

    async def _pobierz(sciezka):
        return b"%PDF"
    monkeypatch.setattr("services.pliki_storage.download", _pobierz)
    assert c.get("/api/pliki/plik/7/pobierz").status_code == kod


# ── Nazwy i typy ─────────────────────────────────────────────────────────────

def test_czysta_nazwa():
    assert svc.czysta_nazwa("  FV/12\\2026.pdf ") == "FV 12 2026.pdf"
    assert svc.czysta_nazwa("") == "plik"
    assert svc.czysta_nazwa("...", "Nowy folder") == "Nowy folder"
    dluga = svc.czysta_nazwa("a" * 300 + ".pdf")
    assert len(dluga) == 200 and dluga.endswith(".pdf")


def test_sciezka_w_buckecie_bez_nazwy_uzytkownika():
    s = svc.nowa_sciezka("Proforma ąę żółć.PDF")
    assert s.startswith("pliki/") and s.endswith(".pdf")
    assert "ą" not in s and " " not in s
    assert svc.nowa_sciezka("bez rozszerzenia") != svc.nowa_sciezka("bez rozszerzenia")


@pytest.mark.parametrize("nazwa,typ", [
    ("a.PDF", "pdf"), ("b.xlsx", "excel"), ("c.zip", "zip"), ("d.xml", "xml"), ("e.jpeg", "image"), ("f", "other"),
])
def test_typ_pliku(nazwa, typ):
    assert svc.typ_pliku(nazwa) == typ


def test_foldery_automatyczne():
    assert svc.jest_automatyczny("producenci", None, None)
    assert svc.jest_automatyczny("producent", 1, None)
    assert svc.jest_automatyczny("kontener", 1, 5)
    assert not svc.jest_automatyczny("reczny", None, None)
    # kontener albo producent usunięty z bazy — folder z plikami staje się zwykłym folderem
    assert not svc.jest_automatyczny("kontener", 1, None)
    assert not svc.jest_automatyczny("producent", None, None)


# ── Dziennik ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("metoda,sciezka,obszar", [
    ("POST", "/api/pliki/wgraj", "Pliki"),
    ("DELETE", "/api/pliki/plik/3", "Pliki"),
    ("POST", "/api/pliki/kosz/usun", "Pliki"),
    ("DELETE", "/api/containers/4/pliki/9", "Kontenery"),
])
def test_dziennik_zna_trasy_plikow(metoda, sciezka, obszar):
    opis = audit_opisy.opis_sciezki(metoda, sciezka)
    assert opis and opis.obszar == obszar and not opis.orzeczenie.startswith("wykonał zmianę")
    assert "Pliki" in audit_opisy.OBSZARY


# ── Przełącznik firm ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("shop,firma", [("", ""), ("amh", "amh"), ("veluxa", "veluxa"), ("zle", ""), ("all", "")])
def test_firma_z_przelacznika(shop, firma):
    from routers.pliki import _firma
    assert _firma(shop, SZEF) == firma


def test_lista_bez_firmy_nie_liczy_firm(klient, monkeypatch):
    """„Wszyscy” nie odpytuje bazy o firmy folderów — to dodatkowe zapytanie tylko przy wybranej firmie."""
    async def _ukryte(db, shop):
        raise AssertionError("bez firmy nie powinno być filtrowania")
    monkeypatch.setattr(svc, "ukryte_foldery", _ukryte)
    monkeypatch.setattr(svc, "synchronizuj_foldery", lambda *a, **k: _nic())
    c, _ = klient
    assert c.get("/api/pliki/lista").status_code == 200


async def _nic():
    return None


def test_zip_dubel_nazwy_dostaje_numer():
    uzyte: set = set()
    assert svc._unikalna("MSKU1/FV.pdf", uzyte) == "MSKU1/FV.pdf"
    assert svc._unikalna("MSKU1/FV.pdf", uzyte) == "MSKU1/FV (2).pdf"
    assert svc._unikalna("MSKU1/fv.pdf", uzyte) == "MSKU1/fv (3).pdf"      # bez względu na wielkość liter
    assert svc._unikalna("MSKU1", uzyte) == "MSKU1"
    assert svc._unikalna("MSKU1", uzyte) == "MSKU1 (2)"


def test_zip_tylko_dla_superadmina_i_bez_wpisu_w_dzienniku(klient):
    c, stan = klient
    stan["user"] = BEZ_PLIKOW
    assert c.post("/api/pliki/zip", json={"foldery": [1]}).status_code == 403
    assert audit_opisy.opis_sciezki("POST", "/api/pliki/zip") is None


# ── Uprawnienia: „Pliki – podgląd” / „Pliki – edycja” ────────────────────────

PODGLAD = CurrentUser(id=5, email="ola@firma.pl", role="IMPORT", perms={"viewFiles": True})
EDYCJA = CurrentUser(id=6, email="jan@firma.pl", role="IMPORT", perms={"viewFiles": True, "editFiles": True})
SAMA_EDYCJA = CurrentUser(id=7, email="ewa@firma.pl", role="IMPORT", perms={"editFiles": True})


def test_reguly_uprawnien(monkeypatch):
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAIL", "szef@firma.pl")
    from security import can_edit_files, can_view_files
    assert can_view_files(SZEF) and can_edit_files(SZEF)
    assert can_view_files(ADMIN) and can_edit_files(ADMIN)  # Admin dostaje oba z roli
    assert not can_view_files(BEZ_PLIKOW)                   # Import i Viewer — tylko z ptaszkiem
    wylaczony = CurrentUser(id=11, email="x@y.pl", role="ADMIN", perms={"viewFiles": False})
    assert not can_view_files(wylaczony)                    # ptaszek odznaczony adminowi wygrywa nad rolą
    assert can_view_files(PODGLAD) and not can_edit_files(PODGLAD)
    assert can_view_files(EDYCJA) and can_edit_files(EDYCJA)
    assert not can_view_files(SAMA_EDYCJA) and not can_edit_files(SAMA_EDYCJA)   # edycja leży na podglądzie


@pytest.mark.parametrize("user,metoda,sciezka,kod", [
    (PODGLAD, "GET", "/api/pliki/status", 200),
    (PODGLAD, "POST", "/api/pliki/folder", 403),
    (PODGLAD, "DELETE", "/api/pliki/plik/1", 403),
    (PODGLAD, "GET", "/api/pliki/kosz", 403),
    (SAMA_EDYCJA, "GET", "/api/pliki/status", 403),
    (SAMA_EDYCJA, "POST", "/api/pliki/folder", 403),
    (EDYCJA, "POST", "/api/pliki/kosz/usun", 403),          # na zawsze — tylko superadmin
    (EDYCJA, "DELETE", "/api/pliki/kosz", 403),
    (EDYCJA, "GET", "/api/pliki/stare-zalaczniki/stan", 403),
    (EDYCJA, "POST", "/api/pliki/stare-zalaczniki/przenies", 403),
    (ADMIN, "GET", "/api/pliki/status", 200),
    (ADMIN, "POST", "/api/pliki/kosz/usun", 403),           # admin też nie usuwa na zawsze
    (ADMIN, "DELETE", "/api/pliki/kosz", 403),
])
def test_kto_co_moze(klient, user, metoda, sciezka, kod):
    c, stan = klient
    stan["user"] = user
    r = c.request(metoda, sciezka, json={"nazwa": "x"} if metoda in ("POST", "PATCH") else None)
    assert r.status_code == kod, (sciezka, r.status_code, r.text)


def test_zakres_firm_to_czesc_wspolna(monkeypatch):
    """User z dwiema firmami nie widzi tylko tego, czego nie ma u ŻADNEJ z nich."""
    import asyncio
    from routers.pliki import _zabronione
    ukryte = {"amh": {1, 2, 3}, "acti": {2, 3, 4}, "veluxa": {9}}

    async def _ukryte(db, shop):
        return set(ukryte[shop])
    monkeypatch.setattr(svc, "ukryte_foldery", _ukryte)
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAIL", "szef@firma.pl")
    dwie = CurrentUser(id=8, email="a@b.pl", role="IMPORT", company_scope=["amh", "acti"])
    wszystkie = CurrentUser(id=9, email="c@d.pl", role="IMPORT", company_scope=["amh", "acti", "veluxa"])
    bez = CurrentUser(id=10, email="e@f.pl", role="IMPORT")
    assert asyncio.run(_zabronione(None, dwie)) == {2, 3}
    assert asyncio.run(_zabronione(None, wszystkie)) == set()
    assert asyncio.run(_zabronione(None, bez)) == set()
    assert asyncio.run(_zabronione(None, SZEF)) == set()


def test_uprawnienia_maja_etykiety_w_dzienniku_i_na_froncie():
    js = (Path(__file__).resolve().parents[1] / "frontend/lib/permissions.js").read_text()
    for klucz in ("viewFiles", "editFiles"):
        assert f'key: "{klucz}"' in js
        assert klucz in audit_opisy.UPRAWNIENIA
