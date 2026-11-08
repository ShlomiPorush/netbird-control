// withCancelOnClose runs an Activity read on its own database client and cancels the running
// query when the browser drops the request. These checks use a fake pool, so they cover the
// order of operations: the cancel reaches only this request's backend, is awaited before the
// client goes back, and a cancelled connection is discarded instead of reused.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { withCancelOnClose } = require('../lib/core');

function fakeDb() {
    const log = [];
    const client = { processID: 4242, release: (discard) => log.push(['release', discard]) };
    return {
        log,
        client,
        connect: async () => client,
        query: async (sql, params) => { log.push(['query', sql, params]); return { rows: [] }; },
    };
}
const fakeRes = () => Object.assign(new EventEmitter(), { writableFinished: false });

test('a request that completes releases its client for reuse and never cancels', async () => {
    const db = fakeDb();
    const res = fakeRes();
    const out = await withCancelOnClose(res, async (c) => { assert.equal(c, db.client); return 'rows'; }, db);
    assert.equal(out, 'rows');
    res.writableFinished = true;
    res.emit('close');
    assert.deepEqual(db.log, [['release', undefined]]);
    assert.equal(res.listenerCount('close'), 0);
});

test('a dropped request cancels its own backend, then discards the connection', async () => {
    const db = fakeDb();
    const res = fakeRes();
    let fail;
    const running = withCancelOnClose(res, () => new Promise((_, reject) => { fail = reject; }), db);
    await new Promise(setImmediate); // let it reach the query
    res.emit('close');
    res.emit('close'); // a second close sends no second cancel
    fail(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
    await assert.rejects(running, (err) => err.requestClosed === true && err.code === '57014');
    assert.deepEqual(db.log, [
        ['query', 'SELECT pg_cancel_backend($1)', [4242]],
        ['release', true],
    ]);
});

test('an ordinary failure is not marked as a dropped request', async () => {
    const db = fakeDb();
    const res = fakeRes();
    await assert.rejects(
        withCancelOnClose(res, async () => { throw new Error('boom'); }, db),
        (err) => err.message === 'boom' && err.requestClosed === undefined,
    );
    assert.deepEqual(db.log, [['release', undefined]]);
});
