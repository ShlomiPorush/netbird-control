// NetBird API rate limiting (lib/netbird.js): a 429 answer is sent again, for every method, up to
// 5 attempts and 30 seconds of waiting per call. The wait is NetBird's Retry-After (seconds or an
// HTTP date) when present, otherwise exponential backoff with jitter. When a limit is reached the
// caller gets the last 429 answer unchanged. Network errors and 5xx answers are not retried.
// After a 429, other calls wait out the same cooldown before they send.
// A local HTTP server plays NetBird; the clock and the sleep are fake, so no test waits.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

let replies = [];
let requests = [];
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        requests.push({ method: req.method, path: req.url, body });
        const next = replies.length > 1 ? replies.shift() : replies[0];
        if (next === 'drop') { req.socket.destroy(); return; }
        res.writeHead(next.status, { 'Content-Type': 'application/json', ...(next.headers || {}) });
        res.end(JSON.stringify(next.body));
    });
});

const TOO_MANY = { message: 'too many requests', code: 429 };
const limited = (retryAfter) => ({ status: 429, body: TOO_MANY, headers: retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) } });
const ok = (body, status = 200) => ({ status, body });

let nb;
let clock = 0;
let waits = [];
const origWarn = console.warn;
const origError = console.error;

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, {
        NETBIRD_API_URL: `http://127.0.0.1:${server.address().port}`,
        NETBIRD_API_TOKEN: crypto.randomBytes(24).toString('hex'),
        NETBIRD_READONLY: '',
    });
    console.warn = () => { };
    console.error = () => { };
    nb = require('../lib/netbird');
});

after(async () => {
    console.warn = origWarn;
    console.error = origError;
    await new Promise((resolve) => server.close(resolve));
    await require('../lib/core').pool.end();
});

beforeEach(() => {
    replies = [];
    requests = [];
    waits = [];
    clock = Date.parse('2026-01-01T00:00:00Z');
    nb._setNetbirdTimingForTests({
        now: () => clock,
        sleep: async (ms) => { waits.push(ms); clock += ms; },
    });
});

test('a GET answered 429 and then 200 returns the 200 body', async () => {
    replies = [limited(), ok([{ id: 'g1' }])];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), [{ id: 'g1' }]);
    assert.equal(requests.length, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 500 && waits[0] <= 1000, `first backoff ${waits[0]} ms`);
});

test('a POST answered 429 is sent again with the same body and returns the usual result', async () => {
    replies = [limited(1), ok({ id: 'p1' }, 201)];
    const r = await nb.netbirdPost('/api/policies', { name: 'x' });
    assert.deepEqual(r, { status: 201, body: { id: 'p1' }, raw: '{"id":"p1"}' });
    assert.deepEqual(requests.map((q) => [q.method, q.body]), [['POST', '{"name":"x"}'], ['POST', '{"name":"x"}']]);
});

test('PUT and DELETE answered 429 are sent again', async () => {
    replies = [limited(1), ok({ id: 'r1' })];
    assert.equal((await nb.netbirdPut('/api/networks/n1/resources/r1', { groups: [] })).status, 200);
    replies = [limited(1), ok({})];
    assert.equal((await nb.netbirdReq('DELETE', '/api/groups/g1')).status, 200);
    assert.deepEqual(requests.map((q) => q.method), ['PUT', 'PUT', 'DELETE', 'DELETE']);
});

test('Retry-After in seconds is honored', async () => {
    replies = [limited(3), ok([])];
    await nb.netbirdGet('/api/groups');
    assert.deepEqual(waits, [3000]);
});

test('Retry-After as an HTTP date is honored', async () => {
    replies = [limited(new Date(clock + 7000).toUTCString()), ok([])];
    await nb.netbirdGet('/api/groups');
    assert.deepEqual(waits, [7000]);
});

test('without Retry-After the backoff grows exponentially, with jitter', async () => {
    replies = [limited(), limited(), limited(), limited(), ok([])];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), []);
    assert.equal(waits.length, 4);
    waits.forEach((ms, i) => {
        const exp = 1000 * 2 ** i;
        assert.ok(ms >= exp / 2 && ms <= exp, `backoff ${i + 1}: ${ms} ms`);
    });
});

test('after 5 attempts the caller gets the original 429', async () => {
    replies = [limited(1)];
    const r = await nb.netbirdReq('PUT', '/api/networks/n1/resources/r1', { groups: [] });
    assert.deepEqual(r, { status: 429, body: TOO_MANY, raw: JSON.stringify(TOO_MANY) });
    assert.equal(requests.length, 5);
    assert.deepEqual(waits, [1000, 1000, 1000, 1000]);

    requests = []; waits = []; clock += 60_000;
    assert.deepEqual(await nb.netbirdGet('/api/groups'), TOO_MANY);
    assert.equal(requests.length, 5);
});

test('a call waits at most 30 seconds in total', async () => {
    replies = [limited(20)];
    const r = await nb.netbirdPost('/api/groups', { name: 'g' });
    assert.equal(r.status, 429);
    assert.equal(requests.length, 2);
    assert.deepEqual(waits, [20000]);
});

test('a Retry-After longer than the limit fails at once and is not shared', async () => {
    replies = [limited(120)];
    assert.equal((await nb.netbirdPost('/api/groups', { name: 'g' })).status, 429);
    assert.equal(requests.length, 1);
    replies = [ok([])];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), []);
    assert.deepEqual(waits, []);
});

test('after a 429, the next call waits out the shared cooldown before it sends', async () => {
    replies = [limited(2)];
    assert.equal((await nb.netbirdReq('DELETE', '/api/groups/g1')).status, 429);
    assert.deepEqual(waits, [2000, 2000, 2000, 2000]);
    waits = [];
    replies = [ok([])];
    assert.deepEqual(await nb.netbirdGet('/api/peers'), []);
    assert.deepEqual(waits, [2000]);
});

test('5xx answers and network errors are not retried', async () => {
    replies = [{ status: 503, body: { message: 'unavailable' } }];
    assert.equal((await nb.netbirdPost('/api/groups', { name: 'g' })).status, 503);
    assert.deepEqual(await nb.netbirdGet('/api/groups'), { message: 'unavailable' });
    replies = ['drop'];
    assert.equal((await nb.netbirdReq('DELETE', '/api/groups/g1')).status, 0);
    assert.equal(await nb.netbirdGet('/api/groups'), null);
    assert.equal(requests.length, 4);
    assert.deepEqual(waits, []);
});
