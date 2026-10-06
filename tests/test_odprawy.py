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


def test_pozycja_bez_towaru_rozklada_sie_na_towar_po_wartosci():
    """Domyślnie koszty pozycji bez towaru idą na cały towar, proporcjonalnie do wartości."""
    o = parsuj(SAD_XML)
    r = policz(o, TOWAR, KOSZTY, klucz=KLUCZ_WAGA)
    assert r.gratisy[3] == 0, "0 = rozłożone"
    pula = sum(w.gratisy for w in r.pozycje)
    towar = sum(w.towar for w in r.pozycje)
    for w in r.pozycje:
        assert abs(w.gratisy - pula * w.towar / towar) < 0.01, w.sku


def test_gratis_mozna_przypiac_do_jednego_produktu():
    o = parsuj(SAD_XML)
    r = policz(o, TOWAR, KOSZTY, klucz=KLUCZ_WAGA, gratisy={3: 1})
    przejmuje = [w for w in r.pozycje if w.gratisy > 0]
    assert len(przejmuje) == 1 and przejmuje[0].item_id == 1


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
    # Bez faktur dostawcy gratis rozkłada się na cały towar po wartości ze zgłoszenia:
    # DUZY (pozycja za 9000 USD) niesie 18/19 puli, WYSIEG (500 USD) 1/19.
    pula = duzy.gratisy + wysieg.gratisy
    assert pula > 11.0 and abs(duzy.gratisy / pula - 9000 / 9500) < 0.001
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



# Dwie pozycje, które biją się o to samo słowo: krótka „POKROWCE PVC" i zbiorcza,
# w której „pokrowiec" jest rzeczownikiem drugoplanowym. Tak wygląda odprawa AMH 1797
# i tak wykładało się liczenie samych wspólnych słów: opis zbiorczy miał ich więcej,
# więc zgarniał pokrowce PVC, choć to nie o nim mowa.
SAD_ZBIORCZY = """<?xml version="1.0" encoding="utf-8" ?>
<SADUE P22WalutaSADu="USD">
  <P1Kontekst DataDekl="2026-05-11"/>
  <P8Odbiorca><Firmy Nazwa="TESTOWA SP. Z O.O." NIP="0000000000"/></P8Odbiorca>
  <P22KursyWalut Waluta="USD" Kurs="4.0000" Mnoznik="1"/>
  <ZestawySADu P22WartoscZestawu="5000" P35BruttoZestawu="500" SumaClaZestawu="0">
    <StatusCelnyAIS MRNAIS="26PL00000000TEST04"/></ZestawySADu>
  <PozycjeSADu P35MasaBrutto="100" P38MasaNetto="95" P42WartoscPozycji="1000" P47WartCelna="4000">
    <P31ZnakiINumery OpisTowaru="POKROWCE PVC"><Opakowania RodzOpak="CT" LiczbaOpak="10"/>
      <Kontenery Numer="TEST5555555"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="39269097"/>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
  </PozycjeSADu>
  <PozycjeSADu P35MasaBrutto="400" P38MasaNetto="380" P42WartoscPozycji="4000" P47WartCelna="16000">
    <P31ZnakiINumery OpisTowaru="POSZEWKA NA PODUSZKĘ, PRZEŚCIERADŁO - POKROWIEC NA MATERAC WYKONANE Z JEDWABIU SYNTETYCZNEGO/WELUR"><Opakowania RodzOpak="CT" LiczbaOpak="40"/>
      <Kontenery Numer="TEST5555555"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="63023290"/>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
  </PozycjeSADu>
</SADUE>"""


def test_krotki_opis_nie_przegrywa_z_dluzszym_o_ten_sam_towar():
    """Pokrowiec PVC ma trafić do pozycji o pokrowcach PVC, nie do zbiorczej.

    Liczenie samych wspólnych słów dawało tu 1:1 albo przewagę pozycji zbiorczej
    (bo „pokrowiec" stoi i tam), a miara Dice'a patrzy na dopasowanie z obu stron:
    dla pozycji krótkiej pokrywa się CAŁY jej opis, dla zbiorczej jedna dziewiąta.
    """
    o = parsuj(SAD_ZBIORCZY)
    towar = [PozycjaTowaru(41, 301, "POK70L", 10, 100.0, nazwa="Pokrowiec PVC 70L")]
    slady = {}
    assert dopasuj(o, towar, slady)[41] == 1
    assert slady["zrodlo"] == {"POK70L": "nazwa"}


