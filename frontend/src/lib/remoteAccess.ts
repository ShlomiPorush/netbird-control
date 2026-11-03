// Browser remote access (RDP / SSH through the Browser Gateway): API shapes, calls, and the
// loader for the official Apache Guacamole client library (served unmodified from
// /vendor/guacamole-common-js-1.6.0/, matched to the guacd 1.6.0 image).
import { api } from '@/lib/api';

export type RemoteProtocol = 'rdp' | 'ssh';

export interface RemoteInfo {
  available: boolean;
  allowed: boolean;
  ssoRequired: boolean;
  clipboard: boolean;
  idleTimeoutMin: number;
  maxDurationHours: number;
}

export interface RemoteStep {
  key: 'access' | 'path';
  status: 'pass' | 'fail';
  code?: string;
  message?: string;
  detail?: string;
  requestable?: boolean;
  troubleshoot?: boolean;
}

export interface RemoteCheck {
  steps: RemoteStep[];
  ok?: boolean;
  target?: {
    protocol: RemoteProtocol; address: string; port: number;
    resource: { id: string; name: string; address: string; type: string } | null;
    network: { id: string; name: string } | null;
  };
}

export interface RemoteSession {
  sessionId: string;
  token: string;
  resource: { id: string; name: string; address: string };
  network: { id: string; name: string };
}

export interface RemoteAccessConfig {
  enabled: boolean;
  allowAll: boolean;
  guacdHost: string;
  guacdPort: number;
  networks: string[];
  maxSessionsPerUser: number;
  maxSessionsTotal: number;
  idleTimeoutMin: number;
  maxDurationHours: number;
  clipboard: boolean;
  sshHostKeys: Record<string, string>;
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
  error: string;
  lastApply: { at: string | null; error: string };
}

export const remoteApi = {
  info: () => api.get<RemoteInfo>('/api/remote-access/info'),
  check: (body: { protocol: RemoteProtocol; address: string; port: number }) => api.post<RemoteCheck>('/api/remote-access/check', body),
  createSession: (body: Record<string, unknown>) => api.post<RemoteSession>('/api/remote-access/sessions', body),
  lease: (id: string) => api.post<{ ok: boolean }>(`/api/remote-access/sessions/${encodeURIComponent(id)}/lease`, {}),
  end: (id: string) => api.del<{ ok: boolean }>(`/api/remote-access/sessions/${encodeURIComponent(id)}`),
  config: () => api.get<RemoteAccessConfig>('/api/remote-access/config'),
  saveConfig: (cfg: Partial<RemoteAccessConfig>) => api.put<{ config: RemoteAccessConfig; sync: { added: number; removed: number } | null }>('/api/remote-access/config', cfg),
  status: () => api.get<RemoteAccessStatus>('/api/remote-access/status'),
  setupKey: () => api.post<{ key: string; expires: string; name: string }>('/api/remote-access/setup-key', {}),
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
