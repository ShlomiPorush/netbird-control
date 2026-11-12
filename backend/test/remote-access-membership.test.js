// Browser Remote Access groups belong to the app:
//   - members added outside the app (a user's own groups, a user's device in a gateway group, any
//     device in a target group) are removed from data the app already read; a gateway enrolled
//     with a setup key (no user) stays;
//   - the group screens, invites and setup keys never add anyone to a managed group, rename it or
//     delete it; removing members still works;
//   - the managed objects carry the installation name, and every installation recognizes every
//     other installation's objects, in the grant checks and in session authorization.
// NetBird and the database are stubs; nothing here needs Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');

// ─── Stubs, before db.js and lib/remote-access.js destructure them ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] ?? null;
core.setSetting = async (k, v) => { settings[k] = v; };
core.pool.query = async () => ({ rows: [] });
core.pool.connect = async () => ({ query: async () => ({ rows: [] }), release() { } });

const nb = require('../lib/netbird');
const { runWithTenant } = nb;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
let state;
const calls = [];
const groupOf = (id) => state.groups.find(g => g.id === id);
nb.netbirdGet = async (p) => {
    calls.push(['GET', p]);
    if (p === '/api/groups') return clone(state.groups);
    if (p.startsWith('/api/groups/')) {
        const g = groupOf(decodeURIComponent(p.slice('/api/groups/'.length)));
        return g ? clone(state.groupShape ? state.groupShape(g) : g) : null;
    }
    if (p === '/api/users') return clone(state.users.filter(u => !u.is_service_user));
    if (p === '/api/users?service_user=true') return clone(state.users.filter(u => u.is_service_user));
    if (p === '/api/policies') return clone(state.policies);
    if (p === '/api/networks') return [];
    if (p === '/api/networks/resources') return [];
    if (p === '/api/peers') return clone(state.peers || []);
    return [];
};
nb.netbirdPost = async (p, body) => {
    calls.push(['POST', p, clone(body)]);
    if (p === '/api/groups') { const g = { id: `g-new-${calls.length}`, name: body.name, peers: [], resources: [] }; state.groups.push(g); return { status: 200, body: g }; }
    if (p === '/api/policies') return { status: 200, body: { id: `pol-new-${calls.length}` } };
    return { status: 200, body: { id: `nb-${calls.length}` } };
};
function put(p, body) {
    calls.push(['PUT', p, clone(body)]);
    if (state.putHook) { const r = state.putHook(p, body); if (r) return r; }
    let m;
    if ((m = /^\/api\/groups\/([^/]+)$/.exec(p))) {
        const g = groupOf(decodeURIComponent(m[1]));
        g.name = body.name; g.peers = body.peers.map(id => ({ id })); g.resources = body.resources;
    }
    if ((m = /^\/api\/users\/([^/]+)$/.exec(p))) {
        const u = state.users.find(x => x.id === decodeURIComponent(m[1]));
        Object.assign(u, { role: body.role, auto_groups: body.auto_groups, is_blocked: body.is_blocked });
    }
    return { status: 200, body: { id: 'ok' } };
}
nb.netbirdReq = async (method, p, body) => (method === 'PUT' ? put(p, body) : (calls.push([method, p]), { status: 200, body: null }));
nb.netbirdPut = async (p, body) => put(p, body);

const db = require('../db');
const ra = require('../lib/remote-access');
const { evaluateUserAccess } = require('../lib/remote-access-auth');
const audits = [];
const setupKeys = [];
ra.setRemoteAccessDeps({
    addResourceGroups: db.addResourceGroups, removeResourceGroups: db.removeResourceGroups,
    removeUserManagedGroups: db.removeUserManagedGroups, recordAudit: (e) => { audits.push(e); },
    createSetupKey: async (o) => { setupKeys.push(o); return { id: 'k1' }; },
});

