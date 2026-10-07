"""Wejście do rachunku kosztu jednostkowego (services/koszt_kontenera.py) — z bazy, hurtem.

Jedna funkcja `policz_kontenery` liczy jeden kontener (zakładka „Koszt jednostkowy”) albo
wszystkie naraz (lista produktów, zakładka „Cena”). Bez zapytań w pętli: osobno pozycje,
kontenery, loty, zaliczki, nadpisania, słownik stawek i kursy — każde jednym zapytaniem.

Płatność „zapłacona” = ma datę zapłaty i ta data nie jest z przyszłości (rata wpisana
z wyprzedzeniem to plan) — ta sama zasada co fetch_payments_pln w services/containers.py.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from services.fx import kursy_przed
from services.koszt_kontenera import Grupa, Kontener, KosztDodatkowy, Platnosc, Pozycja, Wynik, policz, policz_razem
from services.products import compute_effective_cbm

T_KONTENER = "app_koszt_kontenera"
T_POZYCJA = "app_koszt_pozycji"
T_STAWKI = "app_stawki_cn"
T_DODATKOWE = "app_koszt_dodatkowy"


def _f(v) -> Optional[float]:
    return float(v) if v is not None else None


def _waluta(*kandydaci) -> str:
    for k in kandydaci:
        k = (k or "").strip().upper()
        if k:
            return k
    return "USD"


def stawka_dla(slownik: Dict[str, float], kod: Optional[str]) -> Optional[float]:
    """Stawka cła dla kodu CN: dokładny kod, a gdy go nie ma — 8 cyfr (CN bez TARIC)."""
    if not kod:
        return None
    if kod in slownik:
        return slownik[kod]
    return slownik.get(kod[:8])


async def slownik_stawek(db: AsyncSession) -> Dict[str, float]:
    rows = (await db.execute(text(f"SELECT kod_cn, stawka FROM {T_STAWKI}"))).all()
    return {r[0]: float(r[1]) for r in rows}


async def policz_kontenery(db: AsyncSession, container_ids: Optional[Sequence[int]] = None,
                           podmiana: Optional[Dict[str, Any]] = None
                           ) -> "tuple[Dict[int, Wynik], Dict[int, Dict[str, Any]]]":
    """Rachunek dla podanych kontenerów (None = wszystkie).

    `podmiana` = poprawki do podglądu bez zapisu, zamiast tych z bazy:
    {"kontener": {kurs_towaru, fracht_pln, lenmar_pln, transport_pln},
     "pozycje": {item_id: (cena_waluta, stawka_cla, gratis)},
     "koszty": [{nazwa, kwota, manufacturer_id, item_ids}] albo brak klucza = te z bazy} — dotyczy wszystkich liczonych kontenerów,
    więc woła się ją dla jednego.

    Zwraca ({container_id: Wynik}, {item_id: metadane pozycji}) — metadane to to, czego
    rachunek nie potrzebuje, a ekran tak: nazwa produktu, CBM, firma, lot.
    """
    wszystkie = container_ids is None
    ids = list(container_ids or [])
    if not wszystkie and not ids:
        return {}, {}
    zadane = set(ids)
    if not wszystkie:
        # Kontener rozliczany razem z innymi (wspólna faktura) potrzebuje do rachunku towaru
        # i płatności wszystkich — dociągamy partnerów, choć w wyniku nikt ich nie prosił.
        partnerzy = (await db.execute(text(f"""
            SELECT id FROM {settings.TABLE_CONTAINERS}
             WHERE rozliczenie_grupa IN (SELECT rozliczenie_grupa FROM {settings.TABLE_CONTAINERS}
                                          WHERE id = ANY(:ids) AND rozliczenie_grupa IS NOT NULL)
        """), {"ids": ids})).scalars().all()
        ids = sorted(set(ids) | set(partnerzy))
    filtr_c = "" if wszystkie else "WHERE c.id = ANY(:ids)"
    filtr_ci = "" if wszystkie else "WHERE ci.container_id = ANY(:ids)"
    filtr_l = "" if wszystkie else "WHERE l.container_id = ANY(:ids)"
    p = {} if wszystkie else {"ids": ids}

    kontenery = (await db.execute(text(f"""
        SELECT c.id, COALESCE(c.is_consolidated, FALSE) AS skonsolidowany,
               c.koszt_transportu, c.koszt_transportu_magazyn, c.delivered_date, c.eta_date,
               c.waluta_towaru, c.balance_kwota, c.balance_waluta, c.zaplacono_data, c.rozliczenie_grupa
          FROM {settings.TABLE_CONTAINERS} c {filtr_c}
    """), p)).mappings().all()
    if not kontenery:
        return {}, {}
    if wszystkie:
        ids = [k["id"] for k in kontenery]
        p = {"ids": ids}
        filtr_ci, filtr_l = "WHERE ci.container_id = ANY(:ids)", "WHERE l.container_id = ANY(:ids)"

    loty = (await db.execute(text(f"""
        SELECT l.id, l.container_id, l.manufacturer_id, l.waluta_towaru, l.balance_kwota, l.balance_waluta,
               l.zaplacono_data, COALESCE(m.name, l.order_number, '') AS nazwa
          FROM {settings.TABLE_CONTAINER_LOTS} l
          LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = l.manufacturer_id
          {filtr_l}
    """), p)).mappings().all()
    zaliczki = (await db.execute(text(f"""
        SELECT a.container_id, a.lot_id, a.kwota, a.waluta, a.data
          FROM {settings.TABLE_CONTAINER_ADVANCES} a
         WHERE a.kwota IS NOT NULL AND a.kwota > 0
           AND (a.container_id = ANY(:ids)
                OR a.lot_id IN (SELECT l.id FROM {settings.TABLE_CONTAINER_LOTS} l WHERE l.container_id = ANY(:ids)))
         ORDER BY a.position, a.id
    """), p)).mappings().all()
    pozycje = (await db.execute(text(f"""
        SELECT ci.id AS item_id, ci.container_id, ci.lot_id, ci.sku, ci.quantity, ci.unit_cost, ci.cena_waluta AS cena_kontener,
               pa.cbm_per_unit, pa.dlugosc_cm, pa.szerokosc_cm, pa.wysokosc_cm, pa.szt_w_kartonie,
               pa.kod_cn, LOWER(COALESCE(f.slug, 'amh')) AS firma,
               kp.cena_waluta, kp.stawka_cla, COALESCE(kp.gratis, FALSE) AS gratis
          FROM {settings.TABLE_CONTAINER_ITEMS} ci
          LEFT JOIN LATERAL (
              SELECT * FROM {settings.TABLE_PRODUCT_ATTRS} a
               WHERE LOWER(TRIM(a.sku)) = LOWER(TRIM(ci.sku))
               ORDER BY a.updated_at DESC NULLS LAST LIMIT 1
          ) pa ON TRUE
          LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = pa.firma_id
          LEFT JOIN {T_POZYCJA} kp ON kp.item_id = ci.id
          {filtr_ci}
         ORDER BY ci.container_id, ci.id
    """), p)).mappings().all()
    nadpisania = {r["container_id"]: dict(r) for r in (await db.execute(text(
        f"SELECT * FROM {T_KONTENER} WHERE container_id = ANY(:ids)"), p)).mappings().all()}
    dodatkowe: Dict[int, List[dict]] = {}
    for r in (await db.execute(text(f"""
        SELECT container_id, manufacturer_id, nazwa, kwota, item_ids, osobna, szt FROM {T_DODATKOWE}
         WHERE container_id = ANY(:ids) ORDER BY container_id, position, id
    """), p)).mappings().all():
        dodatkowe.setdefault(r["container_id"], []).append(dict(r))
    stawki = await slownik_stawek(db)
    if podmiana is not None and podmiana.get("koszty") is not None:
        for cid in zadane:
            dodatkowe[cid] = list(podmiana["koszty"])
    if podmiana is not None:
        nadpisania = {**nadpisania, **{cid: podmiana.get("kontener") or {} for cid in zadane}}
        brak = (None, None, False)
        pozycje = [{**r, "cena_waluta": podmiana.get("pozycje", {}).get(r["item_id"], brak)[0],
                    "stawka_cla": podmiana.get("pozycje", {}).get(r["item_id"], brak)[1],
                    "gratis": bool(podmiana.get("pozycje", {}).get(r["item_id"], brak)[2])}
                   if r["container_id"] in zadane else r
                   for r in pozycje]

    dzis = date.today()
    jutro = dzis + timedelta(days=1)

    def zaplacona(d: Optional[date]) -> Optional[date]:
        return d if d and d <= dzis else None

    # ── płatności per grupa: (container_id, lot_id albo 0) ─────────
    platnosci: Dict[tuple, List[Platnosc]] = {}
    for k in kontenery:
        if k["balance_kwota"]:
            platnosci.setdefault((k["id"], 0), []).append(Platnosc(
                typ="balance", kwota=float(k["balance_kwota"]),
                waluta=_waluta(k["balance_waluta"], k["waluta_towaru"]), data=zaplacona(k["zaplacono_data"])))
    lot_kontenera = {l["id"]: l["container_id"] for l in loty}
    for l in loty:
        if l["balance_kwota"]:
            platnosci.setdefault((l["container_id"], l["id"]), []).append(Platnosc(
                typ="balance", kwota=float(l["balance_kwota"]),
                waluta=_waluta(l["balance_waluta"], l["waluta_towaru"]), data=zaplacona(l["zaplacono_data"])))
    for a in zaliczki:
        klucz = (a["container_id"], 0) if a["container_id"] else (lot_kontenera.get(a["lot_id"]), a["lot_id"])
        if klucz[0] is None:
            continue
        platnosci.setdefault(klucz, []).insert(0, Platnosc(
            typ="zaliczka", kwota=float(a["kwota"]), waluta=_waluta(a["waluta"]), data=zaplacona(a["data"])))

    # ── kursy: płatności, fracht i „ostatni znany” dla szacunków — jedno zapytanie ──
    po_k = {k["id"]: k for k in kontenery}
    pary = set()
    for lista in platnosci.values():
        for pl in lista:
            pary.add((pl.waluta, pl.data or jutro))
    for k in kontenery:
        if k["koszt_transportu"]:
            pary.add(("USD", k["delivered_date"] or k["eta_date"] or jutro))
        pary.add((_waluta(k["waluta_towaru"]), jutro))
    for l in loty:
        pary.add((_waluta(l["waluta_towaru"], po_k[l["container_id"]]["waluta_towaru"]), jutro))
    kursy = await kursy_przed(db, pary)

    def kurs(w: str, d: date):
        return kursy.get((w.upper(), d), (None, None))

    for lista in platnosci.values():
        for pl in lista:
            if pl.waluta != "PLN":
                pl.data_kursu, pl.kurs = kurs(pl.waluta, pl.data or jutro)

    # ── grupy i pozycje per kontener ───────────────────────────────
    lot_po_id = {l["id"]: l for l in loty}
    poz_k: Dict[int, List[Pozycja]] = {}
    meta: Dict[int, Dict[str, Any]] = {}
    for r in pozycje:
        k = po_k[r["container_id"]]
        gid = r["lot_id"] if k["skonsolidowany"] and r["lot_id"] in lot_po_id else 0
        cbm, cbm_zrodlo = compute_effective_cbm(dict(r))
        poz_k.setdefault(r["container_id"], []).append(Pozycja(
            item_id=r["item_id"], sku=(r["sku"] or "").strip(), szt=int(r["quantity"] or 0),
            unit_cost=float(r["unit_cost"] or 0), cbm_szt=cbm, grupa=gid, firma=r["firma"],
            kod_cn=r["kod_cn"], stawka_slownik=stawka_dla(stawki, r["kod_cn"]),
            cena_reczna=_f(r["cena_waluta"]), stawka_reczna=_f(r["stawka_cla"]), gratis=bool(r["gratis"]),
            cena_kontener=_f(r["cena_kontener"]),
        ))
        meta[r["item_id"]] = {"container_id": r["container_id"], "lot_id": r["lot_id"], "firma": r["firma"],
                              "cbm_szt": cbm, "cbm_zrodlo": cbm_zrodlo}

    out: Dict[int, Wynik] = {}
    wejscie: Dict[int, tuple] = {}
    for cid, lista in poz_k.items():
        k = po_k[cid]
        grupy: List[Grupa] = []
        for gid in sorted({x.grupa for x in lista}):
            l = lot_po_id.get(gid) if gid else None
            wal_towaru = _waluta(l["waluta_towaru"] if l else None, k["waluta_towaru"])
            wal_balance = ((l["balance_waluta"] if l else k["balance_waluta"]) or "").strip().upper()
            pl = platnosci.get((cid, gid), [])
            d_ost, k_ost = kurs(wal_towaru, jutro)
            grupy.append(Grupa(
                id=gid, platnosci=pl,
                # Ta sama reguła co dotąd w zakładce „Cena”: PLN w walucie towaru ALBO balance
                # (formularz zostawia „USD” w walucie towaru nawet przy polskiej fakturze).
                krajowa="PLN" in (wal_towaru, wal_balance),
                waluta=wal_towaru, kurs_ostatni=k_ost, data_kursu_ostatniego=d_ost,
                nazwa=(l["nazwa"] or "") if l else "",
                dostawca_id=l["manufacturer_id"] if l else None,
            ))
        # Dodatkowe koszty do grup: przypięte pozycje wskazują lot same; bez przypięcia — producent
        # lotu (kontener skonsolidowany) albo cały kontener. Pozycje spoza lotu odpadają.
        grupa_poz = {x.item_id: x.grupa for x in lista}
        po_id = {g.id: g for g in grupy}
        for d in dodatkowe.get(cid, []):
            # Osobna pozycja nie ma przypięć — idzie tylko z płatności lotu/kontenera.
            przypiete = [] if d.get("osobna") else [i for i in (d.get("item_ids") or []) if i in grupa_poz]
            if przypiete:
                gid = grupa_poz[przypiete[0]]
            else:
                gid = next((g.id for g in grupy if d.get("manufacturer_id") is not None
                            and g.dostawca_id == d.get("manufacturer_id")),
                           next((g.id for g in grupy if not g.krajowa), None))
            g = po_id.get(gid)
            if g is None or g.krajowa:
                continue
            g.koszty.append(KosztDodatkowy(nazwa=d["nazwa"], kwota=float(d["kwota"] or 0),
                                           pozycje=[i for i in przypiete if grupa_poz[i] == gid], kontener=cid,
                                           osobna=bool(d.get("osobna")), szt=d.get("szt") or None))
        n = nadpisania.get(cid)
        data_frachtu = k["delivered_date"] or k["eta_date"] or jutro
        d_fr, k_fr = kurs("USD", data_frachtu)
        kont = Kontener(
            fracht_usd=float(k["koszt_transportu"] or 0), kurs_frachtu=k_fr, data_kursu_frachtu=d_fr,
            transport_pln=float(k["koszt_transportu_magazyn"] or 0),
            kurs_towaru=_f(n.get("kurs_towaru")) if n else None,
            fracht_pln=_f(n.get("fracht_pln")) if n else None,
            lenmar_pln=_f(n.get("lenmar_pln")) if n else None,
            transport_reczny=_f(n.get("transport_pln")) if n else None,
        )
        wejscie[cid] = (kont, grupy, lista, data_frachtu)

    # Wspólna faktura: kontenery z tym samym rozliczenie_grupa liczą towar razem. Tylko
    # zwykłe kontenery z importu — skonsolidowany ma płatności per lot, krajowy nie ma czego dzielić.
    pule: Dict[int, List[int]] = {}
    for cid, (_, grupy, _, _) in wejscie.items():
        g = po_k[cid]["rozliczenie_grupa"]
        if g is not None and not po_k[cid]["skonsolidowany"] and len(grupy) == 1 and not grupy[0].krajowa:
            pule.setdefault(g, []).append(cid)
    for cidy in pule.values():
        if len(cidy) < 2:
            continue
        for cid, w in policz_razem({c: (wejscie[c][0], wejscie[c][1][0], wejscie[c][2]) for c in cidy}).items():
            w.data_frachtu = wejscie[cid][3]
            out[cid] = w
    for cid, (kont, grupy, lista, data_frachtu) in wejscie.items():
        if cid not in out:
            out[cid] = policz(kont, grupy, lista)
            out[cid].data_frachtu = data_frachtu
    return out, meta
