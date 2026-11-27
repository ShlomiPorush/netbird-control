const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');

async function setup(t) {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    cleanup(() => database.drop());
    const a = await startInstance(database.env, APP, { name: 'A' });
    const b = await startInstance(database.env, APP, { name: 'B' });
    cleanup(async () => { await a.stop(); await b.stop(); });
    await a.call('init');
    await b.call('init');
    return { a, b };
}

test('"Run now" on one instance is skipped while the other runs the same automation', { skip: seamSkipReason() }, async (t) => {
    const { a, b } = await setup(t);
    const [{ id }] = await a.call('sql', { text: `INSERT INTO automations (name, network_id, enabled, interval_minutes, tenant) VALUES ('x', 'n1', true, 60, '') RETURNING id` });
    await a.call('holdLock', { kind: 'automation', parts: ['', String(id)], name: 'run' });
    const out = await b.call('db', { fn: 'runAutomation', args: [id, { trigger: 'manual' }] });
    assert.deepEqual(out, { skipped: true, reason: 'already running' });
    a.release('run');
});

test('a stuck run flag is cleared only when no instance runs it any more', { skip: seamSkipReason() }, async (t) => {
    const { a, b } = await setup(t);
    const [{ id }] = await a.call('sql', { text: `INSERT INTO automations (name, network_id, enabled, interval_minutes, tenant, last_status) VALUES ('x', 'n1', true, 60, '', 'running') RETURNING id` });
    await a.call('holdLock', { kind: 'automation', parts: ['', String(id)], name: 'run' });
    await b.call('db', { fn: 'resetAllStuckRuns' });
    const status = async () => (await a.call('sql', { text: 'SELECT last_status FROM automations WHERE id = $1', params: [id] }))[0].last_status;
    assert.equal(await status(), 'running');
    a.release('run');
    await new Promise((r) => setTimeout(r, 300));
    await b.call('db', { fn: 'resetAllStuckRuns' });
    assert.equal(await status(), '');
});

test('the cleanup job on one instance leaves a grant alone while the other is still creating it', { skip: seamSkipReason() }, async (t) => {
    const { a, b } = await setup(t);
    const [{ id }] = await a.call('sql', { text: `INSERT INTO temporary_access_grants (user_id, user_label, targets, expires_at, status, tenant, issued_at) VALUES ('u1', 'u1', '[]', NOW() + interval '1 hour', 'creating', '', NOW() - interval '1 hour') RETURNING id` });
    await a.call('holdLock', { kind: 'grant', parts: ['', String(id)], name: 'create' });
    await b.call('db', { fn: 'cleanupStuckCreatingGrants' }).catch(() => { });
    assert.equal((await a.call('sql', { text: 'SELECT status FROM temporary_access_grants WHERE id = $1', params: [id] })).length, 1);
    a.release('create');
});
