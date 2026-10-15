"""Zakładka „Pliki” — logika: drzewo folderów, foldery automatyczne, kosz, styk z kontenerem.

Układ (ustalony z właścicielem):
  Producenci / <producent> / <kontener>   ← zakładane SAME z danych kontenerów
  + dowolne foldery ręczne (gdziekolwiek, także w środku folderu kontenera).

Kontener skonsolidowany (partie od kilku producentów) ma folder u KAŻDEGO swojego producenta,
pod tym samym numerem. Plik wrzucony na karcie kontenera trafia do folderu wybranego producenta.

Kontener ↔ Pliki w jedną stronę: plik z karty kontenera zawsze ląduje w jego folderze tutaj
(z ptaszkiem „pokaż na kontenerze”); plik wrzucony tutaj widać na karcie kontenera tylko z ptaszkiem.
Plik istnieje raz — nie ma kopii, które mogłyby się rozjechać.

Kosz: usunięcie = usuniety_at. Folder w koszu chowa całą swoją zawartość (bez przepisywania
dzieci). Po KOSZ_DNI dniach (albo „usuń na zawsze”) plik znika też z bucketu.
"""

import re
import time
import uuid
from datetime import datetime
from typing import Dict, Iterable, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from services import pliki_storage

KOSZ_DNI = 30
MAX_PLIK_BYTES = 50 * 1024 * 1024        # limit bucketu w Supabase (plan darmowy) to 50 MB

F = settings.TABLE_PLIKI_FOLDERY
P = settings.TABLE_PLIKI

# Foldery, których nie da się zmienić ręcznie. Wyjątek: folder kontenera/producenta, którego
# kontener lub producent zniknął z bazy (FK → NULL) — wtedy to zwykły folder z plikami.
AUTOMATYCZNE = ("producenci", "producent", "kontener")


def jest_automatyczny(rodzaj: str, manufacturer_id: Optional[int], container_id: Optional[int]) -> bool:
    if rodzaj == "producenci":
        return True
    if rodzaj == "producent":
        return manufacturer_id is not None
    if rodzaj == "kontener":
        return container_id is not None
    return False


# ── Nazwy, rozmiary, typy ────────────────────────────────────────────────────

_ZAKAZANE = re.compile(r'[\x00-\x1f/\\]')


def czysta_nazwa(nazwa: Optional[str], domyslna: str = "plik") -> str:
    """Nazwa pliku/folderu do pokazania: bez ukośników i znaków sterujących, przycięta do 200 znaków
    (z zachowaniem rozszerzenia). Ścieżka w buckecie i tak jest losowa — to tylko etykieta."""
    n = _ZAKAZANE.sub(" ", (nazwa or "")).strip().strip(".").strip()
    if not n:
        return domyslna
    if len(n) > 200:
        if "." in n[-12:]:
            base, ext = n.rsplit(".", 1)
            n = base[:200 - len(ext) - 1] + "." + ext
        else:
            n = n[:200]
    return n


def ludzki_rozmiar(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n} B"


def typ_pliku(nazwa: str) -> str:
    ext = nazwa.rsplit(".", 1)[-1].lower() if "." in nazwa else ""
    if ext == "pdf":
        return "pdf"
    if ext in ("xlsx", "xls", "csv"):
        return "excel"
    if ext in ("png", "jpg", "jpeg", "webp", "gif"):
        return "image"
    if ext in ("zip", "rar", "7z"):
        return "zip"
    if ext == "xml":
        return "xml"
    if ext in ("doc", "docx"):
        return "word"
    return ext or "other"


def nowa_sciezka(nazwa: str) -> str:
    """Ścieżka w buckecie: losowa, z samym rozszerzeniem. Polskie znaki i spacje w nazwach
    kluczy Storage bywają kłopotliwe, a prawdziwa nazwa i tak siedzi w bazie."""
    ext = nazwa.rsplit(".", 1)[-1].lower() if "." in nazwa else ""
    ext = re.sub(r"[^a-z0-9]", "", ext)[:10]
    return f"pliki/{datetime.now():%Y/%m}/{uuid.uuid4().hex}" + (f".{ext}" if ext else "")


# ── Foldery automatyczne ─────────────────────────────────────────────────────

