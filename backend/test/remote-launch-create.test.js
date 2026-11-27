// A launch link that adds a missing server (POST /api/v1/remote-access/launch, createResource: true):
// what may be added and recorded, what the leader removes or keeps, and the guard on the network
// that holds these servers (the database and NetBird are in-memory stubs).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ─── Stubs, before db.js and lib/remote-access.js destructure them ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] ?? null;
let failSettings = false;
core.setSetting = async (k, v) => { if (failSettings) throw new Error('db down'); settings[k] = v; };
core.updateSetting = async (k, update) => { if (failSettings) throw new Error('db down'); settings[k] = String(update(settings[k] ?? null)); return settings[k]; };

const audits = [];
let failAuditAction = null;
const keyRows = new Map();
let created = [];      // ra_created_resources
let sessionRows = [];  // remote_sessions
let blockRows = [];    // address_blocklist
let profileRows = [];    // access_profiles
let automationRows = []; // automations (name, network_id)
let liveRows = { recurring: [], grants: [], requests: [] };
let recurringRule = null; // the stored recurring rule #3 (recurring_access)
const PROFILE = { id: 11, name: 'Linked Servers', group_id: 'g-links', policy_id: 'pol-crm', shared: true, tenant: '' };
const holdTable = require('./helpers/hold-table').holdTable();
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const rowOut = (r) => ({ ...r, created_at: new Date(r.created_at), updated_at: new Date(r.updated_at) });

