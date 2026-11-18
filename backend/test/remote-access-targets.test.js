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
const holds = require('./helpers/hold-table').holdTable();
core.pool.query = holds.query;
const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
let live = null; // the NetBird answers for the session tests, by path
let routersHook = null; // runs while a session's router read is in flight
let getHook = null; // runs before each read
nb.netbirdGet = async (p) => {
    if (getHook) await getHook(p);
    if (routersHook && p.endsWith('/routers')) await routersHook();
    return JSON.parse(JSON.stringify((live && live[p]) ?? null));
};
const writes = []; // [method, path, body] of every NetBird write
let writeAnswer = null; // a test's answer to a write, instead of 200
let afterWrite = null;  // runs after a write is applied
const resourceAt = (p) => {
    const m = /^\/api\/networks\/[^/]+\/resources\/([^/]+)$/.exec(p);
    return m && live && (live['/api/networks/resources'] || []).find(r => r && r.id === m[1]);
};
nb.netbirdReq = async (method, p, body) => {
    if (method === 'GET') {
        const r = resourceAt(p);
        return r ? { status: 200, body: JSON.parse(JSON.stringify(r)) } : { status: 404, body: null };
    }
    writes.push([method, p, JSON.parse(JSON.stringify(body ?? null))]);
    if (writeAnswer) return writeAnswer;
    // As in NetBird, a group write changes what the next read of that group returns.
    if (live && method === 'PUT' && p.startsWith('/api/groups/') && live[p]) {
        live[p] = { ...live[p], name: body.name, peers: body.peers.map(id => ({ id })), resources: body.resources };
    }
    // A resource write: its groups, and the target group's list (one relation in NetBird).
    const res = method === 'PUT' && resourceAt(p);
    if (res) {
        res.groups = body.groups.map(id => ({ id }));
        for (const gp of ['/api/groups/g-gwt', '/api/groups/g-ngwt']) {
            if (!live[gp]) continue;
            const gid = gp.slice('/api/groups/'.length);
            const others = live[gp].resources.filter(x => x.id !== res.id);
            live[gp] = { ...live[gp], resources: body.groups.includes(gid) ? [...others, { id: res.id, type: res.type }] : others };
        }
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
            { id: 'g-staff', name: 'Staff' }, { id: 'g-srv', name: 'Servers' },
        ],
        networks: [{ id: 'n1', name: 'Office', resources: ['r-wide', 'r-dom', 'r-wild', 'r-special'] }, { id: 'n2', name: 'Closed', resources: ['r-narrow'] }],
        resources: [
            { id: 'r-wide', name: 'office', type: 'subnet', address: '10.20.0.0/16', enabled: true, groups: [{ id: 'g-gwt' }, { id: 'g-srv' }] },
            { id: 'r-dom', name: 'Safe', type: 'domain', address: 'safe.example.com', enabled: true, groups: [{ id: 'g-ngwt' }, { id: 'g-srv' }] },
            { id: 'r-wild', name: 'Corp', type: 'domain', address: '*.corp.example', enabled: true, groups: [{ id: 'g-ngwt' }, { id: 'g-srv' }] },
            { id: 'r-special', name: 'everything', type: 'subnet', address: '0.0.0.0/0', enabled: true, groups: [{ id: 'g-gwt' }, { id: 'g-srv' }] },
            { id: 'r-narrow', name: 'other', type: 'host', address: '10.20.7.7/32', enabled: true, groups: [] },
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
    s.resources.push({ id: 'r-exact', name: 'db', type: 'domain', address: 'db.corp.example', enabled: true, groups: [{ id: 'g-ngwt' }, { id: 'g-srv' }] });
    s.networks[0].resources.push('r-exact');
    const v = name(s, 'db.corp.example');
    assert.equal(v.ok, true);
    assert.equal(v.resource.id, 'r-exact');
});

