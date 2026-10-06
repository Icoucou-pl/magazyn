"use client";
// ============================================================
// MAGAZYN — Koszt z kontenerów w „Danych podstawowych", pod ceną zakupu netto.
//
// Dwa wiersze TYLKO DO ODCZYTU: koszt FIFO i średnia ważona z kontenerów na stanie —
// te same liczby co zakładka „Cena" i nagłówek karty. Nie da się ich wpisać ręcznie:
// wynikają z kosztu jednostkowego kontenerów (karta kontenera i płatności).
// Dane: GET /products/{sku}/koszt (routers/cena.py). Widzi je ten, kto widzi cenę
// zakupu (finanse ALBO „Cena zakupu produktu") — reszta dostaje kropki.
// ============================================================

import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { canSeePurchasePrice, useUser } from "@/lib/permissions";
import { fmtNum } from "@/lib/format";

type Koszt = { fifo: number | null; srednia: number | null };

export default function KosztRows({ sku, shop, rowStyle, labelStyle }: {
  sku: string; shop: string;
  rowStyle: React.CSSProperties; labelStyle: React.CSSProperties;
}) {
  const widzi = canSeePurchasePrice(useUser());
  const klucz = `${sku}|${shop}`;
  // Klucz przy wyniku: po zmianie SKU albo firmy stara liczba przestaje pasować.
  const [stan, setStan] = useState<{ klucz: string; k: Koszt } | null>(null);
  const k = stan?.klucz === klucz ? stan.k : null;

  useEffect(() => {
    if (!widzi) return;
    let alive = true;
    api.get(`/products/${encodeURIComponent(sku)}/koszt${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`)
      .then((d) => { if (alive) setStan({ klucz: `${sku}|${shop}`, k: d as Koszt }); })
      .catch(() => { /* wiersze zostają z kreską — reszta karty działa */ });
    return () => { alive = false; };
  }, [sku, shop, widzi]);

  const wartosc = (v: number | null | undefined, brak: string) => (
    !widzi ? <span className="num" style={{ fontSize: 12, color: "var(--text-mid)", fontWeight: 500 }}>•••••</span>
      : v != null ? (
        <span className="num" style={{ fontSize: 12, color: "var(--text-mid)", fontWeight: 500 }}>
          {fmtNum(v)} zł <span style={{ fontSize: 9, color: "var(--text-disabled)" }}>(z kontenerów)</span>
        </span>
      ) : <span className="num" style={{ fontSize: 12, color: "var(--text-disabled)" }} title={k ? brak : undefined}>—</span>
  );

  return (
    <>
      <div style={rowStyle}>
        <span style={labelStyle}>Cena FIFO</span>
        {wartosc(k?.fifo, "Brak towaru na stanie z kontenerów w aplikacji")}
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Cena średnia ważona</span>
        {wartosc(k?.srednia, "Brak kontenerów z pewnym kosztem (bez szacunku), z których towar jest na stanie")}
      </div>
    </>
  );
}
