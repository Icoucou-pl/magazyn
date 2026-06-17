"use client";
// ============================================================
// MAGAZYN — Cashflow (etap 4B). Port cashflow.jsx → .tsx.
//   Prognoza płatności za kontenery — 12 miesięcy, w PLN.
//   Wariant A: liczone po stronie frontu z GET /containers
//   (total_value kontenera jest już w PLN → bez przeliczania walut).
//   MOCK.manufacturers → nazwa/kolor brane wprost z pól kontenera.
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, Card, CardHeader, MfrChip } from "./ui";
import { MiniStat, STATUS_FULL_META } from "./containers-ui";
import { btnSecondary } from "./products-ui";
import { api } from "@/lib/api";
import { toast, exportCsv, type CsvColumn } from "./toast";
import { fmtPLN, fmtPLNk } from "@/lib/format";

// ── Typy ─────────────────────────────────────────────────────
type Container = {
  id: number;
  container_number: string;
  order_number?: string | null;
  manufacturer_id: number | null;
  manufacturer_name: string | null;
  manufacturer_color: string | null;
  eta_date: string; // 'YYYY-MM-DD'
  status: string;
  total_value: number;
};

type CashMonth = {
  key: string;
  label: string;
  shortLabel: string;
  year: number;
  month: number; // 0–11
  date: Date;
  total: number;
  containers: Container[];
  byMfr: Record<number, number>; // manufacturer_id → suma
};

type Cashflow = {
  months: CashMonth[];
  byMfr: Record<number, number>;
  total: number;
  containerCount: number;
  avgPerMonth: number;
  peakMonth: CashMonth;
  next30: number;
  next30Count: number;
};

type MfrInfo = { name: string; color: string };
type MfrMap = Record<number, MfrInfo>;

const MONTH_SHORT = ["Sty","Lut","Mar","Kwi","Maj","Cze","Lip","Sie","Wrz","Paź","Lis","Gru"];

// Parsuj 'YYYY-MM-DD' jako lokalną północ (domyślny new Date() bierze UTC → off-by-one wieczorem)
const parseLocal = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

