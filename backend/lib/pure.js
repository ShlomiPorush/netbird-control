// Dependency-free pure helpers, extracted verbatim from db.js so they can be unit-tested and
// shared without pulling in the database/API layer. This module must never require db.js
// (keep the dependency direction one-way: db.js -> lib/pure.js).

// NetBird wants single ports in `ports` and "a-b" tokens split into `port_ranges`
// ({start,end} objects). Every rule builder must go through this, or the API
// rejects the rule / silently drops the range.
function splitPortTokens(ports) {
    const plain = [], ranges = [];
    for (const raw of (Array.isArray(ports) ? ports : [])) {
        const s = String(raw).trim();
        if (!s) continue;
        const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) ranges.push({ start: Number(m[1]), end: Number(m[2]) });
        else if (/^\d+$/.test(s)) plain.push(s);
    }
    return { ports: plain, portRanges: ranges };
}

// The reverse: fold a NetBird rule's port_ranges back into the display ports list
// as "a-b" tokens, so editors/tables round-trip ranges instead of showing "All".
function mergeRulePorts(rule) {
    return [
        ...(Array.isArray(rule.ports) ? rule.ports : []),
        ...(Array.isArray(rule.port_ranges) ? rule.port_ranges.map(r => `${r.start}-${r.end}`) : []),
    ];
}

// ── Least-privilege combo logic (pure - extracted for unit tests) ──
// A "combo" is one protocol/ports exposure shape. comboKey normalizes it so identical
// exposures land in the same bucket regardless of port order; combosForResource lists a
// resource's EXISTING exposure from the given policies (a rule counts when it targets the
// resource directly via destinationResource, or via a group the resource belongs to;
// disabled and non-accept rules are ignored). A resource with no matching policy has
// nothing to mirror and gets ALL_COMBO - otherwise the grant would be inert.
const ALL_COMBO = Object.freeze({ protocol: 'all', ports: [], portRanges: [] });
function comboKey(c) {
    return `${c.protocol}|${(c.ports || []).slice().sort().join(',')}|${(c.portRanges || []).map(r => `${r.start}-${r.end}`).sort().join(',')}`;
}
function combosForResource(polArr, resourceId, resourceGroupIds) {
    const gidOf = (x) => (x && x.id) || x;
    const rgroups = new Set(resourceGroupIds || []);
    const combos = new Map();
    for (const p of (Array.isArray(polArr) ? polArr : [])) {
        for (const rule of (p.rules || [])) {
            if (rule.enabled === false || (rule.action && rule.action !== 'accept')) continue;
            const direct = rule.destinationResource && gidOf(rule.destinationResource) === resourceId;
            const viaGroup = (rule.destinations || []).some(d => rgroups.has(gidOf(d)));
            if (!direct && !viaGroup) continue;
            const c = {
                protocol: rule.protocol || 'all',
                ports: Array.isArray(rule.ports) ? rule.ports : [],
                portRanges: Array.isArray(rule.port_ranges) ? rule.port_ranges : [],
            };
            combos.set(comboKey(c), c);
        }
    }
    return combos.size ? [...combos.values()] : [ALL_COMBO];
}

// ─── Self-service access spec: per-rule control of what an auto-approved grant opens ───
// Shape: { tcp?: string[], udp?: string[], icmp?: true }. A key being PRESENT means that
// protocol is allowed ([] = every port of it); absent = not allowed. A null spec means
// "no restriction" - the grant mirrors the target's existing exposure (pre-feature behavior).

// Valid port tokens only: "80" or "100-200", each side 1-65535, start < end. Duplicates drop.
function normPortList(a) {
    const out = [];
    for (const raw of (Array.isArray(a) ? a : [])) {
        const t = String(raw).trim();
        const m = t.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
        if (!m) continue;
        const s = Number(m[1]), e = m[2] === undefined ? null : Number(m[2]);
        if (s < 1 || s > 65535) continue;
        if (e !== null && (e < 1 || e > 65535 || s >= e)) continue;
        if (!out.includes(t)) out.push(t);
    }
    return out;
}