# Pary (kontener, producent): producenci partii kontenera, a gdy partii z producentem brak —
# producent z nagłówka kontenera. Bez żadnego producenta: para (kontener, NULL) — folder trafia
# wtedy wprost pod „Producenci”, żeby wrzucony plik miał gdzie leżeć.
_PARY_SQL = f"""
    SELECT DISTINCT l.container_id, l.manufacturer_id
      FROM {settings.TABLE_CONTAINER_LOTS} l
     WHERE l.manufacturer_id IS NOT NULL {{lot_where}}
    UNION
    SELECT c.id, c.manufacturer_id
      FROM {settings.TABLE_CONTAINERS} c
     WHERE NOT EXISTS (SELECT 1 FROM {settings.TABLE_CONTAINER_LOTS} l
                        WHERE l.container_id = c.id AND l.manufacturer_id IS NOT NULL) {{c_where}}
"""

# Nazwa folderu kontenera liczona w bazie — to samo co audit_opisy.etykieta_kontenera
# (prawdziwy nr, inaczej „FV: …”, inaczej „#id”), żeby nazwy brać jednym zapytaniem.
# {c_where} zawęża do jednego kontenera przy wgrywaniu z karty.
_ETYKIETY_CTE = f"""
    etykiety AS (
        SELECT x.id,
               CASE WHEN x.nr <> '' AND LOWER(x.nr) NOT LIKE 'draft-%' THEN x.nr
                    WHEN x.fv <> '' THEN 'FV: ' || x.fv
                    ELSE '#' || x.id END AS nazwa
          FROM (
            SELECT c.id, TRIM(COALESCE(c.container_number, '')) AS nr,
                   TRIM(COALESCE(NULLIF(TRIM(c.order_number), ''),
                        (SELECT l.order_number FROM {settings.TABLE_CONTAINER_LOTS} l
                          WHERE l.container_id = c.id AND NULLIF(TRIM(l.order_number), '') IS NOT NULL
                          ORDER BY l.position, l.id LIMIT 1), '')) AS fv
              FROM {settings.TABLE_CONTAINERS} c WHERE TRUE {{c_where}}
          ) x
    )
"""

_ostatnia_synchronizacja = {"t": 0.0}
SYNC_CO_SEKUND = 60


async def pary_kontenera(db: AsyncSession, cid: int) -> List[Optional[int]]:
    """Producenci, u których kontener ma folder (kolejność: partie wg pozycji)."""
    r = await db.execute(text(f"""
        SELECT l.manufacturer_id FROM {settings.TABLE_CONTAINER_LOTS} l
         WHERE l.container_id = :c AND l.manufacturer_id IS NOT NULL
         GROUP BY l.manufacturer_id ORDER BY MIN(l.position), MIN(l.id)
    """), {"c": cid})
    ids = [row[0] for row in r]
    if ids:
        return ids
    m = (await db.execute(text(f"SELECT manufacturer_id FROM {settings.TABLE_CONTAINERS} WHERE id = :c"),
                          {"c": cid})).scalar()
    return [m]


