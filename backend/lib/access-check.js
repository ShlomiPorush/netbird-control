'use strict';
// Access Check: is a user authorized for a NetBird network resource, and who is? Pure - every
// input arrives in `snap`, read fresh from NetBird by the caller.
//
// The primary answer is the user's AUTHORIZATION, by the same model Remote Access uses
// (remote-access-auth.js): the user's source groups come from userSourceGroups() - their
// auto_groups, the groups of every device they own, and "All", with temporary-grant groups only
// while the grant is valid - and a policy counts the way evaluatePolicies() counts it. See
// authorizeUser() below.
//
// The device details are secondary: what each of the user's devices can reach right now. That
// part mirrors what NetBird enforces on the device:
//   - NetBird evaluates policies on PEER groups. A user's auto_groups never count for a device;
//     they only feed the "pending" answer (a device that joins would get access).
//   - Every policy and group counts exactly as NetBird holds it. A temporary grant that ended
//     but whose cleanup has not finished still opens access, and is reported as such.
//   - Routes are chosen by the client: the most specific prefix (or domain pattern) wins, and
//     only the winning resource's rules apply to that part of the address range. Identical
//     prefixes in two resources are unpredictable and give "cannot determine".
//   - Within the winning resource, the allowed ports per protocol are the accept rules minus
//     the drop rules.
//   - Posture checks are evaluated on the device and are not modelled: any relevant
//     posture-gated policy makes the device's answer "conditional".
// Anything it does not positively understand is reported as uncertain, never as a grant.

const { parsePrefix, domainPattern, TEMP_POLICY_RE, TEMP_GROUP_RE, grantIsValid, userSourceGroups, MANAGED_POLICY_NAMES } = require('./remote-access-auth');

const idOf = (x) => (x && typeof x === 'object') ? x.id : x;
const arr = (v) => (Array.isArray(v) ? v : []);

const PROTOCOLS = ['any', 'tcp', 'udp', 'icmp'];
const MAX_PORT = 65535;

// Verdict order, best first. A user's verdict is the best among their eligible devices.
const ORDER = ['granted', 'partial', 'conditional', 'port_blocked', 'cannot_determine', 'denied'];
const rank = (v) => { const i = ORDER.indexOf(v); return i < 0 ? ORDER.length : i; };
const best = (verdicts) => verdicts.reduce((a, b) => (rank(b) < rank(a) ? b : a), 'denied');
const LISTED = new Set(['granted', 'partial', 'conditional', 'port_blocked', 'cannot_determine']);

// ─── Port sets: { tcp: [[a,b],...], udp: [[a,b],...], icmp: bool } ───

const emptySet = () => ({ tcp: [], udp: [], icmp: false });

function normIntervals(list) {
    const s = list.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of s) {
        const last = out[out.length - 1];
        if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
    }
    return out;
}

function subtractIntervals(list, minus) {
    let out = list.map(x => [...x]);
    for (const [c, d] of minus) {
        const next = [];
        for (const [a, b] of out) {
            if (d < a || c > b) { next.push([a, b]); continue; }
            if (a < c) next.push([a, c - 1]);
            if (d < b) next.push([d + 1, b]);
        }
        out = next;
    }
    return out;
}

function unionSets(a, b) {
    return { tcp: normIntervals([...a.tcp, ...b.tcp]), udp: normIntervals([...a.udp, ...b.udp]), icmp: a.icmp || b.icmp };
}

function subtractSets(a, b) {
    return { tcp: subtractIntervals(a.tcp, b.tcp), udp: subtractIntervals(a.udp, b.udp), icmp: a.icmp && !b.icmp };
}

function intersectIntervals(a, b) {
    const out = [];
    for (const [x1, y1] of a) for (const [x2, y2] of b) {
        const lo = Math.max(x1, x2), hi = Math.min(y1, y2);
        if (lo <= hi) out.push([lo, hi]);
    }
    return normIntervals(out);
}

function intersectSets(a, b) {
    return { tcp: intersectIntervals(a.tcp, b.tcp), udp: intersectIntervals(a.udp, b.udp), icmp: a.icmp && b.icmp };
}

const setIsEmpty = (s) => !s.tcp.length && !s.udp.length && !s.icmp;
const inIntervals = (list, p) => list.some(([a, b]) => p >= a && p <= b);

// "all", "22, 443, 8000-8100", or "" for display.
function describeIntervals(list) {
    if (list.length === 1 && list[0][0] === 1 && list[0][1] === MAX_PORT) return 'all';
    return list.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(', ');
}
const describeSet = (s) => ({ tcp: describeIntervals(s.tcp), udp: describeIntervals(s.udp), icmp: s.icmp });

const PORT_RE = /^\d{1,5}$/;
const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_PORT;

// The traffic one rule covers, or null when its shape is not understood. `ports` holds single
// ports only (NetBird keeps ranges in port_ranges); ports are only meaningful for tcp and udp.
function ruleSet(rule) {
    const proto = String(rule.protocol || '').toLowerCase();
    if (rule.ports !== undefined && rule.ports !== null && !Array.isArray(rule.ports)) return null;
    if (rule.port_ranges !== undefined && rule.port_ranges !== null && !Array.isArray(rule.port_ranges)) return null;
    const ports = arr(rule.ports);
    const ranges = arr(rule.port_ranges);
    const intervals = [];
    for (const tok of ports) {
        const s = String(tok).trim();
        if (!PORT_RE.test(s) || !validPort(Number(s))) return null;
        intervals.push([Number(s), Number(s)]);
    }
    for (const r of ranges) {
        const a = Number(r && r.start), b = Number(r && r.end);
        if (!validPort(a) || !validPort(b) || a > b) return null;
        intervals.push([a, b]);
    }
    const portList = intervals.length ? normIntervals(intervals) : [[1, MAX_PORT]];
    if (proto === 'all') return intervals.length ? null : { tcp: [[1, MAX_PORT]], udp: [[1, MAX_PORT]], icmp: true };
    if (proto === 'icmp') return intervals.length ? null : { tcp: [], udp: [], icmp: true };
    if (proto === 'tcp') return { tcp: portList, udp: [], icmp: false };
    if (proto === 'udp') return { tcp: [], udp: portList, icmp: false };
    return null;
}

