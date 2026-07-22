"use client";
/**
 * Raporty — dwa raporty oparte o snapshoty (zbierane 2×/dzień: 7:05 i 20:05).
 *
 *  [Raport zbiorczy magazynu]  — KPI w czasie; wybór dnia lub zakresu, grupowanie dzień/miesiąc,
 *                                ptaszki „co pokazać" (raport dla księgowej bez kontenerów).
 *  [Raport magazynu per SKU]   — stany per SKU; przy zakresie: początek vs koniec vs zmiana.
 *                                Filtry: tylko obserwowane, wyszukiwarka, ręczny wybór SKU.
 *
 * Podgląd jest zawsze live — pobranie pliku jest opcjonalne.
 * Dane są dokładne (snapshot), więc okres bez zapisów pokazuje pustkę, a nie zmyślone liczby.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { api, download } from "@/lib/api";
import { fmtPLNk } from "@/lib/format";
import { I, Card } from "@/components/ui";
import { toast } from "@/components/toast";

type KpiRow = { label: string; snap_date: string; snap_slot: string; [k: string]: string | number };
type KpiSummary = { key: string; label: string; start: number | null; end: number | null; delta: number | null; delta_pct: number | null };
type KpiData = { from: string; to: string; scope: string; group: string; live?: boolean; has_data: boolean; rows: KpiRow[]; summary: KpiSummary[]; fields: { key: string; label: string }[] };

type SkuRow = {
  sku: string; nazwa: string; firma_slug: string; cena_jednostkowa: number;
  stan_glowny: number; stan_w_drodze: number; w_kontenerze: number;
  razem: number; wartosc_pln: number; snap_date: string; snap_slot: string;
  razem_start?: number; razem_end?: number; delta_szt?: number;
  wartosc_start?: number; wartosc_end?: number; delta_pln?: number;
};
type SkuData = { from: string; to: string; is_range: boolean; compare?: string; live?: boolean; has_data: boolean; rows: SkuRow[]; totals: Record<string, number> };

const SCOPES = [{ id: "all", label: "Wszyscy" }, { id: "amh", label: "AMH" }, { id: "acti", label: "Acti" }, { id: "veluxa", label: "Veluxa" }];
const KPI_ALL = ["kapital_pln", "magazyn_pln", "magazyn_w_drodze_pln", "kontenery_pln"];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));
const monthStart = () => { const d = new Date(); return iso(new Date(d.getFullYear(), d.getMonth(), 1)); };

const labStyle: React.CSSProperties = { fontSize: 10, fontWeight: 650, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--text-lo)" };
const segWrap: React.CSSProperties = { display: "inline-flex", background: "var(--surface-3)", borderRadius: 9, padding: 3 };
const segBtn = (on: boolean): React.CSSProperties => ({
  border: "none", background: on ? "var(--surface-1)" : "transparent",
  boxShadow: on ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
  color: on ? "var(--text-hi)" : "var(--text-mid)",
  padding: "6px 12px", borderRadius: 6, fontSize: 12.5, fontWeight: 550, cursor: "pointer",
});
const inputStyle: React.CSSProperties = {
  background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8,
  padding: "7px 9px", fontSize: 13, color: "var(--text-hi)", fontFamily: "inherit",
};
const btnDark: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, background: "var(--text-hi)", color: "var(--surface-1)",
  border: "none", padding: "9px 15px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, background: "var(--surface-1)", color: "var(--text-mid)",
  border: "1px solid var(--border)", padding: "9px 15px", borderRadius: 9, fontSize: 13, fontWeight: 550, cursor: "pointer",
};
const th: React.CSSProperties = { textAlign: "left", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-lo)", fontWeight: 650, padding: "0 10px 8px", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "9px 10px", borderBottom: "1px solid var(--surface-3)", fontSize: 12.5, whiteSpace: "nowrap" };

function Delta({ pct, abs }: { pct?: number | null; abs?: number | null }) {
  const v = pct != null ? pct : abs;
  if (v == null) return <span style={{ color: "var(--text-lo)" }}>—</span>;
  const up = v >= 0;
  return (
    <span className="num" style={{ fontWeight: 650, color: up ? "var(--ok)" : "var(--critical)" }}>
      {up ? "▲" : "▼"} {pct != null ? `${Math.abs(pct).toFixed(1).replace(".", ",")}%` : fmtPLNk(Math.abs(abs || 0))}
    </span>
  );
}

/** Fragmentator dat — pojedynczy dzień albo zakres, z szybkimi skrótami. */
function DateSlicer({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  const presets: [string, () => void][] = [
    ["Dziś", () => { setFrom(today()); setTo(today()); }],
    ["7 dni", () => { setFrom(daysAgo(6)); setTo(today()); }],
    ["30 dni", () => { setFrom(daysAgo(29)); setTo(today()); }],
    ["Ten miesiąc", () => { setFrom(monthStart()); setTo(today()); }],
  ];
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={labStyle}>Od</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={labStyle}>Do</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingBottom: 2 }}>
        {presets.map(([lab, fn]) => (
          <button key={lab} onClick={fn} style={{ ...btnGhost, padding: "6px 10px", fontSize: 12 }}>{lab}</button>
        ))}
      </div>
    </div>
  );
}

