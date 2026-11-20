// A launch link that adds a missing server (POST /api/v1/remote-access/launch, createResource: true):
//   - off by default; a strict boolean; its own key scope, checked before anything else;
//   - public IPv4 addresses only (a name only when every answer is public), never one on the
//     blocklist; a target NetBird already covers is not created again;
//   - one row per attempt, reserved under a lock: a limit, one create per address at a time; the
//     key is checked again right before the write; the outcome (created, failed, unknown) is
//     recorded, and a refusal after the create says so (resourceCreated);
//   - the leader's sync adopts an unconfirmed create only by its marker and exact fields, deletes a
//     created resource (only the resource) once its hold has ended, and keeps one that changed;
//   - no gateway-reach check (public servers only); the network for created resources is managed
//     by this code alone: every other app write to its resources is refused (db.js); policies are
//     not guarded.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ─── Stubs, before db.js and lib/remote-access.js destructure them ───
const core = require('../lib/core');
const settings = {};
let settingsFail = false;
core.getSetting = async (k) => { if (settingsFail) throw new Error('db down'); return settings[k] ?? null; };
core.setSetting = async (k, v) => { settings[k] = v; };

const audits = [];
let failAuditAction = null;
const keyRows = new Map();
let created = [];      // ra_created_resources
let sessionRows = [];  // remote_sessions
let blockRows = [];    // address_blocklist
let onSessionsQuery = null; // (resourceId) => runs when the delete asks for session rows
const holdTable = require('./helpers/hold-table').holdTable();
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const rowOut = (r) => ({ ...r, created_at: new Date(r.created_at), updated_at: new Date(r.updated_at) });

