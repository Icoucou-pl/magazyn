"use client";
// ============================================================
// MAGAZYN — Produkty: UI listy (port products-ui.jsx, część 2a).
//   Toolbar, tabela, wiersze, komórki, StatusPillExt, ColPicker,
//   Checkbox, BulkBar + wspólne style modali (dla 2b/2c).
//   Operuje na realnych polach ProductSummary z /api/products.
// ============================================================

import React, { useEffect, useState } from "react";
import { I, Pill, MfrChip, STATUS_META } from "./ui";
import { exportCsv, toast, type CsvColumn } from "./toast";
import { api } from "@/lib/api";
import { canEdit, useUser } from "@/lib/permissions";
import { fmtNum, fmtPLNk } from "@/lib/format";

// ── Typ produktu (z /api/products) ───────────────────────────
export type IncomingDelivery = {
  container_id: number; container_number: string; eta_date: string; status: string; quantity: number;
};
export type Product = {
  sku: string;
  name: string;
  stock: number;
  stock_value: number;
  purchase_price: number;
  stock_in_transit: number;
  product_status: "ACTIVE" | "ACTIVE_NO_STOCK" | "DEAD_STOCK" | "INACTIVE";
  cbm_per_unit: number;
  manufacturer_id: number | null;
  manufacturer_name: string | null;
  manufacturer_color: string | null;
  seasonality_enabled: boolean;
  is_favorite: boolean;
  ean: string | null;
  forced_status: string | null;
  lead_time_days: number;
  sales_1m: number; sales_2m: number; sales_3m: number; sales_4m: number;
  sales_yoy_30d: number; sales_yoy_next_30d: number;
  avg_monthly_weighted: number;
  months_of_stock: number;
  days_until_empty: number;
  days_until_order: number;
  empty_date: string | null;
  order_date: string | null;
  status: string; // urgencja: KRYTYCZNY/ZAMOW_TERAZ/ZAMOW_WKROTCE/OK
  incoming_deliveries: IncomingDelivery[];
};

export type Manufacturer = { id: number; name: string; color: string; email?: string | null; notes?: string | null };

// ── Stałe ────────────────────────────────────────────────────
export const STATUS_RANK: Record<string, number> = { KRYTYCZNY: 0, ZAMOW_TERAZ: 1, ZAMOW_WKROTCE: 2, OK: 3, DEAD_STOCK: 4 };

type ColId =
  | "fav" | "sku" | "name" | "mfr" | "stock" | "inTransit"
  | "sales_1m" | "sales_2m" | "sales_3m" | "sales_4m"
  | "avgMonth" | "yoy" | "yoyNext" | "months" | "price" | "value" | "lt" | "cbm" | "status";

export type ColDef = {
  id: ColId; label: string; w: number | string;
  align: "left" | "right" | "center";
  sortKey: keyof Product | null;
  alwaysVisible?: boolean; highlight?: "yoy";
};

export const PRODUCT_COLS: ColDef[] = [
  { id: "fav", label: "", w: 36, align: "center", sortKey: null, alwaysVisible: true },
  { id: "sku", label: "SKU", w: 132, align: "left", sortKey: "sku", alwaysVisible: true },
  { id: "name", label: "Nazwa", w: "minmax(180px, 1fr)", align: "left", sortKey: "name", alwaysVisible: true },
  { id: "mfr", label: "Producent", w: 150, align: "left", sortKey: "manufacturer_name" },
  { id: "stock", label: "Stan", w: 70, align: "right", sortKey: "stock" },
  { id: "inTransit", label: "W drodze", w: 80, align: "right", sortKey: "stock_in_transit" },
  { id: "sales_1m", label: "Sprz. 1m", w: 80, align: "right", sortKey: "sales_1m" },
  { id: "sales_2m", label: "Sprz. 2m", w: 80, align: "right", sortKey: "sales_2m" },
  { id: "sales_3m", label: "Sprz. 3m", w: 80, align: "right", sortKey: "sales_3m" },
  { id: "sales_4m", label: "Sprz. 4m", w: 80, align: "right", sortKey: "sales_4m" },
  { id: "avgMonth", label: "Sprz./mies", w: 90, align: "right", sortKey: "avg_monthly_weighted" },
  { id: "yoy", label: "YoY (rok)", w: 90, align: "right", sortKey: "sales_yoy_30d", highlight: "yoy" },
  { id: "yoyNext", label: "YoY +30d", w: 90, align: "right", sortKey: "sales_yoy_next_30d", highlight: "yoy" },
  { id: "months", label: "Mies. zap.", w: 80, align: "right", sortKey: "months_of_stock" },
  { id: "price", label: "Cena", w: 90, align: "right", sortKey: "purchase_price" },
  { id: "value", label: "Wartość", w: 100, align: "right", sortKey: "stock_value" },
  { id: "lt", label: "LT", w: 60, align: "right", sortKey: "lead_time_days" },
  { id: "cbm", label: "CBM", w: 70, align: "right", sortKey: "cbm_per_unit" },
  { id: "status", label: "Status", w: 130, align: "left", sortKey: "status", alwaysVisible: true },
];

