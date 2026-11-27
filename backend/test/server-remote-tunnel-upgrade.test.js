const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { WebSocket } = require('ws');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const deadDb = net.createServer((socket) => socket.destroy());
const appServer = http.createServer();
let port = 0;
let encodeInstruction;
const origError = console.error;

before(async () => {
    const dbPort = await listen(deadDb);
    port = await listen(appServer);
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', BASE_URL: '',
        TRUST_PROXY: '', WEBHOOK_AUTH_TOKEN: '',
        DB_HOST: '127.0.0.1', DB_PORT: String(dbPort),
        NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '',
    });
    console.error = () => { };
    const server = require('../server');
    ({ encodeInstruction } = require('../lib/remote-access'));
    appServer.on('upgrade', server.handleRemoteUpgrade);
});

after(async () => {
    console.error = origError;
    for (const s of [appServer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

const unknownToken = () => crypto.randomBytes(32).toString('base64url');

test('a tunnel with a token this instance does not know is refused in the Guacamole protocol, with a message to connect again', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote-access/tunnel?token=${unknownToken()}`, 'guacamole', { origin: `http://127.0.0.1:${port}` });
    const msgs = [];
    ws.on('message', (d) => msgs.push(d.toString('utf8')));
    const closed = await new Promise((resolve, reject) => {
        ws.on('close', (code) => resolve(code));
        ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
        ws.on('error', reject);
    });
    assert.deepEqual(msgs, [encodeInstruction('error', 'This session is no longer available. Connect again.', String(0x0205))]);
    assert.equal(closed, 1005);
});

test('a refused tunnel whose browser sends a broken frame does not stop the server', async () => {
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    const unmasked = Buffer.from([0x81, 0x02, 0x68, 0x69]);
    sock.write([
        `GET /api/remote-access/tunnel?token=${unknownToken()} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`,
        'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: guacamole',
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, '', '',
    ].join('\r\n'));
    sock.write(unmasked);
    let answer = '';
    sock.on('data', (d) => { answer += d.toString('latin1'); });
    sock.on('error', () => { });
    await new Promise((r) => sock.on('close', r));
    assert.match(answer, /^HTTP\/1\.1 101 /);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote-access/tunnel?token=${unknownToken()}`, 'guacamole', { origin: `http://127.0.0.1:${port}` });
    const code = await new Promise((resolve, reject) => { ws.on('close', resolve); ws.on('error', reject); });
    assert.equal(code, 1005, 'the server still answers');
});
