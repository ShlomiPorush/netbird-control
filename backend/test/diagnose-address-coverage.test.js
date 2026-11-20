// Troubleshoot's address check offers "Add As Resource" through `coverage.addable`
// (db.diagnoseAddress): true only when the resources and the routes were both read fresh, the
// address is valid as typed (not cut to the length limit, a port from 1 to 65535), and nothing in
// NetBird covers it - a default route (exit node) or a disabled route doesn't count.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const core = require('../lib/core');
// The device being diagnosed, from the peers mirror; every other query finds nothing.
core.pool.query = async (sql) => (/FROM peers p/.test(sql)
    ? { rows: [{ peer_id: 'p1', name: 'laptop', ip: '100.64.0.2', raw_json: { connected: true, groups: [] } }] }
    : { rows: [] });
core.getSetting = async () => null;

const nb = require('../lib/netbird');
const st = { routes: [], resources: [], failRoutes: false };
const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (path === '/api/routes') return st.failRoutes ? send(500, { message: 'unavailable' }) : send(200, st.routes);
    if (path === '/api/networks/resources') return send(200, st.resources);
    send(200, []);
});
const db = require('../db');

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

const check = (address, opts) => db.diagnoseAddress('p1', address, opts);
const reset = (over = {}) => { st.routes = []; st.resources = []; st.failRoutes = false; Object.assign(st, over); };

test('an uncovered IP address is addable, with or without a port', async () => {
    reset();
    let r = await check('192.0.2.44');
    assert.equal(r.findings.find(f => f.key === 'coverage').status, 'FAIL');
    assert.deepEqual(r.coverage, { addable: true });
    r = await check('192.0.2.44:3389');
    assert.deepEqual(r.coverage, { addable: true });
});

test('an enabled legacy route covers it; an exit node or a disabled route does not', async () => {
    reset({ routes: [{ id: 'l1', network: '192.0.2.0/24', network_id: 'lan', enabled: true, groups: [] }] });
    assert.deepEqual((await check('192.0.2.44')).coverage, { addable: false });
    reset({ routes: [{ id: 'l1', network: '192.0.2.0/24', network_id: 'lan', enabled: false, groups: [] }] });
    assert.deepEqual((await check('192.0.2.44')).coverage, { addable: true });
    reset({ routes: [{ id: 'exit', network: '0.0.0.0/0', network_id: 'exit', enabled: true, groups: [] }] });
    const r = await check('192.0.2.44');
    assert.equal(r.findings.find(f => f.key === 'coverage').status, 'INFO', 'the exit node note is still shown');
    assert.deepEqual(r.coverage, { addable: true });
});

test('a failed resources or routes read never offers, and the diagnosis still answers', async () => {
    reset({ failRoutes: true });
    const r = await check('192.0.2.44');
    assert.ok(r.findings.length > 0);
    assert.deepEqual(r.coverage, { addable: false });
});

test('an address that is not valid as typed is never offered', async () => {
    reset();
    for (const bad of ['192.0.2.44:99999', '192.0.2.44:0', '192.0.2.0/24', '*.example.com', '127.0.0.1', '100.64.0.9']) {
        assert.deepEqual((await check(bad)).coverage, { addable: false }, bad);
    }
    assert.deepEqual((await check('192.0.2.44', { clipped: true })).coverage, { addable: false }, 'cut to the length limit');
});

test('a host name the DNS does not find is not offered', async () => {
    reset();
    const r = await check('no-such-host.invalid');
    assert.deepEqual(r.coverage, { addable: false });
});
