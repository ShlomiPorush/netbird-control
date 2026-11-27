const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');
const { DB_CONNECTION } = require('./core');

const NAMESPACES = {
    user: 0x4e424c01,
    autoApproval: 0x4e424c02,
    rule: 0x4e424c03,
    grant: 0x4e424c04,
    edr: 0x4e424c05,
    mirror: 0x4e424c06,
    automation: 0x4e424c07,
    request: 0x4e424c08,
    tenant: 0x4e424c09,
    targets: 0x4e424c0a,
    settings: 0x4e424c0b,
    remoteSession: 0x4e424c0c,
};

const LOCK_BUSY = Symbol('lock busy');

let lockPool = null;
function poolOf() {
    if (!lockPool) {
        lockPool = new Pool({
            ...DB_CONNECTION, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
            onConnect: (client) => client.query("SET lock_timeout = '60s'"),
        });
        lockPool.on('error', (e) => console.error('[locks] idle lock connection:', e.message));
    }
    return lockPool;
}

function exitOnLostLock(reason) {
    console.error(`[locks] ${reason}; exiting so another instance can take over`);
    process.exit(1);
}

const postgresBackend = {
    async open() {
        const client = await poolOf().connect();
        const session = { client, holds: 0, broken: false };
        session.onError = (e) => {
            session.broken = true;
            if (session.holds > 0) exitOnLostLock(`a lock connection failed while holding a lock (${e.message})`);
        };
        client.on('error', session.onError);
        return session;
    },
    async lock(session, ns, key) {
        await session.client.query('SELECT pg_advisory_lock($1, hashtext($2))', [ns, key]);
    },
    async tryLock(session, ns, key) {
        const r = await session.client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [ns, key]);
        return r.rows[0].ok === true;
    },
    async unlock(session, ns, key) {
        const r = await session.client.query('SELECT pg_advisory_unlock($1, hashtext($2)) AS ok', [ns, key]);
        if (r.rows[0].ok !== true) throw new Error('the lock was not held by this session');
    },
    close(session) {
        session.client.removeListener('error', session.onError);
        session.client.release(session.broken ? new Error('lock connection discarded') : undefined);
    },
};

let backend = postgresBackend;
const owners = new AsyncLocalStorage();

async function acquire(session, ns, key, wait) {
    if (wait) { await backend.lock(session, ns, key); return true; }
    return backend.tryLock(session, ns, key);
}

async function release(session, ns, key) {
    try {
        await backend.unlock(session, ns, key);
    } catch (e) {
        session.broken = true;
        exitOnLostLock(`a lock could not be released (${e.message})`);
        throw e;
    }
}

async function run(kind, parts, fn, wait) {
    const ns = NAMESPACES[kind];
    if (!ns) throw new Error(`unknown lock kind ${kind}`);
    const key = JSON.stringify(parts);
    const owner = owners.getStore();
    if (owner && owner.active) {
        if (!(await acquire(owner.session, ns, key, wait))) return LOCK_BUSY;
        const session = owner.session;
        session.holds++;
        try {
            return await fn();
        } finally {
            session.holds--;
            await release(session, ns, key);
            if (session.closeWhenFree && session.holds === 0) backend.close(session);
        }
    }
    const session = await backend.open();
    const me = { session, active: true };
    try {
        if (!(await acquire(session, ns, key, wait))) return LOCK_BUSY;
        session.holds++;
        try {
            return await owners.run(me, fn);
        } finally {
            me.active = false;
            session.holds--;
            await release(session, ns, key);
        }
    } finally {
        if (session.holds === 0) backend.close(session);
        else session.closeWhenFree = true;
    }
}

function withLock(kind, parts, fn) { return run(kind, parts, fn, true); }
function tryLock(kind, parts, fn) { return run(kind, parts, fn, false); }
function outsideLocks(fn) { return owners.exit(fn); }

function _setLockBackendForTest(next) { backend = next || postgresBackend; }

module.exports = { withLock, tryLock, outsideLocks, LOCK_BUSY, NAMESPACES, _setLockBackendForTest };
