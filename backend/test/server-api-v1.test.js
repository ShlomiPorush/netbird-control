// The public API (/api/v1) on the real server.js stack with SSO on (stub OpenID provider, a
// database that drops every connection, API key rows stubbed): it is reached with a key and no
// login; without a valid key it answers JSON, never a login redirect; and a body that isn't JSON
// never puts its contents (which may hold passwords) into a log line or a response, whatever
// letter case or trailing slash the path has.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
// Every secret is generated for this run; none is fixed in the repository.
const CLIENT_SECRET = crypto.randomBytes(32).toString('hex');
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const API_KEY = 'nbc_' + crypto.randomBytes(32).toString('base64url');
const SECRET_IN_BODY = crypto.randomBytes(16).toString('hex');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
let ISSUER = '';
const issuer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
        return res.end(JSON.stringify({
            issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
        }));
    }
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [] }));
    res.statusCode = 404; res.end();
});
const deadDb = net.createServer((socket) => socket.destroy());
const appServer = http.createServer();
let BASE = '';
const logs = [];
const orig = { error: console.error, log: console.log, warn: console.warn };

before(async () => {
    ISSUER = `http://127.0.0.1:${await listen(issuer)}`;
    const dbPort = await listen(deadDb);
    BASE = `http://127.0.0.1:${await listen(appServer)}`;
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: ISSUER, OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_SECRET: CLIENT_SECRET,
        BASE_URL: BASE, SESSION_SECRET, TRUST_PROXY: 'loopback',
        DB_HOST: '127.0.0.1', DB_PORT: String(dbPort), NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '',
    });
    // The key row: the only database read the API key check makes.
    const core = require('../lib/core');
    const realQuery = core.pool.query.bind(core.pool);
    const keyHash = crypto.createHash('sha256').update(API_KEY).digest('hex');
    core.pool.query = async (sql, params) => {
        if (/FROM api_keys WHERE key_prefix/.test(sql)) {
            return { rows: params[0] === API_KEY.slice(0, 12) ? [{ id: 1, name: 'Test', key_prefix: API_KEY.slice(0, 12), key_hash: keyHash, scopes: ['remote-access:launch'], allowed_ips: [], revoked_at: null, expires_at: null, last_used_at: new Date() }] : [] };
        }
        return realQuery(sql, params);
    };
    for (const k of ['error', 'log', 'warn']) console[k] = (...args) => { logs.push(args.map(String).join(' ')); };
    const { app } = require('../server');
    appServer.on('request', app);
});

after(async () => {
    Object.assign(console, orig);
    for (const s of [appServer, issuer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

let n = 1;
async function post(path, { key, raw, json, contentType = 'application/json' } = {}) {
    const headers = { accept: 'application/json', 'x-forwarded-for': `10.9.${(n >> 8) & 255}.${n++ & 255}` };
    if (key) headers.authorization = `Bearer ${key}`;
    if (raw !== undefined || json !== undefined) headers['content-type'] = contentType;
    const res = await fetch(BASE + path, { method: 'POST', headers, body: raw !== undefined ? raw : json !== undefined ? JSON.stringify(json) : undefined, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') || '' };
}

test('without a valid key: a JSON error, never a login redirect', async () => {
    const none = await post('/api/v1/remote-access/launch', { json: {} });
    assert.equal(none.status, 401);
    assert.equal(JSON.parse(none.text).code, 'MISSING_KEY');
    const bad = await post('/api/v1/remote-access/launch', { key: 'nbc_' + 'x'.repeat(43), json: {} });
    assert.equal(bad.status, 401);
    assert.equal(JSON.parse(bad.text).code, 'INVALID_KEY');
});

test('a valid key reaches the action with no login (here: refused because remote access is off)', async () => {
    const r = await post('/api/v1/remote-access/launch', { key: API_KEY, json: { protocol: 'rdp', address: '10.0.0.5', port: 3389 } });
    assert.equal(r.location, '');
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.text).code, 'DISABLED');
});

test('a body that is not JSON: 400, and its contents appear in no log line or response, on every path form', async () => {
    const raw = `{"protocol":"rdp","password":"${SECRET_IN_BODY}",`;
    for (const path of ['/api/v1/remote-access/launch', '/API/V1/remote-access/launch', '/api/v1/remote-access/launch/', '/Api/V1/Remote-Access/Launch/']) {
        const r = await post(path, { key: API_KEY, raw });
        assert.equal(r.status, 400, path);
        assert.equal(JSON.parse(r.text).code, 'BAD_JSON', path);
        assert.ok(!r.text.includes(SECRET_IN_BODY), path);
    }
    assert.ok(logs.length > 0, 'the failures are logged');
    assert.ok(!logs.some(l => l.includes(SECRET_IN_BODY)), 'no log line holds the body');
});

test('a body that is not JSON on an app route (opening a launch link) is answered 400 without logging it', async () => {
    const before = logs.length;
    const r = await post('/api/remote-access/launch/redeem', { raw: `{"ticket":"${SECRET_IN_BODY}",` });
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes(SECRET_IN_BODY));
    assert.ok(logs.length > before, 'the failure is logged');
    assert.ok(!logs.some(l => l.includes(SECRET_IN_BODY)), 'no log line holds the body');
});

test('a body over 64 KB is refused', async () => {
    const r = await post('/api/v1/remote-access/launch', { key: API_KEY, json: { protocol: 'rdp', password: 'x'.repeat(70 * 1024) } });
    assert.equal(r.status, 413);
    assert.equal(JSON.parse(r.text).code, 'TOO_LARGE');
});

test('an unknown /api/v1 path answers 404 JSON, not the login', async () => {
    const r = await post('/api/v1/nothing-here', { key: API_KEY, json: {} });
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.text).code, 'NOT_FOUND');
});
