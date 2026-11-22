// Deleting an Access Profile never deletes one that is in use, nor its NetBird objects as a side
// effect (db.deleteAccessProfile, profile usage), and the writes around profiles keep them alive:
//   - every "in use" reason refuses the delete (409 PROFILE_IN_USE with its label); a failed read
//     refuses it too (502), and nothing is deleted;
//   - an unused profile's row, stale network defaults and audit row are one transaction, committed
//     before its NetBird policy and group are deleted, once each; a lost answer is reported as a
//     leftover, an object another profile row shares is kept;
//   - deleting a resource keeps every profile group and policy, and reports a delete NetBird didn't
//     answer as unconfirmed; a move whose delete went unanswered checks the source again;
//   - the resource editor updates a kept policy in place (same id), refuses to drop a profile's;
//   - an automation keeps tracking a resource until it is deleted or confirmed gone in its own network.
// The database and the NetBird client are in-memory stubs; one test drives the real NetBird client
// against a local HTTP server to check that `once` sends a DELETE a single time.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
let seq = 0;

// ─── In-memory database ───
let T;
function resetDb() {
    T = {
        profiles: [], defaults: [], automations: [], recurring: [], grants: [], requests: [], settings: {},
        audit: [], automationRow: null, automationRes: [],
    };
}
resetDb();
const log = [];          // every statement: { seq, where: 'pool' | 'client', sql, params }
let failSql = null;      // RegExp: a matching statement throws
let snapshot = null;     // the transaction's starting state (ROLLBACK restores it)
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
function run(where, text, params = []) {
    const s = norm(text);
    log.push({ seq: ++seq, where, sql: s, params });
    if (failSql && failSql.test(s)) throw new Error('database unavailable');
    if (s === 'BEGIN') { snapshot = clone({ profiles: T.profiles, defaults: T.defaults, audit: T.audit }); return { rows: [] }; }
    if (s === 'COMMIT') { snapshot = null; return { rows: [] }; }
    if (s === 'ROLLBACK') { if (snapshot) Object.assign(T, snapshot); snapshot = null; return { rows: [] }; }
    if (s.startsWith('SELECT id, name, group_id, policy_id, shared FROM access_profiles WHERE id = $1')) return { rows: clone(T.profiles.filter(p => p.id === params[0] && (p.tenant || '') === params[1])) };
    if (s.startsWith('SELECT id, name, group_id, policy_id, shared FROM access_profiles WHERE tenant = $1')) return { rows: clone(T.profiles.filter(p => (p.tenant || '') === params[0])) };
    if (s.startsWith('SELECT id FROM access_profiles')) {
        return { rows: T.profiles.filter(p => (p.tenant || '') === params[0] && params[1].includes(p.id) && (!/shared IS NOT FALSE/.test(s) || p.shared !== false)).map(p => ({ id: p.id })) };
    }
    if (s.startsWith('SELECT name, group_id, policy_id FROM access_profiles')) return { rows: clone(T.profiles.filter(p => p.shared !== false)) };
    if (s.startsWith('SELECT name, policy_id FROM access_profiles')) return { rows: clone(T.profiles.filter(p => p.shared !== false && (p.tenant || '') === params[0])) };
    if (s.startsWith('SELECT id, name, group_id, policy_id, sources')) return { rows: clone(T.profiles.filter(p => (p.tenant || '') === params[0])) };
    if (s.startsWith('SELECT group_id, policy_id FROM access_profiles WHERE (group_id')) {
        return { rows: clone(T.profiles.filter(p => (p.group_id && p.group_id === params[0]) || (p.policy_id && p.policy_id === params[1]))) };
    }
    if (s.startsWith('DELETE FROM network_default_profiles WHERE profile_id')) { T.defaults = T.defaults.filter(d => d.profile_id !== params[0]); return { rows: [] }; }
    if (s.startsWith('DELETE FROM access_profiles')) { T.profiles = T.profiles.filter(p => !(p.id === params[0] && (p.tenant || '') === params[1])); return { rows: [] }; }
    if (s.startsWith('SELECT policy_id, protocol, ports, sources, posture_checks FROM access_profiles')) return { rows: clone(T.profiles.filter(r => r.shared !== false && params[0].includes(r.policy_id))) };
    if (s.startsWith('UPDATE access_profiles SET protocol = $2, ports = $3, sources = $4, posture_checks = $5 WHERE policy_id = $1')) {
        for (const r of T.profiles) if (r.policy_id === params[0] && r.shared !== false) Object.assign(r, { protocol: params[1], ports: params[2], sources: JSON.parse(params[3]), posture_checks: JSON.parse(params[4]) });
        return { rows: [] };
    }
    if (/nextval\(pg_get_serial_sequence\('temporary_access_grants'/.test(s) || s.startsWith('UPDATE temporary_access_grants')) return { rows: [{ id: 501 }] };
    if (s.startsWith('INSERT INTO app_audit')) { T.audit.push({ where, action: params[3], target: params[4], meta: params[5] ? JSON.parse(params[5]) : null }); return { rows: [] }; }
    if (s.startsWith('SELECT network_id, profile_id FROM network_default_profiles')) return { rows: clone(T.defaults.filter(d => params[1].includes(d.profile_id))) };
    if (s.startsWith('SELECT name, profile_ids FROM automations')) return { rows: clone(T.automations) };
    if (s.startsWith('SELECT user_id, user_label, targets FROM recurring_access')) return { rows: clone(T.recurring) };
    if (s.startsWith('SELECT user_id, user_label, targets FROM temporary_access_grants')) return { rows: clone(T.grants.filter(g => ['creating', 'active'].includes(g.status))) };
    if (s.startsWith('SELECT requester_id')) return { rows: clone(T.requests.filter(r => r.status === 'pending')) };
    if (s.startsWith('SELECT value FROM app_settings')) { const v = T.settings[params[0]]; return { rows: v == null ? [] : [{ value: v }] }; }
    if (s.startsWith('SELECT * FROM automations WHERE id')) return { rows: T.automationRow ? [clone(T.automationRow)] : [] };
    if (s.startsWith('SELECT * FROM automation_resources')) return { rows: clone(T.automationRes) };
    if (s.startsWith('SELECT external_key, resource_id, network_id FROM automation_resources')) return { rows: clone(T.automationRes) };
    if (s.startsWith('DELETE FROM automation_resources WHERE automation_id=$1 AND external_key=$2')) {
        T.automationRes = T.automationRes.filter(r => r.external_key !== params[1]);
        return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
}
const core = require('../lib/core');
core.pool.query = async (q, params) => run('pool', typeof q === 'string' ? q : q.text, params || (q && q.values) || []);
const { EventEmitter } = require('events');
let dropOnCommit = false; // COMMIT: the connection drops - 'error' on the client, then the query fails
let lastClient = null;
core.pool.connect = async () => {
    const c = new EventEmitter();
    c.query = (q, params) => {
        const text = typeof q === 'string' ? q : q.text;
        if (dropOnCommit && norm(text) === 'COMMIT') {
            // As pg does: the socket error reaches the client as an 'error' event, outside the query.
            return new Promise((resolve, reject) => setImmediate(() => {
                c.emit('error', new Error('Connection terminated unexpectedly'));
                reject(new Error('Connection terminated'));
            }));
        }
        return Promise.resolve().then(() => run('client', text, params || []));
    };
    c.release = () => { c.released = true; };
    lastClient = c;
    return c;
};

// ─── In-memory NetBird ───
let NB;
function resetNb() {
    NB = { groups: {}, policies: {}, lists: {}, resources: {}, networks: {}, answers: {} };
}
resetNb();
const calls = []; // { seq, method, path, body, opts }
const notFound = { status: 404, body: { message: 'not found', code: 404 } };
let postN = 0;
function nbAnswer(method, path, body, opts) {
    calls.push({ seq: ++seq, method, path, body: clone(body), opts });
    const key = `${method} ${path}`;
    const q = NB.answers[key];
    if (q && q.length) return clone(q.length > 1 ? q.shift() : q[0]); // the last answer stays
    let m;
    if (method === 'GET') {
        if ((m = path.match(/^\/api\/groups\/([^/]+)$/))) { const g = NB.groups[decodeURIComponent(m[1])]; return g ? { status: 200, body: clone(g) } : notFound; }
        if ((m = path.match(/^\/api\/policies\/([^/]+)$/))) { const p = NB.policies[decodeURIComponent(m[1])]; return p ? { status: 200, body: clone(p) } : notFound; }
        if (path === '/api/policies') return { status: 200, body: clone(Object.values(NB.policies)) };
        if (path === '/api/groups') return { status: 200, body: clone(Object.values(NB.groups)) };
        if ((m = path.match(/^\/api\/networks\/([^/]+)\/resources\/([^/]+)$/))) {
            const r = NB.resources[`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`];
            return r ? { status: 200, body: clone(r) } : notFound;
        }
        if ((m = path.match(/^\/api\/networks\/([^/]+)\/resources$/))) {
            const net = decodeURIComponent(m[1]);
            return { status: 200, body: clone(Object.entries(NB.resources).filter(([k]) => k.startsWith(net + '/')).map(([, r]) => r)) };
        }
        if ((m = path.match(/^\/api\/networks\/([^/]+)$/)) && !['resources', 'routers'].includes(m[1])) {
            const n = NB.networks[decodeURIComponent(m[1])];
            return n ? { status: 200, body: clone(n) } : notFound;
        }
        if (path === '/api/networks') return { status: 200, body: clone(Object.values(NB.networks)) };
        if (NB.lists[path] !== undefined) return { status: 200, body: clone(NB.lists[path]) };
        return { status: 200, body: [] };
    }
    if (method === 'PUT' && (m = path.match(/^\/api\/policies\/([^/]+)$/)) && body) NB.policies[decodeURIComponent(m[1])] = { id: decodeURIComponent(m[1]), ...clone(body) };
    if (method === 'DELETE') {
        if ((m = path.match(/^\/api\/policies\/([^/]+)$/))) delete NB.policies[decodeURIComponent(m[1])];
        if ((m = path.match(/^\/api\/groups\/([^/]+)$/))) delete NB.groups[decodeURIComponent(m[1])];
        if ((m = path.match(/^\/api\/networks\/([^/]+)\/resources\/([^/]+)$/))) delete NB.resources[`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`];
    }
    if (method === 'POST') {
        const id = `new-${++postN}`;
        if (path === '/api/groups') NB.groups[id] = { id, name: body && body.name };
        return { status: 200, body: { id, type: 'host' } };
    }
    return { status: 200, body: {} };
}

const nb = require('../lib/netbird');
const realNetbirdReq = nb.netbirdReq;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
nb.netbirdReq = async (method, path, body, opts) => nbAnswer(method, path, body, opts);
nb.netbirdGet = async (path) => { const r = nbAnswer('GET', path); return r.status === 0 ? null : r.body; };
nb.netbirdPost = async (path, body, opts) => nbAnswer('POST', path, body, opts);

// The automation source (lib/automations.js reads it through lib/http).
let sourceText = '';
require('../lib/http').httpJson = async () => ({ status: 200, raw: sourceText });

const origError = console.error;
console.error = () => { };
const db = require('../db');
const automations = require('../lib/automations');

// ─── Fixtures ───
const GID = 'grp-prof';
const PID = 'pol-prof';
const profile = (extra = {}) => ({ id: 12, name: 'Payroll', group_id: GID, policy_id: PID, shared: true, tenant: '', ...extra });
const g = (id) => ({ id, name: id.toUpperCase() });
function baseline() {
    resetDb(); resetNb(); log.length = 0; calls.length = 0; failSql = null; snapshot = null;
    T.profiles = [profile()];
    NB.groups[GID] = { id: GID, name: 'Payroll', resources_count: 0, peers_count: 0, resources: [], peers: [] };
    NB.policies[PID] = { id: PID, name: 'Payroll Access', enabled: true, rules: [{ name: 'Payroll', enabled: true, action: 'accept', protocol: 'tcp', ports: ['443'], sources: [g('staff')], destinations: [g(GID)] }] };
    for (const p of ['/api/setup-keys', '/api/networks/routers', '/api/routes', '/api/dns/nameservers', '/api/users', '/api/networks/resources', '/api/reverse-proxies/services']) NB.lists[p] = [];
}
const admin = { user_id: 'u-admin', email: 'admin@example.test', name: 'Admin' };
const writes = () => calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`);
const inUse = (re) => (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'PROFILE_IN_USE');
    assert.match(e.message, re);
    assert.match(e.message, /Remove it from them first\.$/);
    return true;
};
async function refused(re) {
    await assert.rejects(db.deleteAccessProfile(12, admin), inUse(re));
    assert.deepEqual(writes(), [], 'nothing sent to NetBird');
    assert.ok(!log.some(l => /^DELETE FROM access_profiles/.test(l.sql)), 'the row is not deleted');
    assert.equal(T.profiles.length >= 1, true);
}

// ─── "In use" ───
test('resources in the profile group refuse the delete, read fresh - not from the cached count', async () => {
    baseline();
    NB.groups[GID].resources_count = 12;
    const listed = (await db.listAccessProfiles()).find(p => p.id === 12);
    assert.equal(listed.resourceCount, 0, 'the cached count says unused');
    await refused(/in use by 12 resources\./);
    // Fresh read says empty → deleted.
    NB.groups[GID].resources_count = 0;
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
});

test('peers in the profile group refuse the delete', async () => {
    baseline();
    NB.groups[GID].peers = [{ id: 'p1' }];
    await refused(/1 peer\b/);
});

test('a profile policy edited to grant another destination refuses the delete', async () => {
    baseline();
    NB.policies[PID].rules[0].destinations.push(g('grp-other'));
    await refused(/its policy "Payroll Access", which also grants other destinations/);
    baseline();
    NB.policies[PID].rules.push({ name: 'x', enabled: true, action: 'accept', protocol: 'all', sources: [g('staff')], destinationResource: { id: 'res-live', type: 'host' } });
    NB.lists['/api/networks/resources'] = [{ id: 'res-live' }];
    await refused(/which also grants other destinations/);
});

test('a resource target that no longer exists does not count; an unreadable resource list refuses (502)', async () => {
    baseline();
    NB.policies[PID].rules.push({ name: 'x', enabled: true, action: 'accept', protocol: 'all', sources: [g('staff')], destinationResource: { id: 'res-gone', type: 'host' } });
    NB.answers['GET /api/networks/resources'] = [{ status: 500, body: { message: 'boom' } }];
    await assert.rejects(db.deleteAccessProfile(12, admin), (e) => e.status === 502 && e.code === 'PROFILE_USAGE_UNREADABLE');
    assert.deepEqual(writes(), []);
    delete NB.answers['GET /api/networks/resources'];
    NB.lists['/api/networks/resources'] = [{ id: 'res-other' }];
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
});

test('a temporary grant to the profile group refuses the delete; an ended one does not', async () => {
    baseline();
    T.grants = [{ user_id: 'u1', user_label: 'Dana', status: 'active', targets: [{ type: 'group', id: GID }] }];
    await refused(/temporary access for Dana/);
    baseline();
    T.grants = [{ user_id: 'u1', user_label: 'Dana', status: 'revoked', targets: [{ type: 'group', id: GID }] }];
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
});

test('a grant to the profile (by id, or by its group) refuses the delete, also while creating', async () => {
    baseline();
    T.grants = [{ user_id: 'u1', user_label: 'Dana', status: 'creating', targets: [{ type: 'profile', id: '12' }] }];
    await refused(/temporary access for Dana/);
    baseline();
    T.grants = [{ user_id: 'u2', user_label: 'Avi', status: 'active', targets: [{ type: 'profile', id: '99', groupId: GID }] }];
    await refused(/temporary access for Avi/);
});

test('recurring access to the profile refuses the delete, enabled or not, and so does one to its group', async () => {
    baseline();
    T.recurring = [{ user_id: 'u1', user_label: 'Dana', enabled: false, targets: [{ type: 'profile', id: '12', name: 'Payroll' }] }];
    await refused(/recurring access for Dana/);
    baseline();
    T.recurring = [{ user_id: 'u3', user_label: 'Noa', targets: [{ type: 'group', id: GID, name: 'Payroll' }] }];
    await refused(/recurring access for Noa/);
});

test('a pending request refuses the delete (targets or approved targets); a denied one does not', async () => {
    baseline();
    T.requests = [{ requester_id: 'u1', requester_name: 'Dana', status: 'pending', targets: [{ type: 'profile', id: '12' }] }];
    await refused(/a pending access request from Dana/);
    baseline();
    T.requests = [{ requester_id: 'u1', requester_name: 'Dana', status: 'pending', targets: [], approved_targets: [{ type: 'profile', id: 12 }] }];
    await refused(/a pending access request from Dana/);
    baseline();
    T.requests = [{ requester_id: 'u1', requester_name: 'Dana', status: 'denied', targets: [{ type: 'profile', id: '12' }] }];
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
});

test('requests and auto-approval are main-account data: a tenant profile with the same id is not held by them', async () => {
    baseline();
    T.profiles = [profile({ tenant: 't1' })];
    T.requests = [{ requester_id: 'u1', requester_name: 'Dana', status: 'pending', targets: [{ type: 'profile', id: '12' }] }];
    T.settings.auto_approval_config = JSON.stringify({ trusted: [], rules: [{ targets: [{ type: 'profile', id: '12', name: 'Payroll' }], groupIds: ['g1'] }] });
    assert.deepEqual(await nb.runWithTenant('t1', () => db.deleteAccessProfile(12, admin)), { leftover: [] });
});

test('auto-approval rules refuse the delete - legacy targetType rules and paused rules; excluded targets do not', async () => {
    baseline();
    T.settings.auto_approval_config = JSON.stringify({ maxMinutes: 60, trustedGroupIds: [], rules: [{ targetType: 'profile', targetId: '12', targetName: 'Payroll', groupIds: ['g1'] }] });
    await refused(/an auto-approval rule/);
    baseline();
    T.settings.auto_approval_config = JSON.stringify({ trusted: [], rules: [{ enabled: false, targets: [{ type: 'profile', id: '12', name: 'Payroll' }], groupIds: ['g1'] }] });
    await refused(/an auto-approval rule/);
    baseline();
    T.settings.auto_approval_config = JSON.stringify({ trusted: [{ groupIds: ['g1'], excludedTargets: [{ type: 'profile', id: '12', name: 'Payroll' }] }], rules: [] });
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
});

test('an auto-approval rule does not hold a Direct profile', async () => {
    baseline();
    T.profiles = [{ id: 12, name: 'Ports', group_id: '', policy_id: '', shared: false, tenant: '' }];
    T.settings.auto_approval_config = JSON.stringify({ trusted: [], rules: [{ targets: [{ type: 'profile', id: '12', name: 'Ports' }], groupIds: ['g1'] }] });
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
});

test('a recurring rule naming a Direct preset does not hold it', async () => {
    baseline();
    T.profiles = [{ id: 12, name: 'Ports', group_id: '', policy_id: '', shared: false, tenant: '' }];
    T.recurring = [{ user_id: 'u1', user_label: 'Dana', targets: [{ type: 'profile', id: '12', name: 'Ports' }] }];
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
});

test('an automation refuses the delete, also with the id stored as a string', async () => {
    baseline();
    T.automations = [{ name: 'CMDB', profile_ids: ['12'] }];
    await refused(/automation "CMDB"/);
});

test('a network default refuses the delete only while the network exists; a missing network\'s row is removed', async () => {
    baseline();
    NB.networks['net-1'] = { id: 'net-1', name: 'Office' };
    T.defaults = [{ network_id: 'net-1', profile_id: 12 }];
    await refused(/the default profiles of network Office/);
    baseline();
    T.defaults = [{ network_id: 'net-gone', profile_id: 12 }];
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
    assert.equal(T.defaults.length, 0, 'the stale default row went with the profile');
    assert.ok(log.some(l => l.where === 'client' && /^DELETE FROM network_default_profiles/.test(l.sql)));
});

test('NetBird objects that reference the profile group refuse the delete', async () => {
    const cases = [
        ['/api/setup-keys', [{ id: 'k1', name: 'Servers', auto_groups: [GID] }], /setup key "Servers"/],
        ['/api/networks/routers', [{ id: 'r1', peer_groups: [GID] }], /a network router/],
        ['/api/routes', [{ id: 'rt1', network_id: 'lan', groups: ['x'], access_control_groups: [GID] }], /route "lan"/],
        ['/api/dns/nameservers', [{ id: 'ns1', name: 'Corp DNS', groups: [GID] }], /DNS nameservers "Corp DNS"/],
        ['/api/users', [{ id: 'u1', name: 'Dana', auto_groups: [GID] }], /the auto groups of user Dana/],
    ];
    for (const [path, list, re] of cases) {
        baseline();
        NB.lists[path] = list;
        await refused(re);
    }
    baseline();
    NB.policies['pol-other'] = { id: 'pol-other', name: 'Ops To Payroll', rules: [{ sources: [g('ops')], destinations: [g(GID)] }] };
    await refused(/policy "Ops To Payroll"/);
});

const unreadable = async (label) => {
    await assert.rejects(db.deleteAccessProfile(12, admin), (e) => e.status === 502 && e.code === 'PROFILE_USAGE_UNREADABLE', label);
    assert.deepEqual(writes(), [], label);
    assert.equal(T.profiles.length, 1, `${label}: not deleted`);
};

test('a 404 from /api/routes or the reverse-proxy services is none; a 500 on them, or a 404 from any other list, refuses', async () => {
    for (const path of ['/api/routes', '/api/reverse-proxies/services']) {
        baseline();
        NB.answers['GET ' + path] = [notFound];
        assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] }, `${path} 404`);
        baseline();
        NB.answers['GET ' + path] = [{ status: 500, body: { message: 'boom' } }];
        await unreadable(`${path} 500`);
    }
    for (const path of ['/api/setup-keys', '/api/users', '/api/dns/nameservers', '/api/groups', '/api/policies']) {
        baseline();
        NB.answers['GET ' + path] = [notFound];
        await unreadable(`${path} 404`);
    }
});

test('without the account-wide router list (404), each network\'s routers are read; any failure refuses', async () => {
    const setup = () => {
        baseline();
        NB.answers['GET /api/networks/routers'] = [notFound];
        NB.networks = { n1: { id: 'n1', name: 'Office' }, n2: { id: 'n2', name: 'Lab' } };
        NB.lists['/api/networks/n1/routers'] = [];
    };
    setup();
    NB.lists['/api/networks/n2/routers'] = [{ id: 'r1', peer_groups: [GID] }];
    await refused(/a network router/);
    // An empty network's list may come back as a JSON null.
    setup();
    NB.answers['GET /api/networks/n2/routers'] = [{ status: 200, body: null, raw: 'null' }];
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
    setup();
    NB.answers['GET /api/networks/n2/routers'] = [{ status: 500, body: { message: 'boom' } }];
    await unreadable('a network\'s routers 500');
    setup();
    NB.answers['GET /api/networks'] = [{ status: 0, error: 'timeout' }];
    await unreadable('networks unanswered');
});

test('a reverse-proxy service whose access or SSO groups include the profile group refuses the delete', async () => {
    baseline();
    NB.lists['/api/reverse-proxies/services'] = [{ id: 's1', name: 'Wiki', private: true, access_groups: [GID] }];
    await refused(/reverse proxy service "Wiki"/);
    baseline();
    NB.lists['/api/reverse-proxies/services'] = [{ id: 's2', domain: 'hr.example.test', auth: { bearer_auth: { enabled: true, distribution_groups: [GID] } } }];
    await refused(/reverse proxy service "hr\.example\.test"/);
    baseline();
    NB.answers['GET /api/reverse-proxies/services'] = [{ status: 502, body: null }];
    await unreadable('services 502');
});

test('a profile group or policy missing from the lists counts as gone', async () => {
    baseline();
    delete NB.groups[GID];
    delete NB.policies[PID];
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
});

test('several reasons are listed together', async () => {
    baseline();
    NB.groups[GID].resources_count = 12;
    T.recurring = [{ user_id: 'u1', user_label: 'Dana', targets: [{ type: 'profile', id: '12' }] }];
    await refused(/^This profile is in use by 12 resources and recurring access for Dana\. Remove it from them first\.$/);
});

test('any failed read refuses the delete with 502, and nothing is deleted', async () => {
    const failures = [
        () => { NB.answers['GET /api/groups'] = [{ status: 500, body: { message: 'boom' } }]; },
        () => { NB.answers['GET /api/groups'] = [notFound]; },
        () => { NB.answers['GET /api/policies'] = [{ status: 0, error: 'timeout' }]; },
        () => { NB.answers['GET /api/routes'] = [{ status: 500, body: { message: 'boom' } }]; },
        () => { NB.answers['GET /api/setup-keys'] = [{ status: 0, error: 'timeout' }]; },
        () => { NB.answers['GET /api/users'] = [{ status: 200, body: { message: 'not a list' } }]; },
        () => { T.defaults = [{ network_id: 'net-1', profile_id: 12 }]; NB.answers['GET /api/networks'] = [{ status: 502, body: null }]; },
        () => { failSql = /FROM recurring_access/; },
        () => { failSql = /FROM access_requests/; },
    ];
    for (const fail of failures) {
        baseline();
        fail();
        await assert.rejects(db.deleteAccessProfile(12, admin), (e) => e.status === 502 && e.code === 'PROFILE_USAGE_UNREADABLE' && /nothing was deleted/.test(e.message));
        assert.deepEqual(writes(), []);
        assert.ok(!log.some(l => /^DELETE FROM/.test(l.sql)), 'nothing deleted');
    }
});

test('the usage list answers every profile with its reasons', async () => {
    baseline();
    T.profiles.push({ id: 13, name: 'Ports', group_id: '', policy_id: '', shared: false, tenant: '' });
    T.automations = [{ name: 'CMDB', profile_ids: [13] }];
    NB.groups[GID].resources_count = 2;
    const out = await db.getAccessProfileUsage();
    assert.deepEqual(out['12'].reasons, [{ kind: 'resources', label: '2 resources' }]);
    assert.deepEqual(out['13'].reasons, [{ kind: 'automation', label: 'automation "CMDB"' }]);
});

// ─── Delete order and NetBird leftovers ───
test('an unused profile: rows and audit in one committed transaction, then the policy and group, each sent once', async () => {
    baseline();
    T.defaults = [{ network_id: 'net-gone', profile_id: 12 }];
    const out = await db.deleteAccessProfile(12, admin);
    assert.deepEqual(out, { leftover: [] });
    const dels = calls.filter(c => c.method === 'DELETE');
    assert.deepEqual(dels.map(c => c.path), [`/api/policies/${PID}`, `/api/groups/${GID}`], 'policy first, then group');
    assert.ok(dels.every(c => c.opts && c.opts.once === true), 'sent once');
    const tx = log.filter(l => l.where === 'client').map(l => l.sql.split(' ').slice(0, 3).join(' '));
    assert.equal(tx[0], 'BEGIN');
    assert.equal(tx[tx.length - 1], 'COMMIT');
    assert.ok(tx.includes('DELETE FROM access_profiles') && tx.includes('INSERT INTO app_audit') && tx.includes('DELETE FROM network_default_profiles'));
    const commit = log.find(l => l.where === 'client' && l.sql === 'COMMIT');
    assert.ok(commit.seq < dels[0].seq, 'committed before the first NetBird delete');
    assert.equal(T.audit.length, 1);
    assert.equal(T.audit[0].where, 'client');
    assert.equal(T.audit[0].action, 'profile.delete');
    assert.deepEqual(T.audit[0].meta, { id: 12, name: 'Payroll', policyId: PID, groupId: GID });
    assert.equal(T.profiles.length, 0);
});

test('a COMMIT that fails at the connection is "may have been saved", and nothing is sent to NetBird', async () => {
    baseline();
    failSql = /^COMMIT$/;
    await assert.rejects(db.deleteAccessProfile(12, admin), (e) => e.status === 502 && e.code === 'PROFILE_DELETE_UNCONFIRMED'
        && e.message === 'The delete may have been saved. Reload the page to check.');
    assert.deepEqual(writes(), []);
    assert.ok(!log.some(l => l.sql === 'ROLLBACK'), 'no ROLLBACK after an unknown COMMIT');
});

test('a connection that drops during COMMIT emits a client error that is heard, not thrown', async () => {
    baseline();
    dropOnCommit = true;
    try {
        await assert.rejects(db.deleteAccessProfile(12, admin), (e) => e.code === 'PROFILE_DELETE_UNCONFIRMED');
    } finally { dropOnCommit = false; }
    assert.deepEqual(writes(), []);
    assert.equal(lastClient.listenerCount('error'), 0, 'the listener is removed before release');
    assert.equal(lastClient.released, true);
});

test('a failed audit insert rolls the delete back: the row stays and nothing is sent to NetBird', async () => {
    baseline();
    failSql = /^INSERT INTO app_audit/;
    await assert.rejects(db.deleteAccessProfile(12, admin), /database unavailable/);
    assert.equal(T.profiles.length, 1, 'still there');
    assert.ok(log.some(l => l.where === 'client' && l.sql === 'ROLLBACK'));
    assert.ok(!log.some(l => l.sql === 'COMMIT'));
    assert.deepEqual(writes(), []);
});

test('policy deleted, group unanswered: 200 with the group as a leftover and a leftover audit', async () => {
    baseline();
    NB.answers[`DELETE /api/groups/${GID}`] = [{ status: 0, error: 'timeout' }];
    const out = await db.deleteAccessProfile(12, admin);
    assert.deepEqual(out.leftover, [{ kind: 'group', id: GID, name: 'Payroll', outcome: 'unconfirmed' }]);
    assert.equal(T.profiles.length, 0, 'the profile is deleted');
    assert.deepEqual(T.audit.map(a => a.action), ['profile.delete', 'profile.delete_leftover']);
});

test('a 429 is not retried: the delete is sent once and reported as refused', async () => {
    baseline();
    NB.answers[`DELETE /api/policies/${PID}`] = [{ status: 429, body: { message: 'too many requests', code: 429 } }];
    const out = await db.deleteAccessProfile(12, admin);
    assert.deepEqual(out.leftover, [{ kind: 'policy', id: PID, name: 'Payroll Access', outcome: 'refused' }]);
    assert.equal(calls.filter(c => c.method === 'DELETE' && c.path === `/api/policies/${PID}`).length, 1);
});

test('a NetBird object another profile row (any account) shares is kept', async () => {
    baseline();
    T.profiles.push({ id: 40, name: 'Payroll (tenant copy)', group_id: GID, policy_id: 'pol-t1', shared: true, tenant: 't1' });
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
    assert.deepEqual(writes(), [`DELETE /api/policies/${PID}`], 'the shared group stays');
});

test('a Direct profile is deleted without any NetBird call; a missing profile is a no-op', async () => {
    baseline();
    T.profiles = [{ id: 12, name: 'Ports', group_id: '', policy_id: '', shared: false, tenant: '' }];
    assert.deepEqual(await db.deleteAccessProfile(12, admin), { leftover: [] });
    assert.deepEqual(writes(), []);
    assert.equal(await db.deleteAccessProfile(12, admin), null);
});

test('the real NetBird client sends a `once` DELETE a single time and returns the 429', async () => {
    const seen = [];
    const replies = [];
    const server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        const r = replies.length > 1 ? replies.shift() : replies[0];
        res.writeHead(r.status, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify(r.body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const prev = { url: nb._nbApi.url, token: nb._nbApi.token };
    nb._nbApi.url = `http://127.0.0.1:${server.address().port}`;
    nb._nbApi.token = crypto.randomBytes(24).toString('hex');
    let clock = 0;
    nb._setNetbirdTimingForTests({ now: () => clock, wallNow: () => clock, sleep: async (ms) => { clock += ms; } });
    const origWarn = console.warn;
    console.warn = () => { };
    try {
        replies.push({ status: 429, body: { message: 'too many requests', code: 429 } }, { status: 200, body: {} });
        const once = await realNetbirdReq('DELETE', '/api/groups/g1', undefined, { once: true });
        assert.equal(once.status, 429);
        assert.deepEqual(seen, ['DELETE /api/groups/g1']);
        // Without `once` the same answer is sent again (the default retry).
        seen.length = 0; replies.length = 0;
        nb._setNetbirdTimingForTests({});
        replies.push({ status: 429, body: { message: 'too many requests', code: 429 } }, { status: 200, body: {} });
        const retried = await realNetbirdReq('DELETE', '/api/groups/g1');
        assert.equal(retried.status, 200);
        assert.equal(seen.length, 2);
    } finally {
        console.warn = origWarn;
        nb._nbApi.url = prev.url; nb._nbApi.token = prev.token;
        nb._setNetbirdTimingForTests({});
        await new Promise((r) => server.close(r));
    }
});

// ─── deleteResource ───
function resourceFixture() {
    baseline();
    NB.resources['net1/r1'] = { id: 'r1', name: 'NAS', address: '10.0.0.9', type: 'host', groups: [g(GID), g('grp-priv')] };
    NB.groups['grp-priv'] = { id: 'grp-priv', name: 'NAS Group', resources_count: 0, peers_count: 0 };
    NB.policies['pol-direct'] = { id: 'pol-direct', name: 'NAS Policy', enabled: true, rules: [{ sources: [g('a')], destinationResource: { id: 'r1', type: 'host' } }] };
    NB.policies['pol-priv'] = { id: 'pol-priv', name: 'NAS Group Policy', enabled: true, rules: [{ sources: [g('a')], destinations: [g('grp-priv')] }] };
}

test('deleting a resource keeps the profile group and policy even when emptied; its own group and policies go', async () => {
    resourceFixture();
    await db.deleteResource('net1', 'r1');
    const w = writes();
    assert.ok(w.includes('DELETE /api/policies/pol-direct'));
    assert.ok(w.includes('DELETE /api/networks/net1/resources/r1'));
    assert.ok(w.includes('DELETE /api/policies/pol-priv'));
    assert.ok(w.includes('DELETE /api/groups/grp-priv'));
    assert.ok(!w.includes(`DELETE /api/groups/${GID}`), 'profile group kept');
    assert.ok(!w.includes(`DELETE /api/policies/${PID}`), 'profile policy kept');
    const del = calls.find(c => c.method === 'DELETE' && c.path === '/api/networks/net1/resources/r1');
    assert.equal(del.opts && del.opts.once, true, 'the resource DELETE is sent once');
});

test('a profile policy that targets the resource directly is never deleted with it', async () => {
    resourceFixture();
    NB.policies[PID].rules = [{ sources: [g('staff')], destinationResource: { id: 'r1', type: 'host' } }];
    await db.deleteResource('net1', 'r1');
    assert.ok(!writes().includes(`DELETE /api/policies/${PID}`));
});

test('an unanswered or 5xx resource delete is unconfirmed (main account and tenant); a 4xx is a refusal; a 404 is done', async () => {
    for (const ctx of [(fn) => fn(), (fn) => nb.runWithTenant('t1', fn)]) {
        for (const answer of [{ status: 0, error: 'timeout' }, { status: 503, body: null }]) {
            resourceFixture();
            NB.answers['DELETE /api/networks/net1/resources/r1'] = [answer];
            await assert.rejects(ctx(() => db.deleteResource('net1', 'r1')), (e) => e.unconfirmed === true && e.status === 502 && e.code === 'RESOURCE_DELETE_UNCONFIRMED'
                && /NetBird didn't confirm the delete\. Check the network and try again\./.test(e.message));
            assert.ok(!writes().includes('DELETE /api/groups/grp-priv'), 'no cleanup after an unconfirmed delete');
        }
        resourceFixture();
        NB.answers['DELETE /api/networks/net1/resources/r1'] = [{ status: 422, body: { message: 'in use' }, raw: 'in use' }];
        await assert.rejects(ctx(() => db.deleteResource('net1', 'r1')), (e) => !e.unconfirmed && /Failed to delete resource/.test(e.message));
        resourceFixture();
        NB.answers['DELETE /api/networks/net1/resources/r1'] = [notFound];
        await ctx(() => db.deleteResource('net1', 'r1'));
    }
});

test('a move whose source read fails before the DELETE is sent rolls back (nothing was deleted)', async () => {
    resourceFixture();
    NB.networks.net2 = { id: 'net2', name: 'Lab' };
    NB.networks.net1 = { id: 'net1', name: 'Office' };
    NB.answers['GET /api/networks/net1/resources/r1'] = [{ status: 0, error: 'timeout' }];
    const out = await db.moveResources('net1', ['r1'], 'net2');
    assert.equal(out.failed.length, 1);
    assert.ok(!writes().includes('DELETE /api/networks/net1/resources/r1'), 'the original was never deleted');
    assert.ok(writes().some(w => /^DELETE \/api\/networks\/net2\/resources\//.test(w)), 'the copy is removed');
    const puts = calls.filter(c => c.method === 'PUT' && c.path === '/api/policies/pol-direct');
    assert.equal(puts.length, 2, 'pointed at the copy, then back');
    assert.equal(puts[1].body.rules[0].destinationResource.id, 'r1');
});

test('a move whose delete went unanswered reads the source again before rolling back', async () => {
    const setup = () => {
        resourceFixture();
        NB.networks.net2 = { id: 'net2', name: 'Lab' };
        NB.networks.net1 = { id: 'net1', name: 'Office' };
        NB.answers['DELETE /api/networks/net1/resources/r1'] = [{ status: 0, error: 'timeout' }];
    };
    // Gone after all: the move counts as done.
    setup();
    NB.answers['GET /api/networks/net1/resources/r1'] = [{ status: 200, body: NB.resources['net1/r1'] }, notFound];
    let out = await db.moveResources('net1', ['r1'], 'net2');
    assert.deepEqual(out.failed, []);
    assert.equal(out.moved.length, 1);
    assert.ok(!writes().some(w => /^DELETE \/api\/networks\/net2\//.test(w)), 'the copy stays');
    // Still there at the re-read (the delete may still land later), or unknown: never rolled back -
    // the copy and the policies pointing at it stay, and the answer says to check the original.
    // A 502 whose body says code 404 is not a confirmed absence: only an HTTP 404 is.
    for (const reread of [{ status: 200, body: NB.resources['net1/r1'] }, { status: 0, error: 'timeout' }, { status: 502, body: { message: 'resource not found', code: 404 } }]) {
        setup();
        NB.answers['GET /api/networks/net1/resources/r1'] = [{ status: 200, body: NB.resources['net1/r1'] }, reread];
        out = await db.moveResources('net1', ['r1'], 'net2');
        assert.equal(out.failed.length, 1);
        assert.equal(out.failed[0].error, 'The move may be half done: the original may still be in Office. Check it before moving again.');
        assert.ok(!writes().some(w => /^DELETE \/api\/networks\/net2\//.test(w)), 'the copy stays');
        const puts = calls.filter(c => c.method === 'PUT' && c.path === '/api/policies/pol-direct');
        assert.equal(puts.length, 1, 'the policy was pointed at the copy once');
        assert.notEqual(puts[0].body.rules[0].destinationResource.id, 'r1', 'and never pointed back');
    }
});

// ─── The resource editor ───
const tcp443 = (extra = {}) => ({ name: 'NAS Policy', description: '', enabled: true, protocol: 'tcp', ports: ['443'], sources: ['a'], bidirectional: false, postureChecks: [], ...extra });
function editorFixture() {
    baseline();
    NB.resources['net1/r1'] = { id: 'r1', name: 'NAS', address: '10.0.0.9', type: 'host', groups: [] };
    const rule = (extra = {}) => ({ name: 'NAS Policy', enabled: true, action: 'accept', bidirectional: false, protocol: 'tcp', ports: ['443'], sources: [g('a')], destinationResource: { id: 'r1', type: 'host' }, ...extra });
    NB.policies['pol-direct'] = { id: 'pol-direct', name: 'NAS Policy', description: '', enabled: true, source_posture_checks: [], rules: [rule()] };
    // The profile's policy was pointed at this resource directly (F12).
    NB.policies[PID] = { id: PID, name: 'Payroll Access', description: '', enabled: true, source_posture_checks: [], rules: [rule({ name: 'Payroll Access' })] };
}
const both = (a = {}, b = {}) => [{ id: 'pol-direct', ...tcp443(a) }, { id: PID, ...tcp443({ name: 'Payroll Access', ...b }) }];

test('an unchanged list changes nothing; an edited kept policy is updated in place, with the same id', async () => {
    editorFixture();
    await db.syncResourcePolicies('net1', 'r1', both());
    assert.deepEqual(writes(), [], 'no PUT for an unchanged policy');
    editorFixture();
    await db.syncResourcePolicies('net1', 'r1', both({ ports: ['8443'] }));
    assert.deepEqual(writes(), ['PUT /api/policies/pol-direct']);
    const put = calls.find(c => c.method === 'PUT');
    assert.deepEqual(put.body.rules[0].destinationResource, { id: 'r1', type: 'host' }, 'the server sets the target');
    assert.deepEqual(put.body.rules[0].ports, ['8443']);
});

test('a profile policy edited from the resource is a PUT on the same id', async () => {
    editorFixture();
    await db.syncResourcePolicies('net1', 'r1', both({}, { sources: ['a', 'b'] }));
    assert.deepEqual(writes(), [`PUT /api/policies/${PID}`]);
});

test('leaving out a profile policy is refused before anything is written', async () => {
    editorFixture();
    const list = [{ id: 'pol-direct', ...tcp443() }];
    await assert.rejects(db.checkResourcePolicySync('r1', list), (e) => e.status === 409 && e.code === 'PROFILE_POLICY'
        && e.message === 'Policy "Payroll Access" is also the policy of Access Profile "Payroll". Change or delete it in Access Profiles.');
    await assert.rejects(db.syncResourcePolicies('net1', 'r1', list), (e) => e.code === 'PROFILE_POLICY' && !e.partial);
    assert.deepEqual(writes(), []);
});

test('a dropped ordinary policy is deleted and a policy without an id is created', async () => {
    editorFixture();
    await db.syncResourcePolicies('net1', 'r1', [{ id: PID, ...tcp443({ name: 'Payroll Access' }) }, tcp443({ name: 'SSH', ports: ['22'] })]);
    assert.deepEqual(writes(), ['DELETE /api/policies/pol-direct', 'POST /api/policies']);
});

test('an id that is not one of this resource\'s policies, or sent twice, is refused before any write', async () => {
    editorFixture();
    NB.policies['pol-elsewhere'] = { id: 'pol-elsewhere', name: 'Other', enabled: true, rules: [{ sources: [g('a')], destinationResource: { id: 'r2' } }] };
    for (const list of [[...both(), { id: 'pol-elsewhere', ...tcp443() }], [...both(), { id: 'pol-direct', ...tcp443() }]]) {
        await assert.rejects(db.checkResourcePolicySync('r1', list), (e) => e.status === 400 && e.code === 'POLICY_NOT_OF_RESOURCE');
    }
    assert.deepEqual(writes(), []);
});

test('the editor sends a kept policy\'s PUT once; an unanswered one is a partial change, a 429 a plain refusal', async () => {
    editorFixture();
    await db.syncResourcePolicies('net1', 'r1', both({ ports: ['8443'] }));
    assert.deepEqual(calls.find(c => c.method === 'PUT').opts, { once: true });
    for (const answer of [{ status: 0, error: 'timeout' }, { status: 503, body: null }]) {
        editorFixture();
        NB.answers['PUT /api/policies/pol-direct'] = [answer];
        await assert.rejects(db.syncResourcePolicies('net1', 'r1', both({ ports: ['8443'] })),
            (e) => e.unconfirmed === true && e.partial === true, 'the route must not say nothing changed');
    }
    // With `once` a 429 is the answer (sent a single time): a refusal, nothing changed.
    editorFixture();
    NB.answers['PUT /api/policies/pol-direct'] = [{ status: 429, body: { message: 'too many requests', code: 429 } }, { status: 0, error: 'timeout' }];
    await assert.rejects(db.syncResourcePolicies('net1', 'r1', both({ ports: ['8443'] })),
        (e) => !e.unconfirmed && e.partial === false && /Failed to update policy/.test(e.message));
    assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});

test('a policy update NetBird did not answer (or answered 5xx) is unconfirmed, not a success', async () => {
    for (const answer of [{ status: 0, error: 'timeout' }, { status: 502, body: null }]) {
        editorFixture();
        NB.answers['PUT /api/policies/pol-direct'] = [answer];
        await assert.rejects(db.updatePolicy('pol-direct', { name: 'NAS Policy', ...tcp443(), destinationResource: { id: 'r1', type: 'host' } }),
            (e) => e.status === 502 && e.unconfirmed === true && e.code === 'POLICY_UPDATE_UNCONFIRMED');
    }
    editorFixture();
    NB.answers['PUT /api/policies/pol-direct'] = [{ status: 400, body: { message: 'bad' }, raw: 'bad' }];
    await assert.rejects(db.updatePolicy('pol-direct', { ...tcp443(), destinationResource: { id: 'r1' } }), (e) => !e.unconfirmed && /Failed to update policy/.test(e.message));
});

test('an admin changing a profile policy from the resource updates the profile row too; grants then use it', async () => {
    editorFixture();
    T.profiles = [profile({ protocol: 'tcp', ports: '443', sources: ['a'], posture_checks: [] })];
    await db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'], postureChecks: ['pc-1'] }));
    assert.deepEqual(writes(), [`PUT /api/policies/${PID}`]);
    const listed = (await db.listAccessProfiles()).find(p => p.id === 12);
    assert.equal(listed.protocol, 'tcp');
    assert.deepEqual(listed.ports, ['8443']);
    assert.deepEqual(listed.postureChecks, ['pc-1']);
    assert.deepEqual(listed.sources.map(s => s.id), ['a']);
    // A new temporary grant for the profile mirrors the new port and posture check.
    calls.length = 0;
    NB.lists['/api/users'] = [{ id: 'user-1', role: 'user', auto_groups: [] }];
    await db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'profile', id: '12' }] }, admin);
    const temp = calls.filter(c => c.method === 'POST' && c.path === '/api/policies').map(c => c.body);
    assert.equal(temp.length, 1);
    assert.deepEqual(temp[0].rules[0].ports, ['8443']);
    assert.deepEqual(temp[0].source_posture_checks, ['pc-1']);
    assert.deepEqual(temp[0].rules[0].destinations, [GID]);
});

const profileRowUpdates = () => log.filter(l => /^UPDATE access_profiles/.test(l.sql)).length;
const payrollRow = () => T.profiles.find(r => r.id === 12);

test('(a) a failed profile row update is partial; the same save again repairs the row without a PUT', async () => {
    editorFixture();
    T.profiles = [profile({ protocol: 'tcp', ports: '443', sources: ['a'], posture_checks: [] })];
    failSql = /^UPDATE access_profiles/;
    await assert.rejects(db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'] })),
        (e) => e.partial === true && e.code === 'PROFILE_SETTINGS_STALE' && e.message === "The profile's settings may be out of date. Save again to refresh them.");
    assert.equal(payrollRow().ports, '443', 'the row lags behind NetBird');
    failSql = null;
    calls.length = 0;
    await db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'] }));
    assert.deepEqual(writes(), [], 'NetBird already holds it: no PUT');
    assert.equal(payrollRow().ports, '8443', 'repaired from the policy NetBird holds');
});

test('(b) an unanswered PUT that landed syncs the row from the read-back; an unreadable read-back is partial, row untouched', async () => {
    const applied = () => ({ ...clone(NB.policies[PID]), rules: [{ ...clone(NB.policies[PID].rules[0]), ports: ['8443'] }] });
    editorFixture();
    T.profiles = [profile({ protocol: 'tcp', ports: '443', sources: ['a'], posture_checks: [] })];
    NB.answers[`PUT /api/policies/${PID}`] = [{ status: 0, error: 'timeout' }];
    NB.answers[`GET /api/policies/${PID}`] = [{ status: 200, body: clone(NB.policies[PID]) }, { status: 200, body: applied() }];
    await assert.rejects(db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'] })), (e) => e.unconfirmed === true && e.partial === true);
    assert.equal(payrollRow().ports, '8443', 'synced from what NetBird holds');
    editorFixture();
    T.profiles = [profile({ protocol: 'tcp', ports: '443', sources: ['a'], posture_checks: [] })];
    NB.answers[`PUT /api/policies/${PID}`] = [{ status: 0, error: 'timeout' }];
    NB.answers[`GET /api/policies/${PID}`] = [{ status: 200, body: clone(NB.policies[PID]) }, { status: 0, error: 'timeout' }];
    await assert.rejects(db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'] })), (e) => e.partial === true && e.code === 'PROFILE_SETTINGS_STALE');
    assert.equal(payrollRow().ports, '443', 'untouched');
    assert.equal(profileRowUpdates(), 0);
});

test('(c) the row takes the ports NetBird stored, and a new grant opens exactly those', async () => {
    editorFixture();
    T.profiles = [profile({ protocol: 'tcp', ports: '443', sources: ['a'], posture_checks: [] })];
    // "80,443" is not one port item: the policy builder drops it, so NetBird holds 22 only.
    await db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['80,443', '22'] }));
    assert.deepEqual(NB.policies[PID].rules[0].ports, ['22']);
    assert.equal(payrollRow().ports, '22');
    assert.deepEqual((await db.listAccessProfiles()).find(p => p.id === 12).ports, ['22']);
    calls.length = 0;
    NB.lists['/api/users'] = [{ id: 'user-1', role: 'user', auto_groups: [] }];
    await db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'profile', id: '12' }] }, admin);
    const temp = calls.filter(c => c.method === 'POST' && c.path === '/api/policies').map(c => c.body);
    assert.equal(temp.length, 1);
    assert.deepEqual(temp[0].rules[0].ports, ['22']);
    assert.equal(temp[0].rules[0].port_ranges, undefined);
});

