// Access-request targets are resolved against the same catalogue the request typeahead offers
// (resources + their port-policy entries, networks, shared access profiles). Name, network,
// profile group and port scope come from that catalogue - never from the request body - at
// submission and again at approval. Anything the catalogue doesn't offer is rejected.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client and the DB BEFORE db.js loads (it destructures these at require time).
const nb = require('../lib/netbird');
const usage = {
    networks: [{ id: 'net-1', name: 'Office', resources: ['res-1', 'res-2'] }],
    resources: [
        { id: 'res-1', name: 'wiki-host', address: '10.0.0.5', type: 'host' },
        { id: 'res-2', name: 'db-host', address: '10.0.0.6', type: 'host' },
        { id: 'res-loose', name: 'loose-host', address: '10.0.0.7', type: 'host' }, // in no network
    ],
    policies: [{
        id: 'pol-1', name: 'Wiki HTTPS', enabled: true,
        rules: [{ enabled: true, protocol: 'tcp', ports: ['443', '443'], destinationResource: { id: 'res-1' } }],
    }, {
        id: 'pol-2', name: 'DB Web', enabled: true,
        rules: [{ enabled: true, protocol: 'tcp', ports: ['80', '443'], destinationResource: { id: 'res-2' } }],
    }],
    routes: [], nameservers: [], zones: [], setupKeys: [],
};
let nbWrites = [];
nb.getUsageData = async () => usage;
nb.getGroupRefMap = async () => ({});
nb.netbirdGet = async () => [];
nb.netbirdPost = async (path, body) => { nbWrites.push({ path, body }); return { status: 200, body: { id: 'x' } }; };
nb.netbirdPut = async (path, body) => { nbWrites.push({ path, body }); return { status: 200, body: {} }; };
nb.netbirdReq = async (method, path, body) => { nbWrites.push({ method, path, body }); return { status: 200, body: {} }; };

const core = require('../lib/core');
const profiles = [
    { id: 5, name: 'Wiki Profile', group_id: 'grp-wiki', shared: true, protocol: 'tcp', ports: '443', sources: [] },
    { id: 6, name: 'Direct Preset', group_id: '', shared: false, protocol: 'tcp', ports: '22', sources: [] },
];
let profilesFail = false;
let rows = new Map(), nextId = 1, grantInputs = [];
core.pool.query = async (sql, params = []) => {
    if (/FROM access_profiles/.test(sql)) {
        if (profilesFail) throw new Error('db down');
        return { rows: profiles };
    }
    if (/INSERT INTO access_requests/.test(sql)) {
        const row = { id: nextId++, requester_id: params[0], requester_email: params[1], requester_name: params[2], targets: JSON.parse(params[3]), reason: params[4], requested_minutes: params[5], kind: params[6], status: 'pending' };
        rows.set(row.id, row);
        return { rows: [row] };
    }
    if (/SELECT \* FROM access_requests WHERE id=\$1/.test(sql)) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] };
    if (/nextval/.test(sql)) return { rows: [{ id: 900 }] };
    // The grant's input targets are exactly what becomes memberships and policies - capture
    // them and stop before any NetBird object is created.
    if (/INSERT INTO temporary_access_grants/.test(sql)) { grantInputs.push(JSON.parse(params[4])); throw new Error('grant stopped by test'); }
    return { rows: [] };
};
const { createAccessRequest, approveAccessRequest, setAutoApprovalConfig } = require('../db');

const alice = { user_id: 'u-alice', name: 'Alice', email: 'alice@example.com', groups: ['grp-staff'] };
const submit = (targets) => createAccessRequest({ targets, reason: 'work', requestedMinutes: 60 }, alice);
const reset = () => { rows = new Map(); nextId = 1; grantInputs = []; nbWrites = []; profilesFail = false; };
const stored = (id) => rows.get(id).targets;
const REFUSED = /no longer offered|only resources, networks and access profiles/;
// A pending row as it may exist from before targets were resolved.
const legacyRow = (targets) => { const row = { id: nextId++, requester_id: 'u-alice', requester_name: 'Alice', requester_email: 'alice@example.com', targets, kind: 'access', status: 'pending', requested_minutes: 60 }; rows.set(row.id, row); return row.id; };

test.beforeEach(async () => { reset(); await setAutoApprovalConfig({ trusted: [], rules: [] }); });

