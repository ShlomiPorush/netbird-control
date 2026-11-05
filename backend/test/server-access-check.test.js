// The real server.js stack with SSO on, against a stub OpenID provider and stubbed database and
// NetBird lookups. It pins down who may use Access Check (admins and the holders of Manage
// Temporary Access, Manage All Networks or Troubleshoot All Peers; a Tenant Support user inside
// a tenant), that it reads the tenant it runs in, and how it answers bad input and NetBird
// read failures.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
// Credentials are generated for each run; none is fixed in the repository.
const CLIENT_SECRET = crypto.randomBytes(32).toString('hex');
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const ACCESS_TOKEN = crypto.randomBytes(32).toString('hex');

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
            send({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, id_token: idToken });
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

// Subjects: admin-* are NetBird admins; the others hold the listed feature permissions.
const PERMS = {
    plain: [], approver: [], audit: ['audit.view'], peers: ['peers.all'],
    temp: ['temp.manage'], netmgr: ['networks.manage'], trouble: ['troubleshoot.all'],
    support: ['tenants.support'],
};

// A small NetBird account: Dana's laptop reaches srv1 through Staff RDP.
const SNAP = () => ({
    users: [{ id: 'u1', name: 'Dana', email: 'dana@example.com', auto_groups: [] }],
    peers: [{ id: 'p1', name: 'dana-laptop', user_id: 'u1', groups: [{ id: 'g-staff' }], connected: true }],
    groups: [{ id: 'g-all', name: 'All' }, { id: 'g-staff', name: 'Staff' }],
    networks: [{ id: 'n1', name: 'Office', resources: ['r1'] }],
    resources: [{ id: 'r1', name: 'srv1', address: '10.0.0.5/32', enabled: true, groups: [] }],
    policies: [{ id: 'pol', name: 'Staff RDP', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinationResource: { id: 'r1' } }] }],
    routes: [], grants: [], bypassed: new Set(), postureChecks: [],
});
const reads = []; // the tenant each snapshot read ran in
let snapshotFails = false;

before(async () => {
    ISSUER = `http://127.0.0.1:${await listen(issuer)}`;
    const dbPort = await listen(deadDb);
    BASE = `http://127.0.0.1:${await listen(appServer)}`;
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: ISSUER,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: CLIENT_SECRET,
        BASE_URL: BASE,
        SESSION_SECRET,
        TRUST_PROXY: 'loopback',
        DB_HOST: '127.0.0.1',
        DB_PORT: String(dbPort),
        NETBIRD_API_URL: '',
        NETBIRD_API_TOKEN: '',
    });
    console.error = () => { }; // DB-stub failures are expected
    // server.js reads these from the db module when it loads, so replace them first.
    const db = require('../db');
    db.resolveViewer = async (oid) => ({ user_id: String(oid), email: `${oid}@example.com`, name: String(oid), role: String(oid).startsWith('admin-') ? 'admin' : 'user', auto_groups: [] });
    const realPerms = db.resolveFeaturePerms;
    db.resolveFeaturePerms = (args) => {
        const out = realPerms(args);
        for (const p of (PERMS[String(args.userId || '')] || [])) out[p] = true;
        return out;
    };
    db.isActiveDelegate = async () => false;
    db.getApproverGroupIds = () => [];
    db.listMspSwitcher = async () => [{ id: TENANT }];
    db.listMspTenants = async () => [];
    db.netbirdGet = async (p) => (p === '/api/accounts' ? [{ id: db.currentTenantAccount() || 'main-account' }] : []);
    db.loadAccessCheckSnapshot = async () => {
        reads.push(db.currentTenantAccount() || 'main');
        if (snapshotFails) { const e = new Error("Couldn't read peers from NetBird"); e.code = 'NETBIRD_READ_FAILED'; throw e; }
        return SNAP();
    };
    db.loadAccessCheckRouters = async (ids) => new Map(ids.map((id) => [id, []]));
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
const sessions = new Map();

async function signIn(sub) {
    if (sessions.has(sub)) return sessions.get(sub);
    const ip = freshIp();
    const start = await fetch(`${BASE}/login`, { headers: { accept: 'text/html', 'x-forwarded-for': ip }, redirect: 'manual' });
    const authorize = new URL(start.headers.get('location'));
    const code = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    codes.set(code, {
        iss: ISSUER, aud: CLIENT_ID, sub, email: `${sub}@example.com`, name: sub,
        nonce: authorize.searchParams.get('nonce'), iat: now, exp: now + 3600,
    });
    const cb = await fetch(`${BASE}/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get('state'))}`, {
        headers: { accept: 'text/html', 'x-forwarded-for': ip, cookie: cookiesOf(start) },
        redirect: 'manual',
    });
    assert.equal(cb.status, 302, 'callback completes the login');
    const cookie = cookiesOf(cb);
    sessions.set(sub, cookie);
    return cookie;
}

