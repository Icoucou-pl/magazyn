"use client";
// ============================================================
// MAGAZYN — Dropy (sprzedaż do dropshipperów). Widok tylko dla super-admina.
//   · Partnerzy — rejestr, firmy na ptaszki, tryb płatności, limit, konta i klucze API
//   · Cennik    — trzy drogi: ręcznie (z zaznaczaniem i akcją grupową), narzut %, wklejka z Excela
//   · Zamówienia— podgląd, statusy, przesyłka, numer w Sellasist
//   · Logi      — okno z historią zmian (partner + my), ikonka obok
//                 „Odśwież katalog” w pasku zakładek
//
// Dane siedzą w schemacie `dropy`. Sam portal partnera to OSOBNY serwis —
// stąd nic o nim w tym pliku poza tym, co widać w zamówieniach (source).
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { I, Card } from "./ui";
import { Portal } from "./products-ui";

// ── Typy ─────────────────────────────────────────────────────
type PayMode = "zbiorcza" | "przedplata";
const PAY_SHORT: Record<PayMode, string> = { zbiorcza: "Faktura zbiorcza", przedplata: "Przedpłata" };

type Partner = {
  id: number; code: string; name: string; nip?: string | null; email?: string | null;
  phone?: string | null; address?: string | null; firmy: string[];
  // Dane do faktury (płatnik w Sellasist) i adres wysyłek zbiorczych („Na mój adres”)
  bill_street?: string | null; bill_home_number?: string | null; bill_postcode?: string | null; bill_city?: string | null;
  ship_name?: string | null; ship_street?: string | null; ship_postcode?: string | null; ship_city?: string | null;
  ship_phone?: string | null;
  payment_mode: PayMode; allow_installments: boolean;
  terms?: Record<string, PayMode>;          // tryb płatności per firma
  shipping?: Record<string, number | null>; // koszt wysyłki netto per firma („Wyślijcie wy”)
  credit_limit: number | null; is_active: boolean; notes?: string | null;
  orders_month: number; net_month: number; users_count: number; keys_count: number;
};

type PriceRow = {
  sku: string; name: string; stock: number;
  purchase_price: number; price_net: number | null; markup: number | null;
};

type OrderItem = { sku: string; name: string; qty: number; price_net: number };
type Order = {
  id: number; nr: string; partner_id: number; partner_code: string; partner_name: string;
  firma: string; typ: string; status: string; source: string; external_id: string | null;
  recipient_name: string | null; recipient_city: string | null; recipient_street: string | null;
  recipient_zip: string | null; recipient_phone: string | null;
  cod: boolean; shipping_mode: string; label_url: string | null; tracking: string | null;
  sellasist_order_id: string | null; total_net: number; total_gross: number;
  shipping_net: number; checkout_nr: string | null; label_file: string | null;
  created_at: string; items: OrderItem[];
};

type Template = {
  id: number; name: string; firma: string; note: string | null;
  items: number; priced: number;
};

type PortalUser = { id: number; email: string; full_name: string | null; is_active: boolean; last_login: string | null };
type ApiKey = { id: number; label: string; key_hint: string; is_active: boolean; last_used: string | null };

const ADDR_KEYS = ["bill_street", "bill_home_number", "bill_postcode", "bill_city",
  "ship_name", "ship_street", "ship_postcode", "ship_city", "ship_phone"] as const;
type AddrKey = typeof ADDR_KEYS[number];

const FIRMY = [
  { slug: "amh", label: "AMH" },
  { slug: "acti", label: "Acti4med" },
  { slug: "veluxa", label: "Veluxa" },
];
const firmaLabel = (s: string) => FIRMY.find(f => f.slug === s)?.label ?? s;

const STATUS: Record<string, { label: string; fg: string }> = {
  platnosc:  { label: "Czeka na płatność", fg: "var(--warning)" },
  etykieta:  { label: "Czeka na etykietę", fg: "var(--warning)" },
  nowe:      { label: "Nowe",              fg: "var(--accent)" },
  przyjete:  { label: "Przyjęte",          fg: "var(--accent)" },
  spakowane: { label: "Spakowane",         fg: "var(--accent)" },
  wyslane:   { label: "Wysłane",           fg: "var(--success)" },
  anulowane: { label: "Anulowane",         fg: "var(--danger)" },
};

const zl = (n: number) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(n || 0);
const dt = (s?: string | null) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : "—");
const err = (e: unknown) => toast(e instanceof Error ? e.message : "Coś poszło nie tak", "error");

// ── Drobne elementy ──────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13,
  background: "var(--surface-2)", color: "var(--text-hi)",
  border: "1px solid var(--border-soft)", borderRadius: 8,
};

function btn(variant: "primary" | "ghost" | "danger" = "ghost", small = false): React.CSSProperties {
  return {
    padding: small ? "5px 10px" : "8px 14px",
    fontSize: small ? 12 : 13, fontWeight: 500, cursor: "pointer",
    borderRadius: 8, whiteSpace: "nowrap",
    background: variant === "primary" ? "var(--accent)" : "var(--surface-2)",
    color: variant === "primary" ? "#fff" : variant === "danger" ? "var(--danger)" : "var(--text-mid)",
    border: `1px solid ${variant === "primary" ? "var(--accent)" : "var(--border-soft)"}`,
  };
}

function iconBtnStyle(busy: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 32, height: 32, padding: 0, borderRadius: 8,
    background: "var(--surface-2)", color: "var(--text-mid)",
    border: "1px solid var(--border-soft)",
    cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1,
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 12, color: "var(--text-lo)" }}>
      {label}
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  );
}

function Tag({ children, fg }: { children: React.ReactNode; fg?: string }) {
  const color = fg || "var(--text-mid)";
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 99, fontSize: 11.5, fontWeight: 500,
      color, background: "var(--surface-3)", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Portal do document.body — bez tego okno siedzi w stacking-context main/.fade-in
  // i nagłówek chowa się pod topbarem (ten sam wzorzec co modale w Produktach).
  return (
    <Portal>
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "rgba(8,10,16,.55)",
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "84px 16px 24px",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: wide ? 900 : 560, background: "var(--surface-1)",
        border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)",
        // Przewija się TREŚĆ okna, nie całe tło — pasek z tytułem zostaje na wierzchu.
        display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 108px)",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
          padding: "16px 20px", borderBottom: "1px solid var(--border-soft)", flexShrink: 0,
        }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{ ...btn("ghost", true), padding: 6 }} aria-label="Zamknij"><I.Close size={14}/></button>
        </div>
        <div style={{ padding: 20, overflowY: "auto", minHeight: 0 }}>{children}</div>
      </div>
    </div>
    </Portal>
  );
}

// ============================================================
// WIDOK GŁÓWNY
// ============================================================
const TABS = [
  { id: "partnerzy", label: "Partnerzy" },
  { id: "cennik", label: "Cennik" },
  { id: "zamowienia", label: "Zamówienia" },
] as const;
type TabId = typeof TABS[number]["id"];

