"use client";
// ============================================================
// MAGAZYN — Cashflow (etap 5). Rejestr płatności za kontenery.
//   Dwie zakładki, identyczny układ (KPI → pasek per producent →
//   słupki miesięczne → drilldown), różni je tylko zbiór danych i oś czasu:
//     • Do zapłaty — kwota pozostała (bez daty ≤ dziś), bucket po miesiącu ETA.
//       PLN otwarte = szacunek po kursie „dziś" (oznaczone „≈").
//     • Zapłacono — wpłaty z datą ≤ dziś, bucket po miesiącu PŁATNOŚCI (realny wypływ).
//       PLN = kurs historyczny NBP (zablokowany, bez „≈").
//   Pasek sklepu (Wszystkie/AMH/Acti/Veluxa) + przełącznik waluty (PLN/USD/CNY).
//   Źródło: GET /api/cashflow/ledger (płaska lista zdarzeń + rate_today).
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, Card, CardHeader, MfrChip } from "./ui";
import { MiniStat } from "./containers-ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { useUser, isAdmin } from "@/lib/permissions";

// ── Typy ─────────────────────────────────────────────────────
type Status = "paid" | "plan" | "open";
// Opłacona zaliczka doklejana do balansu tego samego lotu/kontenera (kontekst w „Do zapłaty").
type AdvCtx = { kwota: number; waluta: string; data: string | null; kwota_pln: number | null };
type LedgerEvent = {
  id: number;
  kontener: string; po: string | null;
  mfr_id: number | null; mfr_name: string; mfr_color: string;
  shop: string; shop_name: string;
  eta: string | null;
  typ: "zaliczka" | "balance";
  kwota: number; waluta: string;
  data: string | null;
  termin: string | null;              // planowany termin płatności (bucket „Do zapłaty")
  status: Status;
  kwota_pln: number | null;
  brak_kursu: boolean;
  zaliczki_oplacone?: AdvCtx[];        // opłacone zaliczki tego kontenera (tylko dla balansu)
};
type LedgerResp = { as_of: string; rate_today: Record<string, number>; events: LedgerEvent[] };

type MfrAgg = { id: string; name: string; color: string; value: number };
type Bucket = { key: string; label: string; short: string; total: number; byMfr: Record<string, number>; items: LedgerEvent[]; noDate?: boolean };
type Agg = { months: Bucket[]; peak: Bucket | null; mfrs: MfrAgg[]; total: number; maxTotal: number; count: number };

// ── Stałe ────────────────────────────────────────────────────
const SHOPS: [string, string][] = [["amh", "AMH"], ["acti", "Acti"], ["veluxa", "Veluxa"], ["", "Wszystkie"]];
const CURS: string[] = ["PLN", "USD", "CNY"];
const CUR_SYM: Record<string, string> = { PLN: "zł", USD: "$", CNY: "¥" };
const MONTH_SHORT = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];

// ── Formatery ────────────────────────────────────────────────
const fmtCur = (n: number, cur: string) => {
  const v = Math.round(n || 0);
  const s = new Intl.NumberFormat("pl-PL").format(v);
  return cur === "PLN" ? `${s} zł` : `${CUR_SYM[cur] || ""}${s}`;
};
const fmtCurK = (n: number, cur: string) => {
  const v = (n || 0) / 1000;
  const s = (Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(".0", "")).replace(".", ",");
  return cur === "PLN" ? `${s}k zł` : `${CUR_SYM[cur] || ""}${s}k`;
};
const parseLocal = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDay = (s: string) => parseLocal(s).toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" });

// PLN zdarzenia: paid ma kurs historyczny (kwota_pln); reszta = szacunek po kursie „dziś".
const plnOf = (e: LedgerEvent, rt: Record<string, number>) =>
  e.kwota_pln != null ? e.kwota_pln : e.kwota * (rt[e.waluta] ?? 0);

// Wartość zdarzenia w wybranej walucie widoku:
//   PLN → przeliczone/szacowane; USD/CNY → oryginał tylko dla zdarzeń tej waluty (inaczej null).
const dispVal = (e: LedgerEvent, cur: string, rt: Record<string, number>): number | null =>
  cur === "PLN" ? plnOf(e, rt) : (e.waluta === cur ? e.kwota : null);