async def synchronizuj_foldery(db: AsyncSession, *, wymus: bool = False, cid: Optional[int] = None) -> None:
    """Zakłada brakujące foldery „Producenci / producent / kontener”, poprawia ich nazwy
    (zmiana nazwy producenta, numer kontenera wpisany po wypłynięciu) i sprząta PUSTE foldery
    kontenerów, które już nie pasują (producent zniknął z kontenera, kontener usunięty).
    Folder z plikami nigdy nie znika sam — zostaje tam, gdzie był.

    Wołane przy przeglądaniu (najwyżej co SYNC_CO_SEKUND) i zawsze przed wgraniem pliku na kontener.
    `cid` zawęża zakładanie folderów kontenerów do jednego kontenera (szybciej przy wgrywaniu)."""
    teraz = time.monotonic()
    if not wymus and cid is None and teraz - _ostatnia_synchronizacja["t"] < SYNC_CO_SEKUND:
        return

    await db.execute(text(f"""
        INSERT INTO {F} (parent_id, nazwa, rodzaj) VALUES (NULL, 'Producenci', 'producenci')
        ON CONFLICT (rodzaj) WHERE rodzaj = 'producenci' DO NOTHING
    """))
    root = (await db.execute(text(f"SELECT id FROM {F} WHERE rodzaj = 'producenci'"))).scalar()

    await db.execute(text(f"""
        INSERT INTO {F} (parent_id, nazwa, rodzaj, manufacturer_id)
        SELECT :root, m.name, 'producent', m.id FROM {settings.TABLE_MANUFACTURERS} m
        ON CONFLICT (manufacturer_id) WHERE rodzaj = 'producent' DO NOTHING
    """), {"root": root})
    await db.execute(text(f"""
        UPDATE {F} f SET nazwa = m.name FROM {settings.TABLE_MANUFACTURERS} m
         WHERE f.rodzaj = 'producent' AND f.manufacturer_id = m.id AND f.nazwa IS DISTINCT FROM m.name
    """))

    params: Dict = {"root": root}
    # Kontener bez żadnego producenta dostaje folder dopiero, gdy ktoś coś na niego wrzuci (cid podany) —
    # inaczej „Producenci” zarosłyby pustymi folderami luzem.
    lot_where, c_where = "", "AND c.manufacturer_id IS NOT NULL"
    if cid is not None:
        lot_where, c_where, params["cid"] = "AND l.container_id = :cid", "AND c.id = :cid", cid
    pary = _PARY_SQL.format(lot_where=lot_where, c_where=c_where)
    c_where_e = "AND c.id = :cid" if cid is not None else ""

    # Wszystko zbiorczo, po jednym zapytaniu — pierwsza wersja szła pętlą po kontenerach
    # (setki wymian z Supabase przy każdym wejściu w Pliki, kilka sekund czekania).
    await db.execute(text(f"""
        WITH pary AS ({pary}), {_ETYKIETY_CTE.format(c_where=c_where_e)}
        INSERT INTO {F} (parent_id, nazwa, rodzaj, manufacturer_id, container_id)
        SELECT COALESCE(pf.id, :root), e.nazwa, 'kontener', p.manufacturer_id, p.container_id
          FROM pary p(container_id, manufacturer_id)
          JOIN etykiety e ON e.id = p.container_id
          LEFT JOIN {F} pf ON pf.rodzaj = 'producent' AND pf.manufacturer_id = p.manufacturer_id
        ON CONFLICT (container_id, (COALESCE(manufacturer_id, 0))) WHERE rodzaj = 'kontener' DO NOTHING
    """), params)
    # Nazwy folderów kontenerów nadążają za numerem kontenera (Draft → prawdziwy nr).
    await db.execute(text(f"""
        WITH {_ETYKIETY_CTE.format(c_where=c_where_e)}
        UPDATE {F} f SET nazwa = e.nazwa FROM etykiety e
         WHERE f.rodzaj = 'kontener' AND f.container_id = e.id AND f.nazwa IS DISTINCT FROM e.nazwa
    """), params)

    if cid is None:
        # Puste foldery kontenerów, które już nie pasują do żadnej pary — do usunięcia.
        await db.execute(text(f"""
            DELETE FROM {F} f
             WHERE f.rodzaj = 'kontener'
               AND (f.container_id IS NULL OR f.manufacturer_id IS NULL OR NOT EXISTS (
                     SELECT 1 FROM ({pary}) p(container_id, manufacturer_id)
                      WHERE p.container_id = f.container_id
                        AND p.manufacturer_id IS NOT DISTINCT FROM f.manufacturer_id))
               AND NOT EXISTS (SELECT 1 FROM {P} x WHERE x.folder_id = f.id)
               AND NOT EXISTS (SELECT 1 FROM {F} x WHERE x.parent_id = f.id)
        """), params)
        _ostatnia_synchronizacja["t"] = teraz


async def folder_kontenera(db: AsyncSession, cid: int, manufacturer_id: Optional[int]) -> int:
    """Id folderu (kontener, producent) — po synchronizacji tego kontenera zawsze istnieje.
    Producent spoza kontenera (np. karta zapisana w międzyczasie) → pierwszy producent kontenera."""
    await synchronizuj_foldery(db, cid=cid)
    producenci = await pary_kontenera(db, cid)
    if manufacturer_id not in producenci:
        manufacturer_id = producenci[0] if producenci else None
    fid = (await db.execute(text(f"""
        SELECT id FROM {F} WHERE rodzaj = 'kontener' AND container_id = :k
           AND manufacturer_id IS NOT DISTINCT FROM :m
    """), {"k": cid, "m": manufacturer_id})).scalar()
    if fid is None:          # nie powinno się zdarzyć; awaryjnie dowolny folder tego kontenera
        fid = (await db.execute(text(f"SELECT id FROM {F} WHERE rodzaj = 'kontener' AND container_id = :k ORDER BY id LIMIT 1"),
                                {"k": cid})).scalar()
    if fid is None:
        raise ValueError(f"Brak folderu dla kontenera #{cid}")
    return fid


