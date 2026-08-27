"use client";
// ============================================================
// MAGAZYN — Kalendarz (etap 4A). Port calendar.jsx → .tsx.
//   Wygląd 1:1 z mocka, dane z realnego API: GET /calendar.
//   Tryby: Miesiąc (siatka 6 tyg.) / Tydzień (7 kolumn) / Dzień (szczegół).
//   Mapowanie pól mocka → kontrakt backendu:
//     DELIVERY: event.container → container_number, event.units → total_units,
//               event.carrier (nie istnieje) → manufacturer_name,
//               event.mfrId → manufacturer_name + manufacturer_color (MfrChip).
//     ORDER/EMPTY: event.mfrId → manufacturer_name + manufacturer_color,
//               event.qty (sugerowana ilość, 6-mies. pokrycie) dochodzi z backendu.
//
//   PAYMENT (płatności „Do zapłaty"):
//     · Backend wysyła je TYLKO userom z viewCalendarPayments ORAZ viewFinancials —
//       front dodatkowo nie rysuje chipa filtra, żeby nie mrugać pustą kategorią.
//     · Oś czasu to `termin` (planowany termin płatności), nie data wpłaty. Zapłacone
//       (data ≤ dziś) nie przychodzą z backendu w ogóle — kalendarz pokazuje zobowiązania.
//     · Płatności bez terminu mają date=null: nie mieszczą się w siatce, więc siedzą
//       w osobnej karcie w panelu bocznym i można je stamtąd przeciągnąć na dzień.
//     · Drag & drop zmienia WYŁĄCZNIE termin (PATCH /cashflow/payment/termin) i wymaga
//       editContainers. Faktyczna data wpłaty zostaje do ręcznego wpisania w kontenerze.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I, Card, CardHeader, Pill, MfrChip, containerLabel, isDraftNumber } from "./ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { useShop } from "@/lib/shop";
import { fmtNum, fmtPLN } from "@/lib/format";
import { can, canSeeCalendarPayments, useUser } from "@/lib/permissions";

// ── Typy ─────────────────────────────────────────────────────
type EventType = "ORDER" | "EMPTY" | "DELIVERY" | "PAYMENT";
type Mode = "month" | "week" | "day";
type Scope = "watched" | "active";

type CalEvent = {
  date: string | null;            // PAYMENT bez terminu → null (poza siatką)
  type: EventType;
  // ORDER / EMPTY
  sku?: string;
  name?: string;
  status?: string;
  qty?: number;
  // DELIVERY
  container_id?: number;
  container_number?: string;
  order_number?: string | null;
  total_units?: number;
  container_status?: string;
  // PAYMENT
  pay_kind?: "zaliczka" | "balance";
  advance_id?: number | null;
  lot_id?: number | null;
  kwota?: number;
  waluta?: string;
  kwota_pln?: number | null;      // szacunek po dzisiejszym kursie NBP (płatność jest niezapłacona)
  kurs?: number | null;           // kurs użyty do szacunku; null dla PLN i przy braku notowania
  procent?: number | null;
  shop?: string;
  shop_name?: string;
  termin?: string | null;
  overdue?: boolean;
  // wspólne (producent)
  manufacturer_id?: number | null;
  manufacturer_name?: string | null;
  manufacturer_color?: string | null;
};

type Filters = Record<EventType, boolean>;

type DayCellData = {
  date: Date;
  key: string;
  day: number;
  outMonth: boolean;
  weekend: boolean;
};

type EventMeta = { label: string; fg: string; bg: string; dot: string };

// Kontekst drag & drop — jeden obiekt zamiast pięciu propsów przewleczonych przez siatki.
// null = user nie ma editContainers, więc nic nie jest przeciągalne.
type DragCtx = {
  onDragStart: (e: CalEvent) => void;
  onDragEnd: () => void;
  onDropDay: (dayKey: string) => void;
  dropTarget: string | null;
  setDropTarget: (k: string | null) => void;
  active: React.MutableRefObject<CalEvent | null>;
};

// ── Meta / stałe ─────────────────────────────────────────────
const EVENT_META: Record<EventType, EventMeta> = {
  ORDER:    { label: "Zamów do",      fg: "var(--warning)",  bg: "var(--warning-soft)",  dot: "var(--warning)" },
  EMPTY:    { label: "Koniec zapasu", fg: "var(--critical)", bg: "var(--critical-soft)", dot: "var(--critical)" },
  DELIVERY: { label: "Dostawa",       fg: "var(--info)",     bg: "var(--info-soft)",     dot: "var(--info)" },
  PAYMENT:  { label: "Płatności",     fg: "var(--anomaly)",  bg: "var(--anomaly-soft)",  dot: "var(--anomaly)" },
};

const MODE_LABEL: Record<Mode, string> = { month: "Mies", week: "Tydz", day: "Dzień" };

// Kolejność zdarzeń w obrębie dnia. Płatność przed dostawą: termin zapłaty jest „akcyjny"
// (coś trzeba zrobić), dostawa tylko informuje, że towar wjeżdża.
const TYPE_RANK: Record<EventType, number> = { EMPTY: 0, ORDER: 1, PAYMENT: 2, DELIVERY: 3 };

// Sklep/magazyn — te same slugi i etykiety co na dashboardzie. "" = wszystkie sklepy (suma).

const MONTH_NAMES = ["Styczeń","Luty","Marzec","Kwiecień","Maj","Czerwiec","Lipiec","Sierpień","Wrzesień","Październik","Listopad","Grudzień"];
const DAY_NAMES   = ["Pn","Wt","Śr","Cz","Pt","Sb","Nd"];

// Local-tz date key (toISOString uses UTC — wrong in UTC+2 evenings)
const dKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Parse 'YYYY-MM-DD' as LOCAL midnight (default constructor would parse it as UTC)
const parseLocal = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
// Poniedziałek tygodnia zawierającego d
const mondayOf = (d: Date) => { const x = new Date(d); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); x.setHours(0, 0, 0, 0); return x; };
// Krótka data do toastów: „5 sie"
const fmtShortDay = (s?: string | null) =>
  s ? parseLocal(s).toLocaleDateString("pl-PL", { day: "numeric", month: "short" }) : "bez terminu";

// ── Płatności: identyfikacja i etykiety ──────────────────────
// Klucz zdarzenia płatności — musi przeżyć re-render między dragstart a drop.
// Zaliczka ma własny wiersz (advance_id); balance identyfikujemy przez kontener + lot,
// bo siedzi jako kolumna na kontenerze/locie, nie jako osobny rekord.
const payKey = (e: CalEvent) =>
  `${e.pay_kind}:${e.advance_id ?? "-"}:${e.container_id ?? "-"}:${e.lot_id ?? "-"}`;

const payAmount = (e: CalEvent) => `${fmtNum(e.kwota)} ${e.waluta || "USD"}`;

