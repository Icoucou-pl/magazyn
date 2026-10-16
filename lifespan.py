"""
Lifespan aplikacji: przy starcie tworzy brakujące tabele, dokłada brakujące kolumny
(migracje ALTER TABLE), wstawia domyślne typy kontenerów, tworzy domyślnego admina
(jeśli baza userów pusta), zakłada indeksy i dociąga świeże kursy walut NBP.
Przy zamknięciu zwalnia pulę połączeń.
"""

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import FastAPI
from sqlalchemy import text

from config import settings
from database import engine, add_column_if_missing, SessionLocal
from security import hash_password, validate_password_strength


# Co ile sekund tło odświeża kursy NBP. 6h = kursy zawsze świeże w ciągu kilku godzin
# od publikacji (NBP wystawia tabelę A w dni robocze przed południem), niezależnie od
# strefy czasowej i godziny startu serwera. Idempotentne (ON CONFLICT DO NOTHING).
FX_REFRESH_INTERVAL_SECONDS = 6 * 60 * 60


async def _fx_refresh_loop():
    """Wewnętrzny harmonogram: cyklicznie dociąga świeże kursy NBP. Nie wystawia
    niczego na zewnątrz (woła funkcję bezpośrednio, nie endpoint), więc nie wymaga
    auth. Każdy błąd jest łapany — pętla nigdy nie umiera przez chwilowy problem z NBP."""
    from database import SessionLocal
    from services.fx import topup_recent
    while True:
        await asyncio.sleep(FX_REFRESH_INTERVAL_SECONDS)
        try:
            async with SessionLocal() as session:
                res = await topup_recent(session)
            print(f"[fx] auto top-up: {res}")
        except Exception as e:
            print(f"[fx] auto top-up błąd (pomijam, pętla działa dalej): {e}")


# --- Automat Sellasista: co godzinę o pełnej godzinie w oknie [START..END] (Europe/Warsaw) ---
try:
    from zoneinfo import ZoneInfo
    _WARSAW = ZoneInfo("Europe/Warsaw")
except Exception:                       # brak tzdata → fallback do UTC (okno liczone w UTC)
    _WARSAW = None


def _now_warsaw():
    from datetime import datetime
    return datetime.now(_WARSAW) if _WARSAW else datetime.utcnow()


def _next_run_at(now, start_h: int, end_h: int):
    """Najbliższa pełna godzina > now mieszcząca się w oknie [start_h..end_h].
    Poza oknem przeskakuje na start_h (dziś lub jutro)."""
    from datetime import timedelta
    nxt = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    if nxt.hour < start_h:
        nxt = nxt.replace(hour=start_h)
    elif nxt.hour > end_h:
        nxt = (nxt + timedelta(days=1)).replace(hour=start_h)
    return nxt


async def _sellasist_auto_loop():
    """Harmonogram: o pełnych godzinach w oknie [START_HOUR..END_HOUR] (czas warszawski,
    domyślnie 7–20) odświeża dane Sellasista, a zaraz po nim — NIEZALEŻNIE — Fakturownię
    (Acti/Veluxa), tak samo jak ręczny przycisk „Odśwież". Woła funkcje bezpośrednio (nie
    endpoint), pomija bieg jeśli akurat trwa ręczny, każdy błąd łapany — pętla nigdy nie
    umiera. Działa tylko gdy skonfigurowane."""
    if not settings.SELLASIST_AUTO_ENABLED:
        print("[sellasist] automat wyłączony (SELLASIST_AUTO_ENABLED=false)")
        return
    from services.sellasist import is_configured, is_running, mark_started, run_refresh, get_status
    from services import fakturownia as fakt
    from services import fakturownia_sales as fsales
    from services import fakturownia_history as fhist
    start_h = settings.SELLASIST_AUTO_START_HOUR
    end_h = settings.SELLASIST_AUTO_END_HOUR
    while True:
        now = _now_warsaw()
        nxt = _next_run_at(now, start_h, end_h)
        await asyncio.sleep(max(1.0, (nxt - now).total_seconds()))
        try:
            if is_configured() and not is_running():
                mark_started()
                await run_refresh()
                st = get_status()
                print(f"[sellasist] auto: {st.get('error') or st.get('message')}")
        except Exception as e:
            print(f"[sellasist] auto błąd (pomijam, pętla działa dalej): {e}")

        # Fakturownia (Acti/Veluxa) — ten sam automat godzinowy, ale NIEZALEŻNIE od
        # Sellasista: własny guard i osobny try, więc błąd/brak konfiguracji jednego nie
        # blokuje drugiego (jak w routerze /api/sellasist/refresh). Bieg ~6 s, osobny
        # wpis w app_sync_log jako fakturownia:<slug>.
        try:
            if fakt.is_configured() and not fakt.is_running():
                fakt.mark_started()
                await fakt.run_refresh()
                fst = fakt.get_status()
                print(f"[fakturownia] auto: {fst.get('error') or fst.get('message')}")
        except Exception as e:
            print(f"[fakturownia] auto błąd (pomijam, pętla działa dalej): {e}")

        # Sprzedaż z Fakturowni (hurt + przesunięcia wewnątrzgrupowe) — trzeci niezależny
        # blok, ten sam wzorzec: własny guard, własny try. Bieg jest krótki, bo mapa SKU
        # jest kumulatywna (uczy się tylko z nowych faktur), a faktury bez zmian są
        # pomijane po src_updated_at. Pierwszy bieg po wdrożeniu jest długi (~900 requestów).
        try:
            if fsales.is_configured() and not fsales.is_running():
                fsales.mark_started()
                await fsales.run_sync()
                sst = fsales.get_status()
                print(f"[fakturownia_sales] auto: {sst.get('error') or sst.get('message')}")
        except Exception as e:
            print(f"[fakturownia_sales] auto błąd (pomijam, pętla działa dalej): {e}")

        # Dziennik ruchów magazynowych z Fakturowni — źródło zakładki „Historia
        # produktu" dla Acti i Veluxy (Subiekt obsługuje tylko AMH). Czwarty
        # niezależny blok, ten sam wzorzec: własny guard, własny try.
        #
        # KOLEJNOŚĆ MA ZNACZENIE: leci PO fakturownia_sales, bo korzysta z mapy
        # SKU (fakturownia_sku_map), którą tamten bieg zapisuje. Przy pustej
        # mapie ledger i tak się zapisze, ale duża część ruchów zostanie bez
        # symbolu — `code` na akcji bywa puste (686 z 1886 akcji w Veluxie).
        try:
            if fhist.is_configured() and not fhist.is_running():
                fhist.mark_started()
                await fhist.run_sync()
                hst = fhist.get_status()
                print(f"[fakturownia_history] auto: {hst.get('error') or hst.get('message')}")
        except Exception as e:
            print(f"[fakturownia_history] auto błąd (pomijam, pętla działa dalej): {e}")


