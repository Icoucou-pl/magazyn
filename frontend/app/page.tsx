"use client";
// ============================================================
// MAGAZYN — App shell (app/page.tsx). Zastępuje mockowy App z app.jsx.
//   - auth gate przez getUser()/logout() z lib/api; nasłuch 'magazyn:unauthorized'
//   - UserContext.Provider (lib/permissions) — widoki czytają usera/uprawnienia
//   - motyw: useTweaks + applyTweaks; Sun/Moon w headerze ↔ AppearancePanel (sync przez wspólny stan)
//   - density → padding main (prop poleci do widoków w kolejnych etapach)
//   - Ctrl+K / przycisk Szukaj → globalna wyszukiwarka (CommandPalette)
// ============================================================

import React, { useEffect, useState } from "react";
import { getUser, logout, api } from "@/lib/api";
import { UserContext as RawUserContext, canEdit } from "@/lib/permissions";
import LoginScreen from "@/components/login";
import { Sidebar, Topbar, NAV_ITEMS, type User } from "@/components/header";
import Dashboard from "@/components/dashboard";
import ProductsView from "@/components/products";
import ContainersView from "@/components/containers";
import Calendar from "@/components/calendar";
import CashflowView from "@/components/cashflow";
import ForecastView from "@/components/forecast";
import FinanceView from "@/components/finance";
import SettingsView from "@/components/settings";
import CommandPalette from "@/components/command-palette";
import EanScanner from "@/components/ean-scanner";
import Assistant from "@/components/assistant";
import Onboarding from "@/components/onboarding";
import { ToastHost, toast } from "@/components/toast";
import { I } from "@/components/ui";
import { SimulatorModal } from "@/components/simulator";
import type { Product } from "@/components/products-ui";
import {
  AppearancePanel, useTweaks, applyTweaks, TWEAK_DEFAULTS, type TweakValues,
} from "@/components/tweaks-panel";

// lib/permissions.js jest w JS (createContext(null)) — dotypowujemy kontekst pod User.
const UserContext = RawUserContext as unknown as React.Context<User | null>;

