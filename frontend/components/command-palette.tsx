"use client";
// ============================================================
// Globalna wyszukiwarka (Ctrl+K). Podpięta do GET /api/search/global.
//   - debounce 220ms, ignorowanie nieaktualnych odpowiedzi (sekwencja)
//   - grupy: Produkty / Po EAN / Producenci / Kontenery
//   - nawigacja klawiaturą: ↑↓ po płaskiej liście, ↵ otwórz, esc zamknij
//   - klik wyniku → callback do page.tsx (routing widoków siedzi tam)
// Render przez Portal do document.body (jak pozostałe modale).
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { I } from "@/components/ui";
import { Portal, modalBackdrop, modalCard } from "@/components/products-ui";

// ── Kształt odpowiedzi /search/global ────────────────────────
interface GProduct { sku: string; name: string; stock: number; manufacturer_name: string | null; manufacturer_color: string | null; }
interface GEan { sku: string; ean: string | null; name: string | null; }
interface GManufacturer { id: number; name: string; color: string | null; email: string | null; notes: string | null; }
interface GContainer { id: number; container_number: string; order_number: string | null; eta_date: string | null; status: string; manufacturer_name: string | null; manufacturer_color: string | null; }
interface GlobalSearchResponse { products: GProduct[]; ean: GEan[]; manufacturers: GManufacturer[]; containers: GContainer[]; total: number; }

const EMPTY: GlobalSearchResponse = { products: [], ean: [], manufacturers: [], containers: [], total: 0 };

// Płaska, indeksowalna pozycja (pod nawigację klawiaturą)
type FlatItem =
  | { kind: "product"; sku: string; label: string; sub: string; dot?: string }
  | { kind: "manufacturer"; label: string; sub: string; dot?: string }
  | { kind: "container"; label: string; sub: string; dot?: string };

type Props = {
  open: boolean;
  onClose: () => void;
  onProduct: (sku: string) => void;
  onContainer: () => void;
  onManufacturer: () => void;
};

