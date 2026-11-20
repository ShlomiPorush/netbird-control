// "Add As Resource" on the Remote Access check, and the service status line of the connect page.
//   - The failed access step offers to add the target (addable + suggest) only when the inventory
//     was read and nothing in NetBird covers the target: no resource in any network, and no enabled
//     legacy route (a default route such as an exit node doesn't count; a domain route counts for a
//     name it lists). Names: every IPv4 address the DNS returned is uncovered, or the DNS says the
//     name doesn't exist while the names gateway is set up. A temporary DNS failure never offers.
//   - The status probe answers { netbird, gateway, namesGateway? } and nothing else, from an active
//     read-only probe; one at a time, kept 15 s, and a settings change discards a running probe.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

// ─── Stubs, before lib/remote-access.js destructures them ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] || null;
let settingHold = null; // a settings save waits on this while it is set
core.setSetting = async (k, v) => { if (settingHold) await settingHold; settings[k] = v; };
core.pool.query = async () => ({ rows: [] });
const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
let live = null; // the snapshot answers, by path (null: every read fails)
nb.netbirdGet = async (p) => JSON.parse(JSON.stringify((live && live[p]) ?? null));
nb.netbirdReq = async () => ({ status: 200, body: {} });
// The strict inventory read that confirms an offer: from the same answers, or failing.
let inventoryFails = false;
let inventory = null; // a test's own answer to the strict read
nb.getUsageData = async ({ strict } = {}) => {
    if (!strict) throw new Error('only the strict read is used here');
    if (inventoryFails || !live) throw new Error("Couldn't read the resources and routes from NetBird");
    if (inventory) return JSON.parse(JSON.stringify(inventory));
    return { resources: JSON.parse(JSON.stringify(live['/api/networks/resources'] || [])), routes: JSON.parse(JSON.stringify(live['/api/routes'] || [])) };
};
const events = require('../lib/events');
events.addEvent = async () => { };

const ra = require('../lib/remote-access');
const { resolveTarget } = ra._internal;
const { ipUncovered, nameUncovered } = require('../lib/coverage');

