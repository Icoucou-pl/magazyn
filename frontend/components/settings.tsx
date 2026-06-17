"use client";
// ============================================================
// MAGAZYN — Ustawienia. Port settings.jsx → .tsx.
//   5 paneli, wszystkie na realnym API (CRUD już istnieje w backendzie):
//     • Producenci      GET/POST/PATCH/DELETE /manufacturers
//     • Typy kontenerów GET/POST/PATCH/DELETE /container-types
//     • Użytkownicy     GET/POST/PATCH/DELETE /users (+ PUT /users/{id}/password)  [tylko ADMIN]
//     • Moje konto      profil z kontekstu + PUT /auth/me/password
//     • Dziennik audytu GET /audit-log  [tylko super-admin]
//   Różnice vs mock: pole „kontakt", liczniki SKU/openOrders i lista „sesji"
//   pominięte — nie ma ich w backendzie. Reszta 1:1.
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, Card, Pill, Avatar } from "./ui";
import { btnPrimary, btnSecondary } from "./products-ui";
import { api } from "@/lib/api";
import { toast, exportCsv, type CsvColumn } from "./toast";
import { useUser, isAdmin, canEdit } from "@/lib/permissions";

// ── Typy ─────────────────────────────────────────────────────
type Manufacturer = { id: number; name: string; color: string; notes?: string | null; email?: string | null };
type ContainerType = { id: number; name: string; capacity_cbm: number; sort_order: number };
type UserRow = {
  id: number; email: string; full_name?: string | null; role: string;
  is_active: boolean; is_super_admin: boolean; created_at: string; last_login?: string | null;
};
type AuditRow = {
  id: number; user_id?: number | null; user_email?: string | null;
  action: string; resource_type?: string | null; resource_id?: string | null;
  details?: string | null; created_at: string;
};

type SectionId = "manufacturers" | "container_types" | "users" | "account" | "audit";
type SectionDef = { id: SectionId; label: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; desc: string };

// Zalogowany user z kontekstu (permissions.js jest w JS → kontekst nietypowany)
type CtxUser = {
  id?: number | string; email?: string; name?: string; full_name?: string;
  role?: string; isSuper?: boolean; is_super_admin?: boolean;
} | null;

// ── Stałe ────────────────────────────────────────────────────
const SETTINGS_SECTIONS: SectionDef[] = [
  { id: "manufacturers",   label: "Producenci",      icon: I.Factory,  desc: "Dostawcy, kolory, kontakty" },
  { id: "container_types", label: "Typy kontenerów", icon: I.Ship,     desc: "Pojemność CBM, sortowanie" },
  { id: "users",           label: "Użytkownicy",     icon: I.Activity, desc: "Konta, role, dostęp" },
  { id: "account",         label: "Moje konto",      icon: I.Settings, desc: "Hasło, preferencje" },
  { id: "audit",           label: "Dziennik audytu", icon: I.Bell,     desc: "Historia zmian w systemie" },
];

const ROLE_META: Record<string, { label: string; fg: string; bg: string }> = {
  ADMIN:  { label: "Admin",  fg: "var(--accent)",   bg: "var(--accent-soft)" },
  IMPORT: { label: "Import", fg: "var(--info)",     bg: "var(--info-soft)" },
  VIEWER: { label: "Viewer", fg: "var(--text-mid)", bg: "var(--surface-2)" },
};

const COLOR_OPTIONS = [
  "oklch(0.70 0.16 25)", "oklch(0.74 0.15 90)", "oklch(0.68 0.14 240)", "oklch(0.72 0.14 150)",
  "oklch(0.70 0.16 305)", "oklch(0.72 0.16 200)", "oklch(0.70 0.16 50)", "oklch(0.68 0.16 340)",
];

// Czy zalogowany user jest super-adminem (kontekst trzyma surowy UserOut → is_super_admin)
const isSuperUser = (u: { isSuper?: boolean; is_super_admin?: boolean } | null) =>
  Boolean(u?.isSuper ?? u?.is_super_admin);