def test_nazwa_z_dwoma_rzeczownikami_idzie_do_pozycji_zbiorczej():
    """Odwrotny kierunek tej samej miary — nie wystarczy faworyzować krótkich opisów.

    „Poszewka na poduszkę welurowa" pokrywa trzy słowa opisu zbiorczego, więc wygrywa
    z pozycją o pokrowcach PVC, z którą nie ma wspólnego ani jednego.
    """
    o = parsuj(SAD_ZBIORCZY)
    towar = [PozycjaTowaru(42, 301, "POSZ_w", 10, 100.0, nazwa="Poszewka na poduszkę welurowa")]
    assert dopasuj(o, towar)[42] == 2


def test_symbol_krotszy_niz_slowo_w_opisie_tez_dopasowuje():
    """Symbol „PRZE5S" daje rdzeń „prze", a opis celny „przesc" — to ta sama rzecz.

    Przy porównaniu całych rdzeni nie spotykały się nigdy, więc towar bez opisowej
    nazwy w katalogu spadał do zgadywania po wartości.
    """
    o = parsuj(SAD_ZBIORCZY)
    towar = [PozycjaTowaru(43, 301, "PRZE5S", 10, 100.0)]
    slady = {}
    assert dopasuj(o, towar, slady)[43] == 2
    assert slady["zrodlo"] == {"PRZE5S": "nazwa"}


SAD_BLIZNIACZY = """<?xml version="1.0" encoding="utf-8" ?>
<SADUE P22WalutaSADu="USD">
  <P1Kontekst DataDekl="2026-05-11"/>
  <P8Odbiorca><Firmy Nazwa="TESTOWA SP. Z O.O." NIP="0000000000"/></P8Odbiorca>
  <P22KursyWalut Waluta="USD" Kurs="4.0000" Mnoznik="1"/>
  <ZestawySADu P22WartoscZestawu="2000" P35BruttoZestawu="200" SumaClaZestawu="0">
    <StatusCelnyAIS MRNAIS="26PL00000000TEST05"/></ZestawySADu>
  <PozycjeSADu P35MasaBrutto="100" P38MasaNetto="95" P42WartoscPozycji="1000" P47WartCelna="4000">
    <P31ZnakiINumery OpisTowaru="MATERAC PIANKA"><Opakowania RodzOpak="CT" LiczbaOpak="10"/>
      <Kontenery Numer="TEST6666666"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="94042190"/>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
  </PozycjeSADu>
  <PozycjeSADu P35MasaBrutto="100" P38MasaNetto="95" P42WartoscPozycji="1000" P47WartCelna="4000">
    <P31ZnakiINumery OpisTowaru="PIANKA MATERAC"><Opakowania RodzOpak="CT" LiczbaOpak="10"/>
      <Kontenery Numer="TEST6666666"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="94042990"/>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
  </PozycjeSADu>
</SADUE>"""


def test_remis_podobienstwa_nie_jest_rozstrzygany_nazwa():
    """Dwie pozycje opisane tymi samymi słowami — nazwa nie ma prawa wybrać.

    Wymagamy ŚCISŁEJ przewagi. Bez tego decydowałaby kolejność pozycji w pliku,
    czyli nic, a wynik wyglądałby na przemyślany.
    """
    o = parsuj(SAD_BLIZNIACZY)
    towar = [PozycjaTowaru(44, 301, "MAT", 10, 100.0, nazwa="Materac piankowy")]
    slady = {}
    dopasuj(o, towar, slady)
    assert slady["zrodlo"] == {"MAT": "wartosc"}


def test_waga_obiecana_tylko_przy_pozycji_z_jednym_sku():
    """Zapis dopisuje wagę wyłącznie z pozycji obejmującej jedno SKU.

    Komunikat obiecywał to wcześniej wszystkim brakom naraz, także tym z pozycji
    mieszanych, gdzie z masy pozycji nie da się wyliczyć masy sztuki. Akurat tam brak
    wagi kosztuje najwięcej: logistyka dzieli się wtedy wewnątrz pozycji po wartości,
    więc droższa sztuka płaci wyższy fracht, choćby ważyła tyle samo.
    """
    o = parsuj(SAD_ZBIORCZY)
    towar = [
        PozycjaTowaru(51, 301, "POK70L", 10, 100.0, nazwa="Pokrowiec PVC 70L"),
        PozycjaTowaru(52, 301, "PRZE5S", 10, 100.0, nazwa="Prześcieradło welurowe"),
        PozycjaTowaru(53, 301, "POSZ_w", 10, 100.0, nazwa="Poszewka na poduszkę welurowa"),
    ]
    r = policz(o, towar, [LiniaKosztu("Fracht morski", 100.0, lp=1)], klucz=KLUCZ_WAGA)
    obietnice = [u for u in r.uwagi if "uzupełni się przy zapisie" in u.tresc]
    recznie = [u for u in r.uwagi if "wpisz ją ręcznie" in u.tresc]
    assert len(obietnice) == 1 and obietnice[0].szczegol == "POK70L", [u.szczegol for u in obietnice]
    assert len(recznie) == 1 and recznie[0].szczegol == "POSZ_w, PRZE5S", [u.szczegol for u in recznie]


