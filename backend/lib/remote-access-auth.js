'use strict';
// Pure authorization for browser remote sessions (RDP / SSH through the Browser Gateway).
//
// No I/O here: every input arrives in `snap`, a freshly fetched NetBird snapshot plus the
// temporary-grant rows. The portal - not NetBird - decides per session, because NetBird sees
// every browser session as traffic from the gateway peer. So this code must FAIL CLOSED:
// anything it does not positively understand does not grant access.
//
// What it answers:
//   normalizeTarget     - is the typed address an IPv4 address, a valid host name, or neither?
//   evaluateUserAccess  - may this user open a session to ip:port (TCP) right now?
//   evaluateNameAccess  - may this user open a session to name:port through a NetBird domain
//                         resource (on the names gateway) right now?
//   gatewayReach        - every address the gateway peer can route to, used to prove that the
//                         approved resource is the ONLY route the gateway would take to the ip.
//   pathStatus          - is the gateway online, and is a routing peer of the network online?

const TEMP_POLICY_RE = /^Temporary access #(\d+)(?: \(\d+\))?$/;
const TEMP_GROUP_RE = /^Temp (?:access|resources) #(\d+)(?:\D|$)/;

const { domainToASCII } = require('url');

const idOf = (x) => (x && typeof x === 'object') ? x.id : x;
const arr = (v) => (Array.isArray(v) ? v : []);

// Strict dotted-quad IPv4 (no leading zeros, no shorthand) → uint32, else null.
function ipv4ToInt(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim());
    if (!m) return null;
    const parts = m.slice(1);
    if (parts.some(p => (p.length > 1 && p[0] === '0') || Number(p) > 255)) return null;
    return parts.reduce((acc, p) => (acc * 256) + Number(p), 0) >>> 0;
}

// "10.0.0.5", "10.0.0.5/32" or "10.0.0.0/24" → { start, end, bits }, else null (domains, IPv6).
function parsePrefix(addr) {
    const str = String(addr || '').trim();
    if (!str || str.includes(':')) return null;
    const [host, bitsStr, extra] = str.split('/');
    if (extra !== undefined) return null;
    const ip = ipv4ToInt(host);
    if (ip === null) return null;
    let bits = 32;
    if (bitsStr !== undefined) {
        if (!/^\d{1,2}$/.test(bitsStr)) return null;
        bits = Number(bitsStr);
        if (bits > 32) return null;
    }
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    const start = (ip & mask) >>> 0;
    return { start, end: (start + ((~mask) >>> 0)) >>> 0, bits };
}

const prefixCovers = (p, ip) => !!p && ip >= p.start && ip <= p.end;

function grantIsValid(g, now) {
    if (!g || g.status !== 'active' || g.revoke_requested_at) return false;
    const exp = g.expires_at ? new Date(g.expires_at).getTime() : NaN;
    return Number.isFinite(exp) && exp > now;
}

function allGroupIds(snap) {
    return arr(snap.groups).filter(g => g && g.name === 'All').map(g => g.id);
}

// The user's effective source groups: their own auto_groups, the groups of every peer they
// own, and the implicit "All" group. Groups that only exist because of a temporary grant
// count only while that grant is valid (active, not expired, no revoke attempted).
function userSourceGroups(snap, userId, now) {
    const user = arr(snap.users).find(u => u && u.id === userId);
    if (!user) return { error: 'USER_NOT_FOUND' };
    if (user.is_blocked || user.status === 'blocked') return { error: 'USER_BLOCKED' };
    const groups = new Set();
    for (const g of arr(user.auto_groups)) if (idOf(g)) groups.add(idOf(g));
    for (const p of arr(snap.peers)) {
        if (!p || p.user_id !== userId) continue;
        for (const g of arr(p.groups)) if (idOf(g)) groups.add(idOf(g));
    }
    for (const id of allGroupIds(snap)) groups.add(id);

    const grants = arr(snap.grants);
    const grantById = new Map(grants.map(g => [String(g.id), g]));
    const held = (g) => [g.group_id, ...arr(g.assigned_groups)].filter(Boolean);
    const validHeld = new Set();
    const invalidHeld = new Set();
    for (const g of grants) {
        if (!g || g.user_id !== userId) continue;
        for (const gid of held(g)) (grantIsValid(g, now) ? validHeld : invalidHeld).add(gid);
    }
    for (const gid of invalidHeld) if (!validHeld.has(gid)) groups.delete(gid);
    // A temp group whose row never recorded its id (interrupted creation) is still named
    // "Temp access #<id> …": it counts only through a valid grant of that id.
    const nameOf = new Map(arr(snap.groups).map(g => [g.id, g.name || '']));
    for (const gid of [...groups]) {
        const m = TEMP_GROUP_RE.exec(nameOf.get(gid) || '');
        if (m && !grantIsValid(grantById.get(m[1]), now)) groups.delete(gid);
    }
    return { groups, user };
}

