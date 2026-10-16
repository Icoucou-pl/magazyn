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
# Trójki (kontener, producent, firma) — po jednym folderze kontenera na każdą. Firma partii = firma
# większości jej towaru (SKU bez firma_id = AMH). Gdy producent ma w kontenerze partie JEDNEJ firmy
# (zwykły przypadek), firma = NULL i jest jeden folder jak dotąd. Gdy ma partie kilku firm (Fosoto
# dla AMH i osobno dla Veluxy — zawsze osobne partie), każda firma dostaje własny folder „… – AMH”.
# Producent bez partii z producentem → producent z nagłówka kontenera (para z firmą NULL).
_TROJKI_CTE = f"""
    pa AS (
        SELECT DISTINCT ON (LOWER(TRIM(sku))) LOWER(TRIM(sku)) AS sku_canon, firma_id
          FROM {settings.TABLE_PRODUCT_ATTRS}
         WHERE sku IS NOT NULL AND TRIM(sku) <> ''
         ORDER BY LOWER(TRIM(sku)), updated_at DESC NULLS LAST
    ),
    partie AS (
        SELECT l.id, l.container_id, l.manufacturer_id, l.position, l.order_number,
               (SELECT LOWER(COALESCE(fi.slug, 'amh'))
                  FROM {settings.TABLE_CONTAINER_ITEMS} ci
                  LEFT JOIN pa ON pa.sku_canon = LOWER(TRIM(ci.sku))
                  LEFT JOIN {settings.TABLE_FIRMY} fi ON fi.id = pa.firma_id
                 WHERE ci.lot_id = l.id
                 GROUP BY 1 ORDER BY SUM(ci.quantity) DESC, 1 LIMIT 1) AS firma
          FROM {settings.TABLE_CONTAINER_LOTS} l
         WHERE l.manufacturer_id IS NOT NULL {{lot_where}}
    ),
    rozne AS (
        SELECT container_id, manufacturer_id FROM partie WHERE firma IS NOT NULL
         GROUP BY container_id, manufacturer_id HAVING COUNT(DISTINCT firma) > 1
    ),
    trojki AS (
        SELECT DISTINCT p.container_id, p.manufacturer_id,
               CASE WHEN r.container_id IS NOT NULL THEN p.firma END AS firma
          FROM partie p
          LEFT JOIN rozne r ON r.container_id = p.container_id AND r.manufacturer_id = p.manufacturer_id
         WHERE r.container_id IS NULL OR p.firma IS NOT NULL
        UNION
        SELECT c.id, c.manufacturer_id, NULL::VARCHAR
          FROM {settings.TABLE_CONTAINERS} c
         WHERE NOT EXISTS (SELECT 1 FROM {settings.TABLE_CONTAINER_LOTS} l
                            WHERE l.container_id = c.id AND l.manufacturer_id IS NOT NULL) {{c_where}}
    )
"""

# Nazwa folderu kontenera dla każdej trójki z CTE `zrodlo` (container_id, manufacturer_id, firma):
#   1. prawdziwy nr kontenera (bez roboczego „Draft-…”) — ten sam u każdego producenta,
#   2. inaczej „FV: …” — w skonsolidowanym FV partii TEGO producenta (i tej firmy), w zwykłym FV kontenera,
#   3. inaczej „#id”;
# plus „ – AMH” / „ – Veluxa”, gdy producent ma w kontenerze partie kilku firm.
_ETYKIETY_CTE = f"""
    etykiety AS (
        SELECT x.container_id, x.manufacturer_id, x.firma,
               CASE WHEN x.nr <> '' AND LOWER(x.nr) NOT LIKE 'draft-%' THEN x.nr
                    WHEN x.fv <> '' THEN 'FV: ' || x.fv
                    ELSE '#' || x.container_id END
               || CASE WHEN x.firma IS NOT NULL THEN ' – ' || COALESCE(x.firma_nazwa, UPPER(x.firma)) ELSE '' END AS nazwa
          FROM (
            SELECT z.container_id, z.manufacturer_id, z.firma, TRIM(COALESCE(c.container_number, '')) AS nr,
                   (SELECT fi.name FROM {settings.TABLE_FIRMY} fi WHERE LOWER(fi.slug) = z.firma LIMIT 1) AS firma_nazwa,
                   TRIM(COALESCE(
                        CASE WHEN (SELECT COUNT(*) FROM {settings.TABLE_CONTAINER_LOTS} l
                                    WHERE l.container_id = c.id AND l.manufacturer_id IS NOT NULL) > 1
                             THEN (SELECT NULLIF(TRIM(p.order_number), '') FROM partie p
                                    WHERE p.container_id = c.id AND p.manufacturer_id = z.manufacturer_id
                                      AND (z.firma IS NULL OR p.firma = z.firma)
                                      AND NULLIF(TRIM(p.order_number), '') IS NOT NULL
                                    ORDER BY p.position, p.id LIMIT 1) END,
                        NULLIF(TRIM(c.order_number), ''),
                        (SELECT l.order_number FROM {settings.TABLE_CONTAINER_LOTS} l
                          WHERE l.container_id = c.id AND NULLIF(TRIM(l.order_number), '') IS NOT NULL
                          ORDER BY l.position, l.id LIMIT 1), '')) AS fv
              FROM zrodlo z JOIN {settings.TABLE_CONTAINERS} c ON c.id = z.container_id
          ) x
    )
"""

