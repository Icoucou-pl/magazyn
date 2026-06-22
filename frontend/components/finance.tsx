"use client";
// ============================================================
// MAGAZYN — Finanse (finance.tsx).
//   Dwie zakładki:
//   • Przegląd        → GET /finance/overview?period=…  (KPI, kanały, trend, producenci)
//   • Karta produktu  → GET /finance/product?symbol=…&period=…
//                       (info + KPI + rotacja/pokrycie stanu + trend + kanały)
//   Picker symbolu reużywa GET /search/global (grupa products).
//   Wszystko w PLN (przewalutowanie NBP), whitelist statusów = sprzedaż zrealizowana.
//   Marża = przychód netto − koszt (cena_zakupu_netto z Subiekta, bieżący).
//   Cały moduł pod uprawnieniem viewFinancials (gate w nav + zasłona defensywna).
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { fmtPLN, fmtPLNk, fmtNum, fmtPct } from "@/lib/format";
import { useUser, can } from "@/lib/permissions";
import { I } from "./ui";

// ── Typy: Przegląd ───────────────────────────────────────────
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

// ── Typy: Karta produktu ─────────────────────────────────────
type ProductInfo = {
  symbol: string; name: string | null;
  manufacturer_id: number | null; manufacturer_name: string | null; manufacturer_color: string | null;
  ean: string | null; stock: number; unit_cost: number;
  cbm_per_unit: number | null; lead_time_days: number | null;
};
type ProductKpi = {
  revenue_net: number; revenue_gross: number; cost: number; margin: number; margin_pct: number;
  units: number; orders: number; avg_price_net: number; unit_cost: number; unit_margin: number;
};
type ProductRotation = {
  days_in_period: number; avg_daily_units: number; avg_monthly_units: number;
  days_of_cover: number | null; stock: number;
};
type ProductChannelRow = { channel: string; units: number; revenue_net: number; share_pct: number };
type ProductMonthly = { year: number; month: number; units: number; revenue_net: number };
type ProductCard = {
  period: string; period_label: string; date_from: string; date_to: string; currency: string;
  info: ProductInfo; kpi: ProductKpi; rotation: ProductRotation;
  channels: ProductChannelRow[]; monthly: ProductMonthly[];
};
type SearchProduct = { sku: string; name: string; stock: number; manufacturer_name: string | null; manufacturer_color: string | null };

// ── Kanały: kolejność + kolory ───────────────────────────────
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
  ["ytd", "Ten rok"], ["365", "365 dni"], ["90", "90 dni"], ["30", "30 dni"], ["prev_year", "Zeszły rok"],
];
const dec1 = (n: number) => n.toFixed(1).replace(".", ",");

function orderedChannels(present: string[]): string[] {
  const set = new Set(present);
  const out = CH_ORDER.filter((c) => set.has(c));
  present.forEach((c) => { if (!out.includes(c)) out.push(c); });
  return out;
}

// ============================================================
// ROOT
// ============================================================
export default function FinanceView({ density }: { density?: string }) {
  const showFin = can(useUser(), "viewFinancials");
  const [tab, setTab] = useState<"overview" | "product">("overview");
  const [period, setPeriod] = useState("ytd");

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

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Nagłówek + okres */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650, display: "flex", alignItems: "center", gap: 8 }}>
            <I.TrendUp size={20} /> Finanse
          </h1>
          {/* zakładki */}
          <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
            <TabBtn active={tab === "overview"} onClick={() => setTab("overview")} icon={<I.Activity size={14} />}>Przegląd</TabBtn>
            <TabBtn active={tab === "product"} onClick={() => setTab("product")} icon={<I.Box size={14} />}>Karta produktu</TabBtn>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2, padding: 4, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
          {PERIODS.map(([id, label]) => (
            <button key={id} onClick={() => setPeriod(id)} style={{
              padding: "7px 12px", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: "pointer",
              background: period === id ? "var(--surface-3)" : "transparent",
              color: period === id ? "var(--text-hi)" : "var(--text-mid)", transition: "all 0.12s",
            }}>{label}</button>
          ))}
        </div>
      </div>

      {tab === "overview" ? <OverviewTab period={period} /> : <ProductTab period={period} />}
    </div>
  );
}

