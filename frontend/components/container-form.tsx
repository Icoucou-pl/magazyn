"use client";
// ============================================================
// MAGAZYN — Formularz kontenera (etap 3b). Port container-form.jsx.
//   Create (POST /containers) / edit (PATCH /containers/{id}, z items),
//   usuwanie (DELETE), załączniki (POST .../attachments, DELETE /attachments/{id})
//   z reconcyliacją przy zapisie. Podgląd wypełnienia z CBM produktów.
//   Skonsolidowany kontener: kilka lotów (dostawca + PO), pozycje przypisane do lotu.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { I } from "./ui";
import { modalBackdrop, modalCard, btnPrimary, btnSecondary, Portal, type Product, type Manufacturer } from "./products-ui";
import { STATUS_FLOW, STATUS_FULL_META, type Container, type Attachment } from "./containers-ui";
import { api, download } from "@/lib/api";
import { toast } from "./toast";
import { canEdit, can, useUser } from "@/lib/permissions";
import { fmtPLN, fmtNum } from "@/lib/format";
import { computeContainerFill } from "./auto-suggest";

export type ContainerType = { id: number; name: string; capacity_cbm: number; sort_order?: number };

type ItemDraft = { sku: string; quantity: string; unit_cost: string; lotRef: string };
type LotDraft = {
  manufacturer_id: string; order_number: string;
  waluta_towaru: string; zaliczka_procent: string; zaliczka_kwota: string; zaliczka_waluta: string;
  zaliczka_data: string; balance_kwota: string; balance_waluta: string; zaplacono_data: string;
};
const emptyLot = (): LotDraft => ({
  manufacturer_id: "", order_number: "",
  waluta_towaru: "USD", zaliczka_procent: "", zaliczka_kwota: "", zaliczka_waluta: "USD",
  zaliczka_data: "", balance_kwota: "", balance_waluta: "USD", zaplacono_data: "",
});
type AttDraft = Attachment & { _isNew?: boolean; _file?: File };

