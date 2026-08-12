// ============================================================
// MAGAZYN — Pipeline zaopatrzenia per PRODUCENT (lib/pipeline.ts).
//   Liczy kafelki „Magazyn w drodze" i „W Prognozie" w modalu szczegółów producenta,
//   tą samą regułą co KPI na pulpicie: ZIELONE = kontenery wbite do ERP (kwota =
//   zapłacone raty i balance), CZERWONE = jeszcze tylko w apce (kwota = niezapłacone).
//
//   Reguła jest tu PRZEPISANA, a nie zaimportowana z dashboard.tsx — pulpit zostaje
//   nietknięty. Różnica zakresu i tak jest realna: pulpit dzieli kontener na ułamki
//   udziałem firmy (firma_breakdown), a producent nie — kontener zwykły należy do
//   niego w całości, w skonsolidowanym siedzi na poziomie LOTU.
//   Gdyby kiedyś zmieniła się definicja „zapłacone/do zapłacenia", trzeba poprawić
//   w dwóch miejscach: tutaj i w splitSubiekt() w dashboard.tsx.
//
//   Typy są STRUKTURALNE (minimum pól) — Container z containers-ui pasuje do nich bez
//   żadnej zmiany w tamtym pliku; pola płatności backend zwraca, choć typ ich nie deklaruje.
// ============================================================

export type FirmaShare = { units?: number; value?: number };

export type PipelineLot = {
  id: number;
  manufacturer_id?: number | null;
  total_value: number;
  subiekt_wbite?: boolean | null;
  firma_breakdown?: Record<string, FirmaShare>;
  zaplacono_pln?: number;
  do_zaplacenia_pln?: number;
  brak_kursu?: number;
};

export type PipelineContainer = {
  manufacturer_id?: number | null;
  status: string;
  effective_status?: string;
  total_value: number;
  is_consolidated?: boolean;
  subiekt_wbite?: boolean | null;
  lots?: PipelineLot[];
  firma_breakdown?: Record<string, FirmaShare>;
  zaplacono_pln?: number;
  do_zaplacenia_pln?: number;
  brak_kursu?: number;
};

export type PipelineTotals = {
  /** CZERWONE: jeszcze nie w ERP. value = wartość towaru, remaining = niezapłacone raty+balance. */
  kont: { value: number; containers: number; looseLots: number; remaining: number };
  /** ZIELONE: już w ERP. paid = zapłacone raty+balance, remaining = jeszcze do zapłacenia. */
  green: { containers: number; looseLots: number; paid: number; remaining: number };
  /** Wpłaty bez notowania NBP — nie weszły do sum, więc kwoty są zaniżone. */
  missingRates: number;
};

/** Niedostarczony = po statusie EFEKTYWNYM (auto-odprawa/auto-dostawa z ETA), nie po ręcznym. */
export const isUndelivered = (c: PipelineContainer) =>
  (c.effective_status ?? c.status) !== "DELIVERED";

// ── Podział wg PRODUCENTA (zakres: modal „Szczegóły producenta") ──
// Różnica względem firmy: producent nie dzieli kontenera na ułamki. Kontener zwykły
// należy do jednego producenta w całości, a w skonsolidowanym producent siedzi na
// poziomie LOTU — więc bierzemy loty, nie proporcje z firma_breakdown.
// Bez tego producent wożący towar wyłącznie w kontenerach skonsolidowanych
// (c.manufacturer_id = NULL) pokazywałby zera.
export function mfrPipeline(containers: PipelineContainer[], mfrId: number): PipelineTotals {
  let redValue = 0, redContainers = 0, redLooseLots = 0, greenContainers = 0, greenLooseLots = 0;
  let redRemaining = 0, greenPaid = 0, greenRemaining = 0, missingRates = 0;

  for (const c of containers.filter(isUndelivered)) {
    const lots = c.lots ?? [];
    const consolidated = !!c.is_consolidated && lots.length > 0;

    if (consolidated) {
      const mine = lots.filter((l) => l.manufacturer_id === mfrId);
      if (!mine.length) continue;
      const green = mine.filter((l) => !!l.subiekt_wbite);
      const red = mine.filter((l) => !l.subiekt_wbite);
      redValue += red.reduce((s, l) => s + (l.total_value || 0), 0);
      redRemaining += red.reduce((s, l) => s + (l.do_zaplacenia_pln ?? 0), 0);
      greenPaid += green.reduce((s, l) => s + (l.zaplacono_pln ?? 0), 0);
      greenRemaining += green.reduce((s, l) => s + (l.do_zaplacenia_pln ?? 0), 0);
      missingRates += mine.reduce((s, l) => s + (l.brak_kursu ?? 0), 0);
      // Licznik jak na pulpicie: cały kontener tylko gdy WSZYSTKIE jego loty są tego
      // producenta; inaczej liczymy luźne loty, żeby nie zawyżać liczby kontenerów.
      if (red.length > 0 && red.length === lots.length) redContainers += 1;
      else if (red.length > 0) redLooseLots += red.length;
      if (green.length > 0 && green.length === lots.length) greenContainers += 1;
      else if (green.length > 0) greenLooseLots += green.length;
      continue;
    }

    if (c.manufacturer_id !== mfrId) continue;
    const isRed = !c.subiekt_wbite;
    missingRates += c.brak_kursu ?? 0;
    if (isRed) {
      redValue += c.total_value || 0;
      redRemaining += c.do_zaplacenia_pln ?? 0;
      redContainers += 1;
    } else {
      greenPaid += c.zaplacono_pln ?? 0;
      greenRemaining += c.do_zaplacenia_pln ?? 0;
      greenContainers += 1;
    }
  }

  return {
    kont: { value: redValue, containers: redContainers, looseLots: redLooseLots, remaining: redRemaining },
    green: { containers: greenContainers, looseLots: greenLooseLots, paid: greenPaid, remaining: greenRemaining },
    missingRates,
  };
}

/** Czy kontener (lub którykolwiek jego lot) należy do tego producenta. */
export const belongsToMfr = (c: PipelineContainer, mfrId: number) =>
  c.manufacturer_id === mfrId || (c.lots ?? []).some((l) => l.manufacturer_id === mfrId);

export const plPick = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) ? few : many;

/** „39 kontenerów" albo „34 kontenery + 5 lotów" (luźne loty z kontenerów mieszanych). */
export function countLabel(containers: number, looseLots: number): string {
  const parts: string[] = [];
  if (containers > 0 || looseLots === 0) parts.push(`${containers} ${plPick(containers, "kontener", "kontenery", "kontenerów")}`);
  if (looseLots > 0) parts.push(`${looseLots} ${plPick(looseLots, "lot", "loty", "lotów")}`);
  return parts.join(" + ");
}
