"use client";
// ============================================================
// MAGAZYN — zakładka „Koszt jednostkowy" na karcie kontenera.
//
// Składa koszt sztuki z trzech dokumentów odprawy:
//   · XML zgłoszenia celnego (SAD) — pozycje, cło, doliczenia, kurs,
//   · faktura spedytora — fracht, THC, opłaty, ubezpieczenie (przepisywane ręcznie),
//   · pozycje kontenera — sztuki i ceny planowane, już w aplikacji.
//
// Plik XML NIE trafia do załączników: backend czyta z niego liczby i o nim zapomina.
// Dlatego przy zapisie wysyłamy ten sam plik jeszcze raz — trzymamy go w stanie
// komponentu od momentu wrzucenia (patrz `plik`).
//
// Zakładka pokazuje się tylko przy uprawnieniu „Koszt jednostkowy kontenera",
// a pola do wpisywania i przycisk zapisu — przy „Liczenie kosztu jednostkowego"
// (lib/permissions: canSeeLandedCost / canEditLandedCost).
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { canEditLandedCost, useUser } from "@/lib/permissions";
import { toast } from "./toast";

// ── typy odpowiedzi backendu (routers/odprawy.py) ────────────
type Kontrola = { nazwa: string; ok: boolean; wyliczone: number; z_pliku: number };
type Uwaga = { poziom: "blad" | "ostrzezenie" | "info"; tresc: string; szczegol: string };
type Linia = { lp: number | null; nazwa: string; kwota: number; waluta: string; klucz: string; container_id: number | null };
type PozycjaSad = {
  nr: number; kod_cn: string | null; opis: string; wartosc: number; masa_brutto: number;
  clo_stawka: number; clo_pln: number; vat_stawka: number; vat_metoda: string | null;
  liczba_opakowan: number | null; szt_uzup: number | null; kontenery: string[];
  item_ids: number[]; gratis_item_id: number | null;
};
type Towar = {
  item_id: number; container_id: number; container_number: string; sku: string; ilosc: number;
  cena_planowana: number; cena_zakupu_waluta: number; towar: number; logistyka: number; clo: number;
  gratisy: number; transport_krajowy: number; koszt_jednostkowy: number; zmiana_proc: number | null;
  szacunek: boolean; poz_sad: number | null;
};
export type Odprawa = {
  mrn: string | null; data_zgloszenia: string | null; dostawca: string | null; importer: string | null;
  nip_importera: string | null; firma_slug: string | null; incoterms: string | null;
  waluta: string; kurs_celny: number; kursy: Record<string, number>;
  wartosc_faktur: number; masa_brutto: number; clo_suma: number; vat_suma: number;
  faktury_dostawcy: string[]; kontenery: string[]; kontenery_w_aplikacji: number[];
  doliczenia: { kod: string; kwota: number; klucz: string; do_wartosci_celnej: boolean }[];
  pozycje: PozycjaSad[]; towar: Towar[]; koszty: Linia[];
  kontrole: Kontrola[]; uwagi: Uwaga[]; klucz_podzialu: string;
  suma_towar: number; suma_logistyka: number; suma_clo: number; narzut_proc: number | null;
  mozna_zapisac: boolean; status: string;
  zapis?: {
    odprawa_id: number; pozycji_z_kosztem: number; mrn_uzupelniony: string[];
    kontenery_zaktualizowane: string[]; produkty_waga: string[]; produkty_kod_cn: string[];
  } | null;
};

const pl = (n: number | null | undefined, d = 2) =>
  (n ?? 0).toLocaleString("pl-PL", { minimumFractionDigits: d, maximumFractionDigits: d });

