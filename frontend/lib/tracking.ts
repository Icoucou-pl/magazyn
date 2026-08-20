// frontend/lib/tracking.ts
// Armatorzy + linki do śledzenia kontenerów, walidacja numeru ISO 6346.
//
// UWAGA: link generujemy wyłącznie dla armatorów o POTWIERDZONYM formacie URL
// (MSC, CMA CGM). Reszta jest na liście do wyboru — służy jako informacja
// w kartotece kontenera — ale przycisku „Śledź" nie dostaje, bo zgadnięty
// adres prowadziłby do pustego wyniku. Kolejnych dokładamy dopiero po
// zweryfikowaniu prawdziwego URL-a na żywym kontenerze.

export type Carrier =
  | "MSC" | "CMA" | "MAERSK" | "COSCO" | "HAPAG" | "ONE" | "EVERGREEN" | "OTHER";

export const CARRIERS: { value: Carrier; label: string; tracked: boolean }[] = [
  { value: "MSC",       label: "MSC",             tracked: true  },
  { value: "CMA",       label: "CMA CGM",         tracked: true  },
  { value: "MAERSK",    label: "Maersk",          tracked: false },
  { value: "COSCO",     label: "COSCO",           tracked: false },
  { value: "HAPAG",     label: "Hapag-Lloyd",     tracked: false },
  { value: "ONE",       label: "ONE",             tracked: false },
  { value: "EVERGREEN", label: "Evergreen",       tracked: false },
  { value: "OTHER",     label: "Inny",            tracked: false },
];

/* ---------- walidacja ISO 6346 ---------- */

// Wartości liter wg ISO 6346: A=10, wielokrotności 11 są pomijane.
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

export function normalizeContainerNo(raw: string | null | undefined): string {
  return (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isDraftContainer(raw: string | null | undefined): boolean {
  return /^draft-/i.test((raw || "").trim());
}

/** Zwraca null gdy numer poprawny, albo komunikat o błędzie. Puste = brak błędu. */
export function validateContainerNo(raw: string | null | undefined): string | null {
  const no = normalizeContainerNo(raw);
  if (!no || isDraftContainer(raw)) return null;
  if (!/^[A-Z]{4}\d{7}$/.test(no)) return "Format ISO: 4 litery + 7 cyfr (np. TCLU3204372).";
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += (i < 4 ? LETTER_VALUES[no[i]] : Number(no[i])) * Math.pow(2, i);
  }
  const expected = sum % 11 === 10 ? 0 : sum % 11;
  if (expected !== Number(no[10])) return `Błędna cyfra kontrolna (oczekiwano ${expected}).`;
  return null;
}

export function isValidContainerNo(raw: string | null | undefined): boolean {
  const no = normalizeContainerNo(raw);
  return !!no && !isDraftContainer(raw) && validateContainerNo(no) === null;
}

/* ---------- linki ---------- */

function b64(input: string): string {
  if (typeof window !== "undefined" && typeof window.btoa === "function") return window.btoa(input);
  return Buffer.from(input, "utf-8").toString("base64");
}

// MSC koduje parametry wyszukiwania jako base64 w query paramie `params`;
// trackingMode=0 → szukanie po numerze kontenera.
const CARRIER_URLS: Partial<Record<Carrier, (no: string) => string>> = {
  MSC: (no) => `https://www.msc.com/en/track-a-shipment?params=${encodeURIComponent(b64(`trackingNumber=${no}&trackingMode=0`))}`,
  CMA: (no) => `https://www.cma-cgm.com/eBusiness/tracking/detail/${no}`,
};

/** true, gdy dla danego armatora umiemy zbudować działający link. */
export function isTracked(carrier: string | null | undefined): boolean {
  return !!carrier && !!CARRIER_URLS[carrier.toUpperCase() as Carrier];
}

/**
 * Link do śledzenia albo null, gdy: brak numeru / numer draftowy / numer
 * niepoprawny / brak armatora / armator bez potwierdzonego formatu URL.
 */
export function trackingUrl(
  containerNo: string | null | undefined,
  carrier: string | null | undefined
): string | null {
  if (!isValidContainerNo(containerNo)) return null;
  const builder = CARRIER_URLS[(carrier || "").toUpperCase() as Carrier];
  return builder ? builder(normalizeContainerNo(containerNo)) : null;
}

export function carrierLabel(carrier: string | null | undefined): string {
  if (!carrier) return "—";
  return CARRIERS.find((c) => c.value === carrier.toUpperCase())?.label || carrier;
}
