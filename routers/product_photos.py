"""Zdjęcia produktów.

Bajty leżą jako BYTEA w app_product_photos (ten sam wzorzec co załączniki
kontenerów). Postgres trzyma je w TOAST, więc dopóki thumb_data/full_data nie
znajdą się jawnie w SELECT, zapytania listowe ich nie dotykają.

DOSTĘP DO BAJTÓW — decyzja projektowa:
Autoryzacja w aplikacji to Bearer w nagłówku, a <img src> nie potrafi wysłać
nagłówka. Endpointy zwracające obrazek są więc BEZ logowania, ale wymagają
podania pełnego content_hash (sha256 pliku) w ścieżce — to URL-klucz: nie do
zgadnięcia bez wcześniejszego pobrania listy produktów (a ta już wymaga
logowania). Zdjęcia produktów nie są danymi wrażliwymi; ceny i stany zostają
za autoryzacją bez zmian. Upload i kasowanie wymagają uprawnienia editProducts.

Hash w ścieżce daje też cache-busting: podmiana zdjęcia zmienia URL, więc możemy
odpowiadać nagłówkiem `immutable` i przeglądarka nie odpytuje serwera ponownie.
"""

import asyncio
import hashlib
import io
from collections import OrderedDict
from typing import List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Depends, File, Form, UploadFile
from fastapi.responses import Response
from sqlalchemy import text
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db, SessionLocal
from models import CurrentUser, ProductPhotoOut
from security import get_current_user, require_perm

router = APIRouter(prefix="/api", tags=["product-photos"])

require_edit_products = require_perm("editProducts")

# Rok w sekundach. Bezpieczne, bo URL zawiera hash treści.
_CACHE_HEADER = "public, max-age=31536000, immutable"

_ALLOWED_TYPES = {"image/webp", "image/jpeg", "image/png"}

# ── Dlaczego to wszystko poniżej istnieje ────────────────────────────────
# database.py używa NullPool: KAŻDE żądanie zestawia nowe połączenie do poolera
# Supabase. Przeglądarka renderująca listę produktów wypuszcza kilkadziesiąt
# żądań o miniatury równolegle (HTTP/2), więc backend próbował w tej samej
# sekundzie otworzyć kilkadziesiąt połączeń TLS. Część się nie łapała i user
# widział „broken image" w losowych wierszach.
#
# Trzy warstwy obrony:
#   1. Cache w pamięci procesu — treść jest niezmienna (URL zawiera sha256),
#      więc raz pobrany obrazek nigdy się nie dezaktualizuje.
#   2. Semafor — burst 40 żądań ustawia się w kolejce po 4 zamiast szturmować bazę.
#   3. Retry — pojedyncze zerwane połączenie nie kończy się błędem u usera.
#
# KLUCZOWE: te endpointy NIE używają Depends(get_db). Zależność otwierałaby
# połączenie zanim handler wystartuje, czyli przed semaforem — czyli dokładnie
# to, czemu semafor ma zapobiec. Sesję otwieramy ręcznie, już za kolejką.

_CACHE_LIMIT_BYTES = 24 * 1024 * 1024        # ~24 MB; miniatura ~2.5 kB, pełne ~40 kB
_cache: "OrderedDict[Tuple[int, str, str], Tuple[bytes, str]]" = OrderedDict()
_cache_bytes = 0
_db_semafor = asyncio.Semaphore(4)


def _cache_get(klucz):
    dane = _cache.get(klucz)
    if dane is not None:
        _cache.move_to_end(klucz)      # LRU: świeżo użyte na koniec
    return dane


def _cache_put(klucz, wartosc):
    global _cache_bytes
    if klucz in _cache:
        return
    _cache[klucz] = wartosc
    _cache_bytes += len(wartosc[0])
    while _cache_bytes > _CACHE_LIMIT_BYTES and _cache:
        _, stare = _cache.popitem(last=False)
        _cache_bytes -= len(stare[0])

# Jawna lista kolumn metadanych — bez thumb_data/full_data.
_META_COLS = ("id, sku, sort_order, content_hash, content_type, filename, "
              "width, height, thumb_bytes, full_bytes, uploaded_at, uploaded_by")


def _row_to_out(r) -> ProductPhotoOut:
    return ProductPhotoOut(
        id=r.id, sku=r.sku, sort_order=r.sort_order, content_hash=r.content_hash,
        content_type=r.content_type, filename=r.filename, width=r.width, height=r.height,
        thumb_bytes=r.thumb_bytes, full_bytes=r.full_bytes,
        uploaded_at=r.uploaded_at, uploaded_by=r.uploaded_by,
    )


