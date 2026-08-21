"""Anomalie sprzedaży (spike/drop/stock_drain), niedobór wbite oraz lista zakupów per producent."""

from typing import Dict, List, Tuple

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import Anomaly, CurrentUser, ShoppingListGroup
from security import get_current_user, resolve_shop
from services.products import fetch_products

router = APIRouter(prefix="/api", tags=["anomalies"])

# ── Niedobór „wbite" ─────────────────────────────────────────────────────────
# Zielona kropka (subiekt_wbite) NATYCHMIAST wyłącza towar z liczenia jako „w kontenerze"
# (services/snapshots.py), bo zakłada, że jest już w magazynie „w drodze" ERP tej firmy.
# Włączenie po drugiej stronie zależy jednak od czegoś zupełnie innego — od tego, czy ktoś
# faktycznie wprowadził dokument do Subiektu/Fakturowni. Między tymi zdarzeniami nie ma
# sprzężenia, więc przypadkowe wbicie kasuje kapitał z KPI bez śladu.
#
# Uzgadniamy ILOŚCIOWO per SKU × firma, nie obecnościowo per kontener: jedno SKU potrafi
# płynąć w kilku kontenerach naraz i przy 5 wbitych z 6 pokrycie „istnieje", tylko jest
# za małe (600 zadeklarowane vs 500 w ERP → brakuje 100).
DEFAULT_FIRMA_SLUG = "amh"
SYNC_LAG_MULTIPLIER = 2.0      # próg = 2× odstęp od ostatniego udanego syncu…
MIN_THRESHOLD_H = 6.0          # …ale nie mniej niż 6 h (czas na ręczne wpisanie PZ)…
MAX_THRESHOLD_H = 24.0         # …i nie więcej niż doba (zepsuty sync nie może uciszyć alarmu)
SHORTFALL_MIN_QTY = 10         # próg tolerancji: bezwzględny…
SHORTFALL_MIN_PCT = 0.20       # …lub udziałowy (dowolny wystarczy)
SHORTFALL_HIGH_PCT = 0.50      # powyżej → severity high


def _sync_source(slug: str) -> str:
    """Źródło w app_sync_log odpowiadające ERP danej firmy."""
    return "subiekt" if slug == DEFAULT_FIRMA_SLUG else f"fakturownia:{slug}"


def _container_label(nr: str, po: str, mfr: str) -> str:
    """Etykieta kontenera dla człowieka — port reguły z frontendu (ui.tsx → containerLabel).

    Roboczy numer „Draft-<Producent>" to wewnętrzny placeholder, a nie coś, czego użytkownik
    szuka w Subiekcie czy w mailu. Kolejność: prawdziwy numer kontenera → numer zamówienia
    (PO) → sama nazwa producenta. Bez tego podpowiedź „Sprawdź: …" prowadziłaby donikąd.
    """
    nr = (nr or "").strip()
    if nr and not nr.lower().startswith("draft-"):
        return nr
    po = (po or "").strip()
    if po:
        return po
    # Ostatnia deska: nazwa producenta. Świadomie NIE wracamy do „Draft-…" — lepiej pominąć
    # podpowiedź niż wysłać człowieka po numer, którego nigdzie nie znajdzie (tak samo robi front).
    return (mfr or "").strip() or "—"


def _threshold_h(lag_by_source: Dict[str, float], slug: str) -> float:
    """Ile godzin po wbiciu zaczynamy rozliczać kontener. Brak wpisu → sufit."""
    lag = lag_by_source.get(_sync_source(slug))
    if lag is None or lag < 0:
        return MAX_THRESHOLD_H
    return max(MIN_THRESHOLD_H, min(MAX_THRESHOLD_H, lag * SYNC_LAG_MULTIPLIER))


