// Launch links (POST /api/v1/remote-access/launch -> /remote-access?launch=<ticket>): the user's
// own NetBird access decides, the link opens once, only for its user when one was named, never
// after its key was revoked, and the credentials never leave the server side.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ─── Stubs, before lib/remote-access.js loads ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] || null;
core.setSetting = async (k, v) => { settings[k] = v; };
const audits = [];
let auditDelay = 0;
let failAudit = false;
const keyRows = new Map();
core.pool.query = async (sql, params = []) => {
    const s = sql.trim();
    if (s.startsWith('INSERT INTO app_audit')) {
        if (auditDelay) await new Promise(r => setTimeout(r, auditDelay));
        if (failAudit) throw new Error('audit down');
        audits.push({ actor: params[1], action: params[3], target: params[4], meta: params[5] });
        return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM api_keys WHERE id')) return { rows: keyRows.has(params[0]) ? [keyRows.get(params[0])] : [] };
    return { rows: [] };
};

const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
const snapshot = {
    '/api/users': [
        { id: 'u1', email: 'Alice@Example.test', auto_groups: ['g-staff'], is_blocked: false },
        { id: 'u2', email: 'bob@example.test', auto_groups: ['g-staff'], is_blocked: false },
        { id: 'u3', email: 'carol@example.test', auto_groups: [], is_blocked: false },
        { id: 'u4', email: 'dave@example.test', auto_groups: ['g-staff'], is_blocked: true },
        { id: 'u5', email: 'twin@example.test', auto_groups: ['g-staff'], is_blocked: false },
        { id: 'u6', email: 'TWIN@example.test', auto_groups: ['g-staff'], is_blocked: true },
    ],
    '/api/peers': [{ id: 'p-gw', name: 'gw', groups: [{ id: 'g-gw' }], connected: true }, { id: 'p-r', name: 'r', groups: [], connected: true }],
    '/api/groups': [{ id: 'g-all', name: 'All' }, { id: 'g-gw', name: 'Browser Gateway' }, { id: 'g-gwt', name: 'Browser Gateway Targets' }, { id: 'g-staff', name: 'Staff' }],
    '/api/policies': [
        { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
        { id: 'pol-rdp', name: 'Staff RDP', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389', '22'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-gwt' }] }] },
    ],
    '/api/networks/resources': [{ id: 'r1', name: 'srv1', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-gwt' }] }],
    '/api/networks': [{ id: 'n1', name: 'Office', resources: ['r1'] }],
    '/api/routes': [],
    '/api/networks/n1/routers': [{ peer: 'p-r', enabled: true }],
};
nb.netbirdGet = async (p) => JSON.parse(JSON.stringify(snapshot[p] ?? null));
const events = require('../lib/events');
events.addEvent = async () => { };

const ra = require('../lib/remote-access');
const { connectArgs, ticketHash, LAUNCH_MAX } = ra._internal;

const PASSWORD = crypto.randomBytes(12).toString('base64url');
const KEY = { id: 7, name: 'Customer File' };
const alice = { user_id: 'u1', email: 'alice@example.test', name: 'Alice', oid: 'oid-1', authEnabled: true };
const bob = { user_id: 'u2', email: 'bob@example.test', name: 'Bob', oid: 'oid-2', authEnabled: true };
const rdp = (extra = {}) => ({ protocol: 'rdp', address: '10.0.0.5', port: 3389, username: 'admin', password: PASSWORD, ...extra });
const ticketOf = (o) => o.ticket;

test.before(async () => {
    settings.remote_access_config = JSON.stringify({ enabled: true, networks: ['n1'], guacdHost: '127.0.0.1', guacdPort: 4822 });
    settings.remote_access_nb = JSON.stringify({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw' });
    await ra.loadRemoteAccessConfig();
});
test.beforeEach(() => {
    keyRows.set(7, { id: 7, name: 'Customer File', scopes: ['remote-access:launch'], revoked_at: null, expires_at: null });
    audits.length = 0; failAudit = false; auditDelay = 0;
});
test.after(() => ra.closeAllSessions('test over'));

test('a named user: found by email in any letter case, and their own access is checked at issue', async () => {
    const out = await ra.issueLaunch(KEY, rdp({ user: 'ALICE@example.test' }));
    assert.match(out.ticket, /^[A-Za-z0-9_-]{43}$/);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'carol@example.test' })), (e) => e.status === 403 && e.code === 'NO_ACCESS');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'alice@example.test', port: 5900 })), (e) => e.code === 'PORT_NOT_ALLOWED');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'nobody@example.test' })), (e) => e.status === 404 && e.code === 'USER_NOT_FOUND');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'dave@example.test' })), (e) => e.code === 'USER_BLOCKED');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'twin@example.test' })), (e) => e.status === 409 && e.code === 'USER_AMBIGUOUS');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'alice' })), (e) => e.code === 'INVALID_USER');
});

