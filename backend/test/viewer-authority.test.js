// Who holds app authority. A user blocked in NetBird gets no role, groups or permissions. Direct
// per-user grants and approval delegations count only for an existing, unblocked NetBird user.
// Deleting a user in the main account also removes them from those grants and from the Telegram
// approver mapping, and a deleted user's mirror row never comes back to grant their old role.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
    OIDC_ISSUER_BASE_URL: 'http://127.0.0.1:9', OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_SECRET: 'test-secret',
    BASE_URL: 'http://127.0.0.1:8', SESSION_SECRET: 'a-fixed-test-session-secret-0123456789',
    ADMIN_GROUP_ID: 'admins', NETBIRD_API_URL: '', NETBIRD_API_TOKEN: '',
});

// ── Stub NetBird BEFORE db.js loads (it destructures these at require time) ──
const nb = require('../lib/netbird');
let liveUsers = [];   // what NetBird's user list answers
let gateOnce = null;  // when set, a user-list read (after skipping gateSkip reads) takes its snapshot, then waits on it
let gateSkip = 0;
let gateHit = false;
let listDown = false;  // NetBird answers the user-list reads with nothing
let listOnlyServiceUsers = false; // the regular list fails, the service-user list answers one user
nb.netbirdGet = async (path) => {
    if (path === '/api/users/current') return { id: 'svc' };
    if (listDown && path.startsWith('/api/users')) return null;
    if (listOnlyServiceUsers && path === '/api/users') return null;
    if (listOnlyServiceUsers && path === '/api/users?service_user=true') return [{ id: 'svc-1', is_service_user: true }];
    if (path === '/api/users?service_user=true') return [];
    if (path === '/api/users') {
        const snapshot = JSON.parse(JSON.stringify(liveUsers));
        if (gateOnce && gateSkip > 0) gateSkip--;
        else if (gateOnce) { const gate = gateOnce; gateOnce = null; gateHit = true; await gate; }
        return snapshot;
    }
    return null;
};
nb.netbirdReq = async (method, path) => {
    liveUsers = liveUsers.filter(u => `/api/users/${encodeURIComponent(u.id)}` !== path);
    return { status: 200, body: {} };
};
let holdPut = null;   // when set, the next user write is applied in NetBird but answers only when this resolves
nb.netbirdPut = async (path, body) => {
    const u = liveUsers.find(x => `/api/users/${encodeURIComponent(x.id)}` === path);
    if (u) Object.assign(u, body);
    if (holdPut) { const h = holdPut; holdPut = null; await h; }
    return { status: 200, body: {} };
};
nb.bustNbCaches = () => { };
nb.refreshBypassedPeers = async () => { };

// ── Telegram transport stubs, recorded per call ──
const tg = require('../lib/telegram');
const tgCalls = [];
tg.telegramApi = async (method) => { tgCalls.push(method); return { ok: true }; };
tg.answerCallbackQuery = async (id, text) => { tgCalls.push(`answer:${text}`); };
tg.editTelegramReplyMarkup = async () => { tgCalls.push('editMarkup'); };