// Etykieta chipa płatności: PRODUCENT · KWOTA WALUTA (fallback na PO/nr kontenera bez producenta).
const payLabel = (e: CalEvent) => {
  const who = e.manufacturer_name
    || (isDraftNumber(e.container_number) ? (e.order_number || "Płatność") : (e.container_number || e.order_number || "Płatność"));
  return `${who} · ${payAmount(e)}`;
};

const payKindLabel = (e: CalEvent) =>
  e.pay_kind === "zaliczka"
    ? (e.procent != null ? `Zaliczka ${fmtNum(e.procent)}%` : "Zaliczka")
    : "Balance";

// Wersja chipa na wąskie ekrany. Na telefonie kolumna miesiąca ma ~45 px — „Fosoto · 8 200 USD"
// nie zmieści się tam nigdy, a ucięte „Fo…" nic nie mówi. Skracamy do symbolu waluty i kwoty
// w tysiącach: $8,2k / ¥15k / 920 zł. Pełna etykieta zostaje w panelu bocznym i tooltipie.
const CUR_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", CNY: "¥", GBP: "£", PLN: "zł" };

const payShort = (e: CalEvent) => {
  const cur = (e.waluta || "USD").toUpperCase();
  const sym = CUR_SYMBOL[cur] || cur;
  const v = Math.abs(e.kwota || 0);
  let num: string;
  if (v >= 10000) num = `${Math.round(v / 1000)}k`;
  else if (v >= 1000) num = `${(v / 1000).toFixed(1).replace(".", ",")}k`;
  else num = fmtNum(Math.round(v));
  // Złotówki czyta się naturalnie z symbolem z tyłu, waluty obce z przodu.
  return cur === "PLN" ? `${num} zł` : `${sym}${num}`;
};

// Etykieta zdarzenia: dostawa pokazuje producenta (fallback: nr kontenera), reszta SKU
const eventLabel = (e: CalEvent) => {
  if (e.type === "PAYMENT") return payLabel(e);
  return e.type === "DELIVERY"
    ? (e.manufacturer_name ?? (isDraftNumber(e.container_number) ? (e.order_number || "Dostawa") : (e.container_number ?? "Dostawa")))
    : e.sku ?? "";
};
// Podtytuł: dostawa → "nr kontenera · N szt" (producent poszedł na 1 plan), reszta → nazwa produktu
const eventSub = (e: CalEvent) => {
  if (e.type === "PAYMENT") {
    const nr = isDraftNumber(e.container_number) ? null : e.container_number;
    return [payKindLabel(e), nr || e.order_number].filter(Boolean).join(" · ");
  }
  if (e.type !== "DELIVERY") return e.name ?? "";
  // Numer roboczy „Draft-…" nie idzie do UI — zastępuje go PO (containerLabel).
  const lab = containerLabel(e);
  const nr = lab.isFallback ? null : [lab.nr, lab.po].filter(Boolean).join(" ");
  return [nr, `${fmtNum(e.total_units)} szt`].filter(Boolean).join(" · ");
};

// ── Utrwalanie stanu widoku (sessionStorage) ─────────────────
// Po otwarciu popupu kontenera page.tsx przełącza widok na „containers", przez co
// kalendarz się odmontowuje. Zapamiętujemy tryb/miesiąc/wybrany dzień/sklep/zakres/filtry
// ORAZ rozwiniętą płatność, żeby po zamknięciu popupu wrócić dokładnie w to samo miejsce.
// Kalendarz renderuje się wyłącznie po stronie klienta (page.tsx: `if (!ready) return null`),
// więc odczyt w inicjalizatorze useState jest bezpieczny — brak hydration mismatch.
const CAL_STATE_KEY = "magazyn:calendar:view";
// Znacznik „wyszliśmy stąd do popupu kontenera i zaraz wrócimy". Ustawiany tuż przed
// otwarciem kontenera, konsumowany przy najbliższym montażu kalendarza. Pozwala odróżnić
// powrót z popupu (odtwarzamy widok 1:1) od świeżego wejścia w zakładkę (płatności chowamy).
const CAL_ROUNDTRIP_KEY = "magazyn:calendar:roundtrip";

function markContainerRoundtrip(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(CAL_ROUNDTRIP_KEY, "1"); } catch { /* tryb prywatny */ }
}

function consumeRoundtrip(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const was = window.sessionStorage.getItem(CAL_ROUNDTRIP_KEY) === "1";
    window.sessionStorage.removeItem(CAL_ROUNDTRIP_KEY);   // jednorazowy — zużywamy od razu
    return was;
  } catch { return false; }
}
type PersistedCalState = { mode: Mode; cursorTs: number; selected: string; scope: Scope; filters: Filters; openPay: string | null };
function loadCalState(): Partial<PersistedCalState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(CAL_STATE_KEY);
    return raw ? (JSON.parse(raw) as PersistedCalState) : {};
  } catch { return {}; }
}

