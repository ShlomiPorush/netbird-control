// The usage datasets cache (lib/netbird.js getUsageData): one cache per account, invalidated per
// account after a write; a read that started before an invalidation never stores its old result
// and is never joined afterwards. The strict read reads only the resources and the routes, never
// joins a running read, never touches the cache, and fails unless both answers were a 2xx list.
// The NetBird URL and token are saved in one transaction, one save at a time, and published only
// after the commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

// The settings saves go through a stub database client: every statement is recorded with the
// connection the app used while it ran.
const core = require('../lib/core');
const statements = [];
let failInsert = null; // a key whose insert fails
core.pool.connect = async () => ({
    query: async (sql, params) => {
        statements.push({ sql: String(sql).trim().split(/\s+/)[0], key: params && params[0], url: nb._nbApi.url, token: nb._nbApi.token });
        await new Promise((r) => setTimeout(r, 5));
        if (failInsert && params && params[0] === failInsert) throw new Error('database unavailable');
        return { rows: [] };
    },
    release: () => { },
});
const nb = require('../lib/netbird');

// A fake NetBird: answers by path, counts the reads of the resources list, and can hold them.
const st = { reads: { main: 0, t1: 0 }, version: { main: 1, t1: 1 }, holds: [], fail503: null, failRoutes: false };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const account = url.searchParams.get('account') || 'main';
    const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (st.fail503 === url.pathname) return send(503, []);
    if (url.pathname === '/api/routes' && st.failRoutes) return send(500, { message: 'unavailable' });
    if (url.pathname !== '/api/networks/resources') return send(200, []);
    st.reads[account]++;
    const answer = [{ id: `${account}-v${st.version[account]}`, address: '10.0.0.1/32' }];
    const hold = st.holds.shift();
    if (hold) hold.then(() => send(200, answer)); else send(200, answer);
});
const release = [];
const holdNext = () => { let r; st.holds.push(new Promise((ok) => { r = ok; })); release.push(r); };
const idOf = (u) => u.resources[0] && u.resources[0].id;
const waitHeld = async () => { while (st.holds.length) await new Promise((r) => setTimeout(r, 5)); };

test.before(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    nb._nbApi.url = `http://127.0.0.1:${server.address().port}`;
    nb._nbApi.token = crypto.randomBytes(16).toString('hex');
});
test.after(async () => {
    nb._nbApi.url = ''; nb._nbApi.token = '';
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
});

test('each account has its own cache, and an invalidation drops only the account that was written', async () => {
    nb.invalidateUsage();
    await nb.runWithTenant('t1', () => nb.invalidateUsage());
    assert.equal(idOf(await nb.getUsageData()), 'main-v1');
    assert.equal(idOf(await nb.runWithTenant('t1', () => nb.getUsageData())), 't1-v1');
    const before = { ...st.reads };
    await nb.getUsageData();
    await nb.runWithTenant('t1', () => nb.getUsageData());
    assert.deepEqual(st.reads, before, 'both are cached');
    st.version.t1 = 2;
    await nb.runWithTenant('t1', () => nb.bustNbCaches('usage'));
    assert.equal(idOf(await nb.runWithTenant('t1', () => nb.getUsageData())), 't1-v2');
    assert.equal(idOf(await nb.getUsageData()), 'main-v1', 'the main account is still cached');
    assert.equal(st.reads.main, before.main);
    assert.equal(st.reads.t1, before.t1 + 1);
});

test('a read that started before an invalidation is not joined and never stores its result', async () => {
    nb.invalidateUsage();
    holdNext();
    const old = nb.getUsageData(); // reads v1 and is held
    await waitHeld();
    st.version.main = 2;
    nb.invalidateUsage(); // the write happened while the old read was running
    const fresh = await nb.getUsageData();
    assert.equal(idOf(fresh), 'main-v2', 'a new read, not the one in flight');
    release.shift()();
    assert.equal(idOf(await old), 'main-v1');
    assert.equal(idOf(await nb.getUsageData()), 'main-v2', 'the old read did not replace the cache');
});

