"use client";
// ============================================================
// MAGAZYN — Zakładka „Życie produktu 2.0”.
//
// Wersja porównawcza, stojąca OBOK v1. Nie kopiuje jej kodu —
// składa się z tych samych komponentów (product-lifecycle.tsx)
// i dokłada cztery sekcje. Dzięki temu porównujemy zakres,
// a nie dwie rozjeżdżające się implementacje tego samego.
//
// Kiedy zdecydujemy, która wersja zostaje, ten plik albo znika,
// albo zastępuje v1 — a wtedy eksporty z v1 wracają do prywatnych.
//
// NOWE WOBEC v1:
//   1. Utracona sprzedaż    — ile sztuk nie wyszło przez braki
//   2. Marża w czasie        — realny COGS × przychód z faktur
//   3. Koszt: płacimy vs COGS — opóźnienie magazynowe
//   4. Narzut logistyczny    — fracht per dostawa + anomalie
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import {
  Kafelek, KrzywaCeny, KrzywaStanu, OsCzasu, Podsumowanie, TabelaPrzyjec, Tooltip,
  box, fmtC, fmtD, fmtM, note, sect, sectHead, sectHint, sectTitle,
  type Historia, type Przyjecie, type Tip,
} from "./product-lifecycle";

type SeasonPoint = { year: number; month: number; qty: number; value_net: number; value_gross: number };

// ============================================================
export default function LifecycleTabV2({ sku, showFin }: { sku: string; showFin: boolean }) {
  const [h, setH] = useState<Historia | null>(null);
  const [season, setSeason] = useState<SeasonPoint[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setH(null); setSeason(null); setErr(false);
    api.get(`/products/${encodeURIComponent(sku)}/historia`)
      .then((d) => { if (alive) setH(d as Historia); })
      .catch(() => { if (alive) setErr(true); });
    // Przychód jest opcjonalny — bez niego po prostu nie ma wykresu marży.
    api.get(`/products/${encodeURIComponent(sku)}/sales-season`)
      .then((d) => { if (alive) setSeason(d as SeasonPoint[]); })
      .catch(() => { if (alive) setSeason([]); });
    return () => { alive = false; };
  }, [sku]);

  if (err) {
    return (
      <div style={{ ...box, padding: 22, textAlign: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-mid)" }}>Brak historii dla tego SKU</div>
      </div>
    );
  }
  if (!h) return <div style={{ height: 420, ...box }} className="pulse-soft" />;

  return (
    <div>
      <Podsumowanie h={h} showFin={showFin} />
      <UtraconaSprzedaz h={h} showFin={showFin} />
      <KrzywaCeny h={h} />
      {showFin && <MarzaWCzasie h={h} season={season} />}
      <KosztLag h={h} />
      <KrzywaStanu h={h} />
      <NarzutLogistyczny h={h} />
      <OsCzasu h={h} />
      <TabelaPrzyjec h={h} />
    </div>
  );
}

