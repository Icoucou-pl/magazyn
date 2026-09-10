"""Życie produktu — historia zakupów i odtworzony stan magazynu.

WIDOCZNE WYŁĄCZNIE DLA SUPER-ADMINA. Celowo NIE ma tu klucza
uprawnienia i celowo nie dopisujemy nic do `PERMISSIONS` we
froncie: ptaszek w formularzu użytkownika mógłby sobie postawić
każdy z `manageUsers`, a super-admin jest przypięty do adresu
z ENV i nie da się go nadać z UI.

ŹRÓDŁA
------
· subiekt_przyjecia      — wiersz na warstwę przyjęcia, od 07.2023
· subiekt_rozchody_mies  — SKU × miesiąc × magazyn × typ
· subiekt_dwa_magazyny   — stan na dziś (punkt zaczepienia krzywej)

Oba pierwsze zasila skrypt `subiekt_historia.py` z maszyny przy
Subiekcie, raz na dobę.

KRZYWA STANU — dlaczego wstecz, a nie od zera
----------------------------------------------
Stan liczymy od DZIŚ i cofamy się deltami, tak samo jak robi to
`/stock-value-history` (routers/calendar.py). Liczenie od zera przez
trzy lata znaczyłoby, że jeden nieprzewidziany rodzaj ruchu w 2023
przesuwa całą krzywą aż do dzisiaj. Kotwicząc na dzisiejszym stanie
mamy „dziś" dokładne z definicji, a ewentualny błąd klasyfikacji
objawia się dryfem im dalej wstecz — czyli tam, gdzie i tak jest
najmniej istotny.

Na dzień wdrożenia rekonstrukcja zgadzała się co do sztuki dla
wszystkich 276 SKU (kontrola w `subiekt_historia.py`).

RUCH WEWNĘTRZNY
---------------
Przesunięcie między magazynem głównym a „w drodze" nie zmienia
stanu łącznego i musi zniknąć po OBU stronach. Wykluczamy je, gdy
`magazyn_zrodlowy` należy do naszej pary I RÓŻNI SIĘ od
`magazyn_id`. Warunek na różnicę jest kluczowy: zwrot od klienta
też wskazuje magazyn źródłowy, ale wraca na ten sam magazyn i musi
się policzyć.

Ruch z magazynu SPOZA pary (zdarzyło się 100002) to realne wejście
na stan i liczy się normalnie.
"""

from datetime import date
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import CurrentUser
from security import get_current_user

router = APIRouter(prefix="/api", tags=["lifecycle"])


# Magazyny, między którymi ruch jest wewnętrzny.
MAGAZYN_PODSTAWOWY = 100000
MAGAZYN_W_DRODZE = 100001
MAGAZYNY = (MAGAZYN_PODSTAWOWY, MAGAZYN_W_DRODZE)


# ===== DOSTĘP =====