# ── Drzewo ───────────────────────────────────────────────────────────────────

# Foldery „martwe” = w koszu same albo pod folderem w koszu. Cała tabela folderów jest mała
# (setki wierszy), więc liczymy to rekurencyjnie przy każdym odczycie zamiast utrzymywać flagi.
MARTWE_CTE = f"""
    martwe AS (
        WITH RECURSIVE m(id) AS (
            SELECT id FROM {F} WHERE usuniety_at IS NOT NULL
            UNION
            SELECT f.id FROM {F} f JOIN m ON f.parent_id = m.id
        ) SELECT id FROM m
    )
"""


async def sciezka_folderu(db: AsyncSession, fid: Optional[int]) -> List[dict]:
    """Okruszki od korzenia do folderu (włącznie)."""
    if fid is None:
        return []
    r = await db.execute(text(f"""
        WITH RECURSIVE w(id, parent_id, nazwa, rodzaj, glebokosc) AS (
            SELECT id, parent_id, nazwa, rodzaj, 0 FROM {F} WHERE id = :id
            UNION ALL
            SELECT f.id, f.parent_id, f.nazwa, f.rodzaj, w.glebokosc + 1 FROM {F} f JOIN w ON f.id = w.parent_id
             WHERE w.glebokosc < 50
        ) SELECT id, nazwa, rodzaj FROM w ORDER BY glebokosc DESC
    """), {"id": fid})
    return [dict(x) for x in r.mappings().all()]


async def kontener_nad_folderem(db: AsyncSession, fid: Optional[int]) -> Optional[int]:
    """Kontener najbliższego folderu kontenera na drodze w górę (albo None)."""
    if fid is None:
        return None
    return (await db.execute(text(f"""
        WITH RECURSIVE w(id, parent_id, rodzaj, container_id, glebokosc) AS (
            SELECT id, parent_id, rodzaj, container_id, 0 FROM {F} WHERE id = :id
            UNION ALL
            SELECT f.id, f.parent_id, f.rodzaj, f.container_id, w.glebokosc + 1 FROM {F} f JOIN w ON f.id = w.parent_id
             WHERE w.glebokosc < 50
        ) SELECT container_id FROM w WHERE rodzaj = 'kontener' AND container_id IS NOT NULL
          ORDER BY glebokosc LIMIT 1
    """), {"id": fid})).scalar()


async def przelicz_kontenery_plikow(db: AsyncSession) -> None:
    """Po przeniesieniu folderu: każdy plik dostaje kontener swojego najbliższego folderu
    kontenera. Plik, który wyszedł spod kontenera, traci też ptaszek „pokaż na kontenerze”."""
    await db.execute(text(f"""
        WITH RECURSIVE d(id, cid, glebokosc) AS (
            SELECT id, CASE WHEN rodzaj = 'kontener' THEN container_id END, 0 FROM {F} WHERE parent_id IS NULL
            UNION ALL
            SELECT f.id, CASE WHEN f.rodzaj = 'kontener' AND f.container_id IS NOT NULL THEN f.container_id ELSE d.cid END,
                   d.glebokosc + 1
              FROM {F} f JOIN d ON f.parent_id = d.id WHERE d.glebokosc < 50
        )
        UPDATE {P} p SET container_id = d.cid,
                         pokaz_na_kontenerze = (p.pokaz_na_kontenerze AND d.cid IS NOT NULL)
          FROM d WHERE p.folder_id = d.id AND p.container_id IS DISTINCT FROM d.cid
    """))
    await db.execute(text(f"""
        UPDATE {P} SET container_id = NULL, pokaz_na_kontenerze = FALSE
         WHERE folder_id IS NULL AND container_id IS NOT NULL
    """))


async def czy_potomek(db: AsyncSession, kandydat: Optional[int], przodek: int) -> bool:
    """Czy folder `kandydat` leży w poddrzewie `przodek` (albo nim jest) — blokada pętli przy przenoszeniu."""
    if kandydat is None:
        return False
    return any(x["id"] == przodek for x in await sciezka_folderu(db, kandydat))


