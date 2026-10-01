# Magazyn — notatki dla Claude

Aplikacja do zarządzania magazynem i importem dla trzech firm z jednej grupy.
Właściciel nie jest programistą: rozmowa po polsku, prostym językiem, bez żargonu.
Zmiany zawsze sprawdzone testami, zanim trafią na `main`.

## Biznes w pigułce

- **Firmy (sklepy):** `amh`, `acti` (Acti4med), `veluxa` — `security.ALL_SHOPS`.
  Parametr `shop` w API: `""` = wszystkie firmy, raporty używają `"all"`.
- **Źródła danych** (tabele zasilane z zewnątrz, nazwy w `config.py`):
  - **Subiekt** (`subiekt_towary`, `subiekt_dwa_magazyny`) — stany i ceny **AMH**, magazyn „w drodze” AMH.
  - **Sellasist** (`sellasist_orders`, `sellasist_order_items`, `sellasist_stock`) — zamówienia detaliczne
    wszystkich firm (kanał, status) i stany firm nie-AMH. Sprzedaż liczy się tylko ze statusów
    z whitelisty `INCLUDED_ORDER_STATUSES` (AMH) / `INCLUDED_ORDER_STATUSES_EXT` (Acti/Veluxa).
  - **Fakturownia** — stany „w drodze” + ceny zakupu **Acti/Veluxa**, sprzedaż spoza Sellasista
    (hurt, przesunięcia do AMH), dziennik ruchów magazynowych.
  - **NBP** — kursy walut (`app_fx_rates`), przeliczenie na PLN.
- **Kontenery** z Chin: pozycje, loty, zaliczki, załączniki (FV, proformy, BL), odprawa celna
  z XML WinSAD (`services/sad.py`, `services/odprawy.py`) → koszt jednostkowy (landed cost).
- **Prognoza:** średnia ważona sprzedaży 1–4 mies. (`services/products.py`), lead time per SKU,
  dzień zamówienia, auto-sugestia składu kontenera, anomalie, lista zakupów.
- **Dropy** — sprzedaż partnerom (dropshipping). Dwie części:
  `routers/dropy.py` (nasza zakładka w Magazynie) i `dropy_service/` — **osobny serwis** (portal partnera,
  własna rola w bazie, własny JWT; nie importuje niczego z Magazynu).
- **Asystent AI** (`services/assistant.py`) — czat z narzędziami, dostawca zgodny z API OpenAI
  (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). Narzędzia finansowe tylko z `assistantFinancials`.

## Stack i wdrożenie

- **Backend:** FastAPI + SQLAlchemy (async, `asyncpg`), surowy SQL przez `text()`. Python 3.12 (`runtime.txt`).
- **Baza:** PostgreSQL w **Supabase** (session pooler, port 5432, `NullPool`, bez prepared statements).
- **Frontend:** Next.js 16 + React 19 + Tailwind 4 w `frontend/`. Przeczytaj `frontend/AGENTS.md`:
  ta wersja Next różni się od tej z danych treningowych — sprawdzaj `node_modules/next/dist/docs/`.
- **Hosting:** Railway (backend: `Procfile`, jeden proces uvicorna; `dropy_service` jako osobna usługa).
  Push na `main` = automatyczny deploy.
- **Backup:** codzienny GitHub Action `supabase-backup.yml` (opis w `docs/`).

## Mapa kodu

| Gdzie | Co |
|---|---|
| `main.py` | spina routery i middleware (CORS, audyt, pomiar czasu + czyszczenie cache sprzedaży po zapisach) |
| `config.py` | wszystkie ustawienia z env, **nazwy tabel i kolumn** (`settings.TABLE_*`, `COL_*`) |
| `lifespan.py` | start: tworzy tabele/kolumny/indeksy, domyślny admin, pętle w tle (NBP co 6 h, auto-Sellasist, snapshoty KPI 2×/dzień, push dropów, retencja audytu) |
| `security.py` | JWT, hasła, **uprawnienia** (`ROLE_PERMS`, `require_perm`, `can_*`), **zakres firm** (`resolve_shop`) |
| `audit.py`, `audit_opisy.py` | dziennik audytu „po ludzku” (zdania, było → jest) |
| `models.py` | modele Pydantic (wejście/wyjście API) |
| `sql.py` | wspólne kawałki SQL (CTE nazw produktów itp.) |
| `routers/` | endpointy, każdy z prefiksem `/api` |
| `services/` | logika biznesowa i integracje (Sellasist, Fakturownia, NBP, SAD, cena, snapshoty) |
| `sql/` | ręczne migracje do puszczenia w Supabase **przed** deployem |
| `tests/` | pytest, bez bazy |
| `frontend/lib/api.js` | jedyny klient API (dokleja token, 401 → wylogowanie) |
| `frontend/lib/permissions.js` | lustro `ROLE_PERMS` po stronie UI |
| `frontend/lib/routes.ts` | adresy (polskie segmenty) ↔ widoki; aplikacja to jedna strona `app/[[...slug]]` |
| `frontend/components/` | widoki (dashboard, products, containers, finance, dropy, settings…) |

