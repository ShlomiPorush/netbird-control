export function initials(name?: string): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

// Deterministic vivid color for an avatar initial (port of NetBird's generateColorFromString).
export function avatarColor(str?: string): string {
  if (!str) return '#f68330';
  if (str.includes('System')) return '#808080';
  if (str.toLowerCase().startsWith('netbird')) return '#f68330';
  let hash = 0;
  for (const ch of str) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 62%)`;
}

// Title-Case a STATUS/LABEL string for badge display: "temp device" -> "Temp Device",
// "ok" -> "OK", "p2p" -> "P2P". For fixed vocabulary only (statuses, kinds, roles) -
// NEVER run entity names (groups, networks, resources, tags) through this.
const UC_WORDS = new Set(['ok', 'ip', 'id', 'api', 'dns', 'tcp', 'udp', 'icmp', 'p2p', 'edr']);
export function ucLabel(s?: string): string {
  return String(s || '')
    .split(' ')
    .map((w) => (UC_WORDS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// MAC search: compare hex digits only, so "AA:BB", "aa-bb", "aabb" and "aabb.ccdd" all match the
// same interface. Only queries made of hex digits and MAC separators, with at least 4 hex digits,
// are treated as a MAC fragment - otherwise a short word would match every MAC on the fleet.
// An IPv4-shaped query (up to four 1-3 digit groups, e.g. 10.0 or 192.168.1.5) is an IP search,
// never a MAC fragment; digits-only MACs (001122334455, 0011.2233.4455) still match.
export function macQueryKey(q: string): string {
  const s = q.trim();
  if (!/^[0-9a-f:.-]+$/i.test(s) || /^\d{1,3}(\.\d{0,3}){0,3}$/.test(s)) return '';
  const hex = s.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.length >= 4 ? hex : '';
}

export function macMatches(mac: string | undefined, key: string): boolean {
  return !!key && !!mac && mac.replace(/[^0-9a-f]/gi, '').toLowerCase().includes(key);
}
