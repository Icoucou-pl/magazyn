"use client";
/**
 * Dwa raporty ekonomiczne per SKU, oba na jednym endpointcie backendu:
 *
 *  [Koszt magazynowania] — udział produktu w POJEMNOŚCI hali. Stawka = czynsz /
 *                          capacity_m3; SKU zajmujące 10 m³ w hali o 100 m³ płaci
 *                          10% czynszu, niezależnie od tego, co stoi obok.
 *                          Suma kosztów w tabeli NIE równa się fakturze — reszta
 *                          to niewykorzystana hala, pokazana w kafelku „Puste".
 *
 *  [SKU do wykluczenia]  — wynik = marża (przychód − koszt zakupu) minus koszt
 *                          miejsca. Poniżej progu produkt trafia pod rozwagę.
 *
 * Liczby są w skali ROKU: koszt miejsca z dzisiejszej zajętości × 12, marża YTD
 * zannualizowana. Inaczej porównywalibyśmy marżę za pół roku z czynszem za cały.
 *
 * SKU bez kubatury dostaje koszt „—", nie zero — zero zrobiłoby z niego
 * najbardziej rentowną pozycję w zestawieniu. Takie wiersze mają werdykt
 * „brak danych" i osobny licznik w nagłówku.
 *
 * Widoki bramkuje `viewReports` + `viewFinancials` (patrz routers/sku_economics.py).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import { fmtPLN, fmtNum } from "@/lib/format";
import { I, Card, Pill } from "@/components/ui";
import { toast } from "@/components/toast";

// ── typy ─────────────────────────────────────────────────────
type EconRow = {
  sku: string; nazwa: string; firma_slug: string; no_cbm: boolean;
  stock_qty: number; cbm_per_unit: number | null; stock_m3: number | null; share_pct: number | null;
  qty_sold: number; revenue_pln: number; unit_cost_pln: number; cogs_pln: number;
  gross_margin_pln: number; gross_margin_pct: number | null; profit_base_pln: number;
  warehouse_cost_unit_monthly_pln: number | null;
  warehouse_cost_monthly_pln: number | null; warehouse_cost_pln: number | null;
  warehouse_cost_share_pct: number | null; result_pln: number | null; cost_included: boolean;
  stock_value_pln: number; months_of_stock: number | null;
  first_sale: string | null; last_sale: string | null;
  history_months: number | null; stockout_pct: number | null;
  verdict: string; reason: string;
};
type FirmSummary = {
  firma_slug: string; label: string; monthly_cost_pln: number; capacity_m3: number;
  occupied_m3: number; empty_m3: number; empty_cost_pln: number | null;
  rate_pln_per_m3: number; cost_configured: boolean; capacity_configured: boolean;
};
type EconData = {
  mode: string;
  period: { year: number; from: string; to: string; months_elapsed: number };
  estimated: boolean;
  config: { profit_threshold_pln: number; min_history_months: number; stockout_tolerance_pct: number; excluded_skus: string[] };
  summary: FirmSummary[];
  rows: EconRow[];
  meta: { no_cbm_count: number; no_cbm_units: number; excluded_skus: string[]; missing_cost_firms: string[]; missing_capacity_firms: string[]; watched_only: boolean; hidden_count: number };
};
type CostCfg = { firma_slug: string; label: string; monthly_cost_pln: number; note: string | null };

// ── formatowanie ─────────────────────────────────────────────
const m3 = (n: number | null) => (n == null ? "—" : (n || 0).toFixed(2).replace(".", ",") + " m³");
const pc = (n: number | null, d = 1) => (n == null ? "—" : (n || 0).toFixed(d).replace(".", ",") + "%");
const pln = (n: number | null) => (n == null ? "—" : fmtPLN(n));
// Koszt jednej sztuki bywa groszowy — zaokrąglenie do złotówki zrobiłoby z 0,28 zł
// i 0,94 zł to samo „1 zł", przez co kolumna nic by nie mówiła.
const pln2 = (n: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + " zł";

const VERDICT: Record<string, { label: string; tone: string }> = {
  exclude: { label: "Do wykluczenia", tone: "critical" },
  watch: { label: "Obserwuj", tone: "warning" },
  keep: { label: "Zarabia", tone: "ok" },
  stockout: { label: "Brak towaru", tone: "info" },
  new: { label: "Za wcześnie", tone: "pending" },
  unknown: { label: "Brak danych", tone: "info" },
};

const labStyle: React.CSSProperties = { fontSize: 10, fontWeight: 650, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--text-lo)" };
const inputStyle: React.CSSProperties = {
  background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8,
  padding: "7px 9px", fontSize: 13, color: "var(--text-hi)", fontFamily: "inherit", width: 130,
};
const btnDark: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, background: "var(--text-hi)", color: "var(--surface-1)",
  border: "none", padding: "9px 15px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, background: "var(--surface-1)", color: "var(--text-mid)",
  border: "1px solid var(--border)", padding: "7px 12px", borderRadius: 9, fontSize: 12.5, fontWeight: 550, cursor: "pointer",
};
type SortState = { key: keyof EconRow; dir: "asc" | "desc" };

/** Sortowanie po kolumnie. Nulle zawsze na końcu — niezależnie od kierunku,
 *  bo „brak danych" to nie jest wartość najmniejsza ani największa. */