// Does the allowed set answer the query? Without a protocol: any traffic at all.
function setAnswers(s, query) {
    const { protocol, port } = query;
    if (protocol === 'icmp') return s.icmp;
    if (protocol === 'tcp' || protocol === 'udp') return port ? inIntervals(s[protocol], port) : s[protocol].length > 0;
    return !setIsEmpty(s);
}

// ─── Addresses ───

const ipToStr = (n) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

// { kind: 'ip', start, end, bits } | { kind: 'domain', pattern } | { kind: 'other' }
function addrOf(res) {
    const prefix = parsePrefix(res && res.address);
    if (prefix) return { kind: 'ip', ...prefix };
    const pattern = domainPattern(res && res.address);
    if (pattern) return { kind: 'domain', pattern };
    return { kind: 'other' };
}

const patternKey = (p) => (p.wildcard ? '*.' : '') + p.base;

// Does pattern `outer` match every name that `inner` matches? A wildcard "*.base" matches one or
// more labels below base, never base itself.
function patternCovers(outer, inner) {
    if (!outer.wildcard) return !inner.wildcard && outer.base === inner.base;
    if (inner.wildcard && inner.base === outer.base) return true;
    return inner.base.endsWith('.' + outer.base);
}

function rangeLabel(a, b) {
    if (a === b) return ipToStr(a);
    const size = b - a + 1;
    if ((size & (size - 1)) === 0 && a % size === 0) return `${ipToStr(a)}/${32 - Math.log2(size)}`;
    return `${ipToStr(a)} - ${ipToStr(b)}`;
}

// ─── Indexes over the snapshot ───

function buildIndex(snap) {
    const groupName = new Map(arr(snap.groups).map(g => [g.id, g.name || g.id]));
    const allIds = arr(snap.groups).filter(g => g && g.name === 'All').map(g => g.id);
    const resources = arr(snap.resources).filter(r => r && r.id);
    const resById = new Map(resources.map(r => [r.id, r]));
    const netOf = new Map();
    for (const n of arr(snap.networks)) for (const rid of arr(n.resources)) netOf.set(idOf(rid), n);
    const resOfGroup = new Map();
    for (const r of resources) for (const g of arr(r.groups)) {
        const gid = idOf(g);
        if (!gid) continue;
        if (!resOfGroup.has(gid)) resOfGroup.set(gid, new Set());
        resOfGroup.get(gid).add(r.id);
    }
    const grantById = new Map(arr(snap.grants).map(g => [String(g.id), g]));
    const postureName = new Map(arr(snap.postureChecks).map(c => [c.id, c.name || c.id]));
    const managed = new Set(arr(snap.managedPolicyIds).filter(Boolean));
    const users = arr(snap.users).filter(u => u && u.id);
    const userById = new Map(users.map(u => [u.id, u]));

    // Every enabled accept/drop rule, flattened once, with the resources it reaches.
    const rules = [];
    for (const p of arr(snap.policies)) {
        if (!p || p.enabled === false) continue;
        const postureIds = arr(p.source_posture_checks).map(idOf).filter(Boolean);
        arr(p.rules).forEach((rule, i) => {
            if (!rule || rule.enabled === false) return;
            const action = String(rule.action || 'accept').toLowerCase();
            if (action !== 'accept' && action !== 'drop') return;
            const dest = new Set();
            const dr = idOf(rule.destinationResource);
            if (dr && resById.has(dr)) dest.add(dr);
            for (const d of arr(rule.destinations)) for (const rid of (resOfGroup.get(idOf(d)) || [])) dest.add(rid);
            if (!dest.size) return;
            const src = rule.sourceResource && typeof rule.sourceResource === 'object' ? rule.sourceResource : null;
            rules.push({
                policyId: p.id, policyName: p.name || p.id, ruleIndex: i, action,
                sources: new Set(arr(rule.sources).map(idOf).filter(Boolean)),
                sourcePeer: src && String(src.type || '').toLowerCase() === 'peer' ? idOf(src) : null,
                dest, set: ruleSet(rule), posture: postureIds.length > 0, postureIds,
                infra: managed.has(p.id), managedName: MANAGED_POLICY_NAMES.has(p.name),
                tempGrant: (TEMP_POLICY_RE.exec(p.name || '') || [])[1] || null,
            });
        });
    }
    // Routing peers per network: { sure, maybe } - peers that can route, and peers that may
    // (eligibility not certain) - or null when the routers were not read. NetBird skips a router
    // peer that does not exist and leaves a peer waiting for compliance approval out of the
    // network map; being offline does not remove a route. A peer is eligible or not for every
    // network it routes alike.
    const routerPeers = new Map();
    const routerLists = snap.routers instanceof Map ? snap.routers : new Map();
    const groupById = new Map(arr(snap.groups).map(g => [g.id, g]));
    const peerById = new Map(arr(snap.peers).filter(p => p && p.id).map(p => [p.id, p]));
    const bypassed = snap.bypassed instanceof Set ? snap.bypassed : null;
    for (const n of arr(snap.networks)) {
        const list = routerLists.get(n.id);
        if (!Array.isArray(list)) { routerPeers.set(n.id, null); continue; }
        const ids = new Set();
        for (const r of list) {
            if (!r || r.enabled === false) continue;
            if (r.peer) ids.add(idOf(r.peer));
            for (const g of arr(r.peer_groups)) for (const m of arr((groupById.get(idOf(g)) || {}).peers)) ids.add(idOf(m));
        }
        const sure = new Set();
        const maybe = new Set();
        for (const id of ids) {
            const p = peerById.get(id);
            if (!p) continue;
            let unsure = false;
            if (p.approval_required && !p.force_approved) {
                if (!bypassed) unsure = true;
                else if (!bypassed.has(id)) continue; // blocked by compliance: not a router
            }
            if (p.login_expired) unsure = true;
            (unsure ? maybe : sure).add(id);
        }
        routerPeers.set(n.id, { sure, maybe });
    }
    return { groupName, allIds, resources, resById, netOf, grantById, postureName, users, userById, rules, routerPeers };
}

