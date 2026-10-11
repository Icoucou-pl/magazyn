"use client";
// ============================================================
// MAGAZYN — zakładka „test-wycena” na pełnej karcie produktu.
//
//   • Zapisane ceny (minimalne i sugerowane: detal, dropy/hurt, allegro): aktualna + kto i kiedy
//     + historia; ostrzeżenie,
//     gdy koszt od ustawienia urósł albo spadł
//   • Kalkulator z szablonami: koszt bazowy (FIFO / średnia / własny), marża, koszty „+”
//     (zł albo % od netto / brutto, doliczane PO marży), „Zapisz jako …”
//   • Konkurencja: jeden wpis na sklep, nowa cena tego samego sklepu → stara do historii
//   • Pod spodem dotychczasowa zakładka „Cena” bez jej dwóch kalkulatorów (koszty, dostawy) —
//     kalkulatory „Nasze sklepy” i „Dropy/Hurt” zastąpił jeden kalkulator z listą wyboru
//
// Wersja testowa obok zakładki „Cena” — po akceptacji ją zastąpi.
// Dane: GET /api/wycena (routers/wycena.py). Formuła: lib/wycena.ts (lustro services/wycena.py).
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { fmtDay } from "./product-modal";
import ProductPriceTab from "./product-price-tab";
import { api } from "@/lib/api";
import { toast } from "./toast";
import {
  KONKURENCJA_STARA_DNI, dniTemu, num, proc1, wyliczWycene, zl2, type KosztPlus,
} from "@/lib/wycena";
import {
  Box, Kafel, KosztyEdytor, LegendaKolorow, SiatkaCen, TINT_RAMKA, TINT_TLO, type Tint, Linia, Pole, Wiersz, btnPri, btnSec, doEdycji, hint, inp, kartaStyl, linkBtn, linkOk,
  noteInfo, noteWarn, pill, pusty, rozpisStyl, seg, segBtn, segOn, small, td, th, warnStyl, zEdycji,
  type KosztEdycja,
} from "./wycena-ui";

// Ceny zapisywane z kalkulatora — lustro services/wycena.py → KANALY / KANAL_NAZWA.
type Kanal = "detal" | "hurt" | "sug_detal" | "sug_hurt" | "sug_allegro";
type Baza = "fifo" | "srednia" | "wlasna";
type CenaMin = {
  id: number; kanal: Kanal; cena_netto: number; cena_brutto: number; vat: number; baza: Baza;
  koszt_bazy: number; marza: number; koszty: KosztPlus[]; szablon: string | null;
  ustawil: string | null; ustawiono: string | null;
};
type Konkurent = {
  id: number; sklep: string; cena_brutto: number; link: string | null; dodal: string | null; dodano: string | null;
  historia: { cena_brutto: number; dodal: string | null; dodano: string | null }[];
};
type Szablon = { id: number; nazwa: string; cel: Kanal | null; marza: number; koszty: KosztPlus[]; zmienil: string | null; zmieniono: string | null };
type WycenaData = {
  sku: string; shop: string; vat: number; vat_zrodlo: string; fifo: number | null; srednia: number | null;
  ceny_min: CenaMin[]; konkurencja: Konkurent[]; szablony: Szablon[]; moze_zapisac: boolean;
};

// Kolejność kart jak w „test-cena”: detal, detal, hurt, hurt — a Allegro rząd niżej.
const KANALY: Kanal[] = ["detal", "sug_detal", "hurt", "sug_hurt", "sug_allegro"];
const KANAL_NAZWA: Record<Kanal, string> = {
  detal: "Cena minimalna detal",
  hurt: "Cena minimalna dropy/hurt",
  sug_detal: "Cena sugerowana detal",
  sug_hurt: "Cena sugerowana dropy/hurt",
  sug_allegro: "Cena sugerowana allegro",
};
// Detal pokazujemy brutto, dropy/hurt netto; tło kafla mówi, którego kanału dotyczy cena.
const BRUTTO: Record<Kanal, boolean> = { detal: true, sug_detal: true, sug_allegro: true, hurt: false, sug_hurt: false };
const tintKanalu = (k: Kanal): Tint => (k === "sug_allegro" ? "allegro" : BRUTTO[k] ? "detal" : "hurt");
const BAZA_NAZWA: Record<Baza, string> = { fifo: "FIFO", srednia: "średnia", wlasna: "własny koszt" };
const blad = (e: unknown) => (e instanceof Error ? e.message : "błąd");

