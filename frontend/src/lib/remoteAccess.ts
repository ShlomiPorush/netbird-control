// Browser remote access (RDP / SSH through the Browser Gateway): API shapes, calls, and the
// loaders for the official Apache Guacamole client library (served unmodified from
// /vendor/guacamole-common-js-1.6.0/, matched to the guacd 1.6.0 image) and its on-screen keyboard.
import { api, ApiError } from '@/lib/api';

export type RemoteProtocol = 'rdp' | 'ssh';

export interface RemoteInfo {
  available: boolean;
  allowed: boolean;
  ssoRequired: boolean;
  /** Remote access is getting ready (after a restart or a change): a launch link waits. */
  settling?: boolean;
  clipboard: boolean;
  idleTimeoutMin: number;
  maxDurationHours: number;
}

export interface RemoteStep {
  /** 'ready': remote access itself (sent only when it fails). */
  key: 'ready' | 'access' | 'path';
  status: 'pass' | 'fail';
  /** The failure passes by itself soon: check again in a moment. */
  retry?: boolean;
  code?: string;
  message?: string;
  detail?: string;
  requestable?: boolean;
  troubleshoot?: boolean;
  /** Nothing in NetBird covers the target: it can be added as a resource (with this address). */
  addable?: boolean;
  suggest?: { address: string };
}

/** A network "Add As Resource" may add to: open to Remote Access, and the user may edit it. */
export interface RemoteAddNetwork { id: string; name: string }

export type ServiceState = 'up' | 'down' | 'unknown';
/** The service status line; namesGateway only when that gateway is set up. */
export interface RemoteHealth { netbird: ServiceState; gateway: ServiceState; namesGateway?: ServiceState }

export interface RemoteCheck {
  steps: RemoteStep[];
  ok?: boolean;
  target?: {
    protocol: RemoteProtocol; address: string; port: number;
    /** The host name the user typed (normalized), when they typed one. */
    name?: string;
    /** 'names': the name goes through the names gateway; 'ip': the address shown is the IP used. */
    gateway?: 'ip' | 'names';
    resource: { id: string; name: string; address: string; type: string } | null;
    network: { id: string; name: string } | null;
  };
}

export interface RemoteSession {
  sessionId: string;
  token: string;
  resource: { id: string; name: string; address: string };
  network: { id: string; name: string };
  address?: string;
  name?: string;
  gateway?: 'ip' | 'names';
}

export interface RdpDisplay {
  colorDepth: number;
  fontSmoothing: boolean;
  wallpaper: boolean;
  theming: boolean;
  fullWindowDrag: boolean;
  desktopComposition: boolean;
  menuAnimations: boolean;
  serverLayout: string;
}

export interface SshTerminal {
  fontSize: number;
  colorScheme: string;
}

export interface RemoteAccessConfig {
  enabled: boolean;
  allowAll: boolean;
  guacdHost: string;
  guacdPort: number;
  namesGuacdHost: string;
  namesGuacdPort: number;
  networks: string[];
  maxSessionsPerUser: number;
  maxSessionsTotal: number;
  idleTimeoutMin: number;
  maxDurationHours: number;
  /** How long a server a session opened stays open to its gateway (1-72 hours). */
  holdHours: number;
  clipboard: boolean;
  sshHostKeys: Record<string, string>;
  rdp: RdpDisplay;
  ssh: SshTerminal;
  /** What guacd accepts, for the settings form. */
  options?: { rdpLayouts: string[]; rdpColorDepths: number[]; sshColorSchemes: string[] };
  managed?: { gatewayGroupId: string; targetGroupId: string; policyId: string };
  lastApply?: { at: string | null; error: string };
  ssoEnabled?: boolean;
  readonly?: boolean;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  activeSessions: number;
  guacdReachable: boolean | null;
  gateway: { enrolled: boolean; online: boolean; peers: { id: string; name: string; connected: boolean; ip: string }[] };
  domainRoutes: { name: string; address: string; network: string }[];
  extraReach: { name: string; address: string; network: string }[];
  targets: number;
  reachError?: string;
  error: string;
  names: {
    guacdReachable: boolean | null;
    gateway: { enrolled: boolean; online: boolean; peers: { id: string; name: string; connected: boolean; ip: string }[] };
    extraReach: { name: string; address: string; network: string }[];
    targets: number;
    reachError?: string;
  };
  conflicts: { address: string; networks: string[] }[];
  lastApply: { at: string | null; error: string };
  // Members added to the managed groups outside the app, and taken out again (newest first).
  membership?: { at: string | null; error: string; removed: { at: string; kind: 'user' | 'device'; name: string; group: string }[] };
  // Servers that sessions opened to the gateways and that are still held (in use first).
  held?: HeldTarget[];
}

export interface HeldTarget {
  resourceId: string;
  name: string;
  address: string;
  network: string;
  /** A session of the instance that answered uses it right now. */
  inUse: boolean;
  expiresAt: string;
}

// What the user typed or pasted into the address field, cleaned to what the field is for: a
// pasted link keeps only its host ("https://server.example.com:3389/x?y" -> server.example.com,
// port 3389), and "host:port" moves the port to the port field. The server still checks the
// result strictly; this only saves the user from editing it by hand.
export function cleanAddressInput(raw: string): { address: string; port?: string } {
  let s = String(raw || '').trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\\+/, '');
  s = s.split(/[/?#\\]/)[0];
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith('[')) return { address: s };
  const m = /^([^:]+):(\d{1,5})$/.exec(s);
  if (m) return { address: m[1], port: String(Number(m[2])) };
  return { address: s.replace(/:$/, '') };
}

