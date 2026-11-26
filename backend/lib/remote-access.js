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
//     group and one standing policy). The admin-selected networks only say which resources MAY
//     become targets: a resource joins its target group when a session opens to it, and stays
//     while its hold lasts (see "Target holds");
//   - session issue (one-time token), the WebSocket <-> guacd tunnel, quotas and backpressure;
//   - the per-minute re-check that disconnects sessions whose access is gone;
//   - session records in `events` (same format as NetBird traffic, source_type BROWSER_GATEWAY)
//     and live state in `remote_sessions`.
// Main account only: nothing here runs in a tenant context.
//
// This module never requires db.js (db.js requires it, for the app-owned object checks, the target
// rule and the target lock). The few
// db.js helpers it needs are injected by server.js through setRemoteAccessDeps().

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const dns = require('dns');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { pool, getSetting, setSetting } = require('./core');
const { netbirdGet, netbirdPost, netbirdReq, bustNbCaches, netbirdApiConfigured, NETBIRD_READONLY, currentTenantAccount, nbDirectGet, getUsageData, _nbApi } = require('./netbird');
const { addEvent } = require('./events');
const apiKeys = require('./api-keys');
const { evaluateUserAccess, evaluateNameAccess, normalizeTarget, isExactDomainResource, gatewayReach, extraReach, pathStatus, isManagedGatewayName, parsePrefix, standingPolicyProblem, userSourceGroups, ipv4ToInt, isRefusedTarget, webRouteBody, webPolicyBody, webRouteMatches, webPolicyMatches, WEB_ROUTE_NETWORK_PREFIX } = require('./remote-access-auth');
const { ipUncovered, nameUncovered, nameCovered, ipCovered } = require('./coverage');
const { addressBlockedForNetwork, getBlocklist } = require('./blocklist');
const { nbListBody } = require('./pure');

// The managed NetBird objects of each gateway. In NetBird each is named "<base> (<installation
// name>)", so installations that share one NetBird account (production and DEV) never collide.
const KINDS = {
    ip: { group: 'Browser Gateway', targets: 'Browser Gateway Targets', policy: 'Browser Gateway', groupKey: 'gatewayGroupId', targetKey: 'targetGroupId', policyKey: 'policyId' },
    names: { group: 'Browser Gateway Names', targets: 'Browser Gateway Name Targets', policy: 'Browser Gateway Names', groupKey: 'namesGroupId', targetKey: 'namesTargetGroupId', policyKey: 'namesPolicyId' },
};
const DEFAULT_INSTALL_NAME = 'NetBird Control';
const NB_NAME_MAX = 100;
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
const WS_MAX_PAYLOAD = CLIENT_INSTRUCTION_MAX;
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
    // How long a server a session opened stays in its target group after that session's start (and
    // after each re-check of a session still open to it).
    holdHours: 10,
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
    // networkId is set by the Choose Network actions only, groupId by resolving the chosen profile.
    createResources: { enabled: false, networkId: '', profileId: 0, groupId: '', max: 50 },
    browser: { enabled: false, routerGroupId: '', maxSessions: 5, keepAliveMin: 15 },
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
const NB_EMPTY = { gatewayGroupId: '', targetGroupId: '', policyId: '', namesGroupId: '', namesTargetGroupId: '', namesPolicyId: '', webGroupId: '', webAclGroupId: '', webRouteId: '', webPolicyId: '', webRoutingPolicyId: '' };
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
        holdHours: clampInt(x.holdHours, 1, 72, DEFAULTS.holdHours),
        clipboard: x.clipboard === undefined ? DEFAULTS.clipboard : !!x.clipboard,
        sshHostKeys: keys,
        rdp: normRdp(x.rdp),
        ssh: normSsh(x.ssh),
        createResources: normCreate(x.createResources),
        browser: normBrowser(x.browser),
    };
}

function normBrowser(v) {
    const x = v && typeof v === 'object' ? v : {};
    const d = DEFAULTS.browser;
    const routerGroupId = String(x.routerGroupId || '');
    return {
        enabled: !!x.enabled,
        routerGroupId: /^[A-Za-z0-9_|:.@-]{1,200}$/.test(routerGroupId) ? routerGroupId : '',
        maxSessions: clampInt(x.maxSessions, 1, 50, d.maxSessions),
        keepAliveMin: clampInt(x.keepAliveMin, 1, 120, d.keepAliveMin),
    };
}

function normCreate(v) {
    const x = v && typeof v === 'object' ? v : {};
    const d = DEFAULTS.createResources;
    const networkId = String(x.networkId || '');
    const groupId = String(x.groupId || '');
    const profileId = Number(x.profileId); // a SERIAL: at most an int4
    return {
        enabled: !!x.enabled,
        networkId: /^[A-Za-z0-9_-]{1,64}$/.test(networkId) ? networkId : '',
        profileId: Number.isInteger(profileId) && profileId > 0 && profileId <= 2147483647 ? profileId : 0,
        groupId: /^[A-Za-z0-9_|:.@-]{1,200}$/.test(groupId) ? groupId : '',
        max: clampInt(x.max, 1, 500, d.max),
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

async function loadRemoteAccessConfig({ strict = false } = {}) {
    // strict (the leader's reload): a database error is thrown instead of falling back to defaults.
    try { _cfg = normConfig(JSON.parse(await getSetting('remote_access_config') || 'null')); } catch (e) { if (strict && !(e instanceof SyntaxError)) throw e; _cfg = { ...DEFAULTS }; }
    try {
        const n = JSON.parse(await getSetting('remote_access_nb') || 'null') || {};
        _nb = Object.fromEntries(Object.keys(NB_EMPTY).map(k => [k, String(n[k] || '')]));
    } catch (e) { if (strict && !(e instanceof SyntaxError)) throw e; _nb = { ...NB_EMPTY }; }
    await loadTargetHolds({ strict });
}

function getRemoteAccessConfig() {
    return { ..._cfg, networks: [..._cfg.networks], sshHostKeys: { ..._cfg.sshHostKeys }, rdp: { ..._cfg.rdp }, ssh: { ..._cfg.ssh }, createResources: { ..._cfg.createResources }, browser: { ..._cfg.browser },
        options: { rdpLayouts: RDP_LAYOUTS, rdpColorDepths: RDP_COLOR_DEPTHS, sshColorSchemes: SSH_COLOR_SCHEMES }, managed: { ..._nb }, lastApply: { ..._lastApply } };
}

function setRemoteAccessDeps(deps) { _deps = { ..._deps, ...deps }; }

// The standing gateway policies are infrastructure, not exposure: callers that mirror existing
// policies (temporary grants, resource policy edits) must skip them. Matched by id, and by name
// for a policy whose id was not saved yet (an interrupted first save).
function isRemoteAccessManagedPolicy(p) {
    if (!p) return false;
    return managedPolicyIdList().includes(p.id) || isManagedGatewayName(p.name, 'policy');
}

// The managed gateway and target groups are app-owned too: resource writes, grants and routers
// never add, remove or reuse them. Matched by stored id, and by the group's LIVE name from
// NetBird (callers pass that name, never one a client sent): the name covers the old objects
// when the stored ids are gone, for example after a settings import into a new database, and the
// objects of another installation on the same NetBird account.
const managedGroupIds = () => [...Object.values(KINDS).flatMap(k => [_nb[k.groupKey], _nb[k.targetKey]]), _nb.webGroupId, _nb.webAclGroupId].filter(Boolean);
const managedPolicyIdList = () => [_nb.policyId, _nb.namesPolicyId, _nb.webPolicyId, _nb.webRoutingPolicyId].filter(Boolean);
function isRemoteAccessManagedGroup(id, liveName) {
    if (!id) return false;
    return managedGroupIds().includes(id) || isManagedGatewayName(liveName, 'group');
}
const targetGroupIds = () => [_nb.targetGroupId, _nb.namesTargetGroupId].filter(Boolean);

// ─── Target holds ───
// A resource joins its target group only when an authorized user opens a session to it
// (createSession). It then has a hold: one row per resource id in `remote_access_targets`, with
// the network and the address it had (its identity) and an expiry. A session start sets the expiry
// to at least now + holdHours; the re-check of a session still open raises it again. Kept in memory
// too, because the sync's rule is synchronous: loaded with the settings, read again by the sync after
// each group read (another instance may have written one), and updated from the database's answer
// on every write.
const ROUTE_SETTLE_MS = 2000; // measured on a real account: the route was on the gateway 0.52-1.05 s after the write was sent
const HOLD_COLUMNS = 'resource_id, network_id, address, added_at, expires_at';
let _holds = new Map(); // resource id -> { networkId, address, addedAt (ms, 0 = unknown), expiresAt (ms) }
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
const msOf = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : 0; };
async function loadTargetHolds({ strict = false } = {}) {
    try {
        const r = await pool.query(`SELECT ${HOLD_COLUMNS} FROM remote_access_targets`);
        const next = new Map();
        for (const row of (r && Array.isArray(r.rows) ? r.rows : [])) {
            if (!row || typeof row.resource_id !== 'string' || !row.resource_id || !msOf(row.expires_at)) continue;
            next.set(row.resource_id, { networkId: String(row.network_id || ''), address: String(row.address || ''), addedAt: msOf(row.added_at), expiresAt: msOf(row.expires_at) });
        }
        _holds = next;
    } catch (e) {
        if (strict) throw e;
        console.error('[remote-access] could not read the target holds:', e.message);
    }
}
// An address as NetBird means it, in one form: "10.0.0.5" is "10.0.0.5/32", a subnet is written
// from its network address, and a name is lower case without a trailing dot. Holds store this form,
// and every comparison of addresses uses it.
const ipOf = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
function addressKey(address) {
    const a = String(address || '').trim();
    const p = parsePrefix(a);
    return p ? `${ipOf(p.start)}/${p.bits}` : a.toLowerCase().replace(/\.$/, '');
}
const sameIdentity = (h, networkId, address) => !!h && h.networkId === networkId && addressKey(h.address) === addressKey(address);
function holdValid(resourceId, networkId, address, now = Date.now()) {
    const h = resourceId ? _holds.get(resourceId) : null;
    return !!h && h.expiresAt > now && sameIdentity(h, networkId, address);
}

// The target group a resource's address qualifies for, while browser access is on and its network
// is open to it: the IP target group for an IPv4 host/subnet resource, the names target group for
// an exact domain resource; '' for anything else (wildcard domain resources included).
const isIpResourceAddress = (address) => /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(String(address || '').trim());
function targetGroupFor(networkId, address) {
    if (!_cfg.enabled || !_cfg.networks.includes(networkId)) return '';
    if (isIpResourceAddress(address)) return _nb.targetGroupId || '';
    return isExactDomainResource({ address: String(address || '').trim() }) ? (_nb.namesTargetGroupId || '') : '';
}
// The target sync's rule: a resource keeps a managed target group only while it is a member, its
// network is open to browser access, its address qualifies for that group, and it has a valid hold
// for its current network and address. Nothing but a session start ever adds one. Returns the
// target groups the resource may keep (members or not: the sync keeps only those it has).
function remoteAccessTargetGroupsFor(resourceId, networkId, address) {
    const tg = targetGroupFor(networkId, address);
    return tg && holdValid(resourceId, networkId, address) ? [tg] : [];
}
// A resource writer's group list (every resource write in db.js): writers never add a managed
// target group and don't look at holds (expiry is the sync's job). One the resource has now
// (`groupIds` are its current groups, plus what the caller adds) stays only while its network is
// open to browser access, the address written still qualifies for that same group, and the write
// doesn't change the address (`currentAddress`, from the writer's own fresh read, is the same
// address as `address`). `currentAddress` is null for a resource that doesn't exist yet (created,
// or the copy a move makes), which therefore never gets one.
function withManagedTargets(currentAddress, networkId, address, groupIds) {
    const targets = new Set(targetGroupIds());
    const ids = (groupIds || []).filter(Boolean);
    const tg = currentAddress == null || addressKey(currentAddress) !== addressKey(address) ? '' : targetGroupFor(networkId, address);
    return [...new Set([...ids.filter(g => !targets.has(g)), ...(tg && ids.includes(tg) ? [tg] : [])])];
}

// Resource writes and the target sync run one at a time, so a write computed under an older
// configuration always finishes before the sync that follows a configuration change starts (that
// sync then corrects it). Re-entrant within one call chain: a writer that calls another writer, or
// the sync run from applyGatewayObjects (which already holds the lock), never waits on itself.
// Re-entry is allowed only for the call chain that holds the lock right now: a timer or promise
// that outlives its holder keeps the context but not the right to skip the queue.
const _targetLockCtx = new AsyncLocalStorage();
let _targetLockTail = Promise.resolve();
let _targetLockHolder = null;
function withTargetLock(fn) {
    const store = _targetLockCtx.getStore();
    if (store && store === _targetLockHolder) return fn();
    const token = {};
    const run = _targetLockTail
        .then(() => { _targetLockHolder = token; return _targetLockCtx.run(token, fn); })
        .finally(() => { if (_targetLockHolder === token) _targetLockHolder = null; });
    _targetLockTail = run.catch(() => { });
    return run;
}

// A resource write that got no answer (a timeout) may still land later, after a sync that has
// already moved on - NetBird offers no conditional write. So no session is approved until a sync
// that started after a settling deadline has finished: the deadline is 90 s after the last such
// write, and 90 s after start-up (a restart forgets the writes before it). A sync that fails keeps
// the refusal until a later one succeeds.
const SETTLE_MS = 90_000;
let _settleUntil = 0;       // no session is approved before a sync that started at or after this
let _lastSyncStartOk = 0;   // start time of the last target sync that finished
let _settleTimer = null;
const untilDeadline = () => Math.max(0, _settleUntil - Date.now()) + 1000;
function scheduleSettleSync(delayMs = untilDeadline()) {
    clearTimeout(_settleTimer);
    // Created outside any lock context: the timer must queue for the lock like everyone else.
    _settleTimer = _targetLockCtx.exit(() => setTimeout(() => {
        _settleTimer = null;
        if (!targetGroupIds().length || !netbirdApiConfigured() || NETBIRD_READONLY) return; // the next apply syncs
        // Only the leader writes to NetBird (lib/leader.js). A standby asks again until it leads or
        // shuts down; until a sync ends, it keeps refusing new sessions, as during any settling.
        if (_deps.isLeader && !_deps.isLeader()) { scheduleSettleSync(5000); return; }
        syncTargetGroup().catch(e => {
            console.error('[remote-access] target sync after an unanswered write failed:', e.message);
            if (!_settleTimer) scheduleSettleSync(Math.max(60_000, untilDeadline()));
        });
    }, delayMs));
    if (_settleTimer.unref) _settleTimer.unref();
}
function noteUncertainTargetWrite() {
    _settleUntil = Math.max(_settleUntil, Date.now() + SETTLE_MS);
    invalidateSnapshot();
    scheduleSettleSync();
}
function beginStartupSettling() { noteUncertainTargetWrite(); }
// Read-only: this process never writes, but a write sent before a restart may still land, so the
// deadline still holds; with no sync to wait for, a snapshot read after it is enough.
const targetsSettling = () => Date.now() < _settleUntil || (!NETBIRD_READONLY && _lastSyncStartOk < _settleUntil);

function remoteAccessAvailable() { return _cfg.enabled && netbirdApiConfigured(); }

// ─── Managed NetBird objects ───
const nbOk = (r) => r && r.status >= 200 && r.status < 300;
const nbErr = (what, r) => new Error(`${what} failed: ${(r && (r.raw || r.error || r.status)) || 'no response'}`);

// The installation name in the managed object names: the app name from Settings, whitespace
// (line breaks included) collapsed to single spaces. Read again on every apply, so renaming the
// app renames the objects.
let _installName = DEFAULT_INSTALL_NAME;
async function loadInstallName() {
    const v = await getSetting('app_name');
    _installName = String(v || '').replace(/\s+/g, ' ').trim() || DEFAULT_INSTALL_NAME;
    return _installName;
}
const nbName = (base) => `${base} (${_installName})`;
const managedGroupName = (id) => {
    for (const k of Object.values(KINDS)) {
        if (_nb[k.groupKey] === id) return nbName(k.group);
        if (_nb[k.targetKey] === id) return nbName(k.targets);
    }
    return id;
};

// A managed group as NetBird returns it, only when the whole object is there: a PUT replaces the
// peers and the resources, so a partial or malformed read must never become the new state. NetBird
// answers an empty list as null; a field that is missing altogether is refused.
const refId = (x) => String((x && typeof x === 'object' ? x.id : x) || '');
const listField = (g, key) => (!(key in g) ? undefined : g[key] === null ? [] : Array.isArray(g[key]) ? g[key] : undefined);
function fullGroup(g, id) {
    if (!g || typeof g !== 'object' || g.id !== id || typeof g.name !== 'string' || !g.name) return null;
    const peers = listField(g, 'peers');
    const resources = listField(g, 'resources');
    if (!peers || !peers.every(p => refId(p))) return null;
    if (!resources || !resources.every(r => r && typeof r.id === 'string' && r.id && typeof r.type === 'string' && r.type)) return null;
    return { name: g.name, peers: peers.map(refId), resources: resources.map(r => ({ id: r.id, type: r.type })) };
}
// Change a managed group from a fresh read of it. The caller holds the target lock. `change` gets
// { name, peers, resources } and returns the new { name, peers } (resources are kept) or
// { name, peers, resources } (resources are replaced), or null for no write; it may be async (a
// throw writes nothing).
// A target group holds resources only: every write to one leaves it without devices, so a late
// answer to an older write can never put back a device that was taken out meanwhile. The caller
// records the devices it took out (`before.peers` that are not in `after.peers`).
async function putManagedGroup(id, change) {
    const g = fullGroup(await netbirdGet('/api/groups/' + encodeURIComponent(id)), id);
    if (!g) throw new Error(`Couldn't read the group "${managedGroupName(id)}" from NetBird in full, so it was not changed.`);
    const next = await change({ name: g.name, peers: [...g.peers], resources: g.resources });
    if (!next) return null;
    const after = { name: next.name, peers: targetGroupIds().includes(id) ? [] : next.peers, resources: next.resources || g.resources };
    noteTargetsChanged();
    const r = await netbirdReq('PUT', '/api/groups/' + encodeURIComponent(id), after);
    // Any answer but success leaves the write uncertain: NetBird builds its answer after the save,
    // so even an error answer (or none) may follow a saved group.
    if (!nbOk(r)) { noteUncertainTargetWrite(); throw nbErr(`Updating the "${g.name}" group`, r); }
    bustNbCaches('gref', 'groups', 'usage');
    invalidateSnapshot();
    return { before: g, after };
}
const droppedDevices = (out) => (out ? out.before.peers.filter(id => !out.after.peers.includes(id)) : []);

// A managed group is found only by the id this app stored when it created it. A group that merely
// has the name is never taken over: an empty peer list does not prove it is unused (resources,
// policies, users and setup keys can point at it), and its members would get the gateway's
// standing all-TCP policy. The save then stops and says how to fix it; nothing references it.
// A group found by id whose name differs (the app name changed, or the name is from before the
// installation name was added) is renamed; its peers and resources stay. Runs under the target lock.
async function ensureGroup(name, knownId) {
    const groups = await netbirdGet('/api/groups');
    if (!Array.isArray(groups)) throw new Error("Couldn't read the groups from NetBird");
    const found = knownId && groups.find(g => g && g.id === knownId);
    if (groups.some(g => g && g.name === name && g.id !== (found && found.id))) {
        throw new Error(`NetBird already has a group named "${name}" that NetBird Control did not create or no longer has on record. Delete or rename that group in NetBird, then save again. If it was the gateway's group, enroll the gateway again afterwards with a new setup key.`);
    }
    if (found) {
        if (found.name !== name) {
            const out = await putManagedGroup(found.id, g => (g.name === name ? null : { name, peers: g.peers }));
            const gone = droppedDevices(out);
            if (gone.length) noteMemberRemovals(gone.map(id => ({ kind: 'device', id, name: id, group: out.before.name })));
        }
        return found.id;
    }
    const r = await netbirdPost('/api/groups', { name });
    if (!nbOk(r) || !r.body || !r.body.id) throw nbErr(`Creating the "${name}" group`, r);
    return r.body.id;
}

function policyBody(kind, enabled) {
    const k = KINDS[kind];
    return {
        name: nbName(k.policy),
        description: (kind === 'names'
            ? 'Managed by NetBird Control: lets the Browser Gateway for host names reach the domain resources of the networks enabled for browser remote access. Who may connect is decided per session by NetBird Control.'
            : 'Managed by NetBird Control: lets the Browser Gateway reach the networks enabled for browser remote access. Who may connect is decided per session by NetBird Control.')
            + ` Installation: ${_installName}.`,
        enabled,
        source_posture_checks: [],
        rules: [{
            name: nbName(k.policy), enabled: true, action: 'accept', bidirectional: false,
            protocol: 'tcp', ports: [], sources: [_nb[k.groupKey]], destinations: [_nb[k.targetKey]],
        }],
    };
}

function ensurePolicy(kind, enabled) {
    const k = KINDS[kind];
    return ensureNamedPolicy(_nb[k.policyKey], policyBody(kind, enabled));
}

async function ensureNamedPolicy(knownId, body, unchanged = () => false) {
    const pols = await netbirdGet('/api/policies');
    if (!Array.isArray(pols)) throw new Error("Couldn't read the policies from NetBird");
    const name = body.name;
    const found = knownId && pols.find(p => p && p.id === knownId);
    if (!found && pols.some(p => p && p.name === name)) {
        throw new Error(`NetBird already has a policy named "${name}" that NetBird Control did not create or no longer has on record. Delete or rename that policy in NetBird, then save again.`);
    }
    if (found) {
        if (found.name === name && unchanged(found)) return found.id;
        const r = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(found.id), body);
        if (!nbOk(r)) throw nbErr(`Updating the "${name}" policy`, r);
        return found.id;
    }
    const r = await netbirdPost('/api/policies', body);
    if (!nbOk(r) || !r.body || !r.body.id) throw nbErr(`Creating the "${name}" policy`, r);
    return r.body.id;
}