// ── 1. UTRACONA SPRZEDAŻ ─────────────────────────────────────
// Miesiąc zapala się przy DWÓCH warunkach naraz:
//   a) zapas na POCZĄTKU miesiąca nie pokrywał popytu z tego
//      samego miesiąca rok wcześniej,
//   b) sprzedaż faktycznie spadła poniżej mediany z trzech
//      poprzednich miesięcy.
//
// Sam warunek (a) zapala miesiąc, którego odpowiednik rok
// wcześniej był wyjątkowy. Sama miara „stan na koniec < sprzedaż”
// jest kołowa: brak towaru tłumi sprzedaż, a stłumiona sprzedaż
// sprawia, że zapas wygląda na wystarczający.
function UtraconaSprzedaz({ h, showFin }: { h: Historia; showFin: boolean }) {
  const wynik = useMemo(() => {
    const pkt = h.stan_miesiecznie;
    const sprz = new Map(pkt.map((p) => [p.miesiac.slice(0, 7), p.wydano]));
    const szczegoly: { m: string; bylo: number; popyt: number; strata: number }[] = [];
    let bezOdniesienia = 0;

    pkt.forEach((p, i) => {
      const m = p.miesiac.slice(0, 7);
      const rokWcz = `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`;
      const popyt = sprz.get(rokWcz);
      const naStart = i > 0 ? pkt[i - 1].stan : 0;

      if (popyt == null) {
        if (p.wydano > 0 && naStart < p.wydano) bezOdniesienia++;
        return;
      }
      if (naStart >= popyt) return;

      const ostatnie = pkt.slice(Math.max(0, i - 3), i)
        .map((x) => x.wydano).filter((v) => v > 0).sort((a, b) => a - b);
      if (!ostatnie.length) return;
      const mediana = ostatnie[Math.floor(ostatnie.length / 2)];
      if (p.wydano >= mediana) return;

      const strata = Math.max(0, popyt - p.wydano);
      if (strata > 0) szczegoly.push({ m, bylo: p.wydano, popyt, strata });
    });

    const suma = szczegoly.reduce((s, x) => s + x.strata, 0);
    return { szczegoly, suma, bezOdniesienia };
  }, [h.stan_miesiecznie]);

  // Średni koszt własny ostatniego roku — do przeliczenia straty na złotówki
  // liczymy po koszcie, nie po cenie sprzedaży, bo ceny tu nie znamy.
  const sredniKoszt = useMemo(() => {
    const z = h.stan_miesiecznie.filter((p) => p.koszt_wlasny != null && p.wydano > 0).slice(-12);
    if (!z.length) return null;
    const q = z.reduce((s, p) => s + p.wydano, 0);
    return z.reduce((s, p) => s + p.wydano * (p.koszt_wlasny as number), 0) / q;
  }, [h.stan_miesiecznie]);

  if (!wynik.szczegoly.length && !wynik.bezOdniesienia) return null;

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Ile kosztowały braki towaru</span>
        <span style={sectHint}>szacunek, nie pomiar</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        <Kafelek label="Miesięcy z brakiem" value={wynik.szczegoly.length}
          sub="pusty magazyn + załamana sprzedaż"
          tone={wynik.szczegoly.length ? "critical" : "neutral"} />
        <Kafelek label="Szacowana strata" value={`${fmtNum(wynik.suma)} szt`}
          sub="sprzedaż, która nie miała z czego wyjść"
          tone={wynik.suma ? "critical" : "neutral"} />
        {showFin && sredniKoszt != null && (
          <Kafelek label="Zamrożony obrót" value={`~${fmtNum(wynik.suma * sredniKoszt / 1000)} tys zł`}
            sub={`w cenie zakupu (${fmtC(sredniKoszt)} zł/szt)`} tone="warning" />
        )}
        <Kafelek label="Bez odniesienia" value={wynik.bezOdniesienia}
          sub="pierwszy rok — brak porównania" />
      </div>

      <div style={note}>
        {wynik.szczegoly.length > 0 && (
          <>
            Gdzie zabolało:{" "}
            {wynik.szczegoly.map((x) => `${fmtM(`${x.m}-01`)} ${fmtNum(x.bylo)} szt zamiast ${fmtNum(x.popyt)} (−${fmtNum(x.strata)})`).join(" · ")}.{" "}
          </>
        )}
        Miesiąc zapala się, gdy zapas <b>na początku miesiąca</b> nie pokrywał popytu z tego samego
        miesiąca rok wcześniej <b>i</b> sprzedaż spadła poniżej mediany z trzech poprzednich miesięcy.
        Drugi warunek jest po to, żeby nie zapalać miesiąca tylko dlatego, że jego odpowiednik rok
        wcześniej był wyjątkowo dobry. Szacunek zakłada, że popyt był taki sam jak rok wcześniej.
      </div>
    </div>
  );
}

