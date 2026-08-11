"use client";

// ============================================================
// MAGAZYN — Toast notifications + CSV export (Windows-1250)
// Konwersja toast.jsx → .tsx (etap 0.3). Wygląd 1:1.
//   - "use client" + import { I } from "./ui"
//   - eksport toast / ToastHost / exportCsv zamiast Object.assign(window, ...)
//   - window.toast zostaje jako wygoda dla wywołań spoza modułów (np. lib/api)
// ============================================================

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { I } from "./ui";

// ── Toast bus (bez kontekstu) ────────────────────────────────
export type ToastKind = "ok" | "info" | "warning" | "error";
export type ToastOpts = { title?: string; duration?: number };
export type ToastItem = { id: number; msg: string; kind: ToastKind; title?: string; duration?: number };

const _toastSubs = new Set<(t: ToastItem) => void>();
let _toastId = 0;

export function toast(msg: string, kind: ToastKind = "ok", opts: ToastOpts = {}): number {
  const t: ToastItem = { id: ++_toastId, msg, kind, ...opts };
  _toastSubs.forEach((fn) => fn(t));
  return t.id;
}

// Pozwól wołać toast() z modułów, które nie importują (np. lib/api.js).
if (typeof window !== "undefined") {
  (window as unknown as { toast?: typeof toast }).toast = toast;
}

const TOAST_META: Record<ToastKind, { color: string; icon: (s: number) => React.ReactNode }> = {
  ok:      { color: "var(--ok)",       icon: (s) => <I.Activity size={s}/> },
  info:    { color: "var(--info)",     icon: (s) => <I.Activity size={s}/> },
  warning: { color: "var(--warning)",  icon: (s) => <I.Alert size={s}/> },
  error:   { color: "var(--critical)", icon: (s) => <I.Alert size={s}/> },
};

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  // Modale renderują się przez createPortal do <body>. Gdyby ToastHost siedział głębiej
  // w drzewie, jego zIndex mógłby zostać uwięziony w cudzym kontekście układania
  // (wystarczy rodzic z transform/filter). Portal do body + zIndex 2000 to zamyka.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onToast = (t: ToastItem) => {
      setItems((prev) => [...prev, t]);
      const dur = t.duration === undefined ? 3200 : t.duration;
      if (dur > 0) {
        setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), dur);
      }
    };
    _toastSubs.add(onToast);
    return () => { _toastSubs.delete(onToast); };
  }, []);

  const dismiss = (id: number) => setItems((prev) => prev.filter((x) => x.id !== id));

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div style={{
      position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
      // Musi być NAD modalami: modalBackdrop ma 1000, asystent 1001. Przy 200 toasty
      // wpadały pod tło otwartego okna i były niewidoczne (błędy zapisu ginęły w ciszy).
      zIndex: 2000, display: "flex", flexDirection: "column", gap: 8, alignItems: "center",
      pointerEvents: "none", width: "min(440px, calc(100vw - 32px))",
    }}>
      {items.map((t) => {
        const m = TOAST_META[t.kind] || TOAST_META.ok;
        return (
          <div key={t.id} className="toast-in" style={{
            pointerEvents: "auto",
            display: "flex", alignItems: "center", gap: 10,
            padding: "11px 14px", width: "100%",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderLeft: `3px solid ${m.color}`,
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
          }}>
            <span style={{
              width: 26, height: 26, borderRadius: 99, flexShrink: 0,
              background: `color-mix(in oklch, ${m.color} 16%, transparent)`, color: m.color,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{m.icon(14)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {t.title && <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>{t.title}</div>}
              <div style={{ fontSize: 12, color: t.title ? "var(--text-mid)" : "var(--text-hi)", fontWeight: t.title ? 400 : 500 }}>{t.msg}</div>
            </div>
            <button onClick={() => dismiss(t.id)} style={{
              background: "transparent", border: "none", color: "var(--text-lo)", cursor: "pointer",
              display: "flex", padding: 3, flexShrink: 0,
            }}><I.Close size={13}/></button>
          </div>
        );
      })}
      <style>{`
        @keyframes toastIn { from { opacity: 0; transform: translateY(12px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .toast-in { animation: toastIn 0.26s cubic-bezier(0.34,1.56,0.64,1) both; }
      `}</style>
    </div>,
    document.body,
  );
}

// ── CSV export ──
// UTF-8 z BOM. Wcześniej plik szedł w Windows-1250 BEZ znacznika kodowania — bajty były
// poprawne, ale Excel nie ma skąd wiedzieć, że to CP1250 (nagłówka MIME z bloba nie czyta),
// więc otwierał plik w domyślnej stronie kodowej systemu. Na polskim Windowsie trafiał
// przypadkiem, na Macu i na systemie z inną lokalizacją — nie, i stąd krzaki.
// BOM (EF BB BF) rozwiązuje to jednoznacznie: Excel na Windows i Mac rozpoznaje go sam.
// Efekt uboczny na plus: znika stratna podmiana znaków spoza CP1250 — „m³" zostaje „m³",
// a nie „m3", i nic nie ląduje już jako „?".

export type CsvColumn<T> = {
  label: string;
  key?: keyof T | string;
  get?: (row: T) => unknown;
};

export function exportCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]): void {
  const sep = ";";
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cell = (c: CsvColumn<T>, r: T) =>
    typeof c.get === "function" ? c.get(r) : (r as Record<string, unknown>)[c.key as string];
  const header = columns.map((c) => esc(c.label)).join(sep);
  const body = rows.map((r) => columns.map((c) => esc(cell(c, r))).join(sep)).join("\r\n");
  const csv = "\uFEFF" + header + "\r\n" + body;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename.endsWith(".csv") ? filename : filename + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Wyeksportowano ${rows.length} wierszy do ${a.download}`, "ok");
}