export default function ProductTestWycena({ sku, shop, onOpenContainer }: {
  sku: string; shop: string; onOpenContainer?: (key: string) => void;
}) {
  const klucz = `${sku}|${shop}`;
  const [wynik, setWynik] = useState<{ klucz: string; data?: WycenaData; blad?: string } | null>(null);
  const data = wynik?.klucz === klucz ? wynik.data ?? null : null;
  const bladWczytania = wynik?.klucz === klucz ? wynik.blad ?? null : null;
  const popraw = (f: (d: WycenaData) => WycenaData) =>
    setWynik((w) => (w && w.klucz === klucz && w.data ? { ...w, data: f(w.data) } : w));

  useEffect(() => {
    let alive = true;
    api.get(`/wycena?sku=${encodeURIComponent(sku)}${shop ? `&shop=${encodeURIComponent(shop)}` : ""}`)
      .then((d) => { if (alive) setWynik({ klucz: `${sku}|${shop}`, data: d as WycenaData }); })
      .catch((e) => { if (alive) setWynik({ klucz: `${sku}|${shop}`, blad: blad(e) }); });
    return () => { alive = false; };
  }, [sku, shop]);

  if (bladWczytania) return <div style={pusty}>Nie udało się wczytać wyceny: {bladWczytania}</div>;
  if (!data) {
    return (
      <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ height: 120, background: "var(--surface-1)", borderRadius: 10 }} />
        <div style={{ height: 320, background: "var(--surface-1)", borderRadius: 10 }} />
      </div>
    );
  }

  return (
    <>
      <ZapisaneCeny data={data} />
      <Kalkulator key={data.sku} data={data} shop={shop}
        onCenaMin={(c) => popraw((d) => ({ ...d, ceny_min: [c, ...d.ceny_min] }))}
        onSzablony={(s) => popraw((d) => ({ ...d, szablony: s }))} />
      <KonkurencjaEdycja data={data} shop={shop} onZmiana={(k) => popraw((d) => ({ ...d, konkurencja: k }))} />
      <Box title="Koszt zakupu i dostawy" hint="to samo, co w zakładce „Cena” · kalkulatory cen są już w jednym, wyżej">
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <ProductPriceTab sku={sku} shop={shop} onOpenContainer={onOpenContainer} bezKalkulatora />
        </div>
      </Box>
    </>
  );
}

// ── Zapisane ceny (minimalne i sugerowane) ───────────────────
function ZapisaneCeny({ data }: { data: WycenaData }) {
  return (
    <Box title="Zapisane ceny" hint="zapisujesz z kalkulatora poniżej · zespół widzi je w zakładce „test-cena”">
      <SiatkaCen>
        {KANALY.map((k) => <KartaMin key={k} kanal={k} data={data} />)}
      </SiatkaCen>
      <LegendaKolorow />
    </Box>
  );
}

