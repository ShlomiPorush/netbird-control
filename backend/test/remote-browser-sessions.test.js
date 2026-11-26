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
core.pool.query = async (sql, params) => {
    const r = table.query(sql, params);
    if (r) return r;
    if (/INSERT INTO app_settings/.test(sql)) { if (!(params[0] in settings)) settings[params[0]] = params[1]; return { rows: [], rowCount: 1 }; }
    return { rows: [] };
};
core.pool.connect = table.connect;

const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
let snapshot = {};
nb.netbirdGet = async (p) => JSON.parse(JSON.stringify(snapshot[p] ?? null));

const events = require('../lib/events');
const recorded = [];
events.addEvent = async (e) => { recorded.push(JSON.parse(JSON.stringify(e))); };

const ra = require('../lib/remote-access');
const rb = require('../lib/remote-browser');
const { encodeInstruction, GuacParser } = ra._internal;
const { WebSocketServer, WebSocket } = require('ws');

const socketPath = (name) => (process.platform === 'win32'
    ? `\\\\.\\pipe\\nbc-test-${name}-${crypto.randomBytes(6).toString('hex')}`
    : path.join(os.tmpdir(), `nbc-test-${name}-${crypto.randomBytes(6).toString('hex')}.sock`));

const sup = { sessions: new Map(), tombstones: new Set(), requests: [], nextUid: 62000, failStop: false, renewAnswer: null, table7120: ['default dev wt0'], down: false };
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
            sup.requests.push(req);
            if (sup.down) { sock.destroy(); return; }
            sock.write(JSON.stringify(answer(req)) + '\n');
        }
    });
});
function answer(req) {
    switch (req.op) {
        case 'start': {
            if (!Number.isInteger(req.width) || !Number.isInteger(req.height) || !Number.isInteger(req.dpi) || typeof req.terminal !== 'boolean') return { ok: false, error: 'BAD_REQUEST' };
            if (req.terminal) return { ok: false, error: 'TERMINAL' };
            if (sup.tombstones.has(req.session)) return { ok: false, error: 'ENDED' };
            if (!sup.sessions.has(req.session)) {
                const uid = sup.nextUid++;
                sup.sessions.set(req.session, { uid, port: 5901 + uid - 62000, password: crypto.randomBytes(4).toString('hex') });
            }
            const s = sup.sessions.get(req.session);
            return { ok: true, port: s.port, password: s.password, uid: s.uid };
        }
        case 'renew':
            if (sup.renewAnswer) return sup.renewAnswer;
            if (sup.sessions.has(req.session)) return { ok: true };
            return { ok: false, error: sup.tombstones.has(req.session) ? 'ENDED' : 'UNKNOWN' };
        case 'stop':
            if (sup.failStop) return { ok: false, error: 'STOP_FAILED' };
            sup.tombstones.add(req.session);
            sup.sessions.delete(req.session);
            return { ok: true, state: 'stopped' };
        case 'list':
            return { ok: true, sessions: [...sup.sessions].map(([session, s]) => ({ session, state: 'running', uid: s.uid, port: s.port, startedAt: Date.now() })) };
        case 'ready':
            return { ok: true, netns: 4026532001, gateway: { ts: Math.floor(Date.now() / 1000), netns: 4026532001, wt0: '100.92.0.7', lock: true, table7120: ['default dev wt0'] }, table7120: sup.table7120 };
        default:
            return { ok: false, error: 'BAD_REQUEST' };
    }
}

let guacdSeen = [];
let guacdNoDisplay = false;
const guacdSockets = [];
const guacd = net.createServer((sock) => {
    guacdSockets.push(sock);
    sock.on('error', () => { });
    const parser = new GuacParser(1 << 20);
    sock.on('data', (d) => {
        for (const ins of parser.push(d.toString('utf8'))) {
            guacdSeen.push(ins);
            if (ins.opcode === 'select') sock.write(encodeInstruction('args', 'VERSION_1_5_0', 'hostname', 'port', 'password', 'color-depth', 'disable-copy', 'disable-paste', 'enable-sftp', 'enable-audio', 'disable-display-resize', 'clipboard-encoding'));
            if (ins.opcode === 'connect') sock.write(encodeInstruction('ready', '$vnc-1') + (guacdNoDisplay ? encodeInstruction('nop') + encodeInstruction('error', 'Aborted. See logs.', '519') : encodeInstruction('size', '0', '1280', '720')));
        }
    });
});

