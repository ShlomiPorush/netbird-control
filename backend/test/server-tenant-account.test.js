// The real server.js stack with SSO on and the real NetBird client, against a local HTTP server that
// plays NetBird: every token belongs to one account, and ?account= is honored only for the tokens in
// `honored`; otherwise it is ignored without an error and the token's own account answers, as NetBird
// does. A tenant request uses the tenant's own token and must never reach the main account.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { ssoServer } = require('./helpers/sso-server');

const MAIN = 'account-main';
// Tokens are generated for each run; none is fixed in the repository.
const token = () => crypto.randomBytes(24).toString('hex');
const T = { main: token(), tenant: token(), provisioning: token() };
const owner = new Map([[T.main, MAIN], [T.provisioning, MAIN]]);

// Each test gets its own tenant, so no test sees what another one verified.
const tenants = Array.from({ length: 40 }, (_, i) => `account-tenant-${i}`);
let TENANT = '';
let honored = new Set();
let writes = []; // { account, method, path } that NetBird applied
let senders = []; // the token of each applied write
let failMainAccountRead = false;
let limitNextWrite = false;
let revokeDuringMainRead = false;
const nbServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        const url = new URL(req.url, 'http://netbird');
        const tok = String(req.headers.authorization || '').replace(/^Token /, '');
        const asked = url.searchParams.get('account');
        const account = asked && honored.has(tok) ? asked : owner.get(tok);
        const send = (status, out) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); };
        if (!account) return send(401, { message: 'token invalid', code: 401 });
        if (req.method !== 'GET' && limitNextWrite) {
            limitNextWrite = false;
            return send(429, { message: 'too many requests', code: 429 });
        }
        if (req.method !== 'GET') {
            writes.push({ account, method: req.method, path: url.pathname });
            senders.push(tok);
            return send(200, { id: 'new-id', key: 'plain-key', name: 'x', plain_token: T.tenant, personal_access_token: { id: 'pat-id' } });
        }
        if (url.pathname === '/api/accounts') {
            if (failMainAccountRead && !asked) return send(500, { message: 'internal error', code: 500 });
            const answer = () => send(200, [{ id: account, settings: {} }]);
            if (revokeDuringMainRead && !asked) return setTimeout(() => { honored.clear(); answer(); }, 50);
            return answer();
        }
        if (url.pathname === '/api/groups/g1') return send(200, { id: 'g1', name: 'Group', issued: 'api', peers: [], resources: [] });
        if (url.pathname === '/api/users') {
            const serviceUsers = url.searchParams.get('service_user') === 'true';
            return send(200, serviceUsers ? [] : [{ id: 'u1', name: 'User', email: 'u1@example.com', role: 'user', auto_groups: [], is_blocked: false, is_service_user: false }]);
        }
        if (url.pathname === '/api/integrations/msp/switcher') return send(200, [...tenants, MAIN].map((id) => ({ id, account_id: id, name: id })));
        return send(200, []);
    });
});

const h = ssoServer();
let nb;
before(async () => {
    await new Promise((r) => nbServer.listen(0, '127.0.0.1', r));
    await h.start({
        env: { NETBIRD_API_URL: `http://127.0.0.1:${nbServer.address().port}`, NETBIRD_API_TOKEN: T.main, NETBIRD_READONLY: '' },
        beforeRequire: (db) => {
            nb = require('../lib/netbird');
            db.resolveViewer = async (sub) => ({ user_id: sub, email: `${sub}@example.com`, name: sub, role: sub.startsWith('admin') ? 'admin' : 'user', auto_groups: [] });
            const realPerms = db.resolveFeaturePerms;
            db.resolveFeaturePerms = (a) => ({ ...realPerms(a), ...(String(a.userId || '').startsWith('support') ? { 'tenants.support': true } : {}) });
            db.isActiveDelegate = async () => false;
            require('../lib/core').pool.query = async () => ({ rows: [], rowCount: 0 });
        },
    });
});
after(async () => {
    await h.stop();
    nbServer.closeAllConnections();
    await new Promise((r) => nbServer.close(r));
});
let next = 0;
beforeEach(() => {
    TENANT = tenants[next++];
    owner.set(T.tenant, TENANT);
    honored = new Set();
    failMainAccountRead = false;
    limitNextWrite = false;
    revokeDuringMainRead = false;
    nb.setTenantTokenInMemory([TENANT], T.tenant);
    nb.setMspProvisioningTokenInMemory('');
    writes = [];
    senders = [];
});