DROPY_PUSH_INTERVAL_SECONDS = 120


async def _dropy_push_loop():
    """Co 2 minuty wysyła do Sellasista zamówienia dropów, które na nic nie czekają
    (status „Nowe” bez numeru Sellasista). Każdy błąd łapany — pętla nigdy nie umiera."""
    from routers.dropy import push_pending
    await asyncio.sleep(30)                     # daj aplikacji wstać po deployu
    while True:
        try:
            res = await push_pending()
            if res["checked"]:
                print(f"[dropy] auto-push: {res}")
        except Exception as e:
            print(f"[dropy] auto-push błąd (pomijam, pętla działa dalej): {e}")
        await asyncio.sleep(DROPY_PUSH_INTERVAL_SECONDS)


SNAPSHOT_TIMES = ((7, 5, "rano"), (20, 5, "wieczor"))   # (godz, min, nazwa pory) — czas warszawski


def _due_slots(now) -> list:
    """Pory, które na dziś już powinny być zapisane (do uzupełnienia po restarcie apki)."""
    return [name for h, m, name in SNAPSHOT_TIMES if (now.hour, now.minute) >= (h, m)]


def _next_snapshot_at(now):
    """Najbliższy moment snapshotu: dziś o 7:05/20:05, inaczej jutro o 7:05."""
    for h, m, name in SNAPSHOT_TIMES:
        cand = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if cand > now:
            return cand, name
    h, m, name = SNAPSHOT_TIMES[0]
    return (now + timedelta(days=1)).replace(hour=h, minute=m, second=0, microsecond=0), name


async def _run_snapshot(slot: str, why: str):
    """Jeden zapis snapshotu z własną sesją bazy. Błąd łapany — pętla nie umiera."""
    from services.snapshots import store_snapshot
    try:
        async with SessionLocal() as db:
            res = await store_snapshot(db, slot)
        print(f"[snapshot] {why}: {res}")
    except Exception as e:
        print(f"[snapshot] błąd ({why}, {slot}): {e}")


async def _audit_retention_loop():
    """Raz na dobę (i zaraz po starcie) kasuje wpisy dziennika starsze niż 12 miesięcy."""
    from audit import usun_stare_wpisy, RETENCJA_MIESIECY
    while True:
        try:
            n = await usun_stare_wpisy()
            if n:
                print(f"[audit] retencja {RETENCJA_MIESIECY} mies.: usunięto {n} wpisów", flush=True)
        except Exception as e:
            print(f"[audit] retencja nieudana (pomijam): {e}")
        await asyncio.sleep(24 * 60 * 60)


async def _pliki_kosz_loop():
    """Raz na dobę (i zaraz po starcie): kosz zakładki „Pliki” starszy niż 30 dni — na zawsze,
    także z Supabase Storage. Błąd Storage nie kasuje wierszy, więc następna doba spróbuje znowu."""
    from services.pliki import wyczysc_stary_kosz, KOSZ_DNI
    while True:
        try:
            async with SessionLocal() as db:
                n = await wyczysc_stary_kosz(db)
            if n:
                print(f"[pliki] kosz starszy niż {KOSZ_DNI} dni: usunięto {n} plików", flush=True)
        except Exception as e:
            print(f"[pliki] czyszczenie kosza nieudane (pomijam): {e}")
        await asyncio.sleep(24 * 60 * 60)


