"""
Teksty dziennika audytu: obszary, zdania ze ścieżki żądania, formatery wartości
i odtwarzanie zdań dla wpisów sprzed przebudowy dziennika (bez kolumny message).

Bez importów z audit.py — moduł jest czysty (łatwy do testowania).
"""

import ast
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Callable, List, Optional

# ============================================================
# Obszary (filtr w Ustawieniach → Dziennik audytu)
# ============================================================
OBSZARY = ["Produkty", "Ceny", "Kontenery", "Odprawy", "Producenci", "Firmy",
           "Użytkownicy", "Logowania", "Finanse", "Ustawienia", "Dropy", "Inne"]


def plural(n: int, one: str, few: str, many: str) -> str:
    if n == 1:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


# ============================================================
# Formatery wartości do „było → jest”
# ============================================================
PUSTE = "—"


def f_txt(v) -> str:
    if v is None:
        return PUSTE
    s = str(v).strip()
    return s or PUSTE


def _liczba(v: float, prec: int) -> str:
    s = f"{v:,.{prec}f}".replace(",", " ").replace(".", ",")
    if prec and "," in s:
        s = s.rstrip("0").rstrip(",")
    return s


def f_num(jednostka: str = "", prec: int = 2) -> Callable:
    """Liczba bez zbędnych zer: 180.0 → '180 cm', 0.406 → '0,406 kg'."""
    def fmt(v) -> str:
        if v is None or v == "":
            return PUSTE
        s = _liczba(float(v), prec)
        if jednostka == "%":
            return f"{s}%"
        return f"{s} {jednostka}".strip()
    return fmt


def f_kwota(waluta: str = "zł") -> Callable:
    def fmt(v) -> str:
        if v is None or v == "":
            return PUSTE
        s = f"{float(v):,.2f}".replace(",", " ").replace(".", ",")
        return f"{s} {waluta}"
    return fmt


f_zl = f_kwota("zł")
f_proc = f_num("%", 2)


def f_data(v) -> str:
    if v is None or v == "":
        return PUSTE
    if isinstance(v, str):
        try:
            v = date.fromisoformat(v[:10])
        except ValueError:
            return v
    if isinstance(v, datetime):
        v = v.date()
    return v.strftime("%d.%m.%Y")


def f_bool(v) -> str:
    return "tak" if v else "nie"


def f_map(mapa: dict) -> Callable:
    return lambda v: mapa.get(v, f_txt(v)) if v is not None else PUSTE


STATUSY_KONTENERA = {"ORDERED": "zamówiony", "IN_PRODUCTION": "w produkcji",
                     "IN_TRANSIT": "w drodze", "DELIVERED": "dostarczony"}
f_status = f_map(STATUSY_KONTENERA)

STATUSY_PRODUKTU = {None: "auto", "ACTIVE": "aktywny", "ACTIVE_NO_STOCK": "aktywny bez stanu",
                    "DEAD_STOCK": "martwy stan", "INACTIVE": "nieaktywny"}


def f_status_produktu(v) -> str:
    return STATUSY_PRODUKTU.get(v, f_txt(v))


def _robocze(nr) -> bool:
    return bool(nr) and str(nr).strip().lower().startswith("draft-")


def f_nr_kontenera(v) -> str:
    """Roboczy „Draft-…” to brak numeru — w dzienniku go nie pokazujemy."""
    return PUSTE if _robocze(v) else f_txt(v)


def etykieta_kontenera(nr: Optional[str], fv: Optional[str], cid) -> str:
    """Jak containerSlug na froncie: prawdziwy nr kontenera, inaczej nr FV, inaczej #id."""
    nr = (nr or "").strip()
    if nr and not _robocze(nr):
        return nr
    fv = (fv or "").strip()
    return f"FV {fv}" if fv else f"#{cid}"


ROLE = {"ADMIN": "Admin", "IMPORT": "Import", "VIEWER": "Viewer"}

