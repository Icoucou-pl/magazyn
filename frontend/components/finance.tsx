"use client";
// ============================================================
// MAGAZYN — Finanse (finance.tsx).
//   Przychody / marże / kanały sprzedaży. Dane realne:
//   GET /finance/overview?period=ytd|365|90|30|prev_year
//   Wszystko w PLN (przewalutowanie NBP po stronie backendu), tylko
//   whitelist statusów = sprzedaż zrealizowana (zgodnie z Power BI).
//   Marża = przychód netto − koszt (cena_zakupu_netto z Subiekta, bieżący).
//   Sekcje: selektor okresu → karty KPI → kanały (tabela + udział) →
//   trend miesięczny (stack wg kanału) → top producenci.
//   Maskowanie: cały moduł pod uprawnieniem viewFinancials (gate w nav);
//   defensywnie pokazujemy zasłonę gdy brak uprawnienia.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { fmtPLN, fmtPLNk, fmtNum, fmtPct } from "@/lib/format";
import { useUser, can } from "@/lib/permissions";
import { I } from "./ui";

// ── Typy (lustro modeli backendu) ────────────────────────────
type Kpi = {
  revenue_net: number; revenue_gross: number; cost: number;
  margin: number; margin_pct: number; orders: number; units: number; aov_net: number;
};
type ChannelRow = {
  channel: string; revenue_net: number; revenue_gross: number; cost: number;
  margin: number; margin_pct: number; orders: number; units: number; share_pct: number;
};
type MfrRow = {
  manufacturer_id: number | null; name: string; color: string | null;
  revenue_net: number; cost: number; margin: number; margin_pct: number; units: number;
};
type MonthlyPt = { year: number; month: number; channel: string; revenue_net: number };
type Overview = {
  period: string; period_label: string; date_from: string; date_to: string; currency: string;
  kpi: Kpi; channels: ChannelRow[]; manufacturers: MfrRow[]; monthly: MonthlyPt[];
  items_without_cost: number;
};

// ── Kanały: kolejność + kolory (spójne w tabeli, wykresie, legendzie) ──
const CH_ORDER = ["Allegro", "Erli", "Studio-Bay", "Klaudia", "I-CC.PL"];
const CH_COLORS: Record<string, string> = {
  "Allegro": "oklch(0.70 0.17 45)",
  "Erli": "oklch(0.72 0.12 185)",
  "Studio-Bay": "oklch(0.62 0.17 300)",
  "Klaudia": "oklch(0.66 0.14 255)",
  "I-CC.PL": "var(--accent)",
};
const chColor = (c: string) => CH_COLORS[c] || "var(--text-lo)";

const MONTH_NAMES = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];

const PERIODS: [string, string][] = [
  ["ytd", "Ten rok"],
  ["365", "365 dni"],
  ["90", "90 dni"],
  ["30", "30 dni"],
  ["prev_year", "Zeszły rok"],
];

// Posortowana lista kanałów obecnych w danych (stała kolejność + ewentualne dodatkowe)
function orderedChannels(present: string[]): string[] {
  const set = new Set(present);
  const out = CH_ORDER.filter((c) => set.has(c));
  present.forEach((c) => { if (!out.includes(c)) out.push(c); });
  return out;
}

