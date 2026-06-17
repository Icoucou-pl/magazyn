"use client";
// ============================================================
// MAGAZYN — Kalendarz (etap 4A). Port calendar.jsx → .tsx.
//   Wygląd 1:1 z mocka, dane z realnego API: GET /calendar.
//   Mapowanie pól mocka → kontrakt backendu:
//     DELIVERY: event.container → container_number, event.units → total_units,
//               event.carrier (nie istnieje) → manufacturer_name,
//               event.mfrId → manufacturer_name + manufacturer_color (MfrChip).
//     ORDER/EMPTY: event.mfrId → manufacturer_name + manufacturer_color,
//               event.qty (sugerowana ilość, 6-mies. pokrycie) dochodzi z backendu.
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, Card, CardHeader, Pill, MfrChip } from "./ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { fmtNum } from "@/lib/format";

// ── Typy ─────────────────────────────────────────────────────
type EventType = "ORDER" | "EMPTY" | "DELIVERY";

type CalEvent = {
  date: string;
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
  // wspólne (producent)
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

// ── Meta / stałe ─────────────────────────────────────────────
const EVENT_META: Record<EventType, EventMeta> = {
  ORDER:    { label: "Zamów do",      fg: "var(--warning)",  bg: "var(--warning-soft)",  dot: "var(--warning)" },
  EMPTY:    { label: "Koniec zapasu", fg: "var(--critical)", bg: "var(--critical-soft)", dot: "var(--critical)" },
  DELIVERY: { label: "Dostawa",       fg: "var(--info)",     bg: "var(--info-soft)",     dot: "var(--info)" },
};

const MONTH_NAMES = ["Styczeń","Luty","Marzec","Kwiecień","Maj","Czerwiec","Lipiec","Sierpień","Wrzesień","Październik","Listopad","Grudzień"];
const DAY_NAMES   = ["Pn","Wt","Śr","Cz","Pt","Sb","Nd"];

// Local-tz date key (toISOString uses UTC — wrong in UTC+2 evenings)
const dKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Parse 'YYYY-MM-DD' as LOCAL midnight (default constructor would parse it as UTC)
const parseLocal = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

// Etykieta zdarzenia: dostawa pokazuje numer kontenera, reszta SKU
const eventLabel = (e: CalEvent) => (e.type === "DELIVERY" ? e.container_number ?? "" : e.sku ?? "");
// Podtytuł: dostawa → "producent · N szt", reszta → nazwa produktu
const eventSub = (e: CalEvent) =>
  e.type === "DELIVERY"
    ? `${e.manufacturer_name ?? "Dostawa"} · ${fmtNum(e.total_units)} szt`
    : e.name ?? "";

// ── Widok główny ─────────────────────────────────────────────
function Calendar({ density }: { density?: string }) {
  void density; // gęstość nie wpływa na układ kalendarza — zachowane dla spójności propsów widoków

  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(dKey(new Date()));
  const [filters, setFilters] = useState<Filters>({ ORDER: true, EMPTY: true, DELIVERY: true });

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await api.get("/calendar");
        if (mounted) setEvents(Array.isArray(data) ? (data as CalEvent[]) : []);
      } catch {
        if (mounted) { setEvents([]); toast("Nie udało się pobrać kalendarza", "error"); }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const todayKey = dKey(new Date());

  // Build 6-week grid (always 42 cells) — fills with prev/next month
  const cells = useMemo<DayCellData[]>(() => {
    const firstDay = new Date(year, month, 1);
    const startWeekday = (firstDay.getDay() + 6) % 7; // Mon=0
    const result: DayCellData[] = [];
    const start = new Date(year, month, 1 - startWeekday);
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      result.push({
        date: d,
        key: dKey(d),
        day: d.getDate(),
        outMonth: d.getMonth() !== month,
        weekend: d.getDay() === 0 || d.getDay() === 6,
      });
    }
    return result;
  }, [year, month]);

  const eventsByDate = useMemo<Record<string, CalEvent[]>>(() => {
    const map: Record<string, CalEvent[]> = {};
    events.forEach(e => {
      if (!filters[e.type]) return;
      if (!map[e.date]) map[e.date] = [];
      map[e.date].push(e);
    });
    // Stable order: EMPTY > ORDER > DELIVERY within a day
    const rank: Record<EventType, number> = { EMPTY: 0, ORDER: 1, DELIVERY: 2 };
    Object.keys(map).forEach(k => map[k].sort((a, b) => rank[a.type] - rank[b.type]));
    return map;
  }, [events, filters]);

  const monthEventCount = useMemo(() => {
    return events.filter(e => {
      const d = parseLocal(e.date);
      return d.getFullYear() === year && d.getMonth() === month && filters[e.type];
    }).length;
  }, [events, year, month, filters]);

  const selectedEvents = (eventsByDate[selected] || []).slice();
  const selectedDate = parseLocal(selected);

  const goPrev  = () => setCursor(new Date(year, month - 1, 1));
  const goNext  = () => setCursor(new Date(year, month + 1, 1));
  const goToday = () => { const t = new Date(); setCursor(t); setSelected(dKey(t)); };

  // Agenda — najbliższe 3 tygodnie
  const agenda = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today); end.setDate(end.getDate() + 21);
    return events
      .filter(e => filters[e.type])
      .filter(e => {
        const ed = parseLocal(e.date);
        return ed >= today && ed <= end;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [events, filters]);

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 80 }}>
      {/* Toolbar */}
      <CalendarToolbar
        monthLabel={`${MONTH_NAMES[month]} ${year}`}
        eventCount={monthEventCount}
        filters={filters} setFilters={setFilters}
        onPrev={goPrev} onNext={goNext} onToday={goToday}
      />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 14 }} className="calendar-layout">
        {/* Main grid */}
        <Card>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
            borderBottom: "1px solid var(--border-soft)",
          }}>
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
            display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
            gridAutoRows: "minmax(108px, 1fr)",
            background: "var(--border-soft)",
            gap: 1,
          }}>
            {cells.map(c => (
              <DayCell
                key={c.key}
                cell={c}
                events={eventsByDate[c.key] || []}
                isToday={c.key === todayKey}
                isSelected={c.key === selected}
                onSelect={() => setSelected(c.key)}
              />
            ))}
          </div>
        </Card>

        {/* Side panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Selected day */}
          <Card>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-soft)" }}>
              <div style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                {selectedDate.toLocaleDateString("pl-PL", { weekday: "long" })}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
                <span className="num" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>
                  {selectedDate.getDate()}
                </span>
                <span style={{ fontSize: 13, color: "var(--text-mid)" }}>
                  {MONTH_NAMES[selectedDate.getMonth()]} {selectedDate.getFullYear()}
                </span>
                {selected === todayKey && <Pill bg="var(--accent-soft)" fg="var(--accent)" size="sm">DZIŚ</Pill>}
              </div>
            </div>
            <div>
              {selectedEvents.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
                  {loading ? "Ładowanie…" : "Brak wydarzeń tego dnia"}
                </div>
              ) : selectedEvents.map((e, i) => (
                <EventRow key={i} event={e} isLast={i === selectedEvents.length - 1}/>
              ))}
            </div>
          </Card>

          {/* Agenda */}
          <Card>
            <CardHeader
              icon={<I.Activity size={14}/>}
              title="Najbliższe 3 tygodnie"
              hint={`${agenda.length} wydarzeń`}
            />
            <div style={{ maxHeight: 360, overflowY: "auto" }}>
              {agenda.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
                  {loading ? "Ładowanie…" : "Brak wydarzeń"}
                </div>
              ) : agenda.map((e, i) => {
                const d = parseLocal(e.date);
                const showHead = i === 0 || agenda[i - 1].date !== e.date;
                return (
                  <React.Fragment key={i}>
                    {showHead && <AgendaDateHeader date={d} todayKey={todayKey}/>}
                    <AgendaRow event={e} onClick={() => setSelected(e.date)}/>
                  </React.Fragment>
                );
              })}
            </div>
          </Card>
        </div>
      </div>

      <style>{`
        @media (max-width: 1100px) {
          .calendar-layout { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

// --- Toolbar ------------------------------------------------
type ToolbarProps = {
  monthLabel: string;
  eventCount: number;
  filters: Filters;
  setFilters: (f: Filters) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
};

function CalendarToolbar({ monthLabel, eventCount, filters, setFilters, onPrev, onNext, onToday }: ToolbarProps) {
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
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>{monthLabel}</h2>
        <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{eventCount} wydarzeń</span>
      </div>
      <button onClick={onToday} style={{
        padding: "6px 11px", fontSize: 11, fontWeight: 600,
        background: "var(--surface-2)", border: "1px solid var(--border-soft)",
        color: "var(--text-hi)", borderRadius: 6,
      }}>Dziś</button>

      <div style={{ flex: 1 }}/>

      {/* Filter chips */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(Object.entries(EVENT_META) as [EventType, EventMeta][]).map(([key, meta]) => {
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

      <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 7 }}>
        {["Mies", "Tydz", "Dzień"].map((v, i) => (
          <button key={v} disabled={i > 0} style={{
            padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 5,
            background: i === 0 ? "var(--surface-3)" : "transparent",
            color: i === 0 ? "var(--text-hi)" : "var(--text-disabled)",
            border: "none",
            cursor: i === 0 ? "pointer" : "not-allowed",
          }}>{v}</button>
        ))}
      </div>
    </div>
  );
}

// --- Day cell -----------------------------------------------
function DayCell({ cell, events, isToday, isSelected, onSelect }: {
  cell: DayCellData; events: CalEvent[]; isToday: boolean; isSelected: boolean; onSelect: () => void;
}) {
  const visible = events.slice(0, 3);
  const extra = events.length - visible.length;
  return (
    <div onClick={onSelect} style={{
      background: cell.outMonth ? "var(--bg)" : (isSelected ? "var(--surface-2)" : "var(--surface-1)"),
      padding: 6,
      cursor: "pointer",
      position: "relative",
      transition: "background 0.12s",
      display: "flex", flexDirection: "column", gap: 3,
      minHeight: 0,
    }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--surface-2)"; }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = cell.outMonth ? "var(--bg)" : "var(--surface-1)"; }}>

      {/* Selected ring */}
      {isSelected && (
        <span style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          boxShadow: "inset 0 0 0 1px var(--accent)",
        }}/>
      )}

      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "2px 4px 0",
      }}>
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
        {visible.map((e, i) => <EventChip key={i} event={e}/>)}
        {extra > 0 && (
          <span style={{
            fontSize: 10, color: "var(--text-lo)",
            padding: "0 4px",
          }}>+{extra} więcej</span>
        )}
      </div>
    </div>
  );
}

function EventChip({ event }: { event: CalEvent }) {
  const meta = EVENT_META[event.type];
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 4,
      padding: "2px 5px",
      background: meta.bg,
      borderLeft: `2px solid ${meta.fg}`,
      borderRadius: 3,
      fontSize: 10, fontWeight: 500,
      color: meta.fg,
      overflow: "hidden",
    }} className="mono">
      <span style={{
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{eventLabel(event)}</span>
    </div>
  );
}

// --- Selected day event row --------------------------------
function EventRow({ event, isLast }: { event: CalEvent; isLast: boolean }) {
  const meta = EVENT_META[event.type];
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12,
      padding: "12px 18px",
      borderBottom: isLast ? "none" : "1px solid var(--border-soft)",
      cursor: "pointer",
    }}
      onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-2)"}
      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
      <div style={{ width: 3, alignSelf: "stretch", background: meta.dot, borderRadius: 2 }}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Pill bg={meta.bg} fg={meta.fg} size="sm">{meta.label}</Pill>
          {event.qty ? <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>×{event.qty}</span> : null}
        </div>
        <div className="mono" style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>{eventLabel(event)}</div>
        <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>{eventSub(event)}</div>
        {event.manufacturer_name && (
          <div style={{ marginTop: 6 }}>
            <MfrChip name={event.manufacturer_name} color={event.manufacturer_color || "var(--text-lo)"}/>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Agenda items ---------------------------------------------
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
      <span className="num" style={{
        fontSize: 9, fontWeight: 700, letterSpacing: "0.05em",
        color: isToday ? "var(--accent)" : "var(--text-lo)",
      }}>{relLabel}</span>
    </div>
  );
}

function AgendaRow({ event, onClick }: { event: CalEvent; onClick: () => void }) {
  const meta = EVENT_META[event.type];
  return (
    <div onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 18px", cursor: "pointer",
    }}
      onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-2)"}
      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: meta.dot, flexShrink: 0 }}/>
      <span className="mono" style={{ fontSize: 11, fontWeight: 600, flexShrink: 0 }}>{eventLabel(event)}</span>
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