// Kwota opłaconej zaliczki w walucie widoku: PLN → kurs historyczny (fallback: oryginał
// gdy brak notowania NBP); USD/CNY → zawsze oryginał (zaliczka bywa w innej walucie niż widok).
const zaliczkaAmount = (z: AdvCtx, cur: string): string =>
  cur === "PLN"
    ? (z.kwota_pln != null ? fmtCur(z.kwota_pln, "PLN") : fmtCur(z.kwota, z.waluta))
    : fmtCur(z.kwota, z.waluta);

// Klucz koszyka „Bez terminu" — sortuje się przed każdym miesiącem (YYYY-MM), więc ląduje na górze.
const NO_TERM_KEY = "0000-00";

// Agregacja wspólna dla obu zakładek.
//   monthField: pole daty do bucketowania — "eta" | "data" (zapłacono) | "termin" (do zapłaty).
//   noDateBucket: gdy true, zdarzenia bez daty trafiają do koszyka „Bez terminu" na górze,
//                 zamiast wypadać z zestawienia (używane w „Do zapłaty").
function aggregate(events: LedgerEvent[], cur: string, rt: Record<string, number>, monthField: "eta" | "data" | "termin", noDateBucket = false): Agg {
  const monthsMap: Record<string, Bucket> = {};
  const perMfr: Record<string, MfrAgg> = {};
  let total = 0, count = 0;
  events.forEach(e => {
    const val = dispVal(e, cur, rt);
    if (val == null) return;
    const ds = monthField === "eta" ? e.eta : monthField === "data" ? e.data : e.termin;
    if (!ds && !noDateBucket) return;
    count++;
    const key = ds ? ds.slice(0, 7) : NO_TERM_KEY;
    let m = monthsMap[key];
    if (!m) {
      if (ds) {
        const d = parseLocal(ds);
        m = { key, label: `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`, short: MONTH_SHORT[d.getMonth()], total: 0, byMfr: {}, items: [] };
      } else {
        m = { key, label: "Bez terminu", short: "—", total: 0, byMfr: {}, items: [], noDate: true };
      }
      monthsMap[key] = m;
    }
    m.total += val; m.items.push(e);
    const mk = String(e.mfr_id ?? e.mfr_name);
    m.byMfr[mk] = (m.byMfr[mk] || 0) + val;
    const a = (perMfr[mk] = perMfr[mk] || { id: mk, name: e.mfr_name, color: e.mfr_color, value: 0 });
    a.value += val; total += val;
  });
  const months = Object.values(monthsMap).sort((a, b) => (a.key < b.key ? -1 : 1));
  // Największy „miesiąc" liczymy tylko z realnych miesięcy — koszyk bez terminu pomijamy.
  const peak = months.reduce<Bucket | null>((p, m) => (!m.noDate && m.total > (p?.total || 0) ? m : p), null);
  const mfrs = Object.values(perMfr).sort((a, b) => b.value - a.value);
  return { months, peak, mfrs, total, maxTotal: Math.max(...months.map(m => m.total), 1), count };
}