async function api(sub, path, { tenant } = {}) {
    const headers = { accept: 'application/json', 'x-forwarded-for': freshIp(), cookie: await signIn(sub) };
    if (tenant) headers['x-tenant-account'] = tenant;
    const res = await fetch(BASE + path, { headers, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) };
}

const PATHS = [
    '/api/access-check/options',
    '/api/access-check/user?user_id=u1&type=resource&id=r1',
    '/api/access-check/target?type=resource&id=r1',
];

test('a signed-in user without an access-management permission is refused before any read', async () => {
    for (const sub of ['plain', 'approver', 'audit', 'peers', 'support']) {
        for (const path of PATHS) {
            const before = reads.length;
            const r = await api(sub, path);
            assert.equal(r.status, 403, `${sub} ${path}: ${r.text}`);
            assert.equal(reads.length, before, `${sub} ${path} must not read NetBird`);
        }
    }
});

test('admins and each access-management permission may use every endpoint', async () => {
    for (const sub of ['admin-1', 'temp', 'netmgr', 'trouble']) {
        for (const path of PATHS) {
            const r = await api(sub, path);
            assert.equal(r.status, 200, `${sub} ${path}: ${r.text}`);
        }
    }
    const user = (await api('netmgr', PATHS[1])).json();
    assert.equal(user.verdict, 'granted');
    assert.equal(user.routers[0].status, 'none');
    const who = (await api('trouble', PATHS[2])).json();
    assert.deepEqual(who.users.map((u) => u.user.id), ['u1']);
    const opts = (await api('temp', PATHS[0])).json();
    assert.deepEqual(opts.users, [{ id: 'u1', name: 'Dana', email: 'dana@example.com', blocked: false }]);
});

test('a Tenant Support user checks inside the tenant, and the read runs in that tenant', async () => {
    for (const path of PATHS) {
        reads.length = 0;
        const r = await api('support', path, { tenant: TENANT });
        assert.equal(r.status, 200, `${path}: ${r.text}`);
        assert.deepEqual(reads, [TENANT]);
    }
});

test('bad input is refused with 400 before any read', async () => {
    const bad = [
        '/api/access-check/user?type=resource&id=r1',
        '/api/access-check/user?user_id=u1&type=peer&id=r1',
        '/api/access-check/target?type=resource',
        '/api/access-check/target?type=resource&id=r1&protocol=gre',
        '/api/access-check/target?type=resource&id=r1&protocol=icmp&port=22',
        '/api/access-check/target?type=resource&id=r1&port=22',
        '/api/access-check/target?type=resource&id=r1&protocol=tcp&port=70000',
        '/api/access-check/target?type=resource&id=r1&protocol=tcp&port=2x',
        `/api/access-check/target?type=resource&id=${'a'.repeat(201)}`,
    ];
    for (const path of bad) {
        const before = reads.length;
        const r = await api('admin-1', path);
        assert.equal(r.status, 400, `${path}: ${r.text}`);
        assert.equal(reads.length, before);
    }
});

test('an unknown user or resource is 404; a failed NetBird read is 503 with no verdict', async () => {
    assert.equal((await api('admin-1', '/api/access-check/user?user_id=nope&type=resource&id=r1')).status, 404);
    assert.equal((await api('admin-1', '/api/access-check/target?type=network&id=nope')).status, 404);
    snapshotFails = true;
    try {
        for (const path of PATHS) {
            const r = await api('admin-1', path);
            assert.equal(r.status, 503, `${path}: ${r.text}`);
            assert.match(r.text, /Couldn't read peers from NetBird/);
            assert.doesNotMatch(r.text, /verdict/);
        }
    } finally {
        snapshotFails = false;
    }
});

test('Access Check is not part of the public API', async () => {
    const res = await fetch(`${BASE}/api/v1/access-check/user?user_id=u1&type=resource&id=r1`, { headers: { authorization: 'Bearer nb_test' } });
    assert.notEqual(res.status, 200);
    const spec = JSON.stringify(require('../openapi'));
    assert.doesNotMatch(spec, /access-check/);
});
