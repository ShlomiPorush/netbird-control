// The Access Profile routes, and the routes that save a reference to a profile, on the real
// server.js stack with SSO on (test/helpers/sso-server.js):
//   - DELETE /api/access-profiles/:id takes only a positive int4 id; a missing profile is a 404
//     no-op; a profile in use answers 409 PROFILE_IN_USE with its reasons;
//   - GET /api/access-profiles/usage is for admins only;
//   - every route that saves a profile reference refuses one that doesn't exist with 400
//     PROFILE_NOT_FOUND: network defaults, automations, recurring rules, auto-approval rules,
//     temporary grants, and access requests (created or approved).
// The database is an in-memory stub that knows one profile, #7.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ssoServer } = require('./helpers/sso-server');

const h = ssoServer();
const USERS = { plain: {}, admin: { role: 'admin' }, editor: { groups: ['g-edit'] } };
// A network editor (not an admin) may edit net-1.
const GRANTS = { 'net-1': [{ id: 'g-edit', access: 'edit' }] };
// Profile #8 is a Direct preset (no group, no policy).
const DIRECT = { id: 8, name: 'Ports', group_id: '', policy_id: '', sources: [], protocol: 'tcp', ports: '22', shared: false, posture_checks: [], tenant: '' };
const PROFILE = { id: 7, name: 'Ops', group_id: 'pg-7', policy_id: 'pp-7', sources: [], protocol: 'all', ports: '', shared: true, posture_checks: [], tenant: '' };
const queries = [];
let failProfiles = false; // every access_profiles query fails
// The stored recurring rule #3 targets profile #98, which no longer exists.
const recurringRow = () => ({ id: 3, user_id: 'u1', user_label: 'Dana', targets: [{ type: 'profile', id: '98', name: 'Old' }], days: [1], start_time: '09:00', end_time: '17:00', enabled: true });
let usageRows = null; // the profiles the usage route lists (default: #7 only)

before(async () => {
    await h.start({
        beforeRequire(db) {
            const core = require('../lib/core');
            core.pool.query = async (q, params = []) => {
                const sql = String(typeof q === 'string' ? q : q.text).replace(/\s+/g, ' ').trim();
                queries.push(sql);
                if (failProfiles && /access_profiles/.test(sql)) throw new Error('database unavailable');
                if (sql.startsWith('SELECT id FROM access_profiles')) {
                    return { rows: [PROFILE, DIRECT].filter(x => params[1].includes(x.id) && (!/shared IS NOT FALSE/.test(sql) || x.shared)).map(x => ({ id: x.id })) };
                }
                if (sql.startsWith('SELECT policy_id, protocol, ports, sources, posture_checks FROM access_profiles')) return { rows: params[0].includes(PROFILE.policy_id) ? [{ ...PROFILE }] : [] };
                if (usageRows && sql.startsWith('SELECT id, name, group_id, policy_id, shared FROM access_profiles WHERE tenant')) return { rows: usageRows.map(r => ({ ...r })) };
                if (/FROM access_profiles WHERE id = \$1/.test(sql)) return { rows: params[0] === PROFILE.id ? [{ ...PROFILE }] : [] };
                if (/FROM access_profiles/.test(sql)) return { rows: [{ ...PROFILE }] };
                if (/^SELECT \* FROM recurring_access WHERE id=\$1/.test(sql)) {
                    return { rows: [recurringRow()] };
                }
                if (/^SELECT \* FROM access_requests WHERE id=\$1/.test(sql)) {
                    return { rows: [{ id: 5, status: 'pending', kind: 'access', requester_id: 'u1', requester_name: 'Dana', targets: [{ type: 'profile', id: '99', name: 'Gone' }] }] };
                }
                if (/^UPDATE recurring_access SET user_id/.test(sql)) return { rows: [recurringRow()] };
                return { rows: [], rowCount: 0 };
            };
            core.pool.connect = async () => ({ query: core.pool.query, release() { } });
            Object.assign(db, {
                ensureUsersFresh: async () => { },
                ensurePeersFresh: async () => { },
                resolveViewer: async (oid) => (USERS[oid] ? { user_id: oid, role: USERS[oid].role || 'user', name: oid, email: `${oid}@example.com`, auto_groups: USERS[oid].groups || [] } : null),
                fetchUserGroups: async () => [],
                getUserPeerGroupIds: async () => [],
                getApproverGroupIds: () => [],
                isActiveDelegate: async () => false,
                getAllGrants: async () => GRANTS,
                recordAudit: async () => { },
            });
        },
    });
});
after(() => h.stop());

const missing = (r) => {
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'PROFILE_NOT_FOUND', r.text);
};

