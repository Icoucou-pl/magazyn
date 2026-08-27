"""
Fakturownia → PostgreSQL — ingesta SPRZEDAŻY (faktury spoza Sellasista).

PO CO TO JEST
=============
Aplikacja widzi sprzedaż Acti/Veluxy wyłącznie z Sellasista, a Sellasist zna
tylko zamówienia ze sklepów internetowych. Hurt i przesunięcia do AMH Klaudia
fakturuje ręcznie w Fakturowni — i to nie trafiało nigdzie. Dla Veluxy było to
767 tys. zł netto na 6 miesięcy przy 149 tys. widocznych w apce, dla Acti
785 tys. zł. Stany magazynowe były przy tym poprawne (Fakturownia jest ich
źródłem, Sellasist tylko je odbija), więc rozjeżdżał się sam licznik sprzedaży:
towar znikał z magazynu, a popyt stał w miejscu.

CO ZACIĄGAMY
============
Faktury BEZ pola `oid`. To pole ma każda faktura wygenerowana przez Sellasista,
a nie ma go żadna wystawiona ręcznie — sprawdzone na 616 fakturach Veluxy
(454 z oid = detal) i 427 Acti (305 z oid). Sellasist zostaje źródłem detalu
razem z kanałami i statusami, Fakturownia dokłada to, czego w nim nie ma.

KOREKTY
=======
Korekta nigdy nie ma własnego `oid` (linkuje się do faktury, nie do zamówienia),
więc sama reguła „brak oid = hurt" wciągnęłaby zwroty detaliczne, które Sellasist
już obsłużył statusem zamówienia — policzone drugi raz. Dlatego przy
kind = correction sprawdzamy `from_invoice_id`: jeśli rodzic ma `oid`, to zwrot
detaliczny i pomijamy. Na danych Veluxy odsiało to 23 pozycje zwrotów, zostawiając
3 prawdziwe korekty hurtu do AMH.

Fakturownia powtarza na korekcie WSZYSTKIE pozycje faktury pierwotnej, nie tylko
zmienione — te niezmienione mają qty = 0 i total = 0 (u Veluxy 14 z 43 pozycji).
Odrzucamy je. Zostają dwa przypadki: qty ≠ 0 (zwrot towaru) i qty = 0 przy
total ≠ 0 (korekta czysto cenowa, rabat potransakcyjny — u Veluxy 4 pozycje na
−8 056 zł). Ta druga NIE DA SIĘ wyrazić jako ilość × cena, dlatego źródłem prawdy
w tabeli jest `total_net`, a `price_netto` zostaje NULL.

MAPOWANIE SKU
=============
Pozycje faktur wystawianych ręcznie mają puste pole `code` — SKU trzeba ustalić
po `product_id`. Kolejność źródeł (KATALOG przed MAPĄ) wzięła się z konkretnej
pomyłki: pierwsza wersja skryptu diagnostycznego uczyła się z faktur przed
sprawdzeniem katalogu i przypisała łóżku Acti Szp2 symbol „8719076666752",
bo Sellasist wpisuje w `code` własny numer. 18 pozycji za 54 770 zł poszło na
nieistniejące SKU. Karta produktu w katalogu miała poprawny kod przez cały czas.

  1. KATALOG — products.json, po id produktu     (dane wpisane świadomie)
  2. EAN     — products.json, po ean_code
  3. MAPA    — kumulatywna, nauczona z faktur z oid
  4. KOD     — pole code na pozycji, jeśli nie jest samymi cyframi
  5. BRAK    — zapisujemy z sku_source = 'BRAK', NIE wyrzucamy

Punktu „zgadnij SKU z sufiksu nazwy" świadomie nie ma. Zadziałałby dla
„Podkładka … Pod_1b", ale przy korekcie tego samego produktu nazwanej
„Podkładka Manicure Pedicure Podpórka Pod Dłonie Biała Złota" wyprodukowałby
SKU „Paznokcie". Fałszywe trafienie jest gorsze od widocznego braku.

SKU ZAWSZE MA LITERĘ — kod złożony z samych cyfr to EAN, nie symbol. Ta jedna
reguła naprawiła u Acti wszystkie 18 błędnych pozycji, bez zmiany czegokolwiek
w Fakturowni.

CZEGO NIE POMIJAMY
==================
Nierozpoznane pozycje trafiają do bazy z sku_source = 'BRAK', a nie do kosza.
Gdybyśmy je odrzucali, przy pierwszym przebiegu zniknęłoby 157 tys. zł (Veluxa,
łóżko S1 bez kodu w Fakturowni) i nikt by tego nie zauważył. Endpoint synchro
zwraca ich liczbę i wartość. Tak samo pozycje wysyłkowe — dostają
sku_source = 'WYSYLKA' i puste SKU: wchodzą do obrotu, wypadają z prognozy.

is_internal
===========
Nabywca z NIP-em którejś z NASZYCH firm (app_firmy.nip) = przesunięcie
wewnątrzgrupowe. U Veluxy to 87% wolumenu (704 tys. zł do AMH), u Acti zero.
Flaga steruje dwoma miejscami RÓŻNIE i to jest zamierzone:
  - Finanse (obrót spółki): przesunięcia WCHODZĄ — to realny obrót Veluxy.
    Odejmuje się je dopiero na zakładce „wszystkie", gdzie policzyłyby się
    dwa razy (AMH sprzedał potem te same 433 szt. S1 i 224 szt. S2 klientom).
  - Prognoza (popyt): przesunięcia WYPADAJĄ — przełożenie towaru na inną półkę
    w grupie to nie jest zakup klienta. Wliczenie ich zawyżyłoby popyt i
    postrzępiło sygnał paczkami po 20 szt. w rytmie przesunięć.

HTTP: urllib + asyncio.to_thread, jak services/fakturownia.py i sellasist.py.
Konfiguracja per sklep w ENV: FAKTUROWNIA_<SLUG>_URL, _TOKEN oraz opcjonalnie
_SALES_FROM (data początkowa, domyślnie SALES_DEFAULT_FROM).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import SessionLocal

_PAGE_SIZE = 100
_PAGE_SAFETY_LIMIT = 500
_TIMEOUT = 60
_THROTTLE = 0.12                  # przerwa między requestami szczegółów
_SAMPLE = 5                       # ile przykładów w komunikacie

# Pozycje, które nie są towarem. Porównanie po nazwie znormalizowanej.
_SHIPPING = {
    "koszt dostawy",
    "dostawa przez sprzedajacego pobranie",
    "dostawa przez sprzedajacego",
    "wysylka",
    "transport",
    "przesylka",
    "koszt przesylki",
}

_ONLY_DIGITS = re.compile(r"^\d+$")


@dataclass
class Firma:
    slug: str
    firma_id: int
    url: str
    token: str
    sales_from: str


@dataclass
class Wynik:
    """Podsumowanie biegu jednej firmy — trafia do statusu i app_sync_log."""
    slug: str
    ok: bool = True
    error: Optional[str] = None
    faktur_lista: int = 0
    faktur_ingest: int = 0
    faktur_pominietych: int = 0
    pozycji: int = 0
    nauczono: int = 0
    brak_sku: int = 0
    brak_sku_netto: float = 0.0
    brak_probki: List[str] = field(default_factory=list)
    netto_hurt: float = 0.0
    netto_internal: float = 0.0
    marza: float = 0.0
    bez_kosztu: int = 0
    konflikty: int = 0


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


async def _load_firmy() -> Tuple[List[Firma], Set[str]]:
    """Sklepy nie-AMH z kompletem URL+TOKEN + zbiór NIP-ów naszych firm.

    NIP-y bierzemy ze WSZYSTKICH wierszy app_firmy (także AMH), bo służą do
    rozpoznania nabywcy wewnątrzgrupowego, nie do wyboru sklepu.
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
        print(f"[fakturownia_sales] _load_firmy błąd: {e}")
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
                sales_from=_env(slug, "SALES_FROM") or settings.FAKTUROWNIA_SALES_FROM,
            ))
    return out, nasze_nipy


