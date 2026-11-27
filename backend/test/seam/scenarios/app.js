module.exports = async function appScenario(ctx) {
    const db = require('../../../db');
    const core = require('../../../lib/core');
    return {
        async db({ fn, args = [] }) { return db[fn](...args); },
        async sql({ text, params = [] }) { return (await core.pool.query(text, params)).rows; },
        async init() { await db.initializeDatabase(); return true; },
        async migrate({ ops }) {
            const { runSchema, MIGRATIONS } = require('../../../lib/migrations');
            return runSchema({ baseline: db.createBaselineSchema, migrations: [...MIGRATIONS, { id: 9999, overlapSafe: true, ops }] });
        },
        async setLeader({ leader }) { db.setLeaderCheck(() => leader); return true; },
        async refreshUsers() { db.resetNbCaches(); await db.ensureUsersFresh(); return true; },
        async refreshPeers() { db.resetNbCaches(); await db.ensurePeersFresh(); return true; },
        async holdLock({ kind, parts, name }) {
            const { withLock } = require('../../../lib/locks');
            withLock(kind, parts, () => ctx.hold(name)).catch(() => { });
            await new Promise((r) => setTimeout(r, 200));
            return true;
        },
        async exit() { setTimeout(() => process.exit(0), 10); return true; },
    };
};
