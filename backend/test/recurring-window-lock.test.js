// Disabling a recurring rule while the scheduler is opening its window waits for the activation
// and then ends the window it opened - the new grant never outlives the disable.
const test = require('node:test');
const assert = require('node:assert/strict');

const nb = require('../lib/netbird');
const clone = (x) => JSON.parse(JSON.stringify(x));
let nbUser, gateAdd = null;
nb.netbirdApiConfigured = () => true;
nb.bustNbCaches = () => { };
nb.ensureGroupsFresh = async () => { };
nb.netbirdGet = async (path) => (String(path).startsWith('/api/users') ? [clone(nbUser)] : []);
nb.netbirdReq = async (method, path, body) => {
    if (method === 'PUT' && String(path).startsWith('/api/users/')) {
        if (gateAdd && body.auto_groups.includes('g-target')) { const g = gateAdd; gateAdd = null; await g; }
        nbUser.auto_groups = body.auto_groups;
        return { status: 200, body: clone(nbUser) };
    }
    return { status: 200, body: {} };
};
nb.netbirdPut = (path, body) => nb.netbirdReq('PUT', path, body);

let rule, grants, failLinkSave = false;
const core = require('../lib/core');
core.pool.query = async (sql, params = []) => {
    if (/FROM recurring_access WHERE enabled = TRUE/.test(sql)) return { rows: rule.enabled ? [clone(rule)] : [] };
    if (/FROM recurring_access WHERE id=\$1/.test(sql)) return { rows: [clone(rule)] };
    if (/UPDATE recurring_access SET user_id=\$2/.test(sql)) { rule.enabled = params[9]; return { rows: [clone(rule)] }; }
    if (/UPDATE recurring_access SET active_grant_id=\$2/.test(sql)) {
        if (failLinkSave) { failLinkSave = false; throw new Error('database unavailable'); }
        rule.active_grant_id = params[1]; return { rows: [] };
    }
    if (/UPDATE recurring_access SET active_grant_id=NULL/.test(sql)) { rule.active_grant_id = null; return { rows: [] }; }
    if (/nextval/.test(sql)) return { rows: [{ id: 77 }] };
    if (/INSERT INTO temporary_access_grants/.test(sql)) { grants.set(77, { id: 77, user_id: params[1], status: 'creating', assigned_groups: [], policy_ids: [], dest_group_ids: [], dest_resources: [], group_id: '', targets: JSON.parse(params[4]) }); return { rows: [] }; }
    if (/SET group_id=\$2/.test(sql)) { Object.assign(grants.get(params[0]), { status: 'active', assigned_groups: JSON.parse(params[5]) }); return { rows: [{ id: params[0] }] }; }
    if (/FROM temporary_access_grants WHERE id=\$1/.test(sql)) return { rows: grants.has(params[0]) ? [clone(grants.get(params[0]))] : [] };
    if (/UPDATE temporary_access_grants SET status=\$2/.test(sql)) { grants.get(params[0]).status = params[1]; return { rows: [] }; }
    return { rows: [] };
};
const { runRecurringAccess, updateRecurringAccess } = require('../db');

test('a rule disabled while its window is opening ends that window', async (t) => {
    const now = new Date();
    if (now.getUTCHours() * 60 + now.getUTCMinutes() >= 23 * 60 + 58) return t.skip('too close to midnight UTC for an all-day window');
    nbUser = { id: 'u1', role: 'user', is_blocked: false, auto_groups: [] };
    grants = new Map();
    const cfg = { userId: 'u1', userLabel: 'U', targets: [{ type: 'group', id: 'g-target', name: 'Target' }], days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' };
    rule = { id: 3, user_id: 'u1', user_label: 'U', user_email: '', targets: cfg.targets, days: cfg.days, start_time: '00:00', end_time: '23:59', valid_until: '', enabled: true, active_grant_id: null, last_spawn_key: '' };
    let release; gateAdd = new Promise(r => { release = r; });
    const run = runRecurringAccess();                         // starts opening today's window
    await new Promise(r => setTimeout(r, 20));
    const disable = updateRecurringAccess(3, { ...cfg, enabled: false }, { name: 'admin' });
    await new Promise(r => setTimeout(r, 20));
    release();
    await run;
    await disable;
    assert.equal(rule.enabled, false);
    assert.equal(rule.active_grant_id, null);
    assert.equal(grants.get(77).status, 'revoked');
    assert.ok(!nbUser.auto_groups.includes('g-target'));
});

test('a window whose link to the rule cannot be saved is ended at once', async (t) => {
    const now = new Date();
    if (now.getUTCHours() * 60 + now.getUTCMinutes() >= 23 * 60 + 58) return t.skip('too close to midnight UTC for an all-day window');
    nbUser = { id: 'u1', role: 'user', is_blocked: false, auto_groups: [] };
    grants = new Map();
    rule = { id: 4, user_id: 'u1', user_label: 'U', user_email: '', targets: [{ type: 'group', id: 'g-target', name: 'Target' }], days: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '23:59', valid_until: '', enabled: true, active_grant_id: null, last_spawn_key: '' };
    failLinkSave = true;
    await runRecurringAccess();
    assert.equal(rule.active_grant_id, null);
    assert.equal(grants.get(77).status, 'revoked');
    assert.ok(!nbUser.auto_groups.includes('g-target'));
});