def get_status() -> Dict[str, Any]:
    return {**_status, "configured": is_configured()}


def is_running() -> bool:
    return bool(_status["running"])


def mark_started() -> None:
    _status.update({
        "running": True,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "finished_at": None,
        "error": None,
        "message": None,
        "wyniki": [],
    })


# ============================================================
# NARZĘDZIA
# ============================================================
def _now_local() -> datetime:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Warsaw")).replace(tzinfo=None)
    except Exception:
        return datetime.now()


def _to_float(v: Any, default: float = 0.0) -> float:
    if v is None:
        return default
    if isinstance(v, str):
        v = v.replace(" ", "").replace(",", ".").strip()
        if v == "":
            return default
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


def _to_int(v: Any) -> Optional[int]:
    try:
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        return int(str(v).strip())
    except (ValueError, TypeError):
        return None


def _digits(v: Any) -> str:
    return re.sub(r"\D", "", str(v or ""))


def _txt(v: Any, limit: int = 255) -> Optional[str]:
    s = str(v).strip() if v is not None else ""
    return s[:limit] if s else None


def _has_val(v: Any) -> bool:
    """Fakturownia zwraca brak oid raz jako None, raz jako "" albo "0"."""
    if v is None:
        return False
    s = str(v).strip()
    return s not in ("", "0")


