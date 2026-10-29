// Peer interfaces (NetBird v0.81+ `network_addresses`) drive the MAC search and the peer detail
// page. Older servers omit the field and a mirror row may hold anything, so the mapper must
// never throw and must always return an array.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { peerNetworkAddresses } = require('../lib/pure');

test('maps net_ip + mac into { ip, mac }', () => {
    const raw = { network_addresses: [{ net_ip: '192.168.0.11/24', mac: '00:93:37:bd:83:0f' }] };
    assert.deepEqual(peerNetworkAddresses(raw), [{ ip: '192.168.0.11/24', mac: '00:93:37:bd:83:0f' }]);
});

test('older servers (field absent) and malformed values give an empty list', () => {
    assert.deepEqual(peerNetworkAddresses({}), []);
    assert.deepEqual(peerNetworkAddresses(null), []);
    assert.deepEqual(peerNetworkAddresses({ network_addresses: 'x' }), []);
    assert.deepEqual(peerNetworkAddresses({ network_addresses: [null, 5, 'a', {}, { net_ip: 7, mac: {} }] }), []);
});

test('keeps an interface that has only an IP or only a MAC, trims, and drops duplicates', () => {
    const raw = { network_addresses: [
        { net_ip: ' 10.1.2.3/8 ', mac: '' },
        { net_ip: '', mac: 'AA:BB:CC:DD:EE:FF' },
        { net_ip: '', mac: 'aa:bb:cc:dd:ee:ff' },
    ] };
    assert.deepEqual(peerNetworkAddresses(raw), [{ ip: '10.1.2.3/8', mac: '' }, { ip: '', mac: 'AA:BB:CC:DD:EE:FF' }]);
});
