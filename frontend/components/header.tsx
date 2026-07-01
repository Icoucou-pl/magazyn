"use client";
// ============================================================
// MAGAZYN — Sidebar (lewe pionowe menu) + Topbar (search z lewej + akcje).
//   - układ: logo + nawigacja w lewym sidebarze (góra→dół), pasek narzędzi na górze
//   - nawigacja gate'owana can(user, perm) z lib/permissions
//   - Sun/Moon → onToggleTheme (shell zmienia t.theme)
//   - menu usera: Zmień hasło / Dziennik audytu (super) / Wyloguj
//   - mobile: sidebar chowany, hamburger w Topbarze otwiera drawer
//   - logo z /public/assets (logo-white.png / logo-black.png)
// ============================================================

import React, { useEffect, useState } from "react";
import { I, Avatar, Pill, type IconProps } from "./ui";
import { can } from "@/lib/permissions";

export type User = {
  id?: number | string;
  email: string;
  name?: string;
  initials?: string;
  role: string; // 'ADMIN' | 'IMPORT' | 'VIEWER'
  isSuper?: boolean;
  perms?: Record<string, boolean>;
};

type IconCmp = (props: IconProps) => React.ReactElement;

type NavItem = { id: string; label: string; icon: IconCmp; perm?: string };

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard",  label: "Dashboard",  icon: I.Dashboard },
  { id: "calendar",   label: "Kalendarz",  icon: I.Calendar },
  { id: "products",   label: "Produkty",   icon: I.Box },
  { id: "containers", label: "Kontenery",  icon: I.Ship },
  { id: "forecast",   label: "Prognoza",   icon: I.Activity, perm: "viewForecast" },
  { id: "finance",    label: "Finanse",    icon: I.TrendUp, perm: "viewFinancials" },
  { id: "cashflow",   label: "Cashflow",   icon: I.Wallet, perm: "viewFinancials" },
];

export const SIDEBAR_WIDTH = 224;

const iconBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 34, height: 34,
  background: "var(--surface-1)",
  border: "1px solid var(--border-soft)",
  borderRadius: 8,
  color: "var(--text-mid)",
  transition: "all 0.12s",
};

// Surowy stempel (czas warszawski, naive) → "DD.MM HH:MM". Bez konwersji stref.
function fmtFresh(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Logo (współdzielone) ─────────────────────────────────────
function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/assets/logo-white.png" alt="i-coucou" className="brand-logo brand-logo-dark" style={{ height: 26, width: "auto", display: "block" }}/>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/assets/logo-black.png" alt="i-coucou" className="brand-logo brand-logo-light" style={{ height: 26, width: "auto", display: "none" }}/>
      <span className="mono" style={{ fontSize: 9, color: "var(--text-lo)", letterSpacing: "0.1em", paddingLeft: 12, borderLeft: "1px solid var(--border)" }}>
        MAGAZYN
      </span>
    </div>
  );
}

// ── Sidebar (lewe pionowe menu) — desktop ────────────────────
export function Sidebar({
  view, setView, user,
}: {
  view: string; setView: (v: string) => void; user: User;
}) {
  const navItems = NAV_ITEMS.filter((item) => !item.perm || can(user, item.perm));
  return (
    <aside className="app-sidebar hide-mobile" style={{
      position: "sticky", top: 0, alignSelf: "flex-start",
      width: SIDEBAR_WIDTH, flexShrink: 0,
      height: "100dvh",
      display: "flex", flexDirection: "column",
      gap: 4,
      padding: "16px 12px",
      background: "var(--surface-1)",
      borderRight: "1px solid var(--border-soft)",
    }}>
      <div style={{ padding: "6px 8px 14px" }}>
        <Brand/>
      </div>
      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {navItems.map((item) => (
          <NavBtn key={item.id} item={item} active={view === item.id} onClick={() => setView(item.id)}/>
        ))}
      </nav>
    </aside>
  );
}

type TopbarProps = {
  view: string;
  setView: (v: string) => void;
  user: User;
  theme: string;
  onToggleTheme: () => void;
  onLogout: () => void;
  onOpenSearch?: () => void;
  onOpenScan?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  freshness?: { sellasist?: { last: string | null }; subiekt?: { last: string | null } } | null;
  onChangePassword?: () => void;
  onAuditLog?: () => void;
};

