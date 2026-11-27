const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');

async function holdLocks(database) {
    const reader = await database.client();
    const writer = await database.client();
    await reader.query('BEGIN');
    await reader.query('SELECT count(*) FROM events');
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO events (id, timestamp, message) VALUES ('held', NOW(), 'held')`);
    return async () => {
        await reader.query('ROLLBACK'); await writer.query('ROLLBACK');
        await reader.end(); await writer.end();
    };
}

test('a restart runs no DDL: it starts while another instance holds a reader and a writer on events', { skip: seamSkipReason() }, async (t) => {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    cleanup(() => database.drop());
    const a = await startInstance(database.env, APP, { name: 'A' });
    cleanup(() => a.stop());
    await a.call('init');
    await a.call('sql', { text: `INSERT INTO app_settings (key, value) VALUES ('app_name', 'Seam Name') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value` });
    const release = await holdLocks(database);
    cleanup(release);
    const b = await startInstance(database.env, APP, { name: 'B' });
    cleanup(() => b.stop());
    const started = Date.now();
    await b.call('init');
    assert.ok(Date.now() - started < 3000, `the start took ${Date.now() - started} ms`);
    const migrations = await b.call('sql', { text: 'SELECT id FROM schema_migrations ORDER BY id' });
    assert.ok(migrations.some((r) => r.id === 'baseline'));
});

test('a database made by an older release keeps its data and gets the baseline once', { skip: seamSkipReason() }, async (t) => {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    cleanup(() => database.drop());
    const a = await startInstance(database.env, APP, { name: 'A' });
    cleanup(() => a.stop());
    await a.call('db', { fn: 'createBaselineSchema' });
    await a.call('sql', { text: `INSERT INTO events (id, timestamp, message) VALUES ('old', NOW(), 'kept')` });
    await a.call('init');
    const kept = await a.call('sql', { text: `SELECT message FROM events WHERE id = 'old'` });
    assert.deepEqual(kept, [{ message: 'kept' }]);
    const ids = (await a.call('sql', { text: 'SELECT id FROM schema_migrations' })).map((r) => r.id).sort();
    assert.ok(ids.includes('baseline') && ids.includes('m1'));
});

test('an overlap-safe migration waits for a busy table without blocking it and without exiting', { skip: seamSkipReason() }, async (t) => {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    cleanup(() => database.drop());
    const a = await startInstance(database.env, APP, { name: 'A' });
    cleanup(() => a.stop());
    await a.call('init');
    const reader = await database.client();
    await reader.query('BEGIN');
    await reader.query('SELECT count(*) FROM events');
    const migrating = a.call('migrate', { ops: [{ addColumn: { table: 'events', column: { name: 'seam_note', type: 'TEXT' } } }] });
    await new Promise((r) => setTimeout(r, 1000));
    const third = await database.client();
    const before = Date.now();
    await third.query('SELECT count(*) FROM events');
    assert.ok(Date.now() - before < 300, 'a third query is not stuck behind the waiting ALTER');
    await third.end();
    await reader.query('ROLLBACK');
    await reader.end();
    await migrating;
    const cols = await a.call('sql', { text: `SELECT column_name FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'seam_note'` });
    assert.equal(cols.length, 1);
});
