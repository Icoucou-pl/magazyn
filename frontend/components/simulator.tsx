"use client";
// ============================================================
// MAGAZYN — Symulator scenariuszy (what-if). Port simulator.jsx z mocka.
//   Modal z dwoma suwakami (mnożnik sprzedaży, opóźnienie dostaw) +
//   gotowe scenariusze. Przelicza klientowo każdy aktywny produkt pod
//   nowymi parametrami, porównuje rozkład statusów (bazowy vs symulowany)
//   i listuje produkty, które pogarszają status.
//   Dane realne: Product[] z /api/products (te same co Prognoza).
//   Model 1:1 z mocka — pojedyncza dostawa z stock_in_transit, dzienna
//   projekcja na 730 dni. Wynik orientacyjny.
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, StatusPill, STATUS_META } from "./ui";
import { Portal, modalBackdrop, modalCard, btnSecondary, type Product } from "./products-ui";

// ── Statusy urgencji (kolejność = eskalacja od najgorszego) ──
type SimStatusKey = "KRYTYCZNY" | "ZAMOW_TERAZ" | "ZAMOW_WKROTCE" | "OK";

const SIM_STATUSES: Array<{ key: SimStatusKey; label: string; color: string; bad: boolean }> = [
  { key: "KRYTYCZNY",     label: "KRYTYCZNY",     color: "var(--critical)", bad: true  },
  { key: "ZAMOW_TERAZ",   label: "ZAMÓW TERAZ",   color: "var(--warning)",  bad: true  },
  { key: "ZAMOW_WKROTCE", label: "ZAMÓW WKRÓTCE", color: "var(--pending)",  bad: false },
  { key: "OK",            label: "OK",            color: "var(--ok)",       bad: false },
];

// Ranga statusu (mniejsza = gorsza) — do wykrycia pogorszenia.
const SIM_RANK: Record<string, number> = { KRYTYCZNY: 0, ZAMOW_TERAZ: 1, ZAMOW_WKROTCE: 2, OK: 3 };

type SimRow = Product & {
  sim_avg: number;
  sim_days_until_empty: number;
  sim_status: SimStatusKey;
  status_changed: boolean;
  got_worse: boolean;
};

type StatCounts = Record<SimStatusKey, number>;
const emptyCounts = (): StatCounts => ({ KRYTYCZNY: 0, ZAMOW_TERAZ: 0, ZAMOW_WKROTCE: 0, OK: 0 });