function sortRows(rows: EconRow[], sort: SortState | null): EconRow[] {
  if (!sort) return rows;
  const mul = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = a[sort.key] as unknown;
    const vb = b[sort.key] as unknown;
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
    return String(va).localeCompare(String(vb), "pl") * mul;
  });
}

const th: React.CSSProperties = { textAlign: "left", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-lo)", fontWeight: 650, padding: "0 10px 8px", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap" };
const thR: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "9px 10px", borderBottom: "1px solid var(--surface-3)", fontSize: 12.5, whiteSpace: "nowrap" };
const tdR: React.CSSProperties = { ...td, textAlign: "right" };

/** Nagłówek klikalny. Klik przełącza kierunek; liczby startują malejąco,
 *  tekst rosnąco. Kliknięcie obok nagłówka nic nie robi — cursor jest tylko tutaj. */
function SortTh({ label, k, sort, setSort, numeric }: {
  label: string; k: keyof EconRow; sort: SortState | null;
  setSort: (s: SortState) => void; numeric?: boolean;
}) {
  const active = sort?.key === k;
  const toggle = () => setSort(
    active ? { key: k, dir: sort!.dir === "asc" ? "desc" : "asc" } : { key: k, dir: numeric ? "desc" : "asc" }
  );
  return (
    <th style={{ ...(numeric ? thR : th), padding: 0 }}>
      <button
        onClick={toggle}
        style={{
          border: "none", background: "none", cursor: "pointer", font: "inherit",
          color: active ? "var(--text-hi)" : "var(--text-lo)",
          fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 650,
          padding: "0 10px 8px", width: "100%", textAlign: numeric ? "right" : "left",
          display: "inline-flex", justifyContent: numeric ? "flex-end" : "flex-start",
          alignItems: "center", gap: 4, whiteSpace: "nowrap",
        }}
      >
        {label}
        <span style={{ opacity: active ? 1 : 0.25, fontSize: 9 }}>{active && sort!.dir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

// ── wspólne pobranie danych ──────────────────────────────────
function useEconomics(endpoint: string, scope: string, watched: boolean) {
  const [data, setData] = useState<EconData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get(`${endpoint}?scope=${encodeURIComponent(scope)}&mode=runrate&watched=${watched}`)
      .then((d: EconData) => setData(d))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "Nie udało się wczytać raportu", "error"))
      .finally(() => setLoading(false));
  }, [endpoint, scope, watched]);

  useEffect(() => { load(); }, [load]);
  return { data, loading, reload: load };
}