test('a profile target takes its name and destination group from the profile', async () => {
    const r = await submit([{ type: 'profile', id: '5', name: 'Printer', groupId: 'grp-all' }]);
    assert.deepEqual(stored(r.id), [{ type: 'profile', id: '5', name: 'Wiki Profile', groupId: 'grp-wiki' }]);
});

test('a resource target takes its name, network and type from the catalogue', async () => {
    const r = await submit([{ type: 'resource', id: 'res-2', name: 'Printer', networkId: 'net-other', resourceType: 'subnet' }]);
    assert.deepEqual(stored(r.id), [{ type: 'resource', id: 'res-2', name: 'db-host', networkId: 'net-1', resourceType: 'host' }]);
});

test('a network target takes its name from the catalogue', async () => {
    const r = await submit([{ type: 'network', id: 'net-1', name: 'Printer' }]);
    assert.deepEqual(stored(r.id), [{ type: 'network', id: 'net-1', name: 'Office' }]);
});

test('a port entry keeps its ports and policy label, next to the plain resource', async () => {
    // Exactly what the typeahead returns for the port entry (duplicate port included).
    const r = await submit([
        { type: 'resource', id: 'res-1', name: 'Wiki HTTPS', networkId: 'net-1', access: { tcp: ['443', '443'] } },
        { type: 'resource', id: 'res-1', name: 'wiki-host', networkId: 'net-1' },
    ]);
    assert.deepEqual(stored(r.id), [
        { type: 'resource', id: 'res-1', name: 'Wiki HTTPS', networkId: 'net-1', resourceType: 'host', access: { tcp: ['443'] } },
        { type: 'resource', id: 'res-1', name: 'wiki-host', networkId: 'net-1', resourceType: 'host' },
    ]);
});

test('a port entry matches regardless of port order', async () => {
    const r = await submit([{ type: 'resource', id: 'res-2', name: 'DB Web', access: { tcp: ['443', '80'] } }]);
    assert.deepEqual(stored(r.id), [{ type: 'resource', id: 'res-2', name: 'DB Web', networkId: 'net-1', resourceType: 'host', access: { tcp: ['80', '443'] } }]);
});

test('targets the catalogue does not offer are rejected before anything is stored', async () => {
    const cases = [
        { type: 'group', id: 'grp-admins', name: 'Printer' },
        { type: 'peer', id: 'p-1', name: 'Laptop' },
        { type: 'resource', id: 'res-missing', name: 'x' },
        { type: 'resource', id: 'res-loose', name: 'loose-host' },
        { type: 'network', id: 'net-missing', name: 'x' },
        { type: 'profile', id: '6', name: 'Direct Preset' },
        { type: 'profile', id: '99', name: 'x', groupId: 'grp-all' },
        { type: 'resource', id: { toString: () => 'res-1' }, name: 'x' },
        { type: 'resource', id: 'res-1', access: { tcp: [], udp: [], icmp: true } },
        { type: 'resource', id: 'res-1', access: { tcp: ['8443'] } },
        { type: 'resource', id: 'res-1', access: { tcp: ['bogus'] } },
        { type: 'network', id: 'net-1', access: { tcp: ['443'] } },
        { type: 'profile', id: '5', access: { tcp: [] } },
    ];
    for (const t of cases) {
        await assert.rejects(submit([t]), REFUSED, JSON.stringify(t));
    }
    assert.equal(rows.size, 0);
});

test('an unreadable profile list rejects a profile target', async () => {
    profilesFail = true;
    await assert.rejects(submit([{ type: 'profile', id: '5', name: 'Wiki Profile' }]), /db down/);
    assert.equal(rows.size, 0);
});

test('an approver override is resolved the same way', async () => {
    const r = await submit([{ type: 'resource', id: 'res-2', name: 'db-host' }]);
    await assert.rejects(approveAccessRequest(r.id, { actor: { name: 'Bob' }, targets: [{ type: 'group', id: 'grp-admins', name: 'Printer' }] }), REFUSED);
    await assert.rejects(approveAccessRequest(r.id, { actor: { name: 'Bob' }, targets: [{ type: 'resource', id: 'res-1', access: { tcp: [] } }] }), REFUSED);
    assert.equal(grantInputs.length, 0);
    assert.equal(nbWrites.length, 0);
    await assert.rejects(approveAccessRequest(r.id, { actor: { name: 'Bob' }, targets: [{ type: 'profile', id: '5', name: 'Printer', groupId: 'grp-all' }] }), /grant stopped by test/);
    assert.deepEqual(grantInputs[0], [{ type: 'profile', id: '5', name: 'Wiki Profile', groupId: 'grp-wiki' }]);
});

