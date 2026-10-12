"""„Podsumowanie sprzedaży” na pulpicie — liczba i wartość zamówień dzień po dniu, per firma.

Celowo liczone INACZEJ niż finanse: tak jak panel Sellasista, a nie jak Power BI.
  · bierzemy WSZYSTKIE zamówienia z `sellasist_orders` wg daty złożenia, w każdym statusie
    (nowe, za pobraniem, w realizacji…) — finanse liczą tylko zrealizowane (whitelista
    statusów per firma), więc tam świeże dni są „puste”, a tu widać bieżący ruch;
  · wyjątek: statusy z `PODSUMOWANIE_POMIJANE_STATUSY` — Sellasist nie liczy anulowanych
    i zakończonych zwrotów (sprawdzone co do grosza na Veluxie);
  · wartość = `total` zamówienia (brutto, z wysyłką — jak w Sellasiście), przeliczona na PLN
    kursem NBP z dnia roboczego PRZED datą zamówienia (ta sama reguła co w finansach).

Firmy mają różne statusy, ale przy liczeniu „wszystkiego” to nie gra roli — dlatego jedna
reguła pasuje do AMH, Acti i Veluxy. Hurt z Fakturowni tu nie wchodzi (Sellasist go nie zna).
"""
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings

MAX_DNI = 180   # najdłuższe okno wykresu (jak w Sellasiście: 30 / 60 / 180 dni)


def dzis_pl() -> date:
    """Dzisiejsza data w Polsce — serwer stoi w UTC, a „dziś” po 22:00 to już jutro w UTC."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Warsaw")).date()
    except Exception:
        return date.today()


def pomijane_statusy() -> List[str]:
    return [s.strip() for s in settings.PODSUMOWANIE_POMIJANE_STATUSY.split(",") if s.strip()]


def zbuduj_serie(wiersze: Iterable[Dict[str, Any]], firmy: List[str], od: date, do: date) -> Dict[str, Any]:
    """Wiersze z bazy (shop, dzien, zamowien, wartosc, bez_kursu) → pełne serie dzień po dniu.

    Dni bez zamówień dostają zera (wykres ma mieć ciągłą oś). Seria „razem” to suma firm
    dzień po dniu — liczona tutaj, a nie drugim zapytaniem, żeby zawsze zgadzała się z kafelkami."""
    dni = [od + timedelta(days=i) for i in range((do - od).days + 1)]
    puste = lambda: {d: {"zamowien": 0, "wartosc": 0.0} for d in dni}  # noqa: E731
    serie: Dict[str, Dict[date, Dict[str, float]]] = {f: puste() for f in firmy}
    bez_kursu: Dict[str, int] = {f: 0 for f in firmy}
    for w in wiersze:
        f, d = w["shop"], w["dzien"]
        if f not in serie or d not in serie[f]:
            continue
        serie[f][d]["zamowien"] += int(w["zamowien"] or 0)
        serie[f][d]["wartosc"] += float(w["wartosc"] or 0)
        bez_kursu[f] += int(w["bez_kursu"] or 0)

    def _lista(s: Dict[date, Dict[str, float]]) -> List[Dict[str, Any]]:
        return [{"date": d.isoformat(), "orders": int(v["zamowien"]), "value": round(v["wartosc"], 2)}
                for d, v in s.items()]

    out = [{"shop": f, "points": _lista(serie[f]), "missing_rates": bez_kursu[f]} for f in firmy]
    if len(firmy) > 1:
        razem = puste()
        for f in firmy:
            for d, v in serie[f].items():
                razem[d]["zamowien"] += v["zamowien"]
                razem[d]["wartosc"] += v["wartosc"]
        out.append({"shop": "", "points": _lista(razem), "missing_rates": sum(bez_kursu.values())})
    # Lista pomijanych statusów idzie na kartę (dymek „i”) — żeby było widać, co nie wchodzi.
    return {"from": od.isoformat(), "to": do.isoformat(), "series": out, "excluded_statuses": pomijane_statusy()}


async def podsumowanie(db: AsyncSession, firmy: List[str], dni: int = MAX_DNI,
                       dzis: Optional[date] = None) -> Dict[str, Any]:
    """Serie z ostatnich `dni` dni (łącznie z dzisiejszym) dla podanych firm + „razem”."""
    dni = max(1, min(int(dni), MAX_DNI))
    do = dzis or dzis_pl()
    od = do - timedelta(days=dni - 1)
    if not firmy:
        return zbuduj_serie([], [], od, do)

    o = settings.TABLE_ORDERS
    dcol = settings.COL_ORDER_DATE
    scol = settings.COL_ORDER_STATUS
    base = settings.FX_BASE_CURRENCY
    params: Dict[str, Any] = {"od": od, "do_": do + timedelta(days=1), "firmy": list(firmy), "base": base}
    pomijane = pomijane_statusy()
    warunek_statusu = ""
    if pomijane:
        warunek_statusu = f"AND COALESCE(o.{scol}, '') <> ALL(:pomijane)"
        params["pomijane"] = pomijane

    # Najpierw zwijamy zamówienia do (firma, dzień, waluta) — kurs NBP szukamy potem raz
    # na taką trójkę, a nie dla każdego zamówienia osobno.
    sql = f"""
        WITH dzienne AS (
            SELECT o.shop,
                   o.{dcol}::date AS dzien,
                   UPPER(TRIM(COALESCE(NULLIF(o.currency, ''), :base))) AS waluta,
                   COUNT(*) AS zamowien,
                   SUM(COALESCE(o.total, 0)) AS kwota
            FROM {o} o
            WHERE o.{dcol} >= :od AND o.{dcol} < :do_
              AND o.shop = ANY(:firmy)
              {warunek_statusu}
            GROUP BY 1, 2, 3
        )
        SELECT d.shop, d.dzien,
               SUM(d.zamowien) AS zamowien,
               SUM(d.kwota * fx.mult) AS wartosc,
               SUM(CASE WHEN fx.mult IS NULL THEN d.zamowien ELSE 0 END) AS bez_kursu
        FROM dzienne d
        LEFT JOIN LATERAL (
            SELECT CASE WHEN d.waluta = :base THEN 1.0 ELSE (
                SELECT r.mid FROM {settings.TABLE_FX_RATES} r
                WHERE r.currency = d.waluta AND r.rate_date < d.dzien
                ORDER BY r.rate_date DESC LIMIT 1
            ) END AS mult
        ) fx ON TRUE
        GROUP BY 1, 2
    """
    wiersze = (await db.execute(text(sql), params)).mappings().all()
    return zbuduj_serie(wiersze, list(firmy), od, do)