function base() {
    return {
        users: [{ id: 'u1', auto_groups: ['g-staff'], is_blocked: false }],
        peers: [
            { id: 'p-gw', name: 'gw', groups: [{ id: 'g-gw' }, { id: 'g-all' }], connected: true },
            { id: 'p-ngw', name: 'ngw', groups: [{ id: 'g-ngw' }, { id: 'g-all' }], connected: true },
            { id: 'p-r1', name: 'router', groups: [{ id: 'g-all' }], connected: true },
        ],
        groups: [
            { id: 'g-all', name: 'All' }, { id: 'g-gw', name: 'Browser Gateway' }, { id: 'g-gwt', name: 'Browser Gateway Targets' },
            { id: 'g-ngw', name: 'Browser Gateway Names' }, { id: 'g-ngwt', name: 'Browser Gateway Name Targets' },
            { id: 'g-staff', name: 'Staff' }, { id: 'g-srv', name: 'Servers' }, { id: 'g-empty', name: 'Empty' },
        ],
        networks: [{ id: 'n1', name: 'Office', resources: ['r-wide', 'r-dom', 'r-wild'] }, { id: 'n2', name: 'Closed', resources: ['r-narrow'] }],
        resources: [
            { id: 'r-wide', name: 'office', type: 'subnet', address: '10.20.0.0/16', enabled: true, groups: [{ id: 'g-gwt' }, { id: 'g-srv' }] },
            { id: 'r-dom', name: 'Safe', type: 'domain', address: 'safe.example.com', enabled: true, groups: [{ id: 'g-ngwt' }, { id: 'g-srv' }] },
            { id: 'r-wild', name: 'Corp', type: 'domain', address: '*.corp.example', enabled: true, groups: [{ id: 'g-ngwt' }] },
            { id: 'r-narrow', name: 'other', type: 'host', address: '192.0.2.7/32', enabled: true, groups: [] },
        ],
        policies: [
            { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
            { id: 'pol-ngw', name: 'Browser Gateway (Names)', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-ngw' }], destinations: [{ id: 'g-ngwt' }] }] },
            { id: 'pol-staff', name: 'Staff', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: [], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] },
        ],
        routes: [],
        grants: [],
    };
}
const MANAGED = ['pol-gw', 'pol-ngw'];
const IP = { networks: ['n1'], gatewayGroupId: 'g-gw', gatewayGroupIds: ['g-gw', 'g-ngw'], managedPolicyIds: MANAGED };
const NAMES = { networks: ['n1'], gatewayGroupId: 'g-ngw', gatewayGroupIds: ['g-gw', 'g-ngw'], managedPolicyIds: MANAGED };
const NO_NAMES = { ...NAMES, gatewayGroupId: 'g-empty' }; // a names group without a gateway peer
const dnsError = (code) => async () => { throw Object.assign(new Error(code), { code }); };
const resolve = (snap, address, { resolve4 = dnsError('ENOTFOUND'), namesCfg = NAMES, ipCfg = IP } = {}) =>
    resolveTarget(snap, 'u1', address, 3389, { ipCfg, namesCfg, resolve4 });

// ─── The "not covered" rule ───
test('an IP address no resource and no enabled legacy route covers is offered, with the address', async () => {
    const r = await resolve(base(), '192.0.2.50');
    assert.equal(r.verdict.code, 'UNKNOWN_ADDRESS');
    assert.deepEqual(r.add, { suggest: '192.0.2.50' });
});

test('a legacy route covers an address; a disabled route or a default route (exit node) does not', async () => {
    let s = base();
    s.routes = [{ id: 'l1', network: '192.0.2.0/24', enabled: true, groups: [] }];
    assert.equal((await resolve(s, '192.0.2.50')).add, undefined, 'an enabled /24 route covers it');
    s.routes[0].enabled = false;
    assert.deepEqual((await resolve(s, '192.0.2.50')).add, { suggest: '192.0.2.50' }, 'a disabled route carries nothing');
    s = base();
    s.routes = [{ id: 'exit', network: '0.0.0.0/0', enabled: true, groups: [] }];
    assert.deepEqual((await resolve(s, '192.0.2.50')).add, { suggest: '192.0.2.50' }, 'an exit node carries everything, so it covers nothing in particular');
});

test('an address a resource covers anywhere is never offered, nor one that is never a target', async () => {
    const closed = await resolve(base(), '192.0.2.7');
    assert.equal(closed.verdict.code, 'NETWORK_NOT_ENABLED');
    assert.equal(closed.add, undefined);
    const loop = await resolve(base(), '127.0.0.1');
    assert.equal(loop.verdict.code, 'ADDRESS_NOT_ALLOWED');
    assert.equal(loop.add, undefined);
    assert.equal(ipUncovered(base(), '100.64.0.9'), false, 'a NetBird peer address is never offered');
});

test('a read-only instance never offers to add', async () => {
    const r = await resolve(base(), '192.0.2.50', { ipCfg: { ...IP, readonly: true } });
    assert.equal(r.verdict.code, 'UNKNOWN_ADDRESS');
    assert.equal(r.add, undefined);
});

test('a host name: every address uncovered is offered, as the name with the names gateway, else the first address', async () => {
    const both = async () => ['192.0.2.50', '192.0.2.51'];
    let r = await resolve(base(), 'new.example.net', { resolve4: both });
    assert.equal(r.verdict.code, 'UNKNOWN_ADDRESS');
    assert.equal(r.add.suggest, 'new.example.net');
    r = await resolve(base(), 'new.example.net', { resolve4: both, namesCfg: NO_NAMES });
    assert.equal(r.add.suggest, '192.0.2.50');
});

test('a host name with one covered address, a matching domain route, or a wildcard resource is not offered', async () => {
    let r = await resolve(base(), 'mixed.example.net', { resolve4: async () => ['192.0.2.50', '192.0.2.7'] });
    assert.equal(r.add, undefined, 'one address is a resource in a closed network');
    const s = base();
    s.routes = [{ id: 'l2', domains: ['*.example.net'], enabled: true, groups: [] }];
    r = await resolve(s, 'new.example.net', { resolve4: async () => ['192.0.2.50'] });
    assert.equal(r.add, undefined, 'a domain route that lists the name covers it');
    assert.equal(nameUncovered(base(), 'a.corp.example', ['192.0.2.50']), false, 'a wildcard domain resource covers the name');
    r = await resolve(s, 'new.example.net', { resolve4: async () => ['192.0.2.50'], ipCfg: IP, namesCfg: NAMES });
    assert.equal(r.add, undefined);
});

test('a name the DNS does not know is offered only with the names gateway set up; a temporary failure never', async () => {
    let r = await resolve(base(), 'unknown.example.net');
    assert.equal(r.verdict.code, 'NAME_NOT_FOUND');
    assert.equal(r.add.suggest, 'unknown.example.net');
    r = await resolve(base(), 'unknown.example.net', { namesCfg: NO_NAMES });
    assert.equal(r.add, undefined);
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
        r = await resolve(base(), 'unknown.example.net', { resolve4: dnsError(code) });
        assert.equal(r.verdict.code, 'NAME_LOOKUP_FAILED', code);
        assert.equal(r.add, undefined, code);
    }
    const blocked = base();
    blocked.users[0].is_blocked = true;
    assert.equal((await resolve(blocked, 'unknown.example.net')).add, undefined, 'a blocked user is not offered anything');
});

