// NetBird Management API client + its in-memory caches, extracted verbatim from db.js. This owns
// the API connection config, the raw authenticated callers (netbirdGet/netbirdPost/netbirdReq),
// the read-only guard, and the pure caches whose refresh only calls netbirdGet (groups, policies,
// the group ref-map, usage datasets, reverse-proxy status, and the EDR-bypassed peer set).
//
// The DB-backed pieces that consume this client - ensurePeersFresh/ensureUsersFresh/upsertPeers,
// anomaly + domain code - stay in db.js and use the imported client + caches. Dependencies are
// one-way (db.js -> lib/netbird.js -> lib/core.js + lib/http.js; never the reverse, no cycle).

const https = require('https');
const http = require('http');
const { AsyncLocalStorage } = require('async_hooks');
const { pool, setSetting } = require('./core');
const { noteNetbirdOk } = require('./http');

// ─── MSP tenant context ───
// The NetBird Cloud MSP portal manages child tenants with the SAME token plus an
// `account=<tenantId>` query param on every management call (exactly what the official
// dashboard does). A request handled inside runWithTenant() transparently targets that
// tenant: the three low-level callers below append the param, and every cache in this
// module switches to a short-TTL per-tenant slot so tenant data NEVER mixes with the
// main account's caches. Scheduler jobs run outside any context → always the main account.
const _tenantAls = new AsyncLocalStorage();
// opts.authToken: explicit token override for this context - used by tenant PROVISIONING,
// which must call NetBird with the MSP admin's user token (+ ?account=) before the tenant
// has any token of its own.
function runWithTenant(accountId, fn, opts) {
    return _tenantAls.run({ account: String(accountId), authToken: (opts && opts.authToken) || '' }, fn);
}
function currentTenantAccount() { const s = _tenantAls.getStore(); return (s && s.account) || ''; }