def _norm_name(v: Any) -> str:
    """Nazwa bez ogonków i wielkości liter — do porównania z listą wysyłek."""
    s = str(v or "").strip().lower()
    for a, b in (("ą", "a"), ("ć", "c"), ("ę", "e"), ("ł", "l"), ("ń", "n"),
                 ("ó", "o"), ("ś", "s"), ("ź", "z"), ("ż", "z")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s)


def _is_ean_like(code: str) -> bool:
    """SKU zawsze ma literę — kod z samych cyfr to EAN, nie symbol.

    Reguła od Szymona; wcześniejsza wersja opierała się na długości (8–14 cyfr)
    i odrzuciłaby połowę prawdziwych symboli Acti, bo mają 4–11 znaków.
    """
    return bool(code) and bool(_ONLY_DIGITS.match(code))


def _clean_code(v: Any) -> str:
    c = str(v or "").strip()
    return "" if _is_ean_like(c) else c


def _parse_date(v: Any) -> Optional[date]:
    s = str(v or "").strip()[:10]
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def _parse_ts(v: Any) -> Optional[datetime]:
    s = str(v or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=None)
        except ValueError:
            continue
    return None


# ============================================================
# HTTP
# ============================================================
def _ssl_context() -> Optional[ssl.SSLContext]:
    try:
        return ssl.create_default_context()
    except Exception:
        return None


def _http_get_sync(firma: Firma, path: str, params: Optional[dict] = None) -> Any:
    q = dict(params or {})
    q["api_token"] = firma.token
    url = f"{firma.url}/{path}?{urllib.parse.urlencode(q)}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=_TIMEOUT, context=_ssl_context()) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw) if raw else None
    if isinstance(data, dict) and isinstance(data.get("value"), list):
        return data["value"]
    return data


async def _http_get(firma: Firma, path: str, params: Optional[dict] = None) -> Any:
    return await asyncio.to_thread(_http_get_sync, firma, path, params)


async def _fetch_all(firma: Firma, path: str, params: Optional[dict] = None) -> List[dict]:
    out: List[dict] = []
    base = dict(params or {})
    for page in range(1, _PAGE_SAFETY_LIMIT + 1):
        batch = await _http_get(firma, path, {**base, "page": page, "per_page": _PAGE_SIZE})
        if not batch or not isinstance(batch, list):
            break
        out.extend(batch)
        if len(batch) < _PAGE_SIZE:
            break
        await asyncio.sleep(0.15)
    return out


# ============================================================
# MAPA SKU
# ============================================================
class SkuMap:
    """Mapa product_id → SKU. Katalog ma pierwszeństwo nad nauką z faktur."""

    def __init__(self) -> None:
        self.katalog: Dict[str, str] = {}        # product_id → symbol (z karty)
        self.po_ean: Dict[str, str] = {}         # ean_code → symbol
        self.nauczone: Dict[str, str] = {}       # product_id → symbol (z faktur)
        self.nowe: Dict[str, str] = {}           # do zapisania w tej rundzie
        self.konflikty: Dict[str, Set[str]] = {}
        self.koszt: Dict[str, float] = {}        # product_id → purchase_price_net

    def z_katalogu(self, products: List[dict]) -> None:
        for p in products:
            pid = _txt(p.get("id"), 32)
            code = _clean_code(p.get("code"))
            if not code:
                continue
            if pid:
                self.katalog[pid] = code
            ean = str(p.get("ean_code") or "").strip()
            if ean:
                self.po_ean[ean] = code
            # Cena zakupu z karty produktu — stan NA DZIŚ, nie z dnia sprzedaży.
            # Dlatego to źródło uzupełniające; pierwszym jest products_margin
            # z nagłówka faktury, który jest historyczny.
            koszt = _to_float(p.get("purchase_price_net"))
            if pid and koszt > 0:
                self.koszt[pid] = koszt

    def ucz(self, product_id: Any, code: Any) -> bool:
        """Uczy pary z pozycji faktury. Zwraca True, jeśli para jest nowa."""
        pid = _txt(product_id, 32)
        c = _clean_code(code)
        if not pid or not c:
            return False
        stare = self.nauczone.get(pid)
        if stare and stare != c:
            self.konflikty.setdefault(pid, set()).add(c)
            return False                      # pierwsza wygrywa, konflikt logujemy
        if stare == c:
            return False
        self.nauczone[pid] = c
        self.nowe[pid] = c
        return True

    def rozwiaz(self, product_id: Any, code: Any) -> Tuple[Optional[str], str]:
        """Zwraca (symbol, źródło). Kolejność: KATALOG → EAN → MAPA → KOD → BRAK."""
        pid = _txt(product_id, 32)
        if pid:
            if pid in self.katalog:
                return self.katalog[pid], "KATALOG"
            if pid in self.po_ean:
                return self.po_ean[pid], "EAN"
            if pid in self.nauczone:
                return self.nauczone[pid], "MAPA"
        c = _clean_code(code)
        if c:
            return c, "KOD"
        return None, "BRAK"