test('approving a stored request re-resolves its targets', async () => {
    const bad = legacyRow([{ type: 'group', id: 'grp-admins', name: 'Printer' }]);
    await assert.rejects(approveAccessRequest(bad, { actor: { name: 'Bob' } }), REFUSED);
    const wide = legacyRow([{ type: 'resource', id: 'res-1', name: 'wiki-host', networkId: 'net-1', access: { tcp: [], udp: [], icmp: true } }]);
    await assert.rejects(approveAccessRequest(wide, { actor: { name: 'Bob' } }), REFUSED);
    assert.equal(grantInputs.length, 0);
    assert.equal(nbWrites.length, 0);
    const relabelled = legacyRow([{ type: 'profile', id: '5', name: 'Printer', groupId: 'grp-all' }]);
    await assert.rejects(approveAccessRequest(relabelled, { actor: { name: 'Bob' } }), /grant stopped by test/);
    assert.deepEqual(grantInputs[0], [{ type: 'profile', id: '5', name: 'Wiki Profile', groupId: 'grp-wiki' }]);
});

test('a port scope pinned by an auto-approval rule is kept through review', async () => {
    await setAutoApprovalConfig({ trusted: [], rules: [
        { targets: [{ type: 'resource', id: 'res-2', name: 'db-host' }], groupIds: ['grp-staff'], access: { tcp: ['8080'] } },
        { targets: [{ type: 'profile', id: '5', name: 'Wiki Profile' }], groupIds: ['grp-staff'], access: { udp: ['53'] } },
    ] });
    // The grant fails (stopped by the test), so the auto-approved part falls back to review.
    const r = await submit([{ type: 'resource', id: 'res-2', name: 'Printer' }, { type: 'profile', id: '5', name: 'Printer' }]);
    assert.equal(r.pending, 1);
    assert.deepEqual(grantInputs[0], [
        { type: 'resource', id: 'res-2', name: 'db-host', networkId: 'net-1', resourceType: 'host', access: { tcp: ['8080'] }, ruleAccess: true },
        { type: 'profile', id: '5', name: 'Wiki Profile', groupId: 'grp-wiki', access: { udp: ['53'] }, ruleAccess: true },
    ]);
    // A human approval of the stored row, as-is or re-posted by the review modal, keeps the pin.
    await assert.rejects(approveAccessRequest(r.id, { actor: { name: 'Bob' } }), /grant stopped by test/);
    assert.deepEqual(grantInputs[1], grantInputs[0]);
    await assert.rejects(approveAccessRequest(r.id, { actor: { name: 'Bob' }, targets: stored(r.id) }), /grant stopped by test/);
    assert.deepEqual(grantInputs[2], grantInputs[0]);
    // The pin covers only the exact target and ports stored on this request.
    const before = grantInputs.length;
    await assert.rejects(approveAccessRequest(r.id, { actor: { name: 'Bob' }, targets: [{ type: 'resource', id: 'res-2', access: { tcp: [] }, ruleAccess: true }] }), REFUSED);
    await assert.rejects(approveAccessRequest(r.id, { actor: { name: 'Bob' }, targets: [{ type: 'resource', id: 'res-1', access: { tcp: ['8080'] }, ruleAccess: true }] }), REFUSED);
    assert.equal(grantInputs.length, before);
});

test('a pinned scope that replaces a picked port entry is shown under the target name', async () => {
    await setAutoApprovalConfig({ trusted: [], rules: [
        { targets: [{ type: 'resource', id: 'res-1', name: 'wiki-host' }], groupIds: ['grp-staff'], access: { tcp: ['8080'] } },
    ] });
    const r = await submit([{ type: 'resource', id: 'res-1', name: 'Wiki HTTPS', access: { tcp: ['443'] } }]);
    assert.deepEqual(stored(r.id), [{ type: 'resource', id: 'res-1', name: 'wiki-host', networkId: 'net-1', resourceType: 'host', access: { tcp: ['8080'] }, ruleAccess: true }]);
});

test('a pin cannot be claimed in a submitted request', async () => {
    await assert.rejects(submit([{ type: 'resource', id: 'res-2', access: { tcp: ['8080'] }, ruleAccess: true }]), REFUSED);
    assert.equal(rows.size, 0);
});
