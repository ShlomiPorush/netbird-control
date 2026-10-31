// A temporary grant mirrors its target's existing access, including the posture checks that
// gate it: a profile's checks and the checks on a resource's existing policy carry into the
// temporary policy, and targets gated differently never share one temporary policy.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client and the DB BEFORE db.js loads (it destructures these at require time).
const nb = require('../lib/netbird');
let policies = [], posts = [], nextId = 0, networkList = null;
const resources = {
    gated: { id: 'res-gated', name: 'gated', address: '10.0.0.1', groups: [{ id: 'grp-gated' }] },
    open: { id: 'res-open', name: 'open', address: '10.0.0.2', groups: [{ id: 'grp-open' }] },
};
nb.netbirdGet = async (path) => {
    if (path === '/api/users') return [{ id: 'user-1', role: 'user', auto_groups: [] }];
    if (path === '/api/policies') return typeof policies === 'function' ? policies() : JSON.parse(JSON.stringify(policies));
    if (path === '/api/networks/net1/resources') return networkList ? networkList() : Object.values(resources);
    const m = String(path).match(/^\/api\/networks\/net1\/resources\/(.+)$/);
    if (m) return Object.values(resources).find(r => r.id === decodeURIComponent(m[1])) || null;
    return [];
};
nb.netbirdPost = async (path, body) => { posts.push({ path, body }); return { status: 200, body: { id: `nb-${++nextId}` } }; };
nb.netbirdReq = async () => ({ status: 200, body: {} });
nb.bustNbCaches = () => { };
const core = require('../lib/core');
core.pool.query = async (sql) => {
    if (/nextval/.test(sql)) return { rows: [{ id: 501 }] };
    if (/FROM access_profiles/.test(sql)) {
        return { rows: [
            { id: 7, name: 'Payroll', group_id: 'grp-payroll', policy_id: 'pol-prof', sources: [], protocol: 'tcp', ports: '443', shared: true, posture_checks: ['pc-managed'] },
            { id: 8, name: 'Docs', group_id: 'grp-docs', policy_id: 'pol-wiki', sources: [], protocol: 'tcp', ports: '443', shared: true, posture_checks: [] },
            { id: 9, name: 'Lab', group_id: 'grp-lab', policy_id: 'pol-lab', sources: [], protocol: 'all', ports: '', shared: true, posture_checks: ['pc-os'] },
        ] };
    }
    if (/RETURNING id/.test(sql)) return { rows: [{ id: 501 }] };
    return { rows: [] };
};
const { createTemporaryAccessGrant } = require('../db');

const existing = (dest, pcs, ports = ['8443']) => ({
    name: 'Existing', enabled: true, source_posture_checks: pcs,
    rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports, destinations: [{ id: dest }] }],
});
const tempPolicies = () => posts.filter(p => p.path === '/api/policies').map(p => p.body);
const grant = (targets) => createTemporaryAccessGrant({ userId: 'user-1', durationMinutes: 60, targets }, { email: 'admin@example.test' });
const reset = (pols) => { policies = pols; posts = []; networkList = null; };

test('a profile target carries the profile posture checks into the temporary policy', async () => {
    reset([]);
    await grant([{ type: 'profile', id: '7', groupId: 'grp-payroll' }]);
    const [p] = tempPolicies();
    assert.deepEqual(p.source_posture_checks, ['pc-managed']);
    assert.deepEqual(p.rules[0].destinations, ['grp-payroll']);
});

test('a profile open on every protocol still carries its posture checks', async () => {
    reset([]);
    await grant([{ type: 'profile', id: '9', groupId: 'grp-lab' }]);
    const [p] = tempPolicies();
    assert.equal(p.rules[0].protocol, 'all');
    assert.deepEqual(p.source_posture_checks, ['pc-os']);
});

test('a profile without posture checks stays ungated', async () => {
    reset([]);
    await grant([{ type: 'profile', id: '8', groupId: 'grp-docs' }]);
    assert.deepEqual(tempPolicies()[0].source_posture_checks, []);
});

test('a resource target carries the posture checks of the policy it mirrors', async () => {
    reset([existing('grp-gated', [{ id: 'pc-managed' }])]);
    await grant([{ type: 'resource', id: 'res-gated', networkId: 'net1' }]);
    const [p] = tempPolicies();
    assert.deepEqual(p.source_posture_checks, ['pc-managed']);
    assert.deepEqual(p.rules[0].ports, ['8443']);
});