test('delete: an id that is not a whole positive int4 is refused before anything is read', async () => {
    for (const id of ['12abc', '0', '2147483648', '-1', '1.5']) {
        queries.length = 0;
        const r = await h.call('admin', 'DELETE', `/api/access-profiles/${id}`);
        assert.equal(r.status, 400, `${id}: ${r.text}`);
        assert.equal(r.json.code, 'INVALID_PROFILE_ID');
        assert.ok(!queries.some(q => /access_profiles/.test(q)), `${id}: nothing read`);
    }
});

test('delete: a missing profile is a 404 no-op', async () => {
    const r = await h.call('admin', 'DELETE', '/api/access-profiles/99');
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json.code, 'PROFILE_NOT_FOUND');
});

test('delete: a profile in use answers 409 with the reasons, and the row stays', async () => {
    h.netbird.answers['/api/groups'] = [{ id: 'pg-7', name: 'Ops', resources_count: 3, peers_count: 0 }];
    queries.length = 0;
    const r = await h.call('admin', 'DELETE', '/api/access-profiles/7');
    delete h.netbird.answers['/api/groups'];
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'PROFILE_IN_USE');
    assert.deepEqual(r.json.reasons, [{ kind: 'resources', label: '3 resources' }]);
    assert.equal(r.json.error, 'This profile is in use by 3 resources. Remove it from them first.');
    assert.ok(!queries.some(q => /^DELETE FROM access_profiles/.test(q)));
});

test('usage: admins only', async () => {
    const denied = await h.call('plain', 'GET', '/api/access-profiles/usage');
    assert.equal(denied.status, 403);
    h.netbird.answers['/api/groups'] = [{ id: 'pg-7', name: 'Ops', resources_count: 0, peers_count: 2 }];
    const r = await h.call('admin', 'GET', '/api/access-profiles/usage');
    delete h.netbird.answers['/api/groups'];
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { 7: { reasons: [{ kind: 'peers', label: '2 peers' }] } });
});

test('usage: three shared profiles cost a fixed set of NetBird reads, none per profile', async () => {
    usageRows = [7, 8, 9].map(id => ({ ...PROFILE, id, name: `P${id}`, group_id: `pg-${id}`, policy_id: `pp-${id}` }));
    h.netbird.answers['/api/groups'] = usageRows.map(r => ({ id: r.group_id, name: r.name, resources_count: r.id === 8 ? 1 : 0, peers_count: 0 }));
    h.netbird.seen.length = 0;
    const r = await h.call('admin', 'GET', '/api/access-profiles/usage');
    usageRows = null;
    delete h.netbird.answers['/api/groups'];
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { 7: { reasons: [] }, 8: { reasons: [{ kind: 'resources', label: '1 resource' }] }, 9: { reasons: [] } });
    const gets = h.netbird.seen.filter(x => x.startsWith('GET ')).map(x => x.split('?')[0]).sort();
    assert.deepEqual(gets, ['/api/dns/nameservers', '/api/groups', '/api/networks/routers', '/api/policies', '/api/reverse-proxies/services', '/api/routes', '/api/setup-keys', '/api/users'].map(p => 'GET ' + p));
});

test('network defaults: a missing profile is refused; an existing one is saved', async () => {
    missing(await h.call('admin', 'PUT', '/api/networks/net-1/default-profiles', { profileIds: [7, 99] }));
    const ok = await h.call('admin', 'PUT', '/api/networks/net-1/default-profiles', { profileIds: [7] });
    assert.equal(ok.status, 200, ok.text);
});

test('automations: create and update refuse a missing profile', async () => {
    const body = { name: 'CMDB', endpointUrl: 'https://source.example.test/list', profileIds: [99] };
    missing(await h.call('admin', 'POST', '/api/automations', body));
    missing(await h.call('admin', 'PUT', '/api/automations/1', body));
    assert.ok(!queries.some(q => /^(INSERT INTO|UPDATE) automations/.test(q)));
});

test('recurring access: create and update refuse a missing profile', async () => {
    const body = { userId: 'u1', userLabel: 'Dana', targets: [{ type: 'profile', id: '99', name: 'Gone' }], days: [1], startTime: '09:00', endTime: '17:00' };
    missing(await h.call('admin', 'POST', '/api/recurring-access', body));
    missing(await h.call('admin', 'PUT', '/api/recurring-access/3', body));
});