_ostatnia_synchronizacja = {"t": 0.0}
SYNC_CO_SEKUND = 60

# Jedna para (kontener, producent, firma) — porównanie z NULL-ami jak w unikalnym indeksie.
_TA_SAMA_TROJKA = """{a}.container_id = {b}.container_id
                AND {a}.manufacturer_id IS NOT DISTINCT FROM {b}.manufacturer_id
                AND {a}.firma IS NOT DISTINCT FROM {b}.firma"""


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

    Gdy producent zaczyna mieć w kontenerze partie dwóch firm, jego dotychczasowy folder staje się
    folderem firmy pierwszej partii (pliki zostają), a druga firma dostaje nowy. I odwrotnie: gdy
    zostaje jedna firma, jej folder wraca do zwykłej nazwy.

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
    trojki = _TROJKI_CTE.format(lot_where=lot_where, c_where=c_where)
    zrodlo_where = "AND container_id = :cid" if cid is not None else ""

    # Producent zaczął mieć partie dwóch firm: jego zwykły folder (firma NULL) staje się folderem
    # firmy pierwszej partii — pliki zostają na miejscu, druga firma dostanie nowy folder niżej.
    await db.execute(text(f"""
        WITH {trojki},
        pierwsza AS (
            SELECT DISTINCT ON (p.container_id, p.manufacturer_id) p.container_id, p.manufacturer_id, p.firma
              FROM partie p JOIN rozne r ON r.container_id = p.container_id AND r.manufacturer_id = p.manufacturer_id
             WHERE p.firma IS NOT NULL
             ORDER BY p.container_id, p.manufacturer_id, p.position, p.id
        )
        UPDATE {F} f SET firma = p.firma FROM pierwsza p
         WHERE f.rodzaj = 'kontener' AND f.firma IS NULL AND f.container_id = p.container_id
           AND f.manufacturer_id IS NOT DISTINCT FROM p.manufacturer_id
           AND NOT EXISTS (SELECT 1 FROM {F} x WHERE x.rodzaj = 'kontener' AND x.container_id = p.container_id
                              AND x.manufacturer_id IS NOT DISTINCT FROM p.manufacturer_id AND x.firma IS NOT NULL)
    """), params)
    # I odwrotnie: została jedna firma — najstarszy folder firmowy wraca do zwykłego.
    await db.execute(text(f"""
        WITH {trojki}
        UPDATE {F} f SET firma = NULL
         WHERE f.id IN (
            SELECT DISTINCT ON (x.container_id, x.manufacturer_id) x.id
              FROM {F} x JOIN trojki t ON t.container_id = x.container_id
                                      AND t.manufacturer_id IS NOT DISTINCT FROM x.manufacturer_id AND t.firma IS NULL
             WHERE x.rodzaj = 'kontener' AND x.firma IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM {F} y WHERE y.rodzaj = 'kontener' AND y.container_id = x.container_id
                                  AND y.manufacturer_id IS NOT DISTINCT FROM x.manufacturer_id AND y.firma IS NULL)
             ORDER BY x.container_id, x.manufacturer_id, x.id)
    """), params)

    # Wszystko zbiorczo, po jednym zapytaniu — pierwsza wersja szła pętlą po kontenerach
    # (setki wymian z Supabase przy każdym wejściu w Pliki, kilka sekund czekania).
    await db.execute(text(f"""
        WITH {trojki}, zrodlo AS (SELECT container_id, manufacturer_id, firma FROM trojki), {_ETYKIETY_CTE}
        INSERT INTO {F} (parent_id, nazwa, rodzaj, manufacturer_id, container_id, firma)
        SELECT COALESCE(pf.id, :root), e.nazwa, 'kontener', t.manufacturer_id, t.container_id, t.firma
          FROM trojki t
          JOIN etykiety e ON {_TA_SAMA_TROJKA.format(a="e", b="t")}
          LEFT JOIN {F} pf ON pf.rodzaj = 'producent' AND pf.manufacturer_id = t.manufacturer_id
        ON CONFLICT (container_id, (COALESCE(manufacturer_id, 0)), (COALESCE(firma, ''))) WHERE rodzaj = 'kontener'
        DO NOTHING
    """), params)
    # Nazwy folderów kontenerów nadążają za numerem kontenera (Draft → prawdziwy nr), FV partii i firmą.
    await db.execute(text(f"""
        WITH {trojki}, zrodlo AS (
            SELECT DISTINCT container_id, manufacturer_id, firma FROM {F}
             WHERE rodzaj = 'kontener' AND container_id IS NOT NULL {zrodlo_where}
        ), {_ETYKIETY_CTE}
        UPDATE {F} f SET nazwa = e.nazwa FROM etykiety e
         WHERE f.rodzaj = 'kontener' AND {_TA_SAMA_TROJKA.format(a="f", b="e")} AND f.nazwa IS DISTINCT FROM e.nazwa
    """), params)

    if cid is None:
        # Puste foldery kontenerów, które już nie pasują do żadnej trójki — do usunięcia.
        await db.execute(text(f"""
            WITH {trojki}
            DELETE FROM {F} f
             WHERE f.rodzaj = 'kontener'
               AND (f.container_id IS NULL OR f.manufacturer_id IS NULL
                    OR NOT EXISTS (SELECT 1 FROM trojki t WHERE {_TA_SAMA_TROJKA.format(a="t", b="f")}))
               AND NOT EXISTS (SELECT 1 FROM {P} x WHERE x.folder_id = f.id)
               AND NOT EXISTS (SELECT 1 FROM {F} x WHERE x.parent_id = f.id)
        """), params)
        _ostatnia_synchronizacja["t"] = teraz


