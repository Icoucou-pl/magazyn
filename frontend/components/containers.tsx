"use client";
// ============================================================
// MAGAZYN — Kontenery: widok (etap 3a). Orkiestrator.
//   Fetch /containers, filtry/szukajka, rozwijane karty, KPI,
//   „przenieś status" przez PATCH /containers/{id}.
//   Formularz CRUD + załączniki: etap 3b.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { fmtPLNk } from "@/lib/format";
import { useUser, can } from "@/lib/permissions";
import { I } from "./ui";
import {
  ContainersToolbar, ContainerCard, MiniStat,
  STATUS_FLOW, FILTER_STATUSES, eff, type Container,
} from "./containers-ui";
import ContainerFormModal, { type ContainerType } from "./container-form";
import AutoSuggestModal from "./auto-suggest";
import OrderPdfModal from "./order-pdf";
import type { Product, Manufacturer } from "./products-ui";

export default function ContainersView({ density, openId, onOpenedId, openNewAutoSuggest, onOpenedNewAutoSuggest, autoSuggestMfrId }: { density?: string; openId?: number | null; onOpenedId?: () => void; openNewAutoSuggest?: boolean; onOpenedNewAutoSuggest?: () => void; autoSuggestMfrId?: number | null }) {
  const gap = density === "compact" ? 10 : 14;
  const showFin = can(useUser(), "viewFinancials");
  const canPO = can(useUser(), "generatePO");

  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());

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

  // Deep-link z globalnej wyszukiwarki: otwórz konkretny kontener po id
  useEffect(() => {
    if (openId == null || !containers.length) return;
    const c = containers.find((x) => x.id === openId);
    if (c) { openEdit(c); onOpenedId?.(); }
  }, [openId, containers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wywołanie z Dashboardu / szybkiej akcji: otwórz nowy kontener w trybie autosugestii
  useEffect(() => {
    if (openNewAutoSuggest) { openAutoSuggest(autoSuggestMfrId ?? null); onOpenedNewAutoSuggest?.(); }
  }, [openNewAutoSuggest]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const out: Record<string, number> = { ALL: containers.length };
    FILTER_STATUSES.forEach((s) => { out[s] = containers.filter((c) => eff(c) === s).length; });
    return out;
  }, [containers]);

  const filtered = useMemo(() => {
    let arr = containers;
    if (filter !== "ALL") arr = arr.filter((c) => eff(c) === filter);
    if (search) {
      const q = search.toLowerCase();
      arr = arr.filter((c) =>
        c.container_number.toLowerCase().includes(q) ||
        c.order_number?.toLowerCase().includes(q) ||
        c.manufacturer_name?.toLowerCase().includes(q) ||
        c.items.some((i) => i.sku.toLowerCase().includes(q)));
    }
    return [...arr].sort((a, b) => new Date(a.eta_date).getTime() - new Date(b.eta_date).getTime());
  }, [containers, filter, search]);

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
  const toggleAll = () => setExpandedIds((prev) => (prev.size > 0 ? new Set() : new Set(filtered.map((c) => c.id))));

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

      <ContainersToolbar
        search={search} setSearch={setSearch}
        filter={filter} setFilter={setFilter} counts={counts}
        expandedAny={expandedIds.size > 0}
        onToggleAll={toggleAll}
        onAutoSuggest={() => openAutoSuggest(null)}
        onNew={openNew}
        rows={containers}
      />

      {filtered.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center", background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)" }}>
          <I.Ship size={36} style={{ color: "var(--text-disabled)", marginBottom: 10 }} />
          <div style={{ fontSize: 14, color: "var(--text-mid)", fontWeight: 500 }}>Brak kontenerów</div>
          <div style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 4 }}>Kliknij „Nowy kontener" aby zacząć</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((c) => (
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
        </div>
      )}
      {showForm && (
        <ContainerFormModal
          initial={editing}
          manufacturers={manufacturers}
          containerTypes={containerTypes}
          products={products}
          onClose={() => { setShowForm(false); reload(); }}
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
