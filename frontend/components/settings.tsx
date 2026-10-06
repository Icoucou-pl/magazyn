"use client";
// ============================================================
// MAGAZYN — Ustawienia (rozbudowa). Port settings.jsx + users-panel.jsx → .tsx.
//   Producenci      GET/POST/PATCH/DELETE /manufacturers  (+ osoba kontaktowa, liczniki SKU/zamówień)
//   Typy kontenerów GET/POST/PATCH/DELETE /container-types
//   Użytkownicy     /users (ADMIN): lista wg ról, filtr/szukaj, zaznaczanie + zmiany masowe (POST /users/bulk),
//                   macierz uprawnień, inline rola, 4 ikony akcji, edytor uprawnień, reset hasła
//   Moje konto      profil + PUT /auth/me/password + aktywne sesje (/auth/me/sessions)
//   Dziennik audytu GET /audit-log (super-admin): zdania, filtry, zmiany było → jest, eksport CSV
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { I, Card, Pill, Avatar } from "./ui";
import { btnPrimary, btnSecondary } from "./products-ui";
import { api } from "@/lib/api";
import { toast, exportCsv, type CsvColumn } from "./toast";
import { fmtPLN } from "@/lib/format";
import { useUser, isAdmin, canEdit, can, PERMISSIONS, ROLE_PERMS } from "@/lib/permissions";
import UsagePanel from "./usage-panel";
import ManufacturerModal from "./manufacturer-modal";
// Firma aliasowana — w tym pliku niżej żyje własny, bogatszy typ Firma (panel Firmy).
import type { Product, Firma as PuFirma } from "./products-ui";
import type { Container } from "./containers-ui";

// ── Typy ─────────────────────────────────────────────────────
type Manufacturer = {
  id: number; name: string; color: string; notes?: string | null;
  email?: string | null; contact?: string | null; sku_count?: number; open_orders?: number;
  default_currency?: string | null;
};

// Waluty rozliczeń z producentem — te same co w kontenerach (CUR_OPTS w container-form).
const MFR_CURRENCIES: [string, string][] = [["", "— brak —"], ["USD", "USD $"], ["CNY", "CNY ¥"], ["PLN", "PLN zł"]];
type ContainerType = { id: number; name: string; capacity_cbm: number; sort_order: number };
type UserRowT = {
  id: number; email: string; full_name?: string | null; role: string;
  is_active: boolean; is_super_admin: boolean; created_at: string; last_login?: string | null;
  updated_at?: string | null; last_activity?: string | null;
  perms?: Record<string, boolean> | null; show_onboarding?: boolean;
  // Zakres firmowy: lista slugów z backendu. null/[] = wszystkie firmy.
  company_scope?: string[] | null;
};
type AuditChange = { pole: string; bylo: string; jest: string };
type AuditRow = {
  id: number; user_id?: number | null; user_email?: string | null;
  action: string; resource_type?: string | null; resource_id?: string | null;
  details?: string | null; created_at: string;
  message: string;            // gotowe zdanie z backendu
  changes: AuditChange[];     // było → jest
  area: string;               // obszar (filtr)
  legacy: boolean;            // wpis sprzed przebudowy dziennika
};
type SessionT = { id: number; device?: string | null; ip?: string | null; created_at: string; current: boolean };

type PermDef = { key: string; label: string; desc: string; group: string };
const PERMS = PERMISSIONS as unknown as PermDef[];

// Zakres firmowy (company_scope). Lista musi być zgodna z ALL_SHOPS w security.py
// i z SHOP_OPTIONS w lib/shop.tsx — te trzy miejsca opisują ten sam zbiór firm.
const SCOPE_FIRMY: { slug: string; label: string }[] = [
  { slug: "amh", label: "AMH" },
  { slug: "acti", label: "Acti" },
  { slug: "veluxa", label: "Veluxa" },
];
const ROLE_DEF = ROLE_PERMS as unknown as Record<string, Record<string, boolean>>;

type SectionId = "manufacturers" | "firmy" | "cn_sku" | "stawki_cla" | "container_types" | "users" | "account" | "audit" | "freshness" | "usage";
type SectionDef = { id: SectionId; label: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; desc: string };

type CtxUser = {
  id?: number | string; email?: string; name?: string; full_name?: string;
  role?: string; isSuper?: boolean; is_super_admin?: boolean;
} | null;

// ── Stałe ────────────────────────────────────────────────────
const SETTINGS_SECTIONS: SectionDef[] = [
  { id: "manufacturers",   label: "Producenci",      icon: I.Factory,  desc: "Dostawcy, kolory, kontakty" },
  { id: "firmy",            label: "Firmy",           icon: I.Cart,     desc: "Sklepy AMH/Acti/Veluxa, konfiguracja API" },
  { id: "container_types", label: "Typy kontenerów", icon: I.Ship,     desc: "Pojemność CBM, sortowanie" },
  { id: "cn_sku",          label: "Chińskie SKU",    icon: I.Scan,     desc: "Odpowiedniki SKU dla fabryk — pod zamówienia (PO)" },
  { id: "stawki_cla",      label: "Stawki cła",      icon: I.Customs,  desc: "Kod CN i stawka cła obserwowanych SKU, nowości i sampli — do kosztu jednostkowego" },
  { id: "users",           label: "Użytkownicy",     icon: I.Activity, desc: "Konta, role, uprawnienia" },
  { id: "account",         label: "Moje konto",      icon: I.Settings, desc: "Hasło, sesje" },
  { id: "audit",           label: "Dziennik audytu", icon: I.Bell,     desc: "Kto, co i kiedy zmienił w Magazynie" },
  { id: "freshness",       label: "Świeżość danych", icon: I.Refresh,  desc: "Ostatnie pobrania i dziennik synchronizacji" },
  { id: "usage",           label: "Zużycie API",     icon: I.Wallet,   desc: "Koszty asystenta AI — tokeny i saldo" },
];

const ROLE_META: Record<string, { label: string; color: string; soft: string }> = {
  ADMIN:  { label: "Admin",  color: "var(--accent)",   soft: "var(--accent-soft)" },
  IMPORT: { label: "Import", color: "var(--info)",     soft: "var(--info-soft)" },
  VIEWER: { label: "Viewer", color: "var(--text-mid)", soft: "var(--surface-3)" },
};

const COLOR_OPTIONS = [
  "oklch(0.70 0.16 25)", "oklch(0.74 0.15 90)", "oklch(0.68 0.14 240)", "oklch(0.72 0.14 150)",
  "oklch(0.70 0.16 305)", "oklch(0.72 0.16 200)", "oklch(0.70 0.16 50)", "oklch(0.68 0.16 340)",
];

const isSuperUser = (u: CtxUser) => Boolean(u?.isSuper ?? u?.is_super_admin);

const initialsOf = (name?: string | null, email?: string) => {
  const src = (name && name.trim()) || email || "";
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
};
// Parsuje znacznik czasu z backendu. Czas bez strefy traktujemy jako UTC
// (Postgres zapisuje CURRENT_TIMESTAMP w UTC bez offsetu), żeby toLocale* pokazało lokalnie.
const parseTs = (s?: string | null): Date | null => {
  if (!s) return null;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const iso = hasTz ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};
const fmtDate = (s?: string | null) => {
  const d = parseTs(s);
  return d ? d.toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" }) : "—";
};
const fmtDateTime = (s?: string | null) => {
  const d = parseTs(s);
  return d ? d.toLocaleString("pl-PL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
};
// Stemple świeżości danych są zapisywane czasem LOKALNYM (Warszawa) — formatujemy
// je surowo, BEZ doliczania strefy (inaczej niż fmtDateTime zakładający UTC z backendu).
const fmtLocalDt = (s?: string | null) => {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("pl-PL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

// Parsuje User-Agent → „Chrome · macOS"
const parseDevice = (ua?: string | null) => {
  if (!ua) return "Nieznane urządzenie";
  let browser = "Przeglądarka";
  if (/edg/i.test(ua)) browser = "Edge";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";
  let os = "";
  if (/iphone|ipad|ios/i.test(ua)) os = "iOS";
  else if (/android/i.test(ua)) os = "Android";
  else if (/mac os x|macintosh/i.test(ua)) os = "macOS";
  else if (/windows/i.test(ua)) os = "Windows";
  else if (/linux/i.test(ua)) os = "Linux";
  return os ? `${browser} · ${os}` : browser;
};

// ── Widok główny ─────────────────────────────────────────────
function SettingsView({ initialSection, openManufacturerId, onOpenedManufacturer }: {
  initialSection?: SectionId;
  openManufacturerId?: number | null;
  onOpenedManufacturer?: () => void;
  onProductClick?: (sku: string) => void;
} = {}) {
  const user = useUser() as CtxUser;
  const admin = isAdmin(user);
  const superUser = isSuperUser(user);

  const visibleSections = SETTINGS_SECTIONS.filter(s => {
    if (s.id === "users") return admin;
    if (s.id === "audit") return superUser;
    if (s.id === "usage") return admin || superUser;
    if (s.id === "cn_sku") return can(user, "generatePO");
    if (s.id === "stawki_cla") return can(user, "editProducts") || superUser;
    return true;
  });
  const [section, setSection] = useState<SectionId>(
    initialSection && visibleSections.some(s => s.id === initialSection)
      ? initialSection
      : (visibleSections[0]?.id || "account")
  );

  // Deep-link producenta z wyszukiwarki: gdy przyjdzie id, przełącz na panel producentów
  useEffect(() => {
    if (openManufacturerId != null) setSection("manufacturers");
  }, [openManufacturerId]);

  const activeSection = SETTINGS_SECTIONS.find(s => s.id === section);

  return (
    <div className="fade-in" style={{ paddingBottom: 80 }}>
      <div className="settings-layout" style={{ display: "grid", gridTemplateColumns: "240px minmax(0, 1fr)", gap: 14 }}>
        <aside className="settings-sidebar" style={{
          background: "var(--surface-1)", border: "1px solid var(--border-soft)",
          borderRadius: "var(--r-lg)", padding: 6, height: "fit-content", position: "sticky", top: 76,
        }}>
          {visibleSections.map(s => {
            const active = section === s.id;
            const Icon = s.icon;
            return (
              <button key={s.id} onClick={() => setSection(s.id)} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                background: active ? "var(--surface-3)" : "transparent",
                color: active ? "var(--text-hi)" : "var(--text-mid)",
                border: "none", borderRadius: 8, fontSize: 13, fontWeight: active ? 600 : 500,
                textAlign: "left", position: "relative", transition: "all 0.12s",
              }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--surface-2)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                <Icon size={15}/>
                <span style={{ flex: 1, minWidth: 0 }}>{s.label}</span>
                {active && <span style={{ position: "absolute", left: -1, top: 8, bottom: 8, width: 3, background: "var(--accent)", borderRadius: 99 }}/>}
              </button>
            );
          })}
        </aside>

        <main style={{ minWidth: 0 }}>
          {activeSection && (
            <div style={{ marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--border-soft)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <activeSection.icon size={18} style={{ color: "var(--text-mid)" }}/>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>{activeSection.label}</h2>
              </div>
              <p style={{ margin: "4px 0 0 28px", fontSize: 12, color: "var(--text-lo)" }}>{activeSection.desc}</p>
            </div>
          )}
          {section === "manufacturers"   && <ManufacturersPanel openId={openManufacturerId} onOpened={onOpenedManufacturer}/>}
          {section === "firmy"           && <FirmaePanel/>}
          {section === "container_types" && <ContainerTypesPanel/>}
          {section === "cn_sku"          && <CnSkuPanel/>}
          {section === "stawki_cla"      && <StawkiClaPanel/>}
          {section === "users"           && <UsersPanel currentUserId={user?.id}/>}
          {section === "account"         && <AccountPanel/>}
          {section === "audit"           && <AuditLogPanel/>}
          {section === "freshness"       && <FreshnessPanel/>}
          {section === "usage"           && <UsagePanel/>}
        </main>
      </div>

      <style>{`
        @media (max-width: 880px) {
          .settings-layout { grid-template-columns: 1fr !important; }
          .settings-sidebar {
            position: relative !important; top: 0 !important;
            display: flex !important; flex-wrap: wrap; overflow: visible !important;
            padding: 4px !important; gap: 6px;
          }
          .settings-sidebar > button { width: auto !important; flex: 0 0 auto; }
        }
      `}</style>
    </div>
  );
}

// ── Toggle (przełącznik iOS-style) ───────────────────────────
function Toggle({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button onClick={() => !disabled && onClick?.()} disabled={disabled} style={{
      width: 36, height: 20, borderRadius: 99, padding: 2, flexShrink: 0,
      background: on ? "var(--accent)" : "var(--surface-3)",
      border: "none", cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1, transition: "background 0.16s",
    }}>
      <span style={{
        display: "block", width: 16, height: 16, borderRadius: 99, background: "white",
        transform: on ? "translateX(16px)" : "translateX(0)", transition: "transform 0.16s",
      }}/>
    </button>
  );
}

// ============================================================
// PRODUCENCI
// ============================================================
function ManufacturersPanel({ openId, onOpened }: { openId?: number | null; onOpened?: () => void } = {}) {
  const user = useUser() as CtxUser;
  const showEdit = canEdit(user);
  const [items, setItems] = useState<Manufacturer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  // Modal „Szczegóły producenta" — ten sam komponent co w Prognozie.
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailProducts, setDetailProducts] = useState<Product[] | null>(null);
  const [detailContainers, setDetailContainers] = useState<Container[] | null>(null);
  const [detailFirmy, setDetailFirmy] = useState<PuFirma[] | null>(null);

  const load = async () => {
    try {
      const data = await api.get("/manufacturers");
      setItems(Array.isArray(data) ? (data as Manufacturer[]) : []);
    } catch { toast("Nie udało się pobrać producentów", "error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Deep-link z wyszukiwarki: po wczytaniu listy otwórz edycję wskazanego producenta
  useEffect(() => {
    if (openId == null || !items.length) return;
    if (items.some((m) => m.id === openId)) {
      setEditingId(openId);
      onOpened?.();
    }
  }, [openId, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Produkty i kontenery ciągniemy dopiero, gdy ktoś realnie otworzy szczegóły — to dwa
  // ciężkie zapytania, a panel Producentów sam z siebie ich nie potrzebuje. Raz pobrane
  // zostają w stanie, więc kolejne kliknięcia otwierają modal od razu.
  useEffect(() => {
    if (detailId == null || detailProducts) return;
    Promise.allSettled([
      // SAMPLE — pod zakładkę „Sample" w modalu szczegółów producenta.
      api.get("/products?include=ACTIVE,ACTIVE_NO_STOCK,DEAD_STOCK,INACTIVE,SAMPLE"),
      api.get("/containers"),
      // Firmy — pod select w karcie produktu, którą modal producenta otwiera u siebie.
      api.get("/firmy"),
    ]).then(([prod, cont, fir]) => {
      setDetailProducts(prod.status === "fulfilled" ? ((prod.value as Product[]) || []) : []);
      setDetailContainers(cont.status === "fulfilled" ? ((cont.value as Container[]) || []) : []);
      setDetailFirmy(fir.status === "fulfilled" ? ((fir.value as PuFirma[]) || []) : []);
      if (prod.status !== "fulfilled") toast("Nie udało się wczytać produktów producenta", "warning");
    });
  }, [detailId, detailProducts]);

  // Karta kontenera otwarta w szczegółach producenta może go zapisać albo skasować —
  // lokalna lista jest ciągnięta raz i sama się o tym nie dowie.
  const reloadDetailContainers = () => {
    api.get("/containers")
      .then((d) => setDetailContainers((d as Container[]) || []))
      .catch(() => toast("Nie udało się odświeżyć kontenerów", "warning"));
  };

  const totalSku = items.reduce((s, m) => s + (m.sku_count || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{items.length}</span> producentów ·
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}> {totalSku}</span> SKU
        </span>
        {showEdit && <button onClick={() => setCreating(true)} style={btnPrimary}><I.Plus size={12}/> Dodaj producenta</button>}
      </div>

      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
        {creating && (
          <ManufacturerRow item={null} editing isLast onSaved={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)}/>
        )}
        {loading && !items.length ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
        ) : (!items.length && !creating) ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Brak producentów</div>
        ) : items.map((m, i) => (
          <ManufacturerRow key={m.id} item={m}
            editing={editingId === m.id} isLast={i === items.length - 1}
            onEdit={() => setEditingId(m.id)}
            onDetails={() => setDetailId(m.id)}
            onSaved={() => { setEditingId(null); load(); }}
            onCancel={() => setEditingId(null)} showEdit={showEdit}/>
        ))}
      </div>

      {detailId != null && (
        detailProducts && detailContainers ? (
          <ManufacturerModal
            mfr={items.find((m) => m.id === detailId) || null}
            products={detailProducts.filter((p) => p.manufacturer_id === detailId)}
            containers={detailContainers}
            manufacturers={items}
            firmy={detailFirmy || undefined}
            allProducts={detailProducts}
            showFin={can(user, "viewFinancials")}
            onClose={() => setDetailId(null)}
            onContainersChanged={reloadDetailContainers}
          />
        ) : (
          <div onClick={() => setDetailId(null)} style={{
            position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.4)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "white", fontSize: 13,
          }}>Ładowanie szczegółów…</div>
        )
      )}
    </div>
  );
}

function ManufacturerRow({ item, editing, isLast, onEdit, onDetails, onSaved, onCancel, showEdit }: {
  item: Manufacturer | null; editing: boolean; isLast: boolean;
  onEdit?: () => void; onDetails?: () => void; onSaved: () => void; onCancel: () => void; showEdit?: boolean;
}) {
  const [name, setName] = useState(item?.name || "");
  const [color, setColor] = useState(item?.color || COLOR_OPTIONS[0]);
  const [email, setEmail] = useState(item?.email || "");
  const [contact, setContact] = useState(item?.contact || "");
  const [notes, setNotes] = useState(item?.notes || "");
  const [defaultCurrency, setDefaultCurrency] = useState(item?.default_currency || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) { toast("Podaj nazwę producenta", "warning"); return; }
    setBusy(true);
    try {
      const body = { name: name.trim(), color, email: email.trim() || null, contact: contact.trim() || null, notes: notes.trim() || null, default_currency: defaultCurrency || null };
      if (item) await api.patch(`/manufacturers/${item.id}`, body);
      else await api.post("/manufacturers", body);
      toast(item ? "Zapisano producenta" : "Dodano producenta", "ok");
      onSaved();
    } catch { toast("Nie udało się zapisać", "error"); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!item) return;
    if (!window.confirm(`Usunąć producenta „${item.name}"?`)) return;
    setBusy(true);
    try { await api.del(`/manufacturers/${item.id}`); toast("Usunięto producenta", "ok"); onSaved(); }
    catch { toast("Nie udało się usunąć (mogą istnieć powiązane kontenery)", "error"); }
    finally { setBusy(false); }
  };

  if (editing) {
    return (
      <div style={{ padding: 16, background: "var(--surface-2)", borderBottom: isLast ? "none" : "1px solid var(--border-soft)", borderLeft: "3px solid var(--accent)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <SettingsField label="Nazwa firmy">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="np. Tianjin Furniture" style={inputStyle}/>
          </SettingsField>
          <SettingsField label="Osoba kontaktowa">
            <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="np. Liu Wei" style={inputStyle}/>
          </SettingsField>
          <SettingsField label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="orders@example.com" style={inputStyle}/>
          </SettingsField>
          <SettingsField label="Kolor identyfikacyjny">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {COLOR_OPTIONS.map(c => (
                <button key={c} onClick={() => setColor(c)} style={{
                  width: 24, height: 24, borderRadius: 6, background: c,
                  border: color === c ? "2px solid var(--text-hi)" : "2px solid transparent",
                  cursor: "pointer", padding: 0, boxShadow: color === c ? "0 0 0 2px var(--surface-2)" : "none",
                }}/>
              ))}
            </div>
          </SettingsField>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
          <SettingsField label="Notatki">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="np. LT 90 dni, MOQ 50 szt" style={inputStyle}/>
          </SettingsField>
          <SettingsField label="Domyślna waluta">
            <select value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value)} style={inputStyle}>
              {MFR_CURRENCIES.map(([v, l]) => <option key={v || "none"} value={v}>{l}</option>)}
            </select>
          </SettingsField>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
          {item ? <button onClick={remove} disabled={busy} style={{ ...btnGhost, color: "var(--critical)" }}>Usuń producenta</button> : <span/>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onCancel} disabled={busy} style={btnSecondary}>Anuluj</button>
            <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "Zapisywanie…" : "Zapisz"}</button>
          </div>
        </div>
      </div>
    );
  }

  if (!item) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: isLast ? "none" : "1px solid var(--border-soft)", transition: "background 0.12s" }}
      onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-2)"}
      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
      <div style={{
        width: 36, height: 36, borderRadius: 8,
        background: "color-mix(in oklch, " + item.color + " 20%, var(--bg))",
        border: `1px solid ${item.color}`, display: "flex", alignItems: "center", justifyContent: "center", color: item.color, flexShrink: 0,
      }}>
        <I.Factory size={16}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{item.name}</span>
          {(item.open_orders || 0) > 0 && (
            <Pill bg="var(--info-soft)" fg="var(--info)" size="sm"><span className="num">{item.open_orders}</span> aktywnych</Pill>
          )}
          {onDetails && (
            <button onClick={onDetails} style={mfrDetailsBtn}
              title="Szczegóły producenta — sezonowość, wymaga zamówienia, kontenery w drodze">
              <I.Factory size={11}/> Szczegóły
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--text-lo)", marginTop: 3, flexWrap: "wrap" }}>
          <span>{item.contact || "—"}</span>
          <span>·</span>
          <span className="mono">{item.email || "—"}</span>
          <span>·</span>
          <span><span className="num" style={{ color: "var(--text-mid)" }}>{item.sku_count || 0}</span> SKU</span>
        </div>
      </div>
      {showEdit && <button onClick={onEdit} style={btnGhostMini}>Edytuj</button>}
    </div>
  );
}

