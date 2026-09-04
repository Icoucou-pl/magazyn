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

import React, { useEffect, useMemo, useRef, useState } from "react";
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
  // Klik „Spłać" w podsumowaniu wypełnia formularz spłaty. `nonce` rośnie przy każdym
  // kliknięciu, żeby ponowny klik na tego samego wspólnika znów otworzył formularz.
  const [repayPrefill, setRepayPrefill] = useState<{ partner: string; amount: number; nonce: number } | null>(null);
  const nonce = useRef(0);

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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 14 }}>
        <BalancesCard shop={shop} rows={bundle.balances} loans={bundle.loans} canEdit={canEdit} onChanged={reload} />
        <LoansCard shop={shop} rows={bundle.loans.filter((l) => l.amount_pln > 0)} canEdit={canEdit} partners={partners} onChanged={reload} kind="loan" />
        <LoansCard shop={shop} rows={bundle.loans.filter((l) => l.amount_pln < 0)} canEdit={canEdit} partners={partners} onChanged={reload} kind="repay" prefill={repayPrefill} />
      </div>
      {bundle.loans.length > 0 && (
        <PartnersSummary
          loans={bundle.loans}
          canEdit={canEdit}
          onRepay={(partner, amount) => {
            nonce.current += 1;
            setRepayPrefill({ partner, amount, nonce: nonce.current });
          }}
        />
      )}
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
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
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

