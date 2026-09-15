"""Życie produktu — historia zakupów i odtworzony stan magazynu.

WIDOCZNE WYŁĄCZNIE DLA SUPER-ADMINA. Celowo NIE ma tu klucza
uprawnienia i celowo nie dopisujemy nic do `PERMISSIONS` we
froncie: ptaszek w formularzu użytkownika mógłby sobie postawić
każdy z `manageUsers`, a super-admin jest przypięty do adresu
z ENV i nie da się go nadać z UI.

DWA ŹRÓDŁA, JEDEN KONTRAKT
--------------------------
Endpoint przyjmuje `?shop=` — ten sam parametr, którym posługuje się
globalny fragmentator firm (`lib/shop.tsx`) i reszta widoków. Od niego
zależy źródło:

    shop = "" albo firma z is_self = true   → Subiekt   (AMH)
    shop = firma z is_self = false          → Fakturownia (Acti, Veluxa)

Model odpowiedzi jest identyczny w obu przypadkach, więc front nie
wymaga zmian poza doklejeniem `shop` do adresu.

Bez tego parametru zakładka kłamała: na Veluxie „Przegląd" pokazywał
71 szt ze stanu Fakturowni, a „Historia produktu" 12 szt z Subiekta —
bo historia szła na sztywno do tabel AMH, niezależnie od tego, jaką
firmę ma wybraną użytkownik.

ŹRÓDŁA — SUBIEKT
----------------
· subiekt_przyjecia      — wiersz na warstwę przyjęcia, od 07.2023
· subiekt_rozchody_mies  — SKU × miesiąc × magazyn × typ
· subiekt_dwa_magazyny   — stan na dziś (punkt zaczepienia krzywej)

Zasila je skrypt `subiekt_historia.py` z maszyny przy Subiekcie.

ŹRÓDŁA — FAKTUROWNIA
--------------------
· fakturownia_ruchy   — ledger ruchów (services/fakturownia_history.py)
· fakturownia_stock   — stan na dziś, stan_podstawowy + in_transit_qty

Kotwicą jest suma obu magazynów, nie sam główny. Na Veluxie magazyn
główny ma 71 szt Pod_1b, a 1000 szt siedzi w „Towary w drodze" —
kotwiczenie na samym głównym przesuwałoby całą krzywą o tysiąc sztuk.

KRZYWA STANU — dlaczego wstecz, a nie od zera
----------------------------------------------
Stan liczymy od DZIŚ i cofamy się deltami. Liczenie od zera przez trzy
lata znaczyłoby, że jeden nieprzewidziany rodzaj ruchu w 2023 przesuwa
całą krzywą aż do dzisiaj. Kotwicząc na dzisiejszym stanie mamy „dziś"
dokładne z definicji, a błąd klasyfikacji objawia się dryfem im dalej
wstecz — czyli tam, gdzie jest najmniej istotny. `dryf` wystawiamy w
odpowiedzi zamiast go chować.

ROZCHÓD ≠ SPRZEDAŻ
------------------
W obu źródłach rozróżniamy rodzaj rozchodu, bo RW, KPZ i przesunięcia
zdejmują towar ze stanu, ale nie są sprzedażą. Stąd dwie agregacje:

  · krzywa stanu  — wszystko poza PRZESUNIECIE  (pole `wydano`)
  · marża i popyt — wyłącznie WYDANIE           (pole `sprzedano`)

Mieszanie ich daje ujemne marże w miesiącach z dużym RW.

RÓŻNICE FAKTUROWNI, KTÓRE WIDAĆ NA EKRANIE
-------------------------------------------
1. `logistyka_pln` zostaje puste. Fakturownia nie rozbija kosztu na
   towar i fracht — `purchase_price_net` to cena od dostawcy i nic
   poza nią. Kwota „Sprowadzono" znaczy więc co innego niż przy AMH
   i front musi to podpisać, a nie zestawiać wprost.
2. Korekty WZK netują sprzedaż zamiast wchodzić do przyjęć. Wracają
   towar na stan, ale są niedoszłą sprzedażą, nie zakupem. Na SZP1 to
   398 szt wydań wobec 358 szt realnych — 10% różnicy w popycie.
3. Ruch wewnątrz grupy (`is_internal`) wypada ze „Sprowadzono" i z
   listy dostawców. AMH jest trzecim „dostawcą" Acti z 543 szt, a
   4687 z 7865 szt rozchodu Veluxy idzie do AMH — bez tego marża
   liczyłaby się od ceny transferowej do własnej spółki.
"""

