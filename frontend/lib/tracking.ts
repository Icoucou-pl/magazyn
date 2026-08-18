// frontend/lib/tracking.ts
// Generowanie linków do śledzenia kontenerów + walidacja numeru ISO 6346.
// Etap 1 — bez API, bez zależności zewnętrznych.

export type Carrier = "MSC" | "MAERSK" | "COSCO" | "CMA" | "HAPAG" | "ONE" | "EVERGREEN" | "OTHER";

export const CARRIERS: { value: Carrier; label: string }[] = [
  { value: "MSC", label: "MSC" },
  { value: "MAERSK", label: "Maersk" },
  { value: "COSCO", label: "COSCO" },
  { value: "CMA", label: "CMA CGM" },
  { value: "HAPAG", label: "Hapag-Lloyd" },
  { value: "ONE", label: "ONE" },
  { value: "EVERGREEN", label: "Evergreen" },
  { value: "OTHER", label: "Inny / nieznany" },
];

export const DEFAULT_CARRIER: Carrier = "MSC";

/* ---------- walidacja ISO 6346 ---------- */

// Wartości liter wg ISO 6346: A=10, pomijane są wielokrotności 11.
const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  let v = 10;
  for (let i = 0; i < 26; i++) {
    if (v % 11 === 0) v++;
    map[String.fromCharCode(65 + i)] = v;
    v++;
  }
  return map;
})();

export function normalizeContainerNo(raw: string): string {
  return (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isDraftContainer(raw: string | null | undefined): boolean {
  return /^draft-/i.test(raw || "");
}

/**
 * Waliduje numer kontenera w formacie ISO 6346 (4 litery + 6 cyfr + cyfra kontrolna).
 * Zwraca null gdy numer poprawny, albo komunikat o błędzie.
 */
export function validateContainerNo(raw: string): string | null {
  const no = normalizeContainerNo(raw);
  if (!no) return null; // puste pole nie jest błędem — walidujemy tylko wypełnione
  if (!/^[A-Z]{4}\d{7}$/.test(no)) {
    return "Numer powinien mieć 4 litery i 7 cyfr (np. UETU8695821).";
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = no[i];
    const val = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += val * Math.pow(2, i);
  }
  const expected = sum % 11 === 10 ? 0 : sum % 11;
  if (expected !== Number(no[10])) {
    return `Błędna cyfra kontrolna — sprawdź numer (oczekiwano ${expected}).`;
  }
  return null;
}

export function isValidContainerNo(raw: string): boolean {
  const no = normalizeContainerNo(raw);
  return !!no && validateContainerNo(no) === null;
}

/* ---------- generowanie linków ---------- */

function b64(input: string): string {
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    return window.btoa(input);
  }
  // fallback dla SSR / Node
  return Buffer.from(input, "utf-8").toString("base64");
}

/**
 * MSC koduje parametry wyszukiwania jako base64 w query paramie `params`.
 * trackingMode=0 → wyszukiwanie po numerze kontenera.
 */
function mscUrl(containerNo: string): string {
  const params = b64(`trackingNumber=${containerNo}&trackingMode=0`);
  return `https://www.msc.com/en/track-a-shipment?params=${encodeURIComponent(params)}`;
}

const CARRIER_URLS: Record<Carrier, (no: string) => string> = {
  MSC: mscUrl,
  MAERSK: (no) => `https://www.maersk.com/tracking/${no}`,
  COSCO: (no) => `https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number=${no}`,
  CMA: (no) => `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&Reference=${no}`,
  HAPAG: (no) => `https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container=${no}`,
  ONE: (no) => `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam=${no}`,
  EVERGREEN: (no) => `https://www.shipmentlink.com/servlet/TDB1_CargoTracking.do?ctnr=${no}`,
  OTHER: (no) => `https://www.track-trace.com/container?number=${no}`,
};

/**
 * Zwraca link do śledzenia albo null, gdy numeru nie da się użyć
 * (pusty, draftowy lub niepoprawny formalnie).
 */
export function trackingUrl(
  containerNo: string | null | undefined,
  carrier: Carrier | null | undefined = DEFAULT_CARRIER
): string | null {
  if (!containerNo || isDraftContainer(containerNo)) return null;
  const no = normalizeContainerNo(containerNo);
  if (!/^[A-Z]{4}\d{7}$/.test(no)) return null;
  const builder = CARRIER_URLS[(carrier || DEFAULT_CARRIER) as Carrier] || CARRIER_URLS.OTHER;
  return builder(no);
}

export function carrierLabel(carrier: Carrier | null | undefined): string {
  return CARRIERS.find((c) => c.value === (carrier || DEFAULT_CARRIER))?.label || "—";
}