# Etykiety jak w frontend/lib/permissions.js — dziennik ma mówić tym samym językiem co UI.
UPRAWNIENIA = {
    "editProducts": "Edycja produktów", "editContainers": "Edycja kontenerów",
    "import": "Import danych", "export": "Eksport danych", "generatePO": "Generowanie zamówień",
    "viewFinancials": "Dane finansowe (PLN)", "viewDashboardKpi": "KPI Dashboard",
    "assistantFinancials": "Dane finansowe – asystent", "viewForecast": "Prognoza",
    "manageUsers": "Zarządzanie userami", "viewAudit": "Dziennik audytu", "viewReports": "Raporty",
    "viewOccupancy": "Zajętość magazynu", "viewAttachments": "Załączniki kontenerów",
    "viewCalendarPayments": "Płatności w kalendarzu", "viewBankBalances": "Stan konta firmy",
    "editBankBalances": "Wpisywanie stanu konta", "viewProductHistory": "Historia produktu",
    "viewPurchasePrice": "Cena zakupu produktu", "viewProductSales": "Sprzedaż na karcie produktu",
    "viewLandedCost": "Koszt jednostkowy kontenera", "editLandedCost": "Liczenie kosztu jednostkowego",
    "viewProductPrice": "Cena na karcie produktu", "editProductPrice": "Zapis sugerowanej ceny",
    "viewDropy": "Dropy",
}


def opis_ustawien_usera(d: dict) -> List[str]:
    """Słownik zmian z PATCH /users → lista fraz („wyłączono „Dane finansowe (PLN)””)."""
    parts: List[str] = []
    if isinstance(d.get("role"), str):
        parts.append(f"rola {ROLE.get(d['role'], d['role'])}")
    if isinstance(d.get("is_active"), bool):
        parts.append("aktywowano konto" if d["is_active"] else "dezaktywowano konto")
    if isinstance(d.get("full_name"), str):
        parts.append(f"nazwa „{d['full_name']}”")
    perms = d.get("perms")
    if isinstance(perms, dict):
        if not perms:
            parts.append("przywrócono domyślne uprawnienia roli")
        for k, v in perms.items():
            parts.append(f"{'włączono' if v else 'wyłączono'} „{UPRAWNIENIA.get(k, k)}”")
    if isinstance(d.get("show_onboarding"), bool):
        parts.append("włączono onboarding" if d["show_onboarding"] else "wyłączono onboarding")
    if isinstance(d.get("company_scope"), list):
        cs = d["company_scope"]
        parts.append(f"dostęp tylko do: {', '.join(cs)}" if cs else "dostęp do wszystkich firm")
    return parts


# ============================================================
# Zdania ze ścieżki żądania
# ============================================================
@dataclass
class Opis:
    obszar: str
    orzeczenie: str
    akcja: str
    typ: Optional[str] = None
    id: Optional[str] = None


# Żądania, które niczego nie zmieniają albo mają własne miejsce — bez wpisu.
#   podgląd odprawy, czat asystenta, PDF/auto-sugestia (liczą, nie zapisują), onboarding,
#   synchronizacje (Sellasist, Fakturownia, kursy NBP, snapshoty) → zakładka „Świeżość danych”,
#   dropy → własny dziennik w zakładce Dropy, logowanie/hasło → wpisy z routers/auth.py.
POMIJANE = [
    r"^/api/kontenery/\d+/odprawa/podglad$",
    r"^/api/assistant/chat$",
    r"^/api/(order-pdf-data|auto-suggest)$",
    r"^/api/reports/snapshot$",
    r"^/api/auth/(login|logout|me/password|me/onboarding)$",
    r"^/api/sellasist/",
    r"^/api/fakturownia",
    r"^/api/admin/fx/",
    r"^/api/dropy/",
]
_POMIJANE = [re.compile(p) for p in POMIJANE]

_SKU = r"(?P<sku>.+?)"
_ID = r"(?P<id>\d+)"

