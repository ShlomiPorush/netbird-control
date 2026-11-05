'use strict';
// Browser remote access: RDP and SSH sessions opened from the browser through the Browser
// Gateway - a NetBird client container with guacd in its network namespace, next to this app.
// There are two gateways: the IP gateway (NetBird DNS off, static routes to the IPv4 host and
// subnet resources) and the names gateway (NetBird DNS on, only domain resources, reached by
// name the way any NetBird client reaches them). An IP session never uses the names gateway.
//
// NetBird sees every browser session as traffic from the gateway peer, so the PORTAL decides who
// may connect where (lib/remote-access-auth.js, fail closed). This module owns:
//   - the settings and the NetBird objects it manages (per gateway: a gateway group, a target
//     group and one standing policy -> resources of the admin-selected networks);
//   - session issue (one-time token), the WebSocket <-> guacd tunnel, quotas and backpressure;
//   - the per-minute re-check that disconnects sessions whose access is gone;
//   - session records in `events` (same format as NetBird traffic, source_type BROWSER_GATEWAY)
//     and live state in `remote_sessions`.
// Main account only: nothing here runs in a tenant context.
//
// This module never requires db.js (db.js requires it, for isRemoteAccessManagedPolicy). The few
// db.js helpers it needs are injected by server.js through setRemoteAccessDeps().

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { pool, getSetting, setSetting } = require('./core');
const { netbirdGet, netbirdPost, netbirdReq, bustNbCaches, netbirdApiConfigured, NETBIRD_READONLY } = require('./netbird');
const { addEvent } = require('./events');
const { evaluateUserAccess, evaluateNameAccess, normalizeTarget, isDomainResource, gatewayReach, extraReach, pathStatus } = require('./remote-access-auth');

// The managed NetBird objects of each gateway.
const KINDS = {
    ip: { group: 'Browser Gateway', targets: 'Browser Gateway Targets', policy: 'Browser Gateway', groupKey: 'gatewayGroupId', targetKey: 'targetGroupId', policyKey: 'policyId' },
    names: { group: 'Browser Gateway Names', targets: 'Browser Gateway Name Targets', policy: 'Browser Gateway (Names)', groupKey: 'namesGroupId', targetKey: 'namesTargetGroupId', policyKey: 'namesPolicyId' },
};
const POLICY_NAMES = new Set(Object.values(KINDS).map(k => k.policy));
const NAME_LOOKUP_TIMEOUT_MS = 3000;
const SOURCE_TYPE = 'BROWSER_GATEWAY';

const TOKEN_TTL_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const LEASE_TIMEOUT_MS = 150_000;        // the viewer renews every 60 s
const RECHECK_INTERVAL_MS = 60_000;
const SNAPSHOT_DEADLINE_MS = 20_000;
const PERMISSION_DEADLINE_MS = 15_000;   // per-user permission check in the re-check (may call Graph)
const SNAPSHOT_MAX_AGE_MS = 150_000;     // live sessions close when access could not be verified for this long
const CHECK_SNAPSHOT_TTL_MS = 10_000;    // checks/session issue reuse a snapshot at most this old
// Browser -> server. guacamole-common-js sends one instruction per message, the largest a blob of
// a 6048-byte chunk (8064 base64 characters), and none with more than 8 elements.
const CLIENT_INSTRUCTION_MAX = 16 * 1024;
const CLIENT_MAX_ELEMENTS = 16;
const WS_MAX_PAYLOAD = CLIENT_INSTRUCTION_MAX; // client -> server message cap
const GUACD_INSTRUCTION_MAX = 16 * 1024 * 1024;
const WS_BUFFER_HIGH = 4 * 1024 * 1024;  // pause guacd while the browser is this far behind
const WS_BUFFER_LOW = 1 * 1024 * 1024;
const STALL_LIMIT_MS = 30_000;           // a consumer stuck above the cap this long is disconnected
const MAX_WIDTH = 7680, MAX_HEIGHT = 4320;

const DEFAULTS = {
    enabled: false,
    allowAll: false,          // every signed-in user (still only to what they reach) vs. the remote.connect permission
    guacdHost: 'remote-gateway',
    guacdPort: 4822,
    namesGuacdHost: 'remote-names-gateway',
    namesGuacdPort: 4822,
    networks: [],
    maxSessionsPerUser: 5,
    maxSessionsTotal: 20,
    idleTimeoutMin: 30,
    maxDurationHours: 8,
    clipboard: true,
    sshHostKeys: {},
    // How RDP sessions look. Font smoothing and full color cost little bandwidth; the desktop
    // effects (wallpaper, themes, window contents while dragging, animations) cost more.
    rdp: {
        colorDepth: 32,
        fontSmoothing: true,
        wallpaper: false,
        theming: false,
        fullWindowDrag: false,
        desktopComposition: false,
        menuAnimations: false,
        serverLayout: 'en-us-qwerty',
    },
    ssh: { fontSize: 12, colorScheme: 'gray-black' },
};

// What guacd 1.6 accepts (its built-in keymaps and terminal color schemes).
const RDP_COLOR_DEPTHS = [8, 16, 24, 32];
const RDP_LAYOUTS = ['en-us-qwerty', 'en-gb-qwerty', 'cs-cz-qwertz', 'da-dk-qwerty', 'de-ch-qwertz', 'de-de-qwertz',
    'es-es-qwerty', 'es-latam-qwerty', 'fr-be-azerty', 'fr-ca-qwerty', 'fr-ch-qwertz', 'fr-fr-azerty', 'hu-hu-qwertz',
    'it-it-qwerty', 'ja-jp-qwerty', 'no-no-qwerty', 'pl-pl-qwerty', 'pt-br-qwerty', 'pt-pt-qwerty', 'ro-ro-qwerty',
    'sv-se-qwerty', 'tr-tr-qwerty', 'failsafe'];
const SSH_COLOR_SCHEMES = ['gray-black', 'black-white', 'green-black', 'white-black'];
const RDP_FLAGS = ['fontSmoothing', 'wallpaper', 'theming', 'fullWindowDrag', 'desktopComposition', 'menuAnimations'];

// ─── Settings ───
let _cfg = { ...DEFAULTS };
const NB_EMPTY = { gatewayGroupId: '', targetGroupId: '', policyId: '', namesGroupId: '', namesTargetGroupId: '', namesPolicyId: '' };
let _nb = { ...NB_EMPTY };
let _deps = {};
let _lastApply = { at: null, error: '' };

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

function normConfig(c) {
    const x = c && typeof c === 'object' ? c : {};
    const keys = {};
    if (x.sshHostKeys && typeof x.sshHostKeys === 'object') {
        // Keyed by IPv4 address or by host name (normalized, without the trailing dot).
        for (const [addr, key] of Object.entries(x.sshHostKeys)) {
            const t = normalizeTarget(addr);
            const k = String(key || '').trim();
            if (!t.error && k && k.length <= 16384) keys[t.kind === 'ip' ? t.ip : t.name] = k;
        }
    }
    return {
        enabled: !!x.enabled,
        allowAll: !!x.allowAll,
        guacdHost: HOST_RE.test(String(x.guacdHost || '').trim()) ? String(x.guacdHost).trim() : DEFAULTS.guacdHost,
        guacdPort: clampInt(x.guacdPort, 1, 65535, DEFAULTS.guacdPort),
        namesGuacdHost: HOST_RE.test(String(x.namesGuacdHost || '').trim()) ? String(x.namesGuacdHost).trim() : DEFAULTS.namesGuacdHost,
        namesGuacdPort: clampInt(x.namesGuacdPort, 1, 65535, DEFAULTS.namesGuacdPort),
        networks: [...new Set((Array.isArray(x.networks) ? x.networks : []).map(String).filter(s => /^[A-Za-z0-9_-]{1,64}$/.test(s)))],
        maxSessionsPerUser: clampInt(x.maxSessionsPerUser, 1, 10, DEFAULTS.maxSessionsPerUser),
        maxSessionsTotal: clampInt(x.maxSessionsTotal, 1, 200, DEFAULTS.maxSessionsTotal),
        idleTimeoutMin: clampInt(x.idleTimeoutMin, 1, 480, DEFAULTS.idleTimeoutMin),
        maxDurationHours: clampInt(x.maxDurationHours, 1, 24, DEFAULTS.maxDurationHours),
        clipboard: x.clipboard === undefined ? DEFAULTS.clipboard : !!x.clipboard,
        sshHostKeys: keys,
        rdp: normRdp(x.rdp),
        ssh: normSsh(x.ssh),
    };
}

