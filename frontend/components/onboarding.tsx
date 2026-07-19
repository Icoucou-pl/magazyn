"use client";
// ============================================================
// MAGAZYN — Onboarding (components/onboarding.tsx)
//   Pełnoekranowa nakładka pokazywana raz na użytkownika po zalogowaniu.
//   7 slajdów: Powitanie → Trzy sklepy → Funkcje → Prognoza → Asystent AI → Role → Gotowe.
//   Wierny port mocka onboarding.html. Tokeny z globals.css, motyw dziedziczy z <html>
//   (props theme/onToggleTheme z page.tsx → useTweaks). Gating: magazyn_onboarded_<email>.
//   Style scope'owane prefiksem .onb- żeby nie kolidować z globalnymi regułami.
// ============================================================

import React, { useEffect, useState } from "react";

const TOTAL = 6;

// ── Dane demo heatmapy (deterministyczne, tak jak w mocku) ──
const HEAT_MONTHS = ["Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];
const HEAT_SKUS = ["A2cz", "D2cz", "MSTcz", "ASTcz"];
const HEAT_PATTERN = [
  [2, 2, 3, 3, 4, 1, 0, 0],
  [3, 2, 2, 3, 1, 1, 0, 0],
  [4, 3, 2, 2, 2, 1, 1, 0],
  [2, 3, 3, 4, 3, 2, 1, 1],
];
const HEAT_VALS = [
  [462, 334, 518, 601, 585, 220, 0, 0],
  [193, 328, 191, 165, 78, 42, 0, 0],
  [298, 271, 205, 160, 144, 89, 71, 0],
  [120, 174, 279, 304, 213, 128, 84, 29],
];
const HEAT_BG = ["var(--critical)", "var(--warning)", "var(--ok)", "oklch(0.86 0.17 100)", "oklch(0.78 0.12 220)"];
const HEAT_FG = ["white", "oklch(0.2 0.05 55)", "white", "oklch(0.3 0.06 100)", "oklch(0.22 0.05 220)"];

const STYLE = `
.onb-overlay {
  position: fixed; inset: 0; z-index: 2000;
  display: flex; align-items: center; justify-content: center; padding: 24px;
  background: var(--bg); color: var(--text-hi);
  font-family: var(--font-sans, 'Geist', ui-sans-serif, system-ui, sans-serif);
  overflow: hidden;
}
.onb-overlay::before {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background-image:
    radial-gradient(circle at 15% 15%, oklch(0.82 0.16 75 / 0.10), transparent 45%),
    radial-gradient(circle at 85% 85%, oklch(0.70 0.165 305 / 0.10), transparent 45%);
}
.onb-gridbg {
  position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background-image: linear-gradient(var(--border-soft) 1px, transparent 1px), linear-gradient(90deg, var(--border-soft) 1px, transparent 1px);
  background-size: 44px 44px; opacity: 0.3;
  -webkit-mask-image: radial-gradient(circle at center, black, transparent 75%);
  mask-image: radial-gradient(circle at center, black, transparent 75%);
}
.onb-stage {
  position: relative; z-index: 1; width: 100%; max-width: 720px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 20px;
  box-shadow: 0 30px 90px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03);
  overflow: hidden; display: flex; flex-direction: column; min-height: 580px; max-height: calc(100dvh - 48px);
}
.onb-progress { height: 3px; background: var(--surface-2); flex-shrink: 0; }
.onb-progress-fill { height: 100%; background: var(--accent); transition: width 0.4s cubic-bezier(0.4,0,0.2,1); border-radius: 0 3px 3px 0; }
.onb-topbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; flex-shrink: 0; }
.onb-brand { display: flex; align-items: center; gap: 12px; }
.onb-brand img { height: 32px; width: auto; display: block; }
.onb-brand-sep { width: 1px; height: 24px; background: var(--border); }
.onb-brand-name { font-weight: 700; font-size: 14px; letter-spacing: 0.12em; color: var(--text-mid); }
.onb-top-right { display: flex; align-items: center; gap: 14px; }
.onb-step-count { font-size: 11px; color: var(--text-lo); font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace); }
.onb-theme-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: var(--surface-1); border: 1px solid var(--border-soft); color: var(--text-mid); cursor: pointer; transition: all 0.15s; }
.onb-theme-btn:hover { background: var(--surface-2); color: var(--text-hi); }
.onb-skip { background: transparent; border: none; color: var(--text-lo); font-size: 12px; cursor: pointer; font-family: inherit; transition: color 0.15s; }
.onb-skip:hover { color: var(--text-mid); }

.onb-slides { flex: 1; position: relative; overflow: hidden; }
.onb-slide { position: absolute; inset: 0; padding: 20px 44px 24px; display: flex; flex-direction: column; opacity: 0; transform: translateX(30px); pointer-events: none; transition: opacity 0.4s ease, transform 0.4s ease; overflow-y: auto; }
.onb-slide.active { opacity: 1; transform: translateX(0); pointer-events: auto; }
.onb-slide.past { transform: translateX(-30px); }

.onb-badge { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 16px; }
.onb-slide h1 { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
.onb-dot { color: var(--accent); }
.onb-lead { font-size: 15px; color: var(--text-mid); margin-top: 12px; max-width: 82%; }
.onb-hero { width: 72px; height: 72px; border-radius: 18px; margin-bottom: 20px; display: flex; align-items: center; justify-content: center; align-self: flex-start; }

.onb-feat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 20px; }
.onb-feat { display: flex; gap: 12px; padding: 13px; background: var(--surface-1); border: 1px solid var(--border-soft); border-radius: 12px; transition: border-color 0.15s, transform 0.15s; }
.onb-feat:hover { border-color: var(--border); transform: translateY(-2px); }
.onb-feat-ico { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.onb-feat-t { font-size: 13px; font-weight: 600; }
.onb-feat-d { font-size: 11px; color: var(--text-lo); margin-top: 2px; line-height: 1.4; }

.onb-shops { display: flex; flex-direction: column; gap: 10px; margin-top: 22px; }
.onb-shop { display: flex; align-items: center; gap: 14px; padding: 14px 16px; background: var(--surface-1); border: 1px solid var(--border-soft); border-radius: 12px; transition: border-color 0.15s, transform 0.15s; }
.onb-shop:hover { border-color: var(--border); transform: translateX(2px); }
.onb-shop-badge { width: 44px; height: 44px; border-radius: 11px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-family: var(--font-mono, monospace); font-weight: 700; font-size: 12px; }
.onb-shop-name { font-size: 14px; font-weight: 600; }
.onb-shop-desc { font-size: 11px; color: var(--text-lo); margin-top: 2px; line-height: 1.4; }
.onb-shop-src { margin-left: auto; padding: 4px 10px; border-radius: 99px; font-size: 10px; font-weight: 600; letter-spacing: 0.03em; font-family: var(--font-mono, monospace); white-space: nowrap; flex-shrink: 0; }
.onb-shop-note { display: flex; align-items: center; gap: 10px; margin-top: 16px; padding: 12px 14px; background: var(--accent-soft); border: 1px solid color-mix(in oklch, var(--accent) 25%, transparent); border-radius: 10px; font-size: 12.5px; color: var(--text-mid); }
.onb-shop-note b { color: var(--text-hi); }

.onb-chat { margin-top: 20px; background: var(--surface-1); border: 1px solid var(--border-soft); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.onb-brow { display: flex; gap: 10px; align-items: flex-start; }
.onb-brow.user { flex-direction: row-reverse; }
.onb-avatar { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; }
.onb-bubble { max-width: 78%; padding: 10px 13px; border-radius: 12px; font-size: 13px; line-height: 1.5; }
.onb-bubble.ai { background: var(--surface-2); color: var(--text-hi); border-top-left-radius: 4px; }
.onb-bubble.user { background: var(--accent); color: var(--accent-ink); border-top-right-radius: 4px; font-weight: 500; }
.onb-bline { display: flex; justify-content: space-between; gap: 12px; font-family: var(--font-mono, monospace); font-size: 12px; padding: 3px 0; }
.onb-bline + .onb-bline { border-top: 1px solid var(--border-soft); }
.onb-bsku { color: var(--text-mid); }
.onb-bwarn { color: var(--critical); font-weight: 600; }
.onb-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.onb-chip { padding: 7px 12px; border-radius: 99px; font-size: 12px; background: var(--surface-1); border: 1px solid var(--border-soft); color: var(--text-mid); transition: all 0.15s; }
.onb-chip:hover { border-color: var(--accent); color: var(--text-hi); }
.onb-ai-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; font-size: 11.5px; color: var(--text-lo); }
.onb-dotsep { width: 3px; height: 3px; border-radius: 99px; background: var(--text-lo); }

.onb-demo-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
.onb-demo-leg { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-mid); }
.onb-demo-sw { width: 16px; height: 16px; border-radius: 4px; }
.onb-demo-mini { display: grid; grid-template-columns: 64px repeat(8, 1fr); gap: 2px; margin-top: 18px; font-size: 10px; }
.onb-demo-mini .lbl { display: flex; align-items: center; font-family: var(--font-mono, monospace); color: var(--text-mid); padding-left: 2px; }
.onb-demo-mini .hd { text-align: center; color: var(--text-lo); font-weight: 600; }
.onb-demo-mini .cell { aspect-ratio: 1.6; border-radius: 3px; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 9px; }

.onb-checklist { display: flex; flex-direction: column; gap: 10px; margin-top: 22px; }
.onb-check-item { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--text-mid); }
.onb-check-item b { color: var(--text-hi); }
.onb-check-ico { width: 22px; height: 22px; border-radius: 99px; background: var(--ok-soft); color: var(--ok); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.onb-kbd { background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; font-size: 11px; font-family: var(--font-mono, monospace); }

.onb-footer { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-top: 1px solid var(--border-soft); flex-shrink: 0; background: var(--surface-1); }
.onb-dots { display: flex; gap: 7px; }
.onb-dot-nav { width: 7px; height: 7px; border-radius: 99px; background: var(--surface-3); cursor: pointer; transition: all 0.2s; border: none; padding: 0; }
.onb-dot-nav.active { background: var(--accent); width: 22px; }
.onb-nav-btns { display: flex; gap: 8px; }
.onb-btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; border: 1px solid transparent; transition: all 0.15s; }
.onb-btn-ghost { background: transparent; border-color: var(--border); color: var(--text-mid); }
.onb-btn-ghost:hover { background: var(--surface-2); color: var(--text-hi); }
.onb-btn-ghost:disabled { opacity: 0.35; cursor: not-allowed; }
.onb-btn-primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.onb-btn-primary:hover { filter: brightness(1.06); }

@keyframes onb-pop { from { opacity: 0; transform: scale(0.9) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
.onb-pop { animation: onb-pop 0.5s cubic-bezier(0.34,1.56,0.64,1) both; }

@media (max-width: 560px) {
  .onb-overlay { padding: 0; }
  .onb-stage { max-width: 100%; min-height: 0; height: 100dvh; max-height: 100dvh; border-radius: 0; border: none; box-shadow: none; }
  .onb-topbar { padding: 12px 16px; }
  .onb-footer { padding: 14px 16px; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .onb-slide { padding: 16px 20px 20px; }
  .onb-slide h1 { font-size: 24px; }
  .onb-lead { max-width: 100%; }
  .onb-feat-grid { grid-template-columns: 1fr; }
  .onb-step-count { display: none; }
  .onb-shop-src { display: none; }
  .onb-skip { font-size: 12px; }
}
`;

// ── Ikonki (inline, samowystarczalne) ──
const Ico = {
  cube: (s = 36) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" /></svg>
  ),
  check: (s = 12, w = "3.5") => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
  ),
  plus: (s = 11) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
  ),
  dashboard: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></svg>),
  activity: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>),
  ship: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13h18l-1.5-7h-15z" /><path d="M8 16v-3M16 16v-3" /></svg>),
  trend: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></svg>),
  wallet: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4z" /></svg>),
  calendar: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>),
  bot: (s = 18) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" /></svg>),
  box: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>),
  search: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent)" }}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>),
  rocket: () => (<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>),
  arrow: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>),
  done: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>),
  moon: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>),
  sun: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>),
};