# (metoda, wzorzec, obszar, orzeczenie, akcja, typ zasobu). Kolejność ma znaczenie:
# szczegółowe ścieżki produktu przed ogólnym DELETE /products/{sku}.
TRASY = [
    # Produkty
    ("PUT", rf"^/api/products/{_SKU}/attrs$", "Produkty", "zmienił atrybuty produktu {sku}", "PRODUCT_UPDATED", "product"),
    ("PUT", rf"^/api/products/{_SKU}/favorite$", "Produkty", "zmienił obserwowanie produktu {sku}", "PRODUCT_UPDATED", "product"),
    ("PUT", rf"^/api/products/{_SKU}/no-reorder$", "Produkty", "zmienił „nie dozamawiamy” produktu {sku}", "PRODUCT_UPDATED", "product"),
    ("PUT", rf"^/api/products/{_SKU}/new-until$", "Produkty", "zmienił nowość produktu {sku}", "PRODUCT_UPDATED", "product"),
    ("PUT", rf"^/api/products/{_SKU}/lead-time$", "Produkty", "zmienił czas dostawy produktu {sku}", "PRODUCT_UPDATED", "product"),
    ("PUT", rf"^/api/products/{_SKU}/cena$", "Ceny", "zapisał cenę produktu {sku}", "PRICE_SAVED", "product"),
    ("POST", rf"^/api/products/{_SKU}/photos$", "Produkty", "dodał zdjęcie produktu {sku}", "PHOTO_ADDED", "product"),
    ("POST", r"^/api/products/import$", "Produkty", "zaimportował atrybuty produktów z pliku", "PRODUCTS_IMPORTED", "product"),
    ("DELETE", rf"^/api/products/{_SKU}$", "Produkty", "usunął produkt {sku}", "PRODUCT_DELETED", "product"),
    ("POST", r"^/api/samples$", "Produkty", "dodał sample", "SAMPLE_CREATED", "product"),
    ("DELETE", rf"^/api/product-photos/{_ID}$", "Produkty", "usunął zdjęcie produktu", "PHOTO_DELETED", "photo"),
    ("PUT", rf"^/api/product-photos/{_ID}/main$", "Produkty", "ustawił zdjęcie główne produktu", "PHOTO_MAIN", "photo"),
    ("POST", r"^/api/cn-sku$", "Produkty", "dodał chińskie SKU", "CN_SKU_SAVED", "cn_sku"),
    ("POST", r"^/api/cn-sku/bulk$", "Produkty", "wkleił listę chińskich SKU", "CN_SKU_IMPORTED", "cn_sku"),
    ("PATCH", rf"^/api/cn-sku/{_ID}$", "Produkty", "zmienił chińskie SKU (wiersz #{id})", "CN_SKU_SAVED", "cn_sku"),
    ("DELETE", rf"^/api/cn-sku/{_ID}$", "Produkty", "usunął chińskie SKU (wiersz #{id})", "CN_SKU_DELETED", "cn_sku"),
    # Kontenery
    ("POST", r"^/api/containers$", "Kontenery", "dodał kontener", "CONTAINER_CREATED", "container"),
    ("PATCH", rf"^/api/containers/{_ID}$", "Kontenery", "zmienił kontener #{id}", "CONTAINER_UPDATED", "container"),
    ("DELETE", rf"^/api/containers/{_ID}$", "Kontenery", "usunął kontener #{id}", "CONTAINER_DELETED", "container"),
    ("POST", rf"^/api/containers/{_ID}/deliver$", "Kontenery", "oznaczył kontener #{id} jako dostarczony", "CONTAINER_DELIVERED", "container"),
    ("POST", rf"^/api/containers/{_ID}/subiekt-wbite$", "Kontenery", "zmienił znacznik „dodano do Subiektu” kontenera #{id}", "CONTAINER_UPDATED", "container"),
    ("POST", rf"^/api/containers/{_ID}/attachments$", "Kontenery", "dodał załącznik do kontenera #{id}", "ATTACHMENT_ADDED", "container"),
    ("DELETE", rf"^/api/attachments/{_ID}$", "Kontenery", "usunął załącznik kontenera", "ATTACHMENT_DELETED", "attachment"),
    ("PATCH", r"^/api/cashflow/payment/termin$", "Finanse", "przesunął termin płatności", "MOVE_PAYMENT_TERMIN", "payment"),
    # Odprawy
    ("POST", rf"^/api/kontenery/{_ID}/odprawa$", "Odprawy", "zapisał odprawę kontenera #{id}", "ODPRAWA_SAVED", "container"),
    ("DELETE", rf"^/api/odprawy/{_ID}$", "Odprawy", "cofnął odprawę #{id}", "ODPRAWA_DELETED", "odprawa"),
    # Słowniki
    ("POST", r"^/api/manufacturers$", "Producenci", "dodał producenta", "MANUFACTURER_CREATED", "manufacturer"),
    ("PATCH", rf"^/api/manufacturers/{_ID}$", "Producenci", "zmienił producenta #{id}", "MANUFACTURER_UPDATED", "manufacturer"),
    ("DELETE", rf"^/api/manufacturers/{_ID}$", "Producenci", "usunął producenta #{id}", "MANUFACTURER_DELETED", "manufacturer"),
    ("POST", r"^/api/container-types$", "Ustawienia", "dodał typ kontenera", "CONTAINER_TYPE_CREATED", "container_type"),
    ("PATCH", rf"^/api/container-types/{_ID}$", "Ustawienia", "zmienił typ kontenera #{id}", "CONTAINER_TYPE_UPDATED", "container_type"),
    ("DELETE", rf"^/api/container-types/{_ID}$", "Ustawienia", "usunął typ kontenera #{id}", "CONTAINER_TYPE_DELETED", "container_type"),
    ("PATCH", rf"^/api/firmy/{_ID}$", "Firmy", "zmienił firmę #{id}", "FIRMA_UPDATED", "firma"),
    ("POST", rf"^/api/firmy/{_ID}/assign-products$", "Firmy", "przypisał produkty producenta do firmy #{id}", "FIRMA_ASSIGNED", "firma"),
    # Użytkownicy i konto
    ("POST", r"^/api/users$", "Użytkownicy", "dodał użytkownika", "USER_CREATED", "user"),
    ("PATCH", rf"^/api/users/{_ID}$", "Użytkownicy", "zmienił użytkownika #{id}", "USER_UPDATED", "user"),
    ("POST", r"^/api/users/bulk$", "Użytkownicy", "zmienił kilku użytkowników naraz", "USER_UPDATED", "user"),
    ("DELETE", rf"^/api/users/{_ID}$", "Użytkownicy", "usunął użytkownika #{id}", "USER_DELETED", "user"),
    ("PUT", rf"^/api/users/{_ID}/password$", "Użytkownicy", "zresetował hasło użytkownika #{id}", "PASSWORD_RESET_BY_ADMIN", "user"),
    ("DELETE", rf"^/api/auth/me/sessions/{_ID}$", "Logowania", "usunął sesję logowania z listy", "SESSION_DELETED", "session"),
    # Finanse
    ("POST", r"^/api/bank-balances$", "Finanse", "wpisał stan konta firmy", "BANK_BALANCE_SAVED", "bank_balance"),
    ("PATCH", rf"^/api/bank-balances/{_ID}$", "Finanse", "poprawił stan konta firmy", "BANK_BALANCE_SAVED", "bank_balance"),
    ("DELETE", rf"^/api/bank-balances/{_ID}$", "Finanse", "usunął odczyt stanu konta firmy", "BANK_BALANCE_DELETED", "bank_balance"),
    ("POST", r"^/api/owner-loans$", "Finanse", "dodał pożyczkę wspólnika", "OWNER_LOAN_SAVED", "owner_loan"),
    ("PATCH", rf"^/api/owner-loans/{_ID}$", "Finanse", "zmienił pożyczkę wspólnika", "OWNER_LOAN_SAVED", "owner_loan"),
    ("DELETE", rf"^/api/owner-loans/{_ID}$", "Finanse", "usunął pożyczkę wspólnika", "OWNER_LOAN_DELETED", "owner_loan"),
    # Ustawienia
    ("PUT", r"^/api/reports/occupancy/config$", "Ustawienia", "zapisał konfigurację raportu zajętości magazynu", "OCCUPANCY_CONFIG_SAVED", "reports"),
    ("PUT", r"^/api/reports/economics/config$", "Ustawienia", "zapisał konfigurację ekonomiki SKU", "ECONOMICS_CONFIG_SAVED", "reports"),
    ("POST", r"^/api/usage/topup$", "Ustawienia", "doładował limit asystenta AI", "USAGE_TOPUP", "usage"),
]
_TRASY = [(m, re.compile(p), o, z, a, t) for (m, p, o, z, a, t) in TRASY]


