// Access Check answers "does this user have access to that resource?" the way NetBird enforces
// it: per device groups, the most specific route wins, accepts minus drops on the winner,
// temporary grants exactly as NetBird holds them, and posture-gated policies as "conditional".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { explainUserAccess, whoHasAccess, accessCheckOptions, networksForTarget, normalizeQuery, _internal } = require('../lib/access-check');

const NOW = Date.parse('2026-11-05T12:00:00Z');
const LATER = '2026-11-05T18:00:00Z';
const EARLIER = '2026-11-05T06:00:00Z';

const rule = (o) => ({ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-staff' }], ...o });
const pol = (id, rules, o = {}) => ({ id, name: o.name || id, enabled: true, rules, ...o });

function base() {
    return {
        users: [
            { id: 'u1', name: 'Dana', email: 'dana@example.com', auto_groups: ['g-staff'] },
            { id: 'u2', name: 'Avi', email: 'avi@example.com', auto_groups: [] },
            { id: 'svc', name: 'Robot', is_service_user: true, auto_groups: [] },
        ],
        peers: [
            { id: 'p1', name: 'dana-laptop', user_id: 'u1', groups: [{ id: 'g-staff' }], connected: true },
            { id: 'p2', name: 'avi-laptop', user_id: 'u2', groups: [{ id: 'g-other' }], connected: true },
            { id: 'p-r1', name: 'router-1', groups: [{ id: 'g-routers' }], connected: true },
            { id: 'p-r2', name: 'router-2', groups: [], connected: true },
        ],
        groups: [
            { id: 'g-all', name: 'All' }, { id: 'g-staff', name: 'Staff' }, { id: 'g-other', name: 'Other' },
            { id: 'g-srv', name: 'Servers' }, { id: 'g-routers', name: 'Routers', peers: [{ id: 'p-r1' }] },
        ],
        networks: [
            { id: 'n1', name: 'Office', resources: ['r1', 'r-lan'] },
            { id: 'n2', name: 'Lab', resources: ['r-lab'] },
        ],
        resources: [
            { id: 'r1', name: 'srv1', type: 'host', address: '10.0.0.5/32', enabled: true, groups: [{ id: 'g-srv' }] },
            { id: 'r-lan', name: 'office-lan', type: 'subnet', address: '10.0.1.0/24', enabled: true, groups: [] },
            { id: 'r-lab', name: 'lab', type: 'subnet', address: '10.9.0.0/16', enabled: true, groups: [] },
        ],
        policies: [pol('pol-rdp', [rule({ ports: ['3389'], destinations: [{ id: 'g-srv' }] })], { name: 'Staff RDP' })],
        routes: [],
        grants: [],
        bypassed: new Set(),
        postureChecks: [{ id: 'pc-1', name: 'Min Version' }],
        routers: new Map([['n1', [{ id: 'rt1', peer_groups: ['g-routers'], enabled: true }]], ['n2', [{ id: 'rt2', peer: 'p-r2', enabled: true }]]]),
        managedPolicyIds: [],
    };
}

const userCheck = (snap, o = {}) => explainUserAccess(snap, { userId: 'u1', target: { type: 'resource', id: 'r1' }, now: NOW, ...o });

test('grants through a policy from a device group to the resource group', () => {
    const r = userCheck(base());
    assert.equal(r.verdict, 'granted');
    const part = r.devices[0].answer.parts[0];
    assert.equal(part.winner.id, 'r1');
    assert.deepEqual(part.allowed.tcp, '3389');
    assert.equal(part.grantedBy[0].policy, 'Staff RDP');
    assert.deepEqual(part.grantedBy[0].via, ['Staff']);
    assert.equal(r.routers[0].status, 'online');
});

test('a queried port the policy does not open is port_blocked, an open one is granted', () => {
    assert.equal(userCheck(base(), { query: { protocol: 'tcp', port: 22 } }).verdict, 'port_blocked');
    assert.equal(userCheck(base(), { query: { protocol: 'tcp', port: 3389 } }).verdict, 'granted');
    assert.equal(userCheck(base(), { query: { protocol: 'udp' } }).verdict, 'port_blocked');
    assert.equal(userCheck(base(), { query: { protocol: 'icmp' } }).verdict, 'port_blocked');
});

test('the All group counts for every device', () => {
    const s = base();
    s.policies = [pol('p-all', [rule({ protocol: 'all', sources: [{ id: 'g-all' }], destinationResource: { id: 'r1', type: 'host' } })])];
    const r = explainUserAccess(s, { userId: 'u2', target: { type: 'resource', id: 'r1' }, now: NOW });
    assert.equal(r.verdict, 'granted');
    assert.equal(r.devices[0].answer.parts[0].allowed.icmp, true);
});

test('a direct device source (sourceResource peer) hits only that device', () => {
    const s = base();
    s.policies = [pol('p-dev', [rule({ sources: [], sourceResource: { id: 'p2', type: 'peer' }, destinationResource: { id: 'r1' } })])];
    assert.equal(explainUserAccess(s, { userId: 'u2', target: { type: 'resource', id: 'r1' }, now: NOW }).verdict, 'granted');
    assert.equal(userCheck(s).verdict, 'denied');
});

test('disabled policies and disabled rules do not count; unknown actions are ignored', () => {
    for (const mut of [
        (s) => { s.policies[0].enabled = false; },
        (s) => { s.policies[0].rules[0].enabled = false; },
        (s) => { s.policies[0].rules[0].action = 'log'; },
    ]) {
        const s = base();
        mut(s);
        assert.equal(userCheck(s).verdict, 'denied');
    }
});

test('user auto_groups never count for a device: no device in the group gives pending', () => {
    const s = base();
    s.peers[0].groups = [{ id: 'g-other' }];
    const r = userCheck(s);
    assert.equal(r.verdict, 'pending');
    assert.equal(r.pendingAs, 'granted');
});

test('a user with no devices and no matching groups is denied, not pending', () => {
    const r = explainUserAccess(base(), { userId: 'u2', target: { type: 'resource', id: 'r1' }, now: NOW });
    assert.equal(r.verdict, 'denied');
    const s = base();
    s.peers = s.peers.filter(p => p.user_id !== 'u2');
    const r2 = explainUserAccess(s, { userId: 'u2', target: { type: 'resource', id: 'r1' }, now: NOW });
    assert.equal(r2.verdict, 'denied');
    assert.equal(r2.reason, 'no_devices');
});

test('a user with no devices but granting auto_groups is pending', () => {
    const s = base();
    s.peers = s.peers.filter(p => p.user_id !== 'u1');
    const r = userCheck(s);
    assert.equal(r.verdict, 'pending');
    assert.equal(r.reason, 'no_devices');
});

test('a blocked user is denied even with granting auto_groups and no devices', () => {
    const s = base();
    s.users[0].is_blocked = true;
    assert.equal(userCheck(s).verdict, 'denied');
    assert.equal(userCheck(s).reason, 'user_blocked');
    s.peers = s.peers.filter(p => p.user_id !== 'u1');
    assert.equal(userCheck(s).verdict, 'denied');
});

test('a temporary grant that ended is still counted (NetBird still has it) and flagged', () => {
    const s = base();
    s.groups.push({ id: 'g-temp', name: 'Temp access #7 Dana' });
    s.peers[0].groups = [{ id: 'g-temp' }];
    s.policies = [pol('p-temp', [rule({ sources: [{ id: 'g-temp' }], destinationResource: { id: 'r1' } })], { name: 'Temporary access #7' })];
    s.grants = [{ id: 7, user_id: 'u1', status: 'active', expires_at: EARLIER, revoke_requested_at: null }];
    const r = userCheck(s);
    assert.equal(r.verdict, 'granted');
    assert.equal(r.devices[0].answer.parts[0].grantedBy[0].temp.state, 'ended');
    s.grants = [{ id: 7, user_id: 'u1', status: 'active', expires_at: LATER, revoke_requested_at: null }];
    const live = userCheck(s).devices[0].answer.parts[0].grantedBy[0].temp;
    assert.equal(live.state, 'active');
    assert.equal(live.expiresAt, LATER);
    s.grants[0].expires_at = EARLIER;
    const who = whoHasAccess(s, { target: { type: 'resource', id: 'r1' }, now: NOW });
    assert.equal(who.users.find(u => u.user.id === 'u1').devices[0].endedGrant, true);
});

test('a broader resource in another network covers a host target and is labelled overlapping', () => {
    const s = base();
    s.resources.push({ id: 'r-wide', name: 'office-wide', address: '10.0.0.0/16', enabled: true, groups: [] });
    s.networks[1].resources.push('r-wide');
    s.policies = [pol('p-wide', [rule({ ports: ['443'], destinationResource: { id: 'r-wide' } })])];
    const r = userCheck(s);
    assert.equal(r.verdict, 'granted');
    const part = r.devices[0].answer.parts[0];
    assert.equal(part.winner.id, 'r-wide');
    assert.equal(part.overlapping, true);
    assert.deepEqual(networksForTarget(s, { type: 'resource', id: 'r1' }).sort(), ['n1', 'n2']);
});

test('the more specific route wins: the target\'s own rules replace a broader grant', () => {
    const s = base();
    s.resources.push({ id: 'r-wide', name: 'wide', address: '10.0.0.0/16', enabled: true, groups: [] });
    s.networks[1].resources.push('r-wide');
    s.policies.push(pol('p-wide', [rule({ ports: ['443'], destinationResource: { id: 'r-wide' } })]));
    const r = userCheck(s, { query: { protocol: 'tcp', port: 443 } });
    assert.equal(r.verdict, 'port_blocked'); // r1 (/32, RDP only) wins over the /16
});

test('a disabled target is still reachable through an enabled covering resource', () => {
    const s = base();
    s.resources[0].enabled = false;
    assert.equal(userCheck(s).verdict, 'denied');
    s.resources.push({ id: 'r-wide', name: 'wide', address: '10.0.0.0/24', enabled: true, groups: [{ id: 'g-srv' }] });
    s.networks[0].resources.push('r-wide');
    const r = userCheck(s);
    assert.equal(r.verdict, 'granted');
    assert.equal(r.target.enabled, false);
});

test('a /24 target with only a /32 inside granting is partial', () => {
    const s = base();
    s.resources.push({ id: 'r-h', name: 'printer', address: '10.0.1.9/32', enabled: true, groups: [] });
    s.networks[0].resources.push('r-h');
    s.policies = [pol('p-h', [rule({ destinationResource: { id: 'r-h' } })])];
    const r = userCheck(s, { target: { type: 'resource', id: 'r-lan' } });
    assert.equal(r.verdict, 'partial');
    const parts = r.devices[0].answer.parts;
    assert.deepEqual(parts.map(p => [p.label, p.answer]), [
        ['10.0.1.0 - 10.0.1.8', 'no'], ['10.0.1.9', 'yes'], ['10.0.1.10 - 10.0.1.255', 'no'],
    ]);
});

test('two /25 drops covering a granted /24 leave nothing for the query', () => {
    const s = base();
    s.resources.push(
        { id: 'r-a', name: 'a', address: '10.0.1.0/25', enabled: true, groups: [] },
        { id: 'r-b', name: 'b', address: '10.0.1.128/25', enabled: true, groups: [] },
    );
    s.networks[0].resources.push('r-a', 'r-b');
    s.policies = [
        pol('p-lan', [rule({ ports: ['22'], destinationResource: { id: 'r-lan' } })]),
        pol('p-da', [rule({ action: 'drop', ports: ['22'], destinationResource: { id: 'r-a' } })]),
        pol('p-db', [rule({ action: 'drop', ports: ['22'], destinationResource: { id: 'r-b' } })]),
    ];
    assert.equal(userCheck(s, { target: { type: 'resource', id: 'r-lan' }, query: { protocol: 'tcp', port: 22 } }).verdict, 'denied');
});

test('the same prefix in two networks cannot be determined', () => {
    const s = base();
    s.resources.push({ id: 'r1b', name: 'srv1-copy', address: '10.0.0.5', enabled: true, groups: [{ id: 'g-srv' }] });
    s.networks[1].resources.push('r1b');
    const r = userCheck(s);
    assert.equal(r.verdict, 'cannot_determine');
    assert.equal(r.devices[0].answer.parts[0].reason, 'ambiguous_route');
});

test('accepts minus drops per protocol: a full drop of the only open port leaves nothing', () => {
    const s = base();
    s.policies = [
        pol('p-a', [rule({ ports: ['22'], destinationResource: { id: 'r1' } })]),
        pol('p-d', [rule({ action: 'drop', ports: ['22'], destinationResource: { id: 'r1' } })]),
    ];
    assert.equal(userCheck(s).verdict, 'denied');
    s.policies[0].rules[0].ports = ['22', '443'];
    const r = userCheck(s);
    assert.equal(r.verdict, 'granted');
    assert.equal(r.devices[0].answer.parts[0].allowed.tcp, '443');
    assert.deepEqual(r.devices[0].answer.parts[0].blockedBy, ['p-d']);
    assert.equal(userCheck(s, { query: { protocol: 'tcp', port: 22 } }).verdict, 'port_blocked');
});

test('several drops together can cover an accepted range; port_ranges are honoured', () => {
    const s = base();
    s.policies = [
        pol('p-a', [rule({ port_ranges: [{ start: 8000, end: 8100 }], destinationResource: { id: 'r1' } })]),
        pol('p-d1', [rule({ action: 'drop', port_ranges: [{ start: 8000, end: 8050 }], destinationResource: { id: 'r1' } })]),
        pol('p-d2', [rule({ action: 'drop', protocol: 'all', sources: [{ id: 'g-other' }], destinationResource: { id: 'r1' } })]),
        pol('p-d3', [rule({ action: 'drop', port_ranges: [{ start: 8051, end: 8100 }], destinationResource: { id: 'r1' } })]),
    ];
    assert.equal(userCheck(s).verdict, 'denied');
    s.policies.pop();
    assert.equal(userCheck(s).devices[0].answer.parts[0].allowed.tcp, '8051-8100');
});

test('a drop on "all" removes every protocol; a udp accept does not answer a tcp query', () => {
    const s = base();
    s.policies = [
        pol('p-u', [rule({ protocol: 'udp', ports: ['53'], destinationResource: { id: 'r1' } })]),
    ];
    assert.equal(userCheck(s, { query: { protocol: 'udp', port: 53 } }).verdict, 'granted');
    assert.equal(userCheck(s, { query: { protocol: 'tcp', port: 53 } }).verdict, 'port_blocked');
    s.policies.push(pol('p-d', [rule({ action: 'drop', protocol: 'all', destinationResource: { id: 'r1' } })]));
    assert.equal(userCheck(s).verdict, 'denied');
});

test('an unparsable drop makes the answer uncertain; an unparsable accept is ignored', () => {
    const s = base();
    s.policies.push(pol('p-d', [rule({ action: 'drop', ports: ['80-90'], destinationResource: { id: 'r1' } })]));
    assert.equal(userCheck(s).verdict, 'cannot_determine');
    const s2 = base();
    s2.policies = [pol('p-x', [rule({ ports: ['abc'], destinationResource: { id: 'r1' } })])];
    assert.equal(userCheck(s2).verdict, 'denied');
});

test('ruleSet: ports only with tcp/udp, ranges only in port_ranges', () => {
    const { ruleSet } = _internal;
    assert.equal(ruleSet({ protocol: 'all', ports: ['22'] }), null);
    assert.equal(ruleSet({ protocol: 'icmp', port_ranges: [{ start: 1, end: 2 }] }), null);
    assert.equal(ruleSet({ protocol: 'tcp', ports: ['70000'] }), null);
    assert.equal(ruleSet({ protocol: 'tcp', ports: '22' }), null);
    assert.equal(ruleSet({ protocol: 'netbird-ssh' }), null);
    assert.deepEqual(ruleSet({ protocol: 'tcp', ports: ['22', '23'], port_ranges: [{ start: 24, end: 30 }] }).tcp, [[22, 30]]);
});

test('a posture-gated accept makes the device conditional, with both outcomes', () => {
    const s = base();
    s.policies[0].source_posture_checks = ['pc-1'];
    const r = userCheck(s);
    assert.equal(r.verdict, 'conditional');
    const a = r.devices[0].answer;
    assert.equal(a.ifChecksPass.verdict, 'granted');
    assert.equal(a.ifChecksFail.verdict, 'denied');
    assert.deepEqual(a.posturePolicies, [{ policy: 'Staff RDP', checks: ['Min Version'] }]);
});

test('a posture-gated drop never gives a hard deny', () => {
    const s = base();
    s.policies.push(pol('p-d', [rule({ action: 'drop', protocol: 'all', destinationResource: { id: 'r1' } })], { source_posture_checks: ['pc-1'] }));
    const r = userCheck(s);
    assert.equal(r.verdict, 'conditional');
    assert.equal(r.devices[0].answer.ifChecksFail.verdict, 'granted');
    assert.equal(r.devices[0].answer.ifChecksPass.verdict, 'denied');
});

test('a posture-gated narrower route can change the winning route', () => {
    // /24 elsewhere opens 443 for everyone; the /32 target opens 22 only behind a posture check.
    const s = base();
    s.resources.push({ id: 'r-wide', name: 'wide', address: '10.0.0.0/24', enabled: true, groups: [] });
    s.networks[1].resources.push('r-wide');
    s.policies = [
        pol('p-wide', [rule({ ports: ['443'], destinationResource: { id: 'r-wide' } })]),
        pol('p-ssh', [rule({ ports: ['22'], destinationResource: { id: 'r1' } })], { source_posture_checks: ['pc-1'] }),
    ];
    const r = userCheck(s, { query: { protocol: 'tcp', port: 443 } });
    assert.equal(r.verdict, 'conditional');
    assert.equal(r.devices[0].answer.ifChecksFail.verdict, 'granted');
    assert.equal(r.devices[0].answer.ifChecksPass.verdict, 'port_blocked');
});

test('compliance, sign-in and EDR bypass decide whether a matching device can connect', () => {
    const s = base();
    s.peers[0].approval_required = true;
    let r = userCheck(s);
    assert.equal(r.devices[0].effective, 'cannot_connect');
    assert.deepEqual(r.devices[0].blockers, ['compliance']);
    assert.equal(r.verdict, 'denied');
    assert.equal(r.reason, 'device_cannot_connect');
    s.bypassed = new Set(['p1']);
    assert.equal(userCheck(s).verdict, 'granted');
    s.bypassed = null; // the bypass list could not be read
    r = userCheck(s);
    assert.equal(r.verdict, 'cannot_determine');
    assert.deepEqual(r.devices[0].blockers, ['compliance_unknown']);
    s.peers[0].approval_required = false;
    s.peers[0].login_expired = true;
    assert.equal(userCheck(s).devices[0].effective, 'cannot_connect');
});

test('a proven grant on one device is not hidden by uncertainty on another', () => {
    const s = base();
    s.resources.push({ id: 'r1b', name: 'twin', address: '10.0.0.5/32', enabled: true, groups: [] });
    s.networks[1].resources.push('r1b');
    s.groups.push({ id: 'g-twin', name: 'Twin' });
    s.policies.push(pol('p-twin', [rule({ sources: [{ id: 'g-twin' }], destinationResource: { id: 'r1b' } })]));
    s.peers.push({ id: 'p1b', name: 'dana-desktop', user_id: 'u1', groups: [{ id: 'g-staff' }, { id: 'g-twin' }], connected: false });
    const r = userCheck(s);
    assert.equal(r.verdict, 'granted');
    assert.deepEqual(r.devices.map(d => d.effective), ['granted', 'cannot_determine']);
});

test('the Browser Gateway policy is counted and labelled infrastructure', () => {
    const s = base();
    s.groups.push({ id: 'g-gw', name: 'Browser Gateway' });
    s.peers.push({ id: 'p-gw', name: 'gateway', groups: [{ id: 'g-gw' }], connected: true });
    s.policies.push(pol('pol-gw', [rule({ sources: [{ id: 'g-gw' }], destinations: [{ id: 'g-srv' }] })], { name: 'Browser Gateway' }));
    s.managedPolicyIds = ['pol-gw'];
    const who = whoHasAccess(s, { target: { type: 'resource', id: 'r1' }, now: NOW });
    const gw = who.devices.find(d => d.id === 'p-gw');
    assert.ok(gw);
    assert.equal(gw.infrastructure, true);
    // The same policy under another id is an ordinary policy.
    s.managedPolicyIds = [];
    assert.equal(whoHasAccess(s, { target: { type: 'resource', id: 'r1' }, now: NOW }).devices.find(d => d.id === 'p-gw').infrastructure, undefined);
});

test('who has access: users with access, pending users, unowned devices; service users skipped', () => {
    const s = base();
    s.users.push({ id: 'u3', name: 'Noa', auto_groups: ['g-staff'] });
    s.peers.push({ id: 'p-srv', name: 'build-server', groups: [{ id: 'g-staff' }], connected: true });
    s.peers.push({ id: 'p-svc', name: 'robot-box', user_id: 'svc', groups: [{ id: 'g-staff' }], connected: true });
    const r = whoHasAccess(s, { target: { type: 'resource', id: 'r1' }, now: NOW });
    assert.deepEqual(r.users.map(u => [u.user.id, u.verdict]), [['u1', 'granted']]);
    assert.deepEqual(r.users[0].devices[0].policies, ['Staff RDP']);
    assert.deepEqual(r.pending.map(u => u.user.id), ['u3']);
    assert.deepEqual(r.devices.map(d => d.id).sort(), ['p-srv', 'p-svc']);
});

test('a network target evaluates each resource', () => {
    const s = base();
    s.policies.push(pol('p-lan', [rule({ protocol: 'all', sources: [{ id: 'g-other' }], destinationResource: { id: 'r-lan' } })]));
    const r = explainUserAccess(s, { userId: 'u2', target: { type: 'network', id: 'n1' }, now: NOW });
    assert.equal(r.verdict, 'granted');
    assert.deepEqual(r.devices[0].answer.perResource.map(x => [x.resource.id, x.verdict]), [['r1', 'denied'], ['r-lan', 'granted']]);
    const who = whoHasAccess(s, { target: { type: 'network', id: 'n1' }, now: NOW });
    assert.deepEqual(who.users.map(u => u.user.id).sort(), ['u1', 'u2']);
});

test('wildcard domains are split into disjoint parts', () => {
    const s = base();
    s.networks.push({ id: 'n3', name: 'Web', resources: ['d-all', 'd-dev', 'd-db'] });
    s.routers.set('n3', [{ id: 'rt3', peer: 'p-r2', enabled: true }]);
    s.resources.push(
        { id: 'd-all', name: 'all web', address: '*.example.com', enabled: true, groups: [] },
        { id: 'd-dev', name: 'dev', address: '*.dev.example.com', enabled: true, groups: [] },
        { id: 'd-db', name: 'db', address: 'db.dev.example.com', enabled: true, groups: [] },
    );
    s.policies = [
        pol('p-all', [rule({ ports: ['80'], destinationResource: { id: 'd-all' } })]),
        pol('p-dev', [rule({ ports: ['22'], destinationResource: { id: 'd-dev' } })]),
        pol('p-db', [rule({ ports: ['443'], destinationResource: { id: 'd-db' } })]),
    ];
    const r = userCheck(s, { target: { type: 'resource', id: 'd-all' }, query: { protocol: 'tcp', port: 443 } });
    assert.equal(r.verdict, 'partial');
    assert.deepEqual(r.devices[0].answer.parts.map(p => [p.label, p.answer]), [
        ['*.dev.example.com (except db.dev.example.com)', 'no'],
        ['db.dev.example.com', 'yes'],
        ['*.example.com (except *.dev.example.com, db.dev.example.com)', 'no'],
    ]);
    // An exact name is covered by the most specific matching wildcard; the bare base is not.
    s.resources.push({ id: 'd-x', name: 'x', address: 'api.dev.example.com', enabled: true, groups: [] });
    s.resources.push({ id: 'd-base', name: 'base', address: 'example.com', enabled: true, groups: [] });
    s.networks[2].resources.push('d-x', 'd-base');
    assert.equal(userCheck(s, { target: { type: 'resource', id: 'd-x' }, query: { protocol: 'tcp', port: 22 } }).verdict, 'granted');
    assert.equal(userCheck(s, { target: { type: 'resource', id: 'd-base' } }).verdict, 'denied');
});

test('IPv6 targets: only their own rules, overlap flagged, no rule = cannot determine', () => {
    const s = base();
    s.resources.push({ id: 'r6', name: 'v6', address: 'fd00::/64', enabled: true, groups: [] });
    s.networks[0].resources.push('r6');
    let r = userCheck(s, { target: { type: 'resource', id: 'r6' } });
    assert.equal(r.verdict, 'cannot_determine');
    s.policies.push(pol('p6', [rule({ destinationResource: { id: 'r6' } })]));
    r = userCheck(s, { target: { type: 'resource', id: 'r6' } });
    assert.equal(r.verdict, 'granted');
    assert.equal(r.devices[0].answer.overlapNotChecked, true);
});

test('legacy routes covering the target are reported; unreadable routers make the answer uncertain', () => {
    const s = base();
    s.routes = [{ id: 'rt', network_id: 'old-office', network: '10.0.0.0/8', enabled: true }];
    const r = userCheck(s);
    assert.deepEqual(r.legacyRoutes, [{ resource: 'r1', route: 'old-office' }]);
    assert.equal(r.verdict, 'granted');
    s.routers.set('n1', null); // the routers of the network could not be read
    const u = userCheck(s);
    assert.equal(u.routers[0].status, 'unknown');
    assert.equal(u.verdict, 'cannot_determine');
    assert.equal(u.devices[0].answer.parts[0].reason, 'router_unknown');
});

test('unknown users and targets return null; the query is normalised', () => {
    assert.equal(userCheck(base(), { userId: 'nope' }), null);
    assert.equal(userCheck(base(), { target: { type: 'resource', id: 'nope' } }), null);
    assert.equal(userCheck(base(), { target: { type: 'network', id: 'nope' } }), null);
    assert.deepEqual(normalizeQuery({ protocol: 'icmp', port: 22 }), { protocol: 'icmp', port: null });
    assert.deepEqual(normalizeQuery({ protocol: 'bogus' }), { protocol: 'any', port: null });
});

test('picker options list people, resources and networks only', () => {
    const o = accessCheckOptions(base());
    assert.deepEqual(o.users.map(u => u.id), ['u2', 'u1']);
    assert.equal(o.resources.find(r => r.id === 'r1').network.name, 'Office');
    assert.deepEqual(o.networks.map(n => n.id), ['n2', 'n1']);
});

test('one shared set of posture checks: agreeing extremes are definitive', () => {
    // The posture-gated accept on 22 is cancelled by an unconditional drop on 22: pass or fail,
    // the device gets nothing on 22.
    const s = base();
    s.policies = [
        pol('p-ssh', [rule({ ports: ['22'], destinationResource: { id: 'r1' } })], { source_posture_checks: ['pc-1'] }),
        pol('p-d', [rule({ action: 'drop', ports: ['22'], destinationResource: { id: 'r1' } })]),
    ];
    const r = userCheck(s, { query: { protocol: 'tcp', port: 22 } });
    assert.equal(r.verdict, 'denied');
    assert.deepEqual(r.devices[0].answer.postureIndependent, [{ policy: 'p-ssh', checks: ['Min Version'] }]);
});

test('different posture check sets stay conditional even when the extremes agree', () => {
    // Accept 22 behind check A, drop 22 behind check B: both extremes deny 22, but passing A
    // and failing B grants it.
    const s = base();
    s.postureChecks.push({ id: 'pc-2', name: 'Disk Encryption' });
    s.policies = [
        pol('p-a', [rule({ ports: ['22'], destinationResource: { id: 'r1' } })], { source_posture_checks: ['pc-1'] }),
        pol('p-b', [rule({ action: 'drop', ports: ['22'], destinationResource: { id: 'r1' } })], { source_posture_checks: ['pc-2'] }),
        pol('p-web', [rule({ ports: ['443'], destinationResource: { id: 'r1' } })]),
    ];
    const r = userCheck(s, { query: { protocol: 'tcp', port: 22 } });
    assert.equal(r.verdict, 'conditional');
    assert.equal(r.devices[0].answer.ifChecksPass.verdict, 'port_blocked');
    assert.equal(r.devices[0].answer.ifChecksFail.verdict, 'port_blocked');
});

test('on one routing peer, a drop on a covering resource blocks the more specific route', () => {
    // NetBird installs the rules of every resource the routing peer serves and checks drops first.
    const s = base();
    s.resources.push({ id: 'r-net', name: 'office-net', address: '10.0.0.0/24', enabled: true, groups: [] });
    s.networks[0].resources.push('r-net');
    s.policies = [
        pol('p-a', [rule({ ports: ['22'], destinationResource: { id: 'r1' } })]),
        pol('p-d', [rule({ action: 'drop', ports: ['22'], destinationResource: { id: 'r-net' } })], { name: 'No SSH' }),
    ];
    const r = userCheck(s, { query: { protocol: 'tcp', port: 22 } });
    assert.equal(r.verdict, 'denied');
    assert.deepEqual(r.devices[0].answer.parts[0].blockedBy, ['No SSH (on office-net)']);
    // The same drop in another network with its own routing peer does not apply.
    s.networks[0].resources.pop();
    s.networks[1].resources.push('r-net');
    assert.equal(userCheck(s, { query: { protocol: 'tcp', port: 22 } }).verdict, 'granted');
    // ...unless that network is routed by the same peer.
    s.routers.set('n2', [{ id: 'rt2', peer_groups: ['g-routers'], enabled: true }]);
    assert.equal(userCheck(s, { query: { protocol: 'tcp', port: 22 } }).verdict, 'denied');
    // Unknown routers for the other network, and the answer depends on it: cannot determine.
    s.routers.set('n2', null);
    const u = userCheck(s, { query: { protocol: 'tcp', port: 22 } });
    assert.equal(u.verdict, 'cannot_determine');
    assert.equal(u.devices[0].answer.parts[0].reason, 'router_unknown');
});

test('a covering accept on the same routing peer adds its ports to the winner', () => {
    const s = base();
    s.resources.push({ id: 'r-net', name: 'office-net', address: '10.0.0.0/24', enabled: true, groups: [] });
    s.networks[0].resources.push('r-net');
    s.policies.push(pol('p-web', [rule({ ports: ['443'], destinationResource: { id: 'r-net' } })]));
    const r = userCheck(s);
    assert.equal(r.devices[0].answer.parts[0].winner.id, 'r1');
    assert.equal(r.devices[0].answer.parts[0].allowed.tcp, '443, 3389');
});

test('posture-gated extra ports keep the answer conditional even when the verdict agrees', () => {
    const s = base();
    s.policies.push(pol('p-ssh', [rule({ ports: ['22'], destinationResource: { id: 'r1' } })], { source_posture_checks: ['pc-1'] }));
    const r = userCheck(s);
    assert.equal(r.verdict, 'conditional');
    assert.equal(r.devices[0].answer.ifChecksFail.parts[0].allowed.tcp, '3389');
    assert.equal(r.devices[0].answer.ifChecksPass.parts[0].allowed.tcp, '22, 3389');
});

test('who has access reports legacy routes and the routers of the winning network', () => {
    const s = base();
    s.resources.push({ id: 'r-wide', name: 'wide', address: '10.0.0.0/16', enabled: true, groups: [] });
    s.networks[1].resources.push('r-wide');
    s.policies = [pol('p-wide', [rule({ destinationResource: { id: 'r-wide' } })])];
    s.peers.find(p => p.id === 'p-r2').connected = false;
    s.routes = [{ id: 'rt', network_id: 'old-office', network: '10.0.0.0/8', enabled: true }];
    const r = whoHasAccess(s, { target: { type: 'resource', id: 'r1' }, now: NOW });
    assert.deepEqual(r.users.map(u => u.user.id), ['u1']);
    assert.deepEqual(r.legacyRoutes, [{ resource: 'r1', route: 'old-office' }]);
    assert.deepEqual(r.routers.map(x => [x.network.id, x.status]).sort(), [['n1', 'online'], ['n2', 'offline']]);
});

test('high availability: routing peers that apply different rules make the answer uncertain', () => {
    // r1 (/32) is routed by A and B; a /24 routed only by A opens 22; a /16 routed only by B drops 22.
    const s = base();
    s.peers.push({ id: 'p-a', name: 'router-a', groups: [], connected: true }, { id: 'p-b', name: 'router-b', groups: [], connected: true });
    s.networks.push({ id: 'n-a', name: 'A only', resources: ['r-24'] }, { id: 'n-b', name: 'B only', resources: ['r-16'] });
    s.resources.push(
        { id: 'r-24', name: 'lan-24', address: '10.0.0.0/24', enabled: true, groups: [] },
        { id: 'r-16', name: 'lan-16', address: '10.0.0.0/16', enabled: true, groups: [] },
    );
    s.routers.set('n1', [{ id: 'ra', peer: 'p-a', enabled: true }, { id: 'rb', peer: 'p-b', enabled: true }]);
    s.routers.set('n-a', [{ id: 'ra2', peer: 'p-a', enabled: true }]);
    s.routers.set('n-b', [{ id: 'rb2', peer: 'p-b', enabled: true }]);
    s.policies.push(
        pol('p-24', [rule({ ports: ['22'], destinationResource: { id: 'r-24' } })]),
        pol('p-16', [rule({ action: 'drop', ports: ['22'], destinationResource: { id: 'r-16' } })]),
    );
    const r = userCheck(s, { query: { protocol: 'tcp', port: 22 } });
    assert.equal(r.verdict, 'cannot_determine');
    assert.equal(r.devices[0].answer.parts[0].reason, 'router_differs');
    assert.equal(r.devices[0].answer.parts[0].allowed.tcp, '3389'); // 22 is not open through router B
    // RDP is the same through either routing peer.
    assert.equal(userCheck(s, { query: { protocol: 'tcp', port: 3389 } }).verdict, 'granted');
    const rdp = userCheck(s, { query: { protocol: 'tcp', port: 3389 } }).devices[0].answer.parts[0];
    assert.equal(rdp.allowed.tcp, '3389'); // 22 is open only through router A
    assert.equal(rdp.variesByRouter, true);
});

test('a resource in a network with no enabled routing peer is no route', () => {
    const s = base();
    // Only resource, its network's only router disabled: denied, not granted.
    s.routers.set('n1', [{ id: 'rt1', peer_groups: ['g-routers'], enabled: false }]);
    let r = userCheck(s);
    assert.equal(r.verdict, 'denied');
    assert.equal(r.routers[0].status, 'none');
    // A /32 in a network whose router group is empty does not beat a working /24 elsewhere.
    s.routers.set('n1', [{ id: 'rt1', peer_groups: ['g-empty'], enabled: true }]);
    s.groups.push({ id: 'g-empty', name: 'Empty', peers: [] });
    s.resources.push({ id: 'r-wide', name: 'wide', address: '10.0.0.0/24', enabled: true, groups: [] });
    s.networks[1].resources.push('r-wide');
    s.policies.push(pol('p-ssh', [rule({ ports: ['22'], destinationResource: { id: 'r-wide' } })]));
    r = userCheck(s, { query: { protocol: 'tcp', port: 22 } });
    assert.equal(r.verdict, 'granted');
    assert.equal(r.devices[0].answer.parts[0].winner.id, 'r-wide');
});

test('router peers that do not exist or wait for compliance approval do not route', () => {
    const s = base();
    s.routers.set('n1', [{ id: 'rt1', peer: 'MISSING', enabled: true }]);
    assert.equal(userCheck(s).verdict, 'denied');
    const r1 = s.peers.find(p => p.id === 'p-r1');
    s.routers.set('n1', [{ id: 'rt1', peer: 'p-r1', enabled: true }]);
    r1.approval_required = true;
    assert.equal(userCheck(s).verdict, 'denied');        // blocked by compliance, no bypass
    s.bypassed = new Set(['p-r1']);
    assert.equal(userCheck(s).verdict, 'granted');       // bypassed: it routes
    s.bypassed = null;
    assert.equal(userCheck(s).verdict, 'cannot_determine'); // bypass list unreadable
    r1.approval_required = false;
    r1.connected = false;
    assert.equal(userCheck(s).verdict, 'granted');       // offline does not remove the route
    r1.login_expired = true;
    assert.equal(userCheck(s).verdict, 'cannot_determine');
    // Compliance-blocked with a readable bypass list: not a router, whatever its sign-in state.
    r1.approval_required = true;
    s.bypassed = new Set();
    let r = userCheck(s);
    assert.equal(r.verdict, 'denied');
    assert.equal(r.routers[0].status, 'none'); // shown as no usable routing peer, not "online"
    r1.login_expired = false;
    r1.connected = true;
    r = userCheck(s);
    assert.equal(r.verdict, 'denied');
    assert.equal(r.routers[0].status, 'none');
});

test('one routing peer of uncertain state does not hide a certain answer from the others', () => {
    // A healthy router plus one waiting for approval while the bypass list is unreadable; no
    // overlapping resources, so both would apply the same rules.
    const s = base();
    s.peers.push({ id: 'p-r3', name: 'router-3', groups: [], connected: true, approval_required: true });
    s.routers.set('n1', [{ id: 'rt1', peer: 'p-r1', enabled: true }, { id: 'rt3', peer: 'p-r3', enabled: true }]);
    s.bypassed = null;
    s.peers[0].approval_required = false;
    const r = userCheck(s);
    assert.equal(r.verdict, 'granted');
    assert.equal(r.routers[0].status, 'online');
    // Only the uncertain router left: the route itself is uncertain.
    s.routers.set('n1', [{ id: 'rt3', peer: 'p-r3', enabled: true }]);
    const u = userCheck(s);
    assert.equal(u.verdict, 'cannot_determine');
    assert.equal(u.routers[0].status, 'unknown');
});

// ─── Authorization: the Remote Access model ───

const { evaluatePolicies, userSourceGroups } = require('../lib/remote-access-auth');

// A tenant with every kind of rule the Remote Access model weighs.
function authzSnap() {
    const s = base();
    s.users.push({ id: 'u3', name: 'Noa', email: 'noa@example.com', auto_groups: ['g-temp', 'g-gone'] });
    s.users.push({ id: 'u4', name: 'Blocked', email: 'b@example.com', auto_groups: ['g-staff'], is_blocked: true });
    s.groups.push({ id: 'g-temp', name: 'Temp access #7 Noa' }, { id: 'g-gone', name: 'Temp access #8 Noa' });
    s.grants = [
        { id: 7, user_id: 'u3', status: 'active', expires_at: LATER, group_id: 'g-temp', assigned_groups: [] },
        { id: 8, user_id: 'u3', status: 'expired', expires_at: EARLIER, group_id: 'g-gone', assigned_groups: [] },
        { id: 9, user_id: 'u2', status: 'expired', expires_at: EARLIER, group_id: null, assigned_groups: [] },
    ];
    s.policies = [
        pol('pol-rdp', [rule({ ports: ['3389'], destinations: [{ id: 'g-srv' }] })], { name: 'Staff RDP' }),
        pol('pol-drop', [rule({ action: 'drop', ports: ['22'], destinationResource: { id: 'r1', type: 'host' } })], { name: 'No SSH' }),
        pol('pol-ssh', [rule({ ports: ['22'], destinationResource: { id: 'r1', type: 'host' } })], { name: 'Staff SSH' }),
        pol('pol-web', [rule({ ports: ['443'], destinations: [{ id: 'g-srv' }] })], { name: 'Web', source_posture_checks: ['pc-1'] }),
        pol('pol-gw', [rule({ ports: ['5900'], sources: [{ id: 'g-all' }], destinations: [{ id: 'g-srv' }] })], { name: 'Browser Gateway' }),
        pol('pol-dev', [rule({ ports: ['8080'], sources: [{ id: 'g-other' }], destinationResource: { id: 'r-lan', type: 'subnet' } })], { name: 'Other LAN' }),
        pol('pol-t7', [rule({ ports: ['9000'], sources: [{ id: 'g-temp' }], destinationResource: { id: 'r1', type: 'host' } })], { name: 'Temporary access #7' }),
        pol('pol-t8', [rule({ ports: ['9100'], sources: [{ id: 'g-gone' }], destinationResource: { id: 'r1', type: 'host' } })], { name: 'Temporary access #8' }),
        pol('pol-t9', [rule({ ports: ['9200'], sources: [{ id: 'g-all' }], destinationResource: { id: 'r-lab', type: 'subnet' } })], { name: 'Temporary access #9' }),
        pol('pol-udp', [rule({ protocol: 'udp', ports: ['53'], destinationResource: { id: 'r-lab', type: 'subnet' } })], { name: 'Lab DNS' }),
    ];
    return s;
}

const authz = (s, userId, target, query) => explainUserAccess(s, { userId, target, query, now: NOW }).authorization;

test('authorization agrees with the Remote Access policy check on every TCP port', () => {
    const s = authzSnap();
    const map = { OK: 'granted', BLOCKED_BY_POLICY: 'denied', PORT_NOT_ALLOWED: 'port_blocked', POSTURE_REQUIRED: 'conditional', NO_ACCESS: 'denied' };
    let compared = 0;
    for (const userId of ['u1', 'u2', 'u3']) {
        const src = userSourceGroups(s, userId, NOW);
        for (const res of s.resources) {
            for (const port of [22, 53, 443, 3389, 5900, 8080, 9000, 9100, 9200, 12345]) {
                const ra = evaluatePolicies(s, { managedPolicyId: null }, src, res, port, NOW, {});
                const a = authz(s, userId, { type: 'resource', id: res.id }, { protocol: 'tcp', port });
                assert.equal(a.verdict, map[ra.code], `${userId} ${res.id}:${port} remote-access=${ra.code} access-check=${a.verdict}`);
                compared++;
            }
        }
    }
    assert.equal(compared, 90);
});

test('authorization does not depend on having a device', () => {
    const s = authzSnap();
    s.peers = s.peers.filter(p => p.user_id !== 'u1');
    const r = explainUserAccess(s, { userId: 'u1', target: { type: 'resource', id: 'r1' }, now: NOW });
    assert.equal(r.authorization.verdict, 'granted');
    assert.equal(r.authorization.resources[0].grantedBy.find(g => g.policy === 'Staff RDP').via[0], 'Staff');
    assert.ok(r.authorization.groups.includes('Staff'));
    assert.ok(!r.authorization.groups.includes('All'));
    assert.equal(r.reason, 'no_devices'); // the device details still say so
});

test('authorization: drops win, posture is conditional, managed and ended temporary policies never count', () => {
    const s = authzSnap();
    const r1 = { type: 'resource', id: 'r1' };
    assert.equal(authz(s, 'u1', r1, { protocol: 'tcp', port: 22 }).verdict, 'denied');
    const any = authz(s, 'u1', r1, { protocol: 'any' });
    assert.equal(any.verdict, 'granted');
    assert.deepEqual(any.resources[0].blockedBy, ['No SSH']);
    assert.equal(any.resources[0].allowed.tcp, '443, 3389'); // 22 dropped, 5900 is the gateway's
    const web = authz(s, 'u1', r1, { protocol: 'tcp', port: 443 });
    assert.equal(web.verdict, 'conditional');
    assert.deepEqual(web.resources[0].grantedBy.find(g => g.policy === 'Web').postureChecks, ['Min Version']);
    assert.equal(authz(s, 'u2', r1, { protocol: 'tcp', port: 5900 }).verdict, 'denied');
    const noa = authz(s, 'u3', r1, { protocol: 'any' });
    assert.equal(noa.verdict, 'granted');
    assert.equal(noa.resources[0].allowed.tcp, '9000'); // #8 ended: neither its group nor its policy counts
    assert.equal(noa.resources[0].grantedBy[0].temp.state, 'active');
    assert.equal(authz(s, 'u2', { type: 'resource', id: 'r-lab' }, { protocol: 'tcp', port: 9200 }).verdict, 'denied');
});

test('authorization: device groups count, protocols and networks', () => {
    const s = authzSnap();
    // Avi's own groups are empty; his laptop is in Other, which counts as in Remote Access.
    assert.equal(authz(s, 'u2', { type: 'resource', id: 'r-lan' }, { protocol: 'tcp', port: 8080 }).verdict, 'granted');
    assert.equal(authz(s, 'u1', { type: 'resource', id: 'r-lab' }, { protocol: 'udp', port: 53 }).verdict, 'granted');
    assert.equal(authz(s, 'u1', { type: 'resource', id: 'r-lab' }, { protocol: 'tcp' }).verdict, 'port_blocked');
    assert.equal(authz(s, 'u1', { type: 'resource', id: 'r-lab' }, { protocol: 'icmp' }).verdict, 'port_blocked');
    const net = authz(s, 'u1', { type: 'network', id: 'n1' }, { protocol: 'any' });
    assert.equal(net.verdict, 'partial');
    assert.deepEqual(net.resources.map(r => r.verdict), ['granted', 'denied']);
    assert.equal(authz(s, 'u4', { type: 'resource', id: 'r1' }, { protocol: 'any' }).reason, 'user_blocked');
});

test('who has access lists authorized users first, with what authorizes them', () => {
    const s = authzSnap();
    s.peers = s.peers.filter(p => p.user_id !== 'u1');
    const w = whoHasAccess(s, { target: { type: 'resource', id: 'r1' }, now: NOW });
    assert.deepEqual(w.authorized.map(a => a.user.id), ['u1', 'u3']);
    const dana = w.authorized[0];
    assert.ok(dana.resources[0].policies.includes('Staff RDP'));
    assert.ok(dana.resources[0].via.includes('Staff'));
    assert.equal(w.authorized[1].resources[0].temporary, true);
    assert.ok(!w.authorized.some(a => a.user.id === 'u4'));
});
