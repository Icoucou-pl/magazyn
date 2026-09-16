"use client";
// ============================================================
// MAGAZYN — Zakładka „Historia produktu”.
//
// Dawniej „2.0” — nazwa wzięła się stąd, że przez jakiś czas istniała obok
// starszej wersji. Ta została usunięta z modala, więc zostaje jedna historia
// i jedna nazwa. Plik `product-lifecycle.tsx` żyje dalej, bo eksportuje
// kafelki, krzywe i typy, z których ta zakładka korzysta.
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
  KrzywaCeny, KrzywaStanu, OsCzasu, Podsumowanie, TabelaPrzyjec, Tooltip, rowneIndeksy,
  box, fmtC, fmtD, fmtM, note, sect, sectHead, sectHint, sectTitle, useSzerokoscWykresu,
  type Historia, type Przyjecie, type Tip,
} from "./product-lifecycle";

type SeasonPoint = { year: number; month: number; qty: number; value_net: number; value_gross: number };

// ============================================================
export default function LifecycleTabV2({ sku, shop, showFin }: { sku: string; shop?: string; showFin: boolean }) {
  const [h, setH] = useState<Historia | null>(null);
  const [season, setSeason] = useState<SeasonPoint[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setH(null); setSeason(null); setErr(false);
    // Źródło danych wskazuje `shop` — patrz komentarz w product-lifecycle.tsx.
    api.get(`/products/${encodeURIComponent(sku)}/historia${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`)
      .then((d) => { if (alive) setH(d as Historia); })
      .catch(() => { if (alive) setErr(true); });
    // Przychód jest opcjonalny — bez niego po prostu nie ma wykresu marży.
    api.get(`/products/${encodeURIComponent(sku)}/sales-season`)
      .then((d) => { if (alive) setSeason(d as SeasonPoint[]); })
      .catch(() => { if (alive) setSeason([]); });
    return () => { alive = false; };
  }, [sku, shop]);

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