// ============================================================
// ZAKŁADKA: PRZEGLĄD
// ============================================================
function OverviewTab({ period }: { period: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    api.get(`/finance/overview?period=${period}`)
      .then((d: Overview) => { if (alive) setData(d); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : "Błąd pobierania"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [period]);

  const k = data?.kpi;
  if (err) return <ErrBox msg={err} />;
  if (loading && !data) return <LoadBox />;
  if (!data || !k) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, opacity: loading ? 0.6 : 1, transition: "opacity 0.15s" }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-lo)" }}>{data.period_label} · {data.date_from} – {data.date_to} · w PLN</p>

      <div style={kpiGrid}>
        <StatCard label="Przychód netto" value={fmtPLN(k.revenue_net)} icon={<I.Wallet size={16} />} accent />
        <StatCard label="Marża" value={fmtPLN(k.margin)} sub={`marża ${fmtPct(k.margin_pct)}`} icon={<I.TrendUp size={16} />} tone={k.margin >= 0 ? "ok" : "bad"} />
        <StatCard label="Przychód brutto" value={fmtPLN(k.revenue_gross)} icon={<I.Cart size={16} />} />
        <StatCard label="Zamówienia" value={fmtNum(k.orders)} sub={`${fmtNum(k.units)} szt`} icon={<I.Box size={16} />} />
        <StatCard label="Śr. wartość zam." value={fmtPLN(k.aov_net)} sub="netto" icon={<I.Activity size={16} />} />
        <StatCard label="Koszt zakupu" value={fmtPLN(k.cost)} sub="bieżący (Subiekt)" icon={<I.Factory size={16} />} />
      </div>

      {data.items_without_cost > 0 && (
        <div style={warnBox}>
          <I.Alert size={14} />
          {fmtNum(data.items_without_cost)} szt. sprzedanych pozycji nie ma kosztu w Subiekcie — ich marża jest zawyżona (liczona jak koszt 0).
        </div>
      )}

      <ChannelTable channels={data.channels} />
      <TrendChart monthly={data.monthly} />
      <MfrTable rows={data.manufacturers} />
    </div>
  );
}

