// Browser remote sessions are authorized by the portal, not by NetBird (NetBird only sees the
// gateway peer). These tests pin the fail-closed rules: only an enabled, posture-free accept
// rule from the user's own groups to the approved resource on the requested TCP port grants,
// and the gateway must route the address through that resource and nothing else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    evaluateUserAccess, gatewayReach, extraReach, pathStatus, ruleOpensTcpPort, parsePrefix, ipv4ToInt,
} = require('../lib/remote-access-auth');

const NOW = Date.parse('2026-11-03T12:00:00Z');
const LATER = '2026-11-03T18:00:00Z';
const EARLIER = '2026-11-03T06:00:00Z';

function base() {
    return {
        users: [
            { id: 'u1', auto_groups: ['g-staff'], is_blocked: false },
            { id: 'u2', auto_groups: [], is_blocked: false },
        ],
        peers: [
            { id: 'p-gw', name: 'browser-gateway', groups: [{ id: 'g-gw' }, { id: 'g-all' }], connected: true },
            { id: 'p-r1', name: 'router-1', groups: [{ id: 'g-all' }], connected: true },
            { id: 'p-u2', name: 'laptop', user_id: 'u2', groups: [{ id: 'g-laptops' }], connected: true },
        ],
        groups: [
            { id: 'g-all', name: 'All' }, { id: 'g-gw', name: 'Browser Gateway' }, { id: 'g-gwt', name: 'Browser Gateway Targets' },
            { id: 'g-staff', name: 'Staff' }, { id: 'g-srv', name: 'Servers' }, { id: 'g-laptops', name: 'Laptops' },
        ],
        networks: [
            { id: 'n1', name: 'Office', resources: ['r1', 'r-sub', 'r-dom'] },
            { id: 'n2', name: 'Lab', resources: ['r2'] },
        ],
        resources: [
            { id: 'r1', name: 'srv1', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-srv' }, { id: 'g-gwt' }] },
            { id: 'r-sub', name: 'office-lan', type: 'subnet', address: '10.0.1.0/24', enabled: true, groups: [{ id: 'g-gwt' }] },
            { id: 'r-dom', name: 'intranet', type: 'domain', address: 'intranet.example.com', enabled: true, groups: [{ id: 'g-intranet' }] },
            { id: 'r2', name: 'lab', type: 'subnet', address: '10.9.0.0/16', enabled: true, groups: [{ id: 'g-lab' }] },
        ],
        policies: [
            { id: 'pol-gw', name: 'Browser Gateway', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-gwt' }] }] },
            { id: 'pol-staff', name: 'Staff RDP', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-srv' }] }] },
        ],
        routes: [],
        grants: [],
    };
}
const CFG = { networks: ['n1'], gatewayGroupId: 'g-gw', managedPolicyId: 'pol-gw' };
const ask = (snap, o) => evaluateUserAccess(snap, CFG, { userId: 'u1', address: '10.0.0.5', port: 3389, now: NOW, ...o });

test('grants an enabled accept rule from the user group to the resource on the port', () => {
    const r = ask(base());
    assert.equal(r.ok, true);
    assert.equal(r.resource.id, 'r1');
    assert.deepEqual(r.policies, ['Staff RDP']);
});

test('denies a port the policy does not open', () => {
    assert.equal(ask(base(), { port: 22 }).code, 'PORT_NOT_ALLOWED');
});

test('ports and port_ranges are both honoured', () => {
    const rule = { protocol: 'tcp', ports: ['80'], port_ranges: [{ start: 3000, end: 3999 }] };
    assert.equal(ruleOpensTcpPort(rule, 3389), true);
    assert.equal(ruleOpensTcpPort(rule, 80), true);
    assert.equal(ruleOpensTcpPort(rule, 22), false);
    assert.equal(ruleOpensTcpPort({ protocol: 'udp' }, 3389), false);
    assert.equal(ruleOpensTcpPort({ protocol: 'all' }, 3389), true);
    assert.equal(ruleOpensTcpPort({ protocol: 'tcp', ports: '3389' }, 3389), false, 'unknown shape never grants');
});

test('posture-checked policies do not count for browser sessions', () => {
    const s = base();
    s.policies[1].source_posture_checks = ['pc1'];
    assert.equal(ask(s).code, 'POSTURE_REQUIRED');
});

test('disabled policies, disabled rules and drop rules', () => {
    let s = base(); s.policies[1].enabled = false;
    assert.equal(ask(s).code, 'NO_ACCESS');
    s = base(); s.policies[1].rules[0].enabled = false;
    assert.equal(ask(s).code, 'NO_ACCESS');
    s = base();
    s.policies.push({ id: 'pol-drop', name: 'Block', enabled: true, rules: [{ enabled: true, action: 'drop', protocol: 'all', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-srv' }] }] });
    assert.equal(ask(s).code, 'BLOCKED_BY_POLICY');
});

test('the managed gateway policy never grants a user', () => {
    const s = base();
    s.policies = [s.policies[0]];
    s.users[0].auto_groups = ['g-gw'];
    assert.equal(ask(s).code, 'NO_ACCESS');
});

test('blocked or unknown users are denied', () => {
    let s = base(); s.users[0].is_blocked = true;
    assert.equal(ask(s).code, 'USER_BLOCKED');
    s = base();
    assert.equal(ask(s, { userId: 'nobody' }).code, 'USER_NOT_FOUND');
});

test('groups of the user\'s peers and the All group count as sources', () => {
    const s = base();
    s.policies[1].rules[0].sources = [{ id: 'g-laptops' }];
    assert.equal(ask(s, { userId: 'u2' }).ok, true);
    s.policies[1].rules[0].sources = [{ id: 'g-all' }];
    assert.equal(ask(s, { userId: 'u2' }).ok, true);
});

test('addresses outside the selected networks or unknown are denied', () => {
    assert.equal(ask(base(), { address: '10.9.1.1' }).code, 'NETWORK_NOT_ENABLED');
    assert.equal(ask(base(), { address: '192.168.1.1' }).code, 'UNKNOWN_ADDRESS');
    assert.equal(ask(base(), { address: 'srv1.example.com' }).code, 'INVALID_ADDRESS');
    assert.equal(ask(base(), { address: '010.0.0.5' }).code, 'INVALID_ADDRESS');
    assert.equal(ask(base(), { port: 70000 }).code, 'INVALID_PORT');
});

test('a host inside a subnet resource matches that resource', () => {
    const s = base();
    s.policies[1].rules[0].destinations = [{ id: 'g-gwt' }];
    s.policies[1].rules[0].sources = [{ id: 'g-staff' }];
    const r = ask(s, { address: '10.0.1.20' });
    assert.equal(r.ok, true);
    assert.equal(r.resource.id, 'r-sub');
});

test('a disabled resource is denied', () => {
    const s = base(); s.resources[0].enabled = false;
    assert.equal(ask(s).code, 'RESOURCE_DISABLED');
});

test('two equally specific resources for the address are ambiguous', () => {
    const s = base();
    s.resources.push({ id: 'r1b', name: 'srv1-dup', type: 'host', address: '10.0.0.5', enabled: true, groups: [{ id: 'g-gwt' }] });
    s.networks[0].resources.push('r1b');
    assert.equal(ask(s).code, 'AMBIGUOUS_ROUTE');
});

test('another route the gateway receives that is as specific wins the routing and is denied', () => {
    const s = base();
    // An All-sourced policy hands the gateway a /32 in another network for the same ip.
    s.resources.push({ id: 'r-other', name: 'other', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-x' }] });
    s.networks[1].resources.push('r-other');
    s.policies.push({ id: 'pol-x', name: 'Everyone', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'all', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-x' }] }] });
    assert.equal(ask(s).code, 'AMBIGUOUS_ROUTE');
});

test('a less specific route the gateway receives (e.g. an exit-node default route) does not conflict', () => {
    const s = base();
    s.routes.push({ id: 'rt-exit', network: '0.0.0.0/0', enabled: true, groups: ['g-all'] });
    assert.equal(ask(s).ok, true);
});

test('a domain route reaching the gateway blocks every session', () => {
    let s = base();
    s.policies.push({ id: 'pol-d', name: 'Intranet', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-intranet' }] }] });
    assert.equal(ask(s).code, 'GATEWAY_DOMAIN_ROUTES');
    s = base();
    s.routes.push({ id: 'rt-d', domains: ['*.corp.example'], enabled: true, groups: ['g-all'] });
    assert.equal(ask(s).code, 'GATEWAY_DOMAIN_ROUTES');
});

test('a resource the gateway policy does not reach yet is not usable', () => {
    const s = base();
    s.resources[0].groups = [{ id: 'g-srv' }];
    assert.equal(ask(s).code, 'GATEWAY_NOT_SYNCED');
});

test('no enrolled gateway peer', () => {
    const s = base();
    s.peers = s.peers.filter(p => p.id !== 'p-gw');
    assert.equal(ask(s).code, 'GATEWAY_NOT_ENROLLED');
});

function withTempGrant(grant) {
    const s = base();
    s.policies[1].enabled = false; // only the temp grant can grant
    s.groups.push({ id: 'g-tmp', name: 'Temp access #7 (until 18:00)' });
    s.users[0].auto_groups = ['g-tmp'];
    s.policies.push({ id: 'pol-tmp', name: 'Temporary access #7', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', ports: ['3389'], sources: [{ id: 'g-tmp' }], destinations: [{ id: 'g-srv' }] }] });
    s.grants = grant ? [{ id: 7, user_id: 'u1', group_id: 'g-tmp', assigned_groups: ['g-tmp'], ...grant }] : [];
    return s;
}

test('a valid temporary grant grants', () => {
    assert.equal(ask(withTempGrant({ status: 'active', expires_at: LATER })).ok, true);
});

test('an expired temporary grant whose cleanup failed does not grant', () => {
    assert.equal(ask(withTempGrant({ status: 'active', expires_at: EARLIER })).ok, false);
});

test('a temporary grant with a revoke attempt does not grant, even before it expires', () => {
    assert.equal(ask(withTempGrant({ status: 'active', expires_at: LATER, revoke_requested_at: EARLIER })).ok, false);
});

test('a temporary grant still being created does not grant', () => {
    assert.equal(ask(withTempGrant({ status: 'creating', expires_at: LATER })).ok, false);
});

test('leftovers of a grant whose row is gone never count', () => {
    assert.equal(ask(withTempGrant(null)).ok, false);
});

test('a group joined through an invalid grant is not a standing source', () => {
    const s = base();
    s.policies[1].rules[0].sources = [{ id: 'g-ops' }];
    s.groups.push({ id: 'g-ops', name: 'Ops' });
    s.users[0].auto_groups = ['g-ops'];
    s.grants = [{ id: 9, user_id: 'u1', status: 'active', expires_at: EARLIER, group_id: '', assigned_groups: ['g-ops'] }];
    assert.equal(ask(s).ok, false);
    s.grants[0].expires_at = LATER;
    assert.equal(ask(s).ok, true);
});

test('extraReach lists routes beyond the selected networks', () => {
    const s = base();
    s.policies.push({ id: 'pol-x', name: 'Everyone', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'all', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-lab' }] }] });
    const reach = gatewayReach(s, CFG);
    assert.deepEqual(extraReach(reach).map(e => e.id), ['r2']);
});

test('pathStatus needs a connected gateway and an online enabled router', () => {
    const s = base();
    assert.equal(pathStatus(s, CFG, [{ peer: 'p-r1', enabled: true }]).ok, true);
    assert.equal(pathStatus(s, CFG, [{ peer: 'p-r1', enabled: false }]).code, 'NO_ROUTER_ONLINE');
    assert.equal(pathStatus(s, CFG, []).code, 'NO_ROUTER_ONLINE');
    s.peers[0].connected = false;
    assert.equal(pathStatus(s, CFG, [{ peer: 'p-r1', enabled: true }]).code, 'GATEWAY_OFFLINE');
});

test('prefix parsing', () => {
    assert.deepEqual(parsePrefix('10.0.0.5'), { start: ipv4ToInt('10.0.0.5'), end: ipv4ToInt('10.0.0.5'), bits: 32 });
    assert.equal(parsePrefix('10.0.1.7/24').start, ipv4ToInt('10.0.1.0'));
    assert.equal(parsePrefix('example.com'), null);
    assert.equal(parsePrefix('fe80::1/64'), null);
    assert.equal(parsePrefix('10.0.0.0/33'), null);
});
