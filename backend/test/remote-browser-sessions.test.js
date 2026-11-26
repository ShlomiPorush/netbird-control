const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] ?? null;
core.setSetting = async (k, v) => { settings[k] = String(v); };
const table = require('./helpers/browser-table').browserTable();
let queryHook = null;
core.pool.query = async (sql, params) => {
    const r = table.query(sql, params);
    if (queryHook && queryHook.match.test(sql)) {
        const hook = queryHook;
        queryHook = null;
        await hook.run();
    }
    if (r) return r;
    if (/INSERT INTO app_settings/.test(sql)) { if (!(params[0] in settings)) settings[params[0]] = params[1]; return { rows: [], rowCount: 1 }; }
    return { rows: [] };
};
let connectGate = null;
core.pool.connect = async () => {
    if (connectGate) await connectGate.promise;
    return table.connect();
};
const gate = () => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; };

const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
let snapshot = {};
nb.netbirdGet = async (p) => JSON.parse(JSON.stringify(snapshot[p] ?? null));

const events = require('../lib/events');
const recorded = [];
const insertedIds = new Set();
const attemptedIds = [];
let failingWrites = 0;
events.addEvent = async (e) => {
    attemptedIds.push(e.ID);
    if (failingWrites > 0) { failingWrites--; throw new Error('the database is not answering'); }
    if (insertedIds.has(e.ID)) return { rowCount: 0 };
    insertedIds.add(e.ID);
    recorded.push(JSON.parse(JSON.stringify(e)));
    return { rowCount: 1 };
};

const ra = require('../lib/remote-access');
const rb = require('../lib/remote-browser');
const { encodeInstruction, GuacParser } = ra._internal;
const { WebSocketServer, WebSocket } = require('ws');

const socketPath = (name) => (process.platform === 'win32'
    ? `\\\\.\\pipe\\nbc-test-${name}-${crypto.randomBytes(6).toString('hex')}`
    : path.join(os.tmpdir(), `nbc-test-${name}-${crypto.randomBytes(6).toString('hex')}.sock`));

const sup = { sessions: new Map(), tombstones: new Set(), requests: [], nextUid: 62000, failStop: false, renewAnswer: null, table7120: ['default dev wt0'], down: false, instance: 'instance-1', onList: null, unlisted: new Set(), started: new Map(), delays: new Map(), clock: () => Date.now() };
const expired = (req) => req.until <= sup.clock();
const gone = (id) => ({ ok: false, error: sup.tombstones.has(id) ? 'ENDED' : 'UNKNOWN' });
const supervisor = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => { });
    sock.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const req = JSON.parse(buf.slice(0, i));
            buf = buf.slice(i + 1);
            sup.requests.push({ ...req, at: Date.now() });
            if (sup.down) { sock.destroy(); return; }
            req.receivedAt = Date.now();
            if (req.op === 'start' && sup.dropNextStart) {
                sup.dropNextStart = false;
                answer(req);
                sock.destroy();
                return;
            }
            const delay = sup.delays.get(req.op + ':' + req.session) ?? sup.delays.get(req.op + ':*');
            const reply = () => sock.write(JSON.stringify(answer(req)) + '\n');
            if (delay) setTimeout(reply, delay); else reply();
        }
    });
});
function answer(req) {
    switch (req.op) {
        case 'start': {
            if (!Number.isInteger(req.width) || !Number.isInteger(req.height) || !Number.isInteger(req.dpi) || typeof req.terminal !== 'boolean' || !Number.isInteger(req.until)) return { ok: false, error: 'BAD_REQUEST' };
            if (req.terminal) return { ok: false, error: 'TERMINAL' };
            if (expired(req)) return { ok: false, error: 'EXPIRED' };
            if (sup.tombstones.has(req.session)) return { ok: false, error: 'ENDED' };
            if (!sup.sessions.has(req.session)) {
                const uid = sup.nextUid++;
                sup.sessions.set(req.session, { uid, port: 5901 + uid - 62000, password: crypto.randomBytes(4).toString('hex'), startedAt: req.receivedAt || Date.now() });
            }
            const s = sup.sessions.get(req.session);
            return { ok: true, port: s.port, password: s.password, uid: s.uid, instance: sup.instance, startedAt: s.startedAt };
        }
        case 'renew':
            if (!Number.isInteger(req.until)) return { ok: false, error: 'BAD_REQUEST' };
            if (sup.renewAnswer) return sup.renewAnswer;
            if (!sup.sessions.has(req.session)) return gone(req.session);
            if (expired(req)) return { ok: false, error: 'EXPIRED' };
            return { ok: true };
        case 'status':
            return sup.sessions.has(req.session) ? { ok: true, state: 'running' } : gone(req.session);
        case 'credentials': {
            if (!Number.isInteger(req.until)) return { ok: false, error: 'BAD_REQUEST' };
            const s = sup.sessions.get(req.session);
            if (!s) return gone(req.session);
            if (expired(req)) return { ok: false, error: 'EXPIRED' };
            return { ok: true, port: s.port, password: s.password, uid: s.uid, instance: sup.instance, startedAt: s.startedAt };
        }
        case 'stop':
            if (sup.failStop) return { ok: false, error: 'STOP_FAILED' };
            sup.tombstones.add(req.session);
            sup.sessions.delete(req.session);
            return { ok: true, state: 'stopped' };
        case 'list':
            if (sup.onList) sup.onList();
            return { ok: true, instance: sup.instance, sessions: [...sup.sessions].filter(([session]) => !sup.unlisted.has(session)).map(([session, s]) => ({ session, state: 'running', uid: s.uid, port: s.port, startedAt: s.startedAt })) };
        case 'ready':
            return { ok: true, instance: sup.instance, netns: 4026532001, gateway: { ts: Math.floor(Date.now() / 1000), netns: 4026532001, wt0: '100.92.0.7', lock: true, table7120: ['default dev wt0'] }, table7120: sup.table7120 };
        default:
            return { ok: false, error: 'BAD_REQUEST' };
    }
}

let guacdSeen = [];
let guacdNoDisplay = false;
let onSelect = null;
const guacdSockets = [];
const guacd = net.createServer((sock) => {
    guacdSockets.push(sock);
    sock.on('error', () => { });
    const parser = new GuacParser(1 << 20);
    sock.on('data', (d) => {
        for (const ins of parser.push(d.toString('utf8'))) {
            guacdSeen.push(ins);
            if (ins.opcode === 'select' && onSelect) onSelect();
            if (ins.opcode === 'select') sock.write(encodeInstruction('args', 'VERSION_1_5_0', 'hostname', 'port', 'password', 'color-depth', 'disable-copy', 'disable-paste', 'enable-sftp', 'enable-audio', 'disable-display-resize', 'clipboard-encoding'));
            if (ins.opcode === 'connect') sock.write(encodeInstruction('ready', '$vnc-1') + (guacdNoDisplay ? encodeInstruction('nop') + encodeInstruction('error', 'Aborted. See logs.', '519') : encodeInstruction('size', '0', '1280', '720')));
        }
    });
});

