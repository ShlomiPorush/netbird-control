// Reverse-proxy actions that change a network (attach a routing peer, create a resource for a
// container target, delete / disable / enable the network resources a service targets) need
// edit rights on that network. The routes pass a canEditNetwork predicate; without one, those
// side effects are refused. A refusal happens before anything is written.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client and the DB BEFORE db.js loads (it destructures these at require time).
const nb = require('../lib/netbird');
let state, writes;
const reset = (s = {}) => {
    writes = [];
    state = {
        services: [], // full service objects, keyed by id when read singly
        networks: [{ id: 'netA', resources: ['resA'] }, { id: 'netB', resources: ['resB'] }],
        resources: { resA: { id: 'resA', name: 'a.internal', address: 'a.internal', enabled: true, groups: [] }, resB: { id: 'resB', name: 'b.internal', address: 'b.internal', enabled: true, groups: [] } },
        ...s,
    };
};
const clone = (v) => JSON.parse(JSON.stringify(v));
nb.netbirdGet = async (path) => {
    let m;
    if (path === '/api/reverse-proxies/services') return clone(state.services);
    if ((m = path.match(/^\/api\/reverse-proxies\/services\/(.+)$/))) return clone(state.services.find(s => s.id === m[1]) || null);
    if (path === '/api/networks') return clone(state.networks);
    if ((m = path.match(/^\/api\/networks\/[^/]+\/resources\/(.+)$/))) return clone(state.resources[m[1]] || null);
    if ((m = path.match(/^\/api\/networks\/([^/]+)\/resources$/))) return clone((state.networks.find(n => n.id === m[1]) || { resources: [] }).resources.map(id => state.resources[id]));
    if (path === '/api/policies') return [];
    return null;
};
let nextId = 0;
nb.netbirdPost = async (path, body) => {
    writes.push({ method: 'POST', path, body });
    const id = `new${++nextId}`;
    // A created network resource is listed in its network from then on.
    const m = path.match(/^\/api\/networks\/([^/]+)\/resources$/);
    const net = m && state.networks.find(n => n.id === m[1]);
    if (net) { net.resources.push(id); state.resources[id] = { id, name: body.name, address: body.address, enabled: true, groups: [] }; }
    return { status: 200, body: { id, type: 'domain' } };
};
nb.netbirdReq = async (method, path, body) => { writes.push({ method, path, body }); return { status: 200, body: {} }; };
nb.bustNbCaches = () => { };
nb.bustReverseProxyCache = () => { };
nb.getUsageData = async () => ({ networks: clone(state.networks), resources: Object.values(clone(state.resources)) });
const core = require('../lib/core');
core.pool.query = async () => ({ rows: [] });
const { createProxyService, updateProxyService, deleteProxyService, exposeDockerService } = require('../db');

const only = (...ids) => ({ canEditNetwork: async (id) => ids.includes(id) });
const is403 = (e) => e.status === 403;
const networkWrites = () => writes.filter(w => w.path.startsWith('/api/networks/') || w.path.startsWith('/api/policies'));
const svcWith = (id, resIds, extra = {}) => ({
    id, domain: `${id}.example.com`, enabled: true, mode: 'http', proxy_cluster: 'c1',
    targets: resIds.map(r => ({ target_type: 'domain', target_id: r, port: 80, protocol: 'http', enabled: true })),
    ...extra,
});
const exposeCfg = { networkId: 'netB', containerDomain: 'app.internal', routerPeerId: 'peer1', serviceDomain: 'app.example.com', cluster: 'c1', port: 80 };

test('expose-docker: a network the caller cannot edit is refused before any write', async () => {
    reset();
    await assert.rejects(exposeDockerService(exposeCfg, only('netA')), is403);
    assert.deepEqual(writes, []);
});

test('expose-docker: an editable network attaches the routing peer and creates the resource', async () => {
    reset();
    await exposeDockerService(exposeCfg, only('netB'));
    assert.ok(writes.some(w => w.method === 'POST' && w.path === '/api/networks/netB/routers'));
    assert.ok(writes.some(w => w.method === 'POST' && w.path === '/api/networks/netB/resources'));
});