export const DEFAULT_COLS: ColId[] = ["fav", "sku", "name", "mfr", "stock", "inTransit", "sales_1m", "sales_2m", "avgMonth", "yoy", "yoyNext", "months", "value", "status"];

const FILTER_CHIPS: Array<{ id: string; label: string; icon?: React.ReactNode }> = [
  { id: "active", label: "Aktywne" },
  { id: "favorites", label: "Obserwowane", icon: <I.StarFill size={11} /> },
  { id: "critical", label: "Krytyczne" },
  { id: "dead", label: "Dead stock" },
  { id: "all", label: "Wszystkie" },
];

// ── Helpery wyświetlania ─────────────────────────────────────
export const displayStatus = (p: Product): string => (p.product_status === "DEAD_STOCK" ? "DEAD_STOCK" : p.status);
export const monthsDisplay = (v: number): string => (!isFinite(v) || v > 99 ? "∞" : v.toFixed(1));

// ── Toolbar ──────────────────────────────────────────────────
export function ProductsToolbar({
  search, setSearch, filter, setFilter, counts, resultCount, onPickCols, visibleColsCount, onImport, onExport,
}: {
  search: string; setSearch: (v: string) => void;
  filter: string; setFilter: (v: string) => void;
  counts: Record<string, number>; resultCount: number;
  onPickCols: () => void; visibleColsCount: number;
  onImport: () => void; onExport: () => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 11px", background: "var(--bg)", border: "1px solid var(--border-soft)", borderRadius: 8, flex: "1 1 240px", minWidth: 200, maxWidth: 360 }}>
        <I.Search size={14} style={{ color: "var(--text-lo)" }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Szukaj SKU lub nazwy..."
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-hi)", fontSize: 13 }} />
        {search && (
          <button onClick={() => setSearch("")} style={{ background: "transparent", border: "none", color: "var(--text-lo)", display: "flex", padding: 2 }}><I.Close size={13} /></button>
        )}
      </div>

      <div style={{ display: "flex", gap: 4, padding: 3, background: "var(--surface-2)", borderRadius: 8, flexWrap: "wrap", maxWidth: "100%" }}>
        {FILTER_CHIPS.map((c) => {
          const active = filter === c.id;
          return (
            <button key={c.id} onClick={() => setFilter(c.id)} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", fontSize: 12, fontWeight: 500, background: active ? "var(--surface-3)" : "transparent", color: active ? "var(--text-hi)" : "var(--text-mid)", border: "none", borderRadius: 6, transition: "all 0.12s" }}>
              {c.icon}
              {c.label}
              <span className="num" style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 99, background: active ? "var(--accent-soft)" : "var(--surface-3)", color: active ? "var(--accent)" : "var(--text-lo)" }}>{counts[c.id]}</span>
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>
        <span style={{ color: "var(--text-hi)", fontWeight: 600 }}>{resultCount}</span> wyników
      </span>

      <button onClick={onPickCols} style={btnSecondary}>
        <I.Dashboard size={12} /> <span style={{ whiteSpace: "nowrap" }}>Kolumny ({visibleColsCount})</span>
      </button>

      {showEdit && (
        <button onClick={onImport} style={btnSecondary}>
          <I.ArrowDown size={12} /> <span style={{ whiteSpace: "nowrap" }}>Import</span>
        </button>
      )}

      <button onClick={onExport} style={btnSecondary}>
        <I.ArrowUp size={12} /> <span style={{ whiteSpace: "nowrap" }}>Eksport</span>
      </button>
    </div>
  );
}

// ── Tabela ───────────────────────────────────────────────────
export function ProductsTable({
  rows, cols, sort, toggleSort, onProductClick, selected, onToggleRow, onToggleAll, onToggleFav,
}: {
  rows: Product[]; cols: ColDef[];
  sort: { key: keyof Product | null; dir: "asc" | "desc" | null };
  toggleSort: (key: keyof Product | null) => void;
  onProductClick: (p: Product) => void;
  selected: Set<string>;
  onToggleRow: (sku: string) => void;
  onToggleAll: (rows: Product[]) => void;
  onToggleFav: (p: Product) => void;
}) {
  const baseTemplate = cols.map((c) => (typeof c.w === "number" ? c.w + "px" : c.w)).join(" ");
  const gridTemplate = `36px ${baseTemplate}`;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.sku));

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflowX: "auto", overflowY: "clip" }}>
      <div style={{ minWidth: "min-content" }}>
        <div style={{ display: "grid", gridTemplateColumns: gridTemplate, background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", position: "sticky", top: "var(--app-header-h, 60px)", zIndex: 5, borderTopLeftRadius: "var(--r-lg)", borderTopRightRadius: "var(--r-lg)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "10px 0" }} onClick={(e) => e.stopPropagation()}>
            <Checkbox checked={allSelected} onChange={() => onToggleAll(rows)} />
          </div>
          {cols.map((col) => {
            const isActive = sort.key === col.sortKey;
            const align = col.align === "right" ? "flex-end" : col.align === "center" ? "center" : "flex-start";
            const headerBg = col.highlight === "yoy" ? "color-mix(in oklch, var(--anomaly) 8%, var(--bg-elevated))" : "transparent";
            return (
              <button key={col.id} onClick={() => toggleSort(col.sortKey)} disabled={!col.sortKey}
                style={{ display: "flex", alignItems: "center", justifyContent: align, gap: 4, padding: "10px 12px", background: headerBg, border: "none", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: isActive ? "var(--accent)" : (col.highlight === "yoy" ? "var(--anomaly)" : "var(--text-lo)"), cursor: col.sortKey ? "pointer" : "default", textAlign: col.align, transition: "color 0.12s" }}
                onMouseEnter={(e) => { if (col.sortKey && !isActive) e.currentTarget.style.color = "var(--text-mid)"; }}
                onMouseLeave={(e) => { if (col.sortKey && !isActive) e.currentTarget.style.color = "var(--text-lo)"; }}>
                {col.label}
                {col.sortKey && (
                  <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 0.6, fontSize: 8, color: isActive ? "var(--accent)" : "var(--border-strong)" }}>
                    <span style={{ opacity: isActive && sort.dir === "asc" ? 1 : 0.35 }}>▲</span>
                    <span style={{ opacity: isActive && sort.dir === "desc" ? 1 : 0.35 }}>▼</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 50, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
            <I.Box size={32} style={{ opacity: 0.4, marginBottom: 10 }} />
            <div>Brak produktów spełniających kryteria</div>
          </div>
        ) : (
          <div>
            {rows.map((p, idx) => (
              <ProductRow key={p.sku} product={p} cols={cols} gridTemplate={gridTemplate}
                isLast={idx === rows.length - 1} selected={selected.has(p.sku)}
                onToggleRow={() => onToggleRow(p.sku)} onClick={() => onProductClick(p)} onToggleFav={onToggleFav} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProductRow({
  product, cols, gridTemplate, onClick, isLast, selected, onToggleRow, onToggleFav,
}: {
  product: Product; cols: ColDef[]; gridTemplate: string;
  onClick: () => void; isLast: boolean; selected: boolean;
  onToggleRow: () => void; onToggleFav: (p: Product) => void;
}) {
  return (
    <div onClick={onClick} style={{ display: "grid", gridTemplateColumns: gridTemplate, cursor: "pointer", borderBottom: isLast ? "none" : "1px solid var(--border-soft)", transition: "background 0.1s", background: selected ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent" }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--surface-2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent"; }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }} onClick={(e) => { e.stopPropagation(); onToggleRow(); }}>
        <Checkbox checked={selected} onChange={() => {}} />
      </div>
      {cols.map((col) => (
        <Cell key={col.id} col={col} product={product} onToggleFav={onToggleFav} />
      ))}
    </div>
  );
}

function Cell({ col, product: p, onToggleFav }: { col: ColDef; product: Product; onToggleFav: (p: Product) => void }) {
  const isYoy = col.highlight === "yoy";
  const baseStyle: React.CSSProperties = {
    padding: "11px 12px", fontSize: 12, display: "flex", alignItems: "center", minWidth: 0, overflow: "hidden",
    justifyContent: col.align === "right" ? "flex-end" : col.align === "center" ? "center" : "flex-start",
    background: isYoy ? "color-mix(in oklch, var(--anomaly) 5%, transparent)" : "transparent",
  };

  switch (col.id) {
    case "fav":
      return (
        <div style={baseStyle} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => onToggleFav(p)} style={{ background: "transparent", border: "none", padding: 4, color: p.is_favorite ? "var(--accent)" : "var(--text-disabled)", display: "flex" }}>
            {p.is_favorite ? <I.StarFill size={14} /> : <I.Star size={14} />}
          </button>
        </div>
      );
    case "sku":
      return <div style={baseStyle}><span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-hi)" }}>{p.sku}</span></div>;
    case "name":
      return <div style={baseStyle}><span style={{ color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span></div>;
    case "mfr":
      return <div style={baseStyle}>{p.manufacturer_id && p.manufacturer_name ? <MfrChip name={p.manufacturer_name} color={p.manufacturer_color ?? "var(--text-lo)"} /> : <span style={{ color: "var(--text-disabled)" }}>—</span>}</div>;
    case "stock":
      return <div style={baseStyle}><span className="num" style={{ fontWeight: 600, color: p.stock === 0 ? "var(--critical)" : "var(--text-hi)" }}>{p.stock}</span></div>;
    case "inTransit":
      return <div style={baseStyle}>{p.stock_in_transit > 0 ? <span className="num" style={{ color: "var(--info)", fontWeight: 600 }}>+{p.stock_in_transit}</span> : <span style={{ color: "var(--text-disabled)" }}>—</span>}</div>;
    case "avgMonth":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-mid)" }}>{Math.round(p.avg_monthly_weighted)}</span></div>;
    case "sales_1m":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-mid)" }}>{p.sales_1m}</span></div>;
    case "sales_2m":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-mid)" }}>{p.sales_2m}</span></div>;
    case "sales_3m":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-mid)" }}>{p.sales_3m}</span></div>;
    case "sales_4m":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-mid)" }}>{p.sales_4m}</span></div>;
    case "yoy":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--anomaly)", fontWeight: 500 }}>{p.sales_yoy_30d}</span></div>;
    case "yoyNext":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--anomaly)", fontWeight: 600 }}>{p.sales_yoy_next_30d}</span></div>;
    case "months": {
      const v = p.months_of_stock;
      const disp = monthsDisplay(v);
      const mColor = disp === "∞" ? "var(--text-disabled)" : v < 1 ? "var(--critical)" : v < 2 ? "var(--warning)" : v > 12 ? "var(--text-disabled)" : "var(--text-mid)";
      return <div style={baseStyle}><span className="num" style={{ color: mColor, fontWeight: 500 }}>{disp === "∞" ? "∞" : disp + "m"}</span></div>;
    }
    case "price":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-mid)" }}>{fmtNum(p.purchase_price)}</span></div>;
    case "value":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-hi)", fontWeight: 500 }}>{fmtPLNk(p.stock_value)}</span></div>;
    case "lt":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-mid)" }}>{p.lead_time_days}d</span></div>;
    case "cbm":
      return <div style={baseStyle}><span className="num" style={{ color: "var(--text-mid)" }}>{(p.cbm_per_unit ?? 0).toFixed(3)}</span></div>;
    case "status":
      return <div style={baseStyle}><StatusPillExt status={displayStatus(p)} size="sm" /></div>;
    default:
      return <div style={baseStyle} />;
  }
}

