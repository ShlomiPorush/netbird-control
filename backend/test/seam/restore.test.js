const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { seamSkipReason, createDatabase, cleanups } = require('../helpers/pg-test');
const { startInstance } = require('../helpers/instances');

const APP = path.join(__dirname, 'scenarios', 'app.js');

test('a settings restore that fails part way changes nothing, so the other instance never reloads half of it', { skip: seamSkipReason() }, async (t) => {
    const database = await createDatabase();
    const cleanup = cleanups(t);
    cleanup(() => database.drop());
    const a = await startInstance(database.env, APP, { name: 'A' });
    cleanup(() => a.stop());
    await a.call('init');
    await a.call('db', { fn: 'setSetting', args: ['app_name', 'Before'] });
    await a.call('sql', { text: `INSERT INTO filter_rules (field, operator, value, sort_order) VALUES ('any_addr', 'contains', 'kept', 0)` });
    const version = async () => (await a.call('sql', { text: `SELECT value FROM coordination WHERE key = 'settings_version'` }))[0].value;
    const v0 = await version();
    const grant = { network_id: 'n1', group_id: 'g1' };
    await assert.rejects(a.call('db', { fn: 'importAppSettings', args: [{ settings: { app_name: 'After' }, tables: { filter_rules: [], network_grants: [grant, grant] } }] }));
    assert.deepEqual(await a.call('sql', { text: `SELECT value FROM app_settings WHERE key = 'app_name'` }), [{ value: 'Before' }]);
    assert.deepEqual(await a.call('sql', { text: `SELECT value FROM filter_rules` }), [{ value: 'kept' }]);
    assert.equal(await version(), v0);
});
