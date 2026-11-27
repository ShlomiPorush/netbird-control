const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startFakeNetbird } = require('../helpers/fake-netbird');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');

test('a group change on one instance cannot undo a block made on the other', { skip: seamSkipReason() }, async (t) => {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    const nb = await startFakeNetbird();
    cleanup(async () => { await nb.close(); await database.drop(); });
    nb.state.users.push({ id: 'u1', email: 'u1@example.com', name: 'U1', role: 'user', auto_groups: ['g1'], is_blocked: false });
    nb.state.users.push({ id: 'svc', name: 'NetBird Control', role: 'admin', auto_groups: [], is_blocked: false, is_service_user: true });

    const a = await startInstance({ ...database.env, ...nb.envFor('a') }, APP, { name: 'A' });
    const b = await startInstance({ ...database.env, ...nb.envFor('b') }, APP, { name: 'B' });
    cleanup(async () => { await a.stop(); await b.stop(); });
    await a.call('init');
    await a.call('db', { fn: 'ensureUsersFresh' });

    const paused = nb.hold('GET', /^\/api\/users$/, { who: 'a', when: 'after' });
    const groupChange = a.call('db', { fn: 'setUserGroups', args: ['u1', ['g1', 'g2']] });
    await paused.reached;
    const block = b.call('db', { fn: 'setUserBlocked', args: ['u1', true] });
    await new Promise((r) => setTimeout(r, 1500));
    paused.release();
    await Promise.all([groupChange, block]);

    const user = nb.state.users.find((u) => u.id === 'u1');
    assert.equal(user.is_blocked, true, 'the block survives the group change that read the user before it');
    assert.deepEqual(user.auto_groups, ['g1', 'g2']);
});
