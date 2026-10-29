// Recertification matching + config: revoked auto-approval entries are matched by
// CONTENT via stableStringify, because their detail JSON round-trips through Postgres
// JSONB which reorders object keys - a naive JSON.stringify comparison would miss.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../db');
const { stableStringify, normSecurityConfig } = _internal;

test('stableStringify is key-order independent (the JSONB round-trip case)', () => {
    const a = { groupIds: ['g1'], maxMinutes: 60, networkMode: 'all', networks: [] };
    const b = { networks: [], networkMode: 'all', maxMinutes: 60, groupIds: ['g1'] };
    assert.equal(stableStringify(a), stableStringify(b));
});

test('stableStringify recurses into nested objects and arrays', () => {
    const a = { rules: [{ x: 1, y: { b: 2, a: 1 } }] };
    const b = { rules: [{ y: { a: 1, b: 2 }, x: 1 }] };
    assert.equal(stableStringify(a), stableStringify(b));
    // Array ORDER is significant (two different rule lists must not match).
    assert.notEqual(stableStringify({ r: [1, 2] }), stableStringify({ r: [2, 1] }));
});

test('stableStringify distinguishes different content', () => {
    assert.notEqual(
        stableStringify({ groupIds: ['g1'], maxMinutes: 60 }),
        stableStringify({ groupIds: ['g1'], maxMinutes: 90 }),
    );
});

test('recert config: enabled by default, interval clamped to 30-365 days', () => {
    assert.equal(normSecurityConfig({}).recertEnabled, true);
    assert.equal(normSecurityConfig({ recertEnabled: false }).recertEnabled, false);
    assert.equal(normSecurityConfig({}).recertIntervalDays, 90);
    assert.equal(normSecurityConfig({ recertIntervalDays: 7 }).recertIntervalDays, 30);
    assert.equal(normSecurityConfig({ recertIntervalDays: 1000 }).recertIntervalDays, 365);
});
