"use client";
// ============================================================
// MAGAZYN — Ustawienia (rozbudowa). Port settings.jsx + users-panel.jsx → .tsx.
//   Producenci      GET/POST/PATCH/DELETE /manufacturers  (+ osoba kontaktowa, liczniki SKU/zamówień)
//   Typy kontenerów GET/POST/PATCH/DELETE /container-types
//   Użytkownicy     /users (ADMIN): inline rola, 4 ikony akcji, edytor uprawnień, reset hasła
//   Moje konto      profil + PUT /auth/me/password + aktywne sesje (/auth/me/sessions)
//   Dziennik audytu GET /audit-log (super-admin) + eksport CSV
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, Card, Pill, Avatar } from "./ui";
import { btnPrimary, btnSecondary } from "./products-ui";
import { api } from "@/lib/api";
import { toast, exportCsv, type CsvColumn } from "./toast";
import { useUser, isAdmin, canEdit, PERMISSIONS, ROLE_PERMS } from "@/lib/permissions";

// ── Typy ─────────────────────────────────────────────────────
type Manufacturer = {
  id: number; name: string; color: string; notes?: string | null;
  email?: string | null; contact?: string | null; sku_count?: number; open_orders?: number;
};
type ContainerType = { id: number; name: string; capacity_cbm: number; sort_order: number };
type UserRowT = {
  id: number; email: string; full_name?: string | null; role: string;
  is_active: boolean; is_super_admin: boolean; created_at: string; last_login?: string | null;
  updated_at?: string | null; last_activity?: string | null;
  perms?: Record<string, boolean> | null; show_onboarding?: boolean;
};
type AuditRow = {
  id: number; user_id?: number | null; user_email?: string | null;
  action: string; resource_type?: string | null; resource_id?: string | null;
  details?: string | null; created_at: string;
};
type SessionT = { id: number; device?: string | null; ip?: string | null; created_at: string; current: boolean };

type PermDef = { key: string; label: string; desc: string; group: string };
const PERMS = PERMISSIONS as unknown as PermDef[];
const ROLE_DEF = ROLE_PERMS as unknown as Record<string, Record<string, boolean>>;

type SectionId = "manufacturers" | "firmy" | "container_types" | "users" | "account" | "audit" | "freshness";
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
  { id: "users",           label: "Użytkownicy",     icon: I.Activity, desc: "Konta, role, uprawnienia" },
  { id: "account",         label: "Moje konto",      icon: I.Settings, desc: "Hasło, sesje" },
  { id: "audit",           label: "Dziennik audytu", icon: I.Bell,     desc: "Historia zmian w systemie" },
  { id: "freshness",       label: "Świeżość danych", icon: I.Refresh,  desc: "Ostatnie pobrania i dziennik synchronizacji" },
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
} = {}) {
  const user = useUser() as CtxUser;
  const admin = isAdmin(user);
  const superUser = isSuperUser(user);

  const visibleSections = SETTINGS_SECTIONS.filter(s => {
    if (s.id === "users") return admin;
    if (s.id === "audit") return superUser;
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
          {section === "users"           && <UsersPanel currentUserId={user?.id}/>}
          {section === "account"         && <AccountPanel/>}
          {section === "audit"           && <AuditLogPanel/>}
          {section === "freshness"       && <FreshnessPanel/>}
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
            onSaved={() => { setEditingId(null); load(); }}
            onCancel={() => setEditingId(null)} showEdit={showEdit}/>
        ))}
      </div>
    </div>
  );
}

