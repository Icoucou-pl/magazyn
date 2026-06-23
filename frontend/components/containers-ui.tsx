"use client";
// ============================================================
// MAGAZYN — Kontenery: UI (port containers.jsx, część 3a).
//   Statusy, toolbar, rozwijane karty, timeline statusu, KPI.
//   Operuje na realnym ContainerOut z /api/containers.
//   „Track carrier" pominięty (brak realnego mapowania przewoźnika).
// ============================================================

import React from "react";
import { I, Pill, MfrChip } from "./ui";
import { btnPrimary, btnSecondary } from "./products-ui";
import { exportCsv, toast, type CsvColumn } from "./toast";
import { download } from "@/lib/api";
import { canEdit, can, useUser } from "@/lib/permissions";
import { fmtPLN, fmtPLNk, fmtNum } from "@/lib/format";

// ── Typy ─────────────────────────────────────────────────────
export type ContainerItem = {
  id: number; sku: string; quantity: number; unit_cost: number | null;
  lot_id?: number | null;
  product_name: string | null; cbm_per_unit: number; total_cbm: number;
};
export type ContainerLot = {
  id: number;
  manufacturer_id: number | null;
  manufacturer_name: string | null;
  manufacturer_color: string | null;
  order_number: string | null;
  total_units: number; total_cbm: number; total_value: number;
};
export type Attachment = { id: number; filename: string; file_type: string | null; file_size: string | null; uploaded_at: string };
export type Container = {
  id: number;
  container_number: string;
  order_number: string | null;
  container_type_id: number | null;
  container_type_name: string | null;
  container_capacity_cbm: number | null;
  manufacturer_id: number | null;
  manufacturer_name: string | null;
  manufacturer_color: string | null;
  is_consolidated?: boolean;
  lots?: ContainerLot[];
  order_date: string;
  eta_date: string;
  status: string;                       // status ręczny (z bazy)
  effective_status?: string;            // status wyświetlany: ręczny lub auto (CUSTOMS/DELIVERED) z ETA
  is_auto?: boolean;                    // status wynika z dat (odprawa / auto-dostawa)
  customs_days_left?: number | null;    // w odprawie: dni do auto-dostawy
  notes: string | null;
  items: ContainerItem[];
  attachments: Attachment[];
  total_units: number;
  total_cbm: number;
  fill_percentage: number | null;
  total_value: number;
};

type StatusMetaFull = { label: string; icon: React.ComponentType<{ size?: number }>; fg: string; bg: string; accent: string };

// STATUS_FLOW = ręczny tok statusów (do przycisku „Przenieś do…" i kroków ręcznych).
export const STATUS_FLOW = ["ORDERED", "IN_PRODUCTION", "IN_TRANSIT", "DELIVERED"];
// TIMELINE_FLOW = pełna oś czasu z automatyczną odprawą celną (do wizualizacji postępu).
export const TIMELINE_FLOW = ["ORDERED", "IN_PRODUCTION", "IN_TRANSIT", "CUSTOMS", "DELIVERED"];
// FILTER_STATUSES = chipy filtra (na statusie efektywnym — z odprawą włącznie).
export const FILTER_STATUSES = ["ORDERED", "IN_PRODUCTION", "IN_TRANSIT", "CUSTOMS", "DELIVERED"];

export const STATUS_FULL_META: Record<string, StatusMetaFull> = {
  ORDERED: { label: "Zamówione", icon: I.Box, fg: "var(--text-mid)", bg: "var(--surface-2)", accent: "var(--text-mid)" },
  IN_PRODUCTION: { label: "W produkcji", icon: I.Factory, fg: "var(--anomaly)", bg: "var(--anomaly-soft)", accent: "var(--anomaly)" },
  IN_TRANSIT: { label: "W drodze", icon: I.Ship, fg: "var(--info)", bg: "var(--info-soft)", accent: "var(--info)" },
  CUSTOMS: { label: "Odprawa celna", icon: I.Customs, fg: "var(--warning)", bg: "var(--warning-soft)", accent: "var(--warning)" },
  DELIVERED: { label: "Dostarczone", icon: I.Activity, fg: "var(--ok)", bg: "var(--ok-soft)", accent: "var(--ok)" },
};

