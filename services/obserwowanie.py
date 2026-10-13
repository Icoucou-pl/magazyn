"""
Obserwowanie produktu osobno w każdej firmie.

Dawniej „obserwowany” był jedną flagą na produkt (`is_favorite`), wspólną dla AMH, Acti
i Veluxy. Produkt Veluxy, który AMH przestaje sprzedawać, nie dało się zdjąć z listy AMH
bez zniknięcia go także z listy Veluxy.

Zapis: `is_favorite` dalej mówi „obserwowany gdziekolwiek”, a `unwatched_shops`
to lista firm, w których mimo to go NIE obserwujemy. Dzięki temu wszystkie dotychczasowe
gwiazdki działają bez żadnej migracji danych (pusta lista = obserwowany we wszystkich).

Obserwowany w firmie X  ⇔  is_favorite AND X nie ma w unwatched_shops.
Widok „Wszyscy” (shop="") pokazuje produkt obserwowany choćby w jednej firmie.
"""

from typing import Iterable, List, Optional, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from security import ALL_SHOPS


def obserwowany_w(is_favorite: bool, unwatched: Optional[Iterable[str]], shop: str) -> bool:
    """To samo co warunek w SALES_QUERY — dla kodu, który ma już wiersz w Pythonie."""
    if not is_favorite:
        return False
    return not shop or shop not in set(unwatched or [])


def nowy_stan(is_favorite: bool, unwatched: Optional[Iterable[str]], shop: str,
              on: bool) -> Tuple[bool, Optional[List[str]]]:
    """Stan (is_favorite, unwatched_shops) po włączeniu/wyłączeniu obserwowania w `shop`.

    shop="" (Wszyscy) działa jak dawniej: włącza albo wyłącza we wszystkich firmach naraz.
    Lista None = obserwowany wszędzie, gdzie is_favorite; trzymamy ją pustą jako NULL,
    żeby stare i nowe wiersze wyglądały tak samo.
    """
    if not shop:
        return on, None
    wyl = set(unwatched or []) if is_favorite else set(ALL_SHOPS)
    if on:
        wyl.discard(shop)
    else:
        wyl.add(shop)
    # Wyłączony we wszystkich firmach = po prostu nieobserwowany. Bez tego zostałby
    # widoczny w „Wszyscy” (is_favorite = TRUE), choć żadna firma go nie obserwuje.
    if wyl >= set(ALL_SHOPS):
        return False, None
    return True, (sorted(wyl) or None)


async def ustaw_obserwowanie(db: AsyncSession, skus: List[str], shop: str, on: bool) -> List[str]:
    """Włącza/wyłącza obserwowanie listy SKU w firmie `shop` ("" = wszystkie).

    SKU muszą być już w pisowni atrybutów (routers.products._sku_atrybutow).
    Zwraca SKU, którym stan faktycznie się zmienił — do opisu w audycie.
    Nie commituje: robi to router, jednym commitem dla całej paczki.
    """
    if not skus:
        return []
    r = await db.execute(text(f"""
        SELECT sku, COALESCE(is_favorite, FALSE) AS fav, unwatched_shops
        FROM {settings.TABLE_PRODUCT_ATTRS}
        WHERE sku = ANY(:skus)
    """), {"skus": skus})
    obecne = {m["sku"]: (bool(m["fav"]), m["unwatched_shops"]) for m in r.mappings()}

    zmienione: List[str] = []
    for sku in skus:
        fav, wyl = obecne.get(sku, (False, None))
        n_fav, n_wyl = nowy_stan(fav, wyl, shop, on)
        if n_fav == fav and sorted(n_wyl or []) == sorted(wyl or []):
            continue
        await db.execute(text(f"""
            INSERT INTO {settings.TABLE_PRODUCT_ATTRS} (sku, is_favorite, unwatched_shops, updated_at)
            VALUES (:sku, :fav, :wyl, CURRENT_TIMESTAMP)
            ON CONFLICT (sku) DO UPDATE SET is_favorite = EXCLUDED.is_favorite,
                                            unwatched_shops = EXCLUDED.unwatched_shops,
                                            updated_at = CURRENT_TIMESTAMP
        """), {"sku": sku, "fav": n_fav, "wyl": n_wyl})
        zmienione.append(sku)
    return zmienione