// Przycisk „Szczegóły" w wierszu producenta. Celowo lżejszy niż „Edytuj" po prawej —
// to podgląd, nie akcja edycyjna, i siedzi w linii nazwy zaraz za pigułką „aktywnych".
const mfrDetailsBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px",
  background: "transparent", border: "1px solid var(--border-soft)", borderRadius: 99,
  color: "var(--text-lo)", fontSize: 10, fontWeight: 600, cursor: "pointer",
  fontFamily: "inherit", lineHeight: 1.6,
};

// ============================================================
// TYPY KONTENERÓW
// ============================================================
function ContainerTypesPanel() {
  const user = useUser() as CtxUser;
  const showEdit = canEdit(user);
  const [items, setItems] = useState<ContainerType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const data = await api.get("/container-types");
      setItems(Array.isArray(data) ? (data as ContainerType[]) : []);
    } catch { toast("Nie udało się pobrać typów kontenerów", "error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order);
  const maxCapacity = items.length ? Math.max(...items.map(t => t.capacity_cbm)) : 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{items.length}</span> typów ·
          maks. <span className="num" style={{ color: "var(--text-hi)" }}> {maxCapacity} m³</span>
        </span>
        {showEdit && <button onClick={() => setCreating(true)} style={btnPrimary}><I.Plus size={12}/> Dodaj typ</button>}
      </div>

      {loading && !items.length ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
          {sorted.map(t => (
            <ContainerTypeCard key={t.id} item={t} maxCapacity={maxCapacity}
              editing={editingId === t.id} onEdit={() => setEditingId(t.id)}
              onSaved={() => { setEditingId(null); load(); }} onCancel={() => setEditingId(null)} showEdit={showEdit}/>
          ))}
          {creating && (
            <ContainerTypeCard item={null} editing maxCapacity={maxCapacity}
              onSaved={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)}/>
          )}
        </div>
      )}
    </div>
  );
}

function ContainerTypeCard({ item, maxCapacity, editing, onEdit, onSaved, onCancel, showEdit }: {
  item: ContainerType | null; maxCapacity: number; editing: boolean;
  onEdit?: () => void; onSaved: () => void; onCancel: () => void; showEdit?: boolean;
}) {
  const [name, setName] = useState(item?.name || "");
  const [capacity, setCapacity] = useState(String(item?.capacity_cbm ?? 67));
  const [sortOrder, setSortOrder] = useState(String(item?.sort_order ?? 0));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const cap = parseFloat(capacity.replace(",", "."));
    if (!name.trim()) { toast("Podaj nazwę typu", "warning"); return; }
    if (!(cap > 0)) { toast("Pojemność musi być > 0", "warning"); return; }
    setBusy(true);
    try {
      const body = { name: name.trim(), capacity_cbm: cap, sort_order: parseInt(sortOrder, 10) || 0 };
      if (item) await api.patch(`/container-types/${item.id}`, body);
      else await api.post("/container-types", body);
      toast(item ? "Zapisano typ" : "Dodano typ", "ok"); onSaved();
    } catch { toast("Nie udało się zapisać", "error"); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!item) return;
    if (!window.confirm(`Usunąć typ „${item.name}"?`)) return;
    setBusy(true);
    try { await api.del(`/container-types/${item.id}`); toast("Usunięto typ", "ok"); onSaved(); }
    catch { toast("Nie udało się usunąć (mogą istnieć powiązane kontenery)", "error"); }
    finally { setBusy(false); }
  };

  if (editing) {
    return (
      <div style={{ padding: 14, background: "var(--surface-2)", border: "1px solid var(--accent)", borderRadius: 10 }}>
        <SettingsField label="Nazwa typu">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="np. 40′ HC" style={inputStyle}/>
        </SettingsField>
        <SettingsField label="Pojemność (m³)">
          <input type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} step="0.1" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}/>
        </SettingsField>
        <SettingsField label="Sortowanie">
          <input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} step="1" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}/>
        </SettingsField>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
          {item ? <button onClick={remove} disabled={busy} style={{ ...btnGhost, color: "var(--critical)" }}>Usuń</button> : <span/>}
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onCancel} disabled={busy} style={btnSecondary}>Anuluj</button>
            <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "…" : "Zapisz"}</button>
          </div>
        </div>
      </div>
    );
  }

  if (!item) return null;
  const pct = (item.capacity_cbm / maxCapacity) * 100;
  return (
    <div style={{ padding: 14, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, transition: "all 0.12s" }}
      onMouseEnter={(e) => e.currentTarget.style.borderColor = "var(--border)"}
      onMouseLeave={(e) => e.currentTarget.style.borderColor = "var(--border-soft)"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Ship size={20} style={{ color: "var(--text-mid)" }}/>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{item.name}</div>
            <div className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>Sortowanie: {item.sort_order}</div>
          </div>
        </div>
        {showEdit && <button onClick={onEdit} style={btnGhostMini}>Edytuj</button>}
      </div>
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <span style={{ fontSize: 10, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Pojemność</span>
          <span className="num" style={{ fontSize: 18, fontWeight: 600, color: "var(--text-hi)" }}>
            {item.capacity_cbm} <span style={{ fontSize: 11, color: "var(--text-lo)" }}>m³</span>
          </span>
        </div>
        <div style={{ height: 4, background: "var(--surface-2)", borderRadius: 99, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "var(--accent)", borderRadius: 99, transition: "width 0.3s" }}/>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CHIŃSKIE SKU (mapowanie SKU → kod fabryczny, pod generator PO)
// ============================================================
type CnSkuRowT = {
  id: number; sku: string; cn_sku: string; en_name?: string | null;
  product_name?: string | null;
  manufacturer_id?: number | null;
  manufacturer_name?: string | null;
  manufacturer_color?: string | null;
};

// Parsuje wklejkę z Excela: linie, komórki rozdzielone tab / ; / , / 2+ spacje.
// Kolumny: SKU, CN-SKU, [nazwa EN — opcjonalna]. Pomija nagłówek i linie < 2 komórek.
function parseCnSkuPaste(text: string): { sku: string; cn_sku: string; en_name?: string }[] {
  const out: { sku: string; cn_sku: string; en_name?: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(/\t|;|,|\s{2,}/).map(c => c.trim());
    const sku = (cells[0] || "").trim();
    const cn = (cells[1] || "").trim();
    const en = (cells[2] || "").trim();
    if (!sku || !cn) continue;
    if (/^sku$/i.test(sku) || /^cn[\s_-]?sku$/i.test(cn)) continue; // wiersz nagłówka
    out.push({ sku, cn_sku: cn, en_name: en || undefined });
  }
  return out;
}

function CnSkuPanel() {
  const user = useUser() as CtxUser;
  const showEdit = can(user, "generatePO");
  const [rows, setRows] = useState<CnSkuRowT[]>([]);
  const [mfrs, setMfrs] = useState<Manufacturer[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [mfrFilter, setMfrFilter] = useState<number | "all">("all");
  const [creating, setCreating] = useState(false);
  const [newSku, setNewSku] = useState("");
  const [newCn, setNewCn] = useState("");
  const [newEn, setNewEn] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [data, m] = await Promise.all([api.get("/cn-sku"), api.get("/manufacturers")]);
      setRows(Array.isArray(data) ? (data as CnSkuRowT[]) : []);
      setMfrs(Array.isArray(m) ? (m as Manufacturer[]) : []);
    } catch { toast("Nie udało się pobrać listy CN-SKU", "error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter(r => {
      if (mfrFilter !== "all" && r.manufacturer_id !== mfrFilter) return false;
      if (!qq) return true;
      return r.sku.toLowerCase().includes(qq)
        || r.cn_sku.toLowerCase().includes(qq)
        || (r.en_name || "").toLowerCase().includes(qq)
        || (r.product_name || "").toLowerCase().includes(qq);
    });
  }, [rows, q, mfrFilter]);

  const withCn = rows.length;

  const addRow = async () => {
    const sku = newSku.trim(), cn = newCn.trim();
    if (!sku || !cn) { toast("Podaj SKU i CN-SKU", "warning"); return; }
    setBusy(true);
    try {
      await api.post("/cn-sku", { sku, cn_sku: cn, en_name: newEn.trim() || null });
      toast("Dodano CN-SKU", "ok");
      setNewSku(""); setNewCn(""); setNewEn(""); setCreating(false); load();
    } catch { toast("Nie udało się dodać", "error"); }
    finally { setBusy(false); }
  };

  const submitPaste = async () => {
    const parsed = parseCnSkuPaste(pasteText);
    if (parsed.length === 0) { toast("Nie znaleziono par SKU + CN-SKU", "warning"); return; }
    setBusy(true);
    try {
      const res = await api.post("/cn-sku/bulk", { rows: parsed }) as { inserted: number; updated: number };
      toast(`Wgrano: ${res.inserted} nowych, ${res.updated} zaktualizowanych`, "ok");
      setPasteText(""); setShowPaste(false); load();
    } catch { toast("Import nie powiódł się", "error"); }
    finally { setBusy(false); }
  };

  const previewCount = parseCnSkuPaste(pasteText).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{withCn}</span> odpowiedników
          {filtered.length !== withCn && <> · <span className="num" style={{ color: "var(--text-hi)" }}>{filtered.length}</span> po filtrze</>}
        </span>
        {showEdit && (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => { setShowPaste(v => !v); setCreating(false); }} style={btnSecondary}><I.Plus size={12}/> Wklej z Excela</button>
            <button onClick={() => { setCreating(v => !v); setShowPaste(false); }} style={btnPrimary}><I.Plus size={12}/> Dodaj CN-SKU</button>
          </div>
        )}
      </div>

      {showEdit && showPaste && (
        <div style={{ padding: 14, background: "var(--surface-2)", border: "1px solid var(--accent)", borderRadius: 10 }}>
          <div style={{ fontSize: 12, color: "var(--text-mid)", marginBottom: 8 }}>
            Wklej kolumny z Excela: <strong>SKU</strong>, <strong>CN-SKU</strong> i opcjonalnie <strong>nazwa EN</strong> (tab, przecinek lub średnik jako separator). Istniejące SKU zostaną zaktualizowane; puste EN nie nadpisuje.
          </div>
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={8}
            placeholder={"A3cz\tTF-4521\tAluminium Bed 3-seg, Black\nD2cz_s\tTF-2814\t...\n..."}
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12, resize: "vertical" }}/>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
            <span style={{ fontSize: 11, color: "var(--text-lo)" }}>
              Rozpoznano par: <span className="num" style={{ color: "var(--text-hi)" }}>{previewCount}</span>
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => { setShowPaste(false); setPasteText(""); }} disabled={busy} style={btnSecondary}>Anuluj</button>
              <button onClick={submitPaste} disabled={busy || previewCount === 0} style={btnPrimary}>{busy ? "…" : `Wgraj ${previewCount || ""}`}</button>
            </div>
          </div>
        </div>
      )}

      {showEdit && creating && (
        <div style={{ padding: 14, background: "var(--surface-2)", border: "1px solid var(--accent)", borderRadius: 10, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}>
            <SettingsField label="SKU (Twój kod)">
              <input value={newSku} onChange={(e) => setNewSku(e.target.value)} autoFocus placeholder="np. A3cz" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}/>
            </SettingsField>
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <SettingsField label="CN-SKU (kod fabryczny)">
              <input value={newCn} onChange={(e) => setNewCn(e.target.value)} placeholder="np. TF-4521"
                onKeyDown={(e) => { if (e.key === "Enter") addRow(); }}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}/>
            </SettingsField>
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <SettingsField label="Nazwa EN (opcjonalnie)">
              <input value={newEn} onChange={(e) => setNewEn(e.target.value)} placeholder="np. Aluminium Bed 3-seg, Black"
                onKeyDown={(e) => { if (e.key === "Enter") addRow(); }}
                style={inputStyle}/>
            </SettingsField>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => { setCreating(false); setNewSku(""); setNewCn(""); setNewEn(""); }} disabled={busy} style={btnSecondary}>Anuluj</button>
            <button onClick={addRow} disabled={busy} style={btnPrimary}>{busy ? "…" : "Dodaj"}</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 200px" }}>
          <I.Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-lo)" }}/>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj SKU / CN-SKU / nazwy…"
            style={{ ...inputStyle, paddingLeft: 30 }}/>
        </div>
        <select value={String(mfrFilter)} onChange={(e) => setMfrFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          style={{ ...inputStyle, flex: "0 0 auto", minWidth: 180 }}>
          <option value="all">Wszyscy dostawcy</option>
          {mfrs.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      {loading && !rows.length ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
          {rows.length === 0 ? "Brak odpowiedników. Dodaj ręcznie lub wklej z Excela." : "Nic nie pasuje do filtra."}
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(100px, 1fr) minmax(0, 1.5fr) minmax(120px, 1.1fr) minmax(0, 1.5fr) 40px",
            gap: 10, padding: "8px 12px", background: "var(--surface-2)", borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <span>SKU</span><span>Produkt / dostawca</span><span>CN-SKU</span><span>Nazwa EN</span><span/>
          </div>
          {filtered.map(r => <CnSkuRow key={r.id} row={r} showEdit={showEdit} onChanged={load}/>)}
        </div>
      )}
    </div>
  );
}

