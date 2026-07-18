"use client";
// ============================================================
// MAGAZYN — Generator zamówienia (PO), wersje PL + EN.
// Źródło: kontener. Wersja EN podmienia SKU na kod fabryczny (CN-SKU)
// pobierany z listy /cn-sku (Ustawienia › Chińskie SKU).
// Kontenery skonsolidowane: PO generuje się per dostawca (wybór lotu).
// ============================================================
import React, { useEffect, useMemo, useState } from "react";
import { I } from "./ui";
import { Portal, Checkbox, modalBackdrop, modalCard, btnPrimary, btnSecondary, type Manufacturer } from "./products-ui";
import type { Container, ContainerItem } from "./containers-ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { fmtPLN, fmtNum } from "@/lib/format";

type Lang = "pl" | "en";

const PO_I18N = {
  pl: {
    poNumber: "Numer PO", supplierEmail: "Email producenta", orderDate: "Data zamówienia",
    deliveryDate: "Termin dostawy (opcjonalnie)", items: "Pozycje zamówienia",
    hint: "Możesz odznaczyć pozycje, edytować ilości i ceny przed wygenerowaniem PDF.",
    notes: "Uwagi (opcjonalnie)", notesPlaceholder: "np. Termin dostawy do końca marca, paleta EUR, opakowanie zbiorcze...",
    statPositions: "Pozycji", statUnits: "Sztuk", statValue: "Wartość",
    cancel: "Anuluj", copyEmail: "Kopiuj treść maila", generate: "Wygeneruj PDF", generating: "Generuję...",
    docTitle: "Zamówienie", pdfHeader: "ZAMÓWIENIE", pdfDate: "Data", pdfSupplier: "Dostawca", pdfSummary: "Podsumowanie",
    pdfPositions: "pozycji", pdfUnits: "szt", pdfDelivery: "Termin dostawy",
    colNum: "#", colSku: "SKU", colName: "Nazwa produktu", colQty: "Ilość", colPrice: "Cena jedn.", colTotal: "Wartość",
    rowTotal: "RAZEM", notesLabel: "Uwagi", sigBuyer: "Zamawiający", sigSupplier: "Dostawca / Akceptacja",
    generated: "Wygenerowano", printBtn: "Zapisz jako PDF / Drukuj",
    emailGreeting: "Witam,", emailIntro: (po: string) => `Proszę o realizację następującego zamówienia (${po}):`,
    emailTotal: (v: string) => `Łączna wartość: ${v}`, emailNotes: (n: string) => `Uwagi: ${n}`, emailRegards: "Pozdrawiam",
    copyOk: "Treść zamówienia skopiowana do schowka. Wklej do maila.", copyFail: "Nie udało się skopiować — schowek niedostępny.",
    selectAtLeastOne: "Zaznacz co najmniej jeden produkt", enablePopup: "Włącz pop-upy dla tej strony, żeby wygenerować PDF.",
    supplier: "Dostawca", missingCn: (n: number) => `${n} ${n === 1 ? "pozycja" : "pozycji"} bez CN-SKU — użyto Twojego SKU. Uzupełnij w Ustawieniach › Chińskie SKU.`,
  },
  en: {
    poNumber: "PO Number", supplierEmail: "Supplier email", orderDate: "Order date",
    deliveryDate: "Delivery date (optional)", items: "Order items",
    hint: "Uncheck items, edit quantities and prices before generating PDF.",
    notes: "Notes (optional)", notesPlaceholder: "e.g. Delivery by end of March, EUR pallet, master carton...",
    statPositions: "Items", statUnits: "Units", statValue: "Total",
    cancel: "Cancel", copyEmail: "Copy email draft", generate: "Generate PDF", generating: "Generating...",
    docTitle: "Purchase Order", pdfHeader: "PURCHASE ORDER", pdfDate: "Date", pdfSupplier: "Supplier", pdfSummary: "Summary",
    pdfPositions: "items", pdfUnits: "pcs", pdfDelivery: "Delivery date",
    colNum: "#", colSku: "SKU", colName: "Product name", colQty: "Qty", colPrice: "Unit price", colTotal: "Amount",
    rowTotal: "TOTAL", notesLabel: "Notes", sigBuyer: "Buyer", sigSupplier: "Supplier / Acceptance",
    generated: "Generated", printBtn: "Save as PDF / Print",
    emailGreeting: "Dear Sir/Madam,", emailIntro: (po: string) => `Please process the following purchase order (${po}):`,
    emailTotal: (v: string) => `Total value: ${v}`, emailNotes: (n: string) => `Notes: ${n}`, emailRegards: "Best regards",
    copyOk: "Email content copied to clipboard. Paste it into your email.", copyFail: "Could not copy — clipboard not available.",
    selectAtLeastOne: "Select at least one product", enablePopup: "Enable pop-ups for this site to generate the PDF.",
    supplier: "Supplier", missingCn: (n: number) => `${n} item(s) without CN-SKU — your own SKU was used. Fill them in Settings › Chinese SKU.`,
  },
} as const;

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", background: "var(--surface-2)",
  border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-hi)",
  fontSize: 13, outline: "none",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}

