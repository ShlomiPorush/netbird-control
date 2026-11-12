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
const auditAttempts = []; // every app_audit insert tried, written or not
let auditDelay = 0;
let failAudit = false;
let failActions = new Set();
const keyRows = new Map();
const auditTimeouts = []; // query_timeout of each app_audit insert sent as a config object
core.pool.query = async (sql, params = []) => {
    if (typeof sql !== 'string') { params = sql.values; if (/app_audit/.test(sql.text)) auditTimeouts.push([sql.values[3], sql.query_timeout]); sql = sql.text; }
    const s = sql.trim();
    if (s.startsWith('INSERT INTO app_audit')) {
        auditAttempts.push(params[3]);
        if (auditDelay) await new Promise(r => setTimeout(r, auditDelay));
        if (failAudit || failActions.has(params[3])) throw new Error('audit down');
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
    audits.length = 0; auditAttempts.length = 0; failAudit = false; failActions = new Set(); auditDelay = 0;
    ra._internal.clearRefusals();
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
    assert.deepEqual(connectArgs({ ...base, creds: { username: 'admin', password: PASSWORD, domain: 'CORP' } }, names).slice(2), ['admin', PASSWORD, 'CORP']);
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

// ─── Refused requests in the audit log ───
const refusals = () => audits.filter(a => a.action === 'remote_access.launch_refused').map(a => ({ ...a, meta: JSON.parse(a.meta) }));
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${crypto.randomBytes(48).toString('base64')}\n-----END OPENSSH PRIVATE KEY-----`;

test('a refused request is recorded with the key, the reason and the target, never the credentials', async () => {
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'nobody@example.test' })), (e) => e.status === 404 && e.code === 'USER_NOT_FOUND');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'carol@example.test' })), (e) => e.status === 403 && e.code === 'NO_ACCESS');
    await assert.rejects(ra.issueLaunch(KEY, { protocol: 'ssh', address: 'srv.example.test', port: 22, username: 'root', password: PASSWORD, privateKey: PRIVATE_KEY, passphrase: PASSWORD, user: 'x' }), (e) => e.code === 'INVALID_USER');
    const r = refusals();
    assert.deepEqual(r.map(a => [a.meta.code, a.target]), [
        ['USER_NOT_FOUND', 'rdp://10.0.0.5:3389'], ['NO_ACCESS', 'rdp://10.0.0.5:3389'], ['INVALID_USER', 'ssh://srv.example.test:22']]);
    assert.ok(r.every(a => a.actor === '' && a.meta.keyId === 7 && a.meta.count === 1));
    assert.ok(!JSON.stringify(audits).includes(PASSWORD), 'no password in the audit');
    assert.ok(!JSON.stringify(audits).includes('PRIVATE KEY'), 'no private key in the audit');
    // A link that is made is not a refusal.
    await ra.issueLaunch(KEY, rdp({ user: 'alice@example.test' }));
    assert.equal(refusals().length, 3);
});

test('the target holds only checked values: anything else is "invalid", and the refusal reaches the caller unchanged', async () => {
    const SECRET = crypto.randomBytes(9).toString('hex');
    const cases = [
        [{ protocol: 'rdp', address: '10.0.0.5', port: { toString: null } }, 'INVALID_PORT', 'rdp://10.0.0.5:invalid'],
        [{ protocol: { toString: null }, address: { toString: null }, port: 'x' }, 'INVALID_PORT', 'invalid://invalid:invalid'],
        [{ protocol: 'ssh', address: `ssh://alice:${SECRET}@server.example.test`, port: 'x' }, 'INVALID_PORT', 'ssh://invalid:invalid'],
        [{ protocol: 'ssh', address: [SECRET], port: [SECRET] }, 'INVALID_PORT', 'ssh://invalid:invalid'],
        [{ protocol: `rdp${SECRET}`, address: `a\u0000${SECRET}.example.test`, port: 22 }, 'INVALID_PROTOCOL', 'invalid://invalid:22'],
        [{ protocol: 'RDP', address: ' Srv.Example.Test ', port: '0' }, 'INVALID_PORT', 'rdp://srv.example.test:invalid'],
    ];
    for (const [body, code, target] of cases) {
        await assert.rejects(ra.issueLaunch({ id: 8, name: 'k8' }, { ...body, password: PASSWORD }), (e) => e.status === 400 && e.code === code, code);
        ra._internal.clearRefusals();
        const last = refusals().at(-1);
        assert.equal(last.target, target, JSON.stringify(body));
    }
    for (const body of [null, 'text', 42]) {
        await assert.rejects(ra.issueLaunch(KEY, body), (e) => e.status === 400 && e.code === 'INVALID_PORT');
        ra._internal.clearRefusals();
        assert.equal(refusals().at(-1).target, 'invalid://invalid:invalid');
    }
    const text = JSON.stringify(audits);
    assert.ok(!text.includes(SECRET) && !text.includes(PASSWORD), 'no raw field value in the audit');
});