export default function FinanceView({ density }: { density?: string }) {
  const showFin = can(useUser(), "viewFinancials");
  const [period, setPeriod] = useState("ytd");
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!showFin) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setErr(null);
    api.get(`/finance/overview?period=${period}`)
      .then((d: Overview) => { if (alive) setData(d); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : "Błąd pobierania"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [period, showFin]);

  if (!showFin) {
    return (
      <div className="fade-in" style={emptyBox}>
        <div style={emptyIcon}><I.Wallet size={24} /></div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Finanse</h2>
        <p style={{ color: "var(--text-lo)", fontSize: 13, marginTop: 6 }}>
          Twoja rola nie ma dostępu do danych finansowych (•••).
        </p>
      </div>
    );
  }

  const k = data?.kpi;

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Nagłówek + selektor okresu */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650, display: "flex", alignItems: "center", gap: 8 }}>
            <I.TrendUp size={20} /> Finanse
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-lo)" }}>
            {data ? `${data.period_label} · ${data.date_from} – ${data.date_to} · w PLN` : "Przychody, marże i kanały sprzedaży"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 2, padding: 4, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
          {PERIODS.map(([id, label]) => (
            <button key={id} onClick={() => setPeriod(id)} style={{
              padding: "7px 12px", border: "none", borderRadius: 7,
              fontSize: 12, fontWeight: 500, cursor: "pointer",
              background: period === id ? "var(--surface-3)" : "transparent",
              color: period === id ? "var(--text-hi)" : "var(--text-mid)",
              transition: "all 0.12s",
            }}>{label}</button>
          ))}
        </div>
      </div>

      {err && (
        <div style={{ ...panel, padding: 16, color: "var(--critical)", display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <I.Alert size={16} /> {err}
        </div>
      )}

      {loading && !data ? (
        <div style={{ ...panel, padding: 40, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Ładowanie danych…</div>
      ) : data && k ? (
        <>
          {/* KPI */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, opacity: loading ? 0.6 : 1, transition: "opacity 0.15s" }}>
            <StatCard label="Przychód netto" value={fmtPLN(k.revenue_net)} icon={<I.Wallet size={16} />} accent />
            <StatCard label="Marża" value={fmtPLN(k.margin)} sub={`marża ${fmtPct(k.margin_pct)}`} icon={<I.TrendUp size={16} />}
              tone={k.margin >= 0 ? "ok" : "bad"} />
            <StatCard label="Przychód brutto" value={fmtPLN(k.revenue_gross)} icon={<I.Cart size={16} />} />
            <StatCard label="Zamówienia" value={fmtNum(k.orders)} sub={`${fmtNum(k.units)} szt`} icon={<I.Box size={16} />} />
            <StatCard label="Śr. wartość zam." value={fmtPLN(k.aov_net)} sub="netto" icon={<I.Activity size={16} />} />
            <StatCard label="Koszt zakupu" value={fmtPLN(k.cost)} sub="bieżący (Subiekt)" icon={<I.Factory size={16} />} />
          </div>

          {data.items_without_cost > 0 && (
            <div style={{ ...panel, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--warning)" }}>
              <I.Alert size={14} />
              {fmtNum(data.items_without_cost)} szt. sprzedanych pozycji nie ma kosztu w Subiekcie — ich marża jest zawyżona (liczona jak koszt 0).
            </div>
          )}

          {/* Kanały */}
          <ChannelTable channels={data.channels} />

          {/* Trend miesięczny */}
          <TrendChart monthly={data.monthly} />

          {/* Producenci */}
          <MfrTable rows={data.manufacturers} />
        </>
      ) : null}
    </div>
  );
}

// ── Karta KPI ────────────────────────────────────────────────
function StatCard({ label, value, sub, icon, tone, accent }: {
  label: string; value: string; sub?: string; icon?: React.ReactNode;
  tone?: "ok" | "bad"; accent?: boolean;
}) {
  const color = tone === "ok" ? "var(--ok)" : tone === "bad" ? "var(--critical)" : "var(--text-hi)";
  return (
    <div style={{ ...panel, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          width: 30, height: 30, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: accent ? "var(--accent-soft)" : "var(--surface-2)",
          color: accent ? "var(--accent)" : "var(--text-mid)",
        }}>{icon}</span>
        <span style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>{label}</span>
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-lo)" }}>{sub}</div>}
    </div>
  );
}

// ── Tabela kanałów ───────────────────────────────────────────
function ChannelTable({ channels }: { channels: ChannelRow[] }) {
  const sorted = [...channels].sort((a, b) => b.revenue_net - a.revenue_net);
  return (
    <div style={panel}>
      <SectionHead icon={<I.Cart size={15} />} title="Kanały sprzedaży" hint="udział wg przychodu netto" />
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead>
            <tr>
              <Th>Kanał</Th>
              <Th right>Przychód netto</Th>
              <Th>Udział</Th>
              <Th right>Marża</Th>
              <Th right>Marża %</Th>
              <Th right>Zam.</Th>
              <Th right>Szt.</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: "var(--text-lo)", padding: 20 }}>Brak danych w tym okresie</td></tr>
            ) : sorted.map((c) => (
              <tr key={c.channel}>
                <td style={td}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: chColor(c.channel) }} />
                    <span style={{ fontWeight: 600 }}>{c.channel}</span>
                  </span>
                </td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtPLN(c.revenue_net)}</td>
                <td style={{ ...td, minWidth: 160 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 7, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${Math.max(2, c.share_pct)}%`, height: "100%", background: chColor(c.channel), borderRadius: 4 }} />
                    </div>
                    <span className="num" style={{ fontSize: 11, color: "var(--text-mid)", minWidth: 38, textAlign: "right" }}>{c.share_pct.toFixed(1).replace(".", ",")}%</span>
                  </div>
                </td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtPLNk(c.margin)}</td>
                <td style={{ ...td, textAlign: "right", color: c.margin_pct >= 0 ? "var(--ok)" : "var(--critical)" }} className="num">{c.margin_pct.toFixed(1).replace(".", ",")}%</td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtNum(c.orders)}</td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtNum(c.units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Trend miesięczny (stack wg kanału) ───────────────────────
function TrendChart({ monthly }: { monthly: MonthlyPt[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const { buckets, channels, max, multiYear } = useMemo(() => {
    const map = new Map<string, { year: number; month: number; byCh: Record<string, number>; total: number }>();
    const years = new Set<number>();
    const chSet = new Set<string>();
    monthly.forEach((p) => {
      years.add(p.year);
      chSet.add(p.channel);
      const key = `${p.year}-${String(p.month).padStart(2, "0")}`;
      let b = map.get(key);
      if (!b) { b = { year: p.year, month: p.month, byCh: {}, total: 0 }; map.set(key, b); }
      b.byCh[p.channel] = (b.byCh[p.channel] || 0) + p.revenue_net;
      b.total += p.revenue_net;
    });
    const bk = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
    return {
      buckets: bk,
      channels: orderedChannels(Array.from(chSet)),
      max: Math.max(1, ...bk.map((b) => b.total)),
      multiYear: years.size > 1,
    };
  }, [monthly]);

  const H = 240;
  const pad = { t: 14, r: 12, b: 28, l: 48 };
  const iw = Math.max(60, w - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const n = buckets.length;
  const slot = n > 0 ? iw / n : iw;
  const barW = Math.min(46, Math.max(8, slot * 0.6));
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const label = (b: { year: number; month: number }) => MONTH_NAMES[b.month] + (multiYear ? " '" + String(b.year).slice(2) : "");

  return (
    <div style={panel}>
      <SectionHead icon={<I.Activity size={15} />} title="Trend miesięczny" hint="przychód netto, stack wg kanału" />
      <div ref={ref} style={{ position: "relative", padding: "8px 4px 4px" }}>
        {n === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Brak danych w tym okresie</div>
        ) : (
          <svg width="100%" height={H} viewBox={`0 0 ${w} ${H}`} style={{ display: "block" }}
            onMouseLeave={() => setHover(null)}>
            {/* osie y — siatka */}
            {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
              const yy = pad.t + ih - f * ih;
              return (
                <g key={i}>
                  <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={pad.l - 6} y={yy + 3} textAnchor="end" fontSize={9} fill="var(--text-lo)">{Math.round((max * f) / 1000)}k</text>
                </g>
              );
            })}
            {/* słupki stackowane */}
            {buckets.map((b, i) => {
              const cx = pad.l + i * slot + slot / 2;
              let acc = 0;
              return (
                <g key={i} onMouseEnter={() => setHover(i)}>
                  <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
                  {channels.map((ch) => {
                    const v = b.byCh[ch] || 0;
                    if (v <= 0) return null;
                    const h = (v / max) * ih;
                    const yTop = pad.t + ih - acc - h;
                    acc += h;
                    return <rect key={ch} x={cx - barW / 2} y={yTop} width={barW} height={Math.max(0, h)} fill={chColor(ch)} rx={1}
                      opacity={hover == null || hover === i ? 1 : 0.45} />;
                  })}
                  <text x={cx} y={H - 10} textAnchor="middle" fontSize={9} fill={hover === i ? "var(--text-hi)" : "var(--text-lo)"}>{label(b)}</text>
                </g>
              );
            })}
          </svg>
        )}
        {hover != null && buckets[hover] && (
          <div style={{
            position: "absolute", top: 6, right: 12, minWidth: 170,
            background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10,
            padding: "10px 12px", boxShadow: "0 12px 30px rgba(0,0,0,0.35)", pointerEvents: "none",
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: "var(--text-hi)" }}>{label(buckets[hover])}</div>
            {channels.filter((ch) => (buckets[hover].byCh[ch] || 0) > 0).map((ch) => (
              <div key={ch} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 11, padding: "2px 0" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-mid)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: chColor(ch) }} />{ch}
                </span>
                <span className="num" style={{ color: "var(--text-hi)" }}>{fmtPLNk(buckets[hover].byCh[ch])}</span>
              </div>
            ))}
            <div style={{ borderTop: "1px solid var(--border-soft)", marginTop: 6, paddingTop: 6, display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 600 }}>
              <span style={{ color: "var(--text-mid)" }}>Razem</span>
              <span className="num" style={{ color: "var(--text-hi)" }}>{fmtPLNk(buckets[hover].total)}</span>
            </div>
          </div>
        )}
      </div>
      {/* legenda */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "8px 14px 12px", borderTop: "1px solid var(--border-soft)" }}>
        {channels.map((ch) => (
          <span key={ch} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-mid)" }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: chColor(ch) }} />{ch}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Top producenci ───────────────────────────────────────────
function MfrTable({ rows }: { rows: MfrRow[] }) {
  const LIMIT = 12;
  const shown = rows.slice(0, LIMIT);
  const rest = rows.length - shown.length;
  return (
    <div style={panel}>
      <SectionHead icon={<I.Factory size={15} />} title="Producenci" hint={`top ${shown.length} wg przychodu netto`} />
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead>
            <tr>
              <Th>Producent</Th>
              <Th right>Przychód netto</Th>
              <Th right>Marża</Th>
              <Th right>Marża %</Th>
              <Th right>Szt.</Th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "var(--text-lo)", padding: 20 }}>Brak danych w tym okresie</td></tr>
            ) : shown.map((m, i) => (
              <tr key={m.manufacturer_id ?? `none-${i}`}>
                <td style={td}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: m.color || "var(--text-lo)" }} />
                    <span style={{ fontWeight: 500 }}>{m.name}</span>
                  </span>
                </td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtPLN(m.revenue_net)}</td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtPLNk(m.margin)}</td>
                <td style={{ ...td, textAlign: "right", color: m.margin_pct >= 0 ? "var(--ok)" : "var(--critical)" }} className="num">{m.margin_pct.toFixed(1).replace(".", ",")}%</td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtNum(m.units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rest > 0 && (
        <div style={{ padding: "8px 14px 12px", fontSize: 11, color: "var(--text-lo)", borderTop: "1px solid var(--border-soft)" }}>
          …i {rest} więcej
        </div>
      )}
    </div>
  );
}

// ── Wspólne drobiazgi UI ─────────────────────────────────────
function SectionHead({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
      <span style={{ color: "var(--text-mid)" }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
      {hint && <span style={{ fontSize: 11, color: "var(--text-lo)" }}>· {hint}</span>}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th style={{
      textAlign: right ? "right" : "left", padding: "9px 14px",
      fontSize: 10, fontWeight: 600, color: "var(--text-lo)",
      textTransform: "uppercase", letterSpacing: "0.04em",
      borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap",
      position: "sticky", top: 0, background: "var(--surface-1)",
    }}>{children}</th>
  );
}

const panel: React.CSSProperties = {
  background: "var(--surface-1)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--r-lg)",
  overflow: "hidden",
};

const tbl: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse", fontSize: 12.5,
};

const td: React.CSSProperties = {
  padding: "10px 14px", borderBottom: "1px solid var(--border-soft)",
  color: "var(--text-hi)", whiteSpace: "nowrap",
};

const emptyBox: React.CSSProperties = {
  padding: 60, textAlign: "center",
  background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)",
};
const emptyIcon: React.CSSProperties = {
  width: 56, height: 56, margin: "0 auto 16px", borderRadius: 14,
  background: "var(--accent-soft)", color: "var(--accent)",
  display: "flex", alignItems: "center", justifyContent: "center",
};