function ManufacturerRow({ item, editing, isLast, onEdit, onSaved, onCancel, showEdit }: {
  item: Manufacturer | null; editing: boolean; isLast: boolean;
  onEdit?: () => void; onSaved: () => void; onCancel: () => void; showEdit?: boolean;
}) {
  const [name, setName] = useState(item?.name || "");
  const [color, setColor] = useState(item?.color || COLOR_OPTIONS[0]);
  const [email, setEmail] = useState(item?.email || "");
  const [contact, setContact] = useState(item?.contact || "");
  const [notes, setNotes] = useState(item?.notes || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) { toast("Podaj nazwę producenta", "warning"); return; }
    setBusy(true);
    try {
      const body = { name: name.trim(), color, email: email.trim() || null, contact: contact.trim() || null, notes: notes.trim() || null };
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
        <SettingsField label="Notatki">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="np. LT 90 dni, MOQ 50 szt" style={inputStyle}/>
        </SettingsField>
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
// FIRMY (sklepy: AMH / Acti / Veluxa)
// ============================================================
type Firma = {
  id: number; slug: string; name: string; color?: string | null; is_self: boolean;
  base_url?: string | null; api_key_env?: string | null; key_present: boolean;
  configured: boolean; sort_order: number;
};

function FirmaePanel() {
  const user = useUser() as CtxUser;
  const showEdit = isAdmin(user);
  const [items, setItems] = useState<Firma[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = async () => {
    try {
      const data = await api.get("/firmy");
      setItems(Array.isArray(data) ? (data as Firma[]) : []);
    } catch { toast("Nie udało się pobrać firm", "error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span style={{ fontSize: 12, color: "var(--text-lo)", lineHeight: 1.5 }}>
        Sklepy = źródła sprzedaży i zapasu. <b style={{ color: "var(--text-mid)" }}>AMH</b> to hub (stan z Subiektu).
        Acti i Veluxa ciągniemy z ich Sellasista — uzupełnij <span className="num">base_url</span>; klucz API jest w zmiennej środowiskowej na Railway (nie w bazie).
      </span>
      {loading && !items.length ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {items.map(f => (
            <FirmaCard key={f.id} item={f}
              editing={editingId === f.id} onEdit={() => setEditingId(f.id)}
              onSaved={() => { setEditingId(null); load(); }} onCancel={() => setEditingId(null)} showEdit={showEdit}/>
          ))}
        </div>
      )}
    </div>
  );
}

function FirmaCard({ item, editing, onEdit, onSaved, onCancel, showEdit }: {
  item: Firma; editing: boolean; onEdit: () => void; onSaved: () => void; onCancel: () => void; showEdit: boolean;
}) {
  const [baseUrl, setBaseUrl] = useState(item.base_url || "");
  const [color, setColor] = useState(item.color || "#6b7280");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/firmy/${item.id}`, { base_url: baseUrl.trim() || null, color });
      toast("Zapisano firmę", "ok"); onSaved();
    } catch { toast("Nie udało się zapisać", "error"); }
    finally { setBusy(false); }
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
      </div>
    </div>
  );
}

// ============================================================
// UŻYTKOWNICY (tylko ADMIN)
// ============================================================
function UsersPanel({ currentUserId }: { currentUserId?: number | string }) {
  const viewerSuper = isSuperUser(useUser() as CtxUser);
  const [items, setItems] = useState<UserRowT[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<{ id: number; mode: "perms" | "reset" } | null>(null);

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

  const counts = useMemo(() => items.reduce<Record<string, number>>((a, u) => { a[u.role] = (a[u.role] || 0) + 1; return a; }, {}), [items]);

  const patchUser = async (id: number, body: Record<string, unknown>, okMsg: string) => {
    try { await api.patch(`/users/${id}`, body); toast(okMsg, "ok"); load(); }
    catch { toast("Nie udało się zapisać", "error"); }
  };
  const changeRole = (u: UserRowT, role: string) => patchUser(u.id, { role }, "Zmieniono rolę");
  const toggleActive = (u: UserRowT) => patchUser(u.id, { is_active: !u.is_active }, u.is_active ? "Dezaktywowano konto" : "Aktywowano konto");
  const remove = async (u: UserRowT) => {
    if (!window.confirm(`Usunąć użytkownika „${u.full_name || u.email}"? Tej operacji nie można cofnąć.`)) return;
    try { await api.del(`/users/${u.id}`); toast("Usunięto użytkownika", "ok"); load(); }
    catch { toast("Nie udało się usunąć", "error"); }
  };
  const toggleMode = (id: number, mode: "perms" | "reset") =>
    setExpanded(e => (e?.id === id && e.mode === mode) ? null : { id, mode });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        <RoleStat label="Admin"  count={counts.ADMIN || 0}  color={ROLE_META.ADMIN.color}/>
        <RoleStat label="Import" count={counts.IMPORT || 0} color={ROLE_META.IMPORT.color}/>
        <RoleStat label="Viewer" count={counts.VIEWER || 0} color={ROLE_META.VIEWER.color}/>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{items.length}</span> użytkowników w systemie
        </span>
        <button onClick={() => setCreating(true)} style={btnPrimary}><I.Plus size={12}/> Dodaj użytkownika</button>
      </div>

      {creating && <NewUserForm viewerSuper={viewerSuper} onSaved={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)}/>}

      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
        {loading && !items.length ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
        ) : items.map((u, i) => {
          const isSelf = String(u.id) === String(currentUserId);
          const exp = expanded?.id === u.id ? expanded.mode : null;
          return (
            <div key={u.id} style={{ borderBottom: i === items.length - 1 ? "none" : "1px solid var(--border-soft)" }}>
              <UserRow u={u} isSelf={isSelf} viewerSuper={viewerSuper} permsOpen={exp === "perms"}
                onChangeRole={(r) => changeRole(u, r)}
                onToggleActive={() => toggleActive(u)}
                onResetPassword={() => toggleMode(u.id, "reset")}
                onDelete={() => remove(u)}
                onPerms={() => toggleMode(u.id, "perms")}/>
              {exp && (
                <div style={{ padding: "0 14px 14px" }}>
                  {exp === "perms"
                    ? <PermissionsEditor user={u} onCancel={() => setExpanded(null)} onSaved={() => { setExpanded(null); load(); }}/>
                    : <ResetPasswordForm user={u} onCancel={() => setExpanded(null)} onDone={() => setExpanded(null)}/>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoleStat({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ padding: 14, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, background: color }}/>
        <span style={{ fontSize: 11, color: "var(--text-lo)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      </div>
      <div className="num" style={{ fontSize: 24, fontWeight: 600, color: "var(--text-hi)", marginTop: 6, letterSpacing: "-0.02em" }}>{count}</div>
    </div>
  );
}

function UserRow({ u, isSelf, viewerSuper, permsOpen, onChangeRole, onToggleActive, onResetPassword, onDelete, onPerms }: {
  u: UserRowT; isSelf: boolean; viewerSuper: boolean; permsOpen: boolean;
  onChangeRole: (r: string) => void; onToggleActive: () => void;
  onResetPassword: () => void; onDelete: () => void; onPerms: () => void;
}) {
  const meta = ROLE_META[u.role] || ROLE_META.VIEWER;
  const overrideCount = u.perms ? Object.keys(u.perms).length : 0;

  // Reguła: kontami ADMIN zarządza tylko super-admin. Zwykły admin nie tknie żadnego admina.
  // (super-admin jest dla innych "zwykłym" ADMINEM, więc i tak wpada w tę blokadę.)
  const lockedBase = viewerSuper ? false : (u.role === "ADMIN");
  const lockRole = lockedBase || isSelf;
  const lockActive = lockedBase || isSelf;
  const lockDelete = lockedBase || isSelf;
  const lockManage = lockedBase; // uprawnienia + reset hasła

  // Opcje roli: rolę ADMIN może nadawać wyłącznie super-admin
  const roleOptions = viewerSuper ? ["ADMIN", "IMPORT", "VIEWER"] : ["IMPORT", "VIEWER"];

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto auto", gap: 12, alignItems: "center",
      padding: "12px 14px",
      background: !u.is_active ? "color-mix(in oklch, var(--critical) 5%, var(--surface-1))" : "transparent",
      opacity: u.is_active ? 1 : 0.7, transition: "background 0.12s",
    }}
      onMouseEnter={(e) => { if (u.is_active) e.currentTarget.style.background = "var(--surface-2)"; }}
      onMouseLeave={(e) => { if (u.is_active) e.currentTarget.style.background = "transparent"; }}>
      <Avatar initials={initialsOf(u.full_name, u.email)} size={36}/>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{u.full_name || u.email}</span>
          {u.is_super_admin && <Pill bg="var(--accent-soft)" fg="var(--accent)" dot="var(--accent)" size="sm">SUPER</Pill>}
          {isSelf && <Pill bg="var(--info-soft)" fg="var(--info)" size="sm">TY</Pill>}
          {!u.is_active && <Pill bg="var(--critical-soft)" fg="var(--critical)" size="sm">NIEAKTYWNE</Pill>}
          {overrideCount > 0 && <Pill bg="var(--anomaly-soft)" fg="var(--anomaly)" size="sm">{overrideCount} wyjątki</Pill>}
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
function PermissionsEditor({ user, onCancel, onSaved }: { user: UserRowT; onCancel: () => void; onSaved: () => void }) {
  const roleDefaults = ROLE_DEF[user.role] || {};
  const [draft, setDraft] = useState<Record<string, boolean>>(() => ({ ...(user.perms || {}) }));
  const [showOnb, setShowOnb] = useState<boolean>(!!user.show_onboarding);
  const [busy, setBusy] = useState(false);
  const isSuper = user.is_super_admin;

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
  const resetAll = () => setDraft({});

  const groups = useMemo(() => {
    const g: Record<string, PermDef[]> = {};
    PERMS.forEach(p => { (g[p.group] = g[p.group] || []).push(p); });
    return g;
  }, []);
  const overrideCount = Object.keys(draft).filter(k => draft[k] !== !!roleDefaults[k]).length;

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/users/${user.id}`, { perms: draft, show_onboarding: showOnb });
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
      </div>
      <p style={{ fontSize: 11, color: "var(--text-mid)", margin: "0 0 12px" }}>
        Domyślne uprawnienia wynikają z roli. Możesz je nadpisać indywidualnie dla tej osoby — np. dać Viewerowi edycję produktów albo ukryć komuś dane finansowe.
        {isSuper && " Super-admin ma zawsze pełny dostęp (zablokowane)."}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {Object.entries(groups).map(([group, perms]) => (
          <div key={group} style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "7px 12px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-lo)", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elevated)" }}>{group}</div>
            {perms.map(perm => {
              const on = isSuper ? true : eff(perm.key);
              const ovr = !isSuper && isOverridden(perm.key);
              return (
                <div key={perm.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderTop: "1px solid var(--border-soft)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-hi)" }}>{perm.label}</span>
                      {ovr && <span title="Nadpisane względem roli" style={{ width: 6, height: 6, borderRadius: 99, background: "var(--anomaly)" }}/>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-lo)", marginTop: 1 }}>{perm.desc}</div>
                  </div>
                  <Toggle on={on} disabled={isSuper} onClick={() => toggle(perm.key)}/>
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
        <button onClick={resetAll} style={btnGhostMini}><I.Refresh size={11}/> Przywróć domyślne roli</button>
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
// Zamiana surowego wpisu audytu na opis po polsku
const RES_LABELS: Record<string, string> = {
  products: "produkt", containers: "kontener", "container-types": "typ kontenera",
  manufacturers: "producent", users: "użytkownik", auth: "konto", attachments: "załącznik",
};
function parsePyDict(s?: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const j = s.replace(/'/g, '"').replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
    const v = JSON.parse(j);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}
const permLabel = (k: string) => PERMS.find(p => p.key === k)?.label || k;

function humanizeAudit(r: AuditRow): string {
  const a = r.action || "";
  switch (a) {
    case "LOGIN": return "Zalogowanie do systemu";
    case "LOGIN_FAILED": return "Nieudane logowanie";
    case "LOGIN_BLOCKED": return "Logowanie zablokowane (konto nieaktywne)";
    case "PASSWORD_CHANGED": return "Zmiana własnego hasła";
    case "PASSWORD_RESET_BY_ADMIN": return "Reset hasła użytkownika";
    case "USER_CREATED": return "Utworzenie użytkownika";
    case "USER_DELETED": return "Usunięcie użytkownika";
    case "USER_UPDATED": {
      const d = parsePyDict(r.details);
      if (!d) return "Zmiana ustawień użytkownika";
      const parts: string[] = [];
      if (typeof d.role === "string") parts.push(`nadano rolę ${ROLE_META[d.role]?.label || d.role}`);
      if (typeof d.is_active === "boolean") parts.push(d.is_active ? "aktywacja konta" : "dezaktywacja konta");
      if (typeof d.full_name === "string") parts.push("zmiana nazwy");
      if (d.perms && typeof d.perms === "object") {
        const pd = d.perms as Record<string, unknown>;
        const keys = Object.keys(pd);
        if (!keys.length) parts.push("przywrócono domyślne uprawnienia roli");
        else keys.forEach(k => parts.push(`${pd[k] ? "włączono" : "wyłączono"} „${permLabel(k)}"`));
      }
      if (typeof d.show_onboarding === "boolean") parts.push(d.show_onboarding ? "włączono onboarding" : "wyłączono onboarding");
      return parts.length ? `Zmiana ustawień: ${parts.join("; ")}` : "Zmiana ustawień użytkownika";
    }
  }
  const m = a.match(/^([A-Z-]+)_(CREATED|UPDATED|DELETED)$/);
  if (m) {
    const verb = m[2] === "CREATED" ? "Dodano" : m[2] === "DELETED" ? "Usunięto" : "Zmieniono";
    const res = RES_LABELS[m[1].toLowerCase()] || m[1].toLowerCase();
    return `${verb}: ${res}`;
  }
  return "";
}

function AuditLogPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await api.get("/audit-log");
        if (mounted) setRows(Array.isArray(data) ? (data as AuditRow[]) : []);
      } catch { if (mounted) toast("Nie udało się pobrać dziennika audytu", "error"); }
      finally { if (mounted) setLoading(false); }
    })();
    return () => { mounted = false; };
  }, []);

  const target = (r: AuditRow) => [r.resource_type, r.resource_id].filter(Boolean).join(" ") + (r.details ? ` — ${r.details}` : "");

  const doExport = () => {
    const cols: CsvColumn<AuditRow>[] = [
      { label: "Czas", get: (r) => fmtDateTime(r.created_at) },
      { label: "Uzytkownik", get: (r) => r.user_email || "" },
      { key: "action", label: "Akcja" },
      { label: "Opis", get: (r) => humanizeAudit(r) },
      { label: "Obiekt", get: (r) => target(r) },
    ];
    exportCsv("audyt", cols, rows);
  };

  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-soft)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{rows.length}</span> zdarzeń
        </span>
        <button onClick={doExport} disabled={!rows.length} style={btnSecondary}><I.ArrowUp size={12}/> Eksport</button>
      </div>
      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : !rows.length ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Brak zdarzeń</div>
      ) : rows.map((r, i) => (
        <div key={r.id} style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 16, padding: "10px 16px", borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--border-soft)", transition: "background 0.12s" }}
          onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-2)"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
          <span className="num" style={{ fontSize: 11, color: "var(--text-lo)" }}>{fmtDateTime(r.created_at)}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ fontSize: 12 }}>
              <span style={{ fontWeight: 600, color: "var(--text-hi)" }}>{r.user_email || "system"}</span>
              <span style={{ color: "var(--text-mid)" }}> · {r.action}</span>
              {humanizeAudit(r) && <span style={{ color: "var(--text-mid)" }}> — {humanizeAudit(r)}</span>}
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-lo)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{target(r)}</span>
          </div>
        </div>
      ))}
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
      <div style={{ fontSize: 12, color: "var(--text-lo)", marginTop: 4 }}>
        {info && info.count != null ? `${info.count.toLocaleString("pl-PL")} rekordów w bazie` : "—"}
      </div>
    </div>
  );
}

function FreshnessPanel() {
  const [fresh, setFresh] = useState<FreshInfo | null>(null);
  const [rows, setRows] = useState<SyncRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [f, l] = await Promise.all([api.get("/data-freshness"), api.get("/sync-log")]);
      setFresh(f as FreshInfo);
      setRows(Array.isArray(l) ? (l as SyncRow[]) : []);
    } catch {
      /* cicho — panel informacyjny */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FreshCard title="Ostatnie pobranie Sellasist" info={fresh?.sellasist}/>
        <FreshCard title="Ostatnie pobranie Subiekt" info={fresh?.subiekt}/>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>Dziennik pobrań</span>
        <button onClick={load} style={btnSecondary} disabled={loading}>
          <I.Refresh size={14}/> {loading ? "Ładowanie…" : "Odśwież widok"}
        </button>
      </div>

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
                    {r.source === "subiekt" ? "Subiekt" : "Sellasist"}
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