// A device's view: its groups (+ All), and the rules whose sources hit it.
function deviceEntries(ix, { peerId, groups }) {
    const gs = new Set([...groups, ...ix.allIds]);
    const out = [];
    for (const r of ix.rules) {
        const via = [...r.sources].filter(g => gs.has(g));
        const direct = !!(peerId && r.sourcePeer && r.sourcePeer === peerId);
        if (!via.length && !direct) continue;
        out.push({ ...r, via, direct });
    }
    return out;
}

// ─── One device against one target ───

function netInfo(ix, resId) {
    const n = ix.netOf.get(resId);
    return n ? { id: n.id, name: n.name || n.id } : null;
}
function resInfo(ix, res) {
    return { id: res.id, name: res.name || res.address || res.id, address: res.address || '', network: netInfo(ix, res.id) };
}

function tempNote(ix, id, now) {
    const g = ix.grantById.get(String(id));
    if (!g) return { id: String(id), state: 'unknown' };
    if (grantIsValid(g, now)) return { id: String(id), state: 'active', expiresAt: g.expires_at || null };
    return { id: String(id), state: 'ended', status: g.status || '' };
}

// The rules that apply on the routing peer carrying this part. The client sends the traffic
// along the winning route to ONE routing peer of the winner's network (several = high
// availability). That peer installs the rules of every resource it routes and checks all whose
// destination contains the address, drops before accepts (NetBird client/firewall/uspfilter
// routeACLsPass). So for each routing peer of the winner's network, the rules of every covering
// resource that peer routes apply together. When the peers would answer differently, which one
// carries the traffic decides, and the answer cannot be determined. When the routers of a
// covering resource's network could not be read, neither can the answer.
// The allowed set behind each evaluateRules() result, kept out of the JSON answer.
const RAW_ALLOWED = new WeakMap();
const uniqBy = (list) => [...new Map(list.map(x => [JSON.stringify(x), x])).values()];

function evaluatePart(ix, entries, winnerId, coverIds, query, now) {
    const netOf = (id) => (ix.netOf.get(id) || {}).id;
    const wNet = netOf(winnerId);
    const sameNet = new Set(coverIds.filter(id => netOf(id) === wNet));
    const unknown = () => ({ ...evaluateRules(ix, entries, sameNet, winnerId, query, now), answer: 'unknown', reason: 'router_unknown' });
    if (coverIds.some(id => !netOf(id) || !ix.routerPeers.get(netOf(id)))) return unknown();
    // Without a peer that surely routes the winner, the route itself may not exist.
    const w = ix.routerPeers.get(wNet);
    if (!w.sure.size) return unknown();
    const routes = (id, peer) => { const r = ix.routerPeers.get(netOf(id)); return r.sure.has(peer) || r.maybe.has(peer); };
    const scopes = new Map();
    for (const peer of [...w.sure, ...w.maybe]) {
        const scope = coverIds.filter(id => netOf(id) === wNet || routes(id, peer));
        scopes.set(scope.slice().sort().join('\u0000'), new Set(scope));
    }
    const results = [...scopes.values()].map(scope => evaluateRules(ix, entries, scope, winnerId, query, now));
    const first = results[0];
    if (results.length === 1) return first;
    const agree = results.every(r => r.answer === first.answer && r.reason === first.reason);
    if (agree && results.every(r => JSON.stringify(r.allowed) === JSON.stringify(first.allowed))) return first;
    // The routing peers differ: show only the ports open through all of them, and the policies
    // of every one. When their answers differ too, which peer carries the traffic decides.
    const common = results.map(r => RAW_ALLOWED.get(r)).reduce(intersectSets);
    return {
        ...first, allowed: describeSet(common), hasAllowed: !setIsEmpty(common), variesByRouter: true,
        grantedBy: uniqBy(results.flatMap(r => r.grantedBy)), blockedBy: [...new Set(results.flatMap(r => r.blockedBy))],
        ...(agree ? {} : { answer: 'unknown', reason: 'router_differs' }),
    };
}

