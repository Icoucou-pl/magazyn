"""Pieniądze firmy — saldo rachunku (od księgowej) + pożyczki wspólników.

Oba zbiory są RĘCZNE i zawsze przypisane do jednej firmy (firma_slug: amh/acti/veluxa).
Karmią wykres na pulpicie („Pieniądze firmy") i zakładkę w Cashflow.

Rozdział bytów jest celowy:
  • app_bank_balances — POMIAR stanu na dany dzień (jeden wpis na firmę i datę → UPSERT)
  • app_owner_loans   — ZDARZENIE: wpłata wspólnika (+) albo zwrot (−); jednego dnia
    może ich być kilka, więc bez klucza unikalnego

Saldo „bez pożyczek" liczy FRONT: raw(d) − Σ pożyczek o dacie ≤ d (narastająco).
Backend nie liczy tu niczego — oddaje surowe wiersze, żeby ta sama lista obsłużyła
i wykres, i tabelki do edycji.

Guard: odczyt = viewBankBalances ∧ viewFinancials; zapis dodatkowo editBankBalances
(patrz security.can_view_bank / can_edit_bank). Zakres firmowy usera pilnuje _guard_slug —
przy zapisie świadomie 403 zamiast cichego override'u z resolve_shop: podmiana firmy
pod ręką piszącego zapisałaby dane w cudzej książce.
"""

from bisect import bisect_left
from datetime import date, timedelta
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import (
    BankBalanceIn, BankBalanceOut, CurrentUser,
    MoneyBundle, OwnerLoanIn, OwnerLoanOut,
)
from security import (
    can_edit_bank, get_current_user, require_bank_edit, require_bank_view, resolve_shop,
)
from services.containers import fetch_containers

router = APIRouter(prefix="/api", tags=["bank"])

_BAL_COLS = "id, firma_slug, balance_date, amount_pln, note, created_at, updated_at"
_LOAN_COLS = "id, firma_slug, loan_date, amount_pln, partner, note, created_at, updated_at"


def _bal_out(r) -> BankBalanceOut:
    return BankBalanceOut(
        id=r["id"], firma_slug=r["firma_slug"], balance_date=r["balance_date"],
        amount_pln=float(r["amount_pln"] or 0), note=r["note"],
        created_at=r["created_at"], updated_at=r["updated_at"],
    )


def _loan_out(r) -> OwnerLoanOut:
    return OwnerLoanOut(
        id=r["id"], firma_slug=r["firma_slug"], loan_date=r["loan_date"],
        amount_pln=float(r["amount_pln"] or 0), partner=r["partner"], note=r["note"],
        created_at=r["created_at"], updated_at=r["updated_at"],
    )


async def _guard_slug(db: AsyncSession, slug: str, user: CurrentUser) -> str:
    """Firma musi istnieć w app_firmy i mieścić się w zakresie usera."""
    s = (slug or "").strip().lower()
    if not s:
        raise HTTPException(400, "Podaj firmę")
    row = (await db.execute(
        text(f"SELECT 1 FROM {settings.TABLE_FIRMY} WHERE LOWER(slug) = :s"), {"s": s}
    )).first()
    if not row:
        raise HTTPException(404, f"Nieznana firma: {s}")
    if resolve_shop(s, user) != s:
        raise HTTPException(403, "Brak dostępu do tej firmy")
    return s


# ===== ODCZYT =====

@router.get("/money", response_model=MoneyBundle)
async def get_money(shop: str = "", db: AsyncSession = Depends(get_db),
                    user: CurrentUser = Depends(require_bank_view)):
    """Saldo + pożyczki jednej firmy.

    shop="" (widok „Wszyscy") świadomie zwraca puste listy: rachunki trzech spółek
    to trzy różne konta, a odczyty księgowej wpadają w różnych dniach — zsumowana
    linia udawałaby pomiar, którego nikt nie wykonał. Front prosi wtedy o wybór firmy.
    """
    s = resolve_shop(shop, user)
    if not s:
        return MoneyBundle(shop="", balances=[], loans=[], can_edit=can_edit_bank(user))

    bal = await db.execute(
        text(f"SELECT {_BAL_COLS} FROM {settings.TABLE_BANK_BALANCES} "
             f"WHERE firma_slug = :s ORDER BY balance_date"),
        {"s": s},
    )
    loans = await db.execute(
        text(f"SELECT {_LOAN_COLS} FROM {settings.TABLE_OWNER_LOANS} "
             f"WHERE firma_slug = :s ORDER BY loan_date, id"),
        {"s": s},
    )
    return MoneyBundle(
        shop=s,
        balances=[_bal_out(r) for r in bal.mappings()],
        loans=[_loan_out(r) for r in loans.mappings()],
        can_edit=can_edit_bank(user),
    )


