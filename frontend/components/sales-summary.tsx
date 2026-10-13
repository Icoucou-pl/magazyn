"use client";
// ============================================================
// MAGAZYN — „Podsumowanie sprzedaży" na pulpicie (wzór: panel Sellasista).
//
// Jedna karta. Każdy panel:
//   · JEDEN wybór zakresu (od–do, najwcześniej 01.01.2026, skróty dziś / 7D / 30D / Ten rok) —
//     kafelki (liczba zamówień, wartość, średnia) liczą DOKŁADNIE ten zakres,
//   · wykres: słupki = liczba zamówień (oś lewa), linia = wartość w PLN (oś prawa),
//     ten sam zakres, ale zawsze min. 30 dni (przy „dziś”/7D wykres sięga wstecz,
//     a dni spoza wybranego zakresu są przygaszone — widać, z czego są kafelki),
//     grupowanie: dziennie / tygodniowo / miesięcznie — słupek = SUMA za okres.
//     Niepełny tydzień/miesiąc (bieżący albo ucięty zakresem) jest jaśniejszy, żeby
//     nie udawał spadku sprzedaży.
//
// Liczenie jak w Sellasiście, NIE jak w finansach: wszystkie statusy (nowe, za pobraniem…),
// data złożenia zamówienia, kwota brutto z wysyłką → PLN po kursie NBP. Robi to backend
// (services/podsumowanie_sprzedazy.py); tu tylko tniemy okna z jednej pobranej serii.
//
// Firma z Topbara: „Wszyscy" → jeden duży panel „Razem" (podział na firmy w dymku „ⓘ”
// przy kafelku, tylko na komputerze), konkretna firma → tylko jej panel.
// Bez viewFinancials backend oddaje value=null — chowamy kwoty i linię wartości.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { Card } from "./ui";
import { api } from "@/lib/api";
import { useShop, SHOP_OPTIONS } from "@/lib/shop";
import { fmtPLN, fmtNum } from "@/lib/format";

type Point = { date: string; orders: number; value: number | null };
type Series = { shop: string; points: Point[]; missing_rates: number };
type Summary = { from: string; to: string; series: Series[]; excluded_statuses?: string[] };
type Grupa = "d" | "t" | "m";
// Słupek wykresu: jeden dzień albo zsumowany tydzień/miesiąc (date = pierwszy dzień okresu).
// `od`/`do` = pierwszy/ostatni dzień okresu, który faktycznie jest w zakresie.
type Slupek = Point & { od: string; do: string; dni: number; pelnych: number };

// Skróty 1:1 z Sellasistem (sprawdzone na Veluxie co do grosza, 12.10.2026): „30D” = dziś
// + 29 poprzednich, ale „7D” = dziś + 7 poprzednich, czyli 8 dni kalendarzowych.
// Niekonsekwencja jest po stronie Sellasista — trzymamy się jej, żeby liczby się zgadzały.
const SKROTY = [{ d: 1, l: "dziś" }, { d: 8, l: "7D" }, { d: 30, l: "30D" }];
const MIN_WYKRES = 30;   // wykres nigdy krótszy niż 30 dni (przy „dziś” byłby jednym słupkiem)
const POCZATEK = "2026-01-01";   // wcześniej danych nie ma — tak samo pilnuje backend (POCZATEK_DANYCH)
const GRUPY: { v: Grupa; l: string }[] = [{ v: "d", l: "dziennie" }, { v: "t", l: "tygodniowo" }, { v: "m", l: "miesięcznie" }];
// Grupowanie dobierane do długości zakresu (szef: przy długich okresach dzienny wykres to
// „kardiogram”); użytkownik może przełączyć, ale zmiana zakresu wraca do automatu.
const autoGrupa = (dni: number): Grupa => (dni <= 45 ? "d" : "t");

const BAR = "var(--info)";
const LINE = "var(--accent)";

const nazwa = (shop: string) => (shop ? SHOP_OPTIONS.find((o) => o.v === shop)?.l ?? shop : "Razem");

// Ładne podziałki osi: 0 … max zaokrąglony do 1/2/5 × 10^n, 4 odcinki.
function niceMax(v: number) {
  if (v <= 0) return 1;
  const raw = v / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  return step * 4;
}

const dzienLabel = (iso: string) =>
  new Date(iso + "T12:00:00").toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
const miesiacLabel = (iso: string, rok = false) =>
  new Date(iso + "T12:00:00").toLocaleDateString("pl-PL", rok ? { month: "long", year: "numeric" } : { month: "short" });

