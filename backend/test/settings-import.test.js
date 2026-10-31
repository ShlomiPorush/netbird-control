// Restoring a settings file keeps the current NetBird API URL and SMTP server (the stored token and
// password belong to them) and never takes the Telegram callback secret from the file. Settings that
// are kept are reported as skipped; every other setting restores as before.
const test = require('node:test');
const assert = require('node:assert/strict');

// The connection modules read their env at require time - none of it may be set here.
for (const k of ['NETBIRD_API_URL', 'NETBIRD_API_TOKEN', 'SMTP_HOST', 'SMTP_PASS', 'TELEGRAM_BOT_TOKEN']) delete process.env[k];

// In-memory app_settings behind the DB stub (installed BEFORE db.js loads).
const store = new Map();
const core = require('../lib/core');
core.pool.query = async (sql, params = []) => {
    if (/SELECT value FROM app_settings WHERE key = \$1/.test(sql)) return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
    if (/INSERT INTO app_settings/.test(sql)) { store.set(params[0], params[1]); return { rows: [] }; }
    if (/FROM app_settings WHERE key IN/.test(sql)) {
        return { rows: ['netbird_api_url', 'netbird_api_token'].filter(k => store.has(k)).map(k => ({ key: k, value: store.get(k) })) };
    }
    if (/LIKE 'telegram_config:%'/.test(sql)) {
        return { rows: [...store].filter(([k]) => k.startsWith('telegram_config:') || k.startsWith('telegram_bot_token:')).map(([key, value]) => ({ key, value })) };
    }
    return { rows: [] };
};
const { importAppSettings, getNbApiConfig, getSmtpConfig, getTelegramWebhookSecret } = require('../db');

const SMTP = { enabled: true, host: 'mail.example.com', port: 587, secure: false, user: 'notify', from: 'nb@example.com' };
const TG = { enabled: false, chatId: '-100', categories: {}, netbirdEvents: [] };
// Seed the current deployment and reload the in-memory configs through an import of a plain key.
async function seed() {
    store.clear();
    store.set('netbird_api_url', 'https://nb.example.com');
    store.set('netbird_api_token', 'tok');
    store.set('smtp_config', JSON.stringify(SMTP));
    store.set('smtp_pass', 'pw');
    store.set('telegram_config', JSON.stringify({ ...TG, webhookSecret: 'current-secret' }));
    await importAppSettings({ settings: { retention_days: '30' } });
}
const skippedKeys = (r) => (r.skippedSettings || []).map(s => s.key);

test('a different NetBird API URL is kept and reported as skipped', async () => {
    await seed();
    const r = await importAppSettings({ settings: { netbird_api_url: 'https://other.example.com', retention_days: '60' } });
    assert.equal(getNbApiConfig().url, 'https://nb.example.com');
    assert.equal(store.get('netbird_api_url'), 'https://nb.example.com');
    assert.deepEqual(skippedKeys(r), ['netbird_api_url']);
    assert.ok(r.skippedSettings[0].reason);
    assert.deepEqual(r.keys, ['retention_days']);
    assert.equal(r.imported, 1);
    assert.equal(store.get('retention_days'), '60');
});

test('the same NetBird API URL counts as restored', async () => {
    await seed();
    const r = await importAppSettings({ settings: { netbird_api_url: 'https://nb.example.com' } });
    assert.deepEqual(skippedKeys(r), []);
    assert.deepEqual(r.keys, ['netbird_api_url']);
    assert.equal(getNbApiConfig().url, 'https://nb.example.com');
});

test('an SMTP config with a different host, port, security or user is kept and reported as skipped', async () => {
    for (const change of [{ host: 'smtp.other.example' }, { port: 2525 }, { secure: true }, { user: 'someone' }]) {
        await seed();
        const r = await importAppSettings({ settings: { smtp_config: JSON.stringify({ ...SMTP, ...change }) } });
        assert.deepEqual(skippedKeys(r), ['smtp_config'], JSON.stringify(change));
        assert.deepEqual(JSON.parse(store.get('smtp_config')), SMTP);
        assert.equal(getSmtpConfig().host, 'mail.example.com');
    }
});

test('an SMTP config for an empty current host is still kept', async () => {
    await seed();
    store.set('smtp_config', JSON.stringify({ ...SMTP, host: '' }));
    const r = await importAppSettings({ settings: { smtp_config: JSON.stringify(SMTP) } });
    assert.deepEqual(skippedKeys(r), ['smtp_config']);
    assert.equal(JSON.parse(store.get('smtp_config')).host, '');
});

test('an SMTP config for the same server restores its other fields', async () => {
    await seed();
    const r = await importAppSettings({ settings: { smtp_config: JSON.stringify({ ...SMTP, enabled: false, from: 'new@example.com' }) } });
    assert.deepEqual(skippedKeys(r), []);
    assert.equal(getSmtpConfig().from, 'new@example.com');
    assert.equal(getSmtpConfig().host, 'mail.example.com');
});

test('a Telegram config never takes the callback secret from the file', async () => {
    await seed();
    const r = await importAppSettings({ settings: { telegram_config: JSON.stringify({ ...TG, chatId: '-200', webhookSecret: 'X' }) } });
    assert.deepEqual(skippedKeys(r), []);
    assert.equal(getTelegramWebhookSecret(), 'current-secret');
    assert.equal(JSON.parse(store.get('telegram_config')).chatId, '-200');
});

test('a Telegram callback secret in the file is dropped when none is configured', async () => {
    await seed();
    store.set('telegram_config', JSON.stringify(TG));
    await importAppSettings({ settings: { retention_days: '30' } });
    await importAppSettings({ settings: { telegram_config: JSON.stringify({ ...TG, webhookSecret: 'X' }) } });
    assert.equal(getTelegramWebhookSecret(), '');
    assert.equal('webhookSecret' in JSON.parse(store.get('telegram_config')), false);
});

test('the active Telegram callback secret is kept even when the stored config lacks it', async () => {
    await seed(); // active secret in memory: current-secret
    store.set('telegram_config', JSON.stringify(TG));
    await importAppSettings({ settings: { telegram_config: JSON.stringify({ ...TG, chatId: '-300' }) } });
    assert.equal(getTelegramWebhookSecret(), 'current-secret');
    assert.equal(JSON.parse(store.get('telegram_config')).webhookSecret, 'current-secret');
});

test('a Telegram config that is not an object is reported as skipped', async () => {
    for (const bad of ['null', '[]', '"x"', '42', 'not json']) {
        await seed();
        const r = await importAppSettings({ settings: { telegram_config: bad, retention_days: '60' } });
        assert.deepEqual(skippedKeys(r), ['telegram_config'], bad);
        assert.equal(getTelegramWebhookSecret(), 'current-secret');
        assert.equal(JSON.parse(store.get('telegram_config')).webhookSecret, 'current-secret');
    }
});

test('a tenant Telegram config drops the file secret and must be an object', async () => {
    await seed();
    let r = await importAppSettings({ settings: { 'telegram_config:t1': JSON.stringify({ ...TG, webhookSecret: 'X' }) } });
    assert.deepEqual(skippedKeys(r), []);
    assert.equal('webhookSecret' in JSON.parse(store.get('telegram_config:t1')), false);
    r = await importAppSettings({ settings: { 'telegram_config:t1': 'null' } });
    assert.deepEqual(skippedKeys(r), ['telegram_config:t1']);
});