export function SimulatorModal({
  products, loading, onClose, onProductClick,
}: {
  products: Product[];
  loading?: boolean;
  onClose: () => void;
  onProductClick?: (sku: string) => void;
}) {
  const [salesMultiplier, setSalesMultiplier] = useState(1.0);
  const [deliveryDelay, setDeliveryDelay] = useState(0);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  // Symulacja każdego aktywnego produktu pod nowymi parametrami.
  const simulated = useMemo<SimRow[]>(() => {
    return products
      .filter((p) => p.product_status !== "DEAD_STOCK") // pomiń dead stock
      .map((p) => {
        const avg = p.avg_monthly_weighted || 0;
        const lt = p.lead_time_days || 0;
        const inTransit = p.stock_in_transit || 0;
        const newAvg = avg * salesMultiplier;
        const newDaily = newAvg / 30;
        let stock = p.stock;
        let daysUntilEmpty = 9999;
        if (newDaily > 0) {
          // Pojedyncza planowana dostawa z inTransit, przychodzi ~lt*0.6 dnia (opóźniona o N).
          const deliveryDay = inTransit > 0 ? Math.round(lt * 0.6) + deliveryDelay : -1;
          for (let i = 0; i < 730; i++) {
            if (i === deliveryDay) stock += inTransit;
            stock -= newDaily;
            if (stock <= 0) { daysUntilEmpty = i; break; }
          }
        }
        const orderDateOffset = daysUntilEmpty - lt;
        let newStatus: SimStatusKey;
        if (orderDateOffset <= 0 && daysUntilEmpty < lt) newStatus = "KRYTYCZNY";
        else if (orderDateOffset <= 7)  newStatus = "ZAMOW_TERAZ";
        else if (orderDateOffset <= 30) newStatus = "ZAMOW_WKROTCE";
        else newStatus = "OK";
        const beforeRank = SIM_RANK[p.status] ?? 3;
        const afterRank = SIM_RANK[newStatus];
        return {
          ...p,
          sim_avg: newAvg,
          sim_days_until_empty: daysUntilEmpty,
          sim_status: newStatus,
          status_changed: newStatus !== p.status,
          got_worse: afterRank < beforeRank,
        };
      });
  }, [products, salesMultiplier, deliveryDelay]);

  const statsBefore = useMemo(() => {
    const c = emptyCounts();
    simulated.forEach((p) => { if (p.status in c) c[p.status as SimStatusKey]++; });
    return c;
  }, [simulated]);

  const statsAfter = useMemo(() => {
    const c = emptyCounts();
    simulated.forEach((p) => { c[p.sim_status]++; });
    return c;
  }, [simulated]);

  const totalProducts = simulated.length;
  const newCritical = useMemo(() => simulated
    .filter((p) => p.got_worse && (p.sim_status === "KRYTYCZNY" || p.sim_status === "ZAMOW_TERAZ") && (p.avg_monthly_weighted || 0) >= 1)
    .sort((a, b) => b.sim_avg - a.sim_avg), [simulated]);

  const isChanged = salesMultiplier !== 1.0 || deliveryDelay !== 0;
  const reset = () => { setSalesMultiplier(1.0); setDeliveryDelay(0); };

  // Gotowe scenariusze
  const presets = [
    { label: "Boom — sprzedaż +30%",   sales: 1.3, delay: 0  },
    { label: "Kryzys — sprzedaż -30%", sales: 0.7, delay: 0  },
    { label: "Opóźnienie +30 dni",     sales: 1.0, delay: 30 },
    { label: "Czarny scenariusz",      sales: 1.3, delay: 30 },
  ];

  return (
    <Portal>
      <div onClick={onClose} style={modalBackdrop}>
        <div onClick={(e) => e.stopPropagation()} className="fade-in"
          style={{ ...modalCard, maxWidth: 880 }}>

          {/* Header */}
          <div style={{
            padding: "14px 22px",
            background: "var(--bg-elevated)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            position: "relative",
          }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: "var(--anomaly)" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: "var(--anomaly-soft)", color: "var(--anomaly)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}><I.Flask size={16} /></div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-hi)" }}>Symulator scenariuszy</div>
                <div style={{ fontSize: 11, color: "var(--text-lo)" }}>
                  Co jeśli sprzedaż wzrośnie? Co jeśli dostawa się opóźni?
                </div>
              </div>
            </div>
            <button onClick={onClose} style={simIconBtnHeader}><I.Close size={14} /></button>
          </div>

          {/* Body */}
          <div style={{ overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>

            {loading ? (
              <SimEmptyState icon={<span className="pulse-soft"><I.Flask size={28} /></span>} title="Ładuję produkty…" sub="Przygotowuję dane do symulacji." />
            ) : (
            <>

            {/* Suwaki */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
              <SimSlider
                label="Mnożnik sprzedaży"
                icon={<I.TrendUp size={14} />}
                accent="var(--anomaly)"
                value={salesMultiplier}
                min={0.5} max={2.0} step={0.1}
                format={(v) => `${(v * 100).toFixed(0)}%`}
                ticks={["50% kryzys", "bez zmian", "200% boom"]}
                isDefault={salesMultiplier === 1.0}
                onChange={(v) => setSalesMultiplier(parseFloat(v.toFixed(1)))}
              />
              <SimSlider
                label="Opóźnienie dostaw"
                icon={<I.Calendar size={14} />}
                accent="var(--info)"
                value={deliveryDelay}
                min={0} max={60} step={5}
                format={(v) => `+${v} dni`}
                ticks={["na czas", "+30d", "+60d dramat"]}
                isDefault={deliveryDelay === 0}
                onChange={(v) => setDeliveryDelay(Math.round(v))}
              />
            </div>

            {/* Presety */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                Gotowe scenariusze:
              </span>
              {presets.map((p, i) => {
                const active = salesMultiplier === p.sales && deliveryDelay === p.delay;
                return (
                  <button key={i} onClick={() => { setSalesMultiplier(p.sales); setDeliveryDelay(p.delay); }} style={{
                    ...simBtnGhostMini,
                    background: active ? "var(--anomaly-soft)" : "transparent",
                    color: active ? "var(--anomaly)" : "var(--text-mid)",
                    borderColor: active ? "var(--anomaly)" : "var(--border-soft)",
                  }}>{p.label}</button>
                );
              })}
              {isChanged && (
                <button onClick={reset} style={{ ...simBtnGhostMini, color: "var(--text-mid)" }}>
                  <I.Refresh size={10} /> Reset
                </button>
              )}
            </div>

            {/* Porównanie */}
            <SimSection title="Porównanie: bazowy vs symulowany" hint={`${totalProducts} aktywnych produktów`}>
              <ComparisonBars statsBefore={statsBefore} statsAfter={statsAfter} total={totalProducts} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginTop: 12 }}>
                {SIM_STATUSES.map((s) => {
                  const before = statsBefore[s.key] || 0;
                  const after = statsAfter[s.key] || 0;
                  const diff = after - before;
                  const diffBad = s.bad ? diff > 0 : diff < 0;
                  return (
                    <div key={s.key} style={{
                      padding: "10px 12px",
                      background: "var(--surface-1)",
                      border: `1px solid ${diff !== 0 ? s.color : "var(--border-soft)"}`,
                      borderRadius: 8,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: s.color, flexShrink: 0 }} />
                        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{s.label}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 6 }}>
                        <span className="num" style={{ fontSize: 22, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-0.02em" }}>{after}</span>
                        {diff !== 0 && (
                          <>
                            <span className="num" style={{ fontSize: 11, color: "var(--text-lo)", textDecoration: "line-through" }}>{before}</span>
                            <span className="num" style={{
                              fontSize: 12, fontWeight: 700,
                              color: isChanged && diffBad ? "var(--critical)" : isChanged ? "var(--ok)" : "var(--text-lo)",
                            }}>{diff > 0 ? "+" : ""}{diff}</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SimSection>

            {/* Nowo problematyczne albo stan sukcesu */}
            {!isChanged ? (
              <SimEmptyState
                icon={<I.Flask size={28} />}
                title="Przesuń suwaki lub wybierz scenariusz"
                sub="Symulacja przelicza się w czasie rzeczywistym."
              />
            ) : newCritical.length === 0 ? (
              <SimEmptyState
                icon={<I.Activity size={28} />}
                title="Magazyn wytrzymuje ten scenariusz"
                sub="Żaden produkt nie pogarsza statusu."
                variant="ok"
              />
            ) : (
              <SimSection
                title="Produkty które staną się problematyczne"
                hint={`${newCritical.length} pozycji`}
              >
                <div style={{
                  background: "var(--surface-1)",
                  border: "1px solid var(--border-soft)",
                  borderRadius: 8,
                  maxHeight: 320, overflowY: "auto",
                }}>
                  {newCritical.map((p, i) => (
                    <ProblemRow key={p.sku} p={p} isLast={i === newCritical.length - 1}
                      onClick={() => onProductClick?.(p.sku)} />
                  ))}
                </div>
              </SimSection>
            )}

            </>
            )}

          </div>

          {/* Footer */}
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
            padding: "12px 22px",
            borderTop: "1px solid var(--border-soft)",
            background: "var(--bg-elevated)",
          }}>
            <span style={{ fontSize: 11, color: "var(--text-lo)" }}>
              Symulacja oparta na średniej sprzedaży i obecnym stanie. Wynik orientacyjny.
            </span>
            <button onClick={onClose} style={btnSecondary}>Zamknij</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

// ── Suwak ────────────────────────────────────────────────────
function SimSlider({ label, icon, accent, value, min, max, step, format, ticks, isDefault, onChange }: {
  label: string;
  icon: React.ReactNode;
  accent: string;
  value: number;
  min: number; max: number; step: number;
  format: (v: number) => string;
  ticks: string[];
  isDefault: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{
      padding: 14,
      background: "var(--surface-1)",
      border: `1px solid ${isDefault ? "var(--border-soft)" : "color-mix(in oklch, " + accent + " 30%, var(--border))"}`,
      borderRadius: 10,
      transition: "border-color 0.16s",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: accent }}>{icon}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {label}
          </span>
        </div>
        <span className="num" style={{ fontSize: 24, fontWeight: 700, color: isDefault ? "var(--text-mid)" : accent, letterSpacing: "-0.02em" }}>
          {format(value)}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: accent }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--text-lo)", marginTop: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {ticks.map((t, i) => (<span key={i}>{t}</span>))}
      </div>
    </div>
  );
}

// ── Paski porównania (bazowy / po zmianie) ───────────────────
function ComparisonBars({ statsBefore, statsAfter, total }: {
  statsBefore: StatCounts; statsAfter: StatCounts; total: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <BarRow label="BAZOWY" stats={statsBefore} total={total} />
      <BarRow label="PO ZMIANIE" stats={statsAfter} total={total} highlight />
    </div>
  );
}

function BarRow({ label, stats, total, highlight }: {
  label: string; stats: StatCounts; total: number; highlight?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{
        width: 88, flexShrink: 0,
        fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
        color: highlight ? "var(--text-hi)" : "var(--text-lo)",
      }}>{label}</span>
      <div style={{ flex: 1, display: "flex", height: 22, background: "var(--surface-2)", borderRadius: 6, overflow: "hidden" }}>
        {SIM_STATUSES.map((s) => {
          const count = stats[s.key] || 0;
          if (count === 0 || total === 0) return null;
          const pct = (count / total) * 100;
          return (
            <div key={s.key}
              title={`${s.label}: ${count}`}
              style={{
                width: `${pct}%`,
                background: s.color,
                opacity: highlight ? 1 : 0.55,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700, color: "white",
                transition: "width 0.3s",
              }}>
              {pct > 6 && count}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Wiersz problematycznego produktu ─────────────────────────
function ProblemRow({ p, isLast, onClick }: { p: SimRow; isLast: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      display: "grid",
      gridTemplateColumns: "auto 90px minmax(0, 1fr) auto auto",
      gap: 10, alignItems: "center",
      padding: "10px 12px",
      borderBottom: isLast ? "none" : "1px solid var(--border-soft)",
      cursor: "pointer",
      transition: "background 0.1s",
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <span className="mono" style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        fontSize: 10, color: "var(--text-lo)", opacity: 0.8,
      }}>
        <span style={{ textDecoration: "line-through" }}>{STATUS_META[p.status]?.label || p.status}</span>
        <I.ArrowRight size={9} />
      </span>
      <StatusPill status={p.sim_status} size="sm" />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>{p.sku}</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div className="num" style={{ fontSize: 11, color: "var(--text-mid)" }}>{p.sim_avg.toFixed(1)}/mies</div>
        <div className="num" style={{ fontSize: 10, color: "var(--text-lo)" }}>stan {p.stock}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, minWidth: 90 }}>
        <div className="num" style={{ fontSize: 11, fontWeight: 600, color: "var(--critical)" }}>
          koniec za {p.sim_days_until_empty}d
        </div>
        <div className="num" style={{ fontSize: 10, color: "var(--text-lo)", textDecoration: "line-through" }}>
          {p.days_until_empty < 365 ? `bazowo ${p.days_until_empty}d` : "bazowo ∞"}
        </div>
      </div>
    </div>
  );
}

// ── Sekcja (nagłówek + hint) ─────────────────────────────────
function SimSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{title}</div>
        {hint && <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Stan pusty / sukcesu ─────────────────────────────────────
function SimEmptyState({ icon, title, sub, variant }: {
  icon: React.ReactNode; title: string; sub?: string; variant?: "ok";
}) {
  const color = variant === "ok" ? "var(--ok)" : "var(--text-mid)";
  const bg = variant === "ok" ? "var(--ok-soft)" : "var(--surface-1)";
  const border = variant === "ok" ? "color-mix(in oklch, var(--ok) 40%, var(--border))" : "var(--border-soft)";
  return (
    <div style={{
      padding: "28px 20px", textAlign: "center",
      background: bg,
      border: `1px solid ${border}`,
      borderRadius: 10,
    }}>
      <div style={{ color, marginBottom: 10, display: "flex", justifyContent: "center" }}>{icon}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-hi)" }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text-mid)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── Lokalne style (parytet z mockiem) ────────────────────────
const simIconBtnHeader: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border-soft)",
  color: "var(--text-mid)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
};
const simBtnGhostMini: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px",
  background: "transparent", border: "1px solid var(--border-soft)", color: "var(--text-mid)",
  borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: "pointer", transition: "all 0.12s",
};
