"use client";
// ============================================================
// MAGAZYN — Zakładka „Cena" na pełnej karcie produktu.
//
//   • kafle kosztu: FIFO, średnia ważona ze stanu, koszt z ERP (Subiekt / Fakturownia),
//     ostatnia dostawa, najniższa i najwyższa z rozliczonych
//   • ostrzeżenia: kontener z odstającym narzutem, stan spoza kontenerów
//   • tabela dostaw tego SKU (od najnowszej) z linkiem na kartę kontenera
//   • kalkulator ceny sprzedaży: Sklepy | Dropy, zapis na sztywno na tej karcie
//
// Dane: GET /products/{sku}/cena (routers/cena.py). Formuła kalkulatora jest LUSTREM
// services/cena.py → wylicz_cene; serwer przy zapisie liczy cenę jeszcze raz sam.
// Zapisana cena żyje tylko tutaj — nie trafia do nagłówka karty, list ani Dropów.
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { MetricBox, Section, fmtDay } from "./product-modal";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { containerSlug } from "@/lib/routes";
import { nrLubFv } from "./ui";

type Baza = "fifo" | "srednia" | "ostatnia" | "reczna";
type Tryb = "marza" | "narzut";
type Kanal = "sklepy" | "dropy";

type Dostawa = {
  item_id: number; container_id: number; container_number: string;
  order_number: string | null; lot_order_number: string | null; manufacturer_name: string | null;
  data: string | null; data_zrodlo: string; status: "u_nas" | "w_drodze";
  szt: number; na_stanie: number;
  cena_fv_pln: number | null; cena_fv_waluta: number | null; waluta: string | null;
  koszt: number | null; szacunek: boolean; narzut_proc: number | null;
  rozliczenie: "odprawa" | "brak"; odstaje: boolean; fifo: boolean;
};

// Kontener bez numeru (roboczy „Draft-…") pokazujemy jako „FV: <nr faktury>".
const nrDostawy = (d: Dostawa) => nrLubFv(d.container_number, d.lot_order_number || d.order_number);

type Zapisana = {
  kanal: Kanal; baza: Baza; koszt_bazy: number; tryb: Tryb; procent: number;
  wysylka: number; prowizja: number; vat: number; cena_netto: number; cena_brutto: number;
  shop: string | null; zapisal: string | null; zapisano: string | null;
};

type CenaData = {
  sku: string; shop: string; stan: number; poza_dostawami: number;
  erp_zrodlo: "subiekt" | "fakturownia" | null; erp_cena: number | null;
  fifo: number | null; fifo_item_id: number | null;
  srednia: number | null; srednia_szt: number; srednia_pominieto_szt: number;
  ostatnia: number | null; ostatnia_item_id: number | null;
  min: number | null; min_item_id: number | null; max: number | null; max_item_id: number | null;
  sredni_narzut_proc: number | null; narzut_zrodlo: "sku" | "wszystkie" | null;
  dostawy: Dostawa[]; zapisane: Zapisana[]; uwagi: string[]; moze_zapisac: boolean;
  vat: number; vat_zrodlo: "reczna" | "sprzedaz" | "domyslna";
};