async def _snapshot_loop():
    """Snapshoty KPI + stanów 2× dziennie (7:05 i 20:05), po synchronizacji z Subiektem.

    Przy starcie apki uzupełnia pory, które dziś już minęły, a nie mają wpisu — dzięki temu
    restart/deploy w newralgicznym momencie nie gubi dnia. Zapis jest idempotentny.
    """
    from services.snapshots import missing_slots
    # catch-up: co powinno już dziś być, a nie ma
    try:
        now = _now_warsaw()
        due = _due_slots(now)
        if due:
            async with SessionLocal() as db:
                brakuje = await missing_slots(db, now.date(), due)
            for slot in brakuje:
                await _run_snapshot(slot, "uzupełnienie po starcie")
    except Exception as e:
        print(f"[snapshot] catch-up nieudany (pomijam): {e}")

    while True:
        now = _now_warsaw()
        nxt, slot = _next_snapshot_at(now)
        await asyncio.sleep(max(1.0, (nxt - now).total_seconds()))
        await _run_snapshot(slot, "harmonogram")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        # Lead times
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_LEAD_TIMES} (
                sku VARCHAR(255) PRIMARY KEY,
                lead_time_days INTEGER NOT NULL DEFAULT {settings.DEFAULT_LEAD_TIME_DAYS},
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))

        # Producenci
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_MANUFACTURERS} (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                color VARCHAR(20) DEFAULT '#6b7280',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))
        await add_column_if_missing(conn, settings.TABLE_MANUFACTURERS, "email", "VARCHAR(255)")
        await add_column_if_missing(conn, settings.TABLE_MANUFACTURERS, "contact", "VARCHAR(255)")

        # Firmy (sklepy: AMH / Acti / Veluxa) — każda = jeden Sellasist.
        # is_self = AMH (stan z Subiektu, hub). Acti/Veluxa to siostrzane sklepy-źródła zapasu.
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_FIRMY} (
                id SERIAL PRIMARY KEY,
                slug VARCHAR(40) NOT NULL UNIQUE,
                name VARCHAR(120) NOT NULL,
                color VARCHAR(20) DEFAULT '#6b7280',
                is_self BOOLEAN DEFAULT FALSE,
                base_url VARCHAR(255),
                api_key_env VARCHAR(120),
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))
        # Seed 3 firm — tylko jeśli pusto. base_url/klucz Acti i Veluxy uzupełnisz przy wpinaniu ingestu.
        result = await conn.execute(text(f"SELECT COUNT(*) FROM {settings.TABLE_FIRMY}"))
        if result.scalar() == 0:
            await conn.execute(text(f"""
                INSERT INTO {settings.TABLE_FIRMY} (slug, name, color, is_self, base_url, api_key_env, sort_order)
                VALUES
                    ('amh',    'AMH (i-coucou)', '#4f7cff', TRUE,  :amh_base, 'SELLASIST_API_KEY',        0),
                    ('acti',   'Acti',           '#22c55e', FALSE, NULL,      'SELLASIST_ACTI_API_KEY',   1),
                    ('veluxa', 'Veluxa',         '#f59e0b', FALSE, NULL,      'SELLASIST_VELUXA_API_KEY', 2)
            """), {"amh_base": settings.SELLASIST_BASE_URL or None})

        # 2b: stany zewnętrzne (Acti/Veluxa). Tworzymy też tu, żeby katalog (sql.py) nie zależał
        # od pierwszego "Odśwież" — inaczej zapytanie produktów mogłoby trafić na brak tabeli.
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_EXTERNAL_STOCK} (
                shop VARCHAR(40) NOT NULL,
                symbol VARCHAR(255) NOT NULL,
                sku_canon VARCHAR(255) NOT NULL,
                quantity NUMERIC DEFAULT 0,
                reserved NUMERIC DEFAULT 0,
                updated_at TIMESTAMP DEFAULT now(),
                PRIMARY KEY (shop, sku_canon)
            )
        """))

        # Typy kontenerów
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_CONTAINER_TYPES} (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                capacity_cbm DECIMAL(8,2) NOT NULL,
                sort_order INTEGER DEFAULT 0
            )
        """))

        # Migracja: typ „drobnica (LCL)” — nasz towar w cudzym kontenerze, płacimy za miejsce.
        # Nie ma pojemności (capacity_cbm = 0), więc karta pokazuje same CBM, bez % wypełnienia.
        await add_column_if_missing(conn, settings.TABLE_CONTAINER_TYPES, "drobnica", "BOOLEAN NOT NULL DEFAULT FALSE")

        # Domyślne typy kontenerów - tylko jeśli tabela jest pusta
        result = await conn.execute(text(f"SELECT COUNT(*) FROM {settings.TABLE_CONTAINER_TYPES}"))
        if result.scalar() == 0:
            await conn.execute(text(f"""
                INSERT INTO {settings.TABLE_CONTAINER_TYPES} (name, capacity_cbm, sort_order)
                VALUES ('20'' GP', 33.0, 1), ('40'' GP', 67.0, 2), ('40'' HC', 76.0, 3),
                       ('45'' HC', 86.0, 4), ('20'' REEFER', 28.0, 5)
            """))

        # Atrybuty produktów
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_PRODUCT_ATTRS} (
                sku VARCHAR(255) PRIMARY KEY,
                cbm_per_unit DECIMAL(8,4) DEFAULT 0,
                manufacturer_id INTEGER REFERENCES {settings.TABLE_MANUFACTURERS}(id) ON DELETE SET NULL,
                seasonality_enabled BOOLEAN DEFAULT FALSE,
                force_visible BOOLEAN DEFAULT FALSE,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))
        # Migracja: CBM / szt z 4 do 8 miejsc po przecinku — drobne produkty (np. 0,0004725 m³)
        # zapisywały się jako 0,0005, a po zaokrągleniu do 3 miejsc wychodziło 0 („brak CBM”).
        # Tylko gdy skala jest jeszcze mała; w osobnym punkcie zapisu, żeby błąd (np. zależny
        # widok) nie przerwał całego startu.
        skala = (await conn.execute(text(
            "SELECT numeric_scale FROM information_schema.columns "
            "WHERE table_name = :t AND column_name = 'cbm_per_unit'"
        ), {"t": settings.TABLE_PRODUCT_ATTRS})).scalar()
        if skala is not None and skala < 8:
            try:
                async with conn.begin_nested():
                    await conn.execute(text(
                        f"ALTER TABLE {settings.TABLE_PRODUCT_ATTRS} ALTER COLUMN cbm_per_unit TYPE NUMERIC(14,8)"))
            except Exception as e:   # noqa: BLE001 — start ma się udać; stary typ dalej działa
                print(f"[migracja] nie udało się poszerzyć cbm_per_unit do 8 miejsc (zostaje stary typ): {e}")
        # Migracja: ulubione
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "is_favorite", "BOOLEAN DEFAULT FALSE")
        # Obserwowanie per firma: lista firm, w których produktu NIE obserwujemy mimo is_favorite
        # (services/obserwowanie.py). NULL = obserwowany we wszystkich — stare gwiazdki bez zmian.
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "unwatched_shops", "TEXT[]")
        # Migracja: EAN
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "ean", "VARCHAR(50)")
        # Migracja: ręczne wymuszenie statusu
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "forced_status", "VARCHAR(30)")
        # Migracja: firma macierzysta produktu (NULL = AMH). Override per-sku, jak manufacturer_id.
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "firma_id", f"INTEGER REFERENCES {settings.TABLE_FIRMY}(id) ON DELETE SET NULL")
        # Migracja: ręczna cena zakupu (PLN netto). NULL/0 = fallback do ceny z Subiektu. Override per-sku.
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "cena_zakupu", "NUMERIC")
        # Migracja: ręczna nazwa produktu. Puste = nazwa z Subiektu/zamówień (a jak brak, to SKU). Override per-sku.
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "name_override", "VARCHAR(255)")
        # Migracja: ręczna stawka VAT (%). NULL = stawka z ostatniej krajowej sprzedaży (Sellasist). Ręka wygrywa.
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "vat_manual", "NUMERIC(4,1)")
        # Migracja: cena zakupu z innego SKU (ten sam towar pod dwoma symbolami, np. Szp3_szpital
        # ↔ Szp3 — w Fakturowni jest tylko Szp3). NULL = własna cena. Ustawia superadmin.
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "cena_z_sku", "VARCHAR(255)")

        # Kontenery
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_CONTAINERS} (
                id SERIAL PRIMARY KEY,
                container_number VARCHAR(100) NOT NULL,
                container_type_id INTEGER REFERENCES {settings.TABLE_CONTAINER_TYPES}(id),
                manufacturer_id INTEGER REFERENCES {settings.TABLE_MANUFACTURERS}(id),
                supplier VARCHAR(255),
                order_date DATE NOT NULL,
                eta_date DATE NOT NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'ORDERED',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT chk_status CHECK (status IN ('ORDERED','IN_PRODUCTION','IN_TRANSIT','DELIVERED'))
            )
        """))
        # Migracja: order_number
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "order_number", "VARCHAR(100)")
        # Migracja: rzeczywista data dostawy (ustawiana przy DELIVERED; NULL = auto po odprawie ETA+CONTAINER_CUSTOMS_DAYS)
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "delivered_date", "DATE")
        # Migracja: kropka „dodano do Subiektu" (magazyn w drodze) — na kontenerze i na locie.
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "subiekt_wbite", "BOOLEAN DEFAULT FALSE")
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "subiekt_wbite_at", "DATE")
        await add_column_if_missing(conn, settings.TABLE_CONTAINER_LOTS, "subiekt_wbite", "BOOLEAN DEFAULT FALSE")
        await add_column_if_missing(conn, settings.TABLE_CONTAINER_LOTS, "subiekt_wbite_at", "DATE")
        # Migracja: kontenery rozliczane razem (jedna faktura dostawcy w kilku kontenerach).
        # Ta sama liczba = wspólne płatności w koszcie jednostkowym. NULL = rozliczany sam.
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "rozliczenie_grupa", "INTEGER")
        # Migracja: „dokumenty wysłane do agencji celnej" — klikalna plakietka na liście kontenerów
        # (kto i kiedy kliknął), żeby bez wchodzenia w kontener było widać, gdzie jest komplet.
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "dokumenty_wyslane", "BOOLEAN DEFAULT FALSE")
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "dokumenty_wyslane_at", "TIMESTAMP")
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "dokumenty_wyslal", "VARCHAR(255)")
        # Pierwsza wersja notatki do kosztu jednostkowego (jedno pole). Zostaje tylko do przeniesienia
        # starych wpisów do dziennika app_koszt_notatki (niżej) — nowe trafiają już tam.
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "koszt_notatka", "TEXT")
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "koszt_notatka_kto", "VARCHAR(255)")
        await add_column_if_missing(conn, settings.TABLE_CONTAINERS, "koszt_notatka_kiedy", "TIMESTAMP")

        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_CONTAINER_ITEMS} (
                id SERIAL PRIMARY KEY,
                container_id INTEGER NOT NULL REFERENCES {settings.TABLE_CONTAINERS}(id) ON DELETE CASCADE,
                sku VARCHAR(255) NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                unit_cost DECIMAL(10,2)
            )
        """))

        # Migracja: znacznik „gratisy na tę pozycję" w poprawkach kosztu jednostkowego. Tabelę
        # zakłada sql/2026-10-koszt-jednostkowy-v2.sql, więc dokładamy kolumnę tylko, gdy już jest —
        # błąd ALTER-a na brakującej tabeli przerwałby całą transakcję startu.
        if (await conn.execute(text("SELECT to_regclass('app_koszt_pozycji')"))).scalar():
            await add_column_if_missing(conn, "app_koszt_pozycji", "gratis", "BOOLEAN NOT NULL DEFAULT FALSE")

        # Dodatkowe koszty kontenera w „Założeniach” kosztu jednostkowego (przepakowanie, wysyłka
        # próbek…) — nazwana część płatności dostawcy. Kwota w walucie lotu/kontenera. Lot wskazuje
        # producent (manufacturer_id), bo loty dostają nowe id przy każdym zapisie karty; item_ids =
        # pozycje, na które koszt przypięto (puste = cały lot/kontener po wartości).
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS app_koszt_dodatkowy (
                id SERIAL PRIMARY KEY,
                container_id INTEGER NOT NULL REFERENCES {settings.TABLE_CONTAINERS}(id) ON DELETE CASCADE,
                manufacturer_id INTEGER,
                nazwa VARCHAR(200) NOT NULL,
                kwota NUMERIC(14,2) NOT NULL,
                item_ids INTEGER[] NOT NULL DEFAULT '{{}}',
                position INTEGER NOT NULL DEFAULT 0,
                zapisal VARCHAR(255),
                zapisano TIMESTAMPTZ
            )
        """))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_koszt_dodatkowy_kontener ON app_koszt_dodatkowy (container_id)"))
        # Osobna pozycja (np. kartony zamówione z towarem): z płatności, ale do żadnego SKU — własny wiersz.
        await add_column_if_missing(conn, "app_koszt_dodatkowy", "osobna", "BOOLEAN NOT NULL DEFAULT FALSE")
        await add_column_if_missing(conn, "app_koszt_dodatkowy", "szt", "INTEGER")

        # Notatki do kosztu jednostkowego — dziennik wpisów (kto, kiedy), nie jedno pole do nadpisania:
        # szef ma widzieć całą historię wyjaśnień. Swój wpis zmienia/usuwa autor, każdy — administrator.
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS app_koszt_notatki (
                id SERIAL PRIMARY KEY,
                container_id INTEGER NOT NULL REFERENCES {settings.TABLE_CONTAINERS}(id) ON DELETE CASCADE,
                tresc TEXT NOT NULL,
                kto VARCHAR(255),
                kto_id INTEGER,          -- autor: tylko on edytuje (NULL = wpis przeniesiony ze starej wersji)
                kiedy TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                edytowano TIMESTAMP
            )
        """))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_koszt_notatki_kontener ON app_koszt_notatki (container_id)"))
        # Przeniesienie notatek z pierwszej wersji (jedno pole na kontenerze) do dziennika — raz:
        # po przeniesieniu pole jest czyszczone, więc kolejny start nic nie dubluje.
        await conn.execute(text(f"""
            INSERT INTO app_koszt_notatki (container_id, tresc, kto, kiedy)
            SELECT id, koszt_notatka, koszt_notatka_kto, COALESCE(koszt_notatka_kiedy, CURRENT_TIMESTAMP)
              FROM {settings.TABLE_CONTAINERS} WHERE koszt_notatka IS NOT NULL AND TRIM(koszt_notatka) <> ''
        """))
        await conn.execute(text(f"UPDATE {settings.TABLE_CONTAINERS} SET koszt_notatka = NULL WHERE koszt_notatka IS NOT NULL"))

        # Migracja: cena pozycji w walucie dostawcy (USD/CNY) / szt — z proformy/FV dostawcy.
        # Gdy jest, koszt jednostkowy (services/koszt_kontenera.py) bierze ją jako realną cenę
        # pozycji; unit_cost (PLN) zostaje do wartości kontenera. NULL = nie wpisano.
        await add_column_if_missing(conn, settings.TABLE_CONTAINER_ITEMS, "cena_waluta", "NUMERIC(14,4)")

        # Zaliczki (raty) kontenera/lotu — podpięte pod kontener ALBO lot (dokładnie jedno).
        # Backfill istniejących pojedynczych zaliczek robi migracja SQL (Session pooler),
        # tu tylko idempotentne stworzenie tabeli dla świeżych instalacji.
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_CONTAINER_ADVANCES} (
                id SERIAL PRIMARY KEY,
                container_id INTEGER REFERENCES {settings.TABLE_CONTAINERS}(id) ON DELETE CASCADE,
                lot_id INTEGER REFERENCES {settings.TABLE_CONTAINER_LOTS}(id) ON DELETE CASCADE,
                position INTEGER NOT NULL DEFAULT 0,
                procent NUMERIC,
                kwota NUMERIC,
                waluta VARCHAR(10) NOT NULL DEFAULT 'USD',
                data DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT chk_advance_parent CHECK ((container_id IS NULL) <> (lot_id IS NULL))
            )
        """))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_advances_container ON {settings.TABLE_CONTAINER_ADVANCES}(container_id)"))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_advances_lot ON {settings.TABLE_CONTAINER_ADVANCES}(lot_id)"))

        # Snapshoty KPI (4 wartości × firma × pora) — 2×/dzień. Historii nie da się odtworzyć
        # wstecz, więc klucz unikalny pilnuje idempotencji (powtórka nadpisuje, nie duplikuje).
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_KPI_SNAPSHOTS} (
                id SERIAL PRIMARY KEY,
                snap_date DATE NOT NULL,
                snap_slot VARCHAR(10) NOT NULL,
                firma_slug VARCHAR(40) NOT NULL,
                kapital_pln NUMERIC DEFAULT 0,
                magazyn_pln NUMERIC DEFAULT 0,
                magazyn_w_drodze_pln NUMERIC DEFAULT 0,
                kontenery_pln NUMERIC DEFAULT 0,
                zaplacono_pln NUMERIC DEFAULT 0,
                pozostalo_pln NUMERIC DEFAULT 0,
                captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_kpi_snap UNIQUE (snap_date, snap_slot, firma_slug)
            )
        """))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_kpi_snap_date ON {settings.TABLE_KPI_SNAPSHOTS}(snap_date)"))

        # Snapshoty stanów per SKU — cena + trzy rozłączne stany (główny / w drodze / w kontenerze).
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_STOCK_SNAPSHOTS} (
                id SERIAL PRIMARY KEY,
                snap_date DATE NOT NULL,
                snap_slot VARCHAR(10) NOT NULL,
                sku VARCHAR(120) NOT NULL,
                firma_slug VARCHAR(40) NOT NULL DEFAULT 'amh',
                cena_jednostkowa NUMERIC DEFAULT 0,
                stan_glowny INTEGER DEFAULT 0,
                stan_w_drodze INTEGER DEFAULT 0,
                w_kontenerze INTEGER DEFAULT 0,
                captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_stock_snap UNIQUE (snap_date, snap_slot, sku, firma_slug)
            )
        """))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_stock_snap_date ON {settings.TABLE_STOCK_SNAPSHOTS}(snap_date)"))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_stock_snap_sku ON {settings.TABLE_STOCK_SNAPSHOTS}(sku)"))
        # `nazwa` — ta sama kolumna co w subiekt_towary; w tabeli subiektowej bywa jeszcze pusta
        await add_column_if_missing(conn, settings.TABLE_STOCK_SNAPSHOTS, "nazwa", "TEXT")
        await add_column_if_missing(conn, settings.TABLE_SUBIEKT_DWA, "nazwa", "TEXT")

        # Załączniki kontenerów (plik trzymany w bazie jako BYTEA)
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_ATTACHMENTS} (
                id SERIAL PRIMARY KEY,
                container_id INTEGER NOT NULL REFERENCES {settings.TABLE_CONTAINERS}(id) ON DELETE CASCADE,
                filename VARCHAR(255) NOT NULL,
                file_type VARCHAR(50),
                file_size VARCHAR(50),
                content_type VARCHAR(120),
                file_data BYTEA,
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))
        # Doklejenie kolumn na zawartość pliku dla istniejących baz
        await conn.execute(text(f"ALTER TABLE {settings.TABLE_ATTACHMENTS} ADD COLUMN IF NOT EXISTS content_type VARCHAR(120)"))
        await conn.execute(text(f"ALTER TABLE {settings.TABLE_ATTACHMENTS} ADD COLUMN IF NOT EXISTS file_data BYTEA"))
        # Przenosiny do zakładki „Pliki” (routers/pliki.py → /pliki/stare-zalaczniki/przenies):
        # stary wiersz zostaje w bazie jako zapasowa kopia, ale karta kontenera go już nie pokazuje —
        # pokazuje nowy plik z Plików (id w przeniesiony_plik_id). Dzięki temu bez dubli i można powtórzyć.
        await conn.execute(text(f"ALTER TABLE {settings.TABLE_ATTACHMENTS} ADD COLUMN IF NOT EXISTS przeniesiony_plik_id INTEGER"))
        await conn.execute(text(f"ALTER TABLE {settings.TABLE_ATTACHMENTS} ADD COLUMN IF NOT EXISTS przeniesiono_at TIMESTAMP"))

        # Zakładka „Pliki” (routers/pliki.py, services/pliki.py). Folder ma rodzaj:
        #   reczny     — założony ręcznie, można zmieniać nazwę, przenosić, usuwać,
        #   producenci — jeden główny „Producenci”, zakładany sam,
        #   producent  — po jednym na producenta, pod „Producenci”,
        #   kontener   — po jednym na parę (kontener, producent) pod folderem producenta;
        #                kontener skonsolidowany ma więc folder u każdego swojego producenta.
        # Foldery automatyczne zakłada i nazywa services/pliki.py::synchronizuj_foldery.
        # usuniety_at ≠ NULL = w koszu (po 30 dniach kasowane na zawsze w _pliki_kosz_loop).
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_PLIKI_FOLDERY} (
                id SERIAL PRIMARY KEY,
                parent_id INTEGER REFERENCES {settings.TABLE_PLIKI_FOLDERY}(id) ON DELETE CASCADE,
                nazwa VARCHAR(255) NOT NULL,
                rodzaj VARCHAR(20) NOT NULL DEFAULT 'reczny',
                manufacturer_id INTEGER REFERENCES {settings.TABLE_MANUFACTURERS}(id) ON DELETE SET NULL,
                container_id INTEGER REFERENCES {settings.TABLE_CONTAINERS}(id) ON DELETE SET NULL,
                utworzono TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                utworzyl VARCHAR(255),
                usuniety_at TIMESTAMP,
                usunal VARCHAR(255),
                CONSTRAINT chk_pliki_rodzaj CHECK (rodzaj IN ('reczny','producenci','producent','kontener'))
            )
        """))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_pliki_foldery_parent ON {settings.TABLE_PLIKI_FOLDERY} (parent_id)"))
        # Jeden „Producenci”, jeden folder na producenta i jeden na parę (kontener, producent) —
        # na tych indeksach stoi ON CONFLICT DO NOTHING w synchronizacji (bez dubli przy dwóch kartach naraz).
        await conn.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS ux_pliki_foldery_producenci ON {settings.TABLE_PLIKI_FOLDERY} (rodzaj) WHERE rodzaj = 'producenci'"))
        await conn.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS ux_pliki_foldery_producent ON {settings.TABLE_PLIKI_FOLDERY} (manufacturer_id) WHERE rodzaj = 'producent'"))
        await conn.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS ux_pliki_foldery_kontener ON {settings.TABLE_PLIKI_FOLDERY} (container_id, (COALESCE(manufacturer_id, 0))) WHERE rodzaj = 'kontener'"))
        # Plik: folder_id NULL = główny poziom. container_id = kontener najbliższego folderu
        # kontenera nad plikiem (liczone przy wgraniu/przeniesieniu), pokaz_na_kontenerze = widać go
        # też na karcie kontenera. dodano_z_kontenera: wgrany z karty kontenera — usunięcie tam
        # wrzuca go do kosza; wgrany tutaj i tylko „pokazany” — usunięcie tam zdejmuje sam ptaszek.
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_PLIKI} (
                id SERIAL PRIMARY KEY,
                folder_id INTEGER REFERENCES {settings.TABLE_PLIKI_FOLDERY}(id) ON DELETE CASCADE,
                nazwa VARCHAR(255) NOT NULL,
                sciezka VARCHAR(255) NOT NULL UNIQUE,
                content_type VARCHAR(120),
                rozmiar BIGINT NOT NULL DEFAULT 0,
                container_id INTEGER REFERENCES {settings.TABLE_CONTAINERS}(id) ON DELETE SET NULL,
                pokaz_na_kontenerze BOOLEAN NOT NULL DEFAULT FALSE,
                dodano_z_kontenera BOOLEAN NOT NULL DEFAULT FALSE,
                dodano TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                dodal VARCHAR(255),
                usuniety_at TIMESTAMP,
                usunal VARCHAR(255)
            )
        """))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_pliki_folder ON {settings.TABLE_PLIKI} (folder_id)"))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_pliki_kontener ON {settings.TABLE_PLIKI} (container_id) WHERE pokaz_na_kontenerze"))
        # „Cały kontener”: plik leży w folderze kontenera u jednego producenta, ale pokazuje się
        # w folderach tego kontenera u WSZYSTKICH producentów (np. rozliczenie Lenmara). Jeden plik,
        # nie kopie — zmiana nazwy czy kosz działają wszędzie naraz. Tylko bezpośrednio w folderze
        # kontenera (podfoldery są osobne u każdego producenta).
        await add_column_if_missing(conn, settings.TABLE_PLIKI, "caly_kontener", "BOOLEAN NOT NULL DEFAULT FALSE")

        # Użytkownicy
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_USERS} (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(255),
                role VARCHAR(20) NOT NULL DEFAULT 'VIEWER',
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                CONSTRAINT chk_role CHECK (role IN ('ADMIN', 'IMPORT', 'VIEWER'))
            )
        """))

        # Doklejenie kolumn dla istniejących baz: uprawnienia per-user + onboarding
        await add_column_if_missing(conn, settings.TABLE_USERS, "permissions", "TEXT")
        await add_column_if_missing(conn, settings.TABLE_USERS, "show_onboarding", "BOOLEAN DEFAULT FALSE")
        await add_column_if_missing(conn, settings.TABLE_USERS, "updated_at", "TIMESTAMP")

        # Sesje logowania (urządzenie/IP/czas) - podgląd aktywnych sesji
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_SESSIONS} (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES {settings.TABLE_USERS}(id) ON DELETE CASCADE,
                device TEXT,
                ip VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_sessions_user ON {settings.TABLE_SESSIONS}(user_id)"))

        # Audit log - kto co kiedy
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_AUDIT_LOG} (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES {settings.TABLE_USERS}(id) ON DELETE SET NULL,
                user_email VARCHAR(255),
                action VARCHAR(100) NOT NULL,
                resource_type VARCHAR(50),
                resource_id VARCHAR(255),
                details TEXT,
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_audit_log_user ON {settings.TABLE_AUDIT_LOG}(user_id)"))
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_audit_log_created ON {settings.TABLE_AUDIT_LOG}(created_at DESC)"))
        # Dziennik po ludzku (sql/2026-10-dziennik-audytu.sql): zdanie, zmiany „było → jest”, obszar.
        await add_column_if_missing(conn, settings.TABLE_AUDIT_LOG, "message", "TEXT")
        await add_column_if_missing(conn, settings.TABLE_AUDIT_LOG, "changes", "JSONB")
        await add_column_if_missing(conn, settings.TABLE_AUDIT_LOG, "area", "VARCHAR(30)")

        # Kursy walut NBP (tabela A) → PLN. Composite PK (currency, rate_date) służy też
        # jako indeks pod zapytanie sezonowe: WHERE currency=X AND rate_date<D ORDER BY rate_date DESC.
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_FX_RATES} (
                currency  VARCHAR(3)     NOT NULL,
                rate_date DATE           NOT NULL,
                mid       NUMERIC(18,8)  NOT NULL,
                PRIMARY KEY (currency, rate_date)
            )
        """))

        # Rozbicie odczytu salda na subkonta i waluty (rachunek Acti ma PLN, EUR, USD…).
        # Kurs NBP i jego data zapisują się przy wpisie — „zamrożone”, żeby suma w zł nie
        # zmieniała się po fakcie. Stare odczyty nie mają linijek: to jedna kwota w zł.
        # Tabelę salda zakładano ręcznie w Supabase, więc linijki dokładamy tylko, gdy ona już jest,
        # a typ klucza bierzemy z niej (integer/bigint) — błąd REFERENCES przerwałby całą transakcję startu.
        typ_id = (await conn.execute(text(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
            "WHERE attrelid = to_regclass(:t) AND attname = 'id' AND NOT attisdropped"
        ), {"t": settings.TABLE_BANK_BALANCES})).scalar()
        if typ_id in ("integer", "bigint"):
            await conn.execute(text(f"""
                CREATE TABLE IF NOT EXISTS {settings.TABLE_BANK_BALANCE_LINES} (
                    id         SERIAL PRIMARY KEY,
                    balance_id {typ_id} NOT NULL REFERENCES {settings.TABLE_BANK_BALANCES}(id) ON DELETE CASCADE,
                    position   INTEGER NOT NULL DEFAULT 0,
                    label      VARCHAR(60),
                    currency   VARCHAR(3) NOT NULL,
                    amount     NUMERIC(16,2) NOT NULL,
                    rate       NUMERIC(18,8) NOT NULL,
                    rate_date  DATE,
                    amount_pln NUMERIC(16,2) NOT NULL
                )
            """))
            await conn.execute(text(
                f"CREATE INDEX IF NOT EXISTS ix_bank_balance_lines_balance "
                f"ON {settings.TABLE_BANK_BALANCE_LINES} (balance_id)"
            ))

        # Dziennik synchronizacji (świeżość danych): po jednym wierszu na każdy bieg
        # pobrania (Sellasist auto/ręczny zapisuje sam; Subiekt — jeśli skrypt loguje).
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_SYNC_LOG} (
                id          SERIAL PRIMARY KEY,
                source      VARCHAR        NOT NULL,
                started_at  TIMESTAMP,
                finished_at TIMESTAMP,
                ok          BOOLEAN,
                inserted    INTEGER DEFAULT 0,
                updated     INTEGER DEFAULT 0,
                items_added INTEGER DEFAULT 0,
                message     VARCHAR,
                error       VARCHAR
            )
        """))

        # Licznik zużycia LLM (asystent): jeden wiersz na turę czatu — tokeny in/out + koszt USD.
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS app_llm_usage (
                id            BIGSERIAL PRIMARY KEY,
                created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
                query         TEXT,
                model         TEXT,
                input_tokens  INTEGER       NOT NULL DEFAULT 0,
                output_tokens INTEGER       NOT NULL DEFAULT 0,
                cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
                api_calls     INTEGER       NOT NULL DEFAULT 1
            )
        """))

        # Ręcznie rejestrowane dopłaty do konta LLM (przycisk w panelu, tylko super-admin).
        # "Wpłacone" w liczniku = STARTING_BALANCE_USD (env) + suma tych dopłat.
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS app_llm_topups (
                id         BIGSERIAL PRIMARY KEY,
                created_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
                amount_usd NUMERIC(12,2)  NOT NULL,
                note       TEXT,
                added_by   TEXT
            )
        """))

        # Zakładki „test-wycena” / „Cena” (routers/wycena.py). Obie tabele z danymi to
        # DZIENNIKI, nie pola do nadpisania: każdy zapis to nowy wiersz, aktualny = najnowszy.
        # Dzięki temu „kto ustawił i kiedy” oraz historia zmian są za darmo.
        # Cena minimalna: detal (sklepy) i hurt (= dropy), netto + brutto z VAT z chwili zapisu,
        # razem z kosztem, przy którym ją ustawiono — karta ostrzega, gdy koszt od tego czasu urósł.
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS app_cena_minimalna (
                id          SERIAL PRIMARY KEY,
                sku_canon   TEXT          NOT NULL,          -- LOWER(TRIM(sku))
                sku         TEXT          NOT NULL,
                kanal       TEXT          NOT NULL,          -- services/wycena.py → KANALY
                cena_netto  NUMERIC(12,2) NOT NULL,
                cena_brutto NUMERIC(12,2) NOT NULL,
                vat         NUMERIC(5,2)  NOT NULL,
                baza        TEXT          NOT NULL,          -- 'fifo' | 'srednia' | 'wlasna'
                koszt_bazy  NUMERIC(12,2) NOT NULL,
                marza       NUMERIC(7,2)  NOT NULL,
                koszty      JSONB         NOT NULL DEFAULT '[]',
                szablon     TEXT,
                ustawil_id  INTEGER,
                ustawil     TEXT,
                ustawiono   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
            )
        """))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_cena_minimalna_sku ON app_cena_minimalna (sku_canon, kanal, ustawiono DESC)"))
        # Pierwsza wersja miała CHECK tylko na 'detal'/'hurt'; teraz w tym samym dzienniku są też
        # ceny sugerowane. Listę pilnuje API (Literal w models.py), więc ograniczenie zdejmujemy.
        await conn.execute(text("ALTER TABLE app_cena_minimalna DROP CONSTRAINT IF EXISTS app_cena_minimalna_kanal_check"))
        # Aktualna cena sprzedaży (detal, brutto) — wpisywana ręcznie w „test-wycena”, nie liczona.
        # Liczona z zamówień myliła (jedno łóżko z rabatem i średnia już „dziwna”). Też dziennik:
        # aktualna = najnowsza, starsze = historia „kto i kiedy”.
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS app_cena_aktualna (
                id          SERIAL PRIMARY KEY,
                sku_canon   TEXT          NOT NULL,          -- LOWER(TRIM(sku))
                sku         TEXT          NOT NULL,
                cena_brutto NUMERIC(12,2) NOT NULL,
                cena_netto  NUMERIC(12,2) NOT NULL,
                vat         NUMERIC(5,2)  NOT NULL,          -- VAT produktu z chwili zapisu
                ustawil_id  INTEGER,
                ustawil     TEXT,
                ustawiono   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
            )
        """))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_cena_aktualna_sku ON app_cena_aktualna (sku_canon, ustawiono DESC)"))
        # Ceny u konkurencji: jeden aktywny wpis na sklep (najnowszy), starsze = historia.
        # Usunięcie sklepu oznacza wszystkie jego wiersze (usunieto), nic nie kasujemy.
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS app_konkurencja_ceny (
                id          SERIAL PRIMARY KEY,
                sku_canon   TEXT          NOT NULL,
                sku         TEXT          NOT NULL,
                sklep       TEXT          NOT NULL,
                sklep_canon TEXT          NOT NULL,          -- LOWER(TRIM(sklep)) — ten sam sklep inaczej wpisany
                cena_brutto NUMERIC(12,2) NOT NULL,
                link        TEXT,
                dodal_id    INTEGER,
                dodal       TEXT,
                dodano      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
                usunieto    TIMESTAMPTZ,
                usunal      TEXT
            )
        """))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_konkurencja_ceny_sku ON app_konkurencja_ceny (sku_canon)"))
        # Szablony kalkulatora (wspólne dla wszystkich produktów): marża + lista kosztów „+”.
        # cel = 'detal' / 'hurt' → przycisk „Ustaw jako cenę minimalną” podpowiada ten kanał.
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS app_wycena_szablony (
                id         SERIAL PRIMARY KEY,
                nazwa      VARCHAR(120)  NOT NULL,
                cel        TEXT,
                marza      NUMERIC(7,2)  NOT NULL DEFAULT 0,
                koszty     JSONB         NOT NULL DEFAULT '[]',
                kolejnosc  INTEGER       NOT NULL DEFAULT 0,
                zmienil    TEXT,
                zmieniono  TIMESTAMPTZ
            )
        """))
        from services.wycena import DOMYSLNE_SZABLONY, KANAL_NAZWA, STARE_SZABLONY, STARY_ERLI
        # Szablony z pierwszej wersji (stare nazwy) → nowa lista pięciu cen. Raz: po zmianie nazw
        # stare już nie istnieją, więc kolejny start nic nie robi.
        stare = [s[0] for s in STARE_SZABLONY] + [STARY_ERLI]
        if (await conn.execute(text("SELECT EXISTS (SELECT 1 FROM app_wycena_szablony WHERE nazwa = ANY(:n))"),
                               {"n": stare})).scalar():
            for stara, nowa, cel, kol in STARE_SZABLONY:
                await conn.execute(text("UPDATE app_wycena_szablony SET nazwa = :nowa, cel = :cel, kolejnosc = :k WHERE nazwa = :stara"),
                                   {"nowa": nowa, "cel": cel, "k": kol, "stara": stara})
            await conn.execute(text("DELETE FROM app_wycena_szablony WHERE nazwa = :n AND zmienil IS NULL"), {"n": STARY_ERLI})
            if not (await conn.execute(text("SELECT EXISTS (SELECT 1 FROM app_wycena_szablony WHERE cel = 'sug_detal')"))).scalar():
                s = next(x for x in DOMYSLNE_SZABLONY if x["cel"] == "sug_detal")
                await conn.execute(
                    text("""INSERT INTO app_wycena_szablony (nazwa, cel, marza, koszty, kolejnosc)
                            VALUES (:n, :c, :m, CAST(:k AS JSONB), 2)"""),
                    {"n": KANAL_NAZWA["sug_detal"], "c": "sug_detal", "m": s["marza"], "k": json.dumps(s["koszty"])},
                )
        # Szablony dołożone później (DOSZLE_SZABLONY) — raz na bazę; znacznik w app_wycena_dodane,
        # żeby szablonu usuniętego przez właściciela nie wstawiać przy każdym starcie od nowa.
        await conn.execute(text("CREATE TABLE IF NOT EXISTS app_wycena_dodane (cel TEXT PRIMARY KEY, dodano TIMESTAMPTZ NOT NULL DEFAULT NOW())"))
        nowa_baza = not (await conn.execute(text("SELECT EXISTS (SELECT 1 FROM app_wycena_szablony)"))).scalar()
        from services.wycena import DOSZLE_SZABLONY
        for cel, kol in DOSZLE_SZABLONY:
            if not (await conn.execute(text("SELECT EXISTS (SELECT 1 FROM app_wycena_dodane WHERE cel = :c)"), {"c": cel})).scalar():
                if not nowa_baza:   # świeża baza dostaje go niżej razem z resztą
                    s = next(x for x in DOMYSLNE_SZABLONY if x["cel"] == cel)
                    await conn.execute(text("UPDATE app_wycena_szablony SET kolejnosc = kolejnosc + 1 WHERE kolejnosc >= :k"), {"k": kol})
                    await conn.execute(
                        text("""INSERT INTO app_wycena_szablony (nazwa, cel, marza, koszty, kolejnosc)
                                VALUES (:n, :c, :m, CAST(:k AS JSONB), :o)"""),
                        {"n": s["nazwa"], "c": cel, "m": s["marza"], "k": json.dumps(s["koszty"]), "o": kol},
                    )
                await conn.execute(text("INSERT INTO app_wycena_dodane (cel) VALUES (:c) ON CONFLICT DO NOTHING"), {"c": cel})
        if nowa_baza:
            for i, s in enumerate(DOMYSLNE_SZABLONY):
                await conn.execute(
                    text("""INSERT INTO app_wycena_szablony (nazwa, cel, marza, koszty, kolejnosc)
                            VALUES (:n, :c, :m, CAST(:k AS JSONB), :o)"""),
                    {"n": s["nazwa"], "c": s["cel"], "m": s["marza"], "k": json.dumps(s["koszty"]), "o": i},
                )

        # Tworzenie domyślnego admina jeśli ustawione w env i nie ma żadnego użytkownika
        if settings.ADMIN_EMAIL and settings.ADMIN_PASSWORD:
            count_result = await conn.execute(text(f"SELECT COUNT(*) FROM {settings.TABLE_USERS}"))
            user_count = count_result.scalar()
            if user_count == 0:
                pwd_err = validate_password_strength(settings.ADMIN_PASSWORD)
                if pwd_err:
                    print(f"[ERROR] ADMIN_PASSWORD słabe: {pwd_err}. Admin NIE utworzony.")
                else:
                    hashed = hash_password(settings.ADMIN_PASSWORD)
                    await conn.execute(
                        text(f"INSERT INTO {settings.TABLE_USERS} (email, password_hash, full_name, role) VALUES (:e, :h, :n, 'ADMIN')"),
                        {"e": settings.ADMIN_EMAIL, "h": hashed, "n": "Administrator"}
                    )
                    print(f"[INFO] Utworzono domyślnego admina: {settings.ADMIN_EMAIL}")

        # Indeksy
        try:
            await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_sellasist_items_symbol_lower ON {settings.TABLE_ORDER_ITEMS} (LOWER(TRIM({settings.COL_ITEM_SKU})))"))
            await conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_subiekt_towary_symbol_lower ON {settings.TABLE_PRODUCTS} (LOWER(TRIM({settings.COL_PRODUCT_SKU})))"))
        except Exception as e:
            print(f"[indexes] {e}")

    # Top-up kursów walut NBP — idempotentny, NIE blokuje startu jeśli NBP jest niedostępne.
    # Jednorazowy strzał przy starcie: dane świeże już od pierwszego requestu.
    # Pełną historię backfillujesz raz przez POST /api/admin/fx/backfill.
    try:
        from database import SessionLocal
        from services.fx import topup_recent
        async with SessionLocal() as session:
            res = await topup_recent(session)
        print(f"[fx] top-up kursów NBP (start): {res}")
    except Exception as e:
        print(f"[fx] top-up pominięty (start aplikacji nie jest blokowany): {e}")

    # Harmonogram w tle: co FX_REFRESH_INTERVAL_SECONDS dociąga nowe kursy — kursy
    # odświeżają się same, bez deployu i bez konfiguracji w Railway.
    fx_task = asyncio.create_task(_fx_refresh_loop())
    sellasist_task = asyncio.create_task(_sellasist_auto_loop())
    snapshot_task = asyncio.create_task(_snapshot_loop())
    dropy_push_task = asyncio.create_task(_dropy_push_loop())
    audit_task = asyncio.create_task(_audit_retention_loop())
    pliki_kosz_task = asyncio.create_task(_pliki_kosz_loop())

    yield

    # Sprzątanie przy zamknięciu
    for _t in (fx_task, sellasist_task, snapshot_task, dropy_push_task, audit_task, pliki_kosz_task):
        _t.cancel()
        try:
            await _t
        except asyncio.CancelledError:
            pass
    await engine.dispose()
