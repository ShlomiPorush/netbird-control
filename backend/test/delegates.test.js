// Approver delegation normalization: a malformed entry must be dropped, never saved -
// a delegation grants approval rights, so garbage in the config is a security bug.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../db');
const { normDelegates } = _internal;

const USER = { id: 'u1', email: 'X@Corp.com', name: 'X' };

test('valid entry is kept; email is lowercased', () => {
    const out = normDelegates([{ user: USER, from: '2026-07-01', until: '2026-07-20' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].user.email, 'x@corp.com');
    assert.equal(out[0].from, '2026-07-01');
});

test('entries with bad dates are dropped', () => {
    assert.equal(normDelegates([{ user: USER, from: 'tomorrow', until: '2026-07-20' }]).length, 0);
    assert.equal(normDelegates([{ user: USER, from: '2026-07-01', until: '' }]).length, 0);
    // Ends before it starts → dropped, not silently swapped.
    assert.equal(normDelegates([{ user: USER, from: '2026-07-20', until: '2026-07-01' }]).length, 0);
});

test('entries without an identifiable user are dropped', () => {
    assert.equal(normDelegates([{ user: { name: 'no id' }, from: '2026-07-01', until: '2026-07-02' }]).length, 0);
    assert.equal(normDelegates([{ from: '2026-07-01', until: '2026-07-02' }]).length, 0);
    assert.equal(normDelegates(['garbage', null, 5]).length, 0);
    assert.equal(normDelegates('not-an-array').length, 0);
});

test('a single-day delegation (from == until) is valid', () => {
    assert.equal(normDelegates([{ user: USER, from: '2026-07-15', until: '2026-07-15' }]).length, 1);
});
