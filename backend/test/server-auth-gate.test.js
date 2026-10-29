// The real server.js stack with SSO on, against a stub OpenID provider (no real IdP) and a stub
// database socket that drops every connection (no real database). It pins down:
//   - the login gate: exactly the routes registered before the gate are reachable without login;
//     everything else (HTML and JSON) still requires it, and an over-age session is still refused;
//   - the per-IP auth budget on /login, /callback and automatic login starts;
//   - the per-user API budget;
//   - the webhook receivers and the health probe are never rate limited, and the separate
//     failed-token throttle still applies to them.
// TRUST_PROXY=loopback lets each test pick its client address with X-Forwarded-For.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = 'test-client';
const HOOK_TOKEN = 'hook-token';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ── Stub OpenID provider: discovery, JWKS and a token endpoint that issues RS256 ID tokens ──
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const codes = new Map(); // authorization code → ID token claims
let ISSUER = '';
const issuer = http.createServer((req, res) => {
    const send = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url === '/.well-known/openid-configuration') {
        return send({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            end_session_endpoint: `${ISSUER}/logout`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
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
            send({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
        });
        return;
    }
    res.statusCode = 404;
    res.end();
});

// A "database" that accepts and immediately drops every connection, so the handlers that reach
// the DB fail fast instead of waiting on a connect timeout.
const deadDb = net.createServer((socket) => socket.destroy());

const appServer = http.createServer();
let BASE = '';
let app;
const errors = []; // console.error calls (the app's last-resort error handler logs here)
const origError = console.error;

before(async () => {
    ISSUER = `http://127.0.0.1:${await listen(issuer)}`;
    const dbPort = await listen(deadDb);
    BASE = `http://127.0.0.1:${await listen(appServer)}`;
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: ISSUER,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: 'test-secret',
        BASE_URL: BASE,
        SESSION_SECRET: 'a-fixed-test-session-secret-0123456789',
        TRUST_PROXY: 'loopback',
        WEBHOOK_AUTH_TOKEN: HOOK_TOKEN,
        DB_HOST: '127.0.0.1',
        DB_PORT: String(dbPort),
        NETBIRD_API_URL: '',
        NETBIRD_API_TOKEN: '',
    });
    console.error = (...args) => { errors.push(args); };
    ({ app } = require('../server'));
    appServer.on('request', app);
});

