"""Raporty: zbiorczy (KPI w czasie) i per SKU — z podglądem live i eksportem do Excela.

Dane pochodzą ze snapshotów zbieranych 2× dziennie (7:05 / 20:05), więc są DOKŁADNE
— nie rekonstruujemy przeszłości. Okres bez snapshotów zwraca pustkę, nie zmyślone liczby.
"""
from datetime import date, datetime, timedelta
from io import BytesIO
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from models import CurrentUser
from security import get_current_user, has_perm
from services.snapshots import store_snapshot, build_kpi_rows, build_stock_rows, SLOTS

router = APIRouter(prefix="/api", tags=["reports"])

KPI_FIELDS = [
    ("kapital_pln", "Kapitał w towarze"),
    ("magazyn_pln", "Wartość magazynu"),
    ("magazyn_w_drodze_pln", "Magazyn w drodze"),
    ("kontenery_pln", "Kontenery w drodze"),
    ("zaplacono_pln", "Zapłacone za magazyn w drodze"),
    ("pozostalo_pln", "Pozostało do zapłaty"),
]
# 'wieczor' ma pierwszeństwo — to „stan na koniec dnia".
SLOT_ORDER = "CASE snap_slot WHEN 'wieczor' THEN 0 ELSE 1 END"


def _require_reports(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not has_perm(user, "viewReports"):
        raise HTTPException(403, "Brak uprawnienia do raportów")
    return user


def _parse_day(s: str, field: str) -> date:
    try:
        return date.fromisoformat(s)
    except Exception:
        raise HTTPException(400, f"{field}: data w formacie RRRR-MM-DD")


def _range(date_from: str, date_to: str) -> tuple:
    a = _parse_day(date_from, "from")
    b = _parse_day(date_to, "to") if date_to else a
    if b < a:
        a, b = b, a
    return a, b


# ── snapshot ręczny ──────────────────────────────────────────

@router.post("/reports/snapshot")
async def make_snapshot(slot: str = Query("wieczor"), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports)):
    """Wymusza zapis snapshotu teraz (poza harmonogramem). Idempotentnie — nadpisuje tę porę."""
    if slot not in SLOTS:
        raise HTTPException(400, f"Pora musi być jedną z: {', '.join(SLOTS)}")
    return await store_snapshot(db, slot)


@router.get("/reports/available")
async def available(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports)):
    """Zakres dat, dla których w ogóle są snapshoty (do ustawienia fragmentatora)."""
    r = await db.execute(text(f"SELECT MIN(snap_date), MAX(snap_date), COUNT(DISTINCT snap_date) FROM {settings.TABLE_KPI_SNAPSHOTS}"))
    row = r.first()
    return {
        "first": row[0].isoformat() if row and row[0] else None,
        "last": row[1].isoformat() if row and row[1] else None,
        "days": int(row[2] or 0) if row else 0,
    }


# ── raport zbiorczy (KPI) ────────────────────────────────────

