// On-demand Browser Gateway targets: a selected network only says which resources MAY become
// targets. A resource joins its target group when an authorized user opens a session to it, and
// stays while its hold lasts:
//   - the checks before a session judge a resource that is not in its group yet as if it were, and
//     write nothing to NetBird;
//   - a session start sets the hold, adds the resource (one group write), waits until the route is
//     on the gateway (ROUTE_SETTLE_MS after added_at), then approves it again from a fresh read,
//     with the gateway's standing policy opening the port;
//   - an accept rule that reaches a resource only through a target group grants nothing;
//   - the re-check of an open session extends its hold; a failed start frees its quota slot.
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
let live = {};
nb.netbirdGet = async (p) => JSON.parse(JSON.stringify(live[p] ?? null));
const writes = []; // [method, path, body] of every NetBird write
let writeAnswer = null;
nb.netbirdReq = async (method, p, body) => {
    writes.push([method, p, JSON.parse(JSON.stringify(body ?? null))]);
    if (writeAnswer) return writeAnswer;
    // As in NetBird: a group's resources and a resource's groups are one relation.
    const m = /^\/api\/groups\/([^/]+)$/.exec(p);
    if (method === 'PUT' && m && live[p]) {
        live[p] = { ...live[p], name: body.name, peers: [], resources: body.resources };
        const members = new Set(body.resources.map(r => r.id));
        for (const r of live['/api/networks/resources']) {
            const others = (r.groups || []).filter(g => g.id !== m[1]);
            r.groups = members.has(r.id) ? [...others, { id: m[1] }] : others;
        }
    }
    return { status: 200, body: { id: 'ok' } };
};
const events = require('../lib/events');
events.addEvent = async () => { };

const auth = require('../lib/remote-access-auth');
const ra = require('../lib/remote-access');

const HOUR = 3_600_000;
const viewer = { user_id: 'u1', email: 'alice@example.test', name: 'Alice' };
const NB = { gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' };
const gatewayPolicy = (over = {}) => ({ id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: [], sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }], ...over }] });

// One open network with two servers; nothing is in a target group yet ("cold").
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
            { id: 'r1', name: 'srv1', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-srv' }] },
            { id: 'r-dom', name: 'Safe', type: 'domain', address: 'safe.example.com', enabled: true, groups: [{ id: 'g-srv' }] },
        ],
        '/api/networks': [{ id: 'n1', name: 'Office', resources: ['r1', 'r-dom'] }],
        '/api/routes': [],
        '/api/networks/n1/routers': [{ peer: 'p-r', enabled: true }],
        '/api/groups/g-gwt': { id: 'g-gwt', name: 'Browser Gateway Targets', peers: [], resources: [] },
        '/api/groups/g-ngwt': { id: 'g-ngwt', name: 'Browser Gateway Name Targets', peers: [], resources: [] },
    };
}
const policy = (id) => live['/api/policies'].find(p => p.id === id);
const sleeps = [];
let onSleep = null; // runs during the wait before the session is approved
async function reset(cfg = {}) {
    world();
    writes.length = 0; sleeps.length = 0; onSleep = null; writeAnswer = null;
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
test.after(() => { ra.closeAllSessions('test over'); ra._internal.setSleepForTest?.(null); });

// ─── The checks before a session ───
test('a cold resource in an open network passes the check without any NetBird write', async () => {
    await reset();
    const r = await ra.checkAccess(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 });
    assert.deepEqual(r.steps.map(s => [s.key, s.status]), [['access', 'pass'], ['path', 'pass']]);
    const n = await ra.checkAccess(viewer, { protocol: 'ssh', address: 'safe.example.com', port: 22 });
    assert.deepEqual(n.steps.map(s => [s.key, s.status]), [['access', 'pass'], ['path', 'pass']], 'a domain resource on the names gateway too');
    assert.equal(writes.length, 0);
    assert.equal(holds.rows.size, 0, 'nor any hold');
});

test('a missing or disabled standing policy still refuses a cold resource at the check', async () => {
    await reset();
    policy('pol-gw').enabled = false;
    const r = await ra.checkAccess(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 });
    assert.equal(r.steps[0].code, 'GATEWAY_POLICY_MISSING');
    await reset();
    policy('pol-gw').rules[0].destinations = [{ id: 'g-other' }]; // re-pointed elsewhere
    const p = await ra.checkAccess(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 });
    assert.equal(p.steps[0].code, 'GATEWAY_POLICY_MISSING');
    assert.equal(writes.length, 0);
});

