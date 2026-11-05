// The Browser Gateway's groups, standing policies and peers are app-owned infrastructure:
//   - resource writes never add or drop a managed group; the target groups follow one rule
//     (open network + address type), under one lock shared with the target sync;
//   - no grant, recurring rule or grant reconcile puts anyone into a managed group;
//   - the setup never takes over a group or policy that merely has the managed name;
//   - deleting a resource never deletes a managed group or policy; merge, move and the resource
//     editor never re-point or delete a managed policy;
//   - the gateway is never a routing peer;
//   - a resource write that got no answer holds new sessions back until a later sync.
// Managed objects are recognized by stored id, or by their LIVE name from NetBird. NetBird and
// the database are stubs; nothing here needs Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');

// ─── Stubs, before db.js and lib/remote-access.js destructure them ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] ?? null;
core.setSetting = async (k, v) => { settings[k] = v; };
const sqls = [];
let rowsFor = () => null; // per-test SQL answers
core.pool.query = async (sql, params) => {
    sqls.push({ sql, params });
    const r = rowsFor(sql, params);
    if (r) return { rows: r };
    if (/nextval/.test(sql)) return { rows: [{ id: 701 }] };
    if (/RETURNING id/.test(sql)) return { rows: [{ id: 701 }] };
    if (/RETURNING \*/.test(sql)) return { rows: [{ id: 1, user_id: 'user-1', targets: [], days: [1], start_time: '09:00', end_time: '10:00' }] };
    return { rows: [] };
};

const nb = require('../lib/netbird');
const { runWithTenant } = nb;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
let state;
const calls = [];
const resourceOf = (p) => { const m = /^\/api\/networks\/([^/]+)\/resources\/([^/]+)$/.exec(p); return m && state.resources.find(r => r.id === decodeURIComponent(m[2]) && r.net === decodeURIComponent(m[1])); };
nb.netbirdGet = async (p) => {
    calls.push(['GET', p]);
    if (state.readHook) await state.readHook(p);
    if (p === '/api/groups') return state.groupsReadable === false ? null : clone(state.groups);
    if (p.startsWith('/api/groups/')) {
        if (state.groupReadable === false) return null;
        const g = state.groups.find(x => x.id === decodeURIComponent(p.slice('/api/groups/'.length)));
        return g ? clone(g) : null;
    }
    if (p === '/api/policies') return clone(state.policies);
    if (p === '/api/users' || p.startsWith('/api/users?')) return [{ id: 'user-1', role: 'user', auto_groups: [] }];
    if (p === '/api/networks') return clone(state.networks);
    if (p === '/api/networks/resources') return state.resourcesReadable === false ? null : clone(state.resources);
    const res = resourceOf(p);
    if (res) return clone(res);
    let m;
    if ((m = /^\/api\/networks\/([^/]+)\/resources$/.exec(p))) return clone(state.resources.filter(r => r.net === m[1]));
    if ((m = /^\/api\/networks\/([^/]+)$/.exec(p))) return clone(state.networks.find(n => n.id === m[1]) || null);
    return [];
};
nb.netbirdPost = async (p, body) => {
    calls.push(['POST', p, clone(body)]);
    return { status: 200, body: { id: `nb-${calls.length}`, type: 'host' } };
};
nb.netbirdReq = async (method, p, body) => {
    if (method === 'GET') {
        const res = resourceOf(p);
        return res ? { status: 200, body: clone(res) } : { status: 404, body: null };
    }
    calls.push([method, p, clone(body)]);
    if (state.putHook && method === 'PUT') return state.putHook(p, body);
    const res = resourceOf(p);
    if (res && method === 'PUT' && body && Array.isArray(body.groups)) res.groups = body.groups.map(id => ({ id }));
    return { status: 200, body: { id: 'ok' } };
};

const db = require('../db');
const ra = require('../lib/remote-access');
const { evaluateUserAccess } = require('../lib/remote-access-auth');
ra.setRemoteAccessDeps({ addResourceGroups: db.addResourceGroups, removeResourceGroups: db.removeResourceGroups });

