const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] ?? null;
core.setSetting = async (k, v) => { settings[k] = String(v); };
core.pool.query = async (sql, params) => {
    if (/INSERT INTO app_settings/.test(sql)) { if (!(params[0] in settings)) settings[params[0]] = params[1]; return { rows: [], rowCount: 1 }; }
    if (/DELETE FROM app_settings/.test(sql)) { if (settings[params[0]] === params[1]) delete settings[params[0]]; return { rows: [], rowCount: 1 }; }
    if (/UPDATE app_settings/.test(sql)) { if (settings[params[0]] === params[1]) settings[params[0]] = params[2]; return { rows: [], rowCount: 1 }; }
    return { rows: [] };
};

const lockQueries = [];
let onLock = null;
core.pool.connect = async () => ({
    query: async (sql, params) => {
        lockQueries.push([sql.replace(/\s+/g, ' ').trim(), params]);
        if (/pg_advisory_xact_lock/.test(sql) && onLock) onLock();
        return { rows: [] };
    },
    release: () => { },
});

const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
let state;
let calls;
let seq = 0;
const listOf = (p) => ({ '/api/groups': 'groups', '/api/policies': 'policies', '/api/routes': 'routes', '/api/setup-keys': 'setupKeys' }[p]);
let failSetupKeyPut = false;
let onSetupKeyPut = null;
nb.netbirdGet = async (p) => {
    if (listOf(p)) return clone(state[listOf(p)]);
    const g = /^\/api\/groups\/(.+)$/.exec(p);
    if (g) { const x = state.groups.find(y => y.id === decodeURIComponent(g[1])); return x ? clone({ resources: [], ...x }) : null; }
    if (p === '/api/networks/resources' || p === '/api/networks') return [];
    return [];
};
nb.netbirdPost = async (p, body) => {
    calls.push(['POST', p, clone(body)]);
    const id = `new-${++seq}`;
    const key = listOf(p);
    if (key) state[key].push({ id, ...clone(body), ...(key === 'groups' ? { peers: [] } : {}) });
    return { status: 200, body: { id } };
};
nb.netbirdReq = async (method, p, body) => {
    calls.push([method, p, clone(body)]);
    const m = /^\/api\/(groups|policies|routes|setup-keys)\/(.+)$/.exec(p);
    if (!m) return { status: 404 };
    if (m[1] === 'setup-keys' && failSetupKeyPut) return { status: 500, raw: 'NetBird refused' };
    if (m[1] === 'setup-keys' && onSetupKeyPut) onSetupKeyPut();
    const list = state[m[1] === 'setup-keys' ? 'setupKeys' : m[1]];
    const i = list.findIndex(x => x.id === decodeURIComponent(m[2]));
    if (method === 'DELETE') { if (i >= 0) list.splice(i, 1); return { status: i >= 0 ? 200 : 404 }; }
    if (method === 'PUT' && i >= 0) {
        const next = { ...list[i], ...clone(body) };
        if (m[1] === 'groups') next.peers = (body.peers || []).map(id => ({ id }));
        list[i] = next;
        return { status: 200, body: next };
    }
    return { status: 404 };
};

const ra = require('../lib/remote-access');
const keys = [];
const audits = [];
ra.setRemoteAccessDeps({
    createSetupKey: async (k) => { keys.push(k); return { key: 'not-a-real-key', name: k.name }; },
    recordAudit: async (a) => { audits.push(a); },
});