// ─── Session start ───
test('a session start adds the resource in one write, waits for the route, approves it again and issues a token', async () => {
    await reset();
    const reads = [];
    onSleep = async () => { reads.push(JSON.parse(JSON.stringify(live['/api/groups/g-gwt'].resources))); };
    const before = Date.now();
    const out = await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    assert.ok(out.token && out.sessionId);
    assert.deepEqual(groupWrites(), [['PUT', '/api/groups/g-gwt', { name: 'Browser Gateway Targets', peers: [], resources: [{ id: 'r1', type: 'host' }] }]], 'one group write, with NetBird\'s type');
    assert.deepEqual(reads, [[{ id: 'r1', type: 'host' }]], 'the wait comes after the write');
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] > ra.ROUTE_SETTLE_MS - 500 && sleeps[0] <= ra.ROUTE_SETTLE_MS, `the rest of ${ra.ROUTE_SETTLE_MS} ms after added_at (${sleeps[0]})`);
    const row = holds.rows.get('r1');
    assert.equal(row.network_id, 'n1');
    assert.equal(row.address, '10.0.0.5/32', 'the address as NetBird has it');
    assert.ok(new Date(row.added_at).getTime() >= before);
    const exp = new Date(row.expires_at).getTime();
    assert.ok(exp >= before + 10 * HOUR && exp <= Date.now() + 10 * HOUR, 'the full default hold of 10 hours at once');
    // added_at was written before the group write, then again after its answer.
    const order = holds.log.filter(q => !/^\s*SELECT/i.test(q.sql)).map(q => (/^\s*INSERT/i.test(q.sql) ? 'hold' : /added_at/.test(q.sql) ? 'added_at' : q.sql));
    assert.deepEqual(order, ['hold', 'added_at', 'added_at']);
});

test('a second start within the settle time waits only the rest of it, without another write', async () => {
    await reset();
    await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    await new Promise(r => setTimeout(r, 50));
    await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    assert.equal(groupWrites().length, 1, 'already a member: no second write');
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1] < sleeps[0] && sleeps[1] > 0, `the rest from the stored added_at (${sleeps[0]} then ${sleeps[1]})`);
    // Added long enough ago: no wait at all.
    holds.rows.get('r1').added_at = new Date(Date.now() - 10_000);
    await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    assert.equal(sleeps.length, 2);
});

test('a session start on the names gateway adds the domain resource to the names target group', async () => {
    await reset();
    const out = await ra.createSession(viewer, { protocol: 'ssh', address: 'safe.example.com', port: 22, username: 'alice' }, '203.0.113.9');
    assert.equal(out.gateway, 'names');
    assert.deepEqual(groupWrites().map(w => [w[1], w[2].resources]), [['/api/groups/g-ngwt', [{ id: 'r-dom', type: 'domain' }]]]);
    assert.equal(holds.rows.get('r-dom').address, 'safe.example.com');
});

