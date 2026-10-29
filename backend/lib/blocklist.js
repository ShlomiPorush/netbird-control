// Address blocklist (IPs / CIDRs / domains that may not be added as resources), extracted
// verbatim from db.js. Owns the blocklist CRUD (getBlocklist / add / update / delete) plus the
// pure address/CIDR/domain matching helpers (ipv4ToInt, parseCidr4, addressMatchesValue,
// entryAppliesToNetwork, addressBlockedForNetwork).
//
// parseCidr4/addressMatchesValue/entryAppliesToNetwork are also needed by code that STAYS in
// db.js (addrRange4's overlap check imports parseCidr4; scanBlockedResources/enforceBlockedResources
// import addressMatchesValue + entryAppliesToNetwork + getBlocklist). db.js -> lib/blocklist.js is
// the only dependency direction (blocklist.js requires only lib/core.js for the pool; never db.js).

const { pool } = require('./core');
// Per-tenant blocklist: every address_blocklist query filters on tnt() so a tenant sees ONLY
// its own rows ('' = main account). No cycle - netbird.js does not require blocklist.js.
const { currentTenantAccount } = require('./netbird');
const tnt = () => currentTenantAccount() || '';

// ─── Address blocklist (IPs / CIDRs / domains that may not be added as resources) ───
function ipv4ToInt(ip) {
    const m = String(ip || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const p = m.slice(1).map(Number);
    if (p.some(o => o > 255)) return null;
    return (p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]) >>> 0;
}

function parseCidr4(s) {
    const [host, bitsStr] = String(s || '').trim().split('/');
    const ip = ipv4ToInt(host);
    if (ip === null) return null;
    const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
    if (!(bits >= 0 && bits <= 32)) return null;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return { net: (ip & mask) >>> 0, mask };
}

// [start,end] range of an IPv4 or IPv4-CIDR address; null for domains / IPv6 (exact-match only).
function addrRange4(s) {
    const str = String(s || '').trim();
    if (!str || str.includes(':')) return null;
    const c = parseCidr4(str);
    if (!c) return null;
    return { start: c.net, end: (c.net + ((~c.mask) >>> 0)) >>> 0 };
}

// Smart overlap between two resource addresses - not just string equality:
//  - exact match (any kind, case-insensitive; `1.2.3.4` ≡ `1.2.3.4/32` via the range check)
//  - IPv4 range intersection: host inside a CIDR, CIDR inside a CIDR, or partial overlap
//  - domains: exact, or a `*.wildcard` covering the other side
function addressesOverlap(a, b) {
    const A = String(a || '').trim().toLowerCase(), B = String(b || '').trim().toLowerCase();
    if (!A || !B) return false;
    if (A === B) return true;
    const ra = addrRange4(A), rb = addrRange4(B);
    if (ra && rb) return ra.start <= rb.end && rb.start <= ra.end;
    if (ra || rb) return false; // one is an IP/CIDR, the other a domain - distinct
    const wild = (w, d) => w.startsWith('*.') && (d === w.slice(2) || d.endsWith(w.slice(1)));
    return wild(A, B) || wild(B, A);
}

// Same network location even when WRITTEN differently: 1.2.3.4 ≡ 1.2.3.4/32, identical
// CIDRs, case-insensitive domains. Stricter than addressesOverlap (a host inside a /24
// is an overlap but NOT equivalent) - equivalence means "this IS that resource", so
// automations ADOPT it instead of failing on the uniqueness guard.
function addressesEquivalent(a, b) {
    const A = String(a || '').trim().toLowerCase(), B = String(b || '').trim().toLowerCase();
    if (!A || !B) return false;
    if (A === B) return true;
    const ra = addrRange4(A), rb = addrRange4(B);
    return !!(ra && rb && ra.start === rb.start && ra.end === rb.end);
}