// ─── The check ───
const viewer = { user_id: 'u1', email: 'u1@example.test' };
function liveFrom(s) {
    return {
        '/api/users': s.users, '/api/peers': s.peers, '/api/groups': s.groups, '/api/policies': s.policies,
        '/api/networks/resources': s.resources, '/api/networks': s.networks, '/api/routes': s.routes,
    };
}
function readyCheck() {
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' });
    ra._internal.resetSettlingForTest();
    ra._internal.invalidateSnapshot();
}

test('the check: the failed access step carries addable and the suggested address', async () => {
    readyCheck();
    live = liveFrom(base());
    const r = await ra.checkAccess(viewer, { protocol: 'rdp', address: '192.0.2.50', port: 3389 });
    const access = r.steps.find(st => st.key === 'access');
    assert.equal(access.status, 'fail');
    assert.equal(access.code, 'UNKNOWN_ADDRESS');
    assert.equal(access.addable, true);
    assert.deepEqual(access.suggest, { address: '192.0.2.50' });
    const covered = await ra.checkAccess(viewer, { protocol: 'rdp', address: '192.0.2.7', port: 3389 });
    assert.equal(covered.steps.find(st => st.key === 'access').addable, undefined);
});

test('the check: the offer needs the strict read of the resources and routes to agree', async () => {
    readyCheck();
    live = liveFrom(base());
    inventoryFails = true; // for example a 503 for the resources or the routes
    try {
        const r = await ra.checkAccess(viewer, { protocol: 'rdp', address: '192.0.2.50', port: 3389 });
        const access = r.steps.find(st => st.key === 'access');
        assert.equal(access.code, 'UNKNOWN_ADDRESS');
        assert.equal(access.addable, undefined);
    } finally { inventoryFails = false; }
    // The fresh read shows a route that covers it (the snapshot didn't have it yet).
    readyCheck();
    live = liveFrom(base());
    inventory = { resources: base().resources, routes: [{ id: 'l1', network: '192.0.2.0/24', enabled: true, groups: [] }] };
    try {
        const r = await ra.checkAccess(viewer, { protocol: 'rdp', address: '192.0.2.50', port: 3389 });
        assert.equal(r.steps.find(st => st.key === 'access').addable, undefined);
    } finally { inventory = null; }
});

test('the check: an inventory that could not be read offers nothing', async () => {
    readyCheck();
    live = { ...liveFrom(base()), '/api/routes': null };
    const r = await ra.checkAccess(viewer, { protocol: 'rdp', address: '192.0.2.50', port: 3389 });
    assert.deepEqual(r.steps.map(st => [st.key, st.code]), [['ready', 'SNAPSHOT_FAILED']]);
    assert.equal(r.steps.some(st => st.addable), false);
    live = null;
});

// ─── Service status ───
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const TOKEN_A = crypto.randomBytes(16).toString('hex');
const TOKEN_B = crypto.randomBytes(16).toString('hex');
function fakeNetbird() {
    const st = { status: {}, body: {}, seen: [], hold: null, slow: {} };
    st.server = http.createServer(async (req, res) => {
        st.seen.push({ path: req.url, auth: req.headers.authorization });
        if (st.hold && req.url === '/api/accounts') await st.hold;
        if (st.slow[req.url]) await new Promise((r) => setTimeout(r, st.slow[req.url]));
        res.statusCode = st.status[req.url] || 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(st.body[req.url] ?? {}));
    });
    return st;
}
let guacd, guacdPort, closedPort, nbA, nbB, urlA, urlB;