// ── 2. MARŻA W CZASIE ────────────────────────────────────────
function MarzaWCzasie({ h, season }: { h: Historia; season: SeasonPoint[] | null }) {
  const [tip, setTip] = useState<Tip>(null);

  const dane = useMemo(() => {
    if (!season?.length) return [];
    const przychod = new Map<string, number>();
    for (const s of season) {
      przychod.set(`${s.year}-${String(s.month + 1).padStart(2, "0")}`, s.value_net);
    }
    return h.stan_miesiecznie
      .map((p) => {
        const m = p.miesiac.slice(0, 7);
        const rev = przychod.get(m);
        if (rev == null || rev <= 0 || p.koszt_wlasny == null || p.wydano <= 0) return null;
        const koszt = p.wydano * p.koszt_wlasny;
        return { m, rev, koszt, qty: p.wydano, kw: p.koszt_wlasny, marza: ((rev - koszt) / rev) * 100 };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [h.stan_miesiecznie, season]);

  if (!season) return <div style={{ height: 260, ...box, ...sect }} className="pulse-soft" />;
  if (dane.length < 3) return null;

  const W = 720, H = 280, L = 58, R = 44, T = 20, B = 34;
  const maxV = Math.max(...dane.map((d) => d.rev)) * 1.1;
  const X = (i: number) => L + (i + 0.5) * (W - L - R) / dane.length;
  const Y = (v: number) => T + (1 - v / maxV) * (H - T - B);
  const mLo = Math.min(...dane.map((d) => d.marza)) - 5;
  const mHi = Math.max(...dane.map((d) => d.marza)) + 5;
  const Ym = (p: number) => T + (1 - (p - mLo) / (mHi - mLo || 1)) * (H - T - B);
  const bw = ((W - L - R) / dane.length) * 0.72;

  const sr = dane.reduce((s, d) => s + d.rev - d.koszt, 0) / dane.reduce((s, d) => s + d.rev, 0) * 100;
  const min = dane.reduce((a, b) => (b.marza < a.marza ? b : a));
  const max = dane.reduce((a, b) => (b.marza > a.marza ? b : a));

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Marża miesiąc po miesiącu</span>
        <span style={sectHint}>koszt własny liczony przez Subiekta po FIFO</span>
      </div>

      <div style={box}>
        <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Przychód netto, koszt własny i marża</div>
          <div style={{ fontSize: 10.5, color: "var(--text-lo)", marginTop: 2 }}>
            średnio {fmtC(sr, 1)}% · najniżej {fmtC(min.marza, 1)}% ({fmtM(`${min.m}-01`)}),
            najwyżej {fmtC(max.marza, 1)}% ({fmtM(`${max.m}-01`)})
          </div>
        </div>

        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: H }}>
            {[0, 1, 2, 3].map((i) => {
              const v = (maxV * i) / 3, y = Y(v);
              return (
                <g key={i}>
                  <line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={L - 8} y={y + 3.5} textAnchor="end" fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">
                    {fmtNum(v / 1000)}k
                  </text>
                </g>
              );
            })}
            {dane.map((d, i) => {
              const yP = Y(d.rev), yK = Y(d.koszt);
              return (
                <g key={d.m}>
                  <rect x={X(i) - bw / 2} y={yP} width={bw} height={Math.max(0, H - B - yP)} fill="var(--surface-3)" rx={2} />
                  <rect x={X(i) - bw / 2} y={yK} width={bw} height={Math.max(0, H - B - yK)} fill="oklch(0.640 0.190 25 / .55)" rx={2} />
                  {d.m.endsWith("-01") && (
                    <text x={X(i)} y={H - B + 14} textAnchor="middle" fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">
                      {d.m.slice(0, 4)}
                    </text>
                  )}
                  <rect x={X(i) - bw / 2 - 1} y={T} width={bw + 2} height={H - T - B} fill="transparent" style={{ cursor: "pointer" }}
                    onMouseMove={(e) => setTip({
                      x: e.clientX, y: e.clientY,
                      html: (
                        <>
                          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-lo)", marginBottom: 3 }}>{fmtM(`${d.m}-01`)}</div>
                          <div><b>marża {fmtC(d.marza, 1)}%</b></div>
                          <div style={{ color: "var(--text-mid)", marginTop: 3 }}>sprzedano {fmtNum(d.qty)} szt</div>
                          <div style={{ color: "var(--text-mid)" }}>przychód {fmtNum(d.rev)} zł netto</div>
                          <div style={{ color: "var(--critical)" }}>koszt własny {fmtC(d.kw)} zł/szt = {fmtNum(d.koszt)} zł</div>
                        </>
                      ),
                    })}
                    onMouseLeave={() => setTip(null)} />
                </g>
              );
            })}
            <path d={dane.map((d, i) => `${i ? "L" : "M"}${X(i)} ${Ym(d.marza)}`).join(" ")}
                  fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
            {[min.marza, max.marza].map((p, i) => (
              <text key={i} x={W - R + 6} y={Ym(p) + 3.5} fill="var(--accent)" fontSize={10} fontFamily="var(--font-mono)" opacity={0.8}>
                {fmtC(p, 0)}%
              </text>
            ))}
          </svg>
          <Tooltip tip={tip} />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "9px 14px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-elevated)", fontSize: 10, color: "var(--text-lo)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 8, background: "var(--surface-3)" }} />przychód netto</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 8, background: "oklch(0.640 0.190 25 / .55)" }} />koszt własny</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 2, background: "var(--accent)" }} />marża %</span>
        </div>
      </div>

      <div style={note}>
        Koszt własny to <span className="mono">Rozchody.KosztMagazynowy</span> — ile Subiekt po FIFO
        przypisał do konkretnych sprzedanych sztuk, a nie średnia cena zakupu. Przychód netto pochodzi
        z faktur. Wykres sięga tylko tam, gdzie są oba źródła: sprzedaż jest liczona od stycznia
        zeszłego roku, więc wcześniejsze miesiące historii tu nie wejdą.
      </div>
    </div>
  );
}

