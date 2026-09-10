"use client";
// ============================================================
// MAGAZYN — Modal szczegółów produktu (etap 2c). Port product-modal.jsx.
//   KPI · prognoza 180 dni (/projection) · sprzedaż+YoY · edycja
//   atrybutów (PUT attrs) i lead-time (PUT lead-time) · gwiazdka.
//   Porównanie sezonowe + historia: odłożone do etapu 5.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { I, Pill, MfrChip, STATUS_META, ContainerNr } from "./ui";
import {
  StatusPillExt, displayStatus, monthsDisplay,
  modalBackdrop, modalCard, btnPrimary, btnSecondary, Portal,
  type Product, type Manufacturer, type Firma,
} from "./products-ui";
import { api, photoUrl } from "@/lib/api";
import { PhotoHover, ProductThumb, resetPhotoCache } from "./photo-hover";   // PhotoHover — tylko kafelki w „Danych podstawowych”
import { toast } from "./toast";
import { canEdit, can, useUser } from "@/lib/permissions";
import { fmtPLN, fmtNum } from "@/lib/format";
import { SeasonChart, type SeasonPoint } from "./season-chart";
import LifecycleTab from "./product-lifecycle";

type ApiProjPoint = { date: string; stock: number; event: string | null };
type Delivery = { day: number; qty: number; container: string; eta: string; status: string };
type ProjPoint = { day: number; stock: number; arrivals: Delivery[] };
type Projection = { points: ProjPoint[]; deliveries: Delivery[]; deliveryMarkers: { day: number; qty: number }[]; stockOutDay: number | null; orderByDay: number | null };

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
      // Dzień na wykresie liczymy od daty wejścia na magazyn (ETA+odprawa albo znana data),
      // nie od surowej ETA — inaczej dostawa znikała w oknie odprawy.
      const arrival = new Date(d.warehouse_delivery_date);
      const day = Math.round((arrival.getTime() - today.getTime()) / 86400000);
      return { day, qty: d.quantity, container: d.container_number, eta: d.eta_date, status: d.status };
    })
    .filter((d) => d.day >= 0 && d.day <= 180)
    .sort((a, b) => a.day - b.day);

  const points: ProjPoint[] = apiPoints.map((p, i) => ({
    day: i, stock: p.stock, arrivals: deliveries.filter((d) => d.day === i),
  }));

  // Znaczniki na wykresie: gdy kilka dostaw wpada tego samego dnia, pokazujemy JEDNĄ kropkę
  // z sumą sztuk (rozbicie na kontenery zostaje w tooltipie przez points[].arrivals).
  const dayAgg = new Map<number, number>();
  for (const d of deliveries) dayAgg.set(d.day, (dayAgg.get(d.day) || 0) + d.qty);
  const deliveryMarkers = [...dayAgg.entries()]
    .map(([day, qty]) => ({ day, qty }))
    .sort((a, b) => a.day - b.day);

  let stockOutDay: number | null = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].stock <= 0) { stockOutDay = i; break; }
  }
  const orderByDay = stockOutDay != null ? Math.max(0, stockOutDay - product.lead_time_days) : null;
  return { points, deliveries, deliveryMarkers, stockOutDay, orderByDay };
}

