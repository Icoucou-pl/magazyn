"use client";
// ============================================================
// MAGAZYN — zakładka „Cena” na pełnej karcie produktu (dla zespołu).
//
// Same wyniki, bez wyliczeń: ceny minimalne (detal, hurt/dropy), ceny sugerowane,
// alarm „sprzedaż poniżej minimum”, konkurencja na pasku cen.
// Koszt zakupu i Konkurencja — każdy boks ma swój ptaszek (priceSummaryCost / priceSummaryCompetition,
// domyślnie włączone); koszt dodatkowo tylko z ceną zakupu. O widoczności mówi serwer
// (koszt_widoczny / konkurencja_widoczna) — bez ptaszka konkurencji nie oddaje wcale.
// Kalkulator handlowca — ptaszek „Kalkulator handlowca” (+ cena zakupu): handlowiec wpisuje
// swoją cenę netto i widzi swoją prowizję i zysk firmy, z kolorem względem ceny minimalnej hurt.
//
// Do października 2026 nazywała się „test-cena”. Razem z „test-wycena” zastąpiła pierwszą
// zakładkę „Cena” (z kalkulatorem FIFO), już usuniętą — stąd ta sama nazwa.
// Dane: GET /api/ceny-produktu (routers/wycena.py).
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { fmtDay } from "./product-modal";
import { api } from "@/lib/api";
import {
  BAZA_KROTKO, KONKURENCJA_STARA_DNI, dniTemu, liczHandlowca, mediana, num, proc1, progDobrejCeny, strefa, zl2,
  type BazaKosztu, type KosztBazy, type TrybProwizji,
} from "@/lib/wycena";
import {
  Box, Kafel, KosztTowaru, KosztyEdytor, Linia, PasekCen, Pole, Wiersz, critStyl, hint, kartaStyl, linkOk, noteCrit, noteInfo, okStyl,
  pill, pusty, rozpisStyl, KOLOR_KANALU, small, td, th, warnStyl, zEdycji, type KosztEdycja,
} from "./wycena-ui";

type Krotko = { cena_netto: number; cena_brutto: number; ustawil: string | null; ustawiono: string | null };
type Ponizej = { data: string | null; kanal: string | null; cena: number; szt: number };
type Sprzedaz = {
  szt: number; srednia_netto: number | null; srednia_brutto: number | null; ostatnia_data: string | null;
  ponizej_od: string | null; ponizej_z: number; ponizej_ile: number; ponizej: Ponizej[];
};
type Konkurent = { id: number; sklep: string; cena_brutto: number; link: string | null; dodal: string | null; dodano: string | null; historia: unknown[] };
type Koszt = {
  koszty_bazy: KosztBazy[]; baza_domyslna: BazaKosztu | null;
  fifo: number | null; fifo_kontener: string | null; fifo_data: string | null; srednia: number | null;
  najblizsza: number | null; najblizsza_kontener: string | null; najblizsza_data: string | null; najblizsza_szacunek: boolean;
};
export type CenyProduktu = {
  sku: string; shop: string; vat: number;
  min_detal: Krotko | null; min_hurt: Krotko | null; min_allegro: Krotko | null;
  sugerowana_sklepy_brutto: number | null; sugerowana_dropy_netto: number | null; sugerowana_allegro_brutto: number | null;
  aktualna_detal: Krotko | null;
  okres_dni: number; detal: Sprzedaz; hurt: Sprzedaz;
  konkurencja: Konkurent[]; konkurencja_widoczna: boolean;
  koszt: Koszt | null; koszt_widoczny: boolean; kalkulator: boolean; prowizja_tryb: TrybProwizji;
};

const zl = (n: number | null | undefined) => (n == null ? "—" : <>{zl2(n)}<small style={small}> zł</small></>);
const ktoKiedy = (c: Krotko | null) => (c ? `${c.ustawil || "—"} · ${c.ustawiono ? fmtDay(c.ustawiono) : ""}` : "nie ustawiono");

