// Per-target access actions (NetBird v0.81 `access_action`: inherit | bypass | block). The edit
// sends the value it shows; NetBird's own rules are enforced BEFORE any write: HTTP services
// only, and a NetBird-Only (private) service may Block a path but never Bypass its peer check.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client BEFORE db.js loads (it destructures these at require time).
const nb = require('../lib/netbird');
let stored = null, sent = null;
nb.netbirdGet = async () => JSON.parse(JSON.stringify(stored));
nb.netbirdReq = async (method, path, body) => { sent = { method, path, body }; return { status: 200, body: {} }; };
nb.bustReverseProxyCache = () => { };
const { updateProxyService, _internal } = require('../db');
const { proxyAccessActionError } = _internal;

const peer = (path, extra = {}) => ({ target_type: 'peer', target_id: 'p1', host: '100.64.0.1', port: 80, protocol: 'http', enabled: true, ...(path ? { path } : {}), ...extra });
const edit = (path, extra = {}) => ({ type: 'peer', target_type: 'peer', id: 'p1', port: 80, protocol: 'http', enabled: true, ...(path ? { path } : {}), ...extra });

test('the edited access action is sent and wins over the stored one', async () => {
    stored = { id: 's', mode: 'http', targets: [peer('', { access_action: 'inherit' }), peer('/admin', { access_action: 'block' })] };
    sent = null;
    await updateProxyService('s', { targets: [edit(''), edit('/admin', { accessAction: 'inherit' })] });
    assert.equal(sent.body.targets[1].access_action, 'inherit');
    assert.equal(sent.body.targets[0].access_action, 'inherit'); // unstated: stored value carried
});

test('a target that never had an action gets none (unchanged payload for older clusters)', async () => {
    stored = { id: 's', mode: 'http', targets: [peer('')] };
    sent = null;
    await updateProxyService('s', { targets: [edit('')] });
    assert.equal('access_action' in sent.body.targets[0], false);
});

test('NetBird-Only service: Block is kept, Bypass is refused before any write', async () => {
    stored = { id: 's', mode: 'http', private: true, access_groups: ['g'], targets: [peer('/admin', { access_action: 'block' })] };
    sent = null;
    await updateProxyService('s', { targets: [edit('/admin')] });
    assert.equal(sent.body.targets[0].access_action, 'block');
    sent = null;
    await assert.rejects(updateProxyService('s', { targets: [edit('/admin', { accessAction: 'bypass' })] }), (e) => e.status === 400 && /NetBird-Only/.test(e.message));
    assert.equal(sent, null);
    // Turning NetBird-Only on while a path bypasses is refused too.
    stored = { id: 's', mode: 'http', targets: [peer('/hook', { access_action: 'bypass' })] };
    await assert.rejects(updateProxyService('s', { private: true, accessGroups: ['g'] }), (e) => e.status === 400);
    assert.equal(sent, null);
});

test('non-HTTP services refuse Bypass / Block', () => {
    assert.match(proxyAccessActionError({ mode: 'tcp', targets: [{ access_action: 'block' }] }), /HTTP services/);
    assert.equal(proxyAccessActionError({ mode: 'tcp', targets: [{ access_action: 'inherit' }, {}] }), '');
    assert.equal(proxyAccessActionError({ mode: 'http', targets: [{ access_action: 'bypass' }] }), '');
});

test('an unknown access action value is rejected', async () => {
    stored = { id: 's', mode: 'http', targets: [peer('')] };
    await assert.rejects(updateProxyService('s', { targets: [edit('', { accessAction: 'open' })] }), /invalid target access action/);
});
