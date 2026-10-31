// Telegram transport layer, extracted verbatim from db.js. Owns the Telegram config state, the
// raw Bot API caller, message send/edit helpers, webhook registration, and topic creation. The
// domain-side notification builders (handleTelegramCallback, the reqKb* keyboards,
// accessRequestHtml, notifyAccessRequestTelegram, sendAnomalyAlert, TG_ACTION_LABELS, the
// tgFormat*/tgResolve* helpers, etc.) stay in db.js and call the transport helpers exported here.
//
// Dependency direction is one-way (db.js -> lib/telegram.js, never the reverse). The settings
// accessors come straight from lib/core.js and the shared httpJson helper from lib/http.js
// (telegram -> core, telegram -> http, both one-way), so there is nothing to inject.
const { pool, getSetting, setSetting } = require('./core');
const { httpJson } = require('./http');
// currentTenantAccount() (ALS) tells sendTelegram/getTelegramConfig which account is acting.
// One-way dependency: telegram -> netbird (netbird never requires telegram).
const { currentTenantAccount } = require('./netbird');

// ─── Telegram notifications (PER ACCOUNT) ──────────────────────────────────────────────────
// The config is per account: '' = the MSP main account, a tenant id = that tenant. Main
// preserves the original single-account behavior INCLUDING the env token override; tenant slots
// are settings-only and NEVER read env. Each slot keeps its own bot token (a write-only secret),
// chat id, per-category forum "topic" map and event selections. The bot token routes each
// category to its topic thread (message_thread_id) when configured, else the group default.
const _tgEnv = { token: process.env['TELEGRAM_BOT_TOKEN'] || '' };
// account id -> { token, enabled, chatId, categories, netbirdEvents, webhookSecret, tenantActivity }
// webhookSecret + tenantActivity are MAIN-only fields (the callback webhook + the mirror toggle).
const _tg = new Map();
function _slot(acct) {
    const key = acct || '';
    let s = _tg.get(key);
    if (!s) {
        // Main ('') seeds the env token; a tenant slot never does.
        s = { token: key === '' ? _tgEnv.token : '', enabled: false, chatId: '', categories: {}, netbirdEvents: [], webhookSecret: '', tenantActivity: true };
        _tg.set(key, s);
    }
    return s;
}
// Per-account setting keys - the bare key for main, `key:<tenant>` for a tenant (the same
// `key:<tenant>` scheme as whTokenKey / retention_days:<tenant>).
const _cfgKey = (acct) => (acct ? `telegram_config:${acct}` : 'telegram_config');
const _tokKey = (acct) => (acct ? `telegram_bot_token:${acct}` : 'telegram_bot_token');