# ===== SALDO RACHUNKU =====

@router.post("/bank-balances", response_model=BankBalanceOut)
async def upsert_balance(payload: BankBalanceIn, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_bank_edit)):
    """Jedna firma + jedna data = jeden odczyt. Powtórny wpis NADPISUJE, nie duplikuje."""
    s = await _guard_slug(db, payload.firma_slug, user)
    r = await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_BANK_BALANCES}
                (firma_slug, balance_date, amount_pln, note, created_by)
            VALUES (:s, :d, :a, :n, :u)
            ON CONFLICT (firma_slug, balance_date) DO UPDATE
                SET amount_pln = EXCLUDED.amount_pln,
                    note       = EXCLUDED.note,
                    updated_at = now()
            RETURNING {_BAL_COLS}
        """),
        {"s": s, "d": payload.balance_date, "a": payload.amount_pln,
         "n": payload.note, "u": user.id},
    )
    row = r.mappings().first()
    await db.commit()
    return _bal_out(row)


@router.patch("/bank-balances/{bid}", response_model=BankBalanceOut)
async def update_balance(bid: int, payload: BankBalanceIn, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_bank_edit)):
    s = await _guard_slug(db, payload.firma_slug, user)
    old = (await db.execute(
        text(f"SELECT firma_slug FROM {settings.TABLE_BANK_BALANCES} WHERE id = :id"), {"id": bid}
    )).mappings().first()
    if not old:
        raise HTTPException(404, "Wpis nie znaleziony")
    await _guard_slug(db, old["firma_slug"], user)
    try:
        r = await db.execute(
            text(f"UPDATE {settings.TABLE_BANK_BALANCES} SET firma_slug = :s, balance_date = :d, "
                 f"amount_pln = :a, note = :n, updated_at = now() WHERE id = :id RETURNING {_BAL_COLS}"),
            {"s": s, "d": payload.balance_date, "a": payload.amount_pln, "n": payload.note, "id": bid},
        )
        row = r.mappings().first()
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "Na ten dzień jest już odczyt salda tej firmy")
    return _bal_out(row)


@router.delete("/bank-balances/{bid}", status_code=204)
async def delete_balance(bid: int, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_bank_edit)):
    row = (await db.execute(
        text(f"SELECT firma_slug FROM {settings.TABLE_BANK_BALANCES} WHERE id = :id"), {"id": bid}
    )).mappings().first()
    if not row:
        raise HTTPException(404, "Wpis nie znaleziony")
    await _guard_slug(db, row["firma_slug"], user)
    await db.execute(text(f"DELETE FROM {settings.TABLE_BANK_BALANCES} WHERE id = :id"), {"id": bid})
    await db.commit()


# ===== POŻYCZKI WSPÓLNIKÓW =====

@router.post("/owner-loans", response_model=OwnerLoanOut, status_code=201)
async def create_loan(payload: OwnerLoanIn, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(require_bank_edit)):
    s = await _guard_slug(db, payload.firma_slug, user)
    r = await db.execute(
        text(f"""
            INSERT INTO {settings.TABLE_OWNER_LOANS}
                (firma_slug, loan_date, amount_pln, partner, note, created_by)
            VALUES (:s, :d, :a, :p, :n, :u)
            RETURNING {_LOAN_COLS}
        """),
        {"s": s, "d": payload.loan_date, "a": payload.amount_pln,
         "p": payload.partner, "n": payload.note, "u": user.id},
    )
    row = r.mappings().first()
    await db.commit()
    return _loan_out(row)


@router.patch("/owner-loans/{lid}", response_model=OwnerLoanOut)
async def update_loan(lid: int, payload: OwnerLoanIn, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(require_bank_edit)):
    """Pełne nadpisanie wiersza — stąd poprawiasz literówkę w nazwisku wspólnika."""
    s = await _guard_slug(db, payload.firma_slug, user)
    old = (await db.execute(
        text(f"SELECT firma_slug FROM {settings.TABLE_OWNER_LOANS} WHERE id = :id"), {"id": lid}
    )).mappings().first()
    if not old:
        raise HTTPException(404, "Wpis nie znaleziony")
    await _guard_slug(db, old["firma_slug"], user)
    r = await db.execute(
        text(f"UPDATE {settings.TABLE_OWNER_LOANS} SET firma_slug = :s, loan_date = :d, "
             f"amount_pln = :a, partner = :p, note = :n, updated_at = now() "
             f"WHERE id = :id RETURNING {_LOAN_COLS}"),
        {"s": s, "d": payload.loan_date, "a": payload.amount_pln,
         "p": payload.partner, "n": payload.note, "id": lid},
    )
    row = r.mappings().first()
    await db.commit()
    return _loan_out(row)


@router.delete("/owner-loans/{lid}", status_code=204)
async def delete_loan(lid: int, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(require_bank_edit)):
    row = (await db.execute(
        text(f"SELECT firma_slug FROM {settings.TABLE_OWNER_LOANS} WHERE id = :id"), {"id": lid}
    )).mappings().first()
    if not row:
        raise HTTPException(404, "Wpis nie znaleziony")
    await _guard_slug(db, row["firma_slug"], user)
    await db.execute(text(f"DELETE FROM {settings.TABLE_OWNER_LOANS} WHERE id = :id"), {"id": lid})
    await db.commit()


# ===== PARTNERZY (podpowiedzi do pola tekstowego) =====

@router.get("/owner-loans/partners", response_model=List[str])
async def list_partners(shop: str = "", db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_bank_view)):
    """Nazwiska już użyte w danej firmie — datalist w formularzu, żeby ograniczyć literówki.

    Świadomie BEZ słownika wspólników: pożyczkodawców bywa więcej niż dwóch (Veluxa),
    lista rośnie sama, a błędny wpis poprawia się edycją wiersza.
    """
    s = resolve_shop(shop, user)
    if not s:
        return []
    r = await db.execute(
        text(f"SELECT DISTINCT partner FROM {settings.TABLE_OWNER_LOANS} "
             f"WHERE firma_slug = :s ORDER BY partner"),
        {"s": s},
    )
    return [row["partner"] for row in r.mappings()]


# ===== ZAPŁACONE ZA TOWAR W DRODZE =====

@router.get("/transit-paid-history")
async def transit_paid_history(days: int = 90, shop: str = "",
                               db: AsyncSession = Depends(get_db),
                               user: CurrentUser = Depends(require_bank_view)):
    """Ile pieniędzy siedziało danego dnia w kontenerach, które jeszcze nie weszły na magazyn.

    Po co: zaliczka schodzi z konta na długo przed tym, zanim towar trafi na półkę.
    Bez tej serii „kapitał łącznie" ma dziurę — gotówka już wyszła, magazyn jeszcze
    nie urósł, więc wykres pokazuje stratę tam, gdzie pieniądze tylko zmieniły postać.

    Reguła na dany dzień d:
        Σ wpłat o dacie ≤ d, dla kontenerów, których data wejścia na magazyn > d.

    Liczymy WYŁĄCZNIE realnie zapłacone raty (status 'paid' w /cashflow/ledger).
    Reszta balansu to zobowiązanie, nie kapitał — wliczenie jej zawyżałoby obraz.

    Kontener znika z tej serii dokładnie w dniu wejścia na magazyn (kaskada
    delivered_date → expected_delivery_date → ETA + odprawa, ta sama, której używa
    reszta aplikacji). Tego samego dnia jego towar wchodzi do /stock-value-history,
    więc nie ma okna, w którym byłby policzony dwa razy ani takiego, w którym znika.

    Przypisanie do firmy i przeliczenie na PLN — identyczne jak w /cashflow/ledger:
    firma o największym udziale wartości w locie/kontenerze, kurs NBP z dnia
    poprzedzającego wpłatę. Wpłata w obcej walucie bez notowania NBP jest POMIJANA
    (nie zgadujemy kursu) i policzona w `bez_kursu`.
    """
    s = resolve_shop(shop, user)
    today = date.today()
    start = today - timedelta(days=max(1, min(days, 1200)))
    containers = await fetch_containers(db)

    def _sv(x):
        return (x.get("value") if isinstance(x, dict) else getattr(x, "value", 0)) or 0.0

    def _ss(x):
        return (x.get("slug") if isinstance(x, dict) else getattr(x, "slug", None)) or "amh"

    def _firma(fb) -> str:
        if not fb:
            return "amh"
        return (_ss(max(fb.values(), key=_sv)) or "amh").lower()

    # (data_wpłaty, kwota, waluta, data_wejścia_na_magazyn) dla wybranej firmy
    pays: List[tuple] = []

    def _add(slug, kwota, waluta, data, wh):
        if kwota is None or data is None or data > today:
            return
        if s and slug != s:
            return
        pays.append((data, float(kwota), (waluta or "USD").upper(), wh))

    for c in containers:
        wh = c.warehouse_delivery_date
        c_slug = _firma(c.firma_breakdown)
        for a in (c.advances or []):
            _add(c_slug, a.kwota, a.waluta, a.data, wh)
        _add(c_slug, c.balance_kwota, c.balance_waluta, c.zaplacono_data, wh)
        for lot in (c.lots or []):
            l_slug = _firma(lot.firma_breakdown)
            for a in (lot.advances or []):
                _add(l_slug, a.kwota, a.waluta, a.data, wh)
            _add(l_slug, lot.balance_kwota, lot.balance_waluta, lot.zaplacono_data, wh)

    # FX: kurs NBP z dnia POPRZEDZAJĄCEGO wpłatę (jak w /cashflow/ledger).
    curs = sorted({p[2] for p in pays if p[2] != "PLN"})
    fx: dict = {}
    if curs:
        rows = await db.execute(text(f"""
            SELECT currency, rate_date, mid
            FROM {settings.TABLE_FX_RATES}
            WHERE currency = ANY(:curs)
            ORDER BY currency, rate_date
        """), {"curs": curs})
        tmp: dict = {}
        for r in rows:
            m = r._mapping
            tmp.setdefault(m["currency"], []).append((m["rate_date"], float(m["mid"])))
        for cur, arr in tmp.items():
            fx[cur] = ([d for d, _ in arr], [v for _, v in arr])

    def _rate_before(cur, d):
        pair = fx.get(cur)
        if not pair or d is None:
            return None
        dates, mids = pair
        i = bisect_left(dates, d) - 1
        return mids[i] if i >= 0 else None

    # Zamiast liczyć sumę dla każdego dnia osobno (O(dni × wpłaty)) robimy różnice:
    # wpłata dokłada kwotę od dnia płatności, a odejmuje ją od dnia wejścia na magazyn.
    delta: dict = {}
    no_rate = 0
    for d, kwota, cur, wh in pays:
        if cur == "PLN":
            pln = kwota
        else:
            r = _rate_before(cur, d)
            if r is None:
                no_rate += 1
                continue
            pln = kwota * r
        delta[d] = delta.get(d, 0.0) + pln
        if wh is not None:
            delta[wh] = delta.get(wh, 0.0) - pln

    running = sum(v for k, v in delta.items() if k < start)
    points = []
    cur_day = start
    while cur_day <= today:
        running += delta.get(cur_day, 0.0)
        points.append({"date": cur_day.isoformat(), "value": round(max(running, 0.0), 2)})
        cur_day += timedelta(days=1)

    return {
        "shop": s,
        "points": points,
        "current_value": points[-1]["value"] if points else 0.0,
        "bez_kursu": no_rate,
    }
