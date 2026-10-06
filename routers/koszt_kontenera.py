"""Zakładka „Koszt jednostkowy” na karcie kontenera (metoda szefa) i słownik stawek cła.

  GET /api/kontenery/{id}/koszt      rachunek na bieżąco: kafelki, założenia, tabela SKU
  POST /api/kontenery/{id}/koszt/podglad  ten sam rachunek z poprawkami z formularza — bez zapisu
  PUT /api/kontenery/{id}/koszt      zapis WYŁĄCZNIE ręcznych poprawek (null = automat)
  GET /api/stawki-cn                 Ustawienia → Stawki cła: obserwowane, nowości i sample
  PUT /api/stawki-cn/{kod}           ręczna stawka w słowniku (superadmin)
  PUT /api/products/{sku}/kod-cn     kod CN produktu — przeniesiony z „Danych podstawowych”

Rachunek siedzi w services/koszt_kontenera.py (czysty, z testami), wejście z bazy składa
services/koszt_kontenera_dane.py. Tabele: sql/2026-10-koszt-jednostkowy-v2.sql.
"""

from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

import audit
from audit_opisy import f_num, f_proc, f_zl
from config import settings
from database import get_db
from models import (
    CurrentUser, KodCnIn, KosztGrupaOut, KosztKontenerIn, KosztKontenerOut, KosztPlatnoscOut,
    KosztPozycjaOut, KosztUwagaOut, StawkaCnIn, StawkaCnOut,
)
from routers.odprawy import _koszt_erp
from security import (
    can_edit_landed_cost, get_current_user, require_landed_cost_edit, require_landed_cost_view,
    require_perm, require_super_admin_403, resolve_shop,
)
from services.koszt_kontenera import LENMAR_KONTENER, LENMAR_ZGLOSZENIE
from services.koszt_kontenera_dane import (
    T_KONTENER, T_POZYCJA, T_STAWKI, policz_kontenery, slownik_stawek, stawka_dla,
)
from services.sad import normalizuj_cn
from sql import PRODUCT_NAMES_CTE

router = APIRouter(prefix="/api", tags=["koszt-kontenera"])

STATUSY = ("ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE", "SAMPLE")

POLA_KONTENERA = {
    "kurs_towaru": ("Kurs towaru", f_num("", 4)),
    "fracht_pln": ("Fracht morski", f_zl),
    "lenmar_pln": ("Opłaty Lenmara", f_zl),
    "transport_pln": ("Transport do magazynu", f_zl),
}


def _podmiana(body: KosztKontenerIn) -> dict:
    return {"kontener": {"kurs_towaru": body.kurs_towaru, "fracht_pln": body.fracht_pln,
                         "lenmar_pln": body.lenmar_pln, "transport_pln": body.transport_pln},
            "pozycje": {p.item_id: (p.cena_waluta, p.stawka_cla) for p in body.pozycje}}