test('(d) an ordinary policy PUT never touches access_profiles', async () => {
    editorFixture();
    delete NB.policies[PID]; // this resource has only an ordinary policy
    await db.syncResourcePolicies('net1', 'r1', [{ id: 'pol-direct', ...tcp443({ ports: ['8443'] }) }]);
    assert.deepEqual(writes(), ['PUT /api/policies/pol-direct']);
    assert.equal(profileRowUpdates(), 0);
});

test('the resource detail names the profile that owns a direct policy', async () => {
    editorFixture();
    NB.networks.net1 = { id: 'net1', name: 'Office', policies: [] };
    const detail = await db.getNetworkDetail('net1');
    const pols = detail.resources.find(r => r.id === 'r1').policies;
    assert.equal(pols.find(p => p.id === PID).profileName, 'Payroll');
    assert.equal(pols.find(p => p.id === 'pol-direct').profileName, undefined);
});

// ─── Automations ───
// The real sync engine with fake resource writers: deletes answer per network.
let deleteAnswers = {}; // network id → (resourceId) => throws or resolves
const deleted = [];
function automationFixture({ removalMode = 'delete', network = 'netB', realDelete = false } = {}) {
    baseline();
    deleted.length = 0;
    NB.resources[`${network}/r-keep`] = { id: 'r-keep', name: '10.0.0.1', address: '10.0.0.1', groups: [] };
    NB.resources['netA/r-old'] = { id: 'r-old', name: '10.0.0.2', address: '10.0.0.2', groups: [] };
    T.automationRow = { id: 1, name: 'Source', endpoint_url: 'https://source.test/list', source_format: 'text', network_id: network, removal_mode: removalMode, min_items: 0, profile_ids: [], name_prefix: '' };
    T.automationRes = [
        { automation_id: 1, external_key: '10.0.0.1', address: '10.0.0.1', resource_id: 'r-keep', network_id: network, status: 'active' },
        { automation_id: 1, external_key: '10.0.0.2', address: '10.0.0.2', resource_id: 'r-old', network_id: 'netA', status: 'active' },
    ];
    sourceText = '10.0.0.1';
    automations.initAutomations({
        listAccessProfiles: async () => [],
        getNetworkDetail: async () => ({ resources: [{ id: 'r-keep', name: '10.0.0.1', address: '10.0.0.1', enabled: true, groups: [] }] }),
        addResourceGroups: async () => false,
        setResourceEnabled: async () => { },
        renameResource: async () => { },
        createClientResource: async () => { throw new Error('not expected'); },
        deleteResource: realDelete
            ? (networkId, rid) => { deleted.push(`${networkId}/${rid}`); return db.deleteResource(networkId, rid); }
            : async (networkId, rid) => { deleted.push(`${networkId}/${rid}`); const f = deleteAnswers[networkId]; if (f) return f(rid); },
        recordAudit: async () => { },
        getDupAllowedNetworkIds: async () => [],
        assertProfilesExist: async () => { },
        resourceGoneConfirmed: db._internal.resourceGoneConfirmed,
    });
}
const tracked = () => T.automationRes.map(r => r.resource_id).sort();
const err = (props) => Object.assign(new Error(props.message || 'failed'), props);