function CnSkuRow({ row, showEdit, onChanged }: { row: CnSkuRowT; showEdit: boolean; onChanged: () => void }) {
  const [cn, setCn] = useState(row.cn_sku);
  const [en, setEn] = useState(row.en_name || "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCn(row.cn_sku); }, [row.cn_sku]);
  useEffect(() => { setEn(row.en_name || ""); }, [row.en_name]);

  const save = async () => {
    const vCn = cn.trim(), vEn = en.trim();
    if (!vCn) { setCn(row.cn_sku); return; }
    if (vCn === row.cn_sku && vEn === (row.en_name || "")) return;
    setBusy(true);
    try { await api.patch(`/cn-sku/${row.id}`, { sku: row.sku, cn_sku: vCn, en_name: vEn || null }); toast("Zapisano", "ok"); onChanged(); }
    catch { toast("Nie udało się zapisać", "error"); setCn(row.cn_sku); setEn(row.en_name || ""); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Usunąć odpowiednik CN-SKU dla „${row.sku}"? (nie rusza produktu w magazynie)`)) return;
    setBusy(true);
    try { await api.del(`/cn-sku/${row.id}`); toast("Usunięto", "ok"); onChanged(); }
    catch { toast("Nie udało się usunąć", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(100px, 1fr) minmax(0, 1.5fr) minmax(120px, 1.1fr) minmax(0, 1.5fr) 40px",
      gap: 10, padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--border-soft)" }}>
      <span className="mono" style={{ fontSize: 12, color: "var(--text-hi)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{row.sku}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.product_name || <span style={{ color: "var(--text-lo)", fontStyle: "italic" }}>— spoza bazy —</span>}
        </div>
        {row.manufacturer_name && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: row.manufacturer_color || "var(--text-lo)", flex: "0 0 auto" }}/>
            <span style={{ fontSize: 10.5, color: "var(--text-lo)" }}>{row.manufacturer_name}</span>
          </div>
        )}
      </div>
      <input value={cn} onChange={(e) => setCn(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setCn(row.cn_sku); }}
        disabled={!showEdit || busy}
        style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12, padding: "6px 8px" }}/>
      <input value={en} onChange={(e) => setEn(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEn(row.en_name || ""); }}
        disabled={!showEdit || busy} placeholder="nazwa EN"
        style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }}/>
      {showEdit
        ? <button onClick={remove} disabled={busy} title="Usuń" style={{ ...btnGhostMini, color: "var(--critical)", padding: "6px 8px" }}><I.Close size={13}/></button>
        : <span/>}
    </div>
  );
}

// ============================================================
// STAWKI CŁA (kod CN produktu + słownik kod CN → stawka %)
// ============================================================
// Kod CN dawniej siedział w „Danych podstawowych" karty produktu — teraz tutaj, obok
// stawki, bo liczą się razem: cło w koszcie jednostkowym kontenera = (towar + fracht) × stawka.
// Lista to tylko obserwowane SKU, nowości i sample — outlety i reszta katalogu nie są potrzebne.
// Stawka należy do KODU, nie do produktu: poprawka zmienia ją we wszystkich SKU z tym kodem.
// Słownik uzupełnia się sam z zapisanych odpraw (SAD); ręczną stawkę wpisuje superadmin,
// a kod CN — każdy z prawem edycji produktów (security: routers/koszt_kontenera.py).
type StawkaRowT = {
  sku: string; nazwa?: string | null; firma?: string | null; obserwowany: boolean; nowosc: boolean; sample: boolean;
  kod_cn?: string | null; stawka?: number | null; zrodlo?: string | null;
};

const fmtCn = (k?: string | null) => (k ? k.replace(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?$/, (_m, a, b, c, d) => [a, b, c, d].filter(Boolean).join(" ")) : "");

function StawkiClaPanel() {
  const user = useUser() as CtxUser;
  const kodEdit = can(user, "editProducts");
  const stawkaEdit = isSuperUser(user);
  const [rows, setRows] = useState<StawkaRowT[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [tylkoBraki, setTylkoBraki] = useState(false);

  useEffect(() => {
    let zywy = true;
    api.get("/stawki-cn")
      .then((data) => { if (zywy) setRows(Array.isArray(data) ? (data as StawkaRowT[]) : []); })
      .catch(() => toast("Nie udało się pobrać stawek cła", "error"))
      .finally(() => { if (zywy) setLoading(false); });
    return () => { zywy = false; };
  }, []);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase().replace(/\s/g, "");
    return rows.filter(r => {
      if (tylkoBraki && r.kod_cn && r.stawka != null) return false;
      if (!qq) return true;
      return r.sku.toLowerCase().includes(qq) || (r.nazwa || "").toLowerCase().replace(/\s/g, "").includes(qq)
        || (r.kod_cn || "").includes(qq);
    });
  }, [rows, q, tylkoBraki]);
  const braki = rows.filter(r => !r.kod_cn || r.stawka == null).length;

  // Zmiana stawki obowiązuje cały kod — przepisujemy ją we wszystkich wierszach z tym kodem.
  const poStawce = (kod: string, stawka: number) =>
    setRows(rs => rs.map(r => (r.kod_cn === kod ? { ...r, stawka, zrodlo: "reczna" } : r)));
  const poKodzie = (sku: string, kod: string | null, stawka: number | null, zrodlo: string | null) =>
    setRows(rs => rs.map(r => (r.sku === sku ? { ...r, kod_cn: kod, stawka, zrodlo } : r)));

  const kol = "minmax(110px, 1fr) minmax(0, 2fr) 130px 110px 90px";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{rows.length}</span> SKU
          {braki > 0 && <> · <span className="num" style={{ color: "var(--critical)", fontWeight: 600 }}>{braki}</span> bez kodu CN albo stawki</>}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--text-lo)", maxWidth: "62ch" }}>
          Stawki uzupełniają się same z zapisanych odpraw. {stawkaEdit ? "Poprawka stawki zmienia ją we wszystkich SKU z tym kodem." : "Stawkę poprawia superadmin."}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 220px" }}>
          <I.Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-lo)" }}/>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj SKU / nazwy / kodu CN…"
            style={{ ...inputStyle, paddingLeft: 30 }}/>
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-mid)", cursor: "pointer" }}>
          <input type="checkbox" checked={tylkoBraki} onChange={(e) => setTylkoBraki(e.target.checked)}/> tylko braki
        </label>
      </div>

      {loading && !rows.length ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
          {rows.length === 0 ? "Brak obserwowanych SKU, nowości i sampli." : "Nic nie pasuje do filtra."}
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border-soft)", borderRadius: 10, overflowX: "auto" }}>
          <div style={{ minWidth: 620 }}>
            <div style={{ display: "grid", gridTemplateColumns: kol, gap: 10, padding: "8px 12px", background: "var(--surface-2)",
              borderBottom: "1px solid var(--border-soft)", fontSize: 10, fontWeight: 600, color: "var(--text-lo)",
              textTransform: "uppercase", letterSpacing: "0.06em" }}>
              <span>SKU</span><span>Produkt</span><span>Kod CN</span><span>Stawka cła</span><span>Źródło</span>
            </div>
            {filtered.map(r => (
              // Klucz z kodem i stawką: po zmianie wiersz montuje się od nowa z aktualnymi polami.
              <StawkaRow key={`${r.sku}|${r.kod_cn ?? ""}|${r.stawka ?? ""}`} row={r} kol={kol} kodEdit={kodEdit} stawkaEdit={stawkaEdit}
                onStawka={poStawce} onKod={poKodzie}/>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StawkaRow({ row, kol, kodEdit, stawkaEdit, onStawka, onKod }: {
  row: StawkaRowT; kol: string; kodEdit: boolean; stawkaEdit: boolean;
  onStawka: (kod: string, stawka: number) => void;
  onKod: (sku: string, kod: string | null, stawka: number | null, zrodlo: string | null) => void;
}) {
  const [kod, setKod] = useState(fmtCn(row.kod_cn));
  const [st, setSt] = useState(row.stawka != null ? String(row.stawka).replace(".", ",") : "");
  const [busy, setBusy] = useState(false);

  const zapiszKod = async () => {
    const cyfry = kod.replace(/\D/g, "");
    if (cyfry === (row.kod_cn || "")) { setKod(fmtCn(row.kod_cn)); return; }
    setBusy(true);
    try {
      const r = await api.put(`/products/${encodeURIComponent(row.sku)}/kod-cn`, { kod_cn: cyfry || null }) as StawkaRowT;
      onKod(row.sku, r.kod_cn ?? null, r.stawka ?? null, r.zrodlo ?? null);
      toast(cyfry ? `Zapisano kod CN ${fmtCn(r.kod_cn)}` : "Usunięto kod CN", "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Nie udało się zapisać kodu CN", "error"); setKod(fmtCn(row.kod_cn)); }
    finally { setBusy(false); }
  };
  const zapiszStawke = async () => {
    const t = st.trim().replace(",", ".");
    if (!row.kod_cn || t === "" || Number(t) === row.stawka) { setSt(row.stawka != null ? String(row.stawka).replace(".", ",") : ""); return; }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) { toast("Stawka to procent od 0 do 100", "warning"); return; }
    setBusy(true);
    try {
      await api.put(`/stawki-cn/${row.kod_cn}`, { stawka: n });
      onStawka(row.kod_cn, n);
      toast(`Stawka dla ${fmtCn(row.kod_cn)}: ${String(n).replace(".", ",")}%`, "ok");
    } catch (e) { toast(e instanceof Error ? e.message : "Nie udało się zapisać stawki", "error"); }
    finally { setBusy(false); }
  };

  const plak = (t: string, bg: string, fg: string) => (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", padding: "1px 5px", borderRadius: 4, background: bg, color: fg }}>{t}</span>
  );
  const brakStawki = row.kod_cn && row.stawka == null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: kol, gap: 10, padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--border-soft)" }}>
      <span className="mono" style={{ fontSize: 12, color: "var(--text-hi)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{row.sku}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text-mid)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.nazwa || "—"}</div>
        <div style={{ display: "flex", gap: 4, marginTop: 2, flexWrap: "wrap" }}>
          {row.obserwowany && plak("OBSERWOWANY", "var(--accent-soft)", "var(--accent)")}
          {row.nowosc && plak("NOWOŚĆ", "var(--ok-soft)", "var(--ok)")}
          {row.sample && plak("SAMPLE", "var(--anomaly-soft)", "var(--anomaly)")}
          {row.firma && <span style={{ fontSize: 10.5, color: "var(--text-lo)" }}>{row.firma.toUpperCase()}</span>}
        </div>
      </div>
      <input value={kod} onChange={(e) => setKod(e.target.value)} onBlur={zapiszKod} disabled={!kodEdit || busy}
        placeholder="9403 20 80" aria-label={`Kod CN ${row.sku}`}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setKod(fmtCn(row.kod_cn)); }}
        style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12, padding: "6px 8px",
          borderColor: row.kod_cn ? undefined : "color-mix(in oklch, var(--critical) 50%, var(--border))" }}/>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input value={st} onChange={(e) => setSt(e.target.value)} onBlur={zapiszStawke}
          disabled={!stawkaEdit || !row.kod_cn || busy} inputMode="decimal" placeholder={row.kod_cn ? "?" : "—"}
          aria-label={`Stawka cła ${row.sku}`}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12, padding: "6px 8px", textAlign: "right",
            borderColor: brakStawki ? "color-mix(in oklch, var(--critical) 50%, var(--border))" : undefined }}/>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>%</span>
      </div>
      <span>
        {!row.kod_cn ? plak("BRAK KODU", "var(--critical-soft)", "var(--critical)")
          : row.stawka == null ? plak("BRAK STAWKI", "var(--critical-soft)", "var(--critical)")
            : row.zrodlo === "reczna" ? plak("RĘCZNIE", "var(--info-soft)", "var(--info)")
              : plak("Z SAD", "var(--surface-3)", "var(--text-mid)")}
      </span>
    </div>
  );
}

// ============================================================
// FIRMY (sklepy: AMH / Acti / Veluxa)
// ============================================================
type Firma = {
  id: number; slug: string; name: string; color?: string | null; is_self: boolean;
  base_url?: string | null; api_key_env?: string | null; key_present: boolean;
  configured: boolean; sort_order: number; product_count: number;
};
type FirmaMfr = { id: number; name: string };