async def _rachunek(db: AsyncSession, cid: int, user: CurrentUser,
                    podmiana: Optional[dict] = None) -> KosztKontenerOut:
    wyniki, meta = await policz_kontenery(db, [cid], podmiana)
    if cid not in wyniki:
        exists = (await db.execute(text(f"SELECT 1 FROM {settings.TABLE_CONTAINERS} WHERE id = :id"),
                                   {"id": cid})).scalar_one_or_none()
        if not exists:
            raise HTTPException(404, "Nie ma takiego kontenera")
        return KosztKontenerOut(container_id=cid, moze_edytowac=can_edit_landed_cost(user))
    w = wyniki[cid]
    k = w.kontener

    nazwy = {r[0]: r[1] for r in (await db.execute(text(f"""
        WITH {PRODUCT_NAMES_CTE}
        SELECT sku_canon, nazwa FROM prod_names WHERE sku_canon = ANY(:k)
    """), {"k": [p.sku.lower() for p in w.pozycje]})).all()}

    # Koszt z ERP spółki-importera — per firma pozycji (konsolidacja bywa wielospółkowa).
    erp: Dict[int, tuple] = {}
    po_firmie: Dict[str, List] = {}
    for p in w.pozycje:
        po_firmie.setdefault(meta[p.item_id]["firma"], []).append(p)
    for firma, lista in po_firmie.items():
        zrodlo, ceny = await _koszt_erp(db, firma, [p.sku for p in lista])
        for p in lista:
            erp[p.item_id] = (ceny.get(p.sku.lower()), zrodlo)

    stawki = await slownik_stawek(db)
    zapis = (await db.execute(text(f"SELECT zapisal, zapisano FROM {T_KONTENER} WHERE container_id = :c"),
                              {"c": cid})).mappings().first()

    return KosztKontenerOut(
        container_id=cid, krajowa=w.krajowa, szacunek=w.szacunek, podzial=w.podzial, zgloszen=w.zgloszen,
        towar=w.towar, fracht=w.fracht, fracht_auto=w.fracht_auto, fracht_usd=k.fracht_usd,
        kurs_frachtu=k.kurs_frachtu, data_kursu_frachtu=k.data_kursu_frachtu, data_frachtu=w.data_frachtu,
        lenmar=w.lenmar, lenmar_auto=w.lenmar_auto, clo=w.clo,
        transport=w.transport, transport_auto=w.transport_auto, suma=w.suma, narzut_proc=w.narzut_proc,
        kurs_towaru_reczny=k.kurs_towaru, fracht_reczny=k.fracht_pln, lenmar_reczny=k.lenmar_pln,
        transport_reczny=k.transport_reczny,
        lenmar_kontener=LENMAR_KONTENER, lenmar_zgloszenie=LENMAR_ZGLOSZENIE,
        grupy=[KosztGrupaOut(
            id=g.id, nazwa=g.nazwa, krajowa=g.krajowa, waluta=g.waluta, kurs=g.kurs, kurs_auto=g.kurs_auto,
            kurs_reczny=g.kurs_reczny, szacunek=g.szacunek, wartosc_waluta=g.wartosc_waluta,
            wartosc_zrodlo=g.wartosc_zrodlo,
            platnosci=[KosztPlatnoscOut(typ=x.typ, kwota=x.kwota, waluta=x.waluta, data=x.data,
                                        kurs=x.kurs, data_kursu=x.data_kursu) for x in g.platnosci],
        ) for g in w.grupy],
        pozycje=[KosztPozycjaOut(
            item_id=p.item_id, sku=p.sku, nazwa=nazwy.get(p.sku.lower()), szt=p.szt, grupa=p.grupa,
            krajowa=p.krajowa, cbm_szt=meta[p.item_id]["cbm_szt"], cena_planowana=p.cena_planowana,
            cena_waluta=p.cena_waluta, cena_reczna=p.cena_reczna, towar=p.towar, fracht=p.fracht,
            lenmar=p.lenmar, clo=p.clo, transport=p.transport, kod_cn=p.kod_cn, stawka=p.stawka,
            stawka_zrodlo=p.stawka_zrodlo, stawka_slownik=stawka_dla(stawki, p.kod_cn),
            koszt_jednostkowy=p.koszt_jednostkowy, szacunek=p.szacunek,
            koszt_erp=erp.get(p.item_id, (None, None))[0], erp_zrodlo=erp.get(p.item_id, (None, None))[1],
        ) for p in w.pozycje],
        uwagi=[KosztUwagaOut(poziom=u.poziom, tresc=u.tresc) for u in w.uwagi],
        zapisal=zapis["zapisal"] if zapis else None, zapisano=zapis["zapisano"] if zapis else None,
        moze_edytowac=can_edit_landed_cost(user),
    )


@router.get("/kontenery/{container_id}/koszt", response_model=KosztKontenerOut)
async def koszt_kontenera(container_id: int, db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(require_landed_cost_view)):
    return await _rachunek(db, container_id, user)


@router.post("/kontenery/{container_id}/koszt/podglad", response_model=KosztKontenerOut)
async def podglad_poprawek(container_id: int, body: KosztKontenerIn, db: AsyncSession = Depends(get_db),
                           user: CurrentUser = Depends(require_landed_cost_edit)):
    """Przelicza z poprawkami wpisanymi w formularzu, NIC nie zapisuje."""
    audit.skip()
    return await _rachunek(db, container_id, user, _podmiana(body))