const WEB = { group: 'Browser Gateway Web', acl: 'Browser Gateway Web ACL', policy: 'Browser Gateway Web', routing: 'Browser Gateway Web Routing' };
const webObjectIds = () => [_nb.webGroupId, _nb.webAclGroupId, _nb.webRouteId, _nb.webPolicyId, _nb.webRoutingPolicyId].filter(Boolean);
const browserWanted = () => _cfg.enabled && _cfg.browser.enabled;
const webNetworkId = () => WEB_ROUTE_NETWORK_PREFIX + crypto.createHash('sha256').update(_installName).digest('hex').slice(0, 8);

function browserGateWant(routerGroupId, ids) {
    const installation = ` Installation: ${_installName}.`;
    return {
        routerGroupId,
        route: webRouteBody({ description: nbName(WEB.group), networkId: webNetworkId(), routerGroupId, webGroupId: ids.webGroupId, aclGroupId: ids.webAclGroupId }),
        icmpPolicy: webPolicyBody({
            name: nbName(WEB.policy), protocol: 'icmp', sourceGroupId: ids.webGroupId, destinationGroupId: routerGroupId,
            description: 'Managed by NetBird Control: lets the browser gateway for web sessions reach the routing peers of its internet route.' + installation,
        }),
        routingPolicy: webPolicyBody({
            name: nbName(WEB.routing), protocol: 'all', sourceGroupId: ids.webGroupId, destinationGroupId: ids.webAclGroupId,
            description: 'Managed by NetBird Control: lets the browser gateway for web sessions use its internet route. Who may open a web session is decided by NetBird Control.' + installation,
        }),
    };
}

async function readBrowserGate() {
    await loadInstallName();
    let stored = {};
    try { stored = JSON.parse(await getSetting('remote_access_nb') || 'null') || {}; } catch { stored = {}; }
    const ids = Object.fromEntries(['webGroupId', 'webAclGroupId', 'webRouteId', 'webPolicyId', 'webRoutingPolicyId'].map(k => [k, String(stored[k] || '')]));
    const peer = await readWebPeer();
    return { ids: { ...ids, webPeerId: peer ? peer.id : '' }, peer, want: browserGateWant(_cfg.browser.routerGroupId, ids) };
}

async function deleteWebObject(key, path, what) {
    if (!_nb[key]) return;
    const r = await netbirdReq('DELETE', path + encodeURIComponent(_nb[key]));
    if (!nbOk(r) && !(r && r.status === 404)) throw nbErr(`Deleting the ${what}`, r);
    _nb[key] = '';
    await setSetting('remote_access_nb', JSON.stringify(_nb));
}
const deleteWebRoute = () => deleteWebObject('webRouteId', '/api/routes/', 'internet route of the web sessions');
const deleteWebIcmpPolicy = () => deleteWebObject('webPolicyId', '/api/policies/', `"${nbName(WEB.policy)}" policy`);
const deleteWebRoutingPolicy = () => deleteWebObject('webRoutingPolicyId', '/api/policies/', `"${nbName(WEB.routing)}" policy`);

async function ensureWebRoute(body) {
    const routes = await netbirdGet('/api/routes');
    if (!Array.isArray(routes)) throw new Error("Couldn't read the routes from NetBird");
    const found = _nb.webRouteId && routes.find(r => r && r.id === _nb.webRouteId);
    if (!found && routes.some(r => r && (r.network_id === body.network_id || r.description === body.description))) {
        throw new Error(`NetBird already has a route "${body.network_id}" or "${body.description}" that NetBird Control did not create or no longer has on record. Delete that route in NetBird, then save again.`);
    }
    if (found) {
        if (found.description === body.description && webRouteMatches(found, body)) return found.id;
        const r = await netbirdReq('PUT', '/api/routes/' + encodeURIComponent(found.id), body);
        if (!nbOk(r)) throw nbErr('Updating the internet route of the web sessions', r);
        return found.id;
    }
    const r = await netbirdPost('/api/routes', body);
    if (!nbOk(r) || !r.body || !r.body.id) throw nbErr('Creating the internet route of the web sessions', r);
    return r.body.id;
}

async function applyBrowserObjectsLocked() {
    const routerGroupId = _cfg.browser.routerGroupId;
    if (!browserWanted() || !routerGroupId) {
        await deleteWebRoute();
        await deleteWebIcmpPolicy();
        await deleteWebRoutingPolicy();
    }
    if (!browserWanted()) return;
    _nb.webGroupId = await ensureGroup(nbName(WEB.group), _nb.webGroupId);
    await setSetting('remote_access_nb', JSON.stringify(_nb));
    _nb.webAclGroupId = await ensureGroup(nbName(WEB.acl), _nb.webAclGroupId);
    await setSetting('remote_access_nb', JSON.stringify(_nb));
    if (!routerGroupId) return;
    const groups = await netbirdGet('/api/groups');
    if (!Array.isArray(groups)) throw new Error("Couldn't read the groups from NetBird");
    const router = groups.find(g => g && g.id === routerGroupId);
    if (!router) throw new Error('The routing group chosen for web sessions no longer exists in NetBird. Choose another group in Settings > Remote Access, then save again.');
    if (isRemoteAccessManagedGroup(routerGroupId, router.name)) throw new Error('A Browser Gateway group cannot route web sessions. Choose the group of your exit node routing peers in Settings > Remote Access, then save again.');
    const want = browserGateWant(routerGroupId, _nb);
    const routes = await netbirdGet('/api/routes');
    if (!Array.isArray(routes)) throw new Error("Couldn't read the routes from NetBird");
    const route = _nb.webRouteId && routes.find(r => r && r.id === _nb.webRouteId);
    if (route && !(Array.isArray(route.peer_groups) && route.peer_groups.length === 1 && refId(route.peer_groups[0]) === routerGroupId)) {
        await deleteWebRoute();
        await deleteWebIcmpPolicy();
    }
    _nb.webRoutingPolicyId = await ensureNamedPolicy(_nb.webRoutingPolicyId, want.routingPolicy, p => p.description === want.routingPolicy.description && webPolicyMatches(p, want.routingPolicy));
    await setSetting('remote_access_nb', JSON.stringify(_nb));
    _nb.webPolicyId = await ensureNamedPolicy(_nb.webPolicyId, want.icmpPolicy, p => p.description === want.icmpPolicy.description && webPolicyMatches(p, want.icmpPolicy));
    await setSetting('remote_access_nb', JSON.stringify(_nb));
    _nb.webRouteId = await ensureWebRoute(want.route);
    await setSetting('remote_access_nb', JSON.stringify(_nb));
}

// NetBird is the source of truth for which resources are in a target group: the sync never adds
// one. It keeps the members that pass the rule (open network, qualifying address, a valid hold for
// the resource's current network and address) and takes every other member out (wildcard domain
// resources and devices included). Each target group that differs is written as a whole, from a
// fresh read of it, whatever the number of resources (a write per resource ran into NetBird's rate
// limit on networks with hundreds of them). Then it deletes the holds that expired or whose
// resource is no longer a member. It runs while browser access is off too, so the groups drain.
// Holds the target lock for the whole run.
// The targets generation: raised by every target sync that finishes, every settings save, and right
// before every managed group write and every resource or network write and delete of this process
// (db.js). A session start notes it before its last evaluation and gets no token when it changed
// meanwhile (the user tries again). A session start's own add doesn't raise it: an add never takes
// a route away.
let _targetsGen = 0;
function noteTargetsChanged() { _targetsGen++; }

function syncTargetGroup() {
    return withTargetLock(async () => {
        const started = Date.now();
        const out = await syncTargetGroupLocked();
        noteTargetsChanged();
        _lastSyncStartOk = Math.max(_lastSyncStartOk, started);
        invalidateSnapshot();
        // Finished, but started before the current deadline: one more sync after it is still due.
        if (_lastSyncStartOk < _settleUntil && !_settleTimer) scheduleSettleSync();
        return out;
    });
}
// Every resource as NetBird has it now: resource id -> { networkId, address, type }.
async function readResourceIndex() {
    const [resources, networks] = await Promise.all([netbirdGet('/api/networks/resources'), netbirdGet('/api/networks')]);
    if (!Array.isArray(resources) || !Array.isArray(networks)) throw new Error("Couldn't read the networks from NetBird");
    const netOf = new Map();
    for (const n of networks) for (const rid of (Array.isArray(n.resources) ? n.resources : [])) netOf.set((rid && rid.id) || rid, n.id);
    const index = new Map();
    for (const res of resources) {
        if (!res || !res.id) continue;
        const networkId = netOf.get(res.id);
        if (networkId) index.set(res.id, { networkId, address: res.address, type: res.type });
    }
    return index;
}
// The members a target group keeps, from a fresh read of it: resource id -> its type as NetBird
// reports it now. Only members that pass the rule; nobody is added.
function keptTargets(tg, g, index) {
    const want = new Map();
    for (const r of g.resources) {
        const x = index.get(r.id);
        if (!x || !remoteAccessTargetGroupsFor(r.id, x.networkId, x.address).includes(tg)) continue;
        if (typeof x.type !== 'string' || !x.type) throw new Error("Couldn't read the networks from NetBird in full.");
        want.set(r.id, x.type);
    }
    return want;
}

const targetsMatch = (g, want) => {
    const have = new Map(g.resources.map(r => [r.id, r.type]));
    return !g.peers.length && have.size === want.size && [...want].every(([id, type]) => have.get(id) === type);
};

// NetBird has no conditional write, so a resource changed in NetBird between a read and a write
// (an exact name made a wildcard, say) can make the write out of date. Up to two passes write,
// each from a fresh read, writing only what still differs; a third pass after a second write only
// checks. When that check still finds a difference, or a read fails after a write, the writes
// count as uncertain: no session is approved until a follow-up sync (about 90 s later) finishes.
async function syncTargetGroupLocked() {
    let removed = 0;
    const written = new Set();
    const members = new Map(); // target group id -> the resource ids it holds after the sync
    // Each group is judged from the resources and the holds read AFTER that group: a session start
    // writes its hold before it adds the resource, so every member the group read shows (also one
    // another instance just added) has its resource and its hold in these reads. A failed read
    // writes nothing for that group.
    const judge = async (tg, g) => {
        const index = await readResourceIndex();
        await loadTargetHolds({ strict: true });
        return keptTargets(tg, g, index);
    };
    try {
        for (let pass = 0; pass < 3; pass++) {
            let differs = false;
            for (const tg of targetGroupIds()) {
                if (pass === 2) {
                    const g = fullGroup(await netbirdGet('/api/groups/' + encodeURIComponent(tg)), tg);
                    if (!g || !targetsMatch(g, await judge(tg, g))) differs = true;
                    if (g) members.set(tg, new Set(g.resources.map(r => r.id)));
                    continue;
                }
                let seen = null;
                const out = await putManagedGroup(tg, async g => {
                    seen = g;
                    const want = await judge(tg, g);
                    return targetsMatch(g, want) ? null : { name: g.name, peers: [], resources: [...want].map(([id, type]) => ({ id, type })) };
                });
                members.set(tg, new Set((out ? out.after.resources : seen.resources).map(r => r.id)));
                if (!out) continue;
                differs = true;
                written.add(out.after.name);
                const after = new Set(out.after.resources.map(r => r.id));
                const outs = out.before.resources.map(r => r.id).filter(id => !after.has(id));
                removed += outs.length;
                // One write can take many resources out at once: the audit log keeps which ones.
                if (_deps.recordAudit) {
                    Promise.resolve(_deps.recordAudit({
                        actorId: '', actorEmail: '', actorName: 'System', action: 'remote_access.targets_update', target: out.after.name,
                        meta: { removed: outs.length, removedIds: outs.slice(0, 50) },
                    })).catch(() => { });
                }
                const gone = droppedDevices(out);
                if (gone.length) noteMemberRemovals(gone.map(id => ({ kind: 'device', id, name: id, group: out.before.name })));
            }
            if (!differs) break;
            if (pass === 2) {
                noteUncertainTargetWrite();
                throw new Error('NetBird changed again while it was being updated. New sessions wait for a follow-up sync in about 90 seconds.');
            }
        }
    } catch (e) {
        if (written.size) {
            noteUncertainTargetWrite();
            e.message = `The "${[...written].join('" and "')}" group was updated, then: ${e.message}`;
        }
        throw e;
    }
    // No target group was read (none exists yet): the holds still need a current read.
    if (!members.size) await loadTargetHolds({ strict: true });
    await dropStaleHolds(members);
    return { removed };
}

// A hold that expired is deleted; so is one whose resource is not in a target group (a hold without
// membership is stale: it is not added back), once it is older than STALE_HOLD_GRACE_MS: a hold
// that a session start on another instance just wrote, while its add is still on the way, stays.
// Both are guarded by the expiry this process saw, so a hold that a session start or a re-check
// raised meanwhile (here or on another instance) stays.
const STALE_HOLD_GRACE_MS = 10 * 60_000;
async function dropStaleHolds(members) {
    const now = Date.now();
    const inGroup = new Set([...members.values()].flatMap(s => [...s]));
    for (const [id, h] of [..._holds]) {
        const expired = h.expiresAt <= now;
        if (!expired && inGroup.has(id)) continue;
        try {
            const r = await pool.query(expired
                ? 'DELETE FROM remote_access_targets WHERE resource_id = $1 AND expires_at <= $2'
                : `DELETE FROM remote_access_targets WHERE resource_id = $1 AND expires_at <= $2 AND updated_at < NOW() - interval '${STALE_HOLD_GRACE_MS / 60_000} minutes'`,
            [id, new Date(h.expiresAt)]);
            if (r && r.rowCount && _holds.get(id) === h) _holds.delete(id);
        } catch (e) {
            console.error('[remote-access] could not delete a stale target hold:', e.message);
        }
    }
}

// Create or update everything NetBird needs. Disabling turns the standing policy off (and
// keeps the objects, so turning it back on is one save).
async function applyGatewayObjects() {
    if (!netbirdApiConfigured()) throw new Error('Connect the NetBird API first (Settings → NetBird API).');
    if (NETBIRD_READONLY) throw new Error('This instance is read-only (NETBIRD_READONLY=true) - the Browser Gateway objects cannot be created.');
    // One writer of the managed groups at a time (the target sync, the membership clean-up, renames).
    return withTargetLock(applyGatewayObjectsLocked);
}
async function applyGatewayObjectsLocked() {
    try {
        await loadInstallName();
        const tooLong = [...Object.values(KINDS).flatMap(k => [k.group, k.targets, k.policy]), ...Object.values(WEB)].map(nbName).find(n => n.length > NB_NAME_MAX);
        if (tooLong) throw new Error(`The Application Name (Settings > General) is too long for the NetBird object names, such as "${tooLong}". Shorten it to 60 characters or less, then save again.`);
        for (const [kind, k] of Object.entries(KINDS)) {
            // Each id is recorded as soon as it exists: a group this app created but did not record
            // would later be refused as a stranger with the managed name.
            _nb[k.groupKey] = await ensureGroup(nbName(k.group), _nb[k.groupKey]);
            await setSetting('remote_access_nb', JSON.stringify(_nb));
            _nb[k.targetKey] = await ensureGroup(nbName(k.targets), _nb[k.targetKey]);
            await setSetting('remote_access_nb', JSON.stringify(_nb));
            _nb[k.policyKey] = await ensurePolicy(kind, _cfg.enabled);
            await setSetting('remote_access_nb', JSON.stringify(_nb));
        }
        const sync = await syncTargetGroup();
        await applyBrowserObjectsLocked();
        bustNbCaches('policies', 'gref', 'usage', 'groups');
        invalidateSnapshot();
        _lastApply = { at: new Date().toISOString(), error: '' };
        return sync;
    } catch (e) {
        _lastApply = { at: new Date().toISOString(), error: e.message || String(e) };
        throw e;
    }
}