@router.get("/reports/kpi-range")
async def kpi_range(
    date_from: str = Query(..., alias="from"), date_to: str = Query("", alias="to"),
    scope: str = Query("all"), group: str = Query("day"), slot: str = Query(""),
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports),
):
    """Serie KPI w okresie.

    group="day"   → jeden wiersz na dzień (domyślnie snapshot wieczorny = stan na koniec dnia)
    group="month" → jeden wiersz na miesiąc (ostatni snapshot miesiąca)
    slot="rano"/"wieczor" → wymusza konkretną porę zamiast „ostatniej z dnia".
    """
    a, b = _range(date_from, date_to)
    params = {"f": scope, "a": a, "b": b}
    slot_where = ""
    if slot:
        if slot not in SLOTS:
            raise HTTPException(400, "Nieznana pora")
        slot_where = " AND snap_slot = :slot"
        params["slot"] = slot

    if group == "month":
        key_expr = "date_trunc('month', snap_date)"
        label_expr = "to_char(snap_date, 'YYYY-MM')"
    else:
        key_expr = "snap_date"
        label_expr = "to_char(snap_date, 'YYYY-MM-DD')"

    # Jeden dzień bez wymuszonej pory → pokazujemy OBIE pory, żeby było widać ruch w ciągu dnia.
    intraday = (a == b and not slot and group != "month")
    if intraday:
        r = await db.execute(text(f"""
            SELECT to_char(snap_date, 'YYYY-MM-DD') || ' · ' ||
                   CASE snap_slot WHEN 'rano' THEN 'rano' ELSE 'wieczór' END AS label,
                   snap_date, snap_slot,
                   kapital_pln, magazyn_pln, magazyn_w_drodze_pln, kontenery_pln,
                   zaplacono_pln, pozostalo_pln
            FROM {settings.TABLE_KPI_SNAPSHOTS}
            WHERE firma_slug = :f AND snap_date = :a
            ORDER BY CASE snap_slot WHEN 'rano' THEN 0 ELSE 1 END
        """), params)
    else:
        r = await db.execute(text(f"""
            SELECT DISTINCT ON ({key_expr})
                   {label_expr} AS label, snap_date, snap_slot,
                   kapital_pln, magazyn_pln, magazyn_w_drodze_pln, kontenery_pln,
                   zaplacono_pln, pozostalo_pln
            FROM {settings.TABLE_KPI_SNAPSHOTS}
            WHERE firma_slug = :f AND snap_date >= :a AND snap_date <= :b{slot_where}
            ORDER BY {key_expr}, snap_date DESC, {SLOT_ORDER}
        """), params)

    rows = []
    for row in r:
        d = dict(row._mapping)
        d["snap_date"] = d["snap_date"].isoformat()
        for k, _ in KPI_FIELDS:
            d[k] = float(d[k] or 0)
        rows.append(d)
    rows.sort(key=lambda x: x["label"])

    first, last = (rows[0], rows[-1]) if rows else (None, None)
    summary = []
    for key, label in KPI_FIELDS:
        s_val = first[key] if first else None
        e_val = last[key] if last else None
        delta = round(e_val - s_val, 2) if (s_val is not None and e_val is not None) else None
        delta_pct = round(((e_val - s_val) / s_val) * 100, 1) if (s_val not in (None, 0) and e_val is not None) else None
        summary.append({"key": key, "label": label, "start": s_val, "end": e_val,
                        "delta": delta, "delta_pct": delta_pct})

    return {"from": a.isoformat(), "to": b.isoformat(), "scope": scope, "group": group,
            "has_data": bool(rows), "rows": rows, "summary": summary,
            "fields": [{"key": k, "label": l} for k, l in KPI_FIELDS]}


# ── raport per SKU ───────────────────────────────────────────

async def _sku_snapshot(db: AsyncSession, day_lo: date, day_hi: date, newest: bool, slot: str):
    """Jeden snapshot per SKU: najnowszy (newest=True) albo najstarszy w oknie dat."""
    params = {"a": day_lo, "b": day_hi}
    slot_where = ""
    if slot:
        slot_where = " AND snap_slot = :slot"
        params["slot"] = slot
    order_dir = "DESC" if newest else "ASC"
    slot_dir = SLOT_ORDER if newest else f"CASE snap_slot WHEN 'rano' THEN 0 ELSE 1 END"
    r = await db.execute(text(f"""
        SELECT DISTINCT ON (sku, firma_slug)
               sku, nazwa, firma_slug, cena_jednostkowa,
               stan_glowny, stan_w_drodze, w_kontenerze, snap_date, snap_slot
        FROM {settings.TABLE_STOCK_SNAPSHOTS}
        WHERE snap_date >= :a AND snap_date <= :b{slot_where}
        ORDER BY sku, firma_slug, snap_date {order_dir}, {slot_dir}
    """), params)
    out = {}
    for row in r:
        d = dict(row._mapping)
        d["snap_date"] = d["snap_date"].isoformat()
        out[((d["sku"] or "").upper(), d["firma_slug"] or "amh")] = d
    return out



def _collapse(items: List[dict], scope: str) -> List[dict]:
    """Zakres = konkretna firma → filtr. „Wszyscy" → jeden wiersz na SKU, stany zsumowane
    ze wszystkich magazynów (jak w Produktach: 11 na AMH + 254 na Veluxie = 265)."""
    if scope != "all":
        return [r for r in items if (r.get("firma_slug") or "") == scope]
    merged: dict = {}
    for r in items:
        key = (r["sku"] or "").upper()
        m = merged.get(key)
        if m is None:
            m = merged[key] = dict(r)
            m["_firmy"] = set()
        else:
            for f in ("stan_glowny", "stan_w_drodze", "w_kontenerze", "razem",
                      "razem_start", "razem_end", "delta_szt"):
                if f in m and f in r and m[f] is not None and r[f] is not None:
                    m[f] += r[f]
            if not m.get("nazwa"):
                m["nazwa"] = r.get("nazwa")
            if not m.get("cena_jednostkowa"):
                m["cena_jednostkowa"] = r.get("cena_jednostkowa")
        if r.get("firma_slug"):
            m["_firmy"].add(r["firma_slug"])
    out = []
    for m in merged.values():
        firmy = sorted(m.pop("_firmy", set()))
        m["firma_slug"] = "+".join(f.upper() for f in firmy) if firmy else ""
        out.append(m)
    return out


