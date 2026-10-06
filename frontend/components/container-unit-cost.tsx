"use client";
// ============================================================
// MAGAZYN — zakładka „Koszt jednostkowy" na karcie kontenera (metoda szefa).
//
// Rachunek liczy backend na bieżąco z karty kontenera i płatności
// (routers/koszt_kontenera.py → services/koszt_kontenera.py) — bez wgrywania plików.
// Tu tylko pokazujemy wynik i zbieramy ręczne poprawki: kurs, fracht, Lenmar, transport,
// cenę w walucie / szt i stawkę cła pozycji. Każda wpisana liczba od razu przelicza
// tabelę (POST …/koszt/podglad, nic nie zapisuje); „Zapisz poprawki" zapisuje same poprawki.
// Puste pole = wartość automatyczna, więc kontener bez żadnej edycji też ma koszt.
//
// Zakładka pokazuje się przy „Koszt jednostkowy kontenera" (canSeeLandedCost), pola do
// wpisywania i zapis — przy „Liczenie kosztu jednostkowego" (canEditLandedCost).
// Dawne rozliczenie z SAD-u to osobna zakładka „SAD" (container-landed-cost.tsx) — superadmin.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { toast } from "./toast";

// ── typy odpowiedzi backendu (models.py: Koszt*Out) ─────────
type Platnosc = { typ: string; kwota: number; waluta: string; data: string | null; kurs: number | null; data_kursu: string | null };
type Grupa = {
  id: number; nazwa: string; krajowa: boolean; waluta: string; kurs: number | null; kurs_auto: number | null;
  kurs_reczny: boolean; szacunek: boolean; wartosc_waluta: number; wartosc_zrodlo: string; platnosci: Platnosc[];
};
type Pozycja = {
  item_id: number; sku: string; nazwa: string | null; szt: number; grupa: number; krajowa: boolean; cbm_szt: number;
  cena_planowana: number; cena_waluta: number; cena_reczna: boolean; cena_zrodlo: string; towar: number;
  gratisy: number; gratis_przypiety: boolean; fracht: number; lenmar: number;
  clo: number; transport: number; kod_cn: string | null; stawka: number; stawka_zrodlo: string;
  stawka_slownik: number | null; koszt_jednostkowy: number | null; szacunek: boolean;
  koszt_erp: number | null; erp_zrodlo: string | null;
};
type Koszt = {
  container_id: number; krajowa: boolean; szacunek: boolean; podzial: string; zgloszen: number;
  towar: number; gratisy: number; fracht: number; fracht_auto: number; fracht_usd: number; kurs_frachtu: number | null;
  data_kursu_frachtu: string | null; data_frachtu: string | null; lenmar: number; lenmar_auto: number;
  clo: number; transport: number; transport_auto: number; suma: number; narzut_proc: number | null;
  kurs_towaru_reczny: number | null; fracht_reczny: number | null; lenmar_reczny: number | null;
  transport_reczny: number | null; lenmar_kontener: number; lenmar_zgloszenie: number;
  grupy: Grupa[]; pozycje: Pozycja[]; uwagi: { poziom: string; tresc: string }[];
  razem_z: KontenerKrotko[];
  zapisal: string | null; zapisano: string | null; moze_edytowac: boolean;
};

type KontenerKrotko = { id: number; etykieta: string; dostawca?: string | null; eta?: string | null };

// Poprawki jako tekst z pól (po polsku, z przecinkiem). "" = automat.
type Szkic = {
  kurs: string; fracht: string; lenmar: string; transport: string;
  cena: Record<number, string>; stawka: Record<number, string>;
  gratis: number[];   // pozycje, na które przypięto różnicę płatności (gratisy) — zwykle żadna = cała FV
};
type PoleKontenera = "kurs" | "fracht" | "lenmar" | "transport";

const pl = (n: number | null | undefined, d = 2) =>
  (n ?? 0).toLocaleString("pl-PL", { minimumFractionDigits: d, maximumFractionDigits: d });