function normAccessSpec(a) {
    if (!a || typeof a !== 'object') return null;
    const out = {};
    // A non-empty list where EVERY token is invalid drops the protocol entirely - turning
    // garbage into [] would silently widen it to "all ports".
    if (Array.isArray(a.tcp)) { const p = normPortList(a.tcp); if (!a.tcp.length || p.length) out.tcp = p; }
    if (Array.isArray(a.udp)) { const p = normPortList(a.udp); if (!a.udp.length || p.length) out.udp = p; }
    if (a.icmp) out.icmp = true;
    return (out.tcp || out.udp || out.icmp) ? out : null;
}

// Union of several matching rules' specs: port lists merge, [] (= all ports of the
// protocol) beats any list, icmp is sticky. Returns null when nothing restricts.
function mergeAccessSpecs(list) {
    const specs = (list || []).filter(Boolean);
    if (!specs.length) return null;
    const out = {};
    for (const s of specs) {
        for (const k of ['tcp', 'udp']) {
            if (!s[k]) continue;
            if (!(k in out)) out[k] = s[k].slice();
            else if (!out[k].length || !s[k].length) out[k] = [];
            else out[k] = [...new Set([...out[k], ...s[k]])];
        }
        if (s.icmp) out.icmp = true;
    }
    return (out.tcp || out.udp || out.icmp) ? out : null;
}

// The temp-grant policy combos an access spec expands to - one combo (= one NetBird
// policy) per protocol, because a NetBird rule cannot mix TCP / UDP / ICMP.
function accessSpecCombos(a) {
    const out = [];
    if (a && a.tcp) out.push({ protocol: 'tcp', ...splitPortTokens(a.tcp) });
    if (a && a.udp) out.push({ protocol: 'udp', ...splitPortTokens(a.udp) });
    if (a && a.icmp) out.push({ protocol: 'icmp', ports: [], portRanges: [] });
    return out.length ? out : [ALL_COMBO];
}

function humanDuration(min) {
    if (!min) return 'unspecified';
    if (min % 1440 === 0) return `${min / 1440} day(s)`;
    if (min % 60 === 0) return `${min / 60} hour(s)`;
    return `${min} min`;
}

// Key-order-stable stringify: detail JSON round-trips through JSONB (which reorders
// keys), so config entries are matched by CONTENT, not by identity or key order.
function stableStringify(x) {
    if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
    if (x && typeof x === 'object') {
        return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
    }
    return JSON.stringify(x);
}

// ── Reverse-proxy target merge (pure - extracted for unit tests) ──
// The edit modal always sends the FULL target list, and buildProxyTarget rebuilds each target
// from only the fields the app models. Anything NetBird added later would be silently reset on
// every save, so this carries the unmodeled fields and `options` keys of the matching EXISTING
// target onto each rebuilt one. Fields the edit itself sends (e.g. `access_action`) always win.
// NetBird targets have no id of their own (target_id is the peer/resource, shared across paths),
// so a target is identified by its upstream host + path: target_type, target_id (the peer or
// resource), the host of a cluster target, and the normalized path. A different host is a NEW
// target and gets nothing carried over - fields such as custom headers must never follow a target
// to another machine. A port or protocol change on the same host keeps them. Several existing targets can share a key (NetBird ignores disabled targets in its
// duplicate check); they pair in list order only when the fields that would be carried are
// identical. Otherwise there is no safe way to tell which one the edit kept (pairing the wrong one
// could move a `bypass` onto a live target), so the save is refused before anything is written.
const PROXY_TARGET_MODELED = new Set(['target_type', 'target_id', 'host', 'port', 'protocol', 'path', 'enabled', 'options']);
const PROXY_OPTION_MODELED = new Set(['direct_upstream', 'skip_tls_verify', 'path_rewrite']);
function proxyTargetKey(t) {
    const p = String((t && t.path) || '').trim();
    const path = !p || p === '/' ? '/' : (p.startsWith('/') ? p : `/${p}`);
    const type = (t && t.target_type) || '';
    const host = type === 'cluster' ? String((t && t.host) || '').trim().toLowerCase() : '';
    return `${type}|${(t && t.target_id) || ''}|${host}|${path}`;
}
// What mergeProxyTargets would carry from `e` onto `t` (keys `t` sets itself are excluded).
function proxyTargetCarry(e, t) {
    const out = {};
    for (const [k, v] of Object.entries(e)) if (!PROXY_TARGET_MODELED.has(k) && !(k in t)) out[k] = v;
    const options = {};
    const mo = e.options && typeof e.options === 'object' ? e.options : {};
    const to = (t && t.options) || {};
    for (const [k, v] of Object.entries(mo)) if (!PROXY_OPTION_MODELED.has(k) && !(k in to)) options[k] = v;
    return { out, options };
}
function mergeProxyTargets(existingTargets, builtTargets) {
    const pool = new Map(); // key -> existing targets not yet matched, in list order
    for (const e of (Array.isArray(existingTargets) ? existingTargets : [])) {
        if (!e || typeof e !== 'object') continue;
        const k = proxyTargetKey(e);
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k).push(e);
    }
    return builtTargets.map(t => {
        const cands = pool.get(proxyTargetKey(t)) || [];
        if (!cands.length) return t;
        if (cands.length > 1) {
            const sig = c => stableStringify(proxyTargetCarry(c, t));
            if (cands.some(c => sig(c) !== sig(cands[0]))) {
                const e = new Error(`Two targets point to the same upstream and path${t.path ? ` (${t.path})` : ''} with different settings this app doesn't edit, so it can't tell which one to keep. Edit this service in the NetBird dashboard.`);
                e.status = 409;
                throw e;
            }
        }
        const match = cands.shift();
        const { out, options } = proxyTargetCarry(match, t);
        Object.assign(out, t);
        Object.assign(options, t.options || {});
        if (Object.keys(options).length) out.options = options;
        return out;
    });
}

