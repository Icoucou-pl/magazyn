"""Odprawa celna na karcie kontenera: podgląd rachunku i zapis kosztu jednostkowego.

Przepływ jest dwuetapowy i CELOWO bezstanowy:

  1. POST …/odprawa/podglad — wrzucasz XML zgłoszenia, dostajesz odczyt, dopasowanie
     pozycji do towaru, kontrole i wyliczony koszt. Nic nie idzie do bazy.
  2. POST …/odprawa — TEN SAM plik jeszcze raz plus ustawienia. Dopiero tu zapisujemy.

Drugi etap dostaje plik ponownie, zamiast trzymać odczyt w pamięci serwera między
requestami — Railway potrafi mieć kilka procesów, a stan między nimi nie jest dzielony.
Samego XML-a NIE zapisujemy nigdzie: do bazy idzie odczyt (pozycje, doliczenia, cło)
plus ślad „nazwa pliku, kto i kiedy". Załączniki kontenera zostają czyste.

Bramki przed zapisem (kolejność ma znaczenie — pierwsza, która nie przejdzie, kończy):
  · plik musi być eksportem WinSAD-a i mieć pozycje,
  · otwarty kontener musi być wymieniony w zgłoszeniu,
  · NIP importera musi wskazywać firmę tego kontenera,
  · MRN wpisany wcześniej na kontenerze musi zgadzać się z plikiem,
  · MRN nie może należeć do INNEJ odprawy niż ta, którą właśnie zapisujemy.
Numer faktury dostawcy sprawdzamy tylko ostrzeżeniem: kontener bywa opisany numerem
z faktury spedytora (który potrafi się różnić o cyfrę), a jedna odprawa może objąć
dwie faktury dostawcy.
"""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from collections import Counter
from types import SimpleNamespace

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

import audit
from audit_opisy import f_data, f_kwota, f_num, f_txt, f_zl, plural
from config import settings
from database import get_db
from models import (
    CurrentUser, OdprawaKontenerOut, OdprawaKontrolaOut, OdprawaLiniaKosztuIn, OdprawaLotOut,
    OdprawaOut, OdprawaZapisaneOut,
    OdprawaPozycjaOut, OdprawaTowarOut, OdprawaUstawieniaIn, OdprawaUwagaOut,
    OdprawaZapisOut, KursTowaruIn,
)
from security import require_sad
from services.odprawy import (
    KLUCZ_CBM, KLUCZ_WAGA, LiniaKosztu, PozycjaTowaru, Rachunek, Uwaga, ceny_z_sad_na_kontener, policz,
    przelicz_po_kursie,
)
from services.products import compute_effective_cbm
from services.sad import BladSAD, Odprawa, kontrole, parsuj
from sql import PRODUCT_NAMES_CTE

router = APIRouter(prefix="/api", tags=["odprawy"])

MAX_XML = 8 * 1024 * 1024   # zgłoszenie z 7 pozycjami waży 36 kB; 8 MB to zapas z nawiązką


# ============================================================
# Odczyt kontekstu z bazy
# ============================================================

def _etykieta_sql(c: str = "c") -> str:
    """Nazwa kontenera do pokazania: numer, a dopóki jest roboczy „Draft-…" — „FV: <nr>".

    Numer roboczy nadajemy wewnętrznie dla unikalności (drobnica, kontener bez numeru);
    na ekranie go nie pokazujemy — tak samo jak lista kontenerów (containerLabel) i dziennik.
    FV = zamówienie kontenera, a przy konsolidacji zamówienie pierwszego lotu.
    """
    return f"""CASE WHEN COALESCE(TRIM({c}.container_number), '') = ''
                      OR LOWER(TRIM({c}.container_number)) LIKE 'draft-%'
                 THEN COALESCE('FV: ' || COALESCE(NULLIF(TRIM({c}.order_number), ''),
                        (SELECT NULLIF(TRIM(l.order_number), '') FROM {settings.TABLE_CONTAINER_LOTS} l
                          WHERE l.container_id = {c}.id AND NULLIF(TRIM(l.order_number), '') IS NOT NULL
                          ORDER BY l.position, l.id LIMIT 1)), '#' || {c}.id)
                 ELSE {c}.container_number END"""


async def _kontener(db: AsyncSession, container_id: int) -> Dict[str, Any]:
    row = (await db.execute(
        text(f"""
            SELECT c.id, c.container_number, c.mrn, c.koszt_transportu, c.koszt_spedycji,
                   c.koszt_transportu_magazyn, {_etykieta_sql()} AS etykieta
              FROM {settings.TABLE_CONTAINERS} c
             WHERE c.id = :id
        """),
        {"id": container_id},
    )).mappings().first()
    if not row:
        raise HTTPException(404, "Nie ma takiego kontenera")
    return dict(row)


async def _drobnica_pasuje(db: AsyncSession, container_id: int, odprawa: Odprawa) -> bool:
    """Czy SAD bez numerów kontenerów (drobnica) należy do otwartego kontenera.

    Wiąże je faktura dostawcy: numer z N935 musi zgadzać się z numerem zamówienia
    kontenera albo któregoś z jego lotów (AT2603-252 — Fujian, palety w cudzym kontenerze).
    """
    if not odprawa.faktury_dostawcy:
        return False
    rows = (await db.execute(
        text(f"""
            SELECT order_number FROM {settings.TABLE_CONTAINERS} WHERE id = :id
            UNION ALL
            SELECT order_number FROM {settings.TABLE_CONTAINER_LOTS} WHERE container_id = :id
        """),
        {"id": container_id},
    )).all()
    zamowienia = [_numer(r[0]) for r in rows if r[0] and len(_numer(r[0])) >= 5]
    for fv in odprawa.faktury_dostawcy:
        n_fv = _numer(fv)
        if len(n_fv) >= 5 and any(z == n_fv or z in n_fv or n_fv in z for z in zamowienia):
            return True
    return False


async def _kontenery_odprawy(db: AsyncSession, numery: Sequence[str]) -> List[Dict[str, Any]]:
    """Kontenery z aplikacji odpowiadające numerom ze zgłoszenia.

    Numer porównujemy po UPPER(TRIM(…)) — tak samo robi to routers/containers.py,
    bo w bazie zdarzają się spacje na końcu.
    """
    if not numery:
        return []
    rows = (await db.execute(
        text(f"""
            SELECT c.id, c.container_number, c.mrn, c.koszt_transportu, c.koszt_spedycji,
                   c.koszt_transportu_magazyn, COALESCE(c.is_consolidated, FALSE) AS is_consolidated,
                   {_etykieta_sql()} AS etykieta
              FROM {settings.TABLE_CONTAINERS} c
             WHERE UPPER(TRIM(c.container_number)) = ANY(:numery)
             ORDER BY c.id
        """),
        {"numery": [n.strip().upper() for n in numery]},
    )).mappings().all()
    return [dict(r) for r in rows]


async def _towar(db: AsyncSession, container_ids: Sequence[int]
                 ) -> "tuple[List[PozycjaTowaru], Dict[int, Dict[str, Any]]]":
    """Pozycje kontenerów wzbogacone o wagę, CBM i kod CN z karty produktu.

    CBM liczymy tą samą funkcją co karta produktu i wypełnienie kontenera
    (compute_effective_cbm), żeby w trzech miejscach nie wyszły trzy różne liczby.

    Drugi element to metadane pozycji, których rachunek nie potrzebuje, a odprawa
    kontenera skonsolidowanego tak: lot, firma towaru i odprawa, która już go rozliczyła.
    """
    if not container_ids:
        return [], {}
    # Nazwa z katalogu (prod_names — to samo źródło co lista kontenerów) jest potrzebna
    # do dopasowania pozycji zgłoszenia: opis celny mówi „PODUSZKA KOSMETYCZNA", a bez
    # nazwy zostałaby tylko wartość, która przy starych cenach planowanych myli.
    rows = (await db.execute(
        text(f"""
            WITH {PRODUCT_NAMES_CTE}
            SELECT ci.id AS item_id, ci.container_id, ci.sku, ci.quantity, ci.unit_cost,
                   pn.nazwa AS product_name,
                   pa.waga_brutto_kg, pa.kod_cn,
                   COALESCE(pa.cbm_per_unit, 0) AS cbm_per_unit,
                   pa.dlugosc_cm, pa.szerokosc_cm, pa.wysokosc_cm, pa.szt_w_kartonie,
                   ci.lot_id, ci.koszt_odprawa_id,
                   LOWER(COALESCE(f.slug, 'amh')) AS firma
              FROM {settings.TABLE_CONTAINER_ITEMS} ci
              LEFT JOIN prod_names pn ON pn.sku_canon = LOWER(TRIM(ci.sku))
              LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa
                     ON LOWER(TRIM(pa.sku)) = LOWER(TRIM(ci.sku))
              LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = pa.firma_id
             WHERE ci.container_id = ANY(:ids)
             ORDER BY ci.container_id, ci.id
        """),
        {"ids": list(container_ids)},
    )).mappings().all()

    towar: List[PozycjaTowaru] = []
    meta: Dict[int, Dict[str, Any]] = {}
    for r in rows:
        meta[r["item_id"]] = {"lot_id": r["lot_id"], "firma": r["firma"],
                              "odprawa_id": r["koszt_odprawa_id"]}
        cbm, _ = compute_effective_cbm(dict(r))
        towar.append(PozycjaTowaru(
            item_id=r["item_id"],
            container_id=r["container_id"],
            sku=r["sku"],
            ilosc=int(r["quantity"] or 0),
            cena_planowana=float(r["unit_cost"] or 0),
            waga_brutto_kg=float(r["waga_brutto_kg"]) if r["waga_brutto_kg"] is not None else None,
            cbm=cbm or None,
            kod_cn=r["kod_cn"],
            nazwa=r["product_name"],
        ))
    return towar, meta


async def _firma_po_nip(db: AsyncSession, nip: Optional[str]) -> Optional[Dict[str, Any]]:
    if not nip:
        return None
    cyfry = "".join(ch for ch in nip if ch.isdigit())
    row = (await db.execute(
        text(f"SELECT id, slug, name FROM {settings.TABLE_FIRMY} "
             f"WHERE regexp_replace(COALESCE(nip, ''), '[^0-9]', '', 'g') = :nip"),
        {"nip": cyfry},
    )).mappings().first()
    return dict(row) if row else None


async def _firma_kontenera(db: AsyncSession, container_id: int) -> Optional[str]:
    """Firma kontenera = firma jego pozycji (app_product_attrs.firma_id; NULL = AMH).

    Kontener nie ma własnego pola firmy — bierzemy najczęstszą firmę jego SKU,
    dokładnie tak jak firma_breakdown w services/containers.py.
    """
    row = (await db.execute(
        text(f"""
            SELECT LOWER(COALESCE(f.slug, 'amh')) AS slug, COUNT(*) AS ile
              FROM {settings.TABLE_CONTAINER_ITEMS} ci
              LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa
                     ON LOWER(TRIM(pa.sku)) = LOWER(TRIM(ci.sku))
              LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = pa.firma_id
             WHERE ci.container_id = :cid
             GROUP BY 1 ORDER BY ile DESC LIMIT 1
        """),
        {"cid": container_id},
    )).mappings().first()
    return row["slug"] if row else None


# ============================================================
# Złożenie podglądu
# ============================================================

# ============================================================
# Kontener skonsolidowany — loty i ich odprawy
# ============================================================
#
# Kontener skonsolidowany to kilku dostawców (lotów), a często też kilka spółek w jednej
# skrzyni. Agencja odprawia go wtedy kilkoma zgłoszeniami: SAD ma jednego importera, więc
# towar Acti i Veluxy nie może pójść jednym. Konsolidacja Acti CORU2068476: SAD 1/2 objął
# trzy faktury Acti, a 1000 szt. Pod_1b Veluxy poszło osobno. Bez zawężenia do lotów
# rachunek wciągał Pod_1b do pozycji łóżek i rozjeżdżał cały podział.
#
# Nie pytamy więc „ile będzie zgłoszeń". Każdy lot jest albo rozliczony (jego towar ma
# koszt z którejś odprawy), albo czeka. Zgłoszenie bierze te loty, które do niego pasują,
# a resztę zostawia następnemu.