const httpServer = http.createServer();
const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
    const entry = rb.takeToken(new URL(req.url, 'http://x').searchParams.get('token'));
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
    Object.assign(sup, { requests: [], failStop: false, renewAnswer: null, table7120: ['default dev wt0'], down: false });
    sup.sessions.clear();
    sup.tombstones.clear();
    for (const k of Object.keys(settings)) delete settings[k];
    settings.remote_access_nb = JSON.stringify(WEB_IDS);
    settings.remote_access_web_peer = JSON.stringify({ id: 'web-gw', ip: '100.92.0.7' });
    ra._internal.setManagedForTest(WEB_IDS);
    ra._internal.setConfigForTest({
        enabled: true, browserGuacdHost: '127.0.0.1', browserGuacdPort: guacd.address().port,
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
    rb._internal.setPathsForTest(paths);
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

test('a web session opens without any target: checks, a slot, the supervisor, a start record and a token', async () => {
    await reset();
    const out = await rb.createWebSession(USER, { protocol: 'web', width: 2560, height: 1440, dpi: 144, timezone: 'Asia/Jerusalem' }, '198.51.100.9');
    assert.equal(out.protocol, 'web');
    assert.match(out.token, /^[A-Za-z0-9_-]{43}$/);
    const start = sup.requests.find(r => r.op === 'start');
    assert.deepEqual(start, { op: 'start', session: out.sessionId, width: 1920, height: 1080, dpi: 144, terminal: false });
    const row = table.rows.get(out.sessionId);
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
    assert.equal(rb.takeToken(out.token), null, 'a token is used once');
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
    assert.equal(sup.requests.filter(r => r.op === 'start').length, 3, 'the password comes from the supervisor again');
    assert.equal(await rb.endWebSessionByUser(USER, out.sessionId), true);
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
    assert.equal(await rb.renewWebLease(USER, out.sessionId), true);
    assert.equal(row.detached_at, detachedAt);
    assert.equal(row.lease_expires_at, null);
    assert.equal(await rb.renewWebLease(OTHER, out.sessionId), false);
});

test('the leader loop renews, detaches an expired viewer lease, ends after the keep-alive, after lost verification, and when the browser closed', async () => {
    await reset({ keepAliveMin: 15 });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await rb.createWebSession(USER, {}, '')).sessionId);
    const [renewed, leaseGone, keepAliveGone, unverified] = ids.map(id => table.rows.get(id));
    Object.assign(leaseGone, { state: 'active', lease_expires_at: new Date(Date.now() - 1000), detached_at: null });
    keepAliveGone.detached_at = new Date(Date.now() - 16 * 60_000);
    unverified.last_auth_ok_at = new Date(Date.now() - 151_000);
    await rb._internal.maintainWebSessions();
    assert.equal(renewed.state, 'detached');
    assert.ok(sup.requests.some(r => r.op === 'renew' && r.session === renewed.id));
    assert.equal(leaseGone.state, 'detached');
    assert.equal(keepAliveGone.state, 'ended');
    assert.equal(keepAliveGone.end_reason, 'The session ended after 15 minutes without a connection.');
    assert.equal(unverified.state, 'ended');
    assert.equal(unverified.end_code, rb.CODE.denied);
    sup.sessions.delete(renewed.id);
    await rb._internal.maintainWebSessions();
    assert.equal(renewed.state, 'ended');
    assert.equal(renewed.end_reason, 'The browser was closed.');
});

test('a stop that fails keeps the slot until a later stop succeeds', async () => {
    await reset({ maxSessions: 1 });
    const out = await rb.createWebSession(USER, {}, '');
    sup.failStop = true;
    assert.equal(await rb.endWebSessionByUser(USER, out.sessionId), true);
    assert.equal(table.rows.get(out.sessionId).state, 'ending');
    await rejects(rb.createWebSession(USER, {}, ''), 429, 'BROWSER_CAPACITY');
    sup.failStop = false;
    await rb._internal.maintainWebSessions();
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
    assert.equal(recorded.filter(e => e.Message === 'TYPE_END').length, 1);
});

test('a start the supervisor did not answer is stopped, so no browser is left behind', async () => {
    await reset();
    sup.down = true;
    await rejects(rb.createWebSession(USER, {}, ''), 503, 'GATEWAY_NOT_READY');
    sup.down = false;
    const realStart = answer;
    let dropped = false;
    supervisor.removeAllListeners('connection');
    supervisor.on('connection', (sock) => {
        sock.setEncoding('utf8');
        sock.on('error', () => { });
        sock.on('data', (chunk) => {
            for (const line of chunk.split('\n').filter(Boolean)) {
                const req = JSON.parse(line);
                sup.requests.push(req);
                const reply = realStart(req);
                if (req.op === 'start' && !dropped) { dropped = true; sock.destroy(); continue; }
                sock.write(JSON.stringify(reply) + '\n');
            }
        });
    });
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
    await rb._internal.recheckWebSessions();
    assert.ok(Date.now() - table.rows.get(out.sessionId).last_auth_ok_at < 5000);
    snapshot['/api/peers'][0].login_expired = true;
    await rb._internal.recheckWebSessions();
    assert.equal(table.rows.get(out.sessionId).state, 'ended');
    assert.equal(table.rows.get(out.sessionId).end_code, 0x0303);
});

test('the re-check stops every web session when the gate closes', async () => {
    await reset();
    const out = await rb.createWebSession(USER, {}, '');
    snapshot['/api/groups'][3].peers.push({ id: 'laptop' });
    await rb._internal.recheckWebSessions();
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
    const line = (o) => JSON.stringify({ timestamp: '2026-11-26T10:00:00', 'oob.uid': o.uid, 'ip.protocol': o.p || 6, src_ip: '100.92.0.7', src_port: o.sp || 40000, dest_ip: o.ip || '93.184.215.14', dest_port: o.dp || 443 }) + '\n';
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
    await rb._internal.maintainWebSessions();
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
    for (let i = 0; i < cap + 5; i++) {
        rb._internal.handleRecord(JSON.stringify({ 'oob.uid': uid, 'ip.protocol': 6, src_ip: '100.92.0.7', src_port: 10000 + i, dest_ip: '93.184.215.14', dest_port: 443 }));
    }
    await rb._internal.eventsIdleForTest();
    assert.equal(recorded.filter(e => e.remoteAccess.kind === 'connection').length, cap);
    const gaps = recorded.filter(e => e.remoteAccess.kind === 'gap');
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].remoteAccess.reason, /not recorded/);
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
