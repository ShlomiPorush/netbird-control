// Auto-approval: a trusted entry's blocked resources and networks apply to everything a grant would reach.
// A network grant covers all of its resources, a resource lives in its network, and a profile
// grant covers every resource in the profile's group - so a blocked resource or network sends any
// request that contains it, or is inside it, to review. When the NetBird inventory can't be read
// consistently, such targets go to review too.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client and the DB BEFORE db.js loads (it destructures these at require time).
const nb = require('../lib/netbird');
const core = require('../lib/core');
core.pool.query = async () => ({ rows: [] });
let inv;     // what NetBird answers: { networks, resources }
let gate = null; // optional hook: (path) => Promise that settles the answer
nb.netbirdApiConfigured = () => true;
nb.netbirdGet = async (path) => {
    if (gate) return gate(path);
    if (path === '/api/networks') return JSON.parse(JSON.stringify(inv.networks));
    if (path === '/api/networks/resources') return JSON.parse(JSON.stringify(inv.resources));
    return null;
};
const db = require('../db');
const { setAutoApprovalConfig, _internal } = db;
const { autoApproveTargets } = _internal;
const refresh = () => (db.refreshAutoApprovalInventory ? db.refreshAutoApprovalInventory() : Promise.resolve());

const res = (id, groups) => ({ id, name: id, groups: groups.map(g => ({ id: g, name: g })) });
function baseInventory() {
    return {
        networks: [
            { id: 'net-a', name: 'A', resources: ['res-a', 'res-b'] },
            { id: 'net-c', name: 'C', resources: ['res-c'] },
            { id: 'net-e', name: 'E', resources: [] },
        ],
        resources: [res('res-a', ['grp-p']), res('res-b', ['grp-z']), res('res-c', ['grp-q'])],
    };
}
const R = (id, networkId) => ({ type: 'resource', id, name: id, networkId });
const N = (id) => ({ type: 'network', id, name: id });
const P = (id, groupId) => ({ type: 'profile', id, name: id, ...(groupId ? { groupId } : {}) });
const GROUPS = ['grp-trusted'];
const trusted = (excludedTargets, extra = {}) => ({ groupIds: ['grp-trusted'], maxMinutes: 0, excludedTargets, ...extra });

async function configure(trustedEntries, rules = []) {
    await setAutoApprovalConfig({ trusted: trustedEntries, rules });
}
function decide(targets) {
    const { auto, manual } = autoApproveTargets(targets, GROUPS);
    return { auto: auto.map(a => `${a.t.type}:${a.t.id}`), manual: manual.map(t => `${t.type}:${t.id}`) };
}
const isManual = (t) => decide([t]).manual.length === 1;
const isAuto = (t) => decide([t]).auto.length === 1;

test.beforeEach(() => { inv = baseInventory(); gate = null; });

test('a blocked resource also blocks its network and profiles whose group holds it', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }])]);
    await refresh();
    assert.ok(isManual(R('res-a', 'net-a')), 'the blocked resource itself');
    assert.ok(isManual(N('net-a')), 'network containing the blocked resource');
    assert.ok(isManual(P('11', 'grp-p')), 'profile whose group holds the blocked resource');
    assert.ok(isAuto(R('res-b', 'net-a')), 'sibling resource stays auto');
    assert.ok(isAuto(N('net-c')), 'unrelated network stays auto');
    assert.ok(isAuto(N('net-e')), 'known empty network stays auto');
    assert.ok(isAuto(P('12', 'grp-z')), 'unrelated profile stays auto');
});

test('a blocked network also blocks its resources (by the server-side network, not the sent one)', async () => {
    await configure([trusted([{ type: 'network', id: 'net-a' }])]);
    await refresh();
    assert.ok(isManual(N('net-a')));
    assert.ok(isManual(R('res-a', 'net-a')));
    assert.ok(isManual(R('res-a', 'net-c')), 'a wrong networkId in the request does not matter');
    assert.ok(isManual(R('res-a')), 'nor a missing one');
    assert.ok(isManual(P('11', 'grp-p')), 'profile holding a resource of the blocked network');
    assert.ok(isAuto(R('res-c', 'net-c')));
    assert.ok(isAuto(P('13', 'grp-q')));
});

test('unknown networks/resources and profiles without a group go to review when the entry has blocked targets', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }])]);
    await refresh();
    assert.ok(isManual(N('net-unknown')));
    assert.ok(isManual(R('res-unknown', 'net-c')));
    assert.ok(isManual(P('14')));
});

