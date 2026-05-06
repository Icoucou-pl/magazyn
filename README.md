# 📦 Magazyn

Aplikacja do zarządzania magazynem - integracja Subiekt + Sellasist.

## Stack

- **Backend:** FastAPI (Python) + SQLAlchemy + asyncpg
- **Frontend:** Next.js (React)
- **Baza:** PostgreSQL

## Funkcje

- Dashboard z KPI, anomaliami, listą zakupów
- Kalendarz wydarzeń (zamówienia, dostawy, koniec zapasów)
- Zarządzanie kontenerami (CBM, status flow, załączniki)
- Cashflow - prognoza wydatków
- Auto-sugestia kontenera
- Symulator scenariuszy
- Generator PDF zamówień
- Wykres wartości magazynu (90 dni)
- Ulubione produkty
- Globalna wyszukiwarka (Ctrl+K)
- Sortowanie i wybór kolumn
- Import/Eksport XLSX

## Lokalne uruchomienie

### Backend
```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
# Skopiuj .env.example jako .env i uzupełnij dane
uvicorn main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
npm install
# Skopiuj .env.example jako .env.local i ustaw NEXT_PUBLIC_API_BASE
npm run dev
```

## Hosting

Aplikacja przygotowana do hostingu na **Railway**.
