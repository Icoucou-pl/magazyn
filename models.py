"""
Modele Pydantic - współdzielone między routerami i serwisami.

Uwaga: w oryginalnym main.py kilka modeli user/auth było zdefiniowanych dwukrotnie;
Python używał późniejszej definicji. Tu zostają TYLKO efektywne wersje (te które realnie działały).
"""

from datetime import date, datetime
from typing import Any, List, Optional, Literal, Dict

from pydantic import BaseModel, Field, field_validator


# ===== TYPY =====
ContainerStatus = Literal["ORDERED", "IN_PRODUCTION", "IN_TRANSIT", "DELIVERED"]
ProductStatus = Literal["ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE", "SAMPLE"]
UserRole = Literal["ADMIN", "IMPORT", "VIEWER"]


# ===== AUTH / USERS =====
class CurrentUser(BaseModel):
    id: int
    email: str
    role: str
    full_name: Optional[str] = None
    perms: Optional[dict] = None            # override uprawnień per-user (None = domyślne z roli)
    # Zakres firmowy: lista slugów ('amh'/'acti'/'veluxa') albo None = wszystkie firmy.
    # To INNY wymiar niż `perms`: scope mówi CZYJE dane wolno oglądać, perms — CO wolno z nimi zrobić.
    company_scope: Optional[List[str]] = None


class UserCreate(BaseModel):
    email: str = Field(..., min_length=5, max_length=255)
    password: str = Field(..., min_length=8)
    full_name: str = Field(..., min_length=1, max_length=255)
    role: UserRole = "VIEWER"


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None
    perms: Optional[dict] = None            # override uprawnień per-user (None = nie zmieniaj)
    show_onboarding: Optional[bool] = None
    # None = nie zmieniaj; [] = wyczyść zakres (dostęp do wszystkich firm);
    # ['acti','veluxa'] = tylko te firmy.
    company_scope: Optional[List[str]] = None


class UsersBulkUpdate(BaseModel):
    """Zmiana masowa z panelu Użytkownicy. Każde pole None = nie zmieniaj.
    perms: klucz → True (nadaj) / False (odbierz) / None (usuń wyjątek, wróć do roli).
    Ruszane są TYLKO podane klucze — pozostałe wyjątki każdej osoby zostają."""
    user_ids: List[int] = Field(..., min_length=1, max_length=500)
    perms: Optional[Dict[str, Optional[bool]]] = None
    role: Optional[UserRole] = None
    is_active: Optional[bool] = None
    show_onboarding: Optional[bool] = None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)


class AdminPasswordReset(BaseModel):
    new_password: str = Field(..., min_length=8)


class OnboardingSet(BaseModel):
    show_onboarding: bool


class UserOut(BaseModel):
    id: int
    email: str
    full_name: Optional[str]
    role: str
    is_active: bool
    is_super_admin: bool = False  # tylko ten email widzi audit log
    perms: Optional[dict] = None  # override uprawnień (None = domyślne z roli)
    company_scope: Optional[List[str]] = None  # None = wszystkie firmy
    show_onboarding: bool = False
    created_at: datetime
    last_login: Optional[datetime]
    updated_at: Optional[datetime] = None
    last_activity: Optional[datetime] = None  # ostatnia zmiana dokonana przez usera (z audytu)


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class SessionOut(BaseModel):
    id: int
    device: Optional[str] = None
    ip: Optional[str] = None
    created_at: datetime
    current: bool = False


class AuditLogOut(BaseModel):
    id: int
    user_id: Optional[int]
    user_email: Optional[str]
    action: str
    resource_type: Optional[str]
    resource_id: Optional[str]
    details: Optional[str]
    created_at: datetime
    message: str = ""                       # gotowe zdanie („ania@x.pl zmieniła …”)
    changes: List[Dict[str, Any]] = []      # [{pole, bylo, jest}]
    area: str = "Inne"
    legacy: bool = False                    # wpis sprzed przebudowy — zdanie odtworzone przy odczycie


class AuditLogPage(BaseModel):
    rows: List[AuditLogOut]
    more: bool                              # czy jest co doczytać („Załaduj starsze”)
    users: List[str] = []                   # e-maile do filtra
    obszary: List[str] = []


# ===== PRODUKTY =====
class IncomingDelivery(BaseModel):
    container_id: int
    container_number: str
    eta_date: date
    quantity: int
    status: ContainerStatus                        # status surowy z bazy (dla zgodności)
    warehouse_delivery_date: date                  # data wejścia na magazyn: delivered_date / expected / ETA+odprawa
    date_source: str = "estimate"                  # skąd data: 'delivered' | 'expected' | 'estimate'
    effective_status: str = "ORDERED"              # status miękki (compute_effective_status) — do pilla w modalu
    wbite: bool = False                            # wbite do subiektowego „w drodze" (zielona kropka)
    is_consolidated: bool = False
    lot_order_number: Optional[str] = None         # nr PO lotu (skonsolidowane)
    container_order_number: Optional[str] = None   # nr PO kontenera (nieskonsolidowane) — zastępuje „Draft-…" w UI
    manufacturer_name: Optional[str] = None


