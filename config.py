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

    TABLE_PRODUCTS: str = "subiekt_towary"
    COL_PRODUCT_SKU: str = "symbol"
    COL_PRODUCT_NAME: str = "nazwa"
    COL_PRODUCT_STOCK: str = "stan_dostepny"
    COL_PRODUCT_PRICE: str = "cena_zakupu_netto"

    TABLE_ORDERS: str = "sellasist_orders"
    COL_ORDER_ID: str = "order_id"
    COL_ORDER_DATE: str = "order_date"
    COL_ORDER_STATUS: str = "status_name"

    TABLE_ORDER_ITEMS: str = "sellasist_order_items"
    COL_ITEM_ORDER_ID: str = "order_id"
    COL_ITEM_SKU: str = "symbol"
    COL_ITEM_QTY: str = "quantity"
    COL_ITEM_EAN: str = "ean"

    EXCLUDED_ORDER_STATUSES: str = ""

    TABLE_LEAD_TIMES: str = "app_lead_times"
    TABLE_PRODUCT_ATTRS: str = "app_product_attrs"
    TABLE_MANUFACTURERS: str = "app_manufacturers"
    TABLE_CONTAINER_TYPES: str = "app_container_types"
    TABLE_CONTAINERS: str = "app_containers"
    TABLE_CONTAINER_ITEMS: str = "app_container_items"
    TABLE_ATTACHMENTS: str = "app_container_attachments"
    TABLE_USERS: str = "app_users"
    TABLE_AUDIT_LOG: str = "app_audit_log"

    DEFAULT_LEAD_TIME_DAYS: int = 90

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


EXCLUDED_STATUS_FILTER = excluded_status_clause("o")
