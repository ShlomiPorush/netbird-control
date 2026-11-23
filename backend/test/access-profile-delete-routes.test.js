// The Access Profile routes, and the routes that save a reference to a profile, on the real
// server.js stack with SSO on (test/helpers/sso-server.js):
//   - DELETE /api/access-profiles/:id: a missing profile is a 404 no-op; one in use answers 409
//     PROFILE_IN_USE with its reasons; an unused one is deleted and audited, with what NetBird
//     didn't confirm removing;
//   - GET /api/access-profiles/usage is for admins only;
//   - every route that saves a profile reference refuses one that doesn't exist: network defaults,
//     automations, recurring rules, auto-approval rules, temporary grants, and access requests
//     (created or approved);
//   - a resource save never lets a network editor change an Access Profile's policy.
// The database is an in-memory stub that knows two profiles: #7, and the Direct preset #8.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ssoServer } = require('./helpers/sso-server');

const h = ssoServer();
const USERS = { plain: {}, admin: { role: 'admin' }, editor: { groups: ['g-edit'] }, manager: {} };
// A network editor (not an admin) may edit net-1 and net-2; a manager has Manage All Networks.
const GRANTS = { 'net-1': [{ id: 'g-edit', access: 'edit' }], 'net-2': [{ id: 'g-edit', access: 'edit' }] };
const DIRECT = { id: 8, name: 'Ports', group_id: '', policy_id: '', sources: [], protocol: 'tcp', ports: '22', shared: false, posture_checks: [], tenant: '' };
const PROFILE = { id: 7, name: 'Ops', group_id: 'pg-7', policy_id: 'pp-7', sources: [], protocol: 'all', ports: '', shared: true, posture_checks: [], tenant: '' };
const queries = [];
let failProfiles = false; // every access_profiles query fails
const audits = [];
// The stub NetBird answers every request with 200, so a leftover is put into the answer here.
let leftover = [];
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
                    return { rows: [PROFILE, DIRECT].filter(x => !/shared IS NOT FALSE/.test(sql) || x.shared).map(x => ({ id: x.id })) };
                }
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
            const { deleteAccessProfile, resolveFeaturePerms } = db;
            Object.assign(db, {
                deleteAccessProfile: async (id) => { const out = await deleteAccessProfile(id); return out && { ...out, leftover: [...out.leftover, ...leftover] }; },
                ensureUsersFresh: async () => { },
                ensurePeersFresh: async () => { },
                resolveViewer: async (oid) => (USERS[oid] ? { user_id: oid, role: USERS[oid].role || 'user', name: oid, email: `${oid}@example.com`, auto_groups: USERS[oid].groups || [] } : null),
                fetchUserGroups: async () => [],
                resolveFeaturePerms: (a) => ({ ...resolveFeaturePerms(a), ...(a.userId === 'manager' ? { 'networks.manage': true } : {}) }),
                getUserPeerGroupIds: async () => [],
                getApproverGroupIds: () => [],
                isActiveDelegate: async () => false,
                getAllGrants: async () => GRANTS,
                recordAudit: async (e) => { audits.push(e); },
            });
        },
    });
});
after(() => h.stop());

const missing = (r) => {
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'PROFILE_NOT_FOUND', r.text);
};
const goneMessage = (r, status, id = '99') => {
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.error, `Access Profile #${id} no longer exists. Reload and choose again.`);
};

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