export default function DropyView() {
  const [tab, setTab] = useState<TabId>("partnerzy");
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);

  // Migawkę katalogu odświeżamy MY, nie partner. Docelowo pójdzie to z crona,
  // a przycisk zostaje na wypadek, gdy trzeba przeliczyć od razu (nowy produkt, zmiana VAT).
  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      const r = await api.post("/dropy/catalog/refresh", {}) as { refreshed: number };
      setLastRefresh(new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }));
      toast(`Katalog odświeżony: ${r.refreshed} pozycji`, "ok");
    } catch (e) { err(e); } finally { setRefreshing(false); }
  };

  const load = async () => {
    try {
      setPartners((await api.get("/dropy/partners?include_inactive=true")) as Partner[]);
    } catch (e) { err(e); setPartners([]); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="fade-in" style={{ paddingBottom: 80 }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 18, borderBottom: "1px solid var(--border-soft)", alignItems: "center" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "10px 14px", fontSize: 13.5, fontWeight: tab === t.id ? 600 : 500,
            background: "none", border: "none", cursor: "pointer",
            color: tab === t.id ? "var(--text-hi)" : "var(--text-lo)",
            borderBottom: `2px solid ${tab === t.id ? "var(--accent)" : "transparent"}`,
          }}>{t.label}</button>
        ))}
        <div style={{ flex: 1 }}/>
        {/* Dwie ikonki obok siebie: odśwież katalog + logi. Opisy w dymkach (title). */}
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <button
            onClick={refreshCatalog}
            disabled={refreshing}
            aria-label="Odśwież katalog"
            title={refreshing ? "Odświeżam katalog…" : lastRefresh
              ? `Odśwież katalog — przelicza stany, ceny zakupu, zdjęcia i stawki VAT. Ostatnio: ${lastRefresh}`
              : "Odśwież katalog — przelicza stany, ceny zakupu, zdjęcia i stawki VAT"}
            style={iconBtnStyle(refreshing)}
          >
            <I.Refresh size={15} style={{ animation: refreshing ? "spin 1s linear infinite" : undefined }}/>
          </button>
          <button onClick={() => setLogsOpen(true)} aria-label="Logi dropów" title="Logi dropów" style={iconBtnStyle(false)}>
            <I.History size={15}/>
          </button>
          <button onClick={() => setCleanOpen(true)} aria-label="Wyczyść etykiety PDF"
                  title="Wyczyść stare etykiety PDF z magazynu plików" style={iconBtnStyle(false)}>
            <I.Sparkles size={15}/>
          </button>
        </div>
        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      </div>

      {partners === null ? (
        <p style={{ color: "var(--text-lo)", fontSize: 13 }}>Wczytuję…</p>
      ) : tab === "partnerzy" ? (
        <PartnersPanel partners={partners} reload={load}/>
      ) : tab === "cennik" ? (
        <PricingPanel partners={partners.filter(p => p.is_active)}/>
      ) : (
        <OrdersPanel partners={partners}/>
      )}

      {logsOpen && <LogsModal partners={partners || []} onClose={() => setLogsOpen(false)}/>}
      {cleanOpen && <LabelCleanupModal onClose={() => setCleanOpen(false)}/>}
    </div>
  );
}