export default function ProductCena({ sku, shop }: { sku: string; shop: string }) {
  const klucz = `${sku}|${shop}`;
  const [wynik, setWynik] = useState<{ klucz: string; data?: CenyProduktu; blad?: string } | null>(null);
  const data = wynik?.klucz === klucz ? wynik.data ?? null : null;
  const blad = wynik?.klucz === klucz ? wynik.blad ?? null : null;

  useEffect(() => {
    let alive = true;
    api.get(`/ceny-produktu?sku=${encodeURIComponent(sku)}${shop ? `&shop=${encodeURIComponent(shop)}` : ""}`)
      .then((d) => { if (alive) setWynik({ klucz: `${sku}|${shop}`, data: d as CenyProduktu }); })
      .catch((e) => { if (alive) setWynik({ klucz: `${sku}|${shop}`, blad: e instanceof Error ? e.message : "nieznany błąd" }); });
    return () => { alive = false; };
  }, [sku, shop]);

  if (blad) return <div style={pusty}>Nie udało się wczytać cen: {blad}</div>;
  if (!data) {
    return (
      <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ height: 84, background: "var(--surface-1)", borderRadius: 10 }} />
        <div style={{ height: 200, background: "var(--surface-1)", borderRadius: 10 }} />
      </div>
    );
  }

  return (
    <>
      <AlarmPonizej data={data} />
      {data.koszt_widoczny && data.koszt && <KosztZakupu k={data.koszt} />}
      <Ceny data={data} />
      {data.konkurencja_widoczna && <Konkurencja data={data} />}
      {data.kalkulator && data.koszt && <KalkulatorHandlowca data={data} koszt={data.koszt} />}
    </>
  );
}

