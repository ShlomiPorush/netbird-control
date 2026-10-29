// Policies → Duplicate and the single-rule editor. A duplicate must reproduce the source policy's
// access exactly: rebuilding one rule from the form would merge several rules into one, turn a
// disabled rule on, and drop SSH authorized groups - a silent permission change. Editing a
// single-rule policy must keep the rule fields the editor doesn't show.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client BEFORE db.js loads (it destructures these at require time).
const nb = require('../lib/netbird');
let stored = {}, sent = [];
nb.netbirdGet = async (path) => {
    const id = decodeURIComponent(String(path).split('/').pop());
    return stored[id] ? JSON.parse(JSON.stringify(stored[id])) : null;
};
// Per-test failure injection: statuses to answer the next POST / non-GET calls with (FIFO);
// -1 answers status 0, which is what the client returns on a network error or timeout.
const failNext = { post: [], req: [] };
nb.netbirdPost = async (path, body) => { sent.push({ method: 'POST', path, body }); const f = failNext.post.shift(); const st = f === -1 ? 0 : (f || 200); return { status: st, body: { id: 'new1' } }; };
nb.netbirdReq = async (method, path, body) => { sent.push({ method, path, body }); const f = failNext.req.shift(); const st = f === -1 ? 0 : (f || 200); return { status: st, body: {} }; };
nb.bustNbCaches = () => { };
const { createPolicy, updatePolicy, _internal } = require('../db');
const { carryRuleExtras, ruleHasUnmodeled } = _internal;

const g = (id) => ({ id, name: id.toUpperCase() });
const sshRule = {
    id: 'r1', name: 'ssh', description: 'admins over ssh', enabled: true, action: 'accept', bidirectional: false,
    protocol: 'netbird-ssh', ports: [], sources: [g('admins')], destinations: [g('servers')],
    authorized_groups: { admins: ['root'] },
};
const offRule = {
    id: 'r2', name: 'web', description: '', enabled: false, action: 'drop', bidirectional: true,
    protocol: 'tcp', ports: ['443'], port_ranges: [{ start: 8000, end: 8100 }], sources: [g('all')], destinations: [g('web')],
};

test('duplicate copies every rule verbatim: count, per-rule enabled/action, SSH, port ranges', async () => {
    stored = { p1: { id: 'p1', name: 'Src', enabled: true, rules: [sshRule, offRule] } };
    sent = [];
    const before = JSON.stringify(stored.p1);
    // The form sends its (partial) view of the first rule too - here an SSH protocol it can't express.
    await createPolicy({ name: 'Src (copy)', description: 'd', enabled: true, postureChecks: ['pc1'], rulesFromPolicyId: 'p1', protocol: 'netbird-ssh', sources: ['admins'], destinations: ['servers'], ports: [] });
    const { method, path, body } = sent[0];
    assert.equal(method, 'POST');
    assert.equal(path, '/api/policies');
    assert.equal(body.name, 'Src (copy)');
    assert.deepEqual(body.source_posture_checks, ['pc1']);
    assert.equal(body.rules.length, 2);
    const [a, b] = body.rules;
    assert.deepEqual(a.authorized_groups, { admins: ['root'] });
    assert.deepEqual(a.sources, ['admins']);
    assert.equal(b.enabled, false);
    assert.equal(b.action, 'drop');
    assert.deepEqual(b.port_ranges, [{ start: 8000, end: 8100 }]);
    assert.equal('id' in a || 'id' in b, false); // rule ids never reused
    assert.equal(JSON.stringify(stored.p1), before); // source untouched
});

test('duplicate of a missing policy fails before any write', async () => {
    stored = {};
    sent = [];
    await assert.rejects(createPolicy({ name: 'x', rulesFromPolicyId: 'nope' }), /not found/);
    assert.equal(sent.length, 0);
});

