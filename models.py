"""
Modele Pydantic - współdzielone między routerami i serwisami.

Uwaga: w oryginalnym main.py kilka modeli user/auth było zdefiniowanych dwukrotnie;
Python używał późniejszej definicji. Tu zostają TYLKO efektywne wersje (te które realnie działały).
"""

from datetime import date, datetime
from typing import List, Optional, Literal

from pydantic import BaseModel, Field


# ===== TYPY =====
ContainerStatus = Literal["ORDERED", "IN_PRODUCTION", "IN_TRANSIT", "DELIVERED"]
ProductStatus = Literal["ACTIVE", "ACTIVE_NO_STOCK", "DEAD_STOCK", "INACTIVE"]
UserRole = Literal["ADMIN", "IMPORT", "VIEWER"]


# ===== AUTH / USERS =====
class CurrentUser(BaseModel):
    id: int
    email: str
    role: str
    full_name: Optional[str] = None
    perms: Optional[dict] = None            # override uprawnień per-user (None = domyślne z roli)


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


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)


class AdminPasswordReset(BaseModel):
    new_password: str = Field(..., min_length=8)


class UserOut(BaseModel):
    id: int
    email: str
    full_name: Optional[str]
    role: str
    is_active: bool
    is_super_admin: bool = False  # tylko ten email widzi audit log
    perms: Optional[dict] = None  # override uprawnień (None = domyślne z roli)
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


# ===== PRODUKTY =====
class IncomingDelivery(BaseModel):
    container_id: int
    container_number: str
    eta_date: date
    quantity: int
    status: ContainerStatus


class ProductSummary(BaseModel):
    sku: str
    name: str
    stock: int
    stock_value: float
    purchase_price: float = 0  # cena zakupu z Subiekta
    stock_in_transit: int
    product_status: ProductStatus
    cbm_per_unit: float
    manufacturer_id: Optional[int]
    manufacturer_name: Optional[str]
    manufacturer_color: Optional[str] = None
    seasonality_enabled: bool
    is_favorite: bool = False
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
    incoming_deliveries: List[IncomingDelivery] = []


class LeadTimeUpdate(BaseModel):
    lead_time_days: int = Field(..., ge=1, le=365)


class ProductAttrsUpdate(BaseModel):
    cbm_per_unit: Optional[float] = Field(None, ge=0)
    manufacturer_id: Optional[int] = None
    seasonality_enabled: Optional[bool] = None
    ean: Optional[str] = None
    forced_status: Optional[str] = None  # "ACTIVE","ACTIVE_NO_STOCK","DEAD_STOCK","INACTIVE", lub None (auto)


# ===== PRODUCENCI =====
class ManufacturerIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    color: str = "#6b7280"
    notes: Optional[str] = None
    email: Optional[str] = None
    contact: Optional[str] = None


class ManufacturerOut(ManufacturerIn):
    id: int
    sku_count: int = 0
    open_orders: int = 0


# ===== TYPY KONTENERÓW =====
class ContainerTypeIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    capacity_cbm: float = Field(..., gt=0)
    sort_order: int = 0


class ContainerTypeOut(ContainerTypeIn):
    id: int


# ===== KONTENERY =====
class ContainerItemIn(BaseModel):
    sku: str
    quantity: int = Field(..., gt=0)
    unit_cost: Optional[float] = None
    lot_ref: Optional[int] = None   # indeks lotu w tablicy lots (przy skonsolidowanym kontenerze)


class ContainerLotIn(BaseModel):
    manufacturer_id: Optional[int] = None
    order_number: Optional[str] = None


class ContainerCreate(BaseModel):
    container_number: str
    order_number: Optional[str] = None
    container_type_id: Optional[int] = None
    manufacturer_id: Optional[int] = None
    order_date: date
    eta_date: date
    status: ContainerStatus = "ORDERED"
    notes: Optional[str] = None
    is_consolidated: bool = False
    lots: List[ContainerLotIn] = []
    items: List[ContainerItemIn] = Field(..., min_length=1)


class ContainerUpdate(BaseModel):
    container_number: Optional[str] = None
    order_number: Optional[str] = None
    container_type_id: Optional[int] = None
    manufacturer_id: Optional[int] = None
    order_date: Optional[date] = None
    eta_date: Optional[date] = None
    status: Optional[ContainerStatus] = None
    notes: Optional[str] = None
    is_consolidated: Optional[bool] = None
    lots: Optional[List[ContainerLotIn]] = None
    items: Optional[List[ContainerItemIn]] = None


class ContainerItemOut(BaseModel):
    sku: str
    quantity: int
    unit_cost: Optional[float] = None
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
    total_units: int = 0
    total_cbm: float = 0
    total_value: float = 0


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


class ContainerOut(BaseModel):
    id: int
    container_number: str
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
    notes: Optional[str]
    items: List[ContainerItemOut]
    attachments: List[AttachmentOut] = []
    total_units: int
    total_cbm: float
    fill_percentage: Optional[float]
    total_value: float


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
    sku: str
    name: str
    severity: Literal["high", "medium", "low"]
    type: Literal["sales_spike", "sales_drop", "stock_drain"]
    message: str
    sales_1m: int
    sales_3m_avg: float
    change_pct: float


class ImportRow(BaseModel):
    sku: str
    cbm: Optional[float] = None
    manufacturer_name: Optional[str] = None
    lead_time_days: Optional[int] = None
    seasonality_enabled: Optional[bool] = None


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
