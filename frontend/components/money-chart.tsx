"use client";
// ============================================================
// MAGAZYN — „Pieniądze firmy": wykres magazynu + salda rachunku.
//
// Zastępuje ValueChartCard na pulpicie. Linia magazynu jest TA SAMA co dotąd:
// te same punkty z /stock-value-history, ta sama skala, ten sam picker dat,
// to samo porównanie do poprzedniego okna. Przy wyłączonych liniach pieniężnych
// (stan domyślny) karta wygląda i liczy dokładnie jak stara — łącznie z kolorem
// zależnym od trendu i gradientem pod linią.
//
// Nowe linie włącza się klikając plakietki w legendzie:
//   • Stan konta            — odczyty księgowej (app_bank_balances), kropki = realne wpisy
//   • Bez pożyczek          — stan konta MINUS Σ wpłat wspólników o dacie ≤ dany dzień
//   • Kapitał łącznie       — magazyn + konto (odpowiedź na „czy pieniądze tylko zmieniają postać")
//   • Wpłaty wspólników     — pionowe znaczniki (app_owner_loans)
//
// Odejmowanie pożyczek jest NARASTAJĄCE: wpłata z marca zaniża każdy kolejny dzień,
// nie tylko dzień wpłaty. Zwrot (kwota ujemna) działa symetrycznie.
//
// Ograniczenia świadome:
//   · widok „Wszyscy" nie pokazuje linii pieniężnych — trzy spółki to trzy rachunki,
//     a odczyty wpadają w różnych dniach; backend zwraca wtedy puste listy
//   · widok „szt" pokazuje sam magazyn — sztuk na koncie bankowym nie ma
//   · odcinki między kropkami to interpolacja, nie pomiar
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "./ui";
import { api } from "@/lib/api";
import { can, useUser } from "@/lib/permissions";
import { useShop } from "@/lib/shop";
import { fmtPLN, fmtPLNk, fmtNum, fmtPct } from "@/lib/format";

// ── Typy ─────────────────────────────────────────────────────
export type MoneyPoint = { date: string; value: number; units: number };
export type BankBalance = { id: number; firma_slug: string; balance_date: string; amount_pln: number; note?: string | null };
export type OwnerLoan = {
  id: number; firma_slug: string; loan_date: string; amount_pln: number; partner: string;
  numer_umowy?: string | null; data_zawarcia?: string | null; termin_splaty?: string | null;
  oprocentowanie?: string | null; splacono_data?: string | null; note?: string | null;
};
export type MoneyBundle = { shop: string; balances: BankBalance[]; loans: OwnerLoan[]; can_edit: boolean };

type SeriesKey = "mag" | "raw" | "adj" | "transit" | "suma" | "loans";
export type TransitPoint = { date: string; value: number };

// Teal dobrany w konwencji palety z globals.css (jednolite L+C, zmienia się sam odcień) —
// tokenu w tym odcieniu nie ma, a wszystkie istniejące są już zajęte przez inne serie.
const TRANSIT = "oklch(0.700 0.140 195)";

const COLOR: Record<SeriesKey, string> = {
  mag: "var(--info)",
  raw: "var(--ok)",
  adj: "var(--ok)",
  transit: TRANSIT,
  suma: "var(--accent)",
  loans: "var(--anomaly)",
};

// Opisy w dymku po najechaniu na plakietkę — pisane dla kogoś, kto widzi wykres pierwszy raz.
const HELP: Record<SeriesKey, [string, string]> = {
  mag: ["Wartość magazynu", "Ile jest wart towar leżący na półkach. Kontener podbija linię w górę, sprzedaż powoli ją obniża."],
  raw: ["Stan konta", "Ile pieniędzy leży na rachunku firmy — dokładnie to, co podała księgowa. Kropki to dni z realnym wpisem; odcinki między nimi są zgadywane."],
  adj: ["Bez pożyczek wspólników", "Ile byłoby na koncie, gdyby wspólnicy nic nie dołożyli. Każdą wpłatę odejmujemy od dnia wpłaty w przód, na zawsze. Potrafi zejść poniżej zera i to nie jest błąd."],
  transit: ["Zapłacone w drodze", "Pieniądze wydane na kontener, który jeszcze płynie. Rosną w dniu przelewu, znikają w dniu wejścia towaru na magazyn — dokładnie wtedy, gdy podnosi się linia magazynu. Liczone są tylko realnie zapłacone raty; reszta balansu to zobowiązanie, nie kapitał."],
  suma: ["Kapitał łącznie", "Konto plus magazyn plus to, co zapłacone za towar w drodze — wszystkie pieniądze firmy razem. Płasko: kręcisz się w kółko. W górę: zarabiasz. W dół: przejadasz kapitał."],
  loans: ["Wpłaty wspólników", "Pionowy znacznik w dniu, w którym wspólnik dorzucił pieniądze; pusty znacznik to dzień zwrotu. Nic nie liczy — tłumaczy, skąd nagły skok na linii konta."],
};

