// A timed device bypass is only approved together with its expiry. When the expiry cannot be
// saved, the bypass is taken back and the request stays pending; an expiry that was already
// scheduled for the device (including the deletion of a temporary device) is left in place.
const test = require('node:test');
const assert = require('node:assert/strict');

const nb = require('../lib/netbird');
let bypassed, bypassDeleteStatus;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
nb.netbirdGet = async () => [];
nb.netbirdPost = async (path) => {
    if (/\/edr\/bypass$/.test(path)) { bypassed = true; return { status: 200, body: {} }; }
    return { status: 200, body: {} };
};
nb.netbirdReq = async (method, path) => {
    if (method === 'DELETE' && /\/edr\/bypass$/.test(path)) {
        if (bypassDeleteStatus !== 200) return { status: bypassDeleteStatus, error: 'timeout' };
        bypassed = false; return { status: 200, body: {} };
    }
    return { status: 200, body: {} };
};

let request, queries;
const core = require('../lib/core');
core.pool.query = async (sql, params = []) => {
    queries.push(sql);
    if (/SELECT \* FROM access_requests WHERE id=\$1/.test(sql)) return { rows: [{ ...request }] };
    if (/INSERT INTO bypass_expirations/.test(sql)) throw new Error('database unavailable');
    if (/UPDATE access_requests SET status='approved'/.test(sql)) { request.status = 'approved'; return { rows: [] }; }
    return { rows: [] };
};
const { approveAccessRequest } = require('../db');

function reset(extra = {}) {
    bypassed = false; bypassDeleteStatus = 200; queries = [];
    request = { id: 5, kind: 'bypass', status: 'pending', requester_id: 'u1', requester_email: 'u@x', requester_name: 'U', targets: [{ id: 'p1', name: 'Laptop' }], temp_device: true, extend_bypass: false, ...extra };
}

test('an approval whose expiry cannot be saved takes the bypass back and stays pending', async () => {
    reset();
    await assert.rejects(approveAccessRequest(5, { durationMinutes: 60, actor: { name: 'admin' } }), /bypass was removed/i);
    assert.equal(bypassed, false, 'the bypass must be taken back');
    assert.equal(request.status, 'pending');
});

test('taking the bypass back leaves an already scheduled expiry in place', async () => {
    reset({ extend_bypass: true });
    await assert.rejects(approveAccessRequest(5, { durationMinutes: 60, actor: { name: 'admin' } }));
    assert.equal(bypassed, false);
    assert.ok(!queries.some(q => /DELETE FROM bypass_expirations/.test(q)), 'the scheduled expiry must not be dropped');
});

test('when the bypass cannot be taken back, the error says it is still active', async () => {
    reset();
    bypassDeleteStatus = 0;
    await assert.rejects(approveAccessRequest(5, { durationMinutes: 60, actor: { name: 'admin' } }), /still bypassed/i);
    assert.equal(request.status, 'pending');
});