const httpServer = http.createServer();
const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', async (req, socket, head) => {
    const entry = await rb.takeToken(new URL(req.url, 'http://x').searchParams.get('token'));
    if (!entry) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => rb.attachWebTunnel(entry, ws));
});

const USER = { user_id: 'u1', email: 'u1@example.com', name: 'User One', oid: 'oid-1' };
const OTHER = { user_id: 'u2', email: 'u2@example.com', name: 'User Two' };
const WEB_IDS = { webGroupId: 'g-web', webAclGroupId: 'g-acl', webRouteId: 'rt-web', webPolicyId: 'pol-web', webRoutingPolicyId: 'pol-web-routing' };

async function buildSnapshot() {
    const gate = await ra.readBrowserGate();
    const policy = (p, id) => ({ id, ...p });
    snapshot = {
        '/api/users': [{ id: 'u1', auto_groups: [] }, { id: 'u2', auto_groups: [] }],
        '/api/peers': [
            { id: 'laptop', name: 'Laptop', user_id: 'u1', groups: [{ id: 'g-staff' }], connected: false },
            { id: 'router', name: 'Router', user_id: '', groups: [{ id: 'g-office' }], connected: true },
            { id: 'web-gw', name: 'netbird-control-browser-gateway-web', user_id: '', ip: '100.92.0.7', groups: [{ id: 'g-web' }], connected: true },
        ],
        '/api/groups': [
            { id: 'g-all', name: 'All', peers: [{ id: 'laptop' }, { id: 'router' }, { id: 'web-gw' }] },
            { id: 'g-staff', name: 'Staff', peers: [{ id: 'laptop' }] },
            { id: 'g-office', name: 'Office Peers', peers: [{ id: 'router' }] },
            { id: 'g-web', name: 'Browser Gateway Web (NetBird Control)', peers: [{ id: 'web-gw' }], resources: [] },
            { id: 'g-acl', name: 'Browser Gateway Web ACL (NetBird Control)', peers: [], resources: [] },
        ],
        '/api/policies': [
            { id: 'pol-staff', name: 'Staff to Office', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'all', sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-office' }] }] },
            policy(gate.want.icmpPolicy, 'pol-web'), policy(gate.want.routingPolicy, 'pol-web-routing'),
        ],
        '/api/networks/resources': [], '/api/networks': [],
        '/api/routes': [
            { id: 'rt-office', network_id: 'office-exit', network: '0.0.0.0/0', enabled: true, peer_groups: ['g-office'], groups: ['g-staff'], access_control_groups: [] },
            { id: 'rt-web', ...gate.want.route },
        ],
    };
}

async function reset({ maxSessions = 5, keepAliveMin = 15 } = {}) {

    rb._internal.resetForTest();
    table.rows.clear();
    recorded.length = 0;
    guacdSeen = [];
    guacdNoDisplay = false;
    onSelect = null;
    Object.assign(sup, { requests: [], failStop: false, renewAnswer: null, table7120: ['default dev wt0'], down: false, instance: 'instance-1', onList: null, clock: () => Date.now() });
    sup.delays.clear();
    sup.dropNextStart = false;
    insertedIds.clear();
    attemptedIds.length = 0;
    failingWrites = 0;
    connectGate = null;
    queryHook = null;
    sup.unlisted.clear();
    rb._internal.setEndpointsForTest({ ...paths, guacd: { host: '127.0.0.1', port: guacd.address().port } });
    sup.sessions.clear();
    sup.tombstones.clear();
    for (const k of Object.keys(settings)) delete settings[k];
    settings.remote_access_nb = JSON.stringify(WEB_IDS);
    settings.remote_access_web_peer = JSON.stringify({ id: 'web-gw', ip: '100.92.0.7' });
    ra._internal.setManagedForTest(WEB_IDS);
    ra._internal.setConfigForTest({
        enabled: true,
        browser: { enabled: true, routerGroupId: 'g-office', maxSessions, keepAliveMin },
    });
    ra.invalidateSnapshot();
    await buildSnapshot();
}

const paths = { supervisor: socketPath('sup'), connections: socketPath('conn') };
test.before(async () => {
    await new Promise(r => supervisor.listen(paths.supervisor, r));
    await new Promise(r => guacd.listen(0, '127.0.0.1', r));
    await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
});
test.after(async () => {
    await rb._internal.closeConnectionsForTest();
    for (const s of guacdSockets) s.destroy();
    await new Promise(r => supervisor.close(r));
    await new Promise(r => guacd.close(r));
    await new Promise(r => httpServer.close(r));
});

const until = async (cond, ms = 3000) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
        if (Date.now() > end) throw new Error('timed out waiting');
        await new Promise(r => setTimeout(r, 10));
    }
};
const rejects = async (p, status, code) => {
    await assert.rejects(p, (e) => { assert.equal(e.code, code); assert.equal(e.status, status); return true; });
};