async def folder_kontenera(db: AsyncSession, cid: int, manufacturer_id: Optional[int],
                           firma: Optional[str] = None) -> int:
    """Id folderu (kontener, producent[, firma]) — po synchronizacji tego kontenera zawsze istnieje.
    Producent spoza kontenera (np. karta zapisana w międzyczasie) → pierwszy producent kontenera.
    `firma` rozstrzyga, gdy producent ma partie kilku firm; bez niej — folder bez firmy, inaczej najstarszy."""
    await synchronizuj_foldery(db, cid=cid)
    producenci = await pary_kontenera(db, cid)
    if manufacturer_id not in producenci:
        manufacturer_id = producenci[0] if producenci else None
    fid = (await db.execute(text(f"""
        SELECT id FROM {F} WHERE rodzaj = 'kontener' AND container_id = :k
           AND manufacturer_id IS NOT DISTINCT FROM :m AND usuniety_at IS NULL
         ORDER BY (firma IS NOT DISTINCT FROM CAST(:f AS VARCHAR)) DESC, (firma IS NULL) DESC, id LIMIT 1
    """), {"k": cid, "m": manufacturer_id, "f": firma})).scalar()
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
        "dodano": r["dodano"], "dodal": r["dodal"], "caly_kontener": bool(r["caly_kontener"]),
    }


PLIK_KOLUMNY = ("id, folder_id, nazwa, content_type, rozmiar, container_id, pokaz_na_kontenerze, "
                "dodano_z_kontenera, dodano, dodal, caly_kontener")


async def kontenery_widoczne(db: AsyncSession, ukryte: set) -> set:
    """Kontenery, których choć jeden folder (u któregoś producenta) jest widoczny. Plik
    „cały kontener” jest dostępny, gdy jego kontener jest na tej liście — nawet jeśli leży
    w folderze producenta, którego dany user nie widzi (Veluxa widzi rozliczenie Lenmara
    wrzucone u producenta AMH)."""
    r = await db.execute(text(f"""
        WITH {MARTWE_CTE}
        SELECT id, container_id FROM {F}
         WHERE rodzaj = 'kontener' AND container_id IS NOT NULL AND id NOT IN (SELECT id FROM martwe)
    """))
    return {cid for fid, cid in r if fid not in ukryte}