// ─── Target sync ───
// NetBird is the source of truth: the sync keeps the members that pass the rule (open network,
// qualifying address, a valid hold for the resource's current network and address), takes every
// other member out, and never adds one.
const MANAGED_IDS = { gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt' };
const targetGroup = (id, name, resources = [], peers = []) => ({ id, name, peers, resources });
const groupWrites = () => writes.filter(w => w[0] === 'PUT' && w[1].startsWith('/api/groups/'));
const HOUR = 3_600_000;
const hold = (id, networkId, address, expiresAt = Date.now() + HOUR) => holds.set(id, { networkId, address, expiresAt });
function syncSetup(liveData, cfg = { enabled: true, networks: ['n1'] }) {
    live = liveData;
    writes.length = 0;
    holds.clear();
    ra._internal.setConfigForTest(cfg);
    ra._internal.setManagedForTest(MANAGED_IDS);
}

test('the target sync takes wildcard domain resources out and never adds a resource, held or not', async () => {
    syncSetup({
        '/api/networks/resources': [
            { id: 'r-dom', type: 'domain', address: 'safe.example.com', groups: [{ id: 'g-ngwt' }] },
            { id: 'r-wild', type: 'domain', address: '*.corp.example', groups: [{ id: 'g-ngwt' }] },
            { id: 'r-held', type: 'domain', address: 'held.example.com', groups: [] },
            { id: 'r-plain', type: 'domain', address: 'plain.example.com', groups: [] },
        ],
        '/api/networks': [{ id: 'n1', resources: ['r-dom', 'r-wild', 'r-held', 'r-plain'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets', [{ id: 'r-dom', type: 'domain' }, { id: 'r-wild', type: 'domain' }]),
    });
    hold('r-dom', 'n1', 'safe.example.com');
    hold('r-wild', 'n1', '*.corp.example');
    hold('r-held', 'n1', 'held.example.com'); // a hold, but not a member: stale
    try {
        const out = await ra._internal.syncTargetGroup();
        assert.deepEqual(groupWrites(), [['PUT', '/api/groups/g-ngwt', { name: 'Browser Gateway Name Targets', peers: [], resources: [{ id: 'r-dom', type: 'domain' }] }]],
            'the held exact name stays, the wildcard goes, nothing is added; the unchanged IP target group is not written');
        assert.deepEqual(out, { removed: 1 });
        assert.deepEqual([...holds.rows.keys()], ['r-dom'], 'the holds of resources that are not members are deleted');
        assert.deepEqual(Object.keys(ra._internal.holdsForTest()), ['r-dom']);
    } finally { live = null; }
});

test('the first sync after 1.4.x drains the network-wide membership in one write', async () => {
    const hosts = Array.from({ length: 825 }, (_, i) => ({ id: `r${i}`, type: 'host', address: `10.${Math.floor(i / 250)}.${i % 250}.1/32`, groups: [] }));
    const resources = [...hosts, { id: 'r-sub', type: 'subnet', address: '192.0.2.0/24', groups: [] }, { id: 'r-bare', type: 'host', address: '198.51.100.7', groups: [] }];
    const members = resources.map(r => ({ id: r.id, type: r.type }));
    syncSetup({
        '/api/networks/resources': resources,
        '/api/networks': [{ id: 'n-clients', resources: resources.map(r => r.id) }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', members, [{ id: 'p-stray' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    }, { enabled: true, networks: ['n-clients'] });
    const audits = [];
    ra.setRemoteAccessDeps({ recordAudit: (e) => { audits.push(e); } });
    try {
        // No holds yet: one write takes every resource (and the stray device) out.
        const drained = await ra._internal.syncTargetGroup();
        assert.equal(writes.length, 1, 'one NetBird write in total');
        assert.deepEqual(writes[0], ['PUT', '/api/groups/g-gwt', { name: 'Browser Gateway Targets', peers: [], resources: [] }]);
        assert.deepEqual(drained, { removed: 827 });
        await new Promise(r => setImmediate(r));
        const update = audits.find(a => a.action === 'remote_access.targets_update');
        assert.deepEqual([update.target, update.meta.removed, update.meta.removedIds.length], ['Browser Gateway Targets', 827, 50], 'which resources were taken out is audited');
        assert.ok(audits.some(a => a.action === 'remote_access.member_remove' && a.target === 'p-stray'), 'the device taken out is audited like the clean-up does');

        // Already right: nothing is written.
        writes.length = 0;
        assert.deepEqual(await ra._internal.syncTargetGroup(), { removed: 0 });
        assert.equal(writes.length, 0);

        // Held members stay, in one write that takes the others out; a held non-member is not added.
        live['/api/groups/g-gwt'] = targetGroup('g-gwt', 'Browser Gateway Targets', members.slice(0, 3).concat(members.slice(-2)));
        hold('r1', 'n-clients', '10.0.1.1/32');
        hold('r-sub', 'n-clients', '192.0.2.0/24');
        hold('r-bare', 'n-clients', '198.51.100.7/32'); // NetBird's address without the /32: the same address
        hold('r700', 'n-clients', '10.2.200.1/32'); // not a member
        writes.length = 0;
        assert.deepEqual(await ra._internal.syncTargetGroup(), { removed: 2 });
        assert.deepEqual(writes.map(w => w[2].resources), [[{ id: 'r1', type: 'host' }, { id: 'r-sub', type: 'subnet' }, { id: 'r-bare', type: 'host' }]]);
        assert.deepEqual([...holds.rows.keys()].sort(), ['r-bare', 'r-sub', 'r1']);

        // Closing the network: one write empties the group, and the holds go.
        writes.length = 0;
        ra._internal.setConfigForTest({ enabled: true, networks: [] });
        assert.deepEqual(await ra._internal.syncTargetGroup(), { removed: 3 });
        assert.deepEqual(writes, [['PUT', '/api/groups/g-gwt', { name: 'Browser Gateway Targets', peers: [], resources: [] }]]);
        assert.equal(holds.rows.size, 0);
    } finally { live = null; ra.setRemoteAccessDeps({ recordAudit: null }); }
});

test('a hold keeps its resource only while it is valid and still describes the resource', async () => {
    const res = [
        { id: 'r-ok', type: 'host', address: '10.0.0.1/32' },
        { id: 'r-expired', type: 'host', address: '10.0.0.2/32' },
        { id: 'r-moved', type: 'host', address: '10.0.0.3/32' },
        { id: 'r-readdressed', type: 'host', address: '10.0.0.40/32' },
    ];
    syncSetup({
        '/api/networks/resources': res,
        '/api/networks': [{ id: 'n1', resources: ['r-ok', 'r-expired', 'r-readdressed'] }, { id: 'n9', resources: ['r-moved'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', res.map(r => ({ id: r.id, type: r.type }))),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    }, { enabled: true, networks: ['n1', 'n9'] });
    hold('r-ok', 'n1', '10.0.0.1/32');
    hold('r-expired', 'n1', '10.0.0.2/32', Date.now() - 1000);
    hold('r-moved', 'n1', '10.0.0.3/32'); // its network is another one now
    hold('r-readdressed', 'n1', '10.0.0.4/32'); // its address changed in NetBird
    try {
        await ra._internal.syncTargetGroup();
        assert.deepEqual(groupWrites().map(w => w[2].resources), [[{ id: 'r-ok', type: 'host' }]]);
        assert.deepEqual([...holds.rows.keys()], ['r-ok'], 'expired holds and holds without membership are deleted');
    } finally { live = null; }
});

test('a hold that a session raised during the sync is not deleted', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.1/32' }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    hold('r1', 'n1', '10.0.0.1/32', Date.now() - 1000);
    // Another instance starts a session to it after this sync read the holds.
    const later = Date.now() + HOUR;
    getHook = async (p) => { if (p === '/api/groups/g-ngwt') holds.set('r1', { networkId: 'n1', address: '10.0.0.1/32', expiresAt: later, updatedAt: Date.now() }); };
    try {
        await ra._internal.syncTargetGroup();
        assert.equal(new Date(holds.rows.get('r1').expires_at).getTime(), later);
    } finally { getHook = null; live = null; }
});

test('a member that another instance added after the sync started keeps its target', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.1/32' }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    // The other instance wrote r1's hold, then added r1, after this sync first read the holds: the
    // group read already shows r1.
    getHook = async (p) => { if (p === '/api/groups/g-gwt' && !holds.rows.has('r1')) holds.set('r1', { networkId: 'n1', address: '10.0.0.1/32', expiresAt: Date.now() + HOUR, updatedAt: Date.now() }); };
    try {
        await ra._internal.syncTargetGroup();
        assert.deepEqual(groupWrites(), [], 'not taken out');
        assert.ok(holds.rows.has('r1'));
    } finally { getHook = null; live = null; }
});

test('a resource that another instance created and opened after the sync started keeps its target', async () => {
    syncSetup({
        '/api/networks/resources': [],
        '/api/networks': [{ id: 'n1', resources: [] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    // Before the group read: the resource now exists, its hold is written, and it is a member.
    getHook = async (p) => {
        if (p !== '/api/groups/g-gwt' || holds.rows.has('r-new')) return;
        live['/api/networks/resources'] = [{ id: 'r-new', type: 'host', address: '10.0.0.9/32' }];
        live['/api/networks'] = [{ id: 'n1', resources: ['r-new'] }];
        live['/api/groups/g-gwt'] = targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r-new', type: 'host' }]);
        holds.set('r-new', { networkId: 'n1', address: '10.0.0.9/32', expiresAt: Date.now() + HOUR, updatedAt: Date.now() });
    };
    try {
        await ra._internal.syncTargetGroup();
        assert.deepEqual(groupWrites(), [], 'judged from the resources read after the group');
    } finally { getHook = null; live = null; }
});

test('a hold read that fails while a group is compared writes nothing for that group', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.1/32' }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    let reads = 0;
    holds.failWith((sql) => (/^\s*SELECT/i.test(sql) && ++reads === 1 ? new Error('db down') : null)); // the read after the group read
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), /db down/);
        assert.deepEqual(groupWrites(), []);
    } finally { live = null; }
});

test('a new hold without membership survives the sync for 10 minutes; an expired one goes at once', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.1/32' }, { id: 'r2', type: 'host', address: '10.0.0.2/32' }, { id: 'r3', type: 'host', address: '10.0.0.3/32' }],
        '/api/networks': [{ id: 'n1', resources: ['r1', 'r2', 'r3'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    // Another instance just wrote r1's hold, and its add is still on the way.
    holds.set('r1', { networkId: 'n1', address: '10.0.0.1/32', expiresAt: Date.now() + HOUR, updatedAt: Date.now() - 60_000 });
    holds.set('r2', { networkId: 'n1', address: '10.0.0.2/32', expiresAt: Date.now() + HOUR, updatedAt: Date.now() - 11 * 60_000 });
    holds.set('r3', { networkId: 'n1', address: '10.0.0.3/32', expiresAt: Date.now() - 1000, updatedAt: Date.now() - 1000 });
    try {
        await ra._internal.syncTargetGroup();
        assert.deepEqual([...holds.rows.keys()], ['r1']);
        assert.deepEqual(Object.keys(ra._internal.holdsForTest()), ['r1'], 'kept in memory too');
        assert.equal(writes.length, 0, 'and never added');
    } finally { live = null; }
});

test('the background reconcile runs while browser access is off and drains the target groups', async () => {
    syncSetup({
        '/api/groups': [
            { id: 'g-gw', name: 'Browser Gateway (NetBird Control)' }, { id: 'g-gwt', name: 'Browser Gateway Targets (NetBird Control)' },
            { id: 'g-ngw', name: 'Browser Gateway Names (NetBird Control)' }, { id: 'g-ngwt', name: 'Browser Gateway Name Targets (NetBird Control)' },
        ],
        '/api/policies': [{ id: 'pol-gw', name: 'Browser Gateway (NetBird Control)' }, { id: 'pol-ngw', name: 'Browser Gateway Names (NetBird Control)' }],
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.1/32' }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets (NetBird Control)', [{ id: 'r1', type: 'host' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets (NetBird Control)'),
    }, { enabled: false, networks: ['n1'] });
    ra._internal.setManagedForTest({ ...MANAGED_IDS, policyId: 'pol-gw', namesPolicyId: 'pol-ngw' });
    hold('r1', 'n1', '10.0.0.1/32');
    try {
        await ra.reconcileRemoteAccess();
        assert.deepEqual(writes.filter(w => w[1].startsWith('/api/policies/')).map(w => [w[1], w[2].enabled]), [['/api/policies/pol-gw', false], ['/api/policies/pol-ngw', false]], 'the policies stay disabled');
        assert.deepEqual(groupWrites().map(w => [w[1], w[2].resources]), [['/api/groups/g-gwt', []]], 'held or not, nothing stays while access is off');
        assert.equal(holds.rows.size, 0);
    } finally { live = null; }
});

test('a resource whose type changed is written again, with the same members', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'subnet', address: '10.0.0.0/24', groups: [] }], // was a /32 host
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    hold('r1', 'n1', '10.0.0.0/24');
    try {
        assert.deepEqual(await ra._internal.syncTargetGroup(), { removed: 0 });
        assert.deepEqual(groupWrites().map(w => w[2].resources), [[{ id: 'r1', type: 'subnet' }]]);
    } finally { live = null; }
});

test('a sync that fails after writing one group says that group was updated', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]), // no hold: taken out
        '/api/groups/g-ngwt': null, // unreadable
    });
    try {
        await assert.rejects(ra._internal.syncTargetGroup(),
            (e) => /^The "Browser Gateway Targets" group was updated, then: Couldn't read the group/.test(e.message) && !/nothing was changed/.test(e.message));
        assert.equal(groupWrites().length, 1);
    } finally { live = null; }
});

test('a resource changed in NetBird between the read and the write is corrected in the same sync', async () => {
    const dom = { id: 'r-dom', type: 'domain', address: 'safe.example.com', groups: [] };
    syncSetup({
        '/api/networks/resources': [dom],
        '/api/networks': [{ id: 'n1', resources: ['r-dom'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets', [{ id: 'r-dom', type: 'domain' }, { id: 'r-gone', type: 'domain' }]),
    });
    hold('r-dom', 'n1', 'safe.example.com');
    // Someone makes the exact name a wildcard in the NetBird dashboard right after the read.
    afterWrite = () => { live['/api/networks/resources'] = [{ ...dom, address: '*.example.com' }]; afterWrite = null; };
    try {
        await ra._internal.syncTargetGroup();
        assert.deepEqual(groupWrites().map(w => w[2].resources.map(r => r.id)), [['r-dom'], []], 'the second pass takes the wildcard out');
        assert.deepEqual(live['/api/groups/g-ngwt'].resources, []);
    } finally { live = null; afterWrite = null; }
});

test('a member read without its type changes nothing', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    hold('r1', 'n1', '10.0.0.5/32');
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), (e) => e.message === "Couldn't read the networks from NetBird in full.");
        assert.equal(writes.length, 0);
        assert.equal(holds.rows.size, 1, 'a failed sync deletes no hold');
    } finally { live = null; }
});

test('a read that fails after a write says what was written and holds new sessions back', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    afterWrite = () => { live['/api/networks/resources'] = null; afterWrite = null; };
    ra._internal.resetSettlingForTest();
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), (e) => /^The "Browser Gateway Targets" group was updated, then: Couldn't read the networks/.test(e.message));
        assert.equal(ra._internal.settlingForTest(), true);
    } finally { live = null; afterWrite = null; ra._internal.resetSettlingForTest(); }
});

test('a difference still there after the second write holds new sessions back', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r-dom', type: 'domain', address: 'safe.example.com', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r-dom'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets'),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets', [{ id: 'r-dom', type: 'domain' }, { id: 'r-x', type: 'domain' }]),
    });
    hold('r-dom', 'n1', 'safe.example.com');
    // Someone keeps putting a resource without a hold back into the group after each write.
    afterWrite = (p) => { live[p] = { ...live[p], resources: [...live[p].resources, { id: 'r-x', type: 'domain' }] }; };
    ra._internal.resetSettlingForTest();
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), /NetBird changed again while it was being updated/, 'never reported as a success');
        assert.equal(groupWrites().length, 2, 'two writes at most');
        assert.equal(ra._internal.settlingForTest(), true, 'the check after them found a difference');
    } finally { live = null; afterWrite = null; ra._internal.resetSettlingForTest(); }
});

