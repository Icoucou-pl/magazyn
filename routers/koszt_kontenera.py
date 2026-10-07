"""Zakładka „Koszt jednostkowy” na karcie kontenera (metoda szefa) i słownik stawek cła.

  GET /api/kontenery/{id}/koszt      rachunek na bieżąco: kafelki, założenia, tabela SKU
  POST /api/kontenery/{id}/koszt/podglad  ten sam rachunek z poprawkami z formularza — bez zapisu
  PUT /api/kontenery/{id}/koszt      zapis WYŁĄCZNIE ręcznych poprawek (null = automat)
  GET /api/stawki-cn                 Ustawienia → Stawki cła: obserwowane, nowości i sample
  PUT /api/stawki-cn/{kod}           ręczna stawka w słowniku (superadmin)
  PUT /api/products/{sku}/kod-cn     kod CN produktu — przeniesiony z „Danych podstawowych”
  POST /api/kontenery/{id}/koszt/notatki       nowy wpis w notatkach (np. skąd gratisy / dodatkowe koszty)
  PUT /api/kontenery/{id}/koszt/notatki/{n}    poprawka wpisu — autor albo administrator
  DELETE /api/kontenery/{id}/koszt/notatki/{n} usunięcie wpisu — autor albo administrator
  GET /api/kursy/ostatni?waluta=USD  ostatni kurs NBP — formularz kontenera liczy z ceny USD cenę PLN

Rachunek siedzi w services/koszt_kontenera.py (czysty, z testami), wejście z bazy składa
services/koszt_kontenera_dane.py. Tabele: sql/2026-10-koszt-jednostkowy-v2.sql.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

import audit
from audit_opisy import f_num, f_proc, f_zl
from config import settings
from database import get_db
from models import (
    CurrentUser, KodCnIn, KontenerKrotkoOut, KursOut, RozliczenieRazemIn, RozliczenieRazemOut, KosztGrupaOut, KosztDodatkowyOut, KosztKontenerIn, KosztKontenerOut, KosztNotatkaIn, KosztNotatkaOut, KosztPlatnoscOut,
    KosztPozycjaOut, KosztUwagaOut, StawkaCnIn, StawkaCnOut,
)
from routers.odprawy import _etykieta_sql, _koszt_erp
from security import (
    can_edit_landed_cost, get_current_user, is_super_admin, require_landed_cost_edit, require_landed_cost_view,
    require_perm, require_super_admin_403, resolve_shop,
)
from services.fx import kursy_przed
from services.koszt_kontenera import LENMAR_KONTENER, LENMAR_ZGLOSZENIE
from services.koszt_kontenera_dane import (
    T_DODATKOWE, T_KONTENER, T_POZYCJA, T_STAWKI, policz_kontenery, slownik_stawek, stawka_dla,
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


def _koszty_wiersze(body: KosztKontenerIn) -> Optional[List[dict]]:
    if body.koszty is None:
        return None
    return [{"nazwa": x.nazwa, "kwota": x.kwota, "manufacturer_id": x.dostawca_id,
             "item_ids": sorted(set(x.pozycje))} for x in body.koszty]


def _opis_kosztow(wiersze) -> str:
    """Do audytu: „Przepakowanie 300 (przypięte: 2 poz.); Wysyłka 490” albo „—”."""
    if not wiersze:
        return "—"
    return "; ".join(f"{w['nazwa']} {f_num('', 2)(float(w['kwota']))}"
                     + (f" (przypięte: {len(w['item_ids'])} poz.)" if w["item_ids"] else "") for w in wiersze)


def _podmiana(body: KosztKontenerIn) -> dict:
    return {"kontener": {"kurs_towaru": body.kurs_towaru, "fracht_pln": body.fracht_pln,
                         "lenmar_pln": body.lenmar_pln, "transport_pln": body.transport_pln},
            "pozycje": {p.item_id: (p.cena_waluta, p.stawka_cla, p.gratis) for p in body.pozycje},
            "koszty": _koszty_wiersze(body)}


T_NOTATKI = "app_koszt_notatki"


def _admin_notatek(user: CurrentUser) -> bool:
    return user.role == "ADMIN" or is_super_admin(user)


def _moze_zmieniac(user: CurrentUser, kto_id: Optional[int]) -> bool:
    """Swój wpis poprawia i usuwa autor; cudze — tylko administrator (rola ADMIN albo superadmin).
    Wpisy przeniesione ze starej wersji (bez autora) — tylko administrator."""
    return _admin_notatek(user) or (kto_id is not None and kto_id == user.id and can_edit_landed_cost(user))


async def _kontener_istnieje(db: AsyncSession, cid: int) -> None:
    if not (await db.execute(text(f"SELECT 1 FROM {settings.TABLE_CONTAINERS} WHERE id = :id"),
                             {"id": cid})).scalar_one_or_none():
        raise HTTPException(404, "Nie ma takiego kontenera")


async def _notatki(db: AsyncSession, cid: int, user: CurrentUser) -> List[KosztNotatkaOut]:
    rows = (await db.execute(text(
        f"SELECT id, tresc, kto, kto_id, kiedy, edytowano FROM {T_NOTATKI} WHERE container_id = :c ORDER BY kiedy, id"
    ), {"c": cid})).mappings().all()
    return [KosztNotatkaOut(id=r["id"], tresc=r["tresc"], kto=r["kto"], kiedy=r["kiedy"], edytowano=r["edytowano"],
                            moze_edytowac=_moze_zmieniac(user, r["kto_id"]))
            for r in rows]


async def _rachunek(db: AsyncSession, cid: int, user: CurrentUser,
                    podmiana: Optional[dict] = None) -> KosztKontenerOut:
    await _kontener_istnieje(db, cid)
    notatki = {"notatki": await _notatki(db, cid, user)}
    wyniki, meta = await policz_kontenery(db, [cid], podmiana)
    if cid not in wyniki:
        return KosztKontenerOut(container_id=cid, moze_edytowac=can_edit_landed_cost(user), **notatki)
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
    razem = await _krotko(db, w.razem_z)
    zapis = (await db.execute(text(f"SELECT zapisal, zapisano FROM {T_KONTENER} WHERE container_id = :c"),
                              {"c": cid})).mappings().first()

    return KosztKontenerOut(
        container_id=cid, krajowa=w.krajowa, szacunek=w.szacunek, podzial=w.podzial, zgloszen=w.zgloszen,
        towar=w.towar, gratisy=w.gratisy, dodatkowe=w.dodatkowe, fracht=w.fracht, fracht_auto=w.fracht_auto, fracht_usd=k.fracht_usd,
        kurs_frachtu=k.kurs_frachtu, data_kursu_frachtu=k.data_kursu_frachtu, data_frachtu=w.data_frachtu,
        lenmar=w.lenmar, lenmar_auto=w.lenmar_auto, clo=w.clo,
        transport=w.transport, transport_auto=w.transport_auto, suma=w.suma, narzut_proc=w.narzut_proc,
        kurs_towaru_reczny=k.kurs_towaru, fracht_reczny=k.fracht_pln, lenmar_reczny=k.lenmar_pln,
        transport_reczny=k.transport_reczny,
        lenmar_kontener=LENMAR_KONTENER, lenmar_zgloszenie=LENMAR_ZGLOSZENIE,
        grupy=[KosztGrupaOut(
            id=g.id, nazwa=g.nazwa, krajowa=g.krajowa, waluta=g.waluta, kurs=g.kurs, kurs_auto=g.kurs_auto,
            kurs_reczny=g.kurs_reczny, szacunek=g.szacunek, wartosc_waluta=g.wartosc_waluta,
            wartosc_zrodlo=g.wartosc_zrodlo, dostawca_id=g.dostawca_id,
            platnosci=[KosztPlatnoscOut(typ=x.typ, kwota=x.kwota, waluta=x.waluta, data=x.data,
                                        kurs=x.kurs, data_kursu=x.data_kursu) for x in g.platnosci],
        ) for g in w.grupy],
        razem_z=razem,
        # Tylko koszty tej karty — przy wspólnej fakturze grupa niesie też koszty partnerów.
        koszty=[KosztDodatkowyOut(nazwa=x.nazwa, kwota=x.kwota, waluta=g.waluta, grupa=g.id, dostawca_id=g.dostawca_id,
                                  pozycje=x.pozycje, pln=round(x.kwota * (g.kurs or 0.0), 2))
                for g in w.grupy for x in g.koszty if x.kontener == cid],
        pozycje=[KosztPozycjaOut(
            item_id=p.item_id, sku=p.sku, nazwa=nazwy.get(p.sku.lower()), szt=p.szt, grupa=p.grupa,
            krajowa=p.krajowa, cbm_szt=meta[p.item_id]["cbm_szt"], cena_planowana=p.cena_planowana,
            cena_waluta=p.cena_waluta, cena_reczna=p.cena_reczna, cena_zrodlo=p.cena_zrodlo,
            towar=p.towar, gratisy=p.gratisy, gratis_przypiety=p.gratis_przypiety, dodatkowe=p.dodatkowe, fracht=p.fracht,
            lenmar=p.lenmar, clo=p.clo, transport=p.transport, kod_cn=p.kod_cn, stawka=p.stawka,
            stawka_zrodlo=p.stawka_zrodlo, stawka_slownik=stawka_dla(stawki, p.kod_cn),
            koszt_jednostkowy=p.koszt_jednostkowy, szacunek=p.szacunek,
            koszt_erp=erp.get(p.item_id, (None, None))[0], erp_zrodlo=erp.get(p.item_id, (None, None))[1],
        ) for p in w.pozycje],
        uwagi=[KosztUwagaOut(poziom=u.poziom, tresc=u.tresc) for u in w.uwagi],
        zapisal=zapis["zapisal"] if zapis else None, zapisano=zapis["zapisano"] if zapis else None,
        moze_edytowac=can_edit_landed_cost(user), **notatki,
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
        SELECT ci.id, ci.sku, kp.cena_waluta, kp.stawka_cla, COALESCE(kp.gratis, FALSE) AS gratis
          FROM {settings.TABLE_CONTAINER_ITEMS} ci
          LEFT JOIN {T_POZYCJA} kp ON kp.item_id = ci.id
         WHERE ci.container_id = :c
    """), {"c": container_id})).mappings().all()
    po_id = {r["id"]: r for r in pozycje}
    obce = [p.item_id for p in body.pozycje if p.item_id not in po_id]
    if obce:
        raise HTTPException(422, "Pozycja nie należy do tego kontenera")
    wpisane = {p.item_id: p for p in body.pozycje
               if p.cena_waluta is not None or p.stawka_cla is not None or p.gratis}
    zmiany = audit.zmiany(dict(stare) if stare else None, nowe, POLA_KONTENERA)
    for iid, r in po_id.items():
        p = wpisane.get(iid)
        for pole, etykieta, fmt in (("cena_waluta", "cena / szt", f_num("", 4)), ("stawka_cla", "stawka cła", f_proc)):
            a, b = r[pole], getattr(p, pole) if p else None
            if fmt(a) != fmt(b):
                zmiany.append({"pole": f"{r['sku']}: {etykieta}", "bylo": fmt(a) if a is not None else "automat",
                               "jest": fmt(b) if b is not None else "automat"})
        if bool(r["gratis"]) != bool(p and p.gratis):
            zmiany.append({"pole": f"{r['sku']}: gratisy", "bylo": "przypięte" if r["gratis"] else "cała faktura",
                           "jest": "przypięte" if p and p.gratis else "cała faktura"})
    nowe_koszty = _koszty_wiersze(body)
    if nowe_koszty is not None:
        if any(i not in po_id for w in nowe_koszty for i in w["item_ids"]):
            raise HTTPException(422, "Dodatkowy koszt przypięty do pozycji spoza kontenera")
        stare_koszty = [dict(r) for r in (await db.execute(text(
            f"SELECT nazwa, kwota, item_ids FROM {T_DODATKOWE} WHERE container_id = :c ORDER BY position, id"),
            {"c": container_id})).mappings().all()]
        for w in stare_koszty:
            w["item_ids"] = sorted(w["item_ids"] or [])
        if _opis_kosztow(stare_koszty) != _opis_kosztow(nowe_koszty):
            zmiany.append({"pole": "dodatkowe koszty", "bylo": _opis_kosztow(stare_koszty), "jest": _opis_kosztow(nowe_koszty)})
        await db.execute(text(f"DELETE FROM {T_DODATKOWE} WHERE container_id = :c"), {"c": container_id})
        for pos, w in enumerate(nowe_koszty):
            await db.execute(text(f"""
                INSERT INTO {T_DODATKOWE} (container_id, manufacturer_id, nazwa, kwota, item_ids, position, zapisal, zapisano)
                VALUES (:c, :m, :n, :k, :i, :p, :kto, :teraz)
            """), {"c": container_id, "m": w["manufacturer_id"], "n": w["nazwa"], "k": w["kwota"],
                   "i": w["item_ids"], "p": pos, "kto": kto, "teraz": teraz})

    await db.execute(text(f"DELETE FROM {T_POZYCJA} WHERE item_id = ANY(:ids)"), {"ids": list(po_id)})
    for p in wpisane.values():
        await db.execute(text(f"""
            INSERT INTO {T_POZYCJA} (item_id, cena_waluta, stawka_cla, gratis, zapisal, zapisano)
            VALUES (:i, :c, :s, :g, :kto, :teraz)
        """), {"i": p.item_id, "c": p.cena_waluta, "s": p.stawka_cla, "g": p.gratis, "kto": kto, "teraz": teraz})
    await db.commit()

    audit.note_zmiany(f"kosztu jednostkowego kontenera {await audit.nazwa_kontenera(db, container_id)}",
                      zmiany, resource_type="container", resource_id=container_id)
    return await _rachunek(db, container_id, user)


