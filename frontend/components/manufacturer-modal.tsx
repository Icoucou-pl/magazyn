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
  modalBackdrop, modalCard, Portal,
  type Product, type Manufacturer, type Firma,
} from "./products-ui";
import ProductModal from "./product-modal";
import { SeasonChart, type SeasonPoint } from "./season-chart";
import { mfrPipeline, belongsToMfr, isUndelivered, countLabel, plPick } from "@/lib/pipeline";

// Wartość magazynu = te same statusy co na pulpicie. Pulpit liczy ją z /stock-value-history,
// które bierze ACTIVE + ACTIVE_NO_STOCK + DEAD_STOCK — bez INACTIVE. Modal dostaje listę
// z /products?include=…,INACTIVE (macierz prognozy tego potrzebuje), więc INACTIVE trzeba
// odsiać tutaj, inaczej kafelek pokazywał więcej niż pulpit. Sama kwota liczy się identycznie:
// stock × purchase_price (backend: stock_value), gdzie cena idzie ręczna → Fakturownia → Subiekt.
const IN_STOCK_VALUE = new Set(["ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK"]);

// Podpis „N do zamówienia" pod kafelkiem SKU = ta sama reguła co Pożary na Dashboardzie.
// Tam listę robi backend (/shopping-list?favorites_only=1), więc outlety, dead stock
// i „nie dozamawiamy" nigdy tam nie docierają. Tutaj produkty przychodzą z /products
// (pełen asortyment), dlatego ten sam filtr trzeba nałożyć klientowo.
function needsOrder(p: Product): boolean {
  if (p.product_status !== "ACTIVE" && p.product_status !== "ACTIVE_NO_STOCK") return false;
  if (!p.is_favorite) return false;          // tylko obserwowane — jak favorites_only=1
  if (p.no_reorder) return false;            // ręcznie wyłączone z zamawiania
  if (p.avg_monthly_weighted < 1) return false;  // < 1 szt./mies. to nie pożar
  return p.status === "KRYTYCZNY" || p.status === "ZAMOW_TERAZ";
}

// ── Lista produktów: zakładki ────────────────────────────────
// Lista jest CELOWO uboga — odpowiada na jedno pytanie: „co ten producent u nas ma".
// Wiersz to SKU, nazwa i stan; statusy, rotacja, ilości w drodze/w kontenerach, dni do
// zera i wartości siedzą w Prognozie, w zakładce Produkty i w samej karcie produktu
// (jeden klik stąd) — dublowanie ich tutaj robiło z modala trzecią tabelę tego samego.
//
// SAMPLE nie jest flagą obok statusu — backend (services/products.py) daje takiemu SKU
// product_status = "SAMPLE" ZAMIAST właściwego. Dlatego „Wszystkie" musi jawnie odsiać
// sample, inaczej licznik zakładki rozjeżdża się z kafelkiem „Produktów (SKU)".
type MpTab = "fav" | "all" | "sample";

const MP_TABS: { key: MpTab; label: string; test: (p: Product) => boolean }[] = [
  { key: "fav",    label: "Obserwowane", test: (p) => p.product_status !== "SAMPLE" && p.is_favorite },
  { key: "all",    label: "Wszystkie",   test: (p) => p.product_status !== "SAMPLE" },
  { key: "sample", label: "Sample",      test: (p) => p.product_status === "SAMPLE" },
];

// Ile kontenerów pokazujemy bez rozwijania. Producent z 12 pozycjami w drodze
// (Anji) zjadał cały modal i spychał listę produktów pod ekran.
const CONT_PREVIEW = 6;

