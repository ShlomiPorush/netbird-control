// The routes behind "Add As Resource" and the service status line, on the real server.js stack
// with SSO on (test/helpers/sso-server.js):
//   - GET /api/remote-access/add-networks: the networks open to Remote Access that the user may
//     edit, ids and names only;
//   - GET /api/remote-access/health: refused to a user blocked in NetBird, also with allowAll on;
//   - POST /api/networks/:id/resources: the partly-known outcomes answer with their codes, and a
//     resource whose policies failed is audited as created, with policiesSaved: false.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ssoServer } = require('./helpers/sso-server');

const h = ssoServer();
const USERS = {
    plain: {},
    editor: { groups: ['g-edit'] },
    remote: { perms: ['remote.connect'] },
    blocked: { blocked: true, perms: ['remote.connect'] },
    admin: { role: 'admin' },
};
const GRANTS = {
    'net-1': [{ id: 'g-edit', access: 'edit' }],
    'net-2': [{ id: 'g-edit', access: 'edit' }],
    'net-3': [],
};
const audits = [];
let createImpl = null;
let createCalls = 0;
let healthCalls = 0;
let ra;

before(async () => {
    await h.start({
        beforeRequire(db) {
            Object.assign(db, {
                ensureUsersFresh: async () => { },
                ensurePeersFresh: async () => { },
                resolveViewer: async (oid) => (USERS[oid] ? {
                    user_id: oid, role: USERS[oid].role || 'user', name: oid, email: `${oid}@example.com`,
                    auto_groups: USERS[oid].groups || [], blocked: !!USERS[oid].blocked,
                } : null),
                fetchUserGroups: async () => [],
                getUserPeerGroupIds: async () => [],
                getApproverGroupIds: () => [],
                isActiveDelegate: async () => false,
                resolveFeaturePerms: ({ isAdmin, userId } = {}) => (isAdmin
                    ? { 'networks.manage': true, 'remote.connect': true }
                    : Object.fromEntries(((USERS[userId] && USERS[userId].perms) || []).map((p) => [p, true]))),
                getAllGrants: async () => GRANTS,
                getNetworks: async () => [{ id: 'net-1', name: 'Office' }, { id: 'net-2', name: 'Lab' }, { id: 'net-3', name: 'Other' }],
                getBlocklist: async () => [],
                recordAudit: async (e) => { audits.push(e); },
                createClientResource: async (...args) => { createCalls++; return createImpl(...args); },
            });
            ra = require('../lib/remote-access');
            ra.getServiceHealth = async () => { healthCalls++; return { netbird: 'up', gateway: 'down' }; };
        },
    });
});
after(() => h.stop());

const remoteConfig = (over = {}) => ra._internal.setConfigForTest({ enabled: true, allowAll: false, networks: ['net-1', 'net-3'], ...over });

test('add-networks: the open networks the user may edit, ids and names only', async () => {
    remoteConfig({ allowAll: true });
    let r = await h.call('editor', 'GET', '/api/remote-access/add-networks');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { networks: [{ id: 'net-1', name: 'Office' }] }, 'net-2 is not open to Remote Access, net-3 not editable');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    r = await h.call('admin', 'GET', '/api/remote-access/add-networks');
    assert.deepEqual(r.json, { networks: [{ id: 'net-1', name: 'Office' }, { id: 'net-3', name: 'Other' }] });
    r = await h.call('plain', 'GET', '/api/remote-access/add-networks');
    assert.deepEqual(r.json, { networks: [] }, 'allowed to connect, but edits nothing');
    remoteConfig({ allowAll: true, networks: [] });
    r = await h.call('admin', 'GET', '/api/remote-access/add-networks');
    assert.deepEqual(r.json, { networks: [] }, 'no network open to Remote Access');
});

test('add-networks and health need Remote Access permission', async () => {
    remoteConfig();
    for (const path of ['/api/remote-access/add-networks', '/api/remote-access/health']) {
        const r = await h.call('plain', 'GET', path);
        assert.equal(r.status, 403, path);
        assert.equal(r.json.code, 'FORBIDDEN', path);
    }
    assert.equal((await h.call('remote', 'GET', '/api/remote-access/add-networks')).status, 200);
});

test('health: the probe answer as is, and refused to a user blocked in NetBird even with allowAll', async () => {
    remoteConfig({ allowAll: true });
    const before = healthCalls;
    let r = await h.call('remote', 'GET', '/api/remote-access/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { netbird: 'up', gateway: 'down' });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    r = await h.call('blocked', 'GET', '/api/remote-access/health');
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'USER_BLOCKED');
    assert.equal(healthCalls, before + 1, 'the blocked user never reached the probe');
});

const body = { name: 'srv', address: '192.0.2.9', description: '', groups: [], policies: [{ sources: ['g-ops'], protocol: 'tcp', ports: ['3389'] }] };
const lastAudit = () => audits[audits.length - 1];

test('create: a resource whose access policies failed answers its code and id, and is audited as created', async () => {
    audits.length = 0;
    createImpl = async () => { throw Object.assign(new Error("The resource was added, but its access rules weren't all saved. Open the network to finish them."), { code: 'RESOURCE_CREATED_POLICY_FAILED', status: 502, resource: { id: 'res-9' }, cause: 'refused' }); };
    const r = await h.call('admin', 'POST', '/api/networks/net-1/resources', body);
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'RESOURCE_CREATED_POLICY_FAILED');
    assert.deepEqual(r.json.resource, { id: 'res-9' });
    const a = lastAudit();
    assert.equal(a.action, 'resource.create');
    assert.equal(a.target, 'srv');
    assert.equal(a.meta.resourceId, 'res-9');
    assert.equal(a.meta.account, 'main');
    assert.equal(a.meta.policiesSaved, false);
});

test('create: an unconfirmed resource answers RESOURCE_UNCONFIRMED; a success carries the id in its audit', async () => {
    audits.length = 0;
    createImpl = async () => { throw Object.assign(new Error("NetBird didn't confirm the resource was saved. Check the network before you try again."), { code: 'RESOURCE_UNCONFIRMED', status: 502, cause: 'timeout' }); };
    let r = await h.call('admin', 'POST', '/api/networks/net-1/resources', body);
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'RESOURCE_UNCONFIRMED');
    assert.equal(lastAudit().meta.confirmed, false);
    createImpl = async () => ({ resource: { id: 'res-10', name: 'srv' } });
    r = await h.call('admin', 'POST', '/api/networks/net-1/resources', body);
    assert.equal(r.status, 200);
    assert.equal(r.json.resource.id, 'res-10');
    assert.equal(lastAudit().meta.resourceId, 'res-10');
});

test('create: still the ordinary permission check (no network edit, no create)', async () => {
    const before = createCalls;
    const r = await h.call('remote', 'POST', '/api/networks/net-1/resources', body);
    assert.equal(r.status, 403);
    assert.equal(createCalls, before);
});