async function loadTelegram() {
    // MAIN slot - env override included, behavior preserved byte-for-byte.
    try {
        const main = _slot('');
        const v = await getSetting('telegram_config');
        if (v) {
            const c = JSON.parse(v) || {};
            main.enabled = !!c.enabled;
            main.chatId = c.chatId || '';
            main.categories = (c.categories && typeof c.categories === 'object') ? c.categories : {};
            main.netbirdEvents = Array.isArray(c.netbirdEvents) ? c.netbirdEvents : [];
            main.webhookSecret = c.webhookSecret || '';
            // MAIN-only mirror toggle (surface tenant activity in main's channel). Default TRUE.
            main.tenantActivity = c.tenantActivity !== false;
        }
        const tok = await getSetting('telegram_bot_token');
        if (!_tgEnv.token && tok) main.token = tok;
    } catch (e) {
        console.error('[Telegram] config load error:', e.message);
    }
    // TENANT slots - settings-only (never env). Scan every per-tenant key so each tenant's config
    // is in memory for the synchronous getTelegramConfig()/send path (ALS is gone by drain time).
    try {
        const r = await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'telegram_config:%' OR key LIKE 'telegram_bot_token:%'`);
        for (const row of r.rows) {
            const isTok = row.key.startsWith('telegram_bot_token:');
            const acct = row.key.slice((isTok ? 'telegram_bot_token:' : 'telegram_config:').length);
            if (!acct) continue;
            const s = _slot(acct);
            if (isTok) { s.token = row.value || ''; continue; }
            try {
                const c = JSON.parse(row.value) || {};
                s.enabled = !!c.enabled;
                s.chatId = c.chatId || '';
                s.categories = (c.categories && typeof c.categories === 'object') ? c.categories : {};
                s.netbirdEvents = Array.isArray(c.netbirdEvents) ? c.netbirdEvents : [];
                // webhookSecret + tenantActivity stay MAIN-only - never read for a tenant slot.
            } catch { /* skip a malformed tenant config row */ }
        }
    } catch (e) {
        console.error('[Telegram] tenant config load error:', e.message);
    }
}

// UI-safe config for one account - never exposes the bot token or the webhook secret. Defaults to
// the acting account (ALS); pass an explicit id for the main mirror ('') from a tenant context.
function getTelegramConfig(accountId) {
    const acct = accountId === undefined ? (currentTenantAccount() || '') : (accountId || '');
    const s = _slot(acct);
    const out = {
        enabled: s.enabled,
        chatId: s.chatId,
        categories: s.categories,
        netbirdEvents: s.netbirdEvents,
        hasToken: !!s.token,
        tokenFromEnv: acct === '' ? !!_tgEnv.token : false,
        webhookConfigured: !!s.webhookSecret,
    };
    // MAIN-only mirror toggle: returned only for the main account, so a tenant GET can neither see
    // nor (via PUT) set it. Default TRUE.
    if (acct === '') out.tenantActivity = s.tenantActivity !== false;
    return out;
}
function getTelegramToken() { return _slot('').token; }
function getTelegramWebhookSecret() { return _slot('').webhookSecret; }

async function persistTelegram(acct) {
    const s = _slot(acct);
    const json = { enabled: s.enabled, chatId: s.chatId, categories: s.categories, netbirdEvents: s.netbirdEvents };
    if ((acct || '') === '') {
        json.webhookSecret = s.webhookSecret;             // MAIN-only
        json.tenantActivity = s.tenantActivity !== false; // MAIN-only
    }
    await setSetting(_cfgKey(acct), JSON.stringify(json));
}

async function setTelegramConfig({ enabled, chatId, categories, netbirdEvents, token, tenantActivity, account } = {}) {
    const acct = account === undefined ? (currentTenantAccount() || '') : (account || '');
    const s = _slot(acct);
    if (enabled !== undefined) s.enabled = !!enabled;
    if (chatId !== undefined) s.chatId = String(chatId || '').trim();
    if (categories && typeof categories === 'object') s.categories = categories;
    if (Array.isArray(netbirdEvents)) s.netbirdEvents = netbirdEvents;
    // MAIN-only flag: accepted only for the main slot; a tenant PUT can never set it.
    if (acct === '' && tenantActivity !== undefined) s.tenantActivity = !!tenantActivity;
    await persistTelegram(acct);
    // Token: env wins for MAIN only; tenant tokens are settings-only.
    const envWins = acct === '' && !!_tgEnv.token;
    if (!envWins && token !== undefined && String(token).trim() !== '') {
        s.token = String(token).trim();
        await setSetting(_tokKey(acct), s.token);
    }
    return getTelegramConfig(acct);
}

// Live view of the acting account's raw Telegram state. INTERNAL - for db.js domain code that
// needs fields getTelegramConfig() does not expose. Not for external callers.
function getTelegramState() { return _slot(currentTenantAccount() || ''); }

function tgEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Optional observer called after every ACTUAL send attempt (success or failure) - db.js
// registers the outbound log here. The disabled/no-token early return is NOT reported:
// nothing left the server. One-way dependency holds: only the handed-in function is called.
let _onSend = null;
function setTelegramObserver(fn) { _onSend = typeof fn === 'function' ? fn : null; }

// ─── Send queue ───
// Messages are never posted straight to the Bot API: they enter a FIFO queue drained by a
// single worker, so bursts (weekly digest, event storms) can't race each other into
// Telegram's per-chat rate limit and get silently dropped. Only a 2xx response counts as
// sent. ANY other result - a network error or timeout (httpJson returns status 0), an API
// rejection (4xx, including 429), a server error (5xx) or a thrown error - pauses the WHOLE
// queue for a minute (or Telegram's retry_after, if longer) and the message is retried in
// place; it is only reported as failed after TG_MAX_ATTEMPTS. A timeout may hide a message
// Telegram already accepted, so a retry can post it twice.
const TG_RETRY_WAIT_MS = 60_000;
const TG_MAX_ATTEMPTS = 5;
const TG_QUEUE_LIMIT = 1000; // runaway backstop - never expected in practice
const _tgQueue = [];
let _tgDraining = false;
let _tgSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Test seam: replaces the retry wait so tests need not wait a real minute.
function _setTelegramSleepForTests(fn) { _tgSleep = fn; }
// Process-lifetime counters for System Health (reset on restart, like scheduler stats).
const _tgStats = { sent: 0, failed: 0, retries: 0, lastSentAt: null, lastErrorAt: null, lastError: '', pausedUntil: 0 };

// Queue snapshot for the System Health page.
function getTelegramQueueStats() {
    const paused = _tgStats.pausedUntil > Date.now();
    return {
        queued: _tgQueue.length,
        paused,
        pausedUntil: paused ? new Date(_tgStats.pausedUntil).toISOString() : null,
        sent: _tgStats.sent, failed: _tgStats.failed, retries: _tgStats.retries,
        lastSentAt: _tgStats.lastSentAt, lastErrorAt: _tgStats.lastErrorAt, lastError: _tgStats.lastError,
    };
}

function enqueueTelegram(job) {
    return new Promise((resolve) => {
        if (_tgQueue.length >= TG_QUEUE_LIMIT) {
            console.error('[Telegram] queue overflow - dropping message');
            job.observe(false, 'queue overflow');
            return resolve(null);
        }
        _tgQueue.push({ ...job, resolve, attempts: 0 });
        drainTelegramQueue();
    });
}

async function drainTelegramQueue() {
    if (_tgDraining) return;
    _tgDraining = true;
    try {
        while (_tgQueue.length) {
            const job = _tgQueue[0];
            job.attempts++;
            let outcome;
            try {
                // The token was captured at enqueue time from the QUEUING account's config - the
                // ALS context is gone by now, so each job carries its own token explicitly.
                const r = await httpJson('POST', `https://api.telegram.org/bot${job.token}/sendMessage`, { body: job.body });
                if (r && r.status >= 200 && r.status < 300) {
                    outcome = { result: r.body && r.body.result };
                } else {
                    const ra = Number(r && r.body && r.body.parameters && r.body.parameters.retry_after) || 0;
                    outcome = { retry: true, waitMs: Math.max(ra * 1000, TG_RETRY_WAIT_MS), error: String((r && (r.raw || r.error || r.status)) || 'send failed') };
                }
            } catch (e) {
                outcome = { retry: true, waitMs: TG_RETRY_WAIT_MS, error: e.message };
            }
            if (outcome.retry && job.attempts < TG_MAX_ATTEMPTS) {
                console.warn(`[Telegram] send failed (attempt ${job.attempts}/${TG_MAX_ATTEMPTS}): ${outcome.error} - queue paused ${Math.round(outcome.waitMs / 1000)}s (${_tgQueue.length} message(s) waiting)`);
                _tgStats.retries++;
                _tgStats.lastError = outcome.error;
                _tgStats.lastErrorAt = new Date().toISOString();
                _tgStats.pausedUntil = Date.now() + outcome.waitMs;
                await _tgSleep(outcome.waitMs);
                _tgStats.pausedUntil = 0;
                continue; // job stays at the head - retried next iteration
            }
            _tgQueue.shift();
            if (outcome.error) {
                console.error('[Telegram] send failed:', outcome.error);
                _tgStats.failed++;
                _tgStats.lastError = outcome.error;
                _tgStats.lastErrorAt = new Date().toISOString();
                job.observe(false, outcome.error);
                job.resolve(null);
            } else {
                _tgStats.sent++;
                _tgStats.lastSentAt = new Date().toISOString();
                job.observe(true);
                const res = outcome.result;
                job.resolve(res ? { chatId: String((res.chat && res.chat.id) || job.fallbackChatId), messageId: String(res.message_id) } : null);
            }
        }
    } finally {
        _tgDraining = false;
        if (_tgQueue.length) drainTelegramQueue(); // pushed while the last job was in flight
    }
}