// ── Topbar (search z lewej + świeżość + akcje) ───────────────
export function Topbar({
  view, setView, user, theme, onToggleTheme, onLogout,
  onOpenSearch, onOpenScan, onRefresh, refreshing, freshness, onChangePassword, onAuditLog,
}: TopbarProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Zamknij menu usera po kliknięciu poza nim
  useEffect(() => {
    if (!userMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-user-menu]")) setUserMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [userMenuOpen]);

  const navItems = NAV_ITEMS.filter((item) => !item.perm || can(user, item.perm));
  const displayName = user.name || user.email;
  const initials = user.initials || displayName.slice(0, 2).toUpperCase();

  return (
    <>
      <header style={{
        position: "sticky", top: 0, zIndex: 40,
        background: "color-mix(in oklch, var(--bg) 80%, transparent)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--border-soft)",
      }}>
        <div style={{
          padding: "10px 24px",
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          {/* Wiersz 1: hamburger/logo (mobile) + search z lewej + akcje z prawej */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Hamburger + logo — tylko mobile (sidebar schowany) */}
            <button onClick={() => setMobileNavOpen(!mobileNavOpen)} className="show-mobile" style={iconBtn} title="Menu">
              <I.Menu size={18}/>
            </button>
            <div className="show-mobile"><Brand/></div>

            {/* Search — z LEWEJ (desktop pełny pasek, mobile ikona) */}
            <button onClick={onOpenSearch} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 12px",
              background: "var(--surface-1)",
              border: "1px solid var(--border-soft)",
              borderRadius: 8,
              color: "var(--text-lo)",
              fontSize: 12,
              width: "100%", maxWidth: 380,
              transition: "all 0.12s",
            }} className="hide-mobile search-bar-btn">
              <I.Search size={14}/>
              <span style={{ flex: 1, textAlign: "left" }}>Szukaj wszędzie...</span>
              <kbd>Ctrl+K</kbd>
            </button>
            <button onClick={onOpenSearch} className="show-mobile" style={iconBtn} title="Szukaj wszędzie">
              <I.Search size={16}/>
            </button>

            {/* Spacer — dosuwa akcje do prawej */}
            <div style={{ flex: 1 }}/>

            {/* Akcje */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <button onClick={onOpenScan} style={iconBtn} title="Skanuj EAN/SKU">
                <I.Scan size={16}/>
              </button>
              <button onClick={onToggleTheme} style={iconBtn} title={theme === "light" ? "Tryb ciemny" : "Tryb jasny"}>
                {theme === "light" ? <I.Moon size={16}/> : <I.Sun size={16}/>}
              </button>
              <button
                onClick={onRefresh}
                disabled={refreshing}
                style={{ ...iconBtn, cursor: refreshing ? "default" : "pointer", opacity: refreshing ? 0.7 : 1 }}
                title={refreshing ? "Odświeżanie danych Sellasista…" : "Odśwież dane Sellasista"}
              >
                <span className={refreshing ? "magazyn-spin" : ""} style={{ display: "inline-flex" }}>
                  <I.Refresh size={16}/>
                </span>
              </button>
              <button
                onClick={() => setView("settings")}
                style={{
                  ...iconBtn,
                  ...(view === "settings"
                    ? { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text-hi)" }
                    : {}),
                }}
                title="Ustawienia"
              >
                <I.Settings size={16}/>
              </button>

              {/* User menu */}
              <div data-user-menu style={{ position: "relative" }}>
                <button onClick={() => setUserMenuOpen(!userMenuOpen)} title={displayName} style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: 0, marginLeft: 4,
                  background: "transparent", border: "none", borderRadius: 999,
                  cursor: "pointer",
                }}>
                  <Avatar initials={initials} size={32}/>
                </button>
                {userMenuOpen && (
                  <UserMenuPopover
                    user={user} initials={initials} displayName={displayName}
                    onLogout={onLogout} onChangePassword={onChangePassword} onAuditLog={onAuditLog}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Wiersz 2: świeżość danych (osobny wiersz — nie nachodzi na ikony przy wąskim ekranie) */}
          <div className="freshness-row" style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end",
            flexWrap: "wrap", gap: 2, rowGap: 2, columnGap: 10,
            fontSize: 11, color: "var(--text-lo)",
          }}>
            <span style={{ whiteSpace: "nowrap" }}>Ostatnie pobranie Sellasist:{" "}
              <b style={{ color: "var(--text-mid)", fontWeight: 600 }}>
                {refreshing ? "pobieranie…" : fmtFresh(freshness?.sellasist?.last)}
              </b>
            </span>
            <span style={{ opacity: 0.45 }} className="hide-mobile">·</span>
            <span style={{ whiteSpace: "nowrap" }}>Ostatnie pobranie Subiekt:{" "}
              <b style={{ color: "var(--text-mid)", fontWeight: 600 }}>
                {fmtFresh(freshness?.subiekt?.last)}
              </b>
            </span>
          </div>
        </div>

        {/* Mobile nav drawer */}
        {mobileNavOpen && (
          <div className="show-mobile" style={{
            borderTop: "1px solid var(--border-soft)",
            padding: 8,
            display: "flex", flexDirection: "column", gap: 2,
            background: "var(--bg-elevated)",
          }}>
            {navItems.map((item) => (
              <button key={item.id} onClick={() => { setView(item.id); setMobileNavOpen(false); }} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 12px",
                background: view === item.id ? "var(--accent-soft)" : "transparent",
                color: view === item.id ? "var(--accent)" : "var(--text-hi)",
                border: "none", borderRadius: 8,
                fontSize: 13, fontWeight: 500,
                textAlign: "left", width: "100%",
              }}>
                <item.icon size={16}/>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <style>{`
        @media (max-width: 980px) {
          .hide-mobile { display: none !important; }
          .app-sidebar { display: none !important; }
        }
        @media (min-width: 981px) {
          .show-mobile { display: none !important; }
        }
        @media (max-width: 760px) {
          .hide-tablet { display: none !important; }
        }
        .search-bar-btn:hover { background: var(--surface-2); border-color: var(--border); color: var(--text-mid); }
        @keyframes magazyn-spin { to { transform: rotate(360deg); } }
        .magazyn-spin { animation: magazyn-spin 0.8s linear infinite; }
      `}</style>
    </>
  );
}

// ── Pozycja nawigacji (pionowa, pełna szerokość) ─────────────
function NavBtn({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 11,
      width: "100%",
      padding: "9px 12px",
      background: active ? "var(--surface-3)" : "transparent",
      color: active ? "var(--text-hi)" : "var(--text-mid)",
      border: "none",
      borderRadius: 8,
      fontSize: 13, fontWeight: 500,
      textAlign: "left",
      transition: "all 0.12s",
      position: "relative",
    }}
      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.color = "var(--text-hi)"; e.currentTarget.style.background = "var(--surface-2)"; } }}
      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.color = "var(--text-mid)"; e.currentTarget.style.background = "transparent"; } }}>
      {active && <span style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderRadius: 99, background: "var(--accent)" }}/>}
      <item.icon size={16}/>
      {item.label}
    </button>
  );
}

