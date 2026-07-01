"use client";
// ============================================================
// MAGAZYN — Modal szczegółów produktu (etap 2c). Port product-modal.jsx.
//   KPI · prognoza 180 dni (/projection) · sprzedaż+YoY · edycja
//   atrybutów (PUT attrs) i lead-time (PUT lead-time) · gwiazdka.
//   Porównanie sezonowe + historia: odłożone do etapu 5.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { I, Pill, MfrChip, STATUS_META } from "./ui";
import {
  StatusPillExt, displayStatus, monthsDisplay,
  modalBackdrop, modalCard, btnPrimary, btnSecondary, Portal,
  type Product, type Manufacturer,
} from "./products-ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { canEdit, can, useUser } from "@/lib/permissions";
import { fmtPLN, fmtNum } from "@/lib/format";
import { SeasonChart, type SeasonPoint } from "./season-chart";

type ApiProjPoint = { date: string; stock: number; event: string | null };
type Delivery = { day: number; qty: number; container: string; eta: string; status: string };
type ProjPoint = { day: number; stock: number; arrivals: Delivery[] };
type Projection = { points: ProjPoint[]; deliveries: Delivery[]; stockOutDay: number | null; orderByDay: number | null };

const CLASSIFICATION_OPTIONS = [
  { value: "AUTO", label: "Automatyczna" },
  { value: "ACTIVE", label: "Aktywny" },
  { value: "ACTIVE_NO_STOCK", label: "Aktywny (bez stanu)" },
  { value: "DEAD_STOCK", label: "Dead stock" },
  { value: "INACTIVE", label: "Nieaktywny" },
];

function buildProjection(apiPoints: ApiProjPoint[], product: Product): Projection {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const deliveries: Delivery[] = (product.incoming_deliveries || [])
    .map((d) => {
      const eta = new Date(d.eta_date);
      const day = Math.round((eta.getTime() - today.getTime()) / 86400000);
      return { day, qty: d.quantity, container: d.container_number, eta: d.eta_date, status: d.status };
    })
    .filter((d) => d.day >= 0 && d.day <= 180)
    .sort((a, b) => a.day - b.day);

  const points: ProjPoint[] = apiPoints.map((p, i) => ({
    day: i, stock: p.stock, arrivals: deliveries.filter((d) => d.day === i),
  }));

  let stockOutDay: number | null = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].stock <= 0) { stockOutDay = i; break; }
  }
  const orderByDay = stockOutDay != null ? Math.max(0, stockOutDay - product.lead_time_days) : null;
  return { points, deliveries, stockOutDay, orderByDay };
}

