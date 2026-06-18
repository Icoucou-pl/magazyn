"use client";
// ============================================================
// MAGAZYN — Prognoza (forecast.tsx). Port forecast.jsx z mocka.
//   Macierz heatmap: wiersze = SKU, kolumny = miesiące, komórka =
//   prognozowany stan, kolor wg miesięcy zapasu (months-of-cover).
//   Dane realne: /products (+ incoming_deliveries) i /manufacturers.
//   Projekcja liczona klientowo (jak mock projectProduct) — backendowy
//   /projection jest dzienny i służy modalowi produktu.
//   Sterowanie: zakładki producenta, sezonowość, sort, horyzont,
//   filtr statusu, widoczność kolumn, ręczne dodaj/usuń wiersz, eksport.
//   Widok ilościowy (sztuki) — bez danych finansowych, brak maskowania.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { fmtPLNk, fmtNum } from "@/lib/format";
import { useUser, can } from "@/lib/permissions";
import { toast, exportCsv, type CsvColumn } from "./toast";
import { I, Pill, MfrChip } from "./ui";
import { MiniStat, STATUS_FULL_META, type Container } from "./containers-ui";
import {
  Checkbox, modalBackdrop, modalCard, iconBtnGhost,
  StatusPillExt, displayStatus, monthsDisplay,
  type Product, type Manufacturer,
} from "./products-ui";

// ── Kubełki pokrycia (months-of-cover) ───────────────────────
type Bucket = "BRAKI" | "ZAMAWIAMY" | "IDEALNIE" | "ZA_DUZO" | "WYPRZEDAZ";

const FC_BUCKETS: Record<Bucket, { label: string; bg: string; fg: string; desc: string }> = {
  BRAKI:     { label: "Braki",            bg: "var(--critical)",       fg: "white",                desc: "stan ≤ 0" },
  ZAMAWIAMY: { label: "Zamawiamy",        bg: "var(--warning)",        fg: "oklch(0.2 0.05 55)",   desc: "< 1 mies. zapasu" },
  IDEALNIE:  { label: "Idealnie",         bg: "var(--ok)",             fg: "white",                desc: "1–3 mies." },
  ZA_DUZO:   { label: "Troszkę za dużo",  bg: "oklch(0.86 0.17 100)",  fg: "oklch(0.3 0.06 100)",  desc: "3–6 mies." },
  WYPRZEDAZ: { label: "Wyprzedaż / promo", bg: "oklch(0.78 0.12 220)", fg: "oklch(0.22 0.05 220)", desc: "> 6 mies." },
};

const FC_MONTH_NAMES = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];
const SEASONAL_CURVE = [0.85, 0.88, 1.05, 1.15, 1.20, 1.05, 0.80, 0.78, 1.05, 1.15, 1.25, 1.10];

function classifyCover(stock: number, monthlySales: number): Bucket {
  if (stock <= 0) return "BRAKI";
  if (monthlySales <= 0) return stock > 0 ? "WYPRZEDAZ" : "BRAKI";
  const cover = stock / monthlySales;
  if (cover < 1) return "ZAMAWIAMY";
  if (cover <= 3) return "IDEALNIE";
  if (cover <= 6) return "ZA_DUZO";
  return "WYPRZEDAZ";
}

type MonthCol = { key: string; label: string; monthIndex: number; year: number; isYearStart: boolean };

function buildMonthCols(n: number): MonthCol[] {
  const today = new Date();
  const cols: MonthCol[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const yr = d.getFullYear();
    cols.push({
      key: `${yr}-${d.getMonth()}`,
      label: FC_MONTH_NAMES[d.getMonth()] + (yr !== today.getFullYear() ? `'${String(yr).slice(2)}` : ""),
      monthIndex: i, year: yr, isYearStart: d.getMonth() === 0,
    });
  }
  return cols;
}

type FcCell = { stock: number; bucket: Bucket; delivery: number };
type FcRow = { p: Product; cells: FcCell[] };

function projectProduct(p: Product, monthCols: MonthCol[], useSeasonality: boolean): FcCell[] {
  const baseMonthly = p.avg_monthly_weighted || 0;
  const today = new Date();
  const deliveriesByMonth: Record<number, number> = {};
  (p.incoming_deliveries || []).forEach((d) => {
    if (!d.eta_date) return;
    const eta = new Date(d.eta_date);
    if (isNaN(eta.getTime())) return;
    const offset = (eta.getFullYear() - today.getFullYear()) * 12 + (eta.getMonth() - today.getMonth());
    if (offset < 0 || offset >= monthCols.length) return;
    deliveriesByMonth[offset] = (deliveriesByMonth[offset] || 0) + d.quantity;
  });

  let stock = p.stock;
  return monthCols.map((_col, i) => {
    if (deliveriesByMonth[i]) stock += deliveriesByMonth[i];
    const monthIdx = (today.getMonth() + i) % 12;
    const monthly = useSeasonality ? baseMonthly * SEASONAL_CURVE[monthIdx] : baseMonthly;
    const endStock = Math.round(stock - monthly);
    stock = endStock;
    return { stock: endStock, bucket: classifyCover(endStock, monthly), delivery: deliveriesByMonth[i] || 0 };
  });
}

