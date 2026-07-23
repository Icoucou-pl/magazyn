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

// ── Formatery walut/dat kontenerów (płatności per lot: USD/CNY) ──
const CUR_SYM: Record<string, string> = { USD: "$", CNY: "¥", EUR: "€", PLN: "zł" };
const fmtCur = (n?: number | null, cur = "USD"): string => {
  if (n == null) return "—";
  const v = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(n);
  const sym = CUR_SYM[cur] || cur;
  return cur === "PLN" ? `${v} ${sym}` : `${sym}${v}`;
};
const fmtDatePL = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleDateString("pl-PL") : "—";

// ── Typy ─────────────────────────────────────────────────────
export type ContainerItem = {
  id: number; sku: string; quantity: number; unit_cost: number | null;
  lot_id?: number | null;
  product_name: string | null; cbm_per_unit: number; total_cbm: number;
};
export type ContainerAdvance = {
  id?: number;
  procent?: number | null;
  kwota?: number | null;
  waluta?: string | null;
  data?: string | null;
};
// Udział firmy w kontenerze/locie — kontener nie ma własnej firmy, wynika ona
// z właścicieli SKU (app_product_attrs.firma_id), liczona po stronie backendu.
export type FirmaShare = { slug: string; name: string; color?: string | null; units: number; value: number };

export type ContainerLot = {
  id: number;
  firma_breakdown?: Record<string, FirmaShare>;
  manufacturer_id: number | null;
  manufacturer_name: string | null;
  manufacturer_color: string | null;
  order_number: string | null;
  waluta_towaru?: string | null;
  advances?: ContainerAdvance[] | null;
  zaliczka_procent?: number | null;
  zaliczka_kwota?: number | null;
  zaliczka_waluta?: string | null;
  zaliczka_data?: string | null;
  balance_kwota?: number | null;
  balance_waluta?: string | null;
  zaplacono_data?: string | null;
  subiekt_wbite?: boolean | null;
  subiekt_wbite_at?: string | null;
  total_units: number; total_cbm: number; total_value: number;
};
export type Attachment = { id: number; filename: string; file_type: string | null; file_size: string | null; uploaded_at: string };
export type Container = {
  id: number;
  firma_breakdown?: Record<string, FirmaShare>;
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
  koszt_transportu?: number | null;
  koszt_spedycji?: number | null;
  oplata_spedycji?: number | null;
  koszt_transportu_magazyn?: number | null;   // PLN — z portu do magazynu
  folder?: string | null;
  subiekt_nr?: string | null;
  waluta_towaru?: string | null;
  advances?: ContainerAdvance[] | null;
  zaliczka_procent?: number | null;
  zaliczka_kwota?: number | null;
  zaliczka_waluta?: string | null;
  zaliczka_data?: string | null;
  balance_kwota?: number | null;
  balance_waluta?: string | null;
  zaplacono_data?: string | null;
  subiekt_wbite?: boolean | null;
  subiekt_wbite_at?: string | null;
  delivered_date?: string | null;              // ręczna, potwierdzona data dostawy
  expected_delivery_date?: string | null;      // „u nas" — umówiona data odbioru (nie domyka statusu)
  warehouse_delivery_date?: string | null;     // KPI: delivered_date → expected_delivery_date → ETA + odprawa
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
  DELIVERED: { label: "Dostarczone", icon: I.Container, fg: "var(--ok)", bg: "var(--ok-soft)", accent: "var(--ok)" },
};

// Status do wyświetlenia: efektywny z backendu, a gdy go brak — ręczny.
export const eff = (c: { effective_status?: string; status: string }): string => c.effective_status || c.status;