const SERIES: { k: SeriesKey; label: string; dash?: "d" | "s" }[] = [
  { k: "mag", label: "Wartość magazynu" },
  { k: "raw", label: "Stan konta" },
  { k: "adj", label: "Bez pożyczek wspólników", dash: "s" },
  { k: "transit", label: "Zapłacone w drodze" },
  { k: "suma", label: "Kapitał łącznie", dash: "d" },
  { k: "loans", label: "Wpłaty wspólników", dash: "s" },
];

// ── Pomocnicze daty (identyczne z dawnym ValueChartCard) ─────
const DASH_MIN_DATE = "2026-01-01";
const _dAddDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const _dSpan = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000) + 1;
const _dLabel = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("pl-PL", { day: "numeric", month: "short" });

// ── Wykres ───────────────────────────────────────────────────
function MoneyChart({
  points, metric, on, balances, loans, transit, height = 220,
}: {
  points: MoneyPoint[];
  metric: "value" | "units";
  on: Record<SeriesKey, boolean>;
  balances: BankBalance[];
  loans: OwnerLoan[];
  transit: Record<string, number>;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 800, h: height });

  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((entries) => setSize({ w: entries[0].contentRect.width, h: height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [height]);

  const isUnits = metric === "units";
  // Linie pieniężne mają sens tylko w złotówkach.
  const showRaw = !isUnits && on.raw;
  const showAdj = !isUnits && on.adj;
  const showTransit = !isUnits && on.transit;
  const showSuma = !isUnits && on.suma;
  const showMarks = !isUnits && on.loans;
  const anyMoney = showRaw || showAdj || showSuma || showTransit;

  // ── Serie pieniężne: interpolacja między wpisami + narastające pożyczki ──
  const money = useMemo(() => {
    const n = points.length;
    const cum = new Array<number>(n).fill(0);
    const raw = new Array<number | null>(n).fill(null);
    const adj = new Array<number | null>(n).fill(null);
    if (!n) return { cum, raw, adj, anchors: [] as number[], marks: [] as { i: number; loan: OwnerLoan; back: boolean }[] };

    const idxByDate = new Map<string, number>();
    points.forEach((p, i) => idxByDate.set(p.date, i));

    // Pożyczka podnosi saldo od dnia wpłaty i przestaje je podnosić od dnia spłaty —
    // stąd dwa zdarzenia na umowę. Kwota ujemna (stary format „zwrotu") działa jak dawniej.
    const events: { d: string; v: number }[] = [];
    loans.forEach((l) => {
      events.push({ d: l.loan_date, v: l.amount_pln });
      if (l.splacono_data) events.push({ d: l.splacono_data, v: -l.amount_pln });
    });
    events.sort((a, b) => a.d.localeCompare(b.d));
    let acc = 0, li = 0;
    for (let i = 0; i < n; i++) {
      while (li < events.length && events[li].d <= points[i].date) {
        acc += events[li].v;
        li += 1;
      }
      cum[i] = acc;
    }

    // Kotwice = dni z realnym odczytem salda (tylko te mieszczące się w oknie danych).
    const anchors: number[] = [];
    const valueAt = new Map<number, number>();
    [...balances]
      .sort((a, b) => a.balance_date.localeCompare(b.balance_date))
      .forEach((b) => {
        const i = idxByDate.get(b.balance_date);
        if (i == null) return;
        anchors.push(i);
        valueAt.set(i, b.amount_pln);
      });

    for (let k = 0; k < anchors.length - 1; k++) {
      const a = anchors[k], b = anchors[k + 1];
      const va = valueAt.get(a) as number, vb = valueAt.get(b) as number;
      for (let i = a; i <= b; i++) raw[i] = va + (vb - va) * ((i - a) / (b - a));
    }
    if (anchors.length) {
      const last = anchors[anchors.length - 1];
      raw[last] = valueAt.get(last) as number;
    }
    for (let i = 0; i < n; i++) adj[i] = raw[i] == null ? null : (raw[i] as number) - cum[i];

    // Znacznik na dzień wpłaty i (jeśli jest) na dzień zwrotu — oba tłumaczą skok na linii konta.
    const marks = loans
      .flatMap((loan) => [
        { i: idxByDate.get(loan.loan_date), loan, back: false },
        ...(loan.splacono_data ? [{ i: idxByDate.get(loan.splacono_data), loan, back: true }] : []),
      ])
      .filter((m) => m.i != null) as { i: number; loan: OwnerLoan; back: boolean }[];

    return { cum, raw, adj, anchors, marks };
  }, [points, balances, loans]);

  if (points.length < 2) {
    return <div ref={ref} style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-lo)", fontSize: 12 }}>Brak danych do wykresu</div>;
  }

  const magVals = points.map((p) => (isUnits ? p.units : p.value));
  const transitVals = points.map((p) => (transit[p.date] ?? null));
  // Kapitał łącznie ma stałą definicję: magazyn + konto + zapłacone w drodze.
  // Nie zmienia się od tego, które plakietki są zapalone — inaczej ta sama liczba
  // znaczyłaby co innego przy każdym ustawieniu.
  const suma = money.raw.map((v, i) => (v == null ? null : magVals[i] + v + (transitVals[i] ?? 0)));

  const fmtTick = (v: number) => (isUnits ? fmtNum(v) : fmtPLNk(v));
  const fmtFull = (v: number) => (isUnits ? `${fmtNum(v)} szt` : fmtPLN(v));

  // ── Domeny obu osi ──
  const leftVals: number[] = [...magVals];
  if (showSuma) suma.forEach((v) => { if (v != null) leftVals.push(v); });
  const rightVals: number[] = [];
  if (showRaw) money.raw.forEach((v) => { if (v != null) rightVals.push(v); });
  if (showAdj) money.adj.forEach((v) => { if (v != null) rightVals.push(v); });
  // „W drodze" to setki tysięcy — bliżej mu skalą do konta niż do magazynu.
  if (showTransit) transitVals.forEach((v) => { if (v != null) rightVals.push(v); });

  const lMax = Math.max(...leftVals), lMin = Math.min(...leftVals);
  const lRange = lMax - lMin || 1;

  // Jeden odczyt salda to poprawny stan (świeża firma, pierwszy wpis) — wtedy nie ma
  // rozpiętości do policzenia, więc rozsuwamy oś o ±15%, żeby kropka wylądowała
  // pośrodku wykresu zamiast poza jego obszarem.
  const hasRight = rightVals.length > 0;
  const rawMax = hasRight ? Math.max(...rightVals) : 1;
  const rawMin = hasRight ? Math.min(...rightVals) : 0;
  const single = hasRight && rawMax === rawMin;
  const spread = single ? Math.max(Math.abs(rawMax) * 0.15, 1) : 0;
  const rMax = rawMax + spread;
  const rMin = rawMin - spread;
  const rRange = rMax - rMin || 1;

  const lTicks = [lMin + lRange * 0.25, lMin + lRange * 0.5, lMin + lRange * 0.75, lMax];
  const rTicks = !hasRight ? [] : single ? [rawMax] : [rMin, rMin + rRange * 0.5, rMax];

  // Geometria: bez linii pieniężnych trzymamy DAWNE marginesy i etykiety po prawej
  // (żeby domyślny widok był 1:1 ze starą kartą). Z liniami — oś magazynu wędruje
  // w lewo, prawa zostaje dla konta, a marginesy liczymy z NAJDŁUŻSZEJ etykiety,
  // inaczej „3,29 mln zł" wychodzi poza SVG i zostaje z niego „,29 mln zł".
  const textW = (t: string) => t.length * 6.2 + 12;
  const padTop = 20, padBot = 30;
  const padLeft = anyMoney ? Math.ceil(Math.max(...lTicks.map((t) => textW(fmtTick(t))), 40)) : 8;
  const padRight = anyMoney ? Math.ceil(Math.max(...rTicks.map((t) => textW(fmtPLNk(t))), 40)) : 8;
  const innerH = size.h - padTop - padBot;
  const innerW = size.w - padLeft - padRight;
  const getX = (i: number) => padLeft + (i / (points.length - 1)) * innerW;

  const yL = (v: number) => padTop + innerH - ((v - lMin) / lRange) * innerH;
  const yR = (v: number) => padTop + innerH - ((v - rMin) / rRange) * innerH;

  const line = (arr: (number | null)[], y: (v: number) => number) => {
    let d = "", pen = false;
    arr.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${getX(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const magPath = line(magVals, yL);
  const areaPath = `${magPath} L${getX(points.length - 1).toFixed(1)},${padTop + innerH} L${getX(0).toFixed(1)},${padTop + innerH} Z`;

  // Bez linii pieniężnych magazyn zachowuje dawny kolor trendu i gradient.
  // Z nimi przechodzi na niebieski, żeby nie gryzł się z zielenią konta.
  const positive = magVals[magVals.length - 1] - magVals[0] >= 0;
  const magStroke = anyMoney ? COLOR.mag : (positive ? "var(--ok)" : "var(--critical)");
  const magFill = positive ? "url(#chartGradOk)" : "url(#chartGradBad)";

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.round((((e.clientX - rect.left) - padLeft) / innerW) * (points.length - 1));
    if (idx >= 0 && idx < points.length) setHover(idx);
  };

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <svg width={size.w} height={size.h} onMouseMove={handleMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        <defs>
          <linearGradient id="chartGradOk" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.730 0.150 155)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="oklch(0.730 0.150 155)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="chartGradBad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.640 0.190 25)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="oklch(0.640 0.190 25)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {lTicks.slice(0, -1).map((t, i) => (
          <line key={i} x1={padLeft} x2={size.w - padRight} y1={yL(t)} y2={yL(t)} stroke="var(--border-soft)" strokeDasharray="2,4" strokeWidth="1" />
        ))}

        {showMarks && money.marks.map(({ i, loan, back }) => (
          <g key={`${loan.id}${back ? "z" : ""}`}>
            <line x1={getX(i)} x2={getX(i)} y1={padTop} y2={padTop + innerH} stroke={COLOR.loans}
                  strokeDasharray="3,4" strokeWidth="1" opacity={back ? 0.4 : 0.7} />
            {back
              ? <circle cx={getX(i)} cy={padTop} r="3.5" fill="var(--bg)" stroke={COLOR.loans} strokeWidth="1.5" />
              : <circle cx={getX(i)} cy={padTop} r="3.5" fill={COLOR.loans} />}
          </g>
        ))}

        {!anyMoney && <path d={areaPath} fill={magFill} />}
        {on.mag && <path d={magPath} stroke={magStroke} strokeWidth="2" fill="none" strokeLinejoin="round" />}
        {showSuma && <path d={line(suma, yL)} stroke={COLOR.suma} strokeWidth="2" fill="none" strokeDasharray="1,5" strokeLinecap="round" />}
        {showTransit && <path d={line(transitVals, yR)} stroke={TRANSIT} strokeWidth="2" fill="none" strokeLinejoin="round" />}
        {showAdj && <path d={line(money.adj, yR)} stroke={COLOR.adj} strokeWidth="1.8" fill="none" strokeDasharray="6,4" opacity="0.75" />}
        {showRaw && <path d={line(money.raw, yR)} stroke={COLOR.raw} strokeWidth="2" fill="none" strokeLinejoin="round" />}

        {/* Kropki tylko tam, gdzie ktoś wpisał realny odczyt — reszta linii to interpolacja. */}
        {(showRaw || showAdj) && money.anchors.map((i) => {
          const v = showRaw ? money.raw[i] : money.adj[i];
          if (v == null) return null;
          return (
            <g key={i}>
              {/* Jeden odczyt = brak linii (nie ma czego łączyć), więc kropka musi być widoczna sama. */}
              {money.anchors.length === 1 && (
                <line x1={getX(i) - 14} x2={getX(i) + 14} y1={yR(v)} y2={yR(v)} stroke={COLOR.raw} strokeWidth="2" opacity="0.5" />
              )}
              <circle cx={getX(i)} cy={yR(v)} r={money.anchors.length === 1 ? 4.5 : 3} fill="var(--bg)" stroke={COLOR.raw} strokeWidth="2" />
            </g>
          );
        })}

        {hover != null && (
          <g>
            <line x1={getX(hover)} x2={getX(hover)} y1={padTop} y2={padTop + innerH} stroke="var(--text-lo)" strokeDasharray="2,3" strokeWidth="1" />
            {on.mag && <circle cx={getX(hover)} cy={yL(magVals[hover])} r="4" fill={magStroke} stroke="var(--bg)" strokeWidth="2" />}
          </g>
        )}

        {lTicks.map((t, i) => (
          <text key={i} x={anyMoney ? padLeft - 8 : size.w - padRight} y={anyMoney ? yL(t) : yL(t) - 4}
                fill={anyMoney ? COLOR.mag : "var(--text-lo)"} opacity={anyMoney ? 0.8 : 1}
                fontSize="10" textAnchor="end" dominantBaseline={anyMoney ? "middle" : "auto"} fontFamily="var(--font-mono)">
            {fmtTick(t)}
          </text>
        ))}
        {rTicks.map((t, i) => (
          <text key={`r${i}`} x={size.w - padRight + 8} y={yR(t)} fill={COLOR.raw} opacity="0.8"
                fontSize="10" dominantBaseline="middle" fontFamily="var(--font-mono)">{fmtPLNk(t)}</text>
        ))}

        <text x={padLeft} y={size.h - 8} fill="var(--text-lo)" fontSize="10" fontFamily="var(--font-mono)">{_dLabel(points[0].date)}</text>
        <text x={size.w / 2} y={size.h - 8} fill="var(--text-lo)" fontSize="10" textAnchor="middle" fontFamily="var(--font-mono)">{_dLabel(points[Math.floor(points.length / 2)].date)}</text>
        <text x={size.w - padRight} y={size.h - 8} fill="var(--text-lo)" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">{_dLabel(points[points.length - 1].date)}</text>
      </svg>

      {hover != null && (
        <div style={{
          position: "absolute",
          left: Math.min(Math.max(getX(hover) - 95, 8), Math.max(8, size.w - 200)),
          top: 8,
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "8px 11px", fontSize: 11, color: "var(--text-hi)",
          pointerEvents: "none", minWidth: 190, boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
        }}>
          <div style={{ color: "var(--text-lo)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
            {new Date(points[hover].date + "T00:00:00").toLocaleDateString("pl-PL", { weekday: "short", day: "numeric", month: "long" })}
          </div>
          {on.mag && <TipRow label={isUnits ? "Magazyn" : "Magazyn"} value={fmtFull(magVals[hover])} color={magStroke} />}
          {showRaw && money.raw[hover] != null && <TipRow label="Stan konta" value={fmtPLN(money.raw[hover] as number)} color={COLOR.raw} />}
          {showAdj && money.adj[hover] != null && <TipRow label="Bez pożyczek" value={fmtPLN(money.adj[hover] as number)} color={COLOR.adj} />}
          {showTransit && transitVals[hover] != null && <TipRow label="Zapłacone w drodze" value={fmtPLN(transitVals[hover] as number)} color={TRANSIT} />}
          {showSuma && suma[hover] != null && <TipRow label="Kapitał łącznie" value={fmtPLN(suma[hover] as number)} color={COLOR.suma} />}
          {anyMoney && money.cum[hover] !== 0 && <TipRow label="Od wspólników" value={fmtPLN(money.cum[hover])} color={COLOR.loans} />}
        </div>
      )}
    </div>
  );
}

function TipRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, lineHeight: 1.7 }}>
      <span style={{ color: "var(--text-mid)" }}>{label}</span>
      <span className="num" style={{ color }}>{value}</span>
    </div>
  );
}

// ── Karta ────────────────────────────────────────────────────
export function MoneyChartCard({ points, canFin, onOpenEntries }: {
  points: MoneyPoint[];
  canFin: boolean;
  // Skrót do Cashflow → „Konto i pożyczki". Bez niego karta działa tak samo,
  // tylko zamiast przycisku zostaje wskazówka tekstowa pod kwotą.
  onOpenEntries?: () => void;
}) {
  const user = useUser();
  const { shop } = useShop();
  const canBank = can(user, "viewBankBalances") && canFin;

  const [metricSel, setMetricSel] = useState<"value" | "units">(canFin ? "value" : "units");
  const metric: "value" | "units" = canFin ? metricSel : "units";

  // Domyślnie widać SAM magazyn — resztę user dokłada klikając plakietki.
  const [on, setOn] = useState<Record<SeriesKey, boolean>>({ mag: true, raw: false, adj: false, transit: false, suma: false, loans: false });
  const [helpFor, setHelpFor] = useState<SeriesKey | null>(null);
  const marksAuto = useRef(false);

  const [bundle, setBundle] = useState<MoneyBundle | null>(null);
  const [transit, setTransit] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);

  // Ile dni historii „w drodze" pobrać — tyle, ile obejmuje wykres magazynu, żeby serie
  // się pokrywały. Liczba, nie tablica, żeby zmiana referencji propsa nie odpalała fetcha.
  const spanDays = useMemo(() => (points.length
    ? Math.max(30, Math.round((Date.parse(points[points.length - 1].date) - Date.parse(points[0].date)) / 86400000))
    : 90), [points]);

  // Dane pieniężne tylko dla konkretnej firmy: widok „Wszyscy" (shop="") ich nie ma.
  useEffect(() => {
    let alive = true;
    if (!canBank || !shop) { setBundle(null); setTransit({}); setLoaded(true); return () => { alive = false; }; }
    setLoaded(false);
    (async () => {
      const [b, t] = await Promise.all([
        api.get(`/money?shop=${encodeURIComponent(shop)}`).catch(() => null),
        api.get(`/transit-paid-history?shop=${encodeURIComponent(shop)}&days=${spanDays}`).catch(() => null),
      ]);
      if (!alive) return;
      setBundle((b as MoneyBundle) || null);
      const map: Record<string, number> = {};
      ((t as { points?: TransitPoint[] })?.points || []).forEach((pt) => { map[pt.date] = pt.value; });
      setTransit(map);
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [canBank, shop, spanDays]);

  const balances = bundle?.balances ?? [];
  const loans = bundle?.loans ?? [];
  const hasMoney = canBank && !!shop && balances.length > 0;

  const toggle = (k: SeriesKey) => {
    setOn((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      // Pierwsze włączenie linii konta zapala znaczniki wpłat — inaczej user zobaczyłby
      // skok o pół miliona bez wyjaśnienia. Potem może je zgasić i tak zostanie.
      if ((k === "raw" || k === "adj") && next[k] && !marksAuto.current) {
        next.loans = true;
        marksAuto.current = true;
      }
      // Suma zapala swoje składniki: nikt nie powinien patrzeć na „kapitał łącznie",
      // nie widząc, z czego się składa. Zgasić je można potem ręcznie.
      if (k === "suma" && next.suma) {
        next.mag = true;
        if (!next.adj) next.raw = true;
        next.transit = true;
      }
      return next;
    });
  };

  // ── Zakres dat: logika 1:1 z dawnej karty ──
  const dataMin = points.length ? points[0].date : DASH_MIN_DATE;
  const dataMax = points.length ? points[points.length - 1].date : DASH_MIN_DATE;
  const minDate = dataMin < DASH_MIN_DATE ? DASH_MIN_DATE : dataMin;

  const [from, setFrom] = useState<string>(minDate);
  const [to, setTo] = useState<string>(dataMax);
  const fullRef = useRef(true);
  useEffect(() => {
    if (fullRef.current) { setFrom(minDate); setTo(dataMax); }
  }, [minDate, dataMax]);

  const apply = (f: string, t: string, isFull: boolean) => { fullRef.current = isFull; setFrom(f); setTo(t); };
  const onFrom = (v: string) => { const f = v < minDate ? minDate : v > to ? to : v; apply(f, to, false); };
  const onTo = (v: string) => { const t = v > dataMax ? dataMax : v < from ? from : v; apply(from, t, false); };
  const from30 = _dAddDays(dataMax, -29) < minDate ? minDate : _dAddDays(dataMax, -29);
  const preset30 = () => apply(from30, dataMax, false);
  const is30 = from === from30 && to === dataMax;

  const sliced = points.filter((p) => p.date >= from && p.date <= to);
  const isFullDefault = from === minDate && to === dataMax;

  // Które serie realnie widać (metric i brak danych mają pierwszeństwo nad ptaszkami).
  const isUnits = metric === "units";
  const hasTransit = canBank && !!shop && Object.values(transit).some((v) => v > 0);
  const hasLoans = canBank && !!shop && loans.length > 0;
  const vis = {
    mag: on.mag,
    raw: !isUnits && on.raw && hasMoney,
    adj: !isUnits && on.adj && hasMoney,
    transit: !isUnits && on.transit && hasTransit,
    suma: !isUnits && on.suma && hasMoney,
    loans: !isUnits && on.loans && hasLoans,
  };
  // Plakietka bez danych za sobą byłaby martwym przyciskiem — klik nic by nie zmienił.
  // Pokazujemy tylko te serie, które mają czym rysować; czego brakuje, mówi podpis pod kwotą.
  const available: Record<SeriesKey, boolean> = {
    mag: true, raw: hasMoney, adj: hasMoney, suma: hasMoney, transit: hasTransit, loans: hasLoans,
  };

  // ── Nagłówek: seria wiodąca + porównanie do poprzedniego okna (reguła jak dawniej) ──
  const magVal = (p?: MoneyPoint) => (p ? (metric === "value" ? p.value : p.units) : 0);
  const cumAt = (iso: string) => loans.reduce((s, l) => (l.loan_date <= iso ? s + l.amount_pln : s), 0);
  const balAt = (iso: string): number | null => {
    // Ostatni odczyt o dacie ≤ iso (bez interpolacji — nagłówek pokazuje realny pomiar).
    let best: BankBalance | null = null;
    balances.forEach((b) => { if (b.balance_date <= iso && (!best || b.balance_date > best.balance_date)) best = b; });
    return best ? (best as BankBalance).amount_pln : null;
  };

  const lead: { label: string; color: string; cur: number | null; prev: number | null; when: string | null } = (() => {
    if (vis.suma) {
      const b = balAt(to);
      const bp = balAt(_dAddDays(from, -1));
      const cur = b == null ? null : magVal(sliced[sliced.length - 1]) + b + (transit[to] ?? 0);
      const prevPoint = points.find((p) => p.date === _dAddDays(from, -1));
      const prev = bp == null || !prevPoint ? null : magVal(prevPoint) + bp + (transit[_dAddDays(from, -1)] ?? 0);
      return { label: "Kapitał łącznie", color: COLOR.suma, cur, prev, when: null };
    }
    if (vis.transit && !vis.raw && !vis.adj) {
      return {
        label: "Zapłacone w drodze", color: TRANSIT,
        cur: transit[to] ?? null, prev: transit[_dAddDays(from, -1)] ?? null, when: null,
      };
    }
    if (vis.raw || vis.adj) {
      const b = balAt(to);
      const bp = balAt(_dAddDays(from, -1));
      const sub = vis.adj && !vis.raw;
      let when: string | null = null;
      balances.forEach((x) => { if (x.balance_date <= to && (!when || x.balance_date > when)) when = x.balance_date; });
      return {
        label: sub ? "Bez pożyczek wspólników" : "Stan konta",
        color: COLOR.raw,
        cur: b == null ? null : (sub ? b - cumAt(to) : b),
        prev: bp == null ? null : (sub ? bp - cumAt(_dAddDays(from, -1)) : bp),
        when,
      };
    }
    return {
      label: metric === "value" ? "Wartość magazynu" : "Liczba sztuk",
      color: "var(--text-hi)",
      cur: magVal(sliced[sliced.length - 1]),
      prev: (() => {
        const N = _dSpan(from, to);
        const prevFrom = _dAddDays(from, -N);
        if (isFullDefault || prevFrom < minDate) return null;
        const p = points.find((x) => x.date === _dAddDays(from, -1));
        return p ? magVal(p) : null;
      })(),
      when: null,
    };
  })();

  const change = lead.cur != null && lead.prev != null ? lead.cur - lead.prev : null;
  const pct = change != null && lead.prev ? (change / Math.abs(lead.prev)) * 100 : null;
  const changePositive = (change ?? 0) >= 0;
  const fmtBig = (n: number) => (metric === "value" ? fmtPLN(n) : `${fmtNum(n)} szt`);
  const fmtDelta = (n: number) => (metric === "value" ? fmtPLNk(n) : `${fmtNum(n)} szt`);

  const segBtn = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: "pointer",
    background: active ? "var(--surface-3)" : "transparent",
    color: active ? "var(--text-hi)" : "var(--text-mid)", border: "none",
  });
  const dateInput: React.CSSProperties = {
    padding: "4px 8px", fontSize: 11, fontWeight: 600, borderRadius: 6,
    background: "var(--surface-2)", color: "var(--text-hi)",
    border: "1px solid var(--border)", colorScheme: "dark",
  };

  // Podpis pod kwotą — mówi, co dalej zrobić albo skąd wzięła się liczba.
  const subtitle = (() => {
    if (isUnits) return "Widok w sztukach pokazuje sam magazyn — pieniędzy na koncie nie da się liczyć w sztukach.";
    if (!canBank) return null;
    if (!shop) return "Wybierz firmę u góry, żeby dołożyć stan konta — trzy spółki mają trzy osobne rachunki.";
    if (!hasMoney) {
      const co = hasLoans ? "Pożyczki są zapisane, ale bez odczytów salda nie ma z czego narysować linii konta" : "Brak wpisów salda dla tej firmy";
      return onOpenEntries ? `${co} — kliknij „Dodaj wpisy”.` : `${co}. Dodasz je w Cashflow → Konto i pożyczki.`;
    }
    // hasMoney nadal steruje liniami i podpisem niżej — przycisk świeci zawsze,
    // bo prowadzi też do poprawiania i kasowania istniejących wpisów.
    if (lead.when) {
      const c = cumAt(lead.when);
      return `Ostatni wpis: ${_dLabel(lead.when)}. ${c ? `Wspólnicy wpłacili do tego dnia ${fmtPLN(c)}.` : "Brak pożyczek od wspólników."}`;
    }
    return "Kliknij plakietkę, żeby dołożyć linię. Najedź na nią, żeby przeczytać, co pokazuje.";
  })();

  const legendItems = SERIES.filter((s) => (isUnits ? s.k === "mag" : available[s.k]));

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 20px 12px", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>
              {canBank ? "Pieniądze firmy" : (metric === "value" ? "Wartość magazynu" : "Liczba sztuk")}
            </span>
            <span className="mono" style={{ padding: "2px 7px", fontSize: 10, fontWeight: 600, background: "var(--surface-2)", color: "var(--text-mid)", borderRadius: 999 }}>
              {_dLabel(from)}–{_dLabel(to)}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
            <div className="num" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", color: lead.color }}>
              {lead.cur == null ? "brak wpisu" : fmtBig(lead.cur)}
            </div>
            {canBank && <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-lo)" }}>{lead.label}</span>}
            {change != null && pct != null ? (
              <span className="num" style={{ fontSize: 13, fontWeight: 600, color: changePositive ? "var(--ok)" : "var(--critical)" }}>
                {changePositive ? "+" : ""}{fmtDelta(change)} ({fmtPct(pct)})
              </span>
            ) : (
              !canBank && <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-lo)" }}>
                {isFullDefault ? "Wybierz zakres dat, aby zobaczyć zmiany w magazynie." : "Brak zakresu dat do porównania."}
              </span>
            )}
          </div>
          {subtitle && <div style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 4, maxWidth: "70ch" }}>{subtitle}</div>}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {canBank && onOpenEntries && (
            <button
              onClick={onOpenEntries}
              title="Przejdź do Cashflow → Konto i pożyczki"
              style={{
                padding: "5px 11px", fontSize: 11, fontWeight: 600, borderRadius: 6,
                background: "var(--accent-soft)", border: "1px solid transparent", color: "var(--accent)",
              }}
            >
              Dodaj wpisy
            </button>
          )}
          {canFin && (
            <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
              <button onClick={() => setMetricSel("value")} style={segBtn(metric === "value")}>zł</button>
              <button onClick={() => setMetricSel("units")} style={segBtn(metric === "units")}>szt</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="date" value={from} min={minDate} max={to} onChange={(e) => onFrom(e.target.value)} style={dateInput} />
            <span style={{ color: "var(--text-lo)", fontSize: 11 }}>–</span>
            <input type="date" value={to} min={from} max={dataMax} onChange={(e) => onTo(e.target.value)} style={dateInput} />
          </div>
          <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
            <button onClick={preset30} className="num" style={segBtn(is30)}>30D</button>
          </div>
        </div>
      </div>

      {/* Legenda-przełącznik. Widoczna tylko gdy jest co przełączać. */}
      {canBank && loaded && legendItems.length > 1 && (
        <div style={{ position: "relative", padding: "0 20px 10px" }} onMouseLeave={() => setHelpFor(null)}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {legendItems.map((s) => {
              const active = vis[s.k];
              return (
                <button
                  key={s.k}
                  onClick={() => toggle(s.k)}
                  onMouseEnter={() => setHelpFor(s.k)}
                  onFocus={() => setHelpFor(s.k)}
                  aria-pressed={active}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 7, padding: "4px 10px", borderRadius: 999,
                    background: "var(--surface-2)", border: "1px solid var(--border)",
                    fontSize: 11, fontWeight: 600, color: active ? "var(--text-mid)" : "var(--text-lo)",
                    opacity: active ? 1 : 0.45, transition: "opacity 0.12s",
                  }}
                >
                  <i style={{
                    width: 14, flex: "none",
                    ...(s.dash
                      ? { height: 0, borderTop: `3px ${s.dash === "d" ? "dotted" : "dashed"} ${active ? COLOR[s.k] : "var(--text-lo)"}` }
                      : { height: 3, borderRadius: 2, background: active ? COLOR[s.k] : "var(--text-lo)" }),
                  }} />
                  {s.label}
                </button>
              );
            })}
          </div>
          {helpFor && (
            <div style={{
              position: "absolute", zIndex: 15, top: "calc(100% - 6px)", left: 20, maxWidth: 430,
              background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--r-md)",
              padding: "11px 14px", boxShadow: "0 10px 26px rgba(0,0,0,0.5)", pointerEvents: "none",
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLOR[helpFor], marginBottom: 5 }}>{HELP[helpFor][0]}</div>
              <div style={{ fontSize: 12, lineHeight: 1.55, color: "var(--text-mid)" }}>{HELP[helpFor][1]}</div>
            </div>
          )}
        </div>
      )}

      <div style={{ padding: "0 8px 4px" }}>
        <MoneyChart points={sliced} metric={metric} on={vis} balances={balances} loans={loans} transit={transit} height={220} />
      </div>
    </Card>
  );
}

export default MoneyChartCard;
