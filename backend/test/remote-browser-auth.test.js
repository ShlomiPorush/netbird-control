const test = require('node:test');
const assert = require('node:assert/strict');
const {
    browserGateProblem, browserLiveProblem, webRouteBody, webPolicyBody, isManagedGatewayName,
} = require('../lib/remote-access-auth');

const NOW = Date.parse('2026-11-26T10:00:00Z');

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
