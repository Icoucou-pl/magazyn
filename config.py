"""
Konfiguracja aplikacji - ustawienia z env variables (Railway) lub .env (lokalnie).
Buduje DATABASE_URL z osobnych zmiennych DB_* jeśli nie podano gotowego URL.
"""

from typing import Optional
import secrets

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = ""
    DB_HOST: str = ""
    DB_PORT: int = 5432
    DB_NAME: str = ""
    DB_USER: str = ""
    DB_PASSWORD: str = ""

    ALLOWED_ORIGINS: str = "http://localhost:3000"

    # Asystent AI — provider-agnostyczny (endpoint zgodny z OpenAI: Groq / Gemini / Ollama / Anthropic).
    # Przełączenie dostawcy = zmiana tych 3 zmiennych, bez ruszania kodu.
    LLM_BASE_URL: str = ""                        # np. https://api.groq.com/openai/v1
    LLM_API_KEY: str = ""                         # klucz dostawcy
    LLM_MODEL: str = "llama-3.3-70b-versatile"    # domyślnie darmowy Groq
    STARTING_BALANCE_USD: float = 10.0            # ile realnie wrzucone na konto (do salda w liczniku)

    TABLE_EXTERNAL_STOCK: str = "sellasist_stock"   # stany z Sellasistów nie-AMH (Faza 2b)

    TABLE_PRODUCTS: str = "subiekt_towary"
    COL_PRODUCT_SKU: str = "symbol"
    COL_PRODUCT_NAME: str = "nazwa"
    COL_PRODUCT_STOCK: str = "stan_dostepny"
    COL_PRODUCT_PRICE: str = "cena_zakupu_netto"

    TABLE_ORDERS: str = "sellasist_orders"
    COL_ORDER_ID: str = "order_id"
    COL_ORDER_DATE: str = "order_date"
    COL_ORDER_STATUS: str = "status_name"
    COL_ORDER_CREATOR: str = "creator"      # źródło kanału sprzedaży (Allegro/Erli/Studio-Bay/Klaudia/I-CC.PL)

    TABLE_ORDER_ITEMS: str = "sellasist_order_items"
    COL_ITEM_ORDER_ID: str = "order_id"
    COL_ITEM_SKU: str = "symbol"
    COL_ITEM_QTY: str = "quantity"
    COL_ITEM_EAN: str = "ean"
    COL_ITEM_PRICE: str = "price"            # cena jednostkowa brutto
    COL_ITEM_PRICE_NETTO: str = "price_netto"  # cena jednostkowa netto
    COL_ITEM_CURRENCY: str = "currency"

    EXCLUDED_ORDER_STATUSES: str = ""

    # Whitelist statusów liczonych jako ZREALIZOWANA sprzedaż (zgodnie z Power BI).
    # Tylko te statusy wchodzą do przychodu/ilości/sprzedaży 30d-90d. Reszta (anulowane,
    # zwroty, reklamacje, w toku, wysłane-niedoręczone, raty/leasing, błędy) NIE liczy się.
    # Whitelist > blacklist: nowy status w Sellasiście sam z siebie nie zawyży sprzedaży.
    # Nazwy MUSZĄ być 1:1 jak w bazie (status_name). Pusty string = brak filtra (liczy wszystko).
    INCLUDED_ORDER_STATUSES: str = (
        "Doręczone - allegro,Doręczone - drop,Doręczone - gratis,Doręczone - erli,"
        "Doręczone - osobiście,Doręczone - reklamacje,Doręczone - sklep,"
        "Doręczone - Studio Bay,Exchange - zakończony"
    )

    # Whitelista statusów dla sklepów nie-AMH (Acti/Veluxa) — mają inny workflow:
    # realizacja kończy się na "Wysłane" (AMH ma własne "Wysłane" = w drodze, dlatego
    # whitelisty są ROZDZIELONE per sklep). Doręczone - * dodane na zapas (future-proof,
    # gdy Acti zacznie domykać do doręczenia); nazwy 1:1 jak w bazie danego sklepu —
    # nieistniejący jeszcze status jest nieszkodliwy (whitelist > blacklist).
    INCLUDED_ORDER_STATUSES_EXT: str = (
        "Wysłane,Odebrane przez kuriera,Doręczone - Allegro,Doręczone - Sklep"
    )

    # --- Kursy walut NBP (tabela A) → przewalutowanie na PLN ---
    # app_fx_rates trzyma kurs średni (mid) per 1 jednostka waluty, per dzień roboczy.
    # EUR/CZK/HUF są wszystkie w tabeli A NBP, mid jest znormalizowany per 1 jednostkę
    # (HUF ~0.0126, CZK ~0.176, EUR ~4.48), więc wartość_PLN = wartość_waluty × mid.
    TABLE_FX_RATES: str = "app_fx_rates"
    TABLE_SYNC_LOG: str = "app_sync_log"
    FX_BASE_CURRENCY: str = "PLN"           # waluta bazowa - mnożnik 1, bez przewalutowania
    FX_CURRENCIES: str = "EUR,CZK,HUF"      # waluty obce do pobierania z NBP (lista po przecinku)
    NBP_API_BASE: str = "https://api.nbp.pl/api"

    TABLE_LEAD_TIMES: str = "app_lead_times"
    TABLE_PRODUCT_ATTRS: str = "app_product_attrs"
    TABLE_CN_SKU: str = "app_cn_sku"
    TABLE_MANUFACTURERS: str = "app_manufacturers"
    TABLE_FIRMY: str = "app_firmy"
    TABLE_CONTAINER_TYPES: str = "app_container_types"
    TABLE_CONTAINERS: str = "app_containers"
    TABLE_CONTAINER_ITEMS: str = "app_container_items"
    TABLE_CONTAINER_LOTS: str = "app_container_lots"
    TABLE_ATTACHMENTS: str = "app_container_attachments"
    TABLE_USERS: str = "app_users"
    TABLE_AUDIT_LOG: str = "app_audit_log"
    TABLE_SESSIONS: str = "app_sessions"

    DEFAULT_LEAD_TIME_DAYS: int = 90

    # Kontenery: po przekroczeniu ETA kontener wchodzi automatycznie w status
    # "Odprawa celna" (CUSTOMS) na CONTAINER_CUSTOMS_DAYS dni (licząc od dnia PO ETA),
    # a następnie sam zmienia się na "Dostarczone". Ręczny status DELIVERED zawsze wygrywa.
    CONTAINER_CUSTOMS_DAYS: int = 7

    # --- Sellasist (ingesta zamówień w aplikacji: przycisk "Odśwież" w headerze) ---
    # Te same wartości co w skryptach z Task Schedulera. Ustaw w ENV Railway:
    #   SELLASIST_API_KEY  - klucz API (nagłówek apiKey)
    #   SELLASIST_BASE_URL - bazowy adres API (np. https://twojadomena/api/v1)
    # Pusty klucz/URL = przycisk zwróci czytelny błąd "nie skonfigurowano".
    SELLASIST_API_KEY: str = ""
    SELLASIST_BASE_URL: str = ""
    SELLASIST_TIMEOUT: int = 30          # sekundy na pojedynczy request
    SELLASIST_PAGE_SIZE: int = 100       # rozmiar partii GET /orders (offset)
    SELLASIST_DAYS_BACK: int = 60        # okno listy nagłówków (dni wstecz)
    SELLASIST_ITEMS_DAYS_BACK: int = 14  # okno dociągania pozycji (samonaprawa) — krótkie,
                                         # żeby hourly nie odpytywał w kółko pustych koszyków
    SELLASIST_WEBHOOK_SECRET: str = ""   # rezerwa pod webhook (czat AUTH/później)

    # Automat: co godzinę o pełnej godzinie w oknie [START..END] czasu warszawskiego.
    # Domyślnie 7–20. Wyłącznik: SELLASIST_AUTO_ENABLED=false. Bieg i tak rusza tylko
    # gdy klucz/URL są ustawione i gdy nie trwa już ręczne odświeżanie.
    SELLASIST_AUTO_ENABLED: bool = True
    SELLASIST_AUTO_START_HOUR: int = 7
    SELLASIST_AUTO_END_HOUR: int = 20

    # Auth - WAŻNE: w produkcji ustaw silny SECRET_KEY w zmiennych środowiskowych Railway!
    SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_DAYS: int = 7

    # Domyślny admin - tworzy się automatycznie przy pierwszym uruchomieniu
    ADMIN_EMAIL: str = ""
    ADMIN_PASSWORD: str = ""
    # Super-admin - tylko ten email widzi audit log (ustaw ten sam co ADMIN_EMAIL)
    SUPER_ADMIN_EMAIL: str = ""

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        # Na Railway plik .env nie istnieje - czyta z env variables bezpośrednio
        extra = "ignore"