// ── An in-memory stand-in for the users mirror and app_settings ──
const core = require('../lib/core');
const users = new Map();    // `${tenant}|${user_id}` → { tenant, user_id, display_name, email, raw_json }
const settings = new Map(); // app_settings key → value
let failSettingWrite = '';  // the next write to this key fails once
let failUserUpdate = false; // the next direct mirror-row update fails once
let failUserInsert = false; // the next mirror-row upsert fails once
let holdWrites = false;     // settings writes wait until released (to reorder them)
const heldWrites = [];
let emailLookups = 0;
const viewerRow = (r, sql) => ({
    user_id: r.user_id, email: r.email, display_name: r.display_name,
    role: r.raw_json.role, auto_groups: r.raw_json.auto_groups || [],
    // Only a query that actually selects the flag gets it.
    ...(/is_blocked/.test(sql) ? { is_blocked: r.raw_json.is_blocked === true } : {}),
});
async function query(sql, params = []) {
    if (/INSERT INTO app_settings/.test(sql)) {
        const [key, value] = params;
        if (failSettingWrite === key) { failSettingWrite = ''; throw new Error('settings write failed'); }
        if (holdWrites) await new Promise(r => heldWrites.push(r));
        settings.set(key, value);
        return { rows: [] };
    }
    if (/SELECT value FROM app_settings/.test(sql)) {
        return { rows: settings.has(params[0]) ? [{ value: settings.get(params[0]) }] : [] };
    }
    if (/INSERT INTO users/.test(sql)) {
        if (failUserInsert) { failUserInsert = false; throw new Error('mirror write failed'); }
        const [id, name, email, raw, t] = params;
        users.set(`${t}|${id}`, { tenant: t, user_id: id, display_name: name, email, raw_json: JSON.parse(raw) });
        return { rows: [] };
    }
    if (/DELETE FROM users WHERE tenant = \$2 AND user_id <> ALL/.test(sql)) {
        const [ids, t] = params;
        for (const [k, r] of users) if (r.tenant === t && !ids.includes(r.user_id)) users.delete(k);
        return { rows: [] };
    }
    if (/DELETE FROM users WHERE tenant = \$2 AND user_id = \$1/.test(sql)) {
        users.delete(`${params[1]}|${params[0]}`);
        return { rows: [] };
    }
    if (/FROM users WHERE user_id = \$1 AND tenant = \$2/.test(sql)) {
        const r = users.get(`${params[1]}|${params[0]}`);
        return { rows: r ? [r] : [] };
    }
    if (/FROM users WHERE tenant = '' AND \(user_id = \$1/.test(sql)) {
        const r = [...users.values()].find(x => x.tenant === '' && (x.user_id === params[0] || x.user_id.endsWith('|' + params[0])));
        return { rows: r ? [viewerRow(r, sql)] : [] };
    }
    if (/FROM users WHERE tenant = '' AND LOWER\(email\)/.test(sql)) {
        emailLookups++;
        const rows = [...users.values()].filter(x => x.tenant === '' && String(x.email).toLowerCase() === String(params[0]).toLowerCase());
        return { rows: rows.map(r => viewerRow(r, sql)) };
    }
    if (/FROM users WHERE tenant = '' AND user_id = \$1/.test(sql)) {
        const r = users.get('|' + params[0]);
        return { rows: r ? [viewerRow(r, sql)] : [] };
    }
    if (/UPDATE users SET raw_json = jsonb_set/.test(sql)) {
        if (failUserUpdate) { failUserUpdate = false; throw new Error('mirror update failed'); }
        const r = users.get(`${params[1]}|${params[0]}`);
        if (r) r.raw_json = { ...r.raw_json, is_blocked: params[2] };
        return { rows: [] };
    }
    return { rows: [] };
}
core.pool.query = query;
core.pool.connect = async () => ({ query, release() { } });

const db = require('../db');
// Group sources for getViewer: Entra groups per oid, and one group from the user's peers.
const adGroupsByOid = {};
db.fetchUserGroups = async (oid) => adGroupsByOid[oid] || [];
db.getUserPeerGroupIds = async () => ['peer-grp'];
const { getViewer } = require('../server');

const ME = { id: 'u-me', email: 'me@corp.com' };
const OTHER = { id: 'u-other', email: 'other@corp.com' };
const userRow = (id, email, raw, tenant = '') =>
    users.set(`${tenant}|${id}`, { tenant, user_id: id, display_name: id, email, raw_json: { id, email, auto_groups: ['nb-grp'], ...raw } });
const viewerFor = (oid, email) => getViewer({ oidc: { user: { oid, email } } });
const savedJson = (key) => JSON.parse(settings.get(key) || '{}');
const tick = () => new Promise(r => setImmediate(r));
// Hold the next user-list read (after `skip` reads) until the returned open() is called.
function holdListRead(skip = 0) {
    let open; gateOnce = new Promise(r => { open = r; }); gateSkip = skip; gateHit = false;
    return open;
}
async function untilHeld() { while (!gateHit) await tick(); }
function withNetbirdApi(fn) {
    return async () => {
        nb._nbApi.url = 'http://netbird.test'; nb._nbApi.token = 't';
        try { await fn(); } finally { nb._nbApi.url = ''; nb._nbApi.token = ''; }
    };
}

beforeEach(async () => {
    users.clear(); settings.clear(); liveUsers = []; gateOnce = null; gateSkip = 0; gateHit = false;
    failSettingWrite = ''; holdWrites = false; heldWrites.length = 0; emailLookups = 0; listDown = false; tgCalls.length = 0;
    failUserUpdate = false; holdPut = null; listOnlyServiceUsers = false; failUserInsert = false;
    for (const k of Object.keys(adGroupsByOid)) delete adGroupsByOid[k];
    await db.setFeaturePermsConfig({
        'networks.manage': { users: [ME, OTHER], groupIds: [] },
        'audit.view': { users: [], groupIds: ['entra-grp'] },
        // An id-less entry and a different person who shares my email.
        'temp.manage': { users: [{ email: 'ME@corp.com' }, { id: 'u-namesake', email: 'me@corp.com' }], groupIds: [] },
    });
    await db.setApproverConfig({
        groupIds: ['peer-grp'],
        delegates: [
            { user: ME, from: '2000-01-01', until: '2999-12-31' },
            { user: OTHER, from: '2000-01-01', until: '2999-12-31' },
        ],
        telegramApprovers: [
            { telegramId: '1', userId: ME.id, email: ME.email },
            { telegramId: '2', userId: '', email: 'ME@CORP.COM' },
            { telegramId: '3', userId: OTHER.id, email: OTHER.email },
            { telegramId: '4', userId: '', email: '' },
        ],
    });
});

test('a user blocked in NetBird has no role, groups or permissions', async () => {
    userRow(ME.id, ME.email, { role: 'admin', is_blocked: true });
    adGroupsByOid[ME.id] = ['admins', 'entra-grp'];
    const v = await viewerFor(ME.id, ME.email);
    assert.equal(v.isAdmin, false);
    assert.equal(v.canApprove, false);
    assert.equal(v.role, '');
    assert.deepEqual(v.groups, []);
    assert.ok(Object.values(v.perms).every(p => p === false), JSON.stringify(v.perms));
});

test('a blocked user found by email gets nothing, and a blocked id match never falls back to email', async () => {
    userRow(ME.id, ME.email, { role: 'admin', is_blocked: true });
    const byEmail = await viewerFor('unknown-oid', ME.email);
    assert.equal(byEmail.isAdmin, false);
    assert.equal(byEmail.perms['networks.manage'], false);

    // The id matches a blocked row; an unblocked admin row with the same email must not be used.
    userRow('u-twin', ME.email, { role: 'admin', is_blocked: false });
    emailLookups = 0;
    const byId = await viewerFor(ME.id, ME.email);
    assert.equal(byId.isAdmin, false);
    assert.equal(emailLookups, 0);
});

test('unblocking restores the direct grant and the delegation', async () => {
    userRow(ME.id, ME.email, { role: 'user', is_blocked: true });
    assert.equal((await viewerFor(ME.id, ME.email)).perms['networks.manage'], false);
    users.get('|u-me').raw_json.is_blocked = false;
    const v = await viewerFor(ME.id, ME.email);
    assert.equal(v.isAdmin, false);
    assert.equal(v.perms['networks.manage'], true);
    assert.equal(v.canApprove, true);
});

test('an active user gets direct grants, delegations and group grants', async () => {
    userRow(ME.id, ME.email, { role: 'user', is_blocked: false });
    adGroupsByOid[ME.id] = ['entra-grp'];
    await db.setApproverConfig({ groupIds: [] });
    const v = await viewerFor(ME.id, ME.email);
    assert.equal(v.isAdmin, false);
    assert.equal(v.perms['networks.manage'], true);
    assert.equal(v.perms['audit.view'], true);
    assert.equal(v.canApprove, true); // through the delegation only
});

test('without a NetBird user, direct grants and delegations do not apply, group grants and the admin group still do', async () => {
    adGroupsByOid[ME.id] = ['entra-grp'];
    await db.setApproverConfig({ groupIds: [] });
    const v = await viewerFor(ME.id, ME.email);
    assert.equal(v.perms['networks.manage'], false);
    assert.equal(v.perms['temp.manage'], false);
    assert.equal(v.canApprove, false);
    assert.equal(v.perms['audit.view'], true);

    adGroupsByOid[ME.id] = ['admins'];
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, true);
});

