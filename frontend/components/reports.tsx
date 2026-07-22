"use client";
/**
 * Raporty — miesięczne zdjęcie KPI (z tabel snapshotów, zbieranych 2×/dzień).
 *
 * Format:  Widok (kafle jak na pulpicie) | PDF (przez okno druku, jak przy PO) | Excel (backend, openpyxl)
 * Zakres:  Wszyscy / AMH / Acti / Veluxa
 * Porównanie z poprzednim miesiącem — przełącznik.
 *
 * Dane są DOKŁADNE (snapshot z danego dnia), a nie rekonstruowane wstecz — dlatego
 * miesiąc bez snapshotów pokazuje pustkę zamiast zmyślonych liczb.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { api, download } from "@/lib/api";
import { fmtPLNk } from "@/lib/format";
import { I, Card } from "@/components/ui";
import { toast } from "@/components/toast";

type Row = { key: string; label: string; value: number | null; prev: number | null; delta_pct: number | null };
type Monthly = { month: string; scope: string; compare: boolean; snapshot_date: string | null; has_data: boolean; rows: Row[] };

const SCOPES = [
  { id: "all", label: "Wszyscy" },
  { id: "amh", label: "AMH" },
  { id: "acti", label: "Acti" },
  { id: "veluxa", label: "Veluxa" },
];
const MONTHS_PL = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];

const ymOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const labelOf = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS_PL[(m || 1) - 1]} ${y}`;
};
const shiftYm = (ym: string, delta: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, (m || 1) - 1 + delta, 1);
  return ymOf(d);
};
const isCount = (key: string) => false;   // wszystkie 4 KPI są kwotowe
const fmtVal = (r: Row) => (r.value == null ? "—" : isCount(r.key) ? String(r.value) : fmtPLNk(r.value));

function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return <span style={{ color: "var(--text-lo)", fontSize: 11 }}>—</span>;
  const up = pct >= 0;
  return (
    <span className="num" style={{ fontSize: 11, fontWeight: 650, color: up ? "var(--ok)" : "var(--critical)" }}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1).replace(".", ",")}%
    </span>
  );
}

const segBtn = (on: boolean): React.CSSProperties => ({
  border: "none", background: on ? "var(--surface-1)" : "transparent",
  boxShadow: on ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
  color: on ? "var(--text-hi)" : "var(--text-mid)",
  padding: "6px 13px", borderRadius: 6, fontSize: 13, fontWeight: 550, cursor: "pointer",
});
const segWrap: React.CSSProperties = { display: "inline-flex", background: "var(--surface-3)", borderRadius: 9, padding: 3 };
const labStyle: React.CSSProperties = { fontSize: 10, fontWeight: 650, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--text-lo)" };

export default function ReportsView() {
  const [month, setMonth] = useState(() => ymOf(new Date()));
  const [scope, setScope] = useState("all");
  const [compare, setCompare] = useState(true);
  const [fmt, setFmt] = useState<"view" | "pdf" | "xls">("view");
  const [data, setData] = useState<Monthly | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get(`/reports/monthly?month=${month}&scope=${scope}&compare=${compare ? 1 : 0}`);
      setData(d as Monthly);
    } catch {
      setData(null);
      toast("Nie udało się pobrać raportu", "warning");
    } finally {
      setLoading(false);
    }
  }, [month, scope, compare]);

  useEffect(() => { load(); }, [load]);

  const hero = useMemo(() => data?.rows.find((r) => r.key === "kapital_pln") || null, [data]);
  const rest = useMemo(() => (data?.rows || []).filter((r) => r.key !== "kapital_pln"), [data]);

  // Ręczne dorobienie snapshotu — przydaje się przy pierwszym uruchomieniu i do testu.
  const snapshotNow = async () => {
    setBusy(true);
    try {
      await api.post("/reports/snapshot?slot=wieczor", {});
      toast("Zapisano snapshot", "ok");
      await load();
    } catch {
      toast("Nie udało się zapisać snapshotu", "warning");
    } finally {
      setBusy(false);
    }
  };

  const downloadXlsx = async () => {
    setBusy(true);
    try {
      await download(`/reports/monthly/xlsx?month=${month}&scope=${scope}&compare=${compare ? 1 : 0}`,
                     `raport_${month}_${scope}.xlsx`);
    } catch {
      toast("Nie udało się pobrać Excela", "warning");
    } finally {
      setBusy(false);
    }
  };

  // PDF przez okno druku przeglądarki — ten sam wzorzec co generowanie zamówień (zero zależności).
  const printPdf = () => {
    if (!data?.has_data) { toast("Brak danych dla tego miesiąca", "warning"); return; }
    const w = window.open("", "_blank", "width=900,height=1100");
    if (!w) { toast("Włącz pop-upy dla tej strony, żeby wygenerować PDF", "warning"); return; }
    const scopeLabel = SCOPES.find((s) => s.id === scope)?.label || scope;
    const rowsHtml = (data.rows || []).map((r) => `
      <tr>
        <td class="k">${r.label}</td>
        <td class="r num">${r.value == null ? "—" : fmtPLNk(r.value)}</td>
        ${compare ? `<td class="r num">${r.prev == null ? "—" : fmtPLNk(r.prev)}</td>
        <td class="r num" style="color:${r.delta_pct == null ? "#8b909c" : r.delta_pct >= 0 ? "#16a34a" : "#e5484d"}">
          ${r.delta_pct == null ? "—" : (r.delta_pct >= 0 ? "▲ " : "▼ ") + Math.abs(r.delta_pct).toFixed(1).replace(".", ",") + "%"}</td>` : ""}
      </tr>`).join("");
    w.document.write(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Raport ${labelOf(month)}</title>
      <style>
        *{box-sizing:border-box}
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#171a20;margin:0;padding:42px 46px}
        .num{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
        .brand{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #171a20;padding-bottom:14px}
        .co{font-weight:700;font-size:15px}
        .co small{display:block;font-weight:500;color:#8b909c;font-size:11px;margin-top:2px}
        .rt{text-align:right;font-size:11px;color:#4b515c}
        h2{font-size:19px;margin:22px 0 2px}
        .sub{color:#8b909c;font-size:12px;margin-bottom:20px}
        .hero{display:flex;justify-content:space-between;align-items:baseline;background:#f7f8fa;border:1px solid #e7e9ee;border-radius:8px;padding:14px 18px;margin-bottom:18px}
        .hero .l{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#4b515c;font-weight:650}
        .hero .r{font-size:26px;font-weight:700;color:#6b5cf6}
        table{width:100%;border-collapse:collapse;font-size:13px}
        th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8b909c;font-weight:650;padding:0 0 8px;border-bottom:1px solid #e7e9ee}
        th.r,td.r{text-align:right}
        td{padding:11px 0;border-bottom:1px solid #eceef1}
        td.k{font-weight:600}
        .foot{margin-top:26px;padding-top:12px;border-top:1px solid #e7e9ee;font-size:10.5px;color:#8b909c;display:flex;justify-content:space-between}
        @media print{body{padding:0}}
      </style></head><body>
      <div class="brand">
        <div class="co">i-coucou / PolMeble<small>Raport magazynowy</small></div>
        <div class="rt">${scopeLabel}<br>${labelOf(month)}</div>
      </div>
      <h2>Raport miesięczny — ${labelOf(month)}</h2>
      <div class="sub">Stan na koniec miesiąca${data.snapshot_date ? ` (snapshot ${data.snapshot_date})` : ""} · zakres: ${scopeLabel}${compare ? " · porównanie z poprzednim miesiącem" : ""}</div>
      <div class="hero"><span class="l">Kapitał w towarze</span><span class="r num">${hero?.value == null ? "—" : fmtPLNk(hero.value)}</span></div>
      <table>
        <thead><tr><th>KPI</th><th class="r">Wartość</th>${compare ? '<th class="r">Poprzedni mies.</th><th class="r">Zmiana</th>' : ""}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="foot"><span>Wygenerowano automatycznie · Magazyn</span><span>${labelOf(month)} · ${scopeLabel}</span></div>
      </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  const actionLabel = fmt === "xls" ? "Pobierz Excel" : fmt === "pdf" ? "Drukuj / zapisz PDF" : "Zapisz snapshot teraz";
  const doAction = fmt === "xls" ? downloadXlsx : fmt === "pdf" ? printPdf : snapshotNow;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 650, margin: 0, letterSpacing: "-0.02em" }}>Raporty miesięczne</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-lo)", fontSize: 13 }}>
          Zdjęcie KPI na koniec miesiąca — zbierane automatycznie o 7:05 i 20:05.
        </p>
      </div>

      {/* Sterowanie */}
      <Card style={{ padding: "14px 16px", display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labStyle}>Miesiąc</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setMonth(shiftYm(month, -1))} style={{ width: 26, height: 26, border: "1px solid var(--border)", background: "var(--surface-1)", borderRadius: 7, color: "var(--text-mid)", cursor: "pointer" }}>‹</button>
            <span style={{ fontWeight: 600, fontSize: 14, minWidth: 118, textAlign: "center" }}>{labelOf(month)}</span>
            <button onClick={() => setMonth(shiftYm(month, 1))} style={{ width: 26, height: 26, border: "1px solid var(--border)", background: "var(--surface-1)", borderRadius: 7, color: "var(--text-mid)", cursor: "pointer" }}>›</button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labStyle}>Format</span>
          <div style={segWrap}>
            {(["view", "pdf", "xls"] as const).map((f) => (
              <button key={f} onClick={() => setFmt(f)} style={segBtn(fmt === f)}>
                {f === "view" ? "Widok" : f === "pdf" ? "PDF" : "Excel"}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labStyle}>Zakres</span>
          <div style={segWrap}>
            {SCOPES.map((s) => (
              <button key={s.id} onClick={() => setScope(s.id)} style={segBtn(scope === s.id)}>{s.label}</button>
            ))}
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text-mid)", marginTop: 16 }}>
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          Porównaj z poprzednim miesiącem
        </label>

        <div style={{ flex: 1 }} />
        <button onClick={doAction} disabled={busy} style={{
          display: "inline-flex", alignItems: "center", gap: 8, background: "var(--text-hi)", color: "var(--surface-1)",
          border: "none", padding: "10px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600,
          cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, marginTop: 16,
        }}>
          {busy ? "Pracuję…" : actionLabel}
        </button>
      </Card>

      {/* Treść */}
      {loading ? (
        <Card style={{ padding: 40, textAlign: "center", color: "var(--text-lo)" }}>Ładuję…</Card>
      ) : !data?.has_data ? (
        <Card style={{ padding: 40, textAlign: "center" }}>
          <div style={{ color: "var(--text-mid)", fontWeight: 600, marginBottom: 6 }}>Brak snapshotu dla {labelOf(month)}</div>
          <div style={{ color: "var(--text-lo)", fontSize: 12.5, lineHeight: 1.6 }}>
            Dane zbierane są automatycznie o 7:05 i 20:05 — historii nie da się odtworzyć wstecz.<br />
            Możesz zapisać pierwszy snapshot ręcznie przyciskiem powyżej.
          </div>
        </Card>
      ) : (
        <>
          {/* Kafel Kapitał */}
          <Card style={{ padding: "18px 20px", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={labStyle}>Kapitał w towarze</div>
              <div style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 2 }}>magazyn + w drodze</div>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              {compare && <Delta pct={hero?.delta_pct ?? null} />}
              <span className="num" style={{ fontSize: 32, fontWeight: 700, color: "var(--accent)", whiteSpace: "nowrap" }}>
                {hero ? fmtVal(hero) : "—"}
              </span>
            </div>
          </Card>

          {/* Pozostałe KPI */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
            {rest.map((r) => (
              <Card key={r.key} style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={labStyle}>{r.label}</span>
                <span className="num" style={{ fontSize: 24, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fmtVal(r)}</span>
                {compare && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-lo)" }}>
                    <Delta pct={r.delta_pct} />
                    {r.prev != null && <span>poprz. {fmtPLNk(r.prev)}</span>}
                  </span>
                )}
              </Card>
            ))}
          </div>

          {data.snapshot_date && (
            <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
              Stan na podstawie snapshotu z {data.snapshot_date} (ostatni zapis w miesiącu).
            </div>
          )}
        </>
      )}
    </div>
  );
}