// Does a single blocklist value match an address?
// Match = exact (any), IPv4 CIDR containment, or domain (exact or subdomain).
function addressMatchesValue(address, value) {
    const cand = String(address || '').trim();
    const e = String(value || '').trim();
    if (!cand || !e) return false;
    const candLower = cand.toLowerCase();
    const candIp = ipv4ToInt(cand.split('/')[0]);
    if (e.toLowerCase() === candLower) return true; // exact (IPv6, domain, CIDR, IP)
    const cidr = parseCidr4(e);
    if (cidr && candIp !== null) {
        return ((candIp & cidr.mask) >>> 0) === cidr.net; // IPv4 CIDR containment
    }
    if (!cidr && ipv4ToInt(e) === null && !e.includes(':') && !e.includes('/')) {
        const el = e.toLowerCase(); // domain → block it and its subdomains
        return candLower === el || candLower.endsWith('.' + el);
    }
    return false;
}

// Does a blocklist entry apply to a given target network?
function entryAppliesToNetwork(entry, networkId) {
    const scope = entry.scope || 'all';
    if (scope === 'all') return true;
    const nets = Array.isArray(entry.networks) ? entry.networks : [];
    if (scope === 'only') return nets.includes(networkId);
    if (scope === 'except') return !nets.includes(networkId);
    return true;
}

// CIDR width (prefix bits) of an IPv4 address/CIDR string; null for domains/IPv6.
// A bare IP counts as /32.
function addressBits(s) {
    const str = String(s || '').trim();
    if (!str || str.includes(':') || !parseCidr4(str)) return null;
    const slash = str.split('/')[1];
    return slash === undefined ? 32 : parseInt(slash, 10);
}

// Does one entry (in its own mode) match a candidate address?
//  - 'block': classic containment/equality/subdomain matching.
//  - 'limit': the candidate is an IPv4/CIDR that overlaps the entry's range AND is
//    BROADER than the allowed max prefix (10.0.0.0/16 violates "10.0.0.0/8 max /24";
//    hosts and small subnets pass; domains are never affected).
function entryMatchesAddress(entry, address) {
    if (entry.mode === 'limit') {
        const bits = addressBits(address);
        if (bits === null) return false;
        const max = parseInt(entry.maxPrefix, 10);
        if (!Number.isFinite(max)) return false;
        return bits < max && addressesOverlap(address, entry.value);
    }
    return addressMatchesValue(address, entry.value);
}

// Human label for a matched entry - embedded verbatim in every "matches X on the
// blocklist" error message across the app.
function entryLabel(entry) {
    return entry.mode === 'limit' ? `${entry.value} (max /${entry.maxPrefix} allowed)` : entry.value;
}

// Returns the matched entry's label if `address` is blocked for `networkId`, else null.
// Disabled entries are inert - they stay configured but block nothing.
function addressBlockedForNetwork(address, networkId, entries) {
    for (const e of (entries || [])) {
        if (e.enabled === false) continue;
        if (!entryAppliesToNetwork(e, networkId)) continue;
        if (entryMatchesAddress(e, address)) return entryLabel(e);
    }
    return null;
}

function blocklistRowToApi(x) {
    return {
        id: x.id, value: x.value, note: x.note || '', scope: x.scope || 'all',
        networks: Array.isArray(x.networks) ? x.networks : [], enforce: x.enforce || 'none',
        enabled: x.enabled !== false,
        mode: x.mode === 'limit' ? 'limit' : 'block',
        maxPrefix: x.max_prefix == null ? undefined : Number(x.max_prefix),
    };
}

async function getBlocklist() {
    const r = await pool.query('SELECT id, value, note, scope, networks, enforce, enabled, mode, max_prefix FROM address_blocklist WHERE tenant = $1 ORDER BY value', [tnt()]);
    return r.rows.map(blocklistRowToApi);
}

