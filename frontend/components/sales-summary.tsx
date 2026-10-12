"use client";
// ============================================================
// MAGAZYN — „Podsumowanie sprzedaży" na pulpicie (wzór: panel Sellasista).
//
// Jedna karta, w środku panel na firmę + „Razem" (suma trzech). Każdy panel:
//   · 3 kafelki: liczba zamówień, wartość, średnia wartość — za dziś / 7 / 30 dni,
//   · wykres: słupki = liczba zamówień (oś lewa), linia = wartość w PLN (oś prawa),
//     okno 30 / 60 / 180 dni.
//
// Liczenie jak w Sellasiście, NIE jak w finansach: wszystkie statusy (nowe, za pobraniem…),
// data złożenia zamówienia, kwota brutto z wysyłką → PLN po kursie NBP. Robi to backend
// (services/podsumowanie_sprzedazy.py); tu tylko tniemy okna z jednej pobranej serii.
//
// Firma z Topbara: „Wszyscy" → wszystkie panele, konkretna firma → tylko jej panel.
// Bez viewFinancials backend oddaje value=null — chowamy kwoty i linię wartości.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { Card } from "./ui";
import { api } from "@/lib/api";
import { useShop, SHOP_OPTIONS } from "@/lib/shop";
import { fmtPLN, fmtNum } from "@/lib/format";

type Point = { date: string; orders: number; value: number | null };
type Series = { shop: string; points: Point[]; missing_rates: number };
type Summary = { from: string; to: string; series: Series[]; excluded_statuses?: string[] };

const KPI_OKNA = [{ d: 1, l: "dziś" }, { d: 7, l: "7 dni" }, { d: 30, l: "30 dni" }];
const WYKRES_OKNA = [30, 60, 180];

const BAR = "var(--info)";
const LINE = "var(--accent)";

const nazwa = (shop: string) => (shop ? SHOP_OPTIONS.find((o) => o.v === shop)?.l ?? shop : "Razem");

// Ładne podziałki osi: 0 … max zaokrąglony do 1/2/5 × 10^n, 4 odcinki.
function niceMax(v: number) {
  if (v <= 0) return 1;
  const raw = v / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  return step * 4;
}

const dzienLabel = (iso: string) =>
  new Date(iso + "T12:00:00").toLocaleDateString("pl-PL", { day: "numeric", month: "short" });

function SegBtns<T extends number>({ value, options, onChange }: {
  value: T; options: { v: T; l: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} className="num" style={{
          padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: "pointer", border: "none",
          background: value === o.v ? "var(--surface-3)" : "transparent",
          color: value === o.v ? "var(--text-hi)" : "var(--text-mid)",
        }}>{o.l}</button>
      ))}
    </div>
  );
}

