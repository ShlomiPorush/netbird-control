// The real server.js stack with SSO on, for route tests: a stub OpenID provider (no real IdP), a
// stub database socket that drops every connection, and a stub NetBird API that answers what the
// test gives it. Credentials are generated for each run; none is fixed in the repository.
//
// Usage, in before(): const h = ssoServer(); await h.start({ beforeRequire(db) { ...stubs... } });
// then h.call(sub, method, path, body) signs `sub` in once and sends the request.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { pageLoad } = require('./page-load');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function ssoServer() {
    const CLIENT_ID = 'test-client';
    const CLIENT_SECRET = crypto.randomBytes(32).toString('hex');
    const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    const ACCESS_TOKEN = crypto.randomBytes(32).toString('hex');
    const NB_TOKEN = crypto.randomBytes(24).toString('hex');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
    const codes = new Map();
    let ISSUER = '';
    let BASE = '';
    // NetBird answers by path; anything else is an empty list.
    const netbird = { answers: {}, seen: [] };

    const issuer = http.createServer((req, res) => {
        const send = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
        if (req.url === '/.well-known/openid-configuration') {
            return send({
                issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
                response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
                code_challenge_methods_supported: ['S256'],
            });
        }
        if (req.url === '/jwks') return send({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
        if (req.url === '/token' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const claims = codes.get(new URLSearchParams(body).get('code'));
                if (!claims) { res.statusCode = 400; return send({ error: 'invalid_grant' }); }
                const input = `${b64url({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64url(claims)}`;
                const idToken = `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
                send({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, id_token: idToken });
            });
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    const nbServer = http.createServer((req, res) => {
        netbird.seen.push(`${req.method} ${req.url}`);
        const path = req.url.split('?')[0];
        const a = netbird.answers[path];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(a === undefined ? [] : a));
    });
    const deadDb = net.createServer((socket) => socket.destroy());
    const appServer = http.createServer();
    const origError = console.error;
    const origLog = console.log;

    async function start({ env = {}, beforeRequire } = {}) {
        ISSUER = `http://127.0.0.1:${await listen(issuer)}`;
        const dbPort = await listen(deadDb);
        const nbPort = await listen(nbServer);
        BASE = `http://127.0.0.1:${await listen(appServer)}`;
        Object.assign(process.env, {
            OIDC_ISSUER_BASE_URL: ISSUER, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET,
            BASE_URL: BASE, SESSION_SECRET, TRUST_PROXY: '', WEBHOOK_AUTH_TOKEN: '',
            DB_HOST: '127.0.0.1', DB_PORT: String(dbPort),
            NETBIRD_API_URL: `http://127.0.0.1:${nbPort}`, NETBIRD_API_TOKEN: NB_TOKEN,
            ...env,
        });
        console.error = () => { }; // DB-stub failures are expected
        console.log = () => { };
        const db = require('../../db');
        if (beforeRequire) await beforeRequire(db);
        appServer.on('request', require('../../server').app);
    }

    async function stop() {
        console.error = origError;
        console.log = origLog;
        for (const s of [appServer, issuer, deadDb, nbServer]) {
            s.closeAllConnections?.();
            await new Promise((r) => s.close(r));
        }
    }

    const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
    const sessions = new Map();
    async function signIn(sub) {
        if (sessions.has(sub)) return sessions.get(sub);
        const startRes = await pageLoad(`${BASE}/login`, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' } });
        const authorize = new URL(startRes.headers.get('location'));
        const code = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        codes.set(code, {
            iss: ISSUER, aud: CLIENT_ID, sub, email: `${sub}@example.com`, name: sub,
            nonce: authorize.searchParams.get('nonce'), iat: now, exp: now + 3600,
        });
        const cb = await fetch(`${BASE}/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state'))}`, {
            headers: { accept: 'text/html', cookie: cookiesOf(startRes) }, redirect: 'manual',
        });
        assert.equal(cb.status, 302, 'callback completes the login');
        const cookie = cookiesOf(cb);
        sessions.set(sub, cookie);
        return cookie;
    }

    async function call(sub, method, path, body) {
        const res = await fetch(BASE + path, {
            method,
            headers: { accept: 'application/json', 'content-type': 'application/json', cookie: await signIn(sub) },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, text, json, headers: res.headers };
    }

    return { start, stop, call, netbird };
}

module.exports = { ssoServer };