def plik_out(r) -> dict:
    nazwa = r["nazwa"]
    return {
        "id": r["id"], "nazwa": nazwa, "folder_id": r["folder_id"],
        "typ": typ_pliku(nazwa), "rozmiar": int(r["rozmiar"] or 0), "rozmiar_txt": ludzki_rozmiar(int(r["rozmiar"] or 0)),
        "content_type": r["content_type"], "container_id": r["container_id"],
        "pokaz_na_kontenerze": bool(r["pokaz_na_kontenerze"]), "dodano_z_kontenera": bool(r["dodano_z_kontenera"]),
        "dodano": r["dodano"], "dodal": r["dodal"],
    }


PLIK_KOLUMNY = ("id, folder_id, nazwa, content_type, rozmiar, container_id, pokaz_na_kontenerze, "
                "dodano_z_kontenera, dodano, dodal")


# ── Firmy (przełącznik AMH / Acti / Veluxa u góry) ──────────────────────────
# Kontener nie ma własnej firmy — wynika ona z właścicieli SKU w środku (bez firma_id = AMH),
# tak jak firma_breakdown na liście kontenerów. Folder kontenera u producenta należy do firm
# towaru TEGO producenta w kontenerze; folder producenta — do firm jego produktów i kontenerów.
_FIRMY_FOLDEROW_SQL = f"""
    WITH pa AS (
        SELECT DISTINCT ON (LOWER(TRIM(sku))) LOWER(TRIM(sku)) AS sku_canon, firma_id, manufacturer_id
          FROM {settings.TABLE_PRODUCT_ATTRS}
         WHERE sku IS NOT NULL AND TRIM(sku) <> ''
         ORDER BY LOWER(TRIM(sku)), updated_at DESC NULLS LAST
    ),
    kont AS (
        SELECT f.id, f.parent_id, LOWER(COALESCE(fi.slug, 'amh')) AS slug
          FROM {F} f
          JOIN {settings.TABLE_CONTAINER_ITEMS} ci ON ci.container_id = f.container_id
          LEFT JOIN {settings.TABLE_CONTAINER_LOTS} l ON l.id = ci.lot_id
          LEFT JOIN pa ON pa.sku_canon = LOWER(TRIM(ci.sku))
          LEFT JOIN {settings.TABLE_FIRMY} fi ON fi.id = pa.firma_id
         WHERE f.rodzaj = 'kontener' AND f.container_id IS NOT NULL
           -- pozycja bez partii albo partia bez producenta należy do każdego folderu tego kontenera
           AND (ci.lot_id IS NULL OR l.manufacturer_id IS NULL OR f.manufacturer_id IS NULL
                OR l.manufacturer_id = f.manufacturer_id)
    )
    SELECT id, slug FROM kont
    UNION
    SELECT parent_id, slug FROM kont WHERE parent_id IS NOT NULL
    UNION
    SELECT f.id, LOWER(COALESCE(fi.slug, 'amh'))
      FROM {F} f
      JOIN pa ON pa.manufacturer_id = f.manufacturer_id
      LEFT JOIN {settings.TABLE_FIRMY} fi ON fi.id = pa.firma_id
     WHERE f.rodzaj = 'producent'
"""


async def ukryte_foldery(db: AsyncSession, shop: str) -> set:
    """Foldery schowane przy wybranej firmie: folder producenta/kontenera bez towaru tej firmy
    i wszystko pod nim. Kontener jeszcze bez pozycji (świeżo założony) i foldery ręczne widać
    zawsze — lepiej pokazać za dużo niż zgubić dokument. Producent bez żadnego towaru i kontenera
    widać tylko przy „Wszyscy”, żeby lista firmy nie zarastała pustymi folderami. "" = wszystkie."""
    if not shop:
        return set()
    firmy: Dict[int, set] = {}
    for fid, slug in await db.execute(text(_FIRMY_FOLDEROW_SQL)):
        firmy.setdefault(fid, set()).add(slug)
    foldery = (await db.execute(text(f"SELECT id, parent_id, rodzaj FROM {F}"))).all()
    ukryte = {f.id for f in foldery
              if (f.rodzaj == "producent" and shop not in firmy.get(f.id, ()))
              or (f.rodzaj == "kontener" and firmy.get(f.id) and shop not in firmy[f.id])}
    if not ukryte:
        return ukryte
    dzieci: Dict[Optional[int], List[int]] = {}
    for f in foldery:
        dzieci.setdefault(f.parent_id, []).append(f.id)
    stos = list(ukryte)
    while stos:
        for d in dzieci.get(stos.pop(), []):
            if d not in ukryte:
                ukryte.add(d)
                stos.append(d)
    return ukryte