// ── Budowa danych cashflow ───────────────────────────────────
function buildCashflow(containers: Container[]): Cashflow {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const startMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const months: CashMonth[] = [];
  for (let i = 0; i < 12; i++) {
    const date = new Date(startMonth.getFullYear(), startMonth.getMonth() + i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    months.push({
      key,
      label: `${MONTH_SHORT[date.getMonth()]} ${date.getFullYear()}`,
      shortLabel: MONTH_SHORT[date.getMonth()],
      year: date.getFullYear(),
      month: date.getMonth(),
      date,
      total: 0,
      containers: [],
      byMfr: {},
    });
  }

  // Przypisz każdy kontener do miesiąca jego ETA
  containers.forEach(c => {
    if (c.status === "DELIVERED") return; // dostarczone = już opłacone
    const eta = parseLocal(c.eta_date);
    const key = `${eta.getFullYear()}-${String(eta.getMonth() + 1).padStart(2, "0")}`;
    const m = months.find(x => x.key === key);
    if (!m) return;
    m.total += c.total_value;
    m.containers.push(c);
    if (c.manufacturer_id != null) {
      m.byMfr[c.manufacturer_id] = (m.byMfr[c.manufacturer_id] || 0) + c.total_value;
    }
  });

  // Agregacja per producent (cały horyzont)
  const byMfr: Record<number, number> = {};
  containers.forEach(c => {
    if (c.status === "DELIVERED") return;
    if (c.manufacturer_id == null) return;
    byMfr[c.manufacturer_id] = (byMfr[c.manufacturer_id] || 0) + c.total_value;
  });

  const total = months.reduce((s, m) => s + m.total, 0);
  const containerCount = months.reduce((s, m) => s + m.containers.length, 0);
  const activeMonths = months.filter(m => m.total > 0).length;
  const avgPerMonth = activeMonths > 0 ? total / activeMonths : 0;

  // Najbliższe 30 dni
  const day30 = new Date(today); day30.setDate(day30.getDate() + 30);
  const next30Containers = containers.filter(c => {
    if (c.status === "DELIVERED") return false;
    const eta = parseLocal(c.eta_date);
    return eta >= today && eta <= day30;
  });
  const next30 = next30Containers.reduce((s, c) => s + c.total_value, 0);

  // Miesiąc szczytowy
  const peakMonth = months.reduce((peak, m) => (m.total > peak.total ? m : peak), months[0]);

  return { months, byMfr, total, containerCount, avgPerMonth, peakMonth, next30, next30Count: next30Containers.length };
}

// Mapa producentów (id → nazwa/kolor) z pól kontenerów
function buildMfrMap(containers: Container[]): MfrMap {
  const map: MfrMap = {};
  containers.forEach(c => {
    if (c.manufacturer_id != null && c.manufacturer_name && !map[c.manufacturer_id]) {
      map[c.manufacturer_id] = { name: c.manufacturer_name, color: c.manufacturer_color || "var(--text-lo)" };
    }
  });
  return map;
}

// ── Widok główny ─────────────────────────────────────────────
function CashflowView({ onContainerClick }: { onContainerClick?: (c: Container) => void }) {
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredMfr, setHoveredMfr] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await api.get("/containers");
        if (mounted) setContainers(Array.isArray(data) ? (data as Container[]) : []);
      } catch {
        if (mounted) { setContainers([]); toast("Nie udało się pobrać kontenerów", "error"); }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const cashflow = useMemo(() => buildCashflow(containers), [containers]);
  const mfrMap = useMemo(() => buildMfrMap(containers), [containers]);
  const maxTotal = Math.max(...cashflow.months.map(m => m.total), 1);

  if (loading) {
    return (
      <div className="fade-in" style={{ padding: 48, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
        Ładowanie…
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 80 }}>

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <MiniStat label="Suma wydatków"       value={fmtPLNk(cashflow.total)}          sub={`${cashflow.containerCount} kontenerów`} icon={<I.Wallet size={14}/>}/>
        <MiniStat label="Najbliższe 30 dni"   value={fmtPLNk(cashflow.next30)}         sub={`${cashflow.next30Count} płatności`}     icon={<I.Alert size={14}/>}/>
        <MiniStat label="Średnio / miesiąc"   value={fmtPLNk(cashflow.avgPerMonth)}    sub="aktywne miesiące"                        icon={<I.Activity size={14}/>}/>
        <MiniStat label="Największa płatność"  value={fmtPLNk(cashflow.peakMonth.total)} sub={cashflow.peakMonth.label}               icon={<I.TrendUp size={14}/>}/>
      </div>

      {/* Per-manufacturer breakdown */}
      <Card>
        <CardHeader
          icon={<I.Factory size={14}/>}
          title="Wydatki wg producenta"
          hint="kolory pojawiają się w słupkach miesięcznych poniżej"
        />
        <div style={{ padding: "14px 18px" }}>
          <MfrBreakdown breakdown={cashflow.byMfr} total={cashflow.total} hovered={hoveredMfr} setHovered={setHoveredMfr} mfrMap={mfrMap}/>
        </div>
      </Card>

      {/* Monthly forecast bars */}
      <Card>
        <CardHeader
          icon={<I.Wallet size={14}/>}
          title="Prognoza wydatków — 12 miesięcy"
          hint="kontener zaliczany do miesiąca ETA"
          action={
            <button onClick={() => {
              const cols: CsvColumn<CashMonth>[] = [
                { key: "label", label: "Miesiac" },
                { key: "total", label: "Suma (PLN)" },
                { label: "Kontenery", get: (m) => m.containers.length },
                { label: "Numery", get: (m) => m.containers.map(c => c.container_number).join(", ") },
              ];
              exportCsv("cashflow", cols, cashflow.months);
            }} style={btnSecondary}><I.ArrowUp size={12}/> Eksport</button>
          }
        />
        <div style={{ padding: "14px 4px 14px 0" }}>
          <MonthlyChart months={cashflow.months} maxTotal={maxTotal} hoveredMfr={hoveredMfr} mfrMap={mfrMap}/>
        </div>
      </Card>

      {/* Per-month container drilldown */}
      <Card>
        <CardHeader
          icon={<I.Calendar size={14}/>}
          title="Szczegóły miesięczne"
          hint="kliknij kontener aby otworzyć"
        />
        <div>
          {cashflow.months.filter(m => m.containers.length > 0).length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
              Brak zaplanowanych płatności
            </div>
          ) : cashflow.months.filter(m => m.containers.length > 0).map((m, i, arr) => (
            <MonthRow key={m.key} month={m} maxTotal={maxTotal} hoveredMfr={hoveredMfr}
              onContainerClick={onContainerClick} mfrMap={mfrMap}
              isLast={i === arr.length - 1}/>
          ))}
        </div>
      </Card>
    </div>
  );
}