// ── Alarm: sprzedaż poniżej minimum ──────────────────────────
function AlarmPonizej({ data }: { data: CenyProduktu }) {
  const wiersze = ([["detal", data.detal, "brutto"], ["hurt / dropy", data.hurt, "netto"]] as const)
    .filter(([, s]) => s.ponizej_ile > 0);
  if (!wiersze.length) return null;
  return (
    <div style={noteCrit}>
      <span style={{ color: "var(--critical)", fontSize: 16, lineHeight: 1 }}>●</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {wiersze.map(([nazwa, s, jak]) => (
          <div key={nazwa}>
            <b style={{ color: "var(--text-hi)" }}>{s.ponizej_ile} z {s.ponizej_z} sprzedaży ({nazwa}) poniżej ceny minimalnej</b>
            {s.ponizej_od && <> od jej ustawienia {fmtDay(s.ponizej_od)}.</>}{" "}
            <span>
              {s.ponizej.map((p) => `${p.data ? fmtDay(p.data) : "—"} ${p.kanal || ""} ${zl2(p.cena)} zł ${jak}`.trim()).join(" · ")}
              {s.ponizej_ile > s.ponizej.length ? " …" : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Ceny: tabelka kanał × minimalna / sugerowana ─────────────
// Wybrana przez właściciela zamiast kolorowych kafli (w nich się gubił). Każda cena głównie
// brutto, netto pod spodem. Średnich cen sprzedaży tu celowo nie ma — dane z 30 dni zostają
// w odpowiedzi, bo karmią alarm „poniżej minimum” i „naszą cenę” na pasku konkurencji.
// Bez kolorowych wypełnień: kanał zdradza tylko kropka przy nazwie. Przy sugerowanej — ile jest nad minimum.
// Allegro ma własną cenę minimalną (wyższą — prowizja); dopóki jej nie ma, porównujemy z minimum detalu.
type Komorka = { brutto: number; netto: number } | null;

function Ceny({ data }: { data: CenyProduktu }) {
  const v = 1 + data.vat / 100;
  const zBrutto = (b: number | null | undefined): Komorka => (b == null ? null : { brutto: b, netto: b / v });
  const zNetto = (n: number | null | undefined): Komorka => (n == null ? null : { brutto: n * v, netto: n });
  const minDetal: Komorka = data.min_detal ? { brutto: data.min_detal.cena_brutto, netto: data.min_detal.cena_netto } : null;
  const minHurt: Komorka = data.min_hurt ? { brutto: data.min_hurt.cena_brutto, netto: data.min_hurt.cena_netto } : null;
  const minAllegro: Komorka = data.min_allegro ? { brutto: data.min_allegro.cena_brutto, netto: data.min_allegro.cena_netto } : null;
  const wiersze: { nazwa: string; opis: string; kolor: string; min: Komorka; sug: Komorka; minDoPor: Komorka; kto: Krotko | null }[] = [
    { nazwa: "Detal", opis: "I-CC, Veluxa, Acti", kolor: KOLOR_KANALU.detal, min: minDetal, sug: zBrutto(data.sugerowana_sklepy_brutto), minDoPor: minDetal, kto: data.min_detal },
    { nazwa: "Dropy / hurt", opis: "partnerzy, hurtownie", kolor: KOLOR_KANALU.hurt, min: minHurt, sug: zNetto(data.sugerowana_dropy_netto), minDoPor: minHurt, kto: data.min_hurt },
    { nazwa: "Allegro", opis: "własna cena minimalna", kolor: KOLOR_KANALU.allegro, min: minAllegro, sug: zBrutto(data.sugerowana_allegro_brutto), minDoPor: minAllegro ?? minDetal, kto: data.min_allegro },
  ];
  const cena = (k: Komorka) => k ? (
    <>
      <div className="num wyc-zest-cena" style={{ fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.15 }}>{zl2(k.brutto)}<small style={small}> zł</small></div>
      <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>brutto · {zl2(k.netto)} netto</div>
    </>
  ) : <div style={{ fontSize: 13, color: "var(--text-lo)" }}>nie ustawiono</div>;
  const kol = "minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 1fr)";
  return (
    <Box title="Ceny">
      <style>{`.wyc-zest-cena{font-size:20px}.wyc-zest-wiersz{gap:12px;padding:12px 14px}
        @media (max-width:520px){.wyc-zest-cena{font-size:16px}.wyc-zest-wiersz{gap:8px !important;padding:10px !important}}`}</style>
      <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
        <div className="wyc-zest-wiersz" style={{ display: "grid", gridTemplateColumns: kol, background: "var(--surface-2)", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>
          <span />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--critical)" }} />Minimalna</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--ok)" }} />Sugerowana</span>
        </div>
        {wiersze.map((w, i) => {
          const nad = w.sug && w.minDoPor && w.minDoPor.brutto > 0 ? w.sug.brutto - w.minDoPor.brutto : null;
          return (
            <div key={w.nazwa} className="wyc-zest-wiersz" style={{ display: "grid", gridTemplateColumns: kol, alignItems: "start", borderTop: i ? "1px solid var(--border-soft)" : undefined, background: "var(--bg)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 600 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: w.kolor, flexShrink: 0 }} />{w.nazwa}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2, paddingLeft: 16 }}>{w.opis}</div>
              </div>
              <div style={{ minWidth: 0 }} title={w.kto ? `Ustawił(a): ${ktoKiedy(w.kto)}` : undefined}>
                {cena(w.min)}
              </div>
              <div style={{ minWidth: 0 }}>
                {cena(w.sug)}
                {nad != null && (
                  <span style={{ ...pill, whiteSpace: "normal", marginTop: 5, ...(nad >= 0 ? okStyl : critStyl) }}>
                    {nad >= 0 ? "+" : "−"}{zl2(Math.abs(nad))} zł {nad >= 0 ? "nad minimum" : "poniżej minimum"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Box>
  );
}

// ── Koszt zakupu (bez rozpisania) ────────────────────────────
function KosztZakupu({ k }: { k: Koszt }) {
  // Tylko policzalne koszty; ten, od którego liczymy (FIFO → najbliższa → ostatnia dostawa),
  // wyróżniony i podpisany „do wyceny”.
  if (!k.koszty_bazy.length) {
    return (
      <Box title="Koszt zakupu" hint="bez rozpisania">
        <div style={{ ...pusty, padding: 20 }}>Brak dostaw tego produktu w aplikacji — koszt trzeba wpisać ręcznie w kalkulatorze.</div>
      </Box>
    );
  }
  return (
    <Box title="Koszt zakupu" hint="bez rozpisania">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 10 }}>
        {k.koszty_bazy.map((b) => {
          const glowny = b.baza === k.baza_domyslna;
          return (
            <Kafel key={b.baza} label={BAZA_KROTKO[b.baza]} dot={glowny ? "var(--accent)" : undefined}
              value={<span style={{ color: glowny ? "var(--accent)" : undefined }}>{zl(b.koszt)}</span>}
              sub={<>{glowny && <span style={{ ...pill, background: "var(--accent-soft)", color: "var(--accent)", marginRight: 6 }}>do wyceny</span>}
                <span style={{ color: b.szacunek ? "var(--warning)" : undefined }}>{b.opis}</span></>} />
          );
        })}
      </div>
    </Box>
  );
}

// ── Konkurencja ──────────────────────────────────────────────
function Konkurencja({ data }: { data: CenyProduktu }) {
  const konk = data.konkurencja;
  // Na pasku: „My” = aktualna cena sprzedaży (wpisana w „test-wycena”), „Sugerowana” = obrys pod
  // paskiem. Gdy nie ma żadnej z nich — jak dawniej średnia sprzedaż z 30 dni (wyraźnie podpisana).
  const akt = data.aktualna_detal?.cena_brutto ?? null;
  const sug = data.sugerowana_sklepy_brutto;
  const sr30 = akt == null && sug == null ? data.detal.srednia_brutto : null;
  const nasza = akt ?? sr30;
  const naszaOpis = akt != null ? "aktualna cena sprzedaży" : "średnia sprzedaż 30 dni";
  const naszaEtk = akt != null ? "My" : "Śr. 30 dni";
  const minB = data.min_detal?.cena_brutto ?? null;
  if (!konk.length) {
    return (
      <Box title="Konkurencja">
        <div style={{ ...pusty, padding: 20 }}>Nikt jeszcze nie wpisał cen konkurencji. Wpisuje się je w zakładce „test-wycena”.</div>
      </Box>
    );
  }
  const ceny = konk.map((k) => k.cena_brutto).sort((a, b) => a - b);
  const min = ceny[0], max = ceny[ceny.length - 1], srodek = mediana(ceny) as number;
  const najt = konk.find((k) => k.cena_brutto === min), najd = konk.find((k) => k.cena_brutto === max);
  const wartosci = [min, max, ...(nasza != null ? [nasza] : []), ...(sug != null ? [sug] : []), ...(minB != null ? [minB] : [])];
  const lo = Math.floor((Math.min(...wartosci) * 0.94) / 10) * 10, hi = Math.ceil((Math.max(...wartosci) * 1.06) / 10) * 10;
  const stare = konk.filter((k) => (dniTemu(k.dodano) ?? 0) > KONKURENCJA_STARA_DNI).length;

  let wniosek: React.ReactNode = null;
  if (minB != null) {
    const tansi = ceny.filter((c) => c < minB).length;
    wniosek = tansi > 0
      ? <><b>{tansi === 1 ? "Najtańszy konkurent jest" : `${tansi} konkurentów jest`} poniżej naszej ceny minimalnej</b> ({zl2(minB)} zł brutto) — z nimi nie wygramy ceną.
        {minB <= srodek ? <> Realne pole: <b className="mono">{zl2(minB)} – {zl2(srodek)} zł</b>, żeby być w tańszej połowie rynku.</> : <> Nawet środek rynku ({zl2(srodek)} zł) jest poniżej naszego minimum.</>}</>
      : <>Możemy zejść do <b className="mono">{zl2(minB)} zł</b> brutto i być najtańsi na rynku.</>;
  }

  return (
    <Box title="Konkurencja" hint={`${konk.length} ${konk.length === 1 ? "sklep" : konk.length < 5 ? "sklepy" : "sklepów"} · ceny brutto${stare ? ` · ${stare} do odświeżenia` : ""}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 10 }}>
          <Kafel label="Najtaniej" tone="ok" value={zl(min)} sub={najt?.sklep} />
          <Kafel label="Środek rynku" value={zl(srodek)} sub="połowa sklepów taniej, połowa drożej" />
          <Kafel label="Najdrożej" tone="critical" value={zl(max)} sub={najd?.sklep} />
        </div>
        <div style={kartaStyl}>
          <PasekCen lo={lo} hi={hi} min={minB}
            strefy={minB != null ? [{ od: lo, do: minB, kolor: "color-mix(in oklch, var(--critical) 40%, transparent)" }] : []}
            kropki={konk.map((k) => ({ v: k.cena_brutto, t: `${k.sklep}: ${zl2(k.cena_brutto)} zł` }))}
            my={nasza != null ? { v: nasza, etk: `${naszaEtk} ${Math.round(nasza)}` } : null}
            sug={sug != null ? { v: sug, etk: `Sugerowana ${Math.round(sug)}` } : null} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", ...hint }}>
            <span>● konkurent (najedź, żeby zobaczyć sklep)</span>
            {nasza != null && <span style={{ color: "var(--accent)" }}>▮ nasza cena ({naszaOpis})</span>}
            {sug != null && <span style={{ color: "var(--accent)" }}>┆ cena sugerowana</span>}
            {minB != null && <span style={{ color: "var(--critical)" }}>| nasza cena minimalna</span>}
          </div>
          {wniosek && <div style={noteInfo}><span style={{ color: "var(--info)" }}>i</span><div>{wniosek}</div></div>}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Sklep</th><th style={{ ...th, textAlign: "right" }}>Cena brutto</th><th style={th}>Sprawdzone</th><th style={th} /></tr></thead>
            <tbody>
              {konk.map((k) => {
                const dni = dniTemu(k.dodano);
                return (
                  <tr key={k.id}>
                    <td style={td}>{k.sklep}</td>
                    <td style={{ ...td, textAlign: "right" }} className="num">{zl2(k.cena_brutto)} zł</td>
                    <td style={{ ...td, color: "var(--text-lo)", fontSize: 12 }}>
                      {k.dodano ? fmtDay(k.dodano) : "—"} · {k.dodal || "—"}
                      {dni != null && dni > KONKURENCJA_STARA_DNI && <> <span style={{ ...pill, ...warnStyl }}>{dni} dni temu</span></>}
                    </td>
                    <td style={td}>{linkOk(k.link) && <a href={k.link as string} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", fontSize: 12 }}>oferta ↗</a>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Box>
  );
}

// ── Kalkulator handlowca ─────────────────────────────────────
const KLUCZ_PROC = "magazyn.prowizjaHandlowca";
function czytajProc(tryb: TrybProwizji): string {
  try { return localStorage.getItem(`${KLUCZ_PROC}.${tryb}`) ?? ""; } catch { return ""; }
}
function zapiszProc(tryb: TrybProwizji, v: string) {
  try { localStorage.setItem(`${KLUCZ_PROC}.${tryb}`, v); } catch { /* prywatne okno — trudno, wpisze jeszcze raz */ }
}

const STREFY = {
  ponizej: { styl: critStyl, tytul: "Poniżej ceny minimalnej", kolor: "var(--critical)" },
  styk: { styl: warnStyl, tytul: "Na styk", kolor: "var(--warning)" },
  dobra: { styl: okStyl, tytul: "Dobra cena", kolor: "var(--ok)" },
} as const;

function KalkulatorHandlowca({ data, koszt }: { data: CenyProduktu; koszt: Koszt }) {
  // Koszt towaru: ta sama zasada co w wycenie (FIFO → najbliższa → ostatnia dostawa), bez własnego.
  const bazy = koszt.koszty_bazy;
  const minH = data.min_hurt?.cena_netto ?? null;
  const prog = minH != null ? progDobrejCeny(minH, data.sugerowana_dropy_netto) : null;
  const startCena = data.sugerowana_dropy_netto ?? (prog ?? ((bazy[0]?.koszt ?? 0) * 1.3));
  const tryb = data.prowizja_tryb;

  const [cena, setCena] = useState(() => String(Math.round(startCena)));
  // Cenę można wpisać netto albo brutto (np. przepisując ostatnią sprzedaż z paragonu).
  // Liczymy zawsze od netto; dopóki handlowiec pisze w polu brutto, trzymamy jego tekst,
  // żeby przeliczenie w tle nie przestawiało mu cyfr pod kursorem.
  const [bruttoTxt, setBruttoTxt] = useState<string | null>(null);
  const mnoznikVat = 1 + data.vat / 100;
  const zmienNetto = (v: string) => { setCena(v); setBruttoTxt(null); };
  const zmienBrutto = (v: string) => { setBruttoTxt(v); setCena(String(Math.round((num(v) / mnoznikVat) * 100) / 100)); };
  const [baza, setBaza] = useState<BazaKosztu | "wlasna">(koszt.baza_domyslna ?? bazy[0]?.baza ?? "fifo");
  const [proc, setProc] = useState(() => czytajProc(tryb));
  const [koszty, setKoszty] = useState<KosztEdycja[]>([]);

  const K = bazy.find((b) => b.baza === baza)?.koszt ?? bazy[0]?.koszt ?? 0;
  const N = num(cena);
  const w = useMemo(() => liczHandlowca(N, K, koszty.map(zEdycji), tryb, num(proc)), [N, K, koszty, tryb, proc]);
  const s = minH != null && prog != null ? strefa(N, minH, prog) : null;

  if (!bazy.length) {
    return (
      <Box title="Kalkulator handlowca · hurt / dropy">
        <div style={{ ...pusty, padding: 20 }}>Brak kosztu zakupu tego produktu — kalkulator nie ma od czego liczyć.</div>
      </Box>
    );
  }

  const wartosci = [K, N, ...(minH != null ? [minH] : []), ...(prog != null ? [prog] : [])].filter((v) => v > 0);
  const lo = Math.floor((Math.min(...wartosci) * 0.9) / 5) * 5;
  const hi = Math.ceil((Math.max(...wartosci) * 1.25) / 5) * 5;
  const kolKonk = data.konkurencja.map((k) => k.cena_brutto);
  const najtanszyKonkNetto = kolKonk.length ? Math.min(...kolKonk) / (1 + data.vat / 100) : null;

  return (
    <Box title="Kalkulator handlowca · hurt / dropy" hint="liczy na żywo · nic się nie zapisuje">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 12 }}>
        <div style={kartaStyl}>
          <Wiersz label="Twoja cena" htmlFor="hand-cena">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Pole id="hand-cena" value={cena} onChange={zmienNetto} unit="zł netto" />
              <Pole id="hand-cena-brutto" value={bruttoTxt ?? String(Math.round(N * mnoznikVat * 100) / 100)} onChange={zmienBrutto} unit="zł brutto" />
              <span style={hint}>VAT {data.vat}%</span>
            </div>
          </Wiersz>
          <input type="range" aria-label="Cena netto (suwak)" min={lo} max={hi} step={1} value={Math.min(hi, Math.max(lo, N))}
            onChange={(e) => zmienNetto(e.target.value)} style={{ width: "100%", accentColor: "var(--accent)" }} />
          {minH != null && prog != null ? (
            <PasekCen lo={lo} hi={hi} min={minH}
              strefy={[
                { od: lo, do: minH, kolor: "color-mix(in oklch, var(--critical) 55%, transparent)" },
                { od: minH, do: prog, kolor: "color-mix(in oklch, var(--warning) 50%, transparent)" },
                { od: prog, do: hi, kolor: "color-mix(in oklch, var(--ok) 50%, transparent)" },
              ]}
              my={{ v: N, etk: `${Math.round(N)} zł` }} />
          ) : null}
          {s && minH != null && prog != null ? (
            <div style={{ ...STREFY[s].styl, borderRadius: 10, padding: "10px 12px", fontSize: 12.5, display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 16, lineHeight: 1 }}>●</span>
              <div style={{ color: "var(--text-hi)" }}>
                <b>{STREFY[s].tytul}{s === "ponizej" ? ` o ${zl2(minH - N)} zł` : ""}.</b>{" "}
                <span style={{ color: "var(--text-mid)" }}>
                  {s === "ponizej" && `Minimum dla hurtu i dropów to ${zl2(minH)} zł netto. Sprzedaż możliwa, ale firma zarabia za mało.`}
                  {s === "styk" && `Powyżej minimum (${zl2(minH)} zł), ale poniżej ${data.sugerowana_dropy_netto != null && data.sugerowana_dropy_netto > minH ? "ceny sugerowanej" : "minimum + 10%"} (${zl2(prog)} zł).`}
                  {s === "dobra" && `Od ${zl2(prog)} zł netto wzwyż (${data.sugerowana_dropy_netto != null && data.sugerowana_dropy_netto > minH ? "cena sugerowana" : "minimum + 10%"}).`}
                </span>
              </div>
            </div>
          ) : (
            <div style={noteInfo}>Admin nie ustawił jeszcze ceny minimalnej hurt / dropy — kolory pojawią się, gdy ją ustawi.</div>
          )}

          <Wiersz label="Koszt towaru">
            <KosztTowaru koszty={bazy} baza={baza} onBaza={setBaza} wlasny="" onWlasny={() => { /* bez własnego */ }} idPrefix="hand" bezWlasnego />
          </Wiersz>
          <Wiersz label="Twoja prowizja" htmlFor="hand-proc">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Pole id="hand-proc" value={proc} onChange={(v) => { setProc(v); zapiszProc(tryb, v); }} unit="%" width={56} />
              <span style={hint}>{tryb === "A" ? "od ceny netto" : "od zysku"} · sposób ustawia admin w Twoim koncie</span>
            </div>
          </Wiersz>
          <div>
            <div style={{ ...hint, marginBottom: 6 }}>Dodatkowe koszty tej sprzedaży (od Twojej ceny netto)</div>
            <KosztyEdytor koszty={koszty} onChange={setKoszty} zOd={false} idPrefix="hand" />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Kafel label="Ty zarobisz" value={<span style={{ color: "var(--accent)" }}>{zl2(w.prowizja)}<small style={small}> zł</small></span>}
              sub={tryb === "A" ? `${proc1(num(proc))} od ceny netto` : `${proc1(num(proc))} od zysku ${zl2(Math.max(0, w.zyskPrzed))} zł`} />
            <Kafel label="Firma zarobi" tone={w.zyskFirmy < 0 ? "critical" : "neutral"}
              value={<>{zl2(w.zyskFirmy)}<small style={small}> zł</small></>}
              sub={w.marzaFirmy != null ? `marża ${proc1(w.marzaFirmy)} od ceny` : undefined} />
          </div>
          <div style={rozpisStyl}>
            <Linia l="Cena sprzedaży netto" v={`${zl2(w.netto)} zł`} />
            <Linia wciecie l={`− koszt towaru (${BAZA_KROTKO[baza]})`} v={`${zl2(w.koszt)} zł`} />
            {w.koszty.map((k, i) => (
              <Linia key={i} wciecie l={<>− {k.nazwa || "koszt bez nazwy"}{k.typ === "proc" && <span style={hint}> {proc1(k.wartosc)}</span>}</>} v={`${zl2(k.kwota)} zł`} />
            ))}
            <Linia suma l="= zysk przed prowizją" v={`${zl2(w.zyskPrzed)} zł`} />
            <Linia wciecie l={`− Twoja prowizja (${tryb === "A" ? "od ceny" : "od zysku"})`} v={`${zl2(w.prowizja)} zł`} />
            <Linia suma l="= zysk firmy" v={`${zl2(w.zyskFirmy)} zł`} kolor={w.zyskFirmy < 0 ? "var(--critical)" : "var(--ok)"} />
          </div>
          {najtanszyKonkNetto != null && N > 0 && (
            <div style={hint}>
              Najtańszy sklep detaliczny sprzedaje za {zl2(najtanszyKonkNetto * (1 + data.vat / 100))} zł brutto.
              Przy Twojej cenie klient hurtowy ma do niego ok. <b className="mono" style={{ color: "var(--text-mid)" }}>{proc1(((najtanszyKonkNetto - N) / N) * 100)}</b> narzutu.
            </div>
          )}
        </div>
      </div>
    </Box>
  );
}