const today = () => new Date().toISOString().slice(0, 10);
const plus90 = () => { const d = new Date(); d.setDate(d.getDate() + 90); return d.toISOString().slice(0, 10); };
// Okno odprawy celnej — musi odpowiadać CONTAINER_CUSTOMS_DAYS na backendzie (domyślnie 7).
const CUSTOMS_DAYS = 7;
const addDays = (iso: string, n: number) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function ContainerFormModal({
  initial, manufacturers, containerTypes, products, onClose, onSaved, onDeleted,
}: {
  initial?: Container | null;
  manufacturers: Manufacturer[];
  containerTypes: ContainerType[];
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const user = useUser();
  const showEdit = canEdit(user);
  const showFin = can(user, "viewFinancials");
  const isNew = !initial;

  // Mapowanie lot_id (z bazy) → indeks w tablicy lotów (formularz operuje na indeksach).
  const numStr = (n?: number | null) => (n == null ? "" : String(n));
  const initialLots: LotDraft[] = (initial?.lots || []).map((l) => ({
    manufacturer_id: l.manufacturer_id ? String(l.manufacturer_id) : "",
    order_number: l.order_number || "",
    waluta_towaru: l.waluta_towaru || "USD",
    zaliczka_procent: numStr(l.zaliczka_procent),
    zaliczka_kwota: numStr(l.zaliczka_kwota),
    zaliczka_waluta: l.zaliczka_waluta || l.waluta_towaru || "USD",
    zaliczka_data: l.zaliczka_data || "",
    balance_kwota: numStr(l.balance_kwota),
    balance_waluta: l.balance_waluta || l.waluta_towaru || "USD",
    zaplacono_data: l.zaplacono_data || "",
  }));
  const lotIdToIdx = new Map<number, number>();
  (initial?.lots || []).forEach((l, i) => lotIdToIdx.set(l.id, i));

  const [containerNumber, setContainerNumber] = useState(initial?.container_number || "");
  const [orderNumber, setOrderNumber] = useState(initial?.order_number || "");
  const [containerTypeId, setContainerTypeId] = useState<string>(initial?.container_type_id ? String(initial.container_type_id) : "");
  const [manufacturerId, setManufacturerId] = useState<string>(initial?.manufacturer_id ? String(initial.manufacturer_id) : "");
  const [orderDate, setOrderDate] = useState(initial?.order_date || today());
  const [etaDate, setEtaDate] = useState(initial?.eta_date || plus90());
  const [status, setStatus] = useState(initial?.status || "ORDERED");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [isConsolidated, setIsConsolidated] = useState(!!initial?.is_consolidated && initialLots.length > 0);
  const [lots, setLots] = useState<LotDraft[]>(initialLots.length ? initialLots : [emptyLot()]);
  // Koszty spedycji + dokumenty (zawsze na kontenerze)
  const [kosztTransportu, setKosztTransportu] = useState(numStr(initial?.koszt_transportu));            // USD
  const [kosztSpedycji, setKosztSpedycji] = useState(numStr(initial?.koszt_spedycji));                  // USD
  const [kosztTransportuMagazyn, setKosztTransportuMagazyn] = useState(numStr(initial?.koszt_transportu_magazyn)); // PLN
  const [folder, setFolder] = useState(initial?.folder || "");
  const [subiektNr, setSubiektNr] = useState(initial?.subiekt_nr || "");
  // Płatność kontenera nieskonsolidowanego (jeden dostawca).
  // walutaTowaru: waluta domyślna/pierwotna (seed) — nie edytowana w UI, wysyłana z powrotem bez zmian.
  const [walutaTowaru] = useState(initial?.waluta_towaru || "USD");
  const [zaliczkaProcent, setZaliczkaProcent] = useState(numStr(initial?.zaliczka_procent));
  const [zaliczkaKwota, setZaliczkaKwota] = useState(numStr(initial?.zaliczka_kwota));
  const [zaliczkaWaluta, setZaliczkaWaluta] = useState(initial?.zaliczka_waluta || initial?.waluta_towaru || "USD");
  const [zaliczkaData, setZaliczkaData] = useState(initial?.zaliczka_data || "");
  const [balanceKwota, setBalanceKwota] = useState(numStr(initial?.balance_kwota));
  const [balanceWaluta, setBalanceWaluta] = useState(initial?.balance_waluta || initial?.waluta_towaru || "USD");
  const [zaplaconoData, setZaplaconoData] = useState(initial?.zaplacono_data || "");
  const [items, setItems] = useState<ItemDraft[]>(
    initial?.items?.map((i) => ({
      sku: i.sku, quantity: String(i.quantity), unit_cost: i.unit_cost ? String(i.unit_cost) : "",
      lotRef: (i.lot_id != null && lotIdToIdx.has(i.lot_id)) ? String(lotIdToIdx.get(i.lot_id)) : "",
    })) || [{ sku: "", quantity: "", unit_cost: "", lotRef: "" }],
  );
  const [attachments, setAttachments] = useState<AttDraft[]>(initial?.attachments || []);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [coverMonths, setCoverMonths] = useState("6");  // horyzont pokrycia dla autosugestii (mies.)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const productBySku = useMemo(() => {
    const m = new Map<string, Product>();
    products.forEach((p) => m.set(p.sku, p));
    return m;
  }, [products]);

  const containerType = containerTypes.find((t) => String(t.id) === containerTypeId);
  const capacity = containerType?.capacity_cbm || 0;

  const sortedProducts = useMemo(() => {
    if (isConsolidated || !manufacturerId) return products;
    const mfrId = Number(manufacturerId);
    return [...products].sort((a, b) => {
      const am = a.manufacturer_id === mfrId ? 0 : 1;
      const bm = b.manufacturer_id === mfrId ? 0 : 1;
      return am - bm || a.sku.localeCompare(b.sku);
    });
  }, [manufacturerId, products, isConsolidated]);

  const itemDetails = items.map((item) => {
    const product = productBySku.get(item.sku);
    const qty = parseInt(item.quantity, 10) || 0;
    return {
      ...item, product, qty,
      cbm: (product?.cbm_per_unit || 0) * qty,
      value: (parseFloat(item.unit_cost) || 0) * qty,
      isMixed: !isConsolidated && !!(manufacturerId && product?.manufacturer_id && product.manufacturer_id !== Number(manufacturerId)),
    };
  });

  const totalCbm = itemDetails.reduce((s, i) => s + i.cbm, 0);
  const totalUnits = itemDetails.reduce((s, i) => s + i.qty, 0);
  const totalValue = itemDetails.reduce((s, i) => s + i.value, 0);
  const fillPct = capacity > 0 ? (totalCbm / capacity) * 100 : 0;
  const fillColor = fillPct > 100 ? "var(--critical)" : fillPct > 90 ? "var(--warning)" : fillPct > 70 ? "var(--ok)" : "var(--info)";

  const addItem = () => setItems([...items, { sku: "", quantity: "", unit_cost: "", lotRef: "" }]);
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));
  const updateItem = (idx: number, field: keyof ItemDraft, value: string) => {
    const next = [...items];
    next[idx] = { ...next[idx], [field]: value };
    if (field === "sku" && value && !next[idx].unit_cost) {
      const product = productBySku.get(value);
      if (product) next[idx].unit_cost = String(product.purchase_price);
    }
    setItems(next);
  };

  // ── Automatyczne wypełnienie kontenera ───────────────────────
  // Wspólny algorytm (computeContainerFill): pokrywa realne potrzeby wg pilności, a wolną
  // przestrzeń dopełnia wg popytu — dąży do ~100% CBM. Szanuje pozycje już wpisane ręcznie
  // (liczy od wolnej przestrzeni, pomija SKU już na liście). Zakres: wybrany producent, jeśli jest.
  const autoFill = () => {
    if (!showEdit) return;
    if (capacity <= 0) { toast("Najpierw wybierz typ kontenera — potrzebna pojemność CBM", "warning"); return; }
    const months = Math.max(0.5, parseFloat(coverMonths.replace(",", ".")) || 6);

    const usedSkus = new Set(items.map((i) => i.sku).filter(Boolean));
    const mfrId = !isConsolidated && manufacturerId ? Number(manufacturerId) : null;
    const pool = products.filter((p) => !usedSkus.has(p.sku) && (mfrId === null || p.manufacturer_id === mfrId));

    if (capacity - totalCbm <= 1e-6) { toast("Kontener już pełny — brak wolnego miejsca na autouzupełnienie", "info"); return; }

    const lines = computeContainerFill(pool, capacity, months, totalCbm);
    if (lines.length === 0) {
      toast(mfrId !== null ? "Brak sprzedających się produktów tego producenta do dołożenia" : "Brak produktów do dołożenia w wolnej przestrzeni", "info");
      return;
    }

    const additions: ItemDraft[] = lines.map((l) => ({
      sku: l.sku, quantity: String(l.quantity), unit_cost: l.unit_cost ? String(l.unit_cost) : "", lotRef: "",
    }));
    setItems((prev) => {
      const kept = prev.filter((i) => i.sku || (parseInt(i.quantity, 10) || 0) > 0);
      return [...kept, ...additions];
    });

    const addedCbm = lines.reduce((s, l) => s + l.cbm_total, 0);
    const pct = ((totalCbm + addedCbm) / capacity) * 100;
    toast(`Dodano ${additions.length} ${additions.length === 1 ? "pozycję" : "pozycji"} · wypełnienie ${pct.toFixed(0)}%`, "ok");
  };

  // ── Loty (skonsolidowany kontener) ─────────────────────────
  const addLot = () => setLots([...lots, emptyLot()]);
  const updateLot = (idx: number, field: keyof LotDraft, value: string) => {
    const next = [...lots];
    next[idx] = { ...next[idx], [field]: value };
    setLots(next);
  };
  const removeLot = (idx: number) => {
    if (lots.length <= 1) { toast("Skonsolidowany kontener musi mieć przynajmniej jeden lot", "warning"); return; }
    setLots(lots.filter((_, i) => i !== idx));
    // Przeindeksuj przypisania pozycji: usunięty lot → brak; loty po nim przesuwają się o 1 w dół.
    setItems((prev) => prev.map((it) => {
      if (it.lotRef === "") return it;
      const ref = Number(it.lotRef);
      if (ref === idx) return { ...it, lotRef: "" };
      if (ref > idx) return { ...it, lotRef: String(ref - 1) };
      return it;
    }));
  };
  const toggleConsolidated = (on: boolean) => {
    setIsConsolidated(on);
    if (on && lots.length === 0) setLots([emptyLot()]);
  };

  const guessType = (name: string) => {
    const e = name.split(".").pop()?.toLowerCase() || "";
    return e === "pdf" ? "pdf" : (e === "xlsx" || e === "xls") ? "excel" : (["png", "jpg", "jpeg", "webp", "gif"].includes(e) ? "image" : (e || "other"));
  };
  const humanSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const MAX = 10 * 1024 * 1024;

  const onFiles = (files: File[]) => {
    const ok = files.filter((f) => f && f.size <= MAX);
    if (ok.length < files.length) toast("Pominięto plik(i) > 10 MB", "warning");
    const additions: AttDraft[] = ok.map((f) => ({
      id: Date.now() + Math.floor(Math.random() * 1e6),
      filename: f.name, file_type: guessType(f.name), file_size: humanSize(f.size),
      uploaded_at: new Date().toISOString(), _isNew: true, _file: f,
    }));
    if (additions.length) setAttachments((prev) => [...prev, ...additions]);
  };
  const removeAttachment = (id: number) => setAttachments(attachments.filter((a) => a.id !== id));
  const downloadAttachment = (a: AttDraft) => { download(`/attachments/${a.id}/download`, a.filename).catch(() => toast("Nie udało się pobrać pliku", "warning")); };

  const save = async () => {
    if (busy) return;
    if (!containerNumber.trim()) { toast("Podaj numer kontenera", "warning"); return; }
    const validItems = items.filter((i) => i.sku && (parseInt(i.quantity, 10) || 0) > 0);
    if (validItems.length === 0) { toast("Dodaj co najmniej jedną pozycję (SKU + ilość)", "warning"); return; }

    if (isConsolidated) {
      const cleanLots = lots.filter((l) => l.manufacturer_id || l.order_number.trim());
      if (cleanLots.length < 1) { toast("Skonsolidowany kontener wymaga przynajmniej jednego lotu (dostawca lub PO)", "warning"); return; }
      if (cleanLots.length !== lots.length) { toast("Uzupełnij dostawcę lub PO w każdym locie (albo usuń pusty lot)", "warning"); return; }
      const unassigned = validItems.filter((i) => i.lotRef === "");
      if (unassigned.length > 0) { toast(`Przypisz lot do każdej pozycji (bez przypisania: ${unassigned.length})`, "warning"); return; }
    }

    const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
    const dateOrNull = (s: string) => (s.trim() === "" ? null : s);

    const payload = {
      container_number: containerNumber.trim(),
      order_number: isConsolidated ? null : (orderNumber.trim() || null),
      container_type_id: containerTypeId ? Number(containerTypeId) : null,
      manufacturer_id: isConsolidated ? null : (manufacturerId ? Number(manufacturerId) : null),
      order_date: orderDate,
      eta_date: etaDate,
      status,
      notes: notes.trim() || null,
      is_consolidated: isConsolidated,
      // koszty spedycji + dokumenty (zawsze na kontenerze)
      koszt_transportu: numOrNull(kosztTransportu),
      koszt_spedycji: numOrNull(kosztSpedycji),
      koszt_transportu_magazyn: numOrNull(kosztTransportuMagazyn),   // PLN
      folder: folder.trim() || null,
      subiekt_nr: subiektNr.trim() || null,
      // płatność kontenera nieskonsolidowanego (przy konsolidacji → null, dane w lotach)
      waluta_towaru: isConsolidated ? null : walutaTowaru,
      zaliczka_procent: isConsolidated ? null : numOrNull(zaliczkaProcent),
      zaliczka_kwota: isConsolidated ? null : numOrNull(zaliczkaKwota),
      zaliczka_waluta: isConsolidated ? null : zaliczkaWaluta,
      zaliczka_data: isConsolidated ? null : dateOrNull(zaliczkaData),
      balance_kwota: isConsolidated ? null : numOrNull(balanceKwota),
      balance_waluta: isConsolidated ? null : balanceWaluta,
      zaplacono_data: isConsolidated ? null : dateOrNull(zaplaconoData),
      lots: isConsolidated ? lots.map((l) => ({
        manufacturer_id: l.manufacturer_id ? Number(l.manufacturer_id) : null,
        order_number: l.order_number.trim() || null,
        waluta_towaru: l.waluta_towaru || "USD",
        zaliczka_procent: numOrNull(l.zaliczka_procent),
        zaliczka_kwota: numOrNull(l.zaliczka_kwota),
        zaliczka_waluta: l.zaliczka_waluta || "USD",
        zaliczka_data: dateOrNull(l.zaliczka_data),
        balance_kwota: numOrNull(l.balance_kwota),
        balance_waluta: l.balance_waluta || "USD",
        zaplacono_data: dateOrNull(l.zaplacono_data),
      })) : [],
      items: validItems.map((i) => ({
        sku: i.sku, quantity: parseInt(i.quantity, 10), unit_cost: i.unit_cost ? parseFloat(i.unit_cost) : null,
        lot_ref: isConsolidated && i.lotRef !== "" ? Number(i.lotRef) : null,
      })),
    };

    setBusy(true);
    try {
      const saved = isNew
        ? ((await api.post("/containers", payload)) as Container)
        : ((await api.patch(`/containers/${initial!.id}`, payload)) as Container);
      const cid = saved.id;

      // Reconcyliacja załączników (błąd tu nie unieważnia zapisu kontenera)
      let attOk = true;
      let attErr = "";
      try {
        const toAdd = attachments.filter((a) => a._isNew && a._file);
        const initialIds = new Set((initial?.attachments || []).map((a) => a.id));
        const keptRealIds = new Set(attachments.filter((a) => !a._isNew).map((a) => a.id));
        const toDelete = [...initialIds].filter((id) => !keptRealIds.has(id));
        await Promise.all([
          ...toAdd.map((a) => { const fd = new FormData(); fd.append("file", a._file as File); return api.post(`/containers/${cid}/attachments`, fd); }),
          ...toDelete.map((id) => api.del(`/attachments/${id}`)),
        ]);
      } catch (e) {
        attOk = false;
        const st = (e as { status?: number })?.status;
        attErr = st === 422 || st === 405
          ? "backend nieaktualny — przedeployuj serwis web (routers/containers.py + lifespan.py)"
          : st === 413 ? "plik za duży (max 10 MB)"
          : ((e as Error)?.message || "błąd uploadu");
      }

      toast(attOk ? (isNew ? `Utworzono kontener #${payload.container_number}` : "Zapisano zmiany w kontenerze") : `Plik nie wgrany: ${attErr}`, attOk ? "ok" : "warning");
      onSaved();
      if (attOk) onClose();
    } catch {
      toast(isNew ? "Nie udało się utworzyć kontenera" : "Nie udało się zapisać zmian", "warning");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!initial || busy) return;
    if (!window.confirm(`Usunąć kontener #${initial.container_number}? Tej operacji nie można cofnąć.`)) return;
    setBusy(true);
    try {
      await api.del(`/containers/${initial.id}`);
      toast("Usunięto kontener", "ok");
      onDeleted();
      onClose();
    } catch {
      toast("Nie udało się usunąć kontenera", "warning");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Portal>
      <div onClick={onClose} style={modalBackdrop}>
        <div onClick={(e) => e.stopPropagation()} className="fade-in" style={{ ...modalCard, maxWidth: 880 }}>
          {/* Header */}
          <div style={{ padding: "14px 22px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}><I.Ship size={16} /></div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-hi)" }}>{isNew ? "Nowy kontener" : `Edycja: #${initial!.container_number}`}</div>
                {!isNew && <div style={{ fontSize: 11, color: "var(--text-lo)" }}>{initial!.items.length} pozycji · {fmtNum(initial!.total_units)} szt</div>}
              </div>
            </div>
            <button onClick={onClose} style={iconBtnHeader}><I.Close size={14} /></button>
          </div>

          {/* Body */}
          <div style={{ overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
            <Section title="Identyfikacja">
              {/* Przełącznik konsolidacji */}
              <button type="button" onClick={() => showEdit && toggleConsolidated(!isConsolidated)} disabled={!showEdit}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 10, background: isConsolidated ? "var(--accent-soft)" : "var(--surface-2)", border: `1px solid ${isConsolidated ? "var(--accent)" : "var(--border-soft)"}`, borderRadius: 8, cursor: showEdit ? "pointer" : "default", textAlign: "left", transition: "all 0.12s" }}>
                <span style={{ width: 34, height: 20, borderRadius: 99, background: isConsolidated ? "var(--accent)" : "var(--surface-3)", position: "relative", flexShrink: 0, transition: "background 0.15s" }}>
                  <span style={{ position: "absolute", top: 2, left: isConsolidated ? 16 : 2, width: 16, height: 16, borderRadius: 99, background: "#fff", transition: "left 0.15s" }} />
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: isConsolidated ? "var(--accent)" : "var(--text-mid)" }}>Kontener skonsolidowany</span>
                  <span style={{ display: "block", fontSize: 10.5, color: "var(--text-lo)" }}>Kilka zamówień (PO) od różnych dostawców w jednym kontenerze</span>
                </span>
              </button>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <Field label="Nr kontenera" required>
                  <input value={containerNumber} onChange={(e) => setContainerNumber(e.target.value.toUpperCase())} placeholder="np. MSCU-7821934" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                </Field>
                {!isConsolidated && (
                  <Field label="Nr zamówienia (PO)">
                    <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="np. PO-2026-001" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                  </Field>
                )}
                <Field label="Typ kontenera">
                  <select value={containerTypeId} onChange={(e) => setContainerTypeId(e.target.value)} disabled={!showEdit} style={inputStyle}>
                    <option value="">— wybierz —</option>
                    {containerTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.capacity_cbm} m³)</option>)}
                  </select>
                </Field>
                {!isConsolidated && (
                  <Field label="Producent (dostawca)">
                    <select value={manufacturerId} onChange={(e) => setManufacturerId(e.target.value)} disabled={!showEdit} style={inputStyle}>
                      <option value="">— wybierz —</option>
                      {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Data zamówienia" required>
                  <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!showEdit} style={inputStyle} />
                </Field>
                <Field label="ETA (planowana dostawa)" required>
                  <input type="date" value={etaDate} onChange={(e) => setEtaDate(e.target.value)} disabled={!showEdit} style={inputStyle} />
                  {etaDate && (
                    <span style={{ display: "block", fontSize: 10.5, color: "var(--text-lo)", marginTop: 4 }}>
                      Wejście do magazynu po odprawie (~{CUSTOMS_DAYS} dni): <strong style={{ color: "var(--text-mid)" }}>{addDays(etaDate, CUSTOMS_DAYS)}</strong>
                    </span>
                  )}
                </Field>
              </div>
            </Section>

            {isConsolidated && (
              <Section title={`Loty — dostawcy i PO (${lots.length})`} required action={showEdit ? <button onClick={addLot} style={btnGhostMini}><I.Plus size={11} /> Dodaj lot</button> : undefined}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {lots.map((lot, idx) => {
                    const lotUnits = itemDetails.filter((it) => it.lotRef === String(idx)).reduce((s, it) => s + it.qty, 0);
                    return (
                      <div key={idx} style={{ padding: 10, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr) 150px 30px", gap: 6, alignItems: "center" }}>
                          <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", textAlign: "center" }}>#{idx + 1}</span>
                          <select value={lot.manufacturer_id} onChange={(e) => updateLot(idx, "manufacturer_id", e.target.value)} disabled={!showEdit} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12 }}>
                            <option value="">— dostawca —</option>
                            {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </select>
                          <input value={lot.order_number} onChange={(e) => updateLot(idx, "order_number", e.target.value)} placeholder="Nr PO" disabled={!showEdit} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, fontFamily: "var(--font-mono)" }} />
                          <button onClick={() => removeLot(idx)} disabled={!showEdit} title="Usuń lot" style={{ background: "transparent", border: "1px solid var(--border-soft)", color: "var(--critical)", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, height: 32 }}><I.Close size={12} /></button>
                        </div>
                        {showFin && (
                          <PaymentInputs v={lot} disabled={!showEdit} onChange={(f, val) => updateLot(idx, f as keyof LotDraft, val)} />
                        )}
                        <div style={{ fontSize: 10, color: "var(--text-lo)" }} className="num">{lotUnits} szt przypisanych</div>
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            {!isConsolidated && showFin && (
              <Section title="Płatność (dostawca)">
                <PaymentInputs
                  v={{ zaliczka_procent: zaliczkaProcent, zaliczka_kwota: zaliczkaKwota, zaliczka_waluta: zaliczkaWaluta, zaliczka_data: zaliczkaData, balance_kwota: balanceKwota, balance_waluta: balanceWaluta, zaplacono_data: zaplaconoData }}
                  disabled={!showEdit}
                  onChange={(f, val) => {
                    if (f === "zaliczka_procent") setZaliczkaProcent(val);
                    else if (f === "zaliczka_kwota") setZaliczkaKwota(val);
                    else if (f === "zaliczka_waluta") setZaliczkaWaluta(val);
                    else if (f === "zaliczka_data") setZaliczkaData(val);
                    else if (f === "balance_kwota") setBalanceKwota(val);
                    else if (f === "balance_waluta") setBalanceWaluta(val);
                    else if (f === "zaplacono_data") setZaplaconoData(val);
                  }}
                />
              </Section>
            )}

            <Section title="Spedycja i dokumenty">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                {showFin && (
                  <Field label="Koszt transportu (USD)">
                    <input type="number" step="0.01" min="0" value={kosztTransportu} onChange={(e) => setKosztTransportu(e.target.value)} placeholder="np. 2500" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                  </Field>
                )}
                {showFin && (
                  <Field label="Koszt spedycji (USD)">
                    <input type="number" step="0.01" min="0" value={kosztSpedycji} onChange={(e) => setKosztSpedycji(e.target.value)} placeholder="cały rachunek, np. 3000" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                    {showFin && kosztSpedycji.trim() !== "" && kosztTransportu.trim() !== "" && (
                      <span style={{ display: "block", fontSize: 10.5, color: "var(--text-lo)", marginTop: 4 }}>
                        Opłata spedycji: <strong style={{ color: "var(--text-mid)" }}>${(Number(kosztSpedycji) - Number(kosztTransportu)).toLocaleString("pl-PL")}</strong>
                      </span>
                    )}
                  </Field>
                )}
                {showFin && (
                  <Field label="Transport do magazynu (PLN)" labelStyle={{ fontSize: 9, letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
                    <input type="number" step="0.01" min="0" value={kosztTransportuMagazyn} onChange={(e) => setKosztTransportuMagazyn(e.target.value)} placeholder="z portu do magazynu, np. 1800" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                  </Field>
                )}
                <Field label="Folder">
                  <input value={folder} onChange={(e) => setFolder(e.target.value.toUpperCase())} placeholder="np. C120" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                </Field>
                <Field label="Subiekt">
                  <input value={subiektNr} onChange={(e) => setSubiektNr(e.target.value)} placeholder="numer + cyfra" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                </Field>
              </div>
            </Section>

            <Section title="Status">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 6 }}>
                {STATUS_FLOW.map((s) => {
                  const meta = STATUS_FULL_META[s];
                  const Icon = meta.icon;
                  const active = status === s;
                  return (
                    <button key={s} onClick={() => showEdit && setStatus(s)} disabled={!showEdit} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "10px 12px", background: active ? meta.bg : "var(--surface-2)", color: active ? meta.fg : "var(--text-mid)", border: `1px solid ${active ? meta.accent : "var(--border-soft)"}`, borderRadius: 8, fontSize: 12, fontWeight: 600, letterSpacing: "0.02em", transition: "all 0.12s" }}>
                      <Icon size={13} /> {meta.label}
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="Notatki">
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} disabled={!showEdit} placeholder="Opcjonalne komentarze (np. statek, dodatkowe info)" style={{ ...inputStyle, resize: "vertical", minHeight: 60 }} />
            </Section>

            <Section title={`Załączniki (${attachments.length})`}>
              <input ref={fileRef} type="file" multiple style={{ display: "none" }}
                onChange={(e) => { onFiles(Array.from(e.target.files || [])); if (fileRef.current) fileRef.current.value = ""; }} />
              <div
                onDragOver={(e) => { if (showEdit) { e.preventDefault(); setDragging(true); } }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { if (!showEdit) return; e.preventDefault(); setDragging(false); onFiles(Array.from(e.dataTransfer.files || [])); }}
                style={{ padding: 8, background: dragging ? "var(--accent-soft)" : "var(--surface-2)", border: `1px dashed ${dragging ? "var(--accent)" : "var(--border-soft)"}`, borderRadius: 8, display: "flex", flexDirection: "column", gap: 4, minHeight: 50, transition: "all 0.12s" }}>
                {showEdit && (
                  <button type="button" onClick={() => fileRef.current?.click()} style={{ ...btnGhostMini, justifyContent: "center", padding: "8px 10px", whiteSpace: "nowrap" }}>
                    <I.ArrowDown size={12} /> Wybierz plik(i) lub przeciągnij tutaj
                  </button>
                )}
                {attachments.length === 0 ? (
                  <div style={{ padding: 8, textAlign: "center", fontSize: 11, color: "var(--text-lo)" }}>Brak załączników (faktura, proforma, packing list, BL...)</div>
                ) : attachments.map((att) => {
                  const tint = att.file_type === "pdf" ? ["var(--critical-soft)", "var(--critical)"] : att.file_type === "image" ? ["var(--info-soft)", "var(--info)"] : ["var(--ok-soft)", "var(--ok)"];
                  return (
                    <div key={att.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 6 }}>
                      <span className="mono" style={{ padding: "1px 5px", fontSize: 9, fontWeight: 700, background: tint[0], color: tint[1], borderRadius: 3, flexShrink: 0 }}>{(att.file_type || "?").toUpperCase()}</span>
                      {att._isNew ? (
                        <span className="mono" style={{ flex: 1, fontSize: 12, color: "var(--text-hi)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.filename}</span>
                      ) : (
                        <button type="button" onClick={() => downloadAttachment(att)} title="Pobierz plik" className="mono" style={{ flex: 1, textAlign: "left", background: "transparent", border: "none", padding: 0, fontSize: 12, color: "var(--accent)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "underline" }}>{att.filename}</button>
                      )}
                      {att.file_size && <span className="num" style={{ fontSize: 10, color: "var(--text-lo)", flexShrink: 0 }}>{att.file_size}</span>}
                      {att._isNew && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--accent)", background: "var(--accent-soft)", padding: "1px 5px", borderRadius: 3, flexShrink: 0 }}>DO WGRANIA</span>}
                      {showEdit && <button type="button" onClick={() => removeAttachment(att.id)} style={{ background: "transparent", border: "none", color: "var(--critical)", padding: 4, display: "flex" }}><I.Close size={12} /></button>}
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section title={`Produkty (${items.length})`} required action={showEdit ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }} title="Horyzont pokrycia sugerowanej ilości (miesiące sprzedaży)">
                  <input type="number" min={0.5} step={0.5} value={coverMonths} onChange={(e) => setCoverMonths(e.target.value)}
                    style={{ width: 46, padding: "4px 6px", fontSize: 11, textAlign: "right", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-hi)", outline: "none", fontFamily: "var(--font-mono)" }} />
                  <span style={{ fontSize: 10.5, color: "var(--text-lo)" }}>mies.</span>
                </div>
                <button onClick={autoFill} disabled={capacity <= 0}
                  title={capacity <= 0 ? "Wybierz typ kontenera, aby dobrać ilości do pojemności CBM" : "Dobierz produkty do zamówienia i dopełnij kontener do 100% CBM"}
                  style={{ ...btnGhostMini, opacity: capacity <= 0 ? 0.45 : 1, borderColor: capacity > 0 ? "var(--accent)" : "var(--border-soft)", color: capacity > 0 ? "var(--accent)" : "var(--text-lo)" }}>
                  <I.Sparkles size={11} /> Uzupełnij automatycznie
                </button>
                <button onClick={addItem} style={btnGhostMini}><I.Plus size={11} /> Dodaj pozycję</button>
              </div>
            ) : undefined}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {itemDetails.map((item, idx) => (
                  <ItemRow key={idx} item={item} sortedProducts={sortedProducts} manufacturers={manufacturers} disabled={!showEdit} showFin={showFin}
                    consolidated={isConsolidated} lots={lots}
                    onChange={(field, val) => updateItem(idx, field, val)} onRemove={() => removeItem(idx)} />
                ))}
              </div>
              {showFin && (
                <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  <I.Wand size={11} style={{ color: "var(--accent)" }} /> Cena auto-wypełnia się z bazy produktów. Można nadpisać.
                </div>
              )}
            </Section>

            {capacity > 0 && (
              <div style={{ padding: 14, background: "var(--surface-2)", border: `1px solid ${fillPct > 100 ? "var(--critical)" : "var(--border-soft)"}`, borderRadius: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Wypełnienie {containerType?.name}</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                    <span className="num" style={{ fontSize: 13, color: "var(--text-lo)" }}>{totalUnits} szt{showFin && <> · {fmtPLN(totalValue)}</>}</span>
                    <span className="num" style={{ fontSize: 18, fontWeight: 600, color: fillColor }}>{totalCbm.toFixed(3)} <span style={{ color: "var(--text-lo)", fontSize: 11 }}>/ {capacity} m³ ·</span> <span style={{ color: "var(--text-hi)" }}>{fillPct.toFixed(0)}%</span></span>
                  </div>
                </div>
                <div style={{ height: 8, background: "var(--surface-3)", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, fillPct)}%`, background: fillColor, borderRadius: 99, transition: "width 0.3s" }} />
                </div>
                {fillPct > 100 && <div style={{ fontSize: 11, color: "var(--critical)", marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}><I.Alert size={11} /> Przekroczono pojemność o {(fillPct - 100).toFixed(1)}% — zmniejsz ilości lub wybierz większy typ</div>}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 22px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-elevated)" }}>
            {!isNew && showEdit ? (
              <button onClick={doDelete} disabled={busy} style={{ ...btnGhost, color: "var(--critical)" }}><I.Close size={12} /> Usuń kontener</button>
            ) : <div />}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose} style={btnSecondary}>{showEdit ? "Anuluj" : "Zamknij"}</button>
              {showEdit && (
                <button onClick={save} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Zapisuję…" : isNew ? "Utwórz kontener" : "Zapisz zmiany"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}

// ── Wiersz pozycji ───────────────────────────────────────────
function ItemRow({
  item, sortedProducts, manufacturers, disabled, showFin, consolidated, lots, onChange, onRemove,
}: {
  item: { sku: string; quantity: string; unit_cost: string; lotRef: string; product?: Product; qty: number; cbm: number; value: number; isMixed: boolean };
  sortedProducts: Product[]; manufacturers: Manufacturer[]; disabled: boolean; showFin: boolean;
  consolidated: boolean; lots: LotDraft[];
  onChange: (field: "sku" | "quantity" | "unit_cost" | "lotRef", val: string) => void; onRemove: () => void;
}) {
  const mixedMfrName = item.product?.manufacturer_id ? manufacturers.find((m) => m.id === item.product!.manufacturer_id)?.name : undefined;
  // Niezgodność dostawcy w trybie skonsolidowanym: SKU innego producenta niż wybrany lot.
  const lotMfrId = consolidated && item.lotRef !== "" ? lots[Number(item.lotRef)]?.manufacturer_id : "";
  const lotMismatch = !!(consolidated && item.product?.manufacturer_id && lotMfrId && Number(lotMfrId) !== item.product.manufacturer_id);
  const warn = item.isMixed || lotMismatch;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 80px 90px 30px", gap: 6, alignItems: "flex-start", padding: 8, background: warn ? "color-mix(in oklch, var(--warning) 8%, var(--surface-2))" : "var(--surface-2)", border: `1px solid ${warn ? "color-mix(in oklch, var(--warning) 40%, var(--border))" : "var(--border-soft)"}`, borderRadius: 8 }}>
      <div style={{ minWidth: 0 }}>
        <select value={item.sku} onChange={(e) => onChange("sku", e.target.value)} disabled={disabled} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, width: "100%" }}>
          <option value="">— wybierz produkt —</option>
          {sortedProducts.map((p) => (
            <option key={p.sku} value={p.sku}>
              {p.sku} — {p.name.length > 34 ? p.name.slice(0, 34) + "…" : p.name}
              {p.manufacturer_name ? ` · ${p.manufacturer_name}` : ""}
              {p.cbm_per_unit > 0 ? ` · ${p.cbm_per_unit.toFixed(3)}m³` : ""}
            </option>
          ))}
        </select>

        {consolidated && (
          <select value={item.lotRef} onChange={(e) => onChange("lotRef", e.target.value)} disabled={disabled} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, width: "100%", marginTop: 4 }}>
            <option value="">— przypisz lot —</option>
            {lots.map((l, i) => {
              const mName = l.manufacturer_id ? manufacturers.find((m) => m.id === Number(l.manufacturer_id))?.name : null;
              return <option key={i} value={String(i)}>#{i + 1} {mName || "bez dostawcy"}{l.order_number ? ` · ${l.order_number}` : ""}</option>;
            })}
          </select>
        )}

        {item.product && (
          warn ? (
            <div style={{ fontSize: 10, color: "var(--warning)", fontWeight: 600, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
              <I.Alert size={10} /> {lotMismatch ? `SKU innego dostawcy niż lot${mixedMfrName ? ` (${mixedMfrName})` : ""}` : `Inny dostawca niż kontener${mixedMfrName ? ` (${mixedMfrName})` : ""}`}
            </div>
          ) : (
            <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
              Dostawca: <span style={{ color: "var(--text-mid)" }}>{item.product.manufacturer_name || "— brak —"}</span>
            </div>
          )
        )}
        {item.qty > 0 && item.cbm > 0 && (
          <div className="num" style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
            Zajmie: <strong style={{ color: "var(--text-mid)" }}>{item.cbm.toFixed(3)} m³</strong>{showFin && item.value > 0 && <span> · {fmtPLN(item.value)}</span>}
          </div>
        )}
      </div>
      <input type="number" value={item.quantity} onChange={(e) => onChange("quantity", e.target.value)} placeholder="szt" min="1" disabled={disabled} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, fontFamily: "var(--font-mono)", textAlign: "right" }} />
      {showFin ? (
        <input type="number" value={item.unit_cost} onChange={(e) => onChange("unit_cost", e.target.value)} placeholder="cena" step="0.01" disabled={disabled} title={item.product ? `Z bazy: ${item.product.purchase_price} zł` : ""} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, fontFamily: "var(--font-mono)", textAlign: "right" }} />
      ) : (
        <div style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, fontFamily: "var(--font-mono)", textAlign: "right", color: "var(--text-disabled)", display: "flex", alignItems: "center", justifyContent: "flex-end" }}>•••</div>
      )}
      <button onClick={onRemove} disabled={disabled} style={{ background: "transparent", border: "1px solid var(--border-soft)", color: "var(--critical)", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, height: 32 }}><I.Close size={12} /></button>
    </div>
  );
}

// ── Helpery / style ──────────────────────────────────────────
function Section({ title, action, children, required }: { title: string; action?: React.ReactNode; children: React.ReactNode; required?: boolean }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {title}{required && <span style={{ color: "var(--critical)", marginLeft: 4 }}>*</span>}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({ label, required, children, labelStyle }: { label: string; required?: boolean; children: React.ReactNode; labelStyle?: React.CSSProperties }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5, ...labelStyle }}>
        {label}{required && <span style={{ color: "var(--critical)", marginLeft: 3 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

// Wspólny blok pól płatności (per lot lub per kontener nieskonsolidowany).
type PayVals = {
  zaliczka_procent: string; zaliczka_kwota: string; zaliczka_waluta: string; zaliczka_data: string;
  balance_kwota: string; balance_waluta: string; zaplacono_data: string;
};
const CUR_OPTS = [["USD", "USD $"], ["CNY", "CNY ¥"], ["PLN", "PLN zł"]] as const;
function PaymentInputs({ v, onChange, disabled }: { v: PayVals; onChange: (field: keyof PayVals, value: string) => void; disabled?: boolean }) {
  const mini: React.CSSProperties = { ...inputStyle, padding: "6px 8px", fontSize: 12 };
  const monoMini: React.CSSProperties = { ...mini, fontFamily: "var(--font-mono)", textAlign: "right" };
  const curSel: React.CSSProperties = { ...mini, padding: "6px 6px" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Zaliczka: % · kwota · waluta · data */}
      <div style={{ display: "grid", gridTemplateColumns: "70px minmax(0, 1fr) 88px minmax(0, 1fr)", gap: 6 }}>
        <Field label="Zaliczka %">
          <input type="number" step="1" min="0" value={v.zaliczka_procent} onChange={(e) => onChange("zaliczka_procent", e.target.value)} placeholder="30" disabled={disabled} style={monoMini} />
        </Field>
        <Field label="Zaliczka kwota">
          <input type="number" step="0.01" min="0" value={v.zaliczka_kwota} onChange={(e) => onChange("zaliczka_kwota", e.target.value)} placeholder="np. 4200" disabled={disabled} style={monoMini} />
        </Field>
        <Field label="Waluta">
          <select value={v.zaliczka_waluta} onChange={(e) => onChange("zaliczka_waluta", e.target.value)} disabled={disabled} style={curSel}>
            {CUR_OPTS.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
          </select>
        </Field>
        <Field label="Zaliczka — data">
          <input type="date" value={v.zaliczka_data} onChange={(e) => onChange("zaliczka_data", e.target.value)} disabled={disabled} style={mini} />
        </Field>
      </div>
      {/* Balance: kwota · waluta · data */}
      <div style={{ display: "grid", gridTemplateColumns: "70px minmax(0, 1fr) 88px minmax(0, 1fr)", gap: 6 }}>
        <div />
        <Field label="Balance">
          <input type="number" step="0.01" min="0" value={v.balance_kwota} onChange={(e) => onChange("balance_kwota", e.target.value)} placeholder="np. 32000" disabled={disabled} style={monoMini} />
        </Field>
        <Field label="Waluta">
          <select value={v.balance_waluta} onChange={(e) => onChange("balance_waluta", e.target.value)} disabled={disabled} style={curSel}>
            {CUR_OPTS.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
          </select>
        </Field>
        <Field label="Zapłacono — data">
          <input type="date" value={v.zaplacono_data} onChange={(e) => onChange("zaplacono_data", e.target.value)} disabled={disabled} style={mini} />
        </Field>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text-hi)", outline: "none", fontFamily: "inherit",
};
const iconBtnHeader: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, background: "transparent", border: "1px solid var(--border-soft)", borderRadius: 7, color: "var(--text-mid)",
};
const btnGhost: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", background: "transparent", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 7, fontSize: 12, fontWeight: 500,
};
const btnGhostMini: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "transparent", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 5, fontSize: 11, fontWeight: 500,
};