test('deleting a user in the main account removes them from direct grants, delegations and Telegram approvers', async () => {
    userRow(ME.id, ME.email, { role: 'user' });
    liveUsers = [{ id: ME.id, email: ME.email, role: 'user' }];
    await db.deleteUser(ME.id);

    const perms = savedJson('feature_permissions');
    assert.deepEqual(perms['networks.manage'].users.map(u => u.id), [OTHER.id]);
    // The id-less entry with my email is gone; the namesake with its own id stays.
    assert.deepEqual(perms['temp.manage'].users.map(u => u.id), ['u-namesake']);
    const approver = savedJson('approver_config');
    assert.deepEqual(approver.delegates.map(d => d.user.id), [OTHER.id]);
    assert.deepEqual(approver.telegramApprovers.map(a => a.telegramId), ['3', '4']);
    assert.deepEqual(db.getApproverConfig().telegramApprovers.map(a => a.telegramId), ['3', '4']);
});

test('a user without an email never matches id-less entries without an email', async () => {
    userRow('u-svc', '', { role: 'user' });
    await db.deleteUser('u-svc');
    assert.deepEqual(savedJson('approver_config').telegramApprovers.map(a => a.telegramId), ['1', '2', '3', '4']);
    assert.equal(savedJson('feature_permissions')['temp.manage'].users.length, 2);
});