const norm = (s: string) => s.trim().toLowerCase();
const todayISO = () => new Date().toISOString().slice(0, 10);

type PoGroup = { key: string; mfrId: number | null; mfrName: string; mfrColor: string; orderNumber: string; items: ContainerItem[] };
type PoRow = { sku: string; cn_sku: string; name: string; en_name: string; quantity: number; unit_cost: number; selected: boolean; hasCn: boolean };

// Grupowanie kontenera na PO per dostawca. Nieskonsolidowany → jedna grupa.
function buildGroups(c: Container, mfrs: Manufacturer[]): PoGroup[] {
  const findMfr = (id: number | null) => (id != null ? mfrs.find(m => m.id === id) : undefined);
  const poDefault = (suffix: string | number) =>
    `PO-${todayISO().replace(/-/g, "")}-${suffix}`;

  if (c.is_consolidated && c.lots && c.lots.length > 0) {
    return c.lots.map((lot, i) => {
      const m = findMfr(lot.manufacturer_id);
      return {
        key: `lot-${lot.id}`,
        mfrId: lot.manufacturer_id,
        mfrName: lot.manufacturer_name || m?.name || "— brak dostawcy —",
        mfrColor: lot.manufacturer_color || m?.color || "var(--accent)",
        orderNumber: lot.order_number || poDefault(`${c.id}-${i + 1}`),
        items: c.items.filter(it => it.lot_id === lot.id),
      };
    });
  }
  const m = findMfr(c.manufacturer_id);
  return [{
    key: "main",
    mfrId: c.manufacturer_id,
    mfrName: c.manufacturer_name || m?.name || "— brak dostawcy —",
    mfrColor: c.manufacturer_color || m?.color || "var(--accent)",
    orderNumber: c.order_number || poDefault(c.id),
    items: c.items,
  }];
}

