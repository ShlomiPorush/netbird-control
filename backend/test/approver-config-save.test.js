// Saving Settings -> Approvals through the real PUT /api/approver-config route (open mode, no SSO).
// The database is an in-memory app_settings map behind the shared pg pool, so the test sees exactly
// what the route stores. It pins down:
//   - the saved delegation list replaces the stored one: removing a delegation ends it at once,
//     adding one starts it, and a request without a delegates field leaves the list alone;
//   - a failed write changes nothing, neither the stored config nor the live approval rights;
//   - concurrent partial saves never write back a field another save just changed.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const deadDb = net.createServer((socket) => socket.destroy());
const appServer = http.createServer();
let BASE = '';
const origError = console.error;

// In-memory app_settings behind the shared pool. failWrite makes the approver_config write throw;
// holdWrite (a promise) delays it until resolved.
const settings = new Map();
const audits = [];
let failWrite = false;
let holdWrite = null;
const core = require('../lib/core');
core.pool.query = async (sql, params = []) => {
    if (/^SELECT value FROM app_settings WHERE key = \$1/.test(sql)) {
        return { rows: settings.has(params[0]) ? [{ value: settings.get(params[0]) }] : [], rowCount: 0 };
    }
    if (/^INSERT INTO app_settings/.test(sql)) {
        if (params[0] === 'approver_config') {
            if (holdWrite) await holdWrite;
            if (failWrite) throw new Error('write failed');
        }
        settings.set(params[0], params[1]);
        return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO app_audit/.test(sql)) audits.push({ action: params[3], meta: params[5] ? JSON.parse(params[5]) : null });
    return { rows: [], rowCount: 0 };
};
const db = require('../db');

const A = { id: 'user-a', email: 'a@example.test', name: 'A' };
const B = { id: 'user-b', email: 'b@example.test', name: 'B' };
const ALWAYS = { from: '2000-01-01', until: '2999-12-31' };
const stored = () => JSON.parse(settings.get('approver_config') || '{}');

before(async () => {
    const dbPort = await listen(deadDb);
    BASE = `http://127.0.0.1:${await listen(appServer)}`;
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', BASE_URL: '',
        TRUST_PROXY: '', WEBHOOK_AUTH_TOKEN: '',
        DB_HOST: '127.0.0.1', DB_PORT: String(dbPort),
        NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '',
    });
    console.error = () => { }; // the failed-write case logs the error on purpose
    appServer.on('request', require('../server').app);
});

after(async () => {
    console.error = origError;
    for (const s of [appServer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

beforeEach(async () => {
    failWrite = false;
    holdWrite = null;
    settings.clear();
    audits.length = 0;
    await db.setApproverConfig({ groupIds: ['G'], telegramChatId: '', telegramApprovers: [], delegates: [{ user: A, ...ALWAYS }] });
});

async function put(body) {
    const res = await fetch(BASE + '/api/approver-config', {
        method: 'PUT', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

test('saving with the delegation removed ends it immediately', async () => {
    assert.equal(await db.isActiveDelegate({ userId: A.id, email: A.email }), true);
    const r = await put({ groupIds: ['G'], telegramChatId: '', telegramApprovers: [], delegates: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.delegates, []);
    assert.equal(await db.isActiveDelegate({ userId: A.id, email: A.email }), false);
    assert.deepEqual(stored().delegates, []);
    assert.equal(audits.find((a) => a.action === 'settings.approvers').meta.delegates, 0);
});

test('saving with a new delegation stores it and grants approval rights', async () => {
    assert.equal(await db.isActiveDelegate({ userId: B.id, email: B.email }), false);
    const r = await put({ groupIds: ['G'], telegramChatId: '', telegramApprovers: [], delegates: [{ user: A, ...ALWAYS }, { user: B, ...ALWAYS }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.delegates.length, 2);
    assert.equal(await db.isActiveDelegate({ userId: B.id, email: B.email }), true);
    assert.deepEqual(stored().delegates.map((d) => d.user.id), [A.id, B.id]);
});

test('a request without a delegates field keeps the stored delegations', async () => {
    const r = await put({ groupIds: ['G'], telegramChatId: '', telegramApprovers: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.delegates.length, 1);
    assert.equal(await db.isActiveDelegate({ userId: A.id, email: A.email }), true);
});

test('a failed write changes neither the stored config nor the live approval rights', async () => {
    const before = settings.get('approver_config');
    failWrite = true;
    const r = await put({ groupIds: [], telegramChatId: '', telegramApprovers: [], delegates: [{ user: B, ...ALWAYS }] });
    assert.equal(r.status, 500);
    assert.equal(settings.get('approver_config'), before);
    assert.deepEqual(db.getApproverConfig().groupIds, ['G']);
    assert.equal(await db.isActiveDelegate({ userId: A.id, email: A.email }), true);
    assert.equal(await db.isActiveDelegate({ userId: B.id, email: B.email }), false);
});

test('concurrent partial saves keep each other\'s changes', async () => {
    let release;
    holdWrite = new Promise((r) => { release = r; });
    const removal = db.setApproverConfig({ delegates: [] });
    const chatOnly = db.setApproverConfig({ telegramChatId: '-100123' });
    release();
    await Promise.all([removal, chatOnly]);
    assert.deepEqual(db.getApproverConfig().delegates, []);
    assert.equal(db.getApproverConfig().telegramChatId, '-100123');
    assert.deepEqual(stored().delegates, []);
    assert.equal(stored().telegramChatId, '-100123');
});
