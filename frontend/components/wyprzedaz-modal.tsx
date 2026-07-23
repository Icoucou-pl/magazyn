"use client";
// ============================================================
// MAGAZYN — Modal „Wyprzedaż / promo" (wyprzedaz-modal.tsx).
//   Lista SKU, które zalegają: dużo stanu względem rotacji.
//   Kryterium = pokrycie (months-of-cover) ponad próg, domyślnie 6 mies.
//   — ta sama granica, co kubełek WYPRZEDAZ w forecast.tsx („> 6 mies.").
//
//   Liczone KLIENTOWO z /products (jak projekcja w forecast.tsx) — bez
//   dodatkowego endpointu. Pola wejściowe pochodzą z ProductSummary:
//     · pokrycie  = stock / avg_monthly_weighted   (0 sprzedaży ⇒ ∞)
//     · kapitał   = stock_value = stock × purchase_price,
//                   gdzie purchase_price to już COALESCE(cena_zakupu_manual,
//                   subiekt.cena_zakupu_netto, 0) — liczy to SQL (sql.py).
//   Zakres (producent + filtr statusu) przychodzi z miejsca otwarcia, więc
//   liczba w modalu zgadza się z KPI, z którego kliknięto.
// ============================================================

import React, { useMemo, useState } from "react";
import { fmtPLNk, fmtNum } from "@/lib/format";
import { I } from "./ui";
import { exportCsv, type CsvColumn } from "./toast";
import { modalBackdrop, modalCard, iconBtnGhost, Portal, type Product } from "./products-ui";

// Domyślny próg = granica kubełka WYPRZEDAZ w prognozie („> 6 mies.").
export const WYPRZEDAZ_PROG_DEFAULT = 6;
// Brak sprzedaży przy dodatnim stanie: pokrycie nieskończone (jak classifyCover).
const COVER_INF = 999;
// 100% długości paska — powyżej i tak jest „poza skalą".
const COVER_CAP = 120;

export type WyprzedazRow = {
  p: Product;
  cover: number;      // miesiące zapasu
  capital: number;    // zamrożony kapitał (PLN)
  dying: boolean;     // zero sprzedaży w 60 dni
  incoming: number;   // sztuki w drodze
  priority: number;   // cover × capital
};

/** Pokrycie w miesiącach. Zero sprzedaży + dodatni stan ⇒ COVER_INF. */
export function coverMonths(p: Product): number {
  const monthly = p.avg_monthly_weighted || 0;
  if (monthly <= 0) return p.stock > 0 ? COVER_INF : 0;
  return p.stock / monthly;
}

/**
 * Wybiera SKU do wyprzedaży z już przefiltrowanej listy produktów.
 * Filtrowanie po producencie/statusie robi WOŁAJĄCY — dzięki temu liczba
 * tutaj jest identyczna z liczbą na kafelku KPI.
 */
export function selectWyprzedaz(products: Product[], prog: number): WyprzedazRow[] {
  const out: WyprzedazRow[] = [];
  for (const p of products) {
    if (p.stock <= 0) continue;               // nie ma czego wyprzedawać
    const cover = coverMonths(p);
    if (cover < prog) continue;
    const capital = p.stock_value || p.stock * (p.purchase_price || 0);
    out.push({
      p, cover, capital,
      dying: p.sales_1m === 0 && p.sales_2m === 0,
      incoming: p.stock_in_transit || 0,
      priority: Math.min(cover, COVER_INF) * capital,
    });
  }
  return out;
}

/** Nasilenie = odcienie NIEBIESKIEGO (--info). Zielony w tej apce = stan idealny. */
function coverColor(cover: number): string {
  if (cover >= 40) return "color-mix(in oklch, var(--info) 100%, black 22%)";
  if (cover >= 18) return "var(--info)";
  return "color-mix(in oklch, var(--info) 62%, var(--surface-3))";
}

const chipBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px",
  fontSize: 11, fontWeight: 600, borderRadius: 99, cursor: "pointer",
  color: "var(--accent)", background: "var(--accent-soft)",
  border: "1px solid color-mix(in oklch, var(--accent) 30%, transparent)",
};
const sortBtn = (active: boolean): React.CSSProperties => ({
  padding: "4px 11px", fontSize: 11, fontWeight: 600, borderRadius: 99, cursor: "pointer",
  border: "1px solid " + (active ? "var(--text-hi)" : "var(--border-soft)"),
  background: active ? "var(--text-hi)" : "var(--surface-2)",
  color: active ? "var(--bg)" : "var(--text-mid)",
});
const flagTag = (color: string): React.CSSProperties => ({
  fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 5, whiteSpace: "nowrap",
  color, background: `color-mix(in oklch, ${color} 14%, transparent)`,
  border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
});

