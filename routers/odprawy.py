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

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import (
    CurrentUser, OdprawaKontrolaOut, OdprawaLiniaKosztuIn, OdprawaOut,
    OdprawaPozycjaOut, OdprawaTowarOut, OdprawaUstawieniaIn, OdprawaUwagaOut,
    OdprawaZapisOut,
)
from security import require_landed_cost_edit, require_landed_cost_view
from services.odprawy import (
    KLUCZ_CBM, KLUCZ_WAGA, LiniaKosztu, PozycjaTowaru, Rachunek, Uwaga, policz,
)
from services.products import compute_effective_cbm
from services.sad import BladSAD, Odprawa, kontrole, parsuj

router = APIRouter(prefix="/api", tags=["odprawy"])

MAX_XML = 8 * 1024 * 1024   # zgłoszenie z 7 pozycjami waży 36 kB; 8 MB to zapas z nawiązką


# ============================================================
# Odczyt kontekstu z bazy
# ============================================================

async def _kontener(db: AsyncSession, container_id: int) -> Dict[str, Any]:
    row = (await db.execute(
        text(f"""
            SELECT c.id, c.container_number, c.mrn, c.koszt_transportu, c.koszt_spedycji,
                   c.koszt_transportu_magazyn
              FROM {settings.TABLE_CONTAINERS} c
             WHERE c.id = :id
        """),
        {"id": container_id},
    )).mappings().first()
    if not row:
        raise HTTPException(404, "Nie ma takiego kontenera")
    return dict(row)


async def _kontenery_odprawy(db: AsyncSession, numery: Sequence[str]) -> List[Dict[str, Any]]:
    """Kontenery z aplikacji odpowiadające numerom ze zgłoszenia.

    Numer porównujemy po UPPER(TRIM(…)) — tak samo robi to routers/containers.py,
    bo w bazie zdarzają się spacje na końcu.
    """
    if not numery:
        return []
    rows = (await db.execute(
        text(f"""
            SELECT id, container_number, mrn, koszt_transportu, koszt_spedycji,
                   koszt_transportu_magazyn
              FROM {settings.TABLE_CONTAINERS}
             WHERE UPPER(TRIM(container_number)) = ANY(:numery)
             ORDER BY id
        """),
        {"numery": [n.strip().upper() for n in numery]},
    )).mappings().all()
    return [dict(r) for r in rows]


async def _towar(db: AsyncSession, container_ids: Sequence[int]) -> List[PozycjaTowaru]:
    """Pozycje kontenerów wzbogacone o wagę, CBM i kod CN z karty produktu.

    CBM liczymy tą samą funkcją co karta produktu i wypełnienie kontenera
    (compute_effective_cbm), żeby w trzech miejscach nie wyszły trzy różne liczby.
    """
    if not container_ids:
        return []
    rows = (await db.execute(
        text(f"""
            SELECT ci.id AS item_id, ci.container_id, ci.sku, ci.quantity, ci.unit_cost,
                   pa.waga_brutto_kg, pa.kod_cn,
                   COALESCE(pa.cbm_per_unit, 0) AS cbm_per_unit,
                   pa.dlugosc_cm, pa.szerokosc_cm, pa.wysokosc_cm, pa.szt_w_kartonie
              FROM {settings.TABLE_CONTAINER_ITEMS} ci
              LEFT JOIN {settings.TABLE_PRODUCT_ATTRS} pa
                     ON LOWER(TRIM(pa.sku)) = LOWER(TRIM(ci.sku))
             WHERE ci.container_id = ANY(:ids)
             ORDER BY ci.container_id, ci.id
        """),
        {"ids": list(container_ids)},
    )).mappings().all()

    towar: List[PozycjaTowaru] = []
    for r in rows:
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
        ))
    return towar


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

