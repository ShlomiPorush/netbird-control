const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');

test('a settings change on one instance is in effect on the other at its next request', { skip: seamSkipReason() }, async (t) => {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    cleanup(() => database.drop());
    const a = await startInstance(database.env, APP, { name: 'A' });
    const b = await startInstance(database.env, APP, { name: 'B' });
    cleanup(async () => { await a.stop(); await b.stop(); });
    await a.call('init');
    await b.call('init');
    const before = (await b.call('db', { fn: 'getSecurityConfig' })).sessionIdleHours;
    const next = before === 3 ? 5 : 3;
    await a.call('db', { fn: 'setSecurityConfig', args: [{ sessionIdleHours: next }] });
    await b.call('db', { fn: 'ensureSettingsCurrent' });
    assert.equal((await b.call('db', { fn: 'getSecurityConfig' })).sessionIdleHours, next);
});

test('rewriting a setting with the same value does not make the other instance reload', { skip: seamSkipReason() }, async (t) => {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    cleanup(() => database.drop());
    const a = await startInstance(database.env, APP, { name: 'A' });
    cleanup(() => a.stop());
    await a.call('init');
    const version = async () => (await a.call('sql', { text: `SELECT value FROM coordination WHERE key = 'settings_version'` }))[0].value;
    await a.call('db', { fn: 'setSetting', args: ['app_name', 'Same'] });
    const v1 = await version();
    await a.call('db', { fn: 'setSetting', args: ['app_name', 'Same'] });
    assert.equal(await version(), v1);
    await a.call('sql', { text: `DELETE FROM app_settings WHERE key = 'app_name'` });
    assert.notEqual(await version(), v1);
});
