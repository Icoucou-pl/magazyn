// ============================================================
// ROUTES — mapowanie adres URL ↔ widok aplikacji.
//
// Apka jest jedną stroną (app/[[...slug]]/page.tsx) i do tej pory widok
// siedział wyłącznie w useState. Efekt: historia przeglądarki miała jeden
// wpis, więc „wstecz" wyrzucało z aplikacji zamiast cofać o widok.
//
// Teraz źródłem prawdy jest adres. Zmiana widoku = router.push(ścieżka),
// a Next sam pilnuje historii — wstecz/dalej działają bez naszego kodu.
//
// Segmenty są po polsku (widać je w pasku i w linkach wysyłanych na Slacku),
// identyfikatory widoków zostają po angielsku, bo tak nazywa je NAV_ITEMS
// w components/header i cała reszta apki.
// ============================================================

export type Route = {
  view: string;
  sku: string | null;
  containerId: number | null;
};

// Segment adresu → identyfikator widoku.
const VIEW_BY_SEGMENT: Record<string, string> = {
  produkty: "products",
  kontenery: "containers",
  kalendarz: "calendar",
  cashflow: "cashflow",
  prognoza: "forecast",
  finanse: "finance",
  raporty: "reports",
  dropy: "dropy",
  ustawienia: "settings",
};

const SEGMENT_BY_VIEW: Record<string, string> = Object.fromEntries(
  Object.entries(VIEW_BY_SEGMENT).map(([segment, view]) => [view, segment]),
);

export const DEFAULT_VIEW = "dashboard";

/** Ścieżka dla widoku z menu. Dashboard siedzi na „/", reszta na swoim segmencie. */
export function pathForView(view: string): string {
  if (view === DEFAULT_VIEW) return "/";
  const segment = SEGMENT_BY_VIEW[view];
  return segment ? `/${segment}` : "/";
}

/**
 * Deep link do produktu. SKU bywa dziwne (podkreślenia, spacje, ukośniki
 * w starych indeksach), więc zawsze kodujemy — inaczej „A/B" zrobiłoby
 * z jednego SKU dwa segmenty ścieżki.
 */
export function pathForProduct(sku: string): string {
  return `/produkty/${encodeURIComponent(sku)}`;
}

export function pathForContainer(id: number): string {
  return `/kontenery/${id}`;
}

/**
 * Adres → widok. Nieznany segment nie jest błędem: lądujemy na dashboardzie,
 * tak samo jak przy wejściu na „/". Stare linki nie wywalają aplikacji.
 */
export function parsePath(pathname: string | null): Route {
  const pusty: Route = { view: DEFAULT_VIEW, sku: null, containerId: null };
  if (!pathname) return pusty;

  const segments = pathname.split("/").filter(Boolean);
  if (!segments.length) return pusty;

  const view = VIEW_BY_SEGMENT[segments[0]];
  if (!view) return pusty;

  const drugi = segments[1] ? decodeURIComponent(segments[1]) : null;

  if (view === "products") {
    return { view, sku: drugi, containerId: null };
  }
  if (view === "containers") {
    const id = drugi != null ? Number(drugi) : NaN;
    return { view, sku: null, containerId: Number.isFinite(id) ? id : null };
  }
  return { view, sku: null, containerId: null };
}