const zl2 = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number, d = 1) => (n > 0 ? "+" : "") + n.toLocaleString("pl-PL", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";

const BAZA_LABEL: Record<Baza, string> = { fifo: "FIFO", srednia: "Średnia", ostatnia: "Ostatnia", reczna: "Ręcznie" };
const KANAL_LABEL: Record<Kanal, string> = { sklepy: "Sklepy", dropy: "Dropy" };
const VAT_OPIS: Record<string, string> = { reczna: "ustawiona ręcznie", sprzedaz: "z ostatniej sprzedaży", domyslna: "domyślna" };

// ── Formuła (lustro services/cena.py → wylicz_cene) ──────────
type Wynik = { koszt: number; netto: number; brutto: number; prowizja: number; zysk: number; marza: number; narzut: number } | null;
function wylicz(kosztBazy: number, tryb: Tryb, proc: number, wysylka: number, prowizja: number, vat: number): Wynik {
  if (!(kosztBazy > 0) || proc < 0 || wysylka < 0 || prowizja < 0) return null;
  const p = proc / 100, c = prowizja / 100;
  const koszt = kosztBazy + wysylka;
  let netto: number;
  if (tryb === "marza") {
    if (1 - p - c <= 0) return null;
    netto = koszt / (1 - p - c);
  } else {
    if (1 - c <= 0) return null;
    netto = koszt * (1 + p) / (1 - c);
  }
  netto = Math.round(netto * 100) / 100;
  const prow = Math.round(netto * c * 100) / 100;
  const zysk = Math.round((netto - koszt - prow) * 100) / 100;
  return {
    koszt, netto, brutto: Math.round(netto * (1 + vat / 100) * 100) / 100, prowizja: prow, zysk,
    marza: netto ? (zysk / netto) * 100 : 0, narzut: koszt ? (zysk / koszt) * 100 : 0,
  };
}

export default function ProductPriceTab({ sku, shop, onOpenContainer }: {
  sku: string;
  shop: string;
  /** Klik w kontener → pełna karta kontenera (klucz z containerSlug). */
  onOpenContainer?: (key: string) => void;
}) {
  // Wynik trzymamy razem z kluczem zapytania: po zmianie SKU albo firmy stary wynik
  // po prostu przestaje pasować (szkielet), bez czyszczenia stanu w efekcie.
  const klucz = `${sku}|${shop}`;
  const [wynik, setWynik] = useState<{ klucz: string; data?: CenaData; blad?: string } | null>(null);
  const data = wynik?.klucz === klucz ? wynik.data ?? null : null;
  const blad = wynik?.klucz === klucz ? wynik.blad ?? null : null;
  const setData = (f: (prev: CenaData | null) => CenaData | null) =>
    setWynik((w) => (w && w.klucz === klucz ? { ...w, data: f(w.data ?? null) ?? undefined } : w));

  useEffect(() => {
    let alive = true;
    api.get(`/products/${encodeURIComponent(sku)}/cena${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`)
      .then((d) => { if (alive) setWynik({ klucz: `${sku}|${shop}`, data: d as CenaData }); })
      .catch((e) => { if (alive) setWynik({ klucz: `${sku}|${shop}`, blad: e instanceof Error ? e.message : "nieznany błąd" }); });
    return () => { alive = false; };
  }, [sku, shop]);

  if (blad) {
    return <div style={pusty}>Nie udało się wczytać kosztów: {blad}</div>;
  }
  if (!data) {
    return (
      <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ height: 84, background: "var(--surface-1)", borderRadius: 10 }} />
        <div style={{ height: 180, background: "var(--surface-1)", borderRadius: 10 }} />
        <div style={{ height: 320, background: "var(--surface-1)", borderRadius: 10 }} />
      </div>
    );
  }

  const bazy: Record<Exclude<Baza, "reczna">, number | null> = { fifo: data.fifo, srednia: data.srednia, ostatnia: data.ostatnia };
  const poId = new Map(data.dostawy.map((d) => [d.item_id, d]));

  const otworz = (d: Dostawa) => onOpenContainer?.(containerSlug({
    id: d.container_id, container_number: d.container_number,
    order_number: d.order_number, lot_order_numbers: [d.lot_order_number],
  }));

  const zapisano = (z: Zapisana) => setData((prev) => prev && {
    ...prev, zapisane: [...prev.zapisane.filter((x) => x.kanal !== z.kanal), z],
  });

  return (
    <>
      <Kafle data={data} poId={poId} />
      <Ostrzezenia data={data} onOpen={otworz} />
      <Dostawy data={data} onOpen={onOpenContainer ? otworz : undefined} />
      <Section title="Sugerowana cena sprzedaży" hint="kalkulator liczy na żywo · „Zapisz cenę” zostawia ją na tej karcie">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 430px), 1fr))", gap: 12 }}>
          {(["sklepy", "dropy"] as Kanal[]).map((k) => (
            <Kalkulator key={`${data.sku}-${k}`} sku={data.sku} shop={shop} kanal={k} bazy={bazy}
              zapisana={data.zapisane.find((z) => z.kanal === k) || null}
              mozeZapisac={data.moze_zapisac} onSaved={zapisano}
              vat={data.vat} vatZrodlo={data.vat_zrodlo} />
          ))}
        </div>
      </Section>
    </>
  );
}

