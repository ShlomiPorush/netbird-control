// The real server.js stack with SSO on, against a stub OpenID provider and stubbed database and
// NetBird lookups. It pins down that the Admin Session Cap (default 2 h) also applies to a
// Tenant Support user while they manage a tenant with admin rights, and that it does not cut
// their regular use of the main account short (that stays under the User Session Cap, 6 h).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const CLIENT_ID = 'test-client';
const TENANT = 'tenant-1';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ── Stub OpenID provider: discovery, JWKS and a token endpoint that issues RS256 ID tokens ──
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const codes = new Map(); // authorization code → ID token claims
let ISSUER = '';
const issuer = http.createServer((req, res) => {
    const send = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url === '/.well-known/openid-configuration') {
        return send({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
        });
    }
    if (req.url === '/jwks') return send({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    if (req.url === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const claims = codes.get(new URLSearchParams(body).get('code'));
            if (!claims) { res.statusCode = 400; return send({ error: 'invalid_grant' }); }
            const input = `${b64url({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64url(claims)}`;
            const idToken = `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
            send({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
        });
        return;
    }
    res.statusCode = 404;
    res.end();
});

const deadDb = net.createServer((socket) => socket.destroy());
const appServer = http.createServer();
let BASE = '';
const origError = console.error;

// Viewer lookups: `admin-*` subjects are NetBird admins, `support-*` subjects hold Tenant Support.
const failViewerLookupOnce = new Set(); // subjects whose next viewer lookup fails (a transient DB error)
let policyReads = 0;

before(async () => {
    ISSUER = `http://127.0.0.1:${await listen(issuer)}`;
    const dbPort = await listen(deadDb);
    BASE = `http://127.0.0.1:${await listen(appServer)}`;
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: ISSUER,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: 'test-secret',
        BASE_URL: BASE,
        SESSION_SECRET: 'a-fixed-test-session-secret-0123456789',
        TRUST_PROXY: 'loopback',
        DB_HOST: '127.0.0.1',
        DB_PORT: String(dbPort),
        NETBIRD_API_URL: '',
        NETBIRD_API_TOKEN: '',
    });
    console.error = () => { }; // DB-stub failures are expected
    // server.js reads these from the db module when it loads, so replace them first.
    const db = require('../db');
    const subOf = (oid) => String(oid);
    db.resolveViewer = async (oid) => {
        const sub = subOf(oid);
        if (failViewerLookupOnce.delete(sub)) throw new Error('connection terminated');
        return { user_id: sub, email: `${sub}@example.com`, name: sub, role: sub.startsWith('admin-') ? 'admin' : 'user', auto_groups: [] };
    };
    const realPerms = db.resolveFeaturePerms;
    db.resolveFeaturePerms = (args) => {
        const out = realPerms(args);
        if (String(args.userId || '').startsWith('support-')) out['tenants.support'] = true;
        return out;
    };
    db.isActiveDelegate = async () => false;
    db.listMspSwitcher = async () => [{ id: TENANT }];
    db.listMspTenants = async () => [];
    db.netbirdGet = async (p) => (p === '/api/accounts' ? [{ id: db.currentTenantAccount() || 'main-account' }] : []);
    db.getAllPolicies = async () => { policyReads++; return [{ id: `policy-of-${db.currentTenantAccount() || 'main'}` }]; };
    appServer.on('request', require('../server').app);
});

after(async () => {
    console.error = origError;
    for (const s of [appServer, issuer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

let nextIp = 1;
const freshIp = () => { const n = nextIp++; return `10.0.${(n >> 8) & 255}.${n & 255}`; };
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

async function signIn(sub, ageHours) {
    const ip = freshIp();
    const start = await fetch(`${BASE}/login`, { headers: { accept: 'text/html', 'x-forwarded-for': ip }, redirect: 'manual' });
    const authorize = new URL(start.headers.get('location'));
    const code = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    codes.set(code, {
        iss: ISSUER, aud: CLIENT_ID, sub, email: `${sub}@example.com`, name: sub,
        nonce: authorize.searchParams.get('nonce'), iat: now - Math.round(ageHours * 3600), exp: now + 3600,
    });
    const cb = await fetch(`${BASE}/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state'))}`, {
        headers: { accept: 'text/html', 'x-forwarded-for': ip, cookie: cookiesOf(start) },
        redirect: 'manual',
    });
    assert.equal(cb.status, 302, 'callback completes the login');
    const cookie = cookiesOf(cb);
    assert.match(cookie, /appSession/);
    return cookie;
}

async function api(path, cookie, { tenant } = {}) {
    const headers = { accept: 'application/json', 'x-forwarded-for': freshIp(), cookie };
    if (tenant) headers['x-tenant-account'] = tenant;
    const res = await fetch(BASE + path, { headers, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    return {
        status: res.status,
        text: await res.text(),
        sessionCleared: setCookies.some((c) => /^appSession=;/.test(c)),
    };
}

test('a Tenant Support user within the Admin Session Cap manages the tenant', async () => {
    const cookie = await signIn('support-fresh', 1);
    const r = await api('/api/policies', cookie, { tenant: TENANT });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(JSON.parse(r.text), [{ id: `policy-of-${TENANT}` }]);
});

test('past the Admin Session Cap, a Tenant Support user is signed out of tenant management', async () => {
    const cookie = await signIn('support-old', 3);
    const before = policyReads;
    const r = await api('/api/policies', cookie, { tenant: TENANT });
    assert.equal(r.status, 401, r.text);
    assert.match(r.text, /Admin session expired/);
    assert.ok(r.sessionCleared, 'the session cookie is cleared');
    assert.equal(policyReads, before, 'the tenant is never read');
    const again = await api('/api/policies', cookie, { tenant: TENANT }); // a client that kept the cookie
    assert.equal(again.status, 401, again.text);
    assert.equal(policyReads, before);
});

test('past the Admin Session Cap, a failed first viewer lookup does not let a Tenant Support user through', async () => {
    const cookie = await signIn('support-flaky', 3);
    failViewerLookupOnce.add('support-flaky');
    const before = policyReads;
    const r = await api('/api/policies', cookie, { tenant: TENANT });
    assert.equal(r.status, 401, r.text);
    assert.match(r.text, /Admin session expired/);
    assert.equal(policyReads, before, 'the tenant is never read');
});

test('past the Admin Session Cap, a Tenant Support user keeps using the main account until the User Session Cap', async () => {
    const cookie = await signIn('support-main', 3);
    for (const tenant of [undefined, TENANT]) { // /api/me runs outside tenant context even with the header
        const r = await api('/api/me', cookie, { tenant });
        assert.equal(r.status, 200, r.text);
        const me = JSON.parse(r.text);
        assert.equal(me.user_id, 'support-main');
        assert.equal(me.isAdmin, false);
        assert.equal(me.perms['tenants.support'], true);
        assert.ok(!r.sessionCleared);
    }
    const admin = await api('/api/policies', cookie);
    assert.equal(admin.status, 403, 'no admin rights on the main account');
});

test('past the Admin Session Cap, an admin is signed out', async () => {
    const cookie = await signIn('admin-old', 3);
    for (const tenant of [undefined, TENANT]) {
        const r = await api('/api/policies', cookie, { tenant });
        assert.equal(r.status, 401, r.text);
        assert.match(r.text, /Admin session expired/);
    }
});

test('past the User Session Cap, a Tenant Support user is signed out', async () => {
    const cookie = await signIn('support-expired', 7);
    const r = await api('/api/policies', cookie, { tenant: TENANT });
    assert.equal(r.status, 401, r.text);
    assert.match(r.text, /Session expired - please sign in again/);
});