// Accepts minus drops over the device's rules toward any resource in `scope`.
function evaluateRules(ix, entries, scope, winnerId, query, now) {
    let accept = emptySet();
    let drop = emptySet();
    const grantedBy = [];
    const blockedBy = new Set();
    let unparsableDrop = false;
    let unparsableAccept = false;
    for (const e of entries) {
        const hit = [...e.dest].filter(id => scope.has(id));
        if (!hit.length) continue;
        if (!e.set) { if (e.action === 'drop') unparsableDrop = true; else unparsableAccept = true; continue; }
        if (e.action === 'drop') {
            drop = unionSets(drop, e.set);
            const on = hit.includes(winnerId) ? '' : ((ix.resById.get(hit[0]) || {}).name || hit[0]);
            blockedBy.add(on ? `${e.policyName} (on ${on})` : e.policyName);
            continue;
        }
        accept = unionSets(accept, e.set);
        const groupTemp = e.via.map(g => (TEMP_GROUP_RE.exec(ix.groupName.get(g) || '') || [])[1]).find(Boolean);
        const tempId = e.tempGrant || groupTemp || null;
        grantedBy.push({
            policy: e.policyName, policyId: e.policyId, infra: e.infra,
            via: e.direct ? ['(this device)'] : e.via.map(g => ix.groupName.get(g) || g),
            ports: describeSet(e.set),
            ...(tempId ? { temp: tempNote(ix, tempId, now) } : {}),
        });
    }
    const allowed = subtractSets(accept, drop);
    // A drop that removed nothing from what the accepts open is not worth naming.
    const removed = !setIsEmpty(subtractSets(accept, allowed));
    const out = {
        allowed: describeSet(allowed), grantedBy,
        blockedBy: removed ? [...blockedBy] : [],
        ...(unparsableAccept ? { note: 'unparsable_accept' } : {}),
    };
    const result = unparsableDrop
        ? { ...out, answer: 'unknown', reason: 'unparsable_rule', hasAllowed: !setIsEmpty(allowed) }
        : { ...out, answer: setAnswers(allowed, query) ? 'yes' : 'no', hasAllowed: !setIsEmpty(allowed) };
    RAW_ALLOWED.set(result, allowed);
    return result;
}

// The parts of the target and, for each, the winning route among `relevant` resources.
// Each part: { label, winners: [resource ids] } - several winners = ambiguous, none = no route.
function partition(ix, target, relevant) {
    const t = addrOf(target);
    if (t.kind === 'ip') {
        const rel = relevant.map(r => ({ r, a: addrOf(r) })).filter(x => x.a.kind === 'ip');
        const cuts = new Set([t.start, t.end + 1]);
        for (const { a } of rel) {
            cuts.add(Math.max(a.start, t.start));
            cuts.add(Math.min(a.end, t.end) + 1);
        }
        const points = [...cuts].sort((x, y) => x - y);
        const parts = [];
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1] - 1;
            const cover = rel.filter(x => x.a.start <= a && x.a.end >= b);
            const top = cover.reduce((m, x) => Math.max(m, x.a.bits), -1);
            parts.push({ start: a, end: b, winners: cover.filter(x => x.a.bits === top).map(x => x.r.id), cover: cover.map(x => x.r.id) });
        }
        // Merge neighbours with the same winners so the output stays readable.
        const merged = [];
        for (const p of parts) {
            const last = merged[merged.length - 1];
            if (last && last.end + 1 === p.start && last.winners.join() === p.winners.join() && last.cover.join() === p.cover.join()) last.end = p.end;
            else merged.push({ ...p });
        }
        return { kind: 'ip', parts: merged.map(p => ({ label: rangeLabel(p.start, p.end), winners: p.winners, cover: p.cover })) };
    }
    if (t.kind === 'domain') {
        const rel = relevant.map(r => ({ r, a: addrOf(r) })).filter(x => x.a.kind === 'domain');
        const T = t.pattern;
        const coversT = rel.filter(x => patternCovers(x.a.pattern, T));
        const winnersOf = (list) => {
            const top = list.reduce((m, x) => Math.max(m, x.a.pattern.rank), -1);
            return list.filter(x => x.a.pattern.rank === top).map(x => x.r.id);
        };
        const idsOf = (list) => list.map(x => x.r.id);
        if (!T.wildcard) return { kind: 'domain', parts: [{ label: patternKey(T), winners: winnersOf(coversT), cover: idsOf(coversT) }] };
        // Patterns strictly inside the wildcard target, each a part of its own minus the more
        // specific patterns inside it; the remainder is T minus all of them.
        const inside = new Map();
        for (const x of rel) {
            const p = x.a.pattern;
            if (patternKey(p) === patternKey(T) || !patternCovers(T, p)) continue;
            const k = patternKey(p);
            if (!inside.has(k)) inside.set(k, { pattern: p, ids: [] });
            inside.get(k).ids.push(x.r.id);
        }
        const keys = [...inside.keys()];
        const parts = [];
        const except = (outer) => keys.filter(k => k !== patternKey(outer) && patternCovers(outer, inside.get(k).pattern));
        for (const k of keys) {
            const { pattern, ids } = inside.get(k);
            const ex = pattern.wildcard ? except(pattern) : [];
            parts.push({ label: ex.length ? `${k} (except ${ex.join(', ')})` : k, winners: ids, cover: idsOf(rel.filter(x => patternCovers(x.a.pattern, pattern))) });
        }
        const exAll = keys;
        parts.push({ label: exAll.length ? `${patternKey(T)} (except ${exAll.join(', ')})` : patternKey(T), winners: winnersOf(coversT), cover: idsOf(coversT) });
        return { kind: 'domain', parts };
    }
    // IPv6 or an address shape this check does not parse: only the target's own rules count.
    const own = relevant.some(r => r.id === target.id) ? [target.id] : [];
    return { kind: 'other', parts: [{ label: target.address || target.name || target.id, winners: own, cover: own }] };
}