async function setRemoteAccessConfig(input) {
    const { createResources: sent, ...rest } = input || {};
    const wasEnabled = _cfg.enabled;
    try {
        // A read-only instance never adds or removes servers, so it doesn't decide this section.
        const createResources = sent && typeof sent === 'object' && !NETBIRD_READONLY ? await checkedCreateSection(sent) : _cfg.createResources;
        const browser = { ..._cfg.browser, ...(rest.browser && typeof rest.browser === 'object' ? rest.browser : {}) };
        const next = normConfig({ ..._cfg, ...rest, browser, createResources });
        // The network launch links use stays open to the gateway.
        if (createResources.networkId) next.networks = [...new Set([...next.networks, createResources.networkId])];
        await setSetting('remote_access_config', JSON.stringify(next));
        _cfg = next;
    } catch (e) {
        if (e.status) throw e;
        console.error('[remote-access] saving the settings:', e.message);
        throw httpError(503, 'UNAVAILABLE', "The settings couldn't be saved. Try again.");
    }
    noteTargetsChanged();
    if (!_cfg.enabled) closeAllSessions('Browser remote access was turned off by an administrator.');
    let sync = null;
    if (_cfg.enabled || wasEnabled || _nb.policyId || _nb.namesPolicyId || webObjectIds().length) sync = await applyGatewayObjects();
    return { config: getRemoteAccessConfig(), sync };
}

// Background reconcile (the leader, every 10 minutes): the target groups keep only what the rule
// allows, and expired holds go. It runs while browser access is off too (the policies stay
// disabled), so the groups drain; with no managed objects at all there is nothing to do.
async function reconcileRemoteAccess() {
    if (!netbirdApiConfigured() || NETBIRD_READONLY) return;
    let failed = null;
    if (_cfg.enabled || targetGroupIds().length || _nb.policyId || _nb.namesPolicyId || webObjectIds().length) {
        try { await applyGatewayObjects(); } catch (e) { failed = e; }
    }
    await maintainCreatedResources().catch(e => console.error('[remote-access] created resources:', e.message));
    if (failed) throw failed;
}

async function createGatewaySetupKey(kind = 'ip') {
    const web = kind === 'web';
    const k = web ? { group: WEB.group, groupKey: 'webGroupId' } : KINDS[kind];
    if (!k) throw new Error(`Unknown gateway kind "${kind}".`);
    if (web && !browserWanted()) throw new Error('Turn on Remote Access and web sessions first, then create the setup key.');
    if (!_nb[k.groupKey]) await applyGatewayObjects();
    if (!_nb[k.groupKey]) throw new Error(`The "${nbName(k.group)}" group could not be created. Save the Remote Access settings again, then create the setup key.`);
    await loadInstallName();
    if (web) await prepareWebEnrollment();
    return _deps.createSetupKey({ name: nbName(k.group), type: 'one-off', expiresInDays: 1, usageLimit: 1, ephemeral: false, autoGroups: [_nb[k.groupKey]] });
}

async function prepareWebEnrollment() {
    const groupId = _nb.webGroupId;
    const name = nbName(WEB.group);
    const group = await netbirdGet('/api/groups/' + encodeURIComponent(groupId));
    if (!group || group.id !== groupId || !Array.isArray(group.peers)) throw new Error(`Couldn't read the "${name}" group from NetBird. Try again in a minute.`);
    if (group.peers.length) {
        throw new Error(`The "${name}" group already has a peer. Delete the old browser gateway peer in NetBird first, then create a new setup key.`);
    }
    const keys = await netbirdGet('/api/setup-keys');
    if (!Array.isArray(keys)) throw new Error("Couldn't read the setup keys from NetBird. Try again in a minute.");
    const open = keys.filter(key => key && key.id && key.name === name && key.valid === true && !key.revoked
        && Array.isArray(key.auto_groups) && key.auto_groups.includes(groupId));
    for (const key of open) {
        const r = await netbirdReq('PUT', '/api/setup-keys/' + encodeURIComponent(key.id), { revoked: true, auto_groups: key.auto_groups });
        if (!nbOk(r)) throw nbErr(`Revoking the earlier "${name}" setup key`, r);
    }
}

// ─── Members added outside the app ───
// Nobody belongs in the managed groups but the gateways: a user's device in a gateway group, or
// any device in a target group, gets the standing policy's TCP access through NetBird itself.
// Members added outside the app (the NetBird dashboard, the API) are removed when the app next
// reads users or peers from NetBird anyway (the session check, the 60 s re-check while sessions are
// open, the regular users and peers refresh); this never reads NetBird on its own schedule.
//   - a user whose own groups (auto_groups) hold a managed group loses that group;
//   - a device enrolled by a user (a non-empty user_id) is taken out of a gateway group, and its
//     owner loses the group too (NetBird would otherwise add the owner's next device). A gateway
//     is enrolled with a setup key, which leaves user_id empty; one enrolled by a user login is
//     removed as well and has to be enrolled again with a setup key;
//   - any device is taken out of a target group (those hold only resources).
// Only this installation's stored groups are touched. Each removal is written from a fresh read of
// the group or user, and recorded in the app's audit log.
const MEMBERSHIP_RETRY_MS = 5 * 60_000;
let _membershipRun = null;
let _membershipPending = null;
// 'group:<id>' / 'user:<id>' -> { at, message } of the last failure. Kept, and shown, until that
// object is cleaned up or no longer needs it.
const _membershipFailed = new Map();
let _lastMembership = { at: null, removed: [], error: '' };
const membershipError = () => [...new Set([..._membershipFailed.values()].map(f => f.message))].join(' ');

function enforceManagedMembership(data = {}) {
    if ((typeof currentTenantAccount === 'function' && currentTenantAccount()) || NETBIRD_READONLY || !netbirdApiConfigured()) return Promise.resolve(null);
    if (!managedGroupIds().length) return Promise.resolve(null);
    if (_membershipRun) {
        // One run at a time; what arrives meanwhile is checked right after it.
        const p = _membershipPending || {};
        _membershipPending = { users: data.users || p.users, peers: data.peers || p.peers };
        return _membershipRun;
    }
    // Started outside the caller's lock context, so it queues for the locks like everyone else.
    _membershipRun = _targetLockCtx.exit(() => new Promise(r => setImmediate(r)).then(() => runMembership(data)))
        .catch(e => {
            console.error('[remote-access] membership clean-up failed:', e.message);
            _lastMembership = { ..._lastMembership, error: e.message || String(e) };
            return null;
        })
        .finally(() => {
            _membershipRun = null;
            const next = _membershipPending;
            _membershipPending = null;
            if (next) enforceManagedMembership(next);
        });
    return _membershipRun;
}

async function runMembership({ users, peers }) {
    const gateways = [...Object.values(KINDS).map(k => _nb[k.groupKey]), _nb.webGroupId].filter(Boolean);
    const targets = [...targetGroupIds(), _nb.webAclGroupId].filter(Boolean);
    const managed = new Set([...gateways, ...targets]);
    const extraWebPeers = await webPeersToRemove(peers);
    const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
    const fromGroups = new Map(); // group id -> peer ids to take out
    const fromUsers = new Map();  // user id -> group ids to take away
    const peerName = new Map();
    for (const u of Array.isArray(users) ? users : []) {
        // Service users have no devices: a group on one gives no network access.
        if (!u || !u.id || u.is_service_user) continue;
        for (const g of Array.isArray(u.auto_groups) ? u.auto_groups : []) if (managed.has(refId(g))) add(fromUsers, String(u.id), refId(g));
    }
    for (const p of Array.isArray(peers) ? peers : []) {
        if (!p || !p.id) continue;
        const owner = typeof p.user_id === 'string' ? p.user_id : '';
        for (const g of Array.isArray(p.groups) ? p.groups : []) {
            const gid = refId(g);
            const gateway = gateways.includes(gid);
            const extraWeb = gid === _nb.webGroupId && extraWebPeers.has(String(p.id));
            if (!targets.includes(gid) && !(gateway && owner) && !extraWeb) continue;
            add(fromGroups, gid, String(p.id));
            peerName.set(String(p.id), p.name || String(p.id));
            if (gateway && owner) add(fromUsers, owner, gid);
        }
    }
    // A failure is forgotten once the data this run covers no longer shows that member.
    for (const key of [..._membershipFailed.keys()]) {
        const kind = key.slice(0, key.indexOf(':'));
        const id = key.slice(key.indexOf(':') + 1);
        if (kind === 'group' && Array.isArray(peers) && !fromGroups.has(id)) _membershipFailed.delete(key);
        if (kind === 'user' && Array.isArray(users) && Array.isArray(peers) && !fromUsers.has(id)) _membershipFailed.delete(key);
    }
    if (!fromGroups.size && !fromUsers.size) { _lastMembership = { ..._lastMembership, error: membershipError() }; return null; }
    const due = (key) => Date.now() - ((_membershipFailed.get(key) || {}).at || 0) >= MEMBERSHIP_RETRY_MS;
    const failed = (key, e) => _membershipFailed.set(key, { at: Date.now(), message: e.message || String(e) });
    const removed = [];
    for (const [gid, ids] of fromGroups) {
        const key = 'group:' + gid;
        if (!due(key)) continue;
        try {
            const out = await withTargetLock(() => putManagedGroup(gid, g => {
                const keep = g.peers.filter(id => !ids.has(id));
                return keep.length === g.peers.length ? null : { name: g.name, peers: keep };
            }));
            _membershipFailed.delete(key);
            // A target group is written without any device, also one this run's data did not show.
            for (const id of droppedDevices(out)) removed.push({ kind: 'device', id, name: peerName.get(id) || id, group: out.before.name });
        } catch (e) { failed(key, e); }
    }
    // After the group writes, outside the target lock: a user write takes the user's lock first
    // and the target lock inside it (the order the grant revoke path uses).
    for (const uid of fromUsers.keys()) {
        const key = 'user:' + uid;
        if (!due(key) || !_deps.removeUserManagedGroups) continue;
        try {
            // Every managed group, not only the ones this data showed: the fresh read decides.
            const out = await _deps.removeUserManagedGroups(uid, [...managed]);
            _membershipFailed.delete(key);
            if (out) for (const gid of out.removed) removed.push({ kind: 'user', id: uid, name: out.name || uid, group: managedGroupName(gid) });
        } catch (e) { failed(key, e); }
    }
    noteMemberRemovals(removed);
    return removed;
}

const WEB_PEER_KEY = 'remote_access_web_peer';
async function readWebPeer() {
    const raw = await getSetting(WEB_PEER_KEY);
    let v = null;
    try { v = JSON.parse(raw || 'null'); } catch { return null; }
    return v && typeof v.id === 'string' && v.id ? { id: v.id, ip: typeof v.ip === 'string' ? v.ip : '', raw } : null;
}
const webPeerValue = (p) => JSON.stringify({ id: String(p.id), ip: String(p.ip || ''), at: new Date().toISOString() });

async function webPeersToRemove(peers) {
    const out = new Set();
    if (!_nb.webGroupId || !Array.isArray(peers) || !peers.length) return out;
    try {
        const inWeb = peers.filter(p => p && p.id && (Array.isArray(p.groups) ? p.groups : []).some(g => refId(g) === _nb.webGroupId));
        let rec = await readWebPeer();
        const live = rec && peers.find(p => p && p.id === rec.id);
        if (rec && !live) {
            await pool.query('DELETE FROM app_settings WHERE key = $1 AND value = $2', [WEB_PEER_KEY, rec.raw]);
            rec = null;
        } else if (rec && live.ip && live.ip !== rec.ip) {
            await pool.query('UPDATE app_settings SET value = $3 WHERE key = $1 AND value = $2', [WEB_PEER_KEY, rec.raw, webPeerValue(live)]);
            rec = await readWebPeer();
        }
        const enrolled = inWeb.filter(p => !p.user_id);
        if (!rec && enrolled.length === 1) {
            await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [WEB_PEER_KEY, webPeerValue(enrolled[0])]);
            rec = await readWebPeer();
        }
        if (rec) for (const p of inWeb) if (p.id !== rec.id) out.add(String(p.id));
    } catch (e) {
        console.error('[remote-access] could not check the browser gateway peer for web sessions:', e.message);
    }
    return out;
}

// Members taken out of a managed group (by the clean-up, or by the target sync): logged, audited
// and shown on the Remote Access settings page.
function noteMemberRemovals(removed) {
    const at = new Date().toISOString();
    for (const r of removed) {
        console.warn('[remote-access] removed %s %s from the managed group %s', r.kind, r.name, r.group);
        if (_deps.recordAudit) {
            Promise.resolve(_deps.recordAudit({
                actorId: '', actorEmail: '', actorName: 'System', action: 'remote_access.member_remove', target: r.name,
                meta: { group: r.group, member: r.kind, reason: 'Added outside NetBird Control' },
            })).catch(() => { });
        }
    }
    _lastMembership = {
        at,
        removed: [...removed.map(r => ({ ...r, at })), ..._lastMembership.removed].slice(0, 10),
        error: membershipError(),
    };
}

// ─── NetBird snapshot (fresh, bounded in time) ───
let _snapshot = null;         // { at: when the read started, epoch, data }
let _snapshotInFlight = null; // { at, epoch, promise }
let _snapshotEpoch = 0;
// Drop the cached snapshot and any read still running: neither is used once the targets changed.
function invalidateSnapshot() { _snapshotEpoch++; _snapshot = null; _snapshotInFlight = null; }
// A read is usable only if no invalidation came after it started and, once a settling deadline has
// passed, only if it started after that deadline (a late write may have landed just before).
const snapshotUsable = (s) => !!s && s.epoch === _snapshotEpoch && (Date.now() < _settleUntil || s.at >= _settleUntil);

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
    // The users and peers were read anyway: members added outside the app are removed from them.
    enforceManagedMembership({ users: data.users, peers: data.peers }).catch(() => { });
    return data;
}

// One shared fetch at a time; the whole snapshot has an overall deadline. Reads are numbered in
// the order they start: an older read that finishes last never replaces a newer one.
const _readOf = new WeakMap(); // snapshot data -> the read it came from ({ at, epoch, seq })
let _readSeq = 0;      // number of the last read started
let _latestDoneSeq = 0; // number of the newest read that finished
function snapshotOnce(maxAgeMs) {
    if (snapshotUsable(_snapshot) && Date.now() - _snapshot.at <= maxAgeMs) return Promise.resolve(_snapshot.data);
    // A read still running is as old as its start; the re-check (maxAgeMs 0) never joins one.
    if (maxAgeMs > 0 && snapshotUsable(_snapshotInFlight) && Date.now() - _snapshotInFlight.at <= maxAgeMs) return _snapshotInFlight.promise;
    const read = { at: Date.now(), epoch: _snapshotEpoch, seq: ++_readSeq, promise: null };
    read.promise = withDeadline(fetchSnapshot(), SNAPSHOT_DEADLINE_MS, 'Reading NetBird')
        .then(data => {
            _readOf.set(data, { at: read.at, epoch: read.epoch, seq: read.seq });
            if (read.seq > _latestDoneSeq) {
                _latestDoneSeq = read.seq;
                if (snapshotUsable(read)) _snapshot = { at: read.at, epoch: read.epoch, data };
            }
            return data;
        })
        .finally(() => { if (_snapshotInFlight === read) _snapshotInFlight = null; });
    _snapshotInFlight = read;
    return read.promise;
}
// Still current: no target change came after this snapshot's read started (see snapshotUsable).
// Approval paths check it again right before they approve.
const snapshotCurrent = (data) => snapshotUsable(_readOf.get(data));
// Only a current snapshot is handed out: a read that a target change or a newer finished read
// overtook is not; the caller gets a newer one.
async function freshSnapshot(maxAgeMs) {
    for (let i = 0; i < 3; i++) {
        const data = await snapshotOnce(maxAgeMs);
        const info = _readOf.get(data);
        if (snapshotCurrent(data) && info.seq >= _latestDoneSeq) return data;
        if (snapshotCurrent(data) && snapshotUsable(_snapshot)) return _snapshot.data; // the newer read
    }
    throw new Error('NetBird changed while it was being read');
}

// What the evaluation needs about one gateway. By default a resource that is not in the target
// group yet is judged as if it were (simulate); `real: true` counts only real membership (right
// before a session is approved, and the re-check). A read-only instance can't add a resource, so it
// never simulates.
// `standing: true` (the checks before a session, on every instance): the gateway's standing policy
// must also open the port to the target group, so a disabled or re-pointed one is refused before
// any hold or write.
const standingIds = (kind) => {
    const k = KINDS[kind] || KINDS.ip;
    return { policyId: _nb[k.policyKey], gatewayGroupId: _nb[k.groupKey], targetGroupId: _nb[k.targetKey] };
};
const authCfg = (kind = 'ip', { real = false, standing = false } = {}) => ({
    networks: _cfg.networks,
    standingPolicy: standing ? standingIds(kind) : null,
    gatewayGroupId: kind === 'names' ? _nb.namesGroupId : _nb.gatewayGroupId,
    gatewayGroupIds: [_nb.gatewayGroupId, _nb.namesGroupId, _nb.webGroupId].filter(Boolean), // never routing peers
    managedPolicyIds: managedPolicyIdList(),
    targetGroupId: kind === 'names' ? _nb.namesTargetGroupId : _nb.targetGroupId,
    targetGroupIds: targetGroupIds(), // a match only through one of these never grants
    simulate: !real && !NETBIRD_READONLY,
    readonly: !!NETBIRD_READONLY,
});