export default function OrderPdfModal({ container, manufacturers, onClose }: {
  container: Container; manufacturers: Manufacturer[]; onClose: () => void;
}) {
  const [lang, setLang] = useState<Lang>("pl");
  const T = PO_I18N[lang];

  const groups = useMemo(() => buildGroups(container, manufacturers), [container, manufacturers]);
  const [groupIdx, setGroupIdx] = useState(0);
  const group = groups[Math.min(groupIdx, groups.length - 1)] || groups[0];

  const mfrEmail = group.mfrId != null ? (manufacturers.find(m => m.id === group.mfrId)?.email || "") : "";

  const [cnMap, setCnMap] = useState<Record<string, { cn: string; en: string }>>({});
  const [rows, setRows] = useState<PoRow[]>([]);
  const [orderNumber, setOrderNumber] = useState(group.orderNumber);
  const [orderDate, setOrderDate] = useState(todayISO());
  const [deliveryDate, setDeliveryDate] = useState("");
  const [notes, setNotes] = useState(container.notes || "");
  const [generating, setGenerating] = useState(false);

  // Mapa SKU → { CN-SKU, nazwa EN } z listy w Ustawieniach (raz przy otwarciu).
  useEffect(() => {
    (async () => {
      try {
        const data = await api.get("/cn-sku");
        const map: Record<string, { cn: string; en: string }> = {};
        if (Array.isArray(data)) for (const r of data as { sku: string; cn_sku: string; en_name?: string | null }[]) {
          map[norm(r.sku)] = { cn: r.cn_sku, en: r.en_name || "" };
        }
        setCnMap(map);
      } catch { /* brak dostępu / brak danych — EN użyje SKU + polskiej nazwy jako fallback */ }
    })();
  }, []);

  // Przy zmianie dostawcy (lotu) przeładuj pozycje + domyślny numer PO.
  useEffect(() => {
    setOrderNumber(group.orderNumber);
    setRows(group.items.map(it => {
      const info = cnMap[norm(it.sku)];
      const plName = it.product_name || it.sku;
      return {
        sku: it.sku,
        cn_sku: info?.cn || it.sku,
        hasCn: !!info?.cn,
        name: plName,
        en_name: info?.en || "",   // EN: pusto gdy brak angielskiej nazwy (bez fallbacku na PL)
        quantity: it.quantity || 0,
        unit_cost: it.unit_cost != null ? it.unit_cost : 0,
        selected: true,
      };
    }));
  }, [group.key, cnMap]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const update = (idx: number, field: "quantity" | "unit_cost", value: string) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: parseFloat(value) || 0 } : r));
  };
  const toggle = (idx: number) => setRows(prev => prev.map((r, i) => i === idx ? { ...r, selected: !r.selected } : r));
  const removeRow = (idx: number) => setRows(prev => prev.filter((_, i) => i !== idx));

  const selected = rows.filter(r => r.selected && r.quantity > 0);
  const totalUnits = selected.reduce((s, r) => s + r.quantity, 0);
  const totalValue = selected.reduce((s, r) => s + r.quantity * r.unit_cost, 0);
  const missingCn = lang === "en" ? selected.filter(r => !r.hasCn).length : 0;
  const showPrices = lang === "pl";   // wersja EN dla fabryki: bez cen (tylko SKU + nazwa + ilość)

  const generatePdf = () => {
    if (selected.length === 0) { toast(T.selectAtLeastOne, "warning"); return; }
    setGenerating(true);
    const printWindow = window.open("", "_blank", "width=900,height=1200");
    if (!printWindow) { toast(T.enablePopup, "warning"); setGenerating(false); return; }
    const dateLocale = lang === "pl" ? "pl-PL" : "en-US";
    const html = printDocHtml({
      lang, T, accent: group.mfrColor, showPrices,
      orderNumber,
      today: (orderDate ? new Date(orderDate) : new Date()).toLocaleDateString(dateLocale),
      deliveryDate: deliveryDate ? new Date(deliveryDate).toLocaleDateString(dateLocale) : "",
      mfrName: group.mfrName, mfrEmail,
      containerNumber: container.container_number,
      items: selected, totalUnits, totalValue, notes,
    });
    printWindow.document.write(html);
    printWindow.document.close();
    setGenerating(false);
  };

  const copyEmailDraft = () => {
    if (selected.length === 0) { toast(T.selectAtLeastOne, "warning"); return; }
    const lines = [
      T.emailGreeting, "",
      T.emailIntro(orderNumber), "",
      ...selected.map((r, idx) => {
        const sku = lang === "pl" ? r.sku : r.cn_sku;
        const name = lang === "pl" ? r.name : r.en_name;
        const namePart = name ? ` — ${name}` : "";
        return `${idx + 1}. ${sku}${namePart} — ${lang === "pl" ? "ilość" : "qty"}: ${r.quantity} ${T.pdfUnits}`;
      }),
      "",
      ...(showPrices ? [T.emailTotal(fmtPLN(totalValue)), ""] : []),
      ...(notes ? [T.emailNotes(notes), ""] : []),
      T.emailRegards,
    ];
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(lines.join("\n")).then(() => toast(T.copyOk, "ok")).catch(() => toast(T.copyFail, "error"));
    } else { toast(T.copyFail, "error"); }
  };

  const langOpts: { code: Lang; flag: string; label: string; sub: string }[] = [
    { code: "pl", flag: "🇵🇱", label: "PL", sub: "polskie SKU" },
    { code: "en", flag: "🇬🇧", label: "EN", sub: "chińskie SKU" },
  ];

  return (
    <Portal>
      <div onClick={onClose} style={modalBackdrop}>
        <div onClick={(e) => e.stopPropagation()} className="fade-in" style={{ ...modalCard, maxWidth: 860 }}>

          {/* Header */}
          <div style={{ padding: "14px 22px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, position: "relative", flexWrap: "wrap" }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: group.mfrColor }}/>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: `color-mix(in oklch, ${group.mfrColor} 18%, var(--surface-2))`, color: group.mfrColor, display: "flex", alignItems: "center", justifyContent: "center" }}><I.External size={16}/></div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-hi)" }}>{lang === "pl" ? "Generator zamówienia (PO)" : "Purchase Order Generator"}</div>
                <div style={{ fontSize: 11, color: "var(--text-lo)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: group.mfrColor }}/>{group.mfrName}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><I.Ship size={11}/><span className="mono">{container.container_number}</span></span>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 4, background: "var(--surface-2)", padding: 3, borderRadius: 8 }}>
              {langOpts.map(o => (
                <button key={o.code} onClick={() => setLang(o.code)} title={o.sub} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", background: lang === o.code ? "var(--surface-3)" : "transparent", color: lang === o.code ? "var(--text-hi)" : "var(--text-mid)", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                  <span style={{ fontSize: 13 }}>{o.flag}</span>{o.label}
                </button>
              ))}
            </div>

            <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-lo)", cursor: "pointer", padding: 4, display: "flex" }}><I.Close size={16}/></button>
          </div>

          {/* Banner */}
          <div style={{ padding: "8px 22px", background: lang === "en" ? "var(--info-soft)" : "var(--accent-soft)", borderBottom: "1px solid var(--border-soft)", fontSize: 11, color: lang === "en" ? "var(--info)" : "var(--accent)", fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
            {lang === "en" ? "🇬🇧 EN — kody fabryczne (CN-SKU), gotowe do wysłania do dostawcy w Chinach" : "🇵🇱 Wersja polska — Twoje SKU; kopia wewnętrzna / archiwum"}
          </div>

          {/* Body */}
          <div style={{ overflowY: "auto", padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Supplier selector (only consolidated / >1 group) */}
            {groups.length > 1 && (
              <Field label={T.supplier}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {groups.map((g, i) => (
                    <button key={g.key} onClick={() => setGroupIdx(i)} style={{
                      display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                      background: i === groupIdx ? `color-mix(in oklch, ${g.mfrColor} 14%, var(--surface-2))` : "var(--surface-2)",
                      color: i === groupIdx ? "var(--text-hi)" : "var(--text-mid)",
                      border: `1px solid ${i === groupIdx ? `color-mix(in oklch, ${g.mfrColor} 45%, var(--border))` : "var(--border)"}`,
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: g.mfrColor }}/>{g.mfrName}
                      <span className="num" style={{ color: "var(--text-lo)" }}>· {g.items.length}</span>
                    </button>
                  ))}
                </div>
              </Field>
            )}

            {/* Top fields */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <Field label={T.poNumber}>
                <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}/>
              </Field>
              <Field label={T.supplierEmail}>
                <input value={mfrEmail} disabled placeholder={lang === "pl" ? "— nie ustawiono w producencie —" : "— not set on supplier —"} style={{ ...inputStyle, background: "var(--surface-1)", color: "var(--text-lo)", cursor: "not-allowed", fontFamily: "var(--font-mono)" }}/>
              </Field>
              <Field label={T.orderDate}>
                <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} style={inputStyle}/>
              </Field>
              <Field label={T.deliveryDate}>
                <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} style={inputStyle}/>
              </Field>
            </div>

            {/* Missing CN-SKU warning (EN) */}
            {missingCn > 0 && (
              <div style={{ padding: "8px 12px", background: "var(--warning-soft, var(--accent-soft))", border: "1px solid color-mix(in oklch, var(--warning, var(--accent)) 40%, var(--border))", borderRadius: 8, fontSize: 11.5, color: "var(--warning, var(--accent))", display: "flex", alignItems: "center", gap: 6 }}>
                <I.Alert size={13}/> {T.missingCn(missingCn)}
              </div>
            )}

            {/* Items table */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{T.items}</span>
                <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>
                  <span style={{ color: "var(--text-hi)", fontWeight: 600 }}>{selected.length}</span> / {rows.length}
                </span>
              </div>
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, overflow: "hidden", maxHeight: 340, overflowY: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: showPrices ? "28px 124px minmax(0, 1fr) 70px 90px 90px 28px" : "28px 124px minmax(0, 1fr) 70px 28px", gap: 8, padding: "8px 10px", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)" }}>
                  <span/><span>{T.colSku}</span><span>{T.colName}</span>
                  <span style={{ textAlign: "right" }}>{T.colQty}</span>
                  {showPrices && <span style={{ textAlign: "right" }}>{T.colPrice}</span>}
                  {showPrices && <span style={{ textAlign: "right" }}>{T.colTotal}</span>}<span/>
                </div>
                {rows.map((r, idx) => (
                  <PoItemRow key={idx} row={r} lang={lang} showPrices={showPrices}
                    onToggle={() => toggle(idx)} onUpdate={(f, v) => update(idx, f, v)} onRemove={() => removeRow(idx)}/>
                ))}
                {rows.length === 0 && (
                  <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--text-lo)" }}>Brak pozycji dla tego dostawcy.</div>
                )}
              </div>
              <p style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 6, display: "flex", alignItems: "center", gap: 5 }}>
                <I.Wand size={11} style={{ color: "var(--accent)" }}/> {T.hint}
              </p>
            </div>

            {/* Notes */}
            <Field label={T.notes}>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={T.notesPlaceholder} style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}/>
            </Field>

            {/* Summary */}
            <div style={{ padding: 14, background: `color-mix(in oklch, ${group.mfrColor} 8%, var(--surface-1))`, border: `1px solid color-mix(in oklch, ${group.mfrColor} 35%, var(--border))`, borderRadius: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: showPrices ? "repeat(3, 1fr)" : "repeat(2, 1fr)", gap: 12 }}>
                <SummaryStat label={T.statPositions} value={String(selected.length)}/>
                <SummaryStat label={T.statUnits} value={fmtNum(totalUnits)}/>
                {showPrices && <SummaryStat label={T.statValue} value={fmtPLN(totalValue)} accent/>}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "12px 22px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-elevated)", flexWrap: "wrap" }}>
            <button onClick={onClose} style={btnSecondary}>{T.cancel}</button>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={copyEmailDraft} disabled={selected.length === 0} style={{ ...btnSecondary, color: "var(--info)", borderColor: "color-mix(in oklch, var(--info) 40%, var(--border))", opacity: selected.length === 0 ? 0.5 : 1 }}>
                <I.External size={12}/> {T.copyEmail}
              </button>
              <button onClick={generatePdf} disabled={selected.length === 0 || generating} style={{ ...btnPrimary, opacity: (selected.length === 0 || generating) ? 0.5 : 1, cursor: (selected.length === 0 || generating) ? "not-allowed" : "pointer" }}>
                {generating ? <><span className="pulse-soft"><I.Refresh size={12}/></span> {T.generating}</> : <><I.ArrowUp size={12}/> {T.generate} ({lang.toUpperCase()})</>}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function PoItemRow({ row, lang, showPrices, onToggle, onUpdate, onRemove }: {
  row: PoRow; lang: Lang; showPrices: boolean; onToggle: () => void; onUpdate: (f: "quantity" | "unit_cost", v: string) => void; onRemove: () => void;
}) {
  const sku = lang === "pl" ? row.sku : row.cn_sku;
  const name = lang === "pl" ? row.name : row.en_name;
  const cell: React.CSSProperties = { ...inputStyle, padding: "5px 7px", fontSize: 12, fontFamily: "var(--font-mono)", textAlign: "right" };
  return (
    <div style={{ display: "grid", gridTemplateColumns: showPrices ? "28px 124px minmax(0, 1fr) 70px 90px 90px 28px" : "28px 124px minmax(0, 1fr) 70px 28px", gap: 8, alignItems: "center", padding: "8px 10px", background: row.selected ? "var(--surface-1)" : "var(--surface-2)", opacity: row.selected ? 1 : 0.5, borderBottom: "1px solid var(--border-soft)" }}>
      <Checkbox checked={row.selected} onChange={onToggle}/>
      <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: lang === "en" && !row.hasCn ? "var(--warning, var(--accent))" : "var(--text-hi)", overflow: "hidden", textOverflow: "ellipsis" }} title={lang === "en" && !row.hasCn ? "Brak CN-SKU — użyto Twojego SKU" : undefined}>{sku}</span>
      <span style={{ fontSize: 12, color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      <input type="number" value={row.quantity} onChange={(e) => onUpdate("quantity", e.target.value)} min="0" style={cell}/>
      {showPrices && <input type="number" value={row.unit_cost} onChange={(e) => onUpdate("unit_cost", e.target.value)} step="0.01" min="0" style={cell}/>}
      {showPrices && (
        <span className="num" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)", textAlign: "right" }}>
          {fmtPLN(row.quantity * row.unit_cost)}
        </span>
      )}
      <button onClick={onRemove} style={{ background: "transparent", border: "none", color: "var(--critical)", padding: 4, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><I.Close size={12}/></button>
    </div>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>{label}</div>
      <div className="num" style={{ fontSize: 20, fontWeight: 600, color: accent ? "var(--accent)" : "var(--text-hi)", marginTop: 3, letterSpacing: "-0.02em" }}>{value}</div>
    </div>
  );
}

// --- Drukowalny PDF (jasny motyw, obie wersje) ---------------
function printDocHtml({ lang, T, accent, showPrices, orderNumber, today, deliveryDate, mfrName, mfrEmail, containerNumber, items, totalUnits, totalValue, notes }: {
  lang: Lang; T: typeof PO_I18N[Lang]; accent: string; showPrices: boolean; orderNumber: string; today: string; deliveryDate: string;
  mfrName: string; mfrEmail: string; containerNumber: string; items: PoRow[]; totalUnits: number; totalValue: number; notes: string;
}) {
  const fmtMoney = (n: number) => new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2 }).format(n) + " zł";
  const fmtCurrency = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", minimumFractionDigits: 2 }).format(n);

  const itemsHtml = items.map((item, i) => {
    const sku = lang === "pl" ? item.sku : item.cn_sku;
    const name = lang === "pl" ? item.name : item.en_name;
    return `
      <tr>
        <td>${i + 1}</td>
        <td class="mono">${escapeHtml(sku)}</td>
        <td>${escapeHtml(name)}</td>
        <td class="right">${item.quantity}</td>
        ${showPrices ? `<td class="right">${fmtMoney(item.unit_cost)}</td><td class="right"><strong>${fmtMoney(item.quantity * item.unit_cost)}</strong></td>` : ""}
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(T.docTitle)} ${escapeHtml(orderNumber)}</title>
<style>
  *,*:before,*:after { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1c1917; line-height: 1.5; background: #fff; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 4px solid ${accent}; padding-bottom: 20px; margin-bottom: 30px; }
  .logo { font-size: 28px; font-weight: 800; letter-spacing: 0.04em; }
  .logo .accent { color: ${accent}; }
  .sub { font-size: 11px; color: #78716c; margin-top: 5px; }
  .order-info { text-align: right; }
  .order-info h1 { font-size: 22px; }
  .order-info .num { font-family: ui-monospace, 'JetBrains Mono', monospace; font-size: 18px; color: ${accent}; font-weight: bold; margin-top: 4px; }
  .badge-lang { display: inline-block; padding: 2px 8px; background: ${accent}; color: #fff; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; border-radius: 99px; margin-bottom: 6px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 26px; }
  .info-block { background: #fafaf9; border-left: 4px solid ${accent}; padding: 14px 16px; }
  .info-block h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #78716c; margin-bottom: 6px; font-weight: 700; }
  .info-block .name { font-size: 17px; font-weight: 700; }
  .info-block .detail { font-size: 13px; color: #57534e; margin-top: 4px; }
  .info-block .container { font-family: ui-monospace, monospace; font-size: 12px; color: #1c1917; margin-top: 6px; padding: 4px 8px; background: #fff; border: 1px solid #e7e5e4; border-radius: 4px; display: inline-block; }
  .totals-big { font-size: 18px; color: ${accent}; font-weight: 800; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { background: #1c1917; color: #fff; padding: 10px 8px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
  th.right { text-align: right; }
  td { padding: 10px 8px; border-bottom: 1px solid #e7e5e4; font-size: 13px; vertical-align: top; }
  td.right { text-align: right; font-variant-numeric: tabular-nums; }
  td.mono { font-family: ui-monospace, 'JetBrains Mono', monospace; font-weight: 700; }
  .total-row td { border-top: 2px solid #1c1917; padding: 12px 8px; font-size: 14px; background: #fef3c7; font-weight: 700; }
  .notes { background: #fafaf9; padding: 14px 16px; border-left: 4px solid #78716c; margin-top: 18px; }
  .notes h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #78716c; margin-bottom: 6px; font-weight: 700; }
  .signature { margin-top: 50px; display: grid; grid-template-columns: 1fr 1fr; gap: 80px; }
  .sig-line { border-top: 1px solid #1c1917; padding-top: 6px; font-size: 11px; text-align: center; color: #78716c; }
  .footer { margin-top: 36px; padding-top: 18px; border-top: 2px solid #e7e5e4; display: flex; justify-content: space-between; font-size: 11px; color: #78716c; }
  .print-btn { position: fixed; top: 20px; right: 20px; background: ${accent}; color: #1c1917; padding: 12px 22px; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.18); }
  @media print { body { padding: 22px; } .no-print { display: none; } }
</style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">${escapeHtml(T.printBtn)}</button>
  <div class="header">
    <div>
      <div class="logo">MAGAZYN<span class="accent">.</span></div>
      <div class="sub">${lang === "pl" ? "System zarządzania magazynem" : "Warehouse Management System"}</div>
    </div>
    <div class="order-info">
      <div class="badge-lang">${lang === "pl" ? "PL" : "EN"}</div>
      <h1>${escapeHtml(T.pdfHeader)}</h1>
      <div class="num">${escapeHtml(orderNumber)}</div>
      <div class="sub">${escapeHtml(T.pdfDate)}: ${escapeHtml(today)}</div>
    </div>
  </div>
  <div class="info-grid">
    <div class="info-block">
      <h3>${escapeHtml(T.pdfSupplier)}</h3>
      <div class="name">${escapeHtml(mfrName)}</div>
      ${mfrEmail ? `<div class="detail">${escapeHtml(mfrEmail)}</div>` : ""}
      ${containerNumber ? `<div class="container">${lang === "pl" ? "Kontener" : "Container"}: ${escapeHtml(containerNumber)}</div>` : ""}
    </div>
    <div class="info-block">
      <h3>${escapeHtml(T.pdfSummary)}</h3>
      <div class="name">${items.length} ${escapeHtml(T.pdfPositions)} · ${totalUnits} ${escapeHtml(T.pdfUnits)}</div>
      ${showPrices ? `<div class="totals-big">${fmtCurrency(totalValue)}</div>` : ""}
      ${deliveryDate ? `<div class="detail">${escapeHtml(T.pdfDelivery)}: ${escapeHtml(deliveryDate)}</div>` : ""}
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:30px">${escapeHtml(T.colNum)}</th>
        <th style="width:130px">${escapeHtml(T.colSku)}</th>
        <th>${escapeHtml(T.colName)}</th>
        <th class="right" style="width:70px">${escapeHtml(T.colQty)}</th>
        ${showPrices ? `<th class="right" style="width:110px">${escapeHtml(T.colPrice)}</th><th class="right" style="width:120px">${escapeHtml(T.colTotal)}</th>` : ""}
      </tr>
    </thead>
    <tbody>
      ${itemsHtml}
      ${showPrices
        ? `<tr class="total-row"><td colspan="3">${escapeHtml(T.rowTotal)}</td><td class="right">${totalUnits} ${escapeHtml(T.pdfUnits)}</td><td></td><td class="right">${fmtCurrency(totalValue)}</td></tr>`
        : `<tr class="total-row"><td colspan="3">${escapeHtml(T.rowTotal)}</td><td class="right">${totalUnits} ${escapeHtml(T.pdfUnits)}</td></tr>`}
    </tbody>
  </table>
  ${notes ? `<div class="notes"><h3>${escapeHtml(T.notesLabel)}</h3><div>${escapeHtml(notes).replace(/\n/g, "<br>")}</div></div>` : ""}
  <div class="signature">
    <div class="sig-line">${escapeHtml(T.sigBuyer)}</div>
    <div class="sig-line">${escapeHtml(T.sigSupplier)}</div>
  </div>
  <div class="footer">
    <span>${escapeHtml(T.generated)}: ${escapeHtml(today)}</span>
    <span>Magazyn</span>
  </div>
  <script>setTimeout(function(){ window.print(); }, 400);</script>
</body>
</html>`;
}

function escapeHtml(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