test('delete: an unused profile is deleted and audited, with what NetBird did not confirm removing', async () => {
    const answers = { '/api/groups': [{ id: 'pg-7', name: 'Ops', resources_count: 0, peers_count: 0 }], '/api/policies': [{ id: 'pp-7', name: 'Ops Access', rules: [] }] };
    Object.assign(h.netbird.answers, answers);
    const run = async () => {
        audits.length = 0; queries.length = 0; h.netbird.seen.length = 0;
        const r = await h.call('admin', 'DELETE', '/api/access-profiles/7');
        assert.equal(r.status, 200, r.text);
        assert.ok(queries.some(q => /^DELETE FROM access_profiles/.test(q)));
        assert.deepEqual(audits.map(a => [a.action, a.target, a.actorId]), [['profile.delete', 'Ops', 'admin']]);
        return { json: r.json, meta: audits[0].meta };
    };
    try {
        assert.deepEqual(await run(), { json: { status: 'ok', leftover: [] }, meta: null });
        assert.deepEqual(h.netbird.seen.filter(x => x.startsWith('DELETE ')), ['DELETE /api/policies/pp-7', 'DELETE /api/groups/pg-7']);
        leftover = [{ kind: 'group', id: 'pg-7', name: 'Ops' }];
        assert.deepEqual(await run(), { json: { status: 'ok', leftover: [{ kind: 'group', id: 'pg-7', name: 'Ops' }] }, meta: { leftInNetBird: 'group Ops' } });
    } finally {
        leftover = [];
        for (const k of Object.keys(answers)) delete h.netbird.answers[k];
    }
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
    goneMessage(await h.call('admin', 'POST', '/api/automations', body), 500);
    goneMessage(await h.call('admin', 'PUT', '/api/automations/1', body), 500);
    assert.ok(!queries.some(q => /^(INSERT INTO|UPDATE) automations/.test(q)));
});

test('recurring access: create and update refuse a missing profile', async () => {
    const body = { userId: 'u1', userLabel: 'Dana', targets: [{ type: 'profile', id: '99', name: 'Gone' }], days: [1], startTime: '09:00', endTime: '17:00' };
    queries.length = 0;
    goneMessage(await h.call('admin', 'POST', '/api/recurring-access', body), 400);
    goneMessage(await h.call('admin', 'PUT', '/api/recurring-access/3', body), 400);
    assert.ok(!queries.some(q => /^(INSERT INTO|UPDATE) recurring_access/.test(q)));
});

test('recurring access: a rule whose profile is gone can still be saved as disabled, not as enabled', async () => {
    const body = (enabled) => ({ userId: 'u1', userLabel: 'Dana', enabled, targets: [{ type: 'profile', id: '98', name: 'Old' }], days: [1], startTime: '09:00', endTime: '17:00' });
    const off = await h.call('admin', 'PUT', '/api/recurring-access/3', body(false));
    assert.equal(off.status, 200, off.text);
    goneMessage(await h.call('admin', 'PUT', '/api/recurring-access/3', body(true)), 400, '98');
});

test('auto-approval: a rule naming a missing profile is refused', async () => {
    missing(await h.call('admin', 'PUT', '/api/auto-approval-config', { trusted: [], rules: [{ targets: [{ type: 'profile', id: '99', name: 'Gone' }], groupIds: ['g1'] }] }));
});

test('temporary access: a grant to a missing or a Direct profile is refused', async () => {
    for (const id of ['99', '8']) {
        goneMessage(await h.call('admin', 'POST', '/api/temporary-access', { userId: 'u1', durationMinutes: 60, targets: [{ type: 'profile', id, name: 'Gone' }] }), 400, id);
    }
});

test('access requests: creating or approving one for a missing profile is refused', async () => {
    for (const r of [
        await h.call('admin', 'POST', '/api/access-requests', { targets: [{ type: 'profile', id: '99', name: 'Gone' }], reason: 'on call' }),
        await h.call('admin', 'POST', '/api/access-requests', { targets: [{ type: 'profile', id: '007', name: 'Ops' }], reason: 'on call' }),
        await h.call('admin', 'POST', '/api/access-requests/5/approve', { durationMinutes: 60 }),
    ]) {
        assert.equal(r.status, 400, r.text);
        assert.match(r.json.error, /no longer offered/);
    }
});

