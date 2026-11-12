// withCancelOnClose runs an Activity read on its own database client and cancels the running
// query when the browser drops the request. These checks use a fake pool and a fake cancel, so
// they cover the order of operations: the cancel targets only this request's backend and never
// uses the pool, it is awaited before the client goes back, a cancelled connection is discarded
// instead of reused, and a request that is already gone never starts its query.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { withCancelOnClose } = require('../lib/core');

function fakeDb({ connect } = {}) {
    const log = [];
    const client = Object.assign(new EventEmitter(), { processID: 4242, release: (discard) => log.push(['release', discard]) });
    return {
        log,
        client,
        connect: connect || (async () => client),
        query: async () => { log.push(['pool query']); return { rows: [] }; },
        cancel: async (pid) => { log.push(['cancel', pid]); },
    };
}
const fakeRes = () => Object.assign(new EventEmitter(), { writableFinished: false, closed: false });
const dropped = (res) => { res.closed = true; res.emit('close'); };
const canceledError = () => Object.assign(new Error('canceling statement due to user request'), { code: '57014' });

test('a request that completes releases its client for reuse and never cancels', async () => {
    const db = fakeDb();
    const res = fakeRes();
    const out = await withCancelOnClose(res, async (c) => { assert.equal(c, db.client); return 'rows'; }, { db, cancel: db.cancel });
    assert.equal(out, 'rows');
    res.writableFinished = true;
    dropped(res);
    assert.deepEqual(db.log, [['release', undefined]]);
    assert.equal(res.listenerCount('close'), 0);
});

test('a dropped request cancels its own backend outside the pool, then discards the connection', async () => {
    const db = fakeDb();
    const res = fakeRes();
    let fail;
    const running = withCancelOnClose(res, () => new Promise((_, reject) => { fail = reject; }), { db, cancel: db.cancel });
    await new Promise(setImmediate); // let it reach the query
    dropped(res);
    res.emit('close'); // a second close sends no second cancel
    fail(canceledError());
    await assert.rejects(running, (err) => err.requestClosed === true && err.code === '57014');
    assert.deepEqual(db.log, [['cancel', 4242], ['release', true]]);
});

test('a request already gone never takes a connection or starts its query', async () => {
    const db = fakeDb();
    const res = fakeRes();
    res.closed = true;
    let ran = false;
    await assert.rejects(withCancelOnClose(res, async () => { ran = true; }, { db, cancel: db.cancel }), (err) => err.requestClosed === true);
    assert.equal(ran, false);
    assert.deepEqual(db.log, []);
});

test('a request dropped while it waits for a connection never starts its query', async () => {
    let hand;
    const db = fakeDb({ connect: () => new Promise((r) => { hand = r; }) });
    const res = fakeRes();
    let ran = false;
    const running = withCancelOnClose(res, async () => { ran = true; }, { db, cancel: db.cancel });
    await new Promise(setImmediate);
    dropped(res); // the pool is still busy: nothing to cancel yet
    hand(db.client);
    await assert.rejects(running, (err) => err.requestClosed === true);
    assert.equal(ran, false);
    assert.deepEqual(db.log, [['release', undefined]]);
});

test('a database failure other than the cancel is not hidden as a dropped request', async () => {
    const db = fakeDb();
    const res = fakeRes();
    let fail;
    const running = withCancelOnClose(res, () => new Promise((_, reject) => { fail = reject; }), { db, cancel: db.cancel });
    await new Promise(setImmediate);
    dropped(res);
    fail(Object.assign(new Error('connection lost'), { code: '08006' }));
    await assert.rejects(running, (err) => err.code === '08006' && err.requestClosed === undefined);
    await assert.rejects(
        withCancelOnClose(fakeRes(), async () => { throw new Error('boom'); }, { db: fakeDb() }),
        (err) => err.message === 'boom' && err.requestClosed === undefined,
    );
});

test('a connection that breaks mid-query does not stop the process and is not reused', async () => {
    const db = fakeDb();
    const res = fakeRes();
    let fail;
    const running = withCancelOnClose(res, () => new Promise((_, reject) => { fail = reject; }), { db, cancel: db.cancel });
    await new Promise(setImmediate);
    const lost = new Error('Connection terminated unexpectedly');
    db.client.emit('error', lost); // would throw (and stop the process) with no listener
    fail(lost);
    await assert.rejects(running, (err) => err === lost && err.requestClosed === undefined);
    assert.deepEqual(db.log, [['release', true]]);
    assert.equal(db.client.listenerCount('error'), 0);
});

test('a cancel that cannot connect is logged, and the connection still goes back only after the query', async () => {
    const db = fakeDb();
    db.cancel = async () => { throw new Error('too many clients already'); };
    const res = fakeRes();
    let finish;
    const running = withCancelOnClose(res, () => new Promise((resolve) => { finish = resolve; }), { db, cancel: db.cancel });
    await new Promise(setImmediate);
    const logged = [];
    const orig = console.error;
    console.error = (m) => logged.push(m);
    try {
        dropped(res);
        await new Promise(setImmediate);
    } finally { console.error = orig; }
    assert.match(logged.join('\n'), /could not cancel.*too many clients already/);
    assert.deepEqual(db.log, []); // still held by the running query
    finish('rows');
    assert.equal(await running, 'rows');
    assert.deepEqual(db.log, [['release', true]]);
});
