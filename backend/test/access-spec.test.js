// Self-service access specs: normalization, merge semantics, and combo expansion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normAccessSpec, mergeAccessSpecs, accessSpecCombos, ALL_COMBO } = require('../lib/pure');

test('normAccessSpec: null/empty inputs mean "no restriction"', () => {
    assert.equal(normAccessSpec(null), null);
    assert.equal(normAccessSpec({}), null);
    assert.equal(normAccessSpec({ tcp: undefined, icmp: false }), null);
});

test('normAccessSpec: keeps valid tokens, drops garbage, dedupes', () => {
    const s = normAccessSpec({ tcp: ['80', '443', '80', 'abc', '0', '70000', '39100-39200', '200-100'], icmp: true });
    assert.deepEqual(s.tcp, ['80', '443', '39100-39200']);
    assert.equal(s.icmp, true);
    assert.equal('udp' in s, false);
});

test('normAccessSpec: empty list = all ports of that protocol; all-invalid list drops the protocol', () => {
    assert.deepEqual(normAccessSpec({ tcp: [] }).tcp, []);
    // ["99999"] must NOT become [] (that would widen to all ports) - the protocol is dropped.
    assert.equal(normAccessSpec({ tcp: ['99999'] }), null);
});

test('mergeAccessSpecs: port lists union; [] (all ports) beats any list; icmp sticky', () => {
    const m = mergeAccessSpecs([
        { tcp: ['80'], icmp: true },
        { tcp: ['443'], udp: ['53'] },
    ]);
    assert.deepEqual(m.tcp.sort(), ['443', '80']);
    assert.deepEqual(m.udp, ['53']);
    assert.equal(m.icmp, true);
    const all = mergeAccessSpecs([{ tcp: ['80'] }, { tcp: [] }]);
    assert.deepEqual(all.tcp, []);
    assert.equal(mergeAccessSpecs([]), null);
    assert.equal(mergeAccessSpecs([null, null]), null);
});

test('accessSpecCombos: one combo per protocol - NetBird cannot mix them in one rule', () => {
    const combos = accessSpecCombos({ tcp: ['1433', '39100-39200'], udp: ['53'], icmp: true });
    assert.equal(combos.length, 3);
    const tcp = combos.find(c => c.protocol === 'tcp');
    assert.deepEqual(tcp.ports, ['1433']);
    assert.deepEqual(tcp.portRanges, [{ start: 39100, end: 39200 }]);
    const udp = combos.find(c => c.protocol === 'udp');
    assert.deepEqual(udp.ports, ['53']);
    const icmp = combos.find(c => c.protocol === 'icmp');
    assert.deepEqual(icmp.ports, []);
});

test('accessSpecCombos: empty port list opens the whole protocol; null spec falls back to ALL', () => {
    const combos = accessSpecCombos({ tcp: [] });
    assert.equal(combos.length, 1);
    assert.equal(combos[0].protocol, 'tcp');
    assert.deepEqual(combos[0].ports, []);
    assert.deepEqual(accessSpecCombos(null), [ALL_COMBO]);
});