// Daty RRRR-MM-DD, arytmetyka w UTC — bez dryfu przy zmianie czasu letni/zimowy.
const toUTC = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const fromUTC = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => fromUTC(toUTC(iso) + n * 86400000);
const span = (a: string, b: string) => Math.round((toUTC(b) - toUTC(a)) / 86400000) + 1;   // dni włącznie

// Początek okresu, do którego należy dzień: poniedziałek tygodnia albo 1. dzień miesiąca.
function poczatekOkresu(iso: string, g: Grupa): string {
  if (g === "m") return iso.slice(0, 8) + "01";
  const dow = (new Date(toUTC(iso)).getUTCDay() + 6) % 7;   // pon = 0 … nd = 6
  return addDays(iso, -dow);
}
function dlugoscOkresu(start: string, g: Grupa): number {
  if (g === "d") return 1;
  if (g === "t") return 7;
  const [y, m] = start.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Dni → słupki. Suma zamówień i wartości za okres; `dni` < `pelnych` = okres niepełny
// (bieżący tydzień/miesiąc albo ucięty początkiem zakresu) — wykres rysuje go jaśniej.
function grupuj(points: Point[], g: Grupa): Slupek[] {
  const out: Slupek[] = [];
  for (const p of points) {
    const start = g === "d" ? p.date : poczatekOkresu(p.date, g);
    const ost = out[out.length - 1];
    if (ost && ost.date === start) {
      ost.orders += p.orders;
      ost.value = ost.value == null && p.value == null ? null : (ost.value ?? 0) + (p.value ?? 0);
      ost.do = p.date;
      ost.dni += 1;
    } else {
      out.push({ date: start, od: p.date, do: p.date, orders: p.orders, value: p.value, dni: 1, pelnych: dlugoscOkresu(start, g) });
    }
  }
  return out;
}

const okresLabel = (b: Slupek, g: Grupa) => {
  if (g === "d") return new Date(b.date + "T12:00:00").toLocaleDateString("pl-PL", { weekday: "short", day: "numeric", month: "long" });
  if (g === "m") return miesiacLabel(b.date, true);
  return `${dzienLabel(b.od)} – ${dzienLabel(b.do)}`;
};

function SegBtns<T extends string | number>({ value, options, onChange }: {
  value: T; options: { v: T; l: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} className="num" style={{
          padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: "pointer", border: "none",
          background: value === o.v ? "var(--surface-3)" : "transparent",
          color: value === o.v ? "var(--text-hi)" : "var(--text-mid)",
        }}>{o.l}</button>
      ))}
    </div>
  );
}

