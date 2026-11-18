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
const writes = []; // [method, path, body] of every NetBird write
let writeAnswer = null; // a test's answer to a write, instead of 200
let afterWrite = null;  // runs after a write is applied
nb.netbirdReq = async (method, p, body) => {
    writes.push([method, p, JSON.parse(JSON.stringify(body ?? null))]);
    if (writeAnswer) return writeAnswer;
    // As in NetBird, a group write changes what the next read of that group returns.
    if (live && method === 'PUT' && p.startsWith('/api/groups/') && live[p]) {
        live[p] = { ...live[p], name: body.name, peers: body.peers.map(id => ({ id })), resources: body.resources };
    }
    if (afterWrite) afterWrite(p);
    return { status: 200, body: { id: 'ok' } };
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

test('the refused gateway subnets match netbird-docker-compose-files/docker-compose-remote-access.yml', () => {
    const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'netbird-docker-compose-files', 'docker-compose-remote-access.yml'), 'utf8');
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

// ─── Target sync ───
const MANAGED_IDS = { gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt' };
const targetGroup = (id, name, resources = [], peers = []) => ({ id, name, peers, resources });
const groupWrites = () => writes.filter(w => w[0] === 'PUT' && w[1].startsWith('/api/groups/'));

test('the target sync keeps the names target group off wildcard domain resources', async () => {
    live = {
        '/api/networks/resources': [
            { id: 'r-dom', type: 'domain', address: 'safe.example.com', groups: [] },
            { id: 'r-wild', type: 'domain', address: '*.corp.example', groups: [{ id: 'g-ngwt' }] },
            { id: 'r-wild2', type: 'domain', address: '*.new.example', groups: [] },
        ],
        '/api/networks': [{ id: 'n1', resources: ['r-dom', 'r-wild', 'r-wild2'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets', [{ id: 'r-wild', type: 'domain' }]),
    };
    writes.length = 0;
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    try {
        const out = await ra._internal.syncTargetGroup();
        assert.deepEqual(groupWrites(), [['PUT', '/api/groups/g-ngwt', { name: 'Browser Gateway Name Targets', peers: [], resources: [{ id: 'r-dom', type: 'domain' }] }]],
            'the exact name in, the wildcard out; the unchanged IP target group is not written');
        assert.deepEqual(out, { added: 1, removed: 1 });
    } finally { live = null; }
});

test('the target sync writes each target group once, however many resources a network has', async () => {
    const hosts = Array.from({ length: 825 }, (_, i) => ({ id: `r${i}`, type: 'host', address: `10.${Math.floor(i / 250)}.${i % 250}.1/32`, groups: [] }));
    const resources = [...hosts, { id: 'r-sub', type: 'subnet', address: '192.0.2.0/24', groups: [] }, { id: 'r-bare', type: 'host', address: '198.51.100.7', groups: [] }];
    live = {
        '/api/networks/resources': resources,
        '/api/networks': [{ id: 'n-clients', resources: resources.map(r => r.id) }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [], [{ id: 'p-stray' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    };
    ra._internal.setManagedForTest(MANAGED_IDS);
    const audits = [];
    ra.setRemoteAccessDeps({ recordAudit: (e) => { audits.push(e); } });
    try {
        // Opening the network: one write for all of it, no write per resource.
        writes.length = 0;
        ra._internal.setConfigForTest({ enabled: true, networks: ['n-clients'] });
        const opened = await ra._internal.syncTargetGroup();
        assert.equal(writes.length, 1, 'one NetBird write in total');
        const [, p, body] = writes[0];
        assert.equal(p, '/api/groups/g-gwt');
        assert.equal(body.resources.length, 827);
        assert.deepEqual(body.resources.slice(-2), [{ id: 'r-sub', type: 'subnet' }, { id: 'r-bare', type: 'host' }], "each resource with NetBird's type for it");
        assert.deepEqual(body.peers, [], 'a target group holds resources only: a stray device is taken out, never written back');
        assert.deepEqual(opened, { added: 827, removed: 0 });
        await new Promise(r => setImmediate(r));
        const update = audits.find(a => a.action === 'remote_access.targets_update');
        assert.deepEqual([update.target, update.meta.added, update.meta.removed, update.meta.addedIds.length], ['Browser Gateway Targets', 827, 0, 50], 'which resources changed is audited');
        assert.ok(audits.some(a => a.action === 'remote_access.member_remove' && a.target === 'p-stray'), 'the device taken out is audited like the clean-up does');

        // Already in place: nothing is written.
        live['/api/groups/g-gwt'] = targetGroup('g-gwt', 'Browser Gateway Targets', body.resources);
        writes.length = 0;
        assert.deepEqual(await ra._internal.syncTargetGroup(), { added: 0, removed: 0 });
        assert.equal(writes.length, 0);

        // Closing it: one write empties the group.
        writes.length = 0;
        ra._internal.setConfigForTest({ enabled: true, networks: [] });
        const closed = await ra._internal.syncTargetGroup();
        assert.deepEqual(writes, [['PUT', '/api/groups/g-gwt', { name: 'Browser Gateway Targets', peers: [], resources: [] }]]);
        assert.deepEqual(closed, { added: 0, removed: 827 });
    } finally { live = null; }
});

test('a resource whose type changed is written again, with the same members', async () => {
    live = {
        '/api/networks/resources': [{ id: 'r1', type: 'subnet', address: '10.0.0.0/24', groups: [] }], // was a /32 host
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    };
    writes.length = 0;
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    try {
        assert.deepEqual(await ra._internal.syncTargetGroup(), { added: 0, removed: 0 });
        assert.deepEqual(groupWrites().map(w => w[2].resources), [[{ id: 'r1', type: 'subnet' }]]);
    } finally { live = null; }
});

test('a sync that fails after writing one group says that group was updated', async () => {
    live = {
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': null, // unreadable
    };
    writes.length = 0;
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    try {
        await assert.rejects(ra._internal.syncTargetGroup(),
            (e) => /^The "Browser Gateway Targets" group was updated, then: Couldn't read the group/.test(e.message) && !/nothing was changed/.test(e.message));
        assert.equal(groupWrites().length, 1);
    } finally { live = null; }
});

test('a resource changed in NetBird between the read and the write is corrected in the same sync', async () => {
    const dom = { id: 'r-dom', type: 'domain', address: 'safe.example.com', groups: [] };
    live = {
        '/api/networks/resources': [dom],
        '/api/networks': [{ id: 'n1', resources: ['r-dom'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    };
    // Someone makes the exact name a wildcard in the NetBird dashboard right after the read.
    afterWrite = () => { live['/api/networks/resources'] = [{ ...dom, address: '*.example.com' }]; afterWrite = null; };
    writes.length = 0;
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    try {
        await ra._internal.syncTargetGroup();
        assert.deepEqual(groupWrites().map(w => w[2].resources.map(r => r.id)), [['r-dom'], []], 'the second pass takes the wildcard out');
        assert.deepEqual(live['/api/groups/g-ngwt'].resources, []);
    } finally { live = null; afterWrite = null; }
});

test('a resource read without its type changes nothing', async () => {
    live = {
        '/api/networks/resources': [{ id: 'r1', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    };
    writes.length = 0;
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), (e) => e.message === "Couldn't read the networks from NetBird in full.");
        assert.equal(writes.length, 0);
    } finally { live = null; }
});

test('a read that fails after a write says what was written and holds new sessions back', async () => {
    const r1 = { id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] };
    live = {
        '/api/networks/resources': [r1],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    };
    afterWrite = () => { live['/api/networks/resources'] = [{ ...r1, type: '' }]; afterWrite = null; };
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    ra._internal.resetSettlingForTest();
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), (e) => /^The "Browser Gateway Targets" group was updated, then: Couldn't read the networks/.test(e.message));
        assert.equal(ra._internal.settlingForTest(), true);
    } finally { live = null; afterWrite = null; ra._internal.resetSettlingForTest(); }
});

test('a difference still there after the second write holds new sessions back', async () => {
    const dom = { id: 'r-dom', type: 'domain', address: 'safe.example.com', groups: [] };
    live = {
        '/api/networks/resources': [dom],
        '/api/networks': [{ id: 'n1', resources: ['r-dom'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    };
    // NetBird keeps changing under each write: the name flips between exact and wildcard.
    let n = 0;
    afterWrite = () => { live['/api/networks/resources'] = [{ ...dom, address: n++ % 2 ? 'safe.example.com' : '*.example.com' }]; };
    writes.length = 0;
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    ra._internal.resetSettlingForTest();
    try {
        await ra._internal.syncTargetGroup();
        assert.equal(groupWrites().length, 2, 'two writes at most');
        assert.equal(ra._internal.settlingForTest(), true, 'the check after them found a difference');
    } finally { live = null; afterWrite = null; ra._internal.resetSettlingForTest(); }
});

test('a group write answered with an error of any kind counts as uncertain', async () => {
    live = {
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    };
    writeAnswer = { status: 404, raw: 'user not found' }; // can follow a saved group in NetBird
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    ra._internal.resetSettlingForTest();
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), /user not found/);
        assert.equal(ra._internal.settlingForTest(), true);
    } finally { live = null; writeAnswer = null; ra._internal.resetSettlingForTest(); }
});

test('the target sync writes nothing when a target group cannot be read in full', async () => {
    live = {
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': { id: 'g-gwt', name: 'Browser Gateway Targets', peers: [] }, // no resources field
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    };
    writes.length = 0;
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest(MANAGED_IDS);
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), /Couldn't read the group/);
        assert.equal(writes.length, 0);
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