/** Przełącznik źródła: stan liczony na żywo vs zapisane snapshoty. Zielona kropka mruga w trybie live. */
function LiveToggle({ live, setLive }: { live: boolean; setLive: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={labStyle}>Źródło</span>
      <div style={segWrap}>
        <button onClick={() => setLive(true)} style={{ ...segBtn(live), display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span className={live ? "live-dot on" : "live-dot"} />Teraz
        </button>
        <button onClick={() => setLive(false)} style={segBtn(!live)}>Z historii</button>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Card style={{ padding: 40, textAlign: "center" }}>
      <div style={{ color: "var(--text-mid)", fontWeight: 600, marginBottom: 6 }}>Brak danych w tym okresie</div>
      <div style={{ color: "var(--text-lo)", fontSize: 12.5, lineHeight: 1.6 }}>{children}</div>
    </Card>
  );
}

// ── Raport zbiorczy ──────────────────────────────────────────

function KpiReport({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  const [live, setLive] = useState(true);
  const [scope, setScope] = useState("all");
  const [group, setGroup] = useState<"day" | "month">("day");
  const [show, setShow] = useState<string[]>(KPI_ALL);
  const [data, setData] = useState<KpiData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = live ? `/reports/live/kpi?scope=${scope}` : `/reports/kpi-range?from=${from}&to=${to}&scope=${scope}&group=${group}`;
      setData(await api.get(url) as KpiData);
    } catch { setData(null); toast("Nie udało się pobrać raportu", "warning"); }
    finally { setLoading(false); }
  }, [from, to, scope, group, live]);
  useEffect(() => { load(); }, [load]);

  const cols = useMemo(() => (data?.fields || []).filter((f) => show.includes(f.key)), [data, show]);
  const toggle = (k: string) => setShow((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const getXlsx = () =>
    download(live
        ? `/reports/kpi-range/xlsx?live=1&scope=${scope}&fields=${show.join(",")}`
        : `/reports/kpi-range/xlsx?from=${from}&to=${to}&scope=${scope}&group=${group}&fields=${show.join(",")}`,
             live ? `raport_zbiorczy_teraz_${scope}.xlsx` : `raport_zbiorczy_${from}_${to}_${scope}.xlsx`).catch(() => toast("Nie udało się pobrać Excela", "warning"));

  const printPdf = () => {
    if (!data?.has_data) { toast("Brak danych dla tego okresu", "warning"); return; }
    const w = window.open("", "_blank", "width=900,height=1100");
    if (!w) { toast("Włącz pop-upy dla tej strony, żeby wygenerować PDF", "warning"); return; }
    const logoUrl = `${window.location.origin}/assets/logo-black.png`;
    const scopeLabel = SCOPES.find((s) => s.id === scope)?.label || scope;
    const okres = live ? "stan na teraz" : (from === to ? from : `${from} … ${to}`);
    const sumRows = (data.summary || []).filter((s) => show.includes(s.key)).map((s) => `
      <tr><td class="k">${s.label}</td>
        <td class="r num">${s.end == null ? "—" : fmtPLNk(s.end)}</td>
        <td class="r num">${s.start == null ? "—" : fmtPLNk(s.start)}</td>
        <td class="r num" style="color:${s.delta_pct == null ? "#8b909c" : s.delta_pct >= 0 ? "#16a34a" : "#e5484d"}">
          ${s.delta_pct == null ? "—" : (s.delta_pct >= 0 ? "▲ " : "▼ ") + Math.abs(s.delta_pct).toFixed(1).replace(".", ",") + "%"}</td></tr>`).join("");
    const detail = (data.rows || []).map((r) => `
      <tr><td class="k">${r.label}</td>${cols.map((c) => `<td class="r num">${fmtPLNk(Number(r[c.key]) || 0)}</td>`).join("")}</tr>`).join("");
    w.document.write(`<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Raport ${okres}</title><style>
      *{box-sizing:border-box}
      body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#171a20;margin:0;padding:42px 46px}
      .num{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
      .brand{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #171a20;padding-bottom:14px}
      .co small{display:block;font-weight:500;color:#8b909c;font-size:11px;margin-top:6px}
      .logo{height:30px;width:auto;display:block}
      .rt{text-align:right;font-size:11px;color:#4b515c}
      h2{font-size:19px;margin:22px 0 2px}
      .sub{color:#8b909c;font-size:12px;margin-bottom:20px}
      h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#4b515c;margin:24px 0 8px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8b909c;font-weight:650;padding:0 6px 8px;border-bottom:1px solid #e7e9ee}
      th.r,td.r{text-align:right}
      td{padding:9px 6px;border-bottom:1px solid #eceef1}
      td.k{font-weight:600}
      .foot{margin-top:26px;padding-top:12px;border-top:1px solid #e7e9ee;font-size:10.5px;color:#8b909c;display:flex;justify-content:space-between}
      @media print{body{padding:0}}
    </style></head><body>
      <div class="brand">
        <div class="co"><img src="${logoUrl}" alt="i-coucou" class="logo" onerror="this.style.display='none'"><small>Raport magazynowy</small></div>
        <div class="rt">${scopeLabel}<br>${okres}</div>
      </div>
      <h2>Raport zbiorczy magazynu</h2>
      <div class="sub">Okres: ${okres} · zakres: ${scopeLabel}</div>
      <h3>Podsumowanie okresu</h3>
      <table><thead><tr><th>KPI</th><th class="r">Na koniec</th><th class="r">Na początek</th><th class="r">Zmiana</th></tr></thead><tbody>${sumRows}</tbody></table>
      ${data.rows.length > 1 ? `<h3>Przebieg</h3><table><thead><tr><th>Okres</th>${cols.map((c) => `<th class="r">${c.label}</th>`).join("")}</tr></thead><tbody>${detail}</tbody></table>` : ""}
      <div class="foot"><span>Wygenerowano automatycznie · Magazyn</span><span>${okres} · ${scopeLabel}</span></div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
        {!live && <DateSlicer from={from} to={to} setFrom={setFrom} setTo={setTo} />}
        <div style={{ display: "flex", gap: 18, alignItems: "flex-end", flexWrap: "wrap" }}>
          <LiveToggle live={live} setLive={setLive} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labStyle}>Zakres</span>
            <div style={segWrap}>{SCOPES.map((s) => <button key={s.id} onClick={() => setScope(s.id)} style={segBtn(scope === s.id)}>{s.label}</button>)}</div>
          </div>
          {!live && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labStyle}>Grupowanie</span>
              <div style={segWrap}>
                <button onClick={() => setGroup("day")} style={segBtn(group === "day")}>Dzień</button>
                <button onClick={() => setGroup("month")} style={segBtn(group === "month")}>Miesiąc</button>
              </div>
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={printPdf} style={btnGhost}>PDF</button>
          <button onClick={getXlsx} style={btnDark}>Excel</button>
        </div>
        <div>
          <span style={labStyle}>Co pokazać w raporcie</span>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
            {(data?.fields || []).map((f) => (
              <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "var(--text-mid)", cursor: "pointer" }}>
                <input type="checkbox" checked={show.includes(f.key)} onChange={() => toggle(f.key)} />
                {f.label}
              </label>
            ))}
          </div>
        </div>
      </Card>

      {loading ? <Card style={{ padding: 40, textAlign: "center", color: "var(--text-lo)" }}>Ładuję…</Card>
        : !data?.has_data ? <Empty>{live ? "Brak danych do policzenia stanu." : "Snapshoty zbierane są o 7:05 i 20:05 — historii nie da się odtworzyć wstecz."}</Empty>
        : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))", gap: 12 }}>
              {data.summary.filter((s) => show.includes(s.key)).map((s) => (
                <Card key={s.key} style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 7 }}>
                  <span style={labStyle}>{s.label}</span>
                  <span className="num" style={{ fontSize: 23, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.end == null ? "—" : fmtPLNk(s.end)}
                  </span>
                  <span style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11, color: "var(--text-lo)" }}>
                    <Delta pct={s.delta_pct} />{s.start != null && <span>z {fmtPLNk(s.start)}</span>}
                  </span>
                </Card>
              ))}
            </div>

            {data.rows.length > 1 && (
              <Card style={{ padding: "14px 6px 6px" }}>
                <div style={{ padding: "0 10px 10px", ...labStyle }}>Przebieg ({data.rows.length})</div>
                <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr><th style={th}>Okres</th>{cols.map((c) => <th key={c.key} style={{ ...th, textAlign: "right" }}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={r.label}>
                          <td style={{ ...td, fontWeight: 600 }}>{r.label}</td>
                          {cols.map((c) => <td key={c.key} className="num" style={{ ...td, textAlign: "right" }}>{fmtPLNk(Number(r[c.key]) || 0)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </>
        )}
    </div>
  );
}

// ── Raport per SKU ───────────────────────────────────────────

function SkuReport({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  const [live, setLive] = useState(true);
  const [favOnly, setFavOnly] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [data, setData] = useState<SkuData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = live ? `/reports/live/sku?favorites_only=${favOnly ? 1 : 0}`
                       : `/reports/sku?from=${from}&to=${to}&favorites_only=${favOnly ? 1 : 0}`;
      setData(await api.get(url) as SkuData);
    } catch { setData(null); toast("Nie udało się pobrać raportu", "warning"); }
    finally { setLoading(false); }
  }, [from, to, favOnly, live]);
  useEffect(() => { load(); }, [load]);

  const rng = !!data?.is_range;
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.rows || []).filter((r) => !needle || r.sku.toLowerCase().includes(needle) || (r.nazwa || "").toLowerCase().includes(needle));
  }, [data, q]);
  const chosen = useMemo(() => (picked.length ? visible.filter((r) => picked.includes(r.sku)) : visible), [visible, picked]);

  const totals = useMemo(() => ({
    count: chosen.length,
    units: chosen.reduce((s, r) => s + r.razem, 0),
    value: chosen.reduce((s, r) => s + r.wartosc_pln, 0),
    delta: chosen.reduce((s, r) => s + (r.delta_pln || 0), 0),
  }), [chosen]);

  const toggleSku = (sku: string) => setPicked((p) => (p.includes(sku) ? p.filter((x) => x !== sku) : [...p, sku]));
  const getXlsx = () =>
    download(live
        ? `/reports/sku/xlsx?live=1&favorites_only=${favOnly ? 1 : 0}&skus=${encodeURIComponent(picked.join(","))}`
        : `/reports/sku/xlsx?from=${from}&to=${to}&favorites_only=${favOnly ? 1 : 0}&skus=${encodeURIComponent(picked.join(","))}`,
             live ? "raport_sku_teraz.xlsx" : `raport_sku_${from}${rng ? `_${to}` : ""}.xlsx`).catch(() => toast("Nie udało się pobrać Excela", "warning"));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
        {!live && <DateSlicer from={from} to={to} setFrom={setFrom} setTo={setTo} />}
        <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
          <LiveToggle live={live} setLive={setLive} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 220px", minWidth: 180 }}>
            <span style={labStyle}>Szukaj SKU / nazwy</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="np. A2-1cz" style={inputStyle} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-mid)", cursor: "pointer", paddingBottom: 8 }}>
            <input type="checkbox" checked={favOnly} onChange={(e) => { setFavOnly(e.target.checked); setPicked([]); }} />
            Tylko obserwowane
          </label>
          {picked.length > 0 && (
            <button onClick={() => setPicked([])} style={{ ...btnGhost, padding: "7px 11px", fontSize: 12 }}>
              Wyczyść wybór ({picked.length})
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={getXlsx} style={btnDark}>Excel</button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
          {picked.length > 0
            ? `Raport obejmie ${picked.length} zaznaczonych SKU.`
            : "Bez zaznaczenia raport obejmie wszystkie SKU spełniające filtry. Zaznacz wiersze, by zawęzić."}
        </div>
      </Card>

      {loading ? <Card style={{ padding: 40, textAlign: "center", color: "var(--text-lo)" }}>Ładuję…</Card>
        : !data?.has_data ? <Empty>{live ? "Brak stanów do pokazania." : "W tym okresie nie ma snapshotów stanów. Zbierane są o 7:05 i 20:05."}</Empty>
        : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <Card style={{ padding: "14px 16px" }}>
                <div style={labStyle}>SKU w raporcie</div>
                <div className="num" style={{ fontSize: 22, fontWeight: 650, marginTop: 6 }}>{totals.count}</div>
              </Card>
              <Card style={{ padding: "14px 16px" }}>
                <div style={labStyle}>Sztuk łącznie</div>
                <div className="num" style={{ fontSize: 22, fontWeight: 650, marginTop: 6 }}>{totals.units.toLocaleString("pl-PL")}</div>
              </Card>
              <Card style={{ padding: "14px 16px" }}>
                <div style={labStyle}>Wartość</div>
                <div className="num" style={{ fontSize: 22, fontWeight: 650, marginTop: 6, color: "var(--accent)", whiteSpace: "nowrap" }}>{fmtPLNk(totals.value)}</div>
              </Card>
              {rng && (
                <Card style={{ padding: "14px 16px" }}>
                  <div style={labStyle}>{data.compare === "intraday" ? "Zmiana w ciągu dnia" : "Zmiana w okresie"}</div>
                  <div style={{ fontSize: 20, fontWeight: 650, marginTop: 6 }}><Delta abs={totals.delta} /></div>
                </Card>
              )}
            </div>

            <Card style={{ padding: "14px 6px 6px" }}>
              <div style={{ padding: "0 10px 10px", ...labStyle }}>
                Podgląd ({visible.length}{visible.length !== (data.rows.length) ? ` z ${data.rows.length}` : ""})
              </div>
              <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: 34 }} />
                      <th style={th}>SKU</th>
                      <th style={th}>Nazwa</th>
                      <th style={th}>Firma</th>
                      <th style={{ ...th, textAlign: "right" }}>Cena</th>
                      <th style={{ ...th, textAlign: "right" }}>Główny</th>
                      <th style={{ ...th, textAlign: "right" }}>W drodze</th>
                      <th style={{ ...th, textAlign: "right" }}>W kontenerze</th>
                      <th style={{ ...th, textAlign: "right" }}>Razem</th>
                      <th style={{ ...th, textAlign: "right" }}>Wartość</th>
                      {rng && <>
                        <th style={{ ...th, textAlign: "right" }}>{data.compare === "intraday" ? "Szt. rano" : "Szt. start"}</th>
                        <th style={{ ...th, textAlign: "right" }}>{data.compare === "intraday" ? "Szt. wieczór" : "Szt. koniec"}</th>
                        <th style={{ ...th, textAlign: "right" }}>Zmiana</th>
                      </>}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => {
                      const on = picked.includes(r.sku);
                      return (
                        <tr key={r.sku} style={on ? { background: "var(--surface-2)" } : undefined}>
                          <td style={{ ...td, textAlign: "center" }}>
                            <input type="checkbox" checked={on} onChange={() => toggleSku(r.sku)} />
                          </td>
                          <td className="mono" style={{ ...td, fontWeight: 600 }}>{r.sku}</td>
                          <td style={{ ...td, whiteSpace: "normal", maxWidth: 260, color: r.nazwa ? "var(--text-mid)" : "var(--text-lo)" }}>{r.nazwa || "—"}</td>
                          <td style={{ ...td, color: "var(--text-lo)" }}>{(r.firma_slug || "").toUpperCase()}</td>
                          <td className="num" style={{ ...td, textAlign: "right" }}>{r.cena_jednostkowa.toLocaleString("pl-PL")}</td>
                          <td className="num" style={{ ...td, textAlign: "right" }}>{r.stan_glowny}</td>
                          <td className="num" style={{ ...td, textAlign: "right", color: "var(--info)" }}>{r.stan_w_drodze}</td>
                          <td className="num" style={{ ...td, textAlign: "right", color: "var(--info)" }}>{r.w_kontenerze}</td>
                          <td className="num" style={{ ...td, textAlign: "right", fontWeight: 600 }}>{r.razem}</td>
                          <td className="num" style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtPLNk(r.wartosc_pln)}</td>
                          {rng && <>
                            <td className="num" style={{ ...td, textAlign: "right", color: "var(--text-lo)" }}>{r.razem_start ?? 0}</td>
                            <td className="num" style={{ ...td, textAlign: "right", color: "var(--text-lo)" }}>{r.razem_end ?? r.razem}</td>
                            <td style={{ ...td, textAlign: "right" }}><Delta abs={r.delta_pln ?? 0} /></td>
                          </>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
    </div>
  );
}

// ── Ekran główny ─────────────────────────────────────────────

export default function ReportsView() {
  const [mode, setMode] = useState<null | "kpi" | "sku">(null);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());

  const box = (id: "kpi" | "sku", title: string, desc: string, icon: React.ReactNode, formats: string) => (
    <Card style={{ padding: "22px 24px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 10 }}>
      <div onClick={() => setMode(id)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--accent)" }}>{icon}</span>
          <span style={{ fontSize: 15, fontWeight: 650 }}>{title}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-lo)", lineHeight: 1.6 }}>{desc}</div>
        <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>{formats}</div>
      </div>
    </Card>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <style>{`
        @keyframes livePulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.82); } }
        .live-dot { width: 7px; height: 7px; border-radius: 99px; background: var(--ok); display: inline-block; }
        .live-dot.on { animation: livePulse 1.6s ease-in-out infinite; }
      `}</style>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 650, margin: 0, letterSpacing: "-0.02em" }}>Raporty</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-lo)", fontSize: 13 }}>
            Stan na teraz (liczony na żywo) albo z historii — snapshoty zbierane o 7:05 i 20:05.
          </p>
        </div>
      </div>

      {mode === null ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          {box("kpi", "Raport zbiorczy magazynu", "Wartości magazynu w czasie — wybierz dzień lub zakres, zdecyduj ptaszkami, które pozycje mają się pokazać.", <I.TrendUp size={18} />, "Podgląd · PDF · Excel")}
          {box("sku", "Raport magazynu per SKU", "Stany i wartość per produkt. Przy zakresie dat pokaże początek, koniec i zmianę. Filtr obserwowanych i ręczny wybór SKU.", <I.Box size={18} />, "Podgląd · Excel")}
        </div>
      ) : (
        <>
          <button onClick={() => setMode(null)} style={{ ...btnGhost, alignSelf: "flex-start", padding: "6px 11px", fontSize: 12 }}>
            ‹ Wszystkie raporty
          </button>
          {mode === "kpi"
            ? <KpiReport from={from} to={to} setFrom={setFrom} setTo={setTo} />
            : <SkuReport from={from} to={to} setFrom={setFrom} setTo={setTo} />}
        </>
      )}
    </div>
  );
}