// ── Widok główny ─────────────────────────────────────────────
function CashflowView({ onContainerClick }: { onContainerClick?: (id: number) => void }) {
  const user = useUser();
  const [resp, setResp] = useState<LedgerResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [refilling, setRefilling] = useState(false);
  const [tab, setTab] = useState<"due" | "paid">("due");
  const [shop, setShop] = useState("amh");
  const [cur, setCur] = useState("PLN");
  const [year, setYear] = useState("2026");
  const [hoveredMfr, setHoveredMfr] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await api.get("/cashflow/ledger");
      setResp(data as LedgerResp);
    } catch {
      setResp({ as_of: "", rate_today: {}, events: [] });
      toast("Nie udało się pobrać płatności", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Dociągnięcie brakujących kursów NBP (ADMIN). Endpoint bierze waluty z danych
  // (zaliczki + balance), więc łapie USD/CNY nawet bez ustawionej listy walut.
  const refillRates = async () => {
    if (refilling) return;
    setRefilling(true);
    try {
      const r = (await api.post("/admin/fx/refill", {})) as { inserted?: number; errors?: unknown[] };
      const errs = (r?.errors ?? []).length;
      if (errs > 0) toast("NBP nie odpowiedziało dla części walut — spróbuj za chwilę", "warning");
      else toast(r?.inserted ? `Dociągnięto ${r.inserted} kursów NBP` : "Brak nowych kursów do pobrania", "ok");
      await load();
    } catch {
      toast("Nie udało się dociągnąć kursów", "error");
    } finally {
      setRefilling(false);
    }
  };

  const events = resp?.events ?? [];
  const rt = resp?.rate_today ?? {};
  const missingCount = events.filter(e => e.brak_kursu).length;
  const showRefill = isAdmin(user) && missingCount > 0;
  const scoped = useMemo(() => events.filter(e => !shop || e.shop === shop), [events, shop]);
  const yearOpts = useMemo<[string, string][]>(() => {
    const ys = new Set<string>();
    events.forEach(e => { if (e.eta) ys.add(e.eta.slice(0, 4)); if (e.data) ys.add(e.data.slice(0, 4)); if (e.termin) ys.add(e.termin.slice(0, 4)); });
    return [["all", "Wszystkie"], ...[...ys].sort().map(y => [y, y] as [string, string])];
  }, [events]);
  useEffect(() => {
    if (loading) return;                     // dane jeszcze się ładują — nie kasuj domyślnego roku (2026)
    if (year !== "all" && !yearOpts.some(([v]) => v === year)) setYear("all");
  }, [loading, yearOpts, year]);

  if (loading) {
    return <div className="fade-in" style={{ padding: 48, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Ładowanie…</div>;
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 80 }}>
      {/* Nagłówek + zakładki */}
      <div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650, display: "flex", alignItems: "center", gap: 9 }}>
          <I.Wallet size={20} /> Cashflow
        </h1>
        <div style={{ color: "var(--text-lo)", fontSize: 12, marginTop: 4 }}>
          Płatności za kontenery — zaliczki i balance, per producent, z podziałem na sklepy.
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
          <TabBtn active={tab === "due"} onClick={() => setTab("due")} icon={<I.Alert size={14} />}>Do zapłaty</TabBtn>
          <TabBtn active={tab === "paid"} onClick={() => setTab("paid")} icon={<I.Customs size={14} />}>Zapłacono</TabBtn>
        </div>
      </div>

      {/* Filtry: sklep + rok + waluta */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <Seg label="" options={SHOPS} value={shop} onChange={setShop} />
          {yearOpts.length > 1 && <Seg label="Rok" options={yearOpts} value={year} onChange={setYear} />}
        </div>
        <Seg label="Waluta" options={CURS.map(c => [c, c] as [string, string])} value={cur} onChange={setCur} />
      </div>

      {showRefill && (
        <button onClick={refillRates} disabled={refilling} style={{
          display: "flex", alignItems: "center", gap: 7, width: "100%",
          padding: "8px 12px", borderRadius: 8, cursor: refilling ? "default" : "pointer", textAlign: "left",
          background: "color-mix(in oklch, var(--warning) 10%, transparent)",
          border: "1px solid color-mix(in oklch, var(--warning) 35%, transparent)",
          color: "var(--warning)", fontSize: 11.5, fontWeight: 600, opacity: refilling ? 0.6 : 1,
        }}>
          <I.Alert size={13} />
          {refilling
            ? "Dociągam brakujące kursy z NBP…"
            : `${missingCount} ${missingCount === 1 ? "płatność" : "płatności"} bez kursu NBP — kwoty niepełne. Kliknij, żeby dociągnąć z NBP.`}
        </button>
      )}

      {tab === "due"
        ? <DueTab events={scoped} cur={cur} rt={rt} shop={shop} year={year} hoveredMfr={hoveredMfr} setHoveredMfr={setHoveredMfr} onContainerClick={onContainerClick} />
        : <PaidTab events={scoped} cur={cur} rt={rt} shop={shop} year={year} hoveredMfr={hoveredMfr} setHoveredMfr={setHoveredMfr} onContainerClick={onContainerClick} />}

      {/* Nota kontekstowa */}
      <div style={noteStyle}>
        {tab === "due"
          ? <><b>Do zapłaty</b> — otwarte zaliczki i balance, per producent, bucket po <b>terminie płatności</b> (płatności bez wpisanego terminu lądują w koszyku „Bez terminu" na górze). Przy balansie pokazujemy już <b>opłaconą zaliczkę</b> tego kontenera (ile i kiedy). W PLN kwoty otwarte są <b>szacunkiem</b> po dzisiejszym kursie (oznaczone „≈"). W trybie USD/CNY pokazujemy oryginalne kwoty faktur tylko dla zdarzeń danej waluty.</>
          : <><b>Zapłacono</b> — wpłaty z datą ≤ dziś, per producent, bucket po miesiącu faktycznej płatności (realny wypływ kasy). Przy balansie pokazujemy też <b>opłaconą zaliczkę</b> tego kontenera (kiedy i ile) — zaliczki są dodatkowo rozpisane jako osobne pozycje. <b>PLN</b> = kurs historyczny NBP z dnia płatności (zablokowany, dokładny). <b>USD / CNY</b> = oryginalne kwoty faktur, tylko zdarzenia danej waluty (+ PLN w podpisie). Dostawa ≠ zapłata — dostarczony kontener z nieopłaconym balance siedzi w „Do zapłaty".</>}
      </div>
    </div>
  );
}

// ── ZAKŁADKA: DO ZAPŁATY (bucket po terminie płatności) ──────
function DueTab({ events, cur, rt, shop, year, hoveredMfr, setHoveredMfr, onContainerClick }: TabProps) {
  // Otwarte (niezapłacone) zdarzenia. Filtr roku po terminie; pozycje bez terminu pokazujemy
  // zawsze (nie mają roku, a to przypomnienie o nieumówionej płatności).
  const open = useMemo(() => events.filter(e =>
    e.status !== "paid" && (year === "all" || !e.termin || e.termin.slice(0, 4) === year)), [events, year]);
  const agg = useMemo(() => aggregate(open, cur, rt, "termin", true), [open, cur, rt]);
  const next30 = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d30 = new Date(today); d30.setDate(d30.getDate() + 30);
    return open.reduce((s, e) => {
      const v = dispVal(e, cur, rt); if (v == null || !e.termin) return s;
      const d = parseLocal(e.termin); return (d >= today && d <= d30) ? s + v : s;
    }, 0);
  }, [open, cur, rt]);

  return (
    <>
      <KpiRow
        a={{ label: "Suma do zapłaty", value: fmtCur(agg.total, cur), sub: `${agg.count} płatności otwartych`, icon: <I.Wallet size={14} /> }}
        b={{ label: "Najbliższe 30 dni", value: fmtCur(next30, cur), sub: "wg terminu płatności", icon: <I.Alert size={14} /> }}
        c={{ label: "Największy miesiąc", value: agg.peak ? fmtCur(agg.peak.total, cur) : "—", sub: agg.peak?.label || "—", icon: <I.TrendUp size={14} /> }}
        d={{ label: "Otwarte pozycje", value: String(agg.count), sub: `${agg.months.length} okresów`, icon: <I.Activity size={14} /> }}
      />
      <BucketBody agg={agg} cur={cur} rt={rt} shop={shop} hoveredMfr={hoveredMfr} setHoveredMfr={setHoveredMfr} onContainerClick={onContainerClick}
        titles={{
          breakdown: "Pozostało do zapłaty wg producenta",
          barsTitle: "Pozostało do zapłaty — wg terminu płatności", barsHint: "kwota jeszcze niezapłacona",
          drillTitle: "Szczegóły — otwarte płatności", drillHint: "kliknij miesiąc",
          empty: "Brak otwartych płatności dla tego wyboru.",
        }} />
    </>
  );
}