const initialsOf = (name?: string | null, email?: string) => {
  const src = (name && name.trim()) || email || "";
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
};

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtDateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString("pl-PL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

// ── Widok główny ─────────────────────────────────────────────
function SettingsView() {
  const user = useUser() as CtxUser;
  const admin = isAdmin(user);
  const superUser = isSuperUser(user);

  const visibleSections = SETTINGS_SECTIONS.filter(s => {
    if (s.id === "users") return admin;
    if (s.id === "audit") return superUser;
    return true;
  });
  const [section, setSection] = useState<SectionId>(visibleSections[0]?.id || "account");

  const activeSection = SETTINGS_SECTIONS.find(s => s.id === section);

  return (
    <div className="fade-in" style={{ paddingBottom: 80 }}>
      <div className="settings-layout" style={{ display: "grid", gridTemplateColumns: "240px minmax(0, 1fr)", gap: 14 }}>
        {/* Sidebar */}
        <aside className="settings-sidebar" style={{
          background: "var(--surface-1)", border: "1px solid var(--border-soft)",
          borderRadius: "var(--r-lg)", padding: 6, height: "fit-content",
          position: "sticky", top: 76,
        }}>
          {visibleSections.map(s => {
            const active = section === s.id;
            const Icon = s.icon;
            return (
              <button key={s.id} onClick={() => setSection(s.id)} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 12px",
                background: active ? "var(--surface-3)" : "transparent",
                color: active ? "var(--text-hi)" : "var(--text-mid)",
                border: "none", borderRadius: 8,
                fontSize: 13, fontWeight: active ? 600 : 500,
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

        {/* Content */}
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
          {section === "manufacturers"   && <ManufacturersPanel/>}
          {section === "container_types" && <ContainerTypesPanel/>}
          {section === "users"           && <UsersPanel currentUserId={user?.id}/>}
          {section === "account"         && <AccountPanel/>}
          {section === "audit"           && <AuditLogPanel/>}
        </main>
      </div>

      <style>{`
        @media (max-width: 880px) {
          .settings-layout { grid-template-columns: 1fr !important; }
          .settings-sidebar {
            position: relative !important; top: 0 !important;
            display: flex !important; overflow-x: auto; padding: 4px !important; gap: 4px;
          }
          .settings-sidebar > button { flex-shrink: 0; }
        }
      `}</style>
    </div>
  );
}

// ============================================================
// PRODUCENCI
// ============================================================
function ManufacturersPanel() {
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{items.length}</span> producentów
        </span>
        {showEdit && (
          <button onClick={() => setCreating(true)} style={btnPrimary}><I.Plus size={12}/> Dodaj producenta</button>
        )}
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
          <ManufacturerRow
            key={m.id} item={m}
            editing={editingId === m.id}
            isLast={i === items.length - 1}
            onEdit={() => setEditingId(m.id)}
            onSaved={() => { setEditingId(null); load(); }}
            onCancel={() => setEditingId(null)}
            showEdit={showEdit}
          />
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
  const [notes, setNotes] = useState(item?.notes || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) { toast("Podaj nazwę producenta", "warning"); return; }
    setBusy(true);
    try {
      const body = { name: name.trim(), color, email: email.trim() || null, notes: notes.trim() || null };
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
          <SettingsField label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="orders@example.com" style={inputStyle}/>
          </SettingsField>
        </div>
        <SettingsField label="Kolor identyfikacyjny">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {COLOR_OPTIONS.map(c => (
              <button key={c} onClick={() => setColor(c)} style={{
                width: 24, height: 24, borderRadius: 6, background: c,
                border: color === c ? "2px solid var(--text-hi)" : "2px solid transparent",
                cursor: "pointer", padding: 0,
                boxShadow: color === c ? "0 0 0 2px var(--surface-2)" : "none",
              }}/>
            ))}
          </div>
        </SettingsField>
        <SettingsField label="Notatki">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="np. LT 90 dni, MOQ 50 szt, osoba kontaktowa" style={inputStyle}/>
        </SettingsField>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
          {item ? (
            <button onClick={remove} disabled={busy} style={{ ...btnGhost, color: "var(--critical)" }}>Usuń producenta</button>
          ) : <span/>}
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
        border: `1px solid ${item.color}`,
        display: "flex", alignItems: "center", justifyContent: "center", color: item.color, flexShrink: 0,
      }}>
        <I.Factory size={16}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{item.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-lo)", marginTop: 3 }}>
          <span className="mono">{item.email || "—"}</span>
          {item.notes && (<><span>·</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.notes}</span></>)}
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
        {showEdit && (
          <button onClick={() => setCreating(true)} style={btnPrimary}><I.Plus size={12}/> Dodaj typ</button>
        )}
      </div>

      {loading && !items.length ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
          {sorted.map(t => (
            <ContainerTypeCard key={t.id} item={t} maxCapacity={maxCapacity}
              editing={editingId === t.id}
              onEdit={() => setEditingId(t.id)}
              onSaved={() => { setEditingId(null); load(); }}
              onCancel={() => setEditingId(null)}
              showEdit={showEdit}/>
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
      toast(item ? "Zapisano typ" : "Dodano typ", "ok");
      onSaved();
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
          {item ? (
            <button onClick={remove} disabled={busy} style={{ ...btnGhost, color: "var(--critical)" }}>Usuń</button>
          ) : <span/>}
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
// UŻYTKOWNICY (tylko ADMIN)
// ============================================================
function UsersPanel({ currentUserId }: { currentUserId?: number | string }) {
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const data = await api.get("/users");
      setItems(Array.isArray(data) ? (data as UserRow[]) : []);
    } catch { toast("Nie udało się pobrać użytkowników", "error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => items.reduce<Record<string, number>>((a, u) => { a[u.role] = (a[u.role] || 0) + 1; return a; }, {}), [items]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        <RoleStat label="Admin"  count={counts.ADMIN || 0}  meta={ROLE_META.ADMIN}/>
        <RoleStat label="Import" count={counts.IMPORT || 0} meta={ROLE_META.IMPORT}/>
        <RoleStat label="Viewer" count={counts.VIEWER || 0} meta={ROLE_META.VIEWER}/>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>
          <span className="num" style={{ color: "var(--text-hi)", fontWeight: 600 }}>{items.length}</span> użytkowników w systemie
        </span>
        <button onClick={() => setCreating(true)} style={btnPrimary}><I.Plus size={12}/> Dodaj użytkownika</button>
      </div>

      {creating && <UserEditor onSaved={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)}/>}

      <div style={{ background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
        {loading && !items.length ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-lo)", fontSize: 12 }}>Ładowanie…</div>
        ) : items.map((u, i) => {
          const meta = ROLE_META[u.role] || ROLE_META.VIEWER;
          if (editingId === u.id) {
            return <UserEditor key={u.id} item={u} isSelf={String(u.id) === String(currentUserId)}
              onSaved={() => { setEditingId(null); load(); }} onCancel={() => setEditingId(null)}/>;
          }
          return (
            <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderBottom: i === items.length - 1 ? "none" : "1px solid var(--border-soft)", transition: "background 0.12s" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-2)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
              <Avatar initials={initialsOf(u.full_name, u.email)} size={32}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{u.full_name || u.email}</span>
                  {u.is_super_admin && <Pill bg="var(--accent-soft)" fg="var(--accent)" dot="var(--accent)" size="sm">SUPER ADMIN</Pill>}
                  {!u.is_active && <Pill bg="var(--surface-2)" fg="var(--text-lo)" size="sm">NIEAKTYWNY</Pill>}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-lo)", marginTop: 2 }}>{u.email}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-lo)" }}>{u.last_login ? fmtDate(u.last_login) : "nigdy"}</span>
                <Pill bg={meta.bg} fg={meta.fg} size="sm">{meta.label}</Pill>
                <button onClick={() => setEditingId(u.id)} style={btnGhostMini}>Edytuj</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoleStat({ label, count, meta }: { label: string; count: number; meta: { fg: string } }) {
  return (
    <div style={{ padding: 14, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, background: meta.fg }}/>
        <span style={{ fontSize: 11, color: "var(--text-lo)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      </div>
      <div className="num" style={{ fontSize: 24, fontWeight: 600, color: "var(--text-hi)", marginTop: 6, letterSpacing: "-0.02em" }}>{count}</div>
    </div>
  );
}

function UserEditor({ item, isSelf, onSaved, onCancel }: {
  item?: UserRow; isSelf?: boolean; onSaved: () => void; onCancel: () => void;
}) {
  const isNew = !item;
  const [email, setEmail] = useState(item?.email || "");
  const [fullName, setFullName] = useState(item?.full_name || "");
  const [role, setRole] = useState(item?.role || "VIEWER");
  const [active, setActive] = useState(item?.is_active ?? true);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (isNew) {
      if (!email.trim() || !fullName.trim()) { toast("Podaj email i imię/nazwisko", "warning"); return; }
      if (password.length < 8) { toast("Hasło min. 8 znaków", "warning"); return; }
      setBusy(true);
      try {
        await api.post("/users", { email: email.trim(), full_name: fullName.trim(), role, password });
        toast("Dodano użytkownika", "ok"); onSaved();
      } catch { toast("Nie udało się dodać (email może już istnieć)", "error"); }
      finally { setBusy(false); }
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/users/${item!.id}`, { full_name: fullName.trim() || null, role, is_active: active });
      if (password) {
        if (password.length < 8) { toast("Hasło min. 8 znaków", "warning"); setBusy(false); return; }
        await api.put(`/users/${item!.id}/password`, { new_password: password });
      }
      toast("Zapisano użytkownika", "ok"); onSaved();
    } catch { toast("Nie udało się zapisać", "error"); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!item) return;
    if (isSelf) { toast("Nie możesz usunąć własnego konta", "warning"); return; }
    if (!window.confirm(`Usunąć użytkownika „${item.full_name || item.email}"?`)) return;
    setBusy(true);
    try { await api.del(`/users/${item.id}`); toast("Usunięto użytkownika", "ok"); onSaved(); }
    catch { toast("Nie udało się usunąć", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 16, background: "var(--surface-2)", border: "1px solid var(--accent)", borderRadius: "var(--r-lg)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <SettingsField label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!isNew}
            placeholder="user@firma.pl" style={{ ...inputStyle, opacity: isNew ? 1 : 0.6 }}/>
        </SettingsField>
        <SettingsField label="Imię i nazwisko">
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus placeholder="Jan Kowalski" style={inputStyle}/>
        </SettingsField>
        <SettingsField label="Rola">
          <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
            <option value="ADMIN">Admin</option>
            <option value="IMPORT">Import</option>
            <option value="VIEWER">Viewer</option>
          </select>
        </SettingsField>
        <SettingsField label={isNew ? "Hasło startowe" : "Nowe hasło (puste = bez zmiany)"}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="min. 8 znaków" style={inputStyle}/>
        </SettingsField>
      </div>
      {!isNew && (
        <SettingsField label="Status konta">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-mid)", cursor: "pointer" }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}/>
            Konto aktywne
          </label>
        </SettingsField>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
        {!isNew && !isSelf ? (
          <button onClick={remove} disabled={busy} style={{ ...btnGhost, color: "var(--critical)" }}>Usuń użytkownika</button>
        ) : <span/>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} disabled={busy} style={btnSecondary}>Anuluj</button>
          <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "Zapisywanie…" : "Zapisz"}</button>
        </div>
      </div>
    </div>
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
      {/* Profil */}
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

      {/* Zmiana hasła */}
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
    </div>
  );
}

// ============================================================
// DZIENNIK AUDYTU (tylko super-admin)
// ============================================================
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

  const target = (r: AuditRow) =>
    [r.resource_type, r.resource_id].filter(Boolean).join(" ") + (r.details ? ` — ${r.details}` : "");

  const doExport = () => {
    const cols: CsvColumn<AuditRow>[] = [
      { label: "Czas", get: (r) => fmtDateTime(r.created_at) },
      { label: "Uzytkownik", get: (r) => r.user_email || "" },
      { key: "action", label: "Akcja" },
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
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-lo)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{target(r)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// HELPERY
// ============================================================
function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
        {label}
      </label>
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

export { SettingsView };
export default SettingsView;