test('recurring access: a disabling save may keep a stored profile that is gone, but not add one', async () => {
    const body = (targets) => ({ userId: 'u1', userLabel: 'Dana', enabled: false, targets, days: [1], startTime: '09:00', endTime: '17:00' });
    const kept = await h.call('admin', 'PUT', '/api/recurring-access/3', body([{ type: 'profile', id: '98', name: 'Old' }]));
    assert.equal(kept.status, 200, kept.text);
    missing(await h.call('admin', 'PUT', '/api/recurring-access/3', body([{ type: 'profile', id: '98', name: 'Old' }, { type: 'profile', id: '99', name: 'Gone' }])));
    missing(await h.call('admin', 'PUT', '/api/recurring-access/3', body([{ type: 'profile', id: '99', name: 'Gone' }])));
});

test('auto-approval: a rule naming a missing profile is refused', async () => {
    missing(await h.call('admin', 'PUT', '/api/auto-approval-config', { trusted: [], rules: [{ targets: [{ type: 'profile', id: '99', name: 'Gone' }], groupIds: ['g1'] }] }));
});

test('temporary access: a grant to a missing profile is refused', async () => {
    missing(await h.call('admin', 'POST', '/api/temporary-access', { userId: 'u1', durationMinutes: 60, targets: [{ type: 'profile', id: '99', name: 'Gone' }] }));
});

test('access requests: creating or approving one for a missing profile is refused (the early target check)', async () => {
    missing(await h.call('admin', 'POST', '/api/access-requests', { targets: [{ type: 'profile', id: '99', name: 'Gone' }], reason: 'on call' }));
    missing(await h.call('admin', 'POST', '/api/access-requests/5/approve', { durationMinutes: 60 }));
});

test('a non-canonical profile id ("007") is refused, never stored next to "7"', async () => {
    const t = { type: 'profile', id: '007', name: 'Ops' };
    for (const [method, path, body] of [
        ['POST', '/api/recurring-access', { userId: 'u1', targets: [t], days: [1], startTime: '09:00', endTime: '17:00' }],
        ['PUT', '/api/auto-approval-config', { trusted: [], rules: [{ targets: [t], groupIds: ['g1'] }] }],
        ['POST', '/api/temporary-access', { userId: 'u1', durationMinutes: 60, targets: [t] }],
    ]) {
        const r = await h.call('admin', method, path, body);
        assert.equal(r.status, 400, `${path}: ${r.text}`);
        assert.equal(r.json.code, 'INVALID_PROFILE_ID', path);
    }
    // A request resolves targets from the catalogue, where "007" isn't offered.
    missing(await h.call('admin', 'POST', '/api/access-requests', { targets: [t], reason: 'on call' }));
    // The canonical "7" passes the check (the save itself then fails on this database stub).
    const ok = await h.call('admin', 'POST', '/api/recurring-access', { userId: 'u1', targets: [{ ...t, id: '7' }], days: [1], startTime: '09:00', endTime: '17:00' });
    assert.notEqual(ok.json && ok.json.code, 'INVALID_PROFILE_ID', ok.text);
});

test('resource save: a numeric policy id is the same id in the pre-check and the save (updated in place)', async () => {
    const resource = { id: 'r1', name: 'NAS', address: '10.0.0.9', type: 'host', groups: [] };
    const policy = {
        id: '42', name: 'NAS Policy', description: '', enabled: true, source_posture_checks: [],
        rules: [{ name: 'NAS Policy', enabled: true, action: 'accept', bidirectional: false, protocol: 'tcp', ports: ['443'], sources: [{ id: 'g-a', name: 'A' }], destinationResource: { id: 'r1', type: 'host' } }],
    };
    const answers = {
        '/api/networks/net-1/resources/r1': resource, '/api/networks/net-1/resources': [resource],
        '/api/policies': [policy], '/api/policies/42': policy, '/api/groups': [{ id: 'g-a', name: 'A' }],
    };
    Object.assign(h.netbird.answers, answers);
    try {
        const body = (id) => ({ name: 'NAS', address: '10.0.0.9', groups: [], policies: [{ id, name: 'NAS Policy', protocol: 'tcp', ports: ['8443'], sources: ['g-a'], enabled: true }] });
        h.netbird.seen.length = 0;
        const r = await h.call('admin', 'PUT', '/api/networks/net-1/resources/r1', body(42));
        assert.equal(r.status, 200, r.text);
        assert.ok(h.netbird.seen.includes('PUT /api/policies/42'), 'updated in place');
        assert.ok(!h.netbird.seen.some(x => x === 'DELETE /api/policies/42' || x === 'POST /api/policies'), 'not deleted and recreated');
        // An id that is neither a string nor a number is refused before anything is written.
        h.netbird.seen.length = 0;
        const bad = await h.call('admin', 'PUT', '/api/networks/net-1/resources/r1', body(true));
        assert.equal(bad.status, 400, bad.text);
        assert.equal(bad.json.code, 'POLICY_NOT_OF_RESOURCE');
        assert.ok(!h.netbird.seen.some(x => !x.startsWith('GET ')), 'nothing written');
    } finally {
        for (const k of Object.keys(answers)) delete h.netbird.answers[k];
    }
});