export default function ProductModal({
  product: initialProduct, manufacturers, onClose, onUpdated,
}: {
  product: Product;
  manufacturers: Manufacturer[];
  onClose: () => void;
  onUpdated?: (p: Product) => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const [product, setProduct] = useState<Product>(initialProduct);
  const [editingAttrs, setEditingAttrs] = useState(false);
  const [editingLT, setEditingLT] = useState(false);
  const [proj, setProj] = useState<Projection | null>(null);
  const [season, setSeason] = useState<SeasonPoint[] | null>(null);

  useEffect(() => setProduct(initialProduct), [initialProduct]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    api.get(`/products/${encodeURIComponent(product.sku)}/projection?days=180`)
      .then((pts) => { if (alive) setProj(buildProjection((pts as ApiProjPoint[]) || [], product)); })
      .catch(() => { if (alive) setProj(null); });
    return () => { alive = false; };
  }, [product]);

  useEffect(() => {
    let alive = true;
    setSeason(null);
    api.get(`/products/${encodeURIComponent(product.sku)}/sales-season`)
      .then((d) => { if (alive) setSeason((d as SeasonPoint[]) || []); })
      .catch(() => { if (alive) setSeason([]); });
    return () => { alive = false; };
  }, [product.sku]);

  const applyUpdate = (updated: Product) => { setProduct(updated); onUpdated?.(updated); };

  const toggleFav = async () => {
    try {
      const updated = (await api.put(`/products/${encodeURIComponent(product.sku)}/favorite`)) as Product;
      applyUpdate(updated);
    } catch { toast("Nie udało się zmienić obserwowania", "warning"); }
  };

  const statusKey = displayStatus(product);
  const statusMeta = STATUS_META[statusKey] || (statusKey === "DEAD_STOCK"
    ? { label: "DEAD STOCK", bg: "var(--surface-3)", fg: "var(--text-lo)", dot: "var(--text-disabled)" }
    : { label: statusKey, bg: "var(--surface-3)", fg: "var(--text-lo)", dot: "var(--text-disabled)" });

  const monthsStr = monthsDisplay(product.months_of_stock);
  const monthsTone = monthsStr === "∞" ? "neutral" : product.months_of_stock < 1 ? "critical" : product.months_of_stock < 2 ? "warning" : "neutral";

  return (
    <Portal>
      <div onClick={onClose} style={modalBackdrop}>
        <div onClick={(e) => e.stopPropagation()} className="fade-in" style={{ ...modalCard, maxWidth: 880 }}>
        {/* Header */}
        <div style={{ padding: "18px 22px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", position: "relative" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: statusMeta.dot }} />
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <StatusPillExt status={statusKey} size="md" />
                {product.is_favorite && <Pill bg="var(--accent-soft)" fg="var(--accent)" dot="var(--accent)" size="sm">OBSERWOWANY</Pill>}
                {product.manufacturer_id && product.manufacturer_name && <MfrChip name={product.manufacturer_name} color={product.manufacturer_color ?? "var(--text-lo)"} size="md" />}
              </div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 10, color: "var(--text-hi)", letterSpacing: "-0.01em" }}>{product.sku}</div>
              <div style={{ fontSize: 14, color: "var(--text-mid)", marginTop: 2 }}>{product.name}</div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={toggleFav} style={iconBtnHeader} title={product.is_favorite ? "Usuń z obserwowanych" : "Obserwuj"}>
                {product.is_favorite ? <I.StarFill size={16} /> : <I.Star size={16} />}
              </button>
              <button onClick={onClose} style={iconBtnHeader} title="Zamknij"><I.Close size={16} /></button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            <MetricBox label="Stan" value={product.stock} sub={showFin ? fmtPLN(product.stock_value) : "•••••"} tone={product.stock === 0 ? "critical" : "neutral"} />
            <MetricBox label="W drodze" value={product.stock_in_transit > 0 ? `+${product.stock_in_transit}` : "—"} sub={product.stock_in_transit > 0 ? "oczekuje na dostawę" : "brak dostaw"} tone="info" />
            <MetricBox label="Sprzedaż / mies." value={Math.round(product.avg_monthly_weighted)} sub="średnia ważona" tone="neutral" />
            <MetricBox label="Mies. zapasu" value={monthsStr === "∞" ? "∞" : monthsStr + "m"} sub={product.days_until_empty < 365 ? `${product.days_until_empty}d do końca` : "brak ruchu"} tone={monthsTone} />
          </div>

          <Section title="Sprzedaż — sezon do sezonu">
            {season ? (
              <SeasonChart data={season} showFin={showFin} accent="var(--accent)" />
            ) : (
              <div style={{ height: 200, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }} className="pulse-soft" />
            )}
          </Section>

          <Section title="Prognoza stanu — 180 dni" hint={proj ? `${proj.deliveries.length} planowanych dostaw · sprzedaż ${Math.round(product.avg_monthly_weighted)}/mies` : "ładowanie…"}>
            {proj ? <StockProjectionChart projection={proj} product={product} /> : <div style={{ height: 200, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }} className="pulse-soft" />}
          </Section>

          <Section title="Sprzedaż i porównanie YoY">
            <SalesBars product={product} />
          </Section>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
            <AttributesCard product={product} manufacturers={manufacturers} editing={editingAttrs} setEditing={setEditingAttrs} onSaved={applyUpdate} />
            <LeadTimeCard product={product} editing={editingLT} setEditing={setEditingLT} onSaved={applyUpdate} />
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", padding: "12px 22px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-elevated)", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {showEdit ? (
              <button style={btnPrimary} onClick={() => toast("Dodawanie do listy zakupów — wkrótce (etap 6)", "info")}><I.Wand size={12} /> Dodaj do listy zakupów</button>
            ) : (
              <button style={btnPrimary} onClick={onClose}>Zamknij</button>
            )}
          </div>
        </div>
        </div>
      </div>
    </Portal>
  );
}