test('a profile id is matched as it was sent: "007" is not profile #7', async () => {
    const t = { type: 'profile', id: '007', name: 'Ops' };
    const recurring = (target) => ({ userId: 'u1', targets: [target], days: [1], startTime: '09:00', endTime: '17:00' });
    goneMessage(await h.call('admin', 'POST', '/api/recurring-access', recurring(t)), 400, '007');
    goneMessage(await h.call('admin', 'POST', '/api/temporary-access', { userId: 'u1', durationMinutes: 60, targets: [t] }), 400, '007');
    missing(await h.call('admin', 'PUT', '/api/auto-approval-config', { trusted: [], rules: [{ targets: [t], groupIds: ['g1'] }] }));
    queries.length = 0;
    await h.call('admin', 'POST', '/api/recurring-access', recurring({ ...t, id: '7' }));
    assert.ok(queries.some(q => /^INSERT INTO recurring_access/.test(q)), '"7" passes the check');
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
        h.netbird.seen.length = 0;
        const bad = await h.call('admin', 'PUT', '/api/networks/net-1/resources/r1', body(true));
        assert.equal(bad.status, 400, bad.text);
        assert.match(bad.json.error, /isn't one of this resource's own policies/);
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
        h.netbird.seen.length = 0;
        let r = await h.call('editor', 'PUT', '/api/networks/net-1/resources/r1', body(['443']));
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(policyWrites(), [], 'the profile policy keeps its sources');
        h.netbird.seen.length = 0;
        r = await h.call('editor', 'PUT', '/api/networks/net-1/resources/r1', body(['8443']));
        assert.equal(r.status, 403, r.text);
        assert.equal(r.json.error, 'Only an admin can change the policy of Access Profile Ops.');
        assert.ok(!h.netbird.seen.some(x => !x.startsWith('GET ')), 'nothing written');
        for (const ports of [['443'], ['8443']]) {
            h.netbird.seen.length = 0;
            r = await h.call('admin', 'PUT', '/api/networks/net-1/resources/r1', body(ports));
            assert.equal(r.status, 200, r.text);
            assert.deepEqual(policyWrites(), ['PUT /api/policies/pp-7'], `an admin's save, ports ${ports}`);
        }
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

test('a profile read that fails refuses the resource save before the resource is written', async () => {
    const resource = { id: 'r1', name: 'NAS', address: '10.0.0.9', type: 'host', groups: [] };
    const policy = {
        id: 'pp-7', name: 'Ops Access', description: '', enabled: true, source_posture_checks: [],
        rules: [{ name: 'Ops Access', enabled: true, action: 'accept', bidirectional: false, protocol: 'tcp', ports: ['443'], sources: [{ id: 'g-a', name: 'A' }], destinationResource: { id: 'r1', type: 'host' } }],
    };
    const answers = {
        '/api/networks/net-1/resources/r1': resource, '/api/networks/net-1/resources': [resource],
        '/api/policies': [policy], '/api/policies/pp-7': policy, '/api/groups': [{ id: 'g-a', name: 'A' }],
    };
    Object.assign(h.netbird.answers, answers);
    failProfiles = true;
    try {
        h.netbird.seen.length = 0;
        const r = await h.call('admin', 'PUT', '/api/networks/net-1/resources/r1', { name: 'NAS 2', address: '10.0.0.9', groups: [], policies: [{ id: 'pp-7', name: 'Ops Access', description: '', protocol: 'tcp', ports: ['443'], sources: ['g-a'], enabled: true, bidirectional: false, postureChecks: [] }] });
        assert.equal(r.status, 502, r.text);
        assert.ok(!h.netbird.seen.some(x => !x.startsWith('GET ')), 'the resource was not written');
    } finally {
        failProfiles = false;
        for (const k of Object.keys(answers)) delete h.netbird.answers[k];
    }
});

test('Stop Using This Network: admins only', async () => {
    const r = await h.call('editor', 'DELETE', '/api/remote-access/create-resources/network');
    assert.equal(r.status, 403, r.text);
});

test('bulk delete by an admin removes servers in the launch network; the route passes the admin flag', async () => {
    const resource = { id: 'r1', name: 'NAS', address: '10.0.0.9', type: 'host', groups: [], description: '' };
    const answers = { '/api/networks/net-1/resources/r1': resource, '/api/networks/net-1/resources': [resource], '/api/networks': [{ id: 'net-1', name: 'Office', resources: ['r1'] }], '/api/policies': [] };
    Object.assign(h.netbird.answers, answers);
    const remoteAccess = require('../lib/remote-access')._internal;
    remoteAccess.setConfigForTest({ networks: ['net-1'], createResources: { enabled: true, networkId: 'net-1', profileId: 7, groupId: 'pg-7', max: 50 } });
    try {
        h.netbird.seen.length = 0;
        const r = await h.call('admin', 'POST', '/api/networks/net-1/resources/bulk-delete', { ids: ['r1'] });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.deleted, 1, JSON.stringify(r.json));
        assert.ok(h.netbird.seen.includes('DELETE /api/networks/net-1/resources/r1'));
    } finally {
        remoteAccess.setConfigForTest({});
        for (const k of Object.keys(answers)) delete h.netbird.answers[k];
    }
});

test('a Remote Access save whose check could not read NetBird is not answered as a 502, which the page reads as saved', async () => {
    const answers = {
        '/api/groups/pg-7': { id: 'pg-7', name: 'Ops' },
        '/api/policies/pp-7': { id: 'pp-7', enabled: true, rules: [{ enabled: true, action: 'accept', destinations: ['pg-7'] }] },
        '/api/networks/net-1/resources': [], '/api/networks/net-1/routers': [{ id: 'rt-1', peer: 'p-1', enabled: true }],
        '/api/groups': { message: 'down' },
    };
    Object.assign(h.netbird.answers, answers);
    const remoteAccess = require('../lib/remote-access');
    remoteAccess.setRemoteAccessDeps({ checkLaunchNetwork: require('../db').checkLaunchNetwork }); // server.js does it in start()
    remoteAccess._internal.setConfigForTest({ networks: ['net-1'], createResources: { enabled: false, networkId: 'net-1', profileId: 7, groupId: 'pg-7', max: 50 } });
    try {
        const r = await h.call('admin', 'PUT', '/api/remote-access/config', { createResources: { enabled: true } });
        assert.equal(r.status, 503, r.text);
        assert.match(r.json.error, /Couldn't read the groups from NetBird/);
        assert.equal(remoteAccess.getRemoteAccessConfig().createResources.enabled, false);
    } finally {
        remoteAccess._internal.setConfigForTest({});
        for (const k of Object.keys(answers)) delete h.netbird.answers[k];
    }
});

test('in the launch network only an admin adds or deletes routing peers or renames it', async () => {
    const answers = { '/api/groups': [], '/api/networks/net-1': { id: 'net-1' }, '/api/networks/net-2': { id: 'net-2' } };
    for (const n of ['net-1', 'net-2']) answers[`/api/networks/${n}/routers`] = { id: 'rt-1' };
    Object.assign(h.netbird.answers, answers);
    const remoteAccess = require('../lib/remote-access')._internal;
    const guard = (enabled) => remoteAccess.setConfigForTest({ networks: ['net-1'], createResources: { enabled, networkId: 'net-1', profileId: 7, groupId: 'pg-7', max: 50 } });
    const OPS = {
        add: (who, n) => h.call(who, 'POST', `/api/networks/${n}/routers`, { peer: 'p-1' }),
        remove: (who, n) => h.call(who, 'DELETE', `/api/networks/${n}/routers/rt-1`),
        rename: (who, n) => h.call(who, 'PUT', `/api/networks/${n}`, { name: 'New', description: 'x' }),
    };
    const sent = () => h.netbird.seen.filter(x => !x.startsWith('GET '));
    // Renaming needs Manage All Networks in any network.
    const nonAdmins = [['editor', 'add'], ['editor', 'remove'], ['manager', 'add'], ['manager', 'remove'], ['manager', 'rename']];
    try {
        guard(true);
        h.netbird.seen.length = 0;
        for (const [who, op] of nonAdmins) {
            const r = await OPS[op](who, 'net-1');
            assert.equal(r.status, 409, `${who} ${op}: ${r.text}`);
            assert.match(r.json.error, /managed by Remote Access/);
        }
        assert.deepEqual(sent(), []);
        for (const [who, op] of nonAdmins) assert.equal((await OPS[op](who, 'net-2')).status, 200, `${who} ${op} elsewhere`);
        for (const op of Object.keys(OPS)) assert.equal((await OPS[op]('admin', 'net-1')).status, 200, `admin ${op}`);
        guard(false);
        for (const [who, op] of nonAdmins) assert.equal((await OPS[op](who, 'net-1')).status, 200, `${who} ${op}, guard off`);
    } finally {
        remoteAccess.setConfigForTest({});
        for (const k of Object.keys(answers)) delete h.netbird.answers[k];
    }
});