@router.get("/products/{sku:path}/photos", response_model=List[ProductPhotoOut])
async def list_photos(sku: str, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(get_current_user)):
    """Metadane zdjęć produktu, kolejność jak sort_order (pierwsze = główne)."""
    r = await db.execute(
        text(f"SELECT {_META_COLS} FROM {settings.TABLE_PRODUCT_PHOTOS} "
             f"WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku)) ORDER BY sort_order, id"),
        {"sku": sku},
    )
    return [_row_to_out(row) for row in r.fetchall()]


@router.post("/products/{sku:path}/photos", response_model=ProductPhotoOut, status_code=201)
async def upload_photo(
    sku: str,
    full: UploadFile = File(..., description="Zdjęcie ~800 px, WebP (konwersja po stronie frontu)"),
    thumb: UploadFile = File(..., description="Miniatura ~128 px, WebP"),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    user: CurrentUser = Depends(require_edit_products),
):
    """Przyjmuje gotową parę WebP: pełne + miniatura.

    Konwersja i skalowanie dzieją się w przeglądarce (canvas.toBlob) — backend
    nie ma Pillow i nie musi mieć. Tu jest tylko walidacja i zapis.
    """
    full_bytes = await full.read()
    thumb_bytes = await thumb.read()
    if not full_bytes or not thumb_bytes:
        raise HTTPException(400, "Pusty plik")
    if len(full_bytes) > settings.MAX_PHOTO_BYTES:
        raise HTTPException(413, f"Zdjęcie za duże (max {settings.MAX_PHOTO_BYTES // 1024 // 1024} MB)")
    if len(thumb_bytes) > settings.MAX_PHOTO_THUMB_BYTES:
        raise HTTPException(413, "Miniatura za duża")

    ctype = (full.content_type or "image/webp").split(";")[0].strip()
    if ctype not in _ALLOWED_TYPES:
        raise HTTPException(415, f"Niedozwolony format: {ctype}. Dozwolone: WebP, JPEG, PNG.")

    sku_clean = (sku or "").strip()
    if not sku_clean:
        raise HTTPException(400, "Brak SKU")

    content_hash = hashlib.sha256(full_bytes).hexdigest()

    params = {
        "sku": sku_clean,
        "hash": content_hash,
        "ctype": ctype,
        "fname": (full.filename or "")[:255] or None,
        "w": width, "h": height,
        "tb": len(thumb_bytes), "fb": len(full_bytes),
        "td": thumb_bytes, "fd": full_bytes,
        "by": user.email,
        "maxn": settings.MAX_PHOTOS_PER_SKU,
    }
    # sort_order = kolejne wolne miejsce; pierwsze wgrane zdjęcie dostaje 0 i jest główne.
    sql = text(f"""
        INSERT INTO {settings.TABLE_PRODUCT_PHOTOS}
            (sku, sort_order, content_hash, content_type, filename, width, height,
             thumb_bytes, full_bytes, thumb_data, full_data, uploaded_by)
        SELECT :sku,
               COALESCE((SELECT MAX(sort_order) + 1 FROM {settings.TABLE_PRODUCT_PHOTOS}
                          WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku))), 0),
               :hash, :ctype, :fname, :w, :h, :tb, :fb, :td, :fd, :by
        WHERE (SELECT COUNT(*) FROM {settings.TABLE_PRODUCT_PHOTOS}
                WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku))) < :maxn
        RETURNING {_META_COLS}
    """)

    # Ten sam retry co przy załącznikach — pooler Supabase potrafi zerwać
    # pierwsze połączenie przy większym payloadzie.
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            async with SessionLocal() as db:
                r = await db.execute(sql, params)
                row = r.first()
                await db.commit()
                if row is None:
                    raise HTTPException(409, f"Limit {settings.MAX_PHOTOS_PER_SKU} zdjęć na produkt osiągnięty")
                return _row_to_out(row)
        except HTTPException:
            raise
        except (OperationalError, InterfaceError) as e:
            last_err = e
            await asyncio.sleep(0.4 * (attempt + 1))
    raise HTTPException(503, f"Zapis zdjęcia nieudany po kilku próbach: {last_err}")


