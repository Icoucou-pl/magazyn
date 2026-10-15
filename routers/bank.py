"""Pieniądze firmy — saldo rachunku (od księgowej) + pożyczki wspólników.

Oba zbiory są RĘCZNE i zawsze przypisane do jednej firmy (firma_slug: amh/acti/veluxa).
Karmią wykres na pulpicie („Pieniądze firmy") i zakładkę w Cashflow.

Rozdział bytów jest celowy:
  • app_bank_balances — POMIAR stanu na dany dzień (jeden wpis na firmę i datę → UPSERT);
    amount_pln to suma w zł, a rozbicie na subkonta/waluty z zamrożonym kursem NBP leży
    w app_bank_balance_lines (services/stan_konta.py). Stary wpis bez linijek = jedna kwota w zł.
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

import audit
from audit_opisy import f_data, f_kwota, f_zl
from config import settings
from database import get_db
from models import (
    BankBalanceIn, BankBalanceLineIn, BankBalanceLineOut, BankBalanceOut, CurrentUser,
    MoneyBundle, OwnerLoanIn, OwnerLoanOut,
)
from security import (
    can_edit_bank, get_current_user, require_bank_edit, require_bank_view, resolve_shop,
)
from services.containers import fetch_containers
from services.stan_konta import BrakKursu, kursy_dla, przelicz

router = APIRouter(prefix="/api", tags=["bank"])

_BAL_COLS = "id, firma_slug, balance_date, amount_pln, note, created_at, updated_at"
_LOAN_COLS = ("id, firma_slug, loan_date, amount_pln, partner, numer_umowy, data_zawarcia, "
              "termin_splaty, oprocentowanie, splacono_data, note, created_at, updated_at")


_LINE_COLS = "balance_id, label, currency, amount, rate, rate_date, amount_pln"


def _line_out(l) -> BankBalanceLineOut:
    return BankBalanceLineOut(
        label=l["label"], currency=l["currency"], amount=float(l["amount"]),
        rate=float(l["rate"]), rate_date=l["rate_date"], amount_pln=float(l["amount_pln"]),
    )


def _bal_out(r, lines=None) -> BankBalanceOut:
    amount = float(r["amount_pln"] or 0)
    # Wpis sprzed rozbicia na waluty nie ma linijek — pokazujemy go jako jedną linijkę w zł,
    # żeby edycja otwierała się tak samo jak przy nowych wpisach.
    out_lines = [_line_out(l) for l in lines] if lines else [
        BankBalanceLineOut(currency="PLN", amount=amount, rate=1.0, amount_pln=amount)
    ]
    return BankBalanceOut(
        id=r["id"], firma_slug=r["firma_slug"], balance_date=r["balance_date"],
        amount_pln=amount, note=r["note"], lines=out_lines,
        created_at=r["created_at"], updated_at=r["updated_at"],
    )


async def _lines_of(db: AsyncSession, ids) -> dict:
    """{balance_id: [linijki w kolejności z formularza]}."""
    ids = list(ids)
    if not ids:
        return {}
    r = await db.execute(
        text(f"SELECT {_LINE_COLS} FROM {settings.TABLE_BANK_BALANCE_LINES} "
             f"WHERE balance_id = ANY(:ids) ORDER BY balance_id, position, id"),
        {"ids": ids},
    )
    out: dict = {}
    for l in r.mappings():
        out.setdefault(l["balance_id"], []).append(l)
    return out


async def _zamrozone(db: AsyncSession, bid) -> dict:
    """Kursy zapisane przy poprzedniej wersji wpisu: {waluta: (kurs, data notowania)}."""
    if bid is None:
        return {}
    r = await db.execute(
        text(f"SELECT currency, rate, rate_date FROM {settings.TABLE_BANK_BALANCE_LINES} "
             f"WHERE balance_id = :b AND currency <> 'PLN'"),
        {"b": bid},
    )
    return {x["currency"]: (float(x["rate"]), x["rate_date"]) for x in r.mappings()}


async def _przelicz(db: AsyncSession, payload: BankBalanceIn, zamrozone: dict):
    """Linijki z kursem NBP i suma w zł. Brak kursu = 400 z nazwą waluty, nie cichy zły wynik."""
    linie = payload.lines or [BankBalanceLineIn(currency="PLN", amount=payload.amount_pln)]
    try:
        kursy = await kursy_dla(db, [l.currency for l in linie], payload.balance_date, zamrozone)
        return przelicz(linie, kursy)
    except BrakKursu as e:
        raise HTTPException(400, f"Brak kursu NBP dla {e} przed {f_data(payload.balance_date)} — spróbuj później")


async def _zapisz_linie(db: AsyncSession, bid, wiersze) -> None:
    await db.execute(text(f"DELETE FROM {settings.TABLE_BANK_BALANCE_LINES} WHERE balance_id = :b"), {"b": bid})
    await db.execute(
        text(f"INSERT INTO {settings.TABLE_BANK_BALANCE_LINES} "
             f"(balance_id, position, label, currency, amount, rate, rate_date, amount_pln) "
             f"VALUES (:b, :position, :label, :currency, :amount, :rate, :rate_date, :amount_pln)"),
        [{"b": bid, **w} for w in wiersze],
    )


def _opis_kwoty(wiersze, suma: float) -> str:
    """„225 080,50 zł (PLN 120 000,00 zł, EUR 1: 15 000,00 EUR …)” — rozbicie tylko gdy jest co rozbijać."""
    if len(wiersze) == 1 and wiersze[0]["currency"] == "PLN" and not wiersze[0]["label"]:
        return f_zl(suma)
    czesci = [f"{w['label'] + ': ' if w['label'] else ''}{f_kwota(w['currency'])(w['amount'])}" for w in wiersze]
    return f"{f_zl(suma)} ({', '.join(czesci)})"


def _loan_out(r) -> OwnerLoanOut:
    return OwnerLoanOut(
        id=r["id"], firma_slug=r["firma_slug"], loan_date=r["loan_date"],
        amount_pln=float(r["amount_pln"] or 0), partner=r["partner"],
        numer_umowy=r["numer_umowy"], data_zawarcia=r["data_zawarcia"],
        termin_splaty=r["termin_splaty"], oprocentowanie=r["oprocentowanie"],
        splacono_data=r["splacono_data"], note=r["note"],
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
        # Najstarsza wpłata na górze — jej termin spłaty wypada najwcześniej.
        text(f"SELECT {_LOAN_COLS} FROM {settings.TABLE_OWNER_LOANS} "
             f"WHERE firma_slug = :s ORDER BY loan_date ASC, id ASC"),
        {"s": s},
    )
    bal_rows = list(bal.mappings())
    lines = await _lines_of(db, [r["id"] for r in bal_rows])
    return MoneyBundle(
        shop=s,
        balances=[_bal_out(r, lines.get(r["id"])) for r in bal_rows],
        loans=[_loan_out(r) for r in loans.mappings()],
        can_edit=can_edit_bank(user),
    )


# ===== SALDO RACHUNKU =====

@router.post("/bank-balances", response_model=BankBalanceOut)
async def upsert_balance(payload: BankBalanceIn, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_bank_edit)):
    """Jedna firma + jedna data = jeden odczyt. Powtórny wpis NADPISUJE, nie duplikuje
    (i bierze kursy zamrożone w nadpisywanym wpisie — ta sama data, ten sam kurs)."""
    s = await _guard_slug(db, payload.firma_slug, user)
    old = (await db.execute(
        text(f"SELECT id FROM {settings.TABLE_BANK_BALANCES} WHERE firma_slug = :s AND balance_date = :d"),
        {"s": s, "d": payload.balance_date},
    )).first()
    wiersze, suma = await _przelicz(db, payload, await _zamrozone(db, old[0] if old else None))
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
        {"s": s, "d": payload.balance_date, "a": suma, "n": payload.note, "u": user.id},
    )
    row = r.mappings().first()
    await _zapisz_linie(db, row["id"], wiersze)
    await db.commit()
    audit.note(f"wpisał stan konta {s.upper()} na {f_data(payload.balance_date)}: {_opis_kwoty(wiersze, suma)}",
               resource_id=row["id"])
    return _bal_out(row, (await _lines_of(db, [row["id"]])).get(row["id"]))


@router.patch("/bank-balances/{bid}", response_model=BankBalanceOut)
async def update_balance(bid: int, payload: BankBalanceIn, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_bank_edit)):
    """Poprawka odczytu. Ta sama data → kursy zostają zamrożone; inna data → nowy kurs NBP."""
    s = await _guard_slug(db, payload.firma_slug, user)
    old = (await db.execute(
        text(f"SELECT firma_slug, balance_date FROM {settings.TABLE_BANK_BALANCES} WHERE id = :id"), {"id": bid}
    )).mappings().first()
    if not old:
        raise HTTPException(404, "Wpis nie znaleziony")
    await _guard_slug(db, old["firma_slug"], user)
    zamrozone = await _zamrozone(db, bid) if old["balance_date"] == payload.balance_date else {}
    wiersze, suma = await _przelicz(db, payload, zamrozone)
    try:
        r = await db.execute(
            text(f"UPDATE {settings.TABLE_BANK_BALANCES} SET firma_slug = :s, balance_date = :d, "
                 f"amount_pln = :a, note = :n, updated_at = now() WHERE id = :id RETURNING {_BAL_COLS}"),
            {"s": s, "d": payload.balance_date, "a": suma, "n": payload.note, "id": bid},
        )
        row = r.mappings().first()
        await _zapisz_linie(db, bid, wiersze)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "Na ten dzień jest już odczyt salda tej firmy")
    audit.note(f"poprawił stan konta {s.upper()} na {f_data(payload.balance_date)}: {_opis_kwoty(wiersze, suma)}",
               resource_id=bid)
    return _bal_out(row, (await _lines_of(db, [bid])).get(bid))


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
                (firma_slug, loan_date, amount_pln, partner, numer_umowy, data_zawarcia,
                 termin_splaty, oprocentowanie, splacono_data, note, created_by)
            VALUES (:s, :d, :a, :p, :nu, :dz, :ts, :op, :sd, :n, :u)
            RETURNING {_LOAN_COLS}
        """),
        {"s": s, "d": payload.loan_date, "a": payload.amount_pln, "p": payload.partner,
         "nu": payload.numer_umowy, "dz": payload.data_zawarcia, "ts": payload.termin_splaty,
         "op": payload.oprocentowanie, "sd": payload.splacono_data, "n": payload.note, "u": user.id},
    )
    row = r.mappings().first()
    await db.commit()
    return _loan_out(row)


