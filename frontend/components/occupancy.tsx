"use client";
/**
 * Zajętość magazynu — ile miejsca (m³) zajmuje towar dziś i ile będzie zajmował
 * po dostawach do wybranego dnia.
 *
 * Objętość = CBM produktu × ilość. Na stanie liczymy magazyn GŁÓWNY (towar
 * fizycznie w hali). Kontenery dochodzą po dacie wejścia na magazyn:
 * delivered_date → expected_delivery_date → ETA + odprawa (7 dni) — ta sama
 * reguła, co w Kalendarzu i Prognozie.
 *
 * Suwak horyzontu przesuwa datę odcięcia: „dziś" pokazuje stan hali teraz,
 * „+30 dni" — jak będzie wyglądać po rozładowaniu tego, co do wtedy dojedzie.
 *
 * Widok bramkuje uprawnienie `viewOccupancy` (patrz reports.tsx).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { I, Card, Pill } from "@/components/ui";
import { toast } from "@/components/toast";

// ── typy ─────────────────────────────────────────────────────
type Threshold = { label: string; from_pct: number; tone: string };
type Thresholds = { product: Threshold[]; fill: Threshold[] };
type FirmRow = {
  slug: string; label: string; capacity_m3: number; stock_m3: number; incoming_m3: number;
  used_m3: number; free_m3: number; fill_pct: number; sku_count: number; over_count: number;
  no_cbm_count?: number; threshold_label: string; threshold_tone: string;
};
type OccRow = {
  sku: string; nazwa: string; firma_slug: string; cbm_per_unit: number;
  stock_qty: number; incoming_qty: number; qty: number;
  stock_m3: number; incoming_m3: number; volume_m3: number;
  share_firm_pct: number; share_scope_pct: number;
  threshold_label: string; threshold_tone: string; over: boolean; no_cbm?: boolean;
};
type TimelineRow = { date: string; container_number: string; m3: number; firmy: Record<string, number> };
type OccData = {
  scope: string; horizon_days: number; as_of: string; cutoff: string;
  capacity_m3: number; stock_m3: number; incoming_m3: number; used_m3: number; free_m3: number;
  fill_pct: number; fill_label: string; fill_tone: string;
  over_count: number; over_threshold_pct: number; over_threshold_label: string;
  firms: FirmRow[]; rows: OccRow[]; timeline: TimelineRow[];
  missing_cbm: { sku_count: number; units: number; sku_count_all?: number; units_all?: number };
  thresholds: Thresholds; caps: Record<string, number>;
  generated_at?: string;
};

// ── formatowanie ─────────────────────────────────────────────
const m3 = (n: number) => (n || 0).toFixed(1).replace(".", ",");
const pc = (n: number, d = 1) => (n || 0).toFixed(d).replace(".", ",") + "%";
const num = (n: number) => new Intl.NumberFormat("pl-PL").format(Math.round(n || 0));
const tc = (t: string) => `var(--${t || "info"})`;
const tsoft = (t: string) => `var(--${t || "info"}-soft)`;
const dayLabel = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("pl-PL", { day: "numeric", month: "long", year: "numeric" });
};

const TONES = ["ok", "warning", "critical", "info", "pending", "anomaly", "accent"];
const TONE_LABEL: Record<string, string> = {
  ok: "zielony", warning: "pomarańczowy", critical: "czerwony", info: "niebieski",
  pending: "żółty", anomaly: "fioletowy", accent: "amber",
};
const FIRM_COLOR: Record<string, string> = { amh: "var(--accent)", acti: "var(--info)", veluxa: "var(--anomaly)" };
const firmColor = (slug: string) => FIRM_COLOR[slug] || "var(--text-mid)";
const HORIZON_PRESETS = [0, 14, 30, 60, 90];

// ── style ────────────────────────────────────────────────────
const labStyle: React.CSSProperties = { fontSize: 10, fontWeight: 650, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--text-lo)" };
const btnGhost: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, background: "var(--surface-1)", color: "var(--text-mid)",
  border: "1px solid var(--border)", padding: "8px 13px", borderRadius: 9, fontSize: 12.5, fontWeight: 550, cursor: "pointer",
};
const btnDark: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, background: "var(--text-hi)", color: "var(--surface-1)",
  border: "none", padding: "9px 15px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const inputStyle: React.CSSProperties = {
  background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8,
  padding: "7px 9px", fontSize: 13, color: "var(--text-hi)", fontFamily: "inherit",
};
const th: React.CSSProperties = {
  textAlign: "right", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-lo)",
  fontWeight: 650, padding: "0 10px 8px", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none",
};
const td: React.CSSProperties = { padding: "9px 10px", borderBottom: "1px solid var(--surface-3)", fontSize: 12.5, whiteSpace: "nowrap" };

// ── pasek pojemności ─────────────────────────────────────────
function CapacityBar({ segments, incoming, capacity, thresholds, height = 28, ticks = true }: {
  segments: { key: string; label: string; value: number; color: string }[];
  incoming: number; capacity: number; thresholds: Threshold[]; height?: number; ticks?: boolean;
}) {
  const solid = segments.reduce((a, s) => a + s.value, 0);
  const total = solid + incoming;
  const scale = Math.max(capacity, total) * 1.015 || 1;
  const w = (v: number) => (v / scale) * 100;
  const capX = w(capacity);
  return (
    <div>
      <div style={{ position: "relative", height, background: "var(--surface-3)", border: "1px solid var(--border-soft)", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "flex", height: "100%" }}>
          {segments.map((s) => (
            <div key={s.key} title={`${s.label}: ${m3(s.value)} m³ na stanie`}
                 style={{ width: `${w(s.value)}%`, background: s.color, opacity: 0.9 }} />
          ))}
          {incoming > 0 && (
            <div title={`W drodze do wybranego dnia: ${m3(incoming)} m³`}
                 style={{
                   width: `${w(incoming)}%`, backgroundColor: "var(--surface-2)",
                   backgroundImage: "repeating-linear-gradient(115deg, var(--text-lo) 0 3px, transparent 3px 8px)",
                 }} />
          )}
        </div>
        {ticks && thresholds.filter((t) => t.from_pct > 0 && t.from_pct < 100).map((t, i) => (
          <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${w((capacity * t.from_pct) / 100)}%`, width: 1, background: "var(--border-strong)" }} />
        ))}
        {capX < 99.5 && (
          <div title={`Pojemność hali: ${num(capacity)} m³`}
               style={{ position: "absolute", top: -2, bottom: -2, left: `${capX}%`, width: 2, background: "var(--critical)" }} />
        )}
      </div>
      {ticks && (
        <div style={{ position: "relative", height: 15, marginTop: 4 }}>
          {thresholds.filter((t) => t.from_pct > 0 && t.from_pct <= 100).map((t, i) => (
            <span key={i} className="num" style={{
              position: "absolute", left: `min(${w((capacity * t.from_pct) / 100)}%, calc(100% - 40px))`,
              transform: "translateX(-50%)", fontSize: 9, color: tc(t.tone), whiteSpace: "nowrap",
            }}>{t.from_pct}%</span>
          ))}
          {capX < 99.5 && (
            <span className="num" style={{ position: "absolute", left: `${capX}%`, transform: "translateX(-50%)", fontSize: 9, color: "var(--critical)", whiteSpace: "nowrap" }}>
              {num(capacity)} m³
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── kafelek KPI ──────────────────────────────────────────────
function Kpi({ label, value, sub, tone, icon }: { label: string; value: string; sub?: string; tone?: string; icon?: React.ReactNode }) {
  return (
    <Card style={{ padding: "15px 17px", display: "flex", flexDirection: "column", gap: 10, minHeight: 112 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={labStyle}>{label}</span>
        {icon && <span style={{ color: "var(--text-lo)" }}>{icon}</span>}
      </div>
      <div>
        <div className="num" style={{ fontSize: 25, fontWeight: 650, letterSpacing: "-0.02em", color: tone ? tc(tone) : "var(--text-hi)", lineHeight: 1.1 }}>{value}</div>
        {sub && <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginTop: 4 }}>{sub}</div>}
      </div>
    </Card>
  );
}

// ── panel ustawień: pojemności + progi ───────────────────────
function ThresholdEditor({ list, setList, hint }: { list: Threshold[]; setList: (v: Threshold[]) => void; hint: string }) {
  const upd = (i: number, patch: Partial<Threshold>) => setList(list.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const add = () => setList([...list, { label: "Nowy próg", from_pct: Math.min(100, Math.max(...list.map((t) => t.from_pct), 0) + 10), tone: "pending" }]);
  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {list.map((t, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "10px 1fr 96px 128px 34px", gap: 9, alignItems: "center",
            padding: "7px 9px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 9,
          }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: tc(t.tone) }} />
            <input value={t.label} onChange={(e) => upd(i, { label: e.target.value })} placeholder="Etykieta"
                   style={{ ...inputStyle, border: "none", background: "transparent", padding: "4px 0", fontWeight: 550, minWidth: 0 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 10.5, color: "var(--text-lo)" }}>od</span>
              <input type="number" value={t.from_pct} disabled={i === 0} min={0} max={1000}
                     onChange={(e) => upd(i, { from_pct: Number(e.target.value) })}
                     className="num" style={{ ...inputStyle, width: 62, padding: "5px 7px", opacity: i === 0 ? 0.5 : 1 }} />
              <span style={{ fontSize: 10.5, color: "var(--text-lo)" }}>%</span>
            </div>
            <select value={t.tone} onChange={(e) => upd(i, { tone: e.target.value })} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12 }}>
              {TONES.map((x) => <option key={x} value={x}>{TONE_LABEL[x]}</option>)}
            </select>
            <button onClick={() => setList(list.filter((_, j) => j !== i))} disabled={i === 0}
                    title={i === 0 ? "Pierwszy próg musi zostać — łapie wszystko poniżej kolejnego" : "Usuń próg"}
                    style={{ ...btnGhost, padding: 6, justifyContent: "center", opacity: i === 0 ? 0.35 : 1, color: i === 0 ? "var(--text-lo)" : "var(--critical)" }}>
              <I.Close size={13} />
            </button>
          </div>
        ))}
      </div>
      <button onClick={add} style={{ ...btnGhost, marginTop: 9, borderStyle: "dashed" }}><I.Plus size={13} /> Dodaj próg</button>
      <div style={{ fontSize: 10.5, color: "var(--text-lo)", marginTop: 8, lineHeight: 1.5 }}>{hint}</div>
    </div>
  );
}

function ConfigPanel({ caps, thresholds, onSaved, onClose }: {
  caps: Record<string, number>; thresholds: Thresholds;
  onSaved: (caps: Record<string, number>, th: Thresholds) => void; onClose: () => void;
}) {
  const [c, setC] = useState<Record<string, number>>({ ...caps });
  const [prod, setProd] = useState<Threshold[]>(thresholds.product.map((t) => ({ ...t })));
  const [fill, setFill] = useState<Threshold[]>(thresholds.fill.map((t) => ({ ...t })));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const sorted = (l: Threshold[]) => [...l].sort((a, b) => a.from_pct - b.from_pct);
      const res = await api.put("/reports/occupancy/config", { caps: c, product: sorted(prod), fill: sorted(fill) });
      onSaved(res.caps, res.thresholds);
      toast("Zapisano pojemności i progi", "ok");
      onClose();
    } catch {
      toast("Nie udało się zapisać ustawień", "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <I.Settings size={16} />
          <span style={{ fontSize: 14, fontWeight: 650 }}>Pojemności i progi</span>
        </div>
        <button onClick={onClose} style={{ ...btnGhost, padding: 7 }}><I.Close size={14} /></button>
      </div>

      <section>
        <div style={{ ...labStyle, marginBottom: 4 }}>Pojemność hal</div>
        <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginBottom: 10 }}>Ile metrów sześciennych mieści się fizycznie w magazynie każdej firmy.</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {Object.keys(c).sort((a, b) => (a === "amh" ? -1 : b === "amh" ? 1 : a.localeCompare(b))).map((k) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 11px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 9 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: firmColor(k) }} />
              <span style={{ fontSize: 12.5, fontWeight: 550, minWidth: 48 }}>{k.toUpperCase()}</span>
              <input type="number" min={0} step={10} value={c[k]} onChange={(e) => setC({ ...c, [k]: Number(e.target.value) })}
                     className="num" style={{ ...inputStyle, width: 96, padding: "6px 8px" }} />
              <span style={{ fontSize: 10.5, color: "var(--text-lo)" }}>m³</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div style={{ ...labStyle, marginBottom: 4 }}>Progi udziału produktu</div>
        <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginBottom: 10 }}>Jaki procent hali może zajmować jeden SKU, zanim dostaniesz ostrzeżenie.</div>
        <ThresholdEditor list={prod} setList={setProd}
          hint="Produkt dostaje etykietę najwyższego progu, który przekroczył. Udział liczony zawsze względem hali, w której towar fizycznie stoi." />
      </section>

      <section>
        <div style={{ ...labStyle, marginBottom: 4 }}>Progi wypełnienia hali</div>
        <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginBottom: 10 }}>Etykieta całego magazynu — od luźnego do przepełnionego.</div>
        <ThresholdEditor list={fill} setList={setFill} hint="Powyżej 100% towar nie ma gdzie stanąć." />
      </section>

      <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={btnGhost}>Anuluj</button>
        <button onClick={save} disabled={busy} style={{ ...btnDark, opacity: busy ? 0.6 : 1 }}>{busy ? "Zapisuję…" : "Zapisz"}</button>
      </div>
    </Card>
  );
}

// ── widok główny ─────────────────────────────────────────────
const HORIZON_DEBOUNCE_MS = 350;

export default function OccupancyReport({ scope }: { scope: string }) {
  // Dwa stany celowo: `horizonInput` idzie za palcem (płynny suwak), `horizon` to
  // wartość, dla której faktycznie pytamy backend. Endpoint przelicza kontenery i stany
  // wszystkich firm, więc strzelanie nim przy każdym pikselu przeciągnięcia zabijało go
  // serią równoległych zapytań wyprzedzających się nawzajem.
  const [horizonInput, setHorizonInput] = useState(0);
  const [horizon, setHorizon] = useState(0);
  const [data, setData] = useState<OccData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [cfgOpen, setCfgOpen] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "over" | "nocbm">("all");
  const [sort, setSort] = useState<{ key: keyof OccRow; dir: "asc" | "desc" }>({ key: "volume_m3", dir: "desc" });

  useEffect(() => {
    if (horizonInput === horizon) return;
    const t = setTimeout(() => setHorizon(horizonInput), HORIZON_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [horizonInput, horizon]);

  // Numer żądania: odpowiedź z nieaktualnego zapytania jest ignorowana, więc wynik
  // sprzed przeciągnięcia nie nadpisze świeższego (ani nie wyrzuci błędu na wierzch).
  const reqRef = useRef(0);
  const load = useCallback(() => {
    const id = ++reqRef.current;
    setLoading(true);
    api.get(`/reports/occupancy?scope=${scope}&horizon=${horizon}`)
      .then((d: OccData) => { if (id === reqRef.current) { setData(d); setErr(""); } })
      .catch((e: { status?: number }) => {
        if (id !== reqRef.current) return;
        setErr(e?.status === 403 ? "Brak uprawnienia do tego raportu." : "Nie udało się pobrać danych zajętości.");
      })
      .finally(() => { if (id === reqRef.current) setLoading(false); });
  }, [scope, horizon]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    let out = data.rows.filter((r) => !s || r.sku.toLowerCase().includes(s) || (r.nazwa || "").toLowerCase().includes(s));
    if (filter === "over") out = out.filter((r) => r.over);
    if (filter === "nocbm") out = out.filter((r) => r.no_cbm);
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [data, q, filter, sort]);

  const head = (key: keyof OccRow, label: string, align: "left" | "right" = "right") => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }))}
        style={{ ...th, textAlign: align, color: sort.key === key ? "var(--text-hi)" : "var(--text-lo)" }}>
      {label}{sort.key === key ? (sort.dir === "desc" ? " ▼" : " ▲") : ""}
    </th>
  );

  if (loading && !data) return <Card style={{ padding: 28, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Liczę kubaturę…</Card>;
  if (err && !data) return <Card style={{ padding: 28, textAlign: "center", color: "var(--critical)", fontSize: 13 }}>{err}</Card>;
  if (!data) return null;

  // Data odcięcia liczona lokalnie z pozycji suwaka — nagłówek nadąża za palcem,
  // zanim wrócą policzone liczby.
  const cutoffLocal = (() => {
    const d = new Date(data.as_of + "T00:00:00");
    d.setDate(d.getDate() + horizonInput);
    return d.toISOString().slice(0, 10);
  })();
  const stale = loading || horizonInput !== horizon;

  const segments = (scope === "all" ? data.firms : data.firms.filter((f) => f.slug === scope))
    .map((f) => ({ key: f.slug, label: f.label, value: f.stock_m3, color: firmColor(f.slug) }));
  const overRows = data.rows.filter((r) => r.over).slice(0, 5);
  const freeElsewhere = (slug: string) => {
    const others = data.firms.filter((f) => f.slug !== slug && f.free_m3 > 5).sort((a, b) => b.free_m3 - a.free_m3);
    return others.length ? `wolne: ${others[0].label} ${m3(others[0].free_m3)} m³` : "brak wolnego miejsca w pozostałych halach";
  };
  const nextArrivals = data.timeline.filter((t) => t.date > data.cutoff).slice(0, 3);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* suwak horyzontu */}
      <Card style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={labStyle}>Stan na dzień</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginTop: 3, flexWrap: "wrap" }}>
              <span style={{ fontSize: 15, fontWeight: 650 }}>{horizonInput === 0 ? "dziś" : dayLabel(cutoffLocal)}</span>
              <span className="num" style={{ fontSize: 12, color: "var(--text-lo)" }}>
                {horizonInput === 0 ? "sam stan hali" : `+${horizonInput} dni · z dostawami, które do wtedy dojadą`}
              </span>
              {stale && <span style={{ fontSize: 11, color: "var(--accent)" }}>przeliczam…</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
            {HORIZON_PRESETS.map((h) => (
              <button key={h} onClick={() => setHorizonInput(h)} style={{
                ...btnGhost, padding: "6px 11px", fontSize: 12,
                background: horizonInput === h ? "var(--accent-soft)" : "var(--surface-1)",
                color: horizonInput === h ? "var(--accent)" : "var(--text-mid)",
                borderColor: horizonInput === h ? "var(--accent)" : "var(--border)",
              }}>{h === 0 ? "dziś" : `+${h} dni`}</button>
            ))}
            <button onClick={load} style={{ ...btnGhost, padding: 7 }} title="Przelicz"><I.Refresh size={14} /></button>
          </div>
        </div>
        <input type="range" min={0} max={90} step={1} value={horizonInput}
               onChange={(e) => setHorizonInput(Number(e.target.value))}
               style={{ width: "100%", accentColor: "var(--accent)" }} />
        {err && (
          <div style={{ fontSize: 11.5, color: "var(--critical)", display: "flex", alignItems: "center", gap: 7 }}>
            <I.Alert size={13} /> {err} Pokazane liczby są z poprzedniego przeliczenia.
          </div>
        )}
        {nextArrivals.length > 0 && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--text-lo)" }}>
            <span>Poza horyzontem:</span>
            {nextArrivals.map((t) => (
              <span key={t.container_number + t.date} className="num">
                {t.date} · {t.container_number} · {m3(t.m3)} m³
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* wypełnienie */}
      <Card style={{ padding: "18px 20px", opacity: stale ? 0.55 : 1, transition: "opacity .15s" }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span className="num" style={{ fontSize: 40, fontWeight: 650, letterSpacing: "-0.03em", lineHeight: 1, color: tc(data.fill_tone) }}>
              {pc(data.fill_pct)}
            </span>
            <div>
              <div className="num" style={{ fontSize: 13, color: "var(--text-mid)" }}>{m3(data.used_m3)} / {num(data.capacity_m3)} m³</div>
              <div style={{ marginTop: 4 }}>
                <Pill bg={tsoft(data.fill_tone)} fg={tc(data.fill_tone)} dot={tc(data.fill_tone)}>{data.fill_label}</Pill>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 15, flexWrap: "wrap" }}>
            {segments.map((s) => (
              <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-mid)" }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />
                {s.label} <span className="num" style={{ color: "var(--text-lo)" }}>{m3(s.value)} m³</span>
              </span>
            ))}
            {data.incoming_m3 > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-mid)" }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: "var(--surface-2)", backgroundImage: "repeating-linear-gradient(115deg, var(--text-lo) 0 2px, transparent 2px 5px)" }} />
                W drodze <span className="num" style={{ color: "var(--text-lo)" }}>{m3(data.incoming_m3)} m³</span>
              </span>
            )}
          </div>
        </div>
        <CapacityBar segments={segments} incoming={data.incoming_m3} capacity={data.capacity_m3} thresholds={data.thresholds.fill} />
        {data.free_m3 < 0 && (
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--critical)", display: "flex", alignItems: "center", gap: 7 }}>
            <I.Alert size={14} />
            {data.horizon_days === 0
              ? `Hala jest przepełniona o ${m3(-data.free_m3)} m³.`
              : `Do ${dayLabel(data.cutoff)} zabraknie ${m3(-data.free_m3)} m³ miejsca — towar z kontenerów nie zmieści się w hali.`}
          </div>
        )}
        {data.missing_cbm.sku_count > 0 && (
          <button onClick={() => { setFilter("nocbm"); setSort({ key: "qty", dir: "desc" }); }}
                  style={{ marginTop: 10, fontSize: 11.5, color: "var(--pending)", display: "flex", alignItems: "center", gap: 7,
                           background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
            <I.Alert size={13} />
            {num(data.missing_cbm.sku_count)} SKU bez wpisanego CBM ({num(data.missing_cbm.units)} szt.) — nie wchodzi do wyliczenia, więc realna zajętość jest wyższa. Pokaż listę ›
          </button>
        )}
      </Card>

      {/* KPI */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <Kpi label="Wypełnienie" value={pc(data.fill_pct)} sub={data.fill_label} tone={data.fill_tone} icon={<I.TrendUp size={15} />} />
        <Kpi label="Zajęte" value={`${m3(data.used_m3)} m³`} sub={data.horizon_days === 0 ? "towar w hali" : `w hali ${m3(data.stock_m3)} + w drodze ${m3(data.incoming_m3)}`} icon={<I.Box size={15} />} />
        <Kpi label={data.free_m3 < 0 ? "Brakuje miejsca" : "Wolne miejsce"} value={`${m3(Math.abs(data.free_m3))} m³`}
             sub={data.free_m3 < 0 ? "ponad pojemność hali" : "do zapełnienia"} tone={data.free_m3 < 0 ? "critical" : "ok"} icon={<I.Ship size={15} />} />
        <Kpi label={`Nad progiem ${data.over_threshold_pct}%`} value={num(data.over_count)}
             sub={data.over_count ? `SKU z etykietą „${data.over_threshold_label}”` : "żaden SKU nie dominuje"}
             tone={data.over_count ? "critical" : "ok"} icon={<I.Alert size={15} />} />
      </div>

      {/* alert */}
      {overRows.length > 0 && (
        <Card>
          <div style={{ padding: "13px 18px", display: "flex", gap: 12, alignItems: "flex-start", background: "var(--critical-soft)" }}>
            <span style={{ color: "var(--critical)", marginTop: 1 }}><I.Alert size={16} /></span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 650 }}>
                {data.over_count === 1 ? "1 produkt zajmuje" : `${data.over_count} produkty zajmują`} ponad {data.over_threshold_pct}% swojej hali
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-mid)", marginTop: 2 }}>
                Tyle miejsca na jednym SKU blokuje przyjęcia z kontenerów. Zjedź z zamówieniem albo rozłóż zapas między firmy.
              </div>
            </div>
          </div>
          {overRows.map((r) => (
            <div key={r.sku + r.firma_slug} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 18px", borderTop: "1px solid var(--surface-3)", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--text-mid)", minWidth: 104 }}>{r.sku}</span>
              <span style={{ fontSize: 12.5, flex: "1 1 160px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.nazwa || "—"}</span>
              <Pill bg="var(--surface-2)" fg={firmColor(r.firma_slug)} size="sm">{r.firma_slug.toUpperCase()}</Pill>
              <span className="num" style={{ fontSize: 12, color: "var(--text-mid)" }}>{m3(r.volume_m3)} m³</span>
              <span className="num" style={{ fontSize: 12.5, fontWeight: 700, color: tc(r.threshold_tone), minWidth: 52, textAlign: "right" }}>{pc(r.share_firm_pct)}</span>
              <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{freeElsewhere(r.firma_slug)}</span>
            </div>
          ))}
          {data.over_count > overRows.length && (
            <button onClick={() => { setFilter("over"); setSort({ key: "share_firm_pct", dir: "desc" }); }}
                    style={{ ...btnGhost, border: "none", borderTop: "1px solid var(--surface-3)", borderRadius: 0, width: "100%", justifyContent: "flex-start", padding: "10px 18px" }}>
              Pokaż pozostałe {data.over_count - overRows.length} w tabeli <I.ChevronR size={12} />
            </button>
          )}
        </Card>
      )}

      {/* karty firm */}
      {scope === "all" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12 }}>
          {data.firms.map((f) => (
            <Card key={f.slug} style={{ padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 650 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: firmColor(f.slug) }} />
                  {f.label}
                  <span className="num" style={{ fontSize: 10.5, color: "var(--text-lo)", fontWeight: 500 }}>{f.sku_count} SKU</span>
                </span>
                <Pill bg={tsoft(f.threshold_tone)} fg={tc(f.threshold_tone)} size="sm">{f.threshold_label}</Pill>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                <span className="num" style={{ fontSize: 22, fontWeight: 650, color: tc(f.threshold_tone), lineHeight: 1 }}>{pc(f.fill_pct)}</span>
                <span className="num" style={{ fontSize: 11.5, color: "var(--text-lo)" }}>{m3(f.used_m3)} / {num(f.capacity_m3)} m³</span>
              </div>
              <CapacityBar segments={[{ key: f.slug, label: f.label, value: f.stock_m3, color: firmColor(f.slug) }]}
                           incoming={f.incoming_m3} capacity={f.capacity_m3} thresholds={data.thresholds.fill} height={11} ticks={false} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 11 }}>
                <span style={{ color: "var(--text-lo)" }}>
                  {f.free_m3 >= 0 ? "Wolne " : "Brakuje "}
                  <span className="num" style={{ color: f.free_m3 >= 0 ? "var(--ok)" : "var(--critical)", fontWeight: 650 }}>{m3(Math.abs(f.free_m3))} m³</span>
                </span>
                <span style={{ color: f.over_count ? "var(--critical)" : f.no_cbm_count ? "var(--pending)" : "var(--text-lo)" }}>
                  {f.over_count ? `${f.over_count} SKU nad progiem` : f.no_cbm_count ? `${f.no_cbm_count} SKU bez CBM` : "brak SKU nad progiem"}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ustawienia */}
      {cfgOpen ? (
        <ConfigPanel caps={data.caps} thresholds={data.thresholds}
                     onSaved={() => load()} onClose={() => setCfgOpen(false)} />
      ) : (
        <button onClick={() => setCfgOpen(true)} style={{ ...btnGhost, alignSelf: "flex-start" }}>
          <I.Settings size={14} /> Pojemności i progi
        </button>
      )}

      {/* tabela */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border-soft)", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, ...inputStyle, padding: "6px 10px", flex: "1 1 220px", maxWidth: 320 }}>
            <I.Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj SKU lub nazwy…"
                   style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--text-hi)", fontSize: 13, fontFamily: "inherit" }} />
          </div>
          <button onClick={() => setFilter(filter === "over" ? "all" : "over")} style={{
            ...btnGhost, padding: "7px 12px",
            background: filter === "over" ? "var(--critical-soft)" : "var(--surface-1)",
            color: filter === "over" ? "var(--critical)" : "var(--text-mid)",
            borderColor: filter === "over" ? "var(--critical)" : "var(--border)",
          }}>Nad progiem ({data.over_count})</button>
          {data.missing_cbm.sku_count > 0 && (
            <button onClick={() => setFilter(filter === "nocbm" ? "all" : "nocbm")} style={{
              ...btnGhost, padding: "7px 12px",
              background: filter === "nocbm" ? "var(--pending-soft)" : "var(--surface-1)",
              color: filter === "nocbm" ? "var(--pending)" : "var(--text-mid)",
              borderColor: filter === "nocbm" ? "var(--pending)" : "var(--border)",
            }}>Bez CBM ({data.missing_cbm.sku_count})</button>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
            {visible.length} z {data.rows.length} SKU · razem <span className="num">{m3(visible.reduce((a, r) => a + r.volume_m3, 0))} m³</span>
          </span>
        </div>
        <div style={{ overflowX: "auto", maxHeight: 560, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
            <thead>
              <tr>
                {head("sku", "SKU", "left")}
                {head("nazwa", "Nazwa", "left")}
                {scope === "all" && head("firma_slug", "Hala", "left")}
                {head("cbm_per_unit", "m³ / szt")}
                {head("stock_qty", "Na stanie")}
                {head("incoming_qty", "W drodze")}
                {head("volume_m3", "Objętość m³")}
                {head("share_firm_pct", scope === "all" ? "% hali" : "% magazynu")}
                {scope === "all" && head("share_scope_pct", "% całości")}
                <th style={{ ...th, textAlign: "left", cursor: "default" }}>Próg</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.sku + r.firma_slug}
                    style={r.over ? { background: "var(--critical-soft)" } : r.no_cbm ? { background: "var(--pending-soft)" } : undefined}>
                  <td style={{ ...td, textAlign: "left" }}><span className="mono" style={{ fontSize: 11.5, color: "var(--text-mid)" }}>{r.sku}</span></td>
                  <td style={{ ...td, textAlign: "left", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{r.nazwa || "—"}</td>
                  {scope === "all" && (
                    <td style={{ ...td, textAlign: "left" }}>
                      <Pill bg="var(--surface-2)" fg={firmColor(r.firma_slug)} size="sm">{r.firma_slug.toUpperCase()}</Pill>
                    </td>
                  )}
                  <td className="num" style={{ ...td, textAlign: "right", color: r.no_cbm ? "var(--pending)" : "var(--text-mid)" }}>
                    {r.no_cbm ? "brak" : r.cbm_per_unit.toFixed(3).replace(".", ",")}
                  </td>
                  <td className="num" style={{ ...td, textAlign: "right" }}>{num(r.stock_qty)}</td>
                  <td className="num" style={{ ...td, textAlign: "right", color: r.incoming_qty ? "var(--text-mid)" : "var(--text-lo)" }}>{r.incoming_qty ? num(r.incoming_qty) : "—"}</td>
                  <td className="num" style={{ ...td, textAlign: "right", fontWeight: 650, color: r.no_cbm ? "var(--text-lo)" : "var(--text-hi)" }}>
                    {r.no_cbm ? "—" : m3(r.volume_m3)}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                      <span style={{ width: 56, height: 5, background: "var(--surface-3)", borderRadius: 99, overflow: "hidden" }}>
                        <span style={{ display: "block", width: `${Math.min(100, (r.share_firm_pct / Math.max(data.over_threshold_pct * 1.6, 1)) * 100)}%`, height: "100%", background: tc(r.threshold_tone) }} />
                      </span>
                      <span className="num" style={{ fontWeight: 650, color: tc(r.threshold_tone), minWidth: 46 }}>{r.no_cbm ? "—" : pc(r.share_firm_pct)}</span>
                    </span>
                  </td>
                  {scope === "all" && <td className="num" style={{ ...td, textAlign: "right", color: "var(--text-lo)" }}>{r.no_cbm ? "—" : pc(r.share_scope_pct)}</td>}
                  <td style={{ ...td, textAlign: "left" }}>
                    <Pill bg={tsoft(r.threshold_tone)} fg={tc(r.threshold_tone)} size="sm">{r.threshold_label}</Pill>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={scope === "all" ? 10 : 8} style={{ padding: "36px 16px", textAlign: "center", color: "var(--text-lo)", fontSize: 12.5 }}>
                  Brak SKU spełniających filtr. Wyczyść szukanie albo przełącz filtr.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ fontSize: 11, color: "var(--text-lo)" }}>
        Liczone na żywo{data.generated_at ? ` · ${data.generated_at}` : ""}. Na stanie = magazyn główny.
        W drodze = kontenery z datą wejścia na magazyn do {dayLabel(data.cutoff)} (potwierdzona dostawa → umówiony odbiór → ETA + 7 dni odprawy).
      </div>
    </div>
  );
}
