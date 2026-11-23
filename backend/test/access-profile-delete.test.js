// An Access Profile is never deleted while it is in use, its NetBird objects never go as a side
// effect of another write, and its row follows its policy:
//   - every "in use" reason refuses the delete (409 PROFILE_IN_USE with its label); a failed read
//     refuses it too, and nothing is deleted;
//   - an unused profile's rows go first, then its NetBird policy and group; one that NetBird didn't
//     confirm removing is reported as a leftover;
//   - deleting a resource keeps every profile group and policy, and reports a delete NetBird didn't
//     answer as unconfirmed; a move whose delete went unanswered keeps the copy;
//   - the resource editor updates a kept policy in place (same id) and refuses to drop a profile's;
//     a confirmed change of a profile's policy updates the profile's row;
//   - an automation keeps tracking a resource until it is deleted or confirmed gone in its network.
// The database and the NetBird client are in-memory stubs.
const test = require('node:test');
const assert = require('node:assert/strict');

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
let seq = 0;

// ─── In-memory database ───
let T;
function resetDb() {
    T = {
        profiles: [], defaults: [], automations: [], recurring: [], grants: [], requests: [], settings: {},
        automationRow: null, automationRes: [],
    };
}
resetDb();
const log = [];          // every statement: { seq, sql, params }
let failSql = null;      // RegExp: a matching statement throws
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const sameTenant = (r, t) => (r.tenant || '') === (t || '');
const ofPolicy = (id, t) => T.profiles.filter(r => r.policy_id === id && r.shared !== false && sameTenant(r, t));
function run(text, params = []) {
    const s = norm(text);
    log.push({ seq: ++seq, sql: s, params });
    if (failSql && failSql.test(s)) throw new Error('database unavailable');
    if (s.startsWith('SELECT id, name, group_id, policy_id, shared FROM access_profiles WHERE id = $1')) return { rows: clone(T.profiles.filter(p => p.id === params[0] && (p.tenant || '') === params[1])) };
    if (s.startsWith('SELECT id, name, group_id, policy_id, shared FROM access_profiles WHERE tenant = $1')) return { rows: clone(T.profiles.filter(p => (p.tenant || '') === params[0])) };
    if (s.startsWith('SELECT id FROM access_profiles WHERE tenant = $1')) {
        return { rows: T.profiles.filter(p => sameTenant(p, params[0]) && (!/shared IS NOT FALSE/.test(s) || p.shared !== false)).map(p => ({ id: p.id })) };
    }
    if (s.startsWith('SELECT name, group_id, policy_id FROM access_profiles')) return { rows: clone(T.profiles.filter(p => p.shared !== false)) };
    if (s.startsWith('SELECT name, policy_id FROM access_profiles')) return { rows: clone(T.profiles.filter(p => p.shared !== false && (p.tenant || '') === params[0])) };
    if (s.startsWith('SELECT id, name, group_id, policy_id, sources')) return { rows: clone(T.profiles.filter(p => (p.tenant || '') === params[0])) };
    if (s.startsWith('DELETE FROM network_default_profiles WHERE profile_id')) { T.defaults = T.defaults.filter(d => d.profile_id !== params[0]); return { rows: [] }; }
    if (s.startsWith('DELETE FROM access_profiles')) { T.profiles = T.profiles.filter(p => !(p.id === params[0] && (p.tenant || '') === params[1])); return { rows: [] }; }
    if (s.startsWith('UPDATE access_profiles SET posture_checks = $2, protocol = CASE WHEN (group_id = ANY($6::text[]) OR $7::boolean) THEN $3')) {
        const [pid, posture, protocol, ports, sources, destinations, direct, tenant] = params;
        for (const r of ofPolicy(pid, tenant)) {
            r.posture_checks = JSON.parse(posture);
            if (destinations.includes(r.group_id) || direct) Object.assign(r, { protocol, ports, sources: JSON.parse(sources) });
        }
        return { rows: [] };
    }
    if (s === 'UPDATE access_profiles SET name = $2, sources = $3, protocol = $4, ports = $5, posture_checks = $6 WHERE id = $1 AND tenant = $7') {
        for (const r of T.profiles) if (r.id === params[0] && sameTenant(r, params[6])) Object.assign(r, { name: params[1], sources: JSON.parse(params[2]), protocol: params[3], ports: params[4], posture_checks: JSON.parse(params[5]) });
        return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT group_id, policy_id, shared FROM access_profiles WHERE id = $1 AND tenant = $2')) return { rows: clone(T.profiles.filter(p => p.id === params[0] && (p.tenant || '') === params[1])) };
    if (/nextval\(pg_get_serial_sequence\('temporary_access_grants'/.test(s) || s.startsWith('UPDATE temporary_access_grants')) return { rows: [{ id: 501 }] };
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
core.pool.query = async (q, params) => run(typeof q === 'string' ? q : q.text, params || (q && q.values) || []);

// ─── In-memory NetBird ───
let NB;
function resetNb() {
    NB = { groups: {}, policies: {}, lists: {}, resources: {}, networks: {}, answers: {} };
}
resetNb();
const calls = []; // { seq, method, path, body }
const notFound = { status: 404, body: { message: 'not found', code: 404 } };
let postN = 0;
function nbAnswer(method, path, body) {
    calls.push({ seq: ++seq, method, path, body: clone(body) });
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
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
nb.netbirdReq = async (method, path, body) => nbAnswer(method, path, body);
nb.netbirdGet = async (path) => { const r = nbAnswer('GET', path); return r.status === 0 ? null : r.body; };
nb.netbirdPost = async (path, body) => nbAnswer('POST', path, body);

// The automation source (lib/automations.js reads it through lib/http).
let sourceText = '';
require('../lib/http').httpJson = async () => ({ status: 200, raw: sourceText });

const origError = console.error;
console.error = () => { };
test.after(() => { console.error = origError; });
const db = require('../db');
const automations = require('../lib/automations');
const remoteAccess = require('../lib/remote-access');

// ─── Fixtures ───
const GID = 'grp-prof';
const PID = 'pol-prof';
const profile = (extra = {}) => ({ id: 12, name: 'Payroll', group_id: GID, policy_id: PID, shared: true, tenant: '', ...extra });
const directProfile = { id: 12, name: 'Ports', group_id: '', policy_id: '', shared: false, tenant: '' };
const g = (id) => ({ id, name: id.toUpperCase() });
function baseline() {
    resetDb(); resetNb(); log.length = 0; calls.length = 0; failSql = null;
    remoteAccess._internal.setConfigForTest({});
    T.profiles = [profile()];
    NB.groups[GID] = { id: GID, name: 'Payroll', resources_count: 0, peers_count: 0, resources: [], peers: [] };
    NB.policies[PID] = { id: PID, name: 'Payroll Access', enabled: true, rules: [{ name: 'Payroll', enabled: true, action: 'accept', protocol: 'tcp', ports: ['443'], sources: [g('staff')], destinations: [g(GID)] }] };
    for (const p of ['/api/setup-keys', '/api/networks/routers', '/api/routes', '/api/dns/nameservers', '/api/users', '/api/reverse-proxies/services']) NB.lists[p] = [];
}
// The auto-approval config is the one loaded in memory, so it outlives a test.
const autoApproval = (cfg) => { T.settings.auto_approval_config = JSON.stringify(cfg); return db._internal.loadAutoApproval(); };
test.afterEach(() => autoApproval({ trusted: [], rules: [] }));
const admin = { user_id: 'u-admin', email: 'admin@example.test', name: 'Admin' };
const DELETED = { name: 'Payroll', leftover: [] };
const writes = () => calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`);
const inUse = (re) => (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'PROFILE_IN_USE');
    assert.match(e.message, re);
    assert.match(e.message, /Remove it from them first\.$/);
    return true;
};
async function refused(re) {
    await assert.rejects(db.deleteAccessProfile(12), inUse(re));
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
    NB.groups[GID].resources_count = 0;
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
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
    await refused(/which also grants other destinations/);
});

test('a temporary grant to the profile group refuses the delete; an ended one does not', async () => {
    baseline();
    T.grants = [{ user_id: 'u1', user_label: 'Dana', status: 'active', targets: [{ type: 'group', id: GID }] }];
    await refused(/temporary access for Dana/);
    baseline();
    T.grants = [{ user_id: 'u1', user_label: 'Dana', status: 'revoked', targets: [{ type: 'group', id: GID }] }];
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
});

test('a grant to the profile refuses the delete, also while creating', async () => {
    baseline();
    T.grants = [{ user_id: 'u1', user_label: 'Dana', status: 'creating', targets: [{ type: 'profile', id: '12' }] }];
    await refused(/temporary access for Dana/);
    baseline();
    T.grants = [{ user_id: 'u2', user_label: 'Avi', status: 'active', targets: [{ type: 'profile', id: 12, groupId: GID }] }];
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
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
});

test('requests and auto-approval are main-account data: a tenant profile with the same id is not held by them', async () => {
    baseline();
    T.profiles = [profile({ tenant: 't1' })];
    T.requests = [{ requester_id: 'u1', requester_name: 'Dana', status: 'pending', targets: [{ type: 'profile', id: '12' }] }];
    await autoApproval({ trusted: [], rules: [{ targets: [{ type: 'profile', id: '12', name: 'Payroll' }], groupIds: ['g1'] }] });
    assert.deepEqual(await nb.runWithTenant('t1', () => db.deleteAccessProfile(12)), DELETED);
});

test('auto-approval rules refuse the delete - legacy targetType rules and paused rules; excluded targets do not', async () => {
    baseline();
    await autoApproval({ maxMinutes: 60, trustedGroupIds: [], rules: [{ targetType: 'profile', targetId: '12', targetName: 'Payroll', groupIds: ['g1'] }] });
    await refused(/an auto-approval rule/);
    baseline();
    await autoApproval({ trusted: [], rules: [{ enabled: false, targets: [{ type: 'profile', id: '12', name: 'Payroll' }], groupIds: ['g1'] }] });
    await refused(/an auto-approval rule/);
    baseline();
    await autoApproval({ trusted: [{ groupIds: ['g1'], excludedTargets: [{ type: 'profile', id: '12', name: 'Payroll' }] }], rules: [] });
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
});

test('an auto-approval rule does not hold a Direct profile', async () => {
    baseline();
    T.profiles = [directProfile];
    await autoApproval({ trusted: [], rules: [{ targets: [{ type: 'profile', id: '12', name: 'Ports' }], groupIds: ['g1'] }] });
    assert.deepEqual(await db.deleteAccessProfile(12), { name: 'Ports', leftover: [] });
});

test('a recurring rule naming a Direct preset does not hold it', async () => {
    baseline();
    T.profiles = [directProfile];
    T.recurring = [{ user_id: 'u1', user_label: 'Dana', targets: [{ type: 'profile', id: '12', name: 'Ports' }] }];
    assert.deepEqual(await db.deleteAccessProfile(12), { name: 'Ports', leftover: [] });
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
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
    assert.equal(T.defaults.length, 0, 'the stale default row went with the profile');
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
    await assert.rejects(db.deleteAccessProfile(12), (e) => e.status === 502 && e.code === 'PROFILE_USAGE_UNREADABLE', label);
    assert.deepEqual(writes(), [], label);
    assert.equal(T.profiles.length, 1, `${label}: not deleted`);
};

test('a 404 from /api/routes or the reverse-proxy services is none; a 500 on them, or a 404 from any other list, refuses', async () => {
    for (const path of ['/api/routes', '/api/reverse-proxies/services']) {
        baseline();
        NB.answers['GET ' + path] = [notFound];
        assert.deepEqual(await db.deleteAccessProfile(12), DELETED, `${path} 404`);
        baseline();
        NB.answers['GET ' + path] = [{ status: 500, body: { message: 'boom' } }];
        await unreadable(`${path} 500`);
    }
    for (const path of ['/api/setup-keys', '/api/users', '/api/dns/nameservers', '/api/groups', '/api/policies', '/api/networks/routers']) {
        baseline();
        NB.answers['GET ' + path] = [notFound];
        await unreadable(`${path} 404`);
    }
});

test('a JSON null router list is an empty one', async () => {
    baseline();
    NB.answers['GET /api/networks/routers'] = [{ status: 200, body: null, raw: 'null' }];
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
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
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
});

test('several reasons are listed together', async () => {
    baseline();
    NB.groups[GID].resources_count = 12;
    T.recurring = [{ user_id: 'u1', user_label: 'Dana', targets: [{ type: 'profile', id: '12' }] }];
    await refused(/^This profile is in use by 12 resources and recurring access for Dana\. Remove it from them first\.$/);
});

test('any failed read refuses the delete, and nothing is deleted', async () => {
    const nbUnreadable = (e) => e.status === 502 && e.code === 'PROFILE_USAGE_UNREADABLE' && /nothing was deleted/.test(e.message);
    const failures = [
        [() => { NB.answers['GET /api/groups'] = [{ status: 500, body: { message: 'boom' } }]; }, nbUnreadable],
        [() => { NB.answers['GET /api/groups'] = [notFound]; }, nbUnreadable],
        [() => { NB.answers['GET /api/policies'] = [{ status: 0, error: 'timeout' }]; }, nbUnreadable],
        [() => { NB.answers['GET /api/routes'] = [{ status: 500, body: { message: 'boom' } }]; }, nbUnreadable],
        [() => { NB.answers['GET /api/setup-keys'] = [{ status: 0, error: 'timeout' }]; }, nbUnreadable],
        [() => { NB.answers['GET /api/networks/routers'] = [{ status: 500, body: { message: 'boom' } }]; }, nbUnreadable],
        [() => { NB.answers['GET /api/users'] = [{ status: 200, body: { message: 'not a list' } }]; }, nbUnreadable],
        [() => { T.defaults = [{ network_id: 'net-1', profile_id: 12 }]; NB.answers['GET /api/networks'] = [{ status: 502, body: null }]; }, nbUnreadable],
        [() => { failSql = /FROM network_default_profiles/; }, /database unavailable/],
        [() => { failSql = /FROM automations/; }, /database unavailable/],
        [() => { failSql = /FROM recurring_access/; }, /database unavailable/],
        [() => { failSql = /FROM temporary_access_grants/; }, /database unavailable/],
        [() => { failSql = /FROM access_requests/; }, /database unavailable/],
    ];
    for (const [fail, expected] of failures) {
        baseline();
        fail();
        await assert.rejects(db.deleteAccessProfile(12), expected);
        assert.deepEqual(writes(), []);
        assert.equal(T.profiles.length, 1);
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
test('an unused profile: its rows go first, then its policy and its group', async () => {
    baseline();
    T.defaults = [{ network_id: 'net-gone', profile_id: 12 }, { network_id: 'net-1', profile_id: 99 }];
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
    const dels = calls.filter(c => c.method === 'DELETE');
    assert.deepEqual(dels.map(c => c.path), [`/api/policies/${PID}`, `/api/groups/${GID}`], 'policy first, then group');
    const row = log.find(l => /^DELETE FROM access_profiles/.test(l.sql));
    assert.ok(row.seq < dels[0].seq, 'the row is deleted before the first NetBird delete');
    assert.equal(T.profiles.length, 0);
    assert.deepEqual(T.defaults, [{ network_id: 'net-1', profile_id: 99 }], "only this profile's defaults");
});

test('a failed row delete keeps the row and sends nothing to NetBird', async () => {
    baseline();
    failSql = /^DELETE FROM access_profiles/;
    await assert.rejects(db.deleteAccessProfile(12), /database unavailable/);
    assert.equal(T.profiles.length, 1, 'still there');
    assert.deepEqual(writes(), []);
});

test('a NetBird object whose delete was not confirmed is reported as a leftover; an absent one is not', async () => {
    baseline();
    NB.answers[`DELETE /api/groups/${GID}`] = [{ status: 0, error: 'timeout' }];
    assert.deepEqual(await db.deleteAccessProfile(12), { name: 'Payroll', leftover: [{ kind: 'group', id: GID, name: 'Payroll' }] });
    assert.equal(T.profiles.length, 0, 'the profile is deleted');
    baseline();
    NB.answers[`DELETE /api/policies/${PID}`] = [{ status: 429, body: { message: 'too many requests', code: 429 } }];
    assert.deepEqual(await db.deleteAccessProfile(12), { name: 'Payroll', leftover: [{ kind: 'policy', id: PID, name: 'Payroll Access' }] });
    assert.deepEqual(writes(), [`DELETE /api/policies/${PID}`, `DELETE /api/groups/${GID}`], 'the group is still removed');
    baseline();
    NB.answers[`DELETE /api/policies/${PID}`] = [notFound];
    NB.answers[`DELETE /api/groups/${GID}`] = [notFound];
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
});

test('a Direct profile is deleted without any NetBird call; a missing profile is a no-op', async () => {
    baseline();
    T.profiles = [directProfile];
    assert.deepEqual(await db.deleteAccessProfile(12), { name: 'Ports', leftover: [] });
    assert.deepEqual(calls, []);
    assert.equal(await db.deleteAccessProfile(12), null);
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
});

test('a profile policy that targets the resource directly is never deleted with it', async () => {
    resourceFixture();
    NB.policies[PID].rules = [{ sources: [g('staff')], destinationResource: { id: 'r1', type: 'host' } }];
    await db.deleteResource('net1', 'r1');
    assert.ok(!writes().includes(`DELETE /api/policies/${PID}`));
});

test('an unanswered, 5xx or 429 resource delete is unconfirmed (main account and tenant); another 4xx is a refusal; a 404 is done', async () => {
    for (const ctx of [(fn) => fn(), (fn) => nb.runWithTenant('t1', fn)]) {
        for (const answer of [{ status: 0, error: 'timeout' }, { status: 503, body: null }, { status: 429, body: null }]) {
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

test('a move whose delete went unanswered keeps the copy and says the move may be half done', async () => {
    for (const answer of [{ status: 0, error: 'timeout' }, { status: 503, body: null }, { status: 429, body: null }]) {
        resourceFixture();
        NB.networks.net2 = { id: 'net2', name: 'Lab' };
        NB.networks.net1 = { id: 'net1', name: 'Office' };
        NB.answers['DELETE /api/networks/net1/resources/r1'] = [answer];
        const out = await db.moveResources('net1', ['r1'], 'net2');
        assert.deepEqual(out.moved, []);
        assert.deepEqual(out.failed.map(f => f.error), ['The move may be half done: the original may still be in its network. Check it before moving again.']);
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
    T.profiles = [profile({ protocol: 'tcp', ports: '443', sources: ['a'], posture_checks: [] })];
    NB.policies['pol-direct'] = { id: 'pol-direct', name: 'NAS Policy', description: '', enabled: true, source_posture_checks: [], rules: [rule()] };
    NB.policies[PID] = { id: PID, name: 'Payroll Access', description: '', enabled: true, source_posture_checks: [], rules: [rule({ name: 'Payroll Access' })] };
}
const both = (a = {}, b = {}) => [{ id: 'pol-direct', ...tcp443(a) }, { id: PID, ...tcp443({ name: 'Payroll Access', ...b }) }];

test('an unchanged ordinary policy is not sent; an edited one is updated in place, with the same id', async () => {
    editorFixture();
    await db.syncResourcePolicies('net1', 'r1', both(), { isAdmin: false });
    assert.deepEqual(writes(), [], 'no PUT for an unchanged policy');
    await db.syncResourcePolicies('net1', 'r1', both({ ports: ['8443'] }), { isAdmin: false });
    assert.deepEqual(writes(), ['PUT /api/policies/pol-direct']);
    const put = calls.find(c => c.method === 'PUT');
    assert.deepEqual(put.body.rules[0].destinationResource, { id: 'r1', type: 'host' }, 'the server sets the target');
    assert.deepEqual(put.body.rules[0].ports, ['8443']);
});

test("an admin's save sends a profile policy on its own id, also when it is unchanged", async () => {
    for (const edit of [{}, { sources: ['a', 'b'] }]) {
        editorFixture();
        await db.syncResourcePolicies('net1', 'r1', both({}, edit), { isAdmin: true });
        assert.deepEqual(writes(), [`PUT /api/policies/${PID}`]);
    }
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
    assert.deepEqual(writes(), [`PUT /api/policies/${PID}`, 'DELETE /api/policies/pol-direct', 'POST /api/policies']);
});

test('an id that is not one of this resource\'s policies, or sent twice, is refused before any write', async () => {
    editorFixture();
    NB.policies['pol-elsewhere'] = { id: 'pol-elsewhere', name: 'Other', enabled: true, rules: [{ sources: [g('a')], destinationResource: { id: 'r2' } }] };
    for (const list of [[...both(), { id: 'pol-elsewhere', ...tcp443() }], [...both(), { id: 'pol-direct', ...tcp443() }]]) {
        await assert.rejects(db.checkResourcePolicySync('r1', list), (e) => e.status === 400 && e.code === 'POLICY_NOT_OF_RESOURCE');
    }
    assert.deepEqual(writes(), []);
});

test('an unanswered PUT of the editor is a partial change; a refused one changed nothing', async () => {
    const save = () => db.syncResourcePolicies('net1', 'r1', both({ ports: ['8443'] }), { isAdmin: false });
    for (const answer of [{ status: 0, error: 'timeout' }, { status: 503, body: null }]) {
        editorFixture();
        NB.answers['PUT /api/policies/pol-direct'] = [answer];
        await assert.rejects(save(), (e) => e.code === 'POLICY_UPDATE_UNCONFIRMED' && e.unconfirmed === true && e.partial === true, 'the route must not say nothing changed');
    }
    editorFixture();
    NB.answers['PUT /api/policies/pol-direct'] = [{ status: 422, body: { message: 'invalid' }, raw: 'invalid' }];
    await assert.rejects(save(), (e) => !e.unconfirmed && e.partial === false && /Failed to update policy: invalid/.test(e.message));
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

const payrollRow = () => T.profiles.find(r => r.id === 12);
const tempPolicies = () => calls.filter(c => c.method === 'POST' && c.path === '/api/policies').map(c => c.body);
const grantPayroll = async () => {
    calls.length = 0;
    NB.lists['/api/users'] = [{ id: 'user-1', role: 'user', auto_groups: [] }];
    await db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'profile', id: '12' }] }, admin);
    assert.equal(tempPolicies().length, 1);
    return tempPolicies()[0];
};

test('an admin changing a profile policy from the resource updates the profile row too; grants then use it', async () => {
    editorFixture();
    await db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'], postureChecks: ['pc-1'], sources: ['a', 'b'] }));
    assert.deepEqual(writes(), [`PUT /api/policies/${PID}`]);
    const listed = (await db.listAccessProfiles()).find(p => p.id === 12);
    assert.equal(listed.protocol, 'tcp');
    assert.deepEqual(listed.ports, ['8443']);
    assert.deepEqual(listed.postureChecks, ['pc-1']);
    assert.deepEqual(listed.sources.map(x => x.id), ['a', 'b']);
    const temp = await grantPayroll();
    assert.deepEqual(temp.rules[0].ports, ['8443']);
    assert.deepEqual(temp.source_posture_checks, ['pc-1']);
    assert.deepEqual(temp.rules[0].destinations, [GID]);
});

test('a failed profile row write after a confirmed PUT is unconfirmed; saving again brings the row up to date', async () => {
    editorFixture();
    const save = () => db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'] }));
    failSql = /^UPDATE access_profiles/;
    await assert.rejects(save(), (e) => e.unconfirmed === true && e.partial === true && e.status === 502
        && e.message === "The policy was saved, but its Access Profile couldn't be updated. Save it again.");
    failSql = null;
    assert.deepEqual(NB.policies[PID].rules[0].ports, ['8443']);
    assert.equal(payrollRow().ports, '443', 'the row lags behind NetBird');
    calls.length = 0;
    await save();
    assert.deepEqual(writes(), [`PUT /api/policies/${PID}`], 'sent although NetBird already holds it');
    assert.equal(payrollRow().ports, '8443');
});

const UNANSWERED = [{ status: 0, error: 'timeout' }, { status: 503, body: null }, { status: 429, body: null }];

test('an unanswered PUT of a profile policy leaves the row as it was; saving again brings it up to date', async () => {
    const save = () => db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'] }));
    for (const answer of UNANSWERED) {
        editorFixture();
        NB.answers[`PUT /api/policies/${PID}`] = [answer];
        await assert.rejects(save(), (e) => e.code === 'POLICY_UPDATE_UNCONFIRMED' && e.unconfirmed === true && e.partial === true);
        assert.equal(payrollRow().ports, '443', 'untouched');
        assert.ok(!log.some(l => /^UPDATE access_profiles/.test(l.sql)));
    }
    // The PUT landed after all.
    delete NB.answers[`PUT /api/policies/${PID}`];
    NB.policies[PID].rules[0].ports = ['8443'];
    await save();
    assert.equal(payrollRow().ports, '8443');
});

test('the row takes the ports that were sent to NetBird, and a new grant opens exactly those', async () => {
    editorFixture();
    // "80,443" is not one port item: the policy builder drops it, so NetBird holds 22 only.
    await db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['80,443', '22'] }));
    assert.deepEqual(NB.policies[PID].rules[0].ports, ['22']);
    assert.equal(payrollRow().ports, '22');
    assert.deepEqual((await db.listAccessProfiles()).find(p => p.id === 12).ports, ['22']);
    const temp = await grantPayroll();
    assert.deepEqual(temp.rules[0].ports, ['22']);
    assert.equal(temp.rules[0].port_ranges, undefined);
});

test('an ordinary policy PUT leaves every profile row as it was', async () => {
    editorFixture();
    delete NB.policies[PID];
    const before = clone(T.profiles);
    await db.syncResourcePolicies('net1', 'r1', [{ id: 'pol-direct', ...tcp443({ ports: ['8443'] }) }]);
    assert.deepEqual(writes(), ['PUT /api/policies/pol-direct']);
    assert.deepEqual(T.profiles, before);
});

test("a resource save writes only the active account's profile rows", async () => {
    editorFixture();
    T.profiles.push(profile({ id: 40, tenant: 'tenant-a', protocol: 'tcp', ports: '443', sources: ['a'], posture_checks: [] }));
    const other = clone(T.profiles[1]);
    await db.syncResourcePolicies('net1', 'r1', both({}, { ports: ['8443'], postureChecks: ['pc-1'] }));
    assert.equal(payrollRow().ports, '8443');
    assert.deepEqual(T.profiles[1], other, "another account's row is not updated");
});

test("a network editor's save never changes a profile policy, also when the policy changed after the route's check", async () => {
    editorFixture();
    const changed = both({ ports: ['22'] }, { ports: ['8443'] });
    await assert.rejects(db.checkResourcePolicySync('r1', changed, { isAdmin: false, resourceName: 'NAS' }),
        (e) => e.status === 403 && e.code === 'PROFILE_POLICY_ADMIN_ONLY' && e.message === 'Only an admin can change the policy of Access Profile Payroll.');
    await db.checkResourcePolicySync('r1', both({ ports: ['22'] }), { isAdmin: false, resourceName: 'NAS' });
    assert.deepEqual(writes(), []);
    await db.syncResourcePolicies('net1', 'r1', changed, { isAdmin: false });
    assert.deepEqual(writes(), ['PUT /api/policies/pol-direct'], 'no PUT to the profile policy');
    assert.equal(payrollRow().ports, '443');
});

test('the check before a resource save reads the profile rows, so a failed read refuses before the route writes anything', async () => {
    editorFixture();
    failSql = /FROM access_profiles/;
    await assert.rejects(db.checkResourcePolicySync('r1', both()), /database unavailable/);
    await assert.rejects(db.syncResourcePolicies('net1', 'r1', both({ ports: ['8443'] })), /database unavailable/);
    assert.deepEqual(writes(), []);
    failSql = null;
    assert.deepEqual([...(await db.checkResourcePolicySync('r1', both())).profileOwned], [PID]);
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
let deleteAnswers = {}; // network id → (resourceId) => throws or resolves
const deleted = [];
function automationFixture({ realDelete = false } = {}) {
    baseline();
    deleted.length = 0;
    NB.resources['netB/r-keep'] = { id: 'r-keep', name: '10.0.0.1', address: '10.0.0.1', groups: [] };
    NB.resources['netA/r-old'] = { id: 'r-old', name: '10.0.0.2', address: '10.0.0.2', groups: [] };
    T.automationRow = { id: 1, name: 'Source', endpoint_url: 'https://source.test/list', source_format: 'text', network_id: 'netB', removal_mode: 'delete', min_items: 0, profile_ids: [], name_prefix: '' };
    T.automationRes = [
        { automation_id: 1, external_key: '10.0.0.1', address: '10.0.0.1', resource_id: 'r-keep', network_id: 'netB', status: 'active' },
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
    automationFixture({ realDelete: true });
    NB.answers['GET /api/networks/netA/resources/r-old'] = [{ status: 502, body: { message: 'resource not found', code: 404 } }];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep', 'r-old'], 'a 502 confirms nothing, whatever its body says');
    automationFixture({ realDelete: true });
    NB.answers['DELETE /api/networks/netA/resources/r-old'] = [{ status: 0, error: 'timeout' }];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep', 'r-old'], 'unanswered, and still there');
    automationFixture({ realDelete: true });
    NB.answers['DELETE /api/networks/netA/resources/r-old'] = [{ status: 0, error: 'timeout' }];
    NB.answers['GET /api/networks/netA/resources/r-old'] = [{ status: 200, body: NB.resources['netA/r-old'] }, notFound];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep'], 'unanswered, then found gone');
    automationFixture({ realDelete: true });
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep']);
    assert.ok(writes().includes('DELETE /api/networks/netA/resources/r-old'));
});

test("automation removal: a refused delete closes the row only on NetBird's 404", async () => {
    const path = '/api/networks/netA/resources/r-old';
    // In the network launch links use, only an admin's delete is sent.
    const guarded = () => {
        automationFixture({ realDelete: true });
        remoteAccess._internal.setConfigForTest({ networks: ['netA'], createResources: { enabled: true, networkId: 'netA', profileId: 12, groupId: GID } });
    };
    guarded();
    NB.answers[`GET ${path}`] = [notFound];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep']);
    assert.ok(!writes().some(w => w.startsWith('DELETE')), 'no DELETE sent');
    for (const answer of [null, { status: 502, body: { message: 'down', code: 404 } }]) {
        guarded();
        if (answer) NB.answers[`GET ${path}`] = [answer];
        const out = await automations.runAutomation(1);
        assert.equal(out.failed, 1);
        assert.deepEqual(tracked(), ['r-keep', 'r-old']);
        assert.ok(!writes().some(w => w.startsWith('DELETE')), 'no DELETE sent');
        assert.equal(calls.filter(c => c.method === 'GET' && c.path === path).length, 1, 'read once');
    }
    const refusedByNetBird = () => {
        automationFixture({ realDelete: true });
        NB.answers[`DELETE ${path}`] = [{ status: 422, body: { message: 'in use' }, raw: 'in use' }];
    };
    refusedByNetBird();
    const out = await automations.runAutomation(1);
    assert.equal(out.failed, 1);
    assert.deepEqual(tracked(), ['r-keep', 'r-old']);
    refusedByNetBird();
    NB.answers[`GET ${path}`] = [{ status: 200, body: NB.resources['netA/r-old'] }, notFound];
    await automations.runAutomation(1);
    assert.deepEqual(tracked(), ['r-keep']);
});

test('automation repair: a row whose network was deleted is an orphan; a resources 404 with the network still there fails', async () => {
    automationFixture();
    NB.networks.netB = { id: 'netB', name: 'New' };
    NB.answers['GET /api/networks/netA/resources'] = [notFound];
    assert.deepEqual(await automations.repairAutomation(1), { removed: 1 }, 'network netA is not in the list');
    assert.deepEqual(tracked(), ['r-keep']);
    const notDeleted = [
        () => { NB.networks.netA = { id: 'netA', name: 'Old' }; },
        () => { NB.answers['GET /api/networks'] = [{ status: 502, body: { message: 'boom', code: 404 } }]; },
        () => { NB.answers['GET /api/networks'] = [notFound]; },
        () => { NB.answers['GET /api/networks/netA/resources'] = [{ status: 502, body: { message: 'boom', code: 404 } }]; },
    ];
    for (const setup of notDeleted) {
        automationFixture();
        NB.answers['GET /api/networks/netA/resources'] = [notFound];
        setup();
        await assert.rejects(automations.repairAutomation(1), /could not read network resources/);
        assert.deepEqual(tracked(), ['r-keep', 'r-old']);
    }
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
    delete NB.resources['netA/r-old'];
    m = await automations.getAutomationManaged(1);
    assert.equal(m.resources.find(r => r.resourceId === 'r-old').orphan, true);
    automationFixture();
    NB.answers['GET /api/networks/netA/resources'] = [{ status: 500, body: { message: 'boom' } }];
    m = await automations.getAutomationManaged(1);
    assert.equal(m.networkKnown, false);
    assert.equal(m.resources.find(r => r.resourceId === 'r-old').orphan, false);
    automationFixture();
    NB.answers['GET /api/networks/netA/resources'] = [notFound];
    m = await automations.getAutomationManaged(1);
    assert.equal(m.networkKnown, true);
    assert.equal(m.resources.find(r => r.resourceId === 'r-old').orphan, true);
});

test('automation repair works without a current target network', async () => {
    automationFixture();
    T.automationRow.network_id = '';
    delete NB.resources['netA/r-old'];
    assert.deepEqual(await automations.repairAutomation(1), { removed: 1 });
    assert.deepEqual(tracked(), ['r-keep']);
});

// ─── Remote Access launch links use a profile ───
const RA_USE = /Remote Access launch links \(choose another profile in Settings > Remote Access\)/;
const raSettings = (createResources) => remoteAccess._internal.setConfigForTest({ networks: [], createResources });

test('the profile Remote Access uses is in use: the delete is refused and the usage route says why', async () => {
    baseline();
    raSettings({ enabled: true, networkId: 'n-ra', profileId: 12, groupId: GID });
    await refused(RA_USE);
    const usage = await db.getAccessProfileUsage();
    assert.deepEqual(usage['12'].reasons, [{ kind: 'remoteAccess', label: 'Remote Access launch links (choose another profile in Settings > Remote Access)' }]);
    raSettings({ enabled: false, profileId: 12, groupId: GID });
    await refused(RA_USE);
});

test('a profile Remote Access did not choose can be deleted, and no choice marks no profile', async () => {
    baseline();
    T.profiles.push(profile({ id: 50, name: 'Chosen', group_id: 'grp-50', policy_id: 'pol-50' }));
    raSettings({ profileId: 50, groupId: 'grp-50' });
    assert.deepEqual(await db.deleteAccessProfile(12), DELETED);
    baseline();
    T.profiles.push({ ...directProfile, id: 13 });
    raSettings({ profileId: 0, groupId: '' });
    const usage = await db.getAccessProfileUsage();
    assert.deepEqual(usage, { 12: { reasons: [] }, 13: { reasons: [] } });
});

test('a tenant profile is never held by the main account\'s Remote Access', async () => {
    baseline();
    T.profiles = [profile({ tenant: 'tenant-a' })];
    raSettings({ profileId: 12, groupId: GID });
    const usage = await nb.runWithTenant('tenant-a', () => db.getAccessProfileUsage());
    assert.deepEqual(usage['12'].reasons, []);
});

// ─── A profile's row, its policy, and the grants built from it ───
const payroll = () => { baseline(); T.profiles = [profile({ protocol: 'tcp', ports: '22', sources: ['staff'], posture_checks: [] })]; };

test('an Access Profiles save that NetBird did not confirm leaves the row as it was; a confirmed one updates it', async () => {
    const save = () => db.updateAccessProfile(12, { name: 'Payroll 2', sources: ['ops'], protocol: 'tcp', ports: ['8443'], postureChecks: ['pc-1'] });
    for (const answer of [...UNANSWERED, { status: 422, raw: 'invalid' }, notFound]) {
        payroll();
        const before = clone(T.profiles);
        NB.answers[`PUT /api/policies/${PID}`] = [answer];
        await assert.rejects(save(), UNANSWERED.includes(answer) ? /the profile wasn't saved. Save it again/ : /Failed to update policy/);
        assert.deepEqual(writes(), [`PUT /api/policies/${PID}`]);
        assert.deepEqual(T.profiles, before);
    }
    payroll();
    await save();
    assert.deepEqual(payrollRow(), profile({ name: 'Payroll 2', sources: ['ops'], protocol: 'tcp', ports: '8443', posture_checks: ['pc-1'] }));
    const temp = await grantPayroll();
    assert.deepEqual(temp.rules[0].ports, ['8443']);
    assert.deepEqual(temp.source_posture_checks, ['pc-1']);
});

test('the Policies page save of a profile policy updates the row after the confirmed PUT, and only then', async () => {
    const form = (extra = {}) => ({ name: 'Payroll Access', description: '', enabled: true, protocol: 'tcp', ports: ['8443'], sources: ['ops'], destinations: [GID], postureChecks: ['pc-1'], ...extra });
    payroll();
    await db.updatePolicy(PID, form());
    assert.deepEqual(payrollRow(), profile({ protocol: 'tcp', ports: '8443', sources: ['ops'], posture_checks: ['pc-1'] }));
    const put = calls.find(c => c.method === 'PUT');
    assert.ok(log.filter(l => /^UPDATE access_profiles/.test(l.sql)).every(l => l.seq > put.seq));
    for (const answer of [...UNANSWERED, { status: 422, raw: 'invalid' }]) {
        payroll();
        const before = clone(T.profiles);
        NB.answers[`PUT /api/policies/${PID}`] = [answer];
        await assert.rejects(db.updatePolicy(PID, form()), (e) => (UNANSWERED.includes(answer) ? e.code === 'POLICY_UPDATE_UNCONFIRMED' && /didn't confirm/.test(e.message) : !e.unconfirmed));
        assert.deepEqual(T.profiles, before);
    }
    payroll();
    const before = clone(T.profiles);
    NB.policies['pol-other'] = { id: 'pol-other', name: 'Other', enabled: true, rules: [{ name: 'Other', enabled: true, action: 'accept', protocol: 'tcp', ports: ['22'], sources: [g('staff')], destinations: [g(GID)] }] };
    await db.updatePolicy('pol-other', form({ name: 'Other' }));
    assert.deepEqual(T.profiles, before, "another policy to the profile's group is not the profile's policy");
});

test('a profile row is written only from the one accept rule to the profile group; its posture checks always follow', async () => {
    const save = () => db.updatePolicy(PID, { preserveRules: true, name: 'Payroll Access', description: 'Who may open payroll', enabled: true, postureChecks: ['pc-1'] });
    const rule = (extra = {}) => ({ name: 'Payroll', enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [g('ops')], destinations: [g(GID)], ...extra });
    const unclear = {
        'two rules to the group': [rule(), rule({ ports: ['443'] })],
        'a rule to another group next to it': [rule({ destinations: [g('grp-other')] }), rule()],
        'a rule to another group only': [rule({ destinations: [g('grp-other')] })],
        'a Drop rule': [rule({ action: 'drop' })],
    };
    for (const [label, rules] of Object.entries(unclear)) {
        payroll();
        NB.policies[PID].rules = rules;
        await save();
        assert.deepEqual(payrollRow(), profile({ protocol: 'tcp', ports: '22', sources: ['staff'], posture_checks: ['pc-1'] }), label);
    }
    payroll();
    NB.policies[PID].rules = [rule()];
    await save();
    assert.deepEqual(payrollRow(), profile({ protocol: 'tcp', ports: '3389', sources: ['ops'], posture_checks: ['pc-1'] }));
    // A policy that is turned off still says what a temporary grant opens.
    payroll();
    NB.policies[PID].rules = [rule({ enabled: false })];
    await save();
    assert.deepEqual(payrollRow(), profile({ protocol: 'tcp', ports: '3389', sources: ['ops'], posture_checks: ['pc-1'] }));
    payroll();
    NB.policies[PID].rules = [rule({ protocol: 'all', ports: [] })];
    await save();
    assert.deepEqual(payrollRow(), profile({ protocol: 'all', ports: '', sources: ['ops'], posture_checks: ['pc-1'] }));
});

test('a grant is built from the profile row, never from the live policy', async () => {
    payroll();
    NB.policies[PID].rules[0].ports = ['3389'];
    NB.policies[PID].source_posture_checks = ['pc-9'];
    const temp = await grantPayroll();
    assert.deepEqual(temp.rules[0].ports, ['22']);
    assert.deepEqual(temp.source_posture_checks, []);
});

test('each profile target of a grant opens its own ports', async () => {
    payroll();
    T.profiles.push(profile({ id: 13, name: 'Zeta', group_id: 'grp-13', policy_id: 'pol-13', protocol: 'tcp', ports: '3389', sources: ['staff'], posture_checks: [] }));
    NB.lists['/api/users'] = [{ id: 'user-1', role: 'user', auto_groups: [] }];
    await db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'profile', id: '12', access: { tcp: ['443'] } }, { type: 'profile', id: '13' }] }, admin);
    const opened = tempPolicies().map(p => [p.rules[0].ports.join(','), p.rules[0].destinations.join(',')]).sort();
    assert.deepEqual(opened, [['3389', 'grp-13'], ['443', GID]], "#12 pinned to 443 and #13's own 3389, never #12's default 22");
});