// ============================================================
// ZAKŁADKA: KARTA PRODUKTU
// ============================================================
function ProductTab({ period }: { period: string }) {
  const [symbol, setSymbol] = useState<string | null>(null);
  const [data, setData] = useState<ProductCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) { setData(null); return; }
    let alive = true;
    setLoading(true); setErr(null);
    api.get(`/finance/product?symbol=${encodeURIComponent(symbol)}&period=${period}`)
      .then((d: ProductCard) => { if (alive) setData(d); })
      .catch((e: unknown) => { if (alive) { setErr(e instanceof Error ? e.message : "Błąd pobierania"); setData(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol, period]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SymbolPicker value={symbol} onPick={(s) => setSymbol(s || null)} />

      {!symbol ? (
        <div style={{ ...panel, padding: 40, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
          <div style={{ ...emptyIcon, width: 48, height: 48, margin: "0 auto 12px" }}><I.Search size={20} /></div>
          Wpisz symbol produktu, aby zobaczyć jego kartę.
        </div>
      ) : err ? <ErrBox msg={err} />
        : loading && !data ? <LoadBox />
          : data ? <ProductCardBody data={data} loading={loading} /> : null}
    </div>
  );
}

// Picker symbolu — reużywa /search/global (grupa products)
function SymbolPicker({ value, onPick }: { value: string | null; onPick: (s: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchProduct[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current);
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    tRef.current = setTimeout(() => {
      api.get(`/search/global?q=${encodeURIComponent(term)}`)
        .then((d: { products?: SearchProduct[] }) => { setResults(d.products || []); setHi(0); setOpen(true); })
        .catch(() => setResults([]));
    }, 220);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
  }, [q]);

  const pick = (sku: string) => { onPick(sku); setQ(sku); setOpen(false); };

  return (
    <div ref={boxRef} style={{ position: "relative", maxWidth: 520 }}>
      <div style={{ position: "relative" }}>
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-lo)", pointerEvents: "none" }}>
          <I.Search size={16} />
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => { if (results.length) setOpen(true); }}
          onKeyDown={(e) => {
            if (!open || !results.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); const r = results[hi]; if (r) pick(r.sku); }
            else if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Wpisz symbol lub nazwę…"
          style={{
            width: "100%", padding: "11px 12px 11px 38px", fontSize: 14,
            background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 10,
            color: "var(--text-hi)", outline: "none",
          }}
        />
        {value && (
          <button onClick={() => { onPick(""); setQ(""); setResults([]); }} title="Wyczyść"
            style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", color: "var(--text-lo)", cursor: "pointer", padding: 4 }}>
            <I.Close size={15} />
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 40,
          background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 16px 40px rgba(0,0,0,0.4)", maxHeight: 320, overflowY: "auto", padding: 4,
        }}>
          {results.map((r, i) => (
            <button key={r.sku} onMouseEnter={() => setHi(i)} onClick={() => pick(r.sku)}
              style={{
                width: "100%", textAlign: "left", border: "none", cursor: "pointer",
                padding: "9px 10px", borderRadius: 7, background: i === hi ? "var(--surface-2)" : "transparent",
                display: "flex", alignItems: "center", gap: 10,
              }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: r.manufacturer_color || "var(--text-lo)", flexShrink: 0 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="num" style={{ fontWeight: 600, fontSize: 13, color: "var(--text-hi)" }}>{r.sku}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--text-lo)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.name}{r.manufacturer_name ? ` · ${r.manufacturer_name}` : ""}
                </span>
              </span>
              <span className="num" style={{ fontSize: 11, color: "var(--text-mid)", flexShrink: 0 }}>stan {fmtNum(r.stock)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProductCardBody({ data, loading }: { data: ProductCard; loading: boolean }) {
  const { info, kpi, rotation } = data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, opacity: loading ? 0.6 : 1, transition: "opacity 0.15s" }}>
      {/* Nagłówek produktu */}
      <div style={{ ...panel, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="num" style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)" }}>{info.symbol}</span>
          {info.manufacturer_name && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-mid)", padding: "3px 9px", background: "var(--surface-2)", borderRadius: 20 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: info.manufacturer_color || "var(--text-lo)" }} />
              {info.manufacturer_name}
            </span>
          )}
        </div>
        {info.name && <div style={{ marginTop: 6, fontSize: 14, color: "var(--text-mid)" }}>{info.name}</div>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginTop: 14 }}>
          <Meta label="Stan dostępny" value={`${fmtNum(info.stock)} szt`} />
          <Meta label="Koszt netto / szt" value={fmtPLN(info.unit_cost)} />
          <Meta label="CBM / szt" value={info.cbm_per_unit != null ? dec1(info.cbm_per_unit) : "—"} />
          <Meta label="Lead-time" value={info.lead_time_days != null ? `${info.lead_time_days} dni` : "—"} />
          <Meta label="EAN" value={info.ean || "—"} mono />
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-lo)" }}>{data.period_label} · {data.date_from} – {data.date_to} · w PLN</p>

      {/* KPI */}
      <div style={kpiGrid}>
        <StatCard label="Przychód netto" value={fmtPLN(kpi.revenue_net)} icon={<I.Wallet size={16} />} accent />
        <StatCard label="Marża" value={fmtPLN(kpi.margin)} sub={`marża ${fmtPct(kpi.margin_pct)}`} icon={<I.TrendUp size={16} />} tone={kpi.margin >= 0 ? "ok" : "bad"} />
        <StatCard label="Sztuki" value={fmtNum(kpi.units)} sub={`${fmtNum(kpi.orders)} zam.`} icon={<I.Box size={16} />} />
        <StatCard label="Śr. cena netto / szt" value={fmtPLN(kpi.avg_price_net)} icon={<I.Cart size={16} />} />
        <StatCard label="Marża / szt" value={fmtPLN(kpi.unit_margin)} sub={`koszt ${fmtPLN(kpi.unit_cost)}`} icon={<I.Activity size={16} />} tone={kpi.unit_margin >= 0 ? "ok" : "bad"} />
        <StatCard label="Przychód brutto" value={fmtPLN(kpi.revenue_gross)} icon={<I.Factory size={16} />} />
      </div>

      {/* Rotacja / pokrycie stanu */}
      <RotationBlock rotation={rotation} leadTime={info.lead_time_days} />

      {/* Trend miesięczny */}
      <ProductTrendChart monthly={data.monthly} />

      {/* Kanały */}
      <ProductChannelTable channels={data.channels} />
    </div>
  );
}

// ── Rotacja ──────────────────────────────────────────────────
function RotationBlock({ rotation, leadTime }: { rotation: ProductRotation; leadTime: number | null }) {
  const dc = rotation.days_of_cover;
  const lt = leadTime ?? 45;
  let tone: "ok" | "warn" | "bad" | "muted" = "muted";
  let note = "brak sprzedaży w okresie";
  if (dc != null) {
    if (dc < lt) { tone = "bad"; note = "poniżej lead-time — ryzyko braku"; }
    else if (dc < lt * 2) { tone = "warn"; note = "blisko progu — obserwuj"; }
    else { tone = "ok"; note = "zapas bezpieczny"; }
  }
  const dcColor = tone === "bad" ? "var(--critical)" : tone === "warn" ? "var(--warning)" : tone === "ok" ? "var(--ok)" : "var(--text-lo)";
  return (
    <div style={panel}>
      <SectionHead icon={<I.Refresh size={15} />} title="Rotacja i pokrycie stanu" hint="na podstawie sprzedaży w okresie" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 0 }}>
        <RotCell label="Śr. sprzedaż / dzień" value={`${dec1(rotation.avg_daily_units)} szt`} />
        <RotCell label="Śr. sprzedaż / mies." value={`${fmtNum(Math.round(rotation.avg_monthly_units))} szt`} />
        <RotCell label="Stan dostępny" value={`${fmtNum(rotation.stock)} szt`} />
        <div style={{ padding: 16, borderLeft: "1px solid var(--border-soft)" }}>
          <div style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>Dni pokrycia</div>
          <div className="num" style={{ fontSize: 26, fontWeight: 700, color: dcColor, lineHeight: 1.1, marginTop: 6 }}>
            {dc != null ? fmtNum(Math.round(dc)) : "—"}
          </div>
          <div style={{ fontSize: 11, color: dcColor, marginTop: 2 }}>{note}</div>
        </div>
      </div>
    </div>
  );
}
function RotCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 16, borderLeft: "1px solid var(--border-soft)" }}>
      <div style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>{label}</div>
      <div className="num" style={{ fontSize: 20, fontWeight: 700, color: "var(--text-hi)", marginTop: 6 }}>{value}</div>
    </div>
  );
}

