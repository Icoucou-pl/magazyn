"""
Magazyn API - punkt wejścia.
Cała logika rozbita na moduły: config, database, security, models, sql, services/, routers/.
Ten plik tylko spina wszystko razem.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from lifespan import lifespan
from audit import audit_middleware
from routers import (
    auth, users, audit_log, meta, products, anomalies,
    containers, manufacturers, container_types, calendar, tools, fx, finance,
    sellasist, sync, firmy,
)

app = FastAPI(title="Magazyn API", version="5.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Middleware automatycznego audytu mutacji (POST/PUT/PATCH/DELETE)
app.middleware("http")(audit_middleware)

# Routery - każdy ma własny prefix /api
for r in (auth, users, audit_log, meta, products, anomalies,
          containers, manufacturers, container_types, calendar, tools, fx, finance,
          sellasist, sync, firmy):
    app.include_router(r.router)