const support = (method, path, body) => h.call('support-user', method, path, body, { 'x-tenant-account': TENANT });
const admin = (method, path, body) => h.call('admin-user', method, path, body);
const mainWrites = () => writes.filter((w) => w.account === MAIN);
const saveToken = async (value) => {
    const r = await admin('PUT', `/api/msp/tenants/${TENANT}/token`, { token: value });
    assert.equal(r.status, 200, r.text);
};
const verifiedWrite = async () => {
    const r = await support('POST', '/api/groups', { name: 'before' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(writes, [{ account: TENANT, method: 'POST', path: '/api/groups' }]);
    writes = [];
};

test('a Tenant Support user has no admin rights on the main account, not even when NetBird lists it as switchable', async () => {
    const r = await h.call('support-user', 'POST', '/api/groups', { name: 'main' });
    assert.equal(r.status, 403, r.text);
    TENANT = MAIN;
    nb.setTenantTokenInMemory([MAIN], T.main);
    const t = await support('POST', '/api/groups', { name: 'main' });
    nb.setTenantTokenInMemory([MAIN], null);
    assert.equal(t.status, 502, t.text);
    assert.deepEqual(writes, []);
});

test('a tenant with its own token works, for reads and writes', async () => {
    assert.equal((await support('GET', '/api/posture-checks')).status, 200);
    assert.equal((await support('POST', '/api/groups', { name: 'ok' })).status, 200);
    assert.equal((await support('POST', '/api/setup-keys', { name: 'ok' })).status, 200);
    assert.deepEqual(writes.map((w) => w.account), [TENANT, TENANT]);
});

test('after the tenant token is cleared, a tenant request does not write to the main account', async () => {
    await verifiedWrite();
    await saveToken('');
    const r = await support('POST', '/api/setup-keys', { name: 'after' });
    assert.deepEqual(mainWrites(), []);
    assert.equal(r.status, 502, r.text);
});

test('after the tenant token is replaced by a main-account token, a tenant request does not write to the main account', async () => {
    await verifiedWrite();
    await saveToken(T.main);
    const r = await support('POST', '/api/groups', { name: 'after' });
    assert.deepEqual(mainWrites(), []);
    assert.equal(r.status, 502, r.text);
});

test('a tenant token cleared while a request runs does not move the rest of it to the main account', async () => {
    await nb.runWithTenant(TENANT, async () => {
        assert.deepEqual(await nb.netbirdGet('/api/groups'), []);
        nb.setTenantTokenInMemory([TENANT], null);
        const r = await nb.netbirdPost('/api/groups', { name: 'late' });
        assert.deepEqual(mainWrites(), []);
        assert.ok(r.status >= 300, JSON.stringify(r));
    });
});

test('when the main account cannot be read, an ignored switch is not taken as honored', async () => {
    await verifiedWrite();
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    failMainAccountRead = true;
    const r = await support('POST', '/api/users/invite', { name: 'New', email: 'new@example.com', role: 'admin' });
    assert.deepEqual(mainWrites(), []);
    assert.equal(r.status, 502, r.text);
});

test('an invitation sent with the provisioning token does not reach the main account when its switch is ignored', async () => {
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    const r = await support('POST', '/api/users/invite', { name: 'New', email: 'new@example.com', role: 'admin' });
    assert.deepEqual(mainWrites(), []);
    assert.equal(r.status, 502, r.text);
});

test('an invitation sent with the provisioning token works when its switch is honored, and in the main account', async () => {
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    const invite = { name: 'New', email: 'new@example.com', role: 'user' };
    const m = await admin('POST', '/api/users/invite', invite);
    assert.equal(m.status, 200, m.text);
    assert.deepEqual(writes, [{ account: MAIN, method: 'POST', path: '/api/users' }]);
    writes = [];
    honored.add(T.provisioning);
    const r = await support('POST', '/api/users/invite', invite);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(writes, [{ account: TENANT, method: 'POST', path: '/api/users' }]);
});

test('provisioning a tenant writes nothing to the main account when the switch is ignored', async () => {
    nb.setTenantTokenInMemory([TENANT], null);
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    const r = await admin('POST', `/api/msp/tenants/${TENANT}/provision`);
    assert.deepEqual(mainWrites(), []);
    assert.equal(r.status, 502, r.text);
    assert.ok(!nb.hasTenantToken(TENANT), 'no main-account token is stored for the tenant');
});

test('provisioning a tenant works when the switch is honored', async () => {
    nb.setTenantTokenInMemory([TENANT], null);
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    honored.add(T.provisioning);
    const r = await admin('POST', `/api/msp/tenants/${TENANT}/provision`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([...new Set(writes.map((w) => w.account))], [TENANT]);
    writes = [];
    await verifiedWrite();
});

test('a background job of a tenant whose stored token belongs to the main account does not write there', async () => {
    nb.setTenantTokenInMemory([TENANT], T.main);
    const r = await nb.runWithTenant(TENANT, () => nb.netbirdPost('/api/groups', { name: 'job' }));
    assert.deepEqual(mainWrites(), []);
    assert.ok(r.status >= 300, JSON.stringify(r));
});

test('a tenant without its own token is refused, and nothing is sent, even where NetBird would honor the main token', async () => {
    nb.setTenantTokenInMemory([TENANT], null);
    honored.add(T.main);
    const r = await support('POST', '/api/groups', { name: 'x' });
    assert.equal(r.status, 502, r.text);
    assert.match(r.json.error, /no API token/);
    const job = await nb.runWithTenant(TENANT, () => nb.netbirdPost('/api/groups', { name: 'job' }));
    assert.equal(job.status, 502);
    assert.deepEqual(writes, []);
});

test('jobs skip a tenant without its own token, unless they need no NetBird', async () => {
    nb.setTenantTokenInMemory([TENANT], null);
    const { forEachTenant } = require('../db');
    const ran = { netbird: [], local: [] };
    await forEachTenant(async () => { ran.netbird.push(nb.currentTenantAccount()); });
    await forEachTenant(async () => { ran.local.push(nb.currentTenantAccount()); }, { needsNetbird: false });
    assert.ok(ran.netbird.includes('') && !ran.netbird.includes(TENANT));
    assert.ok(ran.local.includes('') && ran.local.includes(TENANT));
});

test('in a tenant, users and groups are changed with the tenant token, also when a provisioning token is set', async () => {
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    for (const [path, body] of [
        ['/api/groups/g1/rename', { name: 'Renamed' }],
        ['/api/groups/g1/users', { add: ['u1'] }],
        ['/api/users/u1/block', { blocked: true }],
    ]) {
        writes = []; senders = [];
        const r = await support('POST', path, body);
        assert.equal(r.status, 200, `${path}: ${r.text}`);
        assert.deepEqual(writes.map((w) => w.account), [TENANT], path);
        assert.deepEqual(senders, [T.tenant], path);
    }
});

test('in the main account, users and groups are still changed with the provisioning token', async () => {
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    const r = await admin('POST', '/api/groups/g1/rename', { name: 'Renamed' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(writes.map((w) => w.account), [MAIN]);
    assert.deepEqual(senders, [T.provisioning]);
});

test('a write that NetBird rate-limited is checked again before it is sent again', async () => {
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    honored.add(T.provisioning);
    limitNextWrite = true;
    // NetBird stops honoring the switch while the write waits for its second attempt.
    let clock = 0;
    nb._setNetbirdTimingForTests({ sleep: async (ms) => { clock += ms; honored.clear(); }, now: () => clock });
    const r = await support('POST', '/api/users/invite', { name: 'New', email: 'new@example.com', role: 'admin' });
    assert.ok(clock > 0 && !limitNextWrite, 'the first attempt was rate-limited and waited');
    assert.deepEqual(mainWrites(), []);
    assert.equal(r.status, 502, r.text);
});

test('a switch that NetBird stops honoring while the main account is read is not used', async () => {
    await verifiedWrite();
    nb.setMspProvisioningTokenInMemory(T.provisioning);
    honored.add(T.provisioning);
    revokeDuringMainRead = true;
    const r = await support('POST', '/api/users/invite', { name: 'New', email: 'new@example.com', role: 'admin' });
    assert.equal(honored.size, 0, 'the main account was read');
    assert.deepEqual(mainWrites(), []);
    assert.equal(r.status, 502, r.text);
});
