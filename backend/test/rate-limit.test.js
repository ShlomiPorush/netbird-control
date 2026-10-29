// Rate-limit options (lib/rate-limit.js) on a minimal Express app: the 429 after the limit, the
// reset after the window, the headers, and which requests share a bucket. The full server stack
// (mount order, login gate, never-limited receivers) is covered by server-auth-gate.test.js and
// server-open-mode.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { LIMITS, WINDOW_MS, MESSAGE, parseTrustProxy, limiterOptions } = require('../lib/rate-limit');

// Starts `app` on a loopback port and returns a request helper plus close().
async function serve(app) {
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });
    return { get, close: () => new Promise((r) => server.close(r)) };
}

// An app with one limiter in front of a 200 handler. `user` (a header the fake identity
// middleware reads) stands in for the verified OIDC session express-openid-connect provides.
function limitedApp(kind, { windowMs, trustProxy = 'loopback', sso = true, mount = '/' } = {}) {
    const app = express();
    app.set('trust proxy', trustProxy);
    if (sso) {
        app.use((req, res, next) => {
            const sub = req.headers['x-test-user'];
            req.oidc = { isAuthenticated: () => !!sub, user: sub ? { sub } : undefined };
            next();
        });
    }
    app.use(mount, rateLimit(limiterOptions(kind, { windowMs })));
    app.use((req, res) => res.json({ ok: true }));
    return app;
}

// Sends n requests, 20 at a time, and drains their bodies.
async function burn(get, path, n, headers) {
    for (let done = 0; done < n; done += 20) {
        const batch = Math.min(20, n - done);
        await Promise.all(Array.from({ length: batch }, () => get(path, headers).then((r) => r.arrayBuffer())));
    }
}

test('limits and window are fixed', () => {
    assert.deepEqual({ ...LIMITS }, { auth: 30, api: 600, spa: 300 });
    assert.equal(WINDOW_MS, 60_000);
    assert.equal(limiterOptions('api').limit, 600);
    assert.throws(() => limiterOptions('nope'));
});

test('429 with a JSON error, RateLimit headers and Retry-After after the limit', async () => {
    // The real 60 s window, so a slow machine can't let the window reset in the middle.
    const { get, close } = await serve(limitedApp('auth'));
    try {
        const first = await get('/api/x');
        assert.equal(first.status, 200);
        assert.match(first.headers.get('ratelimit'), /^"auth"; r=29; t=\d+$/);
        assert.match(first.headers.get('ratelimit-policy'), /^"auth"; q=30; w=60; pk=:[^:]+:$/);
        await burn(get, '/api/x', 29);
        const limited = await get('/api/x');
        assert.equal(limited.status, 429);
        assert.deepEqual(await limited.json(), { error: MESSAGE });
        assert.match(limited.headers.get('retry-after'), /^\d+$/);
        assert.match(limited.headers.get('ratelimit'), /r=0/);
        // A browser page gets the same message as plain text.
        const page = await get('/peers', { accept: 'text/html' });
        assert.equal(page.status, 429);
        assert.equal(await page.text(), MESSAGE);
    } finally { await close(); }
});

test('the count resets after the window', async () => {
    // Only waits past the window, so a slow machine can delay the test but not fail it.
    const { get, close } = await serve(limitedApp('auth', { windowMs: 1500 }));
    try {
        assert.match((await get('/api/x')).headers.get('ratelimit'), /r=29;/);
        await new Promise((r) => setTimeout(r, 1600));
        assert.match((await get('/api/x')).headers.get('ratelimit'), /r=29;/);
    } finally { await close(); }
});

test('two signed-in users do not share a bucket', async () => {
    const { get, close } = await serve(limitedApp('spa'));
    try {
        await burn(get, '/', LIMITS.spa, { 'x-test-user': 'alice' });
        assert.equal((await get('/', { 'x-test-user': 'alice' })).status, 429);
        assert.equal((await get('/', { 'x-test-user': 'bob' })).status, 200);
    } finally { await close(); }
});

test('one user managing several tenants has one bucket (X-Tenant-Account is not part of the key)', async () => {
    const { get, close } = await serve(limitedApp('api', { mount: '/api' }));
    try {
        const r1 = await get('/api/peers', { 'x-test-user': 'carol', 'x-tenant-account': 'tenant-a' });
        const r2 = await get('/api/peers', { 'x-test-user': 'carol', 'x-tenant-account': 'tenant-b' });
        const r3 = await get('/api/peers', { 'x-test-user': 'carol' });
        assert.match(r1.headers.get('ratelimit'), /r=599;/);
        assert.match(r2.headers.get('ratelimit'), /r=598;/);
        assert.match(r3.headers.get('ratelimit'), /r=597;/);
    } finally { await close(); }
});

test('a signed-in user is keyed by user, not by the address they come from', async () => {
    const { get, close } = await serve(limitedApp('api', { mount: '/api' }));
    try {
        await get('/api/x', { 'x-test-user': 'dave', 'x-forwarded-for': '198.51.100.1' });
        const r = await get('/api/x', { 'x-test-user': 'dave', 'x-forwarded-for': '198.51.100.2' });
        assert.match(r.headers.get('ratelimit'), /r=598;/);
    } finally { await close(); }
});