// ── Kafle ────────────────────────────────────────────────────
function Kafle({ data, poId }: { data: CenaData; poId: Map<number, Dostawa> }) {
  const nr = (id: number | null) => (id != null ? poId.get(id) : undefined);
  const fifoD = nr(data.fifo_item_id);
  const ostD = nr(data.ostatnia_item_id);
  const minD = nr(data.min_item_id);
  const maxD = nr(data.max_item_id);
  const erpNazwa = data.erp_zrodlo === "subiekt" ? "Subiekt" : "Fakturownia";
  const erpOpis = data.erp_zrodlo === "subiekt"
    ? <>FV + Lenmar, <span style={{ color: "var(--warning)" }}>bez SAD (cła)</span></>
    : "cena z FV, bez kosztów importu";
  const roz = data.fifo != null && data.erp_cena ? (data.fifo / data.erp_cena - 1) * 100 : null;
  const v = (n: number | null) => (n != null ? <>{zl2(n)}<small style={small}> zł</small></> : "—");

  return (
    <Section title="Koszt zakupu / szt"
      hint={`landed cost z kontenerów · stan ${data.stan} szt${data.shop ? ` · firma ${data.shop.toUpperCase()}` : ""}`}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <div style={{ borderRadius: 10, boxShadow: "0 0 0 1px color-mix(in oklch, var(--accent) 40%, transparent)" }}>
          <MetricBox label="Koszt FIFO" dot="var(--accent)" value={<span style={{ color: "var(--accent)" }}>{v(data.fifo)}</span>}
            sub={fifoD ? <>partia <span className="mono">{nrDostawy(fifoD)}</span> · zostało {fifoD.na_stanie} szt</> : "brak towaru na stanie"} />
        </div>
        <MetricBox label="Średnia ważona" value={v(data.srednia)}
          sub={data.srednia != null
            ? `${data.srednia_szt} szt rozliczonych${data.srednia_pominieto_szt ? ` · pominięto ${data.srednia_pominieto_szt} szt bez SAD` : ""}`
            : data.srednia_pominieto_szt ? "na stanie tylko partie bez SAD" : "brak towaru na stanie"} />
        <MetricBox label={erpNazwa} value={v(data.erp_cena)}
          sub={<>{roz != null && <span style={pillMute}>FIFO {pct(roz)}</span>} {erpOpis}</>} />
        <MetricBox label="Ostatnia dostawa" tone={ostD?.szacunek ? "info" : "neutral"} value={v(data.ostatnia)}
          sub={ostD ? <>{ostD.szacunek && <span style={{ ...tag, ...infoStyl }}>SZAC.</span>} {ostD.data ? fmtDay(ostD.data) : ""}{ostD.szacunek ? " · czeka na SAD" : ""}</> : "—"} />
        <MetricBox label="Najniższa" tone="ok" value={v(data.min)}
          sub={minD ? <><span className="mono">{nrDostawy(minD)}</span>{minD.data ? ` · ${fmtDay(minD.data)}` : ""}</> : "brak rozliczonych"} />
        <MetricBox label="Najwyższa" tone={maxD?.odstaje ? "critical" : "neutral"} value={v(data.max)}
          sub={maxD ? <><span className="mono">{nrDostawy(maxD)}</span>{maxD.data ? ` · ${fmtDay(maxD.data)}` : ""}</> : "brak rozliczonych"} />
      </div>
    </Section>
  );
}

// ── Ostrzeżenia ──────────────────────────────────────────────
function Ostrzezenia({ data, onOpen }: { data: CenaData; onOpen: (d: Dostawa) => void }) {
  const odst = data.dostawy.filter((d) => d.odstaje);
  const inne = data.dostawy.filter((d) => d.rozliczenie === "odprawa" && !d.odstaje && d.narzut_proc != null)
    .map((d) => d.narzut_proc as number);
  const zakres = inne.length ? `${Math.round(Math.min(...inne))}–${Math.round(Math.max(...inne))}%` : null;
  if (!odst.length && !data.uwagi.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: -8 }}>
      {odst.map((d) => (
        <div key={d.item_id} style={{ ...note, ...noteWarn }}>
          <span style={{ color: "var(--warning)", fontWeight: 700 }}>!</span>
          <div>
            <span style={{ color: "var(--text-hi)" }}>Kontener <span className="mono">{nrDostawy(d)}</span> ma narzut importu {pct(d.narzut_proc ?? 0, 0)}</span>
            {zakres && <>, a pozostałe dostawy {zakres}</>}. Sprawdź rozliczenie tego kontenera.{" "}
            <button onClick={() => onOpen(d)} style={linkBtn}>Otwórz kartę kontenera</button>
          </div>
        </div>
      ))}
      {data.uwagi.map((u, i) => (
        <div key={i} style={{ ...note, ...noteInfo }}>
          <span style={{ color: "var(--info)", fontWeight: 700 }}>i</span><div>{u}</div>
        </div>
      ))}
    </div>
  );
}