// ─── Checks (steps 1 and 2) ───
const MESSAGES = {
    INVALID_ADDRESS: "This address isn't valid. Enter an IPv4 address, such as 10.0.0.5, or a host name, such as server.example.com.",
    NAME_NOT_FOUND: "This host name wasn't found. Check the spelling, or enter the server's IP address.",
    NO_IPV4_ADDRESS: "No IPv4 address was found for this host name. Enter the server's IPv4 address, or ask an administrator for it.",
    NAME_LOOKUP_FAILED: "This host name couldn't be looked up right now. Try again in a moment, or enter the server's IP address.",
    NAMES_GATEWAY_NOT_ENROLLED: "This host name can't be reached because the Browser Gateway for host names isn't set up. Enter the server's IP address, or ask an administrator to set up that gateway.",
    NAMES_GATEWAY_EXTRA_REACH: "This host name can't be reached because the Browser Gateway for host names receives IP routes. Enter the server's IP address, or ask an administrator to remove those routes.",
    INVALID_PORT: 'Enter a port from 1 to 65535.',
    USER_NOT_FOUND: "Your account wasn't found in NetBird, so your access can't be checked. Ask an administrator to check your NetBird account.",
    USER_BLOCKED: 'Your NetBird account is blocked. Ask an administrator to unblock it.',
    UNKNOWN_ADDRESS: "NetBird has no resource for this address. Check the address, or ask an administrator to add it as a resource.",
    NO_DOMAIN_MATCH: "NetBird has no resource for this host name. Check the name, or ask an administrator to add it as a resource.",
    NETWORK_NOT_ENABLED: "This resource is in a NetBird network that Remote Access doesn't use. Ask an administrator to add the network in Settings > Remote Access.",
    RESOURCE_DISABLED: "This resource is turned off in NetBird. Ask an administrator to turn it on.",
    AMBIGUOUS_ROUTE: "More than one NetBird route leads to this address, so Remote Access can't tell which resource you mean. Ask an administrator to remove the overlap.",
    GATEWAY_NOT_ENROLLED: "The Browser Gateway isn't set up in NetBird yet, so Remote Access can't connect. Ask an administrator to set it up.",
    GATEWAY_DOMAIN_ROUTES: 'Connecting by IP address is blocked because the Browser Gateway receives domain routes. Ask an administrator to remove those routes from the gateway.',
    GATEWAY_NOT_SYNCED: "The Browser Gateway has no route to this resource yet. Try again in a minute. If it keeps happening, tell an administrator.",
    GATEWAY_POLICY_MISSING: "The Browser Gateway's NetBird policy is missing or isn't set up correctly, so it can't reach this resource. Ask an administrator to repair it.",
    GATEWAY_POLICY_PORT: "The Browser Gateway's NetBird policy doesn't allow this port. Ask an administrator to allow the port in that policy.",
    TARGET_NOT_OPEN_READONLY: "This NetBird Control is read-only, so it can't open this resource to Remote Access. Ask an administrator where to connect instead.",
    TARGET_OPEN_FAILED: "Remote Access couldn't prepare the connection to this resource. Try again in a minute.",
    TARGET_CHANGED: "This resource changed in NetBird while the session was opening. Connect again.",
    BLOCKED_BY_POLICY: 'A NetBird policy blocks your access to this resource. Ask an administrator if you need access.',
    PORT_NOT_ALLOWED: "Your access doesn't include this port. Request access if you need it.",
    NO_ACCESS: "You don't have access to this resource. Request access if you need it.",
    GATEWAY_OFFLINE: "The Browser Gateway is offline, so this resource can't be reached right now. Try again later, or tell an administrator.",
    NO_ROUTER_ONLINE: "No routing peer for this resource's network is online in NetBird, so the resource can't be reached right now. Try again later, or tell an administrator.",
    SNAPSHOT_FAILED: "Remote Access couldn't read NetBird to check your access. Try again in a minute.",
    ADDRESS_NOT_ALLOWED: "Remote Access can't connect to this kind of address, such as a loopback, multicast or NetBird peer address. Ask an administrator which address to use for this resource.",
    WILDCARD_DOMAIN_NOT_ALLOWED: "This host name is covered only by a wildcard resource (such as *.example.com), and Remote Access doesn't connect through those. Enter the server's IP address, or ask an administrator to add this exact name as a resource.",
    GATEWAY_REACH_UNKNOWN: "Remote Access is blocked because a NetBird policy has a source NetBird Control can't read, so the Browser Gateway's access can't be checked. Ask an administrator to check that policy.",
    TARGETS_SETTLING: 'Remote Access is getting ready after a change. Try again in a minute.',
    TOO_MANY: "You've reached your session limit. Close a session, or wait a moment and try again.",
    TOO_MANY_TOTAL: "Remote Access has reached its limit of open sessions. Try again later.",
    SERVER_RESTARTING: 'NetBird Control is restarting or shutting down. Try again in a minute.',
    // A launch link that adds a missing server (createResource: true).
    CREATE_DISABLED: 'Adding missing servers from a link is turned off. Ask an administrator to turn it on in Settings > Remote Access.',
    ADDRESS_NOT_PUBLIC: "Only a public IPv4 address can be added from a link. Ask an administrator to add this server as a resource.",
    NAME_NOT_PUBLIC: "This host name points to an address that isn't public, so it can't be added from a link. Ask an administrator to add this server as a resource.",
    ADDRESS_BLOCKED: "This address is on the blocklist, so it can't be added from a link.",
    CREATE_LIMIT: 'Too many resources created by the API are still in place. Try again later, or ask an administrator to raise the limit.',
    CREATE_UNCONFIRMED: "NetBird didn't confirm that the server was added. Try again in a few minutes.",
    CREATE_IN_PROGRESS: 'This server is being added right now. Try again in a minute.',
    RESOURCE_CREATE_FAILED: "NetBird didn't add the server, so no link was made. Try again later.",
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

// Is the names gateway set up: does its NetBird group have at least one peer (an enrolled gateway)?
// The same rule decides what "Add As Resource" suggests for a host name and whether the service
// status shows the names gateway.
const namesGatewayEnrolled = (snap, namesCfg) => {
    const gid = namesCfg && namesCfg.gatewayGroupId;
    return !!gid && (Array.isArray(snap && snap.peers) ? snap.peers : []).some(p => p && Array.isArray(p.groups) && p.groups.some(g => ((g && g.id) || g) === gid));
};

// What the typed address means and whether this user may reach it:
//   { ok, gateway: 'ip', address: <ip>, name: <typed name or ''>, verdict }
//   { ok, gateway: 'names', address: <name>, name: <name>, verdict }
// A name that matches a NetBird domain resource goes to the names gateway; any other name is
// looked up and each IPv4 answer is checked like a typed IP (the first allowed one is used).
// A refusal may also carry `add: { suggest }`: nothing in NetBird covers the target, so adding it as
// a resource is what is missing (see lib/coverage.js). Only the check shows it; it never changes
// the verdict. Not on a read-only instance.
async function resolveTarget(snap, userId, address, port, opts = {}) {
    const ipCfg = opts.ipCfg || authCfg('ip', { standing: true });
    const namesCfg = opts.namesCfg || authCfg('names', { standing: true });
    const resolve4 = opts.resolve4 || _deps.resolve4 || defaultResolve4;
    const canAdd = !ipCfg.readonly;
    const t = normalizeTarget(address);
    if (t.error) return { ok: false, verdict: { ok: false, code: t.error } };
    if (t.kind === 'ip') {
        const verdict = evaluateUserAccess(snap, ipCfg, { userId, address: t.ip, port });
        const add = canAdd && verdict.code === 'UNKNOWN_ADDRESS' && ipUncovered(snap, t.ip) ? { suggest: t.ip } : null;
        return { ok: verdict.ok, gateway: 'ip', address: t.ip, name: '', verdict, ...(add ? { add } : {}) };
    }
    const named = evaluateNameAccess(snap, namesCfg, { userId, name: t.name, port });
    if (named.code !== 'NO_DOMAIN_MATCH') return { ok: named.ok, gateway: 'names', address: t.name, name: t.name, verdict: named };
    const namesReady = namesGatewayEnrolled(snap, namesCfg);
    let ips;
    try { ips = await resolve4(t.name); }
    catch (e) {
        const code = e && e.code === 'ENOTFOUND' ? 'NAME_NOT_FOUND' : e && e.code === 'ENODATA' ? 'NO_IPV4_ADDRESS' : 'NAME_LOOKUP_FAILED';
        // A name the DNS doesn't know can still be added as a domain resource for the names gateway
        // (NetBird DNS answers it there). A temporary lookup failure says nothing either way.
        const add = canAdd && code === 'NAME_NOT_FOUND' && namesReady && !nameCovered(snap, t.name) && !userSourceGroups(snap, userId, Date.now()).error
            ? { suggest: t.name, name: t.name } : null;
        return { ok: false, gateway: 'ip', address: '', name: t.name, verdict: { ok: false, code }, ...(add ? { add } : {}) };
    }
    const list = (Array.isArray(ips) ? ips : []).map(String).filter(ip => !normalizeTarget(ip).error && normalizeTarget(ip).kind === 'ip');
    if (!list.length) return { ok: false, gateway: 'ip', address: '', name: t.name, verdict: { ok: false, code: 'NO_IPV4_ADDRESS' } };
    let first = null;
    let unknownEverywhere = true; // no resource in any network covers any of the addresses
    for (const ip of list) {
        const verdict = evaluateUserAccess(snap, ipCfg, { userId, address: ip, port });
        if (verdict.ok) return { ok: true, gateway: 'ip', address: ip, name: t.name, verdict };
        if (verdict.code !== 'UNKNOWN_ADDRESS') unknownEverywhere = false;
        if (!first) first = { ok: false, gateway: 'ip', address: ip, name: t.name, verdict };
    }
    if (canAdd && unknownEverywhere && nameUncovered(snap, t.name, list)) first.add = { suggest: namesReady ? t.name : list[0], name: t.name, ips: list };
    return first;
}

const SESSION_TARGET_CHANGED = "Your session ended because this resource changed in NetBird. Connect again.";
const notReady = (code) => ({ key: 'ready', status: 'fail', code, message: MESSAGES[code], retry: code === 'TARGETS_SETTLING' });

async function checkAccess(viewer, body) {
    const { protocol, address, port } = parseTarget(body);
    const steps = [];
    // The environment step ('ready') is reported only when it fails: remote access itself is not
    // ready, which says nothing about the user's own access. retry: it passes by itself soon.
    if (targetsSettling()) return { steps: [notReady('TARGETS_SETTLING')] };
    let snap;
    try { snap = await freshSnapshot(CHECK_SNAPSHOT_TTL_MS); }
    catch (e) { return { steps: [notReady('SNAPSHOT_FAILED')] }; }
    const rt = await resolveTarget(snap, viewer.user_id, address, port);
    const verdict = rt.verdict;
    const target = { protocol, address: rt.address || address, name: rt.name || '', gateway: rt.gateway || 'ip', port, resource: verdict.resource || null, network: verdict.network || null };
    if (!verdict.ok) {
        // The snapshot reads lists without their status, so "nothing covers it" is confirmed by a
        // strict read of the resources and routes (2xx answers only) before it is offered.
        let add = null;
        if (rt.add) {
            const inv = await getUsageData({ strict: true }).catch(() => null);
            const free = !!inv && (rt.add.ips ? nameUncovered(inv, rt.add.name, rt.add.ips) : rt.add.name ? !nameCovered(inv, rt.add.name) : ipUncovered(inv, rt.add.suggest));
            if (free) add = rt.add;
        }
        // Settling may have started while the target was looked up (DNS): no refusal from old data.
        if (targetsSettling() || !snapshotCurrent(snap)) return { steps: [notReady('TARGETS_SETTLING')], target };
        // addable: nothing in NetBird covers the target; the page offers to add it (to a network the
        // user may edit), with the suggested address.
        steps.push({
            key: 'access', status: 'fail', code: verdict.code, message: MESSAGES[verdict.code] || verdict.code, requestable: REQUESTABLE.has(verdict.code),
            ...(add ? { addable: true, suggest: { address: add.suggest } } : {}),
        });
        return { steps, target };
    }
    steps.push({ key: 'access', status: 'pass', detail: `Granted by ${verdict.policies.join(', ')}` });
    const routers = await withDeadline(netbirdGet(`/api/networks/${encodeURIComponent(verdict.network.id)}/routers`), SNAPSHOT_DEADLINE_MS, 'Reading routers').catch(() => null);
    if (!Array.isArray(routers)) return { steps: [notReady('SNAPSHOT_FAILED')], target };
    const path = pathStatus(snap, authCfg(rt.gateway), routers);
    // Again after the reads: an unanswered write may have started settling meanwhile, or the
    // targets changed after the snapshot was read.
    if (targetsSettling() || !snapshotCurrent(snap)) return { steps: [notReady('TARGETS_SETTLING')], target };
    steps.push(path.ok
        ? { key: 'path', status: 'pass', detail: `Gateway online, routing peer online for ${verdict.network.name}` }
        : { key: 'path', status: 'fail', code: path.code, message: MESSAGES[path.code] || path.code, troubleshoot: path.code === 'NO_ROUTER_ONLINE' });
    return { steps, target, ok: path.ok };
}

// ─── Sessions ───
const _tokens = new Map();   // token -> { sessionId, expiresAt }
const _sessions = new Map(); // sessionId -> session
const _pendingEnds = new Set(); // end records still being written
const _endingIds = new Set(); // their session ids: still this process's own, not orphans
let _shuttingDown = false;
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

// opts.presetCreds: credentials from a launch link (server side only - never read from a browser
// body). They go to guacd for RDP and SSH alike.
async function createSession(viewer, body, clientIp, opts = {}) {
    if (!remoteAccessAvailable()) throw httpError(403, 'DISABLED', 'Browser remote access is turned off.');
    if (_shuttingDown) throw httpError(503, 'SERVER_RESTARTING');
    const { protocol, address, port } = parseTarget(body);
    if (countFor(viewer.user_id) >= _cfg.maxSessionsPerUser) throw httpError(429, 'TOO_MANY', `You can have at most ${_cfg.maxSessionsPerUser} sessions at a time. Close a session, or wait a moment and try again.`);
    if (_sessions.size >= _cfg.maxSessionsTotal) throw httpError(429, 'TOO_MANY_TOTAL');
    if (targetsSettling()) throw httpError(503, 'TARGETS_SETTLING');

    let snap;
    try { snap = await freshSnapshot(CHECK_SNAPSHOT_TTL_MS); } catch { throw httpError(503, 'SNAPSHOT_FAILED'); }
    const rt = await resolveTarget(snap, viewer.user_id, address, port);
    const verdict = rt.verdict;
    // Settling may have started while the target was looked up (DNS): no refusal from old data.
    if (!verdict.ok && (targetsSettling() || !snapshotCurrent(snap))) throw httpError(503, 'TARGETS_SETTLING');
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
    let creds = {};
    if (opts.presetCreds) {
        creds = { ...opts.presetCreds };
    } else if (protocol === 'ssh') {
        creds.username = String(body.username || '').slice(0, 256);
        creds.password = String(body.password || '').slice(0, 1024);
        creds.privateKey = String(body.privateKey || '').slice(0, 16384);
        creds.passphrase = String(body.passphrase || '').slice(0, 1024);
    }
    if (protocol === 'ssh' && !creds.username) throw httpError(400, 'USERNAME_REQUIRED', 'Enter the user name for the SSH server.');

    // Check the quota again: the snapshot read above may have let another request in.
    if (countFor(viewer.user_id) >= _cfg.maxSessionsPerUser) throw httpError(429, 'TOO_MANY', `You can have at most ${_cfg.maxSessionsPerUser} sessions at a time. Close a session, or wait a moment and try again.`);
    if (_sessions.size >= _cfg.maxSessionsTotal) throw httpError(429, 'TOO_MANY_TOTAL');
    // And the settling state: an unanswered write may have started it during the reads above, or
    // the targets changed after the snapshot was read.
    if (targetsSettling() || !snapshotCurrent(snap)) throw httpError(503, 'TARGETS_SETTLING');
    // A shutdown that started during the reads above has already closed every session it saw.
    if (_shuttingDown) throw httpError(503, 'SERVER_RESTARTING');
    const s = {
        id: crypto.randomUUID(), protocol, address: rt.address, port, width, height, dpi, timezone, creds,
        // A launch link that connects to an address found for a host name keeps that name, for the SSH
        // host key set for it. Only the server supplies it.
        gateway: rt.gateway, targetName: rt.name || (rt.gateway === 'ip' && opts.targetName) || '',
        userId: viewer.user_id, userEmail: viewer.email || '', userName: viewer.name || '', oid: viewer.oid || '',
        clientIp: String(clientIp || ''),
        resourceId: verdict.resource.id, resourceName: verdict.resource.name || rt.address,
        resourceType: verdict.resource.type === 'subnet' ? 'SUBNET_RESOURCE' : verdict.resource.type === 'domain' ? 'DOMAIN_RESOURCE' : 'HOST_RESOURCE',
        // The approved resource's identity: what its hold is kept for.
        resourceAddress: String(verdict.resource.address || ''), nbType: verdict.resource.type || '',
        networkId: verdict.network.id,
        startedAt: new Date(), leaseAt: Date.now(), lastInputAt: Date.now(),
        // 'preparing' while its target is opened: it counts toward the quotas, has no token yet and
        // is not re-checked. Every way out of here that is not a token closes it.
        state: 'preparing', ws: null, guacd: null, rx: 0, tx: 0, closed: false,
        started: Promise.resolve(false), // no start record yet, so no end record either
    };
    _sessions.set(s.id, s); // counts toward the quota from now on, including setup
    let issued = false;
    try {
        // A read-only instance too: it writes nothing to NetBird, but checks, holds, waits and
        // approves the same way.
        await openTargetForSession(s, port);

        // Whatever closes the session while its start is being recorded (a shutdown, a re-check),
        // closeSession writes the end record only after this start record, and none if it failed.
        s.started = recordStart(s);
        if (!(await s.started)) throw httpError(503, 'RECORD_FAILED', "Remote Access couldn't record the session, so it wasn't opened. Try again.");
        if (_shuttingDown) throw httpError(503, 'SERVER_RESTARTING');
        // An unanswered write may have started settling while the start was being recorded, or the
        // targets changed after the last evaluation.
        if (targetsSettling() || _targetsGen !== s.targetsGen) throw httpError(503, 'TARGETS_SETTLING');
        // Closed while its start was being written (a re-check, the feature turned off): no token for it.
        if (s.closed) throw httpError(409, 'SESSION_CLOSED', 'The session was closed before it finished opening. Connect again.');

        const token = crypto.randomBytes(32).toString('base64url');
        _tokens.set(token, { sessionId: s.id, expiresAt: Date.now() + TOKEN_TTL_MS });
        s.state = 'pending';
        // Still pending after the token's lifetime (never used, or used by an upgrade that then
        // failed): close it, so it never holds a quota slot.
        s.tokenTimer = setTimeout(() => {
            _tokens.delete(token);
            if (s.state === 'pending') closeSession(s, 'The session was not opened in time.');
        }, TOKEN_TTL_MS + 1000);
        issued = true;
        return { sessionId: s.id, token, resource: verdict.resource, network: verdict.network, address: s.address, name: s.targetName, gateway: s.gateway };
    } finally {
        // Frees the quota slot (and, after a start record, writes the end record).
        if (!issued) closeSession(s, _shuttingDown ? 'The server is restarting.' : 'The session did not open.');
    }
}

function closedError() {
    return _shuttingDown ? httpError(503, 'SERVER_RESTARTING') : httpError(409, 'SESSION_CLOSED', 'The session was closed before it finished opening. Connect again.');
}

// Open the session's server to its gateway, then approve it again from NetBird as it is now:
//   1. under the target lock (openTargetLocked): read the resource fresh, and if it no longer is
//      the approved one, stop before anything is written; set the hold (the full holdHours at
//      once); if the resource doesn't carry its target group yet, add the group to the RESOURCE
//      (never by rewriting the group's list, so two opens never undo each other, also on two
//      instances). A read-only instance does all of it but the NetBird write: it refuses a
//      resource that is not a member yet;
//   2. wait until the route is on the gateway (see openTargetLocked);
//   3. read NetBird again and evaluate for real (no simulation of the route): the same resource,
//      network and address, and the gateway's standing policy opens the port to the target group.
async function openTargetForSession(s, port) {
    const until = await withTargetLock(() => openTargetLocked(s));
    if (s.closed) throw closedError();
    const wait = until - Date.now();
    if (until && wait > 0) await _sleep(wait);
    if (s.closed) throw closedError();

    // Under the target lock: a resource write of this instance holds it until NetBird answered, so
    // this read comes after any write already sent, and a write sent after it raises the generation
    // (no token then). The read's own clean-up of managed members runs detached and only queues.
    const snap = await withTargetLock(async () => {
        s.targetsGen = _targetsGen;
        // Always a new read (never the one the checks above used, even within the same millisecond).
        _snapshot = null;
        try { return await freshSnapshot(0); } catch { throw httpError(503, 'SNAPSHOT_FAILED'); }
    });
    if (s.closed) throw closedError();
    const cfg = authCfg(s.gateway, { real: true });
    const v = s.gateway === 'names'
        ? evaluateNameAccess(snap, cfg, { userId: s.userId, name: s.address, port })
        : evaluateUserAccess(snap, cfg, { userId: s.userId, address: s.address, port });
    if (!v.ok) throw httpError(v.code === 'GATEWAY_NOT_SYNCED' ? 503 : 403, v.code);
    if (v.resource.id !== s.resourceId || v.network.id !== s.networkId || addressKey(v.resource.address) !== addressKey(s.resourceAddress)) throw httpError(409, 'TARGET_CHANGED');
    const problem = standingPolicyProblem(snap, standingIds(s.gateway), port);
    if (problem) throw httpError(409, problem);
    if (targetsSettling() || !snapshotCurrent(snap)) throw httpError(503, 'TARGETS_SETTLING');
}

// The hold for a session start, in one statement: the same identity (network and address) keeps its
// added_at (another instance may have just added the resource) and gets the later expiry; another
// identity replaces the row. Returns the row as the database has it.
const UPSERT_HOLD_SQL = `INSERT INTO remote_access_targets (resource_id, network_id, address, added_at, expires_at, updated_at)
    VALUES ($1, $2, $3, NULL, $4, NOW())
    ON CONFLICT (resource_id) DO UPDATE SET
        added_at = CASE WHEN remote_access_targets.network_id = EXCLUDED.network_id AND remote_access_targets.address = EXCLUDED.address
            THEN remote_access_targets.added_at ELSE NULL END,
        expires_at = CASE WHEN remote_access_targets.network_id = EXCLUDED.network_id AND remote_access_targets.address = EXCLUDED.address
            THEN GREATEST(remote_access_targets.expires_at, EXCLUDED.expires_at) ELSE EXCLUDED.expires_at END,
        network_id = EXCLUDED.network_id, address = EXCLUDED.address, updated_at = NOW()
    RETURNING ${HOLD_COLUMNS}`;
const SET_ADDED_AT_SQL = 'UPDATE remote_access_targets SET added_at = $4, updated_at = NOW() WHERE resource_id = $1 AND network_id = $2 AND address = $3';
// A member whose recorded add is this recent may have been added by a write still on its way when
// this request saw it (another request, another instance, or a restamp that failed): the route may
// not be on the gateway yet.
const RECENT_ADD_MS = 30_000;

// Returns when the session may go on (ms since the epoch; 0: at once):
//   - added now: ROUTE_SETTLE_MS after the write's answer;
//   - already a member, with an add recorded in the last RECENT_ADD_MS: ROUTE_SETTLE_MS after the
//     later of that add and the moment this request saw the membership;
//   - already a member otherwise: at once.
async function openTargetLocked(s) {
    if (s.closed) throw closedError();
    const tg = targetGroupFor(s.networkId, s.resourceAddress);
    if (!tg) throw httpError(409, 'GATEWAY_POLICY_MISSING');

    // The resource as NetBird has it now: still the approved one? Checked before the hold, so an
    // approval that is out of date never replaces the hold of the resource's new identity.
    const path = `/api/networks/${encodeURIComponent(s.networkId)}/resources/${encodeURIComponent(s.resourceId)}`;
    const got = await netbirdReq('GET', path);
    if (got && got.status === 404) throw httpError(409, 'TARGET_CHANGED');
    const res = got && got.body;
    if (!nbOk(got) || !res || typeof res !== 'object') throw httpError(503, 'TARGET_OPEN_FAILED');
    if (res.id !== s.resourceId || addressKey(res.address) !== addressKey(s.resourceAddress) || !s.nbType || res.type !== s.nbType) throw httpError(409, 'TARGET_CHANGED');
    const groups = (Array.isArray(res.groups) ? res.groups : []).map(refId).filter(Boolean);
    const seenAt = Date.now();

    let row;
    try {
        const r = await pool.query(UPSERT_HOLD_SQL, [s.resourceId, s.networkId, addressKey(s.resourceAddress), new Date(Date.now() + _cfg.holdHours * 3_600_000)]);
        row = r && r.rows && r.rows[0];
        if (!row || !msOf(row.expires_at)) throw new Error('the database returned no hold');
    } catch (e) {
        console.error('[remote-access] could not record a target hold:', e.message);
        throw httpError(503, 'TARGET_OPEN_FAILED');
    }
    const hold = { networkId: String(row.network_id), address: String(row.address), addedAt: msOf(row.added_at), expiresAt: msOf(row.expires_at) };
    _holds.set(s.resourceId, hold);
    if (s.closed) throw closedError();

    if (groups.includes(tg)) {
        if (!hold.addedAt || seenAt - hold.addedAt > RECENT_ADD_MS) return 0;
        return Math.max(hold.addedAt, seenAt) + ROUTE_SETTLE_MS;
    }
    // A read-only instance writes nothing to NetBird, so it can't open the server.
    if (NETBIRD_READONLY) throw httpError(409, 'TARGET_NOT_OPEN_READONLY');

    // Recorded before the write: a write that lands is never without its added_at.
    const ids = [s.resourceId, s.networkId, addressKey(s.resourceAddress)];
    try {
        const at = Date.now();
        const u = await pool.query(SET_ADDED_AT_SQL, [...ids, new Date(at)]);
        if (!u || u.rowCount !== 1) throw new Error(`the hold was not found (${u ? u.rowCount : 'no answer'})`);
        hold.addedAt = at;
    } catch (e) {
        console.error('[remote-access] could not record when a target is added:', e.message);
        throw httpError(503, 'TARGET_OPEN_FAILED');
    }
    if (s.closed) throw closedError();
    const w = await netbirdReq('PUT', path, {
        name: res.name, address: res.address, description: res.description || '', enabled: res.enabled !== false, groups: [...groups, tg],
    });
    // Any answer but success leaves the write uncertain: it may still land.
    if (!nbOk(w)) {
        noteUncertainTargetWrite();
        console.error('[remote-access] could not add %s to the target group: %s', s.resourceId, (w && (w.raw || w.error || w.status)) || 'no response');
        throw httpError(503, 'TARGET_OPEN_FAILED');
    }
    bustNbCaches('policies', 'gref', 'groups', 'usage');
    const at = Date.now();
    hold.addedAt = at;
    await pool.query(SET_ADDED_AT_SQL, [...ids, new Date(at)])
        .catch(e => console.error('[remote-access] could not record when a target was added:', e.message));
    if (_deps.recordAudit) {
        Promise.resolve(_deps.recordAudit({
            actorId: s.userId, actorEmail: s.userEmail, actorName: s.userName, action: 'remote_access.target_open', target: s.resourceName,
            meta: { group: managedGroupName(tg), resourceId: s.resourceId, networkId: s.networkId, address: s.resourceAddress, holdHours: _cfg.holdHours },
        })).catch(() => { });
    }
    return at + ROUTE_SETTLE_MS;
}

// The live-state row and the start record. Resolves true, or false after undoing the row.
async function recordStart(s) {
    try {
        await pool.query(
            `INSERT INTO remote_sessions (id, user_id, user_email, user_name, client_ip, protocol, target_addr, target_port, resource_id, resource_name, network_id, started_at, target_name, gateway)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [s.id, s.userId, s.userEmail, s.userName, s.clientIp, s.protocol, s.address, s.port, s.resourceId, s.resourceName, s.networkId, s.startedAt, s.targetName, s.gateway]);
        await addEvent(sessionEvent(s, 'start'));
        return true;
    } catch (e) {
        _sessions.delete(s.id);
        await pool.query('DELETE FROM remote_sessions WHERE id = $1', [s.id]).catch(() => { });
        console.error('[remote-access] could not record session start:', e.message);
        return false;
    }
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
        // Credentials come only from a launch link. Otherwise they are left empty: an NLA server
        // makes guacd ask for them ("required"), else the Windows logon screen appears.
        username: s.creds.username || '', password: s.creds.password || '', domain: s.creds.domain || '',
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
    pipeTunnel(s, ws, {
        guacd: s.gateway === 'names' ? { host: _cfg.namesGuacdHost, port: _cfg.namesGuacdPort } : { host: _cfg.guacdHost, port: _cfg.guacdPort },
        select: s.protocol,
        connectArgs: (names) => connectArgs(s, names),
        argv: s.protocol === 'ssh' ? SSH_ARGV : [],
        fitSize: (w, h) => (w > 0 && h > 0 && w <= MAX_WIDTH && h <= MAX_HEIGHT ? [w, h] : null),
        fail: (message, code, detail) => failSession(s, message, code, detail),
        close: (reason) => closeSession(s, reason),
    });
}

function pipeTunnel(s, ws, o) {
    s.ws = ws;
    // The tunnel's own UUID first: Guacamole.WebSocketTunnel marks itself open on it.
    ws.send(encodeInstruction('', s.id));

    const sock = net.connect(o.guacd);
    s.guacd = sock;
    const decoder = new StringDecoder('utf8');
    const parser = new GuacParser(GUACD_INSTRUCTION_MAX);
    const clientParser = new GuacParser(CLIENT_INSTRUCTION_MAX, { maxElements: CLIENT_MAX_ELEMENTS, maxInstruction: CLIENT_INSTRUCTION_MAX });
    // argv names guacd asked for, and the browser's open output streams (clipboard, allowed argv).
    const argvNames = new Set(o.argv);
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
        if (!handshakeDone) o.fail('The Browser Gateway did not answer in time.', 0x0208);
    }, HANDSHAKE_TIMEOUT_MS);
    let displayTimer = null;
    const DISPLAY_OPCODES = new Set(['size', 'sync']);
    const noteDisplay = (list) => {
        for (const ins of list) {
            if (!displayTimer) return false;
            if (DISPLAY_OPCODES.has(ins.opcode)) { clearTimeout(displayTimer); displayTimer = null; return false; }
            if (ins.opcode === 'error') {
                clearTimeout(displayTimer);
                displayTimer = null;
                o.fail(o.displayFailedMessage, 0x0203, ins.args[0]);
                return true;
            }
        }
        return false;
    };

    sock.setNoDelay(true);
    sock.on('connect', () => sock.write(encodeInstruction('select', o.select)));
    sock.on('error', (e) => o.fail(handshakeDone ? 'The connection to the server was lost.' : 'The Browser Gateway is not reachable.', 0x0208, e.message));
    sock.on('close', () => { clearTimeout(displayTimer); o.close(handshakeDone ? 'The server closed the connection.' : 'The Browser Gateway closed the connection.', 'guacd'); });

    // Backpressure guacd -> browser.
    let stalledSince = 0;
    let drainTimer = null;
    const checkDrain = () => {
        if (s.closed) return clearInterval(drainTimer);
        if (ws.bufferedAmount <= WS_BUFFER_LOW) {
            clearInterval(drainTimer); drainTimer = null; stalledSince = 0; sock.resume();
        } else if (Date.now() - stalledSince > STALL_LIMIT_MS) {
            clearInterval(drainTimer); o.fail('Your browser stopped receiving data, so the session was closed.', 0x0308);
        }
    };

    sock.on('data', (chunk) => {
        let instructions;
        try { instructions = parser.push(decoder.write(chunk)); }
        catch (e) { return o.fail('The gateway sent data that could not be read.', 0x0200, e.message); }
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
                    const values = o.connectArgs(names);
                    sock.write(encodeInstruction('connect', ...(version ? [version] : []), ...values));
                    // The SSH secrets are no longer needed here.
                    s.creds = {};
                } else if (ins.opcode === 'ready') {
                    handshakeDone = true;
                    clearTimeout(handshakeTimer);
                    s.state = 'open';
                    if (o.displayTimeoutMs) displayTimer = setTimeout(() => o.fail(o.displayFailedMessage, 0x0202), o.displayTimeoutMs);
                    const after = instructions.slice(k + 1);
                    noteRequired(after);
                    if (noteDisplay(after)) return;
                    const rest = after.map(x => x.raw).join('');
                    if (rest) forward(rest);
                    return;
                } else if (ins.opcode === 'error') {
                    return o.fail('The Browser Gateway refused the connection.', 0x0203, ins.args[0]);
                }
            }
            return;
        }
        noteRequired(instructions);
        if (noteDisplay(instructions)) return;
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
        if (isBinary) return o.fail('Unexpected data from the browser.', 0x0300);
        let instructions;
        try { instructions = clientParser.push(data.toString('utf8')); }
        catch (e) { return o.fail('The browser sent data that could not be read.', 0x0300, e.message); }
        let out = '';
        for (const ins of instructions) {
            if (ins.opcode === '') {
                // Internal channel: answer the stability ping with an identical message.
                if (ins.args[0] === 'ping') ws.send(ins.raw);
                continue;
            }
            if (!handshakeDone || !CLIENT_OPCODES.has(ins.opcode)) continue;
            let raw = ins.raw;
            if (ins.opcode === 'size') {
                const w = Number(ins.args[0]), h = Number(ins.args[1]);
                const fit = o.fitSize(w, h);
                if (!fit) continue;
                if (fit[0] !== w || fit[1] !== h) raw = encodeInstruction('size', String(fit[0]), String(fit[1]), ...ins.args.slice(2));
            }
            if (ins.opcode === 'disconnect') { o.close('Closed by the user.', 'disconnect'); return; }
            if (!streamAllowed(ins)) {
                if (!warnedDrop) { warnedDrop = true; console.warn('[remote-access] session %s: dropped a browser %s that guacd did not ask for', s.id, ins.opcode); }
                continue;
            }
            if (INPUT_OPCODES.has(ins.opcode)) s.lastInputAt = Date.now();
            out += raw;
        }
        if (!out || s.closed) return;
        s.tx += Buffer.byteLength(out);
        if (!sock.write(out)) {
            ws.pause();
            const pausedAt = Date.now();
            const t = setTimeout(() => o.fail('The server stopped receiving data, so the session was closed.', 0x0308), STALL_LIMIT_MS);
            sock.once('drain', () => { clearTimeout(t); if (!s.closed && Date.now() - pausedAt <= STALL_LIMIT_MS) ws.resume(); });
        }
    });
    ws.on('close', () => o.close('The browser closed the session.', 'browser'));
    ws.on('error', () => o.close('The browser connection failed.', 'browser'));
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
    // After the start record (the session may close while its start is still being written), and
    // none when the start failed. Kept until written, so a shutdown can wait for every end record.
    const p = Promise.resolve(s.started ?? true)
        .then((started) => (started ? recordEnd(s, endedAt, reason) : undefined))
        .catch(e => console.error('[remote-access] could not record session end:', e.message));
    _pendingEnds.add(p);
    _endingIds.add(s.id);
    p.finally(() => { _pendingEnds.delete(p); _endingIds.delete(s.id); });
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

// Process shutdown (SIGTERM): no new session from now on, also in requests already past their
// first checks; every open one is closed with a reason; resolves once every end record that is
// still being written, including earlier ones, is done. The caller bounds the wait.
async function shutdownSessions(reason) {
    _shuttingDown = true;
    // Every session closes now. The end record of one whose start is still being written follows
    // that start record (closeSession), so a hanging start holds back only its own end record.
    closeAllSessions(reason);
    while (_pendingEnds.size) await Promise.allSettled([..._pendingEnds]);
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
        if (s.state !== 'pending' && s.state !== 'preparing' && now - s.leaseAt > LEASE_TIMEOUT_MS) { failSession(s, 'Your sign-in ended or the page stopped responding, so the session was closed.', 0x0303); continue; }
        if (now - s.lastInputAt > _cfg.idleTimeoutMin * 60_000) { failSession(s, `The session was idle for ${_cfg.idleTimeoutMin} minutes and was closed.`, 0x020A); continue; }
        if (now - s.startedAt.getTime() > _cfg.maxDurationHours * 3_600_000) { failSession(s, `Sessions are limited to ${_cfg.maxDurationHours} hours. Connect again to continue.`, 0x020A); continue; }
    }
    if (!_sessions.size) { _lastGoodRecheck = now; return; }
    let snap = null;
    try {
        _snapshot = null; // the re-check always reads NetBird again (not a target change)
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
    // Real membership only: an open session's server is in its target group. A session still
    // opening its target is checked by its own start.
    const kept = [];
    await Promise.all([..._sessions.values()].filter(s => s.state !== 'preparing').map(async (s) => {
        const cfg = authCfg(s.gateway, { real: true });
        const v = s.gateway === 'names'
            ? evaluateNameAccess(snap, cfg, { userId: s.userId, name: s.address, port: s.port })
            : evaluateUserAccess(snap, cfg, { userId: s.userId, address: s.address, port: s.port });
        if (!v.ok || v.resource.id !== s.resourceId) { failSession(s, v.ok ? SESSION_TARGET_CHANGED : `Your session ended. ${MESSAGES[v.code] || 'Connect again. If it keeps happening, tell an administrator.'}`, 0x0303); return; }
        // The approved resource itself changed (another network, another address): not the server
        // this session was approved and opened for.
        if (v.network.id !== s.networkId || addressKey(v.resource.address) !== addressKey(s.resourceAddress)) { failSession(s, SESSION_TARGET_CHANGED, 0x0303); return; }
        if (!(await permitted(s)) && !s.closed) { failSession(s, "Your session ended because your Remote Access permission was removed or couldn't be confirmed. Ask an administrator if you need it.", 0x0303); return; }
        if (!s.closed) kept.push(s);
    }));
    await extendHolds(kept);
}

// An open session keeps its server: each re-check raises the hold's expiry to now + holdHours.
// Only a hold whose identity is still the one the session was approved for is extended (the address
// compared as NetBird means it); a missing hold is not created again. Read-only instances do this
// too: it writes only Postgres.
async function extendHolds(sessions) {
    if (!sessions.length) return;
    const ids = new Map();
    for (const s of sessions) ids.set(`${s.resourceId}\n${s.networkId}\n${addressKey(s.resourceAddress)}`, s);
    const until = Date.now() + _cfg.holdHours * 3_600_000;
    await withTargetLock(async () => {
        for (const s of ids.values()) {
            try {
                const r = await pool.query('SELECT address FROM remote_access_targets WHERE resource_id = $1 AND network_id = $2', [s.resourceId, s.networkId]);
                const row = r && r.rows && r.rows[0];
                if (!row || addressKey(row.address) !== addressKey(s.resourceAddress)) continue;
                // The stored address exactly: a row replaced meanwhile is not touched.
                const u = await pool.query(
                    'UPDATE remote_access_targets SET expires_at = GREATEST(expires_at, $4), updated_at = NOW() WHERE resource_id = $1 AND network_id = $2 AND address = $3',
                    [s.resourceId, s.networkId, row.address, new Date(until)]);
                const h = _holds.get(s.resourceId);
                if (u && u.rowCount && h && sameIdentity(h, s.networkId, s.resourceAddress)) h.expiresAt = Math.max(h.expiresAt, until);
            } catch (e) {
                console.error('[remote-access] could not extend a target hold:', e.message);
            }
        }
    }).catch(() => { });
}

function readSnapshotNow() {
    _snapshot = null;
    return freshSnapshot(0);
}

// Sweeps that need no NetBird read: lease, idle, duration. Runs more often than the full re-check
// so a stuck NetBird read can never hold sessions open past their limits.
function sweepSessions() {
    const now = Date.now();
    if (_sessions.size && now - _lastGoodRecheck > SNAPSHOT_MAX_AGE_MS) closeAllSessions("Your access couldn't be verified with NetBird, so the session was closed.");
    for (const s of [..._sessions.values()]) {
        if (s.state !== 'pending' && s.state !== 'preparing' && now - s.leaseAt > LEASE_TIMEOUT_MS) failSession(s, 'Your sign-in ended or the page stopped responding, so the session was closed.', 0x0303);
    }
}

// Sessions left open by a crash or restart: closed with an honest reason.
// The rows of this process's own sessions are not orphans: this instance may already serve sessions
// when it becomes the leader (lib/leader.js). strict (the leader's recovery): throws when a row
// could not be closed, instead of leaving it for the next start-up.
async function closeOrphanSessions({ strict = false } = {}) {
    const r = await pool.query('SELECT * FROM remote_sessions');
    const reason = 'The server restarted. The real end time is unknown.';
    let closed = 0;
    let failed = 0;
    for (const row of r.rows) {
        if (_sessions.has(row.id) || _endingIds.has(row.id)) continue;
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
            failed++;
            console.error('[remote-access] orphan end record (kept for the next start-up):', e.message);
        }
    }
    if (strict && failed) throw new Error(`${failed} remote session(s) left by a restart could not be closed`);
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

// The servers sessions opened, with a hold that has not expired: in use by a session of this
// instance, or until when the hold keeps them. A hold is listed only while the NetBird snapshot shows
// its resource in the right target group with the network and address the hold is for (or a
// session of this instance uses it); the names come from it. No snapshot: nothing is listed (the
// page shows why).
function heldTargets(snap) {
    if (!snap) return [];
    const now = Date.now();
    const resById = new Map(((snap && snap.resources) || []).filter(r => r && r.id).map(r => [r.id, r]));
    const netById = new Map(((snap && snap.networks) || []).filter(n => n && n.id).map(n => [n.id, n]));
    const netOfRes = new Map();
    for (const n of netById.values()) for (const rid of (Array.isArray(n.resources) ? n.resources : [])) netOfRes.set(String((rid && rid.id) || rid), n.id);
    // In the target group its address belongs to, with the network and address the hold is for.
    const member = (id, h) => {
        const res = resById.get(id);
        const tg = isIpResourceAddress(h.address) ? _nb.targetGroupId : _nb.namesTargetGroupId;
        return !!res && !!tg && netOfRes.get(id) === h.networkId && addressKey(res.address) === addressKey(h.address)
            && (Array.isArray(res.groups) ? res.groups : []).some(g => refId(g) === tg);
    };
    return [..._holds].filter(([, h]) => h.expiresAt > now)
        .map(([id, h]) => {
            const res = resById.get(id);
            const net = netById.get(h.networkId);
            const inUse = [..._sessions.values()].some(s => s.resourceId === id && s.state !== 'preparing' && sameIdentity(h, s.networkId, s.resourceAddress));
            if (!inUse && !member(id, h)) return null;
            return { resourceId: id, name: (res && res.name) || h.address, address: h.address, network: (net && net.name) || h.networkId, inUse, expiresAt: new Date(h.expiresAt).toISOString() };
        })
        .filter(Boolean)
        .sort((a, b) => (a.inUse === b.inUse ? a.name.localeCompare(b.name) : a.inUse ? -1 : 1));
}

async function getRemoteAccessStatus() {
    const out = {
        enabled: _cfg.enabled, activeSessions: _sessions.size, guacdReachable: null,
        gateway: { enrolled: false, online: false, peers: [] }, domainRoutes: [], extraReach: [], targets: 0, error: '',
        names: { guacdReachable: null, gateway: { enrolled: false, online: false, peers: [] }, extraReach: [], targets: 0 },
        conflicts: [],
        lastApply: { ..._lastApply },
        membership: { ..._lastMembership, removed: [..._lastMembership.removed] },
        held: [],
    };
    [out.guacdReachable, out.names.guacdReachable] = await Promise.all([
        probeGuacd(_cfg.guacdHost, _cfg.guacdPort), probeGuacd(_cfg.namesGuacdHost, _cfg.namesGuacdPort), loadTargetHolds()]);
    if (!netbirdApiConfigured()) { out.error = 'The NetBird API is not connected.'; return out; }
    try {
        const snap = await freshSnapshot(30_000);
        out.held = heldTargets(snap);
        const peersOf = (r) => (r.peers || []).map(p => ({ id: p.id, name: p.name || p.id, connected: !!p.connected, ip: p.ip || '' }));
        const nreach = gatewayReach(snap, authCfg('names'));
        out.names.gateway.enrolled = nreach.error !== 'GATEWAY_NOT_ENROLLED';
        if (nreach.error === 'GATEWAY_REACH_UNKNOWN') out.names.reachError = MESSAGES.GATEWAY_REACH_UNKNOWN;
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
        out.gateway.enrolled = reach.error !== 'GATEWAY_NOT_ENROLLED';
        if (reach.error === 'GATEWAY_REACH_UNKNOWN') out.reachError = MESSAGES.GATEWAY_REACH_UNKNOWN;
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

// ─── Service status (the connect page) ───
// One line for the user: is NetBird answering, and is each Browser Gateway up? Measured by an active,
// read-only probe of the main account, independent of the snapshot and of every cache:
//   - netbird: is NetBird reachable? One GET to an API path that needs a sign-in, sent WITHOUT the
//     token: any answer below 500 (401 included) is up; no answer, a timeout or a 5xx is down.
//   - each gateway: its group's peers read from NetBird (the connected flag of each peer) and a TCP
//     probe of that gateway's guacd; up when a peer is connected and guacd answers, down when either
//     is known bad, unknown when NetBird couldn't be read for another reason.
// The gateway reads are ordinary authenticated NetBird reads (as every other NetBird call). One probe
// at a time, kept for 15 s; a settings change (another NetBird URL, other gateway groups or guacd
// addresses) starts a new probe and a probe from the old settings is never used.
const HEALTH_TTL_MS = 15_000;
let healthDeadlineMs = 9_000; // per part of the probe (tests shorten it)
const HEALTH_GET_MS = 4_000;
const HEALTH_PEERS_MAX = 50;      // peers read per gateway group
const HEALTH_PEERS_PARALLEL = 5; // at a time
let _health = null;    // { key, value, at }
let _healthRun = null; // { key, promise }
// What the last read of the names group showed, for one NetBird URL and one names group:
// { key, seen }. Only the latest probe that started updates it, under the names group
// it started with, and only while that group is still the current one.
let _namesSeen = null;
let _probeGen = 0; // raised by every probe that starts; only the latest may store its answer
const namesSeenKey = (url, groupId) => JSON.stringify([url, groupId]);
const healthKey = () => JSON.stringify([_nbApi.url, _nb.gatewayGroupId, _nb.namesGroupId, _cfg.guacdHost, _cfg.guacdPort, _cfg.namesGuacdHost, _cfg.namesGuacdPort]);
const okStatus = (r) => !!r && r.status >= 200 && r.status < 300;

const netbirdState = (r) => (r && r.status > 0 && r.status < 500 ? 'up' : 'down');
// The peers of a gateway group: { read: true, peers, connected }, or { read: false } when NetBird
// couldn't be read (with `peers` when the group itself was read). NetBird answers an empty list as
// null. `info.peers` is set as soon as the group was read, so a part that runs out of time still
// knows whether the group has peers. No peer read starts after `stopAt`.
async function gatewayPeers(get, groupId, stopAt, info) {
    if (!groupId) { info.peers = 0; return { read: true, peers: 0, connected: false }; }
    const g = await get('/api/groups/' + encodeURIComponent(groupId));
    if (g && g.status === 404) { info.peers = 0; return { read: true, peers: 0, connected: false }; }
    const list = okStatus(g) && g.body && typeof g.body === 'object' ? (g.body.peers === null ? [] : g.body.peers) : undefined;
    if (!Array.isArray(list)) return { read: false };
    const ids = list.map(refId).filter(Boolean);
    info.peers = ids.length;
    if (!ids.length) return { read: true, peers: 0, connected: false };
    // Every peer of the group (up to HEALTH_PEERS_MAX), a few at a time; one connected peer is enough.
    let allRead = ids.length <= HEALTH_PEERS_MAX;
    const todo = ids.slice(0, HEALTH_PEERS_MAX);
    for (let i = 0; i < todo.length; i += HEALTH_PEERS_PARALLEL) {
        if (Date.now() >= stopAt) return { read: false, peers: ids.length };
        const peers = await Promise.all(todo.slice(i, i + HEALTH_PEERS_PARALLEL).map(id => get('/api/peers/' + encodeURIComponent(id))));
        if (peers.some(r => okStatus(r) && r.body && r.body.connected === true)) return { read: true, peers: ids.length, connected: true };
        if (!peers.every(r => okStatus(r) && r.body && typeof r.body.connected === 'boolean')) allRead = false;
    }
    return allRead ? { read: true, peers: ids.length, connected: false } : { read: false, peers: ids.length };
}
function gatewayState(peers, guacdUp) {
    if (peers.read && peers.connected && guacdUp) return 'up';
    if (!guacdUp || (peers.read && !peers.connected)) return 'down';
    return 'unknown';
}
// Each part (NetBird, the IP gateway, the names gateway) has its own time limit; a part that runs
// out of time is unknown (NetBird down; a gateway whose guacd is already known to be down is down),
// and the others keep what they measured.
const PART_TIMED_OUT = Symbol('timed out');
async function probeHealth(gen) {
    const stopAt = Date.now() + healthDeadlineMs;
    const url = _nbApi.url;
    const namesGroup = _nb.namesGroupId;
    const get = (path) => nbDirectGet(path, { auth: true, timeoutMs: HEALTH_GET_MS });
    const part = (promise) => withDeadline(promise, healthDeadlineMs, 'A status check').catch(() => PART_TIMED_OUT);
    const gatewayPart = (groupId, host, port) => {
        const info = {};
        const guacd = probeGuacd(host, port).then(up => { info.up = up; return up; });
        return part(Promise.all([gatewayPeers(get, groupId, stopAt, info), guacd]))
            .then(r => (r === PART_TIMED_OUT ? { timedOut: true, info } : { peers: r[0], up: r[1], info }));
    };
    const [nb, ip, names] = await Promise.all([
        part(nbDirectGet('/api/users/current', { timeoutMs: HEALTH_GET_MS }).then(netbirdState)),
        gatewayPart(_nb.gatewayGroupId, _cfg.guacdHost, _cfg.guacdPort),
        namesGroup ? gatewayPart(namesGroup, _cfg.namesGuacdHost, _cfg.namesGuacdPort) : Promise.resolve(null),
    ]);
    const stateOf = (g) => (g.timedOut ? (g.info.up === false ? 'down' : 'unknown') : gatewayState(g.peers, g.up));
    const out = { netbird: nb === PART_TIMED_OUT ? 'down' : nb, gateway: stateOf(ip) };
    if (!names) return out;
    // The names gateway only when it is set up: a read of its group showed a peer. When the group
    // couldn't be read, it stays in as unknown if the last read, for this URL, had shown one.
    const seenKey = namesSeenKey(url, namesGroup);
    if (gen === _probeGen && names.info.peers !== undefined && _nb.namesGroupId === namesGroup) _namesSeen = { key: seenKey, seen: names.info.peers > 0 };
    if (names.info.peers > 0) out.namesGateway = stateOf(names);
    else if (names.info.peers === undefined && _namesSeen && _namesSeen.key === seenKey && _namesSeen.seen) out.namesGateway = 'unknown';
    return out;
}
async function getServiceHealth() {
    for (let i = 0; i < 3; i++) {
        const key = healthKey();
        if (_health && _health.key === key && Date.now() - _health.at < HEALTH_TTL_MS) return { ..._health.value };
        let run = _healthRun && _healthRun.key === key ? _healthRun : null;
        if (!run) {
            const mine = { key, promise: null };
            const gen = ++_probeGen;
            mine.promise = probeHealth(gen)
                .catch(() => ({ netbird: 'unknown', gateway: 'unknown' }))
                .then(value => {
                    if (gen === _probeGen && healthKey() === key) _health = { key, value, at: Date.now() };
                    return value;
                })
                .finally(() => { if (_healthRun === mine) _healthRun = null; });
            _healthRun = mine;
            run = mine;
        }
        const value = await run.promise;
        // Settings changed while it ran: its answer is about the old settings.
        if (healthKey() === key) return { ...value };
    }
    return { netbird: 'unknown', gateway: 'unknown' };
}

// ─── Launch links (POST /api/v1/remote-access/launch) ───
// Another system (the customer file) asks, server to server with an API key, for a session to a
// target with stored credentials. It gets a one-time link; the browser opens it signed in to the
// portal, and the session opens with the same checks as a manual connect. The credentials stay in
// this process: in the launch entry until the link is opened, then in the session until guacd has
// them. The link holds only a random ticket; this map is keyed by the ticket's SHA-256.
//   - user (email) given: the user must exist (one NetBird user, not blocked) and have access to
//     the target now, and only that user can open the link.
//   - user empty: no check at issue; whoever opens the link first and passes the checks gets it.
const LAUNCH_TTL_MS = 5 * 60_000;
const LAUNCH_MAX = 500;
const LAUNCH_SCOPE = 'remote-access:launch';
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const _launches = new Map(); // sha256(ticket) -> entry
let _launchSweep = null;

const ticketHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const ticketRef = (hash) => hash.slice(0, 12); // what audit records carry, never the ticket

function sweepLaunches(now = Date.now()) {
    for (const [k, v] of _launches) if (v.expiresAt <= now) _launches.delete(k);
    if (!_launches.size && _launchSweep) { clearInterval(_launchSweep); _launchSweep = null; }
}
function launchRoom() { sweepLaunches(); return _launches.size < LAUNCH_MAX; }

const LAUNCH_MESSAGES = {
    USER_NOT_FOUND: 'No NetBird user has this email address.',
    USER_AMBIGUOUS: 'More than one NetBird user has this email address, so the user is unclear.',
    USER_BLOCKED: 'This NetBird user is blocked.',
};

function str(v, max, field) {
    if (v == null || v === '') return '';
    if (typeof v !== 'string') throw httpError(400, 'INVALID_FIELD', `"${field}" must be text.`);
    if (v.length > max) throw httpError(400, 'INVALID_FIELD', `"${field}" is too long (at most ${max} characters).`);
    return v;
}

// ─── Refused launch requests in the audit log ───
// One record per key and refusal code at the 1st, 10th, 100th... refusal in a 10-minute window,
// with the count so far, so a key holder can't flood the log (the target is the caller's choice,
// so it is not part of what is collapsed). A failed write is tried again on a later refusal, at
// most once a minute. The target holds only values that passed the field checks; never the body's
// other fields.
const REFUSAL_WINDOW_MS = 10 * 60_000;
const REFUSAL_RETRY_MS = 60_000;
const _refusals = new Map(); // `${keyId}:${code}` -> { until, count, next, retryAt, writing }

function refusalTarget(body) {
    const b = body && typeof body === 'object' ? body : {};
    const p = typeof b.protocol === 'string' ? b.protocol.toLowerCase() : '';
    const protocol = p === 'rdp' || p === 'ssh' ? p : 'invalid';
    const t = typeof b.address === 'string' ? normalizeTarget(b.address) : { error: true };
    const address = t.error ? 'invalid' : (t.kind === 'ip' ? t.ip : t.name);
    const rp = b.port;
    const portOk = typeof rp === 'string' ? /^\d{1,5}$/.test(rp) && Number(rp) >= 1 && Number(rp) <= 65535 : (Number.isInteger(rp) && rp >= 1 && rp <= 65535);
    return `${protocol}://${address}:${portOk ? Number(rp) : 'invalid'}`;
}

async function auditRefusedLaunch(key, code, body) {
    const now = Date.now();
    const id = `${key.id}:${code}`;
    let r = _refusals.get(id);
    if (!r) {
        // Entries idle past their window (a key that stopped, or was revoked) are dropped.
        for (const [k, v] of _refusals) if (now >= v.until && now >= v.retryAt && !v.writing) _refusals.delete(k);
        r = { until: 0, count: 0, next: 1, retryAt: 0, writing: false };
        _refusals.set(id, r);
    }
    // A new window restarts the count; a write in flight and the wait after a failed one carry over.
    if (now >= r.until) { r.until = now + REFUSAL_WINDOW_MS; r.count = 0; r.next = 1; }
    r.count++;
    if (r.writing || r.count < r.next || now < r.retryAt) return;
    r.writing = true;
    const count = r.count;
    const window = r.until;
    try {
        await apiKeys.writeAuditStrict(pool, {
            ...apiKeys.keyActor(key), action: 'remote_access.launch_refused', target: refusalTarget(body),
            meta: { keyId: key.id, code, count }, timeoutMs: apiKeys.QUERY_TIMEOUT_MS,
        });
        if (r.until === window) while (r.next <= count) r.next *= 10;
    } catch (e) {
        r.retryAt = Date.now() + REFUSAL_RETRY_MS;
        console.error('[remote-access] launch refusal audit failed:', e.message);
    } finally {
        r.writing = false;
    }
}

// Issue a launch link. `key` is the API key ({ id, name }) the caller used. A refusal is recorded
// (see above) and then reaches the caller unchanged.
async function issueLaunch(key, body) {
    try {
        return await issueLaunchChecked(key, body);
    } catch (e) {
        if (e && e.status && e.code !== 'AUDIT_FAILED' && !e.audited) {
            await auditRefusedLaunch(key, e.code, body).catch(() => { });
        }
        throw e;
    }
}

async function issueLaunchChecked(key, body) {
    const wantCreate = body ? body.createResource : undefined;
    if (wantCreate !== undefined && typeof wantCreate !== 'boolean') throw httpError(400, 'INVALID_FIELD', '"createResource" must be true or false.');
    if (wantCreate && !keyHasScope(key, CREATE_SCOPE)) throw httpError(403, 'SCOPE_MISSING', 'This API key has no permission to create resources.');
    if (!remoteAccessAvailable()) throw httpError(403, 'DISABLED', 'Browser remote access is turned off.');
    // The port exactly as sent: an integer, or a string of digits ("3389.5" or "3389x" is refused).
    const rawPort = body && body.port;
    const portOk = typeof rawPort === 'string' ? /^\d{1,5}$/.test(rawPort) : (Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535);
    if (!portOk) throw httpError(400, 'INVALID_PORT');
    const { protocol, address, port } = parseTarget(body);
    if (!address || address.length > 255) throw httpError(400, 'INVALID_ADDRESS');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'INVALID_PORT');
    const email = str(body.user, 254, 'user').trim().toLowerCase();
    const creds = {
        username: str(body.username, 256, 'username'), password: str(body.password, 1024, 'password'),
        domain: str(body.domain, 256, 'domain'),
        privateKey: str(body.privateKey, 16384, 'privateKey'), passphrase: str(body.passphrase, 1024, 'passphrase'),
    };
    if (protocol === 'ssh' && !creds.username) throw httpError(400, 'USERNAME_REQUIRED', 'Send the user name for the SSH server.');
    if (protocol === 'rdp') { delete creds.privateKey; delete creds.passphrase; }
    else delete creds.domain;
    if (email && !email.includes('@')) throw httpError(400, 'INVALID_USER', '"user" must be an email address.');
    const launchSnapshot = () => freshSnapshot(CHECK_SNAPSHOT_TTL_MS).catch(() => { throw httpError(503, 'SNAPSHOT_FAILED'); });
    const user = email ? launchUser(await launchSnapshot(), email) : null;

    let made = { address };
    if (wantCreate) {
        // No server is added for a link that couldn't be made anyway.
        if (!launchRoom()) throw httpError(503, 'BUSY', 'Too many connection links are waiting to be opened. Try again in a few minutes.');
        made = await createForLaunch(key, address);
    }
    const { address: connectTo, resource } = made;
    try {
        if (user) {
            const rt = await resolveTarget(await launchSnapshot(), user.id, connectTo, port);
            if (!rt.verdict.ok) throw httpError(403, rt.verdict.code);
            if (resource && !resource.id && rt.verdict.resource && rt.verdict.resource.id) resource.id = rt.verdict.resource.id;
        }

        if (!launchRoom()) throw httpError(503, 'BUSY', 'Too many connection links are waiting to be opened. Try again in a few minutes.');
        const ticket = crypto.randomBytes(32).toString('base64url');
        const hash = ticketHash(ticket);
        const audit = { ...apiKeys.keyActor(key), target: `${protocol}://${address}:${port}` };
        const meta = { ticketRef: ticketRef(hash), keyId: key.id, user: email || null, ...(connectTo !== address ? { connectTo } : {}), ...(resource ? { resourceCreated: resource.created } : {}) };
        try {
            await apiKeys.writeAuditStrict(pool, { ...audit, action: 'remote_access.launch_issue', meta, timeoutMs: apiKeys.QUERY_TIMEOUT_MS });
        } catch (e) {
            console.error('[remote-access] launch audit failed:', e.message);
            throw httpError(503, 'AUDIT_FAILED', "The request couldn't be recorded, so no link was made. Try again.");
        }
        // Checked again with no await before the insert: other requests may have filled the room
        // while the audit record was written.
        if (!launchRoom()) {
            const recorded = await apiKeys.writeAuditStrict(pool, { ...audit, action: 'remote_access.launch_discard', meta: { ticketRef: ticketRef(hash), reason: 'busy' }, timeoutMs: apiKeys.QUERY_TIMEOUT_MS }).then(() => true, () => false);
            const busy = httpError(503, 'BUSY', 'Too many connection links are waiting to be opened. Try again in a few minutes.');
            busy.audited = recorded; // the discard record already says why; else the refusal record does
            throw busy;
        }
        const expiresAt = Date.now() + LAUNCH_TTL_MS;
        _launches.set(hash, { userId: user && user.id, email, protocol, address: connectTo, targetName: made.name || '', port, creds, keyId: key.id, keyName: key.name, expiresAt });
        if (!_launchSweep) { _launchSweep = setInterval(sweepLaunches, 30_000); _launchSweep.unref(); }
        return { ticket, expiresAt: new Date(expiresAt).toISOString(), ...(resource ? { resource } : {}) };
    } catch (e) {
        // The resource stays, and the refusal says so.
        if (made.sent && e) e.resourceCreated = true;
        throw e;
    }
}

function launchUser(snap, email) {
    const matches = (snap.users || []).filter(u => u && String(u.email || '').toLowerCase() === email);
    if (!matches.length) throw httpError(404, 'USER_NOT_FOUND', LAUNCH_MESSAGES.USER_NOT_FOUND);
    if (matches.length > 1) throw httpError(409, 'USER_AMBIGUOUS', LAUNCH_MESSAGES.USER_AMBIGUOUS);
    const u = matches[0];
    if (u.is_blocked || u.status === 'blocked') throw httpError(403, 'USER_BLOCKED', LAUNCH_MESSAGES.USER_BLOCKED);
    return u;
}

function launchScreen(protocol, body) {
    const rdp = body.rdp;
    const size = protocol === 'rdp' && rdp && typeof rdp === 'object' && ['width', 'height', 'dpi'].every((k) => Number.isFinite(rdp[k])) ? rdp : body;
    return { width: size.width, height: size.height, dpi: size.dpi };
}

// Open a launch link: the signed-in viewer gets the session. The ticket is used up on the first
// try, whatever the outcome. (The browser waits for remote access to be ready - /info settling -
// before it opens a link.)
async function redeemLaunch(viewer, body, clientIp) {
    const ticket = String((body && body.ticket) || '');
    const hash = TICKET_RE.test(ticket) ? ticketHash(ticket) : '';
    const entry = hash ? _launches.get(hash) : null;
    if (hash) _launches.delete(hash);
    if (!entry || entry.expiresAt <= Date.now()) throw httpError(410, 'EXPIRED', 'This link has expired or was already used. Open the connection again from the system that sent you here.');
    const ref = ticketRef(hash);
    const actor = { actorId: viewer.user_id || viewer.oid || '', actorEmail: viewer.email || '', actorName: viewer.name || '' };
    const target = `${entry.protocol}://${entry.address}:${entry.port}`;
    let valid;
    try { valid = await apiKeys.keyStillValid(entry.keyId, LAUNCH_SCOPE); } catch { throw httpError(503, 'UNAVAILABLE', "Remote Access couldn't check this link. Wait a moment, then start the connection again from the system that sent you here."); }
    if (!valid) throw httpError(410, 'KEY_REVOKED', 'The system that sent you here no longer has a valid key for Remote Access. Ask an administrator to update the key, then start the connection again from that system.');
    if (entry.userId && entry.userId !== viewer.user_id) {
        await apiKeys.writeAuditStrict(pool, { ...actor, action: 'remote_access.launch_wrong_user', target, meta: { ticketRef: ref, keyId: entry.keyId, intendedUser: entry.email }, timeoutMs: apiKeys.QUERY_TIMEOUT_MS })
            .catch((e) => console.error('[remote-access] launch audit failed:', e.message));
        throw httpError(403, 'WRONG_USER', 'This link was made for another user. Sign in to NetBird Control with the right account, then start the connection again from the system that sent you here.');
    }
    try {
        await apiKeys.writeAuditStrict(pool, { ...actor, action: 'remote_access.launch_open', target, meta: { ticketRef: ref, keyId: entry.keyId, keyName: entry.keyName }, timeoutMs: apiKeys.QUERY_TIMEOUT_MS });
    } catch (e) {
        console.error('[remote-access] launch audit failed:', e.message);
        throw httpError(503, 'AUDIT_FAILED', "The connection couldn't be recorded, so it was not opened. Open it again from the system that sent you here.");
    }
    const display = { protocol: entry.protocol, address: entry.address, port: entry.port, ...launchScreen(entry.protocol, body), timezone: body.timezone };
    const out = await createSession(viewer, display, clientIp, { presetCreds: entry.creds, targetName: entry.targetName || '' });
    return { ...out, protocol: entry.protocol, port: entry.port, serverCredentials: true };
}

// ─── Resources created by the launch API ───
// A launch request with createResource: true (and the key scope for it) adds a public server that
// NetBird has no resource for, as a temporary host resource. Access stays NetBird's: the resource
// goes into the group of the Shared Access Profile chosen in Settings, and that profile's policy
// decides who reaches it. This code never writes a policy.
//
// Each attempt is a row in ra_created_resources, so the resource is found again and removed:
//   creating -> created | failed | unknown   (unknown: sent, without a clear answer)
//   unknown, or creating left by a restart -> created | kept | failed
//   created -> deleted | kept | gone         kept -> deleted | gone
// A kept resource (changed since, or named by a policy) is only an administrator's to delete.
const CREATE_SCOPE = 'remote-access:create-resource';
// These count toward the limit; the unique index in db.js allows one such row per address.
const CREATE_ACTIVE = ['creating', 'unknown', 'created'];
const CREATE_IN_USE = [...CREATE_ACTIVE, 'kept'];
const CREATE_FINISHED = ['failed', 'deleted', 'gone'];
const CREATE_FINISHED_LISTED = 50;
const CREATE_RECOVER_MS = 10 * 60_000;
// Each delete waits for the target lock and for NetBird; a burst of expiries must not hold the sync.
const CREATE_DELETES_PER_RUN = 20;
const API_NETWORK_MESSAGE = 'This network is managed by Remote Access. An admin can change its name, description and routing peers, and delete its servers or the network.';
const REMOTE_ACCESS_ACTOR = { actorId: '', actorEmail: '', actorName: 'Remote Access' };

const keyHasScope = (key, scope) => !!key && Array.isArray(key.scopes) && key.scopes.includes(scope);
const rowsOf = (r) => (r && r.rows) || [];
const createUsable = (c) => !NETBIRD_READONLY && c.enabled && !!c.networkId && !!c.profileId && !!c.groupId && _cfg.networks.includes(c.networkId);

async function countCreatedRows(states, exceptNetworkId = '') {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM ra_created_resources WHERE state = ANY($1) AND network_id <> $2', [states, exceptNetworkId]);
    return Number((rowsOf(r)[0] || {}).n) || 0;
}
const countCreatedInUse = (exceptNetworkId) => countCreatedRows(CREATE_IN_USE, exceptNetworkId);

// The networks whose resources only this code (and an admin's delete) may change: the chosen one
// while creating is on, and any with servers launch links added that are still in use.
async function linkGuardNetworkIds() {
    const r = await pool.query('SELECT DISTINCT network_id FROM ra_created_resources WHERE state = ANY($1)', [CREATE_IN_USE]);
    const { networkId, enabled } = _cfg.createResources;
    return new Set([...rowsOf(r).map(x => x.network_id), ...(enabled && networkId ? [networkId] : [])]);
}
async function createdResourceIds() {
    const r = await pool.query("SELECT resource_id FROM ra_created_resources WHERE state = ANY($1) AND resource_id <> ''", [CREATE_IN_USE]);
    return new Set(rowsOf(r).map(x => String(x.resource_id)));
}
// An administrator deleted it, so the sync has nothing left to remove.
async function noteCreatedResourceDeleted(resourceId) {
    await pool.query(`UPDATE ra_created_resources SET state = 'deleted', reason = $2, updated_at = NOW() WHERE resource_id = $1 AND state = ANY($3)`,
        [resourceId, 'Deleted by an admin in Networks.', CREATE_IN_USE]);
}
async function noteCreatedNetworkDeleted(networkId) {
    await pool.query(`UPDATE ra_created_resources SET state = 'deleted', reason = $2, updated_at = NOW() WHERE network_id = $1 AND state = ANY($3)`,
        [networkId, 'The network was deleted by an admin.', CREATE_IN_USE]);
}
async function sessionResourceIds() {
    const r = await pool.query("SELECT DISTINCT resource_id FROM remote_sessions WHERE resource_id <> ''");
    const out = new Set(rowsOf(r).map(x => String(x.resource_id)));
    for (const s of _sessions.values()) if (s.resourceId) out.add(String(s.resourceId));
    return out;
}

// The IANA IPv4 Special-Purpose Address Registry, and multicast: never added from a link.
const NOT_PUBLIC_PREFIXES = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.0.0.0/24', '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
    '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
].map(parsePrefix);
function isPublicIpv4(ip) {
    const n = ipv4ToInt(ip);
    return n !== null && !NOT_PUBLIC_PREFIXES.some(p => n >= p.start && n <= p.end);
}

// ─── Settings for created resources ───
async function profileRow(profileId) {
    const r = await pool.query(`SELECT id, group_id, policy_id, shared FROM access_profiles WHERE id = $1 AND tenant = ''`, [profileId]);
    return rowsOf(r)[0] || null;
}
// A settings import may have put another profile under the stored id.
async function createProfileUnchanged(c) {
    const p = await profileRow(c.profileId);
    return !!p && p.shared !== false && String(p.group_id || '') === c.groupId;
}
async function resolveCreateProfile(profileId) {
    const refuse = (message) => { throw httpError(400, 'INVALID_SETTINGS', message); };
    const p = await profileRow(profileId);
    if (!p) refuse('This Access Profile no longer exists. Choose another one.');
    if (p.shared === false) refuse('Choose a Shared Access Profile: a Direct profile has no group for the servers.');
    const groupId = String(p.group_id || '');
    const read = async (path, missing) => {
        const r = await netbirdReq('GET', path);
        if (r && r.status === 404) refuse(missing);
        if (!nbOk(r) || !r.body || typeof r.body !== 'object') throw httpError(503, 'UNAVAILABLE', "The Access Profile couldn't be checked, so nothing was saved. Try again.");
        return r.body;
    };
    await read('/api/groups/' + encodeURIComponent(groupId), "This Access Profile's group no longer exists in NetBird. Choose another profile.");
    const policy = await read('/api/policies/' + encodeURIComponent(p.policy_id), "This Access Profile's policy no longer exists in NetBird. Choose another profile.");
    if (policy.enabled !== true) refuse("This Access Profile's policy is turned off in NetBird. Turn it on, or choose another profile.");
    const opens = (r) => r && r.enabled === true && r.action === 'accept' && (Array.isArray(r.destinations) ? r.destinations : []).some(d => refId(d) === groupId);
    if (!(Array.isArray(policy.rules) ? policy.rules : []).some(opens)) {
        refuse("This Access Profile's policy has no enabled rule that allows access to its group. Fix the profile, or choose another one.");
    }
    return groupId;
}
// The network and the group are never a client's to set: the Choose Network actions and the profile
// decide them.
async function checkedCreateSection(sent) {
    const cur = _cfg.createResources;
    const pick = (k) => (sent[k] === undefined ? cur[k] : sent[k]);
    const next = normCreate({ ...cur, enabled: pick('enabled'), profileId: pick('profileId'), max: pick('max') });
    const turnsOn = next.enabled && !cur.enabled;
    // Turning it off is always possible.
    if (next.enabled) {
        const refuse = (message) => { throw httpError(400, 'INVALID_SETTINGS', message); };
        if (!next.networkId) refuse('Choose the network first.');
        if (!next.profileId) refuse('Choose the Access Profile that decides who can reach the servers.');
        if (!netbirdApiConfigured()) refuse('Connect the NetBird API first (Settings > NetBird API).');
    }
    if (next.profileId !== cur.profileId || turnsOn) next.groupId = next.profileId ? await resolveCreateProfile(next.profileId) : '';
    if (next.groupId !== cur.groupId) {
        const n = await countCreatedInUse();
        if (n) throw httpError(409, 'CREATED_RESOURCES_EXIST', createdInUseMessage(n, 'The Access Profile'));
    }
    if (turnsOn) await _deps.checkLaunchNetwork(next.networkId);
    return next;
}
const createdInUseMessage = (n, what = 'The network') => `${n} server${n === 1 ? '' : 's'} added by launch links ${n === 1 ? 'is' : 'are'} still in use. ${what} can be changed once ${n === 1 ? 'it is' : 'they are'} removed; kept ones can be deleted in Networks.`;
// A chosen network is open to the gateway.
async function storeCreateSection(patch) {
    const networks = patch.networkId ? [...new Set([..._cfg.networks, patch.networkId])] : _cfg.networks;
    const next = normConfig({ ..._cfg, networks, createResources: { ..._cfg.createResources, ...patch } });
    await setSetting('remote_access_config', JSON.stringify(next));
    _cfg = next;
    noteTargetsChanged();
    return { networks: [...next.networks], createResources: { ...next.createResources } };
}
async function launchNetworkName() {
    await loadInstallName();
    return { name: nbName('Remote Access Resources'), max: NB_NAME_MAX };
}
// remote_access_config from a settings import or a backup restore, which never turns creating on;
// null for a value that isn't a settings object.
function importedRemoteAccessConfig(value) {
    let x = null;
    try { x = JSON.parse(value); } catch { return null; }
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    return JSON.stringify({ ...x, createResources: { ...x.createResources, enabled: false } });
}

// ─── Adding a server ───
const auditCreated = (actor, action, target, meta) => apiKeys.writeAuditStrict(pool, { ...actor, action, target, meta, timeoutMs: apiKeys.QUERY_TIMEOUT_MS })
    .catch(e => console.error('[remote-access] audit failed (%s):', action, e.message));

// Only from the state it was read in: an admin may have deleted it meanwhile. A row whose write
// failed is found again by the sync.
async function settleCreated(attemptId, from, state, { resourceId = '', reason = '' } = {}) {
    try {
        const r = await pool.query(
            `UPDATE ra_created_resources SET state = $3, resource_id = CASE WHEN $4 = '' THEN resource_id ELSE $4 END, reason = $5, updated_at = NOW()
             WHERE attempt_id = $1 AND state = $2`, [attemptId, from, state, resourceId, reason]);
        return !!(r && r.rowCount);
    } catch (e) {
        console.error('[remote-access] could not record a created resource:', e.message);
        return false;
    }
}

// Returns the row of a server another request added a moment ago, or null when this request adds it.
async function reserveCreate(key, c, row, meta) {
    if ((await countCreatedRows(CREATE_ACTIVE)) >= c.max) throw httpError(409, 'CREATE_LIMIT');
    const ins = await pool.query(
        `INSERT INTO ra_created_resources (attempt_id, ip, name, network_id, group_id, key_id, state, expected_name, expected_address, expected_description)
         VALUES ($1, $2, $3, $4, $5, $6, 'creating', $7, $8, $9) ON CONFLICT DO NOTHING`,
        [row.attemptId, row.ip, row.name, c.networkId, c.groupId, key.id, row.expected.name, row.expected.address, row.expected.description]);
    if (!ins.rowCount) {
        const prior = rowsOf(await pool.query('SELECT state, resource_id FROM ra_created_resources WHERE ip = $1 AND state = ANY($2)', [row.ip, CREATE_ACTIVE]))[0];
        if (prior && prior.state === 'created') return prior;
        if (prior && prior.state === 'unknown') throw httpError(503, 'CREATE_UNCONFIRMED', "An earlier request to add this server wasn't confirmed by NetBird yet. Try again in a few minutes.");
        throw httpError(409, 'CREATE_IN_PROGRESS');
    }
    try {
        await apiKeys.writeAuditStrict(pool, { ...apiKeys.keyActor(key), action: 'resource.create_intent', target: row.expected.address, meta, timeoutMs: apiKeys.QUERY_TIMEOUT_MS });
    } catch (e) {
        await settleCreated(row.attemptId, 'creating', 'failed', { reason: 'The request could not be recorded.' });
        throw e;
    }
    return null;
}

// A launch with createResource: true. Returns what the link connects to (`address`), the host name
// the request sent when the link connects to an address found for it (`name`, which keeps the SSH
// host key set for that name), and the answer's `resource`; `sent` when this request added it.
// A target NetBird already covers goes on as without createResource, whatever the settings say:
// an integration may send createResource on every launch.
async function createForLaunch(key, address) {
    const t = normalizeTarget(address);
    if (t.error) throw httpError(400, 'INVALID_ADDRESS');
    const usable = () => createUsable(_cfg.createResources);
    const normal = { address, resource: { created: false, address: t.kind === 'ip' ? t.ip : t.name } };

    let inv;
    try { inv = await getUsageData({ strict: true }); } catch {
        if (!usable()) return normal;
        throw httpError(503, 'SNAPSHOT_FAILED');
    }
    let ips = [t.ip];
    if (t.kind === 'ip') {
        if (!ipUncovered(inv, t.ip)) return normal;
    } else {
        if (nameCovered(inv, t.name)) return normal;
        let answers;
        try { answers = await (_deps.resolve4 || defaultResolve4)(t.name); } catch (e) {
            if (!usable()) return normal;
            if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) throw httpError(403, 'NAME_NOT_FOUND');
            throw httpError(503, 'NAME_LOOKUP_FAILED');
        }
        ips = (Array.isArray(answers) ? answers : []).map(String).filter(ip => normalizeTarget(ip).kind === 'ip');
        if (!ips.length) {
            if (!usable()) return normal;
            throw httpError(403, 'NAME_NOT_FOUND');
        }
        // An answer that is never a target (loopback, say) doesn't make the name covered: it is
        // refused below as not public.
        if (ips.some(ip => !isRefusedTarget(ipv4ToInt(ip)) && ipCovered(inv, ip))) return normal;
    }

    const c = _cfg.createResources;
    if (!createUsable(c)) throw httpError(403, 'CREATE_DISABLED');
    if (targetsSettling()) throw httpError(503, 'TARGETS_SETTLING');
    if (!ips.every(isPublicIpv4)) throw httpError(403, t.kind === 'ip' ? 'ADDRESS_NOT_PUBLIC' : 'NAME_NOT_PUBLIC');
    const ip = ips[0];
    const name = t.kind === 'name' ? t.name : '';
    const attemptId = crypto.randomUUID();
    const expected = { name: name ? `${name} (${ip})` : ip, address: `${ip}/32`, description: `Created by the Remote Access API (${attemptId})` };
    const meta = { attemptId, name: name || null, networkId: c.networkId, profileId: c.profileId, groupId: c.groupId, keyId: key.id };
    let existing;
    try {
        // The list holds names as an administrator typed them (an IDN, a trailing dot).
        const blocklist = (await getBlocklist()).map(e => ({ ...e, value: normalizeTarget(e.value).name || e.value }));
        if ([ip, `${ip}/32`, name].some(a => a && addressBlockedForNetwork(a, c.networkId, blocklist))) throw httpError(403, 'ADDRESS_BLOCKED');
        if (!(await createProfileUnchanged(c))) throw httpError(403, 'CREATE_DISABLED');
        existing = await reserveCreate(key, c, { attemptId, ip, name, expected }, meta);
    } catch (e) {
        if (e && e.status) throw e;
        console.error('[remote-access] could not reserve a created resource:', e && e.message);
        throw httpError(503, 'UNAVAILABLE', "The request couldn't be recorded, so no server was added. Try again.");
    }
    if (existing) {
        invalidateSnapshot();
        return { address: ip, name, resource: { created: false, ...(existing.resource_id ? { id: existing.resource_id } : {}), address: ip } };
    }

    let res = null;
    let failure = null;
    try {
        const out = await _deps.createClientResource(c.networkId, {
            name: expected.name, address: expected.address, description: expected.description, groups: [c.groupId], policies: [],
        }, { linkWrite: true });
        res = out && out.resource;
    } catch (e) { failure = e; }
    invalidateSnapshot();
    const actor = apiKeys.keyActor(key);

    // A 429 is no clear answer: it may stand for a retry that got no answer (lib/netbird.js).
    if (failure && failure.code !== 'RESOURCE_UNCONFIRMED' && failure.nbStatus !== 429) {
        if (await settleCreated(attemptId, 'creating', 'failed', { reason: 'NetBird refused the resource.' })) await auditCreated(actor, 'resource.create_failed', expected.address, meta);
        console.error('[remote-access] a launch link could not add %s: %s', expected.address, failure.message);
        throw httpError(502, 'RESOURCE_CREATE_FAILED');
    }
    const id = res && typeof res.id === 'string' ? res.id : '';
    // The writer drops a managed group without saying so.
    const hasGroup = !!res && Array.isArray(res.groups) && res.groups.some(g => refId(g) === c.groupId);
    if (failure || !id || !hasGroup) {
        const reason = !id ? "NetBird didn't confirm the resource." : "NetBird didn't put the resource in the group.";
        await settleCreated(attemptId, 'creating', 'unknown', { resourceId: id, reason });
        await auditCreated(actor, 'resource.create_unconfirmed', expected.address, { ...meta, resourceId: id || null, reason });
        throw Object.assign(httpError(502, 'CREATE_UNCONFIRMED'), { resourceCreated: id ? true : 'unknown' });
    }
    await settleCreated(attemptId, 'creating', 'created', { resourceId: id });
    await auditCreated(actor, 'resource.create', expected.address, { ...meta, resourceId: id });
    return { address: ip, name, resource: { created: true, id, address: ip }, sent: true };
}

