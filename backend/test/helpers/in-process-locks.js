const locks = require('../../lib/locks');

const held = new Map();

function slot(ns, key) {
    const id = `${ns}:${key}`;
    if (!held.has(id)) held.set(id, { session: null, count: 0, waiters: [] });
    return held.get(id);
}

const inProcessBackend = {
    async open() { return { holds: 0 }; },
    async lock(session, ns, key) {
        const s = slot(ns, key);
        while (s.session && s.session !== session) await new Promise((resolve) => s.waiters.push(resolve));
        s.session = session;
        s.count++;
    },
    async tryLock(session, ns, key) {
        const s = slot(ns, key);
        if (s.session && s.session !== session) return false;
        s.session = session;
        s.count++;
        return true;
    },
    async unlock(session, ns, key) {
        const s = slot(ns, key);
        if (s.session !== session) throw new Error('the lock was not held by this session');
        if (--s.count === 0) {
            s.session = null;
            const next = s.waiters.shift();
            if (next) next();
        }
    },
    close() { },
};

locks._setLockBackendForTest(inProcessBackend);
require('../../lib/settings-version')._setSettingsVersionReaderForTest(async () => null);
