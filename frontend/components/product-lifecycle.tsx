"use client";
// ============================================================
// MAGAZYN — Zakładka „Życie produktu”.
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

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/format";

// ── Typy odpowiedzi API ──────────────────────────────────────
export type Przyjecie = {
  data: string; typ: string; magazyn_id: number; magazyn_zrodlowy: number | null;
  ilosc: number; koszt_jednostkowy: number | null; cena_waluta: number | null;
  kurs: number | null; towar_pln: number | null; logistyka_pln: number | null;
  skorygowane: boolean; dokument: string | null; numer_dokumentu: string | null;
  dostawca: string | null;
};
export type PunktStanu = {
  miesiac: string; przyjeto: number; wydano: number; stan: number;
  koszt_wlasny: number | null;
};
export type Dostawca = {
  nazwa: string; przyjec: number; ilosc: number; od: string; do: string;
  sredni_koszt: number | null;
};
export type Historia = {
  sku: string; stan_dzis: number; pierwsze_przyjecie: string | null;
  liczba_zakupow: number; sprowadzono_szt: number; sprowadzono_pln: number;
  przyjecia: Przyjecie[]; stan_miesiecznie: PunktStanu[];
  dostawcy: Dostawca[]; miesiace_bez_pokrycia: string[]; dryf: number;
};

// ── Pomocnicze ───────────────────────────────────────────────
const fmtD = (s: string) => { const [y, m, d] = s.split("-"); return `${d}.${m}.${y}`; };
const fmtM = (s: string) => { const [y, m] = s.split("-"); return `${m}.${y.slice(2)}`; };
const fmtC = (n: number, d = 2) =>
  n.toLocaleString("pl-PL", { minimumFractionDigits: d, maximumFractionDigits: d });

const MIES = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];

// Kolory dostawców — stabilne, przypisywane po kolejności pierwszego zakupu.
const PALETA = ["var(--accent)", "var(--anomaly)", "var(--info)", "var(--ok)", "var(--warning)"];

const sect: React.CSSProperties = { marginBottom: 22 };
const sectHead: React.CSSProperties = {
  display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap",
};
const sectTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
  textTransform: "uppercase", color: "var(--text-mid)",
};
const sectHint: React.CSSProperties = { fontSize: 11, color: "var(--text-lo)" };
const box: React.CSSProperties = {
  background: "var(--surface-1)", border: "1px solid var(--border-soft)",
  borderRadius: 12, overflow: "hidden",
};
const note: React.CSSProperties = {
  fontSize: 10.5, color: "var(--text-disabled)", lineHeight: 1.55, marginTop: 8,
};

type Tip = { x: number; y: number; html: React.ReactNode } | null;

// ============================================================
export default function LifecycleTab({ sku, showFin }: { sku: string; showFin: boolean }) {
  const [h, setH] = useState<Historia | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setH(null); setErr(false);
    api.get(`/products/${encodeURIComponent(sku)}/historia`)
      .then((d) => { if (alive) setH(d as Historia); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [sku]);

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
      <TabelaPrzyjec h={h} />
    </div>
  );
}

// ── Pasek podsumowania ───────────────────────────────────────
function Podsumowanie({ h, showFin }: { h: Historia; showFin: boolean }) {
  const wiek = useMemo(() => {
    if (!h.pierwsze_przyjecie) return "—";
    const od = new Date(h.pierwsze_przyjecie);
    const m = Math.round((Date.now() - od.getTime()) / 86400000 / 30.44);
    const lata = Math.floor(m / 12);
    return lata > 0 ? `${lata} l. ${m % 12} mies.` : `${m} mies.`;
  }, [h.pierwsze_przyjecie]);

  const zmianaKosztu = useMemo(() => {
    const z = h.przyjecia.filter((p) => p.typ === "ZAKUP" && p.koszt_jednostkowy != null);
    if (z.length < 2) return null;
    const a = z[0].koszt_jednostkowy as number;
    const b = z[z.length - 1].koszt_jednostkowy as number;
    return ((b / a) - 1) * 100;
  }, [h.przyjecia]);

  const pola: [React.ReactNode, string][] = [
    [wiek, h.pierwsze_przyjecie ? `w ofercie od<br>${fmtD(h.pierwsze_przyjecie)}` : "brak przyjęć"],
    [`${h.liczba_zakupow} dostaw`, "wejść z zewnątrz"],
    [`${fmtNum(h.sprowadzono_szt)} szt`, showFin ? `sprowadzono łącznie<br>${fmtNum(h.sprowadzono_pln)} zł` : "sprowadzono łącznie"],
    [`${fmtNum(h.stan_dzis)} szt`, "na stanie dziś"],
    [
      zmianaKosztu == null ? "—" : (
        <span style={{ color: zmianaKosztu > 0 ? "var(--critical)" : "var(--ok)" }}>
          {zmianaKosztu > 0 ? "+" : ""}{fmtC(zmianaKosztu, 1)}%
        </span>
      ),
      "koszt: pierwsza<br>vs ostatnia dostawa",
    ],
  ];

  return (
    <div style={{ ...box, padding: "14px 16px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))", gap: 14, ...sect }}>
      {pola.map(([v, l], i) => (
        <div key={i} style={i > 0 ? { borderLeft: "1px solid var(--border-soft)", paddingLeft: 14 } : undefined}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>{v}</div>
          <div style={{ fontSize: 10.5, color: "var(--text-lo)", marginTop: 3, lineHeight: 1.35 }}
               dangerouslySetInnerHTML={{ __html: l }} />
        </div>
      ))}
    </div>
  );
}

