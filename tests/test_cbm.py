"""CBM / szt (services/products.py::compute_effective_cbm) — drobne produkty nie mogą dawać 0.

Uruchomienie:  python3 -m pytest tests/test_cbm.py -q
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for k, v in {"DB_HOST": "x", "DB_USER": "x", "DB_PASSWORD": "x", "DB_NAME": "x", "SECRET_KEY": "test"}.items():
    os.environ.setdefault(k, v)

from services.products import compute_effective_cbm  # noqa: E402


def test_maly_reczny_cbm_nie_zaokragla_sie_do_zera():
    assert compute_effective_cbm({"cbm_per_unit": 0.0004725}) == (0.0004725, "manual")


def test_maly_cbm_z_wymiarow_kartonu():
    # karton 30 × 20 × 15 cm = 0,009 m³, 50 szt → 0,00018 m³ / szt
    cbm, zrodlo = compute_effective_cbm({"dlugosc_cm": 30, "szerokosc_cm": 20, "wysokosc_cm": 15, "szt_w_kartonie": 50})
    assert zrodlo == "dims" and cbm == 0.00018
