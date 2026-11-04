// The database password has no default: the server refuses to start without DB_PASSWORD, or with
// the public example value older .env.example files shipped, before it connects to the database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { dbPasswordProblem, DB_PASSWORD_PLACEHOLDER } = require('../lib/db-config');

const NOT_SET = /DB_PASSWORD is not set\. Set it in \.env/;
const PLACEHOLDER = /DB_PASSWORD is still the example value change-me-to-a-strong-password, which is public/;
const randomPassword = () => crypto.randomBytes(32).toString('hex');

test('DB password: missing, empty and the example value are refused', () => {
    assert.match(dbPasswordProblem({}), NOT_SET);
    assert.match(dbPasswordProblem({ DB_PASSWORD: '' }), NOT_SET);
    assert.match(dbPasswordProblem({ DB_PASSWORD: DB_PASSWORD_PLACEHOLDER }), PLACEHOLDER);
});

test('DB password: any other value is used as it is', () => {
    // Exact comparison only: a value that worked before keeps working.
    assert.equal(dbPasswordProblem({ DB_PASSWORD: ' ' }), null);
    assert.equal(dbPasswordProblem({ DB_PASSWORD: ` ${DB_PASSWORD_PLACEHOLDER} ` }), null);
    assert.equal(dbPasswordProblem({ DB_PASSWORD: randomPassword() }), null);
});

// Starts server.js against a database stub that counts and drops every connection, and returns the
// exit code, stderr and how many connections reached the stub.
async function startServer(dbPassword) {
    let connections = 0;
    const stub = net.createServer((socket) => { connections++; socket.destroy(); });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    let child, timer;
    try {
        const env = {
            ...process.env,
            // Every variable is set (empty counts), so a local .env can't fill one in.
            OIDC_ISSUER_BASE_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', BASE_URL: '',
            NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '', NETBIRD_READONLY: 'true',
            PORT: '0', DB_HOST: '127.0.0.1', DB_PORT: String(stub.address().port),
            DB_PASSWORD: dbPassword,
            DOTENV_OVERRIDE: 'false', DOTENV_CONFIG_OVERRIDE: 'false',
        };
        child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        timer = setTimeout(() => child.kill(), 15000);
        const code = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
        });
        return { code, stderr, connections };
    } finally {
        clearTimeout(timer);
        if (child && child.exitCode === null) child.kill();
        await new Promise((resolve) => stub.close(resolve));
    }
}

test('the server refuses to start without DB_PASSWORD and never connects', async () => {
    const r = await startServer('');
    assert.equal(r.code, 1);
    assert.match(r.stderr, NOT_SET);
    assert.equal(r.connections, 0);
});

test('the server refuses to start with the example DB_PASSWORD and never connects', async () => {
    const r = await startServer(DB_PASSWORD_PLACEHOLDER);
    assert.equal(r.code, 1);
    assert.match(r.stderr, PLACEHOLDER);
    assert.equal(r.connections, 0);
});

test('with DB_PASSWORD set, the server goes on to connect to the database', async () => {
    const pw = randomPassword();
    const r = await startServer(pw);
    assert.ok(r.connections >= 1, 'the server should have tried the database');
    assert.doesNotMatch(r.stderr, NOT_SET);
    assert.doesNotMatch(r.stderr, PLACEHOLDER);
    assert.ok(!r.stderr.includes(pw), 'the password must not be logged');
});
