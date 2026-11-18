// On-demand Browser Gateway targets: a selected network only says which resources MAY become
// targets. A resource joins its target group when an authorized user opens a session to it, and
// stays while its hold lasts:
//   - the checks before a session judge a resource as a member of its target group, with the
//     gateway's standing policy opening the port, and write nothing to NetBird;
//   - a session start sets the hold, adds the target group to the RESOURCE (one resource write,
//     only when it is still the approved resource), waits until the route is on the gateway
//     (ROUTE_SETTLE_MS after added_at), then approves it again from a fresh read;
//   - an accept rule that reaches a resource only through a target group grants nothing;
//   - the re-check of an open session extends its hold, and ends a session whose resource changed;
//   - a failed start frees its quota slot.
// NetBird and the database are stubs; nothing here needs Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');

// ─── Stubs, before lib/remote-access.js destructures them ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] || null;
core.setSetting = async (k, v) => { settings[k] = v; };
const holds = require('./helpers/hold-table').holdTable();
core.pool.query = holds.query;
const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
let live = {};
const TARGET_GROUPS = { 'g-gwt': 'Browser Gateway Targets', 'g-ngwt': 'Browser Gateway Name Targets' };
// As in NetBird: a group's resources and a resource's groups are one relation.
const groupView = (gid) => ({
    id: gid, name: TARGET_GROUPS[gid], peers: [],
    resources: live['/api/networks/resources'].filter(r => (r.groups || []).some(g => g.id === gid)).map(r => ({ id: r.id, type: r.type })),
});
nb.netbirdGet = async (p) => {
    const m = /^\/api\/groups\/([^/]+)$/.exec(p);
    if (m && TARGET_GROUPS[m[1]] && live.groupsReadable !== false) return clone(groupView(m[1]));
    return clone(live[p]);
};
const RES_PATH = /^\/api\/networks\/([^/]+)\/resources\/([^/]+)$/;
const resourceAt = (p) => {
    const m = RES_PATH.exec(p);
    const net = m && live['/api/networks'].find(n => n.id === m[1]);
    return net && net.resources.includes(m[2]) ? live['/api/networks/resources'].find(r => r.id === m[2]) : null;
};
const writes = []; // [method, path, body] of every NetBird write
let writeAnswer = null;
let readAnswer = null; // a test's answer to a resource read, instead of the resource
nb.netbirdReq = async (method, p, body) => {
    if (method === 'GET') {
        if (readAnswer) return readAnswer;
        const r = resourceAt(p);
        return r ? { status: 200, body: clone(r) } : { status: 404, body: null };
    }
    writes.push([method, p, clone(body)]);
    if (writeAnswer) return writeAnswer;
    const r = resourceAt(p);
    if (method === 'PUT' && r) r.groups = body.groups.map(id => ({ id }));
    const m = /^\/api\/groups\/([^/]+)$/.exec(p);
    if (method === 'PUT' && m && TARGET_GROUPS[m[1]]) {
        const members = new Set(body.resources.map(x => x.id));
        for (const x of live['/api/networks/resources']) {
            const others = (x.groups || []).filter(g => g.id !== m[1]);
            x.groups = members.has(x.id) ? [...others, { id: m[1] }] : others;
        }
    }
    return { status: 200, body: { id: 'ok' } };
};
const events = require('../lib/events');
let onEvent = null; // runs while a session record is written
events.addEvent = async (e) => { if (onEvent) await onEvent(e); };

const auth = require('../lib/remote-access-auth');
const ra = require('../lib/remote-access');

const HOUR = 3_600_000;
const viewer = { user_id: 'u1', email: 'alice@example.test', name: 'Alice' };
const NB = { gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' };
const gatewayPolicy = (over = {}) => ({ id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: [], sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }], ...over }] });

