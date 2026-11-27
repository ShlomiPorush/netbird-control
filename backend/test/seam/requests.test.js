const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startFakeNetbird } = require('../helpers/fake-netbird');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');

async function setup(t) {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    const nb = await startFakeNetbird();
    cleanup(async () => { await nb.close(); await database.drop(); });
    nb.state.peers.push({ id: 'p1', name: 'laptop', os: 'Windows 11', approval_required: true, user_id: 'u1', groups: [] });
    const a = await startInstance({ ...database.env, ...nb.envFor('a') }, APP, { name: 'A' });
    const b = await startInstance({ ...database.env, ...nb.envFor('b') }, APP, { name: 'B' });
    cleanup(async () => { await a.stop(); await b.stop(); });
    await a.call('init');
    await b.call('init');
    const [{ id }] = await a.call('sql', { text: `INSERT INTO access_requests (requester_id, requester_email, requester_name, targets, reason, requested_minutes, kind, status) VALUES ('u1', 'u1@example.com', 'U1', '[{"id":"p1","name":"laptop"}]', 'work', 0, 'bypass', 'pending') RETURNING id` });
    const status = async () => (await b.call('sql', { text: 'SELECT status FROM access_requests WHERE id = $1', params: [id] }))[0].status;
    return { nb, a, b, id, status };
}

test('a deny on one instance while the other approves the same request decides it once', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, id, status } = await setup(t);
    const held = nb.hold('POST', /^\/api\/peers\/p1\/edr\/bypass$/, { who: 'a', when: 'before' });
    const approving = a.call('db', { fn: 'approveAccessRequest', args: [id, { durationMinutes: 0, actor: { name: 'Admin A' } }] });
    await held.reached;
    assert.equal(await status(), 'approving');
    const denying = b.call('db', { fn: 'denyAccessRequest', args: [id, { reason: 'no', actor: { name: 'Admin B' } }] });
    await new Promise((r) => setTimeout(r, 500));
    held.release();
    await approving;
    await assert.rejects(denying, /already been handled/);
    assert.equal(await status(), 'approved');
});

test('an approval left half way by a stopped instance is finished by the leader from what NetBird shows', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, id, status } = await setup(t);
    const held = nb.hold('POST', /^\/api\/peers\/p1\/edr\/bypass$/, { who: 'a', when: 'before' });
    a.call('db', { fn: 'approveAccessRequest', args: [id, { durationMinutes: 0, actor: { name: 'Admin A' } }] }).catch(() => { });
    await held.reached;
    await a.kill();
    held.release('drop');
    assert.equal(await status(), 'approving');
    await b.call('db', { fn: 'reconcileApprovingRequests' });
    assert.equal(await status(), 'pending');
    assert.equal(nb.state.bypassed.has('p1'), false);
});