export default function ProductModal({
  product: initialProduct, manufacturers, firmy, onClose, onUpdated, onContainerClick, onManufacturerClick,
}: {
  product: Product;
  manufacturers: Manufacturer[];
  firmy?: Firma[];
  onClose: () => void;
  onUpdated?: (p: Product) => void;
  onContainerClick?: (id: number) => void;
  /** Klik w chip producenta w nagłówku. Bez tego propa chip zostaje zwykłą etykietą —
   *  żaden istniejący ekran nie zmienia zachowania, dopóki go nie poda. */
  onManufacturerClick?: (id: number) => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  // Obserwowanie i „nie dozamawiamy" to zapis atrybutów produktu → wymaga editProducts
  // (VIEWER go nie ma). Ten sam klucz co guard na endpointach /favorite i /no-reorder.
  const canEditProducts = can(user, "editProducts");
  const [product, setProduct] = useState<Product>(initialProduct);
  const [editingAttrs, setEditingAttrs] = useState(false);
  const [editingLT, setEditingLT] = useState(false);
  const [proj, setProj] = useState<Projection | null>(null);
  const [season, setSeason] = useState<SeasonPoint[] | null>(null);

  // ── Zakładki: WYŁĄCZNIE super-admin ─────────────────────────
  // Zwykły użytkownik nie dostaje nawet paska — modal wygląda
  // dokładnie tak, jak przed tą zmianą. `hasHistory` jest sondą:
  // SKU spoza Subiekta (Acti/Veluxa) dostają 404 i wtedy zakładki
  // też się nie pokazują, bo nie byłoby czego w nich pokazać.
  const isSuper = Boolean(
    (user as { is_super_admin?: boolean; isSuper?: boolean } | null)?.is_super_admin
    ?? (user as { isSuper?: boolean } | null)?.isSuper,
  );
  const [hasHistory, setHasHistory] = useState(false);
  const [tab, setTab] = useState<"przeglad" | "zycie" | "sprzedaz" | "dane">("przeglad");

  useEffect(() => {
    if (!isSuper) { setHasHistory(false); return; }
    let alive = true;
    setHasHistory(false);
    setTab("przeglad");
    api.get(`/products/${encodeURIComponent(product.sku)}/historia`)
      .then(() => { if (alive) setHasHistory(true); })
      .catch(() => { if (alive) setHasHistory(false); });
    return () => { alive = false; };
  }, [product.sku, isSuper]);

  const showTabs = isSuper && hasHistory;

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

  // Po wgraniu/usunięciu zdjęcia dociągamy produkt na nowo — tylko wtedy
  // photo_id/photo_hash w nagłówku i na liście są aktualne.
  const refreshProduct = () => {
    api.get(`/products/${encodeURIComponent(product.sku)}`)
      .then((p) => applyUpdate(p as Product))
      .catch(() => { /* zdjęcie i tak się zapisało — brak odświeżenia nie jest błędem do pokazania */ });
  };

  const toggleFav = async () => {
    try {
      const updated = (await api.put(`/products/${encodeURIComponent(product.sku)}/favorite`)) as Product;
      applyUpdate(updated);
    } catch { toast("Nie udało się zmienić obserwowania", "warning"); }
  };

  const toggleNoReorder = async () => {
    try {
      const updated = (await api.put(`/products/${encodeURIComponent(product.sku)}/no-reorder`)) as Product;
      applyUpdate(updated);
      toast(updated.no_reorder ? "Ukryto z zamawiania" : "Przywrócono do zamawiania", "ok");
    } catch { toast("Nie udało się zmienić", "warning"); }
  };

  const statusKey = displayStatus(product);
  const statusMeta = STATUS_META[statusKey] || (statusKey === "DEAD_STOCK"
    ? { label: "DEAD STOCK", bg: "var(--surface-3)", fg: "var(--text-lo)", dot: "var(--text-disabled)" }
    : { label: statusKey, bg: "var(--surface-3)", fg: "var(--text-lo)", dot: "var(--text-disabled)" });

  const monthsStr = monthsDisplay(product.months_of_stock);
  const monthsTone = monthsStr === "∞" ? "neutral" : product.months_of_stock < 1 ? "critical" : product.months_of_stock < 2 ? "warning" : "neutral";

  // KPI „Najbliższa dostawa" — data wejścia na magazyn + skąd pochodzi.
  const nearestDelivery: { value: React.ReactNode; sub: string; tone: "neutral" | "info" | "ok" } =
    product.nearest_delivery_date
      ? {
          value: fmtDay(product.nearest_delivery_date),
          sub: product.nearest_delivery_source === "estimate" ? "szac. · ETA+7" : "potwierdzona",
          tone: product.nearest_delivery_source === "estimate" ? "info" : "ok",
        }
      : { value: "—", sub: "brak dostaw", tone: "neutral" };

  // Bloki treści wydzielone, żeby OBIE ścieżki renderowania — z zakładkami
  // i bez — używały dokładnie tego samego JSX. Bez tego zwykły użytkownik
  // i super-admin patrzyliby na dwie kopie, które z czasem by się rozjechały.
  const kpiBlok = (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
      <MetricBox label="Stan" value={product.stock} sub={showFin ? fmtPLN(product.stock_value) : "•••••"} tone={product.stock === 0 ? "critical" : "neutral"} />
      <MetricBox label="Magazyn w drodze" dot="var(--ok)" value={product.stock_in_transit_wbite > 0 ? `+${product.stock_in_transit_wbite}` : "—"} sub={product.stock_in_transit_wbite > 0 ? "wbite do ERP (w drodze)" : "nic w drodze"} tone={product.stock_in_transit_wbite > 0 ? "ok" : "neutral"} />
      <MetricBox label="W kontenerach" dot="var(--info)" value={product.stock_in_transit_containers > 0 ? `+${product.stock_in_transit_containers}` : "—"} sub={product.stock_in_transit_containers > 0 ? "jeszcze nie wbite" : "nic w kontenerach"} tone={product.stock_in_transit_containers > 0 ? "info" : "neutral"} />
      <MetricBox label="Najbliższa dostawa" value={nearestDelivery.value} sub={nearestDelivery.sub} tone={nearestDelivery.tone} />
      <MetricBox label="Sprzedaż / mies." value={Math.round(product.avg_monthly_weighted)} sub="średnia ważona" tone="neutral" />
      <MetricBox label="Mies. zapasu" value={monthsStr === "∞" ? "∞" : monthsStr + "m"} sub={product.days_until_empty < 365 ? `${product.days_until_empty}d do końca` : "brak ruchu"} tone={monthsTone} />
    </div>
  );

  const sezonBlok = (
    <Section title="Sprzedaż — sezon do sezonu">
      {season ? (
        <SeasonChart data={season} showFin={showFin} accent="var(--accent)" />
      ) : (
        <div style={{ height: 200, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }} className="pulse-soft" />
      )}
    </Section>
  );

  const prognozaBlok = (
    <Section title="Prognoza stanu — 180 dni" hint={proj ? `${proj.deliveries.length} planowanych dostaw · sprzedaż ${Math.round(product.avg_monthly_weighted)}/mies` : "ładowanie…"}>
      {proj ? <StockProjectionChart projection={proj} product={product} /> : <div style={{ height: 200, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }} className="pulse-soft" />}
    </Section>
  );

  const konteneryBlok = (
    <ContainersSection product={product} onContainerClick={onContainerClick} onClose={onClose} />
  );

  const kartyBlok = (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
      <AttributesCard product={product} manufacturers={manufacturers} firmy={firmy} editing={editingAttrs} setEditing={setEditingAttrs} onSaved={applyUpdate} onPhotosChanged={refreshProduct} />
      <DimensionsCard product={product} editing={editingLT} setEditing={setEditingLT} onSaved={applyUpdate} />
    </div>
  );

  return (
    <Portal>
      {/* data-modal-* — bez tych atrybutów mobilne reguły modali z globals.css nie miały
          się do czego przyczepić i nie działały. */}
      <div onClick={onClose} data-modal-backdrop style={modalBackdrop}>
        <div onClick={(e) => e.stopPropagation()} data-modal-card className="fade-in" style={{ ...modalCard, maxWidth: 880 }}>
        {/* Header */}
        <div style={{ padding: "18px 22px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", position: "relative" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: statusMeta.dot }} />
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            {/* Świadomie BEZ podglądu po najechaniu: w nagłówku zdjęcie pełni rolę
                identyfikatora, a nie miniatury do rozwijania. Powiększanie jest niżej,
                w karcie „Dane podstawowe". */}
            {product.photo_id && product.photo_hash && (
              <div style={{ display: "flex", flexShrink: 0 }}>
                <ProductThumb photoId={product.photo_id} photoHash={product.photo_hash} size={104} />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <StatusPillExt status={statusKey} size="md" />
                {product.is_favorite && <Pill bg="var(--accent-soft)" fg="var(--accent)" dot="var(--accent)" size="sm">OBSERWOWANY</Pill>}
                {product.no_reorder && <Pill bg="var(--info-soft)" fg="var(--info)" dot="var(--info)" size="sm">NIE ZAMAWIAMY</Pill>}
                {product.manufacturer_id && product.manufacturer_name && (
                  onManufacturerClick ? (
                    // Chip jest jedynym miejscem w nagłówku, które MÓWI „producent" —
                    // dorabianie osobnego przycisku obok byłoby drugą drogą do tego samego.
                    <button
                      onClick={() => onManufacturerClick(product.manufacturer_id as number)}
                      title={`Szczegóły producenta: ${product.manufacturer_name}`}
                      style={{ background: "none", border: "none", padding: 0, margin: 0, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, borderRadius: 999 }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.75"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}>
                      <MfrChip name={product.manufacturer_name} color={product.manufacturer_color ?? "var(--text-lo)"} size="md" />
                      <span style={{ color: product.manufacturer_color ?? "var(--text-lo)", display: "flex" }}><I.ChevronR size={12} /></span>
                    </button>
                  ) : (
                    <MfrChip name={product.manufacturer_name} color={product.manufacturer_color ?? "var(--text-lo)"} size="md" />
                  )
                )}
              </div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 10, color: "var(--text-hi)", letterSpacing: "-0.01em" }}>{product.sku}</div>
              <div style={{ fontSize: 14, color: "var(--text-mid)", marginTop: 2 }}>{product.name}</div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {canEditProducts && (
                <button onClick={toggleFav} style={iconBtnHeader} title={product.is_favorite ? "Usuń z obserwowanych" : "Obserwuj"}>
                  {product.is_favorite ? <I.StarFill size={16} /> : <I.Star size={16} />}
                </button>
              )}
              {canEditProducts && (
                <button onClick={toggleNoReorder}
                  style={product.no_reorder ? { ...iconBtnHeader, background: "var(--info-soft)", color: "var(--info)" } : iconBtnHeader}
                  title={product.no_reorder ? "Przywróć do zamawiania (pokaż w pożarach)" : "Nie dozamawiamy — ukryj z pożarów i zamawiania"}>
                  <I.Flame size={16} />
                </button>
              )}
              <button onClick={onClose} style={iconBtnHeader} title="Zamknij"><I.Close size={16} /></button>
            </div>
          </div>
        </div>

        {/* Pasek zakładek — renderuje się TYLKO dla super-admina i tylko
            gdy SKU ma historię. Dla wszystkich innych nie ma go w DOM,
            więc modal jest bit w bit taki jak przed tą zmianą. */}
        {showTabs && (
          <div role="tablist" style={{ display: "flex", gap: 2, padding: "0 14px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", overflowX: "auto" }}>
            {([["przeglad", "Przegląd"], ["zycie", "Życie produktu"], ["sprzedaz", "Sprzedaż"], ["dane", "Dane"]] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                style={{
                  background: "none", border: 0, padding: "12px 14px 11px",
                  color: tab === k ? "var(--text-hi)" : "var(--text-lo)",
                  fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", cursor: "pointer",
                  borderBottom: `2px solid ${tab === k ? "var(--accent)" : "transparent"}`,
                  marginBottom: -1,
                }}>{label}</button>
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 22 }}>
          {!showTabs && (
            <>
              {kpiBlok}
              {sezonBlok}
              {prognozaBlok}
              {konteneryBlok}
              {kartyBlok}
            </>
          )}
          {showTabs && tab === "przeglad" && (
            <>
              {kpiBlok}
              {prognozaBlok}
              {konteneryBlok}
            </>
          )}
          {showTabs && tab === "zycie" && <LifecycleTab sku={product.sku} showFin={showFin} />}
          {showTabs && tab === "sprzedaz" && sezonBlok}
          {showTabs && tab === "dane" && kartyBlok}
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
function MetricBox({ label, value, sub, tone = "neutral", dot }: { label: string; value: React.ReactNode; sub?: string; tone?: "neutral" | "critical" | "warning" | "info" | "ok"; dot?: string }) {
  const color = { neutral: "var(--text-hi)", critical: "var(--critical)", warning: "var(--warning)", info: "var(--info)", ok: "var(--ok)" }[tone];
  return (
    <div style={{ padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", display: "flex", alignItems: "center", gap: 5 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: 99, background: dot, flexShrink: 0 }} />}
        {label}
      </div>
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

  const { points, deliveries, deliveryMarkers, stockOutDay, orderByDay } = projection;
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

        {deliveryMarkers.map((d, i) => (
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

// ── Sekcja: kontenery z tym SKU ──────────────────────────────
function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// Etykieta + kolor dla statusu miękkiego kontenera (spójne z listą kontenerów).
const CSTATUS: Record<string, { label: string; color: string; soft: string }> = {
  ORDERED: { label: "Zamówione", color: "var(--text-mid)", soft: "var(--surface-2)" },
  IN_PRODUCTION: { label: "W produkcji", color: "var(--anomaly)", soft: "var(--anomaly-soft)" },
  IN_TRANSIT: { label: "W drodze", color: "var(--info)", soft: "var(--info-soft)" },
  CUSTOMS: { label: "Odprawa celna", color: "var(--warning)", soft: "var(--warning-soft)" },
  DELIVERED: { label: "Dostarczone", color: "var(--ok)", soft: "var(--ok-soft)" },
};

type CardAgg = {
  container_id: number; container_number: string; effective_status: string;
  warehouse_delivery_date: string; date_source: string; eta_date: string;
  wbite: boolean; is_consolidated: boolean; lot_order_number: string | null;
  container_order_number: string | null;
  manufacturer_name: string | null; qty: number;
};

function ContainersSection({ product, onContainerClick, onClose }: { product: Product; onContainerClick?: (id: number) => void; onClose: () => void }) {
  // Grupujemy po kontenerze (ten sam SKU zwykle jest raz na kontener, ale na wszelki wypadek sumujemy).
  const byContainer = new Map<number, CardAgg>();
  for (const d of product.incoming_deliveries || []) {
    const ex = byContainer.get(d.container_id);
    if (ex) { ex.qty += d.quantity; continue; }
    byContainer.set(d.container_id, {
      container_id: d.container_id, container_number: d.container_number,
      effective_status: d.effective_status, warehouse_delivery_date: d.warehouse_delivery_date,
      date_source: d.date_source, eta_date: d.eta_date, wbite: d.wbite,
      is_consolidated: d.is_consolidated, lot_order_number: d.lot_order_number,
      container_order_number: d.container_order_number ?? null,
      manufacturer_name: d.manufacturer_name, qty: d.quantity,
    });
  }
  const cards = [...byContainer.values()].sort((a, b) => a.warehouse_delivery_date.localeCompare(b.warehouse_delivery_date));
  if (cards.length === 0) return null;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const relDays = (iso: string) => {
    const d = new Date(iso); d.setHours(0, 0, 0, 0);
    const n = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (n === 0) return "dziś"; if (n < 0) return `${-n}d temu`; return `za ${n}d`;
  };
  const totalQty = cards.reduce((s, c) => s + c.qty, 0);

  const go = (id: number) => { onContainerClick?.(id); onClose(); };

  return (
    <Section title="Kontenery z tym SKU" hint={`${cards.length} ${cards.length === 1 ? "dostawa" : "dostawy"} · ${totalQty} szt`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cards.map((c) => {
          const meta = CSTATUS[c.effective_status] || CSTATUS.IN_TRANSIT;
          const est = c.date_source === "estimate";
          const qtyColor = c.wbite ? "var(--ok)" : "var(--info)";
          return (
            <div key={c.container_id} onClick={onContainerClick ? () => go(c.container_id) : undefined} role={onContainerClick ? "button" : undefined}
              style={{ position: "relative", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 12, overflow: "hidden", cursor: onContainerClick ? "pointer" : "default" }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: meta.color }} />
              {onContainerClick && <div style={{ position: "absolute", right: 12, top: 12, color: "var(--text-disabled)", fontSize: 16 }}>›</div>}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 34px 10px 14px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>{c.manufacturer_name || "—"}</div>
                  <div style={{ marginTop: 2 }}><ContainerNr c={{ ...c, order_number: c.container_order_number ?? c.lot_order_number }} size={11.5} color="var(--text-lo)" /></div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
                    <Pill bg={meta.soft} fg={meta.color} dot={meta.color} size="sm">{meta.label}</Pill>
                    {c.is_consolidated && <Pill bg="var(--warning-soft)" fg="var(--warning)" size="sm">Skonsolidowany</Pill>}
                    {c.is_consolidated && c.lot_order_number && <span className="mono" style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 20, background: "var(--surface-2)", color: "var(--text-mid)" }}>{c.lot_order_number}</span>}
                    {c.wbite && <Pill bg="var(--ok-soft)" fg="var(--ok)" dot="var(--ok)" size="sm">wbite</Pill>}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div className="num" style={{ fontSize: 19, fontWeight: 700, color: qtyColor, lineHeight: 1 }}>+{c.qty}</div>
                  <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 2 }}>szt</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "var(--bg-elevated)", borderTop: "1px solid var(--border-soft)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-lo)", marginBottom: 2 }}>Spodziewana dostawa</div>
                  <div className="num" style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em" }}>{fmtDay(c.warehouse_delivery_date)}</div>
                  <div style={{ fontSize: 10, marginTop: 2 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600, padding: "2px 6px", borderRadius: 6, background: est ? "var(--info-soft)" : "var(--ok-soft)", color: est ? "var(--info)" : "var(--ok)" }}>
                      {est ? "◷ szac. · ETA+7" : "✓ potwierdzona"}
                    </span>
                  </div>
                </div>
                <div style={{ width: 1, alignSelf: "stretch", background: "var(--border-soft)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-lo)", marginBottom: 2 }}>ETA (port)</div>
                  <div className="num" style={{ fontSize: 14, fontWeight: 700, color: "var(--text-mid)", letterSpacing: "-0.01em" }}>{fmtDay(c.eta_date)}</div>
                  <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 2 }}>{relDays(c.eta_date)}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10, fontSize: 10, color: "var(--text-lo)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ fontWeight: 600, padding: "1px 5px", borderRadius: 5, background: "var(--info-soft)", color: "var(--info)" }}>szac.</span> ETA + 7 dni (okno odprawy)</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ fontWeight: 600, padding: "1px 5px", borderRadius: 5, background: "var(--ok-soft)", color: "var(--ok)" }}>potwierdzona</span> znana data odbioru</span>
      </div>
    </Section>
  );
}

// ── Zdjęcia produktu ─────────────────────────────────────────
// Konwersja do WebP dzieje się TUTAJ, w przeglądarce (canvas.toBlob).
// Backend nie ma Pillow i nie musi mieć — dostaje gotową parę plików.
// Wysyłamy dwa warianty: pełny (~800 px, modal/hover) i miniaturę (~128 px, listy).
type Photo = {
  id: number; sku: string; sort_order: number; content_hash: string;
  content_type: string; filename: string | null; width: number | null; height: number | null;
  thumb_bytes: number; full_bytes: number; uploaded_at: string; uploaded_by: string | null;
};

const MAX_PHOTOS = 8;

async function toWebp(img: HTMLImageElement, maxPx: number, jakosc: number): Promise<Blob> {
  const skala = Math.min(1, maxPx / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * skala));
  c.height = Math.max(1, Math.round(img.height * skala));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("brak canvas 2d");
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("konwersja nieudana"))), "image/webp", jakosc)
  );
}

function ProductPhotos({ sku, editing, onChanged }: { sku: string; editing: boolean; onChanged: () => void }) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [podglad, setPodglad] = useState<Photo | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(() => {
    api.get(`/products/${encodeURIComponent(sku)}/photos`)
      .then((d) => setPhotos((d as Photo[]) || []))
      .catch(() => setPhotos([]));
  }, [sku]);

  useEffect(() => { setPhotos(null); load(); }, [load]);

  const wgraj = async (files: FileList | null) => {
    if (!files || !files.length || busy) return;
    const wolne = MAX_PHOTOS - (photos?.length ?? 0);
    if (wolne <= 0) { toast(`Maksymalnie ${MAX_PHOTOS} zdjęć na produkt`, "warning"); return; }
    setBusy(true);
    try {
      for (const f of Array.from(files).slice(0, wolne)) {
        if (!f.type.startsWith("image/")) { toast(`${f.name}: to nie jest obrazek`, "warning"); continue; }
        const img = new Image();
        const url = URL.createObjectURL(f);
        try {
          img.src = url;
          await img.decode();
          const [pelne, mini] = await Promise.all([toWebp(img, 800, 0.82), toWebp(img, 128, 0.8)]);
          const fd = new FormData();
          fd.append("full", pelne, "full.webp");
          fd.append("thumb", mini, "thumb.webp");
          fd.append("width", String(img.width));
          fd.append("height", String(img.height));
          await api.post(`/products/${encodeURIComponent(sku)}/photos`, fd);
        } finally { URL.revokeObjectURL(url); }
      }
      load();
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Nie udało się wgrać zdjęcia", "warning");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const usun = async (id: number) => {
    if (busy) return;
    setBusy(true);
    try { await api.del(`/product-photos/${id}`); load(); onChanged(); }
    catch { toast("Nie udało się usunąć zdjęcia", "warning"); }
    finally { setBusy(false); }
  };

  const ustawGlowne = async (id: number) => {
    if (busy) return;
    setBusy(true);
    try { const d = (await api.put(`/product-photos/${id}/main`, {})) as Photo[]; setPhotos(d || []); onChanged(); }
    catch { toast("Nie udało się ustawić zdjęcia głównego", "warning"); }
    finally { setBusy(false); }
  };

  if (photos === null) {
    return <div style={{ padding: "12px 14px" }}><div style={{ width: 120, height: 120, borderRadius: 8, background: "var(--surface-2)" }} className="pulse-soft" /></div>;
  }
  if (!photos.length && !editing) {
    return <div style={{ padding: "10px 14px", fontSize: 11, color: "var(--text-disabled)" }}>Brak zdjęcia</div>;
  }

  return (
    <>
      <div style={{ padding: "12px 14px 4px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
        {photos.map((p, i) => (
          <div key={p.id} style={{ position: "relative", width: 120, height: 120, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface-2)" }}>
            {/* Miniatura 128 px rozciągnięta do 104 px jest lekko miękka, ale ładuje się
                natychmiast. Po najechaniu pokazujemy pełne 800 px w podglądzie 320 px. */}
            <PhotoHover sku={sku} photoId={p.id} photoHash={p.content_hash} size={320} style={{ display: "block", width: "100%", height: "100%" }}>
              <img
                src={photoUrl(p.id, p.content_hash, "thumb") || ""}
                alt={`Zdjęcie ${i + 1}`}
                onClick={() => setPodglad(p)}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", cursor: "zoom-in" }}
              />
            </PhotoHover>
            {i === 0 && (
              <span style={{ position: "absolute", top: 3, left: 3, fontSize: 8, fontWeight: 700, letterSpacing: "0.04em", padding: "1px 5px", borderRadius: 99, background: "var(--accent)", color: "var(--accent-ink)" }}>GŁÓWNE</span>
            )}
            {editing && (
              <div style={{ position: "absolute", top: 3, right: 3, display: "flex", gap: 3 }}>
                {i !== 0 && (
                  <button onClick={() => ustawGlowne(p.id)} disabled={busy} title="Ustaw jako główne"
                    style={{ width: 18, height: 18, borderRadius: 99, border: "none", background: "oklch(0.2 0 0 / 0.62)", color: "#fff", fontSize: 10, lineHeight: 1, padding: 0 }}>★</button>
                )}
                <button onClick={() => usun(p.id)} disabled={busy} title="Usuń zdjęcie"
                  style={{ width: 18, height: 18, borderRadius: 99, border: "none", background: "oklch(0.2 0 0 / 0.62)", color: "#fff", fontSize: 10, lineHeight: 1, padding: 0 }}>✕</button>
              </div>
            )}
          </div>
        ))}

        {editing && photos.length < MAX_PHOTOS && (
          <button onClick={() => inputRef.current?.click()} disabled={busy}
            style={{ width: 120, height: 120, borderRadius: 8, border: "1.5px dashed var(--border-strong)", background: "transparent", color: "var(--text-lo)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, fontSize: 10 }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>+</span>
            <span>{busy ? "…" : "Zdjęcie"}</span>
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => wgraj(e.target.files)} />
      </div>

      {editing && (
        <div style={{ padding: "0 14px 8px", fontSize: 10, color: "var(--text-disabled)", lineHeight: 1.5 }}>
          Dowolny JPG/PNG zostanie przekonwertowany do WebP. Pierwsze zdjęcie jest miniaturką na liście produktów.
        </div>
      )}

      {podglad && (
        <Portal>
          {/* zIndex 1100: modalBackdrop ma 1000, więc 200 chowało podgląd pod modalem
              i klik w zdjęcie wyglądał jakby nic nie robił. */}
          <div onClick={() => setPodglad(null)} style={{ ...modalBackdrop, display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out", zIndex: 1100 }}>
            <img src={photoUrl(podglad.id, podglad.content_hash, "full") || ""} alt=""
              style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 10, boxShadow: "0 20px 60px oklch(0 0 0 / 0.5)" }} />
          </div>
        </Portal>
      )}
    </>
  );
}

// ── Dane podstawowe (edytowalne) ─────────────────────────────
function AttributesCard({
  product, manufacturers, firmy, editing, setEditing, onSaved, onPhotosChanged,
}: {
  product: Product; manufacturers: Manufacturer[]; firmy?: Firma[];
  editing: boolean; setEditing: (v: boolean) => void; onSaved: (p: Product) => void;
  onPhotosChanged: () => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const init = () => ({
    nazwa: product.name_override_manual ?? "",
    ean: product.ean ?? "",
    classification: product.forced_status || "AUTO",
    mfrId: product.manufacturer_id != null ? String(product.manufacturer_id) : "",
    firmaId: product.firma_id != null ? String(product.firma_id) : "",
    cena: product.cena_zakupu_manual != null ? String(product.cena_zakupu_manual) : "",
    isSample: product.is_sample ?? false,
    sampleStock: String(product.sample_stock ?? 0),
  });
  const [draft, setDraft] = useState(init);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(init()); /* resync po zapisie/zmianie produktu */ // eslint-disable-next-line
  }, [product.sku, product.ean, product.manufacturer_id, product.firma_id, product.forced_status, product.cena_zakupu_manual, product.name_override_manual, product.is_sample, product.sample_stock]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = (await api.put(`/products/${encodeURIComponent(product.sku)}/attrs`, {
        name_override: draft.nazwa,
        manufacturer_id: draft.mfrId === "" ? 0 : Number(draft.mfrId),
        firma_id: draft.firmaId === "" ? 0 : Number(draft.firmaId),
        ean: draft.ean,
        forced_status: draft.classification,
        is_sample: draft.isSample,
        sample_stock: parseInt(draft.sampleStock, 10) || 0,
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
  const firmaList = firmy ?? [];
  const firmaOptions = [{ value: "", label: "— domyślnie (AMH) —" }, ...firmaList.map((f) => ({ value: String(f.id), label: f.name }))];
  const curFirma = firmaList.find((f) => String(f.id) === draft.firmaId);

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>Dane podstawowe</span>
        {showEdit && (
          <button onClick={() => (editing ? save() : setEditing(true))} disabled={busy} style={btnGhostMini}>{editing ? (busy ? "Zapisuję…" : "Zapisz") : "Edytuj"}</button>
        )}
      </div>

      {/* Po każdej zmianie zdjęć czyścimy cache podglądu-po-najechaniu dla tego SKU,
          inaczej hover w kontenerach pokazywałby stare zdjęcie do końca sesji.
          Miniatura na liście produktów odświeża się przy kolejnym pobraniu katalogu. */}
      <ProductPhotos sku={product.sku} editing={editing && showEdit} onChanged={() => { resetPhotoCache(product.sku); onPhotosChanged(); }} />
      <div style={{ height: 1, background: "var(--border-soft)", margin: "4px 14px" }} />

      <div style={{ padding: "6px 0" }}>
        <AttrInput label="Nazwa (ręczna)" wide value={editing ? draft.nazwa : (product.name_override_manual || "—")} editing={editing} placeholder={product.name} onChange={(v) => setDraft({ ...draft, nazwa: v })} />
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
                title="Puste = cena z Fakturowni (Acti/Veluxa) albo Subiektu (AMH). Wpisana wartość nadpisuje (PLN netto)."
                style={{ padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text-hi)", outline: "none", width: 120, textAlign: "right" }}
              />
              <span style={{ fontSize: 11, color: "var(--text-lo)", minWidth: 22 }}>zł</span>
            </div>
          ) : (
            <span className="num" style={{ fontSize: 12, color: "var(--text-mid)", fontWeight: 500 }}>
              {fmtNum(product.purchase_price)} zł{" "}
              <span style={{ fontSize: 9, color: "var(--text-disabled)" }}>
                {product.cena_zakupu_manual != null && product.cena_zakupu_manual > 0
                  ? "(ręczna)"
                  : product.price_source === "fakturownia" ? "(Fakturownia)"
                  : product.price_source === "subiekt" ? "(Subiekt)"
                  : ""}
              </span>
            </span>
          )}
        </div>
        <AttrSelect label="Producent (dostawca)" value={draft.mfrId} editing={editing} onChange={(v) => setDraft({ ...draft, mfrId: v })} options={mfrOptions}
          renderDisplay={() => (curMfr ? <MfrChip name={curMfr.name} color={curMfr.color} size="sm" /> : <span style={{ color: "var(--text-disabled)" }}>—</span>)} />
        <AttrSelect label="Firma (magazyn źródłowy)" value={draft.firmaId} editing={editing} onChange={(v) => setDraft({ ...draft, firmaId: v })} options={firmaOptions}
          renderDisplay={() => (curFirma
            ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 99, background: curFirma.color }} /><span style={{ color: "var(--text-hi)", fontWeight: 500 }}>{curFirma.name}</span></span>
            : <span style={{ color: "var(--text-disabled)" }}>AMH (domyślnie)</span>)} />
        <AttrSelect label="Klasyfikacja" value={draft.classification} editing={editing} onChange={(v) => setDraft({ ...draft, classification: v })} options={CLASSIFICATION_OPTIONS}
          renderDisplay={() => {
            const opt = CLASSIFICATION_OPTIONS.find((o) => o.value === draft.classification);
            const isForced = draft.classification !== "AUTO";
            return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: isForced ? "var(--accent)" : "var(--text-hi)", fontWeight: 500 }}>{isForced && <span title="Wymuszony status">📌</span>}{opt?.label || draft.classification}</span>;
          }} />
        {/* SAMPLE: etykieta produktu próbnego. Włączona → status SAMPLE, produkt wypada
            z auto-sugestii, listy zakupów i anomalii. Wyłączenie = "sample się przyjął". */}
        <AttrToggle label="Sample (produkt próbny)" value={draft.isSample} editing={editing} onChange={(v) => setDraft({ ...draft, isSample: v })} />
        {draft.isSample && (
          <AttrInput
            label="Stan sampla (ręczny)"
            suffix="szt"
            value={editing ? draft.sampleStock : String(product.sample_stock ?? 0)}
            editing={editing}
            type="number"
            onChange={(v) => setDraft({ ...draft, sampleStock: v })}
          />
        )}
      </div>
    </div>
  );
}

// ── Wymiary i logistyka ──────────────────────────────────────
// Wymiary opisują KARTON eksportowy. CBM/szt = objętość kartonu ÷ szt. w kartonie.
// Ręczne nadpisanie (cbm_manual) zawsze wygrywa — backend liczy to samo w
// compute_effective_cbm, tutaj tylko podglądamy wynik na żywo przed zapisem.
function DimensionsCard({
  product, editing, setEditing, onSaved,
}: {
  product: Product; editing: boolean; setEditing: (v: boolean) => void; onSaved: (p: Product) => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const init = () => ({
    dl: product.dlugosc_cm != null ? String(product.dlugosc_cm) : "",
    sz: product.szerokosc_cm != null ? String(product.szerokosc_cm) : "",
    wy: product.wysokosc_cm != null ? String(product.wysokosc_cm) : "",
    szt: product.szt_w_kartonie != null ? String(product.szt_w_kartonie) : "",
    cbmMan: product.cbm_manual != null ? String(product.cbm_manual) : "",
    moq: product.moq != null ? String(product.moq) : "",
    zaokr: product.zaokraglaj_karton ?? false,
    lt: String(product.lead_time_days ?? 0),
  });
  const [draft, setDraft] = useState(init);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(init()); // eslint-disable-next-line
  }, [product.sku, product.dlugosc_cm, product.szerokosc_cm, product.wysokosc_cm, product.szt_w_kartonie, product.cbm_manual, product.moq, product.zaokraglaj_karton, product.lead_time_days]);

  const num = (s: string) => parseFloat((s || "").replace(",", ".")) || 0;

  // Podgląd na żywo — ta sama kolejność co compute_effective_cbm na backendzie.
  const podglad = useMemo(() => {
    const man = num(draft.cbmMan);
    if (man > 0) return { cbm: man, zrodlo: "manual" as const, karton: 0, szt: 1 };
    const d = num(draft.dl), s = num(draft.sz), w = num(draft.wy);
    if (d > 0 && s > 0 && w > 0) {
      const szt = Math.max(1, parseInt(draft.szt, 10) || 1);
      const karton = (d * s * w) / 1_000_000;
      return { cbm: karton / szt, zrodlo: "dims" as const, karton, szt };
    }
    return { cbm: 0, zrodlo: "none" as const, karton: 0, szt: 1 };
  }, [draft.dl, draft.sz, draft.wy, draft.szt, draft.cbmMan]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Konwencja backendu: <=0 czyści pole, >0 ustawia. Puste inputy → 0.
      let updated = (await api.put(`/products/${encodeURIComponent(product.sku)}/attrs`, {
        dlugosc_cm: num(draft.dl),
        szerokosc_cm: num(draft.sz),
        wysokosc_cm: num(draft.wy),
        szt_w_kartonie: parseInt(draft.szt, 10) || 0,
        cbm_per_unit: num(draft.cbmMan),
        moq: parseInt(draft.moq, 10) || 0,
        zaokraglaj_karton: draft.zaokr,
      })) as Product;

      // Lead time żyje w osobnej tabeli i ma własny endpoint.
      const lt = Math.max(1, Math.min(365, parseInt(draft.lt, 10) || 0));
      if (lt !== product.lead_time_days) {
        updated = (await api.put(`/products/${encodeURIComponent(product.sku)}/lead-time`, { lead_time_days: lt })) as Product;
      }
      onSaved(updated);
      setEditing(false);
    } catch {
      toast("Nie udało się zapisać wymiarów", "warning");
    } finally { setBusy(false); }
  };

  const dimInput = (v: string, on: (s: string) => void) => (
    <input type="number" step="0.1" inputMode="decimal" value={v} onChange={(e) => on(e.target.value)}
      style={{ padding: "4px 6px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text-hi)", outline: "none", width: 58, textAlign: "right", fontFamily: "var(--font-mono)" }} />
  );

  const wymiaryTekst = (product.dlugosc_cm && product.szerokosc_cm && product.wysokosc_cm)
    ? `${product.dlugosc_cm} × ${product.szerokosc_cm} × ${product.wysokosc_cm} cm`
    : "—";

  const zrodloLabel = podglad.zrodlo === "manual" ? "(ręczny)" : podglad.zrodlo === "dims" ? "(z wymiarów)" : "";

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>Wymiary i logistyka</span>
        {showEdit && (
          <button onClick={() => (editing ? save() : setEditing(true))} disabled={busy} style={btnGhostMini}>{editing ? (busy ? "Zapisuję…" : "Zapisz") : "Edytuj"}</button>
        )}
      </div>

      <div style={{ padding: "6px 0" }}>
        <div style={attrRowStyle}>
          <span style={attrLabelStyle}>Wymiary kartonu</span>
          {editing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {dimInput(draft.dl, (v) => setDraft({ ...draft, dl: v }))}
              <span style={{ fontSize: 11, color: "var(--text-lo)" }}>×</span>
              {dimInput(draft.sz, (v) => setDraft({ ...draft, sz: v }))}
              <span style={{ fontSize: 11, color: "var(--text-lo)" }}>×</span>
              {dimInput(draft.wy, (v) => setDraft({ ...draft, wy: v }))}
              <span style={{ fontSize: 11, color: "var(--text-lo)", minWidth: 18 }}>cm</span>
            </div>
          ) : (
            <span className="num" style={{ fontSize: 12, color: wymiaryTekst === "—" ? "var(--text-disabled)" : "var(--text-hi)", fontWeight: 500 }}>{wymiaryTekst}</span>
          )}
        </div>

        <AttrInput label="Szt. w kartonie" suffix="szt" type="number"
          value={editing ? draft.szt : (product.szt_w_kartonie != null ? String(product.szt_w_kartonie) : "1")}
          editing={editing} onChange={(v) => setDraft({ ...draft, szt: v })} />

        <div style={attrRowStyle}>
          <span style={attrLabelStyle}>CBM / szt</span>
          <span className="num" style={{ fontSize: 12, fontWeight: 500, color: podglad.zrodlo === "manual" ? "var(--accent)" : podglad.zrodlo === "none" ? "var(--text-disabled)" : "var(--text-hi)" }}>
            {podglad.cbm.toFixed(3)} m³ <span style={{ fontSize: 9, color: "var(--text-disabled)" }}>{zrodloLabel}</span>
          </span>
        </div>
        {podglad.zrodlo === "dims" && (
          <div style={{ padding: "0 14px 6px", fontSize: 10, color: "var(--text-disabled)", textAlign: "right" }}>
            {podglad.karton.toFixed(4)} m³ karton ÷ {podglad.szt} szt
          </div>
        )}

        <AttrInput label="CBM ręczny (nadpisuje)" suffix="m³" type="number" step="0.001"
          value={editing ? draft.cbmMan : (product.cbm_manual != null ? String(product.cbm_manual) : "—")}
          editing={editing} onChange={(v) => setDraft({ ...draft, cbmMan: v })} />

        <div style={{ height: 1, background: "var(--border-soft)", margin: "6px 14px" }} />

        <AttrInput label="Min. zamówienie (MOQ)" suffix="szt" type="number"
          value={editing ? draft.moq : (product.moq != null ? String(product.moq) : "—")}
          editing={editing} onChange={(v) => setDraft({ ...draft, moq: v })} />
        <AttrToggle label="Zaokrąglaj do pełnych kartonów" value={draft.zaokr} editing={editing} onChange={(v) => setDraft({ ...draft, zaokr: v })} />

        <div style={{ height: 1, background: "var(--border-soft)", margin: "6px 14px" }} />

        <div style={attrRowStyle}>
          <span style={attrLabelStyle}>Lead time produkcji</span>
          {editing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="number" value={draft.lt} onChange={(e) => setDraft({ ...draft, lt: e.target.value })}
                style={{ padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text-hi)", outline: "none", width: 64, textAlign: "right", fontFamily: "var(--font-mono)" }} />
              <span style={{ fontSize: 11, color: "var(--text-lo)", minWidth: 22 }}>dni</span>
            </div>
          ) : (
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
              <span className="num" style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>{product.lead_time_days}</span>
              <span style={{ fontSize: 11, color: "var(--text-mid)" }}>dni</span>
            </span>
          )}
        </div>

        <div style={{ margin: "6px 0 0", padding: "8px 14px 10px", borderTop: "1px solid var(--border-soft)", fontSize: 10, color: "var(--text-lo)", lineHeight: 1.5 }}>
          CBM zasila zajętość kontenera. Lead time wpływa na termin „zamów do" w prognozie stanu.
          {(product.moq || product.zaokraglaj_karton) ? " MOQ i zaokrąglanie są na razie informacyjne — nie zmieniają jeszcze listy zakupów." : ""}
        </div>
      </div>
    </div>
  );
}

function AttrInput({ label, value, editing, type = "text", mono, suffix, step, wide, placeholder, onChange }: { label: string; value: string | number; editing: boolean; type?: string; mono?: boolean; suffix?: string; step?: string; wide?: boolean; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div style={attrRowStyle}>
      <span style={attrLabelStyle}>{label}</span>
      {editing ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type={type} value={value} step={step} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text-hi)", outline: "none", width: wide ? 240 : 120, textAlign: wide ? "left" : "right", fontFamily: mono ? "var(--font-mono)" : "inherit" }} />
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

const iconBtnHeader: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 7, color: "var(--text-mid)" };
const btnGhostMini: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "transparent", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 5, fontSize: 11, fontWeight: 500 };