function dbQuery(sql, params = []) {
    const s = sql.trim();
    if (s.startsWith('INSERT INTO app_audit')) {
        if (failAuditAction && failAuditAction === params[3]) throw new Error('audit down');
        const a = { actor: params[2], actorId: params[0], action: params[3], target: params[4], meta: params[5] ? JSON.parse(params[5]) : null };
        audits.push(a);
        return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM api_keys WHERE id')) return { rows: keyRows.has(params[0]) ? [clone(keyRows.get(params[0]))] : [] };
    if (/^SELECT value FROM app_settings WHERE key = \$1/.test(s)) return { rows: settings[params[0]] != null ? [{ value: settings[params[0]] }] : [] };
    if (/^SELECT 1 FROM remote_access_targets WHERE resource_id = \$1 AND expires_at > NOW\(\)\s+UNION ALL/.test(s)) {
        const h = holdTable.rows.get(params[0]);
        const held = h && new Date(h.expires_at).getTime() > Date.now();
        return { rows: held || sessionRows.some(r => r.resource_id === params[0]) ? [{ x: 1 }] : [] };
    }
    if (/remote_access_targets/.test(s) && !/ra_created_resources/.test(s)) return holdTable.query(sql, params);
    if (/FROM address_blocklist/.test(s)) return { rows: clone(blockRows) };
    if (s.startsWith('INSERT INTO remote_sessions')) { sessionRows.push({ id: params[0], resource_id: params[8] }); return { rows: [], rowCount: 1 }; }
    if (s.startsWith('DELETE FROM remote_sessions')) { sessionRows = sessionRows.filter(r => r.id !== params[0]); return { rows: [], rowCount: 1 }; }
    if (/^SELECT DISTINCT resource_id FROM remote_sessions/.test(s)) return { rows: [...new Set(sessionRows.map(r => r.resource_id).filter(Boolean))].map(resource_id => ({ resource_id })) };
    if (/remote_sessions/.test(s) && !/ra_created_resources/.test(s)) return { rows: [] };
    if (/^SELECT id, group_id, policy_id, shared FROM access_profiles WHERE id = \$1 AND tenant = ''/.test(s)) return { rows: clone(profileRows.filter(p => p.id === Number(params[0]) && (p.tenant || '') === '')) };
    if (/^SELECT name, group_id, policy_id FROM access_profiles WHERE shared IS NOT FALSE/.test(s)) return { rows: clone(profileRows.filter(p => p.shared !== false)) };
    if (/^SELECT name FROM automations WHERE tenant = '' AND network_id = \$1/.test(s)) return { rows: clone(automationRows.filter(a => a.network_id === params[0])) };
    if (/^SELECT \* FROM recurring_access WHERE id=\$1/.test(s)) return { rows: recurringRule ? [clone(recurringRule)] : [] };
    if (/^UPDATE recurring_access SET user_id=\$2/.test(s)) {
        if (!recurringRule) return { rows: [] };
        Object.assign(recurringRule, { user_id: params[1], user_label: params[2], targets: JSON.parse(params[4]), enabled: params[9] });
        return { rows: [clone(recurringRule)], rowCount: 1 };
    }
    if (/^SELECT user_id, user_label, targets FROM recurring_access/.test(s)) return { rows: clone(liveRows.recurring) };
    if (/^SELECT user_id, user_label, targets FROM temporary_access_grants/.test(s)) return { rows: clone(liveRows.grants) };
    if (/^SELECT requester_id, requester_name, requester_email, targets, approved_targets FROM access_requests/.test(s)) return { rows: clone(liveRows.requests) };
    if (!/ra_created_resources/.test(s)) return { rows: [] };
    const pick = (states) => created.filter(r => states.includes(r.state));
    const update = (hit, state, reason) => {
        for (const r of hit) Object.assign(r, { state, reason, updated_at: Date.now() });
        return { rows: [], rowCount: hit.length };
    };
    if (s.startsWith('SELECT COUNT(*)')) return { rows: [{ n: pick(params[0]).filter(r => r.network_id !== params[1]).length }] };
    if (/WHERE ip = \$1 AND state = ANY\(\$2\)/.test(s)) return { rows: pick(params[1]).filter(r => r.ip === params[0]).map(rowOut) };
    if (s.startsWith('INSERT INTO ra_created_resources')) {
        const [attempt_id, ip, name, network_id, group_id, key_id, expected_name, expected_address, expected_description] = params;
        if (pick(['creating', 'unknown', 'created']).some(r => r.ip === ip)) return { rows: [], rowCount: 0 };
        created.push({ attempt_id, ip, name, network_id, group_id, key_id, state: 'creating', resource_id: '', expected_name, expected_address, expected_description, reason: '', created_at: Date.now(), updated_at: Date.now() });
        return { rows: [], rowCount: 1 };
    }
    if (/^SELECT DISTINCT network_id FROM ra_created_resources/.test(s)) return { rows: [...new Set(pick(params[0]).map(r => r.network_id))].map(network_id => ({ network_id })) };
    if (/^SELECT resource_id FROM ra_created_resources/.test(s)) return { rows: pick(params[0]).filter(r => r.resource_id).map(r => ({ resource_id: r.resource_id })) };
    if (/^UPDATE ra_created_resources SET state = 'deleted'.*WHERE resource_id = \$1/s.test(s)) return update(pick(params[2]).filter(r => r.resource_id === params[0]), 'deleted', params[1]);
    if (/^UPDATE ra_created_resources SET state = 'deleted'.*WHERE network_id = \$1/s.test(s)) return update(pick(params[2]).filter(r => r.network_id === params[0]), 'deleted', params[1]);
    if (s.startsWith('UPDATE ra_created_resources SET state = $3')) {
        const [id, from, state, rid, reason] = params;
        const hit = created.filter(x => x.attempt_id === id && x.state === from);
        if (rid) for (const r of hit) r.resource_id = rid;
        return update(hit, state, reason);
    }
    if (/WHERE state = ANY\(\$1\) ORDER BY created_at$/.test(s)) return { rows: pick(params[0]).sort((a, b) => a.created_at - b.created_at).map(rowOut) };
    if (/WHERE state = ANY\(\$1\) ORDER BY created_at DESC$/.test(s)) return { rows: pick(params[0]).sort((a, b) => b.created_at - a.created_at).map(rowOut) };
    if (/WHERE state = ANY\(\$1\) ORDER BY updated_at DESC LIMIT \$2$/.test(s)) return { rows: pick(params[0]).sort((a, b) => b.updated_at - a.updated_at).slice(0, params[1]).map(rowOut) };
    throw new Error('unexpected statement: ' + s.slice(0, 120));
}
core.pool.query = async (sql, params) => {
    if (typeof sql !== 'string') { params = sql.values; sql = sql.text; }
    return dbQuery(sql, params);
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
    if ((m = /^\/api\/networks\/([^/]+)\/routers$/.exec(p))) return w.routers && w.routers[m[1]] !== undefined ? clone(w.routers[m[1]]) : [{ peer: 'p-r', enabled: true }];
    if ((m = /^\/api\/networks\/([^/]+)$/.exec(p))) return clone(w.networks.find(n => n.id === m[1]) || null);
    if ((m = /^\/api\/policies\/([^/]+)$/.exec(p))) return clone(w.policies.find(x => x.id === m[1]) || null);
    if ((m = /^\/api\/groups\/([^/]+)$/.exec(p))) return clone(w.groups.find(x => x.id === m[1]) || null);
    if ((m = /^\/api\/reverse-proxies\/services\/([^/]+)$/.exec(p))) return clone((w.services || []).find(x => x.id === m[1]) || null);
    return null;
}
nb.netbirdGet = async (p) => get(p);
let networkDeleteAnswer = null;
let onWriteAnswer = null;
let getAnswerFor = null; // (path) => an answer for that GET through netbirdReq
let onWrite = null; // runs right before a write lands
nb.netbirdReq = async (method, p, body) => {
    const m = /^\/api\/networks\/([^/]+)\/resources\/([^/]+)$/.exec(p);
    if (method === 'GET') {
        if (onGet) onGet(p);
        const ga = getAnswerFor && getAnswerFor(p);
        if (ga) return ga;
        if (failGets.has(p)) return { status: 500, body: null, raw: 'down' };
        const v = get(p);
        return v == null ? { status: 404, body: null } : { status: 200, body: v };
    }
    if (onWrite) onWrite(p);
    writes.push([method, p, body]);
    const wa = method === 'PUT' && onWriteAnswer && onWriteAnswer(p);
    if (wa) return wa;
    if (networkDeleteAnswer && method === 'DELETE' && /^\/api\/networks\/[^/]+$/.test(p)) return networkDeleteAnswer;
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
let postAnswerFor = null; // (path, body) => an answer for that POST
nb.netbirdPost = async (p, body) => {
    posts.push([p, clone(body)]);
    const a = postAnswer && postAnswer(body);
    if (a) return a;
    const pa = postAnswerFor && postAnswerFor(p, body);
    if (pa) return pa;
    if (p === '/api/networks') {
        const n = { id: `net-${nextId++}`, name: body.name, description: body.description, resources: [] };
        w.networks.push(n);
        return { status: 201, body: clone(n) };
    }
    const rm = /^\/api\/networks\/([^/]+)\/routers$/.exec(p);
    if (rm) {
        const r = { id: `rt-${nextId++}`, ...clone(body) };
        w.routers = w.routers || {};
        (w.routers[rm[1]] = w.routers[rm[1]] || []).push(r);
        return { status: 201, body: clone(r) };
    }
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
const CFG = { enabled: true, networks: ['n-office', 'n-links'], guacdHost: '127.0.0.1', createResources: { enabled: true, networkId: 'n-links', profileId: 11, groupId: 'g-links', max: 50 } };
const cfgOf = (extra = {}) => ({ ...CFG, ...extra, createResources: { ...CFG.createResources, ...(extra.createResources || {}) } });
const setConfig = (extra = {}) => { ra._internal.setConfigForTest(cfgOf(extra)); settings.remote_access_config = JSON.stringify(ra._internal.normConfig(cfgOf(extra))); };
const rowFor = (ip) => created.find(r => r.ip === ip);
const resourceAt = (ip) => w.resources.find(r => r.address === `${ip}/32`);
const HOUR = 3_600_000;

test.beforeEach(() => {
    w = world();
    created = []; sessionRows = []; blockRows = []; holdTable.rows.clear();
    profileRows = [clone(PROFILE)]; automationRows = []; liveRows = { recurring: [], grants: [], requests: [] }; postAnswerFor = null; getAnswerFor = null; recurringRule = null;
    posts.length = 0; writes.length = 0; reads.length = 0; audits.length = 0;
    postAnswer = null; deleteAnswer = null; onGet = null; failGets = new Set(); onWrite = null; onWriteAnswer = null; failAuditAction = null; inventoryFails = false; dnsAnswers = {};
    keyRows.set(7, { id: 7, name: 'Customer File', scopes: SCOPES, revoked_at: null, expires_at: null });
    setConfig();
    ra._internal.setManagedForTest({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw' });
    ra._internal.resetSettlingForTest();
    ra._internal.clearRefusals();
    ra._internal.invalidateSnapshot();
    ra._internal.setSleepForTest(async () => { });
    ra.setRemoteAccessDeps({
        createClientResource: db.createClientResource, isLeader: () => true, checkLaunchNetwork: db.checkLaunchNetwork,
        resolve4: async (name) => { const a = dnsAnswers[name]; if (a instanceof Error) throw a; if (!a) { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e; } return a; },
    });
});
test.after(() => ra.closeAllSessions('test over'));

const rejects = (p, code, check = () => true) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return check(e) !== false; });

// ─── The request ───
test('off by default, and while off nothing is created', async () => {
    assert.equal(ra._internal.normConfig({}).createResources.enabled, false);
    assert.deepEqual(ra._internal.normConfig({}).createResources, { enabled: false, networkId: '', profileId: 0, groupId: '', max: 50 });
    setConfig({ createResources: { enabled: false } });
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_DISABLED');
    // A network that is no longer open to Remote Access: the setting is not usable.
    setConfig({ networks: ['n-office'] });
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_DISABLED');
    assert.equal(posts.length, 0);
    assert.equal(created.length, 0, 'no reservation either');
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
        assert.equal(ra._internal.isPublicIpv4(ip), false, ip);
    }
    assert.equal(ra._internal.isPublicIpv4('255.255.255.255'), false);
    assert.equal(ra._internal.isPublicIpv4('8.8.8.8'), true);
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
    const again = await ra.issueLaunch(KEY, rdp());
    assert.equal(again.resource.created, false);
    assert.equal(posts.length, 1);
});

test('a reservation whose audit record fails sends nothing, and its row is failed', async () => {
    failAuditAction = 'resource.create_intent';
    await rejects(ra.issueLaunch(KEY, rdp()), 'UNAVAILABLE');
    assert.equal(rowFor(PUBLIC).state, 'failed');
    assert.equal(posts.length, 0);
    failAuditAction = null;
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, true, 'the address is free again');
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
        expected_name: ip, expected_address: `${ip}/32`, expected_description: `Created by the Remote Access API (${attempt})`, reason: '',
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
    await ra.maintainCreatedResources();
    assert.equal(good.state, 'created');
    assert.equal(good.resource_id, resourceAt('9.9.8.1').id);
    assert.equal(young.state, 'unknown', 'still within 10 minutes');
    assert.equal(old.state, 'failed');
    assert.equal(old.resource_id, '', 'the administrator resource was not adopted');
    assert.equal(changed.state, 'kept', 'the marker, but not as asked: shown, never deleted');
    assert.equal(changed.resource_id, resourceAt('9.9.8.4').id);
    assert.equal(crashed.state, 'created');
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
    await ra.maintainCreatedResources();
    assert.deepEqual(deletesSent().sort(), [`/api/networks/n-links/resources/${expired.resource_id}`, `/api/networks/n-links/resources/${rid}`].sort());
    for (const r of [held, inSession, young]) assert.equal(r.state, 'created');
    assert.equal(free.state, 'deleted');
    // Only the resource: the group and the policy to it stay, nothing else was written.
    assert.equal(writes.length, 2);
    assert.ok(w.groups.some(g => g.id === 'g-links'));
    assert.ok(w.policies.some(p => p.id === 'pol-crm'));
    const del = audits.find(a => a.action === 'resource.delete' && a.meta.resourceId === rid);
    assert.equal(del.actor, 'Remote Access');
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
    const list = await ra.listCreatedResources();
    assert.deepEqual(list.items.map(i => i.state).sort(), ['deleted', 'gone', 'kept', 'kept', 'kept', 'kept']);
    assert.equal(list.finishedMore, false);
});

test('a delete without a clear answer is tried again by the next run; a 4xx refusal is kept', async () => {
    for (const answer of [{ status: 0, error: 'timeout' }, { status: 503, raw: 'down' }, { status: 429, raw: 'too many requests' }]) {
        created = []; w = world(); writes.length = 0; audits.length = 0;
        const row = seed('9.9.5.1');
        deleteAnswer = () => answer;
        await ra.maintainCreatedResources();
        assert.equal(row.state, 'created');
        assert.ok(audits.some(a => a.action === 'resource.delete_unconfirmed' && a.meta.resourceId === row.resource_id));
        ra._internal.resetSettlingForTest();
        deleteAnswer = null;
        await ra.maintainCreatedResources();
        assert.equal(row.state, 'deleted');
    }
    // It did land: gone by the next run.
    const row2 = seed('9.9.5.2');
    deleteAnswer = () => { w.resources = w.resources.filter(r => r.id !== row2.resource_id); return { status: 0, error: 'timeout' }; };
    await ra.maintainCreatedResources();
    deleteAnswer = null;
    await ra.maintainCreatedResources();
    assert.equal(row2.state, 'gone');
    const row3 = seed('9.9.5.3');
    deleteAnswer = () => ({ status: 422, body: { message: 'in use' } });
    await ra.maintainCreatedResources();
    assert.equal(row3.state, 'kept');
    assert.match(row3.reason, /422/);
});

test('servers that are no longer in NetBird are marked gone, kept ones too; an unreadable list changes nothing', async () => {
    const active = seed('9.9.5.10', { ageHours: 1 });
    const kept = seed('9.9.5.11', { ageHours: 1 });
    kept.state = 'kept';
    w.resources = w.resources.filter(r => ![active.resource_id, kept.resource_id].includes(r.id));
    failGets.add('/api/networks/n-links/resources');
    await ra.maintainCreatedResources();
    assert.deepEqual([active.state, kept.state], ['created', 'kept']);
    // A 404 with the network still in NetBird (a proxy while NetBird restarts) is not an empty list.
    failGets = new Set();
    getAnswerFor = (p) => (p === '/api/networks/n-links/resources' ? { status: 404, body: null } : null);
    await ra.maintainCreatedResources();
    assert.deepEqual([active.state, kept.state], ['created', 'kept']);
    getAnswerFor = null;
    await ra.maintainCreatedResources();
    assert.deepEqual([active.state, kept.state], ['gone', 'gone']);
    // A network that was deleted in NetBird.
    const inGone = seed('9.9.5.12', { ageHours: 1 });
    w.networks = w.networks.filter(n => n.id !== 'n-links');
    await ra.maintainCreatedResources();
    assert.equal(inGone.state, 'gone');
});

test('a run deletes at most 20 servers', async () => {
    for (let i = 0; i < 22; i++) seed(`9.9.5.${100 + i}`);
    await ra.maintainCreatedResources();
    assert.equal(deletesSent().length, 20);
    await ra.maintainCreatedResources();
    assert.equal(deletesSent().length, 22);
});

test('a session that opens the server while the delete waits for the target lock keeps it', async () => {
    const row = seed('9.9.0.1');
    onGet = (p) => { if (p.endsWith('/' + row.resource_id) && !sessionRows.length) sessionRows.push({ id: 's9', resource_id: row.resource_id }); };
    await ra.maintainCreatedResources();
    assert.equal(deletesSent().length, 0);
    assert.equal(row.state, 'created');
    // Also one of this instance that is still opening.
    sessionRows = []; onGet = null;
    ra._internal.addSessionForTest({ id: 'sess-1', resourceId: row.resource_id, state: 'preparing' });
    try {
        await ra.maintainCreatedResources();
        assert.equal(deletesSent().length, 0);
    } finally { ra._internal.removeSessionForTest('sess-1'); }
});

test('only the leader deletes; a read-only instance or a tenant context never runs it', async () => {
    const row = seed('9.9.4.1');
    ra.setRemoteAccessDeps({ isLeader: () => false });
    await ra.maintainCreatedResources();
    assert.equal(row.state, 'created');
    assert.equal(deletesSent().length, 0);
    ra.setRemoteAccessDeps({ isLeader: () => true });
    await nb.runWithTenant('tenant-a', () => ra.maintainCreatedResources());
    assert.equal(deletesSent().length, 0);
});

// A second Shared profile, with its own group and an enabled accept policy to it.
const OTHER_PROFILE = { id: 12, name: 'Servers', group_id: 'g-srv', policy_id: 'pol-srv', shared: true, tenant: '' };
const addOtherProfile = () => {
    profileRows.push(clone(OTHER_PROFILE));
    w.policies.push({ id: 'pol-srv', name: 'Servers Access', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-crm' }], destinations: [{ id: 'g-srv', name: 'Servers' }] }] });
};
test('a client never sets the network or the group; the profile cannot change group while servers are in use', async () => {
    seed('9.9.3.1');
    // networkId and groupId sent by a client are ignored (nothing else changed: nothing to save there).
    await ra.setRemoteAccessConfig({ ...CFG, createResources: { ...CFG.createResources, networkId: 'n-office', groupId: 'g-srv' } }).catch(e => { if (e.status) throw e; });
    assert.deepEqual(JSON.parse(settings.remote_access_config).createResources, CFG.createResources);
    // Another profile (another group) while a server is in use: refused.
    addOtherProfile();
    await rejects(ra.setRemoteAccessConfig({ createResources: { profileId: 12 } }), 'CREATED_RESOURCES_EXIST', (e) => e.status === 409);
    assert.equal(ra.getRemoteAccessConfig().createResources.profileId, 11);
});

// ─── The guard on the network for created resources ───
const managedError = (e) => e.code === 'NETWORK_MANAGED' && e.status === 409 && /managed by Remote Access/.test(e.message);
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
        () => db.createTemporaryAccessGrant({ userId: 'u1', durationMinutes: 60, targets: [{ type: 'resource', id: rid, networkId: 'n-links' }] }, { email: 'admin@example.test' }),
        // The network named wrongly: found by the resource id.
        () => db.createTemporaryAccessGrant({ userId: 'u1', durationMinutes: 60, targets: [{ type: 'resource', id: rid, networkId: 'n-office' }] }, { email: 'admin@example.test' }),
        () => db.createTemporaryAccessGrant({ userId: 'u1', durationMinutes: 60, targets: [{ type: 'network', id: 'n-links' }] }, { email: 'admin@example.test' }),
        () => db.createProxyService({ domain: 'app.example.com', cluster: 'c1', targets: [{ type: 'host', id: ` ${rid} `, port: 80 }] }),
        () => db.createProxyService({ domain: 'app.example.com', cluster: 'c1', targets: [{ type: 'host', target_id: rid, port: 80 }] }),
        // Before its routing peer is created.
        () => db.exposeDockerService({ networkId: 'n-links', containerDomain: 'app.internal', routerPeerId: 'p-r', serviceName: 'app', serviceDomain: 'app.example.com', port: 80 }, { canEditNetwork: () => true }),
        () => db.addResourceGroups('n-links', rid, ['g-srv']),
        () => db.createProxyService({ domain: 'app.example.com', cluster: 'c1', targets: [{ type: 'container', networkId: 'n-links', containerDomain: 'app.internal', port: 80 }] }, { canEditNetwork: () => true }),
    ];
    for (const [i, call] of calls.entries()) await assert.rejects(call(), managedError, `call ${i}`);
    assert.equal(sent(), 0, 'nothing was written');
    // Reading stays allowed, and the network is labelled.
    assert.equal((await db.getNetworks()).find(n => n.id === 'n-links').managedByApi, true);
    assert.equal((await db.getNetworks()).find(n => n.id === 'n-office').managedByApi, false);
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

// ─── Covered targets ───
test('a covered target goes the normal way whatever the settings say, also a private one', async () => {
    setConfig({ createResources: { enabled: false } });
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
    assert.equal(created.length, 0, 'nothing was reserved');
    // NetBird can't be read and creating is off: the launch goes on as today.
    setConfig({ createResources: { enabled: false } });
    inventoryFails = true;
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, false);
});

// ─── An administrator's delete ───

test('an admin may delete any resource in the managed network (tracked, kept or untracked); others may not', async () => {
    const tracked = seed('9.9.1.1', { ageHours: 0 });
    const kept = seed('9.9.1.2', { ageHours: 0 });
    kept.state = 'kept';
    w.resources.push({ id: 'r-stray', type: 'host', name: 'stray', address: '9.9.1.3/32', description: '', enabled: true, groups: [{ id: 'g-links' }] });
    w.networks.find(n => n.id === 'n-links').resources.push('r-stray');
    // Not without the admin flag (blocklist enforcement, automations, a non-admin).
    await assert.rejects(db.deleteResource('n-links', kept.resource_id), managedError);
    await assert.rejects(db.deleteResource('n-links', tracked.resource_id), managedError);
    assert.equal(deletesSent().length, 0);
    await db.deleteResource('n-links', tracked.resource_id, { linkAdminDelete: true });
    await db.deleteResource('n-links', kept.resource_id, { linkAdminDelete: true });
    await db.deleteResource('n-links', 'r-stray', { linkAdminDelete: true });
    assert.deepEqual(deletesSent().sort(), [`/api/networks/n-links/resources/${tracked.resource_id}`, `/api/networks/n-links/resources/${kept.resource_id}`, '/api/networks/n-links/resources/r-stray'].sort());
    assert.equal(kept.state, 'deleted');
    assert.equal(tracked.state, 'deleted');
    // Only the resources: the feature's group and the policy to it stay.
    assert.ok(!writes.some(([m, p]) => m === 'DELETE' && /\/api\/(groups|policies)\//.test(p)));
    const other = seed('9.9.1.4', { ageHours: 0 });
    await assert.rejects(db.setResourceEnabled('n-links', other.resource_id, false), managedError);
});

test('a link created for a host name keeps the name for the SSH host key and dials the IP', async () => {
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

test('every entry of the IANA special-purpose registry (and multicast) is refused', () => {
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
    for (const [first, last] of registry) for (const ip of [first, last]) assert.equal(ra._internal.isPublicIpv4(ip), false, ip);
    // Right outside the blocks: public.
    for (const ip of ['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.31.195.255', '192.31.197.0',
        '192.52.192.255', '192.52.194.0', '192.88.98.255', '192.88.100.0', '192.175.47.255', '192.175.49.0', '198.17.255.255', '198.20.0.0', '223.255.255.255']) {
        assert.equal(ra._internal.isPublicIpv4(ip), true, ip);
    }
});

test('blocklist names match in the same form as the target (case, trailing dot, IDN)', async () => {
    const entry = (value) => ({ id: 1, value, note: '', scope: 'all', networks: [], enforce: false, enabled: true, mode: 'block', max_prefix: null });
    blockRows = [entry('CRM-Host.Example.COM.')];
    dnsAnswers['crm-host.example.com'] = ['9.9.9.9'];
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'crm-host.example.com' })), 'ADDRESS_BLOCKED');
    blockRows = [entry('bücher.example.com')];
    dnsAnswers['xn--bcher-kva.example.com'] = ['9.9.9.8'];
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'xn--bcher-kva.example.com' })), 'ADDRESS_BLOCKED');
    assert.equal(posts.length, 0);
});

