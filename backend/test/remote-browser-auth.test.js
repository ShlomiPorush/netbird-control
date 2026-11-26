const test = require('node:test');
const assert = require('node:assert/strict');
const {
    evaluateExitNodeEntitlement, browserGateProblem, browserLiveProblem, webRouteBody, webPolicyBody, isManagedGatewayName,
} = require('../lib/remote-access-auth');

const NOW = Date.parse('2026-11-26T10:00:00Z');
const hourFromNow = new Date(NOW + 3_600_000).toISOString();
const hourAgo = new Date(NOW - 3_600_000).toISOString();

function baseSnap() {
    return {
        users: [{ id: 'u1', auto_groups: [] }, { id: 'u2', auto_groups: [] }],
        peers: [
            { id: 'laptop', name: 'Laptop', user_id: 'u1', groups: [{ id: 'g-staff' }] },
            { id: 'router', name: 'Office Router', user_id: '', groups: [{ id: 'g-office' }] },
            { id: 'web-gw', name: 'web', user_id: '', groups: [{ id: 'g-web' }] },
        ],
        groups: [
            { id: 'g-all', name: 'All', peers: [{ id: 'laptop' }, { id: 'router' }, { id: 'web-gw' }] },
            { id: 'g-staff', name: 'Staff', peers: [{ id: 'laptop' }] },
            { id: 'g-office', name: 'Office Peers', peers: [{ id: 'router' }] },
            { id: 'g-exit-acl', name: 'Exit ACL', peers: [] },
            { id: 'g-web', name: 'Browser Gateway Web', peers: [{ id: 'web-gw' }] },
        ],
        routes: [
            { id: 'rt-exit', network_id: 'office-exit', network: '0.0.0.0/0', enabled: true, peer_groups: ['g-office'], groups: ['g-staff'], access_control_groups: [] },
        ],
        policies: [
            { id: 'pol-icmp', name: 'Staff to Office', enabled: true, source_posture_checks: [], rules: [{ enabled: true, action: 'accept', protocol: 'icmp', sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-office' }] }] },
        ],
        grants: [],
    };
}
const evalU1 = (snap, cfg = {}) => evaluateExitNodeEntitlement(snap, cfg, { userId: 'u1', now: NOW });

test('a device in the distribution groups with an ICMP policy to the routing peers is entitled', () => {
    const v = evalU1(baseSnap());
    assert.equal(v.ok, true);
    assert.deepEqual(v.peer, { id: 'laptop', name: 'Laptop' });
    assert.equal(v.route.id, 'rt-exit');
});

test('an unknown or blocked user is refused', () => {
    assert.equal(evaluateExitNodeEntitlement(baseSnap(), {}, { userId: 'nobody', now: NOW }).code, 'USER_NOT_FOUND');
    const snap = baseSnap();
    snap.users[0].is_blocked = true;
    assert.equal(evalU1(snap).code, 'USER_BLOCKED');
});

test('a device whose login expired or that waits for approval is not counted, an offline one is', () => {
    let snap = baseSnap();
    snap.peers[0].login_expired = true;
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap = baseSnap();
    snap.peers[0].approval_required = true;
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap = baseSnap();
    snap.peers[0].connected = false;
    assert.equal(evalU1(snap).ok, true);
});

test('a disabled route, a route that is not 0.0.0.0/0, or one not distributed to the device does not count', () => {
    let snap = baseSnap();
    snap.routes[0].enabled = false;
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap = baseSnap();
    snap.routes[0].network = '10.0.0.0/8';
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap = baseSnap();
    snap.routes[0].groups = ['g-office'];
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
});

test('a single routing peer (route.peer) counts like a peer group', () => {
    const snap = baseSnap();
    snap.routes[0].peer_groups = [];
    snap.routes[0].peer = 'router';
    assert.equal(evalU1(snap).ok, true);
    snap.policies[0].rules[0].destinations = [];
    snap.policies[0].rules[0].destinationResource = { id: 'router', type: 'peer' };
    assert.equal(evalU1(snap).ok, true);
});

test('without a policy to the routing peers there is no entitlement; any protocol counts', () => {
    let snap = baseSnap();
    snap.policies = [];
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap = baseSnap();
    snap.policies[0].rules[0].protocol = 'tcp';
    snap.policies[0].rules[0].ports = ['22'];
    assert.equal(evalU1(snap).ok, true);
    snap = baseSnap();
    snap.policies[0].enabled = false;
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
});

test('a policy with posture checks grants nothing', () => {
    const snap = baseSnap();
    snap.policies[0].source_posture_checks = ['pc-1'];
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
});

test('an enabled drop policy from the device toward the routing peers negates it, also with posture checks', () => {
    const snap = baseSnap();
    snap.policies.push({ id: 'pol-drop', name: 'No exit', enabled: true, source_posture_checks: ['pc-1'], rules: [{ enabled: true, action: 'drop', protocol: 'all', sources: [{ id: 'g-all' }], destinations: [{ id: 'g-office' }] }] });
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap.policies[1].enabled = false;
    assert.equal(evalU1(snap).ok, true);
});

test('a route with access control groups also needs an all-protocol policy to one of them', () => {
    const snap = baseSnap();
    snap.routes[0].access_control_groups = ['g-exit-acl'];
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap.policies.push({ id: 'pol-acl', name: 'Exit ACL', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'tcp', sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-exit-acl' }] }] });
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap.policies[1].rules[0].protocol = 'all';
    const v = evalU1(snap);
    assert.equal(v.ok, true);
    assert.deepEqual(v.policies, ['Staff to Office', 'Exit ACL']);
    snap.policies.push({ id: 'pol-acl-drop', name: 'Block exit ACL', enabled: true, rules: [{ enabled: true, action: 'drop', protocol: 'all', sources: [{ id: 'g-staff' }], destinations: [{ id: 'g-exit-acl' }] }] });
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
});

test('the conditions must hold for the same device, never one device each', () => {
    const snap = baseSnap();
    snap.peers.push({ id: 'phone', name: 'Phone', user_id: 'u1', groups: [{ id: 'g-phones' }] });
    snap.groups.push({ id: 'g-phones', name: 'Phones', peers: [{ id: 'phone' }] });
    snap.routes[0].groups = ['g-phones'];
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap.policies.push({ id: 'pol-phones', name: 'Phones to Office', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'all', sources: [{ id: 'g-phones' }], destinations: [{ id: 'g-office' }] }] });
    assert.deepEqual(evalU1(snap).peer, { id: 'phone', name: 'Phone' });
});

test('a temporary grant counts while it is valid and stops counting once it expired', () => {
    const snap = baseSnap();
    snap.groups.push({ id: 'g-temp', name: 'Temp access #7 (u1)', peers: [{ id: 'laptop' }] });
    snap.peers[0].groups.push({ id: 'g-temp' });
    snap.policies = [{ id: 'pol-temp', name: 'Temporary access #7', enabled: true, rules: [{ enabled: true, action: 'accept', protocol: 'all', sources: [{ id: 'g-temp' }], destinations: [{ id: 'g-office' }] }] }];
    snap.grants = [{ id: 7, user_id: 'u1', status: 'active', expires_at: hourFromNow, group_id: 'g-temp', assigned_groups: [] }];
    assert.equal(evalU1(snap).ok, true);
    snap.grants[0].expires_at = hourAgo;
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
});

test("the app's own web route never counts, by stored id or by its network id", () => {
    const snap = baseSnap();
    snap.routes = [{ id: 'rt-web', network_id: 'nbc-browser-1a2b3c4d', network: '0.0.0.0/0', enabled: true, peer_groups: ['g-office'], groups: ['g-staff'], access_control_groups: [] }];
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap.routes[0].network_id = 'renamed';
    assert.equal(evalU1(snap, { webRouteId: 'rt-web' }).code, 'NO_EXIT_NODE');
    assert.equal(evalU1(snap).ok, true);
});

test('the managed gateway policies grant nothing', () => {
    const snap = baseSnap();
    snap.policies[0].name = 'Browser Gateway Web (NetBird Control)';
    assert.equal(evalU1(snap).code, 'NO_EXIT_NODE');
    snap.policies[0].name = 'Staff to Office';
    assert.equal(evalU1(snap, { managedPolicyIds: ['pol-icmp'] }).code, 'NO_EXIT_NODE');
});

test('the new web object names are managed names', () => {
    assert.equal(isManagedGatewayName('Browser Gateway Web (Prod)', 'group'), true);
    assert.equal(isManagedGatewayName('Browser Gateway Web ACL (Prod)', 'group'), true);
    assert.equal(isManagedGatewayName('Browser Gateway Web Routing (Prod)', 'policy'), true);
    assert.equal(isManagedGatewayName('Browser Gateway Web', 'policy'), true);
    assert.equal(isManagedGatewayName('Browser Gateway Web Routing', 'group'), false);
});

const IDS = { webGroupId: 'g-web', webAclGroupId: 'g-acl', webRouteId: 'rt-web', webPolicyId: 'pol-web', webRoutingPolicyId: 'pol-web-routing', webPeerId: 'web-gw' };
function gateWant() {
    return {
        routerGroupId: 'g-office',
        route: webRouteBody({ description: 'Browser Gateway Web (X)', networkId: 'nbc-browser-1a2b3c4d', routerGroupId: 'g-office', webGroupId: 'g-web', aclGroupId: 'g-acl' }),
        icmpPolicy: webPolicyBody({ name: 'Browser Gateway Web (X)', description: '', protocol: 'icmp', sourceGroupId: 'g-web', destinationGroupId: 'g-office' }),
        routingPolicy: webPolicyBody({ name: 'Browser Gateway Web Routing (X)', description: '', protocol: 'all', sourceGroupId: 'g-web', destinationGroupId: 'g-acl' }),
    };
}
function gateSnap() {
    const want = gateWant();
    const asNetBird = (p, id) => ({ id, ...p, rules: p.rules.map(r => ({ ...r, id: id + '-r', sources: r.sources.map(g => ({ id: g, name: g })), destinations: r.destinations.map(g => ({ id: g, name: g })), ports: null })) });
    return {
        groups: [
            { id: 'g-web', name: 'Browser Gateway Web (X)', peers: [{ id: 'web-gw', name: 'web' }], resources: null },
            { id: 'g-acl', name: 'Browser Gateway Web ACL (X)', peers: null, resources: [] },
            { id: 'g-office', name: 'Office Peers', peers: [{ id: 'router' }] },
        ],
        routes: [{ id: 'rt-web', ...want.route, peer: '', domains: null }],
        policies: [asNetBird(want.icmpPolicy, 'pol-web'), asNetBird(want.routingPolicy, 'pol-web-routing')],
    };
}

test('the readiness gate passes on objects exactly as the app wrote them, in NetBird shapes', () => {
    assert.equal(browserGateProblem(gateSnap(), IDS, gateWant()), null);
});

test('the readiness gate closes on every change to the managed objects', () => {
    const cases = [
        ['no peer recorded', (s, ids) => { ids.webPeerId = ''; }, 'WEB_PEER_NOT_ENROLLED'],
        ['a second peer in the web group', (s) => { s.groups[0].peers.push({ id: 'other' }); }, 'WEB_GROUP_CHANGED'],
        ['another peer instead of the recorded one', (s) => { s.groups[0].peers = [{ id: 'other' }]; }, 'WEB_GROUP_CHANGED'],
        ['a peer in the ACL group', (s) => { s.groups[1].peers = [{ id: 'laptop' }]; }, 'WEB_ACL_CHANGED'],
        ['the router group deleted', (s) => { s.groups.splice(2, 1); }, 'WEB_ROUTER_GROUP_MISSING'],
        ['the route deleted', (s) => { s.routes = []; }, 'WEB_ROUTE_CHANGED'],
        ['the route disabled', (s) => { s.routes[0].enabled = false; }, 'WEB_ROUTE_CHANGED'],
        ['the route distributed to another group too', (s) => { s.routes[0].groups = ['g-web', 'g-office']; }, 'WEB_ROUTE_CHANGED'],
        ['the route without masquerade', (s) => { s.routes[0].masquerade = false; }, 'WEB_ROUTE_CHANGED'],
        ['another metric', (s) => { s.routes[0].metric = 100; }, 'WEB_ROUTE_CHANGED'],
        ['another network id', (s) => { s.routes[0].network_id = 'other'; }, 'WEB_ROUTE_CHANGED'],
        ['another routing group', (s) => { s.routes[0].peer_groups = ['g-acl']; }, 'WEB_ROUTE_CHANGED'],
        ['the ICMP policy disabled', (s) => { s.policies[0].enabled = false; }, 'WEB_POLICY_CHANGED'],
        ['the ICMP policy made bidirectional', (s) => { s.policies[0].rules[0].bidirectional = true; }, 'WEB_POLICY_CHANGED'],
        ['the routing policy with a second rule', (s) => { s.policies[1].rules.push({ ...s.policies[1].rules[0] }); }, 'WEB_POLICY_CHANGED'],
        ['the routing policy to another group', (s) => { s.policies[1].rules[0].destinations = [{ id: 'g-office' }]; }, 'WEB_POLICY_CHANGED'],
        ['the routing policy with TCP only', (s) => { s.policies[1].rules[0].protocol = 'tcp'; }, 'WEB_POLICY_CHANGED'],
    ];
    for (const [what, change, code] of cases) {
        const snap = gateSnap();
        const ids = { ...IDS };
        change(snap, ids);
        assert.equal(browserGateProblem(snap, ids, gateWant()), code, what);
    }
    assert.equal(browserGateProblem(gateSnap(), { ...IDS, webRouteId: '' }, gateWant()), 'WEB_NOT_SET_UP');
});

const NOW_S = Math.floor(NOW / 1000);
const ready = (over = {}, gw = {}) => ({ ok: true, netns: 4026532000, gateway: { ts: NOW_S - 5, netns: 4026532000, wt0: '100.92.0.7', lock: true, table7120: ['default dev wt0'], ...gw }, table7120: ['default dev wt0 '], ...over });

test('the live gate passes for a fresh status of the same namespace with only the web route', () => {
    assert.equal(browserLiveProblem(ready(), { peerIp: '100.92.0.7', nowSec: NOW_S }), null);
});

test('the live gate closes on every live difference', () => {
    const at = { peerIp: '100.92.0.7', nowSec: NOW_S };
    assert.equal(browserLiveProblem(null, at), 'BROWSER_UNAVAILABLE');
    assert.equal(browserLiveProblem({ ok: false, error: 'INTERNAL' }, at), 'BROWSER_UNAVAILABLE');
    assert.equal(browserLiveProblem(ready({ gateway: null }), at), 'GATEWAY_STATUS_MISSING');
    assert.equal(browserLiveProblem(ready({}, { ts: NOW_S - 61 }), at), 'GATEWAY_STATUS_STALE');
    assert.equal(browserLiveProblem(ready({}, { ts: NOW_S - 60 }), at), null);
    assert.equal(browserLiveProblem(ready({}, { netns: 1 }), at), 'GATEWAY_NETNS_CHANGED');
    assert.equal(browserLiveProblem(ready({}, { lock: false }), at), 'GATEWAY_LOCK_MISSING');
    assert.equal(browserLiveProblem(ready({}, { wt0: null }), at), 'GATEWAY_ADDRESS_CHANGED');
    assert.equal(browserLiveProblem(ready(), { ...at, peerIp: '100.92.0.8' }), 'GATEWAY_ADDRESS_CHANGED');
    assert.equal(browserLiveProblem(ready({ table7120: [] }), at), 'GATEWAY_ROUTES_CHANGED');
    assert.equal(browserLiveProblem(ready({ table7120: ['default dev wt0', '10.0.0.0/8 dev wt0'] }), at), 'GATEWAY_ROUTES_CHANGED');
});