test('deleting a user inside a tenant leaves the main-account settings alone', async () => {
    userRow(ME.id, ME.email, { role: 'user' }, 't1');
    const before = [settings.get('feature_permissions'), settings.get('approver_config')];
    await nb.runWithTenant('t1', () => db.deleteUser(ME.id));
    assert.deepEqual([settings.get('feature_permissions'), settings.get('approver_config')], before);
    assert.equal(db.getApproverConfig().telegramApprovers.length, 4);
});

for (const key of ['feature_permissions', 'approver_config']) {
    test(`a failed ${key} write is reported, both settings are still written, and a leftover entry grants nothing`, async () => {
        userRow(ME.id, ME.email, { role: 'admin' });
        userRow('u-gone', 'gone@corp.com', { role: 'user' });
        const other = key === 'feature_permissions' ? 'approver_config' : 'feature_permissions';
        failSettingWrite = key;
        const otherBefore = settings.get(other);
        await assert.rejects(db.deleteUser(ME.id), (err) => {
            assert.equal(err.status, 500);
            assert.match(err.message, /deleted/);
            assert.equal(err.userDeleted.label, ME.email);
            return true;
        });
        assert.notEqual(settings.get(other), otherBefore); // the other document was still written
        // The deleted admin's mirror row is gone, so a new request does not get the old role.
        await db.setApproverConfig({ groupIds: [] }); // leave only the delegation as a route to approving
        const v = await viewerFor(ME.id, ME.email);
        assert.equal(v.isAdmin, false);
        assert.equal(v.canApprove, false);
        assert.equal(v.perms['networks.manage'], false);

        // A failed permissions write stays in memory, so the next save persists it. A failed
        // approver save changes nothing, so that entry stays until an admin removes it.
        await db.deleteUser('u-gone');
        assert.deepEqual(savedJson('feature_permissions')['networks.manage'].users.map(u => u.id), [OTHER.id]);
        assert.deepEqual(savedJson('approver_config').delegates.map(d => d.user.id),
            key === 'approver_config' ? [ME.id, OTHER.id] : [OTHER.id]);
    });
}

