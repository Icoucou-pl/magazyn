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
  STATUS_FLOW, type Container,
} from "./containers-ui";
import ContainerFormModal, { type ContainerType } from "./container-form";
import type { Product, Manufacturer } from "./products-ui";

export default function ContainersView({ density }: { density?: string }) {
  const gap = density === "compact" ? 10 : 14;
  const showFin = can(useUser(), "viewFinancials");

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
        api.get("/products?include=ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE"),
      ]);
      if (m.status === "fulfilled") setManufacturers((m.value as Manufacturer[]) || []);
      if (t.status === "fulfilled") setContainerTypes((t.value as ContainerType[]) || []);
      if (p.status === "fulfilled") setProducts((p.value as Product[]) || []);
    })();
  }, []);

  const openNew = () => { setEditing(null); setShowForm(true); };
  const openEdit = (c: Container) => { setEditing(c); setShowForm(true); };

  const counts = useMemo(() => {
    const out: Record<string, number> = { ALL: containers.length };
    STATUS_FLOW.forEach((s) => { out[s] = containers.filter((c) => c.status === s).length; });
    return out;
  }, [containers]);

  const filtered = useMemo(() => {
    let arr = containers;
    if (filter !== "ALL") arr = arr.filter((c) => c.status === filter);
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
    const inFlight = containers.filter((c) => c.status !== "DELIVERED");
    return {
      inFlight: inFlight.length,
      inFlightValue: inFlight.reduce((s, c) => s + c.total_value, 0),
      totalUnits: inFlight.reduce((s, c) => s + c.total_units, 0),
      avgFill: inFlight.length > 0 ? Math.round(inFlight.reduce((s, c) => s + (c.fill_percentage ?? 0), 0) / inFlight.length) : 0,
      attachments: containers.reduce((s, c) => s + (c.attachments?.length || 0), 0),
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

  if (loading) {
    return (
      <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap, paddingBottom: 80 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} style={{ height: 78, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />)}
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
        <MiniStat label="Wartość w drodze" value={showFin ? fmtPLNk(summary.inFlightValue) : "•••••"} sub={`${summary.totalUnits} szt łącznie`} icon={<I.ArrowDown size={14} />} />
        <MiniStat label="Średnie wypełnienie" value={`${summary.avgFill}%`} sub="CBM / pojemność" icon={<I.Activity size={14} />} />
        <MiniStat label="Załączniki" value={summary.attachments} sub="proforma, BL, PL" icon={<I.External size={14} />} />
      </div>

      <ContainersToolbar
        search={search} setSearch={setSearch}
        filter={filter} setFilter={setFilter} counts={counts}
        expandedAny={expandedIds.size > 0}
        onToggleAll={toggleAll}
        onAutoSuggest={() => toast("Auto-sugestia kontenera — wkrótce (etap 6)", "info")}
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
              onGeneratePO={() => toast("Generator PO — wkrótce (etap 6)", "info")}
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
          onClose={() => setShowForm(false)}
          onSaved={reload}
          onDeleted={reload}
        />
      )}
    </div>
  );
}