// Does this rule open TCP `port`? Unknown shapes never do.
function ruleOpensTcpPort(rule, port) {
    const proto = String(rule.protocol || '').toLowerCase();
    if (proto !== 'tcp' && proto !== 'all') return false;
    if (rule.ports !== undefined && rule.ports !== null && !Array.isArray(rule.ports)) return false;
    if (rule.port_ranges !== undefined && rule.port_ranges !== null && !Array.isArray(rule.port_ranges)) return false;
    const ports = arr(rule.ports);
    const ranges = arr(rule.port_ranges);
    if (!ports.length && !ranges.length) return true;
    for (const tok of ports) {
        const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(String(tok).trim());
        if (!m) continue;
        const a = Number(m[1]);
        const b = m[2] ? Number(m[2]) : a;
        if (port >= a && port <= b) return true;
    }
    for (const r of ranges) {
        const a = Number(r && r.start), b = Number(r && r.end);
        if (Number.isInteger(a) && Number.isInteger(b) && port >= a && port <= b) return true;
    }
    return false;
}

function ruleTargetsResource(rule, res) {
    if (idOf(rule.destinationResource) && idOf(rule.destinationResource) === res.id) return true;
    const resGroups = new Set(arr(res.groups).map(idOf).filter(Boolean));
    return arr(rule.destinations).some(d => resGroups.has(idOf(d)));
}

const ruleIsUsable = (rule) => rule && rule.enabled !== false && Array.isArray(rule.sources);

function networkIndex(snap) {
    const netOf = new Map();
    for (const n of arr(snap.networks)) for (const rid of arr(n.resources)) netOf.set(idOf(rid), n);
    return netOf;
}

// Every address the gateway peer can route to: resources reached by any enabled policy whose
// sources include one of the gateway's groups (including the implicit "All"), plus legacy
// network routes distributed to those groups. Domain-based routes cannot be bounded to
// addresses, so they are reported separately and block every session (fail closed).
function gatewayReach(snap, cfg) {
    const gwGroup = cfg && cfg.gatewayGroupId;
    const gwPeers = gwGroup ? arr(snap.peers).filter(p => p && arr(p.groups).some(g => idOf(g) === gwGroup)) : [];
    if (!gwPeers.length) return { error: 'GATEWAY_NOT_ENROLLED', entries: [], domain: [], peers: [] };
    const gwGroups = new Set(allGroupIds(snap));
    for (const p of gwPeers) for (const g of arr(p.groups)) if (idOf(g)) gwGroups.add(idOf(g));

    const netOf = networkIndex(snap);
    const selected = new Set(arr(cfg.networks));
    const entries = new Map();
    const domain = new Map();
    const addResource = (res) => {
        if (!res || res.enabled === false) return;
        const net = netOf.get(res.id);
        const prefix = parsePrefix(res.address);
        const base = { kind: 'resource', id: res.id, name: res.name || res.address || res.id, address: res.address || '', networkId: net ? net.id : '', networkName: net ? (net.name || net.id) : '' };
        if (prefix) entries.set('r:' + res.id, { ...base, prefix, selected: selected.has(base.networkId) });
        else domain.set('r:' + res.id, { ...base, domains: [res.address || ''], selected: selected.has(base.networkId) });
    };
    const resources = arr(snap.resources);
    for (const p of arr(snap.policies)) {
        if (!p || p.enabled === false) continue;
        for (const rule of arr(p.rules)) {
            if (!ruleIsUsable(rule) || (rule.action && rule.action !== 'accept')) continue;
            if (!rule.sources.some(s => gwGroups.has(idOf(s)))) continue;
            for (const res of resources) if (res && ruleTargetsResource(rule, res)) addResource(res);
        }
    }
    for (const r of arr(snap.routes)) {
        if (!r || r.enabled === false) continue;
        if (!arr(r.groups).some(g => gwGroups.has(idOf(g)))) continue;
        const base = { kind: 'route', id: r.id, name: r.network_id || r.description || r.id, address: r.network || arr(r.domains).join(', '), networkId: '', networkName: '' };
        if (arr(r.domains).length) { domain.set('l:' + r.id, { ...base, domains: arr(r.domains), selected: false }); continue; }
        const prefix = parsePrefix(r.network);
        if (prefix) entries.set('l:' + r.id, { ...base, prefix, selected: false });
    }
    return { entries: [...entries.values()], domain: [...domain.values()], peers: gwPeers };
}

