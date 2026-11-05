'use strict';
// Access Check: does a user (or a device) have access to a NetBird network resource, and who
// has access to it? Pure - every input arrives in `snap`, read fresh from NetBird by the caller.
//
// The answer mirrors what NetBird enforces, not what the portal would allow:
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

const { parsePrefix, domainPattern, TEMP_POLICY_RE, TEMP_GROUP_RE, grantIsValid } = require('./remote-access-auth');

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
                infra: managed.has(p.id),
                tempGrant: (TEMP_POLICY_RE.exec(p.name || '') || [])[1] || null,
            });
        });
    }
    return { groupName, allIds, resources, resById, netOf, grantById, postureName, users, userById, rules };
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

// Evaluate the winner's rules for one part. Returns the part answer and its explanation.
function evaluatePart(ix, entries, winnerId, query, now) {
    let accept = emptySet();
    let drop = emptySet();
    const grantedBy = [];
    const blockedBy = new Set();
    let unparsableDrop = false;
    let unparsableAccept = false;
    for (const e of entries) {
        if (!e.dest.has(winnerId)) continue;
        if (!e.set) { if (e.action === 'drop') unparsableDrop = true; else unparsableAccept = true; continue; }
        if (e.action === 'drop') { drop = unionSets(drop, e.set); blockedBy.add(e.policyName); continue; }
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
    if (unparsableDrop) return { ...out, answer: 'unknown', reason: 'unparsable_rule', hasAllowed: !setIsEmpty(allowed) };
    return { ...out, answer: setAnswers(allowed, query) ? 'yes' : 'no', hasAllowed: !setIsEmpty(allowed) };
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
            parts.push({ start: a, end: b, winners: cover.filter(x => x.a.bits === top).map(x => x.r.id) });
        }
        // Merge neighbours with the same winners so the output stays readable.
        const merged = [];
        for (const p of parts) {
            const last = merged[merged.length - 1];
            if (last && last.end + 1 === p.start && last.winners.join() === p.winners.join()) last.end = p.end;
            else merged.push({ ...p });
        }
        return { kind: 'ip', parts: merged.map(p => ({ label: rangeLabel(p.start, p.end), winners: p.winners })) };
    }
    if (t.kind === 'domain') {
        const rel = relevant.map(r => ({ r, a: addrOf(r) })).filter(x => x.a.kind === 'domain');
        const T = t.pattern;
        const coversT = rel.filter(x => patternCovers(x.a.pattern, T));
        const winnersOf = (list) => {
            const top = list.reduce((m, x) => Math.max(m, x.a.pattern.rank), -1);
            return list.filter(x => x.a.pattern.rank === top).map(x => x.r.id);
        };
        if (!T.wildcard) return { kind: 'domain', parts: [{ label: patternKey(T), winners: winnersOf(coversT) }] };
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
            parts.push({ label: ex.length ? `${k} (except ${ex.join(', ')})` : k, winners: ids });
        }
        const exAll = keys;
        parts.push({ label: exAll.length ? `${patternKey(T)} (except ${exAll.join(', ')})` : patternKey(T), winners: winnersOf(coversT) });
        return { kind: 'domain', parts };
    }
    // IPv6 or an address shape this check does not parse: only the target's own rules count.
    return { kind: 'other', parts: [{ label: target.address || target.name || target.id, winners: relevant.some(r => r.id === target.id) ? [target.id] : [] }] };
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
        return { ...base, winner: resInfo(ix, w), ...(w.id !== target.id ? { overlapping: true } : {}), ...evaluatePart(ix, entries, w.id, query, now) };
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
    const same = (a, b) => a.verdict === b.verdict && a.parts.length === b.parts.length
        && a.parts.every((p, i) => p.answer === b.parts[i].answer && p.label === b.parts[i].label);
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
function routerStatus(snap, networkIds) {
    const peers = new Map(arr(snap.peers).map(p => [p.id, p]));
    const groups = new Map(arr(snap.groups).map(g => [g.id, g]));
    const routers = snap.routers instanceof Map ? snap.routers : new Map();
    const names = new Map(arr(snap.networks).map(n => [n.id, n.name || n.id]));
    return networkIds.map(id => {
        const list = routers.get(id);
        if (!Array.isArray(list)) return { network: { id, name: names.get(id) || id }, status: 'unknown' };
        const members = [];
        for (const r of list) {
            if (!r || r.enabled === false) continue;
            if (r.peer) members.push(peers.get(idOf(r.peer)));
            for (const g of arr(r.peer_groups)) for (const m of arr((groups.get(idOf(g)) || {}).peers)) members.push(peers.get(idOf(m)));
        }
        const known = members.filter(Boolean);
        const online = [...new Set(known.filter(p => p.connected).map(p => p.name || p.id))];
        const status = online.length ? 'online' : (known.length ? 'offline' : 'none');
        return { network: { id, name: names.get(id) || id }, status, online: online.slice(0, 6) };
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
        user: userInfo(user), target: targetInfo(ix, t), query: q, ...out,
        routers: routerStatus(snap, [...new Set([...t.resources.map(r => (ix.netOf.get(r.id) || {}).id).filter(Boolean), ...networksInAnswers(out.devices)])]),
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
    for (const u of people) {
        const r = userVerdict(ix, snap, u, t, q, now);
        const compact = { user: userInfo(u), verdict: r.verdict, devices: r.devices.filter(d => d.answer.verdict !== 'denied').map(compactDevice) };
        if (r.verdict === 'pending') pending.push({ ...compact, pendingAs: r.pendingAs });
        else if (LISTED.has(r.verdict)) users.push(compact);
    }
    users.sort((a, b) => rank(a.verdict) - rank(b.verdict) || a.user.name.localeCompare(b.user.name));
    const devices = [];
    for (const p of arr(snap.peers)) {
        if (!p || (p.user_id && listedIds.has(p.user_id))) continue;
        const d = deviceVsTarget(ix, snap, p, t, q, now);
        if (d.answer.verdict !== 'denied') devices.push(compactDevice(d));
    }
    const nets = [...new Set(t.resources.map(r => (ix.netOf.get(r.id) || {}).id).filter(Boolean))];
    return { target: targetInfo(ix, t), query: q, users, pending, devices, routers: routerStatus(snap, nets) };
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
    _internal: { ruleSet, subtractSets, unionSets, describeSet, partition, buildIndex, setAnswers },
};