def _linie_kosztow(odprawa: Odprawa, ustawienia: OdprawaUstawieniaIn,
                   kontenery: Sequence[Dict[str, Any]]) -> List[OdprawaLiniaKosztuIn]:
    """Domyślny zestaw linii: fracht, THC i ubezpieczenie z doliczeń SAD, reszta pusta.

    Gdy front przysyła własne linie (bo użytkownik przepisał fakturę spedytora),
    biorą one pierwszeństwo w całości — nie doklejamy do nich niczego.
    """
    if ustawienia.koszty:
        return list(ustawienia.koszty)

    d = {x.kod: x.kwota for x in odprawa.doliczenia}
    linie = [
        OdprawaLiniaKosztuIn(lp=1, nazwa="Fracht morski", kwota=d.get("031W", 0), waluta=odprawa.waluta),
        OdprawaLiniaKosztuIn(lp=2, nazwa="THC", kwota=d.get("071V", 0), waluta=odprawa.waluta),
        OdprawaLiniaKosztuIn(lp=3, nazwa="Opłata dokumentacyjna", kwota=0, waluta=odprawa.waluta),
        OdprawaLiniaKosztuIn(lp=4, nazwa="Ubezpieczenie cargo", kwota=d.get("032W", 0),
                             waluta=odprawa.waluta, klucz="wartosc"),
        OdprawaLiniaKosztuIn(lp=5, nazwa="Zgłoszenie do odprawy celnej", kwota=0, waluta=odprawa.waluta),
    ]
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
    if numer not in odprawa.kontenery:
        raise HTTPException(400, (
            f"Ten SAD dotyczy kontenerów {', '.join(odprawa.kontenery) or '(brak numerów)'}, "
            f"a otwarty jest {numer}. Otwórz właściwy kontener albo wrzuć inny plik."
        ))

    firma_sad = await _firma_po_nip(db, odprawa.nip_importera)
    firma_kont = await _firma_kontenera(db, container_id)
    if firma_sad and firma_kont and firma_sad["slug"].lower() != firma_kont:
        raise HTTPException(400, (
            f"Importerem w SAD jest {firma_sad['name']} (NIP {odprawa.nip_importera}), "
            f"a towar w kontenerze należy do firmy {firma_kont.upper()}."
        ))

    kontenery = await _kontenery_odprawy(db, odprawa.kontenery)
    for k in kontenery:
        if k["mrn"] and odprawa.mrn and k["mrn"].strip().upper() != odprawa.mrn.strip().upper():
            raise HTTPException(400, (
                f"Kontener {k['container_number']} ma już MRN {k['mrn']}, a plik niesie {odprawa.mrn}. "
                "Popraw numer na kontenerze albo wrzuć właściwe zgłoszenie."
            ))

    towar = await _towar(db, [k["id"] for k in kontenery])
    linie = _linie_kosztow(odprawa, ustawienia, kontenery)
    klucz = KLUCZ_CBM if ustawienia.klucz_podzialu == KLUCZ_CBM else KLUCZ_WAGA

    rachunek = policz(
        odprawa, towar, _na_serwis(linie),
        przypisanie=ustawienia.przypisanie or None,
        gratisy=ustawienia.gratisy or None,
        klucz=klucz,
        kurs_towaru=ustawienia.kurs_towaru,
        kurs_kosztow=ustawienia.kurs_kosztow,
        ceny_reczne=ustawienia.ceny_reczne or None,
    )

    uwagi = list(rachunek.uwagi)
    brakujace = [n for n in odprawa.kontenery
                 if n not in {(k["container_number"] or "").strip().upper() for k in kontenery}]
    if brakujace:
        uwagi.append(Uwaga("blad", "Kontener ze zgłoszenia nie istnieje w aplikacji", ", ".join(brakujace)))
    if len(kontenery) > 1:
        uwagi.append(Uwaga("info", "Odprawa obejmuje kilka kontenerów — koszt liczony łącznie",
                           ", ".join(k["container_number"] for k in kontenery)))
    for k in kontenery:
        if not k["mrn"]:
            uwagi.append(Uwaga("info", f"{k['container_number']}: MRN uzupełni się przy zapisie",
                               odprawa.mrn or ""))
    if odprawa.faktury_dostawcy:
        uwagi.append(Uwaga("info", "Faktury dostawcy w zgłoszeniu", ", ".join(odprawa.faktury_dostawcy)))
    if len(odprawa.kursy) > 1:
        uwagi.append(Uwaga("info", "W pliku jest kilka kursów — użyty kurs waluty zgłoszenia",
                           f"{odprawa.waluta} {odprawa.kurs_celny}"))

    istniejaca = (await db.execute(
        text(f"SELECT id, status FROM app_odprawy WHERE mrn = :mrn"), {"mrn": odprawa.mrn},
    )).mappings().first()

    kontr = kontrole(odprawa)
    zle_kontrole = [k for k in kontr if not k.ok]
    if zle_kontrole:
        uwagi.append(Uwaga("blad", "Liczby w zgłoszeniu nie spinają się ze sobą",
                           "; ".join(k.nazwa for k in zle_kontrole[:3])))

    po_nr = {p.nr: [] for p in odprawa.pozycje}
    for item_id, nr in rachunek.przypisanie.items():
        po_nr.setdefault(nr, []).append(item_id)
    nr_kontenera = {k["id"]: k["container_number"] for k in kontenery}

    out = OdprawaOut(
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
        kontenery=odprawa.kontenery,
        kontenery_w_aplikacji=[k["id"] for k in kontenery],
        doliczenia=[{"kod": d.kod, "kwota": d.kwota, "klucz": d.klucz,
                     "do_wartosci_celnej": d.do_wartosci_celnej} for d in odprawa.doliczenia],
        pozycje=[OdprawaPozycjaOut(
            nr=p.nr, kod_cn=p.kod_cn or None, opis=p.opis, wartosc=p.wartosc,
            masa_brutto=p.masa_brutto, clo_stawka=p.clo_stawka, clo_pln=p.clo_pln,
            vat_stawka=p.vat_stawka, vat_metoda=p.vat_metoda,
            liczba_opakowan=p.liczba_opakowan, szt_uzup=p.szt_uzup, kontenery=p.kontenery,
            item_ids=sorted(po_nr.get(p.nr, [])), gratis_item_id=rachunek.gratisy.get(p.nr),
        ) for p in odprawa.pozycje],
        towar=[OdprawaTowarOut(
            item_id=w.item_id, container_id=w.container_id,
            container_number=nr_kontenera.get(w.container_id, ""), sku=w.sku, ilosc=w.ilosc,
            cena_planowana=round(w.cena_planowana, 2), cena_zakupu_waluta=w.cena_zakupu_waluta,
            towar=round(w.towar, 2), logistyka=round(w.logistyka, 2), clo=round(w.clo, 2),
            gratisy=round(w.gratisy, 2), transport_krajowy=round(w.transport_krajowy, 2),
            koszt_jednostkowy=w.koszt_jednostkowy, zmiana_proc=w.zmiana_proc,
            szacunek=w.szacunek, poz_sad=rachunek.przypisanie.get(w.item_id),
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
    )
    return out, odprawa, rachunek, kontenery, towar


# ============================================================
# Endpointy
# ============================================================

@router.post("/kontenery/{container_id}/odprawa/podglad", response_model=OdprawaOut)
async def podglad(
    container_id: int,
    plik: UploadFile = File(...),
    ustawienia: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_landed_cost_edit),
):
    """Wczytuje zgłoszenie i pokazuje rachunek. NIC nie zapisuje."""
    tresc = await plik.read()
    if len(tresc) > MAX_XML:
        raise HTTPException(413, "Plik jest za duży jak na zgłoszenie celne (limit 8 MB).")
    out, *_ = await _zloz(db, container_id, tresc, _ustawienia(ustawienia))
    return out


@router.post("/kontenery/{container_id}/odprawa", response_model=OdprawaOut)
async def zapisz(
    container_id: int,
    plik: UploadFile = File(...),
    ustawienia: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_landed_cost_edit),
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

    out.zapis = await _zapisz_wszystko(
        db, odprawa, rachunek, kontenery, towar, out, ust,
        nazwa_pliku=plik.filename or "", user_id=getattr(user, "id", None),
    )
    out.status = "zapisana"
    return out


@router.get("/kontenery/{container_id}/odprawa", response_model=Optional[OdprawaOut])
async def pobierz(
    container_id: int,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_landed_cost_view),
):
    """Zapisana odprawa tego kontenera albo null, gdy jeszcze jej nie policzono."""
    row = (await db.execute(
        text("""
            SELECT o.* FROM app_odprawy o
              JOIN app_odprawa_kontenery ok ON ok.odprawa_id = o.id
             WHERE ok.container_id = :cid
             ORDER BY o.id DESC LIMIT 1
        """),
        {"cid": container_id},
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
        text("SELECT numer, container_id FROM app_odprawa_kontenery WHERE odprawa_id = :id ORDER BY numer"),
        {"id": row["id"]},
    )).mappings().all()
    itemy = (await db.execute(
        text(f"""
            SELECT ci.id AS item_id, ci.container_id, c.container_number, ci.sku, ci.quantity,
                   ci.unit_cost, ci.cena_zakupu_pln, ci.koszt_jednostkowy
              FROM {settings.TABLE_CONTAINER_ITEMS} ci
              JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
             WHERE ci.koszt_odprawa_id = :id
             ORDER BY ci.container_id, ci.sku
        """),
        {"id": row["id"]},
    )).mappings().all()

    return OdprawaOut(
        mrn=row["mrn"], data_zgloszenia=row["data_zgloszenia"], dostawca=row["dostawca"],
        importer=row["importer"], nip_importera=row["nip_importera"],
        incoterms=row["incoterms"], waluta=row["waluta"],
        kurs_celny=float(row["kurs_celny"] or 0),
        wartosc_faktur=float(row["wartosc_faktur"] or 0),
        masa_brutto=float(row["masa_brutto"] or 0),
        clo_suma=float(row["clo_suma"] or 0), vat_suma=float(row["vat_suma"] or 0),
        kontenery=[n["numer"] for n in numery],
        kontenery_w_aplikacji=[n["container_id"] for n in numery if n["container_id"]],
        pozycje=[OdprawaPozycjaOut(
            nr=p["nr"], kod_cn=p["kod_cn"], opis=p["opis"] or "",
            wartosc=float(p["wartosc"] or 0), masa_brutto=float(p["masa_brutto"] or 0),
            clo_stawka=float(p["clo_stawka"] or 0), clo_pln=float(p["clo_pln"] or 0),
            vat_stawka=float(p["vat_stawka"] or 0), vat_metoda=p["vat_metoda"],
            liczba_opakowan=p["liczba_opakowan"],
            szt_uzup=float(p["szt_uzup"]) if p["szt_uzup"] is not None else None,
            gratis_item_id=p["gratis_item_id"],
        ) for p in pozycje],
        towar=[OdprawaTowarOut(
            item_id=i["item_id"], container_id=i["container_id"],
            container_number=i["container_number"], sku=i["sku"], ilosc=int(i["quantity"] or 0),
            cena_planowana=float(i["unit_cost"] or 0),
            cena_zakupu_waluta=0.0,
            towar=float(i["cena_zakupu_pln"] or 0) * int(i["quantity"] or 0),
            logistyka=0.0, clo=0.0, gratisy=0.0, transport_krajowy=0.0,
            koszt_jednostkowy=float(i["koszt_jednostkowy"] or 0),
        ) for i in itemy],
        koszty=[OdprawaLiniaKosztuIn(
            lp=k["lp"], nazwa=k["nazwa"], kwota=float(k["kwota"] or 0), waluta=k["waluta"],
            klucz=k["klucz"], container_id=k["container_id"],
        ) for k in koszty],
        klucz_podzialu=row["klucz_podzialu"],
        status=row["status"],
    )