test('only the admin route deletes an untracked resource there, and only the resource', async () => {
    const kept = seed('9.9.9.1', { ageHours: 0 });
    kept.state = 'kept';
    w.policies.push({ id: 'pol-uses', name: 'Uses', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-crm' }], destinationResource: { id: kept.resource_id, type: 'host' } }] });
    await assert.rejects(db.deleteResource('n-links', kept.resource_id), managedError);
    // NetBird refuses because a policy uses it: the admin gets that answer, and no policy is deleted.
    deleteAnswer = () => ({ status: 422, raw: 'resource is used by a policy' });
    await assert.rejects(db.deleteResource('n-links', kept.resource_id, { linkAdminDelete: true }), /used by a policy/);
    assert.ok(!writes.some(([m, p]) => m === 'DELETE' && p.startsWith('/api/policies/')));
    assert.equal(kept.state, 'kept');
    // The server route passes the admin flag only for admins.
    const src = require('fs').readFileSync(require.resolve('../server'), 'utf8');
    assert.match(src, /deleteResource\(req\.params\.id, req\.params\.rid, \{ linkAdminDelete: !!viewer\.isAdmin \}\)/);
});

test('routing peers and the name are only an admin\'s to change; elsewhere, or while the guard is off, as before', async () => {
    const calls = (net, opts) => [
        () => db.createNetworkRouter(net, { peer: 'p-r', enabled: true }, opts),
        () => db.deleteNetworkRouter(net, 'rt-1', opts),
        () => db.updateNetwork(net, { name: 'x' }, opts),
    ];
    onWriteAnswer = (p) => (/^\/api\/networks\/[^/]+$/.test(p) ? { status: 200, body: { id: p } } : null);
    for (const call of calls('n-links')) await assert.rejects(call(), managedError);
    assert.equal(posts.length + writes.length, 0, 'nothing sent');
    for (const call of [...calls('n-links', { linkWrite: true }), ...calls('n-office')]) await call();
    setConfig({ createResources: { enabled: false } });
    for (const call of calls('n-links')) await call();
    // Off, but a server is still in use there.
    const k = seed('9.9.80.1');
    k.state = 'kept';
    for (const call of calls('n-links')) await assert.rejects(call(), managedError);
    // A tenant has no such network.
    await nb.runWithTenant('tenant-a', () => db.deleteNetworkRouter('n-links', 'rt-1'));
});

test('the network is created with its routing peers while adding is on, and deleted with them', async () => {
    const out = await setUp({ peers: ['p-r'] });
    assert.equal(ra.getRemoteAccessConfig().createResources.enabled, true);
    assert.deepEqual(out.routers.added, [{ peer: 'p-r' }]);
    await db.deleteNetwork(out.network.id, { admin: true, viewer: ADMIN });
    assert.ok(writes.some(([m, p]) => m === 'DELETE' && p.startsWith(`/api/networks/${out.network.id}/routers/`)));
});

test('a name with a public and a loopback answer is not public', async () => {
    dnsAnswers['mixed2.example.com'] = ['8.8.8.30', '127.0.0.1'];
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'mixed2.example.com' })), 'NAME_NOT_PUBLIC');
    assert.equal(posts.length, 0);
});