test('the token is refused when the standing policy no longer opens the port, or is off', async () => {
    // Changed during the wait: the approval after the add reads NetBird again.
    await reset();
    onSleep = async () => { policy('pol-gw').rules[0].ports = ['22']; };
    await assert.rejects(ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9'), (e) => e.code === 'GATEWAY_POLICY_PORT');
    assert.equal(active(), 0, 'the quota slot is free again');

    // Disabled, while another policy still carries the gateway to the target group.
    await reset();
    live['/api/policies'].push({ id: 'pol-extra', name: 'Gateway extra', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] });
    onSleep = async () => { policy('pol-gw').enabled = false; };
    await assert.rejects(ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9'), (e) => e.code === 'GATEWAY_POLICY_MISSING');

    // Disabled, and nothing else reaches it: the route isn't there.
    await reset();
    onSleep = async () => { policy('pol-gw').enabled = false; };
    await assert.rejects(ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9'), (e) => e.code === 'GATEWAY_NOT_SYNCED');
    assert.equal(active(), 0);
});

test('the approval after the add is the real evaluation: a member taken out meanwhile is refused', async () => {
    await reset();
    onSleep = async () => {
        live['/api/groups/g-gwt'].resources = [];
        live['/api/networks/resources'][0].groups = [{ id: 'g-srv' }];
    };
    await assert.rejects(ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9'), (e) => e.code === 'GATEWAY_NOT_SYNCED');
    assert.equal(active(), 0);
});

test('every failed start frees its quota slot and issues no token', async () => {
    const start = () => ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    // The target group can't be read: nothing is written.
    await reset({ maxSessionsPerUser: 1 });
    live['/api/groups/g-gwt'] = null;
    await assert.rejects(start(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(active(), 0);
    assert.equal(groupWrites().length, 0);
    // The hold can't be recorded: nothing is written.
    await reset({ maxSessionsPerUser: 1 });
    holds.failWith((sql) => (/^\s*INSERT/i.test(sql) ? new Error('db down') : null));
    await assert.rejects(start(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(active(), 0);
    assert.equal(groupWrites().length, 0);
    // added_at can't be recorded before the write: the group is not written.
    await reset({ maxSessionsPerUser: 1 });
    holds.failWith((sql) => (/SET added_at/.test(sql) ? new Error('db down') : null));
    await assert.rejects(start(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(groupWrites().length, 0);
    assert.equal(active(), 0);
    // NetBird refuses the group write: the write is uncertain, new sessions wait.
    await reset({ maxSessionsPerUser: 1 });
    writeAnswer = { status: 500, raw: 'boom' };
    await assert.rejects(start(), (e) => e.code === 'TARGET_OPEN_FAILED');
    assert.equal(active(), 0);
    assert.equal(ra._internal.settlingForTest(), true);
    // Closed while it waited for the route (Remote Access turned off, a shutdown).
    await reset({ maxSessionsPerUser: 1 });
    onSleep = async () => { ra.closeAllSessions('turned off'); };
    await assert.rejects(start(), (e) => e.code === 'SESSION_CLOSED');
    assert.equal(active(), 0);
    // And the slot really is free: the next start opens.
    await reset({ maxSessionsPerUser: 1 });
    assert.ok((await start()).token);
    assert.equal(active(), 1);
});

test('a session to the same resource under a new address replaces its hold', async () => {
    await reset();
    holds.set('r1', { networkId: 'n1', address: '10.0.0.6/32', addedAt: Date.now() - 60_000, expiresAt: Date.now() + 50 * HOUR });
    await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    const row = holds.rows.get('r1');
    assert.equal(row.address, '10.0.0.5/32');
    assert.ok(new Date(row.expires_at).getTime() <= Date.now() + 10 * HOUR, 'a new hold, not the longer expiry of the old identity');
    // The same identity keeps the later expiry (GREATEST).
    const later = Date.now() + 30 * HOUR;
    row.expires_at = new Date(later);
    await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    assert.equal(new Date(holds.rows.get('r1').expires_at).getTime(), later);
});

// ─── The re-check ───
test('the re-check of an open session extends its hold; a hold for another identity is not touched', async () => {
    await reset({ holdHours: 2 });
    const out = await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    const soon = Date.now() + 60_000;
    holds.rows.get('r1').expires_at = new Date(soon);
    await ra._internal.loadTargetHolds();
    await ra.recheckSessions();
    assert.equal(ra.renewLease(viewer, out.sessionId), true, 'the session stays');
    const exp = new Date(holds.rows.get('r1').expires_at).getTime();
    assert.ok(exp > Date.now() + 2 * HOUR - 5000, 'raised to now + holdHours');
    assert.equal(ra._internal.holdsForTest().r1.expiresAt, exp, 'and in memory');
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
    const out = await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    // Taken out of the target group (the sync, or by hand): the session closes.
    live['/api/groups/g-gwt'].resources = [];
    live['/api/networks/resources'][0].groups = [{ id: 'g-srv' }];
    await ra.recheckSessions();
    assert.equal(ra.renewLease(viewer, out.sessionId), false);
});

test('the settings page lists the held servers, in use or with their expiry', async () => {
    await reset();
    await ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9');
    holds.set('r-dom', { networkId: 'n1', address: 'safe.example.com', expiresAt: Date.now() + HOUR });
    holds.set('r-old', { networkId: 'n1', address: '10.0.0.9/32', expiresAt: Date.now() - 1000 });
    await ra._internal.loadTargetHolds();
    const snap = await ra._internal.freshSnapshot(0);
    const held = ra._internal.heldTargets(snap);
    assert.deepEqual(held.map(h => [h.name, h.address, h.network, h.inUse]), [['srv1', '10.0.0.5/32', 'Office', true], ['Safe', 'safe.example.com', 'Office', false]], 'in use first; an expired hold is not listed');
    assert.ok(Date.parse(held[1].expiresAt) > Date.now());
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
    const pick = (p) => JSON.parse(JSON.stringify(live[p]));
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
    const v = ask(s, ro);
    assert.equal(v.code, 'TARGET_NOT_OPEN_READONLY');
    assert.match(ra._internal.MESSAGES.TARGET_NOT_OPEN_READONLY, /read-only/);
    const n = auth.evaluateNameAccess(s, { ...ro, gatewayGroupId: 'g-ngw', targetGroupId: 'g-ngwt' }, { userId: 'u1', name: 'safe.example.com', port: 22 });
    assert.equal(n.code, 'TARGET_NOT_OPEN_READONLY');
    s.resources[0].groups.push({ id: 'g-gwt' });
    assert.equal(ask(s, ro).ok, true);
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
