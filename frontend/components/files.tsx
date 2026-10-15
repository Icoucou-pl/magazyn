"use client";
// ============================================================
// MAGAZYN — Pliki (dokumenty jak na dysku Google). Widok tylko dla superadmina.
//   · Producenci / producent / kontener — foldery zakłada i nazywa sama aplikacja
//     (kontener skonsolidowany ma folder u każdego swojego producenta),
//   · własne foldery gdziekolwiek, wrzucanie przeciąganiem, podgląd PDF/zdjęć,
//   · ptaszek „na kontenerze” — plik widać też na karcie kontenera,
//   · kosz: przywracanie, „usuń na zawsze”, po 30 dniach kasuje się samo.
// Pliki z karty kontenera trafiają tu same (folder kontenera, z ptaszkiem).
// Backend: routers/pliki.py, pliki leżą w Supabase Storage (services/pliki_storage.py).
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, download } from "@/lib/api";
import { canSeeFiles, useUser } from "@/lib/permissions";
import { containerSlug } from "@/lib/routes";
import { useShop } from "@/lib/shop";
import { toast } from "./toast";
import { I, Card, CONTAINER_STATUS_META } from "./ui";
import { Portal } from "./products-ui";

// ── Typy ─────────────────────────────────────────────────────
type Rodzaj = "reczny" | "producenci" | "producent" | "kontener";
type FolderRow = {
  id: number; nazwa: string; rodzaj: Rodzaj; automatyczny: boolean;
  manufacturer_id: number | null; container_id: number | null; kolor: string | null;
  kontener: { id: number; container_number: string | null; order_number: string | null; status: string | null; eta_date: string | null } | null;
  ile_plikow: number; ile_folderow: number; utworzono: string | null; utworzyl: string | null;
};
type FileRow = {
  id: number; nazwa: string; folder_id: number | null; typ: string; rozmiar: number; rozmiar_txt: string;
  content_type: string | null; container_id: number | null; pokaz_na_kontenerze: boolean;
  dodano_z_kontenera: boolean; dodano: string | null; dodal: string | null; folder_nazwa?: string | null;
};
type Crumb = { id: number; nazwa: string; rodzaj: Rodzaj };
type Listing = {
  folder: (FolderRow & { parent_id: number | null }) | null;
  sciezka: Crumb[]; foldery: FolderRow[]; pliki: FileRow[];
};
type Status = { storage: boolean; max_mb: number; kosz_dni: number };
type TreeNode = { id: number; parent_id: number | null; nazwa: string; rodzaj: Rodzaj };
type TrashFolder = { id: number; nazwa: string; parent_id: number | null; usuniety_at: string; usunal: string | null; folder_nazwa: string | null; ile_plikow: number };
type TrashFile = { id: number; nazwa: string; folder_id: number | null; typ: string; rozmiar_txt: string; usuniety_at: string; usunal: string | null; folder_nazwa: string | null };
type Trash = { dni: number; foldery: TrashFolder[]; pliki: TrashFile[] };
type Target = { typ: "folder" | "plik"; id: number; nazwa: string };