@router.post("/kontenery/{container_id}/koszt/notatki", response_model=List[KosztNotatkaOut])
async def dodaj_notatke(container_id: int, body: KosztNotatkaIn, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_landed_cost_edit)):
    """Nowy wpis w notatkach do rachunku — np. że różnica płatności to dopłata za przepakowanie.
    Wpisy się nie nadpisują (szef widzi całą historię); nie zmieniają kosztu. Zwraca wszystkie wpisy."""
    await _kontener_istnieje(db, container_id)
    await db.execute(text(f"INSERT INTO {T_NOTATKI} (container_id, tresc, kto, kto_id) VALUES (:c, :t, :kto, :uid)"),
                     {"c": container_id, "t": body.tresc, "kto": user.full_name or user.email, "uid": user.id})
    await db.commit()
    audit.note(f"dodał notatkę do kosztu jednostkowego kontenera {await audit.nazwa_kontenera(db, container_id)}: "
               f"„{body.tresc[:200]}”", resource_type="container", resource_id=container_id)
    return await _notatki(db, container_id, user)


@router.put("/kontenery/{container_id}/koszt/notatki/{notatka_id}", response_model=List[KosztNotatkaOut])
async def popraw_notatke(container_id: int, notatka_id: int, body: KosztNotatkaIn, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_landed_cost_view)):
    """Poprawka wpisu — autor albo administrator (inni dopisują nowy wpis). Zostaje znacznik „edytowano”."""
    r = (await db.execute(text(f"SELECT tresc, kto_id FROM {T_NOTATKI} WHERE id = :n AND container_id = :c"),
                          {"n": notatka_id, "c": container_id})).mappings().first()
    if not r:
        raise HTTPException(404, "Nie ma takiej notatki")
    if not _moze_zmieniac(user, r["kto_id"]):
        raise HTTPException(403, "Notatkę poprawia tylko jej autor albo administrator — możesz dopisać nowy wpis")
    if r["tresc"] == body.tresc:
        audit.skip()
        return await _notatki(db, container_id, user)
    await db.execute(text(f"UPDATE {T_NOTATKI} SET tresc = :t, edytowano = CURRENT_TIMESTAMP WHERE id = :n"),
                     {"t": body.tresc, "n": notatka_id})
    await db.commit()
    audit.note_zmiany(f"kosztu jednostkowego kontenera {await audit.nazwa_kontenera(db, container_id)}",
                      [{"pole": "notatka", "bylo": r["tresc"], "jest": body.tresc}],
                      resource_type="container", resource_id=container_id)
    return await _notatki(db, container_id, user)


