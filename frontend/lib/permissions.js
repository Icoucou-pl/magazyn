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
  { key: "viewSalesSummary", label: "Podsumowanie sprzedaży", desc: "Karta z liczbą i wartością zamówień per firma na pulpicie (kwoty tylko z Dane finansowe). Superadmin widzi zawsze", group: "Widoczność" },
  { key: "viewOccupancy",  label: "Zajętość magazynu",     desc: "Raport kubatury (m³) i kafelek zajętości na pulpicie", group: "Widoczność" },
  { key: "viewFiles", label: "Pliki – podgląd", desc: "Zakładka „Pliki”: przeglądanie folderów producentów i kontenerów, otwieranie i pobieranie plików, ZIP z zaznaczonych. Przy dostępie do jednej firmy — tylko jej foldery. Domyślnie: Admin", group: "Widoczność" },
  { key: "editFiles", label: "Pliki – edycja", desc: "Wrzucanie plików, zakładanie folderów, zmiana nazw, przenoszenie, kosz i przywracanie (wymaga też Pliki – podgląd). „Usuń na zawsze” zostaje dla superadmina", group: "Dane" },
  { key: "viewAttachments", label: "Załączniki kontenerów", desc: "Podgląd i pobieranie plików (faktury, proformy, packing list, BL)", group: "Widoczność" },
  { key: "viewCalendarPayments", label: "Płatności w kalendarzu", desc: "Terminy płatności „Do zapłaty” jako zdarzenia kalendarza (wymaga też Dane finansowe)", group: "Widoczność" },
  { key: "viewBankBalances", label: "Stan konta firmy", desc: "Saldo rachunku i pożyczki wspólników — wykres na pulpicie i zakładka w Cashflow (wymaga też Dane finansowe)", group: "Widoczność" },
  { key: "editBankBalances", label: "Wpisywanie stanu konta", desc: "Dodawanie i poprawianie odczytów salda oraz pożyczek wspólników", group: "Dane" },
  { key: "viewProductHistory", label: "Historia produktu", desc: "Zakładka „Historia produktu” na karcie produktu: przyjęcia, koszt zakupu w czasie, narzut logistyczny", group: "Widoczność" },
  { key: "viewPurchasePrice", label: "Cena zakupu produktu", desc: "Koszt netto za sztukę na karcie produktu (średnia z kontenerów + cena z Fakturowni/Subiektu) — bez dostępu do pozostałych danych finansowych", group: "Widoczność" },
  { key: "viewProductSales", label: "Sprzedaż na karcie produktu", desc: "Zakładka „Sprzedaż” na karcie produktu: przychód, marża, kanały (wymaga też Dane finansowe)", group: "Widoczność" },
  { key: "viewLandedCost", label: "Koszt jednostkowy kontenera", desc: "Zakładka „Koszt jednostkowy” na karcie kontenera: cło, fracht i koszt sztuki po odprawie (wymaga też Dane finansowe)", group: "Widoczność" },
  { key: "editLandedCost", label: "Liczenie kosztu jednostkowego", desc: "Wczytanie odprawy z XML, wpisywanie kwot z faktury spedytora i zapis kosztu na pozycje kontenera", group: "Dane" },
  { key: "viewProductPrice", label: "Wycena (test-wycena)", desc: "Zakładka „test-wycena” na karcie produktu: kalkulator z szablonami, koszt FIFO i średni z kontenerów, dostawy (wymaga też Dane finansowe)", group: "Widoczność" },
  { key: "editProductPrice", label: "Zapis w wycenie", desc: "Zapisywanie w „test-wycena” cen minimalnych i sugerowanych, cen konkurencji i szablonów kalkulatora", group: "Dane" },
  { key: "viewPriceSummary", label: "Ceny dla zespołu (Cena)", desc: "Zakładka „Cena” na karcie produktu: ceny minimalne, średnie ceny sprzedaży — bez wyliczeń", group: "Widoczność" },
  { key: "priceSummaryCost", label: "Cena: Koszt zakupu", desc: "Boks „Koszt zakupu” w zakładce „Cena” (wymaga też Cena zakupu produktu)", group: "Widoczność" },
  { key: "priceSummaryCompetition", label: "Cena: Konkurencja", desc: "Boks „Konkurencja” w zakładce „Cena”: ceny innych sklepów", group: "Widoczność" },
  { key: "useSalesCalculator", label: "Kalkulator handlowca", desc: "Kalkulator marży i prowizji w zakładce „Cena” (wymaga też Cena zakupu produktu)", group: "Handlowiec" },
  { key: "prowizjaOdCeny", label: "Prowizja od ceny (sposób A)", desc: "Kalkulator handlowca liczy prowizję jako % ceny netto. Bez ptaszka: % od zysku (sposób B)", group: "Handlowiec" },
];