# Odprawa Acti 1796 w miniaturze: towar bez cła i część zamienna „gratis", na której
# cło jednak jest. Zgłoszenie każe zapłacić 21 zł, a kafelek CŁO pokazywał 0 — bo kwota
# szła razem z logistyką gratisu. Na sztuce nic się nie zmienia, ale panel kontrolny
# rozjeżdżał się z SAD-em dokładnie tam, gdzie ma się zgadzać.
SAD_GRATIS_Z_CLEM = """<?xml version="1.0" encoding="utf-8" ?>
<SADUE P22WalutaSADu="USD">
  <P1Kontekst DataDekl="2026-09-16"/>
  <P8Odbiorca><Firmy Nazwa="TESTOWA SP. Z O.O." NIP="0000000000"/></P8Odbiorca>
  <P22KursyWalut Waluta="USD" Kurs="4.0000" Mnoznik="1"/>
  <ZestawySADu P22WartoscZestawu="1200" P35BruttoZestawu="1010" SumaClaZestawu="20">
    <StatusCelnyAIS MRNAIS="26PL00000000TEST06"/></ZestawySADu>
  <PozycjeSADu P35MasaBrutto="1000" P38MasaNetto="950" P42WartoscPozycji="1000" P47WartCelna="4000">
    <P31ZnakiINumery OpisTowaru="LOZKA SZPITALNE STALOWE"><Opakowania RodzOpak="CT" LiczbaOpak="100"/>
      <Kontenery Numer="TEST7777777"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="94029000"/>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
  </PozycjeSADu>
  <PozycjeSADu P35MasaBrutto="10" P38MasaNetto="9" P42WartoscPozycji="200" P47WartCelna="800">
    <P31ZnakiINumery OpisTowaru="SILOWNIK TELESKOPOWY, CZESC ZAMIENNA"><Opakowania RodzOpak="CT" LiczbaOpak="1"/>
      <Kontenery Numer="TEST7777777"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="84122180"/>
    <P47Oplaty Typ="A00" Stawka="2.7" Kwota="20" MP="H"><Skladowe KwotaOplaty="21.60"/></P47Oplaty>
  </PozycjeSADu>
</SADUE>"""


def test_clo_pozycji_gratis_liczy_sie_do_cla_a_nie_do_logistyki():
    o = parsuj(SAD_GRATIS_Z_CLEM)
    towar = [PozycjaTowaru(61, 301, "SZP", 10, 500.0, nazwa="Łóżko szpitalne")]
    r = policz(o, towar, [LiniaKosztu("Fracht morski", 100.0, lp=1)], klucz=KLUCZ_WAGA)
    assert round(r.suma_clo, 2) == 20.0, "kafelek CŁO ma pokazywać to, co zgłoszenie każe zapłacić"
    assert round(r.suma_logistyka, 2) == round(100.0 * 4.0, 2), "logistyka to sama faktura spedytora"
    # Na sztuce nic nie ubywa — cło gratisu nadal jedzie w kolumnie „gratisy".
    w = r.pozycje[0]
    assert round(w.razem, 2) == round(1000 * 4.0 + 400.0 + 20.0, 2)