test('editing a single-rule policy keeps rule fields the editor does not show', async () => {
    stored = { p2: { id: 'p2', name: 'Web', enabled: true, rules: [{ ...sshRule, protocol: 'tcp', ports: ['22'] }] } };
    sent = [];
    await updatePolicy('p2', { name: 'Web', enabled: true, sources: ['admins', 'ops'], destinations: ['servers'], protocol: 'tcp', ports: ['22'] });
    const rule = sent.find((s) => s.method === 'PUT').body.rules[0];
    assert.deepEqual(rule.authorized_groups, { admins: ['root'] });
    assert.deepEqual(rule.sources, ['admins', 'ops']); // the edit wins
});

test('rebuilding a netbird-ssh rule is refused instead of turning it into allow-all', async () => {
    stored = { p3: { id: 'p3', name: 'SSH', enabled: true, rules: [sshRule] } };
    sent = [];
    await assert.rejects(updatePolicy('p3', { name: 'SSH', enabled: true, sources: ['admins'], destinations: ['servers'], protocol: 'netbird-ssh', ports: [] }),
        (e) => e.status === 400 && /netbird-ssh/.test(e.message));
    assert.equal(sent.length, 0);
    // The name-only path (preserveRules) still works and keeps the rule as it is.
    await updatePolicy('p3', { name: 'SSH 2', enabled: true, preserveRules: true });
    const rule = sent.find((s) => s.method === 'PUT').body.rules[0];
    assert.equal(rule.protocol, 'netbird-ssh');
    assert.deepEqual(rule.authorized_groups, { admins: ['root'] });
});

test('carryRuleExtras: edited fields win, sourceResource dropped once group sources are set', () => {
    const existing = { id: 'r', sources: [], sourceResource: { id: 'res1', type: 'host' }, authorized_groups: { a: [] }, future_field: 1 };
    assert.deepEqual(carryRuleExtras(existing, { sources: ['g1'], destinations: ['g2'] }),
        { authorized_groups: { a: [] }, future_field: 1, sources: ['g1'], destinations: ['g2'] });
    assert.deepEqual(carryRuleExtras(existing, { sources: [], destinations: ['g2'] }).sourceResource, { id: 'res1', type: 'host' });
    assert.deepEqual(carryRuleExtras(null, { sources: ['g1'] }), { sources: ['g1'] });
});

test('ruleHasUnmodeled ignores empty values and modeled keys', () => {
    assert.equal(ruleHasUnmodeled(offRule), false);
    assert.equal(ruleHasUnmodeled({ ...offRule, sourceResource: null, authorized_groups: {} }), false);
    assert.equal(ruleHasUnmodeled(sshRule), true);
    assert.equal(ruleHasUnmodeled({ sourceResource: { id: 'x' } }), true);
    assert.equal(ruleHasUnmodeled({ protocol: 'netbird-ssh' }), true); // the editor can't express it
});

test('a failed or empty policy read stops the save before any write (both paths)', async () => {
    stored = {};
    sent = [];
    await assert.rejects(updatePolicy('gone', { name: 'x', enabled: true, sources: ['a'], destinations: ['b'], protocol: 'all', ports: [] }), /nothing was changed/);
    await assert.rejects(updatePolicy('gone', { name: 'x', enabled: true, preserveRules: true }), /nothing was changed/);
    stored = { empty: { id: 'empty', name: 'E', rules: [] } };
    await assert.rejects(updatePolicy('empty', { name: 'x', enabled: true, preserveRules: true }), /nothing was changed/);
    assert.equal(sent.length, 0);
});

