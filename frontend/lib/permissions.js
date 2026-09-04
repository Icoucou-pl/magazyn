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
  { key: "viewDashboardKpi", label: "KPI Dashboard",       desc: "Widoczność kart KPI na pulpicie",           group: "Widoczność" },
  { key: "assistantFinancials", label: "Dane finansowe – asystent", desc: "Może pytać asystenta o finanse (niezależnie od PLN w UI)", group: "Widoczność" },
  { key: "viewForecast",   label: "Prognoza",              desc: "Dostęp do macierzy prognozy",               group: "Widoczność" },
  { key: "manageUsers",    label: "Zarządzanie userami",   desc: "Dodawanie, role, uprawnienia",              group: "Administracja" },
  { key: "viewAudit",      label: "Dziennik audytu",       desc: "Podgląd historii zdarzeń",                  group: "Administracja" },
  { key: "viewReports",    label: "Raporty",               desc: "Dostęp do raportów miesięcznych (KPI, PDF/Excel)", group: "Widoczność" },
  { key: "viewOccupancy",  label: "Zajętość magazynu",     desc: "Raport kubatury (m³) i kafelek zajętości na pulpicie", group: "Widoczność" },
  { key: "viewAttachments", label: "Załączniki kontenerów", desc: "Podgląd i pobieranie plików (faktury, proformy, packing list, BL)", group: "Widoczność" },
  { key: "viewCalendarPayments", label: "Płatności w kalendarzu", desc: "Terminy płatności „Do zapłaty” jako zdarzenia kalendarza (wymaga też Dane finansowe)", group: "Widoczność" },
  { key: "viewBankBalances", label: "Stan konta firmy", desc: "Saldo rachunku i pożyczki wspólników — wykres na pulpicie i zakładka w Cashflow (wymaga też Dane finansowe)", group: "Widoczność" },
  { key: "editBankBalances", label: "Wpisywanie stanu konta", desc: "Dodawanie i poprawianie odczytów salda oraz pożyczek wspólników", group: "Dane" },
];

// Domyślne uprawnienia per rola — nadpisywalne per użytkownik
//
// UWAGA — klucze CELOWO nieobecne poniżej (can() zwróci dla nich false dla KAŻDEJ roli,
// łącznie z ADMIN; dostęp daje wyłącznie ptaszek postawiony konkretnemu userowi):
//   · viewOccupancy — Zajętość magazynu.
// Lustro tej samej reguły po stronie backendu siedzi w security.py → ROLE_PERMS.
//
// viewBankBalances / editBankBalances — saldo rachunku i pożyczki wspólników. Domyślnie TYLKO ADMIN.
// Sprawdzaj przez canSeeBank() / canEditBank() — oba są koniunkcyjne z viewFinancials.
//
// viewCalendarPayments — płatności „Do zapłaty" w kalendarzu. Domyślnie TYLKO ADMIN;
// IMPORT/VIEWER dostają je wyłącznie ręcznym ptaszkiem. Sprawdzaj przez canSeeCalendarPayments(),
// nie przez samo can() — uprawnienie jest koniunkcyjne z viewFinancials.
export const ROLE_PERMS = {
  ADMIN:  { editProducts: true,  editContainers: true,  import: true,  export: true,  generatePO: true,  viewFinancials: true,  viewDashboardKpi: true,  assistantFinancials: true,  viewForecast: true,  manageUsers: true,  viewAudit: true,  viewReports: true,  viewAttachments: true,  viewCalendarPayments: true,  viewBankBalances: true,  editBankBalances: true },
  IMPORT: { editProducts: true,  editContainers: true,  import: true,  export: true,  generatePO: true,  viewFinancials: true,  viewDashboardKpi: true,  assistantFinancials: false, viewForecast: true,  manageUsers: false, viewAudit: false, viewReports: false, viewAttachments: true,  viewCalendarPayments: false, viewBankBalances: false, editBankBalances: false },
  VIEWER: { editProducts: false, editContainers: false, import: false, export: true,  generatePO: false, viewFinancials: true,  viewDashboardKpi: false, assistantFinancials: false, viewForecast: true,  manageUsers: false, viewAudit: false, viewReports: false, viewAttachments: false, viewCalendarPayments: false, viewBankBalances: false, editBankBalances: false },
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

// Płatności w kalendarzu — koniunkcja z viewFinancials (chip niesie kwotę zobowiązania).
// Backend pilnuje tego samego w security.py → can_see_calendar_payments; front tylko nie rysuje
// tego, czego i tak nie dostanie z API.
export const canSeeCalendarPayments = (u) => can(u, "viewCalendarPayments") && can(u, "viewFinancials");

// Pieniądze firmy — wykres i wpisy niosą kwoty, więc oba prawa są koniunkcyjne
// z viewFinancials. Lustro w security.py → can_view_bank / can_edit_bank.
export const canSeeBank = (u) => can(u, "viewBankBalances") && can(u, "viewFinancials");
export const canEditBank = (u) => canSeeBank(u) && can(u, "editBankBalances");

// Efektywna mapa uprawnień użytkownika (domyślne z roli + override)
export const effectivePerms = (u) => {
  const base = { ...(ROLE_PERMS[u?.role] || {}) };
  if (u?.perms) Object.assign(base, u.perms);
  return base;
};