// ─── Removing the servers (the leader, after each target sync) ───
// Its target group membership is the sessions' doing.
function sameAsCreated(res, row) {
    const targets = new Set(targetGroupIds());
    const groups = (Array.isArray(res.groups) ? res.groups : []).map(refId).filter(g => g && !targets.has(g));
    return res.name === row.expected_name && addressKey(res.address) === addressKey(row.expected_address)
        && String(res.description || '') === row.expected_description && res.enabled !== false
        && groups.length === 1 && groups[0] === row.group_id;
}
const policyUsing = (policies, rid) => policies.find(p => p && (Array.isArray(p.rules) ? p.rules : []).some(r => r
    && [r.destinationResource, r.sourceResource].some(x => x && refId(x) === rid)));

async function createdResourceInUse(resourceId) {
    if ([..._sessions.values()].some(s => s.resourceId === resourceId)) return true;
    const r = await pool.query(`SELECT 1 FROM remote_access_targets WHERE resource_id = $1 AND expires_at > NOW()
                                UNION ALL SELECT 1 FROM remote_sessions WHERE resource_id = $1 LIMIT 1`, [resourceId]);
    return rowsOf(r).length > 0;
}

// A 404 alone can be a proxy in front of NetBird while it restarts.
async function networkGone(networkId) {
    const nets = nbListBody(await netbirdReq('GET', '/api/networks'));
    return !!nets && !nets.some(n => n && n.id === networkId);
}
async function maintainCreatedResources() {
    if (NETBIRD_READONLY || !netbirdApiConfigured() || (typeof currentTenantAccount === 'function' && currentTenantAccount())) return;
    if (_deps.isLeader && !_deps.isLeader()) return;
    const rows = rowsOf(await pool.query('SELECT * FROM ra_created_resources WHERE state = ANY($1) ORDER BY created_at', [CREATE_IN_USE]));
    const lists = new Map();
    const listOf = async (networkId) => {
        if (!lists.has(networkId)) {
            const r = await netbirdReq('GET', `/api/networks/${encodeURIComponent(networkId)}/resources`);
            lists.set(networkId, r && r.status === 404 && await networkGone(networkId) ? [] : nbListBody(r));
        }
        return lists.get(networkId);
    };
    let policies = null;
    let deletes = 0;
    for (const row of rows) {
        try {
            const list = await listOf(row.network_id);
            if (!list) continue;
            const age = Date.now() - msOf(row.created_at);
            // Never by address: an administrator's resource there is not adopted.
            const res = list.find(r => r && typeof r.id === 'string' && ((row.resource_id && r.id === row.resource_id) || String(r.description || '').includes(row.attempt_id)));
            const settle = async (state, { reason = '', audit = '' } = {}) => {
                const resourceId = (res && res.id) || row.resource_id;
                if (await settleCreated(row.attempt_id, row.state, state, { resourceId, reason }) && audit) {
                    await auditCreated(REMOTE_ACCESS_ACTOR, audit, row.expected_address, { attemptId: row.attempt_id, resourceId, networkId: row.network_id, ...(reason ? { reason } : {}) });
                }
            };
            if (row.state === 'creating' || row.state === 'unknown') {
                if (row.state === 'creating' && age < CREATE_RECOVER_MS) continue;
                if (res && sameAsCreated(res, row)) await settle('created', { audit: 'resource.create' });
                else if (res) await settle('kept', { reason: "It isn't exactly as it was created (for example, it isn't in the group). Delete it if it isn't needed.", audit: 'resource.kept' });
                else if (age >= CREATE_RECOVER_MS) await settle('failed', { reason: 'NetBird has no resource for this request.', audit: 'resource.create_failed' });
            } else if (!res) {
                await settle('gone', { reason: 'It is no longer in NetBird.' });
            } else if (row.state === 'created' && age >= _cfg.holdHours * 3_600_000 && deletes < CREATE_DELETES_PER_RUN && !(await createdResourceInUse(row.resource_id))) {
                if (!policies) policies = nbListBody(await netbirdReq('GET', '/api/policies'));
                if (!policies) return;
                deletes++;
                await withTargetLock(() => deleteCreatedLocked(row, policies, settle));
            }
        } catch (e) {
            console.error('[remote-access] created resource %s:', row.expected_address, e.message);
        }
    }
}