// ── Tabela dostaw ────────────────────────────────────────────
function Dostawy({ data, onOpen }: { data: CenaData; onOpen?: (d: Dostawa) => void }) {
  if (!data.dostawy.length) {
    return (
      <Section title="Dostawy tego SKU">
        <div style={pusty}>Ten produkt nie przyszedł jeszcze w żadnym kontenerze w aplikacji.</div>
      </Section>
    );
  }
  const maxK = Math.max(...data.dostawy.map((d) => d.koszt || 0), 1);
  const sumaSzt = data.dostawy.reduce((s, d) => s + d.szt, 0);
  const szacZ = data.narzut_zrodlo === "wszystkie" ? "średni narzut wszystkich rozliczonych kontenerów" : "średni narzut rozliczonych dostaw";

  return (
    <Section title="Dostawy tego SKU" hint={`od najnowszej · ${data.dostawy.length} ${data.dostawy.length === 1 ? "dostawa" : data.dostawy.length < 5 ? "dostawy" : "dostaw"} · ${sumaSzt} szt`}>
      <div style={karta}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <Th l>Kontener</Th><Th l>Na magazyn</Th><Th>Szt.</Th><Th>Na stanie</Th>
              <Th>Cena FV</Th><Th>Cena FV PLN</Th><Th>Koszt jedn.</Th><Th>Narzut importu</Th><Th l>Rozliczenie</Th>
            </tr></thead>
            <tbody>
              {data.dostawy.map((d) => {
                const wDrodze = d.status === "w_drodze";
                const barKolor = d.odstaje ? "var(--critical)" : d.szacunek ? "var(--info)" : "var(--accent)";
                const status = wDrodze ? <span style={{ ...pill, ...infoStyl }}>W drodze</span>
                  : d.rozliczenie === "brak" ? <span style={{ ...pill, ...warnStyl }}>Bez SAD</span>
                  : d.odstaje ? <span style={{ ...pill, ...critStyl }}>Do sprawdzenia</span>
                  : <span style={{ ...pill, ...okStyl }}>Policzony</span>;
                return (
                  <tr key={d.item_id} style={{ background: d.fifo ? "color-mix(in oklch, var(--accent) 6%, transparent)" : undefined, color: wDrodze ? "var(--text-lo)" : undefined }}>
                    <td style={{ ...td, textAlign: "left" }}>
                      {onOpen
                        ? <button onClick={() => onOpen(d)} className="mono" style={cnrBtn} title="Otwórz kartę kontenera">{nrDostawy(d)} ›</button>
                        : <span className="mono" style={{ fontWeight: 600 }}>{nrDostawy(d)}</span>}
                      {d.fifo && <> <span style={{ ...tag, background: "var(--accent-soft)", color: "var(--accent)" }}>FIFO</span></>}
                      {d.manufacturer_name && <div style={sub}>{d.manufacturer_name}{d.lot_order_number ? ` · ${d.lot_order_number}` : ""}</div>}
                    </td>
                    <td style={{ ...td, textAlign: "left", fontFamily: "var(--font-mono)" }}>
                      {d.data ? fmtDay(d.data) : "—"}
                      {d.data_zrodlo === "estimate" && <span style={sub}> szac.</span>}
                    </td>
                    <td style={tdM}>{d.szt}</td>
                    <td style={{ ...tdM, color: d.na_stanie ? "var(--text-hi)" : "var(--text-disabled)" }}>{d.na_stanie || "—"}</td>
                    <td style={tdM}>{d.cena_fv_waluta != null ? `${zl2(d.cena_fv_waluta)} ${d.waluta === "USD" ? "$" : d.waluta || ""}` : "—"}</td>
                    <td style={tdM}>{d.cena_fv_pln != null ? zl2(d.cena_fv_pln) : "—"}</td>
                    <td style={{ ...tdM, fontWeight: 600, color: d.szacunek ? "var(--info)" : "var(--text-hi)" }}>
                      {d.koszt != null ? <>
                        <span style={{ display: "inline-block", height: 6, borderRadius: 3, marginRight: 6, verticalAlign: "middle", width: Math.round((d.koszt / maxK) * 44), background: barKolor }} />
                        {zl2(d.koszt)}{d.szacunek && <> <span style={{ ...tag, ...infoStyl }}>SZAC.</span></>}
                      </> : "—"}
                    </td>
                    <td style={{ ...tdM, color: d.odstaje ? "var(--critical)" : d.szacunek ? "var(--text-lo)" : "var(--text-mid)" }}>
                      {d.narzut_proc != null ? pct(d.narzut_proc) : "—"}
                    </td>
                    <td style={{ ...td, textAlign: "left" }}>{status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "9px 12px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-elevated)", fontSize: 10.5, color: "var(--text-lo)" }}>
          <span><span style={{ ...tag, background: "var(--accent-soft)", color: "var(--accent)" }}>FIFO</span> z tej partii schodzi teraz towar</span>
          <span><b style={{ color: "var(--text-mid)", fontWeight: 600 }}>Na stanie</b> przypisane wstecz od najnowszej dostawy (brak powiązania PZ ↔ kontener)</span>
          <span><span style={{ ...tag, ...infoStyl }}>SZAC.</span> kontener bez SAD: cena FV × {szacZ}{data.sredni_narzut_proc != null ? ` (${pct(data.sredni_narzut_proc)})` : ""}</span>
        </div>
      </div>
    </Section>
  );
}

// ── Kalkulator ───────────────────────────────────────────────
const DOMYSLNE: Record<Kanal, { baza: Baza; tryb: Tryb; proc: string }> = {
  sklepy: { baza: "fifo", tryb: "marza", proc: "35" },
  dropy: { baza: "srednia", tryb: "narzut", proc: "20" },
};

function Kalkulator({ sku, shop, kanal, bazy, zapisana, mozeZapisac, onSaved, vat, vatZrodlo }: {
  sku: string; shop: string; kanal: Kanal;
  bazy: Record<Exclude<Baza, "reczna">, number | null>;
  zapisana: Zapisana | null; mozeZapisac: boolean;
  onSaved: (z: Zapisana) => void;
  vat: number; vatZrodlo: string;
}) {
  const startowe = () => {
    if (zapisana) {
      return {
        baza: zapisana.baza, tryb: zapisana.tryb, proc: String(zapisana.procent),
        wys: String(zapisana.wysylka), prow: String(zapisana.prowizja),
        reczna: String(zapisana.baza === "reczna" ? zapisana.koszt_bazy : bazy.fifo ?? ""),
      };
    }
    const d = DOMYSLNE[kanal];
    const baza: Baza = bazy[d.baza as Exclude<Baza, "reczna">] != null ? d.baza : (bazy.fifo != null ? "fifo" : "reczna");
    return { baza, tryb: d.tryb, proc: d.proc, wys: "0", prow: "0", reczna: String(bazy.fifo ?? "") };
  };
  const [s, setS] = useState(startowe);
  const [busy, setBusy] = useState(false);
  const num = (v: string) => Number(String(v).replace(",", ".")) || 0;

  const kosztBazy = s.baza === "reczna" ? num(s.reczna) : (bazy[s.baza] ?? 0);
  const w = useMemo(() => wylicz(kosztBazy, s.tryb, num(s.proc), num(s.wys), num(s.prow), vat),
    [kosztBazy, s.tryb, s.proc, s.wys, s.prow, vat]);

  const zapisz = async () => {
    if (!w || busy) return;
    setBusy(true);
    try {
      const z = (await api.put(`/products/${encodeURIComponent(sku)}/cena`, {
        kanal, baza: s.baza, koszt_bazy: Math.round(kosztBazy * 100) / 100, tryb: s.tryb,
        procent: num(s.proc), wysylka: num(s.wys), prowizja: num(s.prow), vat, shop,
      })) as Zapisana;
      onSaved(z);
      toast(`Zapisano cenę dla ${KANAL_LABEL[kanal].toLowerCase()}: ${zl2(z.cena_brutto)} zł brutto`, "ok");
    } catch (e) {
      toast(`Nie udało się zapisać ceny: ${e instanceof Error ? e.message : "błąd"}`, "warning");
    } finally {
      setBusy(false);
    }
  };

  const id = (f: string) => `cena-${kanal}-${f}`;

  return (
    <div style={{ ...karta, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elevated)" }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{KANAL_LABEL[kanal]}</span>
        {zapisana ? <span style={{ ...pill, ...okStyl }}>zapisana</span> : <span style={{ ...pill, background: "var(--surface-2)", color: "var(--text-mid)" }}>brak zapisu</span>}
      </div>

      <ZapisanaBox kanal={kanal} z={zapisana} bazy={bazy} vat={vat} />

      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <Wiersz label="Baza kosztu">
          <div>
            <div role="group" aria-label="Baza kosztu" style={seg}>
              {(Object.keys(BAZA_LABEL) as Baza[]).map((b) => {
                const brak = b !== "reczna" && bazy[b] == null;
                return (
                  <button key={b} disabled={brak} onClick={() => setS({ ...s, baza: b })}
                    style={{ ...segBtn, ...(s.baza === b ? segOn : {}), opacity: brak ? 0.4 : 1, cursor: brak ? "default" : "pointer" }}>
                    {BAZA_LABEL[b]}
                  </button>
                );
              })}
            </div>
            {s.baza === "reczna" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <Pole id={id("reczna")} value={s.reczna} onChange={(v) => setS({ ...s, reczna: v })} unit="zł" />
                <span style={hint}>koszt / szt netto</span>
              </div>
            ) : (
              <div className="mono" style={{ fontSize: 11.5, color: "var(--text-mid)", marginTop: 5 }}>{zl2(bazy[s.baza] ?? 0)} zł</div>
            )}
          </div>
        </Wiersz>
        <Wiersz label={s.tryb === "marza" ? "Marża" : "Narzut"} htmlFor={id("proc")}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pole id={id("proc")} value={s.proc} onChange={(v) => setS({ ...s, proc: v })} unit="%" />
            <div role="group" aria-label="Sposób liczenia" style={seg}>
              <button onClick={() => setS({ ...s, tryb: "marza" })} style={{ ...segBtn, ...(s.tryb === "marza" ? segOn : {}) }}>od ceny (marża)</button>
              <button onClick={() => setS({ ...s, tryb: "narzut" })} style={{ ...segBtn, ...(s.tryb === "narzut" ? segOn : {}) }}>od kosztu (narzut)</button>
            </div>
          </div>
        </Wiersz>
        <Wiersz label="Wysyłka PL" htmlFor={id("wys")}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pole id={id("wys")} value={s.wys} onChange={(v) => setS({ ...s, wys: v })} unit="zł" />
            <span style={hint}>{kanal === "dropy" ? "0, gdy dropshipper płaci za kuriera" : "netto, doliczana do kosztu"}</span>
          </div>
        </Wiersz>
        <Wiersz label="Prowizja kanału" htmlFor={id("prow")}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pole id={id("prow")} value={s.prow} onChange={(v) => setS({ ...s, prow: v })} unit="%" />
            <span style={hint}>opcjonalnie, np. Allegro</span>
          </div>
        </Wiersz>
      </div>

      <div style={{ margin: "0 16px", borderTop: "1px dashed var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <Linia l="Koszt bazowy" v={`${zl2(kosztBazy)} zł`} />
        <Linia l="+ wysyłka" v={`${zl2(num(s.wys))} zł`} />
        {w && w.prowizja > 0 && <Linia l="+ prowizja kanału" v={`${zl2(w.prowizja)} zł`} />}
        <Linia l="Zysk na sztuce" v={w ? `${zl2(w.zysk)} zł` : "—"} kolor="var(--ok)" />
        <Linia l="Marża / narzut" v={w ? `${w.marza.toFixed(1).replace(".", ",")}% / ${w.narzut.toFixed(1).replace(".", ",")}%` : "—"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, margin: "12px 16px 0" }}>
        <MetricBox label="Sugerowana netto" value={w ? <>{zl2(w.netto)}<small style={small}> zł</small></> : "—"} sub="bez VAT" />
        <MetricBox label="Sugerowana brutto" value={w ? <span style={{ color: "var(--accent)" }}>{zl2(w.brutto)}<small style={small}> zł</small></span> : "—"} sub={`z VAT ${vat}% · ${VAT_OPIS[vatZrodlo] || ""}`} />
      </div>
      {!w && <div style={{ ...hint, margin: "8px 16px 0", color: "var(--warning)" }}>Sprawdź parametry: koszt musi być większy od zera, a marża z prowizją mniejsza niż 100%.</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 16px 16px", marginTop: "auto", flexWrap: "wrap" }}>
        {zapisana && <button onClick={() => setS(startowe())} style={btnSec}>Wczytaj zapisane</button>}
        {mozeZapisac && <button onClick={zapisz} disabled={!w || busy} style={{ ...btnPri, opacity: !w || busy ? 0.5 : 1 }}>{busy ? "Zapisuję…" : "Zapisz cenę"}</button>}
      </div>
    </div>
  );
}

function ZapisanaBox({ kanal, z, bazy, vat }: { kanal: Kanal; z: Zapisana | null; bazy: Record<Exclude<Baza, "reczna">, number | null>; vat: number }) {
  if (!z) {
    return (
      <div style={{ margin: "14px 16px 0", padding: "12px 14px", border: "1px dashed var(--border-soft)", borderRadius: 10, textAlign: "center", fontSize: 12, color: "var(--text-lo)" }}>
        Jeszcze nie zapisano ceny dla {KANAL_LABEL[kanal].toLowerCase()}. Ustaw parametry i kliknij „Zapisz cenę”.
      </div>
    );
  }
  const teraz = z.baza === "reczna" ? null : bazy[z.baza];
  const dryf = teraz != null && z.koszt_bazy ? (teraz / z.koszt_bazy - 1) * 100 : null;
  return (
    <div style={{ margin: "14px 16px 0", padding: "12px 14px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border-soft)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>
        <span>Zapisana cena</span>
        <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>{z.zapisano ? fmtDay(z.zapisano) : ""}{z.zapisal ? ` · ${z.zapisal}` : ""}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, marginTop: 4 }}>
        <div className="num" style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{zl2(z.cena_brutto)}<small style={small}> zł brutto</small></div>
        <div className="num" style={{ fontSize: 12, color: "var(--text-mid)" }}>{zl2(z.cena_netto)} zł netto</div>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 4 }}>
        {BAZA_LABEL[z.baza]} {zl2(z.koszt_bazy)} zł · {z.tryb === "marza" ? "marża" : "narzut"} {z.procent}% · wysyłka {zl2(z.wysylka)} zł{z.prowizja ? ` · prowizja ${z.prowizja}%` : ""} · VAT {z.vat}%
      </div>
      {z.vat !== vat && (
        <div style={{ marginTop: 8, fontSize: 11.5, padding: "6px 9px", borderRadius: 6, ...warnStyl }}>
          Cena zapisana z VAT {z.vat}%, a produkt ma teraz {vat}%. Przelicz i zapisz ponownie.
        </div>
      )}
      {dryf != null && Math.abs(dryf) >= 0.05 && (
        <div style={{ marginTop: 8, fontSize: 11.5, padding: "6px 9px", borderRadius: 6, ...(Math.abs(dryf) >= 3 ? warnStyl : { background: "var(--surface-2)", color: "var(--text-mid)" }) }}>
          Koszt bazowy ({BAZA_LABEL[z.baza]}) zmienił się o <b className="mono">{pct(dryf)}</b> od zapisu: {zl2(z.koszt_bazy)} → {zl2(teraz as number)} zł. Warto przeliczyć.
        </div>
      )}
    </div>
  );
}

// ── Drobne klocki ────────────────────────────────────────────
function Wiersz({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="cena-row" style={{ display: "grid", gridTemplateColumns: "120px 1fr", alignItems: "start", gap: 10 }}>
      <style>{`@media (max-width: 640px) { .cena-row { grid-template-columns: 1fr !important; gap: 6px !important; } }`}</style>
      <label htmlFor={htmlFor} style={{ fontSize: 12, color: "var(--text-lo)", paddingTop: 7 }}>{label}</label>
      {children}
    </div>
  );
}

function Pole({ id, value, onChange, unit }: { id: string; value: string; onChange: (v: string) => void; unit: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6 }}>
      <input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: 86, padding: "6px 8px", fontSize: 13, background: "transparent", border: 0, color: "var(--text-hi)", outline: "none", textAlign: "right", fontFamily: "var(--font-mono)" }} />
      <span style={{ padding: "0 9px 0 2px", fontSize: 12, color: "var(--text-lo)" }}>{unit}</span>
    </span>
  );
}

