"use client";
// ============================================================
// MAGAZYN — Szczegóły producenta (manufacturer-modal.tsx).
//   Wyniesione z forecast.tsx, bo ten sam modal otwierają teraz dwa miejsca:
//   Prognoza (przycisk „Szczegóły producenta") i Ustawienia → Producenci.
//   Osobny plik zamiast eksportu z forecast.tsx — inaczej Ustawienia ciągnęłyby
//   cały widok prognozy (macierz, sezonowość, eksport) tylko po jeden modal.
//   Dane podaje wywołujący: produkty i kontenery już zawężone do producenta.
// ============================================================

import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtPLNk } from "@/lib/format";
import { I, Pill, ContainerNr } from "./ui";
import { STATUS_FULL_META, type Container } from "./containers-ui";
import {
  modalBackdrop, modalCard, Portal, StatusPillExt, displayStatus,
  type Product, type Manufacturer,
} from "./products-ui";
import { SeasonChart, type SeasonPoint } from "./season-chart";
import { mfrPipeline, belongsToMfr, isUndelivered, countLabel, plPick } from "@/lib/pipeline";

// „Wymaga zamówienia" w szczegółach producenta = ta sama reguła co Pożary na
// Dashboardzie. Tam listę robi backend (/shopping-list?favorites_only=1), więc outlety,
// dead stock i „nie dozamawiamy" nigdy tam nie docierają. Tutaj produkty przychodzą
// z /products (pełen asortyment, bo macierz prognozy ma pokazywać wszystko),
// dlatego ten sam filtr trzeba nałożyć klientowo — inaczej w modalu wyskakują
// outletowe SKU, których nie zamawiamy.
// Wartość magazynu = te same statusy co na pulpicie. Pulpit liczy ją z /stock-value-history,
// które bierze ACTIVE + ACTIVE_NO_STOCK + DEAD_STOCK — bez INACTIVE. Modal dostaje listę
// z /products?include=…,INACTIVE (macierz prognozy tego potrzebuje), więc INACTIVE trzeba
// odsiać tutaj, inaczej kafelek pokazywał więcej niż pulpit. Sama kwota liczy się identycznie:
// stock × purchase_price (backend: stock_value), gdzie cena idzie ręczna → Fakturownia → Subiekt.
const IN_STOCK_VALUE = new Set(["ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK"]);

function needsOrder(p: Product): boolean {
  if (p.product_status !== "ACTIVE" && p.product_status !== "ACTIVE_NO_STOCK") return false;
  if (!p.is_favorite) return false;          // tylko obserwowane — jak favorites_only=1
  if (p.no_reorder) return false;            // ręcznie wyłączone z zamawiania
  if (p.avg_monthly_weighted < 1) return false;  // < 1 szt./mies. to nie pożar
  return p.status === "KRYTYCZNY" || p.status === "ZAMOW_TERAZ";
}

