const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MIGRATIONS, validateMigrations, opStatements } = require('../lib/migrations');
const db = require('../db');

const BASELINE_SHA256 = '52dc21bb5161c7fa5bacff0f923b4291f9e53e5530585759d88ac56199072c47';

test('the baseline schema is frozen: a schema change is a new numbered migration', () => {
    const source = db.createBaselineSchema.toString().replace(/\r\n/g, '\n');
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), BASELINE_SHA256,
        'createBaselineSchema changed. Put the change in a numbered migration in lib/migrations.js instead.');
});

test('the migration list is valid, and every migration that is not overlap-safe has a ROLLOUT_BREAKS line', () => {
    validateMigrations(MIGRATIONS);
    const breaks = fs.readFileSync(path.join(__dirname, '..', '..', 'ROLLOUT_BREAKS'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const m of MIGRATIONS.filter((x) => !x.overlapSafe)) {
        assert.ok(breaks.includes(`migration-${m.id}`), `add "migration-${m.id}" to ROLLOUT_BREAKS`);
    }
});

test('an overlap-safe migration is declarative and expand-only', () => {
    const safe = (ops) => validateMigrations([{ id: 1, overlapSafe: true, ops }]);
    assert.throws(() => validateMigrations([{ id: 1, overlapSafe: true, run: async () => { } }]), /declarative/);
    assert.throws(() => safe([{ dropColumn: { table: 'events', column: 'x' } }]), /unknown migration operation/);
    assert.throws(() => safe([{ addColumn: { table: 'events', column: { name: 'x', type: 'TEXT', notNull: true } } }]), /constant default/);
    assert.throws(() => safe([{ addColumn: { table: 'events', column: { name: 'x', type: 'TEXT', default: { now: true } } } }]), /constant default/);
    assert.throws(() => safe([{ addColumn: { table: 'events; drop table x', column: { name: 'x', type: 'TEXT' } } }]), /bad table name/);
    assert.throws(() => safe([{ addColumn: { table: 'events', column: { name: 'n', type: 'BIGSERIAL' } } }]), /rewrites the table/);
    assert.throws(() => safe([{ createTable: { name: 't', columns: [{ name: 'a', type: 'TEXT REFERENCES events(id)' }] } }]), /not allowed/);
    assert.throws(() => validateMigrations([{ id: 2, overlapSafe: true, ops: [{ addColumn: { table: 'e', column: { name: 'x', type: 'TEXT' } } }] }, { id: 2, overlapSafe: true, ops: [] }]), /increase/);
    assert.throws(() => validateMigrations([{ id: 1, ops: [] }]), /overlapSafe/);
    assert.deepEqual(opStatements({ addColumn: { table: 'events', column: { name: 'note', type: 'TEXT', notNull: true, default: "it's" } } }),
        ["ALTER TABLE events ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT 'it''s'"]);
    assert.deepEqual(opStatements({ createTable: { name: 't', columns: [{ name: 'a', type: 'TEXT' }], indexes: [
        { name: 't_open', columns: ['a'], where: { column: 'a', notEqual: 'x' } },
        { name: 't_a', columns: ['a'], unique: true, where: { column: 'a', notNull: true } },
    ] } }), [
        'CREATE TABLE IF NOT EXISTS t (a TEXT)',
        "CREATE INDEX IF NOT EXISTS t_open ON t (a) WHERE a <> 'x'",
        'CREATE UNIQUE INDEX IF NOT EXISTS t_a ON t (a) WHERE a IS NOT NULL',
    ]);
    assert.throws(() => safe([{ createTable: { name: 't', columns: [{ name: 'a', type: 'TEXT' }], indexes: [{ name: 'i', columns: ['a'], where: { column: 'a', sql: 'true' } }] } }]), /unknown index condition/);
});