async def _loty(db: AsyncSession, container_ids: Sequence[int]) -> List[Dict[str, Any]]:
    if not container_ids:
        return []
    rows = (await db.execute(
        text(f"""
            SELECT l.id, l.container_id, l.order_number, l.mrn, m.name AS dostawca
              FROM {settings.TABLE_CONTAINER_LOTS} l
              LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = l.manufacturer_id
             WHERE l.container_id = ANY(:ids)
             ORDER BY l.container_id, l.position, l.id
        """),
        {"ids": list(container_ids)},
    )).mappings().all()
    return [dict(r) for r in rows]


def _numer(x: Optional[str]) -> str:
    """Numer faktury albo zamówienia do porównania: same litery i cyfry, wielkimi literami.

    Dostawcy mylą literę O z zerem — na tej samej fakturze KS Medical stoi raz
    „25KS-O1125-PL", a raz „25KS-01125-PL" — więc O traktujemy jak 0.
    """
    return "".join(c for c in (x or "").upper() if c.isalnum()).replace("O", "0")


def _faktury_lotow(odprawa: Odprawa, loty: Sequence[Dict[str, Any]], towar_lotu: Dict[int, List[PozycjaTowaru]]
                   ) -> Dict[int, "tuple[str, str]"]:
    """lot_id → (numer faktury ze zgłoszenia, skąd wiemy: "numer" | "wartosc").

    Najpierw numer zamówienia z lotu porównany z numerem faktury (KS Medical, Sunshine).
    Co zostanie, łączymy po wartości: suma cen planowanych lotu wobec sumy pozycji SAD
    tej faktury. Na MEDI numer zamówienia (MKB…) różni się od numeru faktury (MKF…),
    a wartości różnią się o 3% — przy trzech fakturach o zupełnie różnych kwotach
    to rozstrzyga bez wątpliwości. Rozjazd ponad 50% zostawiamy bez przypisania.
    """
    faktury = list(odprawa.faktury_dostawcy)
    wynik: Dict[int, "tuple[str, str]"] = {}
    wolne = set(faktury)
    # Dwa przejścia: najpierw numer identyczny, dopiero potem zawieranie się. Inaczej
    # zamówienie „CXH20260211" zgarnia fakturę „CXH20260211-1" przed jej właściwym lotem.
    for dokladnie in (True, False):
        for lot in loty:
            nr = _numer(lot.get("order_number"))
            if len(nr) < 5 or lot["id"] in wynik:
                continue
            for fv in sorted(wolne):
                n_fv = _numer(fv)
                if nr == n_fv or (not dokladnie and len(n_fv) >= 5 and (nr in n_fv or n_fv in nr)):
                    wynik[lot["id"]] = (fv, "numer")
                    wolne.discard(fv)
                    break

    kurs = odprawa.kurs_celny or 1.0
    wart_fv: Dict[str, float] = {}
    for p in odprawa.pozycje:
        for fv in p.faktury_dostawcy:
            wart_fv[fv] = wart_fv.get(fv, 0.0) + p.wartosc / max(1, len(p.faktury_dostawcy))
    pary = []
    for lot in loty:
        if lot["id"] in wynik:
            continue
        plan = sum(t.ilosc * t.cena_planowana for t in towar_lotu.get(lot["id"], [])) / kurs
        for fv in wolne:
            w = wart_fv.get(fv, 0.0)
            if plan and w:
                pary.append((abs(plan - w) / w, lot["id"], fv))
    for odch, lot_id, fv in sorted(pary):
        if odch > 0.5 or lot_id in wynik or fv not in wolne:
            continue
        wynik[lot_id] = (fv, "wartosc")
        wolne.discard(fv)
    return wynik


def _wybierz_loty(
    odprawa: Odprawa,
    loty: Sequence[Dict[str, Any]],
    towar: Sequence[PozycjaTowaru],
    meta: Dict[int, Dict[str, Any]],
    firma_sad: Optional[Dict[str, Any]],
    ta_odprawa_id: Optional[int],
    mrn_odpraw: Dict[int, str],
    wybor_uzytkownika: Optional[Sequence[int]],
) -> List[OdprawaLotOut]:
    """Które loty obejmuje to zgłoszenie — automatycznie albo tak, jak zaznaczył użytkownik.

    Lot NIE MOŻE wejść, gdy jego towar należy do innej spółki niż importer z SAD, gdy ma
    już inny MRN albo gdy rozliczyła go inna odprawa. Pozostałe wchodzą domyślnie —
    użytkownik może któryś odznaczyć (na przykład towar, który jeszcze nie przypłynął).
    """
    towar_lotu: Dict[int, List[PozycjaTowaru]] = {}
    for t in towar:
        lid = meta.get(t.item_id, {}).get("lot_id")
        if lid is not None:
            towar_lotu.setdefault(lid, []).append(t)
    slug_sad = ((firma_sad or {}).get("slug") or "").lower() or None
    mrn_sad = (odprawa.mrn or "").strip().upper()

    def stan(lot):
        lista = towar_lotu.get(lot["id"], [])
        firmy = Counter(meta[t.item_id]["firma"] for t in lista)
        firma = firmy.most_common(1)[0][0] if firmy else None
        odprawy = Counter(meta[t.item_id]["odprawa_id"] for t in lista if meta[t.item_id]["odprawa_id"])
        inna = next((oid for oid, _ in odprawy.most_common() if oid != ta_odprawa_id), None)
        mrn_lotu = (lot.get("mrn") or "").strip().upper()
        wolny = (bool(lista) and not (slug_sad and firma and firma != slug_sad)
                 and not (mrn_lotu and mrn_sad and mrn_lotu != mrn_sad) and inna is None)
        return lista, firma, odprawy, inna, mrn_lotu, wolny

    # Faktury dopasowujemy tylko do lotów, które mogą wejść do tego zgłoszenia. Inaczej lot
    # innej spółki potrafił „zabrać" fakturę: MEDU1028983 — lot AMH z zamówieniem CXH20260211
    # łapał fakturę Veluxy CXH20260211-1, a lot Veluxy zostawał bez faktury.
    faktury = _faktury_lotow(odprawa, [l for l in loty if stan(l)[5]], towar_lotu)

    wynik: List[OdprawaLotOut] = []
    for lot in loty:
        lista, firma, odprawy, inna, mrn_lotu, _ = stan(lot)

        blokada, powod = False, ""
        if not lista:
            blokada, powod = True, "Lot nie ma towaru na kontenerze."
        elif slug_sad and firma and firma != slug_sad:
            blokada = True
            powod = (f"Towar {firma.upper()}, a importerem w tym zgłoszeniu jest {slug_sad.upper()}. "
                     "Ten lot rozliczy osobne zgłoszenie.")
        elif mrn_lotu and mrn_sad and mrn_lotu != mrn_sad:
            blokada, powod = True, f"Lot ma już MRN {lot['mrn']} — należy do innego zgłoszenia."
        elif inna is not None:
            blokada = True
            powod = f"Rozliczony odprawą {mrn_odpraw.get(inna, inna)}. Cofnij ją, jeśli to pomyłka."

        fv = faktury.get(lot["id"])
        if not blokada:
            if fv and fv[1] == "numer":
                powod = f"Numer zamówienia zgadza się z fakturą {fv[0]}."
            elif fv:
                powod = f"Wartość lotu odpowiada fakturze {fv[0]} — numer zamówienia jest inny."
            elif odprawa.faktury_dostawcy:
                powod = "Nie znalazłem jego faktury w zgłoszeniu — sprawdź, czy ten towar jest w tym SAD."
            else:
                powod = "Zgłoszenie nie podaje faktur dostawców."

        if wybor_uzytkownika is None:
            wybrany = not blokada
        else:
            wybrany = lot["id"] in set(wybor_uzytkownika)

        wynik.append(OdprawaLotOut(
            lot_id=lot["id"], container_id=lot["container_id"],
            dostawca=lot.get("dostawca"), zamowienie=lot.get("order_number"), mrn=lot.get("mrn"),
            firma=firma, sku=sorted({t.sku for t in lista}), sztuk=sum(t.ilosc for t in lista),
            wybrany=wybrany, blokada=blokada,
            faktura=fv[0] if fv and not blokada else None,
            dopasowanie=fv[1] if fv and not blokada else None,
            powod=powod,
            odprawa_id=inna if inna is not None else (ta_odprawa_id if ta_odprawa_id in odprawy else None),
            odprawa_mrn=mrn_odpraw.get(inna) if inna is not None else None,
        ))
    return wynik


def _udzial_kontenerow(towar_odprawy: Sequence[PozycjaTowaru], towar_wszystko: Sequence[PozycjaTowaru]
                       ) -> Dict[int, float]:
    """Jaka część każdego kontenera należy do tej odprawy — po wadze brutto.

    Transport krajowy to jedna ciężarówka na cały kontener, więc przy kilku odprawach
    każda bierze tyle, ile waży jej towar. Gdy któremuś SKU w kontenerze brakuje wagi,
    porównanie wag byłoby fikcją — liczymy wtedy po wartości planowanej.
    """
    wynik: Dict[int, float] = {}
    for cid in {t.container_id for t in towar_wszystko}:
        wszystko = [t for t in towar_wszystko if t.container_id == cid]
        moje_id = {t.item_id for t in towar_odprawy if t.container_id == cid}
        if all(t.waga_brutto_kg is not None for t in wszystko):
            miara = lambda t: (t.waga_brutto_kg or 0) * t.ilosc  # noqa: E731
        else:
            miara = lambda t: t.cena_planowana * t.ilosc  # noqa: E731
        calosc = sum(miara(t) for t in wszystko)
        wynik[cid] = (sum(miara(t) for t in wszystko if t.item_id in moje_id) / calosc) if calosc else 1.0
    return wynik


async def _odprawy_kontenera(db: AsyncSession, container_id: int) -> List[OdprawaKontenerOut]:
    rows = (await db.execute(
        text(f"""
            SELECT o.id, o.mrn, o.data_zgloszenia, o.importer, o.status,
                   (SELECT COUNT(*) FROM {settings.TABLE_CONTAINER_ITEMS} ci
                     WHERE ci.koszt_odprawa_id = o.id AND ci.container_id = :cid) AS pozycji
              FROM app_odprawy o
              JOIN app_odprawa_kontenery ok ON ok.odprawa_id = o.id
             WHERE ok.container_id = :cid
             ORDER BY o.data_zgloszenia NULLS LAST, o.id
        """),
        {"cid": container_id},
    )).mappings().all()
    return [OdprawaKontenerOut(id=r["id"], mrn=r["mrn"], data_zgloszenia=r["data_zgloszenia"],
                               importer=r["importer"], status=r["status"] or "zapisana",
                               pozycji=int(r["pozycji"] or 0)) for r in rows]


async def _mrn_odpraw(db: AsyncSession, ids: Sequence[int]) -> Dict[int, str]:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    rows = (await db.execute(text("SELECT id, mrn FROM app_odprawy WHERE id = ANY(:ids)"),
                             {"ids": list(ids)})).all()
    return {r[0]: r[1] for r in rows}