@router.delete("/kontenery/{container_id}/koszt/notatki/{notatka_id}", response_model=List[KosztNotatkaOut])
async def usun_notatke(container_id: int, notatka_id: int, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(require_landed_cost_view)):
    """Usunięcie wpisu — autor (swojego) albo administrator (każdego)."""
    r = (await db.execute(text(f"SELECT tresc, kto, kto_id FROM {T_NOTATKI} WHERE id = :n AND container_id = :c"),
                          {"n": notatka_id, "c": container_id})).mappings().first()
    if not r:
        raise HTTPException(404, "Nie ma takiej notatki")
    if not _moze_zmieniac(user, r["kto_id"]):
        raise HTTPException(403, "Notatkę usuwa tylko jej autor albo administrator")
    await db.execute(text(f"DELETE FROM {T_NOTATKI} WHERE id = :n"), {"n": notatka_id})
    await db.commit()
    audit.note(f"usunął notatkę ({r['kto'] or '—'}) z kosztu jednostkowego kontenera "
               f"{await audit.nazwa_kontenera(db, container_id)}: „{(r['tresc'] or '')[:200]}”",
               resource_type="container", resource_id=container_id)
    return await _notatki(db, container_id, user)


@router.get("/kursy/ostatni", response_model=KursOut)
async def ostatni_kurs(waluta: str = Query("USD"), db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)):
    """Ostatni kurs średni NBP — formularz kontenera przelicza nim cenę w walucie na PLN.
    Kurs NBP jest publiczny, więc wystarczy zalogowanie."""
    w = (waluta or "").strip().upper()
    if not (len(w) == 3 and w.isalpha()):
        raise HTTPException(422, "Waluta to trzyliterowy kod, np. USD")
    if w == "PLN":
        return KursOut(waluta=w, kurs=1.0)
    jutro = date.today() + timedelta(days=1)
    d, k = (await kursy_przed(db, [(w, jutro)])).get((w, jutro), (None, None))
    return KursOut(waluta=w, kurs=k, data=d)


