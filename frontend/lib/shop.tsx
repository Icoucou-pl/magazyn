"use client";
// ============================================================
// MAGAZYN — globalny fragmentator firm (AMH / Acti / Veluxa / Wszyscy).
//
// JEDNO ŹRÓDŁO PRAWDY. Wcześniej każdy widok trzymał własny useState("amh"),
// przez co przełączenie firmy na Dashboardzie nie przenosiło się na Finanse,
// Kontenery itd. Teraz wybór siedzi tutaj, a widoki tylko go czytają.
//
// PERSYSTENCJA: localStorage — wybór przeżywa odświeżenie strony.
//
// KLAMRA POD company_scope (przyszłe uprawnienia firmowe):
//   `allowed` to jedyne miejsce, które trzeba będzie zmienić, gdy backend
//   zacznie zwracać `company_scope` na userze. Wszystko poniżej (setShop,
//   odczyt localStorage, przełącznik w Topbarze) już dziś przez tę klamrę
//   przechodzi, więc scoped user NIE MOŻE:
//     · ustawić firmy spoza swojego zakresu (setShop odrzuca),
//     · wejść na "" = wszystkie firmy (bo "" nie będzie w allowed),
//     · odziedziczyć cudzej firmy ze starego wpisu w localStorage (clamp przy starcie).
//   Frontend jest wtedy gotowy bez żadnej dodatkowej zmiany w widokach.
//   UWAGA: to nie zastępuje filtrowania po stronie backendu — jest jego lustrem.
// ============================================================

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ShopOption = { v: string; l: string };

// Kolejność zakładek — taka sama, jak była w widokach.
export const SHOP_OPTIONS: ShopOption[] = [
  { v: "amh", l: "AMH" },
  { v: "acti", l: "Acti" },
  { v: "veluxa", l: "Veluxa" },
  { v: "", l: "Wszyscy" },
];

const STORAGE_KEY = "magazyn_shop";
const DEFAULT_SHOP = "amh";

type ShopContextValue = {
  shop: string;                 // "" = wszystkie firmy
  setShop: (v: string) => void; // klamrowane do `allowed`
  allowed: string[];            // dozwolone wartości (dziś: wszystkie)
  options: ShopOption[];        // opcje do wyrysowania w przełączniku
  locked: boolean;              // true → user ma dostęp do jednej firmy (brak przełącznika)
};

const ShopContext = createContext<ShopContextValue | null>(null);

// Zakres firm dla usera. Dziś company_scope nie przychodzi z backendu (undefined),
// więc allowed = wszystko = obecne zachowanie. Gdy zacznie przychodzić — zawęża się samo.
function computeAllowed(companyScope?: string | null): string[] {
  const scope = (companyScope || "").trim().toLowerCase();
  if (scope) return [scope];
  return SHOP_OPTIONS.map((o) => o.v);
}

export function ShopProvider({
  companyScope,
  children,
}: {
  companyScope?: string | null;
  children: React.ReactNode;
}) {
  const allowed = useMemo(() => computeAllowed(companyScope), [companyScope]);
  const allowedKey = allowed.join("|");

  // Start: zapamiętany wybór, o ile mieści się w zakresie. Inaczej AMH, a jak
  // i AMH poza zakresem (scoped user) — pierwsza dozwolona firma.
  const [shop, setShopState] = useState<string>(() => {
    const fallback = allowed.includes(DEFAULT_SHOP) ? DEFAULT_SHOP : allowed[0];
    if (typeof window === "undefined") return fallback;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      // "" jest poprawną wartością (Wszyscy), więc porównujemy z null, nie falsy.
      if (saved !== null && allowed.includes(saved)) return saved;
    } catch { /* tryb prywatny / brak quota — lecimy na domyślnej */ }
    return fallback;
  });

  const setShop = useCallback((v: string) => {
    const next = allowed.includes(v) ? v : allowed[0];
    setShopState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* ignorujemy */ }
  }, [allowedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zmiana zakresu w trakcie sesji (przelogowanie, nadanie company_scope) —
  // jeśli bieżąca firma wypadła z zakresu, cofamy do pierwszej dozwolonej.
  useEffect(() => {
    if (!allowed.includes(shop)) setShop(allowed[0]);
  }, [allowedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo<ShopContextValue>(() => ({
    shop,
    setShop,
    allowed,
    options: SHOP_OPTIONS.filter((o) => allowed.includes(o.v)),
    locked: allowed.length <= 1,
  }), [shop, setShop, allowed]);

  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

// Hook dla widoków. Poza providerem (np. w testach) zwraca bezpieczną atrapę
// na AMH — komponent się wyrenderuje zamiast wywalić całą stronę.
export function useShop(): ShopContextValue {
  const ctx = useContext(ShopContext);
  if (ctx) return ctx;
  return {
    shop: DEFAULT_SHOP,
    setShop: () => { /* brak providera — nic nie robimy */ },
    allowed: SHOP_OPTIONS.map((o) => o.v),
    options: SHOP_OPTIONS,
    locked: false,
  };
}

// Raporty jadą na własnej konwencji: "all" zamiast "" dla wszystkich firm.
// Mapowanie trzymamy tutaj, żeby nie rozłazić się po widokach.
export function shopToScope(shop: string): string {
  return shop === "" ? "all" : shop;
}

// ── Przełącznik do Topbara ───────────────────────────────────
// Styl 1:1 z dotychczasowymi zakładkami w widokach (surface-2 / surface-3).
export function ShopSwitcher() {
  const { shop, setShop, options, locked } = useShop();

  // Jedna firma = nie ma czego przełączać. Pokazujemy plakietkę, żeby user
  // wiedział, czyje dane ogląda (przyszły scoped viewer).
  if (locked) {
    const only = options[0];
    return (
      <div style={{
        display: "inline-flex", alignItems: "center", flexShrink: 0,
        padding: "6px 12px", borderRadius: 8,
        background: "var(--surface-2)", border: "1px solid var(--border)",
        fontSize: 12, fontWeight: 600, color: "var(--text-hi)", whiteSpace: "nowrap",
      }} title="Twoje konto ma dostęp do jednej firmy">
        {only?.l ?? "—"}
      </div>
    );
  }

  return (
    <div style={{
      display: "inline-flex", gap: 2, padding: 3, flexShrink: 0,
      background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8,
    }}>
      {options.map((s) => {
        const active = shop === s.v;
        return (
          <button
            key={s.v || "all"}
            onClick={() => setShop(s.v)}
            title={s.v ? `Pokaż dane firmy ${s.l}` : "Pokaż dane wszystkich firm"}
            style={{
              padding: "5px 14px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer",
              background: active ? "var(--surface-3)" : "transparent",
              color: active ? "var(--text-hi)" : "var(--text-mid)",
              border: "none", whiteSpace: "nowrap",
            }}
          >{s.l}</button>
        );
      })}
    </div>
  );
}
