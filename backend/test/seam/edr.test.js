const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startFakeNetbird } = require('../helpers/fake-netbird');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');
const bypassCalls = (nb, who) => nb.log.filter((e) => e.method === 'POST' && /\/edr\/bypass$/.test(e.path) && (!who || e.who === who));

async function setup(t) {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    const nb = await startFakeNetbird();
    cleanup(async () => { await nb.close(); await database.drop(); });
    nb.state.peers.push({ id: 'p1', name: 'phone', os: 'Android 14', approval_required: true, user_id: 'u1', groups: [] });
    const a = await startInstance({ ...database.env, ...nb.envFor('a') }, APP, { name: 'A' });
    const b = await startInstance({ ...database.env, ...nb.envFor('b') }, APP, { name: 'B' });
    cleanup(async () => { await a.stop(); await b.stop(); });
    await a.call('init');
    await b.call('init');
    await a.call('setLeader', { leader: true });
    await b.call('setLeader', { leader: false });
    await a.call('db', { fn: 'setEdrAutoBypassConfig', args: [{ enabled: true, rules: [{ os: 'android' }] }] });
    const lists = async () => {
        const rows = await a.call('sql', { text: `SELECT key, value FROM app_settings WHERE key IN ('edr_auto_bypass_applied', 'edr_auto_bypass_revoked')` });
        const get = (k) => JSON.parse((rows.find((r) => r.key === k) || { value: '[]' }).value);
        return { applied: get('edr_auto_bypass_applied'), revoked: get('edr_auto_bypass_revoked') };
    };
    return { nb, a, b, lists };
}

test('only the leader applies the automatic EDR bypass', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, lists } = await setup(t);
    await b.call('refreshPeers');
    assert.equal(bypassCalls(nb, 'b').length, 0);
    await a.call('refreshPeers');
    assert.equal(bypassCalls(nb, 'a').length, 1);
    assert.deepEqual((await lists()).applied, ['p1']);
});

test('a revoke on the other instance while the leader applies the bypass is remembered', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, lists } = await setup(t);
    const held = nb.hold('POST', /^\/api\/peers\/p1\/edr\/bypass$/, { who: 'a', when: 'after' });
    const applying = a.call('refreshPeers');
    await held.reached;
    const revoking = b.call('db', { fn: 'revokeBypassByHuman', args: ['p1'] });
    await new Promise((r) => setTimeout(r, 1000));
    held.release();
    await applying;
    assert.equal(await revoking, true);
    assert.deepEqual(await lists(), { applied: [], revoked: ['p1'] });
    assert.equal(nb.state.bypassed.has('p1'), false);
});

test('a bypass whose answer was lost stays recorded, so a later revoke is remembered', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, lists } = await setup(t);
    const held = nb.hold('POST', /^\/api\/peers\/p1\/edr\/bypass$/, { who: 'a', when: 'after' });
    const applying = a.call('refreshPeers');
    await held.reached;
    held.release('drop');
    await applying;
    assert.deepEqual((await lists()).applied, ['p1']);
    assert.equal(await b.call('db', { fn: 'revokeBypassByHuman', args: ['p1'] }), true);
    assert.deepEqual((await lists()).revoked, ['p1']);
});