# ============================================================
# Wspólna faktura — kontenery rozliczane razem
# ============================================================

async def _krotko(db: AsyncSession, ids, gdzie: str = "c.id = ANY(:ids)", params: Optional[dict] = None
                  ) -> List[KontenerKrotkoOut]:
    if gdzie == "c.id = ANY(:ids)" and not ids:
        return []
    rows = (await db.execute(text(f"""
        SELECT c.id, {_etykieta_sql()} AS etykieta, m.name AS dostawca, c.eta_date
          FROM {settings.TABLE_CONTAINERS} c
          LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = c.manufacturer_id
         WHERE {gdzie}
         ORDER BY c.eta_date DESC NULLS LAST, c.id DESC
    """), {"ids": list(ids or []), **(params or {})})).mappings().all()
    return [KontenerKrotkoOut(id=r["id"], etykieta=r["etykieta"], dostawca=r["dostawca"], eta=r["eta_date"])
            for r in rows]


@router.get("/kontenery/{container_id}/rozliczenie-razem", response_model=RozliczenieRazemOut)
async def rozliczenie_razem(container_id: int, db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(require_landed_cost_view)):
    """Z kim ten kontener dzieli płatności + kandydaci: zwykłe (nieskonsolidowane) kontenery,
    najpierw tego samego dostawcy i z bliską datą ETA."""
    k = (await db.execute(text(f"SELECT id, manufacturer_id, eta_date, rozliczenie_grupa "
                               f"FROM {settings.TABLE_CONTAINERS} WHERE id = :id"),
                          {"id": container_id})).mappings().first()
    if not k:
        raise HTTPException(404, "Nie ma takiego kontenera")
    polaczone = await _krotko(db, None, "c.rozliczenie_grupa = :g AND c.id <> :id",
                              {"g": k["rozliczenie_grupa"], "id": container_id}) if k["rozliczenie_grupa"] else []
    kandydaci = await _krotko(db, None, f"""c.id IN (
            SELECT x.id FROM {settings.TABLE_CONTAINERS} x
             WHERE x.id <> :id AND NOT COALESCE(x.is_consolidated, FALSE)
             ORDER BY (x.manufacturer_id IS NOT DISTINCT FROM :m) DESC,
                      ABS(x.eta_date - CAST(:eta AS DATE)) NULLS LAST
             LIMIT 40)""", {"id": container_id, "m": k["manufacturer_id"], "eta": k["eta_date"]})
    juz = {p.id for p in polaczone}
    return RozliczenieRazemOut(polaczone=polaczone, kandydaci=[c for c in kandydaci if c.id not in juz])


