"use client";
// ============================================================
// MAGAZYN — Zakładka „Historia produktu”.
//
// WIDOCZNA WYŁĄCZNIE DLA SUPER-ADMINA. Modal decyduje o tym sam
// (patrz product-modal.tsx); ten komponent nie zna uprawnień —
// jeśli endpoint zwróci 404, po prostu nic nie renderuje.
//
// Źródło: GET /products/{sku}/historia (routers/product_history.py).
// Dane pochodzą z Subiekta, więc SKU spoza niego (Acti/Veluxa)
// dostaną 404 i zakładka się nie pojawi — tak ma być na tym etapie.
//
// ZWROTY. Backend wlicza je do `przyjeto`, bo tylko wtedy krzywa
// stanu się domyka. Ale zwrot 4 sztuk narysowany jako kropka
// dostawy wygląda jak mikrodostawa i wprowadza w błąd, więc na
// wykresie kropki rysujemy WYŁĄCZNIE dla realnych dostaw
// (z listy przyjęć typu ZAKUP). Zwroty żyją w tooltipie.
// ============================================================

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/format";

// ── Typy odpowiedzi API ──────────────────────────────────────
export type Przyjecie = {
  data: string; typ: string; magazyn_id: number; magazyn_zrodlowy: number | null;
  ilosc: number; koszt_jednostkowy: number | null; cena_waluta: number | null;
  kurs: number | null; towar_pln: number | null; logistyka_pln: number | null;
  skorygowane: boolean; dokument: string | null; numer_dokumentu: string | null;
  dostawca: string | null;
  // Przyjęcie trafiło na magazyn „w drodze" — towar jest kupiony i wbity do
  // ERP, ale jeszcze płynie. Dostawą nazywamy dopiero wjazd na magazyn główny.
  w_drodze?: boolean;
  wewnetrzne?: boolean;
};
// `wydano` — cały rozchód poza przesunięciami (tym cofa się stan).
// `sprzedano` — wyłącznie sprzedaż. Różnica to RW i zwroty do
// dostawcy: schodzą z magazynu, ale nie mają przychodu.
export type PunktStanu = {
  miesiac: string; przyjeto: number; wydano: number; sprzedano: number; stan: number;
  // Stan samego magazynu głównego. `stan` obejmuje też towar w drodze, więc
  // sam potrafi zamaskować pusty magazyn — pokrycie liczymy z tego pola.
  stan_polka?: number | null;
  koszt_wlasny: number | null;
};
export type Dostawca = {
  nazwa: string; przyjec: number; ilosc: number; od: string; do: string;
  sredni_koszt: number | null;
};
export type Historia = {
  sku: string; stan_dzis: number;
  // Rozbicie kotwicy: ile leży na półce, a ile jest w drodze. Suma zostaje
  // podstawą krzywej, ale kafelek musi umieć powiedzieć, co to za sztuki.
  stan_magazyn?: number | null; stan_w_drodze?: number | null;
  pierwsze_przyjecie: string | null;
  liczba_zakupow: number; sprowadzono_szt: number; sprowadzono_pln: number;
  przyjecia: Przyjecie[]; stan_miesiecznie: PunktStanu[];
  // `miesiace_bez_pokrycia` — zapas główny nie pokrywał sprzedaży (łącznie z brakiem).
  // `miesiace_bez_towaru` — podzbiór: półka ≤ 0. Opcjonalne dla starszego backendu.
  dostawcy: Dostawca[]; miesiace_bez_pokrycia: string[]; miesiace_bez_towaru?: string[]; dryf: number;
};

// ── Pomocnicze ───────────────────────────────────────────────

export const fmtD = (s: string) => { const [y, m, d] = s.split("-"); return `${d}.${m}.${y}`; };
export const fmtM = (s: string) => { const [y, m] = s.split("-"); return `${m}.${y.slice(2)}`; };
export const fmtC = (n: number, d = 2) =>
  n.toLocaleString("pl-PL", { minimumFractionDigits: d, maximumFractionDigits: d });

export const MIES = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];

// Kolory dostawców — stabilne, przypisywane po kolejności pierwszego zakupu.
const PALETA = ["var(--accent)", "var(--anomaly)", "var(--info)", "var(--ok)", "var(--warning)"];

export const sect: React.CSSProperties = { marginBottom: 22 };
export const sectHead: React.CSSProperties = {
  display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap",
};
export const sectTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
  textTransform: "uppercase", color: "var(--text-mid)",
};
export const sectHint: React.CSSProperties = { fontSize: 11, color: "var(--text-lo)" };
export const box: React.CSSProperties = {
  background: "var(--surface-1)", border: "1px solid var(--border-soft)",
  borderRadius: 12, overflow: "hidden",
};
export const note: React.CSSProperties = {
  fontSize: 10.5, color: "var(--text-disabled)", lineHeight: 1.55, marginTop: 8,
};

export type Tip = { x: number; y: number; html: React.ReactNode } | null;

// ============================================================
export default function LifecycleTab({ sku, shop, showFin }: { sku: string; shop?: string; showFin: boolean }) {
  const [h, setH] = useState<Historia | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setH(null); setErr(false);
    // `shop` decyduje o źródle: pusty albo AMH → Subiekt, Acti/Veluxa →
    // ledger z Fakturowni. Bez niego zakładka pokazywała dane AMH nawet
    // wtedy, gdy fragmentator stał na innej spółce.
    api.get(`/products/${encodeURIComponent(sku)}/historia${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`)
      .then((d) => { if (alive) setH(d as Historia); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [sku, shop]);

  if (err) {
    return (
      <div style={{ ...box, padding: 22, textAlign: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-mid)" }}>
          Brak historii dla tego SKU
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginTop: 6, lineHeight: 1.6 }}>
          Historia pochodzi z Subiekta i obejmuje towar AMH od lipca 2023.
        </div>
      </div>
    );
  }

  if (!h) {
    return <div style={{ height: 420, ...box }} className="pulse-soft" />;
  }

  return (
    <div>
      <Podsumowanie h={h} showFin={showFin} />
      <KrzywaCeny h={h} />
      <KrzywaStanu h={h} />
      <OsCzasu h={h} />
      <TabelaPrzyjec h={h} />
    </div>
  );
}

// ── Kafelek KPI ──────────────────────────────────────────────
// Świadomie ten sam kształt co MetricBox w product-modal.tsx.
// Nie importuję go, bo tam jest lokalny — ale gdyby kiedyś został
// wyciągnięty do products-ui, ten komponent powinien zniknąć.
/** Zmierzona szerokość kontenera wykresu (w pikselach CSS).
 *
 *  Wykresy miały stały viewBox (700–720) i `width: 100%` przy stałej
 *  wysokości. Przeglądarka skaluje wtedy rysunek proporcjonalnie i CENTRUJE
 *  go: na szerokim ekranie zostawało po kilkadziesiąt pikseli pustki z każdej
 *  strony, a na telefonie wszystko kurczyło się do ~45% — razem z podpisami
 *  osi, które robiły się nieczytelne i wchodziły na siebie.
 *
 *  Rysujemy więc w układzie równym realnej szerokości kontenera, czyli 1:1.
 *  Marginesy są dokładnie takie, jakie wpiszemy, a tekst ma zawsze swój
 *  rozmiar — niezależnie od ekranu. */