// ── Pożyczki i spłaty ────────────────────────────────────────
// Jeden komponent w dwóch odsłonach: „loan" zapisuje kwotę dodatnią (wpłata do firmy),
// „repay" ujemną (zwrot wspólnikowi). W obu formularzach wpisujesz liczbę dodatnią —
// znak dokłada kod, żeby nikt nie musiał pamiętać o minusie.
function LoansCard({
  shop, rows, canEdit, partners, onChanged, kind, prefill,
}: {
  shop: string; rows: OwnerLoan[]; canEdit: boolean; partners: string[];
  onChanged: () => void; kind: "loan" | "repay";
  // Autowypełnienie z przycisku „Spłać" — wartości zostają edytowalne.
  prefill?: { partner: string; amount: number; nonce: number } | null;
}) {
  const isLoan = kind === "loan";
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [partner, setPartner] = useState("");
  const [note, setNote] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Otwarcie formularza z podpowiedzianą kwotą i nazwiskiem. Data = dziś; wszystko
  // można nadpisać przed zapisem (spłata częściowa to normalna sytuacja).
  useEffect(() => {
    if (!prefill || !canEdit) return;
    setEditId(null);
    setAdding(true);
    setPartner(prefill.partner);
    setAmount(String(Math.round(prefill.amount * 100) / 100));
    setDate(todayISO());
    wrapRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [prefill, canEdit]);

  const total = rows.reduce((s, r) => s + Math.abs(r.amount_pln), 0);
  const reset = () => { setAdding(false); setEditId(null); setDate(todayISO()); setAmount(""); setPartner(""); setNote(""); };

  const save = async () => {
    const v = parseAmount(amount);
    if (v == null || v === 0) { toast("Podaj kwotę", "warning"); return; }
    if (!partner.trim()) { toast("Podaj wspólnika", "warning"); return; }
    setBusy(true);
    try {
      const signed = isLoan ? Math.abs(v) : -Math.abs(v);
      const body = { firma_slug: shop, loan_date: date, amount_pln: signed, partner: partner.trim(), note: note || null };
      if (editId != null) await api.patch(`/owner-loans/${editId}`, body);
      else await api.post("/owner-loans", body);
      toast(editId != null ? "Wpis poprawiony" : (isLoan ? "Pożyczka zapisana" : "Spłata zapisana"), "ok");
      reset();
      onChanged();
    } catch {
      toast("Nie udało się zapisać wpisu", "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: OwnerLoan) => {
    if (!confirm(`Usunąć wpis ${row.partner} z ${dLong(row.loan_date)}?`)) return;
    try {
      await api.del(`/owner-loans/${row.id}`);
      toast("Wpis usunięty", "ok");
      onChanged();
    } catch {
      toast("Nie udało się usunąć wpisu", "error");
    }
  };

  const startEdit = (row: OwnerLoan) => {
    setEditId(row.id);
    setAdding(true);
    setDate(row.loan_date);
    setAmount(String(Math.abs(row.amount_pln)));
    setPartner(row.partner);
    setNote(row.note || "");
  };

  const desc = [...rows].sort((a, b) => b.loan_date.localeCompare(a.loan_date));

  return (
    <div ref={wrapRef}>
    <Card>
      <CardHeader
        icon={isLoan ? <I.TrendUp size={14} /> : <I.TrendDown size={14} />}
        title={isLoan ? "Pożyczki od wspólników" : "Spłaty pożyczek"}
        hint={rows.length ? `razem: ${fmtPLN(total)}` : (isLoan ? "wpłaty do firmy" : "zwroty wspólnikom")}
        accent={isLoan ? "var(--anomaly)" : "var(--ok)"}
        action={canEdit && !adding
          ? <button onClick={() => setAdding(true)} style={btnAccent}>{isLoan ? "+ Dodaj pożyczkę" : "+ Dodaj spłatę"}</button>
          : undefined}
      />

      {adding && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elevated)" }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
          <input inputMode="decimal" placeholder="Kwota w zł" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...inputStyle, width: 120 }} />
          <input list="magazyn-partners" placeholder="Wspólnik" value={partner} onChange={(e) => setPartner(e.target.value)} style={{ ...inputStyle, width: 140 }} />
          <datalist id="magazyn-partners">{partners.map((x) => <option key={x} value={x} />)}</datalist>
          <input placeholder="Notatka" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inputStyle, flex: "1 1 120px" }} />
          <button onClick={save} disabled={busy} style={{ ...btnAccent, opacity: busy ? 0.6 : 1 }}>{editId != null ? "Zapisz zmiany" : "Zapisz"}</button>
          <button onClick={reset} style={btnStyle}>Anuluj</button>
        </div>
      )}

      {desc.length === 0 ? (
        <div style={emptyStyle}>
          {isLoan
            ? "Brak wpisów. Dodaj pierwszą wpłatę, żeby odjąć ją od linii konta."
            : "Brak spłat. Każda dopisana tutaj zmniejszy kwotę „do spłaty” niżej."}
        </div>
      ) : (
        <div style={{ maxHeight: 420, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Data</th>
                <th style={thStyle}>Wspólnik</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Kwota</th>
                {canEdit && <th style={{ ...thStyle, width: 1 }} />}
              </tr>
            </thead>
            <tbody>
              {desc.map((r) => (
                <tr key={r.id}>
                  <td style={tdStyle}><span className="num">{r.loan_date}</span></td>
                  <td style={tdStyle}>
                    {r.partner}
                    {r.note && <div style={{ color: "var(--text-lo)", fontSize: 11, marginTop: 2 }}>{r.note}</div>}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", color: isLoan ? "var(--text-hi)" : "var(--ok)" }} className="num">
                    {isLoan ? "+" : "−"}{fmtPLN(Math.abs(r.amount_pln))}
                  </td>
                  {canEdit && (
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <button onClick={() => startEdit(r)} style={{ ...btnStyle, padding: "3px 8px" }}>Popraw</button>{" "}
                      <button onClick={() => remove(r)} style={{ ...btnStyle, padding: "3px 8px", color: "var(--critical)" }}>Usuń</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
    </div>
  );
}

export default MoneyEntriesTab;

// ── Podsumowanie per wspólnik ────────────────────────────────
function PartnersSummary({ loans, canEdit, onRepay }: {
  loans: OwnerLoan[];
  canEdit: boolean;
  onRepay: (partner: string, amount: number) => void;
}) {
  const rows = useMemo(() => {
    // Grupujemy po nazwisku bez względu na wielkość liter i podwójne spacje —
    // „Tomasz" i „tomasz " to ten sam człowiek, a pole jest tekstowe.
    const acc = new Map<string, { name: string; wplaty: number; zwroty: number; ile: number; last: string }>();
    loans.forEach((l) => {
      const key = l.partner.trim().toLowerCase().replace(/\s+/g, " ");
      const cur = acc.get(key) || { name: l.partner.trim(), wplaty: 0, zwroty: 0, ile: 0, last: "" };
      if (l.amount_pln >= 0) { cur.wplaty += l.amount_pln; cur.ile += 1; }
      else cur.zwroty += -l.amount_pln;
      if (l.loan_date > cur.last) cur.last = l.loan_date;
      acc.set(key, cur);
    });
    return [...acc.values()]
      .map((r) => ({ ...r, saldo: r.wplaty - r.zwroty }))
      .sort((a, b) => b.saldo - a.saldo);
  }, [loans]);

  const total = rows.reduce((s, r) => s + r.saldo, 0);

  return (
    <Card>
      <CardHeader
        icon={<I.Wallet size={14} />}
        title="Do spłaty wspólnikom"
        hint={`${rows.length} ${rows.length === 1 ? "osoba" : "osoby"}`}
        accent="var(--anomaly)"
      />
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Wspólnik</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Wpłacone</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Spłacone</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Do spłaty</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Udział</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Ostatnia wpłata</th>
            {canEdit && <th style={{ ...thStyle, width: 1 }} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td style={{ ...tdStyle, color: "var(--text-hi)", fontWeight: 600 }}>
                {r.name}
                <span style={{ color: "var(--text-lo)", fontWeight: 400, marginLeft: 8, fontSize: 11 }}>
                  {r.ile} {r.ile === 1 ? "wpłata" : r.ile < 5 ? "wpłaty" : "wpłat"}
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
              {canEdit && (
                <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                  {r.saldo > 0 && (
                    <button
                      onClick={() => onRepay(r.name, r.saldo)}
                      title={`Wpisz spłatę dla: ${r.name}`}
                      style={{ ...btnStyle, padding: "3px 10px", color: "var(--ok)" }}
                    >
                      Spłać
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          <tr>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)", color: "var(--text-hi)", fontWeight: 600 }}>
              Suma całkowita
            </td>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)", textAlign: "right" }} className="num">
              {fmtPLN(rows.reduce((s, r) => s + r.wplaty, 0))}
            </td>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)", textAlign: "right", color: "var(--ok)" }} className="num">
              −{fmtPLN(rows.reduce((s, r) => s + r.zwroty, 0))}
            </td>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)", textAlign: "right", color: "var(--accent)", fontWeight: 700, fontSize: 13 }} className="num">
              {fmtPLN(total)}
            </td>
            <td style={{ ...tdStyle, borderBottom: "none", borderTop: "1px solid var(--border)" }} colSpan={canEdit ? 3 : 2} />
          </tr>
        </tbody>
      </table>
    </Card>
  );
}
