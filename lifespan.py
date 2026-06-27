"""
Lifespan aplikacji: przy starcie tworzy brakujące tabele, dokłada brakujące kolumny
(migracje ALTER TABLE), wstawia domyślne typy kontenerów, tworzy domyślnego admina
(jeśli baza userów pusta), zakłada indeksy i dociąga świeże kursy walut NBP.
Przy zamknięciu zwalnia pulę połączeń.
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text

from config import settings
from database import engine, add_column_if_missing
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
    """Harmonogram: o pełnych godzinach 7–17 (czas warszawski) odświeża dane Sellasista.
    Woła funkcję bezpośrednio (nie endpoint), pomija bieg jeśli akurat trwa ręczny,
    każdy błąd łapany — pętla nigdy nie umiera. Działa tylko gdy skonfigurowane."""
    if not settings.SELLASIST_AUTO_ENABLED:
        print("[sellasist] automat wyłączony (SELLASIST_AUTO_ENABLED=false)")
        return
    from services.sellasist import is_configured, is_running, mark_started, run_refresh, get_status
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

        # Typy kontenerów
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_CONTAINER_TYPES} (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                capacity_cbm DECIMAL(8,2) NOT NULL,
                sort_order INTEGER DEFAULT 0
            )
        """))

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
        # Migracja: ulubione
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "is_favorite", "BOOLEAN DEFAULT FALSE")
        # Migracja: EAN
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "ean", "VARCHAR(50)")
        # Migracja: ręczne wymuszenie statusu
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "forced_status", "VARCHAR(30)")
        # Migracja: firma macierzysta produktu (NULL = AMH). Override per-sku, jak manufacturer_id.
        await add_column_if_missing(conn, settings.TABLE_PRODUCT_ATTRS, "firma_id", f"INTEGER REFERENCES {settings.TABLE_FIRMY}(id) ON DELETE SET NULL")

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

        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {settings.TABLE_CONTAINER_ITEMS} (
                id SERIAL PRIMARY KEY,
                container_id INTEGER NOT NULL REFERENCES {settings.TABLE_CONTAINERS}(id) ON DELETE CASCADE,
                sku VARCHAR(255) NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                unit_cost DECIMAL(10,2)
            )
        """))

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

    yield

    # Sprzątanie przy zamknięciu
    for _t in (fx_task, sellasist_task):
        _t.cancel()
        try:
            await _t
        except asyncio.CancelledError:
            pass
    await engine.dispose()