/** Lista miesięcy „YYYY-MM" od `od` do `do` włącznie, bez dziur. */
export function zakresMiesiecy(od: string, doDaty: string): string[] {
  const [r0, m0] = od.slice(0, 7).split("-").map(Number);
  const [r1, m1] = doDaty.slice(0, 7).split("-").map(Number);
  const out: string[] = [];
  for (let r = r0, m = m0; r < r1 || (r === r1 && m <= m1); ) {
    out.push(`${r}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; r += 1; }
  }
  return out;
}

/** Które miesiące podpisać na osi X.
 *
 *  Wcześniej podpisy szły co równy INDEKS z listy tych miesięcy, które akurat
 *  miały dane — więc przy siedmiu miesiącach i sześciu podpisach wypadał
 *  środkowy, a przy osi czasowej podpisy lądowały w równych odstępach
 *  czasowych i wychodziło „03.26, 05.26, 06.26, 07.26, 09.26": wygląda równo,
 *  a raz oznacza miesiąc, raz dwa.
 *
 *  Teraz wybieramy co N-ty MIESIĄC KALENDARZOWY, zawsze z pierwszym i
 *  ostatnim. Odstęp między podpisami jest wtedy wszędzie taki sam. */
export function podpisyMiesiecy(miesiace: string[], maks: number): Set<string> {
  if (miesiace.length <= maks) return new Set(miesiace);
  const krok = Math.ceil(miesiace.length / maks);
  const out = new Set<string>();
  for (let i = 0; i < miesiace.length; i += krok) out.add(miesiace[i]);
  out.add(miesiace[miesiace.length - 1]);
  return out;
}

/** Indeksy równo rozłożone po osi — do podpisów miesięcy.
 *
 *  Wykresy podpisywały wyłącznie styczeń, więc przy historii mieszczącej się
 *  w jednym roku (Acti od 10.2025, Veluxa od 12.2024) oś X zostawała zupełnie
 *  pusta i nie dało się odczytać, czego dotyczy który słupek. */
export function rowneIndeksy(dlugosc: number, ile: number): number[] {
  if (dlugosc <= 0) return [];
  const n = Math.min(ile, dlugosc);
  if (n < 2) return [0];
  return Array.from({ length: n }, (_, k) => Math.round((k * (dlugosc - 1)) / (n - 1)));
}

export function useSzerokoscWykresu(fallback = 720) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    // Pomiar odkładamy do następnej klatki i ignorujemy drgania poniżej piksela.
    //
    // Bez tego łatwo o pętlę: obserwator mierzy kontener, pomiar zmienia stan,
    // stan przerysowuje wykres, przerysowanie zmienia wysokość kontenera —
    // i obserwator strzela znowu. W modalu takich obserwatorów jest pięć naraz
    // i wszystkie startują w tej samej chwili przy przełączeniu zakładki albo
    // firmy. Przeglądarka rzuca wtedy „ResizeObserver loop", a przy uporczywej
    // pętli potrafi ubić kartę.
    let klatka = 0;
    let ostatnia = 0;

    const ro = new ResizeObserver((wpisy) => {
      const szer = Math.round(wpisy[0]?.contentRect.width ?? 0);
      if (szer <= 0 || Math.abs(szer - ostatnia) < 1) return;
      ostatnia = szer;
      cancelAnimationFrame(klatka);
      klatka = requestAnimationFrame(() => setW(szer));
    });

    ro.observe(el);
    return () => { cancelAnimationFrame(klatka); ro.disconnect(); };
  }, []);
  return { ref, w };
}

export function Kafelek({ label, value, sub, tone = "neutral", dot }: {
  label: string; value: React.ReactNode; sub?: string;
  tone?: "neutral" | "critical" | "warning" | "info" | "ok"; dot?: string;
}) {
  const color = {
    neutral: "var(--text-hi)", critical: "var(--critical)",
    warning: "var(--warning)", info: "var(--info)", ok: "var(--ok)",
  }[tone];
  return (
    <div style={{ padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", display: "flex", alignItems: "center", gap: 5 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: 99, background: dot, flexShrink: 0 }} />}
        {label}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 600, color, lineHeight: 1.1, marginTop: 4, letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Pasek podsumowania ───────────────────────────────────────
export function Podsumowanie({ h, showFin }: { h: Historia; showFin: boolean }) {
  const wiek = useMemo(() => {
    if (!h.pierwsze_przyjecie) return "—";
    const od = new Date(h.pierwsze_przyjecie);
    const m = Math.round((Date.now() - od.getTime()) / 86400000 / 30.44);
    const lata = Math.floor(m / 12);
    return lata > 0 ? `${lata}l ${m % 12}m` : `${m}m`;
  }, [h.pierwsze_przyjecie]);

  const zmianaKosztu = useMemo(() => {
    const z = h.przyjecia.filter((p) => p.typ === "ZAKUP" && p.koszt_jednostkowy != null);
    if (z.length < 2) return null;
    const a = z[0].koszt_jednostkowy as number;
    const b = z[z.length - 1].koszt_jednostkowy as number;
    return ((b / a) - 1) * 100;
  }, [h.przyjecia]);

  // Ostatnia REALNA dostawa — zwroty i przesunięcia nie są dostawą,
  // a potrafią być świeższe i podawałyby fałszywą datę.
  // Dostawa = towar wjechał na magazyn główny i da się go wydać. Zakup wbity
  // na „w drodze" nią nie jest, choć w ERP wygląda tak samo. Szukamy więc
  // najpierw fizycznego przyjazdu, a dopiero gdy takiego nie ma, pokazujemy
  // ostatni zakup — wyraźnie podpisany, żeby nikt nie wziął płynącego
  // kontenera za towar na półce.
  const ostatnia = useMemo(() => {
    // Co jest „dostawą": towar KUPIONY, który wjechał na magazyn główny.
    // Zwrot od klienta i przyjęcie wewnętrzne wejściem na stan owszem są, ale
    // dostawą nie — a wcześniej wpadały tu razem z resztą i kafelek pokazywał
    // „+1 szt" z dnia zwrotu, podczas gdy w tabeli Przyjęć najnowszy wiersz
    // miał 20 szt sprzed tygodnia. Tabela pokazuje same zakupy, więc kafelek
    // musi liczyć to samo, inaczej dwie liczby na jednym ekranie przeczą sobie.
    const dostawa = (p: Przyjecie) => p.typ === "ZAKUP" || p.typ === "PRZESUNIECIE";
    const naMagazyn = h.przyjecia.filter((p) => !p.w_drodze && p.ilosc > 0 && dostawa(p));
    const zakupy = h.przyjecia.filter((p) => p.typ === "ZAKUP");
    const zrodlo = naMagazyn.length ? naMagazyn : zakupy;
    if (!zrodlo.length) return null;
    const last = zrodlo[zrodlo.length - 1];
    const dni = Math.round((Date.now() - new Date(last.data).getTime()) / 86400000);
    return { ...last, dni, doWDrodze: !naMagazyn.length };
  }, [h.przyjecia]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, ...sect }}>
      <Kafelek
        label="W ofercie"
        value={wiek}
        sub={h.pierwsze_przyjecie ? `od ${fmtD(h.pierwsze_przyjecie)}` : "brak przyjęć"} />
      <Kafelek
        label={ostatnia?.doWDrodze ? "Ostatni zakup" : "Ostatnia dostawa"}
        dot={ostatnia?.doWDrodze ? "var(--info)" : "var(--ok)"}
        value={ostatnia ? fmtD(ostatnia.data) : "—"}
        // Bez dopisku o towarze w drodze — to zakładka HISTORII, a płynący
        // kontener jest przyszłością. Stan bieżący i to, co jeszcze przypłynie,
        // stoi na Przeglądzie, w rozbiciu na magazyn, drogę i kontenery.
        sub={
          ostatnia
            ? `+${fmtNum(ostatnia.ilosc)} szt · ${ostatnia.dni} dni temu`
              + (ostatnia.doWDrodze ? " · na magazyn w drodze" : "")
            : "brak dostaw"
        }
        tone={ostatnia ? (ostatnia.doWDrodze ? "neutral" : "ok") : "neutral"} />
      {/* ZAKUP ≠ DOSTAWA.
          PZ powstaje w momencie zapłaty i wbicia towaru na magazyn „w drodze" —
          towar wtedy dopiero płynie. Dostawą jest przesunięcie na magazyn
          główny. Kafelek „Dostawy 4 · wejść z zewnątrz" przy czterech PZ
          sugerował cztery przypłynięcia, podczas gdy realnie przyjechał jeden
          kontener, a reszta jest na wodzie. */}
      {/* Liczba ZAMÓWIEŃ, nie „dostaw" — dokument PZ powstaje przy zapłacie i
          wbiciu towaru na magazyn „w drodze", więc towar wtedy dopiero płynie.
          Sztuki i kwota schodzą do podpisu: w historii częściej pyta się „ile
          razy to zamawialiśmy" niż o sumę sztuk od początku świata. */}
      <Kafelek
        label="Zamówienia"
        value={h.liczba_zakupow}
        sub={showFin
          ? `${fmtNum(h.sprowadzono_szt)} szt · ${fmtNum(h.sprowadzono_pln)} zł`
          : `${fmtNum(h.sprowadzono_szt)} szt`} />
      {/* Kafelek „Stan dziś" usunięty — to stan bieżący, a nie historia;
          na Przeglądzie stoi i tak, w rozbiciu na magazyn, towar w drodze
          i kontenery. `stan_dzis` zostaje w danych, bo to on kotwiczy krzywą
          stanu i z niego liczy się dryf. */}
      <Kafelek
        label="Zmiana kosztu"
        value={zmianaKosztu == null ? "—" : `${zmianaKosztu > 0 ? "+" : ""}${fmtC(zmianaKosztu, 1)}%`}
        sub="pierwsza vs ostatnia dostawa"
        tone={zmianaKosztu == null ? "neutral" : zmianaKosztu > 0 ? "critical" : "ok"} />
    </div>
  );
}

// ── Krzywa ceny zakupu ───────────────────────────────────────
type TrybCeny = "pln" | "waluta" | "split";

export function KrzywaCeny({ h }: { h: Historia }) {
  const { ref: refWykresu, w: W } = useSzerokoscWykresu();
  const waski = W < 520;
  const [tryb, setTryb] = useState<TrybCeny>("pln");
  const [tip, setTip] = useState<Tip>(null);

  const zakupy = useMemo(
    () => h.przyjecia.filter((p) => p.typ === "ZAKUP" && p.koszt_jednostkowy != null),
    [h.przyjecia],
  );

  // Kurs != 1 oznacza zakup rozliczany w obcej walucie. Przy zakupach
  // złotówkowych „cena w walucie” nie niesie żadnej informacji.
  const wWalucie = useMemo(
    () => zakupy.filter((p) => p.kurs != null && Math.abs((p.kurs as number) - 1) > 0.001),
    [zakupy],
  );

  const kolorDostawcy = useMemo(() => {
    const m = new Map<string, string>();
    h.dostawcy.forEach((d, i) => m.set(d.nazwa, PALETA[i % PALETA.length]));
    return m;
  }, [h.dostawcy]);

  if (zakupy.length < 2) return null;

  const dane = tryb === "waluta" ? wWalucie : zakupy;
  if (!dane.length) return null;

  const wartosc = (p: Przyjecie) =>
    tryb === "waluta" ? (p.cena_waluta as number) : (p.koszt_jednostkowy as number);

  const H = waski ? 200 : 240;
  const L = waski ? 46 : 52, R = waski ? 16 : 16, T = 22, B = 34;
  const gorne = dane.map((p) => (tryb === "split" ? (p.koszt_jednostkowy as number) : wartosc(p)));
  const dolne = tryb === "split"
    ? dane.map((p) => p.towar_pln ?? (p.koszt_jednostkowy as number))
    : gorne;
  const maxV = Math.max(...gorne), minV = Math.min(...dolne);
  const pad = (maxV - minV) * 0.28 || Math.max(1, maxV * 0.1);
  const lo = Math.max(0, minV - pad), hi = maxV + pad;

  const t0 = new Date(dane[0].data).getTime();
  const t1 = new Date(dane[dane.length - 1].data).getTime();
  const rozpietosc = Math.max(t1 - t0, 86400000);
  const X = (t: number) => L + ((t - t0) / rozpietosc) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);

  const maxIlosc = Math.max(...dane.map((p) => p.ilosc));
  const promien = (q: number) => 3.5 + (maxIlosc ? (q / maxIlosc) * 4 : 0);

  const sciezka = (get: (p: Przyjecie) => number) =>
    dane.map((p, i) => `${i ? "L" : "M"}${X(new Date(p.data).getTime())} ${Y(get(p))}`).join(" ");

  // Granice zmian dostawcy — pionowe linie na wykresie.
  const granice = h.dostawcy.slice(1).map((d) => new Date(d.od).getTime());

  const lata = new Set(dane.map((p) => p.data.slice(0, 4)));

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Ile płacimy za tę sztukę</span>
        <span style={sectHint}>{zakupy.length} dostaw · każda osobno</span>
      </div>

      <div style={box}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "11px 14px", borderBottom: "1px solid var(--border-soft)", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>
              {tryb === "pln" ? "Koszt jednostkowy — PLN" : tryb === "waluta" ? "Cena towaru w walucie dostawcy" : "Z czego składa się koszt"}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-lo)", marginTop: 2 }}>
              {tryb === "pln" && `${fmtC(zakupy[0].koszt_jednostkowy as number)} → ${fmtC(zakupy[zakupy.length - 1].koszt_jednostkowy as number)} zł/szt`}
              {tryb === "waluta" && (wWalucie.length ? "bez frachtu i cła — sama negocjacja z dostawcą" : "brak zakupów walutowych")}
              {tryb === "split" && "przestrzeń między liniami to fracht i cło"}
            </div>
          </div>
          <div style={{ display: "inline-flex", background: "var(--surface-2)", borderRadius: 7, padding: 2, gap: 2 }}>
            {([["pln", "Koszt PLN"], ["waluta", "Waluta"], ["split", "Towar / logistyka"]] as [TrybCeny, string][])
              .filter(([k]) => k !== "waluta" || wWalucie.length > 0)
              .map(([k, label]) => (
                <button key={k} onClick={() => setTryb(k)}
                  style={{
                    border: 0, background: tryb === k ? "var(--accent)" : "none",
                    color: tryb === k ? "var(--accent-ink)" : "var(--text-lo)",
                    fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 5, cursor: "pointer",
                  }}>{label}</button>
              ))}
          </div>
        </div>

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
            {[...lata].map((y) => {
              const t = new Date(`${y}-01-01`).getTime();
              if (t < t0 || t > t1) return null;
              // Sama kreska — rok niosą podpisy miesięcy („09.26").
              return <line key={y} x1={X(t)} x2={X(t)} y1={T} y2={H - B} stroke="var(--border-soft)" strokeWidth={1} strokeDasharray="2 4" />;
            })}

            {(() => {
              const mies = zakresMiesiecy(new Date(t0).toISOString(), new Date(t1).toISOString());
              const podpisy = podpisyMiesiecy(mies, waski ? 4 : 8);
              return mies.map((m) => (podpisy.has(m) ? (
                <text key={m} x={X(new Date(`${m}-01`).getTime())} y={H - B + 14} textAnchor="middle"
                      fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">
                  {fmtM(m)}
                </text>
              ) : null));
            })()}

            {tryb !== "waluta" && granice.map((t, i) => (
              <line key={i} x1={X(t)} x2={X(t)} y1={T} y2={H - B} stroke="var(--anomaly)" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />
            ))}

            {tryb === "split" && (
              <path
                d={`${sciezka((p) => p.koszt_jednostkowy as number)} ${dane.slice().reverse().map((p) => `L${X(new Date(p.data).getTime())} ${Y(p.towar_pln ?? (p.koszt_jednostkowy as number))}`).join(" ")} Z`}
                fill="var(--info-soft)" />
            )}
            {tryb === "split" && (
              <path d={sciezka((p) => p.towar_pln ?? (p.koszt_jednostkowy as number))} fill="none" stroke="var(--info)" strokeWidth={2} strokeLinejoin="round" />
            )}
            <path d={sciezka(tryb === "split" ? ((p) => p.koszt_jednostkowy as number) : wartosc)}
                  fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />

            {dane.map((p, i) => {
              const cx = X(new Date(p.data).getTime());
              const cy = Y(tryb === "split" ? (p.koszt_jednostkowy as number) : wartosc(p));
              const poprz = i > 0 ? dane[i - 1] : null;
              const delta = poprz ? ((wartosc(p) / wartosc(poprz)) - 1) * 100 : null;
              return (
                <circle key={i} cx={cx} cy={cy} r={promien(p.ilosc)}
                  fill={p.skorygowane ? "var(--critical)" : (kolorDostawcy.get(p.dostawca || "") || "var(--accent)")}
                  stroke="var(--bg)" strokeWidth={1.5} style={{ cursor: "pointer" }}
                  onMouseMove={(e) => setTip({
                    x: e.clientX, y: e.clientY,
                    html: (
                      <>
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-lo)", marginBottom: 3 }}>
                          {fmtD(p.data)}{p.numer_dokumentu ? ` · ${p.numer_dokumentu}` : ""}
                        </div>
                        <div><b>{fmtNum(p.ilosc)} szt</b>{p.dostawca ? ` · ${p.dostawca}` : ""}</div>
                        <div style={{ color: "var(--text-mid)", marginTop: 3 }}>koszt {fmtC(p.koszt_jednostkowy as number)} zł/szt</div>
                        {p.cena_waluta != null && p.kurs != null && Math.abs(p.kurs - 1) > 0.001 && (
                          <div style={{ color: "var(--text-mid)" }}>towar {fmtC(p.cena_waluta, 0)} × {fmtC(p.kurs, 4)} = {fmtC(p.towar_pln as number)} zł</div>
                        )}
                        {p.logistyka_pln != null && Math.abs(p.logistyka_pln) > 0.005 && (
                          <div style={{ color: "var(--info)" }}>logistyka {fmtC(p.logistyka_pln)} zł</div>
                        )}
                        {delta != null && (
                          <div style={{ color: delta > 0 ? "var(--critical)" : "var(--ok)", marginTop: 3 }}>
                            {delta > 0 ? "+" : ""}{fmtC(delta, 1)}% wobec poprzedniej
                          </div>
                        )}
                        {p.skorygowane && <div style={{ color: "var(--critical)", marginTop: 3 }}>koszt skorygowany (KPZ)</div>}
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
          {h.dostawcy.map((d) => (
            <span key={d.nazwa} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: kolorDostawcy.get(d.nazwa) }} />
              {d.nazwa}
            </span>
          ))}
          <span>wielkość kropki = wielkość dostawy</span>
        </div>
      </div>

      {h.dostawcy.length > 1 && (
        <div style={note}>
          Zmiana dostawcy zaznaczona pionową linią.{" "}
          {h.dostawcy.map((d) => `${d.nazwa}: ${d.przyjec} dostaw, śr. ${d.sredni_koszt != null ? fmtC(d.sredni_koszt) : "—"} zł/szt`).join(" · ")}
        </div>
      )}
    </div>
  );
}

// ── Podział braków: brak towaru vs niski zapas ───────────────
// Backend zwraca dwie listy: `miesiace_bez_pokrycia` (wszystko, co nie
// pokrywało sprzedaży, łącznie z brakiem) i `miesiace_bez_towaru` (sam brak,
// półka ≤ 0). Tu rozdzielamy je na dwa rozłączne zbiory. Fallback liczy brak
// z krzywej, gdyby front wyszedł przed backendem bez nowego pola.
export const glownyStan = (p: PunktStanu) => p.stan_polka ?? p.stan;
export const stanWDrodze = (p: PunktStanu) => Math.max(0, p.stan - glownyStan(p));

export function podzialBrakow(h: Historia): { brak: Set<string>; nisko: Set<string> } {
  const pokrycie = new Set(h.miesiace_bez_pokrycia.map((d) => d.slice(0, 7)));
  const brak = h.miesiace_bez_towaru
    ? new Set(h.miesiace_bez_towaru.map((d) => d.slice(0, 7)))
    : new Set(h.stan_miesiecznie
        .filter((p) => pokrycie.has(p.miesiac.slice(0, 7)) && glownyStan(p) <= 0)
        .map((p) => p.miesiac.slice(0, 7)));
  const nisko = new Set([...pokrycie].filter((k) => !brak.has(k)));
  return { brak, nisko };
}

/** Sklejone ciągi kolejnych miesięcy: [pierwszy, ostatni, ile]. Klucze „RRRR-MM". */
export function ciagiMiesiecy(klucze: Iterable<string>): [string, string, number][] {
  const s = [...klucze].sort();
  const out: [string, string, number][] = [];
  const idx = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7));
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && idx(s[j + 1]) - idx(s[j]) === 1) j++;
    out.push([s[i], s[j], j - i + 1]);
    i = j + 1;
  }
  return out;
}

/** Dopasowanie wjazdów na magazyn do zakupów „w drodze" — FIFO po ilości.
 *
 *  Przesunięcie nie wskazuje w danych, z którego PZ pochodzi towar, więc
 *  zdejmujemy ilość z najstarszych niedojechanych zakupów. Zakup „dotarł"
 *  dopiero wtedy, gdy wjechała cała jego ilość — przy częściowym wjeździe
 *  zostaje w drodze. */
export function dopasujWjazdy(przyjecia: Przyjecie[]) {
  const zakupy = przyjecia
    .filter((p) => p.typ === "ZAKUP" && p.w_drodze && p.ilosc > 0)
    .map((p) => ({ p, zostalo: p.ilosc }));
  const wjazdy = przyjecia.filter((p) => p.typ === "PRZESUNIECIE" && !p.w_drodze && p.ilosc > 0);
  const dotarl = new Map<Przyjecie, string>();
  const zakupWjazdu = new Map<Przyjecie, Przyjecie>();
  let i = 0;
  for (const w of wjazdy) {
    let q = w.ilosc;
    while (q > 1e-9 && i < zakupy.length && zakupy[i].p.data <= w.data) {
      if (!zakupWjazdu.has(w)) zakupWjazdu.set(w, zakupy[i].p);
      const ile = Math.min(q, zakupy[i].zostalo);
      zakupy[i].zostalo -= ile;
      q -= ile;
      if (zakupy[i].zostalo <= 1e-9) { dotarl.set(zakupy[i].p, w.data); i++; }
    }
  }
  return { dotarl, zakupWjazdu };
}

const dm = (s: string) => fmtD(s).slice(0, 5);
const dniMiedzy = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

// ── Krzywa stanu ─────────────────────────────────────────────
// LINIA GŁÓWNA = MAGAZYN GŁÓWNY. Towar na „w drodze" płynie przez ocean i nie
// da się go sprzedać z półki w Pucku. Wcześniej główną linią była suma obu
// magazynów — przy SZP_W skakała o 50 szt w dniu zapłaty za kontener, choć
// półka stała pusta do września. Suma zostaje jako przerywana linia, a różnica
// między nimi to zakreskowany pas „na wodzie".
//
// Oś schodzi pod zero: ujemny stan główny (sprzedaż przed dokumentem
// magazynowym) to informacja, a przycinanie go do 0 udawało pustą półkę.
export function KrzywaStanu({ h }: { h: Historia }) {
  const { ref: refWykresu, w: W } = useSzerokoscWykresu();
  const waski = W < 520;
  const [tip, setTip] = useState<Tip>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const pkt = h.stan_miesiecznie;

  // Zdarzenia per miesiąc: zakup na „w drodze" i wjazd na magazyn główny
  // (zakup prosto na główny albo przesunięcie z „w drodze"). Zwroty i ruchy
  // wewnętrzne kropek nie dostają — żyją w tooltipie.
  const zdarzenia = useMemo(() => {
    const m = new Map<string, { zakupy: Przyjecie[]; wjazdy: Przyjecie[]; zakupySzt: number }>();
    const wez = (k: string) => {
      let e = m.get(k);
      if (!e) { e = { zakupy: [], wjazdy: [], zakupySzt: 0 }; m.set(k, e); }
      return e;
    };
    for (const p of h.przyjecia) {
      if (p.ilosc <= 0) continue;
      const e = wez(p.data.slice(0, 7));
      if (p.typ === "ZAKUP") e.zakupySzt += p.ilosc;
      if (p.typ === "ZAKUP" && p.w_drodze) e.zakupy.push(p);
      else if (!p.w_drodze && (p.typ === "ZAKUP" || p.typ === "PRZESUNIECIE")) e.wjazdy.push(p);
    }
    return m;
  }, [h.przyjecia]);

  const { brak, nisko } = useMemo(() => podzialBrakow(h), [h]);

  if (pkt.length < 2) return null;

  const n = pkt.length;
  const H = waski ? 210 : 250;
  // L na telefonie było za wąskie — czterocyfrowe stany („1 054") nie mieściły
  // się i pierwsza cyfra znikała za krawędzią. R z zapasem, bo na ostatnim
  // miesiącu rysujemy prostokąt braku o szerokości pełnego kroku.
  const L = waski ? 50 : 54, R = waski ? 18 : 16, T = 20, B = 34;

  const maWDrodze = pkt.some((p) => stanWDrodze(p) > 0.5);
  const maxS = Math.max(...pkt.map((p) => Math.max(p.stan, glownyStan(p))), 1) * 1.12;
  const minRaw = Math.min(0, ...pkt.map(glownyStan));
  const minS = minRaw < 0 ? Math.min(minRaw * 1.4, -maxS * 0.07) : 0;
  const X = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - minS) / (maxS - minS)) * (H - T - B);
  const krok = (W - L - R) / (n - 1);
  const y0 = Y(0);

  const linia = pkt.map((p, i) => `${i ? "L" : "M"}${X(i)} ${Y(glownyStan(p))}`).join(" ");
  const obszar = `${linia} L${X(n - 1)} ${y0} L${X(0)} ${y0} Z`;

  const pas = maWDrodze
    ? pkt.map((p, i) => `${i ? "L" : "M"}${X(i)} ${Y(Math.max(p.stan, glownyStan(p)))}`).join(" ")
      + " " + pkt.map((p, i) => [X(i), Y(glownyStan(p))] as const).reverse().map(([x, y]) => `L${x} ${y}`).join(" ")
      + " Z"
    : null;

  // Podpisy pasa — jeden na ciąg miesięcy z towarem w drodze, w miejscu
  // największej ilości. Pomijamy, gdy pas jest za niski albo podpisy by na
  // siebie wjechały (długa historia z kilkoma kontenerami).
  const podpisyPasa: { x: number; y: number; txt: string; w: number }[] = [];
  if (maWDrodze) {
    let i = 0;
    let prawaKrawedz = -Infinity;
    while (i < n) {
      if (stanWDrodze(pkt[i]) <= 0.5) { i++; continue; }
      let j = i, best = i;
      while (j + 1 < n && stanWDrodze(pkt[j + 1]) > 0.5) {
        j++;
        if (stanWDrodze(pkt[j]) > stanWDrodze(pkt[best])) best = j;
      }
      const p = pkt[best];
      const txt = `${fmtNum(Math.round(stanWDrodze(p)))} szt na wodzie`;
      const w = txt.length * 6 + 18;
      const wys = Y(glownyStan(p)) - Y(p.stan);
      const x = Math.max(L + w / 2 + 2, Math.min(X(best), W - R - w / 2 - 2));
      if (wys >= 24 && x - w / 2 > prawaKrawedz + 6) {
        podpisyPasa.push({ x, y: (Y(glownyStan(p)) + Y(p.stan)) / 2, txt, w });
        prawaKrawedz = x + w / 2;
      }
      i = j + 1;
    }
  }

  // Najniższy stan główny i ciąg miesięcy, w których się utrzymał.
  let iMin = 0;
  pkt.forEach((p, i) => { if (glownyStan(p) < glownyStan(pkt[iMin])) iMin = i; });
  let jMin = iMin;
  while (jMin + 1 < n && Math.abs(glownyStan(pkt[jMin + 1]) - glownyStan(pkt[iMin])) < 0.5) jMin++;
  const brakWDrodze = pkt.filter((p) => brak.has(p.miesiac.slice(0, 7)) && stanWDrodze(p) > 0.5).length;
  const maWjazdy = [...zdarzenia.values()].some((e) => e.wjazdy.length > 0);

  const listaDok = (lista: Przyjecie[], slowo: string, kolor: string) => {
    if (!lista.length) return null;
    const szt = lista.reduce((s, p) => s + p.ilosc, 0);
    const opis = lista.length <= 2
      ? lista.map((p) => [p.numer_dokumentu, dm(p.data)].filter(Boolean).join(" · ")).join(", ")
      : `${lista.length} dok.`;
    return (
      <div style={{ color: kolor, marginTop: 3 }}>
        {slowo} {fmtNum(szt)} szt · {opis}
      </div>
    );
  };

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Stan magazynu w czasie</span>
        <span style={sectHint}>magazyn główny, odtworzony z ruchów</span>
        {h.stan_magazyn != null && (
          <span style={{ ...sectHint, marginLeft: "auto" }}>
            dziś <b style={{ color: "var(--text-hi)", fontWeight: 600 }}>{fmtNum(h.stan_magazyn)} szt</b> na magazynie
            {h.stan_w_drodze != null && (
              <> · <b style={{ color: "var(--text-hi)", fontWeight: 600 }}>{fmtNum(h.stan_w_drodze)}</b> w drodze</>
            )}
          </span>
        )}
      </div>

      <div style={box}>
        <div ref={refWykresu} style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: H }}>
            <defs>
              <clipPath id={`${id}nad`}><rect x={0} y={0} width={W} height={Math.max(0, y0)} /></clipPath>
              <clipPath id={`${id}pod`}><rect x={0} y={y0} width={W} height={Math.max(0, H - y0)} /></clipPath>
              <pattern id={`${id}kreski`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width={6} height={6} fill="var(--info-soft)" />
                <line x1={0} y1={0} x2={0} y2={6} stroke="var(--info)" strokeOpacity={0.5} strokeWidth={1.5} />
              </pattern>
            </defs>

            {[0, 1, 2, 3].map((i) => {
              const v = (maxS * i) / 3, y = Y(v);
              return (
                <g key={i}>
                  <line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={L - 8} y={y + 3.5} textAnchor="end" fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">{fmtNum(Math.round(v))}</text>
                </g>
              );
            })}
            {minS < 0 && (
              <line x1={L} x2={W - R} y1={y0} y2={y0} stroke="var(--border-strong)" strokeWidth={1} />
            )}
            {pkt.map((p, i) => p.miesiac.slice(5, 7) === "01" ? (
              // Kreska na styczniu zostaje, podpis roku nie — dublowałby się
              // z podpisami miesięcy niżej.
              <line key={p.miesiac} x1={X(i)} x2={X(i)} y1={T} y2={H - B} stroke="var(--border-soft)" strokeWidth={1} strokeDasharray="2 4" />
            ) : null)}

            {(() => {
              const podpisy = podpisyMiesiecy(pkt.map((p) => p.miesiac.slice(0, 7)), waski ? 4 : 8);
              return pkt.map((p, i) => (podpisy.has(p.miesiac.slice(0, 7)) ? (
                <text key={p.miesiac} x={X(i)} y={H - B + 14} textAnchor="middle"
                      fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">
                  {fmtM(p.miesiac)}
                </text>
              ) : null));
            })()}

            {pkt.map((p, i) => {
              // Każdy miesiąc osobnym prostokątem z obrysem — kreski na granicach
              // miesięcy są celowe, bez nich czerwone tło ginęło pod pasem „w drodze".
              // Przycięte do obszaru wykresu, żeby bok na krańcach nie był obcinany.
              const k = p.miesiac.slice(0, 7);
              const kolor = brak.has(k) ? "critical" : nisko.has(k) ? "warning" : null;
              if (!kolor) return null;
              const x0 = Math.max(L, X(i) - krok / 2);
              const x1 = Math.min(X(i) + krok / 2, W - R);
              return (
                <rect key={`r${i}`} x={x0} y={T} width={x1 - x0} height={H - T - B}
                      fill={`var(--${kolor}-soft)`} stroke={`var(--${kolor})`} strokeWidth={1} />
              );
            })}

            <path d={obszar} fill="var(--accent-soft)" clipPath={`url(#${id}nad)`} />
            {minS < 0 && <path d={obszar} fill="var(--critical-soft)" clipPath={`url(#${id}pod)`} />}
            {pas && <path d={pas} fill={`url(#${id}kreski)`} />}

            {maWDrodze && pkt.map((p, i) => {
              if (!i) return null;
              const a = pkt[i - 1];
              if (stanWDrodze(a) <= 0.5 && stanWDrodze(p) <= 0.5) return null;
              return (
                <line key={`d${i}`} x1={X(i - 1)} y1={Y(Math.max(a.stan, glownyStan(a)))} x2={X(i)} y2={Y(Math.max(p.stan, glownyStan(p)))}
                      stroke="var(--info)" strokeWidth={1.4} strokeDasharray="4 3" />
              );
            })}
            <path d={linia} fill="none" stroke="var(--accent)" strokeWidth={2.2} strokeLinejoin="round" />

            {podpisyPasa.map((s, i) => (
              <g key={`p${i}`} style={{ pointerEvents: "none" }}>
                <rect x={s.x - s.w / 2} y={s.y - 11} width={s.w} height={20} rx={5}
                      fill="var(--bg-elevated)" stroke="var(--info)" strokeOpacity={0.5} />
                <text x={s.x} y={s.y + 3} textAnchor="middle" fill="var(--info)" fontSize={10.5} fontWeight={600}>{s.txt}</text>
              </g>
            ))}

            {pkt.map((p, i) => {
              const e = zdarzenia.get(p.miesiac.slice(0, 7));
              if (!e) return null;
              return (
                <g key={`z${i}`}>
                  {e.zakupy.length > 0 && (
                    <circle cx={X(i)} cy={Y(Math.max(p.stan, glownyStan(p)))} r={4.5} fill="var(--bg-elevated)" stroke="var(--info)" strokeWidth={2} />
                  )}
                  {e.wjazdy.length > 0 && (
                    <circle cx={X(i)} cy={Y(glownyStan(p))} r={4.5} fill="var(--ok)" stroke="var(--bg)" strokeWidth={1.5} />
                  )}
                </g>
              );
            })}

            {pkt.map((p, i) => {
              const k = p.miesiac.slice(0, 7);
              const e = zdarzenia.get(k);
              const zwroty = Math.max(0, p.przyjeto - (e?.zakupySzt || 0));
              const g = glownyStan(p);
              const wd = stanWDrodze(p);
              const [y, m] = p.miesiac.split("-");
              return (
                <rect key={`h${i}`} x={X(i) - krok / 2} y={T} width={krok} height={H - T - B} fill="transparent"
                  style={{ cursor: "pointer" }}
                  onMouseMove={(ev) => setTip({
                    x: ev.clientX, y: ev.clientY,
                    html: (
                      <>
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-lo)", marginBottom: 3 }}>
                          {MIES[Number(m) - 1]} {y}
                        </div>
                        <div style={{ color: g <= 0 ? "var(--critical)" : "var(--text-hi)" }}>
                          <b>na magazynie {fmtNum(Math.round(g))} szt</b>
                        </div>
                        {wd > 0.5 && (
                          <div style={{ color: "var(--info)" }}>
                            w drodze {fmtNum(Math.round(wd))} szt · łącznie {fmtNum(Math.round(p.stan))}
                          </div>
                        )}
                        {e && listaDok(e.zakupy, "zakup", "var(--info)")}
                        {e && listaDok(e.wjazdy, "wjazd na magazyn", "var(--ok)")}
                        <div style={{ color: "var(--text-mid)", marginTop: 3 }}>sprzedaż {fmtNum(p.sprzedano)} szt</div>
                        {p.wydano > p.sprzedano && (
                          <div style={{ color: "var(--text-lo)" }}>rozchód wewn. {fmtNum(p.wydano - p.sprzedano)} szt</div>
                        )}
                        {zwroty > 0 && <div style={{ color: "var(--text-lo)" }}>zwroty {fmtNum(zwroty)} szt</div>}
                        {g <= 0 ? (
                          <div style={{ color: "var(--critical)", marginTop: 3 }}>brak towaru na półce</div>
                        ) : p.sprzedano > 0 ? (
                          <div style={{ color: g < p.sprzedano ? "var(--warning)" : "var(--text-lo)", marginTop: 3 }}>
                            zapas na {fmtC(g / p.sprzedano, 1)} mies.
                          </div>
                        ) : null}
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
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 12, height: 2.2, background: "var(--accent)" }} />na magazynie głównym
          </span>
          {maWDrodze && (
            <>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 12, height: 0, borderTop: "1.4px dashed var(--info)" }} />łącznie z towarem w drodze
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: "var(--bg-elevated)", border: "2px solid var(--info)", boxSizing: "border-box" }} />zakup (wbity na w drodze)
              </span>
            </>
          )}
          {maWjazdy && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: "var(--ok)" }} />wjazd na magazyn
            </span>
          )}
          {brak.size > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 8, background: "var(--critical-soft)", border: "1px solid var(--critical)" }} />brak towaru
            </span>
          )}
          {nisko.size > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 8, background: "var(--warning-soft)", border: "1px solid var(--warning)" }} />zapas poniżej miesięcznej sprzedaży
            </span>
          )}
        </div>
      </div>

      {(brak.size > 0 || nisko.size > 0) && (
        <div style={note}>
          Na magazynie najniżej: <b style={{ color: glownyStan(pkt[iMin]) <= 0 ? "var(--critical)" : "var(--text-mid)" }}>{fmtNum(Math.round(glownyStan(pkt[iMin])))} szt</b>
          {" "}{jMin > iMin ? `(${fmtM(pkt[iMin].miesiac)}–${fmtM(pkt[jMin].miesiac)})` : `na koniec ${fmtM(pkt[iMin].miesiac)}`}.
          {brak.size > 0 && <> Bez towaru na półce: {brak.size} mies.{brakWDrodze > 0 && `, z czego ${brakWDrodze} mies. towar płynął`}.</>}
          {nisko.size > 0 && <> Zapas poniżej sprzedaży: {nisko.size} mies.</>}
          {" "}Rozdzielczość jest miesięczna, więc krótsza przerwa w środku miesiąca może tu nie być widoczna.
        </div>
      )}
      {Math.abs(h.dryf) > 0.5 && (
        <div style={{ ...note, color: "var(--warning)" }}>
          Rekonstrukcja rozjeżdża się o {fmtNum(Math.abs(h.dryf))} szt w skali całej historii —
          stan na dziś jest dokładny, ale im dalej wstecz, tym mniej dokładna krzywa.
        </div>
      )}
    </div>
  );
}