// Resources that may route part of the target for this device: enabled, at least one rule
// toward them hits the device, and their address overlaps the target's.
function relevantResources(ix, entries, target) {
    const toward = new Set();
    for (const e of entries) for (const rid of e.dest) toward.add(rid);
    const t = addrOf(target);
    const out = [];
    for (const rid of toward) {
        const r = ix.resById.get(rid);
        if (!r || r.enabled === false) continue;
        const peers = ix.routerPeers.get((ix.netOf.get(r.id) || {}).id);
        if (peers && !peers.sure.size && !peers.maybe.size) continue; // no peer can route it: no route
        if (t.kind === 'other') { if (r.id === target.id) out.push(r); continue; }
        const a = addrOf(r);
        if (t.kind === 'ip' && a.kind === 'ip' && a.start <= t.end && a.end >= t.start) out.push(r);
        if (t.kind === 'domain' && a.kind === 'domain' && (patternCovers(a.pattern, t.pattern) || patternCovers(t.pattern, a.pattern))) out.push(r);
    }
    return out;
}

function summarize(ix, entries, target, query, now) {
    const relevant = relevantResources(ix, entries, target);
    const { kind, parts } = partition(ix, target, relevant);
    const results = parts.map(p => {
        const base = { label: p.label };
        if (!p.winners.length) {
            if (kind === 'other') return { ...base, answer: 'unknown', reason: 'not_checked', hasAllowed: false };
            return { ...base, answer: 'no', reason: 'no_route', hasAllowed: false };
        }
        if (p.winners.length > 1) {
            return { ...base, answer: 'unknown', reason: 'ambiguous_route', hasAllowed: false, winners: p.winners.map(id => resInfo(ix, ix.resById.get(id))) };
        }
        const w = ix.resById.get(p.winners[0]);
        return { ...base, winner: resInfo(ix, w), ...(w.id !== target.id ? { overlapping: true } : {}), ...evaluatePart(ix, entries, w.id, p.cover, query, now) };
    });
    const yes = results.filter(r => r.answer === 'yes').length;
    const unknown = results.filter(r => r.answer === 'unknown').length;
    const specific = query.protocol !== 'any';
    let verdict;
    if (yes && yes === results.length) verdict = 'granted';
    else if (yes) verdict = 'partial';
    else if (unknown) verdict = 'cannot_determine';
    else if (specific && results.some(r => r.hasAllowed)) verdict = 'port_blocked';
    else verdict = 'denied';
    return { verdict, parts: results, ...(kind === 'other' ? { overlapNotChecked: true } : {}) };
}

// The posture-aware answer for one device's rule entries.
function deviceAnswer(ix, entries, target, query, now) {
    const full = summarize(ix, entries, target, query, now);
    const relevant = new Set(relevantResources(ix, entries, target).map(r => r.id));
    const gated = entries.filter(e => e.posture && [...e.dest].some(rid => relevant.has(rid)));
    if (!gated.length) return full;
    const baseline = summarize(ix, entries.filter(e => !e.posture), target, query, now);
    const policies = new Map();
    for (const e of gated) {
        if (!policies.has(e.policyId)) policies.set(e.policyId, { policy: e.policyName, checks: e.postureIds.map(id => ix.postureName.get(id) || id) });
    }
    // When every relevant gated policy requires the same set of checks, the device passes or
    // fails them together: the two extremes are the only outcomes, so if they agree the answer
    // is definitive. With different check sets, a mixed result can differ from both extremes.
    const checkSets = new Set(gated.map(e => [...e.postureIds].sort().join('\u0000')));
    const key = (p) => JSON.stringify([p.label, p.answer, p.reason || '', p.allowed || null, (p.winner || {}).id || '']);
    const same = (a, b) => a.verdict === b.verdict && a.parts.length === b.parts.length
        && a.parts.every((p, i) => key(p) === key(b.parts[i]));
    if (checkSets.size === 1 && same(baseline, full)) return { ...full, postureIndependent: [...policies.values()] };
    return { verdict: 'conditional', ifChecksFail: baseline, ifChecksPass: full, posturePolicies: [...policies.values()] };
}

// Why a device cannot use what its policies allow. `soft` = may be blocked (status unknown).
function deviceBlockers(peer, owner, bypassed) {
    const hard = [];
    const soft = [];
    if (owner && (owner.is_blocked || owner.status === 'blocked')) hard.push('user_blocked');
    if (peer.login_expired) hard.push('login_expired');
    if (peer.approval_required && !peer.force_approved) {
        if (bypassed === null || bypassed === undefined) soft.push('compliance_unknown');
        else if (!bypassed.has(peer.id)) hard.push('compliance');
    }
    return { hard, soft };
}

const answerParts = (a) => [...arr(a.parts), ...arr(a.ifChecksPass && a.ifChecksPass.parts)];
const answerUsesInfra = (a) => a.verdict !== 'denied' && answerParts(a).some(p => arr(p.grantedBy).some(g => g.infra));

// ─── Public API ───

function normalizeQuery(q = {}) {
    const protocol = PROTOCOLS.includes(q.protocol) ? q.protocol : 'any';
    const port = (protocol === 'tcp' || protocol === 'udp') && validPort(q.port) ? q.port : null;
    return { protocol, port };
}

// The resources a target stands for: one resource, or every resource of a network.
function targetResources(ix, snap, target) {
    if (!target || typeof target.id !== 'string') return null;
    if (target.type === 'network') {
        const n = arr(snap.networks).find(x => x && x.id === target.id);
        if (!n) return null;
        const list = arr(n.resources).map(idOf).map(id => ix.resById.get(id)).filter(Boolean);
        return { type: 'network', id: n.id, name: n.name || n.id, resources: list };
    }
    const r = ix.resById.get(target.id);
    if (!r) return null;
    return { type: 'resource', id: r.id, name: r.name || r.address || r.id, resources: [r] };
}

