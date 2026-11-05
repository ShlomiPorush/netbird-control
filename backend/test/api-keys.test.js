// API keys: only the hash is stored, a key works only while it is not revoked or expired, only from
// its allowed addresses, and only for its scopes; failed attempts count toward the per-IP throttle;
// creating and revoking a key are recorded in the same transaction (no record, no change).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../lib/core');
let rows = [];
let audits = [];
let failAudit = false;
let txLog = [];
const fakeClient = {
    query: async (sql, params) => {
        txLog.push(sql.trim().split(/\s+/)[0]);
        return core.pool.query(sql, params);
    },
    release: () => { },
};
core.pool.connect = async () => fakeClient;
core.pool.query = async (sql, params = []) => {
    const s = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
    if (s.startsWith('INSERT INTO app_audit')) {
        if (failAudit) throw new Error('audit down');
        audits.push({ action: params[3], target: params[4], meta: params[5] });
        return { rows: [] };
    }
    if (s.startsWith('INSERT INTO api_keys')) {
        const row = { id: rows.length + 1, name: params[0], key_prefix: params[1], key_hash: params[2], scopes: params[3], allowed_ips: params[4], created_by: params[5], expires_at: params[6], created_at: new Date(), revoked_at: null };
        rows.push(row);
        return { rows: [row] };
    }
    if (s.startsWith('SELECT * FROM api_keys WHERE key_prefix')) return { rows: rows.filter(r => r.key_prefix === params[0]) };
    if (s.startsWith('SELECT * FROM api_keys WHERE id')) return { rows: rows.filter(r => r.id === params[0]) };
    if (s.startsWith('UPDATE api_keys SET revoked_at')) {
        const r = rows.find(x => x.id === params[0] && !x.revoked_at);
        if (!r) return { rows: [] };
        r.revoked_at = new Date(); r.revoked_by = params[1];
        return { rows: [r] };
    }
    if (s.startsWith('SELECT 1 FROM api_keys')) return { rows: rows.filter(r => r.id === params[0]) };
    if (s.startsWith('UPDATE api_keys SET last_used_at')) return { rows: [] };
    if (s.startsWith('SELECT * FROM api_keys ORDER BY')) return { rows };
    throw new Error('unexpected query: ' + s.slice(0, 60));
};

const keys = require('../lib/api-keys');
const { parseAllowedIps, ipAllowed, sha256 } = keys._internal;
const admin = { user_id: 'u-admin', email: 'admin@example.test', name: 'Admin' };

test.beforeEach(() => { rows = []; audits = []; failAudit = false; txLog = []; });

test('a new key is shown once and only its hash and prefix are stored', async () => {
    const { key, apiKey } = await keys.createApiKey({ name: 'Customer File', scopes: ['remote-access:launch'] }, admin);
    assert.match(key, /^nbc_[A-Za-z0-9_-]{43}$/);
    assert.equal(rows[0].key_hash, sha256(key));
    assert.equal(rows[0].key_prefix, key.slice(0, 12));
    assert.ok(!JSON.stringify(rows).includes(key), 'the key itself is not stored');
    assert.ok(!JSON.stringify(apiKey).includes(rows[0].key_hash), 'the UI never gets the hash');
    assert.ok(!JSON.stringify(audits).includes(key), 'the audit never holds the key');
    assert.equal(audits[0].action, 'apikey.create');
});

test('create is refused without a name or with an unknown scope or a past expiry', async () => {
    await assert.rejects(keys.createApiKey({ name: '', scopes: ['remote-access:launch'] }, admin), (e) => e.code === 'INVALID_NAME');
    await assert.rejects(keys.createApiKey({ name: 'x', scopes: ['admin:all'] }, admin), (e) => e.code === 'INVALID_SCOPES');
    await assert.rejects(keys.createApiKey({ name: 'x', scopes: [] }, admin), (e) => e.code === 'INVALID_SCOPES');
    await assert.rejects(keys.createApiKey({ name: 'x', scopes: ['remote-access:launch'], expiresAt: '2000-01-01' }, admin), (e) => e.code === 'INVALID_EXPIRY');
    assert.equal(rows.length, 0);
});

test('a failed audit record rolls the key back', async () => {
    failAudit = true;
    await assert.rejects(keys.createApiKey({ name: 'x', scopes: ['remote-access:launch'] }, admin));
    assert.ok(txLog.includes('ROLLBACK'));
    assert.ok(!txLog.includes('COMMIT'));
});