async def _koszt_erp(db: AsyncSession, slug: Optional[str],
                    skus: Sequence[str]) -> "tuple[Optional[str], Dict[str, float]]":
    """Bieżący koszt zakupu SKU w ERP spółki, która importuje ten kontener.

    Kolumna „cena plan." z pozycji kontenera bywa nieaktualna — wpisuje się ją przy
    zakładaniu kontenera i nikt jej potem nie poprawia. Do porównania z rachunkiem
    odprawy bardziej miarodajny jest koszt, który dziś trzyma ERP.

    Ten sam SKU potrafi mieć dwa koszty: AMH kupuje część towaru od Acti albo Veluxy
    po cenie transferowej, więc Subiekt zna koszt AMH, a Fakturownia koszt spółki-matki.
    Interesuje nas koszt IMPORTERA — a importera wskazuje samo zgłoszenie (NIP z SAD),
    więc nie ma tu żadnego zgadywania:
      · AMH (is_self)  → Subiekt (subiekt_dwa_magazyny, zapasowo stary katalog)
      · Acti / Veluxa  → fakturownia_stock TEJ firmy (firma_id), nie dowolnej

    Zwraca (źródło, {sku_canon: cena}). Ceny zerowe traktujemy jak brak — zero w tych
    tabelach znaczy „nie wiem", a nie „za darmo".
    """
    klucze = sorted({(x or "").strip().lower() for x in skus if x})
    if not klucze:
        return None, {}
    f = None
    if slug:
        f = (await db.execute(
            text(f"SELECT id, is_self FROM {settings.TABLE_FIRMY} WHERE LOWER(slug) = :s"),
            {"s": slug.strip().lower()},
        )).mappings().first()
    if f is None or f["is_self"]:
        rows = (await db.execute(
            text(f"""
                SELECT k, cena FROM (
                    SELECT LOWER(TRIM(sku)) AS k, MAX(NULLIF(cena_jednostkowa, 0))::float AS cena, 1 AS pri
                      FROM {settings.TABLE_SUBIEKT_DWA}
                     WHERE LOWER(TRIM(sku)) = ANY(:k)
                     GROUP BY 1
                    UNION ALL
                    SELECT LOWER(TRIM({settings.COL_PRODUCT_SKU})),
                           MAX(NULLIF({settings.COL_PRODUCT_PRICE}, 0))::float, 2
                      FROM {settings.TABLE_PRODUCTS}
                     WHERE LOWER(TRIM({settings.COL_PRODUCT_SKU})) = ANY(:k)
                     GROUP BY 1
                ) c
                WHERE cena IS NOT NULL
                ORDER BY pri DESC
            """),
            {"k": klucze},
        )).mappings().all()
        # ORDER BY pri DESC + nadpisywanie w słowniku = wygrywa nowy Subiekt (pri 1).
        return "subiekt", {r["k"]: float(r["cena"]) for r in rows}
    rows = (await db.execute(
        text(f"""
            SELECT sku_canon AS k, MAX(NULLIF(purchase_price_net, 0))::float AS cena
              FROM {settings.TABLE_FAKTUROWNIA_STOCK}
             WHERE firma_id = :fid AND sku_canon = ANY(:k)
             GROUP BY 1
        """),
        {"fid": f["id"], "k": klucze},
    )).mappings().all()
    return "fakturownia", {r["k"]: float(r["cena"]) for r in rows if r["cena"] is not None}


def _kwota(v) -> float:
    """Liczba z bazy (Decimal albo NULL) jako float. Na poziomie modułu — pomocnik `_f`
    żyje wewnątrz endpointu odczytu i stąd go nie widać, co przy ponownym wczytaniu
    zapisanej odprawy kończyło się błędem 500 („Failed to fetch" w przeglądarce)."""
    return float(v) if v is not None else 0.0


async def _zapisane_ustawienia(db: AsyncSession, istniejaca) -> Optional[OdprawaZapisaneOut]:
    """Ustawienia i ceny ręczne z poprzedniego zapisu tej odprawy — albo None.

    Podgląd jest bezstanowy: liczy z pliku i z tego, co przyśle front. Dopóki nie oddawał
    zapisanego stanu, dołożenie faktury spedytora kilka dni po odprawie znaczyło
    przepisywanie od zera wszystkich cen z faktury dostawcy. Teraz front ma czym wypełnić
    puste pola, a co z tym zrobi, zostaje jego decyzją.

    Przywracamy WYŁĄCZNIE ceny wpisane ręcznie. Ceny rozdzielone proporcją mają się
    przeliczyć od nowa — gdyby wróciły jako ręczne, zamroziłyby stary podział nawet po
    zmianie przypisania pozycji.
    """
    if not istniejaca:
        return None
    koszty = (await db.execute(
        text("SELECT lp, nazwa, kwota, waluta, klucz, zrodlo, container_id "
             "  FROM app_odprawa_koszty WHERE odprawa_id = :id ORDER BY lp NULLS LAST, id"),
        {"id": istniejaca["id"]},
    )).mappings().all()
    itemy = (await db.execute(
        text(f"""
            SELECT id, cena_zakupu_waluta, cena_reczna, odprawa_poz_nr
              FROM {settings.TABLE_CONTAINER_ITEMS}
             WHERE koszt_odprawa_id = :id
        """),
        {"id": istniejaca["id"]},
    )).mappings().all()
    return OdprawaZapisaneOut(
        odprawa_id=istniejaca["id"],
        status=istniejaca["status"] or "szkic",
        klucz_podzialu=istniejaca["klucz_podzialu"],
        kurs_towaru=_kwota(istniejaca["kurs_towaru"]) or None,
        kurs_kosztow=_kwota(istniejaca["kurs_kosztow"]) or None,
        fv_spedytora=istniejaca["fv_spedytora"],
        fv_spedytora_data=istniejaca["fv_spedytora_data"],
        koszty=[OdprawaLiniaKosztuIn(
            lp=k["lp"], nazwa=k["nazwa"] or "", kwota=_kwota(k["kwota"]), waluta=k["waluta"] or "USD",
            klucz=k["klucz"] or "fizyczny", container_id=k["container_id"],
        ) for k in koszty],
        ceny_reczne={i["id"]: _kwota(i["cena_zakupu_waluta"]) for i in itemy
                     if i["cena_reczna"] and i["cena_zakupu_waluta"] is not None},
        przypisanie={i["id"]: int(i["odprawa_poz_nr"]) for i in itemy
                     if i["odprawa_poz_nr"] is not None},
    )


LP_ZALADUNEK = 6  # linia „Załadunek u dostawcy (033W)"


def _linie_kosztow(odprawa: Odprawa, ustawienia: OdprawaUstawieniaIn,
                   kontenery: Sequence[Dict[str, Any]]) -> List[OdprawaLiniaKosztuIn]:
    """Domyślny zestaw linii: fracht, THC i ubezpieczenie z doliczeń SAD, reszta pusta.

    Gdy front przysyła własne linie (bo użytkownik przepisał fakturę spedytora),
    biorą one pierwszeństwo w całości — nie doklejamy do nich niczego.
    """
    if ustawienia.koszty:
        return list(ustawienia.koszty)

    # Linie w walucie faktury spedytora (waluta frachtu z SAD), w oryginalnych kwotach —
    # przy SAD w CNY fracht i tak przychodzi w USD.
    wal = odprawa.waluta_kosztow
    d = {x.kod: (x.kwota_waluta if x.waluta == wal else x.kwota) for x in odprawa.doliczenia}
    linie = [
        OdprawaLiniaKosztuIn(lp=1, nazwa="Fracht morski", kwota=d.get("031W", 0), waluta=wal),
        OdprawaLiniaKosztuIn(lp=2, nazwa="THC", kwota=d.get("071V", 0), waluta=wal),
        OdprawaLiniaKosztuIn(lp=3, nazwa="Opłata dokumentacyjna", kwota=0, waluta=wal),
        OdprawaLiniaKosztuIn(lp=4, nazwa="Ubezpieczenie cargo", kwota=d.get("032W", 0),
                             waluta=wal, klucz="wartosc"),
        OdprawaLiniaKosztuIn(lp=5, nazwa="Zgłoszenie do odprawy celnej", kwota=0, waluta=wal),
    ]
    if d.get("033W"):
        # Załadunek po stronie dostawcy (np. „Container FOB cost") — płacony dostawcy,
        # więc nie ma go na fakturze spedytora, a do kosztu towaru należy.
        linie.append(OdprawaLiniaKosztuIn(lp=LP_ZALADUNEK, nazwa="Załadunek u dostawcy (033W)",
                                          kwota=d["033W"], waluta=wal))
    for k in kontenery:
        linie.append(OdprawaLiniaKosztuIn(
            nazwa="Transport krajowy", kwota=float(k.get("koszt_transportu_magazyn") or 0),
            waluta="PLN", container_id=k["id"],
        ))
    return linie


def _na_serwis(linie: Sequence[OdprawaLiniaKosztuIn]) -> List[LiniaKosztu]:
    return [LiniaKosztu(nazwa=l.nazwa, kwota=float(l.kwota or 0), waluta=l.waluta,
                        klucz=l.klucz, container_id=l.container_id, lp=l.lp) for l in linie]