test('concurrent deletes are both removed from the saved settings', async () => {
    userRow(ME.id, ME.email, { role: 'user' });
    userRow(OTHER.id, OTHER.email, { role: 'user' });
    holdWrites = true;
    const done = Promise.all([db.deleteUser(ME.id), db.deleteUser(OTHER.id)]);
    let finished = false;
    done.then(() => { finished = true; }, () => { finished = true; });
    // Let each held write land in reverse order, so an older write would overwrite a newer one.
    while (!finished) {
        await tick();
        const batch = heldWrites.splice(0).reverse();
        for (const release of batch) { release(); await tick(); }
    }
    await done;
    assert.deepEqual(savedJson('feature_permissions')['networks.manage'].users, []);
    assert.deepEqual(savedJson('approver_config').delegates, []);
    assert.deepEqual(savedJson('approver_config').telegramApprovers.map(a => a.telegramId), ['4']);
});

test('a settings save that finishes after a delete does not bring the deleted user back', async () => {
    userRow(ME.id, ME.email, { role: 'user' });
    holdWrites = true;
    // An admin save that still lists me, started before the delete; its write lands last.
    const saving = db.setFeaturePermsConfig({ 'networks.manage': { users: [ME, OTHER], groupIds: [] } });
    const deleting = db.deleteUser(ME.id);
    let finished = false;
    Promise.allSettled([saving, deleting]).then(() => { finished = true; });
    while (!finished) {
        await tick();
        const batch = heldWrites.splice(0).reverse();
        for (const release of batch) { release(); await tick(); }
    }
    await Promise.all([saving, deleting]);
    assert.deepEqual(savedJson('feature_permissions')['networks.manage'].users.map(u => u.id), [OTHER.id]);
    assert.deepEqual(savedJson('approver_config').delegates.map(d => d.user.id), [OTHER.id]);
});

test('a user-list refresh that started before a delete does not bring the user back', withNetbirdApi(async () => {
    userRow(ME.id, ME.email, { role: 'admin' });
    liveUsers = [{ id: ME.id, email: ME.email, role: 'admin' }, { id: OTHER.id, email: OTHER.email, role: 'owner' }];
    db.resetNbCaches();
    const open = holdListRead();
    const refresh = db.ensureUsersFresh(); // reads the list (with me), then waits
    await untilHeld();
    const deleting = db.deleteUser(ME.id);
    await tick();
    open();
    await Promise.all([refresh, deleting]);
    assert.equal(users.has('|u-me'), false);
    assert.equal(await db.resolveViewer(ME.id, ME.email), null);
}));

test('a refresh started by a group change before a delete does not bring the user back', withNetbirdApi(async () => {
    userRow(ME.id, ME.email, { role: 'admin' });
    liveUsers = [{ id: ME.id, email: ME.email, role: 'admin', is_blocked: false }, { id: OTHER.id, email: OTHER.email, role: 'owner', is_blocked: false, auto_groups: [] }];
    const open = holdListRead(1); // the group change reads the list once, then its refresh reads it
    const grouping = db.addUsersToGroup('g9', [OTHER.id]);
    await untilHeld();
    const deleting = db.deleteUser(ME.id);
    await tick();
    open();
    await Promise.all([grouping, deleting]);
    assert.equal(users.has('|u-me'), false);
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, false);
}));

