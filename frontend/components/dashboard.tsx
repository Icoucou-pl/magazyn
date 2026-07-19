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
  I, Card, CardHeader, HoverRow, Pill, StatusPill, MfrChip, CONTAINER_STATUS_META,
} from "./ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { can, canEdit, useUser } from "@/lib/permissions";
import { fmtPLN, fmtPLNk, fmtNum, fmtPct } from "@/lib/format";

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
  firma_breakdown?: Record<string, FirmaShare>;   // slug -> udział firmy (może nie przyjść ze starego backendu)
};
type Anomaly = {
  sku: string; name: string;
  severity: "high" | "medium" | "low";
  type: string; message: string;
};
type ShoppingProduct = {
  sku: string; name: string; stock: number; stock_in_transit: number;
  avg_monthly: number; recommended_quantity: number; status: string; days_until_empty: number;
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
function KpiCard({
  label, value, sub, change, tone = "neutral", icon, sparkData,
}: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  change?: number; tone?: Tone; icon?: React.ReactNode; sparkData?: number[];
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
        <div className="num" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", color: c, lineHeight: 1.05 }}>{value}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          {change != null && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, fontWeight: 600, color: changeColor }} className="num">
              {changePositive ? "▲" : "▼"} {Math.abs(change).toFixed(1).replace(".", ",")}%
            </span>
          )}
          {sub && <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{sub}</span>}
        </div>
      </div>
      {sparkData && sparkData.length > 1 && <Sparkline points={sparkData} color={c} />}
    </div>
  );
}

function Sparkline({ points, color }: { points: number[]; color: string }) {
  const w = 80, h = 24;
  const max = Math.max(...points), min = Math.min(...points);
  const range = max - min || 1;
  const path = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} style={{ position: "absolute", right: 14, bottom: 12, opacity: 0.4 }}>
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
function KpiGrid({
  history, classification, inTransitValue, inTransitCount, shop,
}: {
  history: StockHistory | null;
  classification: Classification | null;
  inTransitValue: number;
  inTransitCount: number;
  shop: string;                    // "" = wszystkie sklepy
}) {
  const user = useUser();
  const showFin = can(user, "viewFinancials");
  const pts = history?.points ?? [];
  const stockValue = history?.current_value ?? 0;
  const change90 = pts.length > 1 ? ((stockValue - pts[0].value) / (pts[0].value || 1)) * 100 : undefined;
  const sparkLast30 = pts.slice(-30).map((p) => p.value);
  const c = classification?.counts;
  // Przy wybranym sklepie "W drodze" = wartość TYLKO towaru tej firmy w całym pipeline.
  const transitSub = shop
    ? `${inTransitCount} kontenerów · towar ${shop.toUpperCase()}`
    : `${inTransitCount} kontenerów`;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
      {showFin ? (
        <KpiCard label="Wartość magazynu" value={fmtPLNk(stockValue)} change={change90} sub="vs 90 dni temu" tone="neutral" sparkData={sparkLast30} icon={<I.Box size={14} />} />
      ) : (
        <KpiCard label="Wartość magazynu" value="•••••" sub="ukryte — brak uprawnień" tone="neutral" icon={<I.Box size={14} />} />
      )}
      {showFin ? (
        <KpiCard label="W drodze" value={fmtPLNk(inTransitValue)} sub={transitSub} tone="info" icon={<I.Ship size={14} />} />
      ) : (
        <KpiCard label="W drodze" value="•••••" sub={transitSub} tone="info" icon={<I.Ship size={14} />} />
      )}
      <KpiCard label="Aktywne SKU" value={fmtNum(c?.ACTIVE)} sub={`${fmtNum(c?.ACTIVE_NO_STOCK)} bez stanu`} tone="ok" icon={<I.Activity size={14} />} />
      <KpiCard label="Dead stock" value={fmtNum(c?.DEAD_STOCK)} sub={fmtPLNk(classification?.dead_stock_value_pln)} tone="warning" icon={<I.Alert size={14} />} />
    </div>
  );
}