async def _zloz(
    db: AsyncSession,
    container_id: int,
    plik: bytes,
    ustawienia: OdprawaUstawieniaIn,
) -> tuple[OdprawaOut, Odprawa, Rachunek, List[Dict[str, Any]], List[PozycjaTowaru]]:
    """Parsuje, sprawdza bramki, liczy rachunek. Nic nie zapisuje."""
    try:
        odprawa = parsuj(plik)
    except BladSAD as e:
        raise HTTPException(400, str(e)) from e

    otwarty = await _kontener(db, container_id)
    numer = (otwarty["container_number"] or "").strip().upper()
    if not odprawa.kontenery and await _drobnica_pasuje(db, container_id, odprawa):
        # Drobnica (LCL): towar jechał na paletach w cudzym kontenerze, więc SAD nie ma
        # numeru kontenera (P19Kontenery="0"). Kontener w aplikacji wiążemy wtedy z
        # fakturą dostawcy — dalej rachunek i zapis idą tak, jakby numer był w pliku.
        odprawa.kontenery = [numer]
    if numer not in odprawa.kontenery:
        raise HTTPException(400, (
            (f"Ten SAD dotyczy kontenerów {', '.join(odprawa.kontenery)}, "
             f"a otwarty jest {otwarty['etykieta']}. Otwórz właściwy kontener albo wrzuć inny plik.")
            if odprawa.kontenery else
            (f"Ten SAD nie podaje numeru kontenera (drobnica), a jego faktura "
             f"{', '.join(odprawa.faktury_dostawcy) or '(brak)'} nie zgadza się z numerem zamówienia "
             f"kontenera {otwarty['etykieta']} ani jego lotów. Popraw numer zamówienia albo otwórz właściwy kontener.")
        ))

    firma_sad = await _firma_po_nip(db, odprawa.nip_importera)
    kontenery = await _kontenery_odprawy(db, odprawa.kontenery)
    # Konsolidację rozpoznajemy po fladze ALBO po samych lotach — flaga bywa nieustawiona,
    # a kontener z lotami bez niej wciągnąłby do rachunku towar innych dostawców i spółek.
    loty_db = await _loty(db, [k["id"] for k in kontenery])
    konsolidacja = any(k.get("is_consolidated") for k in kontenery) or bool(loty_db)
    for k in kontenery:
        # Przy konsolidacji MRN siedzi na lotach (każdy lot może mieć swoje zgłoszenie),
        # więc sprawdzamy go niżej, lot po locie — numer na samym kontenerze nie wiąże.
        if konsolidacja:
            continue
        if k["mrn"] and odprawa.mrn and k["mrn"].strip().upper() != odprawa.mrn.strip().upper():
            raise HTTPException(400, (
                f"Kontener {k['etykieta']} ma już MRN {k['mrn']}, a plik niesie {odprawa.mrn}. "
                "Popraw numer na kontenerze albo wrzuć właściwe zgłoszenie."
            ))

    istniejaca = (await db.execute(
        text("SELECT id, status, klucz_podzialu, kurs_towaru, kurs_kosztow, "
             "       fv_spedytora, fv_spedytora_data "
             "  FROM app_odprawy WHERE mrn = :mrn"),
        {"mrn": odprawa.mrn},
    )).mappings().first()

    towar_wszystko, meta = await _towar(db, [k["id"] for k in kontenery])
    # Zgoda na importera innego niż firma towaru: zaznaczona teraz albo przy wcześniejszym
    # zapisie tej odprawy (zapisana odprawa przeszła już tę bramkę — dołożenie faktury
    # spedytora kilka dni później nie powinno pytać drugi raz).
    inny_importer = bool(ustawienia.inny_importer or istniejaca)
    loty_out: List[OdprawaLotOut] = []
    towar = towar_wszystko
    if konsolidacja:
        mrn_odpraw = await _mrn_odpraw(db, list({m["odprawa_id"] for m in meta.values() if m["odprawa_id"]}))
        loty_out = _wybierz_loty(odprawa, loty_db, towar_wszystko, meta,
                                 None if ustawienia.inny_importer else firma_sad,
                                 istniejaca["id"] if istniejaca else None, mrn_odpraw, ustawienia.loty)
        wybrane = {l.lot_id for l in loty_out if l.wybrany}
        towar = [t for t in towar_wszystko if meta[t.item_id]["lot_id"] is None
                 or meta[t.item_id]["lot_id"] in wybrane]

    # Firma towaru = najczęstsza firma TEGO, co liczymy. Przy konsolidacji to towar
    # wybranych lotów, a nie całego kontenera — inaczej 1000 szt. Veluxy przegłosowałoby
    # trzy loty Acti i odprawa Acti nie dałaby się wczytać.
    firmy = Counter(meta[t.item_id]["firma"] for t in towar)
    firma_kont = firmy.most_common(1)[0][0] if firmy else None
    obcy_importer = bool(firma_sad and firma_kont and firma_sad["slug"].lower() != firma_kont)
    if obcy_importer and not inny_importer:
        # Początek komunikatu jest umową z frontem — po nim pokazuje „Rozlicz mimo to".
        raise HTTPException(400, (
            f"Importerem w SAD jest {firma_sad['name']} (NIP {odprawa.nip_importera}), "
            f"a towar w kontenerze należy do firmy {firma_kont.upper()}."
        ))

    faktury_sku: Dict[str, set] = {}
    for l in loty_out:
        if l.wybrany and l.faktura:
            for sku in l.sku:
                faktury_sku.setdefault(sku, set()).add(l.faktura)
    udzial = _udzial_kontenerow(towar, towar_wszystko) if konsolidacja else None

    linie = _linie_kosztow(odprawa, ustawienia, kontenery)
    klucz = KLUCZ_CBM if ustawienia.klucz_podzialu == KLUCZ_CBM else KLUCZ_WAGA

    # Kurs towaru: wpisany ręcznie, a bez niego — z dni zapłaty zaliczek i balance (jak zakładka
    # „Koszt jednostkowy"). Kurs celny z SAD-u zostaje ostatnim zapasem w services/odprawy.py.
    kurs_platnosci, kurs_szac = await _kurs_z_platnosci(
        db, [t.container_id for t in towar], [t.item_id for t in towar])
    kurs_towaru = ustawienia.kurs_towaru or kurs_platnosci

    rachunek = policz(
        odprawa, towar, _na_serwis(linie),
        przypisanie=ustawienia.przypisanie or None,
        gratisy=ustawienia.gratisy or None,
        klucz=klucz,
        kurs_towaru=kurs_towaru,
        kurs_kosztow=ustawienia.kurs_kosztow or odprawa.kurs_kosztow,
        ceny_reczne=ustawienia.ceny_reczne or None,
        faktury_sku=faktury_sku or None,
        udzial_kontenera=udzial,
    )

    uwagi = list(rachunek.uwagi)
    if obcy_importer:
        uwagi.append(Uwaga(
            "ostrzezenie", "Importer inny niż firma towaru — rozliczone świadomie",
            f"w SAD {firma_sad['name']}, towar {(firma_kont or '').upper()}; koszt z ERP pokazany dla importera",
        ))
    if konsolidacja:
        for l in loty_out:
            if l.wybrany and l.blokada:
                uwagi.append(Uwaga("blad", f"Lot {l.dostawca or l.lot_id} nie może wejść do tej odprawy",
                                   l.powod))
        z_lotem = {l.faktura for l in loty_out if l.wybrany and l.faktura}
        bez_lotu = [fv for fv in odprawa.faktury_dostawcy if fv not in z_lotem]
        if bez_lotu and loty_out:
            uwagi.append(Uwaga(
                "ostrzezenie",
                "Faktura ze zgłoszenia bez lotu na kontenerze — jej pozycje mogą rozliczyć się jako gratis",
                ", ".join(bez_lotu),
            ))
        czeka = [l for l in loty_out if not l.wybrany and l.odprawa_id is None]
        if czeka:
            uwagi.append(Uwaga(
                "info", "Na kontenerze zostaje towar bez zgłoszenia — rozliczysz go następną odprawą",
                "; ".join(f"{l.dostawca or 'lot'}: {', '.join(l.sku)}" for l in czeka),
            ))
        for k in kontenery:
            u = (udzial or {}).get(k["id"], 1.0)
            tk = float(k.get("koszt_transportu_magazyn") or 0)
            if u < 0.999 and any(l.container_id == k["id"] and l.kwota for l in linie):
                po_wadze = all(t.waga_brutto_kg is not None for t in towar_wszystko if t.container_id == k["id"])
                uwagi.append(Uwaga(
                    "info",
                    f"{k['etykieta']}: transport krajowy dzielony na cały kontener — "
                    f"ta odprawa bierze {u * 100:.1f}% " + ("jego wagi" if po_wadze else
                                                             "jego wartości (części towaru brakuje wagi)"),
                    f"kwota w polu to transport całego kontenera{f' ({tk:.2f} zł)' if tk else ''}",
                ))
    brakujace = [n for n in odprawa.kontenery
                 if n not in {(k["container_number"] or "").strip().upper() for k in kontenery}]
    if brakujace:
        uwagi.append(Uwaga("blad", "Kontener ze zgłoszenia nie istnieje w aplikacji", ", ".join(brakujace)))
    if len(kontenery) > 1:
        uwagi.append(Uwaga("info", "Odprawa obejmuje kilka kontenerów — koszt liczony łącznie",
                           ", ".join(k["etykieta"] for k in kontenery)))
    for k in kontenery:
        if konsolidacja:
            bez_mrn = [l for l in loty_out if l.wybrany and not l.blokada and not l.mrn
                       and l.container_id == k["id"]]
            if bez_mrn:
                uwagi.append(Uwaga("info", f"{k['etykieta']}: MRN uzupełni się na lotach przy zapisie",
                                   ", ".join(l.dostawca or str(l.lot_id) for l in bez_mrn)))
        elif not k["mrn"]:
            uwagi.append(Uwaga("info", f"{k['etykieta']}: MRN uzupełni się przy zapisie",
                               odprawa.mrn or ""))
    if odprawa.faktury_dostawcy:
        uwagi.append(Uwaga("info", "Faktury dostawcy w zgłoszeniu", ", ".join(odprawa.faktury_dostawcy)))
    if len(odprawa.kursy) > 1:
        uwagi.append(Uwaga("info", "W pliku jest kilka kursów — użyty kurs waluty zgłoszenia",
                           f"{odprawa.waluta} {odprawa.kurs_celny}"))

    zapisane = await _zapisane_ustawienia(db, istniejaca)
    zrodlo_erp, erp = await _koszt_erp(db, (firma_sad or {}).get("slug") or firma_kont,
                                       [t.sku for t in towar])

    kontr = kontrole(odprawa)
    zle_kontrole = [k for k in kontr if not k.ok]
    if zle_kontrole:
        uwagi.append(Uwaga("blad", "Liczby w zgłoszeniu nie spinają się ze sobą",
                           "; ".join(k.nazwa for k in zle_kontrole[:3])))

    po_nr = {p.nr: [] for p in odprawa.pozycje}
    for item_id, nr in rachunek.przypisanie.items():
        po_nr.setdefault(nr, []).append(item_id)
    nr_kontenera = {k["id"]: k["etykieta"] for k in kontenery}
    etykieta_numeru = {(k["container_number"] or "").strip().upper(): k["etykieta"] for k in kontenery}

    out = OdprawaOut(
        kurs_platnosci=kurs_platnosci, kurs_platnosci_szacunek=kurs_szac,
        mrn=odprawa.mrn,
        data_zgloszenia=odprawa.data_zgloszenia,
        dostawca=odprawa.dostawca,
        importer=odprawa.importer,
        nip_importera=odprawa.nip_importera,
        firma_slug=(firma_sad or {}).get("slug"),
        incoterms=odprawa.incoterms,
        waluta=odprawa.waluta,
        kurs_celny=odprawa.kurs_celny,
        kursy=odprawa.kursy,
        wartosc_faktur=odprawa.wartosc_faktur,
        masa_brutto=odprawa.masa_brutto,
        clo_suma=odprawa.clo_suma,
        vat_suma=odprawa.vat_suma,
        faktury_dostawcy=odprawa.faktury_dostawcy,
        kontenery=[etykieta_numeru.get(n, n) for n in odprawa.kontenery],
        kontenery_w_aplikacji=[k["id"] for k in kontenery],
        doliczenia=[{"kod": d.kod, "kwota": d.kwota, "klucz": d.klucz,
                     "do_wartosci_celnej": d.do_wartosci_celnej} for d in odprawa.doliczenia],
        pozycje=[OdprawaPozycjaOut(
            nr=p.nr, kod_cn=p.kod_cn or None, opis=p.opis, wartosc=p.wartosc,
            masa_brutto=p.masa_brutto, clo_stawka=p.clo_stawka, clo_pln=p.clo_pln,
            vat_stawka=p.vat_stawka, vat_metoda=p.vat_metoda,
            liczba_opakowan=p.liczba_opakowan, szt_uzup=p.szt_uzup, kontenery=p.kontenery,
            item_ids=sorted(po_nr.get(p.nr, [])), gratis_item_id=rachunek.gratisy.get(p.nr),
            faktury=list(p.faktury_dostawcy),
        ) for p in odprawa.pozycje],
        towar=[OdprawaTowarOut(
            item_id=w.item_id, container_id=w.container_id,
            container_number=nr_kontenera.get(w.container_id, ""), sku=w.sku, ilosc=w.ilosc,
            cena_planowana=round(w.cena_planowana, 2), cena_zakupu_waluta=w.cena_zakupu_waluta,
            towar=round(w.towar, 2), logistyka=round(w.logistyka, 2), clo=round(w.clo, 2),
            gratisy=round(w.gratisy, 2), transport_krajowy=round(w.transport_krajowy, 2),
            koszt_jednostkowy=w.koszt_jednostkowy, zmiana_proc=w.zmiana_proc,
            szacunek=w.szacunek, reczna=w.reczna, poz_sad=rachunek.przypisanie.get(w.item_id),
            koszt_erp=erp.get((w.sku or "").strip().lower()),
        ) for w in rachunek.pozycje],
        koszty=linie,
        kontrole=[OdprawaKontrolaOut(nazwa=k.nazwa, ok=k.ok, wyliczone=k.wyliczone, z_pliku=k.z_pliku)
                  for k in kontr],
        uwagi=[OdprawaUwagaOut(poziom=u.poziom, tresc=u.tresc, szczegol=u.szczegol) for u in uwagi],
        klucz_podzialu=klucz,
        suma_towar=rachunek.suma_towar,
        suma_logistyka=rachunek.suma_logistyka,
        suma_clo=rachunek.suma_clo,
        narzut_proc=rachunek.narzut_proc,
        mozna_zapisac=not any(u.poziom == "blad" for u in uwagi),
        status=(istniejaca["status"] if istniejaca else "podglad"),
        zapisane=zapisane,
        zrodlo_erp=zrodlo_erp,
        odprawa_id=istniejaca["id"] if istniejaca else None,
        loty=loty_out,
        odprawy_kontenera=await _odprawy_kontenera(db, container_id),
    )
    return out, odprawa, rachunek, kontenery, towar


# ============================================================
# Endpointy
# ============================================================