// One open network with three servers; nothing is in a target group yet ("cold").
function world() {
    live = {
        '/api/users': [{ id: 'u1', auto_groups: ['g-staff'], is_blocked: false }],
        '/api/peers': [
            { id: 'p-gw', name: 'gw', groups: [{ id: 'g-gw' }], connected: true },
            { id: 'p-ngw', name: 'ngw', groups: [{ id: 'g-ngw' }], connected: true },
            { id: 'p-r', name: 'router', groups: [], connected: true },
        ],
        '/api/groups': [
            { id: 'g-all', name: 'All' }, { id: 'g-gw', name: 'Browser Gateway' }, { id: 'g-gwt', name: 'Browser Gateway Targets' },
            { id: 'g-ngw', name: 'Browser Gateway Names' }, { id: 'g-ngwt', name: 'Browser Gateway Name Targets' },
            { id: 'g-staff', name: 'Staff' }, { id: 'g-srv', name: 'Servers' },
        ],
        '/api/policies': [
            gatewayPolicy(),
            { id: 'pol-ngw', name: 'Browser Gateway Names', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-ngw' }], destinations: [{ id: 'g-ngwt' }] }] },
            { id: 'pol-staff', name: 'Staff', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['22', '3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] },
        ],
        '/api/networks/resources': [
            { id: 'r1', name: 'srv1', type: 'host', address: '10.0.0.5/32', description: 'first', enabled: true, groups: [{ id: 'g-srv' }] },
            { id: 'r2', name: 'srv2', type: 'host', address: '10.0.0.6/32', enabled: true, groups: [{ id: 'g-srv' }] },
            { id: 'r-dom', name: 'Safe', type: 'domain', address: 'safe.example.com', enabled: true, groups: [{ id: 'g-srv' }] },
        ],
        '/api/networks': [{ id: 'n1', name: 'Office', resources: ['r1', 'r2', 'r-dom'] }],
        '/api/routes': [],
        '/api/networks/n1/routers': [{ peer: 'p-r', enabled: true }],
    };
}
const policy = (id) => live['/api/policies'].find(p => p.id === id);
const resource = (id) => live['/api/networks/resources'].find(r => r.id === id);
const sleeps = [];
let onSleep = null; // runs during the wait before the session is approved
async function reset(cfg = {}) {
    world();
    writes.length = 0; sleeps.length = 0; onSleep = null; onEvent = null; writeAnswer = null; readAnswer = null;
    holds.clear();
    ra.closeAllSessions('reset');
    settings.remote_access_config = JSON.stringify({ enabled: true, networks: ['n1'], ...cfg });
    settings.remote_access_nb = JSON.stringify(NB);
    await ra.loadRemoteAccessConfig();
    ra._internal.resetSettlingForTest();
    ra._internal.invalidateSnapshot();
    ra._internal.setSleepForTest?.(async (ms) => { sleeps.push(ms); if (onSleep) await onSleep(); });
}
const groupWrites = () => writes.filter(w => w[0] === 'PUT' && w[1].startsWith('/api/groups/'));
const active = () => ra.getRemoteAccessStatusLite().activeSessions;
const rdp = () => ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
const check = (port = 3389) => ra.checkAccess(viewer, { protocol: 'rdp', address: '10.0.0.5', port });
test.after(() => { ra.closeAllSessions('test over'); ra._internal.setSleepForTest?.(null); });

// ─── The checks before a session ───
test('a cold resource in an open network passes the check without any NetBird write', async () => {
    await reset();
    const r = await check();
    assert.deepEqual(r.steps.map(s => [s.key, s.status]), [['access', 'pass'], ['path', 'pass']]);
    const n = await ra.checkAccess(viewer, { protocol: 'ssh', address: 'safe.example.com', port: 22 });
    assert.deepEqual(n.steps.map(s => [s.key, s.status]), [['access', 'pass'], ['path', 'pass']], 'a domain resource on the names gateway too');
    assert.equal(writes.length, 0);
    assert.equal(holds.rows.size, 0, 'nor any hold');
});

test('a missing or disabled standing policy still refuses a cold resource at the check', async () => {
    await reset();
    policy('pol-gw').enabled = false;
    assert.equal((await check()).steps[0].code, 'GATEWAY_POLICY_MISSING');
    await reset();
    policy('pol-gw').rules[0].destinations = [{ id: 'g-other' }]; // re-pointed elsewhere
    assert.equal((await check()).steps[0].code, 'GATEWAY_POLICY_MISSING');
    assert.equal(writes.length, 0);
});

test('the checks require the standing policy even when another policy already gives the gateway a route', async () => {
    const otherRoute = { id: 'pol-extra', name: 'Gateway to the servers', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [], destinationResource: { id: 'r1', type: 'host' } }] };
    await reset();
    live['/api/policies'].push(otherRoute);
    policy('pol-gw').rules[0].destinations = [{ id: 'g-other' }];
    assert.equal((await check()).steps[0].code, 'GATEWAY_POLICY_MISSING');
    await assert.rejects(rdp(), (e) => e.code === 'GATEWAY_POLICY_MISSING');
    await reset();
    live['/api/policies'].push(otherRoute);
    policy('pol-gw').rules[0].ports = ['22'];
    assert.equal((await check()).steps[0].code, 'GATEWAY_POLICY_PORT', 'a standing policy that does not open the port');
    await assert.rejects(rdp(), (e) => e.code === 'GATEWAY_POLICY_PORT');
    assert.equal(writes.length, 0);
    assert.equal(holds.rows.size, 0, 'refused before any hold');
    assert.equal(active(), 0);
});

test('a drop rule to the target group counts at the check, also when another policy already routes to the resource', async () => {
    await reset();
    live['/api/policies'].push({ id: 'pol-extra', name: 'Gateway to the servers', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [], destinationResource: { id: 'r1', type: 'host' } }] });
    live['/api/policies'].push({ id: 'pol-drop', name: 'No RDP to browser targets', enabled: true, rules: [{ enabled: true, action: 'drop', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-gwt' }] }] });
    assert.equal((await check()).steps[0].code, 'BLOCKED_BY_POLICY');
    await assert.rejects(rdp(), (e) => e.code === 'BLOCKED_BY_POLICY');
    assert.equal(writes.length, 0);
});

// ─── Session start ───
test('a session start adds the target group to the resource in one write, waits for the route, approves it again and issues a token', async () => {
    await reset();
    const reads = [];
    onSleep = async () => { reads.push(groupView('g-gwt').resources); };
    const before = Date.now();
    const out = await rdp();
    assert.ok(out.token && out.sessionId);
    assert.deepEqual(writes, [['PUT', '/api/networks/n1/resources/r1', { name: 'srv1', address: '10.0.0.5/32', description: 'first', enabled: true, groups: ['g-srv', 'g-gwt'] }]],
        'one write, of the resource with its own fields; the group list is never rewritten');
    assert.deepEqual(reads, [[{ id: 'r1', type: 'host' }]], 'the wait comes after the write');
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] > ra.ROUTE_SETTLE_MS - 500 && sleeps[0] <= ra.ROUTE_SETTLE_MS, `the rest of ${ra.ROUTE_SETTLE_MS} ms after added_at (${sleeps[0]})`);
    const row = holds.rows.get('r1');
    assert.equal(row.network_id, 'n1');
    assert.equal(row.address, '10.0.0.5/32', 'the address as NetBird has it');
    assert.ok(new Date(row.added_at).getTime() >= before);
    const exp = new Date(row.expires_at).getTime();
    assert.ok(exp >= before + 10 * HOUR && exp <= Date.now() + 10 * HOUR, 'the full default hold of 10 hours at once');
    // added_at was written before the resource write, then again after its answer.
    const order = holds.log.filter(q => !/^\s*SELECT/i.test(q.sql)).map(q => (/^\s*INSERT/i.test(q.sql) ? 'hold' : /added_at = \$4/.test(q.sql) ? 'added_at' : q.sql));
    assert.deepEqual(order, ['hold', 'added_at', 'added_at']);
});

test('two opens never undo each other: a member another instance added meanwhile stays', async () => {
    await reset();
    // While this instance records added_at, another one adds r2 to the target group.
    holds.failWith((sql) => { if (/added_at = \$4/.test(sql) && !resource('r2').groups.some(g => g.id === 'g-gwt')) resource('r2').groups.push({ id: 'g-gwt' }); return null; });
    await rdp();
    assert.deepEqual(groupView('g-gwt').resources.map(r => r.id).sort(), ['r1', 'r2']);
    assert.equal(groupWrites().length, 0);
});

test('a resource that changed after the checks is not opened, and nothing is written to NetBird', async () => {
    const changes = {
        'a new address': () => { resource('r1').address = '10.0.0.0/24'; },
        'another type': () => { resource('r1').type = 'subnet'; },
        'deleted': () => { live['/api/networks'][0].resources = live['/api/networks'][0].resources.filter(id => id !== 'r1'); },
    };
    for (const [label, change] of Object.entries(changes)) {
        await reset();
        // Right after the checks, while the hold is written.
        holds.failWith((sql) => { if (/^\s*INSERT/i.test(sql)) change(); return null; });
        await assert.rejects(rdp(), (e) => e.code === 'TARGET_CHANGED', label);
        assert.deepEqual(writes, [], label);
        assert.equal(active(), 0, label);
    }
    // The same address written without /32 is the same resource.
    await reset();
    holds.failWith((sql) => { if (/^\s*INSERT/i.test(sql)) resource('r1').address = '10.0.0.5'; return null; });
    assert.ok((await rdp()).token);
});

test('a second start within the settle time waits only the rest of it, without another write', async () => {
    await reset();
    await rdp();
    await new Promise(r => setTimeout(r, 50));
    await rdp();
    assert.equal(writes.length, 1, 'already a member: no second write');
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1] < sleeps[0] && sleeps[1] > 0, `the rest from the stored added_at (${sleeps[0]} then ${sleeps[1]})`);
    // Added long enough ago: no wait at all.
    holds.rows.get('r1').added_at = new Date(Date.now() - 10_000);
    await rdp();
    assert.equal(sleeps.length, 2);
});

