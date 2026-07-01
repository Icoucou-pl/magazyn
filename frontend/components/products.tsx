"use client";
// ============================================================
// MAGAZYN — Produkty: widok listy (etap 2a). Orkiestrator.
//   Fetch /products (4 statusy) + /manufacturers, filtry, sort,
//   zaznaczanie, gwiazdka (toggle favorite), BulkBar, ColPicker, eksport.
//   Import (2b) i modal szczegółów (2c) podpinamy w kolejnych krokach.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast, exportCsv, type CsvColumn } from "./toast";
import { useUser, can } from "@/lib/permissions";
import {
  ProductsToolbar, ProductsTable, ColPickerModal, BulkBar,
  PRODUCT_COLS, DEFAULT_COLS, STATUS_RANK, displayStatus, monthsDisplay,
  readShowInactive, writeShowInactive,
  type Product, type Manufacturer, type Firma,
} from "./products-ui";
import ImportModal from "./import-modal";
import ProductModal from "./product-modal";

type SortState = { key: keyof Product | null; dir: "asc" | "desc" | null };

const sortVal = (p: Product, key: keyof Product): number | string => {
  if (key === "status") return STATUS_RANK[displayStatus(p)] ?? 99;
  const v = p[key];
  if (v == null) return "";
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.toLowerCase();
  return String(v);
};