async def _kurs_z_platnosci(db: AsyncSession, container_ids: Sequence[int],
                            item_ids: Sequence[int]) -> "tuple[Optional[float], bool]":
    """Kurs towaru ze zgłoszenia liczony jak w zakładce „Koszt jednostkowy": średnia z kursów
    NBP z dnia roboczego przed zapłatą zaliczek i balance, ważona wartością lotów objętych
    odprawą. Zwraca (kurs, szacunek) — szacunek, gdy coś jest jeszcze niezapłacone."""
    from services.koszt_kontenera_dane import policz_kontenery

    ids = set(item_ids)
    wyniki, _ = await policz_kontenery(db, sorted(set(container_ids)))
    licznik = mianownik = 0.0
    szacunek = False
    for w in wyniki.values():
        grupy = {p.grupa for p in w.pozycje if p.item_id in ids}
        for g in w.grupy:
            if g.id in grupy and not g.krajowa and g.kurs_auto and g.wartosc_waluta:
                licznik += g.kurs_auto * g.wartosc_waluta
                mianownik += g.wartosc_waluta
                szacunek = szacunek or g.szacunek
    return (round(licznik / mianownik, 4) if mianownik else None), szacunek


async def _dolicz_nowa_metode(db: AsyncSession, out: Optional[OdprawaOut]) -> Optional[OdprawaOut]:
    """Kontrola dla superadmina: koszt tej samej pozycji liczony nową metodą (bez SAD-u).

    Koszt jednostkowy liczy się dziś z karty kontenera i płatności (services/koszt_kontenera.py);
    kolumna obok kosztu z SAD pokazuje, jak bardzo jedno odbiega od drugiego.
    """
    if out is None or not out.towar:
        return out
    from services.koszt_kontenera_dane import policz_kontenery

    wyniki, _ = await policz_kontenery(db, sorted({t.container_id for t in out.towar}))
    koszt = {p.item_id: p.koszt_jednostkowy for w in wyniki.values() for p in w.pozycje}
    for t in out.towar:
        t.koszt_nowa_metoda = koszt.get(t.item_id)
    out.kurs_platnosci, out.kurs_platnosci_szacunek = await _kurs_z_platnosci(
        db, [t.container_id for t in out.towar], [t.item_id for t in out.towar])
    return out


@router.post("/kontenery/{container_id}/odprawa/podglad", response_model=OdprawaOut)
async def podglad(
    container_id: int,
    plik: UploadFile = File(...),
    ustawienia: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_sad),
):
    """Wczytuje zgłoszenie i pokazuje rachunek. NIC nie zapisuje."""
    tresc = await plik.read()
    if len(tresc) > MAX_XML:
        raise HTTPException(413, "Plik jest za duży jak na zgłoszenie celne (limit 8 MB).")
    out, *_ = await _zloz(db, container_id, tresc, _ustawienia(ustawienia))
    return await _dolicz_nowa_metode(db, out)


@router.post("/kontenery/{container_id}/odprawa", response_model=OdprawaOut)
async def zapisz(
    container_id: int,
    plik: UploadFile = File(...),
    ustawienia: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_sad),
):
    """Zapisuje odczyt zgłoszenia i koszt jednostkowy na pozycjach kontenerów."""
    tresc = await plik.read()
    if len(tresc) > MAX_XML:
        raise HTTPException(413, "Plik jest za duży jak na zgłoszenie celne (limit 8 MB).")
    ust = _ustawienia(ustawienia)
    out, odprawa, rachunek, kontenery, towar = await _zloz(db, container_id, tresc, ust)
    if not out.mozna_zapisac:
        bledy = [u.tresc for u in out.uwagi if u.poziom == "blad"]
        raise HTTPException(409, "Nie zapisuję — najpierw popraw: " + "; ".join(bledy))
    if not odprawa.mrn:
        raise HTTPException(400, "Zgłoszenie nie ma numeru MRN — bez niego nie ma czego zapisać.")

    przed = (await db.execute(
        text("SELECT data_zgloszenia, kurs_celny, wartosc_faktur, waluta, clo_suma, vat_suma, fv_spedytora "
             "FROM app_odprawy WHERE mrn = :mrn"), {"mrn": odprawa.mrn},
    )).mappings().first()
    out.zapis = await _zapisz_wszystko(
        db, odprawa, rachunek, kontenery, towar, out, ust,
        nazwa_pliku=plik.filename or "", user_id=getattr(user, "id", None),
    )
    out.status = "zapisana"
    _opisz_zapis(container_id, out, dict(przed) if przed else None, ust)
    return await _dolicz_nowa_metode(db, out)


# Dziennik audytu: co z odprawy pokazujemy w „było → jest”.
POLA_ODPRAWY = {
    "data_zgloszenia": ("Data zgłoszenia", f_data),
    "kurs_celny": ("Kurs celny", f_num("", 4)),
    "wartosc": ("Wartość faktur", f_txt),
    "clo_suma": ("Cło", f_zl),
    "vat_suma": ("VAT importowy", f_zl),
    "fv_spedytora": ("FV spedytora", f_txt),
}


def _opisz_zapis(container_id: int, out: OdprawaOut, przed: Optional[dict], ust) -> None:
    def _wartosc(kwota, waluta):
        return f_kwota(waluta or "USD")(kwota) if kwota is not None else None

    po = {"data_zgloszenia": out.data_zgloszenia, "kurs_celny": out.kurs_celny,
          "wartosc": _wartosc(out.wartosc_faktur, out.waluta), "clo_suma": out.clo_suma,
          "vat_suma": out.vat_suma, "fv_spedytora": getattr(ust, "fv_spedytora", None)}
    if przed:
        przed["wartosc"] = _wartosc(przed.get("wartosc_faktur"), przed.get("waluta"))
    ch = audit.zmiany(przed, po, POLA_ODPRAWY)
    ch.append({"pole": "Logistyka (rozpisana)", "bylo": "", "jest": f_zl(out.suma_logistyka)})
    if out.narzut_proc is not None:
        ch.append({"pole": "Narzut na towar", "bylo": "", "jest": f_num("%", 1)(out.narzut_proc)})
    n = out.zapis.pozycji_z_kosztem if out.zapis else 0
    kont = ", ".join(out.kontenery) or f"#{container_id}"
    audit.note(
        f"{'zapisał ponownie' if przed else 'zapisał'} odprawę MRN {out.mrn} ({kont}) — "
        f"cło {f_zl(out.clo_suma)}, VAT {f_zl(out.vat_suma)}, "
        f"koszt rozpisany na {n} {plural(n, 'pozycję', 'pozycje', 'pozycji')}",
        changes=ch, resource_id=container_id,
    )


@router.get("/kontenery/{container_id}/odprawa", response_model=Optional[OdprawaOut])
async def pobierz(
    container_id: int,
    odprawa_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_sad),
):
    """Zapisana odprawa tego kontenera albo null, gdy jeszcze jej nie policzono.

    Kontener skonsolidowany potrafi mieć kilka odpraw — `odprawa_id` wybiera jedną,
    bez niego dostajemy ostatnią. Lista wszystkich jedzie w `odprawy_kontenera`.
    """
    row = (await db.execute(
        text("""
            SELECT o.* FROM app_odprawy o
              JOIN app_odprawa_kontenery ok ON ok.odprawa_id = o.id
             WHERE ok.container_id = :cid AND (CAST(:oid AS INTEGER) IS NULL OR o.id = :oid)
             ORDER BY o.id DESC LIMIT 1
        """),
        {"cid": container_id, "oid": odprawa_id},
    )).mappings().first()
    if not row:
        return None

    pozycje = (await db.execute(
        text("SELECT * FROM app_odprawa_pozycje WHERE odprawa_id = :id ORDER BY nr"),
        {"id": row["id"]},
    )).mappings().all()
    koszty = (await db.execute(
        text("SELECT * FROM app_odprawa_koszty WHERE odprawa_id = :id ORDER BY lp NULLS LAST, id"),
        {"id": row["id"]},
    )).mappings().all()
    numery = (await db.execute(
        text(f"SELECT ok.numer, ok.container_id, {_etykieta_sql()} AS etykieta "
             f"  FROM app_odprawa_kontenery ok "
             f"  LEFT JOIN {settings.TABLE_CONTAINERS} c ON c.id = ok.container_id "
             f" WHERE ok.odprawa_id = :id ORDER BY ok.numer"),
        {"id": row["id"]},
    )).mappings().all()
    itemy = (await db.execute(
        text(f"""
            SELECT ci.id AS item_id, ci.container_id, {_etykieta_sql()} AS container_number, ci.sku, ci.quantity,
                   ci.unit_cost, ci.cena_zakupu_pln, ci.cena_zakupu_waluta, ci.koszt_jednostkowy,
                   ci.koszt_logistyka_pln, ci.koszt_clo_pln, ci.koszt_gratisy_pln,
                   ci.koszt_transport_pln, ci.odprawa_poz_nr, ci.cena_reczna
              FROM {settings.TABLE_CONTAINER_ITEMS} ci
              JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
             WHERE ci.koszt_odprawa_id = :id
             ORDER BY ci.container_id, ci.sku
        """),
        {"id": row["id"]},
    )).mappings().all()

    def _f(v) -> float:
        return float(v) if v is not None else 0.0

    # Sumy liczymy z zapisanego rozbicia, a nie z nowego rachunku — dzięki temu kafelki
    # po odświeżeniu pokazują to samo, co w chwili zapisu.
    suma_towar = sum(_f(i["cena_zakupu_pln"]) * int(i["quantity"] or 0) for i in itemy)
    suma_log = sum(_f(i["koszt_logistyka_pln"]) + _f(i["koszt_gratisy_pln"])
                   + _f(i["koszt_transport_pln"]) for i in itemy)
    suma_clo = sum(_f(i["koszt_clo_pln"]) for i in itemy)
    po_pozycji: Dict[int, List[int]] = {}
    sku_w_pozycji: Dict[int, set] = {}
    for i in itemy:
        if i["odprawa_poz_nr"] is not None:
            po_pozycji.setdefault(int(i["odprawa_poz_nr"]), []).append(i["item_id"])
            sku_w_pozycji.setdefault(int(i["odprawa_poz_nr"]), set()).add(i["sku"])
    # Cło pozycji bez towaru siedzi na sztuce w kolumnie „gratisy", więc w sumie wyżej
    # wpadło do logistyki. Przenosimy je do kafelka CŁO — tak samo jak w podglądzie,
    # inaczej po odświeżeniu kafelek pokazywałby co innego niż przed zapisem.
    clo_gratisow = sum(float(p["clo_pln"] or 0) for p in pozycje
                       if p["nr"] not in po_pozycji and p["gratis_item_id"] is not None)
    suma_log -= clo_gratisow
    suma_clo += clo_gratisow
    narzut = round((suma_log + suma_clo) / suma_towar * 100, 1) if suma_towar else None

    slug_importera = None
    if row.get("firma_id") is not None:
        r_f = (await db.execute(
            text(f"SELECT slug FROM {settings.TABLE_FIRMY} WHERE id = :id"), {"id": row["firma_id"]},
        )).first()
        slug_importera = r_f[0] if r_f else None
    if slug_importera is None:
        slug_importera = await _firma_kontenera(db, container_id)
    zrodlo_erp, erp = await _koszt_erp(db, slug_importera, [i["sku"] for i in itemy])

    return await _dolicz_nowa_metode(db, OdprawaOut(
        mrn=row["mrn"], data_zgloszenia=row["data_zgloszenia"], dostawca=row["dostawca"],
        importer=row["importer"], nip_importera=row["nip_importera"],
        incoterms=row["incoterms"], waluta=row["waluta"],
        kurs_celny=float(row["kurs_celny"] or 0),
        wartosc_faktur=float(row["wartosc_faktur"] or 0),
        masa_brutto=float(row["masa_brutto"] or 0),
        clo_suma=float(row["clo_suma"] or 0), vat_suma=float(row["vat_suma"] or 0),
        kontenery=[n["etykieta"] if n["container_id"] else n["numer"] for n in numery],
        kontenery_w_aplikacji=[n["container_id"] for n in numery if n["container_id"]],
        pozycje=[OdprawaPozycjaOut(
            nr=p["nr"], kod_cn=p["kod_cn"], opis=p["opis"] or "",
            wartosc=float(p["wartosc"] or 0), masa_brutto=float(p["masa_brutto"] or 0),
            clo_stawka=float(p["clo_stawka"] or 0), clo_pln=float(p["clo_pln"] or 0),
            vat_stawka=float(p["vat_stawka"] or 0), vat_metoda=p["vat_metoda"],
            liczba_opakowan=p["liczba_opakowan"],
            szt_uzup=float(p["szt_uzup"]) if p["szt_uzup"] is not None else None,
            gratis_item_id=p["gratis_item_id"],
            item_ids=sorted(po_pozycji.get(p["nr"], [])),
            faktury=[f.strip() for f in (p.get("faktury") or "").split(",") if f.strip()],
        ) for p in pozycje],
        towar=[OdprawaTowarOut(
            reczna=bool(i["cena_reczna"]),
            # „Szacunek" znaczy: cena rozdzielona proporcją, a nie wzięta wprost.
            # Odtwarzamy to samo kryterium co przy liczeniu — pozycja z kilkoma SKU
            # i cena, której nikt ręcznie nie wpisał.
            szacunek=(not i["cena_reczna"] and len(sku_w_pozycji.get(i["odprawa_poz_nr"], ())) > 1),
            item_id=i["item_id"], container_id=i["container_id"],
            container_number=i["container_number"], sku=i["sku"], ilosc=int(i["quantity"] or 0),
            cena_planowana=_f(i["unit_cost"]),
            cena_zakupu_waluta=_f(i["cena_zakupu_waluta"]),
            towar=_f(i["cena_zakupu_pln"]) * int(i["quantity"] or 0),
            logistyka=_f(i["koszt_logistyka_pln"]), clo=_f(i["koszt_clo_pln"]),
            gratisy=_f(i["koszt_gratisy_pln"]), transport_krajowy=_f(i["koszt_transport_pln"]),
            koszt_jednostkowy=_f(i["koszt_jednostkowy"]),
            zmiana_proc=(round((_f(i["koszt_jednostkowy"]) / _f(i["unit_cost"]) - 1) * 100, 1)
                         if _f(i["unit_cost"]) else None),
            poz_sad=int(i["odprawa_poz_nr"]) if i["odprawa_poz_nr"] is not None else None,
            koszt_erp=erp.get((i["sku"] or "").strip().lower()),
        ) for i in itemy],
        koszty=[OdprawaLiniaKosztuIn(
            lp=k["lp"], nazwa=k["nazwa"], kwota=float(k["kwota"] or 0), waluta=k["waluta"],
            klucz=k["klucz"], container_id=k["container_id"],
        ) for k in koszty],
        klucz_podzialu=row["klucz_podzialu"],
        kurs_towaru=_f(row["kurs_towaru"]) or None,
        kurs_kosztow=_f(row["kurs_kosztow"]) or None,
        fv_spedytora=row["fv_spedytora"],
        fv_spedytora_data=row["fv_spedytora_data"],
        suma_towar=round(suma_towar, 2),
        suma_logistyka=round(suma_log, 2),
        suma_clo=round(suma_clo, 2),
        narzut_proc=narzut,
        status=row["status"],
        zrodlo_erp=zrodlo_erp,
        odprawa_id=row["id"],
        loty=await _pokrycie_lotow(db, container_id, row["id"]),
        odprawy_kontenera=await _odprawy_kontenera(db, container_id),
    ))


