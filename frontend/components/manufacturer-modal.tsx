"use client";
// ============================================================
// MAGAZYN — Szczegóły producenta (manufacturer-modal.tsx).
//   Wyniesione z forecast.tsx, bo ten sam modal otwierają teraz dwa miejsca:
//   Prognoza (przycisk „Szczegóły producenta") i Ustawienia → Producenci.
//   Osobny plik zamiast eksportu z forecast.tsx — inaczej Ustawienia ciągnęłyby
//   cały widok prognozy (macierz, sezonowość, eksport) tylko po jeden modal.
//   Dane podaje wywołujący: produkty i kontenery już zawężone do producenta.
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
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

// ── Lista produktów: zakładki ────────────────────────────────
// SAMPLE nie jest flagą obok statusu — backend (services/products.py) daje takiemu SKU
// product_status = "SAMPLE" ZAMIAST właściwego. Dlatego „Wszystkie" musi jawnie odsiać
// sample, inaczej licznik zakładki rozjeżdża się z kafelkiem „Produktów (SKU)".
type MpTab = "order" | "all" | "fav" | "sample";

const MP_TABS: { key: MpTab; label: string; alarm?: boolean; test: (p: Product) => boolean }[] = [
  { key: "order",  label: "Do zamówienia", alarm: true, test: needsOrder },
  { key: "all",    label: "Wszystkie",  test: (p) => p.product_status !== "SAMPLE" },
  { key: "fav",    label: "Obserwowane", test: (p) => p.product_status !== "SAMPLE" && p.is_favorite },
  { key: "sample", label: "Sample",     test: (p) => p.product_status === "SAMPLE" },
];

type MpSort = "rot" | "urg" | "stock" | "sku";
const MP_SORTS: { key: MpSort; label: string; cmp: (a: Product, b: Product) => number }[] = [
  { key: "rot",   label: "Rotacja ↓",     cmp: (a, b) => b.avg_monthly_weighted - a.avg_monthly_weighted },
  { key: "urg",   label: "Dni do zera ↑", cmp: (a, b) => a.days_until_empty - b.days_until_empty },
  { key: "stock", label: "Stan ↓",        cmp: (a, b) => b.stock - a.stock },
  { key: "sku",   label: "SKU A–Z",       cmp: (a, b) => a.sku.localeCompare(b.sku) },
];