@router.get("/reports/sku")
async def sku_report(
    date_from: str = Query(..., alias="from"), date_to: str = Query("", alias="to"),
    favorites_only: bool = Query(False), skus: str = Query(""), slot: str = Query(""),
    scope: str = Query("all"),
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports),
):
    """Stany per SKU.

    Jeden dzień  → zdjęcie z tego dnia.
    Zakres dat   → początek vs koniec + zmiana (tryb „b”), jeden wiersz na SKU.
    Filtry: tylko ulubione oraz ręczna lista SKU (przecinkami).
    """
    a, b = _range(date_from, date_to)
    is_range = b > a

    end = await _sku_snapshot(db, a, b, newest=True, slot=slot)
    start: dict = {}
    compare = "none"
    if is_range:
        start = await _sku_snapshot(db, a, b, newest=False, slot=slot)
        compare = "range"
    elif not slot:
        # Ten sam dzień: jeśli są obie pory, porównujemy ranek z wieczorem (ruch dzienny).
        rano = await _sku_snapshot(db, a, b, newest=False, slot="rano")
        wieczor = await _sku_snapshot(db, a, b, newest=True, slot="wieczor")
        if rano and wieczor:
            start, end, compare = rano, wieczor, "intraday"
    has_compare = compare != "none"

    # ulubione — flaga trzymana przy atrybutach produktu
    favs = set()
    if favorites_only:
        rf = await db.execute(text(f"SELECT UPPER(TRIM(sku)) FROM {settings.TABLE_PRODUCT_ATTRS} WHERE COALESCE(is_favorite, FALSE) = TRUE"))
        favs = {row[0] for row in rf if row[0]}

    picked = {s.strip().upper() for s in skus.split(",") if s.strip()}

    rows = []
    for (key, firma), e in end.items():
        if favorites_only and key not in favs:
            continue
        if picked and key not in picked:
            continue
        cena = float(e["cena_jednostkowa"] or 0)
        gl, wd, kn = int(e["stan_glowny"] or 0), int(e["stan_w_drodze"] or 0), int(e["w_kontenerze"] or 0)
        razem = gl + wd + kn
        row = {
            "sku": e["sku"], "nazwa": e.get("nazwa") or "", "firma_slug": e.get("firma_slug") or "",
            "cena_jednostkowa": round(cena, 2),
            "stan_glowny": gl, "stan_w_drodze": wd, "w_kontenerze": kn,
            "razem": razem,
            "snap_date": e["snap_date"], "snap_slot": e["snap_slot"],
        }
        if has_compare:
            s = start.get((key, firma))
            s_razem = (int(s["stan_glowny"] or 0) + int(s["stan_w_drodze"] or 0) + int(s["w_kontenerze"] or 0)) if s else 0
            s_cena = float(s["cena_jednostkowa"] or 0) if s else cena
            row.update({"razem_start": s_razem, "razem_end": razem, "delta_szt": razem - s_razem})
        rows.append(row)

    rows = _collapse(rows, scope)
    rows.sort(key=lambda x: x["razem"], reverse=True)
    totals = {
        "sku_count": len(rows),
        "units": sum(r["razem"] for r in rows),
        "units_glowny": sum(r["stan_glowny"] for r in rows),
        "units_w_drodze": sum(r["stan_w_drodze"] for r in rows),
        "units_kontener": sum(r["w_kontenerze"] for r in rows),
    }
    if has_compare:
        totals["delta_szt"] = sum(r.get("delta_szt", 0) for r in rows)

    return {"from": a.isoformat(), "to": b.isoformat(), "is_range": has_compare,
            "compare": compare, "has_data": bool(rows), "rows": rows, "totals": totals}


# ── tryb LIVE (stan na teraz, bez zapisu do bazy) ────────────
# Te same funkcje, których używa pętla snapshotów — tylko bez INSERT-a.
# Dzięki temu „zdjęcie na teraz" nie zaśmieca historii.

