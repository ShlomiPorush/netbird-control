// A grant's NetBird membership and its row must agree: the reconcile job never re-adds a group
// for a grant that was revoked meanwhile, and a revoke whose membership removal did not reach
// NetBird leaves the grant active (with the error) so the next tick retries it.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client and the DB BEFORE db.js loads (it destructures these at require time).
const nb = require('../lib/netbird');
const clone = (x) => JSON.parse(JSON.stringify(x));
let nbUser, putStatus, gateNextUsersRead = null;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
nb.ensureGroupsFresh = async () => { };
nb.netbirdGet = async (path) => {
    if (String(path).startsWith('/api/users')) {
        if (gateNextUsersRead) { const g = gateNextUsersRead; gateNextUsersRead = null; await g; }
        return [clone(nbUser)];
    }
    return [];
};
nb.netbirdReq = async (method, path, body) => {
    if (method === 'PUT' && String(path).startsWith('/api/users/')) {
        if (putStatus !== 200) return { status: putStatus, error: 'socket hang up' };
        nbUser.auto_groups = body.auto_groups;
        return { status: 200, body: clone(nbUser) };
    }
    return { status: 200, body: {} };
};
nb.netbirdPut = (path, body) => nb.netbirdReq('PUT', path, body);

let grant, snapshotGate = null;
const core = require('../lib/core');
core.pool.query = async (sql, params = []) => {
    if (/FROM temporary_access_grants WHERE status='active' AND tenant/.test(sql)) {
        const rows = grant.status === 'active' ? [clone(grant)] : [];
        if (snapshotGate) { const g = snapshotGate; snapshotGate = null; await g; }
        return { rows };
    }
    if (/FROM temporary_access_grants WHERE id=\$1/.test(sql)) return { rows: params[0] === grant.id ? [clone(grant)] : [] };
    if (/UPDATE temporary_access_grants SET status=\$2/.test(sql)) { grant.status = params[1]; return { rows: [] }; }
    if (/UPDATE temporary_access_grants SET last_status='', last_error=\$2/.test(sql)) { grant.last_error = params[1]; return { rows: [] }; }
    return { rows: [] };
};
const { reconcileActiveGrants, revokeTemporaryAccessGrant } = require('../db');

function reset() {
    nbUser = { id: 'u1', role: 'user', is_blocked: false, auto_groups: ['g-base', 'g-target'] };
    putStatus = 200;
    grant = {
        id: 7, user_id: 'u1', user_label: 'U', user_email: '', status: 'active', last_error: '',
        assigned_groups: ['g-target'], group_id: '', dest_group_id: '', dest_group_ids: [], dest_resources: [], policy_ids: [],
        targets: [{ type: 'group', id: 'g-target', name: 'Target' }],
    };
}
const deferred = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

test('reconcile does not re-add a group for a grant revoked after its snapshot', async () => {
    reset();
    const gate = deferred();
    snapshotGate = gate.p;
    const rec = reconcileActiveGrants();           // takes its snapshot (grant active), then waits
    await new Promise(r => setImmediate(r));
    const res = await revokeTemporaryAccessGrant(7); // revoke runs to completion meanwhile
    assert.equal(res.status, 'revoked');
    assert.ok(!nbUser.auto_groups.includes('g-target'));
    gate.release();
    await rec;
    assert.ok(!nbUser.auto_groups.includes('g-target'), 'the revoked membership must stay removed');
});

test('a revoke started while reconcile is writing the user waits, and the group ends removed', async () => {
    reset();
    const gate = deferred();
    gateNextUsersRead = gate.p;                     // reconcile pauses inside its user read
    const rec = reconcileActiveGrants();
    await new Promise(r => setTimeout(r, 10));
    const rev = revokeTemporaryAccessGrant(7);
    await new Promise(r => setTimeout(r, 10));
    gate.release();
    await rec;
    const res = await rev;
    assert.equal(res.status, 'revoked');
    assert.ok(!nbUser.auto_groups.includes('g-target'), 'the revoked membership must stay removed');
});

test('a membership removal that never reached NetBird keeps the grant active with the error', async () => {
    reset();
    putStatus = 0; // connection reset / timeout: netbirdReq resolves { status: 0 }
    const res = await revokeTemporaryAccessGrant(7);
    assert.equal(res.status, 'error');
    assert.equal(grant.status, 'active');
    assert.ok(grant.last_error);
    assert.ok(nbUser.auto_groups.includes('g-target'));
});