from datetime import date
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import CurrentUser
from security import get_current_user

router = APIRouter(prefix="/api", tags=["lifecycle"])


# Magazyny Subiekta, między którymi ruch jest wewnętrzny.
MAGAZYN_PODSTAWOWY = 100000
MAGAZYN_W_DRODZE = 100001
MAGAZYNY = (MAGAZYN_PODSTAWOWY, MAGAZYN_W_DRODZE)


# ===== DOSTĘP =====

def require_super_admin(
    user: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    """Wpuszcza wyłącznie adres z SUPER_ADMIN_EMAIL."""
    super_email = (settings.SUPER_ADMIN_EMAIL or "").strip().lower()

    if not super_email:
        raise HTTPException(404, "Nie znaleziono")

    if not user or (user.email or "").strip().lower() != super_email:
        # 404, nie 403 — brak wskazówki, że taki endpoint istnieje.
        raise HTTPException(404, "Nie znaleziono")

    return user


# ===== MODELE =====

class Przyjecie(BaseModel):
    data: date
    typ: str
    magazyn_id: int
    magazyn_zrodlowy: Optional[int] = None
    ilosc: float
    koszt_jednostkowy: Optional[float] = None
    cena_waluta: Optional[float] = None
    kurs: Optional[float] = None
    towar_pln: Optional[float] = None       # cena_waluta × kurs
    logistyka_pln: Optional[float] = None   # koszt − towar
    skorygowane: bool = False
    dokument: Optional[str] = None
    numer_dokumentu: Optional[str] = None
    dostawca: Optional[str] = None
    wewnetrzne: bool = False                # ruch wewnątrz grupy


class PunktStanu(BaseModel):
    miesiac: date
    przyjeto: float
    wydano: float
    sprzedano: float = 0.0
    stan: float                              # oba magazyny razem
    stan_polka: Optional[float] = None       # sam magazyn główny
    koszt_wlasny: Optional[float] = None


class Dostawca(BaseModel):
    nazwa: str
    przyjec: int
    ilosc: float
    od: date
    do: date
    sredni_koszt: Optional[float] = None


class Historia(BaseModel):
    sku: str
    # Kotwica krzywej = SUMA obu magazynów, bo ledger obejmuje oba. Ale sama
    # suma na kafelku wprowadzała w błąd: WP1 ma 0 szt na półce i 10 w drodze,
    # a kafelek pokazywał „10 na magazynie". Rozbicie idzie osobno, żeby front
    # mógł podpisać to uczciwie, nie zmieniając podstawy obliczeń.
    stan_dzis: float
    stan_magazyn: Optional[float] = None
    stan_w_drodze: Optional[float] = None
    pierwsze_przyjecie: Optional[date] = None
    liczba_zakupow: int
    sprowadzono_szt: float
    sprowadzono_pln: float
    przyjecia: List[Przyjecie]
    stan_miesiecznie: List[PunktStanu]
    dostawcy: List[Dostawca]
    miesiace_bez_pokrycia: List[date]
    dryf: float
    # Metadane źródła — front pokazuje plakietkę i wie, czego nie rysować.
    zrodlo: str = "subiekt"          # "subiekt" | "fakturownia"
    firma: Optional[str] = None      # slug firmy, z której są te dane
    ma_logistyke: bool = True        # False → moduł narzutu chowamy


# ===== ZAPYTANIA — SUBIEKT =====

Q_STAN = text("""
    SELECT COALESCE(stan_magazyn_podstawowy, 0) AS magazyn,
           COALESCE(stan_magazyn_w_drodze, 0)   AS w_drodze
    FROM subiekt_dwa_magazyny
    WHERE lower(sku) = lower(:sku)
    LIMIT 1
""")

Q_PRZYJECIA = text("""
    SELECT data, typ, magazyn_id, magazyn_zrodlowy, ilosc,
           koszt_jednostkowy, cena_waluta, kurs, skorygowane,
           dokument, numer_dokumentu, dostawca
    FROM subiekt_przyjecia
    WHERE lower(sku) = lower(:sku)
    ORDER BY data, przychod_id
""")

Q_ROZCHODY = text("""
    SELECT miesiac, magazyn_id, typ, ilosc, koszt_wlasny
    FROM subiekt_rozchody_mies
    WHERE lower(sku) = lower(:sku)
    ORDER BY miesiac
""")


# ===== ZAPYTANIA — FAKTUROWNIA =====

Q_FIRMA = text("""
    SELECT id, slug, COALESCE(is_self, FALSE) AS is_self
    FROM app_firmy
    WHERE lower(slug) = lower(:slug)
    LIMIT 1
""")

Q_F_RUCHY = text("""
    SELECT data, kind, typ, ilosc, magazyn_id, koszt_jednostkowy,
           numer_dokumentu, kontrahent, is_internal,
           COALESCE(w_drodze, FALSE) AS w_drodze
    FROM fakturownia_ruchy
    WHERE firma_id = :fid
      AND sku_canon = lower(:sku)
      AND data IS NOT NULL
    ORDER BY data, action_id
""")

Q_F_STAN = text("""
    SELECT COALESCE(stan_podstawowy, 0) AS magazyn,
           COALESCE(in_transit_qty, 0)  AS w_drodze
    FROM fakturownia_stock
    WHERE firma_id = :fid AND sku_canon = lower(:sku)
    LIMIT 1
""")


# ===== POMOCNICZE =====

def _kolejny_miesiac(d: date) -> date:
    return date(d.year + (d.month == 12), (d.month % 12) + 1, 1)


def _wewnetrzny(magazyn_zrodlowy, magazyn_id) -> bool:
    """Ruch między naszymi dwoma magazynami — nie zmienia stanu."""
    if magazyn_zrodlowy is None:
        return False
    return (
        magazyn_zrodlowy in MAGAZYNY
        and magazyn_zrodlowy != magazyn_id
    )


def _f(v) -> Optional[float]:
    return None if v is None else float(v)


def _int(v) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _zloz(
    sku: str,
    stan: Tuple[float, Optional[float], Optional[float]],
    przyjecia: List[Przyjecie],
    wejscia: Dict[date, float],
    wyjscia: Dict[date, float],
    sprzedaz: Dict[date, float],
    cogs: Dict[date, float],
    polka: Tuple[Dict[date, float], Dict[date, float]],
    zrodlo: str,
    firma: Optional[str],
    ma_logistyke: bool,
) -> Historia:
    """Wspólne domknięcie dla obu źródeł: krzywa stanu, dryf, dostawcy.

    Rozdzielenie „skąd dane" od „jak je złożyć" jest tu celowe — dzięki
    temu zmiana reguły krzywej albo definicji miesiąca bez pokrycia
    dotyczy obu firm naraz i nie da się ich rozjechać.
    """
    stan_dzis, stan_magazyn, stan_w_drodze = stan
    stan_polka = stan_magazyn

    if not wejscia and not wyjscia:
        raise HTTPException(404, f"Brak ruchów dla SKU {sku}")

    od = min(list(wejscia) + list(wyjscia))
    do = max(list(wejscia) + list(wyjscia))

    miesiace: List[date] = []
    kursor = od
    while kursor <= do:
        miesiace.append(kursor)
        kursor = _kolejny_miesiac(kursor)

    # Kotwica na dziś, cofanie deltami.
    stany: Dict[date, float] = {}
    biezacy = stan_dzis
    for m in reversed(miesiace):
        stany[m] = biezacy
        biezacy -= wejscia.get(m, 0.0) - wyjscia.get(m, 0.0)

    dryf = round(biezacy, 3)

    # DRUGA KRZYWA — sam magazyn główny.
    #
    # Pierwsza mówi, ile towaru NALEŻY do firmy, i to ona musi być kotwiczona
    # na sumie, bo ledger obejmuje oba magazyny, a przyjęcia z zagranicy lądują
    # wprost na „w drodze" (SZP1 ma tam 288 szt). Gdyby kotwicą była sama półka,
    # cała historia przesunęłaby się o wielkość towaru na wodzie.
    #
    # Ale to znaczy, że kontener płynący przez ocean potrafi zamaskować pusty
    # magazyn: krzywa rośnie, choć nie ma czym sprzedawać. Dlatego liczymy
    # równolegle stan samej półki i to na NIM wykrywamy miesiące bez pokrycia.
    # Tu ruch między magazynami już się nie znosi — wjazd z wody na półkę jest
    # prawdziwym przyjęciem i dokładnie o ten moment chodzi.
    wej_p, wyj_p = polka
    stany_p: Dict[date, float] = {}

    if stan_polka is not None and (wej_p or wyj_p):
        biezacy_p = stan_polka
        for m in reversed(miesiace):
            stany_p[m] = biezacy_p
            biezacy_p -= wej_p.get(m, 0.0) - wyj_p.get(m, 0.0)

    stan_miesiecznie = [
        PunktStanu(
            miesiac=m,
            przyjeto=round(wejscia.get(m, 0.0), 3),
            wydano=round(wyjscia.get(m, 0.0), 3),
            sprzedano=round(sprzedaz.get(m, 0.0), 3),
            stan=round(stany[m], 3),
            stan_polka=(round(stany_p[m], 3) if m in stany_p else None),
            koszt_wlasny=cogs.get(m),
        )
        for m in miesiace
    ]

    # Pokrycie liczymy na półce, jeśli ją mamy — inaczej miesiąc z pustym
    # magazynem i pełnym kontenerem na wodzie wyglądałby na zaopatrzony.
    bez_pokrycia = [
        p.miesiac
        for p in stan_miesiecznie
        if p.sprzedano > 0
        and (p.stan_polka if p.stan_polka is not None else p.stan) < p.sprzedano
    ]

    # Dostawcy — wyłącznie realne zakupy z zewnątrz.
    agg: Dict[str, dict] = {}
    for p in przyjecia:
        if p.typ != "ZAKUP" or not p.dostawca:
            continue
        a = agg.setdefault(p.dostawca, {
            "przyjec": 0, "ilosc": 0.0, "wartosc": 0.0,
            "od": p.data, "do": p.data,
        })
        a["przyjec"] += 1
        a["ilosc"] += p.ilosc
        a["od"] = min(a["od"], p.data)
        a["do"] = max(a["do"], p.data)
        if p.koszt_jednostkowy is not None:
            a["wartosc"] += p.ilosc * p.koszt_jednostkowy

    dostawcy = [
        Dostawca(
            nazwa=nazwa,
            przyjec=a["przyjec"],
            ilosc=round(a["ilosc"], 3),
            od=a["od"],
            do=a["do"],
            sredni_koszt=(
                round(a["wartosc"] / a["ilosc"], 2) if a["ilosc"] else None
            ),
        )
        for nazwa, a in sorted(agg.items(), key=lambda kv: kv[1]["od"])
    ]

    zakupy = [p for p in przyjecia if p.typ == "ZAKUP"]

    return Historia(
        sku=sku,
        stan_dzis=stan_dzis,
        stan_magazyn=stan_magazyn,
        stan_w_drodze=stan_w_drodze,
        pierwsze_przyjecie=przyjecia[0].data if przyjecia else None,
        liczba_zakupow=len(zakupy),
        sprowadzono_szt=round(sum(p.ilosc for p in zakupy), 3),
        sprowadzono_pln=round(
            sum(
                p.ilosc * p.koszt_jednostkowy
                for p in zakupy
                if p.koszt_jednostkowy is not None
            ),
            2,
        ),
        przyjecia=przyjecia,
        stan_miesiecznie=stan_miesiecznie,
        dostawcy=dostawcy,
        miesiace_bez_pokrycia=bez_pokrycia,
        dryf=dryf,
        zrodlo=zrodlo,
        firma=firma,
        ma_logistyke=ma_logistyke,
    )


# ===== ŹRÓDŁO: SUBIEKT =====

async def _historia_subiekt(db: AsyncSession, sku: str) -> Historia:
    przyjecia_rows = (
        await db.execute(Q_PRZYJECIA, {"sku": sku})
    ).mappings().all()

    rozchody_rows = (
        await db.execute(Q_ROZCHODY, {"sku": sku})
    ).mappings().all()

    if not przyjecia_rows and not rozchody_rows:
        raise HTTPException(404, f"Brak historii dla SKU {sku}")

    stan_row = (await db.execute(Q_STAN, {"sku": sku})).first()
    mag = float(stan_row[0]) if stan_row else 0.0
    drodze = float(stan_row[1]) if stan_row else 0.0

    przyjecia: List[Przyjecie] = []
    for r in przyjecia_rows:
        koszt = _f(r["koszt_jednostkowy"])
        cena = _f(r["cena_waluta"])
        kurs = _f(r["kurs"])

        towar = (
            round(cena * kurs, 4)
            if cena is not None and kurs is not None
            else None
        )

        przyjecia.append(Przyjecie(
            data=r["data"],
            typ=r["typ"],
            magazyn_id=r["magazyn_id"],
            magazyn_zrodlowy=r["magazyn_zrodlowy"],
            ilosc=float(r["ilosc"]),
            koszt_jednostkowy=koszt,
            cena_waluta=cena,
            kurs=kurs,
            towar_pln=towar,
            logistyka_pln=(
                round(koszt - towar, 4)
                if koszt is not None and towar is not None
                else None
            ),
            skorygowane=bool(r["skorygowane"]),
            dokument=r["dokument"],
            numer_dokumentu=r["numer_dokumentu"],
            dostawca=r["dostawca"],
        ))

    wejscia: Dict[date, float] = {}
    wyjscia: Dict[date, float] = {}
    sprzedaz: Dict[date, float] = {}
    cogs_wartosc: Dict[date, float] = {}
    cogs_ilosc: Dict[date, float] = {}
    # Ruchy samego magazynu podstawowego — druga krzywa. Przesunięcie z „w
    # drodze" na półkę JEST tu wejściem, w przeciwieństwie do krzywej łącznej.
    wej_p: Dict[date, float] = {}
    wyj_p: Dict[date, float] = {}

    for r in przyjecia_rows:
        m = r["data"].replace(day=1)

        if r["magazyn_id"] == MAGAZYN_PODSTAWOWY:
            wej_p[m] = wej_p.get(m, 0.0) + float(r["ilosc"])

        if _wewnetrzny(r["magazyn_zrodlowy"], r["magazyn_id"]):
            continue
        wejscia[m] = wejscia.get(m, 0.0) + float(r["ilosc"])

    for r in rozchody_rows:
        typ = r["typ"]
        m = r["miesiac"]
        ilosc = float(r["ilosc"])

        if r["magazyn_id"] == MAGAZYN_PODSTAWOWY:
            wyj_p[m] = wyj_p.get(m, 0.0) + ilosc

        if typ == "PRZESUNIECIE":
            continue

        wyjscia[m] = wyjscia.get(m, 0.0) + ilosc

        if typ != "WYDANIE":
            continue

        sprzedaz[m] = sprzedaz.get(m, 0.0) + ilosc

        if r["koszt_wlasny"] is not None:
            cogs_wartosc[m] = (
                cogs_wartosc.get(m, 0.0) + ilosc * float(r["koszt_wlasny"])
            )
            cogs_ilosc[m] = cogs_ilosc.get(m, 0.0) + ilosc

    cogs = {
        m: round(cogs_wartosc[m] / cogs_ilosc[m], 4)
        for m in cogs_ilosc
        if cogs_ilosc[m]
    }

    return _zloz(
        sku, (mag + drodze, mag, drodze), przyjecia, wejscia, wyjscia,
        sprzedaz, cogs, (wej_p, wyj_p),
        zrodlo="subiekt", firma="amh", ma_logistyke=True,
    )


# ===== ŹRÓDŁO: FAKTUROWNIA =====

async def _historia_fakturownia(
    db: AsyncSession, sku: str, firma_id: int, slug: str,
) -> Historia:
    rows = (
        await db.execute(Q_F_RUCHY, {"fid": firma_id, "sku": sku})
    ).mappings().all()

    if not rows:
        raise HTTPException(404, f"Brak historii dla SKU {sku}")

    stan_row = (
        await db.execute(Q_F_STAN, {"fid": firma_id, "sku": sku})
    ).first()
    mag = float(stan_row[0]) if stan_row else 0.0
    drodze = float(stan_row[1]) if stan_row else 0.0

    przyjecia: List[Przyjecie] = []
    wejscia: Dict[date, float] = {}
    wyjscia: Dict[date, float] = {}
    sprzedaz: Dict[date, float] = {}
    cogs_wartosc: Dict[date, float] = {}
    cogs_ilosc: Dict[date, float] = {}
    wej_p: Dict[date, float] = {}
    wyj_p: Dict[date, float] = {}

    for r in rows:
        typ = r["typ"]

        # Półka: liczymy po surowym znaku, bez wyjątków na przesunięcia —
        # `mm+` to realny wjazd towaru z wody na magazyn i ma się liczyć.
        if not r["w_drodze"]:
            q = float(r["ilosc"])
            m_p = r["data"].replace(day=1)
            if q > 0:
                wej_p[m_p] = wej_p.get(m_p, 0.0) + q
            elif q < 0:
                wyj_p[m_p] = wyj_p.get(m_p, 0.0) - q

        # Przesunięcie między magazynem głównym a „w drodze" ma w ledgerze
        # dwa wiersze (mm- i mm+) i sumuje się do zera. Wypada z obu stron,
        # tak samo jak ruch wewnętrzny po stronie Subiekta.
        if typ == "PRZESUNIECIE":
            continue

        ilosc = float(r["ilosc"])
        if ilosc == 0:
            continue                      # inwentaryzacja bez korekty

        m = r["data"].replace(day=1)
        koszt = _f(r["koszt_jednostkowy"])

        if typ == "WYDANIE":
            # wz (ujemne) i wzk (dodatnie) do jednego kubełka — netto.
            wyjscia[m] = wyjscia.get(m, 0.0) - ilosc
            sprzedaz[m] = sprzedaz.get(m, 0.0) - ilosc

            if koszt is not None and ilosc < 0:
                cogs_wartosc[m] = cogs_wartosc.get(m, 0.0) + (-ilosc) * koszt
                cogs_ilosc[m] = cogs_ilosc.get(m, 0.0) + (-ilosc)
            continue

        if ilosc > 0:
            wejscia[m] = wejscia.get(m, 0.0) + ilosc
            przyjecia.append(Przyjecie(
                data=r["data"],
                typ=typ,
                magazyn_id=_int(r["magazyn_id"]),
                ilosc=ilosc,
                koszt_jednostkowy=koszt,
                # Fakturownia nie zna frachtu ani cła — świadomie zostaje
                # puste zamiast zera, żeby front umiał to odróżnić.
                logistyka_pln=None,
                dokument=(r["kind"] or "").upper(),
                numer_dokumentu=r["numer_dokumentu"],
                dostawca=r["kontrahent"],
                wewnetrzne=bool(r["is_internal"]),
            ))
        else:
            # RW, zwrot do dostawcy — schodzi ze stanu, nie jest sprzedażą.
            wyjscia[m] = wyjscia.get(m, 0.0) - ilosc

    cogs = {
        m: round(cogs_wartosc[m] / cogs_ilosc[m], 4)
        for m in cogs_ilosc
        if cogs_ilosc[m]
    }

    return _zloz(
        sku, (mag + drodze, mag, drodze), przyjecia, wejscia, wyjscia,
        sprzedaz, cogs, (wej_p, wyj_p),
        zrodlo="fakturownia", firma=slug, ma_logistyke=False,
    )


# ===== ENDPOINT =====

async def _rozstrzygnij_zrodlo(
    db: AsyncSession, shop: str,
) -> Tuple[Optional[int], str]:
    """(firma_id, slug) dla Fakturowni albo (None, 'amh') dla Subiekta.

    Pusty `shop` (fragmentator na „Wszyscy") daje Subiekta — nie sumujemy
    dwóch ERP-ów w jedną krzywą. Front pokazuje wtedy plakietkę, z której
    firmy są dane, i odnośnik do drugiej spółki, jeśli ten SKU tam żyje.
    """
    slug = (shop or "").strip().lower()
    if not slug:
        return None, "amh"

    row = (await db.execute(Q_FIRMA, {"slug": slug})).mappings().first()
    if not row or row["is_self"]:
        return None, slug or "amh"

    return int(row["id"]), slug


@router.get("/products/{sku}/historia", response_model=Historia)
async def historia_produktu(
    sku: str,
    shop: str = Query("", description="slug firmy z fragmentatora"),
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_super_admin),
):
    firma_id, slug = await _rozstrzygnij_zrodlo(db, shop)

    if firma_id is None:
        return await _historia_subiekt(db, sku)

    return await _historia_fakturownia(db, sku, firma_id, slug)


