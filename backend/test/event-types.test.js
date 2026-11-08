// NetBird's event stream sends source_type / destination_type "UNKNOWN" for real peers and network
// resources, and Message "TYPE_UNKNOWN" with num_of_* counters. These checks cover how the app
// recovers the type from the endpoint id and the flow state from the counters, and the Routed
// filter that depends on the recovered type.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ev = require('../lib/events');

const idx = {
    peers: new Set(['peer-1']),
    resources: new Map([['res-host', 'HOST_RESOURCE'], ['res-domain', 'DOMAIN_RESOURCE'], ['res-subnet', 'SUBNET_RESOURCE']]),
};

test('an UNKNOWN or empty type gets the type of a known id', () => {
    assert.equal(ev.resolveEndpointType('res-host', 'UNKNOWN', idx), 'HOST_RESOURCE');
    assert.equal(ev.resolveEndpointType('res-domain', '', idx), 'DOMAIN_RESOURCE');
    assert.equal(ev.resolveEndpointType('res-subnet', undefined, idx), 'SUBNET_RESOURCE');
    assert.equal(ev.resolveEndpointType('peer-1', 'UNKNOWN', idx), 'PEER');
});

test('a real type from NetBird is never replaced', () => {
    assert.equal(ev.resolveEndpointType('res-host', 'PEER', idx), 'PEER');
    assert.equal(ev.resolveEndpointType('peer-1', 'BROWSER_GATEWAY', idx), 'BROWSER_GATEWAY');
});

test('an unknown id, an empty id or a missing index keeps the given value', () => {
    assert.equal(ev.resolveEndpointType('gone', 'UNKNOWN', idx), 'UNKNOWN');
    assert.equal(ev.resolveEndpointType('', 'UNKNOWN', idx), 'UNKNOWN');
    assert.equal(ev.resolveEndpointType('peer-1', 'UNKNOWN', undefined), 'UNKNOWN');
    assert.equal(ev.resolveEndpointType('peer-1', '', { peers: null, resources: null }), '');
});

test('non-string ids or types from the webhook never throw and are never classified', () => {
    const hostile = { toString: null };
    assert.doesNotThrow(() => ev.resolveEndpointType('peer-1', hostile, idx));
    assert.equal(ev.resolveEndpointType('peer-1', hostile, idx), hostile); // passed on as before
    assert.doesNotThrow(() => ev.resolveEndpointType(hostile, 'UNKNOWN', idx));
    assert.equal(ev.resolveEndpointType(hostile, 'UNKNOWN', idx), 'UNKNOWN');
    assert.equal(ev.resolveEndpointType(['peer-1'], 'UNKNOWN', idx), 'UNKNOWN');
    assert.equal(ev.resolveEndpointType(42, '', idx), '');
    assert.equal(ev.resolveEndpointType(42, null, idx), '');
});

test('the resource list is parsed whole: odd entries are skipped, never fail the read', () => {
    const m = ev.parseResourceTypes([
        { id: 'a', type: 'host' },
        { id: 'b', type: { toString: null } },
        { id: ['c'], type: 'domain' },
        null,
        { id: 'd', type: 'SUBNET' },
        { id: 'e', type: 'something-new' },
        { id: 'f', type: 'constructor' },
        { id: 'g', type: '__proto__' },
    ]);
    assert.deepEqual([...m], [['a', 'HOST_RESOURCE'], ['d', 'SUBNET_RESOURCE']]);
    assert.equal(ev.parseResourceTypes(null), null);
    assert.equal(ev.parseResourceTypes({ message: 'forbidden' }), null);
    assert.equal(ev.parseResourceTypes([]).size, 0);
});

