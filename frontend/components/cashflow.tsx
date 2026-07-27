"use client";
// ============================================================
// MAGAZYN — Cashflow (etap 5). Rejestr płatności za kontenery.
//   Dwie zakładki:
//     • Do zapłaty — kwota pozostała per producent, bucket po miesiącu ETA
//       (zaliczki i balance bez daty ≤ dziś; PLN otwarte = szacunek po kursie „dziś").
//     • Zapłacono — ledger per producent, każda wpłata z datą, PLN po kursie historycznym.
//   Pasek sklepu (Wszystkie/AMH/Acti/Veluxa) + przełącznik waluty (PLN/USD/CNY).
//   Źródło: GET /api/cashflow/ledger (płaska lista zdarzeń + rate_today).
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, Card, CardHeader, MfrChip } from "./ui";
import { MiniStat } from "./containers-ui";
import { api } from "@/lib/api";
import { toast } from "./toast";

// ── Typy ─────────────────────────────────────────────────────
type Status = "paid" | "plan" | "open";
type LedgerEvent = {
  kontener: string; po: string | null;
  mfr_id: number | null; mfr_name: string; mfr_color: string;
  shop: string; shop_name: string;
  eta: string | null;
  typ: "zaliczka" | "balance";
  kwota: number; waluta: string;
  data: string | null;
  status: Status;
  kwota_pln: number | null;
  brak_kursu: boolean;
};
type LedgerResp = { as_of: string; rate_today: Record<string, number>; events: LedgerEvent[] };

// ── Stałe ────────────────────────────────────────────────────
const SHOPS: [string, string][] = [["", "Wszystkie"], ["amh", "AMH"], ["acti", "Acti"], ["veluxa", "Veluxa"]];
const CURS: string[] = ["PLN", "USD", "CNY"];
const CUR_SYM: Record<string, string> = { PLN: "zł", USD: "$", CNY: "¥" };
const MONTH_SHORT = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];

// ── Formatery walut ──────────────────────────────────────────
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