test('a policy that targets the resource directly passes its posture checks on', async () => {
    reset([{ name: 'Direct', enabled: true, source_posture_checks: ['pc-managed'],
        rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['22'], destinationResource: { id: 'res-open' } }] }]);
    await grant([{ type: 'resource', id: 'res-open', networkId: 'net1' }]);
    assert.deepEqual(tempPolicies()[0].source_posture_checks, ['pc-managed']);
});

test('a rule-pinned resource target keeps the posture checks of its existing policy', async () => {
    reset([existing('grp-gated', ['pc-managed'])]);
    await grant([{ type: 'resource', id: 'res-gated', networkId: 'net1', access: { tcp: ['8443'] } }]);
    assert.deepEqual(tempPolicies()[0].source_posture_checks, ['pc-managed']);
});

test('a rule-pinned port keeps the checks of the exposure that serves it, not of another port', async () => {
    const pols = [existing('grp-gated', ['pc-managed'], ['22']), existing('grp-gated', [], ['443'])];
    reset(pols);
    await grant([{ type: 'resource', id: 'res-gated', networkId: 'net1', access: { tcp: ['22'] } }]);
    assert.deepEqual(tempPolicies().map(p => p.source_posture_checks), [['pc-managed']]);
    reset(pols);
    await grant([{ type: 'resource', id: 'res-gated', networkId: 'net1', access: { tcp: ['443'] } }]);
    assert.deepEqual(tempPolicies().map(p => p.source_posture_checks), [[]]);
});

test('a rule-pinned profile target keeps the profile posture checks', async () => {
    reset([]);
    await grant([{ type: 'profile', id: '7', groupId: 'grp-payroll', access: { tcp: ['443'] } }]);
    assert.deepEqual(tempPolicies()[0].source_posture_checks, ['pc-managed']);
});

test('targets with the same ports but different posture checks get separate policies', async () => {
    reset([existing('grp-gated', ['pc-managed']), existing('grp-open', [])]);
    await grant([
        { type: 'resource', id: 'res-gated', networkId: 'net1' },
        { type: 'resource', id: 'res-open', networkId: 'net1' },
        { type: 'profile', id: '7', groupId: 'grp-payroll' },
        { type: 'profile', id: '8', groupId: 'grp-docs' },
    ]);
    const all = tempPolicies();
    assert.equal(all.length, 4); // {8443, 443} x {gated, ungated}
    for (const p of all) {
        const gated = p.source_posture_checks.length > 0;
        const dests = p.rules[0].destinations;
        if (dests.includes('grp-payroll')) assert.ok(gated);
        if (dests.includes('grp-docs')) assert.ok(!gated);
        // Never a gated and an ungated profile in one policy.
        assert.ok(!(dests.includes('grp-payroll') && dests.includes('grp-docs')));
    }
    // The two 8443 policies each hold one resource group of their own.
    const res = all.filter(p => p.rules[0].ports.includes('8443'));
    assert.equal(res.length, 2);
    assert.notDeepEqual(res[0].rules[0].destinations, res[1].rules[0].destinations);
});

test('a profile group that no profile owns is refused', async () => {
    reset([]);
    await assert.rejects(grant([{ type: 'profile', id: '99', groupId: 'grp-unknown' }]), /access profile not found/);
    await assert.rejects(grant([{ type: 'profile', id: '99', groupId: 'grp-unknown', access: { tcp: ['443'] } }]), /access profile not found/);
    assert.equal(tempPolicies().length, 0);
});

test('unreadable policies refuse a resource grant', async () => {
    for (const bad of [null, { message: 'unauthorized', code: 401 }]) {
        reset(() => bad);
        await assert.rejects(grant([{ type: 'resource', id: 'res-gated', networkId: 'net1' }]), /could not read the existing policies/);
        assert.equal(tempPolicies().length, 0);
    }
});

test('an unreadable resource list or a missing resource refuses the grant', async () => {
    reset([existing('grp-gated', ['pc-managed'])]);
    networkList = () => ({ message: 'timeout' });
    await assert.rejects(grant([{ type: 'resource', id: 'res-gated', networkId: 'net1' }]), /could not read the resources/);
    reset([existing('grp-gated', ['pc-managed'])]);
    await assert.rejects(grant([{ type: 'resource', id: 'res-gone', networkId: 'net1' }]), /was not found/);
    assert.equal(tempPolicies().length, 0);
});

test('readable but empty policies keep today\'s behavior for an unprotected resource', async () => {
    reset([]);
    await grant([{ type: 'resource', id: 'res-open', networkId: 'net1' }]);
    const [p] = tempPolicies();
    assert.equal(p.rules[0].protocol, 'all');
    assert.deepEqual(p.source_posture_checks, []);
});
