// The Telegram send queue (lib/telegram.js): only a 2xx response counts as sent. Any other
// result - a network failure (status 0), an API rejection (4xx), a server error (5xx) or a
// thrown error - keeps the message at the head of the queue and retries it after a minute
// (longer if a 429 asks for it), until TG_MAX_ATTEMPTS. The test connection check reports a
// network failure as a failure.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the HTTP helper BEFORE lib/telegram.js loads (it destructures httpJson at require time).
const http = require('../lib/http');
let replies = [], calls = [];
http.httpJson = async (method, url, opts) => {
    calls.push({ method, url, body: opts && opts.body });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (next instanceof Error) throw next;
    return next;
};
const tg = require('../lib/telegram');

let waits = [];
tg._setTelegramSleepForTests(async (ms) => { waits.push(ms); });
let observed = [];
tg.setTelegramObserver((e) => observed.push({ ok: e.ok, error: e.error }));
Object.assign(tg.getTelegramState(), { enabled: true, token: 'test-token', chatId: '-1001' });

const OK = { status: 200, body: { ok: true, result: { message_id: 42, chat: { id: -1001 } } } };
const reset = (...r) => { replies = r; calls = []; waits = []; observed = []; };
const send = () => tg.sendTelegram('alerts', 'hello');

test('a 2xx response is sent once, with no retry', async () => {
    reset(OK);
    assert.deepEqual(await send(), { chatId: '-1001', messageId: '42' });
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(observed, [{ ok: true, error: undefined }]);
});

test('a network failure (status 0) is retried after a minute, not counted as sent', async () => {
    reset({ status: 0, error: 'timeout' }, OK);
    assert.deepEqual(await send(), { chatId: '-1001', messageId: '42' });
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [60_000]);
    assert.deepEqual(observed, [{ ok: true, error: undefined }]);
});

test('an API rejection (400) is retried after a minute', async () => {
    reset({ status: 400, raw: '{"ok":false,"description":"Bad Request"}' }, OK);
    assert.deepEqual(await send(), { chatId: '-1001', messageId: '42' });
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [60_000]);
});

test('a server error (500) and a thrown error are retried after a minute', async () => {
    reset({ status: 500, raw: 'oops' }, new Error('socket hang up'), OK);
    assert.deepEqual(await send(), { chatId: '-1001', messageId: '42' });
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [60_000, 60_000]);
});

test('a 429 waits for retry_after when it is longer than a minute', async () => {
    reset({ status: 429, body: { ok: false, parameters: { retry_after: 120 } } }, { status: 429, body: { ok: false, parameters: { retry_after: 5 } } }, OK);
    assert.deepEqual(await send(), { chatId: '-1001', messageId: '42' });
    assert.deepEqual(waits, [120_000, 60_000]);
});

test('the queue gives up after 5 attempts and reports the failure', async () => {
    reset({ status: 0, error: 'getaddrinfo ENOTFOUND api.telegram.org' });
    assert.equal(await send(), null);
    assert.equal(calls.length, 5);
    assert.deepEqual(waits, [60_000, 60_000, 60_000, 60_000]);
    assert.deepEqual(observed, [{ ok: false, error: 'getaddrinfo ENOTFOUND api.telegram.org' }]);
});

test('a message queued behind a retrying one is sent after it, in order', async () => {
    reset({ status: 0, error: 'ECONNRESET' }, OK);
    const texts = () => calls.map((c) => c.body.text);
    const [a, b] = await Promise.all([tg.sendTelegram('alerts', 'first'), tg.sendTelegram('alerts', 'second')]);
    assert.ok(a && b);
    assert.deepEqual(texts(), ['first', 'first', 'second']);
});

test('the connection test reports a network failure as a failure', async () => {
    reset({ status: 0, error: 'timeout' });
    assert.deepEqual(await tg.telegramTest(), { ok: false, error: 'timeout' });
    reset({ status: 403, raw: 'Forbidden: bot was kicked' });
    assert.deepEqual(await tg.telegramTest(), { ok: false, error: 'Forbidden: bot was kicked' });
    reset(OK);
    assert.deepEqual(await tg.telegramTest(), { ok: true });
    assert.deepEqual(waits, []);
});