test('expose-docker: without a permission check, the network change is refused', async () => {
    reset();
    await assert.rejects(exposeDockerService(exposeCfg), is403);
    assert.deepEqual(writes, []);
});

test('create: a container target in a network the caller cannot edit creates nothing', async () => {
    for (const t of [
        { type: 'container', networkId: 'netB', containerDomain: 'x.internal', port: 80 },
        { target_type: 'container', networkId: ' netB ', containerDomain: 'x.internal', port: 80 },
    ]) {
        reset();
        // The allowed container target comes first: it must not be created either.
        const targets = [{ type: 'container', networkId: 'netA', containerDomain: 'ok.internal', port: 80 }, t];
        await assert.rejects(createProxyService({ domain: 'svc.example.com', cluster: 'c1', targets }, only('netA')), is403);
        assert.deepEqual(writes, []);
    }
});

test('create: a container target in an editable network is created; peer targets need no network rights', async () => {
    reset();
    await createProxyService({ domain: 'svc.example.com', cluster: 'c1', targets: [{ type: 'container', networkId: 'netA', containerDomain: 'x.internal', port: 80 }] }, only('netA'));
    assert.ok(writes.some(w => w.method === 'POST' && w.path === '/api/networks/netA/resources'));
    reset();
    await createProxyService({ domain: 'svc.example.com', cluster: 'c1', target: { type: 'peer', id: 'p1', port: 80 } });
    assert.deepEqual(networkWrites(), []);
    assert.ok(writes.some(w => w.path === '/api/reverse-proxies/services'));
});

test('delete: a targeted resource in a network the caller cannot edit refuses the whole delete', async () => {
    reset({ services: [svcWith('s1', ['resA', 'resB'])] });
    await assert.rejects(deleteProxyService('s1', only('netA')), is403);
    assert.deepEqual(writes, []);
});

test('delete: with edit rights the service and its targeted resources are deleted', async () => {
    reset({ services: [svcWith('s1', ['resA', 'resB'])] });
    const out = await deleteProxyService('s1', only('netA', 'netB'));
    assert.ok(writes.some(w => w.method === 'DELETE' && w.path === '/api/reverse-proxies/services/s1'));
    assert.ok(writes.some(w => w.method === 'DELETE' && w.path === '/api/networks/netA/resources/resA'));
    assert.ok(writes.some(w => w.method === 'DELETE' && w.path === '/api/networks/netB/resources/resB'));
    assert.deepEqual(out.cleanedResources.sort(), ['a.internal', 'b.internal']);
});

test('delete: a resource another service still uses is left alone and needs no rights', async () => {
    reset({ services: [svcWith('s1', ['resB']), svcWith('s2', ['resB'])] });
    await deleteProxyService('s1', only());
    assert.ok(writes.some(w => w.method === 'DELETE' && w.path === '/api/reverse-proxies/services/s1'));
    assert.deepEqual(networkWrites(), []);
});

test('disable: a targeted resource in a network the caller cannot edit refuses the update', async () => {
    reset({ services: [svcWith('s1', ['resB'])] });
    await assert.rejects(updateProxyService('s1', { enabled: false }, only('netA')), is403);
    assert.deepEqual(writes, []);
});

test('disable: with edit rights the service and its resource are disabled', async () => {
    reset({ services: [svcWith('s1', ['resB'])] });
    const out = await updateProxyService('s1', { enabled: false }, only('netB'));
    assert.ok(writes.some(w => w.method === 'PUT' && w.path === '/api/reverse-proxies/services/s1' && w.body.enabled === false));
    assert.ok(writes.some(w => w.method === 'PUT' && w.path === '/api/networks/netB/resources/resB' && w.body.enabled === false));
    assert.deepEqual(out.syncedResources, ['b.internal']);
});