settings = Settings()


# Zbuduj DATABASE_URL z osobnych zmiennych jeśli nie podano gotowego
if not settings.DATABASE_URL and settings.DB_HOST:
    from urllib.parse import quote_plus
    pw = quote_plus(settings.DB_PASSWORD)
    user = quote_plus(settings.DB_USER)
    settings.DATABASE_URL = f"postgresql+asyncpg://{user}:{pw}@{settings.DB_HOST}:{settings.DB_PORT}/{settings.DB_NAME}?prepared_statement_cache_size=0"

if not settings.DATABASE_URL:
    raise RuntimeError("Brak konfiguracji bazy. Ustaw DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD w .env")

# Auth setup - jeśli brak SECRET_KEY generujemy tymczasowy (w produkcji USTAW stały w env!)
if not settings.SECRET_KEY:
    settings.SECRET_KEY = secrets.token_urlsafe(48)
    print("[WARNING] SECRET_KEY nie ustawiony w env - wygenerowano tymczasowy. W produkcji USTAW go w zmiennych środowiskowych Railway!")


def to_float(v, default: float = 0.0) -> float:
    """Konwertuje Decimal/None/str na float - Supabase zwraca Decimal zamiast float."""
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def excluded_status_clause(alias: str = "o") -> str:
    """Buduje fragment SQL filtrujący wykluczone statusy zamówień."""
    if not settings.EXCLUDED_ORDER_STATUSES.strip():
        return ""
    statuses = [s.strip() for s in settings.EXCLUDED_ORDER_STATUSES.split(",") if s.strip()]
    quoted = ",".join(f"'{s}'" for s in statuses)
    return f"AND {alias}.{settings.COL_ORDER_STATUS} NOT IN ({quoted})"