export default function WyprzedazModal({
  products, scopeLabels, onClearScope, onClose, onProductClick, loading,
}: {
  /** Produkty JUŻ zawężone do zakresu (producent + status) z miejsca otwarcia. */
  products: Product[];
  /** Etykiety zakresu pokazywane jako chipy w nagłówku. */
  scopeLabels?: { key: string; label: string }[];
  /** Klik w ✕ na chipie — rozszerza zakres (opcjonalne). */
  onClearScope?: (key: string) => void;
  onClose: () => void;
  onProductClick?: (sku: string) => void;
  loading?: boolean;
}) {
  const [prog, setProg] = useState(WYPRZEDAZ_PROG_DEFAULT);
  const [sort, setSort] = useState<"priority" | "cover" | "capital">("priority");

  const rows = useMemo(() => {
    const arr = selectWyprzedaz(products, prog);
    arr.sort((a, b) => b[sort] - a[sort]);
    return arr;
  }, [products, prog, sort]);

  const totalCapital = rows.reduce((s, r) => s + r.capital, 0);
  const totalUnits = rows.reduce((s, r) => s + r.p.stock, 0);

  const onExport = () => {
    const cols: CsvColumn<WyprzedazRow>[] = [
      { key: "sku", label: "SKU", get: (r) => r.p.sku },
      { key: "name", label: "Nazwa", get: (r) => r.p.name_override_manual || r.p.name },
      { key: "mfr", label: "Producent", get: (r) => r.p.manufacturer_name || "" },
      { key: "stock", label: "Stan", get: (r) => r.p.stock },
      { key: "cover", label: "Pokrycie (mies.)", get: (r) => (r.cover >= COVER_INF ? "" : r.cover.toFixed(1)) },
      { key: "monthly", label: "Sprzedaz/mies.", get: (r) => r.p.avg_monthly_weighted },
      { key: "sales30", label: "Sprzedaz 30d", get: (r) => r.p.sales_1m },
      { key: "capital", label: "Zamrozony kapital PLN", get: (r) => Math.round(r.capital) },
      { key: "incoming", label: "W drodze", get: (r) => r.incoming },
      { key: "dying", label: "Umiera", get: (r) => (r.dying ? "TAK" : "") },
    ];
    exportCsv("wyprzedaz", cols, rows);
  };

  return (
    <Portal>
      <div style={modalBackdrop} onClick={onClose}>
        <div style={{ ...modalCard, maxWidth: 860 }} onClick={(e) => e.stopPropagation()}>

          {/* Nagłówek */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, padding: "14px 18px", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, minWidth: 0 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: "var(--info-soft)", color: "var(--info)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <I.TrendDown size={18} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-hi)" }}>Wyprzedaż / promo</div>
                <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>
                  Pokrycie ponad {prog} mies. — zalegają i zamrażają kapitał
                </div>
                {!!scopeLabels?.length && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {scopeLabels.map((s) => (
                      <span key={s.key} style={{ ...chipBtn, cursor: onClearScope ? "pointer" : "default" }}
                        onClick={() => onClearScope?.(s.key)}
                        title={onClearScope ? "Rozszerz zakres" : undefined}>
                        {s.label}{onClearScope && <I.Close size={10} />}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <button onClick={onClose} style={{ ...iconBtnGhost, cursor: "pointer", flexShrink: 0 }} aria-label="Zamknij">
              <I.Close size={16} />
            </button>
          </div>

          {/* Próg pokrycia */}
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 340, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-lo)", marginBottom: 6 }}>
              <span>Próg pokrycia</span>
              <span className="num" style={{ color: "var(--text-mid)" }}>{prog} mies.</span>
            </div>
            <input type="range" min={3} max={36} step={1} value={prog}
              onChange={(e) => setProg(parseInt(e.target.value))}
              style={{ width: "100%", maxWidth: 340, display: "block", accentColor: "var(--info)", cursor: "pointer" }} />
          </div>

          {/* Podsumowanie */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", borderBottom: "1px solid var(--border-soft)", background: "var(--surface-1)" }}>
            <SumCell label="Zamrożony kapitał" value={fmtPLNk(totalCapital)} color="var(--info)" />
            <SumCell label="Produktów" value={fmtNum(rows.length)} divider />
            <SumCell label="Sztuk łącznie" value={fmtNum(totalUnits)} divider />
          </div>

          {/* Sortowanie */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 18px", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-lo)" }}>Sortuj:</span>
            <button onClick={() => setSort("priority")} style={sortBtn(sort === "priority")}>Priorytet</button>
            <button onClick={() => setSort("cover")} style={sortBtn(sort === "cover")}>Pokrycie</button>
            <button onClick={() => setSort("capital")} style={sortBtn(sort === "capital")}>Kapitał</button>
          </div>

          {/* Lista */}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 10px", minHeight: 120 }}>
            {loading ? (
              <div style={{ padding: "48px 16px", textAlign: "center", fontSize: 12, color: "var(--text-lo)" }}>Wczytuję produkty…</div>
            ) : rows.length === 0 ? (
              <div style={{ padding: "48px 16px", textAlign: "center", fontSize: 12, color: "var(--text-lo)" }}>
                W tym zakresie nic nie zalega przy progu {prog} mies.
              </div>
            ) : rows.map((r, i) => {
              const c = coverColor(r.cover);
              const pct = Math.min(100, (Math.min(r.cover, COVER_INF) / COVER_CAP) * 100);
              const clickable = !!onProductClick;
              return (
                <div key={r.p.sku}
                  onClick={() => onProductClick?.(r.p.sku)}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "11px 8px",
                    borderTop: i ? "1px solid var(--border-soft)" : "none",
                    cursor: clickable ? "pointer" : "default", borderRadius: 8,
                  }}
                  onMouseEnter={(e) => { if (clickable) e.currentTarget.style.background = "var(--surface-1)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>

                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-hi)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {r.p.name_override_manual || r.p.name || r.p.sku}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 3 }}>
                      <span className="num" style={{ fontSize: 10.5, color: "var(--text-lo)" }}>{r.p.sku}</span>
                      {r.p.manufacturer_name && (
                        <span style={flagTag(r.p.manufacturer_color || "var(--text-mid)")}>{r.p.manufacturer_name}</span>
                      )}
                      {r.p.is_favorite && <span style={flagTag("var(--accent)")}>★ obs.</span>}
                      {r.dying && <span style={flagTag("var(--critical)")}>umiera</span>}
                      {r.incoming > 0 && <span style={flagTag("var(--warning)")}>+{fmtNum(r.incoming)} w drodze</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
                      <div style={{ height: 5, flex: 1, background: "var(--surface-2)", borderRadius: 99, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: pct + "%", background: c, borderRadius: 99 }} />
                      </div>
                      <span className="num" style={{ width: 84, textAlign: "right", fontSize: 11, fontWeight: 700, color: c, flexShrink: 0 }}>
                        {r.cover >= COVER_INF ? "brak sprz." : r.cover >= 100 ? "100+ mies." : r.cover.toFixed(1).replace(".", ",") + " mies."}
                      </span>
                    </div>
                  </div>

                  <div style={{ textAlign: "right", flexShrink: 0, minWidth: 108 }}>
                    <div className="num" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-hi)" }}>{fmtPLNk(r.capital)}</div>
                    <div className="num" style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 2 }}>
                      stan {fmtNum(r.p.stock)} · {fmtNum(r.p.avg_monthly_weighted)}/mc
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Stopka */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 18px", borderTop: "1px solid var(--border-soft)", background: "var(--surface-1)" }}>
            <span style={{ fontSize: 11.5, color: "var(--text-mid)" }}>
              Wyprzedaż tych <b style={{ color: "var(--text-hi)" }}>{rows.length}</b> produktów uwolni{" "}
              <b style={{ color: "var(--info)" }}>{fmtPLNk(totalCapital)}</b>.
            </span>
            <button onClick={onExport} disabled={rows.length === 0} style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", fontSize: 11.5, fontWeight: 600,
              background: "var(--surface-2)", border: "1px solid var(--border-soft)", color: "var(--text-mid)",
              borderRadius: 7, cursor: rows.length === 0 ? "default" : "pointer", opacity: rows.length === 0 ? 0.5 : 1,
            }}>
              <I.ArrowUp size={12} /> Eksport CSV
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function SumCell({ label, value, color, divider }: { label: string; value: string; color?: string; divider?: boolean }) {
  return (
    <div style={{ padding: "11px 16px", borderLeft: divider ? "1px solid var(--border-soft)" : "none" }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div className="num" style={{ fontSize: 16, fontWeight: 600, marginTop: 3, color: color || "var(--text-hi)" }}>{value}</div>
    </div>
  );
}