test('after one group is written, the next is compared with a fresh read of the resources', async () => {
    const dom = { id: 'r-dom', type: 'domain', address: 'safe.example.com', groups: [] };
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] }, dom],
        '/api/networks': [{ id: 'n1', resources: ['r1', 'r-dom'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]), // no hold: written first
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets', [{ id: 'r-dom', type: 'domain' }]),
    });
    hold('r-dom', 'n1', 'safe.example.com');
    // While the IP group is written, someone makes the name a wildcard and takes it out by hand.
    afterWrite = (p) => {
        if (p !== '/api/groups/g-gwt') return;
        live['/api/networks/resources'] = [live['/api/networks/resources'][0], { ...dom, address: '*.example.com' }];
        live['/api/groups/g-ngwt'] = targetGroup('g-ngwt', 'Browser Gateway Name Targets');
        afterWrite = null;
    };
    try {
        await ra._internal.syncTargetGroup();
        assert.deepEqual(groupWrites().map(w => w[1]), ['/api/groups/g-gwt'], 'the names group is not written from the older read');
        assert.deepEqual(live['/api/groups/g-ngwt'].resources, [], 'the wildcard is not put back');
    } finally { live = null; afterWrite = null; }
});

test('a group write answered with an error of any kind counts as uncertain', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r1', type: 'host' }]),
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    writeAnswer = { status: 404, raw: 'user not found' }; // can follow a saved group in NetBird
    ra._internal.resetSettlingForTest();
    try {
        await assert.rejects(ra._internal.syncTargetGroup(), /user not found/);
        assert.equal(ra._internal.settlingForTest(), true);
    } finally { live = null; writeAnswer = null; ra._internal.resetSettlingForTest(); }
});