// ── Trend produktu (sztuki / mies., przychód w dymku) ────────
function ProductTrendChart({ monthly }: { monthly: ProductMonthly[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const { buckets, max, multiYear } = useMemo(() => {
    const years = new Set<number>();
    monthly.forEach((p) => years.add(p.year));
    const sorted = [...monthly].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month);
    return { buckets: sorted, max: Math.max(1, ...sorted.map((b) => b.units)), multiYear: years.size > 1 };
  }, [monthly]);

  const H = 230;
  const pad = { t: 14, r: 12, b: 28, l: 40 };
  const iw = Math.max(60, w - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const n = buckets.length;
  const slot = n > 0 ? iw / n : iw;
  const barW = Math.min(46, Math.max(8, slot * 0.6));
  const label = (b: ProductMonthly) => MONTH_NAMES[b.month] + (multiYear ? " '" + String(b.year).slice(2) : "");

  return (
    <div style={panel}>
      <SectionHead icon={<I.Activity size={15} />} title="Trend miesięczny" hint="sztuki / mies. (przychód w dymku)" />
      <div ref={ref} style={{ position: "relative", padding: "8px 4px 4px" }}>
        {n === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Brak sprzedaży w tym okresie</div>
        ) : (
          <svg width="100%" height={H} viewBox={`0 0 ${w} ${H}`} style={{ display: "block" }} onMouseLeave={() => setHover(null)}>
            {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
              const yy = pad.t + ih - f * ih;
              return (
                <g key={i}>
                  <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={pad.l - 6} y={yy + 3} textAnchor="end" fontSize={9} fill="var(--text-lo)">{Math.round(max * f)}</text>
                </g>
              );
            })}
            {buckets.map((b, i) => {
              const cx = pad.l + i * slot + slot / 2;
              const h = (b.units / max) * ih;
              return (
                <g key={i} onMouseEnter={() => setHover(i)}>
                  <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
                  <rect x={cx - barW / 2} y={pad.t + ih - h} width={barW} height={Math.max(0, h)} fill="var(--accent)" rx={2}
                    opacity={hover == null || hover === i ? 1 : 0.45} />
                  <text x={cx} y={H - 10} textAnchor="middle" fontSize={9} fill={hover === i ? "var(--text-hi)" : "var(--text-lo)"}>{label(b)}</text>
                </g>
              );
            })}
          </svg>
        )}
        {hover != null && buckets[hover] && (
          <div style={{ position: "absolute", top: 6, right: 12, minWidth: 150, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", boxShadow: "0 12px 30px rgba(0,0,0,0.35)", pointerEvents: "none" }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: "var(--text-hi)" }}>{label(buckets[hover])}</div>
            <Row k="Sztuki" v={fmtNum(buckets[hover].units)} />
            <Row k="Przychód" v={fmtPLNk(buckets[hover].revenue_net)} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Kanały produktu ──────────────────────────────────────────
function ProductChannelTable({ channels }: { channels: ProductChannelRow[] }) {
  const sorted = [...channels].sort((a, b) => b.revenue_net - a.revenue_net);
  return (
    <div style={panel}>
      <SectionHead icon={<I.Cart size={15} />} title="Sprzedaż wg kanału" hint="gdzie się sprzedaje" />
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>Kanał</Th><Th right>Sztuki</Th><Th right>Przychód netto</Th><Th>Udział</Th></tr></thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={4} style={{ ...td, textAlign: "center", color: "var(--text-lo)", padding: 20 }}>Brak sprzedaży w tym okresie</td></tr>
            ) : sorted.map((c) => (
              <tr key={c.channel}>
                <td style={td}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: chColor(c.channel) }} />
                    <span style={{ fontWeight: 600 }}>{c.channel}</span>
                  </span>
                </td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtNum(c.units)}</td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtPLN(c.revenue_net)}</td>
                <td style={{ ...td, minWidth: 150 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 7, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${Math.max(2, c.share_pct)}%`, height: "100%", background: chColor(c.channel), borderRadius: 4 }} />
                    </div>
                    <span className="num" style={{ fontSize: 11, color: "var(--text-mid)", minWidth: 38, textAlign: "right" }}>{dec1(c.share_pct)}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// PRZEGLĄD — komponenty (kanały, trend, producenci)
// ============================================================
function ChannelTable({ channels }: { channels: ChannelRow[] }) {
  const sorted = [...channels].sort((a, b) => b.revenue_net - a.revenue_net);
  return (
    <div style={panel}>
      <SectionHead icon={<I.Cart size={15} />} title="Kanały sprzedaży" hint="udział wg przychodu netto" />
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>Kanał</Th><Th right>Przychód netto</Th><Th>Udział</Th><Th right>Marża</Th><Th right>Marża %</Th><Th right>Zam.</Th><Th right>Szt.</Th></tr></thead>
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
                    <span className="num" style={{ fontSize: 11, color: "var(--text-mid)", minWidth: 38, textAlign: "right" }}>{dec1(c.share_pct)}%</span>
                  </div>
                </td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtPLNk(c.margin)}</td>
                <td style={{ ...td, textAlign: "right", color: c.margin_pct >= 0 ? "var(--ok)" : "var(--critical)" }} className="num">{dec1(c.margin_pct)}%</td>
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
      years.add(p.year); chSet.add(p.channel);
      const key = `${p.year}-${String(p.month).padStart(2, "0")}`;
      let b = map.get(key);
      if (!b) { b = { year: p.year, month: p.month, byCh: {}, total: 0 }; map.set(key, b); }
      b.byCh[p.channel] = (b.byCh[p.channel] || 0) + p.revenue_net;
      b.total += p.revenue_net;
    });
    const bk = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
    return { buckets: bk, channels: orderedChannels(Array.from(chSet)), max: Math.max(1, ...bk.map((b) => b.total)), multiYear: years.size > 1 };
  }, [monthly]);

  const H = 240;
  const pad = { t: 14, r: 12, b: 28, l: 48 };
  const iw = Math.max(60, w - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const n = buckets.length;
  const slot = n > 0 ? iw / n : iw;
  const barW = Math.min(46, Math.max(8, slot * 0.6));
  const label = (b: { year: number; month: number }) => MONTH_NAMES[b.month] + (multiYear ? " '" + String(b.year).slice(2) : "");

  return (
    <div style={panel}>
      <SectionHead icon={<I.Activity size={15} />} title="Trend miesięczny" hint="przychód netto, stack wg kanału" />
      <div ref={ref} style={{ position: "relative", padding: "8px 4px 4px" }}>
        {n === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Brak danych w tym okresie</div>
        ) : (
          <svg width="100%" height={H} viewBox={`0 0 ${w} ${H}`} style={{ display: "block" }} onMouseLeave={() => setHover(null)}>
            {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
              const yy = pad.t + ih - f * ih;
              return (
                <g key={i}>
                  <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={pad.l - 6} y={yy + 3} textAnchor="end" fontSize={9} fill="var(--text-lo)">{Math.round((max * f) / 1000)}k</text>
                </g>
              );
            })}
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
                    return <rect key={ch} x={cx - barW / 2} y={yTop} width={barW} height={Math.max(0, h)} fill={chColor(ch)} rx={1} opacity={hover == null || hover === i ? 1 : 0.45} />;
                  })}
                  <text x={cx} y={H - 10} textAnchor="middle" fontSize={9} fill={hover === i ? "var(--text-hi)" : "var(--text-lo)"}>{label(b)}</text>
                </g>
              );
            })}
          </svg>
        )}
        {hover != null && buckets[hover] && (
          <div style={{ position: "absolute", top: 6, right: 12, minWidth: 170, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", boxShadow: "0 12px 30px rgba(0,0,0,0.35)", pointerEvents: "none" }}>
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

function MfrTable({ rows }: { rows: MfrRow[] }) {
  const LIMIT = 12;
  const shown = rows.slice(0, LIMIT);
  const rest = rows.length - shown.length;
  return (
    <div style={panel}>
      <SectionHead icon={<I.Factory size={15} />} title="Producenci" hint={`top ${shown.length} wg przychodu netto`} />
      <div style={{ overflowX: "auto" }}>
        <table style={tbl}>
          <thead><tr><Th>Producent</Th><Th right>Przychód netto</Th><Th right>Marża</Th><Th right>Marża %</Th><Th right>Szt.</Th></tr></thead>
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
                <td style={{ ...td, textAlign: "right", color: m.margin_pct >= 0 ? "var(--ok)" : "var(--critical)" }} className="num">{dec1(m.margin_pct)}%</td>
                <td style={{ ...td, textAlign: "right" }} className="num">{fmtNum(m.units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rest > 0 && (
        <div style={{ padding: "8px 14px 12px", fontSize: 11, color: "var(--text-lo)", borderTop: "1px solid var(--border-soft)" }}>…i {rest} więcej</div>
      )}
    </div>
  );
}

// ============================================================
// Wspólne drobiazgi UI
// ============================================================
function TabBtn({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px",
      border: "1px solid " + (active ? "var(--border)" : "transparent"), borderRadius: 9,
      background: active ? "var(--surface-1)" : "transparent",
      color: active ? "var(--text-hi)" : "var(--text-mid)", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.12s",
    }}>{icon}{children}</button>
  );
}

function StatCard({ label, value, sub, icon, tone, accent }: {
  label: string; value: string; sub?: string; icon?: React.ReactNode; tone?: "ok" | "bad"; accent?: boolean;
}) {
  const color = tone === "ok" ? "var(--ok)" : tone === "bad" ? "var(--critical)" : "var(--text-hi)";
  return (
    <div style={{ ...panel, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", background: accent ? "var(--accent-soft)" : "var(--surface-2)", color: accent ? "var(--accent)" : "var(--text-mid)" }}>{icon}</span>
        <span style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>{label}</span>
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-lo)" }}>{sub}</div>}
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>{label}</div>
      <div className={mono ? "num" : undefined} style={{ fontSize: 14, fontWeight: 600, color: "var(--text-hi)", marginTop: 3 }}>{value}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, padding: "2px 0" }}>
      <span style={{ color: "var(--text-mid)" }}>{k}</span>
      <span className="num" style={{ color: "var(--text-hi)" }}>{v}</span>
    </div>
  );
}

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
    <th style={{ textAlign: right ? "right" : "left", padding: "9px 14px", fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap", position: "sticky", top: 0, background: "var(--surface-1)" }}>{children}</th>
  );
}

function ErrBox({ msg }: { msg: string }) {
  return <div style={{ ...panel, padding: 16, color: "var(--critical)", display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}><I.Alert size={16} /> {msg}</div>;
}
function LoadBox() {
  return <div style={{ ...panel, padding: 40, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Ładowanie danych…</div>;
}

const kpiGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 };
const panel: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" };
const tbl: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12.5 };
const td: React.CSSProperties = { padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", color: "var(--text-hi)", whiteSpace: "nowrap" };
const warnBox: React.CSSProperties = { ...panel, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--warning)" };
const emptyBox: React.CSSProperties = { padding: 60, textAlign: "center", background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)" };
const emptyIcon: React.CSSProperties = { width: 56, height: 56, margin: "0 auto 16px", borderRadius: 14, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" };