test('the single-rule rebuild is refused for a Drop rule, a disabled rule, or several rules', async () => {
    const plain = { id: 'r', name: 'x', enabled: true, action: 'accept', protocol: 'tcp', ports: ['22'], sources: [g('a')], destinations: [g('b')] };
    const cfg = { name: 'P', enabled: true, sources: ['a'], destinations: ['b'], protocol: 'tcp', ports: ['22'] };
    stored = {
        drop: { id: 'drop', name: 'P', enabled: true, rules: [{ ...plain, action: 'drop' }] },
        off: { id: 'off', name: 'P', enabled: true, rules: [{ ...plain, enabled: false }] },
        many: { id: 'many', name: 'P', enabled: true, rules: [plain, { ...plain, ports: ['80'] }] },
    };
    sent = [];
    await assert.rejects(updatePolicy('drop', cfg), (e) => e.status === 400 && /Drop rule/.test(e.message));
    await assert.rejects(updatePolicy('off', cfg), (e) => e.status === 400 && /status differs/.test(e.message));
    await assert.rejects(updatePolicy('many', cfg), (e) => e.status === 400 && /several rules/.test(e.message));
    assert.equal(sent.length, 0);
});

test('merge / move are refused when a policy uses an affected resource as its source', () => {
    const { policiesSourcingResources } = _internal;
    const pols = [
        { id: 'a', name: 'From NAS', rules: [{ sourceResource: { id: 'res1', type: 'host' }, destinations: [g('x')] }] },
        { id: 'b', name: 'To NAS', rules: [{ sources: [g('x')], destinationResource: { id: 'res1' } }] },
        { id: 'c', name: 'Other', rules: [{ sourceResource: { id: 'res9' } }] },
    ];
    assert.deepEqual(policiesSourcingResources(pols, ['res1']), ['From NAS']);
    assert.deepEqual(policiesSourcingResources(pols, ['res2']), []);
    assert.deepEqual(policiesSourcingResources(null, ['res1']), []);
});

test('an editor payload never widens an unknown protocol to all', async () => {
    const { editorProtocol } = _internal;
    assert.equal(editorProtocol(undefined), 'all');
    assert.equal(editorProtocol('tcp'), 'tcp');
    assert.throws(() => editorProtocol('netbird-ssh'), (e) => e.status === 400);
    sent = [];
    // A pasted SSH policy saved through the create path is refused, not created as allow-all.
    await assert.rejects(createPolicy({ name: 'x', enabled: true, sources: ['a'], destinations: ['b'], protocol: 'netbird-ssh', ports: [] }), (e) => e.status === 400);
    assert.equal(sent.length, 0);
});

test('the resource editor may not replace policies it cannot reproduce (checked before any write)', async () => {
    const { checkResourcePolicySync } = require('../db');
    const dest = { destinationResource: { id: 'res1', type: 'host' } };
    const plain = { id: 'q1', name: 'Plain', enabled: true, rules: [{ name: 'p', enabled: true, action: 'accept', protocol: 'tcp', ports: ['443'], sources: [g('a')], ...dest }] };
    const ssh = { id: 'q2', name: 'SSH To Res', enabled: true, rules: [{ name: 's', enabled: true, action: 'accept', protocol: 'netbird-ssh', sources: [g('a')], authorized_groups: { a: ['root'] }, ...dest }] };
    sent = [];
    stored = { policies: [plain] };
    assert.deepEqual((await checkResourcePolicySync('res1', [{ sources: ['a'], protocol: 'tcp', ports: ['443'] }])).map((p) => p.id), ['q1']);
    stored = { policies: [plain, ssh] };
    await assert.rejects(checkResourcePolicySync('res1', []), (e) => e.status === 409 && /SSH To Res/.test(e.message));
    await assert.rejects(checkResourcePolicySync('res1', [{ sources: ['a'], protocol: 'netbird-ssh' }]), (e) => e.status === 400);
    stored = {}; // unreadable policy list
    await assert.rejects(checkResourcePolicySync('res1', []), /nothing was changed/);
    assert.equal(sent.length, 0);
});

