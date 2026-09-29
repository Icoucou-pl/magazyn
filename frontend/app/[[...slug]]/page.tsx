// ============================================================
// Catch-all trasy aplikacji. Cała treść siedzi w powłoce
// (components/app-shell.tsx, montowanej w app/layout.tsx), która czyta
// adres przez usePathname. Ta strona istnieje tylko po to, żeby każdy
// adres (/produkty/SKU, /kontenery/12…) był poprawną trasą — bez niej
// twarde odświeżenie dawałoby 404.
// ============================================================

export default function Page() {
  return null;
}
