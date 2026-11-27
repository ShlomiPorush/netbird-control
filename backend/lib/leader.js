
// One bigint key for the whole deployment ("NBLD"). The other advisory locks of the app use other
// keys (db.js LOG_INDEX_LOCK) or the two-key form (lib/events.js), which never collide with it.
const LEADER_LOCK_KEY = 0x4e424c44;
const RETRY_MS = 5000;
const CHECK_MS = 5000;
const CHECK_TIMEOUT_MS = 3000;

function createLeader({ Client, connection, onLeader, onFatal, lockKey = LEADER_LOCK_KEY, retryMs = RETRY_MS, checkMs = CHECK_MS, checkTimeoutMs = CHECK_TIMEOUT_MS, log = console }) {
    let client = null;      // the connection that tries for, or holds, the lock
    let holding = false;    // this connection holds the lock
    let ready = false;      // holding, and onLeader succeeded
    let stopped = false;
    let fatal = false;
    let retryTimer = null;
    let checkTimer = null;
    let since = null;

    const clearTimers = () => {
        clearTimeout(retryTimer); retryTimer = null;
        clearInterval(checkTimer); checkTimer = null;
    };

    const die = (reason) => {
        if (fatal || stopped) return;
        fatal = true;
        ready = false;
        clearTimers();
        log.error(`[leader] ${reason}`);
        onFatal(reason);
    };

    const dropClient = () => {
        const c = client;
        client = null;
        if (c) c.end().catch(() => { });
    };

    const scheduleRetry = () => {
        if (stopped || fatal) return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(attempt, retryMs);
        if (retryTimer.unref) retryTimer.unref();
    };

    // Any problem on the lock connection: a standby connects again later; the leader exits.
    const onConnectionLost = (c, why) => {
        if (c !== client) return;
        if (holding) return die(`lost the leader lock connection (${why}); exiting so another instance can take over`);
        dropClient();
        scheduleRetry();
    };

    async function attempt() {
        retryTimer = null;
        if (stopped || fatal || holding) return;
        try {
            if (!client) {
                const c = new Client({ ...connection, keepAlive: true, query_timeout: checkTimeoutMs });
                c.on('error', (e) => onConnectionLost(c, e.message));
                c.on('end', () => onConnectionLost(c, 'connection closed'));
                client = c;
                await c.connect();
            }
            const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey])).rows[0].ok === true;
            if (stopped) return;
            if (!got) return scheduleRetry();
            holding = true;
            since = new Date();
            log.log('[leader] this instance holds the leader lock; running the start-up recovery');
            // The connection is checked from now on, also while onLeader runs.
            checkTimer = setInterval(check, checkMs);
            if (checkTimer.unref) checkTimer.unref();
        } catch (e) {
            if (stopped) return;
            log.error('[leader] could not try for the leader lock:', e.message);
            dropClient();
            return scheduleRetry();
        }
        for (;;) {
            try {
                await onLeader();
                break;
            } catch (e) {
                if (stopped || fatal) return;
                log.error(`[leader] the start-up recovery failed (${e.message}); trying again while holding the lock`);
                await new Promise((r) => { const t = setTimeout(r, retryMs); if (t.unref) t.unref(); });
                if (stopped || fatal) return;
            }
        }
        if (stopped || fatal) return;
        ready = true;
        log.log('[leader] ready: background jobs run on this instance');
    }

    async function check() {
        const c = client;
        if (!c || !holding || stopped || fatal) return;
        try {
            await c.query('SELECT 1');
        } catch (e) {
            onConnectionLost(c, e.message);
        }
    }

    return {
        start() { if (!stopped && !retryTimer && !client) attempt(); },
        isReady: () => ready && !stopped && !fatal,
        status: () => ({ role: holding ? 'leader' : 'standby', ready: ready && !stopped && !fatal, since: since ? since.toISOString() : null }),
        // Shutdown: no new jobs from here on, then the lock is released by closing its connection.
        // A lost connection during shutdown is expected and no longer fatal.
        async stop() {
            stopped = true;
            ready = false;
            clearTimers();
            const c = client;
            client = null;
            holding = false;
            if (c) await c.end().catch(() => { });
        },
    };
}

module.exports = { createLeader, LEADER_LOCK_KEY };
