// Client-side mirror of the backend blocklist matcher (exact + IPv4 CIDR + domain),
// for instant feedback in the resource form. The backend is the authority.

function ipv4ToInt(ip: string): number | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((o) => o > 255)) return null;
  return (p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]) >>> 0;
}

function parseCidr4(s: string): { net: number; mask: number } | null {
  const [host, bitsStr] = s.trim().split('/');
  const ip = ipv4ToInt(host);
  if (ip === null) return null;
  const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
  if (!(bits >= 0 && bits <= 32)) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (ip & mask) >>> 0, mask };
}

import type { BlocklistEntry } from './types';

/** Does a single blocklist value match an address? (exact / IPv4 CIDR / domain) */
function addressMatchesValue(address: string, value: string): boolean {
  const cand = (address || '').trim();
  const e = (value || '').trim();
  if (!cand || !e) return false;
  const candLower = cand.toLowerCase();
  const candIp = ipv4ToInt(cand.split('/')[0]);
  if (e.toLowerCase() === candLower) return true;
  const cidr = parseCidr4(e);
  if (cidr && candIp !== null) return ((candIp & cidr.mask) >>> 0) === cidr.net;
  if (!cidr && ipv4ToInt(e) === null && !e.includes(':') && !e.includes('/')) {
    const el = e.toLowerCase();
    return candLower === el || candLower.endsWith('.' + el);
  }
  return false;
}

function entryAppliesToNetwork(entry: BlocklistEntry, networkId: string): boolean {
  const scope = entry.scope || 'all';
  if (scope === 'all') return true;
  const nets = entry.networks || [];
  if (scope === 'only') return nets.includes(networkId);
  if (scope === 'except') return !nets.includes(networkId);
  return true;
}

/** CIDR width of an IPv4 address/CIDR (bare IP = /32); null for domains/IPv6. */
function addressBits(s: string): number | null {
  const str = (s || '').trim();
  if (!str || str.includes(':') || !parseCidr4(str)) return null;
  const slash = str.split('/')[1];
  return slash === undefined ? 32 : parseInt(slash, 10);
}

/** One entry vs one candidate, honoring the entry's mode (mirrors the backend). */
function entryMatchesAddress(entry: BlocklistEntry, address: string): boolean {
  if (entry.mode === 'limit') {
    const bits = addressBits(address);
    if (bits === null || !entry.maxPrefix) return false;
    return bits < entry.maxPrefix && addressesOverlap(address, entry.value);
  }
  return addressMatchesValue(address, entry.value);
}

/** Returns the matched entry's label if `address` is blocked for `networkId`, else null.
 *  Disabled entries are inert (mirrors the backend). */
export function addressBlockedForNetwork(address: string, networkId: string, entries: BlocklistEntry[]): string | null {
  for (const e of entries || []) {
    if (e.enabled === false) continue;
    if (!entryAppliesToNetwork(e, networkId)) continue;
    if (entryMatchesAddress(e, address)) return e.mode === 'limit' ? `${e.value} (max /${e.maxPrefix} allowed)` : e.value;
  }
  return null;
}

// [start,end] of an IPv4 / IPv4-CIDR address; null for domains / IPv6 (exact-match only).
function addrRange4(s: string): { start: number; end: number } | null {
  const str = (s || '').trim();
  if (!str || str.includes(':')) return null;
  const c = parseCidr4(str);
  if (!c) return null;
  return { start: c.net, end: (c.net + (~c.mask >>> 0)) >>> 0 };
}

/**
 * Smart overlap between two resource addresses (mirror of the backend check) - not just string
 * equality: `1.2.3.4` ≡ `1.2.3.4/32`, a host inside an existing CIDR, intersecting CIDRs, and
 * wildcard-domain coverage all count as overlapping.
 */
export function addressesOverlap(a: string, b: string): boolean {
  const A = (a || '').trim().toLowerCase(), B = (b || '').trim().toLowerCase();
  if (!A || !B) return false;
  if (A === B) return true;
  const ra = addrRange4(A), rb = addrRange4(B);
  if (ra && rb) return ra.start <= rb.end && rb.start <= ra.end;
  if (ra || rb) return false; // one IP/CIDR, one domain - distinct
  const wild = (w: string, d: string) => w.startsWith('*.') && (d === w.slice(2) || d.endsWith(w.slice(1)));
  return wild(A, B) || wild(B, A);
}
