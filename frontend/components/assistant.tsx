"use client";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { I } from "@/components/ui";

type Tool = { name: string; args: Record<string, unknown> };
type Msg = { role: "user" | "assistant"; content: string; tools?: Tool[] };

const DEFAULT_SUGGESTIONS = ["co muszę domówić?"];
const INTRO: Msg = { role: "assistant", content: "Cześć. Pytaj o magazyn po ludzku — stany, kiedy coś się skończy, co domówić." };

export default function Assistant() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([INTRO]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  // Podpowiedzi na realnych SKU — produkty najbliższe wyczerpania (z istniejącego /products).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const prods: any[] = await api.get("/products?include=ACTIVE,ACTIVE_NO_STOCK");
        if (!alive || !Array.isArray(prods)) return;
        const withSku = prods.filter(p => p && p.sku);
        withSku.sort((a, b) => (a.days_until_empty ?? 99999) - (b.days_until_empty ?? 99999));
        const top = withSku.slice(0, 3).map(p => p.sku as string);
        const dyn: string[] = ["co muszę domówić?"];
        if (top[0]) dyn.push(`kiedy skończy się ${top[0]}?`);
        if (top[1]) dyn.push(`ile mam ${top[1]}?`);
        if (top[2]) dyn.push(`kiedy skończy się ${top[2]}?`);
        setSuggestions(dyn);
      } catch { /* zostaw domyślne */ }
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs, loading, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    const next: Msg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    setInput("");
    setLoading(true);
    try {
      const history = next.filter(m => m !== INTRO).map(m => ({ role: m.role, content: m.content }));
      const res: any = await api.post("/assistant/chat", { messages: history });
      setMsgs(m => [...m, { role: "assistant", content: res?.answer || "(brak odpowiedzi)", tools: res?.tools || [] }]);
    } catch (e: any) {
      let msg = "Nie udało się uzyskać odpowiedzi. Spróbuj ponownie za chwilę.";
      if (e?.status === 503) msg = "Asystent nie jest jeszcze skonfigurowany (brak klucza LLM).";
      else if (e?.status === 429) msg = "Limit zapytań Groqa — odczekaj ~minutę i spróbuj ponownie.";
      else if (typeof e?.status === "number") msg = `Błąd ${e.status} — spróbuj ponownie za chwilę.`;
      setMsgs(m => [...m, { role: "assistant", content: msg }]);
    } finally {
      setLoading(false);
    }
  };

  if (!mounted) return null;

  const fab = (
    <button
      onClick={() => setOpen(true)}
      title="Asystent magazynu"
      style={{
        position: "fixed", bottom: 88, right: 24, width: 56, height: 56, borderRadius: 18,
        background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 6px 20px rgba(0,0,0,0.25)", zIndex: 1000,
        transition: "transform 0.12s, box-shadow 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.06)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
    >
      <I.Sparkles size={24}/>
    </button>
  );

  const bubbleBase: React.CSSProperties = {
    maxWidth: "82%", padding: "10px 13px", borderRadius: 14, fontSize: 14, lineHeight: 1.5,
    whiteSpace: "pre-wrap", wordBreak: "break-word",
  };

  const panel = (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 1001,
      width: "min(400px, calc(100vw - 32px))", height: "min(640px, calc(100vh - 100px))",
      display: "flex", flexDirection: "column",
      background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 18,
      boxShadow: "0 18px 50px rgba(0,0,0,0.35)", overflow: "hidden",
    }}>
      {/* Nagłówek */}
      <div style={{
        display: "flex", alignItems: "center", gap: 11, padding: "13px 14px",
        borderBottom: "1px solid var(--border-soft)", background: "var(--surface-2)",
      }}>
        <span style={{
          width: 38, height: 38, borderRadius: 11, background: "var(--accent)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          <I.Sparkles size={20}/>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-hi)" }}>i-coucou · Magazyn</div>
          <div style={{ fontSize: 11, color: "var(--text-lo)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--ok, #22c55e)" }}/>
            Asystent · online
          </div>
        </div>
        <button onClick={() => setOpen(false)} title="Zamknij" style={{
          background: "transparent", border: "none", cursor: "pointer", color: "var(--text-lo)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 6, borderRadius: 8,
        }}>
          <I.Close size={18}/>
        </button>
      </div>

      {/* Wiadomości */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", gap: 5 }}>
            <div style={{
              ...bubbleBase,
              background: m.role === "user" ? "var(--accent)" : "var(--surface-2)",
              color: m.role === "user" ? "#fff" : "var(--text-hi)",
              borderBottomRightRadius: m.role === "user" ? 4 : 14,
              borderBottomLeftRadius: m.role === "user" ? 14 : 4,
            }}>{m.content}</div>
          </div>
        ))}

        {loading && (
          <div style={{ ...bubbleBase, background: "var(--surface-2)", color: "var(--text-lo)", alignSelf: "flex-start", fontSize: 13 }}>
            …myślę
          </div>
        )}

        {msgs.length === 1 && !loading && (
          <div style={{ marginTop: "auto", display: "flex", flexWrap: "wrap", gap: 7 }}>
            {suggestions.map((s, i) => (
              <button key={i} onClick={() => send(s)} style={{
                fontSize: 12.5, color: "var(--text-mid)", background: "var(--surface-2)",
                border: "1px solid var(--border-soft)", borderRadius: 99, padding: "7px 12px", cursor: "pointer",
              }}>{s}</button>
            ))}
          </div>
        )}
      </div>

      {/* Pole wpisywania */}
      <div style={{ padding: 12, borderTop: "1px solid var(--border-soft)", background: "var(--surface-1)" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder="Zapytaj o magazyn…"
            disabled={loading}
            style={{
              flex: 1, fontSize: 14, padding: "11px 13px", borderRadius: 12,
              border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-hi)", outline: "none",
            }}
          />
          <button onClick={() => send(input)} disabled={loading || !input.trim()} title="Wyślij" style={{
            width: 42, height: 42, borderRadius: 12, flexShrink: 0,
            background: input.trim() && !loading ? "var(--accent)" : "var(--surface-3)",
            color: input.trim() && !loading ? "#fff" : "var(--text-lo)",
            border: "none", cursor: input.trim() && !loading ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <I.ArrowUp size={18}/>
          </button>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--text-lo)", textAlign: "center", marginTop: 7 }}>
          Odpowiedzi liczone na żywo z Twojej bazy
        </div>
      </div>
    </div>
  );

  return createPortal(open ? panel : fab, document.body);
}