// ── Widok główny ─────────────────────────────────────────────
function CashflowView({ onContainerClick }: { onContainerClick?: () => void }) {
  const [resp, setResp] = useState<LedgerResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"due" | "paid">("due");
  const [shop, setShop] = useState("");
  const [cur, setCur] = useState("PLN");
  const [hoveredMfr, setHoveredMfr] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await api.get("/cashflow/ledger");
        if (mounted) setResp(data as LedgerResp);
      } catch {
        if (mounted) { setResp({ as_of: "", rate_today: {}, events: [] }); toast("Nie udało się pobrać płatności", "error"); }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const events = resp?.events ?? [];
  const rt = resp?.rate_today ?? {};
  const scoped = useMemo(() => events.filter(e => !shop || e.shop === shop), [events, shop]);

  if (loading) {
    return <div className="fade-in" style={{ padding: 48, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Ładowanie…</div>;
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 80 }}>
      {/* Nagłówek + zakładki */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
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
      </div>

      {/* Filtry: sklep + waluta */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Seg label="Sklep" options={SHOPS} value={shop} onChange={setShop} />
        <Seg label="Waluta" options={CURS.map(c => [c, c] as [string, string])} value={cur} onChange={setCur} />
      </div>

      {tab === "due"
        ? <DueTab events={scoped} cur={cur} rt={rt} shop={shop} hoveredMfr={hoveredMfr} setHoveredMfr={setHoveredMfr} onContainerClick={onContainerClick} />
        : <PaidTab events={scoped} cur={cur} rt={rt} shop={shop} onContainerClick={onContainerClick} />}

      {/* Nota kontekstowa */}
      <div style={noteStyle}>
        {tab === "due"
          ? <><b>Do zapłaty</b> — kwota pozostała (zaliczki i balance bez daty ≤ dziś), per producent, bucket po miesiącu ETA. W PLN kwoty otwarte są <b>szacunkiem</b> po dzisiejszym kursie (oznaczone „≈"). W trybie USD/CNY pokazujemy oryginalne kwoty faktur tylko dla zdarzeń danej waluty.</>
          : <><b>Zapłacono</b> — wpłaty z datą ≤ dziś, per producent. <b>PLN</b> = kurs historyczny NBP z dnia płatności (zablokowany). <b>USD / CNY</b> = oryginalne kwoty faktur, tylko zdarzenia danej waluty (+ PLN w podpisie). Dostawa ≠ zapłata — dostarczony kontener z nieopłaconym balance siedzi w „Do zapłaty".</>}
      </div>
    </div>
  );
}

// ── ZAKŁADKA: DO ZAPŁATY ─────────────────────────────────────
type MfrAgg = { id: string; name: string; color: string; value: number };
type DueMonth = { key: string; label: string; short: string; total: number; byMfr: Record<string, number>; items: LedgerEvent[] };

function DueTab({ events, cur, rt, shop, hoveredMfr, setHoveredMfr, onContainerClick }: {
  events: LedgerEvent[]; cur: string; rt: Record<string, number>; shop: string;
  hoveredMfr: string | null; setHoveredMfr: (v: string | null) => void; onContainerClick?: () => void;
}) {
  const agg = useMemo(() => {
    const open = events.filter(e => e.status !== "paid");
    const monthsMap: Record<string, DueMonth> = {};
    const perMfr: Record<string, MfrAgg> = {};
    let total = 0, next30 = 0, openCount = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d30 = new Date(today); d30.setDate(d30.getDate() + 30);

    open.forEach(e => {
      const val = dispVal(e, cur, rt);
      if (val == null || !e.eta) return;
      openCount++;
      const key = e.eta.slice(0, 7);
      const eta = parseLocal(e.eta);
      const m = (monthsMap[key] = monthsMap[key] || {
        key, label: `${MONTH_SHORT[eta.getMonth()]} ${eta.getFullYear()}`, short: MONTH_SHORT[eta.getMonth()],
        total: 0, byMfr: {}, items: [],
      });
      m.total += val; m.items.push(e);
      const mk = String(e.mfr_id ?? e.mfr_name);
      m.byMfr[mk] = (m.byMfr[mk] || 0) + val;
      const a = (perMfr[mk] = perMfr[mk] || { id: mk, name: e.mfr_name, color: e.mfr_color, value: 0 });
      a.value += val;
      total += val;
      if (eta >= today && eta <= d30) next30 += val;
    });

    const months = Object.values(monthsMap).sort((a, b) => (a.key < b.key ? -1 : 1));
    const peak = months.reduce<DueMonth | null>((p, m) => (m.total > (p?.total || 0) ? m : p), null);
    const mfrs = Object.values(perMfr).sort((a, b) => b.value - a.value);
    return { months, peak, mfrs, total, next30, openCount };
  }, [events, cur, rt]);

  const maxTotal = Math.max(...agg.months.map(m => m.total), 1);
  const colorOf = (mk: string) => agg.mfrs.find(m => m.id === mk)?.color || "var(--text-lo)";
  const nameOf = (mk: string) => agg.mfrs.find(m => m.id === mk)?.name || "—";

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <MiniStat label="Suma do zapłaty" value={fmtCur(agg.total, cur)} sub={`${agg.openCount} płatności otwartych`} icon={<I.Wallet size={14} />} />
        <MiniStat label="Najbliższe 30 dni" value={fmtCur(agg.next30, cur)} sub="wg ETA" icon={<I.Alert size={14} />} />
        <MiniStat label="Największy miesiąc" value={agg.peak ? fmtCur(agg.peak.total, cur) : "—"} sub={agg.peak?.label || "—"} icon={<I.TrendUp size={14} />} />
        <MiniStat label="Otwarte pozycje" value={String(agg.openCount)} sub={`${agg.months.length} miesięcy`} icon={<I.Activity size={14} />} />
      </div>

      {/* Rozbicie per producent */}
      <Card>
        <CardHeader icon={<I.Factory size={14} />} title="Pozostało do zapłaty wg producenta" hint="kolory jak w słupkach niżej" />
        <div style={{ padding: "14px 18px" }}>
          <MfrBreakdown mfrs={agg.mfrs} total={agg.total} cur={cur} hovered={hoveredMfr} setHovered={setHoveredMfr} />
        </div>
      </Card>

      {/* Słupki miesięczne */}
      <Card>
        <CardHeader icon={<I.Calendar size={14} />} title="Pozostało do zapłaty — wg miesiąca ETA" hint="kwota jeszcze niezapłacona" />
        {agg.months.length === 0
          ? <div style={emptyStyle}>Brak otwartych płatności dla tego wyboru.</div>
          : <div style={{ padding: "14px 4px 14px 0" }}>
            <MonthBars months={agg.months} maxTotal={maxTotal} cur={cur} hoveredMfr={hoveredMfr} colorOf={colorOf} nameOf={nameOf} />
          </div>}
      </Card>

      {/* Drilldown otwartych płatności */}
      {agg.months.length > 0 && (
        <Card>
          <CardHeader icon={<I.Box size={14} />} title="Szczegóły — otwarte płatności" hint="kliknij miesiąc" />
          <div>
            {agg.months.map((m, i) => (
              <DueMonthRow key={m.key} month={m} maxTotal={maxTotal} cur={cur} rt={rt} shop={shop}
                hoveredMfr={hoveredMfr} colorOf={colorOf} nameOf={nameOf}
                isLast={i === agg.months.length - 1} onContainerClick={onContainerClick} />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function DueMonthRow({ month: m, maxTotal, cur, rt, shop, hoveredMfr, colorOf, nameOf, isLast, onContainerClick }: {
  month: DueMonth; maxTotal: number; cur: string; rt: Record<string, number>; shop: string;
  hoveredMfr: string | null; colorOf: (k: string) => string; nameOf: (k: string) => string;
  isLast: boolean; onContainerClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const segs = Object.entries(m.byMfr).sort((a, b) => b[1] - a[1]);
  const items = [...m.items].sort((a, b) => ((a.data || "9999") < (b.data || "9999") ? -1 : 1));

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

// ── ZAKŁADKA: ZAPŁACONO ──────────────────────────────────────
function PaidTab({ events, cur, rt, shop, onContainerClick }: {
  events: LedgerEvent[]; cur: string; rt: Record<string, number>; shop: string; onContainerClick?: () => void;
}) {
  const { groups, totalDisp, totalPln, nZal, nBal, nMfr } = useMemo(() => {
    const paid = events.filter(e => e.status === "paid");
    const shown = paid.filter(e => cur === "PLN" || e.waluta === cur);
    const groups: Record<string, { name: string; color: string; list: LedgerEvent[] }> = {};
    shown.forEach(e => {
      const mk = String(e.mfr_id ?? e.mfr_name);
      (groups[mk] = groups[mk] || { name: e.mfr_name, color: e.mfr_color, list: [] }).list.push(e);
    });
    const totalPln = shown.reduce((s, e) => s + (e.kwota_pln ?? 0), 0);
    const totalDisp = cur === "PLN" ? totalPln : shown.reduce((s, e) => s + e.kwota, 0);
    return {
      groups: Object.entries(groups).sort((a, b) => {
        const sa = a[1].list.reduce((s, e) => s + (e.kwota_pln ?? 0), 0);
        const sb = b[1].list.reduce((s, e) => s + (e.kwota_pln ?? 0), 0);
        return sb - sa;
      }),
      totalDisp, totalPln,
      nZal: shown.filter(e => e.typ === "zaliczka").length,
      nBal: shown.filter(e => e.typ === "balance").length,
      nMfr: Object.keys(groups).length,
    };
  }, [events, cur]);

  const nPay = groups.reduce((s, [, g]) => s + g.list.length, 0);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <MiniStat label="Suma zapłacona" value={fmtCur(totalDisp, cur)} sub={cur === "PLN" ? "kurs historyczny NBP" : "kwoty oryginalne faktur"} icon={<I.Wallet size={14} />} />
        <MiniStat label="Liczba płatności" value={String(nPay)} sub={`${nMfr} producentów`} icon={<I.Activity size={14} />} />
        <MiniStat label="Zaliczki" value={String(nZal)} sub="z datami" icon={<I.ArrowUp size={14} />} />
        <MiniStat label="Balance" value={String(nBal)} sub="z datami" icon={<I.TrendUp size={14} />} />
      </div>

      <Card>
        <CardHeader icon={<I.Factory size={14} />} title="Płatności wg producenta"
          hint={cur === "PLN" ? "PLN po kursie z dnia płatności" : "oryginalna waluta faktury"} />
        {nPay === 0
          ? <div style={emptyStyle}>Brak zapłaconych płatności {cur !== "PLN" ? `w walucie ${cur}` : ""} dla tego wyboru.</div>
          : <div>
            {groups.map(([mk, g], i) => (
              <PaidGroup key={mk} name={g.name} color={g.color} list={g.list} cur={cur} rt={rt} shop={shop}
                isLast={i === groups.length - 1} onContainerClick={onContainerClick} />
            ))}
          </div>}
      </Card>
    </>
  );
}

function PaidGroup({ name, color, list, cur, rt, shop, isLast, onContainerClick }: {
  name: string; color: string; list: LedgerEvent[]; cur: string; rt: Record<string, number>;
  shop: string; isLast: boolean; onContainerClick?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const rows = [...list].sort((a, b) => ((a.data || "") < (b.data || "") ? -1 : 1));
  const subPln = list.reduce((s, e) => s + (e.kwota_pln ?? 0), 0);
  const subDisp = cur === "PLN" ? subPln : list.reduce((s, e) => s + e.kwota, 0);

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--border-soft)" }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", cursor: "pointer" }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
        <span style={{ color: "var(--text-lo)", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.18s", flexShrink: 0 }}><I.ChevronR size={14} /></span>
        <div style={{ flex: 1, minWidth: 0 }}><MfrChip name={name} color={color} /></div>
        <div style={{ textAlign: "right", minWidth: 140, flexShrink: 0 }}>
          <div className="num" style={{ fontSize: 14, fontWeight: 600 }}>{fmtCur(subDisp, cur)}</div>
          <div style={{ fontSize: 11, color: "var(--text-lo)" }}>
            {list.length} płatności{cur !== "PLN" ? ` · ${fmtCurK(subPln, "PLN")}` : ""}
          </div>
        </div>
      </div>
      {open && (
        <div className="fade-in" style={{ background: "var(--bg-elevated)", padding: "6px 18px 14px 44px", display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((e, k) => <PayRow key={k} e={e} cur={cur} rt={rt} shop={shop} onContainerClick={onContainerClick} />)}
        </div>
      )}
    </div>
  );
}

// ── Wiersz płatności (wspólny) ───────────────────────────────
function PayRow({ e, cur, rt, shop, onContainerClick }: {
  e: LedgerEvent; cur: string; rt: Record<string, number>; shop: string; onContainerClick?: () => void;
}) {
  const est = e.status !== "paid";
  const dateColor = e.status === "plan" ? "var(--warning)" : (e.status === "open" ? "var(--text-lo)" : "var(--text-mid)");
  const dateTxt = e.data ? fmtDay(e.data) : "bez daty";
  const isZal = e.typ === "zaliczka";
  const amount = cur === "PLN"
    ? `${est ? "≈ " : ""}${fmtCur(plnOf(e, rt), "PLN")}`
    : fmtCur(e.kwota, e.waluta);

  return (
    <div onClick={() => onContainerClick?.()} style={{
      display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto auto auto", gap: 12, alignItems: "center",
      padding: "8px 12px", background: "var(--surface-1)", border: "1px solid var(--border-soft)",
      borderRadius: 7, cursor: onContainerClick ? "pointer" : "default",
    }}
      onMouseEnter={ev => (ev.currentTarget.style.borderColor = "var(--border)")}
      onMouseLeave={ev => (ev.currentTarget.style.borderColor = "var(--border-soft)")}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>#{e.kontener}</span>
        {e.po && <span className="mono" style={{ fontSize: 10, color: "var(--text-lo)" }}>{e.po}</span>}
        {!shop && <span style={firmaTag}>{e.shop_name}</span>}
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
  if (mfrs.length === 0) return <div style={{ fontSize: 12, color: "var(--text-lo)" }}>Brak otwartych płatności.</div>;
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
  months: DueMonth[]; maxTotal: number; cur: string; hoveredMfr: string | null;
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
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-mid)" }}>{label}</span>
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

const emptyStyle: React.CSSProperties = { padding: 26, textAlign: "center", color: "var(--text-lo)", fontSize: 12 };
const firmaTag: React.CSSProperties = { fontSize: 10, fontWeight: 600, padding: "1px 7px", borderRadius: 5, border: "1px solid var(--border)", color: "var(--text-mid)", background: "var(--surface-2)" };
const noteStyle: React.CSSProperties = { marginTop: 6, padding: "14px 16px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderLeft: "3px solid var(--accent)", borderRadius: 8, fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 };

export { CashflowView };
export default CashflowView;