// --- Per-manufacturer breakdown (poziomy pasek + chipy) ------
function MfrBreakdown({ breakdown, total, hovered, setHovered, mfrMap }: {
  breakdown: Record<number, number>; total: number;
  hovered: number | null; setHovered: (id: number | null) => void; mfrMap: MfrMap;
}) {
  const items = Object.entries(breakdown)
    .map(([id, value]) => {
      const nid = Number(id);
      return { id: nid, value, mfr: mfrMap[nid], pct: total > 0 ? (value / total) * 100 : 0 };
    })
    .filter(x => x.mfr)
    .sort((a, b) => b.value - a.value);

  if (items.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-lo)" }}>Brak kontenerów z przypisanym producentem</div>;
  }

  return (
    <div>
      {/* Stacked bar */}
      <div style={{ display: "flex", height: 12, borderRadius: 99, overflow: "hidden", background: "var(--surface-2)", marginBottom: 14 }}>
        {items.map(it => (
          <div key={it.id}
            onMouseEnter={() => setHovered(it.id)}
            onMouseLeave={() => setHovered(null)}
            style={{
              width: `${it.pct}%`,
              background: it.mfr.color,
              opacity: hovered != null && hovered !== it.id ? 0.3 : 1,
              transition: "opacity 0.16s",
              cursor: "pointer",
            }}
            title={`${it.mfr.name}: ${fmtPLN(it.value)} (${it.pct.toFixed(1)}%)`}/>
        ))}
      </div>

      {/* Legend chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {items.map(it => (
          <button key={it.id}
            onMouseEnter={() => setHovered(it.id)}
            onMouseLeave={() => setHovered(null)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "6px 10px",
              background: hovered === it.id ? "color-mix(in oklch, " + it.mfr.color + " 15%, var(--surface-2))" : "var(--surface-2)",
              border: `1px solid ${hovered === it.id ? it.mfr.color : "var(--border-soft)"}`,
              borderRadius: 7,
              transition: "all 0.12s",
              cursor: "pointer",
            }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: it.mfr.color, flexShrink: 0 }}/>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-hi)" }}>{it.mfr.name}</span>
            <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>
              {fmtPLNk(it.value)} <span style={{ opacity: 0.7 }}>· {it.pct.toFixed(0)}%</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Monthly stacked bar chart -------------------------------
function MonthlyChart({ months, maxTotal, hoveredMfr, mfrMap }: {
  months: CashMonth[]; maxTotal: number; hoveredMfr: number | null; mfrMap: MfrMap;
}) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  return (
    <div style={{ position: "relative" }}>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 8,
        padding: "0 18px", alignItems: "flex-end", minHeight: 200, height: 220,
      }}>
        {months.map(m => {
          const isCurrent = m.key === todayKey;
          const heightPct = (m.total / maxTotal) * 100;
          const segments = Object.entries(m.byMfr)
            .map(([id, val]) => {
              const nid = Number(id);
              return { id: nid, val, mfr: mfrMap[nid], pct: m.total > 0 ? (val / m.total) * 100 : 0 };
            })
            .filter(s => s.mfr)
            .sort((a, b) => a.id - b.id);

          return (
            <div key={m.key} style={{
              display: "flex", flexDirection: "column", alignItems: "stretch",
              height: "100%", justifyContent: "flex-end", position: "relative",
            }}>
              {m.total > 0 && (
                <div className="num" style={{
                  fontSize: 10, fontWeight: 600,
                  color: isCurrent ? "var(--accent)" : "var(--text-mid)",
                  textAlign: "center", marginBottom: 4,
                }}>
                  {fmtPLNk(m.total)}
                </div>
              )}
              <div style={{
                height: m.total > 0 ? `${heightPct}%` : 4,
                minHeight: 4,
                background: m.total === 0 ? "var(--surface-2)" : "transparent",
                borderRadius: 6,
                display: "flex", flexDirection: "column-reverse",
                overflow: "hidden", transition: "height 0.3s",
              }} title={m.total > 0 ? `${m.label}: ${fmtPLN(m.total)}` : `${m.label}: brak płatności`}>
                {segments.map(s => (
                  <div key={s.id} style={{
                    height: `${s.pct}%`,
                    background: s.mfr.color,
                    opacity: hoveredMfr != null && hoveredMfr !== s.id ? 0.25 : 1,
                    transition: "opacity 0.16s",
                  }} title={`${s.mfr.name}: ${fmtPLN(s.val)}`}/>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {/* X axis labels */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 8,
        padding: "8px 18px 0", borderTop: "1px solid var(--border-soft)", marginTop: 4,
      }}>
        {months.map(m => {
          const isCurrent = m.key === todayKey;
          return (
            <div key={m.key} style={{
              textAlign: "center",
              fontSize: 10, fontWeight: isCurrent ? 700 : 500,
              color: isCurrent ? "var(--accent)" : "var(--text-lo)",
              textTransform: "uppercase", letterSpacing: "0.04em",
            }}>
              {m.shortLabel}
              {m.month === 0 && <div className="num" style={{ fontSize: 9, opacity: 0.7 }}>{m.year}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Per-month drilldown row ---------------------------------
function MonthRow({ month: m, maxTotal, hoveredMfr, onContainerClick, isLast, mfrMap }: {
  month: CashMonth; maxTotal: number; hoveredMfr: number | null;
  onContainerClick?: (c: Container) => void; isLast: boolean; mfrMap: MfrMap;
}) {
  const [expanded, setExpanded] = useState(false);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const isCurrent = m.key === todayKey;
  const isPast = m.date < new Date(today.getFullYear(), today.getMonth(), 1);

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--border-soft)" }}>
      <div onClick={() => setExpanded(!expanded)} style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 18px", cursor: "pointer", transition: "background 0.12s",
      }}
        onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-2)"}
        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
        <span style={{ color: "var(--text-lo)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.18s", flexShrink: 0 }}>
          <I.ChevronR size={14}/>
        </span>
        <div style={{ width: 90, flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: isCurrent ? "var(--accent)" : "var(--text-hi)" }}>
            {m.label}
          </div>
          {isCurrent
            ? <span style={{ fontSize: 10, color: "var(--accent)", fontWeight: 600 }}>BIEŻĄCY</span>
            : (isPast && <span style={{ fontSize: 10, color: "var(--text-lo)" }}>opłacone</span>)}
        </div>

        {/* Inline mini bar with stacked segments */}
        <div style={{ flex: 1, minWidth: 0, height: 16, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden", display: "flex" }}>
          {Object.entries(m.byMfr)
            .map(([id, val]) => { const nid = Number(id); return { id: nid, val, mfr: mfrMap[nid] }; })
            .filter(s => s.mfr)
            .sort((a, b) => a.id - b.id)
            .map(s => (
              <div key={s.id} style={{
                width: `${(s.val / maxTotal) * 100}%`,
                background: s.mfr.color,
                opacity: hoveredMfr != null && hoveredMfr !== s.id ? 0.25 : 1,
                transition: "opacity 0.16s",
              }} title={`${s.mfr.name}: ${fmtPLN(s.val)}`}/>
            ))}
        </div>

        <div style={{ textAlign: "right", minWidth: 100, flexShrink: 0 }}>
          <div className="num" style={{ fontSize: 14, fontWeight: 600, color: "var(--text-hi)" }}>{fmtPLN(m.total)}</div>
          <div style={{ fontSize: 11, color: "var(--text-lo)" }}>{m.containers.length} kontenerów</div>
        </div>
      </div>

      {expanded && (
        <div className="fade-in" style={{
          background: "var(--bg-elevated)",
          padding: "6px 18px 14px 44px",
          display: "flex", flexDirection: "column", gap: 6,
        }}>
          {m.containers.map(c => {
            const days = Math.ceil((parseLocal(c.eta_date).getTime() - Date.now()) / 86400000);
            const statusMeta = STATUS_FULL_META[c.status];
            const StatusIcon = statusMeta?.icon;
            return (
              <div key={c.id} onClick={() => onContainerClick?.(c)} style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto auto auto",
                gap: 12, alignItems: "center",
                padding: "8px 12px",
                background: "var(--surface-1)",
                border: "1px solid var(--border-soft)",
                borderRadius: 7, cursor: "pointer", transition: "border-color 0.12s",
              }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = "var(--border)"}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = "var(--border-soft)"}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  {StatusIcon && <span style={{ color: statusMeta.fg, flexShrink: 0, display: "inline-flex" }}><StatusIcon size={14}/></span>}
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>#{c.container_number}</span>
                  {c.order_number && <span className="mono" style={{ fontSize: 10, color: "var(--text-lo)" }}>PO {c.order_number}</span>}
                </div>
                {c.manufacturer_name && <MfrChip name={c.manufacturer_name} color={c.manufacturer_color || "var(--text-lo)"}/>}
                <span style={{ fontSize: 11, color: "var(--text-lo)", whiteSpace: "nowrap" }} className="num">
                  ETA {parseLocal(c.eta_date).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}
                  {days > 0 && ` (za ${days}d)`}
                </span>
                <span className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)", textAlign: "right" }}>
                  {fmtPLN(c.total_value)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { CashflowView };
export default CashflowView;