def require_super_admin(
    user: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    """Wpuszcza wyłącznie adres z SUPER_ADMIN_EMAIL.

    Ta sama logika co `_is_super` w routers/users.py. Świadomie NIE
    jest to `require_perm(...)` — uprawnienie dałoby się nadać z UI,
    a to ma pozostać niewidoczne do czasu wypuszczenia funkcji.
    """
    super_email = (settings.SUPER_ADMIN_EMAIL or "").strip().lower()

    if not super_email:
        raise HTTPException(404, "Nie znaleziono")

    if not user or (user.email or "").strip().lower() != super_email:
        # 404, nie 403 — brak wskazówki, że taki endpoint istnieje.
        raise HTTPException(404, "Nie znaleziono")

    return user


# ===== MODELE =====

class Przyjecie(BaseModel):
    data: date
    typ: str
    magazyn_id: int
    magazyn_zrodlowy: Optional[int] = None
    ilosc: float
    koszt_jednostkowy: Optional[float] = None
    cena_waluta: Optional[float] = None
    kurs: Optional[float] = None
    towar_pln: Optional[float] = None       # cena_waluta × kurs
    logistyka_pln: Optional[float] = None   # koszt − towar
    skorygowane: bool = False
    dokument: Optional[str] = None
    numer_dokumentu: Optional[str] = None
    dostawca: Optional[str] = None


class PunktStanu(BaseModel):
    miesiac: date
    przyjeto: float
    wydano: float
    stan: float
    koszt_wlasny: Optional[float] = None


class Dostawca(BaseModel):
    nazwa: str
    przyjec: int
    ilosc: float
    od: date
    do: date
    sredni_koszt: Optional[float] = None


class Historia(BaseModel):
    sku: str
    stan_dzis: float
    pierwsze_przyjecie: Optional[date] = None
    liczba_zakupow: int
    sprowadzono_szt: float
    sprowadzono_pln: float
    przyjecia: List[Przyjecie]
    stan_miesiecznie: List[PunktStanu]
    dostawcy: List[Dostawca]
    miesiace_bez_pokrycia: List[date]
    dryf: float  # rekonstrukcja od zera minus stan dzisiejszy


# ===== ZAPYTANIA =====

Q_STAN = text("""
    SELECT COALESCE(stan_magazyn_podstawowy, 0)
         + COALESCE(stan_magazyn_w_drodze, 0) AS stan
    FROM subiekt_dwa_magazyny
    WHERE lower(sku) = lower(:sku)
    LIMIT 1
""")

Q_PRZYJECIA = text("""
    SELECT data, typ, magazyn_id, magazyn_zrodlowy, ilosc,
           koszt_jednostkowy, cena_waluta, kurs, skorygowane,
           dokument, numer_dokumentu, dostawca
    FROM subiekt_przyjecia
    WHERE lower(sku) = lower(:sku)
    ORDER BY data, przychod_id
""")

Q_ROZCHODY = text("""
    SELECT miesiac, magazyn_id, typ, ilosc, koszt_wlasny
    FROM subiekt_rozchody_mies
    WHERE lower(sku) = lower(:sku)
    ORDER BY miesiac
""")


# ===== POMOCNICZE =====

def _kolejny_miesiac(d: date) -> date:
    return date(d.year + (d.month == 12), (d.month % 12) + 1, 1)


def _wewnetrzny(magazyn_zrodlowy, magazyn_id) -> bool:
    """Ruch między naszymi dwoma magazynami — nie zmienia stanu."""
    if magazyn_zrodlowy is None:
        return False
    return (
        magazyn_zrodlowy in MAGAZYNY
        and magazyn_zrodlowy != magazyn_id
    )


def _f(v) -> Optional[float]:
    return None if v is None else float(v)


# ===== ENDPOINT =====

@router.get("/products/{sku}/historia", response_model=Historia)
async def historia_produktu(
    sku: str,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_super_admin),
):
    przyjecia_rows = (
        await db.execute(Q_PRZYJECIA, {"sku": sku})
    ).mappings().all()

    rozchody_rows = (
        await db.execute(Q_ROZCHODY, {"sku": sku})
    ).mappings().all()

    if not przyjecia_rows and not rozchody_rows:
        raise HTTPException(404, f"Brak historii dla SKU {sku}")

    stan_row = (
        await db.execute(Q_STAN, {"sku": sku})
    ).first()

    stan_dzis = float(stan_row[0]) if stan_row else 0.0

    # ── przyjęcia ────────────────────────────────────────────
    przyjecia: List[Przyjecie] = []

    for r in przyjecia_rows:
        koszt = _f(r["koszt_jednostkowy"])
        cena = _f(r["cena_waluta"])
        kurs = _f(r["kurs"])

        towar = (
            round(cena * kurs, 4)
            if cena is not None and kurs is not None
            else None
        )

        przyjecia.append(Przyjecie(
            data=r["data"],
            typ=r["typ"],
            magazyn_id=r["magazyn_id"],
            magazyn_zrodlowy=r["magazyn_zrodlowy"],
            ilosc=float(r["ilosc"]),
            koszt_jednostkowy=koszt,
            cena_waluta=cena,
            kurs=kurs,
            towar_pln=towar,
            logistyka_pln=(
                round(koszt - towar, 4)
                if koszt is not None and towar is not None
                else None
            ),
            skorygowane=bool(r["skorygowane"]),
            dokument=r["dokument"],
            numer_dokumentu=r["numer_dokumentu"],
            dostawca=r["dostawca"],
        ))

    # ── miesięczne delty ─────────────────────────────────────
    wejscia: Dict[date, float] = {}
    wyjscia: Dict[date, float] = {}
    cogs: Dict[date, float] = {}

    for r in przyjecia_rows:
        if _wewnetrzny(r["magazyn_zrodlowy"], r["magazyn_id"]):
            continue

        m = r["data"].replace(day=1)
        wejscia[m] = wejscia.get(m, 0.0) + float(r["ilosc"])

    for r in rozchody_rows:
        if r["typ"] != "WYDANIE":
            continue

        m = r["miesiac"]
        wyjscia[m] = wyjscia.get(m, 0.0) + float(r["ilosc"])

        if r["koszt_wlasny"] is not None:
            cogs[m] = float(r["koszt_wlasny"])

    if not wejscia and not wyjscia:
        raise HTTPException(404, f"Brak ruchów dla SKU {sku}")

    od = min(list(wejscia) + list(wyjscia))
    do = max(list(wejscia) + list(wyjscia))

    miesiace: List[date] = []
    kursor = od

    while kursor <= do:
        miesiace.append(kursor)
        kursor = _kolejny_miesiac(kursor)

    # ── krzywa stanu: kotwica na dziś, cofanie deltami ───────
    stany: Dict[date, float] = {}
    biezacy = stan_dzis

    for m in reversed(miesiace):
        stany[m] = biezacy
        delta = wejscia.get(m, 0.0) - wyjscia.get(m, 0.0)
        biezacy = biezacy - delta

    # `biezacy` to teraz stan sprzed pierwszego ruchu — powinien
    # wynosić 0. Cokolwiek innego jest miarą rozjazdu klasyfikacji
    # i wystawiamy to na wierzch zamiast chować.
    dryf = round(biezacy, 3)

    stan_miesiecznie = [
        PunktStanu(
            miesiac=m,
            przyjeto=round(wejscia.get(m, 0.0), 3),
            wydano=round(wyjscia.get(m, 0.0), 3),
            stan=round(stany[m], 3),
            koszt_wlasny=cogs.get(m),
        )
        for m in miesiace
    ]

    # Miesiąc bez pokrycia: stan na koniec niższy niż to, co w tym
    # miesiącu zeszło. Sygnał, że towaru zabrakło albo było o włos.
    bez_pokrycia = [
        p.miesiac
        for p in stan_miesiecznie
        if p.wydano > 0 and p.stan < p.wydano
    ]

    # ── dostawcy ─────────────────────────────────────────────
    agg: Dict[str, dict] = {}

    for r in przyjecia_rows:
        if r["typ"] != "ZAKUP" or not r["dostawca"]:
            continue

        a = agg.setdefault(r["dostawca"], {
            "przyjec": 0, "ilosc": 0.0, "wartosc": 0.0,
            "od": r["data"], "do": r["data"],
        })

        ilosc = float(r["ilosc"])
        a["przyjec"] += 1
        a["ilosc"] += ilosc
        a["od"] = min(a["od"], r["data"])
        a["do"] = max(a["do"], r["data"])

        if r["koszt_jednostkowy"] is not None:
            a["wartosc"] += ilosc * float(r["koszt_jednostkowy"])

    dostawcy = [
        Dostawca(
            nazwa=nazwa,
            przyjec=a["przyjec"],
            ilosc=round(a["ilosc"], 3),
            od=a["od"],
            do=a["do"],
            sredni_koszt=(
                round(a["wartosc"] / a["ilosc"], 2)
                if a["ilosc"] else None
            ),
        )
        for nazwa, a in sorted(
            agg.items(),
            key=lambda kv: kv[1]["od"],
        )
    ]

    zakupy = [p for p in przyjecia if p.typ == "ZAKUP"]

    return Historia(
        sku=sku,
        stan_dzis=stan_dzis,
        pierwsze_przyjecie=(
            przyjecia[0].data if przyjecia else None
        ),
        liczba_zakupow=len(zakupy),
        sprowadzono_szt=round(
            sum(p.ilosc for p in zakupy), 3
        ),
        sprowadzono_pln=round(
            sum(
                p.ilosc * p.koszt_jednostkowy
                for p in zakupy
                if p.koszt_jednostkowy is not None
            ),
            2,
        ),
        przyjecia=przyjecia,
        stan_miesiecznie=stan_miesiecznie,
        dostawcy=dostawcy,
        miesiace_bez_pokrycia=bez_pokrycia,
        dryf=dryf,
    )