test('one failed index source does not hide the other, and accounts stay apart', () => {
    ev.setEndpointTypeIndex('tenant-a', { peers: new Set(['p']), resources: null });
    ev.setEndpointTypeIndex('tenant-a', { peers: null, resources: new Map([['r', 'HOST_RESOURCE']]) });
    // A later failed read (null) keeps what the earlier successful read loaded.
    const a = ev.setEndpointTypeIndex('tenant-a', { peers: null, resources: null });
    assert.equal(ev.resolveEndpointType('p', 'UNKNOWN', a), 'PEER');
    assert.equal(ev.resolveEndpointType('r', 'UNKNOWN', a), 'HOST_RESOURCE');
    // A successful read of an empty list is valid and replaces the old data.
    const b = ev.setEndpointTypeIndex('tenant-b', { peers: new Set(), resources: new Map() });
    assert.equal(ev.resolveEndpointType('p', 'UNKNOWN', b), 'UNKNOWN');
    assert.equal(ev.resolveEndpointType('r', 'UNKNOWN', b), 'UNKNOWN');
});

test('counters count only as whole numbers below 2^53', () => {
    assert.equal(ev.counterValue(3), 3);
    assert.equal(ev.counterValue('7'), 7);
    assert.equal(ev.counterValue(0), 0);
    for (const bad of [-1, 1.5, '1.0', '01', ' 1', '1\n', 'abc', null, undefined, {}, [], true, 1e21, '1234567890123456']) {
        assert.equal(ev.counterValue(bad), 0, `value ${JSON.stringify(bad)}`);
    }
});

test('the flow state comes from the counters, the same way as API windows', () => {
    assert.equal(ev.deriveTrafficMessage({ num_of_starts: 1, num_of_ends: 1, num_of_drops: 0 }), 'TYPE_START');
    assert.equal(ev.deriveTrafficMessage({ num_of_starts: 0, num_of_ends: 2 }), 'TYPE_END');
    assert.equal(ev.deriveTrafficMessage({ num_of_starts: 1, num_of_drops: 3 }), 'TYPE_DROP');
    assert.equal(ev.deriveTrafficMessage({ num_of_starts: '4' }), 'TYPE_START');
    // Malformed counters count as 0, so they never decide the state.
    assert.equal(ev.deriveTrafficMessage({ num_of_starts: 'x', num_of_ends: 1 }), 'TYPE_END');
});

test('without a positive counter there is no evidence and no state is invented', () => {
    assert.equal(ev.deriveTrafficMessage({}), null);
    assert.equal(ev.deriveTrafficMessage(undefined), null);
    assert.equal(ev.deriveTrafficMessage({ num_of_starts: 0, num_of_ends: 0, num_of_drops: 0 }), null);
    assert.equal(ev.deriveTrafficMessage({ num_of_starts: -1, num_of_ends: 'abc', num_of_drops: 1e21 }), null);
});

test('the Routed filter covers host, domain and subnet resources', () => {
    const { whereClause, params } = ev.buildEventConds({ type: 'Routed' });
    assert.match(whereClause, /destination_type = ANY\(\$\d+\)/);
    const arr = params.find(Array.isArray);
    assert.deepEqual([...arr].sort(), ['DOMAIN_RESOURCE', 'HOST_RESOURCE', 'SUBNET_RESOURCE']);
});

test('the P2P filter still matches peers only', () => {
    const { whereClause, params } = ev.buildEventConds({ type: 'P2P' });
    assert.match(whereClause, /destination_type = \$\d+/);
    assert.ok(params.includes('PEER'));
});

test('each sweep index predicate is the condition the sweep can fix', () => {
    const byName = Object.fromEntries(ev.EVENT_TYPE_INDEXES.map(i => [i.name, i.cols]));
    assert.match(byName.idx_events_dst_unresolved, /^\(tenant, destination_id\) WHERE destination_type IN \('', 'UNKNOWN'\) AND destination_id <> ''$/);
    assert.match(byName.idx_events_src_unresolved, /^\(tenant, source_id\) WHERE source_type IN \('', 'UNKNOWN'\) AND source_id <> ''$/);
    assert.match(byName.idx_events_msg_unknown, /^\(tenant, id\) WHERE message = 'TYPE_UNKNOWN' AND \(/);
});