function connect(token) {
    const ws = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/?token=${encodeURIComponent(token)}`);
    const got = [];
    const parser = new GuacParser(1 << 20);
    ws.on('message', (d) => { for (const ins of parser.push(d.toString())) got.push(ins); });
    const closed = new Promise(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    return { ws, got, closed, opened: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }) };
}
const errorOf = (got) => got.find(i => i.opcode === 'error');
const ulogdTime = (ms) => new Date(ms).toISOString().slice(0, 19) + '+0000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('a web session opens without any target: checks, a slot, the supervisor, a start record and a token', async () => {
    await reset();
    const before = Date.now();
    const out = await rb.createWebSession(USER, { protocol: 'web', width: 2560, height: 1440, dpi: 144, timezone: 'Asia/Jerusalem' }, '198.51.100.9');
    assert.equal(out.protocol, 'web');
    assert.match(out.token, /^[A-Za-z0-9_-]{43}$/);
    const start = sup.requests.find(r => r.op === 'start');
    const { until, at, ...rest } = start;
    assert.deepEqual(rest, { op: 'start', session: out.sessionId, width: 1920, height: 1080, dpi: 144, terminal: false });
    assert.ok(until >= before + 150_000 && until <= Date.now() + 150_000, 'the first lease ends 150 s after the authorization');
    const row = table.rows.get(out.sessionId);
    assert.equal(out.attachment, row.attachment);
    assert.equal(row.supervisor_instance, 'instance-1');
    assert.equal(row.token_hash, crypto.createHash('sha256').update(out.token).digest('hex'), 'only a hash of the token is stored');
    assert.equal(row.state, 'detached');
    assert.equal(row.uid, 62000);
    assert.equal(row.recorded, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].reference, 'remote-access:web');
    assert.equal(recorded[0].Message, 'TYPE_START');
    assert.equal(recorded[0].meta.destination_name, 'Remote Browser');
    assert.equal(recorded[0].meta.source_type, 'BROWSER_GATEWAY');
    assert.equal(recorded[0].remoteAccess.protocol, 'web');
    assert.ok(!JSON.stringify(recorded).includes(sup.sessions.get(out.sessionId).password));
    const listed = await rb.listWebSessions(USER);
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].state, 'detached');
    assert.equal(typeof listed.sessions[0].expiresAt, 'string');
    assert.equal((await rb.listWebSessions(OTHER)).sessions.length, 0);
});

test('no exit node for the same device, a closed gate or no capacity: no session, and nothing held', async () => {
    await reset({ maxSessions: 1 });
    snapshot['/api/policies'][0].enabled = false;
    ra.invalidateSnapshot();
    await rejects(rb.createWebSession(USER, {}, ''), 403, 'NO_EXIT_NODE');
    await buildSnapshot();
    ra.invalidateSnapshot();
    sup.table7120 = ['default dev wt0', '10.0.0.0/8 dev wt0'];
    await rejects(rb.createWebSession(USER, {}, ''), 503, 'GATEWAY_NOT_READY');
    sup.table7120 = ['default dev wt0'];
    snapshot['/api/routes'][1].masquerade = false;
    ra.invalidateSnapshot();
    await rejects(rb.createWebSession(USER, {}, ''), 503, 'GATEWAY_NOT_READY');
    assert.equal(table.rows.size, 0);
    await buildSnapshot();
    ra.invalidateSnapshot();
    await rb.createWebSession(USER, {}, '');
    await rejects(rb.createWebSession(USER, {}, ''), 429, 'BROWSER_CAPACITY');
    assert.equal([...table.rows.values()].filter(r => r.state !== 'ended').length, 1);
});

test('the connection check reports each web step the way the page shows it, and opens nothing', async () => {
    await reset();
    const ok = await rb.checkWebAccess(USER);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.steps.map(s => [s.key, s.status]), [['access', 'pass'], ['path', 'pass']]);
    snapshot['/api/policies'][0].enabled = false;
    ra.invalidateSnapshot();
    assert.deepEqual((await rb.checkWebAccess(USER)).steps.map(s => [s.key, s.status, s.code]), [['access', 'fail', 'NO_EXIT_NODE']]);
    await buildSnapshot();
    ra.invalidateSnapshot();
    sup.table7120 = ['default dev wt0', '10.0.0.0/8 dev wt0'];
    assert.deepEqual((await rb.checkWebAccess(USER)).steps.map(s => [s.key, s.status, s.code]), [['ready', 'fail', 'GATEWAY_NOT_READY']]);
    sup.table7120 = ['default dev wt0'];
    assert.equal(sup.requests.filter(r => r.op === 'start').length, 0);
    assert.equal(table.rows.size, 0);
});

test('turned off: no session opens, and the open ones are stopped', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    ra._internal.setConfigForTest({ enabled: true, browser: { enabled: false, routerGroupId: 'g-office' } });
    await rejects(rb.createWebSession(USER, {}, ''), 403, 'BROWSER_DISABLED');
    await rb.onConfigChanged();
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
    assert.equal(table.rows.get(out.sessionId).end_code, rb.CODE.denied);
    assert.ok(sup.tombstones.has(out.sessionId));
});

test('the tunnel speaks VNC to the browser guacd with the supervisor credentials, caps the size and detaches on close', async () => {
    await reset();
    const out = await rb.createWebSession(USER, { width: 1280, height: 720, dpi: 96 }, '');
    const c = connect(out.token);
    await c.opened;
    await until(() => guacdSeen.some(i => i.opcode === 'connect') && table.rows.get(out.sessionId).state === 'active');
    assert.equal(guacdSeen.find(i => i.opcode === 'select').args[0], 'vnc');
    const s = sup.sessions.get(out.sessionId);
    const args = guacdSeen.find(i => i.opcode === 'connect').args;
    assert.deepEqual(args, ['VERSION_1_5_0', '127.0.0.1', String(s.port), s.password, '24', '', '', '', '', '', '']);
    await until(() => c.got.some(i => i.opcode === 'size'));
    c.ws.send(encodeInstruction('size', '3840', '2160', '192'));
    await until(() => guacdSeen.some(i => i.opcode === 'size' && i.args[0] === '1920'));
    assert.deepEqual(guacdSeen.filter(i => i.opcode === 'size').pop().args, ['1920', '1080', '192']);
    c.ws.send(encodeInstruction('disconnect'));
    await c.closed;
    await until(() => table.rows.get(out.sessionId).state === 'detached');
    assert.ok(sup.sessions.has(out.sessionId), 'the browser keeps running');
    assert.equal(await rb.takeToken(out.token), null, 'a token is used once');
});

test('resume: same user only, takes over the attached tab, and an ended session answers 410', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const first = connect(out.token);
    await first.opened;
    await until(() => table.rows.get(out.sessionId).state === 'active');
    await rejects(rb.resumeWebSession(OTHER, out.sessionId, {}), 404, 'SESSION_NOT_FOUND');
    const again = await rb.resumeWebSession(USER, out.sessionId, { width: 800, height: 600 });
    assert.equal(again.sessionId, out.sessionId);
    const closed = await first.closed;
    const err = errorOf(first.got);
    assert.equal(err.args[0], 'Your browser was opened in another window.');
    assert.equal(Number(err.args[1]), 0x0205);
    assert.equal(closed.code, 1000);
    const second = connect(again.token);
    await second.opened;
    await until(() => table.rows.get(out.sessionId).state === 'active' && guacdSeen.filter(i => i.opcode === 'connect').length === 2);
    assert.equal(sup.requests.filter(r => r.op === 'start').length, 1, 'resume never starts a browser');
    assert.equal(sup.requests.filter(r => r.op === 'credentials').length, 3, 'the password comes from the supervisor again');
    assert.equal(again.attachment, table.rows.get(out.sessionId).attachment);
    assert.equal(await rb.endWebSessionByUser(USER, out.sessionId), 'stopped');
    await second.closed;
    assert.equal(Number(errorOf(second.got).args[1]), 0x020B);
    await rejects(rb.resumeWebSession(USER, out.sessionId, {}), 410, 'BROWSER_ENDED');
    await rejects(rb.endWebSessionByUser(USER, out.sessionId), 410, 'BROWSER_ENDED');
    const end = recorded.find(e => e.Message === 'TYPE_END');
    assert.equal(end.remoteAccess.endReason, 'Closed by the user.');
    assert.equal(end.ID, `${out.sessionId}:end`);
});

test('a session taken over on another instance is closed by the row watch', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const c = connect(out.token);
    await c.opened;
    await until(() => table.rows.get(out.sessionId).state === 'active');
    table.rows.get(out.sessionId).attachment = 'another-instance';
    await rb.watchAttached();
    await c.closed;
    assert.equal(Number(errorOf(c.got).args[1]), 0x0205);
    assert.equal(table.rows.get(out.sessionId).state, 'active', 'the other tab owns it now');
});

test('a browser that closed by itself is reported as ended when the guacd side closes', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const c = connect(out.token);
    await c.opened;
    await until(() => guacdSeen.some(i => i.opcode === 'connect'));
    sup.sessions.delete(out.sessionId);
    sup.tombstones.add(out.sessionId);
    guacdSockets[guacdSockets.length - 1].destroy();
    await c.closed;
    const err = errorOf(c.got);
    assert.equal(Number(err.args[1]), 0x020B);
    assert.equal(err.args[0], 'The browser was closed.');
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
});

test('a VNC display that never opens fails with a clear reason and leaves the session to resume', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    guacdNoDisplay = true;
    const c = connect(out.token);
    await c.opened;
    await c.closed;
    const err = errorOf(c.got);
    assert.equal(err.args[0], "The remote browser's screen didn't open. Resume the session to try again.");
    assert.equal(Number(err.args[1]), 0x0203);
    assert.ok(!c.got.some(i => i.opcode === 'error' && /Aborted/.test(i.args[0])), "guacd's own error is not passed on");
    await until(() => table.rows.get(out.sessionId).state === 'detached');
});

test('a lease keeps only an attached session alive; a detached one keeps counting from when it detached', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const row = table.rows.get(out.sessionId);
    const detachedAt = row.detached_at;
    assert.equal(await rb.renewWebLease(USER, out.sessionId, out.attachment), true);
    assert.equal(row.detached_at, detachedAt);
    assert.equal(row.lease_expires_at, null);
    assert.equal(await rb.renewWebLease(OTHER, out.sessionId, out.attachment), false);
    assert.equal(await rb.renewWebLease(USER, out.sessionId, ''), false);
    assert.equal(await rb.renewWebLease(USER, out.sessionId, 'an-older-tab'), false, 'a tab that was taken over never renews the new one');
});

test('the leader loop renews, detaches an expired viewer lease, ends after the keep-alive, after lost verification, and when the browser closed', async () => {
    await reset({ keepAliveMin: 15 });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await rb.createWebSession(USER, {}, '')).sessionId);
    const [renewed, leaseGone, keepAliveGone, unverified] = ids.map(id => table.rows.get(id));
    Object.assign(leaseGone, { state: 'active', lease_expires_at: new Date(Date.now() - 1000), detached_at: null });
    keepAliveGone.detached_at = new Date(Date.now() - 16 * 60_000);
    unverified.last_auth_ok_at = new Date(Date.now() - 151_000);
    const readSnapshot = ra.readSnapshotNow;
    ra.readSnapshotNow = async () => { throw new Error('NetBird is not answering'); };
    try {
        await rb._internal.superviseWebSessions();
    } finally {
        ra.readSnapshotNow = readSnapshot;
    }
    assert.equal(renewed.state, 'detached');
    assert.ok(sup.requests.some(r => r.op === 'renew' && r.session === renewed.id));
    assert.equal(leaseGone.state, 'detached');
    assert.equal(keepAliveGone.state, 'ended');
    assert.equal(keepAliveGone.end_reason, 'The session ended after 15 minutes without a connection.');
    assert.equal(unverified.state, 'ended');
    assert.equal(unverified.end_code, rb.CODE.denied);
    sup.sessions.delete(renewed.id);
    await rb._internal.superviseWebSessions();
    assert.equal(renewed.state, 'ended');
    assert.equal(renewed.end_reason, 'The browser was closed.');
});

test('a stop that fails keeps the slot until a later stop succeeds', async () => {
    await reset({ maxSessions: 1 });
    const out = await rb.createWebSession(USER, {}, '');
    sup.failStop = true;
    assert.equal(await rb.endWebSessionByUser(USER, out.sessionId), 'ending');
    assert.equal(table.rows.get(out.sessionId).state, 'ending');
    await rejects(rb.createWebSession(USER, {}, ''), 429, 'BROWSER_CAPACITY');
    sup.failStop = false;
    await rb._internal.superviseWebSessions();
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
    assert.equal(recorded.filter(e => e.Message === 'TYPE_END').length, 1);
});

test('a start the supervisor did not answer is stopped, so no browser is left behind', async () => {
    await reset();
    sup.down = true;
    await rejects(rb.createWebSession(USER, {}, ''), 503, 'GATEWAY_NOT_READY');
    sup.down = false;
    sup.dropNextStart = true;
    await rejects(rb.createWebSession(USER, {}, ''), 503, 'BROWSER_UNAVAILABLE');
    const row = [...table.rows.values()][0];
    assert.equal(row.state, 'ended');
    assert.ok(sup.tombstones.has(row.id));
    assert.equal(recorded.length, 0, 'no start record, so no end record');
});

test('startup reconcile stops browsers without a row and ends rows without a browser', async () => {
    await reset();
    const kept = await rb.createWebSession(USER, {}, '');
    const lost = await rb.createWebSession(USER, {}, '');
    sup.sessions.delete(lost.sessionId);
    sup.sessions.set('orphan', { uid: 62999, port: 6900, password: 'x' });
    table.rows.set('young', { ...table.rows.get(kept.sessionId), id: 'young', state: 'starting', created_at: new Date() });
    assert.equal(await rb._internal.reconcileWithSupervisor(), true);
    assert.ok(sup.tombstones.has('orphan'));
    assert.equal(table.rows.get(lost.sessionId).state, 'ended');
    assert.equal(table.rows.get(kept.sessionId).state, 'detached');
    assert.equal(table.rows.get('young').state, 'starting');
});

test('the re-check ends sessions whose exit node entitlement is gone, and refreshes the others', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    table.rows.get(out.sessionId).last_auth_ok_at = new Date(Date.now() - 100_000);
    await rb._internal.superviseWebSessions();
    assert.ok(Date.now() - table.rows.get(out.sessionId).last_auth_ok_at < 5000);
    snapshot['/api/peers'][0].login_expired = true;
    await rb._internal.superviseWebSessions();
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
    assert.equal(table.rows.get(out.sessionId).end_code, 0x0303);
});

test('the re-check stops every web session when the gate closes', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    snapshot['/api/groups'][3].peers.push({ id: 'laptop' });
    await rb._internal.superviseWebSessions();
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
    assert.match(table.rows.get(out.sessionId).end_reason, /browser gateway isn't ready/);
});

test('connection log: a gap on bind, one event per new 5-tuple, records split across writes, an unknown uid resolved later', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    const gaps = recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'gap');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].reference, 'remote-access:web-connection');
    const uid = table.rows.get(out.sessionId).uid;
    const line = (o) => JSON.stringify({ timestamp: ulogdTime(Date.now()), 'oob.uid': o.uid, 'ip.protocol': o.p || 6, src_ip: '100.92.0.7', src_port: o.sp || 40000, dest_ip: o.ip || '93.184.215.14', dest_port: o.dp || 443 }) + '\n';
    const sock = net.connect(paths.connections);
    await new Promise(r => sock.on('connect', r));
    const burst = line({ uid }) + line({ uid }) + line({ uid, p: 17, sp: 50000 }) + line({ uid, p: 17, sp: 50000 }) + line({ uid, sp: 40001 });
    sock.write(burst.slice(0, 37));
    sock.write(burst.slice(37));
    const later = await rb.createWebSession(USER, {}, '');
    const laterUid = table.rows.get(later.sessionId).uid;
    sock.write(line({ uid: laterUid, ip: '1.1.1.1' }));
    await until(async () => { await rb._internal.eventsIdleForTest(); return recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'connection').length === 4; }, 5000);
    const conns = recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'connection');
    assert.deepEqual(conns.map(e => e.meta.protocol).sort(), [17, 6, 6, 6].sort());
    assert.equal(new Set(conns.map(e => e.ID)).size, 4);
    const web = conns.find(e => e.meta.destination_addr === '1.1.1.1:443');
    assert.equal(web.remoteAccess.sessionId, later.sessionId);
    assert.equal(web.reference, 'remote-access:web-connection');
    assert.equal(web.meta.user_id, 'u1');
    sock.destroy();
    await rb._internal.closeConnectionsForTest();
});

test('an attached tab whose viewer lease lapsed is disconnected, and its keep-alive starts', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const c = connect(out.token);
    await c.opened;
    await until(() => table.rows.get(out.sessionId).state === 'active');
    table.rows.get(out.sessionId).lease_expires_at = new Date(Date.now() - 1000);
    await rb._internal.superviseWebSessions();
    assert.equal(table.rows.get(out.sessionId).state, 'detached');
    await rb.watchAttached();
    await c.closed;
    assert.equal(Number(errorOf(c.got).args[1]), 0x0303);
    assert.equal(table.rows.get(out.sessionId).state, 'detached');
    assert.ok(sup.sessions.has(out.sessionId));
});

test('connection log: after the per-session cap, one gap event and nothing more', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    recorded.length = 0;
    const uid = table.rows.get(out.sessionId).uid;
    const cap = rb._internal.CONNECTIONS_PER_SESSION;
    const record = (i) => rb._internal.handleRecord(JSON.stringify({ 'oob.uid': uid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: 10000 + i, dest_ip: '93.184.215.14', dest_port: 443 }));
    for (let i = 0; i < cap; i++) record(i);
    await rb._internal.eventsIdleForTest();
    for (let i = cap; i < cap + 5; i++) record(i);
    await rb._internal.eventsIdleForTest();
    assert.equal(recorded.filter(e => e.remoteAccess.kind === 'connection').length, cap);
    const gaps = recorded.filter(e => e.remoteAccess.kind === 'gap');
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].remoteAccess.reason, /not recorded/);
    assert.equal(gaps[0].ID, `web-gap:${out.sessionId}:cap`);
    assert.equal(table.rows.get(out.sessionId).conn_count, cap + 1);
    await rb._internal.closeConnectionsForTest();
});

test('the supervisor client and the record parser refuse what they cannot read', () => {
    assert.equal(rb._internal.parseRecord('not json'), null);
    assert.equal(rb._internal.parseRecord(JSON.stringify({ 'oob.uid': 'x', 'ip.protocol': 6, dest_ip: '1.1.1.1' })), null);
    assert.equal(rb._internal.parseRecord(JSON.stringify({ 'oob.uid': 62000, 'ip.protocol': 6, dest_ip: '1.1.1.1', timestamp: 'junk' })).at instanceof Date, true);
    assert.deepEqual(rb._internal.fitSize(5000, 3000), [1920, 1080]);
    assert.deepEqual(rb._internal.fitSize(800, 600), [800, 600]);
    assert.equal(rb._internal.fitSize(0, 600), null);
    assert.equal(rb._internal.fitSize(NaN, 600), null);
});

test('the leader renews each browser only until its last authorization plus 150 s, and a tunnel error only asks for the status', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const row = table.rows.get(out.sessionId);
    row.last_auth_ok_at = new Date(Date.now() - 100_000);
    sup.requests.length = 0;
    await rb._internal.superviseWebSessions();
    const renew = sup.requests.find(r => r.op === 'renew');
    assert.equal(renew.until, row.last_auth_ok_at.getTime() + 150_000);
    const c = connect((await rb.resumeWebSession(USER, out.sessionId, {})).token);
    await c.opened;
    await until(() => guacdSeen.some(i => i.opcode === 'connect'));
    sup.requests.length = 0;
    guacdSockets[guacdSockets.length - 1].destroy();
    await c.closed;
    assert.deepEqual(sup.requests.map(r => r.op), ['status']);
    await until(() => table.rows.get(out.sessionId).state === 'detached');
});

test('a token lives in the database: it works on another app instance once, and not after 30 s', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    rb._internal.resetForTest();
    const entry = await rb.takeToken(out.token);
    assert.equal(entry.sessionId, out.sessionId);
    assert.equal(entry.attachment, out.attachment);
    assert.equal(await rb.takeToken(out.token), null);
    const again = await rb.resumeWebSession(USER, out.sessionId, {});
    table.rows.get(out.sessionId).token_expires = new Date(Date.now() - 1);
    assert.equal(await rb.takeToken(again.token), null);
    assert.equal(await rb.takeToken(''), null);
});

test('a guacd the app cannot reach keeps new sessions closed with a clear reason, but never ends the open ones', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const closed = net.createServer();
    await new Promise(r => closed.listen(0, '127.0.0.1', r));
    const port = closed.address().port;
    await new Promise(r => closed.close(r));
    rb._internal.setEndpointsForTest({ ...paths, guacd: { host: '127.0.0.1', port } });
    await assert.rejects(rb.createWebSession(USER, {}, ''), (e) => e.status === 503 && e.code === 'GATEWAY_NOT_READY' && /display service/.test(e.message));
    const check = await rb.checkWebAccess(USER);
    assert.equal(check.steps[0].code, 'GATEWAY_NOT_READY');
    assert.match(check.steps[0].message, /display service/);
    assert.equal((await rb.getBrowserStatus()).code, 'GUACD_UNREACHABLE');
    await rb._internal.superviseWebSessions();
    assert.equal(table.rows.get(out.sessionId).state, 'detached');
});

test('resume asks the supervisor for the running browser and never starts an empty one; a lost browser answers 410', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    sup.sessions.delete(out.sessionId);
    sup.requests.length = 0;
    await rejects(rb.resumeWebSession(USER, out.sessionId, {}), 410, 'BROWSER_ENDED');
    assert.ok(!sup.requests.some(r => r.op === 'start'));
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
    assert.equal(table.rows.get(out.sessionId).end_reason, 'The browser was closed.');
});

test('a detached browser past its keep-alive cannot be resumed or attached, even before the leader ends it', async () => {
    await reset({ keepAliveMin: 15 });
    const out = await rb.createWebSession(USER, {}, '');
    table.rows.get(out.sessionId).detached_at = new Date(Date.now() - 16 * 60_000);
    const c = connect(out.token);
    await c.closed;
    assert.match(errorOf(c.got).args[0], /15 minutes without a connection/);
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
    const late = await rb.createWebSession(USER, {}, '');
    table.rows.get(late.sessionId).detached_at = new Date(Date.now() - 16 * 60_000);
    await rejects(rb.resumeWebSession(USER, late.sessionId, {}), 410, 'BROWSER_ENDED');
    assert.equal(table.rows.get(late.sessionId).state, 'ended');
    assert.ok(sup.tombstones.has(late.sessionId));
});

test('reconcile reads the rows first: a browser started after that read is kept, and a row missing from the list is ended only after its status says so', async () => {
    await reset();
    const kept = await rb.createWebSession(USER, {}, '');
    const late = { ...table.rows.get(kept.sessionId), id: 'late', uid: 62100 };
    sup.onList = () => {
        table.rows.set('late', { ...late });
        sup.sessions.set('late', { uid: 62100, port: 6001, password: 'x' });
    };
    sup.unlisted.add(kept.sessionId);
    assert.equal(await rb._internal.reconcileWithSupervisor(), true);
    assert.ok(!sup.tombstones.has('late'), 'a browser whose row appeared after the read is not stopped');
    assert.equal(table.rows.get(kept.sessionId).state, 'detached', 'its status says it still runs');
    assert.ok(sup.requests.some(r => r.op === 'status' && r.session === kept.sessionId));
});

test('a supervisor restart ends the old sessions as restarted, and their connections are never given to anyone', async () => {
    await reset();
    const old = await rb.createWebSession(USER, {}, '');
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    recorded.length = 0;
    const uid = table.rows.get(old.sessionId).uid;
    sup.sessions.clear();
    sup.instance = 'instance-2';
    await rb._internal.reconcileWithSupervisor();
    assert.equal(table.rows.get(old.sessionId).state, 'ended');
    assert.equal(table.rows.get(old.sessionId).end_reason, 'The remote browser restarted, so the session ended.');
    const record = (port) => JSON.stringify({ 'oob.uid': uid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: port, dest_ip: '93.184.215.14', dest_port: 443 });
    rb._internal.handleRecord(record(41000));
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    await rb._internal.eventsIdleForTest();
    assert.equal(recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'connection').length, 0);
    assert.equal(recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'gap').length, 1);
    sup.nextUid = uid;
    const fresh = await rb.createWebSession(USER, {}, '');
    assert.equal(table.rows.get(fresh.sessionId).uid, uid, 'the fake supervisor hands out the same uid again');
    rb._internal.handleRecord(record(41001));
    await rb._internal.eventsIdleForTest();
    const conns = recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'connection');
    assert.deepEqual(conns.map(e => e.remoteAccess.sessionId), [fresh.sessionId]);
    await rb._internal.closeConnectionsForTest();
});

test('a record whose uid maps to no open session becomes a gap with the number missed, and an ended session stops mapping at once', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    recorded.length = 0;
    const uid = table.rows.get(out.sessionId).uid;
    sup.failStop = true;
    await rb.endWebSession(out.sessionId, 'Closed by the user.');
    assert.equal(table.rows.get(out.sessionId).state, 'ending');
    const record = (port) => JSON.stringify({ 'oob.uid': uid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: port, dest_ip: '93.184.215.14', dest_port: 443 });
    rb._internal.handleRecord(record(42000));
    rb._internal.handleRecord(record(42001));
    rb._internal.handleRecord(JSON.stringify({ 'oob.uid': 62777, 'ip.protocol': 17, dest_ip: '1.1.1.1', dest_port: 53 }));
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    await rb._internal.eventsIdleForTest();
    assert.equal(recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'connection').length, 0);
    const gaps = recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'gap');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].remoteAccess.missed, 3);
    assert.equal(gaps[0].reference, 'remote-access:web-connection');
    await rb._internal.closeConnectionsForTest();
});

test('connection ids are the same on every leader, and the cap is counted in the database', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    recorded.length = 0;
    const uid = table.rows.get(out.sessionId).uid;
    const record = (port) => JSON.stringify({ 'oob.uid': uid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: port, dest_ip: '93.184.215.14', dest_port: 443 });
    rb._internal.handleRecord(record(43000));
    await rb._internal.eventsIdleForTest();
    await rb._internal.closeConnectionsForTest();
    rb._internal.resetForTest();
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.reconcileWithSupervisor();
    await rb._internal.eventsIdleForTest();
    rb._internal.handleRecord(record(43000));
    await rb._internal.eventsIdleForTest();
    const conns = recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'connection');
    assert.equal(attemptedIds.filter(id => id === conns[0].ID).length, 2, 'the second leader writes the same id');
    assert.equal(conns.length, 1, 'so the database keeps one event');
    assert.equal(table.rows.get(out.sessionId).conn_count, 1, 'and the duplicate does not use the quota');
    assert.match(conns[0].ID, new RegExp(`^web-conn:${out.sessionId}:[0-9a-f]{64}$`));
    recorded.length = 0;
    table.rows.get(out.sessionId).conn_count = rb._internal.CONNECTIONS_PER_SESSION;
    rb._internal.handleRecord(record(43001));
    rb._internal.handleRecord(record(43002));
    await rb._internal.eventsIdleForTest();
    assert.equal(recorded.filter(e => e.remoteAccess.kind === 'connection').length, 0);
    const gaps = recorded.filter(e => e.remoteAccess.kind === 'gap');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].ID, `web-gap:${out.sessionId}:cap`);
    await rb._internal.closeConnectionsForTest();
});

test('the authorization time is one value: stored at create and resume, and sent as until by start, attach, resume and renew', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const stored = () => table.rows.get(out.sessionId).last_auth_ok_at.getTime();
    assert.equal(sup.requests.find(r => r.op === 'start').until, stored() + 150_000);
    sup.requests.length = 0;
    const first = connect(out.token);
    await first.opened;
    await until(() => table.rows.get(out.sessionId).state === 'active');
    assert.equal(sup.requests.find(r => r.op === 'credentials').until, stored() + 150_000, 'attach uses the stored time');
    table.rows.get(out.sessionId).last_auth_ok_at = new Date(Date.now() - 60_000);
    sup.requests.length = 0;
    const before = Date.now();
    await rb.resumeWebSession(USER, out.sessionId, {});
    await first.closed;
    const credentials = sup.requests.find(r => r.op === 'credentials');
    assert.ok(stored() >= before && stored() <= credentials.at, 'resume stores the time of its own authorization, from before the supervisor call');
    assert.equal(credentials.until, stored() + 150_000);
    sup.requests.length = 0;
    await rb._internal.superviseWebSessions();
    assert.equal(sup.requests.find(r => r.op === 'renew').until, stored() + 150_000);
});

test('an authorization that has expired ends the session at renew and at attach', async () => {
    await reset();
    const renewed = await rb.createWebSession(USER, {}, '');
    sup.clock = () => Date.now() + 200_000;
    await rb._internal.superviseWebSessions();
    assert.equal(table.rows.get(renewed.sessionId).state, 'ended');
    assert.equal(table.rows.get(renewed.sessionId).end_code, rb.CODE.denied);
    assert.match(table.rows.get(renewed.sessionId).end_reason, /couldn't be verified/);
    sup.clock = () => Date.now();
    const attached = await rb.createWebSession(USER, {}, '');
    table.rows.get(attached.sessionId).last_auth_ok_at = new Date(Date.now() - 151_000);
    const c = connect(attached.token);
    await c.closed;
    assert.match(errorOf(c.got).args[0], /couldn't be verified/);
    assert.equal(table.rows.get(attached.sessionId).state, 'ended');
    assert.ok(sup.tombstones.has(attached.sessionId));
});

test('a record from an earlier holder of the uid becomes a gap, and one from after the start the supervisor reports is attributed', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    recorded.length = 0;
    const uid = table.rows.get(out.sessionId).uid;
    const startedAt = sup.sessions.get(out.sessionId).startedAt;
    rb._internal.resetForTest();
    await rb._internal.refreshUidMap();
    const record = (at, port) => JSON.stringify({ timestamp: ulogdTime(at), 'oob.uid': uid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: port, dest_ip: '93.184.215.14', dest_port: 443 });
    rb._internal.handleRecord(record(startedAt - 10_000, 44000));
    rb._internal.handleRecord(record(startedAt + 1_000, 44001));
    await rb._internal.eventsIdleForTest();
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    await rb._internal.eventsIdleForTest();
    const conns = recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'connection');
    assert.deepEqual(conns.map(e => e.meta.source_addr), ['100.92.0.7:44001']);
    const gaps = recorded.filter(e => e.remoteAccess && e.remoteAccess.kind === 'gap');
    assert.deepEqual(gaps.map(e => e.remoteAccess.missed), [1]);
    assert.equal(gaps[0].remoteAccess.sessionId, undefined, 'never given to the session');
    await rb._internal.closeConnectionsForTest();
});

test('a failed event write does not use the quota, and the same connection is recorded when it comes again', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    recorded.length = 0;
    const uid = table.rows.get(out.sessionId).uid;
    const record = JSON.stringify({ 'oob.uid': uid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: 45000, dest_ip: '93.184.215.14', dest_port: 443 });
    failingWrites = 1;
    rb._internal.handleRecord(record);
    await rb._internal.eventsIdleForTest();
    assert.equal(table.rows.get(out.sessionId).conn_count, 0);
    rb._internal.handleRecord(record);
    await rb._internal.eventsIdleForTest();
    assert.equal(table.rows.get(out.sessionId).conn_count, 1);
    assert.equal(recorded.filter(e => e.remoteAccess.kind === 'connection').length, 1);
    await rb._internal.closeConnectionsForTest();
});

test('a flood of connection records with a slow database stays bounded and ends in one gap record per session', async () => {
    await reset();
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push((await rb.createWebSession(USER, {}, '')).sessionId);
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    recorded.length = 0;
    connectGate = gate();
    for (const id of sessions) {
        const uid = table.rows.get(id).uid;
        for (let port = 1; port <= 3000; port++) {
            rb._internal.handleRecord(JSON.stringify({ 'oob.uid': uid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: port, dest_ip: '93.184.215.14', dest_port: 443 }));
        }
    }
    assert.equal(rb._internal.queuedForTest(), 5000);
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    assert.equal(rb._internal.queuedForTest(), 5000, 'gap records wait for room instead of passing the budget');
    connectGate.open();
    connectGate = null;
    await until(async () => { await rb._internal.eventsIdleForTest(); return rb._internal.queuedForTest() === 0; }, 20_000);
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    await rb._internal.eventsIdleForTest();
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    await rb._internal.eventsIdleForTest();
    assert.equal(recorded.filter(e => e.remoteAccess.kind === 'connection').length, 4000);
    const gaps = recorded.filter(e => e.remoteAccess.kind === 'gap');
    assert.deepEqual(gaps.filter(e => e.remoteAccess.missed).map(e => [e.remoteAccess.sessionId, e.remoteAccess.missed]), [[sessions[1], 1000], [sessions[2], 3000]],
        'one record per session with everything it missed, written once');
    assert.deepEqual(gaps.filter(e => !e.remoteAccess.missed).map(e => e.ID), [`web-gap:${sessions[0]}:cap`]);
    await rb._internal.closeConnectionsForTest();
});

test('the leader authorizes each user once per tick, and one slow stop does not hold back the renewals of the others', async () => {
    await reset();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await rb.createWebSession(USER, {}, '')).sessionId);
    let checks = 0;
    rb.setRemoteBrowserDeps({ stillPermitted: async () => { checks++; await sleep(50); return true; } });
    try {
        await rb._internal.superviseWebSessions();
    } finally {
        rb.setRemoteBrowserDeps({ stillPermitted: undefined });
    }
    assert.equal(checks, 1);
    const [slow] = ids;
    table.rows.get(slow).state = 'ending';
    sup.delays.set(`stop:${slow}`, 400);
    sup.requests.length = 0;
    const started = Date.now();
    await rb._internal.superviseWebSessions();
    const renews = sup.requests.filter(r => r.op === 'renew');
    assert.equal(renews.length, 3);
    assert.ok(renews.every(r => r.at - started < 300), 'the renewals did not wait for the slow stop');
    assert.equal(table.rows.get(slow).state, 'ended');
});

test('a late row-watch answer about an earlier tab never closes the tab that took over', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const first = connect(out.token);
    await first.opened;
    await until(() => table.rows.get(out.sessionId).state === 'active');
    let second;
    let attachment;
    queryHook = {
        match: /SELECT id, state, attachment, end_reason, end_code FROM browser_sessions/,
        run: async () => {
            const again = await rb.resumeWebSession(USER, out.sessionId, {});
            attachment = again.attachment;
            second = connect(again.token);
            await second.opened;
            await until(() => (rb._internal.attachedForTest(out.sessionId) || {}).attachment === attachment);
        },
    };
    await rb.watchAttached();
    await first.closed;
    await sleep(50);
    const current = rb._internal.attachedForTest(out.sessionId);
    assert.equal(current.attachment, attachment);
    assert.equal(current.closed, false);
    assert.equal(errorOf(second.got), undefined);
    second.ws.close();
    await second.closed;
});

test('the leader keeps the newest authorization time, and renews with the value stored on the row', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    const newer = new Date(Date.now() + 60_000);
    table.rows.get(out.sessionId).last_auth_ok_at = newer;
    sup.requests.length = 0;
    await rb._internal.superviseWebSessions();
    assert.equal(table.rows.get(out.sessionId).last_auth_ok_at.getTime(), newer.getTime(), 'a newer authorization is never overwritten');
    assert.equal(sup.requests.find(r => r.op === 'renew').until, newer.getTime() + 150_000);
});

test('a slow permission check for one user does not delay the renewals of other users', async () => {
    await reset();
    snapshot['/api/peers'].push({ id: 'laptop-2', name: 'Laptop 2', user_id: 'u2', groups: [{ id: 'g-staff' }], connected: false });
    snapshot['/api/groups'][1].peers.push({ id: 'laptop-2' });
    ra.invalidateSnapshot();
    const slow = await rb.createWebSession(USER, {}, '');
    const fast = [await rb.createWebSession(OTHER, {}, ''), await rb.createWebSession(OTHER, {}, '')];
    rb.setRemoteBrowserDeps({ stillPermitted: async ({ userId }) => { if (userId === 'u1') await sleep(300); return true; } });
    sup.requests.length = 0;
    const started = Date.now();
    try {
        await rb._internal.superviseWebSessions();
    } finally {
        rb.setRemoteBrowserDeps({ stillPermitted: undefined });
    }
    const renewedAt = (id) => sup.requests.find(r => r.op === 'renew' && r.session === id).at - started;
    for (const out of fast) assert.ok(renewedAt(out.sessionId) < 200, 'renewed as soon as its own check passed');
    assert.ok(renewedAt(slow.sessionId) >= 300);
});

test('the per-tick permission cache is keyed by the NetBird user and the signed-in identity', async () => {
    await reset();
    const first = await rb.createWebSession(USER, {}, '');
    const second = await rb.createWebSession({ ...USER, oid: 'oid-2', email: 'second@example.com' }, {}, '');
    const asked = [];
    rb.setRemoteBrowserDeps({ stillPermitted: async ({ oid }) => { asked.push(oid); return oid === 'oid-1'; } });
    try {
        await rb._internal.superviseWebSessions();
    } finally {
        rb.setRemoteBrowserDeps({ stillPermitted: undefined });
    }
    assert.deepEqual(asked.sort(), ['oid-1', 'oid-2']);
    assert.equal(table.rows.get(first.sessionId).state, 'detached');
    assert.equal(table.rows.get(second.sessionId).state, 'ended');
    assert.equal(table.rows.get(second.sessionId).end_code, rb.CODE.denied);
});

test('a tunnel whose attachment was replaced before guacd connects is closed as moved and never connects', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    onSelect = () => { table.rows.get(out.sessionId).attachment = 'another-tab'; };
    const c = connect(out.token);
    await c.closed;
    const err = errorOf(c.got);
    assert.equal(err.args[0], 'Your browser was opened in another window.');
    assert.equal(Number(err.args[1]), 0x0205);
    assert.ok(!guacdSeen.some(i => i.opcode === 'connect'));
});

test('a record from an unknown uid refreshes the map from the supervisor at most once per 5 s', async () => {
    await reset();
    await rb.createWebSession(USER, {}, '');
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    sup.requests.length = 0;
    const unknown = (port) => JSON.stringify({ 'oob.uid': 62555, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: port, dest_ip: '1.1.1.1', dest_port: 443 });
    rb._internal.handleRecord(unknown(1));
    rb._internal.handleRecord(unknown(2));
    await until(() => sup.requests.some(r => r.op === 'list'));
    await sleep(30);
    rb._internal.handleRecord(unknown(3));
    await sleep(30);
    assert.equal(sup.requests.filter(r => r.op === 'list').length, 1);
    recorded.length = 0;
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    await rb._internal.eventsIdleForTest();
    assert.deepEqual(recorded.map(e => e.remoteAccess.missed), [3]);
    await rb._internal.closeConnectionsForTest();
});

test('records that arrive while the browser starts are held, then given to the new session; unmatched or older ones become a gap', async () => {
    await reset();
    assert.equal(await rb._internal.bindConnections(), true);
    await rb._internal.eventsIdleForTest();
    recorded.length = 0;
    const uid = sup.nextUid;
    sup.delays.set('start:*', 150);
    const opening = rb.createWebSession(USER, {}, '');
    await until(() => sup.requests.some(r => r.op === 'start'));
    const startedAt = sup.requests.find(r => r.op === 'start').at;
    const record = (at, port, recordUid = uid) => JSON.stringify({ timestamp: ulogdTime(at), 'oob.uid': recordUid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: port, dest_ip: '93.184.215.14', dest_port: 443 });
    rb._internal.handleRecord(record(startedAt + 10, 46000));
    rb._internal.handleRecord(record(startedAt - 10_000, 46001));
    rb._internal.handleRecord(record(startedAt + 10, 46002, 62888));
    assert.equal(rb._internal.queuedForTest(), 3, 'held records use the write budget');
    const out = await opening;
    await rb._internal.eventsIdleForTest();
    rb._internal.releaseHeldForTest(Date.now() + 6_000);
    rb._internal.flushMissedForTest();
    await rb._internal.eventsIdleForTest();
    const conns = recorded.filter(e => e.remoteAccess.kind === 'connection');
    assert.deepEqual(conns.map(e => [e.remoteAccess.sessionId, e.meta.source_addr]), [[out.sessionId, '100.92.0.7:46000']]);
    assert.deepEqual(recorded.filter(e => e.remoteAccess.kind === 'gap').map(e => [e.remoteAccess.sessionId, e.remoteAccess.missed]), [[undefined, 2]]);
    assert.equal(rb._internal.queuedForTest(), 0);
    await rb._internal.closeConnectionsForTest();
});
