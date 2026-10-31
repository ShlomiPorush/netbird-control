// Least-privilege combo logic: a temporary grant must mirror a resource's EXISTING
// exposure (protocol/ports), never widen it. These are the invariants that keep
// "temporary access" from silently becoming "more access".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../db');
const { comboKey, combosForResource, ALL_COMBO } = _internal;
const { postureChecksFor } = require('../lib/pure');

const RES = 'res-1';

function policy(rules, extra = {}) {
    return { name: 'Some Policy', enabled: true, rules, ...extra };
}
function rule(overrides = {}) {
    return { enabled: true, action: 'accept', protocol: 'tcp', ports: [], destinations: [], ...overrides };
}

test('comboKey is insensitive to port order', () => {
    assert.equal(
        comboKey({ protocol: 'tcp', ports: ['443', '80'], portRanges: [] }),
        comboKey({ protocol: 'tcp', ports: ['80', '443'], portRanges: [] }),
    );
});

test('comboKey separates protocols, ports and ranges', () => {
    const a = comboKey({ protocol: 'tcp', ports: ['80'], portRanges: [] });
    const b = comboKey({ protocol: 'udp', ports: ['80'], portRanges: [] });
    const c = comboKey({ protocol: 'tcp', ports: [], portRanges: [{ start: 80, end: 90 }] });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
});

test('no matching policy → ALL_COMBO (nothing to mirror, grant must not be inert)', () => {
    assert.deepEqual(combosForResource([], RES, []), [ALL_COMBO]);
    // A policy that targets a DIFFERENT resource does not count.
    const pols = [policy([rule({ destinationResource: { id: 'other' }, ports: ['22'] })])];
    assert.deepEqual(combosForResource(pols, RES, []), [ALL_COMBO]);
});

test('direct destinationResource rule is mirrored exactly (the TCP-39001 scenario)', () => {
    const pols = [policy([rule({ destinationResource: { id: RES }, ports: ['39001'] })])];
    const combos = combosForResource(pols, RES, []);
    assert.equal(combos.length, 1);
    assert.deepEqual(combos[0], { protocol: 'tcp', ports: ['39001'], portRanges: [] });
});

test('rule matching via the resource’s group is mirrored', () => {
    const pols = [policy([rule({ destinations: [{ id: 'grp-a' }], protocol: 'udp', ports: ['514'] })])];
    const combos = combosForResource(pols, RES, ['grp-a', 'grp-b']);
    assert.deepEqual(combos, [{ protocol: 'udp', ports: ['514'], portRanges: [] }]);
});

test('disabled rules and non-accept rules are ignored', () => {
    const pols = [policy([
        rule({ destinationResource: { id: RES }, ports: ['22'], enabled: false }),
        rule({ destinationResource: { id: RES }, ports: ['23'], action: 'drop' }),
    ])];
    assert.deepEqual(combosForResource(pols, RES, []), [ALL_COMBO]);
});

test('identical exposures from different policies dedup into one combo', () => {
    const pols = [
        policy([rule({ destinationResource: { id: RES }, ports: ['80', '443'] })]),
        policy([rule({ destinations: [{ id: 'g' }], ports: ['443', '80'] })]),
    ];
    assert.equal(combosForResource(pols, RES, ['g']).length, 1);
});

test('different exposures stay separate (two buckets → two policies)', () => {
    const pols = [
        policy([rule({ destinationResource: { id: RES }, ports: ['80'] })]),
        policy([rule({ destinationResource: { id: RES }, protocol: 'udp', ports: ['53'] })]),
    ];
    assert.equal(combosForResource(pols, RES, []).length, 2);
});

test('port_ranges are carried through as-is', () => {
    const pols = [policy([rule({ destinationResource: { id: RES }, ports: [], port_ranges: [{ start: 39100, end: 39200 }] })])];
    const combos = combosForResource(pols, RES, []);
    assert.deepEqual(combos[0].portRanges, [{ start: 39100, end: 39200 }]);
});

test('string group ids and object group refs both match', () => {
    const pols = [policy([rule({ destinations: ['grp-str'], ports: ['8080'] })])];
    assert.equal(combosForResource(pols, RES, ['grp-str']).length, 1);
});

test('posture checks of the mirrored policy travel with the combo, normalized', () => {
    const src = [{ id: 'pc-b' }, 'pc-a', 'pc-b', null];
    const pols = [policy([rule({ destinationResource: { id: RES }, ports: ['443'] })], { source_posture_checks: src })];
    const [c] = combosForResource(pols, RES, []);
    assert.deepEqual(c.postureChecks, ['pc-a', 'pc-b']);
    assert.deepEqual(src, [{ id: 'pc-b' }, 'pc-a', 'pc-b', null]); // input untouched
});

test('same ports with different posture checks stay separate combos', () => {
    const pols = [
        policy([rule({ destinationResource: { id: RES }, ports: ['443'] })], { source_posture_checks: ['pc-a'] }),
        policy([rule({ destinationResource: { id: RES }, ports: ['443'] })]),
    ];
    assert.equal(combosForResource(pols, RES, []).length, 2);
});

test('comboKey separates posture check sets', () => {
    const base = { protocol: 'tcp', ports: ['443'], portRanges: [] };
    assert.notEqual(comboKey(base), comboKey({ ...base, postureChecks: ['pc-a'] }));
    assert.notEqual(comboKey({ ...base, postureChecks: ['pc-a'] }), comboKey({ ...base, postureChecks: ['pc-b'] }));
});

test('postureChecksFor takes the checks of the overlapping exposures only', () => {
    const exp = [
        { protocol: 'tcp', ports: ['22'], portRanges: [], postureChecks: ['pc-a'] },
        { protocol: 'tcp', ports: [], portRanges: [{ start: 8000, end: 8100 }], postureChecks: ['pc-b'] },
        { protocol: 'tcp', ports: ['443'], portRanges: [] },
    ];
    const pin = (ports, protocol = 'tcp') => ({ protocol, ports, portRanges: [] });
    assert.deepEqual(postureChecksFor(pin(['443']), exp), []);
    assert.deepEqual(postureChecksFor(pin(['22']), exp), ['pc-a']);
    assert.deepEqual(postureChecksFor(pin(['8050']), exp), ['pc-b']);
    assert.deepEqual(postureChecksFor(pin(['22', '8050']), exp), ['pc-a', 'pc-b']);
    assert.deepEqual(postureChecksFor(pin([]), exp), ['pc-a', 'pc-b']); // every port
    assert.deepEqual(postureChecksFor(pin(['22'], 'udp'), exp), ['pc-a', 'pc-b']); // no overlap → all
    assert.deepEqual(postureChecksFor(pin(['22'], 'udp'), [{ protocol: 'all', ports: [], portRanges: [], postureChecks: ['pc-c'] }]), ['pc-c']);
    assert.deepEqual(postureChecksFor(pin(['22']), [ALL_COMBO]), []); // no policy at all
});
