// Host names in browser remote access. A name that matches a NetBird domain resource is
// authorized by that resource's policies and goes through the names gateway (NetBird DNS on),
// which must reach the name through that resource only. Any other name is looked up and each
// IPv4 answer is checked like a typed IP. Input that is neither an IPv4 address nor a clean
// host name is refused, never cut down.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTarget, domainPattern, evaluateNameAccess } = require('../lib/remote-access-auth');
const ra = require('../lib/remote-access');
const { resolveTarget, connectArgs } = ra._internal;

const NOW = Date.parse('2026-11-03T12:00:00Z');

function base() {
    return {
        users: [{ id: 'u1', auto_groups: ['g-staff'], is_blocked: false }],
        peers: [
            { id: 'p-gw', name: 'browser-gateway', groups: [{ id: 'g-gw' }, { id: 'g-all' }], connected: true },
            { id: 'p-ngw', name: 'browser-gateway-names', groups: [{ id: 'g-ngw' }, { id: 'g-all' }], connected: true },
            { id: 'p-r1', name: 'router-1', groups: [{ id: 'g-all' }], connected: true },
        ],
        groups: [
            { id: 'g-all', name: 'All' }, { id: 'g-gw', name: 'Browser Gateway' }, { id: 'g-gwt', name: 'Browser Gateway Targets' },
            { id: 'g-ngw', name: 'Browser Gateway Names' }, { id: 'g-ngwt', name: 'Browser Gateway Name Targets' },
            { id: 'g-staff', name: 'Staff' }, { id: 'g-web', name: 'Web' }, { id: 'g-corp', name: 'Corp' }, { id: 'g-srv', name: 'Servers' },
        ],
        networks: [
            { id: 'n1', name: 'Office', resources: ['r-dom', 'r-wild', 'r-host'] },
            { id: 'n3', name: 'Elsewhere', resources: ['r-far'] },
        ],
        resources: [
            { id: 'r-dom', name: 'Safe', type: 'domain', address: 'MosesSafe.com', enabled: true, groups: [{ id: 'g-web' }, { id: 'g-ngwt' }] },
            { id: 'r-wild', name: 'Corp', type: 'domain', address: '*.corp.example', enabled: true, groups: [{ id: 'g-corp' }, { id: 'g-ngwt' }] },
            { id: 'r-host', name: 'srv', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-srv' }, { id: 'g-gwt' }] },
            { id: 'r-far', name: 'Far', type: 'domain', address: 'far.example.org', enabled: true, groups: [] },
        ],
        policies: [
            { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
            { id: 'pol-ngw', name: 'Browser Gateway (Names)', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-ngw' }], destinations: [{ id: 'g-ngwt' }] }] },
            { id: 'pol-web', name: 'Safe RDP', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [], destinationResource: { id: 'r-dom', type: 'domain' } }] },
            { id: 'pol-corp', name: 'Corp SSH', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['22'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-corp' }] }] },
            { id: 'pol-srv', name: 'Servers RDP', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] },
        ],
        routes: [],
        grants: [],
    };
}
const MANAGED = ['pol-gw', 'pol-ngw'];
const NAMES = { networks: ['n1'], gatewayGroupId: 'g-ngw', managedPolicyIds: MANAGED };
const IP = { networks: ['n1'], gatewayGroupId: 'g-gw', managedPolicyIds: MANAGED };
const ask = (snap, o) => evaluateNameAccess(snap, NAMES, { userId: 'u1', name: 'mosessafe.com', port: 3389, now: NOW, ...o });

test('input: IPv4 and clean host names pass, everything else is refused', () => {
    const ok = { '10.0.0.5': '10.0.0.5', 'MosesSafe.com.': 'mosessafe.com', ' srv.moses.local ': 'srv.moses.local', 'bücher.de': 'xn--bcher-kva.de' };
    for (const [input, out] of Object.entries(ok)) {
        const t = normalizeTarget(input);
        assert.equal(t.error, undefined, input);
        assert.equal(t.ip || t.name, out, input);
    }
    for (const bad of ['', '010.0.0.5', '127.1', '0x7f.1', '0177.0.0.1', '2130706433', 'x', 'srv', '*.corp.example', 'a_b.com',
        'https://mosessafe.com', 'mosessafe.com/path', 'mosessafe.com?x', 'mosessafe.com#x', 'mosessafe.com:3389', 'user@mosessafe.com',
        'mosessafe.com..', '-a.com', 'a-.com', 'x.1com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`]) {
        assert.equal(normalizeTarget(bad).error, 'INVALID_ADDRESS', bad);
    }
});

test('domain patterns: exact, and a wildcard covers one or more labels below its base only', () => {
    assert.deepEqual(domainPattern('*.Internal'), { wildcard: true, base: 'internal', rank: 1 });
    const s = base();
    assert.equal(ask(s, { name: 'a.corp.example', port: 22 }).ok, true);
    assert.equal(ask(s, { name: 'a.b.corp.example', port: 22 }).ok, true);
    assert.equal(ask(s, { name: 'corp.example', port: 22 }).code, 'NO_DOMAIN_MATCH');
});

test('a domain resource grants through its own policies, with NetBird semantics', () => {
    const r = ask(base());
    assert.equal(r.ok, true);
    assert.equal(r.resource.id, 'r-dom');
    assert.equal(r.resource.type, 'domain');
    assert.deepEqual(r.policies, ['Safe RDP']);
    assert.equal(ask(base(), { port: 22 }).code, 'PORT_NOT_ALLOWED');
    let s = base(); s.policies[2].source_posture_checks = ['pc1'];
    assert.equal(ask(s).code, 'POSTURE_REQUIRED');
    s = base(); s.policies.push({ id: 'pol-drop', name: 'Block', enabled: true, rules: [{ enabled: true, action: 'drop', protocol: 'all', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-web' }] }] });
    assert.equal(ask(s).code, 'BLOCKED_BY_POLICY');
    s = base(); s.resources[0].enabled = false;
    assert.equal(ask(s).code, 'RESOURCE_DISABLED');
});

test('the managed gateway policies never count as a user grant', () => {
    const s = base();
    s.users[0].auto_groups = ['g-ngw', 'g-gw'];
    s.policies = s.policies.filter(p => p.id !== 'pol-web');
    assert.equal(ask(s).code, 'NO_ACCESS');
});

test('exact beats a wildcard; equal matches in two open networks are ambiguous', () => {
    const s = base();
    s.resources.push({ id: 'r-exact', name: 'One', type: 'domain', address: 'one.corp.example', enabled: true, groups: [{ id: 'g-ngwt' }] });
    s.networks[0].resources.push('r-exact');
    const r = ask(s, { name: 'one.corp.example', port: 22 });
    assert.equal(r.resource.id, 'r-exact');
    assert.equal(r.code, 'NO_ACCESS', 'the exact resource decides, and it has no policy for this user');

    const t = base();
    t.networks.push({ id: 'n2', name: 'Second', resources: ['r-dom2'] });
    t.resources.push({ id: 'r-dom2', name: 'Safe 2', type: 'domain', address: 'mosessafe.com', enabled: true, groups: [{ id: 'g-ngwt' }] });
    assert.equal(evaluateNameAccess(t, { ...NAMES, networks: ['n1', 'n2'] }, { userId: 'u1', name: 'mosessafe.com', port: 3389, now: NOW }).code, 'AMBIGUOUS_ROUTE');
});

test('a name known only in a closed network is refused, not looked up', () => {
    assert.equal(ask(base(), { name: 'far.example.org' }).code, 'NETWORK_NOT_ENABLED');
    assert.equal(ask(base(), { name: 'unknown.example.net' }).code, 'NO_DOMAIN_MATCH');
});

test('names gateway reach: no address routes, no rival match, resource synced, gateway enrolled', () => {
    let s = base();
    s.policies.push({ id: 'pol-wide', name: 'Wide', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-srv' }] }] });
    assert.equal(ask(s).code, 'NAMES_GATEWAY_EXTRA_REACH', 'an address route could capture what the name resolves to');

    s = base();
    s.resources.push({ id: 'r-shadow', name: 'Shadow', type: 'domain', address: 'mosessafe.com', enabled: true, groups: [{ id: 'g-shadow' }] });
    s.networks[1].resources.push('r-shadow');
    s.policies.push({ id: 'pol-shadow', name: 'Shadow', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-shadow' }] }] });
    assert.equal(ask(s).code, 'AMBIGUOUS_ROUTE', 'a matching domain in a closed network that the gateway still receives');

    s = base();
    s.resources.push({ id: 'r-shadow', name: 'Shadow', type: 'domain', address: '*.com', enabled: true, groups: [{ id: 'g-shadow' }] });
    s.networks[1].resources.push('r-shadow');
    s.policies.push({ id: 'pol-shadow', name: 'Shadow', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-ngw' }], destinations: [{ id: 'g-shadow' }] }] });
    assert.equal(ask(s).ok, true, 'a broader wildcard elsewhere never takes an exact name');
    s.resources[s.resources.length - 1].address = 'mosessafe.com';
    assert.equal(ask(s).code, 'AMBIGUOUS_ROUTE', 'an equally specific match elsewhere');

    s = base();
    s.routes.push({ id: 'l1', enabled: true, domains: ['mosessafe.com'], groups: [{ id: 'g-all' }] });
    assert.equal(ask(s).code, 'AMBIGUOUS_ROUTE', 'a legacy domain route');

    s = base(); s.resources[0].groups = [{ id: 'g-web' }];
    assert.equal(ask(s).code, 'GATEWAY_NOT_SYNCED');

    s = base(); s.peers = s.peers.filter(p => p.id !== 'p-ngw');
    assert.equal(ask(s).code, 'NAMES_GATEWAY_NOT_ENROLLED');
});

const opts = (resolve4) => ({ ipCfg: IP, namesCfg: NAMES, resolve4 });
const fail = (code) => async () => { const e = new Error(code); e.code = code; throw e; };

test('a domain resource name goes to the names gateway, by name', async () => {
    const r = await resolveTarget(base(), 'u1', 'MosesSafe.com', 3389, opts(fail('ENOTFOUND')));
    assert.equal(r.ok, true);
    assert.equal(r.gateway, 'names');
    assert.equal(r.address, 'mosessafe.com');
});

test('any other name is looked up; each IPv4 answer is checked like a typed IP', async () => {
    let r = await resolveTarget(base(), 'u1', 'srv.office.example', 3389, opts(async () => ['192.0.2.1', '10.0.0.5']));
    assert.equal(r.ok, true);
    assert.equal(r.gateway, 'ip');
    assert.equal(r.address, '10.0.0.5', 'the first allowed answer');
    assert.equal(r.name, 'srv.office.example');

    r = await resolveTarget(base(), 'u1', 'srv.office.example', 3389, opts(async () => ['192.0.2.1', '192.0.2.2']));
    assert.equal(r.ok, false);
    assert.equal(r.verdict.code, 'UNKNOWN_ADDRESS', 'the first answer\'s reason');

    r = await resolveTarget(base(), 'u1', 'srv.office.example', 22, opts(async () => ['10.0.0.5']));
    assert.equal(r.verdict.code, 'PORT_NOT_ALLOWED');
});

test('lookup failures are told apart', async () => {
    const code = async (resolver) => (await resolveTarget(base(), 'u1', 'srv.office.example', 3389, opts(resolver))).verdict.code;
    assert.equal(await code(fail('ENOTFOUND')), 'NAME_NOT_FOUND');
    assert.equal(await code(fail('ENODATA')), 'NO_IPV4_ADDRESS');
    assert.equal(await code(fail('ETIMEOUT')), 'NAME_LOOKUP_FAILED');
    assert.equal(await code(fail('ESERVFAIL')), 'NAME_LOOKUP_FAILED');
    assert.equal(await code(async () => []), 'NO_IPV4_ADDRESS');
    assert.equal(await code(async () => ['not-an-ip']), 'NO_IPV4_ADDRESS');
    assert.equal((await resolveTarget(base(), 'u1', 'https://x.example', 3389, opts(fail('ENOTFOUND')))).verdict.code, 'INVALID_ADDRESS');
});

test('guacd gets an absolute name on the names gateway and the IP on the IP gateway', () => {
    const names = connectArgs({ protocol: 'rdp', gateway: 'names', address: 'mosessafe.com', port: 3389, creds: {}, timezone: '' }, ['hostname', 'port']);
    assert.deepEqual(names, ['mosessafe.com.', '3389']);
    const ip = connectArgs({ protocol: 'ssh', gateway: 'ip', address: '10.0.0.5', port: 22, creds: { username: 'a' }, timezone: '' }, ['hostname', 'username']);
    assert.deepEqual(ip, ['10.0.0.5', 'a']);
});

test('SSH host keys are kept per IPv4 address or per normalized host name', () => {
    const { normConfig } = ra._internal;
    const c = normConfig({ sshHostKeys: { '10.0.0.5': 'k1', 'Srv.Corp.Example.': 'k2', 'https://bad': 'k3', '*.corp.example': 'k4' } });
    assert.deepEqual(c.sshHostKeys, { '10.0.0.5': 'k1', 'srv.corp.example': 'k2' });
});

test('an SSH host key set for a name applies when the name was looked up to an IP', () => {
    ra._internal.setConfigForTest({ sshHostKeys: { 'srv.corp.example': 'ssh-ed25519 KEYNAME', '10.0.0.9': 'ssh-ed25519 KEYIP' } });
    const args = (s) => connectArgs({ protocol: 'ssh', creds: {}, timezone: '', port: 22, ...s }, ['hostname', 'host-key']);
    assert.deepEqual(args({ gateway: 'ip', address: '10.0.0.5', targetName: 'srv.corp.example' }), ['10.0.0.5', 'ssh-ed25519 KEYNAME']);
    assert.deepEqual(args({ gateway: 'ip', address: '10.0.0.9', targetName: '' }), ['10.0.0.9', 'ssh-ed25519 KEYIP']);
    assert.deepEqual(args({ gateway: 'names', address: 'srv.corp.example', targetName: 'srv.corp.example' }), ['srv.corp.example.', 'ssh-ed25519 KEYNAME']);
    ra._internal.setConfigForTest({});
});

test('a managed gateway policy never grants, even before its id was saved', () => {
    const s = base();
    s.users[0].auto_groups = ['g-ngw'];
    s.policies = s.policies.filter(p => p.id !== 'pol-web');
    // The ids are not known (an interrupted re-creation): the name still excludes it.
    const r = evaluateNameAccess(s, { ...NAMES, managedPolicyIds: [] }, { userId: 'u1', name: 'mosessafe.com', port: 3389, now: NOW });
    assert.equal(r.code, 'NO_ACCESS');
});
