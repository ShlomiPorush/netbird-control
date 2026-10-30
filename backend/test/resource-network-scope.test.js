// Editing or deleting a resource through /api/networks/:id/resources/:rid acts only on a resource
// that belongs to network :id. A resource id from another network (or one NetBird can't return)
// is refused before any write - its access policies are never touched.
// The NetBird client and the database-backed helpers are stubbed; the database is a stub socket
// that drops every connection, set up before the first require so no real database is reached.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

// Two networks, one resource each, one dedicated policy per resource.
const resources = {
    'res-a': { id: 'res-a', network: 'net-a', name: 'A', address: '10.0.0.1', type: 'host', groups: [] },
    'res-b': { id: 'res-b', network: 'net-b', name: 'B', address: '10.0.0.2', type: 'host', groups: [] },
};
const policies = [
    { id: 'pol-a', name: 'A access', enabled: true, rules: [{ action: 'accept', enabled: true, protocol: 'all', sources: [{ id: 'g1' }], destinationResource: { id: 'res-a', type: 'host' } }] },
    { id: 'pol-b', name: 'B access', enabled: true, rules: [{ action: 'accept', enabled: true, protocol: 'all', sources: [{ id: 'g1' }], destinationResource: { id: 'res-b', type: 'host' } }] },
];
const scoped = /^\/api\/networks\/([^/]+)\/resources\/([^/]+)$/;
// NetBird refuses a network/resource pair that doesn't match with a generic error body.
const lookup = (path) => {
    const m = scoped.exec(path);
    if (!m) return undefined;
    const r = resources[decodeURIComponent(m[2])];
    return r && r.network === decodeURIComponent(m[1]) ? r : null;
};
let netbirdDown = false; // every read fails (no answer)
let readError = null;    // the single-resource read answers this error body instead
let writes = [];
const steps = [];
let deleteResource, syncResourcePolicies, deleteNetwork;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const deadDb = net.createServer((socket) => socket.destroy());
const appServer = http.createServer();
let BASE = '';
const origError = console.error;

before(async () => {
    const dbPort = await listen(deadDb);
    BASE = `http://127.0.0.1:${await listen(appServer)}`;
    Object.assign(process.env, {
        OIDC_ISSUER_BASE_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', BASE_URL: '',
        TRUST_PROXY: '', WEBHOOK_AUTH_TOKEN: '',
        DB_HOST: '127.0.0.1', DB_PORT: String(dbPort),
        NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '',
    });
    console.error = () => { };

    // Stub the NetBird client BEFORE db.js loads (it destructures these at require time).
    const nb = require('../lib/netbird');
    nb.netbirdGet = async (path) => {
        if (netbirdDown) return null;
        if (path === '/api/policies') return JSON.parse(JSON.stringify(policies));
        if (path === '/api/networks/net-a/resources') return [JSON.parse(JSON.stringify(resources['res-a']))];
        const r = lookup(path);
        if (r === undefined) return null;
        if (readError) return readError;
        if (r === null) return { message: 'resource not part of network', code: 500 };
        return JSON.parse(JSON.stringify(r));
    };
    nb.netbirdReq = async (method, path) => {
        writes.push(`${method} ${path}`);
        return { status: lookup(path) === null ? 500 : 200, body: {} };
    };
    nb.netbirdPost = async (path) => { writes.push(`POST ${path}`); return { status: 200, body: { id: 'new1' } }; };
    nb.bustNbCaches = () => { };

    const db = require('../db');
    ({ deleteResource, syncResourcePolicies, deleteNetwork } = db);
    // server.js destructures db at require time: stub the database-backed helpers the routes call,
    // and record the policy-check / edit / sync steps of the edit route.
    db.getAllGrants = async () => ({});
    db.getBlocklist = async () => [];
    db.recordAudit = async () => { };
    db.checkResourcePolicySync = async () => { steps.push('check'); return []; };
    db.editResource = async () => { steps.push('edit'); return {}; };
    db.syncResourcePolicies = async () => { steps.push('sync'); };

    appServer.on('request', require('../server').app);
});

after(async () => {
    console.error = origError;
    for (const s of [appServer, deadDb]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

const reset = () => { writes = []; steps.length = 0; netbirdDown = false; readError = null; };
const call = async (method, path, body) => {
    const res = await fetch(BASE + path, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

test('deleting a resource of another network fails with 404 and writes nothing', async () => {
    reset();
    await assert.rejects(deleteResource('net-a', 'res-b'), (e) => e.status === 404 && e.unconfirmed === true);
    assert.deepEqual(writes, []);
});

test('deleting a resource NetBird cannot return fails with 502 and writes nothing', async () => {
    reset();
    netbirdDown = true;
    await assert.rejects(deleteResource('net-a', 'res-a'), (e) => e.status === 502 && e.unconfirmed === true);
    assert.deepEqual(writes, []);
});

test('a resource NetBird reports as not found fails with 404, confirmed gone, and writes nothing', async () => {
    reset();
    readError = { message: 'resource not found', code: 404 };
    await assert.rejects(deleteResource('net-a', 'res-a'), (e) => e.status === 404 && e.unconfirmed === false);
    assert.deepEqual(writes, []);
});

test('deleting a resource of this network removes its own policy, then the resource', async () => {
    reset();
    await deleteResource('net-a', 'res-a');
    assert.deepEqual(writes, ['DELETE /api/policies/pol-a', 'DELETE /api/networks/net-a/resources/res-a']);
});

test('syncing the policies of a resource of another network fails with 404 and writes nothing', async () => {
    reset();
    await assert.rejects(syncResourcePolicies('net-a', 'res-b', []), (e) => e.status === 404);
    assert.deepEqual(writes, []);
});

test('deleting a network stops before the network when a resource read fails', async () => {
    reset();
    readError = { message: 'internal server error', code: 500 };
    await assert.rejects(deleteNetwork('net-a'), /network was not deleted/);
    assert.deepEqual(writes, []);
});

test('editing a resource of another network answers 404 before any check or write', async () => {
    reset();
    const r = await call('PUT', '/api/networks/net-a/resources/res-b', { name: 'B', address: '10.0.0.2', policies: [] });
    assert.equal(r.status, 404);
    assert.deepEqual(steps, []);
    assert.deepEqual(writes, []);
});

test('editing a resource of this network still runs the check, the edit and the sync', async () => {
    reset();
    const r = await call('PUT', '/api/networks/net-a/resources/res-a', { name: 'A', address: '10.0.0.1', policies: [] });
    assert.deepEqual(steps, ['check', 'edit', 'sync']);
    assert.notEqual(r.status, 404);
});

test('deleting a resource of another network through the API answers 404 and writes nothing', async () => {
    reset();
    const r = await call('DELETE', '/api/networks/net-a/resources/res-b');
    assert.equal(r.status, 404);
    assert.deepEqual(writes, []);
});