type OnboardingProps = {
  onDone: () => void;
  theme?: string;
  onToggleTheme?: () => void;
};

export default function Onboarding({ onDone, theme, onToggleTheme }: OnboardingProps) {
  const [cur, setCur] = useState(0);

  // Persystencja „obejrzane" idzie do bazy (page.tsx → PATCH /auth/me/onboarding).
  const finish = () => onDone();

  const advance = (dir: number) => {
    const n = cur + dir;
    if (n < 0) return;
    if (n >= TOTAL) { finish(); return; }
    setCur(n);
  };

  // Nawigacja klawiaturą (strzałki / Enter). Ignorujemy skróty z modyfikatorami (np. Ctrl+K).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); advance(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); advance(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  const cls = (i: number) => "onb-slide" + (i === cur ? " active" : i < cur ? " past" : "");
  const logo = theme === "light" ? "/assets/logo-black.png" : "/assets/logo-white.png";
  const isLast = cur === TOTAL - 1;

  return (
    <div className="onb-overlay" role="dialog" aria-modal="true" aria-label="Wprowadzenie">
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      <div className="onb-gridbg" />

      <div className="onb-stage">
        <div className="onb-progress"><div className="onb-progress-fill" style={{ width: `${((cur + 1) / TOTAL) * 100}%` }} /></div>

        <div className="onb-topbar">
          <div className="onb-brand">
            <img src={logo} alt="i-coucou" />
            <div className="onb-brand-sep" />
            <div className="onb-brand-name">MAGAZYN</div>
          </div>
          <div className="onb-top-right">
            <span className="onb-step-count">{cur + 1} / {TOTAL}</span>
            {onToggleTheme && (
              <button className="onb-theme-btn" onClick={onToggleTheme} title="Zmień motyw" aria-label="Zmień motyw">
                {theme === "light" ? Ico.sun() : Ico.moon()}
              </button>
            )}
            <button className="onb-skip" onClick={finish}>Pomiń wprowadzenie</button>
          </div>
        </div>

        <div className="onb-slides">

          {/* 1 — Powitanie */}
          <section className={cls(0)}>
            <div className="onb-hero onb-pop" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{Ico.cube()}</div>
            <span className="onb-badge" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>Witaj na pokładzie</span>
            <h1>Twój magazyn,<br />pod kontrolą<span className="onb-dot">.</span></h1>
            <p className="onb-lead">W kilka sekund pokażemy Ci jak planować dostawy, unikać braków i zamawiać kontenery — dla trzech sklepów z jednego miejsca. Zajmie to mniej niż minutę.</p>
            <div className="onb-checklist">
              <div className="onb-check-item"><span className="onb-check-ico">{Ico.check()}</span> Prognoza zapasów na 18 miesięcy w przód</div>
              <div className="onb-check-item"><span className="onb-check-ico">{Ico.check()}</span> Automatyczne sugestie składu kontenera</div>
              <div className="onb-check-item"><span className="onb-check-ico">{Ico.check()}</span> Asystent AI, który odpowiada po polsku</div>
            </div>
          </section>

          {/* 2 — Trzy sklepy */}
          <section className={cls(1)}>
            <span className="onb-badge" style={{ background: "var(--info-soft)", color: "var(--info)" }}>Jak to działa</span>
            <h1>Trzy sklepy, jeden magazyn</h1>
            <p className="onb-lead">Wszystkie marki w jednym panelu. Przełącznik u góry filtruje dane dla wybranego sklepu albo pokazuje całość.</p>
            <div className="onb-shops">
              <div className="onb-shop">
                <div className="onb-shop-badge" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>AMH</div>
                <div><div className="onb-shop-name">i-coucou</div><div className="onb-shop-desc">Główny sklep — stany magazynowe z Subiekt GT</div></div>
                <span className="onb-shop-src" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>SUBIEKT GT</span>
              </div>
              <div className="onb-shop">
                <div className="onb-shop-badge" style={{ background: "var(--info-soft)", color: "var(--info)" }}>ACT</div>
                <div><div className="onb-shop-name">Acti</div><div className="onb-shop-desc">Sklep siostrzany — stany zewnętrzne z Sellasist</div></div>
                <span className="onb-shop-src" style={{ background: "var(--info-soft)", color: "var(--info)" }}>SELLASIST</span>
              </div>
              <div className="onb-shop">
                <div className="onb-shop-badge" style={{ background: "var(--anomaly-soft)", color: "var(--anomaly)" }}>VLX</div>
                <div><div className="onb-shop-name">Veluxa</div><div className="onb-shop-desc">Sklep siostrzany — stany zewnętrzne z Sellasist</div></div>
                <span className="onb-shop-src" style={{ background: "var(--anomaly-soft)", color: "var(--anomaly)" }}>SELLASIST</span>
              </div>
            </div>
            <div className="onb-shop-note">
              {Ico.search()}
              <div>Filtr <b>Wszystkie / AMH / Acti / Veluxa</b> działa na Produktach i Dashboardzie. Sprzedaż spływa z Shoper, Shopify i Allegro.</div>
            </div>
          </section>

          {/* 3 — Funkcje */}
          <section className={cls(2)}>
            <span className="onb-badge" style={{ background: "var(--info-soft)", color: "var(--info)" }}>Co potrafi aplikacja</span>
            <h1>Wszystko w zasięgu ręki</h1>
            <p className="onb-lead">Każdy widok rozwiązuje jeden konkretny problem magazynowy.</p>
            <div className="onb-feat-grid">
              {([
                ["accent", Ico.dashboard(), "Dashboard", "KPI, pożary, anomalie, lista zakupów"],
                ["anomaly", Ico.activity(), "Prognoza", "Heatmapa zapasów per producent"],
                ["info", Ico.ship(), "Kontenery", "CBM, statusy, auto-sugestia, tracking"],
                ["ok", Ico.trend(), "Finanse", "Przychód, marża, rotacja, karta produktu"],
                ["info", Ico.wallet(), "Cashflow", "Prognoza wydatków na kontenery"],
                ["accent", Ico.calendar(), "Kalendarz", "Terminy dostaw i płatności"],
                ["anomaly", Ico.bot(), "Asystent AI", "Pytania po polsku, 32 narzędzia"],
                ["ok", Ico.box(), "Produkty", "Tabela, filtry, akcje zbiorcze, import"],
              ] as const).map(([tone, icon, title, desc], i) => (
                <div className="onb-feat" key={i}>
                  <div className="onb-feat-ico" style={{ background: `var(--${tone}-soft)`, color: `var(--${tone})` }}>{icon}</div>
                  <div><div className="onb-feat-t">{title}</div><div className="onb-feat-d">{desc}</div></div>
                </div>
              ))}
            </div>
          </section>

          {/* 4 — Prognoza (heatmapa) */}
          <section className={cls(3)}>
            <span className="onb-badge" style={{ background: "var(--anomaly-soft)", color: "var(--anomaly)" }}>Najważniejsza funkcja</span>
            <h1>Na pierwszy rzut oka</h1>
            <p className="onb-lead">Macierz prognozy koloruje każdy miesiąc według stanu zapasu. Od razu widzisz czego zabraknie, a czego masz za dużo.</p>
            <div className="onb-demo-mini">
              <div className="lbl" style={{ fontSize: 9 }}>SKU</div>
              {HEAT_MONTHS.map((m) => <div className="hd" key={m}>{m}</div>)}
              {HEAT_SKUS.map((sku, ri) => (
                <React.Fragment key={sku}>
                  <div className="lbl">{sku}</div>
                  {HEAT_PATTERN[ri].map((bk, ci) => (
                    <div className="cell" key={ci} style={{ background: HEAT_BG[bk], color: HEAT_FG[bk] }}>{HEAT_VALS[ri][ci]}</div>
                  ))}
                </React.Fragment>
              ))}
            </div>
            <div className="onb-demo-legend">
              <span className="onb-demo-leg"><span className="onb-demo-sw" style={{ background: "var(--critical)" }} /> Braki</span>
              <span className="onb-demo-leg"><span className="onb-demo-sw" style={{ background: "var(--warning)" }} /> Zamawiamy</span>
              <span className="onb-demo-leg"><span className="onb-demo-sw" style={{ background: "var(--ok)" }} /> Idealnie</span>
              <span className="onb-demo-leg"><span className="onb-demo-sw" style={{ background: "oklch(0.86 0.17 100)" }} /> Za dużo</span>
              <span className="onb-demo-leg"><span className="onb-demo-sw" style={{ background: "oklch(0.78 0.12 220)" }} /> Wyprzedaż</span>
            </div>
          </section>

          {/* 5 — Asystent AI */}
          <section className={cls(4)}>
            <span className="onb-badge" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>Nowość</span>
            <h1>Zapytaj po polsku<span className="onb-dot">.</span></h1>
            <p className="onb-lead">Zamiast klikać po filtrach — po prostu zapytaj. Asystent sięga po realne dane: stany, prognozy, kontenery i finanse.</p>
            <div className="onb-chat">
              <div className="onb-brow user"><div className="onb-bubble user">Czego zabraknie w ciągu 3 miesięcy?</div></div>
              <div className="onb-brow">
                <div className="onb-avatar">{Ico.bot(15)}</div>
                <div className="onb-bubble ai">
                  Cztery pozycje wpadną w braki do września:
                  <div className="onb-bline"><span className="onb-bsku">D2cz</span><span className="onb-bwarn">brak za 6 tyg.</span></div>
                  <div className="onb-bline"><span className="onb-bsku">MSTcz</span><span className="onb-bwarn">brak za 9 tyg.</span></div>
                  <div className="onb-bline"><span className="onb-bsku">A2cz</span><span className="onb-bwarn">brak za 11 tyg.</span></div>
                </div>
              </div>
            </div>
            <div className="onb-chips">
              <span className="onb-chip">Co dostawić w następnym kontenerze?</span>
              <span className="onb-chip">Które produkty to martwy zapas?</span>
              <span className="onb-chip">Marża na krzesłach ASTcz?</span>
            </div>
            <div className="onb-ai-meta">
              <span>32 narzędzia</span><span className="onb-dotsep" />
              <span>realne dane z magazynu</span><span className="onb-dotsep" />
              <span>koszt każdego zapytania widoczny w panelu</span>
            </div>
          </section>

          {/* 6 — Gotowe */}
          <section className={cls(5)}>
            <div className="onb-hero onb-pop" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>{Ico.rocket()}</div>
            <span className="onb-badge" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>Gotowe</span>
            <h1>Możemy zaczynać<span className="onb-dot">.</span></h1>
            <p className="onb-lead">Wszystko skonfigurowane. Pierwsze co warto zrobić:</p>
            <div className="onb-checklist">
              <div className="onb-check-item"><span className="onb-check-ico" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{Ico.plus()}</span> Sprawdź zakładkę <b>Prognoza</b> dla swojego głównego producenta</div>
              <div className="onb-check-item"><span className="onb-check-ico" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{Ico.plus()}</span> Zapytaj <b>Asystenta AI</b> co dostawić w następnym kontenerze</div>
              <div className="onb-check-item"><span className="onb-check-ico" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{Ico.plus()}</span> Naciśnij <kbd className="onb-kbd">Ctrl+K</kbd> aby szukać wszędzie</div>
            </div>
          </section>

        </div>

        <div className="onb-footer">
          <div className="onb-dots">
            {Array.from({ length: TOTAL }).map((_, i) => (
              <button key={i} className={"onb-dot-nav" + (i === cur ? " active" : "")} onClick={() => setCur(i)} aria-label={`Slajd ${i + 1}`} />
            ))}
          </div>
          <div className="onb-nav-btns">
            <button className="onb-btn onb-btn-ghost" onClick={() => advance(-1)} disabled={cur === 0}>Wstecz</button>
            <button className="onb-btn onb-btn-primary" onClick={() => advance(1)}>
              {isLast ? <>Wejdź do aplikacji {Ico.done()}</> : <>Dalej {Ico.arrow()}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