test('enable / disable: a resource already in the requested state needs no network rights', async () => {
    reset({ services: [svcWith('s1', ['resB'], { enabled: false })] });
    await updateProxyService('s1', { enabled: true }, only());
    assert.deepEqual(networkWrites(), []);
    reset({ services: [svcWith('s1', ['resB'])] });
    state.resources.resB.enabled = false;
    await updateProxyService('s1', { enabled: false }, only());
    assert.deepEqual(networkWrites(), []);
});

test('enable: a disabled resource in a network the caller cannot edit refuses the update', async () => {
    reset({ services: [svcWith('s1', ['resB'], { enabled: false })] });
    state.resources.resB.enabled = false;
    await assert.rejects(updateProxyService('s1', { enabled: true }, only('netA')), is403);
    assert.deepEqual(writes, []);
});

test('update: a refused enabled change creates no container resource in the same edit', async () => {
    reset({ services: [svcWith('s1', ['resB'])] });
    const targets = [
        { type: 'domain', target_type: 'domain', id: 'resB', port: 80, protocol: 'http', enabled: true },
        { type: 'container', networkId: 'netA', containerDomain: 'x.internal', port: 81 },
    ];
    await assert.rejects(updateProxyService('s1', { enabled: false, targets }, only('netA')), is403);
    assert.deepEqual(writes, []);
});

test('update: disabling with a new container target also disables the resource created for it', async () => {
    reset({ services: [svcWith('s1', ['resA'])] });
    const targets = [
        { type: 'domain', target_type: 'domain', id: 'resA', port: 80, protocol: 'http', enabled: true },
        { type: 'container', networkId: 'netA', containerDomain: 'x.internal', port: 81 },
    ];
    const out = await updateProxyService('s1', { enabled: false, targets }, only('netA'));
    assert.deepEqual(out.syncedResources.sort(), ['a.internal', 'x.internal']);
});

test('a container target that reuses an existing resource needs no network rights', async () => {
    reset();
    const target = { type: 'container', networkId: 'netB', containerDomain: 'b.internal', port: 80 };
    await createProxyService({ domain: 'svc.example.com', cluster: 'c1', target }, only());
    assert.deepEqual(networkWrites(), []);
    const sent = writes.find(w => w.path === '/api/reverse-proxies/services');
    assert.equal(sent.body.targets[0].target_id, 'resB');
    reset({ services: [svcWith('s1', ['resA'])] });
    await updateProxyService('s1', { targets: [target] }, only());
    assert.deepEqual(networkWrites(), []);
});

test('update: a container target in a network the caller cannot edit creates nothing', async () => {
    reset({ services: [svcWith('s1', ['resA'])] });
    await assert.rejects(updateProxyService('s1', { targets: [{ type: 'container', networkId: 'netB', containerDomain: 'x.internal', port: 80 }] }, only('netA')), is403);
    assert.deepEqual(writes, []);
});

test('the same new container address twice in one request creates one resource for both targets', async () => {
    reset();
    const targets = [
        { type: 'container', networkId: 'netA', containerDomain: 'x.internal', port: 80 },
        { type: 'container', networkId: 'netA', containerDomain: 'x.internal', port: 80, path: '/admin' },
    ];
    await createProxyService({ domain: 'svc.example.com', cluster: 'c1', targets }, only('netA'));
    assert.equal(writes.filter(w => w.method === 'POST' && w.path === '/api/networks/netA/resources').length, 1);
    const sent = writes.find(w => w.path === '/api/reverse-proxies/services');
    assert.equal(sent.body.targets.length, 2);
    assert.equal(sent.body.targets[0].target_id, sent.body.targets[1].target_id);
});

test('update: a name-only edit needs no network rights', async () => {
    reset({ services: [svcWith('s1', ['resB'])] });
    await updateProxyService('s1', { name: 'renamed' });
    assert.deepEqual(networkWrites(), []);
    assert.ok(writes.some(w => w.method === 'PUT' && w.path === '/api/reverse-proxies/services/s1'));
});