function ComingSoon({ view }: { view: string }) {
  const meta = NAV_ITEMS.find((n) => n.id === view);
  return (
    <div className="fade-in" style={{
      padding: 60, textAlign: "center",
      background: "var(--surface-1)",
      border: "1px dashed var(--border)",
      borderRadius: "var(--r-lg)",
    }}>
      <div style={{
        width: 56, height: 56, margin: "0 auto 16px",
        borderRadius: 14,
        background: "var(--accent-soft)",
        color: "var(--accent)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>{meta && <meta.icon size={24}/>}</div>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{meta?.label}</h2>
      <p style={{ color: "var(--text-lo)", fontSize: 13, marginTop: 6 }}>
        Ten widok zostanie zaprojektowany w kolejnym etapie.
      </p>
    </div>
  );
}

function ReadOnlyBanner() {
  return (
    <div style={{
      background: "color-mix(in oklch, var(--warning) 12%, var(--bg))",
      borderBottom: "1px solid color-mix(in oklch, var(--warning) 35%, var(--border))",
      padding: "7px 24px",
      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      fontSize: 11, color: "var(--warning)", fontWeight: 600,
      letterSpacing: "0.04em", textTransform: "uppercase",
    }}>
      <I.Alert size={12}/>
      Tryb tylko do odczytu — Twoja rola nie pozwala na zmiany
    </div>
  );
}

export default function Page() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState("dashboard");
  const [pendingProductSku, setPendingProductSku] = useState<string | null>(null);
  const [pendingContainerId, setPendingContainerId] = useState<number | null>(null);
  const [pendingAutoSuggestNew, setPendingAutoSuggestNew] = useState(false);
  const [pendingManufacturerId, setPendingManufacturerId] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);
  const [simProducts, setSimProducts] = useState<Product[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [freshness, setFreshness] = useState<{ sellasist?: { last: string | null }; subiekt?: { last: string | null } } | null>(null);
  const [t, setTweak] = useTweaks<TweakValues>(TWEAK_DEFAULTS, "magazyn_tweaks");

  // Motyw (akcent/warmth/theme/density) → na <html>
  useEffect(() => { applyTweaks(t); }, [t]);

  // Sesja z localStorage + nasłuch wygaśnięcia (401)
  useEffect(() => {
    setCurrentUser(getUser() as User | null);
    setReady(true);
    const onUnauth = () => { setCurrentUser(null); setView("dashboard"); };
    window.addEventListener("magazyn:unauthorized", onUnauth);
    return () => window.removeEventListener("magazyn:unauthorized", onUnauth);
  }, []);

  // Świeżość danych — ostatnie pobranie Sellasist/Subiekt (pasek pod menu).
  // Odświeżane na wejściu, co 5 min, oraz po ręcznym odświeżeniu Sellasista.
  const loadFreshness = async () => {
    try { setFreshness(await api.get("/data-freshness")); } catch { /* cicho */ }
  };
  useEffect(() => {
    if (!currentUser) return;
    loadFreshness();
    const id = window.setInterval(loadFreshness, 5 * 60 * 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // Onboarding — pokazujemy raz na użytkownika (flaga per-email w localStorage).
  useEffect(() => {
    if (!currentUser) { setShowOnboarding(false); return; }
    try {
      setShowOnboarding(!localStorage.getItem("magazyn_onboarded_" + currentUser.email));
    } catch {
      setShowOnboarding(false);
    }
  }, [currentUser]);

  // Ctrl+K — globalna wyszukiwarka
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Routing wyników wyszukiwarki (logika widoków siedzi tutaj)
  const goProduct = (sku: string) => { setPendingProductSku(sku); setView("products"); setSearchOpen(false); setScanOpen(false); };
  const goContainers = (id: number) => { setPendingContainerId(id); setView("containers"); setSearchOpen(false); };
  const goManufacturer = (id: number) => { setPendingManufacturerId(id); setView("settings"); setSearchOpen(false); };

  // Unikamy migotania ekranu logowania przy hydratacji (sesja czytana po montażu)
  if (!ready) return null;

  if (!currentUser) {
    return <LoginScreen onLogin={(u) => setCurrentUser(u)} />;
  }

  const handleLogout = () => {
    logout();
    setCurrentUser(null);
    setView("dashboard");
  };

  // Odśwież dane Sellasista — uruchamia bieg w tle (backend) i polluje status,
  // aż się skończy; wynik pokazuje w toaście. Ikona w headerze kręci się w tym czasie.
  const handleRefreshSellasist = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const start = await api.post("/sellasist/refresh");
      toast(
        start?.status === "already_running"
          ? "Odświeżanie Sellasista już trwa…"
          : "Pobieram dane z Sellasista…",
        "info",
      );
    } catch (e) {
      setRefreshing(false);
      toast(e instanceof Error ? e.message : "Nie udało się uruchomić odświeżania", "error");
      return;
    }

    const poll = async () => {
      try {
        const s = await api.get("/sellasist/status");
        if (s?.running) { window.setTimeout(poll, 2000); return; }
        setRefreshing(false);
        if (s?.error) {
          toast(`Błąd odświeżania Sellasista: ${s.error}`, "error", { duration: 0 });
        } else {
          toast(`Sellasist zaktualizowany — ${s?.message ?? "gotowe"}`, "ok", { duration: 0 });
          loadFreshness();
        }
      } catch {
        setRefreshing(false);
        toast("Nie udało się sprawdzić statusu odświeżania", "warning", { duration: 0 });
      }
    };
    window.setTimeout(poll, 1500);
  };

  // Symulator scenariuszy (dashboard → ActionsBanner). Modal otwiera się od razu,
  // a pełną listę produktów doładowujemy w tle (raz na sesję).
  const openSimulator = async () => {
    setShowSimulator(true);
    if (simProducts) return;
    try {
      const data = await api.get("/products?include=ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE");
      setSimProducts((data as Product[]) || []);
    } catch {
      toast("Nie udało się wczytać produktów do symulatora", "error");
      setShowSimulator(false);
    }
  };

  return (
    <UserContext.Provider value={currentUser}>
      <div style={{ display: "flex", alignItems: "flex-start", minHeight: "100dvh" }}>
        <Sidebar view={view} setView={setView} user={currentUser}/>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
          <Topbar
            view={view}
            setView={setView}
            user={currentUser}
            theme={t.theme}
            onToggleTheme={() => setTweak("theme", t.theme === "light" ? "dark" : "light")}
            onLogout={handleLogout}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenScan={() => setScanOpen(true)}
            onRefresh={handleRefreshSellasist}
            refreshing={refreshing}
            freshness={freshness}
            onChangePassword={() => setView("settings")}
          />

      {!canEdit(currentUser) && <ReadOnlyBanner/>}

      <main className="app-main" style={{
        width: "100%",
        padding: t.density === "compact" ? "16px 20px" : "24px 24px",
      }}>
        {view === "dashboard" ? (
          <Dashboard
            density={t.density}
            onProductClick={(p) => { setPendingProductSku(p.sku); setView("products"); }}
            onContainerClick={(c) => goContainers(c.id)}
            onAutoSuggest={() => { setPendingAutoSuggestNew(true); setView("containers"); }}
            onSimulator={openSimulator}
            onShowOrderPdf={() => toast("Generator PO — wkrótce (etap 6)", "info")}
          />
        ) : view === "products" ? (
          <ProductsView
            density={t.density}
            openSku={pendingProductSku}
            onOpenedSku={() => setPendingProductSku(null)}
          />
        ) : view === "containers" ? (
          <ContainersView
            density={t.density}
            openId={pendingContainerId}
            onOpenedId={() => setPendingContainerId(null)}
            openNewAutoSuggest={pendingAutoSuggestNew}
            onOpenedNewAutoSuggest={() => setPendingAutoSuggestNew(false)}
          />
        ) : view === "calendar" ? (
          <Calendar density={t.density} />
        ) : view === "cashflow" ? (
          <CashflowView onContainerClick={() => setView("containers")} />
        ) : view === "forecast" ? (
          <ForecastView
            density={t.density}
            onProductClick={(sku) => { setPendingProductSku(sku); setView("products"); }}
          />
        ) : view === "finance" ? (
          <FinanceView density={t.density} />
        ) : view === "settings" ? (
          <SettingsView
            initialSection={pendingManufacturerId != null ? "manufacturers" : undefined}
            openManufacturerId={pendingManufacturerId}
            onOpenedManufacturer={() => setPendingManufacturerId(null)}
          />
        ) : (
          <ComingSoon view={view} />
        )}
      </main>
        </div>
      </div>

      {/* Globalna wyszukiwarka (Ctrl+K / przycisk Szukaj w headerze) */}
      <CommandPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onProduct={goProduct}
        onContainer={goContainers}
        onManufacturer={goManufacturer}
      />

      {/* Symulator scenariuszy (odpalany z dashboardu) */}
      {showSimulator && (
        <SimulatorModal
          products={simProducts ?? []}
          loading={simProducts === null}
          onClose={() => setShowSimulator(false)}
          onProductClick={goProduct}
        />
      )}

      {/* Skaner EAN (przycisk skanu w headerze) */}
      <EanScanner
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onProduct={goProduct}
      />

      {/* Pływający panel wyglądu (⚙ w prawym dolnym rogu) — stan wspólny z headerem */}
      <AppearancePanel t={t} setTweak={setTweak}/>
      <Assistant/>

      {/* Wprowadzenie — pełnoekranowa nakładka przy pierwszym logowaniu (raz na użytkownika) */}
      {showOnboarding && (
        <Onboarding
          user={currentUser}
          theme={t.theme}
          onToggleTheme={() => setTweak("theme", t.theme === "light" ? "dark" : "light")}
          onDone={() => setShowOnboarding(false)}
        />
      )}

      <ToastHost/>
    </UserContext.Provider>
  );
}
