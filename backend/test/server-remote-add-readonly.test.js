// A read-only instance (NETBIRD_READONLY) never offers "Add As Resource": Remote Access has no
// network to add to, and Troubleshoot's address check answers coverage.addable: false.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ssoServer } = require('./helpers/sso-server');

const h = ssoServer();
let db;

before(async () => {
    await h.start({
        env: { NETBIRD_READONLY: 'true' },
        beforeRequire(d) {
            db = d;
            const core = require('../lib/core');
            core.pool.query = async (sql) => (/FROM peers p/.test(sql)
                ? { rows: [{ peer_id: 'p1', name: 'laptop', ip: '100.64.0.2', raw_json: { connected: true, groups: [] } }] }
                : { rows: [] });
            Object.assign(d, {
                ensureUsersFresh: async () => { },
                ensurePeersFresh: async () => { },
                resolveViewer: async (oid) => ({ user_id: oid, role: 'admin', name: oid, email: `${oid}@example.com`, auto_groups: [] }),
                fetchUserGroups: async () => [],
                getUserPeerGroupIds: async () => [],
                getApproverGroupIds: () => [],
                isActiveDelegate: async () => false,
                resolveFeaturePerms: () => ({ 'networks.manage': true, 'remote.connect': true }),
                getAllGrants: async () => ({}),
                getNetworks: async () => [{ id: 'net-1', name: 'Office' }],
            });
        },
    });
    require('../lib/remote-access')._internal.setConfigForTest({ enabled: true, networks: ['net-1'] });
});
after(() => h.stop());

test('read-only: no network to add a resource to', async () => {
    const r = await h.call('admin', 'GET', '/api/remote-access/add-networks');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { networks: [] });
});

test('read-only: the address check never offers to add', async () => {
    const r = await db.diagnoseAddress('p1', '192.0.2.44');
    assert.equal(r.findings.find(f => f.key === 'coverage').status, 'FAIL', 'nothing covers it');
    assert.deepEqual(r.coverage, { addable: false });
});