async def _pokrycie_lotow(db: AsyncSession, container_id: int, odprawa_id: int) -> List[OdprawaLotOut]:
    """Loty otwartego kontenera i to, która odprawa rozliczyła ich towar.

    Pusta lista dla zwykłego kontenera — zakładka pokazuje wtedy dawny widok bez lotów.
    Lot „wybrany" to lot rozliczony TĄ odprawą; lot bez żadnej odprawy czeka na zgłoszenie.
    """
    loty = await _loty(db, [container_id])
    if not loty:
        return []
    towar, meta = await _towar(db, [container_id])
    mrn = await _mrn_odpraw(db, list({m["odprawa_id"] for m in meta.values() if m["odprawa_id"]}))

    # Który lot rozliczyła która odprawa — liczone raz, żeby potem dopasować faktury.
    towar_lotu: Dict[int, List[PozycjaTowaru]] = {}
    odprawa_lotu: Dict[int, Optional[int]] = {}
    for lot in loty:
        lista = [t for t in towar if meta[t.item_id]["lot_id"] == lot["id"]]
        towar_lotu[lot["id"]] = lista
        odprawy = Counter(meta[t.item_id]["odprawa_id"] for t in lista if meta[t.item_id]["odprawa_id"])
        odprawa_lotu[lot["id"]] = odprawy.most_common(1)[0][0] if odprawy else None
    faktury = await _faktury_zapisanych(db, loty, towar_lotu, odprawa_lotu)

    wynik: List[OdprawaLotOut] = []
    for lot in loty:
        lista = towar_lotu[lot["id"]]
        firmy = Counter(meta[t.item_id]["firma"] for t in lista)
        oid = odprawa_lotu[lot["id"]]
        fv = faktury.get(lot["id"])
        wynik.append(OdprawaLotOut(
            lot_id=lot["id"], container_id=container_id, dostawca=lot.get("dostawca"),
            zamowienie=lot.get("order_number"), mrn=lot.get("mrn"),
            firma=firmy.most_common(1)[0][0] if firmy else None,
            sku=sorted({t.sku for t in lista}), sztuk=sum(t.ilosc for t in lista),
            wybrany=oid == odprawa_id, blokada=oid is not None and oid != odprawa_id,
            powod=("Rozliczony tą odprawą." if oid == odprawa_id
                   else f"Rozliczony odprawą {mrn.get(oid, oid)}." if oid
                   else "Czeka na zgłoszenie."),
            faktura=fv[0] if fv else None, dopasowanie=fv[1] if fv else None,
            odprawa_id=oid, odprawa_mrn=mrn.get(oid) if oid else None,
        ))
    return wynik


async def _faktury_zapisanych(
    db: AsyncSession,
    loty: Sequence[Dict[str, Any]],
    towar_lotu: Dict[int, List[PozycjaTowaru]],
    odprawa_lotu: Dict[int, Optional[int]],
) -> Dict[int, "tuple[str, str]"]:
    """Faktura z SAD dla lotów już rozliczonych — z pozycji zapisanej odprawy.

    Pliku SAD po zapisie nie mamy, ale każda pozycja trzyma swoje faktury (N935)
    i wartość, a to wystarcza _faktury_lotow: najpierw numer zamówienia, potem wartość.
    Loty dopasowujemy w obrębie ich własnej odprawy, więc lot Veluxy dostaje fakturę
    z odprawy Veluxy, nawet gdy oglądamy odprawę Acti.
    """
    oids = sorted({o for o in odprawa_lotu.values() if o})
    if not oids:
        return {}
    kursy = {r["id"]: float(r["kurs_celny"] or 0) or 1.0 for r in (await db.execute(
        text("SELECT id, kurs_celny FROM app_odprawy WHERE id = ANY(:ids)"), {"ids": oids},
    )).mappings().all()}
    pozycje: Dict[int, List[SimpleNamespace]] = {}
    for r in (await db.execute(
        text("SELECT odprawa_id, wartosc, faktury FROM app_odprawa_pozycje "
             "WHERE odprawa_id = ANY(:ids) ORDER BY odprawa_id, nr"), {"ids": oids},
    )).mappings().all():
        pozycje.setdefault(r["odprawa_id"], []).append(SimpleNamespace(
            wartosc=float(r["wartosc"] or 0),
            faktury_dostawcy=[f.strip() for f in (r["faktury"] or "").split(",") if f.strip()],
        ))
    wynik: Dict[int, "tuple[str, str]"] = {}
    for oid in oids:
        poz = pozycje.get(oid, [])
        faktury_odprawy = list(dict.fromkeys(f for p in poz for f in p.faktury_dostawcy))
        if not faktury_odprawy:
            continue
        odprawa = SimpleNamespace(faktury_dostawcy=faktury_odprawy, pozycje=poz, kurs_celny=kursy.get(oid, 1.0))
        jej = [l for l in loty if odprawa_lotu.get(l["id"]) == oid]
        wynik.update(_faktury_lotow(odprawa, jej, towar_lotu))  # type: ignore[arg-type]
    return wynik


@router.post("/odprawy/{odprawa_id}/kurs-towaru")
async def przelicz_kurs_towaru(
    odprawa_id: int,
    body: KursTowaruIn,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_sad),
):
    """Przelicza ZAPISANĄ odprawę po innym kursie towaru — bez ponownego wgrywania XML.

    W rachunku (services/odprawy.py) kurs towaru mnoży wyłącznie wartość towaru:
    cło rozkłada się po proporcji towaru w pozycji, logistyka i gratisy po kluczu albo
    po proporcji wartości — a te proporcje przy jednym kursie dla całej odprawy się nie
    zmieniają. Dlatego wystarczy: cena PLN = cena w walucie × kurs, a koszt sztuki
    = (towar + logistyka + cło + gratisy + transport) / szt, jak w PozycjaWynik.
    Bez kursu w body bierzemy kurs z dni zapłaty zaliczek i balance.
    """
    odp = (await db.execute(text("SELECT id, mrn, kurs_towaru FROM app_odprawy WHERE id = :id"),
                            {"id": odprawa_id})).mappings().first()
    if not odp:
        raise HTTPException(404, "Nie ma takiej odprawy")
    itemy = (await db.execute(text(f"""
        SELECT id, container_id, quantity, cena_zakupu_waluta, koszt_logistyka_pln, koszt_clo_pln,
               koszt_gratisy_pln, koszt_transport_pln
          FROM {settings.TABLE_CONTAINER_ITEMS} WHERE koszt_odprawa_id = :id
    """), {"id": odprawa_id})).mappings().all()
    if not itemy:
        raise HTTPException(409, "Odprawa nie ma rozliczonych pozycji")
    kurs = body.kurs
    if not kurs:
        kurs, _ = await _kurs_z_platnosci(db, [i["container_id"] for i in itemy], [i["id"] for i in itemy])
    if not kurs:
        raise HTTPException(409, "Brak kursu z płatności — kontener nie ma zaliczek ani balance w walucie")
    for i in itemy:
        zakup, koszt = przelicz_po_kursie(
            _kwota(i["cena_zakupu_waluta"]), int(i["quantity"] or 0), _kwota(i["koszt_logistyka_pln"]),
            _kwota(i["koszt_clo_pln"]), _kwota(i["koszt_gratisy_pln"]), _kwota(i["koszt_transport_pln"]), kurs)
        await db.execute(text(f"""
            UPDATE {settings.TABLE_CONTAINER_ITEMS}
               SET cena_zakupu_pln = :zakup, koszt_jednostkowy = :koszt, koszt_updated_at = :teraz
             WHERE id = :id
        """), {"zakup": zakup, "koszt": koszt, "teraz": datetime.now(timezone.utc), "id": i["id"]})
    await db.execute(text("UPDATE app_odprawy SET kurs_towaru = :k, updated_at = :teraz WHERE id = :id"),
                     {"k": kurs, "teraz": datetime.now(timezone.utc), "id": odprawa_id})
    await db.commit()
    bylo = _kwota(odp["kurs_towaru"])
    audit.note(f"przeliczył odprawę MRN {odp['mrn']} po kursie towaru {f_num('', 4)(kurs)}"
               + (f" (było {f_num('', 4)(bylo)})" if bylo else ""),
               changes=[{"pole": "Kurs towaru", "bylo": f_num("", 4)(bylo) if bylo else "—", "jest": f_num("", 4)(kurs)}],
               resource_id=odprawa_id)
    return {"kurs": kurs, "pozycji": len(itemy)}


