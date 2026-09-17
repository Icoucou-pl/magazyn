"""Połączenie do bazy dla portalu.

NullPool jest wymagany przy Supabase PgBouncer — tak samo jak w Magazynie.
search_path ustawiony na `dropy`, więc nawet zapytanie bez prefiksu nie trafi
przypadkiem do public (do którego ta rola i tak nie ma praw).
"""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    poolclass=NullPool,
    connect_args={"server_settings": {"search_path": "dropy"}},
)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session
