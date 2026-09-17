"""Konfiguracja serwisu portalu dropów.

Osobny serwis = osobne zmienne środowiskowe. Nic tu nie jest współdzielone
z Magazynem: inne połączenie do bazy (rola dropy_app), inny sekret JWT.
Gdyby token z Magazynu trafił tutaj, nie przejdzie — inny podpis i inne `aud`.
"""

import os


class Settings:
    # Połączenie na roli dropy_app — widzi TYLKO schemat `dropy`.
    DATABASE_URL: str = os.getenv("DROPY_DATABASE_URL", "")

    # Własny sekret. NIGDY ten sam co SECRET_KEY Magazynu.
    JWT_SECRET: str = os.getenv("DROPY_JWT_SECRET", "")
    JWT_ALGORITHM: str = "HS256"
    JWT_AUDIENCE: str = "dropy-portal"
    JWT_EXPIRE_HOURS: int = int(os.getenv("DROPY_JWT_EXPIRE_HOURS", "12"))

    # Domena portalu partnera (front). Bez gwiazdek.
    ALLOWED_ORIGINS: str = os.getenv("DROPY_ALLOWED_ORIGINS", "")

    VAT: float = 1.23
    LOW_STOCK_AT: int = 5          # poniżej tego pokazujemy „ostatnie sztuki"


settings = Settings()
