// The real server.js stack with SSO on, against a stub OpenID provider (no real IdP), a stub
// database socket that drops every connection, and stubbed viewer/grant/list lookups in ./db.
// It pins down who may read the access-profile, posture-check and blocklist lists: network
// editors (admins, Manage All Networks holders, members of a group with an edit grant on an
// existing network) - and, for access profiles only, Manage Temporary Access holders.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const CLIENT_ID = 'test-client';
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

// ── Directory stubs: users by login subject, network grants, and the three lists ──
const USERS = {
    plain: {},
    viewer: { groups: ['g-view'] },
    source: { groups: ['g-source'] },
    editor: { groups: ['g-edit'] },
    suffix: { peerGroups: ['g-suffix'] },  // matches the stored "azure|g-suffix" grant by suffix
    stale: { groups: ['g-stale'] },         // edit grant only on a network that no longer exists
    approver: { groups: ['g-approvers'] },
    delegate: {},
    netmgr: { perms: ['networks.manage'] },
    temp: { perms: ['temp.manage'] },
    admin: { role: 'admin' },
};
const GRANTS = {
    'net-1': [
        { id: 'g-edit', access: 'edit' },
        { id: 'g-view', access: 'view' },
        { id: 'g-source', access: 'source' },
        { id: 'azure|g-suffix', access: 'edit' },
    ],
    'net-gone': [{ id: 'g-stale', access: 'edit' }],
};
const LISTS = {
    '/api/access-profiles': { fn: 'listAccessProfiles', body: [{ id: 1, name: 'Ops', shared: true, groupId: 'pg-1' }] },
    '/api/posture-checks': { fn: 'listPostureChecks', body: [{ id: 'pc-1', name: 'Min Version' }] },
    '/api/blocklist': { fn: 'getBlocklist', body: [{ id: 1, value: '10.99.0.0/16' }] },
};
const calls = { listAccessProfiles: 0, listPostureChecks: 0, getBlocklist: 0 };
let grantsFail = false;

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
        TRUST_PROXY: '',
        WEBHOOK_AUTH_TOKEN: '',
        DB_HOST: '127.0.0.1',
        DB_PORT: String(dbPort),
        NETBIRD_API_URL: '',
        NETBIRD_API_TOKEN: '',
    });
    console.error = () => { }; // DB-stub failures are expected
    // server.js destructures ./db when it loads, so the stubs go in before it is required.
    const db = require('../db');
    Object.assign(db, {
        ensureUsersFresh: async () => { },
        ensurePeersFresh: async () => { },
        resolveViewer: async (oid) => (USERS[oid] ? { user_id: oid, role: USERS[oid].role || 'user', name: oid, email: `${oid}@example.com`, auto_groups: USERS[oid].groups || [] } : null),
        fetchUserGroups: async () => [],
        getUserPeerGroupIds: async (userId) => (USERS[userId] && USERS[userId].peerGroups) || [],
        getApproverGroupIds: () => ['g-approvers'],
        isActiveDelegate: async ({ oid } = {}) => oid === 'delegate',
        resolveFeaturePerms: ({ isAdmin, userId } = {}) => (isAdmin
            ? { 'networks.manage': true, 'temp.manage': true }
            : Object.fromEntries(((USERS[userId] && USERS[userId].perms) || []).map((p) => [p, true]))),
        getAllGrants: async () => { if (grantsFail) throw new Error('database unavailable'); return GRANTS; },
        getNetworks: async () => [{ id: 'net-1', name: 'Net 1' }],
    });
    for (const { fn, body } of Object.values(LISTS)) db[fn] = async () => { calls[fn]++; return body; };
    appServer.on('request', require('../server').app);
});

after(async () => {
    console.error = origError;
    for (const s of [appServer, issuer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
const sessions = new Map();

// A full login through the stub provider: /login → /authorize (skipped) → /callback → session.
async function signIn(sub) {
    if (sessions.has(sub)) return sessions.get(sub);
    const start = await fetch(`${BASE}/login`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    const authorize = new URL(start.headers.get('location'));
    const code = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    codes.set(code, {
        iss: ISSUER, aud: CLIENT_ID, sub, email: `${sub}@example.com`, name: sub,
        nonce: authorize.searchParams.get('nonce'), iat: now, exp: now + 3600,
    });
    const cb = await fetch(`${BASE}/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state'))}`, {
        headers: { accept: 'text/html', cookie: cookiesOf(start) },
        redirect: 'manual',
    });
    assert.equal(cb.status, 302, 'callback completes the login');
    const cookie = cookiesOf(cb);
    sessions.set(sub, cookie);
    return cookie;
}

async function read(sub, path) {
    const res = await fetch(BASE + path, { headers: { accept: 'application/json', cookie: await signIn(sub) }, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, text };
}

// Reads each list as `sub` and checks the status; a refused read never reaches the list lookup.
async function expectReads(sub, allowed) {
    for (const [path, { fn, body }] of Object.entries(LISTS)) {
        const before = calls[fn];
        const r = await read(sub, path);
        if (allowed.includes(path)) {
            assert.equal(r.status, 200, `${sub} ${path}: ${r.text}`);
            assert.deepEqual(JSON.parse(r.text), body, `${sub} ${path}`);
        } else {
            assert.equal(r.status, 403, `${sub} ${path}: ${r.text}`);
            assert.equal(calls[fn], before, `${sub} ${path} must not reach ${fn}`);
        }
    }
}

const ALL = Object.keys(LISTS);

test('a signed-in user without a network edit grant or a relevant permission cannot read the lists', async () => {
    for (const sub of ['plain', 'viewer', 'source', 'approver', 'delegate']) await expectReads(sub, []);
});

test('an edit grant only on a network that no longer exists does not count', async () => {
    await expectReads('stale', []);
});

test('network editors read all three lists', async () => {
    for (const sub of ['editor', 'suffix', 'netmgr', 'admin']) await expectReads(sub, ALL);
});

test('Manage Temporary Access holders read access profiles only', async () => {
    await expectReads('temp', ['/api/access-profiles']);
});

test('when the grants cannot be loaded, an editor is refused with 500 and admins are unaffected', async () => {
    grantsFail = true;
    try {
        for (const [path, { fn }] of Object.entries(LISTS)) {
            const before = calls[fn];
            const r = await read('editor', path);
            assert.equal(r.status, 500, `${path}: ${r.text}`);
            assert.equal(calls[fn], before, `${path} must not reach ${fn}`);
        }
        await expectReads('admin', ALL);
        await expectReads('netmgr', ALL);
    } finally {
        grantsFail = false;
    }
});