_RODZAJ_KOLEJNOSC = {"producenci": 0, "producent": 1, "reczny": 2, "kontener": 3}


def _kolejnosc_folderu(f, status: Optional[str]) -> tuple:
    """Kolejność w folderze: najpierw „Producenci”, producenci i foldery ręczne (po nazwie),
    potem kontenery — niedostarczone na górze, dostarczone na dole, w obu grupach
    najpóźniejsza ETA najwyżej (tak chce import: to, co płynie, jest pod ręką)."""
    rodzaj = _RODZAJ_KOLEJNOSC.get(f["rodzaj"], 9)
    if f["rodzaj"] != "kontener":
        return (rodzaj, 0, 0, (f["nazwa"] or "").lower())
    eta = f["eta_date"].toordinal() if f["eta_date"] else 0
    return (rodzaj, 1 if status == "DELIVERED" else 0, -eta, (f["nazwa"] or "").lower())


async def lista_folderu(db: AsyncSession, fid: Optional[int], shop: str = "") -> dict:
    """Zawartość folderu (None = poziom główny): podfoldery + pliki, bez kosza.
    `shop` = firma z przełącznika u góry — chowa producentów i kontenery bez jej towaru."""
    gdzie = "f.parent_id = :id" if fid is not None else "f.parent_id IS NULL"
    foldery = (await db.execute(text(f"""
        SELECT f.id, f.nazwa, f.rodzaj, f.manufacturer_id, f.container_id, f.utworzono, f.utworzyl,
               c.container_number, c.order_number, c.status, c.eta_date, c.order_date, c.expected_delivery_date,
               m.color AS kolor,
               (SELECT COUNT(*) FROM {P} p WHERE p.folder_id = f.id AND p.usuniety_at IS NULL) AS ile_plikow,
               (SELECT COUNT(*) FROM {F} x WHERE x.parent_id = f.id AND x.usuniety_at IS NULL) AS ile_folderow
          FROM {F} f
          LEFT JOIN {settings.TABLE_CONTAINERS} c ON c.id = f.container_id
          LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = f.manufacturer_id
         WHERE {gdzie} AND f.usuniety_at IS NULL
         ORDER BY LOWER(f.nazwa)
    """), {"id": fid})).mappings().all()
    ile_folderow = {f["id"]: int(f["ile_folderow"]) for f in foldery}
    if shop:
        ukryte = await ukryte_foldery(db, shop)
        foldery = [f for f in foldery if f["id"] not in ukryte]
        # Licznik „N folderów” też tylko z tym, co przy tej firmie widać (inaczej „Producenci”
        # pokazywali wszystkich producentów niezależnie od przełącznika).
        if foldery:
            r = await db.execute(text(f"""
                SELECT parent_id, id FROM {F} WHERE parent_id = ANY(:ids) AND usuniety_at IS NULL
            """), {"ids": [f["id"] for f in foldery]})
            ile_folderow = {f["id"]: 0 for f in foldery}
            for parent_id, cid in r:
                if cid not in ukryte:
                    ile_folderow[parent_id] += 1
    # Status jak w zakładce Kontenery (po odprawie kontener sam staje się „Dostarczony”).
    from services.containers import compute_effective_status
    status = {f["id"]: compute_effective_status(f["status"], f["eta_date"], f["expected_delivery_date"])[0]
              for f in foldery if f["container_id"] and f["status"]}
    foldery = sorted(foldery, key=lambda f: _kolejnosc_folderu(f, status.get(f["id"])))
    gdzie_p = "folder_id = :id" if fid is not None else "folder_id IS NULL"
    pliki = (await db.execute(text(f"""
        SELECT {PLIK_KOLUMNY} FROM {P} WHERE {gdzie_p} AND usuniety_at IS NULL ORDER BY LOWER(nazwa)
    """), {"id": fid})).mappings().all()
    return {
        "foldery": [{
            "id": f["id"], "nazwa": f["nazwa"], "rodzaj": f["rodzaj"],
            "automatyczny": jest_automatyczny(f["rodzaj"], f["manufacturer_id"], f["container_id"]),
            "manufacturer_id": f["manufacturer_id"], "container_id": f["container_id"], "kolor": f["kolor"],
            "kontener": ({"id": f["container_id"], "container_number": f["container_number"],
                          "order_number": f["order_number"], "status": status.get(f["id"], f["status"]),
                          "eta_date": f["eta_date"]}
                         if f["container_id"] else None),
            "ile_plikow": int(f["ile_plikow"]), "ile_folderow": ile_folderow.get(f["id"], 0),
            "utworzono": f["utworzono"], "utworzyl": f["utworzyl"],
        } for f in foldery],
        "pliki": [plik_out(p) for p in pliki],
    }


