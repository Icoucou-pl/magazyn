"use client";
// ============================================================
// MAGAZYN — Auto-sugestia kontenera (kreator 3-krokowy). Port auto-suggest.jsx z mocka.
//   Krok 1 Parametry: producent + typ kontenera + horyzont planowania.
//   Krok 2 Sugestia: lista pozycji (edytowalne ilości, usuwanie), podsumowanie CBM/wartość.
//   Krok 3 Utwórz: dane kontenera → POST /containers.
//   Algorytm dąży do PEŁNEGO wypełnienia kontenera (patrz computeContainerFill).
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, MfrChip } from "./ui";
import { modalBackdrop, modalCard, Portal, type Product, type Manufacturer } from "./products-ui";
import type { ContainerType } from "./container-form";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { can, useUser } from "@/lib/permissions";
import { fmtPLN, fmtNum } from "@/lib/format";

// ============================================================
// Algorytm doboru pozycji — dąży do pełnego wypełnienia kontenera.
//   Faza 1: pokrycie realnej potrzeby (avg*horyzont − stan − w drodze), wg pilności.
//   Faza 2: dopełnianie wolnej przestrzeni po 1 szt do produktu o najniższym
//           prognozowanym pokryciu (zbalansowane wg popytu), aż nic się nie zmieści.
// Dzięki fazie 2 nie ma już „4 produkty po 1 szt" — kontener zapełnia się do ~100%.
// ============================================================
export type FillPool = {
  sku: string; name: string; stock: number; stock_in_transit: number;
  avg_monthly_weighted: number; cbm_per_unit: number; purchase_price: number;
};

export type FillUrgency = "critical" | "high" | "medium" | "low";

export type FillLine = {
  sku: string; name: string; stock: number; in_transit: number; avg_month: number;
  needed: number; quantity: number; unit_cost: number; cbm_per_unit: number;
  cbm_total: number; is_partial: boolean; urgency: FillUrgency;
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function computeContainerFill(pool: FillPool[], capacityCbm: number, months: number, usedCbm = 0): FillLine[] {
  const capacity = Math.max(0, capacityCbm - usedCbm);
  const eps = 1e-9;

  const cand = pool
    .filter((p) => (p.avg_monthly_weighted || 0) >= 1 && (p.cbm_per_unit || 0) > 0)
    .map((p) => {
      const avg = p.avg_monthly_weighted;
      const onHand = (p.stock || 0) + (p.stock_in_transit || 0);
      const needed = Math.max(0, Math.ceil(avg * months - onHand));
      const coverage = onHand / avg;                 // miesięcy zapasu (im mniej, tym pilniej)
      const urgency: FillUrgency = coverage < 1 ? "critical" : coverage < 2 ? "high" : coverage < 4 ? "medium" : "low";
      return { p, needed, coverage, urgency, qty: 0 };
    });

  if (capacity <= 0 || cand.length === 0) return [];

  let remaining = capacity;

  // Faza 1 — realna potrzeba, wg pilności (najmniej miesięcy zapasu na górze)
  for (const c of [...cand].sort((a, b) => a.coverage - b.coverage)) {
    if (c.needed <= 0) continue;
    const fit = Math.floor((remaining + eps) / c.p.cbm_per_unit);
    if (fit <= 0) continue;
    const take = Math.min(c.needed, fit);
    c.qty += take;
    remaining -= take * c.p.cbm_per_unit;
  }

  // Faza 2 — dopełnij do pełna po 1 szt (najniższe prognozowane pokrycie = najpilniejszy)
  const minCbm = Math.min(...cand.map((c) => c.p.cbm_per_unit));
  let guard = 200000;
  while (remaining + eps >= minCbm && guard-- > 0) {
    let best: (typeof cand)[number] | null = null;
    let bestCov = Infinity;
    for (const c of cand) {
      if (c.p.cbm_per_unit > remaining + eps) continue;
      const cov = ((c.p.stock || 0) + (c.p.stock_in_transit || 0) + c.qty) / c.p.avg_monthly_weighted;
      if (cov < bestCov) { bestCov = cov; best = c; }
    }
    if (!best) break;
    best.qty += 1;
    remaining -= best.p.cbm_per_unit;
  }

  return cand
    .filter((c) => c.qty > 0)
    .sort((a, b) => a.coverage - b.coverage)
    .map((c) => ({
      sku: c.p.sku, name: c.p.name, stock: c.p.stock, in_transit: c.p.stock_in_transit,
      avg_month: c.p.avg_monthly_weighted, needed: c.needed, quantity: c.qty,
      unit_cost: c.p.purchase_price, cbm_per_unit: c.p.cbm_per_unit,
      cbm_total: r3(c.qty * c.p.cbm_per_unit), is_partial: c.qty < c.needed, urgency: c.urgency,
    }));
}

// ============================================================
type Suggestion = {
  items: FillLine[]; capacity_cbm: number;
  total_units: number; total_value: number; total_cbm: number; fill_pct: number;
};

function recompute(s: Suggestion) {
  s.total_units = s.items.reduce((sum, i) => sum + i.quantity, 0);
  s.total_value = Math.round(s.items.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0) * 100) / 100;
  s.total_cbm = r3(s.items.reduce((sum, i) => sum + i.cbm_total, 0));
  s.fill_pct = s.capacity_cbm > 0 ? Math.round((s.total_cbm / s.capacity_cbm) * 1000) / 10 : 0;
}