@router.patch("/owner-loans/{lid}", response_model=OwnerLoanOut)
async def update_loan(lid: int, payload: OwnerLoanIn, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(require_bank_edit)):
    """Pełne nadpisanie wiersza — stąd poprawiasz literówkę w nazwisku i oznaczasz spłatę.

    Spłata = ustawienie `splacono_data`. Cofnięcie = wyzerowanie go na NULL.
    Osobnego endpointu nie ma celowo: jedna ścieżka zapisu, jedna walidacja.
    """
    s = await _guard_slug(db, payload.firma_slug, user)
    old = (await db.execute(
        text(f"SELECT firma_slug FROM {settings.TABLE_OWNER_LOANS} WHERE id = :id"), {"id": lid}
    )).mappings().first()
    if not old:
        raise HTTPException(404, "Wpis nie znaleziony")
    await _guard_slug(db, old["firma_slug"], user)
    r = await db.execute(
        text(f"UPDATE {settings.TABLE_OWNER_LOANS} SET firma_slug = :s, loan_date = :d, "
             f"amount_pln = :a, partner = :p, numer_umowy = :nu, data_zawarcia = :dz, "
             f"termin_splaty = :ts, oprocentowanie = :op, splacono_data = :sd, note = :n, "
             f"updated_at = now() WHERE id = :id RETURNING {_LOAN_COLS}"),
        {"s": s, "d": payload.loan_date, "a": payload.amount_pln, "p": payload.partner,
         "nu": payload.numer_umowy, "dz": payload.data_zawarcia, "ts": payload.termin_splaty,
         "op": payload.oprocentowanie, "sd": payload.splacono_data, "n": payload.note, "id": lid},
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
    reszta aplikacji). Dla AMH tego samego dnia jego towar wchodzi do /stock-value-history,
    więc nie ma okna, w którym byłby policzony dwa razy ani takiego, w którym znika.
    Acti/Veluxa: tam wykres bierze przyjęcie z dziennika Fakturowni (PZ / przesunięcie
    z „w drodze"), więc data może się rozjechać o kilka dni z datą kontenera.

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
