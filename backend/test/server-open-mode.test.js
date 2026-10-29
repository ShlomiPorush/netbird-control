// The real server.js stack without SSO and without TRUST_PROXY: the app stays open (no login),
// every limit keys by the TCP peer address (X-Forwarded-For is ignored), and the webhook
// receivers and the health probe are never rate limited. The database is a stub socket that
// drops every connection (no real database).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const deadDb = net.createServer((socket) => socket.destroy());
const appServer = http.createServer();
let BASE = '';
const origError = console.error;

before(async () => {
    const dbPort = await listen(deadDb);
    BASE = `http://127.0.0.1:${await listen(appServer)}`;
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', BASE_URL: '',
        TRUST_PROXY: '', WEBHOOK_AUTH_TOKEN: '',
        DB_HOST: '127.0.0.1', DB_PORT: String(dbPort),
        NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '',
    });
    console.error = () => { }; // DB-stub failures and the X-Forwarded-For warning are expected
    appServer.on('request', require('../server').app);
});

after(async () => {
    console.error = origError;
    for (const s of [appServer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

async function call(method, path, { headers = {}, body } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    return { status: res.status, headers: res.headers, text: await res.text() };
}
async function inBatches(n, width, fn) {
    const out = [];
    for (let i = 0; i < n; i += width) out.push(...await Promise.all(Array.from({ length: Math.min(width, n - i) }, fn)));
    return out;
}

test('without SSO the app stays open: no login, pages and the API answer directly', async () => {
    assert.equal((await call('GET', '/version.txt')).status, 200);
    assert.notEqual((await call('GET', '/login')).status, 302);
    assert.equal((await call('POST', '/api/posture-checks/inspect-certificates', { body: { pems: [] } })).status, 200);
});

test('without TRUST_PROXY, X-Forwarded-For is ignored: every "address" shares the peer bucket', async () => {
    const a = await call('GET', '/version.txt', { headers: { 'x-forwarded-for': '203.0.113.1' } });
    const b = await call('GET', '/version.txt', { headers: { 'x-forwarded-for': '203.0.113.2' } });
    const ra = Number(/r=(\d+)/.exec(a.headers.get('ratelimit'))[1]);
    const rb = Number(/r=(\d+)/.exec(b.headers.get('ratelimit'))[1]);
    assert.equal(rb, ra - 1);
});

test('SPA budget (300) and API budget (600) per IP; the receivers and /api/health are never limited', async () => {
    const remaining = (r) => Number(/r=(\d+)/.exec(r.headers.get('ratelimit'))[1]);
    const probe = await call('GET', '/version.txt');
    assert.equal(probe.headers.get('ratelimit-policy').startsWith('"spa"; q=300; w=60;'), true);
    const pages = await inBatches(remaining(probe), 20, () => call('GET', '/version.txt'));
    assert.ok(pages.every((r) => r.status === 200));
    const page = await call('GET', '/', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 429);
    assert.match(page.headers.get('ratelimit'), /"spa"; r=0/);

    const apiProbe = await call('POST', '/api/posture-checks/inspect-certificates', { body: { pems: [] } });
    assert.equal(apiProbe.headers.get('ratelimit-policy').startsWith('"api"; q=600; w=60;'), true);
    const apis = await inBatches(remaining(apiProbe), 20, () => call('POST', '/api/posture-checks/inspect-certificates', { body: { pems: [] } }));
    assert.ok(apis.every((r) => r.status === 200));
    const api = await call('GET', '/api/me');
    assert.equal(api.status, 429);
    assert.match(api.text, /Too many requests/);
    assert.match(api.headers.get('retry-after'), /^\d+$/);

    // Same client, both budgets spent - the receivers still take everything.
    const hooks = await inBatches(650, 20, () => call('POST', '/api/webhook', { body: {} }));
    assert.ok(hooks.every((r) => r.status === 400 && r.headers.get('ratelimit') === null));
    for (const path of ['/api/webhook/', '/API/WEBHOOK', '/api/webhook/t/abc', '/api/integrations/netbird-notifications', '/api/integrations/netbird-notifications/t/abc/', '/api/integrations/telegram/callback', '/API/Integrations/Telegram/Callback/']) {
        const r = await call('POST', path, { body: {} });
        assert.notEqual(r.status, 429, path);
        assert.equal(r.headers.get('ratelimit'), null, path);
    }
    for (const path of ['/api/health', '/API/HEALTH/']) {
        const r = await call('GET', path);
        assert.equal(r.status, 200, path);
        assert.equal(r.headers.get('ratelimit'), null, path);
    }
});