@router.put("/kontenery/{container_id}/koszt", response_model=KosztKontenerOut)
async def zapisz_poprawki(container_id: int, body: KosztKontenerIn, db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(require_landed_cost_edit)):
    """Zapisuje same poprawki. Pozycja, której nie ma w `pozycje`, wraca do automatu."""
    exists = (await db.execute(text(f"SELECT 1 FROM {settings.TABLE_CONTAINERS} WHERE id = :id"),
                               {"id": container_id})).scalar_one_or_none()
    if not exists:
        raise HTTPException(404, "Nie ma takiego kontenera")
    kto = user.full_name or user.email
    teraz = datetime.now(timezone.utc)

    stare = (await db.execute(text(f"SELECT * FROM {T_KONTENER} WHERE container_id = :c"),
                              {"c": container_id})).mappings().first()
    nowe = {"kurs_towaru": body.kurs_towaru, "fracht_pln": body.fracht_pln,
            "lenmar_pln": body.lenmar_pln, "transport_pln": body.transport_pln}
    if any(v is not None for v in nowe.values()):
        await db.execute(text(f"""
            INSERT INTO {T_KONTENER} (container_id, kurs_towaru, fracht_pln, lenmar_pln, transport_pln, zapisal, zapisano)
            VALUES (:c, :kurs_towaru, :fracht_pln, :lenmar_pln, :transport_pln, :kto, :teraz)
            ON CONFLICT (container_id) DO UPDATE SET
                kurs_towaru = EXCLUDED.kurs_towaru, fracht_pln = EXCLUDED.fracht_pln,
                lenmar_pln = EXCLUDED.lenmar_pln, transport_pln = EXCLUDED.transport_pln,
                zapisal = EXCLUDED.zapisal, zapisano = EXCLUDED.zapisano
        """), {"c": container_id, **nowe, "kto": kto, "teraz": teraz})
    else:
        await db.execute(text(f"DELETE FROM {T_KONTENER} WHERE container_id = :c"), {"c": container_id})

    pozycje = (await db.execute(text(f"""
        SELECT ci.id, ci.sku, kp.cena_waluta, kp.stawka_cla
          FROM {settings.TABLE_CONTAINER_ITEMS} ci
          LEFT JOIN {T_POZYCJA} kp ON kp.item_id = ci.id
         WHERE ci.container_id = :c
    """), {"c": container_id})).mappings().all()
    po_id = {r["id"]: r for r in pozycje}
    obce = [p.item_id for p in body.pozycje if p.item_id not in po_id]
    if obce:
        raise HTTPException(422, "Pozycja nie należy do tego kontenera")
    wpisane = {p.item_id: p for p in body.pozycje if p.cena_waluta is not None or p.stawka_cla is not None}
    zmiany = audit.zmiany(dict(stare) if stare else None, nowe, POLA_KONTENERA)
    for iid, r in po_id.items():
        p = wpisane.get(iid)
        for pole, etykieta, fmt in (("cena_waluta", "cena / szt", f_num("", 4)), ("stawka_cla", "stawka cła", f_proc)):
            a, b = r[pole], getattr(p, pole) if p else None
            if fmt(a) != fmt(b):
                zmiany.append({"pole": f"{r['sku']}: {etykieta}", "bylo": fmt(a) if a is not None else "automat",
                               "jest": fmt(b) if b is not None else "automat"})
    await db.execute(text(f"DELETE FROM {T_POZYCJA} WHERE item_id = ANY(:ids)"), {"ids": list(po_id)})
    for p in wpisane.values():
        await db.execute(text(f"""
            INSERT INTO {T_POZYCJA} (item_id, cena_waluta, stawka_cla, zapisal, zapisano)
            VALUES (:i, :c, :s, :kto, :teraz)
        """), {"i": p.item_id, "c": p.cena_waluta, "s": p.stawka_cla, "kto": kto, "teraz": teraz})
    await db.commit()

    audit.note_zmiany(f"kosztu jednostkowego kontenera {await audit.nazwa_kontenera(db, container_id)}",
                      zmiany, resource_type="container", resource_id=container_id)
    return await _rachunek(db, container_id, user)


# ============================================================
# Ustawienia → Stawki cła
# ============================================================

