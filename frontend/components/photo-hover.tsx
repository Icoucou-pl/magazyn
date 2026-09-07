"use client";
// ============================================================
// MAGAZYN — miniatura produktu + podgląd po najechaniu myszką.
//
// Osobny plik, żeby products-ui i containers-ui mogły z niego korzystać
// bez cyklicznego importu między sobą.
//
// Dwa tryby zasilania danymi:
//   1. Lista produktów — zna już photo_id/photo_hash z /api/products,
//      więc miniatura i podgląd idą bez żadnego dodatkowego żądania.
//   2. Pozycje kontenera — mają tylko SKU. Zdjęcie dociągamy LENIWIE,
//      dopiero przy pierwszym najechaniu, i zapamiętujemy w cache modułu.
//      Dzięki temu otwarcie kontenera z 30 pozycjami nie generuje 30 zapytań.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, photoUrl } from "@/lib/api";

type PhotoRef = { id: number; hash: string } | null;

// Cache per SKU na czas życia karty. `null` = sprawdzone, produkt nie ma zdjęcia
// (i nie pytamy o to drugi raz). Klucz znormalizowany — SKU bywa różnej wielkości liter.
const cache = new Map<string, PhotoRef>();
const wLocie = new Map<string, Promise<PhotoRef>>();

const klucz = (sku: string) => sku.trim().toLowerCase();

async function pobierzZdjecie(sku: string): Promise<PhotoRef> {
  const k = klucz(sku);
  if (cache.has(k)) return cache.get(k)!;
  if (wLocie.has(k)) return wLocie.get(k)!;

  const p = api.get(`/products/${encodeURIComponent(sku)}/photos`)
    .then((d) => {
      const lista = (d as Array<{ id: number; content_hash: string }>) || [];
      const ref: PhotoRef = lista.length ? { id: lista[0].id, hash: lista[0].content_hash } : null;
      cache.set(k, ref);
      return ref;
    })
    .catch(() => { cache.set(k, null); return null; })
    .finally(() => { wLocie.delete(k); });

  wLocie.set(k, p);
  return p;
}

/** Czyści cache — wołane po wgraniu/usunięciu zdjęcia, żeby podgląd nie został na starym. */
export function resetPhotoCache(sku?: string) {
  if (sku) { cache.delete(klucz(sku)); } else { cache.clear(); }
}

// Urządzenia dotykowe nie mają hovera — tam podgląd w ogóle się nie uruchamia,
// żeby nie migał przy przewijaniu palcem.
function maHover(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(hover: hover)").matches;
}

const ROZMIAR = 190;   // bok podglądu w px
const ODSTEP = 12;     // odstęp od elementu wyzwalającego

/**
 * Owija dowolny element. Po najechaniu pokazuje podgląd zdjęcia obok kursora.
 * Gdy produkt nie ma zdjęcia — nie dzieje się nic, dziecko renderuje się normalnie.
 */
export function PhotoHover({
  sku, photoId, photoHash, children, style,
}: {
  sku: string;
  photoId?: number | null;
  photoHash?: string | null;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const znane: PhotoRef = photoId && photoHash ? { id: photoId, hash: photoHash } : null;
  const [ref, setRef] = useState<PhotoRef>(znane);
  const [poz, setPoz] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => { setRef(photoId && photoHash ? { id: photoId, hash: photoHash } : null); }, [photoId, photoHash]);

  const wejscie = useCallback(async () => {
    if (!maHover()) return;
    let r = ref;
    if (!r) {
      r = await pobierzZdjecie(sku);
      if (!r) return;
      setRef(r);
    }
    const el = boxRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();

    // Domyślnie po prawej stronie elementu; gdy brakuje miejsca — po lewej.
    // Pion przycinamy do okna, żeby podgląd nigdy nie wyszedł poza ekran.
    const zaWaski = b.right + ODSTEP + ROZMIAR > window.innerWidth;
    const x = zaWaski ? Math.max(8, b.left - ODSTEP - ROZMIAR) : b.right + ODSTEP;
    const y = Math.min(
      Math.max(8, b.top + b.height / 2 - ROZMIAR / 2),
      Math.max(8, window.innerHeight - ROZMIAR - 8)
    );
    setPoz({ x, y });
  }, [ref, sku]);

  const wyjscie = useCallback(() => setPoz(null), []);

  // Przewinięcie strony z otwartym podglądem zostawiłoby go wiszącego w powietrzu.
  useEffect(() => {
    if (!poz) return;
    const zamknij = () => setPoz(null);
    window.addEventListener("scroll", zamknij, true);
    return () => window.removeEventListener("scroll", zamknij, true);
  }, [poz]);

  return (
    <>
      <span ref={boxRef} onMouseEnter={wejscie} onMouseLeave={wyjscie} style={style}>
        {children}
      </span>
      {poz && ref && typeof document !== "undefined" && createPortal(
        <div
          style={{
            position: "fixed", left: poz.x, top: poz.y, width: ROZMIAR, height: ROZMIAR,
            borderRadius: 10, overflow: "hidden", zIndex: 300, pointerEvents: "none",
            background: "var(--surface-1)", border: "1px solid var(--border)",
            boxShadow: "0 12px 32px oklch(0 0 0 / 0.28)",
          }}
        >
          <img src={photoUrl(ref.id, ref.hash, "full") || ""} alt=""
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
        </div>,
        document.body
      )}
    </>
  );
}

/**
 * Kwadratowa miniatura do wiersza listy. Bez zdjęcia rysuje neutralny placeholder,
 * żeby kolumna nie skakała na szerokość między wierszami.
 */
export function ProductThumb({
  photoId, photoHash, size = 28,
}: { photoId?: number | null; photoHash?: string | null; size?: number }) {
  const src = photoUrl(photoId, photoHash, "thumb");
  const wspolne: React.CSSProperties = {
    width: size, height: size, borderRadius: 5, flexShrink: 0,
    border: "1px solid var(--border-soft)", background: "var(--surface-2)",
  };
  if (!src) {
    return <span style={{ ...wspolne, display: "inline-block" }} aria-hidden />;
  }
  // loading="lazy": przy 200 wierszach ładują się tylko widoczne miniatury.
  return <img src={src} alt="" loading="lazy" decoding="async" style={{ ...wspolne, objectFit: "cover", display: "block" }} />;
}