// The server's own text for a failed request, or the fallback when it sent none that fits: an
// answer without a message (a proxy's 502 reads only "HTTP 502") or a generic server error.
export const apiText = (err: unknown, fallback: string) =>
  (err instanceof ApiError && (err.code || err.status < 500) && !/^HTTP \d+$/.test(err.message) ? err.message : fallback);

export const remoteApi = {
  info: (signal?: AbortSignal) => api.get<RemoteInfo>('/api/remote-access/info', undefined, signal),
  check: (body: { protocol: RemoteProtocol; address: string; port: number }) => api.post<RemoteCheck>('/api/remote-access/check', body),
  addNetworks: () => api.get<{ networks: RemoteAddNetwork[] }>('/api/remote-access/add-networks'),
  health: (signal?: AbortSignal) => api.get<RemoteHealth>('/api/remote-access/health', undefined, signal),
  createSession: (body: Record<string, unknown>) => api.post<RemoteSession>('/api/remote-access/sessions', body),
  lease: (id: string) => api.post<{ ok: boolean }>(`/api/remote-access/sessions/${encodeURIComponent(id)}/lease`, {}),
  end: (id: string) => api.del<{ ok: boolean }>(`/api/remote-access/sessions/${encodeURIComponent(id)}`),
  config: () => api.get<RemoteAccessConfig>('/api/remote-access/config'),
  saveConfig: (cfg: Partial<RemoteAccessConfig>) => api.put<{ config: RemoteAccessConfig; sync: { removed: number } | null }>('/api/remote-access/config', cfg),
  status: () => api.get<RemoteAccessStatus>('/api/remote-access/status'),
  setupKey: (kind: 'ip' | 'names') => api.post<{ key: string; expires: string; name: string }>('/api/remote-access/setup-key', { kind }),
  /** Open a launch link from another system. Only the ticket and the screen size are sent. */
  redeemLaunch: (body: { ticket: string; width: number; height: number; dpi: number; timezone: string }) =>
    api.post<LaunchSession>('/api/remote-access/launch/redeem', body),
};

/** A session opened from a launch link: the server sends what the browser needs to show it. */
export interface LaunchSession extends RemoteSession {
  protocol: RemoteProtocol;
  port: number;
  /** The credentials came from the other system and went to the server directly. */
  serverCredentials: true;
}

// ─── API keys (Settings → API Keys) ───
export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  allowedIps: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string;
  revokedAt: string | null;
  revokedBy: string;
}
export const apiKeysApi = {
  list: () => api.get<{ keys: ApiKey[]; scopes: { id: string; label: string }[]; trustProxy: boolean }>('/api/api-keys'),
  create: (body: { name: string; scopes: string[]; allowedIps: string; expiresAt: string | null }) =>
    api.post<{ key: string; apiKey: ApiKey }>('/api/api-keys', body),
  revoke: (id: number) => api.post<{ ok: boolean }>(`/api/api-keys/${id}/revoke`, {}),
};

// ─── Guacamole (global from the vendored script) ───
// Only the parts this app uses are typed.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface GuacStatus { code: number; message: string }
export type Guac = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const GUAC_SRC = '/vendor/guacamole-common-js-1.6.0/all.min.js';
let guacLoading: Promise<Guac> | null = null;

export function loadGuacamole(): Promise<Guac> {
  const w = window as unknown as { Guacamole?: Guac };
  if (w.Guacamole) return Promise.resolve(w.Guacamole);
  if (guacLoading) return guacLoading;
  guacLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GUAC_SRC;
    s.async = true;
    s.onload = () => (w.Guacamole ? resolve(w.Guacamole) : reject(new Error('The remote session library did not load.')));
    s.onerror = () => { guacLoading = null; reject(new Error('The remote session library could not be loaded.')); };
    document.head.appendChild(s);
  });
  return guacLoading;
}

// The official on-screen keyboard's US layout and stylesheet, from the Guacamole web client of the
// same release (served unmodified from /vendor/guacamole-client-1.6.0/).
const OSK_BASE = '/vendor/guacamole-client-1.6.0/';
let oskLoading: Promise<Guac> | null = null;

export function loadKeyboardLayout(): Promise<Guac> {
  if (!document.querySelector('link[data-guac-osk]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = OSK_BASE + 'osk.css';
    l.dataset.guacOsk = '1';
    document.head.appendChild(l);
  }
  oskLoading ||= fetch(OSK_BASE + 'en-us-qwerty.json')
    .then((r) => { if (!r.ok) throw new Error('The keyboard could not be loaded.'); return r.json(); })
    .catch((e) => { oskLoading = null; throw e; });
  return oskLoading;
}

// Guacamole status codes the UI explains in its own words.
export const GUAC = {
  SUCCESS: 0x0000,
  SERVER_ERROR: 0x0200,
  UPSTREAM_TIMEOUT: 0x0202,
  UPSTREAM_ERROR: 0x0203,
  RESOURCE_CONFLICT: 0x0205,
  UPSTREAM_NOT_FOUND: 0x0207,
  UPSTREAM_UNAVAILABLE: 0x0208,
  SESSION_TIMEOUT: 0x020A,
  SESSION_CLOSED: 0x020B,
  CLIENT_UNAUTHORIZED: 0x0301,
  CLIENT_FORBIDDEN: 0x0303,
  CLIENT_TIMEOUT: 0x0308,
} as const;

// Codes whose message comes from NetBird Control itself (clear text, shown as is).
export const PORTAL_MESSAGE_CODES = new Set<number>([GUAC.CLIENT_FORBIDDEN, GUAC.UPSTREAM_UNAVAILABLE, GUAC.SESSION_TIMEOUT, GUAC.CLIENT_TIMEOUT, GUAC.RESOURCE_CONFLICT]);
