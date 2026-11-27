// NetBird API rate limiting (lib/netbird.js): a 429 answer is sent again, for every method, up to
// 5 attempts, waiting at most 5 seconds in total for a read (GET) and 30 seconds for a write. The
// wait is NetBird's Retry-After (seconds or an IMF-fixdate) when present, otherwise exponential
// backoff with jitter, and it is a pause shared by every call (at most 10 minutes): nothing is
// sent while it lasts, and a call that cannot wait it out ends at once with a 429. When a limit is
// reached the caller gets a 429 in its usual result shape. Network errors and 5xx are not retried.
// A local HTTP server plays NetBird; the clock and the sleep are fake, so no test waits.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

let replies = [];
let routes = {}; // path → its own reply queue (otherwise `replies` answers)
let requests = [];
let held = []; // answers a test sends later
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        requests.push({ method: req.method, path: req.url, body });
        const queue = routes[req.url] || replies;
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next === 'drop') { req.socket.destroy(); return; }
        if (next === 'cut') { // headers and half the body, then the connection closes
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
            res.write('[{"id":');
            setTimeout(() => req.socket.destroy(), 20);
            return;
        }
        if (next.hold) { held.push(() => answer(res, next.hold)); return; }
        answer(res, next);
    });
});
function answer(res, next) {
        res.writeHead(next.status, { 'Content-Type': 'application/json', ...(next.headers || {}) });
        res.end(JSON.stringify(next.body));
}

const TOO_MANY = { message: 'too many requests', code: 429 };
const limited = (retryAfter) => ({ status: 429, body: TOO_MANY, headers: retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) } });
const ok = (body, status = 200) => ({ status, body });

let nb;
let clock = 0; // the monotonic clock; the wall clock is WALL0 + clock
const WALL0 = Date.parse('2026-01-01T00:00:00Z');
let waits = [];
let manual = null; // when set, sleeps wait here until the test releases them
const autoSleep = async (ms) => { waits.push(ms); clock += ms; };
const manualSleep = (ms) => new Promise((resolve) => { waits.push(ms); manual.push(() => { clock += ms; resolve(); }); });
const until = async (cond) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(cond(), 'condition never met'); };
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
    routes = {};
    requests = [];
    held = [];
    waits = [];
    manual = null;
    clock = 0;
    nb._setNetbirdTimingForTests({
        now: () => clock,
        wallNow: () => WALL0 + clock,
        sleep: (ms) => (manual ? manualSleep(ms) : autoSleep(ms)),
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
    replies = [limited(new Date(WALL0 + 7000).toUTCString()), ok({})];
    await nb.netbirdPost('/api/groups', { name: 'g' });
    assert.deepEqual(waits, [7000]);
});

test('an unreadable Retry-After falls back to the backoff, never to no wait', async () => {
    for (const value of [
        '-1', '1.5', 'soon', '2026-01-01',
        'Mon, 30 Feb 2026 00:00:07 GMT',    // an impossible date, not 2 March
        'Thursday, 01-Jan-26 00:00:07 GMT', // obsolete RFC 850 form
        'Thu Jan  1 00:00:07 2026',         // obsolete asctime form
        'Sat, 01 Jan 10000 00:00:00 GMT',   // IMF-fixdate has a 4-digit year
    ]) {
        waits = [];
        nb._setNetbirdTimingForTests({});
        replies = [limited(value), ok([])];
        await nb.netbirdGet('/api/groups');
        assert.equal(waits.length, 1, value);
        assert.ok(waits[0] >= 500 && waits[0] <= 1000, `${value}: ${waits[0]} ms`);
    }
});

test('without Retry-After the backoff grows exponentially, with jitter', async () => {
    replies = [limited(), limited(), limited(), limited(), ok({})];
    assert.equal((await nb.netbirdReq('PUT', '/api/groups/g1', { name: 'g' })).status, 200);
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

test('a GET waits at most 5 seconds in total, so a page never hangs on it', async () => {
    replies = [limited(3)];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), TOO_MANY);
    assert.equal(requests.length, 2); // 3 s, then 3 s more would pass 5 s
    assert.deepEqual(waits, [3000]);
});

test('a write waits at most 30 seconds in total', async () => {
    replies = [limited(20)];
    const r = await nb.netbirdPost('/api/groups', { name: 'g' });
    assert.equal(r.status, 429);
    assert.equal(requests.length, 2);
    assert.deepEqual(waits, [20000]);
});

test('the budget counts the time that really passed when a timer fires late', async () => {
    let late = 15_000;
    nb._setNetbirdTimingForTests({ sleep: async (ms) => { waits.push(ms); clock += ms + late; late = 0; } });
    replies = [limited(10)];
    assert.equal((await nb.netbirdPost('/api/groups', { name: 'g' })).status, 429);
    assert.equal(requests.length, 2); // 25 s passed, so 10 s more would pass the 30 s limit
    assert.deepEqual(waits, [10000]);
});