const MANAGED = { gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' };
function reset(over = {}) {
    calls.length = 0; sqls.length = 0; rowsFor = () => null;
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED);
    ra._internal.resetSettlingForTest();
    state = {
        groups: [
            { id: 'g-all', name: 'All', peers: [{ id: 'p-gw' }, { id: 'p-r1' }] },
            { id: 'g-gw', name: 'Browser Gateway', peers: [{ id: 'p-gw' }] }, { id: 'g-gwt', name: 'Browser Gateway Targets', peers: [] },
            { id: 'g-ngw', name: 'Browser Gateway Names', peers: [] }, { id: 'g-ngwt', name: 'Browser Gateway Name Targets', peers: [] },
            { id: 'g-own', name: 'Team', peers: [] }, { id: 'g-new', name: 'New', peers: [] },
            { id: 'g-routers', name: 'Routers', peers: [{ id: 'p-r1' }] }, { id: 'g-mixed', name: 'Mixed', peers: [{ id: 'p-r1' }, { id: 'p-gw' }] },
        ],
        networks: [{ id: 'n1', name: 'Office', resources: ['r1'] }, { id: 'n2', name: 'Lab', resources: ['r2'] }],
        resources: [
            { id: 'r1', net: 'n1', name: 'srv', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-own', name: 'Team' }, { id: 'g-gwt', name: 'Browser Gateway Targets' }] },
            { id: 'r2', net: 'n2', name: 'lab', address: '192.0.2.10/32', enabled: true, groups: [{ id: 'g-gwt', name: 'Browser Gateway Targets' }] },
        ],
        policies: [
            { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
        ],
        ...over,
    };
}
const writes = (method, re) => calls.filter(c => c[0] === method && re.test(c[1]));
const lastBody = (method, re) => { const w = writes(method, re); return w.length ? w[w.length - 1][2] : null; };

// ─── Resource writes ───
test('a new resource never takes a managed group from the caller; the target group follows the rule', async () => {
    reset();
    await db.createClientResource('n1', { name: 'a', address: '10.0.0.9', groups: ['g-gwt', 'g-ngwt', 'g-gw', 'g-ngw', 'g-own'], policies: [] });
    assert.deepEqual(lastBody('POST', /\/api\/networks\/n1\/resources$/).groups, ['g-own', 'g-gwt'], 'open network, IPv4: the IP target group by the rule');
    await db.createClientResource('n2', { name: 'b', address: 'files.example.com', groups: ['g-gwt', 'g-own'], policies: [] });
    assert.deepEqual(lastBody('POST', /\/api\/networks\/n2\/resources$/).groups, ['g-own'], 'closed network: none');
});

test('without stored ids, the old managed groups are still recognized by their live name', async () => {
    reset();
    ra._internal.setManagedForTest({});
    state.groups.push({ id: 'old-gwt', name: 'Browser Gateway Targets', peers: [] });
    await db.createClientResource('n2', { name: 'c', address: '10.9.9.9', groups: ['old-gwt', 'g-own'], policies: [] });
    assert.deepEqual(lastBody('POST', /\/api\/networks\/n2\/resources$/).groups, ['g-own']);
    reset({ groupsReadable: false });
    await assert.rejects(db.createClientResource('n1', { name: 'd', address: '10.0.0.8', groups: ['g-own'], policies: [] }), /Couldn't read the groups/);
    assert.equal(writes('POST', /resources$/).length, 0, 'nothing created when the groups cannot be checked');
});

test('an edit can neither add nor drop a managed group; an address that changes type swaps the target group', async () => {
    reset();
    const edit = (o) => db.editResource('n1', 'r1', { name: 'srv', address: '10.0.0.5/32', description: '', ...o });
    await edit({ groups: ['g-new', 'g-ngwt', 'g-gw'] });
    assert.deepEqual(lastBody('PUT', /r1$/).groups, ['g-new', 'g-gwt']);
    await edit({ groups: [] });
    assert.deepEqual(lastBody('PUT', /r1$/).groups, ['g-gwt'], 'dropping the target group is not possible');
    await edit({ groups: undefined });
    assert.deepEqual(lastBody('PUT', /r1$/).groups, ['g-gwt'], 'omitted groups keep the current ones');
    await edit({ address: 'srv.example.com', groups: ['g-own', 'g-gwt'] });
    assert.deepEqual(lastBody('PUT', /r1$/).groups, ['g-own', 'g-ngwt'], 'a domain gets the names target group, never the IP one');
    await edit({ address: '*.example.com', groups: ['g-own'] });
    assert.deepEqual(lastBody('PUT', /r1$/).groups, ['g-own'], 'a wildcard gets no target group');
});

test("an editor's write to their own resource leaves another user's browser access as it was", async () => {
    reset();
    state.resources.push({ id: 'r3', net: 'n2', name: 'editor', address: 'files.editor.example', enabled: true, groups: [] });
    await db.editResource('n2', 'r3', { name: 'editor', address: 'files.editor.example', groups: ['g-gwt'] });
    const written = lastBody('PUT', /r3$/).groups;
    const snap = {
        users: [{ id: 'victim', auto_groups: ['g-staff'] }],
        peers: [{ id: 'p-gw', groups: [{ id: 'g-gw' }], connected: true }],
        groups: [], routes: [], grants: [],
        networks: [{ id: 'n1', resources: ['r1'] }, { id: 'n2', resources: ['r3'] }],
        resources: [
            { id: 'r1', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-gwt' }] },
            { id: 'r3', address: 'files.editor.example', enabled: true, groups: written.map(id => ({ id })) },
        ],
        policies: [
            state.policies[0],
            { id: 'pol-staff', name: 'Staff', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-gwt' }] }] },
        ],
    };
    const v = evaluateUserAccess(snap, { networks: ['n1'], gatewayGroupId: 'g-gw', managedPolicyIds: ['pol-gw'] }, { userId: 'victim', address: '10.0.0.5', port: 3389 });
    assert.equal(v.code, 'OK');
});

test('read-modify-write helpers set the target groups by the rule, not from their read', async () => {
    reset();
    await db.setResourceEnabled('n2', 'r2', false); // r2 is in a closed network but still carries the target group
    assert.deepEqual(lastBody('PUT', /r2$/).groups, []);
    reset();
    assert.equal(await db.removeResourceGroups('n1', 'r1', ['g-gwt']), false, 'the rule still wants it');
    assert.equal(writes('PUT', /r1$/).length, 0);
    reset();
    state.resources[1].groups = [];
    assert.equal(await db.addResourceGroups('n2', 'r2', ['g-gwt']), false, 'a closed network never gets it');
    assert.equal(writes('PUT', /r2$/).length, 0);
    assert.equal(await db.addResourceGroups('n2', 'r2', ['g-own']), true);
    assert.deepEqual(lastBody('PUT', /r2$/).groups, ['g-own']);
});

test('a write computed before a configuration change finishes before the sync that follows it', async () => {
    reset();
    let release;
    const held = new Promise(r => { release = r; });
    const order = [];
    state.putHook = async (p, body) => {
        order.push('put:' + body.groups.join(','));
        if (order.length === 1) await held;
        const res = resourceOf(p); res.groups = body.groups.map(id => ({ id }));
        return { status: 200, body: {} };
    };
    state.readHook = async (p) => { if (p === '/api/networks/resources') order.push('sync-read'); };
    const editing = db.editResource('n1', 'r1', { name: 'srv', address: '10.0.0.5/32', groups: ['g-own'] });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    ra._internal.setConfigForTest({ enabled: true, networks: [] }); // the admin closes n1
    const syncing = ra._internal.syncTargetGroup();
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(order, ['put:g-own,g-gwt'], 'the sync waits for the write in flight');
    release();
    await editing;
    await syncing;
    assert.deepEqual(order.slice(0, 2), ['put:g-own,g-gwt', 'sync-read']);
    assert.deepEqual(state.resources[0].groups.map(g => g.id), ['g-own'], 'the sync then took the target group off');
});

test('a resource write that got no answer holds new sessions back until a later sync has finished', async () => {
    reset();
    state.putHook = async () => ({ status: 0, error: 'timeout' });
    await assert.rejects(db.setResourceEnabled('n1', 'r1', true), /Failed to set resource enabled/);
    assert.equal(ra._internal.settlingForTest(), true);
    assert.equal(ra._internal.settleTimerPendingForTest(), true, 'one follow-up sync is scheduled');
    const viewer = { user_id: 'user-1' };
    await assert.rejects(ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }), (e) => e.code === 'TARGETS_SETTLING');
    const check = await ra.checkAccess(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 });
    assert.equal(check.steps[0].code, 'TARGETS_SETTLING');
    ra._internal.passSettleDeadlineForTest();
    assert.equal(ra._internal.settlingForTest(), true, 'the deadline alone does not end it');
    state.putHook = null;
    state.resourcesReadable = false;
    await assert.rejects(ra._internal.syncTargetGroup());
    assert.equal(ra._internal.settlingForTest(), true, 'a failed sync keeps refusing');
    state.resourcesReadable = true;
    await ra._internal.syncTargetGroup();
    assert.equal(ra._internal.settlingForTest(), false);
    ra.beginStartupSettling();
    assert.equal(ra._internal.settlingForTest(), true, 'a restart starts in the same state');
    ra._internal.resetSettlingForTest();
});

// ─── Grants ───
test('no grant puts anyone into a managed group, and nothing is recorded or written for one', async () => {
    for (const id of ['g-gw', 'g-gwt', 'g-ngw', 'g-ngwt']) {
        reset();
        await assert.rejects(db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'group', id, name: 'Anything' }] }, { email: 'a@example.test' }),
            /managed by Browser Remote Access/, id);
        assert.equal(sqls.some(q => /INSERT INTO temporary_access_grants/.test(q.sql)), false, id);
        assert.equal(writes('PUT', /^\/api\/users\//).length, 0, id);
    }
    reset();
    ra._internal.setManagedForTest({});
    state.groups.push({ id: 'old-gw', name: 'Browser Gateway', peers: [] });
    await assert.rejects(db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'group', id: 'old-gw', name: 'Team' }] }, {}), /managed by Browser Remote Access/);
    reset({ groupsReadable: false });
    await assert.rejects(db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'group', id: 'g-own' }] }, {}), /Couldn't read the groups/);
});