const today = () => new Date().toISOString().slice(0, 10);
const plus90 = () => { const d = new Date(); d.setDate(d.getDate() + 90); return d.toISOString().slice(0, 10); };

export default function AutoSuggestModal({
  manufacturers, containerTypes, products, onClose, onCreated,
}: {
  manufacturers: Manufacturer[];
  containerTypes: ContainerType[];
  products: Product[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const showFin = can(useUser(), "viewFinancials");
  const [step, setStep] = useState(1);
  const [manufacturerId, setManufacturerId] = useState("");
  const [containerTypeId, setContainerTypeId] = useState<string>(containerTypes[0] ? String(containerTypes[0].id) : "");
  const [monthsHorizon, setMonthsHorizon] = useState(6);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [loading, setLoading] = useState(false);

  const [containerNumber, setContainerNumber] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [orderDate, setOrderDate] = useState(today());
  const [etaDate, setEtaDate] = useState(plus90());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const generate = () => {
    if (!manufacturerId || !containerTypeId) { toast("Wybierz producenta i typ kontenera", "warning"); return; }
    const ct = containerTypes.find((t) => String(t.id) === containerTypeId);
    const capacity = ct?.capacity_cbm || 0;
    const pool = products.filter((p) => p.manufacturer_id === Number(manufacturerId));
    setLoading(true);
    setTimeout(() => {
      const items = computeContainerFill(pool, capacity, monthsHorizon);
      const s: Suggestion = { items, capacity_cbm: capacity, total_units: 0, total_value: 0, total_cbm: 0, fill_pct: 0 };
      recompute(s);
      setSuggestion(s);
      setStep(2);
      setLoading(false);
    }, 320);
  };

  const updateItemQty = (idx: number, newQty: string) => {
    if (!suggestion) return;
    const next: Suggestion = { ...suggestion, items: [...suggestion.items] };
    const it = { ...next.items[idx] };
    const q = Math.max(0, parseInt(newQty, 10) || 0);
    it.quantity = q;
    it.cbm_total = r3(q * it.cbm_per_unit);
    it.is_partial = q < it.needed;
    next.items[idx] = it;
    recompute(next);
    setSuggestion(next);
  };

  const removeItem = (idx: number) => {
    if (!suggestion) return;
    const next: Suggestion = { ...suggestion, items: suggestion.items.filter((_, i) => i !== idx) };
    recompute(next);
    setSuggestion(next);
  };

  const createContainer = async () => {
    if (busy) return;
    if (!containerNumber.trim()) { toast("Podaj numer kontenera", "warning"); return; }
    const items = (suggestion?.items || []).filter((i) => i.quantity > 0);
    if (items.length === 0) { toast("Brak pozycji do zamówienia", "warning"); return; }
    const payload = {
      container_number: containerNumber.trim().toUpperCase(),
      order_number: orderNumber.trim() || null,
      container_type_id: Number(containerTypeId),
      manufacturer_id: Number(manufacturerId),
      order_date: orderDate,
      eta_date: etaDate,
      status: "ORDERED",
      notes: `Wygenerowane automatycznie. Horyzont: ${monthsHorizon} mies. Wypełnienie: ${suggestion?.fill_pct}%`,
      is_consolidated: false,
      lots: [],
      items: items.map((i) => ({ sku: i.sku, quantity: i.quantity, unit_cost: i.unit_cost || null })),
    };
    setBusy(true);
    try {
      await api.post("/containers", payload);
      toast(`Utworzono kontener #${payload.container_number}`, "ok");
      onCreated();
      onClose();
    } catch (e) {
      const st = (e as { status?: number })?.status;
      toast(st === 400 ? "ETA nie może być przed datą zamówienia" : "Nie udało się utworzyć kontenera", "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Portal>
      <div onClick={onClose} style={modalBackdrop}>
        <div onClick={(e) => e.stopPropagation()} className="fade-in" style={{ ...modalCard, maxWidth: 760 }}>
          {/* Header */}
          <div style={{ padding: "14px 22px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, position: "relative" }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: "var(--anomaly)" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--anomaly-soft)", color: "var(--anomaly)", display: "flex", alignItems: "center", justifyContent: "center" }}><I.Wand size={16} /></div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-hi)" }}>Auto-sugestia kontenera</div>
                <div style={{ fontSize: 11, color: "var(--text-lo)" }}>Algorytm dobierze produkty tak, żeby wypełnić kontener do pełna</div>
              </div>
            </div>
            <button onClick={onClose} style={iconBtnHeader}><I.Close size={14} /></button>
          </div>

          <Stepper step={step} steps={["Parametry", "Sugestia", "Utwórz"]} />

          <div style={{ overflowY: "auto", padding: 22, flex: 1 }}>
            {step === 1 && (
              <Step1 {...{ manufacturers, containerTypes, products, manufacturerId, setManufacturerId, containerTypeId, setContainerTypeId, monthsHorizon, setMonthsHorizon, loading, generate }} />
            )}
            {step === 2 && suggestion && (
              <Step2 {...{ suggestion, monthsHorizon, updateItemQty, removeItem, setStep, showFin }} />
            )}
            {step === 3 && suggestion && (
              <Step3 {...{ suggestion, manufacturers, containerTypes, manufacturerId, containerTypeId, containerNumber, setContainerNumber, orderNumber, setOrderNumber, orderDate, setOrderDate, etaDate, setEtaDate, setStep, createContainer, busy, showFin }} />
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

// ── Stepper ──────────────────────────────────────────────────
function Stepper({ step, steps }: { step: number; steps: string[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, padding: "14px 22px", borderBottom: "1px solid var(--border-soft)" }}>
      {steps.map((label, i) => {
        const s = i + 1;
        const reached = step >= s;
        const active = step === s;
        return (
          <React.Fragment key={s}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <div style={{ width: 24, height: 24, borderRadius: 99, background: reached ? "var(--anomaly)" : "var(--surface-2)", color: reached ? "white" : "var(--text-lo)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, border: active ? "2px solid var(--anomaly-soft)" : "1px solid var(--border-soft)", transition: "all 0.16s" }}>
                {reached && step > s ? <I.Activity size={11} /> : s}
              </div>
              <span style={{ fontSize: 12, fontWeight: 500, color: active ? "var(--text-hi)" : reached ? "var(--text-mid)" : "var(--text-lo)" }}>{label}</span>
            </div>
            {i < steps.length - 1 && (
              <div style={{ flex: 1, height: 2, background: step > s ? "var(--anomaly)" : "var(--surface-2)", margin: "0 12px", transition: "background 0.2s" }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Krok 1: Parametry ────────────────────────────────────────
function Step1({
  manufacturers, containerTypes, products, manufacturerId, setManufacturerId,
  containerTypeId, setContainerTypeId, monthsHorizon, setMonthsHorizon, loading, generate,
}: {
  manufacturers: Manufacturer[]; containerTypes: ContainerType[]; products: Product[];
  manufacturerId: string; setManufacturerId: (v: string) => void;
  containerTypeId: string; setContainerTypeId: (v: string) => void;
  monthsHorizon: number; setMonthsHorizon: (v: number) => void;
  loading: boolean; generate: () => void;
}) {
  const selectedMfr = manufacturers.find((m) => String(m.id) === manufacturerId);
  const selectedType = containerTypes.find((t) => String(t.id) === containerTypeId);

  const preview = useMemo(() => {
    if (!manufacturerId) return null;
    const mfrProducts = products.filter((p) => p.manufacturer_id === Number(manufacturerId) && (p.avg_monthly_weighted || 0) > 0);
    const needing = mfrProducts.filter((p) => p.avg_monthly_weighted * monthsHorizon - p.stock - p.stock_in_transit > 0);
    return { total: mfrProducts.length, needing: needing.length };
  }, [manufacturerId, monthsHorizon, products]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Field label="Producent" required>
        <select value={manufacturerId} onChange={(e) => setManufacturerId(e.target.value)} style={inputStyle} autoFocus>
          <option value="">— wybierz producenta —</option>
          {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        {selectedMfr && <div style={{ marginTop: 6 }}><MfrChip name={selectedMfr.name} color={selectedMfr.color} size="sm" /></div>}
      </Field>

      <Field label="Typ kontenera" required>
        <select value={containerTypeId} onChange={(e) => setContainerTypeId(e.target.value)} style={inputStyle}>
          {containerTypes.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.capacity_cbm} m³</option>)}
        </select>
        {selectedType && (
          <div className="num" style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 6 }}>
            Pojemność do wypełnienia: <strong style={{ color: "var(--text-mid)" }}>{selectedType.capacity_cbm} m³</strong>
          </div>
        )}
      </Field>

      <Field label={<>Horyzont planowania: <span className="num" style={{ color: "var(--anomaly)", fontWeight: 700 }}>{monthsHorizon} mies.</span></>}>
        <input type="range" min={3} max={12} value={monthsHorizon} onChange={(e) => setMonthsHorizon(parseInt(e.target.value, 10))} style={{ width: "100%", accentColor: "var(--anomaly)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
          <span>3 mies (bezpiecznie)</span>
          <span className="num">{monthsHorizon}m</span>
          <span>12 mies (z zapasem)</span>
        </div>
      </Field>

      <div style={{ padding: "12px 14px", background: "var(--anomaly-soft)", border: "1px solid color-mix(in oklch, var(--anomaly) 30%, var(--border))", borderRadius: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <I.Activity size={12} style={{ color: "var(--anomaly)" }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--anomaly)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Jak liczy algorytm</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.5 }}>
          Dla każdego SKU: <span style={{ color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>śr. sprzedaż × {monthsHorizon} − stan − w drodze = potrzebne</span>
          <br />
          Sortuje wg pilności, pokrywa potrzeby, a wolną przestrzeń dopełnia wg popytu — aż do pełnego kontenera.
        </div>
        {preview && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, paddingTop: 10, borderTop: "1px solid color-mix(in oklch, var(--anomaly) 30%, transparent)" }}>
            <span style={{ fontSize: 11, color: "var(--text-mid)" }}>Producent ma:</span>
            <span className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{preview.needing}</span>
            <span style={{ fontSize: 11, color: "var(--text-lo)" }}>SKU wymagających uzupełnienia · {preview.total} sprzedających się łącznie</span>
          </div>
        )}
      </div>

      <button onClick={generate} disabled={!manufacturerId || loading} style={{ ...btnPrimaryFull, background: "var(--anomaly)", color: "white", borderColor: "var(--anomaly)", opacity: (!manufacturerId || loading) ? 0.5 : 1, cursor: (!manufacturerId || loading) ? "not-allowed" : "pointer" }}>
        {loading ? (<><span className="pulse-soft"><I.Refresh size={14} /></span> Generuję sugestię…</>) : (<><I.Wand size={14} /> Wygeneruj sugestię</>)}
      </button>
    </div>
  );
}

// ── Krok 2: Sugestia ─────────────────────────────────────────
function Step2({
  suggestion, monthsHorizon, updateItemQty, removeItem, setStep, showFin,
}: {
  suggestion: Suggestion; monthsHorizon: number;
  updateItemQty: (idx: number, v: string) => void; removeItem: (idx: number) => void;
  setStep: (s: number) => void; showFin: boolean;
}) {
  if (suggestion.items.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ padding: 32, textAlign: "center", background: "var(--warning-soft)", border: "1px solid color-mix(in oklch, var(--warning) 40%, var(--border))", borderRadius: 10 }}>
          <I.Alert size={32} style={{ color: "var(--warning)", marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-hi)" }}>Brak produktów do zamówienia</div>
          <div style={{ fontSize: 12, color: "var(--text-mid)", marginTop: 6, lineHeight: 1.5 }}>
            Ten producent nie ma produktów wymagających uzupełnienia<br />w horyzoncie {monthsHorizon} miesięcy.
          </div>
        </div>
        <button onClick={() => setStep(1)} style={btnSecondaryFull}><I.ArrowRight size={12} style={{ transform: "rotate(180deg)" }} /> Wstecz — zmień parametry</button>
      </div>
    );
  }

  const fillColor = suggestion.fill_pct > 100 ? "var(--critical)" : suggestion.fill_pct > 90 ? "var(--warning)" : suggestion.fill_pct > 70 ? "var(--ok)" : "var(--info)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ padding: 16, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: showFin ? "repeat(3, 1fr)" : "repeat(2, 1fr)", gap: 12, marginBottom: 12 }}>
          <StatBlock label="CBM" value={`${suggestion.total_cbm} / ${suggestion.capacity_cbm}`} sub="m³" />
          <StatBlock label="Sztuk" value={fmtNum(suggestion.total_units)} sub={`${suggestion.items.length} SKU`} />
          {showFin && <StatBlock label="Wartość" value={fmtPLN(suggestion.total_value)} sub="łącznie" />}
        </div>
        <div style={{ marginTop: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Wypełnienie</span>
            <span className="num" style={{ fontSize: 16, fontWeight: 700, color: fillColor }}>{suggestion.fill_pct}%</span>
          </div>
          <div style={{ height: 8, background: "var(--surface-3)", borderRadius: 99, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, suggestion.fill_pct)}%`, background: fillColor, borderRadius: 99, transition: "width 0.3s" }} />
          </div>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
          Produkty ({suggestion.items.length}) · posortowane wg pilności
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
          {suggestion.items.map((item, idx) => (
            <SuggestionItem key={item.sku} item={item} showFin={showFin} onQtyChange={(v) => updateItemQty(idx, v)} onRemove={() => removeItem(idx)} />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setStep(1)} style={btnSecondaryFull}><I.ArrowRight size={12} style={{ transform: "rotate(180deg)" }} /> Wstecz</button>
        <button onClick={() => setStep(3)} style={{ ...btnPrimaryFull, background: "var(--anomaly)", color: "white", borderColor: "var(--anomaly)" }}>Dalej: utwórz kontener <I.ArrowRight size={12} /></button>
      </div>
    </div>
  );
}

function SuggestionItem({ item, onQtyChange, onRemove, showFin }: { item: FillLine; onQtyChange: (v: string) => void; onRemove: () => void; showFin: boolean }) {
  const urgencyMeta =
    item.urgency === "critical" ? { color: "var(--critical)", label: "KRYT", bg: "var(--critical-soft)" } :
    item.urgency === "high" ? { color: "var(--warning)", label: "WYS", bg: "var(--warning-soft)" } :
    item.urgency === "medium" ? { color: "var(--pending)", label: "ŚR", bg: "var(--pending-soft)" } :
    { color: "var(--ok)", label: "NIS", bg: "var(--ok-soft)" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: `32px minmax(0, 1fr) 70px ${showFin ? "100px" : "70px"} 24px`, gap: 10, alignItems: "center", padding: "8px 10px", background: item.is_partial ? "color-mix(in oklch, var(--warning) 6%, var(--surface-1))" : "var(--surface-1)", border: `1px solid ${item.is_partial ? "color-mix(in oklch, var(--warning) 40%, var(--border))" : "var(--border-soft)"}`, borderRadius: 7 }}>
      <span title={`Pilność: ${item.urgency}`} style={{ padding: "2px 4px", fontSize: 9, fontWeight: 700, background: urgencyMeta.bg, color: urgencyMeta.color, borderRadius: 4, textAlign: "center", fontFamily: "var(--font-mono)" }}>{urgencyMeta.label}</span>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)", fontFamily: "var(--font-mono)" }}>{item.sku}</span>
          {item.is_partial && <span title="Zmieści się tylko częściowo" style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "var(--warning-soft)", color: "var(--warning)" }}>CZĘŚC.</span>}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
        <div className="num" style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 2 }}>
          <span>stan {item.stock}</span>
          {item.in_transit > 0 && <span style={{ color: "var(--info)" }}> · +{item.in_transit} w drodze</span>}
          <span> · {Math.round(item.avg_month)}/mies</span>
          <span> · potrzeba <strong style={{ color: "var(--text-mid)" }}>{item.needed}</strong></span>
        </div>
      </div>

      <input type="number" value={item.quantity} onChange={(e) => onQtyChange(e.target.value)} min={0} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, fontFamily: "var(--font-mono)", textAlign: "center", width: 70 }} />

      <div style={{ textAlign: "right" }}>
        <div className="num" style={{ fontSize: 11, color: "var(--text-mid)" }}>{item.cbm_total} m³</div>
        {showFin && <div className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{fmtPLN(item.unit_cost * item.quantity)}</div>}
      </div>

      <button onClick={onRemove} title="Usuń pozycję" style={{ background: "transparent", border: "none", color: "var(--critical)", padding: 4, display: "flex", cursor: "pointer" }}><I.Close size={12} /></button>
    </div>
  );
}

function StatBlock({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>{label}</div>
      <div className="num" style={{ fontSize: 17, fontWeight: 600, color: "var(--text-hi)", marginTop: 3, letterSpacing: "-0.01em" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-lo)" }}>{sub}</div>}
    </div>
  );
}

// ── Krok 3: Utwórz ───────────────────────────────────────────
function Step3({
  suggestion, manufacturers, containerTypes, manufacturerId, containerTypeId,
  containerNumber, setContainerNumber, orderNumber, setOrderNumber, orderDate, setOrderDate,
  etaDate, setEtaDate, setStep, createContainer, busy, showFin,
}: {
  suggestion: Suggestion; manufacturers: Manufacturer[]; containerTypes: ContainerType[];
  manufacturerId: string; containerTypeId: string;
  containerNumber: string; setContainerNumber: (v: string) => void;
  orderNumber: string; setOrderNumber: (v: string) => void;
  orderDate: string; setOrderDate: (v: string) => void;
  etaDate: string; setEtaDate: (v: string) => void;
  setStep: (s: number) => void; createContainer: () => void; busy: boolean; showFin: boolean;
}) {
  const mfr = manufacturers.find((m) => String(m.id) === manufacturerId);
  const ct = containerTypes.find((t) => String(t.id) === containerTypeId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <Field label="Nr kontenera" required>
          <input value={containerNumber} onChange={(e) => setContainerNumber(e.target.value.toUpperCase())} autoFocus placeholder="np. MSCU-7821934" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
        </Field>
        <Field label="Nr zamówienia (PO)">
          <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="np. PO-2026-001" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
        </Field>
        <Field label="Data zamówienia" required>
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="ETA dostawy" required>
          <input type="date" value={etaDate} onChange={(e) => setEtaDate(e.target.value)} style={inputStyle} />
        </Field>
      </div>

      <div style={{ padding: 14, background: "var(--anomaly-soft)", border: "1px solid color-mix(in oklch, var(--anomaly) 30%, var(--border))", borderRadius: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--anomaly)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Podsumowanie kontenera</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
          <SummaryRow label="Producent" value={mfr ? <MfrChip name={mfr.name} color={mfr.color} size="sm" /> : "—"} />
          <SummaryRow label="Typ" value={<span style={{ fontSize: 12, fontWeight: 600 }}>{ct?.name}</span>} />
          <SummaryRow label="Produktów" value={<span className="num" style={{ fontSize: 13, fontWeight: 600 }}>{suggestion.items.length}</span>} />
          <SummaryRow label="Sztuk" value={<span className="num" style={{ fontSize: 13, fontWeight: 600 }}>{fmtNum(suggestion.total_units)}</span>} />
          {showFin && <SummaryRow label="Wartość" value={<span className="num" style={{ fontSize: 13, fontWeight: 600 }}>{fmtPLN(suggestion.total_value)}</span>} />}
          <SummaryRow label="Wypełnienie" value={<span className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--anomaly)" }}>{suggestion.fill_pct}%</span>} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setStep(2)} disabled={busy} style={btnSecondaryFull}><I.ArrowRight size={12} style={{ transform: "rotate(180deg)" }} /> Wstecz</button>
        <button onClick={createContainer} disabled={!containerNumber.trim() || busy} style={{ ...btnPrimaryFull, background: "var(--ok)", color: "white", borderColor: "var(--ok)", opacity: (!containerNumber.trim() || busy) ? 0.5 : 1, cursor: (!containerNumber.trim() || busy) ? "not-allowed" : "pointer" }}>
          <I.Plus size={12} /> {busy ? "Tworzę…" : "Utwórz kontener"}
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ marginTop: 3 }}>{value}</div>
    </div>
  );
}

// ── Helpery / style ──────────────────────────────────────────
function Field({ label, required, children }: { label: React.ReactNode; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
        {label}{required && <span style={{ color: "var(--critical)", marginLeft: 3 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text-hi)", outline: "none", fontFamily: "inherit",
};
const iconBtnHeader: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, background: "transparent", border: "1px solid var(--border-soft)", borderRadius: 7, color: "var(--text-mid)",
};
const btnPrimaryFull: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flex: 1, padding: "11px 16px", background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--accent-ink)", borderRadius: 8, fontSize: 13, fontWeight: 600,
};
const btnSecondaryFull: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flex: 1, padding: "11px 16px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 8, fontSize: 13, fontWeight: 500,
};
