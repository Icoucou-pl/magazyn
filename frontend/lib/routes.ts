// ============================================================
// ROUTES — mapowanie adres URL ↔ widok aplikacji.
//
// Apka jest jedną stroną (app/[[...slug]]/page.tsx) i do tej pory widok
// siedział wyłącznie w useState. Efekt: historia przeglądarki miała jeden
// wpis, więc „wstecz" wyrzucało z aplikacji zamiast cofać o widok.
//
// Teraz źródłem prawdy jest adres. Zmiana widoku = history.pushState(ścieżka) (components/app-shell),
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
  /** Karta producenta (/producenci/Nazwa) — nazwa tak, jak stoi w adresie. */
  mfrName: string | null;
  /** Podsekcja Ustawień z adresu (/ustawienia/producenci → "manufacturers"). */
  settingsSection: string | null;
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
  // Karta producenta nie ma pozycji w menu — wchodzi się na nią z karty produktu.
  producenci: "manufacturers",
};

// Podsekcje Ustawień, do których prowadzi adres. Na razie tylko producenci —
// to korzeń breadcrumba karty producenta otwartej z linku.
const SETTINGS_SECTION_BY_SEGMENT: Record<string, string> = {
  producenci: "manufacturers",
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

/**
 * Karta producenta. W adresie NAZWA, nie id — „/producenci/Anji" coś mówi,
 * „/producenci/12" nie. Kodujemy, bo nazwy mają spacje i ukośniki.
 */
export function pathForManufacturer(name: string): string {
  return `/producenci/${encodeURIComponent(name)}`;
}

/** Ustawienia → Producenci (lista producentów, bez otwierania modala). */
export const PATH_MANUFACTURERS_LIST = "/ustawienia/producenci";

export function pathForContainer(id: number): string {
  return `/kontenery/${id}`;
}

/**
 * Adres → widok. Nieznany segment nie jest błędem: lądujemy na dashboardzie,
 * tak samo jak przy wejściu na „/". Stare linki nie wywalają aplikacji.
 */
export function parsePath(pathname: string | null): Route {
  const pusty: Route = { view: DEFAULT_VIEW, sku: null, containerId: null, mfrName: null, settingsSection: null };
  if (!pathname) return pusty;

  const segments = pathname.split("/").filter(Boolean);
  if (!segments.length) return pusty;

  const view = VIEW_BY_SEGMENT[segments[0]];
  if (!view) return pusty;

  let drugi: string | null = null;
  try { drugi = segments[1] ? decodeURIComponent(segments[1]) : null; }
  catch { drugi = segments[1] ?? null; }  // „%" bez kodu w ręcznie wklejonym linku

  const r: Route = { ...pusty, view };
  if (view === "products") return { ...r, sku: drugi };
  if (view === "containers") {
    const id = drugi != null ? Number(drugi) : NaN;
    return { ...r, containerId: Number.isFinite(id) ? id : null };
  }
  if (view === "manufacturers") {
    // Sam „/producenci" bez nazwy nie ma własnego widoku — to lista w Ustawieniach.
    if (!drugi) return { ...r, view: "settings", settingsSection: "manufacturers" };
    return { ...r, mfrName: drugi };
  }
  if (view === "settings") {
    return { ...r, settingsSection: segments[1] ? (SETTINGS_SECTION_BY_SEGMENT[segments[1]] ?? null) : null };
  }
  return r;
}