function dbQuery(sql, params = [], tx = null) {
    const s = sql.trim();
    const all = () => [...created, ...(tx ? tx.rows : [])];
    if (s.startsWith('INSERT INTO app_audit')) {
        if (failAuditAction && failAuditAction === params[3]) throw new Error('audit down');
        const a = { actor: params[2], actorId: params[0], action: params[3], target: params[4], meta: params[5] ? JSON.parse(params[5]) : null };
        if (tx) tx.audits.push(a); else audits.push(a);
        return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM api_keys WHERE id')) return { rows: keyRows.has(params[0]) ? [clone(keyRows.get(params[0]))] : [] };
    // app_settings, as the settings stub keeps them.
    if (/^SELECT value FROM app_settings WHERE key = \$1/.test(s)) return { rows: settings[params[0]] != null ? [{ value: settings[params[0]] }] : [] };
    if (s.startsWith('INSERT INTO app_settings')) {
        let value = params[0];
        if (/jsonb_build_object\('createResources'/.test(s) && settings.remote_access_config) {
            const cur = JSON.parse(settings.remote_access_config);
            value = JSON.stringify({ ...JSON.parse(params[0]), createResources: cur.createResources ?? JSON.parse(params[0]).createResources });
        }
        settings.remote_access_config = value;
        return { rows: [{ value }], rowCount: 1 };
    }
    if (/^SELECT 1 FROM remote_access_targets WHERE resource_id = \$1 AND expires_at > NOW\(\)/.test(s)) {
        const h = holdTable.rows.get(params[0]);
        return { rows: h && new Date(h.expires_at).getTime() > Date.now() ? [{ x: 1 }] : [] };
    }
    if (/remote_access_targets/.test(s) && !/ra_created_resources/.test(s)) return holdTable.query(sql, params);
    if (/FROM address_blocklist/.test(s)) return { rows: clone(blockRows) };
    if (s.startsWith('INSERT INTO remote_sessions')) { sessionRows.push({ id: params[0], resource_id: params[8] }); return { rows: [], rowCount: 1 }; }
    if (s.startsWith('DELETE FROM remote_sessions')) { sessionRows = sessionRows.filter(r => r.id !== params[0]); return { rows: [], rowCount: 1 }; }
    if (/^SELECT 1 FROM remote_sessions WHERE resource_id = \$1/.test(s)) {
        if (onSessionsQuery) onSessionsQuery(params[0]);
        return { rows: sessionRows.filter(r => r.resource_id === params[0]).slice(0, 1) };
    }
    if (/remote_sessions/.test(s) && !/ra_created_resources/.test(s)) return { rows: [] };
    if (!/ra_created_resources/.test(s)) return { rows: [] };
    // ra_created_resources
    if (s.startsWith('SELECT COUNT(*)')) {
        let list = all().filter(r => params[0].includes(r.state));
        if (/network_id <> \$2/.test(s)) list = list.filter(r => r.network_id !== params[1]);
        return { rows: [{ n: list.length }] };
    }
    if (/WHERE ip = \$1 AND state = ANY\(\$2\)/.test(s)) {
        return { rows: all().filter(r => r.ip === params[0] && params[1].includes(r.state)).sort((a, b) => b.created_at - a.created_at).map(rowOut) };
    }
    if (/^SELECT attempt_id, state, network_id, group_id FROM ra_created_resources$/.test(s)) return { rows: all().map(rowOut) };
    if (s.startsWith('INSERT INTO ra_created_resources') && /ON CONFLICT \(attempt_id\) DO NOTHING/.test(s)) {
        const cols = /\(([^)]*)\) VALUES/.exec(s)[1].split(',').map(c => c.trim());
        const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
        if (created.some(r => r.attempt_id === row.attempt_id)) return { rows: [], rowCount: 0 };
        created.push({ ...row, created_at: row.created_at ? new Date(row.created_at).getTime() : Date.now(), updated_at: Date.now(), pending_audit: row.pending_audit ? JSON.parse(row.pending_audit) : null });
        return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO ra_created_resources')) {
        const [attempt_id, ip, name, network_id, group_id, key_id, expected_name, expected_address, expected_description] = params;
        const row = { attempt_id, ip, name, network_id, group_id, key_id, state: 'creating', resource_id: '', expected_name, expected_address, expected_description, reason: '', created_at: Date.now(), updated_at: Date.now(), pending_audit: null };
        if (tx) tx.rows.push(row); else created.push(row);
        return { rows: [], rowCount: 1 };
    }
    if (/^SELECT 1 FROM ra_created_resources WHERE resource_id = \$1/.test(s)) return { rows: created.filter(r => r.resource_id === params[0] && params[1].includes(r.state)).slice(0, 1).map(() => ({ '?column?': 1 })) };
    if (/^SELECT attempt_id, state, expected_address FROM ra_created_resources WHERE network_id = \$1/.test(s)) return { rows: created.filter(r => r.network_id === params[0] && params[1].includes(r.state)).map(rowOut) };
    if (/^SELECT DISTINCT network_id, group_id FROM ra_created_resources/.test(s)) {
        const seen = new Map();
        for (const r of created.filter(x => params[0].includes(x.state))) seen.set(`${r.network_id}|${r.group_id}`, { network_id: r.network_id, group_id: r.group_id });
        return { rows: [...seen.values()] };
    }
    if (/^SELECT resource_id FROM ra_created_resources/.test(s)) return { rows: created.filter(r => params[0].includes(r.state) && r.resource_id).map(r => ({ resource_id: r.resource_id })) };
    if (/^SELECT pending_audit FROM ra_created_resources WHERE attempt_id = \$1/.test(s)) return { rows: created.filter(r => r.attempt_id === params[0]).map(r => ({ pending_audit: clone(r.pending_audit) })) };
    if (/^SELECT attempt_id FROM ra_created_resources WHERE pending_audit IS NOT NULL/.test(s)) return { rows: created.filter(r => r.pending_audit).map(r => ({ attempt_id: r.attempt_id })) };
    if (/^UPDATE ra_created_resources SET pending_audit = \$2::jsonb WHERE attempt_id = \$1 AND pending_audit = \$3::jsonb/.test(s)) {
        const r = created.find(x => x.attempt_id === params[0] && JSON.stringify(x.pending_audit) === params[2]);
        if (!r) return { rows: [], rowCount: 0 };
        r.pending_audit = params[1] ? JSON.parse(params[1]) : null;
        return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE ra_created_resources .*WHERE resource_id = \$1/s.test(s)) {
        const hit = created.filter(r => r.resource_id === params[0] && ['kept', 'gone'].includes(r.state));
        for (const r of hit) Object.assign(r, { state: 'deleted', reason: 'Deleted by an administrator.', updated_at: Date.now() });
        return { rows: [], rowCount: hit.length };
    }
    if (s.startsWith('UPDATE ra_created_resources SET state = $2')) {
        const [id, state, rid, reason, audit, from] = params;
        const r = created.find(x => x.attempt_id === id && (params.length < 6 || x.state === from));
        if (!r) return { rows: [], rowCount: 0 };
        Object.assign(r, { state, reason, updated_at: Date.now() });
        if (rid) r.resource_id = rid;
        if (audit) r.pending_audit = [...(r.pending_audit || []), ...JSON.parse(audit)];
        return { rows: [], rowCount: 1 };
    }
    if (/WHERE state = 'unknown' OR \(state = 'creating'/.test(s)) {
        const cutoff = Date.now() - params[0] * 1000;
        return { rows: created.filter(r => r.state === 'unknown' || (r.state === 'creating' && r.created_at < cutoff)).map(rowOut) };
    }
    if (/FROM ra_created_resources c/.test(s)) {
        const [hours, limit] = params;
        const now = Date.now();
        const held = (rid) => { const h = holdTable.rows.get(rid); return !!h && new Date(h.expires_at).getTime() > now; };
        return {
            rows: created.filter(r => ['created', 'deleting'].includes(r.state) && r.resource_id && r.created_at < now - hours * 3_600_000
                && !held(r.resource_id) && !sessionRows.some(x => x.resource_id === r.resource_id))
                .sort((a, b) => a.created_at - b.created_at).slice(0, limit).map(rowOut),
        };
    }
    if (/WHERE state = ANY\(\$1\) ORDER BY created_at DESC$/.test(s)) {
        return { rows: created.filter(r => params[0].includes(r.state)).sort((a, b) => b.created_at - a.created_at).map(rowOut) };
    }
    if (/WHERE state = ANY\(\$1\) ORDER BY updated_at DESC LIMIT \$2$/.test(s)) {
        return { rows: created.filter(r => params[0].includes(r.state)).sort((a, b) => b.updated_at - a.updated_at).slice(0, params[1]).map(rowOut) };
    }
    throw new Error('unexpected statement: ' + s.slice(0, 120));
}
core.pool.query = async (sql, params) => {
    if (typeof sql !== 'string') { params = sql.values; sql = sql.text; }
    return dbQuery(sql, params);
};
// Transactions: a transaction-level advisory lock is a queue here; writes land on COMMIT.
let lockTail = Promise.resolve();
let connects = 0;
core.pool.connect = async () => {
    connects++;
    let release = null;
    const tx = { rows: [], audits: [] };
    const unlock = () => { if (release) { release(); release = null; } };
    return {
        async query(sql, params = []) {
            if (typeof sql !== 'string') { params = sql.values; sql = sql.text; }
            const s = sql.trim();
            if (s === 'BEGIN') return { rows: [] };
            if (s.startsWith('SELECT pg_advisory_xact_lock')) {
                const prev = lockTail;
                lockTail = new Promise(r => { release = r; });
                await prev;
                return { rows: [] };
            }
            if (s === 'COMMIT') { created.push(...tx.rows); audits.push(...tx.audits); tx.rows = []; tx.audits = []; unlock(); return { rows: [] }; }
            if (s === 'ROLLBACK') { tx.rows = []; tx.audits = []; unlock(); return { rows: [] }; }
            return dbQuery(sql, params, tx);
        },
        release: unlock,
    };
};

// ─── NetBird ───
const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
const PUBLIC = '8.8.8.9';
function world() {
    return {
        users: [
            { id: 'u1', email: 'alice@example.test', auto_groups: ['g-crm'], is_blocked: false },
            { id: 'u2', email: 'bob@example.test', auto_groups: [], is_blocked: false },
        ],
        peers: [
            { id: 'p-gw', name: 'gw', ip: '100.90.0.2', groups: [{ id: 'g-gw' }, { id: 'g-all' }], connected: true },
            { id: 'p-r', name: 'router', ip: '100.90.0.3', groups: [{ id: 'g-all' }], connected: true },
        ],
        groups: [
            { id: 'g-all', name: 'All' }, { id: 'g-gw', name: 'Browser Gateway' }, { id: 'g-gwt', name: 'Browser Gateway Targets' },
            { id: 'g-crm', name: 'CRM Users' }, { id: 'g-links', name: 'Linked Servers' }, { id: 'g-srv', name: 'Servers' },
        ],
        policies: [
            { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
            { id: 'pol-crm', name: 'CRM Users To Linked Servers', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389', '22'], sources: [{ id: 'g-crm' }], destinations: [{ id: 'g-links' }] }] },
        ],
        resources: [
            { id: 'r-office', name: 'office', type: 'host', address: '10.0.0.5/32', description: '', enabled: true, groups: [{ id: 'g-srv' }] },
            { id: 'r-pub', name: 'public range', type: 'subnet', address: '8.8.4.0/24', description: '', enabled: true, groups: [{ id: 'g-srv' }] },
        ],
        networks: [{ id: 'n-office', name: 'Office', resources: ['r-office', 'r-pub'] }, { id: 'n-links', name: 'Links', resources: [] }],
        routes: [],
    };
}
let w = world();
const posts = []; const writes = []; const reads = [];
let postAnswer = null;   // (body) => an answer instead of creating the resource
let deleteAnswer = null; // (path) => an answer instead of deleting
let onGet = null;        // (path) => runs on every NetBird read through netbirdReq
let failGets = new Set(); // paths whose reads fail (500)
let nextId = 1;
const resourcesIn = (netId) => { const n = w.networks.find(x => x.id === netId); return n ? w.resources.filter(r => n.resources.includes(r.id)) : null; };
function get(p) {
    reads.push(p);
    const map = {
        '/api/users': w.users, '/api/users?service_user=true': [], '/api/peers': w.peers, '/api/groups': w.groups, '/api/policies': w.policies,
        '/api/networks/resources': w.resources, '/api/networks': w.networks, '/api/routes': w.routes,
    };
    if (p in map) return clone(map[p]);
    let m;
    if ((m = /^\/api\/networks\/([^/]+)\/resources$/.exec(p))) return clone(resourcesIn(m[1]));
    if ((m = /^\/api\/networks\/([^/]+)\/resources\/([^/]+)$/.exec(p))) return clone((resourcesIn(m[1]) || []).find(r => r.id === m[2]) || null);
    if ((m = /^\/api\/networks\/([^/]+)\/routers$/.exec(p))) return [{ peer: 'p-r', enabled: true }];
    if ((m = /^\/api\/networks\/([^/]+)$/.exec(p))) return clone(w.networks.find(n => n.id === m[1]) || null);
    if ((m = /^\/api\/policies\/([^/]+)$/.exec(p))) return clone(w.policies.find(x => x.id === m[1]) || null);
    if ((m = /^\/api\/groups\/([^/]+)$/.exec(p))) return clone(w.groups.find(x => x.id === m[1]) || null);
    if ((m = /^\/api\/reverse-proxies\/services\/([^/]+)$/.exec(p))) return clone((w.services || []).find(x => x.id === m[1]) || null);
    return null;
}
nb.netbirdGet = async (p) => get(p);
let reqOpts = [];  // the options each write got ({ method, once, hook })
let reqHook = null; // runs right before a write's beforeSend (something that happens during the wait)
nb.netbirdReq = async (method, p, body, opts = {}) => {
    const m = /^\/api\/networks\/([^/]+)\/resources\/([^/]+)$/.exec(p);
    if (method === 'GET') {
        if (onGet) onGet(p);
        if (failGets.has(p)) return { status: 500, body: null, raw: 'down' };
        const v = get(p);
        return v == null ? { status: 404, body: null } : { status: 200, body: v };
    }
    reqOpts.push({ method, once: !!opts.once, hook: typeof opts.beforeSend === 'function' });
    // The real helper runs beforeSend right before its one send; a throw sends nothing.
    if (reqHook) reqHook(p);
    if (opts.beforeSend) await opts.beforeSend();
    writes.push([method, p, body]);
    if (m && method === 'PUT') {
        const r = w.resources.find(x => x.id === m[2]);
        if (!r) return { status: 404, body: null };
        Object.assign(r, { ...body, groups: (body.groups || []).map(id => ({ id: (id && id.id) || id })) });
        return { status: 200, body: clone(r) };
    }
    if (m && method === 'DELETE') {
        const a = deleteAnswer && deleteAnswer(p);
        if (a) return a;
        if (!w.resources.some(x => x.id === m[2])) return { status: 404, body: null };
        w.resources = w.resources.filter(x => x.id !== m[2]);
        for (const n of w.networks) n.resources = n.resources.filter(x => x !== m[2]);
        return { status: 200, body: {} };
    }
    return { status: 200, body: {} };
};
let postOpts = []; // the options each POST got ({ once, beforeSend })
nb.netbirdPost = async (p, body, opts = {}) => {
    postOpts.push({ once: !!opts.once, hook: typeof opts.beforeSend === 'function' });
    // The real helper runs beforeSend right before its one send; a throw sends nothing.
    if (opts.beforeSend) await opts.beforeSend();
    posts.push([p, clone(body)]);
    const a = postAnswer && postAnswer(body);
    if (a) return a;
    const m = /^\/api\/networks\/([^/]+)\/resources$/.exec(p);
    if (!m) return { status: 200, body: { id: `pol-${nextId++}` } };
    const r = { id: `res-${nextId++}`, type: 'host', name: body.name, address: body.address, description: body.description, enabled: body.enabled !== false, groups: (body.groups || []).map(id => ({ id, name: (w.groups.find(g => g.id === id) || {}).name })) };
    w.resources.push(r);
    w.networks.find(n => n.id === m[1]).resources.push(r.id);
    return { status: 201, body: clone(r) };
};
let inventoryFails = false;
nb.getUsageData = async ({ strict } = {}) => {
    if (strict && inventoryFails) throw new Error("Couldn't read the resources and routes from NetBird");
    return { resources: clone(w.resources), routes: clone(w.routes), networks: clone(w.networks) };
};
const events = require('../lib/events');
events.addEvent = async () => { };

const db = require('../db');
const ra = require('../lib/remote-access');

// ─── Fixtures ───
const PASSWORD = crypto.randomBytes(12).toString('base64url');
const SCOPES = ['remote-access:launch', 'remote-access:create-resource'];
const KEY = { id: 7, name: 'Customer File', scopes: SCOPES };
const alice = { user_id: 'u1', email: 'alice@example.test', name: 'Alice', oid: 'oid-1', authEnabled: true };
const rdp = (extra = {}) => ({ protocol: 'rdp', address: PUBLIC, port: 3389, username: 'admin', password: PASSWORD, createResource: true, ...extra });
let dnsAnswers = {}; // name -> list, or an Error to throw
const CFG = { enabled: true, networks: ['n-office', 'n-links'], guacdHost: '127.0.0.1', createResources: { enabled: true, networkId: 'n-links', groupId: 'g-links', max: 50 } };
const cfgOf = (extra = {}) => ({ ...CFG, ...extra, createResources: { ...CFG.createResources, ...(extra.createResources || {}) } });
// This instance's copy and the stored settings (which the create path and the sync read).
const setConfig = (extra = {}) => { ra._internal.setConfigForTest(cfgOf(extra)); settings.remote_access_config = JSON.stringify(cfgOf(extra)); };
const rowFor = (ip) => created.find(r => r.ip === ip);
const resourceAt = (ip) => w.resources.find(r => r.address === `${ip}/32`);
const HOUR = 3_600_000;

test.beforeEach(() => {
    w = world();
    created = []; sessionRows = []; blockRows = []; onSessionsQuery = null; holdTable.rows.clear();
    posts.length = 0; writes.length = 0; reads.length = 0; audits.length = 0;
    postAnswer = null; deleteAnswer = null; onGet = null; failGets = new Set(); postOpts = []; reqOpts = []; reqHook = null; failAuditAction = null; inventoryFails = false; dnsAnswers = {};
    keyRows.set(7, { id: 7, name: 'Customer File', scopes: SCOPES, revoked_at: null, expires_at: null });
    setConfig();
    ra._internal.setManagedForTest({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw' });
    ra._internal.resetSettlingForTest();
    ra._internal.clearRefusals();
    ra._internal.invalidateSnapshot();
    ra._internal.setSleepForTest(async () => { });
    ra.setRemoteAccessDeps({
        createClientResource: db.createClientResource, isLeader: () => true,
        resolve4: async (name) => { const a = dnsAnswers[name]; if (a instanceof Error) throw a; if (!a) { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e; } return a; },
    });
});
test.after(() => ra.closeAllSessions('test over'));

const rejects = (p, code, check = () => true) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return check(e) !== false; });

// ─── The request ───
test('off by default, and while off nothing is created', async () => {
    assert.equal(ra._internal.normConfig({}).createResources.enabled, false);
    assert.deepEqual(ra._internal.normConfig({}).createResources, { enabled: false, networkId: '', groupId: '', max: 50 });
    setConfig({ createResources: { enabled: false } });
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_DISABLED');
    // A network that is no longer open to Remote Access: the setting is not usable.
    setConfig({ networks: ['n-office'] });
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_DISABLED');
    assert.equal(posts.length, 0);
    assert.equal(connects, 0, 'no reservation either');
});

test('createResource is a strict boolean with its own scope, checked before anything else', async () => {
    for (const v of ['true', 1, null, {}]) await rejects(ra.issueLaunch(KEY, rdp({ createResource: v })), 'INVALID_FIELD');
    const launchOnly = { id: 7, name: 'Customer File', scopes: ['remote-access:launch'] };
    // Before any other check: even with Remote Access off.
    ra._internal.setConfigForTest({ ...CFG, enabled: false });
    await rejects(ra.issueLaunch(launchOnly, rdp()), 'SCOPE_MISSING', (e) => e.status === 403);
    setConfig();
    await rejects(ra.issueLaunch(launchOnly, rdp()), 'SCOPE_MISSING');
    // false (or absent) is today's behavior: no create, no `resource` in the answer.
    const out = await ra.issueLaunch(launchOnly, rdp({ createResource: false, address: '10.0.0.5' }));
    assert.ok(out.ticket);
    assert.equal(out.resource, undefined);
    assert.equal(posts.length, 0);
});

test('only public addresses: a non-public IP, a name with any non-public answer, a missing name', async () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1']) {
        await rejects(ra.issueLaunch(KEY, rdp({ address: ip })), 'ADDRESS_NOT_PUBLIC', (e) => e.status === 403);
    }
    // Never a target at all (loopback, peers, multicast...): the launch goes on as today and the
    // usual checks refuse it; nothing is created.
    for (const ip of ['100.90.0.9', '127.0.0.1', '169.254.1.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '0.1.2.3']) {
        assert.deepEqual((await ra.issueLaunch(KEY, rdp({ address: ip }))).resource, { created: false, address: ip });
    }
    for (const ip of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].map(p => p.split('/')[0])) {
        assert.equal(ra._internal.isPublicIpv4(ip, new Set()), false, ip);
    }
    assert.equal(ra._internal.isPublicIpv4('255.255.255.255', new Set()), false);
    assert.equal(ra._internal.isPublicIpv4('8.8.8.8', new Set(['8.8.8.8'])), false, "a gateway peer's own address");
    assert.equal(ra._internal.isPublicIpv4('8.8.8.8', new Set()), true);
    dnsAnswers['mixed.example.com'] = ['8.8.8.10', '10.0.0.9'];
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'mixed.example.com' })), 'NAME_NOT_PUBLIC');
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'nothing.example.com' })), 'NAME_NOT_FOUND');
    dnsAnswers['slow.example.com'] = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'slow.example.com' })), 'NAME_LOOKUP_FAILED');
    assert.equal(posts.length, 0);
    assert.equal(created.length, 0);
});