// ── StatusPill obsługujący DEAD_STOCK ────────────────────────
export function StatusPillExt({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  const meta = STATUS_META[status] || (status === "DEAD_STOCK"
    ? { label: "DEAD STOCK", bg: "var(--surface-3)", fg: "var(--text-lo)", dot: "var(--text-disabled)" }
    : null);
  if (!meta) return null;
  return <Pill bg={meta.bg} fg={meta.fg} dot={meta.dot} size={size}>{meta.label}</Pill>;
}

// ── Wybór kolumn (modal) ─────────────────────────────────────
export function ColPickerModal({
  cols, visible, setVisible, onClose,
}: {
  cols: ColDef[]; visible: ColId[]; setVisible: (v: ColId[]) => void; onClose: () => void;
}) {
  const toggle = (id: ColId) => {
    const col = cols.find((c) => c.id === id);
    if (col?.alwaysVisible) return;
    setVisible(visible.includes(id) ? visible.filter((x) => x !== id) : [...visible, id]);
  };
  const reset = () => setVisible(DEFAULT_COLS);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalCard, maxWidth: 420 }} className="fade-in">
        <div style={modalHeader}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <I.Dashboard size={15} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Widoczne kolumny</span>
          </div>
          <button onClick={onClose} style={iconBtnGhost}><I.Close size={14} /></button>
        </div>
        <div style={{ padding: "4px 0", maxHeight: 460, overflowY: "auto" }}>
          {cols.map((col) => {
            if (!col.label) return null;
            const on = visible.includes(col.id);
            const locked = col.alwaysVisible;
            return (
              <label key={col.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", cursor: locked ? "default" : "pointer", opacity: locked ? 0.5 : 1, transition: "background 0.1s" }}
                onMouseEnter={(e) => { if (!locked) e.currentTarget.style.background = "var(--surface-2)"; }}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <Checkbox checked={on} onChange={() => toggle(col.id)} disabled={locked} />
                <span style={{ fontSize: 13, color: "var(--text-hi)", flex: 1 }}>{col.label}</span>
                {locked && <span style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em" }}>wymagana</span>}
              </label>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 18px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-elevated)" }}>
          <button onClick={reset} style={btnSecondary}>Resetuj</button>
          <button onClick={onClose} style={btnPrimary}>Gotowe</button>
        </div>
      </div>
    </div>
  );
}

// ── Checkbox (dark) ──────────────────────────────────────────
export function Checkbox({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button onClick={onChange} disabled={disabled} style={{ width: 16, height: 16, borderRadius: 4, background: checked ? "var(--accent)" : "var(--surface-2)", border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: disabled ? "default" : "pointer", padding: 0 }}>
      {checked && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  );
}

// ── BulkBar (akcje na zaznaczonych) ──────────────────────────
export function BulkBar({
  count, selectedSkus, rows, manufacturers, onClear, onReload,
}: {
  count: number; selectedSkus: string[]; rows: Product[];
  manufacturers: Manufacturer[]; onClear: () => void; onReload: () => void;
}) {
  const [mfrOpen, setMfrOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedRows = () => rows.filter((p) => selectedSkus.includes(p.sku));

  const exportSel = () => {
    const cols: CsvColumn<Product>[] = [
      { key: "sku", label: "SKU" },
      { key: "name", label: "Nazwa" },
      { label: "Producent", get: (p) => p.manufacturer_name || "" },
      { key: "stock", label: "Stan" },
      { key: "purchase_price", label: "Cena zakupu" },
      { label: "Status", get: (p) => displayStatus(p) },
    ];
    exportCsv("produkty-zaznaczone", cols, selectedRows());
  };

  const runBulk = async (label: string, fn: (sku: string) => Promise<unknown>, skus: string[]) => {
    if (busy) return;
    if (skus.length === 0) { toast("Nic do zmiany", "info"); return; }
    setBusy(true);
    try {
      await Promise.all(skus.map((sku) => fn(sku)));
      toast(label, "ok");
      onClear();
      onReload();
    } catch {
      toast("Część operacji się nie powiodła", "warning");
      onReload();
    } finally {
      setBusy(false);
    }
  };

  const watch = () => {
    // tylko te, które jeszcze nie są obserwowane (endpoint /favorite jest togglem)
    const toAdd = selectedRows().filter((p) => !p.is_favorite).map((p) => p.sku);
    runBulk(`Dodano ${toAdd.length} do obserwowanych`, (sku) => api.put(`/products/${sku}/favorite`), toAdd);
  };
  const assignMfr = (m: Manufacturer) => {
    setMfrOpen(false);
    runBulk(`Przypisano ${count} do: ${m.name}`, (sku) => api.put(`/products/${sku}/attrs`, { manufacturer_id: m.id }), selectedSkus);
  };
  const toForecast = () => runBulk(`Włączono prognozę dla ${count}`, (sku) => api.put(`/products/${sku}/attrs`, { seasonality_enabled: true }), selectedSkus);

  return (
    <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 70, maxWidth: "calc(100vw - 24px)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 12px 10px 16px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)", opacity: busy ? 0.7 : 1 }} className="fade-in">
      <span className="num" style={{ fontSize: 13, fontWeight: 700, color: "var(--text-hi)" }}>{count}</span>
      <span style={{ fontSize: 12, color: "var(--text-mid)", marginRight: 4 }}>zaznaczonych</span>
      <span style={{ width: 1, height: 22, background: "var(--border)" }} />

      <button onClick={watch} disabled={busy} style={bulkBtn}>
        <I.StarFill size={12} style={{ color: "var(--accent)" }} /> Obserwuj
      </button>
      <div style={{ position: "relative" }}>
        <button onClick={() => setMfrOpen(!mfrOpen)} disabled={busy} style={bulkBtn}>
          <I.Factory size={12} /> Producent <I.ChevronD size={11} />
        </button>
        {mfrOpen && (
          <div className="fade-in" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, width: 200, maxHeight: 280, overflowY: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, padding: 6, boxShadow: "0 16px 40px rgba(0,0,0,0.4)" }}>
            {manufacturers.length === 0 && <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-lo)" }}>Brak producentów</div>}
            {manufacturers.map((m) => (
              <button key={m.id} onClick={() => assignMfr(m)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", background: "transparent", border: "none", borderRadius: 6, cursor: "pointer", textAlign: "left" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: m.color }} />
                <span style={{ fontSize: 12, color: "var(--text-hi)" }}>{m.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button onClick={toForecast} disabled={busy} style={bulkBtn}>
        <I.Activity size={12} /> Do prognozy
      </button>
      <button onClick={exportSel} disabled={busy} style={bulkBtn}>
        <I.ArrowDown size={12} /> Eksport
      </button>

      <span style={{ width: 1, height: 22, background: "var(--border)" }} />
      <button onClick={onClear} title="Wyczyść zaznaczenie" style={{ ...bulkBtn, border: "none", padding: 6 }}>
        <I.Close size={14} />
      </button>
    </div>
  );
}

// ── Wspólne style (eksport dla 2b/2c) ────────────────────────
export const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 100, background: "color-mix(in oklch, var(--bg) 50%, black)",
  backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
};
export const modalCard: React.CSSProperties = {
  background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 14,
  boxShadow: "0 24px 80px rgba(0,0,0,0.6)", width: "100%", maxHeight: "92dvh",
  display: "flex", flexDirection: "column", overflow: "hidden",
};
export const modalHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--border-soft)",
};
export const btnPrimary: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", background: "var(--accent)",
  border: "1px solid var(--accent)", color: "var(--accent-ink)", borderRadius: 7, fontSize: 12, fontWeight: 600,
};
export const btnSecondary: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", background: "var(--surface-2)",
  border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 7, fontSize: 11, fontWeight: 500,
};
export const iconBtnGhost: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
  background: "transparent", border: "none", color: "var(--text-lo)", borderRadius: 6,
};
const bulkBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", fontSize: 12, fontWeight: 600,
  background: "var(--surface-2)", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 7, cursor: "pointer",
};