async def drzewo(db: AsyncSession) -> List[dict]:
    """Wszystkie żywe foldery (do okna „Przenieś do…”)."""
    r = await db.execute(text(f"""
        WITH {MARTWE_CTE}
        SELECT id, parent_id, nazwa, rodzaj FROM {F}
         WHERE id NOT IN (SELECT id FROM martwe)
         ORDER BY LOWER(nazwa)
    """))
    return [dict(x) for x in r.mappings().all()]


async def szukaj(db: AsyncSession, q: str, limit: int = 100, shop: str = "") -> dict:
    """Pliki i foldery po fragmencie nazwy (bez kosza), z folderem nadrzędnym do podpowiedzi."""
    wzor = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    pliki = (await db.execute(text(f"""
        WITH {MARTWE_CTE}
        SELECT p.{PLIK_KOLUMNY.replace(', ', ', p.')}, f.nazwa AS folder_nazwa
          FROM {P} p LEFT JOIN {F} f ON f.id = p.folder_id
         WHERE p.usuniety_at IS NULL AND p.nazwa ILIKE :q
           AND (p.folder_id IS NULL OR p.folder_id NOT IN (SELECT id FROM martwe))
         ORDER BY p.dodano DESC LIMIT :lim
    """), {"q": wzor, "lim": limit})).mappings().all()
    foldery = (await db.execute(text(f"""
        WITH {MARTWE_CTE}
        SELECT f.id, f.nazwa, f.rodzaj, f.parent_id, r.nazwa AS folder_nazwa
          FROM {F} f LEFT JOIN {F} r ON r.id = f.parent_id
         WHERE f.nazwa ILIKE :q AND f.id NOT IN (SELECT id FROM martwe)
         ORDER BY LOWER(f.nazwa) LIMIT :lim
    """), {"q": wzor, "lim": limit})).mappings().all()
    ukryte = await ukryte_foldery(db, shop)
    return {
        "pliki": [{**plik_out(p), "folder_nazwa": p["folder_nazwa"]} for p in pliki if p["folder_id"] not in ukryte],
        "foldery": [dict(f) for f in foldery if f["id"] not in ukryte],
    }


# ── Kosz ─────────────────────────────────────────────────────────────────────

async def kosz(db: AsyncSession) -> dict:
    foldery = (await db.execute(text(f"""
        SELECT f.id, f.nazwa, f.parent_id, f.usuniety_at, f.usunal, r.nazwa AS folder_nazwa,
               (SELECT COUNT(*) FROM {P} p WHERE p.folder_id = f.id) AS ile_plikow
          FROM {F} f LEFT JOIN {F} r ON r.id = f.parent_id
         WHERE f.usuniety_at IS NOT NULL ORDER BY f.usuniety_at DESC
    """))).mappings().all()
    pliki = (await db.execute(text(f"""
        SELECT p.id, p.nazwa, p.folder_id, p.rozmiar, p.usuniety_at, p.usunal, f.nazwa AS folder_nazwa
          FROM {P} p LEFT JOIN {F} f ON f.id = p.folder_id
         WHERE p.usuniety_at IS NOT NULL ORDER BY p.usuniety_at DESC
    """))).mappings().all()
    return {
        "dni": KOSZ_DNI,
        "foldery": [dict(f) | {"ile_plikow": int(f["ile_plikow"])} for f in foldery],
        "pliki": [dict(p) | {"typ": typ_pliku(p["nazwa"]), "rozmiar_txt": ludzki_rozmiar(int(p["rozmiar"] or 0))}
                  for p in pliki],
    }


