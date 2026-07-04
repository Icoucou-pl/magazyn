"use client";
// ============================================================
// MAGAZYN — Zużycie API (asystent AI). Panel w Ustawieniach.
// Widoczny tylko dla admina i super-admina (gating w settings.tsx).
// Dane: GET /usage/stats → saldo, rozkład input/output, ostatnie zapytania.
//
// Uwaga: Anthropic nie udostępnia realnego salda konta przez API, więc
// "pozostało" = STARTING_BALANCE_USD − suma zalogowanych kosztów. Trzymaj
// STARTING_BALANCE_USD (env) zgodne z tym, co realnie wpłacone w konsoli.
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import { I } from "./ui";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/format";

// ── Typy (kształt z /usage/stats) ────────────────────────────
type UsageRow = {
  id: number;
  created_at: string | null;
  query: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  input_cost: number;
  output_cost: number;
  api_calls: number;
};
type Breakdown = {
  input_tokens: number;
  output_tokens: number;
  input_cost: number;
  output_cost: number;
  output_share_pct: number;
};
type UsageStats = {
  starting_balance: number;
  spent: number;
  remaining: number;
  count: number;
  breakdown: Breakdown;
  rows: UsageRow[];
};

// ── Formatery ────────────────────────────────────────────────
const usd = (n: number): string => {
  const v = Number(n) || 0;
  if (v !== 0 && Math.abs(v) < 0.01) return "$" + v.toFixed(5);
  return "$" + v.toFixed(v < 1 ? 4 : 2);
};
const fmtTs = (s: string | null): string => {
  if (!s) return "—";
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(hasTz ? s : s.replace(" ", "T") + "Z");
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const CARD: React.CSSProperties = {
  background: "var(--surface-1)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--r-lg)",
  padding: 18,
};
const TD_L: React.CSSProperties = {
  textAlign: "left", padding: "9px 14px",
  borderBottom: "1px solid var(--border-soft)", color: "var(--text-mid)", whiteSpace: "nowrap",
};
const TD_R: React.CSSProperties = {
  textAlign: "right", padding: "9px 14px",
  borderBottom: "1px solid var(--border-soft)", color: "var(--text-mid)", whiteSpace: "nowrap",
};

const HEADS: { label: string; align: React.CSSProperties["textAlign"] }[] = [
  { label: "Czas", align: "left" },
  { label: "Pytanie", align: "left" },
  { label: "Model", align: "left" },
  { label: "Tok. in", align: "right" },
  { label: "Tok. out", align: "right" },
  { label: "Koszt", align: "right" },
];

// ── Panel ────────────────────────────────────────────────────
export default function UsagePanel() {
  const [data, setData] = useState<UsageStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = (await api.get("/usage/stats")) as UsageStats;
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Nie udało się pobrać danych");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000); // odświeżanie w tle
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) return <div style={{ color: "var(--text-lo)", fontSize: 13, padding: 20 }}>Ładowanie…</div>;
  if (err && !data) return <div style={{ color: "var(--critical)", fontSize: 13, padding: 20 }}>{err}</div>;
  if (!data) return null;

  const start = data.starting_balance || 0;
  const pctUsed = start > 0 ? Math.min(100, (data.spent / start) * 100) : 0;
  const low = data.remaining <= start * 0.15;

  const b = data.breakdown;
  const totalCost = (b.input_cost || 0) + (b.output_cost || 0);
  const outW = totalCost > 0 ? (b.output_cost / totalCost) * 100 : 0;
  const inW = 100 - outW;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* SALDO */}
      <div style={CARD}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-lo)", marginBottom: 4 }}>
              Pozostało na koncie
            </div>
            <div className="num" style={{ fontSize: 34, fontWeight: 600, color: low ? "var(--critical)" : "var(--accent)", lineHeight: 1 }}>
              {usd(data.remaining)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            <Metric label="Wpłacone" value={usd(start)} />
            <Metric label="Wydane" value={usd(data.spent)} />
            <Metric label="Zapytań" value={fmtNum(data.count)} />
          </div>
        </div>
        <div style={{ height: 6, borderRadius: 99, background: "var(--surface-3)", marginTop: 16, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pctUsed}%`, background: low ? "var(--critical)" : "var(--accent)", borderRadius: 99, transition: "width .4s" }} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 6 }}>
          {pctUsed.toFixed(1)}% wykorzystane · saldo liczone jako wpłata − koszty
        </div>
      </div>

      {/* ROZKŁAD input vs output */}
      <div style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Gdzie idzie kasa: wejście vs wyjście</div>
        <div style={{ display: "flex", height: 10, borderRadius: 99, overflow: "hidden", background: "var(--surface-3)" }}>
          <div style={{ width: `${inW}%`, background: "var(--info)" }} title={`Wejście ${usd(b.input_cost)}`} />
          <div style={{ width: `${outW}%`, background: "var(--accent)" }} title={`Wyjście ${usd(b.output_cost)}`} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, gap: 12, flexWrap: "wrap" }}>
          <Legend color="var(--info)" label="Wejście (input)" tokens={b.input_tokens} cost={b.input_cost} />
          <Legend color="var(--accent)" label="Wyjście (output)" tokens={b.output_tokens} cost={b.output_cost} />
        </div>
        <div style={{ fontSize: 12, color: "var(--text-mid)", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
          Wyjście to <b style={{ color: "var(--text-hi)" }}>{b.output_share_pct}%</b> rachunku. Najlepszy lewar na koszt to krótkie odpowiedzi, nie cache wejścia.
        </div>
      </div>

      {/* TABELA ostatnich zapytań */}
      <div style={{ ...CARD, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Ostatnie zapytania</div>
          <button
            onClick={load}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface-2)", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}
          >
            <I.Refresh size={13} /> Odśwież
          </button>
        </div>

        {data.rows.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
            Brak zapytań. Zadaj pierwsze pytanie asystentowi.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  {HEADS.map((h) => (
                    <th key={h.label} style={{ textAlign: h.align, padding: "10px 14px", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-lo)", fontWeight: 500, borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap" }}>
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td style={TD_L}>{fmtTs(r.created_at)}</td>
                    <td style={{ ...TD_L, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-hi)" }} title={r.query || ""}>
                      {r.query || "—"}
                    </td>
                    <td style={{ ...TD_L, color: "var(--text-lo)" }}>{(r.model || "").replace("claude-", "")}</td>
                    <td className="num" style={TD_R}>{fmtNum(r.input_tokens)}</td>
                    <td className="num" style={TD_R}>{fmtNum(r.output_tokens)}</td>
                    <td className="num" style={{ ...TD_R, color: "var(--accent)", fontWeight: 500 }} title={`in ${usd(r.input_cost)} · out ${usd(r.output_cost)}`}>
                      {usd(r.cost_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Drobne podkomponenty ─────────────────────────────────────
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-lo)" }}>{label}</div>
      <div className="num" style={{ fontSize: 15, fontWeight: 500, color: "var(--text-hi)", marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Legend({ color, label, tokens, cost }: { color: string; label: string; tokens: number; cost: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 12, color: "var(--text-hi)" }}>{label}</div>
        <div className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{fmtNum(tokens)} tok · {usd(cost)}</div>
      </div>
    </div>
  );
}