class ProductSummary(BaseModel):
    sku: str
    name: str
    name_override_manual: Optional[str] = None  # ręczna nazwa (None = brak, nazwa jedzie z Subiektu/zamówień/SKU)
    stock: int
    stock_value: float
    purchase_price: float = 0  # cena zakupu efektywna (ręczna override, inaczej Subiekt)
    cena_zakupu_manual: Optional[float] = None  # ręczny override PLN netto (None = brak, jedzie z Subiektu)
    price_source: Optional[str] = None          # "manual" | "fakturownia" | "subiekt" — skąd realnie przyszła cena
    stock_in_transit: int
    stock_in_transit_wbite: int = 0          # zielone: wbite do subiektowego „w drodze"
    stock_in_transit_containers: int = 0     # czerwone: jeszcze w kontenerach (niewbite)
    nearest_delivery_date: Optional[date] = None
    nearest_delivery_source: Optional[str] = None   # 'delivered' | 'expected' | 'estimate'
    product_status: ProductStatus
    cbm_per_unit: float                     # CBM EFEKTYWNY (ręczny override albo policzony z wymiarów)
    cbm_manual: Optional[float] = None      # ręczne nadpisanie (None = brak, CBM leci z wymiarów)
    cbm_source: str = "none"                # "manual" | "dims" | "none" — czym podpisać wartość na froncie
    # Wymiary kartonu eksportowego (cm) i pakowanie
    dlugosc_cm: Optional[float] = None
    szerokosc_cm: Optional[float] = None
    wysokosc_cm: Optional[float] = None
    szt_w_kartonie: Optional[int] = None    # None = 1 (produkt pakowany pojedynczo)
    moq: Optional[int] = None               # minimalna ilość zamówienia — na razie informacyjnie
    zaokraglaj_karton: bool = False         # zaokrąglanie listy zakupów do pełnych kartonów — informacyjnie
    # Dane odprawy celnej. Waga brutto = z opakowaniem, na SZTUKĘ — tym kluczem agencja celna
    # rozbija fracht w SAD, więc to ona (nie netto) wchodzi do kosztu jednostkowego kontenera.
    # Kod CN wiąże SKU z pozycją zgłoszenia: raz potwierdzony, dopasowuje kolejne dostawy bez zgadywania.
    waga_brutto_kg: Optional[float] = None
    kod_cn: Optional[str] = None
    photo_id: Optional[int] = None          # zdjęcie główne; bajty pod /api/product-photos/{id}/{hash}/...
    photo_hash: Optional[str] = None
    manufacturer_id: Optional[int]
    manufacturer_name: Optional[str]
    manufacturer_color: Optional[str] = None
    firma_id: Optional[int] = None          # firma-właściciel magazynu źródłowego (NULL = AMH)
    firma_name: Optional[str] = None
    firma_color: Optional[str] = None
    firma_slug: str = "amh"               # slug właściciela (amh/acti/veluxa); brak przypisania = AMH
    # Tylko przy shop=auto: firma, w której backend FAKTYCZNIE znalazł produkt ("" = suma
    # wszystkich firm). Różna od firmy z atrybutów, gdy właściciel (np. Veluxa sprowadza)
    # nie ma tego towaru u siebie, bo stan i sprzedaż żyją w innej firmie (np. AMH).
    shop_resolved: Optional[str] = None
    seasonality_enabled: bool
    is_favorite: bool = False
    is_sample: bool = False            # etykieta: wszedł jako sampel. Status SAMPLE do wejścia do magazynu w drodze, potem NOWOŚĆ
    sample_stock: int = 0              # ręczny licznik sztuk — używany tylko gdy SKU nie ma innego źródła stanu
    first_arrival_date: Optional[date] = None  # sample: pierwsze wejście na magazyn główny (None = jeszcze nie dotarł)
    app_only: bool = False             # SKU w katalogu tylko dzięki etykiecie sample (brak w Subiekcie/Sellasiście)
    first_transit_date: Optional[date] = None  # sample: pierwsze pojawienie się w magazynie w drodze (start NOWOŚCI)
    is_new: bool = False               # sample w okresie NOWOŚCI (od magazynu w drodze do 6 mies. po dostawie)
    new_until: Optional[date] = None   # do kiedy trwa nowość (None = jeszcze płynie, termin liczony od dostawy)
    manual_new_until: Optional[date] = None  # nowość ustawiona ręcznie — tylko znacznik, bez wpływu na status
    ean: Optional[str] = None
    forced_status: Optional[str] = None  # gdy ustawione: produkt ma wymuszony status
    lead_time_days: int
    sales_1m: int
    sales_2m: int
    sales_3m: int
    sales_4m: int
    sales_yoy_30d: int
    sales_yoy_next_30d: int
    avg_monthly_weighted: float
    months_of_stock: float
    days_until_empty: int
    days_until_order: int
    empty_date: date
    order_date: date
    status: str
    no_reorder: bool = False                      # „nie dozamawiamy" — chowa z pożarów i całego flow zamawiania
    # Ile sztuk leży na magazynie głównym w Fakturowni, gdy sklep w ogóle nie zna
    # tego SKU (stan w aplikacji = 0). 0 = brak problemu. Wartość jest wyłącznie
    # informacyjna — nie wchodzi do prognoz ani statusów.
    stan_erp_niewystawione: int = 0
    transfer_source_shop: Optional[str] = None   # magazyn siostry mogący pokryć pożar (Acti/Veluxa)
    transfer_source_qty: int = 0                  # ile tam leży na stanie (0 = siostra pusta)
    transfer_source_transit: int = 0              # ile siostrze jedzie (jej „magazyn w drodze")
    transfer_state: Optional[str] = None          # PULL | PULL_PARTIAL | WAIT | ORDER (None = brak siostry)
    incoming_deliveries: List[IncomingDelivery] = []


class LeadTimeUpdate(BaseModel):
    lead_time_days: int = Field(..., ge=1, le=365)


class ProductAttrsUpdate(BaseModel):
    cbm_per_unit: Optional[float] = Field(None, ge=0)   # ręczne nadpisanie CBM; 0 = wyczyść (→ licz z wymiarów)
    dlugosc_cm: Optional[float] = Field(None, ge=0)     # <=0 = wyczyść
    szerokosc_cm: Optional[float] = Field(None, ge=0)
    wysokosc_cm: Optional[float] = Field(None, ge=0)
    szt_w_kartonie: Optional[int] = Field(None, ge=0)   # 0 = wyczyść (→ traktowane jak 1)
    moq: Optional[int] = Field(None, ge=0)              # 0 = wyczyść
    zaokraglaj_karton: Optional[bool] = None
    waga_brutto_kg: Optional[float] = Field(None, ge=0)  # waga brutto/szt w kg; <=0 = wyczyść
    kod_cn: Optional[str] = None                        # None = nie zmieniaj; "" = wyczyść; cyfry CN/TARIC
    manufacturer_id: Optional[int] = None
    firma_id: Optional[int] = None
    seasonality_enabled: Optional[bool] = None
    is_sample: Optional[bool] = None      # None = nie zmieniaj; True/False = ustaw etykietę sample
    sample_stock: Optional[int] = Field(None, ge=0)   # ręczny stan sampla
    ean: Optional[str] = None
    forced_status: Optional[str] = None  # "ACTIVE","ACTIVE_NO_STOCK","DEAD_STOCK","INACTIVE", lub None (auto)
    cena_zakupu: Optional[float] = None  # None = nie zmieniaj; <=0 = wyczyść override (→ Subiekt); >0 = ustaw. Wymaga viewFinancials.
    name_override: Optional[str] = None  # None = nie zmieniaj; "" = wyczyść (→ nazwa z Subiektu/zamówień); tekst = ustaw ręczną nazwę.


class ProductPhotoOut(BaseModel):
    """Metadane zdjęcia produktu. Bajty NIE są tu zwracane — front składa URL
    z id + content_hash i wstawia go w <img src>."""
    id: int
    sku: str
    sort_order: int
    content_hash: str
    content_type: str
    filename: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    thumb_bytes: int
    full_bytes: int
    uploaded_at: datetime
    uploaded_by: Optional[str] = None


class VatUpdate(BaseModel):
    """PUT /products/{sku}/vat — ręczna stawka VAT produktu. None = wróć do stawki automatycznej."""
    vat: Optional[Literal[23, 8, 5, 0]] = None


class VatOut(BaseModel):
    """Stawka VAT produktu: ręczna wygrywa, inaczej z ostatniej krajowej sprzedaży, inaczej 23%."""
    vat: float = 23
    zrodlo: str = "domyslna"                 # 'reczna' | 'sprzedaz' | 'domyslna'
    vat_auto: Optional[float] = None         # stawka z ostatniej sprzedaży (None = SKU się nie sprzedawał w PL)
    vat_manual: Optional[float] = None


class ManualNewUpdate(BaseModel):
    """PUT /products/{sku}/new-until — nowość ustawiona ręcznie.
    Data końca w przyszłości = ustaw / zmień; None = zdejmij."""
    until: Optional[date] = None


class SampleCreate(BaseModel):
    """Nowy sample — SKU, którego nie ma ani w Subiekcie, ani w Sellasiście.
    Tworzy wiersz w app_product_attrs z is_sample=TRUE; katalog (SALES_QUERY, pri 4)
    podnosi go wtedy do rangi normalnego produktu."""
    sku: str = Field(..., min_length=1, max_length=120)
    name: str = Field(..., min_length=1, max_length=255)
    manufacturer_id: Optional[int] = None
    firma_id: Optional[int] = None
    cbm_per_unit: float = Field(0, ge=0)
    cena_zakupu: Optional[float] = Field(None, ge=0)
    sample_stock: int = Field(0, ge=0)
    ean: Optional[str] = None


# ===== PRODUCENCI =====
class ManufacturerIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    color: str = "#6b7280"
    notes: Optional[str] = None
    email: Optional[str] = None
    contact: Optional[str] = None
    # Domyślna waluta rozliczeń z producentem (zaliczki/balance w kontenerze).
    # None = brak domyślnej. Dozwolone tylko waluty używane w kontenerach.
    default_currency: Optional[str] = None

    @field_validator("default_currency", mode="before")
    @classmethod
    def _norm_default_currency(cls, v):
        if v is None:
            return None
        s = str(v).strip().upper()
        if s == "":
            return None
        if s not in ("USD", "CNY", "PLN"):
            raise ValueError("default_currency musi być jednym z: USD, CNY, PLN")
        return s


