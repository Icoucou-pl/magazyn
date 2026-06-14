"use client";
// ============================================================
// MAGAZYN — Import produktów (etap 2b). Port ImportModal z mocka.
//   Kreator 3-krokowy: wgraj/wklej CSV → podgląd → wynik.
//   Wpięty w POST /products/import (ImportRow[]: sku, cbm,
//   manufacturer_name, lead_time_days, seasonality_enabled).
//   Nieznane SKU są pomijane (produkty pochodzą z Subiekta).
//   Dry-run liczony po stronie frontu (bez zapisu).
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { I, Pill } from "./ui";
import { Checkbox, modalBackdrop, modalCard, Portal } from "./products-ui";
import { api } from "@/lib/api";
import { toast } from "./toast";

type ParsedRow = {
  _line: number;
  sku: string;
  cbm?: number;
  manufacturer_name?: string;
  lead_time_days?: number;
  seasonality_enabled?: boolean;
  _existing: boolean;
};
type DetectedColumns = Record<string, string | null>;
type ImportResult = { total: number; updated: number; skipped: number; errors: string[]; dryRun: boolean };

const EXAMPLE_CSV = `sku;cbm;manufacturer_name;lead_time_days;seasonality_enabled
FUR-7732-OAK;0.180;Tianjin Furniture;90;false
TRN-4521-BLK;0.018;Guangzhou Lights;75;false
CRM-2814-WHT;0.024;Foshan Ceramics;60;true`;