// ── Wykres: słupki (zamówienia) + linia (wartość) ─────────────
function ComboChart({ points, grupa, showValue, selOd, selDo, height = 220 }: {
  points: Slupek[]; grupa: Grupa; showValue: boolean; selOd: string; selDo: string; height?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const n = points.length;
  const padL = 34, padR = showValue ? 54 : 10, padT = 10, padB = 24;
  const innerW = Math.max(10, w - padL - padR);
  const innerH = height - padT - padB;
  const maxO = niceMax(Math.max(0, ...points.map((p) => p.orders)));
  const maxV = niceMax(Math.max(0, ...points.map((p) => p.value ?? 0)));
  const slot = innerW / Math.max(1, n);
  const barW = Math.max(1, Math.min(grupa === "d" ? 18 : 40, slot * 0.6));
  const cx = (i: number) => padL + slot * (i + 0.5);
  const yO = (v: number) => padT + innerH - (v / maxO) * innerH;
  const yV = (v: number) => padT + innerH - (v / maxV) * innerH;
  const niepelny = (p: Slupek) => p.dni < p.pelnych;
  // Słupek w wybranym zakresie (to z niego liczą się kafelki) — reszta przygaszona.
  const wybrany = (p: Slupek) => p.do >= selOd && p.od <= selDo;
  const przygas = (p: Slupek) => (wybrany(p) ? 1 : 0.35);
  // Linia wartości: odcinki do/od niepełnego okresu przerywane — inaczej bieżący tydzień
  // wygląda jak nagły spadek sprzedaży.
  const pt = (i: number) => `${cx(i).toFixed(1)},${yV(points[i].value ?? 0).toFixed(1)}`;
  const odcinki = points.slice(1).map((p, k) => ({
    d: `M${pt(k)} L${pt(k + 1)}`, przerywany: niepelny(p) || niepelny(points[k]),
    poza: !wybrany(p) || !wybrany(points[k]),
  }));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // Etykiety dat co kilka słupków (ok. 70 px na etykietę) — żeby się nie zlewały.
  const co = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 70))));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i = Math.floor((x - padL) / slot);
    setHover(i >= 0 && i < n ? i : null);
  };
  const hp = hover != null ? points[hover] : null;

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w - padR} y1={padT + innerH * (1 - t)} y2={padT + innerH * (1 - t)}
              stroke="var(--border-soft)" strokeDasharray={t === 0 ? undefined : "2,4"} />
            <text x={padL - 6} y={padT + innerH * (1 - t) + 3} fill="var(--text-lo)" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">
              {fmtNum(Math.round(maxO * t))}
            </text>
            {showValue && (
              <text x={w - padR + 6} y={padT + innerH * (1 - t) + 3} fill="var(--text-lo)" fontSize="10" fontFamily="var(--font-mono)">
                {fmtNum(Math.round(maxV * t))}
              </text>
            )}
          </g>
        ))}
        {hover != null && (
          <rect x={padL + slot * hover} y={padT} width={slot} height={innerH} fill="var(--surface-2)" />
        )}
        {points.map((p, i) => (
          <rect key={p.date} x={cx(i) - barW / 2} y={yO(p.orders)} width={barW} height={Math.max(0, padT + innerH - yO(p.orders))}
            rx={Math.min(3, barW / 3)} fill={BAR}
            opacity={(hover == null || hover === i ? 0.45 : 0.25) * (niepelny(p) ? 0.45 : 1) * przygas(p)}
            stroke={niepelny(p) ? BAR : undefined} strokeDasharray={niepelny(p) ? "3,2" : undefined} strokeOpacity={0.6} />
        ))}
        {showValue && odcinki.map((o, k) => (
          <path key={k} d={o.d} fill="none" stroke={LINE} strokeWidth={2} strokeLinecap="round"
            strokeDasharray={o.przerywany ? "4,4" : undefined} opacity={(o.przerywany ? 0.6 : 1) * (o.poza ? 0.35 : 1)} />
        ))}
        {showValue && n <= 60 && points.map((p, i) => (
          <circle key={p.date} cx={cx(i)} cy={yV(p.value ?? 0)} r={hover === i ? 4.5 : 3} opacity={przygas(p)}
            fill={niepelny(p) ? "var(--surface-1)" : LINE} stroke={niepelny(p) ? LINE : "var(--surface-1)"} strokeWidth={1.5} />
        ))}
        {points.map((p, i) => (i % co === 0 ? (
          <text key={p.date} x={cx(i)} y={height - 6} fill="var(--text-lo)" fontSize="10" textAnchor="middle" fontFamily="var(--font-mono)">
            {grupa === "m" ? miesiacLabel(p.od) : dzienLabel(p.od)}
          </text>
        ) : null))}
      </svg>
      {hp && hover != null && (
        <div style={{
          position: "absolute", top: 4, left: Math.min(Math.max(cx(hover) - 80, 4), w - 168),
          background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8,
          padding: "8px 11px", fontSize: 11, color: "var(--text-hi)", pointerEvents: "none", minWidth: 160,
          boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
        }}>
          <div style={{ color: "var(--text-lo)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
            {okresLabel(hp, grupa)}
          </div>
          {niepelny(hp) && (
            <div style={{ color: "var(--warning)", fontSize: 10, marginTop: 2 }}>
              {grupa === "t" ? "niepełny tydzień" : "niepełny miesiąc"}: {hp.dni} z {hp.pelnych} dni
            </div>
          )}
          <div className="num" style={{ marginTop: 3 }}><span style={{ color: BAR }}>■</span> {fmtNum(hp.orders)} zamówień</div>
          {showValue && <div className="num" style={{ marginTop: 2 }}><span style={{ color: LINE }}>●</span> {fmtPLN(hp.value ?? 0)}</div>}
        </div>
      )}
    </div>
  );
}

// `info` = podział „Razem” na firmy, w dymku po najechaniu na „ⓘ” — tylko na komputerze
// (klasa tylko-desktop w globals.css); na telefonie dymek i tak by się nie otworzył.
function Kpi({ label, value, info }: { label: string; value: React.ReactNode; info?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--text-lo)" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 3, minWidth: 0 }}>
        <span className="num" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {value}
        </span>
        {info && (
          <span className="tylko-desktop" title={info} style={{ color: "var(--text-lo)", cursor: "help", fontSize: 12, flexShrink: 0 }}>ⓘ</span>
        )}
      </div>
    </div>
  );
}