test('two client IPs do not share a bucket; IPv6 addresses in one /56 do', async () => {
    const { get, close } = await serve(limitedApp('auth'));
    try {
        await burn(get, '/login', LIMITS.auth, { 'x-forwarded-for': '203.0.113.7' });
        assert.equal((await get('/login', { 'x-forwarded-for': '203.0.113.7' })).status, 429);
        assert.equal((await get('/login', { 'x-forwarded-for': '203.0.113.8' })).status, 200);
        await burn(get, '/login', LIMITS.auth, { 'x-forwarded-for': '2001:db8:1:100::1' });
        assert.equal((await get('/login', { 'x-forwarded-for': '2001:db8:1:1ff::2' })).status, 429);
        assert.equal((await get('/login', { 'x-forwarded-for': '2001:db8:2::1' })).status, 200);
    } finally { await close(); }
});

test('without SSO (no req.oidc) the API and SPA limiters key by client IP', async () => {
    const { get, close } = await serve(limitedApp('api', { sso: false, mount: '/api' }));
    try {
        await get('/api/x', { 'x-forwarded-for': '192.0.2.1', 'x-test-user': 'ignored' });
        const same = await get('/api/x', { 'x-forwarded-for': '192.0.2.1', 'x-test-user': 'other' });
        const other = await get('/api/x', { 'x-forwarded-for': '192.0.2.2' });
        assert.match(same.headers.get('ratelimit'), /r=598;/);
        assert.match(other.headers.get('ratelimit'), /r=599;/);
    } finally { await close(); }
});

test('the auth budget skips signed-in visitors and charges a request once even if mounted twice', async () => {
    const app = express();
    app.set('trust proxy', 'loopback');
    const limiter = rateLimit(limiterOptions('auth'));
    app.use('/login', limiter); // before the identity middleware: always charged
    app.use((req, res, next) => {
        const sub = req.headers['x-test-user'];
        req.oidc = { isAuthenticated: () => !!sub, user: sub ? { sub } : undefined };
        next();
    });
    app.use(limiter); // the requiresAuth() position: charged only when not signed in
    app.use((req, res) => res.json({ ok: true }));
    const { get, close } = await serve(app);
    try {
        const ip = { 'x-forwarded-for': '192.0.2.50' };
        assert.match((await get('/login', ip)).headers.get('ratelimit'), /r=29;/);
        assert.match((await get('/peers', ip)).headers.get('ratelimit'), /r=28;/);
        // Signed in: not charged at the requiresAuth() position.
        const signedIn = await get('/peers', { ...ip, 'x-test-user': 'erin' });
        assert.equal(signedIn.headers.get('ratelimit'), null);
    } finally { await close(); }
});

test('the SPA limiter skips /api and the build assets that exist, not other /assets paths', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbc-assets-'));
    try {
        fs.writeFileSync(path.join(dir, 'index-abc123.js'), '');
        const { skip } = limiterOptions('spa', { assetsDir: dir });
        assert.equal(skip({ path: '/api/logs' }), true);
        assert.equal(skip({ path: '/API/logs' }), true);
        assert.equal(skip({ path: '/assets/index-abc123.js' }), true);
        assert.equal(skip({ path: '/assets/missing.js' }), false);
        assert.equal(skip({ path: '/' }), false);
        assert.equal(skip({ path: '/index.html' }), false);
        assert.equal(skip({ path: '/version.txt' }), false);
        assert.equal(skip({ path: '/apiary' }), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('TRUST_PROXY parsing: default trusts nobody; hop counts and address lists pass through; true is refused', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('1'), 1);
    assert.deepEqual(parseTrustProxy('10.0.0.5'), ['10.0.0.5']);
    assert.deepEqual(parseTrustProxy('loopback, 172.18.0.0/16'), ['loopback', '172.18.0.0/16']);
    const orig = console.error;
    console.error = () => { };
    try { assert.equal(parseTrustProxy('true'), false); } finally { console.error = orig; }
});

test('TRUST_PROXY: the default ignores X-Forwarded-For; an explicit proxy address honors it', async () => {
    const ipApp = (trust) => {
        const app = express();
        app.set('trust proxy', parseTrustProxy(trust));
        app.get('/ip', (req, res) => res.json({ ip: req.ip }));
        return app;
    };
    const spoof = { 'x-forwarded-for': '203.0.113.99' };
    const dflt = await serve(ipApp(undefined));
    try {
        assert.match((await (await dflt.get('/ip', spoof)).json()).ip, /127\.0\.0\.1$/);
    } finally { await dflt.close(); }
    const proxied = await serve(ipApp('127.0.0.1'));
    try {
        assert.equal((await (await proxied.get('/ip', spoof)).json()).ip, '203.0.113.99');
    } finally { await proxied.close(); }
    const otherProxy = await serve(ipApp('10.9.9.9'));
    try {
        assert.match((await (await otherProxy.get('/ip', spoof)).json()).ip, /127\.0\.0\.1$/);
    } finally { await otherProxy.close(); }
});
