"use client";
// ============================================================
// MAGAZYN — Cashflow → „Konto i pożyczki".
// Ręczne wpisy karmiące wykres „Pieniądze firmy" na pulpicie.
//
//   • Stan konta  — odczyt podany przez księgową. Jedna firma + jedna data = jeden wpis;
//     powtórny zapis tej samej daty NADPISUJE (backend robi UPSERT), nie dubluje.
//   • Pożyczki    — wpłata wspólnika (kwota dodatnia) albo zwrot (ujemna). Jednego dnia
//     może ich być kilka, więc dublowanie jest tu dozwolone.
//
// Wszystko per firma — zakładka działa dopiero po wybraniu spółki w Topbarze,
// bo trzy spółki mają trzy osobne rachunki.
//
// Wspólnik to zwykły tekst: pożyczkodawców bywa więcej niż dwóch, a literówkę
// poprawia się edycją wiersza. Datalist podpowiada nazwiska już użyte w tej firmie.
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { I, Card, CardHeader } from "./ui";
import { api } from "@/lib/api";
import { toast } from "./toast";
import { fmtPLN } from "@/lib/format";
import type { BankBalance, MoneyBundle, OwnerLoan } from "./money-chart";

const todayISO = () => new Date().toISOString().slice(0, 10);
const dLong = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("pl-PL", { day: "numeric", month: "long", year: "numeric" });

const inputStyle: React.CSSProperties = {
  padding: "6px 9px", fontSize: 12, borderRadius: 6, minWidth: 0,
  background: "var(--surface-2)", color: "var(--text-hi)",
  border: "1px solid var(--border)", colorScheme: "dark",
};
const btnStyle: React.CSSProperties = {
  padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
  background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-mid)",
};
const btnAccent: React.CSSProperties = {
  ...btnStyle, background: "var(--accent-soft)", borderColor: "transparent", color: "var(--accent)",
};
const thStyle: React.CSSProperties = {
  textAlign: "left", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
  color: "var(--text-lo)", padding: "10px 18px", borderBottom: "1px solid var(--border-soft)",
};
const tdStyle: React.CSSProperties = {
  padding: "9px 18px", borderBottom: "1px solid var(--border-soft)", color: "var(--text-mid)", fontSize: 12,
};
const emptyStyle: React.CSSProperties = { padding: 26, textAlign: "center", color: "var(--text-lo)", fontSize: 12 };

// Kwota z pola tekstowego: akceptujemy przecinek i spacje („1 234,50").
function parseAmount(v: string): number | null {
  const n = Number(v.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function MoneyEntriesTab({ shop }: { shop: string }) {
  const [bundle, setBundle] = useState<MoneyBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [partners, setPartners] = useState<string[]>([]);

  const load = async (slug: string) => {
    setLoading(true);
    try {
      const [d, p] = await Promise.all([
        api.get(`/money?shop=${encodeURIComponent(slug)}`),
        api.get(`/owner-loans/partners?shop=${encodeURIComponent(slug)}`).catch(() => []),
      ]);
      setBundle(d as MoneyBundle);
      setPartners((p as string[]) || []);
    } catch {
      setBundle(null);
      toast("Nie udało się pobrać wpisów", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!shop) { setBundle(null); setLoading(false); return; }
    load(shop);
  }, [shop]);

  if (!shop) {
    return (
      <Card>
        <div style={emptyStyle}>
          Wybierz firmę u góry. Każda spółka ma własny rachunek, więc saldo i pożyczki prowadzimy osobno.
        </div>
      </Card>
    );
  }
  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--text-lo)", fontSize: 13 }}>Ładowanie…</div>;
  }
  if (!bundle) {
    return <Card><div style={emptyStyle}>Brak dostępu do wpisów albo backend nie odpowiedział.</div></Card>;
  }

  const canEdit = bundle.can_edit;
  const reload = () => load(shop);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <LoansCard shop={shop} rows={bundle.loans} canEdit={canEdit} partners={partners} onChanged={reload} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
        <BalancesCard shop={shop} rows={bundle.balances} loans={bundle.loans} canEdit={canEdit} onChanged={reload} />
        {bundle.loans.length > 0 && <PartnersSummary loans={bundle.loans} />}
      </div>
    </div>
  );
}