// Domyślne uprawnienia per rola — nadpisywalne per użytkownik
//
// UWAGA — klucze CELOWO nieobecne poniżej (can() zwróci dla nich false dla KAŻDEJ roli,
// łącznie z ADMIN; dostęp daje wyłącznie ptaszek postawiony konkretnemu userowi):
//   · viewOccupancy — Zajętość magazynu.
//   · viewSalesSummary — Podsumowanie sprzedaży na pulpicie (superadmin widzi zawsze, canSeeSalesSummary).
// Lustro tej samej reguły po stronie backendu siedzi w security.py → ROLE_PERMS.
//
// viewBankBalances / editBankBalances — saldo rachunku i pożyczki wspólników. Domyślnie TYLKO ADMIN.
// Sprawdzaj przez canSeeBank() / canEditBank() — oba są koniunkcyjne z viewFinancials.
//
// viewFiles / editFiles — zakładka „Pliki”. Domyślnie TYLKO ADMIN; superadmin zawsze.
// Sprawdzaj przez canSeeFiles() / canEditFiles() — edycja leży na wierzchu podglądu.
//
// viewProductHistory — zakładka „Historia produktu" na karcie. Domyślnie TYLKO ADMIN
// (wcześniej wyłącznie super-admin — ten dalej widzi ją zawsze, patrz canSeeProductHistory).
//
// viewLandedCost / editLandedCost — rozliczenie odprawy na karcie kontenera. Sprawdzaj przez
// canSeeLandedCost() / canEditLandedCost(): podgląd jest koniunkcyjny z viewFinancials, a edycja
// leży na wierzchu podglądu. Ktoś z samym podglądem widzi wyliczenia, ale nic nie wpisze.
//
// viewPurchasePrice — sama cena zakupu (koszt netto / szt) dla osób BEZ viewFinancials,
// np. obsługa, która musi znać cenę jednostkową, ale nie ma widzieć przychodów i marż.
// Sprawdzaj przez canSeePurchasePrice() — viewFinancials i tak ją obejmuje.
//
// viewProductSales — zakładka „Sprzedaż" na pełnej karcie produktu. Domyślnie TYLKO ADMIN.
// Sprawdzaj przez canSeeProductSales() — koniunkcyjne z viewFinancials, bo zakładka
// pokazuje przychód i marżę, a /finance/product i tak wymaga viewFinancials.
//
// viewCalendarPayments — płatności „Do zapłaty" w kalendarzu. Domyślnie TYLKO ADMIN;
// IMPORT/VIEWER dostają je wyłącznie ręcznym ptaszkiem. Sprawdzaj przez canSeeCalendarPayments(),
// nie przez samo can() — uprawnienie jest koniunkcyjne z viewFinancials.
export const ROLE_PERMS = {
  ADMIN:  { editProducts: true,  editContainers: true,  import: true,  export: true,  generatePO: true,  viewFinancials: true,  viewDashboardKpi: true,  assistantFinancials: true,  viewForecast: true,  manageUsers: true,  viewAudit: true,  viewReports: true,  viewAttachments: true,  viewCalendarPayments: true,  viewBankBalances: true,  editBankBalances: true,  viewProductSales: true,  viewPurchasePrice: true,  viewProductHistory: true,  viewLandedCost: true,  editLandedCost: true,  viewProductPrice: true,  editProductPrice: true,  viewPriceSummary: true,  useSalesCalculator: true,  priceSummaryCost: true,  priceSummaryCompetition: true,  prowizjaOdCeny: false, viewFiles: true, editFiles: true },
  IMPORT: { editProducts: true,  editContainers: true,  import: true,  export: true,  generatePO: true,  viewFinancials: true,  viewDashboardKpi: true,  assistantFinancials: false, viewForecast: true,  manageUsers: false, viewAudit: false, viewReports: false, viewAttachments: true,  viewCalendarPayments: false, viewBankBalances: false, editBankBalances: false, viewProductSales: false, viewPurchasePrice: false, viewProductHistory: false, viewLandedCost: false, editLandedCost: false, viewProductPrice: false, editProductPrice: false, viewPriceSummary: false, useSalesCalculator: false, priceSummaryCost: false, priceSummaryCompetition: false,  prowizjaOdCeny: false, viewFiles: false, editFiles: false },
  VIEWER: { editProducts: false, editContainers: false, import: false, export: true,  generatePO: false, viewFinancials: true,  viewDashboardKpi: false, assistantFinancials: false, viewForecast: true,  manageUsers: false, viewAudit: false, viewReports: false, viewAttachments: false, viewCalendarPayments: false, viewBankBalances: false, editBankBalances: false, viewProductSales: false, viewPurchasePrice: false, viewProductHistory: false, viewLandedCost: false, editLandedCost: false, viewProductPrice: false, editProductPrice: false, viewPriceSummary: false, useSalesCalculator: false, priceSummaryCost: false, priceSummaryCompetition: false,  prowizjaOdCeny: false, viewFiles: false, editFiles: false },
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
export const canSeeProductSales = (u) => can(u, "viewProductSales") && can(u, "viewFinancials");
export const canSeePurchasePrice = (u) => can(u, "viewFinancials") || can(u, "viewPurchasePrice");
export const canSeeProductHistory = (u) =>
  Boolean(u?.is_super_admin || u?.isSuper) || can(u, "viewProductHistory");

// Koszt jednostkowy na karcie kontenera (metoda szefa). Lustro w security.py →
// can_view_landed_cost / can_edit_landed_cost. Bez podglądu zakładki nie ma w pasku w ogóle.
export const canSeeLandedCost = (u) => can(u, "viewLandedCost") && can(u, "viewFinancials");
export const canEditLandedCost = (u) => canSeeLandedCost(u) && can(u, "editLandedCost");
// Podsumowanie sprzedaży na pulpicie — superadmin zawsze, inni tylko z ptaszkiem.
// Lustro w security.py → can_view_sales_summary.
export const canSeeSalesSummary = (u) => Boolean(u?.is_super_admin || u?.isSuper) || can(u, "viewSalesSummary");
// Rozliczenie z SAD (zakładka „SAD", wgrywanie XML) — tylko superadmin, jako kontrola.
// Lustro w security.py → require_sad. Inni nie widzą zakładki ani śladu po niej.
export const canSeeSad = (u) => Boolean(u?.is_super_admin || u?.isSuper);
// Zakładka „Pliki” (foldery producentów/kontenerów, dokumenty) — superadmin zawsze, ADMIN z roli,
// inni z ptaszkiem „Pliki – podgląd”. Lustro w security.py → can_view_files.
export const canSeeFiles = (u) => Boolean(u?.is_super_admin || u?.isSuper) || can(u, "viewFiles");
// Edycja Plików leży na wierzchu podglądu (lustro security.py → can_edit_files).
export const canEditFiles = (u) => Boolean(u?.is_super_admin || u?.isSuper) || (can(u, "viewFiles") && can(u, "editFiles"));
// „Usuń na zawsze”, opróżnianie kosza, przenosiny starych załączników — tylko superadmin.
export const canPurgeFiles = (u) => Boolean(u?.is_super_admin || u?.isSuper);

// Zakładka „test-wycena” na karcie produktu (klucze po starej „Cenie”). Lustro w security.py →
// can_view_product_price / can_edit_product_price. Zapis leży na wierzchu podglądu.
export const canSeeProductPrice = (u) => can(u, "viewProductPrice") && can(u, "viewFinancials");
export const canEditProductPrice = (u) => canSeeProductPrice(u) && can(u, "editProductPrice");

// Zakładka „Cena” i kalkulator handlowca. Lustro w security.py →
// can_view_price_summary / can_use_sales_calculator. Kalkulator pokazuje zysk, a z niego
// widać koszt sztuki, więc wymaga też ceny zakupu. prowizjaOdCeny to ustawienie handlowca
// (sposób A = % ceny netto), nie dostęp — trzymane tu, żeby admin klikał je w tym samym panelu.
export const canSeePriceSummary = (u) => can(u, "viewPriceSummary");
// Boksy w „Cena” — domyślnie tylko ADMIN, reszcie ptaszek stawia admin.
// Koszt zakupu tylko z ceną zakupu. Lustro: can_view_price_summary_cost / _competition.
export const canSeePriceSummaryCost = (u) => canSeePriceSummary(u) && can(u, "priceSummaryCost") && canSeePurchasePrice(u);
export const canSeePriceSummaryCompetition = (u) => canSeePriceSummary(u) && can(u, "priceSummaryCompetition");
export const canUseSalesCalculator = (u) => canSeePriceSummary(u) && can(u, "useSalesCalculator") && canSeePurchasePrice(u);

// Efektywna mapa uprawnień użytkownika (domyślne z roli + override)
export const effectivePerms = (u) => {
  const base = { ...(ROLE_PERMS[u?.role] || {}) };
  if (u?.perms) Object.assign(base, u.perms);
  return base;
};