test('input is validated: protocol, port, field types and lengths, SSH user name', async () => {
    await assert.rejects(ra.issueLaunch(KEY, rdp({ protocol: 'vnc' })), (e) => e.code === 'INVALID_PROTOCOL');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ port: 70000 })), (e) => e.code === 'INVALID_PORT');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ port: 3389.5 })), (e) => e.code === 'INVALID_PORT');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ port: '3389junk' })), (e) => e.code === 'INVALID_PORT');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ port: null })), (e) => e.code === 'INVALID_PORT');
    // Huge numbers are integers too, and parseInt would turn them into a small port.
    for (const port of [1e21, 3.389e24, 1e100, 0, -22]) {
        await assert.rejects(ra.issueLaunch(KEY, rdp({ port })), (e) => e.code === 'INVALID_PORT', String(port));
    }
    assert.ok((await ra.issueLaunch(KEY, rdp({ port: '3389' }))).ticket, 'a port sent as a string of digits is fine');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ password: { x: 1 } })), (e) => e.code === 'INVALID_FIELD');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ password: 'x'.repeat(1025) })), (e) => e.code === 'INVALID_FIELD');
    await assert.rejects(ra.issueLaunch(KEY, { protocol: 'ssh', address: '10.0.0.5', port: 22 }), (e) => e.code === 'USERNAME_REQUIRED');
});

test('a link opens once, for its user only, with the credentials going to guacd and nowhere else', async () => {
    const t1 = ticketOf(await ra.issueLaunch(KEY, rdp({ user: 'alice@example.test', domain: 'CORP' })));
    // Bob tries Alice's link: refused, recorded, and the link is used up.
    await assert.rejects(ra.redeemLaunch(bob, { ticket: t1 }, '203.0.113.2'), (e) => e.status === 403 && e.code === 'WRONG_USER');
    assert.ok(audits.some(a => a.action === 'remote_access.launch_wrong_user'));
    await assert.rejects(ra.redeemLaunch(alice, { ticket: t1 }, '203.0.113.1'), (e) => e.status === 410 && e.code === 'EXPIRED');

    const t2 = ticketOf(await ra.issueLaunch(KEY, rdp({ user: 'alice@example.test', domain: 'CORP' })));
    // The browser may send only display fields: a target in the body is ignored.
    const out = await ra.redeemLaunch(alice, { ticket: t2, width: 1600, height: 900, dpi: 144, address: '10.9.9.9', port: 22, protocol: 'ssh' }, '203.0.113.1');
    assert.equal(out.protocol, 'rdp');
    assert.equal(out.port, 3389);
    assert.equal(out.address, '10.0.0.5');
    assert.equal(out.serverCredentials, true);
    const text = JSON.stringify(out) + JSON.stringify(audits);
    assert.ok(!text.includes(PASSWORD), 'no password in the answer or the audit');
    assert.ok(!text.includes(t2), 'the raw ticket is never recorded');
    assert.ok(audits.some(a => a.action === 'remote_access.launch_open' && JSON.parse(a.meta).ticketRef === ticketHash(t2).slice(0, 12)));
    await assert.rejects(ra.redeemLaunch(alice, { ticket: t2 }, '203.0.113.1'), (e) => e.code === 'EXPIRED');
    ra.endSession(alice, out.sessionId);
});

