"use client";
// ============================================================
// MAGAZYN — Formularz kontenera (etap 3b). Port container-form.jsx.
//   Create (POST /containers) / edit (PATCH /containers/{id}, z items),
//   usuwanie (DELETE), załączniki (POST .../attachments, DELETE /attachments/{id})
//   z reconcyliacją przy zapisie. Podgląd wypełnienia z CBM produktów.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { I } from "./ui";
import { modalBackdrop, modalCard, btnPrimary, btnSecondary, Portal, type Product, type Manufacturer } from "./products-ui";
import { STATUS_FLOW, STATUS_FULL_META, type Container, type Attachment } from "./containers-ui";
import { api, download } from "@/lib/api";
import { toast } from "./toast";
import { canEdit, useUser } from "@/lib/permissions";
import { fmtPLN, fmtNum } from "@/lib/format";

export type ContainerType = { id: number; name: string; capacity_cbm: number; sort_order?: number };

type ItemDraft = { sku: string; quantity: string; unit_cost: string };
type AttDraft = Attachment & { _isNew?: boolean; _file?: File };

const today = () => new Date().toISOString().slice(0, 10);
const plus90 = () => { const d = new Date(); d.setDate(d.getDate() + 90); return d.toISOString().slice(0, 10); };

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
  const isNew = !initial;

  const [containerNumber, setContainerNumber] = useState(initial?.container_number || "");
  const [orderNumber, setOrderNumber] = useState(initial?.order_number || "");
  const [containerTypeId, setContainerTypeId] = useState<string>(initial?.container_type_id ? String(initial.container_type_id) : "");
  const [manufacturerId, setManufacturerId] = useState<string>(initial?.manufacturer_id ? String(initial.manufacturer_id) : "");
  const [orderDate, setOrderDate] = useState(initial?.order_date || today());
  const [etaDate, setEtaDate] = useState(initial?.eta_date || plus90());
  const [status, setStatus] = useState(initial?.status || "ORDERED");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [items, setItems] = useState<ItemDraft[]>(
    initial?.items?.map((i) => ({ sku: i.sku, quantity: String(i.quantity), unit_cost: i.unit_cost ? String(i.unit_cost) : "" })) || [{ sku: "", quantity: "", unit_cost: "" }],
  );
  const [attachments, setAttachments] = useState<AttDraft[]>(initial?.attachments || []);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

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
    if (!manufacturerId) return products;
    const mfrId = Number(manufacturerId);
    return [...products].sort((a, b) => {
      const am = a.manufacturer_id === mfrId ? 0 : 1;
      const bm = b.manufacturer_id === mfrId ? 0 : 1;
      return am - bm || a.sku.localeCompare(b.sku);
    });
  }, [manufacturerId, products]);

  const itemDetails = items.map((item) => {
    const product = productBySku.get(item.sku);
    const qty = parseInt(item.quantity, 10) || 0;
    return {
      ...item, product, qty,
      cbm: (product?.cbm_per_unit || 0) * qty,
      value: (parseFloat(item.unit_cost) || 0) * qty,
      isMixed: !!(manufacturerId && product?.manufacturer_id && product.manufacturer_id !== Number(manufacturerId)),
    };
  });

  const totalCbm = itemDetails.reduce((s, i) => s + i.cbm, 0);
  const totalUnits = itemDetails.reduce((s, i) => s + i.qty, 0);
  const totalValue = itemDetails.reduce((s, i) => s + i.value, 0);
  const fillPct = capacity > 0 ? (totalCbm / capacity) * 100 : 0;
  const fillColor = fillPct > 100 ? "var(--critical)" : fillPct > 90 ? "var(--warning)" : fillPct > 70 ? "var(--ok)" : "var(--info)";

  const addItem = () => setItems([...items, { sku: "", quantity: "", unit_cost: "" }]);
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

    const payload = {
      container_number: containerNumber.trim(),
      order_number: orderNumber.trim() || null,
      container_type_id: containerTypeId ? Number(containerTypeId) : null,
      manufacturer_id: manufacturerId ? Number(manufacturerId) : null,
      order_date: orderDate,
      eta_date: etaDate,
      status,
      notes: notes.trim() || null,
      items: validItems.map((i) => ({ sku: i.sku, quantity: parseInt(i.quantity, 10), unit_cost: i.unit_cost ? parseFloat(i.unit_cost) : null })),
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <Field label="Nr kontenera" required>
                  <input value={containerNumber} onChange={(e) => setContainerNumber(e.target.value.toUpperCase())} placeholder="np. MSCU-7821934" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                </Field>
                <Field label="Nr zamówienia (PO)">
                  <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="np. PO-2026-001" disabled={!showEdit} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                </Field>
                <Field label="Typ kontenera">
                  <select value={containerTypeId} onChange={(e) => setContainerTypeId(e.target.value)} disabled={!showEdit} style={inputStyle}>
                    <option value="">— wybierz —</option>
                    {containerTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.capacity_cbm} m³)</option>)}
                  </select>
                </Field>
                <Field label="Producent (dostawca)">
                  <select value={manufacturerId} onChange={(e) => setManufacturerId(e.target.value)} disabled={!showEdit} style={inputStyle}>
                    <option value="">— wybierz —</option>
                    {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </Field>
                <Field label="Data zamówienia" required>
                  <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!showEdit} style={inputStyle} />
                </Field>
                <Field label="ETA (planowana dostawa)" required>
                  <input type="date" value={etaDate} onChange={(e) => setEtaDate(e.target.value)} disabled={!showEdit} style={inputStyle} />
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

            <Section title={`Produkty (${items.length})`} required action={showEdit ? <button onClick={addItem} style={btnGhostMini}><I.Plus size={11} /> Dodaj pozycję</button> : undefined}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {itemDetails.map((item, idx) => (
                  <ItemRow key={idx} item={item} sortedProducts={sortedProducts} manufacturers={manufacturers} manufacturerId={manufacturerId} disabled={!showEdit}
                    onChange={(field, val) => updateItem(idx, field, val)} onRemove={() => removeItem(idx)} />
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                <I.Wand size={11} style={{ color: "var(--accent)" }} /> Cena auto-wypełnia się z bazy produktów. Można nadpisać.
              </div>
            </Section>

            {capacity > 0 && (
              <div style={{ padding: 14, background: "var(--surface-2)", border: `1px solid ${fillPct > 100 ? "var(--critical)" : "var(--border-soft)"}`, borderRadius: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Wypełnienie {containerType?.name}</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                    <span className="num" style={{ fontSize: 13, color: "var(--text-lo)" }}>{totalUnits} szt · {fmtPLN(totalValue)}</span>
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
  item, sortedProducts, manufacturers, manufacturerId, disabled, onChange, onRemove,
}: {
  item: { sku: string; quantity: string; unit_cost: string; product?: Product; qty: number; cbm: number; value: number; isMixed: boolean };
  sortedProducts: Product[]; manufacturers: Manufacturer[]; manufacturerId: string; disabled: boolean;
  onChange: (field: "sku" | "quantity" | "unit_cost", val: string) => void; onRemove: () => void;
}) {
  const mixedMfrName = item.product?.manufacturer_id ? manufacturers.find((m) => m.id === item.product!.manufacturer_id)?.name : undefined;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 80px 90px 30px", gap: 6, alignItems: "flex-start", padding: 8, background: item.isMixed ? "color-mix(in oklch, var(--warning) 8%, var(--surface-2))" : "var(--surface-2)", border: `1px solid ${item.isMixed ? "color-mix(in oklch, var(--warning) 40%, var(--border))" : "var(--border-soft)"}`, borderRadius: 8 }}>
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
        {item.product && (
          item.isMixed ? (
            <div style={{ fontSize: 10, color: "var(--warning)", fontWeight: 600, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
              <I.Alert size={10} /> Inny dostawca niż kontener{mixedMfrName ? ` (${mixedMfrName})` : ""}
            </div>
          ) : (
            <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
              Dostawca: <span style={{ color: "var(--text-mid)" }}>{item.product.manufacturer_name || "— brak —"}</span>
            </div>
          )
        )}
        {item.qty > 0 && item.cbm > 0 && (
          <div className="num" style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 4 }}>
            Zajmie: <strong style={{ color: "var(--text-mid)" }}>{item.cbm.toFixed(3)} m³</strong>{item.value > 0 && <span> · {fmtPLN(item.value)}</span>}
          </div>
        )}
      </div>
      <input type="number" value={item.quantity} onChange={(e) => onChange("quantity", e.target.value)} placeholder="szt" min="1" disabled={disabled} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, fontFamily: "var(--font-mono)", textAlign: "right" }} />
      <input type="number" value={item.unit_cost} onChange={(e) => onChange("unit_cost", e.target.value)} placeholder="cena" step="0.01" disabled={disabled} title={item.product ? `Z bazy: ${item.product.purchase_price} zł` : ""} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, fontFamily: "var(--font-mono)", textAlign: "right" }} />
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

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
        {label}{required && <span style={{ color: "var(--critical)", marginLeft: 3 }}>*</span>}
      </label>
      {children}
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