// ── Widok główny ─────────────────────────────────────────────
function Calendar({ density, onOpenContainer }: { density?: string; onOpenContainer?: (id: number) => void }) {
  void density; // gęstość nie wpływa na układ kalendarza — zachowane dla spójności propsów widoków

  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const user = useUser();
  // Backend i tak nie wyśle płatności bez uprawnienia — to lustro tej reguły, żeby
  // nie renderować chipa filtra ani karty „bez terminu" dla kogoś, kto nic nie dostanie.
  const showPayments = canSeeCalendarPayments(user);
  // Przeciąganie terminów to zapis na kontenerze — osobne uprawnienie niż samo oglądanie.
  const canDragPayments = showPayments && can(user, "editContainers");

  // Stan widoku inicjowany z sessionStorage (lazy) — patrz komentarz przy loadCalState.
  const [saved] = useState<Partial<PersistedCalState>>(loadCalState);
  // Czy to powrót z popupu kontenera? Czytamy raz, przy montażu (znacznik się zużywa).
  const [isRoundtrip] = useState<boolean>(consumeRoundtrip);
  const [mode, setMode] = useState<Mode>(saved.mode ?? "month");
  const [cursor, setCursor] = useState<Date>(() => (saved.cursorTs ? new Date(saved.cursorTs) : new Date()));
  const [selected, setSelected] = useState(saved.selected ?? dKey(new Date()));
  // Płatności są DOMYŚLNIE SCHOWANE — jako jedyna kategoria niosą kwoty zobowiązań,
  // więc nie wyświetlają się same przy wejściu w zakładkę; trzeba świadomie kliknąć chip.
  // Wyjątek: powrót z popupu kontenera, gdzie odtwarzamy widok 1:1 — inaczej płatność,
  // z której właśnie wszedłeś w kontener, znikałaby po jego zamknięciu.
  // Pozostałe filtry działają jak dotąd (zapamiętywane między wejściami).
  const [filters, setFilters] = useState<Filters>(() => {
    const base: Filters = { ORDER: true, EMPTY: true, DELIVERY: true, PAYMENT: false };
    const merged = { ...base, ...(saved.filters || {}) };
    return { ...merged, PAYMENT: isRoundtrip ? (saved.filters?.PAYMENT ?? false) : false };
  });
  // Zakres SKU: "watched" = tylko obserwowane (gwiazdka), "active" = wszystkie aktywne.
  // Domyślnie "watched" — kalendarz nie zaśmieca się zgniłymi SKU. Dostawy zawsze widoczne.
  const [scope, setScope] = useState<Scope>(saved.scope ?? "watched");
  // Rozwinięty szczegół płatności w panelu bocznym (klucz z payKey albo null).
  // Przy świeżym wejściu zeruje się razem z filtrem — nie ma czego rozwijać, gdy płatności schowane.
  const [openPay, setOpenPay] = useState<string | null>(isRoundtrip ? (saved.openPay ?? null) : null);
  // Dzień podświetlony pod kursorem podczas przeciągania.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Przeciągane zdarzenie w ref — stan re-renderowałby siatkę w trakcie dragu i gubił uchwyt.
  const dragRef = useRef<CalEvent | null>(null);
  // Firma z globalnego fragmentatora w Topbarze (lib/shop).
  // ORDER/EMPTY liczone są per-firma, DELIVERY i PAYMENT zawężone do danych tej firmy.
  const { shop } = useShop();

  // Zapis stanu widoku przy każdej zmianie — dzięki temu po powrocie z popupu kontenera
  // (remount) kalendarz odtwarza dokładnie ten sam widok, łącznie z rozwiniętą płatnością.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(CAL_STATE_KEY, JSON.stringify({
        mode, cursorTs: cursor.getTime(), selected, scope, filters, openPay,
      }));
    } catch { /* quota / tryb prywatny — ignorujemy */ }
  }, [mode, cursor, selected, scope, filters, openPay]);

  // Licznik żądań zamiast flagi `mounted`: load() woła też rollback po nieudanym PATCH-u,
  // więc odpowiedź starszego zapytania nie może nadpisać nowszego stanu.
  const reqIdRef = useRef(0);
  const load = useCallback(async () => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (scope === "watched") params.set("favorites_only", "1");
      if (shop) params.set("shop", shop);
      const qs = params.toString();
      const data = await api.get(`/calendar${qs ? `?${qs}` : ""}`);
      if (reqIdRef.current === myId) setEvents(Array.isArray(data) ? (data as CalEvent[]) : []);
    } catch {
      if (reqIdRef.current === myId) { setEvents([]); toast("Nie udało się pobrać kalendarza", "error"); }
    } finally {
      if (reqIdRef.current === myId) setLoading(false);
    }
  }, [scope, shop]);

  useEffect(() => { load(); }, [load]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const todayKey = dKey(new Date());

  // ── Drag & drop terminów płatności ─────────────────────────
  // Optymistycznie przesuwamy chip od razu (UI nie może czekać na round-trip), a przy
  // błędzie cofamy i przeładowujemy — 409 oznacza, że ktoś ruszył kontener w międzyczasie.
  const movePayment = useCallback(async (ev: CalEvent, newDate: string) => {
    const oldDate = ev.date ?? null;
    if (oldDate === newDate) return;
    const k = payKey(ev);

    setEvents(prev => prev.map(e =>
      (e.type === "PAYMENT" && payKey(e) === k)
        ? { ...e, date: newDate, termin: newDate, overdue: newDate < todayKey }
        : e
    ));
    setSelected(newDate);
    setOpenPay(k);

    try {
      await api.patch("/cashflow/payment/termin", {
        kind: ev.pay_kind,
        container_id: ev.container_id,
        lot_id: ev.lot_id ?? null,
        advance_id: ev.advance_id ?? null,
        termin: newDate,
        expected_termin: oldDate,
      });
      toast(oldDate
        ? `Termin przesunięty: ${fmtShortDay(oldDate)} → ${fmtShortDay(newDate)} · ${payAmount(ev)}`
        : `Termin ustawiony na ${fmtShortDay(newDate)} · ${payAmount(ev)}`);
    } catch (err) {
      // Rollback + świeże dane: po odrzuconym zapisie stan serwera jest nieznany.
      setEvents(prev => prev.map(e =>
        (e.type === "PAYMENT" && payKey(e) === k)
          ? { ...e, date: oldDate, termin: oldDate, overdue: !!(oldDate && oldDate < todayKey) }
          : e
      ));
      const msg = (err as { message?: string } | null)?.message || "Nie udało się przesunąć terminu";
      toast(msg, "error");
      load();
    }
  }, [todayKey, load]);

  const onDragStartPayment = useCallback((ev: CalEvent) => { dragRef.current = ev; }, []);
  const onDragEndPayment = useCallback(() => { dragRef.current = null; setDropTarget(null); }, []);
  const onDropDay = useCallback((dayKey: string) => {
    const ev = dragRef.current;
    dragRef.current = null;
    setDropTarget(null);
    if (ev) movePayment(ev, dayKey);
  }, [movePayment]);

  const dragCtx: DragCtx | null = canDragPayments
    ? { onDragStart: onDragStartPayment, onDragEnd: onDragEndPayment, onDropDay, dropTarget, setDropTarget, active: dragRef }
    : null;

  // Siatka miesiąca: 6 tygodni (42 komórki) — dopełniona poprzednim/następnym miesiącem
  const cells = useMemo<DayCellData[]>(() => {
    const firstDay = new Date(year, month, 1);
    const startWeekday = (firstDay.getDay() + 6) % 7; // Mon=0
    const result: DayCellData[] = [];
    const start = new Date(year, month, 1 - startWeekday);
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      result.push({
        date: d, key: dKey(d), day: d.getDate(),
        outMonth: d.getMonth() !== month,
        weekend: d.getDay() === 0 || d.getDay() === 6,
      });
    }
    return result;
  }, [year, month]);

  // Dni bieżącego tygodnia (Pn–Nd)
  const weekDays = useMemo<Date[]>(() => {
    const mon = mondayOf(cursor);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
  }, [cursor]);

  // Zdarzenia widoczne dla tego usera. Uprawnienie MUSI ciąć zdarzenia, nie tylko chip filtra:
  // backend czyta uprawnienia z bazy przy każdym żądaniu, a front z kopii w localStorage, więc
  // tuż po zmianie ptaszka potrafią się rozjechać. Bez tej bramki płatności wpadały do siatki
  // (filtr PAYMENT domyślnie włączony), ale drag był zablokowany — „widzę, a nie mogę ruszyć".
  const allowedEvents = useMemo(
    () => (showPayments ? events : events.filter(e => e.type !== "PAYMENT")),
    [events, showPayments]
  );

  // Zdarzenia z datą — tylko one trafiają do siatki. Płatności bez terminu (date=null)
  // odfiltrowujemy tutaj raz, żeby żadna dalsza pętla nie musiała się o nie martwić.
  const datedEvents = useMemo(
    () => allowedEvents.filter(e => !!e.date && filters[e.type]),
    [allowedEvents, filters]
  );

  const eventsByDate = useMemo<Record<string, CalEvent[]>>(() => {
    const map: Record<string, CalEvent[]> = {};
    datedEvents.forEach(e => {
      const k = e.date as string;
      if (!map[k]) map[k] = [];
      map[k].push(e);
    });
    Object.keys(map).forEach(k => map[k].sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type]));
    return map;
  }, [datedEvents]);

  // Płatności bez ustalonego terminu — osobna karta w panelu bocznym.
  const noTermPayments = useMemo(
    () => (filters.PAYMENT ? allowedEvents.filter(e => e.type === "PAYMENT" && !e.date) : []),
    [allowedEvents, filters]
  );

  const monthEventCount = useMemo(() => {
    return datedEvents.filter(e => {
      const d = parseLocal(e.date as string);
      return d.getFullYear() === year && d.getMonth() === month;
    }).length;
  }, [datedEvents, year, month]);

  const selectedEvents = (eventsByDate[selected] || []).slice();

  // Liczba wydarzeń w widocznym zakresie (zależnie od trybu)
  const visibleCount = useMemo(() => {
    if (mode === "day") return (eventsByDate[selected] || []).length;
    if (mode === "week") {
      const keys = new Set(weekDays.map(dKey));
      return datedEvents.filter(e => keys.has(e.date as string)).length;
    }
    return monthEventCount;
  }, [mode, eventsByDate, selected, weekDays, datedEvents, monthEventCount]);

  // Etykieta nagłówka zależnie od trybu
  const label = useMemo(() => {
    if (mode === "month") return `${MONTH_NAMES[month]} ${year}`;
    if (mode === "week") {
      const a = weekDays[0], b = weekDays[6];
      const mon = (d: Date) => d.toLocaleDateString("pl-PL", { month: "short" });
      return a.getMonth() === b.getMonth()
        ? `${a.getDate()}–${b.getDate()} ${mon(b)} ${b.getFullYear()}`
        : `${a.getDate()} ${mon(a)} – ${b.getDate()} ${mon(b)} ${b.getFullYear()}`;
    }
    return parseLocal(selected).toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }, [mode, month, year, weekDays, selected]);

  // Nawigacja zależna od trybu
  const goPrev = () => {
    if (mode === "month") { setCursor(new Date(year, month - 1, 1)); return; }
    if (mode === "week")  { const c = new Date(cursor); c.setDate(c.getDate() - 7); setCursor(c); setSelected(dKey(mondayOf(c))); return; }
    const c = new Date(parseLocal(selected)); c.setDate(c.getDate() - 1); setCursor(c); setSelected(dKey(c));
  };
  const goNext = () => {
    if (mode === "month") { setCursor(new Date(year, month + 1, 1)); return; }
    if (mode === "week")  { const c = new Date(cursor); c.setDate(c.getDate() + 7); setCursor(c); setSelected(dKey(mondayOf(c))); return; }
    const c = new Date(parseLocal(selected)); c.setDate(c.getDate() + 1); setCursor(c); setSelected(dKey(c));
  };
  const goToday = () => { const t = new Date(); setCursor(t); setSelected(dKey(t)); };

  // Zmiana trybu — wyśrodkuj widok na aktualnie wybranym dniu
  const changeMode = (m: Mode) => { setMode(m); setCursor(parseLocal(selected)); };

  // Wybór dnia zwija otwarty szczegół płatności (klik w sam chip płatności idzie osobną ścieżką).
  const selectDay = useCallback((k: string) => { setSelected(k); setOpenPay(null); }, []);
  // Klik w chip płatności — skacz na jej dzień i rozwiń szczegół w panelu bocznym.
  const focusPayment = useCallback((e: CalEvent) => {
    if (e.date) setSelected(e.date);
    setOpenPay(payKey(e));
  }, []);

  // Wyjście do popupu kontenera zostawia znacznik — dzięki niemu po powrocie filtr płatności
  // i rozwinięty szczegół wracają takie, jakie były, zamiast resetować się jak przy świeżym wejściu.
  const openContainer = useCallback((id: number) => {
    markContainerRoundtrip();
    onOpenContainer?.(id);
  }, [onOpenContainer]);
  // Zachowujemy undefined, gdy rodzic nie podał handlera — komponenty niżej sprawdzają jego obecność.
  const handleOpenContainer = onOpenContainer ? openContainer : undefined;

  // Agenda — najbliższe 3 tygodnie
  const agenda = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today); end.setDate(end.getDate() + 21);
    return datedEvents
      .filter(e => { const ed = parseLocal(e.date as string); return ed >= today && ed <= end; })
      .sort((a, b) => (a.date as string).localeCompare(b.date as string));
  }, [datedEvents]);

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 80 }}>
      {/* Toolbar */}
      <CalendarToolbar
        label={label}
        eventCount={visibleCount}
        mode={mode} onMode={changeMode}
        filters={filters} setFilters={setFilters}
        scope={scope} onScope={setScope}
        showPayments={showPayments}
        onPrev={goPrev} onNext={goNext} onToday={goToday}
      />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 14 }} className="calendar-layout">
        {/* Główny obszar — zależny od trybu */}
        <div style={{ minWidth: 0 }}>
          {mode === "month" && (
            <MonthGrid cells={cells} eventsByDate={eventsByDate} todayKey={todayKey} selected={selected}
                       onSelect={selectDay} onPayClick={focusPayment} drag={dragCtx}/>
          )}
          {mode === "week" && (
            <WeekGrid weekDays={weekDays} eventsByDate={eventsByDate} todayKey={todayKey} selected={selected}
                      onSelect={selectDay} onPayClick={focusPayment} drag={dragCtx}/>
          )}
          {mode === "day" && (
            <Card>
              <DayDetail dateKey={selected} events={selectedEvents} todayKey={todayKey} loading={loading}
                         openPay={openPay} onTogglePay={setOpenPay} onOpenContainer={handleOpenContainer}/>
            </Card>
          )}
        </div>

        {/* Panel boczny */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Wybrany dzień — w trybie „Dzień" główny obszar to już ten dzień, więc tu pomijamy */}
          {mode !== "day" && (
            <Card>
              <DayDetail dateKey={selected} events={selectedEvents} todayKey={todayKey} loading={loading}
                         openPay={openPay} onTogglePay={setOpenPay} onOpenContainer={handleOpenContainer}/>
            </Card>
          )}

          {/* Płatności bez ustalonego terminu — nie mieszczą się w siatce, ale nie mogą zginąć */}
          {showPayments && filters.PAYMENT && (
            <NoTermPayments items={noTermPayments} canDrag={canDragPayments} drag={dragCtx} onPick={focusPayment}/>
          )}

          {/* Agenda */}
          <Card>
            <CardHeader icon={<I.Activity size={14}/>} title="Najbliższe 3 tygodnie" hint={`${agenda.length} wydarzeń`}/>
            <div style={{ maxHeight: 360, overflowY: "auto" }}>
              {agenda.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
                  {loading ? "Ładowanie…" : "Brak wydarzeń"}
                </div>
              ) : agenda.map((e, i) => {
                const d = parseLocal(e.date as string);
                const showHead = i === 0 || agenda[i - 1].date !== e.date;
                return (
                  <React.Fragment key={i}>
                    {showHead && <AgendaDateHeader date={d} todayKey={todayKey}/>}
                    <AgendaRow event={e} onClick={() => (e.type === "PAYMENT" ? focusPayment(e) : selectDay(e.date as string))}/>
                  </React.Fragment>
                );
              })}
            </div>
          </Card>
        </div>
      </div>

      <style>{`
        .cal-chip-short { display: none; }
        @media (max-width: 1100px) {
          .calendar-layout { grid-template-columns: 1fr !important; }
        }
        /* Telefon: kolumna miesiąca ma ~45 px. Pełna etykieta płatności ustępuje miejsca
           skróconej kwocie, a same komórki dostają mniej paddingu i niższy próg wysokości. */
        @media (max-width: 700px) {
          .cal-chip-pay .cal-chip-full { display: none; }
          .cal-chip-pay .cal-chip-short { display: inline; }
        }
      `}</style>
    </div>
  );
}