async def _wczytaj_mape(session: AsyncSession, firma: Firma) -> SkuMap:
    m = SkuMap()
    r = await session.execute(
        text("SELECT product_id, symbol, source FROM fakturownia_sku_map WHERE firma_id = :fid"),
        {"fid": firma.firma_id},
    )
    for row in r.mappings():
        pid = str(row["product_id"])
        sym = str(row["symbol"])
        if row["source"] == "KATALOG":
            m.katalog[pid] = sym
        else:
            m.nauczone[pid] = sym
    return m


async def _zapisz_mape(session: AsyncSession, firma: Firma, m: SkuMap) -> int:
    """Dopisuje nowe pary. Kumulatywnie — nic nie kasujemy."""
    n = 0
    for pid, sym in m.katalog.items():
        await session.execute(text(
            "INSERT INTO fakturownia_sku_map (firma_id, product_id, symbol, sku_canon, source, updated_at) "
            "VALUES (:fid, :pid, :sym, :canon, 'KATALOG', :ts) "
            "ON CONFLICT (firma_id, product_id) DO UPDATE SET "
            "symbol = EXCLUDED.symbol, sku_canon = EXCLUDED.sku_canon, "
            "source = 'KATALOG', updated_at = EXCLUDED.updated_at"
        ), {"fid": firma.firma_id, "pid": pid, "sym": sym,
            "canon": sym.lower().strip(), "ts": _now_local()})
        n += 1

    for pid, sym in m.nowe.items():
        if pid in m.katalog:
            continue                          # katalog już zapisany, nie nadpisujemy
        konf = ", ".join(sorted(m.konflikty.get(pid, set()))) or None
        await session.execute(text(
            "INSERT INTO fakturownia_sku_map (firma_id, product_id, symbol, sku_canon, source, conflicts, updated_at) "
            "VALUES (:fid, :pid, :sym, :canon, 'FAKTURA', :konf, :ts) "
            "ON CONFLICT (firma_id, product_id) DO UPDATE SET "
            "conflicts = COALESCE(EXCLUDED.conflicts, fakturownia_sku_map.conflicts), "
            "updated_at = EXCLUDED.updated_at"
        ), {"fid": firma.firma_id, "pid": pid, "sym": sym,
            "canon": sym.lower().strip(), "konf": konf, "ts": _now_local()})
        n += 1

    for pid, koszt in m.koszt.items():
        sym = m.katalog.get(pid)
        await session.execute(text(
            "INSERT INTO fakturownia_product_cost "
            "(firma_id, product_id, symbol, sku_canon, purchase_price_net, updated_at) "
            "VALUES (:fid, :pid, :sym, :canon, :koszt, :ts) "
            "ON CONFLICT (firma_id, product_id) DO UPDATE SET "
            "symbol = EXCLUDED.symbol, sku_canon = EXCLUDED.sku_canon, "
            "purchase_price_net = EXCLUDED.purchase_price_net, updated_at = EXCLUDED.updated_at"
        ), {"fid": firma.firma_id, "pid": pid, "sym": sym,
            "canon": sym.lower().strip() if sym else None,
            "koszt": koszt, "ts": _now_local()})

    await session.commit()
    return n


# ============================================================
# POZYCJE
# ============================================================
def _pozycje(detail: dict) -> List[dict]:
    pos = detail.get("positions")
    if pos is None:
        return []
    if not isinstance(pos, list):
        pos = [pos]
    return [p for p in pos if isinstance(p, dict) and not p.get("deleted")]


