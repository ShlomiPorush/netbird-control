// `peer_hostname_collision_rejected` (NetBird v0.81+) is tri-state in the Tenant Defaults profile
// and version-gated on write: a profile saved before the field existed must never switch it on a
// tenant, and an older NetBird (which ignores unknown keys on PUT and answers 200) must never be
// reported as having taken it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../db');
const { normalizeTenantDefaults, nbShapeFromSettings, nbSettingsFromProfile, dropUnsupportedNbSettings } = _internal;
const KEY = 'peer_hostname_collision_rejected';

test('a profile saved before the setting existed leaves it unmanaged (null), never false', () => {
    const p = normalizeTenantDefaults({ nb: { enabled: true, lazy_connection_enabled: true } });
    assert.equal(p.nb[KEY], null);
    assert.equal(KEY in nbSettingsFromProfile(p.nb), false);
});

test('an explicit profile value is kept and written, false included', () => {
    for (const v of [true, false]) {
        const p = normalizeTenantDefaults({ nb: { [KEY]: v } });
        assert.equal(p.nb[KEY], v);
        assert.equal(nbSettingsFromProfile(p.nb)[KEY], v);
    }
    // Non-boolean junk is treated as unmanaged, not coerced.
    assert.equal(normalizeTenantDefaults({ nb: { [KEY]: 'yes' } }).nb[KEY], null);
});

test('reading live settings: absent key = not supported by this NetBird (null)', () => {
    assert.equal(nbShapeFromSettings({}, {})[KEY], null);
    assert.equal(nbShapeFromSettings({ [KEY]: false }, {})[KEY], false);
    assert.equal(nbShapeFromSettings({ [KEY]: true }, {})[KEY], true);
});

test('a write to a NetBird without the key drops it and reports it', () => {
    const patch = { [KEY]: true, lazy_connection_enabled: true };
    assert.deepEqual(dropUnsupportedNbSettings(patch, { lazy_connection_enabled: false }), [KEY]);
    assert.equal(KEY in patch, false);
    assert.equal(patch.lazy_connection_enabled, true);
});

test('a write to a NetBird that has the key keeps it', () => {
    const patch = { [KEY]: false };
    assert.deepEqual(dropUnsupportedNbSettings(patch, { [KEY]: true }), []);
    assert.equal(patch[KEY], false);
    assert.deepEqual(dropUnsupportedNbSettings({}, null), []);
});
