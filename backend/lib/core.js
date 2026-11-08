// Core infrastructure layer, extracted verbatim from db.js: the pg connection pool and the
// low-level app_settings accessors (getSetting/setSetting) that nearly every other module needs.
// This is the base of the lib/ dependency graph - it requires only pg, never db.js and never any
// other lib/ module (keep the dependency direction one-way: everything -> lib/core.js).

const { Pool, Client } = require('pg');

const DB_CONNECTION = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'netbird_logs',
    user: process.env.DB_USER || 'netbird',
    // No default: server.js refuses to start without DB_PASSWORD (lib/db-config.js).
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
};

const pool = new Pool({
    ...DB_CONNECTION,
    max: 20,
    idleTimeoutMillis: 30000,
});

// ─── Capped row counts for paginated log lists ───
// A paginated log list does NOT need an exact total: an exact COUNT(*) over a filtered slice of a
// multi-GB table is a full scan of that slice on EVERY page load, and it grows without bound.
// cappedCount() counts through a LIMIT'ed subquery instead - the executor stops at CAP+1 rows, so
// the cost is bounded no matter how large the table gets. Past the cap the caller reports
// `total: COUNT_CAP, totalCapped: true` and the UI renders "50,000+"; users narrow their filters.
const COUNT_CAP = 50000;

// `fromSql` is an internal SQL fragment of the shape `SELECT 1 FROM <table> <where> [GROUP BY ...]`
// built by the caller from fixed fragments with $n placeholders - every user value rides in `params`.
// `db` is the pool by default; a request that can be cancelled passes its own client instead.
async function cappedCount(fromSql, params, db = pool) {
    const r = await db.query(
        // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- fromSql is an internal fragment assembled from fixed strings by the caller; COUNT_CAP is a constant integer; all user values travel in `params`.
        `SELECT COUNT(*)::int AS n FROM (${fromSql} LIMIT ${COUNT_CAP + 1}) _c`,
        params
    );
    return capTotal(r.rows[0] ? r.rows[0].n : 0);
}
// The same cap for a count the caller already has, for example a grouped query that counts its
// groups with a window function in the same pass, so every log list reports totals one way.
function capTotal(n) {
    return n > COUNT_CAP ? { total: COUNT_CAP, totalCapped: true } : { total: n, totalCapped: false };
}

// ─── Cancel a read when the browser drops the request ───
// Runs fn(client) on a dedicated pool client and cancels its running query when the HTTP response
// closes before it was sent, for example when a newer search replaced the request in the browser.
// Without this, every abandoned search kept scanning the events table to the end, competing with
// the one the user is waiting for.
// - A request already gone, before or while it waits for a pool connection, never starts its query.
// - The cancel runs on a short-lived connection of its own, never from the pool: the pool can be
//   full of the very reads that need cancelling.
// - The cancel is awaited and the cancelled connection is discarded rather than returned to the
//   pool, so it can never reach a query of another request.
// - Only a dropped request is marked `requestClosed = true` (so the route skips answering a client
//   that is gone); any other database error keeps reaching the log.
// - If the cancel itself fails (the server refuses another connection), it is logged and the query
//   runs to its end, as every query did before this existed.
// - Both clients listen for 'error', as node-postgres requires of a client used outside
//   pool.query: a connection that breaks mid-query also emits 'error', and an unhandled one would
//   stop the process. A broken pooled connection is discarded, not returned to the pool.
// `opts.db` (the pool) and `opts.cancel` (the cancel call) are injectable for tests.
const closedEarly = (res) => res.closed && !res.writableFinished;
const requestClosedError = () => Object.assign(new Error('The client closed the request'), { requestClosed: true });
async function cancelBackend(pid) {
    const c = new Client(DB_CONNECTION);
    c.on('error', () => { }); // the same failure rejects connect/query below, which the caller logs
    try {
        await c.connect();
        await c.query('SELECT pg_cancel_backend($1)', [pid]);
    } finally {
        await c.end().catch(() => { });
    }
}
async function withCancelOnClose(res, fn, { db = pool, cancel = cancelBackend } = {}) {
    if (closedEarly(res)) throw requestClosedError();
    let client = null, finished = false, cancelling = null, broken = false;
    const onClose = () => {
        if (finished || !client || res.writableFinished || cancelling) return;
        cancelling = cancel(client.processID).catch((e) => {
            console.error(`[Logs] could not cancel the query of a closed request, it runs to its end: ${e.message}`);
        });
    };
    const onClientError = (e) => {
        broken = true;
        console.error(`[Logs] database connection error during a log read: ${e.message}`);
    };
    res.on('close', onClose);
    try {
        client = await db.connect();
        client.on('error', onClientError);
        if (closedEarly(res)) throw requestClosedError(); // closed while waiting for a connection
        return await fn(client);
    } catch (err) {
        // 57014 = query_canceled: the cancel above stopped this request's query.
        if (cancelling && err && err.code === '57014') err.requestClosed = true;
        throw err;
    } finally {
        finished = true;
        res.off('close', onClose);
        if (cancelling) await cancelling;
        if (client) {
            client.off('error', onClientError);
            client.release(cancelling || broken ? true : undefined);
        }
    }
}

async function getSetting(key) {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].value : null;
}

// setSetting invalidates the events filter cache after any settings write (the filter config is
// partly settings-backed - the builtin_noise flag). That cache lives in lib/events.js; to keep the
// dependency one-way (events -> core, never the reverse) the owner registers its invalidator here
// via onSettingChange() instead of core requiring it. Default is a no-op until registered.
let _onSettingChange = () => { };
function onSettingChange(fn) { if (typeof fn === 'function') _onSettingChange = fn; }

async function setSetting(key, value) {
    await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
    );
    _onSettingChange();
}

module.exports = { pool, getSetting, setSetting, onSettingChange, cappedCount, capTotal, withCancelOnClose, COUNT_CAP };