def _przetworz_pozycje(detail: dict, m: SkuMap, wynik: Wynik) -> List[dict]:
    """Zamienia pozycje faktury na wiersze do bazy. Odsiewa szum korekt."""
    out: List[dict] = []
    for p in _pozycje(detail):
        qty = _to_float(p.get("quantity"))
        total_net = _to_float(p.get("total_price_net"))

        # Korekta powtarza wszystkie pozycje rodzica; niezmienione mają zera.
        if qty == 0 and total_net == 0:
            continue

        nazwa = _txt(p.get("name")) or ""
        if _norm_name(nazwa) in _SHIPPING:
            symbol, zrodlo = None, "WYSYLKA"
        else:
            symbol, zrodlo = m.rozwiaz(p.get("product_id"), p.get("code"))
            if zrodlo == "BRAK":
                wynik.brak_sku += 1
                wynik.brak_sku_netto += total_net
                if len(wynik.brak_probki) < _SAMPLE:
                    wynik.brak_probki.append(f"{nazwa[:40]} ({total_net:.2f} zł)")

        # total_net jest źródłem prawdy; cena jednostkowa tylko gdy da się policzyć.
        # Przy korekcie czysto cenowej (qty = 0) price_net na pozycji jest zerowe,
        # więc branie go wprost zgubiłoby całą korektę.
        total_gross = _to_float(p.get("total_price_gross"))
        cena_net = round(total_net / qty, 4) if qty else None
        cena_brutto = round(total_gross / qty, 4) if qty else None

        koszt_jedn = m.koszt.get(_txt(p.get("product_id"), 32) or "")
        koszt_razem = round(koszt_jedn * qty, 2) if (koszt_jedn and qty) else None

        out.append({
            "position_id": _to_int(p.get("id")) or 0,
            "symbol": symbol,
            "sku_canon": symbol.lower().strip() if symbol else None,
            "sku_source": zrodlo,
            "product_id": _txt(p.get("product_id"), 32),
            "product_name": nazwa[:255] or None,
            "quantity": round(qty, 3),
            "total_net": round(total_net, 2),
            "total_gross": round(total_gross, 2),
            "price_netto": cena_net,
            "price": cena_brutto,
            "is_price_only": (qty == 0 and total_net != 0),
            "cost_net": round(koszt_jedn, 4) if koszt_jedn else None,
            "total_cost": koszt_razem,
        })
    return out


# ============================================================
# ZAPIS
# ============================================================
async def _zapisz_fakture(session: AsyncSession, firma: Firma, hdr: dict,
                          pozycje: List[dict]) -> None:
    """Nagłówek upsertem, pozycje atomowym DELETE+INSERT.

    DELETE+INSERT, a nie upsert po pozycjach: przy edycji faktury w Fakturowni
    pozycja może zniknąć, a upsert zostawiłby ją w bazie jako zombie.
    """
    await session.execute(text(
        "INSERT INTO fakturownia_invoices "
        "(firma_id, shop, invoice_id, number, kind, issue_date, sell_date, currency, "
        " price_net, price_gross, products_margin, oid, from_invoice_id, parent_oid, buyer_name, "
        " buyer_tax_no, is_internal, is_correction, skip_reason, src_updated_at, ingested_at) "
        "VALUES (:fid, :shop, :iid, :num, :kind, :issue, :sell, :cur, :net, :gross, :margin, :oid, "
        " :parent_id, :parent_oid, :buyer, :nip, :internal, :corr, :skip, :srcup, :ts) "
        "ON CONFLICT (firma_id, invoice_id) DO UPDATE SET "
        "number = EXCLUDED.number, kind = EXCLUDED.kind, issue_date = EXCLUDED.issue_date, "
        "sell_date = EXCLUDED.sell_date, currency = EXCLUDED.currency, "
        "price_net = EXCLUDED.price_net, price_gross = EXCLUDED.price_gross, "
        "products_margin = EXCLUDED.products_margin, "
        "oid = EXCLUDED.oid, from_invoice_id = EXCLUDED.from_invoice_id, "
        "parent_oid = EXCLUDED.parent_oid, buyer_name = EXCLUDED.buyer_name, "
        "buyer_tax_no = EXCLUDED.buyer_tax_no, is_internal = EXCLUDED.is_internal, "
        "is_correction = EXCLUDED.is_correction, skip_reason = EXCLUDED.skip_reason, "
        "src_updated_at = EXCLUDED.src_updated_at, ingested_at = EXCLUDED.ingested_at"
    ), hdr)

    await session.execute(text(
        "DELETE FROM fakturownia_invoice_items WHERE firma_id = :fid AND invoice_id = :iid"
    ), {"fid": firma.firma_id, "iid": hdr["iid"]})

    for it in pozycje:
        await session.execute(text(
            "INSERT INTO fakturownia_invoice_items "
            "(firma_id, shop, invoice_id, position_id, symbol, sku_canon, sku_source, "
            " product_id, product_name, quantity, total_net, total_gross, price_netto, "
            " price, currency, is_price_only, cost_net, total_cost, ingested_at) "
            "VALUES (:fid, :shop, :iid, :pos, :symbol, :canon, :src, :pid, :pname, "
            " :qty, :net, :gross, :cena_net, :cena, :cur, :ponly, :koszt, :koszt_raz, :ts)"
        ), {
            "fid": firma.firma_id, "shop": firma.slug, "iid": hdr["iid"],
            "pos": it["position_id"], "symbol": it["symbol"], "canon": it["sku_canon"],
            "src": it["sku_source"], "pid": it["product_id"], "pname": it["product_name"],
            "qty": it["quantity"], "net": it["total_net"], "gross": it["total_gross"],
            "cena_net": it["price_netto"], "cena": it["price"], "cur": hdr["cur"],
            "ponly": it["is_price_only"], "koszt": it["cost_net"],
            "koszt_raz": it["total_cost"], "ts": hdr["ts"],
        })