async def _live_kpi(db: AsyncSession, scope: str) -> dict:
    rows = await build_kpi_rows(db)
    mine = next((r for r in rows if r["firma_slug"] == scope), None)
    fields = [{"key": k, "label": l} for k, l in KPI_FIELDS]
    if not mine:
        return {"from": "teraz", "to": "teraz", "scope": scope, "group": "live",
                "live": True, "has_data": False, "rows": [], "summary": [], "fields": fields}
    row = {"label": "Teraz", "snap_date": date.today().isoformat(), "snap_slot": "live"}
    for k, _ in KPI_FIELDS:
        row[k] = float(mine.get(k) or 0)
    summary = [{"key": k, "label": l, "start": None, "end": float(mine.get(k) or 0),
                "delta": None, "delta_pct": None} for k, l in KPI_FIELDS]
    return {"from": "teraz", "to": "teraz", "scope": scope, "group": "live", "live": True,
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "has_data": True, "rows": [row], "summary": summary, "fields": fields}


async def _live_sku(db: AsyncSession, favorites_only: bool, skus: str, scope: str = "all") -> dict:
    src = await build_stock_rows(db)
    favs = set()
    if favorites_only:
        rf = await db.execute(text(f"SELECT UPPER(TRIM(sku)) FROM {settings.TABLE_PRODUCT_ATTRS} WHERE COALESCE(is_favorite, FALSE) = TRUE"))
        favs = {r[0] for r in rf if r[0]}
    picked = {x.strip().upper() for x in skus.split(",") if x.strip()}

    rows = []
    for e in src:
        key = (e["sku"] or "").strip().upper()
        if favorites_only and key not in favs:
            continue
        if picked and key not in picked:
            continue
        cena = float(e["cena_jednostkowa"] or 0)
        gl, wd, kn = int(e["stan_glowny"] or 0), int(e["stan_w_drodze"] or 0), int(e["w_kontenerze"] or 0)
        razem = gl + wd + kn
        rows.append({
            "sku": e["sku"], "nazwa": e.get("nazwa") or "", "firma_slug": e.get("firma_slug") or "",
            "cena_jednostkowa": round(cena, 2), "stan_glowny": gl, "stan_w_drodze": wd, "w_kontenerze": kn,
            "razem": razem, "wartosc_pln": round(razem * cena, 2),
            "snap_date": date.today().isoformat(), "snap_slot": "live",
        })
    # Zakres firmy — dokładnie jak w raporcie z historii: konkretna firma filtruje,
    # „Wszyscy" scala SKU w jeden wiersz i sumuje stany. Wcześniej `scope` był
    # przyjmowany i ignorowany, więc przełącznik firm nie działał w trybie „Teraz",
    # a przy „Wszyscy" ten sam SKU pojawiał się osobno dla każdego magazynu.
    rows = _collapse(rows, scope)
    for r in rows:
        r["wartosc_pln"] = round(r["razem"] * float(r.get("cena_jednostkowa") or 0), 2)
    rows.sort(key=lambda x: x["wartosc_pln"], reverse=True)
    return {"from": "teraz", "to": "teraz", "is_range": False, "compare": "none", "live": True,
            "has_data": bool(rows), "rows": rows,
            "totals": {"sku_count": len(rows), "units": sum(r["razem"] for r in rows),
                       "value_pln": round(sum(r["wartosc_pln"] for r in rows), 2)}}


@router.get("/reports/live/kpi")
async def live_kpi(scope: str = Query("all"), db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports)):
    """Zbiorczy stan NA TERAZ — liczony na żywo, nic nie zapisuje."""
    return await _live_kpi(db, scope)


@router.get("/reports/live/sku")
async def live_sku(favorites_only: bool = Query(False), skus: str = Query(""), scope: str = Query("all"),
                   db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports)):
    """Stany per SKU NA TERAZ — liczone na żywo, nic nie zapisuje."""
    return await _live_sku(db, favorites_only, skus, scope)


# ── eksport XLSX ─────────────────────────────────────────────