test('the target sync writes nothing when a target group cannot be read in full', async () => {
    syncSetup({
        '/api/networks/resources': [{ id: 'r1', type: 'host', address: '10.0.0.5/32', groups: [] }],
        '/api/networks': [{ id: 'n1', resources: ['r1'] }],
        '/api/groups/g-gwt': { id: 'g-gwt', name: 'Browser Gateway Targets', peers: [] }, // no resources field
        '/api/groups/g-ngwt': targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
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
    s.resources.push({ id: 'r-a', name: 'A', type: 'domain', address: 'a.corp.example', enabled: true, groups: [{ id: 'g-ngwt' }, { id: 'g-srv' }] });
    s.networks[0].resources.push('r-a');
    const snapLive = () => ({
        '/api/users': s.users, '/api/peers': s.peers, '/api/groups': s.groups, '/api/policies': s.policies,
        '/api/networks/resources': s.resources, '/api/networks': s.networks, '/api/routes': [], '/api/networks/n1/routers': [{ peer: 'p-r1', enabled: true }],
        '/api/groups/g-ngwt': (live && live['/api/groups/g-ngwt']) || targetGroup('g-ngwt', 'Browser Gateway Name Targets'),
    });
    live = null;
    live = snapLive();
    holds.clear();
    ra._internal.setSleepForTest(async () => { }); // the wait for the route is not what this checks
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
        ra._internal.setSleepForTest(null);
        live = null;
    }
});

test('a session whose checks were already running is not approved when settling starts meanwhile', async () => {
    const s = base();
    live = {
        '/api/users': s.users, '/api/peers': s.peers, '/api/groups': s.groups, '/api/policies': s.policies,
        '/api/networks/resources': s.resources, '/api/networks': s.networks, '/api/routes': [], '/api/networks/n1/routers': [{ peer: 'p-r1', enabled: true }],
        // Already in its target group (an earlier session opened it): no add, no wait.
        '/api/groups/g-gwt': targetGroup('g-gwt', 'Browser Gateway Targets', [{ id: 'r-wide', type: 'subnet' }]),
    };
    holds.clear();
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
