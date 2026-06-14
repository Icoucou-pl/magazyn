"use client";

// ============================================================
// MAGAZYN — Toast notifications + CSV export (Windows-1250)
// Konwersja toast.jsx → .tsx (etap 0.3). Wygląd 1:1.
//   - "use client" + import { I } from "./ui"
//   - eksport toast / ToastHost / exportCsv zamiast Object.assign(window, ...)
//   - window.toast zostaje jako wygoda dla wywołań spoza modułów (np. lib/api)
// ============================================================

import React, { useEffect, useState } from "react";
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
  useEffect(() => {
    const onToast = (t: ToastItem) => {
      setItems((prev) => [...prev, t]);
      const dur = t.duration || 3200;
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), dur);
    };
    _toastSubs.add(onToast);
    return () => { _toastSubs.delete(onToast); };
  }, []);

  const dismiss = (id: number) => setItems((prev) => prev.filter((x) => x.id !== id));

  return (
    <div style={{
      position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
      zIndex: 200, display: "flex", flexDirection: "column", gap: 8, alignItems: "center",
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
    </div>
  );
}

// ── CSV export (Windows-1250 — co polski Excel czyta domyślnie) ──
const CP1250: Record<string, number> = {
  "ą":0xB9,"ć":0xE6,"ę":0xEA,"ł":0xB3,"ń":0xF1,"ó":0xF3,"ś":0x9C,"ź":0x9F,"ż":0xBF,
  "Ą":0xA5,"Ć":0xC6,"Ę":0xCA,"Ł":0xA3,"Ń":0xD1,"Ó":0xD3,"Ś":0x8C,"Ź":0x8F,"Ż":0xAF,
  "„":0x84,"\u201D":0x94,"–":0x96,"—":0x97,"…":0x85,"°":0xB0,"§":0xA7,"€":0x80,"©":0xA9,
};
// Nieznany unicode → fallback ASCII
const ASCII_FALLBACK: Record<string, string> = { "³":"3","²":"2","→":"->","←":"<-","·":"-","•":"-","\u2019":"'","\u2018":"'" };

function toCp1250(str: string): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code < 128) { bytes.push(code); continue; }
    if (CP1250[ch] != null) { bytes.push(CP1250[ch]); continue; }
    const fb = ASCII_FALLBACK[ch];
    if (fb != null) { for (const c of fb) bytes.push(c.charCodeAt(0)); continue; }
    bytes.push(0x3F); // '?'
  }
  return new Uint8Array(bytes);
}

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
  const csv = header + "\r\n" + body;
  const blob = new Blob([toCp1250(csv)], { type: "text/csv;charset=windows-1250;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename.endsWith(".csv") ? filename : filename + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Wyeksportowano ${rows.length} wierszy do ${a.download}`, "ok");
}