def included_status_clause(alias: str = "o") -> str:
    """Buduje fragment SQL zawężający do whitelisty statusów = sprzedaż zrealizowana
    (zgodnie z Power BI), ROZDZIELONEJ per sklep: AMH ma własne statusy "Doręczone - *",
    sklepy nie-AMH (Acti/Veluxa) realizują na "Wysłane". Warunek działa per-wiersz
    (po {alias}.shop), więc jest poprawny i dla pojedynczego sklepu, i dla "Wszystkich".

    WYDAJNOŚĆ: pierwszy warunek to płaskie `status_name IN (suma obu whitelist)` —
    indeksowalne (idx_orders_status, bitmap scan), redukuje zbiór zanim policzy się
    droższy OR per-shop. Bez tego pre-filtru sam OR po różnych kolumnach wymusza seq scan.
    Obie whitelisty puste → brak filtra (liczy wszystko)."""
    amh = [s.strip() for s in settings.INCLUDED_ORDER_STATUSES.split(",") if s.strip()]
    ext = [s.strip() for s in settings.INCLUDED_ORDER_STATUSES_EXT.split(",") if s.strip()]
    if not amh and not ext:
        return ""
    col = f"{alias}.{settings.COL_ORDER_STATUS}"
    shop = f"{alias}.shop"

    def _q(lst):
        return ",".join("'" + s.replace("'", "''") + "'" for s in lst)

    combined = list(dict.fromkeys(amh + ext))  # suma, dedup, kolejność zachowana
    prefilter = f"{col} IN ({_q(combined)})"

    parts = []
    if amh:
        parts.append(f"({shop} = 'amh' AND {col} IN ({_q(amh)}))")
    if ext:
        parts.append(f"({shop} <> 'amh' AND {col} IN ({_q(ext)}))")
    detailed = "(" + " OR ".join(parts) + ")"
    return f"AND {prefilter} AND {detailed}"


def sales_channel_case(alias: str = "o") -> str:
    """Buduje wyrażenie CASE mapujące sellasist_orders.creator → kanał sprzedaży.
    Reguła 1:1 z Power BI: case-insensitive, PIERWSZE trafienie wygrywa (jak if/else if),
    kolejność WHEN ma znaczenie. creator NULL/puste → 'I-CC.PL'.
    Kanały: Allegro, Erli, Studio-Bay, Klaudia (klaudia LUB api), I-CC.PL (reszta)."""
    c = f"LOWER(COALESCE({alias}.{settings.COL_ORDER_CREATOR}, ''))"
    return (
        "CASE "
        f"WHEN {c} LIKE '%allegro%' THEN 'Allegro' "
        f"WHEN {c} LIKE '%erli%' THEN 'Erli' "
        f"WHEN {c} LIKE '%studio%' THEN 'Studio-Bay' "
        f"WHEN {c} LIKE '%klaudia%' OR {c} LIKE '%api%' THEN 'Klaudia' "
        "ELSE 'I-CC.PL' END"
    )


EXCLUDED_STATUS_FILTER = excluded_status_clause("o")
INCLUDED_STATUS_FILTER = included_status_clause("o")
SALES_CHANNEL_CASE = sales_channel_case("o")