function KartaMin({ kanal, data }: { kanal: Kanal; data: WycenaData }) {
  const wszystkie = data.ceny_min.filter((c) => c.kanal === kanal);
  const c = wszystkie[0];
  const historia = wszystkie.slice(1);
  const tlo = { background: TINT_TLO[tintKanalu(kanal)], border: `1px solid ${TINT_RAMKA[tintKanalu(kanal)]}` };
  if (!c) {
    return (
      <div style={{ ...kartaStyl, ...tlo, alignItems: "center", justifyContent: "center", textAlign: "center", color: "var(--text-lo)", fontSize: 12.5 }}>
        <b style={{ color: "var(--text-mid)" }}>{KANAL_NAZWA[kanal]}</b>
        Jeszcze nie zapisana. Wybierz ją w kalkulatorze poniżej i kliknij „Zapisz cenę”.
      </div>
    );
  }
  // Koszt teraz w tej samej bazie, co przy ustawieniu (własny — porównujemy z FIFO).
  const teraz = c.baza === "srednia" ? data.srednia : data.fifo;
  const zmiana = teraz != null && c.koszt_bazy ? (teraz / c.koszt_bazy - 1) * 100 : null;
  const brutto = BRUTTO[kanal];
  return (
    <div style={{ ...kartaStyl, ...tlo }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>
        <span>{KANAL_NAZWA[kanal]}</span>
        <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>{c.ustawil || "—"} · {c.ustawiono ? fmtDay(c.ustawiono) : ""}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div className="num" style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
          {zl2(brutto ? c.cena_brutto : c.cena_netto)}<small style={small}> zł {brutto ? "brutto" : "netto"}</small>
        </div>
        <div className="num" style={{ fontSize: 12, color: "var(--text-mid)" }}>{zl2(brutto ? c.cena_netto : c.cena_brutto)} zł {brutto ? "netto" : "brutto"}</div>
      </div>
      <div style={hint}>
        {BAZA_NAZWA[c.baza]} {zl2(c.koszt_bazy)} zł · marża {proc1(c.marza)}
        {c.koszty.length ? ` · ${c.koszty.map((k) => `${k.nazwa || "koszt"} ${k.typ === "zl" ? `${zl2(k.wartosc)} zł` : `${proc1(k.wartosc)} od ${k.od}`}`).join(" · ")}` : ""}
        {` · VAT ${c.vat}%`}{c.szablon ? ` · szablon „${c.szablon}”` : ""}
      </div>
      {c.vat !== data.vat && (
        <div style={{ ...noteWarn, fontSize: 12 }}>Ustawiona przy VAT {c.vat}%, a produkt ma teraz {data.vat}%. Przelicz i ustaw ponownie.</div>
      )}
      {zmiana != null && Math.abs(zmiana) >= 2 ? (
        <div style={{ ...noteWarn, fontSize: 12 }}>
          <span>▲</span>
          <div>Koszt {zmiana > 0 ? "wzrósł" : "spadł"} o <b className="mono">{proc1(Math.abs(zmiana))}</b> od ustawienia:
            {" "}{zl2(c.koszt_bazy)} → {zl2(teraz as number)} zł ({c.baza === "srednia" ? "średnia" : "FIFO"}). Sprawdź tę cenę.</div>
        </div>
      ) : zmiana != null ? <span style={{ ...pill, background: "var(--ok-soft)", color: "var(--ok)", alignSelf: "flex-start" }}>koszt bez zmian od ustawienia</span> : null}
      {historia.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", ...hint }}>Historia ({historia.length})</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6, ...hint }}>
            {historia.map((h) => (
              <span key={h.id} className="num">
                {zl2(brutto ? h.cena_brutto : h.cena_netto)} zł {brutto ? "brutto" : "netto"} · {h.ustawil || "—"} · {h.ustawiono ? fmtDay(h.ustawiono) : ""} · {BAZA_NAZWA[h.baza]} {zl2(h.koszt_bazy)} zł, marża {proc1(h.marza)}
              </span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Kalkulator z szablonami ──────────────────────────────────
function Kalkulator({ data, shop, onCenaMin, onSzablony }: {
  data: WycenaData; shop: string;
  onCenaMin: (c: CenaMin) => void;
  onSzablony: (s: Szablon[]) => void;
}) {
  const pierwszy = data.szablony[0];
  const [szablonId, setSzablonId] = useState<number | null>(pierwszy?.id ?? null);
  const [baza, setBaza] = useState<Baza>(data.fifo != null ? "fifo" : data.srednia != null ? "srednia" : "wlasna");
  const [wlasny, setWlasny] = useState(String(data.fifo ?? data.srednia ?? "").replace(".", ","));
  const [marza, setMarza] = useState(String(pierwszy?.marza ?? 20).replace(".", ","));
  const [koszty, setKoszty] = useState<KosztEdycja[]>(() => (pierwszy?.koszty ?? []).map(doEdycji));
  const [busy, setBusy] = useState(false);
  const [nowaNazwa, setNowaNazwa] = useState<string | null>(null);
  const [potwierdzUsun, setPotwierdzUsun] = useState(false);
  // Którą cenę zapisujemy — domyślnie cel szablonu (każdy z pięciu szablonów ma swój).
  const [cel, setCel] = useState<Kanal>(pierwszy?.cel ?? "detal");

  const szablon = data.szablony.find((s) => s.id === szablonId) ?? null;
  const wybierz = (id: number | null) => {
    const s = data.szablony.find((x) => x.id === id);
    setSzablonId(id);
    setPotwierdzUsun(false);
    if (s) { setMarza(String(s.marza).replace(".", ",")); setKoszty(s.koszty.map(doEdycji)); if (s.cel) setCel(s.cel); }
  };

  const K = baza === "wlasna" ? num(wlasny) : (baza === "fifo" ? data.fifo : data.srednia) ?? 0;
  const kosztyPlus = useMemo(() => koszty.map(zEdycji), [koszty]);
  const w = useMemo(() => wyliczWycene(K, num(marza), kosztyPlus, data.vat), [K, marza, kosztyPlus, data.vat]);

  const zapiszCene = async () => {
    if (!w || busy) return;
    const kanal = cel;
    setBusy(true);
    try {
      const c = (await api.put("/wycena/cena", {
        sku: data.sku, shop, kanal, baza, koszt_wlasny: baza === "wlasna" ? num(wlasny) : null,
        marza: num(marza), koszty: kosztyPlus, szablon: szablon?.nazwa ?? null,
      })) as CenaMin;
      onCenaMin(c);
      toast(`Zapisano „${KANAL_NAZWA[kanal]}”: ${BRUTTO[kanal] ? `${zl2(c.cena_brutto)} zł brutto` : `${zl2(c.cena_netto)} zł netto`}`, "ok");
    } catch (e) {
      toast(`Nie udało się zapisać ceny: ${blad(e)}`, "warning");
    } finally {
      setBusy(false);
    }
  };

  const zapiszSzablon = async (nowy: boolean) => {
    if (busy) return;
    const nazwa = nowy ? (nowaNazwa || "").trim() : szablon?.nazwa;
    if (!nazwa) { toast("Podaj nazwę szablonu", "warning"); return; }
    setBusy(true);
    try {
      const body = { nazwa, cel: nowy ? cel : szablon?.cel ?? cel, marza: num(marza), koszty: kosztyPlus };
      const lista = (nowy ? await api.post("/wycena/szablony", body) : await api.put(`/wycena/szablony/${szablon!.id}`, body)) as Szablon[];
      onSzablony(lista);
      if (nowy) { setSzablonId(lista[lista.length - 1]?.id ?? null); setNowaNazwa(null); }
      toast(nowy ? `Dodano szablon „${nazwa}”` : `Zapisano szablon „${nazwa}”`, "ok");
    } catch (e) {
      toast(`Nie udało się zapisać szablonu: ${blad(e)}`, "warning");
    } finally {
      setBusy(false);
    }
  };

  const usunSzablon = async () => {
    if (!szablon || busy) return;
    if (!potwierdzUsun) { setPotwierdzUsun(true); return; }
    setBusy(true);
    try {
      const lista = (await api.del(`/wycena/szablony/${szablon.id}`)) as Szablon[];
      onSzablony(lista);
      setSzablonId(lista[0]?.id ?? null);
      setPotwierdzUsun(false);
      toast(`Usunięto szablon „${szablon.nazwa}”`, "ok");
    } catch (e) {
      toast(`Nie udało się usunąć szablonu: ${blad(e)}`, "warning");
    } finally {
      setBusy(false);
    }
  };

  const brakBazy = (b: Baza) => b !== "wlasna" && (b === "fifo" ? data.fifo : data.srednia) == null;
  const etykBazy = BAZA_NAZWA[baza];

  return (
    <Box title="Kalkulator" hint="koszty „+” doliczają się PO marży — marża zostaje nietknięta">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 400px), 1fr))", gap: 12 }}>
        <div style={kartaStyl}>
          <Wiersz label="Kalkulator" htmlFor="wyc-szablon">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select id="wyc-szablon" value={szablonId ?? ""} onChange={(e) => wybierz(e.target.value ? Number(e.target.value) : null)} style={{ ...inp, flex: "1 1 220px" }}>
                {data.szablony.map((s) => <option key={s.id} value={s.id}>{s.nazwa}</option>)}
                <option value="">— bez szablonu —</option>
              </select>
            </div>
          </Wiersz>
          <Wiersz label="Koszt bazowy">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div role="group" aria-label="Koszt bazowy" style={seg}>
                {(["fifo", "srednia", "wlasna"] as Baza[]).map((b) => (
                  <button key={b} type="button" disabled={brakBazy(b)} onClick={() => setBaza(b)}
                    style={{ ...segBtn, ...(baza === b ? segOn : {}), opacity: brakBazy(b) ? 0.4 : 1, cursor: brakBazy(b) ? "default" : "pointer" }}>
                    {b === "fifo" ? "FIFO" : b === "srednia" ? "Średnia" : "Własny"}
                  </button>
                ))}
              </div>
              {baza === "wlasna"
                ? <Pole id="wyc-wlasny" value={wlasny} onChange={setWlasny} unit="zł" />
                : <span className="mono" style={{ fontSize: 12, color: "var(--text-mid)" }}>{zl2(K)} zł</span>}
            </div>
          </Wiersz>
          <Wiersz label="Marża" htmlFor="wyc-marza">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Pole id="wyc-marza" value={marza} onChange={setMarza} unit="%" width={56} />
              <span style={hint}>od ceny po marży</span>
            </div>
          </Wiersz>
          <div>
            <div style={{ ...hint, marginBottom: 6 }}>Koszty doliczane po marży (zł wprost, % od ceny końcowej)</div>
            <KosztyEdytor koszty={koszty} onChange={setKoszty} zOd idPrefix="wyc" />
          </div>
          {data.moze_zapisac && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderTop: "1px dashed var(--border)", paddingTop: 10 }}>
              {szablon && <button type="button" onClick={() => zapiszSzablon(false)} disabled={busy} style={btnSec}>Zapisz zmiany w szablonie</button>}
              {nowaNazwa === null
                ? <button type="button" onClick={() => setNowaNazwa("")} disabled={busy} style={btnSec}>Zapisz jako nowy szablon</button>
                : (
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    <input aria-label="Nazwa nowego szablonu" placeholder="Nazwa, np. Cena detal — Temu" autoFocus value={nowaNazwa}
                      onChange={(e) => setNowaNazwa(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") zapiszSzablon(true); }} style={inp} />
                    <button type="button" onClick={() => zapiszSzablon(true)} disabled={busy} style={btnPri}>Dodaj</button>
                    <button type="button" onClick={() => setNowaNazwa(null)} style={linkBtn}>anuluj</button>
                  </span>
                )}
              {szablon && (
                <button type="button" onClick={usunSzablon} disabled={busy} style={{ ...linkBtn, color: potwierdzUsun ? "var(--critical)" : "var(--text-lo)" }}>
                  {potwierdzUsun ? `Na pewno usunąć „${szablon.nazwa}”?` : "Usuń szablon"}
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Kafel label="Cena netto" value={w ? <>{zl2(w.netto)}<small style={small}> zł</small></> : "—"} sub="bez VAT" />
            <Kafel label="Cena brutto" value={w ? <span style={{ color: "var(--accent)" }}>{zl2(w.brutto)}<small style={small}> zł</small></span> : "—"} sub={`z VAT ${data.vat}%`} />
          </div>
          {w ? (
            <div style={rozpisStyl}>
              <Linia l={`Koszt towaru (${etykBazy})`} v={`${zl2(w.kosztBazy)} zł`} />
              <Linia wciecie l={`+ marża ${proc1(w.marza)}`} v={`${zl2(w.marzaZl)} zł`} />
              <Linia suma l="= cena po marży" v={`${zl2(w.poMarzy)} zł`} />
              {w.koszty.map((k, i) => (
                <Linia key={i} wciecie
                  l={<>+ {k.nazwa || "koszt bez nazwy"}{k.typ === "proc" && <span style={hint}> {proc1(k.wartosc)} od {k.od}</span>}</>}
                  v={`${zl2(k.kwota)} zł`} />
              ))}
              <Linia suma l="= cena netto" v={`${zl2(w.netto)} zł`} />
              <Linia wciecie l={`+ VAT ${data.vat}%`} v={`${zl2(w.brutto - w.netto)} zł`} />
              <Linia suma l="= cena brutto" v={`${zl2(w.brutto)} zł`} />
              <div style={{ ...hint, marginTop: 6 }}>
                Sprawdzenie: po zapłaceniu wszystkich kosztów zostaje <b style={{ color: "var(--ok)" }}>{zl2(w.marzaZl)} zł</b> marży, czyli {proc1(w.marza)} od ceny po marży.
              </div>
            </div>
          ) : (
            <div style={noteWarn}>Sprawdź dane: koszt musi być większy od zera, marża poniżej 100%, a koszty procentowe nie mogą zabierać całej ceny.</div>
          )}
          {data.moze_zapisac && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label htmlFor="wyc-cel" style={hint}>Zapisz jako</label>
              <select id="wyc-cel" value={cel} onChange={(e) => setCel(e.target.value as Kanal)} style={{ ...inp, flex: "1 1 200px" }}>
                {KANALY.map((k) => <option key={k} value={k}>{KANAL_NAZWA[k]}</option>)}
              </select>
              <button type="button" onClick={zapiszCene} disabled={!w || busy} style={{ ...btnPri, opacity: !w || busy ? 0.5 : 1 }}>
                {busy ? "Zapisuję…" : "Zapisz cenę"}
              </button>
            </div>
          )}
        </div>
      </div>
    </Box>
  );
}

// ── Konkurencja ──────────────────────────────────────────────
function KonkurencjaEdycja({ data, shop, onZmiana }: { data: WycenaData; shop: string; onZmiana: (k: Konkurent[]) => void }) {
  const [sklep, setSklep] = useState("");
  const [cena, setCena] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [doUsuniecia, setDoUsuniecia] = useState<number | null>(null);

  const dodaj = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!sklep.trim() || !(num(cena) > 0)) { toast("Podaj sklep i cenę brutto", "warning"); return; }
    if (link.trim() && !linkOk(link.trim())) { toast("Link musi zaczynać się od http:// albo https://", "warning"); return; }
    setBusy(true);
    try {
      const k = (await api.post("/wycena/konkurencja", { sku: data.sku, shop, sklep: sklep.trim(), cena_brutto: num(cena), link: link.trim() || null })) as Konkurent[];
      onZmiana(k);
      setSklep(""); setCena(""); setLink("");
      toast("Zapisano cenę konkurencji", "ok");
    } catch (err) {
      toast(`Nie udało się zapisać: ${blad(err)}`, "warning");
    } finally {
      setBusy(false);
    }
  };

  const usun = async (id: number) => {
    if (doUsuniecia !== id) { setDoUsuniecia(id); return; }
    setBusy(true);
    try {
      onZmiana((await api.del(`/wycena/konkurencja/${id}${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`)) as Konkurent[]);
      setDoUsuniecia(null);
    } catch (err) {
      toast(`Nie udało się usunąć: ${blad(err)}`, "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box title="Konkurencja" hint="jeden wpis na sklep · nowa cena tego samego sklepu zastępuje starą, stara trafia do historii">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {data.moze_zapisac && (
          <form onSubmit={dodaj} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input aria-label="Sklep" placeholder="Sklep, np. Allegro – medsport24" value={sklep} onChange={(e) => setSklep(e.target.value)} list="wyc-sklepy" style={{ ...inp, flex: "1 1 200px" }} />
            <datalist id="wyc-sklepy">{data.konkurencja.map((k) => <option key={k.id} value={k.sklep} />)}</datalist>
            <Pole id="wyc-konk-cena" value={cena} onChange={setCena} unit="zł brutto" width={80} />
            <input aria-label="Link do oferty" placeholder="Link do oferty (https://…)" value={link} onChange={(e) => setLink(e.target.value)} style={{ ...inp, flex: "1 1 220px" }} />
            <button type="submit" disabled={busy} style={btnPri}>Zapisz</button>
          </form>
        )}
        {data.konkurencja.length === 0 ? (
          <div style={{ ...pusty, padding: 20 }}>Brak wpisów. Dodaj sklep, w którym jest najtaniej, i ten, w którym jest najdrożej.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr><th style={th}>Sklep</th><th style={{ ...th, textAlign: "right" }}>Cena brutto</th><th style={th}>Link</th><th style={th}>Kto i kiedy</th><th style={th}>Historia</th><th style={th} /></tr>
              </thead>
              <tbody>
                {data.konkurencja.map((k) => {
                  const dni = dniTemu(k.dodano);
                  return (
                    <tr key={k.id}>
                      <td style={td}>{k.sklep}</td>
                      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }} className="num">{zl2(k.cena_brutto)} zł</td>
                      <td style={td}>{linkOk(k.link) ? <a href={k.link as string} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", fontSize: 12 }}>oferta ↗</a> : <span style={hint}>—</span>}</td>
                      <td style={{ ...td, color: "var(--text-lo)", fontSize: 12 }}>
                        {k.dodal || "—"} · {k.dodano ? fmtDay(k.dodano) : ""}
                        {dni != null && dni > KONKURENCJA_STARA_DNI && <> <span style={{ ...pill, ...warnStyl }}>{dni} dni temu</span></>}
                      </td>
                      <td style={{ ...td, color: "var(--text-lo)", fontSize: 12 }}>
                        {k.historia.length ? k.historia.map((h, i) => (
                          <div key={i} className="num">{zl2(h.cena_brutto)} zł · {h.dodal || "—"} · {h.dodano ? fmtDay(h.dodano) : ""}</div>
                        )) : "—"}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>
                        {data.moze_zapisac && (
                          <button type="button" onClick={() => usun(k.id)} disabled={busy}
                            style={{ ...linkBtn, color: doUsuniecia === k.id ? "var(--critical)" : "var(--text-lo)" }}>
                            {doUsuniecia === k.id ? "Na pewno?" : "Usuń"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={noteInfo}>
          <span style={{ color: "var(--info)" }}>i</span>
          <div>Zespół widzi te ceny w zakładce „test-cena” na pasku: od najtańszego do najdroższego, z naszą ceną i ceną minimalną.</div>
        </div>
      </div>
    </Box>
  );
}
