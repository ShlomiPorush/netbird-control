// What browser remote access may connect to, whatever resources and policies say:
//   - special addresses (loopback, link-local, NetBird peers, multicast, reserved) and the
//     gateways' own Docker networks are never targets, typed or looked up;
//   - only exact domain resources are targets on the names gateway, never a wildcard, and a live
//     session that went through one ends at the next re-check;
//   - the gateway's reach counts a rule whose source is the gateway peer itself, and a rule source
//     it can't read blocks every session;
//   - a Browser Gateway peer never counts as a network's routing peer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ─── Stubs, before lib/remote-access.js destructures them ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] || null;
core.setSetting = async (k, v) => { settings[k] = v; };
core.pool.query = async () => ({ rows: [] });
const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
let live = null; // the NetBird answers for the session tests, by path
let routersHook = null; // runs while a session's router read is in flight
nb.netbirdGet = async (p) => {
    if (routersHook && p.endsWith('/routers')) await routersHook();
    return JSON.parse(JSON.stringify((live && live[p]) ?? null));
};
const events = require('../lib/events');
events.addEvent = async () => { };

const auth = require('../lib/remote-access-auth');
const { evaluateUserAccess, evaluateNameAccess, gatewayReach, pathStatus, GATEWAY_INTERNAL_SUBNETS } = auth;
const ra = require('../lib/remote-access');
const { resolveTarget, MESSAGES } = ra._internal;

const NOW = Date.parse('2026-11-05T12:00:00Z');