const IP_MANAGED = { gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' };
const NETWORK_ID = 'nbc-browser-' + crypto.createHash('sha256').update('NetBird Control').digest('hex').slice(0, 8);

function reset({ browser = { enabled: true, routerGroupId: 'g-office' }, managed = IP_MANAGED } = {}) {
    calls = [];
    keys.length = 0;
    audits.length = 0;
    for (const k of Object.keys(settings)) delete settings[k];
    ra._internal.setConfigForTest({ enabled: true, networks: [], browser });
    ra._internal.setManagedForTest(managed);
    ra._internal.resetSettlingForTest();
    ra._internal.resetMembershipForTest();
    state = {
        groups: [
            { id: 'g-all', name: 'All', peers: [] },
            { id: 'g-gw', name: 'Browser Gateway (NetBird Control)', peers: [] }, { id: 'g-gwt', name: 'Browser Gateway Targets (NetBird Control)', peers: [] },
            { id: 'g-ngw', name: 'Browser Gateway Names (NetBird Control)', peers: [] }, { id: 'g-ngwt', name: 'Browser Gateway Name Targets (NetBird Control)', peers: [] },
            { id: 'g-office', name: 'Office Peers', peers: [{ id: 'router' }] },
            { id: 'g-other', name: 'Other Routers', peers: [] },
        ],
        policies: [{ id: 'pol-gw', name: 'Browser Gateway (NetBird Control)' }, { id: 'pol-ngw', name: 'Browser Gateway Names (NetBird Control)' }],
        routes: [],
        setupKeys: [],
    };
    failSetupKeyPut = false;
    onSetupKeyPut = null;
    onLock = null;
    lockQueries.length = 0;
}
const stored = () => JSON.parse(settings.remote_access_nb);

test('turning web sessions on creates the two groups, both policies and the route, exactly as specified, and records every id', async () => {
    reset();
    await ra._internal.applyGatewayObjects();
    const nbIds = stored();
    const group = (name) => state.groups.find(g => g.name === name);
    assert.equal(nbIds.webGroupId, group('Browser Gateway Web (NetBird Control)').id);
    assert.equal(nbIds.webAclGroupId, group('Browser Gateway Web ACL (NetBird Control)').id);
    const route = state.routes.find(r => r.id === nbIds.webRouteId);
    assert.deepEqual({ ...route, id: undefined }, {
        id: undefined, description: 'Browser Gateway Web (NetBird Control)', network_id: NETWORK_ID, enabled: true, network: '0.0.0.0/0',
        peer_groups: ['g-office'], groups: [nbIds.webGroupId], access_control_groups: [nbIds.webAclGroupId],
        metric: 9999, masquerade: true, keep_route: false, skip_auto_apply: false,
    });
    const icmp = state.policies.find(p => p.id === nbIds.webPolicyId);
    assert.equal(icmp.name, 'Browser Gateway Web (NetBird Control)');
    assert.deepEqual(icmp.rules.map(r => [r.action, r.bidirectional, r.protocol, r.sources, r.destinations]), [['accept', false, 'icmp', [nbIds.webGroupId], ['g-office']]]);
    const routing = state.policies.find(p => p.id === nbIds.webRoutingPolicyId);
    assert.equal(routing.name, 'Browser Gateway Web Routing (NetBird Control)');
    assert.deepEqual(routing.rules.map(r => [r.action, r.bidirectional, r.protocol, r.sources, r.destinations]), [['accept', false, 'all', [nbIds.webGroupId], [nbIds.webAclGroupId]]]);
    assert.equal(ra.isRemoteAccessManagedGroup(nbIds.webGroupId, ''), true);
    assert.equal(ra.isRemoteAccessManagedGroup(nbIds.webAclGroupId, ''), true);
    assert.equal(ra.isRemoteAccessManagedPolicy({ id: nbIds.webPolicyId, name: 'x' }), true);
    assert.equal(ra.isRemoteAccessManagedPolicy({ id: nbIds.webRoutingPolicyId, name: 'x' }), true);
    const managed = ra.getRemoteAccessConfig().managed;
    assert.equal(managed.webGroupId, nbIds.webGroupId);
    assert.equal(managed.webAclGroupId, nbIds.webAclGroupId);

    calls = [];
    await ra._internal.applyGatewayObjects();
    assert.deepEqual(calls.filter(([m, p]) => m !== 'GET' && (/\/api\/routes/.test(p) || [nbIds.webPolicyId, nbIds.webRoutingPolicyId].some(id => p.endsWith(id)))), [], 'a reconcile writes the web objects only on a difference');
    state.routes[0].masquerade = false;
    await ra._internal.applyGatewayObjects();
    assert.equal(state.routes[0].masquerade, true, 'a changed route is repaired');
});

test('a NetBird object that merely has a web name is never taken over', async () => {
    reset();
    state.groups.push({ id: 'g-stranger', name: 'Browser Gateway Web (NetBird Control)', peers: [] });
    await assert.rejects(ra._internal.applyGatewayObjects(), /already has a group named "Browser Gateway Web \(NetBird Control\)"/);
    reset();
    state.routes.push({ id: 'rt-stranger', network_id: NETWORK_ID, description: 'something' });
    await assert.rejects(ra._internal.applyGatewayObjects(), /already has a route/);
    assert.equal(stored().webRouteId, '');
    reset();
    state.policies.push({ id: 'pol-stranger', name: 'Browser Gateway Web Routing (NetBird Control)' });
    await assert.rejects(ra._internal.applyGatewayObjects(), /already has a policy named "Browser Gateway Web Routing/);
});

test('another routing group replaces the route and the ICMP policy; turning off removes route and policies first and keeps the groups', async () => {
    reset();
    await ra._internal.applyGatewayObjects();
    const before = stored();
    ra._internal.setConfigForTest({ enabled: true, networks: [], browser: { enabled: true, routerGroupId: 'g-other' } });
    calls = [];
    await ra._internal.applyGatewayObjects();
    const after = stored();
    assert.notEqual(after.webRouteId, before.webRouteId);
    assert.notEqual(after.webPolicyId, before.webPolicyId);
    assert.equal(after.webRoutingPolicyId, before.webRoutingPolicyId);
    const order = calls.filter(([m]) => m === 'DELETE' || m === 'POST').map(([m, p]) => `${m} ${p.replace(/\/[^/]+$/, '')}`);
    assert.deepEqual(order.slice(0, 2), ['DELETE /api/routes', 'DELETE /api/policies']);
    assert.deepEqual(state.routes.map(r => r.peer_groups), [['g-other']]);

    ra._internal.setConfigForTest({ enabled: true, networks: [], browser: { enabled: false, routerGroupId: 'g-other' } });
    calls = [];
    await ra._internal.applyGatewayObjects();
    const deletes = calls.filter(([m]) => m === 'DELETE').map(([, p]) => p);
    assert.deepEqual(deletes, [`/api/routes/${after.webRouteId}`, `/api/policies/${after.webPolicyId}`, `/api/policies/${after.webRoutingPolicyId}`]);
    const off = stored();
    assert.equal(off.webRouteId, '');
    assert.equal(off.webPolicyId, '');
    assert.equal(off.webRoutingPolicyId, '');
    assert.equal(off.webGroupId, after.webGroupId);
    assert.ok(state.groups.some(g => g.id === off.webGroupId));
});

test('a managed group can never route web sessions', async () => {
    reset({ browser: { enabled: true, routerGroupId: 'g-gw' } });
    await assert.rejects(ra._internal.applyGatewayObjects(), /cannot route web sessions/);
    assert.equal(state.routes.length, 0);
});

test('the web setup key enrolls into the web group only; an unknown kind never falls back to the IP gateway', async () => {
    reset();
    await ra._internal.applyGatewayObjects();
    await ra.createGatewaySetupKey('web');
    assert.deepEqual(keys[0].autoGroups, [stored().webGroupId]);
    assert.equal(keys[0].name, 'Browser Gateway Web (NetBird Control)');
    assert.equal(keys[0].usageLimit, 1);
    await assert.rejects(ra.createGatewaySetupKey('webx'), /Unknown gateway kind/);
    reset({ browser: { enabled: false, routerGroupId: '' } });
    await assert.rejects(ra.createGatewaySetupKey('web'), /Turn on Remote Access and web sessions first/);
    assert.equal(keys.length, 0);
});

test('the web group keeps exactly the first enrolled peer; other members and every ACL member are removed', async () => {
    reset({ managed: { ...IP_MANAGED, webGroupId: 'g-web', webAclGroupId: 'g-acl' } });
    state.groups.push({ id: 'g-web', name: 'Browser Gateway Web (NetBird Control)', peers: [{ id: 'gw-1' }] }, { id: 'g-acl', name: 'Browser Gateway Web ACL (NetBird Control)', peers: [] });
    const users = [{ id: 'u1', auto_groups: [] }];
    let peers = [{ id: 'gw-1', name: 'web', user_id: '', ip: '100.92.0.7', groups: [{ id: 'g-web' }] }];
    await ra.enforceManagedMembership({ users, peers });
    await ra._internal.membershipIdleForTest();
    assert.deepEqual(await ra.readWebPeer().then(p => [p.id, p.ip]), ['gw-1', '100.92.0.7']);

    state.groups.find(g => g.id === 'g-web').peers.push({ id: 'gw-2' }, { id: 'laptop' });
    state.groups.find(g => g.id === 'g-acl').peers.push({ id: 'laptop' });
    peers = [...peers,
        { id: 'gw-2', name: 'second', user_id: '', groups: [{ id: 'g-web' }] },
        { id: 'laptop', name: 'laptop', user_id: 'u1', groups: [{ id: 'g-web' }, { id: 'g-acl' }] }];
    await ra.enforceManagedMembership({ users, peers });
    await ra._internal.membershipIdleForTest();
    assert.deepEqual(state.groups.find(g => g.id === 'g-web').peers.map(p => p.id), ['gw-1']);
    assert.deepEqual(state.groups.find(g => g.id === 'g-acl').peers.map(p => p.id), []);
    assert.ok(audits.some(a => a.action === 'remote_access.member_remove' && a.target === 'second'));

    peers = [{ id: 'gw-3', name: 'new gateway', user_id: '', ip: '100.92.0.9', groups: [{ id: 'g-web' }] }];
    state.groups.find(g => g.id === 'g-web').peers = [{ id: 'gw-3' }];
    await ra.enforceManagedMembership({ users, peers });
    await ra._internal.membershipIdleForTest();
    assert.equal((await ra.readWebPeer()).id, 'gw-3', 'a deleted gateway peer can be enrolled again');
});

test('the browser settings are normalized, clamped and merged', async () => {
    const norm = ra._internal.normConfig;
    assert.deepEqual(norm({}).browser, { enabled: false, routerGroupId: '', maxSessions: 5, keepAliveMin: 15 });
    assert.deepEqual(norm({ browser: { enabled: 1, routerGroupId: 'bad id!', maxSessions: 99, keepAliveMin: 0 } }).browser, { enabled: true, routerGroupId: '', maxSessions: 50, keepAliveMin: 1 });
    assert.equal('browserGuacdHost' in norm({ browserGuacdHost: '10.0.0.1' }), false);
    assert.equal('browserGuacdPort' in norm({ browserGuacdPort: 1 }), false);
    reset({ browser: { enabled: false, routerGroupId: 'g-office', maxSessions: 7, keepAliveMin: 30 } });
    ra._internal.setConfigForTest({ enabled: false, browser: { enabled: false, routerGroupId: 'g-office', maxSessions: 7, keepAliveMin: 30 } });
    const out = await ra.setRemoteAccessConfig({ browser: { keepAliveMin: 20 } });
    assert.deepEqual(out.config.browser, { enabled: false, routerGroupId: 'g-office', maxSessions: 7, keepAliveMin: 20 });
});

test('a new web setup key needs an empty web group, and revokes every still-valid key for that group first', async () => {
    reset();
    await ra._internal.applyGatewayObjects();
    const webGroupId = stored().webGroupId;
    const name = 'Browser Gateway Web (NetBird Control)';
    state.setupKeys.push(
        { id: 'k-open', name, valid: true, revoked: false, state: 'valid', auto_groups: [webGroupId] },
        { id: 'k-used', name, valid: false, revoked: false, state: 'overused', auto_groups: [webGroupId] },
        { id: 'k-renamed', name: 'Browser Gateway Web (Old Name)', valid: true, revoked: false, state: 'valid', auto_groups: [webGroupId] },
        { id: 'k-ip', name: 'Browser Gateway (NetBird Control)', valid: true, revoked: false, state: 'valid', auto_groups: ['g-gw'] });
    state.groups.find(g => g.id === webGroupId).peers = [{ id: 'old-gateway' }];
    await assert.rejects(ra.createGatewaySetupKey('web'), /already has a peer\. Delete the old browser gateway peer in NetBird first/);
    assert.equal(keys.length, 0);
    state.groups.find(g => g.id === webGroupId).peers = [];
    failSetupKeyPut = true;
    await assert.rejects(ra.createGatewaySetupKey('web'), /Revoking the earlier/);
    assert.equal(keys.length, 0, 'no new key while an earlier one may still enroll a second peer');
    failSetupKeyPut = false;
    await ra.createGatewaySetupKey('web');
    assert.equal(keys.length, 1);
    const puts = calls.filter(c => c[0] === 'PUT' && c[1].startsWith('/api/setup-keys/'));
    assert.deepEqual(puts.slice(-2).map(c => c.slice(1)), [
        ['/api/setup-keys/k-open', { revoked: true, auto_groups: [webGroupId] }],
        ['/api/setup-keys/k-renamed', { revoked: true, auto_groups: [webGroupId] }],
    ], 'a key from before an Application Name change is revoked too');
    assert.ok(puts.every(c => c[1] !== '/api/setup-keys/k-used' && c[1] !== '/api/setup-keys/k-ip'));
    state.groups = state.groups.filter(g => g.id !== webGroupId);
    await assert.rejects(ra.createGatewaySetupKey('web'), /Couldn't read the "Browser Gateway Web \(NetBird Control\)" group/);
    assert.equal(keys.length, 1);
});

test('web key issuance runs under one advisory lock and checks the group again after revoking the earlier keys', async () => {
    reset();
    await ra._internal.applyGatewayObjects();
    const webGroupId = stored().webGroupId;
    state.setupKeys.push({ id: 'k-open', name: 'Browser Gateway Web (NetBird Control)', valid: true, revoked: false, state: 'valid', auto_groups: [webGroupId] });
    onSetupKeyPut = () => { state.groups.find(g => g.id === webGroupId).peers = [{ id: 'enrolled-meanwhile' }]; };
    await assert.rejects(ra.createGatewaySetupKey('web'), /already has a peer/);
    assert.equal(keys.length, 0, 'a peer that enrolled with the old key before it was revoked stops the new key');
    assert.deepEqual(lockQueries.map(q => q[0]), ['BEGIN', 'SELECT pg_advisory_xact_lock($1)', 'ROLLBACK']);
    state.groups.find(g => g.id === webGroupId).peers = [];
    onSetupKeyPut = null;
    lockQueries.length = 0;
    await ra.createGatewaySetupKey('web');
    assert.equal(keys.length, 1);
    assert.deepEqual(lockQueries.map(q => q[0]), ['BEGIN', 'SELECT pg_advisory_xact_lock($1)', 'COMMIT']);
    lockQueries.length = 0;
    await ra.createGatewaySetupKey('ip');
    assert.deepEqual(lockQueries, [], 'other gateways need no lock');
});

test('web key issuance reads the web group id once, after the lock, and uses that id for every step', async () => {
    reset();
    await ra._internal.applyGatewayObjects();
    const earlier = stored().webGroupId;
    state.groups.find(g => g.id === earlier).peers = [{ id: 'old-gateway' }];
    state.groups.push({ id: 'g-web-saved', name: 'Browser Gateway Web (NetBird Control)', peers: [] });
    state.setupKeys.push(
        { id: 'k-saved', name: 'Browser Gateway Web (NetBird Control)', valid: true, revoked: false, state: 'valid', auto_groups: ['g-web-saved'] },
        { id: 'k-earlier', name: 'Browser Gateway Web (NetBird Control)', valid: true, revoked: false, state: 'valid', auto_groups: [earlier] });
    onLock = () => { settings.remote_access_nb = JSON.stringify({ ...stored(), webGroupId: 'g-web-saved' }); };
    await ra.createGatewaySetupKey('web');
    assert.deepEqual(keys.map(k => k.autoGroups), [['g-web-saved']]);
    assert.deepEqual(calls.filter(c => c[0] === 'PUT' && c[1].startsWith('/api/setup-keys/')).map(c => c[1]), ['/api/setup-keys/k-saved']);
});