async def _detect_wbite_shortfall(db: AsyncSession, shop: str = "") -> List[Anomaly]:
    """Uzgodnienie: Σ zielonych kropek (deklaracja) vs magazyn „w drodze" ERP (rzeczywistość).

    Alarmujemy WYŁĄCZNIE przy niedoborze. Nadwyżka jest normalna — w magazynie „w drodze"
    leży też towar z kontenerów już DELIVERED albo wprowadzony poza obiegiem kontenerowym.

    Wieki (godziny) liczy Postgres przez NOW(), a nie Python, żeby wbite_at i finished_at
    były mierzone tą samą miarą niezależnie od strefy, w jakiej zapisał je proces.
    """
    # 1) Opóźnienie ostatniego UDANEGO syncu per źródło → z tego próg czasowy per firma.
    lag_by_source: Dict[str, float] = {}
    r = await db.execute(text(f"""
        SELECT source,
               EXTRACT(EPOCH FROM (NOW() - MAX(finished_at))) / 3600.0 AS lag_h
        FROM {settings.TABLE_SYNC_LOG}
        WHERE ok = TRUE AND finished_at IS NOT NULL
        GROUP BY source
    """))
    for m in r.mappings():
        if m["lag_h"] is not None:
            lag_by_source[str(m["source"])] = float(m["lag_h"])

    # 2) Pozycje z niedostarczonych kontenerów wraz z flagą i wiekiem wbicia.
    #    Dla skonsolidowanych flaga siedzi na locie, dla zwykłych na kontenerze (jak INCOMING_QUERY).
    #    Bez JOIN-ów do słowników — app_product_attrs miewa duplikaty SKU, a fan-out
    #    zawyżyłby ilości. Słowniki dociągamy osobno i sklejamy w Pythonie.
    r = await db.execute(text(f"""
        SELECT ci.sku                                        AS sku,
               c.container_number                            AS container_number,
               COALESCE(l.order_number, c.order_number)      AS order_number,
               COALESCE(lm.name, cm.name)                    AS manufacturer_name,
               COALESCE(ci.quantity, 0)                      AS quantity,
               COALESCE(l.subiekt_wbite, c.subiekt_wbite, FALSE) AS wbite,
               EXTRACT(EPOCH FROM (NOW() - COALESCE(l.subiekt_wbite_at, c.subiekt_wbite_at)))
                   / 3600.0                                  AS wbite_age_h
        FROM {settings.TABLE_CONTAINER_ITEMS} ci
        JOIN {settings.TABLE_CONTAINERS} c ON c.id = ci.container_id
        LEFT JOIN {settings.TABLE_CONTAINER_LOTS} l ON l.id = ci.lot_id
        LEFT JOIN {settings.TABLE_MANUFACTURERS} cm ON cm.id = c.manufacturer_id
        LEFT JOIN {settings.TABLE_MANUFACTURERS} lm ON lm.id = l.manufacturer_id
        WHERE c.status <> 'DELIVERED'
          AND ci.sku IS NOT NULL AND TRIM(ci.sku) <> ''
    """))
    items = [dict(m) for m in r.mappings()]
    if not items:
        return []

    # 3) Firma produktu + nazwa ręczna (zdeduplikowane po sku_canon).
    firma_by_sku: Dict[str, str] = {}
    name_by_sku: Dict[str, str] = {}
    r = await db.execute(text(f"""
        SELECT DISTINCT ON (LOWER(TRIM(pa.sku)))
               LOWER(TRIM(pa.sku))                  AS sku_canon,
               LOWER(COALESCE(f.slug, '{DEFAULT_FIRMA_SLUG}')) AS slug,
               NULLIF(TRIM(pa.name_override), '')   AS nazwa
        FROM {settings.TABLE_PRODUCT_ATTRS} pa
        LEFT JOIN {settings.TABLE_FIRMY} f ON f.id = pa.firma_id
        WHERE pa.sku IS NOT NULL AND TRIM(pa.sku) <> ''
        ORDER BY LOWER(TRIM(pa.sku)), pa.updated_at DESC NULLS LAST
    """))
    for m in r.mappings():
        firma_by_sku[m["sku_canon"]] = m["slug"] or DEFAULT_FIRMA_SLUG
        if m["nazwa"]:
            name_by_sku[m["sku_canon"]] = m["nazwa"]

    # Nazwa zapasowa: nowa tabela subiektowa, potem stara (ta sama warstwowość co katalog).
    for sql_txt in (
        f"""SELECT DISTINCT ON (LOWER(TRIM(sku))) LOWER(TRIM(sku)) AS sku_canon, nazwa AS n
            FROM {settings.TABLE_SUBIEKT_DWA}
            WHERE sku IS NOT NULL AND TRIM(sku) <> '' AND nazwa IS NOT NULL AND TRIM(nazwa) <> ''
            ORDER BY LOWER(TRIM(sku))""",
        f"""SELECT DISTINCT ON (LOWER(TRIM({settings.COL_PRODUCT_SKU})))
                   LOWER(TRIM({settings.COL_PRODUCT_SKU})) AS sku_canon,
                   {settings.COL_PRODUCT_NAME} AS n
            FROM {settings.TABLE_PRODUCTS}
            WHERE {settings.COL_PRODUCT_SKU} IS NOT NULL AND TRIM({settings.COL_PRODUCT_SKU}) <> ''
              AND {settings.COL_PRODUCT_NAME} IS NOT NULL AND TRIM({settings.COL_PRODUCT_NAME}) <> ''
            ORDER BY LOWER(TRIM({settings.COL_PRODUCT_SKU}))""",
    ):
        r = await db.execute(text(sql_txt))
        for m in r.mappings():
            name_by_sku.setdefault(m["sku_canon"], m["n"])

    # 4) Rzeczywisty magazyn „w drodze" per firma.
    #    AMH → druga tabela subiektowa; Acti/Veluxa → Fakturownia „Towary w drodze".
    actual: Dict[Tuple[str, str], int] = {}
    r = await db.execute(text(f"""
        SELECT LOWER(TRIM(sku)) AS sku_canon, COALESCE(SUM(stan_magazyn_w_drodze), 0) AS qty
        FROM {settings.TABLE_SUBIEKT_DWA}
        WHERE sku IS NOT NULL AND TRIM(sku) <> ''
        GROUP BY LOWER(TRIM(sku))
    """))
    for m in r.mappings():
        actual[(DEFAULT_FIRMA_SLUG, m["sku_canon"])] = int(m["qty"] or 0)
    r = await db.execute(text(f"""
        SELECT LOWER(f.slug) AS slug, LOWER(TRIM(fs.sku)) AS sku_canon,
               COALESCE(SUM(fs.in_transit_qty), 0) AS qty
        FROM {settings.TABLE_FAKTUROWNIA_STOCK} fs
        JOIN {settings.TABLE_FIRMY} f ON f.id = fs.firma_id
        WHERE fs.sku IS NOT NULL AND TRIM(fs.sku) <> ''
        GROUP BY LOWER(f.slug), LOWER(TRIM(fs.sku))
    """))
    for m in r.mappings():
        actual[(m["slug"], m["sku_canon"])] = int(m["qty"] or 0)

    # 5) Deklaracja z zielonych kropek — tylko kontenery starsze niż próg SWOJEJ firmy.
    #    Świeżo wbity kontener po prostu jeszcze nie wchodzi do rozliczenia, więc nie
    #    generuje fałszywego alarmu i nie trzeba żadnego wyciszania.
    expected: Dict[Tuple[str, str], int] = {}
    sku_raw: Dict[str, str] = {}
    cands: Dict[Tuple[str, str], List[Tuple[float, str]]] = {}
    for it in items:
        if not it["wbite"]:
            continue
        canon = (it["sku"] or "").strip().lower()
        if not canon:
            continue
        slug = firma_by_sku.get(canon, DEFAULT_FIRMA_SLUG)
        # wbite_age_h NULL = flaga sprzed wprowadzenia kolumny → traktujemy jako dawno temu,
        # inaczej stary błąd zostałby ukryty na zawsze.
        age = it["wbite_age_h"]
        age_h = float(age) if age is not None else float("inf")
        if age_h < _threshold_h(lag_by_source, slug):
            continue
        key = (slug, canon)
        expected[key] = expected.get(key, 0) + int(it["quantity"] or 0)
        sku_raw.setdefault(canon, it["sku"])
        label = _container_label(it["container_number"], it["order_number"], it["manufacturer_name"])
        if label and label != "—":
            cands.setdefault(key, []).append((age_h, label))

    # 6) Porównanie i budowa anomalii.
    sklep = (shop or "").strip().lower()
    out: List[Anomaly] = []
    for (slug, canon), exp in expected.items():
        if exp <= 0:
            continue
        if sklep and slug != sklep:
            continue
        act = actual.get((slug, canon), 0)
        missing = exp - act
        if missing <= 0:
            continue
        if missing < SHORTFALL_MIN_QTY and (missing / exp) < SHORTFALL_MIN_PCT:
            continue
        erp = "Subiekcie" if slug == DEFAULT_FIRMA_SLUG else "Fakturowni"
        # Najświeżej wbity kontener jest najbardziej prawdopodobnym winowajcą.
        podejrzani = [n for _, n in sorted(set(cands.get((slug, canon), [])))[:3]]
        wskazowka = f" Sprawdź: {', '.join(podejrzani)}." if podejrzani else ""
        out.append(Anomaly(
            sku=sku_raw.get(canon, canon),
            name=name_by_sku.get(canon, sku_raw.get(canon, canon)),
            severity="high" if (missing / exp) >= SHORTFALL_HIGH_PCT else "medium",
            type="wbite_shortfall",
            message=(f"Zielone kropki mówią {exp} szt., w {erp} ({slug.upper()}) jest {act}. "
                     f"Brakuje {missing} szt. — ten towar nie liczy się nigdzie.{wskazowka}"),
            firma_slug=slug,
            expected_qty=exp,
            actual_qty=act,
            missing_qty=missing,
            containers=podejrzani or None,
        ))
    out.sort(key=lambda a: -(a.missing_qty or 0))
    return out


