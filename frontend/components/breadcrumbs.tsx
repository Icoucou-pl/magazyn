"use client";
// ============================================================
// MAGAZYN — Breadcrumb „po sznurku" (components/breadcrumbs.tsx).
//
// Breadcrumb pokazuje DROGĘ, którą użytkownik przyszedł, a nie sztywną
// hierarchię: Produkty › D2k › Anji › A2-1cz. Adresy zostają płaskie
// (/produkty/SKU, /producenci/Nazwa), a sam sznurek siedzi w history.state
// wpisu historii (patrz app-shell). Dzięki temu:
//   • wstecz/dalej i odświeżenie odtwarzają sznurek — przeglądarka pamięta
//     state każdego wpisu sama,
//   • link wklejony na Slacku nie ma historii → dostaje domyślny sznurek
//     (Produkty › SKU albo Producenci › Nazwa).
//
// Pętle: wejście w coś, co już jest w sznurku (Anji › A2-1cz › Anji), przycina
// sznurek do tego miejsca zamiast go wydłużać (extendTrail).
// Długi sznurek: środek zwija się do „…" (MAX_WIDOCZNYCH).
// ============================================================

import React from "react";

export type Crumb = {
  label: string;
  /** Ścieżka BEZ query (?tab=) — po niej porównujemy ogniwa. */
  path: string;
  /** SKU i numery pokazujemy monospace, nazwy zwykłym krojem. */
  mono?: boolean;
};

export type Trail = Crumb[];

const MAX_WIDOCZNYCH = 5;

/** Ścieżka bez query i hasha — ?tab= nie tworzy nowego ogniwa. */
export function bareFrom(path: string): string {
  const i = path.search(/[?#]/);
  return i === -1 ? path : path.slice(0, i);
}

/** Porównanie ścieżek odporne na kodowanie (%20 vs spacja) i query. */
export function samePath(a: string, b: string): boolean {
  const d = (x: string) => { try { return decodeURIComponent(bareFrom(x)); } catch { return bareFrom(x); } };
  return d(a) === d(b);
}

/** Nowy sznurek po przejściu z `trail` do `next`. Ogniwo już obecne = przycięcie. */
export function extendTrail(trail: Trail, next: Crumb): Trail {
  const target = bareFrom(next.path);
  const idx = trail.findIndex((c) => samePath(c.path, target));
  if (idx >= 0) return trail.slice(0, idx + 1);
  return [...trail, { ...next, path: target }];
}

/** Sznurek z history.state, o ile pasuje do bieżącego adresu (ostatnie ogniwo = tu). */
export function trailFromState(state: unknown, pathname: string): Trail | null {
  const t = (state as { trail?: unknown } | null)?.trail;
  if (!Array.isArray(t) || t.length === 0) return null;
  const ok = t.every((c) => c && typeof c.label === "string" && typeof c.path === "string");
  if (!ok) return null;
  const last = t[t.length - 1] as Crumb;
  return samePath(last.path, pathname) ? (t as Trail) : null;
}

export default function Breadcrumbs({ trail, onNavigate }: {
  trail: Trail;
  /** Klik w ogniwo `i` (nigdy w ostatnie — to bieżąca strona). */
  onNavigate: (index: number) => void;
}) {
  // Zwijanie: pierwsze ogniwo + „…" + trzy ostatnie. Indeksy zostają oryginalne,
  // więc klik w widoczne ogniwo przycina sznurek dokładnie tam, gdzie trzeba.
  type Item = { kind: "crumb"; crumb: Crumb; index: number } | { kind: "gap"; hidden: Crumb[] };
  const items: Item[] = trail.length > MAX_WIDOCZNYCH
    ? [
        { kind: "crumb", crumb: trail[0], index: 0 },
        { kind: "gap", hidden: trail.slice(1, trail.length - 3) },
        ...trail.slice(-3).map((crumb, k) => ({ kind: "crumb" as const, crumb, index: trail.length - 3 + k })),
      ]
    : trail.map((crumb, index) => ({ kind: "crumb" as const, crumb, index }));

  return (
    <nav aria-label="Ścieżka" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-disabled)", minWidth: 0, flexWrap: "wrap" }}>
      {items.map((it, k) => {
        const sep = k > 0 ? <span aria-hidden style={{ flexShrink: 0 }}>›</span> : null;
        if (it.kind === "gap") {
          return (
            <React.Fragment key={`gap-${k}`}>
              {sep}
              <span title={it.hidden.map((c) => c.label).join(" › ")} style={{ cursor: "default" }}>…</span>
            </React.Fragment>
          );
        }
        const last = it.index === trail.length - 1;
        const { crumb } = it;
        return (
          <React.Fragment key={`${it.index}-${crumb.path}`}>
            {sep}
            {last ? (
              <span className={crumb.mono ? "mono" : undefined} aria-current="page" style={{
                color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260,
              }}>{crumb.label}</span>
            ) : (
              <button onClick={() => onNavigate(it.index)} className={crumb.mono ? "mono" : undefined}
                // font-family tylko dla nazw — przy SKU krój daje klasa .mono,
                // a styl inline z `font: inherit` by ją przykrył.
                style={{ ...crumbBtn, fontFamily: crumb.mono ? undefined : "inherit" }}>
                {crumb.label}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

const crumbBtn: React.CSSProperties = {
  background: "none", border: 0, padding: 0, fontSize: 12, fontWeight: 400, lineHeight: "inherit",
  color: "var(--text-mid)", cursor: "pointer", whiteSpace: "nowrap",
  maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis",
};
