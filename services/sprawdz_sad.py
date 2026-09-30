"""Ręczne odpalenie parsera SAD na pliku z maila od agencji.

    python3 scripts/sprawdz_sad.py ~/Downloads/SAD_1790.xml

Nie dotyka bazy ani aplikacji — czyta plik, drukuje odczyt i wynik kontroli
krzyżowych. Przydaje się, gdy zgłoszenie wygląda nietypowo i chcesz zobaczyć,
co parser z niego wyciąga, zanim wrzucisz je w aplikacji.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.sad import parsuj, kontrole, podzial_kosztu, BladSAD  # noqa: E402


def main(sciezka: str) -> int:
    try:
        o = parsuj(sciezka)
    except BladSAD as e:
        print(f"Nie wczytano: {e}")
        return 1

    print(f"MRN {o.mrn} · {o.data_zgloszenia} · {o.importer} (NIP {o.nip_importera})")
    print(f"Dostawca: {o.dostawca} · {o.incoterms}")
    print(f"Waluta {o.waluta}, kurs celny {o.kurs_celny}"
          + (f" (w pliku także: {', '.join(k for k in o.kursy if k != o.waluta)})" if len(o.kursy) > 1 else ""))
    print(f"Wartość {o.wartosc_faktur} {o.waluta} · masa {o.masa_brutto} kg "
          f"· cło {o.clo_do_zaplaty} zł · VAT {o.vat_suma} zł")
    print(f"Kontenery: {', '.join(o.kontenery) or '—'}")
    print(f"Faktury dostawcy: {', '.join(o.faktury_dostawcy) or '—'}")
    print("\nDoliczenia:")
    for d in o.doliczenia:
        gdzie = "do wartości celnej" if d.do_wartosci_celnej else "tylko do podstawy VAT"
        print(f"  {d.kod}  {d.kwota:>10.2f} {o.waluta}  dzielone wg {d.klucz}  ({gdzie})")

    print("\nPozycje:")
    for p in o.pozycje:
        print(f"  {p.nr}. CN {p.kod_cn:<10} {p.wartosc:>10.2f} {o.waluta} {p.masa_brutto:>9.2f} kg "
              f" cło {p.clo_stawka}% = {p.clo_pln:.2f} zł   {p.opis[:48]}")

    k = kontrole(o)
    zle = [x for x in k if not x.ok]
    print(f"\nKontrole: {len(k) - len(zle)}/{len(k)} zgodnych")
    for x in zle:
        print(f"  BŁĄD  {x.nazwa}: wyliczone {x.wyliczone}, w pliku {x.z_pliku} (różnica {x.roznica})")

    fracht = next((d for d in o.doliczenia if d.kod == "031W"), None)
    if fracht:
        print("\nFracht rozbity kluczem z SAD:")
        for nr, kwota in podzial_kosztu(o, fracht.kwota, fracht.klucz).items():
            print(f"  poz. {nr}: {kwota:>10.2f} {o.waluta}")
    return 0 if not zle else 2


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(1)
    raise SystemExit(main(sys.argv[1]))