@router.delete("/odprawy/{odprawa_id}", status_code=204)
async def usun(
    odprawa_id: int,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_landed_cost_edit),
):
    """Cofa rozliczenie: zdejmuje koszt z pozycji i kasuje odprawę.

    Pola dopisane na kontenerze (MRN, koszty spedycji) ZOSTAJĄ — mogły zostać w międzyczasie
    poprawione ręcznie, a zerowanie ich przy cofaniu rachunku byłoby niespodzianką.
    """
    await db.execute(
        text(f"""
            UPDATE {settings.TABLE_CONTAINER_ITEMS}
               SET koszt_jednostkowy = NULL, cena_zakupu_pln = NULL,
                   koszt_odprawa_id = NULL, koszt_zrodlo = NULL, koszt_updated_at = NULL
             WHERE koszt_odprawa_id = :id
        """),
        {"id": odprawa_id},
    )
    res = await db.execute(text("DELETE FROM app_odprawy WHERE id = :id"), {"id": odprawa_id})
    await db.commit()
    if res.rowcount == 0:
        raise HTTPException(404, "Nie ma takiej odprawy")


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
            "fxt": ust.kurs_towaru or odprawa.kurs_celny,
            "fxk": ust.kurs_kosztow or odprawa.kurs_celny,
            "fv": ust.fv_spedytora, "fv_data": ust.fv_spedytora_data,
            "plik": nazwa_pliku, "uid": user_id, "teraz": teraz,
        },
    )).scalar_one()

    # Pozycje, kontenery i koszty przepisujemy w całości — ponowny import ma dać
    # dokładnie to, co jest w pliku, bez resztek po poprzednim odczycie.
    for tab in ("app_odprawa_pozycje", "app_odprawa_koszty", "app_odprawa_kontenery"):
        await db.execute(text(f"DELETE FROM {tab} WHERE odprawa_id = :id"), {"id": odprawa_id})

    po_numerze = {(k["container_number"] or "").strip().upper(): k["id"] for k in kontenery}
    for numer in odprawa.kontenery:
        await db.execute(
            text("INSERT INTO app_odprawa_kontenery (odprawa_id, numer, container_id) "
                 "VALUES (:id, :numer, CAST(:cid AS INTEGER))"),
            {"id": odprawa_id, "numer": numer, "cid": po_numerze.get(numer)},
        )

    for p in odprawa.pozycje:
        await db.execute(
            text("""
                INSERT INTO app_odprawa_pozycje
                    (odprawa_id, nr, kod_cn, opis, wartosc, masa_brutto, masa_netto,
                     wartosc_celna_pln, clo_stawka, clo_pln, clo_wyliczone, vat_stawka, vat_pln,
                     vat_metoda, liczba_opakowan, szt_uzup, doliczenia, gratis_item_id)
                VALUES (:id, :nr, :cn, :opis, :wartosc, :mb, :mn, :wc, :cs, :cp, :cw, :vs, :vp,
                        :vm, CAST(:opak AS INTEGER), :szt, CAST(:dol AS JSONB), CAST(:gratis AS INTEGER))
            """),
            {
                "id": odprawa_id, "nr": p.nr, "cn": p.kod_cn or None, "opis": p.opis,
                "wartosc": p.wartosc, "mb": p.masa_brutto, "mn": p.masa_netto,
                "wc": p.wartosc_celna_pln, "cs": p.clo_stawka, "cp": p.clo_pln,
                "cw": p.clo_wyliczone, "vs": p.vat_stawka, "vp": p.vat_pln, "vm": p.vat_metoda,
                "opak": p.liczba_opakowan, "szt": p.szt_uzup,
                "dol": json.dumps(p.doliczenia), "gratis": rachunek.gratisy.get(p.nr),
            },
        )

    z_sad = {1: "031W", 2: "071V", 4: "032W"}
    dolicz = {d.kod: d.kwota for d in odprawa.doliczenia}

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

    # ── Koszt na pozycjach kontenera ─────────────────────────────────────────
    for w in rachunek.pozycje:
        await db.execute(
            text(f"""
                UPDATE {settings.TABLE_CONTAINER_ITEMS}
                   SET cena_zakupu_pln = :zakup, koszt_jednostkowy = :koszt,
                       koszt_odprawa_id = :oid, koszt_zrodlo = 'odprawa', koszt_updated_at = :teraz
                 WHERE id = :item
            """),
            {
                "zakup": round(w.towar / w.ilosc, 2) if w.ilosc else 0,
                "koszt": w.koszt_jednostkowy, "oid": odprawa_id,
                "teraz": teraz, "item": w.item_id,
            },
        )

    # ── Dopisanie wartości na kartę kontenera ────────────────────────────────
    # Puste pole uzupełniamy, wypełnionego nie ruszamy — ktoś mógł je wpisać ręcznie
    # i cicha podmiana byłaby najgorszą możliwą niespodzianką.
    fx_k = ust.kurs_kosztow or odprawa.kurs_celny
    fracht = next((float(l.kwota or 0) for l in out.koszty if l.lp == 1), 0.0)
    razem_fv = sum(float(l.kwota or 0) for l in out.koszty if l.container_id is None)
    masy = {k["id"]: sum((t.waga_brutto_kg or 0) * t.ilosc for t in towar if t.container_id == k["id"])
            for k in kontenery}
    masa_razem = sum(masy.values())
    mrn_uzupelniony: List[str] = []
    zaktualizowane: List[str] = []

    for k in kontenery:
        udzial = (masy[k["id"]] / masa_razem) if masa_razem else (1.0 / max(1, len(kontenery)))
        zmiany, params = [], {"cid": k["id"]}
        if not k["mrn"] and odprawa.mrn:
            zmiany.append("mrn = :mrn")
            params["mrn"] = odprawa.mrn
            mrn_uzupelniony.append(k["container_number"])
        if not k["koszt_transportu"] and fracht:
            zmiany.append("koszt_transportu = :kt")
            params["kt"] = round(fracht * udzial, 2)
        if not k["koszt_spedycji"] and razem_fv:
            zmiany.append("koszt_spedycji = :ks")
            params["ks"] = round(razem_fv * udzial, 2)
        tk = next((float(l.kwota or 0) for l in out.koszty if l.container_id == k["id"]), 0.0)
        if not k["koszt_transportu_magazyn"] and tk:
            zmiany.append("koszt_transportu_magazyn = :tk")
            params["tk"] = tk
        if zmiany:
            await db.execute(
                text(f"UPDATE {settings.TABLE_CONTAINERS} SET {', '.join(zmiany)} WHERE id = :cid"),
                params,
            )
            zaktualizowane.append(k["container_number"])

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
