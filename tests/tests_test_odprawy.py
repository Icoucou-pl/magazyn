"""Testy parsera SAD i rachunku odprawy.

Zgłoszenie jest ZMYŚLONE, ale ma strukturę i wszystkie pułapki prawdziwego eksportu
z WinSAD-a: dwie waluty w pliku, doliczenia z jawnym kluczem podziału, cło zaokrąglone
do pełnych złotych, pozycja obejmująca dwa SKU, pozycja gratis bez towaru na kontenerze
oraz kontener rozpisany na dwie pozycje. Dzięki temu test może leżeć w publicznym repo
— prawdziwych odpraw tam nie wrzucamy, bo niosą dostawcę, ceny i NIP-y.

Uruchomienie:  python3 -m pytest tests/test_odprawy.py -q
albo bez pytesta:  python3 tests/test_odprawy.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.sad import BladSAD, kontrole, parsuj  # noqa: E402
from services.odprawy import (  # noqa: E402
    KLUCZ_CBM, KLUCZ_WAGA, LiniaKosztu, PozycjaTowaru, dopasuj, policz,
)

# Liczby dobrane tak, żeby dzieliły się bez reszty i dało się je sprawdzić w pamięci:
# masy 800 / 200 / 20 kg, wartości 8000 / 2000 / 100 USD, kurs 4,0.
SAD_XML = """<?xml version="1.0" encoding="utf-8" ?>
<SADUE P22WalutaSADu="USD">
  <P1Kontekst DataDekl="2026-05-11"/>
  <P2Nadawca><Firmy Nazwa="TESTOWA FABRYKA" Kraj="CN"/></P2Nadawca>
  <P8Odbiorca><Firmy Nazwa="TESTOWA SP. Z O.O." NIP="0000000000"/></P8Odbiorca>
  <P20WarDostawy Kod="FOB" Miejsce="TESTPORT" KodKraju="CN"/>
  <P22KursyWalut Waluta="EUR" Kurs="5.0000" Mnoznik="1"/>
  <P22KursyWalut Waluta="USD" Kurs="4.0000" Mnoznik="1"/>
  <ZestawySADu P22WartoscZestawu="10100" P35BruttoZestawu="1020" SumaClaZestawu="437" SumaVATZestawu="9999">
    <StatusCelnyAIS MRNAIS="26PL00000000TEST01" StanAIS="80"/>
  </ZestawySADu>

  <PozycjeSADu P35MasaBrutto="800" P38MasaNetto="750" P42WartoscPozycji="8000" P47WartCelna="35295.64">
    <P31ZnakiINumery OpisTowaru="Krzesla i stoly testowe"><Opakowania RodzOpak="CT" LiczbaOpak="80"/>
      <Kontenery Numer="TEST1111111"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="9401 61 00"/>
    <P44DodInfo>
      <DokumWymag KodDokum="N935" NrDokum="FV-TEST-1"/>
      <KorektyZrodlowe KodKorekty="031W" WalutaKorekty="USD" RozbijWg="2" WartKorekty="784.31"/>
      <KorektyZrodlowe KodKorekty="032W" WalutaKorekty="USD" RozbijWg="1" WartKorekty="39.60"/>
      <KorektyZrodlowe KodKorekty="071V" WalutaKorekty="USD" RozbijWg="2" WartKorekty="78.43"/>
    </P44DodInfo>
    <P47Oplaty Typ="A00" Stawka="1" Kwota="353" MP="H"><Skladowe KwotaOplaty="352.96"/></P47Oplaty>
    <P47Oplaty Typ="B00" Stawka="23" Kwota="8200" MP="G"><Skladowe KwotaOplaty="8199.99"/></P47Oplaty>
  </PozycjeSADu>

  <PozycjeSADu P35MasaBrutto="200" P38MasaNetto="180" P42WartoscPozycji="2000" P47WartCelna="8823.92">
    <P31ZnakiINumery OpisTowaru="Lampy testowe"><Opakowania RodzOpak="CT" LiczbaOpak="20"/>
      <Kontenery Numer="TEST2222222"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="94052190"/>
    <P44DodInfo>
      <DokumWymag KodDokum="N935" NrDokum="FV-TEST-1"/>
      <KorektyZrodlowe KodKorekty="031W" WalutaKorekty="USD" RozbijWg="2" WartKorekty="196.08"/>
      <KorektyZrodlowe KodKorekty="032W" WalutaKorekty="USD" RozbijWg="1" WartKorekty="9.90"/>
      <KorektyZrodlowe KodKorekty="071V" WalutaKorekty="USD" RozbijWg="2" WartKorekty="19.61"/>
    </P44DodInfo>
    <P47Oplaty Typ="A00" Stawka="0.95" Kwota="84" MP="H"><Skladowe KwotaOplaty="83.83"/></P47Oplaty>
    <P47Oplaty Typ="B00" Stawka="23" Kwota="2050" MP="G"><Skladowe KwotaOplaty="2050.00"/></P47Oplaty>
  </PozycjeSADu>

  <PozycjeSADu P35MasaBrutto="20" P38MasaNetto="18" P42WartoscPozycji="100" P47WartCelna="480.44">
    <P31ZnakiINumery OpisTowaru="Czesci zamienne - gratis"><Opakowania RodzOpak="CT" LiczbaOpak="0"/>
      <Kontenery Numer="TEST1111111"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="39269097"/>
    <P44DodInfo>
      <DokumWymag KodDokum="N935" NrDokum="FV-TEST-1"/>
      <KorektyZrodlowe KodKorekty="031W" WalutaKorekty="USD" RozbijWg="2" WartKorekty="19.61"/>
      <KorektyZrodlowe KodKorekty="032W" WalutaKorekty="USD" RozbijWg="1" WartKorekty="0.50"/>
      <KorektyZrodlowe KodKorekty="071V" WalutaKorekty="USD" RozbijWg="2" WartKorekty="1.96"/>
    </P44DodInfo>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
    <P47Oplaty Typ="B00" Stawka="23" Kwota="102" MP="G"><Skladowe KwotaOplaty="101.58"/></P47Oplaty>
  </PozycjeSADu>

  <KorektyZbiorcze KodKorekty="031W" WalutaKorekty="USD" RozbijWg="2" WartKorekty="1000"/>
  <KorektyZbiorcze KodKorekty="032W" WalutaKorekty="USD" RozbijWg="1" WartKorekty="50"/>
  <KorektyZbiorcze KodKorekty="071V" WalutaKorekty="USD" RozbijWg="2" WartKorekty="100"/>
