const test = require('node:test');
const assert = require('node:assert/strict');

const nb = require('../lib/netbird');
let bypassed, bypassAnswer, expirySaves;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
nb.netbirdGet = async () => [];
nb.netbirdPost = async (path) => {
    if (/\/edr\/bypass$/.test(path)) { bypassed = true; return bypassAnswer; }
    return { status: 200, body: {} };
};
nb.netbirdReq = async () => ({ status: 200, body: {} });

let request, queries;
const core = require('../lib/core');
core.pool.query = async (sql, params = []) => {
    queries.push(sql);
    if (/SELECT \* FROM access_requests WHERE id=\$1/.test(sql)) return { rows: [{ ...request }] };
    if (/INSERT INTO bypass_expirations/.test(sql)) { if (!expirySaves) throw new Error('database unavailable'); return { rows: [] }; }
    if (/UPDATE access_requests SET status='approved'/.test(sql)) { request.status = 'approved'; return { rows: [] }; }
    if (/SET status='approving'/.test(sql)) { if (request.status !== 'pending') return { rows: [] }; request.status = 'approving'; return { rows: [{ id: request.id }] }; }
    if (/SET status='pending'/.test(sql)) { if (request.status === 'approving') request.status = 'pending'; return { rows: [] }; }
    return { rows: [] };
};
const { approveAccessRequest } = require('../db');

function reset(extra = {}) {
    bypassed = false; queries = []; bypassAnswer = { status: 200, body: {} }; expirySaves = false;
    request = { id: 5, kind: 'bypass', status: 'pending', requester_id: 'u1', requester_email: 'u@x', requester_name: 'U', targets: [{ id: 'p1', name: 'Laptop' }], temp_device: true, extend_bypass: false, ...extra };
}

test('an approval whose expiry cannot be saved never bypasses the device and stays pending', async () => {
    reset();
    await assert.rejects(approveAccessRequest(5, { durationMinutes: 60, actor: { name: 'admin' } }), /was not bypassed/i);
    assert.equal(bypassed, false, 'NetBird is not asked before the expiry is saved');
    assert.equal(request.status, 'pending');
});

test('an extension whose expiry cannot be saved leaves the scheduled expiry and the bypass alone', async () => {
    reset({ extend_bypass: true });
    await assert.rejects(approveAccessRequest(5, { durationMinutes: 60, actor: { name: 'admin' } }));
    assert.equal(bypassed, false);
    assert.ok(!queries.some(q => /DELETE FROM bypass_expirations/.test(q)), 'the scheduled expiry must not be dropped');
    assert.equal(request.status, 'pending');
});

test('a bypass whose answer was lost after a 429 keeps its expiry, so the bypass still ends', async () => {
    reset();
    expirySaves = true;
    bypassAnswer = { status: 429, raw: '{"message":"too many requests","code":429}', answerLost: true };
    await assert.rejects(approveAccessRequest(5, { durationMinutes: 60, actor: { name: 'admin' } }));
    assert.equal(bypassed, true);
    assert.ok(!queries.some(q => /DELETE FROM bypass_expirations/.test(q)), 'the expiry must stay while NetBird may have applied the bypass');
    assert.equal(request.status, 'pending');
});

test('a bypass NetBird refused or never received drops the expiry it saved, so the device is never deleted for it', async () => {
    for (const answer of [{ status: 400, raw: '{"message":"bad request"}' }, { status: 429, raw: '{"message":"too many requests","code":429}' }]) {
        reset();
        expirySaves = true;
        bypassAnswer = answer;
        await assert.rejects(approveAccessRequest(5, { durationMinutes: 60, actor: { name: 'admin' } }));
        assert.ok(queries.some(q => /DELETE FROM bypass_expirations/.test(q)), `status ${answer.status}`);
    }
});