@router.get("/stawki-cn", response_model=List[StawkaCnOut])
async def stawki_cn(shop: str = Query(""), db: AsyncSession = Depends(get_db),
                    user: CurrentUser = Depends(get_current_user)):
    """SKU obserwowane, nowości i sample z kodem CN i stawką ze słownika.

    Outlety, dead stock i reszta katalogu nie są tu potrzebne — kod CN liczy się dla towaru,
    który wciąż sprowadzamy. Lista z tego samego fetch_products co tabela „Produkty”.
    """
    from services.products import fetch_products

    shop = resolve_shop(shop, user)
    produkty = await fetch_products(db, set(STATUSY), shop)
    slownik = (await db.execute(text(f"SELECT kod_cn, stawka, zrodlo FROM {T_STAWKI}"))).all()
    st = {r[0]: (float(r[1]), r[2]) for r in slownik}
    out: List[StawkaCnOut] = []
    for p in produkty:
        if not (p.is_favorite or p.is_new or p.is_sample):
            continue
        hit = st.get(p.kod_cn) or (st.get(p.kod_cn[:8]) if p.kod_cn else None)
        out.append(StawkaCnOut(
            sku=p.sku, nazwa=p.name, firma=p.firma_slug, obserwowany=p.is_favorite, nowosc=p.is_new,
            sample=p.is_sample, kod_cn=p.kod_cn, stawka=hit[0] if hit else None, zrodlo=hit[1] if hit else None,
        ))
    out.sort(key=lambda s: (s.kod_cn is not None and s.stawka is not None, s.sku.lower()))
    return out


@router.put("/stawki-cn/{kod}", response_model=StawkaCnOut)
async def zapisz_stawke(kod: str, body: StawkaCnIn, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_super_admin_403)):
    """Ręczna stawka w słowniku — obowiązuje od razu we wszystkich SKU z tym kodem.
    Odprawa z SAD nie nadpisuje stawki wpisanej ręcznie."""
    cn = normalizuj_cn(kod)
    if not cn:
        raise HTTPException(422, "Kod CN to same cyfry, np. 9403 20 80")
    stara = (await db.execute(text(f"SELECT stawka FROM {T_STAWKI} WHERE kod_cn = :k"), {"k": cn})).scalar_one_or_none()
    await db.execute(text(f"""
        INSERT INTO {T_STAWKI} (kod_cn, stawka, zrodlo, zmienil, updated_at)
        VALUES (:k, :s, 'reczna', :kto, NOW())
        ON CONFLICT (kod_cn) DO UPDATE SET stawka = EXCLUDED.stawka, zrodlo = 'reczna',
               zmienil = EXCLUDED.zmienil, updated_at = NOW()
    """), {"k": cn, "s": body.stawka, "kto": user.full_name or user.email})
    await db.commit()
    bylo = f" (było {f_proc(stara)})" if stara is not None else ""
    audit.note(f"ustawił stawkę cła dla kodu CN {cn}: {f_proc(body.stawka)}{bylo}", resource_id=cn)
    return StawkaCnOut(sku="", kod_cn=cn, stawka=body.stawka, zrodlo="reczna")


@router.put("/products/{sku:path}/kod-cn", response_model=StawkaCnOut)
async def zapisz_kod_cn(sku: str, body: KodCnIn, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_perm("editProducts"))):
    """Kod CN produktu (app_product_attrs.kod_cn). Dawniej w „Danych podstawowych” karty,
    teraz w Ustawieniach → Stawki cła, obok stawki. Uprawnienie jak przy edycji produktu."""
    cn = normalizuj_cn(body.kod_cn)
    sku = sku.strip()
    stary = (await db.execute(text(f"""
        SELECT kod_cn FROM {settings.TABLE_PRODUCT_ATTRS} WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:s))
         ORDER BY updated_at DESC NULLS LAST LIMIT 1
    """), {"s": sku})).scalar_one_or_none()
    zmienione = (await db.execute(text(f"""
        UPDATE {settings.TABLE_PRODUCT_ATTRS} SET kod_cn = :cn, updated_at = CURRENT_TIMESTAMP
         WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:s))
    """), {"cn": cn, "s": sku})).rowcount
    if not zmienione:
        await db.execute(text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, kod_cn, updated_at)
            VALUES (:s, :cn, CURRENT_TIMESTAMP)
        """), {"cn": cn, "s": sku})
    await db.commit()
    if (stary or None) == cn:
        audit.skip()
    else:
        audit.note(f"zmienił kod CN produktu {sku}: {stary or '—'} → {cn or '—'}", resource_id=sku)
    st = (await db.execute(text(f"SELECT stawka, zrodlo FROM {T_STAWKI} WHERE kod_cn = :k OR kod_cn = :k8 "
                                f"ORDER BY (kod_cn = :k) DESC LIMIT 1"),
                           {"k": cn or "", "k8": (cn or "")[:8]})).first() if cn else None
    return StawkaCnOut(sku=sku, kod_cn=cn, stawka=float(st[0]) if st else None, zrodlo=st[1] if st else None)