test('a user-list refresh that started before a block does not leave the user unblocked', withNetbirdApi(async () => {
    userRow(ME.id, ME.email, { role: 'admin', is_blocked: false });
    liveUsers = [{ id: ME.id, email: ME.email, role: 'admin', is_blocked: false }, { id: OTHER.id, email: OTHER.email, role: 'owner' }];
    db.resetNbCaches();
    const open = holdListRead();
    const refresh = db.ensureUsersFresh();
    await untilHeld();
    const blocking = db.setUserBlocked(ME.id, true);
    await tick();
    open();
    await Promise.all([refresh, blocking]);
    assert.equal(users.get('|u-me').raw_json.is_blocked, true);
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, false);
}));

// ── Telegram approvals: a mapped approver acts only while their NetBird user exists and is not blocked ──
const press = (tgId) => db.handleTelegramCallback({
    callback_query: { id: 'q', from: { id: tgId }, data: 'req:deny:7', message: { chat: { id: -1 }, message_id: 5 } },
});
const denyReply = (tgId) => db.handleTelegramCallback({
    message: {
        from: { id: tgId }, text: 'not now', chat: { id: -1 }, message_id: 9,
        reply_to_message: { text: 'Reply to this message with a reason to DENY request #7.', message_id: 8 },
    },
});
// Whether this Telegram user may act: a button press opens the deny menu, and a deny reply is
// answered in the chat. Both must agree.
async function tgActs(tgId) {
    tgCalls.length = 0;
    await press(tgId);
    const pressed = tgCalls.includes('editMarkup');
    assert.equal(pressed, !tgCalls.some(c => /not authorized/.test(c)), JSON.stringify(tgCalls));
    tgCalls.length = 0;
    await denyReply(tgId);
    assert.equal(tgCalls.includes('sendMessage'), pressed, 'the deny reply and the button press disagree: ' + JSON.stringify(tgCalls));
    return pressed;
}

test('a Telegram approver whose user is blocked in NetBird can neither press the buttons nor reply with a denial', async () => {
    userRow(ME.id, ME.email, { role: 'admin', is_blocked: true });
    assert.equal(await tgActs(1), false);
    assert.equal(await tgActs(2), false); // an entry without a user id, matched by the blocked user's email
    users.get('|u-me').raw_json.is_blocked = false;
    assert.equal(await tgActs(1), true);
    assert.equal(await tgActs(2), true);
});

test('a Telegram approver whose user no longer exists cannot act, and an entry tied to no user still can', async () => {
    userRow(ME.id, ME.email, { role: 'user' });
    assert.equal(await tgActs(1), true);
    assert.equal(await tgActs(3), false); // mapped to a user with no NetBird user
    assert.equal(await tgActs(4), true);  // no user id and no email
    assert.equal(await tgActs(99), false); // not an approver at all
});

test('an entry matched by email is refused when any NetBird user with that email is blocked', async () => {
    userRow(ME.id, ME.email, { role: 'user' });
    userRow('u-twin', ME.email, { role: 'user', is_blocked: true });
    assert.equal(await tgActs(2), false);
    assert.equal(await tgActs(1), true); // the id-mapped entry checks only its own user
});

test('blocking a user in the app holds even when the user-list refresh after it fails', withNetbirdApi(async () => {
    userRow(ME.id, ME.email, { role: 'admin', is_blocked: false });
    liveUsers = [{ id: ME.id, email: ME.email, role: 'admin', is_blocked: false }, { id: OTHER.id, email: OTHER.email, role: 'owner' }];
    db.resetNbCaches();
    listDown = true;
    await db.setUserBlocked(ME.id, true);
    assert.equal(users.get('|u-me').raw_json.is_blocked, true);
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, false);
    assert.equal(await tgActs(1), false);
}));