const err = (e: unknown) => toast(e instanceof Error ? e.message : "Coś poszło nie tak", "error");
const kiedy = (s?: string | null) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 16)}` : "—");
const dzien = (s?: string | null) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : "—");
const kto = (e?: string | null) => (e ? e.split("@")[0] : "");
const podglad = (f: { typ: string }) => f.typ === "pdf" || f.typ === "image";

// ── Drobne elementy (styl jak w Dropach) ─────────────────────
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13,
  background: "var(--surface-2)", color: "var(--text-hi)",
  border: "1px solid var(--border-soft)", borderRadius: 8,
};

function btn(variant: "primary" | "ghost" | "danger" = "ghost", small = false): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: small ? "5px 10px" : "8px 14px",
    fontSize: small ? 12 : 13, fontWeight: 500, cursor: "pointer",
    borderRadius: 8, whiteSpace: "nowrap",
    background: variant === "primary" ? "var(--accent)" : "var(--surface-2)",
    color: variant === "primary" ? "#1a1408" : variant === "danger" ? "var(--critical)" : "var(--text-mid)",
    border: `1px solid ${variant === "primary" ? "var(--accent)" : "var(--border-soft)"}`,
  };
}

const iconBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 30, height: 30, padding: 0, borderRadius: 7, flexShrink: 0,
  background: "transparent", color: "var(--text-mid)", border: "1px solid transparent", cursor: "pointer",
};

function TypBadge({ typ, nazwa }: { typ: string; nazwa: string }) {
  const ext = nazwa.includes(".") ? nazwa.split(".").pop()!.slice(0, 4) : typ.slice(0, 4);
  const [bg, fg] = typ === "pdf" ? ["var(--critical-soft)", "var(--critical)"]
    : typ === "image" ? ["var(--info-soft)", "var(--info)"]
    : typ === "zip" ? ["var(--warning-soft)", "var(--warning)"]
    : ["var(--ok-soft)", "var(--ok)"];
  return (
    <span className="mono" style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center", width: 34, height: 22, flexShrink: 0,
      fontSize: 9, fontWeight: 700, background: bg, color: fg, borderRadius: 4,
    }}>{(ext || "?").toUpperCase()}</span>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(8,10,16,.55)",
        display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "84px 16px 24px",
      }}>
        <div onClick={(e) => e.stopPropagation()} style={{
          width: "100%", maxWidth: wide ? 640 : 440, background: "var(--surface-1)",
          border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)",
          display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 108px)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--border-soft)", flexShrink: 0 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h3>
            <button onClick={onClose} style={{ ...btn("ghost", true), padding: 6 }} aria-label="Zamknij"><I.Close size={14}/></button>
          </div>
          <div style={{ padding: 18, overflowY: "auto", minHeight: 0 }}>{children}</div>
        </div>
      </div>
    </Portal>
  );
}

// Menu „⋯” przy wierszu — na telefonie rząd ikon by się nie zmieścił.
type MenuItem = { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean };

function RowMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!items.length) return <span style={{ width: 30, flexShrink: 0 }}/>;
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(!open); }} style={iconBtn} aria-label="Więcej" title="Więcej">
        <span style={{ fontSize: 16, lineHeight: 1, letterSpacing: 1 }}>⋯</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: 32, zIndex: 50, minWidth: 230, padding: 4,
          background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 10px 30px rgba(0,0,0,.35)",
        }}>
          {items.map((it) => (
            <button key={it.label} onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", fontSize: 13,
              background: "none", border: "none", borderRadius: 6, cursor: "pointer", textAlign: "left",
              color: it.danger ? "var(--critical)" : "var(--text-hi)",
            }}>{it.icon}{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
  borderBottom: "1px solid var(--border-soft)", minWidth: 0,
};

// ============================================================
// WIDOK GŁÓWNY
// ============================================================
// Pamięć folderów poza komponentem: po powrocie z karty kontenera widok montuje się od nowa,
// a folder ma się pokazać od razu (świeże dane i tak dociągają się w tle).
const pamiecFolderow = new Map<string, Listing>();

export default function FilesView({ folderId, onFolder, onOpenContainer }: {
  /** Otwarty folder — z adresu (/pliki/123), żeby „wstecz” w przeglądarce cofało o folder. */
  folderId: number | null;
  /** Przejście do folderu; zamien = bez nowego wpisu w historii (folder zniknął). */
  onFolder: (fid: number | null, zamien?: boolean) => void;
  onOpenContainer?: (key: string) => void;
}) {
  const user = useUser();
  // Przełącznik firm u góry: przy AMH widać tylko producentów i kontenery z towarem AMH.
  const { shop } = useShop();
  // Zawartość odwiedzonych folderów — powrót do folderu pokazuje się od razu, a świeże dane
  // dociągają się w tle. Najechanie na folder ładuje go z wyprzedzeniem.
  const [cache, setCache] = useState<Record<string, Listing>>(() => Object.fromEntries(pamiecFolderow));
  const [ladowanie, setLadowanie] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [tryb, setTryb] = useState<"lista" | "kosz">("lista");
  const [q, setQ] = useState("");
  const [wynikiSzukania, setWynikiSzukania] = useState<{ pliki: FileRow[]; foldery: (TreeNode & { folder_nazwa: string | null })[] } | null>(null);
  const [wgrywanie, setWgrywanie] = useState<{ done: number; total: number } | null>(null);
  const [przeciaganie, setPrzeciaganie] = useState(false);
  const [pokazNaKontenerze, setPokazNaKontenerze] = useState(false);
  const [nowyFolder, setNowyFolder] = useState(false);
  const [zmianaNazwy, setZmianaNazwy] = useState<Target | null>(null);
  const [przenies, setPrzenies] = useState<Target | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const [odswiez, setOdswiez] = useState(0);
  const load = useCallback(() => { setLadowanie(true); setOdswiez((n) => n + 1); }, []);
  const klucz = (fid: number | null) => `${shop || "wszystkie"}:${fid ?? "root"}`;
  const data = cache[klucz(folderId)] ?? null;
  const pobierzListe = (fid: number | null) =>
    api.get(`/pliki/lista?shop=${encodeURIComponent(shop)}${fid != null ? `&folder_id=${fid}` : ""}`)
      .then((r) => {
        pamiecFolderow.set(klucz(fid), r as Listing);
        setCache((c) => ({ ...c, [klucz(fid)]: r as Listing }));
      });
  const zWyprzedzeniem = (fid: number) => { if (!cache[klucz(fid)]) pobierzListe(fid).catch(() => {}); };

  useEffect(() => {
    pobierzListe(folderId)
      .catch((e) => {
        err(e);
        // Folder zniknął (kosz w innej karcie) — wracamy na górę zamiast pustego ekranu.
        if (folderId != null) onFolder(null, true);
      })
      .finally(() => setLadowanie(false));
  }, [folderId, odswiez, shop]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get("/pliki/status").then((s) => setStatus(s as Status)).catch(() => {}); }, []);

  // Wyszukiwarka: od 2 znaków, z małym opóźnieniem, żeby nie strzelać przy każdej literze.
  // Krótsze zapytanie = brak wyników (liczone niżej), bez czyszczenia stanu w efekcie.
  const qq = q.trim();
  const wyniki = qq.length >= 2 ? wynikiSzukania : null;
  useEffect(() => {
    if (qq.length < 2) return;
    const h = setTimeout(() => {
      api.get(`/pliki/szukaj?q=${encodeURIComponent(qq)}&shop=${encodeURIComponent(shop)}`).then((r) => setWynikiSzukania(r as typeof wynikiSzukania)).catch(err);
    }, 300);
    return () => clearTimeout(h);
  }, [qq, odswiez, shop]);

  const wKontenerze = !!data?.sciezka.some((c) => c.rodzaj === "kontener");
  const idz = (fid: number | null) => {
    setQ(""); setTryb("lista");
    if (fid !== folderId) { setLadowanie(true); onFolder(fid); }
  };

  // ── Wgrywanie: po jednym pliku, żeby był postęp i żeby jeden zły plik nie zatrzymał reszty ──
  const wgraj = async (files: File[]) => {
    if (!files.length) return;
    if (!status?.storage) { toast("Przechowywanie plików nie jest jeszcze skonfigurowane", "warning"); return; }
    const max = (status.max_mb || 50) * 1024 * 1024;
    const zaDuze = files.filter((f) => f.size > max);
    const dobre = files.filter((f) => f.size <= max && f.size > 0);
    if (zaDuze.length) toast(`Pominięto (ponad ${status.max_mb} MB): ${zaDuze.map((f) => f.name).join(", ")}`, "warning");
    if (!dobre.length) return;
    setWgrywanie({ done: 0, total: dobre.length });
    let ok = 0;
    for (const f of dobre) {
      const fd = new FormData();
      fd.append("files", f);
      if (folderId != null) fd.append("folder_id", String(folderId));
      if (wKontenerze && pokazNaKontenerze) fd.append("pokaz_na_kontenerze", "true");
      try { await api.post("/pliki/wgraj", fd); ok += 1; }
      catch (e) { toast(`${f.name}: ${e instanceof Error ? e.message : "błąd"}`, "error"); }
      setWgrywanie({ done: ok, total: dobre.length });
    }
    setWgrywanie(null);
    if (ok) toast(ok === 1 ? "Wgrano plik" : `Wgrano ${ok} pliki/plików`, "ok");
    load();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); dragDepth.current = 0; setPrzeciaganie(false);
    if (tryb === "lista" && !wyniki) wgraj(Array.from(e.dataTransfer.files || []));
  };
  const maPliki = (e: React.DragEvent) => Array.from(e.dataTransfer.types || []).includes("Files");

  // ── Akcje na wierszach ──
  // Pobieranie i podgląd prosto z Supabase (link ważny 5 min) — bajty nie idą przez nasz serwer.
  const pobierz = async (f: FileRow) => {
    try {
      const { url } = (await api.get(`/pliki/plik/${f.id}/link`)) as { url: string };
      // Link ma „download” w adresie — Supabase każe przeglądarce zapisać plik, strona zostaje.
      const a = document.createElement("a");
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch { toast("Nie udało się pobrać pliku", "warning"); }
  };
  const pokaz = async (f: FileRow) => {
    const okno = window.open("", "_blank");   // od razu w kliknięciu, inaczej blokada wyskakujących okien
    try {
      const { url } = (await api.get(`/pliki/plik/${f.id}/link?pobierz=false`)) as { url: string };
      if (okno) okno.location.href = url; else window.open(url, "_blank");
    } catch {
      okno?.close();
      toast("Nie udało się otworzyć pliku", "warning");
    }
  };
  const doKosza = async (t: Target) => {
    try {
      await api.del(t.typ === "plik" ? `/pliki/plik/${t.id}` : `/pliki/folder/${t.id}`);
      toast(`„${t.nazwa}” w koszu — można przywrócić przez ${status?.kosz_dni ?? 30} dni`, "ok");
      load();
    } catch (e) { err(e); }
  };
  const przelaczKontener = async (f: FileRow) => {
    try {
      await api.patch(`/pliki/plik/${f.id}`, { pokaz_na_kontenerze: !f.pokaz_na_kontenerze });
      toast(f.pokaz_na_kontenerze ? "Plik zdjęty z karty kontenera" : "Plik widoczny na karcie kontenera", "ok");
      load();
    } catch (e) { err(e); }
  };
  const otworzKontener = (k: NonNullable<FolderRow["kontener"]>) =>
    onOpenContainer?.(containerSlug({ id: k.id, container_number: k.container_number, order_number: k.order_number }));

  if (!canSeeFiles(user)) {
    return <Card padding={24}><div style={{ color: "var(--text-lo)", fontSize: 13 }}>Zakładka Pliki jest na razie dostępna tylko dla superadmina.</div></Card>;
  }

  const folderMenu = (f: FolderRow) => {
    const t: Target = { typ: "folder", id: f.id, nazwa: f.nazwa };
    const items: MenuItem[] = [];
    if (f.kontener) items.push({ label: "Otwórz kartę kontenera", icon: <I.Ship size={14}/>, onClick: () => otworzKontener(f.kontener!) });
    if (!f.automatyczny) {
      items.push({ label: "Zmień nazwę", icon: <I.Edit size={14}/>, onClick: () => setZmianaNazwy(t) });
      items.push({ label: "Przenieś do…", icon: <I.ArrowRight size={14}/>, onClick: () => setPrzenies(t) });
      items.push({ label: "Do kosza", icon: <I.Trash size={14}/>, onClick: () => doKosza(t), danger: true });
    }
    return items;
  };
  const plikMenu = (f: FileRow) => {
    const t: Target = { typ: "plik", id: f.id, nazwa: f.nazwa };
    const items: MenuItem[] = [{ label: "Pobierz", icon: <I.ArrowDown size={14}/>, onClick: () => { pobierz(f); } }];
    if (podglad(f)) items.push({ label: "Podgląd w nowej karcie", icon: <I.Eye size={14}/>, onClick: () => pokaz(f) });
    if (f.container_id) items.push({
      label: f.pokaz_na_kontenerze ? "Nie pokazuj na kontenerze" : "Pokaż na kontenerze",
      icon: <I.Ship size={14}/>, onClick: () => przelaczKontener(f),
    });
    items.push({ label: "Zmień nazwę", icon: <I.Edit size={14}/>, onClick: () => setZmianaNazwy(t) });
    items.push({ label: "Przenieś do…", icon: <I.ArrowRight size={14}/>, onClick: () => setPrzenies(t) });
    items.push({ label: "Do kosza", icon: <I.Trash size={14}/>, onClick: () => doKosza(t), danger: true });
    return items;
  };

  const folderLine = (f: FolderRow) => {
    const st = f.kontener?.status ? CONTAINER_STATUS_META[f.kontener.status] : null;
    const opis = [
      f.ile_folderow ? `${f.ile_folderow} ${f.ile_folderow === 1 ? "folder" : "folderów"}` : null,
      f.ile_plikow ? `${f.ile_plikow} ${f.ile_plikow === 1 ? "plik" : "plików"}` : null,
    ].filter(Boolean).join(" · ") || "pusty";
    return (
      <div key={f.id} style={{ ...rowStyle, cursor: "pointer" }} onClick={() => idz(f.id)} onMouseEnter={() => zWyprzedzeniem(f.id)} className="hover-row">
        <span style={{ color: f.rodzaj === "kontener" ? "var(--info)" : f.automatyczny ? "var(--accent)" : "var(--text-mid)", display: "flex", flexShrink: 0 }}>
          {f.rodzaj === "kontener" ? <I.Container size={18}/> : <I.Folder size={18}/>}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={f.rodzaj === "kontener" ? "mono" : undefined} style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-hi)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {f.kolor && f.rodzaj === "producent" && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 99, background: f.kolor, marginRight: 7, verticalAlign: "middle" }}/>}
            {f.nazwa}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginTop: 1, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {st && <span style={{ color: st.fg }}>{st.label}</span>}
            {f.kontener?.eta_date && <span>ETA {dzien(f.kontener.eta_date)}</span>}
            <span>{opis}</span>
          </div>
        </div>
        <RowMenu items={folderMenu(f)}/>
      </div>
    );
  };

  const fileLine = (f: FileRow, gdzie = false) => (
    <div key={`p${f.id}`} style={rowStyle} className="hover-row">
      <TypBadge typ={f.typ} nazwa={f.nazwa}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button onClick={() => (podglad(f) ? pokaz(f) : pobierz(f))} title={podglad(f) ? "Otwórz podgląd" : "Pobierz"} style={{
          display: "block", maxWidth: "100%", padding: 0, background: "none", border: "none", cursor: "pointer", textAlign: "left",
          fontSize: 13.5, color: "var(--text-hi)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{f.nazwa}</button>
        <div style={{ fontSize: 11.5, color: "var(--text-lo)", marginTop: 1, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span>{f.rozmiar_txt}</span>
          <span>{kiedy(f.dodano)}{f.dodal ? ` · ${kto(f.dodal)}` : ""}</span>
          {gdzie && <span>w: {f.folder_nazwa || "główny poziom"}</span>}
        </div>
      </div>
      {f.container_id != null && (
        <button onClick={() => przelaczKontener(f)} title={f.pokaz_na_kontenerze ? "Widoczny na karcie kontenera — kliknij, żeby zdjąć" : "Kliknij, żeby pokazać na karcie kontenera"} style={{
          display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", fontSize: 11, borderRadius: 99, cursor: "pointer", flexShrink: 0,
          background: f.pokaz_na_kontenerze ? "var(--info-soft)" : "transparent",
          color: f.pokaz_na_kontenerze ? "var(--info)" : "var(--text-lo)",
          border: `1px solid ${f.pokaz_na_kontenerze ? "transparent" : "var(--border-soft)"}`,
        }}>
          <span style={{ fontSize: 12 }}>{f.pokaz_na_kontenerze ? "✓" : "○"}</span>
          <span className="pliki-chip-label">na kontenerze</span>
        </button>
      )}
      <button onClick={() => pobierz(f)} style={iconBtn} title="Pobierz" aria-label="Pobierz"><I.ArrowDown size={15}/></button>
      <RowMenu items={plikMenu(f)}/>
    </div>
  );

  const pusto = data && !data.foldery.length && !data.pliki.length;

  return (
    <div className="fade-in" style={{ paddingBottom: 80 }}
         onDragEnter={(e) => { if (maPliki(e)) { dragDepth.current += 1; setPrzeciaganie(true); } }}
         onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setPrzeciaganie(false); }}
         onDragOver={(e) => { if (maPliki(e)) e.preventDefault(); }}
         onDrop={onDrop}>
      <style>{`.hover-row:hover{background:var(--surface-2)} @media (max-width:640px){.pliki-chip-label{display:none}} @keyframes pliki-spin{to{transform:rotate(360deg)}}`}</style>

      {/* Pasek: okruszki + szukaj + akcje */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <nav style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", fontSize: 14, flex: "1 1 260px", minWidth: 0 }}>
          <button onClick={() => idz(null)} style={{ background: "none", border: "none", padding: "4px 2px", cursor: "pointer", fontSize: 15, fontWeight: 600, color: tryb === "lista" && folderId == null ? "var(--text-hi)" : "var(--text-mid)" }}>Pliki</button>
          {tryb === "kosz" ? (
            <><I.ChevronR size={13} style={{ color: "var(--text-lo)" }}/><span style={{ fontWeight: 600 }}>Kosz</span></>
          ) : data?.sciezka.map((c, i) => (
            <React.Fragment key={c.id}>
              <I.ChevronR size={13} style={{ color: "var(--text-lo)" }}/>
              <button onClick={() => idz(c.id)} className={c.rodzaj === "kontener" ? "mono" : undefined} style={{
                background: "none", border: "none", padding: "4px 2px", cursor: "pointer", fontSize: 14,
                fontWeight: i === data.sciezka.length - 1 ? 600 : 400,
                color: i === data.sciezka.length - 1 ? "var(--text-hi)" : "var(--text-mid)",
              }}>{c.nazwa}</button>
            </React.Fragment>
          ))}
          {ladowanie && tryb === "lista" && (
            <I.Refresh size={13} style={{ color: "var(--text-lo)", marginLeft: 6, animation: "pliki-spin 1s linear infinite" }}/>
          )}
        </nav>
        <div style={{ position: "relative", flex: "0 1 240px", minWidth: 160 }}>
          <I.Search size={14} style={{ position: "absolute", left: 10, top: 10, color: "var(--text-lo)" }}/>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj pliku lub folderu" style={{ ...inputStyle, paddingLeft: 30 }}/>
        </div>
        {tryb === "lista" && (
          <>
            <button onClick={() => setNowyFolder(true)} style={btn()}><I.Plus size={14}/> Folder</button>
            <button onClick={() => fileRef.current?.click()} disabled={!status?.storage || !!wgrywanie} style={{ ...btn("primary"), opacity: status?.storage ? 1 : 0.5 }}
                    title={status?.storage ? "Wgraj pliki do tego folderu" : "Przechowywanie plików nie jest jeszcze skonfigurowane"}>
              <I.Upload size={14}/> Wgraj
            </button>
          </>
        )}
        <button onClick={() => { setQ(""); setTryb(tryb === "kosz" ? "lista" : "kosz"); }} style={{ ...btn(), color: tryb === "kosz" ? "var(--text-hi)" : "var(--text-mid)" }} title="Kosz">
          <I.Trash size={14}/> {tryb === "kosz" ? "Wróć" : "Kosz"}
        </button>
        <input ref={fileRef} type="file" multiple style={{ display: "none" }}
               onChange={(e) => { wgraj(Array.from(e.target.files || [])); if (fileRef.current) fileRef.current.value = ""; }}/>
      </div>

      {status && !status.storage && (
        <Card padding={14} style={{ marginBottom: 14, borderColor: "var(--warning)" }}>
          <div style={{ fontSize: 13, color: "var(--warning)" }}>
            Przechowywanie plików (Supabase Storage) nie jest jeszcze skonfigurowane — foldery działają, wgrywanie ruszy po
            ustawieniu w Railway zmiennych <span className="mono">PLIKI_STORAGE_EMAIL</span> i <span className="mono">PLIKI_STORAGE_PASSWORD</span> (instrukcja: <span className="mono">sql/2026-10-pliki.sql</span>).
          </div>
        </Card>
      )}

      {tryb === "lista" && wKontenerze && !wyniki && status?.storage && (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-mid)", marginBottom: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={pokazNaKontenerze} onChange={(e) => setPokazNaKontenerze(e.target.checked)}/>
          Nowe pliki pokazuj też na karcie kontenera
        </label>
      )}

      {wgrywanie && (
        <div style={{ fontSize: 12.5, color: "var(--accent)", marginBottom: 10 }}>Wgrywam… {wgrywanie.done}/{wgrywanie.total}</div>
      )}

      {tryb === "kosz" ? (
        <KoszView onZmiana={() => load()} onIdz={idz}/>
      ) : wyniki ? (
        <Card>
          <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-lo)", borderBottom: "1px solid var(--border-soft)" }}>
            Wyniki dla „{qq}”: {wyniki.foldery.length + wyniki.pliki.length}
          </div>
          {wyniki.foldery.map((f) => (
            <div key={`f${f.id}`} style={{ ...rowStyle, cursor: "pointer" }} className="hover-row" onClick={() => idz(f.id)}>
              <span style={{ color: "var(--text-mid)", display: "flex" }}><I.Folder size={18}/></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: "var(--text-hi)" }}>{f.nazwa}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-lo)" }}>w: {f.folder_nazwa || "główny poziom"}</div>
              </div>
            </div>
          ))}
          {wyniki.pliki.map((f) => fileLine(f, true))}
          {!wyniki.foldery.length && !wyniki.pliki.length && (
            <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--text-lo)" }}>Nic nie znaleziono</div>
          )}
        </Card>
      ) : (
        <Card style={{ position: "relative", overflow: "visible" }}>
          {!data ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--text-lo)" }}>Wczytuję…</div>
          ) : (
            <>
              {data.foldery.map(folderLine)}
              {data.pliki.map((f) => fileLine(f))}
              {pusto && (
                <div style={{ padding: 32, textAlign: "center", fontSize: 13, color: "var(--text-lo)" }}>
                  Pusto. {status?.storage ? "Przeciągnij tu pliki albo kliknij „Wgraj”." : ""}
                </div>
              )}
            </>
          )}
          {przeciaganie && (
            <div style={{
              position: "absolute", inset: 0, borderRadius: "var(--r-lg)", pointerEvents: "none",
              background: "var(--accent-soft)", border: "2px dashed var(--accent)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600, color: "var(--accent)",
              minHeight: 120,
            }}>
              {status?.storage ? `Upuść, żeby wgrać do „${data?.sciezka.at(-1)?.nazwa || "Pliki"}”` : "Wgrywanie nie jest jeszcze skonfigurowane"}
            </div>
          )}
        </Card>
      )}

      {tryb === "lista" && !wyniki && folderId == null && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--text-lo)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          Stare załączniki kontenerów (sprzed zakładki Pliki) są jeszcze w bazie — trafią tu w drugim kroku.
          <button onClick={() => {
            toast("Przygotowuję ZIP — przy wielu plikach to chwilę potrwa", "ok");
            download("/pliki/stare-zalaczniki.zip", "zalaczniki-kontenerow.zip").catch(() => toast("Nie udało się pobrać ZIP-a", "warning"));
          }} style={btn("ghost", true)}><I.ArrowDown size={13}/> Pobierz wszystkie jako ZIP</button>
        </div>
      )}

      {nowyFolder && (
        <NazwaModal title="Nowy folder" start="" onClose={() => setNowyFolder(false)} onSave={async (nazwa) => {
          await api.post("/pliki/folder", { nazwa, parent_id: folderId });
          setNowyFolder(false); load();
        }}/>
      )}
      {zmianaNazwy && (
        <NazwaModal title="Zmień nazwę" start={zmianaNazwy.nazwa} onClose={() => setZmianaNazwy(null)} onSave={async (nazwa) => {
          await api.patch(zmianaNazwy.typ === "plik" ? `/pliki/plik/${zmianaNazwy.id}` : `/pliki/folder/${zmianaNazwy.id}`, { nazwa });
          setZmianaNazwy(null); load();
        }}/>
      )}
      {przenies && (
        <PrzeniesModal cel={przenies} onClose={() => setPrzenies(null)} onDone={() => { setPrzenies(null); load(); }}/>
      )}
    </div>
  );
}

// ── Okno z nazwą (nowy folder / zmiana nazwy) ────────────────
function NazwaModal({ title, start, onClose, onSave }: { title: string; start: string; onClose: () => void; onSave: (n: string) => Promise<void> }) {
  const [v, setV] = useState(start);
  const [busy, setBusy] = useState(false);
  const zapisz = async () => {
    if (!v.trim() || busy) return;
    setBusy(true);
    try { await onSave(v.trim()); } catch (e) { err(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") zapisz(); }}
             onFocus={(e) => { const i = start.lastIndexOf("."); e.target.setSelectionRange(0, i > 0 ? i : start.length); }}
             placeholder="Nazwa" style={inputStyle} maxLength={200}/>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button onClick={onClose} style={btn()}>Anuluj</button>
        <button onClick={zapisz} disabled={!v.trim() || busy} style={{ ...btn("primary"), opacity: v.trim() ? 1 : 0.5 }}>{busy ? "Zapisuję…" : "Zapisz"}</button>
      </div>
    </Modal>
  );
}

// ── Okno „Przenieś do…” — drzewo folderów z filtrem ──────────
function PrzeniesModal({ cel, onClose, onDone }: { cel: Target; onClose: () => void; onDone: () => void }) {
  const [drzewo, setDrzewo] = useState<TreeNode[] | null>(null);
  const [wybor, setWybor] = useState<number | null | undefined>(undefined);   // undefined = nic, null = główny poziom
  const [filtr, setFiltr] = useState("");
  const [busy, setBusy] = useState(false);
  const [rozwiniete, setRozwiniete] = useState<Set<number>>(new Set());

  useEffect(() => { api.get("/pliki/drzewo").then((d) => setDrzewo(d as TreeNode[])).catch(err); }, []);

  const dzieci = useMemo(() => {
    const m = new Map<number | null, TreeNode[]>();
    for (const n of drzewo || []) m.set(n.parent_id, [...(m.get(n.parent_id) || []), n]);
    return m;
  }, [drzewo]);

  // Folder nie może trafić do siebie ani do swojego podfolderu — te gałęzie wycinamy.
  const zakazane = useMemo(() => {
    const s = new Set<number>();
    if (cel.typ !== "folder") return s;
    const stos = [cel.id];
    while (stos.length) { const id = stos.pop()!; s.add(id); (dzieci.get(id) || []).forEach((d) => stos.push(d.id)); }
    return s;
  }, [cel, dzieci]);

  const f = filtr.trim().toLowerCase();
  const pasujace = useMemo(() => (f ? (drzewo || []).filter((n) => n.nazwa.toLowerCase().includes(f) && !zakazane.has(n.id)) : []), [f, drzewo, zakazane]);

  const przenies = async () => {
    if (wybor === undefined || busy) return;
    setBusy(true);
    try {
      await api.patch(cel.typ === "plik" ? `/pliki/plik/${cel.id}` : `/pliki/folder/${cel.id}`,
                      cel.typ === "plik" ? { folder_id: wybor } : { parent_id: wybor });
      toast(`Przeniesiono „${cel.nazwa}”`, "ok");
      onDone();
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  const wiersz = (n: TreeNode, poziom: number): React.ReactNode => {
    const sub = (dzieci.get(n.id) || []).filter((d) => !zakazane.has(d.id));
    const open = rozwiniete.has(n.id);
    return (
      <React.Fragment key={n.id}>
        <div onClick={() => setWybor(n.id)} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", paddingLeft: 8 + poziom * 16, cursor: "pointer", borderRadius: 6,
          background: wybor === n.id ? "var(--accent-soft)" : undefined, color: wybor === n.id ? "var(--accent)" : "var(--text-hi)", fontSize: 13,
        }}>
          <button onClick={(e) => { e.stopPropagation(); const s = new Set(rozwiniete); if (open) s.delete(n.id); else s.add(n.id); setRozwiniete(s); }}
                  style={{ ...iconBtn, width: 18, height: 18, visibility: sub.length ? "visible" : "hidden" }}>
            {open ? <I.ChevronD size={12}/> : <I.ChevronR size={12}/>}
          </button>
          {n.rodzaj === "kontener" ? <I.Container size={14}/> : <I.Folder size={14}/>}
          <span className={n.rodzaj === "kontener" ? "mono" : undefined}>{n.nazwa}</span>
        </div>
        {open && sub.map((d) => wiersz(d, poziom + 1))}
      </React.Fragment>
    );
  };

  return (
    <Modal title={`Przenieś „${cel.nazwa}”`} onClose={onClose} wide>
      <input value={filtr} onChange={(e) => setFiltr(e.target.value)} placeholder="Szukaj folderu (np. numer kontenera)" style={inputStyle} autoFocus/>
      <div style={{ marginTop: 10, maxHeight: 360, overflowY: "auto", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 4 }}>
        {!drzewo ? (
          <div style={{ padding: 16, fontSize: 13, color: "var(--text-lo)" }}>Wczytuję…</div>
        ) : f ? (
          pasujace.length ? pasujace.map((n) => (
            <div key={n.id} onClick={() => setWybor(n.id)} style={{
              padding: "6px 10px", cursor: "pointer", borderRadius: 6, fontSize: 13,
              background: wybor === n.id ? "var(--accent-soft)" : undefined, color: wybor === n.id ? "var(--accent)" : "var(--text-hi)",
            }}>
              {n.nazwa} <span style={{ fontSize: 11, color: "var(--text-lo)" }}>· w: {drzewo.find((x) => x.id === n.parent_id)?.nazwa || "główny poziom"}</span>
            </div>
          )) : <div style={{ padding: 16, fontSize: 13, color: "var(--text-lo)" }}>Brak folderu o takiej nazwie</div>
        ) : (
          <>
            <div onClick={() => setWybor(null)} style={{
              padding: "6px 10px", cursor: "pointer", borderRadius: 6, fontSize: 13, fontWeight: 600,
              background: wybor === null ? "var(--accent-soft)" : undefined, color: wybor === null ? "var(--accent)" : "var(--text-hi)",
            }}>Pliki (główny poziom)</div>
            {(dzieci.get(null) || []).filter((d) => !zakazane.has(d.id)).map((n) => wiersz(n, 0))}
          </>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button onClick={onClose} style={btn()}>Anuluj</button>
        <button onClick={przenies} disabled={wybor === undefined || busy} style={{ ...btn("primary"), opacity: wybor === undefined ? 0.5 : 1 }}>
          {busy ? "Przenoszę…" : "Przenieś tutaj"}
        </button>
      </div>
    </Modal>
  );
}

// ── Kosz ─────────────────────────────────────────────────────
function KoszView({ onZmiana, onIdz }: { onZmiana: () => void; onIdz: (fid: number | null) => void }) {
  const [k, setK] = useState<(Trash & { teraz: number }) | null>(null);
  const [potwierdz, setPotwierdz] = useState<null | { opis: string; akcja: () => Promise<void> }>(null);

  const load = () => api.get("/pliki/kosz").then((r) => setK({ ...(r as Trash), teraz: Date.now() })).catch(err);
  useEffect(() => { load(); }, []);

  const ileDni = (s: string) => {
    const minelo = Math.floor(((k?.teraz ?? 0) - new Date(s).getTime()) / 86_400_000);
    return Math.max(0, (k?.dni ?? 30) - minelo);
  };
  const przywroc = async (pliki: number[], foldery: number[]) => {
    try {
      const r = (await api.post("/pliki/kosz/przywroc", { pliki, foldery })) as { na_glowny_poziom: number };
      toast(r.na_glowny_poziom ? "Przywrócono — folder, w którym leżało, jest w koszu, więc wróciło na główny poziom" : "Przywrócono", "ok");
      load(); onZmiana();
    } catch (e) { err(e); }
  };
  const usun = (pliki: number[], foldery: number[], nazwa: string) => setPotwierdz({
    opis: `„${nazwa}” zostanie usunięte na zawsze — tego nie da się cofnąć.`,
    akcja: async () => { await api.post("/pliki/kosz/usun", { pliki, foldery }); load(); },
  });
  const oproznij = () => setPotwierdz({
    opis: "Wszystko z kosza zostanie usunięte na zawsze — tego nie da się cofnąć.",
    akcja: async () => { await api.del("/pliki/kosz"); load(); },
  });

  const pusto = k && !k.foldery.length && !k.pliki.length;
  const akcje = (p: number[], f: number[], nazwa: string) => (
    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
      <button onClick={() => przywroc(p, f)} style={btn("ghost", true)}>Przywróć</button>
      <button onClick={() => usun(p, f, nazwa)} style={btn("danger", true)} title="Usuń na zawsze"><I.Trash size={13}/></button>
    </div>
  );

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ flex: 1, fontSize: 12.5, color: "var(--text-lo)" }}>
          Rzeczy w koszu kasują się same po {k?.dni ?? 30} dniach. Do tego czasu można je przywrócić na stare miejsce.
        </div>
        {!pusto && k && <button onClick={oproznij} style={btn("danger", true)}><I.Trash size={13}/> Opróżnij kosz</button>}
      </div>
      <Card>
        {!k ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--text-lo)" }}>Wczytuję…</div>
        ) : pusto ? (
          <div style={{ padding: 32, textAlign: "center", fontSize: 13, color: "var(--text-lo)" }}>Kosz jest pusty</div>
        ) : (
          <>
            {k.foldery.map((f) => (
              <div key={`f${f.id}`} style={rowStyle}>
                <span style={{ color: "var(--text-mid)", display: "flex" }}><I.Folder size={18}/></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: "var(--text-hi)" }}>{f.nazwa}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-lo)", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span>z: {f.folder_nazwa || "główny poziom"}</span>
                    <span>usunięto {kiedy(f.usuniety_at)}{f.usunal ? ` · ${kto(f.usunal)}` : ""}</span>
                    <span>zniknie za {ileDni(f.usuniety_at)} dni</span>
                  </div>
                </div>
                {akcje([], [f.id], f.nazwa)}
              </div>
            ))}
            {k.pliki.map((p) => (
              <div key={`p${p.id}`} style={rowStyle}>
                <TypBadge typ={p.typ} nazwa={p.nazwa}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: "var(--text-hi)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.nazwa}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-lo)", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span>{p.rozmiar_txt}</span>
                    <button onClick={() => onIdz(p.folder_id)} style={{ background: "none", border: "none", padding: 0, fontSize: 11.5, color: "var(--text-lo)", cursor: "pointer", textDecoration: "underline" }}>
                      z: {p.folder_nazwa || "główny poziom"}
                    </button>
                    <span>usunięto {kiedy(p.usuniety_at)}{p.usunal ? ` · ${kto(p.usunal)}` : ""}</span>
                    <span>zniknie za {ileDni(p.usuniety_at)} dni</span>
                  </div>
                </div>
                {akcje([p.id], [], p.nazwa)}
              </div>
            ))}
          </>
        )}
      </Card>
      {potwierdz && (
        <Modal title="Usunąć na zawsze?" onClose={() => setPotwierdz(null)}>
          <div style={{ fontSize: 13.5, color: "var(--text-mid)" }}>{potwierdz.opis}</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button onClick={() => setPotwierdz(null)} style={btn()}>Anuluj</button>
            <button onClick={async () => { try { await potwierdz.akcja(); toast("Usunięto na zawsze", "ok"); } catch (e) { err(e); } setPotwierdz(null); }}
                    style={{ ...btn(), background: "var(--critical)", color: "#fff", borderColor: "var(--critical)" }}>Usuń na zawsze</button>
          </div>
        </Modal>
      )}
    </>
  );
}
