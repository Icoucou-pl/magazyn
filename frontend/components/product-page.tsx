"use client";
// ============================================================
// MAGAZYN — Pełna karta produktu (/produkty/SKU?tab=…).
//
// Zastępuje modal produktu przy wejściu z listy, wyszukiwarki, skanera,
// dashboardu i prognozy. Modal zostaje TYLKO przy wejściu przez producenta
// (ManufacturerModal) — tam nie wybijamy użytkownika ze stosu okien.
//
// Układ:
//   • nagłówek stały dla wszystkich zakładek: SKU, producent, plakietki
//     (status, sample, nowość, obserwowany, nie zamawiamy), nazwa, stan,
//     koszt netto, EAN; po prawej obserwuj / nie dozamawiamy
//   • Logistyka  — KPI stanu, prognoza 270 dni, kontenery z tym SKU
//   • Sprzedaż   — KPI i rotacja z Finansów, sezon do sezonu, kanały
//                  (canSeeProductSales: viewProductSales ORAZ viewFinancials)
//   • Historia produktu — bez zmian względem modala (super-admin + SKU z historią)
//   • Dane       — atrybuty, zdjęcia, wymiary; strefa usuwania dla super-admina
//
// Klocki są WSPÓLNE z modalem (eksporty z product-modal.tsx i finance.tsx),
// więc obie drogi pokazują te same liczby tak samo policzone.
//
// Breadcrumb to „sznurek" (components/breadcrumbs): Produkty › D2k › Anji › A2-1cz.
// Chip producenta prowadzi na PEŁNĄ kartę producenta (/producenci/Nazwa), nie do modala.
//
// Zakładka siedzi w adresie (?tab=), ale zmienia się przez replace, nie push:
// „wstecz" ma cofać o widok, a nie przeklikiwać zakładki jedna po drugiej.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { I, Pill, STATUS_META } from "./ui";
import {
  StatusPillExt, displayStatus, NewBadge, SampleBadge,
  type Product, type Manufacturer, type Firma,
} from "./products-ui";
import {
  LogistykaKpi, Section, StockProjectionChart, buildProjection, ContainersSection,
  AttributesCard, DimensionsCard, DeleteZone, iconBtnHeader,
  type ApiProjPoint, type Projection, type DeleteCheck,
} from "./product-modal";
import { ProductSalesTab } from "./finance";
import ManufacturerModal from "./manufacturer-modal";
import Breadcrumbs, { type Trail } from "./breadcrumbs";
import LifecycleTabV2 from "./product-lifecycle-v2";
import { SeasonChart, type SeasonPoint } from "./season-chart";
import { ProductThumb } from "./photo-hover";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { can, canSeeProductHistory, canSeeProductSales, canSeePurchasePrice, useUser } from "@/lib/permissions";
import { useShop } from "@/lib/shop";
import { fmtPLN, fmtNum } from "@/lib/format";

export type ProductTab = "logistyka" | "sprzedaz" | "historia" | "dane";

// Prognoza na pełnej karcie: 180 dni z modala + 90. Endpoint przyjmuje dowolne `days`.
const HORYZONT_DNI = 270;

const TAB_LABELS: Record<ProductTab, string> = {
  logistyka: "Logistyka",
  sprzedaz: "Sprzedaż",
  historia: "Historia produktu",
  dane: "Dane",
};

function czytajTabZAdresu(): ProductTab | null {
  if (typeof window === "undefined") return null;
  const t = new URLSearchParams(window.location.search).get("tab");
  return t && t in TAB_LABELS ? (t as ProductTab) : null;
}