test('repeated refusals collapse per key and reason, at the 1st, 10th, 100th..., whatever the target', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    for (let i = 0; i < 120; i++) {
        await assert.rejects(ra.issueLaunch(KEY, rdp({ address: `10.0.${i % 250}.1`, port: 1000 + i, user: 'not-an-email' })), (e) => e.code === 'INVALID_USER');
    }
    assert.deepEqual(refusals().map(a => a.meta.count), [1, 10, 100]);
    assert.deepEqual(refusals().map(a => a.target), ['rdp://10.0.0.1:1000', 'rdp://10.0.9.1:1009', 'rdp://10.0.99.1:1099'], 'each record names the target of that refusal');
    // Another reason, and another key, have their own count.
    await assert.rejects(ra.issueLaunch(KEY, rdp({ protocol: 'vnc' })), (e) => e.code === 'INVALID_PROTOCOL');
    await assert.rejects(ra.issueLaunch({ id: 9, name: 'Other' }, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.deepEqual(refusals().slice(3).map(a => [a.meta.keyId, a.meta.code, a.meta.count]), [[7, 'INVALID_PROTOCOL', 1], [9, 'INVALID_USER', 1]]);
    // The window is 10 minutes from the first refusal: just before it ends, still collapsed;
    // when it ends, a new window starts at 1.
    t.mock.timers.tick(ra._internal.REFUSAL_WINDOW_MS - 1);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.equal(refusals().length, 5);
    t.mock.timers.tick(1);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.deepEqual(refusals().slice(5).map(a => [a.meta.code, a.meta.count]), [['INVALID_USER', 1]]);
});

test('concurrent refusals write one record at a time, and the count stays exact', async () => {
    auditDelay = 20;
    const all = [];
    for (let i = 0; i < 20; i++) all.push(ra.issueLaunch(KEY, rdp({ user: 'x' })));
    const out = await Promise.allSettled(all);
    assert.ok(out.every(r => r.status === 'rejected' && r.reason.code === 'INVALID_USER'));
    assert.deepEqual(refusals().map(a => a.meta.count), [1], 'the 10th arrived while the 1st was being written');
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.deepEqual(refusals().map(a => a.meta.count), [1, 21], 'the next one is recorded, with the true count');
});

test('a refusal record that could not be written is tried again a minute later, not on every refusal', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    failActions = new Set(['remote_access.launch_refused']);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER', 'the caller gets the refusal, not the audit error');
    failActions = new Set();
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.equal(auditAttempts.filter(a => a === 'remote_access.launch_refused').length, 1);
    assert.equal(refusals().length, 0);
    t.mock.timers.tick(ra._internal.REFUSAL_RETRY_MS);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.deepEqual(refusals().map(a => a.meta.count), [3], 'recorded after the store came back, before the 10th');
    assert.ok(auditTimeouts.filter(([a]) => a === 'remote_access.launch_refused').every(([, t]) => t === 5000), 'the write has a time limit');
});

