'use strict';
// Is an address part of the NetBird network at all? Pure: the caller reads the resources and the
// routes (and looks names up) and passes them in.
//
// Used to decide when "Add As Resource" is offered (the Remote Access check and the Troubleshoot
// address check): only for an address that nothing in NetBird covers, so the button never offers
// a second resource for an address that already has one, or that a legacy route already carries.
//   - An IPv4 address is covered by any network resource whose host or subnet contains it (in any
//     network, enabled or not), or by an enabled legacy network route that contains it. A default
//     route (0.0.0.0/0, such as an exit node) does not count: it carries everything.
//   - A host name is covered by a domain resource that matches it (exact, or a *.wildcard), or by
//     an enabled legacy domain route that lists it.
// Addresses that are never browser targets (loopback, link-local, NetBird peers, multicast,
// reserved) are never offered either.

const { parsePrefix, ipv4ToInt, domainPattern, isDomainResource, isRefusedTarget, patternMatches } = require('./remote-access-auth');

const arr = (v) => (Array.isArray(v) ? v : []);
const routeOn = (r) => !!r && r.enabled !== false;

function ipCovered(inv, ip) {
    const n = ipv4ToInt(ip);
    if (n === null) return true; // not an address this code understands: never "uncovered"
    const inside = (p) => !!p && n >= p.start && n <= p.end;
    if (arr(inv && inv.resources).some(r => r && inside(parsePrefix(r.address)))) return true;
    return arr(inv && inv.routes).some(r => routeOn(r) && !arr(r.domains).length && (() => {
        const p = parsePrefix(r.network);
        return !!p && p.bits > 0 && inside(p);
    })());
}

function nameCovered(inv, name) {
    if (arr(inv && inv.resources).some(r => isDomainResource(r) && patternMatches(domainPattern(r.address), name))) return true;
    return arr(inv && inv.routes).some(r => routeOn(r) && arr(r.domains).some(d => patternMatches(domainPattern(d), name)));
}

// An IPv4 address that nothing covers and that may be a target at all.
function ipUncovered(inv, ip) {
    const n = ipv4ToInt(ip);
    return n !== null && !isRefusedTarget(n) && !ipCovered(inv, ip);
}

// A host name that nothing covers by name, and whose looked-up IPv4 addresses (at least one) are
// all uncovered.
function nameUncovered(inv, name, ips) {
    const list = arr(ips);
    return !!name && list.length > 0 && !nameCovered(inv, name) && list.every(ip => ipUncovered(inv, ip));
}

module.exports = { nameCovered, ipUncovered, nameUncovered };