test("the hold keeps an added_at that another instance wrote, and waits from it", async () => {
    await reset();
    resource('r1').groups.push({ id: 'g-gwt' }); // another instance added it a moment ago
    holds.set('r1', { networkId: 'n1', address: '10.0.0.5/32', addedAt: Date.now() - 400, expiresAt: Date.now() + HOUR });
    await rdp();
    assert.equal(writes.length, 0);
    assert.equal(sleeps.length, 1, 'waits the rest after the other instance\'s add');
    assert.ok(sleeps[0] > 1000 && sleeps[0] <= ra.ROUTE_SETTLE_MS - 400, String(sleeps[0]));
    // Written by the other instance between this instance's read and its write of the hold.
    await reset();
    resource('r1').groups.push({ id: 'g-gwt' });
    holds.set('r1', { networkId: 'n1', address: '10.0.0.5/32', addedAt: null, expiresAt: Date.now() + HOUR });
    holds.failWith((sql) => { if (/^\s*INSERT/i.test(sql)) holds.rows.get('r1').added_at = new Date(Date.now() - 300); return null; });
    await rdp();
    assert.ok(holds.rows.get('r1').added_at, 'not overwritten');
    assert.equal(sleeps.length, 1);
});

test('a session start on the names gateway adds the names target group to the domain resource', async () => {
    await reset();
    const out = await ra.createSession(viewer, { protocol: 'ssh', address: 'safe.example.com', port: 22, username: 'alice' }, '203.0.113.9');
    assert.equal(out.gateway, 'names');
    assert.deepEqual(writes.map(w => [w[1], w[2].groups]), [['/api/networks/n1/resources/r-dom', ['g-srv', 'g-ngwt']]]);
    assert.equal(holds.rows.get('r-dom').address, 'safe.example.com');
});