test('a new window keeps the wait after a failed write, and never runs a second write beside one in flight', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const tries = () => auditAttempts.filter(a => a === 'remote_access.launch_refused').length;
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER'); // opens the window
    t.mock.timers.tick(ra._internal.REFUSAL_WINDOW_MS - 1000);
    // The 10th refusal falls a second before the window ends, and its write fails.
    failActions = new Set(['remote_access.launch_refused']);
    for (let i = 0; i < 9; i++) await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.equal(tries(), 2);
    failActions = new Set();
    t.mock.timers.tick(1000); // a new window, inside the minute's wait
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.equal(tries(), 2, 'no retry before the minute is up');
    t.mock.timers.tick(ra._internal.REFUSAL_RETRY_MS);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.deepEqual(refusals().map(a => a.meta.count), [1, 2], 'the new window counts from 1');

    // A write still in flight when its window ends: the next window waits for it.
    ra._internal.clearRefusals(); audits.length = 0; auditAttempts.length = 0;
    auditDelay = 50;
    const slow = assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    await new Promise(r => setImmediate(r));
    t.mock.timers.tick(ra._internal.REFUSAL_WINDOW_MS);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.equal(tries(), 1, 'one write at a time');
    await slow;
    auditDelay = 0;
    // The slow write was for the old window: it does not move the new window past its 1st record.
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.deepEqual(refusals().map(a => a.meta.count), [1, 2]);
});

test('counts for a key that stopped are dropped once their window is over', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    for (let id = 100; id < 110; id++) await assert.rejects(ra.issueLaunch({ id, name: `k${id}` }, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.equal(ra._internal.refusalCount(), 10);
    t.mock.timers.tick(ra._internal.REFUSAL_WINDOW_MS);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'x' })), (e) => e.code === 'INVALID_USER');
    assert.equal(ra._internal.refusalCount(), 1);
});

test('no refusal record when the link record itself failed, or when the discarded link is already recorded', async () => {
    failActions = new Set(['remote_access.launch_issue']);
    await assert.rejects(ra.issueLaunch(KEY, rdp({ user: 'alice@example.test' })), (e) => e.code === 'AUDIT_FAILED');
    assert.ok(!auditAttempts.includes('remote_access.launch_refused'));
    failActions = new Set();

    const raceForLastPlace = async () => {
        ra._internal.sweepLaunches(Number.MAX_SAFE_INTEGER);
        const fill = [];
        for (let i = 0; i < LAUNCH_MAX - 1; i++) fill.push(ra.issueLaunch(KEY, rdp()));
        await Promise.all(fill);
        auditDelay = 30;
        const both = await Promise.allSettled([ra.issueLaunch(KEY, rdp()), ra.issueLaunch(KEY, rdp())]);
        auditDelay = 0;
        assert.equal(both.find(r => r.status === 'rejected').reason.code, 'BUSY');
    };
    // The link lost the race after its record was written: the discard record says why.
    await raceForLastPlace();
    assert.ok(audits.some(a => a.action === 'remote_access.launch_discard'));
    assert.equal(refusals().length, 0);
    // If the discard record could not be written, the refusal record says it instead.
    failActions = new Set(['remote_access.launch_discard']);
    await raceForLastPlace();
    assert.deepEqual(refusals().map(a => a.meta.code), ['BUSY']);
    // With every place taken, a new request is refused before any link record.
    failActions = new Set();
    ra._internal.clearRefusals();
    audits.length = 0;
    await assert.rejects(ra.issueLaunch(KEY, rdp()), (e) => e.code === 'BUSY');
    assert.deepEqual(audits.map(a => a.action), ['remote_access.launch_refused']);
    ra._internal.sweepLaunches(Number.MAX_SAFE_INTEGER);
});