function base() {
    return {
        users: [{ id: 'u1', auto_groups: ['g-staff'], is_blocked: false }],
        peers: [
            { id: 'p-gw', name: 'gw', groups: [{ id: 'g-gw' }, { id: 'g-all' }], connected: true },
            { id: 'p-ngw', name: 'ngw', groups: [{ id: 'g-ngw' }, { id: 'g-all' }], connected: true },
            { id: 'p-r1', name: 'router', groups: [{ id: 'g-all' }], connected: true },
        ],
        groups: [
            { id: 'g-all', name: 'All', peers: [{ id: 'p-gw' }, { id: 'p-ngw' }, { id: 'p-r1' }] },
            { id: 'g-gw', name: 'Browser Gateway', peers: [{ id: 'p-gw' }] }, { id: 'g-gwt', name: 'Browser Gateway Targets' },
            { id: 'g-ngw', name: 'Browser Gateway Names', peers: [{ id: 'p-ngw' }] }, { id: 'g-ngwt', name: 'Browser Gateway Name Targets' },
            { id: 'g-staff', name: 'Staff' },
        ],
        networks: [{ id: 'n1', name: 'Office', resources: ['r-wide', 'r-dom', 'r-wild', 'r-special'] }, { id: 'n2', name: 'Closed', resources: ['r-narrow'] }],
        resources: [
            { id: 'r-wide', name: 'office', type: 'subnet', address: '10.20.0.0/16', enabled: true, groups: [{ id: 'g-gwt' }] },
            { id: 'r-dom', name: 'Safe', type: 'domain', address: 'safe.example.com', enabled: true, groups: [{ id: 'g-ngwt' }] },
            { id: 'r-wild', name: 'Corp', type: 'domain', address: '*.corp.example', enabled: true, groups: [{ id: 'g-ngwt' }] },
            { id: 'r-special', name: 'everything', type: 'subnet', address: '0.0.0.0/0', enabled: true, groups: [{ id: 'g-gwt' }] },
            { id: 'r-narrow', name: 'other', type: 'host', address: '10.20.7.7/32', enabled: true, groups: [] },
        ],
        policies: [
            { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
            { id: 'pol-ngw', name: 'Browser Gateway (Names)', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-ngw' }], destinations: [{ id: 'g-ngwt' }] }] },
            { id: 'pol-staff', name: 'Staff', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: [], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-gwt' }, { id: 'g-ngwt' }] }] },
        ],
        routes: [],
        grants: [],
    };
}
const MANAGED = ['pol-gw', 'pol-ngw'];
const IP = { networks: ['n1'], gatewayGroupId: 'g-gw', gatewayGroupIds: ['g-gw', 'g-ngw'], managedPolicyIds: MANAGED };
const NAMES = { networks: ['n1'], gatewayGroupId: 'g-ngw', gatewayGroupIds: ['g-gw', 'g-ngw'], managedPolicyIds: MANAGED };
const ip = (snap, address, port = 3389) => evaluateUserAccess(snap, IP, { userId: 'u1', address, port, now: NOW });
const name = (snap, n, port = 3389) => evaluateNameAccess(snap, NAMES, { userId: 'u1', name: n, port, now: NOW });

// ─── Special addresses ───
test('special and gateway-local addresses are refused before any resource match, at each range edge', () => {
    const s = base(); // a 0.0.0.0/0 resource that the user may reach covers every one of them
    const refused = ['0.0.0.0', '0.255.255.255', '127.0.0.1', '127.255.255.255', '169.254.0.1', '169.254.169.254',
        '100.64.0.0', '100.92.0.1', '100.127.255.255', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
        '172.31.250.2', '172.31.250.3', '172.31.251.9'];
    for (const a of refused) {
        const v = ip(s, a);
        assert.equal(v.code, 'ADDRESS_NOT_ALLOWED', a);
        assert.equal(v.resource, undefined, `${a}: refused before any resource is chosen`);
    }
    for (const a of ['1.0.0.0', '126.255.255.255', '128.0.0.1', '169.253.255.255', '100.63.255.255', '100.128.0.0', '223.255.255.255', '172.31.249.1', '172.31.252.1']) {
        assert.notEqual(ip(s, a).code, 'ADDRESS_NOT_ALLOWED', a);
    }
    assert.equal(ip(s, '10.20.0.9').ok, true, 'an ordinary address still opens');
});

test('a name the server looks up is refused when it resolves to such an address', async () => {
    const s = base();
    const lookup = async () => ['127.0.0.1'];
    const r = await resolveTarget(s, 'u1', 'loop.elsewhere.test', 22, { ipCfg: IP, namesCfg: NAMES, resolve4: lookup });
    assert.equal(r.ok, false);
    assert.equal(r.verdict.code, 'ADDRESS_NOT_ALLOWED');
    const mixed = await resolveTarget(s, 'u1', 'mixed.elsewhere.test', 22, { ipCfg: IP, namesCfg: NAMES, resolve4: async () => ['100.70.0.1', '10.20.0.9'] });
    assert.equal(mixed.ok, true);
    assert.equal(mixed.address, '10.20.0.9', 'only an allowed answer is ever used');
    assert.equal(MESSAGES.ADDRESS_NOT_ALLOWED.length > 0, true);
});

test('the refused gateway subnets match docker-compose.remote-access.yml', () => {
    const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.remote-access.yml'), 'utf8');
    const subnets = [...compose.matchAll(/^\s*-\s*subnet:\s*([0-9./]+)\s*$/gm)].map(m => m[1]);
    assert.ok(subnets.length >= 2, 'the compose file still declares its networks');
    for (const sn of subnets) assert.ok(GATEWAY_INTERNAL_SUBNETS.includes(sn), `${sn} is refused as a target`);
});

// ─── Wildcard domain resources ───
test('a name only a wildcard domain resource covers is refused and never looked up; exact ones still open', async () => {
    const s = base();
    assert.equal(name(s, 'anything.corp.example').code, 'WILDCARD_DOMAIN_NOT_ALLOWED');
    assert.equal(name(s, 'a.b.corp.example').code, 'WILDCARD_DOMAIN_NOT_ALLOWED');
    let looked = 0;
    const r = await resolveTarget(s, 'u1', 'anything.corp.example', 3389, { ipCfg: IP, namesCfg: NAMES, resolve4: async () => { looked++; return ['10.20.0.9']; } });
    assert.equal(r.ok, false);
    assert.equal(r.verdict.code, 'WILDCARD_DOMAIN_NOT_ALLOWED');
    assert.equal(looked, 0, 'no fallback to the IP path');
    assert.equal(name(s, 'safe.example.com').ok, true);
    // An exact resource below the wildcard is a target in its own right.
    s.resources.push({ id: 'r-exact', name: 'db', type: 'domain', address: 'db.corp.example', enabled: true, groups: [{ id: 'g-ngwt' }] });
    s.networks[0].resources.push('r-exact');
    const v = name(s, 'db.corp.example');
    assert.equal(v.ok, true);
    assert.equal(v.resource.id, 'r-exact');
});

test('the target sync keeps the names target group off wildcard domain resources', async () => {
    live = {
        '/api/networks/resources': [
            { id: 'r-dom', address: 'safe.example.com', groups: [] },
            { id: 'r-wild', address: '*.corp.example', groups: [{ id: 'g-ngwt' }] },
            { id: 'r-wild2', address: '*.new.example', groups: [] },
        ],
        '/api/networks': [{ id: 'n1', resources: ['r-dom', 'r-wild', 'r-wild2'] }],
    };
    const calls = [];
    ra.setRemoteAccessDeps({
        addResourceGroups: async (n, r, g) => { calls.push(['add', r, ...g]); return true; },
        removeResourceGroups: async (n, r, g) => { calls.push(['remove', r, ...g]); return true; },
    });
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt' });
    try {
        await ra._internal.syncTargetGroup();
        assert.deepEqual(calls.sort(), [['add', 'r-dom', 'g-ngwt'], ['remove', 'r-wild', 'g-ngwt']]);
    } finally { live = null; }
});

// ─── Gateway reach ───
const gatewaySourced = (sourceExtra) => ({
    id: 'pol-odd', name: 'Gateway to the closed network', enabled: true,
    rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ...sourceExtra, destinations: [], destinationResource: { id: 'r-narrow', type: 'host' } }],
});

test('a rule whose source is the gateway peer counts as gateway reach on both paths', () => {
    for (const shape of [{ sources: [], sourceResource: { id: 'p-gw', type: 'peer' } }, { sources: null, sourceResource: { id: 'p-gw', type: 'peer' } }, { sourceResource: { id: 'p-gw', type: 'peer' } }]) {
        const s = base();
        s.policies.push(gatewaySourced(shape));
        assert.equal(ip(s, '10.20.7.7').code, 'AMBIGUOUS_ROUTE', JSON.stringify(shape));
        assert.ok(gatewayReach(s, IP).entries.some(e => e.id === 'r-narrow'));
    }
    const s = base();
    s.policies.push(gatewaySourced({ sourceResource: { id: 'p-ngw', type: 'peer' } }));
    assert.equal(name(s, 'safe.example.com').code, 'NAMES_GATEWAY_EXTRA_REACH');
});

test('a rule from another peer changes nothing; a source that cannot be read blocks every session', () => {
    const other = base();
    other.policies.push(gatewaySourced({ sourceResource: { id: 'p-r1', type: 'peer' } }));
    assert.equal(ip(other, '10.20.7.7').ok, true);
    for (const shape of [
        { sourceResource: { id: 'r-wide', type: 'subnet' } },
        { sourceResource: { type: 'peer' } },
        { sourceResource: { id: 'p-r1' } },
        { sources: { id: 'g-staff' } },
    ]) {
        const s = base();
        s.policies.push(gatewaySourced(shape));
        assert.equal(ip(s, '10.20.0.9').code, 'GATEWAY_REACH_UNKNOWN', JSON.stringify(shape));
        assert.equal(name(s, 'safe.example.com').code, 'GATEWAY_REACH_UNKNOWN', JSON.stringify(shape));
        assert.equal(pathStatus(s, IP, [{ peer: 'p-r1', enabled: true }]).code, 'GATEWAY_REACH_UNKNOWN');
    }
    // Disabled and drop rules never add reach, readable or not.
    const off = base();
    off.policies.push({ ...gatewaySourced({ sourceResource: { id: 'x', type: 'subnet' } }), enabled: false });
    off.policies.push({ id: 'pol-drop', name: 'drop', enabled: true, rules: [{ enabled: true, action: 'drop', protocol: 'tcp', sourceResource: { id: 'x', type: 'subnet' }, destinationResource: { id: 'r-narrow' } }] });
    assert.equal(ip(off, '10.20.0.9').ok, true);
});

// ─── Routing peers ───
test('a Browser Gateway peer never counts as a routing peer', () => {
    const s = base();
    s.peers.find(p => p.id === 'p-r1').connected = false;
    assert.equal(pathStatus(s, IP, [{ peer: 'p-r1', enabled: true }]).code, 'NO_ROUTER_ONLINE');
    assert.equal(pathStatus(s, IP, [{ peer: 'p-gw', enabled: true }]).code, 'NO_ROUTER_ONLINE');
    assert.equal(pathStatus(s, IP, [{ peer: 'p-ngw', enabled: true }]).code, 'NO_ROUTER_ONLINE', 'nor the other gateway');
    assert.equal(pathStatus(s, IP, [{ peer_groups: ['g-gw'], enabled: true }]).code, 'NO_ROUTER_ONLINE');
    assert.equal(pathStatus(s, IP, [{ peer_groups: ['g-all'], enabled: true }]).code, 'NO_ROUTER_ONLINE');
    s.peers.find(p => p.id === 'p-r1').connected = true;
    assert.equal(pathStatus(s, IP, [{ peer_groups: ['g-all'], enabled: true }]).ok, true);
});

// ─── A live session through a wildcard ends at the next re-check ───
test('a live names session whose resource is now a wildcard is closed by the re-check', async () => {
    const s = base();
    s.resources.push({ id: 'r-a', name: 'A', type: 'domain', address: 'a.corp.example', enabled: true, groups: [{ id: 'g-ngwt' }] });
    s.networks[0].resources.push('r-a');
    const snapLive = () => ({
        '/api/users': s.users, '/api/peers': s.peers, '/api/groups': s.groups, '/api/policies': s.policies,
        '/api/networks/resources': s.resources, '/api/networks': s.networks, '/api/routes': [], '/api/networks/n1/routers': [{ peer: 'p-r1', enabled: true }],
    });
    live = snapLive();
    settings.remote_access_config = JSON.stringify({ enabled: true, networks: ['n1'] });
    settings.remote_access_nb = JSON.stringify({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' });
    await ra.loadRemoteAccessConfig();
    ra._internal.resetSettlingForTest();
    const viewer = { user_id: 'u1', email: 'a@example.test' };
    try {
        const out = await ra.createSession(viewer, { protocol: 'ssh', address: 'a.corp.example', port: 22, username: 'alice' }, '203.0.113.9');
        assert.equal(out.gateway, 'names');
        // The resource that served it becomes a wildcard (as one opened before this change was).
        s.resources.find(r => r.id === 'r-a').address = '*.a-host.corp.example';
        live = snapLive();
        assert.equal(name(s, 'a.corp.example', 22).code, 'WILDCARD_DOMAIN_NOT_ALLOWED', 'only the wildcard covers the name now');
        await ra.recheckSessions();
        assert.equal(ra.renewLease(viewer, out.sessionId), false, 'the session was closed');
    } finally {
        ra.closeAllSessions('test over');
        live = null;
    }
});

test('a session whose checks were already running is not approved when settling starts meanwhile', async () => {
    const s = base();
    live = {
        '/api/users': s.users, '/api/peers': s.peers, '/api/groups': s.groups, '/api/policies': s.policies,
        '/api/networks/resources': s.resources, '/api/networks': s.networks, '/api/routes': [], '/api/networks/n1/routers': [{ peer: 'p-r1', enabled: true }],
    };
    settings.remote_access_config = JSON.stringify({ enabled: true, networks: ['n1'] });
    settings.remote_access_nb = JSON.stringify({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' });
    await ra.loadRemoteAccessConfig();
    ra._internal.resetSettlingForTest();
    ra._internal.invalidateSnapshot();
    const viewer = { user_id: 'u1', email: 'a@example.test' };
    // An unanswered resource write starts settling while the router read is still running.
    routersHook = async () => { routersHook = null; ra.noteUncertainTargetWrite(); };
    try {
        await assert.rejects(ra.createSession(viewer, { protocol: 'rdp', address: '10.20.0.9', port: 3389 }, '203.0.113.9'), (e) => e.code === 'TARGETS_SETTLING');
        ra._internal.resetSettlingForTest();
        routersHook = async () => { routersHook = null; ra.noteUncertainTargetWrite(); };
        const check = await ra.checkAccess(viewer, { protocol: 'rdp', address: '10.20.0.9', port: 3389 });
        assert.equal(check.steps[0].code, 'TARGETS_SETTLING');
        // A target change (a finished sync) while the router read runs: the snapshot is no longer current.
        ra._internal.resetSettlingForTest();
        routersHook = async () => { routersHook = null; ra._internal.invalidateSnapshot(); };
        await assert.rejects(ra.createSession(viewer, { protocol: 'rdp', address: '10.20.0.9', port: 3389 }, '203.0.113.9'), (e) => e.code === 'TARGETS_SETTLING');
        const ok = await ra.createSession(viewer, { protocol: 'rdp', address: '10.20.0.9', port: 3389 }, '203.0.113.9');
        assert.ok(ok.sessionId, 'a retry with a current snapshot opens');
    } finally {
        routersHook = null;
        ra._internal.resetSettlingForTest();
        ra.closeAllSessions('test over');
        live = null;
    }
});