test('a block the mirror could not record still counts until a user-list refresh records it', withNetbirdApi(async () => {
    userRow(ME.id, ME.email, { role: 'admin', is_blocked: false });
    liveUsers = [{ id: ME.id, email: ME.email, role: 'admin', is_blocked: false }, { id: OTHER.id, email: OTHER.email, role: 'owner' }];
    db.resetNbCaches();
    // A refresh reads the list (me still active) before the block and lands after the block was
    // recorded; the update after NetBird's answer then fails, and later list reads fail.
    const open = holdListRead();
    const refresh = db.ensureUsersFresh();
    await untilHeld();
    listDown = true; failUserUpdate = true;
    const blocking = db.setUserBlocked(ME.id, true);
    while (!liveUsers[0].is_blocked) await tick();
    open();
    await Promise.all([refresh, blocking]);
    assert.equal(users.get('|u-me').raw_json.is_blocked, false); // the stale list overwrote the record
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, false);
    assert.equal(await tgActs(1), false);
    // A refresh that returns only part of the list (here: just the service users) records nothing for me.
    listDown = false; listOnlyServiceUsers = true; db.resetNbCaches();
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, false);
    assert.equal(await tgActs(1), false);
    // Once the list can be read, a refresh records NetBird's state.
    listOnlyServiceUsers = false; db.resetNbCaches();
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, false);
    assert.equal(users.get('|u-me').raw_json.is_blocked, true);
    await db.setUserBlocked(ME.id, false);
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, true);
    assert.equal(await tgActs(1), true);
}));

test('an earlier unblock that answers late does not undo a newer block', withNetbirdApi(async () => {
    userRow(ME.id, ME.email, { role: 'admin', is_blocked: true });
    liveUsers = [{ id: ME.id, email: ME.email, role: 'admin', is_blocked: true }, { id: OTHER.id, email: OTHER.email, role: 'owner' }];
    listDown = true; // no refresh corrects the mirror
    let answer; holdPut = new Promise(r => { answer = r; });
    const unblocking = db.setUserBlocked(ME.id, false);
    while (holdPut) await tick(); // NetBird applied the unblock, its answer is still on the way
    const blocking = db.setUserBlocked(ME.id, true);
    for (let i = 0; i < 30; i++) await tick();
    answer();
    await Promise.all([unblocking, blocking]);
    assert.equal(liveUsers[0].is_blocked, true);
    assert.equal(users.get('|u-me').raw_json.is_blocked, true);
    assert.equal((await viewerFor(ME.id, ME.email)).isAdmin, false);
    assert.equal(await tgActs(1), false);
}));

test('a block is saved in the app before NetBird is asked, and is not sent when it cannot be saved', withNetbirdApi(async () => {
    userRow(ME.id, ME.email, { role: 'admin', is_blocked: false });
    liveUsers = [{ id: ME.id, email: ME.email, role: 'admin', is_blocked: false }, { id: OTHER.id, email: OTHER.email, role: 'owner' }];
    db.resetNbCaches();
    failUserInsert = true;
    await assert.rejects(db.setUserBlocked(ME.id, true), (err) => err.status === 500 && /not blocked/.test(err.message));
    assert.equal(liveUsers[0].is_blocked, false); // NetBird was not asked
    // Saved first: the stored row holds the block even when every later write and read fails,
    // so a restart does not lose it.
    listDown = true; failUserUpdate = true;
    await db.setUserBlocked(ME.id, true);
    assert.equal(liveUsers[0].is_blocked, true);
    assert.equal(users.get('|u-me').raw_json.is_blocked, true);
}));

test('a user list that answers only in part never drops a blocked user from the mirror', withNetbirdApi(async () => {
    userRow(ME.id, ME.email, { role: 'user', is_blocked: true });
    adGroupsByOid[ME.id] = ['admins'];
    liveUsers = [{ id: ME.id, email: ME.email, role: 'user', is_blocked: true }];
    db.resetNbCaches();
    listOnlyServiceUsers = true;
    const v = await viewerFor(ME.id, ME.email);
    assert.equal(users.has('|u-me'), true);
    assert.equal(users.has('|svc-1'), true);
    assert.equal(v.isAdmin, false);
    assert.equal(v.canApprove, false);
}));
