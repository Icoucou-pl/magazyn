"use client";
// ============================================================
// MAGAZYN — wspólne klocki zakładek „test-wycena” i „test-cena”.
//
//   • PasekCen     — poziomy pasek: strefy kolorów, kropki konkurencji, znacznik naszej ceny
//                    i kreska ceny minimalnej (konkurencja i kalkulator handlowca)
//   • KosztyEdytor — lista kosztów „+” (nazwa, % / zł, od netto / od brutto, wartość, ×)
//   • Pole, Linia, style — drobne rzeczy, żeby obie zakładki wyglądały tak samo
// ============================================================

import React from "react";
import { BAZA_KROTKO, num, zl2, type BazaKosztu, type KosztBazy, type KosztPlus, type Od, type TypKosztu } from "@/lib/wycena";

// ── Pasek cen ────────────────────────────────────────────────
export type StrefaPaska = { od: number; do: number; kolor: string };

export function PasekCen({ lo, hi, strefy = [], kropki = [], min, my }: {
  lo: number; hi: number; strefy?: StrefaPaska[];
  kropki?: { v: number; t: string }[];
  min?: number | null;
  my?: { v: number; etk: string } | null;
}) {
  if (!(hi > lo)) return null;
  const x = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const krok = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((k) => (hi - lo) / k <= 7) ?? 10000;
  const podzialka: number[] = [];
  for (let t = Math.ceil(lo / krok) * krok; t <= hi; t += krok) podzialka.push(t);
  return (
    <div style={{ position: "relative", height: 58, margin: "26px 10px 4px" }} aria-hidden>
      <div style={{ position: "absolute", left: 0, right: 0, top: 22, height: 10, borderRadius: 99, background: "var(--surface-2)", overflow: "hidden" }}>
        {strefy.map((s, i) => (
          <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${x(s.od)}%`, width: `${Math.max(0, x(s.do) - x(s.od))}%`, background: s.kolor }} />
        ))}
      </div>
      {min != null && (
        <div title={`Cena minimalna ${zl2(min)} zł`} style={{ position: "absolute", top: 16, left: `${x(min)}%`, width: 2, height: 22, background: "var(--critical)", transform: "translateX(-50%)" }} />
      )}
      {kropki.map((k, i) => (
        <div key={i} title={k.t} style={{ position: "absolute", top: 20, left: `${x(k.v)}%`, transform: "translateX(-50%)", width: 13, height: 13, borderRadius: 99, background: "var(--text-mid)", border: "2px solid var(--bg)" }} />
      ))}
      {podzialka.map((t) => (
        <div key={t} className="mono" style={{ position: "absolute", top: 40, left: `${x(t)}%`, transform: "translateX(-50%)", fontSize: 10.5, color: "var(--text-lo)", whiteSpace: "nowrap" }}>
          {t.toLocaleString("pl-PL")}
        </div>
      ))}
      {my && (
        <div style={{ position: "absolute", top: -8, left: `${x(my.v)}%`, transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, transition: "left .15s" }}>
          <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, background: "var(--accent)", color: "var(--accent-ink)", padding: "1px 7px", borderRadius: 99, whiteSpace: "nowrap" }}>{my.etk}</span>
          <span style={{ width: 3, height: 28, background: "var(--accent)", borderRadius: 2 }} />
        </div>
      )}
    </div>
  );
}

// ── Koszty „+” ───────────────────────────────────────────────
/** Wiersz w edycji: wartość jako tekst, żeby dało się wpisać „1,5”. */
export type KosztEdycja = { nazwa: string; typ: TypKosztu; wartosc: string; od: Od };
export const doEdycji = (k: KosztPlus): KosztEdycja => ({ ...k, wartosc: String(k.wartosc).replace(".", ",") });
export const zEdycji = (k: KosztEdycja): KosztPlus => ({ nazwa: k.nazwa.trim(), typ: k.typ, wartosc: num(k.wartosc), od: k.od });

export function KosztyEdytor({ koszty, onChange, zOd, idPrefix, disabled }: {
  koszty: KosztEdycja[];
  onChange: (k: KosztEdycja[]) => void;
  /** true = przy % wybór „od netto / od brutto”; false = % zawsze od ceny netto (kalkulator handlowca). */
  zOd: boolean;
  idPrefix: string;
  disabled?: boolean;
}) {
  const zmien = (i: number, z: Partial<KosztEdycja>) => onChange(koszty.map((k, j) => (j === i ? { ...k, ...z } : k)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <style>{`.wyc-koszt{display:grid;grid-template-columns:minmax(0,1fr) auto auto 96px 30px;gap:6px;align-items:center}
        @media (max-width:560px){.wyc-koszt{grid-template-columns:minmax(0,1fr) auto 30px}.wyc-koszt .wyc-nazwa{grid-column:1/-1}}`}</style>
      {koszty.map((k, i) => (
        <div key={i} className="wyc-koszt">
          <input className="wyc-nazwa" aria-label="Nazwa kosztu" placeholder="Nazwa, np. prowizja Erli" value={k.nazwa} disabled={disabled}
            onChange={(e) => zmien(i, { nazwa: e.target.value })} style={{ ...inp, width: "100%" }} />
          <div role="group" aria-label="Rodzaj kosztu" style={seg}>
            {(["proc", "zl"] as TypKosztu[]).map((t) => (
              <button key={t} type="button" disabled={disabled} onClick={() => zmien(i, { typ: t })} style={{ ...segBtn, ...(k.typ === t ? segOn : {}) }}>
                {t === "proc" ? "%" : "zł"}
              </button>
            ))}
          </div>
          {zOd ? (
            <select aria-label="Procent od" value={k.od} disabled={disabled || k.typ !== "proc"} onChange={(e) => zmien(i, { od: e.target.value as Od })}
              style={{ ...inp, opacity: k.typ === "proc" ? 1 : 0.35 }}>
              <option value="brutto">od brutto</option>
              <option value="netto">od netto</option>
            </select>
          ) : <span style={{ fontSize: 11, color: "var(--text-lo)", whiteSpace: "nowrap" }}>{k.typ === "proc" ? "od netto" : ""}</span>}
          <Pole id={`${idPrefix}-k${i}`} value={k.wartosc} onChange={(v) => zmien(i, { wartosc: v })} unit={k.typ === "proc" ? "%" : "zł"} width={56} disabled={disabled} />
          <button type="button" aria-label="Usuń koszt" disabled={disabled} onClick={() => onChange(koszty.filter((_, j) => j !== i))} style={btnX}>×</button>
        </div>
      ))}
      {!disabled && (
        <button type="button" onClick={() => onChange([...koszty, { nazwa: "", typ: "proc", wartosc: "", od: zOd ? "brutto" : "netto" }])} style={btnDodaj}>
          + Dodaj koszt
        </button>
      )}
    </div>
  );
}

// ── Ramka sekcji i kafel ─────────────────────────────────────
/** Sekcja w ramce: tytuł w środku po lewej, opis po prawej (zawija się na telefonie). */
export function Box({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: 16, display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "4px 16px" }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>{title}</h3>
        {hint && <span style={{ fontSize: 11.5, color: "var(--text-lo)", textAlign: "right", marginLeft: "auto" }}>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** Kolor kanału ceny — tylko kropka / cienki pasek (pełne wypełnienia właściciel odrzucił:
 *  „szpitalne” i trudno było się w nich połapać). */
export type KanalCeny = "detal" | "hurt" | "allegro";
// Czerwień i zieleń są zajęte (minimalna / sugerowana), więc dropy/hurt dostają fiolet.
export const KOLOR_KANALU: Record<KanalCeny, string> = { detal: "var(--info)", hurt: "var(--anomaly)", allegro: "var(--warning)" };

/** Siatka kart cen: 4 w rzędzie (detal, detal, hurt, hurt), Allegro w rzędzie niżej;
 *  na węższym ekranie 2, na telefonie 1. */
export function SiatkaCen({ children }: { children: React.ReactNode }) {
  return (
    <div className="wyc-siatka" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
      <style>{`@media (max-width: 900px) { .wyc-siatka { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } }
        @media (max-width: 480px) { .wyc-siatka { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
      {children}
    </div>
  );
}

export function Kafel({ label, value, sub, tone = "neutral", dot }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  tone?: "neutral" | "critical" | "warning" | "info" | "ok" | "accent"; dot?: string;
}) {
  const color = { neutral: "var(--text-hi)", critical: "var(--critical)", warning: "var(--warning)", info: "var(--info)", ok: "var(--ok)", accent: "var(--accent)" }[tone];
  return (
    <div style={{ padding: "12px 14px", borderRadius: 10, minWidth: 0, background: "var(--bg)", border: "1px solid var(--border-soft)" }}>
      <div style={{ fontSize: 12, color: "var(--text-lo)", display: "flex", alignItems: "center", gap: 6 }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: 99, background: dot, flexShrink: 0 }} />}
        {label}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 600, color, lineHeight: 1.15, marginTop: 4, letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: "var(--text-mid)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ── Koszt towaru: jedna linia zamiast rzędu przycisków ───────
/** Koszt, od którego liczy kalkulator. Domyślnie ten, który wybrał serwer (FIFO → najbliższa →
 *  ostatnia dostawa), z opisem skąd jest; „zmień” pokazuje tylko to, co da się policzyć, plus
 *  własny koszt. Bez żadnej dostawy w aplikacji — od razu pole na koszt wpisany ręcznie. */
export function KosztTowaru({ koszty, baza, onBaza, wlasny, onWlasny, idPrefix, bezWlasnego }: {
  koszty: KosztBazy[];
  baza: BazaKosztu | "wlasna";
  onBaza: (b: BazaKosztu | "wlasna") => void;
  wlasny: string;
  onWlasny: (v: string) => void;
  idPrefix: string;
  /** Kalkulator handlowca: tylko koszty z aplikacji, bez wpisywania własnego. */
  bezWlasnego?: boolean;
}) {
  const wybrany = koszty.find((k) => k.baza === baza);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {baza === "wlasna" || !wybrany
          ? <Pole id={`${idPrefix}-wlasny`} value={wlasny} onChange={onWlasny} unit="zł" />
          : <span className="num" style={{ fontSize: 15, fontWeight: 600 }}>{zl2(wybrany.koszt)} zł</span>}
        {koszty.length + (bezWlasnego ? 0 : 1) > 1 && (
          <select aria-label="Zmień koszt" value={wybrany ? baza : "wlasna"} onChange={(e) => onBaza(e.target.value as BazaKosztu | "wlasna")}
            style={{ ...inp, padding: "4px 6px", fontSize: 12, color: "var(--text-mid)" }}>
            {koszty.map((k) => <option key={k.baza} value={k.baza}>{BAZA_KROTKO[k.baza]} · {zl2(k.koszt)} zł</option>)}
            {!bezWlasnego && <option value="wlasna">{BAZA_KROTKO.wlasna}</option>}
          </select>
        )}
      </div>
      <span style={{ fontSize: 11.5, color: wybrany?.szacunek ? "var(--warning)" : "var(--text-lo)" }}>
        {wybrany ? wybrany.opis
          : koszty.length ? "własny koszt netto / szt"
          : "brak dostaw w aplikacji — wpisz koszt netto / szt z kosztami importu"}
      </span>
    </div>
  );
}

// ── Drobne klocki ────────────────────────────────────────────
export function Pole({ id, value, onChange, unit, width = 86, disabled }: {
  id: string; value: string; onChange: (v: string) => void; unit: string; width?: number; disabled?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, opacity: disabled ? 0.6 : 1 }}>
      <input id={id} inputMode="decimal" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        style={{ width, padding: "6px 8px", fontSize: 13, background: "transparent", border: 0, color: "var(--text-hi)", outline: "none", textAlign: "right", fontFamily: "var(--font-mono)" }} />
      <span style={{ padding: "0 9px 0 2px", fontSize: 12, color: "var(--text-lo)" }}>{unit}</span>
    </span>
  );
}

export function Linia({ l, v, kolor, suma, wciecie }: { l: React.ReactNode; v: string; kolor?: string; suma?: boolean; wciecie?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5,
      color: suma ? "var(--text-hi)" : "var(--text-mid)", fontWeight: suma ? 600 : 400,
      ...(suma ? { borderTop: "1px solid var(--border)", paddingTop: 5, marginTop: 2 } : {}),
      ...(wciecie ? { paddingLeft: 12 } : {}),
    }}>
      <span style={{ minWidth: 0 }}>{l}</span><span className="num" style={{ color: kolor || "inherit", whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );
}

export function Wiersz({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="wyc-row" style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", alignItems: "start", gap: 10 }}>
      <style>{`@media (max-width: 640px) { .wyc-row { grid-template-columns: 1fr !important; gap: 6px !important; } }`}</style>
      <label htmlFor={htmlFor} style={{ fontSize: 12, color: "var(--text-lo)", paddingTop: 7 }}>{label}</label>
      {children}
    </div>
  );
}

/** Bezpieczny link do oferty — tylko http(s) (serwer i tak innych nie przyjmie). */
export const linkOk = (l: string | null | undefined) => !!l && /^https?:\/\//i.test(l);

export const kartaStyl: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: 16, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 };
export const rozpisStyl: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border-soft)", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 };
export const inp: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", fontSize: 13, color: "var(--text-hi)", font: "inherit", minWidth: 0 };
export const hint: React.CSSProperties = { fontSize: 11, color: "var(--text-lo)" };
export const small: React.CSSProperties = { fontSize: 12, color: "var(--text-lo)", fontWeight: 500 };
export const pill: React.CSSProperties = { display: "inline-flex", alignItems: "center", padding: "2px 8px", fontSize: 10.5, fontWeight: 600, borderRadius: 999, whiteSpace: "nowrap" };
export const okStyl = { background: "var(--ok-soft)", color: "var(--ok)" };
export const warnStyl = { background: "var(--warning-soft)", color: "var(--warning)" };
export const critStyl = { background: "var(--critical-soft)", color: "var(--critical)" };
export const infoStyl = { background: "var(--info-soft)", color: "var(--info)" };
export const note: React.CSSProperties = { display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--r-md)", fontSize: 12.5, color: "var(--text-mid)" };
export const noteWarn: React.CSSProperties = { ...note, background: "var(--warning-soft)", border: "1px solid color-mix(in oklch, var(--warning) 30%, transparent)" };
export const noteCrit: React.CSSProperties = { ...note, background: "var(--critical-soft)", border: "1px solid color-mix(in oklch, var(--critical) 35%, transparent)" };
export const noteInfo: React.CSSProperties = { ...note, background: "var(--info-soft)", border: "1px solid color-mix(in oklch, var(--info) 30%, transparent)" };
export const seg: React.CSSProperties = { display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 3, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 999 };
export const segBtn: React.CSSProperties = { border: 0, background: "transparent", color: "var(--text-lo)", font: "inherit", fontSize: 11.5, fontWeight: 600, padding: "4px 11px", borderRadius: 999, cursor: "pointer" };
export const segOn: React.CSSProperties = { background: "var(--accent)", color: "var(--accent-ink)" };
export const btnPri: React.CSSProperties = { background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--accent-ink)", font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "8px 14px", borderRadius: "var(--r-sm)", cursor: "pointer" };
export const btnSec: React.CSSProperties = { background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-mid)", font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "8px 14px", borderRadius: "var(--r-sm)", cursor: "pointer" };
export const btnX: React.CSSProperties = { background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-lo)", cursor: "pointer", height: 30, font: "inherit" };
export const btnDodaj: React.CSSProperties = { background: "none", border: "1px dashed var(--border)", borderRadius: "var(--r-sm)", color: "var(--text-mid)", font: "inherit", fontSize: 12.5, fontWeight: 600, padding: "7px 12px", cursor: "pointer", textAlign: "left" };
export const linkBtn: React.CSSProperties = { background: "none", border: 0, padding: 0, font: "inherit", fontSize: 12, color: "var(--info)", textDecoration: "underline", textUnderlineOffset: 3, cursor: "pointer" };
export const th: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-lo)", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
export const td: React.CSSProperties = { padding: "8px 10px", fontSize: 12.5, borderBottom: "1px solid var(--border-soft)", verticalAlign: "top" };
export const pusty: React.CSSProperties = { padding: 32, textAlign: "center", background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)", color: "var(--text-lo)", fontSize: 13 };