function UserMenuPopover({
  user, initials, displayName, onLogout, onChangePassword, onAuditLog,
}: {
  user: User;
  initials: string;
  displayName: string;
  onLogout: () => void;
  onChangePassword?: () => void;
  onAuditLog?: () => void;
}) {
  const isSuper = !!user.isSuper;
  return (
    <div style={{
      position: "absolute", right: 0, top: "calc(100% + 8px)",
      width: 260,
      background: "var(--bg-elevated)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: 6,
      boxShadow: "0 16px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)",
      zIndex: 50,
    }} className="fade-in">
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 10px 12px", borderBottom: "1px solid var(--border-soft)" }}>
        <Avatar initials={initials} size={36}/>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{displayName}</div>
          <div style={{ fontSize: 11, color: "var(--text-lo)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
        </div>
      </div>
      <div style={{ padding: "8px 10px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Rola</span>
        <Pill bg="var(--accent-soft)" fg="var(--accent)" size="sm">{user.role}</Pill>
      </div>
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column" }}>
        <MenuItem onClick={onChangePassword}>Zmień hasło</MenuItem>
        {isSuper && onAuditLog && <MenuItem onClick={onAuditLog}>Dziennik audytu</MenuItem>}
        <div style={{ height: 1, background: "var(--border-soft)", margin: "4px 0" }}/>
        <MenuItem danger icon={<I.Logout size={13}/>} onClick={onLogout}>Wyloguj</MenuItem>
      </div>
    </div>
  );
}

function MenuItem({
  children, danger, icon, onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  icon?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "8px 10px",
      background: "transparent", border: "none",
      color: danger ? "var(--critical)" : "var(--text-mid)",
      fontSize: 12, textAlign: "left",
      borderRadius: 6,
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      {icon}{children}
    </button>
  );
}

// Zgodność wsteczna: domyślny eksport = Topbar (gdyby ktoś importował `Header`).
export default Topbar;