function normRdp(v) {
    const x = v && typeof v === 'object' ? v : {};
    const d = DEFAULTS.rdp;
    const depth = Number(x.colorDepth);
    const out = {
        colorDepth: RDP_COLOR_DEPTHS.includes(depth) ? depth : d.colorDepth,
        serverLayout: RDP_LAYOUTS.includes(x.serverLayout) ? x.serverLayout : d.serverLayout,
    };
    for (const k of RDP_FLAGS) out[k] = x[k] === undefined ? d[k] : !!x[k];
    return out;
}

function normSsh(v) {
    const x = v && typeof v === 'object' ? v : {};
    return {
        fontSize: clampInt(x.fontSize, 8, 32, DEFAULTS.ssh.fontSize),
        colorScheme: SSH_COLOR_SCHEMES.includes(x.colorScheme) ? x.colorScheme : DEFAULTS.ssh.colorScheme,
    };
}

async function loadRemoteAccessConfig() {
    try { _cfg = normConfig(JSON.parse(await getSetting('remote_access_config') || 'null')); } catch { _cfg = { ...DEFAULTS }; }
    try {
        const n = JSON.parse(await getSetting('remote_access_nb') || 'null') || {};
        _nb = Object.fromEntries(Object.keys(NB_EMPTY).map(k => [k, String(n[k] || '')]));
    } catch { _nb = { ...NB_EMPTY }; }
}

function getRemoteAccessConfig() {
    return { ..._cfg, networks: [..._cfg.networks], sshHostKeys: { ..._cfg.sshHostKeys }, rdp: { ..._cfg.rdp }, ssh: { ..._cfg.ssh },
        options: { rdpLayouts: RDP_LAYOUTS, rdpColorDepths: RDP_COLOR_DEPTHS, sshColorSchemes: SSH_COLOR_SCHEMES }, managed: { ..._nb }, lastApply: { ..._lastApply } };
}

function setRemoteAccessDeps(deps) { _deps = { ..._deps, ...deps }; }

// The standing gateway policies are infrastructure, not exposure: callers that mirror existing
// policies (temporary grants, resource policy edits) must skip them. Matched by id, and by name
// for a policy whose id was not saved yet (an interrupted first save).
function isRemoteAccessManagedPolicy(p) {
    if (!p) return false;
    const ids = [_nb.policyId, _nb.namesPolicyId].filter(Boolean);
    return ids.includes(p.id) || POLICY_NAMES.has(p.name);
}

function remoteAccessAvailable() { return _cfg.enabled && netbirdApiConfigured(); }

// ─── Managed NetBird objects ───
const nbOk = (r) => r && r.status >= 200 && r.status < 300;
const nbErr = (what, r) => new Error(`${what} failed: ${(r && (r.raw || r.error || r.status)) || 'no response'}`);

async function ensureGroup(name, knownId) {
    const groups = await netbirdGet('/api/groups');
    if (!Array.isArray(groups)) throw new Error("Couldn't read the groups from NetBird");
    const found = groups.find(g => g && g.id === knownId) || groups.find(g => g && g.name === name);
    if (found) return found.id;
    const r = await netbirdPost('/api/groups', { name });
    if (!nbOk(r) || !r.body || !r.body.id) throw nbErr(`Creating the "${name}" group`, r);
    return r.body.id;
}

function policyBody(kind, enabled) {
    const k = KINDS[kind];
    return {
        name: k.policy,
        description: kind === 'names'
            ? 'Managed by NetBird Control: lets the Browser Gateway for host names reach the domain resources of the networks enabled for browser remote access. Who may connect is decided per session by NetBird Control.'
            : 'Managed by NetBird Control: lets the Browser Gateway reach the networks enabled for browser remote access. Who may connect is decided per session by NetBird Control.',
        enabled,
        source_posture_checks: [],
        rules: [{
            name: k.policy, enabled: true, action: 'accept', bidirectional: false,
            protocol: 'tcp', ports: [], sources: [_nb[k.groupKey]], destinations: [_nb[k.targetKey]],
        }],
    };
}

async function ensurePolicy(kind, enabled) {
    const k = KINDS[kind];
    const pols = await netbirdGet('/api/policies');
    if (!Array.isArray(pols)) throw new Error("Couldn't read the policies from NetBird");
    const found = pols.find(p => p && p.id === _nb[k.policyKey]) || pols.find(p => p && p.name === k.policy);
    if (found) {
        const r = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(found.id), policyBody(kind, enabled));
        if (!nbOk(r)) throw nbErr(`Updating the "${k.policy}" policy`, r);
        return found.id;
    }
    const r = await netbirdPost('/api/policies', policyBody(kind, enabled));
    if (!nbOk(r) || !r.body || !r.body.id) throw nbErr(`Creating the "${k.policy}" policy`, r);
    return r.body.id;
}

// Put the IP target group on every IPv4 host/subnet resource of the selected networks and the
// names target group on every domain resource of them; take each group off every other resource.
async function syncTargetGroup() {
    const [resources, networks] = await Promise.all([netbirdGet('/api/networks/resources'), netbirdGet('/api/networks')]);
    if (!Array.isArray(resources) || !Array.isArray(networks)) throw new Error("Couldn't read the networks from NetBird");
    const netOf = new Map();
    for (const n of networks) for (const rid of (Array.isArray(n.resources) ? n.resources : [])) netOf.set((rid && rid.id) || rid, n.id);
    const selected = new Set(_cfg.enabled ? _cfg.networks : []);
    let added = 0, removed = 0;
    for (const res of resources) {
        if (!res || !res.id) continue;
        const netId = netOf.get(res.id);
        if (!netId) continue;
        const isIp = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(String(res.address || '').trim());
        const isDomain = !isIp && isDomainResource(res);
        for (const [tg, fits] of [[_nb.targetGroupId, isIp], [_nb.namesTargetGroupId, isDomain]]) {
            if (!tg) continue;
            const has = (Array.isArray(res.groups) ? res.groups : []).some(g => ((g && g.id) || g) === tg);
            const want = selected.has(netId) && fits;
            if (want && !has) { await _deps.addResourceGroups(netId, res.id, [tg]); added++; }
            else if (!want && has) { await _deps.removeResourceGroups(netId, res.id, [tg]); removed++; }
        }
    }
    return { added, removed };
}