const liczba = (s: string): number | null => {
  const t = (s || "").replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const tekst = (n: number | null | undefined, d = 2) => (n == null ? "" : pl(n, d).replace(/\s/g, ""));
const data = (s: string | null) => (s ? new Date(s).toLocaleDateString("pl-PL") : "—");

function szkicZ(k: Koszt): Szkic {
  const cena: Record<number, string> = {};
  const stawka: Record<number, string> = {};
  for (const p of k.pozycje) {
    if (p.cena_reczna) cena[p.item_id] = tekst(p.cena_waluta, 4).replace(/,?0+$/, "") || "0";
    if (p.stawka_zrodlo === "reczna") stawka[p.item_id] = tekst(p.stawka, 2);
  }
  return {
    kurs: tekst(k.kurs_towaru_reczny, 4), fracht: tekst(k.fracht_reczny), lenmar: tekst(k.lenmar_reczny),
    transport: tekst(k.transport_reczny), cena, stawka,
    gratis: k.pozycje.filter((p) => p.gratis_przypiety).map((p) => p.item_id),
  };
}

function cialo(s: Szkic) {
  const ids = new Set([...Object.keys(s.cena).map(Number), ...Object.keys(s.stawka).map(Number), ...s.gratis]);
  return {
    kurs_towaru: liczba(s.kurs), fracht_pln: liczba(s.fracht), lenmar_pln: liczba(s.lenmar),
    transport_pln: liczba(s.transport),
    pozycje: [...ids].sort((a, b) => a - b).map((id) => ({
      item_id: id, cena_waluta: liczba(s.cena[id] ?? ""), stawka_cla: liczba(s.stawka[id] ?? ""), gratis: s.gratis.includes(id),
    })).filter((p) => p.cena_waluta != null || p.stawka_cla != null || p.gratis),
  };
}

export default function UnitCostTab({ containerId }: { containerId: number }) {
  const [k, setK] = useState<Koszt | null>(null);
  const [blad, setBlad] = useState<string | null>(null);
  const [szkic, setSzkic] = useState<Szkic | null>(null);
  const [zapisany, setZapisany] = useState<string>("");   // JSON zapisanych poprawek — do „są zmiany?"
  const [busy, setBusy] = useState(false);
  const licznik = useRef(0);

  const przyjmij = (z: Koszt) => {
    const s = szkicZ(z);
    setK(z); setSzkic(s); setZapisany(JSON.stringify(cialo(s))); setBlad(null);
  };
  const wczytaj = useCallback(() => api.get(`/kontenery/${containerId}/koszt`) as Promise<Koszt>, [containerId]);
  useEffect(() => {
    let zywy = true;
    wczytaj().then((z) => { if (zywy) przyjmij(z); })
      .catch((e) => { if (zywy) setBlad(e instanceof Error ? e.message : "Nie udało się wczytać kosztu"); });
    return () => { zywy = false; };
  }, [wczytaj]);

  // Przeliczenie z poprawkami z formularza — bez zapisu. Odpowiedź starszego zapytania,
  // które wróciło po nowszym, wyrzucamy (licznik), żeby tabela nie mrugała wstecz.
  const przelicz = useCallback(async (s: Szkic) => {
    const nr = ++licznik.current;
    try {
      const z = (await api.post(`/kontenery/${containerId}/koszt/podglad`, cialo(s))) as Koszt;
      if (nr === licznik.current) setK(z);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Nie udało się przeliczyć", "error");
    }
  }, [containerId]);

  const zmien = (s: Szkic) => { setSzkic(s); };
  const zatwierdz = () => { if (szkic) void przelicz(szkic); };

  const zapisz = async () => {
    if (!szkic) return;
    setBusy(true);
    try {
      przyjmij((await api.put(`/kontenery/${containerId}/koszt`, cialo(szkic))) as Koszt);
      toast("Zapisano poprawki kosztu", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Nie udało się zapisać", "error");
    } finally {
      setBusy(false);
    }
  };

  if (blad) return <Komunikat poziom="blad" tresc={blad} />;
  if (!k || !szkic) return <div className="pulse-soft" style={{ height: 200, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />;
  if (!k.pozycje.length) return <Komunikat poziom="info" tresc="Kontener nie ma pozycji — nie ma czego liczyć." />;

  const edycja = k.moze_edytowac;
  const brudny = JSON.stringify(cialo(szkic)) !== zapisany;
  const importowe = k.grupy.filter((g) => !g.krajowa);
  const grupaPo = new Map(k.grupy.map((g) => [g.id, g]));
  const wiele = importowe.length > 1;
  const glowna = importowe[0];
  const waluta = glowna?.waluta ?? "USD";
  const kursSzac = importowe.some((g) => g.szacunek);
  const ileRecznych = [szkic.kurs, szkic.fracht, szkic.lenmar, szkic.transport].filter(Boolean).length
    + Object.values(szkic.cena).filter(Boolean).length + Object.values(szkic.stawka).filter(Boolean).length
    + szkic.gratis.length;
  const ustawPole = (pole: PoleKontenera, v: string) => zmien({ ...szkic, [pole]: v });
  const przywroc = (pole: PoleKontenera) => { const s = { ...szkic, [pole]: "" }; setSzkic(s); void przelicz(s); };
  const ustawPoz = (rodzaj: "cena" | "stawka", id: number, v: string) =>
    zmien({ ...szkic, [rodzaj]: { ...szkic[rodzaj], [id]: v } });
  // Przypięcie różnicy płatności (gratisów) do jednej pozycji — jedna na fakturę (grupę).
  // Drugie kliknięcie odpina i różnica wraca na całą fakturę.
  const przypnij = (id: number) => {
    const grupa = k.pozycje.find((p) => p.item_id === id)?.grupa;
    const zGrupy = new Set(k.pozycje.filter((p) => p.grupa === grupa).map((p) => p.item_id));
    const bylo = szkic.gratis.includes(id);
    const s = { ...szkic, gratis: [...szkic.gratis.filter((g) => !zGrupy.has(g)), ...(bylo ? [] : [id])] };
    setSzkic(s); void przelicz(s);
  };
  const pokazGratisy = !k.krajowa && (Math.abs(k.gratisy) >= 0.01 || szkic.gratis.length > 0);
  const przywrocCene = (id: number) => {
    const cena = { ...szkic.cena }; delete cena[id];
    const s = { ...szkic, cena }; setSzkic(s); void przelicz(s);
  };

  // ── kafelki ───────────────────────────────────────────────
  const popKursu = (
    <div className="kj-pop" role="tooltip">
      {importowe.map((g) => (
        <div key={g.id} style={{ marginBottom: 6 }}>
          {wiele && <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", margin: "2px 0 4px" }}>{g.nazwa || "Lot"} · kurs {pl(g.kurs, 4)}</div>}
          {g.platnosci.length ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
              <thead><tr>
                <th style={popTh}>Płatność</th><th style={{ ...popTh, textAlign: "right" }}>Kwota</th>
                <th style={popTh}>Kurs z dnia</th><th style={{ ...popTh, textAlign: "right" }}>NBP</th>
              </tr></thead>
              <tbody>{g.platnosci.map((p, i) => (
                <tr key={i}>
                  <td style={popTd}>{p.typ === "balance" ? "Balance" : "Zaliczka"}
                    <div style={{ fontSize: 10.5, color: p.data ? "var(--text-lo)" : "var(--warning)" }}>{p.data ? `zapł. ${data(p.data)}` : "niezapłacona"}</div></td>
                  <td style={{ ...popTd, textAlign: "right" }} className="mono">{pl(p.kwota, 0)} {p.waluta}</td>
                  <td style={popTd} className="mono">{p.waluta === "PLN" ? "—" : data(p.data_kursu)}</td>
                  <td style={{ ...popTd, textAlign: "right" }} className="mono">{p.kurs ? pl(p.kurs, 4) : "brak"}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>Brak płatności na karcie — kurs to ostatni kurs NBP.</div>}
        </div>
      ))}
      <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-lo)", lineHeight: 1.5 }}>
        Kurs średni NBP (tabela A) z dnia roboczego przed płatnością. Niezapłacona płatność — po ostatnim kursie.
      </p>
    </div>
  );

  const kafle = k.krajowa ? [
    <Kafel key="t" l="Towar" v={`${pl(k.towar, 0)} zł`} n="ceny z FV na pozycjach" />,
    <Kafel key="tr" l="Transport krajowy" v={`${pl(k.transport, 0)} zł`} n="do magazynu, po wartości" />,
    <Kafel key="n" l="Narzut" v={k.narzut_proc != null ? `${pl(k.narzut_proc, 1)}%` : "—"} n="transport / towar" akcent />,
  ] : [
    <Kafel key="t" l="Towar" v={`${pl(k.towar + k.gratisy, 0)} zł`} tag={k.szacunek ? <Tag t="szac" /> : null}
      n={(wiele ? `${importowe.length} loty z płatności` : glowna ? `${pl(glowna.wartosc_waluta, 0)} ${waluta} ${glowna.wartosc_zrodlo === "plan" ? "z cen pozycji" : "z płatności"}` : "")
        + (Math.abs(k.gratisy) >= 0.01 ? ` · w tym gratisy ${pl(k.gratisy, 0)} zł` : "")} />,
    <Kafel key="f" l="Fracht" v={`${pl(k.fracht, 0)} zł`}
      n={k.fracht_reczny != null ? "wpisany ręcznie" : k.fracht_usd ? `${pl(k.fracht_usd, 0)} USD × ${pl(k.kurs_frachtu, 4)}` : "brak na karcie"} />,
    <Kafel key="l" l="Lenmar" v={`${pl(k.lenmar, 0)} zł`}
      n={k.lenmar_reczny != null ? "wpisany ręcznie" : `ryczałt · ${k.zgloszen} ${k.zgloszen === 1 ? "zgłoszenie" : "zgłoszenia"}`} />,
    <Kafel key="c" l="Cło" v={`${pl(k.clo, 0)} zł`} n="z kodów CN pozycji"
      tag={k.pozycje.some((p) => p.stawka_zrodlo === "brak") ? <Tag t="brak" /> : null} />,
    <Kafel key="tr" l="Transport krajowy" v={`${pl(k.transport, 0)} zł`} n={`do magazynu, po ${k.podzial === "cbm" ? "CBM" : "wartości"}`} />,
    <Kafel key="n" l="Narzut" v={k.narzut_proc != null ? `${pl(k.narzut_proc, 1)}%` : "—"} n="koszty importu / towar" akcent />,
    <Kafel key="k" l="Kurs towaru" pop={popKursu}
      v={wiele ? "per lot" : pl(glowna?.kurs, 4)}
      tag={kursSzac && !szkic.kurs ? <Tag t="szac" /> : null}
      n={szkic.kurs ? "wpisany ręcznie" : `średnia z płatności · najedź`} />,
  ];

  // ── założenia ─────────────────────────────────────────────
  const zalozenia: { pole: PoleKontenera; nazwa: string; pod: string; auto: string; placeholder: string; zrodlo: string; d: number }[] = [];
  if (!k.krajowa) {
    zalozenia.push({
      pole: "kurs", nazwa: "Kurs towaru", pod: `${waluta} → PLN${wiele ? " · dla wszystkich lotów" : ""}`,
      auto: wiele ? importowe.map((g) => `${g.nazwa || "lot"}: ${pl(g.kurs_auto, 4)}`).join(" · ") : pl(glowna?.kurs_auto, 4),
      placeholder: pl(glowna?.kurs_auto, 4), zrodlo: "z płatności", d: 4,
    });
    zalozenia.push({
      pole: "fracht", nazwa: "Fracht morski", pod: `zł · dzielony po ${k.podzial === "cbm" ? "CBM" : "wartości"}`,
      auto: k.fracht_usd ? `${pl(k.fracht_usd, 0)} USD × ${pl(k.kurs_frachtu, 4)} (${data(k.data_kursu_frachtu)}) = ${pl(k.fracht_auto)}` : "brak frachtu na karcie",
      placeholder: pl(k.fracht_auto), zrodlo: "z karty kontenera", d: 2,
    });
    zalozenia.push({
      pole: "lenmar", nazwa: "Opłaty Lenmara (bez frachtu)", pod: `zł · dzielone po ${k.podzial === "cbm" ? "CBM" : "wartości"}`,
      auto: k.zgloszen > 1
        ? `${pl(k.lenmar_kontener, 0)} + ${pl(k.lenmar_zgloszenie, 0)} × ${k.zgloszen - 1} = ${pl(k.lenmar_auto)}`
        : `${pl(k.lenmar_kontener, 0)} za kontener, 1 zgłoszenie (każde kolejne +${pl(k.lenmar_zgloszenie, 0)})`,
      placeholder: pl(k.lenmar_auto), zrodlo: "ryczałt", d: 2,
    });
  }
  zalozenia.push({
    pole: "transport", nazwa: "Transport do magazynu", pod: `zł · dzielony po ${k.podzial === "cbm" ? "CBM" : "wartości"}`,
    auto: pl(k.transport_auto), placeholder: pl(k.transport_auto), zrodlo: "z karty kontenera", d: 2,
  });

  // ── tabela ────────────────────────────────────────────────
  const erpNazwa = k.pozycje.find((p) => p.erp_zrodlo)?.erp_zrodlo === "fakturownia" ? "Fakturownia" : "Subiekt";
  const sumaSzt = k.pozycje.reduce((s, p) => s + p.szt, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <style>{css}</style>
      <div className="kj-kafle">{kafle}</div>

      {(k.krajowa || !!k.uwagi.length) && (
        <div style={{ display: "grid", gap: 8 }}>
          {k.krajowa && (
            <div style={{ ...karta, padding: "14px 16px", fontSize: 12.5, color: "var(--text-mid)", lineHeight: 1.6 }}>
              <b style={{ color: "var(--text-hi)" }}>Dostawa krajowa:</b> cena z FV + transport do magazynu.
              Towar kupiony w Polsce, więc bez cła, frachtu morskiego i opłat Lenmara.
            </div>
          )}
          {k.uwagi.map((u, i) => <Komunikat key={i} poziom={u.poziom} tresc={u.tresc} />)}
        </div>
      )}

      {!k.krajowa && (
        <WspolnaFaktura containerId={containerId} edycja={edycja}
          onZmiana={() => { wczytaj().then(przyjmij).catch(() => toast("Nie udało się wczytać kosztu", "error")); }} />
      )}

      <div style={karta}>
        <Naglowek tytul="Założenia" hint={edycja ? "Puste pole = wartość automatyczna. Wpisana liczba zastępuje automat." : undefined} />
        {zalozenia.map((z) => {
          const v = szkic[z.pole];
          return (
            <div key={z.pole} className="kj-zal">
              <div style={{ fontSize: 13, fontWeight: 600 }}>{z.nazwa}
                <div style={{ fontWeight: 400, fontSize: 11, color: "var(--text-lo)" }}>{z.pod}</div></div>
              <div style={{ fontSize: 12, color: "var(--text-mid)" }}>automat: <span className="mono" style={{ color: "var(--text-hi)" }}>{z.auto}</span></div>
              <div>
                {edycja ? (
                  <input value={v} placeholder={z.placeholder} inputMode="decimal" aria-label={`${z.nazwa}: wartość ręczna`}
                    onChange={(e) => ustawPole(z.pole, e.target.value)} onBlur={zatwierdz}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    style={{ ...input, ...(v ? reczneStyl : {}), width: "100%", maxWidth: 130 }} />
                ) : <span className="mono">{v || z.placeholder}</span>}
              </div>
              <div>{v ? <Tag t="rec" tekst="ręcznie" /> : <span style={{ ...tag, background: "var(--surface-2)", color: "var(--text-lo)" }}>{z.zrodlo.toUpperCase()}</span>}</div>
              <div>{edycja && v ? <button onClick={() => przywroc(z.pole)} style={btnLink}>przywróć automat</button> : null}</div>
            </div>
          );
        })}
      </div>

      <div style={karta}>
        <Naglowek tytul="Koszt na sztukę" hint={k.krajowa ? "ceny z FV + transport" :
          wiele ? "Wartość lotu = jego płatności, rozłożone po cenach z pozycji"
            : glowna ? `Wartość towaru = ${pl(glowna.wartosc_waluta, 0)} ${waluta} ${glowna.wartosc_zrodlo === "plan" ? "z cen pozycji" : "z płatności"}, rozłożona po cenach z pozycji kontenera` : undefined} />
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>
              <Th l>SKU</Th><Th>Szt.</Th>
              <Th>{k.krajowa ? "Cena z FV/szt" : `Cena ${waluta}/szt`}</Th>
              {!k.krajowa && <><Th>Towar/szt</Th>{pokazGratisy && <Th><span title="Różnica między płatnościami a cenami pozycji — gratisy z faktury (albo rabat). Domyślnie na całą fakturę po wartości; „przypnij” daje całość jednej pozycji.">Gratisy/szt</span></Th>}<Th>Fracht/szt</Th><Th>Lenmar/szt</Th><Th>Cło/szt · CN · stawka %</Th></>}
              <Th>Transport/szt</Th><Th>Koszt jedn.</Th>
              <Th><span title="Bieżący koszt zakupu w ERP spółki-importera — średnia z towaru na stanie, więc może obejmować też wcześniejsze dostawy.">{erpNazwa}</span></Th>
              <Th>Różnica</Th>
            </tr></thead>
            <tbody>
              {k.pozycje.map((p) => {
                const szt = p.szt || 1;
                const g = grupaPo.get(p.grupa);
                const vCena = szkic.cena[p.item_id] ?? "";
                const vStawka = szkic.stawka[p.item_id] ?? "";
                const roz = p.koszt_erp && p.koszt_jednostkowy ? (p.koszt_jednostkowy / p.koszt_erp - 1) * 100 : null;
                return (
                  <tr key={p.item_id}>
                    <td style={{ ...td, textAlign: "left" }}>
                      <span className="mono">{p.sku}</span>
                      <span style={{ display: "inline-flex", gap: 4, marginLeft: 6, verticalAlign: 1 }}>
                        {p.szacunek && <Tag t="szac" />}{p.cena_reczna && <Tag t="rec" />}
                      </span>
                      <div style={{ fontSize: 10.5, color: "var(--text-lo)" }}>{p.nazwa ?? ""}{wiele && g?.nazwa ? ` · ${g.nazwa}` : ""}</div>
                    </td>
                    <td style={tdM}>{pl(p.szt, 0)}</td>
                    <td style={tdM}>
                      {edycja ? (
                        <input value={vCena} placeholder={pl(p.cena_waluta, p.krajowa ? 2 : 4)} inputMode="decimal"
                          aria-label={`Cena za sztukę ${p.sku}`}
                          onChange={(e) => ustawPoz("cena", p.item_id, e.target.value)} onBlur={zatwierdz}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          style={{ ...input, width: 84, ...(vCena ? reczneStyl : {}) }} />
                      ) : <span>{pl(p.cena_waluta, p.krajowa ? 2 : 4)}</span>}
                      {edycja && vCena
                        ? <div><button onClick={() => przywrocCene(p.item_id)} style={btnLink}>automat</button></div>
                        : !p.krajowa ? <div style={{ fontSize: 10.5, color: p.cena_zrodlo === "kontener" ? "var(--info)" : "var(--text-lo)" }}>
                            {p.cena_zrodlo === "kontener" ? "z kontenera (proforma)" : `plan ${pl(p.cena_planowana)} zł`}</div> : null}
                    </td>
                    {!k.krajowa && <>
                      <td style={tdM}>{pl(p.towar / szt)}</td>
                      {pokazGratisy && (
                        <td style={tdM}>
                          <span style={{ color: p.gratisy ? undefined : "var(--text-disabled)" }}>{pl(p.gratisy / szt)}</span>
                          {edycja ? (
                            <div><button onClick={() => przypnij(p.item_id)} style={{ ...btnLink, color: p.gratis_przypiety ? "var(--accent)" : "var(--info)" }}
                              title={p.gratis_przypiety ? "Odepnij — różnica wróci na całą fakturę" : "Przypnij całą różnicę (gratisy) do tej pozycji"}>
                              {p.gratis_przypiety ? "przypięte ✓" : "przypnij"}</button></div>
                          ) : p.gratis_przypiety ? <div style={{ fontSize: 10.5, color: "var(--accent)" }}>przypięte</div> : null}
                        </td>
                      )}
                      <td style={tdM}>{pl(p.fracht / szt)}</td>
                      <td style={tdM}>{pl(p.lenmar / szt)}</td>
                      <td style={tdM}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                          <span>{pl(p.clo / szt)}</span>
                          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-lo)" }}>{p.kod_cn ?? "brak CN"}</span>
                          {edycja ? (
                            <input value={vStawka} inputMode="decimal" aria-label={`Stawka cła % ${p.sku}`}
                              placeholder={p.stawka_slownik != null ? pl(p.stawka_slownik, 1) : "?"}
                              onChange={(e) => ustawPoz("stawka", p.item_id, e.target.value)} onBlur={zatwierdz}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              style={{ ...input, width: 52, ...(vStawka ? reczneStyl : {}) }} />
                          ) : <span>{pl(p.stawka, 1)}%</span>}
                          {p.stawka_zrodlo === "brak" ? <Tag t="brak" /> : p.stawka_zrodlo === "reczna" ? <Tag t="rec" /> : null}
                        </div>
                      </td>
                    </>}
                    <td style={tdM}>{pl(p.transport / szt)}</td>
                    <td style={{ ...tdM, fontWeight: 700, color: "var(--accent)", background: "color-mix(in oklch, var(--accent) 7%, transparent)" }}>
                      {p.koszt_jednostkowy != null ? pl(p.koszt_jednostkowy) : "—"}
                    </td>
                    <td style={{ ...tdM, color: "var(--text-lo)" }}>{p.koszt_erp ? pl(p.koszt_erp) : "—"}</td>
                    <td style={{ ...tdM, color: roz == null ? "var(--text-disabled)" : roz >= 0 ? "var(--critical)" : "var(--ok)" }}>
                      {roz == null ? "—" : `${roz >= 0 ? "+" : ""}${pl(roz, 1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr>
              <td style={{ ...td, textAlign: "left", fontWeight: 700, color: "var(--text-mid)", borderBottom: 0 }}>Razem</td>
              <td style={tdSum}>{pl(sumaSzt, 0)}</td><td style={tdSum} />
              {!k.krajowa && <>
                <td style={tdSum}>{pl(k.towar, 0)}</td>{pokazGratisy && <td style={tdSum}>{pl(k.gratisy, 0)}</td>}<td style={tdSum}>{pl(k.fracht, 0)}</td>
                <td style={tdSum}>{pl(k.lenmar, 0)}</td><td style={tdSum}>{pl(k.clo, 0)}</td>
              </>}
              <td style={tdSum}>{pl(k.transport, 0)}</td><td style={tdSum}>{pl(k.suma, 0)} zł</td>
              <td style={tdSum} /><td style={tdSum} />
            </tr></tfoot>
          </table>
        </div>
      </div>

      {edycja && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={zapisz} disabled={busy || !brudny} style={{ ...btnPri, opacity: busy || !brudny ? 0.5 : 1 }}>
            {busy ? "Zapisuję…" : "Zapisz poprawki"}
          </button>
          {brudny && <button onClick={() => { wczytaj().then(przyjmij).catch(() => toast("Nie udało się wczytać kosztu", "error")); }} style={btnSec}>Odrzuć zmiany</button>}
          <span style={{ fontSize: 11.5, color: "var(--text-lo)", maxWidth: "70ch" }}>
            {brudny ? "Zapis zachowa tylko poprawki ręczne. Reszta liczy się na bieżąco z karty kontenera i płatności."
              : ileRecznych ? `Zapisane poprawki: ${ileRecznych}${k.zapisal ? ` (${k.zapisal}${k.zapisano ? `, ${data(k.zapisano)}` : ""})` : ""}. Pozostałe wartości liczą się same.`
                : "Nic nie poprawiano. Koszt liczy się sam z karty kontenera i płatności, więc ten kontener i tak wpada do FIFO."}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Wspólna faktura: kontenery rozliczane razem ─────────────
// Faktura dostawcy bywa rozłożona na dwa kontenery, a płatności wpisane według faktur —
// wtedy jeden kontener ma pieniądze za towar, który jedzie w drugim. Połączone kontenery
// liczą towar ze wspólnych płatności; fracht, Lenmar i transport zostają na swoich kartach.
function WspolnaFaktura({ containerId, edycja, onZmiana }: { containerId: number; edycja: boolean; onZmiana: () => void }) {
  const [dane, setDane] = useState<{ polaczone: KontenerKrotko[]; kandydaci: KontenerKrotko[] } | null>(null);
  const [wybor, setWybor] = useState("");
  const [busy, setBusy] = useState(false);
  const [licznik, setLicznik] = useState(0);
  useEffect(() => {
    let zywy = true;
    api.get(`/kontenery/${containerId}/rozliczenie-razem`)
      .then((r) => { if (zywy) setDane(r as { polaczone: KontenerKrotko[]; kandydaci: KontenerKrotko[] }); })
      .catch(() => { /* bez listy sekcja się po prostu nie pokaże */ });
    return () => { zywy = false; };
  }, [containerId, licznik]);
  if (!dane || (!edycja && !dane.polaczone.length)) return null;

  const zapisz = async (ids: number[]) => {
    setBusy(true);
    try {
      await api.put(`/kontenery/${containerId}/rozliczenie-razem`, { kontenery: ids });
      setWybor(""); setLicznik((n) => n + 1); onZmiana();
      toast(ids.length ? "Zapisano wspólną fakturę — płatności liczone razem" : "Kontener rozliczany sam", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Nie udało się zapisać", "error");
    } finally { setBusy(false); }
  };
  const ids = dane.polaczone.map((x) => x.id);
  return (
    <div style={karta}>
      <Naglowek tytul="Wspólna faktura" hint="Płatności połączonych kontenerów idą na towar wszystkich — fracht, Lenmar i transport zostają na kartach" />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 16px" }}>
        <span style={{ fontSize: 12.5, color: "var(--text-mid)" }}>Rozliczany razem z:</span>
        {dane.polaczone.length ? dane.polaczone.map((x) => (
          <span key={x.id} style={{ ...tag, fontSize: 11, padding: "3px 8px", background: "var(--info-soft)", color: "var(--info)", display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span className="mono">{x.etykieta}</span>
            {edycja && <button onClick={() => { void zapisz(ids.filter((i) => i !== x.id)); }} disabled={busy}
              title="Odłącz — ten kontener wróci do liczenia sam" style={{ ...btnLink, padding: 0, fontSize: 12 }}>×</button>}
          </span>
        )) : <span style={{ fontSize: 12.5, color: "var(--text-lo)" }}>— sam (płatności tylko z tej karty)</span>}
        {edycja && (
          <>
            <select value={wybor} onChange={(e) => setWybor(e.target.value)} disabled={busy} aria-label="Dodaj kontener do wspólnej faktury"
              style={{ ...input, textAlign: "left", fontFamily: "inherit", padding: "5px 8px", minWidth: 220 }}>
              <option value="">dodaj kontener…</option>
              {dane.kandydaci.map((x) => (
                <option key={x.id} value={x.id}>{x.etykieta}{x.dostawca ? ` · ${x.dostawca}` : ""}{x.eta ? ` · ETA ${data(x.eta)}` : ""}</option>
              ))}
            </select>
            <button onClick={() => { if (wybor) void zapisz([...ids, Number(wybor)]); }} disabled={busy || !wybor}
              style={{ ...btnSec, opacity: busy || !wybor ? 0.5 : 1 }}>Połącz</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── drobne klocki (styl jak zakładka SAD) ───────────────────
function Naglowek({ tytul, hint }: { tytul: string; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "11px 16px", borderBottom: "1px solid var(--border-soft)" }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>{tytul}</span>
      {hint ? <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{hint}</span> : null}
    </div>
  );
}

function Kafel({ l, v, n, akcent, tag: t, pop }: { l: string; v: string; n: string; akcent?: boolean; tag?: React.ReactNode; pop?: React.ReactNode }) {
  return (
    <div className={pop ? "kj-kafel kj-kafel-pop" : "kj-kafel"} tabIndex={pop ? 0 : undefined}
      style={{ ...karta, overflow: "visible", position: "relative", padding: "12px 14px",
        background: akcent ? "color-mix(in oklch, var(--accent) 8%, var(--surface-1))" : "var(--surface-1)", cursor: pop ? "help" : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{l}{t}</div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 4, color: akcent ? "var(--accent)" : undefined }}>{v}</div>
      <div style={{ fontSize: 10.5, color: "var(--text-lo)", marginTop: 2 }}>{n}</div>
      {pop}
    </div>
  );
}

function Tag({ t, tekst: napis }: { t: "szac" | "rec" | "brak"; tekst?: string }) {
  const s = t === "szac" ? { background: "var(--warning-soft)", color: "var(--warning)" }
    : t === "rec" ? { background: "var(--info-soft)", color: "var(--info)" }
      : { background: "var(--critical-soft)", color: "var(--critical)" };
  const domyslny = t === "szac" ? "SZACUNEK" : t === "rec" ? "RĘCZNA" : "BRAK STAWKI";
  return <span style={{ ...tag, ...s }}>{(napis ?? domyslny).toUpperCase()}</span>;
}

function Komunikat({ poziom, tresc }: { poziom: string; tresc: string }) {
  const kolor = poziom === "blad" ? "var(--critical)" : poziom === "ostrzezenie" ? "var(--warning)" : "var(--info)";
  const tlo = poziom === "blad" ? "var(--critical-soft)" : poziom === "ostrzezenie" ? "var(--warning-soft)" : "var(--info-soft)";
  const znak = poziom === "blad" ? "✕" : poziom === "ostrzezenie" ? "!" : "i";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--r-md)",
      background: tlo, border: `1px solid color-mix(in oklch, ${kolor} 30%, transparent)` }}>
      <span style={{ color: kolor, fontWeight: 700, lineHeight: 1.3 }}>{znak}</span>
      <div style={{ fontSize: 12.5, color: "var(--text-hi)", minWidth: 0 }}>{tresc}</div>
    </div>
  );
}

const Th = ({ children, l }: { children: React.ReactNode; l?: boolean }) => (
  <th style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-lo)",
    textAlign: l ? "left" : "right", padding: "8px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{children}</th>
);

const css = `
.kj-kafle { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.kj-pop { display: none; position: absolute; z-index: 20; top: calc(100% + 6px); right: 0; width: min(360px, 86vw);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-md); padding: 10px 12px;
  box-shadow: 0 10px 30px oklch(0 0 0 / .45); text-transform: none; letter-spacing: 0; font-weight: 400; }
.kj-kafel-pop:hover .kj-pop, .kj-kafel-pop:focus .kj-pop, .kj-kafel-pop:focus-within .kj-pop { display: block; }
.kj-zal { display: grid; grid-template-columns: minmax(150px, 1.2fr) minmax(170px, 1.6fr) 130px minmax(110px, 1fr) auto;
  gap: 10px 14px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border-soft); }
.kj-zal:last-child { border-bottom: 0; }
@media (max-width: 760px) { .kj-zal { grid-template-columns: 1fr 1fr; } .kj-zal > :first-child { grid-column: 1 / -1; } }
`;

const karta: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" };
const tabela: React.CSSProperties = { width: "100%", borderCollapse: "collapse" };
const td: React.CSSProperties = { padding: "7px 10px", fontSize: 12.5, textAlign: "right", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap" };
const tdM: React.CSSProperties = { ...td, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };
const tdSum: React.CSSProperties = { ...tdM, fontWeight: 700, color: "var(--text-mid)", borderBottom: 0 };
const input: React.CSSProperties = { padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-hi)", outline: "none", textAlign: "right", fontFamily: "var(--font-mono)" };
const reczneStyl: React.CSSProperties = { borderColor: "color-mix(in oklch, var(--info) 60%, var(--border))", background: "color-mix(in oklch, var(--info) 7%, var(--bg))" };
const btnPri: React.CSSProperties = { background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--accent-ink, #201400)", font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "8px 16px", borderRadius: "var(--r-sm)", cursor: "pointer" };
const btnSec: React.CSSProperties = { background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-mid)", font: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 12px", borderRadius: "var(--r-sm)", cursor: "pointer" };
const btnLink: React.CSSProperties = { background: "none", border: 0, padding: "2px 0", color: "var(--info)", font: "inherit", fontSize: 11.5, fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer", whiteSpace: "nowrap" };
const tag: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap" };
const popTh: React.CSSProperties = { textAlign: "left", fontSize: 9.5, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em", padding: "3px 4px", fontWeight: 700 };
const popTd: React.CSSProperties = { padding: "3px 4px", borderTop: "1px solid var(--border-soft)", color: "var(--text-hi)" };