// ── Saldo rachunku ───────────────────────────────────────────
function BalancesCard({
  shop, rows, loans, canEdit, onChanged,
}: { shop: string; rows: BankBalance[]; loans: OwnerLoan[]; canEdit: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Ile wspólnicy wpłacili do danego dnia — kolumna „bez pożyczek" liczona narastająco.
  const cumAt = useMemo(() => {
    const sorted = [...loans].sort((a, b) => a.loan_date.localeCompare(b.loan_date));
    return (iso: string) => sorted.reduce((s, l) => (l.loan_date <= iso ? s + l.amount_pln : s), 0);
  }, [loans]);

  const reset = () => { setAdding(false); setEditId(null); setDate(todayISO()); setAmount(""); setNote(""); };

  const save = async () => {
    const val = parseAmount(amount);
    if (val == null) { toast("Podaj kwotę", "warning"); return; }
    setBusy(true);
    try {
      const body = { firma_slug: shop, balance_date: date, amount_pln: val, note: note || null };
      if (editId != null) await api.patch(`/bank-balances/${editId}`, body);
      else await api.post("/bank-balances", body);
      toast(editId != null ? "Wpis poprawiony" : "Saldo zapisane", "ok");
      reset();
      onChanged();
    } catch {
      toast("Nie udało się zapisać wpisu", "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: BankBalance) => {
    if (!confirm(`Usunąć odczyt salda z ${dLong(row.balance_date)}?`)) return;
    try {
      await api.del(`/bank-balances/${row.id}`);
      toast("Wpis usunięty", "ok");
      onChanged();
    } catch {
      toast("Nie udało się usunąć wpisu", "error");
    }
  };

  const startEdit = (row: BankBalance) => {
    setEditId(row.id);
    setAdding(true);
    setDate(row.balance_date);
    setAmount(String(row.amount_pln));
    setNote(row.note || "");
  };

  const desc = [...rows].sort((a, b) => b.balance_date.localeCompare(a.balance_date));

  return (
    <Card>
      <CardHeader
        icon={<I.Wallet size={14} />}
        title="Stan konta"
        hint="odczyty od księgowej"
        action={canEdit && !adding ? <button onClick={() => setAdding(true)} style={btnAccent}>+ Dodaj wpis</button> : undefined}
      />

      {adding && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elevated)" }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
          <input inputMode="decimal" placeholder="Kwota w zł" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...inputStyle, width: 130 }} />
          <input placeholder="Notatka (opcjonalnie)" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inputStyle, flex: "1 1 140px" }} />
          <button onClick={save} disabled={busy} style={{ ...btnAccent, opacity: busy ? 0.6 : 1 }}>{editId != null ? "Zapisz zmiany" : "Zapisz"}</button>
          <button onClick={reset} style={btnStyle}>Anuluj</button>
        </div>
      )}

      {desc.length === 0 ? (
        <div style={emptyStyle}>Brak odczytów. Pierwszy wpis odblokuje linię konta na wykresie.</div>
      ) : (
        <div style={{ maxHeight: 420, overflow: "auto" }}>
          <table style={{ width: "100%", minWidth: 420, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Data</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Z wyciągu</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Bez pożyczek</th>
                {canEdit && <th style={{ ...thStyle, width: 1 }} />}
              </tr>
            </thead>
            <tbody>
              {desc.map((r) => {
                const c = cumAt(r.balance_date);
                return (
                  <tr key={r.id}>
                    <td style={tdStyle}>
                      <span className="num">{r.balance_date}</span>
                      {r.note && <div style={{ color: "var(--text-lo)", fontSize: 11, marginTop: 2 }}>{r.note}</div>}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", color: "var(--text-hi)" }} className="num">{fmtPLN(r.amount_pln)}</td>
                    <td style={{ ...tdStyle, textAlign: "right", color: c ? "var(--text-mid)" : "var(--text-lo)" }} className="num">
                      {fmtPLN(r.amount_pln - c)}
                    </td>
                    {canEdit && (
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                        <button onClick={() => startEdit(r)} style={{ ...btnStyle, padding: "3px 8px" }}>Popraw</button>{" "}
                        <button onClick={() => remove(r)} style={{ ...btnStyle, padding: "3px 8px", color: "var(--critical)" }}>Usuń</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Pożyczki od wspólników (umowy) ───────────────────────────
// Model 1:1 z arkuszem: umowa ma numer, datę zawarcia, datę wpłaty, termin spłaty
// i oprocentowanie. Spłatę oznacza DATA (splacono_data), nie kwota ujemna — jeden
// przycisk „Spłać" zamiast wpisywania drugiego wiersza z minusem.
function LoansCard({
  shop, rows, canEdit, partners, onChanged,
}: {
  shop: string; rows: OwnerLoan[]; canEdit: boolean; partners: string[]; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(emptyLoan());
  const [hideSplacone, setHideSplacone] = useState(false);

  const reset = () => { setAdding(false); setEditId(null); setF(emptyLoan()); };

  const save = async () => {
    const v = parseAmount(f.amount);
    if (v == null || v === 0) { toast("Podaj kwotę", "warning"); return; }
    if (!f.partner.trim()) { toast("Podaj pożyczkodawcę", "warning"); return; }
    if (!f.loan_date) { toast("Podaj datę wpłaty", "warning"); return; }
    setBusy(true);
    try {
      const body = {
        firma_slug: shop,
        loan_date: f.loan_date,
        amount_pln: Math.abs(v),
        partner: f.partner.trim(),
        numer_umowy: f.numer_umowy || null,
        data_zawarcia: f.data_zawarcia || null,
        termin_splaty: f.termin_splaty || null,
        oprocentowanie: f.oprocentowanie || null,
        splacono_data: f.splacono_data || null,
        note: f.note || null,
      };
      if (editId != null) await api.patch(`/owner-loans/${editId}`, body);
      else await api.post("/owner-loans", body);
      toast(editId != null ? "Umowa poprawiona" : "Pożyczka zapisana", "ok");
      reset();
      onChanged();
    } catch {
      toast("Nie udało się zapisać wpisu", "error");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (r: OwnerLoan) => {
    setEditId(r.id);
    setAdding(true);
    setF({
      loan_date: r.loan_date, amount: String(Math.abs(r.amount_pln)), partner: r.partner,
      numer_umowy: r.numer_umowy || "", data_zawarcia: r.data_zawarcia || "",
      termin_splaty: r.termin_splaty || "", oprocentowanie: r.oprocentowanie || "",
      splacono_data: r.splacono_data || "", note: r.note || "",
    });
  };

  // „Spłać" stawia dzisiejszą datę na umowie — odpowiednik ptaszka w arkuszu.
  // Datę można potem poprawić edycją wiersza; „Cofnij" ją zdejmuje.
  const flipSplata = async (r: OwnerLoan, splacono: boolean) => {
    try {
      await api.patch(`/owner-loans/${r.id}`, {
        firma_slug: r.firma_slug, loan_date: r.loan_date, amount_pln: r.amount_pln, partner: r.partner,
        numer_umowy: r.numer_umowy || null, data_zawarcia: r.data_zawarcia || null,
        termin_splaty: r.termin_splaty || null, oprocentowanie: r.oprocentowanie || null,
        splacono_data: splacono ? todayISO() : null, note: r.note || null,
      });
      toast(splacono ? `Spłacono: ${r.partner}, ${fmtPLN(Math.abs(r.amount_pln))}` : "Cofnięto oznaczenie spłaty", "ok");
      onChanged();
    } catch {
      toast("Nie udało się zapisać spłaty", "error");
    }
  };

  const remove = async (r: OwnerLoan) => {
    if (!confirm(`Usunąć umowę ${r.numer_umowy || ""} (${r.partner}, ${dLong(r.loan_date)})?`)) return;
    try {
      await api.del(`/owner-loans/${r.id}`);
      toast("Wpis usunięty", "ok");
      onChanged();
    } catch {
      toast("Nie udało się usunąć wpisu", "error");
    }
  };

  // Najstarsza wpłata na górze — jej termin spłaty wypada najwcześniej.
  const sorted = [...rows].sort((a, b) => a.loan_date.localeCompare(b.loan_date));
  const shown = hideSplacone ? sorted.filter((r) => !r.splacono_data) : sorted;
  const doSplaty = rows.filter((r) => !r.splacono_data).reduce((s, r) => s + Math.abs(r.amount_pln), 0);
  const splaconych = rows.filter((r) => r.splacono_data).length;

  return (
    <Card>
      <CardHeader
        icon={<I.TrendUp size={14} />}
        title="Pożyczki od wspólników"
        hint={rows.length ? `do spłaty: ${fmtPLN(doSplaty)}` : "umowy pożyczek"}
        accent="var(--anomaly)"
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {splaconych > 0 && (
              <button onClick={() => setHideSplacone((v) => !v)} style={btnStyle}>
                {hideSplacone ? `Pokaż spłacone (${splaconych})` : "Ukryj spłacone"}
              </button>
            )}
            {canEdit && !adding && <button onClick={() => setAdding(true)} style={btnAccent}>+ Dodaj pożyczkę</button>}
          </div>
        }
      />

      {adding && (
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elevated)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <Fld label="Nr umowy"><input placeholder="1/2026" value={f.numer_umowy} onChange={(e) => setF({ ...f, numer_umowy: e.target.value })} style={{ ...inputStyle, width: 100 }} /></Fld>
          <Fld label="Pożyczkodawca"><input list="magazyn-partners" value={f.partner} onChange={(e) => setF({ ...f, partner: e.target.value })} style={{ ...inputStyle, width: 150 }} /></Fld>
          <datalist id="magazyn-partners">{partners.map((x) => <option key={x} value={x} />)}</datalist>
          <Fld label="Kwota"><input inputMode="decimal" placeholder="100 000" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ ...inputStyle, width: 110 }} /></Fld>
          <Fld label="Data zawarcia"><input type="date" value={f.data_zawarcia} onChange={(e) => setF({ ...f, data_zawarcia: e.target.value })} style={{ ...inputStyle, width: 140 }} /></Fld>
          <Fld label="Data wpłaty"><input type="date" value={f.loan_date} onChange={(e) => setF({ ...f, loan_date: e.target.value })} style={{ ...inputStyle, width: 140 }} /></Fld>
          <Fld label="Termin spłaty"><input type="date" value={f.termin_splaty} onChange={(e) => setF({ ...f, termin_splaty: e.target.value })} style={{ ...inputStyle, width: 140 }} /></Fld>
          <Fld label="Oprocentowanie"><input placeholder="5,85% albo wibor3m+2%" value={f.oprocentowanie} onChange={(e) => setF({ ...f, oprocentowanie: e.target.value })} style={{ ...inputStyle, width: 175 }} /></Fld>
          <Fld label="Spłacono dnia"><input type="date" value={f.splacono_data} onChange={(e) => setF({ ...f, splacono_data: e.target.value })} style={{ ...inputStyle, width: 140 }} /></Fld>
          <Fld label="Notatka"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ ...inputStyle, width: 160 }} /></Fld>
          <button onClick={save} disabled={busy} style={{ ...btnAccent, opacity: busy ? 0.6 : 1 }}>{editId != null ? "Zapisz zmiany" : "Zapisz"}</button>
          <button onClick={reset} style={btnStyle}>Anuluj</button>
        </div>
      )}

      {shown.length === 0 ? (
        <div style={emptyStyle}>
          {rows.length ? "Wszystkie umowy spłacone." : "Brak umów. Dodaj pierwszą wpłatę, żeby odjąć ją od linii konta."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 980, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Nr umowy</th>
                <th style={thStyle}>Pożyczkodawca</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Kwota</th>
                <th style={thStyle}>Zawarcie</th>
                <th style={thStyle}>Wpłata</th>
                <th style={thStyle}>Termin spłaty</th>
                <th style={thStyle}>Oprocentowanie</th>
                <th style={thStyle}>Status</th>
                {canEdit && <th style={{ ...thStyle, width: 1 }} />}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const dni = r.termin_splaty && !r.splacono_data ? daysTo(r.termin_splaty) : null;
                const pilne = dni != null && dni <= 30;
                return (
                  <tr key={r.id} style={r.splacono_data ? { opacity: 0.55 } : undefined}>
                    <td style={{ ...tdStyle, color: "var(--text-hi)", fontWeight: 600 }} className="num">{r.numer_umowy || "—"}</td>
                    <td style={tdStyle}>
                      {r.partner}
                      {r.note && <div style={{ color: "var(--text-lo)", fontSize: 11, marginTop: 2 }}>{r.note}</div>}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", color: "var(--text-hi)" }} className="num">{fmtPLN(Math.abs(r.amount_pln))}</td>
                    <td style={tdStyle} className="num">{r.data_zawarcia || "—"}</td>
                    <td style={tdStyle} className="num">{r.loan_date}</td>
                    <td style={{ ...tdStyle, color: pilne ? "var(--warning)" : undefined, fontWeight: pilne ? 600 : undefined }} className="num">
                      {r.termin_splaty || "—"}
                      {dni != null && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: pilne ? "var(--warning)" : "var(--text-lo)" }}>
                          {dni < 0 ? `${-dni} dni po terminie` : `za ${dni} dni`}
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>{r.oprocentowanie || "—"}</td>
                    <td style={tdStyle}>
                      {r.splacono_data
                        ? <span style={{ padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 600, background: "var(--ok-soft)", color: "var(--ok)" }}>spłacono {r.splacono_data}</span>
                        : <span style={{ padding: "1px 7px", borderRadius: 999, fontSize: 10, fontWeight: 600, background: "var(--anomaly-soft)", color: "var(--anomaly)" }}>do spłaty</span>}
                    </td>
                    {canEdit && (
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                        <button onClick={() => flipSplata(r, !r.splacono_data)} style={{ ...btnStyle, padding: "3px 9px", color: r.splacono_data ? "var(--text-mid)" : "var(--ok)" }}>
                          {r.splacono_data ? "Cofnij" : "Spłać"}
                        </button>{" "}
                        <button onClick={() => startEdit(r)} style={{ ...btnStyle, padding: "3px 8px" }}>Popraw</button>{" "}
                        <button onClick={() => remove(r)} style={{ ...btnStyle, padding: "3px 8px", color: "var(--critical)" }}>Usuń</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function emptyLoan() {
  return {
    loan_date: todayISO(), amount: "", partner: "", numer_umowy: "",
    data_zawarcia: "", termin_splaty: "", oprocentowanie: "", splacono_data: "", note: "",
  };
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-lo)" }}>{label}</span>
      {children}
    </label>
  );
}

// Ile dni do terminu (ujemne = po terminie).
function daysTo(iso: string) {
  return Math.round((Date.parse(iso + "T00:00:00") - Date.parse(todayISO() + "T00:00:00")) / 86400000);
}

export default MoneyEntriesTab;

// ── Podsumowanie per wspólnik ────────────────────────────────
function PartnersSummary({ loans }: { loans: OwnerLoan[] }) {
  const rows = useMemo(() => {
    // Grupujemy po nazwisku bez względu na wielkość liter i podwójne spacje —
    // „Tomasz" i „tomasz " to ten sam człowiek, a pole jest tekstowe.
    const acc = new Map<string, { name: string; wplaty: number; zwroty: number; ile: number; last: string }>();
    loans.forEach((l) => {
      const key = l.partner.trim().toLowerCase().replace(/\s+/g, " ");
      const cur = acc.get(key) || { name: l.partner.trim(), wplaty: 0, zwroty: 0, ile: 0, last: "" };
      const kwota = Math.abs(l.amount_pln);
      cur.wplaty += kwota;
      cur.ile += 1;
      if (l.splacono_data) cur.zwroty += kwota;          // spłacone = umowa ma datę zwrotu
      if (l.loan_date > cur.last) cur.last = l.loan_date;
      acc.set(key, cur);
    });
    return [...acc.values()]
      .map((r) => ({ ...r, saldo: r.wplaty - r.zwroty }))
      .sort((a, b) => b.saldo - a.saldo);
  }, [loans]);

  const total = rows.reduce((s, r) => s + r.saldo, 0);
  const sumaZwrotow = rows.reduce((s, r) => s + r.zwroty, 0);

  return (
    <Card>
      <CardHeader
        icon={<I.Wallet size={14} />}
        title="Do spłaty wspólnikom"
        hint={`${rows.length} ${rows.length === 1 ? "osoba" : "osoby"}`}
        accent="var(--anomaly)"
      />
      <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Wspólnik</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Wpłacone</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Spłacone</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Do spłaty</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Udział</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Ostatnia wpłata</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td style={{ ...tdStyle, color: "var(--text-hi)", fontWeight: 600 }}>
                {r.name}
                <span style={{ color: "var(--text-lo)", fontWeight: 400, marginLeft: 8, fontSize: 11 }}>
                  {r.ile} {r.ile === 1 ? "umowa" : r.ile < 5 ? "umowy" : "umów"}
                </span>
              </td>
              <td style={{ ...tdStyle, textAlign: "right" }} className="num">{fmtPLN(r.wplaty)}</td>
              <td style={{ ...tdStyle, textAlign: "right", color: r.zwroty ? "var(--ok)" : "var(--text-lo)" }} className="num">
                {r.zwroty ? `−${fmtPLN(r.zwroty)}` : "—"}
              </td>
              <td style={{ ...tdStyle, textAlign: "right", color: "var(--text-hi)", fontWeight: 600 }} className="num">{fmtPLN(r.saldo)}</td>
              <td style={{ ...tdStyle, textAlign: "right" }} className="num">
                {total ? `${Math.round((r.saldo / total) * 100)}%` : "—"}
              </td>
              <td style={{ ...tdStyle, textAlign: "right" }} className="num">{r.last || "—"}</td>
            </tr>
          ))}
          <tr>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)", color: "var(--text-hi)", fontWeight: 600 }}>
              Suma całkowita
            </td>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)", textAlign: "right" }} className="num">
              {fmtPLN(rows.reduce((s, r) => s + r.wplaty, 0))}
            </td>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)", textAlign: "right", color: sumaZwrotow ? "var(--ok)" : "var(--text-lo)" }} className="num">
              {sumaZwrotow ? `−${fmtPLN(sumaZwrotow)}` : "—"}
            </td>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)", textAlign: "right", color: "var(--accent)", fontWeight: 700, fontSize: 13 }} className="num">
              {fmtPLN(total)}
            </td>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)" }} colSpan={2} />
          </tr>
        </tbody>
      </table>
      </div>
    </Card>
  );
}
