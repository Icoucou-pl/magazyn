"use client";
// ============================================================
// MAGAZYN — SeasonChart (wspólny). Wykres kalendarzowy Sty–Gru:
//   linia przerywana = cały zeszły rok, gruba kolorowa = ten rok
//   do bieżącego miesiąca. Przełącznik Sztuki / Netto / Brutto
//   (kwoty tylko dla viewFinancials → prop showFin).
//   Dane: GET /manufacturers/{id}/sales-season lub /products/{sku}/sales-season
//   → SeasonPoint[] (year, month 0-11, qty, value_net, value_gross).
//   Używany przez forecast.tsx (modal producenta) i product-modal.tsx.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { fmtNum, fmtPLNk } from "@/lib/format";

export type SeasonPoint = { year: number; month: number; qty: number; value_net: number; value_gross: number };

const AN_MONTHS = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];

type Metric = "qty" | "net" | "gross";

export function SeasonChart({ data, showFin, height = 200, accent = "var(--accent)" }: { data: SeasonPoint[]; showFin: boolean; height?: number; accent?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const [hover, setHover] = useState<number | null>(null);
  const [metric, setMetric] = useState<Metric>("qty");
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const m: Metric = metric !== "qty" && !showFin ? "qty" : metric;
  const isMoney = m !== "qty";
  const now = new Date();
  const yearNow = now.getFullYear();
  const monthNow = now.getMonth(); // 0-based

  const byKey = new Map<string, SeasonPoint>();
  data.forEach((p) => byKey.set(`${p.year}-${p.month}`, p));
  const valAt = (year: number, mo: number): number => {
    const p = byKey.get(`${year}-${mo}`);
    if (!p) return 0;
    return m === "qty" ? p.qty : m === "net" ? p.value_net : p.value_gross;
  };

  const prevVals: number[] = Array.from({ length: 12 }, (_, mo) => valAt(yearNow - 1, mo));
  const curVals: (number | null)[] = Array.from({ length: 12 }, (_, mo) => (mo <= monthNow ? valAt(yearNow, mo) : null));
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

  const fmtFull = (v: number) => (isMoney ? fmtPLNk(v) : `${fmtNum(Math.round(v))} szt`);
  const axisLabel = (v: number) => (isMoney ? `${Math.round(v / 1000)}k` : String(Math.round(v)));

  const onMove = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - pad.l) / iw) * 11);
    if (i >= 0 && i <= 11) setHover(i);
  };

  const tabs: [Metric, string][] = showFin ? [["qty", "Sztuki"], ["net", "Netto"], ["gross", "Brutto"]] : [["qty", "Sztuki"]];

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
              {tabs.map(([k, lab]) => (
                <button key={k} onClick={() => setMetric(k)} style={{
                  padding: "4px 9px", fontSize: 11, fontWeight: 600, border: "none", borderRadius: 5, cursor: "pointer",
                  background: m === k ? "var(--surface-3)" : "transparent",
                  color: m === k ? "var(--text-hi)" : "var(--text-mid)",
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