// Sekcja „Ile kosztowały braki towaru" została usunięta. Był to SZACUNEK
// utraconej sprzedaży (popyt sprzed roku minus to, co dało się sprzedać), a
// nie pomiar — przy krótkiej historii Acti i Veluxy nie miał nawet z czym
// porównywać i pokazywał same zera z dopiskiem „pierwszy rok".
//
// ── 2. MARŻA W CZASIE ────────────────────────────────────────
function MarzaWCzasie({ h, season }: { h: Historia; season: SeasonPoint[] | null }) {
  const { ref: refWykresu, w: W } = useSzerokoscWykresu();
  const waski = W < 520;
  const [tip, setTip] = useState<Tip>(null);

  const dane = useMemo(() => {
    if (!season?.length) return [];
    // Ilość i przychód MUSZĄ pochodzić z tego samego źródła. Wcześniej
    // koszt liczył się od `wydano` (cały rozchód, z RW i zwrotami do
    // dostawcy), a przychód od sprzedaży — stąd ujemne marże w
    // miesiącach z dużym RW.
    const sprzedaz = new Map<string, { net: number; qty: number }>();
    for (const s of season) {
      sprzedaz.set(`${s.year}-${String(s.month + 1).padStart(2, "0")}`, { net: s.value_net, qty: s.qty });
    }
    return h.stan_miesiecznie
      .map((p) => {
        const m = p.miesiac.slice(0, 7);
        const s = sprzedaz.get(m);
        if (!s || s.net <= 0 || s.qty <= 0 || p.koszt_wlasny == null) return null;
        const koszt = s.qty * p.koszt_wlasny;
        // Koszt własny zero przy realnej sprzedaży to BRAK DANYCH, nie zysk
        // stuprocentowy. Subiekt nie przypisał kosztu, bo nie miał z czego:
        // sprzedaż ze stanu ujemnego (brak warstwy), przyjęcie bez wyceny
        // albo towar wjechał jako gratis. Marża „100%" byłaby wtedy fikcją.
        return {
          m, rev: s.net, koszt, qty: s.qty, kw: p.koszt_wlasny,
          marza: ((s.net - koszt) / s.net) * 100,
          brakKosztu: p.koszt_wlasny === 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [h.stan_miesiecznie, season]);

  if (!season) return <div style={{ height: 260, ...box, ...sect }} className="pulse-soft" />;
  if (dane.length < 3) return null;

  const H = waski ? 230 : 280;
  const L = waski ? 50 : 58, R = waski ? 34 : 44, T = 20, B = 34;
  // OŚ OBEJMUJE WSZYSTKIE MIESIĄCE, także te bez sprzedaży.
  //
  // Wcześniej wykres rysował wyłącznie miesiące z obrotem, a resztę po prostu
  // pomijał — przez co 03.26 i 05.26 stały obok siebie, jakby nic ich nie
  // dzieliło. Kwiecień w Pod_1b nie zniknął przez błąd: po prostu nic wtedy
  // nie zeszło, więc nie ma z czego policzyć marży. Ale na osi czasu musi
  // zostać dziura, bo inaczej wykres kłamie o tempie sprzedaży.
  const osMiesiecy = h.stan_miesiecznie
    .map((p) => p.miesiac.slice(0, 7))
    .filter((m) => m >= dane[0].m && m <= dane[dane.length - 1].m);
  const poz = new Map(osMiesiecy.map((m, i) => [m, i]));

  const maxV = Math.max(...dane.map((d) => d.rev)) * 1.1;
  const X = (i: number) => L + (i + 0.5) * (W - L - R) / osMiesiecy.length;
  const Y = (v: number) => T + (1 - v / maxV) * (H - T - B);
  // SKALA ODPORNA NA ABSURDY.
  //
  // Marża to (przychód − koszt) / przychód, więc miesiąc z groszowym przychodem
  // i normalnym kosztem własnym daje liczby w rodzaju −72 409%. Jedna taka
  // wartość rozciągała skalę tak, że cała reszta linii kładła się płasko przy
  // górnej krawędzi i wykres przestawał cokolwiek znaczyć. Widać to było na
  // cyrkoniach: koszt 680 zł przy przychodzie 0,94 zł.
  //
  // Skalę liczymy więc z wartości ROZSĄDNYCH (od −100% wzwyż — niżej marża i
  // tak znaczy tylko „sprzedane poniżej kosztu"), a punkty spoza zakresu
  // przycinamy do krawędzi i oznaczamy na czerwono. Nic nie znika, ale też nic
  // nie psuje odczytu pozostałych miesięcy.
  // „Rozsądna" znaczy: mieści się w skali ORAZ ma z czego być policzona.
  const ROZSADNA = (d: { marza: number; brakKosztu: boolean }) =>
    !d.brakKosztu && d.marza >= -100 && d.marza <= 100;
  const rozsadne = dane.filter(ROZSADNA);
  const bazowe = rozsadne.length ? rozsadne : dane;
  const mLo = Math.max(-100, Math.min(...bazowe.map((d) => d.marza)) - 5);
  const mHi = Math.min(100, Math.max(...bazowe.map((d) => d.marza)) + 5);
  const Ym = (p: number) => {
    const przyciete = Math.min(Math.max(p, mLo), mHi);
    return T + (1 - (przyciete - mLo) / (mHi - mLo || 1)) * (H - T - B);
  };
  const bw = ((W - L - R) / osMiesiecy.length) * 0.72;
  const xm = (m: string) => X(poz.get(m) ?? 0);

  // Średnia ważona obrotem — odporna z natury, bo miesiąc z groszowym
  // przychodem prawie nic w niej nie waży.
  const sr = dane.reduce((s, d) => s + d.rev - d.koszt, 0) / dane.reduce((s, d) => s + d.rev, 0) * 100;
  const min = bazowe.reduce((a, b) => (b.marza < a.marza ? b : a));
  const max = bazowe.reduce((a, b) => (b.marza > a.marza ? b : a));
  const bezKosztu = dane.filter((d) => d.brakKosztu);
  const pozaSkala = dane.filter((d) => !d.brakKosztu && !ROZSADNA(d));

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
            {pozaSkala.length > 0 && (
              <span style={{ color: "var(--critical)" }}>
                {" · "}{pozaSkala.length} {pozaSkala.length === 1 ? "miesiąc" : "miesiące"} poza skalą
                {" "}({pozaSkala.map((d) => fmtM(`${d.m}-01`)).join(", ")}) — przychód bliski zeru przy realnym koszcie
              </span>
            )}
            {bezKosztu.length > 0 && (
              <span style={{ color: "var(--text-lo)" }}>
                {" · "}{bezKosztu.length} bez kosztu własnego
                {" "}({bezKosztu.map((d) => fmtM(`${d.m}-01`)).join(", ")}) — Subiekt nie przypisał warstwy,
                {" "}marży tam nie liczymy
              </span>
            )}
          </div>
        </div>

        <div ref={refWykresu} style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: H }}>
            {[0, 1, 2, 3].map((i) => {
              const v = (maxV * i) / 3, y = Y(v);
              return (
                <g key={i}>
                  <line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={L - 8} y={y + 3.5} textAnchor="end" fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">
                    {/* Zaokrąglone do pełnych tysięcy. `fmtNum(v / 1000)` dawało
                        „58,993k" — siedem znaków, które nie mieściły się w
                        marginesie i traciły pierwszą cyfrę. */}
                    {fmtNum(Math.round(v / 1000))}k
                  </text>
                </g>
              );
            })}
            {/* Podpisy miesięcy. Wcześniej oś X pokazywała wyłącznie rok, i to
                tylko na styczniu — przy historii krótszej niż rok nie było na
                niej nic. */}
            {rowneIndeksy(osMiesiecy.length, waski ? 3 : 6).map((i, idx, tab) => (
              <text key={osMiesiecy[i]} x={X(i)} y={H - B + 14}
                    textAnchor={idx === 0 ? "start" : idx === tab.length - 1 ? "end" : "middle"}
                    fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">
                {fmtM(`${osMiesiecy[i]}-01`)}
              </text>
            ))}

            {dane.map((d) => {
              const yP = Y(d.rev), yK = Y(d.koszt);
              return (
                <g key={d.m}>
                  <rect x={xm(d.m) - bw / 2} y={yP} width={bw} height={Math.max(0, H - B - yP)} fill="var(--surface-3)" rx={2} />
                  <rect x={xm(d.m) - bw / 2} y={yK} width={bw} height={Math.max(0, H - B - yK)} fill="oklch(0.640 0.190 25 / .55)" rx={2} />

                  <rect x={xm(d.m) - bw / 2 - 1} y={T} width={bw + 2} height={H - T - B} fill="transparent" style={{ cursor: "pointer" }}
                    onMouseMove={(e) => setTip({
                      x: e.clientX, y: e.clientY,
                      html: (
                        <>
                          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-lo)", marginBottom: 3 }}>{fmtM(`${d.m}-01`)}</div>
                          <div><b>{d.brakKosztu ? "marży nie da się policzyć" : `marża ${fmtC(d.marza, 1)}%`}</b></div>
                          <div style={{ color: "var(--text-mid)", marginTop: 3 }}>sprzedano {fmtNum(d.qty)} szt wg zamówień</div>
                          <div style={{ color: "var(--text-mid)" }}>przychód {fmtNum(d.rev)} zł netto</div>
                          {d.brakKosztu ? (
                            <div style={{ color: "var(--text-lo)", marginTop: 3 }}>
                              Subiekt nie przypisał kosztu własnego — sprzedaż ze stanu ujemnego,
                              przyjęcie bez wyceny albo towar gratis. „100%" byłoby fikcją.
                            </div>
                          ) : (
                            <div style={{ color: "var(--critical)" }}>koszt własny {fmtC(d.kw)} zł/szt = {fmtNum(d.koszt)} zł</div>
                          )}
                        </>
                      ),
                    })}
                    onMouseLeave={() => setTip(null)} />
                </g>
              );
            })}
            {/* Miesiące poza skalą dostają czerwoną kropkę na krawędzi — linia
                jest tam przycięta, więc bez tego znacznika wyglądałaby po
                prostu na płaską. */}
            {dane.map((d) => (ROZSADNA(d) ? null : (
              <circle key={`out${d.m}`} cx={xm(d.m)} cy={Ym(d.marza)} r={3.5}
                      fill={d.brakKosztu ? "var(--text-lo)" : "var(--critical)"}
                      stroke="var(--surface-1)" strokeWidth={1.5}>
                <title>{d.brakKosztu
                  ? `${fmtM(`${d.m}-01`)} — Subiekt nie przypisał kosztu własnego, marży nie da się policzyć`
                  : `${fmtM(`${d.m}-01`)} — marża ${fmtC(d.marza, 0)}%, poza skalą wykresu`}</title>
              </circle>
            )))}

            {/* Miesiąc bez sprzedaży: pionowa jasna kolumna zamiast gołej dziury.
                Sama luka w słupkach wyglądała jak błąd rysowania, a jest
                informacją — w tym miesiącu nic nie zeszło. */}
            {osMiesiecy.map((m, i) => (dane.some((d) => d.m === m) ? null : (
              <g key={`pusty${m}`}>
                <rect x={X(i) - bw / 2} y={T} width={bw} height={H - T - B}
                      fill="var(--surface-2)" opacity={0.5} rx={2} />
                <text x={X(i)} y={(T + H - B) / 2} textAnchor="middle"
                      fill="var(--text-disabled)" fontSize={9} fontFamily="var(--font-mono)">
                  brak
                </text>
              </g>
            )))}

            {/* Linia marży: pełna między sąsiednimi miesiącami, PRZERYWANA nad
                miesiącem bez sprzedaży. Ciągła sugerowałaby, że coś się w tym
                czasie działo; całkowite urwanie wyglądało z kolei na usterkę. */}
            <path d={rozsadne.map((d, i) => {
              const poprz = i ? rozsadne[i - 1] : null;
              const ciagle = poprz != null && (poz.get(d.m) ?? 0) - (poz.get(poprz.m) ?? 0) === 1;
              return `${ciagle ? "L" : "M"}${xm(d.m)} ${Ym(d.marza)}`;
            }).join(" ")}
                  fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />

            <path d={rozsadne.map((d, i) => {
              const poprz = i ? rozsadne[i - 1] : null;
              if (!poprz || (poz.get(d.m) ?? 0) - (poz.get(poprz.m) ?? 0) === 1) return "";
              return `M${xm(poprz.m)} ${Ym(poprz.marza)} L${xm(d.m)} ${Ym(d.marza)}`;
            }).join(" ")}
                  fill="none" stroke="var(--accent)" strokeWidth={1.6}
                  strokeDasharray="3 4" opacity={0.55} />
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
        przypisał do sprzedanych sztuk, a nie średnia cena zakupu; przy kilku warstwach w miesiącu
        jest to średnia ważona ilością. Liczy się <b>wyłącznie rozchód na WZ</b> — RW i zwroty do
        dostawcy schodzą ze stanu, ale nie są sprzedażą i do marży nie wchodzą. Ilość i przychód
        netto pochodzą z tego samego źródła, czyli z pozycji zamówień. Wykres sięga tylko tam, gdzie
        są oba źródła: sprzedaż jest liczona od stycznia zeszłego roku, więc wcześniejsze miesiące
        historii tu nie wejdą.
      </div>
    </div>
  );
}