// ── Peer network interfaces (pure - extracted for unit tests) ──
// NetBird v0.81+ reports each peer's interfaces as `network_addresses: [{ net_ip, mac }]`; older
// servers omit the field, so this always returns an array (empty when absent or malformed).
function peerNetworkAddresses(raw) {
    const list = raw && Array.isArray(raw.network_addresses) ? raw.network_addresses : [];
    const seen = new Set();
    const out = [];
    for (const a of list) {
        if (!a || typeof a !== 'object') continue;
        const ip = typeof a.net_ip === 'string' ? a.net_ip.trim() : '';
        const mac = typeof a.mac === 'string' ? a.mac.trim() : '';
        if (!ip && !mac) continue;
        const k = `${ip}|${mac.toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ ip, mac });
    }
    return out;
}

// ── CA certificates for the Certificate posture check (NetBird v0.81+) ──
// Parsed on the server (Node's built-in X509 parser) because the browser's WebCrypto is missing on
// a plain-HTTP origin. One certificate per entry, matching NetBird's `ca_certificates[]`. Read-only:
// nothing is stored or sent anywhere. Returns one result per entry, in order.
const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const MAX_CA_CERTS = 20, MAX_PEM_CHARS = 16384;
function inspectCaCertificates(pems) {
    const { X509Certificate } = require('crypto');
    const list = Array.isArray(pems) ? pems.slice(0, MAX_CA_CERTS) : [];
    return list.map((raw) => {
        const pem = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : '';
        if (!pem) return { ok: false, error: 'Paste a PEM encoded certificate.' };
        if (pem.length > MAX_PEM_CHARS) return { ok: false, error: 'This is too long for a single certificate.' };
        const blocks = pem.match(PEM_BLOCK_RE) || [];
        if (!blocks.length) return { ok: false, error: 'Please paste a valid PEM encoded certificate (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----).' };
        if (blocks.length > 1) return { ok: false, error: `This box holds ${blocks.length} certificates - add each one with Add CA Certificate.` };
        try {
            const c = new X509Certificate(blocks[0]);
            const validTo = new Date(c.validTo);
            return {
                ok: true,
                subject: c.subject.replace(/\n/g, ', '),
                issuer: c.issuer.replace(/\n/g, ', '),
                validFrom: new Date(c.validFrom).toISOString(),
                validTo: validTo.toISOString(),
                expired: validTo.getTime() < Date.now(),
                isCA: !!c.ca,
                fingerprint256: c.fingerprint256,
            };
        } catch {
            return { ok: false, error: "This isn't a valid certificate - check that it was pasted completely." };
        }
    });
}

// /login ?returnTo= → a same-app path, or '/' (open-redirect guard). The value is resolved against
// a FIXED origin (never one derived from Host / X-Forwarded-* headers), so whatever the URL parser
// does with tabs, backslashes, dot segments or percent-encoding, a different origin is refused.
// The rebuilt path is checked again: '/a/..//evil' normalizes to '//evil', which a browser would
// read as a host. An encoded slash or backslash in the path (%2F, %5C) is refused too: the app's own
// paths never contain one, and a proxy or browser that decodes it would turn it into a separator.
function safeReturnTo(rt, trustedOrigin) {
    if (typeof rt !== 'string' || rt.length > 2048) return '/';
    let url;
    try { url = new URL(rt, trustedOrigin); } catch { return '/'; }
    if (url.origin !== trustedOrigin) return '/';
    const target = url.pathname + url.search + url.hash;
    if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return '/';
    if (/%(2f|5c)/i.test(url.pathname)) return '/';
    return target;
}

// First meaningful line of a Telegram HTML message, tags stripped - the outbound log's "subject".
// A linear scan, not a regex: text outside <...> is kept, and a '<' that is not closed on its line
// drops the rest of that line, so no '<' ever reaches the output.
function tgFirstLine(html) {
    // A string only: a message object with a crafted .length must never drive the loop below.
    const s = typeof html === 'string' ? html : '';
    let out = '', inTag = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\n') { inTag = false; out += ch; }
        else if (inTag) { if (ch === '>') inTag = false; }
        else if (ch === '<') inTag = true;
        else out += ch;
    }
    const line = out.split('\n').map(l => l.trim()).find(Boolean);
    return line || '';
}

// "local@domain.tld"-shaped address: no whitespace, exactly one '@', a non-empty local part and a
// '.' inside the domain (not its first or last character). Same acceptance as the former
// /^[^\s@]+@[^\s@]+\.[^\s@]+$/, checked in linear time; anything over 254 characters (the SMTP
// path limit) is refused up front, never truncated into a different address.
function isPlausibleEmail(s) {
    if (typeof s !== 'string' || s.length > 254) return false;
    if (/\s/.test(s)) return false;
    const at = s.indexOf('@');
    if (at < 1 || at !== s.lastIndexOf('@')) return false;
    const domain = s.slice(at + 1);
    const dot = domain.indexOf('.', 1);
    return dot !== -1 && dot < domain.length - 1;
}

// The routing peer's name inside a NetBird notification ("Routing peer my-router has
// disconnected..." / "Routing peer  was removed..." - the name can be empty on delete). Same result
// as /^Routing peer\s+(.*?)\s+(?:has|was)\b/i with the capture trimmed, found by a linear scan over
// at most the first 512 characters. '' when there is no name.
function routingPeerName(message) {
    const s = String(message || '').slice(0, 512);
    const PREFIX_LEN = 'Routing peer'.length;
    const isWs = (ch) => /\s/.test(ch);
    const isLineEnd = (ch) => /[\n\r\u2028\u2029]/.test(ch);
    // has|was followed by a word boundary, at index j.
    const verbAt = (j) => /^(?:has|was)$/i.test(s.slice(j, j + 3)) && !/\w/.test(s[j + 3] || '');
    if (!/^Routing peer/i.test(s)) return '';
    let i = PREFIX_LEN;
    if (!isWs(s[i])) return '';
    while (i < s.length && isWs(s[i])) i++;
    const start = i;
    while (i < s.length) {
        if (!isWs(s[i])) { i++; continue; }
        const runStart = i;
        let crossesLine = false;
        while (i < s.length && isWs(s[i])) { if (isLineEnd(s[i])) crossesLine = true; i++; }
        if (verbAt(i)) return s.slice(start, runStart).trim();
        // The name itself is single-line ('.' in the old pattern); only the run before the verb may break.
        if (crossesLine) return '';
    }
    // No verb, or only whitespace before it ("Routing peer  was removed"): no name.
    return '';
}

module.exports = {
    inspectCaCertificates,
    splitPortTokens, mergeRulePorts, comboKey, combosForResource, ALL_COMBO, stableStringify, humanDuration,
    normAccessSpec, mergeAccessSpecs, accessSpecCombos, mergeProxyTargets, peerNetworkAddresses,
    safeReturnTo, tgFirstLine, isPlausibleEmail, routingPeerName,
};
