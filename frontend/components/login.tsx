"use client";
// ============================================================
// MAGAZYN — ekran logowania. Konwersja login.jsx → .tsx.
//   - MOCK setTimeout/MOCK.users → realne login() z lib/api
//   - błędy z ApiError; wygląd 1:1
//   - logo z /public/assets (skopiuj logo-white.png i logo-black.png)
// ============================================================

import React, { useState } from "react";
import { I } from "./ui";
import { login as apiLogin, ApiError } from "@/lib/api";
import type { User } from "./header";

export default function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError("");
    if (!email.trim() || !password.trim()) {
      setError("Wypełnij email i hasło");
      return;
    }
    setLoading(true);
    try {
      const user = (await apiLogin(email.trim(), password)) as User;
      onLogin(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Błąd logowania. Spróbuj ponownie.");
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Subtelne animowane tło */}
      <div style={{
        position: "absolute", inset: 0,
        background: `
          radial-gradient(circle at 20% 20%, color-mix(in oklch, var(--accent) 18%, transparent), transparent 50%),
          radial-gradient(circle at 80% 80%, color-mix(in oklch, var(--anomaly) 15%, transparent), transparent 50%)
        `,
        pointerEvents: "none",
      }}/>
      {/* Siatka */}
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: `linear-gradient(var(--border-soft) 1px, transparent 1px), linear-gradient(90deg, var(--border-soft) 1px, transparent 1px)`,
        backgroundSize: "40px 40px",
        opacity: 0.35,
        maskImage: "radial-gradient(circle at center, black, transparent 70%)",
        WebkitMaskImage: "radial-gradient(circle at center, black, transparent 70%)",
        pointerEvents: "none",
      }}/>

      <div style={{
        position: "relative", zIndex: 1,
        width: "100%", maxWidth: 420,
        display: "flex", flexDirection: "column", gap: 18,
      }} className="fade-in">

        {/* Brand */}
        <div style={{ textAlign: "center" }}>
          <div style={{ margin: "0 auto 16px", display: "flex", justifyContent: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/assets/logo-white.png" alt="i-coucou" className="brand-logo brand-logo-dark" style={{ height: 44, width: "auto" }}/>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/assets/logo-black.png" alt="i-coucou" className="brand-logo brand-logo-light" style={{ height: 44, width: "auto", display: "none" }}/>
          </div>
          <h1 style={{
            margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "0.12em",
            color: "var(--text-mid)",
          }}>
            MAGAZYN
          </h1>
          <p style={{
            margin: "4px 0 0", fontSize: 12,
            color: "var(--text-lo)", letterSpacing: "0.04em",
          }}>System zarządzania magazynem · v5.2</p>
        </div>

        {/* Karta logowania */}
        <div style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}>
          <div style={{
            padding: "14px 22px",
            borderBottom: "1px solid var(--border-soft)",
            background: "var(--surface-1)",
          }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text-hi)" }}>Logowanie</h2>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-lo)" }}>Zaloguj się żeby uzyskać dostęp</p>
          </div>

          <form onSubmit={handleSubmit} style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
            {error && (
              <div style={{
                padding: "10px 12px",
                background: "var(--critical-soft)",
                border: "1px solid color-mix(in oklch, var(--critical) 40%, var(--border))",
                borderRadius: 8,
                display: "flex", alignItems: "flex-start", gap: 8,
              }}>
                <span style={{ color: "var(--critical)", flexShrink: 0, marginTop: 1 }}><I.Alert size={14}/></span>
                <span style={{ fontSize: 12, color: "var(--text-hi)", lineHeight: 1.5 }}>{error}</span>
              </div>
            )}
            <div>
              <label style={loginLabelStyle}>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="twoj@email.com" autoFocus autoComplete="email"
                style={loginInputStyle}/>
            </div>
            <div>
              <label style={loginLabelStyle}>Hasło</label>
              <div style={{ position: "relative" }}>
                <input type={showPassword ? "text" : "password"}
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••" autoComplete="current-password"
                  style={{ ...loginInputStyle, paddingRight: 56 }}/>
                <button type="button" onClick={() => setShowPassword(!showPassword)} style={{
                  position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                  padding: "6px 10px", fontSize: 10, fontWeight: 600,
                  background: "transparent", border: "none",
                  color: "var(--text-lo)", letterSpacing: "0.04em", textTransform: "uppercase",
                  cursor: "pointer",
                }}>{showPassword ? "Ukryj" : "Pokaż"}</button>
              </div>
            </div>
            <button type="submit" disabled={loading} style={{
              padding: "11px 16px",
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "1px solid var(--accent)",
              borderRadius: 8,
              fontSize: 13, fontWeight: 600,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.7 : 1,
              transition: "all 0.12s",
            }}>
              {loading ? (
                <><span className="pulse-soft"><I.Refresh size={13}/></span> Logowanie...</>
              ) : (
                <>Zaloguj się <I.ArrowRight size={13}/></>
              )}
            </button>
            <div style={{ textAlign: "center", fontSize: 11, color: "var(--text-lo)" }}>
              Nie pamiętasz hasła? Poproś administratora o reset.
            </div>
          </form>
        </div>

        <div style={{ textAlign: "center", fontSize: 10, color: "var(--text-disabled)", letterSpacing: "0.04em" }}>
          Dostęp tylko dla uprawnionych użytkowników
        </div>
      </div>
    </div>
  );
}

const loginInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  fontSize: 13,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-hi)",
  outline: "none",
  fontFamily: "inherit",
  transition: "border-color 0.12s",
};

const loginLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10, fontWeight: 600, color: "var(--text-lo)",
  textTransform: "uppercase", letterSpacing: "0.06em",
  marginBottom: 5,
};