test('the blocklist applies to the address and to the name, with no override', async () => {
    blockRows = [{ id: 1, value: '8.8.8.0/24', note: '', scope: 'all', networks: [], enforce: false, enabled: true, mode: 'exact', max_prefix: null }];
    await rejects(ra.issueLaunch(KEY, rdp()), 'ADDRESS_BLOCKED');
    blockRows = [{ id: 2, value: 'crm-host.example.com', note: '', scope: 'all', networks: [], enforce: false, enabled: true, mode: 'exact', max_prefix: null }];
    dnsAnswers['crm-host.example.com'] = ['9.9.9.9'];
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'crm-host.example.com' })), 'ADDRESS_BLOCKED');
    assert.equal(posts.length, 0);
});

test('a target NetBird already covers is not created: the link follows the normal flow', async () => {
    const out = await ra.issueLaunch(KEY, rdp({ address: '8.8.4.4' }));
    assert.deepEqual(out.resource, { created: false, address: '8.8.4.4' });
    // An enabled legacy route covers it too; a default route doesn't.
    w.routes = [{ id: 'rt', enabled: true, network: '9.9.0.0/16', groups: [] }];
    assert.equal((await ra.issueLaunch(KEY, rdp({ address: '9.9.1.1' }))).resource.created, false);
    w.routes = [{ id: 'rt0', enabled: true, network: '0.0.0.0/0', groups: [] }];
    assert.equal((await ra.issueLaunch(KEY, rdp({ address: '9.9.1.2' }))).resource.created, true);
    assert.equal(posts.length, 1);
    // A strict read that fails: nothing is created.
    inventoryFails = true;
    await rejects(ra.issueLaunch(KEY, rdp({ address: '9.9.1.3' })), 'SNAPSHOT_FAILED');
    assert.equal(posts.length, 1);
});

test('a created resource: one host resource in the group, no policy, recorded and audited', async () => {
    const out = await ra.issueLaunch(KEY, rdp({ user: 'alice@example.test' }));
    const res = resourceAt(PUBLIC);
    assert.ok(res, 'created in NetBird');
    assert.deepEqual(out.resource, { created: true, id: res.id, address: PUBLIC });
    assert.equal(posts.length, 1, 'the resource only: no policy');
    const [path, body] = posts[0];
    assert.equal(path, '/api/networks/n-links/resources');
    assert.equal(body.address, `${PUBLIC}/32`);
    assert.deepEqual(body.groups, ['g-links']);
    const row = rowFor(PUBLIC);
    assert.equal(row.state, 'created');
    assert.equal(row.resource_id, res.id);
    assert.match(body.description, new RegExp(`\\(${row.attempt_id}\\)$`));
    assert.deepEqual(audits.filter(a => a.action.startsWith('resource.')).map(a => a.action), ['resource.create_intent', 'resource.create']);
    assert.ok(audits.some(a => a.action === 'remote_access.launch_issue'));
    assert.ok(!JSON.stringify(audits).includes(PASSWORD));
});

