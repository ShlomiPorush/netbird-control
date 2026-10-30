const https = require('https');
const http = require('http');
// Core infrastructure (the pg connection pool + the app_settings accessors) lives in lib/core.js
// (one-way dependency: db.js -> lib/core.js). db.js imports the pool and re-exports
// getSetting/setSetting under their original names so every existing call site and every name
// server.js destructures from require('./db') is unchanged.
// cappedCount is the shared bounded row count for every paginated LOG list (exact COUNT(*) over a
// multi-GB table was a per-page-load full scan of the filtered slice).
const { pool, getSetting, setSetting, cappedCount } = require('./lib/core');
// Event store + queries (the pure pool work over events / admin_events / ip_assignments /
// filter_rules) live in lib/events.js (one-way dependency: db.js -> lib/events.js -> lib/core.js).
// db.js imports them under their original names and re-exports what server.js needs. events.js
// registers invalidateFilterCache with core so setSetting keeps busting the filter cache as before.
// The domain-coupled event functions (addAdminEvent, queryAdminEvents, purgeOldEvents, getAuditLog,
// syncIpAssignments) stay in db.js.
const {
    addEvent, mapApiTrafficEvent, isNoiseTraffic, eventMatchesFilters,
    getAdminStats, queryIpHistory, getIpHistoryUsers,
    queryEvents, getDistinctUsers, getDistinctSources, queryTrafficSummary,
    getStats, getHourlyEventCounts, getFilterConfig, getBuiltinNoise, setBuiltinNoise, getFilterRules,
    createFilterRule, updateFilterRule, deleteFilterRule, invalidateFilterCache, scanEvents, deleteEventsByIds,
} = require('./lib/events');
// Pure, dependency-free helpers live in lib/pure.js (one-way dependency: db.js -> lib/pure.js,
// never the reverse). Imported under their original names so all existing call sites are unchanged.
const { splitPortTokens, mergeRulePorts, comboKey, combosForResource, ALL_COMBO, postureIds, postureChecksFor, stableStringify, humanDuration, normAccessSpec, mergeAccessSpecs, accessSpecCombos, mergeProxyTargets, peerNetworkAddresses, tgFirstLine, isPlausibleEmail, routingPeerName } = require('./lib/pure');
// SMTP transport layer lives in lib/mail.js (one-way dependency: db.js -> lib/mail.js). It pulls
// getSetting/setSetting straight from lib/core.js, so there is nothing to inject. The domain
// notify*Email helpers stay in db.js and use the imported sendMail/mailLayout/mailRows/htmlEsc.
const { loadSmtp, getSmtpConfig, setSmtpConfig, smtpTest, sendMail, setMailObserver, htmlEsc, mailLayout, mailRows } = require('./lib/mail');
// Shared low-level HTTP helper lives in lib/http.js (one-way dependency: db.js -> lib/http.js). It
// owns httpJson (used by the automations pollers below) plus the NetBird "last contact" timestamp,
// read here via getNetbirdLastOk for the System Health page. (The NetBird raw callers in
// lib/netbird.js record their successes through http's noteNetbirdOk directly.)
const { httpJson, getNetbirdLastOk } = require('./lib/http');
// Telegram transport layer lives in lib/telegram.js (one-way dependency: db.js -> lib/telegram.js).
// It pulls getSetting/setSetting from lib/core.js and httpJson from lib/http.js directly, so there
// is nothing to inject. The domain-side Telegram logic (handleTelegramCallback, reqKb* keyboards,
// accessRequestHtml, notifyAccessRequestTelegram, sendAnomalyAlert, TG_ACTION_LABELS,
// tgFormat*/tgResolve*, etc.) stays in db.js and uses the imported transport helpers.
const {
    loadTelegram, getTelegramConfig, getTelegramWebhookSecret, setTelegramConfig,
    tgEsc, TG_CAT_EMOJI, sendTelegram, setTelegramObserver, getTelegramQueueStats, telegramApi, answerCallbackQuery, editTelegramMessage,
    editTelegramReplyMarkup, telegramSetWebhook, telegramDeleteWebhook, telegramTest, telegramCreateTopics,
} = require('./lib/telegram');

// ─── Outbound log - a row per email / Telegram message the app actually sent ───
// Registered as transport observers so EVERY call site is covered automatically; writes are
// fire-and-forget and clipped, so logging can never slow down or break a notification.
async function logOutbound({ channel, recipient, feature, subject, ok, error, body }) {
    await pool.query(
        `INSERT INTO outbound_log (channel, recipient, feature, subject, ok, error, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [channel, String(recipient || '').slice(0, 200), String(feature || '').slice(0, 60),
         String(subject || '').slice(0, 300), ok !== false, String(error || '').slice(0, 500),
         // CLIP the body so a runaway template can never bloat the row.
         String(body || '').slice(0, 200_000)]
    ).catch(e => console.error('[Outbound] log write error:', e.message));
}
setMailObserver(({ to, subject, tag, ok, error, html, text }) =>
    logOutbound({ channel: 'email', recipient: to, feature: tag, subject, ok, error, body: html || text || '' }));
setTelegramObserver(({ chat, category, text, ok, error }) =>
    logOutbound({ channel: 'telegram', recipient: chat, feature: category, subject: tgFirstLine(text), ok, error, body: text || '' }));

// ─── NetBird Management API connection + caches live in lib/netbird.js ───
// (one-way dependency: db.js -> lib/netbird.js -> lib/core.js + lib/http.js, never the reverse).
// db.js imports the client, the caches and the cache-bust helpers under their original names so
// every call site and every name server.js destructures from require('./db') is unchanged. The
// DB-backed consumers (ensurePeersFresh/ensureUsersFresh/upsertPeers, anomaly + domain code) stay
// here and use the imported client + caches. _nbApi is the live connection object (url/token are
// mutated in place, never reassigned), read directly by the peers/users raw fetchers below.
const {
    _nbApi, loadNbApi, getNbApiConfig, setNbApiConfig, netbirdApiConfigured,
    NETBIRD_READONLY, readOnlyResp, netbirdGet, netbirdPost, netbirdPut, netbirdReq,
    bustNbCaches, resetNbCaches, setCacheResetHook,
    ensureGroupsFresh, ensurePoliciesFresh, getGroupsMap,
    getGroupRefMap, getUsageData, getReverseProxyStatus, bustReverseProxyCache,
    refreshBypassedPeers, peerIsBypassed, getBypassedPeerCount,
    runWithTenant, currentTenantAccount, getMspStatus, bustMspCache,
    loadTenantTokens, setTenantTokenInMemory, hasTenantToken,
    getMspProvisioningToken, setMspProvisioningTokenInMemory,
} = require('./lib/netbird');
// The tenant scope of the CURRENT request for DB queries: '' = the main account. Every
// tenant-aware table carries a `tenant` column; feature queries converted to multi-tenant
// filter on tnt(), so tenant A's rows can never surface under tenant B or under main.
const tnt = () => currentTenantAccount() || '';
// resetNbCaches (delegated to lib/netbird.js) must also drop db.js's own peers/users caches to
// match its original full-reset behavior; register that via the hook. _usersLastRefresh /
// _peersLastRefresh are per-account Maps declared further down (initialized before any reset
// runs at runtime); a full reset empties them so EVERY account re-pulls on next use.
setCacheResetHook(() => { _usersLastRefresh.clear(); _peersLastRefresh.clear(); });

// ─── Incoming-webhook auth tokens (per account) ───
// TWO independent Bearer tokens, deliberately unrelated: one for the events webhook
// (POST /api/webhook, env WEBHOOK_AUTH_TOKEN wins) and one for the account-notifications
// webhook (POST /api/integrations/netbird-notifications, DB-only). Either can be set,
// rotated or revoked without touching the other - handing one channel to a third party
// never exposes the second. Both tokens are PER ACCOUNT: the bare key for the main account,
// `key:<tenant>` in a tenant context (mirrors the dupKey pattern) - so a tenant sets its OWN
// tokens in Settings → Webhook and its NetBird posts to /api/webhook/t/<tenant>. Tenant tokens
// are read from settings on demand; only the env-managed MAIN events token is cached in memory.
const _whEnv = { token: process.env['WEBHOOK_AUTH_TOKEN'] || '' };
let _mainWhToken = _whEnv.token; // main account's events token (env wins, else app_settings)
const whTokenKey = () => tnt() ? `webhook_auth_token:${tnt()}` : 'webhook_auth_token';
const whNotifKey = () => tnt() ? `webhook_notif_token:${tnt()}` : 'webhook_notif_token';

async function loadWebhook() {
    try {
        const v = await getSetting('webhook_auth_token');
        if (!_whEnv.token && v) _mainWhToken = v;
    } catch (e) {
        console.error('[Webhook] config load error:', e.message);
    }
}

// The actual tokens for the CURRENT account - for the receiver middlewares only (never sent
// to the client). Async because a tenant's tokens are read from settings on demand.
async function getWebhookToken() {
    if (!tnt()) return _mainWhToken || '';
    return (await getSetting(whTokenKey()).catch(() => '')) || '';
}
async function getNotifWebhookToken() {
    return (await getSetting(whNotifKey()).catch(() => '')) || '';
}

// Read-safe config for the CURRENT account's UI - never exposes the tokens, only whether they
// are set. tokenFromEnv only ever applies to the main account (tenants have no env override).
async function getWebhookConfig() {
    const isMain = !tnt();
    const evTok = await getWebhookToken();
    const nTok = await getNotifWebhookToken();
    // Most recent activity event + account notification for the CURRENT account. This is only a
    // freshness HINT for the UI tooltip - NOT the "is the feature on" signal: traffic events can also
    // arrive via the API pull, so their presence is not proof the streaming integration exists. The
    // authoritative on/off signal comes from getNetbirdWebhookStatus (reads NetBird itself).
    const evLast = await pool.query(
        `SELECT MAX(timestamp) AS at FROM events WHERE tenant = $1`, [tnt()]).catch(() => ({ rows: [] }));
    const nLast = await pool.query(
        `SELECT MAX(received_at) AS at FROM nb_notifications WHERE tenant = $1`, [tnt()]).catch(() => ({ rows: [] }));
    return {
        hasToken: !!evTok, tokenFromEnv: isMain && !!_whEnv.token, authEnabled: !!evTok,
        hasNotifToken: !!nTok, notifAuthEnabled: !!nTok,
        eventsLastAt: (evLast.rows[0] && evLast.rows[0].at) || null,
        notifLastAt: (nLast.rows[0] && nLast.rows[0].at) || null,
    };
}

// Live "is the feature actually set up in NetBird" probe for the CURRENT account. This is the honest
// on/off signal the Webhook page badges use: it reads NetBird's own integration state, independent of
// whether any rows have arrived (traffic events can also come via the API pull, so data presence alone
// is not proof the Generic HTTP streaming integration exists). Matches by our receiver PATH (the host
// may differ behind a reverse proxy). Each probe is independent and returns null when it cannot be
// determined (API not configured, plan lacks the feature, or a transient error) so the UI degrades to
// "Unknown" rather than lying. Runs in whatever account context the caller is in.
async function getNetbirdWebhookStatus() {
    if (!netbirdApiConfigured()) return { eventStreaming: null, notifications: null };
    const probeEvents = async () => {
        try {
            const list = await netbirdGet('/api/integrations/event-streaming');
            const i = (Array.isArray(list) ? list : []).find(x => x && x.platform === 'generic_http'
                && x.config && typeof x.config.url === 'string' && x.config.url.includes('/api/webhook'));
            return i ? { configured: true, enabled: i.enabled !== false } : { configured: false, enabled: false };
        } catch { return null; }
    };
    const probeNotifs = async () => {
        try {
            const channels = await netbirdGet('/api/integrations/notifications/channels');
            const c = (Array.isArray(channels) ? channels : []).find(x => x && x.type === 'webhook'
                && x.target && typeof x.target.url === 'string' && x.target.url.includes('/api/integrations/netbird-notifications'));
            return c ? { configured: true, enabled: c.enabled !== false } : { configured: false, enabled: false };
        } catch { return null; }
    };
    const [eventStreaming, notifications] = await Promise.all([probeEvents(), probeNotifs()]);
    return { eventStreaming, notifications };
}

// Set or clear either webhook token for the current account. The env-managed MAIN events token
// is immutable; an empty/omitted token is ignored unless the matching `clear` flag is set.
async function setWebhookConfig({ token, clear, notifToken, clearNotif } = {}) {
    const isMain = !tnt();
    if (!(isMain && _whEnv.token)) {
        if (clear) {
            if (isMain) _mainWhToken = '';
            await setSetting(whTokenKey(), '');
        } else if (token !== undefined && String(token).trim() !== '') {
            const t = String(token).trim();
            if (isMain) _mainWhToken = t;
            await setSetting(whTokenKey(), t);
        }
    }
    if (clearNotif) {
        await setSetting(whNotifKey(), '');
    } else if (notifToken !== undefined && String(notifToken).trim() !== '') {
        await setSetting(whNotifKey(), String(notifToken).trim());
    }
    return getWebhookConfig();
}

// ─── One-click NetBird Account Notifications setup (per account) ───
// Every NetBird event type a notifications webhook channel can push (from the official dashboard).
const NB_NOTIF_EVENT_TYPES = [
    'peer.pending.approval', 'peer.add', 'routing.peer.disconnect', 'routing.peer.delete',
    'user.pending.approval', 'user.join', 'service.user.create',
    'idp.sync.token.expire', 'edr.sync.token.expire',
];
// Point the CURRENT account's NetBird notifications at our receiver `url` in one call. Runs in
// whatever account context the caller is in (main or a managed tenant), so all netbird* calls and
// the token write target that account. A stored notifications token's plaintext is never
// recoverable, so to guarantee the NetBird channel and our stored token match we ALWAYS generate a
// fresh token, store it, and (re)create-or-update the account's single webhook channel with it -
// callers surface `rotatedToken` so this is visible. Errors bubble up with NetBird's message.
async function autoConfigureNbNotifications(url) {
    if (!netbirdApiConfigured()) throw new Error('NetBird API is not configured');
    const receiver = String(url || '').trim();
    if (!receiver) throw new Error('a receiver URL is required');
    // Always mint + store a fresh ingest token (see note above), then wire the channel to it.
    const token = require('crypto').randomBytes(24).toString('hex');
    await setWebhookConfig({ notifToken: token });
    const channels = await netbirdGet('/api/integrations/notifications/channels');
    const existing = (Array.isArray(channels) ? channels : []).find(c => c && c.type === 'webhook');
    const payload = {
        type: 'webhook', enabled: true, event_types: NB_NOTIF_EVENT_TYPES,
        target: { url: receiver, headers: { Authorization: `Bearer ${token}` } },
    };
    const r = existing && existing.id
        ? await netbirdPut(`/api/integrations/notifications/channels/${encodeURIComponent(existing.id)}`, payload)
        : await netbirdPost('/api/integrations/notifications/channels', payload);
    if (!r || r.status >= 300) {
        throw new Error((r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)) || 'NetBird API error');
    }
    return { configured: true, created: !(existing && existing.id), url: receiver, rotatedToken: true };
}

// ─── One-click NetBird Event Streaming setup (per account) ───
// Point the CURRENT account's activity/traffic Event Streaming (the Generic HTTP integration) at our
// events receiver `url` in one call - mirrors autoConfigureNbNotifications and runs in whatever
// account context the caller is in (main or a managed tenant). Token handling differs from
// notifications: the events ingest token for the MAIN account may be ENV-managed (WEBHOOK_AUTH_TOKEN,
// immutable). So when the current account is MAIN AND that env token is set, we reuse the env token's
// plaintext in the Authorization header WITHOUT rotating (rotatedToken:false); otherwise (main without
// env token, or any tenant) we mint + store a fresh token exactly like notifications (rotatedToken:true,
// stored under the account's events-token key via setWebhookConfig). CONSTRAINT: NetBird's
// config.headers is a JSON-ENCODED STRING of the headers object, not a nested object (matches the
// official dashboard's JSON.stringify(formatHeaders())). We omit body_template so NetBird's default
// payload - what our receiver parses - is used. Errors bubble up with NetBird's own message verbatim,
// so a tenant lacking the event-streaming plan surfaces NetBird's error as-is.
async function autoConfigureNbEventStreaming(url) {
    if (!netbirdApiConfigured()) throw new Error('NetBird API is not configured');
    const receiver = String(url || '').trim();
    if (!receiver) throw new Error('a receiver URL is required');
    const isMain = !tnt();
    // Env-managed MAIN events token: reuse its plaintext, never rotate. Otherwise mint + store fresh.
    let token, rotatedToken;
    if (isMain && _whEnv.token) {
        token = _whEnv.token;
        rotatedToken = false;
    } else {
        token = require('crypto').randomBytes(24).toString('hex');
        await setWebhookConfig({ token });
        rotatedToken = true;
    }
    const headers = JSON.stringify({ Authorization: `Bearer ${token}` });
    const list = await netbirdGet('/api/integrations/event-streaming');
    const existing = (Array.isArray(list) ? list : []).find(i => i && i.platform === 'generic_http');
    // create takes `platform`; update (PUT /{id}) must NOT include it.
    const r = existing && existing.id
        ? await netbirdPut(`/api/integrations/event-streaming/${encodeURIComponent(existing.id)}`, { enabled: true, config: { url: receiver, headers } })
        : await netbirdPost('/api/integrations/event-streaming', { platform: 'generic_http', enabled: true, config: { url: receiver, headers } });
    if (!r || r.status >= 300) {
        throw new Error((r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)) || 'NetBird API error');
    }
    return { configured: true, created: !(existing && existing.id), url: receiver, rotatedToken };
}

// The Telegram config state + accessors (loadTelegram, getTelegramConfig, getTelegramToken,
// getTelegramWebhookSecret, setTelegramConfig) now live in lib/telegram.js (imported at the top).

// ─── Feature permissions: grant specific capabilities to non-admin users/groups ───
// Each key unlocks one admin-gated capability for the listed users and/or Entra/NetBird
// groups (admins always have everything). Adding a capability = one entry here + a
// requirePerm(...) (or perm-aware check) on its routes.
const PERMISSION_KEYS = ['activity.all', 'peers.all', 'audit.view', 'temp.manage', 'networks.manage', 'proxy.manage', 'troubleshoot.all', 'tenants.support'];
const _featurePerms = {}; // key → { users: [{id,email,name}], groupIds: [] }

function normPermEntry(e) {
    const users = (Array.isArray(e && e.users) ? e.users : [])
        .map(u => u && ({ id: String(u.id || '').trim(), email: String(u.email || '').trim().toLowerCase(), name: String(u.name || '').trim() }))
        .filter(u => u && (u.id || u.email));
    const groupIds = (Array.isArray(e && e.groupIds) ? e.groupIds : []).map(s => String(s).trim()).filter(Boolean);
    return { users, groupIds };
}
async function loadFeaturePerms() {
    try {
        const v = await getSetting('feature_permissions');
        const c = v ? (JSON.parse(v) || {}) : {};
        for (const k of PERMISSION_KEYS) _featurePerms[k] = normPermEntry(c[k] || {});
    } catch (e) {
        console.error('[Permissions] config load error:', e.message);
        for (const k of PERMISSION_KEYS) _featurePerms[k] = _featurePerms[k] || { users: [], groupIds: [] };
    }
}
function getFeaturePermsConfig() {
    const out = {};
    for (const k of PERMISSION_KEYS) out[k] = _featurePerms[k] || { users: [], groupIds: [] };
    return out;
}
async function setFeaturePermsConfig(cfg) {
    for (const k of PERMISSION_KEYS) {
        if (cfg && cfg[k] !== undefined) _featurePerms[k] = normPermEntry(cfg[k]);
    }
    await setSetting('feature_permissions', JSON.stringify(getFeaturePermsConfig()));
    return getFeaturePermsConfig();
}
// The viewer's effective permission map. Matches a user by NetBird user id / oid tail / email,
// and groups against the viewer's FULL group union (same semantics as network grants).
function resolveFeaturePerms({ isAdmin, userId, oid, email, groups } = {}) {
    const out = {};
    const em = String(email || '').toLowerCase();
    const ids = new Set([String(userId || ''), String(oid || ''), String(userId || '').split('|').pop()].filter(Boolean));
    const gset = new Set((groups || []).map(String));
    for (const k of PERMISSION_KEYS) {
        if (isAdmin) { out[k] = true; continue; }
        const e = _featurePerms[k] || { users: [], groupIds: [] };
        out[k] = e.users.some(u => (u.email && u.email === em) || (u.id && (ids.has(u.id) || ids.has(u.id.split('|').pop()))))
            || e.groupIds.some(g => gset.has(g));
    }
    return out;
}

// ─── Security & alerts config (in-app: Settings → Security; app_settings-backed) ───
// The whole security & alerts config block (SECURITY_DEFAULTS, secNum, normSecurityConfig,
// loadSecurityConfig, get/setSecurityConfig, RETENTION_WARN_DAYS and the live _security state)
// now lives in lib/security.js (one-way dependency: db.js -> lib/security.js -> lib/core.js).
// _security is bound as a LIVE reference: applySecurityConfig mutates it key-by-key and never
// reassigns it, so every existing `_security.foo` read below keeps working through this binding.
const {
    _security, RETENTION_WARN_DAYS,
    loadSecurityConfig, normSecurityConfig, getSecurityConfig, setSecurityConfig,
} = require('./lib/security');

// The SMTP transport layer (config state, nodemailer transport, sendMail, and the shared mail
// HTML shell: getSmtpConfig/setSmtpConfig/smtpTest/loadSmtp/sendMail/htmlEsc/mailLayout/mailRows)
// now lives in lib/mail.js (imported at the top). The domain notify*Email helpers below stay
// here and call those imported transport helpers.

// Fire-and-forget notification emails (each no-ops when SMTP is off or there's no recipient).
async function notifyGrantEmail({ to, name, targets, expiresAt, note }) {
    if (!getSmtpConfig().enabled || !to) return;
    const until = await formatConfiguredDate(expiresAt).catch(() => new Date(expiresAt).toISOString());
    const body = `<p>Hi ${htmlEsc(name || 'there')},</p>`
        + `<p>You've been granted <b>temporary access</b>${targets ? ` to <b>${htmlEsc(targets)}</b>` : ''}. It is active now and will be revoked automatically when it expires.</p>`
        + mailRows([['Access to', targets], ['Expires', until], note ? ['Note', note] : null]);
    sendMail({ to, subject: `Access granted${targets ? `: ${targets}` : ''}${tenantTag()}`, html: mailLayout('Access Granted', body), tag: 'access-granted' }).catch(() => { });
}
async function notifyGrantEndedEmail({ to, name, targets, trigger }) {
    if (!getSmtpConfig().enabled || !to) return;
    const word = trigger === 'expiry' ? 'expired' : 'been revoked';
    const body = `<p>Hi ${htmlEsc(name || 'there')},</p>`
        + `<p>Your <b>temporary access</b>${targets ? ` to <b>${htmlEsc(targets)}</b>` : ''} has ${word}. If you still need it, submit a new request.</p>`
        + mailRows([['Access to', targets]]);
    sendMail({ to, subject: `Temporary access ended${targets ? `: ${targets}` : ''}${tenantTag()}`, html: mailLayout('Temporary Access Ended', body), tag: 'access-ended' }).catch(() => { });
}
async function notifyBypassApprovedEmail({ to, name, device, minutes, tempDevice }) {
    if (!getSmtpConfig().enabled || !to) return;
    // minutes: what was ACTUALLY approved (0/undefined = unlimited). Timed bypasses also
    // show the concrete end time, formatted with the app's configured time zone.
    const timed = Number(minutes) > 0;
    const until = timed ? await tgFmtTime(new Date(Date.now() + Number(minutes) * 60000).toISOString()).catch(() => '') : '';
    const tempNote = tempDevice
        ? `<p style="margin:14px 0 0;"><b>Temporary device:</b> when the approved period ends, this device is <b>deleted automatically</b> - it must be re-enrolled to ever connect again.</p>`
        : '';
    const body = `<p>Hi ${htmlEsc(name || 'there')},</p>`
        + `<p>Your device <b>${htmlEsc(device)}</b> has been <b>approved</b> - it can now connect to the network.</p>`
        + mailRows([
            ['Device', device],
            ['Approved For', timed ? humanDuration(Number(minutes)) : 'Unlimited'],
            timed && until ? ['Until', until] : null,
        ])
        + tempNote;
    sendMail({ to, subject: `Device approved: ${device}`, html: mailLayout('Device Approved', body), tag: 'device-approved' }).catch(() => { });
}

// A device failed compliance on a login happening right now → tell its owner exactly what
// happened and what the two ways forward are, with a button straight to the request page.
async function notifyComplianceBlockedEmail({ to, name, device, reason }) {
    if (!getSmtpConfig().enabled || !to) return;
    const appUrl = process.env.BASE_URL || '';
    const font = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const btn = appUrl
        ? `<p style="margin:18px 0 0;"><a href="${htmlEsc(appUrl)}/request-access" style="display:inline-block;background-color:#f68330;color:#ffffff;font-family:${font};font-size:14px;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:8px;">Open Request Access</a></p>`
        : '';
    const body = `<p>Hi ${htmlEsc(name || 'there')},</p>`
        + `<p>Your device <b>${htmlEsc(device)}</b> just tried to connect to the network and was <b>blocked</b> - it does not pass the compliance checks, so it has no network access right now.</p>`
        + mailRows([['Device', device], reason ? ['Blocked because', reason] : null])
        + `<p style="margin:16px 0 6px;"><b>What you can do:</b></p>`
        + `<ul style="margin:0;padding-left:20px;">`
        + `<li style="margin:0 0 8px;"><b>Request a bypass</b> - ask an admin to approve this device. Once approved, it connects immediately.</li>`
        + `<li style="margin:0;"><b>Temporary device?</b> If this is a loaner or short-lived machine, tick <b>"Temporary device"</b> in the request - it gets approved for a limited time and is removed automatically when the period ends.</li>`
        + `</ul>`
        + `<p style="margin:14px 0 0;">Both options are on the Request Access page - your request goes straight to an admin for review:</p>`
        + btn;
    sendMail({ to, subject: `Device blocked by compliance: ${device}`, html: mailLayout('Device Blocked', body), tag: 'compliance-blocked' }).catch(() => { });
}

async function notifyBypassEndedEmail({ to, name, device, why }) {
    if (!getSmtpConfig().enabled || !to) return;
    const line = why === 'deleted'
        ? `The approved period for your temporary device <b>${htmlEsc(device)}</b> has ended and the device has been <b>deleted</b> - re-enroll it if you need it again.`
        : `The compliance bypass on your device <b>${htmlEsc(device)}</b> has ${why === 'expired' ? '<b>expired</b>' : 'been <b>removed</b>'} - it is blocked again until it passes the compliance checks.`;
    const body = `<p>Hi ${htmlEsc(name || 'there')},</p><p>${line}</p>` + mailRows([['Device', device]]);
    const subject = why === 'deleted' ? `Temporary device deleted: ${device}` : `Device bypass ${why === 'expired' ? 'expired' : 'removed'}: ${device}`;
    sendMail({ to, subject, html: mailLayout(why === 'deleted' ? 'Temporary Device Deleted' : 'Device Bypass Ended', body), tag: 'bypass-ended' }).catch(() => { });
}

async function notifyRequestDeniedEmail({ to, name, targets, reason }) {
    if (!getSmtpConfig().enabled || !to) return;
    const body = `<p>Hi ${htmlEsc(name || 'there')},</p>`
        + `<p>Your access request${targets ? ` for <b>${htmlEsc(targets)}</b>` : ''} was <b>denied</b>.</p>`
        + mailRows([['Requested', targets], reason ? ['Reason', reason] : null]);
    sendMail({ to, subject: `Access request denied${targets ? `: ${targets}` : ''}`, html: mailLayout('Access Request Denied', body), tag: 'request-denied' }).catch(() => { });
}

// ─── Access-request approvals: who may approve, in-app (Entra groups) and via Telegram ───
// Kept separate from the admin role so approvers get approval rights WITHOUT full admin.
// telegramApprovers: [{ telegramId, userId, name, email }] - each Telegram user id is mapped to a
// system user, so a Telegram approval is attributed to the real person (not the Telegram handle).
// delegates: [{ user: {id,email,name}, from, until }] - TIME-BOXED approval rights
// ("I'm away until the 20th - X approves instead"). Active while from <= today <= until
// (app time zone, inclusive); expires by itself, nothing to clean up.
const _approver = { groupIds: [], telegramChatId: '', telegramApprovers: [], delegates: [] };

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
function normDelegates(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(d => {
        if (!d || typeof d !== 'object' || !d.user || typeof d.user !== 'object') return null;
        const user = { id: String(d.user.id || '').trim(), email: String(d.user.email || '').trim().toLowerCase(), name: String(d.user.name || '').trim() };
        if (!user.id && !user.email) return null;
        const from = String(d.from || '').trim(), until = String(d.until || '').trim();
        if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(until) || from > until) return null;
        return { user, from, until };
    }).filter(Boolean);
}
// Does this viewer hold an ACTIVE delegation right now? Matched like feature perms:
// by user id (with the `|`-tail variant) or email.
async function isActiveDelegate({ oid, userId, email } = {}) {
    if (!_approver.delegates.length) return false;
    const today = (await tzNowParts()).dateKey;
    const em = String(email || '').toLowerCase();
    const ids = new Set([String(userId || ''), String(oid || ''), String(userId || '').split('|').pop()].filter(Boolean));
    return _approver.delegates.some(d =>
        d.from <= today && today <= d.until &&
        ((d.user.email && d.user.email === em) || (d.user.id && (ids.has(d.user.id) || ids.has(String(d.user.id).split('|').pop()))))
    );
}

// Normalize an approvers array to the object shape. Accepts the object form or a bare id string
// (legacy telegramApproverIds / approverIds) - the latter maps to an unmapped {telegramId} entry.
function normApprovers(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(a => {
        if (a && typeof a === 'object') {
            const telegramId = String(a.telegramId || a.id || '').trim();
            return telegramId ? { telegramId, userId: String(a.userId || '').trim(), name: String(a.name || '').trim(), email: String(a.email || '').trim() } : null;
        }
        const telegramId = String(a || '').trim();
        return telegramId ? { telegramId, userId: '', name: '', email: '' } : null;
    }).filter(Boolean);
}

async function loadApproverConfig() {
    try {
        const v = await getSetting('approver_config');
        if (v) {
            const c = JSON.parse(v) || {};
            _approver.groupIds = Array.isArray(c.groupIds) ? c.groupIds.map(String).filter(Boolean) : [];
            _approver.telegramChatId = c.telegramChatId || '';
            // Prefer the new mapping; fall back to (and migrate) the old bare-id list.
            _approver.telegramApprovers = normApprovers(c.telegramApprovers || c.telegramApproverIds);
            _approver.delegates = normDelegates(c.delegates);
            if (!c.telegramApprovers && Array.isArray(c.telegramApproverIds) && c.telegramApproverIds.length) await persistApprover();
        } else {
            // One-time migration: the Telegram approver fields used to live in telegram_config.
            const tg = await getSetting('telegram_config');
            if (tg) {
                const c = JSON.parse(tg) || {};
                _approver.telegramChatId = c.requestsChatId || '';
                _approver.telegramApprovers = normApprovers(c.approverIds);
                if (_approver.telegramChatId || _approver.telegramApprovers.length) await persistApprover();
            }
        }
    } catch (e) {
        console.error('[Approver] config load error:', e.message);
    }
}
async function persistApprover() {
    await setSetting('approver_config', JSON.stringify({
        groupIds: _approver.groupIds, telegramChatId: _approver.telegramChatId, telegramApprovers: _approver.telegramApprovers, delegates: _approver.delegates,
    }));
}
function getApproverConfig() {
    return { groupIds: _approver.groupIds, telegramChatId: _approver.telegramChatId, telegramApprovers: _approver.telegramApprovers, delegates: _approver.delegates };
}
async function setApproverConfig({ groupIds, telegramChatId, telegramApprovers, delegates } = {}) {
    if (Array.isArray(groupIds)) _approver.groupIds = groupIds.map(s => String(s).trim()).filter(Boolean);
    if (telegramChatId !== undefined) _approver.telegramChatId = String(telegramChatId || '').trim();
    if (Array.isArray(telegramApprovers)) _approver.telegramApprovers = normApprovers(telegramApprovers);
    if (Array.isArray(delegates)) _approver.delegates = normDelegates(delegates);
    await persistApprover();
    return getApproverConfig();
}
function getApproverGroupIds() { return _approver.groupIds; }
function getApproverByTelegramId(tgId) { return _approver.telegramApprovers.find(a => a.telegramId === String(tgId)) || null; }
function getApprovalsChatId() { return _approver.telegramChatId; }

// ─── Auto-approval: skip human review for trusted requesters / self-service targets ───
// trusted: [{ groupIds, maxMinutes, excludedTargets }] - members of any listed Entra group are
//   auto-approved for ANY target EXCEPT the entry's excludedTargets (critical resources that must
//   always go through review), capped by maxMinutes (0 = honor the requested length).
// rules:   [{ targets: [{type,id,name}], groupIds, maxMinutes }] - self-service: the listed
//   targets auto-approve for members of the listed groups, capped per rule.
// When several entries match a target, the MOST PERMISSIVE cap wins (0 = uncapped beats any number).
const _autoApproval = { trusted: [], rules: [] };
const normIdList = (a) => Array.isArray(a) ? a.map(s => String(s).trim()).filter(Boolean) : [];
const normTargetList = (a) => (Array.isArray(a) ? a : [])
    .map(t => t && ({ type: String(t.type || '').trim(), id: String(t.id || '').trim(), name: String(t.name || '').trim() }))
    .filter(t => t && t.type && t.id);
function normTrusted(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(t => {
        if (!t || typeof t !== 'object') return null;
        const groupIds = normIdList(t.groupIds);
        if (!groupIds.length) return null;
        // Network scoping: 'all' (default) · 'allow' (auto-approve ONLY inside these networks)
        // · 'block' (auto-approve everywhere EXCEPT these networks). Applies to network targets
        // AND to resources inside them.
        const networkMode = ['allow', 'block'].includes(t.networkMode) ? t.networkMode : 'all';
        const networks = (Array.isArray(t.networks) ? t.networks : [])
            .map(n => n && ({ id: String(n.id || '').trim(), name: String(n.name || '').trim() }))
            .filter(n => n && n.id);
        return {
            groupIds, maxMinutes: Math.max(0, parseInt(t.maxMinutes, 10) || 0),
            excludedTargets: normTargetList(t.excludedTargets),
            networkMode: networks.length ? networkMode : 'all', networks,
            enabled: t.enabled !== false, // paused entries stay configured but never match
        };
    }).filter(Boolean);
}
function normAutoRules(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(r => {
        if (!r || typeof r !== 'object') return null;
        const targets = normTargetList(r.targets);
        const groupIds = normIdList(r.groupIds);
        if (!targets.length || !groupIds.length) return null;
        // Optional access spec: exactly which protocols/ports the auto-approved grant opens
        // ({tcp:[…], udp:[…], icmp:true} - one temp policy per protocol). Absent = mirror the
        // target's existing exposure, like a human approval would.
        const access = normAccessSpec(r.access);
        return { targets, groupIds, maxMinutes: Math.max(0, parseInt(r.maxMinutes, 10) || 0), enabled: r.enabled !== false, ...(access ? { access } : {}) };
    }).filter(Boolean);
}
async function loadAutoApproval() {
    try {
        const v = await getSetting('auto_approval_config');
        if (!v) return;
        const c = JSON.parse(v) || {};
        if (Array.isArray(c.trusted) || (Array.isArray(c.rules) && c.rules[0] && Array.isArray(c.rules[0].targets))) {
            _autoApproval.trusted = normTrusted(c.trusted);
            _autoApproval.rules = normAutoRules(c.rules);
        } else {
            // One-time migration from the flat first version (trustedGroupIds + one global
            // maxMinutes + single-target rules) into per-entry caps / multi-target rules.
            const cap = Math.max(0, parseInt(c.maxMinutes, 10) || 0);
            const tg = normIdList(c.trustedGroupIds);
            _autoApproval.trusted = tg.length ? [{ groupIds: tg, maxMinutes: cap }] : [];
            _autoApproval.rules = normAutoRules((Array.isArray(c.rules) ? c.rules : []).map(r => r && r.targetId ? ({
                targets: [{ type: r.targetType, id: r.targetId, name: r.targetName }], groupIds: r.groupIds, maxMinutes: cap,
            }) : null));
            if (_autoApproval.trusted.length || _autoApproval.rules.length) await persistAutoApproval();
        }
    } catch (e) {
        console.error('[AutoApproval] config load error:', e.message);
    }
}
async function persistAutoApproval() {
    await setSetting('auto_approval_config', JSON.stringify({ trusted: _autoApproval.trusted, rules: _autoApproval.rules }));
}
function getAutoApprovalConfig() {
    return { trusted: _autoApproval.trusted, rules: _autoApproval.rules };
}
async function setAutoApprovalConfig({ trusted, rules } = {}) {
    if (Array.isArray(trusted)) _autoApproval.trusted = normTrusted(trusted);
    if (Array.isArray(rules)) _autoApproval.rules = normAutoRules(rules);
    await persistAutoApproval();
    return getAutoApprovalConfig();
}
// Per-target decision for a requester with Entra groups `groups`:
// { auto: [{ t, cap }], manual: [t…] } - cap is that target's effective max (0 = as requested).
// A trusted entry does NOT apply to targets it excludes (those fall back to review, unless a
// self-service rule explicitly allows them).
function autoApproveTargets(targets, groups) {
    const g = new Set((groups || []).map(String));
    const trustedEntries = _autoApproval.trusted.filter(tr => tr.enabled !== false && tr.groupIds.some(id => g.has(id)));
    const auto = [], manual = [];
    // The network a target lives in: the network itself, or a resource's parent network.
    // Profiles/groups have none - under an 'allow' scope they fall back to review (we can't
    // prove they're inside an approved network); under 'block' they pass.
    const netOf = (t) => t.type === 'network' ? String(t.id) : (t.type === 'resource' ? String(t.networkId || '') : '');
    for (const t of (targets || [])) {
        const caps = [];
        // Access restriction: rules WITH a spec collect it; a matching trusted entry or a
        // rule WITHOUT a spec means "unrestricted" (mirror existing exposure) and wins -
        // the most permissive matching entry decides, same as the duration caps.
        let unrestricted = false;
        const specs = [];
        for (const tr of trustedEntries) {
            if (tr.excludedTargets.some(x => x.type === t.type && x.id === String(t.id))) continue; // blocked for this entry
            const nid = netOf(t);
            if (tr.networkMode === 'allow' && !(nid && tr.networks.some(n => n.id === nid))) continue; // outside the approved networks
            if (tr.networkMode === 'block' && nid && tr.networks.some(n => n.id === nid)) continue;    // inside a blocked network
            caps.push(tr.maxMinutes);
            unrestricted = true;
        }
        for (const r of _autoApproval.rules) {
            if (r.enabled === false) continue; // paused rule - configured but inactive
            if (r.targets.some(x => x.type === t.type && x.id === String(t.id)) && r.groupIds.some(id => g.has(id))) {
                caps.push(r.maxMinutes);
                if (r.access) specs.push(r.access); else unrestricted = true;
            }
        }
        if (!caps.length) { manual.push(t); continue; }
        auto.push({ t, cap: caps.includes(0) ? 0 : Math.max(...caps), access: unrestricted ? null : mergeAccessSpecs(specs) });
    }
    return { auto, manual };
}

// tgEsc now lives in lib/telegram.js (imported at the top).

// An app-action's prefix → notification category.
function auditCategory(action) {
    const p = String(action || '').split('.')[0];
    if (p === 'resource' || p === 'router') return 'resources';
    if (p === 'network') return 'networks';
    if (p === 'policy') return 'policies';
    if (p === 'peer' || p === 'group' || p === 'access') return 'inventory';
    if (p === 'automation') return 'automation';
    if (p === 'request') return 'requests';
    return 'settings';
}

// Inverse of auditCategory: which action prefixes belong to each category (for the audit-log
// category filter). 'settings' is the catch-all - everything not claimed by another category.
const AUDIT_CATEGORY_PREFIXES = {
    resources: ['resource', 'router'],
    networks: ['network'],
    policies: ['policy'],
    inventory: ['peer', 'group', 'access'],
    automation: ['automation'],
    requests: ['request'],
};
// SQL fragment matching an audit category by action prefix (`split_part(action,'.',1)`); returns
// { sql, value } for a single bound param, or null for an unknown category.
function auditCategoryCond(category, idx) {
    const pref = AUDIT_CATEGORY_PREFIXES[category];
    if (pref) return { sql: `split_part(action, '.', 1) = ANY($${idx})`, value: pref };
    if (category === 'settings') {
        const known = Object.values(AUDIT_CATEGORY_PREFIXES).flat();
        return { sql: `NOT (split_part(action, '.', 1) = ANY($${idx}))`, value: known };
    }
    return null;
}

// A NetBird activity message → sub-topic key, so different kinds of NetBird events route to
// separate topics. Heuristic on the message text; order matters (most specific first).
function netbirdSubcategory(msg) {
    const m = String(msg || '').toLowerCase();
    if (/setup\s*key/.test(m)) return 'nb_keys';
    if (/policy|\brule\b|access control|posture/.test(m)) return 'nb_policies';
    if (/route|nameserver|\bdns\b|\bzone\b|network/.test(m)) return 'nb_network';
    if (/\bgroup\b/.test(m)) return 'nb_groups';
    if (/\bpeer\b/.test(m)) return 'nb_peers';
    if (/\buser\b|account|service account|invite|\blogin\b|\brole\b|block/.test(m)) return 'nb_users';
    return 'nb_other';
}

// Same priority-ordered patterns as netbirdSubcategory(), as Postgres POSIX regexes (\y = word
// boundary). Constant strings - no user input, safe to inline.
const NB_SUBCAT_PATTERNS = [
    ['nb_keys', 'setup ?key'],
    ['nb_policies', 'policy|\\yrule\\y|access control|posture'],
    ['nb_network', 'route|nameserver|\\ydns\\y|\\yzone\\y|network'],
    ['nb_groups', '\\ygroup\\y'],
    ['nb_peers', '\\ypeer\\y'],
    ['nb_users', '\\yuser\\y|account|service account|invite|\\ylogin\\y|\\yrole\\y|block'],
];
// SQL fragment selecting admin events whose message maps to `category`. Mirrors the JS heuristic's
// "first match wins": a category matches its own pattern AND none of the higher-priority ones.
function nbEventCategorySql(category) {
    const m = (p) => `message ~* '${p}'`;
    if (category === 'nb_other') return `NOT (${NB_SUBCAT_PATTERNS.map(([, p]) => m(p)).join(' OR ')})`;
    const idx = NB_SUBCAT_PATTERNS.findIndex(([k]) => k === category);
    if (idx < 0) return null;
    let cond = m(NB_SUBCAT_PATTERNS[idx][1]);
    const earlier = NB_SUBCAT_PATTERNS.slice(0, idx).map(([, p]) => m(p));
    if (earlier.length) cond += ` AND NOT (${earlier.join(' OR ')})`;
    return `(${cond})`;
}

// The Telegram transport helpers (sendTelegram, telegramApi, answerCallbackQuery,
// editTelegramMessage, editTelegramReplyMarkup, telegramSetWebhook, telegramDeleteWebhook) and
// TG_CAT_EMOJI now live in lib/telegram.js (imported at the top).

// Human, Title-Case labels so a message reads like a sentence instead of a code.
const TG_ACTION_LABELS = {
    'resource.create': 'Created a resource', 'resource.update': 'Updated a resource',
    'resource.delete': 'Deleted a resource', 'resource.bulk_delete': 'Deleted multiple resources',
    'resource.merge': 'Merged duplicate resources',
    'resource.move': 'Moved resources to another network',
    'router.create': 'Added a routing peer', 'router.delete': 'Removed a routing peer',
    'network.create': 'Created a network', 'network.update': 'Updated a network', 'network.delete': 'Deleted a network',
    'network.grants': 'Updated network access', 'network.default_profiles': 'Updated default access profiles',
    'policy.create': 'Created a policy', 'policy.update': 'Updated a policy', 'policy.delete': 'Deleted a policy',
    'policy.rename': 'Renamed policies (name template)',
    'proxy.create': 'Created a reverse-proxy service', 'proxy.expose': 'Exposed a Docker container via reverse proxy',
    'proxy.update': 'Updated a reverse-proxy service', 'proxy.delete': 'Deleted a reverse-proxy service',
    'group.create': 'Created a group',
    'group.rename': 'Renamed a group',
    'group.delete': 'Deleted a group', 'group.bulk_delete': 'Deleted multiple groups',
    'peer.delete': 'Deleted a peer', 'peer.bulk_delete': 'Deleted multiple peers',
    'peer.bypass_revoke': 'Removed a device bypass', 'peer.bypass_expire': 'Device bypass expired',
    'peer.bypass_auto': 'Automatic EDR bypass applied (OS rule)',
    'peer.temp_delete': 'Deleted a temporary device (bypass expired)',
    'retention.purge': 'Purged events past the retention window',
    'grant.cleanup': 'Cleaned up a crashed grant creation',
    'settings.export': 'Exported the settings backup', 'settings.import': 'Imported a settings backup',
    'peer.meta': 'Updated device tags/notes', 'peer.bulk_tags': 'Tagged multiple devices',
    'recert.open': 'Opened an access review round', 'recert.keep': 'Access review: kept an item',
    'recert.revoke': 'Access review: revoked an item', 'recert.complete': 'Completed an access review round',
    'recert.cancel': 'Cancelled an access review round',
    'profile.create': 'Created an access profile', 'profile.update': 'Updated an access profile', 'profile.delete': 'Deleted an access profile',
    'posture.create': 'Created a posture check', 'posture.update': 'Updated a posture check', 'posture.delete': 'Deleted a posture check',
    'template.create': 'Created a resource template', 'template.update': 'Updated a resource template', 'template.delete': 'Deleted a resource template',
    'filter.create': 'Added an event-filter rule', 'filter.update': 'Updated an event-filter rule', 'filter.delete': 'Deleted an event-filter rule',
    'filter.builtin_noise': 'Toggled the built-in noise filter', 'events.purge_matched': 'Purged events matching the filters',
    'blocklist.add': 'Added a blocklist entry', 'blocklist.update': 'Updated a blocklist entry', 'blocklist.delete': 'Deleted a blocklist entry',
    'blocklist.enforce': 'Enforced the blocklist on existing resources',
    'automation.create': 'Created an automation', 'automation.update': 'Updated an automation', 'automation.delete': 'Deleted an automation',
    'automation.run': 'Ran an automation', 'automation.repair': 'Repaired an automation', 'automation.forget': 'Reset an automation’s managed resources',
    'access.grant': 'Granted temporary access', 'access.revoke': 'Revoked temporary access', 'access.expire': 'Temporary access expired', 'access.extend': 'Extended temporary access',
    'recurring.create': 'Created a recurring access rule', 'recurring.update': 'Updated a recurring access rule', 'recurring.delete': 'Deleted a recurring access rule', 'recurring.expire': 'Recurring access rule ended',
    'request.create': 'Requested access', 'request.approve': 'Approved an access request', 'request.deny': 'Denied an access request', 'request.cancel': 'Cancelled an access request', 'request.expire': 'Access request expired',
    'settings.app_config': 'Updated general settings', 'settings.netbird_api': 'Updated the NetBird API connection',
    'settings.webhook': 'Updated webhook authentication', 'settings.telegram': 'Updated Telegram notifications',
    'settings.traffic_pull': 'Changed the Traffic Events API pull',
    'settings.approvers': 'Updated access-request approvers', 'settings.smtp': 'Updated email (SMTP) settings',
    'settings.permissions': 'Updated feature permissions', 'settings.security': 'Updated security settings',
    'settings.edr_auto_bypass': 'Updated automatic EDR bypass rules',
    'settings.auto_approval': 'Updated auto-approval rules',
    'settings.invite_defaults': 'Updated the default invitation groups',
    'user.invite': 'Invited a user', 'user.invite.resend': 'Re-sent a user invitation',
    'user.delete': 'Deleted a user',
    'peer.setupkey': 'Created an install setup key',
    'tenant.defaults': 'Applied default config to a tenant', 'webhook.nbsetup': 'Auto-configured NetBird notifications',
    'webhook.nbstream': 'Auto-configured NetBird event streaming',
};
function tgActionLabel(action) {
    if (TG_ACTION_LABELS[action]) return TG_ACTION_LABELS[action];
    const [noun, verb] = String(action || '').split('.');
    const V = { create: 'Created', update: 'Updated', delete: 'Deleted', bulk_delete: 'Deleted multiple' };
    const s = `${V[verb] || (verb || '').replace(/_/g, ' ')} ${noun || ''}`.trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : (action || 'Change');
}

// "appName" / "show_resource_groups" → "App name" / "Show resource groups".
function tgHumanizeKey(k) {
    return String(k).replace(/_/g, ' ').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}
// An opaque id-like key (id / resource_id / network_id / resourceId …) - noise in a notification.
function tgIsIdKey(k) { return /(^|[_\s])id$/i.test(k) || /[a-z]Id$/.test(k); }

// Resolve a NetBird initiator id → "Name (email)" via the cached users (same resolver the
// admin-events page uses), so notifications show who it is - not a raw oauth id.
async function tgResolveInitiator(initiatorId) {
    const id = String(initiatorId || '');
    if (!id) return '';
    if (id === 'sys') return 'System';
    const u = await resolveUser(id).catch(() => null);
    if (u && (u.display_name || u.email)) {
        return (u.display_name && u.email) ? `${u.display_name} (${u.email})` : (u.display_name || u.email);
    }
    if (!id.includes('|')) return 'Service account';
    return id.split('|').pop();
}

// Last-resort name lookup for ids the live caches can't resolve (typically a DELETED object):
// find the most recent stored NetBird event that referenced this id together with a name.
// The LIKE scan is unindexable, so results are cached: a deleted object's name never changes,
// so a HIT lives for the process lifetime; a MISS retries after 5 minutes (a later event may
// arrive carrying the name, e.g. the deletion event itself).
const _histNameCache = new Map(); // id → { name, at }
async function tgNameFromHistory(id) {
    const v = String(id || '');
    if (!v || v.length < 6) return '';
    // Cache key carries the account so a tenant's resolution never masks main's (or another tenant's).
    const ck = tnt() + '\x00' + v;
    const c = _histNameCache.get(ck);
    if (c && (c.name || Date.now() - c.at < 5 * 60_000)) return c.name;
    let name = '';
    try {
        const r = await pool.query(
            `SELECT meta->>'name' AS name FROM admin_events
             WHERE tenant = $2 AND COALESCE(meta->>'name', '') <> '' AND (target_id = $1 OR meta::text LIKE '%' || $1 || '%')
             ORDER BY timestamp DESC LIMIT 1`, [v, tnt()]);
        name = (r.rows[0] && r.rows[0].name) || '';
    } catch { /* treated as a miss */ }
    if (_histNameCache.size > 2000) _histNameCache.clear(); // crude size cap - cheap to rebuild
    _histNameCache.set(ck, { name, at: Date.now() });
    return name;
}

// Resolve an id of UNKNOWN kind (an event's target_id) by trying each cache in turn.
// Returns { label, name } so the notification can say "Policy: X" / "User: Y" precisely.
async function tgResolveAnyId(id) {
    const v = String(id || '');
    if (!v) return null;
    try {
        const gm = await getGroupRefMap().catch(() => ({}));
        if (gm[v] && gm[v].name) return { label: 'Group', name: gm[v].name };
        const ps = await getAllPeers().catch(() => []);
        const p = (ps || []).find(x => x && x.id === v);
        if (p) return { label: 'Device', name: p.name || p.hostname || v };
        const usage = await getUsageData().catch(() => null);
        const pol = usage && (usage.policies || []).find(x => x && x.id === v);
        if (pol) return { label: 'Policy', name: pol.name || v };
        const res = usage && (usage.resources || []).find(x => x && x.id === v);
        if (res) return { label: 'Resource', name: res.name || res.address || v };
        const net = usage && (usage.networks || []).find(x => x && x.id === v);
        if (net) return { label: 'Network', name: net.name || v };
        const u = await resolveUser(v).catch(() => null); // DB-only lookup, no API call
        if (u && (u.display_name || u.email)) return { label: 'User', name: u.display_name || u.email };
        const hist = await tgNameFromHistory(v);
        if (hist) return { label: 'Target', name: hist };
    } catch { /* unresolved */ }
    return null;
}

// Resolve a NetBird meta id (group_id / network_id / resource_id / peer_id / policy_id / user_id)
// to a human name via the warm caches, so a notification names the thing instead of a hash.
async function tgResolveIdName(key, id) {
    const v = String(id || '');
    if (!v) return '';
    try {
        if (/group/i.test(key)) { const m = await getGroupRefMap(); return (m[v] && m[v].name) || ''; }
        if (/network/i.test(key)) { const nets = await getNetworks(); const n = (nets || []).find(x => x.id === v); return (n && n.name) || ''; }
        if (/resource/i.test(key)) { const u = await getUsageData(); const r = (u.resources || []).find(x => x.id === v); return (r && (r.name || r.address)) || ''; }
        if (/peer/i.test(key)) { const ps = await getAllPeers(); const p = (ps || []).find(x => x.id === v); return (p && (p.name || p.hostname)) || ''; }
        if (/policy/i.test(key)) { const u = await getUsageData(); const p = (u.policies || []).find(x => x.id === v); return (p && p.name) || ''; }
        // Reverse-proxy (ingress) service ids: resolve via the cached cloud service list.
        if (/service|ingress/i.test(key)) { const st = await getReverseProxyStatus().catch(() => null); const s = st && (st.services || []).find(x => x.id === v); return (s && s.name) || ''; }
        if (/user|account/i.test(key)) { const usr = await resolveUser(v); return (usr && (usr.display_name || usr.email)) || ''; }
    } catch { /* fall through - the id will just be dropped */ }
    // Deleted objects fall off the live caches - recover the name from stored event history.
    return await tgNameFromHistory(v);
}

// Turn NetBird event meta into a human-friendly object: for each opaque `<x>_id` that has no
// `<x>_name` sibling, resolve the id to a name. tgFormatFields then drops the leftover raw ids.
async function tgEnrichNbMeta(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const out = { ...meta };
    for (const [k, v] of Object.entries(meta)) {
        if (!tgIsIdKey(k)) continue;
        const base = k.replace(/[_\s]?id$/i, '');           // group_id → group, id → ''
        const nameKey = base ? `${base}_name` : 'name';
        if (out[nameKey]) continue;                          // already carries a name
        const name = await tgResolveIdName(k, v);
        if (name) out[nameKey] = name;
    }
    return out;
}

// ─── Reverse-proxy ACCESS logs - ingested LOCALLY ───
// NetBird Cloud only keeps these 7 days (GET /api/events/proxy), so a scheduler copies new
// entries into proxy_access_logs and the app's own Data Retention governs how long they live.
// service/user names resolve at INGEST time, so history survives renames and deletions.
// Status is per-account (main '' and each tenant sync independently) - keyed by tnt().
const _proxyLogsSync = new Map(); // tnt() → { available, at, inserted, error }; absent = never ran
const proxyLogsStatus = () => _proxyLogsSync.get(tnt()) || { available: null, at: null, inserted: 0, error: null };

async function syncProxyAccessLogs() {
    if (!netbirdApiConfigured()) return;
    const status = await getReverseProxyStatus().catch(() => null);
    const svcName = new Map(((status && status.services) || []).map(s => [String(s.id), s.name]));
    // Resolve user names from the ACTIVE account's users mirror (tenant-scoped), so tenant
    // log rows carry the tenant's names - not the main account's.
    const users = await getAllUsers().catch(() => []);
    const userName = new Map((users || []).map(u => [String(u.id), u.name || u.email || '']));
    let inserted = 0;
    try {
        // Newest first; stop when a whole page is already stored (caught up) - first run
        // walks up to 50 pages (5,000 entries), which covers the Cloud's whole 7-day window.
        for (let page = 1; page <= 50; page++) {
            const raw = await netbirdGet(`/api/events/proxy?page=${page}&page_size=100&sort_by=timestamp&sort_order=descending`);
            const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data)) ? raw.data : null;
            if (!list) { _proxyLogsSync.set(tnt(), { available: false, at: new Date().toISOString(), inserted, error: null }); return; }
            let newOnPage = 0;
            for (const e of list) {
                if (!e || !e.id || !e.timestamp) continue;
                const uid = String(e.user_id || '');
                const r = await pool.query(
                    `INSERT INTO proxy_access_logs
                       (tenant, id, timestamp, service_id, service_name, protocol, method, host, path, duration_ms,
                        status_code, source_ip, reason, user_id, user_name, auth_method, country_code, city_name,
                        bytes_upload, bytes_download, metadata)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
                     ON CONFLICT (tenant, id) DO NOTHING`,
                    [
                        tnt(), String(e.id), e.timestamp, String(e.service_id || ''), svcName.get(String(e.service_id || '')) || '',
                        String(e.protocol || ''), String(e.method || ''), String(e.host || ''), String(e.path || ''),
                        Number(e.duration_ms) || 0, Number(e.status_code) || 0, String(e.source_ip || ''),
                        String(e.reason || ''), uid, uid ? (userName.get(uid) || '') : '',
                        String(e.auth_method_used || ''), String(e.country_code || ''), String(e.city_name || ''),
                        Number(e.bytes_upload) || 0, Number(e.bytes_download) || 0,
                        e.metadata && typeof e.metadata === 'object' ? JSON.stringify(e.metadata) : null,
                    ]
                );
                if (r.rowCount) { inserted++; newOnPage++; }
            }
            if (!newOnPage || list.length < 100) break;
        }
        _proxyLogsSync.set(tnt(), { available: true, at: new Date().toISOString(), inserted, error: null });
    } catch (e) {
        _proxyLogsSync.set(tnt(), { ...proxyLogsStatus(), at: new Date().toISOString(), error: e.message });
        throw e; // let the tracked() wrapper surface it on System Health
    }
}

// ─── Traffic Events API PULL (opt-in; the no-streaming alternative) ───
// NetBird's webhook event STREAMING needs the Business plan. Accounts below it can often still
// read the same flows through GET /api/events/network-traffic (cloud-only, experimental), so this
// scheduler polls that endpoint and feeds the results through the ORDINARY webhook ingest path -
// mapApiTrafficEvent + isNoiseTraffic + addEvent - landing rows in the same `events` table with
// the same semantics. Every Activity view, filter, retention rule and count therefore works on
// pulled data without knowing where it came from.
//
// DISABLED by default, per account (kill switch): a configured streaming webhook plus this pull
// would be two ingestion paths for the same flows, and only the operator knows which they run.
// Per-account like everything else here - the setting, the cursor and the status are keyed by tnt().
const trafficPullKey = () => tnt() ? `traffic_pull:${tnt()}` : 'traffic_pull';
const trafficCursorKey = () => tnt() ? `traffic_pull_last:${tnt()}` : 'traffic_pull_last';

const TRAFFIC_PULL_PAGE_SIZE = 100;
// Pathological-run guard. A normal 5-minute run sees a handful of pages; 50 pages (5,000 flows)
// means the account is far busier than the cadence assumes, so the run is capped and logged.
const TRAFFIC_PULL_MAX_PAGES = 50;
// Re-ask for 5 minutes we already have: flow windows CLOSE after their last packet, so an event
// can surface with a window_end slightly behind the cursor. Cheap - the ids dedup on insert.
const TRAFFIC_PULL_OVERLAP_MS = 5 * 60 * 1000;
// First run reaches back 48h - NetBird retains only ~48 hours / 50k traffic events, so that IS
// the whole available history. Everything older accumulates only from the moment this is enabled.
const TRAFFIC_PULL_FIRST_RUN_MS = 48 * 60 * 60 * 1000;
// A plan/permission refusal is a STANDING answer, not a blip - stop asking for an hour.
const TRAFFIC_UNSUPPORTED_TTL_MS = 60 * 60 * 1000;

const _trafficPull = new Map();        // tnt() → { at, count, error }; absent = never ran
const _trafficUnsupported = new Map(); // tnt() → epoch ms until which the API is known unavailable

async function getTrafficPullConfig() {
    try {
        const v = await getSetting(trafficPullKey());
        const o = v ? JSON.parse(v) : null;
        return { enabled: !!(o && o.enabled) };
    } catch { return { enabled: false }; }
}

async function setTrafficPullConfig({ enabled }) {
    await setSetting(trafficPullKey(), JSON.stringify({ enabled: enabled === true }));
    // Turning it on must not inherit a stale "unsupported" verdict from a previous account state
    // (e.g. the plan was upgraded) - the next run asks NetBird again.
    if (enabled === true) _trafficUnsupported.delete(tnt());
    return { enabled: enabled === true };
}

// Config + last-run facts for the CURRENT account, for the Settings card.
async function getTrafficPullStatus() {
    const { enabled } = await getTrafficPullConfig();
    const s = _trafficPull.get(tnt()) || null;
    return {
        enabled,
        lastRunAt: (s && s.at) || null,
        lastCount: (s && s.count) || 0,
        unsupported: (_trafficUnsupported.get(tnt()) || 0) > Date.now(),
        lastError: (s && s.error) || null,
    };
}

// The account's plan/permissions do not expose the endpoint. Record it, stay quiet for an hour.
function noteTrafficUnsupported(inserted) {
    _trafficUnsupported.set(tnt(), Date.now() + TRAFFIC_UNSUPPORTED_TTL_MS);
    _trafficPull.set(tnt(), { at: new Date().toISOString(), count: inserted, error: null });
}

async function syncTrafficEvents() {
    if (!netbirdApiConfigured()) return;
    if (!(await getTrafficPullConfig()).enabled) return;
    if ((_trafficUnsupported.get(tnt()) || 0) > Date.now()) return; // known unavailable - skip quietly

    const cursor = (await getSetting(trafficCursorKey()).catch(() => '')) || '';
    const cursorMs = cursor ? Date.parse(cursor) : NaN;
    const startMs = Number.isFinite(cursorMs)
        ? cursorMs - TRAFFIC_PULL_OVERLAP_MS
        : Date.now() - TRAFFIC_PULL_FIRST_RUN_MS;
    const startDate = new Date(startMs).toISOString();

    let inserted = 0, newest = cursor, capped = false;
    try {
        for (let page = 1; page <= TRAFFIC_PULL_MAX_PAGES; page++) {
            // netbirdReq (not netbirdGet) because the STATUS is the signal here: netbirdGet
            // swallows it and returns the parsed error body, which cannot be told apart from a
            // real payload. GET is never blocked by the read-only guard.
            const r = await netbirdReq('GET', `/api/events/network-traffic?page=${page}&page_size=${TRAFFIC_PULL_PAGE_SIZE}&start_date=${encodeURIComponent(startDate)}`);
            // 402 payment required / 403 forbidden / 404 not found / 501 not implemented - every
            // shape a lower plan or a self-hosted deployment answers with.
            if ([402, 403, 404, 501].includes(r.status)) { noteTrafficUnsupported(inserted); return; }
            if (r.status < 200 || r.status >= 300) throw new Error(`NetBird traffic events HTTP ${r.status || 'request failed'}`);
            const body = r.body;
            const list = Array.isArray(body) ? body : (body && Array.isArray(body.data)) ? body.data : null;
            if (!list) { noteTrafficUnsupported(inserted); return; } // 200 but not the documented envelope

            for (const e of list) {
                const payload = mapApiTrafficEvent(e);
                if (!payload) continue;
                // Same noise + user rules the webhook path applies, so both ingestion paths
                // store exactly the same subset of traffic.
                if (await isNoiseTraffic(payload)) continue;
                const res = await addEvent(payload); // (tenant,id) ON CONFLICT DO NOTHING = dedup
                if (res.rowCount) inserted++;
                const w = String(e.window_end || e.window_start || payload.Timestamp || '');
                if (w && (!newest || Date.parse(w) > Date.parse(newest))) newest = w;
            }

            const totalPages = Number(body && body.total_pages) || 0;
            if (list.length < TRAFFIC_PULL_PAGE_SIZE) break;
            if (totalPages && page >= totalPages) break;
            if (page === TRAFFIC_PULL_MAX_PAGES) capped = true;
        }
        if (capped) {
            console.warn(`[TrafficPull] ${tnt() || 'main'}: hit the ${TRAFFIC_PULL_MAX_PAGES}-page cap - the rest of this window is picked up by the next run`);
        }
        // The cursor advances ONLY here, after a run that neither threw nor bailed out - a failed
        // page leaves it untouched, so the next run re-reads the same window (dedup makes that
        // free). It advances even on a capped run: NetBird does not promise a page ORDER, so
        // freezing the cursor could otherwise stall an oldest-first backlog forever.
        if (newest && newest !== cursor) await setSetting(trafficCursorKey(), newest);
        _trafficPull.set(tnt(), { at: new Date().toISOString(), count: inserted, error: null });
    } catch (e) {
        _trafficPull.set(tnt(), { at: new Date().toISOString(), count: inserted, error: e.message });
        throw e; // let the tracked() wrapper surface it on System Health
    }
}

// ─── Audit Events API PULL (opt-in; the no-streaming alternative for ADMIN events) ───
// The exact sibling of the Traffic pull above, for NetBird's ADMIN/AUDIT events. Streaming needs
// the Business plan; accounts below it can still read the same management activity through
// GET /api/events/audit, so this scheduler polls that endpoint and feeds each row through the
// ORDINARY admin ingest path - mapApiAuditEvent + addAdminEvent - landing rows in the same
// `admin_events` table with the same semantics. Every Audit Logs view, filter, category rule and
// retention rule therefore works on pulled data without knowing where it came from.
//
// DISABLED by default, per account (kill switch): a configured Account Notifications / streaming
// webhook plus this pull would be two ingestion paths for the same events, and only the operator
// knows which they run. The setting, the silent-seed flag and the status are keyed by tnt().
const auditPullKey = () => tnt() ? `audit_pull:${tnt()}` : 'audit_pull';
// Set once, after the first run: that run BACKFILLS existing history silently (no Telegram), so
// every subsequent run knows it may notify on genuinely-new events. Production-safe seeding.
const auditSeededKey = () => tnt() ? `audit_pull_seeded:${tnt()}` : 'audit_pull_seeded';

const AUDIT_PULL_PAGE_SIZE = 100;
// Pathological-run guard. A normal 5-minute run sees a handful of pages; 50 pages (5,000 events)
// means the account is far busier than the cadence assumes, so the run is capped and logged.
const AUDIT_PULL_MAX_PAGES = 50;
// A plan/permission refusal is a STANDING answer, not a blip - stop asking for an hour.
const AUDIT_UNSUPPORTED_TTL_MS = 60 * 60 * 1000;

const _auditPull = new Map();        // tnt() → { at, count, error }; absent = never ran
const _auditUnsupported = new Map(); // tnt() → epoch ms until which the API is known unavailable

async function getAuditPullConfig() {
    try {
        const v = await getSetting(auditPullKey());
        const o = v ? JSON.parse(v) : null;
        return { enabled: !!(o && o.enabled) };
    } catch { return { enabled: false }; }
}

async function setAuditPullConfig({ enabled }) {
    await setSetting(auditPullKey(), JSON.stringify({ enabled: enabled === true }));
    // Turning it on must not inherit a stale "unsupported" verdict from a previous account state
    // (e.g. the plan was upgraded) - the next run asks NetBird again.
    if (enabled === true) _auditUnsupported.delete(tnt());
    return { enabled: enabled === true };
}

// Config + last-run facts for the CURRENT account, for the Settings card.
async function getAuditPullStatus() {
    const { enabled } = await getAuditPullConfig();
    const s = _auditPull.get(tnt()) || null;
    return {
        enabled,
        lastRunAt: (s && s.at) || null,
        lastCount: (s && s.count) || 0,
        unsupported: (_auditUnsupported.get(tnt()) || 0) > Date.now(),
        lastError: (s && s.error) || null,
    };
}

// The account's plan/permissions do not expose the endpoint. Record it, stay quiet for an hour.
function noteAuditUnsupported(inserted) {
    _auditUnsupported.set(tnt(), Date.now() + AUDIT_UNSUPPORTED_TTL_MS);
    _auditPull.set(tnt(), { at: new Date().toISOString(), count: inserted, error: null });
}

// Shape the GET /api/events/audit row into the payload addAdminEvent expects. `Message` MUST carry
// the human activity text - Audit Logs category filtering matches on the stored `message` column.
function mapApiAuditEvent(e) {
    if (!e || e.id === undefined || e.id === null) return null;
    return {
        ID: e.id,
        Timestamp: e.timestamp,
        Message: e.activity || e.activity_code || '',
        InitiatorID: e.initiator_id || '',
        target_id: e.target_id || '',
        meta: (e.meta && typeof e.meta === 'object') ? e.meta : {},
        reference: `https://app.netbird.io/activity?id=${e.id}`,
        activity_code: e.activity_code || '',
        initiator_name: e.initiator_name || '',
        initiator_email: e.initiator_email || '',
    };
}

async function syncAuditEvents() {
    if (!netbirdApiConfigured()) return;
    if (!(await getAuditPullConfig()).enabled) return;
    if ((_auditUnsupported.get(tnt()) || 0) > Date.now()) return; // known unavailable - skip quietly

    // First run = silent backfill (a whole history arriving at once must not spam Telegram); every
    // run after the seed flag is set notifies on genuinely-new events like the webhook path does.
    const seeded = !!(await getSetting(auditSeededKey()).catch(() => ''));
    const notify = seeded;

    let inserted = 0, capped = false;
    try {
        // Newest first; walk pages until a whole page brings nothing new (caught up). See the stop
        // conditions after the loop for the bare-array and total_pages cases.
        for (let page = 1; page <= AUDIT_PULL_MAX_PAGES; page++) {
            // netbirdReq (not netbirdGet) because the STATUS is the signal here: netbirdGet
            // swallows it and returns the parsed error body, which cannot be told apart from a
            // real payload. GET is never blocked by the read-only guard.
            const r = await netbirdReq('GET', `/api/events/audit?page=${page}&page_size=${AUDIT_PULL_PAGE_SIZE}&sort_by=timestamp&sort_order=descending`);
            // 402 payment required / 403 forbidden / 404 not found / 501 not implemented - every
            // shape a lower plan or a self-hosted deployment answers with.
            if ([402, 403, 404, 501].includes(r.status)) { noteAuditUnsupported(inserted); return; }
            if (r.status < 200 || r.status >= 300) throw new Error(`NetBird audit events HTTP ${r.status || 'request failed'}`);
            const body = r.body;
            // The endpoint answers either a bare array (whole set, unpaginated) or the documented
            // { data, total_pages } envelope - handle both, and tell them apart for the stop logic.
            const isEnvelope = body && !Array.isArray(body) && Array.isArray(body.data);
            const list = Array.isArray(body) ? body : (isEnvelope ? body.data : null);
            if (!list) { noteAuditUnsupported(inserted); return; } // 200 but neither shape

            let newOnPage = 0;
            for (const e of list) {
                const payload = mapApiAuditEvent(e);
                if (!payload) continue;
                const res = await addAdminEvent(payload, { notify }); // (tenant,id) ON CONFLICT DO NOTHING = dedup
                if (res.rowCount) { inserted++; newOnPage++; }
            }

            // A bare array is the FULL set returned unpaginated - never ask for page 2, or we would
            // re-fetch the same array forever.
            if (!isEnvelope) break;
            if (list.length < AUDIT_PULL_PAGE_SIZE) break;
            // Caught up - but only trust "no new rows" once seeded, since a backfill legitimately
            // inserts every row on its first pages and would otherwise stop after page 1.
            if (seeded && newOnPage === 0) break;
            if (body.total_pages && page >= Number(body.total_pages)) break;
            if (page === AUDIT_PULL_MAX_PAGES) capped = true;
        }
        // Mark seeded AFTER a clean run, so a run that threw mid-backfill retries silently instead
        // of switching to notify mode with a half-loaded history.
        if (!seeded) await setSetting(auditSeededKey(), '1');
        if (capped) {
            console.warn(`[AuditPull] ${tnt() || 'main'}: hit the ${AUDIT_PULL_MAX_PAGES}-page cap - the rest is picked up by the next run`);
        }
        _auditPull.set(tnt(), { at: new Date().toISOString(), count: inserted, error: null });
    } catch (e) {
        _auditPull.set(tnt(), { at: new Date().toISOString(), count: inserted, error: e.message });
        throw e; // let the tracked() wrapper surface it on System Health
    }
}

// ─── Reverse-proxy service creation (the app-side "Add Service" + Docker wizard) ───
const PROXY_TARGET_TYPES = ['peer', 'host', 'domain', 'subnet', 'cluster'];
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Domain bases for new services: FREE domains (connected proxy clusters) + validated CUSTOM
// domains. Each carries its target cluster - the official dashboard derives the service's
// proxy_cluster from the chosen domain, never as a separate field.
async function getProxyDomains() {
    const raw = await netbirdGet('/api/reverse-proxies/domains');
    return (Array.isArray(raw) ? raw : [])
        .map(d => d && ({
            id: d.id || '',
            domain: d.domain || '',
            type: d.type === 'custom' ? 'custom' : 'free',
            validated: d.validated !== false,
            cluster: d.target_cluster || '',
            requireSubdomain: !!d.require_subdomain,
        }))
        .filter(d => d && d.domain);
}

// Normalize ONE target from the UI into NetBird's shape. Shared by create + update.
function buildProxyTarget(t) {
    const type = PROXY_TARGET_TYPES.includes(t.target_type || t.type) ? (t.target_type || t.type) : null;
    if (!type) throw new Error('a target type is required');
    const port = parseInt(t.port, 10);
    if (!(port >= 1 && port <= 65535)) throw new Error('a valid target port (1-65535) is required');
    const protocol = ['http', 'https', 'tcp', 'udp'].includes(t.protocol) ? t.protocol : 'http';
    const out = { target_type: type, protocol, port, enabled: t.enabled !== false };
    const options = {};
    if (type === 'cluster') {
        const host = String(t.host || '').trim();
        if (!host) throw new Error('a target host is required for a direct target');
        out.host = host;
        // The API requires target_id even for cluster targets - it's the cluster's apex domain.
        const cid = String(t.id || t.target_id || '').trim();
        if (!cid) throw new Error('a proxy cluster is required for a direct target');
        out.target_id = cid;
        options.direct_upstream = true; // cluster targets dial via the proxy host's stack
    } else {
        const tid = String(t.id || t.target_id || '').trim();
        if (!tid) throw new Error('a target peer/resource is required');
        out.target_id = tid;
    }
    if (t.skipTlsVerify) options.skip_tls_verify = true;
    const path = String(t.path || '').trim();
    if (path && path !== '/') out.path = path.startsWith('/') ? path : `/${path}`;
    // Official "Preserve Full Path": keep the original request path when forwarding
    // (default strips the matched prefix). Only meaningful when a location path is set.
    if (t.preservePath && out.path) options.path_rewrite = 'preserve';
    if (Object.keys(options).length) out.options = options;
    // NetBird v0.81+ per-path access (inherit | bypass | block). Sent only when the caller states it,
    // so a payload without it is unchanged for older clusters; mergeProxyTargets carries a stored
    // value onto a target the caller left unstated.
    if (t.accessAction !== undefined) {
        if (!PROXY_ACCESS_ACTIONS.includes(t.accessAction)) throw new Error('invalid target access action');
        out.access_action = t.accessAction;
    }
    return out;
}
const PROXY_ACCESS_ACTIONS = ['inherit', 'bypass', 'block'];
// NetBird's own rules for per-target access actions, checked BEFORE any write: they apply to HTTP
// services only, and a NetBird-Only (private) service can't bypass its peer-group check - Block
// stays allowed there. Returns an error message, or '' when the combination is valid.
function proxyAccessActionError(service) {
    const targets = Array.isArray(service && service.targets) ? service.targets : [];
    const acted = targets.filter(t => t && t.access_action && t.access_action !== 'inherit');
    if (!acted.length) return '';
    if ((service.mode || 'http') !== 'http') return 'Per-path access (Bypass / Block) is only available for HTTP services.';
    if (service.private && acted.some(t => t.access_action === 'bypass')) {
        return "Bypass Authentication isn't available on a NetBird-Only service. Set the target back to Use Service Authentication (Block Access is allowed).";
    }
    return '';
}

// A 'container' pseudo-target points at a Docker container by DNS name - no NetBird object
// exists for it yet. Create the domain resource in the given network first (same as Expose
// Docker Container), then rewrite it into a normal 'domain' target. If a resource with that
// exact address already exists in the network it is REUSED, never duplicated. Returns the
// created resources so a failing service create/update can roll them back.
async function materializeContainerTargets(rawTargets) {
    const targets = [];
    const created = []; // [{ networkId, resourceId }]
    for (const t of (rawTargets || [])) {
        const type = t && (t.type || t.target_type);
        if (type !== 'container') { targets.push(t); continue; }
        const networkId = String(t.networkId || '').trim();
        if (!networkId) throw new Error('a network is required for a container target');
        const address = String(t.containerDomain || t.host || '').trim().toLowerCase();
        if (!DOMAIN_RE.test(address)) throw new Error('the container address must be a domain name (e.g. app.internal)');
        const blocked = addressBlockedForNetwork(address, networkId, await getBlocklist());
        if (blocked) throw new Error(`Address "${address}" is blocked for this network (matches "${blocked}" on the blocklist).`);
        // Reuse an existing resource with this exact address in this network.
        let resourceId = null;
        const usage = await getUsageData().catch(() => null);
        const netRes = usage && (usage.networks || []).find(n => n && n.id === networkId);
        if (netRes && Array.isArray(netRes.resources)) {
            const inNet = new Set(netRes.resources);
            const match = (usage.resources || []).find(r => r && inNet.has(r.id) && String(r.address || '').toLowerCase() === address);
            if (match) resourceId = match.id;
        }
        if (!resourceId) {
            const { resource } = await createClientResource(networkId, {
                name: address, address, description: 'Created by reverse-proxy container target', groups: [], policies: [],
            });
            resourceId = (resource && resource.id) || null;
            if (!resourceId) throw new Error('resource creation returned no id');
            created.push({ networkId, resourceId });
        }
        targets.push({ ...t, type: 'domain', target_type: 'domain', id: resourceId, target_id: resourceId });
    }
    return { targets, created };
}
async function rollbackContainerResources(created) {
    for (const c of (created || [])) await deleteResource(c.networkId, c.resourceId).catch(() => { });
}

// Create one HTTPS reverse-proxy service. Targets: peer/resource (NetBird resolves the host
// from target_id) or 'cluster' = direct upstream (the proxy dials the given host via its own
// network stack - useful when the self-hosted proxy shares a Docker network with the target).
async function createProxyService(cfg = {}) {
    const domain = String(cfg.domain || '').trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) throw new Error('a valid service domain is required (e.g. app.example.com)');
    const cluster = String(cfg.cluster || cfg.proxy_cluster || '').trim();
    if (!cluster) throw new Error('a proxy cluster is required');
    const rawTargets = Array.isArray(cfg.targets) && cfg.targets.length ? cfg.targets : (cfg.target ? [cfg.target] : []);
    if (!rawTargets.length) throw new Error('at least one target is required');
    const { targets: matTargets, created } = await materializeContainerTargets(rawTargets);
    try {
        const body = {
            name: String(cfg.name || '').trim() || domain,
            domain,
            mode: 'http',
            proxy_cluster: cluster,
            enabled: cfg.enabled !== false,
            targets: matTargets.map(buildProxyTarget),
        };
        if (cfg.passHostHeader !== undefined) body.pass_host_header = !!cfg.passHostHeader;
        if (cfg.rewriteRedirects !== undefined) body.rewrite_redirects = !!cfg.rewriteRedirects;
        const resp = await netbirdPost('/api/reverse-proxies/services', body);
        if (!resp || resp.status >= 300 || !resp.body || !resp.body.id) {
            throw new Error('Failed to create service: ' + (resp && (resp.raw || resp.error || resp.status)));
        }
        bustReverseProxyCache();
        return { id: resp.body.id, domain, name: body.name };
    } catch (e) {
        await rollbackContainerResources(created);
        throw e;
    }
}

// Flat peers+resources inventory for the unified target selector (official-dashboard style).
async function getProxyTargetOptions() {
    const usage = await getUsageData().catch(() => ({ resources: [], networks: [] }));
    const netName = new Map();
    for (const n of (usage.networks || [])) netName.set(n.id, n.name || n.id);
    const resOfNet = new Map();
    for (const n of (usage.networks || [])) for (const rid of (Array.isArray(n.resources) ? n.resources : [])) resOfNet.set(rid, n.id);
    const peers = (await getAllPeers().catch(() => [])).map(p => ({
        id: p.id, name: p.name || p.hostname || p.id, ip: p.ip || '', dns: p.dns_label || '', os: p.os || '',
    }));
    const resources = (usage.resources || []).map(r => ({
        id: r.id, name: r.name || r.address || r.id, address: r.address || '',
        type: (r.type || '').toLowerCase(),
        network: netName.get(resOfNet.get(r.id)) || '',
    }));
    return { peers, resources };
}

// One service, raw from NetBird (server-side only - may contain auth secrets).
async function getProxyServiceRaw(id) {
    const raw = await netbirdGet('/api/reverse-proxies/services/' + encodeURIComponent(id));
    if (!raw || !raw.id) throw new Error('service not found');
    return raw;
}

// The browser-safe view of a service for the Edit modal. Secrets (password/PIN values,
// header values) are NEVER returned - only whether they are set.
function sanitizeProxyService(raw) {
    const auth = raw.auth || {};
    const ar = raw.access_restrictions || {};
    return {
        id: raw.id, name: raw.name || '', domain: raw.domain || '', mode: raw.mode || 'http',
        cluster: raw.proxy_cluster || '', enabled: raw.enabled !== false, listenPort: raw.listen_port || 0,
        private: !!raw.private,
        accessGroups: Array.isArray(raw.access_groups) ? raw.access_groups : [],
        passHostHeader: !!raw.pass_host_header,
        rewriteRedirects: !!raw.rewrite_redirects,
        targets: (Array.isArray(raw.targets) ? raw.targets : []).map(t => t && ({
            target_type: t.target_type || 'host', target_id: t.target_id || '', host: t.host || '',
            port: t.port || 0, protocol: t.protocol || 'http', path: t.path || '',
            enabled: t.enabled !== false, direct: !!(t.options && t.options.direct_upstream),
            skipTlsVerify: !!(t.options && t.options.skip_tls_verify),
            preservePath: !!(t.options && t.options.path_rewrite === 'preserve'),
            ...(t.access_action ? { accessAction: t.access_action } : {}),
        })).filter(Boolean),
        auth: {
            password: { enabled: !!(auth.password_auth && auth.password_auth.enabled), set: !!(auth.password_auth && auth.password_auth.password) },
            pin: { enabled: !!(auth.pin_auth && auth.pin_auth.enabled), set: !!(auth.pin_auth && auth.pin_auth.pin) },
            sso: { enabled: !!(auth.bearer_auth && auth.bearer_auth.enabled), groups: (auth.bearer_auth && auth.bearer_auth.distribution_groups) || [] },
            link: { enabled: !!(auth.link_auth && auth.link_auth.enabled) },
            headers: (Array.isArray(auth.header_auths) ? auth.header_auths : []).filter(Boolean).map(h => ({ enabled: h.enabled !== false, header: h.header || '' })),
        },
        access: {
            allowedCidrs: Array.isArray(ar.allowed_cidrs) ? ar.allowed_cidrs : [],
            blockedCidrs: Array.isArray(ar.blocked_cidrs) ? ar.blocked_cidrs : [],
            allowedCountries: Array.isArray(ar.allowed_countries) ? ar.allowed_countries : [],
            blockedCountries: Array.isArray(ar.blocked_countries) ? ar.blocked_countries : [],
            crowdsec: ar.crowdsec_mode || 'off',
        },
    };
}

// Partial update: GET the full service, merge the patch, PUT it back. Password/PIN values
// are only replaced when a NEW value arrives - otherwise the existing one is kept
// server-side and never travels to the browser.
async function updateProxyService(id, patch = {}) {
    const raw = await getProxyServiceRaw(id);
    const body = { ...raw };
    if (patch.name !== undefined) body.name = String(patch.name).trim() || raw.name;
    if (patch.enabled !== undefined) body.enabled = !!patch.enabled;
    let createdContainerRes = [];
    if (patch.targets !== undefined) {
        if (!Array.isArray(patch.targets) || !patch.targets.length) throw new Error('at least one target is required');
        const { targets: matTargets, created } = await materializeContainerTargets(patch.targets);
        createdContainerRes = created;
        // Keep fields the app doesn't model on targets that already existed. Refuses (409) an
        // ambiguous edit - then a resource just created for a container target must not outlive it.
        try { body.targets = mergeProxyTargets(raw.targets, matTargets.map(buildProxyTarget)); }
        catch (e) { await rollbackContainerResources(createdContainerRes); throw e; }
    }
    if (patch.passHostHeader !== undefined) body.pass_host_header = !!patch.passHostHeader;
    if (patch.rewriteRedirects !== undefined) body.rewrite_redirects = !!patch.rewriteRedirects;
    if (patch.private !== undefined) body.private = !!patch.private;
    if (patch.accessGroups !== undefined) body.access_groups = Array.isArray(patch.accessGroups) ? patch.accessGroups.filter(Boolean) : [];
    if (patch.auth) {
        const a = { ...(raw.auth || {}) };
        const pa = patch.auth;
        if (pa.password) {
            const existing = (raw.auth && raw.auth.password_auth) || {};
            const value = pa.password.value ? String(pa.password.value) : (existing.password || '');
            if (pa.password.enabled && !value) throw new Error('a password is required to enable password auth');
            a.password_auth = { enabled: !!pa.password.enabled, password: value };
        }
        if (pa.pin) {
            const existing = (raw.auth && raw.auth.pin_auth) || {};
            const value = pa.pin.value ? String(pa.pin.value) : (existing.pin || '');
            if (pa.pin.enabled && !value) throw new Error('a PIN is required to enable PIN auth');
            a.pin_auth = { enabled: !!pa.pin.enabled, pin: value };
        }
        if (pa.sso) a.bearer_auth = { enabled: !!pa.sso.enabled, distribution_groups: Array.isArray(pa.sso.groups) ? pa.sso.groups.filter(Boolean) : [] };
        if (pa.link) a.link_auth = { enabled: !!pa.link.enabled };
        if (pa.headers !== undefined) {
            if (!Array.isArray(pa.headers)) throw new Error('headers must be a list');
            const existing = (raw.auth && Array.isArray(raw.auth.header_auths)) ? raw.auth.header_auths.filter(Boolean) : [];
            const used = new Set();
            a.header_auths = pa.headers.map(h => {
                const header = String((h && h.header) || '').trim();
                if (!header) throw new Error('a header name is required');
                let value = h && h.value ? String(h.value) : '';
                if (!value) {
                    // Blank value = keep the existing secret for this header (matched by name, in order).
                    const idx = existing.findIndex((e, i) => !used.has(i) && (e.header || '') === header);
                    if (idx === -1) throw new Error(`a value is required for header "${header}"`);
                    used.add(idx);
                    value = existing[idx].value || '';
                }
                return { enabled: !h || h.enabled !== false, header, value };
            });
        }
        body.auth = a;
    }
    if (patch.access) {
        const ar = { ...(raw.access_restrictions || {}) };
        const list = v => (Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : []);
        if (patch.access.allowedCidrs !== undefined) ar.allowed_cidrs = list(patch.access.allowedCidrs);
        if (patch.access.blockedCidrs !== undefined) ar.blocked_cidrs = list(patch.access.blockedCidrs);
        if (patch.access.allowedCountries !== undefined) ar.allowed_countries = list(patch.access.allowedCountries).map(c => c.toUpperCase());
        if (patch.access.blockedCountries !== undefined) ar.blocked_countries = list(patch.access.blockedCountries).map(c => c.toUpperCase());
        if (patch.access.crowdsec !== undefined) ar.crowdsec_mode = ['off', 'observe', 'enforce'].includes(patch.access.crowdsec) ? patch.access.crowdsec : 'off';
        body.access_restrictions = ar;
    }
    const accessErr = proxyAccessActionError(body);
    if (accessErr) {
        await rollbackContainerResources(createdContainerRes);
        const e = new Error(accessErr); e.status = 400; throw e;
    }
    const resp = await netbirdReq('PUT', '/api/reverse-proxies/services/' + encodeURIComponent(id), body);
    if (!resp || resp.status >= 300) {
        // A resource created for a NEW container target must not outlive a failed update.
        await rollbackContainerResources(createdContainerRes);
        throw new Error('Failed to update service: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    bustReverseProxyCache();
    // Enable/disable follows through to the resources the service targets.
    let syncedResources = [];
    if (patch.enabled !== undefined && !!patch.enabled !== (raw.enabled !== false)) {
        syncedResources = await syncLinkedProxyResources({ id, targets: body.targets }, patch.enabled ? 'enable' : 'disable');
    }
    return { id, syncedResources };
}

// A service's resource-targets (host/domain/subnet ids) - peers and direct/cluster targets excluded.
function proxyResourceTargetIds(svc) {
    return [...new Set((Array.isArray(svc && svc.targets) ? svc.targets : [])
        .filter(t => t && ['host', 'domain', 'subnet'].includes(t.target_type) && t.target_id)
        .map(t => t.target_id))];
}

// Keep linked network resources in step with their service: deleting a service deletes the
// resources it targeted, disabling/enabling a service disables/enables them. A resource still
// referenced by ANOTHER service (any for delete, an enabled one for disable) is left alone.
async function syncLinkedProxyResources(svc, mode) {
    const ids = proxyResourceTargetIds(svc);
    if (!ids.length) return [];
    const services = await netbirdGet('/api/reverse-proxies/services').catch(() => null);
    const usedElsewhere = (rid) => Array.isArray(services) && services.some(s => s && s.id !== svc.id &&
        (mode !== 'disable' || s.enabled !== false) &&
        (Array.isArray(s.targets) ? s.targets : []).some(t => t && t.target_id === rid));
    const nets = await netbirdGet('/api/networks').catch(() => null);
    const netOf = new Map();
    for (const n of (Array.isArray(nets) ? nets : [])) {
        for (const rid of (Array.isArray(n.resources) ? n.resources : [])) netOf.set(rid, n.id);
    }
    const done = [];
    for (const rid of ids) {
        const networkId = netOf.get(rid);
        if (!networkId) continue; // already gone / not a network resource
        try {
            if (mode !== 'enable' && usedElsewhere(rid)) continue;
            if (mode === 'delete') {
                let name = rid;
                try { name = ((await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(rid)}`)) || {}).name || rid; } catch { /* keep id */ }
                await deleteResource(networkId, rid);
                done.push(name);
            } else {
                const r = await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(rid)}`);
                if (!r || !r.id) continue;
                const enabled = mode === 'enable';
                if ((r.enabled !== false) === enabled) continue; // already in the right state
                const resp = await netbirdReq('PUT', `/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(rid)}`, {
                    name: r.name, address: r.address, description: r.description || '', enabled,
                    groups: (Array.isArray(r.groups) ? r.groups : []).map(g => (g && g.id) || g).filter(Boolean),
                });
                if (!resp || resp.status >= 300) throw new Error((resp && (resp.raw || resp.error || resp.status)) || 'update failed');
                done.push(r.name || rid);
            }
        } catch (e) { console.error('[proxy] linked resource sync failed:', mode, rid, e.message); }
    }
    if (done.length) bustNbCaches('policies', 'gref', 'usage');
    return done;
}

async function deleteProxyService(id) {
    // Snapshot the service BEFORE deletion - afterwards its targets are gone.
    let svc = null;
    try { svc = await getProxyServiceRaw(id); } catch { /* service may already be gone */ }
    const resp = await netbirdReq('DELETE', '/api/reverse-proxies/services/' + encodeURIComponent(id));
    if (!resp || (resp.status >= 300 && resp.status !== 404)) {
        throw new Error('Failed to delete service: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    bustReverseProxyCache();
    const cleanedResources = svc ? await syncLinkedProxyResources(svc, 'delete') : [];
    return { ok: true, cleanedResources };
}

// The proven Docker recipe, automated WITH ROLLBACK: [attach routing peer] → create a
// DOMAIN resource (the container's DNS name, resolved by the routing peer on the Docker
// host) → create a service targeting that resource. Any step failing tears down whatever
// this call already created - nothing half-configured is left behind.
async function exposeDockerService(cfg = {}) {
    const networkId = String(cfg.networkId || '').trim();
    if (!networkId) throw new Error('a network is required');
    const address = String(cfg.containerDomain || '').trim().toLowerCase();
    if (!DOMAIN_RE.test(address)) throw new Error('the container address must be a domain name (e.g. app.internal)');
    const blocked = addressBlockedForNetwork(address, networkId, await getBlocklist());
    if (blocked) throw new Error(`Address "${address}" is blocked for this network (matches "${blocked}" on the blocklist).`);

    let routerId = null;
    let resourceId = null;
    try {
        if (cfg.routerPeerId) {
            const router = await createNetworkRouter(networkId, { peer: String(cfg.routerPeerId), masquerade: true, enabled: true });
            routerId = (router && router.id) || null;
        }
        const { resource } = await createClientResource(networkId, {
            name: String(cfg.resourceName || '').trim() || address,
            address, description: 'Created by Expose Docker Container', groups: [], policies: [],
        });
        resourceId = (resource && resource.id) || null;
        if (!resourceId) throw new Error('resource creation returned no id');
        const service = await createProxyService({
            name: cfg.serviceName, domain: cfg.serviceDomain, cluster: cfg.cluster, enabled: true,
            target: { type: 'domain', id: resourceId, port: cfg.port, protocol: cfg.protocol || 'http', path: cfg.path, preservePath: cfg.preservePath },
            passHostHeader: cfg.passHostHeader, rewriteRedirects: cfg.rewriteRedirects,
        });
        return { service, resourceId, routerId };
    } catch (e) {
        if (resourceId) await deleteResource(networkId, resourceId).catch(() => { });
        if (routerId) await deleteNetworkRouter(networkId, routerId).catch(() => { });
        throw e;
    }
}

// ─── MSP tenants (NetBird Cloud Managed Service Provider portal) ───
// Same endpoints the official dashboard's Tenants section uses. Tenant CRUD is always a
// MAIN-account operation; per-tenant usage/subscription pass the tenant id explicitly as
// ?account= (exactly like upstream). Availability itself comes from getMspStatus().
async function listMspTenants({ withUsage = true } = {}) {
    const raw = await netbirdGet('/api/integrations/msp/tenants');
    const tenants = (Array.isArray(raw) ? raw : []).filter(t => t && t.id).map(t => ({
        id: t.id,
        name: t.name || '',
        domain: t.domain || '',
        status: t.status || '',
        activatedAt: t.activated_at || '',
        createdAt: t.created_at || '',
        groups: Array.isArray(t.groups) ? t.groups.map(g => ({ id: (g && g.id) || '', role: (g && g.role) || '', name: (g && g.name) || '' })).filter(g => g.id) : [],
        usage: null,
        plan: null,
        hasApiToken: hasTenantToken(t.id),
        serviceUser: null,
    }));
    // Managed service-user metadata (name / last rotation / token expiry) for the UI.
    const su = await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'msp_tenant_su:%'`).catch(() => ({ rows: [] }));
    const suBy = new Map(su.rows.map(row => [row.key.slice('msp_tenant_su:'.length), row.value]));
    for (const t of tenants) {
        const raw = suBy.get(t.id);
        if (!raw) continue;
        try {
            const m = JSON.parse(raw);
            t.serviceUser = { name: m.name || '', rotatedAt: m.rotatedAt || '', expiresAt: m.expiresAt || '' };
        } catch { /* unreadable metadata - shown as unprovisioned */ }
    }
    // Onboarding readiness (cheap - settings + row data only, NO NetBird API calls). One batched
    // settings read covers every tenant's webhook + Telegram keys; attached on both paths.
    const readySettings = await readTenantReadinessSettings(tenants.map(t => t.id));
    for (const t of tenants) t.readiness = tenantReadinessOf(t, readySettings);
    // Usage counts per linked tenant (parallel, tolerant - a failure just leaves null).
    // 'invited' tenants have no accessible account yet, everything else does.
    if (!withUsage) return tenants;
    await Promise.all(tenants.map(async t => {
        if (String(t.status).toLowerCase() === 'invited') return;
        // Fetch usage IN the tenant's own context so it uses the tenant PAT. Without a working
        // context the ?account= switch is silently ignored and NetBird returns MAIN's usage -
        // an empty tenant would show main's peer/user counts. Skip (usage stays null) unless the
        // switch is verified honored.
        if (!(await tenantContextSafe(t.id))) return;
        const [u, sub] = await runWithTenant(t.id, () => Promise.all([
            netbirdGet('/api/integrations/billing/usage').catch(() => null),
            netbirdGet('/api/integrations/billing/subscription').catch(() => null),
        ])).catch(() => [null, null]);
        if (u && typeof u === 'object' && !Array.isArray(u) && ('active_peers' in u || 'active_users' in u)) {
            t.usage = {
                activeUsers: Number(u.active_users) || 0, totalUsers: Number(u.total_users) || 0,
                activePeers: Number(u.active_peers) || 0, totalPeers: Number(u.total_peers) || 0,
            };
        }
        // Plan cell (official-dashboard parity): tier '' means free; trial days = ceil(sec/86400).
        if (sub && typeof sub === 'object' && !Array.isArray(sub) && 'plan_tier' in sub) {
            t.plan = {
                tier: sub.plan_tier || 'free',
                remainingTrialDays: sub.remaining_trial === undefined ? null : Math.ceil((Number(sub.remaining_trial) || 0) / 86400),
            };
        }
    }));
    return tenants;
}

// ── Tenant readiness + Fleet Report + Weekly MSP digest (all DB/settings, no per-tenant NetBird) ──
// Semver helpers: parse "major.minor.patch" (a leading v and any pre-release suffix are ignored),
// return null on anything unparseable. cmpSemver compares full triples (b may be null - any real
// version wins); cmpSemverMinor compares major.minor ONLY, so patch-level lag never flags a client.
function parseSemver(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}
function cmpSemver(a, b) {
    if (!b) return a ? 1 : 0;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}
function cmpSemverMinor(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
}
// Batch-read every readiness-relevant settings key for the given tenant ids in ONE query, so
// listMspTenants stays fast (no per-tenant round-trips). Returns key → raw value.
async function readTenantReadinessSettings(ids) {
    const keys = [];
    for (const id of ids) keys.push(`webhook_auth_token:${id}`, `webhook_notif_token:${id}`, `telegram_config:${id}`);
    const map = new Map();
    if (!keys.length) return map;
    const r = await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys]).catch(() => ({ rows: [] }));
    for (const row of r.rows) map.set(row.key, row.value);
    return map;
}
// The five onboarding checks for one tenant row - settings + row data only, no NetBird calls.
// Webhook tokens persist as '' when cleared, so require a NON-empty value (not mere key presence).
function tenantReadinessOf(t, settingsMap) {
    const evTok = settingsMap.get(`webhook_auth_token:${t.id}`);
    const nfTok = settingsMap.get(`webhook_notif_token:${t.id}`);
    let telegram = false;
    const tgRaw = settingsMap.get(`telegram_config:${t.id}`);
    if (tgRaw) { try { telegram = JSON.parse(tgRaw).enabled === true; } catch { /* unreadable config = not ready */ } }
    return {
        verified: String(t.status).toLowerCase() === 'active' || !!t.activatedAt,
        serviceUser: !!t.hasApiToken,
        webhookEvents: !!(evTok && String(evTok).trim()),
        webhookNotif: !!(nfTok && String(nfTok).trim()),
        telegram,
    };
}

// GET /api/msp/fleet-report backing - a one-row-per-tenant management snapshot built ENTIRELY from
// the app's own DB + settings. The tenant list comes from listMspTenants (withUsage:false → no
// per-tenant billing calls); every metric below is read from the peers mirror, nb_notifications,
// events/admin_events and the readiness settings - no per-tenant NetBird API calls.
async function getFleetReport() {
    const tenants = (await listMspTenants({ withUsage: false }))
        .filter(t => String(t.status).toLowerCase() !== 'invited');
    const ids = tenants.map(t => t.id);

    // Latest client version = highest semver seen across ALL accounts' peers (main + every tenant).
    const allVers = await pool.query(`SELECT raw_json->>'version' AS v FROM peers`).catch(() => ({ rows: [] }));
    let latest = null; // [major, minor, patch] or null when nothing parseable exists anywhere
    for (const row of allVers.rows) { const s = parseSemver(row.v); if (s && cmpSemver(s, latest) > 0) latest = s; }

    // Per-tenant peer rows (mirror getAllPeers' parsing: connected / last_seen / version from raw_json).
    const peerRows = ids.length
        ? (await pool.query(`SELECT tenant, raw_json FROM peers WHERE tenant = ANY($1)`, [ids]).catch(() => ({ rows: [] }))).rows
        : [];
    const peersByTenant = new Map(ids.map(id => [id, []]));
    for (const row of peerRows) { const a = peersByTenant.get(row.tenant); if (a) a.push(row.raw_json || {}); }

    // Raw undismissed-within-7d count per tenant - ONLY a fallback for tenants with no working
    // context below. It over-counts (stale/duplicate/self-resolved rows) exactly like the bug we
    // are fixing, so the accurate per-tenant count from getNbNotices (built next) wins whenever a
    // context switch succeeds.
    const issuesRaw = new Map();
    if (ids.length) {
        const r = await pool.query(
            `SELECT tenant, COUNT(*)::int AS n FROM nb_notifications
             WHERE dismissed_at IS NULL AND received_at > NOW() - interval '7 days' AND tenant = ANY($1)
             GROUP BY tenant`, [ids]).catch(() => ({ rows: [] }));
        for (const row of r.rows) issuesRaw.set(row.tenant, row.n);
    }

    // Per-tenant management figures fetched IN the tenant's own context (tenantContextSafe guard +
    // runWithTenant, exactly like listMspTenants' usage fetch). The report is on-demand (manual
    // refresh) + the weekly digest, so a per-tenant billing/usage/subscription/notices call is
    // acceptable. A tenant with no working context is skipped cleanly - its figures stay null and
    // knownIssues falls back to the raw count above.
    //  - knownIssues: getNbNotices({forAdmin:true}).length so the number MATCHES the Known Issues
    //    banner exactly (48h routing window, newest-per-peer/message dedup, connected-router
    //    self-resolve, integration notices admin-gated). getNbNotices reads the tenant's peers via
    //    the ALS-aware getAllPeers for the self-resolve check, which only works inside the context.
    //  - users: active/total from GET billing/usage (same call listMspTenants uses).
    //  - billedUsers: getBillingSummary() reads THIS tenant's latest 'billing%' admin_event meta
    //    (billed_users); NetBird's usage payload is preferred when it carries billed_users.
    //  - plan: { tier, remainingTrialDays } from GET billing/subscription - the SAME shape and
    //    mapping as the tenants-table Plan cell (t.plan), so the frontend reuses its renderer.
    const ctx = new Map();
    await Promise.all(tenants.map(async t => {
        if (!(await tenantContextSafe(t.id))) return;
        const data = await runWithTenant(t.id, async () => {
            const [usage, sub, billing, notices] = await Promise.all([
                netbirdGet('/api/integrations/billing/usage').catch(() => null),
                netbirdGet('/api/integrations/billing/subscription').catch(() => null),
                getBillingSummary().catch(() => null),
                getNbNotices({ forAdmin: true }).catch(() => null),
            ]);
            return { usage, sub, billing, notices };
        }).catch(() => null);
        if (!data) return;
        const u = data.usage;
        const users = (u && typeof u === 'object' && !Array.isArray(u) && ('active_users' in u || 'total_users' in u))
            ? { active: Number(u.active_users) || 0, total: Number(u.total_users) || 0 } : null;
        const billedFromUsage = u && typeof u === 'object' && !Array.isArray(u) && ('billed_users' in u)
            ? (Number.isFinite(Number(u.billed_users)) ? Number(u.billed_users) : null) : null;
        const billedUsers = billedFromUsage != null
            ? billedFromUsage
            : (data.billing && Number.isFinite(data.billing.billedUsers) ? data.billing.billedUsers : null);
        const sub = data.sub;
        const plan = (sub && typeof sub === 'object' && !Array.isArray(sub) && 'plan_tier' in sub)
            ? { tier: sub.plan_tier || 'free', remainingTrialDays: sub.remaining_trial === undefined ? null : Math.ceil((Number(sub.remaining_trial) || 0) / 86400) }
            : null;
        ctx.set(t.id, {
            users, billedUsers, plan,
            knownIssues: Array.isArray(data.notices) ? data.notices.length : null,
        });
    }));

    // Last activity = MAX(events.timestamp, admin_events.timestamp) per tenant.
    const lastEvent = new Map();
    const mergeMax = (t, v) => { if (!v) return; const cur = lastEvent.get(t); if (!cur || new Date(v) > new Date(cur)) lastEvent.set(t, v); };
    if (ids.length) {
        const ev = await pool.query(`SELECT tenant, MAX(timestamp) AS m FROM events WHERE tenant = ANY($1) GROUP BY tenant`, [ids]).catch(() => ({ rows: [] }));
        for (const row of ev.rows) mergeMax(row.tenant, row.m);
        const ae = await pool.query(`SELECT tenant, MAX(timestamp) AS m FROM admin_events WHERE tenant = ANY($1) GROUP BY tenant`, [ids]).catch(() => ({ rows: [] }));
        for (const row of ae.rows) mergeMax(row.tenant, row.m);
    }

    const cutoff30 = Date.now() - 30 * 86400_000;
    const now = Date.now();
    const rows = tenants.map(t => {
        const ps = peersByTenant.get(t.id) || [];
        let online = 0, offline30d = 0, outdated = 0;
        for (const raw of ps) {
            if (raw.connected) online++;
            else {
                const ls = raw.last_seen ? new Date(raw.last_seen).getTime() : NaN;
                if (Number.isFinite(ls) && ls < cutoff30) offline30d++;
            }
            const pv = parseSemver(raw.version);
            if (latest && pv && cmpSemverMinor(pv, latest) < 0) outdated++;
        }
        const rd = t.readiness || {};
        const suExpiry = (t.serviceUser && t.serviceUser.expiresAt) || null;
        const suOk = !!t.hasApiToken && (!suExpiry || new Date(suExpiry).getTime() >= now);
        const le = lastEvent.get(t.id);
        const c = ctx.get(t.id) || {};
        return {
            id: t.id, name: t.name, domain: t.domain, status: t.status,
            peers: { total: ps.length, online, offline30d },
            versions: { latest: latest ? latest.join('.') : null, outdated },
            // Matches the Known Issues banner (getNbNotices) whenever a context switch succeeded;
            // the raw over-counting query is only a fallback for no-context tenants.
            knownIssues: (c.knownIssues != null) ? c.knownIssues : (issuesRaw.get(t.id) || 0),
            users: c.users || null,
            billedUsers: (c.billedUsers != null) ? c.billedUsers : null,
            plan: c.plan || null,
            webhookEvents: !!rd.webhookEvents,
            webhookNotif: !!rd.webhookNotif,
            telegram: !!rd.telegram,
            serviceUser: { ok: suOk, expiresAt: suExpiry },
            lastEventAt: le ? new Date(le).toISOString() : null,
        };
    });
    return { generatedAt: new Date().toISOString(), tenants: rows };
}

// ── Weekly MSP digest (Contract C) - DISABLED by default (production kill switch) ──
const MSP_DIGEST_DEFAULT = { enabled: false, day: 1, hour: 8, telegram: true, emails: [] };
// Normalize/validate: day 0-6, hour 0-23, telegram default on, emails = valid-ish strings (deduped).
function normMspDigest(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const day = Number.isFinite(+r.day) ? Math.min(6, Math.max(0, Math.trunc(+r.day))) : 1;
    const hour = Number.isFinite(+r.hour) ? Math.min(23, Math.max(0, Math.trunc(+r.hour))) : 8;
    const emails = Array.isArray(r.emails)
        ? [...new Set(r.emails.map(e => String(e || '').trim()).filter(isPlausibleEmail))]
        : [];
    return { enabled: !!r.enabled, day, hour, telegram: r.telegram !== false, emails };
}
async function getMspDigestConfig() {
    const raw = await getSetting('msp_digest').catch(() => null);
    if (!raw) return { ...MSP_DIGEST_DEFAULT };
    try { return normMspDigest(JSON.parse(raw)); } catch { return { ...MSP_DIGEST_DEFAULT }; }
}
async function setMspDigestConfig(input) {
    const cfg = normMspDigest(input);
    await setSetting('msp_digest', JSON.stringify(cfg));
    return cfg;
}
// Build the fleet report and send a compact digest. `force` = the admin's "Send Now": skips the
// enabled/schedule/daily gates but STILL stamps the daily marker, so today's scheduled tick won't
// duplicate it. Runs from the main account (schedulers never enter tenant context) → main's Telegram.
async function sendMspDigest({ force = false } = {}) {
    const cfg = await getMspDigestConfig();
    const now = await tzNowParts();
    if (!force) {
        if (!cfg.enabled) return { telegram: false, emails: 0 };
        // AT-or-AFTER the configured hour on the configured day (see internalBackupTick).
        if (now.dow !== cfg.day || now.hour < cfg.hour) return { telegram: false, emails: 0 };
        const last = await getSetting('msp_digest_last').catch(() => '');
        if (last === now.dateKey) return { telegram: false, emails: 0 }; // already sent today
    }
    await setSetting('msp_digest_last', now.dateKey); // stamp up front (Send Now included)

    const report = await getFleetReport();
    const tenants = report.tenants;
    const genLabel = await tgFmtTime(report.generatedAt).catch(() => report.generatedAt);
    // Missing-readiness marks from the fleet row's own fields (status drives verified).
    const missingOf = (t) => {
        const m = [];
        if (String(t.status).toLowerCase() !== 'active') m.push('unverified');
        if (!t.serviceUser.ok) m.push('service-user');
        if (!t.webhookEvents) m.push('events-webhook');
        if (!t.webhookNotif) m.push('notif-webhook');
        if (!t.telegram) m.push('telegram');
        return m;
    };
    // Plan label - the same tier names + trial suffix the tenants-table Plan cell renders.
    const PLAN_NAMES = { business: 'Business', enterprise: 'Enterprise', team: 'Team', free: 'Free', trial: 'Free Trial' };
    const planLabel = (t) => {
        if (String(t.status).toLowerCase() !== 'active' || !t.plan) return '-';
        const tier = (t.plan.tier || 'free').toLowerCase();
        const d = t.plan.remainingTrialDays;
        if ((tier === 'trial' || tier === 'free') && d === 0) return 'Trial Expired';
        let s = PLAN_NAMES[tier] || tier;
        if (tier === 'trial' && d != null) s += d === 1 ? ' (1 day left)' : ` (${d} days left)`;
        return s;
    };
    const usersLabel = (t) => t.users ? `${t.users.active}/${t.users.total}` : '-';
    const billedLabel = (t) => (t.billedUsers != null ? String(t.billedUsers) : '-');
    // Fleet totals across every reported tenant (users/billed skip tenants with no readable figure).
    const totActiveUsers = tenants.reduce((s, t) => s + (t.users ? t.users.active : 0), 0);
    const totBilledUsers = tenants.reduce((s, t) => s + (t.billedUsers || 0), 0);
    const totPeers = tenants.reduce((s, t) => s + t.peers.total, 0);
    const totIssues = tenants.reduce((s, t) => s + t.knownIssues, 0);

    // Telegram (main's own Telegram, 'alerts' category - an admin/operational summary).
    let html = `🛰 <b>MSP Weekly Digest</b>`;
    html += `\n${tenants.length} tenant(s) · ${tgEsc(genLabel)}`;
    html += `\n<b>Fleet:</b> ${totActiveUsers} active users · ${totBilledUsers} billed · ${totPeers} peers · ${totIssues} issue(s)`;
    for (const t of tenants) {
        const miss = missingOf(t);
        html += `\n\n• <b>${tgEsc(t.name || t.id)}</b> - ${tgEsc(planLabel(t))}`;
        html += `\n   ${t.peers.total} peers (${t.peers.online} online) · users ${usersLabel(t)} · billed ${billedLabel(t)}`;
        html += `\n   ${t.peers.offline30d} offline 30d+ · ${t.versions.outdated} outdated · ${t.knownIssues} issue(s)`;
        if (miss.length) html += `\n   ⚠️ missing: ${tgEsc(miss.join(', '))}`;
    }
    if (!tenants.length) html += `\n\n• none`;
    const tgSent = cfg.telegram ? await sendTelegram('alerts', html).catch(() => null) : null;

    // Email (simple HTML table, via the existing mailer + its outbound logging).
    let emailsSent = 0;
    if (cfg.emails.length && getSmtpConfig().enabled) {
        const esc = htmlEsc;
        let body = `<p>${tenants.length} tenant(s) · generated ${esc(genLabel)}</p>`;
        body += `<p><b>Fleet totals:</b> ${totActiveUsers} active users · ${totBilledUsers} billed users · ${totPeers} peers · ${totIssues} known issue(s)</p>`;
        body += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">`;
        body += `<tr><th>Tenant</th><th>Plan</th><th>Users</th><th>Billed</th><th>Peers</th><th>Online</th><th>Offline 30d+</th><th>Outdated</th><th>Issues</th><th>Missing</th></tr>`;
        for (const t of tenants) {
            const miss = missingOf(t);
            body += `<tr><td>${esc(t.name || t.id)}</td><td>${esc(planLabel(t))}</td><td>${esc(usersLabel(t))}</td><td>${esc(billedLabel(t))}</td>`
                + `<td>${t.peers.total}</td><td>${t.peers.online}</td>`
                + `<td>${t.peers.offline30d}</td><td>${t.versions.outdated}</td><td>${t.knownIssues}</td>`
                + `<td>${miss.length ? esc(miss.join(', ')) : '-'}</td></tr>`;
        }
        if (!tenants.length) body += `<tr><td colspan="10">none</td></tr>`;
        body += `</table>`;
        for (const to of cfg.emails) {
            sendMail({ to, subject: 'MSP Weekly Digest', html: mailLayout('MSP Weekly Digest', body), tag: 'msp-digest' }).catch(() => { });
            emailsSent++;
        }
    }
    console.log('[MspDigest] weekly digest sent');
    return { telegram: !!tgSent, emails: emailsSent };
}

// The accounts the current token can switch into - the official dashboard's tenant switcher
// uses THIS endpoint and passes its items' `id` as the ?account= value (a switcher item also
// carries a separate account_id). We mirror that exactly.
async function listMspSwitcher() {
    const raw = await netbirdGet('/api/integrations/msp/switcher');
    return (Array.isArray(raw) ? raw : []).filter(t => t && t.id).map(t => ({
        id: t.id,
        accountId: t.account_id || '',
        name: t.name || '',
        domain: t.domain || '',
        status: t.status || '',
    }));
}

// ── Active-account registry + per-account loop (unification) ──
// Every account a scheduler / ingestion loop must service: the MAIN account ('') plus every
// linked tenant we can actually manage - the same set the tenant middleware validates against
// (switcher ids + non-'invited' tenant ids, deduped). Cached 60s (the middleware uses the same
// window); a scheduler tick doesn't need it fresher. ANY error → just ['' ], so a NetBird hiccup
// while listing tenants never strands the main-account jobs.
let _activeTenants = { at: 0, ids: [''] };
// Tenant id → display name, warmed from the same switcher/tenant lists listActiveTenantIds
// fetches (so a scheduler tick, which calls that first, always has fresh names before it
// notifies). Used by tenantTag() to name the account in a notification; falls back to the id.
let _tenantNames = { at: 0, map: new Map() };
async function listActiveTenantIds() {
    if (Date.now() - _activeTenants.at < 60_000) return _activeTenants.ids;
    try {
        const [sw, list] = await Promise.all([
            listMspSwitcher(),
            listMspTenants({ withUsage: false }),
        ]);
        const ids = new Set(['']);
        const names = new Map();
        for (const t of sw) { if (t.id) ids.add(t.id); if (t.id && t.name) names.set(t.id, t.name); }
        for (const t of list) { if (String(t.status).toLowerCase() !== 'invited') ids.add(t.id); if (t.id && t.name) names.set(t.id, t.name); }
        _activeTenants = { at: Date.now(), ids: [...ids] };
        _tenantNames = { at: Date.now(), map: names };
    } catch (e) {
        console.error('[Unify] active-account list error:', e.message);
        return ['']; // never block the main account on a tenant-listing failure
    }
    return _activeTenants.ids;
}

// ── Per-account keyed app_settings + tenant name tag ──
// app_settings is GLOBAL (not tenant-scoped), so a per-account marker (e.g. a scheduler's
// daily gate) uses a keyed suffix: the bare key for main (''), `key:<tenant>` in a tenant
// context - the same pattern as the blocklist dupKey helper. Keeps each account's gate independent.
function tntKey(key) { const t = tnt(); return t ? `${key}:${t}` : key; }
// '' for main; ' [<tenant name>]' inside a tenant context, appended to a notification title/
// subject so a scheduler-driven grant/recert/automation event names WHICH account it belongs
// to. Reads the cached name (warmed by listActiveTenantIds); falls back to the id, and kicks a
// non-blocking refresh when the cache is stale so a UI-context notification catches up next time.
function tenantTag() {
    const t = tnt();
    if (!t) return '';
    if (Date.now() - _tenantNames.at > 60_000) listActiveTenantIds().catch(() => { });
    return ` [${_tenantNames.map.get(t) || t}]`;
}

// Resolve a tenant id to its display name (same 60s cache; falls back to the raw id).
// Used at READ time - audit rows and Telegram messages store the stable id but show the name,
// so old rows resolve too and a renamed tenant shows its current name.
function tenantNameOf(id) {
    const t = String(id || '');
    if (!t) return t;
    if (Date.now() - _tenantNames.at > 60_000) listActiveTenantIds().catch(() => { });
    return _tenantNames.map.get(t) || t;
}

// Run fn once per active account: for main ('') call it directly, for each tenant inside
// runWithTenant so every ALS-aware call (netbirdGet/Post, tnt()) targets that tenant. Per-
// iteration try/catch collects errors so ONE account's failure never blocks the rest; after the
// loop, if any failed, throw a single summary Error (so tracked() raises the scheduler alert)
// naming the count + the first message.
// Scheduler-side honored-switch guard. NetBird silently IGNORES ?account= when the main token's
// service user has no permission group on the tenant - the HTTP middleware detects that and 502s,
// but scheduler iterations had no equivalent check, so a tokenless tenant's jobs would mirror
// MAIN's peers/users/logs stamped with the tenant id (cross-account leak into tenant rows).
// A tenant with its own PAT needs no switch; otherwise verify once per 10 minutes (both outcomes
// cached so a broken tenant is not re-probed every tick) and SKIP the tenant when not honored.
const _switchSafe = new Map(); // tenant id → { at, ok }
async function tenantContextSafe(id) {
    if (hasTenantToken(id)) return true;
    const c = _switchSafe.get(id);
    if (c && Date.now() - c.at < 10 * 60_000) return c.ok;
    let ok = false;
    try {
        const [tAcc, mAcc] = await Promise.all([
            runWithTenant(id, () => netbirdGet('/api/accounts')),
            netbirdGet('/api/accounts'),
        ]);
        const tid = Array.isArray(tAcc) && tAcc[0] && tAcc[0].id;
        const mid = Array.isArray(mAcc) && mAcc[0] && mAcc[0].id;
        ok = !!(tid && mid && tid !== mid);
    } catch { ok = false; }
    _switchSafe.set(id, { at: Date.now(), ok });
    if (!ok) console.warn(`[Scheduler] tenant ${id}: no PAT and account switch not honored - per-tenant jobs skipped (provision its service user)`);
    return ok;
}

async function forEachTenant(fn) {
    const ids = await listActiveTenantIds();
    const errors = [];
    for (const id of ids) {
        try {
            if (id) {
                // Better no sync than main's inventory written under the tenant's id.
                if (!(await tenantContextSafe(id))) continue;
                await runWithTenant(id, fn);
            } else await fn();
        } catch (e) {
            errors.push(`${id || 'main'}: ${e.message}`);
        }
    }
    if (errors.length) throw new Error(`${errors.length}/${ids.length} account iterations failed: ${errors[0]}`);
}

// ── Per-tenant config copy helpers (shared by "apply to all" propagation + new-tenant seeding) ──
// REPLACE semantics: the tenant's own rows are wiped and overwritten with main's. Each helper reads
// main's rows ONCE (pass the result into copy*To) so a loop over N tenants reads main just once.
// All read main via explicit `tenant = ''`, so they are correct regardless of ALS context.

// Main's filter rules + built-in-noise flag (the source of truth for both copy paths).
async function readMainFilterConfig() {
    const rules = (await pool.query(
        `SELECT field, operator, value, enabled, sort_order FROM filter_rules WHERE tenant = '' ORDER BY sort_order, id`
    )).rows;
    const noise = await getSetting('builtin_noise').catch(() => null); // 'true' | 'false' | undefined
    return { rules, noise };
}
// Overwrite ONE tenant's filter rules + noise toggle with main's. Returns the rule count copied.
// Caller invalidates the filter cache once after its batch (invalidateFilterCache clears ALL slots).
async function copyFilterRulesTo(id, main) {
    await pool.query('DELETE FROM filter_rules WHERE tenant = $1', [id]);
    for (const r of main.rules) {
        await pool.query(
            `INSERT INTO filter_rules (tenant, field, operator, value, enabled, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, r.field, r.operator, r.value, r.enabled, r.sort_order]
        );
    }
    // Copy main's built-in noise toggle to the tenant's keyed setting (default enabled).
    await setSetting(`builtin_noise:${id}`, main.noise === 'false' ? 'false' : 'true');
    return main.rules.length;
}

// Main's blocklist, split into the copyable (scope 'all') entries and the skipped-count.
// Network-scoped entries ('only'/'except') reference MAIN-account network ids that do not exist
// under a tenant, so they are SKIPPED - the skipped set is identical for every tenant.
async function readMainBlocklist() {
    const entries = (await pool.query(
        `SELECT value, note, scope, enforce, enabled, mode, max_prefix FROM address_blocklist WHERE tenant = ''`
    )).rows;
    const copyable = entries.filter(e => (e.scope || 'all') === 'all');
    return { copyable, skipped: entries.length - copyable.length };
}
// Overwrite ONE tenant's blocklist with main's copyable (scope 'all') entries. Returns the count.
async function copyBlocklistTo(id, main) {
    await pool.query('DELETE FROM address_blocklist WHERE tenant = $1', [id]);
    for (const e of main.copyable) {
        await pool.query(
            `INSERT INTO address_blocklist (value, note, scope, networks, enforce, enabled, mode, max_prefix, tenant)
             VALUES ($1, $2, 'all', '[]'::jsonb, $3, $4, $5, $6, $7)`,
            [e.value, e.note, e.enforce, e.enabled, e.mode, e.max_prefix, id]
        );
    }
    return main.copyable.length;
}

// Copy a NetBird ACCOUNT `settings` object into ONE tenant (REPLACE semantics). `mainSettings` is a
// full settings-shaped blob built by the CALLER from the tenant-defaults profile (nbSettingsFromProfile)
// - historically main's live settings, now the explicit defaults profile. Runs
// INSIDE the tenant context: GET /api/accounts → accounts[0] is the tenant's own account (its `id` is
// the tenant account id) → PUT /api/accounts/<id> with body { settings: mainSettings }. Sent AS-IS:
// the settings object carries no account-bound identity (the account id travels in the URL, not the
// body; per the NetBird accounts API the settings blob has no per-account identity fields), and each
// account owns its own JWT/extra fields - if NetBird rejects a field the error surfaces here. Callers
// treat this as best-effort, so a failure never aborts the surrounding app-config seeding.
// Account-INFRASTRUCTURE fields must never be copied between accounts: overwriting a tenant's
// own DNS domain or IP ranges with main's could break its address allocation. Policy toggles
// (expirations, approval, propagation, JWT, extra flags) are the copyable "settings".
// INFRA PROTECTION now lives UPSTREAM, not in an input filter here: nbSettingsFromProfile emits
// dns_domain/network_range/network_range_v6 ONLY when the profile deliberately sets them (non-empty),
// and deriveDefaultsFromMain never emits them at all. So an unset infra field never reaches this
// merge - it is simply absent from `mainSettings` and the tenant's own value survives untouched.
// A DELIBERATE profile value, by contrast, must pass through - hence no filter on the input below.
async function copyNbSettingsTo(tenantId, mainSettings) {
    const id = String(tenantId || '').trim();
    if (!id) throw new Error('a tenant id is required');
    if (!mainSettings || typeof mainSettings !== 'object') throw new Error('main account settings are unavailable');
    return await runWithTenant(id, async () => {
        const accounts = await netbirdGet('/api/accounts');
        const acct = Array.isArray(accounts) && accounts[0];
        if (!acct || !acct.id) throw new Error('could not resolve the tenant account id');
        // MERGE onto the tenant's current settings (not a bare replace): PUT wants a full settings
        // object, and any field ABSENT from the input keeps the tenant's own value (this is what
        // preserves an unset infra field - see the infra-protection note above).
        const input = { ...mainSettings };
        const unsupported = dropUnsupportedNbSettings(input, acct.settings);
        const merged = { ...(acct.settings || {}), ...input };
        if (acct.settings && acct.settings.extra && input.extra) merged.extra = { ...acct.settings.extra, ...input.extra };
        const r = await netbirdPut(`/api/accounts/${encodeURIComponent(acct.id)}`, { settings: merged });
        if (!r || r.status >= 300) {
            throw new Error('Failed to write tenant account settings: ' + (r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)));
        }
        return { unsupported };
    });
}

// ── "Apply to all tenants" propagation (main account only) ──
// Per-tenant work is wrapped so ONE tenant's failure never aborts the rest; the response reports how
// many tenants succeeded (+ errors when any failed). Main-only - the routes reject a tenant-context
// call, and the copy helpers read main's rows via `tenant = ''` regardless of ALS.
async function propagateFilterRules() {
    const ids = (await listActiveTenantIds()).filter(Boolean); // every tenant, never main ('')
    const main = await readMainFilterConfig();
    let tenants = 0, errors = 0;
    for (const id of ids) {
        try {
            await copyFilterRulesTo(id, main);
            tenants++;
        } catch (e) {
            errors++;
            console.error(`[Propagate] filter rules -> ${id}:`, e.message);
        }
    }
    invalidateFilterCache();
    return { tenants, rules: main.rules.length, ...(errors ? { errors } : {}) };
}

async function propagateBlocklist() {
    const ids = (await listActiveTenantIds()).filter(Boolean); // every tenant, never main ('')
    const main = await readMainBlocklist();
    let tenants = 0, errors = 0;
    for (const id of ids) {
        try {
            await copyBlocklistTo(id, main);
            tenants++;
        } catch (e) {
            errors++;
            console.error(`[Propagate] blocklist -> ${id}:`, e.message);
        }
    }
    return { tenants, copied: main.copyable.length, skipped: main.skipped, ...(errors ? { errors } : {}) };
}

// ── Tenant Defaults profile ──
// The EXPLICIT admin-defined reference that seeding/apply/drift read - NOT "copy main's live config"
// ("not everything right for us fits our customers"). Stored as ONE settings key `tenant_defaults`
// (JSON). `nb` is a FLAT map of the FULL official NetBird account settings set; when written to
// NetBird the three flags peer_approval_enabled + user_approval_required + network_traffic_logs_enabled
// live under settings.extra, everything else is a top-level settings field. Group-based settings
// (peer_expose_groups, ipv6_enabled_groups) are excluded by design - account-specific group ids are
// not portable. Infra fields (dns_domain/network_range/network_range_v6) are written to a tenant ONLY
// when the profile explicitly sets them. retentionDays: positive int (days, capped 3650) or null =
// keep forever. copyFilterRules/copyBlocklist gate the app-config copies.

// Lightweight validators for the INFRA fields (applied only when the field is non-empty). Domain-ish
// / CIDR-ish - enough to reject obvious garbage; NetBird does the authoritative validation on write.
const DNS_DOMAIN_RE = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const CIDR4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\/(?:3[0-2]|[12]?\d)$/;
const CIDR6_RE = /^[0-9a-fA-F:]+\/(?:12[0-8]|1[01]\d|\d?\d)$/;

// Coerce any input into the canonical profile shape (types/ranges validated, unknown keys dropped).
// OLD saved profiles (previous shape) normalize cleanly: missing new fields take the defaults below,
// and the removed field `peer_inactivity_expiration` (now fixed at 600s) is simply dropped.
function normalizeTenantDefaults(input) {
    const p = (input && typeof input === 'object') ? input : {};
    const nbIn = (p.nb && typeof p.nb === 'object') ? p.nb : {};
    const bool = (v, d) => typeof v === 'boolean' ? v : (v == null ? d : !!v);
    const str = v => typeof v === 'string' ? v.trim() : '';
    // peer_login_expiration: positive int seconds, clamped to NetBird's 60s..180d (15552000s) window.
    const loginExp = (() => {
        const n = Math.round(Number(nbIn.peer_login_expiration));
        if (!Number.isFinite(n) || n <= 0) return 86400;
        return Math.min(15552000, Math.max(60, n));
    })();
    // Infra fields: trimmed strings; '' = unset (never written to a tenant). Non-empty is validated.
    const dns_domain = str(nbIn.dns_domain);
    if (dns_domain && !DNS_DOMAIN_RE.test(dns_domain)) throw new Error(`Invalid DNS domain: "${dns_domain}"`);
    const network_range = str(nbIn.network_range);
    if (network_range && !CIDR4_RE.test(network_range)) throw new Error(`Invalid network range (expected IPv4 CIDR, e.g. 100.64.0.0/10): "${network_range}"`);
    const network_range_v6 = str(nbIn.network_range_v6);
    if (network_range_v6 && !CIDR6_RE.test(network_range_v6)) throw new Error(`Invalid IPv6 network range (expected IPv6 CIDR, e.g. fd00::/48): "${network_range_v6}"`);
    // jwt_allow_groups: array of non-empty (trimmed) strings; anything else → [].
    const jwt_allow_groups = Array.isArray(nbIn.jwt_allow_groups)
        ? nbIn.jwt_allow_groups.map(g => typeof g === 'string' ? g.trim() : '').filter(Boolean)
        : [];
    const nb = {
        enabled: bool(nbIn.enabled, true),
        peer_approval_enabled: bool(nbIn.peer_approval_enabled, false),          // → settings.extra
        user_approval_required: bool(nbIn.user_approval_required, false),        // → settings.extra
        // Cloud MFA lives on the dedicated per-account /api/service/mfa endpoint (NOT settings). Old
        // profiles' removed `local_mfa_enabled` (embedded-IdP self-hosted MFA) is dropped silently.
        mfa_enabled: bool(nbIn.mfa_enabled, false),
        mfa_remember_browser: bool(nbIn.mfa_remember_browser, false),
        peer_login_expiration_enabled: bool(nbIn.peer_login_expiration_enabled, true),
        peer_login_expiration: loginExp,
        peer_inactivity_expiration_enabled: bool(nbIn.peer_inactivity_expiration_enabled, false), // duration fixed at 600s
        groups_propagation_enabled: bool(nbIn.groups_propagation_enabled, true),
        jwt_groups_enabled: bool(nbIn.jwt_groups_enabled, false),
        jwt_groups_claim_name: typeof nbIn.jwt_groups_claim_name === 'string' ? nbIn.jwt_groups_claim_name : '',
        jwt_allow_groups,
        regular_users_view_blocked: bool(nbIn.regular_users_view_blocked, true),
        dns_domain, network_range, network_range_v6,                            // '' = do not set on tenants
        // true = force IPv6 OFF on tenants by clearing ipv6_enabled_groups (an empty list is the
        // official "disable IPv6"); false = leave the tenant's IPv6 groups untouched.
        ipv6_disable: bool(nbIn.ipv6_disable, false),
        routing_peer_dns_resolution_enabled: bool(nbIn.routing_peer_dns_resolution_enabled, true),
        network_traffic_logs_enabled: bool(nbIn.network_traffic_logs_enabled, false), // → settings.extra
        network_traffic_packet_counter_enabled: bool(nbIn.network_traffic_packet_counter_enabled, false), // → settings.extra (kernel)
        auto_update_version: str(nbIn.auto_update_version) || 'disabled',        // 'disabled' | 'latest' | version
        auto_update_always: bool(nbIn.auto_update_always, false),
        peer_expose_enabled: bool(nbIn.peer_expose_enabled, false),
        lazy_connection_enabled: bool(nbIn.lazy_connection_enabled, false),
        // Tri-state (NetBird v0.81+): null = NOT MANAGED by the profile. Never defaulted, so a
        // profile saved before this field existed can't switch the setting off on a tenant.
        peer_hostname_collision_rejected: typeof nbIn.peer_hostname_collision_rejected === 'boolean' ? nbIn.peer_hostname_collision_rejected : null,
    };
    // retentionDays: positive int (capped 3650) or null (keep forever). 0/invalid → null.
    let retentionDays = null;
    if (p.retentionDays != null) {
        const n = Math.round(Number(p.retentionDays));
        retentionDays = Number.isFinite(n) && n > 0 ? Math.min(3650, n) : null;
    }
    return {
        nb,
        retentionDays,
        copyFilterRules: bool(p.copyFilterRules, true),
        copyBlocklist: bool(p.copyBlocklist, true),
    };
}

// Saved profile (normalized) or null when the admin has never defined one.
async function getTenantDefaults() {
    const raw = await getSetting('tenant_defaults').catch(() => null);
    if (!raw) return null;
    try { return normalizeTenantDefaults(JSON.parse(raw)); }
    catch { return null; }
}

// Validate + persist the profile. Numbers coerced, unknown keys dropped. Returns the saved profile.
async function setTenantDefaults(profile) {
    if (!profile || typeof profile !== 'object') throw new Error('a defaults profile object is required');
    const clean = normalizeTenantDefaults(profile);
    await setSetting('tenant_defaults', JSON.stringify(clean));
    return clean;
}

// Derive the LEGACY-equivalent profile from main's LIVE config (nb from getAccountSettings() mapped
// to the flat shape with enabled:true, retention from main's effective window, copy flags on). This
// is the fallback when no profile is saved (so behavior is unchanged) AND powers the route's
// `mainCurrent` ("Load Current Main Values" button).
// The cloud MFA service (/api/service/mfa) is NOT served by every NetBird API base - the public
// management API answers it with a plain-text 404. Probe once (1h cache) so every MFA consumer
// (derive/seed/drift) can skip cleanly instead of logging errors or POSTing into a missing route.
let _mfaSupport = { at: 0, ok: null };
async function mfaSupported() {
    if (_mfaSupport.ok !== null && Date.now() - _mfaSupport.at < 3600_000) return _mfaSupport.ok;
    const r = await netbirdGet('/api/service/mfa').catch(() => null);
    _mfaSupport = { at: Date.now(), ok: !!r && typeof r === 'object' };
    return _mfaSupport.ok;
}

// Map a NetBird account `settings` object (+ its cloud MFA state) to the FLAT nb shape that both the
// Tenant Defaults profile and the LIVE NetBird Settings editor use. This is the READ counterpart of
// nbSettingsFromProfile (the WRITE builder). The `enabled` master flag and the seeding-only
// `ipv6_disable` convenience are NOT part of this shape - they are added by deriveDefaultsFromMain.
// Infra fields (dns_domain/network_range/network_range_v6) ARE populated here from the account's own
// values (the live editor edits them); deriveDefaultsFromMain blanks them so main's infra never leaks
// onto tenants. `mfa` is the /api/service/mfa payload ({} when the API base doesn't serve MFA).
function nbShapeFromSettings(settings, mfa) {
    const s = settings || {};
    const extra = s.extra || {};
    const m = mfa || {};
    const b = (v, d) => typeof v === 'boolean' ? v : (v == null ? d : !!v);
    const posInt = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };
    return {
        peer_approval_enabled: b(extra.peer_approval_enabled, false),
        user_approval_required: b(extra.user_approval_required, false),
        mfa_enabled: b(m.mfa, false),
        mfa_remember_browser: b(m.mfa_remember_browser, false),
        peer_login_expiration_enabled: b(s.peer_login_expiration_enabled, true),
        peer_login_expiration: posInt(s.peer_login_expiration, 86400),
        peer_inactivity_expiration_enabled: b(s.peer_inactivity_expiration_enabled, false),
        groups_propagation_enabled: b(s.groups_propagation_enabled, true),
        jwt_groups_enabled: b(s.jwt_groups_enabled, false),
        jwt_groups_claim_name: typeof s.jwt_groups_claim_name === 'string' ? s.jwt_groups_claim_name : '',
        jwt_allow_groups: Array.isArray(s.jwt_allow_groups) ? s.jwt_allow_groups.filter(g => typeof g === 'string' && g.trim()) : [],
        regular_users_view_blocked: b(s.regular_users_view_blocked, true),
        dns_domain: typeof s.dns_domain === 'string' ? s.dns_domain : '',
        network_range: typeof s.network_range === 'string' ? s.network_range : '',
        network_range_v6: typeof s.network_range_v6 === 'string' ? s.network_range_v6 : '',
        routing_peer_dns_resolution_enabled: b(s.routing_peer_dns_resolution_enabled, true),
        network_traffic_logs_enabled: b(extra.network_traffic_logs_enabled, false),
        network_traffic_packet_counter_enabled: b(extra.network_traffic_packet_counter_enabled, false),
        auto_update_version: typeof s.auto_update_version === 'string' && s.auto_update_version.trim() ? s.auto_update_version.trim() : 'disabled',
        auto_update_always: b(s.auto_update_always, false),
        peer_expose_enabled: b(s.peer_expose_enabled, false),
        lazy_connection_enabled: b(s.lazy_connection_enabled, false),
        // null = this account's NetBird doesn't expose the setting (pre-v0.81, which silently
        // ignores the key on PUT). v0.81+ always returns it, false included.
        peer_hostname_collision_rejected: typeof s.peer_hostname_collision_rejected === 'boolean' ? s.peer_hostname_collision_rejected : null,
    };
}

async function deriveDefaultsFromMain() {
    const s = (await getAccountSettings().catch(() => null)) || {};
    // Cloud MFA is a dedicated per-account endpoint, not part of the settings blob.
    const mfa = (await mfaSupported()) ? ((await netbirdGet('/api/service/mfa').catch(() => null)) || {}) : {};
    const nb = {
        enabled: true,
        ...nbShapeFromSettings(s, mfa),
        // Infra fields are NEVER derived from main - main's DNS domain / IP ranges must not leak onto tenants.
        dns_domain: '', network_range: '', network_range_v6: '',
        ipv6_disable: false, // never derived - leaving tenant IPv6 untouched is the safe default
    };
    const ret = Math.min(3650, Math.max(0, Math.round(Number(_security.retentionDays) || 0)));
    return { nb, retentionDays: ret > 0 ? ret : null, copyFilterRules: true, copyBlocklist: true };
}

// ── LIVE NetBird account settings editor (main OR managed tenant) ──
// Reads/writes the CURRENT account's ACTUAL NetBird settings via the ALS context - so it targets main
// in main mode and the managed tenant's own account in tenant mode (getAccountSettings + the accounts
// list are already ALS-aware). Distinct from the Tenant Defaults profile, which is a stored TEMPLATE
// for NEW tenants. No master toggle, no copy flags, no retention (retention has its own editor).
async function getNetbirdSettings() {
    const s = (await getAccountSettings().catch(() => null)) || {};
    const mfaSup = await mfaSupported();
    const mfa = mfaSup ? ((await netbirdGet('/api/service/mfa').catch(() => null)) || {}) : {};
    return { nb: nbShapeFromSettings(s, mfa), mfaSupported: mfaSup };
}

// Apply the flat nb map to the CURRENT account's live settings. Uses the SAME builder seeding uses
// (nbSettingsFromProfile) and MERGES the patch onto the account's current settings (never a bare
// replace - preserves fields the patch doesn't set, same logic as copyNbSettingsTo). INFRA SAFETY:
// dns_domain / network_range / network_range_v6 re-allocate every peer IP, so they are sent ONLY when
// actually CHANGED from the account's current value (avoids a no-op re-allocation). The ipv6_disable
// seeding convenience is intentionally absent from the live shape, so no ipv6_enabled_groups is
// touched here. Cloud MFA is applied via the separate /api/service/mfa endpoint, best-effort.
async function saveNetbirdSettings(nbInput) {
    const nb = nbInput && typeof nbInput === 'object' ? nbInput : {};
    // Resolve the CURRENT account (main or managed tenant) - accounts[0] is this context's own account.
    const accounts = await netbirdGet('/api/accounts');
    const acct = Array.isArray(accounts) && accounts[0];
    if (!acct || !acct.id) throw new Error('could not resolve the account id');
    const cur = acct.settings || {};
    const patch = nbSettingsFromProfile(nb); // infra fields present only when non-empty (see builder)
    // INFRA SAFETY: drop an infra field from the patch when it equals the account's current value, so
    // an unchanged DNS domain / range never triggers a re-allocation of peer IPs.
    for (const f of ['dns_domain', 'network_range', 'network_range_v6']) {
        if (f in patch && String(patch[f]) === String(cur[f] == null ? '' : cur[f])) delete patch[f];
    }
    // The editor hides a setting this NetBird doesn't expose; this is the server-side backstop.
    dropUnsupportedNbSettings(patch, cur);
    const merged = { ...cur, ...patch };
    if (cur.extra && patch.extra) merged.extra = { ...cur.extra, ...patch.extra };
    const r = await netbirdPut(`/api/accounts/${encodeURIComponent(acct.id)}`, { settings: merged });
    if (!r || r.status >= 300) {
        throw new Error('Failed to write account settings: ' + (r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)));
    }
    // Cloud MFA is a dedicated per-account endpoint (not part of the settings blob) - best-effort,
    // like seeding. Skipped entirely when the API base doesn't serve the MFA route.
    let mfa = false;
    const mfaSup = await mfaSupported();
    if (mfaSup) {
        try {
            const mr = await netbirdPost('/api/service/mfa', { mfa: !!nb.mfa_enabled, mfa_remember_browser: !!nb.mfa_remember_browser });
            mfa = !!mr && mr.status < 300;
        } catch (e) { console.error('[NetbirdSettings] MFA write:', e.message); }
    }
    // Bust the MAIN account settings cache so the follow-up read reflects the write (tenant reads are
    // uncached in getAccountSettings, so this is a no-op there).
    _acctSettings = { at: 0, data: _acctSettings.data, failedAt: 0 };
    const infraChanged = ['dns_domain', 'network_range', 'network_range_v6'].filter(f => f in patch);
    const summary = {
        peer_approval: !!nb.peer_approval_enabled,
        session_expiration: !!nb.peer_login_expiration_enabled,
        jwt_group_sync: !!nb.jwt_groups_enabled,
        traffic_events: !!nb.network_traffic_logs_enabled,
        ...(infraChanged.length ? { infraChanged } : {}),
        mfa: mfaSup ? (mfa ? 'on' : 'off') : 'n/a',
    };
    const fresh = await getNetbirdSettings();
    return { ...fresh, summary };
}

// The reference profile used by seeding/apply/drift: the saved profile if any, else derived from
// main's live config (so an unset profile === the old "copy main" behavior).
async function effectiveTenantDefaults() {
    return (await getTenantDefaults()) || (await deriveDefaultsFromMain());
}

// Build a NetBird `settings`-shaped object from the profile's flat nb map, for copyNbSettingsTo
// (which MERGES it onto the tenant's live settings). Top-level policy fields go as-is; the three
// extra flags go under settings.extra. peer_inactivity_expiration is FIXED at 600s (matches the
// official dashboard - not configurable). Infra fields are emitted ONLY when the profile deliberately
// sets them (non-empty) - this is where the infra protection lives (copyNbSettingsTo no longer filters
// its input), so an unset infra field is simply never written and the tenant keeps its own value.
// nb.enabled is NOT a settings field - the caller checks it.
function nbSettingsFromProfile(nb) {
    const s = {
        peer_login_expiration_enabled: !!nb.peer_login_expiration_enabled,
        peer_login_expiration: Math.max(1, Math.round(Number(nb.peer_login_expiration) || 86400)),
        peer_inactivity_expiration_enabled: !!nb.peer_inactivity_expiration_enabled,
        peer_inactivity_expiration: 600,
        groups_propagation_enabled: !!nb.groups_propagation_enabled,
        jwt_groups_enabled: !!nb.jwt_groups_enabled,
        jwt_groups_claim_name: typeof nb.jwt_groups_claim_name === 'string' ? nb.jwt_groups_claim_name : '',
        jwt_allow_groups: Array.isArray(nb.jwt_allow_groups) ? nb.jwt_allow_groups.filter(g => typeof g === 'string' && g.trim()) : [],
        regular_users_view_blocked: !!nb.regular_users_view_blocked,
        routing_peer_dns_resolution_enabled: !!nb.routing_peer_dns_resolution_enabled,
        lazy_connection_enabled: !!nb.lazy_connection_enabled,
        auto_update_version: typeof nb.auto_update_version === 'string' && nb.auto_update_version.trim() ? nb.auto_update_version.trim() : 'disabled',
        auto_update_always: !!nb.auto_update_always,
        peer_expose_enabled: !!nb.peer_expose_enabled,
        extra: {
            peer_approval_enabled: !!nb.peer_approval_enabled,
            user_approval_required: !!nb.user_approval_required,
            network_traffic_logs_enabled: !!nb.network_traffic_logs_enabled,
            // Official dependency rule: the kernel counter is forced OFF when traffic events is OFF.
            network_traffic_packet_counter_enabled: nb.network_traffic_logs_enabled ? !!nb.network_traffic_packet_counter_enabled : false,
        },
    };
    // Infra fields ONLY when deliberately set (non-empty). See the infra-protection note above.
    const dns = typeof nb.dns_domain === 'string' ? nb.dns_domain.trim() : '';
    const nr = typeof nb.network_range === 'string' ? nb.network_range.trim() : '';
    const nr6 = typeof nb.network_range_v6 === 'string' ? nb.network_range_v6.trim() : '';
    if (dns) s.dns_domain = dns;
    if (nr) s.network_range = nr;
    if (nr6) s.network_range_v6 = nr6;
    // Disable IPv6 = clear the tenant's IPv6 groups (the official mechanism). Only emitted when
    // deliberately enabled - otherwise the tenant's own IPv6 groups are left untouched.
    if (nb.ipv6_disable) s.ipv6_enabled_groups = [];
    // Tri-state: emitted only when explicitly managed (true/false). Writers drop it again for an
    // account whose NetBird doesn't know the key (see dropUnsupportedNbSettings).
    if (typeof nb.peer_hostname_collision_rejected === 'boolean') s.peer_hostname_collision_rejected = nb.peer_hostname_collision_rejected;
    return s;
}

// Settings keys newer NetBird versions added. An older server ignores an unknown key on PUT and
// still answers 200, so "saved" would be a lie - drop each one the account's own settings (as
// returned by GET) don't carry, and report it. Mutates `patch`; returns the dropped keys.
const NB_VERSIONED_SETTINGS = ['peer_hostname_collision_rejected'];
function dropUnsupportedNbSettings(patch, current) {
    const cur = current || {};
    const dropped = [];
    for (const k of NB_VERSIONED_SETTINGS) {
        if (k in patch && !(k in cur)) { delete patch[k]; dropped.push(k); }
    }
    return dropped;
}

// Seed the effective DEFAULTS PROFILE into ONE tenant (REPLACE semantics) - called on tenant
// creation and from the per-tenant "Apply Defaults" route. copyFilterRules/copyBlocklist gate the
// filter-rules + built-in noise and blocklist copies; retention comes from the profile; nb.enabled
// gates the NetBird account-settings write. Returns a summary for the create/apply response + audit
// meta - rules/blocklist counts are 0 when their flag is off, with copiedRules/copiedBlocklist flags.
async function seedTenantDefaults(tenantId) {
    const id = String(tenantId || '').trim();
    if (!id) throw new Error('a tenant id is required');
    const profile = await effectiveTenantDefaults();

    // App-config copies are GATED by the profile's copy flags. When a flag is off the tenant's own
    // rows/entries are left untouched (they are NOT part of the contract defaults).
    let rules = 0, copiedRules = false;
    if (profile.copyFilterRules) { rules = await copyFilterRulesTo(id, await readMainFilterConfig()); copiedRules = true; }
    let blocklist = 0, copiedBlocklist = false;
    if (profile.copyBlocklist) { blocklist = await copyBlocklistTo(id, await readMainBlocklist()); copiedBlocklist = true; }

    // Retention from the profile (null = keep forever = 0). Stored explicitly so drift reads a value.
    const retentionDays = Math.min(3650, Math.max(0, Math.round(Number(profile.retentionDays) || 0)));
    await setSetting(`retention_days:${id}`, String(retentionDays));
    invalidateFilterCache(); // the tenant's filter slot must re-read its freshly copied rules

    // NetBird ACCOUNT settings from the profile's nb map (login expiration, peer approval, groups
    // propagation, JWT sync, ...) - only when nb.enabled. PER-STEP try/catch: a failure of JUST this
    // NetBird write must NOT abort the DB-only app-config seeding above - report it (nbSettings:false)
    // + log. copyNbSettingsTo switches into the tenant and MERGES the built settings object on.
    let nbSettings = false, mfa = false, nbUnsupported = [];
    if (profile.nb && profile.nb.enabled) {
        try {
            nbUnsupported = (await copyNbSettingsTo(id, nbSettingsFromProfile(profile.nb))).unsupported;
            nbSettings = true;
        } catch (e) {
            console.error('[MSP] seed NetBird settings -> %s:', id, e.message);
        }
        // Cloud MFA is a dedicated per-account endpoint (not part of the settings blob) - its own
        // best-effort step in the tenant context. Failure marks mfa:false without breaking the rest.
        // Skipped entirely (mfa stays false) when the API base doesn't serve the MFA route.
        if (await mfaSupported()) {
            try {
                const r = await runWithTenant(id, () => netbirdPost('/api/service/mfa', {
                    mfa: !!profile.nb.mfa_enabled,
                    mfa_remember_browser: !!profile.nb.mfa_remember_browser,
                }));
                mfa = !!r && r.status < 300;
            } catch (e) {
                console.error('[MSP] seed NetBird MFA -> %s:', id, e.message);
            }
        }
    }
    // nbUnsupported: profile settings this tenant's NetBird doesn't know yet (not written).
    return { rules, blocklist, retentionDays, nbSettings, mfa, copiedRules, copiedBlocklist, ...(nbUnsupported.length ? { nbUnsupported } : {}) };
}

// Content-wise drift of ONE tenant's config against the effective DEFAULTS PROFILE (main account
// context only - the SQL passes the tenant id explicitly rather than relying on tnt()). Shape is
// consumed verbatim by the Tenants drift view; the `main` field now carries the DEFAULT value (the
// frontend relabels that column "Default"). Filter rules + blocklist are normalized + sorted so
// ordering never counts as drift. Rows are GATED by the profile's flags: filterRules/builtinNoise/
// blocklist appear only when their copy flag is on (compared vs main's LIVE lists, the copy source);
// retention compares vs the profile value; the nb.* rows compare the tenant's live settings vs the
// PROFILE's nb values, only when nb.enabled. The two webhook rows are unchanged (reference only).
async function computeTenantDrift(tenantId) {
    const id = String(tenantId || '').trim();
    if (!id) throw new Error('a tenant id is required');
    const profile = await effectiveTenantDefaults();

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const retLabel = d => d > 0 ? plural(d, 'day', 'days') : 'Keep Forever';
    const items = [];

    // Event filter rules + built-in noise: part of the defaults only when copyFilterRules is on. The
    // DEFAULT column is main's LIVE list (the copy source), compared order-independent.
    if (profile.copyFilterRules) {
        const normRules = rows => rows
            .map(r => ({ field: r.field, operator: r.operator, value: r.value, enabled: r.enabled !== false }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const mainRules = normRules((await pool.query(`SELECT field, operator, value, enabled FROM filter_rules WHERE tenant = ''`)).rows);
        const tenRules = normRules((await pool.query(`SELECT field, operator, value, enabled FROM filter_rules WHERE tenant = $1`, [id])).rows);
        const noiseVal = async key => {
            const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
            return r.rows[0] ? r.rows[0].value !== 'false' : true;
        };
        const mainNoise = await noiseVal('builtin_noise');
        const tenNoise = await noiseVal(`builtin_noise:${id}`);
        items.push({ key: 'filterRules', label: 'Event Filtering Rules', match: JSON.stringify(mainRules) === JSON.stringify(tenRules), main: plural(mainRules.length, 'rule', 'rules'), tenant: plural(tenRules.length, 'rule', 'rules') });
        items.push({ key: 'builtinNoise', label: 'Built-In Noise Filter', match: mainNoise === tenNoise, main: mainNoise ? 'On' : 'Off', tenant: tenNoise ? 'On' : 'Off' });
    }

    // Blocklist: only when copyBlocklist is on. DEFAULT is main's scope-'all' entries vs the tenant's,
    // comparing value + note/enforce/enabled/mode/max_prefix. Network-scoped entries are excluded (not
    // copyable) but counted for the label.
    if (profile.copyBlocklist) {
        const normBlock = rows => rows
            .filter(e => (e.scope || 'all') === 'all')
            .map(e => ({ value: e.value, note: e.note || '', enforce: e.enforce || 'none', enabled: e.enabled !== false, mode: e.mode || 'block', maxPrefix: e.max_prefix == null ? null : Number(e.max_prefix) }))
            .sort((a, b) => String(a.value).localeCompare(String(b.value)));
        const mainBlockRows = (await pool.query(`SELECT value, note, scope, enforce, enabled, mode, max_prefix FROM address_blocklist WHERE tenant = ''`)).rows;
        const tenBlockRows = (await pool.query(`SELECT value, note, scope, enforce, enabled, mode, max_prefix FROM address_blocklist WHERE tenant = $1`, [id])).rows;
        const mainScoped = mainBlockRows.length - mainBlockRows.filter(e => (e.scope || 'all') === 'all').length;
        const mainBlock = normBlock(mainBlockRows);
        const tenBlock = normBlock(tenBlockRows);
        items.push({ key: 'blocklist', label: 'Blocklist Entries', match: JSON.stringify(mainBlock) === JSON.stringify(tenBlock), main: `${plural(mainBlock.length, 'entry', 'entries')}${mainScoped ? ` (${mainScoped} network-scoped not compared)` : ''}`, tenant: plural(tenBlock.length, 'entry', 'entries') });
    }

    // Retention: the PROFILE value vs the tenant's keyed setting (0 = keep forever).
    const profRet = Math.min(3650, Math.max(0, Math.round(Number(profile.retentionDays) || 0)));
    const tenRetN = parseInt(await getSetting(`retention_days:${id}`).catch(() => ''), 10);
    const tenRet = Number.isFinite(tenRetN) && tenRetN > 0 ? Math.min(3650, tenRetN) : 0;
    items.push({ key: 'retentionDays', label: 'Data Retention', match: profRet === tenRet, main: retLabel(profRet), tenant: retLabel(tenRet) });

    // Webhook ingest tokens the tenant has set (main column is '-', match = tenant configured).
    const evTok = (await getSetting(`webhook_auth_token:${id}`).catch(() => '')) || '';
    const notifTok = (await getSetting(`webhook_notif_token:${id}`).catch(() => '')) || '';
    items.push({ key: 'webhookEvents', label: 'Activity Webhook Token', match: !!evTok, main: '-', tenant: evTok ? 'Configured' : 'Not Configured' });
    items.push({ key: 'webhookNotif', label: 'Notifications Webhook Token', match: !!notifTok, main: '-', tenant: notifTok ? 'Configured' : 'Not Configured' });

    // NetBird ACCOUNT settings drift: the PROFILE's nb values (DEFAULT column) vs the tenant's own
    // live settings (read inside its context). Only when nb.enabled. ONE granular row per setting, so
    // the report shows exactly WHICH setting differs. Labels are prefixed "NetBird: " so the generic
    // modal groups them AFTER the app-config rows. If the tenant read fails, a single "unreadable" row
    // stands in for the whole NetBird group.
    if (profile.nb && profile.nb.enabled) {
        const nb = profile.nb;
        let tenS = null, tenReadOk = false;
        try { tenS = await runWithTenant(id, () => getAccountSettings()); tenReadOk = !!tenS; }
        catch (e) { console.error('[MSP] drift NetBird settings read -> %s:', id, e.message); }
        if (!tenReadOk || !tenS) {
            items.push({ key: 'nb.settings', label: 'NetBird: Settings', match: false, main: '-', tenant: 'Unreadable' });
        } else {
            const tExtra = tenS.extra || {};
            const onOff = b => b ? 'On' : 'Off';
            // Duration from seconds → human "Xd" / "Xh" (whole units when they divide evenly, else hours).
            const fmtDur = secs => {
                const s = Math.max(0, Math.round(Number(secs) || 0));
                if (s <= 0) return '0';
                if (s % 86400 === 0) return `${s / 86400}d`;
                if (s % 3600 === 0) return `${s / 3600}h`;
                return `${Math.round(s / 3600)}h`;
            };
            const expVal = (en, secs) => en ? `On (${fmtDur(secs)})` : 'Off';
            const jwtVal = (en, claim, groups) => {
                if (!en) return 'Off';
                const n = Array.isArray(groups) ? groups.filter(g => typeof g === 'string' && g.trim()).length : 0;
                return `On (${claim || 'no claim'}, ${plural(n, 'group', 'groups')})`;
            };
            // Automatic Updates: 'disabled' → Disabled, 'latest' → Latest, else vX; + "Forced" when always-on.
            const updVal = (ver, forced) => {
                const v = typeof ver === 'string' ? ver.trim() : '';
                let label;
                if (!v || v === 'disabled') label = 'Disabled';
                else if (v === 'latest') label = 'Latest';
                else label = v.startsWith('v') ? v : `v${v}`;
                return forced ? `${label} (Forced)` : label;
            };
            const push = (key, label, defVal, tenVal) => items.push({ key, label: `NetBird: ${label}`, match: defVal === tenVal, main: defVal, tenant: tenVal });
            push('nb.peerApproval', 'Peer Approval', onOff(nb.peer_approval_enabled), onOff(tExtra.peer_approval_enabled));
            push('nb.userApprovalRequired', 'User Approval Required', onOff(nb.user_approval_required), onOff(tExtra.user_approval_required));
            // Cloud MFA lives on the dedicated per-account /api/service/mfa endpoint - read it in the
            // tenant context (netbirdGet resolves null on failure → "Unreadable value"). The whole
            // row is omitted when this API base doesn't serve the MFA route at all.
            if (await mfaSupported()) {
                let tenMfa = null;
                try { tenMfa = await runWithTenant(id, () => netbirdGet('/api/service/mfa')); }
                catch (e) { console.error('[MSP] drift NetBird MFA read -> %s:', id, e.message); }
                const mfaVal = (on, remember) => !on ? 'Off' : (remember ? 'On + Remember Browser' : 'On');
                push('nb.mfa', 'Multi-Factor Authentication',
                    mfaVal(nb.mfa_enabled, nb.mfa_remember_browser),
                    tenMfa ? mfaVal(!!tenMfa.mfa, !!tenMfa.mfa_remember_browser) : 'Unreadable value');
            }
            push('nb.peerLoginExpiration', 'Peer Session Expiration',
                expVal(nb.peer_login_expiration_enabled, nb.peer_login_expiration), expVal(tenS.peer_login_expiration_enabled, tenS.peer_login_expiration));
            push('nb.peerInactivityExpiration', 'Require Login After Disconnect',
                onOff(nb.peer_inactivity_expiration_enabled), onOff(tenS.peer_inactivity_expiration_enabled));
            push('nb.groupsPropagation', 'Groups Propagation', onOff(nb.groups_propagation_enabled), onOff(tenS.groups_propagation_enabled));
            push('nb.jwtGroups', 'JWT Group Sync',
                jwtVal(nb.jwt_groups_enabled, nb.jwt_groups_claim_name, nb.jwt_allow_groups),
                jwtVal(tenS.jwt_groups_enabled, tenS.jwt_groups_claim_name, tenS.jwt_allow_groups));
            push('nb.regularUsersViewBlocked', 'Restrict Regular Users', onOff(nb.regular_users_view_blocked), onOff(tenS.regular_users_view_blocked));
            // Infra rows appear ONLY when the profile deliberately sets them (compared vs the tenant's live value).
            if (nb.dns_domain) push('nb.dnsDomain', 'DNS Domain', nb.dns_domain, (typeof tenS.dns_domain === 'string' && tenS.dns_domain) || '-');
            if (nb.network_range) push('nb.networkRange', 'Network Range', nb.network_range, (typeof tenS.network_range === 'string' && tenS.network_range) || '-');
            if (nb.network_range_v6) push('nb.networkRangeV6', 'IPv6 Network Range', nb.network_range_v6, (typeof tenS.network_range_v6 === 'string' && tenS.network_range_v6) || '-');
            // Row only when the profile forces IPv6 off - tenant side shows Disabled or its group count.
            if (nb.ipv6_disable) {
                const tg = Array.isArray(tenS.ipv6_enabled_groups) ? tenS.ipv6_enabled_groups.length : 0;
                push('nb.ipv6', 'IPv6', 'Disabled', tg ? `${tg} group${tg === 1 ? '' : 's'}` : 'Disabled');
            }
            push('nb.routingPeerDns', 'Routing Peer DNS Resolution', onOff(nb.routing_peer_dns_resolution_enabled), onOff(tenS.routing_peer_dns_resolution_enabled));
            push('nb.trafficLogs', 'Traffic Events', onOff(nb.network_traffic_logs_enabled), onOff(tExtra.network_traffic_logs_enabled));
            // Kernel counter is forced off when traffic events is off (official dependency) - compare the effective value.
            const effKernel = nb.network_traffic_logs_enabled ? !!nb.network_traffic_packet_counter_enabled : false;
            push('nb.trafficPacketCounter', 'Traffic Reporting (Kernel)', onOff(effKernel), onOff(tExtra.network_traffic_packet_counter_enabled));
            push('nb.autoUpdate', 'Automatic Updates', updVal(nb.auto_update_version, nb.auto_update_always), updVal(tenS.auto_update_version, tenS.auto_update_always));
            push('nb.peerExpose', 'Peer Expose', onOff(nb.peer_expose_enabled), onOff(tenS.peer_expose_enabled));
            push('nb.lazyConnections', 'Lazy Connections', onOff(nb.lazy_connection_enabled), onOff(tenS.lazy_connection_enabled));
            // Tri-state: no row unless the profile manages it. A tenant on a NetBird without the
            // setting can't be brought in line by Apply Defaults, so it reads Not Supported - not drift.
            if (typeof nb.peer_hostname_collision_rejected === 'boolean') {
                const sup = typeof tenS.peer_hostname_collision_rejected === 'boolean';
                items.push({
                    key: 'nb.hostnameCollisions', label: 'NetBird: Reject Hostname Collisions',
                    match: !sup || nb.peer_hostname_collision_rejected === tenS.peer_hostname_collision_rejected,
                    main: onOff(nb.peer_hostname_collision_rejected),
                    tenant: sup ? onOff(tenS.peer_hostname_collision_rejected) : 'Not Supported (needs NetBird v0.81+)',
                });
            }
        }
    }

    return { tenant: tenantNameOf(id), items };
}

// ── Managed tenant service users ──
// The PROVISIONING token (a USER token of an MSP admin who is in the tenants' permission
// groups) is used ONLY to create each tenant's own service user + token. Write-only.
async function setMspProvisioningToken(token) {
    const tok = String(token || '').trim();
    if (tok) await setSetting('msp_provisioning_token', tok);
    else await pool.query(`DELETE FROM app_settings WHERE key = 'msp_provisioning_token'`).catch(() => { });
    setMspProvisioningTokenInMemory(tok);
    return { hasProvisioningToken: !!tok };
}

// Create (or reuse) a service user named like the APP inside the tenant, issue it a fresh
// 365-day token, delete its older tokens, and store the token for routine tenant calls.
// Idempotent - also serves rotation. Runs with the provisioning token + ?account=.
async function provisionTenantServiceUser(tenantId) {
    const id = String(tenantId || '').trim();
    if (!id) throw new Error('a tenant id is required');
    const prov = getMspProvisioningToken();
    if (!prov) throw new Error('No MSP provisioning token is configured (Settings - NetBird API).');
    const appName = (await getSetting('app_name').catch(() => null)) || 'NetBird Control';
    return await runWithTenant(id, async () => {
        // Reuse an existing service user with the app's name, else create one.
        const users = await netbirdGet('/api/users?service_user=true');
        let su = (Array.isArray(users) ? users : []).find(u => u && u.is_service_user && (u.name || '') === appName);
        if (!su) {
            const r = await netbirdPost('/api/users', { name: appName, role: 'admin', is_service_user: true, auto_groups: [] });
            if (!r || r.status >= 300 || !r.body || !r.body.id) {
                throw new Error('Failed to create the tenant service user: ' + (r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)));
            }
            su = r.body;
        }
        // Fresh token first, then prune the older ones - a failed prune never strands us.
        const tr = await netbirdPost(`/api/users/${encodeURIComponent(su.id)}/tokens`, { name: `${appName} token`, expires_in: 365 });
        const plain = tr && tr.body && (tr.body.plain_token || (tr.body.personal_access_token && tr.body.plain_token));
        const newTokenId = tr && tr.body && ((tr.body.personal_access_token && tr.body.personal_access_token.id) || tr.body.id);
        if (!tr || tr.status >= 300 || !plain) {
            throw new Error('Failed to issue the tenant token: ' + (tr && ((tr.body && (tr.body.message || tr.body.error)) || tr.raw || tr.error || tr.status)));
        }
        const olds = await netbirdGet(`/api/users/${encodeURIComponent(su.id)}/tokens`);
        for (const t of (Array.isArray(olds) ? olds : [])) {
            if (t && t.id && t.id !== newTokenId) {
                await netbirdReq('DELETE', `/api/users/${encodeURIComponent(su.id)}/tokens/${encodeURIComponent(t.id)}`).catch(() => { });
            }
        }
        const expiresAt = new Date(Date.now() + 365 * 86400_000).toISOString();
        await setMspTenantToken(id, plain);
        await setSetting(`msp_tenant_su:${id}`, JSON.stringify({ userId: su.id, name: appName, rotatedAt: new Date().toISOString(), expiresAt }));
        return { serviceUser: appName, userId: su.id, expiresAt };
    }, { authToken: prov });
}

// Scheduler: rotate tenant tokens that are within 30 days of their 365-day expiry.
// Silent when there is nothing to do; throws when rotation is DUE but impossible
// (missing provisioning token / API failure) so tracked() raises the 3-strikes alert.
async function rotateTenantTokens() {
    const r = await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'msp_tenant_su:%'`).catch(() => ({ rows: [] }));
    const due = [];
    for (const row of r.rows) {
        try {
            const meta = JSON.parse(row.value);
            if (meta && meta.expiresAt && new Date(meta.expiresAt).getTime() < Date.now() + 30 * 86400_000) {
                due.push(row.key.slice('msp_tenant_su:'.length));
            }
        } catch { /* unreadable metadata - re-provisioning will rewrite it */ }
    }
    if (!due.length) return { rotated: 0 };
    const errors = [];
    for (const id of due) {
        try { await provisionTenantServiceUser(id); }
        catch (e) { errors.push(`${id}: ${e.message}`); }
    }
    if (errors.length) throw new Error(`Tenant token rotation failed for ${errors.length}/${due.length}: ${errors[0]}`);
    return { rotated: due.length };
}

// Save (or clear, with an empty token) a per-tenant API token - a PAT created INSIDE the
// tenant account. Registered in memory under the tenant record id AND its switcher/account
// ids, so whichever id form the switch context carries resolves to the token. Write-only:
// the token is never returned to the browser (only hasApiToken).
async function setMspTenantToken(tenantId, token) {
    const id = String(tenantId || '').trim();
    if (!id) throw new Error('a tenant id is required');
    const tok = String(token || '').trim();
    const sw = await listMspSwitcher().catch(() => []);
    const match = sw.find(s => s.id === id || s.accountId === id);
    const ids = [id, match && match.id, match && match.accountId].filter(Boolean);
    if (tok) await setSetting(`msp_tenant_token:${id}`, tok);
    else await pool.query(`DELETE FROM app_settings WHERE key = $1`, [`msp_tenant_token:${id}`]).catch(() => { });
    setTenantTokenInMemory(ids, tok || null);
    return { hasApiToken: !!tok };
}

// A tenant's incoming-webhook tokens are now set via the normal Settings → Webhook page while
// managing that tenant (per-account keys webhook_auth_token:<id> / webhook_notif_token:<id>),
// and its NetBird posts to /api/webhook/t/<id> (the id in the URL selects the account). The old
// standalone per-tenant webhook-token map (webhook_token:<id>) has been retired.

async function createMspTenant({ name, domain, groups }, setup) {
    const body = {
        name: String(name || '').trim(),
        domain: String(domain || '').trim().toLowerCase(),
        groups: (Array.isArray(groups) ? groups : []).filter(g => g && g.id && g.role).map(g => ({ id: g.id, role: g.role })),
    };
    if (!body.name) throw new Error('a tenant name is required');
    if (!DOMAIN_RE.test(body.domain)) throw new Error('a valid tenant domain is required (e.g. customer.com)');
    // Optional initial-setup toggles from the Add Tenant modal. Defaults REPLICATE today's behavior:
    // seed + provision on, notifications on (new one-click step, run by the route AFTER this returns),
    // events OFF (needs a Business plan). Coerce to booleans so an absent/garbage `setup` still runs
    // the historic path. The two webhook steps live in the route (they need BASE_URL); here we only
    // gate provision + seed.
    const s = setup || {};
    const doProvision = s.provision !== false;
    const doSeed = s.seed !== false;
    const r = await netbirdPost('/api/integrations/msp/tenants', body);
    if (!r || r.status >= 300 || !r.body || !r.body.id) {
        throw new Error('Failed to create tenant: ' + (r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)));
    }
    // Provision the tenant's managed service user + token FIRST (best-effort, awaited), so the
    // NetBird-account-settings step of seeding below has a tenant token to authenticate with. Order
    // matters: copyNbSettingsTo needs the tenant's own token (or, if provisioning fails, falls back to
    // main-token ?account= switching). A provisioning failure never blocks creation - the manual
    // Provision button remains and rotation retries. Only runs when an MSP provisioning token exists
    // AND the caller left "Create Managed Service User" checked (null = skipped, not attempted).
    let provisioned = null;
    if (doProvision && getMspProvisioningToken()) {
        provisioned = false;
        try { await provisionTenantServiceUser(r.body.id); provisioned = true; }
        catch (e) { console.error(`[MSP] auto-provision -> ${r.body.id}:`, e.message); }
    }
    // Seed MAIN's current config into the new tenant: filter rules, blocklist, retention (DB-only,
    // keyed by tenant id) AND the NetBird account settings (login expiration, peer approval, groups
    // propagation, ...) via the just-provisioned token. Best-effort: a seeding failure must NEVER fail
    // tenant creation - log it and leave the manual "Apply Defaults" button. Per-step within, an
    // nbSettings failure alone still returns the DB-config summary (see seedTenantDefaults). Skipped
    // entirely (seeded stays null) when the caller unchecked "Sync Settings From Defaults".
    let seeded = null;
    if (doSeed) {
        try {
            seeded = await seedTenantDefaults(r.body.id);
        } catch (e) {
            console.error(`[MSP] seed defaults -> ${r.body.id}:`, e.message);
        }
    }
    // The response carries the DNS challenge for the ownership TXT record. `provisioned`/`seeded`
    // feed the route's setup summary (null = not requested; the route fills notifications/events).
    return { id: r.body.id, status: r.body.status || '', dnsChallenge: r.body.dns_challenge || '', seeded, provisioned };
}

async function updateMspTenant(id, { name, groups }) {
    const body = {
        name: String(name || '').trim(),
        groups: (Array.isArray(groups) ? groups : []).filter(g => g && g.id && g.role).map(g => ({ id: g.id, role: g.role })),
    };
    if (!body.name) throw new Error('a tenant name is required');
    const r = await netbirdReq('PUT', `/api/integrations/msp/tenants/${encodeURIComponent(id)}`, body);
    if (!r || r.status >= 300) throw new Error('Failed to update tenant: ' + (r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)));
    return { ok: true };
}

async function deleteMspTenant(id) {
    const r = await netbirdReq('DELETE', `/api/integrations/msp/tenants/${encodeURIComponent(id)}`);
    if (!r || r.status >= 300) throw new Error('Failed to delete tenant: ' + (r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)));
    return { ok: true };
}

// Domain ownership verification. Success = verified; failure carries the dns_challenge the
// customer must publish on the tenant domain as a TXT record: `nb-verification=<challenge>`.
async function verifyMspTenantDomain(id) {
    const r = await netbirdPost(`/api/integrations/msp/tenants/${encodeURIComponent(id)}/dns`, {});
    if (r && r.status < 300) return { verified: true };
    const challenge = (r && r.body && r.body.dns_challenge) || '';
    if (challenge) return { verified: false, dnsChallenge: challenge };
    throw new Error('Verification failed: ' + (r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)));
}

// Per-tenant usage + subscription for the Overview drawer. Fetched IN the tenant's context (its
// own PAT) - a bare ?account= with the main token is silently ignored when the main service user
// can't switch, returning MAIN's numbers. Null when the tenant has no working context.
async function getMspTenantOverview(id) {
    if (!(await tenantContextSafe(id))) return { usage: null, subscription: null };
    const [usage, sub] = await runWithTenant(id, () => Promise.all([
        netbirdGet('/api/integrations/billing/usage').catch(() => null),
        netbirdGet('/api/integrations/billing/subscription').catch(() => null),
    ]));
    return {
        usage: usage && typeof usage === 'object' && !Array.isArray(usage) && ('active_peers' in usage || 'active_users' in usage) ? {
            activeUsers: Number(usage.active_users) || 0, totalUsers: Number(usage.total_users) || 0,
            activePeers: Number(usage.active_peers) || 0, totalPeers: Number(usage.total_peers) || 0,
        } : null,
        subscription: sub && typeof sub === 'object' && !Array.isArray(sub) && 'plan_tier' in sub ? {
            active: !!sub.active, planTier: sub.plan_tier || '', remainingTrialSec: Number(sub.remaining_trial) || 0,
        } : null,
    };
}

// ─── MSP billing: the plan catalog + REAL per-tenant subscription changes ───
// The catalog is a MAIN-account resource and identical for every tenant, so it is cached
// module-wide for 10 minutes like the other NetBird catalogs. Currency mirrors the official
// BillingProvider: the MAIN account's own ACTIVE subscription currency, else 'usd'. NetBird
// returns prices in minor units (cents) - converted here so the UI never divides.
const MSP_PLANS_TTL_MS = 10 * 60_000;
let _mspPlans = { at: 0, data: null };
async function getMspBillingPlans() {
    if (_mspPlans.data && Date.now() - _mspPlans.at < MSP_PLANS_TTL_MS) return _mspPlans.data;
    const [raw, sub] = await Promise.all([
        netbirdGet('/api/integrations/billing/plans'),
        netbirdGet('/api/integrations/billing/subscription').catch(() => null),
    ]);
    if (!Array.isArray(raw)) throw new Error('NetBird did not return a billing plan list');
    const currency = (sub && typeof sub === 'object' && !Array.isArray(sub) && sub.active
        && typeof sub.currency === 'string' && sub.currency.trim()) || 'usd';
    // Only the two upgradeable tiers are offered, exactly like the official plan tab (Free has
    // nothing to buy, Enterprise is sales-led).
    const plans = [];
    for (const p of raw) {
        const name = String((p && p.name) || '').trim();
        const tier = /business/i.test(name) ? 'business' : /team/i.test(name) ? 'team' : '';
        if (!tier) continue;
        const price = (Array.isArray(p.prices) ? p.prices : []).find(x => x && x.currency === currency) || null;
        const amount = price && Number(price.price);
        plans.push({
            name, tier,
            // null = this plan has no price in the active currency; the UI shows it without an amount.
            priceMonthly: Number.isFinite(amount) ? amount / 100 : null,
            priceId: String((price && price.price_id) || ''),
            description: String((p && p.description) || ''),
            features: Array.isArray(p.features) ? p.features.filter(f => typeof f === 'string') : [],
        });
    }
    plans.sort((a, b) => (a.tier === 'team' ? 0 : 1) - (b.tier === 'team' ? 0 : 1));
    const out = { currency, plans };
    _mspPlans = { at: Date.now(), data: out };
    return out;
}

// Subscribe ONE tenant to a paid plan. THIS CHARGES MONEY - the plan is billed to the MSP account.
// Which verb NetBird expects depends on the tenant's CURRENT tier (official TenantsProvider
// updateSubscription): free/trial → POST (the initial MSP subscription), anything else → PUT (update
// the existing one). That tier is read in the TENANT's context (its own PAT); a bare ?account= with
// the main token is silently ignored when the switch is not honored, which would read MAIN's tier and
// pick the wrong verb. The write itself is an MSP endpoint and therefore runs against MAIN.
// The priceId is validated against the catalog first - a real billing call must never be made with
// an id the MSP's own plan list does not know.
async function setMspTenantSubscription(id, priceId) {
    const tenantId = String(id || '').trim();
    const price = String(priceId || '').trim();
    if (!tenantId) throw new Error('Tenant id is required');
    if (!price) throw new Error('A plan price is required');
    const catalog = await getMspBillingPlans();
    const plan = catalog.plans.find(p => p.priceId && p.priceId === price);
    if (!plan) throw new Error('Unknown plan price - reload the plan list and try again');
    if (!(await tenantContextSafe(tenantId))) {
        throw new Error('No working context for this tenant - provision its service user first');
    }
    const sub = await runWithTenant(tenantId, () => netbirdGet('/api/integrations/billing/subscription'));
    if (!sub || typeof sub !== 'object' || Array.isArray(sub) || !('plan_tier' in sub)) {
        throw new Error('Could not read the current subscription of this tenant');
    }
    // '' (unknown) counts as free, like the official useTenantSubscription mapping.
    const previousTier = String(sub.plan_tier || '').toLowerCase();
    const isOnFreeOrTrial = previousTier === '' || previousTier === 'free' || previousTier === 'trial';
    const path = `/api/integrations/msp/tenants/${encodeURIComponent(tenantId)}/subscription`;
    const r = isOnFreeOrTrial ? await netbirdPost(path, { priceID: price }) : await netbirdPut(path, { priceID: price });
    if (!r || !r.status || r.status >= 300) {
        throw new Error((r && ((r.body && (r.body.message || r.body.error)) || r.error || r.raw)) || 'Subscription change failed');
    }
    return {
        // NetBird's own body when it returned one, else a plain acknowledgement.
        body: r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : { ok: true },
        plan: plan.name, tier: plan.tier, previousTier, method: isOnFreeOrTrial ? 'POST' : 'PUT',
    };
}

// Distinct users seen in the stored proxy logs - feeds the page's user dropdown.
async function getProxyLogUsers() {
    const r = await pool.query(
        `SELECT user_id, MAX(user_name) AS user_name FROM proxy_access_logs WHERE tenant = $1 AND user_id <> '' GROUP BY user_id ORDER BY MAX(user_name)`,
        [tnt()]
    );
    return r.rows.map(x => ({ user_id: x.user_id, display_name: x.user_name || '', email: '' }));
}

// Shared WHERE builder for the proxy-log queries (detailed list + service summary) - both
// views honor the exact same filters.
function buildProxyLogConds(q = {}) {
    const conds = [], params = [];
    let i = 1;
    // Always scope to the active account (main '' or tenant) - every consumer inherits this.
    conds.push(`tenant = $${i}`); params.push(tnt()); i++;
    const search = String(q.search || '').trim();
    if (search) {
        conds.push(`(host ILIKE $${i} OR path ILIKE $${i} OR source_ip ILIKE $${i} OR user_name ILIKE $${i} OR service_name ILIKE $${i} OR method ILIKE $${i} OR reason ILIKE $${i} OR id ILIKE $${i})`);
        params.push(`%${search}%`); i++;
    }
    // Official-dashboard filters: success = 2xx/3xx, failed = everything else.
    if (q.status === 'success') conds.push(`status_code BETWEEN 200 AND 399`);
    else if (q.status === 'failed') conds.push(`(status_code < 200 OR status_code >= 400)`);
    const method = String(q.method || '').trim().toUpperCase();
    if (/^[A-Z]{3,8}$/.test(method)) { conds.push(`UPPER(method) = $${i}`); params.push(method); i++; }
    const user = String(q.user || '').trim();
    if (user) { conds.push(`(user_name ILIKE $${i} OR user_id ILIKE $${i})`); params.push(`%${user}%`); i++; }
    // Exact user (the toolbar's user dropdown, like the Activity page).
    const userId = String(q.user_id || '').trim();
    if (userId) { conds.push(`user_id = $${i}`); params.push(userId); i++; }
    // Anonymous-only (a summary pair with no user expands to just the unauthenticated requests).
    if (q.user_empty === '1' || q.user_empty === true) conds.push(`user_id = ''`);
    // Exact service (a summary pair's expanded request list).
    const serviceId = String(q.service_id || '').trim();
    if (serviceId) { conds.push(`service_id = $${i}`); params.push(serviceId); i++; }
    const location = String(q.location || '').trim();
    if (location) { conds.push(`(source_ip ILIKE $${i} OR city_name ILIKE $${i} OR country_code ILIKE $${i})`); params.push(`%${location}%`); i++; }
    if (q.from) { conds.push(`timestamp >= $${i}`); params.push(q.from); i++; }
    if (q.to) { conds.push(`timestamp <= $${i}`); params.push(q.to); i++; }
    return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params, i };
}

// Serve the LOCAL history (search + paging in Postgres). `available: false` only when the
// account has no reverse-proxy feature AND nothing was ever stored.
async function getProxyAccessLogs(q = {}) {
    // First page view before the scheduler's first tick: kick a sync in the background.
    if (proxyLogsStatus().at === null) syncProxyAccessLogs().catch(() => { });
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(q.per_page, 10) || 50));
    const { where, params, i } = buildProxyLogConds(q);
    // CAPPED count - see cappedCount() in lib/core.js.
    const { total, totalCapped } = await cappedCount(`SELECT 1 FROM proxy_access_logs ${where}`, params);
    const rows = await pool.query(
        `SELECT * FROM proxy_access_logs ${where} ORDER BY timestamp DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...params, perPage, (page - 1) * perPage]
    );
    const anyStored = total > 0 || (await pool.query('SELECT 1 FROM proxy_access_logs WHERE tenant = $1 LIMIT 1', [tnt()])).rowCount > 0;
    return {
        available: anyStored || proxyLogsStatus().available !== false,
        storedLocally: true,
        lastSync: proxyLogsStatus().at,
        logs: rows.rows.map(r => ({
            id: r.id, timestamp: r.timestamp, service_id: r.service_id, serviceName: r.service_name,
            protocol: r.protocol, method: r.method, host: r.host, path: r.path,
            duration_ms: Number(r.duration_ms) || 0, status_code: r.status_code,
            source_ip: r.source_ip, reason: r.reason, user_id: r.user_id, userName: r.user_name,
            auth_method_used: r.auth_method, country_code: r.country_code, city_name: r.city_name,
            bytes_upload: Number(r.bytes_upload) || 0, bytes_download: Number(r.bytes_download) || 0,
            metadata: r.metadata || undefined,
        })),
        page, per_page: perPage, total, totalCapped,
        total_pages: Math.max(1, Math.ceil(total / perPage) || 1),
    };
}

// Summary view: the filtered access logs aggregated per SERVICE + USER pair - who uses
// which service, how much, and how successfully.
async function getProxyLogsSummary(q = {}) {
    const { where, params } = buildProxyLogConds(q);
    const r = await pool.query(
        `SELECT service_id,
                MAX(NULLIF(service_name, '')) AS service_name,
                user_id,
                MAX(NULLIF(user_name, '')) AS user_name,
                COUNT(*)::int AS requests,
                COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399)::int AS success,
                (COUNT(*) - COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399))::int AS failed,
                COUNT(DISTINCT NULLIF(source_ip, ''))::int AS sources,
                COALESCE(SUM(bytes_download), 0)::bigint AS bytes_download,
                COALESCE(SUM(bytes_upload), 0)::bigint AS bytes_upload,
                MIN(timestamp) AS first_seen,
                MAX(timestamp) AS last_seen
         FROM proxy_access_logs ${where}
         GROUP BY service_id, user_id
         ORDER BY requests DESC`,
        params
    );
    // Rows ingested before a service got its name (or whose service was renamed since) fall
    // back to the CURRENT inventory name; a deleted service keeps whatever was recorded.
    const status = await getReverseProxyStatus().catch(() => null);
    const svcName = new Map(((status && status.services) || []).map(s => [String(s.id), s.name]));
    return {
        rows: r.rows.map(x => ({
            serviceId: x.service_id || '',
            serviceName: x.service_name || svcName.get(String(x.service_id || '')) || x.service_id || 'Unknown Service',
            userId: x.user_id || '',
            userName: x.user_name || '',
            requests: x.requests, success: x.success, failed: x.failed,
            sources: x.sources,
            bytesDownload: Number(x.bytes_download) || 0,
            bytesUpload: Number(x.bytes_upload) || 0,
            firstSeen: x.first_seen, lastSeen: x.last_seen,
        })),
    };
}

// Per-service TOTALS (all stored history, no filters) - shown as statistics on each row of
// the Services tab.
async function getProxyServiceStats() {
    const r = await pool.query(
        `SELECT service_id,
                COUNT(*)::int AS requests,
                (COUNT(*) - COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399))::int AS failed,
                COUNT(DISTINCT NULLIF(user_id, ''))::int AS users,
                COALESCE(SUM(bytes_download), 0)::bigint AS bytes_download,
                COALESCE(SUM(bytes_upload), 0)::bigint AS bytes_upload,
                MAX(timestamp) AS last_seen
         FROM proxy_access_logs
         WHERE tenant = $1
         GROUP BY service_id`,
        [tnt()]
    );
    return r.rows.map(x => ({
        serviceId: x.service_id || '',
        requests: x.requests, failed: x.failed, users: x.users,
        bytesDownload: Number(x.bytes_download) || 0,
        bytesUpload: Number(x.bytes_upload) || 0,
        lastSeen: x.last_seen,
    }));
}

// Resolve opaque ids in a NetBird event's meta to NAMES for display - the admin-events page
// renders meta verbatim, so this is where service/group/network/peer/user ids get translated.
// A resolved id is DROPPED and replaced by its `<x>_name` key; unresolved ids stay visible.
async function enrichAdminEventMeta(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const out = await tgEnrichNbMeta(meta).catch(() => null);
    if (!out || typeof out !== 'object') return meta;
    const res = { ...out };
    for (const k of Object.keys(meta)) {
        if (!tgIsIdKey(k)) continue;
        const base = k.replace(/[_\s]?id$/i, '');
        const nameKey = base ? `${base}_name` : 'name';
        if (res[nameKey] && res[nameKey] !== res[k]) delete res[k];
    }
    return res;
}

// NetBird's user-scoped admin events ("group added to user", "group removed from user", …) put the
// AFFECTED user in the event's top-level target_id - NOT in meta - and frequently leave meta.user_name
// blank. When that happens, resolve target_id to a display name so the UI names WHO the change was
// about instead of showing an empty User field. DB-only and scoped to the CURRENT account (a tenant's
// affected user lives in the tenant's mirror); a deleted user falls back to the readable oauth tail.
async function fillAffectedUserName(meta, targetId) {
    if (!meta || typeof meta !== 'object' || !('user_name' in meta)) return meta;
    if (String(meta.user_name || '').trim()) return meta; // NetBird already named the user
    const id = String(targetId || '').trim();
    if (!id) return meta;
    const r = await pool.query(
        `SELECT display_name, email FROM users WHERE tenant = $2 AND user_id = $1`, [id, tnt()]
    ).catch(() => ({ rows: [] }));
    const u = r.rows[0];
    const name = (u && (u.display_name || u.email)) || (id.includes('|') ? id.split('|').pop() : '');
    return name ? { ...meta, user_name: name } : meta;
}

// 2-letter ISO country code → flag emoji (regional-indicator letters). '' for anything else.
function countryFlag(cc) {
    const s = String(cc || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(s)) return '';
    return String.fromCodePoint(...[...s].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}
let _regionNames;
function countryName(cc) {
    const s = String(cc || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(s)) return '';
    try {
        if (_regionNames === undefined) _regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
        return (_regionNames && _regionNames.of(s)) || s;
    } catch { return s; }
}
// Format a timestamp-ish value using the app's configured zone/format; raw string on failure.
async function tgFmtTime(v) {
    try { const d = new Date(v); if (!isNaN(d.getTime())) return await formatConfiguredDate(d); } catch { /* ignore */ }
    return String(v);
}

// Emoji + Title-Case label for a metadata field. Covers app-audit keys, the *_name fields that
// tgEnrichNbMeta resolves ids into, and NetBird event fields. Keys are looked up lower-cased;
// anything unmapped falls back to a humanized label with a • bullet. Shared by every message.
const TG_FIELD = {
    // identity / naming
    name: ['🔖', 'Name'], type: ['🏷', 'Type'], fqdn: ['🖥', 'Device'], ip: ['📍', 'IP'],
    email: ['✉️', 'Email'], username: ['👤', 'Username'], role: ['🔑', 'Role'], key: ['🔑', 'Key'],
    // resolved id → name
    resource_name: ['📦', 'Resource'], network_name: ['🌐', 'Network'], group_name: ['👥', 'Group'],
    peer_name: ['🖥', 'Peer'], policy_name: ['🛡️', 'Policy'], user_name: ['👤', 'User'], account_name: ['🏢', 'Account'],
    // temporary access / requests
    targets: ['🎯', 'Targets'], until: ['⏳', 'Until'], devices: ['💻', 'Devices'], trigger: ['⚡', 'Trigger'],
    reason: ['📝', 'Reason'], via: ['🔀', 'Via'], grant: ['🎟', 'Grant'], requested: ['⏱', 'Requested'], note: ['📝', 'Note'],
    // settings / audit
    fields: ['✏️', 'Changed'], count: ['🔢', 'Count'], groups: ['👥', 'Groups'], tgapprovers: ['👮', 'Telegram approvers'],
};
// Keys whose value is a timestamp (formatted to the app's zone). Covers named + suffixed keys.
const TG_TIME_KEYS = new Set(['until', 'expires', 'expires_at', 'created_at', 'updated_at', 'timestamp', 'time', 'date']);
const isTgTimeKey = (k) => TG_TIME_KEYS.has(String(k).toLowerCase()) || /(_at$|^timestamp$|_time$|date$)/i.test(k);

// Render metadata as a *designed* block: a single 🌍 Location line (city + region + country with
// its flag), a source-IP line, timestamps formatted to the app's zone, and every other field
// prefixed with a fitting emoji + Title-Case label. Opaque ids and geo noise are dropped.
async function tgFormatFields(meta) {
    const src = { ...(meta || {}) };
    const lines = [];

    // Location block: fold all location_* keys into one line with the country flag.
    const locKeys = Object.keys(src).filter(k => /^location[_\s]/i.test(k));
    if (locKeys.length) {
        const g = {};
        for (const k of locKeys) { g[k.replace(/^location[_\s]/i, '').toLowerCase()] = src[k]; delete src[k]; }
        const cc = g.country_code;
        const flag = countryFlag(cc);
        const parts = [g.city_name, g.region_name, cc ? (countryName(cc) || cc) : ''].filter(Boolean);
        const loc = `${flag ? flag + ' ' : ''}${parts.join(', ')}`.trim();
        if (loc) lines.push(`🌍 <b>Location:</b> ${tgEsc(loc)}`);
        if (g.connection_ip) lines.push(`🌐 <b>Source IP:</b> ${tgEsc(String(g.connection_ip))}`);
        // geo_name_id and any other location_* noise are intentionally dropped.
    }

    const seen = new Set(); // label+value pairs already emitted (meta often carries the
    // same fact under two keys, e.g. group + group_name - one line is enough)
    for (const [k, v] of Object.entries(src)) {
        if (v === false || v === '' || v == null) continue;
        if (typeof v === 'number' && v === 0) continue;
        if (tgIsIdKey(k)) continue; // leftover opaque ids
        const isTime = isTgTimeKey(k);
        const f = TG_FIELD[k.toLowerCase()];
        const emoji = f ? f[0] : (isTime ? '🕐' : '•');
        const label = f ? f[1] : (isTime ? 'Time' : tgHumanizeKey(k));
        let val;
        if (isTime) val = await tgFmtTime(v);
        else if (k === 'fields') val = String(v).split(',').map(x => tgHumanizeKey(x.trim())).filter(Boolean).join(', ');
        else val = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
        if (!val) continue;
        const sig = `${label}:${val}`.toLowerCase();
        if (seen.has(sig)) continue;
        seen.add(sig);
        lines.push(`${emoji} <b>${tgEsc(label)}:</b> ${tgEsc(val)}`);
    }
    return lines.join('\n');
}

// For network.* actions the target is a network id - resolve it to the network's name.
async function tgResolveTarget(action, target) {
    const t = String(target || '');
    if (t && action && action.startsWith('network.')) {
        try {
            const nets = await getNetworks();
            const n = Array.isArray(nets) && nets.find(x => x.id === t);
            if (n && n.name) return n.name;
        } catch { /* fall through to the raw value */ }
    }
    return t;
}

// App action (audit) → Telegram. Goes to the ACTING account's own Telegram (main or the tenant
// that made the change), and - for a TENANT change only - is ALSO mirrored to MAIN's Telegram
// (3.1) so the MSP admin sees tenant activity in their own channel. The mirror is gated on main
// being enabled AND main's `tenantActivity` flag (default on) AND main's own category being
// enabled; the main copy carries a ` [tenant]` title tag. The mirror NEVER falls back to the
// tenant's config, and it never happens for main's own changes. Only app-audit events mirror -
// NetBird/webhook event notifications go solely to the acting account's Telegram.
async function notifyAuditTelegram(entry) {
    if (!entry) return;
    // Access-request actions are notified via their own buttoned message + edits, not here.
    if (String(entry.action || '').startsWith('request.')) return;
    const cat = auditCategory(entry.action);
    const emoji = TG_CAT_EMOJI[cat] || '🔔';
    const actor = entry.actorName || entry.actorEmail || 'Someone';
    const target = await tgResolveTarget(entry.action, entry.target).catch(() => entry.target);
    let meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : null;
    if (meta && meta.tenant) meta = { ...meta, tenant: tenantNameOf(meta.tenant) };
    if (meta) meta = await tgEnrichNbMeta(meta).catch(() => meta);
    const m = meta ? await tgFormatFields(meta).catch(() => '') : '';
    // The body is account-independent; only the title's tenant tag + the routing topic differ.
    const mkHtml = (tag) => {
        let h = `${emoji} <b>${tgEsc(tgActionLabel(entry.action))}${tgEsc(tag)}</b>\n👤 ${tgEsc(actor)}`;
        if (target) h += `\n🎯 <b>Target:</b> ${tgEsc(target)}`;
        if (m) h += `\n${m}`;
        return h;
    };
    const acct = tnt();
    // 1. The acting account's OWN Telegram (unchanged flow): only if enabled AND the category is on.
    const own = getTelegramConfig();
    if (own.enabled) {
        const c = own.categories[cat];
        if (c && c.enabled) await sendTelegram(cat, mkHtml('')).catch(() => { });
    }
    // 2. MAIN mirror of TENANT activity - tenant context only, main's config + topics, tagged.
    if (acct) {
        const main = getTelegramConfig('');
        if (main.enabled && main.tenantActivity !== false) {
            const mc = main.categories[cat];
            if (mc && mc.enabled) await sendTelegram(cat, mkHtml(tenantTag()), { account: '' }).catch(() => { });
        }
    }
}

// NetBird activity event → Telegram, if its type was selected.
async function notifyNetbirdTelegram(payload) {
    const msg = (payload && payload.Message) || '';
    // _telegram state now lives in lib/telegram.js; read it through getTelegramConfig().
    const tg = getTelegramConfig();
    if (!tg.enabled || !msg) return;
    if (!Array.isArray(tg.netbirdEvents) || !tg.netbirdEvents.includes(msg)) return;
    const cat = netbirdSubcategory(msg);
    const emoji = TG_CAT_EMOJI[cat] || '🔔';
    let html = `${emoji} <b>${tgEsc(msg.charAt(0).toUpperCase() + msg.slice(1))}</b>`;
    const who = await tgResolveInitiator(payload.InitiatorID).catch(() => '');
    if (who) html += `\n👤 <b>By:</b> ${tgEsc(who)}`;
    // Resolve opaque ids to names, then render a designed block (flags, emoji fields, formatted
    // times, one location line) instead of a raw wall of hashes.
    let meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : null;
    if (meta) meta = await tgEnrichNbMeta(meta).catch(() => meta);
    const m = meta ? await tgFormatFields(meta).catch(() => '') : '';
    // Name the event's TARGET - who/what it happened TO (the line above says who DID it).
    // Skipped when the meta lines already carry the same name.
    const tgtId = String(payload.target_id || '');
    if (tgtId && tgtId !== String(payload.InitiatorID || '')) {
        const t = await tgResolveAnyId(tgtId).catch(() => null);
        if (t && t.name && !(m && m.toLowerCase().includes(tgEsc(t.name).toLowerCase()))) {
            html += `\n🎯 <b>${tgEsc(t.label)}:</b> ${tgEsc(t.name)}`;
        }
    }
    if (m) html += `\n${m}`;
    return sendTelegram(cat, html);
}

// Latest "billing usage updated" NetBird event → the account's current billed-users count
// (NetBird Cloud reports it daily; we already store the event, so no extra API calls).
// Cached event-driven, not by TTL: the value only changes when a new billing event is
// ingested, and addAdminEvent busts this cache the moment one arrives - so the dashboard is
// fresh within seconds of the daily report without rescanning admin_events every load.
// Keyed per account (tnt()) - in a tenant context the cache must not serve MAIN's value.
const _billingCache = new Map(); // account id → { billedUsers, at }
async function getBillingSummary() {
    const key = tnt();
    const cached = _billingCache.get(key);
    if (cached) return cached;
    const r = await pool.query(
        `SELECT timestamp, meta FROM admin_events
         WHERE tenant = $1 AND LOWER(message) LIKE 'billing%' ORDER BY timestamp DESC LIMIT 1`,
        [key]
    ).catch(() => ({ rows: [] }));
    if (!r.rows.length) return { billedUsers: null, at: null }; // not cached - a first event may still arrive
    const meta = r.rows[0].meta || {};
    const n = parseInt(meta.billed_users ?? meta.billedUsers ?? meta.users, 10);
    const summary = { billedUsers: Number.isFinite(n) ? n : null, at: r.rows[0].timestamp };
    _billingCache.set(key, summary);
    return summary;
}

// Distinct NetBird activity types seen (drives the event-selection checklist in the UI).
async function getAdminEventTypes() {
    const r = await pool.query(
        `SELECT message, COUNT(*)::int AS count FROM admin_events WHERE tenant = $1 AND message <> '' GROUP BY message ORDER BY count DESC, message LIMIT 200`,
        [tnt()]
    );
    return r.rows.map(row => ({ ...row, category: netbirdSubcategory(row.message) }));
}

// telegramTest and telegramCreateTopics now live in lib/telegram.js (imported at the top).

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        message TEXT NOT NULL,
        initiator_id TEXT DEFAULT '',
        target_id TEXT DEFAULT '',
        flow_id TEXT DEFAULT '',
        protocol INTEGER DEFAULT 0,
        direction TEXT DEFAULT '',
        source_addr TEXT DEFAULT '',
        source_name TEXT DEFAULT '',
        source_dns_label TEXT DEFAULT '',
        source_id TEXT DEFAULT '',
        source_type TEXT DEFAULT '',
        source_geo_country TEXT DEFAULT '',
        source_geo_city TEXT DEFAULT '',
        destination_addr TEXT DEFAULT '',
        destination_name TEXT DEFAULT '',
        destination_dns_label TEXT DEFAULT '',
        destination_id TEXT DEFAULT '',
        destination_type TEXT DEFAULT '',
        destination_geo_country TEXT DEFAULT '',
        destination_geo_city TEXT DEFAULT '',
        policy_id TEXT DEFAULT '',
        policy_name TEXT DEFAULT '',
        icmp_type INTEGER DEFAULT 0,
        icmp_code INTEGER DEFAULT 0,
        rx_bytes BIGINT DEFAULT 0,
        rx_packets BIGINT DEFAULT 0,
        tx_bytes BIGINT DEFAULT 0,
        tx_packets BIGINT DEFAULT 0,
        user_id TEXT DEFAULT '',
        reporter_id TEXT DEFAULT '',
        reference TEXT DEFAULT '',
        raw_json JSONB,
        received_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Create users table for identity cache
        await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        uuid TEXT DEFAULT '',
        display_name TEXT DEFAULT '',
        email TEXT DEFAULT '',
        raw_json JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Peers cache (router name resolution from NetBird Management API)
        await client.query(`
      CREATE TABLE IF NOT EXISTS peers (
        peer_id TEXT PRIMARY KEY,
        name TEXT DEFAULT '',
        dns_label TEXT DEFAULT '',
        ip TEXT DEFAULT '',
        raw_json JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Per-network edit permissions: which AD group (object id) may edit a network
        await client.query(`
      CREATE TABLE IF NOT EXISTS network_grants (
        network_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (network_id, group_id)
      );
    `);
        // access level per grant: 'edit' (default, can manage) or 'view' (read-only).
        await client.query(`ALTER TABLE network_grants ADD COLUMN IF NOT EXISTS access TEXT DEFAULT 'edit'`);
        // Whether an 'edit' grant is also auto-added as a SOURCE of new policies created in the
        // network (TRUE = legacy behavior). Lets a group manage the network without its members
        // being granted access by every new policy.
        await client.query(`ALTER TABLE network_grants ADD COLUMN IF NOT EXISTS policy_source BOOLEAN DEFAULT TRUE`);

        // Per-network default Access Profile(s): shared profiles pre-selected when
        // adding a resource to the network.
        await client.query(`
      CREATE TABLE IF NOT EXISTS network_default_profiles (
        network_id TEXT NOT NULL,
        profile_id INTEGER NOT NULL,
        PRIMARY KEY (network_id, profile_id)
      );
    `);

        // Admin-defined resource templates (port/protocol presets for new clients)
        await client.query(`
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'all',
        ports TEXT DEFAULT '',
        description TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Event filtering rules (which webhook traffic events are discarded). Replaces
        // the old FILTER_ADDR_PATTERNS env var; managed in the app's Settings.
        await client.query(`
      CREATE TABLE IF NOT EXISTS filter_rules (
        id SERIAL PRIMARY KEY,
        field TEXT NOT NULL,
        operator TEXT NOT NULL DEFAULT 'contains',
        value TEXT NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Simple key/value app settings (e.g. the built-in noise toggle)
        await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

        // Audit log of every change made THROUGH this app (who did what, via the API).
        await client.query(`
      CREATE TABLE IF NOT EXISTS app_audit (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        actor_id TEXT DEFAULT '',
        actor_email TEXT DEFAULT '',
        actor_name TEXT DEFAULT '',
        action TEXT NOT NULL,
        target TEXT DEFAULT '',
        meta JSONB
      );
    `);
        // (The app_audit time index is now the composite idx_app_audit_tenant_ts, built post-boot by
        // ensureLogIndexes() - every audit read filters tenant first. The old plain
        // idx_app_audit_ts is dropped there once the composite is in place.)

        // Recurring access rules: a standing schedule (weekdays + daily window, app time zone)
        // that spawns a normal temporary grant at each window start - the grant then expires at
        // the window end via the regular grant scheduler. last_spawn_key prevents double-spawns.
        await client.query(`
      CREATE TABLE IF NOT EXISTS recurring_access (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_label TEXT NOT NULL DEFAULT '',
        user_email TEXT NOT NULL DEFAULT '',
        targets JSONB NOT NULL DEFAULT '[]'::jsonb,
        days JSONB NOT NULL DEFAULT '[]'::jsonb,
        start_time TEXT NOT NULL DEFAULT '09:00',
        end_time TEXT NOT NULL DEFAULT '17:00',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        last_spawn_key TEXT NOT NULL DEFAULT '',
        active_grant_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
        // Optional end date (YYYY-MM-DD, app time zone, inclusive) - past it the rule stops
        // activating and is auto-disabled by the scheduler. Empty = no end date.
        await client.query(`ALTER TABLE recurring_access ADD COLUMN IF NOT EXISTS valid_until TEXT NOT NULL DEFAULT ''`);

        // Scheduled expiry of device compliance bypasses (EDR). A row = "revoke this peer's
        // bypass at expires_at" - the 60s scheduler does the revoke. Unlimited bypasses simply
        // have no row. Cleared on manual revoke too.
        await client.query(`
      CREATE TABLE IF NOT EXISTS bypass_expirations (
        peer_id TEXT PRIMARY KEY,
        peer_name TEXT NOT NULL DEFAULT '',
        requester_email TEXT NOT NULL DEFAULT '',
        requester_name TEXT NOT NULL DEFAULT '',
        request_id INTEGER,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
        // Temporary device: on expiry the scheduler DELETES the peer instead of only
        // revoking the bypass (set when approving a temp-device bypass request).
        await client.query(`ALTER TABLE bypass_expirations ADD COLUMN IF NOT EXISTS delete_peer BOOLEAN DEFAULT false`);


        // Operational metadata on devices - free-form tags + a note ("client X's server",
        // "loaner laptop"). App-only; NetBird has no field for this.
        await client.query(`
      CREATE TABLE IF NOT EXISTS peer_meta (
        peer_id TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT '',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

        // Access recertification: a round = one periodic review; an item = one piece of
        // STANDING access snapshotted when the round opened, awaiting keep/revoke.
        await client.query(`
      CREATE TABLE IF NOT EXISTS recert_rounds (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        due_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        reminded_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'open'
      );
    `);
        await client.query(`
      CREATE TABLE IF NOT EXISTS recert_items (
        id SERIAL PRIMARY KEY,
        round_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL DEFAULT '',
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT NOT NULL DEFAULT '',
        decided_at TIMESTAMPTZ
      );
    `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_recert_items_round ON recert_items(round_id, status)');

        // Access Profiles - a named {source groups + protocol/ports} bundle backed by
        // one NetBird group + one policy. Resources assigned to the profile join its
        // group and inherit the shared policy.
        await client.query(`
      CREATE TABLE IF NOT EXISTS access_profiles (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        group_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        sources JSONB,
        protocol TEXT DEFAULT 'all',
        ports TEXT DEFAULT '',
        shared BOOLEAN NOT NULL DEFAULT TRUE,
        posture_checks JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
        // 'shared' distinguishes group-backed profiles (group + policy) from Direct
        // presets (protocol/ports only). Added for installs created before the merge.
        await client.query(`ALTER TABLE access_profiles ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT TRUE`);
        // Posture check ids attached to a shared profile's policy (source_posture_checks).
        await client.query(`ALTER TABLE access_profiles ADD COLUMN IF NOT EXISTS posture_checks JSONB DEFAULT '[]'::jsonb`);

        // Automations - external HTTP source → auto-provisioned NetBird resources.
        await client.query(`
      CREATE TABLE IF NOT EXISTS automations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        endpoint_url TEXT NOT NULL DEFAULT '',
        auth_type TEXT DEFAULT 'none',
        auth_header TEXT DEFAULT '',
        auth_secret TEXT DEFAULT '',
        source_format TEXT DEFAULT 'json',
        name_prefix TEXT DEFAULT '',
        items_path TEXT DEFAULT '',
        address_field TEXT DEFAULT '',
        name_field TEXT DEFAULT '',
        description_field TEXT DEFAULT '',
        key_field TEXT DEFAULT '',
        network_id TEXT DEFAULT '',
        profile_ids JSONB DEFAULT '[]'::jsonb,
        interval_minutes INTEGER DEFAULT 60,
        removal_mode TEXT DEFAULT 'disable',
        min_items INTEGER DEFAULT 0,
        last_run_at TIMESTAMPTZ,
        last_status TEXT DEFAULT '',
        last_error TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
        // Resources WE created per automation - so re-sync only ever touches our own.
        await client.query(`
      CREATE TABLE IF NOT EXISTS automation_resources (
        automation_id INTEGER NOT NULL,
        external_key TEXT NOT NULL,
        address TEXT DEFAULT '',
        resource_id TEXT NOT NULL,
        network_id TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (automation_id, external_key)
      );
    `);
        // Per-run history for observability.
        await client.query(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        id SERIAL PRIMARY KEY,
        automation_id INTEGER NOT NULL,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status TEXT DEFAULT '',
        trigger TEXT DEFAULT 'schedule',
        created INTEGER DEFAULT 0,
        updated INTEGER DEFAULT 0,
        disabled INTEGER DEFAULT 0,
        skipped INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        error TEXT DEFAULT ''
      );
    `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_automation_runs_aid ON automation_runs(automation_id, started_at DESC)');
        // Collisions with non-managed resources (e.g. a manually-added IP / taken name).
        await client.query('ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS conflicts INTEGER DEFAULT 0');
        // Existing resources the automation adopted into management this run.
        await client.query('ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS adopted INTEGER DEFAULT 0');
        // Full per-item failure reasons for the run (diagnostics).
        await client.query(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS errors JSONB DEFAULT '[]'::jsonb`);
        // Safety floor: skip removals when the source returns fewer than this many items.
        await client.query('ALTER TABLE automations ADD COLUMN IF NOT EXISTS min_items INTEGER DEFAULT 0');
        // Source format: 'json' (field-mapped) or 'text' (one IP per line).
        await client.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS source_format TEXT DEFAULT 'json'`);
        // Optional name prefix for text imports (resource name = prefix + address).
        await client.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS name_prefix TEXT DEFAULT ''`);
        // Blocked items skipped this run because their address is on the blocklist.
        await client.query('ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS blocked INTEGER DEFAULT 0');

        // Address blocklist - IPs / CIDRs / domains that may NOT be added as resources
        // (enforced on manual create/edit and on automation imports).
        await client.query(`
      CREATE TABLE IF NOT EXISTS address_blocklist (
        id SERIAL PRIMARY KEY,
        value TEXT NOT NULL,
        note TEXT DEFAULT '',
        scope TEXT DEFAULT 'all',
        networks JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
        // Per-entry network scope: 'all' | 'only' (selected) | 'except' (all but selected).
        await client.query(`ALTER TABLE address_blocklist ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'all'`);
        await client.query(`ALTER TABLE address_blocklist ADD COLUMN IF NOT EXISTS networks JSONB DEFAULT '[]'::jsonb`);
        // Enforcement on EXISTING resources: 'none' (block new only) | 'disable' | 'delete'.
        await client.query(`ALTER TABLE address_blocklist ADD COLUMN IF NOT EXISTS enforce TEXT DEFAULT 'none'`);
        // Disabled entries stay on the list (with their scope/enforce config) but stop
        // blocking/enforcing anything - a pause switch instead of delete-and-retype.
        await client.query(`ALTER TABLE address_blocklist ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true`);
        // Entry mode: 'block' = nothing matching may be added (classic); 'limit' = inside
        // this range only CIDRs at least as narrow as max_prefix may be added - stops an
        // editor from adding 10.0.0.0/8 while hosts inside the range stay addable.
        await client.query(`ALTER TABLE address_blocklist ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'block'`);
        await client.query(`ALTER TABLE address_blocklist ADD COLUMN IF NOT EXISTS max_prefix INTEGER`);

        // Temporary access grants - a user gets time-boxed access to resources via a dedicated
        // group (holding their peers) + policy; the scheduler revokes both at expiry.
        await client.query(`
      CREATE TABLE IF NOT EXISTS temporary_access_grants (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_label TEXT DEFAULT '',
        group_id TEXT DEFAULT '',
        policy_ids JSONB DEFAULT '[]'::jsonb,
        targets JSONB DEFAULT '[]'::jsonb,
        note TEXT DEFAULT '',
        issued_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        status TEXT DEFAULT 'active',
        last_status TEXT DEFAULT '',
        last_error TEXT DEFAULT '',
        created_by TEXT DEFAULT '',
        revoked_by TEXT DEFAULT '',
        revoked_at TIMESTAMPTZ
      );
    `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_temp_grants_active ON temporary_access_grants(expires_at) WHERE status = \'active\'');
        // Groups the user was added to for this grant (target groups / profile sources / the
        // temp group) - removed from all of them on revoke. group_id is only the temp group WE
        // created (and therefore delete); '' when the grant is pure direct-membership.
        await client.query(`ALTER TABLE temporary_access_grants ADD COLUMN IF NOT EXISTS assigned_groups JSONB DEFAULT '[]'::jsonb`);
        // A grant to resources uses a dedicated destination group holding those resources (one
        // policy source→dest, instead of one policy per resource). dest_group_id is that group;
        // dest_resources are the resources we added to it (removed + group deleted on revoke).
        await client.query(`ALTER TABLE temporary_access_grants ADD COLUMN IF NOT EXISTS dest_group_id TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE temporary_access_grants ADD COLUMN IF NOT EXISTS dest_resources JSONB DEFAULT '[]'::jsonb`);
        // Recipient email captured at grant time, so the expiry/revoke email needs no live lookup.
        await client.query(`ALTER TABLE temporary_access_grants ADD COLUMN IF NOT EXISTS user_email TEXT DEFAULT ''`);
        // A grant may create SEVERAL destination groups - one per protocol/ports combo mirrored
        // from the targets' existing policies (dest_group_id keeps the first for legacy rows).
        await client.query(`ALTER TABLE temporary_access_grants ADD COLUMN IF NOT EXISTS dest_group_ids JSONB DEFAULT '[]'::jsonb`);

        // Access requests - a (usually non-admin) user asks for access; an admin approves it
        // (in-app or via Telegram buttons), which creates a temporary_access_grants row.
        await client.query(`
      CREATE TABLE IF NOT EXISTS access_requests (
        id SERIAL PRIMARY KEY,
        requester_id TEXT NOT NULL,
        requester_email TEXT DEFAULT '',
        requester_name TEXT DEFAULT '',
        targets JSONB DEFAULT '[]'::jsonb,
        reason TEXT DEFAULT '',
        requested_minutes INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        decided_by TEXT DEFAULT '',
        decided_at TIMESTAMPTZ,
        decision_note TEXT DEFAULT '',
        grant_id INTEGER,
        tg_chat_id TEXT DEFAULT '',
        tg_message_id TEXT DEFAULT ''
      );
    `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status, created_at DESC)');
        // Request kind: 'access' (temporary access to targets) or 'bypass' (approve/bypass the
        // requester's own non-compliant device via NetBird's EDR bypass).
        await client.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'access'`);
        // When the one-time "still pending" Telegram reminder was sent (NULL = not yet).
        await client.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ`);
        // Targets an approver toggled OFF via the Telegram keyboard before approving
        // ([{type,id,name}]). The approval grants targets MINUS these.
        await client.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS excluded_targets JSONB DEFAULT '[]'::jsonb`);
        // What was ACTUALLY granted (the approver may add/remove targets) - `targets` keeps the
        // original request; displays show this one for approved requests.
        await client.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS approved_targets JSONB`);
        // Bypass-request option: the device is TEMPORARY - when the approved bypass period
        // ends, the device itself is DELETED from NetBird (not just re-blocked).
        await client.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS temp_device BOOLEAN DEFAULT false`);
        // Bypass EXTENSION: the device already has a timed bypass and asks for more time.
        // Approval simply moves the scheduled expiry (same duration picker).
        await client.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS extend_bypass BOOLEAN DEFAULT false`);
        // What was ACTUALLY approved, in minutes (the approver may shorten/extend the ask).
        // NULL = not approved yet / legacy row; 0 = unlimited (device bypass without expiry).
        await client.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS approved_minutes INTEGER`);
        // HOW the decision was made: 'App' / 'Telegram' / 'Auto-approval' ('' on legacy rows).
        await client.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS decided_via TEXT DEFAULT ''`);

        // IP-assignment history: which peer/user held each NetBird IP, as time intervals.
        // Other systems only log the NetBird IP - this answers "who had 100.x.y.z on date D?".
        // An open row (released_at IS NULL) is the current holder; the row closes when the IP
        // moves to another peer/user or the peer disappears.
        await client.query(`
      CREATE TABLE IF NOT EXISTS ip_assignments (
        id SERIAL PRIMARY KEY,
        ip TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        peer_name TEXT DEFAULT '',
        dns_label TEXT DEFAULT '',
        user_id TEXT DEFAULT '',
        user_name TEXT DEFAULT '',
        user_email TEXT DEFAULT '',
        connection_ip TEXT DEFAULT '',
        region TEXT DEFAULT '',
        first_seen TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        released_at TIMESTAMPTZ
      );
    `);
        // Added after the first cut of the table, so ensure they exist on instances that ran the older DDL.
        await client.query(`ALTER TABLE ip_assignments ADD COLUMN IF NOT EXISTS dns_label TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE ip_assignments ADD COLUMN IF NOT EXISTS region TEXT DEFAULT ''`);
        // 2-letter country code (for the flag icon), alongside the human `region` string.
        await client.query(`ALTER TABLE ip_assignments ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT ''`);
        // Backfill the flag code for rows created before this column existed: `region` is stored
        // as "<CC>, <City>" (see syncIpAssignments), so its first token is the country code.
        // Idempotent - only fills empties.
        await client.query(`
            UPDATE ip_assignments
            SET country_code = upper(substring(region from '^[A-Za-z]{2}'))
            WHERE COALESCE(country_code, '') = '' AND region ~ '^[A-Za-z]{2}(,|$)'
        `).catch(e => console.error('[IP history] country backfill:', e.message));
        await client.query('CREATE INDEX IF NOT EXISTS idx_ip_assign_ip ON ip_assignments(ip, first_seen DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_ip_assign_open ON ip_assignments(ip) WHERE released_at IS NULL');

        // Admin / management events (numeric ID, no flow)
        await client.query(`
      CREATE TABLE IF NOT EXISTS admin_events (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        message TEXT NOT NULL,
        initiator_id TEXT DEFAULT '',
        target_id TEXT DEFAULT '',
        meta JSONB,
        reference TEXT DEFAULT '',
        raw_json JSONB,
        received_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Reverse-proxy access logs, INGESTED locally: NetBird Cloud only keeps them 7 days,
        // so a scheduler copies them here and the app's own Data Retention governs their life.
        // service_name / user_name are resolved AT INGEST so history survives renames/deletions.
        await pool.query(`
      CREATE TABLE IF NOT EXISTS proxy_access_logs (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        service_id TEXT DEFAULT '',
        service_name TEXT DEFAULT '',
        protocol TEXT DEFAULT '',
        method TEXT DEFAULT '',
        host TEXT DEFAULT '',
        path TEXT DEFAULT '',
        duration_ms BIGINT DEFAULT 0,
        status_code INT DEFAULT 0,
        source_ip TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        user_id TEXT DEFAULT '',
        user_name TEXT DEFAULT '',
        auth_method TEXT DEFAULT '',
        country_code TEXT DEFAULT '',
        city_name TEXT DEFAULT '',
        bytes_upload BIGINT DEFAULT 0,
        bytes_download BIGINT DEFAULT 0,
        metadata JSONB,
        received_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

        // Everything the app itself sent out (email / Telegram) - one row per actual send
        // attempt, written by the transport observers in lib/mail.js and lib/telegram.js.
        // Answers "who got what, when, and why" after the fact; governed by Data Retention.
        await pool.query(`
      CREATE TABLE IF NOT EXISTS outbound_log (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        channel TEXT NOT NULL,
        recipient TEXT DEFAULT '',
        feature TEXT DEFAULT '',
        subject TEXT DEFAULT '',
        ok BOOLEAN DEFAULT TRUE,
        error TEXT DEFAULT ''
      );
    `);
        // The full rendered body sent out (email HTML / Telegram HTML) so an admin can preview
        // exactly what went out. Kept out of the list query - bodies are large; fetched on demand.
        await pool.query(`ALTER TABLE outbound_log ADD COLUMN IF NOT EXISTS body TEXT DEFAULT ''`);

        // NetBird account notifications (Settings → Notifications → Webhook in the NetBird
        // dashboard, pointed at this app): routing peer down/deleted, pending approvals,
        // IdP/EDR sync token expiry. Raw payload kept in full - the schema is not formally
        // documented, so extraction is best-effort and the original is never lost.
        await pool.query(`
      CREATE TABLE IF NOT EXISTS nb_notifications (
        id BIGSERIAL PRIMARY KEY,
        received_at TIMESTAMPTZ DEFAULT NOW(),
        dedup TEXT UNIQUE,
        category TEXT DEFAULT '',
        event TEXT DEFAULT '',
        message TEXT DEFAULT '',
        peer_name TEXT DEFAULT '',
        raw JSONB
      );
    `);
        // Admin "Ignore" on a notice hides it for EVERYONE (banner + dashboard).
        await pool.query(`ALTER TABLE nb_notifications ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ`);

        // Cleanup-scan ignores: findings an admin marked as "known and fine" (e.g. a resource
        // deliberately kept WITHOUT default policies, reachable only via access requests).
        // Ignored findings drop out of the Cleanup page counters AND the weekly digest.
        await pool.query(`
      CREATE TABLE IF NOT EXISTS cleanup_ignores (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        object_id TEXT NOT NULL,
        created_by TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(category, object_id)
      );
    `);

        // Create indexes for fast querying. NOTE: the (tenant, timestamp DESC) workhorses for the
        // big log tables are NOT here - they are built POST-BOOT and CONCURRENTLY by
        // ensureLogIndexes(), because on a multi-GB events table a blocking build would hold the
        // container's boot (and every writer) for minutes. Everything below is a cheap
        // single-column index that a fresh install needs immediately.
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_events_flow_id ON events(flow_id)',
            'CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_events_source_name ON events(source_name)',
            'CREATE INDEX IF NOT EXISTS idx_events_destination_name ON events(destination_name)',
            'CREATE INDEX IF NOT EXISTS idx_events_destination_addr ON events(destination_addr)',
            'CREATE INDEX IF NOT EXISTS idx_events_protocol ON events(protocol)',
            'CREATE INDEX IF NOT EXISTS idx_events_message ON events(message)',
            'CREATE INDEX IF NOT EXISTS idx_proxy_logs_host ON proxy_access_logs(host)',
            'CREATE INDEX IF NOT EXISTS idx_proxy_logs_source ON proxy_access_logs(source_ip)',
            'CREATE INDEX IF NOT EXISTS idx_events_destination_type ON events(destination_type)',
            'CREATE INDEX IF NOT EXISTS idx_events_reporter_id ON events(reporter_id)',
            'CREATE INDEX IF NOT EXISTS idx_admin_events_timestamp ON admin_events(timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_admin_events_message ON admin_events(message)',
            'CREATE INDEX IF NOT EXISTS idx_outbound_log_ts ON outbound_log(timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_nb_notifications_ts ON nb_notifications(received_at DESC)',
        ];

        for (const idx of indexes) {
            await client.query(idx);
        }

        // ─── Multi-tenant (MSP) columns ───
        // Every tenant-relevant table carries `tenant` ('' = the main account) so tenant data
        // can never mix with main-account data. Existing rows default to '' - upgrades are
        // seamless. Where the natural key is a NetBird OBJECT id (which is account-scoped),
        // the tenant joins the PK/UNIQUE, so two tenants can never collide or overwrite each
        // other. Global app config (app_settings, templates) stays untouched. filter_rules is now
        // per-account too - each account filters its OWN webhook traffic by its OWN rules.
        const TENANT_TABLES = [
            'peers', 'users', 'peer_meta', 'bypass_expirations', 'network_grants', 'network_default_profiles',
            'access_profiles', 'automations', 'automation_runs', 'automation_resources', 'address_blocklist',
            'temporary_access_grants', 'access_requests', 'recurring_access', 'recert_rounds', 'recert_items',
            'cleanup_ignores', 'nb_notifications', 'events', 'admin_events', 'proxy_access_logs',
            'ip_assignments', 'app_audit', 'outbound_log', 'filter_rules',
        ];
        for (const t of TENANT_TABLES) {
            await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT ''`);
        }
        // PK rebuilds (idempotent: compares the CURRENT pk column list first).
        const pkCols = async (table) => {
            // One row per key column (no array_agg - node-postgres returns name[] as a raw
            // string, which broke .join on first boot).
            const r = await client.query(
                `SELECT a.attname::text AS col
                 FROM pg_constraint c
                 JOIN unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord) ON TRUE
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum
                 WHERE c.contype = 'p' AND c.conrelid = $1::regclass
                 ORDER BY x.ord`, [table]);
            return r.rows.map(x => x.col);
        };
        const ensurePk = async (table, cols) => {
            const cur = await pkCols(table);
            if (cur.join(',') === cols.join(',')) return;
            // ATOMIC rebuild: DROP+ADD must commit together - a container killed mid-rebuild
            // must never leave the table PK-less (a committed bare DROP wedged the next boot,
            // which then tried to drop a constraint that no longer existed). IF EXISTS also
            // self-heals a table already left PK-less by that older failure mode.
            await client.query('BEGIN');
            try {
                await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
                await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (${cols.join(', ')})`);
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK').catch(() => { }); throw e; }
            console.log(`[Migrate] ${table} primary key → (${cols.join(', ')})`);
        };
        await ensurePk('peers', ['tenant', 'peer_id']);
        await ensurePk('users', ['tenant', 'user_id']);
        await ensurePk('peer_meta', ['tenant', 'peer_id']);
        await ensurePk('bypass_expirations', ['tenant', 'peer_id']);
        await ensurePk('network_grants', ['tenant', 'network_id', 'group_id']);
        await ensurePk('network_default_profiles', ['tenant', 'network_id', 'profile_id']);
        // Event stores are now per-tenant too - the same event id can exist under main AND a tenant.
        await ensurePk('events', ['tenant', 'id']);
        await ensurePk('admin_events', ['tenant', 'id']);
        // Reverse-proxy access logs are per-tenant too - the same log id can exist under main AND a tenant.
        await ensurePk('proxy_access_logs', ['tenant', 'id']);
        // UNIQUE rebuilds.
        const hasCon = async (name) => (await client.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [name])).rows.length > 0;
        if (!(await hasCon('nb_notifications_tenant_dedup_key'))) {
            if (await hasCon('nb_notifications_dedup_key')) await client.query('ALTER TABLE nb_notifications DROP CONSTRAINT nb_notifications_dedup_key');
            await client.query('ALTER TABLE nb_notifications ADD CONSTRAINT nb_notifications_tenant_dedup_key UNIQUE (tenant, dedup)');
        }
        if (!(await hasCon('cleanup_ignores_tenant_key'))) {
            if (await hasCon('cleanup_ignores_category_object_id_key')) await client.query('ALTER TABLE cleanup_ignores DROP CONSTRAINT cleanup_ignores_category_object_id_key');
            await client.query('ALTER TABLE cleanup_ignores ADD CONSTRAINT cleanup_ignores_tenant_key UNIQUE (tenant, category, object_id)');
        }
        // Tenant lookup index. The four big LOG tables (events, admin_events, proxy_access_logs,
        // app_audit) get the (tenant, timestamp DESC) composite from ensureLogIndexes() instead -
        // a bare (tenant) index is a strict prefix of it, so it serves nothing extra and only
        // taxes every INSERT. ip_assignments has no time-ordered log view, so it keeps its own.
        await client.query(`CREATE INDEX IF NOT EXISTS idx_ip_assignments_tenant ON ip_assignments(tenant)`);
        // filter_rules is small, but the per-account list/ingest reads are always (tenant, sort_order).
        await client.query('CREATE INDEX IF NOT EXISTS idx_filter_rules_tenant ON filter_rules(tenant, sort_order, id)');

        console.log('Database initialized successfully');

        // Seed default templates on first run (admins can edit/add more later)
        const tcount = await client.query('SELECT COUNT(*)::int AS n FROM templates');
        if (tcount.rows[0].n === 0) {
            await client.query(
                `INSERT INTO templates (name, protocol, ports, description, sort_order) VALUES
                 ('All ports', 'all', '', 'Route all protocols and ports', 1),
                 ('Common ports', 'tcp', '22,80,443,9443', 'Common service ports', 2)`
            );
            console.log('Seeded default resource templates');
        }

        // Default app settings + one-time migration of the legacy FILTER_ADDR_PATTERNS env.
        await client.query(
            `INSERT INTO app_settings (key, value) VALUES ('builtin_noise', 'true') ON CONFLICT (key) DO NOTHING`
        );
        await client.query(
            `INSERT INTO app_settings (key, value) VALUES ('app_name', 'NetBird Control') ON CONFLICT (key) DO NOTHING`
        );
        const fcount = await client.query('SELECT COUNT(*)::int AS n FROM filter_rules');
        if (fcount.rows[0].n === 0) {
            const legacy = (process.env.FILTER_ADDR_PATTERNS || '').split(',').map(s => s.trim()).filter(Boolean);
            for (let i = 0; i < legacy.length; i++) {
                await client.query(
                    `INSERT INTO filter_rules (field, operator, value, sort_order) VALUES ('any_addr', 'contains', $1, $2)`,
                    [legacy[i], i]
                );
            }
            if (legacy.length) console.log(`Migrated ${legacy.length} FILTER_ADDR_PATTERNS into filter_rules`);
        }

        // One-time merge: legacy resource templates → Access Profiles of type Direct
        // (protocol/ports presets, no group/policy). Templates and profiles are unified.
        const merged = await client.query(`SELECT 1 FROM app_settings WHERE key = 'templates_merged_v1'`);
        if (!merged.rows.length) {
            const m = await client.query(`
                INSERT INTO access_profiles (name, group_id, policy_id, sources, protocol, ports, shared)
                SELECT name, '', '', '[]'::jsonb, protocol, ports, false FROM templates`);
            await client.query(`INSERT INTO app_settings (key, value) VALUES ('templates_merged_v1', 'true') ON CONFLICT (key) DO NOTHING`);
            if (m.rowCount) console.log(`Merged ${m.rowCount} resource templates into Access Profiles (Direct)`);
        }

        // Load the NetBird API connection + webhook auth token from app_settings (env wins).
        await loadNbApi();
        await loadTenantTokens();
        await loadWebhook();
        await loadTelegram();
        await loadApproverConfig();
        await loadAutoApproval();
        await loadSmtp();
        await loadFeaturePerms();
        await loadSecurityConfig();

        // Log NetBird Management API configuration status (resolves users + router names)
        if (_nbApi.url && _nbApi.token) {
            console.log(`NetBird API configured: ${_nbApi.url} (resolves users + routers)`);
        } else {
            console.log('NetBird API not configured - set it in Settings → NetBird API (or NETBIRD_API_URL/NETBIRD_API_TOKEN env)');
        }
    } finally {
        client.release();
    }
}

// ─── Post-boot log indexes (built CONCURRENTLY, never blocking the boot) ───
// Multi-tenant means EVERY log read starts with `WHERE tenant = $1` and then orders/ranges by
// timestamp - so the workhorse index for each log table is the (tenant, timestamp DESC) composite:
// one contiguous, already-sorted slice per account. A plain (timestamp) index cannot serve that
// (it leads with the wrong column), and a plain (tenant) index is a strict PREFIX of the composite
// (redundant once it exists). These builds take MINUTES on a multi-GB table, so they must never run
// inside initializeDatabase(): CREATE INDEX CONCURRENTLY takes only a SHARE UPDATE EXCLUSIVE lock,
// leaving webhook ingest and every read running while it builds.
const LOG_INDEXES = [
    // Every events list/aggregate/purge is `tenant = $1` + timestamp ordering or a timestamp range
    // (Activity detailed + summary, hourly dashboard chart, retention purge, anomaly baseline,
    // fleet report MAX(timestamp) per tenant).
    { name: 'idx_events_tenant_ts', table: 'events', cols: '(tenant, timestamp DESC)' },
    // Same shape for the NetBird admin-event log (Admin → Activity).
    { name: 'idx_admin_events_tenant_ts', table: 'admin_events', cols: '(tenant, timestamp DESC)' },
    // Reverse-proxy access log list - always `tenant = $1 ... ORDER BY timestamp DESC`.
    { name: 'idx_proxy_logs_tenant_ts', table: 'proxy_access_logs', cols: '(tenant, timestamp DESC)' },
    // The app's own audit log - same shape again.
    { name: 'idx_app_audit_tenant_ts', table: 'app_audit', cols: '(tenant, timestamp DESC)' },
    // The Activity toolbar's user dropdown filters `tenant = $1 AND user_id = $n` and still orders
    // by time; with only the plain (user_id) index that page had to sort the whole matched set.
    { name: 'idx_events_tenant_user_ts', table: 'events', cols: '(tenant, user_id, timestamp DESC)' },
];
// Dropped once their composite exists: each is either the same columns in the useless order
// (timestamp-first) or a strict prefix of a composite. Every query on these tables filters tenant
// first, so nothing is left unserved. Each write to a multi-GB table pays for every index.
const LOG_INDEXES_OBSOLETE = [
    { name: 'idx_events_timestamp', needs: 'idx_events_tenant_ts' },
    { name: 'idx_proxy_logs_ts', needs: 'idx_proxy_logs_tenant_ts' },
    { name: 'idx_app_audit_ts', needs: 'idx_app_audit_tenant_ts' },
    { name: 'idx_events_tenant', needs: 'idx_events_tenant_ts' },
    { name: 'idx_admin_events_tenant', needs: 'idx_admin_events_tenant_ts' },
    { name: 'idx_proxy_access_logs_tenant', needs: 'idx_proxy_logs_tenant_ts' },
    { name: 'idx_app_audit_tenant', needs: 'idx_app_audit_tenant_ts' },
];

let _logIndexesRan = false;
// Fired AFTER the server is listening (see start() in server.js) - never awaited by boot.
async function ensureLogIndexes() {
    if (_logIndexesRan) return;
    _logIndexesRan = true;
    // A DEDICATED client, used with single standalone statements: CREATE INDEX CONCURRENTLY cannot
    // run inside a transaction block, and pooled clients here are otherwise transaction-free but
    // shared. client.query() with no parameter array sends one simple-protocol statement, which is
    // exactly what CONCURRENTLY requires.
    const client = await pool.connect();
    try {
        // Presence AND validity in one look-up (pg_indexes alone cannot tell a half-built index
        // from a usable one).
        const exists = async (name) => (await client.query(
            `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`,
            [name]
        )).rows[0];

        for (const idx of LOG_INDEXES) {
            const cur = await exists(idx.name);
            // Self-heal: a CONCURRENTLY build killed mid-flight (container restart) leaves an
            // INVALID index behind that the planner ignores and IF NOT EXISTS happily keeps.
            // Drop it and build once more.
            if (cur && cur.indisvalid === false) {
                console.log(`[Index] ${idx.name} is INVALID (interrupted build) - dropping and rebuilding`);
                await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx.name}`).catch(e => console.error(`[Index] drop failed: ${e.message}`));
            } else if (cur) {
                continue;
            }
            const t0 = Date.now();
            console.log(`[Index] building ${idx.name} on ${idx.table}${idx.cols} (CONCURRENTLY, online)`);
            try {
                await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idx.name} ON ${idx.table} ${idx.cols}`);
                console.log(`[Index] ${idx.name} ready in ${Math.round((Date.now() - t0) / 1000)}s`);
            } catch (e) {
                // A failed CONCURRENTLY build leaves an invalid index - clear it so the NEXT boot
                // starts clean, then retry once (transient lock/deadlock is the common cause).
                console.error(`[Index] ${idx.name} failed: ${e.message} - retrying once`);
                await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx.name}`).catch(() => { });
                try {
                    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idx.name} ON ${idx.table} ${idx.cols}`);
                    console.log(`[Index] ${idx.name} ready in ${Math.round((Date.now() - t0) / 1000)}s (retry)`);
                } catch (e2) {
                    console.error(`[Index] ${idx.name} FAILED again: ${e2.message} - log pages stay slow until this succeeds`);
                }
            }
        }

        // Only now, with the composites in place and VALID, retire the ones they replace.
        for (const old of LOG_INDEXES_OBSOLETE) {
            const replacement = await exists(old.needs);
            if (!replacement || replacement.indisvalid === false) continue;
            if (!(await exists(old.name))) continue;
            try {
                await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${old.name}`);
                console.log(`[Index] dropped ${old.name} (superseded by ${old.needs})`);
            } catch (e) {
                console.error(`[Index] could not drop ${old.name}: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('[Index] log index maintenance failed:', e.message);
    } finally {
        client.release();
    }
}

// addEvent (the traffic-event ingest) now lives in lib/events.js; imported at the top of this file.
// The NetBird user identity behind the APP'S OWN API token (a service user). Events whose
// initiator is this user were caused by the app (grants, automations, merges...) - the UI
// tags them "Via App" so admins can tell app-driven changes from external ones. Cached 1h.
const _ownNbUser = new Map(); // account id → { at, id } - the "Via App" badge id differs per account
async function getOwnNetbirdUserId() {
    const key = tnt();
    const c = _ownNbUser.get(key);
    if (c && c.id !== null && Date.now() - c.at < 3600_000) return c.id;
    const u = await netbirdGet('/api/users/current').catch(() => null);
    const id = (u && u.id) || '';
    _ownNbUser.set(key, { at: Date.now(), id });
    return id;
}

// addAdminEvent stays here because it fires the NetBird admin-event Telegram notification.
// `notify` lets the Audit Events API pull suppress Telegram on its FIRST (backfill) run - a whole
// history landing at once must not spam the channel. The webhook caller passes no options, so it
// keeps the default notify:true and behaves exactly as before.
async function addAdminEvent(payload, { notify = true } = {}) {
    const meta = payload.meta || {};
    const id = String(payload.ID);
    const query = `
    INSERT INTO admin_events (tenant, id, timestamp, message, initiator_id, target_id, meta, reference, raw_json)
    VALUES ($9, $1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (tenant, id) DO NOTHING
  `;
    const values = [
        id,
        payload.Timestamp,
        payload.Message || '',
        payload.InitiatorID || '',
        payload.target_id || '',
        JSON.stringify(meta),
        payload.reference || '',
        JSON.stringify(payload),
        tnt(), // the active account - main ('') or a tenant (webhook resolved from its token)
    ];
    const r = await pool.query(query, values);
    // Notify ONLY when the event is actually NEW - the same event can arrive more than once
    // (webhook retries / overlapping ingestion). The PK dedupes the DB; this dedupes Telegram.
    if (r.rowCount) {
        if (notify) notifyNetbirdTelegram(payload).catch(() => { }); // fire-and-forget
        // A new billing event = a new billed-users number - refresh the dashboard's cache.
        if (/^billing/i.test(payload.Message || '')) _billingCache.delete(tnt());
    }
    return r;
}

const ADMIN_EVT_SORT_COLS = { event: 'timestamp', user: 'initiator_id' };
async function queryAdminEvents({ search, from, to, category, sort, dir, page = 1, per_page = 10 }) {
    let conditions = [];
    let params = [];
    let paramIndex = 1;

    // Scope to the active account - main ('') or a tenant, identically (tenants read their own
    // stored admin events, exactly like main - the old live-only tenant path is gone).
    conditions.push(`tenant = $${paramIndex}`);
    params.push(tnt());
    paramIndex++;

    if (search) {
        conditions.push(`(message ILIKE $${paramIndex} OR initiator_id::text ILIKE $${paramIndex} OR target_id ILIKE $${paramIndex})`);
        params.push(`%${search}%`);
        paramIndex++;
    }
    if (from) {
        conditions.push(`timestamp >= $${paramIndex}`);
        params.push(from);
        paramIndex++;
    }
    if (to) {
        conditions.push(`timestamp <= $${paramIndex}`);
        params.push(to);
        paramIndex++;
    }
    if (category) {
        const sql = nbEventCategorySql(category);
        if (sql) conditions.push(sql);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // CAPPED count - see cappedCount() in lib/core.js (bounded cost regardless of table size).
    const { total, totalCapped } = await cappedCount(`SELECT 1 FROM admin_events ${whereClause}`, params);

    const offset = (page - 1) * per_page;
    const dataParams = [...params, per_page, offset];
    const col = ADMIN_EVT_SORT_COLS[sort];
    const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy = col ? `${col} ${d} NULLS LAST, timestamp DESC` : `timestamp DESC`;
    const dataResult = await pool.query(
        `SELECT * FROM admin_events ${whereClause} ORDER BY ${orderBy} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        dataParams
    );

    // Translate opaque NetBird ids in each event's meta (ingress services, groups, networks,
    // peers, users…) to names before they reach the UI. Sequential on purpose: the resolvers
    // are cache-backed, and a parallel burst on a cold cache would stampede the NetBird API.
    const events = [];
    for (const row of dataResult.rows) {
        if (!row.meta) { events.push(row); continue; }
        let meta = await enrichAdminEventMeta(row.meta);
        // Fill a blank user_name from the event's target_id (the affected user) - see fillAffectedUserName.
        meta = await fillAffectedUserName(meta, row.target_id);
        events.push({ ...row, meta });
    }

    return {
        events,
        total,
        totalCapped,
        page: parseInt(page, 10),
        per_page: parseInt(per_page, 10),
        total_pages: Math.ceil(total / per_page)
    };
}

// (queryTenantAdminEventsLive removed - tenants now store admin events like main and read them
// through queryAdminEvents, scoped by tnt(); the live pass-through path is gone.)

// getAdminStats now lives in lib/events.js; imported at the top of this file.

// ─── IP-assignment history: which user/peer held each NetBird IP, over time ───

// Reconcile the ip_assignments intervals against the current peers cache. Same holder → bump
// last_seen (throttled to ~5 min so a 60s tick doesn't rewrite every row); different holder →
// close the old interval and open a new one; vanished IP → close. Never touches NetBird.
let _ipSyncRunning = false;
async function syncIpAssignments() {
    if (_ipSyncRunning || !netbirdApiConfigured()) return;
    _ipSyncRunning = true;
    try {
        const t = tnt(); // the active account - main ('') or a tenant; every ip_assignments row is scoped to it
        const peers = await getAllPeers();
        const current = new Map(); // ip → holder snapshot
        for (const p of peers) {
            if (!p.ip) continue;
            current.set(p.ip, {
                peerId: p.id, peerName: p.name || p.hostname || '', dnsLabel: p.dns_label || '',
                userId: p.user_id || '', userName: p.owner_name || '', userEmail: p.owner_email || '',
                connectionIp: p.connection_ip || '', region: p.geo || '', countryCode: p.country_code || '',
            });
        }
        const open = await pool.query(`SELECT * FROM ip_assignments WHERE released_at IS NULL AND tenant = $1`, [t]);
        const openByIp = new Map(open.rows.map(r => [r.ip, r]));
        const now = Date.now();
        for (const [ip, cur] of current) {
            const row = openByIp.get(ip);
            if (row && row.peer_id === cur.peerId && (row.user_id || '') === cur.userId) {
                const stale = now - new Date(row.last_seen).getTime() > 5 * 60_000;
                if (stale || (row.connection_ip || '') !== cur.connectionIp) {
                    await pool.query(
                        `UPDATE ip_assignments SET last_seen=NOW(), peer_name=$2, dns_label=$3, user_name=$4, user_email=$5, connection_ip=$6, region=$7, country_code=$8 WHERE id=$1 AND tenant = $9`,
                        [row.id, cur.peerName, cur.dnsLabel, cur.userName, cur.userEmail, cur.connectionIp, cur.region, cur.countryCode, t]
                    );
                }
            } else {
                if (row) await pool.query(`UPDATE ip_assignments SET released_at=NOW() WHERE id=$1 AND tenant = $2`, [row.id, t]);
                await pool.query(
                    `INSERT INTO ip_assignments (ip, peer_id, peer_name, dns_label, user_id, user_name, user_email, connection_ip, region, country_code, tenant)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                    [ip, cur.peerId, cur.peerName, cur.dnsLabel, cur.userId, cur.userName, cur.userEmail, cur.connectionIp, cur.region, cur.countryCode, t]
                );
            }
        }
        // Open rows whose IP no longer exists (peer deleted) → the interval ends now.
        for (const row of open.rows) {
            if (!current.has(row.ip)) await pool.query(`UPDATE ip_assignments SET released_at=NOW() WHERE id=$1 AND tenant = $2`, [row.id, t]);
        }
    } catch (e) {
        console.error('[IP history] sync error:', e.message);
    } finally {
        _ipSyncRunning = false;
    }
}

// Whitelisted sort columns (server-side, since the history is paginated on the server).
// The default (no `sort`) keeps active intervals first, then most-recent.
// The IP-history queries (IP_SORT_COLS / queryIpHistory / getIpHistoryUsers), the shared events
// WHERE builder (buildEventConds) and the events queries (queryEvents / getDistinctUsers /
// getDistinctSources / queryTrafficSummary / getStats / getHourlyEventCounts) now live in
// lib/events.js; the exported ones are imported at the top of this file.

// Full list of cached users (NetBird /api/users) for the Users page
async function getAllUsers() {
    // Resolve each user's auto-assigned group IDs to names (for the Groups column), like the
    // NetBird dashboard's user table. Best-effort: an unknown id falls back to the id.
    await ensureGroupsFresh().catch(() => {});
    // Read the active account's mirror rows - main ('') or a tenant, identically.
    const result = await pool.query(
        `SELECT user_id, display_name, email, raw_json FROM users WHERE tenant = $1 ORDER BY display_name NULLS LAST, email`,
        [tnt()]
    );
    return result.rows.map(r => {
        const raw = r.raw_json || {};
        const autoGroups = Array.isArray(raw.auto_groups) ? raw.auto_groups : [];
        return {
            id: r.user_id,
            name: r.display_name || '',
            email: r.email || '',
            role: raw.role || '',
            status: raw.status || '',
            last_login: raw.last_login || '',
            is_service_user: !!raw.is_service_user,
            is_blocked: !!raw.is_blocked,
            pending_approval: !!raw.pending_approval,
            // Auto-assigned groups (assigned to peers this user enrolls), resolved to {id,name}.
            groups: autoGroups.map(gid => ({ id: gid, name: getGroupsMap()[gid] || gid })),
        };
    });
}

// Full list of cached peers (NetBird /api/peers) for the Peers page.
// Peers split into "user-device" (a user signed in via SSO - has user_id) and
// "server" (unattended, enrolled with a setup key - no user_id). The owner's
// email is resolved from the users cache.
async function getAllPeers(viewerOid) {
    // Read the active account's mirror rows - main ('') or a tenant, identically. The joined
    // extras (owner from the users mirror, bypass schedule, notes/tags) follow the peer's own
    // tenant. When viewerOid is given (a non-admin user), only return that user's own devices
    // (peers whose owner user_id matches the Azure oid); tenant mode is admin-only so it never applies.
    const params = [tnt()];
    const where = viewerOid
        ? `AND (p.raw_json->>'user_id' = $2 OR p.raw_json->>'user_id' LIKE '%|' || $2)`
        : '';
    if (viewerOid) params.push(viewerOid);
    const result = await pool.query(`
        SELECT p.peer_id, p.name, p.dns_label, p.ip, p.raw_json,
               u.display_name AS owner_name, u.email AS owner_email,
               b.expires_at AS bypass_expires_at, b.delete_peer AS bypass_delete_peer,
               m.note AS meta_note, m.tags AS meta_tags
        FROM peers p
        LEFT JOIN users u ON u.tenant = p.tenant AND u.user_id = (p.raw_json->>'user_id')
        LEFT JOIN bypass_expirations b ON b.tenant = p.tenant AND b.peer_id = p.peer_id
        LEFT JOIN peer_meta m ON m.tenant = p.tenant AND m.peer_id = p.peer_id
        WHERE p.tenant = $1 ${where}
        ORDER BY p.name
    `, params);
    // Session expiry (last_login + the account's peer_login_expiration) - one cached
    // settings read serves the whole list.
    const acct = await getAccountSettings().catch(() => null);
    const expSecs = (acct && acct.peer_login_expiration_enabled !== false) ? Number(acct.peer_login_expiration) || 0 : 0;
    return result.rows.map(r => {
        const raw = r.raw_json || {};
        const userId = raw.user_id || '';
        let sessionExpiresAt = null;
        if (userId && raw.login_expiration_enabled && raw.last_login && expSecs > 0) {
            const t = new Date(raw.last_login).getTime();
            if (Number.isFinite(t)) sessionExpiresAt = new Date(t + expSecs * 1000).toISOString();
        }
        return {
            id: r.peer_id,
            name: r.name || '',
            ip: r.ip || '',
            dns_label: r.dns_label || '',
            os: raw.os || '',
            version: raw.version || '',
            hostname: raw.hostname || '',
            ui_version: raw.ui_version || '',
            connected: !!raw.connected,
            created_at: raw.created_at || '',
            last_seen: raw.last_seen || '',
            last_login: raw.last_login || '',
            // Compliance/posture-relevant flags (drive the Non-Compliant / Bypassed filters).
            login_expired: !!raw.login_expired,
            login_expiration_enabled: !!raw.login_expiration_enabled,
            inactivity_expiration_enabled: !!raw.inactivity_expiration_enabled,
            session_expires_at: sessionExpiresAt,
            approval_required: !!raw.approval_required,
            force_approved: peerIsBypassed(r.peer_id, raw), // admin bypassed compliance (peer flag OR the EDR bypassed list)
            bypass_expires_at: r.bypass_expires_at || null, // scheduled auto-revoke of the bypass (null = unlimited)
            bypass_temp_device: !!r.bypass_delete_peer,     // temporary device - DELETED when the bypass expires
            note: r.meta_note || '',                        // operational note (app-only)
            tags: Array.isArray(r.meta_tags) ? r.meta_tags : [],
            disapproval_reason: raw.disapproval_reason || '',
            connection_ip: raw.connection_ip || '', // public IP the peer connects from
            network_addresses: peerNetworkAddresses(raw), // local interfaces (IP + MAC), NetBird v0.81+
            country_code: raw.country_code || '',
            geo: [raw.country_code, raw.city_name].filter(Boolean).join(', '),
            groups: Array.isArray(raw.groups) ? raw.groups.map(g => (g && g.name) ? g.name : g).filter(Boolean) : [],
            // Full group refs with peer counts for the "Assigned Groups" hover popover.
            groupRefs: Array.isArray(raw.groups)
                ? raw.groups.map(g => ({ id: (g && g.id) || '', name: (g && g.name) || '', peers_count: (g && g.peers_count) || 0 })).filter(g => g.name)
                : [],
            group_count: Array.isArray(raw.groups) ? raw.groups.length : 0,
            user_id: userId,
            owner_name: r.owner_name || '',
            owner_email: r.owner_email || '',
            kind: userId ? 'user-device' : 'server',
        };
    });
}

// Expanded detail for one peer (peer detail page) - the full set of fields from the
// cached NetBird peer object, with the owner resolved from the users cache.
// Account-level settings (peer session expiration etc.) - cached 10 minutes. A FAILED fetch
// is remembered for 60s (outage backoff, so the hot paths that call getAllPeers don't hammer
// a down API on every call), and while backing off we serve the last good value if we have one.
let _acctSettings = { at: 0, data: null, failedAt: 0 };
async function getAccountSettings() {
    // Tenant context: the global cache below is the MAIN account's - never serve it to a tenant.
    // Read the tenant's own account settings live (ALS-aware, uncached: low-traffic admin views).
    if (currentTenantAccount()) {
        const accounts = await netbirdGet('/api/accounts').catch(() => null);
        return (Array.isArray(accounts) && accounts[0] && accounts[0].settings) || null;
    }
    const now = Date.now();
    if (_acctSettings.data && now - _acctSettings.at < 600_000) return _acctSettings.data;
    if (now - _acctSettings.failedAt < 60_000) return _acctSettings.data; // backoff: stale-or-null
    const accounts = await netbirdGet('/api/accounts').catch(() => null);
    const s = (Array.isArray(accounts) && accounts[0] && accounts[0].settings) || null;
    if (s) _acctSettings = { at: now, data: s, failedAt: 0 };
    else _acctSettings.failedAt = now;
    return s || _acctSettings.data;
}

async function getPeerDetail(peerId) {
    // Read the active account's mirror row - main ('') or a tenant, identically. The joined
    // extras (owner, bypass schedule, note/tags) follow the peer's own tenant.
    const r = await pool.query(`
        SELECT p.peer_id, p.name, p.dns_label, p.ip, p.raw_json,
               u.display_name AS owner_name, u.email AS owner_email,
               b.expires_at AS bypass_expires_at, b.delete_peer AS bypass_delete_peer,
               m.note AS meta_note, m.tags AS meta_tags
        FROM peers p
        LEFT JOIN users u ON u.tenant = p.tenant AND u.user_id = (p.raw_json->>'user_id')
        LEFT JOIN bypass_expirations b ON b.tenant = p.tenant AND b.peer_id = p.peer_id
        LEFT JOIN peer_meta m ON m.tenant = p.tenant AND m.peer_id = p.peer_id
        WHERE p.tenant = $2 AND p.peer_id = $1
    `, [peerId, tnt()]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const raw = row.raw_json || {};
    const userId = raw.user_id || '';
    // Session expiry: NetBird counts the account's peer_login_expiration from the peer's
    // last_login, for user-owned peers with login expiration enabled.
    let sessionExpiresAt = null;
    if (userId && raw.login_expiration_enabled && raw.last_login) {
        const s = await getAccountSettings().catch(() => null);
        const secs = (s && s.peer_login_expiration_enabled !== false) ? Number(s.peer_login_expiration) || 0 : 0;
        if (secs > 0) {
            const t = new Date(raw.last_login).getTime();
            if (Number.isFinite(t)) sessionExpiresAt = new Date(t + secs * 1000).toISOString();
        }
    }
    return {
        id: row.peer_id,
        name: row.name || '',
        hostname: raw.hostname || '',
        dns_label: row.dns_label || '',
        ip: row.ip || raw.ip || '',
        ipv6: raw.ipv6 || '',
        connection_ip: raw.connection_ip || '',
        connected: !!raw.connected,
        created_at: raw.created_at || '',
        last_seen: raw.last_seen || '',
        last_login: raw.last_login || '',
        login_expired: !!raw.login_expired,
        login_expiration_enabled: !!raw.login_expiration_enabled,
        inactivity_expiration_enabled: !!raw.inactivity_expiration_enabled,
        session_expires_at: sessionExpiresAt,
        approval_required: !!raw.approval_required,
        force_approved: peerIsBypassed(row.peer_id, raw), // admin bypassed compliance (peer flag OR the EDR bypassed list)
        bypass_expires_at: row.bypass_expires_at || null,
        bypass_temp_device: !!row.bypass_delete_peer,
        note: row.meta_note || '',
        tags: Array.isArray(row.meta_tags) ? row.meta_tags : [],
        disapproval_reason: raw.disapproval_reason || '',
        os: raw.os || '',
        version: raw.version || '',
        ui_version: raw.ui_version || '',
        kernel_version: raw.kernel_version || '',
        serial_number: raw.serial_number || '',
        network_addresses: peerNetworkAddresses(raw),
        city_name: raw.city_name || '',
        country_code: raw.country_code || '',
        ssh_enabled: !!raw.ssh_enabled,
        ephemeral: !!raw.ephemeral,
        groups: Array.isArray(raw.groups)
            ? raw.groups.map(g => ({ id: (g && g.id) || '', name: (g && g.name) || (typeof g === 'string' ? g : '') })).filter(g => g.name)
            : [],
        user_id: userId,
        owner_name: row.owner_name || '',
        owner_email: row.owner_email || '',
        kind: userId ? 'user-device' : 'server',
        raw, // the full NetBird peer object - powers the "View raw" / all-fields view
    };
}

// ─── Group usage (policies / routes / DNS / setup-keys / resources) ───
// The usage datasets cache (emptyUsage/fetchUsageData/getUsageData + USAGE_TTL_MS) now lives in
// lib/netbird.js; getUsageData is imported at the top of this file. The group-resolution helpers
// below (groupRef / policiesForGroup / resolvePolicyGroups / ...) stay here - they are pure and
// used by the domain group/policy views.

const groupRef = g => ((g && g.id) ? g.id : g); // group object or bare id → id

function policiesForGroup(policies, gid) {
    return policies.filter(p => {
        const rule = (p.rules && p.rules[0]) || {};
        const has = arr => (arr || []).some(g => groupRef(g) === gid);
        return has(rule.sources) || has(rule.destinations);
    });
}
function routesForGroup(routes, gid) {
    return routes.filter(r =>
        (r.groups || []).includes(gid) ||
        (r.access_control_groups || []).includes(gid) ||
        (r.peer_groups || []).includes(gid));
}
const nameserversForGroup = (list, gid) => list.filter(ns => (ns.groups || []).includes(gid));
const zonesForGroup = (list, gid) => list.filter(z => (z.distribution_groups || []).includes(gid));
const setupKeysForGroup = (list, gid) => list.filter(k => (k.auto_groups || []).includes(gid));

// The group ref-map cache (_grefMap + getGroupRefMap) now lives in lib/netbird.js; getGroupRefMap
// is imported at the top of this file.

// Policy rule sources/destinations (Group objects or ids) → [{id,name,peers_count,resources_count}].
function resolvePolicyGroups(arr, map) {
    return (arr || []).map(g => {
        const id = groupRef(g);
        const ref = map[id];
        if (ref) return ref;
        return { id, name: (g && g.name) ? g.name : id, peers_count: 0, resources_count: 0 };
    });
}

// Build per-group-id usage counts across all datasets in one pass.
function buildUsageCounts(usage) {
    const policies = {}, routes = {}, nameservers = {}, zones = {}, setupKeys = {};
    const bump = (m, id) => { if (id) m[id] = (m[id] || 0) + 1; };

    for (const p of usage.policies) {
        const rule = (p.rules && p.rules[0]) || {};
        const ids = new Set();
        for (const g of (rule.sources || [])) ids.add(groupRef(g));
        for (const g of (rule.destinations || [])) ids.add(groupRef(g));
        for (const id of ids) bump(policies, id);
    }
    for (const r of usage.routes) {
        const ids = new Set([...(r.groups || []), ...(r.access_control_groups || []), ...(r.peer_groups || [])]);
        for (const id of ids) bump(routes, id);
    }
    for (const ns of usage.nameservers) for (const id of (ns.groups || [])) bump(nameservers, id);
    for (const z of usage.zones) for (const id of (z.distribution_groups || [])) bump(zones, id);
    for (const k of usage.setupKeys) for (const id of (k.auto_groups || [])) bump(setupKeys, id);

    return { policies, routes, nameservers, zones, setupKeys };
}

// All NetBird groups (GET /api/groups) with full usage counts for the Groups tab -
// users/peers/resources plus policies/routes/nameservers/zones/setup-keys (mirrors
// the NetBird dashboard's groups table). Returns [] when the API isn't configured.
async function getGroups() {
    const groups = await netbirdGet('/api/groups');
    if (!Array.isArray(groups)) return [];

    // Count how many cached users have each group in their auto_groups.
    const userCounts = {};
    try {
        const ures = await pool.query(`SELECT raw_json->'auto_groups' AS ag FROM users WHERE tenant = $1`, [tnt()]);
        for (const r of ures.rows) {
            const ag = r.ag;
            if (Array.isArray(ag)) for (const gid of ag) userCounts[gid] = (userCounts[gid] || 0) + 1;
        }
    } catch (e) {
        console.error('[Groups] user-count error:', e.message);
    }

    const counts = buildUsageCounts(await getUsageData());

    return groups.map(g => {
        const peers = Array.isArray(g.peers) ? g.peers.length : (g.peers_count || 0);
        const resources = Array.isArray(g.resources) ? g.resources.length : (g.resources_count || 0);
        return {
            id: g.id,
            name: g.name || g.id,
            issued: g.issued || 'api',
            users_count: userCounts[g.id] || 0,
            peers_count: peers,
            resources_count: resources,
            policies_count: counts.policies[g.id] || 0,
            routes_count: counts.routes[g.id] || 0,
            nameservers_count: counts.nameservers[g.id] || 0,
            zones_count: counts.zones[g.id] || 0,
            setup_keys_count: counts.setupKeys[g.id] || 0,
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

// Delete a NetBird group (admin). The immutable "All" group is protected; NetBird itself
// rejects groups still linked to policies/routes/DNS/setup-keys - surface that message.
// Create an empty group (official-dashboard parity: POST /api/groups { name }). Runs in the
// current account context, so it creates the group inside a managed tenant too.
async function createGroup(name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('A group name is required');
    if (n.length > 100) throw new Error('Group name is too long');
    const resp = await netbirdPost('/api/groups', { name: n });
    if (!resp || resp.status >= 300) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'Failed to create group';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    bustNbCaches('gref', 'groups', 'usage');
    return resp.body;
}

async function deleteGroup(id) {
    const grp = await netbirdGet('/api/groups/' + encodeURIComponent(id));
    if (grp && grp.name === 'All') throw new Error('The "All" group cannot be deleted.');
    const resp = await netbirdReq('DELETE', '/api/groups/' + encodeURIComponent(id));
    if (!resp || (resp.status >= 300 && resp.status !== 404)) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'group may still be in use';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    bustNbCaches('gref', 'groups', 'usage');
    return { ok: true };
}

// Replace a group's PEER membership (official dashboard mechanics: group members-peers live ON the
// group object, so PUT /api/groups/{id} with the FULL desired peer id list - NetBird REPLACES the
// set). Used for both add and remove; the caller computes the final list. NetBird's PUT REPLACES
// the group, so name + resources are resent or they would be wiped. Routed through asRealUser (the
// MSP provisioning token when set) because tenant service-user tokens are restricted on group
// writes, exactly like inviteUser/setUserBlocked. The auto-managed "All" group is rejected (400).
async function setGroupPeers(groupId, peerIds) {
    const acct = tnt();
    const g = await netbirdGet('/api/groups/' + encodeURIComponent(groupId));
    if (!g || !g.id) { const e = new Error('Group not found.'); e.status = 400; throw e; }
    if (g.name === 'All') { const e = new Error('The "All" group is managed automatically - its peers cannot be changed.'); e.status = 400; throw e; }
    const peers = Array.from(new Set((Array.isArray(peerIds) ? peerIds : []).map(x => String(x || '')).filter(Boolean)));
    const body = { name: g.name, peers };
    if (Array.isArray(g.resources)) body.resources = g.resources; // preserve resources across the replace
    const resp = await asRealUser(() => netbirdPut('/api/groups/' + encodeURIComponent(groupId), body));
    if (!resp || resp.status >= 300) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'Failed to update the group';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    // Peer group membership is mirrored on the peer objects too - force a peers re-pull so the
    // group's peer list updates immediately, then bust the group/usage caches.
    _peersLastRefresh.set(acct, 0);
    await refreshPeersCache().catch(err => console.error('[Groups] post-peer-set refresh error:', err.message));
    bustNbCaches('gref', 'groups', 'usage');
    return { ok: true, name: g.name, count: peers.length };
}

// Rename a group (official: the header pencil). Only API-created groups can be renamed - the "All"
// group and IdP/JWT-issued groups are managed by NetBird. Full-replace PUT, so the existing peers +
// resources are resent unchanged alongside the new name.
async function renameGroup(groupId, newName) {
    const name = String(newName || '').trim();
    if (!name) { const e = new Error('A group name is required'); e.status = 400; throw e; }
    if (name.length > 100) { const e = new Error('Group name is too long'); e.status = 400; throw e; }
    const g = await netbirdGet('/api/groups/' + encodeURIComponent(groupId));
    if (!g || !g.id) { const e = new Error('Group not found.'); e.status = 400; throw e; }
    if (g.name === 'All') { const e = new Error('The "All" group cannot be renamed.'); e.status = 400; throw e; }
    if ((g.issued || 'api') !== 'api') { const e = new Error('This group is managed by your identity provider and cannot be renamed here.'); e.status = 400; throw e; }
    const peers = Array.isArray(g.peers) ? g.peers.map(p => (typeof p === 'string' ? p : (p && p.id))).filter(Boolean) : [];
    const body = { name, peers };
    if (Array.isArray(g.resources)) body.resources = g.resources;
    const resp = await asRealUser(() => netbirdPut('/api/groups/' + encodeURIComponent(groupId), body));
    if (!resp || resp.status >= 300) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'Failed to rename the group';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    bustNbCaches('gref', 'groups', 'usage');
    return { ok: true, name };
}

// Replace a USER's group membership (official dashboard mechanics: group membership for users lives
// in the user's auto_groups, NOT on the group - so PUT /api/users/{id} { role, auto_groups }). The
// role and is_blocked MUST be resent or NetBird's PUT wipes them (a missing is_blocked unblocks the
// user; same constraint as setUserBlocked). Sends the FULL
// desired auto_groups set. Routed through asRealUser (tenant service-user tokens are restricted on
// user writes).
// NetBird's user PUT replaces role + auto_groups + is_blocked together, so they are read FRESH from
// NetBird right before the write - never from the local mirror, which can be minutes old (a stale
// is_blocked would unblock a user blocked meanwhile, or re-block one unblocked meanwhile). There is
// no GET /api/users/{id}, so this reads the list (regular + service users) as the real user that
// performs the write. A failed read, or a user without a boolean is_blocked, aborts: no write.
async function liveUsersById(ids) {
    const [regular, service] = await asRealUser(() => Promise.all([
        netbirdGet('/api/users').catch(() => null),
        netbirdGet('/api/users?service_user=true').catch(() => null),
    ]));
    if (!Array.isArray(regular) || !Array.isArray(service)) throw new Error("Couldn't read the user's current state from NetBird - nothing was changed. Try again.");
    const all = new Map([...regular, ...service].filter(u => u && u.id).map(u => [String(u.id), u]));
    const out = new Map();
    for (const id of ids) {
        const u = all.get(String(id));
        if (u && typeof u.is_blocked === 'boolean') out.set(String(id), u);
    }
    return out;
}
const STALE_USER_ERR = "Couldn't read this user's current state from NetBird - nothing was changed. Try again.";

async function setUserGroups(userId, groupIds) {
    const acct = tnt();
    const row = await resolveUserRow(userId, acct);
    const live = (await liveUsersById([userId])).get(String(userId));
    if (!live) throw new Error(STALE_USER_ERR);
    const groups = Array.from(new Set((Array.isArray(groupIds) ? groupIds : []).map(x => String(x || '')).filter(Boolean)));
    const resp = await asRealUser(() => netbirdPut('/api/users/' + encodeURIComponent(userId), { role: live.role || 'user', auto_groups: groups, is_blocked: live.is_blocked }));
    if (!resp || resp.status >= 300) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'Failed to update the user';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    return { ok: true, label: row.email || row.display_name || row.user_id, count: groups.length };
}

// Add/remove a set of users to/from ONE group. Group membership is per-user (auto_groups), so this
// is one PUT per user via setUserGroups - best-effort: one user's failure does not abort the rest.
// Reads each user's CURRENT auto_groups from the mirror, adds/removes groupId, and writes back.
// Refreshes the users mirror once at the end so the group's member list updates immediately.
async function _applyUsersGroup(groupId, userIds, mode) {
    const acct = tnt();
    const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map(x => String(x || '')).filter(Boolean)));
    let updated = 0;
    const failed = [];
    const live = ids.length ? await liveUsersById(ids) : new Map(); // throws (no writes) when unreadable
    for (const uid of ids) {
        try {
            const u = live.get(uid);
            if (!u) throw new Error(STALE_USER_ERR);
            const cur = Array.isArray(u.auto_groups) ? u.auto_groups.map(g => String((g && g.id) || g)) : [];
            let next;
            if (mode === 'add') {
                if (cur.includes(groupId)) continue; // already a member - no-op
                next = [...cur, groupId];
            } else {
                if (!cur.includes(groupId)) continue; // not a member - no-op
                next = cur.filter(g => g !== groupId);
            }
            const resp = await asRealUser(() => netbirdPut('/api/users/' + encodeURIComponent(uid), { role: u.role || 'user', auto_groups: next, is_blocked: u.is_blocked }));
            if (!resp || resp.status >= 300) {
                const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'Failed to update user';
                failed.push({ id: uid, error: typeof msg === 'string' ? msg : String(msg) });
                continue;
            }
            updated++;
        } catch (e) { failed.push({ id: uid, error: e.message }); }
    }
    _usersLastRefresh.set(acct, 0);
    await refreshUsersCache().catch(err => console.error('[Groups] post-user-group refresh error:', err.message));
    bustNbCaches('gref', 'groups', 'usage');
    return { updated, failed };
}
async function addUsersToGroup(groupId, userIds) { return _applyUsersGroup(groupId, userIds, 'add'); }
async function removeUsersFromGroup(groupId, userIds) { return _applyUsersGroup(groupId, userIds, 'remove'); }

// Expanded detail for one group (Groups tab → group detail page). Peers come from
// the peers cache (matched on group membership) so they carry ip/os/owner; users
// from the users cache (auto_groups); resources from the group object.
async function getGroupDetail(id) {
    const group = await netbirdGet('/api/groups/' + encodeURIComponent(id));
    if (!group || !group.id) return null;

    // Peers whose cached groups include this group id.
    const pres = await pool.query(`
        SELECT p.peer_id, p.name, p.dns_label, p.ip, p.raw_json, u.email AS owner_email
        FROM peers p
        LEFT JOIN users u ON u.tenant = $2 AND u.user_id = (p.raw_json->>'user_id')
        WHERE p.tenant = $2 AND p.raw_json->'groups' @> $1::jsonb
        ORDER BY p.name
    `, [JSON.stringify([{ id }]), tnt()]);
    const peers = pres.rows.map(r => {
        const raw = r.raw_json || {};
        return {
            id: r.peer_id,
            name: r.name || '',
            ip: r.ip || '',
            dns_label: r.dns_label || '',
            os: raw.os || '',
            version: raw.version || '',
            connected: !!raw.connected,
            last_seen: raw.last_seen || '',
            owner_email: r.owner_email || '',
        };
    });

    // Users with this group in their auto_groups (scoped to the active account - a leftover
    // tenant = '' here read MAIN's users in tenant mode, so a tenant group always showed 0 members).
    const ures = await pool.query(`
        SELECT user_id, display_name, email, raw_json
        FROM users
        WHERE tenant = $2 AND raw_json->'auto_groups' @> $1::jsonb
        ORDER BY display_name NULLS LAST, email
    `, [JSON.stringify([id]), tnt()]);
    const users = ures.rows.map(r => {
        const raw = r.raw_json || {};
        return {
            id: r.user_id,
            name: r.display_name || '',
            email: r.email || '',
            role: raw.role || '',
            status: raw.status || '',
            is_blocked: !!raw.is_blocked,
            last_login: raw.last_login || '',
        };
    });

    // Cross-referenced usage (policies / routes / DNS / setup-keys / resources).
    const [usage, gmap] = await Promise.all([getUsageData(), getGroupRefMap()]);

    const policies = policiesForGroup(usage.policies, id).map(p => {
        const rule = (p.rules && p.rules[0]) || {};
        return {
            id: p.id,
            name: p.name || '',
            enabled: p.enabled !== false,
            action: rule.action || 'accept',
            protocol: rule.protocol || 'all',
            ports: Array.isArray(rule.ports) ? rule.ports : [],
            bidirectional: !!rule.bidirectional,
            sources: resolvePolicyGroups(rule.sources, gmap),
            destinations: resolvePolicyGroups(rule.destinations, gmap),
        };
    });

    const routes = routesForGroup(usage.routes, id).map(r => ({
        id: r.id,
        network_id: r.network_id || '',
        network: r.network || (Array.isArray(r.domains) ? r.domains.join(', ') : ''),
        description: r.description || '',
        enabled: r.enabled !== false,
        masquerade: !!r.masquerade,
        metric: typeof r.metric === 'number' ? r.metric : null,
    }));

    const nameservers = nameserversForGroup(usage.nameservers, id).map(ns => ({
        id: ns.id,
        name: ns.name || '',
        enabled: ns.enabled !== false,
        primary: !!ns.primary,
        domains: Array.isArray(ns.domains) ? ns.domains : [],
        nameservers: Array.isArray(ns.nameservers) ? ns.nameservers.map(n => `${n.ip}:${n.port || 53}`) : [],
    }));

    const zones = zonesForGroup(usage.zones, id).map(z => ({
        id: z.id,
        name: z.name || '',
        domain: z.domain || '',
        enabled: z.enabled !== false,
    }));

    const setupKeys = setupKeysForGroup(usage.setupKeys, id).map(k => ({
        id: k.id,
        name: k.name || '',
        state: k.state || (k.valid ? 'valid' : 'invalid'),
        valid: !!k.valid,
        revoked: !!k.revoked,
        type: k.type || '',
        used_times: k.used_times || 0,
        usage_limit: k.usage_limit ?? null,
        ephemeral: !!k.ephemeral,
        expires: k.expires || null,
    }));

    // Resources: enrich the group's {id,type} with name/address/network from the
    // global network-resources list (falls back gracefully if that's unavailable).
    const resById = {};
    for (const r of usage.resources) resById[r.id] = r;
    const resources = (Array.isArray(group.resources) ? group.resources : []).map(gr => {
        const rid = groupRef(gr);
        const full = resById[rid];
        const net = full ? usage.networks.find(n => Array.isArray(n.resources) && n.resources.includes(rid)) : null;
        return {
            id: rid,
            name: full ? (full.name || '') : '',
            address: full ? (full.address || '') : '',
            type: (full && full.type) || (gr && gr.type) || '',
            enabled: full ? (full.enabled !== false) : true,
            network_id: net ? (net.id || '') : '',
            network_name: net ? (net.name || '') : '',
        };
    });

    return {
        id: group.id,
        name: group.name || group.id,
        issued: group.issued || 'api',
        users,
        peers,
        resources,
        policies,
        routes,
        nameservers,
        zones,
        setupKeys,
        users_count: users.length,
        peers_count: peers.length,
        resources_count: resources.length,
        policies_count: policies.length,
        routes_count: routes.length,
        nameservers_count: nameservers.length,
        zones_count: zones.length,
        setup_keys_count: setupKeys.length,
    };
}

// Expanded detail for one user (Users tab → user detail page): profile fields,
// the groups they belong to (auto_groups resolved to names) and the peers they own.
async function getUserDetail(id) {
    const ures = await pool.query(
        `SELECT user_id, display_name, email, raw_json FROM users WHERE user_id = $1 AND tenant = $2`, [id, tnt()]
    );
    let r = ures.rows[0];
    if (!r) {
        // SERVICE USERS may be absent from the users mirror (the plain /api/users list can
        // exclude them), and a just-created user may simply not have synced yet - fall back to
        // a LIVE lookup in the current account context before declaring not-found.
        const [regular, service] = await Promise.all([
            netbirdGet('/api/users').catch(() => null),
            netbirdGet('/api/users?service_user=true').catch(() => null),
        ]);
        const live = [...(Array.isArray(regular) ? regular : []), ...(Array.isArray(service) ? service : [])]
            .find(u => u && u.id === id);
        if (!live) return null;
        r = { user_id: live.id, display_name: live.name || '', email: live.email || '', raw_json: live };
    }
    const raw = r.raw_json || {};
    const autoGroups = Array.isArray(raw.auto_groups) ? raw.auto_groups : [];

    // Resolve auto_groups ids → names.
    let groups = [];
    if (autoGroups.length) {
        const all = await netbirdGet('/api/groups');
        const nameById = {};
        if (Array.isArray(all)) for (const g of all) if (g && g.id) nameById[g.id] = g.name || g.id;
        groups = autoGroups.map(gid => ({ id: gid, name: nameById[gid] || gid }));
    }

    // Peers owned by this user.
    const pres = await pool.query(`
        SELECT p.peer_id, p.name, p.dns_label, p.ip, p.raw_json
        FROM peers p
        WHERE p.tenant = $2 AND (p.raw_json->>'user_id' = $1 OR p.raw_json->>'user_id' LIKE '%|' || $1)
        ORDER BY p.name
    `, [id, tnt()]);
    const peers = pres.rows.map(pr => {
        const praw = pr.raw_json || {};
        return {
            id: pr.peer_id,
            name: pr.name || '',
            ip: pr.ip || '',
            dns_label: pr.dns_label || '',
            os: praw.os || '',
            version: praw.version || '',
            connected: !!praw.connected,
            last_seen: praw.last_seen || '',
        };
    });

    return {
        id: r.user_id,
        name: r.display_name || '',
        email: r.email || '',
        role: raw.role || '',
        status: raw.status || '',
        last_login: raw.last_login || '',
        is_blocked: !!raw.is_blocked,
        is_service_user: !!raw.is_service_user,
        // Whether NetBird serves the cloud MFA reset endpoint on this API base (cached probe). The
        // Reset MFA button disables itself with a tooltip when false - like the Tenant Defaults MFA
        // controls - since the reset is unreachable through the management token/base.
        mfa_supported: await mfaSupported().catch(() => false),
        groups,
        peers,
    };
}

// Delete a user from NetBird (admin) - the official dashboard's user delete.
// NetBird ALSO DELETES THE USER'S PEERS, so both mirrors are force-refreshed afterwards.
// The identity is resolved BEFORE the call: the object is gone after it, and the audit entry
// must name a person, not an opaque NetBird id.
async function deleteUser(id) {
    const acct = tnt();
    const ures = await pool.query(
        `SELECT user_id, display_name, email, raw_json FROM users WHERE user_id = $1 AND tenant = $2`, [id, acct]
    );
    let row = ures.rows[0];
    if (!row) {
        // SERVICE USERS may be absent from the mirror (the plain /api/users list can exclude
        // them) - fall back to a LIVE lookup in the current account context, like getUserDetail.
        const [regular, service] = await Promise.all([
            netbirdGet('/api/users').catch(() => null),
            netbirdGet('/api/users?service_user=true').catch(() => null),
        ]);
        const live = [...(Array.isArray(regular) ? regular : []), ...(Array.isArray(service) ? service : [])]
            .find(u => u && u.id === id);
        if (!live) { const e = new Error('User not found.'); e.status = 400; throw e; }
        row = { user_id: live.id, display_name: live.name || '', email: live.email || '', raw_json: live };
    }
    const raw = row.raw_json || {};
    const label = row.email || row.display_name || row.user_id;

    // GUARD: NetBird refuses to delete the account owner - fail here with a readable reason.
    if (String(raw.role || '').toLowerCase() === 'owner') {
        const e = new Error('The account owner cannot be deleted.'); e.status = 400; throw e;
    }
    // GUARD: never delete the identity the app authenticates AS - that revokes its own API
    // access. Two shapes: the token's service user in the CURRENT context, and (in tenant
    // context) the managed service user recorded at provisioning time.
    const own = await getOwnNetbirdUserId().catch(() => '');
    let managed = '';
    if (acct) {
        try { managed = (JSON.parse((await getSetting(`msp_tenant_su:${acct}`)) || '{}') || {}).userId || ''; }
        catch { /* unreadable metadata - the own-id check still applies */ }
    }
    if ((own && id === own) || (managed && id === managed)) {
        const e = new Error("This is the app's own service user - deleting it would break the app's access.");
        e.status = 400; throw e;
    }

    const resp = await netbirdReq('DELETE', '/api/users/' + encodeURIComponent(id));
    // 404 = already gone, which is the desired end state - same as deleteGroup treats it.
    if (!resp || (resp.status >= 300 && resp.status !== 404)) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'Failed to delete the user';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    // Drop the mirror row so the user disappears at once, then force a re-pull of BOTH
    // mirrors for THIS account - the user's peers died with them.
    await pool.query('DELETE FROM users WHERE tenant = $2 AND user_id = $1', [id, acct]).catch(() => { });
    _usersLastRefresh.set(acct, 0);
    _peersLastRefresh.set(acct, 0);
    bustNbCaches('gref', 'usage');
    return { ok: true, name: row.display_name || '', email: row.email || '', label };
}

// Resolve one user to a mirror-shaped row {user_id, display_name, email, raw_json} for the write
// actions below - the mirror first, then a LIVE lookup (service users can be absent from the plain
// /api/users list, and a just-changed user may not have re-synced). Throws a 400 if truly gone.
async function resolveUserRow(id, acct) {
    const ures = await pool.query(
        `SELECT user_id, display_name, email, raw_json FROM users WHERE user_id = $1 AND tenant = $2`, [id, acct]
    );
    if (ures.rows[0]) return ures.rows[0];
    const [regular, service] = await Promise.all([
        netbirdGet('/api/users').catch(() => null),
        netbirdGet('/api/users?service_user=true').catch(() => null),
    ]);
    const live = [...(Array.isArray(regular) ? regular : []), ...(Array.isArray(service) ? service : [])]
        .find(u => u && u.id === id);
    if (!live) { const e = new Error('User not found.'); e.status = 400; throw e; }
    return { user_id: live.id, display_name: live.name || '', email: live.email || '', raw_json: live };
}

// The two identities that must never be blocked (or otherwise self-sabotaged): the account owner
// and the identity the app authenticates AS (the token's own service user in the current context,
// plus, in tenant context, the managed service user recorded at provisioning time). Throws 400.
async function guardProtectedUser(id, raw, acct, verb) {
    if (String((raw && raw.role) || '').toLowerCase() === 'owner') {
        const e = new Error(`The account owner cannot be ${verb}.`); e.status = 400; throw e;
    }
    const own = await getOwnNetbirdUserId().catch(() => '');
    let managed = '';
    if (acct) {
        try { managed = (JSON.parse((await getSetting(`msp_tenant_su:${acct}`)) || '{}') || {}).userId || ''; }
        catch { /* unreadable metadata - the own-id check still applies */ }
    }
    if ((own && id === own) || (managed && id === managed)) {
        const e = new Error(`This is the app's own service user - ${verb === 'blocked' ? 'blocking' : verb} it would break the app's access.`);
        e.status = 400; throw e;
    }
}

// Block / unblock a user (the official dashboard's user block toggle - UserActionCell). NetBird's
// PUT /api/users/{id} REPLACES the user, so role + auto_groups MUST be resent or they are wiped;
// only is_blocked changes here. The write routes through the MSP Provisioning Token when set
// (asRealUser), matching the tenant service-user restriction on user writes. The owner and the
// app's own service user cannot be blocked. The identity/label is resolved for the audit entry.
async function setUserBlocked(id, blocked) {
    const acct = tnt();
    const row = await resolveUserRow(id, acct);
    const raw = row.raw_json || {};
    const label = row.email || row.display_name || row.user_id;
    if (blocked) await guardProtectedUser(id, raw, acct, 'blocked');
    const body = {
        role: raw.role || 'user',
        auto_groups: Array.isArray(raw.auto_groups) ? raw.auto_groups : [],
        is_blocked: !!blocked,
    };
    const resp = await asRealUser(() => netbirdPut('/api/users/' + encodeURIComponent(id), body));
    if (!resp || resp.status >= 300) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'Failed to update the user';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    // Refresh the mirror now (bypassing the TTL) so is_blocked flips immediately on the Users page.
    _usersLastRefresh.set(acct, 0);
    await refreshUsersCache().catch(err => console.error('[UserResolve] post-block refresh error:', err.message));
    return { ok: true, name: row.display_name || '', email: row.email || '', label, blocked: !!blocked };
}

// Reset a user's MFA methods (the dashboard's "Reset MFA"). The official dashboard hits the AUTH
// service (DELETE /service/mfa/{userId}), NOT the management API. On the public MANAGEMENT API base
// that route answers a plain-text 404 (see mfaSupported), so it is likely unreachable here. Probe
// first: if unsupported, throw a clear 501 the route turns into a disabled button + tooltip. When
// supported, DELETE /api/service/mfa/{id} in the current context (routed through asRealUser for the
// same tenant service-user restriction). The label is resolved BEFORE the call, for the audit.
async function resetUserMfa(id) {
    if (!(await mfaSupported())) {
        const e = new Error('NetBird MFA reset is not available through the management API on this deployment.');
        e.status = 501; throw e;
    }
    const acct = tnt();
    const row = await resolveUserRow(id, acct);
    const label = row.email || row.display_name || row.user_id;
    const resp = await asRealUser(() => netbirdReq('DELETE', '/api/service/mfa/' + encodeURIComponent(id)));
    if (!resp || resp.status >= 300) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'Failed to reset MFA';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    return { ok: true, name: row.display_name || '', email: row.email || '', label };
}

// NetBird Networks (GET /api/networks) - fetched on demand for the Networks page.
function fetchNetworksFromApi() {
    if (!netbirdApiConfigured()) return Promise.resolve(null);
    // Tenant context: go through the ALS-aware client (tenant token / ?account=) - this raw
    // fetcher reads _nbApi directly and would silently return the MAIN account's networks.
    if (currentTenantAccount()) return netbirdGet('/api/networks');
    const url = new URL('/api/networks', _nbApi.url);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
        const req = transport.get(url.toString(), {
            headers: { 'Authorization': `Token ${_nbApi.token}`, 'Accept': 'application/json' },
            timeout: 10000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(Array.isArray(json) ? json : null);
                } catch (e) {
                    console.error('[Networks] Parse error:', e.message);
                    resolve(null);
                }
            });
        });
        req.on('error', (err) => { console.error('[Networks] Request error:', err.message); resolve(null); });
        req.on('timeout', () => { console.error('[Networks] Request timeout'); req.destroy(); resolve(null); });
    });
}

// Create a new (empty) network in NetBird.
// Networks where duplicate/overlapping resource addresses are intentionally ALLOWED
// (opt-in per network, e.g. NAT'd branch sites that reuse the same private ranges).
// Stored app-side in app_settings - NetBird itself has no such guard either way.
// Tenant isolation: each tenant gets its own settings key (network ids are account-scoped).
const dupKey = () => tnt() ? `network_allow_duplicates:${tnt()}` : 'network_allow_duplicates';
async function getDupAllowedNetworkIds() {
    try {
        const v = await getSetting(dupKey());
        const a = v ? JSON.parse(v) : [];
        return Array.isArray(a) ? a.map(String) : [];
    } catch { return []; }
}
async function setNetworkAllowDuplicates(networkId, allowed) {
    const ids = new Set(await getDupAllowedNetworkIds());
    if (allowed) ids.add(String(networkId)); else ids.delete(String(networkId));
    await setSetting(dupKey(), JSON.stringify([...ids]));
    return { allowDuplicates: !!allowed };
}

// Rename / re-describe a network (NetBird PUT - same call the official dashboard makes).
async function updateNetwork(id, { name, description }) {
    const resp = await netbirdReq('PUT', '/api/networks/' + encodeURIComponent(id), { name, description: description || '' });
    if (!resp || resp.status >= 300 || !resp.body || !resp.body.id) {
        throw new Error('Failed to update network: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    bustNbCaches('usage');
    return resp.body;
}

async function createNetwork({ name, description }) {
    const resp = await netbirdPost('/api/networks', { name, description: description || '' });
    if (!resp || resp.status >= 300 || !resp.body || !resp.body.id) {
        throw new Error('Failed to create network: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    bustNbCaches('usage');
    return resp.body;
}

// Add a routing peer (router) to a network - either a single peer or one+ peer groups.
async function createNetworkRouter(networkId, { peer, peerGroups, metric, masquerade, enabled }) {
    const body = {
        enabled: enabled !== false,
        masquerade: masquerade !== false,
        metric: Number.isFinite(metric) ? metric : 9999,
    };
    if (peer) body.peer = peer;
    else if (Array.isArray(peerGroups) && peerGroups.length) body.peer_groups = peerGroups.filter(Boolean);
    else throw new Error('a peer or at least one peer group is required');
    const resp = await netbirdPost(`/api/networks/${encodeURIComponent(networkId)}/routers`, body);
    if (!resp || resp.status >= 300 || !resp.body || !resp.body.id) {
        throw new Error('Failed to add routing peer: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    bustNbCaches('usage');
    return resp.body;
}

async function deleteNetworkRouter(networkId, routerId) {
    const resp = await netbirdReq('DELETE', `/api/networks/${encodeURIComponent(networkId)}/routers/${encodeURIComponent(routerId)}`);
    if (!resp || resp.status >= 300) throw new Error('Failed to delete routing peer: ' + (resp && (resp.raw || resp.error || resp.status)));
    bustNbCaches('usage');
    return { status: 'ok' };
}

// Delete a network (admin). Tears it down cleanly: each resource is removed via
// deleteResource (which also cleans up its auto-created policy + group), routers are
// removed, then the network itself is deleted.
async function deleteNetwork(id) {
    const detail = await getNetworkDetail(id).catch(() => null);
    if (detail) {
        for (const r of (detail.resources || [])) {
            if (r && r.id) {
                try { await deleteResource(id, r.id); } catch (e) { console.error('[deleteNetwork] resource:', e.message); }
            }
        }
        for (const rt of (detail.routers || [])) {
            if (rt && rt.id) {
                try { await deleteNetworkRouter(id, rt.id); } catch (e) { console.error('[deleteNetwork] router:', e.message); }
            }
        }
    }
    const resp = await netbirdReq('DELETE', '/api/networks/' + encodeURIComponent(id));
    if (!resp || (resp.status >= 300 && resp.status !== 404)) {
        const msg = (resp && resp.body && (resp.body.message || resp.body.error)) || (resp && resp.raw) || (resp && resp.error) || 'network may still be in use';
        throw new Error(typeof msg === 'string' ? msg : String(msg));
    }
    bustNbCaches('policies', 'gref', 'usage');
    return { ok: true };
}

async function getNetworks() {
    const nets = await fetchNetworksFromApi();
    if (!nets) return [];
    const dupOk = new Set(await getDupAllowedNetworkIds());
    return nets.map(n => ({
        id: n.id,
        name: n.name || '',
        description: n.description || '',
        resources: Array.isArray(n.resources) ? n.resources.length : 0,
        routingPeers: typeof n.routing_peers_count === 'number'
            ? n.routing_peers_count
            : (Array.isArray(n.routers) ? n.routers.length : 0),
        policies: Array.isArray(n.policies) ? n.policies.length : 0,
        allowDuplicates: dupOk.has(String(n.id)),
    })).sort((a, b) => a.name.localeCompare(b.name));
}

// The NetBird raw GET (netbirdGet) and the in-memory groups/policies caches (ensureGroupsFresh /
// ensurePoliciesFresh + NB_TTL_MS + their maps) now live in lib/netbird.js; the client and cache
// accessors are imported at the top of this file. db.js reads the groups map via getGroupsMap().

async function getPeerNames(ids) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return {};
    const r = await pool.query('SELECT peer_id, name FROM peers WHERE peer_id = ANY($1) AND tenant = $2', [list, tnt()]);
    const m = {};
    for (const row of r.rows) m[row.peer_id] = row.name;
    return m;
}

// Full detail of one network: resolved resources, routing peers and policies
async function getNetworkDetail(id) {
    const [net, resources, routers] = await Promise.all([
        netbirdGet('/api/networks/' + encodeURIComponent(id)),
        netbirdGet('/api/networks/' + encodeURIComponent(id) + '/resources'),
        netbirdGet('/api/networks/' + encodeURIComponent(id) + '/routers'),
    ]);
    await Promise.all([ensureGroupsFresh(), ensurePoliciesFresh()]);

    const routerArr = Array.isArray(routers) ? routers : [];
    const peerNames = await getPeerNames(routerArr.map(r => r.peer));

    const resourceList = (Array.isArray(resources) ? resources : []).map(r => ({
        id: r.id,
        name: r.name || '',
        address: r.address || '',
        type: r.type || '',
        description: r.description || '',
        enabled: r.enabled !== false,
        groups: Array.isArray(r.groups) ? r.groups.map(g => ({ id: (g && g.id) || g, name: (g && g.name) || g })) : [],
    }));

    // Attach the policies that grant access to each resource. A policy is "direct"
    // when it targets the resource via destinationResource (the app manages these);
    // it is "inherited" when it targets a group the resource belongs to (shared,
    // shown read-only so the view matches the NetBird portal).
    const rawPolicies = await netbirdGet('/api/policies');
    const polArr = Array.isArray(rawPolicies) ? rawPolicies : [];
    const gidOf = x => (x && x.id) || x;
    for (const r of resourceList) {
        const groupNames = {};
        for (const g of r.groups) groupNames[g.id] = g.name;
        const directRule = (rule) => { const dr = rule.destinationResource; return !!(dr && gidOf(dr) === r.id); };
        const inheritedVia = (rule) => (rule.destinations || []).map(gidOf).find(gid => groupNames[gid] !== undefined);

        r.policies = polArr
            .filter(p => (p.rules || []).some(rule => directRule(rule) || inheritedVia(rule)))
            .map(p => {
                const rule = (p.rules || []).find(ru => directRule(ru) || inheritedVia(ru)) || (p.rules || [])[0] || {};
                const direct = directRule(rule);
                const viaGid = direct ? null : inheritedVia(rule);
                return {
                    id: p.id,
                    name: p.name || p.id,
                    enabled: p.enabled !== false,
                    protocol: rule.protocol || 'all',
                    ports: mergeRulePorts(rule),
                    sources: (rule.sources || []).map(s => ({ id: gidOf(s), name: (s && s.name) || getGroupsMap()[gidOf(s)] || gidOf(s) })),
                    // Extra fields the shared policy editor round-trips for DIRECT policies.
                    description: p.description || '',
                    bidirectional: !!rule.bidirectional,
                    postureChecks: Array.isArray(p.source_posture_checks)
                        ? p.source_posture_checks.map(c => (typeof c === 'string' ? c : (c && c.id))).filter(Boolean)
                        : [],
                    inherited: !direct,
                    viaGroup: viaGid ? (groupNames[viaGid] || '') : '',
                    // Several rules, an SSH / unmodeled rule, a Drop rule or a rule whose status
                    // differs: the resource editor can't reproduce it (Duplicate skips it, Save refuses).
                    ...((p.rules || []).length > 1 || (p.rules || []).some(ru => ruleHasUnmodeled(ru) || (ru.action || 'accept') !== 'accept' || (ru.enabled !== false) !== (p.enabled !== false))
                        ? { notReproducible: true } : {}),
                };
            });
    }

    const routerList = routerArr.map(r => ({
        id: r.id,
        enabled: r.enabled !== false,
        masquerade: !!r.masquerade,
        metric: r.metric,
        peer: r.peer ? (peerNames[r.peer] || r.peer) : '',
        // Raw ids alongside the display names, so the UI can LINK to the peer/group pages.
        peerId: r.peer || '',
        peerGroups: Array.isArray(r.peer_groups) ? r.peer_groups.map(gid => getGroupsMap()[gid] || gid) : [],
        peerGroupRefs: Array.isArray(r.peer_groups) ? r.peer_groups.map(gid => ({ id: gid, name: getGroupsMap()[gid] || gid })) : [],
    }));

    // Policies that belong to this network - resolve each rule's source/destination
    // groups to {id,name,peers_count,resources_count} so the UI can link + show counts.
    const gmap = await getGroupRefMap();
    const polById = {};
    for (const p of polArr) if (p && p.id) polById[p.id] = p;
    const policyIds = (net && Array.isArray(net.policies)) ? net.policies : [];
    const policyList = policyIds.map(pid => {
        const p = polById[pid];
        if (!p) return { name: pid, enabled: true, description: '', rules: [] };
        return {
            name: p.name || pid,
            enabled: p.enabled !== false,
            description: p.description || '',
            rules: (Array.isArray(p.rules) ? p.rules : []).map(rule => ({
                action: rule.action || 'accept',
                protocol: rule.protocol || 'all',
                ports: Array.isArray(rule.ports) ? rule.ports : [],
                bidirectional: !!rule.bidirectional,
                enabled: rule.enabled !== false,
                sources: resolvePolicyGroups(rule.sources, gmap),
                destinations: resolvePolicyGroups(rule.destinations, gmap),
            })),
        };
    });

    return {
        id,
        name: net ? (net.name || '') : '',
        description: net ? (net.description || '') : '',
        resources: resourceList,
        routers: routerList,
        policies: policyList,
        allowDuplicates: (await getDupAllowedNetworkIds()).includes(String(id)),
    };
}

// All access-control policies (read-only overview page). Each rule's source/destination
// groups are resolved to {id,name,peers_count,resources_count} like getNetworkDetail,
// and port_ranges are merged into the ports list for display.
// A rule's destinationResource (single-resource target) → { id, name, type }, name resolved
// from the resources list. Policies created for a specific resource (e.g. temporary access)
// target the resource directly, not a group.
function resolveDestinationResource(rule, resMap) {
    const dr = rule && rule.destinationResource;
    if (!dr) return null;
    const id = (dr && dr.id) || dr;
    if (!id) return null;
    const r = resMap.get(id);
    return { id: String(id), name: (r && (r.name || r.address)) || String(id), type: (dr && dr.type) || (r && r.type) || '' };
}

async function getAllPolicies() {
    const raw = await netbirdGet('/api/policies');
    const arr = Array.isArray(raw) ? raw : [];
    const gmap = await getGroupRefMap();
    const usage = await getUsageData();
    const resMap = new Map((usage.resources || []).map(r => [r.id, r]));
    // Policies owned by a shared Access Profile get labeled - they're managed from the
    // profile (editing them directly would be overwritten on the next profile save).
    const profByPolicy = new Map();
    await pool.query(`SELECT name, policy_id FROM access_profiles WHERE shared IS NOT FALSE AND policy_id IS NOT NULL AND tenant = $1`, [tnt()])
        .then(r => r.rows.forEach(x => profByPolicy.set(x.policy_id, x.name)))
        .catch(() => { });
    return arr.map(p => ({
        id: p.id || p.name || '',
        name: p.name || '',
        profileName: profByPolicy.get(p.id) || undefined,
        description: p.description || '',
        enabled: p.enabled !== false,
        postureChecks: Array.isArray(p.source_posture_checks)
            ? p.source_posture_checks.map(c => (typeof c === 'string' ? c : (c && c.id))).filter(Boolean)
            : [],
        rules: (Array.isArray(p.rules) ? p.rules : []).map(rule => ({
            action: rule.action || 'accept',
            protocol: rule.protocol || 'all',
            ports: mergeRulePorts(rule),
            bidirectional: !!rule.bidirectional,
            enabled: rule.enabled !== false,
            sources: resolvePolicyGroups(rule.sources, gmap),
            destinations: resolvePolicyGroups(rule.destinations, gmap),
            destinationResource: resolveDestinationResource(rule, resMap),
            // Duplicate copies such rules verbatim instead of rebuilding them from the form.
            ...(ruleHasUnmodeled(rule) ? { unmodeled: true } : {}),
        })),
    }));
}

// splitPortTokens and mergeRulePorts now live in lib/pure.js (imported at the top).

// Build a single NetBird policy rule from the admin editor payload. Sources/destinations
// are group ids; ports only apply to tcp/udp.
// The protocol a single-rule editor payload asks for. Absent = 'all' (the editors' default); any
// other value it can't express (e.g. a pasted netbird-ssh) is refused - silently widening it to
// 'all' would turn an SSH rule into allow-all traffic.
function editorProtocol(protocol) {
    if (protocol == null || protocol === '') return 'all';
    if (['tcp', 'udp', 'all', 'icmp'].includes(protocol)) return protocol;
    const e = new Error(`The "${protocol}" protocol can't be set from this editor. Create or edit that rule in the NetBird dashboard.`);
    e.status = 400;
    throw e;
}
function buildPolicyRule({ name, description, enabled, protocol, ports, bidirectional, sources, destinations, destinationResource }) {
    const proto = editorProtocol(protocol);
    const { ports: plainPorts, portRanges } = (proto === 'tcp' || proto === 'udp')
        ? splitPortTokens(ports) : { ports: [], portRanges: [] };
    const rule = {
        name: name || '',
        description: description || '',
        enabled: enabled !== false,
        action: 'accept',
        bidirectional: !!bidirectional,
        protocol: proto,
        ports: plainPorts,
        sources: (Array.isArray(sources) ? sources : []).filter(Boolean),
    };
    // A rule targets EITHER a single resource (destinationResource) OR groups (destinations).
    // Preserve a resource target so editing other fields never wipes it.
    if (destinationResource && destinationResource.id) {
        rule.destinationResource = destinationResource.type ? { id: destinationResource.id, type: destinationResource.type } : { id: destinationResource.id };
    } else {
        rule.destinations = (Array.isArray(destinations) ? destinations : []).filter(Boolean);
    }
    if (portRanges.length) rule.port_ranges = portRanges;
    return rule;
}

function policyBody(cfg) {
    return {
        name: (cfg && cfg.name) || '',
        description: (cfg && cfg.description) || '',
        enabled: !cfg || cfg.enabled !== false,
        source_posture_checks: Array.isArray(cfg && cfg.postureChecks) ? cfg.postureChecks.filter(Boolean) : [],
        rules: [buildPolicyRule(cfg || {})],
    };
}

// Create / update / delete an access-control policy directly in NetBird (admin only).
// Policy mutations change group usage counts, so reset the policy/usage caches.
async function createPolicy(cfg) {
    let body;
    // Duplicate: copy the SOURCE policy's rules verbatim (per-rule enabled/action, SSH
    // authorized_groups, sourceResource, port ranges, ...) instead of rebuilding one rule from the
    // single-rule form - only name / description / enabled / posture come from the form. Read in
    // the current account context, so a tenant can only duplicate its own policies. The form's rule
    // fields are never parsed on this path (they may hold a protocol the editor can't express).
    if (cfg && cfg.rulesFromPolicyId) {
        const src = await netbirdGet('/api/policies/' + encodeURIComponent(String(cfg.rulesFromPolicyId))).catch(() => null);
        if (!src || !Array.isArray(src.rules) || !src.rules.length) throw new Error('The policy to duplicate was not found');
        body = {
            name: cfg.name || '', description: cfg.description || '', enabled: cfg.enabled !== false,
            source_posture_checks: Array.isArray(cfg.postureChecks) ? cfg.postureChecks.filter(Boolean) : [],
            rules: src.rules.map(ruleForPut),
        };
    } else {
        body = policyBody(cfg);
    }
    const resp = await netbirdPost('/api/policies', body);
    if (!resp || resp.status >= 300 || !resp.body || !resp.body.id) {
        throw new Error('Failed to create policy: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    bustNbCaches('policies', 'gref', 'usage');
    return { id: resp.body.id };
}

// Normalize a NetBird rule (as returned by GET) back into PUT shape (group objects → id arrays),
// keeping a resource target and multiple rules intact. Fields this app doesn't model
// (sourceResource, authorized_groups, anything NetBird adds later) are carried verbatim so a
// "keep the rules as they are" PUT never strips them. `id` stays omitted, as before.
const RULE_PUT_MODELED = new Set(['id', 'name', 'description', 'enabled', 'action', 'bidirectional', 'protocol', 'ports', 'port_ranges', 'sources', 'destinations', 'destinationResource']);
// A value that carries no meaning for NetBird (absent / null / '' / [] / {}).
const isEmptyRuleValue = v => v == null || v === '' || (Array.isArray(v) ? !v.length : (typeof v === 'object' && !Object.keys(v).length));
// Protocols the single-rule editor can express (buildPolicyRule maps anything else to 'all').
const EDITOR_PROTOCOLS = new Set(['tcp', 'udp', 'all', 'icmp']);
// True when the single-rule editor can't reproduce a GET rule exactly: a field it doesn't show
// (SSH authorized_groups, sourceResource, anything NetBird adds later) or a protocol it can't
// express (e.g. netbird-ssh). Such rules are then kept verbatim instead of being rebuilt.
function ruleHasUnmodeled(r) {
    if (r && r.protocol && !EDITOR_PROTOCOLS.has(String(r.protocol))) return true;
    return Object.entries(r || {}).some(([k, v]) => !RULE_PUT_MODELED.has(k) && !isEmptyRuleValue(v));
}
// Carry the stored rule's unmodeled fields onto a rule rebuilt by the single-rule editor; the
// rebuilt (edited) fields win. A rule has EITHER group sources OR a sourceResource, so an edit
// that sets group sources drops the stored sourceResource.
function carryRuleExtras(existing, built) {
    if (!existing || typeof existing !== 'object') return built;
    const extra = Object.fromEntries(Object.entries(existing).filter(([k]) => !RULE_PUT_MODELED.has(k)));
    const out = { ...extra, ...built };
    if (Array.isArray(built.sources) && built.sources.length) delete out.sourceResource;
    else if (out.sourceResource && !isEmptyRuleValue(out.sourceResource)) delete out.sources;
    else delete out.sourceResource;
    return out;
}
function ruleForPut(r) {
    const gid = g => (g && g.id) || g;
    const out = {
        ...Object.fromEntries(Object.entries(r || {}).filter(([k]) => !RULE_PUT_MODELED.has(k))),
        name: r.name || '', description: r.description || '', enabled: r.enabled !== false,
        action: r.action || 'accept', bidirectional: !!r.bidirectional, protocol: r.protocol || 'all',
        ports: Array.isArray(r.ports) ? r.ports : [],
    };
    // A rule's source is EITHER one resource (sourceResource) OR groups - NetBird rejects a body that
    // carries both, even with an empty group list.
    delete out.sourceResource;
    if (r.sourceResource && !isEmptyRuleValue(r.sourceResource)) {
        const sr = r.sourceResource;
        out.sourceResource = sr.type ? { id: gid(sr), type: sr.type } : { id: gid(sr) };
    } else {
        out.sources = (Array.isArray(r.sources) ? r.sources : []).map(gid).filter(Boolean);
    }
    if (Array.isArray(r.port_ranges) && r.port_ranges.length) out.port_ranges = r.port_ranges;
    if (r.destinationResource) {
        const dr = r.destinationResource;
        out.destinationResource = dr.type ? { id: gid(dr), type: dr.type } : { id: gid(dr) };
    } else {
        out.destinations = (Array.isArray(r.destinations) ? r.destinations : []).map(gid).filter(Boolean);
    }
    return out;
}

async function updatePolicy(id, cfg) {
    let body;
    // Both paths start from the STORED policy. A failed or empty read stops here, before any write:
    // rebuilding without it would drop the rules' unmodeled fields and skip the guards below.
    const existing = await netbirdGet('/api/policies/' + encodeURIComponent(id)).catch(() => null);
    if (!existing || !Array.isArray(existing.rules) || !existing.rules.length) {
        const e = new Error("Couldn't read this policy's current rules from NetBird - nothing was changed. Try again.");
        e.status = 502;
        throw e;
    }
    // preserveRules: keep the policy's existing rules verbatim (multi-rule / resource-targeting
    // policies the single-rule editor can't represent) and only change name/description/enabled/posture.
    if (cfg && cfg.preserveRules) {
        body = {
            name: cfg.name || existing.name || '',
            description: cfg.description || '',
            enabled: cfg.enabled !== false,
            source_posture_checks: Array.isArray(cfg.postureChecks) ? cfg.postureChecks.filter(Boolean) : (existing.source_posture_checks || []),
            rules: existing.rules.map(ruleForPut),
        };
    } else {
        // The single-rule editor rebuilds ONE accept rule that follows the policy's status. Refuse a
        // rebuild that would silently change what the stored rules allow - several rules merged into
        // one, a protocol it can't express (an SSH rule would become allow-all), a Drop rule turned
        // into Accept, or a disabled rule switched on. Such policies are edited with preserveRules.
        const r0 = existing.rules[0];
        const refuse = (why) => { const e = new Error(`${why} Edit its rules in the NetBird dashboard.`); e.status = 400; throw e; };
        if (existing.rules.length > 1) refuse('This policy has several rules, which this editor can\'t change.');
        if (r0.protocol && !EDITOR_PROTOCOLS.has(String(r0.protocol))) refuse(`This policy uses the "${r0.protocol}" protocol, which this editor can't change.`);
        if ((r0.action || 'accept') !== 'accept') refuse('This policy has a Drop rule, which this editor can\'t change.');
        if ((r0.enabled !== false) !== (existing.enabled !== false)) refuse('This policy has a rule whose status differs from the policy, which this editor can\'t change.');
        // Carry what the editor doesn't model (SSH authorized_groups, future fields) from the stored rule.
        body = policyBody(cfg);
        body.rules = [carryRuleExtras(r0, body.rules[0])];
    }
    const resp = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(id), body);
    if (!resp || resp.status >= 300) {
        throw new Error('Failed to update policy: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    bustNbCaches('policies', 'gref', 'usage');
    return { id };
}

// ─── Tidy policy names: align existing RESOURCE policies with the naming template ───
// Eligible = single-rule policies whose rule targets a resource (destinationResource),
// excluding Access-Profile-owned and temporary-grant policies (both are app-managed).
// Group-destination policies are excluded too - the template's {resource} has no meaning there.
// The "service" behind a policy name: the current name minus generic trailing words
// (Policy / Access / Rule) and a trailing protocol suffix. On a SHARED resource (many port
// policies on one host) this is the only place the service identity lives - Tidy cleans it
// instead of replacing it, so "Adgar Host1 Access" tidies to "Adgar Host1".
function serviceNameFromPolicy(name) {
    const orig = String(name || '').trim();
    let s = orig.replace(/\s*\((tcp|udp|icmp|all)[^)]*\)\s*$/i, '').trim();
    let prev;
    do { prev = s; s = s.replace(/\s+(policy|policies|access|rule|rules)\s*$/i, '').trim(); } while (s !== prev);
    return s || orig;
}

async function policyRenamePlan() {
    const tplRaw = await getSetting('policy_name_template');
    const template = String(tplRaw || '').trim() || '{resource} Policy';
    // Shared-resource tier: a resource with 2+ direct policies keeps per-policy identity -
    // the default template is just the cleaned current name ({service}).
    const sharedTplRaw = await getSetting('policy_name_template_shared');
    const sharedTemplate = String(sharedTplRaw || '').trim() || '{service}';
    const raw = await netbirdGet('/api/policies');
    const arr = Array.isArray(raw) ? raw : [];
    const usage = await getUsageData();
    const resName = new Map((usage.resources || []).map(r => [r.id, r.name || '']));
    const profilePolicyIds = new Set();
    await pool.query(`SELECT policy_id FROM access_profiles WHERE policy_id IS NOT NULL AND tenant = $1`, [tnt()])
        .then(r => r.rows.forEach(x => profilePolicyIds.add(x.policy_id)))
        .catch(() => { });
    // How many LASTING policies target each resource directly - decides the naming tier.
    // Temporary-grant and Access-Profile policies don't count: a passing grant must not
    // flip a normal resource into the "shared" tier.
    const ridCounts = new Map();
    for (const p of arr) {
        if (!p || profilePolicyIds.has(p.id) || /^Temporary access #\d+/.test(p.name || '')) continue;
        const rules = Array.isArray(p.rules) ? p.rules : [];
        const dr = rules.length === 1 && rules[0] && rules[0].destinationResource;
        const rid = dr && ((dr.id) || dr);
        if (rid) ridCounts.set(rid, (ridCounts.get(rid) || 0) + 1);
    }
    const items = [];
    let excluded = 0;
    for (const p of arr) {
        if (!p || !p.id) continue;
        if (profilePolicyIds.has(p.id) || /^Temporary access #\d+/.test(p.name || '')) { excluded++; continue; }
        const rules = Array.isArray(p.rules) ? p.rules : [];
        const dr = rules.length === 1 && rules[0] && rules[0].destinationResource;
        const rid = dr && ((dr.id) || dr);
        if (!rid) { excluded++; continue; }
        const rname = resName.get(rid);
        if (!rname) { excluded++; continue; } // resource unknown (stale policy) - don't guess
        const proto = (rules[0].protocol || 'all').toUpperCase();
        const shared = (ridCounts.get(rid) || 0) >= 2;
        const proposed = (shared ? sharedTemplate : template)
            .replace(/\{service\}/gi, serviceNameFromPolicy(p.name))
            .replace(/\{resource\}/gi, rname)
            .replace(/\{protocol\}/gi, proto)
            .trim();
        if (!proposed) continue;
        items.push({
            id: p.id, rid, currentName: p.name || '', proposedName: proposed,
            resourceName: rname, protocol: proto, shared, changed: proposed !== (p.name || ''),
        });
    }
    // Collision guard: two policies of ONE resource proposing the same name means the
    // template can't represent what distinguishes them - drop the whole group rather than
    // flatten distinct services into identical names.
    const byTarget = new Map();
    for (const it of items) {
        const k = `${it.rid}${it.proposedName.toLowerCase()}`;
        if (!byTarget.has(k)) byTarget.set(k, []);
        byTarget.get(k).push(it);
    }
    let excludedCollisions = 0;
    const colliding = new Set();
    for (const group of byTarget.values()) {
        if (group.length >= 2) { excludedCollisions += group.length; group.forEach(it => colliding.add(it.id)); }
    }
    const finalItems = items.filter(it => !colliding.has(it.id)).map(({ rid: _rid, ...it }) => it);
    return { template, sharedTemplate, items: finalItems, excluded, excludedCollisions };
}

// Rename the selected policies to their template names. Re-plans first (like blocklist
// enforce) so it only ever acts on the CURRENT proposal, and rewrites each policy with its
// full existing body (rules/posture/description preserved verbatim, only the name changes).
async function applyPolicyRenames(ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
    if (!want.size) throw new Error('ids is required');
    const { items } = await policyRenamePlan();
    let renamed = 0;
    const errors = [];
    for (const it of items) {
        if (!want.has(String(it.id)) || !it.changed) continue;
        try {
            const existing = await netbirdGet('/api/policies/' + encodeURIComponent(it.id));
            if (!existing || !Array.isArray(existing.rules)) throw new Error('policy not found');
            const body = {
                name: it.proposedName,
                description: existing.description || '',
                enabled: existing.enabled !== false,
                source_posture_checks: (Array.isArray(existing.source_posture_checks) ? existing.source_posture_checks : [])
                    .map(c => (typeof c === 'string' ? c : (c && c.id))).filter(Boolean),
                rules: existing.rules.map(ruleForPut),
            };
            const resp = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(it.id), body);
            if (!resp || resp.status >= 300) throw new Error((resp && (resp.raw || resp.error || String(resp.status))) || 'update failed');
            renamed++;
        } catch (e) {
            errors.push({ id: it.id, name: it.currentName, error: e.message });
        }
    }
    bustNbCaches('policies', 'gref', 'usage');
    return { renamed, failed: errors.length, errors };
}

async function deletePolicy(id) {
    const resp = await netbirdReq('DELETE', '/api/policies/' + encodeURIComponent(id));
    if (!resp || (resp.status >= 300 && resp.status !== 404)) {
        throw new Error('Failed to delete policy: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    bustNbCaches('policies', 'gref', 'usage');
    return { ok: true };
}

// ─── Network edit permissions (network_grants: network ↔ AD group) ───

// { network_id: [group_id, ...] } - scoped: a tenant's grants never mix with main's.
async function getAllGrants() {
    const r = await pool.query('SELECT network_id, group_id, access, policy_source FROM network_grants WHERE tenant = $1', [tnt()]);
    const m = {};
    for (const row of r.rows) {
        (m[row.network_id] = m[row.network_id] || []).push({
            id: row.group_id,
            // 'source' = grantable-only: pickable as a policy source by the network's
            // editors, but grants NO edit/view rights on the network itself.
            access: row.access === 'view' ? 'view' : row.access === 'source' ? 'source' : 'edit',
            policySource: row.policy_source !== false, // edit grants only; TRUE = added to new policies
        });
    }
    return m;
}

// Per-network default Access Profiles (shared profiles pre-selected on new resources).
async function getNetworkDefaultProfiles(networkId) {
    const r = await pool.query('SELECT profile_id FROM network_default_profiles WHERE tenant = $2 AND network_id = $1', [networkId, tnt()]);
    return r.rows.map(x => x.profile_id);
}

// { network_id: [profile_id, ...] }
async function getAllNetworkDefaultProfiles() {
    const r = await pool.query('SELECT network_id, profile_id FROM network_default_profiles WHERE tenant = $1', [tnt()]);
    const m = {};
    for (const row of r.rows) (m[row.network_id] = m[row.network_id] || []).push(row.profile_id);
    return m;
}

async function setNetworkDefaultProfiles(networkId, profileIds) {
    const ids = [...new Set((profileIds || []).map(Number).filter(n => Number.isInteger(n)))];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM network_default_profiles WHERE tenant = $2 AND network_id = $1', [networkId, tnt()]);
        for (const pid of ids) {
            await client.query('INSERT INTO network_default_profiles (tenant, network_id, profile_id) VALUES ($3, $1, $2) ON CONFLICT DO NOTHING', [networkId, pid, tnt()]);
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
    return ids;
}

// Replace the set of AD groups allowed to edit a network.
// grants: [{ id, access, policySource }] - access 'edit', 'view' or 'source'. A group listed
// twice keeps the first (stronger) entry. policySource (edit grants; default true) controls
// whether the group is auto-added as a source of NEW policies. 'source' rows grant NOTHING
// on the network - they only appear in the editors' policy-source picker (grantable groups).
async function setNetworkGrants(networkId, grants) {
    const seen = new Set();
    const rows = [];
    for (const g of (grants || [])) {
        const id = g && g.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const access = g.access === 'view' ? 'view' : g.access === 'source' ? 'source' : 'edit';
        rows.push({ id, access, policySource: access === 'source' ? false : g.policySource !== false });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM network_grants WHERE tenant = $2 AND network_id = $1', [networkId, tnt()]);
        for (const row of rows) {
            await client.query(
                'INSERT INTO network_grants (tenant, network_id, group_id, access, policy_source, updated_at) VALUES ($5, $1, $2, $3, $4, NOW()) ON CONFLICT DO NOTHING',
                [networkId, row.id, row.access, row.policySource, tnt()]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
    return rows;
}

// AD-synced NetBird groups → [{ id: <ad-object-id>, name }] for the grant picker.
// NetBird represents IdP groups as "oauth2|azure-oauth2|<ad-object-id>"; the suffix
// is the Azure object id, which matches the ids Graph returns for a user's groups.
async function getAdGroups() {
    const groups = await netbirdGet('/api/groups');
    if (!Array.isArray(groups)) return [];
    return groups
        .filter(g => g && typeof g.id === 'string' && g.id.includes('|'))
        .map(g => ({ id: g.id.split('|').pop(), name: g.name || g.id }))
        .filter(g => /^[0-9a-fA-F-]{20,}$/.test(g.id))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Resource templates (admin-defined, DB-backed) ───
function parsePorts(s) {
    return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

async function getTemplates() {
    const r = await pool.query('SELECT id, name, protocol, ports, description FROM templates ORDER BY sort_order, id');
    return r.rows.map(t => ({
        id: t.id,
        name: t.name,
        protocol: t.protocol || 'all',
        ports: parsePorts(t.ports),
        description: t.description || '',
    }));
}

async function getTemplate(id) {
    const r = await pool.query('SELECT id, name, protocol, ports, description FROM templates WHERE id = $1', [id]);
    if (!r.rows.length) return null;
    const t = r.rows[0];
    return { id: t.id, name: t.name, protocol: t.protocol || 'all', ports: parsePorts(t.ports), description: t.description || '' };
}

async function createTemplate({ name, protocol, ports, description }) {
    const r = await pool.query(
        `INSERT INTO templates (name, protocol, ports, description, sort_order)
         VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order),0)+1 FROM templates)) RETURNING id`,
        [name, protocol || 'all', Array.isArray(ports) ? ports.join(',') : (ports || ''), description || '']
    );
    return getTemplate(r.rows[0].id);
}

async function updateTemplate(id, { name, protocol, ports, description }) {
    await pool.query(
        `UPDATE templates SET name = $2, protocol = $3, ports = $4, description = $5 WHERE id = $1`,
        [id, name, protocol || 'all', Array.isArray(ports) ? ports.join(',') : (ports || ''), description || '']
    );
    return getTemplate(id);
}

async function deleteTemplate(id) {
    await pool.query('DELETE FROM templates WHERE id = $1', [id]);
}

// ─── Access Profiles (a named {source groups + protocol/ports} → group + policy) ───
function buildProfileRule(name, groupId, sources, protocol, ports) {
    const proto = ['tcp', 'udp', 'all', 'icmp'].includes(protocol) ? protocol : 'all';
    const { ports: plain, portRanges } = (proto === 'tcp' || proto === 'udp')
        ? splitPortTokens(ports) : { ports: [], portRanges: [] };
    const rule = {
        name, enabled: true, action: 'accept', bidirectional: false,
        protocol: proto,
        ports: plain,
        sources: (sources || []).filter(Boolean),
        destinations: [groupId],
    };
    if (portRanges.length) rule.port_ranges = portRanges;
    return rule;
}

async function listAccessProfiles() {
    const r = await pool.query('SELECT id, name, group_id, policy_id, sources, protocol, ports, shared, posture_checks FROM access_profiles WHERE tenant = $1 ORDER BY shared DESC, name', [tnt()]);
    const gmap = await getGroupRefMap();
    return r.rows.map(p => {
        const srcIds = Array.isArray(p.sources) ? p.sources : [];
        const grp = gmap[p.group_id];
        return {
            id: p.id,
            name: p.name,
            shared: p.shared !== false,
            groupId: p.group_id || '',
            sources: srcIds.map(id => ({ id, name: (gmap[id] && gmap[id].name) || id })),
            protocol: p.protocol || 'all',
            ports: parsePorts(p.ports),
            postureChecks: Array.isArray(p.posture_checks) ? p.posture_checks : [],
            resourceCount: (p.shared !== false && grp) ? (grp.resources_count || 0) : 0,
        };
    });
}

async function createAccessProfile({ name, shared = true, sources, protocol, ports, postureChecks }) {
    const portsStr = Array.isArray(ports) ? ports.join(',') : (ports || '');
    const pc = Array.isArray(postureChecks) ? postureChecks.filter(Boolean) : [];
    // Direct profile = a protocol/ports preset, no NetBird group/policy.
    if (shared === false) {
        const row = await pool.query(
            `INSERT INTO access_profiles (name, group_id, policy_id, sources, protocol, ports, shared, tenant)
             VALUES ($1, '', '', '[]'::jsonb, $2, $3, false, $4) RETURNING id`,
            [name, protocol || 'all', portsStr, tnt()]
        );
        return { id: row.rows[0].id, groupId: '' };
    }
    // Shared profile = group + policy (sources → group), optionally gated by posture checks.
    const grp = await netbirdPost('/api/groups', { name });
    if (!grp || grp.status >= 300 || !grp.body || !grp.body.id) {
        throw new Error('Failed to create group: ' + (grp && (grp.raw || grp.error || grp.status)));
    }
    const groupId = grp.body.id;
    const rule = buildProfileRule(name, groupId, sources, protocol, ports);
    const pol = await netbirdPost('/api/policies', { name: `${name} Access`, description: '', enabled: true, source_posture_checks: pc, rules: [rule] });
    if (!pol || pol.status >= 300 || !pol.body || !pol.body.id) {
        await netbirdReq('DELETE', '/api/groups/' + encodeURIComponent(groupId)).catch(() => { });
        throw new Error('Failed to create policy: ' + (pol && (pol.raw || pol.error || pol.status)));
    }
    const row = await pool.query(
        `INSERT INTO access_profiles (name, group_id, policy_id, sources, protocol, ports, shared, posture_checks, tenant)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8) RETURNING id`,
        [name, groupId, pol.body.id, JSON.stringify((sources || []).filter(Boolean)), protocol || 'all', portsStr, JSON.stringify(pc), tnt()]
    );
    bustNbCaches('policies', 'gref', 'usage');
    return { id: row.rows[0].id, groupId };
}

async function updateAccessProfile(id, { name, sources, protocol, ports, postureChecks }) {
    const r = await pool.query('SELECT group_id, policy_id, shared FROM access_profiles WHERE id = $1 AND tenant = $2', [id, tnt()]);
    if (!r.rows.length) throw new Error('Profile not found');
    const { group_id, policy_id, shared } = r.rows[0];
    const pc = Array.isArray(postureChecks) ? postureChecks.filter(Boolean) : [];
    // Shared profiles push the change to their NetBird policy; Direct presets are local.
    if (shared !== false) {
        const rule = buildProfileRule(name, group_id, sources, protocol, ports);
        const resp = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(policy_id), { name: `${name} Access`, description: '', enabled: true, source_posture_checks: pc, rules: [rule] });
        if (!resp || resp.status >= 300) throw new Error('Failed to update policy: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    await pool.query(
        `UPDATE access_profiles SET name = $2, sources = $3, protocol = $4, ports = $5, posture_checks = $6 WHERE id = $1 AND tenant = $7`,
        [id, name, JSON.stringify(shared !== false ? (sources || []).filter(Boolean) : []), protocol || 'all', Array.isArray(ports) ? ports.join(',') : (ports || ''), JSON.stringify(shared !== false ? pc : []), tnt()]
    );
    bustNbCaches('policies', 'gref', 'usage');
}

// ─── Posture Checks (proxied to the NetBird Management API) ───
async function listPostureChecks() {
    const arr = await netbirdGet('/api/posture-checks');
    return Array.isArray(arr) ? arr : [];
}

async function createPostureCheck(body) {
    const r = await netbirdPost('/api/posture-checks', body);
    if (!r || r.status >= 300 || !r.body) throw new Error('Failed to create posture check: ' + (r && (r.raw || r.error || r.status)));
    return r.body;
}

async function updatePostureCheck(id, body) {
    const r = await netbirdReq('PUT', '/api/posture-checks/' + encodeURIComponent(id), body);
    if (!r || r.status >= 300) throw new Error('Failed to update posture check: ' + (r && (r.raw || r.error || r.status)));
    return r.body;
}

async function deletePostureCheck(id) {
    const r = await netbirdReq('DELETE', '/api/posture-checks/' + encodeURIComponent(id));
    if (!r || r.status >= 300) throw new Error('Failed to delete posture check: ' + (r && (r.raw || r.error || r.status)));
}

async function getCountries() {
    const arr = await netbirdGet('/api/locations/countries');
    return Array.isArray(arr) ? arr : [];
}

async function getCities(country) {
    const arr = await netbirdGet('/api/locations/countries/' + encodeURIComponent(country) + '/cities');
    return Array.isArray(arr) ? arr : [];
}

async function deleteAccessProfile(id) {
    const r = await pool.query('SELECT group_id, policy_id, shared FROM access_profiles WHERE id = $1 AND tenant = $2', [id, tnt()]);
    if (!r.rows.length) return;
    const { group_id, policy_id, shared } = r.rows[0];
    if (shared !== false) {
        await netbirdReq('DELETE', '/api/policies/' + encodeURIComponent(policy_id)).catch(() => { });
        await netbirdReq('DELETE', '/api/groups/' + encodeURIComponent(group_id)).catch(() => { });
    }
    await pool.query('DELETE FROM network_default_profiles WHERE profile_id = $1 AND tenant = $2', [id, tnt()]);
    await pool.query('DELETE FROM access_profiles WHERE id = $1 AND tenant = $2', [id, tnt()]);
    bustNbCaches('policies', 'gref', 'usage');
}

// The event filter-rules block (the _filterCache + invalidateFilterCache, getFilterConfig,
// getFilterRules, createFilterRule, updateFilterRule, deleteFilterRule) and the admin scan/delete
// tools (scanEvents, deleteEventsByIds) now live in lib/events.js; the exported ones are imported
// at the top of this file. events.js registers invalidateFilterCache with core.onSettingChange so
// setSetting keeps busting the cache as before.

// getSetting/setSetting now live in lib/core.js (imported + re-exported above). setSetting's
// filter-cache invalidation is preserved by lib/events.js via core.onSettingChange(invalidateFilterCache).

// ─── App audit log (every change made through this app) ───
async function recordAudit(entry) {
    const { actorId, actorEmail, actorName, action, target, meta } = entry || {};
    try {
        await pool.query(
            `INSERT INTO app_audit (actor_id, actor_email, actor_name, action, target, meta, tenant)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [actorId || '', actorEmail || '', actorName || '', action, target || '', meta ? JSON.stringify(meta) : null, tnt()]
        );
    } catch (e) {
        console.error('[audit] write error:', e.message);
    }
    notifyAuditTelegram(entry || {}).catch(() => { }); // fire-and-forget
    // Anomaly: a HUMAN admin action outside working hours gets a distinct alert. System
    // actors (schedulers, auto-approval, scheduled automations) run around the clock by
    // design - alerting on them is pure noise.
    const SYSTEM_ACTORS = ['Scheduler', 'Auto-approval', 'Automation', 'System'];
    if (_security.anomalyEnabled && !SYSTEM_ACTORS.includes(actorName)) {
        tzNowParts().then((now) => {
            const { workDays, workStart, workEnd } = _security;
            const offDay = !workDays.includes(now.dow);
            const offTime = workStart < workEnd
                ? (now.hour < workStart || now.hour >= workEnd)
                : (now.hour < workStart && now.hour >= workEnd);
            if (offDay || offTime) {
                sendAnomalyAlert(`🌙 <b>${offDay ? 'Non-Workday' : 'Off-Hours'} Admin Action</b>\n👤 ${tgEsc(actorName || actorEmail || 'someone')}\n⚙️ ${tgEsc(tgActionLabel(action))}${target ? `\n🎯 ${tgEsc(target)}` : ''}`);
            }
        }).catch(() => { });
    }
}

const AUDIT_SORT_COLS = { time: 'timestamp', user: 'actor_name', action: 'action', target: 'target' };
async function getAuditLog({ search, from, to, category, sort, dir, page = 1, per_page = 20 } = {}) {
    const conds = [];
    const params = [];
    let i = 1;
    // Scope to the active account - main ('') or a tenant, identically.
    conds.push(`tenant = $${i}`); params.push(tnt()); i++;
    if (search) {
        // meta::text makes the Details column searchable too (addresses, network names, counts).
        conds.push(`(action ILIKE $${i} OR target ILIKE $${i} OR actor_email ILIKE $${i} OR actor_name ILIKE $${i} OR meta::text ILIKE $${i})`);
        params.push(`%${search}%`); i++;
    }
    if (from) { conds.push(`timestamp >= $${i}`); params.push(from); i++; }
    if (to) { conds.push(`timestamp <= $${i}`); params.push(to); i++; }
    if (category) {
        const c = auditCategoryCond(category, i);
        if (c) { conds.push(c.sql); params.push(c.value); i++; }
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    // CAPPED count - see cappedCount() in lib/core.js.
    const { total, totalCapped } = await cappedCount(`SELECT 1 FROM app_audit ${where}`, params);
    const offset = (Math.max(1, page) - 1) * per_page;
    const col = AUDIT_SORT_COLS[sort];
    const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy = col ? `${col} ${d} NULLS LAST, id DESC` : `timestamp DESC`;
    const res = await pool.query(
        `SELECT id, timestamp, actor_id, actor_email, actor_name, action, target, meta
         FROM app_audit ${where} ORDER BY ${orderBy} LIMIT $${i} OFFSET $${i + 1}`,
        [...params, per_page, offset]
    );
    // Display: the stored meta.tenant is the stable id - resolve it to the tenant's name.
    const events = res.rows.map(r => (r.meta && r.meta.tenant)
        ? { ...r, meta: { ...r.meta, tenant: tenantNameOf(r.meta.tenant) } }
        : r);
    return { events, total, totalCapped, page, per_page, total_pages: Math.ceil(total / per_page) };
}

// Outbound log query (Admin → Notifications) - same server-side shape as the audit log.
const OUTBOUND_SORT_COLS = { time: 'timestamp', channel: 'channel', recipient: 'recipient', feature: 'feature', subject: 'subject' };
async function getOutboundLog({ search, channel, status, from, to, sort, dir, page = 1, per_page = 25 } = {}) {
    const conds = [];
    const params = [];
    let i = 1;
    if (search) {
        conds.push(`(recipient ILIKE $${i} OR subject ILIKE $${i} OR feature ILIKE $${i} OR error ILIKE $${i})`);
        params.push(`%${search}%`); i++;
    }
    if (channel === 'email' || channel === 'telegram') { conds.push(`channel = $${i}`); params.push(channel); i++; }
    if (status === 'sent') conds.push('ok');
    else if (status === 'failed') conds.push('NOT ok');
    if (from) { conds.push(`timestamp >= $${i}`); params.push(from); i++; }
    if (to) { conds.push(`timestamp <= $${i}`); params.push(to); i++; }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    // CAPPED count - see cappedCount() in lib/core.js.
    const { total, totalCapped } = await cappedCount(`SELECT 1 FROM outbound_log ${where}`, params);
    const offset = (Math.max(1, page) - 1) * per_page;
    const col = OUTBOUND_SORT_COLS[sort];
    const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy = col ? `${col} ${d}, id DESC` : 'timestamp DESC, id DESC';
    const res = await pool.query(
        `SELECT id, timestamp, channel, recipient, feature, subject, ok, error
         FROM outbound_log ${where} ORDER BY ${orderBy} LIMIT $${i} OFFSET $${i + 1}`,
        [...params, per_page, offset]
    );
    return { rows: res.rows, total, totalCapped, page, per_page, total_pages: Math.ceil(total / per_page) };
}
// The full rendered body of one sent message - fetched on demand for the preview modal (bodies
// are large, so they never travel in the list payload). Returns null when the row is gone.
async function getOutboundBody(id) {
    const res = await pool.query(
        `SELECT id, channel, subject, recipient, body FROM outbound_log WHERE id = $1`,
        [id]
    );
    return res.rows[0] || null;
}

// The read-only guard (NETBIRD_READONLY / readOnlyResp) and the authenticated write callers
// (netbirdPost / netbirdReq) now live in lib/netbird.js; all are imported at the top of this file.

// Resolve a configured value to a real NetBird group id. Accepts either the full
// NetBird id ("oauth2|azure-oauth2|<guid>" or a native id) or a bare Azure GUID.
async function resolveNetbirdGroupId(value) {
    if (!value) return null;
    const groups = await netbirdGet('/api/groups');
    if (!Array.isArray(groups)) return null;
    let g = groups.find(x => x && x.id === value);
    if (g) return g.id;
    g = groups.find(x => x && typeof x.id === 'string' && x.id.split('|').pop() === value);
    return g ? g.id : null;
}

// addrRange4/addressesOverlap moved to lib/blocklist.js (imported at the top) so the
// automations dry-run can predict this guard's verdict without a cycle.

// A duplicate OR overlapping address inside one network is almost always a mistake (two
// resources fighting over the same host/subnet/domain - e.g. adding 10.0.0.5 when 10.0.0.0/24
// already exists). Blocked on create/edit; `excludeId` skips the resource being edited.
async function assertAddressUniqueInNetwork(networkId, address, excludeId) {
    const cand = String(address || '').trim();
    if (!cand) return;
    // Per-network opt-out: some networks legitimately need duplicate/overlapping
    // addresses (e.g. identical private ranges behind different routing peers).
    const dupOk = await getDupAllowedNetworkIds();
    if (dupOk.includes(String(networkId))) return;
    const existing = await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources`);
    const dup = (Array.isArray(existing) ? existing : []).find(r =>
        r && r.id !== excludeId && addressesOverlap(cand, r.address));
    if (dup) {
        const exact = String(dup.address || '').trim().toLowerCase() === cand.toLowerCase();
        throw new Error(exact
            ? `A resource with this address already exists in this network: "${dup.name || dup.id}" (${dup.address})`
            : `This address overlaps an existing resource in this network: "${dup.name || dup.id}" (${dup.address})`);
    }
}

// Create a resource: a NetBird group + a network resource in that group + one access
// policy per provided entry (its source groups → the resource, with protocol/ports).
// A resource with no policies is reachable by no one (NetBird's model).
async function createClientResource(networkId, { name, address, description, groups, policies, allowBlocked }) {
    const groupIds = Array.isArray(groups) ? groups.filter(Boolean) : [];
    // Refuse an unusable policy before anything is created - never leave a resource behind.
    for (const p of (policies || [])) if (p) editorProtocol(p.protocol);
    // allowBlocked = an ADMIN acting deliberately (the route audits the override).
    if (!allowBlocked) {
        const blocked = addressBlockedForNetwork(String(address || '').trim(), networkId, await getBlocklist());
        if (blocked) throw new Error(`Address "${address}" is blocked for this network (matches "${blocked}" on the blocklist).`);
    }
    await assertAddressUniqueInNetwork(networkId, address);

    // Network resource - groups are optional (a management convenience). NetBird
    // derives host/subnet/domain from the address.
    const resp = await netbirdPost(`/api/networks/${encodeURIComponent(networkId)}/resources`, {
        name, address, description: description || '', enabled: true, groups: groupIds,
    });
    if (!resp || resp.status >= 300) {
        throw new Error('Failed to create resource: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    const resourceId = resp.body && resp.body.id;
    const resType = resp.body && resp.body.type;

    // Access policies target the resource directly (destinationResource), so they
    // work whether or not the resource is in any group.
    if (resourceId) {
        for (const p of (policies || [])) {
            if (!p || !Array.isArray(p.sources) || !p.sources.length) continue;
            await createOneResourcePolicy(name, { id: resourceId, type: resType }, p);
        }
    }

    // Refresh policy + group-ref + usage caches so detail views and Access Profile
    // resource counts reflect the new resource immediately.
    bustNbCaches('policies', 'gref', 'usage');
    return { resource: resp.body };
}

// Create a single accept policy: source groups → the resource itself. The shared policy
// editor may pass the richer fields (name/description/enabled/bidirectional/posture);
// legacy inputs without them keep the old defaults exactly.
async function createOneResourcePolicy(name, dest, p) {
    const proto = editorProtocol(p.protocol);
    const { ports, portRanges } = (proto === 'tcp' || proto === 'udp')
        ? splitPortTokens(p.ports) : { ports: [], portRanges: [] };
    const policyName = String(p.name || '').trim() || `${name} Policy`;
    const enabled = p.enabled !== false;
    const rule = {
        name: policyName, enabled, action: 'accept', bidirectional: !!p.bidirectional,
        protocol: proto,
        ports,
        sources: p.sources,
        destinationResource: dest.type ? { id: dest.id, type: dest.type } : { id: dest.id },
    };
    if (portRanges.length) rule.port_ranges = portRanges;
    const pol = await netbirdPost('/api/policies', {
        name: policyName, description: String(p.description || ''), enabled,
        source_posture_checks: Array.isArray(p.postureChecks) ? p.postureChecks.filter(Boolean) : [],
        rules: [rule],
    });
    if (!pol || !(pol.status >= 200 && pol.status < 300)) {
        throw new Error('Failed to create policy: ' + (pol && (pol.raw || pol.error || pol.status)));
    }
    return pol.body;
}

// Best-effort revert of policies a failed merge/move already re-pointed: each is PUT back
// to its pre-change rules (snapshotted via ruleForPut), so no policy is ever left pointing
// at a resource that is about to be rolled back. Reverts in reverse order; a policy that
// can't be reverted is logged loudly instead of silently swallowed.
async function revertRepointedPolicies(repointed) {
    for (const rp of [...repointed].reverse()) {
        const resp = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(rp.policy.id), {
            name: rp.policy.name, description: rp.policy.description || '', enabled: rp.policy.enabled !== false,
            source_posture_checks: Array.isArray(rp.policy.source_posture_checks) ? rp.policy.source_posture_checks : [],
            rules: rp.prevRules,
        }).catch(() => null);
        if (!resp || resp.status >= 300) {
            console.error(`[Rollback] could not revert policy "${rp.policy.name}" (${rp.policy.id}) - check it manually`);
        } else {
            rp.policy.rules = rp.prevRules; // keep the in-memory batch copy truthful
        }
    }
}

// Merge duplicate resources (SAME address) into one - ACROSS networks too. NetBird resolves
// several resources fighting over one address nondeterministically, so the fix is: re-point
// every policy that targets a "loser" directly (destinationResource - policies are
// account-wide, so this works across networks) at the survivor, move the losers' group
// memberships onto the survivor (group-targeting policies keep working), then delete the
// losers. Addresses must be identical - merging different addresses would change access.
// Cross-network consequence (the UI warns about it): all traffic to the address flows
// through the SURVIVING resource's network routing peers afterwards.
// Merge / move re-point only DESTINATION resource references. A policy that uses one of the
// affected resources as its SOURCE (rule.sourceResource) would keep pointing at a resource that
// is deleted (merge) or recreated under a new id (move), so the operation is refused up front,
// before any write. Returns the names of the blocking policies.
function policiesSourcingResources(pols, resourceIds) {
    const ids = new Set(resourceIds);
    return (Array.isArray(pols) ? pols : []).filter(p => (p && Array.isArray(p.rules) ? p.rules : []).some(r => {
        const sr = r && r.sourceResource;
        return sr && ids.has(String(sr.id || sr));
    })).map(p => p.name || p.id);
}
function refuseSourcedResources(names, verb) {
    if (!names.length) return;
    const e = new Error(`Can't ${verb}: ${names.length === 1 ? 'policy' : 'policies'} ${names.map(n => `"${n}"`).join(', ')} ${names.length === 1 ? 'uses' : 'use'} this resource as a source. Change ${names.length === 1 ? 'that policy' : 'those policies'} in the NetBird dashboard first - nothing was changed.`);
    e.status = 409;
    throw e;
}

async function mergeResources(networkId, resourceIds, keepId) {
    const ids = [...new Set((Array.isArray(resourceIds) ? resourceIds : []).map(String).filter(Boolean))];
    if (ids.length < 2) throw new Error('pick at least two resources to merge');
    // Locate every selected resource across ALL networks (a conflict cluster may span them).
    const nets = await netbirdGet('/api/networks');
    const netOf = new Map();
    for (const n of (Array.isArray(nets) ? nets : [])) {
        for (const rid of (Array.isArray(n.resources) ? n.resources : [])) netOf.set(rid, n.id);
    }
    const perNet = new Map(); // networkId → its resources[]
    const chosen = [];
    for (const rid of ids) {
        const nid = netOf.get(rid);
        if (!nid) throw new Error('one of the selected resources no longer exists');
        if (!perNet.has(nid)) {
            const rs = await netbirdGet(`/api/networks/${encodeURIComponent(nid)}/resources`);
            perNet.set(nid, Array.isArray(rs) ? rs : []);
        }
        const r = perNet.get(nid).find(x => x && x.id === rid);
        if (!r) throw new Error('one of the selected resources no longer exists');
        chosen.push({ ...r, __netId: nid });
    }
    const survivor = chosen.find(r => r.id === String(keepId)) || chosen[0];
    const addr = String(survivor.address || '').trim().toLowerCase();
    const mismatch = chosen.find(r => String(r.address || '').trim().toLowerCase() !== addr);
    if (mismatch) throw new Error(`"${mismatch.name || mismatch.id}" has a different address (${mismatch.address}) - only resources with the identical address can be merged`);
    const losers = chosen.filter(r => r.id !== survivor.id);
    const loserIds = new Set(losers.map(r => r.id));
    const crossNetwork = new Set(chosen.map(r => r.__netId)).size > 1;

    // 1. Re-point direct policies from the losers to the survivor (everything else preserved).
    //    Any failure mid-way REVERTS the policies already re-pointed, so a failed merge
    //    leaves everything exactly as it was - nothing half-applied.
    const pols = await netbirdGet('/api/policies');
    if (!Array.isArray(pols)) { const e = new Error("Couldn't read the current policies from NetBird - nothing was changed. Try again."); e.status = 502; throw e; }
    refuseSourcedResources(policiesSourcingResources(pols, [...loserIds]), 'merge');
    let movedPolicies = 0;
    const repointed = []; // { policy, prevRules } for rollback
    try {
        for (const p of (Array.isArray(pols) ? pols : [])) {
            const touches = (p.rules || []).some(rule => {
                const dr = rule && rule.destinationResource;
                return dr && loserIds.has(dr.id || dr);
            });
            if (!touches) continue;
            const prevRules = (p.rules || []).map(ruleForPut); // snapshot BEFORE the change
            const rules = (p.rules || []).map(rule => {
                const dr = rule.destinationResource;
                const rid = dr && (dr.id || dr);
                const out = {
                    ...ruleForPut(rule), // keeps the rule description + fields this app doesn't model
                    id: rule.id, name: rule.name, enabled: rule.enabled !== false, action: rule.action || 'accept',
                    bidirectional: !!rule.bidirectional, protocol: rule.protocol || 'all',
                    ports: Array.isArray(rule.ports) ? rule.ports : [],
                };
                if (Array.isArray(rule.port_ranges) && rule.port_ranges.length) out.port_ranges = rule.port_ranges;
                if (rid) {
                    out.destinationResource = loserIds.has(rid)
                        ? { id: survivor.id, type: survivor.type || (dr && dr.type) }
                        : { id: rid, type: (dr && dr.type) || undefined };
                } else {
                    out.destinations = (rule.destinations || []).map(d => (d && d.id) || d);
                }
                return out;
            });
            const resp = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(p.id), {
                name: p.name, description: p.description || '', enabled: p.enabled !== false,
                source_posture_checks: Array.isArray(p.source_posture_checks) ? p.source_posture_checks : [],
                rules,
            });
            if (!resp || resp.status >= 300) {
                throw new Error(`Failed to move policy "${p.name}" to the surviving resource: ` + (resp && (resp.raw || resp.error || resp.status)));
            }
            repointed.push({ policy: p, prevRules });
            movedPolicies++;
        }
    } catch (e) {
        await revertRepointedPolicies(repointed);
        throw e;
    }

    // 2. Union the losers' group memberships onto the survivor (in ITS network).
    const loserGroups = losers.flatMap(r => (Array.isArray(r.groups) ? r.groups : []).map(g => (g && g.id) || g)).filter(Boolean);
    if (loserGroups.length) await addResourceGroups(survivor.__netId, survivor.id, loserGroups).catch(e => console.error('[Merge] group union failed:', e.message));

    // 3. Delete the losers - each in its own network; their direct policies were re-pointed.
    const deleted = [];
    for (const r of losers) {
        await deleteResource(r.__netId, r.id);
        deleted.push(r.name || r.id);
    }
    bustNbCaches('policies', 'gref', 'usage');
    return { keptId: survivor.id, keptName: survivor.name || survivor.id, keptNetworkId: survivor.__netId, movedPolicies, deleted, crossNetwork };
}

// Move resources to another network. NetBird has no move API, so per resource:
// create an identical resource in the target network (name/address/description/enabled/groups),
// re-point every policy that targets it directly (policies are account-wide), then delete the
// original. Any failure after creation rolls the new resource back - per-resource, so one
// failure never blocks the rest of the batch.
async function moveResources(sourceNetworkId, resourceIds, targetNetworkId) {
    const ids = [...new Set((Array.isArray(resourceIds) ? resourceIds : []).map(String).filter(Boolean))];
    if (!ids.length) throw new Error('pick at least one resource to move');
    const target = String(targetNetworkId || '').trim();
    if (!target) throw new Error('a target network is required');
    if (target === String(sourceNetworkId)) throw new Error('the resource is already in this network');
    const tgtNet = await netbirdGet('/api/networks/' + encodeURIComponent(target));
    if (!tgtNet || !tgtNet.id) throw new Error('the target network no longer exists');

    const srcResources = await netbirdGet(`/api/networks/${encodeURIComponent(sourceNetworkId)}/resources`);
    const byId = new Map((Array.isArray(srcResources) ? srcResources : []).map(r => [r.id, r]));
    const pols = await netbirdGet('/api/policies');
    if (!Array.isArray(pols)) { const e = new Error("Couldn't read the current policies from NetBird - nothing was changed. Try again."); e.status = 502; throw e; }
    const polArr = pols;
    refuseSourcedResources(policiesSourcingResources(polArr, ids), 'move');

    const moved = [];
    const failed = [];
    for (const rid of ids) {
        const r = byId.get(rid);
        if (!r) { failed.push({ id: rid, name: rid, error: 'no longer exists in the source network' }); continue; }
        const label = r.name || r.address || rid;
        try {
            const groups = (Array.isArray(r.groups) ? r.groups : []).map(g => (g && g.id) || g).filter(Boolean);
            // A resource attached to an ACTIVE temporary grant must not move - the grant's
            // cleanup bookkeeping points at the old network/resource id and would leak.
            const inTempGroup = (Array.isArray(r.groups) ? r.groups : []).some(g => /^Temp (access|resources) #\d+/.test((g && g.name) || ''));
            if (inTempGroup) throw new Error('attached to an active temporary grant - wait for it to end or revoke it first');
            // The address must not be blocked for, or already present in, the target network.
            const blk = addressBlockedForNetwork(String(r.address || '').trim(), target, await getBlocklist());
            if (blk) throw new Error(`address is blocked in the target network (matches "${blk}")`);
            await assertAddressUniqueInNetwork(target, r.address);

            // NetBird resource names are unique ACCOUNT-WIDE, and the original still exists
            // at this point - so create under a temporary name and rename back at the end,
            // after the original is gone.
            const tempName = `${r.name} [moving]`;
            const resp = await netbirdPost(`/api/networks/${encodeURIComponent(target)}/resources`, {
                name: tempName, address: r.address, description: r.description || '',
                enabled: r.enabled !== false, groups,
            });
            if (!resp || resp.status >= 300 || !resp.body || !resp.body.id) {
                throw new Error('create in target failed: ' + (resp && (resp.raw || resp.error || resp.status)));
            }
            const newId = resp.body.id;
            const newType = resp.body.type;
            const repointed = []; // { policy, prevRules } - reverted if this move fails mid-way
            try {
                // Re-point direct policies (destinationResource) to the new resource.
                for (const p of polArr) {
                    const touches = (p.rules || []).some(rule => {
                        const dr = rule && rule.destinationResource;
                        return dr && (dr.id || dr) === rid;
                    });
                    if (!touches) continue;
                    const prevRules = (p.rules || []).map(ruleForPut); // snapshot BEFORE the change
                    const rules = (p.rules || []).map(rule => {
                        const dr = rule.destinationResource;
                        const drid = dr && (dr.id || dr);
                        const out = {
                            ...ruleForPut(rule), // keeps the rule description + fields this app doesn't model
                            id: rule.id, name: rule.name, enabled: rule.enabled !== false, action: rule.action || 'accept',
                            bidirectional: !!rule.bidirectional, protocol: rule.protocol || 'all',
                            ports: Array.isArray(rule.ports) ? rule.ports : [],
                        };
                        if (Array.isArray(rule.port_ranges) && rule.port_ranges.length) out.port_ranges = rule.port_ranges;
                        if (drid) out.destinationResource = drid === rid ? { id: newId, type: newType || (dr && dr.type) } : { id: drid, type: (dr && dr.type) || undefined };
                        else out.destinations = (rule.destinations || []).map(d => (d && d.id) || d);
                        return out;
                    });
                    const pr = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(p.id), {
                        name: p.name, description: p.description || '', enabled: p.enabled !== false,
                        source_posture_checks: Array.isArray(p.source_posture_checks) ? p.source_posture_checks : [],
                        rules,
                    });
                    if (!pr || pr.status >= 300) throw new Error(`moving policy "${p.name}" failed: ` + (pr && (pr.raw || pr.error || pr.status)));
                    repointed.push({ policy: p, prevRules });
                    // Keep the local copy in sync - a later resource in this batch may touch
                    // the SAME policy, and rebuilding from stale rules would undo this update.
                    p.rules = rules;
                }
                // Delete the original (its direct policies were re-pointed; groups now also
                // hold the new resource, so group cleanup won't touch them).
                await deleteResource(sourceNetworkId, rid);
                // The original name is free now - drop the temporary [moving] suffix.
                const rn = await netbirdReq('PUT', `/api/networks/${encodeURIComponent(target)}/resources/${encodeURIComponent(newId)}`, {
                    name: r.name, address: r.address, description: r.description || '',
                    enabled: r.enabled !== false, groups,
                }).catch(() => null);
                if (!rn || rn.status >= 300) {
                    moved.push(`${label} (moved, but renaming back failed - currently named "${tempName}")`);
                } else {
                    moved.push(label);
                }
            } catch (inner) {
                // Roll back so nothing is left half-moved: first restore every policy we
                // already re-pointed (or they'd target the resource we're about to delete),
                // THEN drop the new resource.
                await revertRepointedPolicies(repointed);
                await netbirdReq('DELETE', `/api/networks/${encodeURIComponent(target)}/resources/${encodeURIComponent(newId)}`).catch(() => { });
                throw inner;
            }
        } catch (e) {
            failed.push({ id: rid, name: label, error: e.message });
        }
    }
    bustNbCaches('policies', 'gref', 'usage');
    return { moved, failed, targetNetworkName: tgtNet.name || target };
}

// ── Cleanup scan (report-only hygiene sweep) ──
// Cross-references the cached NetBird datasets for leftovers that accumulate over time:
// policies pointing at deleted groups/resources, enabled policies that grant nothing,
// groups unused everywhere, resources no policy can reach, and devices not seen for a long
// time. Nothing is deleted here - the page points, the admin decides.
async function scanCleanup({ staleDays = 30 } = {}) {
    const [usage, groups] = await Promise.all([getUsageData(), getGroups().catch(() => [])]);
    await ensurePeersFresh().catch(() => { });
    const peers = await getAllPeers().catch(() => []);
    const resources = usage.resources || [];
    const policies = usage.policies || [];
    const groupIds = new Set(groups.map(g => g.id));
    const resIds = new Set(resources.map(r => r.id));
    const netName = new Map((usage.networks || []).map(n => [n.id, n.name || n.id]));
    const resOfNet = new Map();
    for (const n of (usage.networks || [])) for (const rid of (Array.isArray(n.resources) ? n.resources : [])) resOfNet.set(rid, n.id);
    const gid = (g) => (g && g.id) || g;

    // A transient API failure returns empty lists - scanning against them would flag
    // EVERYTHING as orphaned/unreachable. An empty dataset disables the checks that
    // depend on it instead of producing a wall of false findings.
    const groupsOk = groups.length > 0;

    // 1+2) Policies referencing deleted groups/resources, and ENABLED policies that can't
    // grant anything (no enabled rule with both a live source and a live destination).
    const orphanedPolicies = [];
    const ineffectivePolicies = [];
    for (const p of (groupsOk ? policies : [])) {
        const missing = new Map(); // "kind:id" → { kind, id }
        let effective = false;
        for (const r of (p.rules || [])) {
            const srcs = (Array.isArray(r.sources) ? r.sources : []).map(gid).filter(Boolean);
            const dsts = (Array.isArray(r.destinations) ? r.destinations : []).map(gid).filter(Boolean);
            for (const id of [...srcs, ...dsts]) if (!groupIds.has(id)) missing.set(`group:${id}`, { kind: 'group', id });
            const drId = r.destinationResource && r.destinationResource.id;
            if (drId && !resIds.has(drId)) missing.set(`resource:${drId}`, { kind: 'resource', id: drId });
            const hasSrc = srcs.some(id => groupIds.has(id));
            const hasDst = dsts.some(id => groupIds.has(id)) || (drId && resIds.has(drId));
            if (r.enabled !== false && hasSrc && hasDst) effective = true;
        }
        const enabled = p.enabled !== false;
        if (missing.size) {
            orphanedPolicies.push({ id: p.id, name: p.name || p.id, enabled, missing: [...missing.values()] });
        } else if (enabled && !effective) {
            const reason = !(p.rules || []).length ? 'no rules'
                : (p.rules || []).every(r => r.enabled === false) ? 'all rules disabled'
                : 'a rule is missing sources or destinations';
            ineffectivePolicies.push({ id: p.id, name: p.name || p.id, enabled, reason });
        }
    }

    // 3) Groups unused EVERYWHERE - no members, no resources, and not referenced by any
    // policy/route/DNS/setup key (getGroups already cross-references all of those). The
    // reverse-proxy services can also hold group references NetBird doesn't count, so any
    // group id appearing in the proxy status JSON is excluded too (ids are unique strings -
    // a plain substring check is exact enough and avoids coupling to the service shape).
    let proxyJson = '';
    try { proxyJson = JSON.stringify(await getReverseProxyStatus() || {}); } catch { /* self-hosted */ }
    const emptyGroups = groups.filter(g => (g.name || '') !== 'All'
        && !g.peers_count && !g.users_count && !g.resources_count
        && !g.policies_count && !g.routes_count && !g.nameservers_count && !g.zones_count && !g.setup_keys_count
        && !(proxyJson && proxyJson.includes(`"${g.id}"`)))
        .map(g => ({ id: g.id, name: g.name, issued: g.issued || 'api' }));

    // 4) Resources no ENABLED policy reaches - directly or via one of the resource's groups.
    // A resource serving as a reverse-proxy target is reachable through the proxy without
    // any policy, so those are excluded (same substring check as above). Skipped entirely
    // when the policies list came back empty - that's an API hiccup, not a clean account.
    const reachableRes = new Set();
    const reachableGroups = new Set();
    for (const p of policies) {
        if (p.enabled === false) continue;
        for (const r of (p.rules || [])) {
            if (r.enabled === false) continue;
            const drId = r.destinationResource && r.destinationResource.id;
            if (drId) reachableRes.add(drId);
            for (const g of (Array.isArray(r.destinations) ? r.destinations : [])) { const id = gid(g); if (id) reachableGroups.add(id); }
        }
    }
    const unreachableResources = (policies.length ? resources : [])
        .filter(r => !reachableRes.has(r.id)
            && !(Array.isArray(r.groups) ? r.groups : []).some(g => reachableGroups.has(gid(g)))
            && !(proxyJson && proxyJson.includes(`"${r.id}"`)))
        .map(r => ({
            id: r.id, name: r.name || r.address || r.id, address: r.address || '',
            networkId: resOfNet.get(r.id) || '', network: netName.get(resOfNet.get(r.id)) || '',
        }));

    // 5) Stale peers: disconnected and last seen more than `staleDays` days ago.
    const days = Math.min(Math.max(parseInt(staleDays, 10) || 30, 7), 365);
    const cutoff = Date.now() - days * 86400_000;
    const stalePeers = peers
        .filter(p => !p.connected && p.last_seen && new Date(p.last_seen).getTime() < cutoff)
        .map(p => ({
            id: p.id, name: p.name || p.dns_label || p.id, os: p.os || '', kind: p.kind,
            owner: p.owner_name || p.owner_email || '', lastSeen: p.last_seen,
            days: Math.floor((Date.now() - new Date(p.last_seen).getTime()) / 86400_000),
        }))
        .sort((a, b) => b.days - a.days);

    // Admin-marked "known and fine" findings drop out of the main lists (and thus the
    // weekly digest's counters) but are returned separately so the UI can show/unignore.
    const ign = await pool.query('SELECT category, object_id FROM cleanup_ignores WHERE tenant = $1', [tnt()]).catch(() => ({ rows: [] }));
    const ignSet = new Set(ign.rows.map(r => `${r.category}:${r.object_id}`));
    const ignored = [];
    const take = (arr, category) => {
        const kept = [];
        for (const x of arr) {
            if (ignSet.has(`${category}:${x.id}`)) ignored.push({ ...x, category });
            else kept.push(x);
        }
        return kept;
    };
    return {
        orphanedPolicies: take(orphanedPolicies, 'orphaned-policy'),
        ineffectivePolicies: take(ineffectivePolicies, 'ineffective-policy'),
        emptyGroups: take(emptyGroups, 'empty-group'),
        unreachableResources: take(unreachableResources, 'unreachable-resource'),
        stalePeers: take(stalePeers, 'stale-peer'),
        ignored,
        staleDays: days,
        scannedAt: new Date().toISOString(),
    };
}

// Mark / unmark one Cleanup finding as deliberately ignored.
const CLEANUP_CATEGORIES = new Set(['orphaned-policy', 'ineffective-policy', 'empty-group', 'unreachable-resource', 'stale-peer']);
async function setCleanupIgnore({ category, id, ignore }, actor) {
    if (!CLEANUP_CATEGORIES.has(String(category))) throw new Error('unknown category');
    const oid = String(id || '').trim();
    if (!oid) throw new Error('id is required');
    if (ignore) {
        await pool.query(
            `INSERT INTO cleanup_ignores (category, object_id, created_by, tenant)
             VALUES ($1, $2, $3, $4) ON CONFLICT (tenant, category, object_id) DO NOTHING`,
            [category, oid, (actor && (actor.email || actor.name)) || '', tnt()]);
    } else {
        await pool.query('DELETE FROM cleanup_ignores WHERE category = $1 AND object_id = $2 AND tenant = $3', [category, oid, tnt()]);
    }
    return { ok: true };
}

// ── Connectivity diagnostics (Troubleshoot page) ──
// The server-side half of the diagnostics wizard: what the management plane knows about a
// device, and whether the access PATH to a chosen target actually exists (policies → groups →
// routing peers). The browser-side half (management/signal reachability, STUN via WebRTC) runs
// in the user's browser - it tests THEIR network, which the server can't see. Read-only.

// Hosts the browser-side checks should probe, derived from the configured management URL.
// NetBird Cloud splits management/signal/STUN across subdomains; self-hosted typically
// serves all three from the management host.
function diagHosts() {
    let mgmt = '';
    try { mgmt = new URL(_nbApi.url).host; } catch { /* unconfigured */ }
    const cloud = !mgmt || /(^|\.)netbird\.io$/i.test(mgmt);
    return {
        management: mgmt || 'api.netbird.io',
        signal: cloud ? 'signal.netbird.io' : mgmt,
        stun: cloud ? 'stun.netbird.io' : mgmt,
    };
}

// Which registered device is this browser likely on? Matched by the request's source IP
// against each peer's public connection IP. Several devices can share one office NAT, so
// this returns candidates, not a verdict.
async function diagWhoAmI(requestIp, scopeToUser) {
    const ip = String(requestIp || '').replace(/^::ffff:/, '');
    if (!ip) return { ip: '', matches: [] };
    await ensurePeersFresh().catch(() => { });
    let peers = await getAllPeers().catch(() => []);
    if (scopeToUser) {
        peers = peers.filter(p => p.user_id === scopeToUser || String(p.user_id || '').endsWith('|' + scopeToUser));
    }
    const matches = peers
        .filter(p => (p.connection_ip || '') === ip)
        .map(p => ({ id: p.id, name: p.name, connected: p.connected, os: p.os }));
    return { ip, matches };
}

// TCP connect probe (the server-side liveness check). Resolves true if the handshake
// completes within the timeout - never throws.
function tcpProbe(host, port, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const net = require('net');
        const s = new net.Socket();
        let done = false;
        const end = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
        s.setTimeout(timeoutMs);
        s.once('connect', () => end(true));
        s.once('timeout', () => end(false));
        s.once('error', () => end(false));
        try { s.connect(port, host); } catch { end(false); }
    });
}

// Loose semver compare on the first three numeric fields ("0.36.5" style).
function diagVerCmp(a, b) {
    const num = v => (String(v || '').match(/\d+/g) || []).slice(0, 3).map(Number);
    const A = num(a), B = num(b);
    for (let i = 0; i < 3; i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d; }
    return 0;
}

// Full server-side health picture of one device. Returns PASS/WARN/FAIL/INFO rows like the
// Windows diagnostics script, plus the device's recent NetBird events. `at` carries an ISO
// timestamp the frontend formats in the app's display settings.
async function diagnoseDevice(peerId) {
    await ensurePeersFresh().catch(() => { });
    const peer = await getPeerDetail(peerId);
    if (!peer) return null;
    const checks = [];
    const add = (key, label, status, detail, at) => checks.push({ key, label, status, detail, ...(at ? { at } : {}) });

    add('registered', 'Registered Device', 'PASS', `${peer.name}${peer.ip ? ` · NetBird IP ${peer.ip}` : ''}${peer.os ? ` · ${peer.os}` : ''}`);

    if (peer.connected) {
        add('connection', 'Management Connection', 'PASS', 'Connected to NetBird right now');
    } else if (peer.login_expired) {
        add('connection', 'Management Connection', 'FAIL', 'Login expired - the device must re-authenticate (run: netbird up)', peer.last_seen || undefined);
    } else {
        add('connection', 'Management Connection', 'FAIL', 'Disconnected - the NetBird client is not talking to the management server. Check that the client is running (netbird status)', peer.last_seen || undefined);
    }

    if (peer.login_expired) {
        add('session', 'SSO Session', 'FAIL', 'The sign-in session expired - run: netbird up');
    } else if (peer.session_expires_at) {
        // Session aging is the normal lifecycle, not a problem - INFO, never a warning.
        const left = new Date(peer.session_expires_at).getTime() - Date.now();
        if (left <= 0) add('session', 'SSO Session', 'INFO', 'Session past its expiration - the device will be asked to sign in again', peer.session_expires_at);
        else if (left < 24 * 3600_000) add('session', 'SSO Session', 'INFO', 'Session expires soon - the device will simply be asked to sign in again', peer.session_expires_at);
        else add('session', 'SSO Session', 'PASS', 'Session valid', peer.session_expires_at);
    }

    if (peer.approval_required && !peer.force_approved) {
        add('compliance', 'Compliance', 'FAIL', `Blocked by compliance checks${peer.disapproval_reason ? ` - ${peer.disapproval_reason}` : ''} - the device has no network access. Request a bypass from the Request Access page`);
    } else if (peer.force_approved) {
        add('compliance', 'Compliance', 'INFO', `Compliance bypassed${peer.bypass_temp_device ? ' (temporary device - deleted when the bypass ends)' : ''}${peer.bypass_expires_at ? '' : ' - unlimited'}`, peer.bypass_expires_at || undefined);
    } else {
        add('compliance', 'Compliance', 'PASS', 'Passes the compliance checks');
    }

    // Compare the client version only against peers on the SAME OS - NetBird versions its
    // desktop and mobile clients on separate tracks (an Android 0.71 is NOT "behind" a Windows
    // 0.75), so a cross-platform "newest in the account" produced false update warnings.
    const fleet = await getAllPeers().catch(() => []);
    const myOs = edrOsKey(peer.os);
    let newest = '';
    for (const p of fleet) {
        if (!p.version) continue;
        if (myOs && edrOsKey(p.os) !== myOs) continue; // same platform only
        if (diagVerCmp(p.version, newest) > 0) newest = p.version;
    }
    const osLabel = EDR_OS_LABELS[myOs] || '';
    if (!peer.version) add('version', 'Client Version', 'INFO', 'Version unknown');
    else if (newest && diagVerCmp(peer.version, newest) < 0) add('version', 'Client Version', 'WARN', `Running ${peer.version} - newer ${osLabel || 'same-platform'} clients in this account run ${newest}. An update may fix connectivity bugs`);
    else add('version', 'Client Version', 'PASS', `${peer.version}${osLabel ? ` (newest ${osLabel} client in this account)` : ' (newest in this account)'}`);

    const groupNames = (peer.groups || []).map(g => g.name).filter(Boolean);
    if (!groupNames.length) add('groups', 'Group Membership', 'WARN', 'Not in any group - policies cannot reach this device, so it can access nothing');
    else add('groups', 'Group Membership', 'PASS', `${groupNames.length} group(s): ${groupNames.slice(0, 6).join(', ')}${groupNames.length > 6 ? '…' : ''}`);

    // Last traffic the app's event store saw from this device (source or reporter - both indexed).
    const tr = await pool.query(
        `SELECT timestamp FROM events WHERE tenant = $3 AND (source_name = $1 OR reporter_id = $2) ORDER BY timestamp DESC LIMIT 1`,
        [peer.name || '::none::', peer.id, tnt()]).catch(() => ({ rows: [] }));
    if (tr.rows.length) add('traffic', 'Last Recorded Traffic', 'INFO', 'Most recent traffic event involving this device', tr.rows[0].timestamp);
    else add('traffic', 'Last Recorded Traffic', 'INFO', 'No traffic events recorded for this device');

    const ev = await pool.query(
        `SELECT timestamp, message FROM admin_events WHERE tenant = $2 AND target_id = $1 ORDER BY timestamp DESC LIMIT 5`,
        [peer.id, tnt()]).catch(() => ({ rows: [] }));

    return {
        peer: {
            id: peer.id, name: peer.name, ip: peer.ip, os: peer.os, connected: peer.connected,
            last_seen: peer.last_seen, kind: peer.kind, owner_email: peer.owner_email,
            approval_required: peer.approval_required, force_approved: peer.force_approved,
            login_expired: peer.login_expired,
        },
        checks,
        recentEvents: ev.rows,
    };
}

// Can THIS device reach THAT target, and if not - why? Walks the actual access path:
// target exists/enabled → routing peers online → an enabled policy connects one of the
// device's (or its owner's) groups to the target. This is the question no local script
// can answer - it needs the management plane's view.
// opts.port adds a port-specific verdict ("you have access, but not on THAT port").
// opts.probeHost/probePort override the liveness probe endpoint - set ONLY by
// diagnoseAddress after it established the host is covered by a declared resource.
async function diagnoseTarget(peerId, { type, id, port, probeHost, probePort } = {}) {
    const peer = await getPeerDetail(peerId);
    if (!peer) return null;
    const usage = await getUsageData();
    const groupsRaw = await netbirdGet('/api/groups').catch(() => null);
    const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
    const gname = new Map(groups.map(g => [g.id, g.name || g.id]));
    const findings = [];
    const add = (key, label, status, detail, at) => findings.push({ key, label, status, detail, ...(at ? { at } : {}) });
    const gid = (g) => (g && g.id) || g;

    // The device's effective source identity: its own groups + the owner's auto-assigned
    // groups + the built-in "All" group (every peer is implicitly in it).
    const memberIds = new Set((peer.groups || []).map(g => g.id).filter(Boolean));
    if (peer.user_id) {
        for (const u of await getAllUsers().catch(() => [])) {
            if (u.id === peer.user_id) { for (const g of (u.groups || [])) { const i = gid(g); if (i) memberIds.add(i); } break; }
        }
    }
    const allIds = new Set(groups.filter(g => (g.name || '') === 'All').map(g => g.id));
    const sourceHits = (sources) => (Array.isArray(sources) ? sources : []).map(gid)
        .filter(i => memberIds.has(i) || allIds.has(i));

    const netName = new Map((usage.networks || []).map(n => [n.id, n.name || n.id]));
    const resOfNet = new Map();
    for (const n of (usage.networks || [])) for (const rid of (Array.isArray(n.resources) ? n.resources : [])) resOfNet.set(rid, n.id);

    // Routing-peer health for one network: without a connected router, NOTHING in the
    // network is reachable no matter what the policies say. A router entry targets either
    // a SINGLE peer (r.peer) or peer GROUPS (r.peer_groups - every member routes); missing
    // the group form previously mislabeled healthy networks as offline.
    const routersCheck = async (netId) => {
        const routers = await netbirdGet(`/api/networks/${encodeURIComponent(netId)}/routers`).catch(() => null);
        const arr = Array.isArray(routers) ? routers : [];
        if (!arr.length) { add('routers', 'Routing Peers', 'FAIL', `Network "${netName.get(netId) || netId}" has no routing peer at all - its resources are unreachable for everyone`); return false; }
        const fleet = await getAllPeers().catch(() => []);
        const byId = new Map(fleet.map(p => [p.id, p]));
        const states = [];
        for (const r of arr) {
            const enabled = r.enabled !== false;
            if (r.peer) {
                const p = byId.get(r.peer);
                states.push({ name: (p && p.name) || r.peer, online: !!(p && p.connected), enabled });
            }
            for (const gRef of (Array.isArray(r.peer_groups) ? r.peer_groups : [])) {
                const rgid = gid(gRef);
                const g = groups.find(x => x.id === rgid);
                const members = (g && Array.isArray(g.peers)) ? g.peers : [];
                if (!members.length) { states.push({ name: `group "${(g && g.name) || rgid}" (no members)`, online: false, enabled }); continue; }
                for (const m of members) {
                    const pid = (m && m.id) || m;
                    const p = byId.get(pid);
                    states.push({ name: (p && p.name) || pid, online: !!(p && p.connected), enabled });
                }
            }
        }
        if (!states.length) { add('routers', 'Routing Peers', 'FAIL', `Network "${netName.get(netId) || netId}" has routing entries that reference no peers`); return false; }
        const online = [...new Set(states.filter(s => s.enabled && s.online).map(s => s.name))];
        if (online.length) add('routers', 'Routing Peers', 'PASS', `Online: ${online.slice(0, 6).join(', ')}${online.length > 6 ? ` +${online.length - 6} more` : ''}`);
        else add('routers', 'Routing Peers', 'FAIL', `No routing peer is online in network "${netName.get(netId) || netId}" (${states.slice(0, 6).map(s => `${s.name}: ${s.enabled ? (s.online ? 'online' : 'OFFLINE') : 'disabled'}`).join(', ')}) - this alone breaks access for everyone`);
        return online.length > 0;
    };

    let target = null;
    if (type === 'network') {
        const n = (usage.networks || []).find(x => x.id === id);
        if (!n) { add('target', 'Target', 'FAIL', 'The network no longer exists'); return { target: null, findings }; }
        target = { type, id, name: n.name || id };
        await routersCheck(id);
        // Any enabled policy that reaches any resource of this network from the device's groups?
        const resIds = new Set(Array.isArray(n.resources) ? n.resources : []);
        const resGroupIds = new Set();
        for (const r of (usage.resources || [])) if (resIds.has(r.id)) for (const g of (r.groups || [])) { const i = gid(g); if (i) resGroupIds.add(i); }
        const granting = [];
        for (const p of (usage.policies || [])) {
            if (p.enabled === false) continue;
            for (const rule of (p.rules || [])) {
                if (rule.enabled === false) continue;
                const dr = rule.destinationResource && gid(rule.destinationResource);
                const hitsDest = (dr && resIds.has(dr)) || (rule.destinations || []).map(gid).some(i => resGroupIds.has(i));
                if (hitsDest && sourceHits(rule.sources).length) { granting.push(p.name || p.id); break; }
            }
        }
        if (granting.length) add('policy', 'Access Policy', 'PASS', `Policies granting this device access into the network: ${[...new Set(granting)].slice(0, 6).join(', ')}`);
        else add('policy', 'Access Policy', 'FAIL', 'No enabled policy connects this device\'s groups to anything in this network - request access if you need it');
        return { target, findings };
    }

    // Default: resource target.
    const res = (usage.resources || []).find(r => r.id === id);
    if (!res) { add('target', 'Target', 'FAIL', 'The resource no longer exists'); return { target: null, findings }; }
    const netId = resOfNet.get(res.id) || '';
    target = { type: 'resource', id, name: res.name || res.address || id, address: res.address || '', network: netName.get(netId) || '', networkId: netId, resourceType: (res.type || '').toLowerCase() };
    if (res.enabled === false) add('target', 'Target', 'FAIL', 'The resource is DISABLED - nobody can reach it until it is enabled');
    else add('target', 'Target', 'PASS', `${target.name} (${res.address || 'no address'}) in network "${target.network}"`);
    if (netId) await routersCheck(netId);

    // Policies that point at this resource, split into "grants THIS device" vs "exists but
    // not for this device's groups".
    const resGroupIds = new Set((res.groups || []).map(gid).filter(Boolean));
    const granting = [];
    const otherPolicies = [];
    for (const p of (usage.policies || [])) {
        if (p.enabled === false) continue;
        for (const rule of (p.rules || [])) {
            if (rule.enabled === false) continue;
            const dr = rule.destinationResource && gid(rule.destinationResource);
            const hitsDest = dr === res.id || (rule.destinations || []).map(gid).some(i => resGroupIds.has(i));
            if (!hitsDest) continue;
            const hits = sourceHits(rule.sources);
            const ports = Array.isArray(rule.ports) && rule.ports.length ? rule.ports.join(',') : (Array.isArray(rule.port_ranges) && rule.port_ranges.length ? rule.port_ranges.map(r => `${r.start}-${r.end}`).join(',') : 'all');
            const entry = { policy: p.name || p.id, protocol: (rule.protocol || 'all').toUpperCase(), ports, via: hits.map(i => gname.get(i) || i) };
            if (hits.length) granting.push(entry); else otherPolicies.push(entry);
        }
    }
    if (granting.length) {
        add('policy', 'Access Policy', 'PASS', `Granted via: ${granting.slice(0, 4).map(g => `${g.policy} (${g.protocol} ${g.ports}, via ${g.via[0]})`).join(' · ')}`);
    } else if (otherPolicies.length) {
        add('policy', 'Access Policy', 'FAIL', `Policies exist for this resource (${[...new Set(otherPolicies.map(o => o.policy))].slice(0, 4).join(', ')}) but none includes a group this device or its owner is in - request access, or ask an admin to add you to the right group`);
    } else {
        add('policy', 'Access Policy', 'FAIL', 'No enabled policy points at this resource at all - it is unreachable for everyone until a policy is created');
    }

    // Port-specific verdict: having access to the resource says nothing about THE port
    // the user actually asked about.
    const portOpen = (portsStr, p) => String(portsStr) === 'all' || String(portsStr).split(',').some(seg => {
        const mm = seg.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!mm) return false;
        const a = parseInt(mm[1], 10), b = mm[2] ? parseInt(mm[2], 10) : a;
        return p >= a && p <= b;
    });
    if (port && granting.length) {
        if (granting.some(g => portOpen(g.ports, port))) {
            add('port', `Port ${port}`, 'PASS', `Your access includes port ${port}`);
        } else {
            add('port', `Port ${port}`, 'FAIL', `You have access to this resource, but NOT on port ${port} - your policies open: ${[...new Set(granting.map(g => `${g.protocol} ${g.ports}`))].join(' · ')}. Request access for this port`);
        }
    }

    // Active temporary grant already covering this exact target?
    if (peer.user_id) {
        const grants = await listTemporaryAccessGrants().catch(() => []);
        const g = grants.find(g => g.status === 'active'
            && (g.userId === peer.user_id || String(g.userId || '') === String(peer.user_id))
            && (g.targets || []).some(t => t.id === id));
        if (g) add('grant', 'Temporary Grant', 'INFO', 'An active temporary grant already covers this target', g.expiresAt || undefined);
    }

    // Server-side liveness: is anything answering at the address? Only for single hosts /
    // domains (a CIDR has no single endpoint), only on ports the policies actually open,
    // and only against the resource's own stored address - or the specific host inside it
    // that diagnoseAddress vetted for coverage (never raw user input; no SSRF).
    const addr = String(res.address || '').trim();
    const isCidr = /\/\d+$/.test(addr) && !/\/32$/.test(addr);
    const isWildcard = addr.startsWith('*');
    const probeTarget = probeHost || ((addr && !isCidr && !isWildcard) ? addr.replace(/\/32$/, '') : '');
    if (probeTarget) {
        const portSet = new Set();
        if (probePort) portSet.add(probePort);
        else {
            for (const e of [...granting, ...otherPolicies]) {
                if (e.protocol === 'UDP' || e.protocol === 'ICMP') continue;
                for (const part of String(e.ports).split(',')) {
                    const m = part.trim().match(/^(\d+)/);
                    if (m) portSet.add(parseInt(m[1], 10));
                    if (portSet.size >= 3) break;
                }
            }
            if (!portSet.size) { portSet.add(443); portSet.add(80); }
        }
        const ports = [...portSet].slice(0, 3);
        const results = await Promise.all(ports.map(p => tcpProbe(probeTarget, p).then(ok => ({ p, ok }))));
        const up = results.filter(r => r.ok);
        if (up.length) add('liveness', 'Target Liveness', 'PASS', `${probeTarget} answers on TCP ${up.map(r => r.p).join(', ')} (checked from the app server)`);
        else add('liveness', 'Target Liveness', 'INFO', `No TCP answer from ${probeTarget} on ${ports.join(', ')} from the app server's vantage point - can be normal (ICMP/UDP-only service, or the server has no route there)`);
    }

    return { target, findings };
}

// Free-form "can I reach 10.20.0.5:8080?" - the org's daily question. Resolves the
// address to whatever NetBird object covers it (a resource, else a legacy network
// route), then answers BOTH questions: is this routed through NetBird at all, and does
// THIS device have access (running the standard access-path analysis + a port verdict).
// The liveness probe runs only when the host IS covered - i.e. it is declared NetBird
// infrastructure - so this cannot be used to scan arbitrary hosts through the server.
async function diagnoseAddress(peerId, addressRaw) {
    const input = String(addressRaw || '').trim();
    const peer = await getPeerDetail(peerId);
    if (!peer) return null;

    // Split an optional :port suffix (IPv4 or hostname only - IPv6 isn't supported here).
    let host = input, port = 0;
    const ci = input.lastIndexOf(':');
    if (ci > 0 && /^\d{1,5}$/.test(input.slice(ci + 1))) {
        host = input.slice(0, ci);
        port = Math.min(65535, parseInt(input.slice(ci + 1), 10));
    }
    host = host.toLowerCase();

    const findings = [];
    const add = (key, label, status, detail, at) => findings.push({ key, label, status, detail, ...(at ? { at } : {}) });
    if (!host || !/^[a-z0-9.*/_-]+$/.test(host)) {
        add('coverage', 'Address', 'FAIL', 'Enter an IPv4 address or a hostname, optionally with :port (e.g. 10.20.0.5:443)');
        return { target: null, findings };
    }

    const usage = await getUsageData();
    const gid = (g) => (g && g.id) || g;

    // Which resource covers this host? Most specific wins: exact match, then the
    // smallest containing IPv4 range, then exact domain over a *.wildcard.
    const covering = (usage.resources || []).filter(r => {
        try { return addressesOverlap(host, String(r.address || '')); } catch { return false; }
    });
    if (covering.length) {
        const size = (r) => {
            const a = String(r.address || '').toLowerCase();
            if (a === host) return -1;
            const rr = addrRange4(a);
            if (rr) return rr.end - rr.start;
            return a.startsWith('*.') ? Number.MAX_SAFE_INTEGER : 0;
        };
        const best = [...covering].sort((a, b) => size(a) - size(b))[0];
        add('coverage', 'NetBird Routing', 'PASS', `${host}${port ? `:${port}` : ''} is covered by resource "${best.name || best.address}" (${best.address}) - traffic to it goes through NetBird`);
        const inner = await diagnoseTarget(peerId, {
            type: 'resource', id: best.id,
            port: port || undefined, probeHost: host, probePort: port || undefined,
        });
        return { target: inner && inner.target, findings: [...findings, ...((inner && inner.findings) || [])] };
    }

    // FQDN ↔ IP awareness: domain resources are routed by NAME, so a raw IP that sits
    // behind an FQDN resource (or a name that resolves into a covered range) must not
    // read as "not routed through NetBird at all". Resolution is best-effort from the
    // app server (1.5s cap per lookup, all in parallel) - a miss just falls through.
    const dnsp = require('dns').promises;
    const resolveA = async (name) => {
        try {
            return await Promise.race([
                dnsp.resolve4(String(name)),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
            ]);
        } catch { return []; }
    };
    const isSingleIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (isSingleIp) {
        // Does any DOMAIN resource resolve to this IP right now?
        const domainRes = (usage.resources || [])
            .filter(r => { const a = String(r.address || '').toLowerCase(); return a && !a.startsWith('*.') && /[a-z]/.test(a) && !addrRange4(a); })
            .slice(0, 60);
        const hits = [];
        await Promise.all(domainRes.map(async r => {
            const ips = await resolveA(String(r.address).toLowerCase());
            if (ips.includes(host)) hits.push(r);
        }));
        if (hits.length) {
            const best = hits[0];
            add('coverage', 'NetBird Routing', 'PASS',
                `${host} is the current resolved address of domain resource "${best.name || best.address}" (${best.address}). Domain resources route by NAME - use ${best.address}${port ? `:${port}` : ''} to go through NetBird reliably; the raw IP may not be routed on every device`);
            const inner = await diagnoseTarget(peerId, {
                type: 'resource', id: best.id,
                port: port || undefined, probeHost: String(best.address).toLowerCase(), probePort: port || undefined,
            });
            return { target: inner && inner.target, findings: [...findings, ...((inner && inner.findings) || [])] };
        }
    } else if (/[a-z]/.test(host) && !host.includes('*') && !host.includes('/')) {
        // A name with NO matching domain resource - maybe it resolves into a covered range.
        const ips = await resolveA(host);
        for (const ip of ips) {
            const cov = (usage.resources || []).filter(r => {
                try { return addressesOverlap(ip, String(r.address || '')); } catch { return false; }
            });
            if (cov.length) {
                const best = cov[0];
                add('coverage', 'NetBird Routing', 'PASS',
                    `${host} resolves to ${ip}, which is covered by resource "${best.name || best.address}" (${best.address}) - traffic to it goes through NetBird`);
                const inner = await diagnoseTarget(peerId, {
                    type: 'resource', id: best.id,
                    port: port || undefined, probeHost: ip, probePort: port || undefined,
                });
                return { target: inner && inner.target, findings: [...findings, ...((inner && inner.findings) || [])] };
            }
        }
    }

    // No resource - maybe a legacy network route covers the IP. The MOST SPECIFIC
    // containing route wins (a 10.0.0.0/8 LAN route beats a 0.0.0.0/0 exit node).
    const hostRange = addrRange4(host);
    let route = null, routeSize = Infinity;
    if (hostRange) {
        for (const rt of (usage.routes || [])) {
            const nr = addrRange4(String(rt.network || ''));
            if (nr && nr.start <= hostRange.start && hostRange.end <= nr.end && (nr.end - nr.start) < routeSize) {
                route = rt; routeSize = nr.end - nr.start;
            }
        }
    }
    if (route) {
        // 0.0.0.0/0 = an EXIT NODE: the device merely receiving it means nothing - using
        // it is a device-side toggle (tray menu) the management API cannot see. Say so,
        // and look for EVIDENCE in the stored flow events instead of guessing.
        const isExitNode = String(route.network || '').trim() === '0.0.0.0/0';
        const routeLabel = route.network_id || route.network;
        if (isExitNode) {
            add('coverage', 'NetBird Routing', 'INFO',
                `${host} is NOT routed through NetBird - traffic to it takes the regular internet path. (Side note: exit node "${routeLabel}" is offered to this device; only while the user turns it on ON the device - tray menu → Exit Node - would this traffic go through NetBird. The management plane cannot see that toggle)`);
        } else {
            add('coverage', 'NetBird Routing', route.enabled === false ? 'FAIL' : 'PASS',
                `${host} falls inside network route "${routeLabel}" (${route.network})${route.enabled === false ? ' - but the route is DISABLED' : ''}`);
        }
        if (route.enabled !== false) {
            // The device only receives the route if it is in one of the distribution groups.
            const memberIds = new Set((peer.groups || []).map(g => g.id).filter(Boolean));
            if (peer.user_id) {
                for (const u of await getAllUsers().catch(() => [])) {
                    if (u.id === peer.user_id) { for (const g of (u.groups || [])) { const i = gid(g); if (i) memberIds.add(i); } break; }
                }
            }
            const groupsRaw = await netbirdGet('/api/groups').catch(() => null);
            const groupsArr = Array.isArray(groupsRaw) ? groupsRaw : [];
            const allIds = new Set(groupsArr.filter(g => (g.name || '') === 'All').map(g => g.id));
            const dist = Array.isArray(route.groups) ? route.groups : [];
            const receives = dist.some(g => { const i = gid(g); return memberIds.has(i) || allIds.has(i); });
            if (receives) add('route', 'Route Distribution', 'PASS', `This device is in the route's distribution groups - it ${isExitNode ? 'is OFFERED the exit node' : 'receives the route'}`);
            else add('route', 'Route Distribution', 'FAIL', `This device is NOT in the route's distribution groups - ${isExitNode ? 'the exit node is not even offered to it' : 'it does not receive this route'}; ask an admin to add it`);

            // Exit-node usage evidence: if the device's internet traffic actually flows
            // through the exit node, the routing peer REPORTS those flows - so recent
            // stored events (device as source, router as reporter, public destination)
            // prove the toggle is on; their absence strongly suggests it is off.
            if (isExitNode && receives) {
                const routerIds = new Set();
                if (route.peer) routerIds.add(route.peer);
                for (const gRef of (Array.isArray(route.peer_groups) ? route.peer_groups : [])) {
                    const g = groupsArr.find(x => x.id === gid(gRef));
                    for (const m of ((g && g.peers) || [])) routerIds.add(gid(m));
                }
                routerIds.delete(peer.id);
                if (routerIds.size) {
                    const ev = await pool.query(
                        `SELECT timestamp, destination_addr FROM events
                         WHERE tenant = $3 AND source_name = $1 AND reporter_id = ANY($2)
                         ORDER BY timestamp DESC LIMIT 100`,
                        [peer.name || ' none', [...routerIds], tnt()]).catch(() => ({ rows: [] }));
                    const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|127\.|169\.254\.)/.test(String(ip || ''));
                    const pub = ev.rows.find(r => r.destination_addr && !isPrivate(r.destination_addr));
                    if (pub) add('exitnode', 'Exit Node Usage', 'INFO', 'Right now it appears to be ON - internet traffic from this device was seen flowing through it', pub.timestamp);
                    else add('exitnode', 'Exit Node Usage', 'INFO', 'Right now it appears to be OFF - no internet traffic from this device has been seen through it');
                }
            }
        }
        return { target: null, findings };
    }

    add('coverage', 'NetBird Routing', 'FAIL', `${host} is not covered by any NetBird resource or network route - traffic to it does NOT go through NetBird at all (it takes the regular network/internet path). If it should be reachable via NetBird, an admin needs to add it as a resource`);
    return { target: null, findings };
}

// ── NetBird account notifications (Settings → Notifications → Webhook) ──
// NetBird pushes account-level notifications as webhook POSTs. Real payload shape
// (verified against production samples): { event_type: "routing.peer.disconnect",
// account_id, timestamp, message, url, link_text, and on some events activity_code /
// initiator_id / initiator_name / initiator_email / target_id }. There is NO peer_name
// field - the routing peer's name only appears inside `message`, so it is extracted
// from there. The raw JSON is always stored in full. Each NEW notification is forwarded
// once to the Telegram alerts topic; a same-day UNIQUE hash absorbs webhook retries.
const NB_NOTIF_LABELS = {
    'routing.peer.disconnect': 'Routing Peer Disconnected',
    'routing.peer.delete': 'Routing Peer Deleted',
    'peer.add': 'Peer Added',
    'peer.approval.pending': 'Peer Pending Approval',
    'user.join': 'User Joined',
    'user.approval.pending': 'User Pending Approval',
    'service.user.create': 'Service User Created',
};
// "routing.peer.disconnect" → "Routing Peer Disconnect" when no explicit label exists.
function nbNotifLabel(event) {
    if (NB_NOTIF_LABELS[event]) return NB_NOTIF_LABELS[event];
    if (!event) return 'NetBird Notification';
    return event.split(/[._-]/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
async function ingestNbNotification(body) {
    const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    const txt = (v) => (typeof v === 'string' ? v.trim() : '');
    const event = txt(b.event_type) || txt(b.event) || txt(b.type) || txt(b.name) || '';
    const message = txt(b.message) || txt(b.body) || txt(b.text) || txt(b.title) || txt(b.description) || '';
    // The routing peer's name lives only inside the message text ("Routing peer my-router
    // has disconnected..." / "Routing peer  was removed..." - name can be empty on delete).
    let peerName = txt(b.peer && b.peer.name) || txt(b.peer_name) || '';
    if (!peerName) peerName = routingPeerName(message);
    const blob = `${event} ${message}`.toLowerCase();
    const category = /^integration\.|idp|edr|sync token/.test(blob) ? 'integration'
        : /^(routing|peer)\./.test(event) || /routing peer/.test(blob) ? 'peer'
        : /^(user|service)\./.test(event) || /\buser\b/.test(blob) ? 'user' : 'other';
    const dedup = require('crypto').createHash('sha1')
        .update(new Date().toISOString().slice(0, 10) + JSON.stringify(b)).digest('hex');
    const r = await pool.query(
        `INSERT INTO nb_notifications (dedup, category, event, message, peer_name, raw, tenant)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant, dedup) DO NOTHING`,
        [dedup, category, event.slice(0, 120), message.slice(0, 500), peerName.slice(0, 120), JSON.stringify(b), tnt()]);
    if (r.rowCount) {
        // Forward to the admins' Telegram alerts topic - same opt-out as the other alerts
        // (Settings → Telegram → the Security Alerts category checkbox).
        const cats = getTelegramConfig().categories;
        const cat = cats && cats.alerts;
        if (!cat || cat.enabled !== false) {
            let html = `🔔 <b>${tgEsc(nbNotifLabel(event))}</b>`;
            if (message) html += `\n${tgEsc(message)}`;
            const who = txt(b.initiator_name) || txt(b.initiator_email);
            if (who && who !== 'API') html += `\n👤 ${tgEsc(who)}`;
            sendTelegram('alerts', html).catch(() => { });
        }
    }
    return { stored: !!r.rowCount };
}

// Active, still-relevant notices for the Troubleshoot banner and the dashboard's Needs
// Attention: routing-peer problems from the last 48h that are STILL true (the router is
// not back online), and - for admin viewers only - integration sync problems (last 7d).
async function getNbNotices({ forAdmin = false } = {}) {
    const r = await pool.query(
        `SELECT id, received_at, category, event, message, peer_name FROM nb_notifications
         WHERE received_at > NOW() - interval '7 days' AND dismissed_at IS NULL AND tenant = $1
         ORDER BY received_at DESC LIMIT 100`,
        [tnt()]
    ).catch(() => ({ rows: [] }));
    if (!r.rows.length) return [];
    const peers = await getAllPeers().catch(() => []);
    const byName = new Map(peers.map(p => [(p.name || '').toLowerCase(), p]));
    const notices = [];
    const seen = new Set();
    for (const row of r.rows) {
        const blob = `${row.event} ${row.message}`.toLowerCase();
        const ageH = (Date.now() - new Date(row.received_at).getTime()) / 3600_000;
        const isRouting = String(row.event || '').startsWith('routing.peer.')
            || (/routing peer/.test(blob) && /disconnect|offline|delet/.test(blob));
        if (isRouting) {
            if (ageH > 48) continue;
            const key = `r:${(row.peer_name || row.message).toLowerCase()}`;
            if (seen.has(key)) continue; // newest occurrence wins
            seen.add(key);
            // Self-resolving: if the named router is connected again, don't alarm anyone.
            const p = row.peer_name ? byName.get(row.peer_name.toLowerCase()) : null;
            if (p && p.connected) continue;
            notices.push({
                id: row.id,
                kind: 'routing', event: nbNotifLabel(row.event) || 'Routing Peer Issue',
                message: row.message || `Routing peer ${row.peer_name || ''} reported disconnected`.trim(),
                peerName: row.peer_name || '', at: row.received_at,
            });
        } else if (forAdmin && row.category === 'integration') {
            const key = `i:${blob.slice(0, 80)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            notices.push({ id: row.id, kind: 'integration', event: nbNotifLabel(row.event) || 'Integration Issue', message: row.message, peerName: '', at: row.received_at });
        }
    }
    return notices.slice(0, 6);
}

// Admin "Ignore": hide a notice for EVERYONE. Also hides earlier rows of the SAME issue
// (same message, or same routing peer) so an older duplicate can't resurface in its place.
// A new notification arriving later is a new incident and shows again - by design.
async function dismissNbNotification(id) {
    const nid = parseInt(id, 10);
    if (!Number.isFinite(nid)) return { dismissed: 0 };
    // Scoped to the CURRENT account so a tenant dismiss can never touch main's (or another
    // tenant's) rows - ids are not unique across accounts (PK is tenant + dedup).
    const r = await pool.query(
        `UPDATE nb_notifications SET dismissed_at = NOW()
         WHERE dismissed_at IS NULL AND tenant = $2 AND (
           id = $1
           OR message = (SELECT message FROM nb_notifications WHERE id = $1 AND tenant = $2)
           OR (COALESCE((SELECT NULLIF(peer_name, '') FROM nb_notifications WHERE id = $1 AND tenant = $2), '') <> ''
               AND peer_name = (SELECT peer_name FROM nb_notifications WHERE id = $1 AND tenant = $2)
               AND event LIKE 'routing.%')
         )`, [nid, tnt()]);
    return { dismissed: r.rowCount };
}

// ── Duplicate-address conflict scan ──
// Same/overlapping-address resources are fine while their AUDIENCES are disjoint - every
// client sees the address through exactly one resource. The moment one user can reach the
// address through TWO resources, NetBird's route/ACL dedup picks an undefined winner and that
// user's access turns unpredictable. This scan finds exactly those cases and names the users.
async function scanResourceConflicts() {
    const usage = await getUsageData();
    const groupsRaw = await netbirdGet('/api/groups').catch(() => null);
    const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
    const gname = new Map(groups.map(g => [g.id, g.name || g.id]));
    const allGroupIds = new Set(groups.filter(g => (g.name || '') === 'All').map(g => g.id));

    // Group membership → canonical member ids: a peer counts as its OWNER user (or the
    // device itself when unowned), and users auto-assigned to the group count directly.
    const peers = await getAllPeers().catch(() => []);
    const peerOwner = new Map(peers.map(p => [p.id, p.user_id || '']));
    const peerName = new Map(peers.map(p => [p.id, p.name || p.dns_label || p.id]));
    const memberSets = new Map();
    const setFor = (gid) => { if (!memberSets.has(gid)) memberSets.set(gid, new Set()); return memberSets.get(gid); };
    for (const g of groups) {
        const s = setFor(g.id);
        for (const p of (Array.isArray(g.peers) ? g.peers : [])) {
            const pid = (p && p.id) || p;
            s.add(peerOwner.get(pid) || `peer:${pid}`);
        }
    }
    const userName = new Map();
    for (const u of await getAllUsers().catch(() => [])) {
        userName.set(u.id, u.name || u.email || u.id);
        for (const g of (u.groups || [])) setFor(g.id).add(u.id);
    }
    const memberLabel = (m) => m.startsWith('peer:')
        ? `device "${peerName.get(m.slice(5)) || m.slice(5)}"`
        : (userName.get(m) || m);

    // Audience per resource = everyone in the source groups of every enabled policy rule that
    // reaches it - directly (destinationResource) or via a group the resource belongs to.
    const groupOfResource = new Map(); // gid → Set(resource ids)
    for (const r of usage.resources || []) {
        for (const g of (Array.isArray(r.groups) ? r.groups : [])) {
            const gid = (g && g.id) || g;
            if (!gid) continue;
            if (!groupOfResource.has(gid)) groupOfResource.set(gid, new Set());
            groupOfResource.get(gid).add(r.id);
        }
    }
    const audiences = new Map(); // resource id → { all, users:Set, srcGroups:Set }
    const audFor = (rid) => { if (!audiences.has(rid)) audiences.set(rid, { all: false, users: new Set(), srcGroups: new Set() }); return audiences.get(rid); };
    for (const p of usage.policies || []) {
        if (!p || p.enabled === false) continue;
        for (const rule of (Array.isArray(p.rules) ? p.rules : [])) {
            if (!rule || rule.enabled === false) continue;
            const src = (rule.sources || []).map(s => (s && s.id) || s).filter(Boolean);
            if (!src.length) continue;
            const reached = new Set();
            const dr = rule.destinationResource;
            if (dr) reached.add(dr.id || dr);
            for (const d of (rule.destinations || [])) {
                for (const rid of (groupOfResource.get((d && d.id) || d) || [])) reached.add(rid);
            }
            for (const rid of reached) {
                const a = audFor(rid);
                for (const gid of src) {
                    a.srcGroups.add(gid);
                    if (allGroupIds.has(gid)) a.all = true;
                    for (const m of (memberSets.get(gid) || [])) a.users.add(m);
                }
            }
        }
    }

    // Compare same-network resources whose addresses overlap.
    const netName = new Map(), netOf = new Map();
    for (const n of usage.networks || []) {
        netName.set(n.id, n.name || n.id);
        for (const rid of (Array.isArray(n.resources) ? n.resources : [])) netOf.set(rid, n.id);
    }
    // One conflict per EXACT address (normalized - a bare IPv4 equals its /32). Overlap with
    // DIFFERENT prefix lengths (a host inside a subnet resource) is deterministic in NetBird -
    // longest prefix wins - and a legitimate layering pattern, so it is NOT flagged here. The
    // unpredictability only exists between IDENTICAL prefixes, where there is no tiebreaker.
    // Grouping runs across ALL networks: the same address in two networks collides just the
    // same - the client gets two routes for one prefix, picks one, and only ITS rules apply.
    const normAddr = (s) => {
        let a = String(s || '').trim().toLowerCase();
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) a += '/32';
        return a;
    };
    const conflicts = [];
    const byAddr = new Map();
    for (const r of (usage.resources || [])) {
        if (!r || !netOf.has(r.id)) continue;
        const key = normAddr(r.address);
        if (!key) continue;
        if (!byAddr.has(key)) byAddr.set(key, []);
        byAddr.get(key).push(r);
    }
    for (const cluster of byAddr.values()) {
        if (cluster.length < 2) continue;
        // A resource nobody can reach (no policies) can't cause a conflict.
        const reachable = cluster.filter(r => {
            const a = audiences.get(r.id);
            return a && (a.all || a.users.size);
        });
        if (reachable.length < 2) continue;

        // Affected = anyone who can reach the address through MORE than one resource.
        const allCount = reachable.filter(r => audiences.get(r.id).all).length;
        const counts = new Map();
        for (const r of reachable) {
            for (const u of audiences.get(r.id).users) counts.set(u, (counts.get(u) || 0) + 1);
        }
        const everyone = allCount >= 2;
        const affected = everyone ? [] : [...counts].filter(([, c]) => c >= 2 || (allCount >= 1 && c >= 1)).map(([u]) => u);
        if (!everyone && !affected.length) continue; // audiences are disjoint - currently safe

        // Groups that feed the audience of 2+ resources (the usual culprit).
        const groupCounts = new Map();
        for (const r of reachable) {
            for (const gid of audiences.get(r.id).srcGroups) groupCounts.set(gid, (groupCounts.get(gid) || 0) + 1);
        }
        const openResource = allCount === 1 ? reachable.find(r => audiences.get(r.id).all) : null;
        const netIds = [...new Set(cluster.map(r => netOf.get(r.id)))];
        conflicts.push({
            networkId: netIds[0], networkName: netName.get(netIds[0]) || netIds[0],
            // Every network involved - a cross-network conflict shows on all of them.
            networks: netIds.map(n => ({ id: n, name: netName.get(n) || n })),
            crossNetwork: netIds.length > 1,
            address: cluster[0].address || '',
            resources: cluster.map(r => ({
                id: r.id, name: r.name || r.id,
                networkId: netOf.get(r.id), networkName: netName.get(netOf.get(r.id)) || '',
            })),
            overlapCount: everyone ? -1 : affected.length, // -1 = everyone
            overlapUsers: affected.slice(0, 8).map(memberLabel),
            sharedGroups: [...groupCounts].filter(([, c]) => c >= 2).map(([g]) => gname.get(g) || g),
            note: everyone ? 'more than one of these is open to everyone (All group)'
                : openResource ? `"${openResource.name || openResource.id}" is open to everyone` : '',
        });
    }
    return conflicts;
}

// Replace the policies dedicated to a resource with the provided list (delete + recreate).
// Replace the policies dedicated to a resource (every rule targets it directly via
// destinationResource). Shared group-targeting policies are never touched.
// The resource editor REPLACES a resource's dedicated policies: it deletes them and recreates one
// single-rule Accept policy per form entry. That is only safe when every stored one is exactly what
// the form can express - otherwise an SSH rule would come back as allow-all, a Drop rule as Accept,
// a multi-rule policy as one rule, and unmodeled fields would be lost. Checked BEFORE any write
// (the route calls it before saving the resource too); returns the dedicated policies.
async function checkResourcePolicySync(resourceId, policies) {
    for (const p of (policies || [])) if (p) editorProtocol(p.protocol);
    const pols = await netbirdGet('/api/policies').catch(() => null);
    if (!Array.isArray(pols)) {
        const e = new Error("Couldn't read the current policies from NetBird - nothing was changed. Try again."); e.status = 502; throw e;
    }
    const dedicated = pols.filter(p => {
        const rules = p.rules || [];
        if (!rules.length) return false;
        return rules.every(rule => {
            const dr = rule.destinationResource;
            return !!(dr && ((dr.id) || dr) === resourceId);
        });
    });
    const targeting = pols.filter(p => (p.rules || []).some(rule => {
        const dr = rule && rule.destinationResource;
        return !!(dr && ((dr.id) || dr) === resourceId);
    }));
    const locked = targeting.filter(p => p.rules.length > 1 || p.rules.some(r => ruleHasUnmodeled(r) || (r.action || 'accept') !== 'accept' || (r.enabled !== false) !== (p.enabled !== false)));
    if (locked.length) {
        const e = new Error(`This resource's access is set by ${locked.length === 1 ? 'a policy' : 'policies'} this editor can't reproduce exactly (${locked.map(p => `"${p.name || p.id}"`).join(', ')} - an SSH, Drop, disabled or multi-rule policy). Change ${locked.length === 1 ? 'it' : 'them'} on the Policies page; nothing was changed.`);
        e.status = 409;
        throw e;
    }
    return dedicated;
}
async function syncResourcePolicies(networkId, resourceId, policies) {
    const r = await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`);
    const name = (r && r.name) || 'resource';
    const resType = r && r.type;

    const dedicated = await checkResourcePolicySync(resourceId, policies);
    let changed = false; // any policy already deleted or created when a later step fails
    try {
        for (const p of dedicated) {
            const d = await netbirdReq('DELETE', '/api/policies/' + encodeURIComponent(p.id));
            if (!d || !(d.status >= 200 && d.status < 300)) throw new Error(`NetBird refused to remove policy "${p.name || p.id}" (${(d && (d.status || d.error)) || 'no response'})`);
            changed = true;
        }
        for (const p of (policies || [])) {
            if (!p || !Array.isArray(p.sources) || !p.sources.length) continue;
            await createOneResourcePolicy(name, { id: resourceId, type: resType }, p);
            changed = true;
        }
    } catch (e) {
        e.partial = changed;
        throw e;
    } finally {
        bustNbCaches('policies');
    }
}

// All NetBird groups (id + name) for the admin source-group picker
async function getNetbirdGroups() {
    const groups = await netbirdGet('/api/groups');
    if (!Array.isArray(groups)) return [];
    return groups
        .filter(g => g && g.id)
        .map(g => ({ id: g.id, name: g.name || g.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// Resolve a network's grant AD-group ids → NetBird groups [{id, name}].
// Used to auto-fill a non-admin editor's policy sources from Network Access.
async function resolveGrantGroups(adGroupIds) {
    const ids = (adGroupIds || []).filter(Boolean);
    if (!ids.length) return [];
    const groups = await netbirdGet('/api/groups');
    if (!Array.isArray(groups)) return [];
    const out = [];
    for (const ad of ids) {
        const g = groups.find(x => x && typeof x.id === 'string' && (x.id === ad || x.id.split('|').pop() === ad));
        if (g) out.push({ id: g.id, name: g.name || g.id });
    }
    return out;
}


// Update a resource's name/address/description (groups optional)
async function editResource(networkId, resourceId, { name, address, description, groups, enabled, allowBlocked }) {
    // allowBlocked = an ADMIN acting deliberately (the route audits the override).
    if (!allowBlocked) {
        const blocked = addressBlockedForNetwork(String(address || '').trim(), networkId, await getBlocklist());
        if (blocked) throw new Error(`Address "${address}" is blocked for this network (matches "${blocked}" on the blocklist).`);
    }
    await assertAddressUniqueInNetwork(networkId, address, resourceId);
    // Preserve the enabled flag when the caller sends it - editing must not silently re-enable
    // a disabled resource. Callers that omit it keep the legacy always-on behavior.
    const body = { name, address, description: description || '', enabled: enabled === undefined ? true : !!enabled };
    if (Array.isArray(groups)) body.groups = groups;
    const resp = await netbirdReq('PUT', `/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`, body);
    if (!resp || resp.status >= 300) throw new Error('Failed to update resource: ' + (resp && (resp.raw || resp.error || resp.status)));
    bustNbCaches('policies', 'gref', 'usage');
    return resp.body;
}

// Toggle a resource's enabled flag without clobbering its other fields (GET-then-PUT).
async function setResourceEnabled(networkId, resourceId, enabled) {
    const r = await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`);
    if (!r || !r.id) throw new Error('Resource not found');
    const groups = Array.isArray(r.groups) ? r.groups.map(g => (g && g.id) || g).filter(Boolean) : [];
    const body = { name: r.name, address: r.address, description: r.description || '', enabled: !!enabled, groups };
    const resp = await netbirdReq('PUT', `/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`, body);
    if (!resp || resp.status >= 300) throw new Error('Failed to set resource enabled: ' + (resp && (resp.raw || resp.error || resp.status)));
    bustNbCaches('policies');
    return resp.body;
}

// resourceHasGroups (pure "already in every wanted group?" check) and setResourceNameFrom (rename
// from an automation's source) are used exclusively by the automations engine and now live in
// lib/automations.js. addResourceGroups below stays here - it is also used by temporary-access
// grants - and is injected into lib/automations.js via initAutomations.

// Ensure a resource belongs to every group in `wantGroupIds` (e.g. its automation's Access
// Profile groups). GET-then-PUT unions with the resource's current groups so name/address/
// description/enabled are preserved. Returns true only if it actually added a group.
async function addResourceGroups(networkId, resourceId, wantGroupIds) {
    const want = [...new Set((wantGroupIds || []).filter(Boolean))];
    if (!want.length) return false;
    const r = await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`);
    if (!r || !r.id) throw new Error('Resource not found');
    const current = Array.isArray(r.groups) ? r.groups.map(g => (g && g.id) || g).filter(Boolean) : [];
    const have = new Set(current);
    const missing = want.filter(g => !have.has(g));
    if (!missing.length) return false;
    const body = { name: r.name, address: r.address, description: r.description || '', enabled: r.enabled !== false, groups: [...current, ...missing] };
    const resp = await netbirdReq('PUT', `/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`, body);
    if (!resp || resp.status >= 300) throw new Error('Failed to assign access-profile group(s): ' + (resp && (resp.raw || resp.error || resp.status)));
    bustNbCaches('policies', 'gref', 'usage');
    return true;
}

// Remove group(s) from a resource (GET-then-PUT). Used to detach a temporary-access destination
// group before deleting it. Returns true only if it actually removed a membership.
async function removeResourceGroups(networkId, resourceId, dropGroupIds) {
    const drop = new Set((dropGroupIds || []).filter(Boolean));
    if (!drop.size || !networkId || !resourceId) return false;
    const r = await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`);
    if (!r || !r.id) return false;
    const current = Array.isArray(r.groups) ? r.groups.map(g => (g && g.id) || g).filter(Boolean) : [];
    const next = current.filter(g => !drop.has(g));
    if (next.length === current.length) return false;
    const body = { name: r.name, address: r.address, description: r.description || '', enabled: r.enabled !== false, groups: next };
    const resp = await netbirdReq('PUT', `/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`, body);
    if (!resp || resp.status >= 300) throw new Error('Failed to detach resource group: ' + (resp && (resp.raw || resp.error || resp.status)));
    bustNbCaches('policies', 'gref', 'usage');
    return true;
}

// Name of the fixed Access-Control source group (for display in the modal)
// Update the protocol/ports of the policy attached to a resource (keeps source/dest)
async function setResourcePolicy(networkId, resourceId, protocol, ports) {
    const r = await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`);
    const groupIds = (r && Array.isArray(r.groups)) ? r.groups.map(g => (g && g.id) || g).filter(Boolean) : [];
    if (!groupIds.length) return;
    const pols = await netbirdGet('/api/policies');
    if (!Array.isArray(pols)) return;
    const pol = pols.find(p => (p.rules || []).some(rule => (rule.destinations || []).some(d => groupIds.includes((d && d.id) || d))));
    if (!pol) return;
    const rules = (pol.rules || []).map(rule => ({
        id: rule.id, name: rule.name, enabled: rule.enabled !== false, action: rule.action || 'accept',
        bidirectional: !!rule.bidirectional,
        protocol: protocol || 'all',
        ports: (protocol && protocol !== 'all' && protocol !== 'icmp') ? (ports || []) : [],
        sources: (rule.sources || []).map(s => (s && s.id) || s),
        destinations: (rule.destinations || []).map(d => (d && d.id) || d),
    }));
    const resp = await netbirdReq('PUT', '/api/policies/' + encodeURIComponent(pol.id), { name: pol.name, description: pol.description || '', enabled: pol.enabled !== false, rules });
    if (!resp || resp.status >= 300) throw new Error('Failed to update policy: ' + (resp && (resp.raw || resp.error || resp.status)));
    bustNbCaches('policies');
}

// Delete a resource and best-effort clean up its auto-created policy + group
async function deleteResource(networkId, resourceId) {
    // Fetch the resource first to learn its groups
    const r = await netbirdGet(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`);
    const groupIds = (r && Array.isArray(r.groups)) ? r.groups.map(g => (g && g.id) || g).filter(Boolean) : [];

    // Delete policies that target this resource directly (NetBird blocks deleting a
    // resource still referenced by a policy's destinationResource).
    const polsBefore = await netbirdGet('/api/policies');
    if (Array.isArray(polsBefore)) {
        for (const p of polsBefore) {
            const targets = (p.rules || []).some(rule => {
                const dr = rule.destinationResource;
                return dr && ((dr.id) || dr) === resourceId;
            });
            if (targets) await netbirdReq('DELETE', '/api/policies/' + encodeURIComponent(p.id));
        }
    }

    const del = await netbirdReq('DELETE', `/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(resourceId)}`);
    if (!del || del.status >= 300) throw new Error('Failed to delete resource: ' + (del && (del.raw || del.error || del.status)));

    // Clean up groups that are now empty (and the policies that targeted them)
    for (const gid of groupIds) {
        try {
            const g = await netbirdGet('/api/groups/' + encodeURIComponent(gid));
            const stillUsed = g && ((g.resources_count || (g.resources ? g.resources.length : 0)) > 0 || (g.peers_count || 0) > 0);
            if (g && !stillUsed) {
                const pols = await netbirdGet('/api/policies');
                if (Array.isArray(pols)) {
                    for (const p of pols) {
                        const targets = (p.rules || []).some(rule => (rule.destinations || []).some(d => ((d && d.id) || d) === gid));
                        if (targets) await netbirdReq('DELETE', '/api/policies/' + encodeURIComponent(p.id));
                    }
                }
                await netbirdReq('DELETE', '/api/groups/' + encodeURIComponent(gid));
            }
        } catch (e) { console.error('[deleteResource] cleanup error:', e.message); }
    }
    // Resource membership changed → refresh the group ref-map (drives Access Profile
    // resource counts) and usage cache, so counts don't show stale values.
    bustNbCaches('policies', 'gref', 'usage');
    return { status: 'ok' };
}

// ─── User resolution via NetBird Management API (GET /api/users) ───
// Users are pulled from NetBird's own API (same PAT as the peers cache) and stored
// in the users table; resolveUser then just reads that cache.

const USERS_TTL_MS = 10 * 60 * 1000; // refresh the cache at most every 10 minutes
// Per-account refresh state (keyed by tnt()): each tenant - and main ('') - has its own TTL
// stamp + in-flight promise, so a tenant refresh never resets main's freshness and vice versa.
const _usersLastRefresh = new Map(); // account id → last refresh ms
const _usersRefreshing = new Map();  // account id → in-flight refresh promise

// ALS-aware fetch: netbirdGet targets the active tenant (or main) transparently. Contract
// preserved - resolves to the users array, or null on error / non-array.
function fetchUsersFromApi() {
    if (!netbirdApiConfigured()) return Promise.resolve(null);
    // Merge regular + service users: the plain list can EXCLUDE service users, and seeing them
    // (incl. the app's own managed service user per tenant) is a requirement. Dedup by id.
    const pull = () => Promise.all([
        netbirdGet('/api/users'),
        netbirdGet('/api/users?service_user=true'),
    ]).then(([a, b]) => {
        if (!Array.isArray(a) && !Array.isArray(b)) return null;
        const seen = new Set(); const out = [];
        for (const u of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
            if (u && u.id && !seen.has(u.id)) { seen.add(u.id); out.push(u); }
        }
        return out;
    });
    // Runs in the active account's context (service token for a tenant) - that already lists users
    // fine; the tenant "0 members" symptom was a hardcoded tenant = '' in getGroupDetail, not this.
    return pull();
}

async function upsertUsers(users) {
    const t = tnt(); // one account for the whole batch (ALS context is stable across the loop)
    const client = await pool.connect();
    try {
        for (const u of users) {
            if (!u || !u.id) continue;
            // Mirror rows are stamped with the active account - main ('') or a tenant, identically.
            await client.query(`
                INSERT INTO users (tenant, user_id, display_name, email, raw_json, updated_at)
                VALUES ($5, $1, $2, $3, $4, NOW())
                ON CONFLICT (tenant, user_id) DO UPDATE SET
                    display_name = $2, email = $3, raw_json = $4, updated_at = NOW()
            `, [u.id, u.name || '', u.email || '', JSON.stringify(u), t]);
        }
    } finally {
        client.release();
    }
}

async function refreshUsersCache() {
    const t = tnt();
    const users = await fetchUsersFromApi();
    if (users) {
        await upsertUsers(users);
        // Prune users deleted in NetBird. Only when the API returned at least one (an account
        // always has its owner, so an empty result means a transient error - don't wipe).
        const ids = users.map(u => u && u.id).filter(Boolean);
        if (ids.length) {
            // Prune only THIS account's rows - other accounts' rows must survive.
            await pool.query(`DELETE FROM users WHERE tenant = $2 AND user_id <> ALL($1)`, [ids, t])
                .catch(e => console.error('[UserResolve] prune error:', e.message));
        }
        console.log(`[UserResolve] Cached ${users.length} users from NetBird API`);
    }
    _usersLastRefresh.set(t, Date.now());
}

// Refresh the users cache if stale; coalesces concurrent callers into one request PER account.
function ensureUsersFresh() {
    if (!netbirdApiConfigured()) return Promise.resolve();
    const key = tnt();
    if (Date.now() - (_usersLastRefresh.get(key) || 0) < USERS_TTL_MS) return Promise.resolve();
    const inflight = _usersRefreshing.get(key);
    if (inflight) return inflight;
    const p = refreshUsersCache()
        .catch(err => console.error('[UserResolve] Refresh error:', err.message))
        .finally(() => { _usersRefreshing.delete(key); });
    _usersRefreshing.set(key, p);
    return p;
}

// ── Invite a user (NetBird Cloud) ────────────────────────────────────────────────────
// The roles NetBird accepts for a human user. 'owner' is deliberately absent - ownership
// is transferred, never assigned at creation.
const USER_ROLES = ['user', 'auditor', 'network_admin', 'admin'];

// The MAIN account's NetBird id, resolved once and cached for the process lifetime (an account
// id never changes). MUST only be called OUTSIDE a tenant context - inside one, /api/accounts
// answers with the tenant's own account.
let _mainAcctId = '';
async function mainAccountId() {
    if (_mainAcctId) return _mainAcctId;
    const accounts = await netbirdGet('/api/accounts').catch(() => null);
    _mainAcctId = (Array.isArray(accounts) && accounts[0] && accounts[0].id) || '';
    return _mainAcctId;
}

// Run `fn` AS A REAL ADMIN USER (the MSP Provisioning Token, a real admin's PAT) instead of the
// app's SERVICE-USER token. NetBird restricts several actions for service users: invitations are
// refused outright ("inviter user with id ... is empty"), and GET /api/users comes back
// empty/limited so a managed tenant's human user list syncs as 0 (peers, on a different fetcher,
// sync fine). authToken + ?account= is exactly the tenant provisioning mechanism; the override
// only engages when an account id is set, so in MAIN context we switch to our OWN account id (a
// no-op NetBird honors). No prov token → run fn on the service token unchanged. Scope this to the
// NetBird call ONLY: the mirror refresh and everything else must keep running on the service token.
async function asRealUser(fn) {
    const prov = getMspProvisioningToken();
    if (!prov) return fn();
    const acct = currentTenantAccount() || await mainAccountId().catch(() => '');
    if (!acct) return fn(); // account id unresolvable - fall back to the service token
    return runWithTenant(acct, fn, { authToken: prov });
}

// A NetBird inviter-identity failure is a configuration problem, not a form error - rewrite it
// into the action that fixes it. Any other message is passed through untouched.
function inviterHint(message) {
    const m = String(message == null ? '' : message);
    return /inviter/i.test(m)
        ? 'NetBird requires invitations to be sent by a real user. Set the MSP Provisioning Token in Settings - NetBird API and try again.'
        : m;
}

// Cloud accounts invite through POST /api/users: NetBird creates the user in the "invited"
// state and mails the invitation itself (the self-hosted invite-LINK flow is not used here).
// Runs in the CURRENT account context - main or a managed MSP tenant.
async function inviteUser({ name, email, role, autoGroups }) {
    const body = {
        name: String(name || '').trim().slice(0, 100),
        email: String(email || '').trim(),
        role: USER_ROLES.includes(String(role || '')) ? String(role) : 'user',
        auto_groups: (Array.isArray(autoGroups) ? autoGroups : []).map(g => String(g || '')).filter(Boolean),
        is_service_user: false,
    };
    const r = await asRealUser(() => netbirdPost('/api/users', body));
    if (!r || r.status >= 300 || !r.body || !r.body.id) {
        throw new Error(inviterHint((r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)) || 'Failed to invite the user'));
    }
    // The mirror is TTL-based, so the invited user would stay invisible for minutes.
    // Refresh it now (bypassing the TTL) so the Users page shows them immediately.
    // Deliberately OUTSIDE asRealUser: the mirror refresh is a service-token concern (and it
    // routes through asRealUser itself when a tenant needs the provisioning token).
    await refreshUsersCache().catch(err => console.error('[UserResolve] post-invite refresh error:', err.message));
    return r.body;
}

// Re-send a pending invitation (dashboard's "Resend"). Only meaningful while the user is
// still in the "invited" state - NetBird decides, we just forward the call. Same inviter-identity
// constraint as the initial invite, so it runs through asRealUser too.
async function resendUserInvite(userId) {
    const r = await asRealUser(() => netbirdPost(`/api/users/${encodeURIComponent(String(userId || ''))}/invite`, {}));
    if (!r || r.status >= 300) {
        throw new Error(inviterHint((r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)) || 'Failed to resend the invitation'));
    }
    return { status: 'ok' };
}

// ── Default Auto-Assigned Groups for invitations (per account) ───────────────────────
// The groups the invite modal pre-selects. App-side state - NetBird has no such notion.
// PER ACCOUNT (the dupKey pattern): bare key for main, `invite_default_groups:<tenant>` in
// tenant context. Group ids are account-scoped, so defaults must NEVER leak across accounts.
const inviteDefKey = () => tnt() ? `invite_default_groups:${tnt()}` : 'invite_default_groups';
async function getInviteDefaultGroups() {
    try {
        const v = await getSetting(inviteDefKey());
        const a = v ? JSON.parse(v) : [];
        return Array.isArray(a) ? a.map(String).filter(Boolean).slice(0, 50) : [];
    } catch { return []; }
}
async function setInviteDefaultGroups(ids) {
    if (!Array.isArray(ids)) throw new Error('Default groups must be a list');
    // Cap at 50 - a defaults list longer than that is a mistake, not a policy.
    const clean = [...new Set(ids.map(g => String(g || '').trim()).filter(Boolean))].slice(0, 50);
    await setSetting(inviteDefKey(), JSON.stringify(clean));
    return clean;
}

// Create a setup key in the CURRENT account context (main or the MSP tenant being managed).
// Two callers, one function:
//   • Add Peer (server install) passes ONLY { name } and must keep getting the official
//     one-off / 24h / single-use / no-auto-groups install key - so every field defaults to
//     that shape when the caller omits it.
//   • The group Setup Keys modal passes the full official field set: { type, expiresInDays,
//     usageLimit, ephemeral, autoGroups, allowExtraDnsLabels }. `expiresInDays: 0` means the
//     key never expires; `usageLimit: 0` (reusable only) means unlimited - matching NetBird.
// Setup keys are a normal service-token call (not restricted to a real user like invites), so
// no asRealUser wrapper is needed; this works with a tenant service-user token.
// The returned object carries the PLAINTEXT `key` exactly once: callers must hand it to the UI
// and never persist or log it.
async function createSetupKey({ name, type, expiresInDays, usageLimit, ephemeral, autoGroups, allowExtraDnsLabels } = {}) {
    const reusable = type === 'reusable';
    // Days → seconds. Omitted (Add Peer) defaults to 1 day; 0 = no expiration (official parity).
    const days = expiresInDays === undefined || expiresInDays === null
        ? 1 : Math.max(0, Math.floor(Number(expiresInDays) || 0));
    // One-off keys are always single-use; reusable keys honor the limit (0 = unlimited).
    const limit = reusable ? Math.max(0, Math.floor(Number(usageLimit) || 0)) : 1;
    const body = {
        name: String(name || '').trim().slice(0, 100)
            || `Install setup key (${new Date().toISOString().replace('T', ' ').slice(0, 19)})`,
        type: reusable ? 'reusable' : 'one-off',
        expires_in: days * 24 * 60 * 60,
        revoked: false,
        auto_groups: (Array.isArray(autoGroups) ? autoGroups : []).map(g => String(g || '')).filter(Boolean),
        usage_limit: limit,
        ephemeral: !!ephemeral,
        allow_extra_dns_labels: !!allowExtraDnsLabels,
    };
    const r = await netbirdPost('/api/setup-keys', body);
    if (!r || r.status >= 300 || !r.body || !r.body.key) {
        throw new Error((r && ((r.body && (r.body.message || r.body.error)) || r.raw || r.error || r.status)) || 'Failed to create the setup key');
    }
    return r.body;
}

async function resolveUser(userId) {
    if (!userId) return null;
    // Identity resolution is ALWAYS a main-account concern (events, viewer, notifications).
    const result = await pool.query(
        `SELECT user_id, display_name, email FROM users WHERE tenant = '' AND user_id = $1`,
        [userId]
    );
    if (result.rows.length > 0) return result.rows[0];
    return { user_id: userId, display_name: '', email: '' };
}

// Resolve a logged-in SSO user (by Azure oid and/or email) to their cached
// NetBird identity + role. Used for access control. Returns null if unknown.
async function resolveViewer(oid, email) {
    const mapRow = row => ({
        user_id: row.user_id,
        email: row.email,
        name: row.display_name,
        role: row.role || '',
        auto_groups: Array.isArray(row.auto_groups) ? row.auto_groups : [],
    });
    if (oid) {
        const r = await pool.query(
            `SELECT user_id, email, display_name, raw_json->>'role' AS role, raw_json->'auto_groups' AS auto_groups
             FROM users WHERE tenant = '' AND (user_id = $1 OR user_id LIKE '%|' || $1) LIMIT 1`,
            [oid]
        );
        if (r.rows.length) return mapRow(r.rows[0]);
    }
    if (email) {
        const r = await pool.query(
            `SELECT user_id, email, display_name, raw_json->>'role' AS role, raw_json->'auto_groups' AS auto_groups
             FROM users WHERE tenant = '' AND LOWER(email) = LOWER($1) LIMIT 1`,
            [email]
        );
        if (r.rows.length) return mapRow(r.rows[0]);
    }
    return null;
}

// NetBird group ids the user belongs to via their PEERS (peer.groups). A user's own
// `auto_groups` only lists IdP-synced groups; membership in native groups (e.g. a
// "Support Department" group used for network-edit grants) is reflected on their
// peers. Used to broaden network-edit grant matching.
async function getUserPeerGroupIds(userId, oid) {
    if (!userId && !oid) return [];
    const r = await pool.query(
        `SELECT raw_json->'groups' AS groups FROM peers
         WHERE tenant = ''
           AND (raw_json->>'user_id' = $1
            OR raw_json->>'user_id' = $2
            OR raw_json->>'user_id' LIKE '%|' || $2)`,
        [userId || '\x00', oid || '\x00']
    );
    const ids = new Set();
    for (const row of r.rows) {
        const gs = row.groups;
        if (Array.isArray(gs)) for (const g of gs) {
            const id = (g && typeof g === 'object') ? g.id : g;
            if (id) ids.add(id);
        }
    }
    return [...ids];
}

async function resolveUsersForEvents(events) {
    const userIds = [...new Set(events.filter(e => e.user_id).map(e => e.user_id))];
    const userMap = {};

    await Promise.all(userIds.map(async (uid) => {
        const user = await resolveUser(uid);
        if (user) userMap[uid] = user;
    }));

    return userMap;
}

async function resolveUsersForAdminEvents(events) {
    const userMap = {};
    // Look in the ACTIVE account's users mirror FIRST - a tenant's initiator lives under the tenant,
    // not main (resolveUser stays main-pinned for viewer/notification identity, so admin-event display
    // does its own account-scoped lookup here). Main is the fallback for a shared/app id.
    const acct = tnt();
    const scopes = acct ? [acct, ''] : [''];
    // Last resort: the audit-events API pull carries the initiator's name/email ON the event itself
    // (the streaming webhook does not), so a tenant initiator with no mirror row is still named.
    const fromPayload = {};
    for (const e of events) {
        const uid = e.initiator_id;
        if (!uid || fromPayload[uid]) continue;
        const raw = e.raw_json || {};
        if (raw.initiator_name || raw.initiator_email) {
            fromPayload[uid] = { user_id: uid, display_name: raw.initiator_name || '', email: raw.initiator_email || '' };
        }
    }

    const initiatorIds = [...new Set(events.filter(e => e.initiator_id).map(e => e.initiator_id))];
    await Promise.all(initiatorIds.map(async (uid) => {
        for (const t of scopes) {
            const r = await pool.query(
                `SELECT user_id, display_name, email FROM users WHERE tenant = $2 AND user_id = $1`, [uid, t]
            ).catch(() => ({ rows: [] }));
            if (r.rows[0] && (r.rows[0].display_name || r.rows[0].email)) { userMap[uid] = r.rows[0]; return; }
        }
        userMap[uid] = fromPayload[uid] || { user_id: uid, display_name: '', email: '' };
    }));

    return userMap;
}

// ─── Peer (router) resolution via NetBird Management API ───
// Routers only ever appear as reporter_id in flow events (never as source/dest),
// so their names can't be derived from events - we pull the peer registry from the
// NetBird API (GET /api/peers) and cache it.

const PEERS_TTL_MS = 10 * 60 * 1000; // refresh the cache at most every 10 minutes
// Per-account refresh state (keyed by tnt()), same design as the users caches above.
const _peersLastRefresh = new Map(); // account id → last refresh ms
const _peersRefreshing = new Map();  // account id → in-flight refresh promise

// netbirdApiConfigured now lives in lib/netbird.js; imported at the top of this file.

// ALS-aware fetch: netbirdGet targets the active tenant (or main) transparently. Contract
// preserved - resolves to the peers array, or null on error / non-array.
function fetchPeersFromApi() {
    if (!netbirdApiConfigured()) return Promise.resolve(null);
    return netbirdGet('/api/peers').then(r => (Array.isArray(r) ? r : null));
}

// ─── Device tags & notes - operational metadata, app-only (NetBird has no such field) ───
// Tags are free-form, deduped, capped (20 tags × 40 chars); the note is capped at 2000.
async function setPeerMeta(peerId, { note, tags } = {}, actor) {
    const cleanTags = [...new Set((Array.isArray(tags) ? tags : []).map(t => String(t).trim()).filter(t => t && t.length <= 40))].slice(0, 20);
    const cleanNote = String(note || '').trim().slice(0, 2000);
    await pool.query(`
        INSERT INTO peer_meta (tenant, peer_id, note, tags, updated_by, updated_at)
        VALUES ($5, $1, $2, $3, $4, NOW())
        ON CONFLICT (tenant, peer_id) DO UPDATE SET note = EXCLUDED.note, tags = EXCLUDED.tags, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `, [peerId, cleanNote, JSON.stringify(cleanTags), (actor && (actor.email || actor.name)) || '', tnt()]);
    const nameRow = await pool.query(`SELECT name FROM peers WHERE tenant = $2 AND peer_id=$1`, [peerId, tnt()]).catch(() => ({ rows: [] }));
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'peer.meta', target: (nameRow.rows[0] && nameRow.rows[0].name) || peerId,
        meta: { tags: cleanTags.join(', ') || 'none', note: cleanNote ? `${cleanNote.length} chars` : 'none' },
    }).catch(() => { });
    return { note: cleanNote, tags: cleanTags };
}
// Bulk-add tags to many devices at once. MERGE semantics: existing tags are kept and
// deduped, notes are untouched - so tagging a batch can never erase per-device data.
async function bulkTagPeers(ids, tags, actor) {
    const peerIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    const cleanTags = [...new Set((Array.isArray(tags) ? tags : []).map(t => String(t).trim()).filter(t => t && t.length <= 40))].slice(0, 20);
    if (!peerIds.length) throw new Error('no devices selected');
    if (!cleanTags.length) throw new Error('add at least one tag');
    for (const pid of peerIds) {
        await pool.query(`
            INSERT INTO peer_meta (tenant, peer_id, note, tags, updated_by, updated_at)
            VALUES ($4, $1, '', $2::jsonb, $3, NOW())
            ON CONFLICT (tenant, peer_id) DO UPDATE SET
                tags = (
                    SELECT COALESCE(jsonb_agg(DISTINCT t), '[]'::jsonb) FROM (
                        SELECT jsonb_array_elements_text(peer_meta.tags) AS t
                        UNION
                        SELECT jsonb_array_elements_text($2::jsonb) AS t
                    ) merged
                ),
                updated_by = EXCLUDED.updated_by, updated_at = NOW()
        `, [pid, JSON.stringify(cleanTags), (actor && (actor.email || actor.name)) || '', tnt()]);
    }
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'peer.bulk_tags', target: `${peerIds.length} device(s)`,
        meta: { tags: cleanTags.join(', '), devices: peerIds.length },
    }).catch(() => { });
    return { updated: peerIds.length, tags: cleanTags };
}

// Every distinct tag in use - for the Peers tag filter and the editor's suggestions.
async function getAllPeerTags() {
    const r = await pool.query(`SELECT DISTINCT jsonb_array_elements_text(tags) AS tag FROM peer_meta WHERE tenant = $1 ORDER BY 1`, [tnt()]).catch(() => ({ rows: [] }));
    return r.rows.map(x => x.tag).filter(Boolean);
}

// Delete a peer from NetBird (admin). Also drops it from the local cache so it disappears
// immediately, and forces a cache refresh on the next read.
async function deletePeer(id) {
    const resp = await netbirdReq('DELETE', '/api/peers/' + encodeURIComponent(id));
    if (!resp || (resp.status >= 300 && resp.status !== 404)) {
        throw new Error('Failed to delete peer: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    await pool.query('DELETE FROM peers WHERE tenant = $2 AND peer_id = $1', [id, tnt()]).catch(() => { });
    _peersLastRefresh.set(tnt(), 0); // force a re-pull for the CURRENT account
    return { ok: true };
}

// Bypass compliance for a non-compliant peer (NetBird's EDR bypass - the same call the official
// dashboard's "Bypass" action makes). The peer then connects despite failing posture/EDR checks.
async function bypassPeer(peerId) {
    const resp = await netbirdPost(`/api/peers/${encodeURIComponent(peerId)}/edr/bypass`, {});
    if (!resp || resp.status >= 300) {
        throw new Error('Failed to bypass the device: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    _peersLastRefresh.set(tnt(), 0); // reflect force_approved on the next peers refresh
    return { ok: true };
}

// Undo an EDR bypass (the official dashboard's "Revoke bypass" - DELETE on the same endpoint).
// The peer goes back to being blocked until it passes the compliance checks again.
async function revokePeerBypass(peerId) {
    const resp = await netbirdReq('DELETE', `/api/peers/${encodeURIComponent(peerId)}/edr/bypass`);
    if (!resp || resp.status >= 300) {
        throw new Error('Failed to remove the bypass: ' + (resp && (resp.raw || resp.error || resp.status)));
    }
    // A manual revoke also cancels any scheduled expiry (scoped to the current context).
    await pool.query('DELETE FROM bypass_expirations WHERE tenant=$2 AND peer_id=$1', [peerId, tnt()]).catch(() => { });
    _peersLastRefresh.set(tnt(), 0);
    return { ok: true };
}

// Scheduler tick: revoke bypasses whose approved duration has passed. Runs alongside
// revokeExpiredGrants (60s). Skipped in read-only mode (the revoke is a NetBird write).
async function revokeExpiredBypasses() {
    if (NETBIRD_READONLY) return;
    // Per-account: runs inside forEachTenant, so tnt() scopes to the account being serviced.
    const r = await pool.query(`SELECT * FROM bypass_expirations WHERE tenant = $1 AND expires_at <= NOW()`, [tnt()]).catch(() => ({ rows: [] }));
    for (const row of r.rows) {
        try {
            if (row.delete_peer) {
                // Temporary device: expiry DELETES the peer from NetBird (which drops the
                // bypass with it) - the device must re-enroll to ever come back.
                await deletePeer(row.peer_id);
                await pool.query(`DELETE FROM bypass_expirations WHERE tenant = $2 AND peer_id=$1`, [row.peer_id, tnt()]).catch(() => { });
                recordAudit({
                    actorId: '', actorEmail: '', actorName: 'Scheduler',
                    action: 'peer.temp_delete', target: row.peer_name || row.peer_id,
                    meta: { device: row.peer_name || row.peer_id, requester: row.requester_name || row.requester_email || undefined, requestId: row.request_id || undefined },
                }).catch(() => { });
                notifyBypassEndedEmail({ to: row.requester_email, name: row.requester_name, device: row.peer_name || row.peer_id, why: 'deleted' });
                // A pending bypass/extension request for the now-deleted device can never be
                // approved - close it out so it doesn't hang in the approvers' queue.
                const stale = await pool.query(
                    `UPDATE access_requests SET status='expired', decided_by='Scheduler', decided_at=NOW(),
                            decision_note='The device was deleted when its temporary bypass ended'
                     WHERE tenant='' AND kind='bypass' AND status='pending' AND targets @> $1::jsonb RETURNING *`,
                    [JSON.stringify([{ id: row.peer_id }])]
                ).catch(() => ({ rows: [] }));
                for (const sr of stale.rows) {
                    if (sr.tg_chat_id && sr.tg_message_id) editTelegramMessage(sr.tg_chat_id, sr.tg_message_id, accessRequestOutcomeHtml(sr, 'expired', 'Scheduler')).catch(() => { });
                }
                continue;
            }
            await revokePeerBypass(row.peer_id); // also deletes the row
            recordAudit({
                actorId: '', actorEmail: '', actorName: 'Scheduler',
                action: 'peer.bypass_expire', target: row.peer_name || row.peer_id,
                meta: { device: row.peer_name || row.peer_id, requestId: row.request_id || undefined },
            }).catch(() => { });
            notifyBypassEndedEmail({ to: row.requester_email, name: row.requester_name, device: row.peer_name || row.peer_id, why: 'expired' });
        } catch (e) {
            console.error('[Bypass] expiry revoke error (%s):', row.peer_id, e.message);
            // Push the retry 10 minutes out so a transient API failure doesn't hot-loop every tick.
            await pool.query(`UPDATE bypass_expirations SET expires_at = NOW() + interval '10 minutes' WHERE tenant = $2 AND peer_id=$1`, [row.peer_id, tnt()]).catch(() => { });
        }
    }
}

// ─── Automatic EDR bypass by OS (per account) ───────────────────────────────────────────
// Some devices can NEVER run the EDR agent (phones, appliance-style Linux servers), so every
// one of them lands in the compliance-blocked queue and needs a MANUAL bypass. This automates
// that decision per operating system, using EXACTLY the manual mechanism: bypassPeer() (the
// NetBird POST /api/peers/<id>/edr/bypass the dashboard's "Bypass" action makes) plus the same
// bypass_expirations bookkeeping for timed ones - so expiry, the System Health counters, the
// Peers page "Bypassed" badges and access recertification all behave identically to a bypass an
// admin clicked. An UNLIMITED auto-bypass therefore also enters every recertification round
// (buildRecertItems snapshots force_approved peers with no bypass_expires_at).
//
// The OS is SELF-REPORTED by the client and can be spoofed - this is a deliberate trade-off,
// off by default (enabled=false is the kill switch), capped per run, fully audited and alerted.
const EDR_OS_VALUES = ['ios', 'android', 'linux', 'windows', 'macos'];
const EDR_OS_LABELS = { ios: 'iOS / iPadOS', android: 'Android', linux: 'Linux', windows: 'Windows', macos: 'macOS' };
// Per-account settings keys (the dupKey pattern: bare key for main, `key:<tenant>` for a tenant),
// so a tenant's rules only ever act on the tenant's own peers.
const edrAutoKey = () => tnt() ? `edr_auto_bypass:${tnt()}` : 'edr_auto_bypass';
// Peer ids whose AUTO bypass an admin explicitly revoked - never auto-bypassed again (no war
// with the admin). Capped, newest kept.
const edrRevokedKey = () => tnt() ? `edr_auto_bypass_revoked:${tnt()}` : 'edr_auto_bypass_revoked';
// Peer ids this feature bypassed, so the revoke hook can tell an AUTO bypass from a manual one.
const edrAppliedKey = () => tnt() ? `edr_auto_bypass_applied:${tnt()}` : 'edr_auto_bypass_applied';
const EDR_REVOKED_CAP = 500;
const EDR_APPLIED_CAP = 2000;
// Throttle: a bad rule must never mass-bypass a whole fleet in one tick.
const EDR_AUTO_MAX_PER_RUN = 25;

// Map a self-reported OS string ("Linux Mint 21", "iOS 17.1", "Android 14", "Darwin 23.5.0")
// to one of the five rule platforms. ORDER MATTERS: Android identifies itself as Android but
// its userland is Linux, so it is tested first and can never fall through to the linux rule.
function edrOsKey(osRaw) {
    const s = String(osRaw || '').toLowerCase();
    if (!s) return '';
    if (/android/.test(s)) return 'android';
    if (/\bios\b|ipados|iphone|ipad/.test(s)) return 'ios';
    if (/windows/.test(s)) return 'windows';
    if (/darwin|mac ?os|macintosh|\bmac\b/.test(s)) return 'macos';
    // Many clients report only the DISTRO ("Ubuntu 22.04 LTS"), never the word "Linux".
    if (/linux|ubuntu|debian|fedora|centos|red ?hat|rhel|alma|rocky|alpine|arch|manjaro|mint|suse|raspbian|raspberry|gentoo|kali|amzn|amazon ami|oracle server|photon|nixos|void|slackware/.test(s)) return 'linux';
    return '';
}

// Known platforms only, 1-365 days, deduped by OS. durationDays null = unlimited.
function normEdrAutoBypass(cfg) {
    cfg = cfg || {};
    const seen = new Set();
    const rules = [];
    for (const r of (Array.isArray(cfg.rules) ? cfg.rules : [])) {
        const os = String((r && r.os) || '').trim().toLowerCase();
        if (!EDR_OS_VALUES.includes(os) || seen.has(os)) continue;
        seen.add(os);
        const d = (r && r.durationDays !== undefined) ? r.durationDays : null;
        let days = null;
        if (d !== null && d !== undefined && String(d).trim() !== '') {
            const n = Math.round(Number(d));
            if (Number.isFinite(n)) days = Math.min(365, Math.max(1, n));
        }
        rules.push({ os, durationDays: days });
    }
    return { enabled: cfg.enabled === true, rules }; // default OFF - the kill switch
}

async function getEdrAutoBypassConfig() {
    try { return normEdrAutoBypass(JSON.parse((await getSetting(edrAutoKey())) || 'null')); }
    catch { return normEdrAutoBypass(null); }
}
async function setEdrAutoBypassConfig(cfg) {
    const out = normEdrAutoBypass(cfg);
    await setSetting(edrAutoKey(), JSON.stringify(out));
    return out;
}

async function edrIdSet(key) {
    try {
        const a = JSON.parse((await getSetting(key)) || '[]');
        return new Set(Array.isArray(a) ? a.map(String).filter(Boolean) : []);
    } catch { return new Set(); }
}
async function saveEdrIdSet(key, set, cap) {
    const arr = [...set]; // Sets keep insertion order - trimming the head drops the OLDEST ids
    await setSetting(key, JSON.stringify(arr.length > cap ? arr.slice(arr.length - cap) : arr));
}

// Called from the EXPLICIT admin revoke paths only (the revoke-bypass route and an Access Review
// "Revoke" decision) - never from the scheduler's natural expiry. A peer whose TIMED auto-bypass
// simply expired is blocked again and gets re-applied on the next sync (rolling renewal while the
// rule stays on); only a human revoke puts it in the revoke memory, permanently.
// Returns true when the revoked bypass was one WE applied.
async function noteEdrAutoBypassRevoked(peerId) {
    const id = String(peerId || '');
    if (!id) return false;
    try {
        const applied = await edrIdSet(edrAppliedKey());
        if (!applied.has(id)) return false;
        applied.delete(id);
        await saveEdrIdSet(edrAppliedKey(), applied, EDR_APPLIED_CAP);
        const revoked = await edrIdSet(edrRevokedKey());
        if (!revoked.has(id)) {
            revoked.add(id);
            await saveEdrIdSet(edrRevokedKey(), revoked, EDR_REVOKED_CAP);
        }
        return true;
    } catch (e) {
        console.error('[EDR auto-bypass] revoke memory error:', e.message);
        return false;
    }
}

// Telegram notice on the SAME security-alerts category as the other security alerts
// (Settings → Telegram → Security Alerts); ALS-aware, so a tenant's message goes to the
// tenant's own chat/topic.
function notifyAutoEdrBypass(device, osLabel, days) {
    const cats = getTelegramConfig().categories;
    const cat = cats && cats.alerts;
    if (cat && cat.enabled === false) return Promise.resolve(null);
    const dur = days ? `${days} day${days === 1 ? '' : 's'}` : 'unlimited';
    const html = `🛡 <b>Automatic EDR Bypass</b>${tgEsc(tenantTag())}\n`
        + `Automatic EDR bypass applied to <b>${tgEsc(device)}</b> (${tgEsc(osLabel)})\n`
        + `⏱ <b>${tgEsc(dur)}</b>`;
    return sendTelegram('alerts', html).catch(() => { });
}

// One evaluation pass for the ACTIVE account, run right after every peers mirror refresh (so it
// covers main and every tenant - refreshPeersCache is the single code path both use). `peers` is
// the raw NetBird peer list just fetched.
async function applyAutoEdrBypasses(peers) {
    // The apply step is a NetBird WRITE - blocked in read-only mode (netbirdPost would answer 503
    // and bypassPeer would throw); bail early so a read-only instance stays silent. Configuring
    // the rules is still allowed.
    if (NETBIRD_READONLY) return { applied: 0 };
    const cfg = await getEdrAutoBypassConfig();
    if (!cfg.enabled || !cfg.rules.length) return { applied: 0 };
    const byOs = new Map(cfg.rules.map(r => [r.os, r]));

    const matched = [];
    for (const p of (Array.isArray(peers) ? peers : [])) {
        if (!p || !p.id) continue;
        if (!p.approval_required) continue;      // not compliance-blocked - nothing to bypass
        if (peerIsBypassed(p.id, p)) continue;   // already bypassed (manually or by us)
        const os = edrOsKey(p.os);
        if (!os || !byOs.has(os)) continue;
        matched.push({ peer: p, os, rule: byOs.get(os) });
    }
    if (!matched.length) return { applied: 0 };

    const revoked = await edrIdSet(edrRevokedKey());
    let todo = matched.filter(m => !revoked.has(String(m.peer.id)));
    if (!todo.length) return { applied: 0 };
    let capped = false;
    if (todo.length > EDR_AUTO_MAX_PER_RUN) {
        console.warn('[EDR auto-bypass] %d blocked devices matched a rule this run - applying only %d (review the rules)', todo.length, EDR_AUTO_MAX_PER_RUN);
        todo = todo.slice(0, EDR_AUTO_MAX_PER_RUN);
        capped = true;
    }

    const applied = await edrIdSet(edrAppliedKey());
    let n = 0;
    for (const m of todo) {
        const name = m.peer.name || m.peer.dns_label || m.peer.id;
        const days = m.rule.durationDays;
        try {
            await bypassPeer(m.peer.id); // the exact call the manual approve makes
        } catch (e) {
            console.error('[EDR auto-bypass] failed for %s: %s', name, e.message);
            continue;
        }
        // Identical bookkeeping to a manual timed approval - the 60s revokeExpiredBypasses
        // scheduler owns the expiry, and getAllPeers surfaces bypass_expires_at as usual.
        if (days) {
            await pool.query(`
                INSERT INTO bypass_expirations (tenant, peer_id, peer_name, requester_email, requester_name, request_id, expires_at, delete_peer)
                VALUES ($1, $2, $3, '', 'Automatic EDR Bypass', NULL, NOW() + ($4 || ' days')::interval, false)
                ON CONFLICT (tenant, peer_id) DO UPDATE SET
                    expires_at = EXCLUDED.expires_at, peer_name = EXCLUDED.peer_name,
                    requester_name = EXCLUDED.requester_name, request_id = NULL, delete_peer = false
            `, [tnt(), m.peer.id, name, String(days)]).catch(e => console.error('[EDR auto-bypass] expiry save error:', e.message));
        } else {
            // Unlimited: no row (exactly like an unlimited manual bypass) → it becomes a
            // recertification item every round.
            await pool.query(`DELETE FROM bypass_expirations WHERE tenant=$1 AND peer_id=$2`, [tnt(), m.peer.id]).catch(() => { });
        }
        applied.add(String(m.peer.id));
        n++;
        recordAudit({
            actorId: '', actorEmail: '', actorName: 'Automatic EDR Bypass',
            action: 'peer.bypass_auto', target: name,
            meta: {
                device: name, rule: EDR_OS_LABELS[m.os] || m.os, reportedOs: m.peer.os || '',
                duration: days ? `${days} day${days === 1 ? '' : 's'}` : 'unlimited',
            },
        }).catch(() => { });
        notifyAutoEdrBypass(name, EDR_OS_LABELS[m.os] || m.os, days).catch(() => { });
    }
    if (n) {
        await saveEdrIdSet(edrAppliedKey(), applied, EDR_APPLIED_CAP);
        // Re-read NetBird's bypassed list so peerIsBypassed is immediately truthful: the Peers
        // page shows the badge on this refresh, and the NEXT sync will not re-apply these.
        await refreshBypassedPeers().catch(() => { });
    }
    return { applied: n, capped };
}

// ─── Anomaly alerts (Telegram) - suspicious changes get their own 🚨 message ───
// Configured in-app (Settings → Security). Covered: a device switching country, a NEW device
// enrolling from a country the user was never seen in, admin actions outside working hours
// (app time zone), and per-device traffic spikes (> multiplier × its 7-day hourly average
// AND above a floor).
function sendAnomalyAlert(html) {
    // Routed via the 'alerts' Telegram category → its own topic when one is configured
    // (Settings → Telegram). Missing category = on by default (the real master switch is
    // anomalyEnabled in Settings → Security); explicitly unchecked = off.
    // _telegram state now lives in lib/telegram.js; read the live categories map via getTelegramConfig().
    const cats = getTelegramConfig().categories;
    const cat = cats && cats.alerts;
    if (cat && cat.enabled === false) return Promise.resolve(null);
    return sendTelegram('alerts', `🚨 ${html}`).catch(() => { });
}

// Telegram alert when a background job breaks (repeated consecutive failures) or recovers.
// Fired by server.js's tracked() wrapper ON TRANSITIONS ONLY - once when a job crosses the
// failure threshold, once when it succeeds again - never on every failing tick. Without this,
// a silently-broken scheduler job is only visible if someone happens to open System Health.
// Master switch: schedAlertsEnabled (Settings → Security); same 'alerts' topic as anomalies.
function notifySchedJobAlert(name, { failed, failures, error } = {}) {
    if (!_security.schedAlertsEnabled) return Promise.resolve(null);
    const cats = getTelegramConfig().categories;
    const cat = cats && cats.alerts;
    if (cat && cat.enabled === false) return Promise.resolve(null);
    const html = failed
        ? `🚨 <b>Background Job Failing</b>\n\n⚙️ <b>Job:</b> ${tgEsc(name)}\n🔁 <b>Consecutive Failures:</b> ${failures}\n❗ <b>Last Error:</b> ${tgEsc(error || 'unknown')}\n\nDetails: Operations → System Health.`
        : `✅ <b>Background Job Recovered</b>\n\n⚙️ <b>Job:</b> ${tgEsc(name)} is running normally again.`;
    return sendTelegram('alerts', html).catch(() => { });
}

function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

// Hourly: flag devices that moved far more traffic in the last hour than their own baseline.
let _trafficAnomalyHour = '';
async function checkTrafficAnomalies() {
    if (!_security.anomalyEnabled || !getTelegramConfig().enabled) return;
    const hourKey = new Date().toISOString().slice(0, 13);
    if (_trafficAnomalyHour === hourKey) return; // once per hour
    _trafficAnomalyHour = hourKey;
    const floor = _security.trafficFloorMb * 1024 * 1024;
    const r = await pool.query(`
        WITH last_hour AS (
            SELECT source_name AS src, SUM(rx_bytes + tx_bytes)::bigint AS b
            FROM events
            WHERE tenant = $3 AND timestamp >= NOW() - interval '1 hour' AND COALESCE(source_name, '') <> ''
            GROUP BY 1
        ), baseline AS (
            SELECT source_name AS src, SUM(rx_bytes + tx_bytes)::numeric / 168 AS avg_b
            FROM events
            WHERE tenant = $3 AND timestamp >= NOW() - interval '8 days' AND timestamp < NOW() - interval '1 hour'
              AND COALESCE(source_name, '') <> ''
            GROUP BY 1
        )
        SELECT l.src, l.b, COALESCE(bs.avg_b, 0)::bigint AS avg_b
        FROM last_hour l LEFT JOIN baseline bs ON bs.src = l.src
        WHERE l.b > $1 AND l.b > COALESCE(bs.avg_b, 0) * $2
        ORDER BY l.b DESC LIMIT 5
    `, [floor, _security.trafficMult, tnt()]).catch(() => ({ rows: [] }));
    for (const row of r.rows) {
        const avg = Number(row.avg_b);
        await sendAnomalyAlert(`📈 <b>Traffic Spike</b>\n🖥 ${tgEsc(row.src)}\n📊 <b>${fmtBytes(Number(row.b))}</b> in the last hour${avg > 0 ? ` (hourly average: ${fmtBytes(avg)})` : ' (no prior baseline)'}`);
    }
}

async function upsertPeers(peers) {
    const t = tnt(); // one account for the whole batch (ALS context is stable across the loop)
    // Snapshot the previous geo/owner per peer, to detect country changes and
    // new devices enrolling from a country the user was never seen in.
    let prev = new Map();
    if (_security.anomalyEnabled && getTelegramConfig().enabled) {
        try {
            const r = await pool.query(`SELECT peer_id, raw_json->>'country_code' AS cc, raw_json->>'user_id' AS uid FROM peers WHERE tenant = $1`, [t]);
            prev = new Map(r.rows.map(x => [x.peer_id, x]));
        } catch { /* alerts are best-effort */ }
    }
    // Previous login state per peer - the compliance-blocked owner email fires ONLY on a
    // transition observed between two syncs (a login happening right now), never on state.
    let loginPrev = null;
    try {
        const r0 = await pool.query(`SELECT peer_id, raw_json->>'last_login' AS ll FROM peers WHERE tenant = $1`, [t]);
        loginPrev = new Map(r0.rows.map(x => [x.peer_id, x.ll || '']));
    } catch { /* email is best-effort */ }
    const alerts = [];
    const client = await pool.connect();
    try {
        for (const p of peers) {
            if (!p || !p.id) continue;
            // Mirror rows are stamped with the active account - main ('') or a tenant, identically.
            await client.query(`
                INSERT INTO peers (tenant, peer_id, name, dns_label, ip, raw_json, updated_at)
                VALUES ($6, $1, $2, $3, $4, $5, NOW())
                ON CONFLICT (tenant, peer_id) DO UPDATE SET
                    name = $2, dns_label = $3, ip = $4, raw_json = $5, updated_at = NOW()
            `, [p.id, p.name || '', p.dns_label || '', p.ip || '', JSON.stringify(p), t]);

            if (_security.anomalyEnabled && getTelegramConfig().enabled && p.country_code && prev.size) {
                const old = prev.get(p.id);
                const flag = countryFlag(p.country_code) || '';
                if (old && old.cc && old.cc !== p.country_code) {
                    alerts.push(`🌍 <b>Device Changed Country</b>\n🖥 ${tgEsc(p.name || p.id)}\n📍 <b>${tgEsc(countryName(old.cc) || old.cc)} → ${flag} ${tgEsc(countryName(p.country_code) || p.country_code)}</b>${p.connection_ip ? `\n🌐 ${tgEsc(p.connection_ip)}` : ''}`);
                } else if (!old && p.user_id) {
                    const known = new Set([...prev.values()].filter(x => x.uid === p.user_id && x.cc).map(x => x.cc));
                    if (known.size && !known.has(p.country_code)) {
                        alerts.push(`🆕 <b>New Device From a New Country</b>\n🖥 ${tgEsc(p.name || p.id)}\n📍 ${flag} <b>${tgEsc(countryName(p.country_code) || p.country_code)}</b> (user's other devices: ${[...known].join(', ')})`);
                    }
                }
            }
        }
    } finally {
        client.release();
    }
    for (const a of alerts.slice(0, 5)) await sendAnomalyAlert(a);
    // Owner email for compliance-blocked devices - fires only on a login observed RIGHT NOW.
    notifyComplianceBlockedOwners(peers, loginPrev).catch(e => console.error('[Compliance email] error:', e.message));
}

// A user-owned peer with approval_required (and no bypass) failed to get network access.
// The trigger is a TRANSITION between two consecutive syncs - nothing else:
//   - an existing peer whose last_login CHANGED (the user logged in just now), or
//   - a brand-new peer that enrolled since the previous sync (enrolling IS logging in).
// Pure state ("this peer is blocked") never emails - so a deploy, a restart or an initial
// cache fill (empty baseline) can never mass-mail the backlog.
// Kill switch: Settings → Email → compliance_blocked_email ('false' disables).
async function notifyComplianceBlockedOwners(peers, loginPrev) {
    if (tnt()) return; // customer-facing emails for tenants need their own policy - main only for now
    if (!getSmtpConfig().enabled) return;
    if (!loginPrev || !loginPrev.size) return; // no baseline (initial fill / snapshot failed) - nothing is "now"
    if ((await getSetting('compliance_blocked_email')) === 'false') return;
    for (const p of (Array.isArray(peers) ? peers : [])) {
        if (!p || !p.id || !p.user_id) continue;
        if (!p.approval_required || peerIsBypassed(p.id, p)) continue;
        const before = loginPrev.get(p.id);
        const isNewPeer = before === undefined;
        const loggedInNow = before !== undefined && String(before || '') !== String(p.last_login || '');
        if (!isNewPeer && !loggedInNow) continue;
        const u = await resolveUser(p.user_id).catch(() => null);
        if (u && u.email) {
            notifyComplianceBlockedEmail({
                to: u.email, name: u.display_name || '',
                device: p.name || p.dns_label || p.id,
                reason: p.disapproval_reason || '',
            });
        }
    }
}

// The EDR-bypassed peer set (_bypassedPeerIds + refreshBypassedPeers / peerIsBypassed) now lives in
// lib/netbird.js; refreshBypassedPeers / peerIsBypassed are imported at the top of this file, and
// getBypassedPeerCount() exposes the set size for the System Health page.

async function refreshPeersCache() {
    const t = tnt();
    await refreshBypassedPeers();
    const peers = await fetchPeersFromApi();
    if (peers) {
        await upsertPeers(peers);
        // Prune peers that were deleted in NetBird so they stop appearing in the app - the cache
        // mirrors NetBird. Only when the API returned at least one peer (don't wipe on a transient
        // empty/error response).
        const ids = peers.map(p => p && p.id).filter(Boolean);
        if (ids.length) {
            // Prune only THIS account's rows - other accounts' rows must survive.
            await pool.query(`DELETE FROM peers WHERE tenant = $2 AND peer_id <> ALL($1)`, [ids, t])
                .catch(e => console.error('[PeerResolve] prune error:', e.message));
        }
        console.log(`[PeerResolve] Cached ${peers.length} peers from NetBird API`);
        // Automatic EDR bypass by OS - evaluated on EVERY peers sync, for EVERY account (main and
        // each tenant run this same path inside their own context, so tnt()-keyed rules apply to
        // that account's own peers). Best-effort: never let it break the mirror refresh.
        await applyAutoEdrBypasses(peers).catch(e => console.error('[EDR auto-bypass] error:', e.message));
    }
    _peersLastRefresh.set(t, Date.now());
}

// Refresh the peers cache if stale; coalesces concurrent callers into one request PER account.
function ensurePeersFresh() {
    if (!netbirdApiConfigured()) return Promise.resolve();
    const key = tnt();
    if (Date.now() - (_peersLastRefresh.get(key) || 0) < PEERS_TTL_MS) return Promise.resolve();
    const inflight = _peersRefreshing.get(key);
    if (inflight) return inflight;
    const p = refreshPeersCache()
        .catch(err => console.error('[PeerResolve] Refresh error:', err.message))
        .finally(() => { _peersRefreshing.delete(key); });
    _peersRefreshing.set(key, p);
    return p;
}

// ─── Microsoft Graph: user AD group membership (for admin + permissions) ───
// Uses the app's own client credentials (same App Registration as login) to read
// a user's transitive group memberships. Requires the Graph application permission
// GroupMember.Read.All (or Directory.Read.All) with admin consent.
const GRAPH_TTL_MS = 5 * 60 * 1000;
let _graphToken = null, _graphTokenExp = 0;
const _userGroupsCache = {}; // oid -> { groups: [ids], at: ts }

function graphConfigured() {
    return !!(process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && process.env.OIDC_ISSUER_BASE_URL);
}

function graphTenantBase() {
    return (process.env.OIDC_ISSUER_BASE_URL || '').replace(/\/v2\.0\/?$/, '');
}

function getGraphToken() {
    if (_graphToken && Date.now() < _graphTokenExp - 60000) return Promise.resolve(_graphToken);
    if (!graphConfigured()) return Promise.resolve(null);
    const tokenUrl = new URL(graphTenantBase() + '/oauth2/v2.0/token');
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.OIDC_CLIENT_ID,
        client_secret: process.env.OIDC_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
    }).toString();
    return new Promise((resolve) => {
        const req = https.request(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
            timeout: 10000,
        }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j.access_token) { _graphToken = j.access_token; _graphTokenExp = Date.now() + (j.expires_in || 3600) * 1000; resolve(_graphToken); }
                    else { console.error('[Graph] token error:', j.error_description || j.error || d.slice(0, 150)); resolve(null); }
                } catch (e) { console.error('[Graph] token parse error:', e.message); resolve(null); }
            });
        });
        req.on('error', e => { console.error('[Graph] token request error:', e.message); resolve(null); });
        req.on('timeout', () => { console.error('[Graph] token timeout'); req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

function graphGet(token, apiPath) {
    return new Promise((resolve) => {
        const url = new URL('https://graph.microsoft.com/v1.0' + apiPath);
        const req = https.get(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, timeout: 10000 }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// Transitive AD group ids for a user (cached per oid). Returns [] if Graph isn't set up.
async function fetchUserGroups(oid) {
    if (!oid || !graphConfigured()) return [];
    const cached = _userGroupsCache[oid];
    if (cached && Date.now() - cached.at < GRAPH_TTL_MS) return cached.groups;
    const token = await getGraphToken();
    if (!token) return cached ? cached.groups : [];
    const json = await graphGet(token, `/users/${encodeURIComponent(oid)}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999`);
    let groups;
    if (json && Array.isArray(json.value)) groups = json.value.map(g => g.id).filter(Boolean);
    else {
        // Surface WHY Graph returned no groups. The usual cause is a 403
        // "Authorization_RequestDenied" - the app registration is missing the
        // GroupMember.Read.All (or Directory.Read.All) APPLICATION permission with admin consent.
        const errMsg = json && json.error ? `${json.error.code || ''} ${json.error.message || ''}`.trim() : 'no group list returned';
        console.error('[Graph] transitiveMemberOf for %s failed: %s', oid, errMsg);
        groups = cached ? cached.groups : []; // keep stale on failure
    }
    _userGroupsCache[oid] = { groups, at: Date.now() };
    return groups;
}

// Live Graph diagnostic for /api/me?debug - runs the actual group lookup and returns the
// outcome (token ok? which tenant? how many groups? exact error) so an empty adGroups can be
// explained from the browser without server-log access.
async function graphGroupDiag(oid) {
    const out = { graphConfigured: graphConfigured(), tenantBase: graphTenantBase(), oid: oid || null, tokenOk: false, groupCount: 0, error: null };
    if (!out.graphConfigured) { out.error = 'Graph not configured (need OIDC_CLIENT_ID/SECRET/ISSUER)'; return out; }
    if (!oid) { out.error = 'no oid on the session token'; return out; }
    const token = await getGraphToken();
    out.tokenOk = !!token;
    if (!token) { out.error = 'could not acquire a Graph app token - check the client secret / tenant (see [Graph] token error in logs)'; return out; }
    const json = await graphGet(token, `/users/${encodeURIComponent(oid)}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999`);
    if (json && Array.isArray(json.value)) { out.groupCount = json.value.length; return out; }
    out.error = json && json.error ? `${json.error.code || ''}: ${json.error.message || ''}`.trim() : 'Graph returned no group list';
    return out;
}

// ─── Address blocklist (IPs / CIDRs / domains that may not be added as resources) ───
// The blocklist CRUD (getBlocklist / add / update / delete) and the pure address/CIDR/domain
// matching helpers now live in lib/blocklist.js (one-way dependency: db.js -> lib/blocklist.js ->
// lib/core.js). addressesOverlap backs assertAddressUniqueInNetwork; addressMatchesValue
// and entryAppliesToNetwork are imported for scanBlockedResources/enforceBlockedResources below,
// which stay here because they call domain functions (getUsageData/deleteResource/setResourceEnabled).
const {
    getBlocklist, addBlocklistEntry, addBlocklistEntries, updateBlocklistEntry, deleteBlocklistEntry, addressBlockedForNetwork,
    addressMatchesValue, entryAppliesToNetwork, entryMatchesAddress, entryLabel, addressesOverlap, addrRange4,
} = require('./lib/blocklist');

// ─── Blocklist enforcement on EXISTING resources ───
// Scan every network's resources for addresses matching a blocklist entry whose `enforce`
// mode is 'disable' or 'delete' (respecting each entry's network scope). Read-only.
async function scanBlockedResources() {
    const enforceEntries = (await getBlocklist()).filter(e => e.enabled !== false && (e.enforce === 'disable' || e.enforce === 'delete'));
    if (!enforceEntries.length) return { matches: [], entries: 0 };
    const usage = await getUsageData();
    const netById = new Map();
    const netOfResource = new Map();
    for (const n of usage.networks || []) {
        netById.set(n.id, n);
        for (const rid of (Array.isArray(n.resources) ? n.resources : [])) netOfResource.set(rid, n.id);
    }
    const matches = [];
    for (const r of usage.resources || []) {
        if (!r || !r.address) continue;
        const networkId = netOfResource.get(r.id) || '';
        let hit = null;
        for (const e of enforceEntries) {
            if (!entryAppliesToNetwork(e, networkId)) continue;
            if (entryMatchesAddress(e, r.address)) { hit = e; break; }
        }
        if (!hit) continue;
        const net = netById.get(networkId);
        matches.push({
            resourceId: r.id, resourceName: r.name || '', address: r.address,
            enabled: r.enabled !== false,
            networkId, networkName: (net && net.name) || networkId || '(unknown)',
            matchedValue: entryLabel(hit), action: hit.enforce, entryId: hit.id,
        });
    }
    return { matches, entries: enforceEntries.length };
}

// Apply the configured action (disable/delete) to matching existing resources. `ids` (resource
// ids the caller confirmed) scopes the action; omitted = all current matches. Re-scans first so
// we only ever touch resources that still match a live blocklist entry.
async function enforceBlockedResources(ids) {
    const { matches } = await scanBlockedResources();
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
    const target = wanted ? matches.filter(m => wanted.has(String(m.resourceId))) : matches;
    const counts = { disabled: 0, deleted: 0, skipped: 0, failed: 0, total: target.length };
    const errors = [];
    for (const m of target) {
        try {
            if (m.action === 'delete') {
                await deleteResource(m.networkId, m.resourceId);
                counts.deleted++;
            } else { // disable
                if (m.enabled === false) { counts.skipped++; continue; } // already disabled
                await setResourceEnabled(m.networkId, m.resourceId, false);
                counts.disabled++;
            }
        } catch (e) {
            counts.failed++;
            errors.push({ resourceId: m.resourceId, networkId: m.networkId, error: e.message });
            console.error('[blocklist enforce] %s "%s" (net %s) failed: %s', m.action, m.resourceId, m.networkId, e.message);
        }
    }
    bustNbCaches('usage', 'policies'); // bust caches after mutating NetBird
    return { ...counts, errors };
}

// ─── Automations: external HTTP source → auto-provisioned NetBird resources ───
// The whole automation engine (CRUD, source poller, test + dry-run diagnostics, the sync engine
// runAutomation/runDueAutomations, plus the automation-only helpers resourceHasGroups and
// setResourceNameFrom) now lives in lib/automations.js (one-way dependency: db.js ->
// lib/automations.js -> lib/{core,http,netbird,blocklist}.js). The domain functions the sync
// engine calls stay in db.js and are injected once via initAutomations() below - they are all
// hoisted function declarations, so the mid-file init call captures live references safely.
const {
    initAutomations,
    listAutomations, getAutomationRow, createAutomation, updateAutomation, deleteAutomation,
    getAutomationRuns, runAutomation, testAutomation, runDueAutomations, resetStuckAutomations,
    getAutomationManaged, repairAutomation, forgetAutomation, dryRunAutomation,
} = require('./lib/automations');
initAutomations({ listAccessProfiles, getNetworkDetail, addResourceGroups, setResourceEnabled, createClientResource, deleteResource, recordAudit, getDupAllowedNetworkIds });


// ─── Temporary access grants: time-boxed user→resource access, auto-revoked on expiry ───

const _runningGrants = new Set();

// The grantee's devices (peers) - used for the informational device count only.
// Match on the NetBird user id (full or the IdP-subject tail) OR the owner email, since a
// peer's raw user_id and the /api/users id don't always share the same prefix form.
async function getUserPeers(userId) {
    const uid = String(userId || '');
    const tail = uid.split('|').pop();
    let email = '';
    try { const u = (await getAllUsers()).find(x => String(x.id) === uid); email = ((u && u.email) || '').toLowerCase(); } catch { /* ignore */ }
    const all = await getAllPeers();
    return all.filter(p => {
        const pu = String(p.user_id || '');
        if (pu && (pu === uid || pu.split('|').pop() === tail)) return true;
        return !!email && String(p.owner_email || '').toLowerCase() === email;
    });
}

// The live NetBird user object (for role / auto_groups), matched by id or IdP-subject tail.
async function getNbUser(userId) {
    const uid = String(userId || '');
    const tail = uid.split('|').pop();
    const users = await netbirdGet('/api/users');
    return (Array.isArray(users) ? users : []).find(u => String(u.id) === uid || String(u.id).split('|').pop() === tail) || null;
}

// Add/remove a group from a user's auto-assigned groups (what NetBird's "Assign Users" does).
// The user's peers inherit the group, so a policy sourced from it grants them access.
// Returns true when it actually changed something. GET-then-PUT preserves role / is_blocked.
async function setUserGroupMembership(userId, groupId, add) {
    const u = await getNbUser(userId);
    if (!u) throw new Error(`user not found in NetBird (id "${userId}")`);
    const idsOf = arr => (Array.isArray(arr) ? arr.map(g => (g && g.id) || g).filter(Boolean) : []);
    const current = idsOf(u.auto_groups);
    const has = current.includes(groupId);
    if (add ? has : !has) return false;
    const next = add ? [...current, groupId] : current.filter(g => g !== groupId);
    const body = { role: u.role || 'user', auto_groups: next, is_blocked: !!u.is_blocked };
    console.log('[grant] %s group %s %s user %s (role %s)', add ? 'assigning' : 'removing', groupId, add ? 'to' : 'from', u.id, u.role || 'user');
    const resp = await netbirdReq('PUT', '/api/users/' + encodeURIComponent(u.id), body);
    if (!resp || resp.status >= 300) {
        throw new Error(`NetBird rejected the user update (HTTP ${resp && resp.status}): ${resp && (resp.raw || resp.error || '')} - the API token likely lacks user-management permission`);
    }
    // Verify against the returned user object: some tokens accept the request but ignore
    // auto_groups. Only trip when the response explicitly shows the change didn't take.
    if (resp.body && Array.isArray(resp.body.auto_groups) && idsOf(resp.body.auto_groups).includes(groupId) !== add) {
        throw new Error('NetBird accepted the request but did not change the user\'s groups - the API token most likely lacks user-management permission (use a token from an Admin/Owner service user)');
    }
    bustNbCaches('gref', 'usage'); _usersLastRefresh.set(tnt(), 0);
    return true;
}

function grantExpiryFrom(cfg) {
    const exp = cfg.durationMinutes
        ? new Date(Date.now() + Math.max(1, parseInt(cfg.durationMinutes, 10)) * 60000)
        : new Date(cfg.expiresAt);
    if (!(exp instanceof Date) || isNaN(exp.getTime()) || exp.getTime() <= Date.now()) throw new Error('expiry must be in the future');
    return exp;
}

// Format a date using the app's configured time zone + date format (mirrors the frontend's
// logfmt), so server-generated labels (e.g. temp-access group names) match what the UI shows.
async function formatConfiguredDate(date) {
    let tz = 'UTC', df = 'med', hour12 = true;
    try {
        const [t, d, h] = await Promise.all([getSetting('timezone'), getSetting('date_format'), getSetting('hour12')]);
        if (t) tz = t; if (d) df = d; hour12 = h !== 'false';
    } catch { /* use defaults */ }
    const dt = new Date(date);
    const tzOpt = { timeZone: tz };
    try {
        let dateStr;
        switch (df) {
            case 'iso': dateStr = dt.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...tzOpt }); break;
            case 'dmy': dateStr = dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', ...tzOpt }); break;
            case 'mdy': dateStr = dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', ...tzOpt }); break;
            case 'dmy_med': dateStr = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...tzOpt }); break;
            default: dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...tzOpt });
        }
        const timeStr = dt.toLocaleTimeString('en-US', { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12, ...tzOpt });
        return `${dateStr}, ${timeStr}`;
    } catch {
        return dt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }
}

// ALL_COMBO, comboKey and combosForResource (least-privilege combo logic) now live in
// lib/pure.js (imported at the top).

async function createTemporaryAccessGrant(cfg, actor) {
    const userId = String((cfg && cfg.userId) || '').trim();
    if (!userId) throw new Error('a user is required');
    const targets = Array.isArray(cfg.targets) ? cfg.targets.filter(t => t && t.id && t.type) : [];
    if (!targets.length) throw new Error('at least one target is required');
    const expiresAt = grantExpiryFrom(cfg);

    const peers = await getUserPeers(userId);
    const label = String(cfg.userLabel || (peers[0] && (peers[0].owner_name || peers[0].owner_email)) || userId);
    // Recipient email for the "access granted / ended" notification (explicit, else a peer, else
    // the NetBird user). Resolved even for users with no enrolled device yet.
    let recipientEmail = String(cfg.userEmail || (peers.find(p => p.owner_email) || {}).owner_email || '').trim();
    if (!recipientEmail) { const nbu = await getNbUser(userId).catch(() => null); recipientEmail = (nbu && nbu.email) || ''; }
    const until = await formatConfiguredDate(expiresAt);
    // Reserve the grant id up front so the NetBird group/policy names can be short and stable
    // (`#<id> (until <date>)`) - these objects are app-managed, so a long user label just clutters.
    const grantId = (await pool.query(`SELECT nextval(pg_get_serial_sequence('temporary_access_grants','id')) AS id`)).rows[0].id;
    // Crash-safety: write a 'creating' placeholder BEFORE touching NetBird. If the process
    // dies mid-creation, this row (plus the "#<id>" embedded in every NetBird object name)
    // lets cleanupStuckCreatingGrants find and delete the orphaned groups/policies - without
    // it they would be untracked forever. Success flips the row to 'active'; a thrown error
    // deletes it (after the in-line compensation removed the NetBird objects).
    await pool.query(
        `INSERT INTO temporary_access_grants (id, user_id, user_label, user_email, targets, note, expires_at, created_by, status, tenant)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'creating',$9)`,
        [grantId, userId, label, recipientEmail, JSON.stringify(targets), String(cfg.note || '').trim(), expiresAt.toISOString(), (actor && (actor.email || actor.name)) || '', tnt()]
    );

    // Split targets:
    //  - GROUP    → the user JOINS that exact group directly (their explicit choice; they get
    //               everything that group grants, and appear in its Users tab).
    //  - PROFILE  → the policy points at the profile's *destination* group, so the user gets
    //               EXACTLY the profile's resources - never whatever the profile's shared source
    //               groups grant elsewhere.
    //  - RESOURCE → collected and dropped into one shared destination group (below).
    //  - NETWORK  → expands into all of its resources, collected the same way.
    // Everything that isn't a direct group-join is served by a SINGLE policy: the user goes into
    // one source group (Gs), all the loose resources into one destination group (Gd), and the
    // policy is Gs -> [Gd, ...profile destination groups]. One group pair, one policy, however
    // many resources - the Access Profile pattern (NetBird keeps only one destinationResource per
    // policy, so per-resource policies don't scale; groups do).
    const joinGroups = new Set();
    const destGroupIds = new Set();   // profile destination groups (policy destinations)
    const destGroupAccess = new Map(); // profile dest group → access spec (null = profile default)
    const resourceRefs = [];          // { networkId, resourceId, access } to drop into Gd
    let profileGroups = null;         // lazy profile id → destination group id map
    // Auto-approval rules may pin the EXACT protocols/ports the grant opens (t.access,
    // one temp policy per protocol). null = mirror existing exposure, as always. Group
    // targets are direct memberships - a spec can't apply there and is ignored.
    for (const t of targets) {
        const acc = normAccessSpec(t.access);
        if (t.type === 'group') { joinGroups.add(t.id); continue; }
        if (t.type === 'profile') {
            let gid = t.groupId;
            if (!gid) {
                if (!profileGroups) profileGroups = new Map((await listAccessProfiles()).map(p => [String(p.id), p.groupId]));
                gid = profileGroups.get(String(t.id));
            }
            if (gid) {
                destGroupIds.add(gid);
                // Unrestricted (null) wins if the same profile group arrives twice.
                if (!destGroupAccess.has(gid) || acc === null) destGroupAccess.set(gid, acc);
            }
            continue;
        }
        if (t.type === 'resource') {
            if (t.networkId) resourceRefs.push({ networkId: t.networkId, resourceId: t.id, access: acc });
            continue;
        }
        if (t.type === 'network') {
            const rs = await netbirdGet('/api/networks/' + encodeURIComponent(t.id) + '/resources');
            for (const r of (Array.isArray(rs) ? rs : [])) {
                if (r && r.id) resourceRefs.push({ networkId: t.id, resourceId: r.id, access: acc });
            }
            continue;
        }
    }

    const assignedGroups = [];   // groups we actually added the user to (so revoke only undoes ours)
    let sourceGroupId = '';      // Gs - the temp source group the user joins
    const allDestGroupIds = [];  // every temp destination group we created (one per combo bucket)
    const destResources = [];    // { networkId, resourceId, groupId } we attached (for clean detach)
    let policyIds = [];
    try {
        // 1) direct group memberships (target groups). Only track the ones we actually add, so
        //    revoke never strips a membership the user already had.
        for (const gid of joinGroups) {
            if (await setUserGroupMembership(userId, gid, true)) assignedGroups.push(gid);
        }
        // 2) resources / profiles → one source group (Gs, user assigned) + one policy PER
        //    protocol/ports combo, MIRRORING each destination's EXISTING exposure: a resource
        //    whose only policy is TCP 39001 stays TCP 39001 for the temp user too - temporary
        //    access never opens more than the resource already allows. Resources with no policy
        //    at all have nothing to mirror and get 'all' (otherwise the grant would be inert);
        //    profiles mirror their own protocol/ports definition.
        if (resourceRefs.length || destGroupIds.size) {
            const gs = await netbirdPost('/api/groups', { name: `Temp access #${grantId} (until ${until})` });
            if (!gs || gs.status >= 300 || !gs.body || !gs.body.id) throw new Error('Failed to create group: ' + (gs && (gs.raw || gs.error || gs.status)));
            sourceGroupId = gs.body.id;
            await setUserGroupMembership(userId, sourceGroupId, true);
            assignedGroups.push(sourceGroupId);

            // ── Existing exposure per resource → combo buckets (pure logic: combosForResource) ──
            // Resource → groups lookup (one fetch per network; network targets were fetched above
            // but refetching here keeps this self-contained and cheap).
            // An unreadable list stops the grant: treating it as empty would mirror no policy
            // and no posture checks.
            const netResources = new Map();
            for (const rr of resourceRefs) {
                if (netResources.has(rr.networkId)) continue;
                const rs = await netbirdGet('/api/networks/' + encodeURIComponent(rr.networkId) + '/resources');
                if (!Array.isArray(rs)) throw new Error('could not read the resources of network ' + rr.networkId);
                netResources.set(rr.networkId, rs);
            }
            // All enabled, non-temporary policies (other grants' temp policies must not leak
            // their 'all' back into new grants).
            const rawPolicies = await netbirdGet('/api/policies');
            if (resourceRefs.length && !Array.isArray(rawPolicies)) throw new Error('could not read the existing policies');
            const polArr = (Array.isArray(rawPolicies) ? rawPolicies : [])
                .filter(p => p && p.enabled !== false && !/^Temporary access #\d+/.test(p.name || ''));
            const combosFor = (rr) => {
                const res = (netResources.get(rr.networkId) || []).find(x => x && x.id === rr.resourceId);
                if (!res) throw new Error('resource ' + rr.resourceId + ' was not found in network ' + rr.networkId);
                const rgroups = (Array.isArray(res.groups) ? res.groups : []).map(g => (g && g.id) || g);
                const existing = combosForResource(polArr, rr.resourceId, rgroups);
                if (!rr.access) return existing;
                // Rule-pinned protocols/ports keep the posture checks of the exposure they overlap.
                return accessSpecCombos(rr.access).map(c => {
                    const pc = postureChecksFor(c, existing);
                    return pc.length ? { ...c, postureChecks: pc } : c;
                });
            };

            // bucket key → { combo, resources: [rr], profileGroups: [gid] }
            const buckets = new Map();
            const bucketFor = (c) => {
                const k = comboKey(c);
                if (!buckets.has(k)) buckets.set(k, { combo: c, resources: [], profileGroups: [] });
                return buckets.get(k);
            };
            for (const rr of resourceRefs) {
                for (const c of combosFor(rr)) bucketFor(c).resources.push(rr);
            }
            if (destGroupIds.size) {
                const profByGid = new Map((await listAccessProfiles()).map(p => [p.groupId, p]));
                for (const gid of destGroupIds) {
                    const prof = profByGid.get(gid);
                    if (!prof) throw new Error('access profile not found for group ' + gid);
                    // The profile's posture checks gate the temp policy too.
                    const pc = postureIds(prof.postureChecks);
                    const gated = (c) => (pc.length ? { ...c, postureChecks: pc } : c);
                    const acc = destGroupAccess.get(gid);
                    if (acc) { // rule-pinned protocols/ports override the profile's definition
                        for (const c of accessSpecCombos(acc)) bucketFor(gated(c)).profileGroups.push(gid);
                        continue;
                    }
                    const ports = prof && (Array.isArray(prof.ports) ? prof.ports : String(prof.ports || '').split(',').map(s => s.trim()).filter(Boolean));
                    const c = prof && prof.protocol && prof.protocol !== 'all'
                        ? { protocol: prof.protocol, ...splitPortTokens(ports || []) }
                        : ALL_COMBO;
                    bucketFor(gated(c)).profileGroups.push(gid);
                }
            }

            // ── One destination group (when loose resources exist) + one policy per bucket ──
            let bi = 0;
            for (const b of buckets.values()) {
                bi++;
                const suffix = buckets.size > 1 ? ` (${bi})` : '';
                const destinations = [...b.profileGroups];
                if (b.resources.length) {
                    const gd = await netbirdPost('/api/groups', { name: `Temp resources #${grantId}${suffix} (until ${until})` });
                    if (!gd || gd.status >= 300 || !gd.body || !gd.body.id) throw new Error('Failed to create destination group: ' + (gd && (gd.raw || gd.error || gd.status)));
                    allDestGroupIds.push(gd.body.id);
                    for (const rr of b.resources) {
                        await addResourceGroups(rr.networkId, rr.resourceId, [gd.body.id]);
                        destResources.push({ ...rr, groupId: gd.body.id });
                    }
                    destinations.push(gd.body.id);
                }
                if (!destinations.length) continue;
                const rule = {
                    name: 'Temporary access', enabled: true, action: 'accept', bidirectional: false,
                    protocol: b.combo.protocol, ports: b.combo.ports || [], sources: [sourceGroupId], destinations,
                };
                if (b.combo.portRanges && b.combo.portRanges.length) rule.port_ranges = b.combo.portRanges;
                const p = await netbirdPost('/api/policies', {
                    name: `Temporary access #${grantId}${suffix}`, description: `Auto-managed temporary access for ${label}`, enabled: true,
                    source_posture_checks: b.combo.postureChecks || [],
                    rules: [rule],
                });
                if (p && p.status < 300 && p.body && p.body.id) policyIds.push(p.body.id);
                else throw new Error('Failed to create policy: ' + (p && (p.raw || p.error || p.status)));
            }
            if (!policyIds.length) throw new Error(`no reachable destinations for the chosen targets - a whole-network target needs at least one resource in that network`);
        }
        if (!assignedGroups.length) throw new Error('nothing to grant - the user may already be a member of the chosen group(s)');
    } catch (e) {
        for (const pid of policyIds) await netbirdReq('DELETE', '/api/policies/' + encodeURIComponent(pid)).catch(() => { });
        for (const rr of destResources) await removeResourceGroups(rr.networkId, rr.resourceId, [rr.groupId]).catch(() => { });
        for (const gid of assignedGroups) await setUserGroupMembership(userId, gid, false).catch(() => { });
        for (const gid of allDestGroupIds) await netbirdReq('DELETE', '/api/groups/' + encodeURIComponent(gid)).catch(() => { });
        if (sourceGroupId) await netbirdReq('DELETE', '/api/groups/' + encodeURIComponent(sourceGroupId)).catch(() => { });
        // Compensation removed the NetBird objects - drop the placeholder too.
        await pool.query(`DELETE FROM temporary_access_grants WHERE id=$1 AND status='creating' AND tenant=$2`, [grantId, tnt()]).catch(() => { });
        throw e;
    }

    const row = await pool.query(
        `UPDATE temporary_access_grants
         SET group_id=$2, dest_group_id=$3, dest_group_ids=$4, dest_resources=$5, assigned_groups=$6, policy_ids=$7, status='active'
         WHERE id=$1 AND tenant=$8 RETURNING id`,
        [grantId, sourceGroupId, allDestGroupIds[0] || '', JSON.stringify(allDestGroupIds), JSON.stringify(destResources), JSON.stringify(assignedGroups), JSON.stringify(policyIds), tnt()]
    );
    bustNbCaches('policies', 'gref', 'usage');
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'access.grant', target: label,
        meta: { targets: targets.map(t => t.name || t.id).join(', '), until: expiresAt.toISOString(), devices: peers.length || 'none yet' },
    }).catch(() => { });
    // Tell the recipient they now have access (covers both direct grants and approved requests).
    notifyGrantEmail({ to: recipientEmail, name: label, targets: targets.map(t => t.name || t.id).join(', '), expiresAt, note: String(cfg.note || '').trim() }).catch(() => { });
    return { id: row.rows[0].id, devices: peers.length };
}

async function revokeTemporaryAccessGrant(id, { trigger = 'manual', actor = null } = {}) {
    if (_runningGrants.has(id)) return { skipped: true };
    const r = await pool.query('SELECT * FROM temporary_access_grants WHERE id=$1 AND tenant=$2', [id, tnt()]);
    if (!r.rows.length) return { error: 'not found' };
    const g = r.rows[0];
    if (g.status !== 'active') return { skipped: true, reason: 'not active' };

    _runningGrants.add(id);
    await pool.query(`UPDATE temporary_access_grants SET last_status='running' WHERE id=$1 AND tenant=$2`, [id, tnt()]);
    let err = '';
    try {
        for (const pid of (Array.isArray(g.policy_ids) ? g.policy_ids : [])) {
            const resp = await netbirdReq('DELETE', '/api/policies/' + encodeURIComponent(pid));
            if (resp && resp.status >= 300 && resp.status !== 404) throw new Error('policy delete failed: ' + (resp.raw || resp.error || resp.status));
        }
        // Remove the user from every group we added them to (target groups, profile sources,
        // and the temp source group). Must precede deleting the temp group (a group referenced by
        // a user's auto_groups can't be removed cleanly). Idempotent - safe to retry.
        const assigned = Array.isArray(g.assigned_groups) && g.assigned_groups.length ? g.assigned_groups : (g.group_id ? [g.group_id] : []);
        for (const gid of assigned) await setUserGroupMembership(g.user_id, gid, false);
        // Detach the loose resources from their temp destination group(s) before deleting them
        // (a group still referenced by a resource can't be removed cleanly). Each entry carries
        // the group it was attached to (combo buckets); legacy rows fall back to dest_group_id.
        for (const rr of (Array.isArray(g.dest_resources) ? g.dest_resources : [])) {
            const gid = (rr && rr.groupId) || g.dest_group_id;
            if (rr && rr.networkId && rr.resourceId && gid) await removeResourceGroups(rr.networkId, rr.resourceId, [gid]);
        }
        // Delete only the temp groups we created (source + destinations); never the user's own groups.
        const tempGroups = [...new Set([g.group_id, g.dest_group_id, ...(Array.isArray(g.dest_group_ids) ? g.dest_group_ids : [])].filter(Boolean))];
        for (const gid of tempGroups) {
            const resp = await netbirdReq('DELETE', '/api/groups/' + encodeURIComponent(gid));
            if (resp && resp.status >= 300 && resp.status !== 404) throw new Error('group delete failed: ' + (resp.raw || resp.error || resp.status));
        }
    } catch (e) {
        err = e.message || String(e);
    } finally {
        _runningGrants.delete(id);
    }

    if (err) {
        // Leave it active so the next tick / a manual retry can try again.
        await pool.query(`UPDATE temporary_access_grants SET last_status='', last_error=$2 WHERE id=$1 AND tenant=$3`, [id, err, tnt()]);
        console.error('[grant revoke] %s failed: %s', id, err);
        return { status: 'error', error: err };
    }
    const status = trigger === 'expiry' ? 'expired' : 'revoked';
    await pool.query(
        `UPDATE temporary_access_grants SET status=$2, last_status='', last_error='', revoked_at=NOW(), revoked_by=$3 WHERE id=$1 AND tenant=$4`,
        [id, status, (actor && (actor.email || actor.name)) || (trigger === 'expiry' ? 'system' : ''), tnt()]
    );
    bustNbCaches('policies', 'gref', 'usage');
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || (trigger === 'expiry' ? 'system' : ''), actorName: (actor && actor.name) || (trigger === 'expiry' ? 'System' : ''),
        action: trigger === 'expiry' ? 'access.expire' : 'access.revoke', target: g.user_label || g.user_id,
        meta: { trigger, targets: (Array.isArray(g.targets) ? g.targets : []).map(t => t.name || t.id).join(', ') },
    }).catch(() => { });
    // Let the user know their access ended (expiry or manual revoke).
    notifyGrantEndedEmail({ to: g.user_email, name: g.user_label, targets: (Array.isArray(g.targets) ? g.targets : []).map(t => t.name || t.id).join(', '), trigger }).catch(() => { });
    return { status };
}

async function extendTemporaryAccessGrant(id, cfg, actor) {
    const r = await pool.query('SELECT * FROM temporary_access_grants WHERE id=$1 AND tenant=$2', [id, tnt()]);
    if (!r.rows.length) throw new Error('grant not found');
    const g = r.rows[0];
    if (g.status !== 'active') throw new Error('only an active grant can be extended');
    const newExp = grantExpiryFrom(cfg);
    await pool.query('UPDATE temporary_access_grants SET expires_at=$2 WHERE id=$1 AND tenant=$3', [id, newExp.toISOString(), tnt()]);
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'access.extend', target: g.user_label || g.user_id, meta: { until: newExp.toISOString() },
    }).catch(() => { });
    return { id, expiresAt: newExp.toISOString() };
}

async function listTemporaryAccessGrants() {
    const r = await pool.query(`SELECT * FROM temporary_access_grants WHERE tenant=$1 ORDER BY (status='active') DESC, expires_at DESC LIMIT 500`, [tnt()]);
    return r.rows.map(g => ({
        id: g.id, userId: g.user_id, userLabel: g.user_label || g.user_id,
        groupId: g.group_id || '', policyIds: Array.isArray(g.policy_ids) ? g.policy_ids : [],
        targets: Array.isArray(g.targets) ? g.targets : [],
        note: g.note || '', issuedAt: g.issued_at, expiresAt: g.expires_at,
        status: g.status || 'active', lastError: g.last_error || '',
        createdBy: g.created_by || '', revokedBy: g.revoked_by || '', revokedAt: g.revoked_at || null,
    }));
}

// Remove a finished (revoked/expired/error) grant row from history. Active grants must be revoked first.
async function deleteTemporaryAccessGrant(id) {
    const r = await pool.query('SELECT status FROM temporary_access_grants WHERE id=$1 AND tenant=$2', [id, tnt()]);
    if (r.rows.length && r.rows[0].status === 'active') throw new Error('revoke the grant before deleting it');
    await pool.query('DELETE FROM temporary_access_grants WHERE id=$1 AND tenant=$2', [id, tnt()]);
    return { deleted: true };
}

// Startup: clear any 'running' flags left by a crash so a revoke can be retried.
async function resetStuckGrants() {
    await pool.query(`UPDATE temporary_access_grants SET last_status='' WHERE last_status='running' AND tenant=$1`, [tnt()]).catch(() => { });
}

// Crash-recovery: a grant stuck in 'creating' means the process died between reserving the
// id and finishing the NetBird writes. Every object the creation makes embeds "#<id>" in
// its name (source group "Temp access #id (until …)", dest groups "Temp resources #id…",
// policies "Temporary access #id"), so the orphans can be found and deleted BY NAME even
// though the row never received their ids. Only rows older than 15 minutes are touched, so
// this can never race a creation still in progress. Rows whose cleanup fails stay
// 'creating' and are retried on the next tick (the failure shows on System Health).
async function cleanupStuckCreatingGrants() {
    if (NETBIRD_READONLY) return;
    const r = await pool.query(
        `SELECT * FROM temporary_access_grants WHERE status='creating' AND issued_at < NOW() - interval '15 minutes' AND tenant=$1`,
        [tnt()]
    ).catch(() => ({ rows: [] }));
    for (const g of r.rows) {
        let ok = true;
        try {
            // Policies first - they reference the groups.
            const polPat = new RegExp(`^Temporary access #${g.id}( \\(\\d+\\))?$`);
            for (const p of (await netbirdGet('/api/policies')) || []) {
                if (p && p.id && polPat.test(p.name || '')) {
                    const resp = await netbirdReq('DELETE', '/api/policies/' + encodeURIComponent(p.id));
                    if (resp && resp.status >= 300 && resp.status !== 404) ok = false;
                }
            }
            // Membership in directly-joined target groups (recorded on the placeholder row).
            const targets = Array.isArray(g.targets) ? g.targets : [];
            for (const t of targets) {
                if (t && t.type === 'group') await setUserGroupMembership(g.user_id, t.id, false).catch(() => { });
            }
            // Our temp groups: drop the user's membership, detach any resources that already
            // joined (a referenced group can't be deleted cleanly), then delete the group.
            const grpPat = new RegExp(`^Temp (access|resources) #${g.id}( \\(\\d+\\))? \\(until `);
            const resourceRefs = [];
            for (const t of targets) {
                if (t && t.type === 'resource' && t.networkId) resourceRefs.push({ networkId: t.networkId, resourceId: t.id });
                if (t && t.type === 'network') {
                    const rs = await netbirdGet('/api/networks/' + encodeURIComponent(t.id) + '/resources');
                    for (const res of (Array.isArray(rs) ? rs : [])) if (res && res.id) resourceRefs.push({ networkId: t.id, resourceId: res.id });
                }
            }
            for (const grp of (await netbirdGet('/api/groups')) || []) {
                if (!grp || !grp.id || !grpPat.test(grp.name || '')) continue;
                await setUserGroupMembership(g.user_id, grp.id, false).catch(() => { });
                for (const rr of resourceRefs) await removeResourceGroups(rr.networkId, rr.resourceId, [grp.id]).catch(() => { });
                const resp = await netbirdReq('DELETE', '/api/groups/' + encodeURIComponent(grp.id));
                if (resp && resp.status >= 300 && resp.status !== 404) ok = false;
            }
        } catch (e) {
            ok = false;
            console.error('[Grants] creating-cleanup error (#%s):', g.id, e.message);
        }
        if (ok) {
            await pool.query(`DELETE FROM temporary_access_grants WHERE id=$1 AND status='creating' AND tenant=$2`, [g.id, tnt()]).catch(() => { });
            bustNbCaches('policies', 'gref', 'usage');
            recordAudit({
                actorId: '', actorEmail: '', actorName: 'Scheduler',
                action: 'grant.cleanup', target: g.user_label || g.user_id,
                meta: { grant: g.id, reason: 'creation crashed mid-way - removed the orphaned NetBird objects' },
            }).catch(() => { });
        } else {
            throw new Error(`grant #${g.id}: could not remove all orphaned NetBird objects (will retry)`);
        }
    }
}

// ─── Recurring access: standing schedules that spawn normal temporary grants ───
// A rule = user + targets + weekdays + a daily window (app time zone). At each window start the
// scheduler creates a REGULAR temporary grant expiring at the window end - so activation, teardown,
// audit, notifications and the UI all reuse the proven grant machinery.
const RECUR_TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
function recurToApi(r) {
    return {
        id: r.id, userId: r.user_id, userLabel: r.user_label || r.user_id, userEmail: r.user_email || '',
        targets: Array.isArray(r.targets) ? r.targets : [],
        days: Array.isArray(r.days) ? r.days : [],
        startTime: r.start_time, endTime: r.end_time,
        validUntil: r.valid_until || '',
        enabled: r.enabled !== false, note: r.note || '', createdBy: r.created_by || '',
        activeGrantId: r.active_grant_id || null, createdAt: r.created_at,
    };
}
function normRecurCfg(cfg) {
    const userId = String((cfg && cfg.userId) || '').trim();
    if (!userId) throw new Error('userId is required');
    const targets = (Array.isArray(cfg.targets) ? cfg.targets : [])
        .map(t => t && ({ type: String(t.type || ''), id: String(t.id || ''), name: String(t.name || t.id || '') }))
        .filter(t => t && t.type && t.id);
    if (!targets.length) throw new Error('at least one target is required');
    const days = [...new Set((Array.isArray(cfg.days) ? cfg.days : []).map(d => parseInt(d, 10)).filter(d => d >= 0 && d <= 6))].sort();
    if (!days.length) throw new Error('pick at least one weekday');
    const startTime = String(cfg.startTime || '').trim(), endTime = String(cfg.endTime || '').trim();
    if (!RECUR_TIME_RE.test(startTime) || !RECUR_TIME_RE.test(endTime)) throw new Error('times must be HH:MM');
    const toMin = (s) => { const m = s.match(RECUR_TIME_RE); return parseInt(m[1], 10) * 60 + parseInt(m[2], 10); };
    if (toMin(endTime) <= toMin(startTime)) throw new Error('end time must be after start time');
    const validUntil = String(cfg.validUntil || '').trim();
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new Error('until date must be YYYY-MM-DD');
    return {
        userId, userLabel: String(cfg.userLabel || '').trim() || userId, userEmail: String(cfg.userEmail || '').trim(),
        targets, days, startTime, endTime, validUntil,
        enabled: cfg.enabled !== false, note: String(cfg.note || '').trim(),
    };
}
async function listRecurringAccess() {
    const r = await pool.query('SELECT * FROM recurring_access WHERE tenant=$1 ORDER BY id', [tnt()]).catch(() => ({ rows: [] }));
    return r.rows.map(recurToApi);
}
async function createRecurringAccess(cfg, actor) {
    const c = normRecurCfg(cfg);
    const r = await pool.query(`
        INSERT INTO recurring_access (user_id, user_label, user_email, targets, days, start_time, end_time, valid_until, enabled, note, created_by, tenant)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [c.userId, c.userLabel, c.userEmail, JSON.stringify(c.targets), JSON.stringify(c.days), c.startTime, c.endTime, c.validUntil, c.enabled, c.note,
        (actor && (actor.name || actor.email)) || 'admin', tnt()]);
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'recurring.create', target: c.userLabel,
        meta: { targets: c.targets.map(t => t.name).join(', '), days: c.days.join(','), window: `${c.startTime}-${c.endTime}`, until: c.validUntil || undefined },
    }).catch(() => { });
    return recurToApi(r.rows[0]);
}
async function updateRecurringAccess(id, cfg, actor) {
    const old = await pool.query('SELECT * FROM recurring_access WHERE id=$1 AND tenant=$2', [id, tnt()]);
    if (!old.rows.length) throw new Error('rule not found');
    const c = normRecurCfg(cfg);
    const r = await pool.query(`
        UPDATE recurring_access SET user_id=$2, user_label=$3, user_email=$4, targets=$5, days=$6,
               start_time=$7, end_time=$8, valid_until=$9, enabled=$10, note=$11
        WHERE id=$1 AND tenant=$12 RETURNING *
    `, [id, c.userId, c.userLabel, c.userEmail, JSON.stringify(c.targets), JSON.stringify(c.days), c.startTime, c.endTime, c.validUntil, c.enabled, c.note, tnt()]);
    // Disabling a rule while its window is active tears the live grant down immediately.
    if (!c.enabled && old.rows[0].active_grant_id) {
        await revokeCurrentRecurringGrant(old.rows[0].active_grant_id, actor);
        await pool.query('UPDATE recurring_access SET active_grant_id=NULL WHERE id=$1 AND tenant=$2', [id, tnt()]).catch(() => { });
    }
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'recurring.update', target: c.userLabel,
        meta: { targets: c.targets.map(t => t.name).join(', '), days: c.days.join(','), window: `${c.startTime}-${c.endTime}`, until: c.validUntil || undefined, enabled: c.enabled },
    }).catch(() => { });
    return recurToApi(r.rows[0]);
}
async function deleteRecurringAccess(id, actor) {
    const old = await pool.query('SELECT * FROM recurring_access WHERE id=$1 AND tenant=$2', [id, tnt()]);
    if (!old.rows.length) throw new Error('rule not found');
    if (old.rows[0].active_grant_id) await revokeCurrentRecurringGrant(old.rows[0].active_grant_id, actor);
    await pool.query('DELETE FROM recurring_access WHERE id=$1 AND tenant=$2', [id, tnt()]);
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'recurring.delete', target: old.rows[0].user_label || old.rows[0].user_id,
    }).catch(() => { });
    return { deleted: true };
}
async function revokeCurrentRecurringGrant(grantId, actor) {
    try {
        const g = await pool.query('SELECT status FROM temporary_access_grants WHERE id=$1 AND tenant=$2', [grantId, tnt()]);
        if (g.rows.length && g.rows[0].status === 'active') await revokeTemporaryAccessGrant(grantId, actor);
    } catch (e) { console.error('[Recurring] revoke of grant %s failed:', grantId, e.message); }
}

// Scheduler tick: activate any rule whose window just opened (today, app time zone). The spawned
// grant expires at the window end on its own; last_spawn_key makes activation once-per-day.
async function runRecurringAccess() {
    if (NETBIRD_READONLY) return;
    const rules = await pool.query('SELECT * FROM recurring_access WHERE enabled = TRUE AND tenant=$1', [tnt()]).catch(() => ({ rows: [] }));
    if (!rules.rows.length) return;
    const now = await tzNowParts();
    const nowMin = now.hour * 60 + now.minute;
    for (const r of rules.rows) {
        // Past the optional end date (inclusive, app time zone) the rule stops activating and
        // is disabled once, so the UI shows it ended. An already-active window keeps running
        // until its own end - the date governs NEW activations.
        if (r.valid_until && now.dateKey > r.valid_until) {
            await pool.query('UPDATE recurring_access SET enabled=FALSE WHERE id=$1 AND tenant=$2', [r.id, tnt()]).catch(() => { });
            recordAudit({
                actorId: '', actorEmail: '', actorName: 'Scheduler',
                action: 'recurring.expire', target: r.user_label || r.user_id,
                meta: { until: r.valid_until },
            }).catch(() => { });
            continue;
        }
        const days = Array.isArray(r.days) ? r.days : [];
        if (!days.includes(now.dow) || r.last_spawn_key === now.dateKey) continue;
        const sm = r.start_time.match(RECUR_TIME_RE), em = r.end_time.match(RECUR_TIME_RE);
        if (!sm || !em) continue;
        const startMin = parseInt(sm[1], 10) * 60 + parseInt(sm[2], 10);
        const endMin = parseInt(em[1], 10) * 60 + parseInt(em[2], 10);
        if (nowMin < startMin || nowMin >= endMin) continue;
        // Mark BEFORE creating, so a failure can't spawn twice; a failed day is skipped (next day retries).
        await pool.query('UPDATE recurring_access SET last_spawn_key=$2 WHERE id=$1 AND tenant=$3', [r.id, now.dateKey, tnt()]).catch(() => { });
        try {
            const grant = await createTemporaryAccessGrant({
                userId: r.user_id, userLabel: r.user_label || r.user_id, userEmail: r.user_email || '',
                targets: Array.isArray(r.targets) ? r.targets : [],
                note: `Recurring access rule #${r.id} (${r.start_time}-${r.end_time})`,
                durationMinutes: endMin - nowMin,
            }, { name: 'Scheduler', isAdmin: true });
            await pool.query('UPDATE recurring_access SET active_grant_id=$2 WHERE id=$1 AND tenant=$3', [r.id, grant.id, tnt()]).catch(() => { });
        } catch (e) {
            console.error('[Recurring] rule %s activation failed:', r.id, e.message);
        }
    }
}

// Scheduler tick: revoke every active grant whose expiry has passed.
async function revokeExpiredGrants() {
    if (!netbirdApiConfigured()) return;
    const r = await pool.query(`SELECT id FROM temporary_access_grants WHERE status='active' AND expires_at < NOW() AND tenant=$1 ORDER BY id`, [tnt()]).catch(() => ({ rows: [] }));
    for (const g of r.rows) await revokeTemporaryAccessGrant(g.id, { trigger: 'expiry' }).catch(e => console.error('[grant expiry]', e.message));
}

// Re-assert each active grant's user→group assignments (in case an IdP sync stripped them).
// Best-effort, non-fatal; no-op when the assignment is already in place.
async function reconcileActiveGrants() {
    if (!netbirdApiConfigured()) return;
    const r = await pool.query(`SELECT id, user_id, assigned_groups, group_id FROM temporary_access_grants WHERE status='active' AND tenant=$1`, [tnt()]).catch(() => ({ rows: [] }));
    for (const g of r.rows) {
        const groups = Array.isArray(g.assigned_groups) && g.assigned_groups.length ? g.assigned_groups : (g.group_id ? [g.group_id] : []);
        for (const gid of groups) {
            try { await setUserGroupMembership(g.user_id, gid, true); }
            catch (e) { console.error('[grant reconcile]', g.id, e.message); }
        }
    }
}

// ─── Access requests: user asks, admin approves (in-app or via Telegram buttons) ───

function accessRequestToApi(r) {
    return {
        id: r.id, requesterId: r.requester_id,
        requesterEmail: r.requester_email || '', requesterName: r.requester_name || r.requester_email || r.requester_id,
        targets: Array.isArray(r.targets) ? r.targets : [],
        // What was actually granted (approver-adjusted); null = same as requested / not approved yet.
        approvedTargets: Array.isArray(r.approved_targets) ? r.approved_targets : null,
        reason: r.reason || '', requestedMinutes: r.requested_minutes || 0,
        // Minutes actually granted on approval (0 = unlimited bypass); null on older/pending rows.
        approvedMinutes: (r.approved_minutes === null || r.approved_minutes === undefined) ? null : r.approved_minutes,
        kind: r.kind === 'bypass' ? 'bypass' : 'access',
        tempDevice: !!r.temp_device,
        extendBypass: !!r.extend_bypass,
        status: r.status || 'pending', createdAt: r.created_at,
        decidedBy: r.decided_by || '', decidedAt: r.decided_at || null, decisionNote: r.decision_note || '',
        decidedVia: r.decided_via || '',
        grantId: r.grant_id || null,
    };
}

// How a request decision was made, for display: the Telegram buttons, the app, or auto-approval.
function decisionVia(actor) {
    if (actor && actor.auto) return 'Auto-approval';
    if (actor && actor.viaTelegram) return 'Telegram';
    return 'App';
}

// humanDuration now lives in lib/pure.js (imported at the top).

// Typeahead over grantable things (resources / networks / shared profiles). NOT filtered by the
// requester's own grants - they're asking for what they lack. Min 2 chars, capped.
async function searchRequestTargets(q) {
    const query = String(q || '').trim().toLowerCase();
    if (query.length < 2) return { results: [] };
    // Cap PER TYPE, not overall - with a shared cap, resources (scanned first) exhausted it
    // and matching networks/profiles never showed up at all. Generous cap: the dropdown
    // scrolls, so there's no reason to hide matches.
    const CAP = 50;
    const has = (s) => String(s || '').toLowerCase().includes(query);
    const results = [];
    const usage = await getUsageData();
    const netName = new Map(), netOfResource = new Map();
    for (const n of usage.networks || []) {
        netName.set(n.id, n.name || n.id);
        for (const rid of (Array.isArray(n.resources) ? n.resources : [])) netOfResource.set(rid, n.id);
    }
    // Per-resource PORT policies (destinationResource with a specific protocol) become
    // requestable sub-entries: "resource · policy (TCP 8006)". The policy already carries the
    // service's name and ports, so one merged resource with many port policies still offers
    // per-service requests - and the grant opens ONLY that policy's ports (target.access).
    const polByResource = new Map();
    for (const p of usage.policies || []) {
        if (!p || p.enabled === false) continue;
        for (const rule of (Array.isArray(p.rules) ? p.rules : [])) {
            if (!rule || rule.enabled === false) continue;
            const dr = rule.destinationResource;
            const rid = (dr && (dr.id || dr)) || '';
            if (!rid) continue;
            const proto = String(rule.protocol || 'all').toLowerCase();
            if (proto === 'all') continue; // full exposure - the plain resource entry covers it
            const ports = [
                ...(Array.isArray(rule.ports) ? rule.ports.map(String) : []),
                ...(Array.isArray(rule.port_ranges) ? rule.port_ranges.map(x => x && `${x.start}-${x.end}`).filter(Boolean) : []),
            ];
            const access = proto === 'tcp' ? { tcp: ports } : proto === 'udp' ? { udp: ports } : proto === 'icmp' ? { icmp: true } : null;
            if (!access) continue;
            if (!polByResource.has(rid)) polByResource.set(rid, []);
            polByResource.get(rid).push({
                label: p.name || rule.name || '',
                portsLabel: proto === 'icmp' ? 'ICMP' : `${proto.toUpperCase()} ${ports.length ? ports.join(', ') : 'all ports'}`,
                access,
            });
        }
    }

    let hits = 0;
    for (const r of usage.resources || []) {
        if (hits >= CAP) break;
        const nid = netOfResource.get(r.id) || '';
        const resourceMatch = has(r.name) || has(r.address) || has(r.description);
        if (resourceMatch) {
            results.push({ type: 'resource', id: r.id, name: r.name || r.address || r.id, subtitle: [r.address, netName.get(nid), r.description].filter(Boolean).join(' · '), networkId: nid, resourceType: r.type || '' });
            hits++;
        }
        // Sub-entries ride on a resource match, and ALSO surface on a policy-name match
        // (searching "veeam" finds the Veeam port policy even if the resource is named "Host X").
        for (const s of (polByResource.get(r.id) || [])) {
            if (hits >= CAP) break;
            if (!resourceMatch && !has(s.label) && !has(s.portsLabel)) continue;
            results.push({
                type: 'resource', id: r.id,
                name: s.label || `${r.name || r.address || r.id} (${s.portsLabel})`,
                subtitle: [s.portsLabel, r.address, netName.get(nid)].filter(Boolean).join(' · '),
                networkId: nid, resourceType: r.type || '', access: s.access,
            });
            hits++;
        }
    }
    hits = 0;
    for (const n of usage.networks || []) {
        if (hits >= CAP) break;
        if (has(n.name) || has(n.description)) {
            results.push({ type: 'network', id: n.id, name: n.name || n.id, subtitle: ['Whole network', n.description].filter(Boolean).join(' · ') });
            hits++;
        }
    }
    hits = 0;
    for (const p of await listAccessProfiles().catch(() => [])) {
        if (hits >= CAP) break;
        if (p.shared && (has(p.name) || has(p.description))) {
            results.push({ type: 'profile', id: String(p.id), name: p.name, subtitle: 'Access profile', groupId: p.groupId });
            hits++;
        }
    }
    return { results };
}

// System actor for auto-approved requests, so the decision is attributed to "Auto-approval".
const AUTO_ACTOR = { name: 'Auto-approval', email: '', user_id: '', oid: '', isAdmin: true, auto: true };

async function createAccessRequest(cfg, requester) {
    const kind = cfg.kind === 'bypass' ? 'bypass' : 'access';
    const targets = Array.isArray(cfg.targets) ? cfg.targets.filter(t => t && t.id && t.type) : [];
    if (!targets.length) throw new Error('choose at least one thing to request access to');
    const reason = String(cfg.reason || '').trim();
    if (!reason) throw new Error('a reason is required');
    const requesterId = String((requester && (requester.user_id || requester.oid)) || '').trim();
    if (!requesterId) throw new Error('could not identify the requester');
    // Bypass requests may also propose a duration (0 = "approver decides") - the approver
    // sees it and can approve as-requested or override, exactly like access requests.
    const minutes = Math.max(0, parseInt(cfg.requestedMinutes, 10) || 0);
    // Temporary device (bypass only): delete the device automatically when the approved
    // bypass period ends. Recorded on the request so the approver sees it up front.
    const tempDevice = kind === 'bypass' && !!cfg.tempDevice;
    const clean = targets.map(t => {
        const access = normAccessSpec(t.access);
        return { type: t.type, id: String(t.id), name: String(t.name || t.id), networkId: t.networkId, resourceType: t.resourceType, groupId: t.groupId, ...(access ? { access } : {}) };
    });

    // Insert one access_requests row for a subset of targets, auditing request.create.
    // opts: tempDev overrides the requester's checkbox (extension inherits the current
    // bypass's temp flag), extendBypass marks a more-time request for an active bypass.
    const insertRow = async (rowTargets, opts = {}) => {
        const isTemp = opts.tempDev !== undefined ? !!opts.tempDev : tempDevice;
        const isExt = !!opts.extendBypass;
        const row = await pool.query(
            `INSERT INTO access_requests (requester_id, requester_email, requester_name, targets, reason, requested_minutes, kind, temp_device, extend_bypass)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [requesterId, (requester && requester.email) || '', (requester && requester.name) || '', JSON.stringify(rowTargets), reason, minutes, kind, isTemp, isExt]
        );
        recordAudit({
            actorId: requesterId, actorEmail: (requester && requester.email) || '', actorName: (requester && requester.name) || '',
            action: 'request.create', target: (requester && (requester.name || requester.email)) || requesterId,
            meta: { kind: kind === 'bypass' ? (isExt ? 'device bypass extension' : 'device bypass') : undefined, targets: rowTargets.map(t => t.name).join(', '), reason, requested: minutes ? humanDuration(minutes) : undefined, temporary: isTemp ? 'device deleted when the bypass expires' : undefined },
        }).catch(() => { });
        return row.rows[0];
    };

    // Device-bypass request: exactly one peer target, which must be the requester's OWN device
    // and actually need approval. Never auto-approved - a compliance decision stays human.
    if (kind === 'bypass') {
        const t = clean[0];
        if (clean.length !== 1 || t.type !== 'peer') throw new Error('a bypass request targets exactly one device');
        const own = await getAllPeers(requester.oid || '__none__');
        const peer = (own || []).find(p => p.id === t.id);
        if (!peer) throw new Error('this device does not belong to you');
        // An already-bypassed device with a TIMED bypass may ask for an EXTENSION (the
        // approval just moves the expiry). Unlimited bypasses have nothing to extend; a
        // compliant device needs nothing. Extensions inherit the temp-device flag - a
        // device approved as temporary stays temporary.
        let extendBypass = false, tempDev;
        if (peer.force_approved) {
            if (!peer.bypass_expires_at) throw new Error("this device's bypass has no expiry - nothing to extend");
            extendBypass = true;
            tempDev = !!peer.bypass_temp_device;
        } else if (!peer.approval_required) {
            throw new Error('this device does not need approval');
        }
        const dup = await pool.query(`SELECT id FROM access_requests WHERE kind='bypass' AND status='pending' AND requester_id=$1 AND targets @> $2::jsonb`, [requesterId, JSON.stringify([{ id: t.id }])]);
        if (dup.rows.length) throw new Error('a bypass request for this device is already pending');
        t.name = peer.name || t.name; // trust the cache's name over the client's
        const req = await insertRow([t], { extendBypass, tempDev });
        notifyAccessRequestTelegram(req).catch(() => { });
        return { id: req.id, ids: [req.id], autoApproved: 0, pending: 1 };
    }

    // Split by the auto-approval config, using the requester's FULL group set (the same union
    // getViewer builds for network-edit grants: Graph + NetBird auto_groups + peer groups, each
    // also normalized to its `|`-tail) so it matches the group picker's ids regardless of whether
    // the group is Entra-synced or native NetBird. Read-only mode can't create grants → none auto.
    const groups = (requester && Array.isArray(requester.groups)) ? requester.groups : [];
    const { auto, manual } = NETBIRD_READONLY ? { auto: [], manual: clean } : autoApproveTargets(clean, groups);

    let autoApproved = 0, pending = 0;
    const ids = [];

    if (auto.length) {
        // Each target's requested duration is clamped by ITS matching rule's cap (0 = no cap).
        // Targets sharing an effective duration are granted together - one row + grant per bucket.
        // A rule's access spec rides on the target itself (per-target), so mixed buckets are fine.
        const buckets = new Map();
        for (const { t, cap, access } of auto) {
            const dur = cap ? Math.min(minutes || cap, cap) : (minutes || 60);
            if (!buckets.has(dur)) buckets.set(dur, []);
            buckets.get(dur).push(access ? { ...t, access } : t);
        }
        for (const [dur, bucketTargets] of buckets) {
            const req = await insertRow(bucketTargets);
            ids.push(req.id);
            try {
                await approveAccessRequest(req.id, { durationMinutes: dur, actor: AUTO_ACTOR });
                notifyAutoApprovedTelegram(req, dur).catch(() => { });
                autoApproved = 1;
            } catch (e) {
                // Grant creation failed - don't lose the request: fall back to human review.
                console.error('[AutoApproval] auto-approve failed for #%s: %s', req.id, e.message);
                notifyAccessRequestTelegram(req).catch(() => { });
                pending = 1;
            }
        }
    }
    if (manual.length) {
        const req = await insertRow(manual);
        ids.push(req.id);
        notifyAccessRequestTelegram(req).catch(() => { });
        pending = 1;
    }

    return { id: ids[0], ids, autoApproved, pending };
}

async function listAccessRequests({ status, requesterId } = {}) {
    const where = [], params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (requesterId) { params.push(String(requesterId)); where.push(`requester_id = $${params.length}`); }
    const sql = `SELECT * FROM access_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`;
    const r = await pool.query(sql, params);
    return r.rows.map(accessRequestToApi);
}

async function countPendingRequests() {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM access_requests WHERE status='pending'`).catch(() => ({ rows: [{ n: 0 }] }));
    return (r.rows[0] && r.rows[0].n) || 0;
}

// One-time backfill of approved_minutes for requests approved before the column existed,
// from real evidence only: the grant's own issued→expires window, an active timed bypass's
// scheduled expiry, and - for peers currently bypassed with NO scheduled expiry - unlimited (0)
// on that peer's latest approved bypass request. Idempotent (only fills NULLs).
async function backfillApprovedDurations() {
    // Access requests → the granted window lives on the grant row itself.
    await pool.query(`
        UPDATE access_requests ar
        SET approved_minutes = GREATEST(1, ROUND(EXTRACT(EPOCH FROM (g.expires_at - g.issued_at)) / 60))
        FROM temporary_access_grants g
        WHERE g.tenant = '' AND ar.grant_id = g.id AND ar.status = 'approved' AND ar.approved_minutes IS NULL
    `).catch(e => console.error('[Backfill] grant durations:', e.message));
    // Timed bypasses still scheduled → duration = decision → scheduled expiry.
    await pool.query(`
        UPDATE access_requests ar
        SET approved_minutes = GREATEST(1, ROUND(EXTRACT(EPOCH FROM (b.expires_at - COALESCE(ar.decided_at, ar.created_at))) / 60))
        FROM bypass_expirations b
        WHERE b.tenant = '' AND b.request_id = ar.id AND ar.status = 'approved' AND ar.kind = 'bypass' AND ar.approved_minutes IS NULL
    `).catch(e => console.error('[Backfill] bypass durations:', e.message));
    // Currently bypassed peers with no scheduled expiry = unlimited bypass.
    if (netbirdApiConfigured()) {
        const list = await netbirdGet('/api/peers/edr/bypassed').catch(() => null);
        const ids = (Array.isArray(list) ? list : [])
            .map(x => (x && (x.peer_id || x.id)) || (typeof x === 'string' ? x : '')).filter(Boolean);
        for (const pid of ids) {
            await pool.query(`
                UPDATE access_requests SET approved_minutes = 0
                WHERE id = (
                    SELECT id FROM access_requests
                    WHERE kind='bypass' AND status='approved' AND approved_minutes IS NULL
                      AND targets @> jsonb_build_array(jsonb_build_object('id', $1::text))
                    ORDER BY decided_at DESC NULLS LAST LIMIT 1
                )
                AND NOT EXISTS (SELECT 1 FROM bypass_expirations WHERE tenant = '' AND peer_id = $1)
            `, [pid]).catch(e => console.error('[Backfill] unlimited bypass:', e.message));
        }
    }
}

async function approveAccessRequest(id, { durationMinutes, expiresAt, actor, targets } = {}) {
    const r = await pool.query('SELECT * FROM access_requests WHERE id=$1', [id]);
    if (!r.rows.length) throw new Error('request not found');
    const req = r.rows[0];
    if (req.status !== 'pending') throw new Error('this request has already been handled');

    // Device-bypass request: approve the peer in NetBird (EDR bypass) - no grant. The approver
    // may give the bypass a DURATION (durationMinutes > 0 → auto-revoked by the scheduler);
    // 0/omitted = unlimited (until the device is compliant or someone revokes it).
    if (req.kind === 'bypass') {
        const t = (Array.isArray(req.targets) && req.targets[0]) || {};
        const tempDev = !!req.temp_device;
        const min = Math.max(0, parseInt(durationMinutes, 10) || 0);
        // A temporary device is deleted ON EXPIRY - an unlimited bypass never expires,
        // so it would silently drop the requested deletion. Force a real duration.
        if (tempDev && min <= 0) throw new Error('a temporary device needs a duration - pick how long the bypass lasts');
        // Extension: the peer is already bypassed and the real work is moving the expiry,
        // so a re-POST of the bypass being rejected must not fail the approval.
        try { await bypassPeer(t.id); }
        catch (e) { if (!req.extend_bypass) throw e; }
        if (min > 0) {
            await pool.query(`
                INSERT INTO bypass_expirations (tenant, peer_id, peer_name, requester_email, requester_name, request_id, expires_at, delete_peer)
                VALUES ('', $1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval, $7)
                ON CONFLICT (tenant, peer_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, request_id = EXCLUDED.request_id, delete_peer = EXCLUDED.delete_peer
            `, [t.id, t.name || t.id, req.requester_email || '', req.requester_name || '', id, String(min), tempDev]).catch(e => console.error('[Bypass] expiry save error:', e.message));
        } else {
            await pool.query(`DELETE FROM bypass_expirations WHERE tenant = '' AND peer_id=$1`, [t.id]).catch(() => { });
        }
        const decidedBy = (actor && (actor.name || actor.email)) || 'admin';
        await pool.query(`UPDATE access_requests SET status='approved', decided_by=$2, decided_at=NOW(), approved_minutes=$3, decided_via=$4 WHERE id=$1`, [id, decidedBy, min, decisionVia(actor)]);
        recordAudit({
            actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
            action: 'request.approve', target: req.requester_name || req.requester_id,
            meta: { kind: req.extend_bypass ? 'device bypass extension' : 'device bypass', device: t.name || t.id, duration: min > 0 ? humanDuration(min) : 'unlimited', temporary: tempDev ? 'device deleted when the bypass expires' : undefined, via: actor && actor.viaTelegram ? 'Telegram' : 'app' },
        }).catch(() => { });
        if (req.tg_chat_id && req.tg_message_id) editTelegramMessage(req.tg_chat_id, req.tg_message_id, accessRequestOutcomeHtml(req, 'approved', decidedBy, { grantedMinutes: min })).catch(() => { });
        notifyBypassApprovedEmail({ to: req.requester_email, name: req.requester_name, device: t.name || t.id, minutes: min, tempDevice: tempDev }).catch(() => { });
        return { id };
    }

    // Approver-adjusted targets: an explicit override (in-app editing - add/remove) wins;
    // otherwise targets toggled OFF via the Telegram keyboard are dropped. The grant and the
    // audit both use the EFFECTIVE list; the request keeps the original for history.
    const requested = Array.isArray(req.targets) ? req.targets : [];
    let effective = requested;
    if (Array.isArray(targets) && targets.length) {
        effective = targets
            .map(t => {
                if (!t) return null;
                const access = normAccessSpec(t.access);
                return { type: String(t.type || ''), id: String(t.id || ''), name: String(t.name || t.id || ''), networkId: t.networkId, groupId: t.groupId, ...(access ? { access } : {}) };
            })
            .filter(t => t && t.type && t.id);
        if (!effective.length) throw new Error('at least one target is required');
    } else if (Array.isArray(req.excluded_targets) && req.excluded_targets.length) {
        const ex = new Set(req.excluded_targets.map(x => `${x.type}:${x.id}`));
        effective = requested.filter(t => !ex.has(`${t.type}:${t.id}`));
        if (!effective.length) throw new Error('all targets were removed - deny the request instead');
    }
    const changed = effective.length !== requested.length ||
        effective.some(t => !requested.some(r => r.type === t.type && r.id === t.id));

    const durCfg = expiresAt ? { expiresAt } : { durationMinutes: durationMinutes || req.requested_minutes || 60 };
    // The duration ACTUALLY granted (for the requester's "My Requests" display).
    const approvedMin = expiresAt
        ? Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000))
        : (durationMinutes || req.requested_minutes || 60);
    const grant = await createTemporaryAccessGrant({
        userId: req.requester_id, userLabel: req.requester_name || req.requester_email, userEmail: req.requester_email,
        targets: effective,
        note: `Approved access request #${id}`, ...durCfg,
    }, actor);
    // The "access granted" email is sent by createTemporaryAccessGrant - it covers the approval.
    const decidedBy = (actor && (actor.name || actor.email)) || 'admin';
    await pool.query(
        `UPDATE access_requests SET status='approved', decided_by=$2, decided_at=NOW(), grant_id=$3, approved_targets=$4, approved_minutes=$5, decided_via=$6 WHERE id=$1`,
        [id, decidedBy, grant.id, JSON.stringify(effective), approvedMin, decisionVia(actor)]
    );
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'request.approve', target: req.requester_name || req.requester_id,
        meta: {
            targets: effective.map(t => t.name || t.id).join(', '),
            requested: changed ? requested.map(t => t.name || t.id).join(', ') : undefined,
            grant: grant.id, via: (actor && actor.auto) ? 'auto-approval' : (actor && actor.viaTelegram ? 'Telegram' : 'app'),
        },
    }).catch(() => { });
    if (req.tg_chat_id && req.tg_message_id) {
        editTelegramMessage(req.tg_chat_id, req.tg_message_id, accessRequestOutcomeHtml({ ...req, targets: effective }, 'approved', decidedBy, { grantedMinutes: approvedMin })).catch(() => { });
    }
    return { id, grantId: grant.id };
}

async function denyAccessRequest(id, { reason, actor } = {}) {
    const r = await pool.query('SELECT * FROM access_requests WHERE id=$1', [id]);
    if (!r.rows.length) throw new Error('request not found');
    const req = r.rows[0];
    if (req.status !== 'pending') throw new Error('this request has already been handled');
    const decidedBy = (actor && (actor.name || actor.email)) || 'admin';
    await pool.query(`UPDATE access_requests SET status='denied', decided_by=$2, decided_at=NOW(), decision_note=$3, decided_via=$4 WHERE id=$1`, [id, decidedBy, String(reason || '').trim(), decisionVia(actor)]);
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'request.deny', target: req.requester_name || req.requester_id,
        meta: { targets: (req.targets || []).map(t => t.name || t.id).join(', '), reason: String(reason || '').trim() || undefined, via: actor && actor.viaTelegram ? 'Telegram' : 'app' },
    }).catch(() => { });
    if (req.tg_chat_id && req.tg_message_id) editTelegramMessage(req.tg_chat_id, req.tg_message_id, accessRequestOutcomeHtml(req, 'denied', decidedBy, { reason: String(reason || '').trim() })).catch(() => { });
    // Tell the requester their request was turned down (and why).
    notifyRequestDeniedEmail({ to: req.requester_email, name: req.requester_name, targets: (req.targets || []).map(t => t.name || t.id).join(', '), reason: String(reason || '').trim() }).catch(() => { });
    return { id };
}

async function cancelAccessRequest(id, requester) {
    const r = await pool.query('SELECT * FROM access_requests WHERE id=$1', [id]);
    if (!r.rows.length) throw new Error('request not found');
    const req = r.rows[0];
    const rid = String((requester && (requester.user_id || requester.oid)) || '');
    if (req.requester_id !== rid && !(requester && requester.isAdmin)) throw new Error('not allowed');
    if (req.status !== 'pending') throw new Error('this request has already been handled');
    const by = (requester && (requester.name || requester.email)) || 'requester';
    await pool.query(`UPDATE access_requests SET status='cancelled', decided_by=$2, decided_at=NOW() WHERE id=$1`, [id, by]);
    recordAudit({
        actorId: rid, actorEmail: (requester && requester.email) || '', actorName: (requester && requester.name) || '',
        action: 'request.cancel', target: req.requester_name || req.requester_id, meta: { targets: (req.targets || []).map(t => t.name || t.id).join(', ') },
    }).catch(() => { });
    if (req.tg_chat_id && req.tg_message_id) editTelegramMessage(req.tg_chat_id, req.tg_message_id, accessRequestOutcomeHtml(req, 'cancelled', by)).catch(() => { });
    return { id };
}

// ── Telegram messages for a request (same designed style: 👤 identity line, then emoji labels) ──
function accessRequestHtml(req) {
    const who = tgEsc(req.requester_name || req.requester_email || req.requester_id);
    const targets = (Array.isArray(req.targets) ? req.targets : []).map(t => tgEsc(t.name || t.id)).join(', ');
    if (req.kind === 'bypass') {
        let s = `💻 <b>Device Bypass ${req.extend_bypass ? 'Extension ' : ''}Request</b>\n👤 ${who}`;
        s += `\n🖥 <b>Device:</b> ${targets}`;
        if (req.requested_minutes) s += `\n⏱ <b>Requested:</b> ${tgEsc(humanDuration(req.requested_minutes))}`;
        if (req.temp_device) s += `\n🗑 <b>Temporary device</b> - deleted automatically when the bypass expires`;
        if (req.reason) s += `\n📝 <b>Reason:</b> ${tgEsc(req.reason)}`;
        return s;
    }
    let s = `${TG_CAT_EMOJI.requests} <b>Access Request</b>\n👤 ${who}`;
    s += `\n🎯 <b>Targets:</b> ${targets}`;
    s += `\n⏱ <b>Requested:</b> ${tgEsc(humanDuration(req.requested_minutes))}`;
    if (req.reason) s += `\n📝 <b>Reason:</b> ${tgEsc(req.reason)}`;
    return s;
}
const TG_OUTCOME = { approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled', expired: 'Expired' };
// extra.grantedMinutes / extra.reason override the row's stored values (used right at
// decision time, before the row re-read); otherwise the stored ones render, so late
// re-renders (expired buttons etc.) show the same details.
function accessRequestOutcomeHtml(req, outcome, by, extra = {}) {
    const icon = outcome === 'approved' ? '✅' : outcome === 'denied' ? '⛔' : '↩️';
    const who = tgEsc(req.requester_name || req.requester_email || req.requester_id);
    const targets = (Array.isArray(req.targets) ? req.targets : []).map(t => tgEsc(t.name || t.id)).join(', ');
    const title = req.kind === 'bypass' ? `Device Bypass ${TG_OUTCOME[outcome] || outcome}` : `Access ${TG_OUTCOME[outcome] || outcome}`;
    let s = `${icon} <b>${title}</b>\n👤 ${who}`;
    s += `\n${req.kind === 'bypass' ? '🖥 <b>Device:</b>' : '🎯 <b>Targets:</b>'} ${targets}`;
    if (outcome === 'approved') {
        const granted = extra.grantedMinutes !== undefined ? extra.grantedMinutes
            : (req.approved_minutes === null || req.approved_minutes === undefined ? undefined : req.approved_minutes);
        if (req.requested_minutes) s += `\n⏱ <b>Requested:</b> ${tgEsc(humanDuration(req.requested_minutes))}`;
        if (granted !== undefined) s += `\n⏳ <b>Granted:</b> ${tgEsc(granted === 0 ? 'unlimited' : humanDuration(granted))}`;
    }
    if (outcome === 'denied') {
        const reason = String(extra.reason !== undefined ? extra.reason : (req.decision_note || '')).trim();
        if (reason) s += `\n📝 <b>Reason:</b> ${tgEsc(reason)}`;
    }
    s += `\n👮 <b>By:</b> ${tgEsc(by)}`;
    return s;
}
// ── Inline keyboards for the approval flow ──
const TG_DUR_PRESETS = [
    { label: '1h', min: 60 }, { label: '4h', min: 240 }, { label: '8h', min: 480 },
    { label: '1d', min: 1440 }, { label: '3d', min: 4320 }, { label: '1w', min: 10080 },
];
function shortDur(min) { if (!min) return ''; if (min % 1440 === 0) return `${min / 1440}d`; if (min % 60 === 0) return `${min / 60}h`; return `${min}m`; }
function reqKbInitial(id) {
    return { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `req:approve:${id}` },
        { text: '⛔ Deny', callback_data: `req:deny:${id}` },
    ]] };
}
// Approve submenu: keep the requested duration, or override it with a preset. Multi-target
// requests also offer editing (toggling off) targets before picking the duration.
function reqKbApprove(id, requestedMin, canEditTargets) {
    const rows = [];
    if (requestedMin) rows.push([{ text: `✅ As requested (${shortDur(requestedMin)})`, callback_data: `req:ap:${id}:0` }]);
    for (let i = 0; i < TG_DUR_PRESETS.length; i += 3) {
        rows.push(TG_DUR_PRESETS.slice(i, i + 3).map(p => ({ text: p.label, callback_data: `req:ap:${id}:${p.min}` })));
    }
    if (canEditTargets) rows.push([{ text: '🎯 Edit Targets', callback_data: `req:tg:${id}` }]);
    rows.push([{ text: '⬅ Back', callback_data: `req:menu:${id}` }]);
    return { inline_keyboard: rows };
}
// Target-editing submenu: one toggle button per requested target (✅ granted / ❌ removed).
// The exclusions persist on the request row, so the eventual approval honours them.
function reqKbTargets(req) {
    const excluded = new Set((Array.isArray(req.excluded_targets) ? req.excluded_targets : []).map(x => `${x.type}:${x.id}`));
    const rows = (Array.isArray(req.targets) ? req.targets : []).map((t, i) => ([{
        text: `${excluded.has(`${t.type}:${t.id}`) ? '❌' : '✅'} ${String(t.name || t.id).slice(0, 48)}`,
        callback_data: `req:tgl:${req.id}:${i}`,
    }]));
    rows.push([{ text: '▶️ Approve Selected', callback_data: `req:approve:${req.id}` }, { text: '⬅ Back', callback_data: `req:menu:${req.id}` }]);
    return { inline_keyboard: rows };
}
// Bypass approve submenu: pick how long the bypass lasts (or unlimited). A temporary
// device is deleted on expiry, so it MUST expire - no Unlimited option for it. When the
// requester proposed a duration, approving it as-is is the first button.
function reqKbBypassApprove(id, tempDevice, requestedMin) {
    const rows = [];
    if (requestedMin > 0) rows.push([{ text: `✅ As requested (${shortDur(requestedMin)})`, callback_data: `req:ap:${id}:${requestedMin}` }]);
    rows.push([{ text: '1h', callback_data: `req:ap:${id}:60` }, { text: '4h', callback_data: `req:ap:${id}:240` }, { text: '8h', callback_data: `req:ap:${id}:480` }]);
    const secondRow = [{ text: '1d', callback_data: `req:ap:${id}:1440` }, { text: '3d', callback_data: `req:ap:${id}:4320` }];
    if (!tempDevice) secondRow.push({ text: '♾ Unlimited', callback_data: `req:ap:${id}:0` });
    rows.push(secondRow, [{ text: '⬅ Back', callback_data: `req:menu:${id}` }]);
    return { inline_keyboard: rows };
}
// Deny submenu: with a typed reason (reply prompt) or none.
function reqKbDeny(id) {
    return { inline_keyboard: [
        [{ text: '✍️ Deny with reason', callback_data: `req:dnr:${id}` }, { text: '⛔ Deny (no reason)', callback_data: `req:dn:${id}` }],
        [{ text: '⬅ Back', callback_data: `req:menu:${id}` }],
    ] };
}
// Force-reply prompt so an approver can type a denial reason inline in the chat.
function sendDenyPrompt(chatId, id, who) {
    return telegramApi('sendMessage', {
        chat_id: chatId,
        text: `✍️ Reply to this message with a reason to DENY request #${id}${who ? ` (${who})` : ''}.`,
        reply_markup: { force_reply: true, input_field_placeholder: 'Reason for denial…' },
    });
}
// Build the actor (a system user) for a Telegram approver, for attribution in the audit log.
function tgActorFrom(approver, from) {
    from = from || {};
    const tgName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `tg:${from.id}`;
    return {
        name: approver.name || tgName, email: approver.email || (from.username ? `@${from.username}` : ''),
        user_id: approver.userId || '', oid: approver.userId || '', isAdmin: true, viaTelegram: true,
    };
}
async function getAccessRequestRow(id) {
    const r = await pool.query('SELECT * FROM access_requests WHERE id=$1', [id]).catch(() => ({ rows: [] }));
    return r.rows[0] || null;
}

// Device context lines for a bypass request, so the approver can decide without opening the app:
// OS, agent version, online state, IPs, location (with flag) and WHY the device is blocked.
async function tgDeviceInfoLines(peerId) {
    const peer = (await getAllPeers().catch(() => [])).find(p => p.id === peerId);
    if (!peer) return '';
    const lines = [];
    if (peer.os) lines.push(`💻 <b>OS:</b> ${tgEsc(peer.os)}`);
    if (peer.version) lines.push(`📦 <b>Agent:</b> ${tgEsc(peer.version)}`);
    lines.push(peer.connected
        ? '🟢 <b>Status:</b> Online'
        : `⚪ <b>Status:</b> Offline${peer.last_seen ? ` - last seen ${tgEsc(await tgFmtTime(peer.last_seen))}` : ''}`);
    const flag = countryFlag(peer.country_code);
    const loc = [peer.geo, peer.connection_ip ? `(${peer.connection_ip})` : ''].filter(Boolean).join(' ');
    if (loc) lines.push(`🌍 <b>Location:</b> ${flag ? flag + ' ' : ''}${tgEsc(loc)}`);
    if (peer.disapproval_reason) lines.push(`⚠️ <b>Blocked:</b> ${tgEsc(peer.disapproval_reason)}`);
    return lines.length ? '\n' + lines.join('\n') : '';
}

async function notifyAccessRequestTelegram(req) {
    if (!getTelegramConfig().enabled) return;
    let html = accessRequestHtml(req);
    // Bypass requests carry the full device context inline.
    if (req.kind === 'bypass') {
        const t = (Array.isArray(req.targets) && req.targets[0]) || {};
        html += await tgDeviceInfoLines(t.id).catch(() => '');
        // Extension: show when the current bypass ends, so the approver sees what's being extended.
        if (req.extend_bypass) {
            const cur = await pool.query(`SELECT expires_at FROM bypass_expirations WHERE tenant = '' AND peer_id=$1`, [t.id]).catch(() => ({ rows: [] }));
            if (cur.rows[0]) html += `\n⏳ <b>Current bypass ends:</b> ${tgEsc(await tgFmtTime(cur.rows[0].expires_at))}`;
        }
    }
    // Post to the dedicated approvals group when configured, else the main group's requests topic.
    const sent = await sendTelegram('requests', html, { replyMarkup: reqKbInitial(req.id), chatId: getApprovalsChatId() || undefined });
    if (sent) await pool.query(`UPDATE access_requests SET tg_chat_id=$2, tg_message_id=$3 WHERE id=$1`, [req.id, sent.chatId, sent.messageId]).catch(() => { });
}
// Informational (button-less) note for a request that was auto-approved - approvers still see it.
async function notifyAutoApprovedTelegram(req, grantedMinutes) {
    if (!getTelegramConfig().enabled) return;
    await sendTelegram('requests', accessRequestOutcomeHtml(req, 'approved', 'Auto-approval', grantedMinutes !== undefined ? { grantedMinutes } : {}), { chatId: getApprovalsChatId() || undefined });
}

// ─── Pending-request escalation: remind approvers, then expire stale requests ───
// A pending request gets ONE Telegram reminder (a reply to its approval message) after
// requestReminderMinutes, and expires after requestExpireHours - the requester is emailed
// and the message's buttons are replaced with the outcome. 0 disables either step.
// Both are configured in-app (Settings → Security).
async function notifyRequestExpiredEmail({ to, name, targets }) {
    if (!getSmtpConfig().enabled || !to) return;
    const body = `<p>Hi ${htmlEsc(name || 'there')},</p>`
        + `<p>Your access request${targets ? ` for <b>${htmlEsc(targets)}</b>` : ''} <b>expired</b> without a decision. If you still need the access, please submit it again.</p>`
        + mailRows([['Requested', targets]]);
    sendMail({ to, subject: `Access request expired${targets ? `: ${targets}` : ''}`, html: mailLayout('Access Request Expired', body), tag: 'request-expired' }).catch(() => { });
}

async function escalatePendingRequests() {
    const { requestReminderMinutes, requestExpireHours } = _security;
    // 1. One-time reminder for requests still pending past the reminder age.
    if (requestReminderMinutes > 0 && getTelegramConfig().enabled) {
        const r = await pool.query(
            `SELECT * FROM access_requests
             WHERE status='pending' AND reminded_at IS NULL AND created_at <= NOW() - ($1 || ' minutes')::interval
             ORDER BY created_at LIMIT 20`,
            [String(Math.round(requestReminderMinutes))]).catch(() => ({ rows: [] }));
        for (const req of r.rows) {
            // Mark FIRST so a Telegram hiccup can't double-remind on the next tick.
            await pool.query('UPDATE access_requests SET reminded_at=NOW() WHERE id=$1', [req.id]).catch(() => { });
            const who = tgEsc(req.requester_name || req.requester_email || req.requester_id);
            const ageMin = Math.max(1, Math.round((Date.now() - new Date(req.created_at).getTime()) / 60000));
            const html = `⏰ <b>Reminder</b> - ${req.kind === 'bypass' ? 'device bypass' : 'access'} request from ${who} is still pending (${tgEsc(humanDuration(ageMin))}).`;
            await sendTelegram('requests', html, {
                chatId: req.tg_chat_id || getApprovalsChatId() || undefined,
                replyTo: req.tg_message_id || undefined,
            }).catch(() => { });
        }
    }
    // 2. Expire requests nobody decided in time.
    if (requestExpireHours > 0) {
        const r = await pool.query(
            `UPDATE access_requests SET status='expired', decided_by='Scheduler', decided_at=NOW(),
                    decision_note='Expired - no decision within ' || $1 || ' hours'
             WHERE status='pending' AND created_at <= NOW() - ($1 || ' hours')::interval
             RETURNING *`,
            [String(requestExpireHours)]).catch(() => ({ rows: [] }));
        for (const req of r.rows) {
            const targets = (Array.isArray(req.targets) ? req.targets : []).map(t => t.name || t.id).join(', ');
            recordAudit({
                actorId: '', actorEmail: '', actorName: 'Scheduler',
                action: 'request.expire', target: req.requester_name || req.requester_id,
                meta: { targets, kind: req.kind === 'bypass' ? 'device bypass' : undefined },
            }).catch(() => { });
            if (req.tg_chat_id && req.tg_message_id) {
                editTelegramMessage(req.tg_chat_id, req.tg_message_id, accessRequestOutcomeHtml(req, 'expired', 'Scheduler (timeout)')).catch(() => { });
            }
            notifyRequestExpiredEmail({ to: req.requester_email, name: req.requester_name, targets });
        }
    }
}

// ─── Weekly access review digest ───
// A recurring "what's currently open" summary so standing access actually gets LOOKED AT:
// active temporary grants, active bypasses, auto-approval rules, feature permissions and
// pending requests. Sent to the approvals Telegram chat (and optional email recipients)
// on the configured weekday/hour (app time zone) - all set in-app under Settings → Security.

// Day-of-week / hour / date key "now", in the app's configured time zone.
async function tzNowParts() {
    let tz = 'UTC';
    try { const t = await getSetting('timezone'); if (t) tz = t; } catch { /* default */ }
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date());
        const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
        const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const hour = parseInt(get('hour'), 10) % 24 || 0;
        return { dow: dowMap[get('weekday')] ?? new Date().getDay(), hour, minute: parseInt(get('minute'), 10) || 0, dateKey: `${get('year')}-${get('month')}-${get('day')}` };
    } catch {
        const d = new Date();
        return { dow: d.getDay(), hour: d.getHours(), minute: d.getMinutes(), dateKey: d.toISOString().slice(0, 10) };
    }
}

// ─── Event retention - daily purge of events older than the configured window ───
// Disabled by default (retentionDays = 0 keeps everything forever). The window is
// fully admin-controlled, in days (Settings → Data Retention); the UI warns below
// ~24 months but the admin's choice wins. Deletes in batches so a huge backlog never
// holds a long lock; runs at most once per day (app time zone).
// Retention days for the CURRENT account. Main keeps reading the shared security blob (unchanged);
// a tenant stores its own days under a keyed setting (retention_days:<tenant>) so each account's
// window is fully independent. 0 = disabled (keep forever); capped at 3650 (10 years).
async function getRetentionDays() {
    if (!tnt()) return _security.retentionDays;
    const v = await getSetting(`retention_days:${tnt()}`).catch(() => '');
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(3650, n) : 0;
}
async function setRetentionDays(days) {
    const n = Math.min(3650, Math.max(0, Math.round(Number(days) || 0)));
    if (!tnt()) { await setSecurityConfig({ retentionDays: n }); return n; }
    await setSetting(`retention_days:${tnt()}`, String(n));
    return n;
}

async function purgeOldEvents() {
    const days = await getRetentionDays();
    if (!days || days < 1) return;
    const acct = tnt();
    const now = await tzNowParts();
    // Daily gate is per account (bare key for main, retention_purge_last:<tenant> in context).
    const gateKey = tntKey('retention_purge_last');
    const last = await getSetting(gateKey).catch(() => '');
    if (last === now.dateKey) return; // already ran today
    await setSetting(gateKey, now.dateKey);

    // Scope every DELETE to THIS account. The tenant filter is on the OUTER delete too: with the
    // per-tenant PK, an id (numeric admin-event id especially) can repeat across accounts, so an
    // unscoped `id IN (...)` would delete another tenant's row with the same id.
    const deleteOld = async (table, tsCol) => {
        let total = 0;
        for (; ;) {
            const r = await pool.query(
                `DELETE FROM ${table} WHERE tenant = $2 AND id IN (
                     SELECT id FROM ${table}
                     WHERE tenant = $2 AND ${tsCol} < NOW() - ($1 || ' days')::interval
                     LIMIT 20000
                 )`, [String(days), acct]);
            total += r.rowCount || 0;
            if (!r.rowCount || r.rowCount < 20000) break;
        }
        return total;
    };
    try {
        const events = await deleteOld('events', 'timestamp');
        const adminEvents = await deleteOld('admin_events', 'timestamp');
        const proxyLogs = await deleteOld('proxy_access_logs', 'timestamp');
        const outbound = await deleteOld('outbound_log', 'timestamp');
        const nbNotifs = await deleteOld('nb_notifications', 'received_at');
        _retentionLast[acct] = { at: new Date().toISOString(), events, adminEvents, proxyLogs, outbound, nbNotifs };
        if (events || adminEvents || proxyLogs || outbound || nbNotifs) {
            recordAudit({
                actorId: '', actorEmail: '', actorName: 'Scheduler',
                action: 'retention.purge', target: `${days} days`,
                meta: { events, adminEvents, proxyLogs, outbound, nbNotifs, olderThan: `${days} days` },
            }).catch(() => { });
        }
    } catch (e) {
        _retentionLast[acct] = { at: new Date().toISOString(), error: e.message };
        console.error('[Retention] purge error:', e.message);
    }
}
const _retentionLast = {}; // account → { at, events, adminEvents } | { at, error } - surfaced on System Health
async function getRetentionStatus() {
    return { days: await getRetentionDays(), warnDays: RETENTION_WARN_DAYS, last: _retentionLast[tnt()] || null };
}

// ─── Settings backup / restore (admin) ───
// Exports every app_settings key EXCEPT secrets and transient scheduler markers.
// Secrets (tokens/passwords) live in their OWN keys - never mixed into the config
// JSONs - so the exclusion is exact and a backup file can be stored/shared without
// leaking credentials. Import filters through the same exclusion (a crafted file
// can't plant a token) and reloads every in-memory config so the restored values
// take effect immediately, no restart needed.
const SETTINGS_EXPORT_EXCLUDE = new Set([
    'netbird_api_token', 'webhook_auth_token', 'webhook_notif_token', 'telegram_bot_token', 'smtp_pass', // secrets - never leave the server
    'access_review_last', 'retention_purge_last', 'internal_backup_last', 'traffic_pull_last', // transient scheduler markers
    // Envelope-backup keypair: backup_private_key_enc is passphrase-encrypted ciphertext and
    // backup_public_key is harmless on its own, but BOTH are kept out of the PLAINTEXT export -
    // defense in depth, and they are meaningless outside the internal-backup file that carries them.
    'backup_private_key_enc', 'backup_public_key',
]);
// Prefixed/MSP keys - excluded by prefix (tokens are secrets; service-user metadata is
// install-specific and meaningless in another deployment). Plus the provisioning token.
// traffic_pull_last:<tenant> is the per-tenant API-pull CURSOR - a scheduler marker, not config
// (traffic_pull[:tenant], the opt-in itself, IS exported like every other per-account setting).
const SETTINGS_EXPORT_EXCLUDE_PREFIXES = ['msp_tenant_token:', 'msp_tenant_su:', 'webhook_token:', 'webhook_auth_token:', 'webhook_notif_token:', 'telegram_bot_token:', 'traffic_pull_last:'];
// telegram_config[:tenant] is EXPORTED but with the embedded callback webhookSecret stripped -
// the non-secret Telegram settings (chat, topics, categories) must survive a backup/restore.
const isTelegramConfigKey = (k) => k === 'telegram_config' || String(k).startsWith('telegram_config:');
SETTINGS_EXPORT_EXCLUDE.add('msp_provisioning_token');
const settingKeyExcluded = (k) => SETTINGS_EXPORT_EXCLUDE.has(k) || SETTINGS_EXPORT_EXCLUDE_PREFIXES.some(p => String(k).startsWith(p));
// ─── App-side CONFIG TABLES carried by the SAME backup file ───
// Besides the app_settings key/values, the backup also snapshots the app configuration that lives
// in TABLES - what an admin authored, NOT state/history derived from NetBird or produced at runtime:
// event-filtering rules, the address blocklist, automations, recurring access, access profiles +
// per-network defaults, network grants, resource templates and cleanup ignores. Rows are exported
// across ALL tenants WITH their id + tenant columns so referential links
// (network_default_profiles.profile_id → access_profiles.id) and cross-tenant fidelity survive an
// export→import round-trip. EXCLUDED on purpose (state / history / runtime - never configuration):
// events, admin_events, app_audit, outbound_log, ip_assignments, proxy_access_logs, the peers/users
// mirrors, temporary_access_grants, bypass_expirations, recert_rounds/items, nb_notifications,
// automation_runs (run history) and automation_resources (managed runtime state).
// `strip` = per-table columns removed on export AND ignored on import: SECRETS (automations.auth_secret
// is the bearer token / header value - never leaves the server; auth_header is only the header NAME so
// it stays) and per-row RUNTIME state that must not be replanted (automation last-run markers; the
// recurring_access active_grant_id / last_spawn_key which point at a grant the backup never carries).
// Consequence noted in the UI/docs: automation source credentials must be re-entered after a restore.
// Import order matters: access_profiles lands before network_default_profiles so referenced ids exist.
const EXPORT_TABLES = [
    { name: 'filter_rules', idCol: 'id', strip: [], required: ['field'] },
    { name: 'address_blocklist', idCol: 'id', strip: [], required: ['value'] },
    { name: 'automations', idCol: 'id', strip: ['auth_secret', 'last_run_at', 'last_status', 'last_error'], required: ['name'] },
    { name: 'recurring_access', idCol: 'id', strip: ['last_spawn_key', 'active_grant_id'], required: ['user_id'] },
    { name: 'access_profiles', idCol: 'id', strip: [], required: ['name', 'group_id', 'policy_id'] },
    { name: 'network_default_profiles', idCol: null, strip: [], required: ['network_id', 'profile_id'] }, // composite PK - no serial
    { name: 'network_grants', idCol: null, strip: [], required: ['network_id', 'group_id'] }, // composite PK - no serial
    { name: 'templates', idCol: 'id', strip: [], required: ['name'] }, // global (no tenant column)
    { name: 'cleanup_ignores', idCol: 'id', strip: [], required: ['category', 'object_id'] },
];
const EXPORT_TABLES_VERSION = 1;
const EXPORT_TABLE_ROW_CAP = 50000; // bomb guard - config tables are tiny; a giant section means a bad file

// full = the internal ENVELOPE-ENCRYPTED backup: keep secrets + runtime cols intact (the whole file
// is encrypted, so nothing leaks). full=false (the plaintext export) strips them as before.
async function exportConfigTables(full = false) {
    const tables = {};
    for (const t of EXPORT_TABLES) {
        const order = t.idCol ? ` ORDER BY ${t.idCol}` : '';
        const r = await pool.query(`SELECT * FROM ${t.name}${order}`); // ALL rows, ALL tenants
        tables[t.name] = r.rows.map(row => {
            const o = { ...row };
            if (!full) for (const c of t.strip) delete o[c]; // plaintext export: secrets/runtime never leave the server
            return o;
        });
    }
    return tables;
}
// Column name→type map, so import drops unknown columns and JSON-encodes jsonb values (node-postgres
// would otherwise mis-encode a JS array as a Postgres array literal `{...}` and reject it).
async function tableColumnTypes(table) {
    const r = await pool.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1', [table]);
    const types = {};
    for (const row of r.rows) types[row.column_name] = row.data_type;
    return types;
}
// REPLACE each section PRESENT in the file, one transaction per section: DELETE the whole table then
// re-INSERT the file's rows WITH their original ids; a section ABSENT from the file leaves its live
// table untouched. results/skipped are filled in place (per-section kept vs dropped counts).
async function importConfigTables(tables, results, skipped, full = false) {
    for (const t of EXPORT_TABLES) {
        const rows = tables[t.name];
        if (!Array.isArray(rows)) continue; // section absent → do not touch the live table
        if (rows.length > EXPORT_TABLE_ROW_CAP) throw new Error(`section "${t.name}" has too many rows (${rows.length} > ${EXPORT_TABLE_ROW_CAP})`);
        const types = await tableColumnTypes(t.name);
        const valid = new Set(Object.keys(types));
        if (!full) for (const c of t.strip) valid.delete(c); // plaintext restore never replants secrets/runtime; full restore keeps them
        const clean = [];
        let bad = 0;
        for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) { bad++; continue; }
            const o = {};
            for (const k of Object.keys(row)) if (valid.has(k)) o[k] = row[k]; // drop unknown columns
            if (t.idCol && !Number.isInteger(o[t.idCol])) { bad++; continue; } // serial id must round-trip intact
            if (t.required.some(c => o[c] === undefined || o[c] === null || o[c] === '')) { bad++; continue; } // malformed
            clean.push(o);
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`DELETE FROM ${t.name}`); // REPLACE: the file's rows become the whole table (all tenants)
            for (const o of clean) {
                const keys = Object.keys(o);
                const vals = keys.map(k => {
                    const v = o[k];
                    if (v === null || v === undefined) return null;
                    const dt = types[k];
                    if (dt === 'jsonb' || dt === 'json') return typeof v === 'string' ? v : JSON.stringify(v);
                    return v;
                });
                const ph = keys.map((_, i) => `$${i + 1}`).join(', ');
                await client.query(`INSERT INTO ${t.name} (${keys.join(', ')}) VALUES (${ph})`, vals);
            }
            // Serial tables only: advance the sequence past the largest restored id so new inserts don't collide.
            if (t.idCol) {
                await client.query(
                    `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${t.idCol}) FROM ${t.name}), 1))`,
                    [t.name, t.idCol]);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => { });
            client.release();
            throw new Error(`restoring "${t.name}": ${e.message}`);
        }
        client.release();
        results[t.name] = clean.length;
        if (bad) skipped[t.name] = bad;
    }
}
async function exportAppSettings() {
    const r = await pool.query('SELECT key, value FROM app_settings ORDER BY key');
    const settings = {};
    for (const row of r.rows) {
        if (settingKeyExcluded(row.key)) continue;
        let v = row.value;
        if (isTelegramConfigKey(row.key)) {
            // Strip ONLY the secret; unparseable blobs stay home entirely.
            try { const j = JSON.parse(v); delete j.webhookSecret; v = JSON.stringify(j); } catch { continue; }
        }
        settings[row.key] = v;
    }
    // Same file shape as before + `tables`/`tablesVersion` (backward + forward compatible: an older
    // reader ignores the new keys; an older FILE simply has no `tables` and restores settings-only).
    return {
        app: 'netbird-companion', kind: 'settings-export', exportedAt: new Date().toISOString(),
        settings, tables: await exportConfigTables(), tablesVersion: EXPORT_TABLES_VERSION,
    };
}
async function importAppSettings(payload, actor) {
    const settings = payload && payload.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('invalid backup file - missing the "settings" object');
    }
    const entries = Object.entries(settings)
        .filter(([k, v]) => typeof k === 'string' && k.length <= 100 && typeof v === 'string' && !settingKeyExcluded(k));
    if (!entries.length) throw new Error('the backup contains no importable settings');
    for (const [k, v] of entries) {
        let val = v;
        if (isTelegramConfigKey(k)) {
            // Exports carry telegram_config WITHOUT its webhookSecret - keep this deployment's
            // existing secret so the approvals callback keeps working after a restore.
            try {
                const cur = JSON.parse((await getSetting(k)) || 'null');
                const imp = JSON.parse(v);
                if (cur && cur.webhookSecret && !imp.webhookSecret) imp.webhookSecret = cur.webhookSecret;
                val = JSON.stringify(imp);
            } catch { /* keep the imported value as-is */ }
        }
        await setSetting(k, val);
    }
    // Reload every config module state so the import applies without a restart.
    await loadNbApi(); await loadWebhook(); await loadTelegram(); await loadApproverConfig();
    await loadAutoApproval(); await loadSmtp(); await loadFeaturePerms(); await loadSecurityConfig();
    // Config TABLES: only touched when the file carries them (older backups skip this untouched).
    const tableResults = {}, tableSkipped = {};
    if (payload.tables && typeof payload.tables === 'object' && !Array.isArray(payload.tables)) {
        await importConfigTables(payload.tables, tableResults, tableSkipped);
        invalidateFilterCache(); // filter_rules changed - drop every account's cached filter config (the
        // only per-table cache; blocklist/automations/profiles/grants/templates read the DB directly)
    }
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'settings.import', target: 'app settings',
        meta: { keys: entries.length, restored: entries.map(([k]) => k).join(', '), tables: tableResults, skipped: tableSkipped },
    }).catch(() => { });
    return { imported: entries.length, keys: entries.map(([k]) => k), tables: tableResults, skipped: tableSkipped };
}

// ─── Internal ENVELOPE-ENCRYPTED backup (tier 2) - full config + ALL secrets, written to a mounted
// folder on a schedule, where THE SERVER CANNOT DECRYPT ITS OWN BACKUPS. An admin sets a passphrase
// in the UI; from it we derive an RSA-4096 keypair. The PUBLIC key encrypts each backup on a schedule
// (no passphrase needed at backup time); the PRIVATE key is stored ONLY passphrase-encrypted, so a
// restore ALWAYS needs the human passphrase. The passphrase itself is never stored in any form. ───
const backupCrypto = require('crypto');
const backupFs = require('fs');
const backupPath = require('path');
const BACKUP_MAGIC = Buffer.from('NBCBK2'); // 6 bytes - file-format tag
const BACKUP_DIR = process.env.BACKUP_DIR || '/backup';
const BACKUP_NAME_RE = /^netbird-control-[\d-]+\.nbbackup$/; // zero traversal: enforced everywhere a name arrives
const INTERNAL_BACKUP_DEFAULTS = { enabled: false, hour: 3, keep: 14 }; // disabled by default - kill switch

// scrypt(passphrase, salt) → 32-byte AES key. Same KDF for the stored private key and the embedded blob.
function backupScryptKey(passphrase, salt) { return backupCrypto.scryptSync(String(passphrase), salt, 32); }

// PKCS8 DER private key → base64(salt16 | iv12 | tag16 | ciphertext), AES-256-GCM under scrypt(passphrase).
function encryptPrivateKey(privDer, passphrase) {
    const salt = backupCrypto.randomBytes(16);
    const iv = backupCrypto.randomBytes(12);
    const cipher = backupCrypto.createCipheriv('aes-256-gcm', backupScryptKey(passphrase, salt), iv);
    const ct = Buffer.concat([cipher.update(privDer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, tag, ct]).toString('base64');
}
// Reverse: base64/decoded blob bytes + passphrase → PKCS8 DER. A wrong passphrase makes the GCM tag
// verification fail (final() throws) - the caller maps that to a clean 400.
function decryptPrivateKeyBlob(blob, passphrase) {
    if (blob.length < 44) throw new Error('bad key blob'); // salt16 + iv12 + tag16
    const salt = blob.subarray(0, 16), iv = blob.subarray(16, 28), tag = blob.subarray(28, 44), ct = blob.subarray(44);
    const decipher = backupCrypto.createDecipheriv('aes-256-gcm', backupScryptKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]); // throws on wrong passphrase
}

// Set / change / reset the backup passphrase. The passphrase is NEVER stored - only the keypair is.
//  - first-time set: fresh RSA-4096 keypair, private key encrypted under the new passphrase.
//  - change (currentPassphrase supplied): decrypt the existing private key with the OLD passphrase
//    (GCM failure → 400 'Wrong passphrase'), re-encrypt the SAME keypair under the new one. On THIS
//    server the new passphrase opens old files too (restore falls back to the stored re-locked
//    blob); on a fresh server an old file needs the passphrase that was current when it was written.
//  - reset (current passphrase forgotten): FRESH keypair - old backups remain readable ONLY with the
//    old passphrase (the UI confirm states this).
async function setBackupPassphrase({ passphrase, currentPassphrase, reset } = {}) {
    const pass = String(passphrase || '');
    if (pass.length < 12) { const e = new Error('Passphrase must be at least 12 characters'); e.status = 400; throw e; }
    const curPub = await getSetting('backup_public_key');
    const curEnc = await getSetting('backup_private_key_enc');
    const freshKeypair = () => {
        const kp = backupCrypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
        return { pub: kp.publicKey.export({ type: 'spki', format: 'pem' }), priv: kp.privateKey.export({ type: 'pkcs8', format: 'der' }) };
    };
    let mode, pubPem, privDer;
    if (!curPub || !curEnc) {                    // first-time set
        mode = 'set'; ({ pub: pubPem, priv: privDer } = freshKeypair());
    } else if (reset) {                          // forgotten passphrase → new identity
        mode = 'reset'; ({ pub: pubPem, priv: privDer } = freshKeypair());
    } else {                                     // change → keep the keypair, re-wrap it
        mode = 'changed';
        try { privDer = decryptPrivateKeyBlob(Buffer.from(curEnc, 'base64'), String(currentPassphrase || '')); }
        catch { const e = new Error('Wrong passphrase'); e.status = 400; throw e; }
        pubPem = curPub;
    }
    await setSetting('backup_public_key', typeof pubPem === 'string' ? pubPem : pubPem.toString('utf8'));
    await setSetting('backup_private_key_enc', encryptPrivateKey(privDer, pass));
    return { mode };
}

// Read/normalize the schedule config (settings key `internal_backup`). hour 0-23, keep 1-90.
async function getInternalBackupConfig() {
    let c = {};
    try { c = JSON.parse((await getSetting('internal_backup')) || '{}') || {}; } catch { c = {}; }
    const m = { ...INTERNAL_BACKUP_DEFAULTS, ...c };
    return {
        enabled: !!m.enabled,
        hour: Number.isFinite(+m.hour) ? Math.min(23, Math.max(0, Math.round(+m.hour))) : INTERNAL_BACKUP_DEFAULTS.hour,
        keep: Number.isFinite(+m.keep) ? Math.min(90, Math.max(1, Math.round(+m.keep))) : INTERNAL_BACKUP_DEFAULTS.keep,
    };
}
async function setInternalBackupConfig(input) {
    const i = input || {};
    const cfg = {
        enabled: !!i.enabled,
        hour: Number.isFinite(+i.hour) ? Math.min(23, Math.max(0, Math.round(+i.hour))) : INTERNAL_BACKUP_DEFAULTS.hour,
        keep: Number.isFinite(+i.keep) ? Math.min(90, Math.max(1, Math.round(+i.keep))) : INTERNAL_BACKUP_DEFAULTS.keep,
    };
    await setSetting('internal_backup', JSON.stringify(cfg));
    return cfg;
}

// The BACKUP_DIR must exist AND be writable for the feature to be usable.
async function backupDirWritable() {
    try { await backupFs.promises.access(BACKUP_DIR, backupFs.constants.W_OK); return true; } catch { return false; }
}
// Validate a filename and resolve it INSIDE BACKUP_DIR - path.basename + the regex block traversal.
function backupFilePath(name) {
    const base = backupPath.basename(String(name || ''));
    if (!BACKUP_NAME_RE.test(base)) throw new Error('Invalid backup file name');
    return backupPath.join(BACKUP_DIR, base);
}
function backupStamp(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function listBackupFiles() {
    let names;
    try { names = await backupFs.promises.readdir(BACKUP_DIR); } catch { return []; }
    const files = [];
    for (const n of names) {
        if (!BACKUP_NAME_RE.test(n)) continue;
        try { const st = await backupFs.promises.stat(backupPath.join(BACKUP_DIR, n)); files.push({ name: n, size: st.size, at: st.mtime.toISOString() }); } catch { /* skip unreadable */ }
    }
    files.sort((a, b) => b.at.localeCompare(a.at)); // newest first
    return files;
}
async function pruneBackups(keep) {
    const excess = (await listBackupFiles()).slice(Math.max(0, keep | 0)); // list is newest-first; drop the tail
    for (const f of excess) { try { await backupFs.promises.unlink(backupPath.join(BACKUP_DIR, f.name)); } catch { /* best effort */ } }
    return excess.length;
}

// The FULL payload: every app_settings row (NO exclusions - includes all secrets) + the config tables
// WITHOUT any strip. Only meaningful inside the encrypted file.
async function buildInternalBackupPayload() {
    const r = await pool.query('SELECT key, value FROM app_settings ORDER BY key');
    const settings = {};
    for (const row of r.rows) settings[row.key] = row.value; // FULL - no exclusion filter
    return {
        app: 'netbird-companion', kind: 'internal-backup', version: 2, exportedAt: new Date().toISOString(),
        settings, tables: await exportConfigTables(true), // full: secrets + runtime cols kept
    };
}

// Encrypt a payload object → backup file bytes.
// Layout (binary): magic 'NBCBK2' (6) | u16BE privKeyBlobLen | privKeyBlob | u16BE wrappedKeyLen |
//                  wrappedKey | iv (12) | tag (16) | ciphertext.
// privKeyBlob = the base64-DECODED backup_private_key_enc bytes, EMBEDDED so a FRESH server (empty DB)
// can restore from the file + passphrase alone; it is passphrase-encrypted, so it leaks nothing.
function encryptBackup(payloadObj, publicKeyPem, privKeyBlob) {
    const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const dataKey = backupCrypto.randomBytes(32);
    const iv = backupCrypto.randomBytes(12);
    const cipher = backupCrypto.createCipheriv('aes-256-gcm', dataKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedKey = backupCrypto.publicEncrypt(
        { key: publicKeyPem, padding: backupCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dataKey);
    const head = Buffer.alloc(6 + 2 + privKeyBlob.length + 2 + wrappedKey.length);
    let off = 0;
    BACKUP_MAGIC.copy(head, off); off += 6;
    head.writeUInt16BE(privKeyBlob.length, off); off += 2;   // privKeyBlob ~2.5KB, wrappedKey 512B - both fit u16
    privKeyBlob.copy(head, off); off += privKeyBlob.length;
    head.writeUInt16BE(wrappedKey.length, off); off += 2;
    wrappedKey.copy(head, off); off += wrappedKey.length;
    return Buffer.concat([head, iv, tag, ct]);
}
// Decrypt file bytes + passphrase → payload object. NEVER uses stored server material - the private
// key comes from the file's OWN embedded blob, unlocked only by the human passphrase. Any structural
// or crypto failure collapses to one message so we never leak which stage failed.
function decryptBackup(fileBuf, passphrase, storedPrivBlob) {
    const CORRUPT = 'Wrong passphrase or corrupted file';
    try {
        // Raw file bytes only: a string, array or Buffer-like object from a tampered request never
        // reaches the parser below.
        if (typeof fileBuf !== 'object' || !Buffer.isBuffer(fileBuf)) throw new Error(CORRUPT);
        if (fileBuf.length < 6 + 2 + 2 + 12 + 16 || !fileBuf.subarray(0, 6).equals(BACKUP_MAGIC)) throw new Error(CORRUPT);
        let off = 6;
        const privLen = fileBuf.readUInt16BE(off); off += 2;
        if (off + privLen > fileBuf.length) throw new Error(CORRUPT);
        const privBlob = fileBuf.subarray(off, off + privLen); off += privLen;
        const wrappedLen = fileBuf.readUInt16BE(off); off += 2;
        if (off + wrappedLen + 12 + 16 > fileBuf.length) throw new Error(CORRUPT);
        const wrappedKey = fileBuf.subarray(off, off + wrappedLen); off += wrappedLen;
        const iv = fileBuf.subarray(off, off + 12); off += 12;
        const tag = fileBuf.subarray(off, off + 16); off += 16;
        const ct = fileBuf.subarray(off);
        // The embedded blob is locked with the passphrase that was CURRENT when the file was
        // written. After a passphrase CHANGE the keypair stays the same but the server's stored
        // blob is re-locked under the new passphrase - so on the same server, fall back to it:
        // the new passphrase then opens old files too. A fresh server has no stored blob and
        // relies on the embedded one alone (file + its original passphrase).
        let privDer;
        try { privDer = decryptPrivateKeyBlob(Buffer.from(privBlob), passphrase); }
        catch (e) {
            if (!storedPrivBlob) throw e;
            privDer = decryptPrivateKeyBlob(Buffer.from(storedPrivBlob), passphrase);
        }
        const privateKey = backupCrypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
        const dataKey = backupCrypto.privateDecrypt(
            { key: privateKey, padding: backupCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedKey);
        const decipher = backupCrypto.createDecipheriv('aes-256-gcm', dataKey, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8'));
    } catch { const e = new Error(CORRUPT); e.status = 400; throw e; }
}

// Backup keypair settings that the FULL restore SKIPS: the restoring server keeps ITS OWN keypair.
// Adopting the file's would silently change which passphrase future backups need - surprising - so we
// carry these two keys in the payload (like everything else) but do not overwrite the live ones.
const BACKUP_KEY_SETTINGS = new Set(['backup_public_key', 'backup_private_key_enc']);
// Import a decrypted FULL payload: settings with NO exclusion filter, then the config tables (REPLACE,
// id-preserving, full - secrets/runtime restored), then reload EVERY in-memory config + bust caches.
async function importInternalBackupPayload(payload) {
    const settings = payload && payload.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('invalid backup - missing the "settings" object');
    let settingsCount = 0;
    for (const [k, v] of Object.entries(settings)) {
        if (typeof k !== 'string' || k.length > 100 || typeof v !== 'string') continue;
        if (BACKUP_KEY_SETTINGS.has(k)) continue; // keep this server's own backup keypair (see BACKUP_KEY_SETTINGS)
        await setSetting(k, v);
        settingsCount++;
    }
    // Reload every config module so the restore applies without a restart.
    await loadNbApi(); await loadTenantTokens(); await loadWebhook(); await loadTelegram(); await loadApproverConfig();
    await loadAutoApproval(); await loadSmtp(); await loadFeaturePerms(); await loadSecurityConfig();
    const tableResults = {}, tableSkipped = {};
    if (payload.tables && typeof payload.tables === 'object' && !Array.isArray(payload.tables)) {
        await importConfigTables(payload.tables, tableResults, tableSkipped, true); // full: secrets + runtime restored
        invalidateFilterCache();
    }
    return { settings: settingsCount, tables: tableResults, skipped: tableSkipped };
}

// Run a backup NOW (schedule-independent). No passphrase needed - the public key encrypts.
async function runInternalBackup() {
    const pub = await getSetting('backup_public_key');
    const enc = await getSetting('backup_private_key_enc');
    if (!pub || !enc) { const e = new Error('No backup encryption key configured - set a passphrase first'); e.status = 400; throw e; }
    if (!(await backupDirWritable())) { const e = new Error(`Backup directory ${BACKUP_DIR} is not writable`); e.status = 400; throw e; }
    const bytes = encryptBackup(await buildInternalBackupPayload(), pub, Buffer.from(enc, 'base64'));
    const name = `netbird-control-${backupStamp()}.nbbackup`;
    const finalPath = backupPath.join(BACKUP_DIR, name);
    const tmpPath = finalPath + '.tmp';
    await backupFs.promises.writeFile(tmpPath, bytes);
    await backupFs.promises.rename(tmpPath, finalPath); // atomic publish
    await pruneBackups((await getInternalBackupConfig()).keep);
    return { file: name, size: bytes.length };
}
// Restore from raw file bytes (folder file or uploaded buffer) + human passphrase.
async function restoreInternalBackup(fileBuf, passphrase) {
    // Same-server fallback blob (see decryptBackup): lets the CURRENT passphrase open files
    // written before a passphrase change. Absent on a fresh server - embedded blob only.
    let stored = null;
    try { const b64 = await getSetting('backup_private_key_enc'); if (b64) stored = Buffer.from(b64, 'base64'); } catch { /* fresh server */ }
    const payload = decryptBackup(fileBuf, passphrase, stored); // clean 400 on wrong passphrase / corruption
    if (!payload || payload.kind !== 'internal-backup') { const e = new Error('Not an internal backup file'); e.status = 400; throw e; }
    return importInternalBackupPayload(payload);
}
async function readBackupFile(name) { return backupFs.promises.readFile(backupFilePath(name)); }

// Status for the UI: dir writable?, path, keypair configured?, schedule config, files (newest first).
async function getInternalBackupStatus() {
    const [dirOk, pub, enc, config, files] = await Promise.all([
        backupDirWritable(), getSetting('backup_public_key'), getSetting('backup_private_key_enc'),
        getInternalBackupConfig(), listBackupFiles(),
    ]);
    return { dirOk, dir: BACKUP_DIR, keyConfigured: !!(pub && enc), config, files };
}

// Scheduler tick (hourly): self-gates on enabled + the configured hour + a once-a-day marker
// (internal_backup_last). Main account only - the scheduler never runs in tenant context.
async function internalBackupTick() {
    const cfg = await getInternalBackupConfig();
    if (!cfg.enabled) return;
    const pub = await getSetting('backup_public_key');
    const enc = await getSetting('backup_private_key_enc');
    if (!pub || !enc || !(await backupDirWritable())) return; // not usable yet - quiet no-op
    const now = await tzNowParts();
    // AT-or-AFTER the configured hour (not equality): the tick may not land exactly inside the
    // configured hour (boot-anchored drift, restarts) - the daily marker prevents repeats, so the
    // first tick past the hour runs it and a missed window self-heals.
    if (now.hour < cfg.hour) return;
    const last = await getSetting('internal_backup_last').catch(() => '');
    if (last === now.dateKey) return;              // already ran today
    await setSetting('internal_backup_last', now.dateKey); // stamp up front so a slow run never double-fires
    const out = await runInternalBackup();
    recordAudit({
        actorId: '', actorEmail: '', actorName: 'Scheduler', action: 'backup.run', target: out.file,
        meta: { file: out.file, size: out.size, scheduled: true },
    }).catch(() => { });
}

// DB + workload numbers for the System Health page. The account-scoped parts (row counts, oldest
// rows, grants/requests/bypasses, retention, NetBird health) reflect the CURRENT account, so the
// page is honest in tenant context too (System Health runs IN tenant context). The physical table
// SIZE stays global - it is a shared-DB metric, not an account's data. Global infra fields
// (version/node/uptime/schedulers/queues) are added by the route and are the same for every account.
async function getSystemStats() {
    const acct = tnt();
    // Physical size of a table (whole DB object - global, not per account).
    const tableBytes = async (table) => {
        const r = await pool.query(
            `SELECT pg_total_relation_size(oid) AS bytes FROM pg_class WHERE relname = $1`,
            [table]).catch(() => ({ rows: [] }));
        return r.rows[0] ? Number(r.rows[0].bytes) || 0 : 0;
    };
    // Exact row count for THIS account. The tenant column leads the events/admin_events PK and has
    // an index on the rest, so a scoped count uses an index scan rather than a full-table scan.
    const rowsFor = async (table) => {
        const r = await pool.query(`SELECT COUNT(*)::bigint AS n FROM ${table} WHERE tenant = $1`, [acct]).catch(() => ({ rows: [{ n: 0 }] }));
        return Math.max(0, Number(r.rows[0].n) || 0);
    };
    // Oldest row for THIS account via the timestamp index (LIMIT 1 on an ordered scan).
    const oldest = async (table, col) => {
        const r = await pool.query(`SELECT ${col} AS t FROM ${table} WHERE tenant = $1 ORDER BY ${col} ASC LIMIT 1`, [acct]).catch(() => ({ rows: [] }));
        return r.rows[0] ? r.rows[0].t : null;
    };
    const count = async (sql) => { const r = await pool.query(sql, [acct]).catch(() => ({ rows: [{ n: 0 }] })); return Number(r.rows[0].n) || 0; };
    const [evBytes, evRows, evOldest, aeBytes, aeRows, aeOldest, auditBytes, auditRows, ipaBytes, ipaRows] = await Promise.all([
        tableBytes('events'), rowsFor('events'), oldest('events', 'timestamp'),
        tableBytes('admin_events'), rowsFor('admin_events'), oldest('admin_events', 'timestamp'),
        tableBytes('app_audit'), rowsFor('app_audit'),
        tableBytes('ip_assignments'), rowsFor('ip_assignments'),
    ]);
    const [activeGrants, pendingRequests, scheduledBypasses] = await Promise.all([
        count(`SELECT COUNT(*)::int AS n FROM temporary_access_grants WHERE status='active' AND tenant=$1`),
        count(`SELECT COUNT(*)::int AS n FROM access_requests WHERE status='pending' AND tenant=$1`),
        count(`SELECT COUNT(*)::int AS n FROM bypass_expirations WHERE tenant=$1`),
    ]);
    // Bypassed peers: for main, the live EDR bypassed-list size (unchanged). For a tenant, that
    // global set is not per-account, so count the tenant's OWN peers flagged force_approved in the
    // cached NetBird object - honest for the account being managed.
    const bypassedPeers = acct
        ? await count(`SELECT COUNT(*)::int AS n FROM peers WHERE tenant=$1 AND (raw_json->>'force_approved')='true'`)
        : getBypassedPeerCount();
    // NetBird health: in tenant context probe the tenant's OWN API through the ALS-aware client (a
    // cheap GET on the tenant token), instead of the shared global "last contact" timestamp. Main
    // keeps its passive reading (no extra API call on every health load).
    let netbird;
    if (acct) {
        let ok = false;
        try { await netbirdGet('/api/accounts'); ok = true; } catch { ok = false; }
        netbird = { configured: hasTenantToken(acct), lastOkAt: ok ? new Date().toISOString() : null, readonly: NETBIRD_READONLY };
    } else {
        netbird = { configured: netbirdApiConfigured(), lastOkAt: getNetbirdLastOk(), readonly: NETBIRD_READONLY };
    }
    return {
        db: {
            events: { rows: evRows, bytes: evBytes, oldest: evOldest },
            adminEvents: { rows: aeRows, bytes: aeBytes, oldest: aeOldest },
            audit: { rows: auditRows, bytes: auditBytes },
            ipAssignments: { rows: ipaRows, bytes: ipaBytes },
        },
        activeGrants, pendingRequests, scheduledBypasses,
        bypassedPeers,
        netbird,
        retention: await getRetentionStatus(),
    };
}

// ─── Access recertification - periodic keep/revoke attestation of all STANDING access ───
// The weekly digest SHOWS what's open; recertification forces a DECISION. Every
// recertIntervalDays a round opens, snapshotting: unlimited device bypasses, feature
// permissions (per user and per group), auto-approval entries (trusted + self-service)
// and enabled recurring-access rules. Each item is kept or revoked in-app; revoke
// performs the real removal. The round auto-completes when the last item is decided.

// stableStringify now lives in lib/pure.js (imported at the top).

const RECERT_KIND_LABELS = {
    bypass: 'Unlimited Device Bypass', perm_user: 'Feature Permission (User)', perm_group: 'Feature Permission (Group)',
    auto_trusted: 'Auto-Approval: Trusted Requesters', auto_rule: 'Auto-Approval: Self-Service Rule', recurring: 'Recurring Access Rule',
};

// What each feature permission actually unlocks - shown on review items so the
// reviewer can decide without knowing the internal permission keys.
const RECERT_PERM_INFO = {
    'activity.all': { label: 'View All Activity', desc: "can see every user's and device's traffic on the Activity page, not just their own" },
    'peers.all': { label: 'View All Peers', desc: 'can see every device in the account on the Peers page, not just their own' },
    'audit.view': { label: 'View Audit Logs', desc: 'can open the Admin page: full audit trail, NetBird admin activity and IP history' },
    'temp.manage': { label: 'Manage Temporary Access', desc: 'can create, extend and revoke temporary access grants, including recurring rules' },
    'networks.manage': { label: 'Manage All Networks', desc: 'admin-grade access to every network: resources, routing peers, policies, create/rename/delete (implies seeing all peers)' },
    'proxy.manage': { label: 'Manage Reverse Proxy', desc: 'can open the Reverse Proxy page (services + access logs) and create new proxy services' },
    'troubleshoot.all': { label: 'Troubleshoot All Peers', desc: 'can pick ANY device on the Troubleshoot page and run diagnostics on it (support desk) - read-only, grants no management rights and not the Peers page' },
    'tenants.support': { label: 'Tenant Support', desc: 'can switch into MSP tenants and fully manage them - no admin rights on the main account, no tenant creation or deletion' },
};
const RECERT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Snapshot everything currently standing. `label` is the headline; `detail.info` is the
// full decision context (the reviewer must not need to hunt elsewhere for it); the rest
// of `detail` is what applyRecertRevoke needs to actually remove the item later.
async function buildRecertItems() {
    const items = [];
    const push = (kind, ref, label, info, detail) => items.push({ kind, ref: String(ref), label, detail: { ...detail, info } });
    // Entra-group id → display name (feature perms and auto-approval store Entra ids).
    const adNames = new Map((await getAdGroups().catch(() => [])).map(g => [g.id, g.name]));
    const gname = (id) => adNames.get(String(id)) || String(id);

    const peers = await getAllPeers().catch(() => []);
    for (const p of peers) {
        if (p.force_approved && !p.bypass_expires_at) {
            const bits = [
                p.os || null,
                p.ip ? `NetBird IP ${p.ip}` : null,
                p.connected ? 'online now' : (p.last_seen ? `last seen ${await formatConfiguredDate(p.last_seen)}` : 'never seen'),
                p.disapproval_reason ? `blocked reason: ${p.disapproval_reason}` : null,
            ].filter(Boolean);
            push('bypass', p.id,
                `${p.name || p.id}${p.owner_email ? ` - ${p.owner_email}` : ''}`,
                `Bypasses compliance forever until revoked. ${bits.join(' · ')}`,
                { peerId: p.id, name: p.name || p.id });
        }
    }

    // Feature permissions + auto-approval are GLOBAL/main-only config (app_settings, not
    // tenant-scoped) and applyRecertRevoke mutates that same shared config - so they belong to
    // MAIN rounds only. A tenant round snapshots strictly per-account standing access
    // (device bypasses + recurring rules), never global config a tenant reviewer could change.
    if (!tnt()) {
        const perms = getFeaturePermsConfig();
        for (const [key, e] of Object.entries(perms)) {
            const pi = RECERT_PERM_INFO[key] || { label: key, desc: '' };
            for (const u of (e.users || [])) {
                push('perm_user', `${key}:${u.id || u.email}`,
                    `${u.name || u.email || u.id} → ${pi.label}`,
                    `${u.email ? `${u.email} - ` : ''}${pi.desc}`,
                    { key, user: u });
            }
            for (const gid of (e.groupIds || [])) {
                push('perm_group', `${key}:${gid}`,
                    `Group "${gname(gid)}" → ${pi.label}`,
                    `Every member of the group ${pi.desc}`,
                    { key, groupId: gid });
            }
        }

        const auto = getAutoApprovalConfig();
        (auto.trusted || []).forEach((t, i) => {
            const scope = t.networkMode === 'allow' ? ` Only inside: ${(t.networks || []).map(n => n.name || n.id).join(', ')}.`
                : t.networkMode === 'block' ? ` Everywhere except: ${(t.networks || []).map(n => n.name || n.id).join(', ')}.` : '';
            const excluded = (t.excludedTargets || []).length ? ` Blocked targets: ${t.excludedTargets.map(x => x.name || x.id).join(', ')}.` : '';
            push('auto_trusted', `trusted:${i}`,
                `Trusted requesters: ${t.groupIds.map(gname).join(', ')}`,
                `Members get access requests approved automatically with no human review${t.maxMinutes ? `, capped at ${humanDuration(t.maxMinutes)}` : ', at the requested duration'}.${scope}${excluded}`,
                { entry: t });
        });
        (auto.rules || []).forEach((r, i) => {
            push('auto_rule', `rule:${i}`,
                `Self-service: ${(r.targets || []).map(t => t.name || t.id).join(', ')}`,
                `Requests for these targets skip human review for members of ${r.groupIds.map(gname).join(', ')}${r.maxMinutes ? `, capped at ${humanDuration(r.maxMinutes)}` : ''}.`,
                { entry: r });
        });
    }

    for (const r of await listRecurringAccess().catch(() => [])) {
        if (r.enabled === false) continue;
        const days = (r.days || []).map(d => RECERT_DAY_NAMES[d] ?? d).join(', ');
        push('recurring', r.id,
            `${r.userLabel} → ${(r.targets || []).map(t => t.name).join(', ')}`,
            `Standing schedule: every ${days || 'day'}, ${r.startTime}-${r.endTime}${r.validUntil ? `, until ${r.validUntil}` : ', with no end date'}${r.note ? ` · note: ${r.note}` : ''}`,
            { ruleId: r.id });
    }
    return items;
}

// Access-review scheduler alert → Telegram. runRecertification runs per account (forEachTenant),
// and decideRecertItem runs in the tenant's request context, so this sends to the ACTING account's
// own Telegram (no tag; its default chat/'requests' topic). From a TENANT context it ALSO mirrors
// to MAIN's approvals channel under the same `tenantActivity` flag, with a ` [tenant]` suffix on
// the main copy only. Main's own review is unchanged: its approvals group, no tag. `makeHtml(tag)`
// builds the message given the tenant tag ('' for the account's own copy).
async function notifyReviewTelegram(makeHtml) {
    const acct = tnt();
    if (!acct) {
        await sendTelegram('requests', makeHtml(''), { chatId: getApprovalsChatId() || undefined }).catch(() => { });
        return;
    }
    // Tenant's own copy → its own default chat/'requests' topic (no main-approvals override, no tag).
    await sendTelegram('requests', makeHtml('')).catch(() => { });
    // Mirror to MAIN's approvals channel under the flag, tagged - an operational alert the MSP wants.
    const main = getTelegramConfig('');
    if (main.enabled && main.tenantActivity !== false) {
        await sendTelegram('requests', makeHtml(tenantTag()), { account: '', chatId: getApprovalsChatId() || undefined }).catch(() => { });
    }
}

async function openRecertRound(startedBy) {
    const items = await buildRecertItems();
    if (!items.length) {
        // Nothing standing - record an auto-completed round so the interval clock advances.
        await pool.query(`INSERT INTO recert_rounds (due_at, status, completed_at, tenant) VALUES (NOW() + interval '14 days', 'completed', NOW(), $1)`, [tnt()]);
        recordAudit({ actorId: '', actorEmail: '', actorName: startedBy || 'Scheduler', action: 'recert.open', target: 'access review', meta: { items: 0, note: 'nothing standing - auto-completed' } }).catch(() => { });
        return { items: 0 };
    }
    const round = await pool.query(`INSERT INTO recert_rounds (due_at, tenant) VALUES (NOW() + interval '14 days', $1) RETURNING *`, [tnt()]);
    for (const it of items) {
        await pool.query(
            `INSERT INTO recert_items (round_id, kind, ref_id, label, detail, tenant) VALUES ($1,$2,$3,$4,$5,$6)`,
            [round.rows[0].id, it.kind, it.ref, it.label, JSON.stringify(it.detail), tnt()]
        );
    }
    recordAudit({ actorId: '', actorEmail: '', actorName: startedBy || 'Scheduler', action: 'recert.open', target: 'access review', meta: { round: round.rows[0].id, items: items.length } }).catch(() => { });
    const counts = {};
    for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
    notifyReviewTelegram((tag) => {
        let html = `🔁 <b>Access Review Opened${tgEsc(tag)}</b>\n${items.length} standing item(s) need a keep/revoke decision (due in 14 days):`;
        for (const [k, n] of Object.entries(counts)) html += `\n• ${tgEsc(RECERT_KIND_LABELS[k] || k)}: ${n}`;
        html += `\n\nDecide in the app under <b>Access Review</b>.`;
        return html;
    }).catch(() => { });
    return { id: round.rows[0].id, items: items.length };
}

// Daily gate: opens a round when the interval elapsed, or nags once when one is overdue.
async function runRecertification() {
    if (_security.recertEnabled === false) return;
    const now = await tzNowParts();
    // Daily gate is per-account: the bare key for main, `recert_check_last:<tenant>` in a tenant
    // context, so each account opens/nags its own rounds independently.
    const last = await getSetting(tntKey('recert_check_last')).catch(() => '');
    if (last === now.dateKey) return;
    await setSetting(tntKey('recert_check_last'), now.dateKey);

    const open = await pool.query(`SELECT * FROM recert_rounds WHERE status='open' AND tenant=$1 ORDER BY id DESC LIMIT 1`, [tnt()]).catch(() => ({ rows: [] }));
    if (open.rows.length) {
        const round = open.rows[0];
        if (!round.reminded_at && new Date(round.due_at).getTime() < Date.now()) {
            const pending = await pool.query(`SELECT COUNT(*)::int AS n FROM recert_items WHERE round_id=$1 AND tenant=$2 AND status='pending'`, [round.id, tnt()]);
            if ((pending.rows[0] || {}).n > 0) {
                await pool.query('UPDATE recert_rounds SET reminded_at=NOW() WHERE id=$1 AND tenant=$2', [round.id, tnt()]).catch(() => { });
                notifyReviewTelegram((tag) => `⏰ <b>Access Review Overdue${tgEsc(tag)}</b>\n${pending.rows[0].n} item(s) still waiting for a keep/revoke decision.`).catch(() => { });
            }
        }
        return;
    }
    const prev = await pool.query(`SELECT started_at FROM recert_rounds WHERE tenant=$1 ORDER BY id DESC LIMIT 1`, [tnt()]).catch(() => ({ rows: [] }));
    if (prev.rows.length && Date.now() - new Date(prev.rows[0].started_at).getTime() < _security.recertIntervalDays * 86400000) return;
    await openRecertRound('Scheduler');
}

// Perform the ACTUAL removal for a revoked item. Config entries are matched by stable
// content (JSONB reorders keys); an item whose underlying object is already gone is a
// no-op success - the standing access no longer exists, which is the desired end state.
async function applyRecertRevoke(it, actor) {
    const d = it.detail || {};
    if (it.kind === 'bypass') {
        await revokePeerBypass(d.peerId);
        // An explicit human "Revoke" - if we applied this bypass automatically, remember it so
        // the OS rule never re-applies it (same semantics as the Peers page revoke).
        await noteEdrAutoBypassRevoked(d.peerId).catch(() => { });
        return;
    }
    if (it.kind === 'perm_user' || it.kind === 'perm_group') {
        const cfg = getFeaturePermsConfig();
        const e = cfg[d.key];
        if (!e) return;
        if (it.kind === 'perm_user') {
            e.users = (e.users || []).filter(u => !((d.user && d.user.id && u.id === d.user.id) || (d.user && d.user.email && u.email === d.user.email)));
        } else {
            e.groupIds = (e.groupIds || []).filter(g => g !== d.groupId);
        }
        await setFeaturePermsConfig({ [d.key]: e });
        return;
    }
    if (it.kind === 'auto_trusted' || it.kind === 'auto_rule') {
        const cfg = getAutoApprovalConfig();
        const match = stableStringify(d.entry);
        if (it.kind === 'auto_trusted') await setAutoApprovalConfig({ trusted: (cfg.trusted || []).filter(t => stableStringify(t) !== match), rules: cfg.rules });
        else await setAutoApprovalConfig({ trusted: cfg.trusted, rules: (cfg.rules || []).filter(r => stableStringify(r) !== match) });
        return;
    }
    if (it.kind === 'recurring') {
        const old = await pool.query('SELECT * FROM recurring_access WHERE id=$1 AND tenant=$2', [d.ruleId, tnt()]);
        if (!old.rows.length) return; // rule already deleted
        await pool.query('UPDATE recurring_access SET enabled=false WHERE id=$1 AND tenant=$2', [d.ruleId, tnt()]);
        if (old.rows[0].active_grant_id) {
            await revokeCurrentRecurringGrant(old.rows[0].active_grant_id, actor).catch(() => { });
            await pool.query('UPDATE recurring_access SET active_grant_id=NULL WHERE id=$1 AND tenant=$2', [d.ruleId, tnt()]).catch(() => { });
        }
        return;
    }
    throw new Error('unknown review item kind: ' + it.kind);
}

async function decideRecertItem(itemId, decision, actor) {
    if (decision !== 'keep' && decision !== 'revoke') throw new Error('decision must be keep or revoke');
    const r = await pool.query(`SELECT i.*, rr.status AS round_status FROM recert_items i JOIN recert_rounds rr ON rr.id = i.round_id AND rr.tenant = i.tenant WHERE i.id=$1 AND i.tenant=$2`, [itemId, tnt()]);
    if (!r.rows.length) throw new Error('review item not found');
    const it = r.rows[0];
    if (it.round_status !== 'open') throw new Error('this review round is already closed');
    if (it.status !== 'pending') throw new Error('this item was already decided');

    if (decision === 'revoke') await applyRecertRevoke(it, actor);
    const by = (actor && (actor.name || actor.email)) || 'admin';
    await pool.query(`UPDATE recert_items SET status=$2, decided_by=$3, decided_at=NOW() WHERE id=$1 AND tenant=$4`, [itemId, decision === 'revoke' ? 'revoked' : 'kept', by, tnt()]);
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: decision === 'revoke' ? 'recert.revoke' : 'recert.keep', target: it.label,
        meta: { kind: RECERT_KIND_LABELS[it.kind] || it.kind, round: it.round_id },
    }).catch(() => { });

    // Last decision closes the round.
    const pending = await pool.query(`SELECT COUNT(*)::int AS n FROM recert_items WHERE round_id=$1 AND tenant=$2 AND status='pending'`, [it.round_id, tnt()]);
    if (!(pending.rows[0] || {}).n) {
        await pool.query(`UPDATE recert_rounds SET status='completed', completed_at=NOW() WHERE id=$1 AND tenant=$2`, [it.round_id, tnt()]);
        const sums = await pool.query(`SELECT status, COUNT(*)::int AS n FROM recert_items WHERE round_id=$1 AND tenant=$2 GROUP BY status`, [it.round_id, tnt()]);
        const kept = (sums.rows.find(x => x.status === 'kept') || {}).n || 0;
        const revoked = (sums.rows.find(x => x.status === 'revoked') || {}).n || 0;
        recordAudit({ actorId: '', actorEmail: '', actorName: by, action: 'recert.complete', target: 'access review', meta: { round: it.round_id, kept, revoked } }).catch(() => { });
        notifyReviewTelegram((tag) => `✅ <b>Access Review Completed${tgEsc(tag)}</b>\n${kept} kept · ${revoked} revoked.`).catch(() => { });
    }
    return { id: itemId, status: decision === 'revoke' ? 'revoked' : 'kept' };
}

function recertItemToApi(i) {
    return {
        id: i.id, kind: i.kind, kindLabel: RECERT_KIND_LABELS[i.kind] || i.kind,
        label: i.label, info: (i.detail && i.detail.info) || '',
        status: i.status, decidedBy: i.decided_by || '', decidedAt: i.decided_at || null,
    };
}

// Cancel the open round entirely (items + row). Lets an admin restart with a fresh
// snapshot (e.g. after config changes made the items stale). The previous round's
// started_at still drives the interval clock, so cancelling never delays the schedule.
async function cancelRecertRound(actor) {
    const open = await pool.query(`SELECT * FROM recert_rounds WHERE status='open' AND tenant=$1 ORDER BY id DESC LIMIT 1`, [tnt()]);
    if (!open.rows.length) throw new Error('no open review round to cancel');
    const id = open.rows[0].id;
    await pool.query('DELETE FROM recert_items WHERE round_id=$1 AND tenant=$2', [id, tnt()]);
    await pool.query('DELETE FROM recert_rounds WHERE id=$1 AND tenant=$2', [id, tnt()]);
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '', actorEmail: (actor && actor.email) || '', actorName: (actor && actor.name) || '',
        action: 'recert.cancel', target: 'access review', meta: { round: id },
    }).catch(() => { });
    return { cancelled: id };
}
// One-time in-place upgrade: rounds opened before items carried decision context
// (detail.info) get their PENDING items re-snapshotted with fresh labels + info, so an
// already-open round shows the full context without having to cancel it. Decided items
// keep their historical label (that is what was reviewed). Matched by kind + ref_id;
// items whose underlying object vanished keep their old label.
async function upgradeRecertItemsInfo(items) {
    if (!items.some(i => i.status === 'pending' && !(i.detail && i.detail.info))) return false;
    const fresh = await buildRecertItems();
    const byKey = new Map(fresh.map(f => [`${f.kind}:${f.ref}`, f]));
    for (const it of items) {
        if (it.status !== 'pending') continue;
        const f = byKey.get(`${it.kind}:${it.ref_id}`);
        if (!f) continue;
        await pool.query('UPDATE recert_items SET label=$2, detail=$3 WHERE id=$1 AND tenant=$4', [it.id, f.label, JSON.stringify(f.detail), tnt()]).catch(() => { });
    }
    return true;
}

// Completed-round history + one round's full report (who kept/revoked what, when) -
// the evidence trail an external audit asks for.
async function listRecertRounds() {
    const r = await pool.query(`
        SELECT r.*,
               (SELECT COUNT(*)::int FROM recert_items i WHERE i.round_id = r.id AND i.tenant = r.tenant AND i.status='kept') AS kept,
               (SELECT COUNT(*)::int FROM recert_items i WHERE i.round_id = r.id AND i.tenant = r.tenant AND i.status='revoked') AS revoked
        FROM recert_rounds r WHERE r.status='completed' AND r.tenant=$1 ORDER BY r.id DESC LIMIT 20`, [tnt()]);
    return r.rows.map(x => ({ id: x.id, startedAt: x.started_at, completedAt: x.completed_at, kept: x.kept, revoked: x.revoked }));
}
async function getRecertRound(id) {
    const r = await pool.query('SELECT * FROM recert_rounds WHERE id=$1 AND tenant=$2', [id, tnt()]);
    if (!r.rows.length) throw new Error('review round not found');
    const items = await pool.query('SELECT * FROM recert_items WHERE round_id=$1 AND tenant=$2 ORDER BY kind, label', [id, tnt()]);
    return {
        id: r.rows[0].id, status: r.rows[0].status,
        startedAt: r.rows[0].started_at, completedAt: r.rows[0].completed_at,
        items: items.rows.map(recertItemToApi),
    };
}

async function getRecertification() {
    const open = await pool.query(`SELECT * FROM recert_rounds WHERE status='open' AND tenant=$1 ORDER BY id DESC LIMIT 1`, [tnt()]);
    const lastDone = await pool.query(`
        SELECT r.*,
               (SELECT COUNT(*)::int FROM recert_items i WHERE i.round_id = r.id AND i.tenant = r.tenant AND i.status='kept') AS kept,
               (SELECT COUNT(*)::int FROM recert_items i WHERE i.round_id = r.id AND i.tenant = r.tenant AND i.status='revoked') AS revoked
        FROM recert_rounds r WHERE r.status='completed' AND r.tenant=$1 ORDER BY r.id DESC LIMIT 1`, [tnt()]);
    let round = null;
    if (open.rows.length) {
        let items = await pool.query(`SELECT * FROM recert_items WHERE round_id=$1 AND tenant=$2 ORDER BY kind, label`, [open.rows[0].id, tnt()]);
        if (await upgradeRecertItemsInfo(items.rows)) {
            items = await pool.query(`SELECT * FROM recert_items WHERE round_id=$1 AND tenant=$2 ORDER BY kind, label`, [open.rows[0].id, tnt()]);
        }
        round = {
            id: open.rows[0].id, startedAt: open.rows[0].started_at, dueAt: open.rows[0].due_at,
            items: items.rows.map(recertItemToApi),
        };
    }
    const ld = lastDone.rows[0];
    return {
        enabled: _security.recertEnabled !== false,
        intervalDays: _security.recertIntervalDays,
        open: round,
        lastCompleted: ld ? { id: ld.id, startedAt: ld.started_at, completedAt: ld.completed_at, kept: ld.kept, revoked: ld.revoked } : null,
    };
}

// `force` = the admin's "Send Now" button: skips the enabled/schedule/once-a-day gates but
// still stamps the daily marker, so a manual send suppresses that day's scheduled one
// (no accidental double digest).
async function sendAccessReviewDigest({ force = false } = {}) {
    const now = await tzNowParts();
    if (!force) {
        if (!_security.reviewEnabled) return;
        if (now.dow !== _security.reviewDay || now.hour !== _security.reviewHour) return;
        const last = await getSetting('access_review_last').catch(() => '');
        if (last === now.dateKey) return; // already sent today
    }
    await setSetting('access_review_last', now.dateKey);

    const [grants, pending] = await Promise.all([
        listTemporaryAccessGrants().catch(() => []),
        countPendingRequests().catch(() => 0),
    ]);
    const active = grants.filter(g => g.status === 'active');
    await ensurePeersFresh().catch(() => { });
    const allPeers = await getAllPeers().catch(() => []);
    const bypassed = allPeers.filter(p => p.force_approved);

    // ── "This Week" + hygiene additions: the digest answers BOTH "what is open right
    // now" (the sections above) and "what happened / what rotted since last week".
    // Every collector degrades independently - a failed scan never kills the digest.
    const weekMs = Date.now() - 7 * 86400_000;
    const newPeers = allPeers.filter(p => p.created_at && new Date(p.created_at).getTime() > weekMs);
    const nonCompliant = allPeers.filter(p => p.approval_required && !p.force_approved);
    const reqStats = await pool.query(
        `SELECT status, COUNT(*)::int AS n FROM access_requests
         WHERE created_at > NOW() - interval '7 days' GROUP BY status`).catch(() => ({ rows: [] }));
    const rq = Object.fromEntries(reqStats.rows.map(r => [r.status, r.n]));
    const rqTotal = reqStats.rows.reduce((s, r) => s + r.n, 0);
    const rqBreakdown = ['approved', 'denied', 'pending', 'expired', 'cancelled']
        .filter(s => rq[s]).map(s => `${rq[s]} ${s}`).join(', ');
    const notifStats = await pool.query(
        `SELECT category, COUNT(*)::int AS n FROM nb_notifications
         WHERE received_at > NOW() - interval '7 days' GROUP BY category`).catch(() => ({ rows: [] }));
    const nf = Object.fromEntries(notifStats.rows.map(r => [r.category, r.n]));
    const nfLine = [nf.peer ? `${nf.peer} peer/routing` : '', nf.integration ? `${nf.integration} integration` : '']
        .filter(Boolean).join(', ');
    // Billed users: current + the change vs ~a week ago (both from stored billing events).
    let billedLine = '';
    try {
        const cur = await getBillingSummary();
        if (cur && cur.billedUsers != null) {
            const prev = await pool.query(
                `SELECT meta FROM admin_events WHERE tenant = $1 AND LOWER(message) LIKE 'billing%'
                 AND timestamp <= NOW() - interval '6 days' ORDER BY timestamp DESC LIMIT 1`, [tnt()]).catch(() => ({ rows: [] }));
            const pm = (prev.rows[0] && prev.rows[0].meta) || {};
            const pn = parseInt(pm.billed_users ?? pm.billedUsers ?? pm.users, 10);
            const delta = Number.isFinite(pn) ? cur.billedUsers - pn : null;
            billedLine = `${cur.billedUsers}${delta ? ` (${delta > 0 ? '+' : ''}${delta} this week)` : ''}`;
        }
    } catch { /* billing data optional */ }
    const conflicts = await scanResourceConflicts().catch(() => []);
    const conflictCount = Array.isArray(conflicts) ? conflicts.length : 0;
    const cleanup = await scanCleanup({ staleDays: 30 }).catch(() => null);
    const perms = getFeaturePermsConfig();
    const permLines = Object.entries(perms)
        .filter(([, e]) => e.users.length || e.groupIds.length)
        .map(([k, e]) => `• <b>${tgEsc(k)}</b>: ${e.users.map(u => tgEsc(u.name || u.email)).join(', ') || '-'}${e.groupIds.length ? ` + ${e.groupIds.length} group(s)` : ''}`);
    const auto = getAutoApprovalConfig();
    const autoBits = [];
    if ((auto.trusted || []).length) autoBits.push(`${auto.trusted.length} trusted-group rule(s)`);
    if ((auto.rules || []).length) autoBits.push(`${auto.rules.length} self-service rule(s)`);

    let html = `📋 <b>Weekly Access Review</b>`;
    html += `\n\n🔑 <b>Active temporary grants (${active.length}):</b>`;
    for (const g of active.slice(0, 15)) {
        const t = (g.targets || []).map(x => x.name || x.id).join(', ');
        html += `\n• ${tgEsc(g.userLabel)} → ${tgEsc(t)} (until ${tgEsc(await tgFmtTime(g.expiresAt))})`;
    }
    if (active.length > 15) html += `\n… and ${active.length - 15} more`;
    if (!active.length) html += '\n• none';
    html += `\n\n🛡 <b>Active device bypasses (${bypassed.length}):</b>`;
    for (const p of bypassed.slice(0, 15)) {
        html += `\n• ${tgEsc(p.name || p.id)}${p.owner_email ? ` (${tgEsc(p.owner_email)})` : ''}${p.bypass_expires_at ? ` - expires ${tgEsc(await tgFmtTime(p.bypass_expires_at))}` : ' - ♾ unlimited'}${p.bypass_temp_device ? ' 🗑 temp device' : ''}`;
    }
    if (!bypassed.length) html += '\n• none';
    html += `\n\n⚙️ <b>Auto-approval:</b> ${autoBits.join(', ') || 'none configured'}`;
    html += `\n👥 <b>Feature permissions:</b>${permLines.length ? '\n' + permLines.join('\n') : ' none granted'}`;
    const activeDelegs = _approver.delegates.filter(d => d.from <= now.dateKey && now.dateKey <= d.until);
    if (activeDelegs.length) {
        html += `\n🔁 <b>Active approver delegations:</b>`;
        for (const d of activeDelegs) html += `\n• ${tgEsc(d.user.name || d.user.email || d.user.id)} (until ${tgEsc(d.until)})`;
    }
    html += `\n\n⏳ <b>Pending requests:</b> ${pending}`;

    html += `\n\n📈 <b>This week:</b>`;
    html += `\n• New devices: ${newPeers.length}${newPeers.length ? ` (${newPeers.slice(0, 5).map(p => tgEsc(p.name)).join(', ')}${newPeers.length > 5 ? '…' : ''})` : ''}`;
    html += `\n• Access requests: ${rqTotal}${rqBreakdown ? ` (${rqBreakdown})` : ''}`;
    html += `\n• Non-compliant devices right now: ${nonCompliant.length}`;
    if (nfLine) html += `\n• NetBird alerts: ${nfLine}`;
    if (billedLine) html += `\n• Billed users: ${billedLine}`;

    html += `\n\n🧹 <b>Hygiene:</b>`;
    if (cleanup) {
        html += `\n• Policies: ${cleanup.orphanedPolicies.length} orphaned, ${cleanup.ineffectivePolicies.length} ineffective · Groups unused: ${cleanup.emptyGroups.length}`;
        html += `\n• Unreachable resources: ${cleanup.unreachableResources.length} · Devices offline 30d+: ${cleanup.stalePeers.length}`;
    }
    html += `\n• Open address conflicts: ${conflictCount}`;
    if (cleanup || conflictCount) html += `\n(Details: Operations → Cleanup)`;

    html += `\n\nReview anything that shouldn't still be open.`;

    const tgSent = await sendTelegram('requests', html, { chatId: getApprovalsChatId() || undefined }).catch(() => null);
    const REVIEW_EMAILS = _security.reviewEmails || [];
    let emailsSent = 0;
    if (REVIEW_EMAILS.length && getSmtpConfig().enabled) {
        const esc = htmlEsc;
        let mail = `<p>Weekly summary of currently open access - review anything that shouldn't still be open.</p>`;
        mail += `<h3>Active Temporary Grants (${active.length})</h3><ul>` + (active.map(g =>
            `<li>${esc(g.userLabel)} → ${esc((g.targets || []).map(x => x.name || x.id).join(', '))}</li>`).join('') || '<li>none</li>') + '</ul>';
        mail += `<h3>Active Device Bypasses (${bypassed.length})</h3><ul>` + (bypassed.map(p =>
            `<li>${esc(p.name || p.id)}${p.owner_email ? ` (${esc(p.owner_email)})` : ''}${p.bypass_expires_at ? '' : ' - unlimited'}</li>`).join('') || '<li>none</li>') + '</ul>';
        mail += `<p><b>Auto-approval:</b> ${esc(autoBits.join(', ') || 'none configured')}<br/><b>Pending requests:</b> ${pending}</p>`;
        mail += `<h3>This Week</h3><ul>`
            + `<li><b>New devices:</b> ${newPeers.length}${newPeers.length ? ' - ' + esc(newPeers.slice(0, 8).map(p => `${p.name}${p.owner_name || p.owner_email ? ` (${p.owner_name || p.owner_email})` : ''}`).join(', ')) + (newPeers.length > 8 ? '…' : '') : ''}</li>`
            + `<li><b>Access requests:</b> ${rqTotal}${rqBreakdown ? ` (${esc(rqBreakdown)})` : ''}</li>`
            + `<li><b>Non-compliant devices right now:</b> ${nonCompliant.length}${nonCompliant.length ? ' - ' + esc(nonCompliant.slice(0, 5).map(p => p.name).join(', ')) + (nonCompliant.length > 5 ? '…' : '') : ''}</li>`
            + (nfLine ? `<li><b>NetBird alerts:</b> ${esc(nfLine)}</li>` : '')
            + (billedLine ? `<li><b>Billed users:</b> ${esc(billedLine)}</li>` : '')
            + `</ul>`;
        mail += `<h3>Hygiene</h3><ul>`
            + (cleanup
                ? `<li><b>Policies:</b> ${cleanup.orphanedPolicies.length} orphaned, ${cleanup.ineffectivePolicies.length} ineffective</li>`
                + `<li><b>Unused groups:</b> ${cleanup.emptyGroups.length}</li>`
                + `<li><b>Unreachable resources:</b> ${cleanup.unreachableResources.length}</li>`
                + `<li><b>Devices offline 30d+:</b> ${cleanup.stalePeers.length}</li>`
                : '')
            + `<li><b>Open address conflicts:</b> ${conflictCount}</li>`
            + `</ul><p>Details live under Operations &rsaquo; Cleanup in the app.</p>`;
        for (const to of REVIEW_EMAILS) {
            sendMail({ to, subject: 'Weekly Access Review', html: mailLayout('Weekly Access Review', mail), tag: 'access-review' }).catch(() => { });
            emailsSent++;
        }
    }
    console.log('[AccessReview] weekly digest sent');
    // Summary for the manual "Send Now" button's feedback toast.
    return { telegram: !!tgSent, emails: emailsSent };
}

// Handle a Telegram update: either a button press (callback_query) or a reply carrying a denial
// reason (message). The webhook is subscribed to both.
async function handleTelegramCallback(update) {
    if (update && update.message) return handleTelegramReplyMessage(update.message);
    const cq = update && update.callback_query;
    if (!cq) return;
    const from = cq.from || {};
    // Authorize by the Telegram id, and resolve it to the mapped SYSTEM user so the decision is
    // attributed to the real person in the audit log - not their Telegram handle.
    const approver = getApproverByTelegramId(from.id);
    if (!approver) {
        await answerCallbackQuery(cq.id, '⛔ You are not authorized to approve access requests.');
        return;
    }
    // req:<kind>:<id>[:<arg>]  kinds: approve|deny|menu|tg (submenus) · ap|dn|dnr|tgl (actions)
    const m = String(cq.data || '').match(/^req:(approve|deny|menu|ap|dn|dnr|tg|tgl):(\d+)(?::(\d+))?$/);
    if (!m) { await answerCallbackQuery(cq.id, 'Unknown action'); return; }
    const kind = m[1], id = parseInt(m[2], 10), arg = m[3] != null ? parseInt(m[3], 10) : null;
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const msgId = cq.message && cq.message.message_id;
    const actor = tgActorFrom(approver, from);
    try {
        if (kind === 'approve') {                                   // open the duration submenu
            const req = await getAccessRequestRow(id);
            if (req && req.kind === 'bypass') {                     // bypass: pick a duration (or unlimited)
                await editTelegramReplyMarkup(chatId, msgId, reqKbBypassApprove(id, !!req.temp_device, req.requested_minutes || 0));
                await answerCallbackQuery(cq.id, req.temp_device ? 'Temporary device - it will be deleted when the bypass expires.' : 'How long should the bypass last?');
                return;
            }
            await editTelegramReplyMarkup(chatId, msgId, reqKbApprove(id, req ? req.requested_minutes : 0, !!(req && Array.isArray(req.targets) && req.targets.length > 1)));
            await answerCallbackQuery(cq.id, 'Choose how long…');
        } else if (kind === 'tg') {                                 // open the target-editing submenu
            const req = await getAccessRequestRow(id);
            if (!req || req.kind === 'bypass' || req.status !== 'pending') { await answerCallbackQuery(cq.id, 'Not available'); return; }
            await editTelegramReplyMarkup(chatId, msgId, reqKbTargets(req));
            await answerCallbackQuery(cq.id, 'Toggle targets, then Approve Selected');
        } else if (kind === 'tgl') {                                // toggle one target on/off
            const req = await getAccessRequestRow(id);
            const t = req && Array.isArray(req.targets) ? req.targets[arg] : null;
            if (!req || req.status !== 'pending' || !t) { await answerCallbackQuery(cq.id, 'Not available'); return; }
            const key = (x) => `${x.type}:${x.id}`;
            let ex = Array.isArray(req.excluded_targets) ? req.excluded_targets : [];
            if (ex.some(x => key(x) === key(t))) {
                ex = ex.filter(x => key(x) !== key(t));
            } else {
                if (ex.length + 1 >= req.targets.length) { await answerCallbackQuery(cq.id, 'At least one target must stay - deny the request instead.'); return; }
                ex = [...ex, { type: t.type, id: t.id, name: t.name || t.id }];
            }
            await pool.query('UPDATE access_requests SET excluded_targets=$2 WHERE id=$1', [id, JSON.stringify(ex)]).catch(() => { });
            await editTelegramReplyMarkup(chatId, msgId, reqKbTargets({ ...req, excluded_targets: ex }));
            await answerCallbackQuery(cq.id, '');
        } else if (kind === 'deny') {                               // open the deny submenu
            await editTelegramReplyMarkup(chatId, msgId, reqKbDeny(id));
            await answerCallbackQuery(cq.id, 'Deny this request…');
        } else if (kind === 'menu') {                               // back to Approve / Deny
            // Backing out resets any target toggles - approvals from a fresh menu grant everything.
            await pool.query(`UPDATE access_requests SET excluded_targets='[]'::jsonb WHERE id=$1 AND status='pending'`, [id]).catch(() => { });
            await editTelegramReplyMarkup(chatId, msgId, reqKbInitial(id));
            await answerCallbackQuery(cq.id, '');
        } else if (kind === 'dnr') {                                // ask for a typed reason
            const req = await getAccessRequestRow(id);
            await sendDenyPrompt(chatId, id, req && (req.requester_name || req.requester_email || req.requester_id));
            await answerCallbackQuery(cq.id, 'Reply with a reason ✍️');
        } else if (kind === 'ap') {                                 // approve (0 = as requested)
            if (NETBIRD_READONLY) { await answerCallbackQuery(cq.id, 'Read-only mode - cannot approve.'); return; }
            await approveAccessRequest(id, { durationMinutes: arg || undefined, actor });
            await answerCallbackQuery(cq.id, `Approved ✅${arg ? ` (${shortDur(arg)})` : ''}`);
        } else if (kind === 'dn') {                                 // deny with no reason
            await denyAccessRequest(id, { reason: 'Denied via Telegram', actor });
            await answerCallbackQuery(cq.id, 'Denied ⛔');
        }
    } catch (e) {
        await answerCallbackQuery(cq.id, e.message || 'Could not process');
        const req = await getAccessRequestRow(id);
        if (req && req.status !== 'pending' && req.tg_chat_id) {
            editTelegramMessage(req.tg_chat_id, req.tg_message_id, accessRequestOutcomeHtml(req, req.status, req.decided_by || 'someone')).catch(() => { });
        }
    }
}

// Deny reason typed as a reply to the bot's force-reply prompt.
async function handleTelegramReplyMessage(msg) {
    const reply = msg && msg.reply_to_message;
    if (!reply || !reply.text) return;
    const mk = reply.text.match(/DENY request #(\d+)/i);   // only our deny prompt qualifies
    if (!mk) return;
    const approver = getApproverByTelegramId((msg.from || {}).id);
    if (!approver) return;                                  // silently ignore non-approvers
    const reason = String(msg.text || '').trim();
    if (!reason) return;
    const id = parseInt(mk[1], 10);
    const chatId = msg.chat && msg.chat.id;
    try {
        await denyAccessRequest(id, { reason, actor: tgActorFrom(approver, msg.from) });
        if (chatId) {
            telegramApi('deleteMessage', { chat_id: chatId, message_id: reply.message_id }).catch(() => { }); // clear the prompt
            telegramApi('sendMessage', { chat_id: chatId, text: `⛔ Request #${id} denied.`, reply_to_message_id: msg.message_id }).catch(() => { });
        }
    } catch (e) {
        if (chatId) telegramApi('sendMessage', { chat_id: chatId, text: `⚠️ ${e.message || 'Could not deny'}`, reply_to_message_id: msg.message_id }).catch(() => { });
    }
}

module.exports = {
    pool, initializeDatabase, ensureLogIndexes, addEvent, addAdminEvent, queryEvents, queryTrafficSummary, queryAdminEvents, getAdminStats,
    syncIpAssignments, queryIpHistory, getIpHistoryUsers, getHourlyEventCounts, getReverseProxyStatus, bustReverseProxyCache, getProxyAccessLogs, syncProxyAccessLogs, getProxyLogUsers, getProxyLogsSummary, getProxyServiceStats, getProxyDomains, createProxyService, exposeDockerService, getProxyServiceRaw, sanitizeProxyService, updateProxyService, deleteProxyService, getProxyTargetOptions,
    getDistinctUsers, getDistinctSources, getStats, getAllUsers, getAllPeers, getPeerDetail, deletePeer, revokePeerBypass, getGroups, getGroupDetail, createGroup, renameGroup, deleteGroup, setGroupPeers, setUserGroups, addUsersToGroup, removeUsersFromGroup, getUserDetail, deleteUser, setUserBlocked, resetUserMfa, getNetworks, getNetworkDetail, getUsageData, getAllPolicies, createPolicy, updatePolicy, checkResourcePolicySync, deletePolicy, policyRenamePlan, applyPolicyRenames, createNetwork, updateNetwork, deleteNetwork, setNetworkAllowDuplicates, createNetworkRouter, deleteNetworkRouter,
    getAllGrants, setNetworkGrants, getAdGroups, createClientResource, editResource, deleteResource, mergeResources, moveResources, scanResourceConflicts, scanCleanup, setCleanupIgnore, setResourceEnabled,
    setResourcePolicy, syncResourcePolicies, getNetbirdGroups, resolveGrantGroups,
    getTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
    getFilterConfig, getFilterRules, createFilterRule, updateFilterRule, deleteFilterRule, scanEvents, deleteEventsByIds, getSetting, setSetting,
    // Ingestion filtering shared by both paths (webhook receiver + API pull) - see lib/events.js.
    isNoiseTraffic, eventMatchesFilters,
    // Opt-in Traffic Events API pull (the no-streaming alternative).
    syncTrafficEvents, getTrafficPullConfig, setTrafficPullConfig, getTrafficPullStatus,
    // Opt-in Audit Events API pull (the no-streaming alternative for admin/audit events).
    syncAuditEvents, getAuditPullConfig, setAuditPullConfig, getAuditPullStatus,
    getNbApiConfig, setNbApiConfig, getWebhookConfig, getNetbirdWebhookStatus, setWebhookConfig, getWebhookToken, getNotifWebhookToken,
    getTelegramConfig, setTelegramConfig, getTelegramQueueStats, getAdminEventTypes, getBillingSummary, telegramTest, telegramCreateTopics,
    getSmtpConfig, setSmtpConfig, smtpTest,
    getFeaturePermsConfig, setFeaturePermsConfig, resolveFeaturePerms,
    getApproverConfig, setApproverConfig, getApproverGroupIds, getTelegramWebhookSecret, telegramSetWebhook, telegramDeleteWebhook, handleTelegramCallback,
    getAutoApprovalConfig, setAutoApprovalConfig,
    searchRequestTargets, createAccessRequest, listAccessRequests, countPendingRequests,
    approveAccessRequest, denyAccessRequest, cancelAccessRequest, backfillApprovedDurations,
    recordAudit, getAuditLog, getOutboundLog, getOutboundBody, notifySchedJobAlert,
    diagHosts, diagWhoAmI, diagnoseDevice, diagnoseTarget, diagnoseAddress,
    ingestNbNotification, getNbNotices, dismissNbNotification,
    runWithTenant, currentTenantAccount, getMspStatus, bustMspCache,
    listMspTenants, listMspSwitcher, createMspTenant, updateMspTenant, deleteMspTenant, verifyMspTenantDomain, getMspTenantOverview,
    getMspBillingPlans, setMspTenantSubscription,
    setMspTenantToken, setMspProvisioningToken, provisionTenantServiceUser, rotateTenantTokens, getMspProvisioningToken,
    getFleetReport, getMspDigestConfig, setMspDigestConfig, sendMspDigest,
    listActiveTenantIds, forEachTenant, propagateFilterRules, propagateBlocklist,
    seedTenantDefaults, computeTenantDrift, autoConfigureNbNotifications, autoConfigureNbEventStreaming, tenantNameOf,
    getTenantDefaults, setTenantDefaults, effectiveTenantDefaults, deriveDefaultsFromMain, mfaSupported,
    getNetbirdSettings, saveNetbirdSettings,
    getBuiltinNoise, setBuiltinNoise,
    netbirdGet, getGroupRefMap,
    listAccessProfiles, createAccessProfile, updateAccessProfile, deleteAccessProfile,
    getNetworkDefaultProfiles, getAllNetworkDefaultProfiles, setNetworkDefaultProfiles,
    listPostureChecks, createPostureCheck, updatePostureCheck, deletePostureCheck, getCountries, getCities,
    listAutomations, getAutomationRow, createAutomation, updateAutomation, deleteAutomation,
    getAutomationRuns, runAutomation, testAutomation, runDueAutomations, resetStuckAutomations,
    getAutomationManaged, repairAutomation, forgetAutomation,
    getBlocklist, addBlocklistEntry, addBlocklistEntries, updateBlocklistEntry, deleteBlocklistEntry, addressBlockedForNetwork,
    scanBlockedResources, enforceBlockedResources,
    listTemporaryAccessGrants, createTemporaryAccessGrant, revokeTemporaryAccessGrant, extendTemporaryAccessGrant, deleteTemporaryAccessGrant,
    revokeExpiredGrants, reconcileActiveGrants, resetStuckGrants, cleanupStuckCreatingGrants, revokeExpiredBypasses, escalatePendingRequests, sendAccessReviewDigest, checkTrafficAnomalies,
    purgeOldEvents, getRetentionStatus, getRetentionDays, setRetentionDays, getSystemStats,
    exportAppSettings, importAppSettings,
    // Internal envelope-encrypted backup (tier 2)
    getInternalBackupStatus, setBackupPassphrase, getInternalBackupConfig, setInternalBackupConfig,
    runInternalBackup, restoreInternalBackup, readBackupFile, backupFilePath, listBackupFiles, internalBackupTick,
    BACKUP_DIR,
    runRecertification, openRecertRound, getRecertification, decideRecertItem, cancelRecertRound, listRecertRounds, getRecertRound,
    isActiveDelegate, setPeerMeta, getAllPeerTags, bulkTagPeers, dryRunAutomation,
    // Pure helpers exposed ONLY for unit tests (backend/test) - not part of the app API.
    _internal: { comboKey, combosForResource, ALL_COMBO, splitPortTokens, mergeRulePorts, normSecurityConfig, humanDuration, stableStringify, normDelegates, normEdrAutoBypass, edrOsKey, ruleForPut, carryRuleExtras, ruleHasUnmodeled, policiesSourcingResources, editorProtocol,
        normalizeTenantDefaults, nbShapeFromSettings, nbSettingsFromProfile, dropUnsupportedNbSettings, proxyAccessActionError,
        normMspDigest, encryptPrivateKey, encryptBackup, decryptBackup },
    listRecurringAccess, createRecurringAccess, updateRecurringAccess, deleteRecurringAccess, runRecurringAccess,
    getSecurityConfig, setSecurityConfig,
    getEdrAutoBypassConfig, setEdrAutoBypassConfig, noteEdrAutoBypassRevoked, EDR_OS_LABELS,
    resolveUser, resolveUsersForEvents, resolveUsersForAdminEvents, getOwnNetbirdUserId, resolveViewer, getUserPeerGroupIds,
    ensurePeersFresh, ensureUsersFresh, resetNbCaches, netbirdApiConfigured,
    inviteUser, resendUserInvite, USER_ROLES, createSetupKey,
    getInviteDefaultGroups, setInviteDefaultGroups,
    fetchUserGroups, graphConfigured, graphGroupDiag, NETBIRD_READONLY
};