test('a key authenticates until it is revoked or expires', async () => {
    const { key, apiKey } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'] }, admin);
    assert.equal((await keys.authenticateKey(key, '203.0.113.5')).id, apiKey.id);
    // Same prefix, different key: refused (the hash decides, not the prefix).
    const forged = key.slice(0, 12) + crypto.randomBytes(32).toString('base64url').slice(0, 31);
    await assert.rejects(keys.authenticateKey(forged, '203.0.113.5'), (e) => e.code === 'INVALID_KEY');
    await assert.rejects(keys.authenticateKey('Bearer ' + key, '203.0.113.5'), (e) => e.code === 'INVALID_KEY');
    rows[0].expires_at = new Date(Date.now() - 1000);
    await assert.rejects(keys.authenticateKey(key, '203.0.113.5'), (e) => e.code === 'KEY_EXPIRED');
    rows[0].expires_at = null;
    await keys.revokeApiKey(apiKey.id, admin);
    await assert.rejects(keys.authenticateKey(key, '203.0.113.5'), (e) => e.code === 'KEY_REVOKED');
    // Revoking again (or a missing key) asks on the same connection it already holds.
    let connects = 0;
    const realConnect = core.pool.connect;
    core.pool.connect = async () => { connects++; return fakeClient; };
    txLog = [];
    assert.deepEqual(await keys.revokeApiKey(apiKey.id, admin), { ok: true, alreadyRevoked: true });
    assert.deepEqual(txLog, ['BEGIN', 'UPDATE', 'SELECT', 'ROLLBACK'], 'the lookup runs on the held connection');
    await assert.rejects(keys.revokeApiKey(999, admin), (e) => e.code === 'NOT_FOUND');
    core.pool.connect = realConnect;
    assert.equal(connects, 2, 'one connection per revoke');
    assert.equal(await keys.keyStillValid(apiKey.id, 'remote-access:launch'), false);
    assert.deepEqual(audits.map(a => a.action), ['apikey.create', 'apikey.revoke']);
});

test('allowed addresses: single addresses and ranges, IPv4 clients over IPv6 sockets', async () => {
    assert.deepEqual(parseAllowedIps('203.0.113.5, 198.51.100.0/24\n::ffff:192.0.2.1'), ['203.0.113.5', '198.51.100.0/24', '192.0.2.1']);
    assert.throws(() => parseAllowedIps(['10.0.0.0/33']), /not an IP address/);
    assert.throws(() => parseAllowedIps(['example.com']), /not an IP address/);
    const list = ['203.0.113.5', '198.51.100.0/24', '2001:db8::/32'];
    assert.equal(ipAllowed('203.0.113.5', list), true);
    assert.equal(ipAllowed('::ffff:203.0.113.5', list), true);
    assert.equal(ipAllowed('198.51.100.77', list), true);
    assert.equal(ipAllowed('2001:db8::1', list), true);
    assert.equal(ipAllowed('203.0.113.6', list), false);
    assert.equal(ipAllowed('', list), false);
    assert.equal(ipAllowed('1.2.3.4', []), true, 'no list: any address');
    const { key } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'], allowedIps: ['198.51.100.0/24'] }, admin);
    await assert.rejects(keys.authenticateKey(key, '203.0.113.9'), (e) => e.code === 'IP_NOT_ALLOWED');
    assert.ok(await keys.authenticateKey(key, '::ffff:198.51.100.3'));
});

function runMiddleware(mw, headers, ip = '203.0.113.5') {
    return new Promise((resolve) => {
        const req = { headers, ip };
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b, req }); } };
        mw(req, res, () => resolve({ status: 'next', req }));
    });
}

test('the middleware checks the scope and counts every failed attempt', async () => {
    const fails = [];
    let blocked = false;
    const deps = { tooManyAuthFails: () => blocked, noteAuthFail: (ip) => fails.push(ip) };
    const { key } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'] }, admin);
    const mw = keys.requireApiKey('remote-access:launch', deps);
    const ok = await runMiddleware(mw, { authorization: `Bearer ${key}` });
    assert.equal(ok.status, 'next');
    assert.equal(ok.req.apiKey.name, 'k');
    assert.equal((await runMiddleware(mw, {})).body.code, 'MISSING_KEY');
    assert.equal((await runMiddleware(mw, { authorization: 'Bearer nbc_nope' })).body.code, 'INVALID_KEY');
    assert.equal(fails.length, 2);
    const other = keys.requireApiKey('something:else', deps);
    assert.equal((await runMiddleware(other, { authorization: `Bearer ${key}` })).body.code, 'SCOPE_MISSING');
    blocked = true;
    assert.equal((await runMiddleware(mw, { authorization: `Bearer ${key}` })).status, 429);
});
