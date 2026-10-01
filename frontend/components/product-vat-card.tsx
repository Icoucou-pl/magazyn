"use client";
// ============================================================
// MAGAZYN — Stawka VAT produktu (zakładka Dane na pełnej karcie).
//
// Automat: stawka z ostatniej krajowej sprzedaży tego SKU (Sellasist, 23/8/5%).
// Ręczna stawka wygrywa — klik w stawkę zapisuje od razu, „Auto" wraca do automatu.
// Z tej stawki korzysta kalkulator w zakładce „Cena" (netto → brutto).
// Dane: GET/PUT /products/{sku}/vat (routers/products.py, services/cena.py → vat_produktu).
// ============================================================

import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { can, useUser } from "@/lib/permissions";

type Vat = { vat: number; zrodlo: "reczna" | "sprzedaz" | "domyslna"; vat_auto: number | null; vat_manual: number | null };

const STAWKI = [23, 8, 5, 0];
const OPIS: Record<Vat["zrodlo"], string> = {
  reczna: "ustawiona ręcznie",
  sprzedaz: "z ostatniej krajowej sprzedaży",
  domyslna: "domyślna — produkt nie sprzedawał się jeszcze w Polsce",
};

export default function VatCard({ sku, shop }: { sku: string; shop: string }) {
  const user = useUser();
  const mozeEdytowac = can(user, "editProducts");
  const klucz = `${sku}|${shop}`;
  const [stan, setStan] = useState<{ klucz: string; v: Vat } | null>(null);
  const [busy, setBusy] = useState(false);
  const v = stan?.klucz === klucz ? stan.v : null;
  const q = shop ? `?shop=${encodeURIComponent(shop)}` : "";

  useEffect(() => {
    let alive = true;
    api.get(`/products/${encodeURIComponent(sku)}/vat${q}`)
      .then((d) => { if (alive) setStan({ klucz: `${sku}|${shop}`, v: d as Vat }); })
      .catch(() => { /* karta zostaje na szkielecie — reszta zakładki działa */ });
    return () => { alive = false; };
  }, [sku, shop, q]);

  const ustaw = async (vat: number | null) => {
    if (busy || !v || vat === v.vat_manual) return;
    setBusy(true);
    try {
      const d = (await api.put(`/products/${encodeURIComponent(sku)}/vat${q}`, { vat })) as Vat;
      setStan({ klucz, v: d });
      toast(vat == null ? `VAT wraca do automatu: ${d.vat}%` : `Ustawiono VAT ${vat}%`, "ok");
    } catch {
      toast("Nie udało się zapisać stawki VAT", "warning");
    } finally {
      setBusy(false);
    }
  };

  const chip = (on: boolean): React.CSSProperties => ({
    border: 0, font: "inherit", fontSize: 11.5, fontWeight: 600, padding: "4px 11px", borderRadius: 999,
    cursor: mozeEdytowac && !busy ? "pointer" : "default",
    background: on ? "var(--accent)" : "transparent", color: on ? "var(--accent-ink)" : "var(--text-lo)",
  });

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-mid)" }}>Stawka VAT</span>
      </div>
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {!v ? (
          <div className="pulse-soft" style={{ height: 44, background: "var(--surface-2)", borderRadius: 8 }} />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span className="num" style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>{v.vat}%</span>
              <span style={{ fontSize: 11.5, color: v.zrodlo === "reczna" ? "var(--accent)" : "var(--text-lo)" }}>{OPIS[v.zrodlo]}</span>
            </div>
            {mozeEdytowac && (
              <div role="group" aria-label="Stawka VAT" style={{ display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 3, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 999, alignSelf: "flex-start" }}>
                <button disabled={busy} onClick={() => ustaw(null)} style={chip(v.vat_manual == null)}
                  title="Stawka z ostatniej krajowej sprzedaży">
                  Auto{v.vat_auto != null ? ` (${v.vat_auto}%)` : ""}
                </button>
                {STAWKI.map((s) => (
                  <button key={s} disabled={busy} onClick={() => ustaw(s)} style={chip(v.vat_manual === s)}>{s}%</button>
                ))}
              </div>
            )}
            {v.vat_manual != null && v.vat_auto != null && v.vat_manual !== v.vat_auto && (
              <div style={{ fontSize: 11.5, padding: "6px 9px", borderRadius: 6, background: "var(--warning-soft)", color: "var(--warning)" }}>
                W ostatniej sprzedaży produkt szedł z VAT {v.vat_auto}%, a ręcznie ustawiono {v.vat_manual}%.
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--text-lo)" }}>Z tej stawki liczy kalkulator w zakładce „Cena”.</div>
          </>
        )}
      </div>
    </div>
  );
}