# ── Kontener skonsolidowany ─────────────────────────────────────────────────
# Zgłoszenie budowane z listy pozycji: (wartość USD, masa kg, faktura dostawcy, opis).
# Odwzorowuje SAD 1/2 konsolidacji Acti CORU2068476 — trzy faktury, a jedna pozycja
# (próbka) nie ma towaru na kontenerze.
def _sad_z_pozycji(pozycje, mrn="26PL00000000TEST07"):
    poz_xml = []
    for wart, masa, fv, opis in pozycje:
        poz_xml.append(f"""
  <PozycjeSADu P35MasaBrutto="{masa}" P38MasaNetto="{masa}" P42WartoscPozycji="{wart}" P47WartCelna="{wart * 4}">
    <P31ZnakiINumery OpisTowaru="{opis}"><Opakowania RodzOpak="CT" LiczbaOpak="1"/>
      <Kontenery Numer="TEST8888888"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="94029000"/>
    <P44DodInfo><DokumWymag KodDokum="N935" NrDokum="{fv}"/></P44DodInfo>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
  </PozycjeSADu>""")
    suma = sum(p[0] for p in pozycje)
    masa = sum(p[1] for p in pozycje)
    return f"""<?xml version="1.0" encoding="utf-8" ?>
<SADUE P22WalutaSADu="USD">
  <P1Kontekst DataDekl="2026-04-15"/>
  <P8Odbiorca><Firmy Nazwa="TESTOWA SP. Z O.O." NIP="0000000000"/></P8Odbiorca>
  <P22KursyWalut Waluta="USD" Kurs="4.0000" Mnoznik="1"/>
  <ZestawySADu P22WartoscZestawu="{suma}" P35BruttoZestawu="{masa}" SumaClaZestawu="0">
    <StatusCelnyAIS MRNAIS="{mrn}"/></ZestawySADu>{''.join(poz_xml)}
</SADUE>"""


SAD_KONSOLIDACJA = _sad_z_pozycji([
    (2000, 200, "FV-A", "LOZKA SZPITALNE"),         # 1: dostawca A
    (1580, 80, "FV-B", "MATA PLAZOWA"),             # 2: dostawca B
    (890, 63, "FV-B", "WOZEK ELEKTRYCZNY PROBKA"),  # 3: dostawca B — próbki nie ma na kontenerze
    (1784, 94, "FV-B", "WOZKI BEZ NAPEDU"),         # 4: dostawca B
    (2630, 800, "FV-C", "STOLIK PRZYLOZKOWY"),      # 5: dostawca C
])
TOWAR_KONSOLIDACJA = [
    PozycjaTowaru(71, 501, "LOZ", 2, 4000.0, waga_brutto_kg=100.0),
    PozycjaTowaru(72, 501, "MATA", 1, 6320.0, waga_brutto_kg=80.0),
    PozycjaTowaru(73, 501, "WPA", 1, 3340.0, waga_brutto_kg=30.0),
    PozycjaTowaru(74, 501, "WP", 1, 2396.0, waga_brutto_kg=25.0),
    PozycjaTowaru(75, 501, "KRZ", 1, 1400.0, waga_brutto_kg=39.0),
    PozycjaTowaru(76, 501, "STOL", 100, 105.2, waga_brutto_kg=8.0),
]
FAKTURY_KONSOLIDACJA = {"LOZ": {"FV-A"}, "MATA": {"FV-B"}, "WPA": {"FV-B"}, "WP": {"FV-B"},
                        "KRZ": {"FV-B"}, "STOL": {"FV-C"}}


def test_faktura_dostawcy_zawęża_dopasowanie_do_jej_pozycji():
    """SKU od dostawcy A nie może trafić do pozycji faktury B, choćby wartość pasowała."""
    o = parsuj(SAD_KONSOLIDACJA)
    p = dopasuj(o, TOWAR_KONSOLIDACJA, faktury_sku=FAKTURY_KONSOLIDACJA)
    assert p[71] == 1, "jedyna pozycja faktury A — tu nie ma czego zgadywać"
    assert p[76] == 5, "jedyna pozycja faktury C"
    for item in (72, 73, 74, 75):
        assert p[item] in (2, 3, 4), f"towar dostawcy B poza pozycjami faktury B: {item} -> {p[item]}"


def test_reczna_zmiana_pozycji_nie_wyrzuca_reszty_towaru():
    """Lista „Pozycja SAD" wysyła tylko przestawione SKU.

    Rachunek brał to za kompletne przypisanie i cała reszta towaru zostawała bez pozycji:
    bez ceny zakupu, a pozycje SAD szły w gratisy. Ręczna zmiana ma NADPISYWAĆ automat.
    """
    o = parsuj(SAD_KONSOLIDACJA)
    r = policz(o, TOWAR_KONSOLIDACJA, [LiniaKosztu("Fracht morski", 100.0, lp=1)],
               klucz=KLUCZ_WAGA, przypisanie={73: 4}, faktury_sku=FAKTURY_KONSOLIDACJA)
    assert r.przypisanie[73] == 4, "ręczna zmiana musi zostać"
    assert all(w.towar > 0 for w in r.pozycje), [w.sku for w in r.pozycje if not w.towar]