function FirmaePanel() {
  const user = useUser() as CtxUser;
  const showEdit = isAdmin(user);
  const [items, setItems] = useState<Firma[]>([]);
  const [mfrs, setMfrs] = useState<FirmaMfr[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = async () => {
    try {
      const [f, m] = await Promise.all([api.get("/firmy"), api.get("/manufacturers")]);
      setItems(Array.isArray(f) ? (f as Firma[]) : []);
      setMfrs(Array.isArray(m) ? (m as FirmaMfr[]) : []);
    } catch { toast("Nie udało się pobrać firm", "error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span style={{ fontSize: 12, color: "var(--text-lo)", lineHeight: 1.5 }}>
        Sklepy = źródła sprzedaży i zapasu. <b style={{ color: "var(--text-mid)" }}>AMH</b> to hub (stan z Subiektu).
        Acti i Veluxa ciągniemy z ich Sellasista — uzupełnij <span className="num">base_url</span>; klucz API jest w zmiennej środowiskowej na Railway (nie w bazie).
        Produkty przypisujesz do firmy masowo — po producencie (zrób to <b style={{ color: "var(--text-mid)" }}>zanim</b> wyczyścisz producentów Acti/Veluxa).
      </span>
      {loading && !items.length ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {items.map(f => (
            <FirmaCard key={f.id} item={f} mfrs={mfrs}
              editing={editingId === f.id} onEdit={() => setEditingId(f.id)}
              onSaved={() => { setEditingId(null); load(); }} onCancel={() => setEditingId(null)} showEdit={showEdit}/>
          ))}
        </div>
      )}
    </div>
  );
}

function FirmaCard({ item, mfrs, editing, onEdit, onSaved, onCancel, showEdit }: {
  item: Firma; mfrs: FirmaMfr[]; editing: boolean; onEdit: () => void; onSaved: () => void; onCancel: () => void; showEdit: boolean;
}) {
  const [baseUrl, setBaseUrl] = useState(item.base_url || "");
  const [color, setColor] = useState(item.color || "#6b7280");
  const [busy, setBusy] = useState(false);
  const [assignMfr, setAssignMfr] = useState("");
  const [assigning, setAssigning] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/firmy/${item.id}`, { base_url: baseUrl.trim() || null, color });
      toast("Zapisano firmę", "ok"); onSaved();
    } catch { toast("Nie udało się zapisać", "error"); }
    finally { setBusy(false); }
  };

  const assign = async () => {
    const mid = parseInt(assignMfr, 10);
    if (!mid) { toast("Wybierz producenta", "warning"); return; }
    setAssigning(true);
    try {
      const res = await api.post(`/firmy/${item.id}/assign-products`, { manufacturer_id: mid });
      const n = (res && typeof res.assigned === "number") ? res.assigned : 0;
      toast(`Przypisano ${n} produktów do ${item.name}`, "ok"); setAssignMfr(""); onSaved();
    } catch { toast("Nie udało się przypisać", "error"); }
    finally { setAssigning(false); }
  };

  if (editing) {
    return (
      <div style={{ padding: 14, background: "var(--surface-2)", border: "1px solid var(--accent)", borderRadius: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{item.name}</div>
        <SettingsField label="Base URL Sellasista">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoFocus placeholder="https://…/api" style={inputStyle}/>
        </SettingsField>
        <SettingsField label="Kolor (tag na dashboardach)">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ ...inputStyle, height: 38, padding: 3 }}/>
        </SettingsField>
        <div style={{ fontSize: 11, color: "var(--text-lo)", marginBottom: 10 }}>
          Klucz API: zmienna <span className="num">{item.api_key_env || "—"}</span> — {item.key_present ? "ustawiona ✓" : "brak na Railway"}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button onClick={onCancel} disabled={busy} style={btnSecondary}>Anuluj</button>
          <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "…" : "Zapisz"}</button>
        </div>
      </div>
    );
  }

  const badge = item.is_self
    ? { txt: "Hub (Subiekt)", col: "var(--text-mid)" }
    : item.configured
      ? { txt: "Połączona", col: "var(--ok, #22c55e)" }
      : !item.key_present
        ? { txt: "Brak klucza API", col: "var(--critical)" }
        : { txt: "Uzupełnij base_url", col: "var(--warning, #f59e0b)" };

  return (
    <div style={{ padding: 14, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, transition: "all 0.12s" }}
      onMouseEnter={(e) => e.currentTarget.style.borderColor = "var(--border)"}
      onMouseLeave={(e) => e.currentTarget.style.borderColor = "var(--border-soft)"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: item.color || "#6b7280", flexShrink: 0 }}/>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{item.name}</div>
            <div className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{item.slug}</div>
          </div>
        </div>
        {showEdit && <button onClick={onEdit} style={btnGhostMini}>Edytuj</button>}
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ alignSelf: "flex-start", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: badge.col, background: "var(--surface-2)", padding: "3px 8px", borderRadius: 99 }}>{badge.txt}</span>
        <div className="num" style={{ fontSize: 11, color: "var(--text-lo)", wordBreak: "break-all" }}>
          {item.base_url || "— brak base_url —"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-lo)" }}>
          Przypisane produkty: <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{item.product_count}</span>
        </div>
      </div>

      {showEdit && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
            Przypisz produkty po producencie
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={assignMfr} onChange={(e) => setAssignMfr(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
              <option value="">— wybierz producenta —</option>
              {mfrs.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <button onClick={assign} disabled={assigning || !assignMfr} style={btnPrimary}>{assigning ? "…" : "Przypisz"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// UŻYTKOWNICY (tylko ADMIN)
// ============================================================
// ── Użytkownicy: kolejność, zależności, pakiety ──────────────
// Lista i macierz idą rolami: najpierw Admin, potem Import, na końcu Viewer.
const ROLE_ORDER = ["ADMIN", "IMPORT", "VIEWER"] as const;
const ROLE_RANK: Record<string, number> = { ADMIN: 0, IMPORT: 1, VIEWER: 2 };

// Uprawnienia koniunkcyjne — bez wymaganego klucza dane uprawnienie nic nie pokaże.
// Lustro reguł z lib/permissions.js (canSee*) i security.py (can_*).
const PERM_REQUIRES: Record<string, string[]> = {
  viewProductPrice: ["viewFinancials"],
  editProductPrice: ["viewProductPrice", "viewFinancials"],
  viewProductSales: ["viewFinancials"],
  viewLandedCost: ["viewFinancials"],
  editLandedCost: ["viewLandedCost", "viewFinancials"],
  viewCalendarPayments: ["viewFinancials"],
  viewBankBalances: ["viewFinancials"],
  editBankBalances: ["viewBankBalances", "viewFinancials"],
};

// Gotowe pakiety do zmiany masowej („Nadaj” na wszystkich kluczach pakietu).
const PERM_PRESETS: { id: string; label: string; perms: string[] }[] = [
  { id: "cena",     label: "Cena produktu (podgląd)",            perms: ["viewFinancials", "viewProductPrice"] },
  { id: "cenaEdit", label: "Cena produktu + zapis",              perms: ["viewFinancials", "viewProductPrice", "editProductPrice"] },
  { id: "produkt",  label: "Karta produktu: historia + sprzedaż", perms: ["viewFinancials", "viewProductHistory", "viewProductSales"] },
  { id: "koszt",    label: "Koszt kontenera",                    perms: ["viewFinancials", "viewLandedCost"] },
];

// Kolejność grup uprawnień w macierzy i w panelu masowym
const PERM_GROUP_ORDER = ["Widoczność", "Dane", "Zamówienia", "Administracja"];
const permsByGroup = (): [string, PermDef[]][] => {
  const g: Record<string, PermDef[]> = {};
  PERMS.forEach(p => { (g[p.group] = g[p.group] || []).push(p); });
  const known = PERM_GROUP_ORDER.filter(n => g[n]);
  const rest = Object.keys(g).filter(n => !PERM_GROUP_ORDER.includes(n));
  return [...known, ...rest].map(n => [n, g[n]]);
};

type BulkOp = "grant" | "revoke" | "default";
type BulkBody = { user_ids: number[]; perms?: Record<string, boolean | null>; role?: string; is_active?: boolean; show_onboarding?: boolean };

const hasOwn = (o: object | null | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const roleDefault = (role: string, key: string) => !!(ROLE_DEF[role] || {})[key];
const effPerm = (u: UserRowT, key: string) => hasOwn(u.perms, key) ? !!u.perms![key] : roleDefault(u.role, key);
const isOverride = (u: UserRowT, key: string) => hasOwn(u.perms, key) && !!u.perms![key] !== roleDefault(u.role, key);
const overridesOf = (u: UserRowT) => u.perms ? Object.keys(u.perms).filter(k => isOverride(u, k)).length : 0;
const nameOf = (u: UserRowT) => (u.full_name && u.full_name.trim()) || u.email;
const pl = (n: number, one: string, few: string, many: string) => {
  if (n === 1) return one;
  const d = n % 10, h = n % 100;
  return d >= 2 && d <= 4 && (h < 10 || h >= 20) ? few : many;
};
const sortUsers = (a: UserRowT, b: UserRowT) =>
  (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9)
  || Number(b.is_super_admin) - Number(a.is_super_admin)
  || Number(b.is_active) - Number(a.is_active)
  || nameOf(a).localeCompare(nameOf(b), "pl");

function UsersPanel({ currentUserId }: { currentUserId?: number | string }) {
  const viewerSuper = isSuperUser(useUser() as CtxUser);
  const [items, setItems] = useState<UserRowT[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<{ id: number; mode: "perms" | "reset" } | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [view, setView] = useState<"list" | "matrix">("list");
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [bulkModal, setBulkModal] = useState<null | "perms" | "role">(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = async () => {
    try {
      const data = await api.get("/users");
      setItems(Array.isArray(data) ? (data as UserRowT[]) : []);
    } catch { toast("Nie udało się pobrać użytkowników", "error"); }
    finally { setLoading(false); }
  };
  const [, setNowTick] = useState(0); // tick wymusza re-render → przeliczenie koloru kropki „na żywo"
  useEffect(() => {
    load();
    const dataTimer = setInterval(load, 60000);          // odśwież dane co 60 s
    const tickTimer = setInterval(() => setNowTick(t => t + 1), 20000); // przelicz kolor co 20 s
    return () => { clearInterval(dataTimer); clearInterval(tickTimer); };
  }, []);

  const isSelfU = (u: UserRowT) => String(u.id) === String(currentUserId);
  // Reguła: kontami ADMIN zarządza tylko super-admin (backend pilnuje tego samego).
  const lockedBase = (u: UserRowT) => !viewerSuper && u.role === "ADMIN";
  // Zaznaczyć (i ruszać masowo / w macierzy) można każde konto poza własnym i zablokowanymi.
  const selectable = (u: UserRowT) => !lockedBase(u) && !isSelfU(u);

  // Po odświeżeniu listy wyrzuć z zaznaczenia konta, których już nie ma albo nie wolno ruszać.
  useEffect(() => {
    setSelected(prev => {
      if (!prev.size) return prev;
      const ok = new Set(items.filter(selectable).map(u => u.id));
      const next = new Set([...prev].filter(id => ok.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => items.reduce<Record<string, number>>((a, u) => { a[u.role] = (a[u.role] || 0) + 1; return a; }, {}), [items]);
  const inactiveCount = items.filter(u => !u.is_active).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter(u => (!roleFilter || u.role === roleFilter)
        && (showInactive || u.is_active)
        && (!q || nameOf(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q)))
      .sort(sortUsers);
  }, [items, roleFilter, query, showInactive]);
  const groups = useMemo(() => ROLE_ORDER
    .map(role => ({ role: role as string, users: visible.filter(u => u.role === role) }))
    .concat([{ role: "_other", users: visible.filter(u => !(u.role in ROLE_RANK)) }])
    .filter(g => g.users.length), [visible]);
  const selectedUsers = useMemo(() => items.filter(u => selected.has(u.id)), [items, selected]);

  const toggleSel = (id: number) => setSelected(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });
  const toggleGroup = (users: UserRowT[]) => {
    const sel = users.filter(selectable);
    const all = sel.length > 0 && sel.every(u => selected.has(u.id));
    setSelected(prev => { const n = new Set(prev); sel.forEach(u => all ? n.delete(u.id) : n.add(u.id)); return n; });
  };

  const patchUser = async (id: number, body: Record<string, unknown>, okMsg: string) => {
    try { await api.patch(`/users/${id}`, body); toast(okMsg, "ok"); load(); }
    catch { toast("Nie udało się zapisać", "error"); }
  };
  const runBulk = async (body: BulkBody, okMsg: (updated: number) => string): Promise<boolean> => {
    setBulkBusy(true);
    try {
      const r = await api.post("/users/bulk", body) as { updated?: number } | null;
      toast(okMsg(r?.updated ?? 0), "ok");
      await load();
      return true;
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Nie udało się zapisać zmian", "error");
      return false;
    } finally { setBulkBusy(false); }
  };
  const changedMsg = (verb: string) => (n: number) =>
    n ? `${verb} — zmiana u ${n} ${pl(n, "osoby", "osób", "osób")}` : "Bez zmian — wszyscy mieli już takie ustawienie";

  const changeRole = (u: UserRowT, role: string) => patchUser(u.id, { role }, "Zmieniono rolę");
  const toggleActive = (u: UserRowT) => patchUser(u.id, { is_active: !u.is_active }, u.is_active ? "Dezaktywowano konto" : "Aktywowano konto");
  const remove = async (u: UserRowT) => {
    if (!window.confirm(`Usunąć użytkownika „${u.full_name || u.email}"? Tej operacji nie można cofnąć.`)) return;
    try { await api.del(`/users/${u.id}`); toast("Usunięto użytkownika", "ok"); load(); }
    catch { toast("Nie udało się usunąć", "error"); }
  };
  const toggleMode = (id: number, mode: "perms" | "reset") =>
    setExpanded(e => (e?.id === id && e.mode === mode) ? null : { id, mode });

  // „Włącz/Wyłącz wprowadzenie wszystkim” — wszystkie konta, którymi wolno zarządzać.
  const onboardingAll = async (val: boolean) => {
    const what = val ? "włączyć wprowadzenie wszystkim" : "wyłączyć wprowadzenie wszystkim";
    if (!window.confirm(`Na pewno ${what}? Zmiana obejmie wszystkie konta — każdy zobaczy (lub przestanie widzieć) ekran powitalny przy następnym logowaniu.`)) return;
    const ids = items.filter(u => !lockedBase(u)).map(u => u.id);
    if (!ids.length) return;
    await runBulk({ user_ids: ids, show_onboarding: val }, changedMsg(val ? "Włączono wprowadzenie" : "Wyłączono wprowadzenie"));
  };

  // ── akcje masowe ──
  const ids = () => selectedUsers.map(u => u.id);
  const bulkOnboarding = () => runBulk({ user_ids: ids(), show_onboarding: true }, changedMsg("Włączono wprowadzenie"));
  const bulkActive = async (val: boolean) => {
    const n = selectedUsers.length;
    if (!val && !window.confirm(`Dezaktywować ${n} ${pl(n, "konto", "konta", "kont")}? Te osoby nie zalogują się, dopóki ich nie aktywujesz.`)) return;
    const ok = await runBulk({ user_ids: ids(), is_active: val }, changedMsg(val ? "Aktywowano" : "Dezaktywowano"));
    if (ok && !val) setSelected(new Set());
  };
  const bulkRole = async (role: string) => {
    const ok = await runBulk({ user_ids: ids(), role }, changedMsg(`Zmieniono rolę na ${ROLE_META[role]?.label || role}`));
    if (ok) setBulkModal(null);
  };
  const bulkPerms = async (ops: Record<string, BulkOp>) => {
    const perms: Record<string, boolean | null> = {};
    Object.entries(ops).forEach(([k, op]) => { perms[k] = op === "grant" ? true : op === "revoke" ? false : null; });
    const ok = await runBulk({ user_ids: ids(), perms }, changedMsg("Zapisano uprawnienia"));
    if (ok) setBulkModal(null);
  };
  // Pojedyncza komórka macierzy — ten sam endpoint, jedna osoba, jeden klucz.
  const toggleCell = (u: UserRowT, key: string, label: string) => {
    const nv = !effPerm(u, key);
    runBulk({ user_ids: [u.id], perms: { [key]: nv } }, () => `${nv ? "Włączono" : "Wyłączono"} „${label}” — ${nameOf(u)}`);
  };

  const anyActiveSel = selectedUsers.some(u => u.is_active);
  const anyInactiveSel = selectedUsers.some(u => !u.is_active);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: selected.size ? 72 : 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        {ROLE_ORDER.map(r => (
          <RoleStat key={r} label={ROLE_META[r].label} count={counts[r] || 0} color={ROLE_META[r].color}
            active={roleFilter === r} onClick={() => setRoleFilter(f => f === r ? null : r)}/>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{items.length}</span> użytkowników w systemie
          {roleFilter && <> · filtr: <b style={{ color: ROLE_META[roleFilter]?.color }}>{ROLE_META[roleFilter]?.label}</b> <button onClick={() => setRoleFilter(null)} style={{ ...btnGhostMini, padding: "1px 7px", marginLeft: 4 }}>pokaż wszystkich</button></>}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button onClick={() => onboardingAll(true)} disabled={bulkBusy} style={btnSecondary} title="Pokaż wprowadzenie wszystkim przy następnym logowaniu">Włącz wprowadzenie wszystkim</button>
          <button onClick={() => onboardingAll(false)} disabled={bulkBusy} style={btnGhostMini}>Wyłącz</button>
          <button onClick={() => setCreating(true)} style={btnPrimary}><I.Plus size={12}/> Dodaj użytkownika</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 220px", minWidth: 0 }}>
          <I.Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-lo)" }}/>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Szukaj po imieniu lub e-mailu…"
            style={{ ...inputStyle, paddingLeft: 30, background: "var(--surface-1)" }} name="users-search" autoComplete="off"/>
        </div>
        <div style={{ display: "inline-flex", background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8, padding: 2 }}>
          {([["list", "Lista"], ["matrix", "Macierz uprawnień"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} style={{
              background: view === v ? "var(--surface-3)" : "transparent", color: view === v ? "var(--text-hi)" : "var(--text-mid)",
              border: "none", fontSize: 12, fontWeight: 500, padding: "5px 11px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
            }}>{label}</button>
          ))}
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-mid)", cursor: "pointer" }}>
          <SelectBox checked={showInactive} onChange={() => setShowInactive(v => !v)} label="Pokaż nieaktywne"/>
          Pokaż nieaktywne{inactiveCount ? <span className="num" style={{ color: "var(--text-lo)" }}> ({inactiveCount})</span> : null}
        </label>
      </div>

      {creating && <NewUserForm viewerSuper={viewerSuper} onSaved={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)}/>}

      {view === "matrix" ? (
        <PermMatrix groups={groups} isLocked={(u) => !selectable(u)} busy={bulkBusy} onToggle={toggleCell}/>
      ) : (
        <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
          {loading && !items.length ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
          ) : !groups.length ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Brak użytkowników dla tego filtra.</div>
          ) : groups.map(g => {
            const meta = ROLE_META[g.role] || { label: "Inne", color: "var(--text-lo)", soft: "var(--surface-3)" };
            const sel = g.users.filter(selectable);
            const nSel = sel.filter(u => selected.has(u.id)).length;
            const active = g.users.filter(u => u.is_active).length;
            return (
              <div key={g.role}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)" }}>
                  <SelectBox checked={nSel > 0 && nSel === sel.length} indeterminate={nSel > 0 && nSel < sel.length}
                    disabled={!sel.length} onChange={() => toggleGroup(g.users)} label={`Zaznacz grupę ${meta.label}`}/>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: meta.color }}>{meta.label}</span>
                  <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{g.users.length} · {active} {pl(active, "aktywny", "aktywnych", "aktywnych")}</span>
                  {g.role === "ADMIN" && !viewerSuper && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-disabled)" }}>Kontami admin zarządza tylko super-admin</span>}
                </div>
                {g.users.map(u => {
                  const isSelf = isSelfU(u);
                  const exp = expanded?.id === u.id ? expanded.mode : null;
                  return (
                    <div key={u.id} style={{ borderBottom: "1px solid var(--border-soft)" }}>
                      <UserRow u={u} isSelf={isSelf} viewerSuper={viewerSuper} permsOpen={exp === "perms"}
                        selectable={selectable(u)} selected={selected.has(u.id)} onSelect={() => toggleSel(u.id)}
                        onChangeRole={(r) => changeRole(u, r)}
                        onToggleActive={() => toggleActive(u)}
                        onResetPassword={() => toggleMode(u.id, "reset")}
                        onDelete={() => remove(u)}
                        onPerms={() => toggleMode(u.id, "perms")}/>
                      {exp && (
                        <div style={{ padding: "0 14px 14px" }}>
                          {exp === "perms"
                            ? <PermissionsEditor user={u} isSelf={isSelf} onCancel={() => setExpanded(null)} onSaved={() => { setExpanded(null); load(); }}/>
                            : <ResetPasswordForm user={u} onCancel={() => setExpanded(null)} onDone={() => setExpanded(null)}/>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {selectedUsers.length > 0 && typeof document !== "undefined" && createPortal(
        <div style={{
          position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 16, zIndex: 900,
          width: "min(880px, calc(100% - 32px))", background: "var(--surface-2)", border: "1px solid var(--accent)",
          borderRadius: 12, boxShadow: "0 12px 40px oklch(0 0 0 / 0.5)",
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 12px",
        }}>
          <span className="num" style={{ fontWeight: 700, fontSize: 13, color: "var(--text-hi)" }}>{selectedUsers.length}</span>
          <span style={{ flex: "1 1 120px", minWidth: 0, fontSize: 11, color: "var(--text-lo)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedUsers.map(u => nameOf(u).split(" ")[0]).join(", ")}
          </span>
          <button onClick={() => setBulkModal("perms")} disabled={bulkBusy} style={btnPrimary}><ShieldIcon size={12}/> Uprawnienia…</button>
          <button onClick={() => setBulkModal("role")} disabled={bulkBusy} style={btnSecondary}>Zmień rolę…</button>
          <button onClick={bulkOnboarding} disabled={bulkBusy} style={btnSecondary}>Pokaż wprowadzenie</button>
          {anyInactiveSel && <button onClick={() => bulkActive(true)} disabled={bulkBusy} style={{ ...btnSecondary, color: "var(--ok)" }}>Aktywuj</button>}
          {anyActiveSel && <button onClick={() => bulkActive(false)} disabled={bulkBusy} style={{ ...btnSecondary, color: "var(--critical)" }}>Dezaktywuj</button>}
          <button onClick={() => setSelected(new Set())} style={btnGhost}>Wyczyść</button>
        </div>,
        document.body,
      )}

      {bulkModal === "perms" && selectedUsers.length > 0 && (
        <BulkPermsModal users={selectedUsers} busy={bulkBusy} onClose={() => setBulkModal(null)} onApply={bulkPerms}/>
      )}
      {bulkModal === "role" && selectedUsers.length > 0 && (
        <BulkRoleModal count={selectedUsers.length} viewerSuper={viewerSuper} busy={bulkBusy} onClose={() => setBulkModal(null)} onPick={bulkRole}/>
      )}
    </div>
  );
}

function RoleStat({ label, count, color, active, onClick }: { label: string; count: number; color: string; active?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} title={active ? "Pokaż wszystkie role" : `Pokaż tylko: ${label}`} style={{
      padding: 14, textAlign: "left", fontFamily: "inherit", cursor: "pointer", color: "inherit",
      background: active ? `color-mix(in oklch, ${color} 8%, var(--surface-1))` : "var(--surface-1)",
      border: `1px solid ${active ? color : "var(--border-soft)"}`, borderRadius: 10, transition: "border-color 0.12s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, background: color }}/>
        <span style={{ fontSize: 11, color: "var(--text-lo)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      </div>
      <div className="num" style={{ fontSize: 24, fontWeight: 600, color: "var(--text-hi)", marginTop: 6, letterSpacing: "-0.02em" }}>{count}</div>
    </button>
  );
}

// Checkbox w stylu aplikacji (z obsługą stanu „część zaznaczona”).
function SelectBox({ checked, indeterminate, disabled, onChange, label }: {
  checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: () => void; label: string;
}) {
  const on = checked || indeterminate;
  return (
    <button type="button" role="checkbox" aria-checked={indeterminate ? "mixed" : checked} aria-label={label} title={disabled ? undefined : label}
      disabled={disabled} onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!disabled) onChange(); }}
      style={{
        width: 16, height: 16, flexShrink: 0, padding: 0, borderRadius: 4,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: checked ? "var(--accent)" : indeterminate ? "var(--accent-soft)" : "transparent",
        border: `1px solid ${on ? "var(--accent)" : "var(--border-strong)"}`,
        color: checked ? "var(--accent-ink)" : "var(--accent)", fontSize: 11, fontWeight: 800, lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.25 : 1,
      }}>{checked ? "✓" : indeterminate ? "–" : ""}</button>
  );
}

function UserRow({ u, isSelf, viewerSuper, permsOpen, selectable, selected, onSelect, onChangeRole, onToggleActive, onResetPassword, onDelete, onPerms }: {
  u: UserRowT; isSelf: boolean; viewerSuper: boolean; permsOpen: boolean;
  selectable: boolean; selected: boolean; onSelect: () => void;
  onChangeRole: (r: string) => void; onToggleActive: () => void;
  onResetPassword: () => void; onDelete: () => void; onPerms: () => void;
}) {
  const meta = ROLE_META[u.role] || ROLE_META.VIEWER;
  const overrideCount = overridesOf(u);

  // Reguła: kontami ADMIN zarządza tylko super-admin. Zwykły admin nie tknie żadnego admina.
  // (super-admin jest dla innych "zwykłym" ADMINEM, więc i tak wpada w tę blokadę.)
  const lockedBase = viewerSuper ? false : (u.role === "ADMIN");
  const lockRole = lockedBase || isSelf;
  const lockActive = lockedBase || isSelf;
  const lockDelete = lockedBase || isSelf;
  const lockManage = lockedBase; // uprawnienia + reset hasła

  // Opcje roli: rolę ADMIN może nadawać wyłącznie super-admin
  const roleOptions = viewerSuper ? ["ADMIN", "IMPORT", "VIEWER"] : ["IMPORT", "VIEWER"];
  const restBg = selected ? "color-mix(in oklch, var(--accent) 7%, var(--surface-1))"
    : !u.is_active ? "color-mix(in oklch, var(--critical) 5%, var(--surface-1))" : "transparent";

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "auto auto minmax(0, 1fr) auto auto", gap: 12, alignItems: "center",
      padding: "12px 14px",
      background: restBg,
      opacity: u.is_active ? 1 : 0.7, transition: "background 0.12s",
    }}
      onMouseEnter={(e) => { if (u.is_active && !selected) e.currentTarget.style.background = "var(--surface-2)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = restBg; }}>
      <SelectBox checked={selected} disabled={!selectable} onChange={onSelect}
        label={isSelf ? "To Twoje konto" : !selectable ? "Brak uprawnień" : `Zaznacz: ${nameOf(u)}`}/>
      <Avatar initials={initialsOf(u.full_name, u.email)} size={36}/>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{u.full_name || u.email}</span>
          {u.is_super_admin && <Pill bg="var(--accent-soft)" fg="var(--accent)" dot="var(--accent)" size="sm">SUPER</Pill>}
          {isSelf && <Pill bg="var(--info-soft)" fg="var(--info)" size="sm">TY</Pill>}
          {!u.is_active && <Pill bg="var(--critical-soft)" fg="var(--critical)" size="sm">NIEAKTYWNE</Pill>}
          {overrideCount > 0 && <Pill bg="var(--anomaly-soft)" fg="var(--anomaly)" size="sm">{overrideCount} {pl(overrideCount, "wyjątek", "wyjątki", "wyjątków")}</Pill>}
          {(u.company_scope?.length ?? 0) > 0 && (
            <Pill bg="var(--accent-soft)" fg="var(--accent)" size="sm">
              {SCOPE_FIRMY.filter(f => u.company_scope!.includes(f.slug)).map(f => f.label).join(" + ")}
            </Pill>
          )}
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
        {viewerSuper && (() => {
          const actTs = parseTs(u.last_activity);
          const actMins = actTs ? (Date.now() - actTs.getTime()) / 60000 : null;
          const dotColor = actMins === null ? "var(--text-disabled)" : (actMins <= 20 ? "var(--ok)" : "var(--critical)");
          return (
            <div className="num" style={{ fontSize: 10, color: "var(--text-disabled)", marginTop: 2 }}>
              Ostatnie logowanie: {u.last_login ? fmtDateTime(u.last_login) : "nigdy"}
              {"   ·   "}
              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 99, background: dotColor, marginRight: 5, verticalAlign: "middle" }}/>
              Ostatnia zmiana: {u.last_activity ? fmtDateTime(u.last_activity) : "—"}
            </div>
          );
        })()}
      </div>

      <select value={u.role} onChange={(e) => onChangeRole(e.target.value)} disabled={lockRole} style={{
        padding: "5px 9px", fontSize: 11, fontWeight: 600, background: meta.soft, color: meta.color,
        border: `1px solid ${meta.color}`, borderRadius: 6, outline: "none",
        cursor: lockRole ? "not-allowed" : "pointer", opacity: lockRole ? 0.6 : 1,
      }}>
        {/* gdy bieżąca rola spoza dozwolonych opcji (np. ADMIN u nie-super) — pokaż ją, ale select i tak zablokowany */}
        {!roleOptions.includes(u.role) && <option value={u.role}>{ROLE_META[u.role]?.label || u.role}</option>}
        {roleOptions.map(r => <option key={r} value={r}>{ROLE_META[r]?.label || r}</option>)}
      </select>

      <div style={{ display: "flex", gap: 4 }}>
        <button onClick={() => !lockManage && onPerms()} title={lockManage ? "Brak uprawnień" : "Uprawnienia"} disabled={lockManage} style={userActionBtn("var(--accent)", permsOpen, lockManage)}><ShieldIcon size={13}/></button>
        <button onClick={() => !lockManage && onResetPassword()} title={lockManage ? "Brak uprawnień" : "Reset hasła"} disabled={lockManage} style={userActionBtn("var(--info)", false, lockManage)}><PasswordIcon size={12}/></button>
        <button onClick={() => !lockActive && onToggleActive()} title={u.is_active ? "Dezaktywuj" : "Aktywuj"} disabled={lockActive} style={userActionBtn(u.is_active ? "var(--warning)" : "var(--ok)", false, lockActive)}>
          {u.is_active ? <PauseIcon size={12}/> : <PlayIcon size={12}/>}
        </button>
        <button onClick={() => !lockDelete && onDelete()} title="Usuń" disabled={lockDelete} style={userActionBtn("var(--critical)", false, lockDelete)}><TrashIcon size={12}/></button>
      </div>
    </div>
  );
}

// ── Macierz uprawnień: osoby × uprawnienia ──────────────────
function PermMatrix({ groups, isLocked, busy, onToggle }: {
  groups: { role: string; users: UserRowT[] }[];
  isLocked: (u: UserRowT) => boolean; busy: boolean;
  onToggle: (u: UserRowT, key: string, label: string) => void;
}) {
  const permGroups = useMemo(permsByGroup, []);
  const cols = permGroups.flatMap(([, p]) => p);
  const th: React.CSSProperties = { position: "sticky", top: 0, background: "var(--bg-elevated)", fontSize: 10, fontWeight: 600, color: "var(--text-lo)", borderBottom: "1px solid var(--border-soft)" };
  const firstCol: React.CSSProperties = { position: "sticky", left: 0, background: "var(--surface-1)", zIndex: 1, textAlign: "left" };
  if (!groups.length) {
    return <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }}>Brak użytkowników dla tego filtra.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--text-lo)", alignItems: "center" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MatrixDot on/> ma uprawnienie</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MatrixDot on={false}/> nie ma</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MatrixDot on ovr/> wyjątek względem roli</span>
        <span>Kliknięcie w komórkę przełącza uprawnienie tej osobie.</span>
      </div>
      <div style={{ overflowX: "auto", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5, minWidth: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, ...firstCol, background: "var(--bg-elevated)", zIndex: 3 }}/>
              {permGroups.map(([g, p]) => (
                <th key={g} colSpan={p.length} style={{ ...th, padding: "6px 6px 2px", textAlign: "left", letterSpacing: "0.06em", textTransform: "uppercase", borderLeft: "1px solid var(--border-soft)", borderBottom: "none" }}>{g}</th>
              ))}
            </tr>
            <tr>
              <th style={{ ...th, ...firstCol, background: "var(--bg-elevated)", zIndex: 3, padding: "8px 12px", verticalAlign: "bottom" }}>Użytkownik</th>
              {cols.map(p => (
                <th key={p.key} title={p.desc} style={{ ...th, padding: "8px 4px", height: 150, verticalAlign: "bottom", whiteSpace: "nowrap" }}>
                  <span style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", display: "inline-block" }}>{p.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(g => {
              const meta = ROLE_META[g.role] || { label: "Inne", color: "var(--text-lo)" };
              return (
                <React.Fragment key={g.role}>
                  <tr>
                    <td colSpan={cols.length + 1} style={{ padding: "6px 12px", background: "var(--bg-elevated)", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: meta.color, borderBottom: "1px solid var(--border-soft)" }}>{meta.label}</td>
                  </tr>
                  {g.users.map(u => {
                    const locked = isLocked(u);
                    return (
                      <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.55 }}>
                        <td style={{ ...firstCol, padding: "7px 12px", borderBottom: "1px solid var(--border-soft)", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                          <span style={{ fontWeight: 600, color: "var(--text-hi)" }}>{nameOf(u)}</span>
                        </td>
                        {cols.map(p => {
                          const on = effPerm(u, p.key), ovr = isOverride(u, p.key);
                          return (
                            <td key={p.key} style={{ padding: "6px 4px", textAlign: "center", borderBottom: "1px solid var(--border-soft)" }}>
                              <button type="button" disabled={locked || busy} onClick={() => onToggle(u, p.key, p.label)}
                                title={`${nameOf(u)} · ${p.label}: ${on ? "tak" : "nie"}${ovr ? " (wyjątek)" : ""}`}
                                style={{ background: "none", border: "none", padding: 2, cursor: locked ? "not-allowed" : busy ? "wait" : "pointer", opacity: locked ? 0.35 : 1 }}>
                                <MatrixDot on={on} ovr={ovr}/>
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatrixDot({ on, ovr }: { on: boolean; ovr?: boolean }) {
  return (
    <span style={{
      width: 18, height: 18, borderRadius: 5, display: "inline-flex", alignItems: "center", justifyContent: "center", verticalAlign: "middle",
      background: on ? "var(--ok-soft)" : "transparent",
      border: `1px solid ${ovr ? "var(--anomaly)" : on ? "var(--ok)" : "var(--border)"}`,
      boxShadow: ovr ? "0 0 0 2px var(--anomaly-soft)" : "none",
    }}>
      {on && <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--ok)" }}/>}
    </span>
  );
}

// ── Modal (portal do body, z-index 1000 — wzorzec z tech-notes) ──
function UsersModal({ onClose, width, children }: { onClose: () => void; width: number; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "oklch(0 0 0 / 0.55)",
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto",
    }}>
      <div className="fade-in" role="dialog" style={{
        width: `min(${width}px, 100%)`, background: "var(--surface-1)", border: "1px solid var(--border)",
        borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 14,
      }}>{children}</div>
    </div>,
    document.body,
  );
}

function BulkPermsModal({ users, busy, onClose, onApply }: {
  users: UserRowT[]; busy: boolean; onClose: () => void; onApply: (ops: Record<string, BulkOp>) => void;
}) {
  const [ops, setOps] = useState<Record<string, BulkOp>>({});
  const n = users.length;
  const permGroups = useMemo(permsByGroup, []);
  const labelOf = (k: string) => PERMS.find(p => p.key === k)?.label || k;
  const roles = [...new Set(users.map(u => ROLE_META[u.role]?.label || u.role))];

  const setOp = (k: string, op: BulkOp | null) => setOps(prev => {
    const next = { ...prev }; if (op) next[k] = op; else delete next[k]; return next;
  });
  const applyPreset = (keys: string[]) => setOps(prev => {
    const next = { ...prev }; keys.forEach(k => { next[k] = "grant"; }); return next;
  });

  // Brakujące zależności: nadajemy X, a część osób nie ma (lub traci) tego, czego X wymaga.
  const missing = useMemo(() => {
    const m = new Set<string>();
    Object.entries(ops).forEach(([k, op]) => {
      if (op !== "grant") return;
      (PERM_REQUIRES[k] || []).forEach(req => {
        if (ops[req] === "grant") return;
        const after = (u: UserRowT) => ops[req] === "revoke" ? false : ops[req] === "default" ? roleDefault(u.role, req) : effPerm(u, req);
        if (users.some(u => !after(u))) m.add(req);
      });
    });
    return [...m];
  }, [ops, users]);

  // Ile ustawień faktycznie się zmieni (tak jak policzy backend).
  const { changes, touched } = useMemo(() => {
    let changes = 0; const touched = new Set<number>();
    users.forEach(u => Object.entries(ops).forEach(([k, op]) => {
      const def = roleDefault(u.role, k);
      const nv = op === "grant" ? true : op === "revoke" ? false : def;
      const willStore = op !== "default" && nv !== def;
      const changed = effPerm(u, k) !== nv || hasOwn(u.perms, k) !== willStore;
      if (changed) { changes++; touched.add(u.id); }
    }));
    return { changes, touched: touched.size };
  }, [ops, users]);

  const planned = Object.entries(ops);
  const opBtn = (k: string, op: BulkOp | null, label: string, fg: string, bg: string) => {
    const on = (ops[k] ?? null) === op;
    return (
      <button key={label} type="button" onClick={() => setOp(k, op)} title={op === "default" ? "Usuń wyjątek — wróć do ustawień roli" : undefined} style={{
        fontFamily: "inherit", fontSize: 10.5, fontWeight: 600, padding: "4px 7px", border: "none", borderLeft: op === null ? "none" : "1px solid var(--border)",
        background: on ? bg : "transparent", color: on ? fg : "var(--text-lo)", cursor: "pointer",
      }}>{label}</button>
    );
  };

  return (
    <UsersModal onClose={onClose} width={780}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <ShieldIcon size={15} color="var(--accent)"/>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>Uprawnienia dla {n} {pl(n, "osoby", "osób", "osób")}</span>
        <Pill bg="var(--surface-3)" fg="var(--text-mid)" size="sm">{roles.join(" + ")}</Pill>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--text-mid)", margin: 0, lineHeight: 1.55 }}>
        Ustawiasz tylko to, co chcesz zmienić — reszta zostaje jak jest u każdej osoby. „Nadaj” i „Odbierz” zapisują wyjątek
        (o ile różni się od roli), „Domyślne” usuwa wyjątek i wraca do ustawień roli. Przy każdym uprawnieniu widać, ile zaznaczonych osób ma je teraz.
      </p>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", marginRight: 4 }}>Pakiety</span>
        {PERM_PRESETS.map(p => (
          <button key={p.id} type="button" onClick={() => applyPreset(p.perms)} title={p.perms.map(labelOf).join(" + ")} style={{
            fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, padding: "5px 10px", borderRadius: 99,
            border: "1px dashed var(--border-strong)", background: "transparent", color: "var(--text-mid)", cursor: "pointer",
          }}>{p.label}</button>
        ))}
      </div>

      {missing.length > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "9px 12px", borderRadius: 8, fontSize: 11.5, color: "var(--text-mid)", background: "var(--warning-soft)", border: "1px solid color-mix(in oklch, var(--warning) 45%, transparent)" }}>
          <span style={{ flex: "1 1 260px" }}>
            <b style={{ color: "var(--warning)" }}>Brakuje zależności.</b>{" "}
            {missing.map(k => `„${labelOf(k)}”`).join(", ")} — bez tego nadawane uprawnienia nic nie pokażą części osób.
          </span>
          <button type="button" onClick={() => applyPreset(missing)} style={btnSecondary}>Nadaj też</button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        {permGroups.map(([group, perms]) => (
          <div key={group} style={{ border: "1px solid var(--border-soft)", borderRadius: 9, overflow: "hidden", minWidth: 0 }}>
            <div style={{ padding: "7px 12px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-soft)" }}>{group}</div>
            {perms.map((p, i) => {
              const has = users.filter(u => effPerm(u, p.key)).length;
              const changed = !!ops[p.key];
              return (
                <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: i ? "1px solid var(--border-soft)" : "none", background: changed ? "color-mix(in oklch, var(--accent) 6%, transparent)" : "transparent" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-hi)" }} title={p.desc}>{p.label}</div>
                    <div className="num" style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 1 }}>ma {has}/{n}</div>
                  </div>
                  <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
                    {opBtn(p.key, null, "—", "var(--text-hi)", "var(--surface-3)")}
                    {opBtn(p.key, "grant", "Nadaj", "var(--ok)", "var(--ok-soft)")}
                    {opBtn(p.key, "revoke", "Odbierz", "var(--critical)", "var(--critical-soft)")}
                    {opBtn(p.key, "default", "Domyślne", "var(--info)", "var(--info-soft)")}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-soft)", borderRadius: 9, padding: "10px 12px", fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 }}>
        {planned.length ? (
          <>
            Zmiana: {planned.map(([k, op], i) => (
              <React.Fragment key={k}>{i ? ", " : ""}<b style={{ color: "var(--text-hi)" }}>{op === "grant" ? "+" : op === "revoke" ? "−" : "↺"} {labelOf(k)}</b></React.Fragment>
            ))}
            <br/>Faktycznie zmieni się <b className="num" style={{ color: "var(--text-hi)" }}>{changes}</b> {pl(changes, "ustawienie", "ustawienia", "ustawień")} u <b className="num" style={{ color: "var(--text-hi)" }}>{touched}</b> {pl(touched, "osoby", "osób", "osób")}. W dzienniku audytu: jeden wpis na osobę.
          </>
        ) : "Nic jeszcze nie wybrano — kliknij „Nadaj”, „Odbierz” albo pakiet."}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <button onClick={onClose} disabled={busy} style={btnSecondary}>Anuluj</button>
        <button onClick={() => onApply(ops)} disabled={busy || !changes} style={{ ...btnPrimary, opacity: busy || !changes ? 0.5 : 1 }}>
          {busy ? "Zapisywanie…" : `Zapisz u ${touched} ${pl(touched, "osoby", "osób", "osób")}`}
        </button>
      </div>
    </UsersModal>
  );
}

function BulkRoleModal({ count, viewerSuper, busy, onClose, onPick }: {
  count: number; viewerSuper: boolean; busy: boolean; onClose: () => void; onPick: (role: string) => void;
}) {
  const options = viewerSuper ? [...ROLE_ORDER] : ROLE_ORDER.filter(r => r !== "ADMIN");
  return (
    <UsersModal onClose={onClose} width={460}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>Zmień rolę: {count} {pl(count, "osoba", "osoby", "osób")}</div>
      <p style={{ fontSize: 11.5, color: "var(--text-mid)", margin: 0, lineHeight: 1.55 }}>
        Wyjątki w uprawnieniach zostają bez zmian.{!viewerSuper && " Rolę Admin może nadać tylko super-admin."}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {options.map(r => {
          const m = ROLE_META[r];
          return (
            <button key={r} disabled={busy} onClick={() => onPick(r)} style={{
              fontFamily: "inherit", padding: "8px 16px", fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: busy ? "wait" : "pointer",
              background: m.soft, color: m.color, border: `1px solid ${m.color}`,
            }}>{m.label}</button>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={onClose} disabled={busy} style={btnSecondary}>Anuluj</button>
      </div>
    </UsersModal>
  );
}

function userActionBtn(color: string, active?: boolean, disabled?: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
    background: active ? "var(--accent-soft)" : "transparent",
    border: `1px solid ${active ? color : "var(--border-soft)"}`,
    color, borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1, transition: "all 0.12s",
  };
}

// ── Nowy użytkownik ─────────────────────────────────────────
function NewUserForm({ viewerSuper, onSaved, onCancel }: { viewerSuper: boolean; onSaved: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("VIEWER");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!email.trim() || !fullName.trim()) { toast("Podaj email i imię/nazwisko", "warning"); return; }
    if (password.length < 8) { toast("Hasło min. 8 znaków", "warning"); return; }
    setBusy(true);
    try {
      await api.post("/users", { email: email.trim(), full_name: fullName.trim(), role, password });
      toast("Dodano użytkownika", "ok"); onSaved();
    } catch { toast("Nie udało się dodać (email może już istnieć)", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 16, background: "var(--surface-2)", border: "1px solid var(--accent)", borderRadius: "var(--r-lg)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <SettingsField label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus placeholder="user@firma.pl" style={inputStyle} autoComplete="off" name="nu-email"/>
        </SettingsField>
        <SettingsField label="Imię i nazwisko">
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jan Kowalski" style={inputStyle} autoComplete="off" name="nu-fullname"/>
        </SettingsField>
        <SettingsField label="Rola">
          <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
            {viewerSuper && <option value="ADMIN">Admin</option>}
            <option value="IMPORT">Import</option>
            <option value="VIEWER">Viewer</option>
          </select>
        </SettingsField>
        <SettingsField label="Hasło startowe">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min. 8 znaków" style={inputStyle} autoComplete="new-password" name="nu-password"/>
        </SettingsField>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button onClick={onCancel} disabled={busy} style={btnSecondary}>Anuluj</button>
        <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "Dodawanie…" : "Dodaj użytkownika"}</button>
      </div>
    </div>
  );
}

// ── Edytor uprawnień ────────────────────────────────────────
function PermissionsEditor({ user, isSelf, onCancel, onSaved }: { user: UserRowT; isSelf?: boolean; onCancel: () => void; onSaved: () => void }) {
  const roleDefaults = ROLE_DEF[user.role] || {};
  const [draft, setDraft] = useState<Record<string, boolean>>(() => ({ ...(user.perms || {}) }));
  const [showOnb, setShowOnb] = useState<boolean>(!!user.show_onboarding);
  // Zakres firmowy: pusta lista = brak ograniczenia (backend zapisze NULL).
  const [scope, setScope] = useState<string[]>(() => (user.company_scope || []).filter(Boolean));
  const [busy, setBusy] = useState(false);
  const isSuper = user.is_super_admin;
  const scopeAll = scope.length === 0;
  const toggleFirma = (slug: string) =>
    setScope(prev => prev.includes(slug) ? prev.filter(x => x !== slug) : [...prev, slug]);

  const eff = (key: string) => Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : !!roleDefaults[key];
  const isOverridden = (key: string) => Object.prototype.hasOwnProperty.call(draft, key) && draft[key] !== !!roleDefaults[key];
  const toggle = (key: string) => {
    setDraft(prev => {
      const next = { ...prev };
      const newVal = !(Object.prototype.hasOwnProperty.call(prev, key) ? prev[key] : !!roleDefaults[key]);
      if (newVal === !!roleDefaults[key]) delete next[key];
      else next[key] = newVal;
      return next;
    });
  };
  const resetAll = () => { setDraft({}); setScope([]); };

  const groups = useMemo(() => {
    const g: Record<string, PermDef[]> = {};
    PERMS.forEach(p => { (g[p.group] = g[p.group] || []).push(p); });
    return g;
  }, []);
  const overrideCount = Object.keys(draft).filter(k => draft[k] !== !!roleDefaults[k]).length;

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/users/${user.id}`, { perms: draft, show_onboarding: showOnb, company_scope: scope });
      toast("Zapisano uprawnienia", "ok"); onSaved();
    } catch { toast("Nie udało się zapisać uprawnień", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fade-in" style={{ padding: 16, background: "var(--accent-soft)", border: "1px solid color-mix(in oklch, var(--accent) 40%, var(--border))", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <ShieldIcon size={15} color="var(--accent)"/>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-hi)" }}>Uprawnienia: {user.full_name || user.email}</span>
        <Pill bg="var(--surface-2)" fg="var(--text-mid)" size="sm">{ROLE_META[user.role]?.label || user.role}</Pill>
        {overrideCount > 0 && <Pill bg="var(--anomaly-soft)" fg="var(--anomaly)" size="sm">{overrideCount} wyjątki</Pill>}
        {!scopeAll && <Pill bg="var(--accent-soft)" fg="var(--accent)" size="sm">{SCOPE_FIRMY.filter(f => scope.includes(f.slug)).map(f => f.label).join(" + ")}</Pill>}
      </div>
      <p style={{ fontSize: 11, color: "var(--text-mid)", margin: "0 0 12px" }}>
        Najpierw wybierz firmy, potem uprawnienia — działają one w ramach wybranego zakresu (np. „Dane finansowe” = finanse wszystkich zaznaczonych firm).
        Domyślne uprawnienia wynikają z roli. Możesz je nadpisać indywidualnie dla tej osoby — np. dać Viewerowi edycję produktów albo ukryć komuś dane finansowe.
        {isSuper && " To konto super-administratora — widzisz stan rzeczywisty i możesz go zmieniać. Uwaga: backend nie robi wyjątku dla super-admina, więc odebranie sobie uprawnienia naprawdę je odbiera (konta i tak nie da się usunąć)."}
      </p>

      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ padding: "7px 12px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elevated)" }}>
          Dostęp do firm
        </div>
        <div style={{ padding: "11px 12px" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 9 }}>
            {SCOPE_FIRMY.map(f => {
              const on = scope.includes(f.slug);
              return (
                <button key={f.slug} onClick={() => { if (!isSelf) toggleFirma(f.slug); }}
                  disabled={isSelf}
                  title={isSelf ? "Nie możesz ograniczyć własnego konta do wybranych firm" : undefined}
                  style={{
                  opacity: isSelf ? 0.5 : 1, cursor: isSelf ? "not-allowed" : "pointer",
                  display: "inline-flex", alignItems: "center", gap: 7,
                  padding: "6px 13px", fontSize: 12, fontWeight: 600, borderRadius: 7,
                  background: on ? "var(--accent-soft)" : "var(--surface-2)",
                  color: on ? "var(--accent)" : "var(--text-mid)",
                  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                }}>
                  <span style={{
                    width: 13, height: 13, borderRadius: 4, flexShrink: 0,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    background: on ? "var(--accent)" : "transparent",
                    border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                    color: "var(--surface-1)", fontSize: 10, fontWeight: 700, lineHeight: 1,
                  }}>{on ? "✓" : ""}</span>
                  {f.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 10, color: scopeAll ? "var(--text-lo)" : "var(--accent)", lineHeight: 1.5 }}>
            {isSelf
              ? "To Twoje konto — zakresu firm nie można ograniczyć samemu sobie (stracił(a)byś dostęp do panelu bez możliwości cofnięcia)."
              : scopeAll
              ? "Nic nie zaznaczone = dostęp do wszystkich firm (obecne zachowanie). Zaznacz firmy, żeby ograniczyć."
              : `Widzi dane wyłącznie tych firm: ${SCOPE_FIRMY.filter(f => scope.includes(f.slug)).map(f => f.label).join(", ")}. Przełącznik firm w pasku pokaże tylko te zakładki, bez opcji „Wszyscy”.`}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {Object.entries(groups).map(([group, perms]) => (
          <div key={group} style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "7px 12px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elevated)" }}>{group}</div>
            {perms.map(perm => {
              const on = eff(perm.key);
              const ovr = isOverridden(perm.key);
              return (
                <div key={perm.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderTop: "1px solid var(--border-soft)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-hi)" }}>{perm.label}</span>
                      {ovr && <span title="Nadpisane względem roli" style={{ width: 6, height: 6, borderRadius: 99, background: "var(--anomaly)" }}/>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 1 }}>{perm.desc}</div>
                  </div>
                  <Toggle on={on} onClick={() => toggle(perm.key)}/>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, padding: "11px 14px", background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-hi)" }}>Pokaż wprowadzenie (onboarding)</div>
          <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 1 }}>
            {showOnb ? "Przy następnym logowaniu zobaczy przewodnik po aplikacji" : "Loguje się prosto do Dashboardu"}
          </div>
        </div>
        <Toggle on={showOnb} onClick={() => setShowOnb(v => !v)}/>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
        <button onClick={resetAll} style={btnGhostMini}><I.Refresh size={11}/> Przywróć domyślne roli i pełny dostęp</button>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} disabled={busy} style={btnSecondary}>Anuluj</button>
          <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "Zapisywanie…" : "Zapisz uprawnienia"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Reset hasła (inline) ────────────────────────────────────
function ResetPasswordForm({ user, onCancel, onDone }: { user: UserRowT; onCancel: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const checks = { len: password.length >= 8, upper: /[A-Z]/.test(password), digit: /[0-9]/.test(password) };
  const valid = checks.len && checks.upper && checks.digit;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try { await api.put(`/users/${user.id}/password`, { new_password: password }); toast("Hasło zresetowane", "ok"); onDone(); }
    catch { toast("Nie udało się zresetować hasła", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fade-in" style={{ padding: 14, background: "var(--info-soft)", border: "1px solid color-mix(in oklch, var(--info) 40%, var(--border))", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <PasswordIcon size={14} color="var(--info)"/>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Reset hasła: <span className="mono" style={{ color: "var(--info)" }}>{user.email}</span></span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
            placeholder="Nowe hasło (min. 8 znaków, A, 1)" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}/>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <PwdHint ok={checks.len} label="8+ znaków"/>
            <PwdHint ok={checks.upper} label="A-Z"/>
            <PwdHint ok={checks.digit} label="0-9"/>
          </div>
        </div>
        <button onClick={onCancel} disabled={busy} style={btnSecondary}>Anuluj</button>
        <button onClick={submit} disabled={!valid || busy} style={{ ...btnPrimary, background: "var(--info)", borderColor: "var(--info)", color: "white", opacity: valid ? 1 : 0.5, cursor: valid ? "pointer" : "not-allowed" }}>
          {busy ? "…" : "Ustaw hasło"}
        </button>
      </div>
    </div>
  );
}

function PwdHint({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: ok ? "var(--ok)" : "var(--text-lo)" }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: ok ? "var(--ok)" : "var(--text-disabled)" }}/>{label}
    </span>
  );
}

// ============================================================
// MOJE KONTO
// ============================================================
// Samodzielne włączenie/wyłączenie wprowadzenia dla bieżącego użytkownika.
function OnboardingSelfCard() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.get("/auth/me");
        setOn(!!(me as { show_onboarding?: boolean })?.show_onboarding);
      } catch { setOn(false); }
    })();
  }, []);

  const toggle = async () => {
    if (on === null || busy) return;
    const nextVal = !on;
    setBusy(true);
    try {
      await api.patch("/auth/me/onboarding", { show_onboarding: nextVal });
      setOn(nextVal);
      toast(nextVal ? "Wprowadzenie pokaże się przy następnym logowaniu" : "Wprowadzenie wyłączone", "ok");
    } catch { toast("Nie udało się zmienić ustawienia", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Wprowadzenie (onboarding)</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-lo)" }}>
            Włącz, aby ekran powitalny pokazał się ponownie przy następnym logowaniu.
          </p>
        </div>
        <Toggle on={!!on} disabled={on === null || busy} onClick={toggle}/>
      </div>
    </div>
  );
}

function AccountPanel() {
  const user = useUser() as CtxUser;
  const name = user?.full_name || user?.name || user?.email || "";
  const email = user?.email || "";
  const role = user?.role || "VIEWER";
  const superUser = isSuperUser(user);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);

  const change = async () => {
    if (!current || !next) { toast("Uzupełnij hasła", "warning"); return; }
    if (next.length < 8) { toast("Nowe hasło min. 8 znaków", "warning"); return; }
    if (next !== repeat) { toast("Hasła się nie zgadzają", "warning"); return; }
    setBusy(true);
    try {
      await api.put("/auth/me/password", { current_password: current, new_password: next });
      toast("Hasło zmienione", "ok");
      setCurrent(""); setNext(""); setRepeat("");
    } catch { toast("Nie udało się zmienić hasła (sprawdź obecne)", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Avatar initials={initialsOf(name, email)} size={56}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-hi)" }}>{name}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 2 }}>{email}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
              <Pill bg="var(--accent-soft)" fg="var(--accent)" dot="var(--accent)" size="sm">{role}</Pill>
              {superUser && <Pill bg="var(--ok-soft)" fg="var(--ok)" size="sm">SUPER ADMIN</Pill>}
            </div>
          </div>
        </div>
      </div>

      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: 18 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 600 }}>Zmiana hasła</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <SettingsField label="Obecne hasło">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="••••••••" style={inputStyle}/>
          </SettingsField>
          <SettingsField label="Nowe hasło">
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="min. 8 znaków" style={inputStyle}/>
          </SettingsField>
          <SettingsField label="Powtórz nowe hasło">
            <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} placeholder="••••••••" style={inputStyle}/>
          </SettingsField>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={change} disabled={busy} style={btnPrimary}>{busy ? "Zmienianie…" : "Zmień hasło"}</button>
        </div>
      </div>

      <OnboardingSelfCard/>

      <SessionsPanel/>
    </div>
  );
}

// ── Aktywne sesje ───────────────────────────────────────────
function SessionsPanel() {
  const [rows, setRows] = useState<SessionT[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await api.get("/auth/me/sessions");
      setRows(Array.isArray(data) ? (data as SessionT[]) : []);
    } catch { /* sesje opcjonalne — cisza */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (s: SessionT) => {
    try { await api.del(`/auth/me/sessions/${s.id}`); toast("Sesja usunięta z listy", "ok"); setRows(rs => rs.filter(r => r.id !== s.id)); }
    catch { toast("Nie udało się usunąć sesji", "error"); }
  };

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Aktywne sesje</h3>
        <span style={{ fontSize: 10, color: "var(--text-lo)" }}>rejestr logowań</span>
      </div>
      {loading ? (
        <div style={{ padding: 12, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : !rows.length ? (
        <div style={{ padding: 12, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Brak zarejestrowanych sesji</div>
      ) : rows.map((s, i) => (
        <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--border-soft)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: s.current ? "var(--ok)" : "var(--text-disabled)", flexShrink: 0 }}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{parseDevice(s.device)}</div>
            <div style={{ fontSize: 11, color: "var(--text-lo)" }}>
              {s.ip || "—"} · {s.current ? "aktywna teraz" : fmtDateTime(s.created_at)}
            </div>
          </div>
          {s.current
            ? <Pill bg="var(--ok-soft)" fg="var(--ok)" size="sm">TA SESJA</Pill>
            : <button onClick={() => remove(s)} style={{ ...btnGhostMini, color: "var(--critical)" }}>Usuń</button>}
        </div>
      ))}
      <p style={{ fontSize: 10, color: "var(--text-disabled)", margin: "10px 0 0" }}>
        Usunięcie wpisu czyści go z listy. Token logowania jest bezstanowy (JWT) — zdalne wylogowanie urządzenia będzie dodane osobno.
      </p>
    </div>
  );
}

// ============================================================
// DZIENNIK AUDYTU (tylko super-admin)
// ============================================================
// Backend oddaje gotowe zdania (message) i zmiany „było → jest” (changes) — tu tylko je
// pokazujemy. Wpisy sprzed przebudowy mają zdanie odtworzone przy odczycie (legacy).
type AuditPage = { rows: AuditRow[]; more: boolean; users: string[]; obszary: string[] };

const auditDay = (s: string) => {
  const d = parseTs(s);
  if (!d) return "—";
  const dzien = (x: Date) => x.toLocaleDateString("pl-PL", { day: "numeric", month: "long", year: "numeric" });
  const dzis = new Date();
  const wczoraj = new Date(); wczoraj.setDate(dzis.getDate() - 1);
  if (dzien(d) === dzien(dzis)) return `Dziś · ${dzien(d)}`;
  if (dzien(d) === dzien(wczoraj)) return `Wczoraj · ${dzien(d)}`;
  return d.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};
const zmianLabel = (n: number) =>
  n === 1 ? "zmiana" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? "zmiany" : "zmian";
const auditTime = (s: string) => {
  const d = parseTs(s);
  return d ? d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "—";
};

// Zdanie z wyróżnionym autorem (e-mail na początku) i obiektem (resource_id).
function AuditMessage({ r }: { r: AuditRow }) {
  let rest = r.message;
  let who: string | null = null;
  if (r.user_email && rest.startsWith(r.user_email + " ")) {
    who = r.user_email;
    rest = rest.slice(r.user_email.length);
  }
  const obj = r.resource_id && r.resource_id.length > 1 ? r.resource_id : null;
  const at = obj ? rest.indexOf(obj) : -1;
  return (
    <>
      {who && <span style={{ fontWeight: 600, color: "var(--text-hi)" }}>{who}</span>}
      {at < 0 ? rest : <>
        {rest.slice(0, at)}
        <span style={{ fontWeight: 500, color: "var(--text-hi)" }}>{obj}</span>
        {rest.slice(at + (obj as string).length)}
      </>}
    </>
  );
}

function AuditChanges({ changes }: { changes: AuditChange[] }) {
  return (
    <div style={{ marginTop: 8, border: "1px solid var(--border-soft)", borderRadius: 8, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ background: "var(--surface-2)" }}>
            {["Pole", "Było", "Jest"].map(h => (
              <th key={h} style={{ textAlign: "left", padding: "6px 10px", fontWeight: 500, fontSize: 11, color: "var(--text-lo)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {changes.map((c, i) => (
            <tr key={i} style={{ borderTop: "1px solid var(--border-soft)" }}>
              <td style={{ padding: "6px 10px", color: "var(--text-mid)", whiteSpace: "nowrap" }}>{c.pole}</td>
              <td className="num" style={{ padding: "6px 10px", color: c.bylo ? "var(--critical)" : "var(--text-lo)", wordBreak: "break-word" }}>{c.bylo}</td>
              <td className="num" style={{ padding: "6px 10px", color: c.jest ? "var(--ok)" : "var(--text-lo)", wordBreak: "break-word" }}>{c.jest}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditLogPanel() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [users, setUsers] = useState<string[]>([]);
  const [obszary, setObszary] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [area, setArea] = useState("");
  const [od, setOd] = useState("");
  const [doo, setDo] = useState("");
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [tech, setTech] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());

  // Szukajka strzela dopiero po chwili bez pisania, a nie na każdą literę.
  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const fetchPage = async (offset: number, limit = 100) => {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (email) qs.set("user_email", email);
    if (area) qs.set("area", area);
    if (od) qs.set("od", od);
    if (doo) qs.set("do", doo);
    if (qDeb) qs.set("q", qDeb);
    return (await api.get(`/audit-log?${qs}`)) as AuditPage;
  };

  useEffect(() => {
    let alive = true;
    setRows(null);
    fetchPage(0)
      .then(p => {
        if (!alive) return;
        setRows(p.rows); setMore(p.more);
        if (p.users?.length) setUsers(p.users);
        if (p.obszary?.length) setObszary(p.obszary);
      })
      .catch(() => { if (alive) { toast("Nie udało się pobrać dziennika audytu", "error"); setRows([]); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, area, od, doo, qDeb]);

  const loadMore = async () => {
    if (!rows) return;
    setLoadingMore(true);
    try {
      const p = await fetchPage(rows.length);
      setRows([...rows, ...p.rows]);
      setMore(p.more);
    } catch { toast("Nie udało się doczytać starszych wpisów", "error"); }
    finally { setLoadingMore(false); }
  };

  const toggle = (id: number) => setOpen(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // Eksport: wszystko, co pasuje do filtrów (do 500 najnowszych), nie tylko to, co już wczytane.
  const doExport = async () => {
    try {
      const p = await fetchPage(0, 500);
      const cols: CsvColumn<AuditRow>[] = [
        { label: "Czas", get: (r) => fmtDateTime(r.created_at) },
        { label: "Uzytkownik", get: (r) => r.user_email || "" },
        { label: "Obszar", get: (r) => r.area },
        { label: "Opis", get: (r) => r.message },
        { label: "Zmiany", get: (r) => (r.changes || []).map(c => `${c.pole}: ${c.bylo || "—"} → ${c.jest || "—"}`).join("; ") },
        { label: "Surowy zapis", get: (r) => `${r.action} ${r.details || ""}`.trim() },
      ];
      exportCsv("dziennik-audytu", cols, p.rows);
    } catch { toast("Nie udało się wyeksportować dziennika", "error"); }
  };

  const filtered = !!(email || area || od || doo || qDeb);
  const fieldStyle: React.CSSProperties = { ...inputStyle, width: "auto", fontSize: 12, padding: "7px 10px" };
  const chip = (on: boolean): React.CSSProperties => ({
    fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
    border: `1px solid ${on ? "var(--text-hi)" : "var(--border-soft)"}`,
    background: on ? "var(--text-hi)" : "transparent", color: on ? "var(--surface-1)" : "var(--text-mid)",
  });

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
      {/* Filtry */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-soft)", display: "flex", flexWrap: "wrap", gap: 8 }}>
        <input id="audit-q" style={{ ...fieldStyle, flex: "1 1 220px" }} value={q} onChange={e => setQ(e.target.value)}
               placeholder="Szukaj: SKU, nr kontenera, e-mail…"/>
        <select id="audit-user" style={fieldStyle} value={email} onChange={e => setEmail(e.target.value)}>
          <option value="">Wszyscy użytkownicy</option>
          {users.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <input id="audit-od" type="date" style={fieldStyle} value={od} onChange={e => setOd(e.target.value)} title="Od"/>
        <input id="audit-do" type="date" style={fieldStyle} value={doo} onChange={e => setDo(e.target.value)} title="Do"/>
        {filtered && (
          <button style={btnGhostMini} onClick={() => { setEmail(""); setArea(""); setOd(""); setDo(""); setQ(""); }}>
            Wyczyść
          </button>
        )}
      </div>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-soft)", display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button style={chip(!area)} onClick={() => setArea("")}>Wszystko</button>
        {obszary.map(a => <button key={a} style={chip(area === a)} onClick={() => setArea(area === a ? "" : a)}>{a}</button>)}
      </div>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{rows ? rows.length : "…"}</span>
          {more ? "+" : ""} {rows && rows.length === 1 ? "zdarzenie" : "zdarzeń"}
        </span>
        <span style={{ flex: 1 }}/>
        <label style={{ fontSize: 12, color: "var(--text-lo)", display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input id="audit-tech" type="checkbox" checked={tech} onChange={e => setTech(e.target.checked)}/> Szczegóły techniczne
        </label>
        <button onClick={doExport} disabled={!rows?.length} style={btnSecondary}><I.ArrowUp size={12}/> Eksport CSV</button>
      </div>

      {rows === null ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : !rows.length ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>
          {filtered ? "Nic nie pasuje do filtrów." : "Brak zdarzeń"}
        </div>
      ) : (
        <div>
          {rows.map((r, i) => {
            const day = auditDay(r.created_at);
            const newDay = i === 0 || auditDay(rows[i - 1].created_at) !== day;
            const ch = r.changes || [];
            const expandable = ch.length > 0;
            const isOpen = open.has(r.id);
            const failed = r.action === "LOGIN_FAILED" || r.action === "LOGIN_BLOCKED";
            return (
              <React.Fragment key={r.id}>
                {newDay && (
                  <div style={{
                    padding: "8px 16px", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase",
                    color: "var(--text-lo)", background: "var(--surface-2)", borderBottom: "1px solid var(--border-soft)",
                  }}>{day}</div>
                )}
                <div
                  role={expandable ? "button" : undefined}
                  tabIndex={expandable ? 0 : undefined}
                  aria-expanded={expandable ? isOpen : undefined}
                  onClick={() => expandable && toggle(r.id)}
                  onKeyDown={e => { if (expandable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(r.id); } }}
                  style={{
                    display: "grid", gridTemplateColumns: "52px minmax(0,1fr) auto", gap: 14, alignItems: "start",
                    padding: "10px 16px", borderBottom: "1px solid var(--border-soft)",
                    cursor: expandable ? "pointer" : "default", transition: "background 0.12s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <span className="num" style={{ fontSize: 12, color: "var(--text-lo)", paddingTop: 1 }}>{auditTime(r.created_at)}</span>
                  <div style={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-mid)" }}>
                    <AuditMessage r={r}/>
                    {expandable && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-lo)" }}>
                        {isOpen ? "▾" : "▸"} {ch.length} {zmianLabel(ch.length)}
                      </span>
                    )}
                    {(tech || r.legacy) && (
                      <div className="mono" style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 3, overflowWrap: "anywhere" }}>
                        {r.action}{r.details ? ` · ${r.details}` : ""}
                      </div>
                    )}
                    {isOpen && <AuditChanges changes={ch}/>}
                  </div>
                  <span style={{
                    fontSize: 10.5, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap",
                    border: `1px ${r.legacy ? "dashed" : "solid"} ${failed ? "var(--critical)" : "var(--border-soft)"}`,
                    color: failed ? "var(--critical)" : "var(--text-lo)",
                  }} title={r.legacy ? "Wpis sprzed przebudowy dziennika — bez wartości było → jest" : undefined}>
                    {r.legacy ? "wpis sprzed zmiany" : r.area}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
          {more && (
            <div style={{ padding: 12, display: "flex", justifyContent: "center" }}>
              <button style={btnSecondary} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Wczytuję…" : "Załaduj starsze"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// IKONY AKCJI (SVG inline — spójne z mockiem)
// ============================================================
function ShieldIcon({ size = 13, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>
    </svg>
  );
}
function PasswordIcon({ size = 13, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}
function PauseIcon({ size = 12 }: { size?: number }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>);
}
function PlayIcon({ size = 12 }: { size?: number }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>);
}
function TrashIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
    </svg>
  );
}

// ============================================================
// HELPERY
// ============================================================
function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 11px", fontSize: 13,
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7,
  color: "var(--text-hi)", outline: "none", fontFamily: "inherit",
};
const btnGhost: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px",
  background: "transparent", border: "none", color: "var(--text-mid)",
  fontSize: 11, fontWeight: 500, borderRadius: 6, cursor: "pointer",
};
const btnGhostMini: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px",
  background: "transparent", border: "1px solid var(--border-soft)", color: "var(--text-mid)",
  borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: "pointer",
};

// ── ŚWIEŻOŚĆ DANYCH ──────────────────────────────────────────
type FreshInfo = {
  sellasist?: { last: string | null; count: number };
  subiekt?: { last: string | null; count: number };
  fakturownia?: { last: string | null; count: number };
};
type BackupRow = {
  id: number; started_at?: string | null; finished_at?: string | null;
  ok?: boolean | null; message?: string | null; error?: string | null;
  details?: BackupDetails;
};
type BackupDetails = {
  artifact?: string; size_mb?: number; public_tables?: number; auth_users?: number;
  attachments_with_data?: number; attachments_total?: number; storage_objects?: number;
};
// Odpowiedź GET /api/fakturownia-sales/braki — pozycje faktur bez rozpoznanego SKU.
type BrakiInfo = {
  pozycji: number;
  netto: number;
  produkty: Array<{
    shop: string;
    product_id: string | null;
    nazwa: string | null;
    pozycji: number;
    sztuk: number;
    netto: number;
    przyklad_faktury: string | null;
  }>;
};

type BackupStatus = {
  status: "ok" | "error" | "stale" | "unknown";
  stale_hours: number;
  last_attempt?: BackupRow | null;
  last_ok?: BackupRow | null;
  details?: BackupDetails;
  history?: BackupRow[];
};

type SyncRow = {
  id: number; source: string; started_at?: string | null; finished_at?: string | null;
  ok?: boolean | null; inserted?: number; updated?: number; items_added?: number;
  message?: string | null; error?: string | null;
};

function FreshCard({ title, info }: { title: string; info?: { last: string | null; count: number } }) {
  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 10,
      padding: "14px 16px", background: "var(--bg-elevated)",
    }}>
      <div style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{title}</div>
      <div className="num" style={{ fontSize: 18, fontWeight: 600, marginTop: 6 }}>{fmtLocalDt(info?.last)}</div>
    </div>
  );
}

// Kafelek nocnego backupu bazy. Stoi w rzędzie ze świeżością danych, ale mówi o czymś
// innym: tamte kafelki pokazują KIEDY pobraliśmy dane, ten — czy mamy z czego odtworzyć
// bazę. Dlatego jako jedyny ma kropkę statusu; brak backupu to problem, brak pobrania nie.
const BACKUP_TONE = {
  ok:      { color: "var(--ok)",       label: "OK" },
  error:   { color: "var(--critical)", label: "BŁĄD" },
  stale:   { color: "var(--warning)",  label: "UWAGA" },
  unknown: { color: "var(--text-lo)",  label: "BRAK DANYCH" },
} as const;

function BackupCard({ data, onClick }: { data: BackupStatus | null; onClick?: () => void }) {
  const tone = BACKUP_TONE[data?.status ?? "unknown"];
  const d = data?.details ?? {};
  const last = data?.last_ok?.finished_at || data?.last_ok?.started_at;
  // Przy błędzie pokazujemy datę OSTATNIEJ UDANEJ kopii, nie nieudanej próby — to ta
  // liczba mówi, jak stare dane realnie mamy.
  const sub =
    data?.status === "error" ? (data.last_attempt?.error || "Ostatnia próba nie powiodła się")
    : data?.status === "stale" ? `Brak świeżej kopii od ponad ${data.stale_hours} h`
    : data?.status === "unknown" ? "Brak wpisów w dzienniku"
    : [d.size_mb != null ? `${d.size_mb} MB` : null,
       d.public_tables != null ? `${d.public_tables} tabel` : null,
       d.attachments_total ? `${d.attachments_with_data}/${d.attachments_total} zał.` : null,
      ].filter(Boolean).join(" · ");

  return (
    <div onClick={onClick} style={{
      border: "1px solid var(--border)", borderRadius: 10,
      padding: "14px 16px", background: "var(--bg-elevated)",
      cursor: onClick ? "pointer" : "default",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Backup bazy
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, color: tone.color }}>
          <span style={{ width: 7, height: 7, borderRadius: 99, background: tone.color }}/> {tone.label}
        </span>
      </div>
      <div className="num" style={{ fontSize: 18, fontWeight: 600, marginTop: 6 }}>{fmtLocalDt(last)}</div>
      <div style={{
        fontSize: 11, marginTop: 4, color: data?.status === "ok" ? "var(--text-lo)" : tone.color,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }} title={sub}>{sub || "—"}</div>
    </div>
  );
}

function FreshnessPanel() {
  const [fresh, setFresh] = useState<FreshInfo | null>(null);
  const [rows, setRows] = useState<SyncRow[]>([]);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [showBackupHist, setShowBackupHist] = useState(false);
  // Pozycje z faktur Fakturowni, których nie udało się zmapować na SKU. Ingesta ich
  // NIE wyrzuca — zapisuje z sku_source='BRAK', żeby brakujący towar był widocznym
  // problemem, a nie cichym ubytkiem w obrocie. Pobierane leniwie, dopiero po kliknięciu.
  const [braki, setBraki] = useState<BrakiInfo | null>(null);
  const [brakiOpen, setBrakiOpen] = useState(false);
  const [brakiLoading, setBrakiLoading] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      // allSettled, nie all — gdyby backup-status padł (stary backend, brak tabeli),
      // panel świeżości ma się załadować normalnie zamiast zniknąć w całości.
      const [f, l, b] = await Promise.allSettled([
        api.get("/data-freshness"), api.get("/sync-log"), api.get("/backup-status"),
      ]);
      if (f.status === "fulfilled") setFresh(f.value as FreshInfo);
      if (l.status === "fulfilled") setRows(Array.isArray(l.value) ? (l.value as SyncRow[]) : []);
      setBackup(b.status === "fulfilled" ? (b.value as BackupStatus) : null);
    } catch {
      /* cicho — panel informacyjny */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const toggleBraki = async () => {
    const otwieram = !brakiOpen;
    setBrakiOpen(otwieram);
    if (!otwieram || braki !== null) return;
    setBrakiLoading(true);
    try {
      setBraki(await api.get("/fakturownia-sales/braki") as BrakiInfo);
    } catch {
      setBraki({ pozycji: 0, netto: 0, produkty: [] });   // endpoint tylko dla ADMIN
    } finally {
      setBrakiLoading(false);
    }
  };

  const th: React.CSSProperties = {
    textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 600,
    color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.03em",
    borderBottom: "1px solid var(--border)", whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = {
    padding: "8px 10px", fontSize: 12, color: "var(--text-mid)",
    borderBottom: "1px solid var(--border-soft)", verticalAlign: "top",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* auto-fit zamiast sztywnych 3 kolumn — czwarty kafelek nie ściska pozostałych
          na wąskim ekranie, tylko zjeżdża do drugiego rzędu. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
        <FreshCard title="Ostatnie pobranie Sellasist" info={fresh?.sellasist}/>
        <FreshCard title="Ostatnie pobranie Subiekt AMH" info={fresh?.subiekt}/>
        <FreshCard title="Ostatnie pobranie Fakturownia" info={fresh?.fakturownia}/>
        <BackupCard data={backup} onClick={() => setShowBackupHist((v) => !v)}/>
      </div>

      {showBackupHist && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px", fontSize: 12, fontWeight: 600, color: "var(--text-hi)", borderBottom: "1px solid var(--border-soft)" }}>
            Historia backupów
          </div>
          {(backup?.history ?? []).length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-lo)" }}>Brak wpisów.</div>
          ) : (backup?.history ?? []).map((h) => {
            const ok = h.ok === true && !h.error;
            return (
              <div key={h.id} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                fontSize: 12, borderTop: "1px solid var(--border-soft)",
              }}>
                <span style={{ color: ok ? "var(--ok)" : "var(--critical)", fontWeight: 700 }}>{ok ? "✓" : "✕"}</span>
                <span className="num" style={{ color: "var(--text-mid)", minWidth: 110 }}>{fmtLocalDt(h.finished_at || h.started_at)}</span>
                <span className="num" style={{ color: "var(--text-lo)", minWidth: 70 }}>{h.details?.size_mb != null ? `${h.details.size_mb} MB` : "—"}</span>
                <span style={{ color: h.error ? "var(--critical)" : "var(--text-lo)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.error || h.details?.artifact || h.message || "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>Dziennik pobrań</span>
        <button onClick={toggleBraki} style={btnSecondary} disabled={brakiLoading}>
          <I.Alert size={14}/> {brakiLoading ? "Ładowanie…" : "Pozycje bez SKU"}
          {braki && braki.pozycji > 0 ? ` (${braki.pozycji})` : ""}
        </button>
        <button onClick={load} style={btnSecondary} disabled={loading}>
          <I.Refresh size={14}/> {loading ? "Ładowanie…" : "Odśwież widok"}
        </button>
      </div>

      {brakiOpen && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px", fontSize: 12, borderBottom: "1px solid var(--border-soft)", color: "var(--text-mid)" }}>
            <b style={{ color: "var(--text-hi)" }}>Pozycje faktur bez rozpoznanego SKU</b>
            {braki && braki.pozycji > 0 && (
              <span className="num" style={{ marginLeft: 8, color: "var(--warning)" }}>
                {braki.pozycji} poz. · {fmtPLN(braki.netto)}
              </span>
            )}
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-lo)" }}>
              Wchodzą do przychodu, wypadają z rozbicia per SKU. Zwykle karta produktu w Fakturowni
              bez wypełnionego pola „kod”, albo pozycja wpisana na fakturę z ręki (brak product_id).
            </div>
          </div>
          {brakiLoading ? (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-lo)" }}>Ładowanie…</div>
          ) : !braki || braki.produkty.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--ok)" }}>
              Wszystkie pozycje zmapowane.
            </div>
          ) : braki.produkty.map((b, idx) => (
            <div key={`${b.shop}-${b.product_id ?? idx}`} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
              fontSize: 12, borderTop: "1px solid var(--border-soft)",
            }}>
              <span style={{ color: "var(--text-lo)", minWidth: 52, textTransform: "uppercase" }}>{b.shop}</span>
              <span style={{ color: "var(--text-mid)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {b.nazwa || "—"}
              </span>
              <span className="num" style={{ color: "var(--text-lo)", minWidth: 60, textAlign: "right" }}>{b.sztuk} szt.</span>
              <span className="num" style={{ color: "var(--text-hi)", minWidth: 90, textAlign: "right" }}>{fmtPLN(b.netto)}</span>
              <span className="num" style={{ color: "var(--text-lo)", minWidth: 110, textAlign: "right" }}>{b.przyklad_faktury || "—"}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        <table style={{ width: "100%", minWidth: 600, borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Źródło</th>
              <th style={th}>Zakończono</th>
              <th style={th}>Status</th>
              <th style={th}>Dodane</th>
              <th style={th}>Zmienione</th>
              <th style={th}>Pozycje</th>
              <th style={{ ...th, width: "30%" }}>Informacja</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td style={{ ...td, color: "var(--text-lo)" }} colSpan={7}>
                {loading ? "Ładowanie…" : "Brak wpisów — pierwszy pojawi się po najbliższym pobraniu."}
              </td></tr>
            )}
            {rows.map((r) => {
              const ok = r.ok !== false && !r.error;
              return (
                <tr key={r.id}>
                  <td style={{ ...td, fontWeight: 600, color: "var(--text-hi)" }}>
                    {(() => {
                      const s = r.source || "";
                      if (s === "subiekt" || s.startsWith("subiekt:")) return "Subiekt AMH";
                      if (s.startsWith("sellasist:")) {
                        const sh = s.slice(10);
                        return sh ? `Sellasist · ${sh.toUpperCase()}` : "Sellasist";
                      }
                      if (s === "sellasist") return "Sellasist";
                      if (s.startsWith("fakturownia:")) {
                        const sh = s.slice(12);
                        return sh ? `Fakturownia · ${sh.charAt(0).toUpperCase()}${sh.slice(1)}` : "Fakturownia";
                      }
                      if (s === "fakturownia") return "Fakturownia";
                      if (s === "supabase_backup") return "Backup Supabase";
                      // Domyślnie: pokaż surowe źródło z kropką zamiast dwukropka, zamiast mylącego „Sellasist".
                      return s ? s.replace(":", " · ") : "—";
                    })()}
                  </td>
                  <td style={td} className="num">{fmtLocalDt(r.finished_at || r.started_at)}</td>
                  <td style={td}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
                      color: ok ? "var(--ok)" : "var(--critical)",
                      background: `color-mix(in oklch, ${ok ? "var(--ok)" : "var(--critical)"} 14%, transparent)`,
                    }}>{ok ? "OK" : "Błąd"}</span>
                  </td>
                  <td style={td} className="num">{r.inserted ?? 0}</td>
                  <td style={td} className="num">{r.updated ?? 0}</td>
                  <td style={td} className="num">{r.items_added ?? 0}</td>
                  <td style={{ ...td, color: r.error ? "var(--critical)" : "var(--text-lo)" }}>
                    {r.error || r.message || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-lo)", margin: 0 }}>
        Sellasist trafia tu po każdym pobraniu (ręcznym i automatycznym 7–17). Subiekt pojawi się,
        gdy skrypt na serwerze będzie dopisywał wpis do dziennika.
      </p>
    </div>
  );
}

export { SettingsView };
export default SettingsView;