// Suma zamówień i wartości serii w zakresie od–do (włącznie) — tyle pokazują kafelki.
const sumaZakresu = (s: Series, od: string, do_: string) => {
  const okno = s.points.filter((p) => p.date >= od && p.date <= do_);
  return { zam: okno.reduce((a, p) => a + p.orders, 0), wart: okno.reduce((a, p) => a + (p.value ?? 0), 0) };
};

function Panel({ s, firmy, od, do_, wykresOd, grupa, showValue, height }: {
  s: Series; firmy: Series[]; od: string; do_: string; wykresOd: string; grupa: Grupa; showValue: boolean; height: number;
}) {
  const { zam, wart } = sumaZakresu(s, od, do_);
  // Panel „Razem”: podział na firmy w dymku „ⓘ” (szef nie chce 3 osobnych wykresów ani
  // podpisów pod kafelkami, ale ma się dać sprawdzić, z czego jest suma).
  const podzial = s.shop === "" && firmy.length > 1 ? firmy.map((f) => ({ l: nazwa(f.shop), ...sumaZakresu(f, od, do_) })) : null;
  const dymek = (fmt: (f: { zam: number; wart: number }) => string) => podzial?.map((f) => `${f.l}: ${fmt(f)}`).join("\n");
  const slupki = grupuj(s.points.filter((p) => p.date >= wykresOd && p.date <= do_), grupa);
  return (
    <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "12px 14px 6px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{nazwa(s.shop)}</span>
        {showValue && s.missing_rates > 0 && (
          <span title="Zamówienia w obcej walucie bez kursu NBP — ich kwota nie weszła do wartości."
            style={{ fontSize: 11, color: "var(--warning)", cursor: "help" }}>
            {fmtNum(s.missing_rates)} bez kursu
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: showValue ? "repeat(3, minmax(0, 1fr))" : "1fr", gap: 12, margin: "10px 0 8px" }}>
        <Kpi label="Liczba zamówień" value={fmtNum(zam)} info={dymek((f) => fmtNum(f.zam))} />
        {showValue && <Kpi label="Wartość" value={fmtPLN(wart)} info={dymek((f) => fmtPLN(f.wart))} />}
        {showValue && <Kpi label="Średnia wartość" value={zam ? fmtPLN(wart / zam) : "—"}
          info={dymek((f) => (f.zam ? fmtPLN(f.wart / f.zam) : "—"))} />}
      </div>
      <ComboChart points={slupki} grupa={grupa} showValue={showValue} selOd={od} selDo={do_} height={height} />
    </div>
  );
}

