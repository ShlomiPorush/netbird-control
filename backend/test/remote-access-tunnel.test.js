// End-to-end tunnel behaviour against a fake guacd: the one-time token, the guacd handshake with
// target and credentials taken only from the server-side session, the Guacamole WebSocket
// tunnel's internal channel (UUID first, ping echoed), input forwarding, and session records that
// never carry credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');

// ─── Stubs, before lib/remote-access.js destructures them ───
const core = require('../lib/core');
const settings = {};
core.getSetting = async (k) => settings[k] || null;
core.setSetting = async (k, v) => { settings[k] = v; };
const queries = [];
const order = []; // DB writes and event records, in the order they happened
core.pool.query = async (sql, params) => { queries.push({ sql, params }); order.push(sql.trim().split(/\s+/)[0] + ':' + (/remote_sessions/.test(sql) ? 'remote_sessions' : '')); return { rows: [] }; };

const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
const snapshot = {
    '/api/users': [{ id: 'u1', auto_groups: ['g-staff'], is_blocked: false }, { id: 'u2', auto_groups: ['g-staff'], is_blocked: false }],
    '/api/peers': [{ id: 'p-gw', name: 'gw', groups: [{ id: 'g-gw' }], connected: true }, { id: 'p-ngw', name: 'ngw', groups: [{ id: 'g-ngw' }], connected: true }, { id: 'p-r', name: 'r', groups: [], connected: true }],
    '/api/groups': [{ id: 'g-all', name: 'All' }, { id: 'g-gw', name: 'Browser Gateway' }, { id: 'g-gwt', name: 'Browser Gateway Targets' }, { id: 'g-ngw', name: 'Browser Gateway Names' }, { id: 'g-ngwt', name: 'Browser Gateway Name Targets' }, { id: 'g-staff', name: 'Staff' }],
    '/api/policies': [
        { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
        { id: 'pol-ssh', name: 'Staff SSH', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['22'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-gwt' }] }] },
        { id: 'pol-ngw', name: 'Browser Gateway (Names)', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-ngw' }], destinations: [{ id: 'g-ngwt' }] }] },
        { id: 'pol-web', name: 'Staff Web SSH', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['22'], sources: [{ id: 'g-staff' }], destinations: [], destinationResource: { id: 'r-dom', type: 'domain' } }] },
    ],
    '/api/networks/resources': [
        { id: 'r1', name: 'srv1', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-gwt' }] },
        { id: 'r-dom', name: 'Safe', type: 'domain', address: 'mosessafe.com', enabled: true, groups: [{ id: 'g-ngwt' }] },
    ],
    '/api/networks': [{ id: 'n1', name: 'Office', resources: ['r1', 'r-dom'] }],
    '/api/routes': [],
    '/api/networks/n1/routers': [{ peer: 'p-r', enabled: true }],
};
nb.netbirdGet = async (p) => JSON.parse(JSON.stringify(snapshot[p] ?? null));

const events = require('../lib/events');
const recorded = [];
let failEvents = false;
events.addEvent = async (e) => { if (failEvents) throw new Error('db down'); recorded.push(e); order.push('event:' + e.Message); };

const ra = require('../lib/remote-access');
const { encodeInstruction, GuacParser } = ra._internal;
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
// A fresh random value per run: it must reach guacd and must never appear in any record.
const SECRET = crypto.randomBytes(12).toString('base64url');

// ─── Fake guacd ───
let guacdSeen = [];
let guacdSockets = [];
const guacd = net.createServer((sock) => {
    guacdSockets.push(sock);
    const parser = new GuacParser(1 << 20);
    sock.on('data', (d) => {
        for (const ins of parser.push(d.toString('utf8'))) {
            guacdSeen.push(ins);
            if (ins.opcode === 'select') sock.write(encodeInstruction('args', 'VERSION_1_5_0', 'hostname', 'port', 'username', 'password', 'host-key'));
            if (ins.opcode === 'connect') sock.write(encodeInstruction('ready', '$conn-1') + encodeInstruction('name', 'srv1 ✓'));
        }
    });
});

// A second fake guacd, standing in for the names gateway's.
const namesSeen = [];
const guacdNames = net.createServer((sock) => {
    guacdSockets.push(sock);
    const parser = new GuacParser(1 << 20);
    sock.on('data', (d) => {
        for (const ins of parser.push(d.toString('utf8'))) {
            namesSeen.push(ins);
            if (ins.opcode === 'select') sock.write(encodeInstruction('args', 'VERSION_1_5_0', 'hostname', 'port', 'username', 'password', 'host-key'));
            if (ins.opcode === 'connect') sock.write(encodeInstruction('ready', '$conn-n'));
        }
    });
});

// ─── App side: upgrade -> takeToken -> attachTunnel (as server.js does) ───
const wss = new WebSocketServer({ noServer: true, maxPayload: ra.WS_MAX_PAYLOAD, handleProtocols: (p) => (p.has('guacamole') ? 'guacamole' : false) });
const app = http.createServer();
app.on('upgrade', (req, socket, head) => {
    const id = ra.takeToken(new URL(req.url, 'http://x').searchParams.get('token'));
    if (!id) { socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => ra.attachTunnel(id, ws));
});

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const viewer = { user_id: 'u1', email: 'alice@example.test', name: 'Alice', oid: 'oid-1', authEnabled: true };

test.before(async () => {
    const gport = await listen(guacd);
    const nport = await listen(guacdNames);
    settings.remote_access_config = JSON.stringify({ enabled: true, networks: ['n1'], guacdHost: '127.0.0.1', guacdPort: gport, namesGuacdHost: '127.0.0.1', namesGuacdPort: nport });
    settings.remote_access_nb = JSON.stringify({ gatewayGroupId: 'g-gw', targetGroupId: 'g-gwt', policyId: 'pol-gw', namesGroupId: 'g-ngw', namesTargetGroupId: 'g-ngwt', namesPolicyId: 'pol-ngw' });
    await ra.loadRemoteAccessConfig();
});
test.after(() => { ra.closeAllSessions('test over'); guacd.close(); guacdNames.close(); app.close(); for (const s of guacdSockets) s.destroy(); });

function open(port, token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote-access/tunnel?token=${encodeURIComponent(token)}`, 'guacamole');
        const msgs = [];
        ws.on('message', (d) => msgs.push(d.toString('utf8')));
        ws.on('open', () => resolve({ ws, msgs }));
        ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
        ws.on('error', reject);
    });
}
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('check reports both steps passing for an allowed target', async () => {
    const r = await ra.checkAccess(viewer, { protocol: 'ssh', address: '10.0.0.5', port: 22 });
    assert.deepEqual(r.steps.map(s => [s.key, s.status]), [['access', 'pass'], ['path', 'pass']]);
});

test('a denied target gets no session', async () => {
    await assert.rejects(ra.createSession(viewer, { protocol: 'rdp', address: '10.0.0.5', port: 3389 }, '203.0.113.9'), (e) => e.code === 'PORT_NOT_ALLOWED');
});

test('the tunnel: one-time token, handshake from the server-side record, internal ping, input', async () => {
    const port = await listen(app);
    const out = await ra.createSession(viewer, { protocol: 'ssh', address: '10.0.0.5', port: 22, username: 'alice', password: SECRET, width: 1024, height: 768 }, '203.0.113.9');
    assert.ok(out.token && out.sessionId);
    const { ws, msgs } = await open(port, out.token);

    // A second use of the same token is refused.
    await assert.rejects(open(port, out.token), /HTTP 401/);

    // Guacamole.WebSocketTunnel needs its UUID first, as an internal instruction.
    await waitFor(() => msgs.length >= 1);
    assert.equal(msgs[0], encodeInstruction('', out.sessionId));

    // guacd got the target and credentials from the session record, in its declared arg order.
    await waitFor(() => guacdSeen.some(i => i.opcode === 'connect'));
    assert.deepEqual(guacdSeen.find(i => i.opcode === 'select').args, ['ssh']);
    assert.deepEqual(guacdSeen.find(i => i.opcode === 'connect').args, ['VERSION_1_5_0', '10.0.0.5', '22', 'alice', SECRET, '']);
    assert.deepEqual(guacdSeen.find(i => i.opcode === 'size').args, ['1024', '768', '96']);

    // After "ready", guacd output reaches the browser (multi-byte text intact); "ready" itself does not.
    await waitFor(() => msgs.some(m => m.includes('4.name')));
    assert.ok(msgs.some(m => m === encodeInstruction('name', 'srv1 ✓')));
    assert.ok(!msgs.some(m => m.includes('5.ready')));

    // The internal ping is answered by the tunnel and never reaches guacd.
    const ping = encodeInstruction('', 'ping', '1700000000000');
    ws.send(ping);
    await waitFor(() => msgs.filter(m => m === ping).length === 1);

    // Input is forwarded; a handshake opcode from the browser is dropped.
    ws.send(encodeInstruction('key', '65', '1'));
    ws.send(encodeInstruction('connect', 'VERSION_1_5_0', '10.9.9.9', '22'));
    ws.send(encodeInstruction('size', '99999', '99999'));
    await waitFor(() => guacdSeen.some(i => i.opcode === 'key'));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(guacdSeen.filter(i => i.opcode === 'connect').length, 1, 'no second connect');
    assert.ok(!guacdSeen.some(i => i.opcode === 'size' && i.args[0] === '99999'), 'oversized display dropped');
    assert.ok(!guacdSeen.some(i => i.opcode === ''), 'internal instructions never reach guacd');

    // Closing records the end; no record ever carries the password.
    ws.close();
    await waitFor(() => recorded.some(e => e.Message === 'TYPE_END'));
    const start = recorded.find(e => e.Message === 'TYPE_START');
    const end = recorded.find(e => e.Message === 'TYPE_END');
    assert.equal(start.meta.source_type, 'BROWSER_GATEWAY');
    assert.equal(start.meta.user_id, 'u1');
    assert.equal(start.meta.flow_id, out.sessionId);
    assert.equal(end.meta.flow_id, out.sessionId);
    assert.notEqual(start.ID, end.ID);
    assert.equal(start.meta.rx_bytes, 0, 'bytes only on the end record');
    assert.ok(!JSON.stringify(recorded).includes(SECRET));
    assert.ok(!JSON.stringify(queries).includes(SECRET));
});

test('the live-state row is deleted only after the end record is written', async () => {
    const i = order.lastIndexOf('event:TYPE_END');
    const d = order.lastIndexOf('DELETE:remote_sessions');
    assert.ok(i >= 0 && d > i, 'end record first, then the row is removed');
});

test('a failed end record keeps the live-state row for the next start-up', async () => {
    const port = app.address().port;
    const out = await ra.createSession(viewer, { protocol: 'ssh', address: '10.0.0.5', port: 22, username: 'alice' }, '203.0.113.9');
    const { ws } = await open(port, out.token);
    await waitFor(() => guacdSeen.filter(x => x.opcode === 'connect').length >= 2);
    failEvents = true;
    const before = order.length;
    ws.close();
    await new Promise(r => setTimeout(r, 200));
    failEvents = false;
    assert.ok(!order.slice(before).includes('DELETE:remote_sessions'), 'the row stays when the end record fails');
});

test('a session is not created while no routing peer is online', async () => {
    // Routers are read live for every session request (not from the cached snapshot).
    const routers = snapshot['/api/networks/n1/routers'];
    snapshot['/api/networks/n1/routers'] = [{ peer: 'p-r', enabled: false }];
    try {
        await assert.rejects(ra.createSession(viewer, { protocol: 'ssh', address: '10.0.0.5', port: 22, username: 'alice' }, '203.0.113.9'), (e) => e.code === 'NO_ROUTER_ONLINE');
    } finally { snapshot['/api/networks/n1/routers'] = routers; }
});

test('an unknown token is refused', async () => {
    const port = app.address().port;
    await assert.rejects(open(port, 'nope'), /HTTP 401/);
});

test('turning the feature off closes sessions and voids pending tokens', async () => {
    const port = app.address().port;
    const out = await ra.createSession(viewer, { protocol: 'ssh', address: '10.0.0.5', port: 22, username: 'alice' }, '203.0.113.9');
    const { ws, msgs } = await open(port, out.token);
    const pending = await ra.createSession(viewer, { protocol: 'ssh', address: '10.0.0.5', port: 22, username: 'alice' }, '203.0.113.9');
    let closed = null;
    ws.on('close', (code, reason) => { closed = String(reason); });
    ra.closeAllSessions('Browser remote access was turned off by an administrator.');
    await waitFor(() => closed !== null);
    assert.ok(msgs.some(m => m.startsWith('5.error,') && m.includes('turned off')));
    assert.equal(closed, String(0x0303));
    await assert.rejects(open(port, pending.token), /HTTP 401/);
});

test('the re-check runs permission checks in parallel, once per user', async () => {
    const bob = { ...viewer, user_id: 'u2', email: 'bob@example.test', oid: 'oid-2' };
    const a1 = await ra.createSession(viewer, { protocol: 'ssh', address: '10.0.0.5', port: 22, username: 'alice' }, '203.0.113.9');
    const a2 = await ra.createSession(viewer, { protocol: 'ssh', address: '10.0.0.5', port: 22, username: 'alice' }, '203.0.113.9');
    const b1 = await ra.createSession(bob, { protocol: 'ssh', address: '10.0.0.5', port: 22, username: 'bob' }, '203.0.113.10');
    const calls = [];
    let slowDone = 0;
    ra.setRemoteAccessDeps({
        stillPermitted: async ({ userId }) => {
            calls.push({ userId, at: Date.now(), slowDoneBefore: slowDone });
            if (userId === 'u1') { await new Promise(r => setTimeout(r, 400)); slowDone = Date.now(); return false; }
            return true;
        },
    });
    try {
        await ra.recheckSessions();
        assert.equal(calls.filter(c => c.userId === 'u1').length, 1, 'one check per user per cycle');
        const bobCall = calls.find(c => c.userId === 'u2');
        assert.ok(bobCall && bobCall.slowDoneBefore === 0, "bob's check did not wait for alice's slow one");
        assert.equal(ra.renewLease(bob, b1.sessionId), true, 'bob keeps his session');
        assert.equal(ra.renewLease(viewer, a1.sessionId), false, "alice's sessions closed");
        assert.equal(ra.renewLease(viewer, a2.sessionId), false);
    } finally {
        ra.setRemoteAccessDeps({ stillPermitted: undefined });
        ra.closeAllSessions('test over');
    }
});

test('the parser handles split chunks and surrogate pairs', () => {
    const p = new GuacParser(1024);
    const full = encodeInstruction('name', 'a😀b') + encodeInstruction('nop');
    const parts = [full.slice(0, 3), full.slice(3, 9), full.slice(9)];
    const got = parts.flatMap(x => p.push(x));
    assert.deepEqual(got.map(i => [i.opcode, i.args]), [['name', ['a😀b']], ['nop', []]]);
    assert.throws(() => new GuacParser(1024).push('x.nop;'), /malformed/);
    assert.throws(() => new GuacParser(10).push('99.'), /too large/);
});

test('a domain resource name opens on the names gateway, with an absolute name for guacd', async () => {
    const port = app.address().port;
    const out = await ra.createSession(viewer, { protocol: 'ssh', address: 'MosesSafe.com', port: 22, username: 'alice', password: SECRET }, '203.0.113.9');
    assert.equal(out.gateway, 'names');
    assert.equal(out.address, 'mosessafe.com');
    const before = guacdSeen.length;
    const { ws } = await open(port, out.token);
    await waitFor(() => namesSeen.some(i => i.opcode === 'connect'));
    assert.deepEqual(namesSeen.find(i => i.opcode === 'connect').args.slice(0, 3), ['VERSION_1_5_0', 'mosessafe.com.', '22']);
    assert.equal(guacdSeen.length, before, 'the IP gateway was not used');
    const insert = queries.find(q => /INSERT INTO remote_sessions/.test(q.sql) && q.params[0] === out.sessionId);
    assert.equal(insert.params[6], 'mosessafe.com');
    assert.equal(insert.params[12], 'mosessafe.com');
    assert.equal(insert.params[13], 'names');
    ws.close();
});