def opis_sciezki(method: str, path: str) -> Optional[Opis]:
    """Zdanie dla żądania. None = żądanie nie trafia do dziennika."""
    if any(p.search(path) for p in _POMIJANE):
        return None
    for m, wzor, obszar, orzeczenie, akcja, typ in _TRASY:
        if m != method:
            continue
        hit = wzor.match(path)
        if hit:
            g = hit.groupdict()
            rid = g.get("sku") or g.get("id")
            return Opis(obszar, orzeczenie.format(**g), akcja, typ, rid)
    # Nieznana trasa — wpis i tak powstaje, żeby nic nie przepadło.
    parts = [p for p in path.strip("/").split("/") if p and p != "api"]
    return Opis("Inne", f"wykonał zmianę: {method} {path}", f"{method}_{(parts or ['?'])[0].upper()}",
                parts[0] if parts else None, parts[1] if len(parts) > 1 else None)


# ============================================================
# Obszar dla wpisów z log_audit() (bez ścieżki)
# ============================================================
_OBSZAR_AKCJI = {
    "LOGIN": "Logowania", "LOGIN_FAILED": "Logowania", "LOGIN_BLOCKED": "Logowania",
    "PASSWORD_CHANGED": "Logowania", "SESSION_DELETED": "Logowania",
    "USER_CREATED": "Użytkownicy", "USER_UPDATED": "Użytkownicy", "USER_DELETED": "Użytkownicy",
    "PASSWORD_RESET_BY_ADMIN": "Użytkownicy",
    "PRODUCT_DELETED": "Produkty", "MOVE_PAYMENT_TERMIN": "Finanse",
    "OCCUPANCY_CONFIG_SAVED": "Ustawienia", "ECONOMICS_CONFIG_SAVED": "Ustawienia",
}
# Stare wpisy middleware: resource_type = pierwszy człon ścieżki.
_OBSZAR_TYPU = {
    "products": "Produkty", "samples": "Produkty", "product-photos": "Produkty", "cn-sku": "Produkty",
    "product": "Produkty", "cena": "Ceny",
    "containers": "Kontenery", "attachments": "Kontenery", "kontenery": "Odprawy", "odprawy": "Odprawy",
    "manufacturers": "Producenci", "container-types": "Ustawienia", "firmy": "Firmy",
    "users": "Użytkownicy", "user": "Użytkownicy", "auth": "Logowania",
    "bank-balances": "Finanse", "owner-loans": "Finanse", "cashflow": "Finanse", "payment": "Finanse",
    "reports": "Ustawienia", "usage": "Ustawienia", "dropy": "Dropy",
}