@router.get("/products/{sku}/historia-firmy")
async def historia_firmy(
    sku: str,
    db: AsyncSession = Depends(get_db),
    user: CurrentUser = Depends(require_super_admin),
):
    """Które spółki mają historię tego SKU — zapala przełącznik we froncie.

    Dopasowanie idzie po symbolu (`sku_canon`), nie po EAN. Przy dziesięciu
    produktach żyjących w dwóch spółkach to wystarcza i jest sprawdzalne
    ręcznie; budowanie dopasowywania po EAN byłoby tu przerostem formy.
    """
    out: List[dict] = []

    subiekt = (await db.execute(text(
        "SELECT MIN(data) AS od, MAX(data) AS do, COUNT(*) AS ile "
        "FROM subiekt_przyjecia WHERE lower(sku) = lower(:sku)"
    ), {"sku": sku})).mappings().first()

    if subiekt and subiekt["ile"]:
        out.append({
            "firma": "amh",
            "zrodlo": "subiekt",
            "od": subiekt["od"],
            "do": subiekt["do"],
            "przyjec": int(subiekt["ile"]),
        })

    fakturownia = (await db.execute(text(
        "SELECT f.slug, MIN(r.data) AS od, MAX(r.data) AS do, "
        "       COUNT(*) FILTER (WHERE r.ilosc > 0) AS przyjec "
        f"FROM fakturownia_ruchy r "
        f"JOIN {settings.TABLE_FIRMY} f ON f.id = r.firma_id "
        "WHERE r.sku_canon = lower(:sku) "
        "GROUP BY f.slug ORDER BY f.slug"
    ), {"sku": sku})).mappings().all()

    for r in fakturownia:
        out.append({
            "firma": r["slug"],
            "zrodlo": "fakturownia",
            "od": r["od"],
            "do": r["do"],
            "przyjec": int(r["przyjec"] or 0),
        })

    return {"sku": sku, "firmy": out}