// Post one HTML message to the category's topic thread (or the group default), via the send
// queue above. opts.replyMarkup adds inline buttons; opts.chatId posts to a different group
// (e.g. the separate approvals group) - topics are per-group so no topic is applied in that
// case. Resolves to { chatId, messageId } once the message is ACTUALLY sent (null on failure).
async function sendTelegram(category, html, { replyMarkup, chatId, replyTo, account } = {}) {
    // Resolve the config of the account QUEUING this message. Defaults to the acting account
    // (ALS); `account` forces a specific slot - the main mirror passes account: '' from a tenant
    // context. A tenant without config (or disabled) simply sends nothing - never main's config.
    const acct = account === undefined ? (currentTenantAccount() || '') : (account || '');
    const cfg = _slot(acct);
    const chat = chatId || cfg.chatId;
    if (!cfg.enabled || !cfg.token || !chat) return null;
    const body = { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true };
    if (!chatId) {
        const cat = cfg.categories[category];
        const t = cat && cat.topic ? parseInt(cat.topic, 10) : NaN;
        if (Number.isFinite(t)) body.message_thread_id = t;
    }
    if (replyTo) body.reply_parameters = { message_id: parseInt(replyTo, 10), allow_sending_without_reply: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const observe = (ok, error) => {
        try { _onSend && _onSend({ chat: String(chat), category: category || '', text: html, ok, error }); }
        catch { /* observer must never break sends */ }
    };
    // Capture the token NOW - the ALS context is lost by the time the queue drains.
    return enqueueTelegram({ body, token: cfg.token, observe, fallbackChatId: String(chat) });
}

// Raw Telegram Bot API call helper. MAIN account only - it backs the callback webhook + the
// approvals button edits, which are main-account features.
async function telegramApi(method, body) {
    const token = _slot('').token;
    if (!token) return null;
    try {
        return await httpJson('POST', `https://api.telegram.org/bot${token}/${method}`, { body });
    } catch (e) {
        console.error('[Telegram] %s error: %s', method, e.message);
        return null;
    }
}

function answerCallbackQuery(id, text) {
    return telegramApi('answerCallbackQuery', { callback_query_id: id, text: text || '', show_alert: false });
}

// Replace a sent message's text (used to show the outcome + drop the buttons).
function editTelegramMessage(chatId, messageId, html) {
    return telegramApi('editMessageText', {
        chat_id: chatId, message_id: parseInt(messageId, 10), text: html,
        parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] },
    });
}
// Swap only a message's inline keyboard (used to open/close the approve-duration / deny submenus).
function editTelegramReplyMarkup(chatId, messageId, replyMarkup) {
    return telegramApi('editMessageReplyMarkup', { chat_id: chatId, message_id: parseInt(messageId, 10), reply_markup: replyMarkup });
}