// Filtry statusu (na realnych polach Product)
const FC_STATUS_FILTERS: Record<string, { label: string; test: (p: Product) => boolean }> = {
  active:   { label: "Aktywne",     test: (p) => p.product_status === "ACTIVE" || p.product_status === "ACTIVE_NO_STOCK" },
  critical: { label: "Krytyczne",   test: (p) => p.status === "KRYTYCZNY" || p.status === "ZAMOW_TERAZ" },
  fav:      { label: "Obserwowane", test: (p) => p.is_favorite },
  all:      { label: "Wszystkie",   test: () => true },
};

type MfrId = number | "ALL";

const fcSelect: React.CSSProperties = {
  padding: "7px 10px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border-soft)",
  borderRadius: 7, color: "var(--text-hi)", outline: "none", fontFamily: "inherit",
};
const fcGhostBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 11px",
  background: "var(--surface-2)", border: "1px solid var(--border-soft)",
  borderRadius: 7, color: "var(--text-mid)", fontSize: 12, fontWeight: 600, cursor: "pointer",
};
const fcMetaCell: React.CSSProperties = {
  padding: "7px 10px", fontSize: 11, display: "flex", alignItems: "center",
  borderRight: "1px solid var(--border-soft)",
};

export default function ForecastView({
  density, onProductClick,
}: {
  density?: string;
  onProductClick?: (sku: string) => void;
}) {
  const gap = density === "compact" ? 12 : 14;
  const showFin = can(useUser(), "viewFinancials");

  const [products, setProducts] = useState<Product[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);

  const [mfrId, setMfrId] = useState<MfrId>("ALL");
  const [horizon, setHorizon] = useState(14);
  const [sortKey, setSortKey] = useState<"sales30" | "sales90" | "stock" | "sku">("sales30");
  const [seasonality, setSeasonality] = useState(false);
  const [statusFilter, setStatusFilter] = useState("active");
  const [colVis, setColVis] = useState<{ sales60: boolean; sales90: boolean }>({ sales60: true, sales90: true });
  const [showColMenu, setShowColMenu] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [detailMfrId, setDetailMfrId] = useState<number | null>(null);
  // Ręczne nadpisania — SKU wymuszone do usunięcia / dodania
  const [hiddenSkus, setHiddenSkus] = useState<Set<string>>(() => new Set());
  const [extraSkus, setExtraSkus] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.allSettled([
      api.get("/products?include=ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE"),
      api.get("/manufacturers"),
      api.get("/containers"),
    ]).then(([prod, mfr, cont]) => {
      if (!alive) return;
      if (prod.status === "fulfilled") setProducts((prod.value as Product[]) || []);
      else toast("Nie udało się wczytać produktów", "warning");
      if (mfr.status === "fulfilled") setManufacturers((mfr.value as Manufacturer[]) || []);
      if (cont.status === "fulfilled") setContainers((cont.value as Container[]) || []);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const monthCols = useMemo(() => buildMonthCols(horizon), [horizon]);
  const mfr = useMemo(() => manufacturers.find((m) => m.id === mfrId), [manufacturers, mfrId]);

  // Reset ręcznych nadpisań przy zmianie producenta
  useEffect(() => { setHiddenSkus(new Set()); setExtraSkus(new Set()); }, [mfrId]);

  useEffect(() => {
    if (!showColMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-colmenu]")) setShowColMenu(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showColMenu]);

  const rows = useMemo<FcRow[]>(() => {
    const inMfr = (p: Product) => mfrId === "ALL" || p.manufacturer_id === mfrId;
    const passFilter = FC_STATUS_FILTERS[statusFilter].test;
    let arr = products.filter((p) => {
      if (!inMfr(p)) return false;
      if (hiddenSkus.has(p.sku)) return false;
      return passFilter(p) || extraSkus.has(p.sku);
    });
    const mapped: FcRow[] = arr.map((p) => ({ p, cells: projectProduct(p, monthCols, seasonality) }));
    const sales90 = (p: Product) => p.sales_1m + p.sales_2m + p.sales_3m;
    mapped.sort((a, b) => {
      if (sortKey === "sales30") return b.p.sales_1m - a.p.sales_1m;
      if (sortKey === "sales90") return sales90(b.p) - sales90(a.p);
      if (sortKey === "stock") return b.p.stock - a.p.stock;
      return a.p.sku.localeCompare(b.p.sku);
    });
    return mapped;
  }, [products, mfrId, monthCols, sortKey, seasonality, statusFilter, hiddenSkus, extraSkus]);

  // Produkty, które można dodać (ten sam producent, jeszcze nie na liście)
  const addable = useMemo(() => {
    const shownSkus = new Set(rows.map((r) => r.p.sku));
    return products.filter((p) =>
      (mfrId === "ALL" || p.manufacturer_id === mfrId) && !shownSkus.has(p.sku)
    );
  }, [rows, products, mfrId]);

  const summary = useMemo(() => {
    const counts: Record<Bucket, number> = { BRAKI: 0, ZAMAWIAMY: 0, IDEALNIE: 0, ZA_DUZO: 0, WYPRZEDAZ: 0 };
    rows.forEach((r) => r.cells.slice(0, 6).forEach((c) => { counts[c.bucket]++; }));
    const willStockOut = rows.filter((r) => r.cells.some((c) => c.bucket === "BRAKI")).length;
    const needOrderSoon = rows.filter((r) => r.cells.slice(0, 3).some((c) => c.bucket === "ZAMAWIAMY" || c.bucket === "BRAKI")).length;
    return { counts, willStockOut, needOrderSoon };
  }, [rows]);

  const removeRow = (sku: string) => {
    setExtraSkus((prev) => { const n = new Set(prev); n.delete(sku); return n; });
    setHiddenSkus((prev) => new Set(prev).add(sku));
  };
  const addRow = (sku: string) => {
    setHiddenSkus((prev) => { const n = new Set(prev); n.delete(sku); return n; });
    setExtraSkus((prev) => new Set(prev).add(sku));
  };
  const resetOverrides = () => { setHiddenSkus(new Set()); setExtraSkus(new Set()); };
  const hasOverrides = hiddenSkus.size > 0 || extraSkus.size > 0;

  // Kolumny meta (lewa, przyklejona strefa)
  type MetaCol = { id: string; label: string; w: number; align: "left" | "right" | "center" };
  const META_COLS: MetaCol[] = [
    { id: "sku",    label: "SKU",      w: 132, align: "left" },
    { id: "stock",  label: "Stan",     w: 64,  align: "right" },
    { id: "sales",  label: "Sprz.30d", w: 72,  align: "right" },
    ...(colVis.sales60 ? [{ id: "sales60", label: "Sprz.60d", w: 72, align: "right" as const }] : []),
    ...(colVis.sales90 ? [{ id: "sales90", label: "Sprz.90d", w: 72, align: "right" as const }] : []),
    { id: "rm", label: "", w: 34, align: "center" },
  ];
  const monthW = 52;
  const gridTemplate = `${META_COLS.map((c) => c.w + "px").join(" ")} ${monthCols.map(() => monthW + "px").join(" ")}`;

  const metaCellValue = (id: string, p: Product): React.ReactNode => {
    switch (id) {
      case "sku": return <span className="mono" style={{ fontWeight: 600, color: "var(--text-hi)" }}>{p.sku}</span>;
      case "stock": return <span className="num" style={{ fontWeight: 600, color: p.stock === 0 ? "var(--critical)" : "var(--text-hi)" }}>{p.stock}</span>;
      case "sales": return <span className="num" style={{ color: "var(--text-mid)" }}>{p.sales_1m}</span>;
      case "sales60": return <span className="num" style={{ color: "var(--text-mid)" }}>{p.sales_1m + p.sales_2m}</span>;
      case "sales90": return <span className="num" style={{ color: "var(--text-mid)" }}>{p.sales_1m + p.sales_2m + p.sales_3m}</span>;
      default: return null;
    }
  };

  const onExport = () => {
    const cols: CsvColumn<FcRow>[] = [
      { label: "SKU", get: (r) => r.p.sku },
      { label: "Stan", get: (r) => r.p.stock },
      { label: "Sprzedaz 30d", get: (r) => r.p.sales_1m },
      ...(colVis.sales60 ? [{ label: "Sprzedaz 60d", get: (r: FcRow) => r.p.sales_1m + r.p.sales_2m }] : []),
      ...(colVis.sales90 ? [{ label: "Sprzedaz 90d", get: (r: FcRow) => r.p.sales_1m + r.p.sales_2m + r.p.sales_3m }] : []),
      ...monthCols.map((mc, ci): CsvColumn<FcRow> => ({ label: mc.label, get: (r: FcRow) => r.cells[ci]?.stock ?? 0 })),
    ];
    exportCsv(`prognoza-${(mfr?.name || "all").replace(/\s+/g, "_")}`, cols, rows);
  };

  if (loading) {
    return (
      <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap, paddingBottom: 80 }}>
        <div style={{ height: 56, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />
        <div style={{ height: 48, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />
        <div style={{ height: 460, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap, paddingBottom: 80, minWidth: 0 }}>

      {/* Toolbar 1 — producent / sezonowość / sort / horyzont */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        padding: "12px 14px",
        background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)",
      }}>
        <div style={{ display: "flex", gap: 4, padding: 3, background: "var(--surface-2)", borderRadius: 8, flexWrap: "wrap" }}>
          {([{ id: "ALL" as MfrId, name: "Wszyscy", color: "var(--text-lo)" }, ...manufacturers]).map((m) => {
            const active = mfrId === m.id;
            return (
              <button key={String(m.id)} onClick={() => setMfrId(m.id as MfrId)} style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px",
                background: active ? "var(--surface-3)" : "transparent",
                color: active ? "var(--text-hi)" : "var(--text-mid)",
                border: "none", borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: "pointer",
              }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: m.color }} />
                {m.name}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSeasonality(!seasonality)} title="Uwzględnij sezonowość sprzedaży w prognozie" style={{
          display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 11px",
          background: seasonality ? "var(--anomaly-soft)" : "var(--surface-2)",
          border: `1px solid ${seasonality ? "var(--anomaly)" : "var(--border-soft)"}`,
          borderRadius: 7, color: seasonality ? "var(--anomaly)" : "var(--text-mid)",
          fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.12s",
        }}>
          <span style={{ width: 28, height: 16, borderRadius: 99, padding: 2, background: seasonality ? "var(--anomaly)" : "var(--surface-3)", display: "inline-flex", transition: "background 0.16s" }}>
            <span style={{ width: 12, height: 12, borderRadius: 99, background: "white", transform: seasonality ? "translateX(12px)" : "translateX(0)", transition: "transform 0.16s" }} />
          </span>
          <I.Activity size={13} /> Sezonowość
        </button>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as "sales30" | "sales90" | "stock" | "sku")} style={fcSelect}>
          <option value="sales30">Sortuj: sprzedaż 30d ↓</option>
          <option value="sales90">Sortuj: sprzedaż 90d ↓</option>
          <option value="stock">Sortuj: stan ↓</option>
          <option value="sku">Sortuj: SKU A-Z</option>
        </select>
        <select value={horizon} onChange={(e) => setHorizon(parseInt(e.target.value))} style={fcSelect}>
          <option value={6}>6 miesięcy</option>
          <option value={12}>12 miesięcy</option>
          <option value={14}>14 miesięcy</option>
          <option value={18}>18 miesięcy</option>
        </select>
      </div>

      {/* Toolbar 2 — filtr / zarządzanie wierszami */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        padding: "10px 14px",
        background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)",
      }}>
        <div style={{ display: "flex", gap: 4, padding: 3, background: "var(--surface-2)", borderRadius: 8 }}>
          {Object.entries(FC_STATUS_FILTERS).map(([key, f]) => {
            const active = statusFilter === key;
            return (
              <button key={key} onClick={() => setStatusFilter(key)} style={{
                padding: "5px 10px", fontSize: 11, fontWeight: 500,
                background: active ? "var(--surface-3)" : "transparent",
                color: active ? "var(--text-hi)" : "var(--text-mid)",
                border: "none", borderRadius: 5, cursor: "pointer",
              }}>{f.label}</button>
            );
          })}
        </div>

        <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>
          <span style={{ color: "var(--text-hi)", fontWeight: 600 }}>{rows.length}</span> produktów
          {hasOverrides && <span style={{ color: "var(--anomaly)" }}> · ręczne zmiany</span>}
        </span>

        {mfrId !== "ALL" && (
          <button onClick={() => setDetailMfrId(mfrId as number)} style={{ ...fcGhostBtn, color: mfr?.color, borderColor: `color-mix(in oklch, ${mfr?.color} 40%, var(--border))` }}>
            <I.Factory size={12} /> Szczegóły producenta
          </button>
        )}

        <div style={{ flex: 1 }} />

        {hasOverrides && (
          <button onClick={resetOverrides} style={fcGhostBtn}>
            <I.Refresh size={12} /> Reset listy
          </button>
        )}

        <div data-colmenu style={{ position: "relative" }}>
          <button onClick={() => setShowColMenu(!showColMenu)} style={fcGhostBtn}>
            <I.Dashboard size={12} /> Kolumny
          </button>
          {showColMenu && (
            <div className="fade-in" style={{
              position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 30,
              width: 200, background: "var(--bg-elevated)", border: "1px solid var(--border)",
              borderRadius: 10, padding: 6, boxShadow: "0 16px 40px rgba(0,0,0,0.4)",
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", padding: "6px 8px" }}>
                Widoczne kolumny
              </div>
              {([
                { id: "sales", label: "Sprzedaż 30 dni", locked: true },
                { id: "sales60", label: "Sprzedaż 60 dni", locked: false },
                { id: "sales90", label: "Sprzedaż 90 dni", locked: false },
              ] as { id: string; label: string; locked: boolean }[]).map((c) => (
                <label key={c.id} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px",
                  borderRadius: 6, cursor: c.locked ? "default" : "pointer", opacity: c.locked ? 0.5 : 1,
                }}
                  onMouseEnter={(e) => { if (!c.locked) e.currentTarget.style.background = "var(--surface-2)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                  <Checkbox
                    checked={c.locked ? true : colVis[c.id as "sales60" | "sales90"]}
                    disabled={c.locked}
                    onChange={() => { if (!c.locked) setColVis({ ...colVis, [c.id]: !colVis[c.id as "sales60" | "sales90"] }); }}
                  />
                  <span style={{ fontSize: 12, color: "var(--text-hi)", flex: 1 }}>{c.label}</span>
                  {c.locked && <span style={{ fontSize: 9, color: "var(--text-lo)", textTransform: "uppercase" }}>stała</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        <button onClick={() => setShowAdd(true)} style={{ ...fcGhostBtn, color: "var(--accent)", borderColor: "color-mix(in oklch, var(--accent) 40%, var(--border))" }}>
          <I.Plus size={12} /> Dodaj produkt
        </button>
        <button onClick={onExport} style={fcGhostBtn}>
          <I.ArrowUp size={12} /> Eksport
        </button>
      </div>

      {/* Karty podsumowania */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <MiniStat label="Produktów" value={rows.length} sub={mfr ? mfr.name : "wszyscy"} icon={<I.Box size={14} />} />
        <MiniStat label="Zabraknie w horyzoncie" value={summary.willStockOut} sub={`z ${rows.length} SKU`} icon={<I.Alert size={14} />} />
        <MiniStat label="Zamów w 3 mies." value={summary.needOrderSoon} sub="wymaga akcji" icon={<I.Flame size={14} />} />
        <MiniStat label="Nadmiar / promo" value={summary.counts.WYPRZEDAZ} sub="komórek (6 mies.)" icon={<I.TrendDown size={14} />} />
      </div>

      {/* Heatmap */}
      <div style={{
        background: "var(--surface-1)", border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-lg)", overflow: "auto", maxHeight: "72vh",
      }}>
        <div style={{ minWidth: "min-content" }}>
          {/* Nagłówek */}
          <div style={{
            display: "grid", gridTemplateColumns: gridTemplate,
            position: "sticky", top: 0, zIndex: 6,
            background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)",
          }}>
            {META_COLS.map((c) => (
              <div key={c.id} style={{
                padding: "10px 10px", fontSize: 10, fontWeight: 700,
                letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-lo)",
                textAlign: c.align,
                ...(c.id === "sku" ? { position: "sticky", left: 0, zIndex: 7 } : {}),
                background: "var(--bg-elevated)",
              }}>{c.label}</div>
            ))}
            {monthCols.map((m) => (
              <div key={m.key} style={{
                padding: "10px 4px", fontSize: 10, fontWeight: 700, textAlign: "center",
                color: m.isYearStart ? "var(--accent)" : "var(--text-lo)",
                borderLeft: m.isYearStart ? "2px solid var(--border)" : "1px solid var(--border-soft)",
              }}>{m.label}</div>
            ))}
          </div>

          {/* Wiersze */}
          {rows.map(({ p, cells }) => (
            <div key={p.sku} className="fc-row" style={{
              display: "grid", gridTemplateColumns: gridTemplate, borderBottom: "1px solid var(--border-soft)",
            }}>
              {META_COLS.map((c) => {
                if (c.id === "rm") {
                  return (
                    <div key="rm" style={{ ...fcMetaCell, justifyContent: "center", borderRight: "1px solid var(--border-soft)" }}>
                      <button onClick={() => removeRow(p.sku)} title="Usuń z listy" className="fc-rm-btn" style={{
                        background: "transparent", border: "none", color: "var(--text-disabled)",
                        cursor: "pointer", padding: 3, display: "flex", borderRadius: 4,
                      }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--critical)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-disabled)"; }}>
                        <I.Close size={13} />
                      </button>
                    </div>
                  );
                }
                const sticky = c.id === "sku";
                return (
                  <div key={c.id} style={{
                    ...fcMetaCell, textAlign: c.align,
                    justifyContent: c.align === "right" ? "flex-end" : "flex-start",
                    ...(sticky ? { position: "sticky", left: 0, background: "var(--surface-1)", zIndex: 1 } : {}),
                  }}>{metaCellValue(c.id, p)}</div>
                );
              })}
              {/* Komórki miesięcy */}
              {cells.map((cell, ci) => {
                const b = FC_BUCKETS[cell.bucket];
                return (
                  <div key={ci} title={`${monthCols[ci].label}: ${cell.stock} szt · ${b.label}${cell.delivery ? ` · dostawa +${cell.delivery}` : ""}`}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 2px",
                      fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                      background: b.bg, color: b.fg,
                      borderLeft: monthCols[ci].isYearStart ? "2px solid var(--border)" : "1px solid color-mix(in oklch, var(--bg) 18%, transparent)",
                      position: "relative",
                    }}>
                    {cell.stock <= 0 ? "0" : cell.stock}
                    {cell.delivery > 0 && (
                      <span title={`Dostawa +${cell.delivery}`} style={{
                        position: "absolute", top: 1, right: 2, width: 5, height: 5, borderRadius: 99,
                        background: "var(--info)", boxShadow: "0 0 0 1.5px white",
                      }} />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {rows.length === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
              Brak produktów. Zmień filtr lub dodaj produkt ręcznie.
            </div>
          )}
        </div>
      </div>

      {/* Legenda */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", padding: "12px 16px",
        background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)",
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Legenda</span>
        {(Object.entries(FC_BUCKETS) as [Bucket, typeof FC_BUCKETS[Bucket]][]).map(([key, b]) => (
          <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-mid)" }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: b.bg, flexShrink: 0 }} />
            <strong style={{ color: "var(--text-hi)", fontWeight: 600 }}>{b.label}</strong>
            <span style={{ color: "var(--text-lo)" }}>({b.desc})</span>
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-mid)" }}>
          <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--info)", flexShrink: 0 }} />
          dostawa w danym miesiącu
        </span>
      </div>

      {showAdd && <AddProductModal addable={addable} onAdd={addRow} onClose={() => setShowAdd(false)} />}

      {detailMfrId != null && (
        <ManufacturerModal
          mfr={manufacturers.find((m) => m.id === detailMfrId) || null}
          products={products.filter((p) => p.manufacturer_id === detailMfrId)}
          containers={containers.filter((c) => c.manufacturer_id === detailMfrId)}
          showFin={showFin}
          onClose={() => setDetailMfrId(null)}
          onProductClick={(sku) => { setDetailMfrId(null); onProductClick?.(sku); }}
        />
      )}

      <style>{`
        .fc-rm-btn { opacity: 0; transition: opacity 0.12s; }
        .fc-row:hover .fc-rm-btn { opacity: 1; }
      `}</style>
    </div>
  );
}

// ── Picker dodawania produktu ────────────────────────────────
function AddProductModal({
  addable, onAdd, onClose,
}: {
  addable: Product[];
  onAdd: (sku: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const results = useMemo(() => {
    if (!q) return addable.slice(0, 40);
    const ql = q.toLowerCase();
    return addable.filter((p) => p.sku.toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql)).slice(0, 40);
  }, [q, addable]);

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} className="fade-in" style={{ ...modalCard, maxWidth: 540 }}>
        <div style={{
          padding: "14px 18px", borderBottom: "1px solid var(--border-soft)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <I.Plus size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Dodaj produkt do prognozy</span>
          <button onClick={onClose} style={iconBtnGhost}><I.Close size={14} /></button>
        </div>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", background: "var(--bg)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
            <I.Search size={14} style={{ color: "var(--text-lo)" }} />
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Szukaj SKU lub nazwy..."
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-hi)", fontSize: 13 }} />
          </div>
        </div>
        <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
          {results.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
              {addable.length === 0 ? "Wszystkie produkty są już na liście" : `Brak wyników dla „${q}”`}
            </div>
          ) : results.map((p) => (
            <button key={p.sku} onClick={() => { onAdd(p.sku); onClose(); }} style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%",
              padding: "10px 18px", background: "transparent", border: "none",
              borderTop: "1px solid var(--border-soft)", cursor: "pointer", textAlign: "left",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)", minWidth: 120 }}>{p.sku}</span>
              <span style={{ fontSize: 12, color: "var(--text-mid)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              {p.manufacturer_id && p.manufacturer_name && <MfrChip name={p.manufacturer_name} color={p.manufacturer_color ?? "var(--text-lo)"} size="sm" />}
              <span style={{ color: "var(--accent)", display: "flex" }}><I.Plus size={14} /></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Analityka producenta (port analytics.jsx) ────────────────
const AN_MONTHS = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];

type SeasonPoint = { year: number; month: number; qty: number; value: number };

// Wykres kalendarzowy Sty–Gru: linia przerywana = cały zeszły rok,
// gruba kolorowa = ten rok do bieżącego miesiąca. Przełącznik szt ↔ przychód
// (przychód netto = ilość × cena sprzedaży netto; tylko dla viewFinancials).
function SeasonChart({ data, showFin, height = 200, accent = "var(--accent)" }: { data: SeasonPoint[]; showFin: boolean; height?: number; accent?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const [hover, setHover] = useState<number | null>(null);
  const [metric, setMetric] = useState<"qty" | "value">("qty");
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const useValue = metric === "value" && showFin;
  const now = new Date();
  const yearNow = now.getFullYear();
  const monthNow = now.getMonth(); // 0-based

  const byKey = new Map<string, SeasonPoint>();
  data.forEach((p) => byKey.set(`${p.year}-${p.month}`, p));
  const valAt = (year: number, m: number): number => {
    const p = byKey.get(`${year}-${m}`);
    if (!p) return 0;
    return useValue ? p.value : p.qty;
  };

  const prevVals: number[] = Array.from({ length: 12 }, (_, m) => valAt(yearNow - 1, m));
  const curVals: (number | null)[] = Array.from({ length: 12 }, (_, m) => (m <= monthNow ? valAt(yearNow, m) : null));
  const labels = AN_MONTHS;

  const curNums = curVals.filter((v): v is number => v != null);
  const max = Math.max(...prevVals, ...curNums, 1);

  const pad = { t: 16, r: 12, b: 26, l: 40 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / 11) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = (vals: (number | null)[]) => {
    let d = ""; let pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  // Porównanie rok-do-roku w tym samym oknie (Sty…bieżący miesiąc)
  const curYTD = curVals.slice(0, monthNow + 1).reduce<number>((a, b) => a + (b || 0), 0);
  const prevYTD = prevVals.slice(0, monthNow + 1).reduce<number>((a, b) => a + b, 0);
  const pct = prevYTD > 0 ? ((curYTD - prevYTD) / prevYTD) * 100 : 0;

  const fmtFull = (v: number) => (useValue ? fmtPLNk(v) : `${fmtNum(Math.round(v))} szt`);
  const axisLabel = (v: number) => (useValue ? `${Math.round(v / 1000)}k` : String(Math.round(v)));

  const onMove = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - pad.l) / iw) * 11);
    if (i >= 0 && i <= 11) setHover(i);
  };

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-mid)" }}>
            <span style={{ width: 14, height: 2, background: accent, borderRadius: 2 }} /> Ten rok
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-mid)" }}>
            <span style={{ width: 14, height: 0, borderTop: "2px dashed var(--text-lo)" }} /> Rok temu
          </span>
          {showFin && (
            <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--surface-2)", borderRadius: 7 }}>
              {([["qty", "Sztuki"], ["value", "Przychód"]] as [("qty" | "value"), string][]).map(([k, lab]) => (
                <button key={k} onClick={() => setMetric(k)} style={{
                  padding: "4px 9px", fontSize: 11, fontWeight: 600, border: "none", borderRadius: 5, cursor: "pointer",
                  background: metric === k ? "var(--surface-3)" : "transparent",
                  color: metric === k ? "var(--text-hi)" : "var(--text-mid)",
                }}>{lab}</button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{fmtFull(prevYTD)} → {fmtFull(curYTD)} <span style={{ fontSize: 10 }}>(do {labels[monthNow]})</span></span>
          <span className="num" style={{ fontSize: 12, fontWeight: 700, color: pct >= 0 ? "var(--ok)" : "var(--critical)" }}>
            {pct >= 0 ? "+" : ""}{pct.toFixed(1)}%
          </span>
        </div>
      </div>
      <div ref={ref} style={{ position: "relative" }}>
        <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={pad.l} x2={w - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--border-soft)" strokeDasharray="2,4" />
          ))}
          {[0.5, 1].map((f) => (
            <text key={f} x={pad.l - 6} y={y(max * f) + 3} fill="var(--text-lo)" fontSize="9" textAnchor="end" fontFamily="var(--font-mono)">{axisLabel(max * f)}</text>
          ))}
          <path d={line(prevVals)} stroke="var(--text-lo)" strokeWidth="1.5" fill="none" strokeDasharray="4,3" opacity="0.7" />
          <path d={line(curVals)} stroke={accent} strokeWidth="2.4" fill="none" strokeLinejoin="round" />
          {curVals.map((v, i) => (v == null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4 : 2.5} fill={accent} />))}
          {hover != null && (
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--text-lo)" strokeDasharray="2,3" />
          )}
          {labels.map((l, i) => (
            <text key={i} x={x(i)} y={height - 8} fill={hover === i ? "var(--text-hi)" : "var(--text-lo)"} fontSize="9" textAnchor="middle" fontFamily="var(--font-mono)">{l}</text>
          ))}
        </svg>
        {hover != null && (
          <div style={{
            position: "absolute", left: Math.min(Math.max(x(hover) - 70, 4), w - 150), top: 6,
            background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 7,
            padding: "7px 10px", fontSize: 11, pointerEvents: "none", minWidth: 136,
          }}>
            <div style={{ fontSize: 10, color: "var(--text-lo)", fontWeight: 600 }}>{labels[hover]}</div>
            <div className="num" style={{ color: accent, fontWeight: 600 }}>ten rok: {curVals[hover] == null ? "—" : fmtFull(curVals[hover] as number)}</div>
            <div className="num" style={{ color: "var(--text-lo)" }}>rok temu: {fmtFull(prevVals[hover])}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Szczegóły producenta (port ManufacturerModal) ────────────
function ManufacturerModal({
  mfr, products, containers, showFin, onClose, onProductClick,
}: {
  mfr: Manufacturer | null;
  products: Product[];
  containers: Container[];
  showFin: boolean;
  onClose: () => void;
  onProductClick?: (sku: string) => void;
}) {
  const [season, setSeason] = useState<SeasonPoint[] | null>(null);
  const [seasonErr, setSeasonErr] = useState(false);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const mfrId = mfr?.id;
  useEffect(() => {
    if (mfrId == null) return;
    let alive = true;
    setSeason(null); setSeasonErr(false);
    api.get(`/manufacturers/${mfrId}/sales-season`)
      .then((d) => { if (alive) setSeason((d as SeasonPoint[]) || []); })
      .catch(() => { if (alive) setSeasonErr(true); });
    return () => { alive = false; };
  }, [mfrId]);

  if (!mfr) return null;

  const mfrExt = mfr as Manufacturer & { contact?: string | null };
  const inFlight = containers.filter((c) => c.status !== "DELIVERED");
  const delivered = containers.filter((c) => c.status === "DELIVERED").length;
  const stockValue = products.reduce((s, p) => s + (p.stock_value || 0), 0);
  const inTransitValue = inFlight.reduce((s, c) => s + (c.total_value || 0), 0);
  const needOrder = products.filter((p) => p.status === "KRYTYCZNY" || p.status === "ZAMOW_TERAZ");

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} className="fade-in" style={{ ...modalCard, maxWidth: 820, maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
        {/* Nagłówek */}
        <div style={{ padding: "16px 22px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", position: "relative", flexShrink: 0 }}>
          <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: mfr.color }} />
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: `color-mix(in oklch, ${mfr.color} 20%, var(--bg))`, border: `1px solid ${mfr.color}`, color: mfr.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <I.Factory size={22} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)" }}>{mfr.name}</div>
              <div style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 2 }}>
                {mfrExt.contact ? `${mfrExt.contact} · ` : ""}<span className="mono">{mfr.email || "—"}</span>
              </div>
            </div>
            <button onClick={onClose} style={fcIconBtnHeader}><I.Close size={14} /></button>
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* KPI */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
            <FcMetricBox label="Produktów (SKU)" value={products.length} sub={`${needOrder.length} do zamówienia`} tone={needOrder.length ? "warning" : "neutral"} />
            <FcMetricBox label="Wartość magazynu" value={showFin ? fmtPLNk(stockValue) : "•••"} sub="bieżący stan" />
            <FcMetricBox label="W drodze" value={showFin ? fmtPLNk(inTransitValue) : "•••"} sub={`${inFlight.length} kontenerów`} tone="info" />
            <FcMetricBox label="Kontenery łącznie" value={containers.length} sub={`${delivered} dostarczonych`} />
          </div>

          {/* Sezon do sezonu */}
          <FcSection title="Sprzedaż wszystkich SKU — sezon do sezonu">
            {season ? (
              <SeasonChart data={season} showFin={showFin} accent={mfr.color} />
            ) : seasonErr ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
                Brak danych historycznych sprzedaży dla tego producenta.
              </div>
            ) : (
              <div className="pulse-soft" style={{ height: 200, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }} />
            )}
          </FcSection>

          {/* Wymaga zamówienia */}
          {needOrder.length > 0 && (
            <FcSection title={`Wymaga zamówienia (${needOrder.length})`}>
              <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
                {needOrder.map((p, i) => (
                  <div key={p.sku} onClick={() => onProductClick?.(p.sku)} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: onProductClick ? "pointer" : "default",
                    borderBottom: i === needOrder.length - 1 ? "none" : "1px solid var(--border-soft)",
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                    <StatusPillExt status={displayStatus(p)} size="sm" />
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{p.sku}</span>
                    <span style={{ fontSize: 12, color: "var(--text-mid)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>stan {p.stock} · {Math.round(p.avg_monthly_weighted)}/mies</span>
                  </div>
                ))}
              </div>
            </FcSection>
          )}

          {/* Kontenery w drodze */}
          {inFlight.length > 0 && (
            <FcSection title={`Kontenery w drodze (${inFlight.length})`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {inFlight.map((c) => {
                  const m = STATUS_FULL_META[c.status] || STATUS_FULL_META.ORDERED;
                  const Icon = m.icon;
                  const days = Math.ceil((new Date(c.eta_date).getTime() - Date.now()) / 86400000);
                  return (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
                      <span style={{ color: m.fg, display: "flex" }}><Icon size={14} /></span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>#{c.container_number}</span>
                      <Pill bg={m.bg} fg={m.fg} size="sm">{m.label}</Pill>
                      <span style={{ flex: 1 }} />
                      <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{c.total_units} szt · {showFin ? fmtPLNk(c.total_value) : "•••"} · za {days}d</span>
                    </div>
                  );
                })}
              </div>
            </FcSection>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pomocnicze (lokalne odpowiedniki Section/MetricBox z mocka) ──
function FcSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

const FC_TONE_COLOR: Record<string, string> = {
  neutral: "var(--text-hi)", warning: "var(--warning)", info: "var(--info)", critical: "var(--critical)", ok: "var(--ok)",
};

function FcMetricBox({ label, value, sub, tone = "neutral" }: { label: string; value: React.ReactNode; sub?: string; tone?: "neutral" | "warning" | "info" | "critical" | "ok" }) {
  return (
    <div style={{ padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, color: FC_TONE_COLOR[tone] || "var(--text-hi)", marginTop: 5, letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

const fcIconBtnHeader: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border-soft)",
  color: "var(--text-mid)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
};
