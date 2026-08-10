"use client";
// ============================================================
// MAGAZYN — Dashboard (etap 1). Port dashboard.jsx → .tsx.
//   Dane z realnego API (Promise.allSettled):
//   /stock-value-history · /classification · /containers · /anomalies · /shopping-list · /top-sellers
//
//   Konwencja list: każda karta pokazuje 5 wierszy, reszta po kliknięciu "Wszystkie"
//   (rozwijanie W MIEJSCU, bez nawigacji). Patrz: ExpandFooter + useExpandable.
//
//   Sklep (AMH/Acti/Veluxa) filtruje też kontenery: kontener nie ma własnej firmy,
//   więc backend dokleja firma_breakdown (slug -> {items, units, value}) liczone
//   z pozycji: sku -> product_attrs.firma_id. KPI "W drodze" pokazuje wtedy wartość
//   TYLKO towaru danej firmy, a lista dostaw — kontenery, które ten towar wiozą.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  I, Card, CardHeader, HoverRow, Pill, StatusPill, MfrChip, CONTAINER_STATUS_META, ContainerNr,
} from "./ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { can, canEdit, useUser } from "@/lib/permissions";
import { fmtPLN, fmtPLNk, fmtNum, fmtPct } from "@/lib/format";
import WyprzedazModal from "./wyprzedaz-modal";
import type { Product } from "./products-ui";

// ── Typy odpowiedzi API ──────────────────────────────────────
type StockPoint = { date: string; value: number; units: number };
type StockHistory = { points: StockPoint[]; current_value: number; current_units?: number };
type Classification = {
  counts: { ACTIVE: number; ACTIVE_NO_STOCK: number; DEAD_STOCK: number; INACTIVE: number };
  dead_stock_value_pln: number;
  total: number;
};
type FirmaShare = {
  slug: string;
  name: string | null;
  color: string | null;
  items: number;
  units: number;
  value: number;
};
type ContainerOut = {
  id: number;
  container_number: string;
  manufacturer_id: number | null;
  manufacturer_name: string | null;
  manufacturer_color: string | null;
  eta_date: string;
  status: string;
  effective_status?: string;
  is_auto?: boolean;
  customs_days_left?: number | null;
  items: unknown[];
  total_units: number;
  total_value: number;
  is_consolidated?: boolean;
  subiekt_wbite?: boolean | null;
  lots?: { id: number; total_value: number; subiekt_wbite?: boolean | null; firma_breakdown?: Record<string, FirmaShare>;
           zaplacono_pln?: number; pozostalo_pln?: number; do_zaplacenia_pln?: number; brak_kursu?: number }[];
  // Płatności przeliczone na PLN po kursie NBP z dnia poprzedzającego wpłatę (liczy backend).
  zaplacono_pln?: number;
  pozostalo_pln?: number;
  do_zaplacenia_pln?: number;
  brak_kursu?: number;
  firma_breakdown?: Record<string, FirmaShare>;   // slug -> udział firmy (może nie przyjść ze starego backendu)
  expected_delivery_date?: string | null;          // „u nas" — umówiona data odbioru
  warehouse_delivery_date?: string | null;         // data wejścia na magazyn (delivered/expected/ETA+odprawa)
};
type Anomaly = {
  sku: string; name: string;
  severity: "high" | "medium" | "low";
  type: string; message: string;
  sales_1m: number; sales_3m_avg: number; change_pct: number;
};
type ShoppingProduct = {
  sku: string; name: string; stock: number; stock_in_transit: number;
  avg_monthly: number; recommended_quantity: number; status: string; days_until_empty: number;
  transfer_source_shop?: string | null; transfer_source_qty?: number;
};
type ShoppingGroup = {
  manufacturer_id: number | null;
  manufacturer_name: string | null;
  manufacturer_color: string | null;
  manufacturer_email: string | null;
  products: ShoppingProduct[];
  total_skus: number;
};
type TopSeller = {
  sku: string; name: string; status: string; stock: number; days_until_empty: number;
  sales_1m: number; sales_yoy_30d: number; avg_monthly: number;
  manufacturer_name: string | null; manufacturer_color: string | null;
};

type ClickTarget = { sku: string; name?: string };

type Tone = "neutral" | "accent" | "ok" | "warning" | "critical" | "info";

// ── KPI card ─────────────────────────────────────────────────
// „i" w kółku obok kwoty — tooltip po najechaniu (natywny title, jak reszta hoverów).
function InfoDot({ title }: { title: string }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", color: "var(--text-lo)", cursor: "help", flexShrink: 0 }}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    </span>
  );
}