def _xlsx_response(wb, filename: str) -> StreamingResponse:
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _style_header(ws, row_idx: int, headers: List[str]):
    from openpyxl.styles import Font, PatternFill, Alignment
    fill = PatternFill("solid", fgColor="1F3864")
    for i, h in enumerate(headers, start=1):
        c = ws.cell(row=row_idx, column=i, value=h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = fill
        c.alignment = Alignment(horizontal="center")


@router.get("/reports/kpi-range/xlsx")
async def kpi_range_xlsx(
    date_from: str = Query("", alias="from"), date_to: str = Query("", alias="to"),
    scope: str = Query("all"), group: str = Query("day"), slot: str = Query(""),
    fields: str = Query(""), live: bool = Query(False),
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports),
):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    data = (await _live_kpi(db, scope)) if live else (
        await kpi_range(date_from=date_from, date_to=date_to, scope=scope, group=group, slot=slot, db=db, user=user))
    chosen = [k.strip() for k in fields.split(",") if k.strip()] or [k for k, _ in KPI_FIELDS]
    cols = [(k, l) for k, l in KPI_FIELDS if k in chosen]

    wb = Workbook(); ws = wb.active; ws.title = "Raport zbiorczy"
    okres_x = "stan na teraz" if data.get("live") else f"{data['from']} … {data['to']}"
    ws["A1"] = f"Raport zbiorczy magazynu — {okres_x}"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = f"Zakres: {scope.upper()} · grupowanie: {'miesiąc' if group == 'month' else 'dzień'}"
    ws["A2"].font = Font(color="808080")

    head = ["Okres"] + [l for _, l in cols]
    _style_header(ws, 4, head)
    for j, row in enumerate(data["rows"], start=5):
        ws.cell(row=j, column=1, value=row["label"])
        for i, (k, _) in enumerate(cols, start=2):
            ws.cell(row=j, column=i, value=row[k]).number_format = "#,##0.00"

    ws.column_dimensions["A"].width = 16
    for i in range(len(cols)):
        ws.column_dimensions[chr(ord("B") + i)].width = 20
    return _xlsx_response(wb, f"raport_zbiorczy_{data['from']}_{data['to']}_{scope}.xlsx")


@router.get("/reports/sku/xlsx")
async def sku_xlsx(
    date_from: str = Query("", alias="from"), date_to: str = Query("", alias="to"),
    favorites_only: bool = Query(False), skus: str = Query(""), slot: str = Query(""),
    live: bool = Query(False), scope: str = Query("all"),
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(_require_reports),
):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    data = (await _live_sku(db, favorites_only, skus, scope)) if live else (await sku_report(date_from=date_from, date_to=date_to, favorites_only=favorites_only,
                            skus=skus, slot=slot, scope=scope, db=db, user=user))
    rng = data["is_range"]

    wb = Workbook(); ws = wb.active; ws.title = "Magazyn per SKU"
    ws["A1"] = "Raport magazynu per SKU — stan na teraz" if data.get("live") else (f"Raport magazynu per SKU — {data['from']}" + (f" … {data['to']}" if rng else ""))
    ws["A1"].font = Font(bold=True, size=14)
    sub = []
    if favorites_only: sub.append("tylko obserwowane")
    if skus: sub.append("wybrane SKU")
    ws["A2"] = " · ".join(sub) if sub else "wszystkie SKU"
    ws["A2"].font = Font(color="808080")

    head = ["SKU", "Nazwa", "Firma", "Cena jedn.", "Magazyn główny", "W drodze", "W kontenerze", "Razem szt"]
    if rng:
        head += ["Szt. początek", "Szt. koniec", "Zmiana szt"]
    _style_header(ws, 4, head)

    for j, r in enumerate(data["rows"], start=5):
        vals = [r["sku"], r["nazwa"], r["firma_slug"], r["cena_jednostkowa"], r["stan_glowny"],
                r["stan_w_drodze"], r["w_kontenerze"], r["razem"]]
        if rng:
            vals += [r.get("razem_start"), r.get("razem_end"), r.get("delta_szt")]
        for i, v in enumerate(vals, start=1):
            c = ws.cell(row=j, column=i, value=v)
            if isinstance(v, float):
                c.number_format = "#,##0.00"

    t = data["totals"]
    last = 5 + len(data["rows"]) + 1
    ws.cell(row=last, column=1, value="RAZEM").font = Font(bold=True)
    for col_i, key in ((5, "units_glowny"), (6, "units_w_drodze"), (7, "units_kontener"), (8, "units")):
        ws.cell(row=last, column=col_i, value=t.get(key, 0)).font = Font(bold=True)

    ws.column_dimensions["A"].width = 18
    ws.column_dimensions["B"].width = 34
    for col in "CDEFGHI":
        ws.column_dimensions[col].width = 15
    name = f"raport_sku_{data['from']}" + (f"_{data['to']}" if rng else "") + ".xlsx"
    return _xlsx_response(wb, name)