// Per-tenant API tokens (PATs created INSIDE the tenant account). NetBird's permission
// groups cannot contain service users, so the main service-user token often cannot switch
// into tenants at all - a per-tenant token is the reliable path. When one exists for the
// active tenant, requests authenticate WITH IT directly (no ?account= needed); without
// one we fall back to main-token account switching. Loaded from app_settings on boot.
const _tenantTokens = new Map(); // tenant/account id → PAT
// The MSP PROVISIONING token: a USER token (an MSP admin in the tenants' permission groups)
// used ONLY to create each tenant's own service user + token - never for routine calls.
const _mspProv = { token: '' };
function getMspProvisioningToken() { return _mspProv.token; }
function setMspProvisioningTokenInMemory(token) { _mspProv.token = String(token || ''); }
async function loadTenantTokens() {
    try {
        const r = await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'msp_tenant_token:%' OR key = 'msp_provisioning_token'`);
        _tenantTokens.clear();
        _mspProv.token = '';
        for (const row of r.rows) {
            if (row.key === 'msp_provisioning_token') { _mspProv.token = row.value || ''; continue; }
            const id = row.key.slice('msp_tenant_token:'.length);
            if (id && row.value) _tenantTokens.set(id, row.value);
        }
    } catch (e) {
        console.error('[MSP] tenant token load error:', e.message);
    }
}
// Register/unregister in memory under one or more ids (record id + switcher/account ids,
// so the token resolves no matter which id form the switch context carries).
function setTenantTokenInMemory(ids, token) {
    for (const id of ids) {
        if (!id) continue;
        if (token) _tenantTokens.set(id, token); else _tenantTokens.delete(id);
    }
}
function hasTenantToken(id) { return _tenantTokens.has(String(id)); }
// The auth + url adjustments for the active tenant context, shared by the three callers.
// Order: explicit override (provisioning, always with ?account=) → the tenant's own PAT
// (no switch needed) → main token + ?account= switching as a fallback.
function tenantAuth(url) {
    const s = _tenantAls.getStore();
    const tenant = (s && s.account) || '';
    if (!tenant) return _nbApi.token;
    if (s.authToken) {
        url.searchParams.set('account', tenant);
        return s.authToken;
    }
    const tok = _tenantTokens.get(tenant);
    if (tok) return tok; // direct tenant PAT - no account switch needed
    url.searchParams.set('account', tenant); // fall back to main-token switching
    return _nbApi.token;
}
// Per-tenant cache slots (groups/policies/gref/usage), 60s TTL - tenant admin views are
// low-traffic, and short freshness beats cross-tenant staleness.
const TENANT_TTL_MS = 60 * 1000;
const _tenantStore = new Map(); // account id → { groupsMap, groupsAt, ... }
function tenantSlot() {
    const acct = currentTenantAccount();
    let s = _tenantStore.get(acct);
    if (!s) {
        if (_tenantStore.size > 50) _tenantStore.clear(); // runaway backstop
        s = {};
        _tenantStore.set(acct, s);
    }
    return s;
}

// ─── NetBird Management API connection (configured in-app, env as fallback) ───
// Cached in memory so the many API helpers stay synchronous; DB settings override
// the NETBIRD_API_URL / NETBIRD_API_TOKEN env vars when present.
// Values set via env are authoritative and locked (can't be edited in the app); the
// DB-backed values are only used for fields env doesn't define.
const _nbEnv = { url: process.env['NETBIRD_API_URL'] || '', token: process.env['NETBIRD_API_TOKEN'] || '' };
const _nbApi = { url: _nbEnv.url, token: _nbEnv.token };

async function loadNbApi() {
    try {
        const r = await pool.query("SELECT key, value FROM app_settings WHERE key IN ('netbird_api_url', 'netbird_api_token')");
        const m = {};
        for (const row of r.rows) m[row.key] = row.value;
        if (!_nbEnv.url && m.netbird_api_url) _nbApi.url = m.netbird_api_url;
        if (!_nbEnv.token && m.netbird_api_token) _nbApi.token = m.netbird_api_token;
    } catch (e) {
        console.error('[NetBird API] config load error:', e.message);
    }
}

// Read-safe config for the UI - never exposes the token; flags env-locked fields.
function getNbApiConfig() {
    return { url: _nbApi.url || '', hasToken: !!_nbApi.token, urlFromEnv: !!_nbEnv.url, tokenFromEnv: !!_nbEnv.token };
}

// Persist + apply new connection settings. Env-managed fields are immutable; an
// empty/omitted token keeps the existing one.
async function setNbApiConfig({ url, token }) {
    if (url !== undefined && !_nbEnv.url) {
        _nbApi.url = String(url || '').trim();
        await setSetting('netbird_api_url', _nbApi.url);
    }
    if (token !== undefined && String(token).trim() !== '' && !_nbEnv.token) {
        _nbApi.token = String(token).trim();
        await setSetting('netbird_api_token', _nbApi.token);
    }
    // Force the caches that depend on the API to refresh on next use.
    resetNbCaches();
    return getNbApiConfig();
}

// Bust one or more NetBird-derived in-memory caches so the next read re-pulls fresh from the
// Management API. Names: 'groups' | 'policies' | 'gref' | 'usage'. db.js call sites (which used to
// zero these timestamps by hand before the state moved here) pass exactly the caches they reset.
function bustNbCaches(...names) {
    for (const n of names) {
        if (n === 'groups') _groupsAt = 0;
        else if (n === 'policies') _policiesAt = 0;
        else if (n === 'gref') _grefAt = 0;
        else if (n === 'usage') _usage.at = 0;
    }
}

// db.js registers a hook here to also drop its own peers/users caches (which stay in db.js) so
// resetNbCaches keeps its original full-reset behavior without netbird.js depending on db.js.
let _extraCacheReset = () => { };
function setCacheResetHook(fn) { if (typeof fn === 'function') _extraCacheReset = fn; }

// Drop every NetBird-derived in-memory cache so the next read re-pulls fresh from the
// Management API. Used by setNbApiConfig and the manual "Refresh" button. The registered hook
// also clears db.js's peers/users caches, matching the original resetNbCaches exactly.
function resetNbCaches() {
    bustNbCaches('gref', 'groups', 'policies', 'usage');
    bustReverseProxyCache(); // proxy status (auth/ACL badges) must not survive a manual refresh
    _extraCacheReset();
}

function netbirdApiConfigured() {
    return !!(_nbApi.url && _nbApi.token);
}

// Authenticated POST to the NetBird API → { status, body, raw }
// Global read-only guard. With NETBIRD_READONLY set, the app never writes to the NetBird
// Management API - every create/update/delete is refused here, at the only two HTTP write
// choke points (netbirdPost / non-GET netbirdReq). Reads (netbirdGet) are unaffected. Lets a
// dev instance share a production NetBird tenant without ever provisioning into it.
// The 503 status makes all callers' `status >= 300` checks throw with this message, so a
// blocked write surfaces as a clear error instead of a silent no-op.
const NETBIRD_READONLY = ['true', '1', 'on', 'yes'].includes(String(process.env.NETBIRD_READONLY || '').toLowerCase());
function readOnlyResp() {
    return { status: 503, error: 'NetBird is in read-only mode (NETBIRD_READONLY=true)', raw: 'NetBird is in read-only mode (NETBIRD_READONLY=true)' };
}

// Generic authenticated GET to the NetBird API → parsed JSON (array/object) or null
function netbirdGet(apiPath) {
    if (!netbirdApiConfigured()) return Promise.resolve(null);
    const url = new URL(apiPath, _nbApi.url);
    const auth = tenantAuth(url);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
        const req = transport.get(url.toString(), {
            headers: { 'Authorization': `Token ${auth}`, 'Accept': 'application/json' },
            timeout: 10000,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) noteNetbirdOk();
                    resolve(j);
                } catch (e) {
                    // A non-JSON body on a FAILED status is not a parse problem - e.g. a plain-text
                    // "404 page not found" on a route this API base doesn't serve. Log those by status.
                    if (res.statusCode >= 200 && res.statusCode < 300) console.error('[NetBird GET %s] parse error:', apiPath, e.message);
                    else console.error('[NetBird GET %s] HTTP %s (non-JSON body)', apiPath, res.statusCode);
                    resolve(null);
                }
            });
        });
        req.on('error', (err) => { console.error('[NetBird GET %s] error:', apiPath, err.message); resolve(null); });
        req.on('timeout', () => { console.error(`[NetBird GET ${apiPath}] timeout`); req.destroy(); resolve(null); });
    });
}

function netbirdPost(apiPath, bodyObj) {
    if (NETBIRD_READONLY) return Promise.resolve(readOnlyResp());
    if (!netbirdApiConfigured()) return Promise.resolve({ status: 0, error: 'NetBird API not configured' });
    const url = new URL(apiPath, _nbApi.url);
    const auth = tenantAuth(url);
    const body = JSON.stringify(bodyObj);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
        const req = transport.request(url, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${auth}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 15000,
        }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { } if (res.statusCode >= 200 && res.statusCode < 300) noteNetbirdOk(); resolve({ status: res.statusCode, body: j, raw: d }); });
        });
        req.on('error', e => resolve({ status: 0, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
        req.write(body);
        req.end();
    });
}

// Authenticated PUT (thin wrapper over netbirdReq) - a named companion to netbirdPost for the
// update call sites (notifications channels, etc.); same read-only guard + result shape.
function netbirdPut(apiPath, bodyObj) { return netbirdReq('PUT', apiPath, bodyObj); }

// Authenticated PUT / DELETE to the NetBird API
function netbirdReq(method, apiPath, bodyObj) {
    if (NETBIRD_READONLY && String(method).toUpperCase() !== 'GET') return Promise.resolve(readOnlyResp());
    if (!netbirdApiConfigured()) return Promise.resolve({ status: 0, error: 'NetBird API not configured' });
    const url = new URL(apiPath, _nbApi.url);
    const auth = tenantAuth(url);
    const body = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { 'Authorization': `Token ${auth}`, 'Accept': 'application/json' };
    if (body !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    return new Promise((resolve) => {
        const req = transport.request(url, { method, headers, timeout: 15000 }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { } if (res.statusCode >= 200 && res.statusCode < 300) noteNetbirdOk(); resolve({ status: res.statusCode, body: j, raw: d }); });
        });
        req.on('error', e => resolve({ status: 0, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
        if (body !== null) req.write(body);
        req.end();
    });
}

// In-memory caches for groups (id→name) and policies (id→{name,enabled})
const NB_TTL_MS = 10 * 60 * 1000;
let _groupsMap = {}, _groupsAt = 0, _groupsRefreshing = null;
let _policiesMap = {}, _policiesAt = 0, _policiesRefreshing = null;

function ensureGroupsFresh() {
    if (!netbirdApiConfigured()) return Promise.resolve();
    // Tenant context: fill the tenant's own slot, never the main-account map.
    if (currentTenantAccount()) {
        const s = tenantSlot();
        if (s.groupsAt && Date.now() - s.groupsAt < TENANT_TTL_MS) return Promise.resolve();
        return (async () => {
            const groups = await netbirdGet('/api/groups');
            if (Array.isArray(groups)) {
                const m = {};
                for (const g of groups) if (g && g.id) m[g.id] = g.name || g.id;
                s.groupsMap = m; s.groupsAt = Date.now();
            }
        })().catch(e => console.error('[Groups] tenant refresh error:', e.message));
    }
    if (Date.now() - _groupsAt < NB_TTL_MS && Object.keys(_groupsMap).length) return Promise.resolve();
    if (_groupsRefreshing) return _groupsRefreshing;
    _groupsRefreshing = (async () => {
        const groups = await netbirdGet('/api/groups');
        if (Array.isArray(groups)) {
            const m = {};
            for (const g of groups) if (g && g.id) m[g.id] = g.name || g.id;
            _groupsMap = m; _groupsAt = Date.now();
        }
    })().catch(e => console.error('[Groups] refresh error:', e.message)).finally(() => { _groupsRefreshing = null; });
    return _groupsRefreshing;
}

function ensurePoliciesFresh() {
    if (!netbirdApiConfigured()) return Promise.resolve();
    // Tenant context: fill the tenant's own slot, never the main-account map.
    if (currentTenantAccount()) {
        const s = tenantSlot();
        if (s.policiesAt && Date.now() - s.policiesAt < TENANT_TTL_MS) return Promise.resolve();
        return (async () => {
            const pols = await netbirdGet('/api/policies');
            if (Array.isArray(pols)) { s.policiesMap = mapPolicies(pols); s.policiesAt = Date.now(); }
        })().catch(e => console.error('[Policies] tenant refresh error:', e.message));
    }
    if (Date.now() - _policiesAt < NB_TTL_MS && Object.keys(_policiesMap).length) return Promise.resolve();
    if (_policiesRefreshing) return _policiesRefreshing;
    _policiesRefreshing = (async () => {
        const pols = await netbirdGet('/api/policies');
        if (Array.isArray(pols)) { _policiesMap = mapPolicies(pols); _policiesAt = Date.now(); }
    })().catch(e => console.error('[Policies] refresh error:', e.message)).finally(() => { _policiesRefreshing = null; });
    return _policiesRefreshing;
}

// Raw /api/policies list → the id-keyed cache shape (shared by main + tenant refreshes).
function mapPolicies(pols) {
    const m = {};
    for (const p of pols) {
        if (!p || !p.id) continue;
        m[p.id] = {
            name: p.name || p.id,
            enabled: !!p.enabled,
            description: p.description || '',
            rules: (Array.isArray(p.rules) ? p.rules : []).map(rule => ({
                action: rule.action || 'accept',
                protocol: rule.protocol || 'all',
                ports: Array.isArray(rule.ports) ? rule.ports : [],
                bidirectional: !!rule.bidirectional,
                enabled: rule.enabled !== false,
                sources: Array.isArray(rule.sources) ? rule.sources.map(s => (s && s.name) ? s.name : s).filter(Boolean) : [],
                destinations: Array.isArray(rule.destinations) ? rule.destinations.map(s => (s && s.name) ? s.name : s).filter(Boolean) : [],
            })),
        };
    }
    return m;
}

// Live views of the id-keyed maps for db.js read sites. The maps are reassigned on every refresh,
// so callers must go through these getters rather than capture a binding that goes stale.
function getGroupsMap() { return currentTenantAccount() ? (tenantSlot().groupsMap || {}) : _groupsMap; }
function getPoliciesMap() { return currentTenantAccount() ? (tenantSlot().policiesMap || {}) : _policiesMap; }

// Cached map id → { id, name, peers_count, resources_count } for resolving policy
// source/destination groups (so the UI can link to each group + show its counts).
let _grefMap = {}, _grefAt = 0, _grefRefreshing = null;
function mapGroupRefs(groups) {
    const m = {};
    if (Array.isArray(groups)) for (const g of groups) {
        if (!g || !g.id) continue;
        const peers = Array.isArray(g.peers) ? g.peers.length : (g.peers_count || 0);
        const resources = Array.isArray(g.resources) ? g.resources.length : (g.resources_count || 0);
        m[g.id] = { id: g.id, name: g.name || g.id, peers_count: peers, resources_count: resources };
    }
    return m;
}
function getGroupRefMap() {
    if (!netbirdApiConfigured()) return Promise.resolve({});
    // Tenant context: per-tenant slot, never the main-account map.
    if (currentTenantAccount()) {
        const s = tenantSlot();
        if (s.grefMap && Date.now() - (s.grefAt || 0) < TENANT_TTL_MS) return Promise.resolve(s.grefMap);
        return (async () => {
            const groups = await netbirdGet('/api/groups');
            s.grefMap = mapGroupRefs(groups); s.grefAt = Date.now();
            return s.grefMap;
        })().catch(e => { console.error('[Groups] tenant ref-map error:', e.message); return s.grefMap || {}; });
    }
    if (Object.keys(_grefMap).length && Date.now() - _grefAt < NB_TTL_MS) return Promise.resolve(_grefMap);
    if (_grefRefreshing) return _grefRefreshing;
    _grefRefreshing = (async () => {
        const groups = await netbirdGet('/api/groups');
        _grefMap = mapGroupRefs(groups); _grefAt = Date.now();
        return _grefMap;
    })().catch(e => { console.error('[Groups] ref-map error:', e.message); return _grefMap; }).finally(() => { _grefRefreshing = null; });
    return _grefRefreshing;
}

// ─── Group usage (policies / routes / DNS / setup-keys / resources) ───
// NetBird has no per-group usage endpoint, so the dashboard cross-references the
// global lists. We do the same and cache the datasets briefly (admin pages reload
// often). Each list degrades to [] when its endpoint is missing/unavailable.
const USAGE_TTL_MS = 60 * 1000;
let _usage = { at: 0, data: null, refreshing: null };

function emptyUsage() {
    return { policies: [], routes: [], nameservers: [], zones: [], setupKeys: [], resources: [], networks: [] };
}

async function fetchUsageData() {
    const [policies, routes, nameservers, zones, setupKeys, resources, networks] = await Promise.all([
        netbirdGet('/api/policies'),
        netbirdGet('/api/routes'),
        netbirdGet('/api/dns/nameservers'),
        netbirdGet('/api/dns/zones'),
        netbirdGet('/api/setup-keys'),
        netbirdGet('/api/networks/resources'),
        netbirdGet('/api/networks'),
    ]);
    const arr = v => (Array.isArray(v) ? v : []);
    return {
        policies: arr(policies), routes: arr(routes), nameservers: arr(nameservers),
        zones: arr(zones), setupKeys: arr(setupKeys), resources: arr(resources), networks: arr(networks),
    };
}

// Cached usage datasets; coalesces concurrent callers into one refresh.
function getUsageData() {
    if (!netbirdApiConfigured()) return Promise.resolve(emptyUsage());
    // Tenant context: per-tenant slot, never the main-account cache.
    if (currentTenantAccount()) {
        const s = tenantSlot();
        if (s.usage && Date.now() - (s.usageAt || 0) < TENANT_TTL_MS) return Promise.resolve(s.usage);
        return fetchUsageData()
            .then(d => { s.usage = d; s.usageAt = Date.now(); return d; })
            .catch(e => { console.error('[Groups] tenant usage fetch error:', e.message); return s.usage || emptyUsage(); });
    }
    if (_usage.data && Date.now() - _usage.at < USAGE_TTL_MS) return Promise.resolve(_usage.data);
    if (_usage.refreshing) return _usage.refreshing;
    _usage.refreshing = fetchUsageData()
        .then(d => { _usage.data = d; _usage.at = Date.now(); return d; })
        .catch(e => { console.error('[Groups] usage fetch error:', e.message); return _usage.data || emptyUsage(); })
        .finally(() => { _usage.refreshing = null; });
    return _usage.refreshing;
}

// ─── Reverse proxy (NetBird Cloud ingress) status ───
// Cloud-only endpoints - the same ones the official dashboard uses. On self-hosted deployments
// they don't exist, so `available: false` and the UI simply hides the card. Cached ~60s.
let _rproxy = { at: 0, data: null };
// Creating/changing services must invalidate the 60s status cache immediately - the cache
// of the ACTIVE context (tenant slot in tenant mode, else the main cache).
function bustReverseProxyCache() {
    if (currentTenantAccount()) {
        const s = tenantSlot();
        s.rproxy = null; s.rproxyAt = 0;
        return;
    }
    _rproxy = { at: 0, data: null };
}
async function getReverseProxyStatus() {
    if (!netbirdApiConfigured()) return { available: false, clusters: [], services: [] };
    // Tenant context: per-tenant slot - the main cache must NEVER answer for a tenant
    // (each tenant has its own Cloud ingress; serving main data here was a real bug).
    const tenantCtx = !!currentTenantAccount();
    if (tenantCtx) {
        const s = tenantSlot();
        if (s.rproxy && Date.now() - (s.rproxyAt || 0) < TENANT_TTL_MS) return s.rproxy;
    } else if (_rproxy.data && Date.now() - _rproxy.at < 60_000) {
        return _rproxy.data;
    }
    const [clusters, services] = await Promise.all([
        netbirdGet('/api/reverse-proxies/clusters'),
        netbirdGet('/api/reverse-proxies/services'),
    ]);
    const available = Array.isArray(clusters);
    const svc = Array.isArray(services) ? services : [];
    // Name lookups for targets (a target usually points at a network resource) and for the
    // auth hover cards (distribution / access group names). Cached upstream, cheap here.
    const gmap = available ? await getGroupRefMap().catch(() => ({})) : {};
    const usage = available ? await getUsageData().catch(() => ({ resources: [] })) : { resources: [] };
    const resById = new Map((usage.resources || []).map(r => [r.id, r]));
    const gname = id => (gmap[id] && gmap[id].name) || id;
    const data = {
        available,
        clusters: (Array.isArray(clusters) ? clusters : []).map(c => ({
            id: c.id || c.address,
            address: c.address || '',
            type: c.type || '',
            online: !!c.online,
            connectedProxies: c.connected_proxies || 0,
            private: !!c.private,
            services: svc.filter(s => s.proxy_cluster === c.address).length,
        })),
        services: svc.map(s => {
            const auth = s.auth || {};
            const ar = s.access_restrictions || {};
            const targets = Array.isArray(s.targets) ? s.targets : [];
            // The Auth & Access hover cards mirror the official dashboard's contents.
            const authMethods = [];
            if (s.private) authMethods.push({ kind: 'netbird', label: 'NetBird-Only Access', groups: (Array.isArray(s.access_groups) ? s.access_groups : []).map(gname) });
            if (auth.bearer_auth && auth.bearer_auth.enabled) authMethods.push({ kind: 'sso', label: 'SSO (Single Sign On)', groups: (Array.isArray(auth.bearer_auth.distribution_groups) ? auth.bearer_auth.distribution_groups : []).map(gname) });
            if (auth.password_auth && auth.password_auth.enabled) authMethods.push({ kind: 'password', label: 'Password' });
            if (auth.pin_auth && auth.pin_auth.enabled) authMethods.push({ kind: 'pin', label: 'PIN Code' });
            if (auth.link_auth && auth.link_auth.enabled) authMethods.push({ kind: 'link', label: 'Magic Link' });
            const headerCount = (Array.isArray(auth.header_auths) ? auth.header_auths : []).filter(h => h && h.enabled).length;
            if (headerCount) authMethods.push({ kind: 'headers', label: 'HTTP Headers', headers: headerCount });
            const aclRules = [];
            const stripHost = a => String(a).replace(/\/32$/, '');
            const cidrLabel = (arr, prefix) => {
                const hosts = arr.filter(a => /\/32$/.test(a)), cidrs = arr.filter(a => !/\/32$/.test(a));
                if (hosts.length) aclRules.push({ label: `${prefix} IP${hosts.length === 1 ? '' : 's'}`, allow: prefix === 'Allowed', value: hosts.map(stripHost).join(', ') });
                if (cidrs.length) aclRules.push({ label: `${prefix} CIDR${cidrs.length === 1 ? '' : 's'}`, allow: prefix === 'Allowed', value: cidrs.join(', ') });
            };
            if (Array.isArray(ar.allowed_countries) && ar.allowed_countries.length) aclRules.push({ label: 'Allowed Countries', allow: true, value: ar.allowed_countries.join(', ') });
            if (Array.isArray(ar.blocked_countries) && ar.blocked_countries.length) aclRules.push({ label: 'Blocked Countries', allow: false, value: ar.blocked_countries.join(', ') });
            cidrLabel(Array.isArray(ar.allowed_cidrs) ? ar.allowed_cidrs : [], 'Allowed');
            cidrLabel(Array.isArray(ar.blocked_cidrs) ? ar.blocked_cidrs : [], 'Blocked');
            if (ar.crowdsec_mode && ar.crowdsec_mode !== 'off') aclRules.push({ label: 'CrowdSec', allow: true, value: ar.crowdsec_mode === 'enforce' ? 'Enforce' : 'Observe' });
            return {
                id: s.id, name: s.name || s.domain || s.id,
                domain: s.domain || '',
                enabled: s.enabled !== false,
                status: (s.meta && s.meta.status) || '',
                cluster: s.proxy_cluster || '',
                mode: s.mode || '',
                listenPort: s.listen_port || 0,
                targets: targets.length,
                // Full target rows for the expandable Targets sub-table (official dashboard
                // layout: Resource / Location / Destination / Active). target_id → resource name.
                targetsDetail: targets.map(t => {
                    if (!t) return null;
                    const res = t.target_id ? resById.get(t.target_id) : null;
                    const port = Number(t.port) || 0;
                    const proto = String(t.protocol || 'http').toLowerCase();
                    const dest = t.destination || `${proto}://${t.host || ''}${port && port !== 80 && port !== 443 ? ':' + port : ''}`;
                    return {
                        name: (res && res.name) || t.host || dest,
                        sub: (res && res.address) || '',
                        path: t.path || '/',
                        destination: dest,
                        enabled: t.enabled !== false,
                        // Per-path access override (NetBird v0.81+); absent = the service's auth.
                        ...(t.access_action && t.access_action !== 'inherit' ? { accessAction: t.access_action } : {}),
                    };
                }).filter(Boolean),
                targetList: targets.map(t => t && (t.destination || [t.host, t.port].filter(Boolean).join(':'))).filter(Boolean),
                authMethods, aclRules,
                authCount: authMethods.length,
                aclCount: ['allowed_cidrs', 'blocked_cidrs', 'allowed_countries', 'blocked_countries'].reduce((n, k) => n + (Array.isArray(ar[k]) ? ar[k].length : 0), 0)
                    + ((ar.crowdsec_mode && ar.crowdsec_mode !== 'off') ? 1 : 0),
            };
        }),
    };
    if (tenantCtx) {
        const s = tenantSlot();
        s.rproxy = data; s.rproxyAt = Date.now();
    } else {
        _rproxy = { at: Date.now(), data };
    }
    return data;
}