// ── Metric box ───────────────────────────────────────────────
function MetricBox({ label, value, sub, tone = "neutral" }: { label: string; value: React.ReactNode; sub?: string; tone?: "neutral" | "critical" | "warning" | "info" | "ok" }) {
  const color = { neutral: "var(--text-hi)", critical: "var(--critical)", warning: "var(--warning)", info: "var(--info)", ok: "var(--ok)" }[tone];
  return (
    <div style={{ padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 600, color, lineHeight: 1.1, marginTop: 4, letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>{title}</span>
        {hint && <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Prognoza stanu ───────────────────────────────────────────
function StockProjectionChart({ projection, product }: { projection: Projection; product: Product }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 200 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((entries) => setSize({ w: entries[0].contentRect.width, h: 200 }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const { points, deliveries, stockOutDay, orderByDay } = projection;
  const max = Math.max(...points.map((p) => p.stock), 1);
  const avg = product.avg_monthly_weighted;
  const safetyStock = Math.max(1, Math.round(avg * 0.5));
  const pad = { t: 22, r: 12, b: 28, l: 12 };
  const iw = size.w - pad.l - pad.r;
  const ih = size.h - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / (points.length - 1)) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayToDate = (d: number) => { const dt = new Date(today); dt.setDate(dt.getDate() + d); return dt; };
  const fmtDate = (d: Date) => d.toLocaleDateString("pl-PL", { day: "numeric", month: "short" });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.stock).toFixed(1)}`).join(" ");
  const areaPath = linePath + ` L${x(points.length - 1).toFixed(1)},${pad.t + ih} L${x(0).toFixed(1)},${pad.t + ih} Z`;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - rect.left - pad.l) / iw) * (points.length - 1))));
    setHover(idx);
  };

  const safetyY = y(safetyStock);

  return (
    <div ref={ref} style={{ position: "relative", width: "100%", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
      <svg width={size.w} height={size.h} onMouseMove={handleMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        <defs>
          <linearGradient id="projGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="dangerZone" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--critical)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--critical)" stopOpacity="0.12" />
          </linearGradient>
        </defs>

        <rect x={pad.l} y={safetyY} width={iw} height={pad.t + ih - safetyY} fill="url(#dangerZone)" />

        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={pad.l} x2={size.w - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--border-soft)" strokeDasharray="2,4" />
        ))}

        <line x1={pad.l} x2={size.w - pad.r} y1={safetyY} y2={safetyY} stroke="var(--warning)" strokeOpacity="0.5" strokeDasharray="4,3" strokeWidth="1" />
        <text x={size.w - pad.r - 4} y={safetyY - 3} fill="var(--warning)" fontSize="9" textAnchor="end" fontFamily="var(--font-mono)" opacity="0.85">safe — {safetyStock}</text>

        <line x1={pad.l} x2={size.w - pad.r} y1={y(0)} y2={y(0)} stroke="var(--critical)" strokeOpacity="0.4" strokeDasharray="3,3" />

        {orderByDay != null && orderByDay > 0 && (
          <g>
            <line x1={x(orderByDay)} x2={x(orderByDay)} y1={pad.t} y2={pad.t + ih} stroke="var(--warning)" strokeWidth="1.5" strokeDasharray="4,3" />
            <text x={x(orderByDay) + 4} y={pad.t + 10} fill="var(--warning)" fontSize="9" fontWeight="700" fontFamily="var(--font-mono)">ZAMÓW (+{orderByDay}d)</text>
          </g>
        )}

        {stockOutDay != null && stockOutDay < 180 && (
          <g>
            <line x1={x(stockOutDay)} x2={x(stockOutDay)} y1={pad.t} y2={pad.t + ih} stroke="var(--critical)" strokeWidth="1.5" strokeDasharray="3,2" />
            <text x={x(stockOutDay) - 4} y={pad.t + 10} fill="var(--critical)" fontSize="9" fontWeight="700" fontFamily="var(--font-mono)" textAnchor="end">KONIEC (+{stockOutDay}d)</text>
          </g>
        )}

        <path d={areaPath} fill="url(#projGrad)" />
        <path d={linePath} stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinejoin="round" />

        {deliveries.map((d, i) => (
          <g key={i}>
            <line x1={x(d.day)} x2={x(d.day)} y1={pad.t} y2={y(points[d.day].stock)} stroke="var(--info)" strokeWidth="1" strokeDasharray="2,3" opacity="0.7" />
            <circle cx={x(d.day)} cy={y(points[d.day].stock)} r="5" fill="var(--info)" stroke="var(--bg)" strokeWidth="2" />
            <text x={x(d.day)} y={y(points[d.day].stock) - 10} fill="var(--info)" fontSize="10" fontWeight="700" fontFamily="var(--font-mono)" textAnchor="middle">+{d.qty}</text>
          </g>
        ))}

        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--text-lo)" strokeDasharray="2,3" />
            <circle cx={x(hover)} cy={y(points[hover].stock)} r="4" fill="var(--accent)" stroke="var(--bg)" strokeWidth="2" />
          </g>
        )}

        <text x={pad.l + 4} y={pad.t + 9} fill="var(--text-lo)" fontSize="9" fontFamily="var(--font-mono)">{Math.round(max)}</text>

        <text x={pad.l} y={size.h - 10} fill="var(--text-lo)" fontSize="10" fontFamily="var(--font-mono)">dziś</text>
        <text x={pad.l + iw * 0.25} y={size.h - 10} fill="var(--text-disabled)" fontSize="10" textAnchor="middle" fontFamily="var(--font-mono)">{fmtDate(dayToDate(45))}</text>
        <text x={size.w / 2} y={size.h - 10} fill="var(--text-disabled)" fontSize="10" textAnchor="middle" fontFamily="var(--font-mono)">{fmtDate(dayToDate(90))}</text>
        <text x={pad.l + iw * 0.75} y={size.h - 10} fill="var(--text-disabled)" fontSize="10" textAnchor="middle" fontFamily="var(--font-mono)">{fmtDate(dayToDate(135))}</text>
        <text x={size.w - pad.r} y={size.h - 10} fill="var(--text-lo)" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">{fmtDate(dayToDate(180))}</text>
      </svg>

      {hover != null && (
        <div style={{ position: "absolute", left: Math.min(Math.max(x(hover) - 90, 8), size.w - 196), top: 8, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 7, padding: "7px 11px", fontSize: 11, pointerEvents: "none", minWidth: 180, boxShadow: "0 8px 20px rgba(0,0,0,0.4)" }}>
          <div className="num" style={{ fontSize: 10, color: "var(--text-lo)" }}>{fmtDate(dayToDate(hover))} · za {hover}d</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 600, color: points[hover].stock < avg * 0.5 ? "var(--critical)" : points[hover].stock < avg ? "var(--warning)" : "var(--text-hi)", marginTop: 1 }}>{Math.round(points[hover].stock)} szt</div>
          {points[hover].arrivals.map((d, i) => (
            <div key={i} style={{ fontSize: 10, color: "var(--info)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
              <I.Ship size={10} /><span className="mono">{d.container}</span><span className="num">+{d.qty}</span>
            </div>
          ))}
          {hover === stockOutDay && <div style={{ fontSize: 10, color: "var(--critical)", fontWeight: 700, marginTop: 3 }}>⚠ KONIEC ZAPASU</div>}
          {hover === orderByDay && <div style={{ fontSize: 10, color: "var(--warning)", fontWeight: 700, marginTop: 3 }}>⚠ ZAMÓW DZIŚ (LT={product.lead_time_days}d)</div>}
        </div>
      )}

      <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border-soft)", display: "flex", flexWrap: "wrap", gap: 14, fontSize: 10, color: "var(--text-lo)", background: "var(--bg-elevated)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 2, background: "var(--accent)" }} /> prognoza stanu</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 99, background: "var(--info)" }} /> dostawa ({deliveries.length})</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 0, borderTop: "1px dashed var(--warning)" }} /> safe / zamów-do</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 0, borderTop: "1px dashed var(--critical)" }} /> koniec zapasu</span>
      </div>
    </div>
  );
}

// ── Słupki sprzedaży ─────────────────────────────────────────
function SalesBars({ product: p }: { product: Product }) {
  const bars = [
    { label: "1m", value: p.sales_1m, group: "recent" },
    { label: "2m", value: p.sales_2m, group: "recent" },
    { label: "3m", value: p.sales_3m, group: "recent" },
    { label: "4m", value: p.sales_4m, group: "recent" },
    { label: "rok t.", value: p.sales_yoy_30d, group: "yoy" },
    { label: "+30d", value: p.sales_yoy_next_30d, group: "yoy" },
  ];
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div style={{ padding: 18, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
        {bars.map((b, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: "100%", height: 80, background: "var(--surface-2)", borderRadius: 6, display: "flex", flexDirection: "column-reverse", overflow: "hidden" }}>
              <div style={{ height: `${(b.value / max) * 100}%`, background: b.group === "yoy" ? "var(--anomaly)" : "var(--accent)", opacity: b.group === "yoy" ? 0.8 : 1, transition: "height 0.4s" }} />
            </div>
            <div className="num" style={{ fontSize: 14, fontWeight: 600, marginTop: 5 }}>{b.value}</div>
            <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{b.label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 10, color: "var(--text-lo)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--accent)" }} /> Sprzedaż ostatnich miesięcy</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--anomaly)" }} /> Porównanie YoY (rok temu)</span>
      </div>
    </div>
  );
}

// ── Atrybuty (edytowalne) ────────────────────────────────────
function AttributesCard({
  product, manufacturers, editing, setEditing, onSaved,
}: {
  product: Product; manufacturers: Manufacturer[];
  editing: boolean; setEditing: (v: boolean) => void; onSaved: (p: Product) => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const init = () => ({
    cbm: product.cbm_per_unit ?? 0,
    ean: product.ean ?? "",
    seasonality: product.seasonality_enabled,
    classification: product.forced_status || "AUTO",
    mfrId: product.manufacturer_id != null ? String(product.manufacturer_id) : "",
    cena: product.cena_zakupu_manual != null ? String(product.cena_zakupu_manual) : "",
  });
  const [draft, setDraft] = useState(init);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(init()); /* resync po zapisie/zmianie produktu */ // eslint-disable-next-line
  }, [product.sku, product.cbm_per_unit, product.ean, product.manufacturer_id, product.forced_status, product.seasonality_enabled, product.cena_zakupu_manual]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = (await api.put(`/products/${encodeURIComponent(product.sku)}/attrs`, {
        cbm_per_unit: draft.cbm,
        manufacturer_id: draft.mfrId === "" ? 0 : Number(draft.mfrId),
        ean: draft.ean,
        seasonality_enabled: draft.seasonality,
        forced_status: draft.classification,
        ...(showFin ? { cena_zakupu: draft.cena.trim() === "" ? 0 : (parseFloat(draft.cena.replace(",", ".")) || 0) } : {}),
      })) as Product;
      onSaved(updated);
      setEditing(false);
    } catch {
      toast("Nie udało się zapisać atrybutów", "warning");
    } finally { setBusy(false); }
  };

  const mfrOptions = [{ value: "", label: "— bez producenta —" }, ...manufacturers.map((m) => ({ value: String(m.id), label: m.name }))];
  const curMfr = manufacturers.find((m) => String(m.id) === draft.mfrId);

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>Atrybuty</span>
        {showEdit && (
          <button onClick={() => (editing ? save() : setEditing(true))} disabled={busy} style={btnGhostMini}>{editing ? (busy ? "Zapisuję…" : "Zapisz") : "Edytuj"}</button>
        )}
      </div>
      <div style={{ padding: "6px 0" }}>
        <AttrInput label="CBM / szt" suffix="m³" value={editing ? draft.cbm : (product.cbm_per_unit ?? 0).toFixed(3)} editing={editing} type="number" step="0.001" onChange={(v) => setDraft({ ...draft, cbm: parseFloat(v) || 0 })} />
        <AttrInput label="EAN" value={draft.ean || (editing ? "" : "—")} editing={editing} mono onChange={(v) => setDraft({ ...draft, ean: v })} />
        <div style={attrRowStyle}>
          <span style={attrLabelStyle}>Cena zakupu</span>
          {!showFin ? (
            <span className="num" style={{ fontSize: 12, color: "var(--text-mid)", fontWeight: 500 }}>•••••</span>
          ) : editing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number" step="0.01" inputMode="decimal"
                value={draft.cena}
                placeholder={product.purchase_price ? String(product.purchase_price) : "z Subiektu"}
                onChange={(e) => setDraft({ ...draft, cena: e.target.value })}
                title="Puste = cena z Subiektu. Wpisana wartość nadpisuje (PLN netto)."
                style={{ padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text-hi)", outline: "none", width: 120, textAlign: "right" }}
              />
              <span style={{ fontSize: 11, color: "var(--text-lo)", minWidth: 22 }}>zł</span>
            </div>
          ) : (
            <span className="num" style={{ fontSize: 12, color: "var(--text-mid)", fontWeight: 500 }}>
              {fmtNum(product.purchase_price)} zł{" "}
              <span style={{ fontSize: 9, color: "var(--text-disabled)" }}>
                {product.cena_zakupu_manual != null && product.cena_zakupu_manual > 0 ? "(ręczna)" : "(Subiekt)"}
              </span>
            </span>
          )}
        </div>
        <AttrSelect label="Producent (dostawca)" value={draft.mfrId} editing={editing} onChange={(v) => setDraft({ ...draft, mfrId: v })} options={mfrOptions}
          renderDisplay={() => (curMfr ? <MfrChip name={curMfr.name} color={curMfr.color} size="sm" /> : <span style={{ color: "var(--text-disabled)" }}>—</span>)} />
        <AttrSelect label="Klasyfikacja" value={draft.classification} editing={editing} onChange={(v) => setDraft({ ...draft, classification: v })} options={CLASSIFICATION_OPTIONS}
          renderDisplay={() => {
            const opt = CLASSIFICATION_OPTIONS.find((o) => o.value === draft.classification);
            const isForced = draft.classification !== "AUTO";
            return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: isForced ? "var(--accent)" : "var(--text-hi)", fontWeight: 500 }}>{isForced && <span title="Wymuszony status">📌</span>}{opt?.label || draft.classification}</span>;
          }} />
        <AttrToggle label="Sezonowość" value={draft.seasonality} editing={editing} onChange={(v) => setDraft({ ...draft, seasonality: v })} />
      </div>
    </div>
  );
}

function AttrInput({ label, value, editing, type = "text", mono, suffix, step, onChange }: { label: string; value: string | number; editing: boolean; type?: string; mono?: boolean; suffix?: string; step?: string; onChange: (v: string) => void }) {
  return (
    <div style={attrRowStyle}>
      <span style={attrLabelStyle}>{label}</span>
      {editing ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type={type} value={value} step={step} onChange={(e) => onChange(e.target.value)} style={{ padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text-hi)", outline: "none", width: 120, textAlign: "right", fontFamily: mono ? "var(--font-mono)" : "inherit" }} />
          {suffix && <span style={{ fontSize: 11, color: "var(--text-lo)", minWidth: 22 }}>{suffix}</span>}
        </div>
      ) : (
        <span className={mono ? "mono" : ""} style={{ fontSize: 12, color: "var(--text-hi)", fontWeight: 500 }}>{value}{suffix ? ` ${suffix}` : ""}</span>
      )}
    </div>
  );
}

function AttrSelect({ label, value, options, editing, onChange, renderDisplay }: { label: string; value: string; options: Array<{ value: string; label: string }>; editing: boolean; onChange: (v: string) => void; renderDisplay?: () => React.ReactNode }) {
  return (
    <div style={attrRowStyle}>
      <span style={attrLabelStyle}>{label}</span>
      {editing ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} style={{ padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text-hi)", outline: "none", minWidth: 170, textAlign: "right", fontFamily: "inherit" }}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        renderDisplay ? renderDisplay() : <span style={{ fontSize: 12, color: "var(--text-hi)" }}>{options.find((o) => o.value === value)?.label || value}</span>
      )}
    </div>
  );
}

function AttrToggle({ label, value, editing, onChange }: { label: string; value: boolean; editing: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={attrRowStyle}>
      <span style={attrLabelStyle}>{label}</span>
      <button onClick={() => editing && onChange(!value)} disabled={!editing} style={{ width: 34, height: 18, borderRadius: 99, background: value ? "var(--accent)" : "var(--surface-3)", border: "none", padding: 0, position: "relative", cursor: editing ? "pointer" : "default", opacity: editing ? 1 : 0.7, transition: "background 0.16s" }}>
        <span style={{ position: "absolute", top: 2, left: value ? 18 : 2, width: 14, height: 14, borderRadius: 99, background: value ? "var(--accent-ink)" : "var(--text-mid)", transition: "left 0.16s" }} />
      </button>
    </div>
  );
}

const attrRowStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", gap: 12 };
const attrLabelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-lo)", flexShrink: 0 };

// ── Lead time ────────────────────────────────────────────────
function LeadTimeCard({
  product, editing, setEditing, onSaved,
}: {
  product: Product; editing: boolean; setEditing: (v: boolean) => void; onSaved: (p: Product) => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const [draft, setDraft] = useState(product.lead_time_days);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(product.lead_time_days); }, [product.lead_time_days]);

  const save = async () => {
    if (busy) return;
    const lt = Math.max(1, Math.min(365, Math.round(Number(draft) || 0)));
    setBusy(true);
    try {
      const updated = (await api.put(`/products/${encodeURIComponent(product.sku)}/lead-time`, { lead_time_days: lt })) as Product;
      onSaved(updated);
      setEditing(false);
    } catch {
      toast("Nie udało się zapisać lead-time", "warning");
    } finally { setBusy(false); }
  };

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>Lead time produkcji</span>
        {showEdit && (
          <button onClick={() => (editing ? save() : setEditing(true))} disabled={busy} style={btnGhostMini}>{editing ? (busy ? "Zapisuję…" : "Zapisz") : "Edytuj"}</button>
        )}
      </div>
      {editing ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 14 }}>
          <input type="number" value={draft} onChange={(e) => setDraft(parseInt(e.target.value, 10) || 0)} style={{ padding: "8px 12px", fontSize: 24, fontWeight: 700, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 7, color: "var(--text-hi)", outline: "none", width: 90, textAlign: "center", fontFamily: "var(--font-mono)" }} />
          <span style={{ color: "var(--text-mid)", fontSize: 13 }}>dni</span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 14 }}>
          <span className="num" style={{ fontSize: 32, fontWeight: 700, color: "var(--accent)", letterSpacing: "-0.02em" }}>{product.lead_time_days}</span>
          <span style={{ fontSize: 13, color: "var(--text-mid)" }}>dni od zamówienia do dostawy</span>
        </div>
      )}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 11, color: "var(--text-lo)" }}>
        Wpływa na termin „zamów do" w prognozie stanu.
      </div>
    </div>
  );
}

const iconBtnHeader: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 7, color: "var(--text-mid)" };
const btnGhostMini: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "transparent", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 5, fontSize: 11, fontWeight: 500 };