test('merge stops with nothing written when the policy list cannot be read', async () => {
    const { mergeResources } = require('../db');
    stored = { networks: [{ id: 'n1', resources: ['r1', 'r2'] }], resources: [{ id: 'r1', name: 'A', address: '10.0.0.5' }, { id: 'r2', name: 'B', address: '10.0.0.5' }] };
    sent = [];
    await assert.rejects(mergeResources('n1', ['r1', 'r2'], 'r1'), /nothing was changed/);
    assert.equal(sent.length, 0);
});

test('creating a resource with an unusable policy is refused before the resource is created', async () => {
    const { createClientResource } = require('../db');
    sent = [];
    await assert.rejects(createClientResource('n1', { name: 'NAS', address: '10.0.0.9', groups: [], allowBlocked: true, policies: [{ sources: ['a'], protocol: 'netbird-ssh' }] }), (e) => e.status === 400);
    assert.equal(sent.length, 0);
});

test('resource policy sync: a refused delete fails (no silent success), and a later failure is marked partial', async () => {
    const { syncResourcePolicies } = require('../db');
    const dest = { destinationResource: { id: 'res1', type: 'host' } };
    const plain = { id: 'q1', name: 'Plain', enabled: true, rules: [{ name: 'p', enabled: true, action: 'accept', protocol: 'tcp', ports: ['443'], sources: [g('a')], ...dest }] };
    stored = { policies: [plain], res1: { id: 'res1', name: 'NAS', type: 'host' } };
    const want = [{ sources: ['a'], protocol: 'tcp', ports: ['443'] }, { sources: ['b'], protocol: 'tcp', ports: ['22'] }];
    // DELETE answered 403: nothing was changed, and the caller hears about it.
    sent = []; failNext.req = [403]; failNext.post = [];
    await assert.rejects(syncResourcePolicies('n1', 'res1', want), (e) => /refused to remove/.test(e.message) && e.partial === false);
    assert.equal(sent.filter((x) => x.method === 'POST').length, 0);
    // Delete OK, first create OK, second create fails: reported as a PARTIAL change.
    sent = []; failNext.req = []; failNext.post = [200, 500];
    await assert.rejects(syncResourcePolicies('n1', 'res1', want), (e) => e.partial === true);
    failNext.post = [];
});

test('resource sync: a mixed policy with a disabled rule for this resource blocks the replace', async () => {
    const { checkResourcePolicySync } = require('../db');
    const mixed = { id: 'm1', name: 'Mixed', enabled: true, rules: [
        { name: 'x', enabled: false, action: 'accept', protocol: 'tcp', ports: ['443'], sources: [g('a')], destinationResource: { id: 'res1' } },
        { name: 'y', enabled: true, action: 'accept', protocol: 'tcp', ports: ['443'], sources: [g('a')], destinationResource: { id: 'res2' } },
    ] };
    stored = { policies: [mixed] };
    await assert.rejects(checkResourcePolicySync('res1', [{ sources: ['a'], protocol: 'tcp', ports: ['443'] }]), (e) => e.status === 409 && /Mixed/.test(e.message));
});

test('resource sync: a network error (status 0) on delete or create is a failure, not a success', async () => {
    const { syncResourcePolicies } = require('../db');
    const plain = { id: 'q1', name: 'Plain', enabled: true, rules: [{ name: 'p', enabled: true, action: 'accept', protocol: 'tcp', ports: ['443'], sources: [g('a')], destinationResource: { id: 'res1', type: 'host' } }] };
    stored = { policies: [plain], res1: { id: 'res1', name: 'NAS', type: 'host' } };
    const want = [{ sources: ['a'], protocol: 'tcp', ports: ['443'] }];
    sent = []; failNext.req = [-1]; failNext.post = [];
    await assert.rejects(syncResourcePolicies('n1', 'res1', want), (e) => e.partial === false);
    assert.equal(sent.filter((x) => x.method === 'POST').length, 0);
    sent = []; failNext.req = []; failNext.post = [-1];
    await assert.rejects(syncResourcePolicies('n1', 'res1', want), (e) => e.partial === true && /Failed to create policy/.test(e.message));
    failNext.post = [];
});
