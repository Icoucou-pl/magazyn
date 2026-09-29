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
  /** Karta kontenera (/kontenery/MSDU6911513 albo /kontenery/SK2605042) — patrz containerSlug. */
  containerKey: string | null;
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

/** Karta kontenera pod jego „ludzkim" kluczem (containerSlug). */
export function pathForContainerPage(key: string): string {
  return `/kontenery/${encodeURIComponent(key)}`;
}

type SlugSource = {
  id: number;
  container_number?: string | null;
  order_number?: string | null;
  lot_order_numbers?: (string | null | undefined)[];
};

/**
 * Klucz kontenera w adresie karty. Numer kontenera znamy zwykle dopiero po
 * wypłynięciu, a FV wpisujemy od razu przy zakładaniu — więc:
 *   1. prawdziwy numer kontenera (bez roboczego „Draft-…"),
 *   2. inaczej nr FV kontenera, a w skonsolidowanym — FV pierwszego lotu,
 *   3. inaczej „id-12".
 * Gdy numer się pojawi, link zmieni się na numer kontenera, ale stary link
 * z FV dalej trafia — karta szuka po numerze kontenera ORAZ po FV (także lotów).
 * Klucz z samych cyfr zamieniamy na „id-12", bo same cyfry w adresie to stary
 * deep-link do formularza (/kontenery/12).
 */
export function containerSlug(c: SlugSource): string {
  const clean = (v?: string | null) => (v || "").trim();
  const nr = clean(c.container_number);
  const realNr = nr && !/^draft-/i.test(nr) ? nr : "";
  const fv = clean(c.order_number) || (c.lot_order_numbers || []).map(clean).find(Boolean) || "";
  const key = realNr || fv;
  if (!key || /^\d+$/.test(key)) return `id-${c.id}`;
  return key;
}

/**
 * Adres → widok. Nieznany segment nie jest błędem: lądujemy na dashboardzie,
 * tak samo jak przy wejściu na „/". Stare linki nie wywalają aplikacji.
 */
export function parsePath(pathname: string | null): Route {
  const pusty: Route = { view: DEFAULT_VIEW, sku: null, containerId: null, mfrName: null, settingsSection: null, containerKey: null };
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
    // Same cyfry = stary deep-link (/kontenery/12): lista Kontenerów + formularz w oknie.
    // Kalendarz, Cashflow i pulpit dalej tak otwierają kontener.
    // Cokolwiek innego = numer kontenera / FV → pełna karta kontenera.
    if (drugi != null && /^\d+$/.test(drugi)) return { ...r, containerId: Number(drugi) };
    if (drugi) return { ...r, view: "containerPage", containerKey: drugi };
    return r;
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