## Zasady, których pilnujemy

**Bezpieczeństwo i uprawnienia**
- Każdy endpoint `/api` wymaga logowania (`Depends(get_current_user)` albo `require_*`).
  Pilnuje tego `tests/test_autoryzacja.py`. Świadomie publiczne trasy dopisuje się do `PUBLICZNE` w tym teście, z powodem.
- Uprawnienia: `ROLE_PERMS` w `security.py` **musi zgadzać się 1:1** z `frontend/lib/permissions.js`.
  Nowe uprawnienie = obie strony. Override per użytkownik (kolumna `permissions`) wygrywa nad rolą.
- Uprawnienia „finansowe” są **koniunkcyjne** z `viewFinancials` (bank, landed cost, cena, płatności w kalendarzu) —
  używaj gotowych `can_*` / `require_*`, nie samego `has_perm`.
- Odpowiedzi z cenami przepuszczaj przez maskowanie (`routers/products.py::_mask_financials`).
- **Zakres firm** (`company_scope`) egzekwuje serwer: parametr `shop` z frontu zawsze przez
  `resolve_shop(shop, user)` / `resolve_scope`, a `get_product(..., allowed=allowed_shops(user))`.
- Logowanie ma limit prób (`services/login_limit.py`, w pamięci procesu).

**SQL i baza**
- Wartości od użytkownika **zawsze** jako parametry (`:nazwa`). W f-stringach tylko nazwy z `settings`
  i wartości z whitelisty (np. `ALLOWED_SHOPS`).
- Nazwy tabel/kolumn bierz z `settings`, nie wpisuj na sztywno.
- Zdjęcia produktów (`app_product_photos`): kolumn `thumb_data`/`full_data` **nigdy** w zapytaniach listowych ani `SELECT *`.
- Zmiana schematu: dopisz `add_column_if_missing` / `CREATE ... IF NOT EXISTS` w `lifespan.py` **albo**
  plik `sql/RRRR-MM-opis.sql` (idempotentny, z komentarzem „puścić w Supabase PRZED wdrożeniem”) —
  i powiedz właścicielowi, że musi go uruchomić.
- Na produkcyjnej bazie Claude **nic nie zapisuje**. Dostęp, jeśli jest, tylko do odczytu.

**Styl kodu**
- Komentarze i docstringi **po polsku**, wyjaśniają „dlaczego”, gęsto jak w otoczeniu.
  Nazwy zmiennych mieszane (angielskie w starszym kodzie, polskie w nowszym) — trzymaj się stylu pliku.
- Router = cienka warstwa; logika w `services/`.
- Zmiany danych są audytowane automatycznie (middleware); szczegóły „było → jest” przez `audit.note_zmiany(...)`.

## Sprawdzanie zmian

```bash
pip install -r requirements.txt pytest httpx
python3 -m pytest -q tests          # bez bazy; config wymaga tylko zmiennych DB_* (test ustawia atrapy)
cd frontend && npm install && npm run lint && npm run build
```

- Endpoint bez bazy da się sprawdzić `TestClient` z podmienionym `database.get_db`
  (`app.dependency_overrides`) i atrapami `DB_*`, `SECRET_KEY` w env.
- Nie ma CI z testami na GitHubie — testy uruchamiamy sami przed pushem.

## Jak pracujemy z GitHubem

- Commity i PR-y **po polsku**, tytuł mówi co i dlaczego (np. „Odprawy: …”, „Cena produktu etap 2: …”).
- Praca na gałęzi → PR do `main` → **squash merge**. Właściciel zgodził się, żeby Claude scalał sam,
  gdy testy są zielone i nie ma konfliktów.
- Nie nadpisujemy historii (`push --force`) — gałąź po scaleniu odświeżamy merge'em.
- Po scaleniu napisz właścicielowi, co przeklikać w aplikacji po deployu.

## Otwarte tematy

- `SECRET_KEY` — upewnić się, że jest ustawiony w Railway (bez niego każdy deploy wylogowuje wszystkich);
  dopisać do `.env.example`. Odłożone.
- Dostęp do Supabase tylko do odczytu (rola `claude_ro`, zmienna `SUPABASE_RO_URL`) — w przygotowaniu.
  Potem sprawdzić, czy `dropy.orders` ma UNIQUE na `nr` i `(partner_id, firma, external_id)`:
  `dropy_service/api.py::_next_nr` liczy numer jako „ostatni + 1”, bez blokady.
- Raport stanów (`routers/reports.py`, `s_cena`) liczy cenę początkową, której nie używa — porównanie
  jest tylko w sztukach, nie w wartości.
- Zmiana hasła nie unieważnia innych sesji (JWT bezstanowy, 7 dni) — świadomie odłożone.