// ── ZAKŁADKA: ZAPŁACONO (bucket po dacie płatności) ──────────
function PaidTab({ events, cur, rt, shop, year, hoveredMfr, setHoveredMfr, onContainerClick }: TabProps) {
  const paid = useMemo(() => events.filter(e =>
    e.status === "paid" && (year === "all" || (!!e.data && e.data.slice(0, 4) === year))), [events, year]);
  const agg = useMemo(() => aggregate(paid, cur, rt, "data"), [paid, cur, rt]);
  const last30 = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dm30 = new Date(today); dm30.setDate(dm30.getDate() - 30);
    return paid.reduce((s, e) => {
      const v = dispVal(e, cur, rt); if (v == null || !e.data) return s;
      const d = parseLocal(e.data); return (d >= dm30 && d <= today) ? s + v : s;
    }, 0);
  }, [paid, cur, rt]);

  return (
    <>
      <KpiRow
        a={{ label: "Suma zapłacona", value: fmtCur(agg.total, cur), sub: cur === "PLN" ? "kurs historyczny NBP" : "kwoty oryginalne faktur", icon: <I.Wallet size={14} /> }}
        b={{ label: "Ostatnie 30 dni", value: fmtCur(last30, cur), sub: "wg daty płatności", icon: <I.Activity size={14} /> }}
        c={{ label: "Największy miesiąc", value: agg.peak ? fmtCur(agg.peak.total, cur) : "—", sub: agg.peak?.label || "—", icon: <I.TrendUp size={14} /> }}
        d={{ label: "Liczba płatności", value: String(agg.count), sub: `${agg.mfrs.length} producentów`, icon: <I.Factory size={14} /> }}
      />
      <BucketBody agg={agg} cur={cur} rt={rt} shop={shop} hoveredMfr={hoveredMfr} setHoveredMfr={setHoveredMfr} onContainerClick={onContainerClick}
        titles={{
          breakdown: "Zapłacone wg producenta",
          barsTitle: "Zapłacone — wg miesiąca płatności", barsHint: "kwota faktycznie wypłacona",
          drillTitle: "Szczegóły — płatności", drillHint: "kliknij miesiąc",
          empty: `Brak zapłaconych płatności ${cur !== "PLN" ? `w walucie ${cur}` : ""} dla tego wyboru.`,
        }} />
    </>
  );
}