# ============================================================
# BIEG JEDNEJ FIRMY
# ============================================================
async def _rodzic_ma_oid(firma: Firma, parent_id: int,
                         lista: Dict[int, dict], cache: Dict[int, Optional[str]]) -> Optional[str]:
    """oid faktury macierzystej korekty. Najpierw z listy, potem punktowo z API.

    Rodzic bywa starszy niż okno pobierania (np. korekta ze stycznia do faktury
    z grudnia), dlatego brak w liście NIE oznacza, że rodzic nie ma oid.
    Zgadywanie w tym miejscu wciągnęłoby zwroty detaliczne do hurtu.
    """
    if parent_id in cache:
        return cache[parent_id]
    hdr = lista.get(parent_id)
    if hdr is None:
        try:
            hdr = await _http_get(firma, f"invoices/{parent_id}.json")
            await asyncio.sleep(_THROTTLE)
        except Exception:
            hdr = None
    oid = _txt(hdr.get("oid"), 64) if isinstance(hdr, dict) and _has_val(hdr.get("oid")) else None
    cache[parent_id] = oid
    return oid


async def _bieg_firmy(firma: Firma, nasze_nipy: Set[str], sync_time: datetime) -> Wynik:
    w = Wynik(slug=firma.slug)
    try:
        async with SessionLocal() as session:
            mapa = await _wczytaj_mape(session, firma)
            r = await session.execute(
                text("SELECT last_learned_id FROM fakturownia_sync_state WHERE firma_id = :fid"),
                {"fid": firma.firma_id},
            )
            row = r.mappings().first()
            last_learned = int(row["last_learned_id"] or 0) if row else 0

            r2 = await session.execute(text(
                "SELECT invoice_id, src_updated_at FROM fakturownia_invoices WHERE firma_id = :fid"
            ), {"fid": firma.firma_id})
            znane = {int(x["invoice_id"]): x["src_updated_at"] for x in r2.mappings()}

        # 1. Katalog — pierwszeństwo przed mapą nauczoną.
        produkty = await _fetch_all(firma, "products.json")
        mapa.z_katalogu(produkty)

        # 2. Lista faktur.
        do_dnia = date.today().isoformat()
        faktury = await _fetch_all(firma, "invoices.json", {
            "period": "more", "date_from": firma.sales_from, "date_to": do_dnia,
        })
        w.faktur_lista = len(faktury)
        lista_by_id: Dict[int, dict] = {}
        for f in faktury:
            fid = _to_int(f.get("id"))
            if fid is not None:
                lista_by_id[fid] = f

        z_oid = [f for f in faktury if _has_val(f.get("oid"))]
        bez_oid = [f for f in faktury if not _has_val(f.get("oid"))]

        # 3. Nauka mapy — tylko z faktur NOWSZYCH niż ostatnio przerobione.
        #    Bez tego każdy bieg pobierałby szczegóły ~550 faktur detalicznych.
        max_id = last_learned
        for f in sorted(z_oid, key=lambda x: _to_int(x.get("id")) or 0):
            fid = _to_int(f.get("id")) or 0
            if fid <= last_learned:
                continue
            try:
                det = await _http_get(firma, f"invoices/{fid}.json")
            except Exception:
                continue
            for p in _pozycje(det if isinstance(det, dict) else {}):
                if mapa.ucz(p.get("product_id"), p.get("code")):
                    w.nauczono += 1
            max_id = max(max_id, fid)
            await asyncio.sleep(_THROTTLE)
        w.konflikty = len(mapa.konflikty)

        # 4. Ingesta faktur bez oid.
        cache_rodzicow: Dict[int, Optional[str]] = {}
        async with SessionLocal() as session:
            await _zapisz_mape(session, firma, mapa)

            for f in bez_oid:
                fid = _to_int(f.get("id"))
                if fid is None:
                    continue
                src_up = _parse_ts(f.get("updated_at"))
                if fid in znane and src_up and znane[fid] and src_up <= znane[fid]:
                    continue                        # bez zmian od ostatniego biegu

                try:
                    det = await _http_get(firma, f"invoices/{fid}.json")
                except Exception as e:
                    print(f"[fakturownia_sales] {firma.slug} faktura {fid}: {e}")
                    continue
                if not isinstance(det, dict):
                    continue
                await asyncio.sleep(_THROTTLE)

                kind = _txt(det.get("kind"), 32) or ""
                is_corr = (kind == "correction")
                parent_id = _to_int(det.get("from_invoice_id"))
                parent_oid = None
                skip = None

                if is_corr and parent_id:
                    parent_oid = await _rodzic_ma_oid(firma, parent_id, lista_by_id, cache_rodzicow)
                    if parent_oid:
                        # Zwrot detaliczny — Sellasist już go obsłużył statusem.
                        skip = "KOREKTA_DETAL"

                nip = _digits(det.get("buyer_tax_no"))
                internal = bool(nip and nip in nasze_nipy)

                pozycje = [] if skip else _przetworz_pozycje(det, mapa, w)

                hdr = {
                    "fid": firma.firma_id, "shop": firma.slug, "iid": fid,
                    "num": _txt(det.get("number"), 64), "kind": kind,
                    "issue": _parse_date(det.get("issue_date")),
                    "sell": _parse_date(det.get("sell_date")),
                    "cur": _txt(det.get("currency"), 8) or settings.FX_BASE_CURRENCY,
                    "net": round(_to_float(det.get("price_net")), 2),
                    "gross": round(_to_float(det.get("price_gross")), 2),
                    # products_margin liczy Fakturownia w chwili wystawienia —
                    # wartość historyczna, dokładniejsza niż koszt z katalogu.
                    # Korekty jej nie mają, tam zostaje wyliczenie z pozycji.
                    "margin": (round(_to_float(det.get("products_margin")), 2)
                               if _has_val(det.get("products_margin")) else None),
                    "oid": None,
                    "parent_id": parent_id, "parent_oid": parent_oid,
                    "buyer": _txt(det.get("buyer_name")),
                    "nip": _txt(det.get("buyer_tax_no"), 32),
                    "internal": internal, "corr": is_corr,
                    "skip": skip, "srcup": src_up, "ts": sync_time,
                }
                await _zapisz_fakture(session, firma, hdr, pozycje)

                if skip:
                    w.faktur_pominietych += 1
                else:
                    w.faktur_ingest += 1
                    w.pozycji += len(pozycje)
                    suma = sum(p["total_net"] for p in pozycje)
                    # Marża: nagłówek gdy jest, inaczej z pozycji (netto − koszt).
                    if hdr["margin"] is not None:
                        w.marza += hdr["margin"]
                    else:
                        for p in pozycje:
                            if p["total_cost"] is not None:
                                w.marza += p["total_net"] - p["total_cost"]
                            elif p["sku_source"] != "WYSYLKA":
                                w.bez_kosztu += 1
                    if internal:
                        w.netto_internal += suma
                    else:
                        w.netto_hurt += suma

            await session.execute(text(
                "INSERT INTO fakturownia_sync_state (firma_id, last_learned_id, last_run) "
                "VALUES (:fid, :lid, :ts) "
                "ON CONFLICT (firma_id) DO UPDATE SET "
                "last_learned_id = GREATEST(fakturownia_sync_state.last_learned_id, EXCLUDED.last_learned_id), "
                "last_run = EXCLUDED.last_run"
            ), {"fid": firma.firma_id, "lid": max_id, "ts": sync_time})
            await session.commit()

    except urllib.error.HTTPError as e:
        w.ok, w.error = False, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        w.ok, w.error = False, f"brak połączenia ({e.reason})"
    except Exception as e:
        w.ok, w.error = False, str(e)
    return w


