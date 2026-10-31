// SSO is all or nothing: setting any OIDC_* variable requires the other two and BASE_URL, and
// the server refuses to start without them. No OIDC_* at all (BASE_URL alone included) is the
// open mode and still starts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const SSO_VARS = ['OIDC_ISSUER_BASE_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'BASE_URL'];
const FULL = {
    OIDC_ISSUER_BASE_URL: 'https://login.example.com/tenant/v2.0',
    OIDC_CLIENT_ID: 'client-id',
    OIDC_CLIENT_SECRET: 'client-secret',
    BASE_URL: 'https://logs.example.com',
};
const only = (...keys) => Object.fromEntries(keys.map((k) => [k, FULL[k]]));

test('missing SSO settings: none when SSO is off or fully configured', () => {
    const { missingSsoSettings } = require('../lib/sso-config');
    assert.deepEqual(missingSsoSettings({}), []);
    assert.deepEqual(missingSsoSettings({ OIDC_ISSUER_BASE_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', BASE_URL: '' }), []);
    assert.deepEqual(missingSsoSettings(only('BASE_URL')), []);
    assert.deepEqual(missingSsoSettings(FULL), []);
});

test('missing SSO settings: any OIDC_* variable requires the rest and BASE_URL', () => {
    const { missingSsoSettings } = require('../lib/sso-config');
    assert.deepEqual(missingSsoSettings(only('OIDC_ISSUER_BASE_URL')), ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'BASE_URL']);
    assert.deepEqual(missingSsoSettings(only('OIDC_CLIENT_ID')), ['OIDC_ISSUER_BASE_URL', 'OIDC_CLIENT_SECRET', 'BASE_URL']);
    assert.deepEqual(missingSsoSettings(only('OIDC_CLIENT_SECRET')), ['OIDC_ISSUER_BASE_URL', 'OIDC_CLIENT_ID', 'BASE_URL']);
    assert.deepEqual(missingSsoSettings(only('OIDC_ISSUER_BASE_URL', 'OIDC_CLIENT_ID')), ['OIDC_CLIENT_SECRET', 'BASE_URL']);
    assert.deepEqual(missingSsoSettings({ ...FULL, BASE_URL: '' }), ['BASE_URL']);
    // A whitespace-only value counts as set, as it does for turning SSO on.
    assert.deepEqual(missingSsoSettings({ OIDC_CLIENT_ID: ' ' }), ['OIDC_ISSUER_BASE_URL', 'OIDC_CLIENT_SECRET', 'BASE_URL']);
});

test('the server refuses to start when SSO is only partly configured', async () => {
    // A database stub that drops every connection: startup must stop before it is reached.
    const deadDb = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => deadDb.listen(0, '127.0.0.1', resolve));
    let child, timer;
    try {
        // Every SSO variable is set (empty counts), so a local .env can't fill one in.
        const env = { ...process.env, ...Object.fromEntries(SSO_VARS.map((k) => [k, ''])) };
        Object.assign(env, only('OIDC_ISSUER_BASE_URL', 'OIDC_CLIENT_ID'), {
            PORT: '0', DB_HOST: '127.0.0.1', DB_PORT: String(deadDb.address().port),
            NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '',
            DOTENV_OVERRIDE: 'false', DOTENV_CONFIG_OVERRIDE: 'false',
        });
        child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        timer = setTimeout(() => child.kill(), 15000);
        const code = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
        });
        assert.equal(code, 1);
        assert.match(stderr, /SSO is partially configured: set OIDC_CLIENT_SECRET, BASE_URL/);
    } finally {
        clearTimeout(timer);
        if (child && child.exitCode === null) child.kill();
        await new Promise((resolve) => deadDb.close(resolve));
    }
});
