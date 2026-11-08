// Core infrastructure layer, extracted verbatim from db.js: the pg connection pool and the
// low-level app_settings accessors (getSetting/setSetting) that nearly every other module needs.
// This is the base of the lib/ dependency graph - it requires only pg, never db.js and never any
// other lib/ module (keep the dependency direction one-way: everything -> lib/core.js).

const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'netbird_logs',
    user: process.env.DB_USER || 'netbird',
    // No default: server.js refuses to start without DB_PASSWORD (lib/db-config.js).
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
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
// the one the user is waiting for. pg_cancel_backend is awaited, and a cancelled connection is
// discarded rather than returned to the pool, so the cancel can never reach a query of another
// request. An error thrown after a cancel carries `requestClosed = true`, so the route can skip
// answering a client that is gone. `db` is injectable for tests.
async function withCancelOnClose(res, fn, db = pool) {
    const client = await db.connect();
    let finished = false, cancelling = null;
    const onClose = () => {
        if (finished || res.writableFinished || cancelling) return;
        cancelling = db.query('SELECT pg_cancel_backend($1)', [client.processID]).catch(() => { });
    };
    res.on('close', onClose);
    try {
        return await fn(client);
    } catch (err) {
        if (cancelling && err && typeof err === 'object') err.requestClosed = true;
        throw err;
    } finally {
        finished = true;
        res.off('close', onClose);
        if (cancelling) await cancelling;
        client.release(cancelling ? true : undefined);
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