def obszar_akcji(action: Optional[str], resource_type: Optional[str] = None) -> str:
    return _OBSZAR_AKCJI.get(action or "") or _OBSZAR_TYPU.get(resource_type or "") or "Inne"


# ============================================================
# Wpisy sprzed przebudowy (message IS NULL) — zdanie składane przy odczycie
# ============================================================
_SZCZEGOLY_SCIEZKI = re.compile(r"^(POST|PUT|PATCH|DELETE) (/\S+)$")


def _slownik_py(s: Optional[str]) -> Optional[dict]:
    if not s:
        return None
    try:
        v = ast.literal_eval(s)
        return v if isinstance(v, dict) else None
    except (ValueError, SyntaxError):
        return None


def orzeczenie_legacy(action: str, resource_id: Optional[str], details: Optional[str]) -> str:
    """Najlepsze zdanie, jakie da się złożyć ze starego wpisu (bez wartości było → jest)."""
    a = action or ""
    rid = resource_id or ""
    m = _SZCZEGOLY_SCIEZKI.match(details or "")
    if m:
        opis = opis_sciezki(m.group(1), m.group(2))
        if opis:
            return opis.orzeczenie
    po_dwukropku = (details or "").split(": ", 1)[-1]
    if a == "LOGIN":
        return "zalogował się"
    if a == "LOGIN_FAILED":
        return f"nieudane logowanie na konto {rid} — złe e-mail lub hasło"
    if a == "LOGIN_BLOCKED":
        return f"zablokowane logowanie na konto {rid} — konto nieaktywne"
    if a == "PASSWORD_CHANGED":
        return "zmienił swoje hasło"
    if a == "PASSWORD_RESET_BY_ADMIN":
        return f"zresetował hasło użytkownika {po_dwukropku}"
    if a == "USER_CREATED":
        return f"dodał użytkownika {details or ''}".strip()
    if a == "USER_DELETED":
        return f"usunął użytkownika {po_dwukropku}"
    if a == "USER_UPDATED":
        parts = opis_ustawien_usera(_slownik_py(details) or {})
        return f"zmienił użytkownika #{rid}" + (f": {'; '.join(parts)}" if parts else "")
    if a == "PRODUCT_DELETED":
        return f"usunął produkt {rid}"
    if a == "MOVE_PAYMENT_TERMIN":
        return f"przesunął termin płatności ({details})" if details else "przesunął termin płatności"
    if a == "OCCUPANCY_CONFIG_SAVED":
        return "zapisał konfigurację raportu zajętości magazynu"
    if a == "ECONOMICS_CONFIG_SAVED":
        return "zapisał konfigurację ekonomiki SKU"
    return f"{a.lower()} {rid}".strip()

