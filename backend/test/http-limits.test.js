// httpJson (lib/http.js) against a loopback server: a normal JSON response still parses, and a
// response that never completes or grows past the size limit stops the request, closes the
// connection and resolves with status 0 and an error.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { httpJson, getNetbirdLastOk } = require('../lib/http');

let current = null;

// Starts `handler` on a loopback port. Counts connections the client has closed.
async function serve(handler) {
    const server = http.createServer(handler);
    const state = { server, closed: 0, timers: [] };
    server.on('connection', (s) => s.on('close', () => { state.closed++; }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.url = `http://127.0.0.1:${server.address().port}/`;
    current = state;
    return state;
}

afterEach(async () => {
    if (!current) return;
    const { server, timers } = current;
    current = null;
    timers.forEach(clearInterval);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
});

// Fails instead of hanging when the request never settles.
function settles(promise, ms = 2000) {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`request did not settle within ${ms} ms`)), ms); });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('a JSON response split across chunks is parsed', async () => {
    const payload = Buffer.from(JSON.stringify({ name: 'שלום', items: [1, 2, 3] }));
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Split inside a multi-byte character.
        res.write(payload.subarray(0, 10));
        setTimeout(() => res.end(payload.subarray(10)), 20);
    });
    const r = await settles(httpJson('GET', current.url));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { name: 'שלום', items: [1, 2, 3] });
});

test('a server that never sends headers is stopped at the deadline', async () => {
    await serve(() => { /* never responds */ });
    const started = Date.now();
    const r = await settles(httpJson('GET', current.url, { deadlineMs: 300 }));
    assert.equal(r.status, 0);
    assert.match(r.error, /not completed within/);
    assert.ok(Date.now() - started < 1500);
    await pause(50);
    assert.equal(current.closed, 1);
});

test('a body that keeps trickling is stopped at the deadline', async () => {
    const state = await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        state.timers.push(setInterval(() => res.write(' '), 50));
    });
    const r = await settles(httpJson('GET', current.url, { deadlineMs: 300 }));
    assert.equal(r.status, 0);
    assert.match(r.error, /not completed within/);
    await pause(50);
    assert.equal(current.closed, 1);
});

test('a body over the default size limit is stopped', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        let sent = 0;
        const pump = () => {
            while (sent < 11 && res.write(chunk)) sent++;
            if (sent < 11) res.once('drain', () => { sent++; pump(); });
            else res.end();
        };
        pump();
    });
    const r = await settles(httpJson('GET', current.url), 5000);
    assert.equal(r.status, 0);
    assert.match(r.error, /larger than/);
    await pause(50);
    assert.equal(current.closed, 1);
});

test('a body that crosses the size limit in its last chunk does not count as a success', async () => {
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(Buffer.alloc(1001, 0x20));
    });
    await pause(10);
    const lastOk = getNetbirdLastOk();
    const r = await settles(httpJson('GET', current.url, { maxBytes: 1000 }));
    assert.equal(r.status, 0);
    assert.match(r.error, /larger than/);
    await pause(50);
    assert.equal(getNetbirdLastOk(), lastOk);
});

test('a connection dropped mid-body resolves with an error', async () => {
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"items": [');
        setTimeout(() => req.socket.destroy(), 20);
    });
    const r = await settles(httpJson('GET', current.url));
    assert.equal(r.status, 0);
    assert.ok(r.error);
});
