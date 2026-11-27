const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startFakeNetbird } = require('../helpers/fake-netbird');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');
const NB = { gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' };
const RDP = { protocol: 'rdp', address: '10.0.0.5', port: 3389 };
const U1 = { user_id: 'u1', email: 'u1@example.com', name: 'U1' };
const U2 = { user_id: 'u2', email: 'u2@example.com', name: 'U2' };
const RESOURCE = /^\/api\/networks\/n1\/resources\/r1$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function world(state, warm) {
    state.users.push(
        { id: 'u1', email: 'u1@example.com', name: 'U1', role: 'user', auto_groups: ['g-staff'], is_blocked: false },
        { id: 'u2', email: 'u2@example.com', name: 'U2', role: 'user', auto_groups: ['g-staff'], is_blocked: false });
    state.peers.push(
        { id: 'p-gw', name: 'gw', groups: [{ id: 'g-gw' }], connected: true },
        { id: 'p-r', name: 'router', groups: [], connected: true });
    const group = (id, name, extra = {}) => ({ id, name, peers: [], resources: [], ...extra });
    state.groups.push(
        group('g-gw', 'Browser Gateway', { peers: [{ id: 'p-gw' }] }),
        group('g-gwt', 'Browser Gateway Targets', { resources: warm ? [{ id: 'r1', type: 'host' }] : [] }),
        group('g-ngw', 'Browser Gateway Names'), group('g-ngwt', 'Browser Gateway Name Targets'),
        group('g-staff', 'Staff'), group('g-srv', 'Servers'));
    state.policies.push(
        { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: [], sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
        { id: 'pol-staff', name: 'Staff', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] });
    state.resources.push({ id: 'r1', network_id: 'n1', name: 'srv1', type: 'host', address: '10.0.0.5/32', description: '', enabled: true, groups: [{ id: 'g-srv' }, ...(warm ? [{ id: 'g-gwt' }] : [])] });
    state.networks.push({ id: 'n1', name: 'Office', resources: ['r1'], routers: ['rt1'] });
    state.routers.push({ id: 'rt1', network_id: 'n1', peer: 'p-r', enabled: true });
}

async function setup(t, { cfg = {}, warm = true } = {}) {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    const nb = await startFakeNetbird();
    cleanup(async () => { await nb.close(); await database.drop(); });
    world(nb.state, warm);
    const a = await startInstance({ ...database.env, ...nb.envFor('a') }, APP, { name: 'A' });
    const b = await startInstance({ ...database.env, ...nb.envFor('b') }, APP, { name: 'B' });
    cleanup(async () => { await a.stop(); await b.stop(); });
    await a.call('init');
    await b.call('init');
    await a.call('db', { fn: 'setSetting', args: ['remote_access_config', JSON.stringify({ enabled: true, networks: ['n1'], ...cfg })] });
    await a.call('db', { fn: 'setSetting', args: ['remote_access_nb', JSON.stringify(NB)] });
    for (const x of [a, b]) await x.call('db', { fn: 'ensureSettingsCurrent' });
    const another = async () => {
        const c = await startInstance({ ...database.env, ...nb.envFor('a') }, APP, { name: 'C' });
        cleanup(() => c.stop());
        await c.call('init');
        return c;
    };
    return { nb, a, b, another };
}

const groupReadsBy = (nb, who) => nb.log.filter((e) => e.who === who && e.method === 'GET' && /^\/api\/groups\/g-/.test(e.path));

test("a session start's target write on one instance holds the target sync on the other until it is answered", { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b } = await setup(t, { warm: false });
    const held = nb.hold('PUT', RESOURCE, { who: 'a', when: 'before' });
    const starting = a.call('raSession', { viewer: U1, body: RDP });
    await held.reached;
    const syncing = b.call('raInternal', { fn: 'syncTargetGroup' });
    await sleep(1500);
    assert.equal(groupReadsBy(nb, 'b').length, 0, 'the sync waits for the write');
    const putAt = nb.log.findIndex((e) => e.who === 'a' && e.method === 'PUT' && RESOURCE.test(e.path));
    held.release();
    await syncing;
    assert.ok(nb.log.findIndex((e) => e.who === 'b' && e.method === 'GET' && /^\/api\/groups\/g-/.test(e.path)) > putAt, 'the sync read the groups after the write');
    assert.equal((await starting).ok, true, JSON.stringify(await starting));
});

