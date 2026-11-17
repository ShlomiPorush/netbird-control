// Leader election (lib/leader.js) against a fake pg client: only the instance that holds the
// advisory lock and finished its start-up recovery is ready; a failed recovery or a lost lock
// connection is fatal; a standby keeps trying; a stop releases the lock without being fatal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createLeader, LEADER_LOCK_KEY } = require('../lib/leader');

// One fake PostgreSQL server: the lock belongs to at most one connection.
function fakeDb() {
    const db = { holder: null, clients: [], failConnect: false };
    db.Client = class extends EventEmitter {
        constructor(opts) { super(); this.opts = opts; this.ended = false; this.failQueries = false; db.clients.push(this); }
        async connect() { if (db.failConnect) throw new Error('connection refused'); }
        async query(sql, params) {
            if (this.ended) throw new Error('Client was closed');
            if (this.failQueries) throw new Error('Query read timeout');
            if (/pg_try_advisory_lock/.test(sql)) {
                assert.deepEqual(params, [LEADER_LOCK_KEY]);
                if (db.holder && db.holder !== this) return { rows: [{ ok: false }] };
                db.holder = this;
                return { rows: [{ ok: true }] };
            }
            return { rows: [{ '?column?': 1 }] };
        }
        async end() {
            if (this.ended) return;
            this.ended = true;
            if (db.holder === this) db.holder = null;
            this.emit('end');
        }
        // The server or the network drops the connection: the lock is gone with it.
        drop() { this.ended = true; if (db.holder === this) db.holder = null; this.emit('error', new Error('Connection terminated unexpectedly')); }
    };
    return db;
}

const quiet = { log() { }, error() { } };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await tick(5); } };

function make(db, over = {}) {
    const calls = { leader: 0, fatal: [] };
    const leader = createLeader({
        Client: db.Client, connection: { host: 'db' }, log: quiet, retryMs: 20, checkMs: 20, checkTimeoutMs: 10,
        onLeader: async () => { calls.leader++; if (over.onLeader) await over.onLeader(); },
        onFatal: (reason) => calls.fatal.push(reason),
    });
    return { leader, calls };
}

test('the instance that gets the lock runs the recovery, then is ready', async () => {
    const db = fakeDb();
    let releaseRecovery;
    const { leader, calls } = make(db, { onLeader: () => new Promise((r) => { releaseRecovery = r; }) });
    leader.start();
    await waitFor(() => calls.leader === 1);
    assert.equal(leader.isReady(), false, 'not ready while the recovery runs');
    assert.equal(leader.status().role, 'leader');
    releaseRecovery();
    await waitFor(() => leader.isReady());
    assert.equal(db.clients[0].opts.keepAlive, true);
    assert.equal(db.clients[0].opts.host, 'db', 'the connection settings of the app are used');
    await leader.stop();
});

test('a second instance stays standby while the first holds the lock, and takes over once it is released', async () => {
    const db = fakeDb();
    const a = make(db);
    a.leader.start();
    await waitFor(() => a.leader.isReady());
    const b = make(db);
    b.leader.start();
    await tick(100);
    assert.equal(b.leader.isReady(), false);
    assert.equal(b.leader.status().role, 'standby');
    assert.equal(b.calls.leader, 0, 'no recovery while another instance leads');
    await a.leader.stop();
    await waitFor(() => b.leader.isReady());
    assert.equal(b.calls.leader, 1);
    assert.deepEqual([...a.calls.fatal, ...b.calls.fatal], [], 'a stop is never fatal');
    await b.leader.stop();
});

test('a failed recovery is fatal and the instance never becomes ready', async () => {
    const db = fakeDb();
    const { leader, calls } = make(db, { onLeader: async () => { throw new Error('reload failed'); } });
    leader.start();
    await waitFor(() => calls.fatal.length === 1);
    assert.match(calls.fatal[0], /recovery failed: reload failed/);
    assert.equal(leader.isReady(), false);
    await leader.stop();
});

test('losing the lock connection while leading is fatal', async () => {
    const db = fakeDb();
    const { leader, calls } = make(db);
    leader.start();
    await waitFor(() => leader.isReady());
    db.clients[0].drop();
    assert.equal(calls.fatal.length, 1);
    assert.match(calls.fatal[0], /lost the leader lock connection/);
    assert.equal(leader.isReady(), false);
    await leader.stop();
});

test('a lock connection that stops answering while leading is fatal', async () => {
    const db = fakeDb();
    const { leader, calls } = make(db);
    leader.start();
    await waitFor(() => leader.isReady());
    db.clients[0].failQueries = true;
    await waitFor(() => calls.fatal.length === 1);
    assert.equal(leader.isReady(), false);
    await leader.stop();
});

test('losing the connection during the recovery is fatal, and the recovery result does not make it ready', async () => {
    const db = fakeDb();
    let releaseRecovery;
    const { leader, calls } = make(db, { onLeader: () => new Promise((r) => { releaseRecovery = r; }) });
    leader.start();
    await waitFor(() => calls.leader === 1);
    db.clients[0].drop();
    assert.equal(calls.fatal.length, 1);
    releaseRecovery();
    await tick(50);
    assert.equal(leader.isReady(), false);
    await leader.stop();
});

test('a standby whose connection fails connects again and is never fatal', async () => {
    const db = fakeDb();
    const a = make(db);
    a.leader.start();
    await waitFor(() => a.leader.isReady());
    db.failConnect = true;
    const b = make(db);
    b.leader.start();
    await tick(80);
    db.failConnect = false;
    await waitFor(() => db.clients.length >= 2 && b.leader.status().role === 'standby');
    db.clients[db.clients.length - 1].drop();
    await tick(80);
    assert.deepEqual(b.calls.fatal, []);
    await a.leader.stop();
    await waitFor(() => b.leader.isReady());
    await b.leader.stop();
});

test('after a stop the instance is not ready and does not try for the lock again', async () => {
    const db = fakeDb();
    const { leader, calls } = make(db);
    leader.start();
    await waitFor(() => leader.isReady());
    await leader.stop();
    assert.equal(leader.isReady(), false);
    assert.equal(db.holder, null, 'the lock is released');
    const before = db.clients.length;
    await tick(100);
    assert.equal(db.clients.length, before);
    assert.deepEqual(calls.fatal, []);
});