def test_pelne_przypisanie_z_formularza_nic_nie_przestawia():
    """Front po każdej zmianie wysyła cały układ — wtedy nic nie ma prawa się ruszyć."""
    o = parsuj(SAD_KONSOLIDACJA)
    uklad = {71: 1, 72: 2, 73: 4, 74: 4, 75: 4, 76: 5}
    r = policz(o, TOWAR_KONSOLIDACJA, [LiniaKosztu("Fracht morski", 100.0, lp=1)],
               klucz=KLUCZ_WAGA, przypisanie=uklad, faktury_sku=FAKTURY_KONSOLIDACJA)
    assert {k: r.przypisanie[k] for k in uklad} == uklad


def test_gratis_rozklada_sie_na_towar_tej_samej_faktury():
    """Próbka od dostawcy B obciąża cały towar B po wartości — nic nie idzie na A ani C."""
    o = parsuj(SAD_KONSOLIDACJA)
    uklad = {71: 1, 72: 2, 73: 4, 74: 4, 75: 4, 76: 5}   # pozycja 3 bez towaru
    r = policz(o, TOWAR_KONSOLIDACJA, [LiniaKosztu("Fracht morski", 100.0, lp=1)],
               klucz=KLUCZ_WAGA, przypisanie=uklad, faktury_sku=FAKTURY_KONSOLIDACJA)
    w = {x.item_id: x for x in r.pozycje}
    assert w[71].gratisy == 0 and w[76].gratisy == 0, "towar innych faktur nie płaci za próbkę B"
    b = [w[i] for i in (72, 73, 74, 75)]
    pula = sum(x.gratisy for x in b)
    assert pula > 0
    for x in b:
        assert abs(x.gratisy - pula * x.towar / sum(y.towar for y in b)) < 0.01, x.sku


def test_transport_krajowy_bierze_tylko_udzial_odprawy():
    """Jedna ciężarówka na kontener — odprawa z 40% wagi niesie 40% transportu."""
    o = parsuj(SAD_KONSOLIDACJA)
    uklad = {71: 1, 72: 2, 73: 4, 74: 4, 75: 4, 76: 5}
    r = policz(o, TOWAR_KONSOLIDACJA, [LiniaKosztu("Transport krajowy", 1000.0, waluta="PLN", container_id=501)],
               klucz=KLUCZ_WAGA, przypisanie=uklad, udzial_kontenera={501: 0.4})
    assert abs(sum(w.transport_krajowy for w in r.pozycje) - 400.0) < 0.01


def test_duza_odprawa_z_dokladnymi_cenami_uklada_sie_poprawnie():
    """Ścieżka zachłanna: 12 SKU w 6 pozycjach (6^12 układów, ponad limit pełnego przeglądu).

    Wcześniej SKU jeszcze nieułożone liczyły się tak, jakby leżały w pozycji 1, więc
    pierwsze decyzje szły pod sztucznie przepełnioną pozycję i przy cenach zgodnych
    z fakturą co do procenta trafiało mniej niż połowa.
    """
    wartosci = [(1000, "A"), (2600, "B"), (450, "C"), (5200, "D"), (175, "E"), (3300, "F")]
    o = parsuj(_sad_z_pozycji([(w, 10, "FV-" + n, "TOWAR " + n) for w, n in wartosci]))
    # Każda pozycja to dwa SKU o różnych cenach; ceny planowane (PLN) = cena USD × kurs 4.
    sklad = {1: (600, 400), 2: (1500, 1100), 3: (250, 200), 4: (3000, 2200), 5: (100, 75), 6: (2000, 1300)}
    towar, prawda, i = [], {}, 200
    for nr, (a, b) in sklad.items():
        for usd in (a, b):
            towar.append(PozycjaTowaru(i, 501, f"S{i}", 1, usd * 4.0))
            prawda[i] = nr
            i += 1
    slady = {}
    p = dopasuj(o, towar, slady)
    assert slady["zachlannie"] is True
    zle = {k: (p[k], v) for k, v in prawda.items() if p[k] != v}
    assert not zle, zle

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