// ── 3. KOSZT: CO PŁACIMY vs CO SPRZEDAJEMY ───────────────────
function KosztLag({ h }: { h: Historia }) {
  const { ref: refWykresu, w: W } = useSzerokoscWykresu();
  const waski = W < 520;
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

  const H = waski ? 200 : 240;
  const L = waski ? 46 : 52, R = waski ? 18 : 16, T = 20, B = 34;
  const wszystkie = [
    ...zakupy.map((p) => p.koszt_jednostkowy as number),
    ...cogs.map((p) => p.koszt_wlasny as number),
  ];
  const lo = Math.min(...wszystkie) * 0.92, hi = Math.max(...wszystkie) * 1.06;
  // Oś czasu musi obejmować TAKŻE dostawy, nie tylko miesiące.
  //
  // Miesiące mają datę pierwszego dnia (2026-09-01), a dostawa z 09.09 wypada
  // PO ostatnim z nich — więc przy skali liczonej na samych miesiącach jej
  // kropka lądowała poza obszarem wykresu, za osią, w rogu panelu. Dlatego
  // koniec osi to późniejsza z dwóch dat.
  const daty = zakupy.map((d) => new Date(d.data).getTime());
  const t0 = Math.min(new Date(h.stan_miesiecznie[0].miesiac).getTime(), ...daty);
  const t1 = Math.max(
    new Date(h.stan_miesiecznie[h.stan_miesiecznie.length - 1].miesiac).getTime(),
    ...daty,
  );
  // Odstęp z prawej, żeby ostatni punkt i czerwona linia nie dobijały do samej
  // krawędzi — wyglądało to, jakby wykres był ucięty w połowie miesiąca.
  const PR = waski ? 16 : 24;
  const X = (t: number) => {
    const x = L + ((t - t0) / Math.max(t1 - t0, 1)) * (W - L - R - PR);
    // Siatka bezpieczeństwa: nic nie ma prawa wyjechać poza obszar rysowania,
    // nawet gdy do danych wpadnie data spoza zakresu.
    return Math.min(Math.max(x, L), W - R - PR);
  };
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);

  const lata = [...new Set(h.stan_miesiecznie.map((p) => p.miesiac.slice(0, 4)))];

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Co płacimy dziś, a co sprzedajemy</span>
        <span style={sectHint}>magazyn działa jak bufor</span>
      </div>

      <div style={box}>
        <div ref={refWykresu} style={{ position: "relative" }}>
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
                  {/* Sama kreska. Podpis roku nakładał się na podpisy
                      miesięcy, które i tak niosą rok („09.26"). */}
                  <line x1={X(t)} x2={X(t)} y1={T} y2={H - B} stroke="var(--border-soft)" strokeWidth={1} strokeDasharray="2 4" />
                </g>
              );
            })}

            {/* Podpisy miesięcy. Wcześniej oś X miała wyłącznie kreski na
                początkach lat — przy historii mieszczącej się w jednym roku
                (Acti, Veluxa) nie było na niej ANI JEDNEGO podpisu i nie dało
                się odczytać, czego dotyczą kropki. */}
            {(() => {
              const ms = h.stan_miesiecznie;
              const ile = Math.min(waski ? 3 : 5, ms.length);
              if (ile < 2) return null;
              return Array.from({ length: ile }, (_, k) => {
                const p = ms[Math.round((k * (ms.length - 1)) / (ile - 1))];
                const t = new Date(p.miesiac).getTime();
                const x = X(t);
                return (
                  <text key={p.miesiac} x={x} y={H - B + 14}
                        textAnchor={k === 0 ? "start" : k === ile - 1 ? "end" : "middle"}
                        fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">
                    {fmtM(p.miesiac)}
                  </text>
                );
              });
            })()}

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
  const { ref: refWykresu, w: W } = useSzerokoscWykresu();
  const waski = W < 520;
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

  const H = waski ? 190 : 220;
  const L = waski ? 48 : 56, R = waski ? 18 : 16, T = 20, B = 34;
  const maxL = Math.max(...dane.map((p) => p.logistyka_pln as number), 1) * 1.14;
  const X = (i: number) => L + (i + 0.5) * (W - L - R) / dane.length;
  const Y = (v: number) => T + (1 - v / maxL) * (H - T - B);
  const bw = ((W - L - R) / dane.length) * 0.7;

  // Wszystkie zakupy w PLN, zero frachtu na każdej pozycji — wykres słupkowy
  // rysowałby wtedy samą pustą siatkę z osią „0 zł, 0 zł, 1 zł, 1 zł", bo skala
  // nie ma z czego wyjść. Zamiast pustego prostokąta mówimy wprost, dlaczego
  // nie ma czego pokazać. Tak wygląda Pod_1b w AMH: towar kupowany od Veluxy,
  // rozliczany w złotówkach, więc fracht siedzi po stronie Veluxy.
  const maLogistyke = dane.some((p) => (p.logistyka_pln as number) > 0);
  if (!maLogistyke) {
    return (
      <div style={sect}>
        <div style={sectHead}>
          <span style={sectTitle}>Narzut logistyczny na dostawę</span>
          <span style={sectHint}>brak frachtu na tych zakupach</span>
        </div>
        <div style={{ ...box, padding: "16px 18px" }}>
          <p style={{ ...note, margin: 0 }}>
            Żadna z {dane.length} dostaw nie ma doliczonego frachtu ani cła —
            wszystkie rozliczone w złotówkach. Przy zakupie krajowym tak ma być:
            koszt transportu siedzi u dostawcy, nie u nas. Wykres pojawi się,
            gdy trafi się import z rozrzuconymi kosztami dodatkowymi.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Narzut logistyczny na dostawę</span>
        <span style={sectHint}>fracht i cło rozrzucone przez Subiekta</span>
      </div>

      <div style={box}>
        <div ref={refWykresu} style={{ position: "relative" }}>
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