// Networks whose routing peers matter for this target: those holding an enabled resource
// that overlaps any of the target's resources (the caller reads their routers).
function networksForTarget(snap, target) {
    const ix = buildIndex(snap);
    const t = targetResources(ix, snap, target);
    if (!t) return [];
    const nets = new Set();
    for (const tr of t.resources) {
        const ta = addrOf(tr);
        const n = ix.netOf.get(tr.id);
        if (n) nets.add(n.id);
        for (const r of ix.resources) {
            if (r.enabled === false) continue;
            const a = addrOf(r);
            const overlaps = (ta.kind === 'ip' && a.kind === 'ip' && a.start <= ta.end && a.end >= ta.start)
                || (ta.kind === 'domain' && a.kind === 'domain' && (patternCovers(a.pattern, ta.pattern) || patternCovers(ta.pattern, a.pattern)));
            const rn = ix.netOf.get(r.id);
            if (overlaps && rn) nets.add(rn.id);
        }
    }
    return [...nets];
}

// Routing status of the networks that hold a winning route for any listed result.
// Routing status of networks, from the same router eligibility the answer uses: online when a
// peer that surely routes is connected, offline when such peers exist but none is connected,
// unknown when only peers of uncertain eligibility (or unread routers) remain, none otherwise.
function routerStatus(ix, snap, networkIds) {
    const peers = new Map(arr(snap.peers).map(p => [p.id, p]));
    const names = new Map(arr(snap.networks).map(n => [n.id, n.name || n.id]));
    return networkIds.map(id => {
        const network = { id, name: names.get(id) || id };
        const r = ix.routerPeers.get(id);
        if (!r) return { network, status: 'unknown' };
        const online = [...r.sure].map(pid => peers.get(pid)).filter(p => p && p.connected).map(p => p.name || p.id);
        const status = online.length ? 'online' : r.sure.size ? 'offline' : r.maybe.size ? 'unknown' : 'none';
        return { network, status, online: online.slice(0, 6) };
    });
}

function legacyRouteWarnings(snap, resources) {
    const out = [];
    for (const res of resources) {
        const t = addrOf(res);
        for (const r of arr(snap.routes)) {
            if (!r || r.enabled === false) continue;
            let hit = false;
            if (t.kind === 'ip') {
                const p = parsePrefix(r.network);
                hit = !!p && p.start <= t.end && p.end >= t.start;
            } else if (t.kind === 'domain') {
                hit = arr(r.domains).some(d => { const p = domainPattern(d); return p && (patternCovers(p, t.pattern) || patternCovers(t.pattern, p)); });
            }
            if (hit) out.push({ resource: res.id, route: r.network_id || r.description || r.id });
        }
    }
    return out;
}

function networksInAnswers(devices) {
    const ids = new Set();
    const visit = (s) => { for (const p of arr(s && s.parts)) { if (p.winner && p.winner.network) ids.add(p.winner.network.id); for (const w of arr(p.winners)) if (w.network) ids.add(w.network.id); } };
    for (const d of devices) {
        const a = d.answer;
        if (a.perResource) for (const r of a.perResource) { visit(r.answer); visit(r.answer.ifChecksPass); visit(r.answer.ifChecksFail); }
        else { visit(a); visit(a.ifChecksPass); visit(a.ifChecksFail); }
    }
    return [...ids];
}

// A device against a whole target (one resource, or each resource of a network).
//   answer    - what its policies allow (for a network: per resource, and the best of them)
//   effective - what it can use: 'cannot_connect' when a hard blocker applies; an unknown
//               compliance status caps a positive answer at 'cannot_determine'.
function deviceVsTarget(ix, snap, peer, t, query, now) {
    const owner = peer.user_id ? ix.userById.get(peer.user_id) : null;
    const entries = deviceEntries(ix, { peerId: peer.id, groups: arr(peer.groups).map(idOf).filter(Boolean) });
    let answer;
    let infra;
    if (t.type === 'resource') {
        answer = deviceAnswer(ix, entries, t.resources[0], query, now);
        infra = answerUsesInfra(answer);
    } else {
        const per = t.resources.map(r => {
            const a = deviceAnswer(ix, entries, r, query, now);
            return { resource: resInfo(ix, r), verdict: a.verdict, answer: a };
        });
        answer = { verdict: per.length ? best(per.map(p => p.verdict)) : 'denied', perResource: per };
        infra = per.some(p => answerUsesInfra(p.answer));
    }
    const { hard, soft } = deviceBlockers(peer, owner, snap.bypassed);
    let effective = answer.verdict;
    if (hard.length) effective = 'cannot_connect';
    else if (soft.length && rank(effective) < rank('cannot_determine')) effective = 'cannot_determine';
    return {
        id: peer.id, name: peer.name || peer.hostname || peer.id, connected: !!peer.connected,
        userId: peer.user_id || '', effective, blockers: [...hard, ...soft],
        ...(infra ? { infrastructure: true } : {}), answer,
    };
}

// The pending check: a device carrying only the user's auto_groups.
function pendingAnswer(ix, user, t, query, now) {
    const entries = deviceEntries(ix, { peerId: null, groups: arr(user.auto_groups).map(idOf).filter(Boolean) });
    const verdicts = t.resources.map(r => deviceAnswer(ix, entries, r, query, now).verdict);
    const v = best(verdicts);
    return ['granted', 'partial', 'conditional'].includes(v) ? v : null;
}