test('the limit counts every active row', async () => {
    setConfig({ createResources: { max: 1 } });
    created.push({ attempt_id: 'a0', ip: '9.9.9.1', name: '', network_id: 'n-links', group_id: 'g-links', state: 'created', resource_id: 'res-x', expected_name: '9.9.9.1', expected_address: '9.9.9.1/32', expected_description: 'x', reason: '', created_at: Date.now(), updated_at: Date.now() });
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_LIMIT', (e) => e.status === 409 && e.resourceCreated === undefined);
    created[0].state = 'deleted';
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, true);
});

test('concurrent requests for one address create it once', async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => ra.issueLaunch(KEY, rdp())));
    assert.equal(posts.length, 1, 'one create');
    assert.equal(created.length, 1, 'one row');
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    assert.equal(ok.filter(o => o.resource.created).length, 1);
    for (const r of results.filter(x => x.status === 'rejected')) assert.equal(r.reason.code, 'CREATE_IN_PROGRESS');
    // Once it exists, the next request uses it.
    const again = await ra.issueLaunch(KEY, rdp());
    assert.equal(again.resource.created, false);
    assert.equal(posts.length, 1);
});

test('a key revoked (or without the scope) right before the write: nothing is sent', async () => {
    keyRows.get(7).revoked_at = new Date();
    await rejects(ra.issueLaunch(KEY, rdp()), 'KEY_REVOKED', (e) => e.resourceCreated === undefined);
    assert.equal(posts.length, 0);
    assert.equal(rowFor(PUBLIC).state, 'failed');
    keyRows.set(7, { id: 7, name: 'Customer File', scopes: ['remote-access:launch'], revoked_at: null, expires_at: null });
    await rejects(ra.issueLaunch(KEY, rdp()), 'KEY_REVOKED');
    assert.equal(posts.length, 0);
});

test('a reservation whose audit record fails leaves no row and sends nothing', async () => {
    failAuditAction = 'resource.create_intent';
    await rejects(ra.issueLaunch(KEY, rdp()), 'UNAVAILABLE');
    assert.equal(created.length, 0);
    assert.equal(posts.length, 0);
});

test('outcomes: no answer is unknown; a missing group is unknown; a refusal is failed, without NetBird\'s text', async () => {
    postAnswer = () => ({ status: 0, error: 'timeout' });
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_UNCONFIRMED', (e) => e.resourceCreated === 'unknown' && e.status === 502);
    assert.equal(rowFor(PUBLIC).state, 'unknown');
    // While a create for this address is unconfirmed, no new one.
    postAnswer = null;
    ra._internal.resetSettlingForTest();
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_UNCONFIRMED', (e) => e.resourceCreated === undefined && e.status === 503);
    assert.equal(posts.length, 1);

    // NetBird answered with a resource without the group.
    postAnswer = (body) => ({ status: 201, body: { id: 'res-nogroup', type: 'host', name: body.name, address: body.address, description: body.description, enabled: true, groups: [] } });
    await rejects(ra.issueLaunch(KEY, rdp({ address: '9.9.9.2' })), 'CREATE_UNCONFIRMED', (e) => e.resourceCreated === true);
    assert.equal(rowFor('9.9.9.2').state, 'unknown');
    assert.equal(rowFor('9.9.9.2').resource_id, 'res-nogroup');

    const RAW = crypto.randomBytes(8).toString('hex');
    postAnswer = () => ({ status: 400, body: { message: RAW }, raw: RAW });
    await rejects(ra.issueLaunch(KEY, rdp({ address: '9.9.9.3' })), 'RESOURCE_CREATE_FAILED', (e) => e.resourceCreated === undefined && !e.message.includes(RAW));
    assert.equal(rowFor('9.9.9.3').state, 'failed');
    assert.ok(audits.some(a => a.action === 'resource.create_failed'));
    assert.ok(audits.some(a => a.action === 'resource.create_unconfirmed'));
});

test('a refusal after the create says so, and the resource stays (NO_ACCESS)', async () => {
    await rejects(ra.issueLaunch(KEY, rdp({ user: 'bob@example.test' })), 'NO_ACCESS', (e) => e.resourceCreated === true && e.status === 403);
    assert.ok(resourceAt(PUBLIC), 'the resource stays');
    assert.equal(rowFor(PUBLIC).state, 'created');
    // A user who isn't there is refused before anything is created.
    await rejects(ra.issueLaunch(KEY, rdp({ address: '9.9.9.4', user: 'nobody@example.test' })), 'USER_NOT_FOUND', (e) => e.resourceCreated === undefined);
    assert.equal(rowFor('9.9.9.4'), undefined);
});

test('a host name: created for its public IP, and the link connects to that IP', async () => {
    dnsAnswers['crm-host.example.com'] = [PUBLIC, '8.8.8.10'];
    const out = await ra.issueLaunch(KEY, rdp({ address: 'crm-host.example.com', user: 'alice@example.test' }));
    assert.deepEqual(out.resource, { created: true, id: resourceAt(PUBLIC).id, address: PUBLIC });
    assert.equal(resourceAt(PUBLIC).name, `crm-host.example.com (${PUBLIC})`);
    assert.equal(w.resources.filter(r => /^8\.8\.8\./.test(r.address)).length, 1, 'only the first answer');
    const session = await ra.redeemLaunch(alice, { ticket: out.ticket }, '198.51.100.20');
    assert.equal(session.address, PUBLIC);
    assert.equal(session.resource.id, resourceAt(PUBLIC).id);
    ra.endSession(alice, session.sessionId);
});

// ─── The leader's sync ───
function seed(ip, { state = 'created', ageHours = 11, resource = true, extra = {} } = {}) {
    const attempt = crypto.randomUUID();
    const row = {
        attempt_id: attempt, account: '', ip, name: '', network_id: 'n-links', group_id: 'g-links', key_id: 7, state, resource_id: '',
        expected_name: ip, expected_address: `${ip}/32`, expected_description: `Created by a Remote Access link (${attempt})`, reason: '',
        created_at: Date.now() - ageHours * HOUR, updated_at: Date.now() - ageHours * HOUR,
    };
    if (resource) {
        const r = { id: `res-${nextId++}`, type: 'host', name: ip, address: `${ip}/32`, description: row.expected_description, enabled: true, groups: [{ id: 'g-links' }], ...extra };
        w.resources.push(r);
        w.networks.find(n => n.id === 'n-links').resources.push(r.id);
        if (state !== 'unknown' && state !== 'creating') row.resource_id = r.id;
    }
    created.push(row);
    return row;
}
const deletesSent = () => writes.filter(([m]) => m === 'DELETE').map(([, p]) => p);

test('an unconfirmed create is adopted only by its marker and exact fields; none after 10 minutes is failed', async () => {
    const good = seed('9.9.8.1', { state: 'unknown', ageHours: 0.05 });
    const young = seed('9.9.8.2', { state: 'unknown', ageHours: 0.05, resource: false });
    const old = seed('9.9.8.3', { state: 'unknown', ageHours: 1, resource: false });
    // An administrator's resource at the same address, without the marker: never adopted.
    w.resources.push({ id: 'r-admin', type: 'host', name: '9.9.8.3', address: '9.9.8.3/32', description: 'mine', enabled: true, groups: [{ id: 'g-links' }] });
    w.networks.find(n => n.id === 'n-links').resources.push('r-admin');
    // The marker, but changed since: not adopted either.
    const changed = seed('9.9.8.4', { state: 'unknown', ageHours: 1, extra: { name: 'renamed' } });
    // A crash left one in 'creating' long ago.
    const crashed = seed('9.9.8.5', { state: 'creating', ageHours: 1 });
    const out = await ra.maintainCreatedResources();
    assert.equal(good.state, 'created');
    assert.equal(good.resource_id, resourceAt('9.9.8.1').id);
    assert.equal(young.state, 'unknown', 'still within 10 minutes');
    assert.equal(old.state, 'failed');
    assert.equal(old.resource_id, '', 'the administrator resource was not adopted');
    assert.equal(changed.state, 'kept', 'the marker, but not as asked: shown, never deleted');
    assert.equal(changed.resource_id, resourceAt('9.9.8.4').id);
    assert.equal(crashed.state, 'created');
    assert.equal(out.recovered, 2);
    assert.equal(deletesSent().length, 0, 'recovery deletes nothing');
});

