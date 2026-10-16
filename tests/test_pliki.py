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
def test_zakladka_tylko_dla_superadmina(klient, metoda, sciezka):
    c, stan = klient
    stan["user"] = ADMIN      # nawet admin z pełną rolą — zakładka jest bez uprawnień w ROLE_PERMS
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
    stan["user"] = ADMIN
    assert c.post("/api/pliki/zip", json={"foldery": [1]}).status_code == 403
    assert audit_opisy.opis_sciezki("POST", "/api/pliki/zip") is None