async function deleteCreatedLocked(row, policies, settle) {
    const path = `/api/networks/${encodeURIComponent(row.network_id)}/resources/${encodeURIComponent(row.resource_id)}`;
    const got = await netbirdReq('GET', path);
    if (!nbOk(got) || !got.body || typeof got.body !== 'object' || got.body.id !== row.resource_id) return;
    const user = policyUsing(policies, row.resource_id);
    const reason = !sameAsCreated(got.body, row) ? 'It was changed after it was created.' : user ? `The policy "${user.name || user.id}" uses it.` : '';
    if (reason) { await settle('kept', { reason, audit: 'resource.kept' }); return; }
    // A session may have opened it while this waited for the lock.
    if (await createdResourceInUse(row.resource_id)) return;
    noteTargetsChanged();
    const d = await netbirdReq('DELETE', path);
    bustNbCaches('policies', 'gref', 'usage');
    invalidateSnapshot();
    if (nbOk(d) || (d && d.status === 404)) { await settle('deleted', { audit: 'resource.delete' }); return; }
    if (!d || !d.status || d.status >= 500 || d.status === 429) {
        // It may be gone: the next run sees.
        noteUncertainTargetWrite();
        await auditCreated(REMOTE_ACCESS_ACTOR, 'resource.delete_unconfirmed', row.expected_address, { attemptId: row.attempt_id, resourceId: row.resource_id, networkId: row.network_id });
        return;
    }
    await settle('kept', { reason: `NetBird refused to delete it (HTTP ${d.status}).`, audit: 'resource.kept' });
}