test("a Remote Access settings change on one instance is in effect for the other instance's next target sync", { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b } = await setup(t);
    assert.equal((await a.call('raSession', { viewer: U1, body: RDP })).ok, true);
    await b.call('raInternal', { fn: 'syncTargetGroup' });
    assert.deepEqual(nb.state.groups.find((g) => g.id === 'g-gwt').resources, [{ id: 'r1', type: 'host' }], 'the open server stays while its network is open');
    await a.call('db', { fn: 'setSetting', args: ['remote_access_config', JSON.stringify({ enabled: true, networks: [] })] });
    await b.call('raInternal', { fn: 'syncTargetGroup' });
    assert.deepEqual(nb.state.groups.find((g) => g.id === 'g-gwt').resources, [], 'the server left the target group of a network no longer open');
});

test('an unanswered target write on one instance makes the other refuse new sessions until a sync that started after the deadline', { skip: seamSkipReason() }, async (t) => {
    const { a, b, nb } = await setup(t, { warm: false });
    const held = nb.hold('PUT', RESOURCE, { who: 'a', when: 'before' });
    const starting = a.call('raSession', { viewer: U1, body: RDP });
    await held.reached;
    held.release('drop');
    assert.equal((await starting).code, 'TARGET_OPEN_FAILED');
    assert.equal(await b.call('ra', { fn: 'isSettling' }), true);
    assert.equal((await b.call('raSession', { viewer: U2, body: RDP })).code, 'TARGETS_SETTLING');
    await a.call('raInternal', { fn: 'passSettleDeadlineForTest' });
    await b.call('raInternal', { fn: 'passSettleDeadlineForTest' });
    assert.equal(await b.call('ra', { fn: 'isSettling' }), true, 'the deadline alone does not end it');
    await a.call('raInternal', { fn: 'syncTargetGroup' });
    assert.equal(await b.call('ra', { fn: 'isSettling' }), false);
    assert.equal((await b.call('raSession', { viewer: U2, body: RDP })).ok, true);
});

test('an instance killed while its target write is on the way leaves the other refusing new sessions until the deadline passed and a later sync finished', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b } = await setup(t, { warm: false });
    await b.call('raLeader', { leader: true });
    const held = nb.hold('PUT', RESOURCE, { who: 'a', when: 'before' });
    a.call('raSession', { viewer: U1, body: RDP }).catch(() => { });
    await held.reached;
    await a.kill();
    assert.equal((await b.call('raSession', { viewer: U2, body: RDP })).code, 'TARGETS_SETTLING', 'the check under the targets lock sees the write that never got an answer');
    const pending = () => b.call('sql', { text: `SELECT key FROM coordination WHERE key LIKE 'ra_pending:%'` });
    assert.equal((await pending()).length, 1);
    const before = Date.now();
    await b.call('ra', { fn: 'followSharedSettling' });
    assert.equal((await pending()).length, 0, 'the leader turned the row into a deadline');
    const [deadline] = await b.call('sql', { text: `SELECT value FROM coordination WHERE key = 'ra_settle_until'` });
    assert.ok(Number(deadline.value) >= before + 90_000, 'the deadline runs from the conversion');
    assert.equal(await b.call('ra', { fn: 'isSettling' }), true);
    await b.call('raInternal', { fn: 'passSettleDeadlineForTest' });
    assert.equal(await b.call('ra', { fn: 'isSettling' }), true, 'the deadline alone does not end it');
    await b.call('raInternal', { fn: 'syncTargetGroup' });
    assert.equal(await b.call('ra', { fn: 'isSettling' }), false);
    assert.equal((await b.call('raSession', { viewer: U2, body: RDP })).ok, true);
});

test("the leader turns a stopped writer's row into a deadline even when another instance holds the targets lock at its tick", { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b, another } = await setup(t, { warm: false });
    const c = await another();
    await b.call('raLeader', { leader: true });
    const held = nb.hold('PUT', RESOURCE, { who: 'a', when: 'before' });
    a.call('raSession', { viewer: U1, body: RDP }).catch(() => { });
    await held.reached;
    await a.kill();
    const pending = () => b.call('sql', { text: `SELECT key FROM coordination WHERE key LIKE 'ra_pending:%'` });
    await c.call('holdLock', { kind: 'targets', parts: ['remote-access'], name: 'c-targets' });
    await c.waitFor('held:c-targets');
    let done = false;
    const following = b.call('ra', { fn: 'followSharedSettling' }).then(() => { done = true; });
    await sleep(1000);
    assert.equal(done, false, 'the follow-up waits for the lock');
    assert.equal((await pending()).length, 1);
    c.release('c-targets');
    await following;
    assert.equal((await pending()).length, 0, 'converted once the lock was free');
    assert.equal(await b.call('ra', { fn: 'isSettling' }), true);
});

