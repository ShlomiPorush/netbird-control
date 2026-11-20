// The usage datasets cache (lib/netbird.js getUsageData): one cache per account, invalidated per
// account after a write; a read that started before an invalidation never stores its old result
// and is never joined afterwards; an older read that finishes last never replaces a newer one; the
// strict read never joins a running read and fails when the resources or the routes can't be read.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const nb = require('../lib/netbird');

// A fake NetBird: answers by path, counts the reads of the resources list, and can hold them.
const st = { reads: { main: 0, t1: 0 }, version: { main: 1, t1: 1 }, holds: [], failRoutes: false };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const account = url.searchParams.get('account') || 'main';
    const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/routes' && st.failRoutes) return send(500, { message: 'unavailable' });
    if (url.pathname !== '/api/networks/resources') return send(200, []);
    st.reads[account]++;
    const answer = [{ id: `${account}-v${st.version[account]}`, address: '10.0.0.1/32' }];
    const hold = st.holds.shift();
    if (hold) hold.then(() => send(200, answer)); else send(200, answer);
});
let release = [];
const holdNext = () => { let r; st.holds.push(new Promise((ok) => { r = ok; })); release.push(r); };
const idOf = (u) => u.resources[0] && u.resources[0].id;

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
    while (st.holds.length) await new Promise((r) => setTimeout(r, 5));
    st.version.main = 2;
    nb.invalidateUsage(); // the write happened while the old read was running
    const fresh = await nb.getUsageData();
    assert.equal(idOf(fresh), 'main-v2', 'a new read, not the one in flight');
    release.shift()();
    assert.equal(idOf(await old), 'main-v1');
    assert.equal(idOf(await nb.getUsageData()), 'main-v2', 'the old read did not replace the cache');
});

test('an older read that finishes after a newer one never replaces it', async () => {
    nb.invalidateUsage();
    st.version.main = 3;
    holdNext();
    const older = nb.getUsageData({ strict: true });
    while (st.holds.length) await new Promise((r) => setTimeout(r, 5));
    st.version.main = 4;
    const newer = await nb.getUsageData({ strict: true });
    assert.equal(idOf(newer), 'main-v4');
    release.shift()();
    assert.equal(idOf(await older), 'main-v3');
    assert.equal(idOf(await nb.getUsageData()), 'main-v4');
});

test('the strict read never joins a read in flight, and fails when the routes cannot be read', async () => {
    nb.invalidateUsage();
    holdNext();
    const normal = nb.getUsageData();
    while (st.holds.length) await new Promise((r) => setTimeout(r, 5));
    const reads = st.reads.main;
    const strict = await nb.getUsageData({ strict: true });
    assert.equal(st.reads.main, reads + 1, 'the strict read made its own request');
    assert.equal(idOf(strict), 'main-v4');
    release.shift()();
    await normal;
    st.failRoutes = true;
    try {
        await assert.rejects(nb.getUsageData({ strict: true }), /resources and routes/);
        nb.invalidateUsage();
        const lenient = await nb.getUsageData();
        assert.deepEqual(lenient.routes, [], 'a normal read still turns the failed list into []');
    } finally { st.failRoutes = false; }
});

test('the URL and token are handed out as one pair whose version changes with either value', () => {
    const a = nb.getNbApiSnapshot();
    assert.equal(nb.getNbApiSnapshot(), a, 'unchanged values: the same pair');
    const token = nb._nbApi.token;
    nb._nbApi.token = crypto.randomBytes(16).toString('hex');
    const b = nb.getNbApiSnapshot();
    assert.notEqual(b.version, a.version);
    assert.equal(b.url, a.url);
    assert.equal(Object.isFrozen(b), true);
    nb._nbApi.token = token;
});