// ── 3. KOSZT: CO PŁACIMY vs CO SPRZEDAJEMY ───────────────────
function KosztLag({ h }: { h: Historia }) {
  const [tip, setTip] = useState<Tip>(null);

  const zakupy = useMemo(
    () => h.przyjecia.filter((p) => p.typ === "ZAKUP" && p.koszt_jednostkowy != null),
    [h.przyjecia],
  );
  const cogs = useMemo(
    () => h.stan_miesiecznie.filter((p) => p.koszt_wlasny != null && p.wydano > 0),
    [h.stan_miesiecznie],
  );

  if (zakupy.length < 2 || cogs.length < 3) return null;

  const W = 720, H = 240, L = 52, R = 16, T = 20, B = 34;
  const wszystkie = [
    ...zakupy.map((p) => p.koszt_jednostkowy as number),
    ...cogs.map((p) => p.koszt_wlasny as number),
  ];
  const lo = Math.min(...wszystkie) * 0.92, hi = Math.max(...wszystkie) * 1.06;
  const t0 = new Date(h.stan_miesiecznie[0].miesiac).getTime();
  const t1 = new Date(h.stan_miesiecznie[h.stan_miesiecznie.length - 1].miesiac).getTime();
  const X = (t: number) => L + ((t - t0) / Math.max(t1 - t0, 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);

  const lata = [...new Set(h.stan_miesiecznie.map((p) => p.miesiac.slice(0, 4)))];

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Co płacimy dziś, a co sprzedajemy</span>
        <span style={sectHint}>magazyn działa jak bufor</span>
      </div>

      <div style={box}>
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: H }}>
            {[0, 1, 2, 3].map((i) => {
              const v = lo + ((hi - lo) * i) / 3, y = Y(v);
              return (
                <g key={i}>
                  <line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={L - 8} y={y + 3.5} textAnchor="end" fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">{fmtC(v, 0)}</text>
                </g>
              );
            })}
            {lata.map((y) => {
              const t = new Date(`${y}-01-01`).getTime();
              if (t < t0 || t > t1) return null;
              return (
                <g key={y}>
                  <line x1={X(t)} x2={X(t)} y1={T} y2={H - B} stroke="var(--border-soft)" strokeWidth={1} strokeDasharray="2 4" />
                  <text x={X(t) + 4} y={H - B + 14} fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">{y}</text>
                </g>
              );
            })}

            <path d={cogs.map((p, i) => {
              const t = new Date(p.miesiac).getTime() + 15 * 86400000;
              return `${i ? "L" : "M"}${X(t)} ${Y(p.koszt_wlasny as number)}`;
            }).join(" ")} fill="none" stroke="var(--critical)" strokeWidth={2} strokeLinejoin="round" />

            {zakupy.map((p, i) => {
              const cx = X(new Date(p.data).getTime());
              const cy = Y(p.koszt_jednostkowy as number);
              return (
                <circle key={i} cx={cx} cy={cy} r={4} fill="var(--info)" stroke="var(--bg)" strokeWidth={1.5}
                  style={{ cursor: "pointer" }}
                  onMouseMove={(e) => setTip({
                    x: e.clientX, y: e.clientY,
                    html: (
                      <>
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-lo)", marginBottom: 3 }}>
                          {fmtD(p.data)}{p.numer_dokumentu ? ` · ${p.numer_dokumentu}` : ""}
                        </div>
                        <div><b>{fmtNum(p.ilosc)} szt</b>{p.dostawca ? ` · ${p.dostawca}` : ""}</div>
                        <div style={{ color: "var(--info)", marginTop: 3 }}>zapłacone {fmtC(p.koszt_jednostkowy as number)} zł/szt</div>
                      </>
                    ),
                  })}
                  onMouseLeave={() => setTip(null)} />
              );
            })}
          </svg>
          <Tooltip tip={tip} />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "9px 14px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-elevated)", fontSize: 10, color: "var(--text-lo)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 99, background: "var(--info)" }} />koszt nowej dostawy</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 2, background: "var(--critical)" }} />koszt własny sprzedanej sztuki (FIFO)</span>
        </div>
      </div>

      <div style={note}>
        Kropki to cena, jaką płacicie za nowy towar. Czerwona linia to koszt tych sztuk, które
        faktycznie wyszły z magazynu w danym miesiącu. Odstęp między nimi to opóźnienie magazynowe —
        obniżka u dostawcy dociera do wyniku dopiero wtedy, gdy skończy się starszy, droższy zapas.
        To jest odpowiedź na pytanie „obniżyliśmy zakup, czemu marża nie rośnie”.
      </div>
    </div>
  );
}