// Register / clear the Telegram webhook so button presses reach us. The secret is echoed by
// Telegram in the X-Telegram-Bot-Api-Secret-Token header on every callback.
async function telegramSetWebhook(baseUrl) {
    const main = _slot(''); // the callback webhook is a MAIN-account feature
    if (!main.token || !baseUrl) return { ok: false, error: 'missing token or BASE_URL' };
    if (!main.webhookSecret) {
        main.webhookSecret = require('crypto').randomBytes(24).toString('hex');
        await persistTelegram('');
    }
    const url = baseUrl.replace(/\/+$/, '') + '/api/integrations/telegram/callback';
    // 'message' too, so a denial reason typed as a reply to the bot's prompt reaches us.
    const r = await telegramApi('setWebhook', { url, secret_token: main.webhookSecret, allowed_updates: ['callback_query', 'message'] });
    const ok = !!(r && r.status < 300 && r.body && r.body.ok);
    if (!ok) console.error('[Telegram] setWebhook failed:', r && (r.raw || r.error || r.status));
    return { ok, url };
}
function telegramDeleteWebhook() { return telegramApi('deleteWebhook', {}); }

// Per-category emoji for the header line.
const TG_CAT_EMOJI = {
    resources: '📦', networks: '🌐', policies: '🛡️', inventory: '👥', automation: '🤖', settings: '⚙️', requests: '🙋', alerts: '🚨',
    nb_peers: '💻', nb_users: '👤', nb_groups: '👥', nb_policies: '🛡️', nb_keys: '🔑', nb_network: '🌐', nb_other: '🔔',
};