// Create or update everything NetBird needs. Disabling turns the standing policy off (and
// keeps the objects, so turning it back on is one save).
async function applyGatewayObjects() {
    if (!netbirdApiConfigured()) throw new Error('Connect the NetBird API first (Settings → NetBird API).');
    if (NETBIRD_READONLY) throw new Error('This instance is read-only (NETBIRD_READONLY=true) - the Browser Gateway objects cannot be created.');
    try {
        for (const [kind, k] of Object.entries(KINDS)) {
            _nb[k.groupKey] = await ensureGroup(k.group, _nb[k.groupKey]);
            _nb[k.targetKey] = await ensureGroup(k.targets, _nb[k.targetKey]);
            await setSetting('remote_access_nb', JSON.stringify(_nb));
            _nb[k.policyKey] = await ensurePolicy(kind, _cfg.enabled);
            await setSetting('remote_access_nb', JSON.stringify(_nb));
        }
        const sync = await syncTargetGroup();
        bustNbCaches('policies', 'gref', 'usage');
        _snapshot = null;
        _lastApply = { at: new Date().toISOString(), error: '' };
        return sync;
    } catch (e) {
        _lastApply = { at: new Date().toISOString(), error: e.message || String(e) };
        throw e;
    }
}

async function setRemoteAccessConfig(input) {
    const next = normConfig({ ..._cfg, ...(input || {}) });
    const wasEnabled = _cfg.enabled;
    _cfg = next;
    await setSetting('remote_access_config', JSON.stringify(_cfg));
    if (!_cfg.enabled) closeAllSessions('Browser remote access was turned off by an administrator.');
    let sync = null;
    if (_cfg.enabled || wasEnabled || _nb.policyId || _nb.namesPolicyId) sync = await applyGatewayObjects();
    return { config: getRemoteAccessConfig(), sync };
}

// Background reconcile: new resources in a selected network join the target group.
async function reconcileRemoteAccess() {
    if (!_cfg.enabled || !netbirdApiConfigured() || NETBIRD_READONLY) return;
    await applyGatewayObjects();
}

async function createGatewaySetupKey(kind = 'ip') {
    const k = KINDS[kind] || KINDS.ip;
    if (!_nb[k.groupKey]) await applyGatewayObjects();
    return _deps.createSetupKey({ name: k.group, type: 'one-off', expiresInDays: 1, usageLimit: 1, ephemeral: false, autoGroups: [_nb[k.groupKey]] });
}

// ─── NetBird snapshot (fresh, bounded in time) ───
let _snapshot = null; // { at, data }
let _snapshotInFlight = null;

function withDeadline(promise, ms, what) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function fetchSnapshot() {
    const names = ['users', 'peers', 'groups', 'policies', 'resources', 'networks', 'routes'];
    const paths = ['/api/users', '/api/peers', '/api/groups', '/api/policies', '/api/networks/resources', '/api/networks', '/api/routes'];
    const results = await Promise.all(paths.map(p => netbirdGet(p)));
    const data = {};
    names.forEach((n, i) => {
        if (!Array.isArray(results[i])) throw new Error(`Couldn't read ${n} from NetBird`);
        data[n] = results[i];
    });
    const g = await pool.query(
        `SELECT id, user_id, status, expires_at, revoke_requested_at, group_id, assigned_groups
         FROM temporary_access_grants
         WHERE tenant = '' AND (status IN ('active', 'creating') OR issued_at > NOW() - interval '90 days')`);
    data.grants = g.rows;
    return data;
}

// One shared fetch at a time; the whole snapshot has an overall deadline.
function freshSnapshot(maxAgeMs) {
    if (_snapshot && Date.now() - _snapshot.at <= maxAgeMs) return Promise.resolve(_snapshot.data);
    if (_snapshotInFlight) return _snapshotInFlight;
    _snapshotInFlight = withDeadline(fetchSnapshot(), SNAPSHOT_DEADLINE_MS, 'Reading NetBird')
        .then(data => { _snapshot = { at: Date.now(), data }; return data; })
        .finally(() => { _snapshotInFlight = null; });
    return _snapshotInFlight;
}

const authCfg = (kind = 'ip') => ({
    networks: _cfg.networks,
    gatewayGroupId: kind === 'names' ? _nb.namesGroupId : _nb.gatewayGroupId,
    managedPolicyIds: [_nb.policyId, _nb.namesPolicyId].filter(Boolean),
});

// ─── Checks (steps 1 and 2) ───
const MESSAGES = {
    INVALID_ADDRESS: 'Enter an IPv4 address, such as 10.0.0.5, or a host name, such as server.example.com.',
    NAME_NOT_FOUND: "This host name wasn't found. Check the name, or enter the server's IP address.",
    NO_IPV4_ADDRESS: 'This host name has no IPv4 address. Enter the IPv4 address instead.',
    NAME_LOOKUP_FAILED: "The host name couldn't be looked up right now. Try again, or enter the IP address.",
    NAMES_GATEWAY_NOT_ENROLLED: "Connecting by host name isn't set up yet. Ask an administrator to enroll the Browser Gateway for host names, or enter an IP address.",
    NAMES_GATEWAY_EXTRA_REACH: 'The Browser Gateway for host names receives address routes, so connecting by name is blocked until an administrator fixes it.',
    INVALID_PORT: 'Enter a port between 1 and 65535.',
    USER_NOT_FOUND: "Your account wasn't found in NetBird, so your access can't be checked.",
    USER_BLOCKED: 'Your NetBird account is blocked.',
    UNKNOWN_ADDRESS: "This address isn't a NetBird resource. Check the address, or use Troubleshoot to see what covers it.",
    NETWORK_NOT_ENABLED: "This address is in a network that isn't open to browser access. Ask an administrator to enable it.",
    RESOURCE_DISABLED: 'This resource is disabled in NetBird.',
    AMBIGUOUS_ROUTE: 'More than one NetBird route leads to this address, so the connection could reach the wrong server. An administrator needs to remove the overlap.',
    GATEWAY_NOT_ENROLLED: "The Browser Gateway isn't set up yet. Ask an administrator to enroll it.",
    GATEWAY_DOMAIN_ROUTES: 'The Browser Gateway receives domain-based routes, so browser access is blocked for everyone until an administrator fixes it.',
    GATEWAY_NOT_SYNCED: "This resource isn't available to the Browser Gateway yet. Try again in a few minutes.",
    BLOCKED_BY_POLICY: 'A NetBird policy blocks this connection.',
    POSTURE_REQUIRED: 'Your access to this resource requires a managed device. Connect with the NetBird client instead.',
    PORT_NOT_ALLOWED: "You have access to this resource, but not on this port. Request access if you need it.",
    NO_ACCESS: "You don't have access to this resource. Request access if you need it.",
    GATEWAY_OFFLINE: 'The Browser Gateway is offline. Try again later, or tell an administrator.',
    NO_ROUTER_ONLINE: 'No routing peer is online for this network, so the server cannot be reached right now.',
    SNAPSHOT_FAILED: "NetBird couldn't be reached to check your access. Try again in a moment.",
};
const REQUESTABLE = new Set(['NO_ACCESS', 'PORT_NOT_ALLOWED']);

function httpError(status, code, message) {
    const e = new Error(message || MESSAGES[code] || code);
    e.status = status; e.code = code;
    return e;
}

function parseTarget(body) {
    const protocol = String((body && body.protocol) || '').toLowerCase();
    if (protocol !== 'rdp' && protocol !== 'ssh') throw httpError(400, 'INVALID_PROTOCOL', 'Choose RDP or SSH.');
    const address = String((body && body.address) || '').trim();
    const port = parseInt(body && body.port, 10);
    return { protocol, address, port };
}

// Name lookups for the IP path use the system's DNS servers through c-ares (a bounded,
// cancellable lookup that never occupies the libuv thread pool). Tests inject their own.
function defaultResolve4(name) {
    const r = new dns.promises.Resolver({ timeout: NAME_LOOKUP_TIMEOUT_MS, tries: 1 });
    return r.resolve4(name);
}