function normalizeBlocklistCfg(cfg) {
    const c = cfg || {};
    const scope = ['all', 'only', 'except'].includes(c.scope) ? c.scope : 'all';
    const enforce = ['none', 'disable', 'delete'].includes(c.enforce) ? c.enforce : 'none';
    const networks = Array.isArray(c.networks) ? c.networks.map(String).filter(Boolean) : [];
    const value = String(c.value || '').trim();
    const mode = c.mode === 'limit' ? 'limit' : 'block';
    let maxPrefix = null;
    if (mode === 'limit') {
        if (!parseCidr4(value)) throw new Error('Limit mode requires an IPv4 address or CIDR range');
        maxPrefix = parseInt(c.maxPrefix, 10);
        if (!Number.isInteger(maxPrefix) || maxPrefix < 1 || maxPrefix > 32) throw new Error('Limit mode requires a max prefix between /1 and /32');
    }
    return { value, note: String(c.note || '').trim(), scope, networks: scope === 'all' ? [] : networks, enforce, enabled: c.enabled !== false, mode, maxPrefix };
}

async function addBlocklistEntry(cfg) {
    const c = normalizeBlocklistCfg(cfg);
    if (!c.value) throw new Error('value is required');
    const r = await pool.query(
        'INSERT INTO address_blocklist (value, note, scope, networks, enforce, enabled, mode, max_prefix, tenant) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
        [c.value, c.note, c.scope, JSON.stringify(c.networks), c.enforce, c.enabled, c.mode, c.maxPrefix, tnt()]
    );
    return { id: r.rows[0].id };
}

// Bulk add (e.g. addresses picked from a network's existing resources). Shared note/scope/
// networks/enforce for all values; values already on the list (exact, case-insensitive) are
// skipped instead of duplicated. Returns { added, skipped }.
async function addBlocklistEntries(values, cfg) {
    const list = [...new Set((Array.isArray(values) ? values : []).map(v => String(v || '').trim()).filter(Boolean))];
    if (!list.length) throw new Error('values is required');
    if (list.length > 500) throw new Error('Too many values (max 500 per request)');
    // Bulk-picked addresses are always classic BLOCK entries - a width limit makes no
    // sense for a list of existing concrete addresses.
    const base = normalizeBlocklistCfg({ ...(cfg || {}), value: 'placeholder', mode: 'block' });
    const existing = new Set((await getBlocklist()).map(e => String(e.value).toLowerCase()));
    let added = 0, skipped = 0;
    for (const value of list) {
        if (existing.has(value.toLowerCase())) { skipped++; continue; }
        await pool.query(
            'INSERT INTO address_blocklist (value, note, scope, networks, enforce, enabled, mode, max_prefix, tenant) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [value, base.note, base.scope, JSON.stringify(base.networks), base.enforce, base.enabled, 'block', null, tnt()]
        );
        existing.add(value.toLowerCase());
        added++;
    }
    return { added, skipped };
}

async function updateBlocklistEntry(id, cfg) {
    const c = normalizeBlocklistCfg(cfg);
    if (!c.value) throw new Error('value is required');
    await pool.query(
        'UPDATE address_blocklist SET value=$2, note=$3, scope=$4, networks=$5, enforce=$6, enabled=$7, mode=$8, max_prefix=$9 WHERE id=$1 AND tenant=$10',
        [id, c.value, c.note, c.scope, JSON.stringify(c.networks), c.enforce, c.enabled, c.mode, c.maxPrefix, tnt()]
    );
}

async function deleteBlocklistEntry(id) {
    await pool.query('DELETE FROM address_blocklist WHERE id = $1 AND tenant = $2', [id, tnt()]);
}

module.exports = {
    getBlocklist, addBlocklistEntry, addBlocklistEntries, updateBlocklistEntry, deleteBlocklistEntry,
    addressBlockedForNetwork,
    // Matching helpers db.js still needs: parseCidr4 (addrRange4's overlap check),
    // addressMatchesValue + entryAppliesToNetwork (scanBlockedResources/enforceBlockedResources).
    parseCidr4, addressMatchesValue, entryAppliesToNetwork, entryMatchesAddress, entryLabel,
    // Smart resource-address overlap - used by db.js's uniqueness guard AND the
    // automations dry-run (which must predict that guard's verdict).
    addrRange4, addressesOverlap, addressesEquivalent,
};