@router.post("/odprawy/{odprawa_id}/ceny-na-kontener")
async def ceny_na_kontener(
    odprawa_id: int,
    container_id: int = Query(...),
    nadpisz: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_sad),
):
    """Przepisuje cenę / szt w walucie z zapisanej odprawy na pozycje kontenera (pole „cena
    w walucie” — to samo, w które wpisuje się cenę z proformy), żeby nie przepisywać FV drugi raz.
    Z niego bierze ją koszt jednostkowy (metoda szefa).

    Pomijamy: pozycje bez ceny z SAD; ceny SZACOWANE (pozycja SAD z kilkoma SKU, cena rozdzielona
    proporcją, a nie wpisana ręcznie — to nie jest cena z faktury); pozycje, których lot/kontener
    płaci w innej walucie niż odprawa; oraz — bez `nadpisz` — pozycje, które mają już INNĄ cenę.
    Zwraca podsumowanie, żeby ekran mógł zapytać o nadpisanie.
    """
    odp = (await db.execute(text("SELECT id, mrn, waluta FROM app_odprawy WHERE id = :id"),
                            {"id": odprawa_id})).mappings().first()
    if not odp:
        raise HTTPException(404, "Nie ma takiej odprawy")
    wal_odprawy = (odp["waluta"] or "").strip().upper()
    wszystkie = (await db.execute(text(f"""
        SELECT ci.id, ci.container_id, ci.sku, ci.cena_zakupu_waluta, ci.cena_waluta, ci.cena_reczna,
               ci.odprawa_poz_nr,
               UPPER(COALESCE(NULLIF(TRIM(CASE WHEN c.is_consolidated THEN l.balance_waluta ELSE c.balance_waluta END), ''),
                              NULLIF(TRIM(CASE WHEN c.is_consolidated THEN l.waluta_towaru ELSE c.waluta_towaru END), ''),
                              'USD')) AS waluta
          FROM {settings.TABLE_CONTAINER_ITEMS} ci
          JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
          LEFT JOIN {settings.TABLE_CONTAINER_LOTS} l ON l.id = ci.lot_id
         WHERE ci.koszt_odprawa_id = :id
    """), {"id": odprawa_id})).mappings().all()
    if not any(i["container_id"] == container_id for i in wszystkie):
        raise HTTPException(409, "Ta odprawa nie ma rozliczonych pozycji tego kontenera")
    do_wpisania, wynik = ceny_z_sad_na_kontener([dict(i) for i in wszystkie], container_id, wal_odprawy, nadpisz)
    zmiany: List[dict] = []
    for item_id, sku, bylo, jest in do_wpisania:
        await db.execute(text(f"UPDATE {settings.TABLE_CONTAINER_ITEMS} SET cena_waluta = :c WHERE id = :id"),
                         {"c": jest, "id": item_id})
        zmiany.append({"pole": f"{sku}: cena {wal_odprawy} / szt".strip(),
                       "bylo": f_num("", 4)(bylo) if bylo is not None else "—", "jest": f_num("", 4)(jest)})
    await db.commit()
    if zmiany:
        audit.note_zmiany(f"kontenera {await audit.nazwa_kontenera(db, container_id)} (ceny z SAD, MRN {odp['mrn']})",
                          zmiany, resource_type="container", resource_id=container_id)
    else:
        audit.skip()
    return wynik


@router.delete("/odprawy/{odprawa_id}", status_code=204)
async def usun(
    odprawa_id: int,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_sad),
):
    """Cofa rozliczenie: zdejmuje koszt z pozycji i kasuje odprawę.

    Pola dopisane na kontenerze (MRN, koszty spedycji) ZOSTAJĄ — mogły zostać w międzyczasie
    poprawione ręcznie, a zerowanie ich przy cofaniu rachunku byłoby niespodzianką.
    """
    mrn = (await db.execute(text("SELECT mrn FROM app_odprawy WHERE id = :id"), {"id": odprawa_id})).scalar()
    zdjete = await db.execute(
        text(f"""
            UPDATE {settings.TABLE_CONTAINER_ITEMS}
               SET koszt_jednostkowy = NULL, cena_zakupu_pln = NULL, cena_reczna = FALSE,
                   koszt_odprawa_id = NULL, koszt_zrodlo = NULL, koszt_updated_at = NULL
             WHERE koszt_odprawa_id = :id
        """),
        {"id": odprawa_id},
    )
    res = await db.execute(text("DELETE FROM app_odprawy WHERE id = :id"), {"id": odprawa_id})
    await db.commit()
    if res.rowcount == 0:
        raise HTTPException(404, "Nie ma takiej odprawy")
    n = zdjete.rowcount or 0
    audit.note(f"cofnął odprawę MRN {mrn or '#' + str(odprawa_id)} — koszt zdjęty z {n} "
               f"{plural(n, 'pozycji', 'pozycji', 'pozycji')}", resource_id=odprawa_id)


# ============================================================
# Zapis
# ============================================================

def _ustawienia(surowe: Optional[str]) -> OdprawaUstawieniaIn:
    """Ustawienia lecą jako pole formularza (bo obok jedzie plik), więc są tekstem JSON."""
    if not surowe:
        return OdprawaUstawieniaIn()
    try:
        return OdprawaUstawieniaIn(**json.loads(surowe))
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"Nieczytelne ustawienia rachunku: {e}") from e