test('automation removal: a refused or unconfirmed delete keeps the tracking row for the next run', async () => {
    for (const thrown of [err({ message: 'Failed to delete resource: in use' }), err({ status: 502, unconfirmed: true, message: "NetBird didn't confirm the delete." })]) {
        automationFixture();
        deleteAnswers = { netA: async () => { throw thrown; } };
        const out = await automations.runAutomation(1);
        assert.equal(out.failed, 1);
        assert.deepEqual(tracked(), ['r-keep', 'r-old']);
    }
});

test('automation removal deletes in the network the row recorded, never the automation\'s current one', async () => {
    // The automation now targets netB; the resource was created in netA.
    automationFixture();
    deleteAnswers = { netA: async () => { throw err({ status: 502, unconfirmed: true, message: "Couldn't read the resource from NetBird." }); } };
    await automations.runAutomation(1);
    assert.deepEqual(deleted, ['netA/r-old'], 'checked in the row\'s network');
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
});

test('automation removal: only NetBird\'s HTTP 404 on the resource path confirms it is gone (real answers)', async () => {
    // A real 404 whose body isn't JSON (the first read can't tell it from an outage): gone.
    automationFixture({ realDelete: true });
    NB.answers['GET /api/networks/netA/resources/r-old'] = [{ status: 404, body: null, raw: '404 page not found' }];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep'], 'confirmed gone');
    // A 502 whose body says code 404: not a confirmed absence.
    automationFixture({ realDelete: true });
    NB.answers['GET /api/networks/netA/resources/r-old'] = [{ status: 502, body: { message: 'resource not found', code: 404 } }];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
    // An unanswered DELETE with the resource still there: kept; found gone afterwards (404): removed.
    automationFixture({ realDelete: true });
    NB.answers['DELETE /api/networks/netA/resources/r-old'] = [{ status: 0, error: 'timeout' }];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
    automationFixture({ realDelete: true });
    NB.answers['DELETE /api/networks/netA/resources/r-old'] = [{ status: 0, error: 'timeout' }];
    NB.answers['GET /api/networks/netA/resources/r-old'] = [{ status: 200, body: NB.resources['netA/r-old'] }, notFound];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep']);
    // A delete that succeeds.
    automationFixture({ realDelete: true });
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep']);
    assert.ok(writes().includes('DELETE /api/networks/netA/resources/r-old'));
});

