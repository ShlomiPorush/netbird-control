// A read-only instance (NETBIRD_READONLY) refuses DELETE /api/access-profiles/:id before anything
// is read or changed - neither the database nor NetBird is asked - and a profile edit changes
// neither of them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ssoServer } = require('./helpers/sso-server');

const h = ssoServer();
const queries = [];

before(async () => {
    await h.start({
        env: { NETBIRD_READONLY: 'true' },
        beforeRequire(db) {
            require('../lib/core').pool.query = async (q) => {
                const sql = String(typeof q === 'string' ? q : q.text);
                queries.push(sql);
                if (/^SELECT group_id, policy_id, shared FROM access_profiles WHERE id = \$1/.test(sql)) return { rows: [{ group_id: 'pg-7', policy_id: 'pp-7', shared: true }] };
                return { rows: [] };
            };
            Object.assign(db, {
                ensureUsersFresh: async () => { },
                ensurePeersFresh: async () => { },
                resolveViewer: async (oid) => ({ user_id: oid, role: 'admin', name: oid, email: `${oid}@example.com`, auto_groups: [] }),
                fetchUserGroups: async () => [],
                getUserPeerGroupIds: async () => [],
                getApproverGroupIds: () => [],
                isActiveDelegate: async () => false,
            });
        },
    });
});
after(() => h.stop());

test('read-only: deleting a profile is refused and nothing is read or deleted', async () => {
    queries.length = 0;
    h.netbird.seen.length = 0;
    const r = await h.call('admin', 'DELETE', '/api/access-profiles/7');
    assert.equal(r.status, 403, r.text);
    assert.match(r.json.error, /read-only/);
    assert.ok(!queries.some(q => /access_profiles|network_default_profiles|app_audit/.test(q)), 'no profile row read or written');
    assert.ok(!h.netbird.seen.some(s => /\/api\/(groups|policies)/.test(s)), 'NetBird not asked');
});

test('read-only: editing a profile changes neither its row nor NetBird', async () => {
    queries.length = 0;
    h.netbird.seen.length = 0;
    const r = await h.call('admin', 'PUT', '/api/access-profiles/7', { name: 'Ops', sources: [], protocol: 'tcp', ports: ['22'], postureChecks: [] });
    assert.equal(r.status, 502, r.text);
    assert.match(r.json.error, /read-only/);
    assert.ok(!queries.some(q => /UPDATE access_profiles/.test(q)), 'no profile row written');
    assert.ok(!h.netbird.seen.some(s => /^PUT /.test(s)), 'nothing sent');
});

test('read-only: Stop Using This Network is refused', async () => {
    const r = await h.call('admin', 'DELETE', '/api/remote-access/create-resources/network');
    assert.equal(r.status, 403, r.text);
    assert.match(r.json.error, /read-only/);
});
