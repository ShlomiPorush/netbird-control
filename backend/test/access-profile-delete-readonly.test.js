// A read-only instance (NETBIRD_READONLY) refuses DELETE /api/access-profiles/:id before anything
// is read or changed - neither the database nor NetBird is asked.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ssoServer } = require('./helpers/sso-server');

const h = ssoServer();
const queries = [];

before(async () => {
    await h.start({
        env: { NETBIRD_READONLY: 'true' },
        beforeRequire(db) {
            require('../lib/core').pool.query = async (q) => { queries.push(String(typeof q === 'string' ? q : q.text)); return { rows: [] }; };
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