test('the strict read: only resources and routes, its own request, and nothing stored in the cache', async () => {
    nb.invalidateUsage();
    holdNext();
    const normal = nb.getUsageData(); // reads v2 and is held
    await waitHeld();
    const reads = st.reads.main;
    st.version.main = 3;
    const strict = await nb.getUsageData({ strict: true });
    assert.equal(st.reads.main, reads + 1, 'the strict read made its own request');
    assert.deepEqual(Object.keys(strict).sort(), ['resources', 'routes']);
    assert.equal(idOf(strict), 'main-v3');
    release.shift()();
    assert.equal(idOf(await normal), 'main-v2');
    assert.equal(idOf(await nb.getUsageData()), 'main-v2', 'the strict answer did not go into the cache');
});

test('the strict read fails on a failed status, also when its body is an empty list', async () => {
    for (const path of ['/api/networks/resources', '/api/routes']) {
        st.fail503 = path;
        try {
            await assert.rejects(nb.getUsageData({ strict: true }), /resources and routes/, path);
        } finally { st.fail503 = null; }
    }
    st.failRoutes = true;
    try {
        await assert.rejects(nb.getUsageData({ strict: true }), /resources and routes/);
    } finally { st.failRoutes = false; }
});

test('a settings save writes the URL and token in one transaction and publishes them after the commit', async () => {
    const old = { url: nb._nbApi.url, token: nb._nbApi.token };
    const next = { url: 'http://127.0.0.1:9/', token: crypto.randomBytes(16).toString('hex') };
    statements.length = 0;
    try {
        await nb.setNbApiConfig(next);
        assert.deepEqual(statements.map(s => s.sql), ['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
        assert.deepEqual(statements.filter(s => s.key).map(s => s.key), ['netbird_api_url', 'netbird_api_token']);
        assert.ok(statements.every(s => s.url === old.url && s.token === old.token), 'nothing new is used before the commit');
        assert.equal(nb._nbApi.url, next.url);
        assert.equal(nb._nbApi.token, next.token);
    } finally { nb._nbApi.url = old.url; nb._nbApi.token = old.token; }
});

test('a failed save rolls back and publishes nothing', async () => {
    const old = { url: nb._nbApi.url, token: nb._nbApi.token };
    statements.length = 0;
    failInsert = 'netbird_api_token';
    try {
        await assert.rejects(nb.setNbApiConfig({ url: 'http://127.0.0.1:9/', token: crypto.randomBytes(16).toString('hex') }), /database unavailable/);
        assert.equal(statements[statements.length - 1].sql, 'ROLLBACK');
        assert.deepEqual({ url: nb._nbApi.url, token: nb._nbApi.token }, old);
    } finally { failInsert = null; nb._nbApi.url = old.url; nb._nbApi.token = old.token; }
});

test('saves run one at a time, in order', async () => {
    const old = { url: nb._nbApi.url, token: nb._nbApi.token };
    statements.length = 0;
    try {
        const a = nb.setNbApiConfig({ url: 'http://127.0.0.1:7/', token: crypto.randomBytes(16).toString('hex') });
        const b = nb.setNbApiConfig({ url: 'http://127.0.0.1:8/', token: crypto.randomBytes(16).toString('hex') });
        await Promise.all([a, b]);
        assert.deepEqual(statements.map(s => s.sql), ['BEGIN', 'INSERT', 'INSERT', 'COMMIT', 'BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
        assert.equal(nb._nbApi.url, 'http://127.0.0.1:8/', 'the later save wins');
    } finally { nb._nbApi.url = old.url; nb._nbApi.token = old.token; }
});

test('every publish raises the version, also back to earlier values (A, B, A)', async () => {
    const old = { url: nb._nbApi.url, token: nb._nbApi.token };
    try {
        const tokenA = crypto.randomBytes(16).toString('hex');
        await nb.setNbApiConfig({ url: 'http://127.0.0.1:7/', token: tokenA });
        const a1 = nb.getNbApiSnapshot();
        assert.equal(nb.getNbApiSnapshot(), a1, 'unchanged values: the same pair');
        await nb.setNbApiConfig({ url: 'http://127.0.0.1:8/', token: crypto.randomBytes(16).toString('hex') });
        await nb.setNbApiConfig({ url: 'http://127.0.0.1:7/', token: tokenA });
        const a2 = nb.getNbApiSnapshot();
        assert.equal(a2.url, a1.url);
        assert.equal(a2.token, a1.token);
        assert.ok(a2.version > a1.version + 1);
        assert.equal(Object.isFrozen(a2), true);
    } finally { nb._nbApi.url = old.url; nb._nbApi.token = old.token; }
});