test('the token is refused when the standing policy no longer opens the port, or is off', async () => {
    // Changed during the wait: the approval after the add reads NetBird again.
    await reset();
    onSleep = async () => { policy('pol-gw').rules[0].ports = ['22']; };
    await assert.rejects(rdp(), (e) => e.code === 'GATEWAY_POLICY_PORT');
    assert.equal(active(), 0, 'the quota slot is free again');

    // Disabled, while another policy still carries the gateway to the target group.
    await reset();
    live['/api/policies'].push({ id: 'pol-extra', name: 'Gateway extra', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] });
    onSleep = async () => { policy('pol-gw').enabled = false; };
    await assert.rejects(rdp(), (e) => e.code === 'GATEWAY_POLICY_MISSING');

    // Disabled, and nothing else reaches it: the route isn't there.
    await reset();
    onSleep = async () => { policy('pol-gw').enabled = false; };
    await assert.rejects(rdp(), (e) => e.code === 'GATEWAY_NOT_SYNCED');
    assert.equal(active(), 0);
});

test('the approval after the add is the real evaluation: a member taken out meanwhile is refused', async () => {
    await reset();
    onSleep = async () => { resource('r1').groups = [{ id: 'g-srv' }]; };
    await assert.rejects(rdp(), (e) => e.code === 'GATEWAY_NOT_SYNCED');
    assert.equal(active(), 0);
});

test('no token when settling started while the start was being recorded', async () => {
    await reset();
    onEvent = async (e) => { if (e.Message === 'TYPE_START') ra.noteUncertainTargetWrite(); };
    await assert.rejects(rdp(), (e) => e.code === 'TARGETS_SETTLING');
    assert.equal(active(), 0);
});

