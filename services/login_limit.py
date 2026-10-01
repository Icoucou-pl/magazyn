"""Limit nieudanych logowań — ochrona przed zgadywaniem hasła.

Licznik w pamięci procesu (Procfile: jeden proces uvicorna). Restart/deploy go zeruje —
to akceptowalne: chodzi o spowolnienie zgadywania, nie o trwały zapis prób
(te i tak lądują w dzienniku audytu jako LOGIN_FAILED).

Dwa liczniki w oknie WINDOW_S:
  · per konto (e-mail)  — MAX_PER_EMAIL prób, potem konto czeka do końca okna,
  · per adres IP        — MAX_PER_IP prób, żeby jeden adres nie przeczesywał wielu kont.
Udane logowanie zeruje licznik konta.
"""

import time
from collections import deque
from typing import Deque, Dict, Optional

WINDOW_S = 15 * 60
MAX_PER_EMAIL = 5
MAX_PER_IP = 20
_MAX_KEYS = 10_000          # bezpiecznik pamięci przy zalewie losowymi e-mailami

_fails: Dict[str, Deque[float]] = {}


def _key_email(email: str) -> str:
    return "e:" + (email or "").strip().lower()


def _key_ip(ip: str) -> Optional[str]:
    return ("ip:" + ip) if ip else None


def _fresh(key: str, now: float) -> Deque[float]:
    q = _fails.get(key)
    if q is None:
        return deque()
    while q and now - q[0] >= WINDOW_S:
        q.popleft()
    if not q:
        _fails.pop(key, None)
    return q


def _wait(key: Optional[str], limit: int, now: float) -> int:
    if not key:
        return 0
    q = _fresh(key, now)
    if len(q) < limit:
        return 0
    return max(1, int(WINDOW_S - (now - q[0])) + 1)


def retry_after(email: str, ip: str) -> int:
    """Ile sekund trzeba poczekać przed kolejną próbą (0 = można próbować)."""
    now = time.monotonic()
    return max(_wait(_key_email(email), MAX_PER_EMAIL, now),
               _wait(_key_ip(ip), MAX_PER_IP, now))


def register_failure(email: str, ip: str) -> None:
    now = time.monotonic()
    if len(_fails) >= _MAX_KEYS:
        for k in list(_fails):
            _fresh(k, now)
        if len(_fails) >= _MAX_KEYS:
            _fails.clear()
    for key in (_key_email(email), _key_ip(ip)):
        if key:
            _fails.setdefault(key, deque()).append(now)


def register_success(email: str) -> None:
    _fails.pop(_key_email(email), None)


def reset() -> None:
    """Dla testów."""
    _fails.clear()