test('two Remote Access saves that overlap keep both changes: one turns it off, the other changes only a browser field', { skip: seamSkipReason() }, async (t) => {
    const { a, b } = await setup(t);
    await a.call('holdLock', { kind: 'targets', parts: ['remote-access'], name: 'a-targets' });
    await a.waitFor('held:a-targets');
    const off = a.call('ra', { fn: 'setRemoteAccessConfig', args: [{ enabled: false }] }).catch((e) => e);
    await sleep(500);
    const browser = b.call('ra', { fn: 'setRemoteAccessConfig', args: [{ browser: { keepAliveMin: 25 } }] }).catch((e) => e);
    await sleep(500);
    a.release('a-targets');
    await off;
    await browser;
    const saved = JSON.parse((await b.call('sql', { text: `SELECT value FROM app_settings WHERE key = 'remote_access_config'` }))[0].value);
    assert.equal(saved.enabled, false, 'still off');
    assert.equal(saved.browser.keepAliveMin, 25, 'with the browser change');
});

test('a launch network release that overlaps a Remote Access settings save keeps both changes', { skip: seamSkipReason() }, async (t) => {
    const { a, b } = await setup(t, { cfg: { createResources: { enabled: false, networkId: 'n9' } } });
    await a.call('holdLock', { kind: 'targets', parts: ['remote-access'], name: 'a-targets' });
    await a.waitFor('held:a-targets');
    const saving = a.call('ra', { fn: 'setRemoteAccessConfig', args: [{ idleTimeoutMin: 45 }] }).catch((e) => e);
    await sleep(500);
    const releasing = b.call('db', { fn: 'releaseLaunchNetwork', args: [U2] }).catch((e) => e);
    await sleep(500);
    a.release('a-targets');
    await saving;
    await releasing;
    const saved = JSON.parse((await b.call('sql', { text: `SELECT value FROM app_settings WHERE key = 'remote_access_config'` }))[0].value);
    assert.equal(saved.idleTimeoutMin, 45, 'with the settings change');
    assert.equal(saved.createResources.networkId, '', 'and without the released network');
});

test('a Remote Access settings save raises the targets generation and writes the setting only while it holds the targets lock', { skip: seamSkipReason() }, async (t) => {
    const { a, b } = await setup(t);
    const gen = async () => ((await b.call('sql', { text: `SELECT value FROM coordination WHERE key = 'ra_targets_gen'` }))[0] || {}).value || '';
    const saved = async () => JSON.parse((await b.call('sql', { text: `SELECT value FROM app_settings WHERE key = 'remote_access_config'` }))[0].value).maxSessionsPerUser;
    const genBefore = await gen();
    await b.call('holdLock', { kind: 'targets', parts: ['remote-access'], name: 'b-targets' });
    await b.waitFor('held:b-targets');
    const saving = a.call('ra', { fn: 'setRemoteAccessConfig', args: [{ maxSessionsPerUser: 3 }] }).catch(() => { });
    await sleep(1000);
    assert.equal(await gen(), genBefore, 'no raise while another instance holds the lock');
    assert.notEqual(await saved(), 3, 'no write while another instance holds the lock');
    b.release('b-targets');
    await saving;
    assert.notEqual(await gen(), genBefore);
    assert.equal(await saved(), 3);
});

test('a target write on its way on one instance does not refuse the other instance, whose session start waits for it under the targets lock', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b } = await setup(t, { warm: false });
    const held = nb.hold('PUT', RESOURCE, { who: 'a', when: 'before' });
    const first = a.call('raSession', { viewer: U1, body: RDP });
    await held.reached;
    assert.equal(await b.call('ra', { fn: 'isSettling' }), false);
    const check = await b.call('ra', { fn: 'checkAccess', args: [U2, RDP] });
    assert.deepEqual(check.steps.map((s) => [s.key, s.status]), [['access', 'pass'], ['path', 'pass']]);
    await b.call('raLeader', { leader: true });
    await b.call('sql', { text: `UPDATE coordination SET value = $1 WHERE key LIKE 'ra_pending:%'`, params: [String(Date.now() - 120_000)] });
    const following = b.call('ra', { fn: 'followSharedSettling' });
    await sleep(500);
    assert.equal((await b.call('sql', { text: `SELECT key FROM coordination WHERE key LIKE 'ra_pending:%'` })).length, 1, 'the leader leaves the row of a writer that still holds the lock, however old');
    assert.equal(await b.call('ra', { fn: 'isSettling' }), false);
    let answered = false;
    const second = b.call('raSession', { viewer: U2, body: RDP }).then((out) => { answered = true; return out; });
    await sleep(1500);
    assert.equal(answered, false, 'the session start waits for the write');
    held.release();
    assert.equal((await first).ok, true);
    await following;
    assert.equal((await second).ok, true, JSON.stringify(await second));
    assert.equal(await b.call('ra', { fn: 'isSettling' }), false, 'an answered write leaves no deadline');
});

