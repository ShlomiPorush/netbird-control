const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const contentDisposition = require('content-disposition');
const { ssoServer } = require('./helpers/sso-server');

const h = ssoServer();
const USERS = { remote: { perms: ['remote.connect'] }, plain: {}, blocked: { blocked: true } };
const recorded = [];
const seen = [];
let ra;
let browserFiles;
let handle = (req, res) => { res.statusCode = 500; res.end(); };

const socketPath = () => (process.platform === 'win32'
    ? `\\\\.\\pipe\\nbc-test-files-${crypto.randomBytes(6).toString('hex')}`
    : path.join(os.tmpdir(), `nbc-test-files-${crypto.randomBytes(6).toString('hex')}.sock`));
const filesSocket = socketPath();
const readBody = (req) => new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('close', () => resolve(Buffer.concat(parts)));
});
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const filesServer = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handle(req, res);
});
const until = async (cond, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timed out waiting');
        await new Promise(r => setTimeout(r, 10));
    }
};
const fileEvents = () => recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'file');
const base = '/api/remote-access/sessions/w1';

before(async () => {
    await new Promise(r => filesServer.listen(filesSocket, r));
    await h.start({
        beforeRequire(db) {
            Object.assign(db, {
                ensureUsersFresh: async () => { },
                ensurePeersFresh: async () => { },
                resolveViewer: async (oid) => (USERS[oid] ? { user_id: oid, role: 'user', name: oid, email: `${oid}@example.com`, auto_groups: [], blocked: !!USERS[oid].blocked } : null),
                fetchUserGroups: async () => [],
                getUserPeerGroupIds: async () => [],
                getApproverGroupIds: () => [],
                isActiveDelegate: async () => false,
                resolveFeaturePerms: ({ userId } = {}) => Object.fromEntries(((USERS[userId] && USERS[userId].perms) || []).map((p) => [p, true])),
                recordAudit: async () => { },
            });
            const events = require('../lib/events');
            events.addEvent = async (e) => { recorded.push(JSON.parse(JSON.stringify(e))); return { rowCount: 1 }; };
            ra = require('../lib/remote-access');
            const rb = require('../lib/remote-browser');
            rb.ownedWebSession = async (viewer, id) => {
                if (id === 'w1' && ['remote', 'blocked'].includes(viewer.user_id)) return { id: 'w1', userId: 'remote', user: 'remote@example.com' };
                throw ra.httpError(404, 'SESSION_NOT_FOUND', 'This web session was not found.');
            };
            browserFiles = require('../lib/remote-browser-files');
        },
    });
    browserFiles._internal.setSocketForTest(filesSocket);
});
after(async () => {
    await h.stop();
    filesServer.closeAllConnections?.();
    await new Promise(r => filesServer.close(r));
});
beforeEach(() => {
    ra._internal.setConfigForTest({ enabled: true, allowAll: false, networks: [], browser: { enabled: true, routerGroupId: 'g-office', files: true, transfer: true } });
    browserFiles._internal.setSocketForTest(filesSocket);
    recorded.length = 0;
    seen.length = 0;
    handle = (req, res) => json(res, 500, { error: 'UNEXPECTED', message: 'not expected in this test' });
});

function rawRequest(method, url, { cookie, headers = {}, write }) {
    return new Promise((resolve, reject) => {
        const req = http.request(h.url(url), { method, headers: { accept: 'application/json', cookie, ...headers } });
        req.on('error', () => { });
        req.on('response', (res) => {
            readBody(res).then((body) => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(body.toString() || 'null') }), reject);
        });
        write(req);
    });
}

test('the file list reaches the remote browser for the owner of the session only', async () => {
    const listing = { files: [{ name: 'a.bin', size: 3, mtime: 1, partial: false }], used: 4096, limit: 2 * 1024 ** 3, upload: null };
    handle = (req, res) => json(res, 200, listing);
    let r = await h.call('remote', 'GET', `${base}/files`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, listing);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(seen.map(s => `${s.method} ${s.url}`), ['GET /sessions/w1/files']);
    seen.length = 0;
    r = await h.call('remote', 'GET', '/api/remote-access/sessions/w2/files');
    assert.deepEqual([r.status, r.json.code], [404, 'SESSION_NOT_FOUND']);
    r = await h.call('plain', 'GET', `${base}/files`);
    assert.deepEqual([r.status, r.json.code], [403, 'FORBIDDEN']);
    r = await h.call('remote', 'DELETE', '/api/remote-access/sessions/w2/files/a.bin');
    assert.equal(r.status, 404);
    assert.deepEqual(seen, [], 'nothing reaches the remote browser for another session');
    assert.deepEqual(fileEvents(), []);
});

