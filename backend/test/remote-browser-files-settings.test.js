const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../lib/core');
const stored = new Map();
const statements = [];
let releases = 0;
let failInsert = false;
core.pool.query = async () => ({ rows: [] });
core.pool.connect = async () => ({
    query: async (sql, params = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        statements.push(s);
        if (/^SELECT value FROM app_settings WHERE key = \$1 FOR UPDATE$/.test(s)) return { rows: stored.has(params[0]) ? [{ value: stored.get(params[0]) }] : [] };
        if (/^INSERT INTO app_settings \(key, value\) VALUES \(\$1, NULL\) ON CONFLICT \(key\) DO NOTHING$/.test(s)) {
            if (!stored.has(params[0])) stored.set(params[0], null);
            return { rows: [], rowCount: 1 };
        }
        if (/^INSERT INTO app_settings/.test(s)) {
            if (failInsert) throw new Error('the database is not answering');
            stored.set(params[0], params[1]);
            return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
    },
    release: () => { releases++; },
});

const ra = require('../lib/remote-access');
const { normConfig } = ra._internal;

const savedConfig = () => JSON.parse(stored.get('remote_access_config'));
function reset(saved, cached = saved) {
    stored.clear();
    statements.length = 0;
    releases = 0;
    failInsert = false;
    if (saved !== undefined) stored.set('remote_access_config', JSON.stringify(saved));
    ra._internal.setConfigForTest(cached || {});
}

test('the files settings are off by default, transfer needs files, and the limit stays within 1 to 10 GB', () => {
    const browser = (b) => normConfig({ browser: b }).browser;
    const pick = ({ files, transfer, filesLimitGb }) => ({ files, transfer, filesLimitGb });
    assert.deepEqual(pick(browser(undefined)), { files: false, transfer: false, filesLimitGb: 2 });
    assert.deepEqual(pick(browser({ transfer: true })), { files: false, transfer: false, filesLimitGb: 2 });
    assert.deepEqual(pick(browser({ files: 1, transfer: 'yes', filesLimitGb: '5' })), { files: true, transfer: true, filesLimitGb: 5 });
    assert.equal(browser({ filesLimitGb: 99 }).filesLimitGb, 10);
    assert.equal(browser({ filesLimitGb: 0 }).filesLimitGb, 1);
    assert.equal(browser({ filesLimitGb: 'lots' }).filesLimitGb, 2);
    assert.equal(normConfig({}).rev, 0);
    assert.equal(normConfig({ rev: 7 }).rev, 7);
    for (const bad of [-1, 1.5, '3', null]) assert.equal(normConfig({ rev: bad }).rev, 0);
});

const CREATE_ROW = 'INSERT INTO app_settings (key, value) VALUES ($1, NULL) ON CONFLICT (key) DO NOTHING';
const LOCK_ROW = 'SELECT value FROM app_settings WHERE key = $1 FOR UPDATE';

test('a locked update reads the row FOR UPDATE, writes, commits and releases; a failure rolls back and still releases', async () => {
    reset();
    stored.set('k', 'old');
    assert.equal(await core.updateSetting('k', (v) => `${v}+new`), 'old+new');
    assert.deepEqual(statements.map(s => s.split(' ').slice(0, 2).join(' ')), ['BEGIN', 'INSERT INTO', 'SELECT value', 'INSERT INTO', 'COMMIT']);
    assert.deepEqual(statements.slice(1, 3), [CREATE_ROW, LOCK_ROW]);
    assert.equal(stored.get('k'), 'old+new');
    assert.equal(releases, 1);
    statements.length = 0;
    await assert.rejects(core.updateSetting('k', () => { throw new Error('bad change'); }), /bad change/);
    assert.deepEqual(statements, ['BEGIN', CREATE_ROW, LOCK_ROW, 'ROLLBACK']);
    failInsert = true;
    statements.length = 0;
    await assert.rejects(core.updateSetting('k', () => 'x'), /not answering/);
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(stored.get('k'), 'old+new');
    assert.equal(releases, 3);
});

test('a first save creates the row before it locks it, so a second first save waits for it instead of also starting from nothing', async () => {
    reset();
    const seen = [];
    assert.equal(await core.updateSetting('fresh', (v) => { seen.push(v); return 'first'; }), 'first');
    assert.deepEqual(seen, [null]);
    assert.deepEqual(statements.slice(0, 3), ['BEGIN', CREATE_ROW, LOCK_ROW]);
    assert.equal(stored.get('fresh'), 'first');
});

test('a save merges into the saved settings, not into a stale copy, and counts up the revision', async () => {
    reset({ browser: { routerGroupId: 'g-office', files: false }, idleTimeoutMin: 40, rev: 5 },
        { browser: { routerGroupId: 'g-office', files: true, transfer: true }, idleTimeoutMin: 30, rev: 2 });
    const out = await ra.setRemoteAccessConfig({ browser: { keepAliveMin: 20 }, rev: 100 });
    const saved = savedConfig();
    assert.equal(saved.rev, 6, 'the stored revision plus one; a revision sent by the client is ignored');
    assert.deepEqual([saved.browser.files, saved.browser.transfer, saved.browser.keepAliveMin, saved.idleTimeoutMin], [false, false, 20, 40]);
    assert.deepEqual(out.config.browser, saved.browser);
    assert.equal(ra.getRemoteAccessConfig().rev, 6, "this instance's copy follows");
    assert.equal(releases, 1);
});

test('turning files on saves both settings and the limit', async () => {
    reset({ browser: { routerGroupId: 'g-office' } });
    await ra.setRemoteAccessConfig({ browser: { files: true, transfer: true, filesLimitGb: 4 } });
    const saved = savedConfig();
    assert.deepEqual([saved.browser.files, saved.browser.transfer, saved.browser.filesLimitGb, saved.rev], [true, true, 4, 1]);
});

test('a save that fails to write keeps the settings and answers 503', async () => {
    reset({ rev: 3 });
    failInsert = true;
    await assert.rejects(ra.setRemoteAccessConfig({ idleTimeoutMin: 45 }), (e) => e.status === 503 && e.code === 'UNAVAILABLE');
    assert.equal(savedConfig().rev, 3);
});

test('the launch network choice goes through the same locked update', async () => {
    reset({ networks: ['n1'], rev: 8 }, { networks: [], rev: 1 });
    const out = await ra.storeCreateSection({ networkId: 'n2' });
    assert.deepEqual(out.networks, ['n1', 'n2']);
    assert.equal(savedConfig().rev, 9);
    assert.ok(statements.some(s => /FOR UPDATE$/.test(s)));
});

test('an import keeps its own fields, turns creating off, and gets the next revision whatever revision the file has', async () => {
    for (const fileRev of [0, 999, undefined]) {
        reset({ rev: 12 });
        const ok = await ra.importRemoteAccessConfig(JSON.stringify({ enabled: true, futureKey: 'kept', createResources: { enabled: true, max: 9 }, ...(fileRev === undefined ? {} : { rev: fileRev }) }));
        assert.equal(ok, true);
        const saved = savedConfig();
        assert.deepEqual([saved.rev, saved.futureKey, saved.createResources.enabled, saved.createResources.max], [13, 'kept', false, 9], String(fileRev));
        assert.equal(ra.getRemoteAccessConfig().rev, 13);
    }
    reset({ rev: 12 });
    assert.equal(await ra.importRemoteAccessConfig('[1]'), false);
    assert.equal(savedConfig().rev, 12);
});

test('a save of the launch settings keeps the saved network, not the one a stale copy holds', async () => {
    reset({ networks: ['n-new'], createResources: { networkId: 'n-new', max: 50 }, rev: 2 },
        { networks: ['n-old'], createResources: { networkId: 'n-old', max: 50 }, rev: 1 });
    await ra.setRemoteAccessConfig({ createResources: { max: 7 } });
    const saved = savedConfig();
    assert.deepEqual([saved.createResources.networkId, saved.createResources.max, saved.networks, saved.rev], ['n-new', 7, ['n-new'], 3]);
});