// ── Wspólne ciało zakładki: pasek per producent + słupki + drilldown ──
type Titles = { breakdown: string; barsTitle: string; barsHint: string; drillTitle: string; drillHint: string; empty: string };
function BucketBody({ agg, cur, rt, shop, hoveredMfr, setHoveredMfr, onContainerClick, titles }: {
  agg: Agg; cur: string; rt: Record<string, number>; shop: string;
  hoveredMfr: string | null; setHoveredMfr: (v: string | null) => void; onContainerClick?: (id: number) => void; titles: Titles;
}) {
  const colorOf = (mk: string) => agg.mfrs.find(m => m.id === mk)?.color || "var(--text-lo)";
  const nameOf = (mk: string) => agg.mfrs.find(m => m.id === mk)?.name || "—";
  // Słupki to oś czasu — koszyk „Bez terminu" tam nie pasuje, więc go pomijamy (zostaje w liście niżej).
  const barMonths = agg.months.filter(m => !m.noDate);

  return (
    <>
      <Card>
        <CardHeader icon={<I.Factory size={14} />} title={titles.breakdown} hint="kolory jak w słupkach niżej" />
        <div style={{ padding: "14px 18px" }}>
          <MfrBreakdown mfrs={agg.mfrs} total={agg.total} cur={cur} hovered={hoveredMfr} setHovered={setHoveredMfr} />
        </div>
      </Card>

      <Card>
        <CardHeader icon={<I.Calendar size={14} />} title={titles.barsTitle} hint={titles.barsHint} />
        {barMonths.length === 0
          ? <div style={emptyStyle}>{titles.empty}</div>
          : <div style={{ padding: "14px 4px 14px 0" }}>
            <MonthBars months={barMonths} maxTotal={agg.maxTotal} cur={cur} hoveredMfr={hoveredMfr} colorOf={colorOf} nameOf={nameOf} />
          </div>}
      </Card>

      {agg.months.length > 0 && (
        <Card>
          <CardHeader icon={<I.Box size={14} />} title={titles.drillTitle} hint={titles.drillHint} />
          <div>
            {agg.months.map((m, i) => (
              <MonthRow key={m.key} month={m} maxTotal={agg.maxTotal} cur={cur} rt={rt} shop={shop}
                hoveredMfr={hoveredMfr} colorOf={colorOf} nameOf={nameOf}
                isLast={i === agg.months.length - 1} onContainerClick={onContainerClick} />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function MonthRow({ month: m, maxTotal, cur, rt, shop, hoveredMfr, colorOf, nameOf, isLast, onContainerClick }: {
  month: Bucket; maxTotal: number; cur: string; rt: Record<string, number>; shop: string;
  hoveredMfr: string | null; colorOf: (k: string) => string; nameOf: (k: string) => string;
  isLast: boolean; onContainerClick?: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const segs = Object.entries(m.byMfr).sort((a, b) => b[1] - a[1]);
  // „Zapłacono" ma datę → sortuje po niej; „Do zapłaty" jej nie ma → sortuje po terminie.
  const sortKey = (e: LedgerEvent) => e.data || e.termin || "9999";
  const items = [...m.items].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--border-soft)" }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", cursor: "pointer" }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
        <span style={{ color: "var(--text-lo)", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.18s", flexShrink: 0 }}><I.ChevronR size={14} /></span>
        <div style={{ width: 100, flexShrink: 0, fontSize: 13, fontWeight: 600 }}>{m.label}</div>
        <div style={{ flex: 1, minWidth: 0, height: 16, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden", display: "flex" }}>
          {segs.map(([mk, v]) => (
            <div key={mk} title={`${nameOf(mk)}: ${fmtCur(v, cur)}`} style={{
              width: `${(v / maxTotal) * 100}%`, background: colorOf(mk),
              opacity: hoveredMfr != null && hoveredMfr !== mk ? 0.25 : 1, transition: "opacity 0.16s",
            }} />
          ))}
        </div>
        <div style={{ textAlign: "right", minWidth: 120, flexShrink: 0 }}>
          <div className="num" style={{ fontSize: 14, fontWeight: 600 }}>{fmtCur(m.total, cur)}</div>
          <div style={{ fontSize: 11, color: "var(--text-lo)" }}>{m.items.length} płatności</div>
        </div>
      </div>
      {open && (
        <div className="fade-in" style={{ background: "var(--bg-elevated)", padding: "6px 18px 14px 44px", display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((e, k) => <PayRow key={k} e={e} cur={cur} rt={rt} shop={shop} onContainerClick={onContainerClick} />)}
        </div>
      )}
    </div>
  );
}

// ── Wiersz płatności ─────────────────────────────────────────
function PayRow({ e, cur, rt, shop, onContainerClick }: {
  e: LedgerEvent; cur: string; rt: Record<string, number>; shop: string; onContainerClick?: (id: number) => void;
}) {
  const est = e.status !== "paid";
  // W „Do zapłaty" pozycja ma tylko termin (brak faktycznej daty) — pokazujemy termin jako datę płatności.
  const dateTxt = e.data ? fmtDay(e.data) : (e.termin ? fmtDay(e.termin) : "bez terminu");
  const dateColor = e.status === "plan" ? "var(--warning)" : ((e.data || e.termin) ? "var(--text-mid)" : "var(--text-lo)");
  const isZal = e.typ === "zaliczka";
  // Opłacone zaliczki tego kontenera — kontekst przy balansie w obu zakładkach
  // („Do zapłaty" i „Zapłacono"): informacyjnie, ile i kiedy już wpłacono.
  const zaliczki = e.typ === "balance" ? (e.zaliczki_oplacone || []) : [];
  // Numer roboczy (Draft-…)/pusty nie pokazujemy — spójnie z kartami kontenerów.
  const nr = e.kontener && !/^draft-/i.test(e.kontener) ? e.kontener : null;
  const amount = cur === "PLN"
    ? `${est ? "≈ " : ""}${fmtCur(plnOf(e, rt), "PLN")}`
    : fmtCur(e.kwota, e.waluta);

  return (
    <div onClick={() => onContainerClick?.(e.id)} style={{
      display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto auto auto", gap: 12, alignItems: "center",
      padding: "8px 12px", background: "var(--surface-1)", border: "1px solid var(--border-soft)",
      borderRadius: 7, cursor: onContainerClick ? "pointer" : "default",
    }}
      onMouseEnter={ev => (ev.currentTarget.style.borderColor = "var(--border)")}
      onMouseLeave={ev => (ev.currentTarget.style.borderColor = "var(--border-soft)")}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {/* Producent — pierwszy plan (przed nr kontenera i FV) */}
        {e.mfr_name
          ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: e.mfr_color || "var(--text-lo)", flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.mfr_name}</span>
            </span>
          )
          : (nr && <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>#{nr}</span>)}
        {/* nr kontenera — pomniejszony do rozmiaru FV (tylko gdy jest producent i prawdziwy numer) */}
        {e.mfr_name && nr && <span className="mono" style={{ fontSize: 10, color: "var(--text-lo)" }}>#{nr}</span>}
        {e.po && <span className="mono" style={{ fontSize: 10, color: "var(--text-lo)" }}>{e.po}</span>}
        {!shop && <span style={firmaTag}>{e.shop_name}</span>}
        {zaliczki.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto", paddingLeft: 8, flexShrink: 0 }}>
            {zaliczki.map((z, zi) => (
              <span key={zi} title={`Zaliczka opłacona${z.data ? ` — ${fmtDay(z.data)}` : ""}`} style={{
                display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 9px", borderRadius: 99,
                fontSize: 11, whiteSpace: "nowrap", background: "var(--info-soft)", color: "var(--info)",
                border: "1px solid color-mix(in oklch, var(--info) 22%, transparent)",
              }}>
                <I.Customs size={11} />
                <span style={{ fontWeight: 600 }}>Zaliczka</span>
                <span className="num">{zaliczkaAmount(z, cur)}</span>
                {z.data && <span className="num" style={{ opacity: 0.65 }}>· {fmtDay(z.data)}</span>}
              </span>
            ))}
          </span>
        )}
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, letterSpacing: "0.03em", whiteSpace: "nowrap",
        background: isZal ? "var(--info-soft)" : "var(--accent-soft)", color: isZal ? "var(--info)" : "var(--accent)" }}>
        {isZal ? "ZALICZKA" : "BALANCE"}
      </span>
      <span style={{ fontSize: 12, color: dateColor, whiteSpace: "nowrap" }}>
        {dateTxt}{e.status === "plan" ? " ⏳" : ""}
      </span>
      <span className="num" style={{ fontSize: 12, color: "var(--text-lo)", textAlign: "right", whiteSpace: "nowrap", minWidth: 70 }}>
        {cur === "PLN" ? fmtCur(e.kwota, e.waluta) : ""}
      </span>
      <span className="num" style={{ fontSize: 13, fontWeight: 600, textAlign: "right", whiteSpace: "nowrap", minWidth: 96, color: est ? "var(--text-lo)" : "var(--text-hi)" }}>
        {e.brak_kursu ? "brak kursu" : amount}
      </span>
    </div>
  );
}

// ── Rozbicie per producent (pasek + chipy) ───────────────────
function MfrBreakdown({ mfrs, total, cur, hovered, setHovered }: {
  mfrs: MfrAgg[]; total: number; cur: string; hovered: string | null; setHovered: (v: string | null) => void;
}) {
  if (mfrs.length === 0) return <div style={{ fontSize: 12, color: "var(--text-lo)" }}>Brak danych dla tego wyboru.</div>;
  return (
    <div>
      <div style={{ display: "flex", height: 12, borderRadius: 99, overflow: "hidden", background: "var(--surface-2)", marginBottom: 14 }}>
        {mfrs.map(m => (
          <div key={m.id} onMouseEnter={() => setHovered(m.id)} onMouseLeave={() => setHovered(null)}
            title={`${m.name}: ${fmtCur(m.value, cur)} (${total > 0 ? Math.round((m.value / total) * 100) : 0}%)`}
            style={{ width: `${total > 0 ? (m.value / total) * 100 : 0}%`, background: m.color, cursor: "pointer",
              opacity: hovered != null && hovered !== m.id ? 0.3 : 1, transition: "opacity 0.16s" }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {mfrs.map(m => (
          <button key={m.id} onMouseEnter={() => setHovered(m.id)} onMouseLeave={() => setHovered(null)}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 10px",
              background: hovered === m.id ? `color-mix(in oklch, ${m.color} 15%, var(--surface-2))` : "var(--surface-2)",
              border: `1px solid ${hovered === m.id ? m.color : "var(--border-soft)"}`, borderRadius: 7, cursor: "pointer", transition: "all 0.12s" }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: m.color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 500 }}>{m.name}</span>
            <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>
              {fmtCurK(m.value, cur)} <span style={{ opacity: 0.7 }}>· {total > 0 ? Math.round((m.value / total) * 100) : 0}%</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Słupki miesięczne (stacked per producent) ────────────────
function MonthBars({ months, maxTotal, cur, hoveredMfr, colorOf, nameOf }: {
  months: Bucket[]; maxTotal: number; cur: string; hoveredMfr: string | null;
  colorOf: (k: string) => string; nameOf: (k: string) => string;
}) {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${months.length}, 1fr)`, gap: 8, padding: "0 18px", alignItems: "flex-end", minHeight: 200, height: 220 }}>
        {months.map(m => {
          const hp = (m.total / maxTotal) * 100;
          const segs = Object.entries(m.byMfr).sort((a, b) => b[1] - a[1]);
          return (
            <div key={m.key} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", height: "100%", justifyContent: "flex-end" }}>
              <div className="num" style={{ fontSize: 10, fontWeight: 600, color: "var(--text-mid)", textAlign: "center", marginBottom: 4 }}>{fmtCurK(m.total, cur)}</div>
              <div style={{ height: `${hp}%`, minHeight: 4, borderRadius: 6, display: "flex", flexDirection: "column-reverse", overflow: "hidden" }}
                title={`${m.label}: ${fmtCur(m.total, cur)}`}>
                {segs.map(([mk, v]) => (
                  <div key={mk} title={`${nameOf(mk)}: ${fmtCur(v, cur)}`} style={{
                    height: `${(v / m.total) * 100}%`, background: colorOf(mk),
                    opacity: hoveredMfr != null && hoveredMfr !== mk ? 0.25 : 1, transition: "opacity 0.16s" }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${months.length}, 1fr)`, gap: 8, padding: "8px 18px 0", borderTop: "1px solid var(--border-soft)", marginTop: 6 }}>
        {months.map(m => (
          <div key={m.key} style={{ textAlign: "center", fontSize: 10, fontWeight: 500, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{m.short}</div>
        ))}
      </div>
    </div>
  );
}

// ── Drobne UI ────────────────────────────────────────────────
type Kpi = { label: string; value: React.ReactNode; sub: string; icon: React.ReactNode };
function KpiRow({ a, b, c, d }: { a: Kpi; b: Kpi; c: Kpi; d: Kpi }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
      {[a, b, c, d].map((k, i) => <MiniStat key={i} label={k.label} value={k.value} sub={k.sub} icon={k.icon} />)}
    </div>
  );
}

function TabBtn({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, border: "1px solid transparent",
      display: "inline-flex", alignItems: "center", gap: 7, transition: "all 0.12s",
      background: active ? "var(--surface-2)" : "transparent", color: active ? "var(--text-hi)" : "var(--text-mid)",
      borderColor: active ? "var(--border-soft)" : "transparent",
    }}>{icon}{children}</button>
  );
}

function Seg({ label, options, value, onChange }: { label: string; options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      {label && <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-mid)" }}>{label}</span>}
      <div style={{ display: "inline-flex", gap: 2, padding: 3, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8 }}>
        {options.map(([v, l]) => (
          <button key={v || "all"} onClick={() => onChange(v)} style={{
            padding: "5px 14px", fontSize: 12, fontWeight: 600, borderRadius: 6, border: "none",
            background: value === v ? "var(--surface-3)" : "transparent", color: value === v ? "var(--text-hi)" : "var(--text-mid)",
          }}>{l}</button>
        ))}
      </div>
    </div>
  );
}

type TabProps = {
  events: LedgerEvent[]; cur: string; rt: Record<string, number>; shop: string; year: string;
  hoveredMfr: string | null; setHoveredMfr: (v: string | null) => void; onContainerClick?: (id: number) => void;
};

const emptyStyle: React.CSSProperties = { padding: 26, textAlign: "center", color: "var(--text-lo)", fontSize: 12 };
const firmaTag: React.CSSProperties = { fontSize: 10, fontWeight: 600, padding: "1px 7px", borderRadius: 5, border: "1px solid var(--border)", color: "var(--text-mid)", background: "var(--surface-2)" };
const noteStyle: React.CSSProperties = { marginTop: 6, padding: "14px 16px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderLeft: "3px solid var(--accent)", borderRadius: 8, fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 };

export { CashflowView };
export default CashflowView;