// ── Oś czasu ─────────────────────────────────────────────────
// Zdarzenia wyprowadzone z odpowiedzi API. Świadomie NIE ma tu
// zmian atrybutów (cena ręczna, MOQ, lead time) — te siedzą
// w app_audit_log, którego endpoint jeszcze nie czyta.
type Zdarzenie = {
  data: string; kolor: string; tytul: string; opis: string;
};

export function OsCzasu({ h }: { h: Historia }) {
  const [wszystkie, setWszystkie] = useState(false);

  const zdarzenia = useMemo<Zdarzenie[]>(() => {
    const z: Zdarzenie[] = [];
    const zakupy = h.przyjecia.filter((p) => p.typ === "ZAKUP");
    if (!zakupy.length) return z;

    const opisDostawy = (p: Przyjecie, poprz?: Przyjecie) => {
      const cz: string[] = [];
      if (p.numer_dokumentu) cz.push(p.numer_dokumentu);
      if (p.dostawca) cz.push(p.dostawca);
      if (p.koszt_jednostkowy != null) {
        const d = poprz?.koszt_jednostkowy
          ? ((p.koszt_jednostkowy / poprz.koszt_jednostkowy) - 1) * 100 : null;
        cz.push(`${fmtC(p.koszt_jednostkowy)} zł/szt${d != null && Math.abs(d) >= 0.05 ? ` (${d > 0 ? "+" : ""}${fmtC(d, 1)}%)` : ""}`);
      }
      return cz.join(" · ");
    };

    // Pierwsza i ostatnia dostawa
    // Nazewnictwo zdarzeń: „zakup" to wbicie na magazyn w drodze, „dostawa" to
    // wjazd towaru na magazyn główny. Wcześniej jedno i drugie nazywało się
    // dostawą, więc oś pokazywała „Ostatnia dostawa — 1000 szt" w dniu, w
    // którym towar dopiero wypłynął z Chin.
    // Rodzaj też się zgadza: „Pierwszy zakup", ale „Pierwsza dostawa".
    const tytul = (p: Przyjecie, ktory: "pierwszy" | "ostatni") => {
      const zakup = !!p.w_drodze;
      const przym = ktory === "pierwszy"
        ? (zakup ? "Pierwszy" : "Pierwsza")
        : (zakup ? "Ostatni" : "Ostatnia");
      return `${przym} ${zakup ? "zakup" : "dostawa"} — ${fmtNum(p.ilosc)} szt`;
    };

    z.push({
      data: zakupy[0].data, kolor: "var(--text-lo)",
      tytul: tytul(zakupy[0], "pierwszy"),
      opis: `${opisDostawy(zakupy[0])} · produkt wchodzi do oferty`
            + (zakupy[0].w_drodze ? " · wbity na magazyn w drodze" : ""),
    });
    if (zakupy.length > 1) {
      const last = zakupy[zakupy.length - 1];
      z.push({
        data: last.data, kolor: last.w_drodze ? "var(--info)" : "var(--ok)",
        tytul: tytul(last, "ostatni"),
        opis: opisDostawy(last, zakupy[zakupy.length - 2])
              + (last.w_drodze ? " · wbity na magazyn w drodze" : ""),
      });
    }

    // Wjazd z „w drodze" na magazyn — moment, w którym towar realnie jest.
    const przyjazdy = h.przyjecia.filter((p) => p.typ === "PRZESUNIECIE" && !p.w_drodze);
    const ostatniPrzyjazd = przyjazdy[przyjazdy.length - 1];
    if (ostatniPrzyjazd) {
      // Ile płynął — od zakupu, z którego FIFO zdjęło pierwsze sztuki tego wjazdu.
      const zakup = dopasujWjazdy(h.przyjecia).zakupWjazdu.get(ostatniPrzyjazd);
      const dni = zakup ? dniMiedzy(zakup.data, ostatniPrzyjazd.data) : null;
      const cz: string[] = [];
      if (ostatniPrzyjazd.numer_dokumentu) cz.push(ostatniPrzyjazd.numer_dokumentu);
      cz.push("przesunięcie z magazynu „w drodze\"");
      cz.push(dni != null && dni >= 0
        ? `płynął ${fmtNum(dni)} ${dni === 1 ? "dzień" : "dni"} od zakupu`
        : "od tego dnia jest fizycznie dostępny");
      z.push({
        data: ostatniPrzyjazd.data, kolor: "var(--ok)",
        tytul: `Towar wjechał na magazyn — ${fmtNum(ostatniPrzyjazd.ilosc)} szt`,
        opis: cz.join(" · "),
      });
    }

    // Największa dostawa — tylko jeśli wyraźnie odstaje
    const max = zakupy.reduce((a, b) => (b.ilosc > a.ilosc ? b : a));
    const sr = zakupy.reduce((s, p) => s + p.ilosc, 0) / zakupy.length;
    if (max.ilosc > sr * 1.8 && max !== zakupy[0] && max !== zakupy[zakupy.length - 1]) {
      z.push({
        data: max.data, kolor: "var(--info)",
        tytul: `Największe zamówienie — ${fmtNum(max.ilosc)} szt`,
        opis: `${opisDostawy(max)} · ${fmtC(max.ilosc / sr, 1)}× średnia dostawa`,
      });
    }

    // Zmiany dostawcy
    h.dostawcy.slice(1).forEach((d, i) => {
      const poprz = h.dostawcy[i];
      const zmiana = d.sredni_koszt != null && poprz.sredni_koszt
        ? ((d.sredni_koszt / poprz.sredni_koszt) - 1) * 100 : null;
      z.push({
        data: d.od, kolor: "var(--anomaly)",
        tytul: `Zmiana dostawcy — ${poprz.nazwa} → ${d.nazwa}`,
        opis: zmiana != null
          ? `średni koszt ${fmtC(poprz.sredni_koszt as number)} → ${fmtC(d.sredni_koszt as number)} zł/szt (${zmiana > 0 ? "+" : ""}${fmtC(zmiana, 1)}%)`
          : `${d.przyjec} dostaw od tego dostawcy`,
      });
    });

    // Przejście na rozliczanie w obcej walucie
    const walutowy = zakupy.find((p) => p.kurs != null && Math.abs(p.kurs - 1) > 0.001);
    if (walutowy && walutowy !== zakupy[0]) {
      z.push({
        data: walutowy.data, kolor: "var(--warning)",
        tytul: "Przejście na rozliczanie w obcej walucie",
        opis: `${walutowy.numer_dokumentu || ""} · pierwszy dokument z kursem innym niż 1,0`.trim(),
      });
    }

    // Korekty kosztu — zgrupowane po dacie, bo jeden KPZ poprawia zwykle kilka pozycji
    const kor = new Map<string, Przyjecie[]>();
    for (const p of h.przyjecia) {
      if (!p.skorygowane) continue;
      const k = kor.get(p.data) || [];
      k.push(p); kor.set(p.data, k);
    }
    for (const [data, poz] of kor) {
      z.push({
        data, kolor: "var(--critical)",
        tytul: `Koszt skorygowany — ${poz.length} ${poz.length === 1 ? "pozycja" : "pozycje"}`,
        opis: `${poz.map((p) => p.numer_dokumentu).filter(Boolean).join(", ") || "dokument KPZ"} · koszt pierwotny został zastąpiony`,
      });
    }

    // Braki — liczone na magazynie głównym, sklejone w ciągi. Dwa rodzaje:
    // brak towaru (półka ≤ 0) i niski zapas (jest, ale mniej niż sprzedaż).
    // Wcześniej był tylko drugi, a miesiące z pustą półką i zerową sprzedażą
    // wypadały — nie było czego sprzedać, więc „pokrycie" wyglądało na OK.
    const { brak, nisko } = podzialBrakow(h);
    const punkt = (k: string) => h.stan_miesiecznie.find((p) => p.miesiac.slice(0, 7) === k);
    const zakres = (od: string, doK: string, ile: number) =>
      ile === 1 ? fmtM(od) : `${fmtM(od)} – ${fmtM(doK)}`;

    for (const [od, doK, ile] of ciagiMiesiecy(brak)) {
      const koniec = punkt(doK);
      const wCiagu = h.stan_miesiecznie.filter((p) => {
        const k = p.miesiac.slice(0, 7);
        return k >= od && k <= doK;
      });
      const plynelo = Math.max(0, ...wCiagu.map(stanWDrodze));
      // Zakup, który wtedy płynął: ostatni wbity na „w drodze" do końca ciągu.
      const zakup = [...zakupy].reverse().find((p) => p.w_drodze && p.data.slice(0, 7) <= doK);
      const cz = [zakres(od, doK, ile)];
      if (koniec) cz.push(`na magazynie ${fmtNum(Math.round(glownyStan(koniec)))} szt`);
      if (plynelo > 0.5) {
        cz.push(zakup
          ? `od ${dm(zakup.data)} w drodze ${fmtNum(Math.round(plynelo))} szt`
          : `w drodze ${fmtNum(Math.round(plynelo))} szt`);
      }
      z.push({
        data: `${doK}-01`, kolor: "var(--critical)",
        tytul: ile === 1 ? "Brak towaru na magazynie" : `Brak towaru przez ${ile} mies.`,
        opis: cz.join(" · "),
      });
    }

    for (const [od, doK, ile] of ciagiMiesiecy(nisko)) {
      const koniec = punkt(doK);
      z.push({
        data: `${doK}-01`, kolor: "var(--warning)",
        tytul: ile === 1
          ? "Zapas poniżej miesięcznej sprzedaży"
          : `Zapas poniżej sprzedaży przez ${ile} mies.`,
        opis: `${zakres(od, doK, ile)}${koniec ? ` · na koniec ${fmtNum(Math.round(glownyStan(koniec)))} szt przy sprzedaży ${fmtNum(koniec.sprzedano)}/mies` : ""}`,
      });
    }

    return z.sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  }, [h]);

  if (!zdarzenia.length) return null;

  // Domyślnie ostatnie 12 miesięcy — przy produkcie z 3-letnią historią
  // pełna lista rozjeżdża modal, a najnowsze zdarzenia są najważniejsze.
  const prog = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const swieze = zdarzenia.filter((e) => e.data >= prog);
  const widoczne = wszystkie || swieze.length < 3 ? zdarzenia : swieze;
  const ukryte = zdarzenia.length - widoczne.length;

  let rok = "";

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Co się z nim działo</span>
        <span style={sectHint}>dostawy, zmiany dostawcy, braki towaru</span>
      </div>

      <div style={{ position: "relative", paddingLeft: 26 }}>
        <div style={{ position: "absolute", left: 7, top: 6, bottom: 6, width: 2, background: "var(--border-soft)" }} />
        {widoczne.map((e, i) => {
          const r = e.data.slice(0, 4);
          const naglowekRoku = r !== rok ? (rok = r) : null;
          return (
            <React.Fragment key={`${e.data}-${i}`}>
              {naglowekRoku && (
                <div className="mono" style={{ position: "relative", margin: "0 0 12px -26px", fontSize: 11, fontWeight: 700, color: "var(--text-disabled)", letterSpacing: "0.08em" }}>
                  {naglowekRoku}
                </div>
              )}
              <div style={{ position: "relative", paddingBottom: 16 }}>
                <span style={{ position: "absolute", left: -24, top: 4, width: 12, height: 12, borderRadius: 99, background: e.kolor, border: "2px solid var(--bg)", boxShadow: "0 0 0 2px var(--border-soft)" }} />
                <div className="mono" style={{ fontSize: 11, color: "var(--text-lo)" }}>{fmtD(e.data)}</div>
                <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 1, color: e.kolor === "var(--critical)" ? "var(--critical)" : "var(--text-hi)" }}>{e.tytul}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-mid)", marginTop: 3 }}>{e.opis}</div>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {ukryte > 0 && (
        <button onClick={() => setWszystkie(true)}
          style={{ width: "100%", marginTop: 4, padding: 9, background: "transparent", border: "1px dashed var(--border)", borderRadius: 8, color: "var(--text-lo)", fontSize: 12, cursor: "pointer" }}>
          Pokaż wcześniejsze zdarzenia ({ukryte})
        </button>
      )}
    </div>
  );
}

