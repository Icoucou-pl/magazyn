"""
Audit log: pomocnik log_audit() do ręcznego logowania oraz middleware
który automatycznie loguje wszystkie udane mutacje (POST/PUT/PATCH/DELETE).
"""

from typing import Optional

from sqlalchemy import text

from config import settings
from database import SessionLocal
from security import decode_jwt_token
from models import CurrentUser


async def log_audit(db, user: Optional[CurrentUser], action: str,
                    resource_type: Optional[str] = None, resource_id: Optional[str] = None,
                    details: Optional[str] = None):
    """Zapisuje wpis do audit log. Errory ignorowane (nie blokują głównej operacji)."""
    try:
        await db.execute(
            text(f"""
                INSERT INTO {settings.TABLE_AUDIT_LOG} (user_id, user_email, action, resource_type, resource_id, details)
                VALUES (:uid, :email, :action, :rtype, :rid, :details)
            """),
            {
                "uid": user.id if user else None,
                "email": user.email if user else None,
                "action": action,
                "rtype": resource_type,
                "rid": str(resource_id) if resource_id else None,
                "details": details,
            }
        )
        await db.commit()
    except Exception as e:
        print(f"[audit] {e}")


async def audit_middleware(request, call_next):
    """
    Middleware który automatycznie loguje wszystkie mutacje (POST/PUT/PATCH/DELETE).
    Nie blokuje żądań - logi zapisywane po odpowiedzi.
    """
    response = await call_next(request)

    # Loguj tylko mutacje które się udały (2xx)
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and 200 <= response.status_code < 300:
        # Pomiń endpointy auth (logowanie itp. - mają swój log)
        path = request.url.path
        if any(skip in path for skip in ["/auth/login", "/auth/logout", "/auth/me/password"]):
            return response

        # Pobierz token żeby zidentyfikować usera
        token_str = None
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token_str = auth_header[7:]
        # Fallback: token w query param (download)
        if not token_str:
            token_str = request.query_params.get("token")

        user_id = None
        user_email = None
        if token_str:
            payload = decode_jwt_token(token_str)
            if payload:
                user_id = int(payload.get("sub", 0)) or None
                user_email = payload.get("email")

        # Mapuj metodę + ścieżkę na czytelną akcję
        method_labels = {"POST": "CREATED", "PUT": "UPDATED", "PATCH": "UPDATED", "DELETE": "DELETED"}
        action_label = method_labels.get(request.method, request.method)

        # Wyciągnij typ zasobu ze ścieżki (/api/containers/5 → containers)
        path_parts = [p for p in path.strip("/").split("/") if p and p != "api"]
        resource_type = path_parts[0] if path_parts else "unknown"
        resource_id = path_parts[1] if len(path_parts) > 1 else None

        action = f"{resource_type.upper()}_{action_label}"

        try:
            async with SessionLocal() as db:
                await db.execute(
                    text(f"""
                        INSERT INTO {settings.TABLE_AUDIT_LOG} (user_id, user_email, action, resource_type, resource_id, details)
                        VALUES (:uid, :email, :action, :rtype, :rid, :details)
                    """),
                    {
                        "uid": user_id,
                        "email": user_email,
                        "action": action,
                        "rtype": resource_type,
                        "rid": str(resource_id) if resource_id else None,
                        "details": f"{request.method} {path}",
                    }
                )
                await db.commit()
        except Exception as e:
            print(f"[audit_middleware] {e}")

    return response