// ── Mini stat ────────────────────────────────────────────────
// Klikalny wariant: podaj onClick + accent (kolor liczby i ramki) + hint (podpowiedź w stopce).
// Bez tych propsów zachowuje się dokładnie jak dotąd — zwykły, nieklikalny kafelek.
export function MiniStat({ label, value, sub, icon, onClick, accent, hint }: {
  label: string; value: React.ReactNode; sub?: string; icon?: React.ReactNode;
  onClick?: () => void; accent?: string; hint?: string;
}) {
  const clickable = typeof onClick === "function";
  const idle = accent ? `color-mix(in oklch, ${accent} 30%, var(--border-soft))` : "var(--border-soft)";
  const body = (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
        {icon && <span style={{ color: accent || "var(--text-lo)" }}>{icon}</span>}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 600, color: accent || "var(--text-hi)", marginTop: 4, letterSpacing: "-0.02em" }}>{value}</div>
      {(sub || (clickable && hint)) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
          <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{sub}</span>
          {clickable && hint && <span style={{ fontSize: 10, fontWeight: 700, color: accent || "var(--text-mid)", whiteSpace: "nowrap" }}>{hint}</span>}
        </div>
      )}
    </>
  );
  const base: React.CSSProperties = {
    padding: "12px 14px", background: "var(--surface-1)",
    border: `1px solid ${clickable ? idle : "var(--border-soft)"}`,
    borderRadius: "var(--r-lg)",
  };
  if (!clickable) return <div style={base}>{body}</div>;
  return (
    <button onClick={onClick} style={{ ...base, textAlign: "left", width: "100%", cursor: "pointer", transition: "all 0.14s ease" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; e.currentTarget.style.borderColor = accent || "var(--border-strong)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--surface-1)"; e.currentTarget.style.borderColor = idle; }}>
      {body}
    </button>
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

// ── Kropka „dodano do Subiektu" (magazyn w drodze) ───────────
// Zielony = wbite do magazynu „w drodze" w Subiekcie (liczony stamtąd), czerwony = jeszcze
// tylko w apce (liczony z kontenera). Mieszany = część lotów wbita. null dla dostarczonych.
export function subiektSummary(c: Container): "green" | "red" | "mixed" | null {
  if (eff(c) === "DELIVERED") return null;
  const lots = c.lots ?? [];
  if (c.is_consolidated && lots.length > 0) {
    const green = lots.filter((l) => !!l.subiekt_wbite).length;
    if (green === 0) return "red";
    if (green === lots.length) return "green";
    return "mixed";
  }
  return c.subiekt_wbite ? "green" : "red";
}

const SUBIEKT_META = {
  green: { color: "var(--ok)", label: "w Subiekcie (magazyn w drodze)" },
  red: { color: "var(--critical)", label: "jeszcze w apce (kontener)" },
  mixed: { color: "var(--warning)", label: "część w Subiekcie, część w apce" },
} as const;

export function SubiektDot({ state, onClick, size = 10 }: { state: "green" | "red" | "mixed"; onClick?: () => void; size?: number }) {
  const meta = SUBIEKT_META[state];
  const clickable = !!onClick;
  return (
    <span
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      title={meta.label + (clickable ? " — kliknij, by zmienić" : "")}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size + 6, height: size + 6, cursor: clickable ? "pointer" : "default", flexShrink: 0 }}>
      <span style={{ width: size, height: size, borderRadius: 99, background: meta.color, boxShadow: `0 0 0 2px color-mix(in oklch, ${meta.color} 22%, transparent)` }} />
    </span>
  );
}

// Przełącznik iOS-style: lewo/czerwony = w apce (kontener), prawo/zielony = w Subiekcie (magazyn w drodze).
export function SubiektSwitch({ on, onToggle, disabled }: { on: boolean; onToggle?: () => void; disabled?: boolean }) {
  const clickable = !!onToggle && !disabled;
  return (
    <button
      type="button"
      onClick={clickable ? (e) => { e.stopPropagation(); onToggle!(); } : undefined}
      disabled={!clickable}
      title={on ? "w Subiekcie (magazyn w drodze) — kliknij, by cofnąć" : "w apce (kontener) — kliknij, gdy wbite do Subiektu"}
      style={{
        position: "relative", width: 40, height: 22, borderRadius: 999, border: "none", padding: 0,
        background: on ? "var(--ok)" : "var(--critical)",
        opacity: clickable ? 1 : 0.55, cursor: clickable ? "pointer" : "default",
        transition: "background 0.18s", flexShrink: 0,
      }}>
      <span style={{
        position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: "50%",
        background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.35)", transition: "left 0.18s",
      }} />
    </button>
  );
}