test('an ordinary group grant still joins the user to it', async () => {
    reset();
    await db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'group', id: 'g-own' }] }, {});
    const put = lastBody('PUT', /^\/api\/users\/user-1$/);
    assert.ok(put && put.auto_groups.includes('g-own'));
});

test('the grant reconcile never re-adds a managed group, and a group it cannot read is not added', async () => {
    reset();
    ra._internal.setManagedForTest({}); // ids lost; the group is known by its live name
    state.groups.push({ id: 'old-gw', name: 'Browser Gateway', peers: [] });
    rowsFor = (sql) => {
        if (/SELECT id, user_id FROM temporary_access_grants WHERE status='active'/.test(sql)) return [{ id: 9, user_id: 'user-1' }];
        if (/SELECT id, user_id, status, assigned_groups, group_id/.test(sql)) return [{ id: 9, user_id: 'user-1', status: 'active', assigned_groups: ['old-gw', 'g-own'], group_id: '' }];
        return null;
    };
    await db.reconcileActiveGrants();
    const puts = writes('PUT', /^\/api\/users\//);
    assert.equal(puts.length, 1, 'only the ordinary group');
    assert.deepEqual(puts[0][2].auto_groups, ['g-own']);
    reset({ groupReadable: false });
    rowsFor = (sql) => {
        if (/SELECT id, user_id FROM temporary_access_grants WHERE status='active'/.test(sql)) return [{ id: 9, user_id: 'user-1' }];
        if (/SELECT id, user_id, status, assigned_groups, group_id/.test(sql)) return [{ id: 9, user_id: 'user-1', status: 'active', assigned_groups: ['g-own'], group_id: '' }];
        return null;
    };
    await db.reconcileActiveGrants();
    assert.equal(writes('PUT', /^\/api\/users\//).length, 0);
});

test('recurring rules: create, update and the scheduled window refuse a managed group; a disabling save works', async () => {
    const rule = { userId: 'user-1', targets: [{ type: 'group', id: 'g-gw', name: 'Team' }], days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' };
    reset();
    await assert.rejects(db.createRecurringAccess(rule, {}), /managed by Browser Remote Access/);
    assert.equal(sqls.some(q => /INSERT INTO recurring_access/.test(q.sql)), false);
    reset();
    const row = { id: 3, user_id: 'user-1', targets: rule.targets, days: rule.days, start_time: '00:00', end_time: '23:59', enabled: true, tenant: '' };
    rowsFor = (sql) => (/SELECT \* FROM recurring_access WHERE id=\$1/.test(sql) ? [row] : null);
    await assert.rejects(db.updateRecurringAccess(3, rule, {}), /managed by Browser Remote Access/);
    assert.equal(sqls.some(q => /UPDATE recurring_access SET user_id/.test(q.sql)), false);
    await db.updateRecurringAccess(3, { ...rule, enabled: false }, {});
    assert.ok(sqls.some(q => /UPDATE recurring_access SET user_id/.test(q.sql)), 'a rule can always be switched off');
    // A rule stored before this change: its window opens, and the grant is refused.
    reset();
    rowsFor = (sql) => {
        if (/SELECT \* FROM recurring_access WHERE enabled = TRUE/.test(sql)) return [{ ...row, last_spawn_key: '' }];
        if (/SELECT enabled FROM recurring_access/.test(sql)) return [{ enabled: true }];
        return null;
    };
    const err = console.error; console.error = () => { };
    try { await db.runRecurringAccess(); } finally { console.error = err; }
    assert.equal(sqls.some(q => /INSERT INTO temporary_access_grants/.test(q.sql)), false);
    assert.equal(writes('PUT', /^\/api\/users\//).length, 0);
});

test('an active grant with a managed group target cannot be extended', async () => {
    reset();
    rowsFor = (sql) => (/SELECT \* FROM temporary_access_grants WHERE id=\$1/.test(sql) ? [{ id: 4, status: 'active', user_id: 'user-1', targets: [{ type: 'group', id: 'g-gw' }] }] : null);
    await assert.rejects(db.extendTemporaryAccessGrant(4, { durationMinutes: 60 }, {}), /managed by Browser Remote Access/);
    assert.equal(sqls.some(q => /UPDATE temporary_access_grants SET expires_at/.test(q.sql)), false);
});

// ─── Routing peers ───
test('the Browser Gateway is never a routing peer, for any caller', async () => {
    for (const body of [{ peer: 'p-gw' }, { peerGroups: ['g-gw'] }, { peerGroups: ['g-gwt'] }, { peerGroups: ['g-all'] }, { peerGroups: ['g-mixed'] }]) {
        reset();
        await assert.rejects(db.createNetworkRouter('n1', body), /can't be a routing peer/, JSON.stringify(body));
        assert.equal(writes('POST', /routers$/).length, 0);
    }
    reset();
    ra._internal.setManagedForTest({});
    state.groups.push({ id: 'old-gw', name: 'Browser Gateway', peers: [{ id: 'p-old' }] });
    await assert.rejects(db.createNetworkRouter('n1', { peer: 'p-old' }), /can't be a routing peer/, 'a peer of a group with the managed name');
    reset({ groupsReadable: false });
    await assert.rejects(db.createNetworkRouter('n1', { peer: 'p-r1' }), /Couldn't read the groups/);
    reset();
    await db.createNetworkRouter('n1', { peer: 'p-r1' });
    await db.createNetworkRouter('n1', { peerGroups: ['g-routers'] });
    assert.equal(writes('POST', /routers$/).length, 2, 'ordinary peers and groups still route');
});

// ─── Setup: nothing is adopted by name ───
test('the setup never takes over a group or policy that only has the managed name', async () => {
    const variants = {
        'a jwt group with members': [{ id: 'jwt-gw', name: 'Browser Gateway', issued: 'jwt', peers: [{ id: 'p-x' }] }],
        'an empty api group': [{ id: 'api-gw', name: 'Browser Gateway', issued: 'api', peers: [] }],
        'duplicates': [{ id: 'd1', name: 'Browser Gateway', issued: 'api' }, { id: 'd2', name: 'Browser Gateway', issued: 'jwt' }],
    };
    for (const [label, groups] of Object.entries(variants)) {
        reset({ groups, policies: [] });
        ra._internal.setManagedForTest({});
        delete settings.remote_access_nb;
        await assert.rejects(ra._internal.applyGatewayObjects(), /already has a group named "Browser Gateway"/, label);
        assert.match(ra._internal.lastApplyForTest().error, /Delete or rename that group/, label);
        assert.equal(writes('POST', /^\/api\/policies$/).length + writes('PUT', /^\/api\/policies\//).length, 0, label);
        assert.equal(String(settings.remote_access_nb || '').includes(groups[0].id), false, `${label}: never stored`);
    }
    reset({ policies: [{ id: 'foreign', name: 'Browser Gateway', enabled: true, rules: [] }] });
    ra._internal.setManagedForTest({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt' }); // groups known, policy id lost
    await assert.rejects(ra._internal.applyGatewayObjects(), /already has a policy named "Browser Gateway"/);
    assert.equal(writes('PUT', /^\/api\/policies\/foreign$/).length, 0, 'the foreign policy is not overwritten');
    reset({ resources: [], networks: [] });
    state.policies.push({ id: 'pol-ngw', name: 'Browser Gateway (Names)', enabled: true, rules: [] });
    await ra._internal.applyGatewayObjects();
    assert.deepEqual(writes('PUT', /^\/api\/policies\//).map(c => c[1]).sort(), ['/api/policies/pol-gw', '/api/policies/pol-ngw'], 'stored ids are used');
});

// ─── Deleting and re-pointing ───
test('deleting a resource never deletes a managed group or policy; a tenant cleans up as before', async () => {
    reset();
    state.groups.find(g => g.id === 'g-gwt').resources_count = 0;
    state.policies.push({ id: 'pol-direct', name: 'srv access', enabled: true, rules: [{ destinationResource: { id: 'r1' } }] });
    state.policies.push({ id: 'pol-own', name: 'team', enabled: true, rules: [{ destinations: [{ id: 'g-own' }] }] });
    await db.deleteResource('n1', 'r1');
    const deleted = writes('DELETE', /./).map(c => c[1]);
    assert.ok(deleted.includes('/api/policies/pol-direct'));
    assert.ok(deleted.includes('/api/groups/g-own'), 'an ordinary empty group is still cleaned up');
    assert.equal(deleted.includes('/api/groups/g-gwt'), false);
    assert.equal(deleted.includes('/api/policies/pol-gw'), false);
    reset();
    state.policies.push({ id: 't-pol', name: 'Browser Gateway', enabled: true, rules: [{ destinationResource: { id: 'r1' } }] });
    await runWithTenant('acct-b', () => db.deleteResource('n1', 'r1'));
    assert.ok(writes('DELETE', /./).some(c => c[1] === '/api/policies/t-pol'), "a tenant's own policy with that name is not special");
});

test('the resource editor, merge and move never re-point or delete a managed policy', async () => {
    reset();
    state.policies[0].rules[0].destinationResource = { id: 'r1', type: 'host' };
    await assert.rejects(db.checkResourcePolicySync('r1', []), (e) => e.status === 409 && /Browser Gateway's own policy/.test(e.message));
    state.resources.push({ id: 'r1b', net: 'n1', name: 'dup', address: '10.0.0.5/32', enabled: true, groups: [] });
    state.networks[0].resources.push('r1b');
    await assert.rejects(db.mergeResources('n1', ['r1b', 'r1'], 'r1b'), /Browser Gateway's own policy/);
    await assert.rejects(db.moveResources('n1', ['r1'], 'n2'), /Browser Gateway's own policy/);
    assert.equal(writes('PUT', /^\/api\/policies\//).length + writes('DELETE', /./).length + writes('POST', /resources$/).length, 0, 'nothing changed');
});

// ─── Review round 1 ───
test('a timer that outlives its lock holder queues for the lock like everyone else', async () => {
    const order = [];
    let leaked;
    await ra.withTargetLock(async () => {
        setTimeout(() => { leaked = ra.withTargetLock(async () => { order.push('leaked'); }); }, 5);
    });
    let release;
    const gate = new Promise(r => { release = r; });
    const holder = ra.withTargetLock(async () => { order.push('holder-start'); await gate; order.push('holder-end'); });
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(order, ['holder-start'], 'the late timer did not skip the queue');
    release();
    await holder;
    await leaked;
    assert.deepEqual(order, ['holder-start', 'holder-end', 'leaked']);
});

test('a snapshot read that started before the targets changed is never used afterwards', async () => {
    reset();
    let n = 0;
    const gates = [];
    state.readHook = async (p) => { if (p === '/api/peers') { const i = n++; await new Promise(r => gates.push(r)); state.readIndex = i; } };
    const nbGet = nb.netbirdGet;
    nb.netbirdGet = async (p) => (p === '/api/users' ? (await nbGet(p), [{ id: 'read-' + (state.readIndex ?? 'x') }]) : nbGet(p));
    try {
        const first = ra._internal.freshSnapshot(60_000);
        await new Promise(r => setImmediate(r));
        ra._internal.invalidateSnapshot(); // e.g. a target sync finished
        const second = ra._internal.freshSnapshot(60_000);
        await new Promise(r => setImmediate(r));
        assert.equal(gates.length, 2, 'a new read started instead of joining the old one');
        gates[0](); gates[1]();
        const [old, fresh] = await Promise.all([first, second]);
        assert.equal(old, fresh, 'a caller waiting on the overtaken read gets the newer one');
        const again = await ra._internal.freshSnapshot(60_000);
        assert.equal(again, fresh, 'the cache holds the read that started after the change');
    } finally { nb.netbirdGet = nbGet; state.readHook = null; ra._internal.invalidateSnapshot(); }
});

test('a successful sync that started before the deadline leaves one more sync scheduled', async () => {
    reset();
    ra.beginStartupSettling();
    ra._internal.clearSettleTimerForTest(); // as when a retry replaced the deadline timer
    await ra._internal.syncTargetGroup();
    assert.equal(ra._internal.settlingForTest(), true);
    assert.equal(ra._internal.settleTimerPendingForTest(), true, 'not left waiting for the periodic reconcile');
    ra._internal.resetSettlingForTest();
});

test('deleting a resource deletes no group whose read is an error answer', async () => {
    reset();
    ra._internal.setManagedForTest({}); // ids lost: only the live name would tell
    state.groups = state.groups.filter(g => g.id !== 'g-gwt');
    const get = nb.netbirdGet;
    nb.netbirdGet = async (p) => (p === '/api/groups/g-gwt' ? { code: 500, message: 'internal error' } : get(p));
    try {
        await db.deleteResource('n1', 'r1');
        assert.equal(writes('DELETE', /^\/api\/groups\/g-gwt$/).length, 0);
    } finally { nb.netbirdGet = get; }
});

test('an Access Profile whose group is a managed one is refused as a grant target', async () => {
    reset();
    rowsFor = (sql) => (/FROM access_profiles/.test(sql) ? [{ id: 7, name: 'Browser Gateway', group_id: 'g-gw', sources: [], protocol: 'all', ports: '', shared: true, posture_checks: [] }] : null);
    await assert.rejects(db.createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'profile', id: 7 }] }, {}), /managed by Browser Remote Access/);
    await assert.rejects(db.createRecurringAccess({ userId: 'user-1', targets: [{ type: 'profile', id: '7', name: 'P' }], days: [1], startTime: '09:00', endTime: '10:00' }, {}), /managed by Browser Remote Access/);
    assert.equal(sqls.some(q => /INSERT INTO (temporary_access_grants|recurring_access)/.test(q.sql)), false);
});

test('a group added to a resource is never a managed one, by stored id or live name', async () => {
    reset();
    ra._internal.setManagedForTest({ targetGroupId: 'g-gwt', namesTargetGroupId: 'g-ngwt' }); // the source group id was lost
    state.resources[1].groups = [];
    assert.equal(await db.addResourceGroups('n2', 'r2', ['g-gw', 'g-gwt', 'g-own']), true);
    assert.deepEqual(lastBody('PUT', /r2$/).groups, ['g-own'], 'an Access Profile group with the managed name is not attached');
    reset({ groupsReadable: false });
    state.resources[1].groups = [];
    await assert.rejects(db.addResourceGroups('n2', 'r2', ['g-own']), /Couldn't read the groups/);
    reset();
    assert.equal(await db.addResourceGroups('n1', 'r1', ['g-gwt']), false, "the sync's own call needs no group read");
    assert.equal(calls.some(c => c[1] === '/api/groups'), false);
});

test("a resource's access policy never takes a managed group as its source", async () => {
    reset();
    const pol = { protocol: 'tcp', ports: '3389', sources: ['g-own', 'g-gw'] };
    await assert.rejects(db.createClientResource('n1', { name: 'x', address: '10.0.0.9', groups: [], policies: [pol] }), /can't be the source of an access policy/);
    assert.equal(writes('POST', /./).length, 0, 'nothing created');
    await assert.rejects(db.checkResourcePolicySync('r1', [pol]), /can't be the source of an access policy/);
    await assert.rejects(db.syncResourcePolicies('n1', 'r1', [pol]), /can't be the source of an access policy/);
    assert.equal(writes('DELETE', /./).length + writes('POST', /./).length, 0);
});