test('the list shows every active row and the latest 50 finished ones', async () => {
    for (let i = 0; i < 60; i++) seed(`9.8.0.${i}`, { state: 'created', resource: true });
    for (let i = 0; i < 55; i++) { const r = seed(`9.8.1.${i}`, { resource: false }); r.state = 'failed'; r.updated_at = Date.now() - i * 1000; }
    const list = await ra.listCreatedResources();
    assert.equal(list.items.filter(i => i.state === 'created').length, 60);
    assert.equal(list.items.filter(i => i.state === 'failed').length, 50);
    assert.equal(list.finishedMore, true);
});

test('a save of other fields keeps the stored section as it is', async () => {
    const stored = { enabled: false, networkId: 'n-links', profileId: 11, groupId: 'g-links', max: 9 };
    setConfig({ createResources: stored });
    await ra.setRemoteAccessConfig({ idleTimeoutMin: 41 }).catch(() => { });
    assert.deepEqual(JSON.parse(settings.remote_access_config).createResources, stored);
    assert.equal(JSON.parse(settings.remote_access_config).idleTimeoutMin, 41);
    assert.deepEqual(ra.getRemoteAccessConfig().createResources, stored);
});

test('a save of the section changes only the fields it sends', async () => {
    await ra.setRemoteAccessConfig({ createResources: { max: 12 } }).catch(e => { if (e.status) throw e; });
    assert.deepEqual(JSON.parse(settings.remote_access_config).createResources, { enabled: true, networkId: 'n-links', profileId: 11, groupId: 'g-links', max: 12 });
});

test('a save whose networks leave out the stored network keeps it open to the gateway', async () => {
    for (const cr of [{}, { enabled: false }]) {
        setConfig({ createResources: cr });
        await ra.setRemoteAccessConfig({ networks: ['n-office'] }).catch(e => { if (e.status) throw e; });
        assert.deepEqual(JSON.parse(settings.remote_access_config).networks, ['n-office', 'n-links']);
        assert.deepEqual(ra.getRemoteAccessConfig().networks, ['n-office', 'n-links']);
    }
    // Without a stored network the list is saved as sent.
    setConfig({ createResources: { enabled: false, networkId: '', profileId: 0, groupId: '' } });
    await ra.setRemoteAccessConfig({ networks: ['n-office'] }).catch(e => { if (e.status) throw e; });
    assert.deepEqual(JSON.parse(settings.remote_access_config).networks, ['n-office']);
});

