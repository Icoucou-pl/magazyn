"""
Połączenie z bazą (Supabase / PostgreSQL przez asyncpg).
Session pooler port 5432 + statement_cache_size=0 (PgBouncer nie lubi prepared statements).
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

from config import settings


engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=5,
    pool_timeout=30,
    pool_recycle=300,
    connect_args={
        "timeout": 30,
        "command_timeout": 30,
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
    },
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db():
    """Dependency FastAPI - sesja bazy na czas żądania."""
    async with SessionLocal() as session:
        yield session


async def add_column_if_missing(conn, table: str, column: str, definition: str):
    """Dodaje kolumnę jeśli nie istnieje. Pomija jak istnieje."""
    try:
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {definition}"))
    except Exception as e:
        print(f"[migration] {table}.{column}: {e}")