async function listCreatedResources() {
    const cols = 'attempt_id, ip, name, resource_id, state, reason, expected_name, created_at, updated_at';
    const [inUse, finished] = await Promise.all([
        pool.query(`SELECT ${cols} FROM ra_created_resources WHERE state = ANY($1) ORDER BY created_at DESC`, [CREATE_IN_USE]),
        pool.query(`SELECT ${cols} FROM ra_created_resources WHERE state = ANY($1) ORDER BY updated_at DESC LIMIT $2`, [CREATE_FINISHED, CREATE_FINISHED_LISTED + 1]),
    ]);
    const iso = (v) => (msOf(v) ? new Date(msOf(v)).toISOString() : null);
    const item = (x) => ({
        id: x.attempt_id, address: x.ip, name: x.name || '', resourceName: x.expected_name || '', resourceId: x.resource_id || '',
        state: x.state, reason: x.reason || '', createdAt: iso(x.created_at), updatedAt: iso(x.updated_at),
    });
    const done = rowsOf(finished);
    return {
        readonly: !!NETBIRD_READONLY,
        items: [...rowsOf(inUse), ...done.slice(0, CREATE_FINISHED_LISTED)].map(item),
        finishedMore: done.length > CREATE_FINISHED_LISTED,
    };
}

module.exports = {
    issueLaunch, redeemLaunch,
    CREATE_SCOPE, API_NETWORK_MESSAGE, linkGuardNetworkIds, countCreatedInUse, createdInUseMessage, createdResourceIds, sessionResourceIds,
    noteCreatedResourceDeleted, noteCreatedNetworkDeleted, storeCreateSection, launchNetworkName, importedRemoteAccessConfig,
    listCreatedResources, maintainCreatedResources,
    loadRemoteAccessConfig, getRemoteAccessConfig, setRemoteAccessConfig, setRemoteAccessDeps,
    isRemoteAccessManagedPolicy, isRemoteAccessManagedGroup, withManagedTargets,
    withTargetLock, noteUncertainTargetWrite, noteTargetsChanged, ROUTE_SETTLE_MS, beginStartupSettling, enforceManagedMembership,
    remoteAccessAvailable, reconcileRemoteAccess, createGatewaySetupKey,
    checkAccess, createSession, renewLease, isSettling: () => targetsSettling(), endSession, takeToken, attachTunnel,
    recheckSessions, sweepSessions, closeOrphanSessions, closeAllSessions, shutdownSessions, getRemoteAccessStatus, getRemoteAccessStatusLite,
    getServiceHealth, invalidateSnapshot,
    RECHECK_INTERVAL_MS, WS_MAX_PAYLOAD,
    browserWanted, readBrowserGate, readWebPeer, readSnapshotNow, pipeTunnel, encodeInstruction, sendError, httpError, freshSnapshot, withDeadline,
    CHECK_SNAPSHOT_TTL_MS, LEASE_TIMEOUT_MS, MAX_SNAPSHOT_AGE_MS: SNAPSHOT_MAX_AGE_MS,
    _internal: {
        GuacParser, CLIENT_MAX_ELEMENTS, encodeInstruction, connectArgs, normConfig, sessionEvent, resolveTarget, MESSAGES, syncTargetGroup, applyGatewayObjects,
        launchCount: () => _launches.size, launchScreen, LAUNCH_MAX, LAUNCH_TTL_MS, ticketHash, sweepLaunches,
        REFUSAL_WINDOW_MS, REFUSAL_RETRY_MS, clearRefusals: () => _refusals.clear(), refusalCount: () => _refusals.size,
        setConfigForTest: (c) => { _cfg = normConfig(c); },
        setManagedForTest: (n) => { _nb = { ...NB_EMPTY, ...(n || {}) }; },
        lastApplyForTest: () => ({ ..._lastApply }),
        resetSettlingForTest: () => { clearTimeout(_settleTimer); _settleTimer = null; _settleUntil = 0; _lastSyncStartOk = 0; },
        settlingForTest: () => targetsSettling(),
        passSettleDeadlineForTest: () => { _settleUntil = Math.min(_settleUntil, Date.now() - 1); },
        settleTimerPendingForTest: () => !!_settleTimer,
        clearSettleTimerForTest: () => { clearTimeout(_settleTimer); _settleTimer = null; },
        freshSnapshot, invalidateSnapshot,
        resetHealthForTest: () => { _health = null; _healthRun = null; _namesSeen = null; },
        setHealthDeadlineForTest: (ms) => { healthDeadlineMs = ms || 9_000; },
        membershipIdleForTest: async () => { while (_membershipRun) await _membershipRun; },
        resetMembershipForTest: () => { _membershipFailed.clear(); _lastMembership = { at: null, removed: [], error: '' }; _membershipPending = null; },
        passMembershipRetryForTest: () => { for (const f of _membershipFailed.values()) f.at -= MEMBERSHIP_RETRY_MS; },
        installNameForTest: () => _installName,
        // Target holds: read the in-memory copy, and replace the wait before approval.
        holdsForTest: () => Object.fromEntries([..._holds].map(([id, h]) => [id, { ...h }])),
        setSleepForTest: (fn) => { _sleep = fn || ((ms) => new Promise(r => setTimeout(r, ms))); },
        loadTargetHolds, heldTargets,
        lastMembershipForTest: () => ({ ..._lastMembership }),
        isPublicIpv4, CREATE_RECOVER_MS,
        addSessionForTest: (s) => { _sessions.set(s.id, s); }, removeSessionForTest: (id) => { _sessions.delete(id); },
    },
};