</SADUE>"""

# Kontener 1: krzesła i stoły (jedna pozycja SAD, dwa SKU). Kontener 2: lampy.
TOWAR = [
    PozycjaTowaru(1, 101, "KRZ", 100, 240.0, waga_brutto_kg=6.0, cbm=0.10),
    PozycjaTowaru(2, 101, "STL", 20,  400.0, waga_brutto_kg=10.0, cbm=0.50),
    PozycjaTowaru(3, 102, "LMP", 200, 40.0,  waga_brutto_kg=1.0, cbm=0.01),
]
KOSZTY = [
    LiniaKosztu("Fracht morski", 1000.0, lp=1),
    LiniaKosztu("THC", 100.0, lp=2),
    LiniaKosztu("Ubezpieczenie cargo", 50.0, klucz="wartosc", lp=4),
]


def test_parser_bierze_kurs_waluty_zgloszenia():
    o = parsuj(SAD_XML)
    assert o.waluta == "USD"
    assert o.kurs_celny == 4.0, "kurs EUR z pliku nie może wygrać z walutą zgłoszenia"
    assert set(o.kursy) == {"EUR", "USD"}


def test_parser_czyta_naglowek_i_kody_cn():
    o = parsuj(SAD_XML)
    assert o.mrn == "26PL00000000TEST01"
    assert o.nip_importera == "0000000000"
    assert o.incoterms == "FOB TESTPORT"
    assert o.kontenery == ["TEST1111111", "TEST2222222"]
    assert o.faktury_dostawcy == ["FV-TEST-1"]
    assert [p.kod_cn for p in o.pozycje] == ["94016100", "94052190", "39269097"], "spacje w kodzie CN muszą zniknąć"
    assert o.pozycje[2].liczba_opakowan == 0


def test_parser_rozroznia_clo_zaplacone_od_wyliczonego():
    o = parsuj(SAD_XML)
    assert o.pozycje[0].clo_pln == 353 and o.pozycje[0].clo_wyliczone == 352.96
    assert o.clo_do_zaplaty == 437.0 == o.clo_suma
    assert all(p.vat_metoda == "G" for p in o.pozycje), "VAT w JPK nie wchodzi do kosztu"


def test_kontrole_przechodza_na_spojnym_zgloszeniu():
    zle = [k for k in kontrole(parsuj(SAD_XML)) if not k.ok]
    assert not zle, [f"{k.nazwa}: {k.wyliczone} vs {k.z_pliku}" for k in zle]


def test_kontrole_lapia_podmieniona_wartosc():
    zepsuty = SAD_XML.replace('P42WartoscPozycji="2000"', 'P42WartoscPozycji="2500"')
    assert [k for k in kontrole(parsuj(zepsuty)) if not k.ok], "podmiana wartości musi zapalić kontrolę"


def test_smieciowe_wejscie_daje_czytelny_blad():
    for zle_dane in ("", "nie xml", "<Faktura/>"):
        try:
            parsuj(zle_dane)
        except BladSAD:
            continue
        raise AssertionError(f"{zle_dane!r} powinno rzucić BladSAD")


def test_ten_sam_sku_nie_rozpada_sie_na_dwie_pozycje():
    o = parsuj(SAD_XML)
    towar = TOWAR + [PozycjaTowaru(4, 102, "KRZ", 10, 240.0, waga_brutto_kg=6.0, cbm=0.10)]
    p = dopasuj(o, towar)
    assert p[1] == p[4], "KRZ z dwóch kontenerów musi trafić do jednej pozycji SAD"


def test_kod_cn_z_karty_produktu_wygrywa_z_wartoscia():
    o = parsuj(SAD_XML)
    towar = [PozycjaTowaru(9, 101, "LMP2", 1, 1.0, kod_cn="94052190")]
    assert dopasuj(o, towar)[9] == 2, "dopasowanie po kodzie CN ma pierwszeństwo"


def test_rachunek_spina_sie_co_do_grosza():
    o = parsuj(SAD_XML)
    r = policz(o, TOWAR, KOSZTY, klucz=KLUCZ_WAGA)
    # Towar: pozycje z towarem to 8000 + 2000 USD; gratis (100 USD) nie jest kupiony.
    assert round(r.suma_towar, 2) == 10000 * 4.0
    # Logistyka: cała faktura po kursie; cło: kwoty zapłacone z SAD.
    assert round(r.suma_logistyka, 2) == round(1150 * 4.0, 2)
    assert round(r.suma_clo, 2) == 437.0
    razem = sum(w.razem for w in r.pozycje)
    assert abs(razem - (40000 + 4600 + 437)) < 0.01


def test_pozycja_bez_towaru_trafia_na_najdrozszy_produkt():
    o = parsuj(SAD_XML)
    r = policz(o, TOWAR, KOSZTY, klucz=KLUCZ_WAGA)
    przejmuje = [w for w in r.pozycje if w.gratisy > 0]
    assert len(przejmuje) == 1 and przejmuje[0].sku == "KRZ", "gratis idzie na największą wartościowo pozycję"
    assert r.gratisy[3] == 1


def test_cena_reczna_nadpisuje_szacunek_w_pozycji_mieszanej():
    o = parsuj(SAD_XML)
    bez = policz(o, TOWAR, KOSZTY, klucz=KLUCZ_WAGA)
    assert {w.sku for w in bez.pozycje if w.szacunek} == {"KRZ", "STL"}
    # Z faktury dostawcy: 100 krzeseł po 60 USD i 20 stołów po 100 USD = 8000 USD.
    z = policz(o, TOWAR, KOSZTY, klucz=KLUCZ_WAGA, ceny_reczne={1: 60.0, 2: 100.0})
    assert not any(w.szacunek for w in z.pozycje)
    krzeslo = next(w for w in z.pozycje if w.sku == "KRZ")
    assert round(krzeslo.towar, 2) == round(100 * 60 * 4.0, 2)
    assert not [u for u in z.uwagi if u.poziom == "blad"]


def test_zle_ceny_reczne_zapalaja_blad():
    o = parsuj(SAD_XML)
    r = policz(o, TOWAR, KOSZTY, klucz=KLUCZ_WAGA, ceny_reczne={1: 10.0, 2: 10.0})
    assert [u for u in r.uwagi if u.poziom == "blad"], "suma 1200 USD zamiast 8000 musi zapalić błąd"


def test_klucz_zmienia_koszt_ciezkiego_drobiazgu():
    o = parsuj(SAD_XML)
    waga = {w.sku: w.koszt_jednostkowy for w in policz(o, TOWAR, KOSZTY, klucz=KLUCZ_WAGA).pozycje}
    cbm = {w.sku: w.koszt_jednostkowy for w in policz(o, TOWAR, KOSZTY, klucz=KLUCZ_CBM).pozycje}
    assert waga["LMP"] > cbm["LMP"], "lampa jest ciężka wobec swojej objętości — po CBM ma taniej"
    assert abs(sum(waga.values()) - sum(cbm.values())) > 0.01


def test_transport_krajowy_obciaza_tylko_swoj_kontener():
    o = parsuj(SAD_XML)
    koszty = KOSZTY + [LiniaKosztu("Transport krajowy", 2000.0, waluta="PLN", container_id=102)]
    r = policz(o, TOWAR, koszty, klucz=KLUCZ_WAGA)
    w_101 = [w for w in r.pozycje if w.container_id == 101]
    w_102 = [w for w in r.pozycje if w.container_id == 102]
    assert all(w.transport_krajowy == 0 for w in w_101)
    assert abs(sum(w.transport_krajowy for w in w_102) - 2000.0) < 0.01


def test_brak_cbm_nie_wywala_rachunku():
    o = parsuj(SAD_XML)
    bez_cbm = [PozycjaTowaru(t.item_id, t.container_id, t.sku, t.ilosc, t.cena_planowana,
                             waga_brutto_kg=t.waga_brutto_kg, cbm=None) for t in TOWAR]
    r = policz(o, bez_cbm, KOSZTY, klucz=KLUCZ_CBM)
    assert abs(sum(w.razem for w in r.pozycje) - (40000 + 4600 + 437)) < 0.01
    assert [u for u in r.uwagi if "CBM" in u.tresc]


# Odprawa Acti 1782 w pigułce: duża pozycja niedopełniona przez stare ceny planowane,
# obok drobna pozycja, której wartość odpowiada co do grosza jednemu SKU. Metryka
# bezwzględna dawała tu REMIS między „wstaw drobiazg do dużej pozycji" a „zostaw jego
# własną pozycję pustą" — i wybierała to drugie, przez co wysięgniki z własnym cłem 6,5%
# lądowały w gratisach przy łóżkach.
SAD_PUSTA_POZYCJA = """<?xml version="1.0" encoding="utf-8" ?>
<SADUE P22WalutaSADu="USD">
  <P1Kontekst DataDekl="2026-05-11"/>
  <P8Odbiorca><Firmy Nazwa="TESTOWA SP. Z O.O." NIP="0000000000"/></P8Odbiorca>
  <P22KursyWalut Waluta="USD" Kurs="4.0000" Mnoznik="1"/>
  <ZestawySADu P22WartoscZestawu="9600" P35BruttoZestawu="970" SumaClaZestawu="33">
    <StatusCelnyAIS MRNAIS="26PL00000000TEST02"/></ZestawySADu>
  <PozycjeSADu P35MasaBrutto="900" P38MasaNetto="880" P42WartoscPozycji="9000" P47WartCelna="36000">
    <P31ZnakiINumery OpisTowaru="Duza pozycja"><Opakowania RodzOpak="CT" LiczbaOpak="90"/>
      <Kontenery Numer="TEST3333333"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="94016100"/>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
    <P47Oplaty Typ="B00" Stawka="23" Kwota="8280" MP="G"><Skladowe KwotaOplaty="8280"/></P47Oplaty>
  </PozycjeSADu>
  <PozycjeSADu P35MasaBrutto="20" P38MasaNetto="18" P42WartoscPozycji="100" P47WartCelna="400">
    <P31ZnakiINumery OpisTowaru="Czesc gratis"><Opakowania RodzOpak="CT" LiczbaOpak="1"/>
      <Kontenery Numer="TEST3333333"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="84122180"/>
    <P47Oplaty Typ="A00" Stawka="2.7" Kwota="11" MP="H"><Skladowe KwotaOplaty="10.8"/></P47Oplaty>
    <P47Oplaty Typ="B00" Stawka="23" Kwota="95" MP="G"><Skladowe KwotaOplaty="94.5"/></P47Oplaty>
  </PozycjeSADu>
  <PozycjeSADu P35MasaBrutto="50" P38MasaNetto="45" P42WartoscPozycji="500" P47WartCelna="2000">
    <P31ZnakiINumery OpisTowaru="Wysiegniki - wlasna pozycja"><Opakowania RodzOpak="CT" LiczbaOpak="5"/>
      <Kontenery Numer="TEST3333333"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="39269097"/>
    <P47Oplaty Typ="A00" Stawka="6.5" Kwota="130" MP="H"><Skladowe KwotaOplaty="130"/></P47Oplaty>
    <P47Oplaty Typ="B00" Stawka="23" Kwota="489" MP="G"><Skladowe KwotaOplaty="489"/></P47Oplaty>
  </PozycjeSADu>