// ============================================================
// PARTNERZY
// ============================================================
function PartnersPanel({ partners, reload }: { partners: Partner[]; reload: () => void }) {
  const [editing, setEditing] = useState<Partner | "new" | null>(null);
  const [access, setAccess] = useState<Partner | null>(null);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-lo)" }}>
          Każda firma to osobne zamówienie i osobna faktura. Partner widzi tylko te, które mu zaznaczysz.
        </p>
        <button onClick={() => setEditing("new")} style={btn("primary")}>
          <I.Plus size={13} style={{ marginRight: 6, verticalAlign: -2 }}/>Nowy partner
        </button>
      </div>

      {partners.length === 0 ? (
        <Card padding={40}>
          <p style={{ margin: 0, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>
            Nie ma jeszcze żadnego partnera. Zacznij od dodania pierwszego.
          </p>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {partners.map(p => (
            <Card key={p.id} padding={16}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ minWidth: 220 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span className="mono" style={{ fontSize: 12, color: "var(--text-lo)" }}>{p.code}</span>
                    <strong style={{ fontSize: 14.5 }}>{p.name}</strong>
                    {!p.is_active && <Tag fg="var(--danger)">Wyłączony</Tag>}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    {p.firmy.map(f => (
                      <Tag key={f}>
                        {firmaLabel(f)} · {PAY_SHORT[p.terms?.[f] ?? p.payment_mode].toLowerCase()}
                        {p.shipping?.[f] != null ? ` · wysyłka ${zl(p.shipping[f] as number)}` : ""}
                      </Tag>
                    ))}
                    {p.allow_installments && <Tag>Raty</Tag>}
                    <Tag>{p.credit_limit != null ? `Limit ${zl(p.credit_limit)}` : "Bez limitu"}</Tag>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>W tym miesiącu</div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{p.orders_month} zam., {zl(p.net_month)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setAccess(p)} style={btn("ghost", true)}>
                      Dostęp ({p.users_count}/{p.keys_count})
                    </button>
                    <button onClick={() => setEditing(p)} style={btn("ghost", true)}>Edytuj</button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <PartnerForm
          partner={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      {access && <AccessModal partner={access} onClose={() => { setAccess(null); reload(); }}/>}
    </>
  );
}

function PartnerForm({ partner, onClose, onSaved }: {
  partner: Partner | null; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    code: partner?.code ?? "", name: partner?.name ?? "", nip: partner?.nip ?? "",
    email: partner?.email ?? "", phone: partner?.phone ?? "", address: partner?.address ?? "",
    ...Object.fromEntries(ADDR_KEYS.map(k => [k, (partner?.[k] as string | null | undefined) ?? ""])) as Record<AddrKey, string>,
    firmy: partner?.firmy ?? [],
    terms: { ...(partner?.terms ?? Object.fromEntries((partner?.firmy ?? []).map(x => [x, partner?.payment_mode ?? "zbiorcza"]))) } as Record<string, PayMode>,
    shipping: Object.fromEntries(Object.entries(partner?.shipping ?? {}).map(([k, v]) => [k, v != null ? String(v) : ""])) as Record<string, string>,
    allow_installments: partner?.allow_installments ?? false,
    credit_limit: partner?.credit_limit != null ? String(partner.credit_limit) : "",
    is_active: partner?.is_active ?? true, notes: partner?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF(prev => ({ ...prev, [k]: v }));

  const toggleFirma = (slug: string) => {
    const has = f.firmy.includes(slug);
    if (has && f.firmy.length === 1) { toast("Partner musi mieć co najmniej jedną firmę", "warning"); return; }
    set("firmy", has ? f.firmy.filter(x => x !== slug) : [...f.firmy, slug]);
    // Nowa firma dostaje domyślnie fakturę zbiorczą — do zmiany obok.
    if (!has && !f.terms[slug]) set("terms", { ...f.terms, [slug]: "zbiorcza" });
  };
  const modeOf = (slug: string): PayMode => f.terms[slug] ?? "zbiorcza";

  const save = async () => {
    if (!f.name.trim() || (!partner && !f.code.trim())) { toast("Kod i nazwa są wymagane", "warning"); return; }
    if (f.firmy.length === 0) { toast("Zaznacz przynajmniej jedną firmę", "warning"); return; }
    const badShip = f.firmy.find(x => {
      const v = (f.shipping[x] ?? "").trim().replace(",", ".");
      return v !== "" && !(Number(v) >= 0);
    });
    if (badShip) { toast(`Koszt wysyłki ${firmaLabel(badShip)} musi być liczbą`, "warning"); return; }
    const shipAny = [f.ship_street, f.ship_postcode, f.ship_city].some(v => v.trim());
    const shipAll = [f.ship_street, f.ship_postcode, f.ship_city].every(v => v.trim());
    if (shipAny && !shipAll) { toast("Adres wysyłek zbiorczych: uzupełnij ulicę, kod i miasto", "warning"); return; }
    const badZip = [f.bill_postcode, f.ship_postcode].find(v => v.trim() && !/^\d{2}-\d{3}$/.test(v.trim()));
    if (badZip) { toast(`Kod pocztowy „${badZip}” — wpisz w formacie 00-000`, "warning"); return; }
    setBusy(true);
    // Domyślny tryb partnera (dla firm dodanych później) = tryb pierwszej firmy.
    const firstMode = modeOf(FIRMY.find(x => f.firmy.includes(x.slug))?.slug ?? f.firmy[0]);
    const body: Record<string, unknown> = {
      name: f.name.trim(), nip: f.nip || null, email: f.email || null, phone: f.phone || null,
      firmy: f.firmy,
      // Adresy w polach. Puste pole = wyczyść (dlatego "" zamiast null).
      ...Object.fromEntries(ADDR_KEYS.map(k => [k, (f[k] ?? "").trim()])),
      // Tryb płatności osobno w każdej firmie. Wysyłamy tylko firmy, od których partner kupuje.
      terms: Object.fromEntries(f.firmy.map(x => [x, modeOf(x)])),
      // Koszt wysyłki netto per firma; puste pole = bez opłaty.
      shipping: Object.fromEntries(f.firmy.map(x => {
        const v = (f.shipping[x] ?? "").trim().replace(",", ".");
        return [x, v === "" ? null : Number(v)];
      })),
      allow_installments: f.allow_installments, notes: f.notes || null,
      credit_limit: f.credit_limit.trim() === "" ? null : Number(f.credit_limit),
    };
    try {
      if (partner) {
        await api.patch(`/dropy/partners/${partner.id}`, { ...body, is_active: f.is_active });
      } else {
        await api.post("/dropy/partners", { ...body, payment_mode: firstMode, code: f.code.trim().toUpperCase() });
      }
      toast(partner ? "Zapisane" : `Partner ${f.code.toUpperCase()} dodany`, "ok");
      onSaved();
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={partner ? `Partner ${partner.code}` : "Nowy partner"} onClose={onClose}>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10 }}>
          <Field label="Kod">
            <input style={{ ...inputStyle, textTransform: "uppercase" }} value={f.code} disabled={!!partner}
              onChange={e => set("code", e.target.value)} placeholder="DROP-01"/>
          </Field>
          <Field label="Nazwa">
            <input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)}/>
          </Field>
        </div>
        {!partner && (
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-lo)" }}>
            Kod trafia w tytuł przelewu i w numer zamówienia. Później się go nie zmienia.
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="NIP"><input style={inputStyle} value={f.nip ?? ""} onChange={e => set("nip", e.target.value)}/></Field>
          <Field label="Telefon"><input style={inputStyle} value={f.phone ?? ""} onChange={e => set("phone", e.target.value)}/></Field>
        </div>
        <Field label="E-mail"><input style={inputStyle} value={f.email ?? ""} onChange={e => set("email", e.target.value)}/></Field>
        <div>
          <div style={{ fontSize: 12, color: "var(--text-lo)", marginBottom: 6 }}>Dane do faktury (płatnik w Sellasist)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8 }}>
            <input style={inputStyle} placeholder="Ulica" value={f.bill_street} onChange={e => set("bill_street", e.target.value)}/>
            <input style={inputStyle} placeholder="Nr" value={f.bill_home_number} onChange={e => set("bill_home_number", e.target.value)}/>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 8, marginTop: 8 }}>
            <input style={inputStyle} placeholder="00-000" value={f.bill_postcode} onChange={e => set("bill_postcode", e.target.value)}/>
            <input style={inputStyle} placeholder="Miasto" value={f.bill_city} onChange={e => set("bill_city", e.target.value)}/>
          </div>
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-lo)" }}>Adres wysyłek zbiorczych („Na mój adres”)</span>
            <div style={{ flex: 1 }}/>
            <button type="button" style={btn("ghost", true)} onClick={() => setF(prev => ({
              ...prev, ship_name: prev.ship_name || prev.name,
              ship_street: [prev.bill_street, prev.bill_home_number].filter(Boolean).join(" "),
              ship_postcode: prev.bill_postcode, ship_city: prev.bill_city, ship_phone: prev.ship_phone || prev.phone,
            }))}>Jak do faktury</button>
          </div>
          <input style={inputStyle} placeholder="Odbiorca (firma lub osoba)" value={f.ship_name} onChange={e => set("ship_name", e.target.value)}/>
          <input style={{ ...inputStyle, marginTop: 8 }} placeholder="Ulica i numer" value={f.ship_street} onChange={e => set("ship_street", e.target.value)}/>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 150px", gap: 8, marginTop: 8 }}>
            <input style={inputStyle} placeholder="00-000" value={f.ship_postcode} onChange={e => set("ship_postcode", e.target.value)}/>
            <input style={inputStyle} placeholder="Miasto" value={f.ship_city} onChange={e => set("ship_city", e.target.value)}/>
            <input style={inputStyle} placeholder="Telefon" value={f.ship_phone} onChange={e => set("ship_phone", e.target.value)}/>
          </div>
          {f.address && !f.ship_street && (
            <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--warning)" }}>Stary zapis adresu: „{f.address}” — przepisz go do pól.</p>
          )}
        </div>

        <div>
          <div style={{ fontSize: 12, color: "var(--text-lo)", marginBottom: 6 }}>Może kupować od</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {FIRMY.map(fi => {
              const on = f.firmy.includes(fi.slug);
              return (
                <button key={fi.slug} onClick={() => toggleFirma(fi.slug)} style={{
                  ...btn(on ? "primary" : "ghost", true), padding: "7px 14px",
                }}>{fi.label}</button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 150px", gap: 10, fontSize: 12, color: "var(--text-lo)", marginBottom: 6 }}>
            <span>Warunki w firmie</span><span>Płatność</span><span>Wysyłka „Wyślijcie wy”</span>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {FIRMY.filter(fi => f.firmy.includes(fi.slug)).map(fi => (
              <div key={fi.slug} style={{ display: "grid", gridTemplateColumns: "110px 1fr 150px", gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 13 }}>{fi.label}</span>
                <select style={inputStyle} value={modeOf(fi.slug)}
                  onChange={e => set("terms", { ...f.terms, [fi.slug]: e.target.value as PayMode })}>
                  <option value="zbiorcza">Faktura zbiorcza</option>
                  <option value="przedplata">Przedpłata</option>
                </select>
                <input style={inputStyle} inputMode="decimal" placeholder="bez opłaty" title="Koszt wysyłki netto (VAT 23%)"
                  value={f.shipping[fi.slug] ?? ""}
                  onChange={e => set("shipping", { ...f.shipping, [fi.slug]: e.target.value })}/>
              </div>
            ))}
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--text-lo)" }}>
            Wysyłkę netto doliczamy tylko wtedy, gdy nadajemy my. Przy etykiecie partnera nic nie doliczamy.
          </p>
        </div>

        <Field label="Limit kupiecki (puste = brak, liczony ze wszystkich firm na fakturze zbiorczej)">
          <input style={inputStyle} inputMode="decimal" value={f.credit_limit}
            onChange={e => set("credit_limit", e.target.value)} placeholder="np. 15000"/>
        </Field>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={f.allow_installments} onChange={e => set("allow_installments", e.target.checked)}/>
          Może rozkładać faktury na raty
        </label>
        {partner && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={f.is_active} onChange={e => set("is_active", e.target.checked)}/>
            Konto aktywne
          </label>
        )}

        <Field label="Notatka">
          <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} value={f.notes ?? ""}
            onChange={e => set("notes", e.target.value)}/>
        </Field>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button onClick={onClose} style={btn("ghost")}>Anuluj</button>
          <button onClick={save} disabled={busy} style={btn("primary")}>{busy ? "Zapisuję…" : "Zapisz"}</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Konta portalu i klucze API ───────────────────────────────
function AccessModal({ partner, onClose }: { partner: Partner; onClose: () => void }) {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newUser, setNewUser] = useState({ email: "", password: "", full_name: "" });
  const [keyLabel, setKeyLabel] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const load = async () => {
    try {
      const [u, k] = await Promise.all([
        api.get(`/dropy/partners/${partner.id}/users`),
        api.get(`/dropy/partners/${partner.id}/keys`),
      ]);
      setUsers(u as PortalUser[]); setKeys(k as ApiKey[]);
    } catch (e) { err(e); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [partner.id]);

  const addUser = async () => {
    if (!newUser.email.trim() || newUser.password.length < 8) {
      toast("E-mail i hasło (min. 8 znaków, wielka litera, cyfra)", "warning"); return;
    }
    try {
      await api.post(`/dropy/partners/${partner.id}/users`, newUser);
      setNewUser({ email: "", password: "", full_name: "" });
      toast("Konto dodane", "ok"); load();
    } catch (e) { err(e); }
  };

  const addKey = async () => {
    if (!keyLabel.trim()) { toast("Podaj opis klucza, np. „Shopify sklep.pl”", "warning"); return; }
    try {
      const r = await api.post(`/dropy/partners/${partner.id}/keys`, { label: keyLabel.trim() }) as { key: string };
      setFreshKey(r.key); setKeyLabel(""); load();
    } catch (e) { err(e); }
  };

  const revoke = async (id: number) => {
    try { await api.del(`/dropy/keys/${id}`); toast("Klucz unieważniony", "ok"); load(); } catch (e) { err(e); }
  };

  const toggleUser = async (u: PortalUser) => {
    try { await api.patch(`/dropy/users/${u.id}`, { is_active: !u.is_active }); load(); } catch (e) { err(e); }
  };

  return (
    <Modal title={`Dostęp: ${partner.name}`} onClose={onClose} wide>
      <h4 style={{ margin: "0 0 10px", fontSize: 13.5 }}>Konta do portalu</h4>
      {users.length === 0 && <p style={{ fontSize: 12.5, color: "var(--text-lo)", margin: "0 0 10px" }}>Brak kont.</p>}
      {users.map(u => (
        <div key={u.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border-soft)" }}>
          <div>
            <div style={{ fontSize: 13 }}>{u.email}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
              {u.full_name || "—"} · ostatnie logowanie {dt(u.last_login)}
            </div>
          </div>
          <button onClick={() => toggleUser(u)} style={btn(u.is_active ? "ghost" : "primary", true)}>
            {u.is_active ? "Wyłącz" : "Włącz"}
          </button>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, marginTop: 12 }}>
        <input style={inputStyle} placeholder="e-mail" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })}/>
        <input style={inputStyle} placeholder="hasło" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })}/>
        <input style={inputStyle} placeholder="imię i nazwisko" value={newUser.full_name} onChange={e => setNewUser({ ...newUser, full_name: e.target.value })}/>
        <button onClick={addUser} style={btn("primary", true)}>Dodaj</button>
      </div>

      <h4 style={{ margin: "22px 0 10px", fontSize: 13.5 }}>Klucze API</h4>
      <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--text-lo)" }}>
        Do automatyzacji ze sklepu partnera. Klucz pokazujemy raz — w bazie zostaje tylko jego hash.
      </p>
      {keys.map(k => (
        <div key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border-soft)" }}>
          <div>
            <div style={{ fontSize: 13 }}>{k.label} {!k.is_active && <Tag fg="var(--danger)">unieważniony</Tag>}</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--text-lo)" }}>…{k.key_hint} · użyty {dt(k.last_used)}</div>
          </div>
          {k.is_active && <button onClick={() => revoke(k.id)} style={btn("danger", true)}>Unieważnij</button>}
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: 12 }}>
        <input style={inputStyle} placeholder="opis, np. Shopify meblonet.pl" value={keyLabel} onChange={e => setKeyLabel(e.target.value)}/>
        <button onClick={addKey} style={btn("primary", true)}>Wygeneruj klucz</button>
      </div>

      {freshKey && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--warning)" }}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>Skopiuj teraz — drugi raz tego nie pokażemy:</div>
          <code className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{freshKey}</code>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button style={btn("primary", true)} onClick={() => { navigator.clipboard?.writeText(freshKey); toast("Skopiowane", "ok"); }}>Kopiuj</button>
            <button style={btn("ghost", true)} onClick={() => setFreshKey(null)}>Zamknij</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ============================================================