// What the typed address means and whether this user may reach it:
//   { ok, gateway: 'ip', address: <ip>, name: <typed name or ''>, verdict }
//   { ok, gateway: 'names', address: <name>, name: <name>, verdict }
// A name that matches a NetBird domain resource goes to the names gateway; any other name is
// looked up and each IPv4 answer is checked like a typed IP (the first allowed one is used).
async function resolveTarget(snap, userId, address, port, opts = {}) {
    const ipCfg = opts.ipCfg || authCfg('ip');
    const namesCfg = opts.namesCfg || authCfg('names');
    const resolve4 = opts.resolve4 || _deps.resolve4 || defaultResolve4;
    const t = normalizeTarget(address);
    if (t.error) return { ok: false, verdict: { ok: false, code: t.error } };
    if (t.kind === 'ip') {
        const verdict = evaluateUserAccess(snap, ipCfg, { userId, address: t.ip, port });
        return { ok: verdict.ok, gateway: 'ip', address: t.ip, name: '', verdict };
    }
    const named = evaluateNameAccess(snap, namesCfg, { userId, name: t.name, port });
    if (named.code !== 'NO_DOMAIN_MATCH') return { ok: named.ok, gateway: 'names', address: t.name, name: t.name, verdict: named };
    let ips;
    try { ips = await resolve4(t.name); }
    catch (e) {
        const code = e && e.code === 'ENOTFOUND' ? 'NAME_NOT_FOUND' : e && e.code === 'ENODATA' ? 'NO_IPV4_ADDRESS' : 'NAME_LOOKUP_FAILED';
        return { ok: false, gateway: 'ip', address: '', name: t.name, verdict: { ok: false, code } };
    }
    const list = (Array.isArray(ips) ? ips : []).map(String).filter(ip => !normalizeTarget(ip).error && normalizeTarget(ip).kind === 'ip');
    if (!list.length) return { ok: false, gateway: 'ip', address: '', name: t.name, verdict: { ok: false, code: 'NO_IPV4_ADDRESS' } };
    let first = null;
    for (const ip of list) {
        const verdict = evaluateUserAccess(snap, ipCfg, { userId, address: ip, port });
        if (verdict.ok) return { ok: true, gateway: 'ip', address: ip, name: t.name, verdict };
        if (!first) first = { ok: false, gateway: 'ip', address: ip, name: t.name, verdict };
    }
    return first;
}

async function checkAccess(viewer, body) {
    const { protocol, address, port } = parseTarget(body);
    const steps = [];
    let snap;
    try { snap = await freshSnapshot(CHECK_SNAPSHOT_TTL_MS); }
    catch (e) { return { steps: [{ key: 'access', status: 'fail', code: 'SNAPSHOT_FAILED', message: MESSAGES.SNAPSHOT_FAILED }] }; }
    const rt = await resolveTarget(snap, viewer.user_id, address, port);
    const verdict = rt.verdict;
    const target = { protocol, address: rt.address || address, name: rt.name || '', gateway: rt.gateway || 'ip', port, resource: verdict.resource || null, network: verdict.network || null };
    if (!verdict.ok) {
        steps.push({ key: 'access', status: 'fail', code: verdict.code, message: MESSAGES[verdict.code] || verdict.code, requestable: REQUESTABLE.has(verdict.code) });
        return { steps, target };
    }
    steps.push({ key: 'access', status: 'pass', detail: `Granted by ${verdict.policies.join(', ')}` });
    const routers = await withDeadline(netbirdGet(`/api/networks/${encodeURIComponent(verdict.network.id)}/routers`), SNAPSHOT_DEADLINE_MS, 'Reading routers').catch(() => null);
    if (!Array.isArray(routers)) {
        steps.push({ key: 'path', status: 'fail', code: 'SNAPSHOT_FAILED', message: MESSAGES.SNAPSHOT_FAILED });
        return { steps, target };
    }
    const path = pathStatus(snap, authCfg(rt.gateway), routers);
    steps.push(path.ok
        ? { key: 'path', status: 'pass', detail: `Gateway online, routing peer online for ${verdict.network.name}` }
        : { key: 'path', status: 'fail', code: path.code, message: MESSAGES[path.code] || path.code, troubleshoot: path.code === 'NO_ROUTER_ONLINE' });
    return { steps, target, ok: path.ok };
}

// ─── Sessions ───
const _tokens = new Map();   // token -> { sessionId, expiresAt }
const _sessions = new Map(); // sessionId -> session
let _lastGoodRecheck = Date.now();

const countFor = (userId) => [..._sessions.values()].filter(s => s.userId === userId).length;

function sessionEvent(s, kind, extra = {}) {
    const end = kind === 'end';
    return {
        ID: `${s.id}:${kind}`,
        Timestamp: (end ? (extra.endedAt || new Date()) : s.startedAt).toISOString(),
        Message: end ? 'TYPE_END' : 'TYPE_START',
        reference: `remote-access:${s.protocol}`,
        meta: {
            flow_id: s.id, protocol: 6, direction: 'EGRESS',
            source_addr: s.clientIp || '', source_name: 'Browser Gateway', source_type: SOURCE_TYPE,
            destination_addr: `${s.address}:${s.port}`, destination_name: s.resourceName || s.address,
            destination_id: s.resourceId || '', destination_type: s.resourceType || '',
            user_id: s.userId,
            // Bytes are the Guacamole tunnel's, not RDP/SSH wire bytes - only on the end record so
            // sums per flow are not doubled.
            rx_bytes: end ? (extra.rx || 0) : 0, tx_bytes: end ? (extra.tx || 0) : 0,
        },
        remoteAccess: { protocol: s.protocol, user: s.userEmail || s.userName || '', name: s.targetName || undefined, gateway: s.gateway || 'ip', endReason: extra.reason || undefined, bytes: end ? 'tunnel' : undefined },
    };
}

