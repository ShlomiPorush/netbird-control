// The Telegram callback receiver on the real server.js stack (no SSO, stub database socket that
// drops every connection). An update reaches the callback handler only when this deployment has a
// stored webhook secret and the request carries it in X-Telegram-Bot-Api-Secret-Token; without a
// stored secret every update is rejected.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const deadDb = net.createServer((socket) => socket.destroy());
const appServer = http.createServer();
let BASE = '';
const origError = console.error;

// server.js takes both functions from ../db when it loads, so they are replaced before that.
let secret = '';
// The registered webhook secret is generated for each run; none is fixed in the repository.
const REGISTERED_SECRET = crypto.randomBytes(32).toString('hex');
const handled = [];

before(async () => {
    const dbPort = await listen(deadDb);
    BASE = `http://127.0.0.1:${await listen(appServer)}`;
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', BASE_URL: '',
        TRUST_PROXY: '', WEBHOOK_AUTH_TOKEN: '',
        DB_HOST: '127.0.0.1', DB_PORT: String(dbPort),
        NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '',
    });
    console.error = () => { }; // DB-stub failures are expected
    const db = require('../db');
    db.getTelegramWebhookSecret = () => secret;
    db.handleTelegramCallback = async (update) => { handled.push(update); };
    appServer.on('request', require('../server').app);
});

after(async () => {
    console.error = origError;
    for (const s of [appServer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

beforeEach(() => { secret = ''; handled.length = 0; });

const UPDATE = { update_id: 1, callback_query: { id: 'q1', from: { id: 12345 }, data: 'ap:1:60' } };
async function callback(headers = {}) {
    const res = await fetch(`${BASE}/api/integrations/telegram/callback`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
        body: JSON.stringify(UPDATE),
    });
    return { status: res.status, text: await res.text() };
}
const withToken = (token) => ({ 'x-telegram-bot-api-secret-token': token });

test('without a stored webhook secret every update is rejected and never handled', async () => {
    assert.equal((await callback()).status, 403);
    assert.equal((await callback(withToken(''))).status, 403);
    assert.equal((await callback(withToken('anything'))).status, 403);
    assert.equal(handled.length, 0);
});

test('rejections while no secret is stored do not count toward the failed-token throttle', async () => {
    for (let i = 0; i < 25; i++) assert.equal((await callback(withToken('x'))).status, 403);
    secret = REGISTERED_SECRET;
    assert.equal((await callback(withToken(secret))).status, 200);
    assert.equal(handled.length, 1);
});

test('with a stored secret, a missing or wrong secret header is rejected', async () => {
    secret = REGISTERED_SECRET;
    assert.equal((await callback()).status, 403);
    assert.equal((await callback(withToken('wrong-secret'))).status, 403);
    assert.equal(handled.length, 0);
});

test('with a stored secret, the matching secret header passes the update to the handler', async () => {
    secret = REGISTERED_SECRET;
    const r = await callback(withToken(secret));
    assert.equal(r.status, 200);
    assert.deepEqual(handled, [UPDATE]);
});

// Last: the block it builds up lasts for the rest of this file (every request comes from 127.0.0.1).
test('the right secret works from an address that failed too often; a wrong one from it gets 429', async () => {
    secret = REGISTERED_SECRET;
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++) last = (await callback(withToken('wrong-secret'))).status;
    assert.equal(last, 429, 'the address is blocked');
    assert.equal((await callback()).status, 429, 'no secret');
    const r = await callback(withToken(secret));
    assert.equal(r.status, 200);
    assert.deepEqual(handled, [UPDATE]);
    assert.equal((await callback(withToken('wrong-secret'))).status, 429, 'the right secret does not lift the block');
});
