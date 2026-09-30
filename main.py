"""
Magazyn API - punkt wejścia.
Cała logika rozbita na moduły: config, database, security, models, sql, services/, routers/.
Ten plik tylko spina wszystko razem.
"""

import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from lifespan import lifespan
from audit import audit_middleware
from services.products import invalidate_sales_cache
from database import db_timing
from routers import (
    auth, users, audit_log, meta, products, anomalies,
    containers, manufacturers, container_types, calendar, tools, fx, finance,
    sellasist, sync, firmy, assistant, cn_sku, reports,
    fakturownia, fakturownia_sales, sku_economics, bank, product_photos,
    product_history, fakturownia_history, dropy, odprawy,
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


# Pomiar czasu odpowiedzi. Dodany jako ostatni = najbardziej zewnętrzny, więc mierzy
# całe żądanie (auth, baza, serializacja). Wolne żądania lądują w logach Railwaya
# jako „[wolne] GET /api/anomalies 2345 ms", a każda odpowiedź niesie nagłówek
# Server-Timing — przeglądarka pokazuje go w DevTools → Network → Timing.
SLOW_REQUEST_MS = 500


@app.middleware("http")
async def timing_middleware(request, call_next):
    t0 = time.perf_counter()
    slot: dict = {}
    db_timing.set(slot)          # get_db dopisze tu czas łączenia z bazą
    response = await call_next(request)
    ms = (time.perf_counter() - t0) * 1000
    response.headers["Server-Timing"] = f"app;dur={ms:.0f}"
    response.headers["Timing-Allow-Origin"] = "*"
    # Każda udana zmiana danych kasuje wspólny wynik SALES_QUERY (services/products.py),
    # żeby po edycji produktu lista nie pokazała stanu sprzed zmiany.
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and response.status_code < 400:
        invalidate_sales_cache()
    if ms >= SLOW_REQUEST_MS:
        q = f"?{request.url.query}" if request.url.query else ""
        conn = f" (łączenie z bazą {slot['connect_ms']:.0f} ms)" if "connect_ms" in slot else ""
        print(f"[wolne] {request.method} {request.url.path}{q} {ms:.0f} ms{conn}", flush=True)
    return response

# Routery - każdy ma własny prefix /api
for r in (auth, users, audit_log, meta, products, anomalies,
          containers, manufacturers, container_types, calendar, tools, fx, finance,
          sellasist, sync, firmy, assistant, cn_sku, reports,
          fakturownia, fakturownia_sales, sku_economics, bank, product_photos,
          product_history, fakturownia_history, dropy, odprawy):
    app.include_router(r.router)
