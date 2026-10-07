"""Kto może poprawiać i usuwać notatki do kosztu jednostkowego (routers/koszt_kontenera.py).

Zasada właściciela: swój wpis autor poprawia i usuwa sam, cudze — tylko administrator.

Uruchomienie:  python3 -m pytest tests/test_koszt_notatki.py -q
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

for k, v in {"DB_HOST": "localhost", "DB_PORT": "5432", "DB_NAME": "test",
             "DB_USER": "test", "DB_PASSWORD": "test", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

from models import CurrentUser  # noqa: E402
from routers.koszt_kontenera import _moze_zmieniac  # noqa: E402


def uzytkownik(uid, rola="IMPORT", **perms):
    return CurrentUser(id=uid, email=f"u{uid}@x.pl", role=rola, perms=perms or None)


def test_autor_zmienia_swoj_wpis_ale_nie_cudzy():
    u = uzytkownik(7, editLandedCost=True, viewLandedCost=True)
    assert _moze_zmieniac(u, 7)
    assert not _moze_zmieniac(u, 8)


def test_administrator_zmienia_kazdy_wpis_takze_stary_bez_autora():
    a = uzytkownik(1, "ADMIN")
    assert _moze_zmieniac(a, 8) and _moze_zmieniac(a, None)


def test_wpis_bez_autora_zmienia_tylko_administrator():
    assert not _moze_zmieniac(uzytkownik(7, editLandedCost=True), None)


def test_autor_bez_prawa_do_kosztu_nie_zmienia():
    assert not _moze_zmieniac(uzytkownik(7), 7)