function userVerdict(ix, snap, user, t, query, now) {
    const blocked = !!(user.is_blocked || user.status === 'blocked');
    const peers = arr(snap.peers).filter(p => p && p.user_id === user.id);
    const devices = peers.map(p => deviceVsTarget(ix, snap, p, t, query, now));
    if (blocked) return { verdict: 'denied', reason: 'user_blocked', devices };
    const eligible = devices.filter(d => d.effective !== 'cannot_connect');
    const verdict = best(eligible.map(d => d.effective));
    if (verdict !== 'denied') return { verdict, devices };
    // A device whose policies match but that cannot connect explains the denial; the user is
    // not "pending" - they already have the device.
    if (devices.some(d => d.effective === 'cannot_connect' && d.answer.verdict !== 'denied')) {
        return { verdict: 'denied', reason: 'device_cannot_connect', devices };
    }
    const pending = pendingAnswer(ix, user, t, query, now);
    if (pending) return { verdict: 'pending', pendingAs: pending, devices, ...(peers.length ? {} : { reason: 'no_devices' }) };
    return { verdict: 'denied', devices, ...(peers.length ? {} : { reason: 'no_devices' }) };
}

// ─── Authorization (the Remote Access model) ───
//
// The user is authorized for a resource when an enabled policy rule from one of their source
// groups (userSourceGroups) targets it, minus what drop rules from those groups block - exactly
// the rules evaluatePolicies() weighs: the Browser Gateway policies (by id or name) never count,
// and a temporary policy counts only while its grant is valid. Rules with a device as their
// direct source are not a user's authorization and do not count. evaluatePolicies() answers
// for one TCP port; this answers for the query's protocol and port, with the same outcome on a
// TCP port (the agreement test pins it).
// One deliberate difference: Remote Access refuses posture-gated policies, because a browser
// session cannot pass device checks. Here such a policy makes the answer "conditional" - the
// user is authorized if their device passes the checks.
function authorizeResource(ix, groups, res, query, now) {
    const rules = ix.rules.filter(r => r.dest.has(res.id) && !r.infra && !r.managedName
        && (!r.tempGrant || grantIsValid(ix.grantById.get(r.tempGrant), now))
        && [...r.sources].some(g => groups.has(g)));
    let accept = emptySet();
    let acceptNoPosture = emptySet();
    let drop = emptySet();
    let unparsableDrop = false;
    const grantedBy = [];
    const drops = [];
    for (const r of rules) {
        if (!r.set) { if (r.action === 'drop') unparsableDrop = true; continue; }
        if (r.action === 'drop') { drop = unionSets(drop, r.set); drops.push(r); continue; }
        accept = unionSets(accept, r.set);
        if (!r.posture) acceptNoPosture = unionSets(acceptNoPosture, r.set);
        const via = [...r.sources].filter(g => groups.has(g));
        const tempId = r.tempGrant || via.map(g => (TEMP_GROUP_RE.exec(ix.groupName.get(g) || '') || [])[1]).find(Boolean) || null;
        grantedBy.push({
            policy: r.policyName, policyId: r.policyId,
            via: via.map(g => ix.groupName.get(g) || g), ports: describeSet(r.set),
            ...(r.posture ? { postureChecks: r.postureIds.map(id => ix.postureName.get(id) || id) } : {}),
            ...(tempId ? { temp: tempNote(ix, tempId, now) } : {}),
        });
    }
    const allowed = subtractSets(accept, drop);
    const certain = subtractSets(acceptNoPosture, drop);
    // A drop is worth naming when it removes something the accepts open, or blocks the query.
    const blockedBy = [...new Set(drops.filter(r => !setIsEmpty(intersectSets(r.set, accept)) || setAnswers(r.set, query)).map(r => r.policyName))];
    let verdict;
    let reason;
    if (unparsableDrop) { verdict = 'cannot_determine'; reason = 'unparsable_rule'; }
    else if (setAnswers(certain, query)) verdict = 'granted';
    else if (setAnswers(allowed, query)) verdict = 'conditional';
    // A drop rule that covers the query blocks it, as in Remote Access (BLOCKED_BY_POLICY).
    else if (setAnswers(drop, query)) { verdict = 'denied'; reason = 'blocked_by_policy'; }
    else if (query.protocol !== 'any' && !setIsEmpty(allowed)) verdict = 'port_blocked';
    else verdict = 'denied';
    return {
        resource: resInfo(ix, res), verdict, allowed: describeSet(allowed), grantedBy, blockedBy,
        ...(reason ? { reason } : {}),
    };
}

function authorizeUser(ix, snap, user, t, query, now) {
    const src = userSourceGroups(snap, user.id, now);
    if (src.error) return { verdict: 'denied', reason: src.error === 'USER_BLOCKED' ? 'user_blocked' : 'user_not_found', groups: [], resources: [] };
    const groups = [...src.groups].filter(g => !ix.allIds.includes(g)).map(g => ix.groupName.get(g) || g).sort((a, b) => a.localeCompare(b));
    const resources = t.resources.map(r => authorizeResource(ix, src.groups, r, query, now));
    const vs = resources.map(r => r.verdict);
    let verdict;
    if (!vs.length) verdict = 'denied';
    else if (vs.every(v => v === 'granted')) verdict = 'granted';
    else if (t.type === 'network' && vs.some(v => v === 'granted')) verdict = 'partial';
    else verdict = best(vs);
    return { verdict, groups, resources };
}

function userInfo(u) {
    return { id: u.id, name: u.name || u.email || u.id, email: u.email || '', blocked: !!(u.is_blocked || u.status === 'blocked') };
}