// ── panel konfiguracji: czynsz per firma + progi ─────────────
function ConfigPanel({ onSaved, showThreshold }: { onSaved: () => void; showThreshold: boolean }) {
  const [open, setOpen] = useState(false);
  const [costs, setCosts] = useState<CostCfg[]>([]);
  const [threshold, setThreshold] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get("/reports/economics/config")
      .then((d: { costs: CostCfg[]; profit_threshold_pln: number }) => {
        setCosts(d.costs || []);
        setThreshold(String(d.profit_threshold_pln ?? ""));
      })
      .catch(() => toast("Nie udało się wczytać ustawień", "error"));
  }, [open]);

  const save = () => {
    setSaving(true);
    const body: Record<string, unknown> = {
      costs: costs.map((c) => ({ firma_slug: c.firma_slug, monthly_cost_pln: Number(c.monthly_cost_pln) || 0, note: c.note })),
    };
    if (showThreshold && threshold !== "") body.profit_threshold_pln = Number(threshold) || 0;
    api.put("/reports/economics/config", body)
      .then(() => { toast("Zapisano", "ok"); setOpen(false); onSaved(); })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "Nie udało się zapisać", "error"))
      .finally(() => setSaving(false));
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={btnGhost}>
        <I.Settings size={14} />Ustawienia
      </button>
    );
  }

  return (
    <Card style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16, width: "100%" }}>
      <div style={{ fontSize: 14, fontWeight: 650 }}>Koszt magazynu miesięcznie</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {costs.map((c, i) => (
          <div key={c.firma_slug} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labStyle}>{c.label}</span>
            <input
              type="number" min={0} step={100} value={c.monthly_cost_pln}
              onChange={(e) => setCosts((prev) => prev.map((p, j) => (j === i ? { ...p, monthly_cost_pln: Number(e.target.value) } : p)))}
              style={inputStyle}
            />
          </div>
        ))}
        {showThreshold && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labStyle}>Próg rentowności / rok</span>
            <input type="number" min={0} step={1000} value={threshold} onChange={(e) => setThreshold(e.target.value)} style={inputStyle} />
          </div>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-lo)", lineHeight: 1.6 }}>
        Kwota netto za całą halę. Każdy produkt płaci za swój udział w pojemności magazynu:
        10 m³ ze 100 m³ to 10% czynszu. Niewykorzystana część hali nie obciąża produktów —
        widać ją osobno jako „Puste".
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={save} disabled={saving} style={{ ...btnDark, opacity: saving ? 0.6 : 1 }}>
          {saving ? "Zapisywanie…" : "Zapisz"}
        </button>
        <button onClick={() => setOpen(false)} style={btnGhost}>Anuluj</button>
      </div>
    </Card>
  );
}

/** Zakres tabeli: domyślnie tylko obserwowane i SAMPLE, opcjonalnie cały asortyment. */
function ScopeToggle({ watched, setWatched, hidden }: { watched: boolean; setWatched: (v: boolean) => void; hidden: number }) {
  return (
    <div style={{ display: "inline-flex", background: "var(--surface-3)", borderRadius: 9, padding: 3 }}>
      <button
        onClick={() => setWatched(true)}
        style={{
          border: "none", background: watched ? "var(--surface-1)" : "transparent",
          boxShadow: watched ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
          color: watched ? "var(--text-hi)" : "var(--text-mid)",
          padding: "6px 12px", borderRadius: 6, fontSize: 12.5, fontWeight: 550, cursor: "pointer",
        }}
      >
        Obserwowane i SAMPLE
      </button>
      <button
        onClick={() => setWatched(false)}
        style={{
          border: "none", background: !watched ? "var(--surface-1)" : "transparent",
          boxShadow: !watched ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
          color: !watched ? "var(--text-hi)" : "var(--text-mid)",
          padding: "6px 12px", borderRadius: 6, fontSize: 12.5, fontWeight: 550, cursor: "pointer",
        }}
        title={hidden > 0 ? `${hidden} pozycji poza obserwowanymi` : undefined}
      >
        Wszystkie{hidden > 0 && watched ? ` (+${hidden})` : ""}
      </button>
    </div>
  );
}