// ── Krzywa ceny zakupu ───────────────────────────────────────
type TrybCeny = "pln" | "waluta" | "split";

function KrzywaCeny({ h }: { h: Historia }) {
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

  const W = 700, H = 240, L = 52, R = 16, T = 22, B = 34;
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
            {[...lata].map((y) => {
              const t = new Date(`${y}-01-01`).getTime();
              if (t < t0 || t > t1) return null;
              return (
                <g key={y}>
                  <line x1={X(t)} x2={X(t)} y1={T} y2={H - B} stroke="var(--border-soft)" strokeWidth={1} strokeDasharray="2 4" />
                  <text x={X(t) + 4} y={H - B + 14} fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">{y}</text>
                </g>
              );
            })}

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

// ── Krzywa stanu ─────────────────────────────────────────────
function KrzywaStanu({ h }: { h: Historia }) {
  const [tip, setTip] = useState<Tip>(null);

  const pkt = h.stan_miesiecznie;
  if (pkt.length < 2) return null;

  // Dostawy (typ ZAKUP) w rozbiciu na miesiące — TYLKO one dostają kropkę.
  // Zwroty siedzą w `przyjeto`, ale rysowane jako dostawa myliłyby.
  const dostawy = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of h.przyjecia) {
      if (p.typ !== "ZAKUP") continue;
      const k = p.data.slice(0, 7);
      m.set(k, (m.get(k) || 0) + p.ilosc);
    }
    return m;
  }, [h.przyjecia]);

  const bezPokrycia = useMemo(
    () => new Set(h.miesiace_bez_pokrycia.map((d) => d.slice(0, 7))),
    [h.miesiace_bez_pokrycia],
  );

  const W = 700, H = 250, L = 50, R = 14, T = 20, B = 34;
  const maxS = Math.max(...pkt.map((p) => p.stan), 1) * 1.12;
  const X = (i: number) => L + (i / (pkt.length - 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - v / maxS) * (H - T - B);
  const krok = (W - L - R) / (pkt.length - 1);

  const linia = pkt.map((p, i) => `${i ? "L" : "M"}${X(i)} ${Y(p.stan)}`).join(" ");
  const najnizszy = pkt.reduce((a, b) => (b.stan < a.stan ? b : a));

  return (
    <div style={sect}>
      <div style={sectHead}>
        <span style={sectTitle}>Stan magazynu w czasie</span>
        <span style={sectHint}>odtworzony z ruchów, zakotwiczony na dzisiejszym stanie</span>
      </div>

      <div style={box}>
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: H }}>
            {[0, 1, 2, 3].map((i) => {
              const v = (maxS * i) / 3, y = Y(v);
              return (
                <g key={i}>
                  <line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
                  <text x={L - 8} y={y + 3.5} textAnchor="end" fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">{fmtNum(v)}</text>
                </g>
              );
            })}
            {pkt.map((p, i) => p.miesiac.slice(5, 7) === "01" ? (
              <g key={p.miesiac}>
                <line x1={X(i)} x2={X(i)} y1={T} y2={H - B} stroke="var(--border-soft)" strokeWidth={1} strokeDasharray="2 4" />
                <text x={X(i) + 4} y={H - B + 14} fill="var(--text-disabled)" fontSize={10} fontFamily="var(--font-mono)">{p.miesiac.slice(0, 4)}</text>
              </g>
            ) : null)}

            {pkt.map((p, i) => bezPokrycia.has(p.miesiac.slice(0, 7)) ? (
              <rect key={`r${i}`} x={X(i) - krok / 2} y={T} width={krok} height={H - T - B}
                    fill="var(--critical-soft)" stroke="var(--critical)" strokeWidth={1} />
            ) : null)}

            <path d={`${linia} L${X(pkt.length - 1)} ${Y(0)} L${X(0)} ${Y(0)} Z`} fill="var(--accent-soft)" />
            <path d={linia} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />

            {pkt.map((p, i) => {
              const q = dostawy.get(p.miesiac.slice(0, 7)) || 0;
              return q > 0 ? (
                <circle key={`d${i}`} cx={X(i)} cy={Y(p.stan)} r={4} fill="var(--info)" stroke="var(--bg)" strokeWidth={1.5} />
              ) : null;
            })}

            {pkt.map((p, i) => {
              const q = dostawy.get(p.miesiac.slice(0, 7)) || 0;
              const zwroty = Math.max(0, p.przyjeto - q);
              const [y, m] = p.miesiac.split("-");
              return (
                <rect key={`h${i}`} x={X(i) - krok / 2} y={T} width={krok} height={H - T - B} fill="transparent"
                  style={{ cursor: "pointer" }}
                  onMouseMove={(e) => setTip({
                    x: e.clientX, y: e.clientY,
                    html: (
                      <>
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-lo)", marginBottom: 3 }}>
                          {MIES[Number(m) - 1]} {y}
                        </div>
                        <div><b>stan {fmtNum(p.stan)} szt</b></div>
                        {q > 0 && <div style={{ color: "var(--info)", marginTop: 3 }}>dostawa {fmtNum(q)} szt</div>}
                        <div style={{ color: "var(--text-mid)" }}>sprzedaż {fmtNum(p.wydano)} szt</div>
                        {zwroty > 0 && <div style={{ color: "var(--text-lo)" }}>zwroty {fmtNum(zwroty)} szt</div>}
                        {p.wydano > 0 && (
                          <div style={{ color: p.stan < p.wydano ? "var(--critical)" : "var(--text-lo)", marginTop: 3 }}>
                            zapas na {fmtC(p.stan / p.wydano, 1)} mies.
                          </div>
                        )}
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
            <span style={{ width: 10, height: 2, background: "var(--accent)" }} />stan na koniec miesiąca
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 99, background: "var(--info)" }} />dostawa
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 8, background: "var(--critical-soft)", border: "1px solid var(--critical)" }} />zapas poniżej miesięcznej sprzedaży
          </span>
        </div>
      </div>

      {bezPokrycia.size > 0 && (
        <div style={note}>
          Najniższy stan: <b style={{ color: "var(--critical)" }}>{fmtNum(najnizszy.stan)} szt</b> na koniec {fmtM(najnizszy.miesiac)}.
          {" "}Miesięcy z zapasem poniżej własnej sprzedaży: {bezPokrycia.size}. Rozdzielczość jest miesięczna,
          więc krótsza przerwa w środku miesiąca może tu nie być widoczna.
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

// ── Tabela przyjęć ───────────────────────────────────────────
function TabelaPrzyjec({ h }: { h: Historia }) {
  const [wszystkie, setWszystkie] = useState(false);

  const wiersze = useMemo(() => {
    const p = wszystkie ? h.przyjecia : h.przyjecia.filter((x) => x.typ === "ZAKUP");
    return [...p].reverse();
  }, [h.przyjecia, wszystkie]);

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
        <span style={sectTitle}>Przyjęcia</span>
        <span style={sectHint}>{wiersze.length} pozycji · od najnowszej</span>
        <button onClick={() => setWszystkie((v) => !v)}
          style={{ marginLeft: "auto", background: "none", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 5, fontSize: 11, padding: "3px 9px", cursor: "pointer" }}>
          {wszystkie ? "Tylko zakupy" : "Pokaż zwroty i przesunięcia"}
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
function Tooltip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement | null>(null);
  if (!tip) return null;
  const w = ref.current?.offsetWidth ?? 200;
  const hh = ref.current?.offsetHeight ?? 80;
  const x = tip.x + 14 + w > window.innerWidth - 8 ? tip.x - w - 14 : tip.x + 14;
  const y = tip.y - hh - 10 < 8 ? tip.y + 16 : tip.y - hh - 10;
  return (
    <div ref={ref} style={{
      position: "fixed", left: x, top: y, zIndex: 200, pointerEvents: "none",
      background: "var(--surface-2)", border: "1px solid var(--border-strong)",
      borderRadius: 8, padding: "8px 10px", fontSize: 11.5, maxWidth: 260,
      boxShadow: "0 8px 24px oklch(0 0 0 / .5)",
    }}>{tip.html}</div>
  );
}