def plik_dostepny(p, ukryte: set, widoczne_kontenery: set) -> bool:
    """Plik do pokazania mimo zawężenia: jego folder nie jest schowany ALBO to plik „cały kontener”
    z kontenera, który user widzi u innego producenta."""
    return p["folder_id"] not in ukryte or (bool(p["caly_kontener"]) and p["container_id"] in widoczne_kontenery)


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
    foldery = (await db.execute(text(f"SELECT id, parent_id, rodzaj, firma FROM {F}"))).all()
    for f in foldery:          # folder partii jednej firmy (producent dla kilku firm) — tylko ta firma
        if f.rodzaj == "kontener" and f.firma:
            firmy[f.id] = {f.firma}
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
               (SELECT COUNT(*) FROM {P} p WHERE p.usuniety_at IS NULL
                   AND (p.folder_id = f.id
                        OR (f.rodzaj = 'kontener' AND f.container_id IS NOT NULL AND p.caly_kontener
                            AND p.container_id = f.container_id AND p.folder_id <> f.id
                            AND p.folder_id IN (SELECT x.id FROM {F} x WHERE x.rodzaj = 'kontener'
                                                   AND x.container_id = f.container_id)))) AS ile_plikow,
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
    ten = (await db.execute(text(f"SELECT rodzaj, container_id FROM {F} WHERE id = :id"), {"id": fid})).first() \
        if fid is not None else None
    kontener = ten.container_id if ten is not None and ten.rodzaj == "kontener" else None
    if kontener is not None:
        # Folder kontenera: własne pliki + pliki „cały kontener” z folderów tego kontenera u innych producentów.
        gdzie_p = f"""(folder_id = :id OR (caly_kontener AND container_id = :cid AND folder_id IN (
                        SELECT x.id FROM {F} x WHERE x.rodzaj = 'kontener' AND x.container_id = :cid
                           AND x.usuniety_at IS NULL)))"""
    pliki = (await db.execute(text(f"""
        SELECT {PLIK_KOLUMNY} FROM {P} WHERE {gdzie_p} AND usuniety_at IS NULL ORDER BY LOWER(nazwa)
    """), {"id": fid, "cid": kontener})).mappings().all()
    # Ilu producentów ma ten kontener — przy jednym nie ma czego współdzielić (bez ptaszka na ekranie).
    producentow = (await db.execute(text(f"""
        SELECT COUNT(*) FROM {F} WHERE rodzaj = 'kontener' AND container_id = :cid AND usuniety_at IS NULL
    """), {"cid": kontener})).scalar() if kontener is not None else 0
    return {
        "producentow_kontenera": int(producentow or 0),
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
    widoczne = await kontenery_widoczne(db, ukryte) if ukryte else set()
    return {
        "pliki": [{**plik_out(p), "folder_nazwa": p["folder_nazwa"]} for p in pliki
                  if plik_dostepny(p, ukryte, widoczne)],
        "foldery": [dict(f) for f in foldery if f["id"] not in ukryte],
    }


# ── ZIP z zaznaczonych ───────────────────────────────────────────────────────

ZIP_MAX_BYTES = 1024 * 1024 * 1024       # 1 GB — powyżej lepiej pobierać mniejszymi kawałkami


def _unikalna(sciezka: str, uzyte: set) -> str:
    """Dwa pliki o tej samej nazwie w jednym folderze ZIP-a → „nazwa (2).pdf”."""
    cel, i = sciezka, 1
    while cel.lower() in uzyte:
        i += 1
        base, kropka, ext = sciezka.rpartition(".")
        cel = f"{base} ({i}).{ext}" if kropka and "/" not in ext else f"{sciezka} ({i})"
    uzyte.add(cel.lower())
    return cel


async def pliki_do_zip(db: AsyncSession, *, pliki: Iterable[int] = (), foldery: Iterable[int] = (),
                       shop: str = "") -> List[dict]:
    """Co trafi do ZIP-a: zaznaczone pliki (luzem, w głównym katalogu ZIP-a) i zaznaczone foldery
    z całą zawartością, z zachowaniem podfolderów („MSKU123/Zdjęcia/a.jpg”). Bez kosza i bez
    folderów schowanych przy wybranej firmie. Zwraca [{zip, sciezka, rozmiar}] — `sciezka` w buckecie."""
    pliki, foldery = list(pliki), list(foldery)
    martwe = {r[0] for r in await db.execute(text(f"WITH {MARTWE_CTE} SELECT id FROM martwe"))}
    pomin = martwe | await ukryte_foldery(db, shop)
    wszystkie = (await db.execute(text(f"""
        SELECT f.id, f.parent_id, f.nazwa, f.rodzaj, m.name AS producent
          FROM {F} f LEFT JOIN {settings.TABLE_MANUFACTURERS} m ON m.id = f.manufacturer_id
    """))).all()
    dzieci: Dict[Optional[int], List] = {}
    for f in wszystkie:
        dzieci.setdefault(f.parent_id, []).append(f)
    nazwa_f = {f.id: f.nazwa for f in wszystkie}
    # Ten sam kontener zaznaczony u dwóch producentów ma dwa foldery o tej samej nazwie —
    # w ZIP-ie dopisujemy producenta („KONS – Anji”, „KONS – Fosoto”) zamiast „KONS (2)”.
    po_id = {f.id: f for f in wszystkie}
    ile_nazw: Dict[str, int] = {}
    for fid in foldery:
        if fid in po_id:
            ile_nazw[nazwa_f[fid].lower()] = ile_nazw.get(nazwa_f[fid].lower(), 0) + 1
    for fid in foldery:
        f = po_id.get(fid)
        if f is not None and f.rodzaj == "kontener" and f.producent and ile_nazw.get(f.nazwa.lower(), 0) > 1:
            nazwa_f[fid] = f"{f.nazwa} – {f.producent}"

    # folder → ścieżka w ZIP-ie (zaznaczony folder jest katalogiem głównym swojej gałęzi)
    katalog: Dict[int, str] = {}
    uzyte_kat: set = set()
    for fid in foldery:
        if fid in pomin or fid not in nazwa_f or fid in katalog:
            continue
        stos = [(fid, _unikalna(czysta_nazwa(nazwa_f[fid], "folder").replace(":", ""), uzyte_kat))]
        while stos:
            x, sc = stos.pop()
            if x in katalog:          # podfolder zaznaczony osobno i już ujęty w nadrzędnym
                continue
            katalog[x] = sc
            for d in dzieci.get(x, []):
                if d.id not in pomin:
                    stos.append((d.id, f"{sc}/{czysta_nazwa(d.nazwa, 'folder').replace(':', '')}"))

    wiersze = []
    if katalog:
        wiersze += (await db.execute(text(f"""
            SELECT id, folder_id, nazwa, sciezka, rozmiar FROM {P}
             WHERE folder_id = ANY(:ids) AND usuniety_at IS NULL ORDER BY folder_id, LOWER(nazwa)
        """), {"ids": list(katalog)})).mappings().all()
        # Pliki „cały kontener” lądują w folderze kontenera każdego zaznaczonego producenta — tak jak w Plikach.
        wiersze += (await db.execute(text(f"""
            SELECT p.id, f.id AS folder_id, p.nazwa, p.sciezka, p.rozmiar
              FROM {P} p JOIN {F} f ON f.rodzaj = 'kontener' AND f.container_id = p.container_id
             WHERE f.id = ANY(:ids) AND p.caly_kontener AND p.usuniety_at IS NULL AND p.folder_id <> f.id
               AND p.folder_id IN (SELECT x.id FROM {F} x WHERE x.rodzaj = 'kontener' AND x.container_id = p.container_id)
        """), {"ids": list(katalog)})).mappings().all()
    if pliki:
        widoczne = await kontenery_widoczne(db, pomin)
        wiersze += [w | {"folder_id": None} for w in (await db.execute(text(f"""
            SELECT id, folder_id, nazwa, sciezka, rozmiar, caly_kontener, container_id FROM {P}
             WHERE id = ANY(:ids) AND usuniety_at IS NULL
        """), {"ids": pliki})).mappings().all() if plik_dostepny(w, pomin, widoczne)]

    out, uzyte, w_folderach, widziane = [], set(), set(), set()
    for w in wiersze:
        if w["folder_id"] in katalog:
            klucz = (w["id"], w["folder_id"])
            w_folderach.add(w["id"])
        elif w["id"] in w_folderach:  # plik zaznaczony i jednocześnie w zaznaczonym folderze — raz
            continue
        else:
            klucz = (w["id"], None)
        if klucz in widziane:
            continue
        widziane.add(klucz)
        nazwa = czysta_nazwa(w["nazwa"])
        sc = f"{katalog[w['folder_id']]}/{nazwa}" if w["folder_id"] in katalog else nazwa
        out.append({"zip": _unikalna(sc, uzyte), "sciezka": w["sciezka"], "rozmiar": int(w["rozmiar"] or 0)})
    return out


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
               CASE WHEN p.caly_kontener THEN 'cały kontener'
                    WHEN f.firma IS NOT NULL THEN m.name || ' – ' || COALESCE(
                         (SELECT fi.name FROM {settings.TABLE_FIRMY} fi WHERE LOWER(fi.slug) = f.firma LIMIT 1), UPPER(f.firma))
                    ELSE m.name END AS producent
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