@router.get("/anomalies", response_model=List[Anomaly])
async def detect_anomalies(shop: str = "", favorites_only: bool = False, db: AsyncSession = Depends(get_db),
                           user: CurrentUser = Depends(get_current_user)):
    """
    Wykrywanie anomalii - rozsądna czułość:
    - sales_spike: 1m > 1.5x średniej z poprzednich 3m, ALE 1m >= 5 (żeby nie spam dla małych)
    - sales_drop: 1m < 0.4x średniej z poprzednich 3m, ALE poprzedni miesiąc był >= 5
    - stock_drain: stan = 0 i sprzedaż 1m >= 10

    favorites_only=True → tylko obserwowane SKU (is_favorite). Dashboard woła z True,
    żeby anomalie nie krzyczały o produktach, których już nie sprzedajemy.
    """
    shop = resolve_shop(shop, user)
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, shop)
    if favorites_only:
        products = [p for p in products if p.is_favorite]
    anomalies = []

    for p in products:
        prev_3m_total = p.sales_2m * 2 + p.sales_3m * 3 + p.sales_4m * 4 - p.sales_1m
        prev_avg = max(p.sales_3m, 1)

        # SPIKE
        if p.sales_1m >= 5 and p.sales_1m > prev_avg * 1.5:
            change_pct = ((p.sales_1m / prev_avg) - 1) * 100
            sev = "high" if change_pct > 100 else "medium"
            anomalies.append(Anomaly(
                sku=p.sku, name=p.name, severity=sev, type="sales_spike",
                message=f"Sprzedaż wzrosła z {prev_avg}/mies do {p.sales_1m}/mies (+{change_pct:.0f}%)",
                sales_1m=p.sales_1m, sales_3m_avg=prev_avg, change_pct=round(change_pct, 1),
            ))
        # DROP
        elif prev_avg >= 5 and p.sales_1m < prev_avg * 0.4:
            change_pct = ((p.sales_1m / prev_avg) - 1) * 100
            sev = "high" if change_pct < -70 else "medium"
            anomalies.append(Anomaly(
                sku=p.sku, name=p.name, severity=sev, type="sales_drop",
                message=f"Sprzedaż spadła z {prev_avg}/mies do {p.sales_1m}/mies ({change_pct:.0f}%)",
                sales_1m=p.sales_1m, sales_3m_avg=prev_avg, change_pct=round(change_pct, 1),
            ))
        # STOCK DRAIN
        elif p.stock == 0 and p.sales_1m >= 10 and p.stock_in_transit == 0:
            anomalies.append(Anomaly(
                sku=p.sku, name=p.name, severity="high", type="stock_drain",
                message=f"Zero stanu, sprzedaż {p.sales_1m}/mies, brak kontenera w drodze!",
                sales_1m=p.sales_1m, sales_3m_avg=prev_avg, change_pct=0,
            ))

    sev_order = {"high": 0, "medium": 1, "low": 2}
    anomalies.sort(key=lambda a: (sev_order[a.severity], -a.sales_1m))

    # Niedobór wbite ZAWSZE na górze i POZA filtrem ulubionych — dziura kapitałowa na
    # nieobserwowanym SKU to nadal dziura, a przy sales_1m = 0 wypadłaby z limitu 20.
    # Awaria tej detekcji nie może zabrać anomalii sprzedażowych, stąd try/except.
    try:
        wbite = await _detect_wbite_shortfall(db, shop)
    except Exception as e:  # noqa: BLE001 — celowo miękko, to dodatek do listy
        print(f"[anomalies] wbite_shortfall pominięte: {e}")
        wbite = []
    return wbite + anomalies[:20]


