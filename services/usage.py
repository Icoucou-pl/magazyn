"""
services/usage.py
-----------------
Licznik zużycia LLM: jeden wiersz na turę asystenta (tokeny in/out + koszt USD).
Dopasowany do Twojego stacku: async SQLAlchemy + asyncpg, styl jak reszta services/.

Tabelę app_llm_usage zakłada lifespan (patrz PATCH). Ceny per model niżej.

Ta wersja dorzuca ROZKŁAD kosztu na wejście vs wyjście — globalnie i per wiersz —
żebyś widział na własnych danych, gdzie faktycznie idzie kasa (spoiler: output).
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# USD za 1 token: (wejście, wyjście)
PRICING = {
    "claude-haiku-4-5":  (Decimal("1.00")  / 1_000_000, Decimal("5.00")  / 1_000_000),
    "claude-sonnet-4-6": (Decimal("3.00")  / 1_000_000, Decimal("15.00") / 1_000_000),
    "claude-opus-4-8":   (Decimal("5.00")  / 1_000_000, Decimal("25.00") / 1_000_000),
}
# fallback gdyby model nie był na liście (np. znów Groq/Llama — wtedy koszt ~0)
DEFAULT_PRICE = (Decimal("0"), Decimal("0"))


def _prices(model: str):
    return PRICING.get(model, DEFAULT_PRICE)


def cost_usd(model: str, tin: int, tout: int) -> Decimal:
    pin, pout = _prices(model)
    return tin * pin + tout * pout


async def log_usage(db: AsyncSession, *, query: str, model: str,
                    tin: int, tout: int, rounds: int) -> None:
    """Zapisuje JEDEN wiersz za całą turę (suma po wszystkich rundkach tool-callingu)."""
    c = cost_usd(model, tin, tout)
    await db.execute(
        text("""
            INSERT INTO app_llm_usage
                (query, model, input_tokens, output_tokens, cost_usd, api_calls)
            VALUES (:q, :m, :tin, :tout, :cost, :calls)
        """),
        {"q": (query or "")[:500], "m": model, "tin": tin, "tout": tout,
         "cost": c, "calls": rounds},
    )
    await db.commit()


async def get_stats(db: AsyncSession, starting_balance: float, limit: int = 200) -> Dict[str, Any]:
    """Saldo + rozkład input/output (globalnie i per wiersz) + ostatnie wiersze."""

    # --- agregat per model: pozwala policzyć koszt input vs output dokładnie,
    #     nawet gdyby w logu były różne modele (np. część na Groq, część na Claude) ---
    per_model = (await db.execute(text("""
        SELECT model,
               COALESCE(SUM(input_tokens), 0)  AS tin,
               COALESCE(SUM(output_tokens), 0) AS tout,
               COALESCE(SUM(cost_usd), 0)      AS cost,
               COUNT(*)                        AS n
          FROM app_llm_usage
         GROUP BY model
    """))).mappings().all()

    total_in = total_out = count = 0
    in_cost = out_cost = spent = Decimal(0)
    for r in per_model:
        pin, pout = _prices(r["model"])
        ti, to = int(r["tin"]), int(r["tout"])
        total_in  += ti
        total_out += to
        in_cost   += ti * pin
        out_cost  += to * pout
        spent     += Decimal(r["cost"])
        count     += int(r["n"])

    spent_f    = float(round(spent, 6))
    in_cost_f  = float(round(in_cost, 6))
    out_cost_f = float(round(out_cost, 6))
    # udział wyjścia w koszcie (zwykle >70% — dlatego caching od strony inputu mało daje)
    out_share = round(out_cost_f / spent_f * 100, 1) if spent_f > 0 else 0.0

    # --- ostatnie wiersze z rozbiciem kosztu na in/out ---
    raw = (await db.execute(text("""
        SELECT id, created_at, query, model,
               input_tokens, output_tokens, cost_usd, api_calls
          FROM app_llm_usage
         ORDER BY id DESC
         LIMIT :lim
    """), {"lim": limit})).mappings().all()

    rows = []
    for r in raw:
        pin, pout = _prices(r["model"])
        ti, to = int(r["input_tokens"]), int(r["output_tokens"])
        d = dict(r)
        d["cost_usd"]    = float(r["cost_usd"])
        d["input_cost"]  = float(round(ti * pin, 6))
        d["output_cost"] = float(round(to * pout, 6))
        d["created_at"]  = r["created_at"].isoformat() if r["created_at"] else None
        rows.append(d)

    return {
        "starting_balance": starting_balance,
        "spent": spent_f,
        "remaining": round(starting_balance - spent_f, 6),
        "count": count,
        # rozkład input vs output — to jest to, co chciałeś zobaczyć:
        "breakdown": {
            "input_tokens": total_in,
            "output_tokens": total_out,
            "input_cost": in_cost_f,
            "output_cost": out_cost_f,
            "output_share_pct": out_share,   # ile % rachunku to wyjście
        },
        "rows": rows,
    }
