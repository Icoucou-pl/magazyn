"""Wykres „Sprzedaż — sezon do sezonu” w karcie produktu: outlety liczą się do produktu bazowego.

SZP1 = SZP1 + Szp1_Outlet, SZP3 = SZP3 + SZP3_Outlet + SZP3_OUTLET2.
Baza jest podmieniona atrapą, która zapamiętuje zapytanie i parametry.

Uruchomienie:  python3 -m pytest tests/test_sezon_outlety.py -q
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

from fastapi.testclient import TestClient  # noqa: E402

from database import get_db  # noqa: E402
from main import app  # noqa: E402
from models import CurrentUser  # noqa: E402
from security import get_current_user  # noqa: E402


class _Db:
    def __init__(self):
        self.sql, self.params = None, None

    async def execute(self, sql, params=None):
        self.sql, self.params = str(sql), params
        return [type("R", (), {"_mapping": {"yr": 2026, "mo": 6, "qty": 69, "val_net": 1.0, "val_gross": 1.23}})()]


def _zapytaj(sku):
    db = _Db()

    async def _get_db():
        yield db

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(id=1, email="t@t", role="admin")
    try:
        r = TestClient(app).get(f"/api/products/{sku}/sales-season")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200, r.text
    return db, r.json()


def test_szp1_dolicza_outlety():
    db, dane = _zapytaj(" SZP1 ")
    assert db.params == {"sku": "szp1", "sku_len": 4}, "SKU małymi literami, bez spacji"
    assert "~ '^_outlet[0-9]*$'" in db.sql, "outlet, outlet2… doliczone do bazowego SKU"
    assert dane == [{"year": 2026, "month": 5, "qty": 69, "value_net": 1.0, "value_gross": 1.23}]


def test_sku_nie_trafia_do_regexu():
    # Wartość od użytkownika idzie tylko jako parametr — w SQL nie ma jej tekstu.
    db, _ = _zapytaj("SZP.*")
    assert "SZP.*" not in db.sql and "szp.*" not in db.sql
    assert db.params["sku"] == "szp.*"