export default function SalesSummaryCard({ gap = 16 }: { gap?: number }) {
  const { shop } = useShop();
  const [data, setData] = useState<Summary | null>(null);
  const [blad, setBlad] = useState(false);
  // Zakres kafelków i wykresu: null = „30D” (liczone od ostatniego dnia z serwera, gdy dane dojdą).
  const [zakres, setZakres] = useState<{ od: string; do_: string } | null>(null);
  const [grupaSel, setGrupaSel] = useState<Grupa | null>(null);   // null = automat wg długości zakresu

  useEffect(() => {
    let alive = true;
    // Jeden fetch od 01.01.2026 — każdy zakres z pickera tniemy z niego, bez kolejnych zapytań.
    api.get(`/sales-summary?od=${POCZATEK}`)
      .then((r) => { if (alive) setData(r as Summary); })
      .catch(() => { if (alive) setBlad(true); });
    return () => { alive = false; };
  }, []);

  if (blad) return null;   // karta pomocnicza — jak się nie wczyta, reszta pulpitu działa dalej
  const wszystkie = data?.series ?? [];
  const firmy = wszystkie.filter((s) => s.shop !== "");
  // „Wszyscy” → sam „Razem” (jest tylko przy >1 firmie w zakresie usera; inaczej ta jedna firma).
  const razem = wszystkie.find((s) => s.shop === "");
  const series = shop ? wszystkie.filter((s) => s.shop === shop) : razem ? [razem] : wszystkie;
  const showValue = series.some((s) => s.points.some((p) => p.value != null));
  const pomijane = data?.excluded_statuses ?? [];

  const maxD = data?.to ?? POCZATEK;
  const minD = data && data.from > POCZATEK ? data.from : POCZATEK;
  const clamp = (d: string) => (d < minD ? minD : d > maxD ? maxD : d);
  const odSkrotu = (d: number) => clamp(addDays(maxD, -(d - 1)));
  const odRoku = clamp(maxD.slice(0, 4) + "-01-01");   // „Ten rok” = od 1 stycznia roku z „dziś”
  const od = zakres ? clamp(zakres.od) : odSkrotu(30);
  const do_ = zakres ? clamp(zakres.do_) : maxD;
  // Wykres: wybrany zakres, ale min. 30 dni — krótszy wydłużamy wstecz od daty „do”.
  const wykresOd = span(od, do_) >= MIN_WYKRES ? od : clamp(addDays(do_, -(MIN_WYKRES - 1)));
  const grupa = grupaSel ?? autoGrupa(span(wykresOd, do_));
  const ustaw = (o: string, d: string) => { setZakres({ od: o, do_: d }); setGrupaSel(null); };

  const dateInput: React.CSSProperties = {
    padding: "4px 8px", fontSize: 11, fontWeight: 600, borderRadius: 6,
    background: "var(--surface-2)", color: "var(--text-hi)", border: "1px solid var(--border)", colorScheme: "dark",
  };
  const presetBtn = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: "pointer", border: "none",
    background: active ? "var(--surface-3)" : "transparent", color: active ? "var(--text-hi)" : "var(--text-mid)",
  });

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", gap: 12, flexWrap: "wrap", borderBottom: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Podsumowanie sprzedaży</h3>
          <span title={"Jak w Sellasiście: zamówienia wg daty złożenia, w każdym statusie (nowe, za pobraniem, w realizacji…)"
            + (pomijane.length ? ` OPRÓCZ: ${pomijane.join(", ")}` : "") + ". "
            + "Wartość brutto z wysyłką, obce waluty po kursie NBP. Bez hurtu z Fakturowni. To bieżący ruch — nie zrealizowana sprzedaż z Finansów."}
            style={{ color: "var(--text-lo)", cursor: "help", fontSize: 12 }}>ⓘ</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="date" aria-label="Od" value={od} min={minD} max={do_}
              onChange={(e) => e.target.value && ustaw(clamp(e.target.value > do_ ? do_ : e.target.value), do_)} style={dateInput} />
            <span style={{ color: "var(--text-lo)", fontSize: 11 }}>–</span>
            <input type="date" aria-label="Do" value={do_} min={od} max={maxD}
              onChange={(e) => e.target.value && ustaw(od, clamp(e.target.value < od ? od : e.target.value))} style={dateInput} />
          </div>
          <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
            {SKROTY.map((k) => (
              <button key={k.d} onClick={() => ustaw(odSkrotu(k.d), maxD)} className="num"
                title={k.d === 8 ? "Jak w Sellasiście: dziś + 7 poprzednich dni" : undefined}
                style={presetBtn(od === odSkrotu(k.d) && do_ === maxD)}>{k.l}</button>
            ))}
            <button onClick={() => ustaw(odRoku, maxD)} style={presetBtn(od === odRoku && do_ === maxD && odRoku !== odSkrotu(30))}>Ten rok</button>
          </div>
        </div>
      </div>
      {/* Grupowanie osobnym wierszem pod nagłówkiem — w jednym rzędzie z datami było za ciasno. */}
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 14px 0" }}>
        <SegBtns value={grupa} options={GRUPY} onChange={setGrupaSel} />
      </div>
      <div style={{ padding: 14 }}>
        {!data ? (
          <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-lo)", fontSize: 12 }}>Wczytuję…</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 480px), 1fr))", gap }}>
            {series.map((s) => (
              <Panel key={s.shop || "razem"} s={s} firmy={firmy} od={od} do_={do_} wykresOd={wykresOd} grupa={grupa}
                showValue={showValue} height={series.length === 1 ? 320 : 220} />
            ))}
          </div>
        )}
        {data && showValue && (
          <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 10, fontSize: 11, color: "var(--text-mid)", flexWrap: "wrap" }}>
            <span><span style={{ color: LINE }}>●</span> Wartość zamówień (PLN)</span>
            <span><span style={{ color: BAR, opacity: 0.6 }}>■</span> Liczba zamówień</span>
            {grupa !== "d" && <span><span style={{ color: BAR, opacity: 0.3 }}>■</span> Niepełny {grupa === "t" ? "tydzień" : "miesiąc"}</span>}
          </div>
        )}
      </div>
    </Card>
  );
}
