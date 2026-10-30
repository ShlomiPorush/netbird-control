// An Access Review "Revoke" is recorded only when the access really ended: a recurring rule whose
// live window could not be torn down stays pending, and an auto-approval entry edited after the
// round opened is still the one that gets removed.
const test = require('node:test');
const assert = require('node:assert/strict');

const nb = require('../lib/netbird');
const clone = (x) => JSON.parse(JSON.stringify(x));
let nbUser, policyDeleteStatus;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
nb.ensureGroupsFresh = async () => { };
nb.netbirdGet = async (path) => (String(path).startsWith('/api/users') ? [clone(nbUser)] : []);
nb.netbirdReq = async (method, path, body) => {
    if (method === 'DELETE' && String(path).startsWith('/api/policies/')) return { status: policyDeleteStatus, raw: 'unavailable' };
    if (method === 'PUT' && String(path).startsWith('/api/users/')) { nbUser.auto_groups = body.auto_groups; return { status: 200, body: clone(nbUser) }; }
    return { status: 200, body: {} };
};
nb.netbirdPut = (path, body) => nb.netbirdReq('PUT', path, body);

let item, rule, grant, settings;
const core = require('../lib/core');
core.pool.query = async (sql, params = []) => {
    if (/FROM recert_items i JOIN recert_rounds/.test(sql)) return { rows: [clone(item)] };
    if (/UPDATE recert_items SET status=\$2/.test(sql)) { item.status = params[1]; return { rows: [] }; }
    if (/COUNT\(\*\)::int AS n FROM recert_items/.test(sql)) return { rows: [{ n: 1 }] };
    if (/FROM recurring_access WHERE id=\$1/.test(sql)) return { rows: rule ? [clone(rule)] : [] };
    if (/UPDATE recurring_access SET enabled=false/i.test(sql)) { rule.enabled = false; return { rows: [clone(rule)] }; }
    if (/UPDATE recurring_access SET active_grant_id=NULL/.test(sql)) { rule.active_grant_id = null; return { rows: [] }; }
    if (/FROM temporary_access_grants WHERE id=\$1/.test(sql)) return { rows: grant && params[0] === grant.id ? [clone(grant)] : [] };
    if (/UPDATE temporary_access_grants SET status=\$2/.test(sql)) { grant.status = params[1]; return { rows: [] }; }
    if (/UPDATE temporary_access_grants SET last_status='', last_error=\$2/.test(sql)) { grant.last_error = params[1]; return { rows: [] }; }
    if (/FROM app_settings WHERE key = \$1/.test(sql)) return { rows: settings.has(params[0]) ? [{ value: settings.get(params[0]) }] : [] };
    if (/INSERT INTO app_settings/.test(sql)) { settings.set(params[0], params[1]); return { rows: [] }; }
    return { rows: [] };
};
const db = require('../db');
const { decideRecertItem, getAutoApprovalConfig, setAutoApprovalConfig } = db;

test('revoking a recurring rule whose live window cannot be ended keeps the item pending', async () => {
    nbUser = { id: 'u1', role: 'user', is_blocked: false, auto_groups: ['tmp-src'] };
    policyDeleteStatus = 503;
    rule = { id: 3, user_id: 'u1', enabled: true, active_grant_id: 9 };
    grant = { id: 9, user_id: 'u1', status: 'active', policy_ids: ['pol-1'], assigned_groups: ['tmp-src'], group_id: 'tmp-src', dest_group_ids: [], dest_resources: [], targets: [] };
    item = { id: 50, round_id: 1, round_status: 'open', status: 'pending', kind: 'recurring', label: 'Rule', detail: { ruleId: 3 } };
    await assert.rejects(decideRecertItem(50, 'revoke', { name: 'admin' }));
    assert.equal(item.status, 'pending');
    assert.equal(rule.active_grant_id, 9, 'the link to the live window must be kept for a retry');
    assert.equal(rule.enabled, false);
    assert.equal(grant.status, 'active');
});

test('revoking an auto-approval entry edited after the round opened removes that entry', async () => {
    settings = new Map();
    await setAutoApprovalConfig({ trusted: [{ groupIds: ['g-trusted'], maxMinutes: 60 }], rules: [] });
    const snapshot = clone(getAutoApprovalConfig().trusted[0]); // what the round stored
    const edited = { ...clone(snapshot), maxMinutes: 120 };     // the edit form keeps the entry's id
    await setAutoApprovalConfig({ trusted: [edited], rules: [] });
    item = { id: 51, round_id: 1, round_status: 'open', status: 'pending', kind: 'auto_trusted', label: 'Trusted', detail: { entry: snapshot } };
    await decideRecertItem(51, 'revoke', { name: 'admin' });
    assert.equal(item.status, 'revoked');
    assert.equal(getAutoApprovalConfig().trusted.length, 0);
});

test('an item from before entries had ids still finds its entry after the config was normalized', async () => {
    // Stored by an older version: no ids, and only the fields the first migration wrote.
    settings = new Map([['auto_approval_config', JSON.stringify({ trusted: [{ groupIds: ['g-old'], maxMinutes: 30 }], rules: [] })]]);
    await db._internal.loadAutoApproval();
    item = { id: 52, round_id: 1, round_status: 'open', status: 'pending', kind: 'auto_trusted', label: 'Trusted', detail: { entry: { groupIds: ['g-old'], maxMinutes: 30 } } };
    const live = clone(getAutoApprovalConfig().trusted[0]);
    await setAutoApprovalConfig({ trusted: [{ ...live, maxMinutes: 45 }], rules: [] }); // edited, id kept
    await decideRecertItem(52, 'revoke', { name: 'admin' });
    assert.equal(getAutoApprovalConfig().trusted.length, 0);
});
