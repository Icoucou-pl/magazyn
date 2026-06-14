"use client";

// ============================================================
// MAGAZYN — UI primitives (icons, badges, cards)
// Konwersja ui.jsx → .tsx (etap 0.3). Wygląd 1:1.
//   - "use client" + importy zamiast Object.assign(window, ...)
//   - MOCK wyrzucony: MfrChip dostaje name+color przez propsy
//   - STATUS_META przeniesiony tutaj jako edytowalny zestaw
// Tokeny (--surface-*, --text-*, --accent, --ok, ...) pochodzą z design-systemu
// (globals.css), który scalamy w 0.4 — do tego czasu kolory mogą nie być widoczne.
// ============================================================

import React from "react";

// ── Typy ─────────────────────────────────────────────────────
export type IconProps = {
  size?: number;
  stroke?: number;
  fill?: string;
  children?: React.ReactNode;
  d?: string;
};

type Size = "sm" | "md";

// ── Icon base (stroke-based, hand-tuned for dark mode) ───────
const Icon = ({ d, size = 16, stroke = 1.6, fill = "none", children }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
       strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    {d ? <path d={d} /> : children}
  </svg>
);

export const I = {
  Dashboard: (p: IconProps) => <Icon {...p}><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></Icon>,
  Calendar:  (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></Icon>,
  Box:       (p: IconProps) => <Icon {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></Icon>,
  Ship:      (p: IconProps) => <Icon {...p}><path d="M2 20h.01M7 20h.01M12 20h.01M17 20h.01M22 20h.01M22 16l-1.296-1.296a2.41 2.41 0 0 0-3.408 0L16 16M2 16l1.296-1.296a2.41 2.41 0 0 1 3.408 0L8 16M8 16v-3M16 16v-3M3 13h18l-1.5-7h-15z"/></Icon>,
  Wallet:    (p: IconProps) => <Icon {...p}><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></Icon>,
  Settings:  (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></Icon>,
  Search:    (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></Icon>,
  Scan:      (p: IconProps) => <Icon {...p}><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8M19 8v8"/></Icon>,
  Refresh:   (p: IconProps) => <Icon {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></Icon>,
  Bell:      (p: IconProps) => <Icon {...p}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/></Icon>,
  Alert:     (p: IconProps) => <Icon {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"/></Icon>,
  Flame:     (p: IconProps) => <Icon {...p}><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></Icon>,
  Cart:      (p: IconProps) => <Icon {...p}><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></Icon>,
  Star:      (p: IconProps) => <Icon {...p}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></Icon>,
  StarFill:  (p: IconProps) => <Icon {...p} fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></Icon>,
  Activity:  (p: IconProps) => <Icon {...p}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></Icon>,
  Sparkles:  (p: IconProps) => <Icon {...p}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></Icon>,
  TrendUp:   (p: IconProps) => <Icon {...p}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></Icon>,
  TrendDown: (p: IconProps) => <Icon {...p}><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></Icon>,
  ArrowRight:(p: IconProps) => <Icon {...p}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></Icon>,
  ArrowUp:   (p: IconProps) => <Icon {...p}><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 5 5 12"/></Icon>,
  ArrowDown: (p: IconProps) => <Icon {...p}><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 19 19 12"/></Icon>,
  ChevronR:  (p: IconProps) => <Icon {...p}><polyline points="9 18 15 12 9 6"/></Icon>,
  ChevronD:  (p: IconProps) => <Icon {...p}><polyline points="6 9 12 15 18 9"/></Icon>,
  Plus:      (p: IconProps) => <Icon {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></Icon>,
  Close:     (p: IconProps) => <Icon {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></Icon>,
  Menu:      (p: IconProps) => <Icon {...p}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></Icon>,
  Factory:   (p: IconProps) => <Icon {...p}><path d="M2 20h20M4 20V8l6 4V8l6 4V8l4 2v10M8 14h.01M14 14h.01M14 18h.01M8 18h.01"/></Icon>,
  Wand:      (p: IconProps) => <Icon {...p}><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h0M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/></Icon>,
  Flask:     (p: IconProps) => <Icon {...p}><path d="M10 2v7.31M14 9.3V1.99M8.5 2h7M14 9.3a6.5 6.5 0 1 1-4 0M5.52 16h12.96"/></Icon>,
  Logout:    (p: IconProps) => <Icon {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></Icon>,
  External:  (p: IconProps) => <Icon {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></Icon>,
  Dot:       (p: IconProps) => <Icon {...p} fill="currentColor"><circle cx="12" cy="12" r="3"/></Icon>,
  Sun:       (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></Icon>,
  Moon:      (p: IconProps) => <Icon {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></Icon>,
};

// ── Pill / Badge ─────────────────────────────────────────────
export type PillProps = {
  children?: React.ReactNode;
  bg?: string;
  fg?: string;
  dot?: string;
  mono?: boolean;
  size?: Size;
};

export function Pill({ children, bg, fg, dot, mono, size = "md" }: PillProps) {
  const padding = size === "sm" ? "2px 7px" : "3px 9px";
  const fontSize = size === "sm" ? 10 : 11;
  return (
    <span className={mono ? "mono" : ""} style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding, fontSize, fontWeight: 600, letterSpacing: "0.02em",
      background: bg || "var(--surface-2)",
      color: fg || "var(--text-mid)",
      borderRadius: 999,
      whiteSpace: "nowrap", textTransform: mono ? "none" : "uppercase",
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: dot, flexShrink: 0 }}/>}
      {children}
    </span>
  );
}

// ── Statusy stanu produktu (1:1 z mock-data.jsx → window.STATUS_META) ──
export type StatusMeta = { label: string; bg: string; fg: string; dot: string };

export const STATUS_META: Record<string, StatusMeta> = {
  KRYTYCZNY:     { label: "KRYTYCZNY",     bg: "var(--critical-soft)", fg: "var(--critical)", dot: "var(--critical)" },
  ZAMOW_TERAZ:   { label: "ZAMÓW TERAZ",   bg: "var(--warning-soft)",  fg: "var(--warning)",  dot: "var(--warning)" },
  ZAMOW_WKROTCE: { label: "ZAMÓW WKRÓTCE", bg: "var(--pending-soft)",  fg: "var(--pending)",  dot: "var(--pending)" },
  OK:            { label: "OK",            bg: "var(--ok-soft)",       fg: "var(--ok)",       dot: "var(--ok)" },
};

export function StatusPill({ status, size = "md" }: { status: string; size?: Size }) {
  const meta = STATUS_META[status];
  if (!meta) return null;
  return <Pill bg={meta.bg} fg={meta.fg} dot={meta.dot} size={size}>{meta.label}</Pill>;
}

// ── Statusy kontenera (1:1 z mock-data.jsx → window.CONTAINER_STATUS_META) ──
// Uwaga: bez bg — w mocku kontener renderuje samo fg + kropkę. Przyda się w etapie 3.
export type ContainerStatusMeta = { label: string; fg: string; dot: string };

export const CONTAINER_STATUS_META: Record<string, ContainerStatusMeta> = {
  ORDERED:       { label: "Zamówione",   fg: "var(--text-mid)", dot: "var(--text-mid)" },
  IN_PRODUCTION: { label: "W produkcji", fg: "var(--anomaly)",  dot: "var(--anomaly)" },
  IN_TRANSIT:    { label: "W drodze",    fg: "var(--info)",     dot: "var(--info)" },
  DELIVERED:     { label: "Dostarczone", fg: "var(--ok)",       dot: "var(--ok)" },
};

// ── MfrChip (czysty — bez MOCK) ──────────────────────────────
// Dawniej: <MfrChip id={...}/> i szukało w MOCK.manufacturers.
// Teraz pobiera name+color przez propsy. Przy budowie produktów/kontenerów
// (etap 2/3) rozwiążemy id → {name, color} na podstawie danych z /manufacturers.
// Typ 1:1 z mock-data.jsx (color = oklch(...), działa w color-mix).
export type Manufacturer = {
  id: number;
  name: string;
  color: string;
  email?: string;
  contact?: string;
  notes?: string;
  skuCount?: number;
  openOrders?: number;
};

export function MfrChip({ name, color, size = "sm" }: { name: string; color: string; size?: Size }) {
  if (!name) return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: size === "sm" ? "2px 7px" : "3px 9px",
      fontSize: size === "sm" ? 10 : 11, fontWeight: 600,
      borderRadius: 999,
      background: "color-mix(in oklch, " + color + " 15%, transparent)",
      color,
      whiteSpace: "nowrap",
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: color }}/>
      {name}
    </span>
  );
}

// ── Card shell ───────────────────────────────────────────────
export type CardProps = {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  padding?: number | string;
  className?: string;
};

export function Card({ children, style, padding = 0, className = "" }: CardProps) {
  return (
    <div className={className} style={{
      background: "var(--surface-1)",
      border: "1px solid var(--border-soft)",
      borderRadius: "var(--r-lg)",
      overflow: "hidden",
      padding,
      ...style,
    }}>{children}</div>
  );
}

export type CardHeaderProps = {
  icon?: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  accent?: string;
};

export function CardHeader({ icon, title, hint, action, accent }: CardHeaderProps) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "14px 18px",
      borderBottom: "1px solid var(--border-soft)",
      gap: 12, flexWrap: "wrap",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        {icon && <span style={{ color: accent || "var(--text-mid)" }}>{icon}</span>}
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: "0.01em", color: "var(--text-hi)" }}>{title}</h3>
        {hint && <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{hint}</span>}
      </div>
      {action}
    </div>
  );
}

// ── Hover row (spójne interakcje list) ───────────────────────
export type HoverRowProps = {
  children?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
};

export function HoverRow({ children, onClick, style }: HoverRowProps) {
  return (
    <div onClick={onClick} role="button" tabIndex={0}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "11px 18px",
        cursor: "pointer", transition: "background 0.12s ease",
        borderBottom: "1px solid var(--border-soft)",
        ...style,
      }}>{children}</div>
  );
}

// ── Avatar (inicjały, gradient) ──────────────────────────────
export function Avatar({ initials, size = 28 }: { initials: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: 99,
      background: "linear-gradient(135deg, var(--accent) 0%, color-mix(in oklch, var(--accent) 60%, var(--anomaly)) 100%)",
      color: "var(--accent-ink)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.42, fontWeight: 700,
      flexShrink: 0,
    }}>{initials}</div>
  );
}