</SADUE>"""

# Ceny planowane celowo zaniżone o ~6% na dużej pozycji — tak jak w prawdziwej odprawie,
# gdzie unit_cost pochodzi sprzed dostawy.
TOWAR_PUSTA = [
    PozycjaTowaru(11, 201, "DUZY", 100, 340.0),   # 8 500 USD wobec pozycji za 9 000
    PozycjaTowaru(12, 201, "WYSIEG", 50, 40.0),   # 500 USD — dokładnie tyle, co pozycja 3
]


def test_nie_zostawia_pustej_pozycji_gdy_pasuje_do_niej_towar():
    o = parsuj(SAD_PUSTA_POZYCJA)
    p = dopasuj(o, TOWAR_PUSTA)
    assert p[12] == 3, "SKU o wartości równej pozycji 3 musi tam trafić, a nie do niedopełnionej pozycji 1"
    assert p[11] == 1


def test_wlasna_pozycja_niesie_wlasne_clo():
    o = parsuj(SAD_PUSTA_POZYCJA)
    r = policz(o, TOWAR_PUSTA, [LiniaKosztu("Fracht morski", 1000.0, lp=1)], klucz=KLUCZ_WAGA)
    wysieg = next(w for w in r.pozycje if w.sku == "WYSIEG")
    duzy = next(w for w in r.pozycje if w.sku == "DUZY")
    assert round(wysieg.clo, 2) == 130.0, "cło 6,5% należy do wysięgników, nie do gratisów"
    assert round(duzy.clo, 2) == 0.0
    # Gratis to cło pozycji 2 (11 zł) ORAZ jej udział we frachcie — część zamienna też
    # zajęła miejsce w kontenerze, więc nie jeździ za darmo.
    assert duzy.gratisy > 11.0 and wysieg.gratisy == 0.0
    razem = sum(w.razem for w in r.pozycje)
    assert abs(razem - (38000 + 1000 * 4 + 141)) < 0.01, f"towar + fracht + cło, wyszło {razem}"
    assert not any(w.szacunek for w in r.pozycje), "każda pozycja ma jedno SKU — bez szacowania"


def test_niepewne_dopasowanie_daje_ostrzezenie():
    """Dwa SKU o zbliżonej wartości i dwie pozycje, które da się obsadzić na dwa sposoby."""
    xml = SAD_PUSTA_POZYCJA.replace('P42WartoscPozycji="500"', 'P42WartoscPozycji="900"')
    o = parsuj(xml)
    towar = [PozycjaTowaru(21, 201, "A", 10, 380.0), PozycjaTowaru(22, 201, "B", 10, 370.0)]
    r = policz(o, towar, [LiniaKosztu("Fracht morski", 100.0, lp=1)], klucz=KLUCZ_WAGA)
    assert [u for u in r.uwagi if u.poziom == "ostrzezenie" and "sprawdź" in u.tresc], \
        "bliski remis musi zapalić ostrzeżenie o dopasowaniu"


def test_pewne_dopasowanie_bez_ostrzezenia():
    o = parsuj(SAD_PUSTA_POZYCJA)
    r = policz(o, TOWAR_PUSTA, [LiniaKosztu("Fracht morski", 1000.0, lp=1)], klucz=KLUCZ_WAGA)
    assert not [u for u in r.uwagi if u.poziom == "ostrzezenie" and "sprawdź" in u.tresc]


# Odprawa AMH 1797 w pigułce: cztery pozycje opisane po polsku i towar, którego nazwy
# mówią wprost, do której pozycji należy — a ceny planowane są sprzed dostawy i mylą
# dopasowanie po wartości. Bez kroku „po nazwie" materace lądowały w poduszkach,
# a prześcieradła w pokrowcach PVC.
SAD_OPISOWY = """<?xml version="1.0" encoding="utf-8" ?>
<SADUE P22WalutaSADu="USD">
  <P1Kontekst DataDekl="2026-05-11"/>
  <P8Odbiorca><Firmy Nazwa="TESTOWA SP. Z O.O." NIP="0000000000"/></P8Odbiorca>
  <P22KursyWalut Waluta="USD" Kurs="4.0000" Mnoznik="1"/>
  <ZestawySADu P22WartoscZestawu="10000" P35BruttoZestawu="1000" SumaClaZestawu="0">
    <StatusCelnyAIS MRNAIS="26PL00000000TEST03"/></ZestawySADu>
  <PozycjeSADu P35MasaBrutto="800" P38MasaNetto="780" P42WartoscPozycji="8000" P47WartCelna="32000">
    <P31ZnakiINumery OpisTowaru="MATERAC ANATOMICZNY WYKONANY Z PIANKI MEMORY"><Opakowania RodzOpak="CT" LiczbaOpak="80"/>
      <Kontenery Numer="TEST4444444"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="94042190"/>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
    <P47Oplaty Typ="B00" Stawka="23" Kwota="7360" MP="G"><Skladowe KwotaOplaty="7360"/></P47Oplaty>
  </PozycjeSADu>
  <PozycjeSADu P35MasaBrutto="200" P38MasaNetto="190" P42WartoscPozycji="2000" P47WartCelna="8000">
    <P31ZnakiINumery OpisTowaru="PODUSZKA KOSMETYCZNA WYKONANA Z PIANKI TAPICERSKIEJ"><Opakowania RodzOpak="CT" LiczbaOpak="20"/>
      <Kontenery Numer="TEST4444444"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="94049090"/>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
    <P47Oplaty Typ="B00" Stawka="23" Kwota="1840" MP="G"><Skladowe KwotaOplaty="1840"/></P47Oplaty>
  </PozycjeSADu>