test('no gateway check: a save, a launch and the sync work while the gateway reaches the group', async () => {
    w.policies.push({ id: 'pol-reach', name: 'Gateway To Linked', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'all', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-links' }] }] });
    await ra.setRemoteAccessConfig({ createResources: { max: 20 } }).catch(e => { if (e.status) throw e; });
    assert.equal(JSON.parse(settings.remote_access_config).createResources.max, 20);
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, true);
    await ra.maintainCreatedResources();
    // Policy writes are as on main: no refusal.
    await db.createPolicy({ name: 'Gateway To Linked 2', protocol: 'all', sources: ['g-gw'], destinations: ['g-links'] });
    assert.equal(posts.filter(([p]) => p === '/api/policies').length, 1);
});

test('kept servers keep the network in use; the creation limit counts active rows only', async () => {
    const kept = seed('9.9.23.1');
    kept.state = 'kept';
    setConfig({ createResources: { enabled: false } });
    addOtherProfile();
    await rejects(ra.setRemoteAccessConfig({ createResources: { profileId: 12 } }), 'CREATED_RESOURCES_EXIST');
    // The limit: one kept row and a maximum of 1 still allow a create.
    setConfig({ createResources: { max: 1 } });
    assert.equal((await ra.issueLaunch(KEY, rdp())).resource.created, true);
});

test('the admin delete counts only a success or a 404; no answer leaves the row', async () => {
    const kept = seed('9.9.25.1', { ageHours: 0 });
    kept.state = 'kept';
    deleteAnswer = () => ({ status: 0, error: 'timeout' });
    await assert.rejects(db.deleteResource('n-links', kept.resource_id, { linkAdminDelete: true }), (e) => e.status === 502 && /didn't confirm the delete/.test(e.message));
    assert.equal(kept.state, 'kept');
    deleteAnswer = () => ({ status: 503, raw: 'down' });
    await assert.rejects(db.deleteResource('n-links', kept.resource_id, { linkAdminDelete: true }), (e) => e.status === 502);
    assert.equal(kept.state, 'kept');
    deleteAnswer = () => ({ status: 404, body: null });
    await db.deleteResource('n-links', kept.resource_id, { linkAdminDelete: true });
    assert.equal(kept.state, 'deleted');
});

const stored = () => JSON.parse(settings.remote_access_config);
const saveCr = (cr) => ra.setRemoteAccessConfig({ createResources: cr });
// A save whose NetBird part may fail afterwards (the gateway sync): only a refusal counts.
const saved = (p) => p.catch(e => { if (e.status) throw e; });

test('choosing a profile adopts its group; each kind of unusable profile is refused with its reason', async () => {
    setConfig({ createResources: { enabled: false, profileId: 0, groupId: '' } });
    addOtherProfile();
    await saved(saveCr({ profileId: 12 }));
    assert.equal(stored().createResources.profileId, 12);
    assert.equal(stored().createResources.groupId, 'g-srv', 'the group comes from the profile');
    assert.equal(ra.getRemoteAccessConfig().createResources.groupId, 'g-srv');
    await saved(saveCr({ profileId: 0 }));
    assert.deepEqual([stored().createResources.profileId, stored().createResources.groupId], [0, '']);

    const refused = async (row, re, extra = () => { }) => {
        setConfig({ createResources: { enabled: false, profileId: 0, groupId: '' } });
        profileRows = [clone(PROFILE), { id: 20, name: 'X', policy_id: 'pol-x', shared: true, tenant: '', group_id: 'g-x', ...row }];
        w = world();
        w.groups.push({ id: 'g-x', name: 'X' });
        w.policies.push({ id: 'pol-x', name: 'X Access', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-crm' }], destinations: [{ id: 'g-x' }] }] });
        extra();
        const before = settings.remote_access_config;
        await rejects(saveCr({ profileId: 20 }), 'INVALID_SETTINGS', (e) => e.status === 400 && re.test(e.message));
        assert.equal(settings.remote_access_config, before, 'nothing saved');
    };
    await refused({ id: 99 }, /no longer exists/);
    await refused({ shared: false, group_id: '', policy_id: '' }, /Shared Access Profile/);
    await refused({ group_id: 'g-nogroup' }, /group no longer exists in NetBird/);
    await refused({}, /policy no longer exists/, () => { w.policies = w.policies.filter(p => p.id !== 'pol-x'); });
    await refused({}, /policy is turned off/, () => { w.policies.find(p => p.id === 'pol-x').enabled = false; });
    await refused({}, /no enabled rule/, () => { w.policies.find(p => p.id === 'pol-x').rules[0].enabled = false; });
    await refused({}, /no enabled rule/, () => { w.policies.find(p => p.id === 'pol-x').rules[0].action = 'drop'; });
    await refused({}, /no enabled rule/, () => { w.policies.find(p => p.id === 'pol-x').rules[0].destinations = [{ id: 'g-crm' }]; });
    // Destinations given as plain ids are read too.
    setConfig({ createResources: { enabled: false, profileId: 0, groupId: '' } });
    profileRows = [clone(PROFILE)];
    profileRows.push({ id: 22, group_id: 'g-x', policy_id: 'pol-plain', shared: true, tenant: '' });
    w.policies.push({ id: 'pol-plain', name: 'Plain', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: ['g-crm'], destinations: ['g-x'] }] });
    await saved(saveCr({ profileId: 22 }));
    assert.equal(stored().createResources.groupId, 'g-x');
});

test('turning on resolves the chosen profile again (an import may have put another one under its id)', async () => {
    setConfig({ createResources: { enabled: false } });
    Object.assign(profileRows[0], { group_id: 'g-srv', policy_id: 'pol-srv' });
    w.policies.push({ id: 'pol-srv', name: 'Servers Access', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-crm' }], destinations: [{ id: 'g-srv' }] }] });
    await saved(saveCr({ enabled: true }));
    assert.deepEqual([stored().createResources.enabled, stored().createResources.groupId], [true, 'g-srv']);
});

test('a launch is refused when the chosen profile is gone, Direct or has another group', async () => {
    for (const rows of [[], [{ ...clone(PROFILE), shared: false }], [{ ...clone(PROFILE), group_id: 'g-srv' }], [{ ...clone(PROFILE), tenant: 'tenant-a' }]]) {
        profileRows = rows;
        await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_DISABLED');
    }
    assert.equal(posts.length, 0);
    assert.equal(created.length, 0);
});

test('a refused or rate-limited create', async () => {
    // A 429 may stand for a retry that got no answer: the sync decides.
    postAnswer = () => ({ status: 429, body: { message: 'too many requests' }, raw: 'too many requests' });
    await rejects(ra.issueLaunch(KEY, rdp()), 'CREATE_UNCONFIRMED', (e) => e.resourceCreated === 'unknown');
    assert.equal(rowFor(PUBLIC).state, 'unknown');
    // Refused by the writer before anything was sent.
    const before = posts.length;
    ra.setRemoteAccessDeps({ createClientResource: async () => { throw new Error('An address already exists.'); } });
    await rejects(ra.issueLaunch(KEY, rdp({ address: '9.9.10.2' })), 'RESOURCE_CREATE_FAILED', (e) => e.resourceCreated === undefined);
    assert.equal(rowFor('9.9.10.2').state, 'failed');
    assert.equal(posts.length, before);
});

test('an import or restore never turns creating on', async () => {
    const imported = JSON.parse(ra.importedRemoteAccessConfig(JSON.stringify({ enabled: true, networks: ['n-office'], createResources: { enabled: true, networkId: 'n-office', profileId: 4, groupId: 'g-x', max: 9 } })));
    assert.deepEqual(imported, { enabled: true, networks: ['n-office'], createResources: { enabled: false, networkId: 'n-office', profileId: 4, groupId: 'g-x', max: 9 } });
    for (const bad of ['not json', '[1]', 'null', '"x"']) assert.equal(ra.importedRemoteAccessConfig(bad), null);
    // The plaintext settings export never carries the table.
    const exp = await db.exportAppSettings();
    assert.equal((exp.tables || {}).ra_created_resources, undefined);
});

test('NetBird unreadable while resolving refuses with 503, nothing saved', async () => {
    setConfig({ createResources: { enabled: false, profileId: 0, groupId: '' } });
    addOtherProfile();
    const before = settings.remote_access_config;
    failGets.add('/api/groups/g-srv');
    await rejects(saveCr({ profileId: 12 }), 'UNAVAILABLE', (e) => e.status === 503);
    failGets = new Set(['/api/policies/pol-srv']);
    await rejects(saveCr({ profileId: 12 }), 'UNAVAILABLE', (e) => e.status === 503);
    assert.equal(settings.remote_access_config, before);
});

test('turning off works with old settings (a group, no profile) and active rows, with NetBird down; no profile is read', async () => {
    setConfig({ createResources: { profileId: 0 } });
    seed('9.9.30.1');
    failGets = new Set(['/api/groups/g-links', '/api/policies/pol-crm', '/api/groups', '/api/policies']);
    const readsBefore = reads.length;
    await saved(saveCr({ enabled: false }));
    assert.deepEqual(stored().createResources, { enabled: false, networkId: 'n-links', profileId: 0, groupId: 'g-links', max: 50 });
    assert.ok(!reads.slice(readsBefore).some(p => ['/api/groups/g-links', '/api/policies/pol-crm'].includes(p)), 'no profile check in NetBird');
});

test('a max-only save of old enabled settings without a profile asks for the profile', async () => {
    setConfig({ createResources: { profileId: 0 } });
    await rejects(saveCr({ max: 9 }), 'INVALID_SETTINGS', (e) => e.status === 400 && /^Choose the Access Profile/.test(e.message));
    setConfig({ createResources: { enabled: false, networkId: '' } });
    await rejects(saveCr({ enabled: true }), 'INVALID_SETTINGS', (e) => /Choose the network first/.test(e.message));
});

test('the audit records carry the profile id', async () => {
    await ra.issueLaunch(KEY, rdp());
    const list = audits.filter(x => ['resource.create_intent', 'resource.create'].includes(x.action));
    assert.equal(list.length, 2);
    for (const a of list) assert.equal(a.meta.profileId, 11, a.action);
});

const ADMIN = { user_id: 'admin-1', email: 'admin@example.test', name: 'Admin' };
const NET_NAME = 'Remote Access Resources (NetBird Control)';
const noNetBirdDelete = () => assert.ok(!writes.some(([m]) => m === 'DELETE'), 'no NetBird DELETE');
// No network stored yet (a profile is chosen, creating is off).
const noNetwork = (extra = {}) => setConfig({ networks: ['n-office'], ...extra, createResources: { enabled: false, networkId: '', ...(extra.createResources || {}) } });
const setUp = (body) => db.setUpLaunchNetwork(body, ADMIN);
const routerPosts = () => posts.filter(([p]) => /\/routers$/.test(p));
const networkPosts = () => posts.filter(([p]) => p === '/api/networks');
const launchError = (code, status, re) => (e) => { assert.equal(e.code, code, e.message); assert.equal(e.status, status); if (re) assert.match(e.message, re); return true; };

test('the network is created, attached before any router, then one router per peer and one for the groups', async () => {
    noNetwork();
    w.groups.push({ id: 'g-routers', name: 'Routers', peers: [{ id: 'p-r' }] });
    const before = stored();
    const storedAtPost = [];
    postAnswerFor = (p) => { storedAtPost.push([p, stored().createResources.networkId]); return null; };
    const out = await setUp({ peers: ['p-r', 'p-r2', 'p-r'], peerGroups: ['g-routers'] });
    const net = w.networks.find(n => n.name === NET_NAME);
    assert.ok(net, 'created in NetBird');
    assert.deepEqual(networkPosts()[0][1], { name: NET_NAME, description: 'Servers added by Remote Access launch links.' });
    assert.deepEqual(out.network, { id: net.id, name: NET_NAME });
    // The network POST before anything is stored; every router POST after the attach.
    assert.deepEqual(storedAtPost.map(x => x[0]), ['/api/networks', ...Array(3).fill(`/api/networks/${net.id}/routers`)]);
    assert.equal(storedAtPost[0][1], '');
    assert.ok(storedAtPost.slice(1).every(x => x[1] === net.id), 'attached before the first router');
    assert.deepEqual(routerPosts().map(([, b]) => b), [
        { enabled: true, masquerade: true, metric: 9999, peer: 'p-r' },
        { enabled: true, masquerade: true, metric: 9999, peer: 'p-r2' },
        { enabled: true, masquerade: true, metric: 9999, peer_groups: ['g-routers'] },
    ]);
    assert.deepEqual(out.routers, { added: [{ peer: 'p-r' }, { peer: 'p-r2' }, { peerGroups: ['g-routers'] }], failed: [] });
    // Only networkId and the networks changed.
    const after = stored();
    assert.deepEqual(after.networks, ['n-office', net.id]);
    assert.deepEqual(after.createResources, { ...before.createResources, networkId: net.id });
    const rest = (x) => { const c = { ...x }; delete c.networks; delete c.createResources; delete c.rev; return c; };
    assert.deepEqual(rest(after), rest(before));
    assert.equal(after.rev, before.rev + 1);
    assert.deepEqual(out.config, { networks: ['n-office', net.id], createResources: { ...ra._internal.normConfig(before).createResources, networkId: net.id } });
    assert.equal(ra.getRemoteAccessConfig().createResources.networkId, net.id, "this instance's copy follows");
    const attach = audits.find(a => a.action === 'remote_access.network_attach');
    assert.deepEqual(attach.meta, { networkId: net.id, name: NET_NAME, mode: 'created', replaced: null, added: ['p-r', 'p-r2', 'g-routers'], failed: [] });
    assert.equal(attach.actorId, 'admin-1');
    noNetBirdDelete();
    // The write guard protects it once creating is on (while off and unused it is ordinary).
    ra._internal.setConfigForTest({ ...stored(), createResources: { ...stored().createResources, enabled: true } });
    await assert.rejects(db.createClientResource(net.id, { name: 'x', address: '9.9.40.1', groups: [], policies: [] }), managedError);
});

test('refused before anything is written: a stored network that exists, servers in use (kept too), a taken name, a gateway router', async () => {
    noNetwork();
    const k = seed('9.9.41.1');
    k.state = 'kept';
    await assert.rejects(setUp({ peers: ['p-r'] }), launchError('CREATED_RESOURCES_EXIST', 409));
    created = [];
    w.networks.push({ id: 'n-old', name: NET_NAME, resources: [] });
    await assert.rejects(setUp({ peers: ['p-r'] }), launchError('NETWORK_NAME_TAKEN', 409, /possibly from an earlier attempt\. Delete or rename it in Networks/));
    w.networks = w.networks.filter(n => n.id !== 'n-old');
    // A router that is the gateway, or a group holding it.
    w.groups.find(g => g.id === 'g-gw').peers = [{ id: 'p-gw' }];
    w.groups.push({ id: 'g-mixed', name: 'Mixed', peers: [{ id: 'p-gw' }, { id: 'p-r' }] });
    await assert.rejects(setUp({ peers: ['p-r', 'p-gw'] }), (e) => e.status === 400 && /Browser Gateway/.test(e.message));
    await assert.rejects(setUp({ peers: ['p-r'], peerGroups: ['g-mixed'] }), (e) => e.status === 400);
    await assert.rejects(setUp({ peerGroups: ['g-all'] }), (e) => e.status === 400);
    failGets.add('/api/networks');
    await assert.rejects(setUp({ peers: ['p-r'] }), launchError('UNAVAILABLE', 503));
    assert.equal(posts.length, 0, 'nothing sent');
    assert.equal(stored().createResources.networkId, '');
    noNetBirdDelete();
});

test('the request is validated: valid ids and at least one', async () => {
    noNetwork();
    for (const body of [{}, { peers: [] }, { peers: 'p-r' }, { peers: ['bad id'] }, { peerGroups: [7] },
        { networkId: 'bad id' }, { networkId: '' }]) {
        await assert.rejects(setUp(body), launchError('INVALID_REQUEST', 400), JSON.stringify(body).slice(0, 60));
    }
    assert.equal(posts.length, 0);
});

test('a network refusal (a 429 too) or no clear answer: nothing else is done, nothing deleted', async () => {
    noNetwork();
    for (const [answer, code, re] of [
        [{ status: 400, raw: 'bad name' }, 'NETWORK_CREATE_FAILED', /bad name/],
        [{ status: 429, raw: 'too many requests' }, 'NETWORK_CREATE_FAILED', /too many requests/],
        [{ status: 0, error: 'timeout' }, 'NETWORK_CREATE_FAILED', /Check Networks for a network named "Remote Access Resources \(NetBird Control\)"/],
        [{ status: 503, raw: 'down' }, 'NETWORK_CREATE_FAILED', /Check Networks/],
        [{ status: 201, body: {} }, 'NETWORK_CREATE_FAILED', /Check Networks/],
    ]) {
        posts.length = 0;
        postAnswerFor = (p) => (p === '/api/networks' ? answer : null);
        await assert.rejects(setUp({ peers: ['p-r'] }), launchError(code, 502, re));
        assert.equal(posts.length, 1, 'the network POST only, once');
        assert.equal(stored().createResources.networkId, '');
    }
    noNetBirdDelete();
});

test('a router that could not be added is reported with the reason; the others are added and the network stays chosen', async () => {
    noNetwork();
    w.groups.push({ id: 'g-routers', name: 'Routers', peers: [] });
    let n = 0;
    postAnswerFor = (p) => (/\/routers$/.test(p) && ++n === 2 ? { status: 0, error: 'timeout' } : null);
    const out = await setUp({ peers: ['p-1', 'p-2', 'p-3'], peerGroups: ['g-routers'] });
    assert.deepEqual(out.routers.added, [{ peer: 'p-1' }, { peer: 'p-3' }, { peerGroups: ['g-routers'] }]);
    assert.deepEqual(out.routers.failed, [{ peer: 'p-2', reason: 'Failed to add routing peer: timeout' }]);
    assert.equal(stored().createResources.networkId, out.network.id);
    const { added, failed } = audits.find(a => a.action === 'remote_access.network_attach').meta;
    assert.deepEqual({ added, failed }, { added: ['p-1', 'p-3', 'g-routers'], failed: ['p-2'] });
    noNetBirdDelete();
});

test('a setting that cannot be stored leaves the new network and names it', async () => {
    noNetwork();
    postAnswerFor = (p) => { if (p === '/api/networks') failSettings = true; return null; };
    try {
        await assert.rejects(setUp({ peers: ['p-r'] }), launchError('UNAVAILABLE', 503, /couldn't be saved\. Delete network net-\d+ in Networks/));
    } finally { failSettings = false; }
    assert.equal(routerPosts().length, 0);
    assert.equal(ra.getRemoteAccessConfig().createResources.networkId, '');
    noNetBirdDelete();
});

test('the first network on a clean install is added to an empty list', async () => {
    ra._internal.setConfigForTest({});
    settings.remote_access_config = JSON.stringify({});
    const out = await setUp({ peers: ['p-r'] });
    assert.deepEqual(stored().networks, [out.network.id]);
    assert.equal(stored().createResources.networkId, out.network.id);
});

test('servers of a network that was deleted in NetBird do not hold the choice of another one', async () => {
    setConfig({ networks: ['n-office', 'n-gone'], createResources: { enabled: false, networkId: 'n-gone' } });
    const row = (state, network_id = 'n-gone') => ({ attempt_id: crypto.randomUUID(), ip: '9.9.42.1', name: '', network_id, group_id: 'g-links', key_id: 7, state, resource_id: 'res-x',
        expected_name: 'x', expected_address: '9.9.42.1/32', expected_description: 'x', reason: '', created_at: Date.now(), updated_at: Date.now() });
    created.push(row('kept'), row('created'));
    const out = await setUp({ peers: ['p-r'] });
    assert.deepEqual(stored().networks, ['n-office', 'n-gone', out.network.id], 'the old one stays as it is');
    assert.equal(audits.find(a => a.action === 'remote_access.network_attach').meta.replaced, 'n-gone');
    // Servers in use in another network still refuse.
    setConfig({ networks: ['n-office'], createResources: { enabled: false, networkId: 'n-gone2' } });
    created.push(row('created', 'n-links'));
    await assert.rejects(setUp({ peers: ['p-r'] }), launchError('CREATED_RESOURCES_EXIST', 409));
});

test('the route is admin-only, main account only, and refused on a read-only instance', () => {
    const src = require('fs').readFileSync(require.resolve('../server'), 'utf8');
    const i = src.indexOf("app.post('/api/remote-access/create-resources/network', requireAdmin,");
    assert.ok(i > 0, 'requireAdmin');
    const body = src.slice(i, src.indexOf('\napp.', i + 10));
    assert.match(body, /if \(currentTenantAccount\(\)\) return res\.status\(404\)/);
    assert.match(body, /if \(NETBIRD_READONLY\) return res\.status\(403\)/);
    assert.match(body, /setUpLaunchNetwork\(req\.body, await getViewer\(req\)\)/);
});

// ─── An existing network ───
const EMPTY = { id: 'n-empty', name: 'Empty', resources: [] };
const useEmpty = () => { noNetwork(); w.networks.push(clone(EMPTY)); w.routers = { 'n-empty': [{ id: 'rt-1', peer: 'p-r', enabled: true }, { id: 'rt-2', peer_groups: ['g-srv'], enabled: false }] }; };

test('an empty network is chosen with no router POST; only networkId and the networks change', async () => {
    useEmpty();
    const before = stored();
    const out = await setUp({ networkId: 'n-empty' });
    assert.equal(posts.length, 0, 'nothing created');
    assert.deepEqual(out.network, { id: 'n-empty', name: 'Empty' });
    assert.equal(out.enabledRouters, 1);
    assert.deepEqual(stored().networks, ['n-office', 'n-empty']);
    assert.deepEqual(stored().createResources, { ...before.createResources, networkId: 'n-empty' });
    assert.equal(audits.find(a => a.action === 'remote_access.network_attach').meta.mode, 'existing');
    noNetBirdDelete();
    // No enabled router: the answer says 0 (the page warns).
    useEmpty();
    w.networks = w.networks.filter((n, i, a) => a.findIndex(x => x.id === n.id) === i);
    w.routers['n-empty'] = [];
    assert.equal((await setUp({ networkId: 'n-empty' })).enabledRouters, 0);
});

test('a network with resources, or whose resources cannot be read, is refused; nothing written', async () => {
    useEmpty();
    const before = settings.remote_access_config;
    await assert.rejects(setUp({ networkId: 'n-office' }), launchError('NETWORK_NOT_EMPTY', 409, /This network has 2 resources\. Clear it in Networks, or choose another one\./));
    failGets.add('/api/networks/n-empty/resources');
    await assert.rejects(setUp({ networkId: 'n-empty' }), launchError('UNAVAILABLE', 503));
    assert.equal(settings.remote_access_config, before);
    assert.ok(!audits.some(a => a.action === 'remote_access.network_attach'));
    // NetBird answers an empty list as JSON null.
    failGets = new Set();
    getAnswerFor = (p) => (p === '/api/networks/n-empty/resources' ? { status: 200, body: null, raw: 'null' } : null);
    assert.equal((await setUp({ networkId: 'n-empty' })).network.id, 'n-empty');
});

test('refused: a missing network, an automation target, a gateway router, unreadable routers', async () => {
    useEmpty();
    await assert.rejects(setUp({ networkId: 'n-nope' }), launchError('NETWORK_NOT_FOUND', 404));
    automationRows = [{ name: 'CRM Feed', network_id: 'n-empty' }];
    await assert.rejects(setUp({ networkId: 'n-empty' }), launchError('NETWORK_NOT_USABLE', 409, /automation "CRM Feed"/));
    automationRows = [];
    w.groups.find(g => g.id === 'g-gw').peers = [{ id: 'p-gw' }];
    w.groups.push({ id: 'g-holds-gw', name: 'Holds Gateway', peers: [{ id: 'p-gw' }] });
    for (const routers of [[{ peer: 'p-gw', enabled: true }], [{ peer_groups: [{ id: 'g-holds-gw' }], enabled: true }]]) {
        w.routers['n-empty'] = routers;
        await assert.rejects(setUp({ networkId: 'n-empty' }), (e) => e.status === 400 && /Browser Gateway/.test(e.message));
    }
    w.routers['n-empty'] = { not: 'a list' };
    await assert.rejects(setUp({ networkId: 'n-empty' }), launchError('UNAVAILABLE', 503));
    w.routers['n-empty'] = [];
    failGets.add('/api/networks/n-empty/routers');
    await assert.rejects(setUp({ networkId: 'n-empty' }), launchError('UNAVAILABLE', 503));
    assert.equal(stored().createResources.networkId, '');
});

test('a network a live access target names is refused with the reason', async () => {
    const target = { type: 'network', id: 'n-empty', name: 'Empty' };
    for (const [set, re] of [
        [() => { liveRows.recurring = [{ user_id: 'u9', user_label: 'Dana', targets: [target] }]; }, /^Network Empty is used by recurring access for Dana\. Remove it there first\.$/],
        [() => { liveRows.requests = [{ requester_id: 'u9', requester_name: 'Dana', targets: [], approved_targets: [target] }]; }, /a pending access request from Dana/],
        [async () => { await db.setAutoApprovalConfig({ trusted: [], rules: [{ targets: [target], groupIds: ['g-crm'], maxMinutes: 60 }] }); }, /an auto-approval rule/],
        [() => { liveRows.grants = [{ user_id: 'u9', user_label: 'Dana', targets: [target] }]; }, /temporary access for Dana/],
    ]) {
        useEmpty();
        liveRows = { recurring: [], grants: [], requests: [] };
        await db.setAutoApprovalConfig({ trusted: [], rules: [] });
        await set();
        await assert.rejects(setUp({ networkId: 'n-empty' }), launchError('NETWORK_NOT_USABLE', 409, re));
        assert.equal(stored().createResources.networkId, '');
    }
    await db.setAutoApprovalConfig({ trusted: [], rules: [] });
});

// ─── The chosen network elsewhere ───

test('an automation can\'t target the stored network (create or update); others can', async () => {
    const cfg = (networkId) => ({ name: 'Feed', endpointUrl: 'https://feed.example.test/items', networkId, profileIds: [] });
    await assert.rejects(db.createAutomation(cfg('n-links')), (e) => e.status === 400 && e.code === 'NETWORK_MANAGED' && /launch links/.test(e.message));
    await assert.rejects(db.updateAutomation(3, cfg('n-links')), (e) => e.status === 400 && e.code === 'NETWORK_MANAGED');
    // Another network passes this check (the insert is the stub's).
    await db.updateAutomation(3, cfg('n-office'));
});

test('the stored network is left out of the request search, and refused in requests, recurring rules and auto-approval', async () => {
    assert.ok(!(await db.searchRequestTargets('links')).results.some(r => r.type === 'network' && r.id === 'n-links'), 'the network is not offered');
    assert.ok((await db.searchRequestTargets('office')).results.some(r => r.type === 'network' && r.id === 'n-office'));
    const rid = seed('9.9.44.1', { ageHours: 0 }).resource_id;
    assert.ok(!(await db.searchRequestTargets('9.9.44')).results.some(r => r.id === rid), 'nor its resources');
    const network = { type: 'network', id: 'n-links', name: 'Links' };
    await assert.rejects(db.createAccessRequest({ targets: [network], reason: 'work' }, { user_id: 'u1', email: 'alice@example.test', name: 'Alice' }), managedError);
    await assert.rejects(db.createRecurringAccess({ userId: 'u1', targets: [network], days: [1], startTime: '08:00', endTime: '10:00' }, ADMIN), managedError);
    await assert.rejects(db.setAutoApprovalConfig({ trusted: [], rules: [{ targets: [{ type: 'resource', id: rid, name: 'x' }], groupIds: ['g-crm'], maxMinutes: 60 }] }), managedError);
    // A rule that is off may name it; it can't be turned on.
    await db.setAutoApprovalConfig({ trusted: [], rules: [{ targets: [network], groupIds: ['g-crm'], maxMinutes: 60, enabled: false }] });
    await db.setAutoApprovalConfig({ trusted: [], rules: [] });
    recurringRule = { id: 3, user_id: 'u1', user_label: 'Dana', targets: [network], days: [1], start_time: '08:00', end_time: '10:00', enabled: false, active_grant_id: null };
    const rule = (enabled) => ({ userId: 'u1', userLabel: 'Dana', targets: [network], days: [1], startTime: '08:00', endTime: '10:00', enabled });
    await db.updateRecurringAccess(3, rule(false), ADMIN);
    await assert.rejects(db.updateRecurringAccess(3, rule(true), ADMIN), managedError);
});

test('detaching a group from a resource that is gone finishes in the protected network; a real detach there is still refused', async () => {
    assert.equal(await db.removeResourceGroups('n-links', 'res-missing', ['g-tmp']), false, 'the read confirms it is gone');
    const rid = seed('9.9.48.1', { ageHours: 0, extra: { groups: [{ id: 'g-links' }, { id: 'g-tmp' }] } }).resource_id;
    const sent = writes.length;
    await assert.rejects(db.removeResourceGroups('n-links', rid, ['g-tmp']), managedError);
    assert.equal(writes.length, sent, 'no PUT');
});

// ─── Changing or releasing the network ───

test('Change Network: with nothing in use, both forms replace the stored network; the old one stays among the networks', async () => {
    // Create: the network and its router are the only NetBird writes.
    const out = await setUp({ peers: ['p-r'] });
    assert.equal(stored().createResources.networkId, out.network.id);
    assert.deepEqual(stored().networks, ['n-office', 'n-links', out.network.id]);
    assert.deepEqual(posts.map(([p]) => p), ['/api/networks', `/api/networks/${out.network.id}/routers`]);
    assert.ok(!writes.length, 'nothing else written');
    assert.equal(audits.find(a => a.action === 'remote_access.network_attach').meta.replaced, 'n-links');
    // Existing: nothing written at all.
    setConfig();
    posts.length = 0;
    w.networks.push(clone(EMPTY));
    w.routers = { 'n-empty': [] };
    await setUp({ networkId: 'n-empty' });
    assert.equal(stored().createResources.networkId, 'n-empty');
    assert.ok(stored().networks.includes('n-links'));
    assert.equal(posts.length + writes.length, 0);
});

test('Change Network and Stop Using This Network are refused while servers are in use (kept ones too)', async () => {
    const k = seed('9.9.60.1');
    k.state = 'kept';
    const inUse = (e) => e.status === 409 && e.code === 'CREATED_RESOURCES_EXIST' && /still in use\. The network can be changed once (it is|they are) removed; kept ones can be deleted in Networks\./.test(e.message);
    await assert.rejects(setUp({ peers: ['p-r'] }), inUse);
    await assert.rejects(db.releaseLaunchNetwork(ADMIN), inUse);
    assert.equal(stored().createResources.networkId, 'n-links');
    assert.equal(posts.length + writes.length, 0);
});

test('Stop Using This Network clears the network, turns creating off, is audited, and changes nothing in NetBird', async () => {
    const out = await db.releaseLaunchNetwork(ADMIN);
    assert.equal(stored().createResources.networkId, '');
    assert.equal(stored().createResources.enabled, false, 'it can\'t run without a network');
    assert.equal(stored().createResources.profileId, 11, 'other fields as stored');
    assert.deepEqual(stored().networks, ['n-office', 'n-links']);
    assert.deepEqual(out.config.createResources.networkId, '');
    assert.equal(ra.getRemoteAccessConfig().createResources.networkId, '', "this instance's copy follows");
    const a = audits.find(x => x.action === 'remote_access.network_release');
    assert.deepEqual(a.meta, { networkId: 'n-links' });
    assert.equal(posts.length + writes.length, 0, 'nothing sent to NetBird');
    // The network is an ordinary one now.
    await db.createClientResource('n-links', { name: 'x', address: '9.9.60.2', groups: [], policies: [] });
});

test('the guard: off with nothing in use, the network is ordinary; on, or with servers in use, it is guarded', async () => {
    setConfig({ createResources: { enabled: false } });
    await db.createClientResource('n-links', { name: 'x', address: '9.9.61.1', groups: [], policies: [] });
    assert.equal((await db.getNetworks()).find(n => n.id === 'n-links').managedByApi, false, 'no label');
    await db.updateAutomation(3, { name: 'Feed', endpointUrl: 'https://feed.example.test/items', networkId: 'n-links', profileIds: [] });
    assert.ok((await db.searchRequestTargets('links')).results.some(r => r.type === 'network' && r.id === 'n-links'), 'requestable');
    // Off, a kept server there: guarded.
    const k = seed('9.9.61.2');
    k.state = 'kept';
    await assert.rejects(db.createClientResource('n-links', { name: 'y', address: '9.9.61.3', groups: [], policies: [] }), managedError);
    assert.equal((await db.getNetworks()).find(n => n.id === 'n-links').managedByApi, true);
    // On, nothing in use: guarded.
    created = [];
    setConfig();
    await assert.rejects(db.createClientResource('n-links', { name: 'z', address: '9.9.61.4', groups: [], policies: [] }), managedError);
    // A rows read that fails refuses.
    setConfig({ createResources: { enabled: false } });
    const realQuery = core.pool.query;
    core.pool.query = async (sql, params) => { const t = typeof sql === 'string' ? sql : sql.text; if (/FROM ra_created_resources/.test(t)) throw new Error('db down'); return realQuery(sql, params); };
    try {
        await assert.rejects(db.createClientResource('n-links', { name: 'q', address: '9.9.61.5', groups: [], policies: [] }), /db down/);
    } finally { core.pool.query = realQuery; }
});

test('a network with servers in use stays guarded when an import chose another one', async () => {
    const row = seed('9.9.61.9', { ageHours: 0 });
    ra._internal.setConfigForTest(cfgOf({ createResources: { enabled: false, networkId: '' } }));
    await assert.rejects(db.setResourceEnabled('n-links', row.resource_id, false), managedError);
    await assert.rejects(db.deleteNetwork('n-links'), managedError);
    assert.equal((await db.getNetworks()).find(n => n.id === 'n-links').managedByApi, true);
    await db.deleteNetwork('n-links', { admin: true, viewer: ADMIN });
    assert.equal(row.state, 'deleted');
});

test('a settings save that cannot be stored changes nothing in memory', async () => {
    setConfig({ createResources: { enabled: false } });
    failSettings = true;
    try { await rejects(saveCr({ enabled: true }), 'UNAVAILABLE', (e) => e.status === 503); } finally { failSettings = false; }
    assert.equal(ra.getRemoteAccessConfig().createResources.enabled, false);
});

test('settings that change while a launch looks up a name decide where it is added, or that it is not', async () => {
    const during = (extra) => ra.setRemoteAccessDeps({ resolve4: async () => { ra._internal.setConfigForTest(cfgOf(extra)); return [PUBLIC]; } });
    during({ createResources: { enabled: false, networkId: '' } });
    await rejects(ra.issueLaunch(KEY, rdp({ address: 'slow.example.com' })), 'CREATE_DISABLED');
    assert.equal(posts.length, 0);
    setConfig();
    during({ createResources: { networkId: 'n-office' } });
    await ra.issueLaunch(KEY, rdp({ address: 'slow.example.com' }));
    assert.equal(posts[0][0], '/api/networks/n-office/resources');
    assert.equal(rowFor(PUBLIC).network_id, 'n-office');
});

test('turning creating on re-checks the network: foreign resources, an unreadable list, or a gateway router refuse', async () => {
    setConfig({ createResources: { enabled: false } });
    // A server launch links added is not foreign.
    seed('9.9.62.1');
    w.resources.push({ id: 'r-foreign', name: 'foreign', type: 'host', address: '10.9.9.9/32', enabled: true, groups: [] });
    w.networks.find(n => n.id === 'n-links').resources.push('r-foreign');
    const before = settings.remote_access_config;
    await rejects(saveCr({ enabled: true }), 'NETWORK_NOT_EMPTY', (e) => e.status === 409 && /This network has 1 resource\. Clear it in Networks, or choose another one\./.test(e.message));
    assert.equal(settings.remote_access_config, before);
    w.networks.find(n => n.id === 'n-links').resources = w.networks.find(n => n.id === 'n-links').resources.filter(x => x !== 'r-foreign');
    failGets.add('/api/networks/n-links/resources');
    await rejects(saveCr({ enabled: true }), 'UNAVAILABLE', (e) => e.status === 503);
    failGets = new Set();
    w.groups.find(g => g.id === 'g-gw').peers = [{ id: 'p-gw' }];
    w.routers = { 'n-links': [{ id: 'rt-1', peer: 'p-gw', enabled: true }] };
    await assert.rejects(saveCr({ enabled: true }), (e) => e.status === 400 && /Browser Gateway/.test(e.message));
    w.routers = {};
    liveRows.grants = [{ user_id: 'u9', user_label: 'Dana', targets: [{ type: 'network', id: 'n-links' }] }];
    await rejects(saveCr({ enabled: true }), 'NETWORK_NOT_USABLE', (e) => e.status === 409);
    liveRows.grants = [];
    assert.equal(settings.remote_access_config, before);
    w.routers = { 'n-links': [{ id: 'rt-1', peer: 'p-r', enabled: true }] };
    await saved(saveCr({ enabled: true }));
    assert.equal(stored().createResources.enabled, true);
});

const resourceDeletes = () => writes.filter(([m, p]) => m === 'DELETE' && /\/resources\//.test(p)).map(([, p]) => p);

test('admin delete: an Active server Remote Access added is deleted once and its row settled; the leader leaves it alone', async () => {
    const row = seed('9.9.70.1', { ageHours: 0 });
    await assert.rejects(db.deleteResource('n-links', row.resource_id), managedError);
    await db.deleteResource('n-links', row.resource_id, { linkAdminDelete: true });
    assert.deepEqual(resourceDeletes(), [`/api/networks/n-links/resources/${row.resource_id}`]);
    assert.equal(row.state, 'deleted');
    assert.equal(row.reason, 'Deleted by an admin in Networks.');
    row.created_at = Date.now() - 20 * HOUR;
    await ra.maintainCreatedResources();
    assert.equal(resourceDeletes().length, 1, 'the leader sends nothing more');
    assert.equal(row.state, 'deleted');
});

test('admin delete: no clear answer leaves the row as it was; a server still being added can be deleted too', async () => {
    const row = seed('9.9.70.2', { ageHours: 0 });
    deleteAnswer = () => ({ status: 0, error: 'timeout' });
    await assert.rejects(db.deleteResource('n-links', row.resource_id, { linkAdminDelete: true }), (e) => e.status === 502 && e.unconfirmed === true);
    assert.equal(row.state, 'created');
    deleteAnswer = null;
    const pending = seed('9.9.70.3', { state: 'unknown', ageHours: 1 });
    await db.deleteResource('n-links', resourceAt('9.9.70.3').id, { linkAdminDelete: true });
    await ra.maintainCreatedResources();
    assert.equal(pending.state, 'failed', 'the sync finds nothing for it');
    const noGroup = seed('9.9.70.6', { state: 'unknown', ageHours: 0 });
    noGroup.resource_id = resourceAt('9.9.70.6').id;
    await db.deleteResource('n-links', noGroup.resource_id, { linkAdminDelete: true });
    assert.equal(noGroup.state, 'deleted');
});

test('admin delete: the network detail says which servers someone is connected to', async () => {
    const a = seed('9.9.70.4', { ageHours: 0 });
    const b = seed('9.9.70.5', { ageHours: 0 });
    sessionRows.push({ id: 's-70', resource_id: b.resource_id });
    const d = await db.getNetworkDetail('n-links');
    const byId = Object.fromEntries(d.resources.map(r => [r.id, r]));
    assert.equal(byId[a.resource_id].inSession, false);
    assert.equal(byId[b.resource_id].inSession, true);
});

test('admin network delete: creating off first, then NetBird deletes, then the setting is cleared, rows settled, audited', async () => {
    const row = seed('9.9.71.1', { ageHours: 0 });
    let enabledAtFirstDelete = null;
    onWrite = (p) => { if (enabledAtFirstDelete === null && /^\/api\/networks\//.test(p)) enabledAtFirstDelete = stored().createResources.enabled; };
    assert.deepEqual(await db.deleteNetwork('n-links', { admin: true, viewer: ADMIN }), { ok: true });
    assert.equal(enabledAtFirstDelete, false, 'turned off before anything was deleted');
    assert.ok(writes.some(([m, p]) => m === 'DELETE' && p === '/api/networks/n-links'), 'the network is deleted');
    assert.ok(!writes.some(([m, p]) => m === 'DELETE' && /^\/api\/(groups|policies)\/(g-links|pol-crm)$/.test(p)), "the profile's group and policy stay");
    assert.equal(stored().createResources.networkId, '');
    assert.equal(stored().createResources.enabled, false);
    assert.equal(row.state, 'deleted');
    assert.ok(audits.some(x => x.action === 'settings.remote_access' && x.meta && x.meta.via === 'network.delete'));
    assert.deepEqual(audits.find(x => x.action === 'remote_access.network_release').meta, { networkId: 'n-links', via: 'network.delete' });
    assert.equal(ra.getRemoteAccessConfig().createResources.networkId, '');
});

test('admin network delete: a partial failure keeps the setting attached with creating off; a non-admin is refused', async () => {
    seed('9.9.71.2', { ageHours: 0 });
    await assert.rejects(db.deleteNetwork('n-links'), managedError);
    deleteAnswer = (p) => (/\/resources\//.test(p) ? { status: 0, error: 'timeout' } : null);
    await assert.rejects(db.deleteNetwork('n-links', { admin: true, viewer: ADMIN }), /network was not deleted/);
    assert.ok(!writes.some(([m, p]) => m === 'DELETE' && p === '/api/networks/n-links'));
    assert.equal(stored().createResources.networkId, 'n-links', 'still attached');
    assert.equal(stored().createResources.enabled, false, 'creating stays off');
    // The network's own delete without an answer: nothing is released either.
    deleteAnswer = null;
    getAnswerFor = null;
    networkDeleteAnswer = { status: 0, error: 'timeout' };
    try { await assert.rejects(db.deleteNetwork('n-links', { admin: true, viewer: ADMIN }), /timeout/); } finally { networkDeleteAnswer = null; }
    assert.equal(created[0].state, 'deleted', 'the server itself was removed');
    assert.equal(stored().createResources.networkId, 'n-links');
});

test('network delete: a stored network that is not guarded (off, nothing in use) is an ordinary delete, then the setting is cleared', async () => {
    setConfig({ createResources: { enabled: false } });
    await db.deleteNetwork('n-links', { viewer: ADMIN });
    assert.ok(writes.some(([m, p]) => m === 'DELETE' && p === '/api/networks/n-links'));
    assert.equal(stored().createResources.networkId, '');
    assert.equal(audits.find(x => x.action === 'remote_access.network_release').meta.via, 'network.delete');
});