test('deletion: only once the hold has ended, no session uses it, and it is older than the hold time', async () => {
    const held = seed('9.9.7.1');
    await holdTable.query(`INSERT INTO remote_access_targets (resource_id, network_id, address, added_at, expires_at, updated_at) VALUES ($1, $2, $3, NULL, $4, NOW()) ON CONFLICT (resource_id) DO UPDATE SET x`, [held.resource_id, 'n-links', '9.9.7.1/32', new Date(Date.now() + HOUR)]);
    const inSession = seed('9.9.7.2');
    sessionRows.push({ id: 's1', resource_id: inSession.resource_id });
    const young = seed('9.9.7.3', { ageHours: 2 });
    const expired = seed('9.9.7.4');
    await holdTable.query(`INSERT INTO remote_access_targets (resource_id, network_id, address, added_at, expires_at, updated_at) VALUES ($1, $2, $3, NULL, $4, NOW()) ON CONFLICT (resource_id) DO UPDATE SET x`, [expired.resource_id, 'n-links', '9.9.7.4/32', new Date(Date.now() - HOUR)]);
    const free = seed('9.9.7.5');
    const rid = free.resource_id;
    const out = await ra.maintainCreatedResources();
    assert.deepEqual(deletesSent().sort(), [`/api/networks/n-links/resources/${expired.resource_id}`, `/api/networks/n-links/resources/${rid}`].sort());
    assert.equal(out.deleted, 2);
    for (const r of [held, inSession, young]) assert.equal(r.state, 'created');
    assert.equal(free.state, 'deleted');
    // Only the resource: the group and the policy to it stay, nothing else was written.
    assert.equal(writes.length, 2);
    assert.ok(w.groups.some(g => g.id === 'g-links'));
    assert.ok(w.policies.some(p => p.id === 'pol-crm'));
    const del = audits.find(a => a.action === 'resource.delete' && a.meta.resourceId === rid);
    assert.equal(del.actor, 'Remote Access');
    assert.equal(del.meta.reason, 'created by a launch link, hold ended');
});

test('a created resource that changed, or that a policy uses, is kept; one already gone is marked gone', async () => {
    const renamed = seed('9.9.6.1', { extra: { name: 'Renamed By Admin' } });
    const moreGroups = seed('9.9.6.2', { extra: { groups: [{ id: 'g-links' }, { id: 'g-srv' }] } });
    const disabled = seed('9.9.6.3', { extra: { enabled: false } });
    const inTarget = seed('9.9.6.4', { extra: { groups: [{ id: 'g-links' }, { id: 'g-gwt' }] } }); // the target group doesn't count
    const used = seed('9.9.6.5');
    w.policies.push({ id: 'pol-direct', name: 'Direct', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-crm' }], destinationResource: { id: used.resource_id, type: 'host' } }] });
    const gone = seed('9.9.6.6');
    w.resources = w.resources.filter(r => r.id !== gone.resource_id);
    await ra.maintainCreatedResources();
    for (const r of [renamed, moreGroups, disabled, used]) assert.equal(r.state, 'kept', r.ip);
    assert.match(used.reason, /Direct/);
    assert.equal(inTarget.state, 'deleted');
    assert.equal(gone.state, 'gone');
    assert.deepEqual(deletesSent(), [`/api/networks/n-links/resources/${inTarget.resource_id}`]);
    assert.equal(audits.filter(a => a.action === 'resource.kept').length, 4);
    // Kept is audited once: the next run does nothing more.
    audits.length = 0;
    await ra.maintainCreatedResources();
    assert.equal(audits.filter(a => a.action === 'resource.kept').length, 0);
    // The list shows what is still there.
    const list = await ra.listCreatedResources();
    assert.deepEqual(list.items.map(i => i.state).sort(), ['deleted', 'gone', 'kept', 'kept', 'kept', 'kept']);
    assert.equal(list.finishedMore, false);
});

test('a delete without a clear answer stays deleting and is read again by the next run; a 4xx refusal is kept', async () => {
    const row = seed('9.9.5.1');
    deleteAnswer = () => ({ status: 0, error: 'timeout' });
    await ra.maintainCreatedResources();
    assert.equal(row.state, 'deleting');
    assert.ok(resourceAt('9.9.5.1'), 'still there');
    ra._internal.resetSettlingForTest();
    // The next run: still there and unchanged, deleted again.
    deleteAnswer = null;
    await ra.maintainCreatedResources();
    assert.equal(row.state, 'deleted');
    // Gone by the time of the next run: deleted.
    const row2 = seed('9.9.5.2');
    row2.state = 'deleting';
    w.resources = w.resources.filter(r => r.id !== row2.resource_id);
    await ra.maintainCreatedResources();
    assert.equal(row2.state, 'deleted');
    const row3 = seed('9.9.5.3');
    deleteAnswer = () => ({ status: 422, body: { message: 'in use' } });
    await ra.maintainCreatedResources();
    assert.equal(row3.state, 'kept');
    assert.match(row3.reason, /422/);
});

test('only the leader deletes; a read-only instance or a tenant context never runs it', async () => {
    const row = seed('9.9.4.1');
    ra.setRemoteAccessDeps({ isLeader: () => false });
    assert.equal(await ra.maintainCreatedResources(), null);
    assert.equal(row.state, 'created');
    assert.equal(deletesSent().length, 0);
    ra.setRemoteAccessDeps({ isLeader: () => true });
    assert.equal(await nb.runWithTenant('tenant-a', () => ra.maintainCreatedResources()), null);
    assert.equal(deletesSent().length, 0);
});

// ─── The gateway check ───
test('the network for created resources cannot change while servers added by links are still in it', async () => {
    seed('9.9.3.1');
    await rejects(ra.setRemoteAccessConfig({ ...CFG, createResources: { ...CFG.createResources, networkId: 'n-office' } }), 'CREATED_RESOURCES_EXIST', (e) => e.notSaved && e.status === 409);
    assert.equal(ra.getRemoteAccessConfig().createResources.networkId, 'n-links');
});

// ─── The guard on the network for created resources ───
const managedError = (e) => e.code === 'NETWORK_MANAGED' && e.status === 409 && /managed automatically/.test(e.message);
test('every app write to the network for created resources is refused, before anything is sent', async () => {
    const r = seed('9.9.2.1', { ageHours: 0 });
    const rid = r.resource_id;
    const sent = () => posts.length + writes.length;
    const calls = [
        () => db.createClientResource('n-links', { name: 'x', address: '9.9.2.2', groups: [], policies: [] }),
        () => db.editResource('n-links', rid, { name: 'x', address: '9.9.2.1/32' }),
        () => db.setResourceEnabled('n-links', rid, false),
        () => db.deleteResource('n-links', rid),
        () => db.deleteNetwork('n-links'),
        () => db.moveResources('n-links', [rid], 'n-office'),
        () => db.moveResources('n-office', ['r-office'], 'n-links'),
        () => db.mergeResources('n-office', ['r-office', rid], 'r-office'),
        () => db.syncResourcePolicies('n-links', rid, []),
        () => db.setResourcePolicy('n-links', rid, 'tcp', ['22']),
        () => db.createTemporaryAccessGrant({ userId: 'u1', durationMinutes: 60, targets: [{ type: 'resource', id: rid, networkId: 'n-links' }] }, { email: 'admin@example.test' }),
        // The network named wrongly: found by the resource id.
        () => db.createTemporaryAccessGrant({ userId: 'u1', durationMinutes: 60, targets: [{ type: 'resource', id: rid, networkId: 'n-office' }] }, { email: 'admin@example.test' }),
        () => db.createTemporaryAccessGrant({ userId: 'u1', durationMinutes: 60, targets: [{ type: 'network', id: 'n-links' }] }, { email: 'admin@example.test' }),
        () => db.createProxyService({ domain: 'app.example.com', cluster: 'c1', targets: [{ type: 'host', id: rid, port: 80 }] }),
        () => db.createProxyService({ domain: 'app.example.com', cluster: 'c1', targets: [{ type: 'container', networkId: 'n-links', containerDomain: 'app.internal', port: 80 }] }, { canEditNetwork: () => true }),
    ];
    for (const [i, call] of calls.entries()) await assert.rejects(call(), managedError, `call ${i}`);
    assert.equal(sent(), 0, 'nothing was written');
    // Reading stays allowed, and the network is labelled.
    assert.equal((await db.getNetworks()).find(n => n.id === 'n-links').managedByLinks, true);
    assert.equal((await db.getNetworks()).find(n => n.id === 'n-office').managedByLinks, false);
    // A policy to another resource is fine.
    await db.createPolicy({ name: 'p', protocol: 'tcp', ports: ['22'], sources: ['g-crm'], destinationResource: { id: 'r-office', type: 'host' } });
    assert.equal(posts.length, 1);
});

test('with no network for created resources the guard reads nothing and refuses nothing', async () => {
    setConfig({ createResources: { enabled: false, networkId: '', groupId: '' } });
    await db.createPolicy({ name: 'p', protocol: 'tcp', ports: ['22'], sources: ['g-crm'], destinationResource: { id: 'r-office', type: 'host' } });
    assert.ok(!reads.some(p => /^\/api\/networks\/[^/]+$/.test(p)), 'no network read for the guard');
    await db.createClientResource('n-links', { name: 'x', address: '9.9.2.9', groups: [], policies: [] });
    assert.ok(w.resources.some(r => r.address === '9.9.2.9'), 'created');
});

// ─── Coverage first, and the stored settings ───
test('a covered target goes the normal way whatever the settings say, also a private one', async () => {
    // Off in the stored settings, on in this instance's copy: a covered private server still works.
    settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { enabled: false } }));
    const before = connects;
    const out = await ra.issueLaunch(KEY, rdp({ address: '10.0.0.5' }));
    assert.deepEqual(out.resource, { created: false, address: '10.0.0.5' });
    // A name that a domain resource covers: no lookup, no create.
    w.resources.push({ id: 'r-dom', name: 'crm', type: 'domain', address: 'crm.example.com', description: '', enabled: true, groups: [{ id: 'g-srv' }] });
    w.networks.find(n => n.id === 'n-office').resources.push('r-dom');
    setConfig();
    assert.deepEqual((await ra.issueLaunch(KEY, rdp({ address: 'crm.example.com' }))).resource, { created: false, address: 'crm.example.com' });
    // A name whose address a resource covers.
    dnsAnswers['range.example.com'] = ['8.8.4.20'];
    assert.equal((await ra.issueLaunch(KEY, rdp({ address: 'range.example.com' }))).resource.created, false);
    assert.equal(posts.length, 0);
    assert.equal(connects, before, 'nothing was reserved');
    // NetBird can't be read and creating is off: the launch goes on as today.
    settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { enabled: false } }));
    inventoryFails = true;
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, false);
});

