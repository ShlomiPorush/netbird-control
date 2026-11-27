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
    nb.state.users.push({ id: 'owner', email: 'owner@example.com', name: 'Owner', role: 'owner', auto_groups: [], is_blocked: false });
    nb.state.users.push({ id: 'u1', email: 'u1@example.com', name: 'U1', role: 'admin', auto_groups: [], is_blocked: false });
    nb.state.users.push({ id: 'svc', name: 'NetBird Control', role: 'admin', auto_groups: [], is_blocked: false, is_service_user: true });
    const a = await startInstance({ ...database.env, ...nb.envFor('a') }, APP, { name: 'A' });
    const b = await startInstance({ ...database.env, ...nb.envFor('b') }, APP, { name: 'B' });
    cleanup(async () => { await a.stop(); await b.stop(); });
    await a.call('init');
    await b.call('init');
    await a.call('refreshUsers');
    const row = async () => (await a.call('sql', { text: `SELECT raw_json->>'is_blocked' AS blocked FROM users WHERE user_id = 'u1'` }))[0];
    return { nb, a, b, row };
}

test("a refresh on one instance that read the users before a block on the other does not open the user again", { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, row } = await setup(t);
    const held = nb.hold('GET', /^\/api\/users$/, { who: 'b', when: 'after' });
    const refreshing = b.call('refreshUsers');
    await held.reached;
    await a.call('db', { fn: 'setUserBlocked', args: ['u1', true] });
    held.release();
    await refreshing;
    assert.deepEqual(await row(), { blocked: 'true' });
    assert.equal((await b.call('db', { fn: 'resolveViewer', args: ['u1', 'u1@example.com'] })).blocked, true);
});

test('a refresh that read the users before a delete on the other instance does not bring the user back', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, row } = await setup(t);
    const held = nb.hold('GET', /^\/api\/users$/, { who: 'b', when: 'after' });
    const refreshing = b.call('refreshUsers');
    await held.reached;
    await a.call('db', { fn: 'deleteUser', args: ['u1'] }).catch(() => { });
    held.release();
    await refreshing;
    assert.equal(await row(), undefined);
    assert.equal(await b.call('db', { fn: 'resolveViewer', args: ['u1', 'u1@example.com'] }), null);
});

test('a block whose answer was lost keeps the user blocked until NetBird shows it, on both instances', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, row } = await setup(t);
    const held = nb.hold('PUT', /^\/api\/users\/u1$/, { who: 'a', when: 'before' });
    const blocking = a.call('db', { fn: 'setUserBlocked', args: ['u1', true] });
    await held.reached;
    assert.deepEqual(await row(), { blocked: 'true' }, 'the mirror is closed before NetBird is asked');
    assert.equal((await b.call('db', { fn: 'resolveViewer', args: ['u1', 'u1@example.com'] })).blocked, true);
    held.release('drop');
    await assert.rejects(blocking);
    await b.call('refreshUsers');
    assert.deepEqual(await row(), { blocked: 'true' }, 'the open intent keeps the mirror closed');
    assert.equal((await a.call('sql', { text: `SELECT kind FROM user_intents WHERE user_id = 'u1'` })).length, 1);
});