export default function CommandPalette({ open, onClose, onProduct, onContainer, onManufacturer }: Props) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<GlobalSearchResponse>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // Reset i fokus przy otwarciu
  useEffect(() => {
    if (open) {
      setQ("");
      setRes(EMPTY);
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounce + fetch
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setRes(EMPTY);
      setLoading(false);
      return;
    }
    setLoading(true);
    const reqId = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const data = (await api.get(`/search/global?q=${encodeURIComponent(query)}`)) as GlobalSearchResponse;
        if (reqId !== seq.current) return; // odrzuć nieaktualną odpowiedź
        setRes(data || EMPTY);
        setActive(0);
      } catch {
        if (reqId === seq.current) setRes(EMPTY);
      } finally {
        if (reqId === seq.current) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q, open]);

  // Płaska lista do nawigacji + akcji
  const flat: FlatItem[] = useMemo(() => {
    const out: FlatItem[] = [];
    for (const p of res.products) {
      out.push({ kind: "product", sku: p.sku, label: p.sku, sub: p.name || "—", dot: p.manufacturer_color || undefined });
    }
    for (const e of res.ean) {
      out.push({ kind: "product", sku: e.sku, label: e.sku, sub: e.ean ? `EAN ${e.ean}` : (e.name || "—") });
    }
    for (const m of res.manufacturers) {
      out.push({ kind: "manufacturer", label: m.name, sub: "Producent", dot: m.color || undefined });
    }
    for (const c of res.containers) {
      out.push({ kind: "container", label: c.container_number, sub: c.manufacturer_name || c.order_number || c.status, dot: c.manufacturer_color || undefined });
    }
    return out;
  }, [res]);

  const fire = (it: FlatItem) => {
    if (it.kind === "product") onProduct(it.sku);
    else if (it.kind === "manufacturer") onManufacturer();
    else onContainer();
  };

  // Przewijanie aktywnej pozycji do widoku
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (!flat.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % flat.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + flat.length) % flat.length); }
    else if (e.key === "Enter") { e.preventDefault(); const it = flat[active]; if (it) fire(it); }
  };

  // Renderowanie grupy; idxBase = offset w płaskiej liście
  const Group = ({ title, icon, items, idxBase }: { title: string; icon: React.ReactNode; items: FlatItem[]; idxBase: number }) => {
    if (!items.length) return null;
    return (
      <div style={{ padding: "6px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 16px", color: "var(--text-lo)", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {icon}{title}
        </div>
        {items.map((it, i) => {
          const idx = idxBase + i;
          const on = idx === active;
          return (
            <div
              key={`${it.kind}-${it.label}-${idx}`}
              data-idx={idx}
              onMouseEnter={() => setActive(idx)}
              onClick={() => fire(it)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", cursor: "pointer",
                background: on ? "var(--accent-soft)" : "transparent",
                borderLeft: `2px solid ${on ? "var(--accent)" : "transparent"}`,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 3, flexShrink: 0, background: it.dot || "var(--border)" }} />
              <span style={{ color: "var(--text-hi)", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{it.label}</span>
              <span style={{ color: "var(--text-lo)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{it.sub}</span>
              {on && <I.ArrowRight size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />}
            </div>
          );
        })}
      </div>
    );
  };

  const nProd = res.products.length;
  const nEan = res.ean.length;
  const nMfr = res.manufacturers.length;
  const showHint = q.trim().length < 2;
  const showEmpty = !loading && !showHint && flat.length === 0;

  return (
    <Portal>
      <div
        style={{ ...modalBackdrop, alignItems: "flex-start", paddingTop: "10vh" }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{ ...modalCard, maxWidth: 640 }} onKeyDown={onKey}>
          {/* Pole wyszukiwania */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border-soft)" }}>
            <I.Search size={16} style={{ color: "var(--text-lo)", flexShrink: 0 }} />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Szukaj SKU, nazwy, EAN, producenta, kontenera..."
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-hi)", fontSize: 15 }}
            />
            {loading && <span style={{ color: "var(--text-lo)", fontSize: 11 }}>szukam…</span>}
            <button onClick={onClose} title="Zamknij (Esc)" style={{ display: "inline-flex", background: "transparent", border: "none", color: "var(--text-lo)", cursor: "pointer", padding: 2 }}>
              <I.Close size={16} />
            </button>
          </div>

          {/* Wyniki */}
          <div ref={listRef} style={{ overflowY: "auto", maxHeight: "56vh" }}>
            {showHint && (
              <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
                Wpisz min. 2 znaki, żeby szukać.
              </div>
            )}
            {showEmpty && (
              <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
                Brak wyników dla „{q.trim()}".
              </div>
            )}
            {!showHint && (
              <>
                <Group title="Produkty" icon={<I.Box size={11} />} items={flat.slice(0, nProd)} idxBase={0} />
                <Group title="Po EAN" icon={<I.Scan size={11} />} items={flat.slice(nProd, nProd + nEan)} idxBase={nProd} />
                <Group title="Producenci" icon={<I.Factory size={11} />} items={flat.slice(nProd + nEan, nProd + nEan + nMfr)} idxBase={nProd + nEan} />
                <Group title="Kontenery" icon={<I.Ship size={11} />} items={flat.slice(nProd + nEan + nMfr)} idxBase={nProd + nEan + nMfr} />
              </>
            )}
          </div>

          {/* Stopka z podpowiedziami */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 16px", borderTop: "1px solid var(--border-soft)", color: "var(--text-lo)", fontSize: 11 }}>
            <span><Kbd>↑</Kbd><Kbd>↓</Kbd> nawigacja</span>
            <span><Kbd>↵</Kbd> otwórz</span>
            <span><Kbd>esc</Kbd> zamknij</span>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 18, height: 18, padding: "0 4px",
      background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 4,
      fontSize: 10, color: "var(--text-mid)", marginRight: 3,
    }}>{children}</kbd>
  );
}
