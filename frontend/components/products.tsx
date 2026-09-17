"use client";
// ============================================================
// MAGAZYN — Produkty: widok listy (etap 2a). Orkiestrator.
//   Fetch /products (4 statusy) + /manufacturers, filtry, sort,
//   zaznaczanie, gwiazdka (toggle favorite), BulkBar, ColPicker, eksport.
//   Import (2b) i modal szczegółów (2c) podpinamy w kolejnych krokach.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { api } from "@/lib/api";
import { toast, exportCsv, type CsvColumn } from "./toast";
import { useUser, can } from "@/lib/permissions";
import { useShop } from "@/lib/shop";
import {
  ProductsToolbar, ProductsTable, ColPickerModal, BulkBar, AddSampleModal,
  PRODUCT_COLS, DEFAULT_COLS, STATUS_RANK, displayStatus, monthsDisplay,
  readShowInactive, writeShowInactive,
  type Product, type Manufacturer, type Firma,
} from "./products-ui";
import ImportModal from "./import-modal";
import ProductModal from "./product-modal";
import ManufacturerModal from "./manufacturer-modal";

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
  density, openSku, onOpenedSku, onContainerClick,
}: {
  density?: string;
  openSku?: string | null;
  onOpenedSku?: () => void;
  onContainerClick?: (id: number) => void;
}) {
  const gap = density === "compact" ? 10 : 12;
  const showFin = can(useUser(), "viewFinancials");

  const [products, setProducts] = useState<Product[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [firmy, setFirmy] = useState<Firma[]>([]);
  // Ostatnio obsłużone SKU z drill-downu — blokada przed zapętleniem efektu.
  const obsluzone = useRef<string | null>(null);
  // SKU, którego kartę właśnie otwieramy (null = nic w toku).
  const [otwieranySku, setOtwieranySku] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  // Producent otwarty z chipa w karcie produktu. Katalogu ani kontenerów mu tu NIE
  // podajemy: lista w tym widoku jest zawężona zakładką firmy i „pokaż nieaktywne",
  // więc kafelek „Produktów (SKU)" pokazywałby co innego niż ten sam modal z Prognozy.
  // Modal dociąga sobie pełne dane sam.
  const [mfrModalId, setMfrModalId] = useState<number | null>(null);

  const [search, setSearch] = useState("");
  // Domyślny widok po wejściu w Produkty = Obserwowane (is_favorite), nie Aktywne.
  const [filter, setFilter] = useState("favorites");
  // Firma z globalnego fragmentatora w Topbarze (lib/shop).
  const { shop, setShop } = useShop();
  // Start false (SSR-safe: brak window), wczytaj zapamiętaną preferencję po montażu.
  const [showInactive, setShowInactive] = useState(false);
  useEffect(() => { setShowInactive(readShowInactive()); }, []);
  // Zapis tylko przy jawnym przełączeniu przez usera (nie klobruje przy starcie).
  const toggleInactive = useCallback((v: boolean) => { setShowInactive(v); writeShowInactive(v); }, []);
  const [sort, setSort] = useState<SortState>({ key: "status", dir: "asc" });
  const [visibleCols, setVisibleCols] = useState(DEFAULT_COLS);
  const [showColPicker, setShowColPicker] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddSample, setShowAddSample] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const existingSkus = useMemo(() => new Set(products.map((p) => p.sku.trim().toLowerCase())), [products]);

  const reload = useCallback(async () => {
    setLoading(true);
    // INACTIVE (stan 0 + zero sprzedaży 12m) domyślnie POMIJANE — zaśmiecały listę,
    // liczniki i wyszukiwanie w liście. Wchodzą tylko po włączeniu toggla "Nieaktywne".
    // SAMPLE jedzie zawsze — to status katalogowy (etykieta), a nie śmieć jak INACTIVE.
    const include = showInactive
      ? "ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE,SAMPLE"
      : "ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,SAMPLE";
    const shopQ = shop ? `&shop=${shop}` : "";
    const [prod, mfr] = await Promise.allSettled([
      api.get(`/products?include=${include}${shopQ}`),
      api.get("/manufacturers"),
    ]);
    if (prod.status === "fulfilled") setProducts((prod.value as Product[]) || []);
    else toast("Nie udało się wczytać produktów", "warning");
    if (mfr.status === "fulfilled") setManufacturers((mfr.value as Manufacturer[]) || []);
    setLoading(false);
  }, [showInactive, shop]);

  useEffect(() => { reload(); }, [reload]);

  // Modal dostaje KOPIĘ wiersza z listy, nie referencję do źródła. Po zmianie
  // firmy lista przyjeżdża nowa (stan, sprzedaż i cena są liczone per firma),
  // ale otwarta karta zostawała z liczbami poprzedniej spółki — przełącznik
  // się przełączał, a dane stały w miejscu. Podmieniamy wiersz na świeży,
  // dopasowany po SKU. Gdy produktu nie ma w nowej liście (nie występuje w tej
  // firmie), zostawiamy poprzedni — lepsze niż zamknięcie karty pod palcami.
  useEffect(() => {
    setSelectedProduct((prev) => {
      if (!prev) return prev;
      return products.find((p) => p.sku === prev.sku) || prev;
    });
  }, [products]);

  // Firmy (sklepy AMH/Acti/Veluxa) — do dropdownu „Firma" na karcie i bulku „Przypisz firmę". Statyczne → raz na mount.
  useEffect(() => {
    (async () => {
      try { setFirmy(((await api.get("/firmy")) as Firma[]) || []); } catch { /* brak firm — dropdown pokaże pustkę */ }
    })();
  }, []);

  // Drill-down z Dashboardu / globalnej wyszukiwarki: otwórz modal wskazanego SKU.
  // Dociągamy produkt WPROST przez get_product (nie z listy) — lista przy pierwszym
  // wejściu bywa jeszcze pusta i dawniej dawała fałszywe „Nie znaleziono produktu".
  // get_product zwraca SUMĘ po firmach niezależnie od wybranej zakładki, więc modal
  // pokazuje pełny obraz, a globalny fragmentator zostaje NIETKNIĘTY (dawniej robił
  // tu setShop(""), przez co po zamknięciu modalu cała apka siedziała na „Wszyscy").
  useEffect(() => {
    if (!openSku) { obsluzone.current = null; return; }

    // Każde SKU obsługujemy DOKŁADNIE RAZ — i BEZ sprzątania anulującego.
    //
    // Efekt ma w zależnościach `products` i `shop`, a sam wywołuje setShop i
    // powoduje przeładowanie listy, więc uruchamia się kilka razy pod rząd.
    // Poprzednia wersja miała blokadę „już obsłużone" ORAZ `return () =>
    // { cancelled = true }` — i te dwie rzeczy zabijały się nawzajem: kolejne
    // wejście w efekt sprzątało poprzednie (anulując trwające zapytanie),
    // a blokada nie pozwalała wystartować nowemu. Efekt: szkielet karty wisiał
    // w nieskończoność i nic się nie otwierało.
    //
    // Teraz aktualność sprawdzamy referencją: jeśli w międzyczasie użytkownik
    // otworzył inny produkt, `obsluzone.current` już się nie zgadza i odpowiedź
    // po prostu odrzucamy.
    if (obsluzone.current === openSku) return;
    obsluzone.current = openSku;

    const sku = openSku;
    const aktualne = () => obsluzone.current === sku;

    // Okno pokazujemy OD RAZU, ze szkieletem — wejście z dashboardu najpierw
    // przerzuca na „Produkty" i bez tego przez chwilę nic się nie dzieje.
    setOtwieranySku(sku);

    // Skrót: gdy lista jest już wczytana i zawiera ten SKU, wstawiamy wiersz
    // natychmiast, a zapytanie niżej tylko podmienia dane na firmowe.
    const zListy = products.find((x) => (x.sku || "").toLowerCase() === sku.toLowerCase());
    if (zListy) setSelectedProduct(zListy);

    (async () => {
      try {
        // Jeden strzał: backend przy shop="auto" sam ustala firmę właściciela.
        const p = (await api.get(
          `/products/${encodeURIComponent(sku)}?shop=auto`,
        )) as Product;

        if (!aktualne()) return;

        if (p) {
          const wlasciciel = p.firma_id
            ? firmy.find((f) => f.id === p.firma_id)?.slug
            : "amh";
          if (wlasciciel && wlasciciel !== shop) setShop(wlasciciel);
          setSelectedProduct(p);
        } else {
          toast(`Nie znaleziono produktu ${sku}`, "info");
        }
      } catch {
        if (aktualne()) toast(`Nie znaleziono produktu ${sku}`, "info");
      } finally {
        // Szkielet znika ZAWSZE — także gdy zapytanie padło. Inaczej zostaje
        // na ekranie na zawsze, co właśnie widzieliśmy.
        if (aktualne()) { setOtwieranySku(null); onOpenedSku?.(); }
      }
    })();
  }, [openSku, onOpenedSku, firmy, shop, setShop, products]);

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
  // Zmiana firmy: czyścimy zaznaczenie, bo lista SKU się zmienia (inaczej bulk mógłby trafić w SKU spoza widoku).
  useEffect(() => { setSelected(new Set()); }, [shop]);

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
      // „Sample" = wszystkie z ptaszkiem (etykieta pochodzenia), „Nowości" = w okresie nowości.
      // Filtry mogą się nakładać: sampel płynący albo świeżo dostarczony jest w obu.
      if (filter === "sample") arr = arr.filter((p) => p.is_sample);
      if (filter === "nowosc") arr = arr.filter((p) => p.is_new);
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
    sample: products.filter((p) => p.is_sample).length,
    nowosc: products.filter((p) => p.is_new).length,
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
      { label: "Firma", get: (p) => p.firma_name || "" },
      { label: "Producent", get: (p) => p.manufacturer_name || "" },
      { key: "stock", label: "Stan" },
      { label: "Magazyn w drodze", get: (p) => p.stock_in_transit_wbite || 0 },
      { label: "W kontenerach", get: (p) => p.stock_in_transit_containers || 0 },
      { label: "Sprzedaż/mies", get: (p) => Math.round(p.avg_monthly_weighted) },
      { key: "sales_1m", label: "Sprzedaż 30d" },
      { label: "Miesięcy zapasu", get: (p) => monthsDisplay(p.months_of_stock) },
      ...(showFin ? [
        { key: "purchase_price", label: "Cena zakupu (obecna)" },
        { label: "Cena zakupu (ręczna)", get: (p) => (p.cena_zakupu_manual != null && p.cena_zakupu_manual > 0 ? p.cena_zakupu_manual : "") },
        { key: "stock_value", label: "Wartość stanu" },
      ] as CsvColumn<Product>[] : []),
      { key: "lead_time_days", label: "Lead time (dni)" },
      { key: "cbm_per_unit", label: "CBM" },
      { label: "Status", get: (p) => displayStatus(p) },
    ];
    exportCsv("produkty", cols, filtered);
  };

  // Szkielet TYLKO przy pierwszym wczytaniu. Wcześniej ten return łapał każde
  // przeładowanie listy — także to po zmianie firmy w fragmentatorze — i na
  // ułamek sekundy podmieniał cały widok, przez co otwarty modal produktu był
  // odmontowywany i montował się od nowa. Przy kolejnych przeładowaniach
  // zostawiamy poprzednią listę na ekranie; świeżość sygnalizuje `loading`
  // przekazany do modala.
  if (loading && products.length === 0) {
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
        onAddSample={() => setShowAddSample(true)}
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
      {showAddSample && (
        <AddSampleModal
          manufacturers={manufacturers}
          firmy={firmy}
          showFin={showFin}
          onClose={() => setShowAddSample(false)}
          onCreated={() => { setFilter("sample"); reload(); }}
        />
      )}
      {/* Szkielet karty na czas pobierania. Znika w momencie, w którym
          prawdziwy modal ma już dane — dzięki temu klik z dashboardu od razu
          daje sygnał „otwieram", zamiast zostawiać użytkownika na liście. */}
      {otwieranySku && !selectedProduct && (
        <div onClick={() => setOtwieranySku(null)}
             style={{
               position: "fixed", inset: 0, zIndex: 60, background: "oklch(0 0 0 / 0.5)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
             }}>
          <div className="pulse-soft" onClick={(e) => e.stopPropagation()}
               style={{
                 width: "min(880px, 100%)", maxHeight: "88vh", background: "var(--surface-1)",
                 border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)",
                 padding: 22, display: "flex", flexDirection: "column", gap: 14,
               }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 64, height: 64, borderRadius: 10, background: "var(--surface-2)" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)" }}>
                  {otwieranySku}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 4 }}>wczytuję kartę produktu…</div>
              </div>
            </div>
            <div style={{ height: 70, background: "var(--surface-2)", borderRadius: "var(--r-md)" }} />
            <div style={{ height: 180, background: "var(--surface-2)", borderRadius: "var(--r-md)" }} />
          </div>
        </div>
      )}
      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          manufacturers={manufacturers}
          firmy={firmy}
          busy={loading}
          onClose={() => setSelectedProduct(null)}
          onUpdated={onProductUpdated}
          onContainerClick={onContainerClick}
          onManufacturerClick={(id) => setMfrModalId(id)}
          onDeleted={() => { setSelectedProduct(null); void reload(); }}
        />
      )}
      {mfrModalId != null && (
        <ManufacturerModal
          mfr={manufacturers.find((m) => m.id === mfrModalId) || null}
          manufacturers={manufacturers}
          firmy={firmy}
          showFin={showFin}
          onClose={() => setMfrModalId(null)}
        />
      )}
    </div>
  );
}
