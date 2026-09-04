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