test('during a pause longer than a call may wait, nothing is sent and the call ends at once with the 429', async () => {
    replies = [limited(120)];
    assert.equal((await nb.netbirdPost('/api/groups', { name: 'g' })).status, 429);
    assert.equal(requests.length, 1);
    replies = [ok([])];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), TOO_MANY);
    assert.deepEqual(await nb.netbirdReq('PUT', '/api/groups/g1', { name: 'g' }), { status: 429, body: TOO_MANY, raw: JSON.stringify(TOO_MANY) });
    assert.equal(requests.length, 1);
    assert.deepEqual(waits, []);
    clock += 120_000; // the pause is over
    assert.deepEqual(await nb.netbirdGet('/api/groups'), []);
    assert.equal(requests.length, 2);
});

test('a pause too long for a GET is waited out by a write', async () => {
    replies = [limited(20)];
    assert.equal((await nb.netbirdPost('/api/groups', { name: 'g' })).status, 429); // pause: 20 s
    requests = []; waits = [];
    replies = [ok({})];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), TOO_MANY);
    assert.equal(requests.length, 0);
    assert.equal((await nb.netbirdReq('DELETE', '/api/groups/g1')).status, 200);
    assert.deepEqual(waits, [20000]);
    assert.equal(requests.length, 1);
});

test('a pause longer than 10 minutes is capped at 10 minutes', async () => {
    replies = [limited(3600)];
    assert.equal((await nb.netbirdPost('/api/groups', { name: 'g' })).status, 429);
    clock += 10 * 60_000;
    replies = [ok([])];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), []);
    assert.equal(requests.length, 2);
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

test('a call that is already waiting also waits out a longer cooldown set meanwhile', async () => {
    manual = [];
    routes['/api/b'] = [{ hold: limited(5) }, ok([])];
    routes['/api/a'] = [limited(1), ok([])];
    const b = nb.netbirdReq('PUT', '/api/b', {});
    await until(() => held.length === 1); // B is sent; its answer is held
    const a = nb.netbirdReq('PUT', '/api/a', {});
    await until(() => manual.length === 1); // A got its 429 and waits 1 s
    held.shift()(); // now B gets a 429 asking for 5 s
    await until(() => manual.length === 2);
    manual.shift()(); // A wakes after 1 s ...
    await until(() => manual.length === 2);
    assert.deepEqual(waits, [1000, 5000, 4000]); // ... and waits the 4 s left before it sends
    assert.equal(requests.filter((q) => q.path === '/api/a').length, 1);
    while (manual.length) { manual.shift()(); await new Promise((r) => setTimeout(r, 10)); }
    assert.deepEqual((await Promise.all([a, b])).map((r) => r.status), [200, 200]);
});

test('a GET whose timer fires late does not send again past its 5 seconds', async () => {
    nb._setNetbirdTimingForTests({ sleep: async (ms) => { waits.push(ms); clock += ms + 2000; } });
    replies = [limited(4), ok([])];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), TOO_MANY);
    assert.equal(requests.length, 1);
});

test('a call that is never sent gets a plain 429, never another call\'s answer', async () => {
    const detailed = { message: 'too many requests for account acc-1', code: 429 };
    replies = [{ status: 429, body: detailed, headers: { 'Retry-After': '120' } }];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), detailed); // its own answer
    replies = [ok([])];
    assert.deepEqual(await nb.netbirdGet('/api/peers'), TOO_MANY);
    assert.deepEqual(await nb.netbirdPost('/api/groups', { name: 'g' }), { status: 429, body: TOO_MANY, raw: JSON.stringify(TOO_MANY) });
    assert.equal(requests.length, 1);
});

test('a retry that ends in a network error reports the 429, not a status 0, marked as an answer that was lost', async () => {
    replies = [limited(1), 'drop'];
    assert.deepEqual(await nb.netbirdReq('DELETE', '/api/groups/g1'), { status: 429, body: TOO_MANY, raw: JSON.stringify(TOO_MANY), answerLost: true });
    clock += 60_000;
    replies = [limited(1), 'drop'];
    assert.deepEqual(await nb.netbirdGet('/api/groups'), TOO_MANY);
    assert.equal(requests.length, 4);
});

test('a connection closed in the middle of the body ends the call as a network error', { timeout: 5000 }, async () => {
    replies = ['cut'];
    assert.equal(await nb.netbirdGet('/api/groups'), null);
    const r = await nb.netbirdReq('PUT', '/api/groups/g1', { name: 'g' });
    assert.equal(r.status, 0);
    assert.equal(typeof r.error, 'string');
    assert.equal(requests.length, 2);
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
