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
// Only the tenant id is kept, in sessionStorage: it survives the switch's hard reload and the
// OIDC login round trip, but it is scoped to ONE tab - a switch in one tab never redirects
// another open tab's writes to a different account. The display name is resolved from the
// tenant lists (see TopBar); the top-bar chip is the visible indicator.
//
// The account is fixed for the lifetime of the page: it is read once when the page loads, and every
// request from this page uses it. Once a switch starts, this page sends nothing more, so a save that
// fires while the reload is pending can never reach the account being switched to (or main).
//
// Older builds kept { id, name } in localStorage under the same key, shared by every tab. It is
// ignored and deliberately left alone: deleting it would silently move a tab that still runs an
// older build, and is managing a tenant, onto the main account.
export interface TenantMode { id: string }
const TENANT_KEY = 'msp-tenant';
function readTenantMode(): TenantMode | null {
  try {
    const id = sessionStorage.getItem(TENANT_KEY);
    return id ? { id } : null;
  } catch { return null; }
}
const PAGE_TENANT: TenantMode | null = readTenantMode();
let switching = false;
export function getTenantMode(): TenantMode | null {
  return PAGE_TENANT;
}
function setTenantMode(t: TenantMode | null) {
  if (t) sessionStorage.setItem(TENANT_KEY, t.id);
  else sessionStorage.removeItem(TENANT_KEY);
}
// Switch the managed account and HARD-RELOAD into its home page. A soft navigate is not
// enough: in-flight responses from the previous account can land after qc.clear() and
// repopulate the cache under the same query keys, and components that read getTenantMode()
// at render time keep stale flags unless remounted. A full reload makes the switch atomic.
export function switchAccount(t: TenantMode | null) {
  switching = true;
  try {
    setTenantMode(t);
  } catch {
    // Storage is blocked (for example site data disabled): the switch can't be remembered across
    // the reload, so cancel it and keep this page working on its current account.
    switching = false;
    window.alert("Couldn't switch the account: this browser blocks site storage for this app. Allow it and try again.");
    return;
  }
  window.location.assign('/');
}
function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', ...(extra || {}) };
  if (PAGE_TENANT) h['X-Tenant-Account'] = PAGE_TENANT.id;
  return h;
}
// Every request goes through here: refused while an account switch is reloading the page.
function send(input: string, init: RequestInit): Promise<Response> {
  if (switching) return Promise.reject(new ApiError(409, 'Switching account - the page is reloading'));
  return fetch(input, init);
}

export const api = {
  get<T>(path: string, query?: Query): Promise<T> {
    return send(buildUrl(path, query), { headers: baseHeaders() }).then(handle<T>);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return send(path, {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(handle<T>);
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return send(path, {
      method: 'PUT',
      headers: baseHeaders({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(handle<T>);
  },
  del<T>(path: string): Promise<T> {
    return send(path, { method: 'DELETE', headers: baseHeaders() }).then(handle<T>);
  },
  // Raw binary POST (application/octet-stream) - the internal-backup upload sends encrypted file
  // bytes with the passphrase in a header, since a raw body can't carry JSON fields.
  postRaw<T>(path: string, body: ArrayBuffer | Uint8Array, extraHeaders?: Record<string, string>): Promise<T> {
    return send(path, {
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
