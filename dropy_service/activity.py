"""Logi dropów po stronie portalu.

Każda zmiana, którą robi partner (w portalu albo przez API), zostawia wpis
w dropy.activity_log jako GOTOWE ZDANIE, np.
    „Użytkownik jan@aftercare.pl dodał etykietę do zamówienia AFT/202609/0012”.

Zasady:
  · zdanie składamy w chwili zdarzenia — późniejsza zmiana nazwy czy loginu
    nie przepisuje historii,
  · wpis idzie w TEJ SAMEJ transakcji co zmiana (tu nie ma commita),
    więc nie ma zmiany bez wpisu ani wpisu bez zmiany,
  · rola dropy_app ma tylko INSERT — portal nie czyta i nie kasuje logów.
"""

import json
from decimal import Decimal
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from auth import Partner


def zl(v) -> str:
    """1284.5 → „1 284,50 zł”."""
    s = f"{float(v or 0):,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} zł"


def plural(n: int, one: str, few: str, many: str) -> str:
    if n == 1:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


async def who(db: AsyncSession, p: Partner) -> tuple:
    """(actor, podmiot zdania) — np. ('jan@x.pl', 'Użytkownik jan@x.pl')."""
    if p.via == "api":
        name = f"„{p.key_label}” (…{p.key_hint})" if p.key_label else "partnera"
        return f"API {name}", f"Klucz API {name}"
    actor = "nieznany"
    if p.user_id:
        r = await db.execute(
            text("SELECT COALESCE(NULLIF(TRIM(full_name), ''), email) FROM dropy.users WHERE id = :id"),
            {"id": p.user_id},
        )
        actor = r.scalar() or actor
    return actor, f"Użytkownik {actor}"


def _json(changes: Optional[dict]) -> Optional[str]:
    if not changes:
        return None
    return json.dumps(changes, ensure_ascii=False,
                      default=lambda v: float(v) if isinstance(v, Decimal) else str(v))


async def log(db: AsyncSession, p: Partner, action: str, message: str,
              order_nr: Optional[str] = None, changes: Optional[dict] = None, actor: Optional[str] = None):
    """Dopisuje wpis. BEZ commita — commit robi endpoint razem ze zmianą."""
    if actor is None:
        actor, _ = await who(db, p)
    await db.execute(text(
        "INSERT INTO dropy.activity_log (partner_id, source, actor, actor_user_id, action, order_nr, message, changes) "
        "VALUES (:p, :src, :actor, :uid, :action, :nr, :msg, CAST(:ch AS JSONB))"
    ), {
        "p": p.id, "src": "api" if p.via == "api" else "portal", "actor": actor[:255],
        "uid": p.user_id, "action": action, "nr": order_nr, "msg": message, "ch": _json(changes),
    })
