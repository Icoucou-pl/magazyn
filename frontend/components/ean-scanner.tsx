"use client";
// ============================================================
// Skaner EAN z kamery. Dekoder: @zxing/browser (ZXing) — działa cross-platform,
// w tym iOS Safari (gdzie brak natywnego BarcodeDetector).
//   - tylna kamera (facingMode: environment), formaty handlowe (EAN/UPC/Code128)
//   - po wykryciu kodu → GET /api/search/ean → 1 trafienie otwiera kartę produktu,
//     wiele trafień → lista do wyboru, brak → banner i skanuje dalej
//   - fallback ręczny: wpisanie/wklejenie EAN lub SKU (gdy brak/odmowa kamery)
// Wymaga HTTPS (getUserMedia działa tylko w bezpiecznym kontekście — front na Railway OK).
// Render przez Portal do document.body.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { api } from "@/lib/api";
import { I } from "@/components/ui";
import { Portal, modalBackdrop, modalCard } from "@/components/products-ui";

interface EanResult { sku: string; name: string | null; stock: number | null; ean: string | null; }

type Mode = "scanning" | "looking_up" | "results" | "notfound" | "error";

type Props = {
  open: boolean;
  onClose: () => void;
  onProduct: (sku: string) => void;
};

// Hinty: ograniczamy do kodów spotykanych na produktach — szybciej i celniej.
const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
  ]],
]);

export default function EanScanner({ open, onClose, onProduct }: Props) {
  const [mode, setMode] = useState<Mode>("scanning");
  const [results, setResults] = useState<EanResult[]>([]);
  const [lastCode, setLastCode] = useState("");
  const [err, setErr] = useState("");
  const [manual, setManual] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const busyRef = useRef(false);
  const onProductRef = useRef(onProduct);
  useEffect(() => { onProductRef.current = onProduct; });

  const stopCamera = useCallback(() => {
    try { controlsRef.current?.stop(); } catch { /* noop */ }
    controlsRef.current = null;
    const v = videoRef.current;
    const stream = v && (v.srcObject as MediaStream | null);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (v) v.srcObject = null;
  }, []);

  const doLookup = useCallback(async (codeRaw: string) => {
    const code = codeRaw.trim();
    if (code.length < 2) return;
    setLastCode(code);
    setMode("looking_up");
    try {
      const data = (await api.get(`/search/ean?q=${encodeURIComponent(code)}`)) as EanResult[];
      if (!data || data.length === 0) {
        setMode("notfound");
        busyRef.current = false; // skanujemy dalej
      } else if (data.length === 1) {
        onProductRef.current(data[0].sku); // rodzic zamknie skaner → cleanup ubije kamerę
      } else {
        setResults(data);
        setMode("results");
      }
    } catch {
      setErr("Błąd wyszukiwania — spróbuj ponownie.");
      setMode("error");
      busyRef.current = false;
    }
  }, []);

  // Start/stop kamery przy otwarciu
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMode("scanning"); setErr(""); setResults([]); setLastCode(""); setManual("");
    busyRef.current = false;

    const reader = new BrowserMultiFormatReader(HINTS);
    (async () => {
      try {
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: "environment" } },
          videoRef.current as HTMLVideoElement,
          (result) => {
            if (result && !busyRef.current) {
              busyRef.current = true;
              void doLookup(result.getText());
            }
          },
        );
        if (cancelled) { controls.stop(); return; }
        controlsRef.current = controls;
      } catch {
        if (!cancelled) {
          setErr("Brak dostępu do kamery. Wpisz lub wklej EAN/SKU ręcznie.");
          setMode("error");
        }
      }
    })();

    return () => { cancelled = true; stopCamera(); };
  }, [open, doLookup, stopCamera]);

  if (!open) return null;

  const rescan = () => { setMode("scanning"); setResults([]); setErr(""); busyRef.current = false; };
  const submitManual = () => { busyRef.current = true; void doLookup(manual); };

  return (
    <Portal>
      <div style={modalBackdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div style={{ ...modalCard, maxWidth: 460 }}>
          {/* Nagłówek */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-hi)", fontSize: 14, fontWeight: 600 }}>
              <I.Scan size={16} style={{ color: "var(--accent)" }} /> Skaner EAN
            </div>
            <button onClick={onClose} title="Zamknij (Esc)" style={{ display: "inline-flex", background: "transparent", border: "none", color: "var(--text-lo)", cursor: "pointer", padding: 2 }}>
              <I.Close size={18} />
            </button>
          </div>

          {/* Podgląd kamery (ukryty w trybie błędu) */}
          {mode !== "error" && (
            <div style={{ position: "relative", background: "#000", aspectRatio: "4 / 3", overflow: "hidden" }}>
              <video
                ref={videoRef}
                muted
                playsInline
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
              {/* Ramka celownika */}
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                <div style={{ width: "72%", height: "42%", border: "2px solid color-mix(in oklch, var(--accent) 80%, white)", borderRadius: 12, boxShadow: "0 0 0 9999px color-mix(in oklch, black 35%, transparent)" }} />
              </div>
              {/* Status na dole podglądu */}
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "8px 12px", background: "color-mix(in oklch, black 55%, transparent)", color: "#fff", fontSize: 12, textAlign: "center" }}>
                {mode === "looking_up" ? `Sprawdzam ${lastCode}…`
                  : mode === "notfound" ? `Nie znaleziono „${lastCode}" — skanuj dalej lub wpisz ręcznie`
                  : "Nakieruj kod na ramkę"}
              </div>
            </div>
          )}

          {/* Błąd kamery */}
          {mode === "error" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px", color: "var(--warning)", fontSize: 13 }}>
              <I.Alert size={18} style={{ flexShrink: 0 }} /> {err}
            </div>
          )}

          {/* Lista wyboru przy wielu trafieniach */}
          {mode === "results" && (
            <div style={{ maxHeight: "34vh", overflowY: "auto", borderBottom: "1px solid var(--border-soft)" }}>
              <div style={{ padding: "8px 16px 4px", color: "var(--text-lo)", fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                Wiele dopasowań do „{lastCode}"
              </div>
              {results.map((r) => (
                <div key={r.sku} onClick={() => onProductRef.current(r.sku)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-soft)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <I.Box size={14} style={{ color: "var(--text-lo)", flexShrink: 0 }} />
                  <span style={{ color: "var(--text-hi)", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{r.sku}</span>
                  <span style={{ color: "var(--text-lo)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{r.name || "—"}</span>
                  <I.ArrowRight size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
                </div>
              ))}
              <div style={{ padding: "8px 16px" }}>
                <button onClick={rescan} style={{ background: "transparent", border: "none", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>← Skanuj ponownie</button>
              </div>
            </div>
          )}

          {/* Ręczne wpisanie EAN/SKU (zawsze dostępne) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, padding: "8px 11px", background: "var(--bg)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
              <I.Search size={14} style={{ color: "var(--text-lo)" }} />
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitManual(); }}
                placeholder="EAN lub SKU ręcznie…"
                inputMode="text"
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text-hi)", fontSize: 13 }}
              />
            </div>
            <button onClick={submitManual} disabled={manual.trim().length < 2}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--accent-ink)", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: manual.trim().length < 2 ? "default" : "pointer", opacity: manual.trim().length < 2 ? 0.5 : 1 }}>
              Szukaj
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