function Linia({ l, v, kolor }: { l: string; v: string; kolor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, color: "var(--text-mid)" }}>
      <span>{l}</span><span className="num" style={{ color: kolor || "var(--text-hi)" }}>{v}</span>
    </div>
  );
}

const Th = ({ children, l }: { children: React.ReactNode; l?: boolean }) => (
  <th style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-lo)",
    textAlign: l ? "left" : "right", padding: "8px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{children}</th>
);

const karta: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" };
const td: React.CSSProperties = { padding: "8px 10px", fontSize: 12.5, textAlign: "right", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const tdM: React.CSSProperties = { ...td, fontFamily: "var(--font-mono)" };
const sub: React.CSSProperties = { fontSize: 10.5, color: "var(--text-lo)", fontFamily: "var(--font-sans)", fontWeight: 400 };
const small: React.CSSProperties = { fontSize: 12, color: "var(--text-lo)", fontWeight: 500 };
const hint: React.CSSProperties = { fontSize: 11, color: "var(--text-lo)" };
const tag: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", padding: "2px 6px", borderRadius: 4 };
const pill: React.CSSProperties = { display: "inline-flex", alignItems: "center", padding: "2px 7px", fontSize: 10, fontWeight: 600, letterSpacing: "0.02em", borderRadius: 999, whiteSpace: "nowrap", textTransform: "uppercase" };
const pillMute: React.CSSProperties = { ...pill, textTransform: "none", background: "var(--surface-2)", color: "var(--text-mid)" };
const okStyl = { background: "var(--ok-soft)", color: "var(--ok)" };
const warnStyl = { background: "var(--warning-soft)", color: "var(--warning)" };
const critStyl = { background: "var(--critical-soft)", color: "var(--critical)" };
const infoStyl = { background: "var(--info-soft)", color: "var(--info)" };
const note: React.CSSProperties = { display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--r-md)", fontSize: 12.5, color: "var(--text-mid)" };
const noteWarn: React.CSSProperties = { background: "var(--warning-soft)", border: "1px solid color-mix(in oklch, var(--warning) 30%, transparent)" };
const noteInfo: React.CSSProperties = { background: "var(--info-soft)", border: "1px solid color-mix(in oklch, var(--info) 30%, transparent)" };
const linkBtn: React.CSSProperties = { background: "none", border: 0, padding: 0, font: "inherit", color: "var(--info)", textDecoration: "underline", textUnderlineOffset: 3, cursor: "pointer" };
const cnrBtn: React.CSSProperties = { background: "none", border: 0, padding: 0, fontSize: 12.5, fontWeight: 600, color: "var(--text-hi)", cursor: "pointer" };
const seg: React.CSSProperties = { display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 3, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 999 };
const segBtn: React.CSSProperties = { border: 0, background: "transparent", color: "var(--text-lo)", font: "inherit", fontSize: 11.5, fontWeight: 600, padding: "4px 11px", borderRadius: 999, cursor: "pointer" };
const segOn: React.CSSProperties = { background: "var(--accent)", color: "var(--accent-ink)" };
const btnPri: React.CSSProperties = { background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--accent-ink)", font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "8px 16px", borderRadius: "var(--r-sm)", cursor: "pointer" };
const btnSec: React.CSSProperties = { background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-mid)", font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "8px 16px", borderRadius: "var(--r-sm)", cursor: "pointer" };
const pusty: React.CSSProperties = { padding: 32, textAlign: "center", background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)", color: "var(--text-lo)", fontSize: 13 };
