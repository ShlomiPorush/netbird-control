// Creating a resource when NetBird's answer is only partly known (db.createClientResource):
//   - the resource was created but an access policy was refused or answered without a policy:
//     RESOURCE_CREATED_POLICY_FAILED, with the created resource, and no later policy is sent;
//   - no answer to the resource write, or a 2xx without an id: RESOURCE_UNCONFIRMED;
//   - once the resource write was sent, the caches of the account that was written are dropped,
//     and the Remote Access snapshot only for a main-account write.
const test = require('node:test');
const assert = require('node:assert/strict');

// ─── Stubs, before db.js and lib/remote-access.js destructure them ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] ?? null;
core.setSetting = async (k, v) => { settings[k] = v; };
core.pool.query = async () => ({ rows: [] });

const nb = require('../lib/netbird');
const { runWithTenant, currentTenantAccount } = nb;
nb.netbirdApiConfigured = () => true;
const busts = []; // [account, names]
nb.bustNbCaches = (...names) => { busts.push([currentTenantAccount() || 'main', names]); };
const posts = [];
let answers = []; // the answers to the next POSTs, in order (default: a created object)
let snapshotReads = 0;
nb.netbirdGet = async (p) => {
    if (p === '/api/users') snapshotReads++;
    if (p === '/api/groups') return [{ id: 'g-all', name: 'All' }, { id: 'g-ops', name: 'Ops' }];
    if (/^\/api\/networks\/[^/]+\/resources$/.test(p)) return [];
    return [];
};
nb.netbirdPost = async (p, body) => {
    posts.push([p, body]);
    const a = answers.shift();
    return a !== undefined ? a : { status: 200, body: { id: `id-${posts.length}`, type: 'host' } };
};
nb.netbirdReq = async () => ({ status: 200, body: {} });

const db = require('../db');
const ra = require('../lib/remote-access');

const policy = (name) => ({ name, sources: ['g-ops'], protocol: 'tcp', ports: ['3389'] });
const create = (extra = {}) => db.createClientResource('n1', { name: 'srv', address: '192.0.2.9', groups: [], allowBlocked: true, ...extra });
function reset() {
    posts.length = 0; busts.length = 0; answers = [];
    ra._internal.setConfigForTest({ enabled: true, networks: ['n1'] });
    ra._internal.setManagedForTest({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw' });
    ra._internal.resetSettlingForTest();
}
const usageBusted = (account) => busts.some(([a, names]) => a === account && names.includes('usage'));

test('a created resource with its policies is returned, and the account caches are dropped', async () => {
    reset();
    answers = [{ status: 200, body: { id: 'res-1', type: 'host' } }, { status: 200, body: { id: 'pol-1' } }];
    const out = await create({ policies: [policy('A')] });
    assert.equal(out.resource.id, 'res-1');
    assert.deepEqual(posts.map(p => p[0]), ['/api/networks/n1/resources', '/api/policies']);
    assert.ok(usageBusted('main'));
});

test('a refused policy: RESOURCE_CREATED_POLICY_FAILED with the resource, and no later policy is sent', async () => {
    reset();
    answers = [{ status: 200, body: { id: 'res-2', type: 'host' } }, { status: 200, body: { id: 'pol-a' } }, { status: 400, body: null, raw: 'bad rule' }];
    await assert.rejects(create({ policies: [policy('A'), policy('B'), policy('C')] }), (e) => {
        assert.equal(e.code, 'RESOURCE_CREATED_POLICY_FAILED');
        assert.equal(e.resource.id, 'res-2');
        assert.match(e.message, /access rules weren't all saved/);
        return true;
    });
    assert.equal(posts.length, 3, 'policy C was not sent');
    assert.ok(usageBusted('main'));
});

test('a policy answer without a policy in it counts as not saved; so does no answer', async () => {
    reset();
    answers = [{ status: 200, body: { id: 'res-3', type: 'host' } }, { status: 201, body: null, raw: '' }];
    await assert.rejects(create({ policies: [policy('A')] }), (e) => e.code === 'RESOURCE_CREATED_POLICY_FAILED' && e.resource.id === 'res-3');
    reset();
    answers = [{ status: 200, body: { id: 'res-4', type: 'host' } }, { status: 0, error: 'timeout' }];
    await assert.rejects(create({ policies: [policy('A')] }), (e) => e.code === 'RESOURCE_CREATED_POLICY_FAILED');
});

test('a 2xx policy answer without an id ({} or []) counts as not saved', async () => {
    for (const body of [{}, []]) {
        reset();
        answers = [{ status: 200, body: { id: 'res-5', type: 'host' } }, { status: 200, body }];
        await assert.rejects(create({ policies: [policy('A')] }), (e) => e.code === 'RESOURCE_CREATED_POLICY_FAILED' && e.resource.id === 'res-5', JSON.stringify(body));
    }
});

test('no answer to the resource write, or a 2xx without an id: RESOURCE_UNCONFIRMED, and no policy is sent', async () => {
    reset();
    answers = [{ status: 200, body: {} }];
    await assert.rejects(create({ policies: [policy('A')] }), (e) => e.code === 'RESOURCE_UNCONFIRMED' && /didn't confirm/.test(e.message));
    assert.equal(posts.length, 1);
    assert.ok(usageBusted('main'));
    reset();
    answers = [{ status: 0, error: 'timeout' }];
    await assert.rejects(create({ policies: [policy('A')] }), (e) => e.code === 'RESOURCE_UNCONFIRMED');
    assert.equal(posts.length, 1);
    assert.equal(ra._internal.settlingForTest(), true, 'an unanswered main-account resource write still holds new sessions back');
    ra._internal.resetSettlingForTest();
    ra._internal.clearSettleTimerForTest();
});

test('a 5xx answer to the resource write is unconfirmed (it may have been saved); a 4xx is a refusal', async () => {
    for (const status of [500, 502, 503]) {
        reset();
        answers = [{ status, body: { message: 'failed to get groups' }, raw: 'failed to get groups' }];
        await assert.rejects(create({ policies: [policy('A')] }), (e) => e.code === 'RESOURCE_UNCONFIRMED', String(status));
        assert.equal(posts.length, 1, 'no policy is sent');
    }
    for (const status of [400, 409, 422]) {
        reset();
        answers = [{ status, body: { message: 'invalid' }, raw: 'invalid' }];
        await assert.rejects(create(), (e) => !e.code && /Failed to create resource/.test(e.message), String(status));
    }
});

test('a refused resource write is a plain failure, not an unconfirmed one', async () => {
    reset();
    answers = [{ status: 422, body: { message: 'invalid address' }, raw: 'invalid address' }];
    await assert.rejects(create(), (e) => !e.code && /Failed to create resource/.test(e.message));
});

test('the Remote Access snapshot is dropped after a main-account write only', async () => {
    reset();
    await ra._internal.freshSnapshot(60_000);
    const first = snapshotReads;
    await ra._internal.freshSnapshot(60_000);
    assert.equal(snapshotReads, first, 'cached');
    await create();
    await ra._internal.freshSnapshot(60_000);
    assert.equal(snapshotReads, first + 1, 'read again after the main-account write');
    reset();
    await runWithTenant('t1', () => create());
    assert.ok(usageBusted('t1'), "the tenant's own usage cache is dropped");
    assert.equal(usageBusted('main'), false, "the main account's is not");
    await ra._internal.freshSnapshot(60_000);
    assert.equal(snapshotReads, first + 1, 'a tenant write leaves the Remote Access snapshot alone');
});