// ── Szczegóły producenta (port ManufacturerModal) ────────────
export default function ManufacturerModal({
  mfr, products, containers, manufacturers, firmy, showFin, onClose, onContainerClick,
}: {
  mfr: Manufacturer | null;
  products: Product[];
  /** WSZYSTKIE kontenery, nie zawężone do producenta — zawężenie robi modal, bo w kontenerach
   *  skonsolidowanych producent siedzi na locie, a nie na kontenerze (c.manufacturer_id = NULL). */
  containers: Container[];
  /** Pełna lista producentów — leci do zagnieżdżonej karty produktu, żeby dało się tam
   *  przepiąć SKU do innego producenta. Bez tego select miałby jedną pozycję. */
  manufacturers?: Manufacturer[];
  firmy?: Firma[];
  showFin: boolean;
  onClose: () => void;
  onContainerClick?: (id: number) => void;
}) {
  const [season, setSeason] = useState<SeasonPoint[] | null>(null);
  const [seasonErr, setSeasonErr] = useState(false);
  const [tab, setTab] = useState<MpTab>("fav");
  const [q, setQ] = useState("");
  const [contAll, setContAll] = useState(false);
  // Karta produktu otwierana NA modalu producenta, nie zamiast niego — zamknięcie
  // wraca do listy producenta. Wcześniej klik przerzucał widok na Produkty i po
  // zamknięciu karty człowiek zostawał tam, z rozwalonym kontekstem.
  const [openSku, setOpenSku] = useState<string | null>(null);
  // Edycje z karty produktu (gwiazdka, producent, klasyfikacja) nakładamy lokalnie —
  // lista producenta dostaje dane od rodzica i sama ich nie przeładowuje.
  const [patches, setPatches] = useState<Record<string, Product>>({});

  const mfrId = mfr?.id;

  useEffect(() => {
    // Gdy na wierzchu jest karta produktu, Esc ma zamknąć tylko ją. Bez tego obie
    // obsługi łapią to samo zdarzenie i modal producenta znika razem z kartą.
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !openSku) onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose, openSku]);

  useEffect(() => {
    if (mfrId == null) return;
    let alive = true;
    setSeason(null); setSeasonErr(false);
    api.get(`/manufacturers/${mfrId}/sales-season`)
      .then((d) => { if (alive) setSeason((d as SeasonPoint[]) || []); })
      .catch(() => { if (alive) setSeasonErr(true); });
    return () => { alive = false; };
  }, [mfrId]);

  // Reset przy zmianie producenta. `counts` czytamy w środku, ale go nie śledzimy —
  // odznaczenie ostatniej gwiazdki nie ma przerzucać zakładki pod palcami.
  useEffect(() => {
    if (mfrId == null) return;
    setTab("fav"); setQ(""); setContAll(false); setPatches({}); setOpenSku(null);
  }, [mfrId]);

  // Produkty po nałożeniu lokalnych edycji. SKU przepięte w karcie do innego
  // producenta wypada z listy od razu, zamiast wisieć do przeładowania widoku.
  const effProducts = useMemo(() => {
    if (Object.keys(patches).length === 0) return products;
    return products
      .map((p) => patches[p.sku] ?? p)
      .filter((p) => patches[p.sku] == null || p.manufacturer_id === mfrId);
  }, [products, patches, mfrId]);

  const counts = useMemo(() => {
    const c: Record<MpTab, number> = { fav: 0, all: 0, sample: 0 };
    for (const p of effProducts) for (const t of MP_TABS) if (t.test(p)) c[t.key] += 1;
    return c;
  }, [effProducts]);

  const needOrderCount = useMemo(() => effProducts.filter(needsOrder).length, [effProducts]);

  // Producent bez ani jednego obserwowanego SKU pokazałby pustą listę na wejściu —
  // wtedy (i tylko wtedy) spadamy na „Wszystkie".
  const effTab: MpTab = tab === "fav" && counts.fav === 0 ? "all" : tab;

  const visible = useMemo(() => {
    const t = MP_TABS.find((x) => x.key === effTab) || MP_TABS[1];
    const ql = q.trim().toLowerCase();
    return effProducts
      .filter((p) => {
        if (!t.test(p)) return false;
        if (!ql) return true;
        return p.sku.toLowerCase().includes(ql) || (p.name || "").toLowerCase().includes(ql);
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }, [effProducts, effTab, q]);

  const openProduct = useMemo(
    () => (openSku ? effProducts.find((p) => p.sku === openSku) || null : null),
    [openSku, effProducts],
  );

  if (!mfr) return null;

  const mfrExt = mfr as Manufacturer & { contact?: string | null };
  // Kontenery tego producenta = własne + skonsolidowane, w których ma choć jeden lot.
  const mine = containers.filter((c) => belongsToMfr(c, mfr.id));
  // „Dostarczony" po statusie EFEKTYWNYM (auto-dostawa z ETA) — jak na pulpicie.
  // Wcześniej szedł status ręczny, więc kontener po ETA wciąż liczył się jako w drodze.
  const inFlight = mine.filter(isUndelivered);
  const delivered = mine.length - inFlight.length;
  const shownFlight = contAll ? inFlight : inFlight.slice(0, CONT_PREVIEW);
  const stockValue = effProducts
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
            <FcMetricBox label="Produktów (SKU)" value={counts.all} sub={`${needOrderCount} do zamówienia`} tone={needOrderCount ? "warning" : "neutral"} />
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

          {/* Produkty */}
          <FcSection title={`Produkty (${visible.length}${q.trim() ? ` z ${counts[effTab]}` : ""})`}>
            <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                padding: "9px 10px", borderBottom: "1px solid var(--border-soft)",
              }}>
                <div style={{ display: "inline-flex", gap: 2, padding: 2, background: "var(--surface-2)", borderRadius: 8 }}>
                  {MP_TABS.map((t) => {
                    const on = t.key === effTab;
                    return (
                      <button key={t.key} onClick={() => setTab(t.key)} style={{
                        display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 11px",
                        border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                        fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
                        background: on ? "var(--bg-elevated)" : "transparent",
                        color: on ? "var(--text-hi)" : "var(--text-lo)",
                      }}>
                        {t.label}
                        <span className="num" style={{ fontSize: 10.5, color: on ? "var(--text-mid)" : "var(--text-lo)" }}>{counts[t.key]}</span>
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
              </div>

              <div style={{ maxHeight: 328, overflowY: "auto" }}>
                {visible.length === 0 ? (
                  <div style={{ padding: 26, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
                    {q.trim() ? `Brak wyników dla „${q.trim()}"`
                      : effTab === "sample" ? "Brak sampli u tego producenta."
                        : "Brak produktów przypiętych do tego producenta."}
                  </div>
                ) : visible.map((p, i) => (
                  <div key={p.sku} onClick={() => setOpenSku(p.sku)} style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "8px 14px", cursor: "pointer",
                    borderBottom: i === visible.length - 1 ? "none" : "1px solid var(--border-soft)",
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-2)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)", width: 96, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.sku}</span>
                    <span style={{ fontSize: 12, color: "var(--text-mid)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span className="num" style={{ fontSize: 11, color: "var(--text-lo)", flexShrink: 0, whiteSpace: "nowrap", textAlign: "right" }}>
                      stan {p.stock}
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
                    Pokaż pozostałe {inFlight.length - CONT_PREVIEW} {plPick(inFlight.length - CONT_PREVIEW, "kontener", "kontenery", "kontenerów")}
                  </button>
                )}
              </div>
            </FcSection>
          )}
        </div>
      </div>

    </div>

    {/* Karta produktu NA modalu producenta — RODZEŃSTWO tła, nie dziecko.
        React przepuszcza zdarzenia przez drzewo Reacta, nie DOM-u, więc portal
        zagnieżdżony w tle z onClick={onClose} zamykałby modal producenta przy
        każdym kliknięciu w karcie produktu. */}
    {openProduct && (
      <ProductModal
        product={openProduct}
        manufacturers={manufacturers && manufacturers.length ? manufacturers : [mfr]}
        firmy={firmy}
        onClose={() => setOpenSku(null)}
        onUpdated={(p) => setPatches((prev) => ({ ...prev, [p.sku]: p }))}
        onContainerClick={onContainerClick}
      />
    )}
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