async def _sciezki_poddrzewa(db: AsyncSession, folder_ids: List[int]) -> List[str]:
    """Ścieżki w buckecie wszystkich plików w podanych folderach i ich podfolderach."""
    if not folder_ids:
        return []
    r = await db.execute(text(f"""
        WITH RECURSIVE d(id) AS (
            SELECT id FROM {F} WHERE id = ANY(:ids)
            UNION
            SELECT f.id FROM {F} f JOIN d ON f.parent_id = d.id
        ) SELECT p.sciezka FROM {P} p WHERE p.folder_id IN (SELECT id FROM d)
    """), {"ids": folder_ids})
    return [row[0] for row in r]


async def usun_na_zawsze(db: AsyncSession, *, pliki: Iterable[int] = (), foldery: Iterable[int] = ()) -> int:
    """Kasuje pliki z bucketu i wiersze z bazy. Najpierw bucket: gdy Storage padnie, wiersze
    zostają i kosz spróbuje jeszcze raz — lepiej niż osierocony plik, o którym baza zapomniała.
    Zwraca liczbę skasowanych plików."""
    pliki, foldery = list(pliki), list(foldery)
    sciezki: List[str] = []
    if pliki:
        sciezki += [row[0] for row in await db.execute(text(f"SELECT sciezka FROM {P} WHERE id = ANY(:ids)"), {"ids": pliki})]
    sciezki += await _sciezki_poddrzewa(db, foldery)
    if sciezki:
        await pliki_storage.remove(sciezki)
    if pliki:
        await db.execute(text(f"DELETE FROM {P} WHERE id = ANY(:ids)"), {"ids": pliki})
    if foldery:
        # ON DELETE CASCADE zabiera podfoldery i ich pliki
        await db.execute(text(f"DELETE FROM {F} WHERE id = ANY(:ids)"), {"ids": foldery})
    return len(sciezki)


async def wyczysc_stary_kosz(db: AsyncSession, dni: int = KOSZ_DNI) -> int:
    """Wszystko, co leży w koszu dłużej niż `dni` — na zawsze. Woła pętla w lifespan raz na dobę."""
    granica = f"CURRENT_TIMESTAMP - INTERVAL '{int(dni)} days'"
    pliki = [r[0] for r in await db.execute(text(f"SELECT id FROM {P} WHERE usuniety_at < {granica}"))]
    foldery = [r[0] for r in await db.execute(text(f"SELECT id FROM {F} WHERE usuniety_at < {granica}"))]
    if not pliki and not foldery:
        return 0
    n = await usun_na_zawsze(db, pliki=pliki, foldery=foldery)
    await db.commit()
    return n


# ── Styk z kartą kontenera ───────────────────────────────────────────────────

async def pliki_na_kontenerach(db: AsyncSession, container_ids: List[int]) -> Dict[int, List[dict]]:
    """Pliki z ptaszkiem „pokaż na kontenerze” (bez kosza i bez folderów w koszu),
    w kształcie AttachmentOut. {container_id: [...]}."""
    if not container_ids:
        return {}
    r = await db.execute(text(f"""
        WITH {MARTWE_CTE}
        SELECT p.id, p.container_id, p.nazwa, p.rozmiar, p.dodano, p.dodano_z_kontenera,
               m.name AS producent
          FROM {P} p
          LEFT JOIN {F} f ON f.id = p.folder_id
          LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = f.manufacturer_id AND f.rodzaj = 'kontener'
         WHERE p.container_id = ANY(:ids) AND p.pokaz_na_kontenerze AND p.usuniety_at IS NULL
           AND (p.folder_id IS NULL OR p.folder_id NOT IN (SELECT id FROM martwe))
         ORDER BY p.dodano DESC
    """), {"ids": list(container_ids)})
    out: Dict[int, List[dict]] = {}
    for x in r.mappings().all():
        out.setdefault(x["container_id"], []).append({
            "id": x["id"], "filename": x["nazwa"], "file_type": typ_pliku(x["nazwa"]),
            "file_size": ludzki_rozmiar(int(x["rozmiar"] or 0)), "uploaded_at": x["dodano"],
            "zrodlo": "pliki", "producent": x["producent"],
        })
    return out