</SADUE>"""

# Ceny planowane celowo przestawione: materac wyceniony nisko, poduszka wysoko —
# sama wartość wskazałaby odwrotne przypisanie niż prawda.
TOWAR_OPISOWY = [
    PozycjaTowaru(31, 301, "MC_60", 100, 80.0, waga_brutto_kg=8.0, nazwa="Materac EKO 60 z pianki"),
    PozycjaTowaru(32, 301, "PDcz", 100, 320.0, waga_brutto_kg=2.0, nazwa="Poduszka kosmetyczna czarna"),
]


def test_nazwa_towaru_wygrywa_ze_zwodnicza_wartoscia():
    o = parsuj(SAD_OPISOWY)
    p = dopasuj(o, TOWAR_OPISOWY)
    assert p[31] == 1, "materac ma trafić do pozycji o materacach, mimo niższej ceny planowanej"
    assert p[32] == 2, "poduszka do pozycji o poduszkach"


def test_dopasowanie_po_nazwie_jest_odnotowane():
    o = parsuj(SAD_OPISOWY)
    slady = {}
    dopasuj(o, TOWAR_OPISOWY, slady)
    assert slady["zrodlo"] == {"MC_60": "nazwa", "PDcz": "nazwa"}
    assert not slady["po_wartosci"], "nic nie powinno zostać do zgadywania po wartości"


def test_kod_cn_ma_pierwszenstwo_przed_nazwa():
    o = parsuj(SAD_OPISOWY)
    # Nazwa mówi „materac", ale karta produktu niesie kod CN poduszek — kod wygrywa,
    # bo pochodzi z potwierdzonej wcześniej odprawy, a nie z podobieństwa słów.
    towar = [PozycjaTowaru(33, 301, "MC_X", 10, 100.0, kod_cn="94049090", nazwa="Materac testowy")]
    slady = {}
    assert dopasuj(o, towar, slady)[33] == 2
    assert slady["zrodlo"] == {"MC_X": "cn"}


def test_remis_nazw_zostawia_sprawe_wartosci():
    o = parsuj(SAD_OPISOWY)
    # „Pokrowiec" nie występuje w żadnym opisie — nazwa nie rozstrzyga, decyduje wartość.
    towar = [PozycjaTowaru(34, 301, "POK", 10, 100.0, nazwa="Pokrowiec PVC")]
    slady = {}
    dopasuj(o, towar, slady)
    assert slady["zrodlo"] == {"POK": "wartosc"}


def test_rozjazd_wartosci_pozycji_zapala_ostrzezenie():
    o = parsuj(SAD_OPISOWY)
    # Materac wyceniony w katalogu na ułamek tego, co zgłoszono; poduszka trafia w punkt.
    # Ostrzeżenie ma dotyczyć tylko tej pozycji, która się rozjeżdża.
    towar = [
        PozycjaTowaru(35, 301, "MC_60", 100, 8.0, nazwa="Materac EKO 60 z pianki"),
        PozycjaTowaru(36, 301, "PDcz", 100, 80.0, nazwa="Poduszka kosmetyczna czarna"),
    ]
    r = policz(o, towar, [LiniaKosztu("Fracht morski", 100.0, lp=1)], klucz=KLUCZ_WAGA)
    rozjazdy = [u for u in r.uwagi if "wartości ze zgłoszenia" in u.tresc]
    assert len(rozjazdy) == 1 and "Poz. 1" in rozjazdy[0].tresc, [u.tresc for u in rozjazdy]


def test_duza_odprawa_zawsze_prosi_o_sprawdzenie():
    """Ścieżka zachłanna (zbyt wiele układów na pełny przegląd) nie gwarantuje optimum.

    Wcześniej milczała: margines liczył się wyłącznie przy pełnym przeglądzie, więc
    największe odprawy — te, które najbardziej potrzebują kontroli — nie dostawały
    żadnego ostrzeżenia.
    """
    o = parsuj(SAD_OPISOWY)
    # 2 pozycje i 20 SKU bez nazw = 2^20 układów, czyli ponad limit pełnego przeglądu.
    towar = [PozycjaTowaru(100 + i, 301, f"X{i}", 10, 50.0) for i in range(20)]
    slady = {}
    dopasuj(o, towar, slady)
    assert slady["zachlannie"] is True
    r = policz(o, towar, [LiniaKosztu("Fracht morski", 100.0, lp=1)], klucz=KLUCZ_WAGA)
    assert [u for u in r.uwagi if u.poziom == "ostrzezenie" and "sprawdź" in u.tresc]


if __name__ == "__main__":
    zle = 0
    for nazwa, fn in sorted(globals().items()):
        if not nazwa.startswith("test_"):
            continue
        try:
            fn()
            print(f"  ok    {nazwa}")
        except AssertionError as e:
            zle += 1
            print(f"  BŁĄD  {nazwa}: {e}")
    print("wszystkie testy przeszły" if not zle else f"{zle} testów nie przeszło")
    raise SystemExit(1 if zle else 0)
