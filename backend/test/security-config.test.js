// Security-config normalization: these clamps ARE the security guarantees (the UI can
// send anything; a crafted API call can send worse). Retention is admin-controlled in
// DAYS (0 = keep forever); legacy month-based configs must convert, not vanish.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../db');
const { normSecurityConfig } = _internal;

test('retention: admin-controlled days; 0/absent = keep forever', () => {
    assert.equal(normSecurityConfig({ retentionDays: 0 }).retentionDays, 0);
    assert.equal(normSecurityConfig({}).retentionDays, 0);
    assert.equal(normSecurityConfig({ retentionDays: 90 }).retentionDays, 90);
    assert.equal(normSecurityConfig({ retentionDays: 730 }).retentionDays, 730);
});

test('retention: capped at 10 years; garbage input disables rather than crashes', () => {
    assert.equal(normSecurityConfig({ retentionDays: 999999 }).retentionDays, 3650);
    assert.equal(normSecurityConfig({ retentionDays: 'abc' }).retentionDays, 0);
    assert.equal(normSecurityConfig({ retentionDays: -5 }).retentionDays, 0);
});

test('retention: legacy month-based configs convert to days (30-day months)', () => {
    assert.equal(normSecurityConfig({ retentionMonths: 24 }).retentionDays, 720);
    assert.equal(normSecurityConfig({ retentionMonths: 36 }).retentionDays, 1080);
    // An explicit retentionDays wins over a stale legacy field.
    assert.equal(normSecurityConfig({ retentionMonths: 24, retentionDays: 90 }).retentionDays, 90);
    assert.equal(normSecurityConfig({ retentionMonths: 0 }).retentionDays, 0);
});

test('workDays can never be emptied (an empty week would alert on every action)', () => {
    assert.deepEqual(normSecurityConfig({ workDays: [] }).workDays, [0, 1, 2, 3, 4]);
    assert.deepEqual(normSecurityConfig({ workDays: [9, -1] }).workDays, [0, 1, 2, 3, 4]);
    assert.deepEqual(normSecurityConfig({ workDays: [1, 1, 3] }).workDays, [1, 3]);
});

test('session limits are clamped to sane ranges', () => {
    assert.equal(normSecurityConfig({ sessionIdleHours: 9999 }).sessionIdleHours, 168);
    assert.equal(normSecurityConfig({ sessionIdleHours: -1 }).sessionIdleHours, 0);
    assert.equal(normSecurityConfig({ adminSessionMaxHours: 'x' }).adminSessionMaxHours, 2);
});

test('unknown keys are never copied in (mass-assignment safe)', () => {
    const out = normSecurityConfig({ evil: true, __proto__: { hacked: 1 } });
    assert.equal('evil' in out, false);
    assert.equal(out.hacked, undefined);
});