SAD_ZALADUNEK = """<?xml version="1.0" encoding="utf-8" ?>
<SADUE P22WalutaSADu="USD">
  <P1Kontekst DataDekl="2026-05-21"/>
  <P8Odbiorca><Firmy Nazwa="TESTOWA SP. Z O.O." NIP="0000000000"/></P8Odbiorca>
  <P22KursyWalut Waluta="USD" Kurs="4.0000" Mnoznik="1"/>
  <ZestawySADu P22WartoscZestawu="1000" P35BruttoZestawu="100" SumaClaZestawu="0">
    <StatusCelnyAIS MRNAIS="26PL00000000TEST33"/></ZestawySADu>
  <PozycjeSADu P35MasaBrutto="100" P38MasaNetto="90" P42WartoscPozycji="1000" P47WartCelna="4600">
    <P31ZnakiINumery OpisTowaru="POCHLANIACZ"><Opakowania RodzOpak="CT" LiczbaOpak="1"/>
      <Kontenery Numer="TEST8888888"/></P31ZnakiINumery>
    <P33KodTowaru KodCN="84213925"/>
    <P44DodInfo>
      <KorektyZrodlowe KodKorekty="031W" WalutaKorekty="USD" RozbijWg="2" WartKorekty="100"/>
      <KorektyZrodlowe KodKorekty="033W" WalutaKorekty="USD" RozbijWg="2" WartKorekty="50"/>
    </P44DodInfo>
    <P47Oplaty Typ="A00" Stawka="0" Kwota="0" MP="L"><Skladowe KwotaOplaty="0"/></P47Oplaty>
  </PozycjeSADu>
  <KorektyZbiorcze ID="1" KodKorekty="031W" WalutaKorekty="USD" RozbijWg="2" WartKorekty="100"/>
  <KorektyZbiorcze ID="2" KodKorekty="033W" WalutaKorekty="USD" RozbijWg="2" WartKorekty="50"/>
</SADUE>"""


def test_zaladunek_033w_wchodzi_do_wartosci_celnej():
    """Dongguan MEDU5327848: „Container FOB cost" poszedł jako 033W. Bez niego wartość
    celna pozycji się nie spinała i zapis był zablokowany."""
    o = parsuj(SAD_ZALADUNEK)
    d = {x.kod: x for x in o.doliczenia}
    assert d["033W"].do_wartosci_celnej
    assert all(k.ok for k in kontrole(o)), [k.nazwa for k in kontrole(o) if not k.ok]


def test_sku_bez_ceny_planowanej_sam_w_pozycji_dostaje_wartosc_z_sad():
    """ECSU3903241: szafka SZ1 z ceną planowaną 0 sama w pozycji dostawała 0 USD i błąd
    „ceny nie sumują się". Bez cen planowanych pozycja dzieli się po sztukach."""
    o = parsuj(SAD_KONSOLIDACJA)
    towar = [PozycjaTowaru(91, 501, "STOL", 100, 0.0, waga_brutto_kg=8.0)]
    r = policz(o, towar, [], klucz=KLUCZ_WAGA, przypisanie={91: 5})
    w = {x.item_id: x for x in r.pozycje}
    assert abs(w[91].cena_zakupu_waluta - 26.30) < 0.001
    assert not any(u.poziom == "blad" for u in r.uwagi), [u.tresc for u in r.uwagi]


def test_przeliczenie_zapisanej_odprawy_po_innym_kursie_rowna_sie_pelnemu_rachunkowi():
    """Przycisk „Przelicz po kursie z płatności” nie ma pliku XML — liczy z zapisanych kwot.
    Musi dać to samo, co pełny rachunek odpalony z nowym kursem towaru."""
    from services.odprawy import przelicz_po_kursie

    o = parsuj(SAD_XML)
    for klucz in (KLUCZ_WAGA, KLUCZ_CBM):
        stary = policz(o, TOWAR, KOSZTY, klucz=klucz, kurs_towaru=3.6894)
        nowy = {w.item_id: w for w in policz(o, TOWAR, KOSZTY, klucz=klucz, kurs_towaru=3.6255).pozycje}
        for w in stary.pozycje:
            # tak jak zapis w routers/odprawy.py: kwoty zaokrąglone do groszy
            zakup, koszt = przelicz_po_kursie(
                round(w.cena_zakupu_waluta, 4), w.ilosc, round(w.logistyka, 2), round(w.clo, 2),
                round(w.gratisy, 2), round(w.transport_krajowy, 2), 3.6255)
            assert abs(koszt - nowy[w.item_id].koszt_jednostkowy) <= 0.01, (klucz, w.sku)
            assert abs(zakup - nowy[w.item_id].towar / w.ilosc) <= 0.01, (klucz, w.sku)