test('automation removal of a row without a recorded network: gone everywhere, undeterminable network, unreadable list', async () => {
    const setup = () => { automationFixture({ realDelete: true }); T.automationRes[1].network_id = ''; };
    setup();
    NB.lists['/api/networks/resources'] = [{ id: 'r-keep' }];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep'], 'absent from every network: gone');
    assert.deepEqual(deleted, []);
    setup();
    NB.lists['/api/networks/resources'] = [{ id: 'r-keep' }, { id: 'r-old' }];
    // No network lists it (and none leaves its resources unlisted): the network can't be determined.
    let out = await automations.runAutomation(1);
    assert.equal(out.failed, 1);
    assert.match(out.error, /this resource's network isn't recorded - delete it in NetBird, then run Repair/);
    assert.deepEqual(tracked(), ['r-keep', 'r-old'], 'still somewhere: kept');
    assert.deepEqual(deleted, [], 'never deleted in the automation\'s current network');
    // A network's own resource list can't be read: still undeterminable.
    setup();
    NB.lists['/api/networks/resources'] = [{ id: 'r-keep' }, { id: 'r-old' }];
    NB.networks = { netA: { id: 'netA', name: 'Old' } };
    NB.answers['GET /api/networks/netA/resources'] = [{ status: 500, body: { message: 'boom' } }];
    out = await automations.runAutomation(1);
    assert.match(out.error, /network isn't recorded/);
    assert.deepEqual(deleted, []);
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
    setup();
    NB.answers['GET /api/networks/resources'] = [{ status: 500, body: { message: 'boom' } }];
    out = await automations.runAutomation(1);
    assert.equal(out.failed, 1);
    assert.deepEqual(tracked(), ['r-keep', 'r-old'], 'unreadable: kept');
});

test('automation removal of a row without a recorded network deletes the resource in the network that holds it', async () => {
    const setup = () => {
        automationFixture({ realDelete: true });
        T.automationRes[1].network_id = '';
        NB.lists['/api/networks/resources'] = [{ id: 'r-keep' }, { id: 'r-old' }];
    };
    const gets = () => calls.filter(c => c.method === 'GET').map(c => c.path);
    // The networks list names each network's resources.
    setup();
    NB.networks = { netB: { id: 'netB', resources: ['r-keep'] }, netA: { id: 'netA', resources: ['r-old'] }, netC: { id: 'netC', resources: null } };
    await automations.runAutomation(1);
    assert.deepEqual(deleted, ['netA/r-old']);
    assert.deepEqual(tracked(), ['r-keep'], 'deleted, then the row goes');
    assert.ok(!gets().some(x => /^\/api\/networks\/net[BC]\/resources$/.test(x)), 'no per-network list read when the networks list says');
    // A network that doesn't list its resources: its own list is read.
    setup();
    NB.networks = { netA: { id: 'netA' } };
    await automations.runAutomation(1);
    assert.deepEqual(deleted, ['netA/r-old']);
    assert.deepEqual(tracked(), ['r-keep']);
    // The account-wide entry carries its network: no further read.
    setup();
    NB.lists['/api/networks/resources'] = [{ id: 'r-keep' }, { id: 'r-old', network_id: 'netA' }];
    await automations.runAutomation(1);
    assert.deepEqual(deleted, ['netA/r-old']);
    assert.ok(!gets().includes('/api/networks'));
    assert.deepEqual(tracked(), ['r-keep']);
    // Found, but the delete went unanswered and the resource is still there: the row stays.
    setup();
    NB.networks = { netA: { id: 'netA', resources: ['r-old'] } };
    NB.answers['DELETE /api/networks/netA/resources/r-old'] = [{ status: 0, error: 'timeout' }];
    const out = await automations.runAutomation(1);
    assert.equal(out.failed, 1);
    assert.deepEqual(deleted, ['netA/r-old']);
    assert.deepEqual(tracked(), ['r-keep', 'r-old'], 'unconfirmed: kept');
});

test('automation repair: a row whose network was deleted is an orphan; a resources 404 with the network still there fails', async () => {
    automationFixture();
    NB.answers['GET /api/networks/netA/resources'] = [notFound];
    assert.deepEqual(await automations.repairAutomation(1), { removed: 1 }, 'network netA is gone (404)');
    assert.deepEqual(tracked(), ['r-keep']);
    automationFixture();
    NB.answers['GET /api/networks/netA/resources'] = [notFound];
    NB.networks.netA = { id: 'netA', name: 'Old' };
    await assert.rejects(automations.repairAutomation(1), /could not read network resources/);
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
    automationFixture();
    NB.answers['GET /api/networks/netA/resources'] = [notFound];
    NB.answers['GET /api/networks/netA'] = [{ status: 502, body: { message: 'boom', code: 404 } }];
    await assert.rejects(automations.repairAutomation(1), /could not read network resources/);
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
});

test('automation repair checks a row without a recorded network against every network', async () => {
    automationFixture();
    T.automationRes[1].network_id = '';
    NB.lists['/api/networks/resources'] = [{ id: 'r-old' }];
    assert.deepEqual(await automations.repairAutomation(1), { removed: 0 });
    NB.lists['/api/networks/resources'] = [];
    assert.deepEqual(await automations.repairAutomation(1), { removed: 1 });
    automationFixture();
    T.automationRes[1].network_id = '';
    NB.answers['GET /api/networks/resources'] = [{ status: 0, error: 'timeout' }];
    await assert.rejects(automations.repairAutomation(1), /could not read network resources/);
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
});

test('automation repair checks each row in its own network and changes nothing when a read fails', async () => {
    automationFixture();
    assert.deepEqual(await automations.repairAutomation(1), { removed: 0 }, 'both live where their rows say');
    delete NB.resources['netA/r-old'];
    NB.answers['GET /api/networks/netA/resources'] = [{ status: 500, body: { message: 'boom' } }];
    await assert.rejects(automations.repairAutomation(1), /could not read network resources/);
    assert.deepEqual(tracked(), ['r-keep', 'r-old'], 'nothing removed');
    delete NB.answers['GET /api/networks/netA/resources'];
    assert.deepEqual(await automations.repairAutomation(1), { removed: 1 });
    assert.deepEqual(tracked(), ['r-keep']);
});

test('automation repair reads a JSON null resource list as an empty network', async () => {
    automationFixture();
    NB.answers['GET /api/networks/netA/resources'] = [{ status: 200, body: null, raw: 'null' }];
    assert.deepEqual(await automations.repairAutomation(1), { removed: 1 });
    assert.deepEqual(tracked(), ['r-keep']);
    // A 2xx whose body isn't JSON at all is still a failure.
    automationFixture();
    NB.answers['GET /api/networks/netA/resources'] = [{ status: 200, body: null, raw: '<html>' }];
    await assert.rejects(automations.repairAutomation(1), /could not read network resources/);
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
});

test('the tracking screen checks each row in its own network, not the automation\'s current target', async () => {
    // The automation targets netB now; r-old still lives in netA.
    automationFixture();
    let m = await automations.getAutomationManaged(1);
    assert.equal(m.networkKnown, true);
    assert.deepEqual(m.resources.map(r => [r.resourceId, r.orphan]).sort(), [['r-keep', false], ['r-old', false]]);
    assert.equal(m.resources.find(r => r.resourceId === 'r-old').name, '10.0.0.2');
    // Gone from its own network: an orphan.
    delete NB.resources['netA/r-old'];
    m = await automations.getAutomationManaged(1);
    assert.equal(m.resources.find(r => r.resourceId === 'r-old').orphan, true);
    // Its network can't be read: unknown, not an orphan.
    automationFixture();
    NB.answers['GET /api/networks/netA/resources'] = [{ status: 500, body: { message: 'boom' } }];
    m = await automations.getAutomationManaged(1);
    assert.equal(m.networkKnown, false);
    assert.equal(m.resources.find(r => r.resourceId === 'r-old').orphan, false);
    // A row without a recorded network: checked against every network.
    automationFixture();
    T.automationRes[1].network_id = '';
    NB.lists['/api/networks/resources'] = [{ id: 'r-keep' }];
    m = await automations.getAutomationManaged(1);
    assert.equal(m.resources.find(r => r.resourceId === 'r-old').orphan, true);
});

test('automation repair works without a current target network', async () => {
    automationFixture();
    T.automationRow.network_id = '';
    delete NB.resources['netA/r-old'];
    assert.deepEqual(await automations.repairAutomation(1), { removed: 1 });
    assert.deepEqual(tracked(), ['r-keep']);
});

test.after(() => { console.error = origError; });