// ─── MSP (Managed Service Provider) status ───
// Cloud-only: GET /api/integrations/msp answers with the MSP object when the MAIN account
// is an activated MSP parent (non-empty activated_at). Self-hosted / non-MSP accounts get
// an error body → { available: false } and the whole Tenants feature stays hidden.
// Cached 5 minutes; always about the main account (never called in tenant context).
let _msp = { at: 0, data: null };
function bustMspCache() { _msp = { at: 0, data: null }; }
async function getMspStatus() {
    if (!netbirdApiConfigured()) return { available: false };
    if (_msp.data && Date.now() - _msp.at < 5 * 60_000) return _msp.data;
    const raw = await netbirdGet('/api/integrations/msp');
    const active = !!(raw && typeof raw === 'object' && !Array.isArray(raw) && raw.activated_at);
    const data = active
        ? { available: true, name: raw.name || '', domain: raw.domain || '', status: raw.status || '' }
        : { available: false };
    _msp = { at: Date.now(), data };
    return data;
}

// Peers with an active EDR compliance bypass. NetBird does NOT reflect this on the peer
// object itself - the official dashboard reads a separate endpoint (/api/peers/edr/bypassed,
// a list of { peer_id }). Refreshed together with the peers cache; unavailable endpoint
// (self-hosted / no EDR) → empty set, so nothing shows as bypassed.
let _bypassedPeerIds = new Set();
async function refreshBypassedPeers() {
    const list = await netbirdGet('/api/peers/edr/bypassed');
    _bypassedPeerIds = new Set(
        (Array.isArray(list) ? list : []).map(x => (x && (x.peer_id || x.id)) || (typeof x === 'string' ? x : '')).filter(Boolean),
    );
}
function peerIsBypassed(peerId, raw) {
    return !!(raw && raw.force_approved) || _bypassedPeerIds.has(peerId);
}
// Count of bypassed peers, for the System Health page (the set itself is module-private).
function getBypassedPeerCount() { return _bypassedPeerIds.size; }

module.exports = {
    _nbApi,
    loadNbApi, getNbApiConfig, setNbApiConfig, netbirdApiConfigured,
    NETBIRD_READONLY, readOnlyResp,
    netbirdGet, netbirdPost, netbirdPut, netbirdReq,
    bustNbCaches, resetNbCaches, setCacheResetHook,
    ensureGroupsFresh, ensurePoliciesFresh, getGroupsMap, getPoliciesMap,
    getGroupRefMap, getUsageData, getReverseProxyStatus, bustReverseProxyCache,
    refreshBypassedPeers, peerIsBypassed, getBypassedPeerCount,
    runWithTenant, currentTenantAccount, getMspStatus, bustMspCache,
    loadTenantTokens, setTenantTokenInMemory, hasTenantToken,
    getMspProvisioningToken, setMspProvisioningTokenInMemory,
};