@router.get("/shopping-list", response_model=List[ShoppingListGroup])
async def shopping_list(shop: str = "", favorites_only: bool = False, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(get_current_user)):
    """Grupy produktów do zamówienia per producent.

    favorites_only=True → tylko obserwowane SKU (is_favorite). Zasila boxy „Pożary"
    i „Lista zakupów" na Dashboardzie, gdzie chcemy widzieć wyłącznie to, co sprzedajemy.
    """
    shop = resolve_shop(shop, user)
    products = await fetch_products(db, {"ACTIVE", "ACTIVE_NO_STOCK"}, shop)
    if favorites_only:
        products = [p for p in products if p.is_favorite]
    needing = [p for p in products if p.status in ("KRYTYCZNY", "ZAMOW_TERAZ", "ZAMOW_WKROTCE") and p.avg_monthly_weighted >= 1 and not p.no_reorder]

    mfr_result = await db.execute(text(f"SELECT id, name, color, email FROM {settings.TABLE_MANUFACTURERS}"))
    mfr_emails = {r._mapping["id"]: r._mapping["email"] for r in mfr_result}

    groups = {}
    for p in needing:
        key = p.manufacturer_id or 0
        if key not in groups:
            groups[key] = {
                "manufacturer_id": p.manufacturer_id,
                "manufacturer_name": p.manufacturer_name,
                "manufacturer_color": p.manufacturer_color,
                "manufacturer_email": mfr_emails.get(p.manufacturer_id) if p.manufacturer_id else None,
                "products": [],
                "total_skus": 0,
            }
        recommended = max(1, int(p.avg_monthly_weighted * 6 - p.stock - p.stock_in_transit))
        groups[key]["products"].append({
            "sku": p.sku, "name": p.name,
            "stock": p.stock, "stock_in_transit": p.stock_in_transit,
            "avg_monthly": p.avg_monthly_weighted,
            "recommended_quantity": recommended,
            "purchase_price": p.purchase_price,
            "cbm_per_unit": p.cbm_per_unit,
            "status": p.status,
            "days_until_empty": p.days_until_empty,
            "transfer_source_shop": p.transfer_source_shop,
            "transfer_source_qty": p.transfer_source_qty,
            "transfer_source_transit": p.transfer_source_transit,
            "transfer_state": p.transfer_state,
        })
        groups[key]["total_skus"] += 1

    return list(groups.values())
