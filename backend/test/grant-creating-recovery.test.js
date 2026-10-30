// The 'creating' row is the only record of NetBird objects a half-finished grant may have left
// behind. It is removed only once every one of them is confirmed gone: a failed undo step, an
// uncertain write, or an unreadable NetBird list keeps it for the next cleanup run.
const test = require('node:test');
const assert = require('node:assert/strict');

const nb = require('../lib/netbird');
const clone = (x) => JSON.parse(JSON.stringify(x));
let nbUser, nbReads, deleteStatus, userPutStatus, policyPostStatus, otherActiveGrants, tempGroups, resourceReadStatus;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
nb.ensureGroupsFresh = async () => { };
nb.netbirdGet = async (path) => {
    if (!nbReads) return null; // NetBird unreachable
    path = String(path);
    if (path.startsWith('/api/users')) return [clone(nbUser)];
    if (path === '/api/groups') return clone(tempGroups);
    if (path === '/api/networks/n1/resources') return [{ id: 'r1', groups: [] }];
    if (path === '/api/networks/n1/resources/r1') return { id: 'r1', name: 'R1', address: '10.0.0.1', groups: [] };
    return [];
};
nb.netbirdPost = async (path) => {
    if (path === '/api/groups') return { status: 200, body: { id: 'grp-' + Math.random().toString(36).slice(2, 6) } };
    if (path === '/api/policies') return { status: policyPostStatus, raw: 'policy rejected' };
    return { status: 200, body: {} };
};
nb.netbirdReq = async (method, path, body) => {
    path = String(path);
    if (method === 'GET' && resourceReadStatus !== 200) return { status: resourceReadStatus, body: { message: 'forbidden', code: resourceReadStatus } };
    if (method === 'GET') return { status: nbReads ? 200 : 0, body: nbReads ? await nb.netbirdGet(path) : null };
    if (method === 'PUT' && path.startsWith('/api/users/')) {
        nbUser.auto_groups = body.auto_groups; // NetBird applies it...
        if (userPutStatus !== 200) return { status: userPutStatus, error: 'timeout' }; // ...but the answer is lost
        return { status: 200, body: clone(nbUser) };
    }
    if (method === 'DELETE') return { status: deleteStatus, error: deleteStatus ? '' : 'timeout' };
    return { status: 200, body: {} };
};
nb.netbirdPut = (path, body) => nb.netbirdReq('PUT', path, body);

let rows;
const core = require('../lib/core');
core.pool.query = async (sql, params = []) => {
    if (/nextval/.test(sql)) return { rows: [{ id: 42 }] };
    if (/INSERT INTO temporary_access_grants/.test(sql)) {
        rows.set(params[0], { id: params[0], user_id: params[1], user_label: params[2], targets: JSON.parse(params[4]), status: 'creating', last_error: '', assigned_groups: [] });
        return { rows: [] };
    }
    if (/DELETE FROM temporary_access_grants WHERE id=\$1 AND status='creating'/.test(sql)) { rows.delete(params[0]); return { rows: [] }; }
    if (/UPDATE temporary_access_grants SET assigned_groups=/.test(sql)) {
        const r = rows.get(params[0]);
        if (r) Object.assign(r, { assigned_groups: JSON.parse(params[1]), last_error: params[3] });
        return { rows: [] };
    }
    if (/SET group_id=\$2/.test(sql)) { const r = rows.get(params[0]); if (r) r.status = 'active'; return { rows: [{ id: params[0] }] }; }
    if (/FROM temporary_access_grants WHERE status='creating'/.test(sql)) return { rows: [...rows.values()].filter(r => r.status === 'creating').map(clone) };
    if (/FROM temporary_access_grants WHERE status='active' AND regexp_replace\(user_id/.test(sql)) {
        // Mirrors the SQL: same IdP-subject tail, and the group in assigned_groups.
        return { rows: otherActiveGrants.filter(o => o.user_id.split('|').pop() === params[0] && o.assigned_groups.includes(params[2])).map(o => ({ id: o.id })) };
    }
    return { rows: [] };
};
const { createTemporaryAccessGrant, cleanupStuckCreatingGrants } = require('../db');

function reset() {
    nbUser = { id: 'u1', role: 'user', is_blocked: false, auto_groups: ['g-base'] };
    nbReads = true; deleteStatus = 200; userPutStatus = 200; policyPostStatus = 200;
    rows = new Map(); otherActiveGrants = []; tempGroups = []; resourceReadStatus = 200;
}
const grantCfg = (targets) => ({ userId: 'u1', userLabel: 'U', userEmail: 'u@x', targets, durationMinutes: 60 });

test('a failed undo step keeps the creating row for the cleanup job', async () => {
    reset();
    policyPostStatus = 500;   // creation fails after the groups were made
    deleteStatus = 0;         // and the undo cannot reach NetBird
    await assert.rejects(createTemporaryAccessGrant(grantCfg([{ type: 'resource', id: 'r1', networkId: 'n1', name: 'R1' }]), { name: 'admin' }));
    assert.ok(rows.has(42), 'the creating row must be kept');
    assert.equal(rows.get(42).status, 'creating');
    assert.ok(rows.get(42).last_error);
});

test('an add whose answer was lost is undone and the creating row is kept', async () => {
    reset();
    userPutStatus = 0;
    await assert.rejects(createTemporaryAccessGrant(grantCfg([{ type: 'group', id: 'g-target', name: 'Target' }]), { name: 'admin' }));
    assert.ok(rows.has(42), 'the creating row must be kept');
    assert.deepEqual(rows.get(42).assigned_groups, ['g-target']);
});

test('cleanup keeps the creating row when NetBird cannot be read', async () => {
    reset();
    rows.set(13, { id: 13, user_id: 'u1', user_label: 'U', status: 'creating', last_error: '', assigned_groups: [], targets: [{ type: 'group', id: 'g-target' }] });
    nbReads = false;
    await assert.rejects(cleanupStuckCreatingGrants());
    assert.ok(rows.has(13), 'the creating row must be kept');
});

test('cleanup keeps the creating row when a resource cannot be read', async () => {
    reset();
    rows.set(13, { id: 13, user_id: 'u1', user_label: 'U', status: 'creating', last_error: '', assigned_groups: [], targets: [{ type: 'resource', id: 'r1', networkId: 'n1' }] });
    tempGroups = [{ id: 'tmp-13', name: 'Temp resources #13 (until Jan 1, 2030, 9:00 AM)' }];
    resourceReadStatus = 403;
    await assert.rejects(cleanupStuckCreatingGrants());
    assert.ok(rows.has(13), 'the creating row must be kept');
});

test('cleanup leaves a group that another active grant of the user holds', async () => {
    reset();
    nbUser.auto_groups = ['g-base', 'g-target'];
    rows.set(13, { id: 13, user_id: 'u1', user_label: 'U', status: 'creating', last_error: 'creation failed', assigned_groups: ['g-target'], targets: [{ type: 'group', id: 'g-target' }] });
    otherActiveGrants = [{ id: 14, user_id: 'azure|u1', assigned_groups: ['g-target'] }]; // same user, other id form
    await cleanupStuckCreatingGrants();
    assert.ok(nbUser.auto_groups.includes('g-target'));
    assert.ok(!rows.has(13));
});
