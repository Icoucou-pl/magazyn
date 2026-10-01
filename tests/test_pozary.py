"""„Pożary” na pulpicie: lista zakupów niesie firmę-właściciela produktu.

Pulpit pokazuje w „Pożarach” tylko towar firmy z wybranej zakładki (na AMH bez produktów
Acti/Veluxy przesuwanych z marżą). Filtr siedzi we froncie, więc backend musi oddać
`firma_slug` przy każdej pozycji — a produkt bez przypisanej firmy to AMH.

Uruchomienie:  python3 -m pytest tests/test_pozary.py -q
"""

import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

for k, v in {"DB_HOST": "localhost", "DB_PORT": "5432", "DB_NAME": "test",
             "DB_USER": "test", "DB_PASSWORD": "test", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

import routers.anomalies as anomalies  # noqa: E402
from models import ProductSummary  # noqa: E402


def _produkt(sku, firma_slug):
    return SimpleNamespace(
        sku=sku, name=sku, stock=1, stock_in_transit=0, avg_monthly_weighted=10,
        purchase_price=0, cbm_per_unit=0, status="KRYTYCZNY", days_until_empty=3,
        transfer_source_shop=None, transfer_source_qty=0, transfer_source_transit=0,
        transfer_state=None, is_favorite=True, no_reorder=False,
        manufacturer_id=None, manufacturer_name=None, manufacturer_color=None,
        firma_slug=firma_slug,
    )


class _Db:
    async def execute(self, *a, **k):
        return []


def test_lista_zakupow_oddaje_firme_wlasciciela(monkeypatch):
    async def fake_fetch(db, include, shop):
        return [_produkt("A1", "amh"), _produkt("V1", "veluxa")]

    monkeypatch.setattr(anomalies, "fetch_products", fake_fetch)
    grupy = asyncio.run(anomalies.shopping_list(shop="amh", favorites_only=True, db=_Db(), user=None))
    firmy = {p["sku"]: p["firma_slug"] for g in grupy for p in g["products"]}
    assert firmy == {"A1": "amh", "V1": "veluxa"}


def test_produkt_bez_firmy_to_amh():
    assert ProductSummary.model_fields["firma_slug"].default == "amh"