// --- Toolbar ------------------------------------------------
type ToolbarProps = {
  label: string;
  eventCount: number;
  mode: Mode;
  onMode: (m: Mode) => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
  scope: Scope;
  onScope: (s: Scope) => void;
  showPayments: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
};

function CalendarToolbar({ label, eventCount, mode, onMode, filters, setFilters, scope, onScope, showPayments, onPrev, onNext, onToday }: ToolbarProps) {
  // Chip „Płatności" istnieje tylko dla uprawnionych — inaczej mrugałby pustą kategorią,
  // bo backend i tak nie przyśle ani jednego takiego zdarzenia.
  const chipTypes = (Object.keys(EVENT_META) as EventType[]).filter(k => k !== "PAYMENT" || showPayments);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      padding: "12px 16px",
      background: "var(--surface-1)",
      border: "1px solid var(--border-soft)",
      borderRadius: "var(--r-lg)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button onClick={onPrev} style={iconBtnSmall}><I.ChevronR size={14} style={{ transform: "rotate(180deg)" }}/></button>
        <button onClick={onNext} style={iconBtnSmall}><I.ChevronR size={14}/></button>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", textTransform: "capitalize" }}>{label}</h2>
        <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{eventCount} wydarzeń</span>
      </div>
      <button onClick={onToday} style={{
        padding: "6px 11px", fontSize: 11, fontWeight: 600,
        background: "var(--surface-2)", border: "1px solid var(--border-soft)",
        color: "var(--text-hi)", borderRadius: 6,
      }}>Dziś</button>

      <div style={{ flex: 1 }}/>

      {/* Zakres SKU: obserwowane / aktywne (dostawy i płatności zawsze widoczne) */}
      <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 7 }}>
        {([
          { key: "watched" as Scope, label: "Obserwowane", icon: true },
          { key: "active" as Scope, label: "Aktywne", icon: false },
        ]).map(({ key, label: lbl, icon }) => {
          const active = scope === key;
          return (
            <button key={key} onClick={() => onScope(key)} title={
              key === "watched" ? "Tylko obserwowane SKU (gwiazdka)" : "Wszystkie aktywne SKU"
            } style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 5,
              background: active ? "var(--surface-3)" : "transparent",
              color: active ? "var(--text-hi)" : "var(--text-disabled)",
              border: "none", cursor: "pointer",
            }}>
              {icon && <I.StarFill size={11} style={{ color: active ? "var(--accent)" : "var(--text-disabled)" }}/>}
              {lbl}
            </button>
          );
        })}
      </div>

      {/* Filter chips */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {chipTypes.map((key) => {
          const meta = EVENT_META[key];
          const on = filters[key];
          return (
            <button key={key} onClick={() => setFilters({ ...filters, [key]: !on })} style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "5px 11px",
              fontSize: 11, fontWeight: 600,
              background: on ? meta.bg : "transparent",
              color: on ? meta.fg : "var(--text-disabled)",
              border: `1px solid ${on ? "transparent" : "var(--border-soft)"}`,
              borderRadius: 999,
              transition: "all 0.12s",
              opacity: on ? 1 : 0.65,
            }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: on ? meta.dot : "var(--text-disabled)" }}/>
              {meta.label}
            </button>
          );
        })}
      </div>

      {/* Przełącznik trybu */}
      <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 7 }}>
        {(["month", "week", "day"] as Mode[]).map((m) => {
          const active = mode === m;
          return (
            <button key={m} onClick={() => onMode(m)} style={{
              padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 5,
              background: active ? "var(--surface-3)" : "transparent",
              color: active ? "var(--text-hi)" : "var(--text-disabled)",
              border: "none", cursor: "pointer",
            }}>{MODE_LABEL[m]}</button>
          );
        })}
      </div>
    </div>
  );
}