export default function LandedCostTab({ containerId, onSaved }: { containerId: number; onSaved?: () => void }) {
  const canEdit = canEditLandedCost(useUser());
  const [dane, setDane] = useState<Odprawa | null>(null);
  const [plik, setPlik] = useState<File | null>(null);
  const [blad, setBlad] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ladowanie, setLadowanie] = useState(true);
  const [drag, setDrag] = useState(false);
  const wejscie = useRef<HTMLInputElement>(null);

  // Ustawienia rachunku — wszystko, co użytkownik może zmienić przed zapisem.
  const [klucz, setKlucz] = useState<"waga" | "cbm">("waga");
  const [koszty, setKoszty] = useState<Linia[]>([]);
  const [fxTowar, setFxTowar] = useState<string>("");
  const [fxKoszty, setFxKoszty] = useState<string>("");
  const [fvNr, setFvNr] = useState("");
  const [fvData, setFvData] = useState("");
  const [przypisanie, setPrzypisanie] = useState<Record<number, number>>({});
  const [gratisy, setGratisy] = useState<Record<number, number>>({});
  const [cenyReczne, setCenyReczne] = useState<Record<number, string>>({});

  // Zapisana odprawa tego kontenera — jeśli jest, pokazujemy ją bez wrzucania pliku.
  useEffect(() => {
    let zyje = true;
    (async () => {
      try {
        const z = (await api.get(`/kontenery/${containerId}/odprawa`)) as Odprawa | null;
        if (zyje && z) { setDane(z); setKlucz(z.klucz_podzialu === "cbm" ? "cbm" : "waga"); setKoszty(z.koszty ?? []); }
      } catch { /* brak odprawy to normalny stan, nie błąd */ }
      finally { if (zyje) setLadowanie(false); }
    })();
    return () => { zyje = false; };
  }, [containerId]);

  const ustawienia = useCallback(() => ({
    klucz_podzialu: klucz,
    kurs_towaru: fxTowar ? Number(fxTowar.replace(",", ".")) : null,
    kurs_kosztow: fxKoszty ? Number(fxKoszty.replace(",", ".")) : null,
    fv_spedytora: fvNr || null,
    fv_spedytora_data: fvData || null,
    koszty,
    przypisanie,
    gratisy,
    ceny_reczne: Object.fromEntries(
      Object.entries(cenyReczne)
        .filter(([, v]) => v !== "" && !Number.isNaN(Number(v.replace(",", "."))))
        .map(([k, v]) => [k, Number(v.replace(",", "."))]),
    ),
  }), [klucz, fxTowar, fxKoszty, fvNr, fvData, koszty, przypisanie, gratisy, cenyReczne]);

  const wyslij = useCallback(async (f: File, zapis: boolean) => {
    setBusy(true); setBlad(null);
    try {
      const fd = new FormData();
      fd.append("plik", f);
      fd.append("ustawienia", JSON.stringify(ustawienia()));
      const url = `/kontenery/${containerId}/odprawa${zapis ? "" : "/podglad"}`;
      const z = (await api.post(url, fd)) as Odprawa;
      setDane(z);
      setPlik(f);
      if (!koszty.length) setKoszty(z.koszty ?? []);
      if (!fxTowar) setFxTowar(String(z.kurs_celny));
      if (!fxKoszty) setFxKoszty(String(z.kurs_celny));
      if (zapis) { toast("Zapisano koszt jednostkowy", "ok"); onSaved?.(); }
    } catch (e) {
      const m = e instanceof Error && e.message ? e.message : "Nie udało się wczytać zgłoszenia";
      setBlad(m);
      if (zapis) toast(m, "warning");
    } finally { setBusy(false); }
  }, [containerId, ustawienia, koszty.length, fxTowar, fxKoszty, onSaved]);

  // Zmiana ustawienia przelicza podgląd na tym samym pliku — bez ponownego wybierania.
  const przelicz = useCallback(() => { if (plik) void wyslij(plik, false); }, [plik, wyslij]);

  const wybierz = (f: File | null | undefined) => {
    if (!f) return;
    if (!/\.xml$/i.test(f.name)) { setBlad("To nie jest plik XML. Agencja dołącza go do maila obok PDF-a."); return; }
    void wyslij(f, false);
  };

  const zapisz = () => { if (plik) void wyslij(plik, true); };

  const zmienKoszt = (idx: number, kwota: string) => {
    setKoszty((k) => k.map((l, i) => (i === idx ? { ...l, kwota: Number(kwota.replace(",", ".")) || 0 } : l)));
  };

  if (ladowanie) return <div className="pulse-soft" style={{ height: 200, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />;

  // ── stan pusty ────────────────────────────────────────────
  if (!dane) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {blad && <Komunikat poziom="blad" tresc={blad} />}
        {canEdit ? (
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); wybierz(e.dataTransfer.files?.[0]); }}
            style={{
              border: `2px dashed ${drag ? "var(--accent)" : "var(--border)"}`, borderRadius: "var(--r-lg)",
              background: drag ? "var(--accent-soft)" : "var(--surface-1)", padding: "44px 20px", textAlign: "center",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Nie ma jeszcze rachunku dla tej odprawy</div>
            <p style={{ margin: "0 auto", maxWidth: "58ch", fontSize: 12.5, color: "var(--text-lo)", lineHeight: 1.6 }}>
              Wrzuć plik XML zgłoszenia celnego z maila od agencji. Aplikacja odczyta z niego pozycje,
              cło i doliczenia. Plik nie trafi do załączników kontenera.
            </p>
            <button onClick={() => wejscie.current?.click()} disabled={busy} style={{ ...btnPri, marginTop: 16 }}>
              {busy ? "Wczytuję…" : "Wczytaj XML odprawy"}
            </button>
            <input ref={wejscie} type="file" accept=".xml,text/xml,application/xml" style={{ display: "none" }}
              onChange={(e) => { wybierz(e.target.files?.[0]); e.currentTarget.value = ""; }} />
          </div>
        ) : (
          <Komunikat poziom="info" tresc="Koszt jednostkowy nie został jeszcze policzony dla tego kontenera." />
        )}
      </div>
    );
  }

  const zapisany = dane.status === "zapisana" && !plik;
  const bledy = dane.uwagi.filter((u) => u.poziom === "blad");
  const zleKontrole = dane.kontrole.filter((k) => !k.ok);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {blad && <Komunikat poziom="blad" tresc={blad} />}

      {/* Nagłówek odprawy */}
      <div style={{ ...karta, display: "flex", gap: 24, flexWrap: "wrap", padding: "12px 16px", alignItems: "flex-start" }}>
        <Pole etykieta="Odprawa" wartosc={dane.mrn ?? "—"} mono
          pod={[dane.data_zgloszenia, dane.faktury_dostawcy.join(", ")].filter(Boolean).join(" · ")} />
        <Pole etykieta="Dostawca" wartosc={dane.dostawca ?? "—"} pod={dane.incoterms ?? ""} />
        <Pole etykieta="Importer" wartosc={dane.importer ?? "—"} pod={dane.nip_importera ? `NIP ${dane.nip_importera}` : ""} />
        <Pole etykieta="Wartość" wartosc={`${pl(dane.wartosc_faktur, 0)} ${dane.waluta}`} mono
          pod={`kurs celny ${pl(dane.kurs_celny, 4)}`} />
        <Pole etykieta="Kontenery" wartosc={dane.kontenery.join(", ")} mono />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ ...plakietka, ...(zapisany ? okStyl : bledy.length ? zlyStyl : ostrzStyl) }}>
            {zapisany ? "zapisana" : bledy.length ? `${bledy.length} do poprawy` : "gotowa do zapisu"}
          </span>
          {canEdit && (
            <button onClick={() => { setDane(null); setPlik(null); setKoszty([]); }} style={btnSec}>
              {zapisany ? "Wczytaj ponownie" : "Zmień plik"}
            </button>
          )}
        </div>
      </div>

      {/* Kontrole */}
      {!!dane.kontrole.length && (
        <div style={karta}>
          <Naglowek tytul="Kontrole" hint={`${dane.kontrole.length - zleKontrole.length}/${dane.kontrole.length} zgodnych`} />
          <div style={{ padding: "8px 16px 12px", display: "grid", gap: 6 }}>
            {(zleKontrole.length ? zleKontrole : dane.kontrole.slice(0, 4)).map((k, i) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 12.5, alignItems: "baseline" }}>
                <span style={{ color: k.ok ? "var(--ok)" : "var(--critical)", fontWeight: 700 }}>{k.ok ? "✓" : "✕"}</span>
                <span style={{ flex: 1, minWidth: 0 }}>{k.nazwa}</span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
                  {k.ok ? pl(k.z_pliku) : `${pl(k.wyliczone)} vs ${pl(k.z_pliku)}`}
                </span>
              </div>
            ))}
            {!zleKontrole.length && dane.kontrole.length > 4 && (
              <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
                …i {dane.kontrole.length - 4} dalszych — wszystkie zgodne.
              </div>
            )}
          </div>
        </div>
      )}

      {dane.uwagi.map((u, i) => <Komunikat key={i} poziom={u.poziom} tresc={u.tresc} szczegol={u.szczegol} />)}

      {/* Pozycje SAD i przypisany towar */}
      <div style={karta}>
        <Naglowek tytul="Pozycje zgłoszenia i towar z kontenerów"
          hint={canEdit ? "Przenieś SKU, jeśli trafiło do złej pozycji" : ""} />
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>
              <Th l>Pozycja / SKU</Th><Th l>Kontener</Th><Th>Szt.</Th><Th>Cena plan.</Th>
              <Th>{dane.waluta}/szt</Th><Th l>Źródło</Th><Th>Cło</Th>{canEdit && <Th l>Pozycja SAD</Th>}
            </tr></thead>
            <tbody>
              {dane.pozycje.map((p) => {
                const wiersze = dane.towar.filter((t) => t.poz_sad === p.nr);
                const mieszana = new Set(wiersze.map((t) => t.sku)).size > 1;
                return (
                  <React.Fragment key={p.nr}>
                    <tr style={{ background: "var(--surface-2)" }}>
                      <td colSpan={3} style={{ ...td, textAlign: "left", whiteSpace: "normal" }}>
                        <b>Poz. {p.nr}</b> <span className="mono" style={{ color: "var(--text-lo)", fontSize: 11 }}>{p.kod_cn}</span>{" "}
                        <span style={{ color: "var(--text-mid)", fontSize: 11.5 }}>{p.opis.slice(0, 90)}</span>
                      </td>
                      <td style={td} />
                      <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{pl(p.wartosc)}</td>
                      <td style={{ ...td, textAlign: "left" }}>
                        {!wiersze.length ? <span style={{ ...tag, ...infoStyl }}>GRATIS</span>
                          : mieszana ? <span style={{ ...tag, ...ostrzStyl }}>KILKA SKU</span> : null}
                      </td>
                      <td style={{ ...td, fontFamily: "var(--font-mono)" }}>
                        {p.clo_stawka ? `${pl(p.clo_stawka, 1)}% · ` : ""}{pl(p.clo_pln, 0)} zł
                      </td>
                      {canEdit && <td style={td} />}
                    </tr>

                    {!wiersze.length && (
                      <tr>
                        <td colSpan={canEdit ? 8 : 7} style={{ ...td, textAlign: "left", paddingLeft: 26, whiteSpace: "normal" }}>
                          <span style={{ color: "var(--text-lo)", fontSize: 12 }}>
                            Brak tej pozycji w kontenerach — cło i logistyka trafią na:{" "}
                          </span>
                          {canEdit ? (
                            <select value={gratisy[p.nr] ?? p.gratis_item_id ?? ""} style={select}
                              onChange={(e) => { setGratisy((g) => ({ ...g, [p.nr]: Number(e.target.value) })); przelicz(); }}>
                              {dane.towar.map((t) => (
                                <option key={t.item_id} value={t.item_id}>{t.sku} ({t.container_number})</option>
                              ))}
                            </select>
                          ) : (
                            <b>{dane.towar.find((t) => t.item_id === p.gratis_item_id)?.sku ?? "—"}</b>
                          )}
                        </td>
                      </tr>
                    )}

                    {wiersze.map((t) => (
                      <tr key={t.item_id}>
                        <td style={{ ...td, textAlign: "left", paddingLeft: 26 }}>
                          <span className="mono">{t.sku}</span>
                        </td>
                        <td style={{ ...td, textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-lo)" }}>
                          {t.container_number}
                        </td>
                        <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{t.ilosc}</td>
                        <td style={{ ...td, fontFamily: "var(--font-mono)", color: "var(--text-lo)" }}>{pl(t.cena_planowana)}</td>
                        <td style={td}>
                          {canEdit && t.szacunek ? (
                            <input type="number" step="0.01" style={input}
                              placeholder={pl(t.cena_zakupu_waluta)}
                              value={cenyReczne[t.item_id] ?? ""}
                              onChange={(e) => setCenyReczne((c) => ({ ...c, [t.item_id]: e.target.value }))}
                              onBlur={przelicz} />
                          ) : (
                            <span className="mono">{pl(t.cena_zakupu_waluta)}</span>
                          )}
                        </td>
                        <td style={{ ...td, textAlign: "left" }}>
                          <span style={{ ...tag, ...(t.szacunek ? ostrzStyl : okStyl) }}>
                            {t.szacunek ? "SZACUNEK" : "Z SAD"}
                          </span>
                        </td>
                        <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{pl(t.clo)} zł</td>
                        {canEdit && (
                          <td style={{ ...td, textAlign: "left" }}>
                            <select value={przypisanie[t.item_id] ?? t.poz_sad ?? ""} style={select}
                              onChange={(e) => { setPrzypisanie((p2) => ({ ...p2, [t.item_id]: Number(e.target.value) })); przelicz(); }}>
                              {dane.pozycje.map((q) => <option key={q.nr} value={q.nr}>poz. {q.nr} · {q.kod_cn}</option>)}
                            </select>
                          </td>
                        )}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Koszty z faktury spedytora */}
      <div style={karta}>
        <Naglowek tytul="Koszty" action={canEdit && (
          <div style={{ display: "inline-flex", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 999, padding: 3 }}>
            {(["waga", "cbm"] as const).map((k) => (
              <button key={k} onClick={() => { setKlucz(k); przelicz(); }}
                style={{ ...segBtn, ...(klucz === k ? segOn : null) }}>{k === "waga" ? "Waga" : "CBM"}</button>
            ))}
          </div>
        )} />
        {canEdit && (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: "10px 16px", borderBottom: "1px solid var(--border-soft)" }}>
            <Wpis etykieta="Nr faktury spedytora" v={fvNr} set={setFvNr} szer={160} />
            <Wpis etykieta="Data sprzedaży" v={fvData} set={setFvData} szer={120} placeholder="2026-08-26" />
            <Wpis etykieta="Kurs kosztów" v={fxKoszty} set={setFxKoszty} szer={100} onBlur={przelicz} />
            <Wpis etykieta="Kurs towaru" v={fxTowar} set={setFxTowar} szer={100} onBlur={przelicz} />
            <span style={{ fontSize: 11.5, color: "var(--text-lo)", alignSelf: "flex-end", flex: 1, minWidth: 180 }}>
              Kurs NBP jest w nagłówku faktury, w zdaniu o przeliczeniu VAT.
            </span>
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr><Th l>Pozycja</Th><Th>Lp.</Th><Th>Kwota netto</Th><Th l>Klucz</Th></tr></thead>
            <tbody>
              {koszty.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...td, textAlign: "left" }}>
                    {l.nazwa}
                    {l.container_id && <span style={{ fontSize: 10.5, color: "var(--text-lo)" }}> · osobna faktura</span>}
                  </td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)", color: "var(--text-lo)" }}>{l.lp ?? "—"}</td>
                  <td style={td}>
                    {canEdit ? (
                      <input type="number" step="0.01" style={input} value={l.kwota || ""} placeholder="0"
                        onChange={(e) => zmienKoszt(i, e.target.value)} onBlur={przelicz} />
                    ) : <span className="mono">{pl(l.kwota)}</span>}{" "}
                    <span style={{ color: "var(--text-lo)", fontSize: 11 }}>{l.waluta}</span>
                  </td>
                  <td style={{ ...td, textAlign: "left", color: "var(--text-lo)" }}>
                    {l.klucz === "wartosc" ? "wartość" : klucz}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border-soft)", fontSize: 11.5, color: "var(--text-lo)", lineHeight: 1.6 }}>
          Przepisujesz kolumnę „Wartość netto" z faktury spedytora. VAT z niej jest do odliczenia
          i nie wchodzi do kosztu; VAT importowy rozliczany w JPK (art. 33a) też nie.
        </div>
      </div>

      {/* Podsumowanie */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <Kafel l="Towar" v={`${pl(dane.suma_towar, 0)} zł`} n={`po kursie ${pl(Number(fxTowar) || dane.kurs_celny, 4)}`} />
        <Kafel l="Logistyka" v={`${pl(dane.suma_logistyka, 0)} zł`} n="fracht, opłaty, transport" />
        <Kafel l="Cło" v={`${pl(dane.suma_clo, 0)} zł`} n="z SAD, do zapłaty" />
        <Kafel l="Narzut na towar" v={dane.narzut_proc != null ? `+${pl(dane.narzut_proc, 1)}%` : "—"} n="cała odprawa" akcent />
        <Kafel l="VAT importowy" v={`${pl(dane.vat_suma, 0)} zł`} n="w JPK, poza kosztem" />
      </div>

      {/* Wynik */}
      <div style={karta}>
        <Naglowek tytul="Koszt jednostkowy" hint="ten sam SKU w dwóch kontenerach dostaje osobny koszt" />
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>
              <Th l>SKU</Th><Th>Szt.</Th><Th>Towar/szt</Th><Th>Logistyka/szt</Th><Th>Cło/szt</Th>
              <Th>Gratisy/szt</Th><Th>Transport/szt</Th><Th>Koszt jedn.</Th><Th>Cena plan.</Th><Th>Zmiana</Th>
            </tr></thead>
            <tbody>
              {dane.towar.map((t) => (
                <tr key={t.item_id}>
                  <td style={{ ...td, textAlign: "left" }}>
                    <span className="mono">{t.sku}</span>
                    <div style={{ fontSize: 10.5, color: "var(--text-lo)", fontFamily: "var(--font-mono)" }}>{t.container_number}</div>
                  </td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{t.ilosc}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{pl(t.towar / (t.ilosc || 1))}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{pl(t.logistyka / (t.ilosc || 1))}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{pl(t.clo / (t.ilosc || 1))}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)", color: t.gratisy ? undefined : "var(--text-disabled)" }}>{pl(t.gratisy / (t.ilosc || 1))}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)", color: t.transport_krajowy ? undefined : "var(--text-disabled)" }}>{pl(t.transport_krajowy / (t.ilosc || 1))}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--accent)", background: "color-mix(in oklch, var(--accent) 7%, transparent)" }}>{pl(t.koszt_jednostkowy)}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)", color: "var(--text-lo)" }}>{pl(t.cena_planowana)}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)", color: (t.zmiana_proc ?? 0) >= 0 ? "var(--critical)" : "var(--ok)" }}>
                    {t.zmiana_proc == null ? "—" : `${t.zmiana_proc >= 0 ? "+" : ""}${pl(t.zmiana_proc, 1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {canEdit && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={zapisz} disabled={busy || !plik || !dane.mozna_zapisac} style={{ ...btnPri, opacity: (busy || !plik || !dane.mozna_zapisac) ? 0.5 : 1 }}>
            {busy ? "Zapisuję…" : "Zapisz koszt odprawy"}
          </button>
          <span style={{ fontSize: 11.5, color: "var(--text-lo)", maxWidth: "70ch" }}>
            {!plik ? "Wczytaj plik zgłoszenia, żeby przeliczyć i zapisać rachunek od nowa."
              : !dane.mozna_zapisac ? "Popraw błędy wypisane wyżej — zapis jest zablokowany."
                : "Zapis ustawi koszt na pozycjach kontenerów, uzupełni puste pola karty kontenera oraz wagę i kod CN w kartach produktów."}
          </span>
        </div>
      )}

      {dane.zapis && (
        <div style={{ ...karta, padding: "12px 16px", fontSize: 12.5, color: "var(--text-mid)", lineHeight: 1.7 }}>
          <b style={{ color: "var(--text-hi)" }}>Co zmienił zapis</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            <li>Koszt ustawiony na {dane.zapis.pozycji_z_kosztem} pozycjach kontenerów.</li>
            {!!dane.zapis.mrn_uzupelniony.length && <li>Uzupełniony MRN na: {dane.zapis.mrn_uzupelniony.join(", ")}.</li>}
            {!!dane.zapis.kontenery_zaktualizowane.length && <li>Uzupełnione koszty spedycji na: {dane.zapis.kontenery_zaktualizowane.join(", ")}.</li>}
            {!!dane.zapis.produkty_waga.length && <li>Waga brutto dopisana do kart: {dane.zapis.produkty_waga.join(", ")}.</li>}
            {!!dane.zapis.produkty_kod_cn.length && <li>Kod CN dopisany do kart: {dane.zapis.produkty_kod_cn.join(", ")}.</li>}
            <li>Plik XML nie został zapisany — w bazie jest sam odczyt i ślad, kto go wczytał.</li>
          </ul>
        </div>
      )}
    </div>
  );
}

// ── drobne klocki ────────────────────────────────────────────
function Naglowek({ tytul, hint, action }: { tytul: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "11px 16px", borderBottom: "1px solid var(--border-soft)" }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>{tytul}</span>
      {action ?? (hint ? <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{hint}</span> : null)}
    </div>
  );
}

function Pole({ etykieta, wartosc, pod, mono }: { etykieta: string; wartosc: string; pod?: string; mono?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>{etykieta}</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2, fontFamily: mono ? "var(--font-mono)" : undefined }}>{wartosc}</div>
      {pod ? <div style={{ fontSize: 11, color: "var(--text-lo)" }}>{pod}</div> : null}
    </div>
  );
}

function Kafel({ l, v, n, akcent }: { l: string; v: string; n: string; akcent?: boolean }) {
  return (
    <div style={{ ...karta, padding: "12px 14px", background: akcent ? "color-mix(in oklch, var(--accent) 8%, var(--surface-1))" : "var(--surface-1)" }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>{l}</div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 4, color: akcent ? "var(--accent)" : undefined }}>{v}</div>
      <div style={{ fontSize: 10.5, color: "var(--text-lo)", marginTop: 2 }}>{n}</div>
    </div>
  );
}

function Wpis({ etykieta, v, set, szer, placeholder, onBlur }: {
  etykieta: string; v: string; set: (s: string) => void; szer: number; placeholder?: string; onBlur?: () => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-lo)" }}>{etykieta}</span>
      <input value={v} placeholder={placeholder} onChange={(e) => set(e.target.value)} onBlur={onBlur}
        style={{ ...input, width: szer }} />
    </label>
  );
}

function Komunikat({ poziom, tresc, szczegol }: { poziom: Uwaga["poziom"]; tresc: string; szczegol?: string }) {
  const s = poziom === "blad" ? zlyStyl : poziom === "ostrzezenie" ? ostrzStyl : infoStyl;
  const znak = poziom === "blad" ? "✕" : poziom === "ostrzezenie" ? "!" : "i";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--r-md)",
      background: s.background, border: `1px solid color-mix(in oklch, ${s.color} 30%, transparent)` }}>
      <span style={{ color: s.color, fontWeight: 700, lineHeight: 1.3 }}>{znak}</span>
      <div style={{ fontSize: 12.5, color: "var(--text-mid)", minWidth: 0 }}>
        <span style={{ color: "var(--text-hi)" }}>{tresc}</span>
        {szczegol ? <span style={{ color: "var(--text-lo)" }}> — {szczegol}</span> : null}
      </div>
    </div>
  );
}

const Th = ({ children, l }: { children: React.ReactNode; l?: boolean }) => (
  <th style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-lo)",
    textAlign: l ? "left" : "right", padding: "8px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{children}</th>
);

const karta: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" };
const tabela: React.CSSProperties = { width: "100%", borderCollapse: "collapse" };
const td: React.CSSProperties = { padding: "7px 10px", fontSize: 12.5, textAlign: "right", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap" };
const input: React.CSSProperties = { padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-hi)", outline: "none", width: 92, textAlign: "right", fontFamily: "var(--font-mono)" };
const select: React.CSSProperties = { padding: "3px 6px", fontSize: 11.5, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-hi)" };
const btnPri: React.CSSProperties = { background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--accent-ink, #201400)", font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "8px 16px", borderRadius: "var(--r-sm)", cursor: "pointer" };
const btnSec: React.CSSProperties = { background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-mid)", font: "inherit", fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: "var(--r-sm)", cursor: "pointer" };
const segBtn: React.CSSProperties = { border: 0, background: "transparent", color: "var(--text-lo)", font: "inherit", fontSize: 11.5, fontWeight: 600, padding: "4px 12px", borderRadius: 999, cursor: "pointer" };
const segOn: React.CSSProperties = { background: "var(--accent)", color: "var(--accent-ink, #201400)" };
const plakietka: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, padding: "3px 10px", borderRadius: 999, whiteSpace: "nowrap" };
const tag: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", padding: "2px 6px", borderRadius: 4 };
const okStyl = { background: "var(--ok-soft)", color: "var(--ok)" };
const ostrzStyl = { background: "var(--warning-soft)", color: "var(--warning)" };
const zlyStyl = { background: "var(--critical-soft)", color: "var(--critical)" };
const infoStyl = { background: "var(--info-soft)", color: "var(--info)" };