async function createSession(viewer, body, clientIp) {
    if (!remoteAccessAvailable()) throw httpError(403, 'DISABLED', 'Browser remote access is turned off.');
    const { protocol, address, port } = parseTarget(body);
    if (countFor(viewer.user_id) >= _cfg.maxSessionsPerUser) throw httpError(429, 'TOO_MANY', `You already have ${_cfg.maxSessionsPerUser} open sessions. Close one first.`);
    if (_sessions.size >= _cfg.maxSessionsTotal) throw httpError(429, 'TOO_MANY_TOTAL', 'The Browser Gateway is at its session limit. Try again later.');

    let snap;
    try { snap = await freshSnapshot(CHECK_SNAPSHOT_TTL_MS); } catch { throw httpError(503, 'SNAPSHOT_FAILED'); }
    const rt = await resolveTarget(snap, viewer.user_id, address, port);
    const verdict = rt.verdict;
    if (!verdict.ok) throw httpError(403, verdict.code);
    // The path check is enforced here too, not only shown by /check.
    const routers = await withDeadline(netbirdGet(`/api/networks/${encodeURIComponent(verdict.network.id)}/routers`), SNAPSHOT_DEADLINE_MS, 'Reading routers').catch(() => null);
    if (!Array.isArray(routers)) throw httpError(503, 'SNAPSHOT_FAILED');
    const path = pathStatus(snap, authCfg(rt.gateway), routers);
    if (!path.ok) throw httpError(409, path.code);

    const width = clampInt(body.width, 320, MAX_WIDTH, 1280);
    const height = clampInt(body.height, 240, MAX_HEIGHT, 720);
    // Up to Windows' largest scaling (500%).
    const dpi = clampInt(body.dpi, 72, 480, 96);
    const timezone = /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(body.timezone || '')) ? String(body.timezone) : '';
    const creds = {};
    if (protocol === 'ssh') {
        creds.username = String(body.username || '').slice(0, 256);
        creds.password = String(body.password || '').slice(0, 1024);
        creds.privateKey = String(body.privateKey || '').slice(0, 16384);
        creds.passphrase = String(body.passphrase || '').slice(0, 1024);
        if (!creds.username) throw httpError(400, 'USERNAME_REQUIRED', 'Enter the user name for the SSH server.');
    }

    // Check the quota again: the snapshot read above may have let another request in.
    if (countFor(viewer.user_id) >= _cfg.maxSessionsPerUser || _sessions.size >= _cfg.maxSessionsTotal) throw httpError(429, 'TOO_MANY');
    const s = {
        id: crypto.randomUUID(), protocol, address: rt.address, port, width, height, dpi, timezone, creds,
        gateway: rt.gateway, targetName: rt.name || '',
        userId: viewer.user_id, userEmail: viewer.email || '', userName: viewer.name || '', oid: viewer.oid || '',
        clientIp: String(clientIp || ''),
        resourceId: verdict.resource.id, resourceName: verdict.resource.name || rt.address,
        resourceType: verdict.resource.type === 'subnet' ? 'SUBNET_RESOURCE' : verdict.resource.type === 'domain' ? 'DOMAIN_RESOURCE' : 'HOST_RESOURCE',
        networkId: verdict.network.id,
        startedAt: new Date(), leaseAt: Date.now(), lastInputAt: Date.now(),
        state: 'pending', ws: null, guacd: null, rx: 0, tx: 0, closed: false,
    };
    _sessions.set(s.id, s); // counts toward the quota from now on, including setup

    try {
        await pool.query(
            `INSERT INTO remote_sessions (id, user_id, user_email, user_name, client_ip, protocol, target_addr, target_port, resource_id, resource_name, network_id, started_at, target_name, gateway)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [s.id, s.userId, s.userEmail, s.userName, s.clientIp, protocol, s.address, port, s.resourceId, s.resourceName, s.networkId, s.startedAt, s.targetName, s.gateway]);
        await addEvent(sessionEvent(s, 'start'));
    } catch (e) {
        _sessions.delete(s.id);
        await pool.query('DELETE FROM remote_sessions WHERE id = $1', [s.id]).catch(() => { });
        console.error('[remote-access] could not record session start:', e.message);
        throw httpError(503, 'RECORD_FAILED', "The session couldn't be recorded, so it was not opened. Try again.");
    }

    const token = crypto.randomBytes(32).toString('base64url');
    _tokens.set(token, { sessionId: s.id, expiresAt: Date.now() + TOKEN_TTL_MS });
    // Still pending after the token's lifetime (never used, or used by an upgrade that then
    // failed): close it, so it never holds a quota slot.
    s.tokenTimer = setTimeout(() => {
        _tokens.delete(token);
        if (s.state === 'pending') closeSession(s, 'The session was not opened in time.');
    }, TOKEN_TTL_MS + 1000);
    return { sessionId: s.id, token, resource: verdict.resource, network: verdict.network, address: s.address, name: s.targetName, gateway: s.gateway };
}

// Lease renewal through an ordinary authenticated request (the SSO middleware answers 401 for an
// expired session, so a lapsed sign-in simply stops renewing).
function renewLease(viewer, sessionId) {
    const s = _sessions.get(sessionId);
    if (!s || s.userId !== viewer.user_id) return false;
    s.leaseAt = Date.now();
    return true;
}

function endSession(viewer, sessionId) {
    const s = _sessions.get(sessionId);
    if (!s || s.userId !== viewer.user_id) return false;
    closeSession(s, 'Closed by the user.');
    return true;
}

// ─── Guacamole protocol ───
// Elements are "<length>.<value>", lengths in Unicode code points; instructions end with ";".
function encodeElement(v) {
    const str = String(v);
    return `${[...str].length}.${str}`;
}
function encodeInstruction(opcode, ...args) {
    return [opcode, ...args].map(encodeElement).join(',') + ';';
}

// Incremental parser over decoded text. Returns complete instructions as
// { opcode, args, raw }. Throws on malformed input, an oversized element, more elements than
// allowed, an instruction longer than maxInstruction, or more than maxPending units of an
// unfinished instruction left at the end of a push. The parse state (inside a length, a value or
// between elements) is kept across push() calls, so no unit of input is read twice however the
// text is split: `examined`, the units stepped over, always equals the input length so far.
// After a throw the parser must not be reused.
const SURROGATES = /[\uD800-\uDFFF]/;
class GuacParser {
    constructor(maxLen, { maxElements = Infinity, maxInstruction = Infinity, maxPending = maxLen + 64 } = {}) {
        this.maxLen = maxLen;
        this.maxElements = maxElements;
        this.maxInstruction = maxInstruction;
        this.maxPending = maxPending;
        this.examined = 0;
        this._reset();
    }
    _reset() {
        this.state = 'len';      // 'len' (digits) | 'value' (code points) | 'term' (',' or ';')
        this.lenStr = '';
        this.need = 0;           // code points still missing from the current value
        this.lowNext = false;    // the value's last high surrogate ended the previous chunk
        this.valueParts = [];
        this.elements = [];
        this.rawParts = [];
        this.size = 0;           // units of the pending instruction so far
    }
    push(text) {
        const out = [];
        const n = text.length;
        let i = 0;
        let seg = 0;             // where the pending instruction's text in this chunk starts
        const grow = (units) => {
            this.size += units;
            if (this.size > this.maxInstruction) throw new Error('instruction too large');
        };
        while (i < n) {
            if (this.state === 'len') {
                const c = text.charCodeAt(i);
                this.examined++;
                if (c >= 48 && c <= 57) {
                    if (this.lenStr.length >= 10) throw new Error('malformed instruction');
                    this.lenStr += text[i++];
                    grow(1);
                    continue;
                }
                if (c !== 46 || !this.lenStr) throw new Error('malformed instruction');
                const len = Number(this.lenStr);
                if (len > this.maxLen) throw new Error('instruction too large');
                if (this.elements.length >= this.maxElements) throw new Error('too many elements');
                i++;
                grow(1);
                this.lenStr = '';
                this.need = len;
                this.state = len ? 'value' : 'term';
                continue;
            }
            if (this.state === 'value') {
                const from = i;
                if (this.lowNext) {
                    // A high surrogate ended the previous chunk: the next unit belongs to its code
                    // point, as it would have without the split.
                    this.lowNext = false;
                    i++;
                }
                const span = Math.min(this.need, n - i);
                if (!SURROGATES.test(text.slice(i, i + span))) { i += span; this.need -= span; } else {
                    while (this.need > 0 && i < n) {
                        const c = text.charCodeAt(i);
                        if (c >= 0xD800 && c <= 0xDBFF) {
                            if (i + 1 < n) i += 2;
                            else { i += 1; this.lowNext = true; }
                        } else i += 1;
                        this.need--;
                    }
                }
                this.valueParts.push(text.slice(from, i));
                this.examined += i - from;
                grow(i - from);
                if (this.need === 0 && !this.lowNext) this.state = 'term';
                continue;
            }
            // state 'term'
            const c = text[i];
            this.examined++;
            if (c !== ',' && c !== ';') throw new Error('malformed instruction');
            i++;
            grow(1);
            this.elements.push(this.valueParts.length === 1 ? this.valueParts[0] : this.valueParts.join(''));
            this.valueParts = [];
            if (c === ',') { this.state = 'len'; continue; }
            this.rawParts.push(text.slice(seg, i));
            const elements = this.elements;
            out.push({ opcode: elements[0], args: elements.slice(1), raw: this.rawParts.join('') });
            this._reset();
            seg = i;
        }
        if (seg < n) this.rawParts.push(text.slice(seg));
        if (this.size > this.maxPending) throw new Error('instruction too large');
        return out;
    }
}

// The host guacd connects to: the IP, or for the names gateway the name as an absolute FQDN
// (trailing dot), which the resolver never expands with its search list (resolv.conf(5)).
const guacdHostname = (s) => (s.gateway === 'names' ? `${s.address}.` : s.address);

const flag = (on) => (on ? 'true' : '');

function connectArgs(s, argNames) {
    const look = _cfg.rdp, term = _cfg.ssh;
    const rdp = {
        hostname: guacdHostname(s), port: String(s.port),
        security: 'any', 'ignore-cert': 'true',
        'resize-method': 'display-update',
        // The browser's DPI. Without it guacd picks 96 DPI and shrinks the size the browser asked
        // for to match, so a scaled screen (150%) would get a smaller, upscaled desktop.
        dpi: String(s.dpi || 96),
        'color-depth': String(look.colorDepth),
        // guacd's graphics pipeline (GFX, on by default) always runs at 32-bit and ignores
        // color-depth, so a lower depth turns it off.
        'disable-gfx': flag(look.colorDepth < 32),
        'server-layout': look.serverLayout,
        'enable-font-smoothing': flag(look.fontSmoothing),
        'enable-wallpaper': flag(look.wallpaper),
        'enable-theming': flag(look.theming),
        'enable-full-window-drag': flag(look.fullWindowDrag),
        'enable-desktop-composition': flag(look.desktopComposition),
        'enable-menu-animations': flag(look.menuAnimations),
        'disable-audio': 'true', 'enable-drive': '', 'enable-printing': '',
        'disable-download': 'true', 'disable-upload': 'true',
        'disable-copy': _cfg.clipboard ? '' : 'true', 'disable-paste': _cfg.clipboard ? '' : 'true',
        timezone: s.timezone,
        // Credentials are left empty: an NLA server makes guacd ask for them ("required"),
        // otherwise the Windows logon screen appears in the session.
        username: '', password: '', domain: '',
    };
    const ssh = {
        hostname: guacdHostname(s), port: String(s.port),
        username: s.creds.username || '', password: s.creds.password || '',
        'private-key': s.creds.privateKey || '', passphrase: s.creds.passphrase || '',
        // The key set for the name the user typed, else for the address used.
        'host-key': (s.targetName && _cfg.sshHostKeys[s.targetName]) || _cfg.sshHostKeys[s.address] || '',
        'disable-copy': _cfg.clipboard ? '' : 'true', 'disable-paste': _cfg.clipboard ? '' : 'true',
        'enable-sftp': '', timezone: s.timezone,
        'font-size': String(term.fontSize), 'color-scheme': term.colorScheme,
    };
    const map = s.protocol === 'rdp' ? rdp : ssh;
    return argNames.map(name => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : ''));
}

// Client instructions that count as user activity (for the idle timeout).
const INPUT_OPCODES = new Set(['key', 'mouse', 'touch', 'clipboard', 'argv', 'blob', 'end']);
// Client instructions passed to guacd after the handshake. Anything else is dropped.
const CLIENT_OPCODES = new Set(['key', 'mouse', 'touch', 'size', 'clipboard', 'argv', 'blob', 'end', 'ack', 'sync', 'nop', 'disconnect']);
// Connection parameters the browser may send with "argv": the ones guacd asks for with
// "required", plus terminal settings guacd always accepts for SSH. The target never comes from
// the browser, even if asked for.
const SSH_ARGV = ['font-name', 'font-size', 'color-scheme'];
const NEVER_ARGV = new Set(['hostname', 'port']);
// guacd's stream indices are 0..511 (GUAC_USER_MAX_STREAMS); written as plain decimals.
const MAX_STREAMS = 512;
const streamIndex = (v) => (/^(0|[1-9]\d{0,2})$/.test(v || '') && Number(v) < MAX_STREAMS ? Number(v) : -1);

function sendError(ws, message, code) {
    try { if (ws && ws.readyState === 1) ws.send(encodeInstruction('error', message, String(code))); } catch { /* closing anyway */ }
}

// Attach an upgraded WebSocket to its pending session. Called by server.js after it consumed
// the token with takeToken().
function attachTunnel(sessionId, ws) {
    const s = _sessions.get(sessionId);
    if (!s || s.state !== 'pending' || s.closed) { sendError(ws, 'This session is no longer available.', 0x0205); ws.close(); return; }
    clearTimeout(s.tokenTimer);
    s.state = 'connecting';
    s.ws = ws;
    // The tunnel's own UUID first: Guacamole.WebSocketTunnel marks itself open on it.
    ws.send(encodeInstruction('', s.id));

    const sock = net.connect(s.gateway === 'names'
        ? { host: _cfg.namesGuacdHost, port: _cfg.namesGuacdPort }
        : { host: _cfg.guacdHost, port: _cfg.guacdPort });
    s.guacd = sock;
    const decoder = new StringDecoder('utf8');
    const parser = new GuacParser(GUACD_INSTRUCTION_MAX);
    const clientParser = new GuacParser(CLIENT_INSTRUCTION_MAX, { maxElements: CLIENT_MAX_ELEMENTS, maxInstruction: CLIENT_INSTRUCTION_MAX });
    // argv names guacd asked for, and the browser's open output streams (clipboard, allowed argv).
    const argvNames = new Set(s.protocol === 'ssh' ? SSH_ARGV : []);
    const openStreams = new Set();
    let warnedDrop = false;
    const noteRequired = (list) => {
        for (const ins of list) if (ins.opcode === 'required') for (const name of ins.args) argvNames.add(name);
    };
    // Stream instructions from the browser: clipboard and an asked-for argv open a stream; blob
    // and end pass only on an open one. Anything else (another name, an unknown index) is dropped.
    const streamAllowed = (ins) => {
        const op = ins.opcode;
        if (op !== 'clipboard' && op !== 'argv' && op !== 'blob' && op !== 'end') return true;
        const idx = streamIndex(ins.args[0]);
        if (idx < 0) return false;
        if (op === 'clipboard') { openStreams.add(idx); return true; }
        if (op === 'argv') {
            const name = ins.args[2];
            if (argvNames.has(name) && !NEVER_ARGV.has(name)) { openStreams.add(idx); return true; }
            openStreams.delete(idx);
            return false;
        }
        if (!openStreams.has(idx)) return false;
        if (op === 'end') openStreams.delete(idx);
        return true;
    };
    let handshakeDone = false;
    const handshakeTimer = setTimeout(() => {
        if (!handshakeDone) failSession(s, 'The Browser Gateway did not answer in time.', 0x0208);
    }, HANDSHAKE_TIMEOUT_MS);

    sock.setNoDelay(true);
    sock.on('connect', () => sock.write(encodeInstruction('select', s.protocol)));
    sock.on('error', (e) => failSession(s, handshakeDone ? 'The connection to the server was lost.' : 'The Browser Gateway is not reachable.', 0x0208, e.message));
    sock.on('close', () => closeSession(s, handshakeDone ? 'The server closed the connection.' : 'The Browser Gateway closed the connection.'));

    // Backpressure guacd -> browser.
    let stalledSince = 0;
    let drainTimer = null;
    const checkDrain = () => {
        if (s.closed) return clearInterval(drainTimer);
        if (ws.bufferedAmount <= WS_BUFFER_LOW) {
            clearInterval(drainTimer); drainTimer = null; stalledSince = 0; sock.resume();
        } else if (Date.now() - stalledSince > STALL_LIMIT_MS) {
            clearInterval(drainTimer); failSession(s, 'Your browser stopped receiving data, so the session was closed.', 0x0308);
        }
    };

    sock.on('data', (chunk) => {
        let instructions;
        try { instructions = parser.push(decoder.write(chunk)); }
        catch (e) { return failSession(s, 'The gateway sent data that could not be read.', 0x0200, e.message); }
        if (!handshakeDone) {
            for (let k = 0; k < instructions.length; k++) {
                const ins = instructions[k];
                if (ins.opcode === 'args') {
                    const version = ins.args[0] && ins.args[0].startsWith('VERSION_') ? ins.args[0] : null;
                    const names = version ? ins.args.slice(1) : ins.args;
                    sock.write(encodeInstruction('size', String(s.width), String(s.height), String(s.dpi)));
                    sock.write(encodeInstruction('audio'));
                    sock.write(encodeInstruction('video'));
                    sock.write(encodeInstruction('image', 'image/png', 'image/jpeg', 'image/webp'));
                    if (s.timezone) sock.write(encodeInstruction('timezone', s.timezone));
                    const values = connectArgs(s, names);
                    sock.write(encodeInstruction('connect', ...(version ? [version] : []), ...values));
                    // The SSH secrets are no longer needed here.
                    s.creds = {};
                } else if (ins.opcode === 'ready') {
                    handshakeDone = true;
                    clearTimeout(handshakeTimer);
                    s.state = 'open';
                    const after = instructions.slice(k + 1);
                    noteRequired(after);
                    const rest = after.map(x => x.raw).join('');
                    if (rest) forward(rest);
                    return;
                } else if (ins.opcode === 'error') {
                    return failSession(s, 'The Browser Gateway refused the connection.', 0x0203, ins.args[0]);
                }
            }
            return;
        }
        noteRequired(instructions);
        const text = instructions.map(x => x.raw).join('');
        if (text) forward(text);
    });

    function forward(text) {
        if (s.closed || ws.readyState !== 1) return;
        s.rx += Buffer.byteLength(text);
        ws.send(text);
        if (ws.bufferedAmount > WS_BUFFER_HIGH && !drainTimer) {
            sock.pause();
            stalledSince = Date.now();
            drainTimer = setInterval(checkDrain, 50);
        }
    }

    // Browser -> guacd.
    ws.on('message', (data, isBinary) => {
        if (isBinary) return failSession(s, 'Unexpected data from the browser.', 0x0300);
        let instructions;
        try { instructions = clientParser.push(data.toString('utf8')); }
        catch (e) { return failSession(s, 'The browser sent data that could not be read.', 0x0300, e.message); }
        let out = '';
        for (const ins of instructions) {
            if (ins.opcode === '') {
                // Internal channel: answer the stability ping with an identical message.
                if (ins.args[0] === 'ping') ws.send(ins.raw);
                continue;
            }
            if (!handshakeDone || !CLIENT_OPCODES.has(ins.opcode)) continue;
            if (ins.opcode === 'size') {
                const w = Number(ins.args[0]), h = Number(ins.args[1]);
                if (!(w > 0 && h > 0 && w <= MAX_WIDTH && h <= MAX_HEIGHT)) continue;
            }
            if (ins.opcode === 'disconnect') { closeSession(s, 'Closed by the user.'); return; }
            if (!streamAllowed(ins)) {
                if (!warnedDrop) { warnedDrop = true; console.warn('[remote-access] session %s: dropped a browser %s that guacd did not ask for', s.id, ins.opcode); }
                continue;
            }
            if (INPUT_OPCODES.has(ins.opcode)) s.lastInputAt = Date.now();
            out += ins.raw;
        }
        if (!out || s.closed) return;
        s.tx += Buffer.byteLength(out);
        if (!sock.write(out)) {
            ws.pause();
            const pausedAt = Date.now();
            const t = setTimeout(() => failSession(s, 'The server stopped receiving data, so the session was closed.', 0x0308), STALL_LIMIT_MS);
            sock.once('drain', () => { clearTimeout(t); if (!s.closed && Date.now() - pausedAt <= STALL_LIMIT_MS) ws.resume(); });
        }
    });
    ws.on('close', () => closeSession(s, 'The browser closed the session.'));
    ws.on('error', () => closeSession(s, 'The browser connection failed.'));
}

function failSession(s, message, code, detail) {
    if (s.closed) return;
    if (detail) console.error('[remote-access] session %s: %s (%s)', s.id, message, detail);
    sendError(s.ws, message, code);
    closeSession(s, message, code);
}

// The close reason carries the Guacamole status code: Guacamole.WebSocketTunnel reads it as the
// final status (0 = success, anything else = the error already sent as an instruction).
function closeSession(s, reason, code = 0) {
    if (!s || s.closed) return;
    s.closed = true;
    _sessions.delete(s.id);
    clearTimeout(s.tokenTimer);
    for (const [tok, v] of _tokens) if (v.sessionId === s.id) _tokens.delete(tok);
    s.creds = {};
    try { if (s.guacd) s.guacd.destroy(); } catch { /* already gone */ }
    try { if (s.ws && s.ws.readyState <= 1) s.ws.close(1000, String(code)); } catch { /* already gone */ }
    const endedAt = new Date();
    recordEnd(s, endedAt, reason).catch(e => console.error('[remote-access] could not record session end:', e.message));
}

// The end record goes to `events` first. Only then is the live-state row deleted: if the record
// fails, the row stays open and the next start-up closes it (the end record's fixed ID makes a
// second write a no-op). `remote_sessions` therefore never keeps finished sessions.
async function recordEnd(s, endedAt, reason) {
    await pool.query('UPDATE remote_sessions SET rx_bytes = $2, tx_bytes = $3 WHERE id = $1', [s.id, s.rx, s.tx]).catch(() => { });
    await addEvent(sessionEvent(s, 'end', { endedAt, reason, rx: s.rx, tx: s.tx }));
    await pool.query('DELETE FROM remote_sessions WHERE id = $1', [s.id]);
}

function closeAllSessions(reason) {
    _tokens.clear();
    for (const s of [..._sessions.values()]) failSession(s, reason, 0x0303);
}

// Consume a one-time token. Single-threaded: get + delete cannot interleave with another upgrade.
function takeToken(token) {
    const t = _tokens.get(String(token || ''));
    if (!t) return null;
    _tokens.delete(String(token));
    if (t.expiresAt < Date.now() || !remoteAccessAvailable()) return null;
    return t.sessionId;
}

// ─── Re-check: every live session keeps its access, lease, limits ───
async function recheckSessions() {
    const now = Date.now();
    for (const s of [..._sessions.values()]) {
        if (s.state !== 'pending' && now - s.leaseAt > LEASE_TIMEOUT_MS) { failSession(s, 'Your sign-in ended or the page stopped responding, so the session was closed.', 0x0303); continue; }
        if (now - s.lastInputAt > _cfg.idleTimeoutMin * 60_000) { failSession(s, `The session was idle for ${_cfg.idleTimeoutMin} minutes and was closed.`, 0x020A); continue; }
        if (now - s.startedAt.getTime() > _cfg.maxDurationHours * 3_600_000) { failSession(s, `Sessions are limited to ${_cfg.maxDurationHours} hours. Connect again to continue.`, 0x020A); continue; }
    }
    if (!_sessions.size) { _lastGoodRecheck = now; return; }
    let snap = null;
    try {
        _snapshot = null; // the re-check always reads NetBird again
        snap = await freshSnapshot(0);
        _lastGoodRecheck = Date.now();
    } catch (e) {
        console.error('[remote-access] re-check could not read NetBird:', e.message);
    }
    if (!snap) {
        if (Date.now() - _lastGoodRecheck > SNAPSHOT_MAX_AGE_MS) closeAllSessions("Your access couldn't be verified with NetBird, so the session was closed.");
        return;
    }
    // Permission checks may wait on Microsoft Graph: they run in parallel, once per user, each with
    // its own deadline - one slow lookup never delays the other sessions' checks (a check that times
    // out or fails denies).
    const permission = new Map();
    const permitted = (s) => {
        if (!_deps.stillPermitted) return Promise.resolve(true);
        if (!permission.has(s.userId)) {
            permission.set(s.userId, withDeadline(Promise.resolve(_deps.stillPermitted({ oid: s.oid, email: s.userEmail, userId: s.userId, snap })), PERMISSION_DEADLINE_MS, 'Checking the permission')
                .then(ok => !!ok, () => false));
        }
        return permission.get(s.userId);
    };
    await Promise.all([..._sessions.values()].map(async (s) => {
        const v = s.gateway === 'names'
            ? evaluateNameAccess(snap, authCfg('names'), { userId: s.userId, name: s.address, port: s.port })
            : evaluateUserAccess(snap, authCfg('ip'), { userId: s.userId, address: s.address, port: s.port });
        if (!v.ok || v.resource.id !== s.resourceId) { failSession(s, `Your access to this server ended: ${MESSAGES[v.code] || v.code || 'the route changed.'}`, 0x0303); return; }
        if (!(await permitted(s)) && !s.closed) failSession(s, 'You no longer have permission to use browser remote access.', 0x0303);
    }));
}

// Sweeps that need no NetBird read: lease, idle, duration. Runs more often than the full re-check
// so a stuck NetBird read can never hold sessions open past their limits.
function sweepSessions() {
    const now = Date.now();
    if (_sessions.size && now - _lastGoodRecheck > SNAPSHOT_MAX_AGE_MS) closeAllSessions("Your access couldn't be verified with NetBird, so the session was closed.");
    for (const s of [..._sessions.values()]) {
        if (s.state !== 'pending' && now - s.leaseAt > LEASE_TIMEOUT_MS) failSession(s, 'Your sign-in ended or the page stopped responding, so the session was closed.', 0x0303);
    }
}

// Sessions left open by a crash or restart: closed with an honest reason.
async function closeOrphanSessions() {
    const r = await pool.query('SELECT * FROM remote_sessions');
    const reason = 'The server restarted. The real end time is unknown.';
    let closed = 0;
    for (const row of r.rows) {
        const s = {
            id: row.id, protocol: row.protocol, address: row.target_addr, port: row.target_port,
            userId: row.user_id, userEmail: row.user_email, userName: row.user_name, clientIp: row.client_ip,
            resourceId: row.resource_id, resourceName: row.resource_name, resourceType: '',
            targetName: row.target_name || '', gateway: row.gateway || 'ip',
            startedAt: new Date(row.started_at),
        };
        try {
            await addEvent(sessionEvent(s, 'end', { endedAt: new Date(), reason, rx: Number(row.rx_bytes) || 0, tx: Number(row.tx_bytes) || 0 }));
            await pool.query('DELETE FROM remote_sessions WHERE id = $1', [row.id]);
            closed++;
        } catch (e) {
            console.error('[remote-access] orphan end record (kept for the next start-up):', e.message);
        }
    }
    return closed;
}

// ─── Status (admin settings + System Health) ───
function probeGuacd(host, port) {
    return new Promise((resolve) => {
        const sock = net.connect({ host, port });
        const done = (ok) => { sock.destroy(); resolve(ok); };
        sock.setTimeout(2000, () => done(false));
        sock.on('connect', () => done(true));
        sock.on('error', () => done(false));
    });
}

function getRemoteAccessStatusLite() { return { activeSessions: _sessions.size }; }

async function getRemoteAccessStatus() {
    const out = {
        enabled: _cfg.enabled, activeSessions: _sessions.size, guacdReachable: null,
        gateway: { enrolled: false, online: false, peers: [] }, domainRoutes: [], extraReach: [], targets: 0, error: '',
        names: { guacdReachable: null, gateway: { enrolled: false, online: false, peers: [] }, extraReach: [], targets: 0 },
        conflicts: [],
        lastApply: { ..._lastApply },
    };
    [out.guacdReachable, out.names.guacdReachable] = await Promise.all([
        probeGuacd(_cfg.guacdHost, _cfg.guacdPort), probeGuacd(_cfg.namesGuacdHost, _cfg.namesGuacdPort)]);
    if (!netbirdApiConfigured()) { out.error = 'The NetBird API is not connected.'; return out; }
    try {
        const snap = await freshSnapshot(30_000);
        const peersOf = (r) => (r.peers || []).map(p => ({ id: p.id, name: p.name || p.id, connected: !!p.connected, ip: p.ip || '' }));
        const nreach = gatewayReach(snap, authCfg('names'));
        out.names.gateway.enrolled = !nreach.error;
        out.names.gateway.peers = peersOf(nreach);
        out.names.gateway.online = out.names.gateway.peers.some(p => p.connected);
        // Any address route on the names gateway blocks connecting by name (it could capture the
        // address a name resolves to).
        out.names.extraReach = (nreach.entries || []).map(e => ({ name: e.name, address: e.address, network: e.networkName || (e.kind === 'route' ? 'Network route' : '') }));
        out.names.targets = (nreach.domain || []).filter(d => d.selected).length;
        if (_deps.scanResourceConflicts) {
            const sel = new Set(_cfg.networks);
            const all = await withDeadline(Promise.resolve(_deps.scanResourceConflicts()), SNAPSHOT_DEADLINE_MS, 'Scanning address conflicts').catch(() => []);
            out.conflicts = (Array.isArray(all) ? all : [])
                .filter(c => (c.networks || []).some(n => sel.has(n.id)))
                .map(c => ({ address: c.address, networks: (c.networks || []).map(n => n.name) }));
        }
        const reach = gatewayReach(snap, authCfg('ip'));
        out.gateway.enrolled = !reach.error;
        out.gateway.peers = (reach.peers || []).map(p => ({ id: p.id, name: p.name || p.id, connected: !!p.connected, ip: p.ip || '' }));
        out.gateway.online = out.gateway.peers.some(p => p.connected);
        out.domainRoutes = (reach.domain || []).map(d => ({ name: d.name, address: d.address, network: d.networkName }));
        out.extraReach = extraReach(reach).map(e => ({ name: e.name, address: e.address, network: e.networkName || (e.kind === 'route' ? 'Network route' : '') }));
        out.targets = (reach.entries || []).filter(e => e.selected).length;
    } catch (e) {
        out.error = e.message || String(e);
    }
    return out;
}

module.exports = {
    loadRemoteAccessConfig, getRemoteAccessConfig, setRemoteAccessConfig, setRemoteAccessDeps,
    isRemoteAccessManagedPolicy, remoteAccessAvailable, reconcileRemoteAccess, createGatewaySetupKey,
    checkAccess, createSession, renewLease, endSession, takeToken, attachTunnel,
    recheckSessions, sweepSessions, closeOrphanSessions, closeAllSessions, getRemoteAccessStatus, getRemoteAccessStatusLite,
    RECHECK_INTERVAL_MS, WS_MAX_PAYLOAD,
    _internal: { GuacParser, CLIENT_MAX_ELEMENTS, encodeInstruction, connectArgs, normConfig, sessionEvent, resolveTarget, MESSAGES, setConfigForTest: (c) => { _cfg = normConfig(c); } },
};
