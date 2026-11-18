// A read-only instance (NETBIRD_READONLY=true) never writes to NetBird, so it can't open a server
// to the Browser Gateway: it serves only servers already in their target group, refuses any other
// with a message that says why, checks the gateway's standing policy before a session like any
// instance, and still extends the holds of its open sessions (that writes only Postgres).
process.env.NETBIRD_READONLY = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] || null;
core.setSetting = async (k, v) => { settings[k] = v; };
const holds = require('./helpers/hold-table').holdTable();
core.pool.query = holds.query;
const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
let live = {};
const reads = [];
nb.netbirdGet = async (p) => { reads.push(p); return JSON.parse(JSON.stringify(live[p] ?? null)); };
const writes = [];
let onResourceRead = null; // runs when a session start reads its resource
nb.netbirdReq = async (method, p, body) => {
    if (method === 'GET') {
        const m = /^\/api\/networks\/[^/]+\/resources\/([^/]+)$/.exec(p);
        if (onResourceRead) onResourceRead();
        const r = m && live['/api/networks/resources'].find(x => x.id === m[1]);
        return r ? { status: 200, body: JSON.parse(JSON.stringify(r)) } : { status: 404, body: null };
    }
    writes.push([method, p, body]);
    return { status: 503, raw: 'read-only' };
};
const events = require('../lib/events');
events.addEvent = async () => { };

const ra = require('../lib/remote-access');

const HOUR = 3_600_000;
const sleeps = [];
const viewer = { user_id: 'u1', email: 'alice@example.test' };
function world() {
    live = {
        '/api/users': [{ id: 'u1', auto_groups: ['g-staff'], is_blocked: false }],
        '/api/peers': [{ id: 'p-gw', name: 'gw', groups: [{ id: 'g-gw' }], connected: true }, { id: 'p-r', name: 'router', groups: [], connected: true }],
        '/api/groups': [{ id: 'g-all', name: 'All' }, { id: 'g-gw', name: 'Browser Gateway' }, { id: 'g-gwt', name: 'Browser Gateway Targets' }, { id: 'g-staff', name: 'Staff' }, { id: 'g-srv', name: 'Servers' }],
        '/api/policies': [
            { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: [], sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
            { id: 'pol-staff', name: 'Staff', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] },
        ],
        '/api/networks/resources': [
            { id: 'r-open', name: 'open', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-srv' }, { id: 'g-gwt' }] },
            { id: 'r-cold', name: 'cold', type: 'host', address: '10.0.0.6/32', enabled: true, groups: [{ id: 'g-srv' }] },
        ],
        '/api/networks': [{ id: 'n1', name: 'Office', resources: ['r-open', 'r-cold'] }],
        '/api/routes': [],
        '/api/networks/n1/routers': [{ peer: 'p-r', enabled: true }],
    };
}
async function reset() {
    world();
    writes.length = 0; sleeps.length = 0; onResourceRead = null;
    holds.clear();
    ra._internal.setSleepForTest(async (ms) => { sleeps.push(ms); });
    ra.closeAllSessions('reset');
    settings.remote_access_config = JSON.stringify({ enabled: true, networks: ['n1'], holdHours: 3 });
    settings.remote_access_nb = JSON.stringify({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw' });
    await ra.loadRemoteAccessConfig();
    ra._internal.resetSettlingForTest();
    ra._internal.invalidateSnapshot();
}
const open = (address) => ra.createSession(viewer, { protocol: 'rdp', address, port: 3389 }, '203.0.113.9');
test.after(() => { ra.closeAllSessions('test over'); ra._internal.setSleepForTest(null); });

test('a read-only instance serves an open server and refuses a cold one, writing nothing', async () => {
    await reset();
    const cold = await ra.checkAccess(viewer, { protocol: 'rdp', address: '10.0.0.6', port: 3389 });
    assert.equal(cold.steps[0].code, 'TARGET_NOT_OPEN_READONLY');
    await assert.rejects(open('10.0.0.6'), (e) => e.code === 'TARGET_NOT_OPEN_READONLY');
    assert.ok((await open('10.0.0.5')).token);
    assert.deepEqual(writes, []);
    assert.deepEqual([...holds.rows.keys()], ['r-open'], 'the open server is held like on any instance (Postgres only)');
});

test('a read-only session start reads the resource again and approves it again before the token', async () => {
    await reset();
    // Taken out of its target group after the checks: this instance can't put it back.
    onResourceRead = () => { live['/api/networks/resources'][0].groups = [{ id: 'g-srv' }]; };
    await assert.rejects(open('10.0.0.5'), (e) => e.code === 'TARGET_NOT_OPEN_READONLY');
    await reset();
    onResourceRead = () => { live['/api/networks/resources'][0].address = '10.0.0.0/24'; };
    await assert.rejects(open('10.0.0.5'), (e) => e.code === 'TARGET_CHANGED');
    // The standing policy changes after the checks: the approval before the token reads NetBird again.
    await reset();
    onResourceRead = () => { live['/api/policies'][0].rules[0].ports = ['22']; };
    await assert.rejects(open('10.0.0.5'), (e) => e.code === 'GATEWAY_POLICY_PORT');
    assert.equal(ra.getRemoteAccessStatusLite().activeSessions, 0);
    assert.deepEqual(writes, []);
});

test('a read-only session start waits for a route that another instance just added', async () => {
    await reset();
    holds.set('r-open', { networkId: 'n1', address: '10.0.0.5/32', addedAt: Date.now() - 500, expiresAt: Date.now() + HOUR });
    assert.ok((await open('10.0.0.5')).token);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] > 1900 && sleeps[0] <= 2000, String(sleeps[0]));
});

test('a read-only instance checks the standing policy before a session', async () => {
    await reset();
    live['/api/policies'][0].rules[0].ports = ['22'];
    const r = await ra.checkAccess(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 });
    assert.equal(r.steps[0].code, 'GATEWAY_POLICY_PORT');
    await assert.rejects(open('10.0.0.5'), (e) => e.code === 'GATEWAY_POLICY_PORT');
});

test('the re-check on a read-only instance extends the holds of its open sessions', async () => {
    await reset();
    const soon = Date.now() + 60_000;
    holds.set('r-open', { networkId: 'n1', address: '10.0.0.5/32', expiresAt: soon }); // opened by another instance
    await ra._internal.loadTargetHolds();
    const out = await open('10.0.0.5');
    await ra.recheckSessions();
    assert.equal(ra.renewLease(viewer, out.sessionId), true);
    assert.ok(new Date(holds.rows.get('r-open').expires_at).getTime() > Date.now() + 3 * HOUR - 5000);
    assert.deepEqual(writes, []);
});