test('RDP credentials from a link reach guacd; a manual RDP session still sends none', () => {
    const names = ['hostname', 'port', 'username', 'password', 'domain'];
    const base = { protocol: 'rdp', address: '10.0.0.5', port: 3389, timezone: '', dpi: 96, gateway: 'ip' };
    assert.deepEqual(connectArgs({ ...base, creds: { username: 'admin', password: 'pw', domain: 'CORP' } }, names).slice(2), ['admin', 'pw', 'CORP']);
    assert.deepEqual(connectArgs({ ...base, creds: {} }, names).slice(2), ['', '', '']);
});

test('without a user, the first signed-in user who passes the checks gets the link', async () => {
    const t = ticketOf(await ra.issueLaunch(KEY, rdp()));
    const out = await ra.redeemLaunch(bob, { ticket: t }, '203.0.113.2');
    assert.equal(out.serverCredentials, true);
    ra.endSession(bob, out.sessionId);
    // No access for the one who opens it: the session is refused (and the link is used up).
    const t2 = ticketOf(await ra.issueLaunch(KEY, rdp()));
    const carol = { user_id: 'u3', email: 'carol@example.test', name: 'Carol', oid: 'oid-3', authEnabled: true };
    await assert.rejects(ra.redeemLaunch(carol, { ticket: t2 }, '203.0.113.3'), (e) => e.code === 'NO_ACCESS');
    await assert.rejects(ra.redeemLaunch(bob, { ticket: t2 }, '203.0.113.2'), (e) => e.code === 'EXPIRED');
});

test('a revoked key voids its links that were not opened yet', async () => {
    const t = ticketOf(await ra.issueLaunch(KEY, rdp({ user: 'alice@example.test' })));
    keyRows.get(7).revoked_at = new Date();
    await assert.rejects(ra.redeemLaunch(alice, { ticket: t }, '203.0.113.1'), (e) => e.code === 'KEY_REVOKED');
});

test('a link expires after five minutes', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const tk = ticketOf(await ra.issueLaunch(KEY, rdp({ user: 'alice@example.test' })));
    t.mock.timers.tick(ra._internal.LAUNCH_TTL_MS + 1);
    await assert.rejects(ra.redeemLaunch(alice, { ticket: tk }, '203.0.113.1'), (e) => e.code === 'EXPIRED');
});

test('no audit record, no link; no audit record, no session', async () => {
    failAudit = true;
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'alice@example.test' })), (e) => e.code === 'AUDIT_FAILED');
    failAudit = false;
    const t = ticketOf(await ra.issueLaunch(KEY, rdp({ user: 'alice@example.test' })));
    failAudit = true;
    await assert.rejects(ra.redeemLaunch(alice, { ticket: t }, '203.0.113.1'), (e) => e.code === 'AUDIT_FAILED');
});

test('the waiting-link cap holds under concurrent issues, and expired links free their place', async () => {
    ra._internal.sweepLaunches(Number.MAX_SAFE_INTEGER);
    const fill = [];
    for (let i = 0; i < LAUNCH_MAX - 1; i++) fill.push(ra.issueLaunch(KEY, rdp()));
    await Promise.all(fill);
    assert.equal(ra._internal.launchCount(), LAUNCH_MAX - 1);
    auditDelay = 30;
    const both = await Promise.allSettled([ra.issueLaunch(KEY, rdp()), ra.issueLaunch(KEY, rdp())]);
    assert.equal(both.filter(r => r.status === 'fulfilled').length, 1, 'exactly one gets the last place');
    assert.equal(both.find(r => r.status === 'rejected').reason.code, 'BUSY');
    assert.equal(ra._internal.launchCount(), LAUNCH_MAX);
    ra._internal.sweepLaunches(Number.MAX_SAFE_INTEGER);
    assert.equal(ra._internal.launchCount(), 0);
});
