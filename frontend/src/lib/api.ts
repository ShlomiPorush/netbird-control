// Thin fetch wrapper around the existing Express API. Same-origin in production
// (Express serves the built SPA); proxied to :3000 in dev (see vite.config.ts).

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Query = Record<string, unknown>;

function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

// Single-flight guard: a page fires many queries in parallel, so an expired session yields
// a burst of 401s at once. Only the FIRST may start the login redirect - each extra /login
// hit would overwrite the OIDC transaction cookie and break the login with a PKCE mismatch.
let redirectingToLogin = false;

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    // Not authenticated → kick off the OIDC login flow, remembering WHERE the user was -
    // after the (frequent, by security design) re-login they land back on the same page
    // instead of being dumped on Home.
    if (!redirectingToLogin) {
      redirectingToLogin = true;
      const here = window.location.pathname + window.location.search + window.location.hash;
      window.location.href = '/login?returnTo=' + encodeURIComponent(here);
    }
    throw new ApiError(401, 'Unauthorized');
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

// ─── MSP tenant mode ───
// While "managing" an MSP tenant, EVERY api call carries X-Tenant-Account; the backend runs
// the request in that tenant's context (only live-management routes are allowed there).
// Persisted so a refresh stays in tenant mode; the Layout banner is the visible indicator.
export interface TenantMode { id: string; name: string }
const TENANT_KEY = 'msp-tenant';
export function getTenantMode(): TenantMode | null {
  try {
    const raw = localStorage.getItem(TENANT_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return t && typeof t.id === 'string' && t.id ? { id: t.id, name: String(t.name || t.id) } : null;
  } catch { return null; }
}
export function setTenantMode(t: TenantMode | null) {
  if (t) localStorage.setItem(TENANT_KEY, JSON.stringify({ id: t.id, name: t.name }));
  else localStorage.removeItem(TENANT_KEY);
}
// Switch the managed account and HARD-RELOAD into its home page. A soft navigate is not
// enough: in-flight responses from the previous account can land after qc.clear() and
// repopulate the cache under the same query keys, and components that read getTenantMode()
// at render time keep stale flags unless remounted. A full reload makes the switch atomic.
export function switchAccount(t: TenantMode | null) {
  setTenantMode(t);
  window.location.assign('/');
}
function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', ...(extra || {}) };
  const t = getTenantMode();
  if (t) h['X-Tenant-Account'] = t.id;
  return h;
}

export const api = {
  get<T>(path: string, query?: Query): Promise<T> {
    return fetch(buildUrl(path, query), { headers: baseHeaders() }).then(handle<T>);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return fetch(path, {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(handle<T>);
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return fetch(path, {
      method: 'PUT',
      headers: baseHeaders({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(handle<T>);
  },
  del<T>(path: string): Promise<T> {
    return fetch(path, { method: 'DELETE', headers: baseHeaders() }).then(handle<T>);
  },
  // Raw binary POST (application/octet-stream) - the internal-backup upload sends encrypted file
  // bytes with the passphrase in a header, since a raw body can't carry JSON fields.
  postRaw<T>(path: string, body: ArrayBuffer | Uint8Array, extraHeaders?: Record<string, string>): Promise<T> {
    return fetch(path, {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/octet-stream', ...(extraHeaders || {}) }),
      body: body as BodyInit,
    }).then(handle<T>);
  },
  // version.txt is plain text, not JSON
  async version(): Promise<string> {
    try {
      const res = await fetch('/version.txt?' + Date.now());
      if (!res.ok) return '';
      return (await res.text()).trim();
    } catch { return ''; }
  },
};