// --- Handlery drop dla dnia (wspólne dla siatki miesiąca i tygodnia) ---
// Bez preventDefault w onDragOver przeglądarka nigdy nie wywoła onDrop — to nie jest kosmetyka.
function dropHandlers(dayKey: string, drag: DragCtx | null) {
  if (!drag) return {};
  return {
    onDragOver: (ev: React.DragEvent) => {
      if (!drag.active.current) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      if (drag.dropTarget !== dayKey) drag.setDropTarget(dayKey);
    },
    onDragLeave: () => { if (drag.dropTarget === dayKey) drag.setDropTarget(null); },
    onDrop: (ev: React.DragEvent) => { ev.preventDefault(); drag.onDropDay(dayKey); },
  };
}

// --- Siatka miesiąca ----------------------------------------
function MonthGrid({ cells, eventsByDate, todayKey, selected, onSelect, onPayClick, drag }: {
  cells: DayCellData[]; eventsByDate: Record<string, CalEvent[]>; todayKey: string; selected: string;
  onSelect: (k: string) => void; onPayClick: (e: CalEvent) => void; drag: DragCtx | null;
}) {
  return (
    <Card>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", borderBottom: "1px solid var(--border-soft)" }}>
        {DAY_NAMES.map((d, i) => (
          <div key={d} style={{
            padding: "10px 12px", fontSize: 10, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: "0.08em",
            color: i >= 5 ? "var(--text-disabled)" : "var(--text-lo)",
            background: "var(--surface-1)",
          }}>{d}</div>
        ))}
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
        gridAutoRows: "minmax(108px, 1fr)", background: "var(--border-soft)", gap: 1,
      }}>
        {cells.map(c => (
          <DayCell
            key={c.key}
            cell={c}
            events={eventsByDate[c.key] || []}
            isToday={c.key === todayKey}
            isSelected={c.key === selected}
            onSelect={() => onSelect(c.key)}
            onPayClick={onPayClick}
            drag={drag}
          />
        ))}
      </div>
    </Card>
  );
}