// ── Karta kontenera ──────────────────────────────────────────
export function ContainerCard({
  container: c, expanded, onToggle, onEdit, onAdvance, onGeneratePO, onSetDelivered, onToggleSubiekt,
}: {
  container: Container; expanded: boolean; onToggle: () => void;
  onEdit: () => void; onAdvance: () => void; onGeneratePO?: () => void;
  onSetDelivered?: (d: string | null) => Promise<void>;
  onToggleSubiekt?: (lotId: number | null, value: boolean) => Promise<void> | void;
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
  const subiektSt = subiektSummary(c);
  // Druga data pod ETA: potwierdzona dostawa wygrywa, inaczej umówiony odbiór („u nas").
  // Sam automat (ETA + okno odprawy) tu nie wchodzi — to szacunek, jest w rozwinięciu karty.
  const arrival = c.delivered_date
    ? { label: "Dostarczono", date: c.delivered_date, color: "var(--ok)" }
    : c.expected_delivery_date
      ? { label: "U nas", date: c.expected_delivery_date, color: "var(--info)" }
      : null;

  return (
    <div style={{
        background: "var(--surface-1)",
        border: `1px solid ${expanded ? `color-mix(in oklch, ${meta.accent} 45%, var(--border))` : "var(--border-soft)"}`,
        borderRadius: "var(--r-lg)",
        overflow: "hidden",
        transition: "border-color 0.14s, box-shadow 0.14s",
        boxShadow: expanded ? `0 10px 30px -12px color-mix(in oklch, ${meta.accent} 42%, transparent)` : "none",
        position: "relative",
        zIndex: expanded ? 1 : 0,
      }}
      onMouseEnter={(e) => { if (!expanded) e.currentTarget.style.borderColor = "var(--border)"; }}
      onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.borderColor = "var(--border-soft)"; }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer", position: "relative", background: expanded ? "var(--surface-2)" : "transparent", transition: "background 0.12s", borderBottom: expanded ? "1px solid var(--border-soft)" : "none" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: meta.accent }} />
        <span style={{ color: "var(--text-lo)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.18s" }}><I.ChevronR size={14} /></span>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: meta.bg, color: meta.fg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={16} /></div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--text-hi)" }}>#{c.container_number}</span>
            {subiektSt && <SubiektDot state={subiektSt} />}
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
          {arrival && (
            <div style={{ marginTop: 3, paddingTop: 3, borderTop: "1px solid var(--border-soft)" }}>
              <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{arrival.label}</div>
              <div className="num" style={{ fontSize: 12, fontWeight: 600, color: arrival.color }}>{fmtDatePL(arrival.date)}</div>
            </div>
          )}
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

      {expanded && <ContainerCardBody container={c} fillColor={fillColor} nextStatus={nextStatus} onEdit={onEdit} onAdvance={onAdvance} onGeneratePO={onGeneratePO} onSetDelivered={onSetDelivered} onToggleSubiekt={onToggleSubiekt} />}
    </div>
  );
}