test('a viewer blocked in NetBird reaches no file route, even when every signed-in user may use Remote Access', async () => {
    ra._internal.setConfigForTest({ enabled: true, allowAll: true, networks: [], browser: { enabled: true, routerGroupId: 'g-office', files: true, transfer: true } });
    handle = (req, res) => json(res, 200, { ok: true, files: [], used: 0, limit: 1, upload: null, id: 'up1', received: 0 });
    const routes = [['GET', `${base}/files`], ['GET', `${base}/files/a.bin`], ['DELETE', `${base}/files/a.bin`],
        ['POST', `${base}/uploads`, { name: 'x.bin', size: 1 }], ['PUT', `${base}/uploads/up1?offset=0`, new Uint8Array(1)], ['DELETE', `${base}/uploads/up1`]];
    for (const [method, url, body] of routes) {
        const r = await h.call('blocked', method, url, body, body instanceof Uint8Array ? { 'content-type': 'application/octet-stream' } : undefined);
        assert.deepEqual([r.status, r.json && r.json.code], [403, 'USER_BLOCKED'], `${method} ${url}`);
    }
    assert.deepEqual(seen, [], 'nothing reaches the remote browser');
    assert.deepEqual(fileEvents(), []);
});

test('the error codes and statuses of the remote browser pass through in the app error shape', async () => {
    const cases = [
        [404, 'NO_SESSION'], [403, 'FILES_OFF'], [403, 'TRANSFER_OFF'], [400, 'BAD_NAME'], [409, 'PARTIAL'], [409, 'BUSY'],
        [507, 'FILES_LIMIT'], [409, 'NAME_TAKEN'], [404, 'NOT_FOUND'], [400, 'BAD_SIZE'],
    ];
    for (const [status, code] of cases) {
        handle = (req, res) => json(res, status, { error: code, message: `text for ${code}` });
        const r = await h.call('remote', 'DELETE', `${base}/files/a.bin`);
        assert.deepEqual([r.status, r.json], [status, { error: `text for ${code}`, code }], code);
    }
    handle = (req, res) => json(res, 409, { error: 'OFFSET', message: 'The upload continues at another offset.', received: 1024 });
    const r = await h.call('remote', 'PUT', `${base}/uploads/up1?offset=0`, new Uint8Array(8), { 'content-type': 'application/octet-stream' });
    assert.deepEqual([r.status, r.json], [409, { error: 'The upload continues at another offset.', code: 'OFFSET', received: 1024 }]);
    assert.deepEqual(fileEvents(), []);
});

test('a download is an attachment of raw bytes that is never cached, also for hostile file names', async () => {
    const names = ['report "final".pdf', 'line\r\nSet-Cookie: x=1.bin', 'קושחה-7.4.bin', 'semi;colon,comma=.txt', '%2e%2e', 'emoji-\u{1F600}.zip',
        ...(process.platform === 'win32' ? [] : ['back\\slash.txt'])];
    for (const name of names) {
        const bytes = crypto.randomBytes(5000);
        let asked = '';
        handle = (req, res) => {
            asked = decodeURIComponent(req.url.split('/').pop());
            res.writeHead(200, { 'content-length': bytes.length, 'content-type': 'text/html' });
            res.end(bytes);
        };
        const res = await fetch(h.url(`${base}/files/${encodeURIComponent(name)}`), { headers: { cookie: await h.signIn('remote') } });
        const body = Buffer.from(await res.arrayBuffer());
        assert.equal(res.status, 200, name);
        assert.equal(asked, name, 'the remote browser is asked for the exact name');
        assert.ok(body.equals(bytes), name);
        assert.equal(res.headers.get('content-type'), 'application/octet-stream');
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.ok(!(res.headers.get('set-cookie') || '').includes('x=1'), name);
        const disposition = res.headers.get('content-disposition');
        assert.ok(!/[\r\n]/.test(disposition), name);
        assert.equal(contentDisposition.parse(disposition).type, 'attachment');
        assert.equal(contentDisposition.parse(disposition).parameters.filename, name);
        await until(() => fileEvents().length === 1);
        const [event] = fileEvents();
        assert.deepEqual(event.remoteAccess, { protocol: 'web', kind: 'file', action: 'downloaded', sessionId: 'w1', user: 'remote@example.com', name, size: 5000 });
        recorded.length = 0;
    }
});