test('a targets change on one instance while a session start on the other waits to issue its token makes it refuse', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b } = await setup(t);
    const resourceRead = nb.hold('GET', RESOURCE, { who: 'b', when: 'before' });
    const starting = b.call('raSession', { viewer: U1, body: RDP });
    await resourceRead.reached;
    const lastRead = nb.hold('GET', /^\/api\/users$/, { who: 'b', when: 'after' });
    resourceRead.release();
    await lastRead.reached;
    await a.call('holdLock', { kind: 'targets', parts: ['remote-access'], name: 'a-targets' });
    lastRead.release();
    await a.waitFor('held:a-targets');
    await sleep(1000);
    await a.call('ra', { fn: 'noteTargetsChanged' });
    a.release('a-targets');
    assert.equal((await starting).code, 'TARGETS_SETTLING');
});

test('an unanswered target write on a standby makes the leader schedule the follow-up sync', { skip: seamSkipReason() }, async (t) => {
    const { a, b } = await setup(t);
    await a.call('raLeader', { leader: true });
    await b.call('raLeader', { leader: false });
    await b.call('ra', { fn: 'noteUncertainTargetWrite' });
    assert.equal(await a.call('raInternal', { fn: 'settleTimerPendingForTest' }), false);
    await a.call('ra', { fn: 'followSharedSettling' });
    assert.equal(await a.call('raInternal', { fn: 'settleTimerPendingForTest' }), true);
    assert.equal(await a.call('ra', { fn: 'isSettling' }), true);
});

test('a targets change on one instance makes a session start on the other that read the old generation refuse', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b } = await setup(t);
    const resourceRead = nb.hold('GET', RESOURCE, { who: 'b', when: 'before' });
    const starting = b.call('raSession', { viewer: U1, body: RDP });
    await resourceRead.reached;
    const lastRead = nb.hold('GET', /^\/api\/users$/, { who: 'b', when: 'after' });
    resourceRead.release();
    await lastRead.reached;
    await a.call('ra', { fn: 'noteTargetsChanged' });
    lastRead.release();
    assert.equal((await starting).code, 'TARGETS_SETTLING');
    assert.equal((await b.call('raSession', { viewer: U1, body: RDP })).ok, true, 'the next try opens');
});

test('the per-user session limit holds across both instances', { skip: seamSkipReason() }, async (t) => {
    const { a, b } = await setup(t, { cfg: { maxSessionsPerUser: 1 } });
    assert.equal((await a.call('raSession', { viewer: U1, body: RDP })).ok, true);
    assert.equal((await b.call('raSession', { viewer: U1, body: RDP })).code, 'TOO_MANY');
    assert.equal((await b.call('raSession', { viewer: U2, body: RDP })).ok, true, 'another user still gets one');
});

test('two instances starting sessions at once for the last slot give it to one of them only', { skip: seamSkipReason() }, async (t) => {
    const { nb, a, b } = await setup(t, { cfg: { maxSessionsTotal: 1 } });
    const routersA = nb.hold('GET', /^\/api\/networks\/n1\/routers$/, { who: 'a', when: 'after' });
    const routersB = nb.hold('GET', /^\/api\/networks\/n1\/routers$/, { who: 'b', when: 'after' });
    const first = a.call('raSession', { viewer: U1, body: RDP });
    const second = b.call('raSession', { viewer: U2, body: RDP });
    await Promise.all([routersA.reached, routersB.reached]);
    routersA.release();
    routersB.release();
    const outcomes = [await first, await second];
    assert.equal(outcomes.filter((o) => o.ok).length, 1, JSON.stringify(outcomes));
    assert.deepEqual(outcomes.filter((o) => !o.ok).map((o) => o.code), ['TOO_MANY_TOTAL']);
});