// ── Wykres (karta z zakresem 7D/30D/90D) ─────────────────────
function ValueChartCard({ points, canFin }: { points: StockPoint[]; canFin: boolean }) {
  const [range, setRange] = useState<"7D" | "30D" | "90D">("90D");
  const [metricSel, setMetricSel] = useState<"value" | "units">(canFin ? "value" : "units");
  const metric: "value" | "units" = canFin ? metricSel : "units";
  const ranges: Array<"7D" | "30D" | "90D"> = ["7D", "30D", "90D"];
  const sliced = range === "7D" ? points.slice(-7) : range === "30D" ? points.slice(-30) : points;

  const val = (p?: StockPoint) => (p ? (metric === "value" ? p.value : p.units) : 0);
  const first = val(sliced[0]);
  const last = val(sliced[sliced.length - 1]);
  const change = last - first;
  const pct = first ? (change / first) * 100 : 0;
  const positive = change >= 0;

  const title = metric === "value" ? "Wartość magazynu" : "Liczba sztuk";
  const fmtBig = (n: number) => (metric === "value" ? fmtPLN(n) : `${fmtNum(n)} szt`);
  const fmtDelta = (n: number) => (metric === "value" ? fmtPLNk(n) : `${fmtNum(n)} szt`);

  const segBtn = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
    background: active ? "var(--surface-3)" : "transparent",
    color: active ? "var(--text-hi)" : "var(--text-mid)", border: "none",
  });

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 20px 12px", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>{title}</span>
            <Pill bg="var(--surface-2)" fg="var(--text-mid)" size="sm" mono>{range}</Pill>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 6 }}>
            <div className="num" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{fmtBig(last)}</div>
            <span className="num" style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 13, fontWeight: 600, color: positive ? "var(--ok)" : "var(--critical)" }}>
              {positive ? <I.TrendUp size={13} /> : <I.TrendDown size={13} />}
              {positive ? "+" : ""}{fmtDelta(change)} ({fmtPct(pct)})
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canFin && (
            <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
              <button onClick={() => setMetricSel("value")} style={segBtn(metric === "value")}>zł</button>
              <button onClick={() => setMetricSel("units")} style={segBtn(metric === "units")}>szt</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
            {ranges.map((r) => (
              <button key={r} onClick={() => setRange(r)} className="num" style={segBtn(r === range)}>{r}</button>
            ))}
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
function FiresCard({ fires, onProductClick }: { fires: ShoppingProduct[]; onProductClick?: (p: ClickTarget) => void }) {
  const { shown, hidden, open, toggle } = useExpandable(fires);
  return (
    <Card>
      <CardHeader icon={<I.Flame size={16} />} title="Pożary" hint={`${fires.length} pozycji`} accent="var(--critical)" />
      <div style={listScroll(open)}>
        {shown.map((p, i) => (
          <HoverRow key={p.sku} onClick={() => onProductClick?.(p)} style={i === shown.length - 1 ? { borderBottom: "none" } : undefined}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
              <StatusPill status={p.status} size="sm" />
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>{p.sku}</span>
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
  const showFin = can(useUser(), "viewFinancials");
  const { shown, hidden, open, toggle } = useExpandable(deliveries);
  return (
    <Card>
      <CardHeader icon={<I.Ship size={16} />} title="Najbliższe dostawy"
        hint={shop ? `${deliveries.length} kontenerów z towarem ${shop.toUpperCase()}` : `${deliveries.length} kontenerów`}
        accent="var(--info)" />
      <div style={listScroll(open)}>
        {shown.map((c, i) => {
          const days = Math.ceil((new Date(c.eta_date).getTime() - Date.now()) / 86400000);
          const eStatus = c.effective_status ?? c.status;
          const meta = CONTAINER_STATUS_META[eStatus];
          // Przy wybranym sklepie pokazujemy UDZIAŁ tej firmy w kontenerze, nie całość
          // (kontener bywa mieszany — zwłaszcza skonsolidowany).
          const share = shop ? c.firma_breakdown?.[shop] : undefined;
          const itemsCount = c.items.length;
          return (
            <HoverRow key={c.id} onClick={() => onContainerClick?.(c)} style={i === shown.length - 1 ? { borderBottom: "none" } : undefined}>
              <div style={{ width: 4, height: 32, background: meta?.dot ?? "var(--text-lo)", borderRadius: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>#{c.container_number}</span>
                  {c.manufacturer_name && <MfrChip name={c.manufacturer_name} color={c.manufacturer_color ?? "var(--text-lo)"} />}
                  {share && (
                    <Pill bg="var(--surface-2)" fg={share.color ?? "var(--text-mid)"} size="sm" dot={share.color ?? undefined}>
                      {share.name ?? share.slug.toUpperCase()}
                    </Pill>
                  )}
                </div>
                <div className="num" style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>
                  {share
                    ? <>{share.items}/{itemsCount} pozycji · {fmtNum(share.units)} szt · {showFin ? fmtPLNk(share.value) : "•••"}</>
                    : <>{itemsCount} pozycji · {fmtNum(c.total_units)} szt · {showFin ? fmtPLNk(c.total_value) : "•••"}</>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div className="num" style={{ fontSize: 12, fontWeight: 600 }}>{new Date(c.eta_date).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}</div>
                <div className="num" style={{ fontSize: 10, color: eStatus === "CUSTOMS" ? "var(--warning)" : "var(--text-lo)" }}>
                  {eStatus === "CUSTOMS" ? `odprawa · ${c.customs_days_left ?? 0}d` : `za ${days}d`} · {meta?.label ?? eStatus}
                </div>
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
    <Card>
      <CardHeader icon={<I.Activity size={16} />} title="Anomalie" hint={`${anomalies.length} wykrytych`} accent="var(--anomaly)" />
      <div style={listScroll(open)}>
        {shown.map((a, i) => (
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
              <div style={{ fontSize: 12, color: "var(--text-mid)", marginTop: 2, lineHeight: 1.4 }}>{a.message}</div>
            </div>
          </HoverRow>
        ))}
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
    <Card>
      <CardHeader icon={<I.TrendUp size={16} />} title="Top sprzedaży"
        hint={shop ? `30 dni · szt · ${shop.toUpperCase()}` : "30 dni · szt · wszystkie sklepy"}
        accent="var(--ok)" />
      <div style={listScroll(open)}>
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
function ActionsBanner({ onAutoSuggest, onSimulator }: { onAutoSuggest?: () => void; onSimulator?: () => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
      <SmartAction icon={<I.Wand size={18} />} title="Auto-sugestia kontenera"
        sub="Algorytm zaplanuje optymalny skład na podstawie sprzedaży, lead-time i wolnej pojemności" onClick={onAutoSuggest} accent="var(--accent)" />
      <SmartAction icon={<I.Flask size={18} />} title="Symulator scenariuszy"
        sub="Co jeśli sprzedaż +30%, dostawa +30 dni lub kurs USD wzrośnie o 8%" onClick={onSimulator} accent="var(--anomaly)" />
    </div>
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
  const [classification, setClassification] = useState<Classification | null>(null);
  const [containers, setContainers] = useState<ContainerOut[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [shopping, setShopping] = useState<ShoppingGroup[]>([]);
  const [topSellers, setTopSellers] = useState<TopSeller[]>([]);
  const [shop, setShop] = useState("");
  const cacheRef = useRef<Record<string, {
    history: StockHistory | null; classification: Classification | null;
    containers: ContainerOut[]; anomalies: Anomaly[]; shopping: ShoppingGroup[]; topSellers: TopSeller[];
  }>>({});

  const applyBundle = (b: {
    history: StockHistory | null; classification: Classification | null;
    containers: ContainerOut[]; anomalies: Anomaly[]; shopping: ShoppingGroup[]; topSellers: TopSeller[];
  }) => {
    setHistory(b.history); setClassification(b.classification); setContainers(b.containers);
    setAnomalies(b.anomalies); setShopping(b.shopping); setTopSellers(b.topSellers);
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
      const [h, cls, cont, ano, shp, top] = await Promise.allSettled([
        api.get(`/stock-value-history?favorites_only=1&days=90${shopQ}`),
        api.get(`/classification?favorites_only=1${shopQ}`),
        api.get("/containers"),
        api.get(`/anomalies?favorites_only=1${shopQ}`),
        api.get(`/shopping-list?favorites_only=1${shopQ}`),
        api.get(`/top-sellers?favorites_only=1&limit=20${shopQ}`),
      ]);
      if (!alive) return;
      let failed = false;
      const bundle = {
        history: null as StockHistory | null, classification: null as Classification | null,
        containers: [] as ContainerOut[], anomalies: [] as Anomaly[],
        shopping: [] as ShoppingGroup[], topSellers: [] as TopSeller[],
      };
      if (h.status === "fulfilled") bundle.history = h.value as StockHistory; else failed = true;
      if (cls.status === "fulfilled") bundle.classification = cls.value as Classification; else failed = true;
      if (cont.status === "fulfilled") bundle.containers = (cont.value as ContainerOut[]) || []; else failed = true;
      if (ano.status === "fulfilled") bundle.anomalies = (ano.value as Anomaly[]) || []; else failed = true;
      if (shp.status === "fulfilled") bundle.shopping = (shp.value as ShoppingGroup[]) || []; else failed = true;
      if (top.status === "fulfilled") bundle.topSellers = (top.value as TopSeller[]) || []; else failed = true;
      if (!failed) cacheRef.current[shop] = bundle;
      applyBundle(bundle);
      if (failed) {
        toast("Część danych pulpitu nie wczytała się", "warning");
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [shop]);

  // Pipeline zaopatrzenia: WSZYSTKIE niedostarczone kontenery
  // (zamówione + w produkcji + w drodze + odprawa), nie tylko IN_TRANSIT.
  //
  // Przy wybranym sklepie kontener nie znika, tylko liczy się jego UDZIAŁ:
  //  · lista dostaw  → kontenery, które wiozą towar tej firmy (kontener przypływa cały),
  //  · KPI "W drodze" → suma wartości WYŁĄCZNIE pozycji tej firmy.
  // Gdyby backend nie przysłał firma_breakdown (stary deploy), spadamy na całość — bez wysypki.
  const pipeline = useMemo(() => {
    const undelivered = containers
      .filter((c) => (c.effective_status ?? c.status) !== "DELIVERED")
      .sort((a, b) => new Date(a.eta_date).getTime() - new Date(b.eta_date).getTime());

    if (!shop) {
      return {
        deliveries: undelivered,
        value: undelivered.reduce((s, c) => s + (c.total_value || 0), 0),
        count: undelivered.length,
      };
    }
    const hasBreakdown = undelivered.some((c) => c.firma_breakdown && Object.keys(c.firma_breakdown).length > 0);
    if (!hasBreakdown) {
      return {
        deliveries: undelivered,
        value: undelivered.reduce((s, c) => s + (c.total_value || 0), 0),
        count: undelivered.length,
      };
    }
    const mine = undelivered.filter((c) => (c.firma_breakdown?.[shop]?.units ?? 0) > 0);
    return {
      deliveries: mine,
      value: mine.reduce((s, c) => s + (c.firma_breakdown?.[shop]?.value ?? 0), 0),
      count: mine.length,
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
    { v: "", l: "Wszystkie" },
    { v: "amh", l: "AMH" },
    { v: "acti", l: "Acti" },
    { v: "veluxa", l: "Veluxa" },
  ];

  const shopSelector = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-mid)" }}>Sklep</span>
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
          <KpiGrid history={history} classification={classification} inTransitValue={pipeline.value} inTransitCount={pipeline.count} shop={shop} />
          {history && history.points.length > 1 && <ValueChartCard points={history.points} canFin={showFin} />}
          {showEdit && <ActionsBanner onAutoSuggest={onAutoSuggest} onSimulator={onSimulator} />}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 480px), 1fr))", gap }}>
            <FiresCard fires={fires} onProductClick={onProductClick} />
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