export default function ImportModal({
  onClose, existingSkus, onImported,
}: {
  onClose: () => void;
  existingSkus: Set<string>; // znormalizowane (trim+lowercase)
  onImported?: () => void;
}) {
  const [step, setStep] = useState(1);
  const [csvText, setCsvText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [detectedSep, setDetectedSep] = useState(";");
  const [detectedColumns, setDetectedColumns] = useState<DetectedColumns>({});
  const [options, setOptions] = useState({ dryRun: false });
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const handleFile = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => setCsvText(String(e.target?.result ?? ""));
    reader.readAsText(file);
  };

  const parse = () => {
    setParseError(null);
    try {
      const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) { setParseError("Plik musi mieć nagłówek + co najmniej 1 wiersz danych"); return; }
      const sep = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
      setDetectedSep(sep);
      const headers = lines[0].split(sep).map((h) => h.trim().toLowerCase());

      const skuIdx = headers.findIndex((h) => h === "sku" || h === "symbol");
      const cbmIdx = headers.findIndex((h) => h === "cbm" || h === "cbm_per_unit");
      const mfrIdx = headers.findIndex((h) => h.includes("manufacturer") || h === "producent");
      const ltIdx = headers.findIndex((h) => h.includes("lead") || h === "lead_time_days");
      const seasIdx = headers.findIndex((h) => h.includes("season"));

      setDetectedColumns({
        sku: skuIdx >= 0 ? headers[skuIdx] : null,
        cbm: cbmIdx >= 0 ? headers[cbmIdx] : null,
        manufacturer: mfrIdx >= 0 ? headers[mfrIdx] : null,
        lead_time: ltIdx >= 0 ? headers[ltIdx] : null,
        seasonality: seasIdx >= 0 ? headers[seasIdx] : null,
      });

      if (skuIdx === -1) { setParseError('Nie znaleziono kolumny "sku" / "symbol" w nagłówku'); return; }

      const rows: ParsedRow[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(sep).map((c) => c.trim());
        const sku = cols[skuIdx];
        if (!sku) continue;
        const row: ParsedRow = { _line: i + 1, sku, _existing: existingSkus.has(sku.trim().toLowerCase()) };
        if (cbmIdx >= 0 && cols[cbmIdx]) row.cbm = parseFloat(cols[cbmIdx].replace(",", "."));
        if (mfrIdx >= 0 && cols[mfrIdx]) row.manufacturer_name = cols[mfrIdx];
        if (ltIdx >= 0 && cols[ltIdx]) row.lead_time_days = parseInt(cols[ltIdx], 10);
        if (seasIdx >= 0 && cols[seasIdx]) row.seasonality_enabled = ["true", "tak", "1", "yes", "on"].includes(cols[seasIdx].toLowerCase());
        rows.push(row);
      }
      if (rows.length === 0) { setParseError("Wszystkie wiersze mają pusty SKU"); return; }
      setParsedRows(rows);
      setStep(2);
    } catch (e) {
      setParseError("Błąd parsowania: " + (e as Error).message);
    }
  };

  const doImport = async () => {
    const existing = parsedRows.filter((r) => r._existing);
    const missing = parsedRows.filter((r) => !r._existing);

    if (options.dryRun) {
      setResult({
        total: parsedRows.length,
        updated: existing.length,
        skipped: missing.length,
        errors: missing.map((r) => `Linia ${r._line}: SKU ${r.sku} nie istnieje w bazie (pominięto)`).slice(0, 20),
        dryRun: true,
      });
      setStep(3);
      return;
    }

    setImporting(true);
    try {
      const payload = parsedRows.map((r) => ({
        sku: r.sku,
        cbm: r.cbm ?? null,
        manufacturer_name: r.manufacturer_name ?? null,
        lead_time_days: r.lead_time_days ?? null,
        seasonality_enabled: r.seasonality_enabled ?? null,
      }));
      const res = (await api.post("/products/import", payload)) as { total: number; updated: number; skipped: number; errors: string[] };
      setResult({ total: res.total, updated: res.updated, skipped: res.skipped, errors: res.errors || [], dryRun: false });
      setStep(3);
      onImported?.();
    } catch {
      toast("Import nie powiódł się", "warning");
    } finally {
      setImporting(false);
    }
  };

  const reset = () => { setStep(1); setCsvText(""); setParsedRows([]); setParseError(null); setResult(null); };

  return (
    <Portal>
      <div onClick={onClose} style={modalBackdrop}>
        <div onClick={(e) => e.stopPropagation()} className="fade-in" style={{ ...modalCard, maxWidth: 760 }}>
        <div style={{ padding: "14px 22px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}><I.ArrowDown size={16} /></div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-hi)" }}>Import produktów</div>
              <div style={{ fontSize: 11, color: "var(--text-lo)" }}>Aktualizacja atrybutów SKU z pliku CSV</div>
            </div>
          </div>
          <button onClick={onClose} style={iconBtnHeaderInline}><I.Close size={14} /></button>
        </div>

        <ImportStepper step={step} />

        <div style={{ overflowY: "auto", padding: 22, flex: 1 }}>
          {step === 1 && (
            <ImportStep1 csvText={csvText} setCsvText={setCsvText} dragging={dragging} setDragging={setDragging} parseError={parseError} onFile={handleFile} onParse={parse} />
          )}
          {step === 2 && (
            <ImportStep2 rows={parsedRows} columns={detectedColumns} separator={detectedSep} options={options} setOptions={setOptions} onBack={() => setStep(1)} onImport={doImport} importing={importing} />
          )}
          {step === 3 && result && <ImportStep3 result={result} onClose={onClose} onReset={reset} />}
        </div>
        </div>
      </div>
    </Portal>
  );
}

