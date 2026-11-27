const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const http = require('../lib/http');
let reply = null;
let sends = 0;
http.httpJson = async () => { sends++; return reply; };

const core = require('../lib/core');
let rows = [];
const done = [];
core.pool.query = async (sql, params = []) => {
    if (/^SELECT \* FROM outbox/.test(sql)) return { rows: rows.splice(0) };
    if (/^DELETE FROM outbox/.test(sql)) { done.push(['deleted', params[0]]); return { rows: [] }; }
    if (/^UPDATE outbox/.test(sql)) { done.push(['kept', params[0], params[1], params[3]]); return { rows: [] }; }
    return { rows: [] };
};

const tg = require('../lib/telegram');
tg._setTelegramSleepForTests(async () => { });
const db = require('../db');

const telegram = (state) => Object.assign(tg.getTelegramState(), { enabled: true, token: crypto.randomBytes(16).toString('hex'), chatId: '-1001', categories: {} }, state);
const queue = () => { rows = [{ id: 7, tenant: '', channel: 'anomaly-alert', payload: { html: 'moved' }, attempts: 0 }]; done.length = 0; sends = 0; };

test('an alert Telegram accepted leaves the queue', async () => {
    telegram();
    reply = { status: 200, body: { ok: true, result: { message_id: 1, chat: { id: -1001 } } } };
    queue();
    await db.deliverOutbox();
    assert.deepEqual(done, [['deleted', 7]]);
    assert.equal(sends, 1);
});

test('an alert Telegram refused stays queued for another try', async () => {
    telegram();
    reply = { status: 403, raw: '{"ok":false,"description":"Forbidden"}' };
    queue();
    await db.deliverOutbox();
    assert.deepEqual(done, [['kept', 7, 1, 'pending']]);
});

test('an alert with Telegram off or the alerts category off leaves the queue without a send', async () => {
    for (const state of [{ enabled: false }, { categories: { alerts: { enabled: false } } }]) {
        telegram(state);
        queue();
        await db.deliverOutbox();
        assert.deepEqual(done, [['deleted', 7]]);
        assert.equal(sends, 0);
    }
});
