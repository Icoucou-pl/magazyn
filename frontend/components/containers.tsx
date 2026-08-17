"use client";
// ============================================================
// MAGAZYN — Kontenery: widok (etap 3a). Orkiestrator.
//   Fetch /containers, filtry/szukajka, rozwijane karty, KPI,
//   „przenieś status" przez PATCH /containers/{id}.
//   Formularz CRUD + załączniki: etap 3b.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { fmtPLNk } from "@/lib/format";
import { useUser, can } from "@/lib/permissions";
import { useShop } from "@/lib/shop";
import { I } from "./ui";
import {
  ContainersToolbar, ContainerCard, ContainersStyles, MiniStat, MonthGroup, monthLabelPL,
  STATUS_FLOW, FILTER_STATUSES, eff, type Container,
} from "./containers-ui";
import ContainerFormModal, { type ContainerType } from "./container-form";
import AutoSuggestModal from "./auto-suggest";
import OrderPdfModal from "./order-pdf";
import type { Product, Manufacturer } from "./products-ui";

// Fallback okna odprawy — używany TYLKO gdy backend nie policzył warehouse_delivery_date
// (normalnie zawsze je zwraca: delivered_date → expected_delivery_date → ETA + CONTAINER_CUSTOMS_DAYS).
const CUSTOMS_FALLBACK_DAYS = 7;
const parseLocalDate = (iso: string): Date => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
// Data wejścia na magazyn, po której grupujemy miesiące: realna gdy znana, inaczej szacunek ETA + odprawa.
const warehouseDate = (c: Container): Date | null => {
  const iso = c.warehouse_delivery_date || c.delivered_date || c.expected_delivery_date;
  if (iso) return parseLocalDate(iso);
  if (c.eta_date) { const d = parseLocalDate(c.eta_date); d.setDate(d.getDate() + CUSTOMS_FALLBACK_DAYS); return d; }
  return null;
};
const ymKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

type MonthBucket = {
  key: string; label: string; sort: number; isCurrent: boolean;
  containers: Container[]; totalValue: number; totalUnits: number; statusCounts: Record<string, number>;
};