def _opis(w: Wynik) -> str:
    if not w.ok:
        return f"błąd {w.error}"
    czesci = [
        f"{w.faktur_ingest} faktur",
        f"{w.pozycji} pozycji",
        f"hurt {w.netto_hurt:,.2f} zł".replace(",", " "),
    ]
    if w.netto_internal:
        czesci.append(f"wewn. {w.netto_internal:,.2f} zł".replace(",", " "))
    if w.faktur_pominietych:
        czesci.append(f"pominięto {w.faktur_pominietych} korekt detalu")
    if w.nauczono:
        czesci.append(f"mapa +{w.nauczono}")
    if w.brak_sku:
        czesci.append(
            f"BEZ SKU: {w.brak_sku} poz. / {w.brak_sku_netto:,.2f} zł".replace(",", " ")
            + (f" ({'; '.join(w.brak_probki)})" if w.brak_probki else "")
        )
    obrot = w.netto_hurt + w.netto_internal
    if w.marza:
        czesci.append(f"marża {w.marza:,.2f} zł".replace(",", " ")
                      + (f" ({w.marza / obrot * 100:.1f}%)" if obrot else ""))
    if w.bez_kosztu:
        czesci.append(f"bez kosztu: {w.bez_kosztu} poz.")
    if w.konflikty:
        czesci.append(f"konflikty mapy: {w.konflikty}")
    return " · ".join(czesci)