test('entries without blocked targets do not depend on the inventory', async () => {
    await configure([trusted([])]);
    inv.networks = null; // unreadable
    await refresh();
    assert.ok(isAuto(N('net-a')));
    assert.ok(isAuto(P('11', 'grp-p')));
    assert.ok(isAuto(R('res-unknown')));
    // Another entry for a different group, with blocked targets and a failing refresh.
    await configure([trusted([]), { groupIds: ['grp-other'], maxMinutes: 0, excludedTargets: [{ type: 'resource', id: 'res-a' }] }]);
    await refresh();
    assert.ok(isAuto(N('net-a')));
});

test('of two matching entries, the one that does not block the target still auto-approves it', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }]), trusted([])]);
    await refresh();
    assert.ok(isAuto(N('net-a')));
});

test('an exact self-service rule still auto-approves a target a trusted entry blocks', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }])], [{ targets: [N('net-a')], groupIds: ['grp-trusted'], maxMinutes: 60 }]);
    await refresh();
    assert.ok(isAuto(N('net-a')));
});

test('unreadable or inconsistent inventory sends non-exact targets to review', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }])]);
    const cases = {
        'networks unreadable': (i) => { i.networks = null; },
        'resources unreadable': (i) => { i.resources = { error: 'forbidden' }; },
        'resource missing from its network list': (i) => { i.resources.push(res('res-x', ['grp-z'])); },
        'network lists an unlisted resource': (i) => { i.networks[0].resources.push('res-y'); },
        'resource with unreadable group data': (i) => { i.resources[1].groups = 'n/a'; },
    };
    for (const [name, mutate] of Object.entries(cases)) {
        inv = baseInventory();
        await refresh();
        assert.ok(isAuto(N('net-c')), `${name}: baseline is auto`);
        mutate(inv);
        await refresh();
        assert.ok(isManual(N('net-c')), `${name}: network goes to review`);
        assert.ok(isManual(P('12', 'grp-z')), `${name}: profile goes to review`);
        assert.ok(isManual(R('res-c', 'net-c')), `${name}: resource goes to review`);
    }
});

test('null lists from NetBird mean empty: an empty network or an ungrouped resource keeps the inventory usable', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }])]);
    inv.networks[2].resources = null;  // net-e has no resources
    inv.resources[2].groups = null;    // res-c is in no group
    await refresh();
    assert.ok(isAuto(N('net-e')));
    assert.ok(isAuto(R('res-c', 'net-c')));
    assert.ok(isAuto(P('12', 'grp-z')));
    assert.ok(isManual(N('net-a')));
    assert.ok(isManual(P('11', 'grp-p')));
});

test('when no resource carries group data, profiles go to review but networks and resources are still decided', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }])]);
    for (const r of inv.resources) r.groups = null;
    await refresh();
    assert.ok(isManual(P('12', 'grp-z')));
    assert.ok(isAuto(N('net-c')));
    assert.ok(isManual(N('net-a')));
});

test('never refreshed, too old, or a failed refresh after a success sends targets to review', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }])]);
    // A failed refresh clears an earlier good inventory.
    await refresh();
    assert.ok(isAuto(P('12', 'grp-z')));
    inv.resources[0].groups.push({ id: 'grp-z' }); // res-a joins grp-z...
    inv.networks = null;                             // ...and the next read fails
    await refresh();
    assert.ok(isManual(P('12', 'grp-z')));
    // A fresh read sees the new membership.
    inv = baseInventory();
    inv.resources[0].groups.push({ id: 'grp-z' });
    await refresh();
    assert.ok(isManual(P('12', 'grp-z')));
    // An inventory older than the freshness window is not used.
    inv = baseInventory();
    await refresh();
    assert.ok(isAuto(N('net-c')));
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + 31_000;
        assert.ok(isManual(N('net-c')));
    } finally { Date.now = realNow; }
});

test('a slower, older refresh never overwrites a newer one', async () => {
    await configure([trusted([{ type: 'resource', id: 'res-a' }])]);
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen; // both attempts start in the same millisecond
    try {
        for (const newerSucceeds of [true, false]) {
            const pending = [];
            gate = (path) => new Promise(resolve => pending.push({ path, resolve }));
            const older = refresh();
            const newer = refresh();
            const settle = (attempt, ok) => {
                for (const p of pending.filter(x => x.attempt === attempt)) {
                    const good = baseInventory();
                    p.resolve(!ok ? null : p.path === '/api/networks' ? good.networks : good.resources);
                }
            };
            pending.forEach((p, i) => { p.attempt = i < 2 ? 'older' : 'newer'; });
            settle('newer', newerSucceeds);
            await newer;
            settle('older', !newerSucceeds);
            await older;
            gate = null;
            if (newerSucceeds) assert.ok(isAuto(N('net-c')), 'newer success kept');
            else assert.ok(isManual(N('net-c')), 'newer failure kept');
        }
    } finally { Date.now = realNow; }
});