// ── Tabela przyjęć ───────────────────────────────────────────
export function TabelaPrzyjec({ h }: { h: Historia }) {
  const [wszystkie, setWszystkie] = useState(false);

  const wiersze = useMemo(() => {
    // ZWROTY NIE WCHODZĄ DO TEJ TABELI.
    //
    // Zwrot od klienta nie ma dokumentu, dostawcy ani kosztu — w tabeli
    // zostawia sam wiersz z datą i sztukami. Przy D2cz było ich ponad sto i
    // zalewały listę, w której szuka się zakupów. Do stanu magazynu wchodzą
    // normalnie (są w krzywej), a analizę zwrotów robi się w Power BI.
    //
    // Przesunięcia zostają pod przyciskiem, bo one niosą konkret: moment,
    // w którym towar wjechał z magazynu „w drodze" na główny.
    const p = h.przyjecia.filter((x) =>
      x.typ === "ZAKUP" || (wszystkie && x.typ === "PRZESUNIECIE"));
    return [...p].reverse();
  }, [h.przyjecia, wszystkie]);

  // Zakup „w drodze", który już w całości wjechał na magazyn, dostaje datę
  // wjazdu zamiast plakietki „w drodze" — inaczej tabela twierdzi, że towar
  // płynie, choć od tygodni leży na półce.
  const { dotarl } = useMemo(() => dopasujWjazdy(h.przyjecia), [h.przyjecia]);
  const ile = wiersze.length;
  const pozycji = ile === 1 ? "pozycja"
    : ile % 10 >= 2 && ile % 10 <= 4 && (ile % 100 < 12 || ile % 100 > 14) ? "pozycje" : "pozycji";

  const th: React.CSSProperties = {
    textAlign: "left", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em",
    textTransform: "uppercase", color: "var(--text-lo)", padding: "9px 12px",
    borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap",
    position: "sticky", top: 0, background: "var(--surface-1)", zIndex: 1,
  };
  const td: React.CSSProperties = {
    padding: "9px 12px", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap",
  };

  const TYP_KOLOR: Record<string, string> = {
    ZAKUP: "var(--ok)", WEWNETRZNE: "var(--text-lo)",
    ZWROT: "var(--info)", PRZESUNIECIE: "var(--warning)",
  };

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Zakupy</span>
        <span style={sectHint}>
          {ile} {pozycji} · {wszystkie ? "zakupy i przesunięcia" : "dokumenty PZ, czyli moment zapłaty i wbicia towaru"}
        </span>
        <button onClick={() => setWszystkie((v) => !v)}
          style={{ marginLeft: "auto", background: "none", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 5, fontSize: 11, padding: "3px 9px", cursor: "pointer" }}>
          {wszystkie ? "Tylko zakupy" : "Pokaż przesunięcia"}
        </button>
      </div>

      <div style={box}>
        <div style={{ maxHeight: 380, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={th}>Data</th>
                {wszystkie && <th style={th}>Typ</th>}
                <th style={th}>Dokument</th>
                <th style={th}>Dostawca</th>
                <th style={{ ...th, textAlign: "right" }}>Szt</th>
                <th style={{ ...th, textAlign: "right" }}>Koszt/szt</th>
                <th style={{ ...th, textAlign: "right" }}>Logistyka</th>
              </tr>
            </thead>
            <tbody>
              {wiersze.map((p, i) => {
                const poprz = wiersze[i + 1];
                const delta = poprz && poprz.koszt_jednostkowy && p.koszt_jednostkowy
                  ? ((p.koszt_jednostkowy / poprz.koszt_jednostkowy) - 1) * 100 : null;
                return (
                  <tr key={`${p.data}-${i}`}>
                    <td style={td}>
                      <span className="mono" style={{ fontWeight: 600 }}>{fmtD(p.data)}</span>
                      {p.skorygowane && (
                        <span className="mono" style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 4, background: "var(--critical-soft)", color: "var(--critical)" }}>kor</span>
                      )}
                      {/* Ten dokument wbił towar na magazyn „w drodze" — data
                          w wierszu to dzień zapłaty, nie dzień przypłynięcia. */}
                      {p.w_drodze && (dotarl.get(p) ? (
                        <span className="mono" title={`wbite na magazyn w drodze ${fmtD(p.data)}, wjechało na magazyn ${fmtD(dotarl.get(p) as string)}`}
                              style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 4, background: "var(--ok-soft)", color: "var(--ok)" }}>
                          dotarł {dm(dotarl.get(p) as string)}
                        </span>
                      ) : (
                        <span className="mono" title="wbite na magazyn w drodze — towar jeszcze płynie"
                              style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 4, background: "var(--info-soft, var(--surface-2))", color: "var(--info)" }}>
                          w drodze
                        </span>
                      ))}
                    </td>
                    {wszystkie && (
                      <td style={{ ...td, color: TYP_KOLOR[p.typ] || "var(--text-lo)", fontSize: 11 }}>{p.typ}</td>
                    )}
                    <td style={{ ...td, fontSize: 11 }} className="mono">{p.numer_dokumentu || "—"}</td>
                    <td style={td}>{p.dostawca || <span style={{ color: "var(--text-disabled)" }}>—</span>}</td>
                    <td style={{ ...td, textAlign: "right" }} className="mono">{fmtNum(p.ilosc)}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {p.koszt_jednostkowy != null ? fmtC(p.koszt_jednostkowy) : "—"}
                      </span>
                      {delta != null && Math.abs(delta) >= 0.05 && (
                        <span className="mono" style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, padding: "1px 5px", borderRadius: 5, background: delta > 0 ? "var(--critical-soft)" : "var(--ok-soft)", color: delta > 0 ? "var(--critical)" : "var(--ok)" }}>
                          {delta > 0 ? "+" : ""}{fmtC(delta, 1)}%
                        </span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "var(--info)" }} className="mono">
                      {p.logistyka_pln != null && Math.abs(p.logistyka_pln) > 0.005 ? fmtC(p.logistyka_pln) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tooltip ──────────────────────────────────────────────────
export function Tooltip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement | null>(null);
  if (!tip) return null;
  // Przy pierwszym renderze `ref` jest jeszcze pusty, więc szerokość zgadujemy —
  // i musi to być GÓRNE oszacowanie (maxWidth), nie 200. Przy zaniżonym
  // szacunku dymek przy prawej krawędzi „nie wiedział", że się nie mieści,
  // wyjeżdżał poza ekran i był ucinany w połowie nazwy dostawcy.
  const w = ref.current?.offsetWidth ?? 260;
  const hh = ref.current?.offsetHeight ?? 80;
  const surowy = tip.x + 14 + w > window.innerWidth - 8 ? tip.x - w - 14 : tip.x + 14;
  // Twarde ograniczenie do ekranu — działa też wtedy, gdy oszacowanie chybi.
  const x = Math.max(8, Math.min(surowy, window.innerWidth - w - 8));
  const y = Math.max(8, tip.y - hh - 10 < 8 ? tip.y + 16 : tip.y - hh - 10);
  return (
    <div ref={ref} style={{
      position: "fixed", left: x, top: y, zIndex: 200, pointerEvents: "none",
      background: "var(--surface-2)", border: "1px solid var(--border-strong)",
      borderRadius: 8, padding: "8px 10px", fontSize: 11.5, maxWidth: 260,
      boxShadow: "0 8px 24px oklch(0 0 0 / .5)",
    }}>{tip.html}</div>
  );
}
