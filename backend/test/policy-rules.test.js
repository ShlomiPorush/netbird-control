// ruleForPut turns a GET rule back into PUT shape for "keep the rules as they are" writes
// (multi-rule save, rename, merge/move re-point and rollback). Fields the app doesn't model must
// ride along, or every such write silently strips them from the live policy.
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../db');
const { ruleForPut } = _internal;

const getRule = {
    id: 'r1', name: 'ssh', description: 'admins', enabled: true, action: 'accept', bidirectional: false,
    protocol: 'netbird-ssh', ports: [], sources: [{ id: 'g1', name: 'Admins' }], destinations: [{ id: 'g2', name: 'Servers' }],
    authorized_groups: { g1: ['root'] },
};

test('unmodeled rule fields are carried verbatim', () => {
    const out = ruleForPut(getRule);
    assert.deepEqual(out.authorized_groups, { g1: ['root'] });
    const withSrcRes = ruleForPut({ ...getRule, sources: [], sourceResource: { id: 'res1', type: 'host' } });
    assert.deepEqual(withSrcRes.sourceResource, { id: 'res1', type: 'host' });
    // NetBird rejects a rule carrying both sourceResource and sources (even an empty list).
    assert.equal('sources' in withSrcRes, false);
    // An empty/null sourceResource is not a source: group sources are kept, no sourceResource sent.
    const nullSrcRes = ruleForPut({ ...getRule, sourceResource: null });
    assert.deepEqual(nullSrcRes.sources, ['g1']);
    assert.equal('sourceResource' in nullSrcRes, false);
});

test('modeled fields are still normalized to PUT shape, and id stays omitted', () => {
    const out = ruleForPut(getRule);
    assert.deepEqual(out.sources, ['g1']);
    assert.deepEqual(out.destinations, ['g2']);
    assert.equal(out.description, 'admins');
    assert.equal('id' in out, false);
    const res = ruleForPut({ ...getRule, destinations: undefined, destinationResource: { id: 'res2', type: 'domain', name: 'x' } });
    assert.deepEqual(res.destinationResource, { id: 'res2', type: 'domain' });
    assert.equal('destinations' in res, false);
});