test('status: set up the fake NetBird and guacd', async () => {
    guacd = net.createServer((s) => s.end());
    guacdPort = await listen(guacd);
    const closed = net.createServer();
    closedPort = await listen(closed);
    await new Promise((r) => closed.close(r));
    nbA = fakeNetbird(); nbB = fakeNetbird();
    urlA = `http://127.0.0.1:${await listen(nbA.server)}`;
    urlB = `http://127.0.0.1:${await listen(nbB.server)}`;
});

function healthSetup({ namesPort = guacdPort, ipPort = guacdPort } = {}) {
    ra._internal.setConfigForTest({ enabled: true, guacdHost: '127.0.0.1', guacdPort: ipPort, namesGuacdHost: '127.0.0.1', namesGuacdPort: namesPort });
    ra._internal.setManagedForTest({ gatewayGroupId: 'g-gw', namesGroupId: 'g-ngw' });
    ra._internal.resetHealthForTest();
    nb._nbApi.url = urlA; nb._nbApi.token = TOKEN_A;
    for (const f of [nbA, nbB]) {
        f.status = {}; f.seen = []; f.hold = null; f.slow = {};
        f.body = {
            '/api/accounts': [{ id: 'acc' }],
            '/api/groups/g-gw': { id: 'g-gw', name: 'Browser Gateway', peers: [{ id: 'p-gw', name: 'gw' }] },
            '/api/groups/g-ngw': { id: 'g-ngw', name: 'Browser Gateway Names', peers: [{ id: 'p-ngw', name: 'ngw' }] },
            '/api/peers/p-gw': { id: 'p-gw', connected: true },
            '/api/peers/p-ngw': { id: 'p-ngw', connected: true },
        };
    }
}

test('status: the answer has the three states and nothing else', async () => {
    healthSetup();
    assert.deepEqual(await ra.getServiceHealth(), { netbird: 'up', gateway: 'up', namesGateway: 'up' });
    assert.ok(nbA.seen.every(s => s.auth === `Token ${TOKEN_A}`));
    // No names gateway peer: the names gateway isn't set up, so it is not in the answer.
    healthSetup();
    nbA.body['/api/groups/g-ngw'] = { id: 'g-ngw', name: 'Browser Gateway Names', peers: null };
    assert.deepEqual(await ra.getServiceHealth(), { netbird: 'up', gateway: 'up' });
});

test('status: NetBird is down on no answer, 5xx, 401 or 403, and unknown on another answer', async () => {
    const cases = { 200: 'up', 401: 'down', 403: 'down', 500: 'down', 503: 'down', 404: 'unknown', 429: 'unknown' };
    for (const [code, want] of Object.entries(cases)) {
        healthSetup();
        nbA.status['/api/accounts'] = Number(code);
        assert.equal((await ra.getServiceHealth()).netbird, want, code);
    }
    healthSetup();
    nb._nbApi.url = `http://127.0.0.1:${closedPort}`;
    const off = await ra.getServiceHealth();
    assert.equal(off.netbird, 'down');
    assert.equal(off.gateway, 'unknown', 'guacd answers, but the gateway peers could not be read');
    assert.equal('namesGateway' in off, false, 'a names gateway no read has shown is not in the answer');
    // The names group was read and has a peer, but the peer couldn't be read: still shown.
    healthSetup({ namesPort: closedPort });
    nbA.status['/api/peers/p-ngw'] = 500;
    assert.equal((await ra.getServiceHealth()).namesGateway, 'down', 'its guacd is closed');
});

test('status: a gateway is down when its peer is offline or guacd is closed, unknown when NetBird could not be read', async () => {
    healthSetup();
    nbA.body['/api/peers/p-gw'] = { id: 'p-gw', connected: false };
    assert.equal((await ra.getServiceHealth()).gateway, 'down');
    healthSetup({ ipPort: closedPort });
    assert.equal((await ra.getServiceHealth()).gateway, 'down');
    healthSetup();
    nbA.status['/api/groups/g-gw'] = 500;
    assert.equal((await ra.getServiceHealth()).gateway, 'unknown');
    healthSetup({ ipPort: closedPort });
    nbA.status['/api/groups/g-gw'] = 500;
    assert.equal((await ra.getServiceHealth()).gateway, 'down', 'guacd is known bad');
    healthSetup({ namesPort: closedPort });
    assert.equal((await ra.getServiceHealth()).namesGateway, 'down');
});

