// Resource-address overlap: backs BOTH the create/edit uniqueness guard and the
// automations dry-run prediction. A miss here means the dry run says "create" for an
// item the real run rejects (for example a bare host vs the same host written as /32).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addressesOverlap, addressesEquivalent } = require('../lib/blocklist');

test('bare host overlaps its own /32 (the production dry-run miss)', () => {
    assert.equal(addressesOverlap('203.0.113.76', '203.0.113.76/32'), true);
    assert.equal(addressesOverlap('203.0.113.76/32', '203.0.113.76'), true);
});

test('host inside a CIDR / CIDR intersection', () => {
    assert.equal(addressesOverlap('10.0.0.5', '10.0.0.0/24'), true);
    assert.equal(addressesOverlap('10.0.0.0/24', '10.0.0.128/25'), true);
    assert.equal(addressesOverlap('10.0.1.5', '10.0.0.0/24'), false);
});

test('equivalence: same host written differently ADOPTS instead of failing', () => {
    assert.equal(addressesEquivalent('203.0.113.76', '203.0.113.76/32'), true);
    assert.equal(addressesEquivalent('10.0.0.0/24', '10.0.0.0/24'), true);
    assert.equal(addressesEquivalent('DB.Example.com', 'db.example.com'), true);
    // Overlap without equivalence stays a failure, not an adoption.
    assert.equal(addressesEquivalent('10.0.0.5', '10.0.0.0/24'), false);
    assert.equal(addressesEquivalent('10.0.0.0/24', '10.0.0.128/25'), false);
    assert.equal(addressesEquivalent('*.example.com', 'db.example.com'), false);
});

test('domains: exact and wildcard coverage only', () => {
    assert.equal(addressesOverlap('db.example.com', 'db.example.com'), true);
    assert.equal(addressesOverlap('*.example.com', 'db.example.com'), true);
    assert.equal(addressesOverlap('db.example.com', 'other.example.com'), false);
    // An IP never overlaps a domain.
    assert.equal(addressesOverlap('10.0.0.5', 'db.example.com'), false);
});
