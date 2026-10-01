"use client";
// ============================================================
// MAGAZYN — Stawka VAT produktu: wiersz w „Danych podstawowych", pod ceną zakupu netto.
//
// Automat: stawka z ostatniej krajowej sprzedaży tego SKU (Sellasist, 23/8/5%).
// Ręczna stawka wygrywa. Wybór pojawia się po kliknięciu „Edytuj" w karcie
// i zapisuje się od razu (osobny endpoint, niezależny od zapisu reszty karty).
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
  reczna: "(ręczna)",
  sprzedaz: "(z ostatniej sprzedaży)",
  domyslna: "(domyślna)",
};

export default function VatRow({ sku, shop, editing, rowStyle, labelStyle }: {
  sku: string; shop: string; editing: boolean;
  rowStyle: React.CSSProperties; labelStyle: React.CSSProperties;
}) {
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
      .catch(() => { /* wiersz zostaje z kreską — reszta karty działa */ });
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

  const rozjazd = v && v.vat_manual != null && v.vat_auto != null && v.vat_manual !== v.vat_auto;

  return (
    <>
      <div style={rowStyle}>
        <span style={labelStyle}>Stawka VAT</span>
        {!v ? (
          <span className="num" style={{ fontSize: 12, color: "var(--text-disabled)" }}>—</span>
        ) : editing && mozeEdytowac ? (
          <select value={v.vat_manual == null ? "auto" : String(v.vat_manual)} disabled={busy}
            onChange={(e) => ustaw(e.target.value === "auto" ? null : Number(e.target.value))}
            style={{ padding: "4px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text-hi)", outline: "none" }}>
            <option value="auto">Auto{v.vat_auto != null ? ` (${v.vat_auto}%)` : " (23%)"}</option>
            {STAWKI.map((s) => <option key={s} value={s}>{s}%</option>)}
          </select>
        ) : (
          <span className="num" style={{ fontSize: 12, color: "var(--text-mid)", fontWeight: 500 }}>
            {v.vat}%{" "}
            <span style={{ fontSize: 9, color: v.zrodlo === "reczna" ? "var(--accent)" : "var(--text-disabled)" }}>{OPIS[v.zrodlo]}</span>
          </span>
        )}
      </div>
      {rozjazd && (
        <div style={{ padding: "0 14px 6px", fontSize: 10, color: "var(--warning)", textAlign: "right" }}>
          w ostatniej sprzedaży {v.vat_auto}%
        </div>
      )}
    </>
  );
}