async def _zapisz_wszystko(
    db: AsyncSession,
    odprawa: Odprawa,
    rachunek: Rachunek,
    kontenery: List[Dict[str, Any]],
    towar: List[PozycjaTowaru],
    out: OdprawaOut,
    ust: OdprawaUstawieniaIn,
    *,
    nazwa_pliku: str,
    user_id: Optional[int],
) -> OdprawaZapisOut:
    teraz = datetime.now(timezone.utc)
    przypisanie_zapisu = rachunek.przypisanie
    firma_id = None
    if out.firma_slug:
        row = (await db.execute(
            text(f"SELECT id FROM {settings.TABLE_FIRMY} WHERE LOWER(slug) = :s"),
            {"s": out.firma_slug.lower()},
        )).first()
        firma_id = row[0] if row else None

    odprawa_id = (await db.execute(
        text("""
            INSERT INTO app_odprawy
                (mrn, firma_id, nip_importera, importer, dostawca, incoterms, data_zgloszenia,
                 waluta, kurs_celny, wartosc_faktur, masa_brutto, clo_suma, vat_suma,
                 klucz_podzialu, kurs_towaru, kurs_kosztow, fv_spedytora, fv_spedytora_data,
                 plik_nazwa, wczytal_user_id, wczytano_at, status, updated_at)
            VALUES (:mrn, :firma, :nip, :importer, :dostawca, :inco, :data,
                    :waluta, :kurs, :wartosc, :masa, :clo, :vat,
                    :klucz, :fxt, :fxk, :fv, :fv_data,
                    :plik, CAST(:uid AS INTEGER), :teraz, 'zapisana', :teraz)
            ON CONFLICT (mrn) DO UPDATE SET
                firma_id = EXCLUDED.firma_id, importer = EXCLUDED.importer,
                dostawca = EXCLUDED.dostawca, incoterms = EXCLUDED.incoterms,
                data_zgloszenia = EXCLUDED.data_zgloszenia, waluta = EXCLUDED.waluta,
                kurs_celny = EXCLUDED.kurs_celny, wartosc_faktur = EXCLUDED.wartosc_faktur,
                masa_brutto = EXCLUDED.masa_brutto, clo_suma = EXCLUDED.clo_suma,
                vat_suma = EXCLUDED.vat_suma, klucz_podzialu = EXCLUDED.klucz_podzialu,
                kurs_towaru = EXCLUDED.kurs_towaru, kurs_kosztow = EXCLUDED.kurs_kosztow,
                fv_spedytora = EXCLUDED.fv_spedytora, fv_spedytora_data = EXCLUDED.fv_spedytora_data,
                plik_nazwa = EXCLUDED.plik_nazwa, wczytal_user_id = EXCLUDED.wczytal_user_id,
                wczytano_at = EXCLUDED.wczytano_at, status = 'zapisana', updated_at = EXCLUDED.updated_at
            RETURNING id
        """),
        {
            "mrn": odprawa.mrn, "firma": firma_id, "nip": odprawa.nip_importera,
            "importer": odprawa.importer, "dostawca": odprawa.dostawca,
            "inco": odprawa.incoterms, "data": odprawa.data_zgloszenia,
            "waluta": odprawa.waluta, "kurs": odprawa.kurs_celny,
            "wartosc": odprawa.wartosc_faktur, "masa": odprawa.masa_brutto,
            "clo": odprawa.clo_suma, "vat": odprawa.vat_suma,
            "klucz": out.klucz_podzialu,
            "fxt": ust.kurs_towaru or out.kurs_platnosci or odprawa.kurs_celny,
            "fxk": ust.kurs_kosztow or odprawa.kurs_kosztow,
            "fv": ust.fv_spedytora, "fv_data": ust.fv_spedytora_data,
            "plik": nazwa_pliku, "uid": user_id, "teraz": teraz,
        },
    )).scalar_one()

    # Udział kontenerów w kosztach tej odprawy — po wadze jej towaru w każdym z nich.
    # Liczony przed zapisem, bo trafia do app_odprawa_kontenery: karta kontenera dostaje
    # SUMĘ udziałów ze wszystkich jego odpraw (konsolidacja = kilka zgłoszeń na kontener).
    fracht = next((float(l.kwota or 0) for l in out.koszty if l.lp == 1), 0.0)
    # Karta kontenera trzyma rachunek SPEDYTORA. Załadunek 033W płacimy dostawcy,
    # więc do kosztu towaru wchodzi, ale do „kosztu spedycji" na karcie już nie.
    razem_fv = sum(float(l.kwota or 0) for l in out.koszty if l.container_id is None and l.lp != LP_ZALADUNEK)
    masy = {k["id"]: sum((t.waga_brutto_kg or 0) * t.ilosc for t in towar if t.container_id == k["id"])
            for k in kontenery}
    masa_razem = sum(masy.values())
    udzial_k = {k["id"]: ((masy[k["id"]] / masa_razem) if masa_razem else (1.0 / max(1, len(kontenery))))
                for k in kontenery}

    async def sumy_kart() -> Dict[int, "tuple[float, float]"]:
        rows = (await db.execute(
            text("SELECT container_id, COALESCE(SUM(fracht), 0), COALESCE(SUM(spedycja), 0) "
                 "  FROM app_odprawa_kontenery WHERE container_id = ANY(:ids) GROUP BY container_id"),
            {"ids": [k["id"] for k in kontenery]},
        )).all()
        return {r[0]: (float(r[1]), float(r[2])) for r in rows}

    sumy_przed = await sumy_kart()

    # Pozycje, kontenery i koszty przepisujemy w całości — ponowny import ma dać
    # dokładnie to, co jest w pliku, bez resztek po poprzednim odczycie.
    for tab in ("app_odprawa_pozycje", "app_odprawa_koszty", "app_odprawa_kontenery"):
        await db.execute(text(f"DELETE FROM {tab} WHERE odprawa_id = :id"), {"id": odprawa_id})

    po_numerze = {(k["container_number"] or "").strip().upper(): k["id"] for k in kontenery}
    for numer in odprawa.kontenery:
        cid = po_numerze.get(numer)
        u = udzial_k.get(cid, 0.0) if cid else 0.0
        await db.execute(
            text("INSERT INTO app_odprawa_kontenery (odprawa_id, numer, container_id, fracht, spedycja) "
                 "VALUES (:id, :numer, CAST(:cid AS INTEGER), :fr, :sp)"),
            {"id": odprawa_id, "numer": numer, "cid": cid,
             "fr": round(fracht * u, 2) if cid else None, "sp": round(razem_fv * u, 2) if cid else None},
        )

    for p in odprawa.pozycje:
        await db.execute(
            text("""
                INSERT INTO app_odprawa_pozycje
                    (odprawa_id, nr, kod_cn, opis, wartosc, masa_brutto, masa_netto,
                     wartosc_celna_pln, clo_stawka, clo_pln, clo_wyliczone, vat_stawka, vat_pln,
                     vat_metoda, liczba_opakowan, szt_uzup, doliczenia, gratis_item_id, faktury)
                VALUES (:id, :nr, :cn, :opis, :wartosc, :mb, :mn, :wc, :cs, :cp, :cw, :vs, :vp,
                        :vm, CAST(:opak AS INTEGER), :szt, CAST(:dol AS JSONB), CAST(:gratis AS INTEGER),
                        :faktury)
            """),
            {
                "id": odprawa_id, "nr": p.nr, "cn": p.kod_cn or None, "opis": p.opis,
                "wartosc": p.wartosc, "mb": p.masa_brutto, "mn": p.masa_netto,
                "wc": p.wartosc_celna_pln, "cs": p.clo_stawka, "cp": p.clo_pln,
                "cw": p.clo_wyliczone, "vs": p.vat_stawka, "vp": p.vat_pln, "vm": p.vat_metoda,
                "opak": p.liczba_opakowan, "szt": p.szt_uzup,
                "dol": json.dumps(p.doliczenia), "gratis": rachunek.gratisy.get(p.nr) or None,  # 0 = rozłożone
                "faktury": ", ".join(p.faktury_dostawcy) or None,
            },
        )

    # Słownik stawek cła (Ustawienia → Stawki cła): dla kodów z tego zgłoszenia stawka
    # z NAJNOWSZEGO zgłoszenia, w którym kod wystąpił — ponowne wczytanie starego SAD-u
    # nie cofa nowszej stawki. Stawki wpisanej ręcznie SAD nie nadpisuje.
    kody = sorted({p.kod_cn for p in odprawa.pozycje if p.kod_cn})
    if kody:
        await db.execute(text("""
            INSERT INTO app_stawki_cn (kod_cn, stawka, zrodlo, zmienil, updated_at)
            SELECT DISTINCT ON (p.kod_cn) p.kod_cn, p.clo_stawka, 'sad', 'SAD ' || COALESCE(o.mrn, ''), NOW()
              FROM app_odprawa_pozycje p
              JOIN app_odprawy o ON o.id = p.odprawa_id
             WHERE p.kod_cn = ANY(:kody) AND p.clo_stawka IS NOT NULL
             ORDER BY p.kod_cn, o.data_zgloszenia DESC NULLS LAST, o.id DESC
            ON CONFLICT (kod_cn) DO UPDATE
               SET stawka = EXCLUDED.stawka, zmienil = EXCLUDED.zmienil, updated_at = NOW()
             WHERE app_stawki_cn.zrodlo = 'sad'
        """), {"kody": kody})

    z_sad = {1: "031W", 2: "071V", 4: "032W", LP_ZALADUNEK: "033W"}
    dolicz = {d.kod: (d.kwota_waluta if d.waluta == odprawa.waluta_kosztow else d.kwota)
              for d in odprawa.doliczenia}

    def zrodlo(l) -> str:
        if l.container_id:
            return "kontener"
        kod = z_sad.get(l.lp or 0)
        if kod and abs(float(l.kwota or 0) - dolicz.get(kod, 0)) < 0.01:
            return "sad"
        return "fv" if l.kwota else "reczne"

    for l in out.koszty:
        await db.execute(
            text("""
                INSERT INTO app_odprawa_koszty (odprawa_id, lp, nazwa, kwota, waluta, klucz, zrodlo, container_id)
                VALUES (:id, CAST(:lp AS SMALLINT), :nazwa, :kwota, :waluta, :klucz, :zrodlo,
                        CAST(:cid AS INTEGER))
            """),
            {
                "id": odprawa_id, "lp": l.lp, "nazwa": l.nazwa, "kwota": float(l.kwota or 0),
                "waluta": l.waluta, "klucz": l.klucz,
                "zrodlo": zrodlo(l),
                "cid": l.container_id,
            },
        )

    # ── Pozycje, które wypadły z tej odprawy ─────────────────────────────────
    # Ponowny zapis z odznaczonym lotem nie może zostawić na jego towarze kosztu z tej
    # odprawy — inaczej lot wyglądałby na rozliczony, choć nikt go już nie liczy.
    await db.execute(
        text(f"""
            UPDATE {settings.TABLE_CONTAINER_ITEMS}
               SET koszt_jednostkowy = NULL, cena_zakupu_pln = NULL, cena_zakupu_waluta = NULL,
                   cena_reczna = FALSE, koszt_logistyka_pln = NULL, koszt_clo_pln = NULL,
                   koszt_gratisy_pln = NULL, koszt_transport_pln = NULL, odprawa_poz_nr = NULL,
                   koszt_odprawa_id = NULL, koszt_zrodlo = NULL, koszt_updated_at = NULL
             WHERE koszt_odprawa_id = :oid AND NOT (id = ANY(:ids))
        """),
        {"oid": odprawa_id, "ids": [w.item_id for w in rachunek.pozycje] or [0]},
    )

    # ── Koszt na pozycjach kontenera ─────────────────────────────────────────
    # Zapisujemy CAŁE rozbicie, nie tylko wynik. Odczyt zapisanej odprawy ma pokazać
    # dokładnie to, co zatwierdzono — odtwarzanie rachunku przy każdym wejściu dałoby
    # inne liczby, gdy ceny planowane albo wagi produktów zmienią się później.
    for w in rachunek.pozycje:
        await db.execute(
            text(f"""
                UPDATE {settings.TABLE_CONTAINER_ITEMS}
                   SET cena_zakupu_pln = :zakup, cena_zakupu_waluta = :zakup_wal,
                       cena_reczna = :reczna, koszt_jednostkowy = :koszt,
                       koszt_logistyka_pln = :log, koszt_clo_pln = :clo,
                       koszt_gratisy_pln = :gratis, koszt_transport_pln = :transport,
                       odprawa_poz_nr = CAST(:poz AS SMALLINT),
                       koszt_odprawa_id = :oid, koszt_zrodlo = 'odprawa', koszt_updated_at = :teraz
                 WHERE id = :item
            """),
            {
                "zakup": round(w.towar / w.ilosc, 2) if w.ilosc else 0,
                "zakup_wal": round(w.cena_zakupu_waluta, 4), "reczna": w.reczna,
                "koszt": w.koszt_jednostkowy,
                "log": round(w.logistyka, 2), "clo": round(w.clo, 2),
                "gratis": round(w.gratisy, 2), "transport": round(w.transport_krajowy, 2),
                "poz": przypisanie_zapisu.get(w.item_id),
                "oid": odprawa_id, "teraz": teraz, "item": w.item_id,
            },
        )

    # ── Dopisanie wartości na kartę kontenera ────────────────────────────────
    # Fracht i spedycja na karcie = SUMA udziałów ze wszystkich odpraw kontenera. Pole
    # nadpisujemy tylko wtedy, gdy jest puste albo równe sumie sprzed tego zapisu — czyli
    # gdy wpisała je aplikacja. Kwoty wpisanej ręcznie nie ruszamy: cicha podmiana byłaby
    # najgorszą możliwą niespodzianką.
    sumy_po = await sumy_kart()
    mrn_uzupelniony: List[str] = []
    zaktualizowane: List[str] = []
    konsolidacja = bool(out.loty)

    def wolno(obecna, przed: float) -> bool:
        return not obecna or abs(float(obecna) - przed) < 0.01

    for k in kontenery:
        zmiany, params = [], {"cid": k["id"]}
        fr_przed, sp_przed = sumy_przed.get(k["id"], (0.0, 0.0))
        fr_po, sp_po = sumy_po.get(k["id"], (0.0, 0.0))
        if konsolidacja:
            # MRN na lotach, które objęło to zgłoszenie. Kontener skonsolidowany nie ma
            # jednego MRN — każdy lot może przyjść innym zgłoszeniem.
            loty_mrn = [l.lot_id for l in out.loty
                        if l.wybrany and not l.blokada and not l.mrn and l.container_id == k["id"]]
            if loty_mrn and odprawa.mrn:
                await db.execute(
                    text(f"UPDATE {settings.TABLE_CONTAINER_LOTS} SET mrn = :mrn "
                         f"WHERE id = ANY(:ids) AND COALESCE(TRIM(mrn), '') = ''"),
                    {"mrn": odprawa.mrn, "ids": loty_mrn},
                )
                mrn_uzupelniony.append(k["etykieta"])
        elif not k["mrn"] and odprawa.mrn:
            zmiany.append("mrn = :mrn")
            params["mrn"] = odprawa.mrn
            mrn_uzupelniony.append(k["etykieta"])
        if fr_po and wolno(k["koszt_transportu"], fr_przed) and abs(float(k["koszt_transportu"] or 0) - fr_po) >= 0.01:
            zmiany.append("koszt_transportu = :kt")
            params["kt"] = round(fr_po, 2)
        if sp_po and wolno(k["koszt_spedycji"], sp_przed) and abs(float(k["koszt_spedycji"] or 0) - sp_po) >= 0.01:
            zmiany.append("koszt_spedycji = :ks")
            params["ks"] = round(sp_po, 2)
        tk = next((float(l.kwota or 0) for l in out.koszty if l.container_id == k["id"]), 0.0)
        if not k["koszt_transportu_magazyn"] and tk:
            zmiany.append("koszt_transportu_magazyn = :tk")
            params["tk"] = tk
        if zmiany:
            await db.execute(
                text(f"UPDATE {settings.TABLE_CONTAINERS} SET {', '.join(zmiany)} WHERE id = :cid"),
                params,
            )
            zaktualizowane.append(k["etykieta"])

    # ── Waga i kod CN do karty produktu ──────────────────────────────────────
    # Tylko tam, gdzie pole jest puste. Waga ma sens wyłącznie, gdy pozycja SAD ma
    # jedno SKU — przy pozycji mieszanej nie wiadomo, ile z niej waży które SKU.
    wg_pozycji: Dict[int, List[PozycjaTowaru]] = {}
    for t in towar:
        wg_pozycji.setdefault(rachunek.przypisanie.get(t.item_id, -1), []).append(t)
    waga_zapisana, cn_zapisany = [], []
    for p in odprawa.pozycje:
        lista = wg_pozycji.get(p.nr, [])
        sku_w_pozycji = {t.sku for t in lista}
        for t in lista:
            if p.kod_cn and not t.kod_cn:
                await db.execute(
                    text(f"UPDATE {settings.TABLE_PRODUCT_ATTRS} SET kod_cn = :cn, "
                         f"updated_at = CURRENT_TIMESTAMP "
                         f"WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku)) AND kod_cn IS NULL"),
                    {"cn": p.kod_cn, "sku": t.sku},
                )
                cn_zapisany.append(t.sku)
            if len(sku_w_pozycji) == 1 and t.waga_brutto_kg is None and p.masa_brutto and t.ilosc:
                await db.execute(
                    text(f"UPDATE {settings.TABLE_PRODUCT_ATTRS} SET waga_brutto_kg = :w, "
                         f"updated_at = CURRENT_TIMESTAMP "
                         f"WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku)) AND waga_brutto_kg IS NULL"),
                    {"w": round(p.masa_brutto / t.ilosc, 3), "sku": t.sku},
                )
                waga_zapisana.append(t.sku)

    await db.commit()
    return OdprawaZapisOut(
        odprawa_id=odprawa_id,
        pozycji_z_kosztem=len(rachunek.pozycje),
        mrn_uzupelniony=mrn_uzupelniony,
        kontenery_zaktualizowane=zaktualizowane,
        produkty_waga=sorted(set(waga_zapisana)),
        produkty_kod_cn=sorted(set(cn_zapisany)),
    )