// Ile kontenerów pokazujemy bez rozwijania. Producent z 12 pozycjami w drodze
// (Anji) zjadał cały modal i spychał listę produktów pod ekran.
const CONT_PREVIEW = 6;

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
  const [tab, setTab] = useState<MpTab>("fav");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<MpSort>("rot");
  const [contAll, setContAll] = useState(false);

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

  // Liczniki zakładek — jeden przelot po produktach zamiast czterech filtrów.
  const counts = useMemo(() => {
    const c: Record<MpTab, number> = { order: 0, all: 0, fav: 0, sample: 0 };
    for (const p of products) for (const t of MP_TABS) if (t.test(p)) c[t.key] += 1;
    return c;
  }, [products]);

  // Domyślnie „Obserwowane"; producent bez ani jednego obserwowanego SKU pokazałby
  // pustą listę na wejściu, więc wtedy spadamy na „Wszystkie".
  useEffect(() => {
    if (mfrId == null) return;
    setTab(counts.fav > 0 ? "fav" : "all");
    setQ(""); setSort("rot"); setContAll(false);
  }, [mfrId, counts.fav]);

  const visible = useMemo(() => {
    const t = MP_TABS.find((x) => x.key === tab) || MP_TABS[1];
    const ql = q.trim().toLowerCase();
    const arr = products.filter((p) => {
      if (!t.test(p)) return false;
      if (!ql) return true;
      return p.sku.toLowerCase().includes(ql) || (p.name || "").toLowerCase().includes(ql);
    });
    // Zakładka alarmowa ma stałą kolejność (najpilniejsze u góry) — jak w Pożarach.
    const cmp = tab === "order"
      ? MP_SORTS[1].cmp
      : (MP_SORTS.find((s) => s.key === sort) || MP_SORTS[0]).cmp;
    return [...arr].sort(cmp);
  }, [products, tab, q, sort]);

  if (!mfr) return null;

  const mfrExt = mfr as Manufacturer & { contact?: string | null };
  // Kontenery tego producenta = własne + skonsolidowane, w których ma choć jeden lot.
  const mine = containers.filter((c) => belongsToMfr(c, mfr.id));
  // „Dostarczony" po statusie EFEKTYWNYM (auto-dostawa z ETA) — jak na pulpicie.
  // Wcześniej szedł status ręczny, więc kontener po ETA wciąż liczył się jako w drodze.
  const inFlight = mine.filter(isUndelivered);
  const delivered = mine.length - inFlight.length;
  const shownFlight = contAll ? inFlight : inFlight.slice(0, CONT_PREVIEW);
  const stockValue = products
    .filter((p) => IN_STOCK_VALUE.has(p.product_status))
    .reduce((s, p) => s + (p.stock_value || 0), 0);
  // Kwoty w drodze: ten sam kod co KPI na pulpicie, tylko zakres = producent zamiast firmy.
  const pipe = mfrPipeline(containers, mfr.id);

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
            {/* Bez sampli — inaczej kafelek kłamie względem zakładki „Wszystkie". */}
            <FcMetricBox label="Produktów (SKU)" value={counts.all} sub={`${counts.order} do zamówienia`} tone={counts.order ? "warning" : "neutral"} />
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

          {/* Produkty — jedna lista z zakładkami. Zastąpiła osobną sekcję „Wymaga zamówienia":
              przy kilkudziesięciu SKU były to dwie listy pod sobą z tymi samymi wierszami.
              Alarm nie zniknął — siedzi jako pierwsza zakładka z pomarańczowym licznikiem. */}
          <FcSection title={`Produkty (${visible.length}${q.trim() ? ` z ${counts[tab]}` : ""})`}>
            <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                padding: "9px 10px", borderBottom: "1px solid var(--border-soft)",
              }}>
                <div style={{ display: "inline-flex", gap: 2, padding: 2, background: "var(--surface-2)", borderRadius: 8 }}>
                  {MP_TABS.map((t) => {
                    const n = counts[t.key];
                    const on = t.key === tab;
                    return (
                      <button key={t.key} onClick={() => setTab(t.key)} style={{
                        display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 11px",
                        border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                        fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
                        background: on ? "var(--bg-elevated)" : "transparent",
                        color: on ? "var(--text-hi)" : "var(--text-lo)",
                      }}>
                        {t.alarm && n > 0 && <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--warning)", flexShrink: 0 }} />}
                        {t.label}
                        <span className="num" style={{
                          fontSize: 10.5, fontWeight: t.alarm && n > 0 ? 700 : 600,
                          color: t.alarm && n > 0 ? "var(--warning)" : on ? "var(--text-mid)" : "var(--text-lo)",
                        }}>{n}</span>
                      </button>
                    );
                  })}
                </div>

                <div style={{ position: "relative", flex: 1, minWidth: 130 }}>
                  <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-lo)", display: "flex" }}>
                    <I.Search size={12} />
                  </span>
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj po SKU lub nazwie…" style={{
                    width: "100%", padding: "6px 10px 6px 27px", fontFamily: "inherit", fontSize: 11.5,
                    background: "var(--bg)", border: "1px solid var(--border-soft)", borderRadius: 7,
                    color: "var(--text-hi)", outline: "none",
                  }} />
                </div>

                {/* Na zakładce alarmowej sortowanie jest zablokowane na „dni do zera" — wybór
                    byłby martwy, więc go chowamy zamiast pokazywać nieaktywny select. */}
                {tab !== "order" && (
                  <select value={sort} onChange={(e) => setSort(e.target.value as MpSort)} style={{
                    padding: "6px 8px", fontFamily: "inherit", fontSize: 11.5, background: "var(--bg)",
                    border: "1px solid var(--border-soft)", borderRadius: 7, color: "var(--text-mid)",
                    outline: "none", cursor: "pointer",
                  }}>
                    {MP_SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                )}
              </div>

              <div style={{ maxHeight: 328, overflowY: "auto" }}>
                {visible.length === 0 ? (
                  <div style={{ padding: 26, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
                    {q.trim() ? `Brak wyników dla „${q.trim()}"`
                      : tab === "order" ? "Nic nie wymaga zamówienia — czysto."
                        : tab === "sample" ? "Brak sampli u tego producenta."
                          : tab === "fav" ? "Żadne SKU tego producenta nie jest obserwowane."
                            : "Brak produktów przypiętych do tego producenta."}
                  </div>
                ) : visible.map((p, i) => (
                  <div key={p.sku} onClick={() => onProductClick?.(p.sku)} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                    cursor: onProductClick ? "pointer" : "default",
                    borderBottom: i === visible.length - 1 ? "none" : "1px solid var(--border-soft)",
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                    {/* Gwiazdka zamiast osobnej kolumny „obserwowane" — na zakładce Wszystkie
                        od razu widać, które SKU w ogóle wchodzi do Pożarów. */}
                    <span style={{ width: 12, display: "flex", flexShrink: 0, color: "var(--accent)", visibility: p.is_favorite ? "visible" : "hidden" }}>
                      <I.StarFill size={12} />
                    </span>
                    <span style={{ width: 118, flexShrink: 0 }}>
                      <StatusPillExt status={displayStatus(p)} size="sm" />
                    </span>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600, width: 84, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{p.sku}</span>
                    <span style={{ fontSize: 12, color: "var(--text-mid)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span className="num" style={{ fontSize: 11, color: "var(--text-lo)", flexShrink: 0, whiteSpace: "nowrap", textAlign: "right" }}>
                      stan {p.stock}
                      {p.stock_in_transit > 0 && <> · <span style={{ color: "var(--info)" }}>+{p.stock_in_transit} w drodze</span></>}
                      {p.avg_monthly_weighted >= 1 && <> · {Math.round(p.avg_monthly_weighted)}/mies</>}
                      {(p.status === "KRYTYCZNY" || p.status === "ZAMOW_TERAZ") && p.avg_monthly_weighted >= 1 && isFinite(p.days_until_empty) && (
                        <> · <span style={{ color: "var(--critical)" }}>{Math.max(0, Math.round(p.days_until_empty))}d do zera</span></>
                      )}
                      {showFin && p.stock_value > 0 && <> · <span style={{ color: "var(--text-mid)" }}>{fmtPLNk(p.stock_value)}</span></>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </FcSection>

          {/* Kontenery w drodze */}
          {inFlight.length > 0 && (
            <FcSection title={`Kontenery w drodze (${inFlight.length})`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {shownFlight.map((c) => {
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
                {!contAll && inFlight.length > CONT_PREVIEW && (
                  <button onClick={() => setContAll(true)} style={{
                    width: "100%", padding: 8, background: "var(--surface-1)", border: "1px dashed var(--border)",
                    borderRadius: 8, color: "var(--text-lo)", fontFamily: "inherit", fontSize: 11.5,
                    fontWeight: 600, cursor: "pointer",
                  }}>
                    Pokaż {plPick(inFlight.length - CONT_PREVIEW, "pozostały", "pozostałe", "pozostałych")} {inFlight.length - CONT_PREVIEW} {plPick(inFlight.length - CONT_PREVIEW, "kontener", "kontenery", "kontenerów")}
                  </button>
                )}
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
