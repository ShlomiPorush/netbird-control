// Changing a user's groups PUTs role + auto_groups + is_blocked together. Those must come from a
// FRESH NetBird read, never the local mirror: a stale is_blocked would unblock a user blocked
// meanwhile (or re-block one unblocked meanwhile). An unreadable state must abort the write.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the NetBird client and the DB BEFORE db.js loads (it destructures these at require time).
const nb = require('../lib/netbird');
let live = [], liveOk = true, sent = [];
nb.netbirdGet = async (path) => {
    if (!liveOk) return null;
    return String(path).includes('service_user=true') ? [] : JSON.parse(JSON.stringify(live));
};
nb.netbirdPut = async (path, body) => { sent.push({ path, body }); return { status: 200, body: {} }; };
nb.bustNbCaches = () => { };
const core = require('../lib/core');
// The mirror row says NOT blocked, in the old group only - deliberately stale.
core.pool.query = async (sql) => /FROM users WHERE user_id/.test(sql)
    ? { rows: [{ user_id: 'u1', display_name: 'U', email: 'u@x', raw_json: { id: 'u1', role: 'user', is_blocked: false, auto_groups: ['old'] } }] }
    : { rows: [] };
const { setUserGroups, addUsersToGroup } = require('../db');

test('a user blocked in NetBird after the last mirror sync stays blocked', async () => {
    live = [{ id: 'u1', role: 'admin', is_blocked: true, auto_groups: ['old', 'new-in-netbird'] }];
    liveOk = true; sent = [];
    await setUserGroups('u1', ['g1']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.is_blocked, true);
    assert.equal(sent[0].body.role, 'admin');
});

test('adding to a group keeps groups added in NetBird since the last sync', async () => {
    live = [{ id: 'u1', role: 'user', is_blocked: false, auto_groups: ['old', 'new-in-netbird'] }];
    liveOk = true; sent = [];
    await addUsersToGroup('g9', ['u1']).catch(() => { });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.auto_groups, ['old', 'new-in-netbird', 'g9']);
    assert.equal(sent[0].body.is_blocked, false);
});

test('an unreadable NetBird state aborts before any write', async () => {
    liveOk = false; sent = [];
    await assert.rejects(setUserGroups('u1', ['g1']), /nothing was changed/);
    await assert.rejects(addUsersToGroup('g9', ['u1']), /nothing was changed/);
    assert.equal(sent.length, 0);
});

test('a user missing from the fresh list (or without is_blocked) is not written', async () => {
    live = [{ id: 'u1', role: 'user', auto_groups: [] }]; // no is_blocked
    liveOk = true; sent = [];
    await assert.rejects(setUserGroups('u1', ['g1']), /nothing was changed/);
    assert.equal(sent.length, 0);
});
