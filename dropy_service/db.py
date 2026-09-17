"""Połączenie do bazy dla portalu.

Ustawienia 1:1 z database.py Magazynu — ta sama baza, ten sam Session Pooler
Supabase, więc te same wymagania:
  · NullPool — pulowaniem zajmuje się PgBouncer, własna pula na wierzchu oddaje
    losowo nieświeże połączenia,
  · statement_cache_size = 0 — PgBouncer nie trawi prepared statements.

Różnica jest jedna i celowa: łączymy się rolą `dropy_app`, a search_path
ustawiamy na `dropy`, żeby nawet zapytanie bez prefiksu nie poszło do public.
"""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    poolclass=NullPool,
    connect_args={
        "timeout": 30,
        "command_timeout": 30,
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
        "server_settings": {"search_path": "dropy"},
    },
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db():
    """Dependency FastAPI — sesja bazy na czas żądania."""
    async with SessionLocal() as session:
        yield session