// ── Szczegóły producenta (port ManufacturerModal) ────────────
export default function ManufacturerModal({
  mfr, products, containers, showFin, onClose, onProductClick,
}: {
  mfr: Manufacturer | null;
  products: Product[];
  /** WSZYSTKIE kontenery, nie zawężone do producenta — zawężenie robi modal, bo w kontenerach
   *  skonsolidowanych producent siedzi na locie, a nie na kontenerze (c.manufacturer_id = NULL). */
  containers: Container[];
  showFin: boolean;
  onClose: () => void;
  onProductClick?: (sku: string) => void;
}) {
  const [season, setSeason] = useState<SeasonPoint[] | null>(null);
  const [seasonErr, setSeasonErr] = useState(false);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const mfrId = mfr?.id;
  useEffect(() => {
    if (mfrId == null) return;
    let alive = true;
    setSeason(null); setSeasonErr(false);
    api.get(`/manufacturers/${mfrId}/sales-season`)
      .then((d) => { if (alive) setSeason((d as SeasonPoint[]) || []); })
      .catch(() => { if (alive) setSeasonErr(true); });
    return () => { alive = false; };
  }, [mfrId]);

  if (!mfr) return null;

  const mfrExt = mfr as Manufacturer & { contact?: string | null };
  // Kontenery tego producenta = własne + skonsolidowane, w których ma choć jeden lot.
  const mine = containers.filter((c) => belongsToMfr(c, mfr.id));
  // „Dostarczony" po statusie EFEKTYWNYM (auto-dostawa z ETA) — jak na pulpicie.
  // Wcześniej szedł status ręczny, więc kontener po ETA wciąż liczył się jako w drodze.
  const inFlight = mine.filter(isUndelivered);
  const delivered = mine.length - inFlight.length;
  const stockValue = products
    .filter((p) => IN_STOCK_VALUE.has(p.product_status))
    .reduce((s, p) => s + (p.stock_value || 0), 0);
  // Kwoty w drodze: ten sam kod co KPI na pulpicie, tylko zakres = producent zamiast firmy.
  const pipe = mfrPipeline(containers, mfr.id);
  const needOrder = products.filter(needsOrder)
    .sort((a, b) => a.days_until_empty - b.days_until_empty);  // najpilniejsze u góry — jak w Pożarach

  return (
    <Portal>
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} className="fade-in" style={{ ...modalCard, maxWidth: 820, maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
        {/* Nagłówek */}
        <div style={{ padding: "16px 22px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", position: "relative", flexShrink: 0 }}>
          <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: mfr.color }} />
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: `color-mix(in oklch, ${mfr.color} 20%, var(--bg))`, border: `1px solid ${mfr.color}`, color: mfr.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <I.Factory size={22} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)" }}>{mfr.name}</div>
              <div style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 2 }}>
                {mfrExt.contact ? `${mfrExt.contact} · ` : ""}<span className="mono">{mfr.email || "—"}</span>
              </div>
            </div>
            <button onClick={onClose} style={fcIconBtnHeader}><I.Close size={14} /></button>
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* KPI */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
            <FcMetricBox label="Produktów (SKU)" value={products.length} sub={`${needOrder.length} do zamówienia`} tone={needOrder.length ? "warning" : "neutral"} />
            <FcMetricBox label="Wartość magazynu" value={showFin ? fmtPLNk(stockValue) : "•••"} sub="bieżący stan" />
            {/* Rozbite na dwa kafelki, tak jak pulpit. Wcześniej było jedno „W drodze" = suma
                wartości TOWARU wszystkich niedostarczonych kontenerów — liczba, której na
                pulpicie nie ma nigdzie, bo tam obie karty mówią o PŁATNOŚCIACH. */}
            <FcMetricBox label="Magazyn w drodze" value={showFin ? fmtPLNk(pipe.green.paid) : "•••"}
              sub={showFin ? `do zapłacenia ${fmtPLNk(pipe.green.remaining)}` : countLabel(pipe.green.containers, pipe.green.looseLots)} tone="info" />
            <FcMetricBox label="W Prognozie" value={showFin ? fmtPLNk(pipe.kont.remaining) : "•••"}
              sub={countLabel(pipe.kont.containers, pipe.kont.looseLots)} tone="info" />
            <FcMetricBox label="Kontenery łącznie" value={mine.length} sub={`${delivered} dostarczonych`} />
          </div>
          {showFin && pipe.missingRates > 0 && (
            // Wpłaty bez notowania NBP nie weszły do sum — mówimy o tym wprost, zamiast po cichu
            // zaniżać kwoty. Dociągnięcie kursów jest na pulpicie, tutaj sam sygnał.
            <div style={{
              display: "flex", alignItems: "center", gap: 7, padding: "8px 12px", borderRadius: 8,
              background: "color-mix(in oklch, var(--warning) 10%, transparent)",
              border: "1px solid color-mix(in oklch, var(--warning) 35%, transparent)",
              color: "var(--warning)", fontSize: 11.5, fontWeight: 600, marginTop: -8,
            }}>
              <I.Alert size={13} />
              {pipe.missingRates} {plPick(pipe.missingRates, "wpłata", "wpłaty", "wpłat")} bez kursu NBP — kwoty zaniżone.
            </div>
          )}

          {/* Sezon do sezonu */}
          <FcSection title="Sprzedaż wszystkich SKU — sezon do sezonu">
            {season ? (
              <SeasonChart data={season} showFin={showFin} accent={mfr.color} />
            ) : seasonErr ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
                Brak danych historycznych sprzedaży dla tego producenta.
              </div>
            ) : (
              <div className="pulse-soft" style={{ height: 200, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }} />
            )}
          </FcSection>

          {/* Wymaga zamówienia */}
          {needOrder.length > 0 && (
            <FcSection title={`Wymaga zamówienia (${needOrder.length})`}>
              <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
                {needOrder.map((p, i) => (
                  <div key={p.sku} onClick={() => onProductClick?.(p.sku)} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: onProductClick ? "pointer" : "default",
                    borderBottom: i === needOrder.length - 1 ? "none" : "1px solid var(--border-soft)",
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                    <StatusPillExt status={displayStatus(p)} size="sm" />
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{p.sku}</span>
                    <span style={{ fontSize: 12, color: "var(--text-mid)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>stan {p.stock} · {Math.round(p.avg_monthly_weighted)}/mies</span>
                  </div>
                ))}
              </div>
            </FcSection>
          )}

          {/* Kontenery w drodze */}
          {inFlight.length > 0 && (
            <FcSection title={`Kontenery w drodze (${inFlight.length})`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {inFlight.map((c) => {
                  const m = STATUS_FULL_META[c.status] || STATUS_FULL_META.ORDERED;
                  const Icon = m.icon;
                  const days = Math.ceil((new Date(c.eta_date).getTime() - Date.now()) / 86400000);
                  return (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
                      <span style={{ color: m.fg, display: "flex" }}><Icon size={14} /></span>
                      <ContainerNr c={c} size={12} />
                      <Pill bg={m.bg} fg={m.fg} size="sm">{m.label}</Pill>
                      <span style={{ flex: 1 }} />
                      <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{c.total_units} szt · {showFin ? fmtPLNk(c.total_value) : "•••"} · za {days}d</span>
                    </div>
                  );
                })}
              </div>
            </FcSection>
          )}
        </div>
      </div>
    </div>
    </Portal>
  );
}

// ── Pomocnicze (lokalne odpowiedniki Section/MetricBox z mocka) ──
function FcSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

const FC_TONE_COLOR: Record<string, string> = {
  neutral: "var(--text-hi)", warning: "var(--warning)", info: "var(--info)", critical: "var(--critical)", ok: "var(--ok)",
};

function FcMetricBox({ label, value, sub, tone = "neutral" }: { label: string; value: React.ReactNode; sub?: string; tone?: "neutral" | "warning" | "info" | "critical" | "ok" }) {
  return (
    <div style={{ padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, color: FC_TONE_COLOR[tone] || "var(--text-hi)", marginTop: 5, letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

const fcIconBtnHeader: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border-soft)",
  color: "var(--text-mid)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
};
