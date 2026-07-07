// ============================================================
// API helper — komunikacja z backendem FastAPI (Railway "web").
// Token JWT trzymany w localStorage, dokładany jako Bearer.
// Na 401: czyści sesję i emituje event 'magazyn:unauthorized'
// (shell w page.js złapie go i pokaże ekran logowania).
// ============================================================

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://web-production-d1745.up.railway.app/api";

const TOKEN_KEY = "magazyn_token";
const USER_KEY = "magazyn_user";

// ---- Sesja (localStorage, bezpieczne przy SSR) ----
export function getToken() {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getUser() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  if (typeof window === "undefined") return;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {}
}

export function clearSession() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {}
}

// ---- Rdzeń żądania ----
async function request(method, path, body, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  let payload = body;

  // Auto-JSON dla obiektów (nie dotyka FormData)
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && body !== null && !isForm) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: payload,
  });

  // 401 → sesja nieważna: wyczyść i powiadom shell.
  // WYJĄTEK: /auth/login — tam 401 oznacza „nieprawidłowe dane logowania", a nie
  // „wygasłą sesję". Taki 401 przepuszczamy do ogólnej obsługi niżej, żeby pokazać
  // komunikat z backendu (np. „Nieprawidłowy email lub hasło").
  if (res.status === 401 && path !== "/auth/login") {
    clearSession();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("magazyn:unauthorized"));
    }
    throw new ApiError("Sesja wygasła — zaloguj się ponownie", 401);
  }

  if (!res.ok) {
    let detail = `Błąd ${res.status}`;
    try {
      const data = await res.json();
      detail = data.detail || detail;
    } catch {}
    throw new ApiError(detail, res.status);
  }

  // 204 / brak treści
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ---- Skróty ----
export const api = {
  get: (path, opts) => request("GET", path, undefined, opts),
  post: (path, body, opts) => request("POST", path, body, opts),
  put: (path, body, opts) => request("PUT", path, body, opts),
  patch: (path, body, opts) => request("PATCH", path, body, opts),
  del: (path, opts) => request("DELETE", path, undefined, opts),
};

// ---- Logowanie / wylogowanie ----
// Backend: POST /auth/login → { access_token, token_type, user }
export async function login(email, password) {
  const data = await request("POST", "/auth/login", { email, password });
  setSession(data.access_token, data.user);
  return data.user;
}

export function logout() {
  clearSession();
}

// ---- Pobieranie plików (eksport XLSX) ----
// Endpointy typu /products/export/csv zwracają plik, nie JSON.
export async function download(path, filename) {
  const token = getToken();
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) throw new ApiError(`Błąd pobierania ${res.status}`, res.status);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "plik.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export { API_BASE };