// Reach outside the admin's selection (widens the gateway's ceiling) - shown as a warning.
function extraReach(reach) {
    return arr(reach.entries).filter(e => !e.selected);
}

function evaluateUserAccess(snap, cfg, { userId, address, port, now = Date.now() }) {
    const deny = (code, extra = {}) => ({ ok: false, code, ...extra });
    const ip = ipv4ToInt(address);
    if (ip === null) return deny('INVALID_ADDRESS');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return deny('INVALID_PORT');

    const src = userSourceGroups(snap, userId, now);
    if (src.error) return deny(src.error);

    // The approved resource: the most specific host/subnet resource covering the ip in a
    // network the admin opened to browser access.
    const netOf = networkIndex(snap);
    const selected = new Set(arr(cfg.networks));
    let best = null;
    let coveredElsewhere = false;
    for (const res of arr(snap.resources)) {
        if (!res) continue;
        const prefix = parsePrefix(res.address);
        if (!prefix || !prefixCovers(prefix, ip)) continue;
        const net = netOf.get(res.id);
        if (!net || !selected.has(net.id)) { coveredElsewhere = true; continue; }
        if (!best || prefix.bits > best.prefix.bits) best = { res, net, prefix };
        else if (prefix.bits === best.prefix.bits) best.tie = true;
    }
    if (!best) return deny(coveredElsewhere ? 'NETWORK_NOT_ENABLED' : 'UNKNOWN_ADDRESS');
    const resource = { id: best.res.id, name: best.res.name || best.res.address, address: best.res.address, type: best.res.type || '' };
    const network = { id: best.net.id, name: best.net.name || best.net.id };
    if (best.tie) return deny('AMBIGUOUS_ROUTE', { resource, network });
    if (best.res.enabled === false) return deny('RESOURCE_DISABLED', { resource, network });

    // The gateway must route this ip through the approved resource and nothing else: no
    // domain routes (unbounded), and no other route at least as specific as the resource.
    const reach = gatewayReach(snap, cfg);
    if (reach.error) return deny(reach.error, { resource, network });
    if (reach.domain.length) return deny('GATEWAY_DOMAIN_ROUTES', { resource, network });
    const inReach = reach.entries.some(e => e.kind === 'resource' && e.id === best.res.id);
    if (!inReach) return deny('GATEWAY_NOT_SYNCED', { resource, network });
    const rival = reach.entries.some(e => !(e.kind === 'resource' && e.id === best.res.id)
        && prefixCovers(e.prefix, ip) && e.prefix.bits >= best.prefix.bits);
    if (rival) return deny('AMBIGUOUS_ROUTE', { resource, network });

    return evaluatePolicies(snap, cfg, src, best.res, port, now, { resource, network });
}

// The managed gateway policies are infrastructure, never a user's access: matched by id, and by
// name for one whose id was not saved yet (re-created after a deletion, then interrupted).
const MANAGED_POLICY_NAMES = new Set(['Browser Gateway', 'Browser Gateway (Names)']);
function managedPolicyIds(cfg) {
    return new Set([cfg && cfg.managedPolicyId, ...arr(cfg && cfg.managedPolicyIds)].filter(Boolean));
}

