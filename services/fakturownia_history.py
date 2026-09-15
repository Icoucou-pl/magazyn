"""
Fakturownia → PostgreSQL — dziennik ruchów magazynowych (historia produktu).

PO CO: zakładka „Historia produktu" i „2.0" siedziała dotąd wyłącznie na
tabelach Subiekta, czyli działała tylko dla AMH. Acti i Veluxa mają swoje
magazyny w Fakturowni i ten moduł buduje dla nich równoważne źródło.

ŹRÓDŁO PRAWDY: /warehouse_actions.json
--------------------------------------
To jest gotowy ledger — jeden wiersz na ruch, z ilością, ceną, magazynem,
datą dokumentu i flagą usunięcia. Diagnostyka na produkcji (09.2026):

    ACTI    997 akcji, suma ruchów == warehouse_quantity dla 55/58 SKU
    VELUXA 1886 akcji, suma ruchów == warehouse_quantity dla 28/28 SKU

NIE WOLNO odtwarzać historii przez iterowanie `warehouse_documents` i
sumowanie `warehouse_actions` z ich szczegółów — ta droga podwaja część
pozycji (SZP1 dawało 556 zamiast 276). Dokumenty służą wyłącznie do
metadanych: numeru i kontrahenta.

ZNAK BIERZEMY Z `quantity`, NIGDY Z `kind` ANI Z `sign`
-------------------------------------------------------
`quantity` przychodzi z gotowym znakiem: PZ dodatnie, WZ ujemne. Pole
`sign` jest niespójne — na 72 z 75 korekt WZK w Acti kłóci się ze znakiem
ilości (sign = -1 przy quantity = +1). Wyliczanie kierunku z `kind` też
się wywraca, bo zdarzają się ujemne PZ (zwrot do dostawcy, 1 szt w Veluxie)
i ujemne WZK. Dlatego reguła jest jedna: `kind` nazywa typ ruchu, a
kierunek zawsze czytamy ze znaku ilości.

WZK NETUJE SPRZEDAŻ, NIE JEST PRZYJĘCIEM
----------------------------------------
Korekta wydania wraca towar na stan, ale nie jest zakupem — to niedoszła
sprzedaż. Gdyby trafiła do przyjęć, popyt byłby zawyżony: SZP1 ma 398 szt
wydań i 40 szt korekt, czyli realnie 358 szt (10,1% różnicy, rozłożone na
10 miesięcy). Dlatego agregacja miesięczna wrzuca `wz` i `wzk` do jednego
kubełka WYDANIE z ilością netto. Krzywa stanu wychodzi wtedy tak samo
dobrze: 634 przyjęć − 358 rozchodu = 276 = stan z karty.

JEDNA TABELA, NIE TRZY
----------------------
Model Subiekta ma osobne `subiekt_przyjecia` i `subiekt_rozchody_mies`, bo
źródłem jest SQL Server na maszynie w biurze, do którego apka nie sięga —
skrypt musi raz na dobę wypchnąć gotowe agregaty. Tutaj ledger jest już
znormalizowany i mieści się w ~2 tys. wierszy na firmę, więc przyjęcia i
rozchody miesięczne to dwa SELECT-y, a nie dwie tabele. Mniej miejsc, w
których dane mogą się rozjechać z ledgerem.

RUCH WEWNĄTRZ GRUPY
-------------------
AMH, Acti i Veluxa handlują między sobą i te faktury generują normalne PZ
i WZ. Bez oznaczenia psują trzy rzeczy: „Sprowadzono" liczy ten sam towar
dwa razy na poziomie grupy, lista dostawców pokazuje własną spółkę obok
chińskiej fabryki, a krzywa kosztu miesza cenę fabryki z ceną transferową.
Skala jest realna — AMH to trzeci dostawca Acti (543 szt), a 4687 z 7865
szt rozchodu Veluxy idzie do AMH.

Rozpoznajemy po NIP-ie kontrahenta (`/clients.json` → `tax_no`) zderzonym
z NIP-ami z `app_firmy` — tak samo jak `fakturownia_sales`. Ruch dostaje
`is_internal = true`; co z tym zrobić, decyduje router, nie ingesta.

MAPOWANIE SKU
-------------
`code` na akcji bywa puste — 276 z 997 akcji w Acti, 686 z 1886 w Veluxie.
Dlatego mapujemy przez `SkuMap` z `fakturownia_sales`: KATALOG → EAN →
MAPA → KOD. Świadomie reużywamy tamtej klasy zamiast pisać drugą: to ona
zna regułę „SKU zawsze ma literę", która naprawiła 18 pozycji Acti
wrzuconych na wspólny EAN. Dwie różne prawdy o tym, czym jest SKU danej
firmy, byłyby gorsze niż import prywatnej nazwy.

INWENTARYZACJA
--------------
`inventory` nie zmienia stanu w żadnej z firm (21 pozycji w Acti, 87 w
Veluxie, wszystkie z `inventory_quantity == inventory_new_quantity`).
Liczymy mimo to `delta = new - old` i zapisujemy jako zwykły ruch — gdy
kiedyś pojawi się realna korekta, wejdzie sama.

TYLKO GET. Ten moduł niczego w Fakturowni nie zmienia.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import SessionLocal

# Reużycie helperów z istniejących modułów Fakturowni — HTTP, stronicowanie
# i mapa SKU są już rozwiązane i przetestowane na produkcji.
from services.fakturownia import (
    _fetch_all,
    _now_local,
    _to_float,
)
from services.fakturownia_sales import (
    SkuMap,
    _digits,
    _parse_date,
    _txt,
    _wczytaj_mape,
    _zapisz_mape,
)

TABELA = "fakturownia_ruchy"

# Rodzaje ruchu, które w agregacie miesięcznym lecą do jednego kubełka.
# Kierunek i tak bierzemy ze znaku ilości — to jest wyłącznie nazwa typu.
_TYP_WG_KIND = {
    "pz": "ZAKUP",
    "pw": "WEWNETRZNE",
    "zw": "ZWROT",
    "wz": "WYDANIE",
    "wzk": "WYDANIE",          # korekta netuje sprzedaż, patrz docstring
    "rw": "WEWNETRZNE",
    "mm-": "PRZESUNIECIE",
    "mm+": "PRZESUNIECIE",
    "mm": "PRZESUNIECIE",
    "inventory": "INNE",
}


@dataclass
class Firma:
    slug: str
    firma_id: int
    url: str
    token: str
    wh_main: str = ""
    wh_drodze: str = ""


@dataclass
class Wynik:
    slug: str
    ok: bool = True
    error: Optional[str] = None
    akcji: int = 0
    zapisanych: int = 0
    usunietych: int = 0
    bez_sku: int = 0
    wewnetrznych: int = 0
    dokumentow: int = 0
    od: Optional[date] = None
    do: Optional[date] = None
    probki_bez_sku: List[str] = field(default_factory=list)


_status: Dict[str, Any] = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "error": None,
    "message": None,
    "wyniki": [],
}


# ============================================================
# KONFIGURACJA
# ============================================================

def _env(slug: str, key: str) -> str:
    return (os.getenv(f"FAKTUROWNIA_{slug.upper()}_{key}") or "").strip()


def is_configured() -> bool:
    slugs = {"acti", "veluxa"}
    for k in os.environ:
        if k.startswith("FAKTUROWNIA_") and k.endswith("_URL"):
            slugs.add(k[len("FAKTUROWNIA_"):-len("_URL")].lower())
    return any(_env(s, "URL") and _env(s, "TOKEN") for s in slugs)


def get_status() -> Dict[str, Any]:
    return dict(_status)


def is_running() -> bool:
    return bool(_status.get("running"))


def mark_started() -> None:
    _status.update({
        "running": True,
        "started_at": _now_local().isoformat(),
        "finished_at": None,
        "error": None,
        "message": None,
        "wyniki": [],
    })


async def _load_firmy() -> Tuple[List[Firma], Set[str]]:
    """Sklepy nie-AMH z kompletem URL+TOKEN oraz NIP-y wszystkich naszych firm.

    NIP-y lecą ze WSZYSTKICH wierszy app_firmy (łącznie z AMH) — służą do
    rozpoznania kontrahenta wewnątrzgrupowego, nie do wyboru sklepu.
    """
    out: List[Firma] = []
    nasze_nipy: Set[str] = set()
    try:
        async with SessionLocal() as session:
            r = await session.execute(text(
                f"SELECT id, slug, COALESCE(is_self, FALSE) AS is_self, nip "
                f"FROM {settings.TABLE_FIRMY} ORDER BY sort_order, id"
            ))
            rows = list(r.mappings())
    except Exception as e:
        print(f"[fakturownia_history] _load_firmy błąd: {e}")
        return out, nasze_nipy

    for row in rows:
        nip = _digits(row.get("nip"))
        if nip:
            nasze_nipy.add(nip)
        slug = (row["slug"] or "").strip()
        if not slug or row["is_self"]:
            continue
        url, token = _env(slug, "URL"), _env(slug, "TOKEN")
        if url and token:
            out.append(Firma(
                slug=slug,
                firma_id=int(row["id"]),
                url=url.rstrip("/"),
                token=token,
                wh_main=_env(slug, "WH_MAIN"),
                wh_drodze=_env(slug, "WH_DRODZE"),
            ))
    return out, nasze_nipy


# ============================================================
# SCHEMAT
# ============================================================

async def _ensure_schema(session: AsyncSession) -> None:
    """Siatka bezpieczeństwa — idempotentne tworzenie tabeli ledgera."""
    await session.execute(text(
        f"CREATE TABLE IF NOT EXISTS {TABELA} ("
        " firma_id INTEGER NOT NULL,"
        " action_id BIGINT NOT NULL,"
        " product_id VARCHAR,"
        " sku VARCHAR,"
        " sku_canon VARCHAR,"
        " kind VARCHAR NOT NULL,"
        " typ VARCHAR NOT NULL,"
        " ilosc NUMERIC NOT NULL,"
        " data DATE,"
        " magazyn_id VARCHAR,"
        " koszt_jednostkowy NUMERIC,"
        " waluta VARCHAR,"
        " dokument_id BIGINT,"
        " numer_dokumentu VARCHAR,"
        " kontrahent VARCHAR,"
        " kontrahent_nip VARCHAR,"
        " is_internal BOOLEAN DEFAULT FALSE,"
        " w_drodze BOOLEAN DEFAULT FALSE,"
        " updated_at TIMESTAMP DEFAULT now(),"
        " PRIMARY KEY (firma_id, action_id)"
        ")"
    ))
    await session.commit()

    # Dokładka dla kont, na których tabela powstała przed tym polem.
    # CREATE TABLE IF NOT EXISTS nie dodaje kolumn do istniejącej tabeli.
    await session.execute(text(
        f"ALTER TABLE {TABELA} ADD COLUMN IF NOT EXISTS w_drodze BOOLEAN DEFAULT FALSE"
    ))
    await session.commit()

    for idx, kol in (
        ("idx_fakturownia_ruchy_canon", "(firma_id, sku_canon)"),
        ("idx_fakturownia_ruchy_data", "(firma_id, data)"),
    ):
        await session.execute(text(
            f"CREATE INDEX IF NOT EXISTS {idx} ON {TABELA} {kol}"
        ))
        await session.commit()


# ============================================================
# POBRANIE
# ============================================================

def _prawda(v: Any) -> bool:
    return str(v).strip().lower() in ("1", "true", "t", "yes")


async def _klienci_nip(firma: Firma) -> Dict[str, str]:
    """client_id → NIP. Potrzebne wyłącznie do rozpoznania ruchu w grupie."""
    out: Dict[str, str] = {}
    try:
        for c in await _fetch_all(firma, "clients.json"):
            cid = _txt(c.get("id"), 32)
            nip = _digits(c.get("tax_no") or c.get("nip"))
            if cid and nip:
                out[cid] = nip
    except Exception as e:
        # Brak listy klientów nie blokuje ingesty — tracimy tylko flagę
        # wewnętrzności, a nie cały ledger.
        print(f"[fakturownia_history] {firma.slug}: clients.json — {e}")
    return out


async def _dokumenty(firma: Firma) -> Dict[str, dict]:
    """warehouse_document_id → metadane. Wyłącznie numer i kontrahent."""
    out: Dict[str, dict] = {}
    for d in await _fetch_all(firma, "warehouse_documents.json"):
        did = _txt(d.get("id"), 32)
        if not did:
            continue
        out[did] = {
            "numer": _txt(d.get("number"), 64),
            "client_id": _txt(d.get("client_id"), 32),
            "kontrahent": _txt(d.get("client_name"), 255),
        }
    return out


def _delta_inwentaryzacji(a: dict) -> Optional[float]:
    """Dla `inventory` ilość bywa zerowa, a korekta siedzi w dwóch polach."""
    stare, nowe = a.get("inventory_quantity"), a.get("inventory_new_quantity")
    if stare is None or nowe is None:
        return None
    return _to_float(nowe) - _to_float(stare)


def _normalizuj(a: dict, firma: Firma, mapa: SkuMap,  # noqa: C901
                dokumenty: Dict[str, dict], nipy_klientow: Dict[str, str],
                nasze_nipy: Set[str], wynik: Wynik) -> Optional[dict]:
    aid = a.get("id")
    if aid is None:
        return None

    kind = (str(a.get("kind") or "")).strip().lower()

    # ZNAK ZAWSZE Z `quantity` — patrz docstring modułu.
    ilosc = _to_float(a.get("quantity"))
    if kind == "inventory":
        delta = _delta_inwentaryzacji(a)
        if delta is not None:
            ilosc = delta

    symbol, _zrodlo = mapa.rozwiaz(a.get("product_id"), a.get("code"))
    if not symbol:
        wynik.bez_sku += 1
        if len(wynik.probki_bez_sku) < 10:
            wynik.probki_bez_sku.append(
                f"{a.get('product_name') or '?'} (pid {a.get('product_id')})"
            )

    doc = dokumenty.get(_txt(a.get("warehouse_document_id"), 32) or "", {})
    nip = nipy_klientow.get(doc.get("client_id") or "", "")
    wewnetrzny = bool(nip and nip in nasze_nipy)
    if wewnetrzny:
        wynik.wewnetrznych += 1

    # Przyjęcie od własnej spółki to przesunięcie w grupie, nie zakup —
    # inaczej zawyża „Sprowadzono" i wchodzi na listę dostawców.
    typ = _TYP_WG_KIND.get(kind, "INNE")
    if wewnetrzny and typ == "ZAKUP":
        typ = "WEWNETRZNE"

    # Ujemne PZ to zwrot do dostawcy — w Subiekcie odpowiednik KPZ.
    if kind == "pz" and ilosc < 0:
        typ = "ZWROT_DOSTAWCA"

    data = _parse_date(a.get("wd_issue_date")) or _parse_date(a.get("created_at"))
    if data:
        wynik.od = data if wynik.od is None else min(wynik.od, data)
        wynik.do = data if wynik.do is None else max(wynik.do, data)

    koszt = _to_float(a.get("purchase_price_net"))

    # Czy ruch dotyczy magazynu „Towary w drodze". Potrzebne, żeby dało się
    # narysować drugą krzywą — tę pokazującą, ile towaru realnie leżało na
    # półce. Bez rozbicia kontener płynący po oceanie maskuje pusty magazyn.
    mag = _txt(a.get("warehouse_id"), 32) or ""
    w_drodze = bool(firma.wh_drodze) and mag == str(firma.wh_drodze)

    return {
        "fid": firma.firma_id,
        "aid": int(aid),
        "pid": _txt(a.get("product_id"), 32),
        "sku": symbol,
        "canon": (symbol or "").lower().strip() or None,
        "kind": kind or "?",
        "typ": typ,
        "ilosc": ilosc,
        "data": data,
        "mag": _txt(a.get("warehouse_id"), 32),
        "koszt": koszt if koszt > 0 else None,
        "waluta": _txt(a.get("purchase_currency"), 8),
        "doc_id": a.get("warehouse_document_id"),
        "numer": doc.get("numer"),
        "kontrahent": doc.get("kontrahent"),
        "nip": nip or None,
        "wew": wewnetrzny,
        "drodze": w_drodze,
    }


_INSERT = text(
    f"INSERT INTO {TABELA} (firma_id, action_id, product_id, sku, sku_canon, "
    "kind, typ, ilosc, data, magazyn_id, koszt_jednostkowy, waluta, "
    "dokument_id, numer_dokumentu, kontrahent, kontrahent_nip, is_internal, "
    "w_drodze, updated_at) "
    "VALUES (:fid, :aid, :pid, :sku, :canon, :kind, :typ, :ilosc, :data, :mag, "
    ":koszt, :waluta, :doc_id, :numer, :kontrahent, :nip, :wew, :drodze, :ts) "
    "ON CONFLICT (firma_id, action_id) DO UPDATE SET "
    "product_id = EXCLUDED.product_id, sku = EXCLUDED.sku, "
    "sku_canon = EXCLUDED.sku_canon, kind = EXCLUDED.kind, typ = EXCLUDED.typ, "
    "ilosc = EXCLUDED.ilosc, data = EXCLUDED.data, magazyn_id = EXCLUDED.magazyn_id, "
    "koszt_jednostkowy = EXCLUDED.koszt_jednostkowy, waluta = EXCLUDED.waluta, "
    "dokument_id = EXCLUDED.dokument_id, numer_dokumentu = EXCLUDED.numer_dokumentu, "
    "kontrahent = EXCLUDED.kontrahent, kontrahent_nip = EXCLUDED.kontrahent_nip, "
    "is_internal = EXCLUDED.is_internal, w_drodze = EXCLUDED.w_drodze, "
    "updated_at = EXCLUDED.updated_at"
)


async def _bieg_firmy(firma: Firma, nasze_nipy: Set[str],
                      sync_time: datetime) -> Wynik:
    w = Wynik(slug=firma.slug)

    async with SessionLocal() as session:
        await _ensure_schema(session)

        # 1) katalog produktów → mapa product_id → SKU
        mapa = await _wczytaj_mape(session, firma)          # kumulatywna, z bazy
        produkty = await _fetch_all(firma, "products.json")
        mapa.z_katalogu(produkty)

        # 2) metadane i NIP-y — do numeru dokumentu i flagi wewnętrzności
        dokumenty = await _dokumenty(firma)
        w.dokumentow = len(dokumenty)
        nipy = await _klienci_nip(firma)

        # 3) ledger
        akcje = await _fetch_all(firma, "warehouse_actions.json")
        w.akcji = len(akcje)

        wiersze: List[dict] = []
        usuniete: List[int] = []

        for a in akcje:
            if _prawda(a.get("deleted")):
                aid = a.get("id")
                if aid is not None:
                    usuniete.append(int(aid))
                continue
            row = _normalizuj(a, firma, mapa, dokumenty, nipy, nasze_nipy, w)
            if row:
                row["ts"] = sync_time
                wiersze.append(row)

        # 4) zapis. Pełna podmiana per firma — ledger jest mały, a przy
        #    upsercie bez kasowania zostałyby zombie po ruchach usuniętych
        #    w Fakturowni już po naszym poprzednim biegu.
        await session.execute(
            text(f"DELETE FROM {TABELA} WHERE firma_id = :fid"),
            {"fid": firma.firma_id},
        )
        for i in range(0, len(wiersze), 500):
            await session.execute(_INSERT, wiersze[i:i + 500])
        await session.commit()

        w.zapisanych = len(wiersze)
        w.usunietych = len(usuniete)

        await _zapisz_mape(session, firma, mapa)
        await session.commit()

    return w


def _opis(w: Wynik) -> str:
    if not w.ok:
        return f"{w.slug}: BŁĄD — {w.error}"
    zakres = (
        f", {w.od:%Y-%m-%d}→{w.do:%Y-%m-%d}"
        if w.od and w.do else ""
    )
    ogon = []
    if w.bez_sku:
        ogon.append(f"{w.bez_sku} bez SKU")
    if w.wewnetrznych:
        ogon.append(f"{w.wewnetrznych} w grupie")
    if w.usunietych:
        ogon.append(f"{w.usunietych} usuniętych pominięto")
    return (
        f"{w.slug}: {w.zapisanych} ruchów z {w.akcji}{zakres}"
        + (f" ({', '.join(ogon)})" if ogon else "")
    )


async def run_sync() -> None:
    """Bieg wszystkich skonfigurowanych Fakturowni. Wywoływane z lifespan."""
    started = _now_local()
    firmy, nasze_nipy = await _load_firmy()

    if not firmy:
        _status.update({
            "running": False,
            "finished_at": _now_local().isoformat(),
            "message": "Brak skonfigurowanych Fakturowni",
        })
        return

    wyniki: List[Wynik] = []
    for firma in firmy:
        try:
            wyniki.append(await _bieg_firmy(firma, nasze_nipy, started))
        except Exception as e:
            wyniki.append(Wynik(slug=firma.slug, ok=False, error=str(e)))
        await asyncio.sleep(0.2)

    finished = _now_local()
    _status.update({
        "running": False,
        "finished_at": finished.isoformat(),
        "error": None if all(w.ok for w in wyniki) else "część firm z błędem",
        "message": " · ".join(_opis(w) for w in wyniki),
        "wyniki": [w.__dict__ for w in wyniki],
    })

    for w in wyniki:
        await _write_sync_log(
            f"fakturownia_history:{w.slug}", started, finished, w.ok, _opis(w)
        )


async def _write_sync_log(source: str, started: datetime, finished: datetime,
                          ok: bool, opis: str) -> None:
    try:
        async with SessionLocal() as session:
            await session.execute(text(
                f"INSERT INTO {settings.TABLE_SYNC_LOG} "
                "(source, started_at, finished_at, ok, message) "
                "VALUES (:s, :b, :f, :ok, :m)"
            ), {"s": source, "b": started, "f": finished, "ok": ok, "m": opis})
            await session.commit()
    except Exception as e:
        print(f"[fakturownia_history] dziennik: {e}")