const MANAGED = { gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' };
function reset(over = {}) {
    calls.length = 0; audits.length = 0; setupKeys.length = 0;
    for (const k of Object.keys(settings)) delete settings[k];
    ra._internal.setConfigForTest({ enabled: true, networks: [] });
    ra._internal.setManagedForTest(MANAGED);
    ra._internal.resetSettlingForTest();
    ra._internal.resetMembershipForTest();
    state = {
        groups: [
            { id: 'g-gw', name: 'Browser Gateway (NetBird Control)', peers: [{ id: 'p-gw' }], resources: [] },
            { id: 'g-gwt', name: 'Browser Gateway Targets (NetBird Control)', peers: [], resources: [{ id: 'r1', type: 'host' }] },
            { id: 'g-ngw', name: 'Browser Gateway Names (NetBird Control)', peers: [], resources: [] },
            { id: 'g-ngwt', name: 'Browser Gateway Name Targets (NetBird Control)', peers: [], resources: [] },
            { id: 'g-team', name: 'Team', peers: [{ id: 'p-u1' }], resources: [] },
        ],
        users: [
            { id: 'u1', email: 'u1@example.com', role: 'user', auto_groups: ['g-team'], is_blocked: false },
            { id: 'u2', email: 'u2@example.com', role: 'admin', auto_groups: [], is_blocked: false },
            { id: 'svc', name: 'NetBird Control', role: 'admin', auto_groups: [], is_blocked: false, is_service_user: true },
        ],
        policies: [],
        ...over,
    };
}
const writes = (method, re) => calls.filter(c => c[0] === method && re.test(c[1]));
const peerIds = (gid) => groupOf(gid).peers.map(p => p.id);
async function enforce(data) {
    ra.enforceManagedMembership(data);
    await ra._internal.membershipIdleForTest();
}

// ─── Members added outside the app ───
test('a user given a managed group outside the app loses it; their other groups and other users stay', async () => {
    reset();
    state.users[0].auto_groups = ['g-team', 'g-gw', 'g-ngwt'];
    state.users[1].auto_groups = ['g-team'];
    await enforce({ users: clone(state.users) });
    assert.deepEqual(state.users[0].auto_groups, ['g-team']);
    assert.equal(state.users[0].role, 'user');
    assert.equal(state.users[0].is_blocked, false);
    assert.equal(writes('PUT', /^\/api\/users\//).length, 1, 'only the user that had a managed group is written');
    assert.equal(audits.length, 2);
    assert.equal(audits[0].action, 'remote_access.member_remove');
    assert.equal(audits[0].actorName, 'System');
});

test('the write uses a fresh read: a group already gone or a user changed since is not overwritten', async () => {
    reset();
    const stale = clone(state.users);
    stale[0].auto_groups = ['g-gw'];
    state.users[0].auto_groups = ['g-team', 'g-new'];
    state.users[0].is_blocked = true;
    await enforce({ users: stale });
    assert.equal(writes('PUT', /^\/api\/users\//).length, 0, 'the live user no longer has the group');
    state.users[0].auto_groups = ['g-team', 'g-new', 'g-gw'];
    ra._internal.resetMembershipForTest();
    await enforce({ users: stale });
    assert.deepEqual(state.users[0].auto_groups, ['g-team', 'g-new'], 'the groups added since are kept');
    assert.equal(state.users[0].is_blocked, true, 'the block made since is kept');
});

test('service users are not touched', async () => {
    reset();
    state.users[2].auto_groups = ['g-gw'];
    await enforce({ users: clone(state.users) });
    assert.equal(writes('PUT', /^\/api\/users\//).length, 0);
});

test("a user's device in a gateway group is taken out, and its owner loses the group; the setup-key gateway stays", async () => {
    reset();
    state.groups[0].peers.push({ id: 'p-u1' });
    state.users[0].auto_groups = ['g-team', 'g-gw'];
    const peers = [
        { id: 'p-gw', name: 'gateway', user_id: '', groups: [{ id: 'g-gw' }] },
        { id: 'p-u1', name: 'laptop', user_id: 'u1', groups: [{ id: 'g-gw' }, { id: 'g-team' }] },
    ];
    await enforce({ peers });
    assert.deepEqual(peerIds('g-gw'), ['p-gw']);
    assert.deepEqual(peerIds('g-team'), ['p-u1'], 'an ordinary group is not touched');
    assert.deepEqual(state.users[0].auto_groups, ['g-team']);
    const groupPut = writes('PUT', /^\/api\/groups\/g-gw$/);
    assert.equal(groupPut.length, 1);
    assert.equal(groupPut[0][2].name, 'Browser Gateway (NetBird Control)');
    assert.deepEqual(audits.map(a => a.meta.member).sort(), ['device', 'user']);
});

test('a gateway enrolled by a user login is removed as well, even when it is the only member', async () => {
    reset();
    state.groups[0].peers = [{ id: 'p-old-gw' }];
    await enforce({ peers: [{ id: 'p-old-gw', name: 'old gateway', user_id: 'u2', groups: [{ id: 'g-gw' }] }] });
    assert.deepEqual(peerIds('g-gw'), []);
});

test('any device in a target group is taken out; the resources of the group stay', async () => {
    reset();
    state.groups[1].peers = [{ id: 'p-x' }, { id: 'p-gw' }];
    await enforce({ peers: [
        { id: 'p-x', name: 'x', user_id: 'u1', groups: [{ id: 'g-gwt' }] },
        { id: 'p-gw', name: 'gateway', user_id: '', groups: [{ id: 'g-gw' }, { id: 'g-gwt' }] },
    ] });
    assert.deepEqual(peerIds('g-gwt'), []);
    assert.deepEqual(writes('PUT', /^\/api\/groups\/g-gwt$/)[0][2].resources, [{ id: 'r1', type: 'host' }]);
    assert.deepEqual(peerIds('g-gw'), ['p-gw']);
});

test('a group read that is not complete is never written back', async () => {
    for (const shape of [(g) => ({ ...g, resources: undefined }), (g) => ({ ...g, peers: [{}] }), (g) => ({ ...g, id: 'other' }), (g) => ({ ...g, resources: [{ id: 'r1' }] })]) {
        reset({ groupShape: shape });
        state.groups[1].peers = [{ id: 'p-x' }];
        await enforce({ peers: [{ id: 'p-x', user_id: 'u1', groups: [{ id: 'g-gwt' }] }] });
        assert.equal(writes('PUT', /^\/api\/groups\//).length, 0);
        assert.match(ra._internal.lastMembershipForTest().error, /in full/);
    }
});

test('a failed removal waits before it is tried again; a later success clears the error', async () => {
    reset({ putHook: () => ({ status: 500, raw: 'busy' }) });
    state.groups[1].peers = [{ id: 'p-x' }];
    const data = { peers: [{ id: 'p-x', user_id: 'u1', groups: [{ id: 'g-gwt' }] }] };
    await enforce(data);
    await enforce(data);
    assert.equal(writes('PUT', /^\/api\/groups\//).length, 1, 'not retried right away');
    assert.match(ra._internal.lastMembershipForTest().error, /busy/, 'the failure stays visible while it waits');
    state.putHook = null;
    ra._internal.passMembershipRetryForTest();
    await enforce(data);
    assert.deepEqual(peerIds('g-gwt'), []);
    assert.equal(ra._internal.lastMembershipForTest().error, '');
});

test('a group write that gets no answer holds new sessions back and is reported', async () => {
    reset({ putHook: () => ({ status: 0, error: 'timeout' }) });
    state.groups[1].peers = [{ id: 'p-x' }];
    await enforce({ peers: [{ id: 'p-x', user_id: 'u1', groups: [{ id: 'g-gwt' }] }] });
    assert.equal(ra._internal.settlingForTest(), true);
    assert.match(ra._internal.lastMembershipForTest().error, /timeout/);
    ra._internal.clearSettleTimerForTest();
});

test('NetBird answers an empty list as null: such a group is still cleaned up and renamed', async () => {
    reset({ groupShape: (g) => ({ ...g, peers: g.peers.length ? g.peers : null, resources: g.resources && g.resources.length ? g.resources : null }) });
    state.groups[0].peers.push({ id: 'p-u1' });
    await enforce({ peers: [{ id: 'p-u1', user_id: 'u1', groups: [{ id: 'g-gw' }] }] });
    assert.deepEqual(peerIds('g-gw'), ['p-gw']);
    assert.deepEqual(writes('PUT', /^\/api\/groups\/g-gw$/)[0][2].resources, []);
    settings.app_name = 'Prod';
    await ra._internal.applyGatewayObjects();
    assert.equal(groupOf('g-gwt').name, 'Browser Gateway Targets (Prod)', 'a target group without devices is renamed');
});

test("a user found through one group loses every managed group, so an earlier failure isn't hidden", async () => {
    reset({ putHook: (p) => (p === '/api/users/u1' ? { status: 500, raw: 'user-busy' } : null) });
    state.users[0].auto_groups = ['g-team', 'g-gwt'];
    await enforce({ users: clone(state.users) });
    assert.match(ra._internal.lastMembershipForTest().error, /user-busy/);
    state.putHook = null;
    ra._internal.passMembershipRetryForTest();
    state.groups[0].peers.push({ id: 'p-u1' });
    await enforce({ peers: [{ id: 'p-u1', name: 'laptop', user_id: 'u1', groups: [{ id: 'g-gw' }] }] });
    assert.deepEqual(state.users[0].auto_groups, ['g-team'], 'the target group the device did not show is removed too');
    assert.equal(ra._internal.lastMembershipForTest().error, '');
});

test('a user whose state NetBird does not return in full is not written, and the failure is reported', async () => {
    reset();
    state.users[0].auto_groups = ['g-gw'];
    delete state.users[0].is_blocked;
    await enforce({ users: clone(state.users) });
    assert.equal(writes('PUT', /^\/api\/users\//).length, 0);
    assert.match(ra._internal.lastMembershipForTest().error, /in full/);
});

test('nothing is written for another account, without stored groups, or for ordinary groups', async () => {
    reset();
    state.users[0].auto_groups = ['g-gw'];
    await runWithTenant('acct-b', () => ra.enforceManagedMembership({ users: clone(state.users) }));
    await ra._internal.membershipIdleForTest();
    ra._internal.setManagedForTest({});
    await enforce({ users: clone(state.users) });
    assert.equal(writes('PUT', /./).length, 0);
    reset();
    await enforce({ users: clone(state.users), peers: [{ id: 'p-u1', user_id: 'u1', groups: [{ id: 'g-team' }] }] });
    assert.equal(writes('PUT', /./).length, 0);
});

test('data that arrives during a run is checked right after it', async () => {
    reset();
    let release;
    const gate = new Promise(r => { release = r; });
    state.users[0].auto_groups = ['g-gw'];
    state.users[1].auto_groups = ['g-ngw'];
    const held = ra.withTargetLock(() => gate); // the first run waits for the target lock
    ra.enforceManagedMembership({ users: clone(state.users).slice(0, 1) });
    ra.enforceManagedMembership({ users: clone(state.users).slice(1, 2) });
    release();
    await held;
    await ra._internal.membershipIdleForTest();
    await new Promise(r => setImmediate(r));
    await ra._internal.membershipIdleForTest();
    assert.deepEqual(state.users[0].auto_groups, []);
    assert.deepEqual(state.users[1].auto_groups, []);
});

test("a user write waits for the target lock after taking the user's lock", async () => {
    reset();
    state.users[0].auto_groups = ['g-gw'];
    let release;
    const held = ra.withTargetLock(() => new Promise(r => { release = r; }));
    const removing = db.removeUserManagedGroups('u1', ['g-gw']);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(writes('PUT', /^\/api\/users\//).length, 0, 'no write while a managed-group writer holds the lock');
    release();
    await held;
    assert.deepEqual(await removing, { name: 'u1@example.com', removed: ['g-gw'] });
});

test('the regular users refresh and devices refresh run the clean-up for the main account', async () => {
    reset();
    state.users[0].auto_groups = ['g-gw'];
    db.resetNbCaches();
    await db.ensureUsersFresh();
    await ra._internal.membershipIdleForTest();
    assert.deepEqual(state.users[0].auto_groups, []);
    reset();
    state.groups[1].peers = [{ id: 'p-x' }];
    state.peers = [{ id: 'p-x', name: 'x', user_id: 'u1', groups: [{ id: 'g-gwt' }] }];
    db.resetNbCaches();
    await db.ensurePeersFresh();
    await ra._internal.membershipIdleForTest();
    assert.deepEqual(peerIds('g-gwt'), []);
});

// ─── Screens, invites and setup keys ───
test('the group screens never add to, rename or delete a managed group; removing members still works', async () => {
    reset();
    state.groups[0].peers.push({ id: 'p-extra' });
    await assert.rejects(db.setGroupPeers('g-gw', ['p-gw', 'p-extra', 'p-new']), /managed by Browser Remote Access/);
    await assert.rejects(db.setGroupPeers('g-gw', ['p-gw']), /managed by Browser Remote Access/, 'devices are set by the app only');
    assert.deepEqual(peerIds('g-gw'), ['p-gw', 'p-extra']);
    await assert.rejects(db.renameGroup('g-gwt', 'Renamed'), /managed by Browser Remote Access/);
    await assert.rejects(db.deleteGroup('g-ngw'), /managed by Browser Remote Access/);
    await assert.rejects(db.addUsersToGroup('g-ngwt', ['u1']), /managed by Browser Remote Access/);
    await assert.rejects(db.setUserGroups('u1', ['g-team', 'g-gw']), /managed by Browser Remote Access/);
    await assert.rejects(db.inviteUser({ name: 'n', email: 'n@example.com', role: 'user', autoGroups: ['g-gw'] }), /managed by Browser Remote Access/);
    state.users[0].auto_groups = ['g-team', 'g-gw'];
    await db.removeUsersFromGroup('g-gw', ['u1']);
    assert.deepEqual(state.users[0].auto_groups, ['g-team'], 'removing a user still works');
    await db.setUserGroups('u1', ['g-team']);
    await db.renameGroup('g-team', 'Team 2');
    assert.equal(groupOf('g-team').name, 'Team 2', 'an ordinary group is renamed as before');
});

test("another installation's groups are refused too, by their live name", async () => {
    reset();
    state.groups.push({ id: 'g-dev', name: 'Browser Gateway (NetBird Control DEV)', peers: [], resources: [] });
    await assert.rejects(db.refuseManagedGroupEdit(['g-dev']), /managed by Browser Remote Access/);
    await runWithTenant('acct-b', () => db.refuseManagedGroupEdit(['g-dev'])); // not in another account
});

// ─── Installation name ───
test('the objects are named after the app name, and renamed by stored id with members and resources kept', async () => {
    reset({ policies: [{ id: 'pol-gw', name: 'Browser Gateway', rules: [] }, { id: 'pol-ngw', name: 'Browser Gateway (Names)', rules: [] }] });
    state.groups[0].name = 'Browser Gateway';
    state.groups[1].name = 'Browser Gateway Targets';
    settings.app_name = '  NetBird  Control\nDEV (שלוחה) ';
    await ra._internal.applyGatewayObjects();
    const label = 'NetBird Control DEV (שלוחה)';
    assert.equal(ra._internal.installNameForTest(), label);
    assert.equal(groupOf('g-gw').name, `Browser Gateway (${label})`);
    assert.deepEqual(peerIds('g-gw'), ['p-gw'], 'the gateway stays in its group');
    assert.equal(groupOf('g-gwt').name, `Browser Gateway Targets (${label})`);
    assert.deepEqual(groupOf('g-gwt').resources, [{ id: 'r1', type: 'host' }]);
    assert.equal(groupOf('g-ngwt').name, `Browser Gateway Name Targets (${label})`);
    const pols = writes('PUT', /^\/api\/policies\//).map(c => c[2].name).sort();
    assert.deepEqual(pols, [`Browser Gateway (${label})`, `Browser Gateway Names (${label})`]);
    assert.match(writes('PUT', /^\/api\/policies\/pol-gw$/)[0][2].description, /Installation: NetBird Control DEV/);
    await ra.createGatewaySetupKey('names');
    assert.equal(setupKeys[0].name, `Browser Gateway Names (${label})`);
});

test('an app name that makes a name too long stops the save before any write', async () => {
    reset();
    settings.app_name = 'x'.repeat(80);
    await assert.rejects(ra._internal.applyGatewayObjects(), /too long for the NetBird object names/);
    assert.equal(writes('PUT', /./).length + writes('POST', /./).length, 0);
});

test('renaming onto a name another group already has stops the save', async () => {
    reset();
    settings.app_name = 'Prod';
    state.groups.push({ id: 'g-stranger', name: 'Browser Gateway (Prod)', peers: [], resources: [] });
    await assert.rejects(ra._internal.applyGatewayObjects(), /already has a group named "Browser Gateway \(Prod\)"/);
    assert.equal(groupOf('g-gw').name, 'Browser Gateway (NetBird Control)');
});

test('the names of every installation are recognized, and nothing else', () => {
    ra._internal.setManagedForTest({});
    const yes = ['Browser Gateway', 'Browser Gateway Targets', 'Browser Gateway Names', 'Browser Gateway Name Targets',
        'Browser Gateway (Prod)', 'Browser Gateway Targets (x)', 'Browser Gateway Names (a\nb)', 'Browser Gateway (a (b) c)', 'Browser Gateway (שלוחה)'];
    const no = ['Browser Gateways', 'Browser Gateway ()', 'Browser Gateway (x', 'My Browser Gateway', 'Browser Gateway Targets x', ''];
    for (const n of yes) assert.equal(ra.isRemoteAccessManagedGroup('g-x', n), true, n);
    for (const n of no) assert.equal(ra.isRemoteAccessManagedGroup('g-x', n), false, n);
    for (const n of ['Browser Gateway', 'Browser Gateway (Names)', 'Browser Gateway Names (Prod)', 'Browser Gateway (Prod)']) {
        assert.equal(ra.isRemoteAccessManagedPolicy({ id: 'p-x', name: n }), true, n);
    }
    assert.equal(ra.isRemoteAccessManagedPolicy({ id: 'p-x', name: 'Browser Gateway Targets (Prod)' }), false);
});

test("another installation's gateway policy never grants a session, and a drop rule under that name still denies", () => {
    const snap = {
        users: [{ id: 'u1', auto_groups: ['g-staff'], is_blocked: false }],
        peers: [{ id: 'p-gw', name: 'gw', groups: [{ id: 'g-gw' }], connected: true }],
        groups: [{ id: 'g-gw', name: 'Browser Gateway (Prod)' }, { id: 'g-gwt', name: 'Browser Gateway Targets (Prod)' }, { id: 'g-staff', name: 'Staff' }, { id: 'g-srv', name: 'Servers' }],
        networks: [{ id: 'n1', name: 'Office', resources: ['r1'] }],
        resources: [{ id: 'r1', name: 'srv', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-srv' }, { id: 'g-gwt' }] }],
        policies: [
            { id: 'pol-gw', name: 'Browser Gateway (Prod)', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
            { id: 'pol-dev', name: 'Browser Gateway (DEV)', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] },
        ],
        routes: [], grants: [],
    };
    const cfg = { networks: ['n1'], gatewayGroupId: 'g-gw', managedPolicyIds: ['pol-gw'] };
    const ask = () => evaluateUserAccess(snap, cfg, { userId: 'u1', address: '10.0.0.5', port: 3389 });
    assert.equal(ask().code, 'NO_ACCESS', "another installation's accept rule grants nothing");
    snap.policies.push({ id: 'pol-staff', name: 'Staff RDP', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] });
    assert.equal(ask().ok, true, 'an ordinary policy still grants');
    snap.policies.push({ id: 'pol-block', name: 'Browser Gateway (Contractors)', enabled: true, rules: [{ enabled: true, action: 'drop', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] });
    assert.equal(ask().code, 'BLOCKED_BY_POLICY', 'a drop rule under a managed-looking name still denies');
});