test('the stored settings decide, not this instance\'s copy', async () => {
    // This instance still thinks it is on; the database says off.
    settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { enabled: false } }));
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_DISABLED');
    assert.equal(posts.length, 0);
    assert.equal(created.length, 0);
    // Turned off between the reservation and the write: nothing is sent, the row is failed.
    setConfig();
    const real = keyRows.get(7);
    let reads = 0;
    keyRows.set(7, new Proxy(real, { get(t, p) { if (p === 'scopes' && ++reads === 2) settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { enabled: false } })); return t[p]; } }));
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_DISABLED');
    assert.equal(posts.length, 0);
    assert.equal(rowFor(PUBLIC).state, 'failed');
    // The sync reads them too: with no network stored and nothing left, it does nothing.
    settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { enabled: false, networkId: '', groupId: '' } }));
    created = [];
    assert.equal(await ra.maintainCreatedResources(), null);
});

// ─── An administrator may delete what the app no longer tracks ───
test('a kept or untracked resource in the managed network can be deleted by an admin; a tracked one cannot', async () => {
    const tracked = seed('9.9.1.1', { ageHours: 0 });
    const kept = seed('9.9.1.2', { ageHours: 0 });
    kept.state = 'kept';
    w.resources.push({ id: 'r-stray', type: 'host', name: 'stray', address: '9.9.1.3/32', description: '', enabled: true, groups: [{ id: 'g-links' }] });
    w.networks.find(n => n.id === 'n-links').resources.push('r-stray');
    const detail = await db.getNetworkDetail('n-links');
    const locked = Object.fromEntries(detail.resources.map(r => [r.id, r.linkLocked]));
    assert.deepEqual(locked, { [tracked.resource_id]: true, [kept.resource_id]: false, 'r-stray': false });

    await assert.rejects(db.deleteResource('n-links', tracked.resource_id, { linkAdminDelete: true }), managedError);
    // Not without the admin route (blocklist enforcement, automations, bulk delete).
    await assert.rejects(db.deleteResource('n-links', kept.resource_id), managedError);
    assert.equal(deletesSent().length, 0);
    await db.deleteResource('n-links', kept.resource_id, { linkAdminDelete: true });
    await db.deleteResource('n-links', 'r-stray', { linkAdminDelete: true });
    assert.deepEqual(deletesSent().sort(), [`/api/networks/n-links/resources/${kept.resource_id}`, '/api/networks/n-links/resources/r-stray'].sort());
    assert.equal(kept.state, 'deleted');
    // Only the resources: the feature's group and the policy to it stay.
    assert.ok(!writes.some(([m, p]) => m === 'DELETE' && /\/api\/(groups|policies)\//.test(p)));
    // Still no edit.
    await assert.rejects(db.setResourceEnabled('n-links', tracked.resource_id, false), managedError);
});

// ─── Review round 1 ───
test('C1: a link created for a host name keeps the name for the SSH host key and dials the IP', async () => {
    const hostKey = 'ssh-ed25519 ' + crypto.randomBytes(32).toString('base64');
    setConfig({ sshHostKeys: { 'crm-ssh.example.com': hostKey } });
    dnsAnswers['crm-ssh.example.com'] = [PUBLIC];
    const out = await ra.issueLaunch(KEY, { protocol: 'ssh', address: 'crm-ssh.example.com', port: 22, username: 'ops', password: PASSWORD, createResource: true, user: 'alice@example.test' });
    assert.equal(out.resource.created, true);
    const session = await ra.redeemLaunch(alice, { ticket: out.ticket }, '198.51.100.20');
    assert.equal(session.address, PUBLIC, 'dials the IP');
    assert.equal(session.name, 'crm-ssh.example.com', 'keeps the name');
    const args = ra._internal.connectArgs({ protocol: 'ssh', address: session.address, targetName: session.name, port: 22, creds: { username: 'ops' }, timezone: '', gateway: 'ip' }, ['hostname', 'host-key']);
    assert.deepEqual(args, [PUBLIC, hostKey]);
    ra.endSession(alice, session.sessionId);
});

test('C2: a session that writes a hold between selection and the lock keeps its resource', async () => {
    const row = seed('9.9.0.1');
    onGet = (p) => {
        if (p === `/api/networks/n-links/resources/${row.resource_id}` && !holdTable.rows.has(row.resource_id)) {
            holdTable.rows.set(row.resource_id, { resource_id: row.resource_id, network_id: 'n-links', address: '9.9.0.1/32', added_at: null, expires_at: new Date(Date.now() + HOUR), updated_at: new Date() });
        }
    };
    await ra.maintainCreatedResources();
    assert.equal(deletesSent().length, 0);
    assert.equal(row.state, 'created');
    // A session row written meanwhile counts too.
    holdTable.rows.clear();
    onGet = (p) => { if (p.endsWith(row.resource_id) && !sessionRows.length) sessionRows.push({ id: 's9', resource_id: row.resource_id }); };
    await ra.maintainCreatedResources();
    assert.equal(deletesSent().length, 0);
    assert.equal(row.state, 'created');
});

test('C3: the guard follows the stored settings, not this instance\'s copy', async () => {
    // Stored: n-office; this instance still thinks n-links.
    settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { networkId: 'n-office' } }));
    await assert.rejects(db.setResourceEnabled('n-office', 'r-office', false), managedError);
    await db.createClientResource('n-links', { name: 'x', address: '9.9.3.9', groups: [], policies: [] });
    assert.ok(w.resources.some(r => r.address === '9.9.3.9'));
    assert.equal((await db.getNetworks()).find(n => n.id === 'n-office').managedByLinks, true);
    settingsFail = true;
    try {
        // A settings read that fails: the last known network is still protected, others are not blocked.
        await assert.rejects(db.setResourceEnabled('n-office', 'r-office', false), managedError);
        await db.createClientResource('n-links', { name: 'y', address: '9.9.3.8', groups: [], policies: [] });
        assert.ok(w.resources.some(r => r.address === '9.9.3.8'));
    } finally { settingsFail = false; }
});

test('C3: an import or restore never turns creating on, and keeps the stored network and group while rows exist', async () => {
    const imported = async (cr) => { assert.equal(await ra.writeImportedRemoteAccessConfig(JSON.stringify({ enabled: true, networks: ['n-office'], createResources: cr })), true); return JSON.parse(settings.remote_access_config).createResources; };
    assert.deepEqual(await imported({ enabled: true, networkId: 'n-office', groupId: 'g-x', max: 9 }), { enabled: false, networkId: 'n-office', groupId: 'g-x', max: 9 });
    setConfig();
    seed('9.9.3.1');
    assert.deepEqual(await imported({ enabled: true, networkId: 'n-office', groupId: 'g-x', max: 9 }), { enabled: false, networkId: 'n-links', groupId: 'g-links', max: 9 });
    assert.equal(await ra.writeImportedRemoteAccessConfig('not json'), false);
    // The plaintext settings export never carries the table.
    const exp = await db.exportAppSettings();
    assert.equal((exp.tables || {}).ra_created_resources, undefined);
});

