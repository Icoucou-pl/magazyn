"use client";
// ============================================================
// MAGAZYN — Pełna karta kontenera (/kontenery/NR).
//
// Wchodzi się na nią z karty produktu („Kontenery z tym SKU") i z listy
// kontenerów na karcie producenta: Produkty › D2b › #SK2605042.
// Widok Kontenery, Kalendarz, Cashflow i pulpit dalej otwierają formularz
// w oknie pod starym adresem /kontenery/12 (same cyfry).
//
// Treść to ta sama ContainerCard co na liście Kontenerów, tylko zawsze
// rozwinięta (pinned): oś statusu, dostawa, „w drodze", spedycja, MRN,
// płatności, pozycje, załączniki, notatki — te same liczby, ten sam kod.
// Na karcie SKU prowadzą na kartę produktu, a producent na kartę producenta.
// Edycja = dotychczasowy formularz jako okno nad kartą; po zapisie karta
// dociąga kontener od nowa.
//
// Adres: numer kontenera, a dopóki go nie ma — nr FV (lib/routes: containerSlug).
// Szukamy po numerze kontenera, FV kontenera i FV lotów, więc stary link z FV
// działa także po nadaniu numeru. „id-12" to zapas dla kontenera bez obu.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Breadcrumbs, { type Trail } from "./breadcrumbs";
import { ContainerCard, ContainersStyles, STATUS_FLOW, type Container } from "./containers-ui";
import ContainerFormModal, { type ContainerType } from "./container-form";
import OrderPdfModal from "./order-pdf";
import type { Manufacturer, Product } from "./products-ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { can, canSeeLandedCost, useUser } from "@/lib/permissions";
import { containerSlug } from "@/lib/routes";
import LandedCostTab from "./container-landed-cost";

const norm = (s?: string | null) => (s || "").trim().toLocaleLowerCase("pl-PL");

/** Kontener pasujący do klucza z adresu. Numer kontenera wygrywa z FV. */
function findByKey(list: Container[], key: string): Container | null {
  const idMatch = /^id-(\d+)$/i.exec(key.trim());
  if (idMatch) return list.find((c) => c.id === Number(idMatch[1])) ?? null;
  const k = norm(key);
  const byNr = list.find((c) => norm(c.container_number) === k);
  if (byNr) return byNr;
  return list.find((c) =>
    norm(c.order_number) === k || (c.lots ?? []).some((l) => norm(l.order_number) === k),
  ) ?? null;
}