// --- Komórka dnia (miesiąc) ---------------------------------
function DayCell({ cell, events, isToday, isSelected, onSelect, onPayClick, drag }: {
  cell: DayCellData; events: CalEvent[]; isToday: boolean; isSelected: boolean;
  onSelect: () => void; onPayClick: (e: CalEvent) => void; drag: DragCtx | null;
}) {
  const visible = events.slice(0, 3);
  const extra = events.length - visible.length;
  const isDropTarget = drag?.dropTarget === cell.key;
  const baseBg = cell.outMonth ? "var(--bg)" : (isSelected ? "var(--surface-2)" : "var(--surface-1)");
  return (
    <div onClick={onSelect} {...dropHandlers(cell.key, drag)} style={{
      background: isDropTarget ? "var(--anomaly-soft)" : baseBg,
      padding: 6, cursor: "pointer", position: "relative", transition: "background 0.12s",
      // minWidth:0 — bez tego grid item nie zejdzie poniżej szerokości swojej treści
      // i długi chip (np. płatność) rozpycha całą siatkę zamiast się przyciąć.
      display: "flex", flexDirection: "column", gap: 3, minHeight: 0, minWidth: 0,
    }}
      onMouseEnter={(e) => { if (!isSelected && !isDropTarget) e.currentTarget.style.background = "var(--surface-2)"; }}
      onMouseLeave={(e) => { if (!isSelected && !isDropTarget) e.currentTarget.style.background = cell.outMonth ? "var(--bg)" : "var(--surface-1)"; }}>

      {(isSelected || isDropTarget) && (
        <span style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          boxShadow: isDropTarget ? "inset 0 0 0 2px var(--anomaly)" : "inset 0 0 0 1px var(--accent)",
        }}/>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 0" }}>
        <span className="num" style={{
          fontSize: 12, fontWeight: 600,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 22, height: 22, borderRadius: 99,
          background: isToday ? "var(--accent)" : "transparent",
          color: isToday
            ? "var(--accent-ink)"
            : (cell.outMonth ? "var(--text-disabled)" : (cell.weekend ? "var(--text-lo)" : "var(--text-hi)")),
        }}>{cell.day}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
        {visible.map((e, i) => <EventChip key={i} event={e} onPayClick={onPayClick} drag={drag}/>)}
        {extra > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-lo)", padding: "0 4px" }}>+{extra} więcej</span>
        )}
      </div>
    </div>
  );
}

