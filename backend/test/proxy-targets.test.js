// Reverse-proxy target merge: the edit modal sends the full target list and the backend rebuilds
// each target from the fields it models. Fields NetBird added later (v0.81 `access_action`, which
// can block a path) and unknown `options` keys must survive a save on targets that already existed.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client BEFORE db.js loads (it destructures these at require time), so the
// real update path runs end-to-end without touching a live account.
const nb = require('../lib/netbird');
let stored = null, sent = null;
nb.netbirdGet = async () => JSON.parse(JSON.stringify(stored));
nb.netbirdReq = async (method, path, body) => { sent = { method, path, body }; return { status: 200, body: {} }; };
nb.bustReverseProxyCache = () => { };
const { updateProxyService } = require('../db');
const { mergeProxyTargets } = require('../lib/pure');

const peerRoot = { target_type: 'peer', target_id: 'p1', host: '100.64.0.1', port: 80, protocol: 'http', enabled: true, access_action: 'inherit' };
const peerAdmin = { target_type: 'peer', target_id: 'p1', host: '100.64.0.1', port: 80, protocol: 'http', path: '/admin', enabled: true, access_action: 'block', options: { skip_tls_verify: true, request_timeout: '30s' } };

test('update path: a matched target keeps access_action and unknown options keys', async () => {
    stored = { id: 'svc1', name: 'app', domain: 'app.example.com', enabled: true, targets: [peerRoot, peerAdmin] };
    // What the edit modal sends: the full list, with skip TLS turned off on /admin.
    await updateProxyService('svc1', {
        targets: [
            { type: 'peer', target_type: 'peer', id: 'p1', port: 80, protocol: 'http', enabled: true },
            { type: 'peer', target_type: 'peer', id: 'p1', port: 80, protocol: 'http', path: '/admin', enabled: true },
        ],
    });
    assert.equal(sent.method, 'PUT');
    const [root, admin] = sent.body.targets;
    assert.equal(root.access_action, 'inherit');
    assert.equal(admin.access_action, 'block');
    assert.deepEqual(admin.options, { request_timeout: '30s' }); // skip_tls_verify was turned off in the edit
});

test('unknown field and unknown options key are preserved on a matched target', () => {
    const out = mergeProxyTargets([peerAdmin], [{ target_type: 'peer', target_id: 'p1', protocol: 'http', port: 80, enabled: true, path: '/admin', options: { skip_tls_verify: true } }]);
    assert.equal(out[0].access_action, 'block');
    assert.deepEqual(out[0].options, { skip_tls_verify: true, request_timeout: '30s' });
});

test('edited modeled fields win, and modeled fields the edit omits are not resurrected', () => {
    const existing = { ...peerAdmin, options: { skip_tls_verify: true, path_rewrite: 'preserve', direct_upstream: true } };
    const out = mergeProxyTargets([existing], [{ target_type: 'peer', target_id: 'p1', protocol: 'https', port: 8443, enabled: false, path: '/admin' }]);
    assert.deepEqual(out[0], { target_type: 'peer', target_id: 'p1', protocol: 'https', port: 8443, enabled: false, path: '/admin', access_action: 'block' });
    assert.equal('host' in out[0], false);
});

test('a new target gets nothing carried over', () => {
    const fresh = { target_type: 'peer', target_id: 'p2', protocol: 'http', port: 80, enabled: true, path: '/admin' };
    const out = mergeProxyTargets([peerRoot, peerAdmin], [fresh]);
    assert.deepEqual(out, [fresh]);
    // Same peer, a path that did not exist before: also new.
    const newPath = { target_type: 'peer', target_id: 'p1', protocol: 'http', port: 80, enabled: true, path: '/api' };
    assert.deepEqual(mergeProxyTargets([peerRoot, peerAdmin], [newPath]), [newPath]);
});

test('a target removed in the UI stays removed', () => {
    const out = mergeProxyTargets([peerRoot, peerAdmin], [{ target_type: 'peer', target_id: 'p1', protocol: 'http', port: 80, enabled: true }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].path, undefined);
    assert.equal(out[0].access_action, 'inherit');
});

test('targets sharing a target_id with different paths keep their own fields', () => {
    const a = { ...peerRoot, access_action: 'bypass', custom: 'root' };
    const b = { ...peerAdmin, custom: 'admin' };
    // Reordered in the edit: matching is by key, not position.
    const out = mergeProxyTargets([a, b], [
        { target_type: 'peer', target_id: 'p1', protocol: 'http', port: 80, enabled: true, path: '/admin' },
        { target_type: 'peer', target_id: 'p1', protocol: 'http', port: 80, enabled: true },
    ]);
    assert.deepEqual([out[0].access_action, out[0].custom], ['block', 'admin']);
    assert.deepEqual([out[1].access_action, out[1].custom], ['bypass', 'root']);
});

test('path normalization: "/" and missing path are the same key', () => {
    const out = mergeProxyTargets([{ target_type: 'host', target_id: 'r1', path: '/', port: 80, x: 1 }], [{ target_type: 'host', target_id: 'r1', port: 80 }]);
    assert.equal(out[0].x, 1);
});

test('duplicate keys with identical carried fields pair in order; extras beyond them are new', () => {
    const e = { target_type: 'host', target_id: 'r1', port: 80, x: 1 };
    const out = mergeProxyTargets([e, { ...e, enabled: false }], [
        { target_type: 'host', target_id: 'r1', port: 80 },
        { target_type: 'host', target_id: 'r1', port: 80 },
        { target_type: 'host', target_id: 'r1', port: 80 },
    ]);
    assert.deepEqual(out.map(t => t.x), [1, 1, undefined]);
});

test('deleting a disabled bypass twin never moves bypass onto the live target: refused before write', () => {
    // NetBird's duplicate check ignores disabled targets, so this pair is valid stored data.
    const off = { target_type: 'peer', target_id: 'p1', port: 80, path: '/app', enabled: false, access_action: 'bypass' };
    const on = { target_type: 'peer', target_id: 'p1', port: 80, path: '/app', enabled: true, access_action: 'inherit' };
    assert.throws(() => mergeProxyTargets([off, on], [{ target_type: 'peer', target_id: 'p1', port: 80, path: '/app', enabled: true }]),
        (e) => e.status === 409 && /NetBird dashboard/.test(e.message));
    // When the edit states the field itself, nothing is ambiguous and the edit wins.
    const out = mergeProxyTargets([off, on], [{ target_type: 'peer', target_id: 'p1', port: 80, path: '/app', enabled: true, access_action: 'inherit' }]);
    assert.equal(out[0].access_action, 'inherit');
});

test('a cluster target moved to another host is a new target (custom headers never follow it)', () => {
    const e = { target_type: 'cluster', target_id: 'c.example', host: 'a.internal', port: 443, custom_headers: { Authorization: 'x' } };
    const out = mergeProxyTargets([e], [{ target_type: 'cluster', target_id: 'c.example', host: 'b.internal', port: 443 }]);
    assert.equal('custom_headers' in out[0], false);
    const same = mergeProxyTargets([e], [{ target_type: 'cluster', target_id: 'c.example', host: 'A.internal', port: 8443 }]);
    assert.deepEqual(same[0].custom_headers, { Authorization: 'x' });
});

test('no existing targets (or junk) is handled', () => {
    const t = { target_type: 'peer', target_id: 'p1', port: 80 };
    assert.deepEqual(mergeProxyTargets(undefined, [t]), [t]);
    assert.deepEqual(mergeProxyTargets([null, 'x'], [t]), [t]);
});