function targetInfo(ix, t) {
    if (t.type === 'network') return { type: 'network', id: t.id, name: t.name, resources: t.resources.map(r => ({ ...resInfo(ix, r), enabled: r.enabled !== false })) };
    const r = t.resources[0];
    return { type: 'resource', ...resInfo(ix, r), enabled: r.enabled !== false };
}

// "Does user X have access to target Y?" → null when the user or the target does not exist.
function explainUserAccess(snap, { userId, target, query, now = Date.now() }) {
    const ix = buildIndex(snap);
    const user = ix.userById.get(userId);
    const t = targetResources(ix, snap, target);
    if (!user || !t) return null;
    const q = normalizeQuery(query);
    const out = userVerdict(ix, snap, user, t, q, now);
    return {
        user: userInfo(user), target: targetInfo(ix, t), query: q,
        authorization: authorizeUser(ix, snap, user, t, q, now), ...out,
        routers: routerStatus(ix, snap, [...new Set([...t.resources.map(r => (ix.netOf.get(r.id) || {}).id).filter(Boolean), ...networksInAnswers(out.devices)])]),
        legacyRoutes: legacyRouteWarnings(snap, t.resources),
    };
}

// "Who has access to target Y?" → null when the target does not exist.
function whoHasAccess(snap, { target, query, now = Date.now() }) {
    const ix = buildIndex(snap);
    const t = targetResources(ix, snap, target);
    if (!t) return null;
    const q = normalizeQuery(query);
    const people = ix.users.filter(u => !u.is_service_user);
    const listedIds = new Set(people.map(u => u.id));
    const users = [];
    const pending = [];
    const evaluated = [];
    const authorized = [];
    for (const u of people) {
        const a = authorizeUser(ix, snap, u, t, q, now);
        if (LISTED.has(a.verdict)) {
            authorized.push({
                user: userInfo(u), verdict: a.verdict,
                resources: a.resources.filter(r => r.verdict !== 'denied').map(r => ({
                    resource: r.resource, verdict: r.verdict,
                    policies: [...new Set(r.grantedBy.map(g => g.policy))],
                    via: [...new Set(r.grantedBy.flatMap(g => g.via))],
                    ...(r.grantedBy.some(g => g.temp && g.temp.state === 'active') ? { temporary: true } : {}),
                })),
            });
        }
    }
    authorized.sort((a, b) => rank(a.verdict) - rank(b.verdict) || a.user.name.localeCompare(b.user.name));
    for (const u of people) {
        const r = userVerdict(ix, snap, u, t, q, now);
        evaluated.push(...r.devices);
        const compact = { user: userInfo(u), verdict: r.verdict, devices: r.devices.filter(d => d.answer.verdict !== 'denied').map(compactDevice) };
        if (r.verdict === 'pending') pending.push({ ...compact, pendingAs: r.pendingAs });
        else if (LISTED.has(r.verdict)) users.push(compact);
    }
    users.sort((a, b) => rank(a.verdict) - rank(b.verdict) || a.user.name.localeCompare(b.user.name));
    const devices = [];
    for (const p of arr(snap.peers)) {
        if (!p || (p.user_id && listedIds.has(p.user_id))) continue;
        const d = deviceVsTarget(ix, snap, p, t, q, now);
        evaluated.push(d);
        if (d.answer.verdict !== 'denied') devices.push(compactDevice(d));
    }
    const nets = [...new Set([...t.resources.map(r => (ix.netOf.get(r.id) || {}).id).filter(Boolean), ...networksInAnswers(evaluated)])];
    return {
        target: targetInfo(ix, t), query: q, authorized, users, pending, devices,
        routers: routerStatus(ix, snap, nets), legacyRoutes: legacyRouteWarnings(snap, t.resources),
    };
}

// A granting rule that comes from a temporary grant that has ended but is still in NetBird.
const usesEndedGrant = (a) => (a.perResource ? a.perResource.map(r => r.answer) : [a])
    .some(x => answerParts(x).some(p => arr(p.grantedBy).some(g => g.temp && g.temp.state === 'ended')));

function compactDevice(d) {
    const a = d.answer;
    const parts = a.perResource ? [] : answerParts(a);
    const policies = [...new Set(parts.flatMap(p => arr(p.grantedBy).map(g => g.policy)))];
    return {
        id: d.id, name: d.name, connected: d.connected, effective: d.effective, blockers: d.blockers,
        ...(d.infrastructure ? { infrastructure: true } : {}),
        ...(usesEndedGrant(a) ? { endedGrant: true } : {}),
        ...(a.perResource ? { resources: a.perResource.filter(r => r.verdict !== 'denied').map(r => ({ resource: r.resource, verdict: r.verdict })) } : { policies }),
    };
}

// Minimal lists for the pickers.
function accessCheckOptions(snap) {
    const ix = buildIndex(snap);
    return {
        users: ix.users.filter(u => !u.is_service_user).map(userInfo).sort((a, b) => a.name.localeCompare(b.name)),
        resources: ix.resources.map(r => ({ ...resInfo(ix, r), enabled: r.enabled !== false })).sort((a, b) => a.name.localeCompare(b.name)),
        networks: arr(snap.networks).filter(n => n && n.id).map(n => ({ id: n.id, name: n.name || n.id })).sort((a, b) => a.name.localeCompare(b.name)),
    };
}

module.exports = {
    explainUserAccess, whoHasAccess, accessCheckOptions, networksForTarget, normalizeQuery,
    _internal: { ruleSet, subtractSets, unionSets, describeSet, partition, buildIndex, setAnswers, authorizeUser, targetResources },
};