after(async () => {
    console.error = origError;
    for (const s of [appServer, issuer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

// Every request carries its own client address; `ip` defaults to a fresh one so tests don't
// drain each other's per-IP budgets.
let nextIp = 1;
const freshIp = () => { const n = nextIp++; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };
async function call(method, path, { ip = freshIp(), accept = 'text/html', cookie, headers = {}, body } = {}) {
    const h = { accept, 'x-forwarded-for': ip, ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location') || '' };
}
const startsLogin = (r) => r.status === 302 && r.location.startsWith(`${ISSUER}/authorize`);
const loginReturnTo = (r) => JSON.parse(Buffer.from(new URL(r.location).searchParams.get('state'), 'base64url')).returnTo;
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

// A full login through the stub provider: /login → /authorize (skipped) → /callback → session.
async function signIn(sub, { iat = Math.floor(Date.now() / 1000) } = {}) {
    const ip = freshIp();
    const start = await fetch(`${BASE}/login`, { headers: { accept: 'text/html', 'x-forwarded-for': ip }, redirect: 'manual' });
    const authorize = new URL(start.headers.get('location'));
    assert.equal(authorize.origin + authorize.pathname, `${ISSUER}/authorize`);
    const code = crypto.randomUUID();
    codes.set(code, {
        iss: ISSUER, aud: CLIENT_ID, sub, email: `${sub}@example.com`, name: sub,
        nonce: authorize.searchParams.get('nonce'), iat, exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const cb = await fetch(`${BASE}/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state'))}`, {
        headers: { accept: 'text/html', 'x-forwarded-for': ip, cookie: cookiesOf(start) },
        redirect: 'manual',
    });
    assert.equal(cb.status, 302, 'callback completes the login');
    const cookie = cookiesOf(cb);
    assert.match(cookie, /appSession/);
    return cookie;
}

// Runs fn over items, `width` at a time.
async function inBatches(items, width, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += width) out.push(...await Promise.all(items.slice(i, i + width).map(fn)));
    return out;
}

// The routes registered BEFORE the gate - the only ones reachable without login.
const PUBLIC_ROUTES = new Set([
    'POST /api/integrations/netbird-notifications',
    'POST /api/integrations/netbird-notifications/t/:acct',
    'POST /api/webhook',
    'POST /api/webhook/t/:acct',
    'GET /api/health',
    'POST /api/integrations/telegram/callback',
]);

test('every app route except the public ones requires login (unauthenticated browser request starts the OIDC login)', async () => {
    const routes = [];
    for (const layer of app._router.stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
            if (method === '_all') continue;
            routes.push({ method: method.toUpperCase(), path: layer.route.path });
        }
    }
    // Every app.get/post/put/patch/delete( registration in server.js is in the list.
    const registered = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').match(/^\s*app\.(get|post|put|patch|delete)\(/gm).length;
    assert.equal(routes.length, registered);
    const results = await inBatches(routes, 10, async ({ method, path }) => {
        const url = path === '*' ? '/some/spa/page' : path.replace(/:\w+\??/g, 'x');
        const r = await call(method, url, { body: method === 'GET' ? undefined : {} });
        return { key: `${method} ${path}`, r };
    });
    const open = results.filter(({ r }) => !startsLogin(r)).map(({ key }) => key).sort();
    assert.deepEqual(open, [...PUBLIC_ROUTES].sort());
    for (const { key, r } of results) {
        if (PUBLIC_ROUTES.has(key)) assert.notEqual(r.status, 429, key);
    }
});

test('static files, the app shell, API docs and /login?returnTo= still require login', async () => {
    for (const path of ['/', '/index.html', '/version.txt', '/assets/index-abc.js', '/peers', '/api/docs/', '/api/me', '/API/ME', '/api/me/']) {
        assert.ok(startsLogin(await call('GET', path)), path);
    }
    // /login is still behind the gate: the login it starts returns to /login?returnTo=…, which
    // then (signed in) redirects to the requested page - the same round trip as before.
    const r = await call('GET', '/login?returnTo=/peers');
    assert.ok(startsLogin(r));
    assert.equal(loginReturnTo(r), '/login?returnTo=/peers');
});

test('unauthenticated JSON requests are refused by the login gate, not served', async () => {
    errors.length = 0;
    for (const path of ['/api/me', '/api/logs', '/version.txt']) {
        const r = await call('GET', path, { accept: 'application/json' });
        assert.ok(!startsLogin(r), path);
        assert.ok(r.status >= 400, `${path} → ${r.status}`);
    }
    const unauthorized = errors.filter((args) => args.some((a) => a && a.name === 'UnauthorizedError' && a.status === 401));
    assert.equal(unauthorized.length, 3);
});

test('a signed-in user reaches protected routes; /login returns them to the page', async () => {
    const cookie = await signIn('alice');
    const v = await call('GET', '/version.txt', { cookie });
    assert.equal(v.status, 200);
    const back = await call('GET', '/login?returnTo=/peers', { cookie });
    assert.equal(back.status, 302);
    assert.equal(back.location, '/peers');
    const api = await call('POST', '/api/posture-checks/inspect-certificates', { cookie, accept: 'application/json', body: { pems: [] } });
    assert.equal(api.status, 200);
});

test('a session past the absolute cap is still refused (API 401, /login starts a fresh login)', async () => {
    const cookie = await signIn('old-session', { iat: Math.floor(Date.now() / 1000) - 7 * 3600 }); // default cap: 6 h
    const api = await call('POST', '/api/posture-checks/inspect-certificates', { cookie, accept: 'application/json', body: { pems: [] } });
    assert.equal(api.status, 401);
    assert.match(api.text, /Session expired/);
    const again = await call('GET', '/login?returnTo=/peers', { cookie });
    assert.ok(startsLogin(again));
});

test('auth budget: 30 per minute per IP across /login and automatic login starts; other IPs unaffected', async () => {
    const a = freshIp();
    for (let i = 0; i < 30; i++) assert.ok(startsLogin(await call('GET', '/login', { ip: a })), `request ${i + 1}`);
    const limited = await call('GET', '/login', { ip: a });
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after'), /^\d+$/);
    assert.match(limited.headers.get('ratelimit'), /"auth"; r=0/);
    assert.ok(startsLogin(await call('GET', '/login', { ip: freshIp() })));

    // Automatic login starts (any protected page, including /assets) share the same budget.
    const b = freshIp();
    for (let i = 0; i < 20; i++) await call('GET', '/login', { ip: b });
    for (let i = 0; i < 10; i++) assert.ok(startsLogin(await call('GET', i % 2 ? '/peers' : '/assets/index-abc.js', { ip: b })));
    assert.equal((await call('GET', '/peers', { ip: b })).status, 429);
    const api = await call('GET', '/api/me', { ip: b, accept: 'application/json' });
    assert.equal(api.status, 429);
    assert.match(api.text, /Too many requests/);
});

test('auth budget covers /callback and /logout', async () => {
    const c = freshIp();
    for (let i = 0; i < 15; i++) await call('GET', '/callback', { ip: c });
    for (let i = 0; i < 15; i++) await call('GET', '/logout', { ip: c });
    assert.equal((await call('GET', '/callback', { ip: c })).status, 429);
    assert.equal((await call('POST', '/callback', { ip: c })).status, 429);
    assert.equal((await call('GET', '/logout', { ip: c })).status, 429);
});

test('API budget: 600 per minute per signed-in user, shared across addresses, separate per user', async () => {
    const carol = await signIn('carol');
    const dave = await signIn('dave');
    const post = (cookie, ip) => call('POST', '/api/posture-checks/inspect-certificates', { cookie, ip, accept: 'application/json', body: { pems: [] } });
    const statuses = await inBatches(Array.from({ length: 600 }, (_, i) => i), 20, async (i) => (await post(carol, freshIp())).status);
    assert.ok(statuses.every((s) => s === 200), 'the first 600 pass, from any address');
    const limited = await post(carol, freshIp());
    assert.equal(limited.status, 429);
    assert.deepEqual(JSON.parse(limited.text), { error: 'Too many requests - try again in a moment' });
    assert.match(limited.headers.get('retry-after'), /^\d+$/);
    assert.match(limited.headers.get('ratelimit'), /"api"; r=0/);
    assert.equal((await post(dave, freshIp())).status, 200);
});

test('webhook receivers and /api/health are never rate limited, including path variants Express routes to them', async () => {
    const ip = freshIp();
    const hook = (path) => call('POST', path, { ip, accept: 'application/json', headers: { authorization: `Bearer ${HOOK_TOKEN}` }, body: {} });
    const many = await inBatches(Array.from({ length: 650 }, (_, i) => i), 20, () => hook('/api/webhook'));
    assert.ok(many.every((r) => r.status === 400 && /missing ID/.test(r.text)), 'all reached the receiver');
    assert.ok(many.every((r) => r.headers.get('ratelimit') === null));
    const health = await inBatches(Array.from({ length: 650 }, (_, i) => i), 20, () => call('GET', '/api/health', { ip, accept: 'application/json' }));
    assert.ok(health.every((r) => r.status === 200 && r.headers.get('ratelimit') === null));

    const variants = [
        ['POST', '/api/webhook/'], ['POST', '/API/WEBHOOK'], ['POST', '/api/webhook/t/abc'], ['POST', '/Api/Webhook/T/abc/'],
        ['POST', '/api/integrations/netbird-notifications'], ['POST', '/API/Integrations/NetBird-Notifications/'],
        ['POST', '/api/integrations/netbird-notifications/t/abc'], ['POST', '/api/integrations/netbird-notifications/t/abc/'],
        ['POST', '/api/integrations/telegram/callback'], ['POST', '/API/INTEGRATIONS/TELEGRAM/CALLBACK/'],
        ['GET', '/api/health/'], ['GET', '/API/HEALTH'],
    ];
    for (const [method, path] of variants) {
        const rs = await inBatches(Array.from({ length: 40 }, (_, i) => i), 20, () => (method === 'GET'
            ? call('GET', path, { ip, accept: 'application/json' })
            : hook(path)));
        for (const r of rs) {
            assert.ok(!startsLogin(r) && r.status !== 429, `${method} ${path} → ${r.status}`);
            assert.equal(r.headers.get('ratelimit'), null, `${method} ${path}`);
        }
    }
    // The Telegram webhook REGISTRATION (admin) is not a receiver: it stays behind login + limits.
    assert.ok(startsLogin(await call('POST', '/api/integrations/telegram/webhook', { ip })));
});

test('the failed-token throttle on the receivers is separate from the rate limits and still applies', async () => {
    const ip = freshIp();
    const bad = () => call('POST', '/api/webhook', { ip, accept: 'application/json', headers: { authorization: 'Bearer wrong' }, body: {} });
    for (let i = 0; i < 20; i++) assert.equal((await bad()).status, 403);
    const throttled = await bad();
    assert.equal(throttled.status, 429);
    assert.match(throttled.text, /Too many failed attempts/);
    assert.equal(throttled.headers.get('ratelimit'), null, 'not one of the rate limiters');
    const good = await call('POST', '/api/webhook', { ip: freshIp(), accept: 'application/json', headers: { authorization: `Bearer ${HOOK_TOKEN}` }, body: {} });
    assert.equal(good.status, 400);
});