async def _serve(pid: int, content_hash: str, kolumna: str) -> Response:
    """Zwraca bajty jednego wariantu. Hash musi się zgadzać — bez tego 404."""
    klucz = (pid, content_hash, kolumna)

    trafienie = _cache_get(klucz)
    if trafienie is None:
        sql = text(f"SELECT {kolumna} AS data, content_type FROM {settings.TABLE_PRODUCT_PHOTOS} "
                   f"WHERE id = :id AND content_hash = :h")
        params = {"id": pid, "h": content_hash}

        ostatni: Exception | None = None
        async with _db_semafor:
            # Drugie sprawdzenie cache: przy burście kilkanaście żądań o ten sam
            # obrazek czeka na semaforze; pierwsze go pobiera, reszta ma już gotowe.
            trafienie = _cache_get(klucz)
            if trafienie is None:
                for proba in range(3):
                    try:
                        async with SessionLocal() as db:
                            r = await db.execute(sql, params)
                            row = r.first()
                        if not row or row.data is None:
                            raise HTTPException(404, "Zdjęcie nie znalezione")
                        trafienie = (bytes(row.data), row.content_type or "image/webp")
                        _cache_put(klucz, trafienie)
                        break
                    except HTTPException:
                        raise
                    except (OperationalError, InterfaceError) as e:
                        ostatni = e
                        await asyncio.sleep(0.25 * (proba + 1))
                else:
                    raise HTTPException(503, f"Nie udało się odczytać zdjęcia: {ostatni}")

    dane, ctype = trafienie
    return Response(content=dane, media_type=ctype, headers={"Cache-Control": _CACHE_HEADER})


@router.get("/product-photos/{pid}/{content_hash}/thumb")
async def get_thumb(pid: int, content_hash: str):
    """Miniatura ~128 px. Bez autoryzacji — patrz nota na górze pliku."""
    return await _serve(pid, content_hash, "thumb_data")


@router.get("/product-photos/{pid}/{content_hash}/full")
async def get_full(pid: int, content_hash: str):
    """Zdjęcie ~800 px. Bez autoryzacji — patrz nota na górze pliku."""
    return await _serve(pid, content_hash, "full_data")


@router.delete("/product-photos/{pid}", status_code=204)
async def delete_photo(pid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_edit_products)):
    """Usuwa zdjęcie i domyka dziurę w sort_order, żeby kolejne zostało główne."""
    r = await db.execute(
        text(f"DELETE FROM {settings.TABLE_PRODUCT_PHOTOS} WHERE id = :id RETURNING sku"),
        {"id": pid},
    )
    row = r.first()
    if row is None:
        await db.rollback()
        raise HTTPException(404, "Zdjęcie nie znalezione")

    # Przenumerowanie 0..n-1 — bez tego usunięcie głównego zostawiłoby sort_order
    # zaczynający się od 1 i kolejny upload wskoczyłby w złe miejsce.
    await db.execute(
        text(f"""
            UPDATE {settings.TABLE_PRODUCT_PHOTOS} p
               SET sort_order = nowa.rn
              FROM (SELECT id, (ROW_NUMBER() OVER (ORDER BY sort_order, id) - 1) AS rn
                      FROM {settings.TABLE_PRODUCT_PHOTOS}
                     WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku))) nowa
             WHERE p.id = nowa.id AND p.sort_order <> nowa.rn
        """),
        {"sku": row.sku},
    )
    await db.commit()


@router.put("/product-photos/{pid}/main", response_model=List[ProductPhotoOut])
async def set_main(pid: int, db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_edit_products)):
    """Ustawia zdjęcie jako główne (sort_order = 0), reszta przesuwa się w dół."""
    r = await db.execute(
        text(f"SELECT sku FROM {settings.TABLE_PRODUCT_PHOTOS} WHERE id = :id"), {"id": pid}
    )
    row = r.first()
    if not row:
        raise HTTPException(404, "Zdjęcie nie znalezione")

    await db.execute(
        text(f"""
            UPDATE {settings.TABLE_PRODUCT_PHOTOS} p
               SET sort_order = nowa.rn
              FROM (SELECT id,
                           (ROW_NUMBER() OVER (ORDER BY (id = :id) DESC, sort_order, id) - 1) AS rn
                      FROM {settings.TABLE_PRODUCT_PHOTOS}
                     WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku))) nowa
             WHERE p.id = nowa.id
        """),
        {"id": pid, "sku": row.sku},
    )
    await db.commit()

    r2 = await db.execute(
        text(f"SELECT {_META_COLS} FROM {settings.TABLE_PRODUCT_PHOTOS} "
             f"WHERE LOWER(TRIM(sku)) = LOWER(TRIM(:sku)) ORDER BY sort_order, id"),
        {"sku": row.sku},
    )
    return [_row_to_out(x) for x in r2.fetchall()]