export default function ContainersView({ density, openId, onOpenedId, onDeepLinkClose, openNewAutoSuggest, onOpenedNewAutoSuggest, autoSuggestMfrId }: { density?: string; openId?: number | null; onOpenedId?: () => void; onDeepLinkClose?: () => void; openNewAutoSuggest?: boolean; onOpenedNewAutoSuggest?: () => void; autoSuggestMfrId?: number | null }) {
  const gap = density === "compact" ? 10 : 14;
  const showFin = can(useUser(), "viewFinancials");
  const canPO = can(useUser(), "generatePO");

  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  // Firma z globalnego fragmentatora w Topbarze (lib/shop).
  const { shop } = useShop();
  const [mfr, setMfr] = useState("");       // "" = wszyscy producenci
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [openMonths, setOpenMonths] = useState<Set<string>>(() => new Set());
  const seededMonths = useRef(false);

  // Dane pomocnicze do formularza
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [containerTypes, setContainerTypes] = useState<ContainerType[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Container | null>(null);
  const [poContainer, setPoContainer] = useState<Container | null>(null);
  const [autoSuggestOpen, setAutoSuggestOpen] = useState(false);
  const [autoSuggestMfr, setAutoSuggestMfr] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await api.get("/containers")) as Container[];
      setContainers(data || []);
    } catch {
      toast("Nie udało się wczytać kontenerów", "warning");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Dane do formularza (raz) — producenci, typy, produkty
  useEffect(() => {
    (async () => {
      const [m, t, p] = await Promise.allSettled([
        api.get("/manufacturers"),
        api.get("/container-types"),
        api.get("/products?include=ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE,SAMPLE"),
      ]);
      if (m.status === "fulfilled") setManufacturers((m.value as Manufacturer[]) || []);
      if (t.status === "fulfilled") setContainerTypes((t.value as ContainerType[]) || []);
      if (p.status === "fulfilled") setProducts((p.value as Product[]) || []);
    })();
  }, []);

  const openNew = () => { setEditing(null); setShowForm(true); };
  const openEdit = (c: Container) => { setEditing(c); setShowForm(true); };
  const openAutoSuggest = (mfrId: number | null = null) => { setAutoSuggestMfr(mfrId); setAutoSuggestOpen(true); };
  // True gdy formularz otwarto deep-linkiem (openId z innego widoku) — wtedy zamknięcie ma wrócić do źródła.
  const deepLinkRef = useRef(false);

  // Deep-link z globalnej wyszukiwarki: otwórz konkretny kontener po id
  useEffect(() => {
    if (openId == null || !containers.length) return;
    const c = containers.find((x) => x.id === openId);
    if (c) { deepLinkRef.current = true; openEdit(c); onOpenedId?.(); }
  }, [openId, containers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wywołanie z Dashboardu / szybkiej akcji: otwórz nowy kontener w trybie autosugestii
  useEffect(() => {
    if (openNewAutoSuggest) { openAutoSuggest(autoSuggestMfrId ?? null); onOpenedNewAutoSuggest?.(); }
  }, [openNewAutoSuggest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Kontener nie ma własnej firmy — wynika ona z właścicieli SKU (firma_breakdown),
  // a przy skonsolidowanym siedzi na lotach. Producent analogicznie: na kontenerze
  // albo na locie. Zawężamy PRZED liczeniem statusów, żeby liczby na chipach
  // odpowiadały temu, co faktycznie widać na liście.
  const scoped = useMemo(() => {
    let arr = containers;
    if (shop) {
      arr = arr.filter((c) =>
        (c.firma_breakdown?.[shop]?.units ?? 0) > 0 ||
        (c.lots ?? []).some((l) => (l.firma_breakdown?.[shop]?.units ?? 0) > 0));
    }
    if (mfr) {
      const id = Number(mfr);
      arr = arr.filter((c) =>
        c.manufacturer_id === id || (c.lots ?? []).some((l) => l.manufacturer_id === id));
    }
    return arr;
  }, [containers, shop, mfr]);

  // Producenci obecni w bieżącym zakresie firmy — lista nie puchnie o nieużywanych.
  const mfrOptions = useMemo(() => {
    const seen = new Map<number, string>();
    const base = shop ? scoped : containers;
    for (const c of base) {
      if (c.manufacturer_id && c.manufacturer_name) seen.set(c.manufacturer_id, c.manufacturer_name);
      for (const l of c.lots ?? []) {
        if (l.manufacturer_id && l.manufacturer_name) seen.set(l.manufacturer_id, l.manufacturer_name);
      }
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [containers, scoped, shop]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { ALL: scoped.length };
    FILTER_STATUSES.forEach((s) => { out[s] = scoped.filter((c) => eff(c) === s).length; });
    return out;
  }, [scoped]);

  const filtered = useMemo(() => {
    let arr = scoped;
    if (filter !== "ALL") arr = arr.filter((c) => eff(c) === filter);
    if (search) {
      const q = search.toLowerCase();
      // W skonsolidowanym kontenerze PO i dostawca żyją na lotach, a nie na kontenerze —
      // bez przeszukania lotów wyszukiwarka nie znajdowała takich kontenerów po numerze PO.
      const hit = (v?: string | null) => !!v && v.toLowerCase().includes(q);
      arr = arr.filter((c) =>
        hit(c.container_number) ||
        hit(c.order_number) ||
        hit(c.manufacturer_name) ||
        hit(c.subiekt_nr) ||
        (c.lots ?? []).some((l) => hit(l.order_number) || hit(l.manufacturer_name)) ||
        c.items.some((i) => hit(i.sku)));
    }
    return [...arr].sort((a, b) => new Date(a.eta_date).getTime() - new Date(b.eta_date).getTime());
  }, [scoped, filter, search]);

  // Kontenery pogrupowane po miesiącu wejścia na magazyn (warehouse_delivery_date).
  // Miesiące rosnąco (kalendarzowo), wewnątrz po dacie wejścia (ETA jako tie-break).
  const grouped = useMemo<MonthBucket[]>(() => {
    const nowKey = ymKey(new Date());
    const map = new Map<string, MonthBucket>();
    for (const c of filtered) {
      const d = warehouseDate(c);
      const key = d ? ymKey(d) : "____-__";
      let g = map.get(key);
      if (!g) {
        g = {
          key, label: d ? monthLabelPL(d) : "Bez daty",
          sort: d ? d.getFullYear() * 12 + d.getMonth() : Number.MAX_SAFE_INTEGER,
          isCurrent: key === nowKey, containers: [], totalValue: 0, totalUnits: 0, statusCounts: {},
        };
        map.set(key, g);
      }
      g.containers.push(c);
      g.totalValue += c.total_value || 0;
      g.totalUnits += c.total_units || 0;
      const s = eff(c);
      g.statusCounts[s] = (g.statusCounts[s] || 0) + 1;
    }
    const arr = [...map.values()].sort((a, b) => a.sort - b.sort);
    arr.forEach((g) => g.containers.sort((a, b) =>
      ((warehouseDate(a)?.getTime() ?? 0) - (warehouseDate(b)?.getTime() ?? 0)) ||
      (new Date(a.eta_date).getTime() - new Date(b.eta_date).getTime())));
    return arr;
  }, [filtered]);
  const monthKeys = useMemo(() => grouped.map((g) => g.key), [grouped]);

  // Podczas szukania auto-rozwijamy miesiące z trafieniami (inaczej wynik chowałby się
  // w zwiniętych nagłówkach). Filtr statusu NIE wymusza rozwinięcia — resztę klika się ręcznie.
  const forceOpenMonths = !!search.trim();

  // Domyślnie wszystko zwinięte, ale bieżący miesiąc rozwijamy raz na starcie.
  useEffect(() => {
    if (seededMonths.current || grouped.length === 0) return;
    seededMonths.current = true;
    const nowKey = ymKey(new Date());
    if (monthKeys.includes(nowKey)) setOpenMonths(new Set([nowKey]));
  }, [grouped, monthKeys]);

  const summary = useMemo(() => {
    const inFlight = containers.filter((c) => eff(c) !== "DELIVERED");

    // Granice tygodnia (pn–nd) i miesiąca — w czasie lokalnym.
    const now = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today0 = startOfDay(now);
    const dow = (today0.getDay() + 6) % 7;                                        // pn=0 … nd=6
    const weekStart = new Date(today0); weekStart.setDate(today0.getDate() - dow);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7); // [weekStart, weekEnd)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);           // [monthStart, monthEnd)
    const inRange = (iso: string, from: Date, to: Date) => {
      const d = startOfDay(new Date(iso));
      return d >= from && d < to;
    };

    // Najbliższa dostawa: najwcześniejsze ETA wśród niedostarczonych (efektywnie).
    const next = inFlight
      .map((c) => ({ c, days: Math.ceil((startOfDay(new Date(c.eta_date)).getTime() - today0.getTime()) / 86400000) }))
      .sort((a, b) => a.days - b.days)[0] ?? null;

    return {
      inFlight: inFlight.length,
      inFlightValue: inFlight.reduce((s, c) => s + c.total_value, 0),
      totalUnits: inFlight.reduce((s, c) => s + c.total_units, 0),
      thisWeek: containers.filter((c) => inRange(c.eta_date, weekStart, weekEnd)).length,
      thisMonth: containers.filter((c) => inRange(c.eta_date, monthStart, monthEnd)).length,
      nextDays: next ? next.days : null,
      nextNumber: next ? next.c.container_number : null,
    };
  }, [containers]);

  const toggleExpand = (id: number) => setExpandedIds((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  // Rozwijanie miesięcy — pierwszy poziom (karty w środku mają własne „Pokaż szczegóły").
  const toggleMonth = (key: string) => setOpenMonths((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const advance = async (c: Container) => {
    const idx = STATUS_FLOW.indexOf(c.status);
    if (idx < 0 || idx >= STATUS_FLOW.length - 1) return;
    const next = STATUS_FLOW[idx + 1];
    try {
      await api.patch(`/containers/${c.id}`, { status: next });
      await reload();
    } catch {
      toast("Nie udało się zmienić statusu", "warning");
    }
  };

  // Ręczna data „Dostawa na magazyn": wpis domyka kontener (backend ustawia DELIVERED),
  // null = zdejmij potwierdzenie → KPI wraca do auto (ETA + odprawa).
  const setDelivered = async (c: Container, dateStr: string | null) => {
    try {
      await api.patch(`/containers/${c.id}`, { delivered_date: dateStr });
      await reload();
      toast(dateStr ? "Zapisano datę dostawy — kontener domknięty" : "Zdjęto potwierdzenie dostawy", "ok");
    } catch {
      toast("Nie udało się zapisać daty dostawy", "warning");
      throw new Error("save failed");
    }
  };

  // Kropka „dodano do Subiektu": zielona = wbite do magazynu „w drodze" → liczone z Subiekta,
  // czerwona = jeszcze w apce → liczone z kontenera. lotId=null → kontener nieskonsolidowany.
  const toggleSubiekt = async (c: Container, lotId: number | null, value: boolean) => {
    try {
      await api.post(`/containers/${c.id}/subiekt-wbite`, { lot_id: lotId, value });
      await reload();
      toast(value ? "Oznaczono: w Subiekcie (magazyn w drodze)" : "Cofnięto: z powrotem w apce", "ok");
    } catch {
      toast("Nie udało się zmienić statusu Subiekta", "warning");
    }
  };

  if (loading) {
    return (
      <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap, paddingBottom: 80 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          {[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ height: 78, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />)}
        </div>
        <div style={{ height: 56, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />
        {[0, 1, 2].map((i) => <div key={i} style={{ height: 72, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />)}
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap, paddingBottom: 80 }}>
      <ContainersStyles />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <MiniStat label="Aktywne kontenery" value={summary.inFlight} sub="nie dostarczone" icon={<I.Ship size={14} />} />
        <MiniStat label="Wartość zamówiona" value={showFin ? fmtPLNk(summary.inFlightValue) : "•••••"} sub={`${summary.totalUnits} szt · przed dostawą`} icon={<I.Wallet size={14} />} />
        <MiniStat
          label="Najbliższa dostawa"
          value={summary.nextDays === null ? "—" : summary.nextDays === 0 ? "dziś" : summary.nextDays < 0 ? `${Math.abs(summary.nextDays)}d po ETA` : `za ${summary.nextDays}d`}
          sub={summary.nextNumber ? `#${summary.nextNumber}` : "brak w drodze"}
          icon={<I.ArrowDown size={14} />}
        />
        <MiniStat label="Dostawy w tym tygodniu" value={summary.thisWeek} sub="wg ETA (pn–nd)" icon={<I.Calendar size={14} />} />
        <MiniStat label="Dostawy w tym miesiącu" value={summary.thisMonth} sub="wg ETA" icon={<I.Calendar size={14} />} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-mid)" }}>Producent</span>
          <select value={mfr} onChange={(e) => setMfr(e.target.value)} style={{
            padding: "6px 10px", fontSize: 12, borderRadius: 8, minWidth: 150,
            background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-hi)",
          }}>
            <option value="">Wszyscy ({mfrOptions.length})</option>
            {mfrOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        {mfr && (
          <button onClick={() => setMfr("")} style={{
            padding: "5px 12px", fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: "pointer",
            background: "transparent", border: "1px solid var(--border)", color: "var(--text-mid)",
          }}>Wyczyść</button>
        )}
        <span style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
          {filtered.length} z {containers.length} kontenerów
        </span>
      </div>

      <ContainersToolbar
        search={search} setSearch={setSearch}
        filter={filter} setFilter={setFilter} counts={counts}
        onAutoSuggest={() => openAutoSuggest(null)}
        onNew={openNew}
        rows={containers}
      />

      {grouped.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center", background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)" }}>
          <I.Ship size={36} style={{ color: "var(--text-disabled)", marginBottom: 10 }} />
          <div style={{ fontSize: 14, color: "var(--text-mid)", fontWeight: 500 }}>Brak kontenerów</div>
          <div style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 4 }}>Kliknij „Nowy kontener" aby zacząć</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {grouped.map((g) => {
            const open = forceOpenMonths || openMonths.has(g.key);
            return (
              <MonthGroup
                key={g.key}
                label={g.label}
                open={open}
                onToggle={() => toggleMonth(g.key)}
                count={g.containers.length}
                units={g.totalUnits}
                value={g.totalValue}
                statusCounts={g.statusCounts}
                showFin={showFin}
                isCurrent={g.isCurrent}
              >
                {open && g.containers.map((c) => (
                  <ContainerCard
                    key={c.id} container={c}
                    expanded={expandedIds.has(c.id)}
                    onToggle={() => toggleExpand(c.id)}
                    onEdit={() => openEdit(c)}
                    onAdvance={() => advance(c)}
                    onGeneratePO={canPO ? () => setPoContainer(c) : undefined}
                    onSetDelivered={(d) => setDelivered(c, d)}
                    onToggleSubiekt={(lotId, value) => toggleSubiekt(c, lotId, value)}
                  />
                ))}
              </MonthGroup>
            );
          })}
        </div>
      )}
      {showForm && (
        <ContainerFormModal
          initial={editing}
          manufacturers={manufacturers}
          containerTypes={containerTypes}
          products={products}
          onClose={() => {
            setShowForm(false);
            if (deepLinkRef.current) { deepLinkRef.current = false; onDeepLinkClose?.(); }
            else { reload(); }
          }}
          onSaved={reload}
          onDeleted={reload}
        />
      )}
      {autoSuggestOpen && (
        <AutoSuggestModal
          manufacturers={manufacturers}
          containerTypes={containerTypes}
          products={products}
          initialManufacturerId={autoSuggestMfr}
          onClose={() => { setAutoSuggestOpen(false); setAutoSuggestMfr(null); }}
          onCreated={reload}
        />
      )}
      {poContainer && (
        <OrderPdfModal
          container={poContainer}
          manufacturers={manufacturers}
          onClose={() => setPoContainer(null)}
        />
      )}
    </div>
  );
}