export default function ProductsView({
  density, openSku, onOpenedSku,
}: {
  density?: string;
  openSku?: string | null;
  onOpenedSku?: () => void;
}) {
  const gap = density === "compact" ? 10 : 12;
  const showFin = can(useUser(), "viewFinancials");

  const [products, setProducts] = useState<Product[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [firmy, setFirmy] = useState<Firma[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("active");
  // Start false (SSR-safe: brak window), wczytaj zapamiętaną preferencję po montażu.
  const [showInactive, setShowInactive] = useState(false);
  useEffect(() => { setShowInactive(readShowInactive()); }, []);
  // Zapis tylko przy jawnym przełączeniu przez usera (nie klobruje przy starcie).
  const toggleInactive = useCallback((v: boolean) => { setShowInactive(v); writeShowInactive(v); }, []);
  const [sort, setSort] = useState<SortState>({ key: "status", dir: "asc" });
  const [visibleCols, setVisibleCols] = useState(DEFAULT_COLS);
  const [showColPicker, setShowColPicker] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const existingSkus = useMemo(() => new Set(products.map((p) => p.sku.trim().toLowerCase())), [products]);

  const reload = useCallback(async () => {
    setLoading(true);
    // INACTIVE (stan 0 + zero sprzedaży 12m) domyślnie POMIJANE — zaśmiecały listę,
    // liczniki i wyszukiwanie w liście. Wchodzą tylko po włączeniu toggla "Nieaktywne".
    const include = showInactive
      ? "ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE"
      : "ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK";
    const [prod, mfr] = await Promise.allSettled([
      api.get(`/products?include=${include}`),
      api.get("/manufacturers"),
    ]);
    if (prod.status === "fulfilled") setProducts((prod.value as Product[]) || []);
    else toast("Nie udało się wczytać produktów", "warning");
    if (mfr.status === "fulfilled") setManufacturers((mfr.value as Manufacturer[]) || []);
    setLoading(false);
  }, [showInactive]);

  useEffect(() => { reload(); }, [reload]);

  // Firmy (sklepy AMH/Acti/Veluxa) — do dropdownu „Firma" na karcie i bulku „Przypisz firmę". Statyczne → raz na mount.
  useEffect(() => {
    (async () => {
      try { setFirmy(((await api.get("/firmy")) as Firma[]) || []); } catch { /* brak firm — dropdown pokaże pustkę */ }
    })();
  }, []);

  // Drill-down z Dashboardu: po załadowaniu otwórz modal wskazanego SKU
  useEffect(() => {
    if (!openSku || loading) return;
    const p = products.find((x) => x.sku === openSku);
    if (p) setSelectedProduct(p);
    else toast(`Nie znaleziono produktu ${openSku}`, "info");
    onOpenedSku?.();
  }, [openSku, loading, products, onOpenedSku]);

  const toggleRow = (sku: string) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(sku)) n.delete(sku); else n.add(sku);
    return n;
  });
  const toggleAll = (rows: Product[]) => setSelected((prev) => {
    const allSel = rows.length > 0 && rows.every((r) => prev.has(r.sku));
    return allSel ? new Set() : new Set(rows.map((r) => r.sku));
  });
  const clearSel = () => setSelected(new Set());

  const onToggleFav = async (p: Product) => {
    try {
      const updated = (await api.put(`/products/${encodeURIComponent(p.sku)}/favorite`)) as Product;
      setProducts((prev) => prev.map((x) => (x.sku === p.sku ? updated : x)));
    } catch {
      toast("Nie udało się zmienić obserwowania", "warning");
    }
  };

  const onProductUpdated = (u: Product) => {
    setProducts((prev) => prev.map((x) => (x.sku === u.sku ? u : x)));
    setSelectedProduct(u);
  };

  const filtered = useMemo(() => {
    let arr = products;
    const q = search.trim().toLowerCase();
    if (q) {
      // Szukanie działa globalnie — niezależnie od zakładki statusu, żeby znaleźć też
      // produkty nieaktywne/martwe (np. stan 0 bez świeżej sprzedaży).
      arr = arr.filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    } else {
      if (filter === "active") arr = arr.filter((p) => p.product_status === "ACTIVE" || p.product_status === "ACTIVE_NO_STOCK");
      if (filter === "favorites") arr = arr.filter((p) => p.is_favorite);
      if (filter === "critical") arr = arr.filter((p) => p.status === "KRYTYCZNY" || p.status === "ZAMOW_TERAZ");
      if (filter === "dead") arr = arr.filter((p) => p.product_status === "DEAD_STOCK");
    }
    if (sort.key) {
      const key = sort.key;
      arr = [...arr].sort((a, b) => {
        const av = sortVal(a, key);
        const bv = sortVal(b, key);
        if ((av as never) < (bv as never)) return sort.dir === "asc" ? -1 : 1;
        if ((av as never) > (bv as never)) return sort.dir === "asc" ? 1 : -1;
        return 0;
      });
    }
    return arr;
  }, [products, filter, search, sort]);

  const counts = useMemo(() => ({
    active: products.filter((p) => p.product_status === "ACTIVE" || p.product_status === "ACTIVE_NO_STOCK").length,
    favorites: products.filter((p) => p.is_favorite).length,
    critical: products.filter((p) => p.status === "KRYTYCZNY" || p.status === "ZAMOW_TERAZ").length,
    dead: products.filter((p) => p.product_status === "DEAD_STOCK").length,
    all: products.length,
  }), [products]);

  const toggleSort = (key: keyof Product | null) => {
    if (!key) return;
    if (sort.key === key) {
      setSort(sort.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: null });
    } else {
      setSort({ key, dir: "asc" });
    }
  };

  const onExport = () => {
    const cols: CsvColumn<Product>[] = [
      { key: "sku", label: "SKU" },
      { key: "name", label: "Nazwa" },
      { label: "Producent", get: (p) => p.manufacturer_name || "" },
      { key: "stock", label: "Stan" },
      { key: "stock_in_transit", label: "W drodze" },
      { label: "Sprzedaz/mies", get: (p) => Math.round(p.avg_monthly_weighted) },
      { key: "sales_1m", label: "Sprzedaz 30d" },
      { label: "Miesiecy zapasu", get: (p) => monthsDisplay(p.months_of_stock) },
      ...(showFin ? [
        { key: "purchase_price", label: "Cena zakupu (obecna)" },
        { label: "Cena zakupu (reczna)", get: (p) => (p.cena_zakupu_manual != null && p.cena_zakupu_manual > 0 ? p.cena_zakupu_manual : "") },
        { key: "stock_value", label: "Wartosc stanu" },
      ] as CsvColumn<Product>[] : []),
      { key: "lead_time_days", label: "Lead time (dni)" },
      { key: "cbm_per_unit", label: "CBM" },
      { label: "Status", get: (p) => displayStatus(p) },
    ];
    exportCsv("produkty", cols, filtered);
  };

  if (loading) {
    return (
      <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap, paddingBottom: 80 }}>
        <div style={{ height: 56, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />
        <div style={{ height: 480, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }} />
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap, paddingBottom: 80, minWidth: 0 }}>
      <ProductsToolbar
        search={search} setSearch={setSearch}
        filter={filter} setFilter={setFilter}
        showInactive={showInactive} setShowInactive={toggleInactive}
        counts={counts}
        resultCount={filtered.length}
        onPickCols={() => setShowColPicker(true)}
        onImport={() => setShowImport(true)}
        onExport={onExport}
        visibleColsCount={visibleCols.length}
      />
      <ProductsTable
        rows={filtered}
        cols={PRODUCT_COLS.filter((c) => visibleCols.includes(c.id))}
        sort={sort} toggleSort={toggleSort}
        onProductClick={(p) => setSelectedProduct(p)}
        selected={selected}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
        onToggleFav={onToggleFav}
      />
      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          selectedSkus={[...selected]}
          rows={products}
          manufacturers={manufacturers}
          firmy={firmy}
          onClear={clearSel}
          onReload={reload}
        />
      )}
      {showColPicker && (
        <ColPickerModal
          cols={PRODUCT_COLS}
          visible={visibleCols}
          setVisible={setVisibleCols}
          onClose={() => setShowColPicker(false)}
        />
      )}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          existingSkus={existingSkus}
          onImported={reload}
        />
      )}
      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          manufacturers={manufacturers}
          firmy={firmy}
          onClose={() => setSelectedProduct(null)}
          onUpdated={onProductUpdated}
        />
      )}
    </div>
  );
}