test('C4: a Reverse Proxy target is checked as the request builder sends it', async () => {
    const rid = seed('9.9.4.5', { ageHours: 0 }).resource_id;
    const svc = (t) => db.createProxyService({ domain: 'app.example.com', cluster: 'c1', targets: [{ port: 80, ...t }] });
    // target_type wins over type, and the id is trimmed.
    await assert.rejects(svc({ target_type: 'host', type: 'peer', id: ` ${rid} ` }), managedError);
    await assert.rejects(svc({ type: 'host', target_id: rid }), managedError);
    assert.equal(posts.length, 0);
});

test('C6: every entry of the IANA special-purpose registry (and multicast) is refused', () => {
    // Written out from https://www.iana.org/assignments/iana-ipv4-special-registry/ (first and last
    // address of each block), independently of the code's list.
    const registry = [
        ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'], ['100.64.0.0', '100.127.255.255'], ['127.0.0.0', '127.255.255.255'],
        ['169.254.0.0', '169.254.255.255'], ['172.16.0.0', '172.31.255.255'], ['192.0.0.0', '192.0.0.255'], ['192.0.0.8', '192.0.0.8'],
        ['192.0.0.9', '192.0.0.9'], ['192.0.0.10', '192.0.0.10'], ['192.0.0.170', '192.0.0.171'], ['192.0.2.0', '192.0.2.255'],
        ['192.31.196.0', '192.31.196.255'], ['192.52.193.0', '192.52.193.255'], ['192.88.99.0', '192.88.99.255'], ['192.88.99.2', '192.88.99.2'],
        ['192.168.0.0', '192.168.255.255'], ['192.175.48.0', '192.175.48.255'], ['198.18.0.0', '198.19.255.255'], ['198.51.100.0', '198.51.100.255'],
        ['203.0.113.0', '203.0.113.255'], ['240.0.0.0', '255.255.255.255'], ['255.255.255.255', '255.255.255.255'],
        ['224.0.0.0', '239.255.255.255'], // multicast (its own registry)
    ];
    for (const [first, last] of registry) for (const ip of [first, last]) assert.equal(ra._internal.isPublicIpv4(ip, new Set()), false, ip);
    // Right outside the blocks: public.
    for (const ip of ['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.31.195.255', '192.31.197.0',
        '192.52.192.255', '192.52.194.0', '192.88.98.255', '192.88.100.0', '192.175.47.255', '192.175.49.0', '198.17.255.255', '198.20.0.0', '223.255.255.255']) {
        assert.equal(ra._internal.isPublicIpv4(ip, new Set()), true, ip);
    }
});

test('C7: blocklist names match in the same form as the target (case, trailing dot, IDN)', async () => {
    const entry = (value) => ({ id: 1, value, note: '', scope: 'all', networks: [], enforce: false, enabled: true, mode: 'block', max_prefix: null });
    blockRows = [entry('CRM-Host.Example.COM.')];
    dnsAnswers['crm-host.example.com'] = ['9.9.9.9'];
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'crm-host.example.com' })), 'ADDRESS_BLOCKED');
    blockRows = [entry('bücher.example.com')];
    dnsAnswers['xn--bcher-kva.example.com'] = ['9.9.9.8'];
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'xn--bcher-kva.example.com' })), 'ADDRESS_BLOCKED');
    assert.equal(posts.length, 0);
});

test('C8: the key and the settings are checked inside the writer, after the wait for the lock', async () => {
    for (const change of [() => { keyRows.get(7).revoked_at = new Date(); }, () => { settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { enabled: false } })); }]) {
        created = []; posts.length = 0; setConfig(); keyRows.get(7).revoked_at = null;
        let release;
        const held = ra.withTargetLock(() => new Promise(r => { release = r; }));
        const p = ra.issueLaunch(KEY, rdp());
        for (let i = 0; i < 2000 && !rowFor(PUBLIC); i++) await new Promise(r => setImmediate(r));
        assert.ok(rowFor(PUBLIC), 'reserved');
        for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)); // the writer is waiting for the lock now
        change();
        release();
        await held;
        await assert.rejects(p, (e) => ['KEY_REVOKED', 'CREATE_DISABLED'].includes(e.code) && e.resourceCreated === undefined);
        assert.equal(posts.length, 0, 'nothing was sent');
        assert.equal(rowFor(PUBLIC).state, 'failed');
    }
});

test('C9: only the admin route deletes an untracked resource there, and only the resource', async () => {
    const kept = seed('9.9.9.1', { ageHours: 0 });
    kept.state = 'kept';
    w.policies.push({ id: 'pol-uses', name: 'Uses', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-crm' }], destinationResource: { id: kept.resource_id, type: 'host' } }] });
    await assert.rejects(db.deleteResource('n-links', kept.resource_id), managedError);
    // NetBird refuses because a policy uses it: the admin gets that answer, and no policy is deleted.
    deleteAnswer = () => ({ status: 422, raw: 'resource is used by a policy' });
    await assert.rejects(db.deleteResource('n-links', kept.resource_id, { linkAdminDelete: true }), (e) => e.status === 422 && /used by a policy/.test(e.message));
    assert.ok(!writes.some(([m, p]) => m === 'DELETE' && p.startsWith('/api/policies/')));
    assert.equal(kept.state, 'kept');
    // The server route passes the admin flag only for admins.
    const src = require('fs').readFileSync(require.resolve('../server'), 'utf8');
    assert.match(src, /deleteResource\(req\.params\.id, req\.params\.rid, \{ linkAdminDelete: !!viewer\.isAdmin \}\)/);
});

test('C10: routing peers in the network stay allowed', async () => {
    // Routing peers in the network stay allowed.
    await db.createNetworkRouter('n-links', { peer: 'p-r', enabled: true });
    assert.ok(posts.some(([p]) => p === '/api/networks/n-links/routers'));
});

test('C11: the row changes first; a failed audit is written by the next sync, once', async () => {
    failAuditAction = 'resource.create';
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, true);
    assert.equal(rowFor(PUBLIC).state, 'created');
    assert.equal(audits.filter(a => a.action === 'resource.create').length, 0);
    assert.equal(rowFor(PUBLIC).pending_audit.length, 1);
    failAuditAction = null;
    await ra.maintainCreatedResources();
    await ra.maintainCreatedResources();
    assert.equal(audits.filter(a => a.action === 'resource.create').length, 1);
    assert.equal(rowFor(PUBLIC).pending_audit, null);
});

test('C13: a name with a public and a loopback answer is not public', async () => {
    dnsAnswers['mixed2.example.com'] = ['8.8.8.30', '127.0.0.1'];
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'mixed2.example.com' })), 'NAME_NOT_PUBLIC');
    assert.equal(posts.length, 0);
});

test('C14: the list shows every active row and the latest 50 finished ones', async () => {
    for (let i = 0; i < 60; i++) seed(`9.8.0.${i}`, { state: 'created', resource: true });
    for (let i = 0; i < 55; i++) { const r = seed(`9.8.1.${i}`, { resource: false }); r.state = 'failed'; r.updated_at = Date.now() - i * 1000; }
    const list = await ra.listCreatedResources();
    assert.equal(list.items.filter(i => i.state === 'created').length, 60);
    assert.equal(list.items.filter(i => i.state === 'failed').length, 50);
    assert.equal(list.finishedMore, true);
});

// ─── Review round 2 ───
test('C15: a session of this instance (also one still opening) keeps its resource from the delete', async () => {
    const row = seed('9.9.10.1');
    ra._internal.addSessionForTest({ id: 'sess-c15', resourceId: row.resource_id, state: 'preparing' });
    try {
        await ra.maintainCreatedResources();
        assert.equal(deletesSent().length, 0);
        assert.equal(row.state, 'created');
    } finally { ra._internal.removeSessionForTest('sess-c15'); }
});

test('C16/C17: the create is sent once with the hook; a 429 is a refusal', async () => {
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, true);
    assert.deepEqual(postOpts[0], { once: true, hook: true });
    postAnswer = () => ({ status: 429, body: { message: 'too many requests' }, raw: 'too many requests' });
    await rejects(ra.issueLaunch(KEY, rdp({ address: '9.9.10.2' })), 'RESOURCE_CREATE_FAILED', (e) => e.resourceCreated === undefined);
    assert.equal(rowFor('9.9.10.2').state, 'failed');
});

test('open point: a save of other fields keeps the stored section as it is', async () => {
    const stored = { enabled: false, networkId: 'n-links', groupId: 'g-links', max: 9 };
    settings.remote_access_config = JSON.stringify(cfgOf({ createResources: stored }));
    await ra.setRemoteAccessConfig({ idleTimeoutMin: 41 }).catch(() => { });
    assert.deepEqual(JSON.parse(settings.remote_access_config).createResources, stored);
    assert.equal(JSON.parse(settings.remote_access_config).idleTimeoutMin, 41);
    assert.deepEqual(ra.getRemoteAccessConfig().createResources, stored);
});