export default function ContainerPage({
  containerKey, trail, onCrumb, highlightSku, onOpenProduct, onOpenManufacturer, onBackToList, onDeleted, onCanonicalKey,
}: {
  /** Klucz z adresu (już zdekodowany): nr kontenera, nr FV albo „id-12". */
  containerKey: string;
  trail: Trail;
  onCrumb: (index: number) => void;
  /** SKU z poprzedniego ogniwa sznurka — podświetlony na liście pozycji. */
  highlightSku?: string | null;
  onOpenProduct: (sku: string) => void;
  onOpenManufacturer: (name: string) => void;
  /** Widok Kontenery — przycisk przy „nie znaleziono". */
  onBackToList: () => void;
  onDeleted: () => void;
  /** Klucz kontenera zmienił się (np. po edycji przyszedł numer kontenera zamiast FV) —
   *  rodzic podmienia adres bez nowego wpisu w historii. */
  onCanonicalKey?: (key: string) => void;
}) {
  const user = useUser();
  const canPO = can(user, "generatePO");
  const pokazKoszt = canSeeLandedCost(user);
  // Zakładka siedzi w adresie (?tab=koszt), żeby odświeżenie strony zostawiało na niej
  // użytkownika — wcześniej F5 zawsze wyrzucało na Przegląd. Zmieniamy ją przez
  // replaceState, nie pushState (jak na karcie produktu): „wstecz" ma cofać o widok,
  // a nie przeklikiwać zakładki. Stan historii (sznurek breadcrumba) przenosimy bez zmian.
  const [tab, setTabState] = useState<"przeglad" | "koszt">(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "koszt"
      ? "koszt" : "przeglad");
  const setTab = (t: "przeglad" | "koszt") => {
    setTabState(t);
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    if (t === "koszt") q.set("tab", "koszt"); else q.delete("tab");
    const qs = q.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (qs ? `?${qs}` : ""));
  };
  const [container, setContainer] = useState<Container | null>(null);
  const [nieZnaleziono, setNieZnaleziono] = useState(false);

  // Zależności formularza i generatora PO — dociągane leniwie, dopiero przy pierwszym
  // kliknięciu „Edytuj" / „Generuj PO". Sama karta ich nie potrzebuje.
  const [manufacturers, setManufacturers] = useState<Manufacturer[] | null>(null);
  const [ctTypes, setCtTypes] = useState<ContainerType[] | null>(null);
  const [catalog, setCatalog] = useState<Product[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [poOpen, setPoOpen] = useState(false);
  const [booting, setBooting] = useState(false);

  const usuniety = useRef(false);
  const containerRef = useRef<Container | null>(null);
  useEffect(() => { containerRef.current = container; }, [container]);

  // ── Kontener z adresu ─────────────────────────────────────
  useEffect(() => {
    // Podmiana adresu na kanoniczny (FV → nr kontenera) nie ma pobierać kontenera od nowa.
    const cur = containerRef.current;
    if (cur && findByKey([cur], containerKey)) return;
    let alive = true;
    setContainer(null); setNieZnaleziono(false);
    api.get("/containers")
      .then((d) => {
        if (!alive) return;
        const c = findByKey((d as Container[]) || [], containerKey);
        if (c) setContainer(c); else setNieZnaleziono(true);
      })
      .catch(() => { if (alive) { setNieZnaleziono(true); toast("Nie udało się wczytać kontenera", "warning"); } });
    return () => { alive = false; };
  }, [containerKey]);

  // Adres zawsze pod aktualnym kluczem: gdy kontener dostanie numer (albo zmieni się FV),
  // link w pasku i w sznurku przechodzi na nowy, a stary dalej trafia (findByKey).
  const slug = container ? containerSlug({
    id: container.id, container_number: container.container_number, order_number: container.order_number,
    lot_order_numbers: (container.lots ?? []).map((l) => l.order_number),
  }) : null;
  useEffect(() => {
    if (slug && slug !== containerKey) onCanonicalKey?.(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const containerId = container?.id ?? null;
  const reload = useCallback(async () => {
    if (containerId == null || usuniety.current) return;
    try {
      const c = (await api.get(`/containers/${containerId}`)) as Container;
      if (c) setContainer(c);
    } catch {
      toast("Nie udało się odświeżyć kontenera", "warning");
    }
  }, [containerId]);

  const ensureFormDeps = async (withCatalog: boolean): Promise<boolean> => {
    const needM = manufacturers == null;
    const needT = withCatalog && ctTypes == null;
    const needP = withCatalog && catalog == null;
    if (!needM && !needT && !needP) return true;
    setBooting(true);
    const [m, t, p] = await Promise.allSettled([
      needM ? api.get("/manufacturers") : Promise.resolve(null),
      needT ? api.get("/container-types") : Promise.resolve(null),
      needP ? api.get("/products?include=ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE,SAMPLE") : Promise.resolve(null),
    ]);
    setBooting(false);
    if (needM) setManufacturers(m.status === "fulfilled" ? ((m.value as Manufacturer[]) || []) : []);
    if (needT) setCtTypes(t.status === "fulfilled" ? ((t.value as ContainerType[]) || []) : []);
    if (needP) setCatalog(p.status === "fulfilled" ? ((p.value as Product[]) || []) : []);
    const failed = (needM && m.status === "rejected") || (needT && t.status === "rejected") || (needP && p.status === "rejected");
    if (failed) toast("Nie udało się wczytać danych formularza", "warning");
    return !failed;
  };

  const openEdit = async () => { if (await ensureFormDeps(true)) setFormOpen(true); };
  const openPO = async () => { if (await ensureFormDeps(false)) setPoOpen(true); };

  // ── Akcje z karty — 1:1 z widoku Kontenerów ───────────────
  const advance = async () => {
    if (!container) return;
    const idx = STATUS_FLOW.indexOf(container.status);
    if (idx < 0 || idx >= STATUS_FLOW.length - 1) return;
    try {
      await api.patch(`/containers/${container.id}`, { status: STATUS_FLOW[idx + 1] });
      await reload();
    } catch {
      toast("Nie udało się zmienić statusu", "warning");
    }
  };

  const setDelivered = async (dateStr: string | null) => {
    if (!container) return;
    try {
      await api.patch(`/containers/${container.id}`, { delivered_date: dateStr });
      await reload();
      toast(dateStr ? "Zapisano datę dostawy — kontener domknięty" : "Zdjęto potwierdzenie dostawy", "ok");
    } catch {
      toast("Nie udało się zapisać daty dostawy", "warning");
      throw new Error("save failed");
    }
  };

  const toggleSubiekt = async (lotId: number | null, value: boolean) => {
    if (!container) return;
    try {
      await api.post(`/containers/${container.id}/subiekt-wbite`, { lot_id: lotId, value });
      await reload();
      toast(value ? "Oznaczono: w Subiekcie (magazyn w drodze)" : "Cofnięto: z powrotem w apce", "ok");
    } catch (e) {
      const err = e as { status?: number; message?: string };
      const why = [err?.status, err?.message].filter(Boolean).join(": ") || "brak odpowiedzi serwera";
      toast(`Nie udało się zmienić statusu: ${why}`, "warning");
    }
  };

  // Producent z przycisku karty: id → nazwa (z samego kontenera, bez dodatkowego zapytania).
  const mfrNameById = useMemo(() => {
    const m = new Map<number, string>();
    if (container?.manufacturer_id != null && container.manufacturer_name) m.set(container.manufacturer_id, container.manufacturer_name);
    for (const l of container?.lots ?? []) if (l.manufacturer_id != null && l.manufacturer_name) m.set(l.manufacturer_id, l.manufacturer_name);
    return m;
  }, [container]);

  const pasek = (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 12, minHeight: 28 }}>
      <Breadcrumbs trail={trail} onNavigate={onCrumb} />
    </div>
  );

  // Zakładka „Koszt jednostkowy" pojawia się TYLKO przy uprawnieniu — bez niego pasek
  // ma jedną pozycję i nikt się nie dowie, że rozliczenie odprawy w ogóle istnieje.
  const paskZakladek = pokazKoszt ? (
    <div style={{ display: "flex", gap: 2, marginBottom: 14, borderBottom: "1px solid var(--border-soft)" }}>
      {([["przeglad", "Przegląd"], ["koszt", "Koszt jednostkowy"]] as const).map(([k, label]) => (
        <button key={k} onClick={() => setTab(k)}
          style={{
            border: 0, background: "none", font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer",
            padding: "9px 13px", marginBottom: -1, color: tab === k ? "var(--text-hi)" : "var(--text-lo)",
            borderBottom: `2px solid ${tab === k ? "var(--accent)" : "transparent"}`,
          }}>
          {label}
        </button>
      ))}
    </div>
  ) : null;

  if (nieZnaleziono) {
    return (
      <div className="fade-in">
        {pasek}
        <div style={{ padding: 48, textAlign: "center", background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)" }}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)" }}>{containerKey}</div>
          <p style={{ color: "var(--text-lo)", fontSize: 13, margin: "8px 0 16px" }}>Nie znaleziono kontenera o tym numerze ani FV.</p>
          <button onClick={onBackToList} style={backBtn}>Lista kontenerów</button>
        </div>
      </div>
    );
  }

  if (!container) {
    return (
      <div className="fade-in">
        {pasek}
        <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ height: 88, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />
          <div style={{ height: 120, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />
          <div style={{ height: 220, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ paddingBottom: 80, opacity: booting ? 0.85 : 1, transition: "opacity .15s" }}>
      <ContainersStyles />
      {pasek}
      {paskZakladek}
      {tab === "koszt" && pokazKoszt ? (
        <LandedCostTab containerId={container.id} onSaved={() => { void reload(); }} />
      ) : (
      <ContainerCard
        container={container}
        pinned
        expanded
        onToggle={() => { /* karta zawsze rozwinięta */ }}
        onEdit={() => { void openEdit(); }}
        onAdvance={() => { void advance(); }}
        onGeneratePO={canPO ? () => { void openPO(); } : undefined}
        onSetDelivered={setDelivered}
        onToggleSubiekt={toggleSubiekt}
        onManufacturerClick={(id) => { const n = mfrNameById.get(id); if (n) onOpenManufacturer(n); }}
        onProductClick={onOpenProduct}
        highlightSku={highlightSku}
      />
      )}

      {formOpen && (
        <ContainerFormModal
          initial={container}
          manufacturers={manufacturers ?? []}
          containerTypes={ctTypes ?? []}
          products={catalog ?? []}
          onClose={() => { setFormOpen(false); void reload(); }}
          onSaved={() => { void reload(); }}
          onDeleted={() => { usuniety.current = true; setFormOpen(false); onDeleted(); }}
        />
      )}
      {poOpen && (
        <OrderPdfModal container={container} manufacturers={manufacturers ?? []} onClose={() => setPoOpen(false)} />
      )}
    </div>
  );
}

const backBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  background: "var(--surface-1)", border: "1px solid var(--border-soft)", color: "var(--text-mid)",
  font: "inherit", fontSize: 12.5, padding: "6px 12px", borderRadius: "var(--r-sm)", cursor: "pointer",
};
