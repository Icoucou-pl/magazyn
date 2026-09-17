"""Portal dropów — osobny serwis.

Świadomie NIE importuje niczego z Magazynu. Ma własną bazę (rola dropy_app),
własny sekret JWT i własne CORS. Przeniesienie go na inny projekt Railway albo
inną bazę to podmiana dwóch zmiennych środowiskowych.

Railway: Root Directory = dropy_service, Start Command =
  uvicorn app:app --host 0.0.0.0 --port $PORT
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import router
from config import settings

app = FastAPI(title="Dropy Portal API", version="1.0", docs_url=None, redoc_url=None)

# Bez gwiazdek. Portal ma jedną domenę i tylko ona ma tu wstęp.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Drop-Key"],
)

app.include_router(router)


@app.get("/health")
async def health():
    return {"ok": True, "service": "dropy-portal"}