@router.put("/kontenery/{container_id}/rozliczenie-razem", response_model=RozliczenieRazemOut)
async def zapisz_rozliczenie_razem(container_id: int, body: RozliczenieRazemIn, db: AsyncSession = Depends(get_db),
                                   user: CurrentUser = Depends(require_landed_cost_edit)):
    """Ustawia wspólną fakturę: ten kontener + `kontenery` liczą towar z płatności razem.
    Lista dokładnie opisuje grupę — kontener zdjęty z listy wraca do liczenia sam."""
    nowe = {container_id} | set(body.kontenery)
    rows = (await db.execute(text(f"""
        SELECT id, COALESCE(is_consolidated, FALSE) AS skonsolidowany, rozliczenie_grupa
          FROM {settings.TABLE_CONTAINERS} WHERE id = ANY(:ids)
    """), {"ids": list(nowe)})).mappings().all()
    if len(rows) != len(nowe):
        raise HTTPException(404, "Nie ma takiego kontenera")
    if any(r["skonsolidowany"] for r in rows):
        raise HTTPException(422, "Kontener skonsolidowany ma płatności per lot — nie łączymy go z innymi")
    stara = next((r["rozliczenie_grupa"] for r in rows if r["id"] == container_id), None)
    przed = await _krotko(db, None, "c.rozliczenie_grupa = :g AND c.id <> :id",
                          {"g": stara, "id": container_id}) if stara else []

    # Grupa tego kontenera w całości od nowa, a nowi członkowie wychodzą ze swoich starych grup.
    await db.execute(text(f"UPDATE {settings.TABLE_CONTAINERS} SET rozliczenie_grupa = NULL "
                          f"WHERE id = ANY(:ids) OR (CAST(:g AS INTEGER) IS NOT NULL AND rozliczenie_grupa = :g)"),
                     {"ids": list(nowe), "g": stara})
    if len(nowe) > 1:
        await db.execute(text(f"""
            UPDATE {settings.TABLE_CONTAINERS}
               SET rozliczenie_grupa = (SELECT COALESCE(MAX(rozliczenie_grupa), 0) + 1 FROM {settings.TABLE_CONTAINERS})
             WHERE id = ANY(:ids)
        """), {"ids": list(nowe)})
    # Grupa, z której ktoś odszedł i został w niej jeden kontener, przestaje istnieć.
    await db.execute(text(f"""
        UPDATE {settings.TABLE_CONTAINERS} SET rozliczenie_grupa = NULL
         WHERE rozliczenie_grupa IN (SELECT rozliczenie_grupa FROM {settings.TABLE_CONTAINERS}
                                      WHERE rozliczenie_grupa IS NOT NULL
                                      GROUP BY rozliczenie_grupa HAVING COUNT(*) = 1)
    """))
    await db.commit()

    po = await rozliczenie_razem(container_id, db, user)
    fmt = lambda lista: ", ".join(k.etykieta for k in lista) or "—"   # noqa: E731
    if fmt(przed) == fmt(po.polaczone):
        audit.skip()
    else:
        audit.note(f"ustawił wspólną fakturę kontenera {await audit.nazwa_kontenera(db, container_id)}: "
                   f"rozliczany razem z {fmt(po.polaczone)}",
                   changes=[{"pole": "Rozliczany razem z", "bylo": fmt(przed), "jest": fmt(po.polaczone)}],
                   resource_type="container", resource_id=container_id)
    return po


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
