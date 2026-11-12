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
let queryTimeouts = []; // query_timeout of every query sent as a config object
let touches = []; // last-use updates: { sql, params }
let failTouch = false;
core.pool.query = async (sql, params = []) => {
    if (typeof sql !== 'string') { queryTimeouts.push(sql.query_timeout); params = sql.values; sql = sql.text; }
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
    if (s.startsWith('UPDATE api_keys SET last_used_at')) {
        touches.push({ sql: s, params });
        if (failTouch) throw new Error('db down');
        return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM api_keys ORDER BY')) return { rows };
    throw new Error('unexpected query: ' + s.slice(0, 60));
};

const keys = require('../lib/api-keys');
const { parseAllowedIps, ipAllowed, sha256 } = keys._internal;
const admin = { user_id: 'u-admin', email: 'admin@example.test', name: 'Admin' };

test.beforeEach(() => { rows = []; audits = []; failAudit = false; txLog = []; queryTimeouts = []; touches = []; failTouch = false; });

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

test('the middleware checks the scope and counts missing, malformed, unknown and expired keys as failed attempts', async () => {
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
    const unknown = 'nbc_' + crypto.randomBytes(32).toString('base64url');
    assert.equal((await runMiddleware(mw, { authorization: `Bearer ${unknown}` })).body.code, 'INVALID_KEY');
    assert.equal(fails.length, 3);
    rows[0].expires_at = new Date(Date.now() - 1000);
    assert.equal((await runMiddleware(mw, { authorization: `Bearer ${key}` })).body.code, 'KEY_EXPIRED');
    assert.equal(fails.length, 4, 'an expired key still counts');
    rows[0].expires_at = null;
    const other = keys.requireApiKey('something:else', deps);
    assert.equal((await runMiddleware(other, { authorization: `Bearer ${key}` })).body.code, 'SCOPE_MISSING');
    assert.equal(fails.length, 4, 'a missing scope is not a failed attempt');
    assert.ok(queryTimeouts.length > 0 && queryTimeouts.every(t => t === keys.QUERY_TIMEOUT_MS), 'the key lookup has a time limit');
});

test('a valid key works from a blocked address; every failed attempt from it gets 429 and adds nothing', async () => {
    const fails = [];
    const deps = { tooManyAuthFails: () => true, noteAuthFail: (ip) => fails.push(ip) };
    const mw = keys.requireApiKey('remote-access:launch', deps);
    const { key } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'] }, admin);
    const { key: limited } = await keys.createApiKey({ name: 'limited', scopes: ['remote-access:launch'], allowedIps: ['198.51.100.0/24'] }, admin);
    const { key: expired } = await keys.createApiKey({ name: 'expired', scopes: ['remote-access:launch'] }, admin);
    const { key: revoked, apiKey: revokedRow } = await keys.createApiKey({ name: 'revoked', scopes: ['remote-access:launch'] }, admin);
    rows[2].expires_at = new Date(Date.now() - 1000);
    await keys.revokeApiKey(revokedRow.id, admin);
    audits = [];

    const ok = await runMiddleware(mw, { authorization: `Bearer ${key}` });
    assert.equal(ok.status, 'next');
    assert.equal(ok.req.apiKey.name, 'k');
    // A valid key without the permission: the real answer, not the throttle.
    assert.equal((await runMiddleware(keys.requireApiKey('something:else', deps), { authorization: `Bearer ${key}` })).body.code, 'SCOPE_MISSING');

    const unknown = 'nbc_' + crypto.randomBytes(32).toString('base64url');
    for (const headers of [{}, { authorization: 'Bearer nbc_nope' }, { authorization: `Bearer ${unknown}` }, { authorization: `Bearer ${expired}` },
        { authorization: `Bearer ${revoked}` }, { authorization: `Bearer ${limited}` }, { authorization: `Basic ${key}` }]) {
        const r = await runMiddleware(mw, headers);
        assert.equal(r.status, 429, JSON.stringify(headers));
        assert.equal(r.body.code, 'TOO_MANY_FAILURES');
    }
    assert.equal(fails.length, 0, 'nothing more is counted while blocked');
    assert.equal(audits.length, 0, 'a failed attempt writes nothing');
});

test('a failed key lookup is "unavailable", blocked address or not', async () => {
    const { key } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'] }, admin);
    const realQuery = core.pool.query;
    core.pool.query = async () => { throw new Error('Query read timeout'); };
    try {
        for (const blocked of [false, true]) {
            const fails = [];
            const mw = keys.requireApiKey('remote-access:launch', { tooManyAuthFails: () => blocked, noteAuthFail: (ip) => fails.push(ip) });
            const r = await runMiddleware(mw, { authorization: `Bearer ${key}` });
            assert.equal(r.status, 503);
            assert.equal(r.body.code, 'UNAVAILABLE');
            assert.equal(fails.length, 0);
        }
    } finally {
        core.pool.query = realQuery;
    }
});

test('a real key used from a non-allowed address, or after it was revoked, is refused but not counted as a failed attempt', async () => {
    const fails = [];
    const deps = { tooManyAuthFails: () => false, noteAuthFail: (ip) => fails.push(ip) };
    const mw = keys.requireApiKey('remote-access:launch', deps);
    const { key, apiKey } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'], allowedIps: ['198.51.100.0/24'] }, admin);
    for (let i = 0; i < 25; i++) {
        const r = await runMiddleware(mw, { authorization: `Bearer ${key}` }, '203.0.113.9');
        assert.equal(r.status, 403);
        assert.equal(r.body.code, 'IP_NOT_ALLOWED');
    }
    await keys.revokeApiKey(apiKey.id, admin);
    for (let i = 0; i < 25; i++) {
        const r = await runMiddleware(mw, { authorization: `Bearer ${key}` }, '198.51.100.3');
        assert.equal(r.status, 401);
        assert.equal(r.body.code, 'KEY_REVOKED');
    }
    assert.equal(fails.length, 0);
    // A guess from the same address still counts.
    await runMiddleware(mw, { authorization: 'Bearer nbc_nope' }, '203.0.113.9');
    assert.deepEqual(fails, ['203.0.113.9']);
});

test('the key check records no use; recordKeyUse does, once a minute, with the time check in the update and a time limit', async () => {
    const { key } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'] }, admin);
    const mw = keys.requireApiKey('remote-access:launch', { tooManyAuthFails: () => false, noteAuthFail: () => { } });
    const ok = await runMiddleware(mw, { authorization: `Bearer ${key}` });
    assert.equal(ok.status, 'next');
    assert.equal(touches.length, 0, 'the key check itself writes nothing');
    assert.equal(ok.req.apiKey.lastUsedAt, null);

    const record = (apiKey) => { let nexts = 0; keys.recordKeyUse({ apiKey, ip: '::ffff:203.0.113.9' }, {}, () => { nexts++; }); return nexts; };
    queryTimeouts = [];
    assert.equal(record(ok.req.apiKey), 1);
    assert.equal(touches.length, 1);
    assert.match(touches[0].sql, /WHERE id = \$1 AND \(last_used_at IS NULL OR last_used_at < NOW\(\) - make_interval\(secs => \$3\)\)/);
    assert.deepEqual(touches[0].params, [ok.req.apiKey.id, '203.0.113.9', 60]);
    assert.deepEqual(queryTimeouts, [keys.QUERY_TIMEOUT_MS]);

    // A use recorded less than a minute ago: no query at all.
    assert.equal(record({ ...ok.req.apiKey, lastUsedAt: new Date(Date.now() - 30_000) }), 1);
    assert.equal(touches.length, 1);
    assert.equal(record({ ...ok.req.apiKey, lastUsedAt: new Date(Date.now() - 61_000) }), 1);
    assert.equal(touches.length, 2);

    // A failed write never fails the request and leaves no unhandled rejection.
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const origError = console.error;
    console.error = () => { };
    try {
        failTouch = true;
        assert.equal(record({ ...ok.req.apiKey, lastUsedAt: null }), 1);
        await new Promise((r) => setTimeout(r, 20));
    } finally { console.error = origError; process.off('unhandledRejection', onUnhandled); }
    assert.equal(touches.length, 3);
    assert.deepEqual(unhandled, []);
});

test('the key check when a launch link is opened has a time limit', async () => {
    const { apiKey } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'] }, admin);
    queryTimeouts = [];
    assert.equal(await keys.keyStillValid(apiKey.id, 'remote-access:launch'), true);
    assert.deepEqual(queryTimeouts, [keys.QUERY_TIMEOUT_MS]);
});

test('only the listed permission names are accepted, never inherited object names', async () => {
    for (const s of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
        await assert.rejects(keys.createApiKey({ name: 'x', scopes: [s] }, admin), (e) => e.code === 'INVALID_SCOPES', s);
        await assert.rejects(keys.createApiKey({ name: 'x', scopes: ['remote-access:launch', s] }, admin), (e) => e.code === 'INVALID_SCOPES', s);
    }
    assert.equal(rows.length, 0);
    assert.equal(audits.length, 0);
});

test('revoke takes only an exact key id, as a number or a string of digits', async () => {
    const { apiKey } = await keys.createApiKey({ name: 'k', scopes: ['remote-access:launch'] }, admin);
    assert.equal(apiKey.id, 1);
    let connects = 0;
    const realConnect = core.pool.connect;
    core.pool.connect = async () => { connects++; return fakeClient; };
    try {
        for (const bad of ['1abc', '1.5', '1e3', '01', ' 1', '1 ', '+1', '0x1', '', '0', '-1', '2147483648', '99999999999',
            1.5, 0, -1, NaN, Infinity, 2147483648, null, undefined, true, [1], { id: 1 }]) {
            await assert.rejects(keys.revokeApiKey(bad, admin), (e) => e.status === 404 && e.code === 'NOT_FOUND', JSON.stringify(bad) ?? String(bad));
        }
        assert.equal(connects, 0, 'a value that is no id never reaches the database');
        assert.equal(rows[0].revoked_at, null);
        assert.ok((await keys.revokeApiKey('1', admin)).apiKey.revokedAt);
        rows[0].revoked_at = null;
        assert.ok((await keys.revokeApiKey(1, admin)).apiKey.revokedAt);
        // The largest id the column holds is a valid id (no such key here).
        await assert.rejects(keys.revokeApiKey('2147483647', admin), (e) => e.code === 'NOT_FOUND');
        await assert.rejects(keys.revokeApiKey(2147483647, admin), (e) => e.code === 'NOT_FOUND');
        assert.equal(connects, 4);
    } finally {
        core.pool.connect = realConnect;
    }
});