test('every failed start frees its quota slot and issues no token', async () => {
    // The resource can't be read: nothing is written.
    await reset({ maxSessionsPerUser: 1 });
    readAnswer = { status: 500, raw: 'boom' };
    await assert.rejects(rdp(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(active(), 0);
    assert.equal(writes.length, 0);
    // The hold can't be recorded: nothing is written.
    await reset({ maxSessionsPerUser: 1 });
    holds.failWith((sql) => (/^\s*INSERT/i.test(sql) ? new Error('db down') : null));
    await assert.rejects(rdp(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(active(), 0);
    assert.equal(writes.length, 0);
    // added_at can't be recorded before the write: the resource is not written.
    await reset({ maxSessionsPerUser: 1 });
    holds.failWith((sql) => (/added_at = \$4/.test(sql) ? new Error('db down') : null));
    await assert.rejects(rdp(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(writes.length, 0);
    assert.equal(active(), 0);
    // ...nor when the hold is gone by then (the update changed no row).
    await reset({ maxSessionsPerUser: 1 });
    holds.failWith((sql) => { if (/added_at = \$4/.test(sql)) holds.rows.delete('r1'); return null; });
    await assert.rejects(rdp(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(writes.length, 0);
    assert.equal(active(), 0);
    // NetBird refuses the resource write: the write is uncertain, new sessions wait.
    await reset({ maxSessionsPerUser: 1 });
    writeAnswer = { status: 500, raw: 'boom' };
    await assert.rejects(rdp(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(active(), 0);
    assert.equal(ra._internal.settlingForTest(), true);
    // Closed while it waited for the route (Remote Access turned off, a shutdown).
    await reset({ maxSessionsPerUser: 1 });
    onSleep = async () => { ra.closeAllSessions('turned off'); };
    await assert.rejects(rdp(), (e) => e.code === 'SESSION_CLOSED');
    assert.equal(active(), 0);
    // And the slot really is free: the next start opens.
    await reset({ maxSessionsPerUser: 1 });
    assert.ok((await rdp()).token);
    assert.equal(active(), 1);
});

test('a session to the same resource under a new address replaces its hold', async () => {
    await reset();
    holds.set('r1', { networkId: 'n1', address: '10.0.0.6/32', addedAt: Date.now() - 60_000, expiresAt: Date.now() + 50 * HOUR });
    await rdp();
    const row = holds.rows.get('r1');
    assert.equal(row.address, '10.0.0.5/32');
    assert.ok(new Date(row.expires_at).getTime() <= Date.now() + 10 * HOUR, 'a new hold, not the longer expiry of the old identity');
    // The same identity keeps the later expiry (GREATEST).
    const later = Date.now() + 30 * HOUR;
    row.expires_at = new Date(later);
    await rdp();
    assert.equal(new Date(holds.rows.get('r1').expires_at).getTime(), later);
});

// ─── The re-check ───
test('the re-check of an open session extends its hold; a hold for another identity is not touched', async () => {
    await reset({ holdHours: 2 });
    const out = await rdp();
    const soon = Date.now() + 60_000;
    holds.rows.get('r1').expires_at = new Date(soon);
    await ra._internal.loadTargetHolds();
    await ra.recheckSessions();
    assert.equal(ra.renewLease(viewer, out.sessionId), true, 'the session stays');
    const exp = new Date(holds.rows.get('r1').expires_at).getTime();
    assert.ok(exp > Date.now() + 2 * HOUR - 5000, 'raised to now + holdHours');
    assert.equal(ra._internal.holdsForTest().r1.expiresAt, exp, 'and in memory');
    // The same address written without /32 is the same identity.
    holds.rows.get('r1').address = '10.0.0.5';
    holds.rows.get('r1').expires_at = new Date(soon);
    await ra.recheckSessions();
    assert.ok(new Date(holds.rows.get('r1').expires_at).getTime() > soon);
    // The hold now describes another address: it is not extended, and not created again.
    holds.rows.get('r1').address = '10.0.0.6/32';
    holds.rows.get('r1').expires_at = new Date(soon);
    await ra.recheckSessions();
    assert.equal(new Date(holds.rows.get('r1').expires_at).getTime(), soon);
    holds.rows.delete('r1');
    await ra.recheckSessions();
    assert.equal(holds.rows.has('r1'), false);
});

test('the re-check counts only real membership', async () => {
    await reset();
    const out = await rdp();
    // Taken out of the target group (the sync, or by hand): the session closes.
    resource('r1').groups = [{ id: 'g-srv' }];
    await ra.recheckSessions();
    assert.equal(ra.renewLease(viewer, out.sessionId), false);
});

test('the re-check ends a session whose approved resource now has another address', async () => {
    await reset();
    const out = await rdp();
    // Still the same id, still covering the address, still a member: but not what was approved.
    resource('r1').address = '10.0.0.0/24';
    resource('r1').type = 'subnet';
    await ra.recheckSessions();
    assert.equal(ra.renewLease(viewer, out.sessionId), false);
});

test('the settings page lists the held servers that are open, in use or with their expiry', async () => {
    await reset();
    await rdp();
    resource('r-dom').groups.push({ id: 'g-ngwt' });
    holds.set('r-dom', { networkId: 'n1', address: 'safe.example.com', expiresAt: Date.now() + HOUR });
    holds.set('r2', { networkId: 'n1', address: '10.0.0.6/32', expiresAt: Date.now() + HOUR }); // a hold, but not a member
    holds.set('r-old', { networkId: 'n1', address: '10.0.0.9/32', expiresAt: Date.now() - 1000 });
    await ra._internal.loadTargetHolds();
    ra._internal.invalidateSnapshot();
    const snap = await ra._internal.freshSnapshot(0);
    const held = ra._internal.heldTargets(snap);
    assert.deepEqual(held.map(h => [h.name, h.address, h.network, h.inUse]), [['srv1', '10.0.0.5/32', 'Office', true], ['Safe', 'safe.example.com', 'Office', false]],
        'in use first; a hold without membership and an expired hold are not listed');
    assert.ok(Date.parse(held[1].expiresAt) > Date.now());
    assert.equal(ra._internal.heldTargets(null).length, 3, 'without a snapshot, every valid hold');
});

// ─── Settings ───
test('holdHours: 10 by default, a whole number of hours from 1 to 72', () => {
    const norm = (v) => ra._internal.normConfig(v === undefined ? {} : { holdHours: v }).holdHours;
    assert.equal(norm(undefined), 10);
    assert.equal(norm('abc'), 10);
    assert.equal(norm(0), 1);
    assert.equal(norm(-5), 1);
    assert.equal(norm(100), 72);
    assert.equal(norm('12'), 12);
    assert.equal(norm(24.9), 24);
    assert.equal(ra.getRemoteAccessConfig().holdHours !== undefined, true, 'part of the saved (and exported) settings');
});

// ─── The evaluation ───
const MANAGED = ['pol-gw', 'pol-ngw'];
const cfg = (over = {}) => ({ networks: ['n1'], gatewayGroupId: 'g-gw', gatewayGroupIds: ['g-gw', 'g-ngw'], managedPolicyIds: MANAGED, targetGroupId: 'g-gwt', targetGroupIds: ['g-gwt', 'g-ngwt'], simulate: true, ...over });
function snapshot() {
    world();
    const pick = (p) => clone(live[p]);
    return {
        users: pick('/api/users'), peers: pick('/api/peers'), groups: pick('/api/groups'), policies: pick('/api/policies'),
        resources: pick('/api/networks/resources'), networks: pick('/api/networks'), routes: [], grants: [],
    };
}
const ask = (s, c, port = 3389) => auth.evaluateUserAccess(s, c, { userId: 'u1', address: '10.0.0.5', port });

test('a foreign accept rule to a target group grants nothing, member or not', () => {
    for (const member of [false, true]) {
        const s = snapshot();
        if (member) s.resources[0].groups.push({ id: 'g-gwt' });
        s.policies = s.policies.filter(p => p.id !== 'pol-staff');
        s.policies.push({ id: 'pol-foreign', name: 'Everyone to the browser targets', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'all', sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-gwt' }] }] });
        assert.equal(ask(s, cfg()).code, 'NO_ACCESS', member ? 'a member' : 'a cold resource');
        // Another installation's target group, known only by its name, grants nothing either.
        s.groups.push({ id: 'g-other-t', name: 'Browser Gateway Targets (Other Install)' });
        s.resources[0].groups.push({ id: 'g-other-t' });
        s.policies[s.policies.length - 1].rules[0].destinations = [{ id: 'g-other-t' }];
        assert.equal(ask(s, cfg()).code, 'NO_ACCESS');
    }
    // The resource's own policies still grant.
    assert.equal(ask(snapshot(), cfg()).ok, true);
});

test('a drop rule to a target group still blocks, also through the simulated membership', () => {
    const s = snapshot();
    s.policies.push({ id: 'pol-drop', name: 'No RDP to browser targets', enabled: true, rules: [{ enabled: true, action: 'drop', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-gwt' }] }] });
    assert.equal(ask(s, cfg()).code, 'BLOCKED_BY_POLICY', 'cold: judged as a member');
    // In the gateway's reach through another policy, but not a member: still judged as a member.
    s.policies.push({ id: 'pol-extra', name: 'Gateway to the servers', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [], destinationResource: { id: 'r1', type: 'host' } }] });
    assert.equal(ask(s, cfg()).code, 'BLOCKED_BY_POLICY', 'reached another way');
    s.resources[0].groups.push({ id: 'g-gwt' });
    assert.equal(ask(s, cfg({ simulate: false })).code, 'BLOCKED_BY_POLICY', 'a real member');
});

test('only the chosen resource is simulated as a member, and only when asked to', () => {
    const s = snapshot();
    assert.equal(ask(s, cfg()).ok, true);
    assert.equal(s.resources[0].groups.some(g => g.id === 'g-gwt'), false, 'the snapshot itself is not changed');
    assert.equal(ask(s, cfg({ simulate: false })).code, 'GATEWAY_NOT_SYNCED', 'the real evaluation counts real membership only');
    assert.equal(ask(s, cfg({ targetGroupId: '' })).code, 'GATEWAY_POLICY_MISSING');
});

test('a read-only instance refuses a cold resource, and still serves one that is a member', () => {
    const s = snapshot();
    const ro = cfg({ simulate: false, readonly: true });
    assert.equal(ask(s, ro).code, 'TARGET_NOT_OPEN_READONLY');
    assert.match(ra._internal.MESSAGES.TARGET_NOT_OPEN_READONLY, /read-only/);
    const n = auth.evaluateNameAccess(s, { ...ro, gatewayGroupId: 'g-ngw', targetGroupId: 'g-ngwt' }, { userId: 'u1', name: 'safe.example.com', port: 22 });
    assert.equal(n.code, 'TARGET_NOT_OPEN_READONLY');
    s.resources[0].groups.push({ id: 'g-gwt' });
    assert.equal(ask(s, ro).ok, true);
    // The standing policy counts on a read-only instance too, when asked for.
    const standing = { policyId: 'pol-gw', gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt' };
    s.policies[0].rules[0].ports = ['22'];
    assert.equal(ask(s, { ...ro, standingPolicy: standing }).code, 'GATEWAY_POLICY_PORT');
});

test('the standing policy check: present, enabled, gateway group to target group, opening the port', () => {
    const s = snapshot();
    const ids = { policyId: 'pol-gw', gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt' };
    assert.equal(auth.standingPolicyProblem(s, ids, 3389), null);
    assert.equal(auth.standingPolicyProblem(s, { ...ids, policyId: 'gone' }, 3389), 'GATEWAY_POLICY_MISSING');
    s.policies[0].rules[0].ports = ['22'];
    assert.equal(auth.standingPolicyProblem(s, ids, 3389), 'GATEWAY_POLICY_PORT');
    s.policies[0].rules[0].protocol = 'udp';
    s.policies[0].rules[0].ports = [];
    assert.equal(auth.standingPolicyProblem(s, ids, 3389), 'GATEWAY_POLICY_PORT');
    s.policies[0].rules[0].protocol = 'tcp';
    s.policies[0].rules[0].sources = [{ id: 'g-all' }];
    assert.equal(auth.standingPolicyProblem(s, ids, 3389), 'GATEWAY_POLICY_MISSING');
    s.policies[0].rules[0].sources = [{ id: 'g-gw' }];
    s.policies[0].rules[0].enabled = false;
    assert.equal(auth.standingPolicyProblem(s, ids, 3389), 'GATEWAY_POLICY_MISSING');
    s.policies[0].rules[0].enabled = true;
    s.policies[0].enabled = false;
    assert.equal(auth.standingPolicyProblem(s, ids, 3389), 'GATEWAY_POLICY_MISSING');
});