// Status do wyświetlenia: efektywny z backendu, a gdy go brak — ręczny.
export const eff = (c: { effective_status?: string; status: string }): string => c.effective_status || c.status;

// ── Mini stat ────────────────────────────────────────────────
export function MiniStat({ label, value, sub, icon }: { label: string; value: React.ReactNode; sub?: string; icon?: React.ReactNode }) {
  return (
    <div style={{ padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
        {icon && <span style={{ color: "var(--text-lo)" }}>{icon}</span>}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 600, color: "var(--text-hi)", marginTop: 4, letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────
export function ContainersToolbar({
  search, setSearch, filter, setFilter, counts, expandedAny, onToggleAll, onAutoSuggest, onNew, rows,
}: {
  search: string; setSearch: (v: string) => void;
  filter: string; setFilter: (v: string) => void;
  counts: Record<string, number>; expandedAny: boolean;
  onToggleAll: () => void; onAutoSuggest: () => void; onNew: () => void;
  rows: Container[];
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const exportAll = () => {
    const cols: CsvColumn<Container>[] = [
      { key: "container_number", label: "Nr kontenera" },
      { key: "order_number", label: "Nr zamowienia" },
      { key: "container_type_name", label: "Typ" },
      { key: "manufacturer_name", label: "Producent" },
      { label: "Status", get: (c) => STATUS_FULL_META[eff(c)]?.label || eff(c) },
      { key: "order_date", label: "Data zamowienia" },
      { key: "eta_date", label: "ETA" },
      { key: "total_units", label: "Sztuk" },
      ...(showFin ? [{ key: "total_value", label: "Wartosc" } as CsvColumn<Container>] : []),
      { key: "total_cbm", label: "CBM" },
      { key: "fill_percentage", label: "Wypelnienie %" },
    ];
    exportCsv("kontenery", cols, rows);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 11px", background: "var(--bg)", border: "1px solid var(--border-soft)", borderRadius: 8, flex: "1 1 200px", minWidth: 180, maxWidth: 280 }}>
        <I.Search size={14} style={{ color: "var(--text-lo)" }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Szukaj nr / PO / SKU" style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-hi)", fontSize: 13 }} />
        {search && <button onClick={() => setSearch("")} style={{ background: "transparent", border: "none", color: "var(--text-lo)", display: "flex", padding: 2 }}><I.Close size={13} /></button>}
      </div>

      <div style={{ display: "flex", gap: 4, padding: 3, background: "var(--surface-2)", borderRadius: 8, flexWrap: "wrap" }}>
        <FilterChip active={filter === "ALL"} onClick={() => setFilter("ALL")} count={counts.ALL}>Wszystkie</FilterChip>
        {FILTER_STATUSES.map((s) => {
          const m = STATUS_FULL_META[s];
          const Icon = m.icon;
          return (
            <FilterChip key={s} active={filter === s} onClick={() => setFilter(s)} count={counts[s]} accent={m.accent}>
              <Icon size={11} /> {m.label}
            </FilterChip>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      <button onClick={onToggleAll} style={btnSecondary}>
        {expandedAny ? <><I.ChevronD size={12} style={{ transform: "rotate(180deg)" }} /> Zwiń wszystkie</> : <><I.ChevronD size={12} /> Rozwiń wszystkie</>}
      </button>
      {showEdit && (
        <button onClick={onAutoSuggest} style={{ ...btnSecondary, borderColor: "color-mix(in oklch, var(--anomaly) 40%, var(--border))", color: "var(--anomaly)" }}>
          <I.Wand size={12} /> Auto-sugestia
        </button>
      )}
      <button onClick={exportAll} style={btnSecondary}><I.ArrowUp size={12} /> Eksport</button>
      {showEdit && <button onClick={onNew} style={btnPrimary}><I.Plus size={12} /> Nowy kontener</button>}
    </div>
  );
}

function FilterChip({ children, active, onClick, count, accent }: { children: React.ReactNode; active: boolean; onClick: () => void; count: number; accent?: string }) {
  return (
    <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", background: active ? "var(--surface-3)" : "transparent", color: active ? (accent || "var(--text-hi)") : "var(--text-mid)", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 500, transition: "all 0.12s" }}>
      {children}
      <span className="num" style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 99, background: active ? "var(--accent-soft)" : "var(--surface-3)", color: active ? "var(--accent)" : "var(--text-lo)" }}>{count}</span>
    </button>
  );
}

// ── Karta kontenera ──────────────────────────────────────────
export function ContainerCard({
  container: c, expanded, onToggle, onEdit, onAdvance, onGeneratePO,
}: {
  container: Container; expanded: boolean; onToggle: () => void;
  onEdit: () => void; onAdvance: () => void; onGeneratePO?: () => void;
}) {
  const eStatus = eff(c);
  const meta = STATUS_FULL_META[eStatus] || STATUS_FULL_META.ORDERED;
  const showFin = can(useUser(), "viewFinancials");
  const Icon = meta.icon;
  const days = Math.ceil((new Date(c.eta_date).getTime() - Date.now()) / 86400000);
  const isDelivered = eStatus === "DELIVERED";
  const isCustoms = eStatus === "CUSTOMS";
  const isOverdue = days < 0 && !isDelivered && !isCustoms;
  // „Przenieś do…" działa na statusie RĘCZNYM (z bazy) — automat (odprawa/auto-dostawa) go nie dotyczy.
  const nextStatus = STATUS_FLOW[STATUS_FLOW.indexOf(c.status) + 1];
  const fill = c.fill_percentage ?? 0;
  const fillColor = fill > 100 ? "var(--critical)" : fill > 90 ? "var(--warning)" : fill > 70 ? "var(--ok)" : "var(--info)";
  const lots = c.lots ?? [];
  const consolidated = !!c.is_consolidated && lots.length > 0;

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden", transition: "border-color 0.12s" }}
      onMouseEnter={(e) => { if (!expanded) e.currentTarget.style.borderColor = "var(--border)"; }}
      onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.borderColor = "var(--border-soft)"; }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer", position: "relative", background: expanded ? "var(--surface-2)" : "transparent", transition: "background 0.12s", borderBottom: expanded ? "1px solid var(--border-soft)" : "none" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: meta.accent }} />
        <span style={{ color: "var(--text-lo)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.18s" }}><I.ChevronR size={14} /></span>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: meta.bg, color: meta.fg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={16} /></div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--text-hi)" }}>#{c.container_number}</span>
            {c.container_type_name && <Pill bg="var(--surface-3)" fg="var(--text-mid)" size="sm" mono>{c.container_type_name}</Pill>}
            {consolidated
              ? lots.map((l) => <MfrChip key={l.id} name={l.manufacturer_name || "— bez dostawcy —"} color={l.manufacturer_color ?? "var(--text-lo)"} />)
              : (c.manufacturer_id && c.manufacturer_name && <MfrChip name={c.manufacturer_name} color={c.manufacturer_color ?? "var(--text-lo)"} />)}
            {consolidated && <Pill bg="var(--accent-soft)" fg="var(--accent)" size="sm">skonsolidowany</Pill>}
            {c.is_auto && <Pill bg={meta.bg} fg={meta.fg} size="sm">{isCustoms ? "odprawa · auto" : "auto"}</Pill>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-lo)", marginTop: 4, flexWrap: "wrap" }}>
            {consolidated
              ? <span className="mono">{lots.map((l) => l.order_number || "—").join(" · ")}</span>
              : (c.order_number ? <span className="mono">PO: {c.order_number}</span> : <span style={{ color: "var(--text-disabled)" }}>bez PO</span>)}
            <span>·</span>
            <span><span className="num" style={{ color: "var(--text-mid)" }}>{c.items.length}</span> pozycji · <span className="num" style={{ color: "var(--text-mid)" }}>{c.total_units}</span> szt</span>
            <span>·</span>
            <span className="num" style={{ color: "var(--text-mid)" }}>{showFin ? fmtPLNk(c.total_value) : "•••"}</span>
          </div>
        </div>

        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>ETA</div>
          <div className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{new Date(c.eta_date).toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "2-digit" })}</div>
          <div className="num" style={{ fontSize: 11, color: isOverdue ? "var(--critical)" : isCustoms ? "var(--warning)" : "var(--text-lo)", fontWeight: (isOverdue || isCustoms) ? 600 : 400 }}>
            {isDelivered
              ? (c.is_auto ? "auto-dostawa" : "dostarczony")
              : isCustoms
                ? `odprawa · ${c.customs_days_left ?? 0}d do dostawy`
                : days < 0 ? `${Math.abs(days)}d temu` : days === 0 ? "dziś" : `za ${days}d`}
          </div>
        </div>

        {!expanded && (c.container_capacity_cbm ?? 0) > 0 && (
          <div style={{ width: 80, flexShrink: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-lo)", marginBottom: 3 }}>
              <span>CBM</span><span className="num">{fill}%</span>
            </div>
            <div style={{ height: 4, background: "var(--surface-3)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(100, fill)}%`, background: fillColor, transition: "width 0.3s" }} />
            </div>
          </div>
        )}
      </div>

      {expanded && <ContainerCardBody container={c} fillColor={fillColor} nextStatus={nextStatus} onEdit={onEdit} onAdvance={onAdvance} onGeneratePO={onGeneratePO} />}
    </div>
  );
}

function ContainerCardBody({
  container: c, fillColor, nextStatus, onEdit, onAdvance, onGeneratePO,
}: {
  container: Container; fillColor: string; nextStatus?: string;
  onEdit: () => void; onAdvance: () => void; onGeneratePO?: () => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const cap = c.container_capacity_cbm ?? 0;
  const fill = c.fill_percentage ?? 0;
  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }} className="fade-in">
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 18, alignItems: "flex-start" }} className="container-body-grid">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
          <DataCell label="Zamówiony" value={new Date(c.order_date).toLocaleDateString("pl-PL")} />
          <DataCell label="Pozycji" value={c.items.length} />
          <DataCell label="Sztuk" value={fmtNum(c.total_units)} />
          <DataCell label="Wartość" value={showFin ? fmtPLN(c.total_value) : "•••••"} />
          {cap > 0 && <DataCell label="CBM" value={`${c.total_cbm} / ${cap}`} sub={`${fill}% wypełnienia`} />}
        </div>
        <StatusTimeline current={eff(c)} />
      </div>

      {cap > 0 && (
        <div style={{ padding: "12px 14px", background: "var(--surface-2)", borderRadius: 8, border: "1px solid var(--border-soft)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Wypełnienie kontenera</span>
            <span className="num" style={{ fontSize: 16, fontWeight: 600, color: fillColor }}>{c.total_cbm} <span style={{ color: "var(--text-lo)", fontSize: 11 }}>/ {cap} m³ ·</span> <span style={{ color: "var(--text-hi)" }}>{fill}%</span></span>
          </div>
          <div style={{ height: 8, background: "var(--surface-3)", borderRadius: 99, overflow: "hidden", position: "relative" }}>
            <div style={{ height: "100%", width: `${Math.min(100, fill)}%`, background: fillColor, borderRadius: 99, transition: "width 0.3s" }} />
            {fill > 100 && <div style={{ position: "absolute", right: 4, top: -1, fontSize: 9, fontWeight: 700, color: "var(--critical)" }}>+{(fill - 100).toFixed(1)}% NADMIAR</div>}
          </div>
        </div>
      )}

      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Pozycje ({c.items.length})</div>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, overflow: "hidden" }}>
          {c.items.map((item, i) => {
            const itemCbm = (item.cbm_per_unit || 0) * item.quantity;
            const itemValue = (item.unit_cost || 0) * item.quantity;
            return (
              <div key={item.id} style={{ display: "grid", gridTemplateColumns: "140px minmax(0, 1fr) 70px 90px 100px", gap: 10, alignItems: "center", padding: "8px 12px", borderBottom: i === c.items.length - 1 ? "none" : "1px solid var(--border-soft)", fontSize: 12 }}>
                <span className="mono" style={{ fontWeight: 600, color: "var(--text-hi)" }}>{item.sku}</span>
                <span style={{ color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.product_name}</span>
                <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600, textAlign: "right" }}>×{item.quantity}</span>
                <span className="num" style={{ color: "var(--text-lo)", textAlign: "right" }}>{itemCbm.toFixed(3)} m³</span>
                <span className="num" style={{ color: "var(--text-mid)", textAlign: "right" }}>{showFin ? fmtPLN(itemValue) : "•••••"}</span>
              </div>
            );
          })}
        </div>
      </div>

      {c.attachments && c.attachments.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><I.External size={11} /> Załączniki ({c.attachments.length})</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {c.attachments.map((att) => {
              const isPdf = att.file_type === "pdf";
              return (
                <button key={att.id} type="button" onClick={() => download(`/attachments/${att.id}/download`, att.filename).catch(() => toast("Nie udało się pobrać pliku", "warning"))}
                  title="Pobierz plik" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 6, fontSize: 11, color: "var(--text-mid)", cursor: "pointer" }}>
                  <span className="mono" style={{ padding: "0 4px", fontSize: 9, fontWeight: 700, background: isPdf ? "var(--critical-soft)" : "var(--ok-soft)", color: isPdf ? "var(--critical)" : "var(--ok)", borderRadius: 3 }}>{(att.file_type || "?").toUpperCase()}</span>
                  <span style={{ textDecoration: "underline" }}>{att.filename}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {c.notes && (
        <div style={{ padding: "10px 12px", background: "var(--surface-2)", border: "1px dashed var(--border-soft)", borderRadius: 8, fontSize: 12, color: "var(--text-mid)", fontStyle: "italic" }}>{c.notes}</div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {c.is_auto ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-lo)" }}>
              <I.Customs size={12} style={{ color: "var(--warning)" }} />
              {eff(c) === "CUSTOMS"
                ? `Status liczony automatycznie z ETA — auto-dostawa za ${c.customs_days_left ?? 0} dni`
                : "Status liczony automatycznie z ETA (po oknie odprawy)"}
            </span>
          ) : (showEdit && nextStatus && (
            <button onClick={onAdvance} style={{ ...btnSecondary, color: STATUS_FULL_META[nextStatus].fg, borderColor: "color-mix(in oklch, " + STATUS_FULL_META[nextStatus].accent + " 40%, var(--border))" }}>
              <I.ArrowRight size={12} /> Przenieś do „{STATUS_FULL_META[nextStatus].label}"
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {onGeneratePO && (
            <button onClick={onGeneratePO} style={{ ...btnSecondary, color: "var(--accent)", borderColor: "color-mix(in oklch, var(--accent) 40%, var(--border))" }}><I.External size={12} /> Generuj PO</button>
          )}
          <button onClick={onEdit} style={btnPrimary}><I.Settings size={12} /> {showEdit ? "Edytuj kontener" : "Pokaż szczegóły"}</button>
        </div>
      </div>

      <style>{`@media (max-width: 720px) { .container-body-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function DataCell({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 7 }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function StatusTimeline({ current }: { current: string }) {
  const currentIdx = TIMELINE_FLOW.indexOf(current);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
      {TIMELINE_FLOW.map((s, i) => {
        const meta = STATUS_FULL_META[s];
        const Icon = meta.icon;
        const reached = i <= currentIdx;
        const active = i === currentIdx;
        return (
          <React.Fragment key={s}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ width: 28, height: 28, borderRadius: 99, background: reached ? meta.bg : "var(--surface-2)", color: reached ? meta.fg : "var(--text-disabled)", display: "flex", alignItems: "center", justifyContent: "center", border: active ? `2px solid ${meta.accent}` : "1px solid var(--border-soft)", transition: "all 0.2s" }}>
                <Icon size={12} />
              </div>
              <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: reached ? (active ? meta.fg : "var(--text-mid)") : "var(--text-disabled)", textAlign: "center", whiteSpace: "nowrap" }}>{meta.label}</span>
            </div>
            {i < TIMELINE_FLOW.length - 1 && (
              <div style={{ width: 18, height: 2, background: i < currentIdx ? STATUS_FULL_META[TIMELINE_FLOW[i + 1]].accent : "var(--surface-2)", marginTop: -14, transition: "background 0.2s" }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