test('status: every peer of the gateway group is read, a few at a time; one connected peer is enough', async () => {
    healthSetup();
    const ids = Array.from({ length: 12 }, (_, i) => `p-${i}`);
    nbA.body['/api/groups/g-gw'] = { id: 'g-gw', name: 'Browser Gateway', peers: ids.map(id => ({ id })) };
    for (const id of ids) nbA.body[`/api/peers/${id}`] = { id, connected: false };
    nbA.body['/api/peers/p-11'] = { id: 'p-11', connected: true };
    assert.equal((await ra.getServiceHealth()).gateway, 'up', 'the twelfth peer is connected');
    healthSetup();
    nbA.body['/api/groups/g-gw'] = { id: 'g-gw', name: 'Browser Gateway', peers: ids.map(id => ({ id })) };
    for (const id of ids) nbA.body[`/api/peers/${id}`] = { id, connected: false };
    assert.equal((await ra.getServiceHealth()).gateway, 'down');
    assert.equal(nbA.seen.filter(s => s.path.startsWith('/api/peers/p-') && s.path !== '/api/peers/p-ngw').length, 12);
});

test('status: a names gateway known to be set up stays in as unknown when its group cannot be read', async () => {
    healthSetup();
    assert.equal((await ra.getServiceHealth()).namesGateway, 'up');
    // Another guacd port is another settings key, so a new probe runs (and its guacd is closed).
    ra._internal.setConfigForTest({ enabled: true, guacdHost: '127.0.0.1', guacdPort, namesGuacdHost: '127.0.0.1', namesGuacdPort: closedPort });
    nbA.status['/api/groups/g-ngw'] = 500;
    assert.equal((await ra.getServiceHealth()).namesGateway, 'unknown');
    // Never seen set up: a group that can't be read leaves it out.
    healthSetup();
    nbA.status['/api/groups/g-ngw'] = 500;
    assert.equal('namesGateway' in (await ra.getServiceHealth()), false);
});

test('status: one probe at a time, kept for 15 seconds', async () => {
    healthSetup();
    const [a, b] = await Promise.all([ra.getServiceHealth(), ra.getServiceHealth()]);
    assert.deepEqual(a, b);
    await ra.getServiceHealth();
    assert.equal(nbA.seen.filter(s => s.path === '/api/accounts').length, 1);
});

test('status: a settings change starts a new probe, and the old probe is never used or sent to the new URL', async () => {
    healthSetup();
    let release;
    nbA.hold = new Promise((r) => { release = r; });
    const pending = ra.getServiceHealth();
    while (!nbA.seen.some(s => s.path === '/api/accounts')) await new Promise((r) => setTimeout(r, 5));
    // The NetBird connection changes while the probe runs (URL and token together).
    nb._nbApi.url = urlB; nb._nbApi.token = TOKEN_B;
    nbB.status['/api/accounts'] = 401;
    release();
    const out = await pending;
    assert.equal(out.netbird, 'down', 'the answer is the new probe\'s (401 at the new URL), not the old one\'s');
    assert.ok(nbA.seen.every(s => s.auth === `Token ${TOKEN_A}`), 'the old URL only ever got the old token');
    assert.ok(nbB.seen.length > 0 && nbB.seen.every(s => s.auth === `Token ${TOKEN_B}`), 'the new URL only ever got the new token');
    // A gateway settings change also starts a new probe.
    const before = nbB.seen.filter(s => s.path === '/api/accounts').length;
    ra._internal.setManagedForTest({ gatewayGroupId: 'g-gw', namesGroupId: '' });
    const again = await ra.getServiceHealth();
    assert.equal(nbB.seen.filter(s => s.path === '/api/accounts').length, before + 1);
    assert.equal('namesGateway' in again, false);
});