async def run_sync() -> None:
    """Pełny bieg po wszystkich skonfigurowanych Fakturowniach. Zakłada mark_started()."""
    sync_time = _now_local()
    wyniki: List[Wynik] = []
    try:
        firmy, nasze_nipy = await _load_firmy()
        if not firmy:
            _status["error"] = "Brak skonfigurowanych Fakturowni (URL + TOKEN w ENV)"
        elif not nasze_nipy:
            _status["error"] = ("Żadna firma w app_firmy nie ma NIP-u — bez tego nie da się "
                                "rozpoznać przesunięć wewnątrzgrupowych. Uzupełnij app_firmy.nip.")
        else:
            for f in firmy:
                wyniki.append(await _bieg_firmy(f, nasze_nipy, sync_time))
            _status["message"] = " · ".join(f"{w.slug}: {_opis(w)}" for w in wyniki)
            _status["wyniki"] = [vars(w) for w in wyniki]
            padle = [w for w in wyniki if not w.ok]
            if padle and len(padle) == len(wyniki):
                _status["error"] = "; ".join(f"{w.slug}: {w.error}" for w in padle)
    except Exception as e:
        _status["error"] = str(e)
    finally:
        _status["running"] = False
        finished = _now_local()
        _status["finished_at"] = datetime.now().isoformat(timespec="seconds")
        if wyniki:
            for w in wyniki:
                await _write_sync_log(
                    f"fakturownia_sales:{w.slug}", sync_time, finished, w.ok,
                    w.faktur_ingest, 0, w.pozycji,
                    _opis(w) if w.ok else None, w.error,
                )
        else:
            await _write_sync_log("fakturownia_sales", sync_time, finished,
                                  _status["error"] is None, 0, 0, 0,
                                  _status.get("message"), _status.get("error"))


async def _write_sync_log(source: str, started: datetime, finished: datetime, ok: bool,
                          ins: int, upd: int, items: int,
                          message: Optional[str], error: Optional[str]) -> None:
    try:
        async with SessionLocal() as session:
            await session.execute(text(
                f"INSERT INTO {settings.TABLE_SYNC_LOG} "
                "(source, started_at, finished_at, ok, inserted, updated, items_added, message, error) "
                "VALUES (:src, :s, :f, :ok, :ins, :upd, :items, :msg, :err)"
            ), {
                "src": source, "s": started, "f": finished, "ok": ok,
                "ins": ins, "upd": upd, "items": items, "msg": message, "err": error,
            })
            await session.commit()
    except Exception as e:
        print(f"[fakturownia_sales] zapis dziennika pominięty: {e}")