// ── banery ostrzegawcze ──────────────────────────────────────
function Notices({ data }: { data: EconData }) {
  const missing = data.meta.missing_cost_firms || [];
  return (
    <>
      {missing.length > 0 && (
        <Card style={{ padding: "14px 18px", borderLeft: "3px solid var(--warning)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Brak kwoty czynszu</div>
          <div style={{ fontSize: 12.5, color: "var(--text-lo)", lineHeight: 1.6 }}>
            Nie ustawiono kosztu magazynu dla: {missing.join(", ").toUpperCase()}. Do czasu uzupełnienia
            koszt miejsca dla tych firm wychodzi zero, a wynik produktów jest zawyżony. Wpisz kwotę w Ustawieniach.
          </div>
        </Card>
      )}
      {(data.meta.missing_capacity_firms || []).length > 0 && (
        <Card style={{ padding: "14px 18px", borderLeft: "3px solid var(--warning)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Brak pojemności hali</div>
          <div style={{ fontSize: 12.5, color: "var(--text-lo)", lineHeight: 1.6 }}>
            Nie ustawiono pojemności dla: {data.meta.missing_capacity_firms.join(", ").toUpperCase()}.
            Bez niej nie ma od czego liczyć udziału produktu, więc koszt miejsca wychodzi zero.
            Pojemność ustawia się w raporcie Zajętość magazynu.
          </div>
        </Card>
      )}
      {data.meta.no_cbm_count > 0 && (
        <Card style={{ padding: "14px 18px", borderLeft: "3px solid var(--info)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            {data.meta.no_cbm_count} SKU bez kubatury ({fmtNum(data.meta.no_cbm_units)} szt.)
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-lo)", lineHeight: 1.6 }}>
            Te pozycje nie mają wypełnionego CBM, więc nie da się policzyć kosztu ich miejsca — pokazują „—",
            nie zero. Zostają w tabeli, żebyś wiedział, co uzupełnić w module Produkty.
            {(data.meta.excluded_skus || []).length > 0 && ` Pozycje techniczne pominięte całkowicie: ${data.meta.excluded_skus.join(", ")}.`}
          </div>
        </Card>
      )}
    </>
  );
}

// ── kafelki per firma ────────────────────────────────────────
function FirmTiles({ summary }: { summary: FirmSummary[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
      {summary.map((f) => (
        <Card key={f.firma_slug} style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 650 }}>{f.label}</span>
            <span className="num" style={{ fontSize: 13, fontWeight: 600 }}>{pln(f.monthly_cost_pln)}/mies.</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-lo)" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Zajęte / pojemność</span>
              <span className="num">{m3(f.occupied_m3)} / {m3(f.capacity_m3)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Stawka</span><span className="num">{pln(f.rate_pln_per_m3)} / m³ / mies.</span>
            </div>
            {f.capacity_m3 > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Puste ({m3(f.empty_m3)})</span>
                <span className="num" style={{ color: "var(--warning)" }}>{pln(f.empty_cost_pln)}/mies.</span>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ══ RAPORT 1: koszt magazynowania ════════════════════════════
export function WarehouseCostReport({ scope }: { scope: string }) {
  const [watched, setWatched] = useState(true);
  const { data, loading, reload } = useEconomics("/reports/warehouse-cost", scope, watched);
  const [onlyNoCbm, setOnlyNoCbm] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);

  const rows = useMemo(() => {
    if (!data) return [];
    const base = onlyNoCbm ? data.rows.filter((r) => r.no_cbm) : data.rows.filter((r) => r.stock_qty > 0);
    return sortRows(base, sort);
  }, [data, onlyNoCbm, sort]);

  if (loading) return <Card style={{ padding: 40, textAlign: "center", color: "var(--text-lo)" }}>Liczenie…</Card>;
  if (!data) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 650, margin: 0 }}>Koszt magazynowania</h2>
          <p style={{ margin: "4px 0 0", color: "var(--text-lo)", fontSize: 12.5 }}>
            Czynsz rozłożony po zajmowanej objętości. Stan na dziś, koszt w skali roku.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <ScopeToggle watched={watched} setWatched={setWatched} hidden={data?.meta.hidden_count || 0} />
          <button onClick={() => setOnlyNoCbm((v) => !v)} style={{ ...btnGhost, ...(onlyNoCbm ? { borderColor: "var(--info)", color: "var(--info)" } : {}) }}>
            Tylko bez kubatury
          </button>
          <ConfigPanel onSaved={reload} showThreshold={false} />
        </div>
      </div>

      <Notices data={data} />
      <FirmTiles summary={data.summary} />

      <Card style={{ padding: "18px 4px 6px" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortTh label="SKU" k="sku" sort={sort} setSort={setSort} />
                <SortTh label="Nazwa" k="nazwa" sort={sort} setSort={setSort} />
                <SortTh label="Stan" k="stock_qty" sort={sort} setSort={setSort} numeric />
                <SortTh label="CBM/szt." k="cbm_per_unit" sort={sort} setSort={setSort} numeric />
                <SortTh label="Zajmuje" k="stock_m3" sort={sort} setSort={setSort} numeric />
                <SortTh label="Udział hali" k="share_pct" sort={sort} setSort={setSort} numeric />
                <SortTh label="Koszt szt./mies." k="warehouse_cost_unit_monthly_pln" sort={sort} setSort={setSort} numeric />
                <SortTh label="Koszt / mies." k="warehouse_cost_monthly_pln" sort={sort} setSort={setSort} numeric />
                <SortTh label="Koszt / rok" k="warehouse_cost_pln" sort={sort} setSort={setSort} numeric />
                <SortTh label="% marży" k="warehouse_cost_share_pct" sort={sort} setSort={setSort} numeric />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.sku}-${r.firma_slug}`}>
                  <td style={{ ...td, fontFamily: "var(--font-mono, monospace)", fontWeight: 600 }}>
                    {r.sku}
                    {r.no_cbm && <span style={{ marginLeft: 7 }}><Pill bg="var(--info-soft)" fg="var(--info)" size="sm">brak CBM</Pill></span>}
                  </td>
                  <td style={{ ...td, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>{r.nazwa}</td>
                  <td style={tdR} className="num">{fmtNum(r.stock_qty)}</td>
                  <td style={tdR} className="num">{r.cbm_per_unit == null ? "—" : r.cbm_per_unit.toFixed(3).replace(".", ",")}</td>
                  <td style={tdR} className="num">{m3(r.stock_m3)}</td>
                  <td style={tdR} className="num">{pc(r.share_pct)}</td>
                  <td style={{ ...tdR, color: "var(--text-mid)" }} className="num">{pln2(r.warehouse_cost_unit_monthly_pln)}</td>
                  <td style={tdR} className="num">{pln(r.warehouse_cost_monthly_pln)}</td>
                  <td style={{ ...tdR, fontWeight: 650 }} className="num">{pln(r.warehouse_cost_pln)}</td>
                  <td style={{ ...tdR, color: (r.warehouse_cost_share_pct ?? 0) > 50 ? "var(--critical)" : "var(--text-lo)" }} className="num">
                    {pc(r.warehouse_cost_share_pct)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={10} style={{ ...td, textAlign: "center", color: "var(--text-lo)", padding: 30 }}>Brak pozycji</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ══ RAPORT 2: SKU do wykluczenia ═════════════════════════════
export function SkuExclusionReport({ scope }: { scope: string }) {
  const [watched, setWatched] = useState(true);
  const { data, loading, reload } = useEconomics("/reports/sku-exclusion", scope, watched);
  const [filter, setFilter] = useState<string>("all");
  const [sort, setSort] = useState<SortState | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    (data?.rows || []).forEach((r) => { c[r.verdict] = (c[r.verdict] || 0) + 1; });
    return c;
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const base = filter === "all" ? data.rows : data.rows.filter((r) => r.verdict === filter);
    return sortRows(base, sort);
  }, [data, filter, sort]);

  if (loading) return <Card style={{ padding: 40, textAlign: "center", color: "var(--text-lo)" }}>Liczenie…</Card>;
  if (!data) return null;

  const thr = data.config.profit_threshold_pln;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 650, margin: 0 }}>SKU do wykluczenia</h2>
          <p style={{ margin: "4px 0 0", color: "var(--text-lo)", fontSize: 12.5 }}>
            Marża minus koszt miejsca, w skali roku. Poniżej {fmtPLN(thr)} produkt trafia pod rozwagę.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <ScopeToggle watched={watched} setWatched={setWatched} hidden={data.meta.hidden_count || 0} />
          <ConfigPanel onSaved={reload} showThreshold />
        </div>
      </div>

      <Notices data={data} />

      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        <button onClick={() => setFilter("all")} style={{ ...btnGhost, ...(filter === "all" ? { borderColor: "var(--text-hi)", color: "var(--text-hi)" } : {}) }}>
          Wszystkie ({data.rows.length})
        </button>
        {Object.entries(VERDICT).map(([key, v]) => (counts[key] ? (
          <button
            key={key} onClick={() => setFilter(key)}
            style={{ ...btnGhost, ...(filter === key ? { borderColor: `var(--${v.tone})`, color: `var(--${v.tone})` } : {}) }}
          >
            {v.label} ({counts[key]})
          </button>
        ) : null))}
      </div>

      <Card style={{ padding: "18px 4px 6px" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortTh label="SKU" k="sku" sort={sort} setSort={setSort} />
                <SortTh label="Nazwa" k="nazwa" sort={sort} setSort={setSort} />
                <SortTh label="Sprzedane" k="qty_sold" sort={sort} setSort={setSort} numeric />
                <SortTh label="Przychód" k="revenue_pln" sort={sort} setSort={setSort} numeric />
                <SortTh label="Marża" k="gross_margin_pln" sort={sort} setSort={setSort} numeric />
                <SortTh label="Koszt miejsca" k="warehouse_cost_pln" sort={sort} setSort={setSort} numeric />
                <SortTh label="Wynik / rok" k="result_pln" sort={sort} setSort={setSort} numeric />
                <SortTh label="Stan" k="stock_qty" sort={sort} setSort={setSort} numeric />
                <SortTh label="Zapas" k="months_of_stock" sort={sort} setSort={setSort} numeric />
                <SortTh label="Werdykt" k="verdict" sort={sort} setSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const v = VERDICT[r.verdict] || VERDICT.unknown;
                return (
                  <tr key={`${r.sku}-${r.firma_slug}`}>
                    <td style={{ ...td, fontFamily: "var(--font-mono, monospace)", fontWeight: 600 }}>{r.sku}</td>
                    <td style={{ ...td, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{r.nazwa}</td>
                    <td style={tdR} className="num">{fmtNum(r.qty_sold)}</td>
                    <td style={tdR} className="num">{pln(r.revenue_pln)}</td>
                    <td style={tdR} className="num">
                      {pln(r.gross_margin_pln)}
                      {r.gross_margin_pct != null && (
                        <span style={{ color: "var(--text-lo)", marginLeft: 6, fontSize: 11.5 }}>{pc(r.gross_margin_pct, 0)}</span>
                      )}
                    </td>
                    <td style={tdR} className="num">{pln(r.warehouse_cost_pln)}</td>
                    <td
                      style={{ ...tdR, fontWeight: 650, color: r.result_pln == null ? "var(--text-lo)" : r.result_pln < 0 ? "var(--critical)" : r.result_pln < thr ? "var(--warning)" : "var(--ok)" }}
                      className="num"
                      title={r.cost_included ? undefined : "Bez kosztu magazynu — brak CBM, wynik zawyżony"}
                    >
                      {pln(r.result_pln)}
                      {!r.cost_included && <span style={{ color: "var(--text-lo)", fontWeight: 400 }}> *</span>}
                    </td>
                    <td style={tdR} className="num">{fmtNum(r.stock_qty)}</td>
                    <td style={tdR} className="num">
                      {r.months_of_stock == null ? "—" : `${r.months_of_stock.toFixed(1).replace(".", ",")} mies.`}
                    </td>
                    <td style={td} title={r.reason}>
                      <Pill bg={`var(--${v.tone}-soft)`} fg={`var(--${v.tone})`} size="sm">{v.label}</Pill>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={10} style={{ ...td, textAlign: "center", color: "var(--text-lo)", padding: 30 }}>Brak pozycji</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ fontSize: 11.5, color: "var(--text-lo)", lineHeight: 1.7, padding: "0 4px" }}>
        Gwiazdka przy wyniku oznacza pozycję bez wypełnionego CBM: koszt magazynu nie został odjęty,
        więc wynik jest zawyżony. Jeśli mimo to wypada poniżej progu, ocena jest pewna — doliczenie
        miejsca mogłoby go tylko pogorszyć.
        {" "}Werdykt „za wcześnie" dostają produkty ze zbyt krótką historią sprzedaży — nowość z ostatniego kontenera
        zawsze wypadłaby źle. „Brak towaru" oznacza, że SKU stało puste przez większość dni: to brak dostaw,
        nie brak popytu. Obie etykiety mają pierwszeństwo przed oceną liczbową.
      </div>
    </div>
  );
}