test('status: a part that runs out of time is unknown, and the other parts keep their answers', async () => {
    healthSetup();
    ra._internal.setHealthDeadlineForTest(300);
    try {
        nbA.slow['/api/groups/g-gw'] = 1000;
        assert.deepEqual(await ra.getServiceHealth(), { netbird: 'up', gateway: 'unknown', namesGateway: 'up' });
        // No peer read starts after the time limit.
        healthSetup();
        const ids = Array.from({ length: 12 }, (_, i) => `p-${i}`);
        nbA.body['/api/groups/g-gw'] = { id: 'g-gw', name: 'Browser Gateway', peers: ids.map(id => ({ id })) };
        for (const id of ids) { nbA.body[`/api/peers/${id}`] = { id, connected: false }; nbA.slow[`/api/peers/${id}`] = 200; }
        assert.equal((await ra.getServiceHealth()).gateway, 'unknown');
        await new Promise((r) => setTimeout(r, 800));
        const sent = nbA.seen.filter(x => x.path.startsWith('/api/peers/p-') && x.path !== '/api/peers/p-ngw').length;
        assert.ok(sent < 12, `${sent} of 12 peer reads were sent`);
    } finally { ra._internal.setHealthDeadlineForTest(0); }
});

test('status: what was seen of the names gateway counts only for the same NetBird connection', async () => {
    healthSetup();
    assert.equal((await ra.getServiceHealth()).namesGateway, 'up');
    nb._nbApi.token = TOKEN_B; // another connection version
    nbA.status['/api/groups/g-ngw'] = 500;
    assert.equal('namesGateway' in (await ra.getServiceHealth()), false);
});

test('status: while the NetBird settings are being saved the probe sends nothing, and NetBird is unknown', async () => {
    healthSetup();
    let release;
    settingHold = new Promise((r) => { release = r; });
    const saving = nb.setNbApiConfig({ url: urlB, token: TOKEN_B });
    try {
        const out = await ra.getServiceHealth();
        assert.equal(out.netbird, 'unknown');
        assert.equal(nbA.seen.length + nbB.seen.length, 0, 'no request was sent to either URL');
    } finally { settingHold = null; release(); await saving; }
    // After the save, a probe runs normally against the new connection.
    nbB.seen = [];
    assert.equal((await ra.getServiceHealth()).netbird, 'up');
    assert.ok(nbB.seen.length > 0 && nbB.seen.every(x => x.auth === `Token ${TOKEN_B}`));
});

test('status: peer reads that run out of time: a known names gateway is unknown, a gateway with guacd down is down', async () => {
    healthSetup({ ipPort: closedPort });
    ra._internal.setHealthDeadlineForTest(300);
    try {
        nbA.slow['/api/peers/p-gw'] = 1000;
        nbA.slow['/api/peers/p-ngw'] = 1000;
        const out = await ra.getServiceHealth();
        assert.equal(out.gateway, 'down', 'its guacd is closed, so its slow peers do not matter');
        assert.equal(out.namesGateway, 'unknown', 'its group showed a peer, so it stays in');
    } finally { ra._internal.setHealthDeadlineForTest(0); }
});

test('status: only the latest probe stores its answer (A, B, A)', async () => {
    healthSetup();
    let release;
    nbA.hold = new Promise((r) => { release = r; });
    const first = ra.getServiceHealth(); // settings A, held
    while (!nbA.seen.some(x => x.path === '/api/accounts')) await new Promise((r) => setTimeout(r, 5));
    const cfgA = { enabled: true, guacdHost: '127.0.0.1', guacdPort, namesGuacdHost: '127.0.0.1', namesGuacdPort: guacdPort };
    ra._internal.setConfigForTest({ ...cfgA, namesGuacdPort: closedPort }); // settings B
    nbA.hold = null;
    await ra.getServiceHealth(); // a newer probe, stored for B
    ra._internal.setConfigForTest(cfgA); // back to A: the same key as the first probe
    release();
    await first;
    const before = nbA.seen.filter(x => x.path === '/api/accounts').length;
    await ra.getServiceHealth();
    assert.equal(nbA.seen.filter(x => x.path === '/api/accounts').length, before + 1, 'the older probe did not store its answer');
});

test('status: clean up', async () => {
    nb._nbApi.url = ''; nb._nbApi.token = '';
    for (const s of [guacd, nbA.server, nbB.server]) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
});