test('C19/C24: the network or group cannot change while rows are active (counted under the lock)', async () => {
    seed('9.9.11.1');
    const before = settings.remote_access_config;
    await rejects(ra.setRemoteAccessConfig({ createResources: { ...CFG.createResources, groupId: 'g-srv' } }), 'CREATED_RESOURCES_EXIST', (e) => e.status === 409 && e.notSaved);
    assert.equal(settings.remote_access_config, before);
    // A launch whose settings changed before its reservation: refused inside the lock, no row.
    created = [];
    onGet = (p) => { if (p === '/api/peers') settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { groupId: 'g-srv' } })); };
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_DISABLED');
    assert.equal(created.length, 0);
});

test('C23: a stored network that does not exist protects nothing and blocks nothing', async () => {
    setConfig({ createResources: { networkId: 'n-gone' } });
    await db.setResourceEnabled('n-office', 'r-office', false);
    await db.createPolicy({ name: 'p', protocol: 'tcp', ports: ['22'], sources: ['g-crm'], destinationResource: { id: 'r-office', type: 'host' } });
    assert.ok(!reads.includes('/api/networks/n-gone'), 'the network is never looked up by id');
});

test('C25: a Reverse Proxy change without targets still checks the targets the service has', async () => {
    const rid = seed('9.9.12.1', { ageHours: 0 }).resource_id;
    w.services = [{ id: 'svc1', name: 'App', domain: 'app.example.com', enabled: true, targets: [{ target_type: 'host', target_id: rid, port: 80, protocol: 'http', enabled: true }] }];
    await assert.rejects(db.updateProxyService('svc1', { name: 'Renamed' }), managedError);
    assert.ok(!writes.some(([m]) => m === 'PUT'));
});

test('C26: the admin delete waits while a create for that address or marker is unresolved', async () => {
    const pending = seed('9.9.13.1', { state: 'unknown', ageHours: 0 });
    const res = resourceAt('9.9.13.1');
    // An untracked resource at the same address (no row has its id).
    await assert.rejects(db.deleteResource('n-links', res.id, { linkAdminDelete: true }), (e) => e.status === 409 && /still finishing/.test(e.message));
    pending.state = 'failed';
    await db.deleteResource('n-links', res.id, { linkAdminDelete: true });
    assert.ok(deletesSent().includes(`/api/networks/n-links/resources/${res.id}`));
});

test('C27: a restore keeps the feature off and follows the restored rows; rows in two networks are refused', async () => {
    assert.match(ra.restoredRowsProblem([{ state: 'created', network_id: 'a', group_id: 'g' }, { state: 'kept', network_id: 'b', group_id: 'g' }]), /another network or group/);
    assert.equal(ra.restoredRowsProblem([{ state: 'created', network_id: 'a', group_id: 'g' }, { state: 'deleted', network_id: 'b', group_id: 'h' }]), '');
    seed('9.9.14.1');
    settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { enabled: true, networkId: 'n-office', groupId: 'g-srv' } }));
    await ra.restoreCreatedRowsForcingOff(null);
    assert.deepEqual(JSON.parse(settings.remote_access_config).createResources, { enabled: false, networkId: 'n-links', groupId: 'g-links', max: 50 });
});

// ─── Review round 3 ───
test('C29: a save of the section changes only the fields it sends', async () => {
    await ra.setRemoteAccessConfig({ createResources: { max: 12 } }).catch(e => { if (e.notSaved) throw e; });
    assert.deepEqual(JSON.parse(settings.remote_access_config).createResources, { enabled: true, networkId: 'n-links', groupId: 'g-links', max: 12 });
});

test('C30: a session that starts while the delete reads the database keeps its resource', async () => {
    const row = seed('9.9.16.1');
    onSessionsQuery = (rid) => { if (rid === row.resource_id) ra._internal.addSessionForTest({ id: 'sess-c30', resourceId: rid, state: 'preparing' }); };
    try {
        await ra.maintainCreatedResources();
        assert.equal(deletesSent().length, 0);
        assert.equal(row.state, 'created');
    } finally { ra._internal.removeSessionForTest('sess-c30'); }
});

test('C34: a restore adds the backup rows by attempt id and never removes the current ones', async () => {
    const current = seed('9.9.17.1');
    const restored = { attempt_id: crypto.randomUUID(), ip: '9.9.17.2', name: '', network_id: 'n-links', group_id: 'g-links', key_id: 7, state: 'created', resource_id: 'res-old',
        expected_name: '9.9.17.2', expected_address: '9.9.17.2/32', expected_description: 'x', reason: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), pending_audit: null };
    settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { enabled: true } }));
    const out = await ra.restoreCreatedRowsForcingOff([{ ...current, created_at: new Date().toISOString(), state: 'deleted' }, restored]);
    assert.deepEqual(out, { added: 1, message: '' });
    // In the same transaction: adding servers is off, and the network and group are the rows'.
    assert.deepEqual(JSON.parse(settings.remote_access_config).createResources, { enabled: false, networkId: 'n-links', groupId: 'g-links', max: 50 });
    assert.equal(rowFor('9.9.17.1').state, 'created', 'the current row is kept as it is');
    assert.ok(rowFor('9.9.17.2'));
    // Rows in another network than the tracked ones: nothing is added.
    const other = await ra.restoreCreatedRowsForcingOff([{ ...restored, attempt_id: crypto.randomUUID(), ip: '9.9.17.3', network_id: 'n-office' }]);
    assert.equal(other.added, 0);
    assert.match(other.message, /another network or group/);
    assert.equal(rowFor('9.9.17.3'), undefined);
});

test('C35: the reservation compares against the maximum stored now', async () => {
    seed('9.9.18.1');
    onGet = (p) => { if (p === '/api/peers') settings.remote_access_config = JSON.stringify(cfgOf({ createResources: { max: 1 } })); };
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_LIMIT');
    assert.equal(posts.length, 0);
});

test('C36: the networks keep the network for created resources while it is on or in use', async () => {
    await rejects(ra.setRemoteAccessConfig({ networks: ['n-office'] }), 'NETWORK_IN_USE', (e) => e.status === 409 && e.notSaved);
    // Off, with a server still there: still refused.
    setConfig({ createResources: { enabled: false } });
    seed('9.9.19.1');
    await rejects(ra.setRemoteAccessConfig({ networks: ['n-office'] }), 'NETWORK_IN_USE');
    // Off and nothing left: allowed.
    created = [];
    await ra.setRemoteAccessConfig({ networks: ['n-office'] }).catch(e => { if (e.notSaved) throw e; });
    assert.deepEqual(JSON.parse(settings.remote_access_config).networks, ['n-office']);
});

// ─── Owner decision: no gateway-reach protection; C42-C44 ───
test('no gateway check: a save, a launch and the sync work while the gateway reaches the group', async () => {
    w.policies.push({ id: 'pol-reach', name: 'Gateway To Linked', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'all', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-links' }] }] });
    await ra.setRemoteAccessConfig({ createResources: { max: 20 } }).catch(e => { if (e.notSaved) throw e; });
    assert.equal(JSON.parse(settings.remote_access_config).createResources.max, 20);
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, true);
    const out = await ra.maintainCreatedResources();
    assert.equal(out.paused, undefined);
    // Policy and Access Profile writes are as on main: no settings read, no refusal.
    reads.length = 0;
    await db.createPolicy({ name: 'Gateway To Linked 2', protocol: 'all', sources: ['g-gw'], destinations: ['g-links'] });
    assert.equal(posts.filter(([p]) => p === '/api/policies').length, 1);
});

test('C42: the automatic delete is sent once; a 429 leaves the row deleting; a new session stops it at the send', async () => {
    const row = seed('9.9.21.1');
    deleteAnswer = () => ({ status: 429, body: { message: 'too many requests' }, raw: 'too many requests' });
    await ra.maintainCreatedResources();
    assert.equal(row.state, 'deleting');
    assert.equal(deletesSent().length, 1, 'one attempt');
    assert.ok(reqOpts.some(o => o.method === 'DELETE' && o.once && o.hook));
    // The hook is the last step: a session that appears there keeps the resource.
    deleteAnswer = null;
    reqHook = () => ra._internal.addSessionForTest({ id: 'sess-c42', resourceId: row.resource_id, state: 'preparing' });
    try {
        await ra.maintainCreatedResources();
        assert.equal(row.state, 'created');
        assert.ok(resourceAt('9.9.21.1'), 'not deleted');
    } finally { ra._internal.removeSessionForTest('sess-c42'); reqHook = null; }
});

test('C44: an import keeps the network for created resources among the networks while rows exist', async () => {
    seed('9.9.22.1');
    assert.equal(await ra.writeImportedRemoteAccessConfig(JSON.stringify({ enabled: true, networks: ['n-office'], createResources: { enabled: true, networkId: 'n-office', groupId: 'g-x' } })), true);
    const saved = JSON.parse(settings.remote_access_config);
    assert.deepEqual(saved.networks, ['n-office', 'n-links']);
    assert.deepEqual(saved.createResources, { enabled: false, networkId: 'n-links', groupId: 'g-links' });
});