// CENNIK
// ============================================================
function PricingPanel({ partners }: { partners: Partner[] }) {
  const [pid, setPid] = useState<number | null>(partners[0]?.id ?? null);
  const partner = partners.find(p => p.id === pid) || null;
  const [firma, setFirma] = useState<string>(partner?.firmy[0] ?? "amh");
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [draft, setDraft] = useState<Record<string, number | null>>({});   // sku → nowa cena (null = usuń)
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [onlyPriced, setOnlyPriced] = useState(false);
  const [bulk, setBulk] = useState<"cena" | "narzut" | null>(null);
  const [bulkVal, setBulkVal] = useState("");
  const [paste, setPaste] = useState<string | null>(null);
  const [tpl, setTpl] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (partner && !partner.firmy.includes(firma)) setFirma(partner.firmy[0]);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [pid]);

  const load = async () => {
    if (!pid || !firma) return;
    setRows(null); setDraft({}); setSel(new Set());
    try {
      const r = await api.get(`/dropy/partners/${pid}/pricing?firma=${firma}`) as { rows: PriceRow[] };
      setRows(r.rows);
    } catch (e) { err(e); setRows([]); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pid, firma]);

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter(r => {
      const priced = r.sku in draft ? draft[r.sku] != null : r.price_net != null;
      if (onlyPriced && !priced) return false;
      if (!needle) return true;
      return (r.name + " " + r.sku).toLowerCase().includes(needle);
    });
  }, [rows, q, onlyPriced, draft]);

  const priceOf = (r: PriceRow) => (r.sku in draft ? draft[r.sku] : r.price_net);
  const changed = Object.keys(draft).length;

  const setPrice = (sku: string, value: number | null) => setDraft(d => ({ ...d, [sku]: value }));

  const applyBulk = () => {
    if (!rows) return;
    const v = Number(bulkVal.replace(",", "."));
    if (!Number.isFinite(v) || v < 0) { toast("Podaj liczbę", "warning"); return; }
    const next = { ...draft };
    let touched = 0;
    for (const r of rows) {
      if (!sel.has(r.sku)) continue;
      if (bulk === "cena") { next[r.sku] = v; touched++; }
      else if (r.purchase_price > 0) { next[r.sku] = Math.round(r.purchase_price * (1 + v / 100) * 100) / 100; touched++; }
    }
    setDraft(next); setBulk(null); setBulkVal("");
    toast(bulk === "cena" ? `Ustawiono cenę dla ${touched} pozycji` : `Przeliczono ${touched} pozycji`, "ok");
  };

  const removeSelected = () => {
    const next = { ...draft };
    sel.forEach(sku => { next[sku] = null; });
    setDraft(next);
    toast(`${sel.size} pozycji zniknie z cennika po zapisie`, "info");
  };

  const applyPaste = (txt: string) => {
    if (!rows) return;
    const known = new Map(rows.map(r => [r.sku.trim().toLowerCase(), r.sku]));
    const next = { ...draft };
    let ok = 0; const bad: string[] = [];
    for (const line of txt.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split(/\t|;|\s{2,}|,(?=\s*\d)/).map(s => s.trim()).filter(Boolean);
      if (parts.length < 2) { bad.push(line.trim()); continue; }
      const sku = known.get(parts[0].toLowerCase());
      const cena = Number(parts[parts.length - 1].replace(/\s/g, "").replace(",", "."));
      if (!sku || !Number.isFinite(cena)) { bad.push(line.trim()); continue; }
      next[sku] = cena; ok++;
    }
    setDraft(next); setPaste(null);
    toast(bad.length ? `Wczytano ${ok}, pominięto ${bad.length}` : `Wczytano ${ok} pozycji`, bad.length ? "warning" : "ok");
  };

  const save = async () => {
    if (!pid || !changed) return;
    setBusy(true);
    try {
      // Cennik jest per firma — zapis dotyczy tylko wybranej zakładki firmy.
      await api.put(`/dropy/partners/${pid}/prices?firma=${firma}`,
        Object.entries(draft).map(([sku, price_net]) => ({ sku, price_net })));
      toast(`Cennik zapisany (${changed} zmian)`, "ok");
      load();
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  if (!partner) return <Card padding={40}><p style={{ margin: 0, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Najpierw dodaj partnera.</p></Card>;

  return (
    <>
      {/* Kontekst zawsze na wierzchu — cennik jest per partner × firma, łatwo edytować nie ten. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: "var(--text-lo)" }}>Cennik:</span>
        <strong style={{ fontSize: 15 }}>{partner.code} — {partner.name}</strong>
        <span style={{ fontSize: 15, color: "var(--text-lo)" }}>·</span>
        <strong style={{ fontSize: 15 }}>{firmaLabel(firma)}</strong>
        <Tag>{PAY_SHORT[partner.terms?.[firma] ?? partner.payment_mode]}</Tag>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <select style={{ ...inputStyle, width: "auto", minWidth: 200 }} value={pid ?? ""} onChange={e => setPid(Number(e.target.value))}>
          {partners.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
        </select>
        <div style={{ display: "flex", gap: 4 }}>
          {partner.firmy.map(f => (
            <button key={f} onClick={() => setFirma(f)} style={btn(firma === f ? "primary" : "ghost", true)}>{firmaLabel(f)}</button>
          ))}
        </div>
        <input style={{ ...inputStyle, width: 200 }} placeholder="Szukaj po nazwie lub SKU" value={q} onChange={e => setQ(e.target.value)}/>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--text-mid)" }}>
          <input type="checkbox" checked={onlyPriced} onChange={e => setOnlyPriced(e.target.checked)}/>
          tylko z ceną
        </label>
        <button onClick={() => setPaste("")} style={btn("ghost", true)}>Wklej z Excela</button>
        <button onClick={() => setTpl(true)} style={btn("ghost", true)}>Szablony</button>
        <div style={{ flex: 1 }}/>
        <button onClick={save} disabled={!changed || busy} style={{ ...btn("primary"), opacity: changed ? 1 : 0.5 }}>
          {busy ? "Zapisuję…" : changed ? `Zapisz zmiany (${changed})` : "Brak zmian"}
        </button>
      </div>

      {sel.size > 0 && (
        <div style={{
          display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12,
          padding: "10px 12px", borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border-soft)",
        }}>
          <strong style={{ fontSize: 13 }}>Zaznaczone: {sel.size}</strong>
          {bulk ? (
            <>
              <input autoFocus style={{ ...inputStyle, width: 120 }} value={bulkVal} inputMode="decimal"
                placeholder={bulk === "cena" ? "cena netto" : "narzut %"}
                onChange={e => setBulkVal(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") applyBulk(); }}/>
              <button onClick={applyBulk} style={btn("primary", true)}>Zastosuj</button>
              <button onClick={() => { setBulk(null); setBulkVal(""); }} style={btn("ghost", true)}>Anuluj</button>
            </>
          ) : (
            <>
              <button onClick={() => setBulk("cena")} style={btn("ghost", true)}>Ustaw jedną cenę</button>
              <button onClick={() => setBulk("narzut")} style={btn("ghost", true)}>Narzut % od ceny zakupu</button>
              <button onClick={removeSelected} style={btn("danger", true)}>Usuń z cennika</button>
              <button onClick={() => setSel(new Set())} style={btn("ghost", true)}>Odznacz</button>
            </>
          )}
        </div>
      )}

      <Card padding={0}>
        {rows === null ? (
          <p style={{ padding: 20, fontSize: 13, color: "var(--text-lo)", margin: 0 }}>Wczytuję produkty…</p>
        ) : view.length === 0 ? (
          <p style={{ padding: 20, fontSize: 13, color: "var(--text-lo)", margin: 0 }}>Nic nie pasuje do filtrów.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--text-lo)", fontSize: 11.5 }}>
                  <th style={{ padding: "10px 12px", width: 34 }}>
                    <input type="checkbox"
                      checked={sel.size > 0 && view.every(r => sel.has(r.sku))}
                      onChange={e => setSel(e.target.checked ? new Set(view.map(r => r.sku)) : new Set())}/>
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 12px" }}>Produkt</th>
                  <th style={{ textAlign: "right", padding: "10px 12px" }}>Stan</th>
                  <th style={{ textAlign: "right", padding: "10px 12px" }}>Zakup</th>
                  <th style={{ textAlign: "right", padding: "10px 12px", width: 130 }}>Cena partnera</th>
                  <th style={{ textAlign: "right", padding: "10px 12px" }}>Narzut</th>
                </tr>
              </thead>
              <tbody>
                {view.map(r => {
                  const cena = priceOf(r);
                  const dirty = r.sku in draft;
                  const markup = cena && r.purchase_price > 0 ? Math.round((cena / r.purchase_price - 1) * 1000) / 10 : null;
                  return (
                    <tr key={r.sku} style={{ borderTop: "1px solid var(--border-soft)", background: dirty ? "var(--surface-2)" : undefined }}>
                      <td style={{ padding: "8px 12px" }}>
                        <input type="checkbox" checked={sel.has(r.sku)} onChange={e => {
                          const n = new Set(sel);
                          if (e.target.checked) n.add(r.sku); else n.delete(r.sku);
                          setSel(n);
                        }}/>
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <div>{r.name}</div>
                        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-lo)" }}>{r.sku}</div>
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right", color: r.stock > 0 ? "var(--text-mid)" : "var(--danger)" }}>{r.stock}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", color: "var(--text-lo)" }}>
                        {r.purchase_price > 0 ? zl(r.purchase_price) : "—"}
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>
                        <input
                          style={{ ...inputStyle, textAlign: "right", padding: "5px 8px" }}
                          inputMode="decimal"
                          value={cena == null ? "" : String(cena)}
                          placeholder="brak"
                          onChange={e => {
                            const v = e.target.value.trim().replace(",", ".");
                            setPrice(r.sku, v === "" ? null : Number(v));
                          }}/>
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right", color: "var(--text-lo)" }}>
                        {markup != null ? `${markup}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-lo)" }}>
        Produkt bez ceny nie istnieje w katalogu partnera. Wyczyszczenie pola usuwa go z cennika po zapisie.
      </p>

      {tpl && (
        <TemplatesModal
          partnerId={partner.id}
          partnerName={partner.name}
          firma={firma}
          partners={partners}
          rows={rows || []}
          onClose={() => setTpl(false)}
          onApplied={() => { setTpl(false); load(); }}
        />
      )}

      {paste !== null && (
        <Modal title="Wklej cennik z Excela" onClose={() => setPaste(null)}>
          <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--text-lo)" }}>
            Dwie kolumny: SKU i cena netto. Wklej prosto z arkusza — rozdzielenie tabulatorem, średnikiem
            albo spacjami działa tak samo. Nieznane SKU pominiemy.
          </p>
          <textarea autoFocus value={paste} onChange={e => setPaste(e.target.value)}
            style={{ ...inputStyle, minHeight: 220, fontFamily: "var(--font-mono, monospace)", fontSize: 12.5 }}
            placeholder={"A2cz\t389\nD2cz\t749"}/>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={() => setPaste(null)} style={btn("ghost")}>Anuluj</button>
            <button onClick={() => applyPaste(paste)} style={btn("primary")}>Wczytaj</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Szablony cenników ────────────────────────────────────────
// Cennik jest jednocześnie bazą produktów partnera, więc szablon służy do obu
// rzeczy naraz: „zapisz ten zestaw" i „wczytaj go kolejnemu klientowi".
function TemplatesModal({ partnerId, partnerName, firma, partners, rows, onClose, onApplied }: {
  partnerId: number; partnerName: string; firma: string; partners: Partner[];
  rows: PriceRow[]; onClose: () => void; onApplied: () => void;
}) {
  const [list, setList] = useState<Template[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [fromPartner, setFromPartner] = useState<string>("");
  const [mode, setMode] = useState<"fill" | "update" | "replace">("fill");
  const [adjust, setAdjust] = useState("");
  const [markup, setMarkup] = useState("");
  const [name, setName] = useState("");
  const [withPrices, setWithPrices] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setList((await api.get(`/dropy/templates?firma=${firma}`)) as Template[]); }
    catch (e) { err(e); setList([]); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [firma]);

  const priced = rows.filter(r => r.price_net != null).length;
  const chosen = list?.find(t => t.id === pick) || null;
  const needsMarkup = !!chosen && chosen.priced < chosen.items;

  const save = async () => {
    if (!name.trim()) { toast("Nazwij szablon", "warning"); return; }
    setBusy(true);
    try {
      const r = await api.post("/dropy/templates", {
        name: name.trim(), firma, partner_id: partnerId, with_prices: withPrices,
      }) as { items: number };
      toast(`Szablon zapisany (${r.items} pozycji)`, "ok");
      setName(""); load();
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!pick && !fromPartner) { toast("Wybierz szablon albo partnera do skopiowania", "warning"); return; }
    if (needsMarkup && !markup.trim()) { toast("Ten szablon nie ma cen — podaj narzut %", "warning"); return; }
    setBusy(true);
    try {
      const r = await api.post(`/dropy/partners/${partnerId}/prices/apply`, {
        firma, mode,
        template_id: pick ?? undefined,
        from_partner_id: fromPartner ? Number(fromPartner) : undefined,
        adjust_pct: adjust.trim() === "" ? 0 : Number(adjust.replace(",", ".")),
        markup_pct: markup.trim() === "" ? undefined : Number(markup.replace(",", ".")),
      }) as { written: number; skipped: number };
      toast(`Wczytano ${r.written} pozycji${r.skipped ? `, pominięto ${r.skipped}` : ""}`, "ok");
      onApplied();
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  const remove = async (id: number) => {
    try { await api.del(`/dropy/templates/${id}`); toast("Szablon usunięty", "ok"); setPick(null); load(); }
    catch (e) { err(e); }
  };

  return (
    <Modal title={`Szablony cenników — ${firmaLabel(firma)}`} onClose={onClose} wide>
      <h4 style={{ margin: "0 0 8px", fontSize: 13.5 }}>Wczytaj do: {partnerName}</h4>

      {list === null ? (
        <p style={{ fontSize: 12.5, color: "var(--text-lo)" }}>Wczytuję…</p>
      ) : list.length === 0 ? (
        <p style={{ fontSize: 12.5, color: "var(--text-lo)", margin: "0 0 10px" }}>
          Nie ma jeszcze szablonu dla tej firmy. Zapisz pierwszy niżej.
        </p>
      ) : list.map(t => (
        <div key={t.id} onClick={() => { setPick(t.id); setFromPartner(""); }} style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
          padding: "10px 12px", marginBottom: 6, cursor: "pointer", borderRadius: 8,
          background: pick === t.id ? "var(--surface-3)" : "var(--surface-2)",
          border: `1px solid ${pick === t.id ? "var(--accent)" : "var(--border-soft)"}`,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t.name}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
              {t.items} SKU · {t.priced === t.items ? "z cenami" : t.priced === 0 ? "sama baza produktów" : `${t.priced} z ceną`}
              {t.note ? ` · ${t.note}` : ""}
            </div>
          </div>
          <button onClick={(e) => { e.stopPropagation(); remove(t.id); }} style={btn("danger", true)}>Usuń</button>
        </div>
      ))}

      <div style={{ marginTop: 10 }}>
        <Field label="albo skopiuj cennik innego partnera">
          <select style={inputStyle} value={fromPartner}
            onChange={e => { setFromPartner(e.target.value); setPick(null); }}>
            <option value="">—</option>
            {partners.filter(p => p.id !== partnerId && p.firmy.includes(firma))
              .map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
          </select>
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 120px", gap: 8, marginTop: 12, alignItems: "end" }}>
        <Field label="Co zrobić z tym, co partner już ma">
          <select style={inputStyle} value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
            <option value="fill">Dołóż brakujące, istniejące zostaw</option>
            <option value="update">Zmień tylko te, które już ma</option>
            <option value="replace">Zastąp cały cennik tej firmy</option>
          </select>
        </Field>
        <Field label="Korekta cen %"><input style={inputStyle} inputMode="decimal" placeholder="np. -3" value={adjust} onChange={e => setAdjust(e.target.value)}/></Field>
        <Field label="Narzut % (bez cen)"><input style={inputStyle} inputMode="decimal" placeholder="np. 35" value={markup} onChange={e => setMarkup(e.target.value)}/></Field>
      </div>
      {needsMarkup && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--warning)" }}>
          Ten szablon niesie sam zestaw SKU. Ceny policzymy narzutem od ceny zakupu.
        </p>
      )}
      {mode === "replace" && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--danger)" }}>
          Uwaga: wszystkie dotychczasowe ceny tego partnera dla {firmaLabel(firma)} znikną.
        </p>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={apply} disabled={busy} style={btn("primary")}>{busy ? "Wczytuję…" : "Wczytaj"}</button>
      </div>

      <h4 style={{ margin: "24px 0 8px", fontSize: 13.5, paddingTop: 16, borderTop: "1px solid var(--border-soft)" }}>
        Zapisz cennik {partnerName} jako szablon
      </h4>
      <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--text-lo)" }}>
        Weźmiemy {priced} pozycji z ceną dla firmy {firmaLabel(firma)}.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center" }}>
        <input style={inputStyle} placeholder="nazwa, np. Standard 2026" value={name} onChange={e => setName(e.target.value)}/>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--text-mid)" }}>
          <input type="checkbox" checked={withPrices} onChange={e => setWithPrices(e.target.checked)}/>
          z cenami
        </label>
        <button onClick={save} disabled={busy} style={btn("primary", true)}>Zapisz szablon</button>
      </div>
    </Modal>
  );
}

// ============================================================
// ZAMÓWIENIA
// ============================================================
function OrdersPanel({ partners }: { partners: Partner[] }) {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [pid, setPid] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [open, setOpen] = useState<Order | null>(null);

  const load = async () => {
    setOrders(null);
    const qs = new URLSearchParams({ month });
    if (pid) qs.set("partner_id", pid);
    if (status) qs.set("status", status);
    try { setOrders((await api.get(`/dropy/orders?${qs}`)) as Order[]); }
    catch (e) { err(e); setOrders([]); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [month, pid, status]);

  const months = useMemo(() => {
    const out: string[] = [];
    const d = new Date();
    for (let i = 0; i < 12; i++) { out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); d.setMonth(d.getMonth() - 1); }
    return out;
  }, []);

  const sum = (orders || []).filter(o => o.status !== "anulowane");

  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <select style={{ ...inputStyle, width: "auto" }} value={month} onChange={e => setMonth(e.target.value)}>
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select style={{ ...inputStyle, width: "auto" }} value={pid} onChange={e => setPid(e.target.value)}>
          <option value="">Wszyscy partnerzy</option>
          {partners.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
        </select>
        <select style={{ ...inputStyle, width: "auto" }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Wszystkie statusy</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <div style={{ flex: 1 }}/>
        <div style={{ fontSize: 13, color: "var(--text-mid)" }}>
          {sum.length} zam. · {zl(sum.reduce((s, o) => s + o.total_net, 0))} netto
        </div>
      </div>

      <Card padding={0}>
        {orders === null ? (
          <p style={{ padding: 20, margin: 0, fontSize: 13, color: "var(--text-lo)" }}>Wczytuję…</p>
        ) : orders.length === 0 ? (
          <p style={{ padding: 20, margin: 0, fontSize: 13, color: "var(--text-lo)" }}>Brak zamówień w tym miesiącu.</p>
        ) : orders.map(o => (
          <button key={o.id} onClick={() => setOpen(o)} style={{
            display: "grid", gridTemplateColumns: "180px 90px minmax(0,1fr) 110px 150px", gap: 12,
            width: "100%", textAlign: "left", alignItems: "center", padding: "12px 16px",
            background: "none", border: "none", borderTop: "1px solid var(--border-soft)", cursor: "pointer",
          }}>
            <span className="mono" style={{ fontSize: 12 }}>{o.nr}</span>
            <span style={{ fontSize: 12, color: "var(--text-lo)" }}>{dt(o.created_at)}</span>
            <span style={{ fontSize: 13, minWidth: 0 }}>
              {o.recipient_name || o.partner_name}
              <small style={{ display: "block", color: "var(--text-lo)", fontSize: 11.5 }}>
                {firmaLabel(o.firma)} · {o.typ === "klient" ? "do klienta" : "zbiorcze"}
                {o.shipping_mode === "wlasna" ? " · etykieta partnera" : " · wysyłka nasza"}
                {o.cod ? " · pobranie" : ""}{o.external_id ? ` · ${o.external_id}` : ""}
                {o.sellasist_order_id ? ` · Sellasist #${o.sellasist_order_id}` : ""}
              </small>
            </span>
            <span style={{ fontSize: 13, textAlign: "right", fontWeight: 600 }}>{zl(o.total_net)}</span>
            <span style={{ textAlign: "right" }}>
              <Tag fg={STATUS[o.status]?.fg}>{STATUS[o.status]?.label ?? o.status}</Tag>
            </span>
          </button>
        ))}
      </Card>

      {open && <OrderModal order={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }}/>}
    </>
  );
}

function OrderModal({ order, onClose, onChanged }: { order: Order; onClose: () => void; onChanged: () => void }) {
  const [tracking, setTracking] = useState(order.tracking ?? "");
  const [sellasist, setSellasist] = useState(order.sellasist_order_id ?? "");
  const [label, setLabel] = useState(order.label_url ?? "");
  const [busy, setBusy] = useState(false);

  const removeLabel = () => {
    const back = order.status === "nowe" && !order.sellasist_order_id;
    const msg = back
      ? "Usunąć etykietę? Zamówienie wróci do statusu „Czeka na etykietę”."
      : order.sellasist_order_id
        ? "Usunąć etykietę? Zamówienie jest już w Sellasist — tam etykietę trzeba poprawić ręcznie."
        : "Usunąć etykietę z tego zamówienia?";
    if (!window.confirm(msg)) return;
    patch({ remove_label: true }, "Etykieta usunięta");
  };

  const patch = async (body: Record<string, unknown>, msg: string) => {
    setBusy(true);
    try { await api.patch(`/dropy/orders/${order.id}`, body); toast(msg, "ok"); onChanged(); }
    catch (e) { err(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={order.nr} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <Tag fg={STATUS[order.status]?.fg}>{STATUS[order.status]?.label ?? order.status}</Tag>
        <Tag>{firmaLabel(order.firma)}</Tag>
        <Tag>{order.partner_code}</Tag>
        <Tag>{order.source === "api" ? "z API sklepu" : order.source === "portal" ? "z portalu" : "z panelu"}</Tag>
        <Tag fg={order.shipping_mode === "wlasna" ? "var(--warning)" : undefined}>
          {order.shipping_mode === "wlasna" ? "etykieta partnera" : "wysyłka nasza"}
        </Tag>
        {order.cod && <Tag fg="var(--warning)">pobranie</Tag>}
        {order.checkout_nr && <Tag>koszyk {order.checkout_nr}</Tag>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginBottom: 4 }}>Odbiorca</div>
          <div style={{ fontSize: 13 }}>
            {order.recipient_name || "—"}<br/>
            {order.recipient_street || ""} {order.recipient_zip || ""} {order.recipient_city || ""}<br/>
            {order.recipient_phone || ""}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginBottom: 4 }}>Etykieta</div>
          {order.shipping_mode !== "wlasna" ? (
            <div style={{ fontSize: 13 }}>Wysyłamy my — etykieta powstaje u nas</div>
          ) : (
            <>
              <div style={{ fontSize: 13, marginBottom: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                {order.label_url ? (
                  <>
                    <a href={order.label_url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                      Otwórz etykietę partnera{order.label_file ? " (PDF)" : ""}
                    </a>
                    <button disabled={busy} style={btn("danger", true)} onClick={removeLabel}>Usuń etykietę</button>
                  </>
                ) : "Brak — zamówienie czeka na etykietę"}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)}
                       placeholder="https://… link do PDF z etykietą"/>
                <button disabled={busy || !label.trim() || label.trim() === (order.label_url ?? "")} style={btn("ghost", true)}
                  onClick={() => patch({ label_url: label.trim() }, order.label_url ? "Etykieta podmieniona" : "Etykieta dodana")}>
                  {order.label_url ? "Podmień" : "Dodaj"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 16 }}>
        <thead>
          <tr style={{ color: "var(--text-lo)", fontSize: 11.5 }}>
            <th style={{ textAlign: "left", padding: "6px 0" }}>Produkt</th>
            <th style={{ textAlign: "right", padding: "6px 0" }}>Ilość</th>
            <th style={{ textAlign: "right", padding: "6px 0" }}>Netto</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map(it => (
            <tr key={it.sku} style={{ borderTop: "1px solid var(--border-soft)" }}>
              <td style={{ padding: "8px 0" }}>{it.name}<div className="mono" style={{ fontSize: 11.5, color: "var(--text-lo)" }}>{it.sku}</div></td>
              <td style={{ padding: "8px 0", textAlign: "right" }}>{it.qty}</td>
              <td style={{ padding: "8px 0", textAlign: "right" }}>{zl(it.price_net * it.qty)}</td>
            </tr>
          ))}
          {order.shipping_net > 0 && (
            <tr style={{ borderTop: "1px solid var(--border-soft)" }}>
              <td style={{ padding: "8px 0" }}>Wysyłka</td><td/>
              <td style={{ padding: "8px 0", textAlign: "right" }}>{zl(order.shipping_net)}</td>
            </tr>
          )}
          <tr style={{ borderTop: "1px solid var(--border-soft)" }}>
            <td style={{ padding: "8px 0", fontWeight: 600 }}>Razem</td>
            <td/>
            <td style={{ padding: "8px 0", textAlign: "right", fontWeight: 600 }}>{zl(order.total_net)} netto / {zl(order.total_gross)} brutto</td>
          </tr>
        </tbody>
      </table>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "end", marginBottom: 14 }}>
        <Field label="Numer przesyłki"><input style={inputStyle} value={tracking} onChange={e => setTracking(e.target.value)}/></Field>
        <Field label="ID w Sellasist"><input style={inputStyle} value={sellasist} onChange={e => setSellasist(e.target.value)}/></Field>
        <button disabled={busy} style={btn("ghost")}
          onClick={() => patch({ tracking: tracking || null, sellasist_order_id: sellasist || null }, "Zapisane")}>Zapisz</button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["nowe", "przyjete", "spakowane", "wyslane", "anulowane"] as const).map(s => (
          <button key={s} disabled={busy || order.status === s} style={btn(order.status === s ? "primary" : "ghost", true)}
            onClick={() => patch({ status: s }, `Status: ${STATUS[s].label}`)}>{STATUS[s].label}</button>
        ))}
      </div>
    </Modal>
  );
}


// ============================================================
// LOGI — historia zmian dropów (portal, API, Magazyn, System)
// ============================================================
type LogRow = {
  id: number; created_at: string; partner_id: number | null; partner_code: string | null;
  partner_name: string | null; source: "portal" | "api" | "magazyn" | "system"; actor: string;
  action: string; order_nr: string | null; message: string; changes: Record<string, unknown> | null;
};

const SOURCE: Record<LogRow["source"], { label: string; fg: string }> = {
  portal:  { label: "Portal",  fg: "var(--accent)" },
  api:     { label: "API",     fg: "var(--warning)" },
  magazyn: { label: "Magazyn", fg: "var(--success)" },
  system:  { label: "System",  fg: "var(--text-mid)" },
};

const WAW: Intl.DateTimeFormatOptions = { timeZone: "Europe/Warsaw" };
const logDay = (iso: string) =>
  new Date(iso).toLocaleDateString("pl-PL", { ...WAW, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const logTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("pl-PL", { ...WAW, hour: "2-digit", minute: "2-digit" });

const showVal = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "tak" : "nie";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

function LogChanges({ changes }: { changes: Record<string, unknown> }) {
  return (
    <div style={{
      marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "var(--surface-2)",
      border: "1px solid var(--border-soft)", fontSize: 12, display: "grid", gap: 4,
    }}>
      {Object.entries(changes).map(([k, v]) => {
        const pair = Array.isArray(v) && v.length === 2 && !(k === "items" || k === "orders");
        return (
          <div key={k} style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", gap: 8 }}>
            <span className="mono" style={{ color: "var(--text-lo)" }}>{k}</span>
            <span style={{ wordBreak: "break-word" }}>
              {pair ? <>{showVal(v[0])} <span style={{ color: "var(--text-lo)" }}>→</span> {showVal(v[1])}</> : showVal(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function LogsModal({ partners, onClose }: { partners: Partner[]; onClose: () => void }) {
  const [pid, setPid] = useState("");
  const [source, setSource] = useState("");
  const [od, setOd] = useState("");
  const [doo, setDo] = useState("");
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  // Szukajka strzela dopiero po chwili bez pisania, a nie na każdą literę.
  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const fetchPage = async (offset: number) => {
    const qs = new URLSearchParams({ limit: "100", offset: String(offset) });
    if (pid) qs.set("partner_id", pid);
    if (source) qs.set("source", source);
    if (od) qs.set("od", od);
    if (doo) qs.set("do", doo);
    if (qDeb) qs.set("q", qDeb);
    return (await api.get(`/dropy/activity?${qs}`)) as { rows: LogRow[]; more: boolean };
  };

  useEffect(() => {
    let alive = true;
    setRows(null);
    fetchPage(0)
      .then(r => { if (alive) { setRows(r.rows); setMore(r.more); } })
      .catch(e => { if (alive) { err(e); setRows([]); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, source, od, doo, qDeb]);

  const loadMore = async () => {
    if (!rows) return;
    setLoadingMore(true);
    try {
      const r = await fetchPage(rows.length);
      setRows([...rows, ...r.rows]);
      setMore(r.more);
    } catch (e) { err(e); } finally { setLoadingMore(false); }
  };

  const filtered = !!(pid || source || od || doo || qDeb);

  return (
    <Modal title="Logi dropów" onClose={onClose} wide>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <input style={{ ...inputStyle, flex: "1 1 220px", width: "auto" }} value={q} onChange={e => setQ(e.target.value)}
               placeholder="Szukaj: nr zamówienia, login, faktura…"/>
        <select style={{ ...inputStyle, width: "auto" }} value={pid} onChange={e => setPid(e.target.value)}>
          <option value="">Wszyscy partnerzy</option>
          {partners.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
        </select>
        <select style={{ ...inputStyle, width: "auto" }} value={source} onChange={e => setSource(e.target.value)}>
          <option value="">Wszystkie źródła</option>
          {Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <input type="date" style={{ ...inputStyle, width: "auto" }} value={od} onChange={e => setOd(e.target.value)} title="Od"/>
        <input type="date" style={{ ...inputStyle, width: "auto" }} value={doo} onChange={e => setDo(e.target.value)} title="Do"/>
        {filtered && (
          <button style={btn("ghost", true)} onClick={() => { setPid(""); setSource(""); setOd(""); setDo(""); setQ(""); }}>
            Wyczyść
          </button>
        )}
      </div>

      {rows === null ? (
        <p style={{ fontSize: 13, color: "var(--text-lo)", margin: 0 }}>Wczytuję…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-lo)", margin: 0 }}>
          {filtered ? "Nic nie pasuje do filtrów." : "Jeszcze nie ma żadnych wpisów."}
        </p>
      ) : (
        <div>
          {rows.map((r, i) => {
            const day = logDay(r.created_at);
            const newDay = i === 0 || logDay(rows[i - 1].created_at) !== day;
            const expandable = !!(r.changes && Object.keys(r.changes).length);
            const isOpen = openId === r.id;
            return (
              <React.Fragment key={r.id}>
                {newDay && (
                  <div style={{
                    fontSize: 11.5, fontWeight: 600, color: "var(--text-lo)", textTransform: "uppercase",
                    letterSpacing: ".06em", padding: i === 0 ? "0 0 6px" : "16px 0 6px",
                  }}>{day}</div>
                )}
                <div
                  onClick={() => expandable && setOpenId(isOpen ? null : r.id)}
                  style={{
                    display: "grid", gridTemplateColumns: "48px 78px minmax(0,1fr)", gap: 10, alignItems: "start",
                    padding: "9px 0", borderTop: newDay ? "none" : "1px solid var(--border-soft)",
                    cursor: expandable ? "pointer" : "default",
                  }}
                >
                  <span className="mono" style={{ fontSize: 12, color: "var(--text-lo)", paddingTop: 2 }}>{logTime(r.created_at)}</span>
                  <span><Tag fg={SOURCE[r.source]?.fg}>{SOURCE[r.source]?.label ?? r.source}</Tag></span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, lineHeight: 1.45 }}>
                      {r.message}
                      {expandable && (
                        <span style={{ marginLeft: 6, fontSize: 11.5, color: "var(--text-lo)" }}>
                          {isOpen ? "▾ szczegóły" : "▸ szczegóły"}
                        </span>
                      )}
                    </div>
                    {r.partner_code && (
                      <small style={{ fontSize: 11.5, color: "var(--text-lo)" }}>
                        {r.partner_code} · {r.partner_name}
                      </small>
                    )}
                    {isOpen && r.changes && <LogChanges changes={r.changes}/>}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          {more && (
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button style={btn("ghost", true)} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Wczytuję…" : "Wczytaj starsze"}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}


// ── Czyszczenie etykiet PDF ──────────────────────────────────
// PDF-y etykiet leżą w prywatnym buckecie. Po wysyłce są zbędne, a podmienione
// zostają jako sieroty — tu jednym ruchem je usuwamy. Link w zamówieniu zostaje
// i po kliknięciu mówi, że plik już usunięto.
function LabelCleanupModal({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState("30");
  const [info, setInfo] = useState<{ to_delete: number; orphans: number; stored: number; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const d = Math.max(0, Math.floor(Number(days) || 0));

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/dropy/labels/cleanup?days=${d}`) as typeof info;
        if (live) setInfo(r);
      } catch (e) { err(e); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [d]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post("/dropy/labels/cleanup", { days: d }) as { removed: number; left: number };
      toast(r.left ? `Usunięto ${r.removed}, nie udało się ${r.left}` : `Usunięto ${r.removed} plików`, r.left ? "warning" : "ok");
      onClose();
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  return (
    <Modal title="Wyczyść etykiety PDF" onClose={onClose}>
      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Usuń PDF-y zamówień wysłanych lub anulowanych dawniej niż (dni)">
          <input style={{ ...inputStyle, width: 120 }} inputMode="numeric" value={days} onChange={e => setDays(e.target.value)}/>
        </Field>
        <p style={{ margin: 0, fontSize: 13 }}>
          {info === null ? "Liczę…" : !info.enabled
            ? "Wgrywanie plików nie jest skonfigurowane (brak zmiennych DROPY_STORAGE_* w Railway)."
            : <>W magazynie plików: <b>{info.stored}</b>. Do usunięcia: <b>{info.to_delete}</b>
                {info.orphans ? <> (w tym {info.orphans} podmienionych lub usuniętych z zamówień)</> : null}.</>}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={btn("ghost")}>Anuluj</button>
          <button onClick={run} disabled={busy || !info?.enabled || !info.to_delete} style={btn("danger")}>
            {busy ? "Usuwam…" : `Usuń ${info?.to_delete ?? ""}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
