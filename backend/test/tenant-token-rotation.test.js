const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

for (const k of ['NETBIRD_API_URL', 'NETBIRD_API_TOKEN']) delete process.env[k];

const store = new Map();
const order = [];
const core = require('../lib/core');
core.getSetting = async (k) => store.get(k) ?? null;
core.setSetting = async (k, v) => { order.push(['set', k, v]); store.set(k, String(v)); };
core.pool.query = async (sql, params = []) => {
    if (/LIKE 'msp_tenant_su:%'/.test(sql)) return { rows: [...store].filter(([k]) => k.startsWith('msp_tenant_su:')).map(([key, value]) => ({ key, value })) };
    if (/LIKE 'msp_tenant_token:%'/.test(sql)) return { rows: [{ key: 'msp_provisioning_token', value: PROV }] };
    return { rows: [] };
};
core.pool.connect = async () => {
    const staged = [];
    return {
        query: async (sql, params = []) => {
            if (sql === 'COMMIT') for (const [k, v] of staged.splice(0)) { order.push(['set', k, v]); store.set(k, v); }
            else if (/^INSERT INTO app_settings/.test(sql)) staged.push([params[0], params[1]]);
            return { rows: [] };
        },
        release() { },
    };
};
const PROV = crypto.randomBytes(16).toString('hex');
const NEW_PLAIN = crypto.randomBytes(16).toString('hex');

const nb = require('../lib/netbird');
nb.netbirdApiConfigured = () => true;
let deleteStatus = 200;
let tokensListed = true;
nb.netbirdGet = async (p) => {
    if (p === '/api/users?service_user=true') return [{ id: 'su1', name: 'NetBird Control', is_service_user: true }];
    if (p === '/api/users/su1/tokens') return tokensListed ? [{ id: 'old1' }, { id: 'new1' }] : null;
    return [];
};
nb.netbirdPost = async (p) => (p === '/api/users/su1/tokens' ? { status: 200, body: { plain_token: NEW_PLAIN, personal_access_token: { id: 'new1' } } } : { status: 200, body: {} });
nb.netbirdReq = async (method, p) => { order.push([method, p]); return { status: deleteStatus }; };

const db = require('../db');

test('the new tenant token is stored before the old one is revoked', async () => {
    await nb.loadTenantTokens();
    order.length = 0;
    await db.provisionTenantServiceUser('tenant-a');
    const stored = order.findIndex(([op, k]) => op === 'set' && k === 'msp_tenant_token:tenant-a');
    const revoked = order.findIndex(([op, p]) => op === 'DELETE' && p === '/api/users/su1/tokens/old1');
    assert.ok(stored >= 0 && revoked > stored, JSON.stringify(order));
    assert.deepEqual(JSON.parse(store.get('msp_tenant_su:tenant-a')).pendingRevoke, []);
});

test('an old token whose revoke failed stays recorded, and the rotation job comes back for it', async () => {
    deleteStatus = 503;
    await db.provisionTenantServiceUser('tenant-b');
    assert.deepEqual(JSON.parse(store.get('msp_tenant_su:tenant-b')).pendingRevoke, ['old1']);
    deleteStatus = 200;
    order.length = 0;
    await db.rotateTenantTokens();
    assert.ok(order.some(([op, p]) => op === 'DELETE' && p === '/api/users/su1/tokens/old1'));
    assert.deepEqual(JSON.parse(store.get('msp_tenant_su:tenant-b')).pendingRevoke, []);
});

test('a token list NetBird does not return keeps the new token and brings the rotation back', async () => {
    tokensListed = false;
    await assert.rejects(db.provisionTenantServiceUser('tenant-c'), /did not list the old tokens/);
    assert.equal(store.get('msp_tenant_token:tenant-c'), NEW_PLAIN);
    assert.equal(JSON.parse(store.get('msp_tenant_su:tenant-c')).tokensUnlisted, true);
    tokensListed = true;
    order.length = 0;
    await db.rotateTenantTokens().catch(() => { });
    assert.ok(order.some(([op, p]) => op === 'DELETE' && p === '/api/users/su1/tokens/old1'));
    assert.equal(JSON.parse(store.get('msp_tenant_su:tenant-c')).tokensUnlisted, undefined);
});

test('an old token whose revoke got no answer stays recorded for the next rotation', async () => {
    tokensListed = true;
    deleteStatus = 0;
    await db.provisionTenantServiceUser('tenant-d');
    assert.deepEqual(JSON.parse(store.get('msp_tenant_su:tenant-d')).pendingRevoke, ['old1']);
    deleteStatus = 200;
});