// ── Wykres: słupki (zamówienia) + linia (wartość) ─────────────
function ComboChart({ points, showValue, height = 220 }: { points: Point[]; showValue: boolean; height?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const n = points.length;
  const padL = 34, padR = showValue ? 54 : 10, padT = 10, padB = 24;
  const innerW = Math.max(10, w - padL - padR);
  const innerH = height - padT - padB;
  const maxO = niceMax(Math.max(0, ...points.map((p) => p.orders)));
  const maxV = niceMax(Math.max(0, ...points.map((p) => p.value ?? 0)));
  const slot = innerW / Math.max(1, n);
  const barW = Math.max(1, Math.min(18, slot * 0.6));
  const cx = (i: number) => padL + slot * (i + 0.5);
  const yO = (v: number) => padT + innerH - (v / maxO) * innerH;
  const yV = (v: number) => padT + innerH - (v / maxV) * innerH;
  const linia = points.map((p, i) => `${i === 0 ? "M" : "L"}${cx(i).toFixed(1)},${yV(p.value ?? 0).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // Etykiety dat co ~6 słupków (przy 180 dniach co miesiąc z kawałkiem) — żeby się nie zlewały.
  const co = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 70))));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i = Math.floor((x - padL) / slot);
    setHover(i >= 0 && i < n ? i : null);
  };
  const hp = hover != null ? points[hover] : null;

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w - padR} y1={padT + innerH * (1 - t)} y2={padT + innerH * (1 - t)}
              stroke="var(--border-soft)" strokeDasharray={t === 0 ? undefined : "2,4"} />
            <text x={padL - 6} y={padT + innerH * (1 - t) + 3} fill="var(--text-lo)" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">
              {fmtNum(Math.round(maxO * t))}
            </text>
            {showValue && (
              <text x={w - padR + 6} y={padT + innerH * (1 - t) + 3} fill="var(--text-lo)" fontSize="10" fontFamily="var(--font-mono)">
                {fmtNum(Math.round(maxV * t))}
              </text>
            )}
          </g>
        ))}
        {hover != null && (
          <rect x={padL + slot * hover} y={padT} width={slot} height={innerH} fill="var(--surface-2)" />
        )}
        {points.map((p, i) => (
          <rect key={p.date} x={cx(i) - barW / 2} y={yO(p.orders)} width={barW} height={Math.max(0, padT + innerH - yO(p.orders))}
            rx={Math.min(3, barW / 3)} fill={BAR} opacity={hover == null || hover === i ? 0.45 : 0.25} />
        ))}
        {showValue && <path d={linia} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" />}
        {showValue && n <= 60 && points.map((p, i) => (
          <circle key={p.date} cx={cx(i)} cy={yV(p.value ?? 0)} r={hover === i ? 4.5 : 3} fill={LINE} stroke="var(--surface-1)" strokeWidth={1.5} />
        ))}
        {points.map((p, i) => (i % co === 0 ? (
          <text key={p.date} x={cx(i)} y={height - 6} fill="var(--text-lo)" fontSize="10" textAnchor="middle" fontFamily="var(--font-mono)">
            {dzienLabel(p.date)}
          </text>
        ) : null))}
      </svg>
      {hp && hover != null && (
        <div style={{
          position: "absolute", top: 4, left: Math.min(Math.max(cx(hover) - 80, 4), w - 168),
          background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8,
          padding: "8px 11px", fontSize: 11, color: "var(--text-hi)", pointerEvents: "none", minWidth: 160,
          boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
        }}>
          <div style={{ color: "var(--text-lo)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
            {new Date(hp.date + "T12:00:00").toLocaleDateString("pl-PL", { weekday: "short", day: "numeric", month: "long" })}
          </div>
          <div className="num" style={{ marginTop: 3 }}><span style={{ color: BAR }}>■</span> {fmtNum(hp.orders)} zamówień</div>
          {showValue && <div className="num" style={{ marginTop: 2 }}><span style={{ color: LINE }}>●</span> {fmtPLN(hp.value ?? 0)}</div>}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--text-lo)" }}>{label}</div>
      <div className="num" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {value}
      </div>
    </div>
  );
}

function Panel({ s, kpiDni, wykresDni, showValue }: { s: Series; kpiDni: number; wykresDni: number; showValue: boolean }) {
  const okno = s.points.slice(-kpiDni);
  const zam = okno.reduce((a, p) => a + p.orders, 0);
  const wart = okno.reduce((a, p) => a + (p.value ?? 0), 0);
  return (
    <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "12px 14px 6px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{nazwa(s.shop)}</span>
        {showValue && s.missing_rates > 0 && (
          <span title="Zamówienia w obcej walucie bez kursu NBP — ich kwota nie weszła do wartości."
            style={{ fontSize: 11, color: "var(--warning)", cursor: "help" }}>
            {fmtNum(s.missing_rates)} bez kursu
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: showValue ? "repeat(3, minmax(0, 1fr))" : "1fr", gap: 12, margin: "10px 0 8px" }}>
        <Kpi label="Liczba zamówień" value={fmtNum(zam)} />
        {showValue && <Kpi label="Wartość" value={fmtPLN(wart)} />}
        {showValue && <Kpi label="Średnia wartość" value={zam ? fmtPLN(wart / zam) : "—"} />}
      </div>
      <ComboChart points={s.points.slice(-wykresDni)} showValue={showValue} />
    </div>
  );
}

export default function SalesSummaryCard({ gap = 16 }: { gap?: number }) {
  const { shop } = useShop();
  const [data, setData] = useState<Summary | null>(null);
  const [blad, setBlad] = useState(false);
  const [kpiDni, setKpiDni] = useState(30);
  const [wykresDni, setWykresDni] = useState(30);

  useEffect(() => {
    let alive = true;
    api.get("/sales-summary?days=180")
      .then((r) => { if (alive) setData(r as Summary); })
      .catch(() => { if (alive) setBlad(true); });
    return () => { alive = false; };
  }, []);

  if (blad) return null;   // karta pomocnicza — jak się nie wczyta, reszta pulpitu działa dalej
  const series = (data?.series ?? []).filter((s) => !shop || s.shop === shop);
  const showValue = series.some((s) => s.points.some((p) => p.value != null));
  const pomijane = data?.excluded_statuses ?? [];

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", gap: 12, flexWrap: "wrap", borderBottom: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Podsumowanie sprzedaży</h3>
          <span title={"Jak w Sellasiście: zamówienia wg daty złożenia, w każdym statusie (nowe, za pobraniem, w realizacji…)"
            + (pomijane.length ? ` OPRÓCZ: ${pomijane.join(", ")}` : "") + ". "
            + "Wartość brutto z wysyłką, obce waluty po kursie NBP. Bez hurtu z Fakturowni. To bieżący ruch — nie zrealizowana sprzedaż z Finansów."}
            style={{ color: "var(--text-lo)", cursor: "help", fontSize: 12 }}>ⓘ</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text-lo)" }}>kafelki</span>
          <SegBtns value={kpiDni} options={KPI_OKNA.map((o) => ({ v: o.d, l: o.l }))} onChange={setKpiDni} />
          <span style={{ fontSize: 11, color: "var(--text-lo)", marginLeft: 6 }}>wykres</span>
          <SegBtns value={wykresDni} options={WYKRES_OKNA.map((d) => ({ v: d, l: `${d} dni` }))} onChange={setWykresDni} />
        </div>
      </div>
      <div style={{ padding: 14 }}>
        {!data ? (
          <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-lo)", fontSize: 12 }}>Wczytuję…</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 480px), 1fr))", gap }}>
            {series.map((s) => <Panel key={s.shop || "razem"} s={s} kpiDni={kpiDni} wykresDni={wykresDni} showValue={showValue} />)}
          </div>
        )}
        {data && showValue && (
          <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 10, fontSize: 11, color: "var(--text-mid)" }}>
            <span><span style={{ color: LINE }}>●</span> Wartość zamówień (PLN)</span>
            <span><span style={{ color: BAR, opacity: 0.6 }}>■</span> Liczba zamówień</span>
          </div>
        )}
        {data && pomijane.length > 0 && (
          <div style={{ textAlign: "center", marginTop: 6, fontSize: 11, color: "var(--text-lo)" }}>
            Wszystkie statusy oprócz: {pomijane.join(", ")}
          </div>
        )}
      </div>
    </Card>
  );
}