function ContainerCardBody({
  container: c, fillColor, nextStatus, onEdit, onAdvance, onGeneratePO, onSetDelivered, onToggleSubiekt,
}: {
  container: Container; fillColor: string; nextStatus?: string;
  onEdit: () => void; onAdvance: () => void; onGeneratePO?: () => void;
  onSetDelivered?: (d: string | null) => Promise<void>;
  onToggleSubiekt?: (lotId: number | null, value: boolean) => Promise<void> | void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const cap = c.container_capacity_cbm ?? 0;
  const fill = c.fill_percentage ?? 0;
  const lots = c.lots ?? [];
  const consolidated = !!c.is_consolidated && lots.length > 0;
  const isDelivered = eff(c) === "DELIVERED";
  // Sekcje finansowe są teraz zawsze widoczne po rozwinięciu (przy showFin) — bez chowania gdy brak danych.
  const showDocs = showFin || !!c.folder || !!c.subiekt_nr;
  const sectionLabelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 };
  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }} className="fade-in">
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 18, alignItems: "flex-start" }} className="container-body-grid">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
          <DataCell label="Zamówiony" value={new Date(c.order_date).toLocaleDateString("pl-PL")} />
          <DataCell label="Pozycji" value={c.items.length} />
          <DataCell label="Sztuk" value={fmtNum(c.total_units)} />
          <DataCell label="Wartość" value={showFin ? fmtPLN(c.total_value) : "•••••"} />
          {cap > 0 && <DataCell label="CBM" value={`${c.total_cbm} / ${cap}`} sub={`${fill}% wypełnienia`} />}
          <DeliveryCell c={c} editable={showEdit && !!onSetDelivered} onSet={onSetDelivered ?? (async () => {})} />
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

      {!isDelivered && (
        <div>
          <div style={sectionLabelStyle}>Magazyn w drodze (Subiekt)</div>
          <div style={{ background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 4 }}>
            {consolidated ? lots.map((l) => (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px" }}>
                <SubiektSwitch on={!!l.subiekt_wbite} onToggle={showEdit && onToggleSubiekt ? () => onToggleSubiekt(l.id, !l.subiekt_wbite) : undefined} disabled={!showEdit} />
                <MfrChip name={l.manufacturer_name || "— bez dostawcy —"} color={l.manufacturer_color ?? "var(--text-lo)"} />
                {l.order_number && <span className="mono" style={{ fontSize: 11, color: "var(--text-lo)" }}>PO: {l.order_number}</span>}
                <span style={{ marginLeft: "auto", fontSize: 11, color: l.subiekt_wbite ? "var(--ok)" : "var(--text-lo)" }}>
                  {l.subiekt_wbite ? `w Subiekcie${l.subiekt_wbite_at ? ` · ${fmtDatePL(l.subiekt_wbite_at)}` : ""}` : "w apce (kontener)"}
                </span>
              </div>
            )) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px" }}>
                <SubiektSwitch on={!!c.subiekt_wbite} onToggle={showEdit && onToggleSubiekt ? () => onToggleSubiekt(null, !c.subiekt_wbite) : undefined} disabled={!showEdit} />
                <span style={{ fontSize: 12, color: "var(--text-mid)" }}>
                  {c.subiekt_wbite ? `Wbite do magazynu „w drodze"${c.subiekt_wbite_at ? ` · ${fmtDatePL(c.subiekt_wbite_at)}` : ""}` : "Jeszcze w apce — liczone z kontenera"}
                </span>
              </div>
            )}
          </div>
          {showEdit && <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>Kliknij kropkę, gdy towar zostanie wbity do magazynu „w drodze" w Subiekcie (czerwona → zielona).</div>}
        </div>
      )}

      {showDocs && (
        <div>
          <div style={sectionLabelStyle}>Spedycja i dokumenty</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
            {showFin && <MoneyCell label="Koszt transportu" value={fmtCur(c.koszt_transportu, "USD")} />}
            {showFin && <MoneyCell label="Koszt spedycji" value={fmtCur(c.koszt_spedycji, "USD")} />}
            {showFin && <MoneyCell label="Opłata spedycji" value={fmtCur(c.oplata_spedycji, "USD")} sub="rachunek − transport" muted />}
            {showFin && <MoneyCell label="Transport do magazynu" value={fmtCur(c.koszt_transportu_magazyn, "PLN")} sub="port → magazyn" />}
            <MoneyCell label="Folder" value={c.folder || "—"} />
            <MoneyCell label="Subiekt" value={c.subiekt_nr || "—"} />
          </div>
        </div>
      )}

      {showFin && (consolidated ? (
        <div>
          <div style={sectionLabelStyle}>Płatności — loty</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {lots.map((l) => (
              <div key={l.id} style={{ padding: "10px 12px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <MfrChip name={l.manufacturer_name || "— bez dostawcy —"} color={l.manufacturer_color ?? "var(--text-lo)"} />
                  {l.order_number && <span className="mono" style={{ fontSize: 11, color: "var(--text-lo)" }}>PO: {l.order_number}</span>}
                </div>
                <PaymentBlock
                  advances={advancesOf(l)}
                  bCur={l.balance_waluta || l.waluta_towaru || "USD"}
                  balance={l.balance_kwota} zaplacono={l.zaplacono_data} showFin={showFin}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <div style={sectionLabelStyle}>Płatność</div>
          <PaymentBlock
            advances={advancesOf(c)}
            bCur={c.balance_waluta || c.waluta_towaru || "USD"}
            balance={c.balance_kwota} zaplacono={c.zaplacono_data} showFin={showFin}
          />
        </div>
      ))}

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

// KPI „Dostawa na magazyn" — data wejścia towaru do magazynu.
//   • potwierdzona = ręcznie wpisana (delivered_date) → zielona, domyka status kontenera;
//   • auto · szac. = wyliczona z ETA + okno odprawy celnej (gdy nikt nie klika „dostarczono").
//   Edytowalna (dla ról z edycją): klik → date-picker; zapis potwierdza i domyka kontener.
function DeliveryCell({ c, editable, onSet }: { c: Container; editable: boolean; onSet: (d: string | null) => Promise<void> }) {
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const confirmed = !!c.delivered_date;
  const expected = !confirmed && !!c.expected_delivery_date;
  const whd = c.warehouse_delivery_date || c.delivered_date || null;

  const open = () => { setVal(c.delivered_date || c.warehouse_delivery_date || ""); setEditing(true); };
  const save = async () => {
    if (!val) return;
    setSaving(true);
    try { await onSet(val); setEditing(false); } catch { /* toast w rodzicu */ } finally { setSaving(false); }
  };
  const clear = async () => {
    setSaving(true);
    try { await onSet(null); setEditing(false); } catch { /* toast w rodzicu */ } finally { setSaving(false); }
  };

  if (editing) {
    return (
      <div style={{ padding: "8px 10px", background: "var(--surface-2)", border: "1px solid var(--accent)", borderRadius: 7, gridColumn: "1 / -1" }}>
        <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Dostawa na magazyn</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input type="date" value={val} onChange={(e) => setVal(e.target.value)} disabled={saving}
            style={{ fontSize: 12, padding: "5px 8px", background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-hi)" }} />
          <button onClick={save} disabled={saving || !val} style={{ ...btnPrimary, padding: "5px 12px", fontSize: 11, opacity: (saving || !val) ? 0.55 : 1 }}>Zapisz</button>
          {confirmed && <button onClick={clear} disabled={saving} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 11 }}>Wyczyść</button>}
          <button onClick={() => setEditing(false)} disabled={saving} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 11 }}>Anuluj</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 6 }}>Wpis potwierdza dostawę i domyka kontener (status „Dostarczone").</div>
      </div>
    );
  }

  return (
    <div onClick={editable ? open : undefined} title={editable ? "Kliknij, aby ustawić datę dostawy" : undefined}
      style={{ padding: "8px 10px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 7, cursor: editable ? "pointer" : "default" }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 4 }}>
        Dostawa na magazyn {editable && <I.Calendar size={9} style={{ color: "var(--text-disabled)" }} />}
      </div>
      <div className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)", marginTop: 2 }}>{fmtDatePL(whd)}</div>
      <div style={{ fontSize: 10, marginTop: 1, fontWeight: (confirmed || expected) ? 600 : 400, color: confirmed ? "var(--ok)" : expected ? "var(--info)" : "var(--text-lo)" }}>
        {confirmed ? "potwierdzona" : expected ? "umówiona · u nas" : "auto · szac."}
      </div>
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

function MoneyCell({ label, value, sub, muted }: { label: string; value: React.ReactNode; sub?: string; muted?: boolean }) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 7 }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div className="num" style={{ fontSize: 13, fontWeight: 600, color: muted ? "var(--text-mid)" : "var(--text-hi)", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// Zaliczki do wyświetlenia: z nowego pola `advances`, a gdy puste — fallback na legacy
// pojedynczą zaliczkę (dane sprzed migracji).
function advancesOf(src: {
  waluta_towaru?: string | null; advances?: ContainerAdvance[] | null;
  zaliczka_procent?: number | null; zaliczka_kwota?: number | null; zaliczka_waluta?: string | null; zaliczka_data?: string | null;
}): ContainerAdvance[] {
  if (src.advances && src.advances.length) return src.advances;
  if (src.zaliczka_kwota != null || src.zaliczka_data || src.zaliczka_procent != null) {
    return [{ procent: src.zaliczka_procent, kwota: src.zaliczka_kwota, waluta: src.zaliczka_waluta || src.waluta_towaru || "USD", data: src.zaliczka_data }];
  }
  return [];
}

function PaymentBlock({ advances, bCur, balance, zaplacono, showFin }: {
  advances: ContainerAdvance[]; bCur: string;
  balance?: number | null; zaplacono?: string | null; showFin: boolean;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
      {advances.length === 0 && (
        <MoneyCell label="Zaliczka" value={showFin ? "—" : "•••••"} sub="brak" muted />
      )}
      {advances.map((a, i) => {
        const cur = a.waluta || "USD";
        return (
          <MoneyCell
            key={a.id ?? i}
            label={`Zaliczka ${i + 1}${a.procent != null ? ` · ${fmtNum(a.procent)}%` : ""}`}
            value={showFin ? fmtCur(a.kwota, cur) : "•••••"}
            sub={a.data ? `wpł. ${fmtDatePL(a.data)} · ${cur}` : `plan · ${cur}`}
          />
        );
      })}
      <MoneyCell label="Balance" value={showFin ? fmtCur(balance, bCur) : "•••••"} sub={`waluta: ${bCur}`} />
      <MoneyCell label="Zapłacono" value={fmtDatePL(zaplacono)} muted />
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
