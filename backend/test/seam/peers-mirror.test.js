const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startFakeNetbird } = require('../helpers/fake-netbird');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');

test('a device change seen by refreshes on both instances is queued for notification once', { skip: seamSkipReason() }, async (t) => {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    const nb = await startFakeNetbird();
    cleanup(async () => { await nb.close(); await database.drop(); });
    nb.state.peers.push({ id: 'p1', name: 'laptop', os: 'Windows 11', country_code: 'DE', user_id: 'u1', groups: [] });
    const a = await startInstance({ ...database.env, ...nb.envFor('a') }, APP, { name: 'A' });
    const b = await startInstance({ ...database.env, ...nb.envFor('b') }, APP, { name: 'B' });
    cleanup(async () => { await a.stop(); await b.stop(); });
    await a.call('init');
    await a.call('db', { fn: 'setSecurityConfig', args: [{ anomalyEnabled: true }] });
    await a.call('db', { fn: 'setTelegramConfig', args: [{ enabled: true, chatId: '-1', token: crypto.randomBytes(16).toString('hex') }] });
    await b.call('init');
    await a.call('refreshPeers');
    nb.state.peers[0].country_code = 'FR';
    const held = nb.hold('GET', /^\/api\/peers$/, { who: 'b', when: 'after' });
    const first = b.call('refreshPeers');
    await held.reached;
    const second = a.call('refreshPeers');
    await new Promise((r) => setTimeout(r, 800));
    held.release();
    await Promise.all([first, second]);
    const queued = await a.call('sql', { text: `SELECT channel FROM outbox` });
    assert.deepEqual(queued, [{ channel: 'anomaly-alert' }]);
});