class ManufacturerOut(ManufacturerIn):
    id: int
    sku_count: int = 0
    open_orders: int = 0


# ===== Chińskie SKU (mapowanie SKU → kod fabryczny, pod generator PO) =====
class CnSkuIn(BaseModel):
    sku: str = Field(..., min_length=1, max_length=120)
    cn_sku: str = Field(..., min_length=1, max_length=120)
    en_name: Optional[str] = Field(None, max_length=255)


class CnSkuBulkIn(BaseModel):
    rows: List[CnSkuIn] = Field(..., min_length=1, max_length=5000)


class CnSkuOut(BaseModel):
    id: int
    sku: str
    cn_sku: str
    en_name: Optional[str] = None
    product_name: Optional[str] = None
    manufacturer_id: Optional[int] = None
    manufacturer_name: Optional[str] = None
    manufacturer_color: Optional[str] = None


class CnSkuBulkResult(BaseModel):
    inserted: int = 0
    updated: int = 0


# ===== TYPY KONTENERÓW =====
class ContainerTypeIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    capacity_cbm: float = Field(..., gt=0)
    sort_order: int = 0


class ContainerTypeOut(ContainerTypeIn):
    id: int


# ===== PIENIĄDZE FIRMY (saldo konta + pożyczki wspólników) =====
# Oba byty są RĘCZNE i zawsze przypisane do jednej firmy (firma_slug: amh/acti/veluxa).
# Rozdzielone celowo: saldo to POMIAR stanu na dany dzień, pożyczka to ZDARZENIE.
class BankBalanceIn(BaseModel):
    firma_slug: str = Field(..., min_length=1, max_length=32)
    balance_date: date
    amount_pln: float
    note: Optional[str] = Field(None, max_length=500)

    @field_validator("firma_slug")
    @classmethod
    def _slug_lower(cls, v: str) -> str:
        return v.strip().lower()