// Policies: an enabled accept rule from one of the user's groups to this resource that opens
// the TCP port. Posture-checked policies cannot be evaluated for a browser session and do not
// count. A matching drop rule wins.
function evaluatePolicies(snap, cfg, src, res, port, now, where) {
    const deny = (code, extra = {}) => ({ ok: false, code, ...where, ...extra });
    const managed = managedPolicyIds(cfg);
    const grantById = new Map(arr(snap.grants).map(g => [String(g.id), g]));
    const granting = [];
    let postureOnly = false;
    let portMismatch = false;
    for (const p of arr(snap.policies)) {
        if (!p || p.enabled === false || managed.has(p.id) || MANAGED_POLICY_NAMES.has(p.name)) continue;
        const tm = TEMP_POLICY_RE.exec(p.name || '');
        if (tm && !grantIsValid(grantById.get(tm[1]), now)) continue;
        const posture = arr(p.source_posture_checks).length > 0;
        for (const rule of arr(p.rules)) {
            if (!ruleIsUsable(rule)) continue;
            if (!rule.sources.some(s => src.groups.has(idOf(s)))) continue;
            if (!ruleTargetsResource(rule, res)) continue;
            const opens = ruleOpensTcpPort(rule, port);
            const action = rule.action || 'accept';
            if (action === 'drop') {
                if (opens) return deny('BLOCKED_BY_POLICY', { policy: p.name || p.id });
                continue;
            }
            if (action !== 'accept') continue;
            if (!opens) { portMismatch = true; continue; }
            if (posture) { postureOnly = true; continue; }
            granting.push(p.name || p.id);
        }
    }
    if (granting.length) return { ok: true, code: 'OK', ...where, policies: [...new Set(granting)] };
    if (postureOnly) return deny('POSTURE_REQUIRED');
    if (portMismatch) return deny('PORT_NOT_ALLOWED');
    return deny('NO_ACCESS');
}

// ─── Host names ───
// The typed address is an IPv4 address, or a host name in the form the DNS uses. Anything else
// is refused - nothing is cut off silently (the browser cleans pasted URLs visibly before
// sending). The last label must start with a letter, so no inet_aton form ("127.1", "0x7f.1",
// "2130706433") can pass as a name: guacd resolves names with getaddrinfo, which reads those as
// addresses.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function asciiName(raw, minLabels = 2) {
    if (!/^[\p{L}\p{M}\p{N}.-]+$/u.test(raw)) return null;
    let name;
    try { name = domainToASCII(raw); } catch { return null; }
    if (!name) return null;
    name = name.toLowerCase();
    if (name.endsWith('.')) name = name.slice(0, -1);
    if (!name || name.length > 253) return null;
    const labels = name.split('.');
    if (labels.length < minLabels || !labels.every(l => LABEL_RE.test(l)) || !/^[a-z]/.test(labels[labels.length - 1])) return null;
    return name;
}

function normalizeTarget(input) {
    const raw = String(input === undefined || input === null ? '' : input).trim();
    if (!raw || raw.length > 300) return { error: 'INVALID_ADDRESS' };
    if (/^[0-9.]+$/.test(raw)) return ipv4ToInt(raw) === null ? { error: 'INVALID_ADDRESS' } : { kind: 'ip', ip: raw };
    const name = asciiName(raw);
    return name ? { kind: 'name', name } : { error: 'INVALID_ADDRESS' };
}

// A domain resource address as NetBird matches it: "example.com" (exact) or "*.example.com"
// (one or more labels below example.com, never example.com itself).
function domainPattern(addr) {
    const str = String(addr || '').trim();
    const wildcard = str.startsWith('*.');
    const base = wildcard ? asciiName(str.slice(2), 1) : asciiName(str);
    return base ? { wildcard, base, rank: wildcard ? base.split('.').length : 1000 } : null;
}

function patternMatches(p, name) {
    return !!p && (p.wildcard ? name.endsWith('.' + p.base) : name === p.base);
}

const isDomainResource = (res) => !!res && !parsePrefix(res.address) && !!domainPattern(res.address);