test('auto-approval: a rule naming a Direct profile is refused, like the request catalogue', async () => {
    missing(await h.call('admin', 'PUT', '/api/auto-approval-config', { trusted: [], rules: [{ targets: [{ type: 'profile', id: '8', name: 'Ports' }], groupIds: ['g1'] }] }));
});

test('resource save: only an admin may change an Access Profile\'s policy; source resolution never rewrites it', async () => {
    // pp-7 is profile #7's policy, pointed at this resource directly; its source g-a is not one of
    // the network editor's allowed sources (g-edit).
    const resource = { id: 'r1', name: 'NAS', address: '10.0.0.9', type: 'host', groups: [] };
    const policy = {
        id: 'pp-7', name: 'Ops Access', description: '', enabled: true, source_posture_checks: [],
        rules: [{ name: 'Ops Access', enabled: true, action: 'accept', bidirectional: false, protocol: 'tcp', ports: ['443'], sources: [{ id: 'g-a', name: 'A' }], destinationResource: { id: 'r1', type: 'host' } }],
    };
    const answers = {
        '/api/networks/net-1/resources/r1': resource, '/api/networks/net-1/resources': [resource],
        '/api/policies': [policy], '/api/policies/pp-7': policy, '/api/groups': [{ id: 'g-a', name: 'A' }, { id: 'g-edit', name: 'Editors' }],
    };
    Object.assign(h.netbird.answers, answers);
    const body = (ports) => ({ name: 'NAS', address: '10.0.0.9', groups: [], policies: [{ id: 'pp-7', name: 'Ops Access', description: '', protocol: 'tcp', ports, sources: ['g-a'], enabled: true, bidirectional: false, postureChecks: [] }] });
    const policyWrites = () => h.netbird.seen.filter(x => /^(PUT|POST|DELETE) \/api\/policies/.test(x));
    try {
        // A network editor sends it unchanged: saved, and the policy is not written.
        h.netbird.seen.length = 0;
        let r = await h.call('editor', 'PUT', '/api/networks/net-1/resources/r1', body(['443']));
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(policyWrites(), [], 'the profile policy keeps its sources');
        // A network editor changes it: refused before anything is written.
        h.netbird.seen.length = 0;
        r = await h.call('editor', 'PUT', '/api/networks/net-1/resources/r1', body(['8443']));
        assert.equal(r.status, 403, r.text);
        assert.equal(r.json.code, 'PROFILE_POLICY_ADMIN_ONLY');
        assert.equal(r.json.error, 'Only an admin can change the policy of Access Profile Ops.');
        assert.ok(!h.netbird.seen.some(x => !x.startsWith('GET ')), 'nothing written');
        // An admin: unchanged is no PUT, changed is a PUT on the same id.
        h.netbird.seen.length = 0;
        r = await h.call('admin', 'PUT', '/api/networks/net-1/resources/r1', body(['443']));
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(policyWrites(), []);
        h.netbird.seen.length = 0;
        r = await h.call('admin', 'PUT', '/api/networks/net-1/resources/r1', body(['8443']));
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(policyWrites(), ['PUT /api/policies/pp-7']);
    } finally {
        for (const k of Object.keys(answers)) delete h.netbird.answers[k];
    }
});

test('resource save: a network editor saving without existing policies needs no profile read', async () => {
    const resource = { id: 'r1', name: 'NAS', address: '10.0.0.9', type: 'host', groups: [] };
    const answers = {
        '/api/networks/net-1/resources/r1': resource, '/api/networks/net-1/resources': [resource],
        '/api/policies': [], '/api/groups': [{ id: 'g-edit', name: 'Editors' }],
    };
    Object.assign(h.netbird.answers, answers);
    failProfiles = true;
    try {
        const r = await h.call('editor', 'PUT', '/api/networks/net-1/resources/r1', { name: 'NAS', address: '10.0.0.9', groups: [], policies: [{ name: 'New', protocol: 'tcp', ports: ['22'], sources: ['g-edit'], enabled: true }] });
        assert.equal(r.status, 200, r.text);
        assert.ok(h.netbird.seen.includes('POST /api/policies'), 'the new policy is created');
    } finally {
        failProfiles = false;
        for (const k of Object.keys(answers)) delete h.netbird.answers[k];
    }
});
