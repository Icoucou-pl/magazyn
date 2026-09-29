"use client";
// ============================================================
// MAGAZYN — Pełna karta producenta (/producenci/Nazwa).
//
// Wchodzi się na nią z chipa producenta na karcie produktu (Produkty › D2k › Anji).
// Pozostałe wejścia — Ustawienia, Kontenery, Prognoza, lista Produktów — dalej
// otwierają modal, bo tam użytkownik jest w stosie okien i nie chcemy go wybijać.
//
// Treść to ManufacturerModal w trybie "page": te same KPI, sezon, produkty
// i kontenery, policzone tym samym kodem. Klik w produkt → pełna karta produktu
// (sznurek rośnie: … › Anji › A2-1cz), klik w kontener → pełna karta kontenera
// (… › Anji › #MSDU6911513).
//
// W adresie jest NAZWA producenta. Szukamy jej bez względu na wielkość liter
// i spacje na brzegach, żeby ręcznie wpisany /producenci/anji też trafiał.
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import ManufacturerModal from "./manufacturer-modal";
import Breadcrumbs, { type Trail } from "./breadcrumbs";
import type { Manufacturer } from "./products-ui";
import type { Container } from "./containers-ui";
import { api } from "@/lib/api";
import { can, useUser } from "@/lib/permissions";

const norm = (s: string) => s.trim().toLocaleLowerCase("pl-PL");

export default function ManufacturerPage({
  name, trail, onCrumb, onOpenProduct, onOpenContainer, onBackToList,
}: {
  /** Nazwa z adresu (już zdekodowana). */
  name: string;
  trail: Trail;
  onCrumb: (index: number) => void;
  onOpenProduct: (sku: string) => void;
  /** Klik w kontener na liście → pełna karta kontenera. */
  onOpenContainer?: (c: Container) => void;
  /** Ustawienia → Producenci — przycisk przy „nie znaleziono". */
  onBackToList: () => void;
}) {
  const user = useUser();
  const showFin = can(user, "viewFinancials");
  const [manufacturers, setManufacturers] = useState<Manufacturer[] | null>(null);
  const [blad, setBlad] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get("/manufacturers")
      .then((d) => { if (alive) setManufacturers((d as Manufacturer[]) || []); })
      .catch(() => { if (alive) { setBlad(true); setManufacturers([]); } });
    return () => { alive = false; };
  }, []);

  const mfr = useMemo(() => {
    if (!manufacturers) return null;
    const n = norm(name);
    return manufacturers.find((m) => norm(m.name) === n) ?? null;
  }, [manufacturers, name]);

  const pasek = (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 12, minHeight: 28 }}>
      <Breadcrumbs trail={trail} onNavigate={onCrumb} />
    </div>
  );

  if (!manufacturers) {
    return (
      <div className="fade-in">
        {pasek}
        <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ height: 78, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)" }} />
          <div style={{ height: 90, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />
          <div style={{ height: 220, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />
        </div>
      </div>
    );
  }

  if (!mfr) {
    return (
      <div className="fade-in">
        {pasek}
        <div style={{ padding: 48, textAlign: "center", background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)" }}>{name}</div>
          <p style={{ color: "var(--text-lo)", fontSize: 13, margin: "8px 0 16px" }}>
            {blad ? "Nie udało się wczytać listy producentów." : "Nie ma producenta o tej nazwie — mógł zostać przemianowany."}
          </p>
          <button onClick={onBackToList} style={backBtn}>Lista producentów</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {pasek}
      <ManufacturerModal
        key={mfr.id}
        variant="page"
        mfr={mfr}
        manufacturers={manufacturers}
        showFin={showFin}
        onClose={() => { /* strona — nie ma czego zamykać */ }}
        onOpenProduct={onOpenProduct}
        onOpenContainer={onOpenContainer}
      />
    </div>
  );
}

const backBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  background: "var(--surface-1)", border: "1px solid var(--border-soft)", color: "var(--text-mid)",
  font: "inherit", fontSize: 12.5, padding: "6px 12px", borderRadius: "var(--r-sm)", cursor: "pointer",
};