// --- Siatka tygodnia ----------------------------------------
function WeekGrid({ weekDays, eventsByDate, todayKey, selected, onSelect, onPayClick, drag }: {
  weekDays: Date[]; eventsByDate: Record<string, CalEvent[]>; todayKey: string; selected: string;
  onSelect: (k: string) => void; onPayClick: (e: CalEvent) => void; drag: DragCtx | null;
}) {
  return (
    <Card>
      {/* Nagłówek: nazwa dnia + numer */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", borderBottom: "1px solid var(--border-soft)" }}>
        {weekDays.map((d, i) => {
          const isToday = dKey(d) === todayKey;
          return (
            <div key={i} style={{
              padding: "8px 10px", display: "flex", alignItems: "center", gap: 6,
              background: "var(--surface-1)",
            }}>
              <span style={{
                fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em",
                color: i >= 5 ? "var(--text-disabled)" : "var(--text-lo)",
              }}>{DAY_NAMES[i]}</span>
              <span className="num" style={{
                fontSize: 12, fontWeight: 600,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, borderRadius: 99,
                background: isToday ? "var(--accent)" : "transparent",
                color: isToday ? "var(--accent-ink)" : "var(--text-hi)",
              }}>{d.getDate()}</span>
            </div>
          );
        })}
      </div>
      {/* Kolumny dni — pełna lista zdarzeń, przewijalna */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", background: "var(--border-soft)", gap: 1 }}>
        {weekDays.map((d, i) => {
          const key = dKey(d);
          const evs = eventsByDate[key] || [];
          const isSelected = key === selected;
          const isDropTarget = drag?.dropTarget === key;
          return (
            <div key={i} onClick={() => onSelect(key)} {...dropHandlers(key, drag)} style={{
              background: isDropTarget ? "var(--anomaly-soft)" : (isSelected ? "var(--surface-2)" : "var(--surface-1)"),
              minHeight: 440, maxHeight: 560, overflowY: "auto",
              padding: 8, cursor: "pointer", position: "relative",
              display: "flex", flexDirection: "column", gap: 4, minWidth: 0,
            }}
              onMouseEnter={(e) => { if (!isSelected && !isDropTarget) e.currentTarget.style.background = "var(--surface-2)"; }}
              onMouseLeave={(e) => { if (!isSelected && !isDropTarget) e.currentTarget.style.background = "var(--surface-1)"; }}>
              {(isSelected || isDropTarget) && (
                <span style={{
                  position: "absolute", inset: 0, pointerEvents: "none",
                  boxShadow: isDropTarget ? "inset 0 0 0 2px var(--anomaly)" : "inset 0 0 0 1px var(--accent)",
                }}/>
              )}
              {evs.length === 0
                ? <span style={{ fontSize: 10, color: "var(--text-disabled)", padding: "2px 4px" }}>—</span>
                : evs.map((e, j) => <EventChip key={j} event={e} onPayClick={onPayClick} drag={drag}/>)}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// --- Szczegół dnia (panel boczny / tryb Dzień) --------------
function DayDetail({ dateKey, events, todayKey, loading, openPay, onTogglePay, onOpenContainer }: {
  dateKey: string; events: CalEvent[]; todayKey: string; loading: boolean;
  openPay: string | null; onTogglePay: (k: string | null) => void; onOpenContainer?: (id: number) => void;
}) {
  const d = parseLocal(dateKey);
  return (
    <>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-soft)" }}>
        <div style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
          {d.toLocaleDateString("pl-PL", { weekday: "long" })}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
          <span className="num" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{d.getDate()}</span>
          <span style={{ fontSize: 13, color: "var(--text-mid)" }}>
            {MONTH_NAMES[d.getMonth()]} {d.getFullYear()}
          </span>
          {dateKey === todayKey && <Pill bg="var(--accent-soft)" fg="var(--accent)" size="sm">DZIŚ</Pill>}
        </div>
      </div>
      <div>
        {events.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
            {loading ? "Ładowanie…" : "Brak wydarzeń tego dnia"}
          </div>
        ) : events.map((e, i) => (
          <EventRow key={i} event={e} isLast={i === events.length - 1}
                    openPay={openPay} onTogglePay={onTogglePay} onOpenContainer={onOpenContainer}/>
        ))}
      </div>
    </>
  );
}

// --- Chip zdarzenia (komórka) -------------------------------
// Płatność jest przeciągalna (gdy user ma editContainers) i klikalna — klik rozwija
// szczegół w panelu bocznym, a nie otwiera od razu kontenera.
function EventChip({ event, onPayClick, drag }: { event: CalEvent; onPayClick: (e: CalEvent) => void; drag: DragCtx | null }) {
  const meta = EVENT_META[event.type];
  const isPay = event.type === "PAYMENT";
  const draggable = isPay && !!drag;
  return (
    <div
      draggable={draggable}
      onDragStart={draggable && drag ? (ev) => {
        drag.onDragStart(event);
        ev.dataTransfer.effectAllowed = "move";
        // Firefox NIE rozpocznie przeciągania bez setData — bez tej linii chip jest tam
        // całkowicie martwy, mimo poprawnych uprawnień. Treść nieistotna, liczy się wywołanie.
        try { ev.dataTransfer.setData("text/plain", payKey(event)); } catch { /* starsze przeglądarki */ }
      } : undefined}
      onDragEnd={draggable && drag ? () => drag.onDragEnd() : undefined}
      onClick={isPay ? (ev) => { ev.stopPropagation(); onPayClick(event); } : undefined}
      title={isPay
        ? (draggable
            ? `${payLabel(event)} — przeciągnij, by zmienić termin płatności`
            : `${payLabel(event)} — przesuwanie terminu wymaga uprawnienia „Edycja kontenerów”`)
        : undefined}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "2px 5px",
        background: meta.bg, borderLeft: `2px solid ${meta.fg}`, borderRadius: 3,
        fontSize: 10, fontWeight: 500, color: meta.fg, overflow: "hidden",
        cursor: draggable ? "grab" : (isPay ? "pointer" : undefined),
        // Zaległa płatność musi krzyczeć nawet przy przewijaniu wstecz.
        boxShadow: event.overdue ? "inset 0 0 0 1px var(--critical)" : undefined,
      }} className={isPay ? "mono cal-chip-pay" : "mono"}>
      <span className="cal-chip-full" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {eventLabel(event)}
      </span>
      {/* Wariant skrócony — podmieniany CSS-em na wąskich ekranach, bez JS i bez ryzyka
          niezgodności przy hydratacji (obie wersje są w DOM od razu). */}
      {isPay && (
        <span className="cal-chip-short" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {payShort(event)}
        </span>
      )}
    </div>
  );
}

// --- Wiersz zdarzenia (szczegół dnia) -----------------------
// Dostawa jest klikalna → otwiera popup kontenera (przez onOpenContainer z page.tsx).
// Płatność rozwija tabelkę ze szczegółami (producent / kontener / PO / kwota / termin),
// a dopiero z niej przycisk prowadzi do kontenera — po zamknięciu popupu page.tsx wraca
// na kalendarz, a sessionStorage odtwarza ten sam dzień i tę samą rozwiniętą pozycję.
// Producent jest na 1 planie (eventLabel), numer kontenera + sztuki niżej (eventSub) —
// dlatego dolny chip producenta pokazujemy już tylko dla ORDER/EMPTY, gdzie producent
// nie ma innego miejsca; dla dostawy i płatności byłby zdublowaniem tytułu.
function EventRow({ event, isLast, openPay, onTogglePay, onOpenContainer }: {
  event: CalEvent; isLast: boolean; openPay: string | null;
  onTogglePay: (k: string | null) => void; onOpenContainer?: (id: number) => void;
}) {
  const meta = EVENT_META[event.type];
  const isPay = event.type === "PAYMENT";
  const k = isPay ? payKey(event) : "";
  const expanded = isPay && openPay === k;
  const clickable = isPay || (event.type === "DELIVERY" && event.container_id != null && !!onOpenContainer);

  const onClick = () => {
    if (isPay) { onTogglePay(expanded ? null : k); return; }
    if (event.container_id != null && onOpenContainer) onOpenContainer(event.container_id);
  };

  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        display: "flex", alignItems: "flex-start", gap: 12,
        padding: "12px 18px",
        borderBottom: isLast ? "none" : "1px solid var(--border-soft)",
        cursor: clickable ? "pointer" : "default",
        background: expanded ? "var(--surface-2)" : "transparent",
      }}
      onMouseEnter={(e) => { if (clickable && !expanded) e.currentTarget.style.background = "var(--surface-2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = expanded ? "var(--surface-2)" : "transparent"; }}>
      <div style={{ width: 3, alignSelf: "stretch", background: meta.dot, borderRadius: 2 }}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Pill bg={meta.bg} fg={meta.fg} size="sm">{isPay ? payKindLabel(event).toUpperCase() : meta.label}</Pill>
          {isPay && event.overdue && <Pill bg="var(--critical-soft)" fg="var(--critical)" size="sm">PO TERMINIE</Pill>}
          {isPay && event.shop_name && <Pill bg="var(--surface-3)" fg="var(--text-mid)" size="sm">{event.shop_name}</Pill>}
          {event.qty ? <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>×{event.qty}</span> : null}
        </div>
        <div className="mono" style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>{eventLabel(event)}</div>
        <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>{eventSub(event)}</div>
        {event.type !== "DELIVERY" && event.type !== "PAYMENT" && event.manufacturer_name && (
          <div style={{ marginTop: 6 }}>
            <MfrChip name={event.manufacturer_name} color={event.manufacturer_color || "var(--text-lo)"}/>
          </div>
        )}
        {expanded && <PaymentDetail event={event} onOpenContainer={onOpenContainer}/>}
      </div>
    </div>
  );
}

// --- Rozwinięty szczegół płatności --------------------------
function PaymentDetail({ event, onOpenContainer }: { event: CalEvent; onOpenContainer?: (id: number) => void }) {
  const nr = isDraftNumber(event.container_number) ? null : (event.container_number || null);
  const rows: Array<[string, string, React.CSSProperties | undefined, string | undefined]> = [
    ["Producent", event.manufacturer_name || "Bez producenta", undefined, undefined],
    ["Nr kontenera", nr || "—", undefined, undefined],
    ["Nr PO", event.order_number || "—", undefined, undefined],
    ["Typ", payKindLabel(event), undefined, undefined],
    ["Kwota", payAmount(event), { color: "var(--anomaly)", fontWeight: 600 }, undefined],
  ];

  // Wartość w PLN jest z definicji SZACUNKIEM — płatność jeszcze nie wyszła, więc kursu z dnia
  // wpłaty nie ma. Stąd „≈" i kurs w tooltipie, dokładnie jak w zakładce „Do zapłaty".
  // Dla zobowiązań już w PLN nie ma czego przeliczać, więc wiersz pomijamy.
  if (event.kwota_pln != null && (event.waluta || "USD") !== "PLN") {
    rows.push([
      "Wartość PLN",
      `≈ ${fmtPLN(event.kwota_pln)}`,
      { color: "var(--text-mid)" },
      event.kurs ? `Szacunek po dzisiejszym kursie NBP: ${event.kurs.toString().replace(".", ",")}` : undefined,
    ]);
  }

  rows.push(
    ["Termin",
      event.termin ? parseLocal(event.termin).toLocaleDateString("pl-PL", { day: "numeric", month: "long", year: "numeric" }) : "bez terminu",
      event.overdue ? { color: "var(--critical)" } : undefined, undefined],
    ["Firma", event.shop_name || "—", undefined, undefined],
  );

  return (
    // stopPropagation: klik w tabelkę nie może zwijać wiersza, który ją zawiera.
    <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10 }}>
      <div style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", overflow: "hidden" }}>
        {rows.map(([lbl, value, extra, tip], i) => (
          <div key={lbl} style={{
            display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center",
            borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--border-soft)",
          }}>
            <span style={{
              padding: "6px 10px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em",
              color: "var(--text-lo)", background: "var(--surface-2)", whiteSpace: "nowrap",
            }}>{lbl}</span>
            <span className="mono" title={tip} style={{
              padding: "6px 10px", fontSize: 11, textAlign: "right",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(extra || {}),
            }}>{value}</span>
          </div>
        ))}
      </div>
      {event.container_id != null && onOpenContainer && (
        <button onClick={() => onOpenContainer(event.container_id as number)} style={{
          display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8,
          padding: "6px 11px", fontSize: 11, fontWeight: 600,
          background: "var(--surface-3)", border: "1px solid var(--border)",
          color: "var(--text-hi)", borderRadius: 6, cursor: "pointer",
        }}>
          Otwórz kontener <I.ArrowRight size={12}/>
        </button>
      )}
    </div>
  );
}