function KpiCard({
  label, value, sub, change, tone = "neutral", icon, sparkData, valueInfo,
}: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  change?: number; tone?: Tone; icon?: React.ReactNode; sparkData?: number[];
  valueInfo?: string;
}) {
  const toneColor: Record<Tone, string> = {
    neutral: "var(--text-hi)",
    accent: "var(--accent)",
    ok: "var(--ok)",
    warning: "var(--warning)",
    critical: "var(--critical)",
    info: "var(--info)",
  };
  const c = toneColor[tone];
  const changePositive = (change ?? 0) >= 0;
  const changeColor = change == null ? "var(--text-lo)"
    : (tone === "critical" || tone === "warning") ? (changePositive ? "var(--critical)" : "var(--ok)")
      : (changePositive ? "var(--ok)" : "var(--critical)");

  return (
    <div style={{
      background: "var(--surface-1)",
      border: "1px solid var(--border-soft)",
      borderRadius: "var(--r-lg)",
      padding: "16px 18px",
      position: "relative", overflow: "hidden", minHeight: 124,
      display: "flex", flexDirection: "column", justifyContent: "space-between",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>{label}</span>
        {icon && <span style={{ color: "var(--text-lo)", opacity: 0.65 }}>{icon}</span>}
      </div>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span className="num" style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-0.02em", color: c, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</span>
          {valueInfo && <InfoDot title={valueInfo} />}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, overflow: "hidden" }}>
            {change != null && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, fontWeight: 600, color: changeColor, flexShrink: 0 }} className="num">
                {changePositive ? "▲" : "▼"} {Math.abs(change).toFixed(1).replace(".", ",")}%
              </span>
            )}
            {sub && <span style={{ fontSize: 11, color: "var(--text-lo)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span>}
          </div>
          {sparkData && sparkData.length > 1 && <Sparkline points={sparkData} color={c} />}
        </div>
      </div>
    </div>
  );
}

function Sparkline({ points, color }: { points: number[]; color: string }) {
  const w = 72, h = 22;
  const max = Math.max(...points), min = Math.min(...points);
  const range = max - min || 1;
  const path = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} style={{ opacity: 0.5, flexShrink: 0 }}>
      <path d={path} stroke={color} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Wykres wartości magazynu ─────────────────────────────────
function StockValueChart({ points, metric = "value", height = 220 }: { points: StockPoint[]; metric?: "value" | "units"; height?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 800, h: height });

  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setSize({ w, h: height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [height]);

  if (points.length < 2) {
    return <div ref={ref} style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-lo)", fontSize: 12 }}>Brak danych do wykresu</div>;
  }

  const val = (p: StockPoint) => (metric === "value" ? p.value : p.units);
  const fmtTick = (n: number) => (metric === "value" ? fmtPLNk(n) : fmtNum(n));
  const fmtFull = (n: number) => (metric === "value" ? fmtPLN(n) : `${fmtNum(n)} szt`);

  const values = points.map(val);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const padTop = 20, padBot = 30, padLeft = 8, padRight = 8;
  const innerH = size.h - padTop - padBot;
  const innerW = size.w - padLeft - padRight;

  const getX = (i: number) => padLeft + (i / (points.length - 1)) * innerW;
  const getY = (v: number) => padTop + innerH - ((v - min) / range) * innerH;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${getX(i).toFixed(1)},${getY(val(p)).toFixed(1)}`).join(" ");
  const areaPath = linePath + ` L${getX(points.length - 1).toFixed(1)},${padTop + innerH} L${getX(0).toFixed(1)},${padTop + innerH} Z`;

  const valueChange = val(points[points.length - 1]) - val(points[0]);
  const positive = valueChange >= 0;
  const stroke = positive ? "var(--ok)" : "var(--critical)";
  const fill = positive ? "url(#chartGradOk)" : "url(#chartGradBad)";

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round(((x - padLeft) / innerW) * (points.length - 1));
    if (idx >= 0 && idx < points.length) setHover(idx);
  };

  const ticks = [min + range * 0.25, min + range * 0.5, min + range * 0.75, max];

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <svg width={size.w} height={size.h} onMouseMove={handleMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        <defs>
          <linearGradient id="chartGradOk" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.730 0.150 155)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="oklch(0.730 0.150 155)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="chartGradBad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.640 0.190 25)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="oklch(0.640 0.190 25)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.slice(0, -1).map((t, i) => (
          <line key={i} x1={padLeft} x2={size.w - padRight} y1={getY(t)} y2={getY(t)} stroke="var(--border-soft)" strokeDasharray="2,4" strokeWidth="1" />
        ))}
        <path d={areaPath} fill={fill} />
        <path d={linePath} stroke={stroke} strokeWidth="2" fill="none" strokeLinejoin="round" />
        {hover != null && (
          <g>
            <line x1={getX(hover)} x2={getX(hover)} y1={padTop} y2={padTop + innerH} stroke="var(--text-lo)" strokeDasharray="2,3" strokeWidth="1" />
            <circle cx={getX(hover)} cy={getY(val(points[hover]))} r="4" fill={stroke} stroke="var(--bg)" strokeWidth="2" />
          </g>
        )}
        {ticks.map((t, i) => (
          <text key={i} x={size.w - padRight} y={getY(t) - 4} fill="var(--text-lo)" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">{fmtTick(t)}</text>
        ))}
        <text x={padLeft} y={size.h - 8} fill="var(--text-lo)" fontSize="10" fontFamily="var(--font-mono)">
          {new Date(points[0].date).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}
        </text>
        <text x={size.w / 2} y={size.h - 8} fill="var(--text-lo)" fontSize="10" textAnchor="middle" fontFamily="var(--font-mono)">
          {new Date(points[Math.floor(points.length / 2)].date).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}
        </text>
        <text x={size.w - padRight} y={size.h - 8} fill="var(--text-lo)" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">
          {new Date(points[points.length - 1].date).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}
        </text>
      </svg>
      {hover != null && (
        <div style={{
          position: "absolute",
          left: Math.min(Math.max(getX(hover) - 80, 8), size.w - 168),
          top: 8,
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "8px 11px", fontSize: 11, color: "var(--text-hi)",
          pointerEvents: "none", minWidth: 160, boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
        }}>
          <div style={{ color: "var(--text-lo)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
            {new Date(points[hover].date).toLocaleDateString("pl-PL", { weekday: "short", day: "numeric", month: "long" })}
          </div>
          <div className="num" style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{fmtFull(val(points[hover]))}</div>
        </div>
      )}
    </div>
  );
}

// ── KPI grid ─────────────────────────────────────────────────
// Podział kontenera na część „w Subiekcie" (zielona) i „w apce" (czerwona) — dla KPI i liczników.
// shop="" → całość; shop=slug → wartość i liczniki CZERWONE zawężone do towaru tej firmy
// (per lot, z lot_firma_breakdown). Zielona strona (magazyn w drodze) liczona globalnie —
// jej wartość i tak bierze się z tabeli subiektowej (AMH), a licznik pokazujemy tylko dla AMH.
function splitSubiekt(c: ContainerOut, shop: string) {
  const lots = c.lots ?? [];
  const consolidated = !!c.is_consolidated && lots.length > 0;
  const carries = (fb?: Record<string, FirmaShare>) => !shop || ((fb?.[shop]?.units ?? 0) > 0);
  const redValOf = (fb: Record<string, FirmaShare> | undefined, total: number) => shop ? (fb?.[shop]?.value ?? 0) : total;

  // Udział sklepu w wartości — tym samym współczynnikiem skalujemy kwoty płatności,
  // żeby przy zakładce Acti/Veluxa karty pokazywały część przypadającą na ten sklep.
  // Udział sklepu, po wartości. Gdy wartość kontenera jest zerowa (SKU spoza katalogu,
  // brak cen jednostkowych) wartość nie nadaje się na miarę — schodzimy na sztuki,
  // inaczej cała wpłata przepadłaby przez mnożenie przez zero.
  const ratioOf = (fb: Record<string, FirmaShare> | undefined, total: number) => {
    if (!shop) return 1;
    if (total > 0) return (fb?.[shop]?.value ?? 0) / total;
    const units = Object.values(fb ?? {}).reduce((s, f) => s + (f.units ?? 0), 0);
    return units > 0 ? (fb?.[shop]?.units ?? 0) / units : 0;
  };

  if (consolidated) {
    const green = lots.filter((l) => !!l.subiekt_wbite);
    const red = lots.filter((l) => !l.subiekt_wbite);
    const redValue = red.reduce((s, l) => s + redValOf(l.firma_breakdown, l.total_value || 0), 0);
    const redRemaining = red.reduce((s, l) => s + (l.do_zaplacenia_pln ?? 0) * ratioOf(l.firma_breakdown, l.total_value || 0), 0);
    const greenPaid = green.reduce((s, l) => s + (l.zaplacono_pln ?? 0) * ratioOf(l.firma_breakdown, l.total_value || 0), 0);
    const greenRemaining = green.reduce((s, l) => s + (l.do_zaplacenia_pln ?? 0) * ratioOf(l.firma_breakdown, l.total_value || 0), 0);
    const missingRates = lots.reduce((s, l) => s + (l.brak_kursu ?? 0), 0);
    const relevant = lots.filter((l) => carries(l.firma_breakdown));
    const redRel = red.filter((l) => carries(l.firma_breakdown));
    const redWhole = redRel.length > 0 && redRel.length === relevant.length;
    const looseRed = (redRel.length > 0 && redRel.length < relevant.length) ? redRel.length : 0;
    // Zielona strona liczona tak samo jak czerwona — tylko loty wiozące towar tej firmy.
    // Wcześniej ignorowała `shop`, przez co licznik kontenerów był globalny.
    const greenRel = green.filter((l) => carries(l.firma_breakdown));
    const greenWhole = greenRel.length > 0 && greenRel.length === relevant.length;
    const looseGreen = (greenRel.length > 0 && greenRel.length < relevant.length) ? greenRel.length : 0;
    return { redValue, redWhole, looseRed, greenWhole, looseGreen, redRemaining, greenPaid, greenRemaining, missingRates };
  }
  const isRed = !c.subiekt_wbite;
  const rel = carries(c.firma_breakdown);
  const ratio = ratioOf(c.firma_breakdown, c.total_value || 0);
  return {
    redValue: isRed ? redValOf(c.firma_breakdown, c.total_value || 0) : 0,
    redWhole: isRed && rel,
    looseRed: 0,
    greenWhole: !isRed && rel,
    looseGreen: 0,
    redRemaining: isRed ? (c.do_zaplacenia_pln ?? 0) * ratio : 0,
    greenPaid: isRed ? 0 : (c.zaplacono_pln ?? 0) * ratio,
    greenRemaining: isRed ? 0 : (c.do_zaplacenia_pln ?? 0) * ratio,
    missingRates: c.brak_kursu ?? 0,
  };
}

const _plPick = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) ? few : many;
// „39 kontenerów" albo „34 kontenery + 5 lotów" (luźne loty z kontenerów mieszanych).
function countLabel(containers: number, looseLots: number): string {
  const parts: string[] = [];
  if (containers > 0 || looseLots === 0) parts.push(`${containers} ${_plPick(containers, "kontener", "kontenery", "kontenerów")}`);
  if (looseLots > 0) parts.push(`${looseLots} ${_plPick(looseLots, "lot", "loty", "lotów")}`);
  return parts.join(" + ");
}

// Kropka na liście dostaw (wariant C): zielony = w Subiekcie, czerwony = w apce, żółty = mieszany.
function subiektRowState(c: ContainerOut): "green" | "red" | "mixed" {
  const s = splitSubiekt(c, "");
  if (s.greenWhole) return "green";
  if (s.redWhole) return "red";
  return "mixed";
}
const SUBIEKT_ROW_META = {
  green: { color: "var(--ok)", label: "w Subiekcie" },
  red: { color: "var(--critical)", label: "w apce" },
  mixed: { color: "var(--warning)", label: "mieszany" },
} as const;

// Nazwa ERP zależna od firmy kontenera (dominującej): AMH → Subiekt, Acti/Veluxa → Fakturownia.
function erpLocOf(c: ContainerOut): string {
  const fb = c.firma_breakdown || {};
  let best = "amh", bestU = -1;
  for (const [slug, share] of Object.entries(fb)) {
    const u = (share as FirmaShare | undefined)?.units ?? 0;
    if (u > bestU) { bestU = u; best = slug.toLowerCase(); }
  }
  return best === "amh" ? "Subiekcie" : "Fakturowni";
}

function KpiGrid({
  history, kont, mag, shop, missingRates, onRefillRates,
}: {
  history: StockHistory | null;
  kont: { value: number; containers: number; looseLots: number; remaining: number };
  mag: { value: number; containers: number; looseLots: number; paid: number; remaining: number };
  shop: string;                    // "" = wszystkie sklepy
  missingRates: number;            // wpłaty bez notowania NBP (nie weszły do sum)
  onRefillRates: () => void;
}) {
  const user = useUser();
  const showFin = can(user, "viewFinancials");
  const pts = history?.points ?? [];
  const stockValue = history?.current_value ?? 0;
  // „vs 90 dni temu": szereg sięga teraz aż do 01.01.2026, więc pts[0] to już NIE 90 dni temu.
  // Bierzemy punkt sprzed dokładnie 90 dni po indeksie, żeby etykieta i delta pozostały prawdziwe.
  const base90 = pts.length > 91 ? pts[pts.length - 1 - 90].value : (pts[0]?.value ?? 0);
  const change90 = pts.length > 1 ? ((stockValue - base90) / (base90 || 1)) * 100 : undefined;
  const sparkLast30 = pts.slice(-30).map((p) => p.value);
  // Karta „Magazyn w drodze" liczona spójnie z JEDNEGO źródła — płatności kontenerowe:
  //   główna = zapłacone (Σ zaliczek + balance zielonych, skalowane udziałem sklepu),
  //   „do zapłacenia" = suma NIEZAPŁACONYCH zaliczek i balansów tych samych zielonych
  //   kontenerów (backend: do_zaplacenia_pln, kwoty bez daty zapłaty, kurs dzisiejszy),
  //   skalowana udziałem sklepu. Liczone live per firma; „magazyn w drodze" (greenPaid)
  //   bez zmian. Wcześniej było greenRemaining = wartość_towaru − zapłacone (zła metoda).
  const magPaidLabel = fmtPLNk(mag.paid);
  const magToPay = fmtPLNk(mag.remaining);
  const magSub = `do zapłacenia ${magToPay}`;
  const magSubCount = countLabel(mag.containers, mag.looseLots);   // wariant bez kwoty (maskowany)
  // „W Prognozie" (czerwone = jeszcze nie w Subiekcie): niezapłacone zaliczki+balance tych
  // kontenerów (do_zaplacenia_pln, kwoty bez daty zapłaty, kurs dzisiejszy), skalowane udziałem
  // sklepu — symetrycznie do „do zapłacenia" zielonych. Pod spodem tylko liczba kontenerów.
  const kontSub = countLabel(kont.containers, kont.looseLots);
  const kapital = stockValue + mag.paid;   // kapitał w towarze: magazyn + zapłacone w drodze

  return (
    <>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
      {showFin ? (
        <KpiCard label="Kapitał w towarze" value={fmtPLNk(kapital)} sub="magazyn + zapłacone w drodze" tone="accent" icon={<I.Wallet size={14} />} />
      ) : (
        <KpiCard label="Kapitał w towarze" value="•••••" sub="magazyn + zapłacone w drodze" tone="accent" icon={<I.Wallet size={14} />} />
      )}
      {showFin ? (
        <KpiCard label="Wartość magazynu" value={fmtPLNk(stockValue)} change={change90} sub="vs 90 dni temu" tone="neutral" sparkData={sparkLast30} icon={<I.Box size={14} />} />
      ) : (
        <KpiCard label="Wartość magazynu" value="•••••" sub="ukryte — brak uprawnień" tone="neutral" icon={<I.Box size={14} />} />
      )}
      {showFin ? (
        <KpiCard label="Magazyn w drodze" value={magPaidLabel} valueInfo="Suma opłaconych zaliczek i balance" sub={magSub} tone="info" icon={<I.Container size={14} />} />
      ) : (
        <KpiCard label="Magazyn w drodze" value="•••••" sub={magSubCount} tone="info" icon={<I.Container size={14} />} />
      )}
      {showFin ? (
        <KpiCard label="W Prognozie" value={fmtPLNk(kont.remaining)} sub={kontSub} tone="info" icon={<I.Ship size={14} />} />
      ) : (
        <KpiCard label="W Prognozie" value="•••••" sub={kontSub} tone="info" icon={<I.Ship size={14} />} />
      )}
    </div>
    {showFin && missingRates > 0 && (
      // Wpłaty bez notowania NBP nie weszły do sum — mówimy o tym wprost, zamiast po cichu
      // zaniżać „zapłacone". Klik dociąga brakujące kursy z NBP (idempotentnie).
      <button
        onClick={onRefillRates}
        style={{
          marginTop: 8, display: "flex", alignItems: "center", gap: 7, width: "100%",
          padding: "8px 12px", borderRadius: 8, cursor: "pointer", textAlign: "left",
          background: "color-mix(in oklch, var(--warning) 10%, transparent)",
          border: "1px solid color-mix(in oklch, var(--warning) 35%, transparent)",
          color: "var(--warning)", fontSize: 11.5, fontWeight: 600,
        }}
      >
        <I.Alert size={13} />
        {missingRates} {_plPick(missingRates, "wpłata", "wpłaty", "wpłat")} bez kursu NBP — kwoty zaniżone. Kliknij, żeby dociągnąć.
      </button>
    )}
    </>
  );
}

// ── Pomocnicze: daty YYYY-MM-DD, arytmetyka w UTC (bez dryfu stref) ──
const DASH_MIN_DATE = "2026-01-01";               // najwcześniejszy wybieralny dzień
const _dToUTC = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const _dFromUTC = (ms: number) => {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
};
const _dAddDays = (iso: string, n: number) => _dFromUTC(_dToUTC(iso) + n * 86400000);
const _dSpan = (a: string, b: string) => Math.round((_dToUTC(b) - _dToUTC(a)) / 86400000) + 1; // dni włącznie
const _dLabel = (iso: string) => { const [, m, d] = iso.split("-"); return `${d}.${m}`; };       // „05.03"

// ── Wykres (karta z pickerem dat + preset 30D) ─────────────────────
//   Jeden fetch (01.01.2026 → dziś) leży w `points`; picker i porównanie TNĄ tę tablicę
//   po stronie klienta — zero dodatkowych zapytań do backendu.
//   Porównanie (Wariant A): poprzednie okno TEJ SAMEJ długości, cofnięte o tyle samo DNI
//   (prev = [from−N, from−1]). Jeśli prev wychodzi przed 01.01.2026 → chip zamienia się w notatkę.
function ValueChartCard({ points, canFin }: { points: StockPoint[]; canFin: boolean }) {
  const [metricSel, setMetricSel] = useState<"value" | "units">(canFin ? "value" : "units");
  const metric: "value" | "units" = canFin ? metricSel : "units";

  // Granice pickera z danych: min = pierwszy punkt (≈01.01.2026), max = ostatni (dziś wg serwera).
  const dataMin = points.length ? points[0].date : DASH_MIN_DATE;
  const dataMax = points.length ? points[points.length - 1].date : DASH_MIN_DATE;
  const minDate = dataMin < DASH_MIN_DATE ? DASH_MIN_DATE : dataMin;

  // Domyślnie po wejściu: pełny zakres 01.01.2026 → dziś (auto-wybrany).
  const [from, setFrom] = useState<string>(minDate);
  const [to, setTo] = useState<string>(dataMax);

  // Gdy dane się zmienią (przełączenie sklepu) — dosuwamy zakres do świeżych granic, ale tylko
  // jeśli user trzyma domyślny pełny zakres; ręcznego wyboru nie nadpisujemy.
  const fullRef = useRef(true);
  useEffect(() => {
    if (fullRef.current) { setFrom(minDate); setTo(dataMax); }
  }, [minDate, dataMax]);

  const apply = (f: string, t: string, isFull: boolean) => { fullRef.current = isFull; setFrom(f); setTo(t); };
  const onFrom = (v: string) => { const f = v < minDate ? minDate : v > to ? to : v; apply(f, to, false); };
  const onTo = (v: string) => { const t = v > dataMax ? dataMax : v < from ? from : v; apply(from, t, false); };
  const from30 = _dAddDays(dataMax, -29) < minDate ? minDate : _dAddDays(dataMax, -29);
  const preset30 = () => apply(from30, dataMax, false);
  const is30 = from === from30 && to === dataMax;

  // Wybrane okno (włącznie), cięte z jednej pobranej tablicy.
  const sliced = points.filter((p) => p.date >= from && p.date <= to);
  const val = (p?: StockPoint) => (p ? (metric === "value" ? p.value : p.units) : 0);
  const last = val(sliced[sliced.length - 1]);
  const isFullDefault = from === minDate && to === dataMax;

  // Porównanie do poprzedniego okna tej samej długości.
  const N = _dSpan(from, to);
  const prevFrom = _dAddDays(from, -N);
  const prevTo = _dAddDays(from, -1);               // koniec poprzedniego okna
  const hasCompare = !isFullDefault && prevFrom >= minDate;
  const byDate = (iso: string) => points.find((p) => p.date === iso);
  const endPrev = val(byDate(prevTo));              // wartość na końcu poprzedniego okna
  const change = last - endPrev;
  const pct = endPrev ? (change / endPrev) * 100 : 0;
  const positive = change >= 0;

  const title = metric === "value" ? "Wartość magazynu" : "Liczba sztuk";
  const fmtBig = (n: number) => (metric === "value" ? fmtPLN(n) : `${fmtNum(n)} szt`);
  const fmtDelta = (n: number) => (metric === "value" ? fmtPLNk(n) : `${fmtNum(n)} szt`);

  const segBtn = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: "pointer",
    background: active ? "var(--surface-3)" : "transparent",
    color: active ? "var(--text-hi)" : "var(--text-mid)", border: "none",
  });
  const dateInput: React.CSSProperties = {
    padding: "4px 8px", fontSize: 11, fontWeight: 600, borderRadius: 6,
    background: "var(--surface-2)", color: "var(--text-hi)",
    border: "1px solid var(--border)", colorScheme: "dark",
  };

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 20px 12px", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>{title}</span>
            <Pill bg="var(--surface-2)" fg="var(--text-mid)" size="sm" mono>{_dLabel(from)}–{_dLabel(to)}</Pill>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
            <div className="num" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{fmtBig(last)}</div>
            {hasCompare ? (
              <span className="num" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, fontWeight: 600, color: positive ? "var(--ok)" : "var(--critical)" }}>
                {positive ? <I.TrendUp size={13} /> : <I.TrendDown size={13} />}
                {positive ? "+" : ""}{fmtDelta(change)} ({fmtPct(pct)})
                <span style={{ color: "var(--text-lo)", fontWeight: 500 }}>vs {_dLabel(prevFrom)}–{_dLabel(prevTo)}</span>
              </span>
            ) : (
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-lo)" }}>
                {isFullDefault ? "Wybierz zakres dat, aby zobaczyć zmiany w magazynie." : "Brak zakresu dat do porównania."}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {canFin && (
            <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
              <button onClick={() => setMetricSel("value")} style={segBtn(metric === "value")}>zł</button>
              <button onClick={() => setMetricSel("units")} style={segBtn(metric === "units")}>szt</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="date" value={from} min={minDate} max={to} onChange={(e) => onFrom(e.target.value)} style={dateInput} />
            <span style={{ color: "var(--text-lo)", fontSize: 11 }}>–</span>
            <input type="date" value={to} min={from} max={dataMax} onChange={(e) => onTo(e.target.value)} style={dateInput} />
          </div>
          <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
            <button onClick={preset30} className="num" style={segBtn(is30)}>30D</button>
          </div>
        </div>
      </div>
      <div style={{ padding: "0 8px 4px" }}>
        <StockValueChart points={sliced} metric={metric} height={220} />
      </div>
    </Card>
  );
}

// ── Rozwijanie list w miejscu (5 wierszy → wszystkie) ────────
const ROW_LIMIT = 5;

function useExpandable<T>(list: T[], limit: number = ROW_LIMIT) {
  const [open, setOpen] = useState(false);
  const shown = open ? list : list.slice(0, limit);
  const hidden = Math.max(0, list.length - limit);
  return { shown, hidden, open, toggle: () => setOpen((v) => !v) };
}

function ExpandFooter({ hidden, open, onToggle }: { hidden: number; open: boolean; onToggle: () => void }) {
  if (hidden === 0) return null;
  return (
    <button onClick={onToggle} style={{
      width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
      padding: "10px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer",
      background: "transparent", color: "var(--text-mid)",
      border: "none", borderTop: "1px solid var(--border-soft)",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; e.currentTarget.style.color = "var(--text-hi)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-mid)"; }}>
      {open ? "Pokaż mniej" : <>Wszystkie <span className="num">({hidden} więcej)</span></>}
      <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.18s" }}>
        <I.ChevronD size={13} />
      </span>
    </button>
  );
}

// Kontener rozwinięty do pełnej listy nie może rozjechać strony — scroll po przekroczeniu.
const listScroll = (open: boolean): React.CSSProperties =>
  open ? { maxHeight: 420, overflowY: "auto" } : {};

// ── Pożary ───────────────────────────────────────────────────
function FiresCard({ fires, onProductClick, onNoReorder }: { fires: ShoppingProduct[]; onProductClick?: (p: ClickTarget) => void; onNoReorder?: (sku: string) => void }) {
  // Pożary mają niższe wiersze niż sąsiadujący box dostaw — mieści się 6 (footer i tak jest przypięty na dole).
  const { shown, hidden, open, toggle } = useExpandable(fires, 6);
  return (
    <Card style={{ display: "flex", flexDirection: "column" }}>
      <CardHeader icon={<I.Flame size={16} />} title="Pożary" hint={`${fires.length} pozycji`} accent="var(--critical)" />
      <div style={{ flex: 1, ...listScroll(open) }}>
        {shown.map((p, i) => (
          <HoverRow key={p.sku} onClick={() => onProductClick?.(p)} style={i === shown.length - 1 ? { borderBottom: "none" } : undefined}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
              <StatusPill status={p.status} size="sm" />
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>{p.sku}</span>
              {(p.transfer_source_qty ?? 0) > 0 && (
                <span title={`${p.transfer_source_qty} szt na stanie w ${p.transfer_source_shop} — nie zamawiaj z Chin, zaciągnij z magazynu grupy`}
                  style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 5, background: "var(--info-soft)", color: "var(--info)", whiteSpace: "nowrap" }}>
                  ↔ z {p.transfer_source_shop}: {p.transfer_source_qty}
                </span>
              )}
              {p.stock_in_transit > 0 && (
                <span title={`${p.stock_in_transit} szt już w drodze — ale za mało na miesiąc; zamów tylko brakującą różnicę`}
                  style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 5, background: "var(--info-soft)", color: "var(--info)", whiteSpace: "nowrap" }}>
                  +{p.stock_in_transit} w drodze
                </span>
              )}
              <span style={{ fontSize: 12, color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{p.name}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
              <div style={{ textAlign: "right" }}>
                <div className="num" style={{ fontSize: 12, fontWeight: 600 }}>{p.stock} szt</div>
                <div className="num" style={{ fontSize: 10, color: "var(--text-lo)" }}>{Math.round(p.avg_monthly)}/mies</div>
              </div>
              <div style={{ textAlign: "right", minWidth: 70 }}>
                <div className="num" style={{ fontSize: 12, fontWeight: 600, color: p.days_until_empty <= 7 ? "var(--critical)" : "var(--warning)" }}>
                  {p.days_until_empty === 0 ? "BRAK" : `${p.days_until_empty}d`}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-lo)" }}>do końca</div>
              </div>
              {onNoReorder && (
                <button
                  onClick={(e) => { e.stopPropagation(); onNoReorder(p.sku); }}
                  title="Nie dozamawiamy — ukryj z pożarów i zamawiania (odwracalne w karcie produktu)"
                  style={{ flexShrink: 0, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-disabled)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-3)"; e.currentTarget.style.color = "var(--text-mid)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-disabled)"; }}
                >✕</button>
              )}
            </div>
          </HoverRow>
        ))}
        {fires.length === 0 && <EmptyRow text="Brak pilnych pozycji" />}
      </div>
      <ExpandFooter hidden={hidden} open={open} onToggle={toggle} />
    </Card>
  );
}

// ── Najbliższe dostawy ───────────────────────────────────────
function DeliveriesCard({
  deliveries, shop, onContainerClick,
}: {
  deliveries: ContainerOut[];
  shop: string;                       // "" = wszystkie sklepy
  onContainerClick?: (c: ContainerOut) => void;
}) {
  const { shown, hidden, open, toggle } = useExpandable(deliveries);
  return (
    <Card style={{ display: "flex", flexDirection: "column" }}>
      <CardHeader icon={<I.Ship size={16} />} title="Najbliższe dostawy"
        hint={shop ? `${deliveries.length} kontenerów z towarem ${shop.toUpperCase()}` : `${deliveries.length} kontenerów`}
        accent="var(--info)" />
      <div style={{ flex: 1, ...listScroll(open) }}>
        {shown.map((c, i) => {
          const days = Math.ceil((new Date(c.eta_date).getTime() - Date.now()) / 86400000);
          const eStatus = c.effective_status ?? c.status;
          const meta = CONTAINER_STATUS_META[eStatus];
          // Przy wybranym sklepie pokazujemy UDZIAŁ tej firmy w kontenerze, nie całość
          // (kontener bywa mieszany — zwłaszcza skonsolidowany).
          const share = shop ? c.firma_breakdown?.[shop] : undefined;
          // Przy „Wszystkie" (bez wybranego sklepu) pokazujemy tagi wszystkich firm obecnych w kontenerze.
          const allFirmas = !shop && c.firma_breakdown
            ? Object.values(c.firma_breakdown).filter((f) => f.units > 0)
            : [];
          const itemsCount = c.items.length;
          const subSt = subiektRowState(c);
          const subMeta = SUBIEKT_ROW_META[subSt];
          return (
            <HoverRow key={c.id} onClick={() => onContainerClick?.(c)} style={i === shown.length - 1 ? { borderBottom: "none" } : undefined}>
              <div style={{ width: 4, height: 32, background: meta?.dot ?? "var(--text-lo)", borderRadius: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span title={`Magazyn w drodze: ${subSt === "green" ? `w ${erpLocOf(c)}` : subMeta.label}`} style={{ width: 9, height: 9, borderRadius: 99, background: subMeta.color, flexShrink: 0, boxShadow: `0 0 0 2px color-mix(in oklch, ${subMeta.color} 22%, transparent)` }} />
                  <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.manufacturer_name || "—"}</span>
                  {share && (
                    <Pill bg="var(--surface-2)" fg={share.color ?? "var(--text-mid)"} size="sm" dot={share.color ?? undefined}>
                      {share.name ?? share.slug.toUpperCase()}
                    </Pill>
                  )}
                  {allFirmas.map((f) => (
                    <Pill key={f.slug} bg="var(--surface-2)" fg={f.color ?? "var(--text-mid)"} size="sm" dot={f.color ?? undefined}>
                      {f.name ?? f.slug.toUpperCase()}
                    </Pill>
                  ))}
                </div>
                <div style={{ marginTop: 2 }}><ContainerNr c={c} size={10.5} color="var(--text-lo)" /></div>
                <div className="num" style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>
                  {share
                    ? <>{share.items} SKU · {fmtNum(share.units)} szt</>
                    : <>{itemsCount} SKU · {fmtNum(c.total_units)} szt</>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 8.5, fontWeight: 600, color: "var(--text-disabled)", textTransform: "uppercase", letterSpacing: "0.06em" }}>ETA</div>
                <div className="num" style={{ fontSize: 12, fontWeight: 600 }}>{new Date(c.eta_date).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}</div>
                <div className="num" style={{ fontSize: 10, color: eStatus === "CUSTOMS" ? "var(--warning)" : "var(--text-lo)" }}>
                  {eStatus === "CUSTOMS" ? `odprawa · ${c.customs_days_left ?? 0}d` : `za ${days}d`} · {meta?.label ?? eStatus}
                </div>
                {c.warehouse_delivery_date && (eStatus === "CUSTOMS" || !!c.expected_delivery_date) && (
                  <div className="num" style={{ fontSize: 10, color: "var(--ok)", marginTop: 1 }}>
                    U nas: {new Date(c.warehouse_delivery_date).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}
                  </div>
                )}
              </div>
            </HoverRow>
          );
        })}
        {deliveries.length === 0 && <EmptyRow text={shop ? `Brak dostaw z towarem ${shop.toUpperCase()}` : "Brak nadchodzących dostaw"} />}
      </div>
      <ExpandFooter hidden={hidden} open={open} onToggle={toggle} />
    </Card>
  );
}

// ── Anomalie ─────────────────────────────────────────────────
function AnomaliesCard({ anomalies, onProductClick }: { anomalies: Anomaly[]; onProductClick?: (p: ClickTarget) => void }) {
  const sevColor: Record<string, string> = { high: "var(--critical)", medium: "var(--warning)", low: "var(--text-mid)" };
  const sevLabel: Record<string, string> = { high: "WYS", medium: "ŚR", low: "NIS" };
  const { shown, hidden, open, toggle } = useExpandable(anomalies);
  return (
    <Card style={{ display: "flex", flexDirection: "column" }}>
      <CardHeader icon={<I.Activity size={16} />} title="Anomalie" hint={`${anomalies.length} wykrytych`} accent="var(--anomaly)" />
      <div style={{ flex: 1, ...listScroll(open) }}>
        {shown.map((a, i) => {
          // Procent (±) trzymamy po prawej — z komunikatu usuwamy końcowe „(…)", żeby się nie dublował.
          const hasTrend = a.type === "sales_spike" || a.type === "sales_drop";
          const up = a.change_pct >= 0;
          const msg = hasTrend ? a.message.replace(/\s*\([^)]*\)\s*$/, "") : a.message;
          return (
          <HoverRow key={`${a.sku}-${i}`} onClick={() => onProductClick?.(a)} style={i === shown.length - 1 ? { borderBottom: "none" } : undefined}>
            <span className="mono" style={{
              padding: "2px 6px", fontSize: 10, fontWeight: 700,
              background: "color-mix(in oklch, " + (sevColor[a.severity] || "var(--text-mid)") + " 18%, transparent)",
              color: sevColor[a.severity] || "var(--text-mid)",
              borderRadius: 4, width: 30, textAlign: "center", flexShrink: 0,
            }}>{sevLabel[a.severity] || "—"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{a.sku}</span>
                <span style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{a.type.replace(/_/g, " ")}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
              <div style={{ fontSize: 12, color: "var(--text-mid)", marginTop: 2, lineHeight: 1.4 }}>{msg}</div>
            </div>
            {hasTrend && (
              <div className="num" style={{
                display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0,
                fontSize: 12, fontWeight: 600, color: up ? "var(--ok)" : "var(--critical)",
              }}>
                {up ? <I.TrendUp size={12} /> : <I.TrendDown size={12} />}
                {fmtPct(a.change_pct)}
              </div>
            )}
          </HoverRow>
          );
        })}
        {anomalies.length === 0 && <EmptyRow text="Brak anomalii" />}
      </div>
      <ExpandFooter hidden={hidden} open={open} onToggle={toggle} />
    </Card>
  );
}

// ── Lista zakupów per producent ──────────────────────────────
function ShoppingListCard({
  groups, showEdit, onCreateContainer, onAutoSuggest,
}: {
  groups: ShoppingGroup[];
  showEdit: boolean;
  onCreateContainer?: (manufacturerId: number | null) => void;
  onAutoSuggest?: () => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(groups[0]?.manufacturer_id ?? null);
  return (
    <Card>
      <CardHeader icon={<I.Wand size={16} />} title="Lista zakupów" hint="grupowanie per producent oszczędza fracht" accent="var(--accent)"
        action={<button onClick={onAutoSuggest} style={{ ...btnAccent, display: showEdit ? "inline-flex" : "none" }}><I.Wand size={12} /> Auto-sugestia kontenera</button>} />
      <div>
        {groups.map((g, i) => {
          const key = g.manufacturer_id ?? 0;
          const isExpanded = expanded === key;
          const totalQty = g.products.reduce((s, p) => s + p.recommended_quantity, 0);
          return (
            <div key={key} style={{ borderBottom: i === groups.length - 1 ? "none" : "1px solid var(--border-soft)" }}>
              <div onClick={() => setExpanded(isExpanded ? null : key)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", cursor: "pointer", transition: "background 0.12s" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <span style={{ width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-mid)", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.18s" }}><I.ChevronR size={14} /></span>
                {g.manufacturer_name
                  ? <MfrChip name={g.manufacturer_name} color={g.manufacturer_color ?? "var(--text-lo)"} size="md" />
                  : <Pill bg="var(--surface-2)" fg="var(--text-mid)" size="sm">Bez producenta</Pill>}
                <span style={{ fontSize: 12, color: "var(--text-mid)" }}>
                  <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{g.total_skus}</span> SKU ·
                  <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}> {fmtNum(totalQty)}</span> szt
                </span>
                <div style={{ flex: 1 }} />
                <button onClick={(e) => { e.stopPropagation(); onCreateContainer?.(g.manufacturer_id); }} style={{ ...btnGhost, display: showEdit ? "inline-flex" : "none" }}>Utwórz kontener <I.Box size={11} /></button>
              </div>
              {isExpanded && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 6, padding: "4px 18px 16px" }} className="fade-in">
                  {g.products.map((item) => (
                    <div key={item.sku} style={{ background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="mono" style={{ fontSize: 11, fontWeight: 600 }}>{item.sku}</div>
                        <div style={{ fontSize: 10, color: "var(--text-lo)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
                      </div>
                      <span className="num" style={{ background: "var(--accent-soft)", color: "var(--accent)", fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 4, flexShrink: 0 }}>×{item.recommended_quantity}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && <EmptyRow text="Nic do zamówienia 🎉" />}
      </div>
    </Card>
  );
}

// ── Top sprzedaży (sztuki, bez PLN — widoczne dla wszystkich) ─
function TopSellersCard({ top, shop, onProductClick }: { top: TopSeller[]; shop: string; onProductClick?: (p: ClickTarget) => void }) {
  const { shown, hidden, open, toggle } = useExpandable(top);
  const max = top.length ? Math.max(...top.map((p) => p.sales_1m)) : 0;
  return (
    <Card style={{ display: "flex", flexDirection: "column" }}>
      <CardHeader icon={<I.TrendUp size={16} />} title="Top sprzedaży"
        hint={shop ? `30 dni · szt · ${shop.toUpperCase()}` : "30 dni · szt · wszystkie sklepy"}
        accent="var(--ok)" />
      <div style={{ flex: 1, ...listScroll(open) }}>
        {shown.map((p, i) => {
          const yoy = p.sales_yoy_30d;
          const pct = yoy > 0 ? ((p.sales_1m - yoy) / yoy) * 100 : null;
          const up = pct !== null && pct >= 0;
          const bar = max > 0 ? Math.max(2, (p.sales_1m / max) * 100) : 0;
          return (
            <HoverRow key={p.sku} onClick={() => onProductClick?.(p)} style={i === shown.length - 1 ? { borderBottom: "none" } : undefined}>
              <span className="num" style={{
                width: 20, flexShrink: 0, textAlign: "center", fontSize: 11, fontWeight: 700,
                color: i < 3 ? "var(--ok)" : "var(--text-lo)",
              }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{p.sku}</span>
                  <StatusPill status={p.status} size="sm" />
                </div>
                <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div style={{ marginTop: 5, height: 3, borderRadius: 2, background: "var(--surface-2)", overflow: "hidden" }}>
                  <div style={{ width: `${bar}%`, height: "100%", background: "var(--ok)", borderRadius: 2 }} />
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, minWidth: 74 }}>
                <div className="num" style={{ fontSize: 13, fontWeight: 600 }}>{fmtNum(p.sales_1m)} szt</div>
                {pct === null ? (
                  <div style={{ fontSize: 10, color: "var(--text-lo)" }}>brak r/r</div>
                ) : (
                  <div className="num" style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 600, color: up ? "var(--ok)" : "var(--critical)" }}>
                    {up ? <I.TrendUp size={10} /> : <I.TrendDown size={10} />}
                    {fmtPct(pct)} r/r
                  </div>
                )}
                <div className="num" style={{ fontSize: 10, color: "var(--text-lo)" }}>
                  stan {fmtNum(p.stock)} · {p.days_until_empty < 365 ? `${p.days_until_empty}d` : "∞"}
                </div>
              </div>
            </HoverRow>
          );
        })}
        {top.length === 0 && <EmptyRow text="Brak sprzedaży w ostatnich 30 dniach" />}
      </div>
      <ExpandFooter hidden={hidden} open={open} onToggle={toggle} />
    </Card>
  );
}

// ── Banner akcji ─────────────────────────────────────────────
function ActionsBanner({ onAutoSuggest, onSimulator, onProductClick }: {
  onAutoSuggest?: () => void; onSimulator?: () => void; onProductClick?: (sku: string) => void;
}) {
  // Produkty ciągniemy DOPIERO po kliknięciu — pulpit i tak jest ciężki,
  // więc kafelek nie dokłada kolejnego /products do pierwszego renderu.
  const [showWyprzedaz, setShowWyprzedaz] = useState(false);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loading, setLoading] = useState(false);

  const openWyprzedaz = () => {
    setShowWyprzedaz(true);
    if (products || loading) return;
    setLoading(true);
    api.get("/products?include=ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK")
      .then((res) => setProducts((res as Product[]) || []))
      .catch(() => toast("Nie udało się wczytać produktów", "warning"))
      .finally(() => setLoading(false));
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <SmartAction icon={<I.TrendDown size={18} />} title="Do wyprzedaży"
          sub="Produkty z zapasem ponad 6 miesięcy i stanem od 50 szt. — zamrażają kapitał" onClick={openWyprzedaz} accent="var(--info)" />
        <SmartAction icon={<I.Wand size={18} />} title="Auto-sugestia kontenera"
          sub="Algorytm zaplanuje optymalny skład na podstawie sprzedaży, lead-time i wolnej pojemności" onClick={onAutoSuggest} accent="var(--accent)" />
        <SmartAction icon={<I.Flask size={18} />} title="Symulator scenariuszy"
          sub="Co jeśli sprzedaż +30%, dostawa +30 dni lub kurs USD wzrośnie o 8%" onClick={onSimulator} accent="var(--anomaly)" />
      </div>

      {showWyprzedaz && (
        <WyprzedazModal
          products={products || []}
          loading={loading}
          onClose={() => setShowWyprzedaz(false)}
          onProductClick={onProductClick ? (sku) => { setShowWyprzedaz(false); onProductClick(sku); } : undefined}
        />
      )}
    </>
  );
}

function SmartAction({ icon, title, sub, onClick, accent }: { icon: React.ReactNode; title: string; sub: string; onClick?: () => void; accent: string }) {
  return (
    <button onClick={onClick} style={{
      textAlign: "left", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)",
      padding: "16px 18px", display: "flex", alignItems: "center", gap: 14, transition: "all 0.16s ease", position: "relative", overflow: "hidden",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; e.currentTarget.style.borderColor = accent; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--surface-1)"; e.currentTarget.style.borderColor = "var(--border-soft)"; }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: "color-mix(in oklch, " + accent + " 14%, transparent)", color: accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{title}</div>
        <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2, lineHeight: 1.4 }}>{sub}</div>
      </div>
      <I.ArrowRight size={16} />
    </button>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div style={{ padding: "18px", textAlign: "center", fontSize: 12, color: "var(--text-lo)" }}>{text}</div>;
}

const btnGhost: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px",
  fontSize: 11, fontWeight: 600, background: "transparent", border: "1px solid var(--border)",
  color: "var(--text-mid)", borderRadius: 6, transition: "all 0.12s",
};
const btnAccent: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px",
  fontSize: 11, fontWeight: 600, background: "var(--accent)", border: "1px solid var(--accent)",
  color: "var(--accent-ink)", borderRadius: 6,
};

// ── Skeleton ładowania ───────────────────────────────────────
function DashboardSkeleton({ gap }: { gap: number }) {
  const box = (h: number): React.CSSProperties => ({
    background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", height: h,
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }} className="pulse-soft">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={box(124)} />)}
      </div>
      <div style={box(260)} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 480px), 1fr))", gap }}>
        <div style={box(220)} /><div style={box(220)} />
      </div>
    </div>
  );
}

// ── Główny widok ─────────────────────────────────────────────
export default function Dashboard({
  density, onProductClick, onContainerClick, onAutoSuggest, onSimulator, onCreateContainer,
}: {
  density?: string;
  onProductClick?: (p: ClickTarget) => void;
  onContainerClick?: (c: ContainerOut) => void;
  onAutoSuggest?: () => void;
  onSimulator?: () => void;
  onCreateContainer?: (manufacturerId: number | null) => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const gap = density === "compact" ? 10 : 16;

  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<StockHistory | null>(null);
  const [containers, setContainers] = useState<ContainerOut[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [shopping, setShopping] = useState<ShoppingGroup[]>([]);
  const [topSellers, setTopSellers] = useState<TopSeller[]>([]);
  const [transitWh, setTransitWh] = useState<{ value_pln: number; sku_count: number } | null>(null);
  const [shop, setShop] = useState("amh");
  const cacheRef = useRef<Record<string, {
    history: StockHistory | null;
    containers: ContainerOut[]; anomalies: Anomaly[]; shopping: ShoppingGroup[]; topSellers: TopSeller[];
    transitWh: { value_pln: number; sku_count: number } | null;
  }>>({});

  const applyBundle = (b: {
    history: StockHistory | null;
    containers: ContainerOut[]; anomalies: Anomaly[]; shopping: ShoppingGroup[]; topSellers: TopSeller[];
    transitWh: { value_pln: number; sku_count: number } | null;
  }) => {
    setHistory(b.history); setContainers(b.containers);
    setAnomalies(b.anomalies); setShopping(b.shopping); setTopSellers(b.topSellers);
    setTransitWh(b.transitWh);
  };

  // Dociągnięcie brakujących kursów NBP z poziomu dashboardu (ADMIN-only endpoint).
  // Po sukcesie czyścimy cache i przeładowujemy kontenery, żeby kwoty od razu się poprawiły.
  const refillRates = async () => {
    try {
      const r = (await api.post("/admin/fx/refill", {})) as { inserted?: number; errors?: unknown[] };
      const errs = (r?.errors ?? []).length;
      if (errs > 0) {
        toast("NBP nie odpowiedziało dla części walut — spróbuj za chwilę", "warning");
      } else {
        toast(r?.inserted ? `Dociągnięto ${r.inserted} kursów` : "Brak nowych kursów do pobrania", "ok");
      }
      cacheRef.current = {};
      const cont = await api.get("/containers");
      setContainers((cont as ContainerOut[]) ?? []);
    } catch (e) {
      const err = e as { status?: number };
      toast(err?.status === 403 ? "Dociąganie kursów wymaga uprawnień administratora" : "Nie udało się dociągnąć kursów", "warning");
    }
  };

  // „Nie dozamawiamy" — chowa SKU z pożarów i całego flow zamawiania. Optymistycznie usuwamy
  // z listy zakupów (pożary są jej pochodną), czyścimy cache pozostałych zakładek, potem zapis.
  const onNoReorder = async (sku: string) => {
    setShopping((prev) => prev
      .map((g) => {
        const products = g.products.filter((p) => p.sku !== sku);
        return { ...g, products, total_skus: products.length };
      })
      .filter((g) => g.products.length > 0));
    cacheRef.current = {};
    try {
      await api.put(`/products/${encodeURIComponent(sku)}/no-reorder`);
      toast("Ukryto z zamawiania — przywrócisz w karcie produktu", "ok");
    } catch {
      toast("Nie udało się ukryć — odśwież stronę", "warning");
    }
  };

  useEffect(() => {
    let alive = true;
    const cached = cacheRef.current[shop];
    if (cached) {
      applyBundle(cached);
      setLoading(false);
      return () => { alive = false; };
    }
    (async () => {
      setLoading(true);
      // Dashboard pokazuje WYŁĄCZNIE obserwowane SKU (favorites_only=1) — na sztywno, bez przełącznika.
      // W obserwowanych trzymamy tylko to, co firmy aktualnie sprzedają, więc boxy nie krzyczą o wycofanych SKU.
      // Kontenery (/containers) zostają globalne: wiozą fizyczny towar niezależnie od obserwacji.
      const shopQ = shop ? `&shop=${shop}` : "";
      // Szereg od 01.01.2026 do dziś (jeden fetch). Picker dat i porównanie tną tę tablicę
      // po stronie klienta — bez dodatkowych zapytań. Podłoga 90, gdyby ktoś odpalił przed marcem.
      const _startMs = Date.UTC(2026, 0, 1);
      const _now = new Date();
      const _todayMs = Date.UTC(_now.getFullYear(), _now.getMonth(), _now.getDate());
      const rangeDays = Math.max(90, Math.round((_todayMs - _startMs) / 86400000));
      const [h, cont, ano, shp, top, tw] = await Promise.allSettled([
        api.get(`/stock-value-history?favorites_only=0&days=${rangeDays}${shopQ}`),
        api.get("/containers"),
        api.get(`/anomalies?favorites_only=1${shopQ}`),
        api.get(`/shopping-list?favorites_only=1${shopQ}`),
        api.get(`/top-sellers?favorites_only=1&limit=20${shopQ}`),
        api.get("/kpi/transit-warehouse"),
      ]);
      if (!alive) return;
      let failed = false;
      const bundle = {
        history: null as StockHistory | null,
        containers: [] as ContainerOut[], anomalies: [] as Anomaly[],
        shopping: [] as ShoppingGroup[], topSellers: [] as TopSeller[],
        transitWh: null as { value_pln: number; sku_count: number } | null,
      };
      if (h.status === "fulfilled") bundle.history = h.value as StockHistory; else failed = true;
      if (cont.status === "fulfilled") bundle.containers = (cont.value as ContainerOut[]) || []; else failed = true;
      if (ano.status === "fulfilled") bundle.anomalies = (ano.value as Anomaly[]) || []; else failed = true;
      if (shp.status === "fulfilled") bundle.shopping = (shp.value as ShoppingGroup[]) || []; else failed = true;
      if (top.status === "fulfilled") bundle.topSellers = (top.value as TopSeller[]) || []; else failed = true;
      if (tw.status === "fulfilled") bundle.transitWh = tw.value as { value_pln: number; sku_count: number };
      if (!failed) cacheRef.current[shop] = bundle;
      applyBundle(bundle);
      if (failed) {
        toast("Część danych pulpitu nie wczytała się", "warning");
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [shop]);

  // Pipeline zaopatrzenia: WSZYSTKIE niedostarczone kontenery.
  //  · lista dostaw (wariant C) → wszystkie niedostarczone (opcjonalnie zawężone do towaru sklepu),
  //  · KPI „Kontenery w drodze" → tylko część CZERWONA (jeszcze nie w Subiekcie), wartość z kontenera,
  //  · KPI „Magazyn w drodze" → licznik z części ZIELONEJ (wartość liczy backend z tabeli subiektowej).
  // Liczniki: całe kontenery + luźne loty z kontenerów mieszanych (dokładne, bez dublowania).
  // Uwaga: wartość „Kontenerów w drodze" jest globalna/AMH (nie zawężana firma_breakdown) —
  // trójka KPI jest AMH-owa; przy sklepie zawężamy tylko listę dostaw.
  const pipeline = useMemo(() => {
    const undelivered = containers
      .filter((c) => (c.effective_status ?? c.status) !== "DELIVERED")
      .sort((a, b) => new Date(a.eta_date).getTime() - new Date(b.eta_date).getTime());

    let deliveries = undelivered;
    if (shop) {
      const hasBreakdown = undelivered.some((c) => c.firma_breakdown && Object.keys(c.firma_breakdown).length > 0);
      if (hasBreakdown) deliveries = undelivered.filter((c) => (c.firma_breakdown?.[shop]?.units ?? 0) > 0);
    }

    let redValue = 0, redContainers = 0, redLooseLots = 0, greenContainers = 0, greenLooseLots = 0;
    let redRemaining = 0, greenPaid = 0, greenRemaining = 0, missingRates = 0;
    for (const c of undelivered) {
      const s = splitSubiekt(c, shop);
      redValue += s.redValue;
      if (s.redWhole) redContainers += 1;
      redLooseLots += s.looseRed;
      redRemaining += s.redRemaining;
      missingRates += s.missingRates;

      // Licznik kontenerów oraz kwoty (zapłacone i do zapłacenia) idą zakresem wybranej
      // zakładki: na „Wszyscy" wszystkie firmy, na zakładce firmowej tylko jej towar
      // (skalowane udziałem firmy z firma_breakdown). Dzięki temu suma po sklepach zgadza
      // się z „Wszyscy", a Acti/Veluxa też mają swoją część, mimo że w Subiekcie ich nie ma.
      if (s.greenWhole) greenContainers += 1;
      greenLooseLots += s.looseGreen;
      greenPaid += s.greenPaid;
      greenRemaining += s.greenRemaining;
    }
    return {
      deliveries,
      kont: { value: redValue, containers: redContainers, looseLots: redLooseLots, remaining: redRemaining },
      green: { containers: greenContainers, looseLots: greenLooseLots, paid: greenPaid, remaining: greenRemaining },
      missingRates,
    };
  }, [containers, shop]);

  // Pożary: pozycje z listy zakupów (KRYTYCZNY/ZAMÓW TERAZ) wg dni do końca — pełna lista,
  // karta sama limituje do 5 wierszy i rozwija resztę w miejscu.
  const fires = useMemo(() => {
    const all = shopping.flatMap((g) => g.products);
    return all.filter((p) => p.status === "KRYTYCZNY" || p.status === "ZAMOW_TERAZ")
      .sort((a, b) => a.days_until_empty - b.days_until_empty);
  }, [shopping]);

  const SHOPS: Array<{ v: string; l: string }> = [
    { v: "amh", l: "AMH" },
    { v: "acti", l: "Acti" },
    { v: "veluxa", l: "Veluxa" },
    { v: "", l: "Wszystkie" },
  ];

  const shopSelector = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <div style={{ display: "inline-flex", gap: 2, padding: 3, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8 }}>
        {SHOPS.map((s) => {
          const active = shop === s.v;
          return (
            <button key={s.v || "all"} onClick={() => setShop(s.v)} style={{
              padding: "5px 14px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer",
              background: active ? "var(--surface-3)" : "transparent",
              color: active ? "var(--text-hi)" : "var(--text-mid)", border: "none",
            }}>{s.l}</button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap, paddingBottom: 80 }} className="fade-in">
      {shopSelector}
      {loading ? <DashboardSkeleton gap={gap} /> : (
        <>
          {can(user, "viewDashboardKpi") && (
            <KpiGrid history={history} kont={pipeline.kont} mag={{ value: transitWh?.value_pln ?? 0, containers: pipeline.green.containers, looseLots: pipeline.green.looseLots, paid: pipeline.green.paid, remaining: pipeline.green.remaining }} shop={shop} missingRates={pipeline.missingRates} onRefillRates={refillRates} />
          )}
          {history && history.points.length > 1 && <ValueChartCard points={history.points} canFin={showFin} />}
          {showEdit && <ActionsBanner onAutoSuggest={onAutoSuggest} onSimulator={onSimulator}
            onProductClick={onProductClick ? (sku) => onProductClick({ sku }) : undefined} />}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 480px), 1fr))", gap }}>
            <FiresCard fires={fires} onProductClick={onProductClick} onNoReorder={onNoReorder} />
            <DeliveriesCard deliveries={pipeline.deliveries} shop={shop} onContainerClick={onContainerClick} />
          </div>
          <ShoppingListCard groups={shopping} showEdit={showEdit} onCreateContainer={onCreateContainer} onAutoSuggest={onAutoSuggest} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 480px), 1fr))", gap }}>
            <AnomaliesCard anomalies={anomalies} onProductClick={onProductClick} />
            <TopSellersCard top={topSellers} shop={shop} onProductClick={onProductClick} />
          </div>
        </>
      )}
    </div>
  );
}