export default function ProductPage({
  sku, autoShop, backLabel, onBack, onBackToList, onTabChange, onContainerClick, onUpdated, onDeleted,
  trail, onCrumb, onManufacturerClick,
}: {
  sku: string;
  /** Wejście „z zewnątrz" (wyszukiwarka, skaner, dashboard, prognoza): sami ustalamy
   *  firmę właściciela i przełączamy na nią fragmentator — jak dotąd przy modalu.
   *  Wejście z listy: zostajemy w firmie, w której użytkownik właśnie jest. */
  autoShop: boolean;
  /** Etykieta warunkowego powrotu („← Wróć do: Kontenery"). null = przyszliśmy z listy
   *  albo z bezpośredniego linku — wtedy wystarcza breadcrumb. */
  backLabel: string | null;
  onBack: () => void;
  onBackToList: () => void;
  onTabChange: (tab: ProductTab) => void;
  onContainerClick?: (id: number) => void;
  /** Zmiana produktu (obserwuj, atrybuty, zdjęcie) — lista pod spodem ma się dowiedzieć. */
  onUpdated?: (p: Product) => void;
  onDeleted: () => void;
  /** Sznurek do breadcrumba. Brak = domyślny „Produkty › SKU". */
  trail?: Trail;
  onCrumb?: (index: number) => void;
  /** Chip producenta → pełna karta producenta. Brak = stary modal (zapas). */
  onManufacturerClick?: (name: string) => void;
}) {
  const user = useUser();
  const showFin = can(user, "viewFinancials");
  const canEditProducts = can(user, "editProducts");
  const salesAllowed = canSeeProductSales(user);
  // Cena jednostkowa w nagłówku: finanse ALBO osobne „Cena zakupu produktu" —
  // są osoby, które mają znać koszt sztuki, ale nie przychody i marże.
  const showPrice = canSeePurchasePrice(user);
  const isSuper = Boolean(
    (user as { is_super_admin?: boolean; isSuper?: boolean } | null)?.is_super_admin
    ?? (user as { isSuper?: boolean } | null)?.isSuper,
  );
  // Historia: ptaszek „Historia produktu" (domyślnie admin) albo super-admin.
  // Strefa usuwania zostaje wyłącznie przy super-adminie.
  const historyAllowed = canSeeProductHistory(user);
  const { shop, setShop } = useShop();

  const [product, setProduct] = useState<Product | null>(null);
  const [nieZnaleziono, setNieZnaleziono] = useState(false);
  // Po przełączeniu firmy SKU może w niej nie występować. Nie zamykamy karty
  // pod palcami — zostają liczby poprzedniej firmy, a nad nimi uczciwa informacja.
  const [brakWFirmie, setBrakWFirmie] = useState(false);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [firmy, setFirmy] = useState<Firma[]>([]);
  const [proj, setProj] = useState<Projection | null>(null);
  const [season, setSeason] = useState<SeasonPoint[] | null>(null);
  const [editingAttrs, setEditingAttrs] = useState(false);
  const [editingLT, setEditingLT] = useState(false);
  const [mfrModalId, setMfrModalId] = useState<number | null>(null);
  // null = sonda jeszcze nie odpowiedziała. Rozróżnienie jest potrzebne, żeby
  // wejście z linkiem ?tab=historia nie zostało zepchnięte na Logistykę,
  // zanim backend w ogóle powie, czy historia istnieje.
  const [hasHistory, setHasHistory] = useState<boolean | null>(null);
  const [delChk, setDelChk] = useState<DeleteCheck | null>(null);

  const [tab, setTabState] = useState<ProductTab>(() => czytajTabZAdresu() || "logistyka");
  const setTab = (t: ProductTab) => { setTabState(t); onTabChange(t); };

  // ── Słowniki (raz na montaż) ───────────────────────────────
  useEffect(() => {
    api.get("/manufacturers").then((d) => setManufacturers((d as Manufacturer[]) || [])).catch(() => { /* select producenta pusty — nie blokuje karty */ });
    api.get("/firmy").then((d) => setFirmy((d as Firma[]) || [])).catch(() => { /* jw. */ });
  }, []);

  // ── Produkt ────────────────────────────────────────────────
  // Nowe SKU → czyścimy wszystko, co należało do poprzedniego.
  //
  // `zaladowaneSku` = SKU, dla którego produkt FAKTYCZNIE dotarł i został
  // wstawiony. Ustawiamy go dopiero po udanej odpowiedzi, nie na starcie
  // efektu. W trybie deweloperskim React (StrictMode) odpala efekt dwa razy
  // z anulowaniem pierwszego przebiegu — gdyby znacznik stawiał się od razu,
  // drugi przebieg uznałby wejście za „nie pierwsze", pominął ustalanie firmy
  // właściciela i karta z wyszukiwarki otwierała się w bieżącej firmie
  // (Pod_1b Veluxy w AMH). Po udanym ładowaniu znacznik stoi, więc późniejsze
  // ręczne przełączenie firmy nie jest odkręcane na siłę.
  const zaladowaneSku = useRef<string | null>(null);
  useEffect(() => {
    setProduct(null); setNieZnaleziono(false); setBrakWFirmie(false);
    setProj(null); setSeason(null); setHasHistory(null); setDelChk(null);
    setEditingAttrs(false); setEditingLT(false);
    window.scrollTo({ top: 0 });
  }, [sku]);

  useEffect(() => {
    let alive = true;
    const pierwszeWejscie = zaladowaneSku.current !== sku;
    const enc = encodeURIComponent(sku);

    // Wejście „z zewnątrz" albo produkt, którego nie ma w bieżącej firmie przy
    // PIERWSZYM ładowaniu (np. odświeżenie strony w innej zakładce firm):
    // backend przy shop=auto sam ustala właściciela, a my przełączamy na niego
    // fragmentator. Przy późniejszych zmianach firmy NIE wracamy na siłę do
    // właściciela — inaczej użytkownik nie mógłby przełączyć firmy ręcznie.
    const zaladujAuto = async () => {
      const p = (await api.get(`/products/${enc}?shop=auto`)) as Product;
      if (!alive) return;
      let slownik = firmy;
      if (!slownik.length) {
        try { slownik = ((await api.get("/firmy")) as Firma[]) || []; } catch { slownik = []; }
      }
      if (!alive) return;
      const wlasciciel = p.firma_id ? slownik.find((f) => f.id === p.firma_id)?.slug : "amh";
      zaladowaneSku.current = sku;
      if (wlasciciel && wlasciciel !== shop) setShop(wlasciciel);
      setProduct(p); setBrakWFirmie(false);
    };

    (async () => {
      try {
        if (pierwszeWejscie && autoShop) { await zaladujAuto(); return; }
        const p = (await api.get(`/products/${enc}${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`)) as Product;
        if (!alive) return;
        zaladowaneSku.current = sku;
        setProduct(p); setBrakWFirmie(false);
      } catch {
        if (!alive) return;
        if (pierwszeWejscie) {
          try { await zaladujAuto(); }
          catch { if (alive) setNieZnaleziono(true); }
        } else {
          setBrakWFirmie(true);
        }
      }
    })();
    return () => { alive = false; };
    // `firmy` celowo poza zależnościami: słownik jest potrzebny tylko w ścieżce
    // auto, a jego dojście nie może wyzwalać ponownego pobrania produktu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sku, shop, autoShop]);

  const applyUpdate = (u: Product) => { setProduct(u); onUpdated?.(u); };
  const refreshProduct = () => {
    api.get(`/products/${encodeURIComponent(sku)}${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`)
      .then((p) => applyUpdate(p as Product))
      .catch(() => { /* zdjęcie i tak się zapisało */ });
  };

  // ── Prognoza (270 dni) i sezon ─────────────────────────────
  useEffect(() => {
    if (!product) return;
    let alive = true;
    api.get(`/products/${encodeURIComponent(product.sku)}/projection?days=${HORYZONT_DNI}`)
      .then((pts) => { if (alive) setProj(buildProjection((pts as ApiProjPoint[]) || [], product, HORYZONT_DNI)); })
      .catch(() => { if (alive) setProj(null); });
    return () => { alive = false; };
  }, [product]);

  useEffect(() => {
    let alive = true;
    api.get(`/products/${encodeURIComponent(sku)}/sales-season`)
      .then((d) => { if (alive) setSeason((d as SeasonPoint[]) || []); })
      .catch(() => { if (alive) setSeason([]); });
    return () => { alive = false; };
  }, [sku]);

  // ── Sondy super-admina (jak w modalu) ──────────────────────
  useEffect(() => {
    if (!historyAllowed) { setHasHistory(false); return; }
    let alive = true;
    api.get(`/products/${encodeURIComponent(sku)}/historia${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`)
      .then(() => { if (alive) setHasHistory(true); })
      .catch(() => { if (alive) setHasHistory(false); });
    return () => { alive = false; };
  }, [sku, historyAllowed, shop]);

  useEffect(() => {
    if (!isSuper) { setDelChk(null); return; }
    let alive = true;
    api.get(`/products/${encodeURIComponent(sku)}/delete-check`)
      .then((d) => { if (alive) setDelChk(d as DeleteCheck); })
      .catch(() => { if (alive) setDelChk(null); });
    return () => { alive = false; };
  }, [sku, isSuper]);

  // ── Dostępne zakładki ──────────────────────────────────────
  const tabs = useMemo(() => {
    const out: ProductTab[] = ["logistyka"];
    if (salesAllowed) out.push("sprzedaz");
    if (historyAllowed && hasHistory) out.push("historia");
    out.push("dane");
    return out;
  }, [salesAllowed, historyAllowed, hasHistory]);

  // Zakładka z linku, do której ktoś nie ma dostępu (albo historia, której
  // SKU nie ma) → Logistyka. Dla historii czekamy na odpowiedź sondy.
  useEffect(() => {
    if (tabs.includes(tab)) return;
    if (tab === "historia" && hasHistory === null) return;
    setTab("logistyka");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, tab, hasHistory]);

  // ── Akcje nagłówka ─────────────────────────────────────────
  // Zapis idzie po SKU z ODPOWIEDZI backendu, nie z adresu. Adres ktoś może
  // wpisać ręcznie małymi literami (/produkty/yfg2), a endpointy zapisu
  // tworzą wiersz atrybutów dokładnie pod podanym SKU — tak powstały dziś
  // dublujące się „YFG2" / „YFg2" w app_product_attrs.
  const skuZapisu = product?.sku ?? sku;
  const toggleFav = async () => {
    try {
      applyUpdate((await api.put(`/products/${encodeURIComponent(skuZapisu)}/favorite`)) as Product);
    } catch { toast("Nie udało się zmienić obserwowania", "warning"); }
  };
  const toggleNoReorder = async () => {
    try {
      const u = (await api.put(`/products/${encodeURIComponent(skuZapisu)}/no-reorder`)) as Product;
      applyUpdate(u);
      toast(u.no_reorder ? "Ukryto z zamawiania" : "Przywrócono do zamawiania", "ok");
    } catch { toast("Nie udało się zmienić", "warning"); }
  };

  // ── Widoki brzegowe ────────────────────────────────────────
  const pasekGorny = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
      <Breadcrumbs
        trail={trail && trail.length ? trail : [
          { label: "Produkty", path: "/produkty" },
          { label: product?.sku || sku, path: `/produkty/${encodeURIComponent(sku)}`, mono: true },
        ]}
        onNavigate={(i) => (onCrumb ? onCrumb(i) : onBackToList())}
      />
      {backLabel && (
        <button onClick={onBack} style={backBtn}>
          <span style={{ display: "flex", transform: "rotate(180deg)" }}><I.ChevronR size={13} /></span>
          Wróć do: {backLabel}
        </button>
      )}
    </div>
  );

  if (nieZnaleziono) {
    return (
      <div className="fade-in">
        {pasekGorny}
        <div style={{ padding: 48, textAlign: "center", background: "var(--surface-1)", border: "1px dashed var(--border)", borderRadius: "var(--r-lg)" }}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)" }}>{sku}</div>
          <p style={{ color: "var(--text-lo)", fontSize: 13, margin: "8px 0 16px" }}>Nie znaleziono takiego produktu w żadnej firmie.</p>
          <button onClick={onBackToList} style={backBtn}>Wróć do listy produktów</button>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="fade-in">
        {pasekGorny}
        <div className="pulse-soft" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ height: 132, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)" }} />
          <div style={{ height: 44, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />
          <div style={{ height: 90, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />
          <div style={{ height: 220, background: "var(--surface-1)", borderRadius: "var(--r-md)" }} />
        </div>
      </div>
    );
  }

  const statusKey = displayStatus(product);
  const statusDot = STATUS_META[statusKey]?.dot ?? "var(--text-disabled)";
  const mfrColor = product.manufacturer_color ?? "var(--text-lo)";

  const sezonBlok = (
    <Section title="Sprzedaż — sezon do sezonu">
      {season ? (
        <SeasonChart data={season} showFin={showFin} accent="var(--accent)" />
      ) : (
        <div style={skeleton(200)} className="pulse-soft" />
      )}
    </Section>
  );

  return (
    <div className="fade-in">
      <style>{`
        .pp-head { display: grid; gap: 8px 16px; align-items: start;
          grid-template-columns: auto 1fr auto; grid-template-areas: "thumb main actions"; }
        .pp-thumb { grid-area: thumb; }
        .pp-main { grid-area: main; min-width: 0; }
        .pp-actions { grid-area: actions; display: flex; gap: 6px; }
        .pp-line1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pp-meta { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 12px; }
        .pp-mfr-link { display: inline-flex; align-items: center; gap: 5px; margin: 2px 0 0 -6px; padding: 1px 6px;
          background: none; border: 0; border-radius: 6px; cursor: pointer; font: inherit;
          font-size: 14px; font-weight: 600; color: var(--info); }
        .pp-mfr-name { border-bottom: 1px dashed color-mix(in oklch, var(--info) 55%, transparent); line-height: 1.25; }
        .pp-mfr-arrow { transition: transform .15s ease; }
        .pp-mfr-link:hover { background: var(--info-soft); }
        .pp-mfr-link:hover .pp-mfr-name { border-bottom-style: solid; }
        .pp-mfr-link:hover .pp-mfr-arrow { transform: translateX(2px); }
        .pp-mfr-link:focus-visible { outline: 2px solid var(--info); outline-offset: 1px; }
        .pp-tabs { scrollbar-width: none; }
        .pp-tabs::-webkit-scrollbar { display: none; }
        @media (max-width: 640px) {
          .pp-head { grid-template-columns: auto 1fr; grid-template-areas: "thumb actions" "main main"; gap: 8px 10px; }
          .pp-thumb > * { width: 64px !important; height: 64px !important; }
          .pp-line1 > *:not(.pp-sku) { font-size: 9.5px !important; }
        }
      `}</style>

      {pasekGorny}

      {/* ── Nagłówek (stały dla wszystkich zakładek) ── */}
      <div style={{ position: "relative", overflow: "hidden", background: "var(--bg-elevated)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md) var(--r-md) 0 0" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: statusDot }} />
        <div className="pp-head" style={{ padding: "16px 20px" }}>
          {product.photo_id && product.photo_hash ? (
            <div className="pp-thumb" style={{ display: "flex", flexShrink: 0 }}>
              <ProductThumb photoId={product.photo_id} photoHash={product.photo_hash} size={92} />
            </div>
          ) : <div className="pp-thumb" />}

          <div className="pp-main">
            <div className="pp-line1">
              <span className="mono pp-sku" style={{ fontSize: 20, fontWeight: 700, color: "var(--text-hi)", letterSpacing: "-0.01em" }}>{product.sku}</span>
              <StatusPillExt status={statusKey} size="md" />
              {product.is_favorite && <Pill bg="var(--accent-soft)" fg="var(--accent)" dot="var(--accent)" size="sm">OBSERWOWANY</Pill>}
              {product.is_sample && <SampleBadge size="sm" />}
              {product.is_new && <NewBadge until={product.new_until} size="sm" />}
              {product.no_reorder && <Pill bg="var(--info-soft)" fg="var(--info)" dot="var(--info)" size="sm">NIE ZAMAWIAMY</Pill>}
            </div>
            <div style={{ fontSize: 14, color: "var(--text-mid)", marginTop: 4 }}>{product.name}</div>
            <div className="pp-meta">
              {/* Producent jako POLE z etykietą, nie plakietka w rzędzie statusów —
                  jako chip wyglądał jak kolejny status i mało kto wiedział, że da się
                  go kliknąć. Tu wygląda jak link: ikona, kolor, podkreślenie, strzałka. */}
              <div>
                <div style={metaLabel}>Producent</div>
                {product.manufacturer_id && product.manufacturer_name ? (
                  <button
                    className="pp-mfr-link"
                    onClick={() => (onManufacturerClick
                      ? onManufacturerClick(product.manufacturer_name as string)
                      : setMfrModalId(product.manufacturer_id as number))}
                    title={`Otwórz kartę producenta: ${product.manufacturer_name}`}>
                    <span style={{ color: mfrColor, display: "flex" }}><I.Factory size={14} /></span>
                    <span className="pp-mfr-name">{product.manufacturer_name}</span>
                    <span className="pp-mfr-arrow" style={{ display: "flex" }}><I.ChevronR size={13} /></span>
                  </button>
                ) : (
                  <div className="num" style={{ fontSize: 14, fontWeight: 600, color: "var(--text-lo)", marginTop: 2 }}>—</div>
                )}
              </div>
              <Meta label="Stan dostępny" value={`${fmtNum(product.stock)} szt`} />
              <Meta label="Koszt netto / szt" value={showPrice ? fmtPLN(product.purchase_price) : "•••••"} />
              <Meta label="EAN" value={product.ean || "—"} mono />
            </div>
          </div>

          <div className="pp-actions">
            {canEditProducts && (
              <button onClick={toggleFav} style={iconBtnHeader} title={product.is_favorite ? "Usuń z obserwowanych" : "Obserwuj"}>
                {product.is_favorite ? <I.StarFill size={16} /> : <I.Star size={16} />}
              </button>
            )}
            {canEditProducts && (
              <button onClick={toggleNoReorder}
                style={product.no_reorder ? { ...iconBtnHeader, background: "var(--info-soft)", color: "var(--info)" } : iconBtnHeader}
                title={product.no_reorder ? "Przywróć do zamawiania (pokaż w pożarach)" : "Nie dozamawiamy — ukryj z pożarów i zamawiania"}>
                <I.Flame size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Zakładki ── */}
      {/* overflowX: auto zostaje (na telefonie zakładki przewijają się w bok),
          ale pionowo nic nie może wystawać — inaczej przeglądarka dokłada
          zbędny pionowy suwak. Stąd overflowY: hidden i brak ujemnego marginesu. */}
      <div role="tablist" className="pp-tabs" style={{ display: "flex", gap: 2, padding: "0 12px", overflowX: "auto", overflowY: "hidden", background: "var(--bg-elevated)", border: "1px solid var(--border-soft)", borderTop: 0, borderRadius: "0 0 var(--r-md) var(--r-md)" }}>
        {tabs.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            style={{
              background: "none", border: 0, padding: "12px 14px 11px",
              color: tab === k ? "var(--text-hi)" : "var(--text-lo)",
              fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", cursor: "pointer",
              borderBottom: `2px solid ${tab === k ? "var(--accent)" : "transparent"}`,
            }}>{TAB_LABELS[k]}</button>
        ))}
      </div>

      {brakWFirmie && (
        <div style={{ marginTop: 14, padding: "9px 12px", borderRadius: "var(--r-sm)", background: "var(--warning-soft)", color: "var(--warning)", fontSize: 12 }}>
          Tego SKU nie ma w wybranej firmie — pokazuję liczby z poprzedniej.
        </div>
      )}

      {/* ── Treść ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 22, paddingTop: 20 }}>
        {tab === "logistyka" && (
          <>
            <LogistykaKpi product={product} showFin={showFin} />
            <Section
              title={`Prognoza stanu — ${HORYZONT_DNI} dni`}
              hint={proj ? `${proj.deliveries.length} planowanych dostaw · sprzedaż ${Math.round(product.avg_monthly_weighted)}/mies` : "ładowanie…"}>
              {proj ? <StockProjectionChart projection={proj} product={product} /> : <div style={skeleton(200)} className="pulse-soft" />}
            </Section>
            <ContainersSection product={product} onContainerClick={onContainerClick} onClose={() => { /* karta nie jest oknem — nie ma czego zamykać */ }} />
          </>
        )}

        {tab === "sprzedaz" && salesAllowed && (
          <ProductSalesTab
            sku={product.sku}
            shop={shop}
            transit={product.stock_in_transit || 0}
            leadTime={product.lead_time_days ?? null}
            sezon={sezonBlok}
          />
        )}

        {tab === "historia" && historyAllowed && hasHistory && (
          <LifecycleTabV2 sku={product.sku} shop={shop} showFin={showFin} />
        )}

        {tab === "dane" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
              <AttributesCard product={product} manufacturers={manufacturers} firmy={firmy} editing={editingAttrs} setEditing={setEditingAttrs} onSaved={applyUpdate} onPhotosChanged={refreshProduct} />
              <DimensionsCard product={product} editing={editingLT} setEditing={setEditingLT} onSaved={applyUpdate} />
            </div>
            {delChk && (
              <DeleteZone
                check={delChk}
                onContainerClick={onContainerClick}
                onClose={() => { /* jw. */ }}
                onDeleted={onDeleted}
              />
            )}
          </>
        )}
      </div>

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

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)" }}>{label}</div>
      <div className={mono ? "mono" : "num"} style={{ fontSize: 14, fontWeight: 600, color: "var(--text-hi)", marginTop: 2 }}>{value}</div>
    </div>
  );
}

// Etykieta pola w wierszu danych — ta sama co w <Meta>, żeby „Producent" stał w szeregu.
const metaLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)",
};

const skeleton = (h: number): React.CSSProperties => ({
  height: h, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10,
});

const backBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  background: "var(--surface-1)", border: "1px solid var(--border-soft)", color: "var(--text-mid)",
  font: "inherit", fontSize: 12.5, padding: "6px 12px", borderRadius: "var(--r-sm)", cursor: "pointer",
};