// --- Płatności bez ustalonego terminu -----------------------
// Nie mają daty, więc w siatce nie istnieją — ale zapomniane zobowiązanie jest gorsze
// niż zaległe. Przeciągnięcie na dzień ustawia termin po raz pierwszy.
function NoTermPayments({ items, canDrag, drag, onPick }: {
  items: CalEvent[]; canDrag: boolean; drag: DragCtx | null; onPick: (e: CalEvent) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader icon={<I.Wallet size={14}/>} title="Płatności bez terminu" hint={`${items.length} poz.`}/>
      <div style={{
        padding: "8px 18px", fontSize: 10, color: "var(--text-lo)",
        background: "var(--surface-2)", borderBottom: "1px solid var(--border-soft)",
      }}>
        {canDrag
          ? "Przeciągnij pozycję na dzień w kalendarzu, żeby ustawić termin płatności."
          : "Brak uprawnienia do edycji kontenerów — pozycje tylko do podglądu."}
      </div>
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {items.map((e, i) => (
          <div
            key={payKey(e)}
            draggable={canDrag && !!drag}
            onDragStart={canDrag && drag ? (ev) => {
              drag.onDragStart(e);
              ev.dataTransfer.effectAllowed = "move";
              // Patrz komentarz w EventChip — bez setData Firefox nie startuje przeciągania.
              try { ev.dataTransfer.setData("text/plain", payKey(e)); } catch { /* starsze przeglądarki */ }
            } : undefined}
            onDragEnd={canDrag && drag ? () => drag.onDragEnd() : undefined}
            onClick={() => onPick(e)}
            style={{
              display: "flex", alignItems: "center", gap: 9,
              padding: "9px 18px",
              borderBottom: i === items.length - 1 ? "none" : "1px solid var(--border-soft)",
              cursor: canDrag ? "grab" : "pointer",
            }}
            onMouseEnter={(ev) => ev.currentTarget.style.background = "var(--surface-2)"}
            onMouseLeave={(ev) => ev.currentTarget.style.background = "transparent"}>
            <span style={{ color: "var(--text-disabled)", fontSize: 11, flexShrink: 0, lineHeight: 1 }}>
              {canDrag ? "⠿" : "·"}
            </span>
            <span className="mono" style={{
              fontSize: 11, fontWeight: 600, flex: 1, minWidth: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {e.manufacturer_name || "Bez producenta"}
              <span style={{ color: "var(--text-lo)", fontWeight: 400 }}>
                {" · "}{payKindLabel(e).toLowerCase()}{e.order_number ? ` · ${e.order_number}` : ""}
              </span>
            </span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--anomaly)", flexShrink: 0 }}>
              {payAmount(e)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --- Agenda --------------------------------------------------
function AgendaDateHeader({ date, todayKey }: { date: Date; todayKey: string }) {
  const key = dKey(date);
  const isToday = key === todayKey;
  const todayD = new Date(); todayD.setHours(0, 0, 0, 0);
  const diff = Math.round((date.getTime() - todayD.getTime()) / 86400000);
  const relLabel = diff === 0 ? "DZIŚ" : diff === 1 ? "JUTRO" : `ZA ${diff}D`;
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 18px 4px",
      borderTop: "1px solid var(--border-soft)",
      background: "var(--bg-elevated)",
      position: "sticky", top: 0, zIndex: 1,
    }}>
      <span className="num" style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)" }}>
        {date.toLocaleDateString("pl-PL", { weekday: "short", day: "numeric", month: "short" })}
      </span>
      <span className="num" style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", color: isToday ? "var(--accent)" : "var(--text-lo)" }}>
        {relLabel}
      </span>
    </div>
  );
}

function AgendaRow({ event, onClick }: { event: CalEvent; onClick: () => void }) {
  const meta = EVENT_META[event.type];
  return (
    <div onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", cursor: "pointer",
    }}
      onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-2)"}
      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: meta.dot, flexShrink: 0 }}/>
      {/* Etykieta płatności bywa długa (producent + kwota + waluta), więc w odróżnieniu
          od krótkich SKU musi mieć prawo się skurczyć — inaczej rozpycha wiersz na telefonie. */}
      <span className="mono" style={{
        fontSize: 11, fontWeight: 600,
        flexShrink: event.type === "PAYMENT" ? 1 : 0,
        minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{eventLabel(event)}</span>
      <span style={{ fontSize: 11, color: "var(--text-lo)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {eventSub(event)}
      </span>
    </div>
  );
}

const iconBtnSmall: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 28, height: 28,
  background: "var(--surface-2)",
  border: "1px solid var(--border-soft)",
  borderRadius: 6,
  color: "var(--text-mid)",
};

export { Calendar };
export default Calendar;
