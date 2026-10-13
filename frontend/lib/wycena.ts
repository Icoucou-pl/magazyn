// ============================================================
// MAGAZYN — rachunek kalkulatorów z zakładek „test-wycena” i „Cena”.
//
// wyliczWycene jest LUSTREM services/wycena.py → wylicz_wycene (serwer przy zapisie ceny
// minimalnej liczy ją jeszcze raz sam). Zasada ustalona z właścicielem: najpierw marża,
// potem koszty „+” tak, żeby marża została nietknięta — koszt w zł dodajemy, koszt w %
// od ceny końcowej dzielimy (4000 zł po marży i 5% prowizji → 4000 ÷ 0,95, nie 4000 + 5%).
//
// liczHandlowca — kalkulator handlowca: handlowiec wpisuje swoją cenę netto i widzi,
// ile zarobi on, a ile firma. Prowizja: A = % ceny netto, B = % zysku przed prowizją
// (sposób ustawia admin ptaszkiem „Prowizja od ceny” w koncie handlowca).
// ============================================================

export type TypKosztu = "zl" | "proc";
export type Od = "netto" | "brutto";
export type KosztPlus = { nazwa: string; typ: TypKosztu; wartosc: number; od: Od };

export type PozycjaRozpisu = KosztPlus & { kwota: number };
export type Wycena = {
  kosztBazy: number; marza: number; poMarzy: number; marzaZl: number;
  netto: number; brutto: number; koszty: PozycjaRozpisu[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** null = z tych danych nie da się policzyć ceny (front pokazuje podpowiedź zamiast liczb). */
export function wyliczWycene(kosztBazy: number, marza: number, koszty: KosztPlus[], vat: number): Wycena | null {
  if (!(kosztBazy > 0) || marza < 0 || marza >= 100) return null;
  const v = vat / 100;
  let sumaZl = 0;
  let mian = 1;
  for (const k of koszty) {
    if (!(k.wartosc >= 0)) return null;
    if (k.typ === "zl") sumaZl += k.wartosc;
    else mian -= (k.wartosc / 100) * (k.od === "brutto" ? 1 + v : 1);
  }
  if (mian <= 0) return null;
  const poMarzy = kosztBazy / (1 - marza / 100);
  const netto = r2((poMarzy + sumaZl) / mian);
  const brutto = r2(netto * (1 + v));
  return {
    kosztBazy: r2(kosztBazy), marza, poMarzy: r2(poMarzy), marzaZl: r2(poMarzy - kosztBazy), netto, brutto,
    koszty: koszty.map((k) => ({
      ...k, kwota: r2(k.typ === "zl" ? k.wartosc : (k.wartosc / 100) * (k.od === "brutto" ? brutto : netto)),
    })),
  };
}

/** Koszt bazowy do wyboru (serwer oddaje tylko policzalne) — routers/wycena.py → _koszty_bazy. */
export type BazaKosztu = "fifo" | "srednia" | "najblizsza" | "ostatnia";
export type KosztBazy = { baza: BazaKosztu; koszt: number; opis: string; szacunek: boolean };
export const BAZA_KROTKO: Record<BazaKosztu | "wlasna", string> = {
  fifo: "FIFO", srednia: "Średnia ze stanu", najblizsza: "Najbliższa dostawa", ostatnia: "Ostatnia dostawa", wlasna: "Własny koszt",
};

export type TrybProwizji = "A" | "B";
export type WynikHandlowca = {
  netto: number; koszt: number; koszty: PozycjaRozpisu[]; sumaKosztow: number;
  zyskPrzed: number; prowizja: number; zyskFirmy: number; marzaFirmy: number | null;
};

/** Koszty „+” handlowca liczą się od jego ceny netto (zł wprost, % od netto). */
export function liczHandlowca(netto: number, koszt: number, koszty: KosztPlus[], tryb: TrybProwizji, proc: number): WynikHandlowca {
  const poz = koszty.map((k) => ({ ...k, kwota: r2(k.typ === "zl" ? k.wartosc || 0 : ((k.wartosc || 0) / 100) * netto) }));
  const sumaKosztow = r2(poz.reduce((a, k) => a + k.kwota, 0));
  const zyskPrzed = r2(netto - koszt - sumaKosztow);
  const p = (proc || 0) / 100;
  const prowizja = r2(Math.max(0, tryb === "A" ? p * netto : p * zyskPrzed));
  const zyskFirmy = r2(zyskPrzed - prowizja);
  return { netto, koszt, koszty: poz, sumaKosztow, zyskPrzed, prowizja, zyskFirmy, marzaFirmy: netto > 0 ? (zyskFirmy / netto) * 100 : null };
}

export type Strefa = "ponizej" | "styk" | "dobra";

/** Kolor ceny handlowca: poniżej minimum / między minimum a progiem / od progu wzwyż.
 *  Próg = cena sugerowana dla dropów i hurtu, a gdy jej nie ma (albo jest niższa niż
 *  minimum) — minimum + 10%. */
export function progDobrejCeny(minimum: number, sugerowana: number | null): number {
  return sugerowana != null && sugerowana > minimum ? sugerowana : r2(minimum * 1.1);
}
export function strefa(cena: number, minimum: number, prog: number): Strefa {
  if (cena < minimum - 0.005) return "ponizej";
  if (cena < prog - 0.005) return "styk";
  return "dobra";
}

/** Wpis konkurencji starszy niż tyle dni dostaje plakietkę „do odświeżenia”. */
export const KONKURENCJA_STARA_DNI = 60;
export const dniTemu = (iso: string | null | undefined) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

export function mediana(liczby: number[]): number | null {
  if (!liczby.length) return null;
  const s = [...liczby].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const zl2 = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const proc1 = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
/** Pole tekstowe z liczbą: przecinek albo kropka, puste = 0. */
export const num = (v: string) => Number(String(v).replace(",", ".").replace(/\s/g, "")) || 0;