class BankBalanceOut(BankBalanceIn):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class OwnerLoanIn(BaseModel):
    """Umowa pożyczki od wspólnika. Spłatę oznacza `splacono_data`, NIE kwota ujemna."""
    firma_slug: str = Field(..., min_length=1, max_length=32)
    loan_date: date                        # data wpłaty na konto firmy
    amount_pln: float
    partner: str = Field(..., min_length=1, max_length=120)
    numer_umowy: Optional[str] = Field(None, max_length=60)
    data_zawarcia: Optional[date] = None
    termin_splaty: Optional[date] = None
    oprocentowanie: Optional[str] = Field(None, max_length=120)   # tekst: „5,85%" albo „wibor3m+2% marża"
    splacono_data: Optional[date] = None                          # None = jeszcze do spłaty
    note: Optional[str] = Field(None, max_length=500)

    @field_validator("firma_slug")
    @classmethod
    def _slug_lower(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("partner")
    @classmethod
    def _partner_trim(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Podaj wspólnika")
        return v

    @field_validator("amount_pln")
    @classmethod
    def _not_zero(cls, v: float) -> float:
        if not v:
            raise ValueError("Kwota nie może być zerowa")
        return v


class OwnerLoanOut(OwnerLoanIn):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class MoneyBundle(BaseModel):
    """Wszystko, czego potrzebuje wykres i zakładka: obie listy + co user może zrobić."""
    shop: str
    balances: List[BankBalanceOut] = []
    loans: List[OwnerLoanOut] = []
    can_edit: bool = False


# ===== KONTENERY =====
class ContainerItemIn(BaseModel):
    sku: str
    quantity: int = Field(..., gt=0)
    unit_cost: Optional[float] = None
    cena_waluta: Optional[float] = Field(None, ge=0)   # cena w walucie dostawcy / szt (proforma, FV)
    lot_ref: Optional[int] = None   # indeks lotu w tablicy lots (przy skonsolidowanym kontenerze)


class ContainerAdvanceIn(BaseModel):
    """Pojedyncza zaliczka (rata). data = faktycznie zapłacono; puste = zaplanowana."""
    procent: Optional[float] = None
    kwota: Optional[float] = None
    waluta: Optional[str] = None
    termin: Optional[date] = None      # planowany termin płatności (deadline; niezależny od `data`)
    data: Optional[date] = None


class ContainerAdvanceOut(BaseModel):
    id: int
    procent: Optional[float] = None
    kwota: Optional[float] = None
    waluta: Optional[str] = "USD"
    termin: Optional[date] = None
    data: Optional[date] = None


class DokumentyIn(BaseModel):
    """Plakietka „dokumenty wysłane do agencji celnej" — True = wysłane, False = cofnij."""
    value: bool


class SubiektWbiteIn(BaseModel):
    """Przełącznik kropki „dodano do Subiektu". lot_id=None → dotyczy kontenera (nieskonsolidowany)."""
    value: bool
    lot_id: Optional[int] = None


class ContainerLotIn(BaseModel):
    manufacturer_id: Optional[int] = None
    order_number: Optional[str] = None
    mrn: Optional[str] = None                 # numer odprawy celnej tego lotu (kontener skonsolidowany)
    # płatności per lot; waluta osobno dla zaliczki i balance (USD/CNY/PLN)
    waluta_towaru: Optional[str] = None       # domyślna/pierwotna waluta (seed) — nie edytowana w UI
    # Wiele zaliczek (rat) — nowy model. Legacy pola zaliczka_* zostają jeszcze jeden
    # deploy dla bezpiecznego rollbacku; backend zapisuje 1. zaliczkę też do nich.
    advances: List[ContainerAdvanceIn] = []
    zaliczka_procent: Optional[float] = None
    zaliczka_kwota: Optional[float] = None
    zaliczka_waluta: Optional[str] = None
    zaliczka_data: Optional[date] = None
    balance_kwota: Optional[float] = None
    balance_waluta: Optional[str] = None
    balance_termin: Optional[date] = None     # planowany termin zapłaty balance
    zaplacono_data: Optional[date] = None


class ContainerCreate(BaseModel):
    container_number: Optional[str] = None   # puste = backend nada Draft-<Producent> (nr znamy po produkcji)
    carrier: Optional[str] = None            # armator (MSC/CMA/…) — źródło linku do śledzenia
    order_number: Optional[str] = None
    container_type_id: Optional[int] = None
    manufacturer_id: Optional[int] = None
    order_date: date
    eta_date: date
    expected_delivery_date: Optional[date] = None   # „u nas" — realna, umówiona data odbioru (nie domyka statusu)
    delivered_date: Optional[date] = None           # potwierdzone wejście na magazyn (kontener dodany wstecz)
    status: ContainerStatus = "ORDERED"
    notes: Optional[str] = None
    is_consolidated: bool = False
    # koszty spedycji + dokumenty (zawsze na kontenerze)
    koszt_transportu: Optional[float] = None            # USD
    koszt_spedycji: Optional[float] = None              # USD (cały rachunek)
    koszt_transportu_magazyn: Optional[float] = None    # PLN — z portu do magazynu
    folder: Optional[str] = None
    subiekt_nr: Optional[str] = None
    mrn: Optional[str] = None                           # odprawa celna — tylko kontener nieskonsolidowany
    # płatności dla kontenera nieskonsolidowanego (jeden dostawca)
    waluta_towaru: Optional[str] = None                 # domyślna/pierwotna waluta (seed)
    advances: List[ContainerAdvanceIn] = []             # wiele zaliczek (rat)
    zaliczka_procent: Optional[float] = None
    zaliczka_kwota: Optional[float] = None
    zaliczka_waluta: Optional[str] = None
    zaliczka_data: Optional[date] = None
    balance_kwota: Optional[float] = None
    balance_waluta: Optional[str] = None
    balance_termin: Optional[date] = None
    zaplacono_data: Optional[date] = None
    lots: List[ContainerLotIn] = []
    items: List[ContainerItemIn] = Field(..., min_length=1)


class ContainerUpdate(BaseModel):
    container_number: Optional[str] = None
    carrier: Optional[str] = None
    order_number: Optional[str] = None
    container_type_id: Optional[int] = None
    manufacturer_id: Optional[int] = None
    order_date: Optional[date] = None
    eta_date: Optional[date] = None
    status: Optional[ContainerStatus] = None
    notes: Optional[str] = None
    is_consolidated: Optional[bool] = None
    koszt_transportu: Optional[float] = None
    koszt_spedycji: Optional[float] = None
    koszt_transportu_magazyn: Optional[float] = None    # PLN — z portu do magazynu
    folder: Optional[str] = None
    subiekt_nr: Optional[str] = None
    mrn: Optional[str] = None                           # odprawa celna — tylko kontener nieskonsolidowany
    waluta_towaru: Optional[str] = None
    advances: Optional[List[ContainerAdvanceIn]] = None   # wiele zaliczek (rat); None = nie ruszaj
    zaliczka_procent: Optional[float] = None
    zaliczka_kwota: Optional[float] = None
    zaliczka_waluta: Optional[str] = None
    zaliczka_data: Optional[date] = None
    balance_kwota: Optional[float] = None
    balance_waluta: Optional[str] = None
    balance_termin: Optional[date] = None
    zaplacono_data: Optional[date] = None
    delivered_date: Optional[date] = None    # ręczna data dostawy na magazyn (domyka status)
    expected_delivery_date: Optional[date] = None   # „u nas" — umówiona data odbioru; NIE domyka statusu
    lots: Optional[List[ContainerLotIn]] = None
    items: Optional[List[ContainerItemIn]] = None


class ContainerItemOut(BaseModel):
    sku: str
    quantity: int
    unit_cost: Optional[float] = None
    cena_waluta: Optional[float] = None       # cena w walucie dostawcy / szt (None = nie wpisano)
    id: int
    lot_id: Optional[int] = None
    product_name: Optional[str] = None
    cbm_per_unit: float = 0
    total_cbm: float = 0


class ContainerLotOut(BaseModel):
    id: int
    manufacturer_id: Optional[int] = None
    manufacturer_name: Optional[str] = None
    manufacturer_color: Optional[str] = None
    order_number: Optional[str] = None
    mrn: Optional[str] = None                 # numer odprawy celnej tego lotu
    waluta_towaru: Optional[str] = "USD"
    advances: List[ContainerAdvanceOut] = []
    zaliczka_procent: Optional[float] = None
    zaliczka_kwota: Optional[float] = None
    zaliczka_waluta: Optional[str] = "USD"
    zaliczka_data: Optional[date] = None
    balance_kwota: Optional[float] = None
    balance_waluta: Optional[str] = "USD"
    balance_termin: Optional[date] = None
    zaplacono_data: Optional[date] = None
    subiekt_wbite: bool = False              # lot wbity do magazynu „w drodze" w Subiekcie
    subiekt_wbite_at: Optional[date] = None
    firma_breakdown: Dict[str, "ContainerFirmaShare"] = {}   # udział firm w tym locie (per SKU→firma)
    total_units: int = 0
    total_cbm: float = 0
    total_value: float = 0
    # Płatności przeliczone na PLN (kurs NBP z dnia poprzedzającego wpłatę).
    zaplacono_pln: float = 0.0    # faktycznie zapłacone (zaliczki z datą + balance z zaplacono_data)
    pozostalo_pln: float = 0.0    # wartość towaru − zapłacone, nie schodzi poniżej 0
    do_zaplacenia_pln: float = 0.0  # niezapłacone raty+balance (bez daty), kurs dzisiejszy — KPI „Do zapłacenia"
    brak_kursu: int = 0           # ile wpłat nie dało się przeliczyć (brak notowania NBP)


class AttachmentOut(BaseModel):
    id: int
    filename: str
    file_type: Optional[str]
    file_size: Optional[str]
    uploaded_at: datetime


class AttachmentCreate(BaseModel):
    filename: str
    file_type: Optional[str] = None
    file_size: Optional[str] = None


class ContainerFirmaShare(BaseModel):
    """Udział jednej firmy (sklepu) w kontenerze.

    Liczony z pozycji kontenera: container_items.sku -> product_attrs.firma_id -> firmy.slug.
    SKU bez firma_id trafia do AMH (NULL = AMH, zgodnie z ProductSummary.firma_id).
    Dzięki temu KPI "W drodze" i lista dostaw mogą być filtrowane per sklep bez
    dodatkowego zapytania — kontener fizycznie bywa mieszany (zwłaszcza skonsolidowany)."""
    slug: str
    name: Optional[str] = None
    color: Optional[str] = None
    items: int = 0          # ile pozycji (SKU) danej firmy
    units: int = 0          # ile sztuk
    value: float = 0.0      # wartość PLN tych pozycji


class ContainerOut(BaseModel):
    id: int
    container_number: str
    carrier: Optional[str] = None
    order_number: Optional[str] = None
    container_type_id: Optional[int]
    container_type_name: Optional[str]
    container_capacity_cbm: Optional[float]
    manufacturer_id: Optional[int]
    manufacturer_name: Optional[str]
    manufacturer_color: Optional[str] = None
    order_date: date
    eta_date: date
    status: ContainerStatus                 # status ręczny (zapisany w bazie)
    effective_status: str = "ORDERED"       # status wyświetlany: ręczny lub auto (CUSTOMS/DELIVERED) z ETA
    is_auto: bool = False                   # True gdy effective_status wynika z dat (odprawa celna / auto-dostawa)
    customs_days_left: Optional[int] = None # gdy w "Odprawa celna": ile dni do auto-dostawy
    is_consolidated: bool = False
    lots: List[ContainerLotOut] = []
    # koszty spedycji + dokumenty (kontener)
    koszt_transportu: Optional[float] = None
    koszt_spedycji: Optional[float] = None
    oplata_spedycji: Optional[float] = None            # = koszt_spedycji − koszt_transportu (liczone)
    koszt_transportu_magazyn: Optional[float] = None   # PLN — z portu do magazynu
    # Stan rozliczenia odprawy: "zapisana" | "szkic" | None. Zasila plakietkę na liście
    # kontenerów, żeby jednym spojrzeniem znaleźć te bez policzonego kosztu jednostkowego.
    koszt_status: Optional[str] = None
    folder: Optional[str] = None
    subiekt_nr: Optional[str] = None
    mrn: Optional[str] = None                          # odprawa celna (kontener nieskonsolidowany)
    # płatności kontenera nieskonsolidowanego (jeden dostawca)
    waluta_towaru: Optional[str] = "USD"
    advances: List[ContainerAdvanceOut] = []
    zaliczka_procent: Optional[float] = None
    zaliczka_kwota: Optional[float] = None
    zaliczka_waluta: Optional[str] = "USD"
    zaliczka_data: Optional[date] = None
    balance_kwota: Optional[float] = None
    balance_waluta: Optional[str] = "USD"
    balance_termin: Optional[date] = None
    zaplacono_data: Optional[date] = None
    subiekt_wbite: bool = False              # kontener (nieskonsolidowany) wbity do „w drodze" w Subiekcie
    subiekt_wbite_at: Optional[date] = None
    delivered_date: Optional[date] = None            # ręczna, potwierdzona data dostawy (jeśli jest)
    expected_delivery_date: Optional[date] = None    # „u nas" — umówiona data odbioru (przed potwierdzeniem)
    # Dokumenty do agencji celnej wysłane — klikalna plakietka na liście (kto i kiedy).
    dokumenty_wyslane: bool = False
    dokumenty_wyslane_at: Optional[datetime] = None
    dokumenty_wyslal: Optional[str] = None
    # Koszt jednostkowy (metoda szefa): 'policzony' | 'szacunek' | None (brak pozycji
    # albo brak uprawnienia „Koszt jednostkowy kontenera" — wtedy plakietki nie ma).
    koszt_v2: Optional[str] = None
    koszt_razem_z: List[str] = []   # wspólna faktura: kontenery rozliczane razem (etykiety) — jak koszt_v2
    # Płatności przeliczone na PLN (kurs NBP z dnia poprzedzającego wpłatę).
    zaplacono_pln: float = 0.0    # faktycznie zapłacone (zaliczki z datą + balance z zaplacono_data)
    pozostalo_pln: float = 0.0    # wartość towaru − zapłacone, nie schodzi poniżej 0
    do_zaplacenia_pln: float = 0.0  # niezapłacone raty+balance (bez daty), kurs dzisiejszy — KPI „Do zapłacenia"
    brak_kursu: int = 0           # ile wpłat nie dało się przeliczyć (brak notowania NBP)
    warehouse_delivery_date: Optional[date] = None   # KPI: delivered_date → expected_delivery_date → ETA + odprawa
    notes: Optional[str]
    items: List[ContainerItemOut]
    attachments: List[AttachmentOut] = []
    total_units: int
    total_cbm: float
    fill_percentage: Optional[float]
    total_value: float
    firma_breakdown: Dict[str, ContainerFirmaShare] = {}   # slug -> udział firmy w kontenerze


# ContainerLotOut.firma_breakdown używa forward-refa do ContainerFirmaShare (zdefiniowanej niżej).
ContainerLotOut.model_rebuild()


class TopSellerOut(BaseModel):
    """Top sprzedaży — TYLKO sztuki, zero pól finansowych.
    Dzięki temu karta jest widoczna dla wszystkich (nie wymaga viewFinancials)."""
    sku: str
    name: str
    status: str
    stock: int
    days_until_empty: int
    sales_1m: int              # sztuki sprzedane w ostatnich 30 dniach (wg wybranego sklepu)
    sales_yoy_30d: int         # te same 30 dni rok temu — do strzałki trendu
    avg_monthly: float
    manufacturer_name: Optional[str] = None
    manufacturer_color: Optional[str] = None


# ===== ANOMALIE / PROJEKCJE / IMPORT / LISTA ZAKUPÓW =====
class StockProjectionPoint(BaseModel):
    date: date
    stock: int
    event: Optional[str] = None


class SeasonPoint(BaseModel):
    """Punkt szeregu sezonowego dla jednego miesiąca.
    month: indeks 0-11 (0=styczeń) — zgodnie z frontendowym SeasonChart.
    qty: liczba sprzedanych sztuk.
    value_net / value_gross: przychód netto/brutto (qty × price_netto / price)
    z rzeczywistych cen sprzedaży w pozycjach zamówień."""
    year: int
    month: int
    qty: int
    value_net: float
    value_gross: float


class Anomaly(BaseModel):
    """Anomalia na dashboardzie.

    Typy sprzedażowe (spike/drop/stock_drain) używają pól sales_*/change_pct.
    Typ `wbite_shortfall` (niedobór w magazynie „w drodze" wobec zielonych kropek)
    ich nie ma — dlatego dostały wartości domyślne — a niesie własne pola opcjonalne.
    Front trzyma `type` jako luźny string i renderuje go generycznie, więc nowy typ
    nie wymaga zmian po tamtej stronie.
    """
    sku: str
    name: str
    severity: Literal["high", "medium", "low"]
    type: Literal["sales_spike", "sales_drop", "stock_drain", "wbite_shortfall",
                  "brak_w_sklepie"]
    message: str
    sales_1m: int = 0
    sales_3m_avg: float = 0.0
    change_pct: float = 0.0
    # --- tylko dla wbite_shortfall ---
    firma_slug: Optional[str] = None      # firma, której ERP nie pokrywa deklaracji
    expected_qty: Optional[int] = None    # ile powinno być wg zielonych kropek
    actual_qty: Optional[int] = None      # ile realnie jest w ERP tej firmy
    missing_qty: Optional[int] = None     # expected - actual
    containers: Optional[List[str]] = None  # kandydaci do sprawdzenia (najświeżej wbite)


class ImportRow(BaseModel):
    sku: str
    cbm: Optional[float] = None
    manufacturer_name: Optional[str] = None
    lead_time_days: Optional[int] = None
    seasonality_enabled: Optional[bool] = None
    cena_zakupu: Optional[float] = None  # ręczna cena zakupu (PLN netto); stosowana tylko z uprawnieniem viewFinancials


class ImportResult(BaseModel):
    total: int
    updated: int
    skipped: int
    errors: List[str] = []


class ShoppingListGroup(BaseModel):
    manufacturer_id: Optional[int]
    manufacturer_name: Optional[str]
    manufacturer_color: Optional[str]
    manufacturer_email: Optional[str]
    products: List[dict]
    total_skus: int


# ===== FIRMY (sklepy: AMH / Acti / Veluxa) =====
class FirmaOut(BaseModel):
    id: int
    slug: str
    name: str
    color: Optional[str] = None
    is_self: bool = False
    base_url: Optional[str] = None
    api_key_env: Optional[str] = None
    key_present: bool = False          # czy zmienna środowiskowa z kluczem jest ustawiona
    configured: bool = False           # gotowa do ingestu (hub AMH zawsze, reszta: base_url + klucz)
    sort_order: int = 0
    product_count: int = 0             # ile produktów ma przypisaną tę firmę macierzystą


class FirmaUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    base_url: Optional[str] = None
    sort_order: Optional[int] = None


class FirmaAssignRequest(BaseModel):
    manufacturer_id: int               # przypisz wszystkie produkty tego producenta do firmy


# ===== AUTO-SUGESTIA =====
class AutoSuggestRequest(BaseModel):
    manufacturer_id: int
    container_type_id: int
    months_horizon: int = Field(6, ge=1, le=24)


class AutoSuggestItem(BaseModel):
    sku: str
    name: str
    quantity: int
    unit_cost: float
    cbm_total: float
    is_partial: bool = False


class AutoSuggestResponse(BaseModel):
    items: List[AutoSuggestItem]
    total_cbm: float
    capacity_cbm: float
    fill_pct: float
    total_value: float
    total_units: int


# ===== PDF ZAMÓWIENIA =====
class OrderPdfRequest(BaseModel):
    manufacturer_id: int
    items: List[dict]  # [{sku, name, quantity, unit_cost}]
    notes: Optional[str] = None
    custom_order_number: Optional[str] = None


# ===== FINANSE =====
class FinanceKpi(BaseModel):
    """Zagregowane wskaźniki dla wybranego okresu (wszystko w PLN, po przewalutowaniu NBP).
    margin = revenue_net - cost (koszt = ilość × cena_zakupu_netto z Subiekta, bieżący).
    margin_pct = margin / revenue_net × 100 (0 gdy brak przychodu).
    aov_net = revenue_net / orders (średnia wartość zamówienia netto)."""
    revenue_net: float
    revenue_gross: float
    cost: float
    margin: float
    margin_pct: float
    orders: int
    units: int
    aov_net: float


class FinanceChannelRow(BaseModel):
    channel: str
    revenue_net: float
    revenue_gross: float
    cost: float
    margin: float
    margin_pct: float
    orders: int
    units: int
    share_pct: float  # udział w przychodzie netto


class FinanceMfrRow(BaseModel):
    manufacturer_id: Optional[int] = None
    name: str
    color: Optional[str] = None
    revenue_net: float
    cost: float
    margin: float
    margin_pct: float
    units: int


class FinanceMonthlyPoint(BaseModel):
    year: int
    month: int  # 0-11 (0 = styczeń) — zgodnie z frontem
    channel: str
    revenue_net: float


class FinanceOverview(BaseModel):
    period: str
    period_label: str
    date_from: date
    date_to: date
    currency: str = "PLN"
    kpi: FinanceKpi
    channels: List[FinanceChannelRow]
    manufacturers: List[FinanceMfrRow]
    monthly: List[FinanceMonthlyPoint]
    items_without_cost: int  # sztuki pozycji bez dopasowanego kosztu w Subiekcie (marża zawyżona dla nich)


# ===== FINANSE — KARTA PRODUKTU =====
class FinanceProductInfo(BaseModel):
    symbol: str
    name: Optional[str] = None
    manufacturer_id: Optional[int] = None
    manufacturer_name: Optional[str] = None
    manufacturer_color: Optional[str] = None
    ean: Optional[str] = None
    stock: int
    unit_cost: float                       # cena_zakupu_netto (bieżąca, PLN)
    cbm_per_unit: Optional[float] = None
    lead_time_days: Optional[int] = None


class FinanceProductKpi(BaseModel):
    revenue_net: float
    revenue_gross: float
    cost: float                            # sztuki × unit_cost
    margin: float
    margin_pct: float
    units: int
    orders: int
    avg_price_net: float                   # przychód netto / sztuki (efektywna cena jedn.)
    unit_cost: float
    unit_margin: float                     # avg_price_net − unit_cost


class FinanceProductRotation(BaseModel):
    days_in_period: int
    avg_daily_units: float
    avg_monthly_units: float
    days_of_cover: Optional[float] = None  # stock / avg_daily; None = brak sprzedaży w okresie
    stock: int


class FinanceProductChannelRow(BaseModel):
    # Czy TEN wiersz został pominięty w KPI tej konkretnej zakładki. Przesunięcie
    # wewnątrzgrupowe wypada wyłącznie na „wszyscy"; na zakładce spółki to jej realny
    # obrót i liczy się normalnie, więc flaga jest tam False mimo internal=True na FV.
    excluded_from_kpi: bool = False
    channel: str
    units: int
    revenue_net: float
    share_pct: float


class FinanceProductMonthly(BaseModel):
    year: int
    month: int  # 0-11
    units: int
    revenue_net: float


class FinanceProduct(BaseModel):
    period: str
    period_label: str
    date_from: date
    date_to: date
    currency: str = "PLN"
    info: FinanceProductInfo
    kpi: FinanceProductKpi
    rotation: FinanceProductRotation
    channels: List[FinanceProductChannelRow]
    monthly: List[FinanceProductMonthly]


# ── ASYSTENT AI ──────────────────────────────────────────────────────────────
class AssistantMessage(BaseModel):
    role: str                      # "user" lub "assistant"
    content: str


class AssistantChatRequest(BaseModel):
    messages: List[AssistantMessage]   # cała rozmowa (frontend dosyła historię)


class AssistantToolUsed(BaseModel):
    name: str
    args: dict = {}


class AssistantChatResponse(BaseModel):
    answer: str
    tools: List[AssistantToolUsed] = []   # które narzędzia odpalił model (do chipów w UI)

# ============================================================
# Odprawa celna — rozliczenie kosztu jednostkowego kontenera
# ============================================================
# Podgląd NIC nie zapisuje: parsuje plik, dopasowuje pozycje i liczy koszt.
# Zapis dostaje TEN SAM plik jeszcze raz (multipart) plus ustawienia — dzięki temu
# backend jest bezstanowy, a sam XML i tak nigdy nie ląduje w bazie ani w załącznikach.


class OdprawaLiniaKosztuIn(BaseModel):
    """Linia z faktury spedytora albo transport krajowy (wtedy z container_id i w PLN)."""
    lp: Optional[int] = None
    nazwa: str
    kwota: float = 0
    waluta: str = "USD"
    klucz: str = "fizyczny"            # "fizyczny" (waga/CBM) | "wartosc"
    container_id: Optional[int] = None


class OdprawaUstawieniaIn(BaseModel):
    klucz_podzialu: str = "waga"       # "waga" | "cbm"
    kurs_towaru: Optional[float] = None
    kurs_kosztow: Optional[float] = None
    fv_spedytora: Optional[str] = None
    fv_spedytora_data: Optional[date] = None
    koszty: List[OdprawaLiniaKosztuIn] = []
    # item_id → nr pozycji SAD; puste = zostaw dopasowanie automatyczne
    przypisanie: Dict[int, int] = {}
    # nr pozycji SAD bez towaru → item_id, który przejmuje jej cło i logistykę
    gratisy: Dict[int, int] = {}
    # item_id → cena na sztukę w walucie odprawy (z faktury dostawcy, przy pozycjach mieszanych)
    ceny_reczne: Dict[int, float] = {}
    # Kontener skonsolidowany: id lotów objętych TYM zgłoszeniem. None = wybór automatyczny
    # (loty innej spółki, z innym MRN albo rozliczone inną odprawą odpadają same).
    loty: Optional[List[int]] = None
    # Importer w SAD celowo inny niż firma towaru (np. AMH zapłaciło za towar Acti).
    # Bez tej zgody odprawa zatrzymuje się na bramce „importer ≠ firma towaru".
    inny_importer: bool = False


class OdprawaKontrolaOut(BaseModel):
    nazwa: str
    ok: bool
    wyliczone: float
    z_pliku: float


class OdprawaUwagaOut(BaseModel):
    poziom: str                        # "blad" | "ostrzezenie" | "info"
    tresc: str
    szczegol: str = ""


class OdprawaPozycjaOut(BaseModel):
    nr: int
    kod_cn: Optional[str] = None
    opis: str = ""
    wartosc: float
    masa_brutto: float
    clo_stawka: float
    clo_pln: float
    vat_stawka: float
    vat_metoda: Optional[str] = None
    liczba_opakowan: Optional[int] = None
    szt_uzup: Optional[float] = None
    kontenery: List[str] = []
    item_ids: List[int] = []           # pozycje kontenera przypisane do tej pozycji SAD
    faktury: List[str] = []            # faktury dostawcy podane w tej pozycji (N935)
    gratis_item_id: Optional[int] = None


class OdprawaTowarOut(BaseModel):
    item_id: int
    container_id: int
    container_number: str
    sku: str
    ilosc: int
    cena_planowana: float
    cena_zakupu_waluta: float
    towar: float
    logistyka: float
    clo: float
    gratisy: float
    transport_krajowy: float
    koszt_jednostkowy: float
    zmiana_proc: Optional[float] = None
    szacunek: bool = False
    reczna: bool = False
    poz_sad: Optional[int] = None
    # Bieżący koszt zakupu w ERP importera (Subiekt dla AMH, Fakturownia dla Acti/Veluxy).
    koszt_erp: Optional[float] = None
    # Kontrola: koszt tej pozycji liczony nową metodą (karta kontenera + płatności, bez SAD).
    koszt_nowa_metoda: Optional[float] = None


class OdprawaZapisOut(BaseModel):
    """Co zmienił zapis — to samo, co pokazuje zakładka po kliknięciu „Zapisz"."""
    odprawa_id: int
    pozycji_z_kosztem: int
    mrn_uzupelniony: List[str] = []
    kontenery_zaktualizowane: List[str] = []
    produkty_waga: List[str] = []
    produkty_kod_cn: List[str] = []


class OdprawaLotOut(BaseModel):
    """Lot kontenera skonsolidowanego widziany z odprawy: czy ją obejmuje i dlaczego."""
    lot_id: int
    container_id: int
    dostawca: Optional[str] = None
    zamowienie: Optional[str] = None
    mrn: Optional[str] = None
    firma: Optional[str] = None
    sku: List[str] = []
    sztuk: int = 0
    wybrany: bool = False
    blokada: bool = False            # nie może wejść do tej odprawy (inna spółka, inny MRN, inna odprawa)
    faktura: Optional[str] = None    # faktura dostawcy ze zgłoszenia, którą przypisaliśmy lotowi
    dopasowanie: Optional[str] = None  # "numer" | "wartosc" — skąd wiemy, że to ta faktura
    powod: str = ""
    odprawa_id: Optional[int] = None   # odprawa, która już rozliczyła towar tego lotu
    odprawa_mrn: Optional[str] = None


class OdprawaKontenerOut(BaseModel):
    """Jedna z odpraw kontenera — do paska przełączania na karcie."""
    id: int
    mrn: str
    data_zgloszenia: Optional[date] = None
    importer: Optional[str] = None
    status: str = "zapisana"
    pozycji: int = 0


class OdprawaZapisaneOut(BaseModel):
    """Co dla tego MRN leży już w bazie — front wypełnia tym pola po ponownym wczytaniu.

    Bez tego dołożenie faktury spedytora kilka dni po odprawie znaczyło przepisywanie
    od nowa wszystkich cen z faktury dostawcy, bo podgląd jest bezstanowy i nic o
    poprzednim zapisie nie wiedział.
    """
    odprawa_id: int
    status: str = "szkic"
    klucz_podzialu: Optional[str] = None
    kurs_towaru: Optional[float] = None
    kurs_kosztow: Optional[float] = None
    fv_spedytora: Optional[str] = None
    fv_spedytora_data: Optional[date] = None
    koszty: List[OdprawaLiniaKosztuIn] = []
    # Tylko ceny WPISANE RĘCZNIE — wyliczonych proporcją nie przywracamy, bo mają się
    # przeliczyć na nowo, gdyby zmieniło się przypisanie pozycji.
    ceny_reczne: Dict[int, float] = {}
    przypisanie: Dict[int, int] = {}


class OdprawaOut(BaseModel):
    mrn: Optional[str] = None
    data_zgloszenia: Optional[date] = None
    dostawca: Optional[str] = None
    importer: Optional[str] = None
    nip_importera: Optional[str] = None
    firma_slug: Optional[str] = None
    incoterms: Optional[str] = None
    waluta: str = "USD"
    kurs_celny: float = 0
    kursy: Dict[str, float] = {}
    wartosc_faktur: float = 0
    masa_brutto: float = 0
    clo_suma: float = 0
    vat_suma: float = 0
    faktury_dostawcy: List[str] = []
    kontenery: List[str] = []
    kontenery_w_aplikacji: List[int] = []
    doliczenia: List[Dict[str, Any]] = []
    pozycje: List[OdprawaPozycjaOut] = []
    towar: List[OdprawaTowarOut] = []
    koszty: List[OdprawaLiniaKosztuIn] = []
    kontrole: List[OdprawaKontrolaOut] = []
    uwagi: List[OdprawaUwagaOut] = []
    klucz_podzialu: str = "waga"
    # Ustawienia rachunku odtworzone z zapisu — front wypełnia nimi pola nagłówka faktury
    # po odświeżeniu zakładki, żeby nie trzeba było wpisywać ich drugi raz.
    kurs_towaru: Optional[float] = None
    # Kurs ważony z płatności (NBP z dni zapłaty zaliczek i balance) — ten sam co w zakładce
    # „Koszt jednostkowy". Domyślny kurs towaru, gdy pole jest puste.
    kurs_platnosci: Optional[float] = None
    kurs_platnosci_szacunek: bool = False
    kurs_kosztow: Optional[float] = None
    fv_spedytora: Optional[str] = None
    fv_spedytora_data: Optional[date] = None
    suma_towar: float = 0
    suma_logistyka: float = 0
    suma_clo: float = 0
    narzut_proc: Optional[float] = None
    mozna_zapisac: bool = False
    zapisane: Optional[OdprawaZapisaneOut] = None
    zrodlo_erp: Optional[str] = None     # "subiekt" | "fakturownia" — skąd koszt_erp
    odprawa_id: Optional[int] = None
    # Kontener skonsolidowany: loty i to, czy ta odprawa je obejmuje. Pusta lista = zwykły kontener.
    loty: List[OdprawaLotOut] = []
    # Wszystkie odprawy otwartego kontenera — pasek przełączania na karcie.
    odprawy_kontenera: List[OdprawaKontenerOut] = []
    status: str = "podglad"            # "podglad" | "szkic" | "zapisana"
    zapis: Optional[OdprawaZapisOut] = None


# ===== ZAKŁADKA „CENA" NA KARCIE PRODUKTU =====
# Koszt zakupu z kontenerów (landed cost / szacunek), rozkład stanu na dostawy
# i zapisane sugerowane ceny sprzedaży. Logika: services/cena.py, endpointy: routers/cena.py.

class CenaDostawaOut(BaseModel):
    item_id: int
    container_id: int
    container_number: str
    order_number: Optional[str] = None        # PO kontenera — front składa z niego adres karty
    lot_order_number: Optional[str] = None
    manufacturer_name: Optional[str] = None
    data: Optional[date] = None               # wejście na magazyn
    data_zrodlo: str = "estimate"             # 'delivered' | 'expected' | 'estimate'
    status: str = "w_drodze"                  # 'u_nas' | 'w_drodze'
    szt: int
    na_stanie: int = 0
    cena_fv_pln: Optional[float] = None
    cena_fv_waluta: Optional[float] = None
    waluta: Optional[str] = None
    koszt: Optional[float] = None             # koszt / szt: landed cost albo szacunek
    szacunek: bool = False
    narzut_proc: Optional[float] = None       # koszt ÷ cena z FV − 1
    rozliczenie: str = "brak"                 # 'odprawa' | 'krajowa' | 'brak'
    odstaje: bool = False                     # narzut daleko od pozostałych dostaw — sprawdzić kontener
    fifo: bool = False


class CenaZapisanaOut(BaseModel):
    kanal: str                                # 'sklepy' | 'dropy'
    baza: str                                 # 'fifo' | 'srednia' | 'ostatnia' | 'reczna'
    koszt_bazy: float
    tryb: str                                 # 'marza' | 'narzut'
    procent: float
    wysylka: float = 0
    prowizja: float = 0
    vat: float = 23
    cena_netto: float
    cena_brutto: float
    shop: Optional[str] = None
    zapisal: Optional[str] = None
    zapisano: Optional[datetime] = None


class CenaZapisIn(BaseModel):
    kanal: Literal["sklepy", "dropy"]
    baza: Literal["fifo", "srednia", "ostatnia", "reczna"]
    koszt_bazy: float = Field(..., gt=0)
    tryb: Literal["marza", "narzut"]
    procent: float = Field(..., ge=0, lt=1000)
    wysylka: float = Field(0, ge=0)
    prowizja: float = Field(0, ge=0, lt=100)
    vat: float = Field(23, ge=0, le=100)
    shop: Optional[str] = None


class CenaListaPozycja(BaseModel):
    """Lista „Produkty": VAT i koszt z kontenerów jednego SKU (dokładane do tabeli po SKU)."""
    sku: str
    vat: float
    fifo: Optional[float] = None
    srednia: Optional[float] = None


class KosztNaglowekOut(BaseModel):
    """Nagłówek i „Dane podstawowe" karty: FIFO i średnia ważona z kontenerów + cena z ERP."""
    fifo: Optional[float] = None
    srednia: Optional[float] = None
    erp_cena: Optional[float] = None
    erp_zrodlo: Optional[str] = None          # 'subiekt' | 'fakturownia'


class CenaProduktuOut(BaseModel):
    sku: str
    shop: str = ""
    stan: int = 0                             # magazyn główny + wbite do „w drodze"
    poza_dostawami: int = 0
    # Koszt z ERP do porównania: Subiekt (AMH — FV + Lenmar, bez SAD) albo Fakturownia (goła FV).
    erp_zrodlo: Optional[str] = None          # 'subiekt' | 'fakturownia'
    erp_cena: Optional[float] = None
    fifo: Optional[float] = None
    fifo_item_id: Optional[int] = None
    srednia: Optional[float] = None
    srednia_szt: int = 0
    srednia_pominieto_szt: int = 0     # sztuki z partii bez SAD, pominięte w średniej
    ostatnia: Optional[float] = None
    ostatnia_item_id: Optional[int] = None
    min: Optional[float] = None
    min_item_id: Optional[int] = None
    max: Optional[float] = None
    max_item_id: Optional[int] = None
    sredni_narzut_proc: Optional[float] = None
    narzut_zrodlo: Optional[str] = None       # 'sku' | 'wszystkie'
    dostawy: List[CenaDostawaOut] = []
    zapisane: List[CenaZapisanaOut] = []
    uwagi: List[str] = []
    moze_zapisac: bool = False
    # Stawka VAT produktu do kalkulatora (ręczna z zakładki Dane wygrywa nad automatyczną).
    vat: float = 23
    vat_zrodlo: str = "domyslna"             # 'reczna' | 'sprzedaz' | 'domyslna'


# ===== KOSZT JEDNOSTKOWY v2 („metoda szefa”) =====
class KontenerKrotkoOut(BaseModel):
    id: int
    etykieta: str
    dostawca: Optional[str] = None
    eta: Optional[date] = None


class RozliczenieRazemOut(BaseModel):
    """Kontenery rozliczane wspólnie z tym (jedna faktura dostawcy) + podpowiedzi do wyboru."""
    polaczone: List[KontenerKrotkoOut] = []
    kandydaci: List[KontenerKrotkoOut] = []


class RozliczenieRazemIn(BaseModel):
    kontenery: List[int] = []                 # pusta lista = rozliczaj sam


class KosztPlatnoscOut(BaseModel):
    typ: str                                  # 'zaliczka' | 'balance'
    kwota: float
    waluta: str
    data: Optional[date] = None               # data zapłaty (None = niezapłacona)
    kurs: Optional[float] = None              # NBP z dnia roboczego przed zapłatą
    data_kursu: Optional[date] = None


class KosztGrupaOut(BaseModel):
    """Lot (kontener skonsolidowany) albo cały kontener (id 0)."""
    id: int
    nazwa: str = ""
    krajowa: bool = False
    waluta: str
    kurs: Optional[float] = None
    kurs_auto: Optional[float] = None
    kurs_reczny: bool = False
    szacunek: bool = False
    wartosc_waluta: float = 0.0
    wartosc_zrodlo: str = "platnosci"         # 'platnosci' | 'plan' | 'faktura'
    platnosci: List[KosztPlatnoscOut] = []


class KosztPozycjaOut(BaseModel):
    item_id: int
    sku: str
    nazwa: Optional[str] = None
    szt: int
    grupa: int = 0
    krajowa: bool = False
    cbm_szt: float = 0.0
    cena_planowana: float = 0.0               # unit_cost z pozycji (PLN)
    cena_waluta: float = 0.0                  # wartość w walucie / szt (krajowa: PLN)
    cena_reczna: bool = False
    cena_zrodlo: str = "auto"                 # 'reczna' | 'kontener' (z pozycji kontenera) | 'auto'
    towar: float = 0.0
    gratisy: float = 0.0                      # udział w różnicy płatności (gratisy z faktury / rabat)
    gratis_przypiety: bool = False
    fracht: float = 0.0
    lenmar: float = 0.0
    clo: float = 0.0
    transport: float = 0.0
    kod_cn: Optional[str] = None
    stawka: float = 0.0
    stawka_zrodlo: str = "brak"               # 'slownik' | 'reczna' | 'brak' | 'krajowa'
    stawka_slownik: Optional[float] = None
    koszt_jednostkowy: Optional[float] = None
    szacunek: bool = False
    koszt_erp: Optional[float] = None
    erp_zrodlo: Optional[str] = None          # 'subiekt' | 'fakturownia'


class KosztUwagaOut(BaseModel):
    poziom: str
    tresc: str


class KosztKontenerOut(BaseModel):
    container_id: int
    krajowa: bool = False
    szacunek: bool = False
    podzial: str = "cbm"                      # 'cbm' | 'wartosc'
    zgloszen: int = 0
    towar: float = 0.0
    gratisy: float = 0.0                      # różnica płatności vs ceny pozycji, rozłożona na towar
    fracht: float = 0.0
    fracht_auto: float = 0.0
    fracht_usd: float = 0.0
    kurs_frachtu: Optional[float] = None
    data_kursu_frachtu: Optional[date] = None
    data_frachtu: Optional[date] = None       # dostawa albo ETA
    lenmar: float = 0.0
    lenmar_auto: float = 0.0
    clo: float = 0.0
    transport: float = 0.0
    transport_auto: float = 0.0
    suma: float = 0.0
    narzut_proc: Optional[float] = None
    # ręczne poprawki (None = automat)
    kurs_towaru_reczny: Optional[float] = None
    fracht_reczny: Optional[float] = None
    lenmar_reczny: Optional[float] = None
    transport_reczny: Optional[float] = None
    lenmar_kontener: float = 0.0              # stałe ryczałtu — do opisu „1 600 + 600 × …”
    lenmar_zgloszenie: float = 0.0
    grupy: List[KosztGrupaOut] = []
    razem_z: List[KontenerKrotkoOut] = []     # wspólna faktura: płatności liczone razem z tymi kontenerami
    pozycje: List[KosztPozycjaOut] = []
    uwagi: List[KosztUwagaOut] = []
    zapisal: Optional[str] = None
    zapisano: Optional[datetime] = None
    moze_edytowac: bool = False
    # notatka do rachunku (np. skąd różnica płatności) — wpisuje człowiek, nie liczy automat
    notatka: Optional[str] = None
    notatka_kto: Optional[str] = None
    notatka_kiedy: Optional[datetime] = None


class KosztNotatkaIn(BaseModel):
    notatka: Optional[str] = Field(None, max_length=4000)   # pusto / null = usuń notatkę


class KosztPozycjaIn(BaseModel):
    item_id: int
    cena_waluta: Optional[float] = Field(None, ge=0)
    stawka_cla: Optional[float] = Field(None, ge=0, le=100)
    gratis: bool = False                      # ta pozycja przejmuje całą różnicę płatności (gratisy)


class KosztKontenerIn(BaseModel):
    """Same ręczne poprawki. null = wróć do wartości automatycznej."""
    kurs_towaru: Optional[float] = Field(None, gt=0)
    fracht_pln: Optional[float] = Field(None, ge=0)
    lenmar_pln: Optional[float] = Field(None, ge=0)
    transport_pln: Optional[float] = Field(None, ge=0)
    pozycje: List[KosztPozycjaIn] = []


class StawkaCnOut(BaseModel):
    """Wiersz listy Ustawienia → Stawki cła: SKU z kodem CN i stawką ze słownika."""
    sku: str
    nazwa: Optional[str] = None
    firma: Optional[str] = None
    obserwowany: bool = False
    nowosc: bool = False
    sample: bool = False
    kod_cn: Optional[str] = None
    stawka: Optional[float] = None
    zrodlo: Optional[str] = None              # 'sad' | 'reczna' | None (brak w słowniku)


class StawkaCnIn(BaseModel):
    stawka: float = Field(..., ge=0, le=100)


class KursTowaruIn(BaseModel):
    """Przeliczenie zapisanej odprawy po innym kursie towaru. None = kurs z płatności."""
    kurs: Optional[float] = Field(None, gt=0)


class KursOut(BaseModel):
    """Ostatni kurs średni NBP — formularz kontenera przelicza nim cenę USD na PLN."""
    waluta: str
    kurs: Optional[float] = None
    data: Optional[date] = None


class KodCnIn(BaseModel):
    kod_cn: Optional[str] = None              # puste = usuń kod
