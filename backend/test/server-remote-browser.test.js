const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ssoServer } = require('./helpers/sso-server');

const h = ssoServer();
const USERS = { remote: { perms: ['remote.connect'] }, admin: { role: 'admin' }, plain: {} };
const calls = [];
let ra;
let rb;
let endImpl = async () => true;
let leaseImpl = async () => true;

before(async () => {
    await h.start({
        beforeRequire(db) {
            Object.assign(db, {
                ensureUsersFresh: async () => { },
                ensurePeersFresh: async () => { },
                resolveViewer: async (oid) => (USERS[oid] ? { user_id: oid, role: USERS[oid].role || 'user', name: oid, email: `${oid}@example.com`, auto_groups: [], blocked: false } : null),
                fetchUserGroups: async () => [],
                getUserPeerGroupIds: async () => [],
                getApproverGroupIds: () => [],
                isActiveDelegate: async () => false,
                resolveFeaturePerms: ({ isAdmin, userId } = {}) => (isAdmin ? { 'remote.connect': true }
                    : Object.fromEntries(((USERS[userId] && USERS[userId].perms) || []).map((p) => [p, true]))),
                recordAudit: async () => { },
            });
            ra = require('../lib/remote-access');
            ra.createGatewaySetupKey = async (kind) => { calls.push(['setup-key', kind]); return { key: 'not-a-real-key', expires: '', name: kind }; };
            ra.createSession = async () => { calls.push(['rdp-session']); return { sessionId: 'rdp' }; };
            ra.endSession = () => false;
            ra.renewLease = () => false;
            rb = require('../lib/remote-browser');
            Object.assign(rb, {
                createWebSession: async (viewer, body) => { calls.push(['web-session', viewer.user_id, body.protocol]); return { sessionId: 'w1', token: 't', protocol: 'web', keepAliveMin: 15 }; },
                resumeWebSession: async (viewer, id) => { calls.push(['resume', viewer.user_id, id]); return { sessionId: id, token: 't2', protocol: 'web', keepAliveMin: 15 }; },
                listWebSessions: async (viewer) => ({ keepAliveMin: 15, sessions: [{ id: 'w1', state: 'detached', owner: viewer.user_id }] }),
                renewWebLease: async (...args) => leaseImpl(...args),
                endWebSessionByUser: async (...args) => endImpl(...args),
                onConfigChanged: () => Promise.resolve(),
            });
        },
    });
});
after(() => h.stop());

const config = (browser) => ra._internal.setConfigForTest({ enabled: true, allowAll: false, networks: [], browser });

test('info offers web sessions only while they are on, with the keep-alive', async () => {
    config({ enabled: true, routerGroupId: 'g-office', keepAliveMin: 25 });
    let r = await h.call('remote', 'GET', '/api/remote-access/info');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.browser, { keepAliveMin: 25 });
    r = await h.call('plain', 'GET', '/api/remote-access/info');
    assert.equal(r.json.browser, undefined, 'not for a user without Remote Access');
    config({ enabled: false, routerGroupId: 'g-office' });
    r = await h.call('remote', 'GET', '/api/remote-access/info');
    assert.equal(r.json.browser, undefined);
});

test('a session with protocol web goes to the remote browser, any other to RDP/SSH', async () => {
    config({ enabled: true, routerGroupId: 'g-office' });
    calls.length = 0;
    let r = await h.call('remote', 'POST', '/api/remote-access/sessions', { protocol: 'web', width: 1280, height: 720 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { sessionId: 'w1', token: 't', protocol: 'web', keepAliveMin: 15 });
    r = await h.call('remote', 'POST', '/api/remote-access/sessions', { protocol: 'rdp', address: '10.0.0.5', port: 3389 });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [['web-session', 'remote', 'web'], ['rdp-session']]);
});

test('lease, DELETE, list and resume reach web sessions on any instance; an ended one answers 410', async () => {
    config({ enabled: true, routerGroupId: 'g-office' });
    let r = await h.call('remote', 'POST', '/api/remote-access/sessions/w1/lease');
    assert.equal(r.status, 200);
    leaseImpl = async () => false;
    r = await h.call('remote', 'POST', '/api/remote-access/sessions/w1/lease');
    assert.equal(r.status, 404);
    r = await h.call('remote', 'DELETE', '/api/remote-access/sessions/w1');
    assert.equal(r.status, 200);
    endImpl = async () => { throw ra.httpError(410, 'BROWSER_ENDED', 'This web session has ended.'); };
    r = await h.call('remote', 'DELETE', '/api/remote-access/sessions/w1');
    assert.equal(r.status, 410);
    assert.equal(r.json.code, 'BROWSER_ENDED');
    r = await h.call('remote', 'GET', '/api/remote-access/web-sessions');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.sessions, [{ id: 'w1', state: 'detached', owner: 'remote' }]);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    calls.length = 0;
    r = await h.call('remote', 'POST', '/api/remote-access/sessions/w1/resume', { width: 800, height: 600 });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [['resume', 'remote', 'w1']]);
    r = await h.call('plain', 'GET', '/api/remote-access/web-sessions');
    assert.equal(r.status, 403);
});

test('the setup key route creates the web gateway key, and anything unknown stays the IP gateway', async () => {
    calls.length = 0;
    let r = await h.call('admin', 'POST', '/api/remote-access/setup-key', { kind: 'web' });
    assert.equal(r.status, 200, r.text);
    r = await h.call('admin', 'POST', '/api/remote-access/setup-key', { kind: 'weird' });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [['setup-key', 'web'], ['setup-key', 'ip']]);
});