// May this user open a session to name:port through a domain resource? The answer is
// { ok: false, code: 'NO_DOMAIN_MATCH' } when no domain resource in any network matches the
// name - the caller then resolves the name to IPv4 addresses and uses evaluateUserAccess.
//   cfg.networks        - networks open to browser access
//   cfg.gatewayGroupId  - the NAMES gateway's group (its reach is checked here)
function evaluateNameAccess(snap, cfg, { userId, name, port, now = Date.now() }) {
    const deny = (code, extra = {}) => ({ ok: false, code, ...extra });
    if (!Number.isInteger(port) || port < 1 || port > 65535) return deny('INVALID_PORT');

    const netOf = networkIndex(snap);
    const selected = new Set(arr(cfg.networks));
    const matches = [];
    for (const res of arr(snap.resources)) {
        if (!isDomainResource(res)) continue;
        const p = domainPattern(res.address);
        if (!patternMatches(p, name)) continue;
        const net = netOf.get(res.id);
        matches.push({ res, net, rank: p.rank, selected: !!net && selected.has(net.id) });
    }
    if (!matches.length) return deny('NO_DOMAIN_MATCH');
    const open = matches.filter(m => m.selected);
    if (!open.length) return deny('NETWORK_NOT_ENABLED');
    open.sort((a, b) => b.rank - a.rank);
    const best = open[0];
    const resource = { id: best.res.id, name: best.res.name || best.res.address, address: best.res.address, type: 'domain' };
    const network = { id: best.net.id, name: best.net.name || best.net.id };
    if (open.length > 1 && open[1].rank === best.rank) return deny('AMBIGUOUS_ROUTE', { resource, network });
    if (best.res.enabled === false) return deny('RESOURCE_DISABLED', { resource, network });

    const src = userSourceGroups(snap, userId, now);
    if (src.error) return deny(src.error, { resource, network });

    // The names gateway must reach this name through this resource and nothing else: no
    // address routes at all (a static route could capture the address the name resolves to),
    // and no other domain resource or domain route, in any network, that matches the name at
    // least as specifically (NetBird resolves a name through its most specific match, so a
    // broader wildcard elsewhere never takes it).
    const reach = gatewayReach(snap, cfg);
    if (reach.error) return deny('NAMES_GATEWAY_NOT_ENROLLED', { resource, network });
    if (reach.entries.length) return deny('NAMES_GATEWAY_EXTRA_REACH', { resource, network });
    const inReach = reach.domain.some(d => d.kind === 'resource' && d.id === best.res.id);
    if (!inReach) return deny('GATEWAY_NOT_SYNCED', { resource, network });
    const rival = reach.domain.some(d => !(d.kind === 'resource' && d.id === best.res.id)
        && arr(d.domains).some(a => { const p = domainPattern(a); return patternMatches(p, name) && p.rank >= best.rank; }));
    if (rival) return deny('AMBIGUOUS_ROUTE', { resource, network });

    return evaluatePolicies(snap, cfg, src, best.res, port, now, { resource, network });
}

// Is the path up: a connected gateway peer, and an enabled, connected routing peer for the
// network (a router targets one peer or every peer of its peer groups).
function pathStatus(snap, cfg, routers) {
    const gw = gatewayReach(snap, cfg);
    if (gw.error) return { ok: false, code: gw.error };
    if (!gw.peers.some(p => p.connected)) return { ok: false, code: 'GATEWAY_OFFLINE' };
    const peersById = new Map(arr(snap.peers).map(p => [p.id, p]));
    const groupsById = new Map(arr(snap.groups).map(g => [g.id, g]));
    for (const r of arr(routers)) {
        if (!r || r.enabled === false) continue;
        if (r.peer && peersById.get(r.peer) && peersById.get(r.peer).connected) return { ok: true, code: 'OK' };
        for (const gref of arr(r.peer_groups)) {
            const g = groupsById.get(idOf(gref));
            for (const m of arr(g && g.peers)) {
                const p = peersById.get(idOf(m));
                if (p && p.connected) return { ok: true, code: 'OK' };
            }
        }
    }
    return { ok: false, code: 'NO_ROUTER_ONLINE' };
}

module.exports = {
    evaluateUserAccess, evaluateNameAccess, normalizeTarget, domainPattern, isDomainResource,
    gatewayReach, extraReach, pathStatus,
    userSourceGroups, ruleOpensTcpPort, grantIsValid, parsePrefix, ipv4ToInt,
    TEMP_POLICY_RE, TEMP_GROUP_RE,
};
