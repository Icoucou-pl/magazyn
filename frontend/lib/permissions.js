"use client";

// ============================================================
// Model uprawnień — port 1:1 z app.jsx (mock).
// Zamiast Object.assign(window, ...) eksportujemy jako moduł ES.
// Granularne uprawnienia: override per użytkownik (perms) wygrywa
// nad domyślnym zestawem roli (ROLE_PERMS).
// ============================================================

import { createContext, useContext } from "react";

// Katalog granularnych uprawnień (key → etykieta/opis/grupa)
export const PERMISSIONS = [
  { key: "editProducts",   label: "Edycja produktów",      desc: "Zmiana atrybutów, lead-time, klasyfikacji", group: "Dane" },
  { key: "editContainers", label: "Edycja kontenerów",     desc: "Tworzenie i edycja kontenerów",             group: "Dane" },
  { key: "import",         label: "Import danych",         desc: "Wgrywanie plików CSV/XLSX",                 group: "Dane" },
  { key: "export",         label: "Eksport danych",        desc: "Pobieranie list do CSV",                    group: "Dane" },
  { key: "generatePO",     label: "Generowanie zamówień",  desc: "Tworzenie PO / auto-sugestia",              group: "Zamówienia" },
  { key: "viewFinancials", label: "Dane finansowe (PLN)",  desc: "Widzi wartości, ceny, cashflow",            group: "Widoczność" },
  { key: "assistantFinancials", label: "Dane finansowe – asystent", desc: "Może pytać asystenta o finanse (niezależnie od PLN w UI)", group: "Widoczność" },
  { key: "viewForecast",   label: "Prognoza",              desc: "Dostęp do macierzy prognozy",               group: "Widoczność" },
  { key: "manageUsers",    label: "Zarządzanie userami",   desc: "Dodawanie, role, uprawnienia",              group: "Administracja" },
  { key: "viewAudit",      label: "Dziennik audytu",       desc: "Podgląd historii zdarzeń",                  group: "Administracja" },
];

// Domyślne uprawnienia per rola — nadpisywalne per użytkownik
export const ROLE_PERMS = {
  ADMIN:  { editProducts: true,  editContainers: true,  import: true,  export: true,  generatePO: true,  viewFinancials: true,  assistantFinancials: true,  viewForecast: true,  manageUsers: true,  viewAudit: true },
  IMPORT: { editProducts: true,  editContainers: true,  import: true,  export: true,  generatePO: true,  viewFinancials: true,  assistantFinancials: false, viewForecast: true,  manageUsers: false, viewAudit: false },
  VIEWER: { editProducts: false, editContainers: false, import: false, export: true,  generatePO: false, viewFinancials: true,  assistantFinancials: false, viewForecast: true,  manageUsers: false, viewAudit: false },
};

// Kontekst użytkownika (provider zakładamy w page.js / shell — etap 0.4)
export const UserContext = createContext(null);
export const useUser = () => useContext(UserContext);

// can(user, permKey): override per-user wygrywa, inaczej domyślne z roli
export const can = (u, key) => {
  if (!u) return false;
  if (u.perms && Object.prototype.hasOwnProperty.call(u.perms, key)) return !!u.perms[key];
  return !!(ROLE_PERMS[u.role] || {})[key];
};

// canEdit: jakakolwiek możliwość zapisu (produkty LUB kontenery)
export const canEdit = (u) => can(u, "editProducts") || can(u, "editContainers");
export const isAdmin = (u) => can(u, "manageUsers");

// Efektywna mapa uprawnień użytkownika (domyślne z roli + override)
export const effectivePerms = (u) => {
  const base = { ...(ROLE_PERMS[u?.role] || {}) };
  if (u?.perms) Object.assign(base, u.perms);
  return base;
};
