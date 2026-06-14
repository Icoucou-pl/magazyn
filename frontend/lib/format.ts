// ============================================================
// MAGAZYN — formatery (port z mock-data.jsx). Wspólne dla widoków.
// ============================================================

export const fmtPLN = (n?: number) =>
  new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency: "PLN",
    maximumFractionDigits: 0,
  }).format(n || 0);

export const fmtPLNk = (n?: number) => {
  const v = n || 0;
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(".", ",") + " mln zł";
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1).replace(".", ",") + " tys zł";
  return new Intl.NumberFormat("pl-PL").format(v) + " zł";
};

export const fmtNum = (n?: number) => new Intl.NumberFormat("pl-PL").format(n || 0);

export const fmtPct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1).replace(".", ",") + "%";