// ── Stepper ──────────────────────────────────────────────────
function ImportStepper({ step }: { step: number }) {
  const labels = ["Wgraj plik", "Sprawdź dane", "Wynik"];
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "14px 22px", borderBottom: "1px solid var(--border-soft)" }}>
      {labels.map((label, i) => {
        const s = i + 1;
        const reached = step >= s;
        const active = step === s;
        return (
          <React.Fragment key={s}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 24, height: 24, borderRadius: 99, background: reached ? "var(--accent)" : "var(--surface-2)", color: reached ? "var(--accent-ink)" : "var(--text-lo)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, border: active ? "2px solid var(--accent-soft)" : "1px solid var(--border-soft)", transition: "all 0.16s" }}>
                {step > s ? <I.Activity size={11} /> : s}
              </div>
              <span style={{ fontSize: 12, fontWeight: 500, color: active ? "var(--text-hi)" : reached ? "var(--text-mid)" : "var(--text-lo)" }}>{label}</span>
            </div>
            {i < labels.length - 1 && (
              <div style={{ flex: 1, height: 2, background: step > s ? "var(--accent)" : "var(--surface-2)", margin: "0 12px", transition: "background 0.2s" }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Krok 1: wgraj / wklej ────────────────────────────────────
function ImportStep1({
  csvText, setCsvText, dragging, setDragging, parseError, onFile, onParse,
}: {
  csvText: string; setCsvText: (v: string) => void;
  dragging: boolean; setDragging: (v: boolean) => void;
  parseError: string | null; onFile: (f?: File) => void; onParse: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop} onClick={() => inputRef.current?.click()}
        style={{ padding: 22, border: `2px dashed ${dragging ? "var(--accent)" : "var(--border)"}`, borderRadius: 12, background: dragging ? "var(--accent-soft)" : "var(--surface-1)", textAlign: "center", transition: "all 0.16s", cursor: "pointer" }}>
        <input ref={inputRef} type="file" accept=".csv,.txt,.tsv" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <div style={{ width: 40, height: 40, margin: "0 auto 10px", borderRadius: 10, background: "var(--surface-2)", color: dragging ? "var(--accent)" : "var(--text-mid)", display: "flex", alignItems: "center", justifyContent: "center" }}><I.ArrowDown size={18} /></div>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-hi)" }}>Przeciągnij plik lub kliknij żeby wybrać</div>
        <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 3 }}>CSV / TSV — zostanie wklejony do pola poniżej</div>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em" }}>… lub wklej dane CSV</label>
          <button onClick={() => setCsvText(EXAMPLE_CSV)} style={{ background: "transparent", border: "none", color: "var(--accent)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Wstaw przykład</button>
        </div>
        <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={8} placeholder={EXAMPLE_CSV}
          style={{ ...inputStyleImport, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, resize: "vertical", minHeight: 160 }} />
      </div>

      {parseError && (
        <div style={{ padding: "10px 12px", background: "var(--critical-soft)", border: "1px solid color-mix(in oklch, var(--critical) 40%, var(--border))", borderRadius: 8, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <span style={{ color: "var(--critical)", flexShrink: 0, marginTop: 1 }}><I.Alert size={13} /></span>
          <span style={{ fontSize: 12, color: "var(--text-hi)" }}>{parseError}</span>
        </div>
      )}

      <div style={{ padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Format kolumn (separator: „;", „," lub TAB)</div>
        <div className="mono" style={{ fontSize: 11, color: "var(--text-mid)", lineHeight: 1.6 }}>
          <strong style={{ color: "var(--text-hi)" }}>sku</strong>* · cbm · manufacturer_name · lead_time_days · seasonality_enabled
        </div>
        <div style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 6 }}>
          Tylko <strong>sku</strong> jest wymagany. Reszta opcjonalna. Nieznani producenci utworzą się automatycznie. SKU spoza bazy są pomijane.
        </div>
      </div>

      <button onClick={onParse} disabled={!csvText.trim()} style={{ ...btnPrimaryFullImport, opacity: !csvText.trim() ? 0.5 : 1, cursor: !csvText.trim() ? "not-allowed" : "pointer" }}>
        Sprawdź dane <I.ArrowRight size={13} />
      </button>
    </div>
  );
}

// ── Krok 2: podgląd ──────────────────────────────────────────
function ImportStep2({
  rows, columns, separator, options, setOptions, onBack, onImport, importing,
}: {
  rows: ParsedRow[]; columns: DetectedColumns; separator: string;
  options: { dryRun: boolean }; setOptions: (o: { dryRun: boolean }) => void;
  onBack: () => void; onImport: () => void; importing: boolean;
}) {
  const existing = rows.filter((r) => r._existing).length;
  const missing = rows.length - existing;
  const canImport = existing > 0;
  const previewGrid = "32px 130px 70px minmax(0, 1fr) 60px 60px 60px";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
        <ImportStat label="Wierszy" value={rows.length} color="var(--text-hi)" />
        <ImportStat label="Istniejące" value={existing} color="var(--info)" />
        <ImportStat label="Nieznane" value={missing} color="var(--anomaly)" />
        <ImportStat label="Separator" value={separator === "\t" ? "TAB" : `„${separator}"`} color="var(--text-mid)" mono />
      </div>

      <div style={{ padding: "12px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Wykryte kolumny</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {Object.entries(columns).map(([key, val]) => (
            <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", background: val ? "var(--ok-soft)" : "var(--surface-2)", color: val ? "var(--ok)" : "var(--text-disabled)", borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
              {val ? <I.Activity size={10} /> : <I.Close size={10} />}
              <span style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>{key}</span>
              {val && <span className="mono" style={{ opacity: 0.75 }}>→ {val}</span>}
            </span>
          ))}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-mid)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
          Podgląd ({Math.min(rows.length, 50)} z {rows.length} wierszy)
        </div>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, maxHeight: 260, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: previewGrid, gap: 8, padding: "8px 12px", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)" }}>
            <span style={{ textAlign: "center" }}>L.</span>
            <span>SKU</span>
            <span style={{ textAlign: "right" }}>CBM</span>
            <span>Producent</span>
            <span style={{ textAlign: "right" }}>LT</span>
            <span style={{ textAlign: "center" }}>Sez.</span>
            <span style={{ textAlign: "center" }}>Akcja</span>
          </div>
          {rows.slice(0, 50).map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: previewGrid, gap: 8, padding: "7px 12px", fontSize: 11, borderBottom: i === Math.min(rows.length, 50) - 1 ? "none" : "1px solid var(--border-soft)", alignItems: "center" }}>
              <span className="num" style={{ textAlign: "center", color: "var(--text-lo)" }}>{r._line}</span>
              <span className="mono" style={{ fontWeight: 600, color: "var(--text-hi)" }}>{r.sku}</span>
              <span className="num" style={{ textAlign: "right", color: r.cbm ? "var(--text-mid)" : "var(--text-disabled)" }}>{r.cbm?.toFixed(3) || "—"}</span>
              <span style={{ color: r.manufacturer_name ? "var(--text-mid)" : "var(--text-disabled)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.manufacturer_name || "—"}</span>
              <span className="num" style={{ textAlign: "right", color: r.lead_time_days ? "var(--text-mid)" : "var(--text-disabled)" }}>{r.lead_time_days || "—"}</span>
              <span style={{ textAlign: "center" }}>{r.seasonality_enabled ? <span style={{ color: "var(--anomaly)" }}>●</span> : <span style={{ color: "var(--text-disabled)" }}>○</span>}</span>
              <span style={{ textAlign: "center", fontSize: 9, fontWeight: 700, letterSpacing: "0.04em" }}>
                {r._existing ? <span style={{ color: "var(--info)" }}>UPD</span> : <span style={{ color: "var(--text-disabled)" }}>POMIŃ</span>}
              </span>
            </div>
          ))}
          {rows.length > 50 && <div style={{ padding: 10, textAlign: "center", fontSize: 11, color: "var(--text-lo)" }}>…i {rows.length - 50} więcej</div>}
        </div>
      </div>

      <label style={importOptionStyle}>
        <Checkbox checked={options.dryRun} onChange={() => setOptions({ dryRun: !options.dryRun })} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: "var(--text-hi)" }}>Dry-run (pokaż zmiany bez zapisu)</div>
          <div style={{ fontSize: 10, color: "var(--text-lo)" }}>Nic nie zapisze — tylko podgląd wyniku</div>
        </div>
        {options.dryRun && <Pill bg="var(--pending-soft)" fg="var(--pending)" size="sm">SUCHY</Pill>}
      </label>

      {missing > 0 && (
        <div style={{ padding: "10px 12px", background: "var(--warning-soft)", border: "1px solid color-mix(in oklch, var(--warning) 30%, var(--border))", borderRadius: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <I.Alert size={13} style={{ color: "var(--warning)" }} />
          <span style={{ fontSize: 11, color: "var(--text-mid)" }}>
            <strong style={{ color: "var(--warning)" }}>{missing} wierszy</strong> ma SKU spoza bazy — zostaną pominięte (produkty pochodzą z Subiekta)
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onBack} style={btnSecondaryFullImport}>
          <I.ArrowRight size={12} style={{ transform: "rotate(180deg)" }} /> Wstecz
        </button>
        <button onClick={onImport} disabled={importing || (!options.dryRun && !canImport)}
          style={{ ...btnPrimaryFullImport, background: options.dryRun ? "var(--pending)" : "var(--accent)", borderColor: options.dryRun ? "var(--pending)" : "var(--accent)", color: "var(--accent-ink)", opacity: (importing || (!options.dryRun && !canImport)) ? 0.5 : 1, cursor: (importing || (!options.dryRun && !canImport)) ? "not-allowed" : "pointer" }}>
          {importing ? (
            <><span className="pulse-soft"><I.Refresh size={12} /></span> {options.dryRun ? "Symuluję..." : "Importuję..."}</>
          ) : (
            <>{options.dryRun ? "Wykonaj dry-run" : `Importuj ${existing} wierszy`} <I.ArrowRight size={12} /></>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Krok 3: wynik ────────────────────────────────────────────
function ImportStep3({ result, onClose, onReset }: { result: ImportResult; onClose: () => void; onReset: () => void }) {
  const isSuccess = result.updated > 0 && (!result.errors || result.errors.length === 0);
  const tone = result.dryRun ? "var(--pending)" : isSuccess ? "var(--ok)" : "var(--warning)";
  const toneSoft = result.dryRun ? "var(--pending-soft)" : isSuccess ? "var(--ok-soft)" : "var(--warning-soft)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ padding: 22, textAlign: "center", background: toneSoft, border: `1px solid color-mix(in oklch, ${tone} 40%, var(--border))`, borderRadius: 12 }}>
        <div style={{ width: 48, height: 48, margin: "0 auto 12px", borderRadius: 12, background: tone, color: "white", display: "flex", alignItems: "center", justifyContent: "center" }}><I.Activity size={22} /></div>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-hi)" }}>
          {result.dryRun ? "Dry-run zakończony" : isSuccess ? "Import zakończony" : "Import zakończony z ostrzeżeniami"}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-mid)", marginTop: 6 }}>
          {result.dryRun ? "Nic nie zapisano — to był podgląd." : `${result.updated} wierszy zaktualizowanych`}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
        <ImportStat label="Łącznie" value={result.total} color="var(--text-hi)" />
        <ImportStat label="Zaktualizowane" value={result.updated} color="var(--info)" />
        <ImportStat label="Pominięte" value={result.skipped} color="var(--text-lo)" />
      </div>

      {result.errors && result.errors.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--warning)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <I.Alert size={11} /> Ostrzeżenia ({result.errors.length})
          </div>
          <div style={{ background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 10, maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {result.errors.map((e, i) => (
              <div key={i} className="mono" style={{ fontSize: 10, color: "var(--text-mid)" }}>{e}</div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onReset} style={btnSecondaryFullImport}><I.Refresh size={12} /> Nowy import</button>
        <button onClick={onClose} style={btnPrimaryFullImport}>Zamknij <I.Close size={12} /></button>
      </div>
    </div>
  );
}

// ── Helpery / style ──────────────────────────────────────────
function ImportStat({ label, value, color, mono }: { label: string; value: React.ReactNode; color: string; mono?: boolean }) {
  return (
    <div style={{ padding: "10px 12px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div className={mono ? "mono" : "num"} style={{ fontSize: 20, fontWeight: 600, color, marginTop: 3, letterSpacing: "-0.02em" }}>{value}</div>
    </div>
  );
}

const inputStyleImport: React.CSSProperties = {
  width: "100%", padding: "10px 12px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text-hi)", outline: "none", fontFamily: "inherit",
};
const btnPrimaryFullImport: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flex: 1, padding: "11px 16px", background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--accent-ink)", borderRadius: 8, fontSize: 13, fontWeight: 600,
};
const btnSecondaryFullImport: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flex: 1, padding: "11px 16px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", color: "var(--text-mid)", borderRadius: 8, fontSize: 13, fontWeight: 500,
};
const importOptionStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8, cursor: "pointer",
};
const iconBtnHeaderInline: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, background: "transparent", border: "1px solid var(--border-soft)", borderRadius: 7, color: "var(--text-mid)",
};
