// Port token handling: the editors accept "80" and "39100-39200" in one list; NetBird's
// API wants singles in `ports` and ranges as {start,end} in `port_ranges`. A break here
// silently drops firewall constraints, so the round-trip must be exact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../db');
const { splitPortTokens, mergeRulePorts } = _internal;

test('splits singles and ranges into the two NetBird fields', () => {
    const r = splitPortTokens(['80', '39100-39200', ' 443 ', '', '1000 - 2000']);
    assert.deepEqual(r.ports, ['80', '443']);
    assert.deepEqual(r.portRanges, [{ start: 39100, end: 39200 }, { start: 1000, end: 2000 }]);
});

test('non-numeric junk is dropped, not passed to the API', () => {
    const r = splitPortTokens(['abc', '80x', '-', '80']);
    assert.deepEqual(r.ports, ['80']);
    assert.deepEqual(r.portRanges, []);
});

test('merge folds port_ranges back into display tokens', () => {
    assert.deepEqual(
        mergeRulePorts({ ports: ['80'], port_ranges: [{ start: 1, end: 9 }] }),
        ['80', '1-9'],
    );
    assert.deepEqual(mergeRulePorts({}), []);
});

test('split → merge → split round-trips exactly', () => {
    const first = splitPortTokens(['80', '443', '39100-39200']);
    const merged = mergeRulePorts({ ports: first.ports, port_ranges: first.portRanges });
    assert.deepEqual(splitPortTokens(merged), first);
});
