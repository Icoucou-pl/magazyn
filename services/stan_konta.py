"""Stan konta rozbity na subkonta i waluty — przeliczenie na zł po kursie NBP.

Rachunek Acti ma subkonta w PLN, EUR, USD (i bywa CZK); księgowa podaje saldo każdego
osobno. Suma w zł to Σ kwota × kurs średni NBP z ostatniego dnia roboczego PRZED datą
stanu (ta sama reguła co przy płatnościach za kontenery — services/fx.kursy_przed).

Kurs jest ZAMROŻONY: zapisuje się w linijce przy wpisie. Poprawka kwot przy tej samej
dacie bierze kurs zapisany wcześniej; zmiana daty to nowy kurs (i znowu zamrożony).
Suma może wyjść ujemna (debet) — zapisujemy ją prawdziwą, a do zera przycina dopiero wykres.
"""

from __future__ import annotations

from datetime import date
from typing import Dict, Iterable, List, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from services import fx

Kurs = Tuple[float, Optional[date]]        # (kurs, data notowania)


class BrakKursu(Exception):
    """NBP nie dał kursu dla waluty — wpisu nie da się przeliczyć na zł."""


def przelicz(linie: Iterable, kursy: Dict[str, Kurs]) -> Tuple[List[dict], float]:
    """Linijki z kursem i kwotą w zł + suma. `kursy` musi mieć każdą walutę poza PLN."""
    wynik: List[dict] = []
    for i, l in enumerate(linie):
        if l.currency == "PLN":
            kurs, data_kursu = 1.0, None
        else:
            if l.currency not in kursy:
                raise BrakKursu(l.currency)
            kurs, data_kursu = kursy[l.currency]
        wynik.append({
            "position": i, "label": l.label, "currency": l.currency, "amount": round(l.amount, 2),
            "rate": kurs, "rate_date": data_kursu, "amount_pln": round(l.amount * kurs, 2),
        })
    return wynik, round(sum(w["amount_pln"] for w in wynik), 2)


async def kursy_dla(db: AsyncSession, waluty: Iterable[str], dzien: date,
                    zamrozone: Optional[Dict[str, Kurs]] = None) -> Dict[str, Kurs]:
    """Kurs każdej waluty obcej na dzień stanu: zamrożony z poprzedniej wersji wpisu,
    a brakujący — z NBP (dzień roboczy przed `dzien`)."""
    zamrozone = zamrozone or {}
    obce = {w for w in waluty if w != "PLN"}
    kursy = {w: zamrozone[w] for w in obce if w in zamrozone}
    brak = obce - kursy.keys()
    if brak:
        nbp = await fx.kursy_przed(db, [(w, dzien) for w in brak])
        for w in brak:
            if (w, dzien) not in nbp:
                raise BrakKursu(w)
            data_kursu, kurs = nbp[(w, dzien)]
            kursy[w] = (kurs, data_kursu)
    return kursy
