"""
Połączenie z bazą (Supabase / PostgreSQL przez asyncpg).
Session pooler port 5432 + statement_cache_size=0 (PgBouncer nie lubi prepared statements).
"""

import time
from contextvars import ContextVar
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import NullPool

from config import settings


engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    # Pulowanie oddajemy poolерowi Supabase — własna pula SQLAlchemy na wierzchu
    # PgBouncera oddawała losowo „nieświeże" połączenia (upload działał dopiero za którymś razem).
    poolclass=NullPool,
    connect_args={
        "timeout": 30,
        "command_timeout": 30,
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
    },
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


# Pomiar czasu zestawienia połączenia z bazą (NullPool → nowe połączenie na każde
# żądanie). Middleware w main.py wkłada do kontekstu pusty słownik, get_db dopisuje
# do niego czas, a log „[wolne]" pokazuje, ile z całego żądania zjadło samo łączenie.
db_timing: ContextVar[Optional[dict]] = ContextVar("db_timing", default=None)


async def get_db():
    """Dependency FastAPI - sesja bazy na czas żądania."""
    async with SessionLocal() as session:
        t0 = time.perf_counter()
        await session.connection()
        slot = db_timing.get()
        if slot is not None:
            slot["connect_ms"] = (time.perf_counter() - t0) * 1000
        yield session


async def add_column_if_missing(conn, table: str, column: str, definition: str):
    """Dodaje kolumnę jeśli nie istnieje. Pomija jak istnieje."""
    try:
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {definition}"))
    except Exception as e:
        print(f"[migration] {table}.{column}: {e}")