test('a download stops reading from the remote browser when the client goes away, and records what was sent', async () => {
    let upstreamClosed = false;
    handle = (req, res) => {
        res.writeHead(200, { 'content-length': 50 * 1024 * 1024 });
        res.write(Buffer.alloc(64 * 1024));
        res.on('close', () => { upstreamClosed = true; });
    };
    const ctrl = new AbortController();
    const res = await fetch(h.url(`${base}/files/big.iso`), { headers: { cookie: await h.signIn('remote') }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read();
    ctrl.abort();
    await until(() => upstreamClosed);
    await until(() => fileEvents().length === 1);
    const [event] = fileEvents();
    assert.equal(event.remoteAccess.complete, false);
    assert.ok(event.remoteAccess.size > 0 && event.remoteAccess.size < 50 * 1024 * 1024);
});

test('a failed download is not recorded, and a remote browser that does not answer is a 503', async () => {
    handle = (req, res) => json(res, 409, { error: 'PARTIAL', message: 'This file is still downloading.' });
    let r = await h.call('remote', 'GET', `${base}/files/x.crdownload`);
    assert.deepEqual([r.status, r.json.code], [409, 'PARTIAL']);
    browserFiles._internal.setSocketForTest(socketPath());
    r = await h.call('remote', 'GET', `${base}/files`);
    assert.deepEqual([r.status, r.json.code], [503, 'BROWSER_UNAVAILABLE']);
    r = await h.call('remote', 'GET', `${base}/files/a.bin`);
    assert.deepEqual([r.status, r.json.code], [503, 'BROWSER_UNAVAILABLE']);
    assert.deepEqual(fileEvents(), []);
});

test('a delete passes through and is recorded with the size the remote browser reported', async () => {
    handle = (req, res) => json(res, 200, { ok: true, size: 1234 });
    const r = await h.call('remote', 'DELETE', `${base}/files/${encodeURIComponent('old firmware.out')}`);
    assert.deepEqual([r.status, r.json], [200, { ok: true, size: 1234 }]);
    assert.deepEqual(seen.map(s => `${s.method} ${s.url}`), ['DELETE /sessions/w1/files/old%20firmware.out']);
    await until(() => fileEvents().length === 1);
    assert.deepEqual(fileEvents()[0].remoteAccess, { protocol: 'web', kind: 'file', action: 'deleted', sessionId: 'w1', user: 'remote@example.com', name: 'old firmware.out', size: 1234 });
});

test('an upload chunk reaches the remote browser as raw bytes, even sent as JSON, and the published file is recorded with the same event id on a retry', async () => {
    const chunk = Buffer.from('{"not":"parsed"}');
    const bodies = [];
    handle = async (req, res) => {
        const body = await readBody(req);
        bodies.push({ url: req.url, type: req.headers['content-type'], body });
        if (req.method === 'POST') return json(res, 200, { id: 'up1', received: 0 });
        if (req.method === 'PUT') return json(res, 200, { received: chunk.length, done: true, name: 'fw.bin', size: chunk.length });
        return json(res, 200, { ok: true });
    };
    let r = await h.call('remote', 'POST', `${base}/uploads`, { name: 'fw.bin', size: chunk.length, extra: 'dropped' });
    assert.deepEqual([r.status, r.json], [200, { id: 'up1', received: 0 }]);
    assert.deepEqual(JSON.parse(bodies[0].body), { name: 'fw.bin', size: chunk.length });
    for (let i = 0; i < 2; i++) {
        r = await h.call('remote', 'PUT', `${base}/uploads/up1?offset=0`, new Uint8Array(chunk), { 'content-type': 'application/json' });
        assert.deepEqual([r.status, r.json], [200, { received: chunk.length, done: true, name: 'fw.bin', size: chunk.length }]);
    }
    const puts = bodies.filter(b => b.url.startsWith('/sessions/w1/uploads/up1'));
    assert.deepEqual(puts.map(p => [p.url, p.type]), Array(2).fill(['/sessions/w1/uploads/up1?offset=0', 'application/octet-stream']));
    assert.ok(puts.every(p => p.body.equals(chunk)), 'the bytes arrive untouched');
    await until(() => fileEvents().length === 2);
    assert.deepEqual(fileEvents().map(e => e.ID), Array(2).fill('web-file:w1:upload:up1'), 'a retried last chunk has the same event id');
    assert.deepEqual(fileEvents()[0].remoteAccess, { protocol: 'web', kind: 'file', action: 'uploaded', sessionId: 'w1', user: 'remote@example.com', name: 'fw.bin', size: chunk.length });
    r = await h.call('remote', 'DELETE', `${base}/uploads/up1`);
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
});

test('the uploaded file is recorded with the name and size of the answer of the remote browser, never from a copy on this server', async () => {
    handle = async (req, res) => {
        await readBody(req);
        if (req.method === 'POST') return json(res, 200, { id: 'up2', received: 0 });
        return json(res, 200, { received: 3, done: true, name: 'kept.bin', size: 3 });
    };
    await h.call('remote', 'POST', `${base}/uploads`, { name: 'started.bin', size: 99 });
    const r = await h.call('remote', 'PUT', `${base}/uploads/up2?offset=0`, new Uint8Array(3), { 'content-type': 'application/octet-stream' });
    assert.equal(r.status, 200);
    await until(() => fileEvents().length === 1);
    assert.deepEqual([fileEvents()[0].remoteAccess.name, fileEvents()[0].remoteAccess.size], ['kept.bin', 3]);
    assert.deepEqual(seen.map(s => s.method), ['POST', 'PUT'], 'no extra request to learn the name');
});

test('a chunk over 8 MiB is refused, with or without a declared length; 8 MiB itself passes', async () => {
    const cookie = await h.signIn('remote');
    const received = [];
    handle = async (req, res) => {
        if (req.method === 'GET') return json(res, 200, { files: [], used: 0, limit: 1, upload: null });
        const body = await readBody(req);
        received.push(body.length);
        if (!req.complete) return;
        return json(res, 200, { received: body.length, done: false });
    };
    const MiB = 1024 * 1024;
    let r = await rawRequest('PUT', `${base}/uploads/up3?offset=0`, {
        cookie, headers: { 'content-type': 'application/octet-stream', 'content-length': 8 * MiB + 1 },
        write: (req) => req.end(Buffer.alloc(8 * MiB + 1)),
    });
    assert.deepEqual([r.status, r.json.code], [413, 'TOO_LARGE']);
    assert.ok(!seen.some(s => s.method === 'PUT'), 'a declared length over the limit never reaches the remote browser');
    r = await rawRequest('PUT', `${base}/uploads/up3?offset=0`, {
        cookie, headers: { 'content-type': 'application/octet-stream' },
        write: (req) => { for (let i = 0; i < 9; i++) req.write(Buffer.alloc(MiB)); req.end(); },
    });
    assert.deepEqual([r.status, r.json.code], [413, 'TOO_LARGE']);
    await until(() => received.length === 1);
    assert.ok(received[0] <= 8 * MiB, 'the remote browser never gets more than 8 MiB');
    r = await rawRequest('PUT', `${base}/uploads/up3?offset=0`, {
        cookie, headers: { 'content-type': 'application/octet-stream' },
        write: (req) => { for (let i = 0; i < 8; i++) req.write(Buffer.alloc(MiB)); req.end(); },
    });
    assert.deepEqual([r.status, r.json], [200, { received: 8 * MiB, done: false }]);
});