// ── 4. NARZUT LOGISTYCZNY ────────────────────────────────────
function NarzutLogistyczny({ h }: { h: Historia }) {
  const [tip, setTip] = useState<Tip>(null);

  const dane = useMemo(
    () => h.przyjecia.filter((p) => p.typ === "ZAKUP" && p.logistyka_pln != null),
    [h.przyjecia],
  );

  // Zakup krajowy nie ma frachtu z definicji — rozpoznajemy go po tym,
  // że dostawca ma NIP-owy zapis w bazie? Nie mamy tego pola, więc
  // używamy kursu: zakup rozliczany w PLN (kurs 1) traktujemy jako
  // krajowy. Zero frachtu przy imporcie jest podejrzane, przy zakupie
  // złotówkowym — normalne.
  const jestImportem = (p: Przyjecie) => p.kurs != null && Math.abs(p.kurs - 1) > 0.001;

  const anomalie = useMemo(
    () => dane.filter((p) => jestImportem(p) && !p.skorygowane && Math.abs(p.logistyka_pln as number) < 0.02),
    [dane],
  );

  const stat = useMemo(() => {
    const imp = dane.filter((p) => jestImportem(p) && !p.skorygowane);
    if (!imp.length) return null;
    const q = imp.reduce((s, p) => s + p.ilosc, 0);
    const log = imp.reduce((s, p) => s + (p.logistyka_pln as number) * p.ilosc, 0) / q;
    const koszt = imp.reduce((s, p) => s + (p.koszt_jednostkowy as number) * p.ilosc, 0) / q;
    return { log, udzial: (log / koszt) * 100, max: Math.max(...imp.map((p) => p.logistyka_pln as number)) };
  }, [dane]);

  if (dane.length < 3) return null;

  const W = 720, H = 220, L = 56, R = 16, T = 20, B = 34;
  const maxL = Math.max(...dane.map((p) => p.logistyka_pln as number), 1) * 1.14;
  const X = (i: number) => L + (i + 0.5) * (W - L - R) / dane.length;
  const Y = (v: number) => T + (1 - v / maxL) * (H - T - B);
  const bw = ((W - L - R) / dane.length) * 0.7;

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Narzut logistyczny na dostawę</span>
        <span style={sectHint}>fracht i cło rozrzucone przez Subiekta</span>
      </div>

      <div style={box}>
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: H }}>
            {[0, 1, 2, 3].map((i) => {
              const v = (maxL * i) / 3, y = Y(v);
              return (
                <g key={i}>
                  <line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={L - 8} y={y + 3.5} textAnchor="end" fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">{fmtC(v, 0)} zł</text>
                </g>
              );
            })}
            {dane.map((p, i) => {
              const log = p.logistyka_pln as number;
              const zeroImport = jestImportem(p) && !p.skorygowane && Math.abs(log) < 0.02;
              const kolor = zeroImport ? "var(--critical)" : jestImportem(p) ? "var(--info)" : "var(--anomaly)";
              const y = Y(Math.max(log, 0));
              return (
                <g key={i}>
                  <rect x={X(i) - bw / 2} y={zeroImport ? H - B - 3 : y} width={bw}
                        height={zeroImport ? 3 : Math.max(0, H - B - y)} fill={kolor} rx={2} />
                  {zeroImport && (
                    <text x={X(i)} y={H - B - 8} textAnchor="middle" fill="var(--critical)" fontSize={15} fontWeight={700}>!</text>
                  )}
                  <rect x={X(i) - bw / 2 - 1} y={T} width={bw + 2} height={H - T - B} fill="transparent" style={{ cursor: "pointer" }}
                    onMouseMove={(e) => setTip({
                      x: e.clientX, y: e.clientY,
                      html: (
                        <>
                          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-lo)", marginBottom: 3 }}>
                            {fmtD(p.data)}{p.numer_dokumentu ? ` · ${p.numer_dokumentu}` : ""}
                          </div>
                          <div><b>{p.dostawca || "—"}</b> · {fmtNum(p.ilosc)} szt</div>
                          <div style={{ color: "var(--text-mid)", marginTop: 3 }}>
                            towar {fmtC(p.towar_pln ?? 0)} zł + logistyka {fmtC(log)} zł
                          </div>
                          <div style={{ color: "var(--text-mid)" }}>
                            = {fmtC(p.koszt_jednostkowy as number)} zł/szt ({fmtC(log / (p.koszt_jednostkowy as number) * 100, 1)}%)
                          </div>
                          {p.skorygowane && <div style={{ color: "var(--warning)", marginTop: 3 }}>skorygowane KPZ — korekta zastępuje też fracht</div>}
                          {zeroImport && <div style={{ color: "var(--critical)", marginTop: 3 }}>import bez frachtu — do sprawdzenia</div>}
                        </>
                      ),
                    })}
                    onMouseLeave={() => setTip(null)} />
                </g>
              );
            })}
          </svg>
          <Tooltip tip={tip} />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "9px 14px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-elevated)", fontSize: 10, color: "var(--text-lo)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 8, background: "var(--info)" }} />import</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 8, background: "var(--anomaly)" }} />zakup w PLN</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 8, background: "var(--critical)" }} />import bez frachtu</span>
        </div>
      </div>

      <div style={note}>
        {stat && (
          <>Import: średni narzut <b>{fmtC(stat.log)} zł/szt</b>, czyli {fmtC(stat.udzial, 1)}% kosztu,
          przy rozrzucie od 0 do {fmtC(stat.max)} zł. </>
        )}
        Zakupy rozliczane w złotówkach mają zero frachtu i tak ma być — to towar krajowy.
        {anomalie.length > 0 && (
          <> <b style={{ color: "var(--critical)" }}>
            Ale {anomalie.length} {anomalie.length === 1 ? "import ma" : "importy mają"} zerowy fracht:{" "}
            {anomalie.map((p) => p.numer_dokumentu).filter(Boolean).join(", ")}.
          </b>{" "}
          Albo koszty poszły w całości na inne pozycje tego kontenera, albo ich nie wprowadzono —
          w drugim przypadku ta dostawa wygląda taniej, niż była.</>
        )}
      </div>
    </div>
  );
}
