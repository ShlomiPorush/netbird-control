// The Browser Gateway's standing policy (all TCP ports, no posture checks, gateway group ->
// "Browser Gateway Targets") is infrastructure, not exposure. A temporary grant mirrors a
// resource's EXISTING exposure, so it must never pick up that policy - otherwise every grant to a
// gateway target would widen to all ports without posture checks. A revoke also marks the grant
// before it touches NetBird, so a revoke that fails or crashes never leaves a grant that browser
// access would still count.
const test = require('node:test');
const assert = require('node:assert/strict');

const nb = require('../lib/netbird');
let policies = [], posts = [], nextId = 0, nbCalls = [];
const resource = { id: 'res-rdp', name: 'rdp', address: '10.0.0.5', groups: [{ id: 'grp-srv' }, { id: 'grp-gwt' }] };
nb.netbirdGet = async (path) => {
    nbCalls.push(['GET', path]);
    if (path === '/api/users') return [{ id: 'user-1', role: 'user', auto_groups: [] }];
    if (path === '/api/policies') return JSON.parse(JSON.stringify(policies));
    if (path === '/api/networks/net1/resources') return [resource];
    if (path === '/api/networks/net1/resources/res-rdp') return resource;
    return [];
};
nb.netbirdPost = async (path, body) => { nbCalls.push(['POST', path]); posts.push({ path, body }); return { status: 200, body: { id: `nb-${++nextId}` } }; };
nb.netbirdReq = async (method, path) => { nbCalls.push([method, path]); return { status: 200, body: {} }; };
nb.bustNbCaches = () => { };

const core = require('../lib/core');
const sqls = [];
let grantRow = null;
let savedNb = null;
core.pool.query = async (sql, params) => {
    sqls.push({ sql, params, nbCallsBefore: nbCalls.length });
    if (/FROM app_settings WHERE key = \$1/.test(sql) && params && params[0] === 'remote_access_nb' && savedNb) return { rows: [{ value: JSON.stringify(savedNb) }] };
    if (/nextval/.test(sql)) return { rows: [{ id: 601 }] };
    if (/RETURNING id/.test(sql)) return { rows: [{ id: 601 }] };
    if (/SELECT \* FROM temporary_access_grants WHERE id=\$1/.test(sql) && grantRow) return { rows: [grantRow] };
    if (/SELECT user_id FROM temporary_access_grants/.test(sql) && grantRow) return { rows: [{ user_id: grantRow.user_id }] };
    return { rows: [] };
};

const { createTemporaryAccessGrant, revokeTemporaryAccessGrant } = require('../db');

const gatewayPolicy = {
    id: 'pol-gw', name: 'Browser Gateway', enabled: true, source_posture_checks: [],
    rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: [], sources: [{ id: 'grp-gw' }], destinations: [{ id: 'grp-gwt' }] }],
};
const staffRdp = {
    id: 'pol-staff', name: 'Staff RDP', enabled: true, source_posture_checks: [{ id: 'pc-managed' }],
    rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'grp-staff' }], destinations: [{ id: 'grp-srv' }] }],
};

test('a temporary grant mirrors the real exposure and ignores the gateway policy', async () => {
    policies = [gatewayPolicy, staffRdp];
    posts = [];
    await createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'resource', id: 'res-rdp', networkId: 'net1' }] }, { email: 'admin@example.test' });
    const temp = posts.filter(p => p.path === '/api/policies').map(p => p.body);
    assert.equal(temp.length, 1, 'one temporary policy, for the one real exposure');
    assert.deepEqual(temp[0].rules[0].ports, ['3389']);
    assert.equal(temp[0].rules[0].protocol, 'tcp');
    assert.deepEqual(temp[0].source_posture_checks, ['pc-managed']);
});

test('a revoke records revoke_requested_at before any NetBird call', async () => {
    grantRow = { id: 602, user_id: 'user-1', status: 'active', policy_ids: ['p1'], assigned_groups: [], group_id: 'g-tmp', dest_resources: [], dest_group_ids: [] };
    sqls.length = 0;
    nbCalls = [];
    await revokeTemporaryAccessGrant(602, { trigger: 'manual' });
    const mark = sqls.find(q => /revoke_requested_at=COALESCE\(revoke_requested_at, NOW\(\)\)/.test(q.sql));
    assert.ok(mark, 'the revoke marks the grant');
    assert.equal(mark.nbCallsBefore, 0, 'the mark is written before NetBird is touched');
    assert.ok(nbCalls.some(c => c[0] === 'DELETE'), 'then NetBird objects are removed');
    grantRow = null;
});

// The names gateway's standing policy is infrastructure too - by name before its id is saved, and
// by id once saved (even if someone renamed it in NetBird).
const namesPolicy = (id, name) => ({
    id, name, enabled: true, source_posture_checks: [],
    rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: [], sources: [{ id: 'grp-ngw' }], destinations: [{ id: 'grp-gwt' }] }],
});

test('a temporary grant ignores the names gateway policy by its name', async () => {
    policies = [namesPolicy('pol-ngw', 'Browser Gateway (Names)'), staffRdp];
    posts = [];
    await createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'resource', id: 'res-rdp', networkId: 'net1' }] }, { email: 'admin@example.test' });
    const temp = posts.filter(p => p.path === '/api/policies').map(p => p.body);
    assert.equal(temp.length, 1);
    assert.deepEqual(temp[0].rules[0].ports, ['3389']);
});

test('a temporary grant ignores the names gateway policy by its saved id, even renamed', async () => {
    savedNb = { namesPolicyId: 'pol-ngw-renamed' };
    await require('../lib/remote-access').loadRemoteAccessConfig();
    policies = [namesPolicy('pol-ngw-renamed', 'Someone renamed it'), staffRdp];
    posts = [];
    await createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets: [{ type: 'resource', id: 'res-rdp', networkId: 'net1' }] }, { email: 'admin@example.test' });
    const temp = posts.filter(p => p.path === '/api/policies').map(p => p.body);
    assert.equal(temp.length, 1);
    assert.deepEqual(temp[0].rules[0].ports, ['3389']);
    savedNb = null;
});