async function telegramTest() {
    // Tests the ACTING account's config (main or the tenant being managed).
    const s = _slot(currentTenantAccount() || '');
    if (!s.token) return { ok: false, error: 'Bot token is required.' };
    if (!s.chatId) return { ok: false, error: 'Chat ID is required.' };
    const r = await httpJson('POST', `https://api.telegram.org/bot${s.token}/sendMessage`, {
        body: { chat_id: s.chatId, text: '✅ NetBird Control - Telegram notifications are connected.', disable_web_page_preview: true },
    });
    if (!r || !(r.status >= 200 && r.status < 300)) return { ok: false, error: (r && (r.raw || r.error)) || `HTTP ${r && r.status}` };
    return { ok: true };
}

// Auto-create a forum topic per category and store the returned thread ids. `namesByKey` is
// { categoryKey: "Display name" }. Skips categories that already have a topic. The bot must be
// a group admin with the "Manage Topics" permission, and the group must have Topics enabled.
async function telegramCreateTopics(namesByKey) {
    // Creates topics in the ACTING account's group, using that account's bot token + chat.
    const acct = currentTenantAccount() || '';
    const s = _slot(acct);
    if (!s.token) return { ok: false, error: 'Bot token is required.' };
    if (!s.chatId) return { ok: false, error: 'Chat ID is required.' };
    const names = (namesByKey && typeof namesByKey === 'object') ? namesByKey : {};
    const created = [];
    const errors = [];
    for (const [key, name] of Object.entries(names)) {
        const cur = s.categories[key];
        if (cur && cur.topic) continue; // already has a topic
        const r = await httpJson('POST', `https://api.telegram.org/bot${s.token}/createForumTopic`, {
            body: { chat_id: s.chatId, name: String(name || key).slice(0, 128) },
        });
        const threadId = r && r.body && r.body.ok && r.body.result && r.body.result.message_thread_id;
        if (threadId) {
            s.categories[key] = { ...(s.categories[key] || {}), topic: String(threadId) };
            created.push(key);
        } else {
            const desc = (r && r.body && (r.body.description || r.body.error)) || (r && (r.error || r.raw)) || `HTTP ${r && r.status}`;
            errors.push(`${name}: ${desc}`);
        }
    }
    await persistTelegram(acct);
    return { ok: errors.length === 0, created: created.length, errors };
}

module.exports = {
    loadTelegram, getTelegramConfig, getTelegramToken, getTelegramWebhookSecret, setTelegramConfig,
    getTelegramState,
    tgEsc, TG_CAT_EMOJI,
    sendTelegram, setTelegramObserver, getTelegramQueueStats, telegramApi, answerCallbackQuery, editTelegramMessage, editTelegramReplyMarkup,
    telegramSetWebhook, telegramDeleteWebhook, telegramTest, telegramCreateTopics,
    _setTelegramSleepForTests,
};
