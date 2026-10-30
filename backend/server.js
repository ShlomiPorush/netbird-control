// quiet: dotenv 17+ otherwise logs an "injecting env" line on every start.
require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { auth, requiresAuth } = require('express-openid-connect');
const { parseTrustProxy, limiterOptions } = require('./lib/rate-limit');
const { safeReturnTo, isPlausibleEmail } = require('./lib/pure');
const { initializeDatabase, ensureLogIndexes, addEvent, addAdminEvent, queryEvents, queryTrafficSummary, queryAdminEvents, getAdminStats, syncIpAssignments, queryIpHistory, getIpHistoryUsers, getHourlyEventCounts, getReverseProxyStatus, bustReverseProxyCache, getProxyAccessLogs, syncProxyAccessLogs, getProxyLogUsers, getProxyLogsSummary, getProxyServiceStats, getProxyDomains, createProxyService, exposeDockerService, getProxyServiceRaw, sanitizeProxyService, updateProxyService, deleteProxyService, getProxyTargetOptions, getDistinctUsers, getDistinctSources, getStats, getAllUsers, getAllPeers, getPeerDetail, deletePeer, revokePeerBypass, getGroups, getGroupDetail, createGroup, renameGroup, deleteGroup, getUserDetail, deleteUser, getNetworks, getNetworkDetail, getUsageData, getAllPolicies, createPolicy, updatePolicy, checkResourcePolicySync, deletePolicy, policyRenamePlan, applyPolicyRenames, createNetwork, updateNetwork, deleteNetwork, setNetworkAllowDuplicates, createNetworkRouter, deleteNetworkRouter, getAllGrants, setNetworkGrants, getAdGroups, createClientResource, editResource, deleteResource, mergeResources, moveResources, scanResourceConflicts, setResourceEnabled, setResourcePolicy, syncResourcePolicies, getNetbirdGroups, resolveGrantGroups, getTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, getFilterConfig, getFilterRules, createFilterRule, updateFilterRule, deleteFilterRule, scanEvents, deleteEventsByIds, getSetting, setSetting, getNbApiConfig, setNbApiConfig, getWebhookConfig, getNetbirdWebhookStatus, setWebhookConfig, getWebhookToken, getTelegramConfig, setTelegramConfig, getTelegramQueueStats, getAdminEventTypes, getBillingSummary, telegramTest, telegramCreateTopics, getTelegramWebhookSecret, telegramSetWebhook, telegramDeleteWebhook, handleTelegramCallback, getSmtpConfig, setSmtpConfig, smtpTest, getFeaturePermsConfig, setFeaturePermsConfig, resolveFeaturePerms, getAutoApprovalConfig, setAutoApprovalConfig, getApproverConfig, setApproverConfig, getApproverGroupIds, searchRequestTargets, createAccessRequest, listAccessRequests, countPendingRequests, approveAccessRequest, denyAccessRequest, cancelAccessRequest, backfillApprovedDurations, recordAudit, getAuditLog, listAccessProfiles, createAccessProfile, updateAccessProfile, deleteAccessProfile, getNetworkDefaultProfiles, getAllNetworkDefaultProfiles, setNetworkDefaultProfiles, listPostureChecks, createPostureCheck, updatePostureCheck, deletePostureCheck, getCountries, getCities, listAutomations, getAutomationRow, createAutomation, updateAutomation, deleteAutomation, getAutomationRuns, runAutomation, testAutomation, runDueAutomations, resetStuckAutomations, getAutomationManaged, repairAutomation, forgetAutomation, getBlocklist, addBlocklistEntry, addBlocklistEntries, updateBlocklistEntry, deleteBlocklistEntry, addressBlockedForNetwork, scanBlockedResources, enforceBlockedResources, listTemporaryAccessGrants, createTemporaryAccessGrant, revokeTemporaryAccessGrant, extendTemporaryAccessGrant, deleteTemporaryAccessGrant, revokeExpiredGrants, reconcileActiveGrants, resetStuckGrants, cleanupStuckCreatingGrants, revokeExpiredBypasses, escalatePendingRequests, sendAccessReviewDigest, checkTrafficAnomalies, purgeOldEvents, getRetentionStatus, getSystemStats, exportAppSettings, importAppSettings, getInternalBackupStatus, setBackupPassphrase, getInternalBackupConfig, setInternalBackupConfig, runInternalBackup, restoreInternalBackup, readBackupFile, backupFilePath, internalBackupTick, BACKUP_DIR, runRecertification, openRecertRound, getRecertification, decideRecertItem, cancelRecertRound, listRecertRounds, getRecertRound, isActiveDelegate, setPeerMeta, getAllPeerTags, bulkTagPeers, dryRunAutomation, listRecurringAccess, createRecurringAccess, updateRecurringAccess, deleteRecurringAccess, runRecurringAccess, getSecurityConfig, setSecurityConfig, resolveUsersForEvents, resolveUsersForAdminEvents, getOwnNetbirdUserId, ensurePeersFresh, ensureUsersFresh, resetNbCaches, resolveViewer, getUserPeerGroupIds, netbirdApiConfigured, fetchUserGroups, graphGroupDiag, NETBIRD_READONLY } = require('./db');

// Later additions to db.js's API - kept as a separate require so the huge destructure
// above stays untouched (require() returns the same cached module instance).
const { getOutboundLog, getOutboundBody, scanCleanup, setCleanupIgnore, notifySchedJobAlert, diagHosts, diagWhoAmI, diagnoseDevice, diagnoseTarget, diagnoseAddress, ingestNbNotification, getNbNotices, dismissNbNotification, getNotifWebhookToken, runWithTenant, currentTenantAccount, getMspStatus, listMspTenants, listMspSwitcher, createMspTenant, updateMspTenant, deleteMspTenant, verifyMspTenantDomain, getMspTenantOverview, getMspBillingPlans, setMspTenantSubscription, setMspTenantToken, setMspProvisioningToken, provisionTenantServiceUser, rotateTenantTokens, getMspProvisioningToken, netbirdGet, getGroupRefMap, forEachTenant, listActiveTenantIds, getRetentionDays, setRetentionDays, getBuiltinNoise, setBuiltinNoise, propagateFilterRules, propagateBlocklist, seedTenantDefaults, computeTenantDrift, autoConfigureNbNotifications, autoConfigureNbEventStreaming, tenantNameOf, getTenantDefaults, setTenantDefaults, deriveDefaultsFromMain, mfaSupported, getNetbirdSettings, saveNetbirdSettings, getFleetReport, getMspDigestConfig, setMspDigestConfig, sendMspDigest, inviteUser, resendUserInvite, setUserBlocked, resetUserMfa, setGroupPeers, addUsersToGroup, removeUsersFromGroup, USER_ROLES, createSetupKey, getInviteDefaultGroups, setInviteDefaultGroups, isNoiseTraffic, eventMatchesFilters, syncTrafficEvents, setTrafficPullConfig, getTrafficPullStatus, syncAuditEvents, setAuditPullConfig, getAuditPullStatus, getEdrAutoBypassConfig, setEdrAutoBypassConfig, noteEdrAutoBypassRevoked, EDR_OS_LABELS } = require('./db');

// AD group whose members are treated as admins (in addition to NetBird owner/admin)
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID || '';
// Bulk-deleting stored events is destructive and intentionally NOT for every admin - only the
// explicit allow-list of emails (comma-separated). Empty + SSO on = nobody can purge.
const EVENT_PURGE_ADMINS = (process.env.EVENT_PURGE_ADMINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Resolve the protocol/ports for a chosen template id (or 'manual')
async function resolveTemplatePorts(template, protocol, ports) {
    if (template === 'manual') {
        const p = ['tcp', 'udp', 'all', 'icmp'].includes(protocol) ? protocol : 'tcp';
        const pts = Array.isArray(ports) ? ports.map(x => String(x).trim()).filter(Boolean) : [];
        return { protocol: p, ports: (p === 'all' || p === 'icmp') ? [] : pts };
    }
    const t = await getTemplate(parseInt(template, 10));
    if (!t) throw new Error('Unknown template');
    const p = t.protocol || 'all';
    return { protocol: p, ports: (p === 'all' || p === 'icmp') ? [] : t.ports };
}

// Normalize a resource's policies for the acting viewer. Admins choose source groups
// freely; a regular editor's sources are forced to the network's Network Access grants.
async function resolvePolicySources(viewer, networkId, grants, policies) {
    const list = Array.isArray(policies) ? policies : [];
    // The shared policy editor sends richer per-policy fields - they must survive this
    // source-resolution step or they silently vanish on save (posture checks did).
    const extras = (p) => ({
        name: p.name, description: p.description, enabled: p.enabled, bidirectional: p.bidirectional,
        postureChecks: Array.isArray(p.postureChecks) ? p.postureChecks.filter(Boolean) : [],
    });
    if (viewer.isAdmin) {
        return list.map(p => ({
            sources: (p.sources || []).filter(Boolean),
            protocol: p.protocol,
            ports: p.ports,
            ...extras(p),
        }));
    }
    // A regular editor may pick sources ONLY from the network's allowed set: the edit grants
    // flagged as policy sources (the defaults) plus the admin-curated 'source' (grantable)
    // groups. Anything else the client sends is silently dropped; an empty/invalid pick
    // falls back to the defaults - exactly the pre-grantable behavior.
    const rows = grants[networkId] || [];
    const grantGroups = await resolveGrantGroups(rows.filter(g => g.access === 'edit' && g.policySource !== false).map(g => g.id));
    const grantable = await resolveGrantGroups(rows.filter(g => g.access === 'source').map(g => g.id));
    const allowed = new Set([...grantGroups, ...grantable].map(g => g.id));
    const srcIds = grantGroups.map(g => g.id);
    return list.map(p => {
        const chosen = (p.sources || []).map(String).filter(s => allowed.has(s));
        return { sources: chosen.length ? chosen : srcIds, protocol: p.protocol, ports: p.ports, ...extras(p) };
    });
}

// Record an audit-log entry for a change made through the app (fire-and-forget).
function audit(viewer, action, target, meta) {
    // Actions performed while managing an MSP tenant are tagged with the tenant id, so the
    // audit log always shows WHICH account a change touched.
    const tenant = currentTenantAccount();
    return recordAudit({
        actorId: (viewer && (viewer.user_id || viewer.oid)) || '',
        actorEmail: (viewer && viewer.email) || '',
        actorName: (viewer && viewer.name) || '',
        action,
        target: target || '',
        meta: tenant ? { ...(meta || {}), tenant } : (meta || null),
    });
}

// Audit metas show the network's NAME, not its opaque NetBird id - both the Audit Logs
// page and the Telegram notifications read this meta verbatim.
async function netLabel(id) {
    try { return (((await getNetworks()).find(n => n && n.id === id)) || {}).name || id; }
    catch { return id; }
}

// Resolve an entity's display name BEFORE deleting it, so the audit target survives the
// object (a deleted object can't be resolved later). Falls back to the raw id.
async function labelBeforeDelete(kind, id) {
    try {
        if (kind === 'network') return await netLabel(id);
        if (kind === 'peer') return ((await getAllPeers()).find(p => p && p.id === id) || {}).name || id;
        if (kind === 'group') return ((await getGroups()).find(g => g && g.id === id) || {}).name || id;
        if (kind === 'policy') return ((await netbirdGet(`/api/policies/${encodeURIComponent(id)}`)) || {}).name || id;
        if (kind === 'posture') return ((await netbirdGet(`/api/posture-checks/${encodeURIComponent(id)}`)) || {}).name || id;
    } catch { /* fall through to the raw id */ }
    return id;
}

// nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage -- CSRF is mitigated without csurf: login uses express-openid-connect with a SameSite=Lax, httpOnly session cookie (configured below), so cross-site requests don't carry it; the webhook authenticates with a Bearer token (no cookie); and the API is JSON-only and same-origin.
const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_AUTH_TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

// ─── SSO / OIDC (Azure AD) - optional, auto-enabled when configured ───
const AUTH_ENABLED = !!(
    process.env.OIDC_ISSUER_BASE_URL &&
    process.env.OIDC_CLIENT_ID &&
    process.env.OIDC_CLIENT_SECRET &&
    process.env.BASE_URL
);

// Which proxies may report the client address (X-Forwarded-*): TRUST_PROXY, in Express
// 'trust proxy' syntax. Default: none, so req.ip is the TCP peer and a client can't spoof it
// with a header (the per-IP rate limits and the failed-token throttle key on it). Behind a
// reverse proxy, set it to that proxy's address or CIDR - see lib/rate-limit.js.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
// 1mb is plenty for every route EXCEPT the settings restore, which also carries the app-config
// TABLES (automations / blocklist could push past 1mb) and gets its own 10mb parser on the route.
const jsonBody1mb = express.json({ limit: '1mb' });
// /api/settings-import carries the config TABLES (10mb parser on the route). /api/internal-backup/upload
// is RAW encrypted binary (express.raw on the route) - both bypass the global 1mb json wrapper.
const BODY_PARSER_EXEMPT = new Set(['/api/settings-import', '/api/internal-backup/upload']);
app.use((req, res, next) => (BODY_PARSER_EXEMPT.has(req.path) ? next() : jsonBody1mb(req, res, next)));

// ─── Security headers (hand-rolled; no CSP on /api-docs - Swagger UI needs inline bits) ───
const HSTS_ON = String(process.env.BASE_URL || '').startsWith('https://');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (HSTS_ON) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    if (!req.path.startsWith('/api-docs')) {
        // style-src allows inline because React components use style={} attributes.
        // Google Fonts (Inter) is the one allowed external origin pair. connect-src also
        // allows the NetBird management + signal hosts so the Troubleshoot page's
        // browser-side reachability checks (no-cors fetch) aren't killed by our own CSP.
        const dh = diagHosts();
        res.setHeader('Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            + `img-src 'self' data:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://${dh.management} https://${dh.signal}; `
            + "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    next();
});

// Constant-time string compare for secrets (timing-safe even on length mismatch).
function safeEqual(a, b) {
    const ab = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Brute-force guard for the PUBLIC endpoints: only FAILED auth attempts count (legit
// webhook bursts are never throttled), per client IP, fixed window. In-memory - fine
// for the single-instance deployment this app targets.
const _authFails = new Map(); // ip → { count, reset }
function tooManyAuthFails(ip) {
    const now = Date.now();
    const e = _authFails.get(ip);
    return !!(e && now < e.reset && e.count >= 20);
}
function noteAuthFail(ip) {
    const now = Date.now();
    let e = _authFails.get(ip);
    if (!e || now >= e.reset) { e = { count: 0, reset: now + 10 * 60 * 1000 }; _authFails.set(ip, e); }
    e.count++;
    // Cap the map so a spoofed-IP flood can't grow memory unbounded.
    if (_authFails.size > 10000) {
        for (const [k, v] of _authFails) { if (now >= v.reset) _authFails.delete(k); }
        if (_authFails.size > 10000) _authFails.clear();
    }
}

// Each tenant's incoming webhook carries a UNIQUE link: the tenant id in the URL path
// (/api/webhook/t/<id> and /api/integrations/netbird-notifications/t/<id>); the main account uses
// the plain paths (/api/webhook, /api/integrations/netbird-notifications). Resolve + validate that
// account id: '' (no param) is always main; a non-empty id must be a real active tenant (else 404).
async function resolveWebhookAccount(acct) {
    const id = String(acct || '').trim();
    if (!id) return '';
    const ids = await listActiveTenantIds().catch(() => ['']); // includes '' + every active tenant
    return ids.includes(id) ? id : null; // null → unknown tenant
}

// Constant-time Bearer check against the account's expected token (empty = open - no auth required).
// Returns true when authenticated; on failure it sends the response itself and returns false. Only
// FAILED attempts count toward the per-IP throttle (legit webhook bursts are never throttled).
function checkWebhookAuth(req, res, expected) {
    if (!expected) return true;
    if (tooManyAuthFails(req.ip)) { res.status(429).json({ error: 'Too many failed attempts - try again later' }); return false; }
    const authHeader = req.headers['authorization'];
    if (!authHeader) { noteAuthFail(req.ip); res.status(401).json({ error: 'Missing Authorization header' }); return false; }
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!safeEqual(token, expected)) { noteAuthFail(req.ip); res.status(403).json({ error: 'Invalid token' }); return false; }
    return true;
}

// ────────────── Traffic Noise Filter (DB-backed; managed in Settings) ──────────────
// isNoiseTraffic (live payload) and eventMatchesFilters (stored row) moved into lib/events.js and
// are imported above: the opt-in Traffic Events API pull in db.js must drop exactly the same
// traffic as this webhook receiver, and db.js can never require server.js. One implementation.

// Admin events: numeric ID (or string of digits). Traffic: UUID string.
function isAdminEvent(payload) {
    const id = payload.ID;
    if (typeof id === 'number') return true;
    if (typeof id === 'string' && /^\d+$/.test(id)) return true;
    return false;
}

// ══════════════ PUBLIC ROUTES (no login) ══════════════

// ────────────── NetBird Notifications Webhook ──────────────
// NetBird's account notifications (dashboard → Settings → Notifications → Webhook):
// routing peer disconnected/deleted, pending approvals, IdP/EDR sync token expiry.
// Point NetBird at <app>/api/integrations/netbird-notifications (main) or …/t/<tenantId> (a
// managed tenant), with that account's own Bearer token. Stored + forwarded to the Telegram
// alerts topic; the Troubleshoot page and the dashboard surface the still-relevant ones.
async function notifReceiver(req, res) {
    let acct;
    try { acct = await resolveWebhookAccount(req.params.acct); } catch { acct = null; }
    if (acct === null) return res.status(404).json({ error: 'Unknown tenant' });
    // Auth + ingest both run in the resolved account so the token read and the stored rows match.
    const run = (fn) => acct ? runWithTenant(acct, fn) : fn();
    try {
        const expected = await run(() => getNotifWebhookToken());
        // Tenants are STRICT: no configured token = no ingestion (an open tenant receiver would
        // accept forged notices from anyone who learns the tenant id). Main keeps the legacy
        // optional-auth behavior for backward compatibility.
        if (acct && !expected) return res.status(403).json({ error: 'No notifications webhook token configured for this tenant' });
        if (!checkWebhookAuth(req, res, expected)) return; // response already sent
        await run(async () => { res.json(await ingestNbNotification(req.body || {})); });
    } catch (err) {
        console.error('Error ingesting NetBird notification:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
}
app.post('/api/integrations/netbird-notifications', notifReceiver);
app.post('/api/integrations/netbird-notifications/t/:acct', notifReceiver);

// ────────────── Webhook Endpoint ──────────────
// The main account posts to /api/webhook; a managed tenant posts to /api/webhook/t/<tenantId>.
// The id in the URL selects the account: auth uses THAT account's token and the whole body runs
// inside runWithTenant so addEvent/addAdminEvent/ensureUsersFresh stamp + refresh the right one.
async function webhookReceiver(req, res) {
    let acct;
    try { acct = await resolveWebhookAccount(req.params.acct); } catch { acct = null; }
    if (acct === null) return res.status(404).json({ error: 'Unknown tenant' });
    const run = (fn) => acct ? runWithTenant(acct, fn) : fn();
    const handle = async () => {
        const payload = req.body;

        if (!payload || payload.ID === undefined || payload.ID === null) {
            return res.status(400).json({ error: 'Invalid payload: missing ID field' });
        }

        if (isAdminEvent(payload)) {
            await addAdminEvent(payload);
            // Keep the users cache warm so initiator_id resolves to a name/email
            ensureUsersFresh().catch(err => console.error('User refresh error:', err.message));
            console.log(`[${new Date().toISOString()}] Admin event received: ${payload.ID} (${payload.Message})`);
            return res.status(200).json({ status: 'ok', id: payload.ID, admin: true });
        }

        // Filter out broadcast/keepalive noise + user-defined rules
        if (await isNoiseTraffic(payload)) {
            return res.status(200).json({ status: 'ok', filtered: true });
        }

        await addEvent(payload);

        // Keep the users cache warm so user_id resolves to a name/email
        ensureUsersFresh().catch(err => console.error('User refresh error:', err.message));

        console.log(`[${new Date().toISOString()}] Event received: ${payload.ID} (${payload.Message})`);
        res.status(200).json({ status: 'ok', id: payload.ID });
    };
    try {
        const expected = await run(() => getWebhookToken());
        // Tenants are STRICT: no token = no ingestion (see notifReceiver). Main keeps legacy optional auth.
        if (acct && !expected) return res.status(403).json({ error: 'No webhook token configured for this tenant' });
        if (!checkWebhookAuth(req, res, expected)) return; // response already sent
        await run(handle);
    } catch (err) {
        console.error('Error processing webhook:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
}
app.post('/api/webhook', webhookReceiver);
app.post('/api/webhook/t/:acct', webhookReceiver);

// Health check (kept public for uptime probes)
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Telegram webhook - receives inline-button presses (callback_query). Public (Telegram can't
// log in), but authenticated by the secret token Telegram echoes in a header, and each press is
// re-checked against the approver allow-list inside handleTelegramCallback.
app.post('/api/integrations/telegram/callback', async (req, res) => {
    try {
        const secret = getTelegramWebhookSecret();
        if (secret) {
            if (tooManyAuthFails(req.ip)) return res.status(429).json({ error: 'too many attempts' });
            if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'], secret)) {
                noteAuthFail(req.ip);
                return res.status(403).json({ error: 'forbidden' });
            }
        }
        await handleTelegramCallback(req.body || {});
    } catch (e) {
        console.error('Telegram callback error:', e.message);
    }
    res.status(200).json({ ok: true });
});

// ══════════════ RATE LIMITS + AUTH GATE - everything below is rate limited and requires login (when configured) ══════════════
// The routes above (webhook receivers, health probe, Telegram callback) are registered BEFORE
// every limiter, so they are never rate limited: the receivers must accept NetBird's and
// Telegram's event volume and are protected by their tokens plus the failed-token throttle.
const authLimiter = rateLimit(limiterOptions('auth'));
const apiLimiter = rateLimit(limiterOptions('api'));
const spaLimiter = rateLimit(limiterOptions('spa', { assetsDir: path.join(__dirname, 'public', 'assets') }));
// How often a failed OIDC callback restarts the login before it stops (see the error handler).
const MAX_LOGIN_RETRIES = 3;

if (AUTH_ENABLED) {
    // Per client IP, before the OIDC middleware below handles /callback and /logout itself.
    app.use(['/login', '/callback', '/logout'], authLimiter);
    app.use(auth({
        // Identity only here: login is enforced by requiresAuth() below, after the rate limiters
        // (they key on the signed-in user, which this middleware resolves).
        authRequired: false,
        idpLogout: true,
        auth0Logout: false,
        issuerBaseURL: process.env.OIDC_ISSUER_BASE_URL,
        baseURL: process.env.BASE_URL,
        clientID: process.env.OIDC_CLIENT_ID,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
        // Explicit hardening: SameSite=Lax means the session cookie is NOT sent on cross-site
        // requests, which blocks CSRF on the cookie-authenticated API. httpOnly keeps it out of JS.
        // These durations are HARD CEILINGS only - the effective (shorter) idle/absolute limits
        // are configured in-app (Settings → Security) and enforced by the middleware below.
        session: {
            rolling: true,
            rollingDuration: 24 * 3600,
            absoluteDuration: 7 * 24 * 3600,
            cookie: { httpOnly: true, sameSite: 'Lax' },
        },
        authorizationParams: {
            response_type: 'code',
            scope: 'openid profile email',
        },
        // The built-in /login ignores query params and always returns to '/', which dumped
        // users on Home after every re-login. Disabled here; the custom route below honors
        // a (strictly validated) ?returnTo= so the SPA sends users back where they were.
        routes: { login: false },
        // The library's default state ({ returnTo }), plus the retry count of a login restarted by
        // the error handler after a failed callback (/login?retry=N), so the restarts are bounded.
        getLoginState: (req, options) => {
            const retry = req.path === '/login' ? Number.parseInt(req.query.retry, 10) : 0;
            return {
                returnTo: options.returnTo || req.originalUrl,
                ...(retry >= 1 && retry <= MAX_LOGIN_RETRIES ? { retry } : {}),
            };
        },
    }));
}

// Keyed by the signed-in user, else by client IP (always by IP without SSO).
app.use('/api', apiLimiter);
app.use(spaLimiter);

if (AUTH_ENABLED) {
    // Equivalent to auth()'s authRequired: true - every route below requires login. A visitor who is
    // not signed in is sent to login (HTML) or refused, and draws from the per-IP auth budget, so
    // these automatic login starts can't bypass the /login limit.
    app.use(authLimiter);
    app.use(requiresAuth());

    app.get('/login', (req, res) => {
        // Same-app PATHS only, checked against a fixed origin (BASE_URL's, never the Host or
        // X-Forwarded-* headers). Anything else falls back to Home (open-redirect guard).
        let origin = 'http://app.invalid';
        try { origin = new URL(process.env.BASE_URL).origin; } catch { /* keep the placeholder */ }
        const returnTo = safeReturnTo(req.query.returnTo, origin);
        // Already signed in (e.g. another tab finished logging in first)? Starting a NEW
        // OIDC transaction here would overwrite the auth_verification cookie of any login
        // still in flight elsewhere → PKCE mismatch (AADSTS501481) when it completes.
        // BUT only bounce back if the session also passes the in-app freshness caps below -
        // the API 401s a policy-expired session even though its cookie is still valid, so
        // bouncing one back would refresh-loop forever (SPA → 401 → /login → SPA → …).
        if (req.oidc && req.oidc.isAuthenticated() && sessionPassesCaps(req)) return res.redirect(returnTo);
        res.oidc.login({ returnTo });
    });

    // Session exposure limits (Settings → Security): a rolling IDLE timeout for everyone, an
    // ABSOLUTE cap for regular users and a stricter one for admins. Absolute age is measured by
    // the ID token's `iat` - stamped at the actual login and NOT extended by activity - so past
    // a cap a real re-authentication is required: the stale cookie is dropped and the API answers
    // 401, which the SPA turns into a redirect to /login. Idle time is tracked per login session
    // (oid+iat) in memory - a restart just restarts the idle clock, never extends a cap.
    const _sessionSeen = new Map(); // `${oid}|${iat}` → last-activity ms
    app.use('/api', async (req, res, next) => {
        try {
            if (!req.oidc || !req.oidc.isAuthenticated()) return next();
            const claims = req.oidc.idTokenClaims || {};
            const iat = claims.iat;
            if (!iat) return next();
            const sec = getSecurityConfig();
            const key = `${claims.oid || claims.sub || ''}|${iat}`;
            const nowMs = Date.now();
            const kill = (msg) => {
                _sessionSeen.delete(key);
                res.clearCookie('appSession');
                for (let i = 0; i < 5; i++) res.clearCookie(`appSession.${i}`); // chunked-cookie variants
                return res.status(401).json({ error: msg });
            };
            // Idle timeout (everyone).
            const last = _sessionSeen.get(key);
            if (last && sec.sessionIdleHours > 0 && nowMs - last > sec.sessionIdleHours * 3600_000) {
                return kill('Session expired after inactivity - please sign in again');
            }
            _sessionSeen.set(key, nowMs);
            if (_sessionSeen.size > 5000) { // prune long-gone sessions
                for (const [k, v] of _sessionSeen) if (nowMs - v > 7 * 86400_000) _sessionSeen.delete(k);
            }
            // Absolute caps.
            const ageHours = (nowMs / 1000 - Number(iat)) / 3600;
            if (sec.sessionMaxHours > 0 && ageHours > sec.sessionMaxHours) {
                return kill('Session expired - please sign in again');
            }
            if (sec.adminSessionMaxHours > 0 && ageHours > sec.adminSessionMaxHours) {
                const viewer = await getViewer(req); // only resolved once past the admin threshold
                if (viewer.isAdmin) return kill('Admin session expired - please sign in again');
            }
            return next();
        } catch (err) {
            console.error('Session-limit check error:', err.message);
            return next();
        }
    });

    // Would the /api middleware above still accept this session? Used by /login to decide
    // whether an already-authenticated visitor may skip re-authentication. Conservative on
    // the admin cap (role lookup is async) - past it, EVERYONE re-authenticates.
    function sessionPassesCaps(req) {
        try {
            const claims = (req.oidc && req.oidc.idTokenClaims) || {};
            if (!claims.iat) return true;
            const sec = getSecurityConfig();
            const key = `${claims.oid || claims.sub || ''}|${claims.iat}`;
            const last = _sessionSeen.get(key);
            if (last && sec.sessionIdleHours > 0 && Date.now() - last > sec.sessionIdleHours * 3600_000) return false;
            const ageHours = (Date.now() / 1000 - Number(claims.iat)) / 3600;
            if (sec.sessionMaxHours > 0 && ageHours > sec.sessionMaxHours) return false;
            if (sec.adminSessionMaxHours > 0 && ageHours > sec.adminSessionMaxHours) return false;
            return true;
        } catch { return false; }
    }
}

// ─── MSP tenant-mode middleware ───
// A request carrying X-Tenant-Account (sent by the frontend while "managing" an MSP tenant)
// runs its whole handler inside runWithTenant(): every NetBird API call transparently targets
// that tenant via ?account=, with per-tenant cache slots. Admin-only; the id must be a real
// active tenant. TENANT_CTX_PREFIXES are the routes allowed to run IN tenant context - live
// NetBird management PLUS the now per-tenant stateful features (blocklist, event filtering,
// system health, cleanup, access profiles, network default profiles, resource conflicts,
// reverse-proxy config + LOGS, tenant NB events). The two /propagate endpoints sit under the
// filter-rules/blocklist prefixes but are main-only - their handlers reject a tenant-context call.
// Everything else (grants, requests, automations, history, settings) stays main-only
// and is refused in tenant mode. Scheduler jobs never pass here → always the main account.
const TENANT_CTX_PREFIXES = [
    '/api/peers', '/api/users', '/api/groups', '/api/netbird-groups',
    // Setup-key creation is part of the Add Peer (server) flow - an MSP must be able to enroll
    // a CUSTOMER's server while managing that tenant, so it runs IN tenant context.
    '/api/setup-keys',
    '/api/networks', '/api/policies', '/api/posture-checks',
    '/api/blocklist', '/api/filter-rules', '/api/system-health',
    '/api/cleanup-scan', '/api/access-profiles',
    '/api/network-default-profiles', '/api/resource-conflicts',
    '/api/reverse-proxy-status', '/api/reverse-proxy-domains',
    '/api/reverse-proxy-services', '/api/reverse-proxy-target-options',
    '/api/reverse-proxy-logs',
    '/api/admin-logs', '/api/logs', '/api/stats', '/api/audit', '/api/ip-history',
    // Global search (⌘K) - every data source it reads (usage, grants, peers, groups, users,
    // profiles, rproxy) is context-aware, so in tenant mode it searches the tenant's data.
    '/api/search',
    // Manual refresh: in tenant context it force-refreshes the TENANT's peers/users mirrors
    // (ensure*Fresh run inside runWithTenant) - without this the Peers refresh button 403'd
    // silently in tenant mode and a just-enrolled peer only appeared after the 10-min TTL.
    '/api/refresh',
    // Now per-tenant app-owned features (U4): their CRUD + the grant modal's target search all
    // act on the tenant's OWN rows / usage data, so they run IN context. request-targets pulls
    // targets from the tenant's own usage; automations/grants/recurring/recert are tnt()-scoped.
    '/api/temporary-access', '/api/recurring-access', '/api/recertification',
    '/api/automations', '/api/request-targets',
    // Per-tenant app configuration exposed in Settings while managing a tenant: the tenant's own
    // incoming-webhook tokens + endpoint URL, its own event-retention window, and its own Telegram
    // (bot/chat/topics/events + test-send + create-topics - the tenant reads/writes ITS OWN config;
    // the tenantActivity mirror toggle is main-only and never returned in this context). The
    // main-only /telegram/webhook register + /telegram/callback receiver are guarded in-handler.
    // The rest of Settings (and all of security-config) stays main-only.
    '/api/integrations/webhook', '/api/data-retention', '/api/integrations/telegram',
    // Automatic EDR bypass rules are PER ACCOUNT (a tenant's rules act on the tenant's own
    // peers, evaluated inside that tenant's peers sync), so the config runs IN tenant context.
    '/api/edr-auto-bypass',
    // The Traffic Events API pull is a per-account opt-in (own setting, own cursor, own status),
    // configured on the same Settings page - so it runs IN tenant context like the tokens above.
    '/api/traffic-pull',
    // The Audit Events API pull is the same per-account opt-in for admin/audit events - same reason.
    '/api/audit-pull',
    // The LIVE NetBird account-settings editor edits the CURRENT account's own settings - so while
    // managing a tenant it must target THAT tenant's account (getAccountSettings + the accounts write
    // are ALS-aware). Distinct from /api/tenant-defaults (the main-only seed template for NEW tenants).
    '/api/netbird-settings',
    // Per-tenant dashboard + Troubleshoot reads: the billing tile, Known Issues and the whole
    // Troubleshoot page show the tenant's OWN data - getBillingSummary / getNbNotices and the
    // diagnose* helpers (device/target/address/whoami) are all tnt()-scoped or run their NetBird
    // reads through the active tenant context. The notices dismiss route shares this prefix by
    // design (admin dismiss of the tenant's own notice, scoped in dismissNbNotification).
    '/api/billing-summary', '/api/diagnostics',
];
// App-level reads that keep the UI alive in tenant mode - run WITHOUT tenant context.
// /api/ad-groups is the MSP's own Entra directory (shared across every tenant), so it resolves
// the same people regardless of the account being managed - a PLAIN (no-context) read.
// /api/tenant-defaults is main-account-only (the defaults profile the seeding/drift read). It is
// listed here so the tenant middleware passes it through to the route's explicit 400 guard rather
// than 403'ing it - the handler rejects any X-Tenant-Account with 400.
// /api/msp-digest is main-account-only (like /api/tenant-defaults): listed here so the middleware
// passes it through to the route's explicit 400 guard rather than 403'ing an X-Tenant-Account call.
// (/api/msp/fleet-report is already covered by the '/api/msp' prefix.)
// /api/locations is account-independent reference data (country/city lists for geo posture and
// proxy rules) - served without tenant context so the pickers work while managing a tenant.
const TENANT_PLAIN_PREFIXES = ['/api/msp', '/api/msp-digest', '/api/me', '/api/app-config', '/api/peer-tags', '/api/ad-groups', '/api/tenant-defaults', '/api/locations'];
let _tenantIds = { at: 0, ids: new Set() };
const _tenantOk = new Map(); // tenant id → last time the account switch was VERIFIED honored
app.use('/api', async (req, res, next) => {
    const tenantId = String(req.headers['x-tenant-account'] || '').trim();
    if (!tenantId) return next();
    const p = '/api' + req.path;
    const hit = (list) => list.some(x => p === x || p.startsWith(x + '/'));
    // Templates are GLOBAL resource-creation presets - read-only pass-through without ctx
    // (template WRITES stay blocked in tenant mode). Blocklist is now fully tenant-scoped and
    // runs IN context, so it is no longer skipped here.
    if (hit(TENANT_PLAIN_PREFIXES) || (req.method === 'GET' && hit(['/api/templates']))) return next();
    try {
        const viewer = await getViewer(req);
        // Tenant mode is open to admins and to non-admin holders of tenants.support.
        if (!viewer.isAdmin && !viewer.perms?.['tenants.support']) return res.status(403).json({ error: 'Forbidden - tenant mode is admin-only' });
        if (!hit(TENANT_CTX_PREFIXES)) return res.status(403).json({ error: 'Not available while managing a tenant' });
        // Support elevation: a non-admin tenants.support holder operates as admin WITHIN this
        // validated in-context request only. The flag is set ONLY after the allowlist check passes,
        // so it never covers TENANT_PLAIN_PREFIXES (e.g. /api/msp CRUD) or a headerless request -
        // getViewer returns an elevated per-request copy that keeps the real identity for audits.
        if (!viewer.isAdmin) req.tenantSupportAdmin = true;
        // Validate against the SWITCHER list (the official dashboard's own switch source) plus
        // the tenants list (60s cache) - a stale/foreign id is refused. Any linked tenant is
        // manageable - including pending-verification ones; only 'invited' is not.
        if (Date.now() - _tenantIds.at > 60_000) {
            const [sw, list] = await Promise.all([
                listMspSwitcher().catch(() => []),
                listMspTenants({ withUsage: false }).catch(() => []),
            ]);
            const ids = new Set();
            for (const t of sw) { ids.add(t.id); if (t.accountId) ids.add(t.accountId); }
            for (const t of list) if (String(t.status).toLowerCase() !== 'invited') ids.add(t.id);
            _tenantIds = { at: Date.now(), ids };
        }
        if (!_tenantIds.ids.has(tenantId)) return res.status(403).json({ error: 'Unknown or inactive tenant' });
        // NetBird may silently IGNORE ?account= (e.g. the token's service user has no
        // permission group on the tenant) and answer with MAIN-account data - which would
        // render your own network under a tenant banner. Verify the switch is actually
        // honored once per tenant (10-min cache): the account answering inside the tenant
        // context must differ from the main account.
        if ((_tenantOk.get(tenantId) || 0) < Date.now() - 10 * 60_000) {
            const [tenantAcc, mainAcc] = await Promise.all([
                runWithTenant(tenantId, () => netbirdGet('/api/accounts')).catch(() => null),
                netbirdGet('/api/accounts').catch(() => null),
            ]);
            const gotId = (Array.isArray(tenantAcc) && tenantAcc[0] && String(tenantAcc[0].id || '')) || '';
            const mainId = (Array.isArray(mainAcc) && mainAcc[0] && String(mainAcc[0].id || '')) || '';
            if (!gotId || gotId === mainId) {
                return res.status(502).json({
                    error: 'NetBird did not switch to the tenant account - the main API token has no access to this tenant (service users cannot join permission groups). Set a per-tenant API token: switch into the tenant in the official dashboard, create a service user + access token there, and save it on the tenant row (key icon) in the Tenants page.',
                });
            }
            _tenantOk.set(tenantId, Date.now());
        }
        return runWithTenant(tenantId, () => next());
    } catch (err) {
        console.error('Tenant middleware error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Resolve the current viewer (logged-in user) → identity + role.
// Without SSO configured, everyone is treated as an admin (open access, legacy behavior).
async function getViewer(req) {
    // Support elevation: req.tenantSupportAdmin is set by the tenant middleware ONLY on an
    // allowlisted in-context request by a non-admin tenants.support holder. It grants admin
    // rights WITHIN that request without polluting the cached real viewer - identity fields
    // (oid/user_id/name/email) stay intact so audits record the real user. The copy is fresh
    // per call, so a shared/cached viewer is never mutated.
    const elevate = (v) => (req.tenantSupportAdmin && v && !v.isAdmin) ? { ...v, isAdmin: true } : v;
    if (req._viewer) return elevate(req._viewer);
    if (!AUTH_ENABLED) {
        req._viewer = { authEnabled: false, isAdmin: true, canApprove: true, oid: null, user_id: null, name: '', email: '', role: '', groups: [], perms: resolveFeaturePerms({ isAdmin: true }) };
        return elevate(req._viewer);
    }
    const claims = (req.oidc && req.oidc.user) || {};
    const oid = claims.oid || claims.sub || '';
    const email = claims.email || claims.preferred_username || claims.upn || '';
    await Promise.all([ensureUsersFresh().catch(() => { }), ensurePeersFresh().catch(() => { })]);
    const v = await resolveViewer(oid, email);
    const role = v ? (v.role || '') : '';
    // AD group membership (Microsoft Graph) - admin if in the configured admin group
    const adGroups = await fetchUserGroups(oid).catch(() => []);
    const isAdmin = role === 'owner' || role === 'admin' || (!!ADMIN_GROUP_ID && adGroups.includes(ADMIN_GROUP_ID));

    // Groups used for network-edit grants AND approver / auto-approval matching. Grants and rules
    // are stored as the bare group id (Azure AD object id / native NetBird group id). We collect
    // the viewer's group memberships from every available source and also add each id's
    // "…|<suffix>" form, so a match works regardless of which id shape was stored:
    //   1. Microsoft Graph transitive memberships (if consented/available)
    //   2. their NetBird user.auto_groups (IdP-synced groups)
    //   3. groups their PEERS belong to (native groups like a Support Department)
    const netbirdGroups = (v && v.auto_groups) || [];
    const peerGroups = await getUserPeerGroupIds(v ? v.user_id : null, oid).catch(() => []);
    const allNb = [...netbirdGroups, ...peerGroups];
    const groups = [...new Set([
        ...adGroups,
        ...allNb,
        ...allNb.map(g => String(g).split('|').pop()),
    ].filter(Boolean))];

    // Approvers can approve/deny access requests WITHOUT being admins. Match the full group set
    // (same as the picker in Settings → Approvals) so native NetBird groups work, not just Graph.
    // A time-boxed DELEGATION (Settings → Approvals → Delegation) also grants approval rights
    // while its date window is active - for covering an approver's vacation.
    const canApprove = isAdmin || getApproverGroupIds().some(g => groups.includes(g))
        || await isActiveDelegate({ oid, userId: v ? v.user_id : '', email });

    req._viewer = {
        authEnabled: true,
        isAdmin,
        canApprove,
        role,
        oid,
        user_id: v ? v.user_id : null,
        name: (v && v.name) || claims.name || email,
        email: (v && v.email) || email,
        groups,
        adGroups,
        netbirdGroups,
        peerGroups,
        // Fine-grained feature permissions (admins get everything).
        perms: resolveFeaturePerms({ isAdmin, userId: v ? v.user_id : null, oid, email: (v && v.email) || email, groups }),
    };
    return elevate(req._viewer);
}

// Middleware: admins, or holders of the given feature permission (Settings → Permissions).
function requirePerm(perm) {
    return async (req, res, next) => {
        try {
            const viewer = await getViewer(req);
            if (viewer.isAdmin || (viewer.perms && viewer.perms[perm])) return next();
            return res.status(403).json({ error: 'Forbidden' });
        } catch (err) {
            console.error('Authorization error:', err.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    };
}

// Middleware: only admins (NetBird owner/admin, or AD admin group) may proceed
async function requireAdmin(req, res, next) {
    try {
        const viewer = await getViewer(req);
        if (!viewer.isAdmin) return res.status(403).json({ error: 'Forbidden - admin access required' });
        next();
    } catch (err) {
        console.error('Authorization error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Middleware: admins OR designated approvers (Entra approver group) - for handling access requests.
async function requireApprover(req, res, next) {
    try {
        const viewer = await getViewer(req);
        if (!viewer.canApprove) return res.status(403).json({ error: 'Forbidden - approver access required' });
        next();
    } catch (err) {
        console.error('Authorization error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// May this viewer scan/delete stored events? Admin AND on the EVENT_PURGE_ADMINS allow-list.
// Open mode (no SSO) is fully unauthenticated/admin, so it's allowed there too.
function canPurgeEvents(v) {
    if (!v.authEnabled) return true;
    const email = String(v.email || '').toLowerCase();
    return !!(v.isAdmin && email && EVENT_PURGE_ADMINS.includes(email));
}

async function requirePurgeAdmin(req, res, next) {
    try {
        const v = await getViewer(req);
        if (!canPurgeEvents(v)) return res.status(403).json({ error: 'Forbidden - not authorized to purge events' });
        next();
    } catch (err) {
        console.error('Authorization error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Does the viewer belong to a granted group? `needEdit` requires an 'edit' grant;
// otherwise any grant ('edit' or 'view') counts. Grants are [{ id, access }].
function hasGrant(viewer, networkId, grants, needEdit) {
    const granted = (grants && grants[networkId]) || [];
    const mine = new Set(viewer.groups || []);
    // Match either the stored id directly or its "…|<oid>" suffix (both sides normalized).
    return granted.some(g => {
        if (needEdit && g.access !== 'edit') return false;
        // 'source' rows are grantable-as-policy-source ONLY - they confer no view/edit.
        if (g.access === 'source') return false;
        return mine.has(g.id) || mine.has(String(g.id).split('|').pop());
    });
}

// Can this viewer edit a network? Admins → all; others → if one of their AD groups has
// an 'edit' grant.
// The 'networks.manage' feature permission = admin-grade access to ALL networks (list, edit
// resources/routers, create/rename/delete networks) - without any other admin rights.
function managesNetworks(viewer) {
    return !!(viewer && viewer.perms && viewer.perms['networks.manage']);
}
function canEditNetwork(viewer, networkId, grants) {
    return viewer.isAdmin || managesNetworks(viewer) || hasGrant(viewer, networkId, grants, true);
}

// Can this viewer view a network (read-only or better)? Admins → all; others → any grant.
function canViewNetwork(viewer, networkId, grants) {
    return viewer.isAdmin || managesNetworks(viewer) || hasGrant(viewer, networkId, grants, false);
}

// App version - single source of truth is the project-root VERSION file, read by the
// backend at runtime (NOT bundled into the frontend), so a version bump needs no rebuild.
// Candidates cover dev (root is one level up) and Docker (VERSION copied beside server.js).
function readVersion() {
    const candidates = [
        path.join(__dirname, '..', 'VERSION'), // project root in dev
        path.join(__dirname, 'VERSION'),        // copied beside server.js in Docker
    ];
    for (const p of candidates) {
        try {
            const v = fs.readFileSync(p, 'utf8').trim();
            if (v) return v;
        } catch { /* try next candidate */ }
    }
    return '';
}

app.get('/version.txt', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('text/plain').send(readVersion());
});

// ── Static frontend (gated by the auth middleware above) ──
// index.html must never be cached (so a rebuild is picked up immediately); the
// content-hashed /assets/* are safe to cache forever.
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    },
}));

// ════════════════ API ENDPOINTS ════════════════

// Current logged-in user (for the frontend to tailor access)
app.get('/api/me', async (req, res) => {
    try {
        const v = await getViewer(req);
        const body = { authEnabled: v.authEnabled, isAdmin: v.isAdmin, canApprove: !!v.canApprove, canPurge: canPurgeEvents(v), perms: v.perms || {}, user_id: v.user_id, name: v.name, email: v.email, role: v.role, netbirdConfigured: netbirdApiConfigured() };
        // /api/me?debug=1 → "why am I (not) an admin": the viewer's own identity + the AD groups
        // resolved from Microsoft Graph, so an ADMIN_GROUP_ID mismatch or a missing/unconsented
        // Graph permission is immediately obvious. Returns only the caller's own data.
        if (req.query.debug) {
            const ag = v.adGroups || [];
            body.diag = {
                oid: v.oid || null,
                role: v.role || '(none)',
                adminViaRole: v.role === 'owner' || v.role === 'admin',
                graphConfigured: !!(process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && process.env.OIDC_ISSUER_BASE_URL),
                adminGroupId: ADMIN_GROUP_ID || null,
                adGroupCount: ag.length,
                adGroups: ag,
                adminGroupMatched: !!(ADMIN_GROUP_ID && ag.includes(ADMIN_GROUP_ID)),
            };
            // Live Graph probe - surfaces the exact reason adGroups is empty (token failure,
            // 403 Authorization_RequestDenied, user-not-found, or genuinely 0 groups).
            body.graph = await graphGroupDiag(v.oid).catch((e) => ({ error: e.message }));
        }
        res.json(body);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// App display config (name + timezone) - readable by any user (sidebar/title/log
// times); only admins can change it. An empty timeZone means "use the browser's zone".
const DEFAULT_APP_NAME = 'NetBird Control';

const DATE_FORMATS = ['med', 'dmy_med', 'iso', 'dmy', 'mdy'];

function isValidTimeZone(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
    catch { return false; }
}

// Default name for a NEW per-resource policy. Placeholders: {resource} = the resource's
// name, {protocol} = TCP/UDP/ALL/ICMP. The admin can change the template in Settings.
const DEFAULT_POLICY_NAME_TEMPLATE = '{resource} Policy';

async function readAppConfig() {
    const [appName, timeZone, dateFormat, hour12, showResourceGroups, policyNameTemplate, policyNameTemplateShared, proxyDefaultDomain] = await Promise.all([
        getSetting('app_name'), getSetting('timezone'), getSetting('date_format'), getSetting('hour12'),
        getSetting('show_resource_groups'), getSetting('policy_name_template'), getSetting('policy_name_template_shared'), getSetting('proxy_default_domain'),
    ]);
    return {
        appName: appName || DEFAULT_APP_NAME,
        timeZone: timeZone || '',
        dateFormat: DATE_FORMATS.includes(dateFormat) ? dateFormat : 'med',
        hour12: hour12 !== 'false', // default 12-hour
        showResourceGroups: showResourceGroups !== 'false', // default shown
        policyNameTemplate: (policyNameTemplate || '').trim() || DEFAULT_POLICY_NAME_TEMPLATE,
        // Shared (multi-policy) resources keep per-policy identity - {service} = cleaned current name.
        policyNameTemplateShared: (policyNameTemplateShared || '').trim() || '{service}',
        proxyDefaultDomain: (proxyDefaultDomain || '').trim(), // '' = first available
    };
}

app.get('/api/app-config', async (req, res) => {
    try {
        res.json(await readAppConfig());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/app-config', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const before = await readAppConfig(); // snapshot, to record what actually changed (old → new)
        if (body.appName !== undefined) {
            const appName = String(body.appName || '').trim();
            if (!appName) return res.status(400).json({ error: 'Application name is required' });
            if (appName.length > 60) return res.status(400).json({ error: 'Application name is too long (max 60 characters)' });
            await setSetting('app_name', appName);
        }
        if (body.timeZone !== undefined) {
            const tz = String(body.timeZone || '').trim();
            if (tz && !isValidTimeZone(tz)) return res.status(400).json({ error: 'Invalid time zone' });
            await setSetting('timezone', tz); // '' = browser-local
        }
        if (body.dateFormat !== undefined) {
            const df = String(body.dateFormat || '').trim();
            if (!DATE_FORMATS.includes(df)) return res.status(400).json({ error: 'Invalid date format' });
            await setSetting('date_format', df);
        }
        if (body.hour12 !== undefined) {
            await setSetting('hour12', body.hour12 ? 'true' : 'false');
        }
        if (body.showResourceGroups !== undefined) {
            await setSetting('show_resource_groups', body.showResourceGroups ? 'true' : 'false');
        }
        if (body.policyNameTemplate !== undefined) {
            const tpl = String(body.policyNameTemplate || '').trim();
            if (tpl.length > 80) return res.status(400).json({ error: 'Policy name template is too long (max 80 characters)' });
            await setSetting('policy_name_template', tpl); // '' = default "{resource} Policy"
        }
        if (body.policyNameTemplateShared !== undefined) {
            const tpl = String(body.policyNameTemplateShared || '').trim();
            if (tpl.length > 80) return res.status(400).json({ error: 'Shared policy name template is too long (max 80 characters)' });
            await setSetting('policy_name_template_shared', tpl); // '' = default "{service}"
        }
        if (body.proxyDefaultDomain !== undefined) {
            const d = String(body.proxyDefaultDomain || '').trim().toLowerCase();
            if (d.length > 200) return res.status(400).json({ error: 'Domain is too long' });
            await setSetting('proxy_default_domain', d); // '' = first available
        }
        const after = await readAppConfig();
        const LBL = { appName: 'App name', timeZone: 'Time zone', dateFormat: 'Date format', hour12: 'Clock', showResourceGroups: 'Show resource groups', policyNameTemplate: 'Policy name template', policyNameTemplateShared: 'Shared policy name template', proxyDefaultDomain: 'Default proxy domain' };
        const show = (k, v) => k === 'hour12' ? (v ? '12-hour' : '24-hour')
            : k === 'showResourceGroups' ? (v ? 'on' : 'off')
                : k === 'timeZone' ? (v || 'Browser local') : String(v);
        const changes = Object.keys(LBL)
            .filter(k => String(before[k]) !== String(after[k]))
            .map(k => `${LBL[k]}: ${show(k, before[k])} → ${show(k, after[k])}`);
        audit(await getViewer(req), 'settings.app_config', '', changes.length ? { changes: changes.join(' · ') } : { fields: Object.keys(body).join(', ') });
        res.json(after);
    } catch (err) {
        console.error('Error saving app config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Manual "Refresh" - drop the NetBird-derived in-memory caches so the next reads re-pull
// fresh from the Management API. Open to any logged-in user (served data stays per-viewer
// filtered; this only busts a read cache, it never writes to NetBird).
// Global search (command palette) - networks, resources, peers + (admin) groups, users,
// policies. Results are permission-filtered to what the viewer may see.
app.get('/api/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        if (!q) return res.json({ results: [] });
        const viewer = await getViewer(req);
        const CAP = 6;
        const has = (...vals) => vals.some(v => String(v == null ? '' : v).toLowerCase().includes(q));
        const results = [];

        // Networks + resources + policies share one cached bundle (one set of API calls).
        const usage = await getUsageData().catch(() => null);
        const networks = (usage && usage.networks) || [];
        const grants = await getAllGrants().catch(() => ({}));
        const visibleNets = networks.filter(n => viewer.isAdmin || canViewNetwork(viewer, n.id, grants));

        let nc = 0;
        for (const net of visibleNets) {
            if (nc >= CAP) break;
            if (has(net.name, net.description)) { nc++; results.push({ type: 'network', id: net.id, title: net.name || net.id, subtitle: net.description || '', to: `/networks/${net.id}` }); }
        }

        // A resource's network = the visible network whose resources[] (ids) includes it.
        let rc = 0;
        for (const r of (usage && usage.resources) || []) {
            if (rc >= CAP) break;
            if (!has(r.name, r.address)) continue;
            const net = visibleNets.find(n => Array.isArray(n.resources) && n.resources.includes(r.id));
            if (!net) continue;
            rc++;
            results.push({ type: 'resource', id: r.id, title: r.name || r.address || r.id, subtitle: [r.address, net.name].filter(Boolean).join(' · '), to: `/networks/${net.id}` });
        }

        // Peers - permission-filtered to the viewer's own when not admin.
        const viewerOid = viewer.isAdmin ? null : (viewer.oid || '__no_match__');
        await ensurePeersFresh().catch(() => { });
        let pc = 0;
        for (const p of await getAllPeers(viewerOid).catch(() => [])) {
            if (pc >= CAP) break;
            if (has(p.name, p.ip, p.dns_label, p.hostname)) { pc++; results.push({ type: 'peer', id: p.id, title: p.name || p.ip || p.id, subtitle: [p.ip, p.os].filter(Boolean).join(' · '), to: `/peers/${p.id}` }); }
        }

        // Reverse-proxy services - for admins and holders of the proxy.manage permission.
        if (viewer.isAdmin || (viewer.perms && viewer.perms['proxy.manage'])) {
            let sc = 0;
            const rp = await getReverseProxyStatus().catch(() => null);
            for (const s of (rp && rp.services) || []) {
                if (sc >= CAP) break;
                if (!has(s.name, s.domain, s.cluster, ...(Array.isArray(s.targetList) ? s.targetList : []))) continue;
                sc++;
                results.push({
                    type: 'proxy', id: s.id, title: s.name || s.domain,
                    subtitle: [s.name && s.name !== s.domain ? s.domain : '', s.cluster].filter(Boolean).join(' · '),
                    to: '/reverse-proxy',
                });
            }
        }

        // Admin-only entities.
        if (viewer.isAdmin) {
            let gc = 0;
            for (const g of await getGroups().catch(() => [])) {
                if (gc >= CAP) break;
                if (has(g.name)) { gc++; results.push({ type: 'group', id: g.id, title: g.name || g.id, subtitle: '', to: `/groups/${encodeURIComponent(g.id)}` }); }
            }
            let uc = 0;
            for (const u of await getAllUsers().catch(() => [])) {
                if (uc >= CAP) break;
                if (has(u.name, u.email)) { uc++; results.push({ type: 'user', id: u.id, title: u.name || u.email || u.id, subtitle: u.email || '', to: `/users/${encodeURIComponent(u.id)}` }); }
            }
            let plc = 0;
            for (const pol of (usage && usage.policies) || []) {
                if (plc >= CAP) break;
                if (has(pol.name)) { plc++; results.push({ type: 'policy', id: pol.id || pol.name, title: pol.name || 'Policy', subtitle: '', to: '/policies' }); }
            }
            let apc = 0;
            for (const ap of await listAccessProfiles().catch(() => [])) {
                if (apc >= CAP) break;
                if (has(ap.name)) { apc++; results.push({ type: 'profile', id: String(ap.id), title: ap.name, subtitle: ap.shared ? 'Shared profile' : 'Direct profile', to: '/operations?tab=profiles' }); }
            }
        }

        res.json({ results });
    } catch (err) {
        console.error('Search error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/refresh', async (req, res) => {
    try {
        resetNbCaches();
        // Re-pull the DB-backed caches NOW (peers + users) so the data is already fresh the
        // moment the UI refetches - don't rely on a lazy re-pull. Live calls (networks, groups,
        // network detail) hit the NetBird API directly, so they're fresh on the next read.
        await Promise.allSettled([ensurePeersFresh(), ensureUsersFresh()]);
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// NetBird Management API connection - admin only. The GET never returns the token,
// only whether one is set, so it can't be read back out of the app.
app.get('/api/integrations/netbird', requireAdmin, async (req, res) => {
    try {
        res.json(getNbApiConfig());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/integrations/netbird', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        let url;
        if (body.url !== undefined) {
            url = String(body.url || '').trim();
            if (url) { try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid API URL' }); } }
        }
        const out = await setNbApiConfig({ url, token: body.token });
        // Never log the token itself - only that the connection settings changed.
        audit(await getViewer(req), 'settings.netbird_api', out.url, { urlChanged: url !== undefined, tokenChanged: !!(body.token && String(body.token).trim()) });
        res.json(out);
    } catch (err) {
        console.error('Error saving NetBird API config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Incoming-webhook auth - admin only. The endpoint NetBird posts events to, plus the
// Bearer token it must present. The GET never returns the token, only whether one is set.
// The endpoint URL carries the account: main → /api/webhook, a managed tenant → /api/webhook/t/<id>
// (currentTenantAccount() is set by the tenant middleware while managing a tenant). The frontend
// derives the notifications URL from this by swapping the /api/webhook path segment.
async function webhookConfigResponse() {
    const base = (process.env.BASE_URL || '').replace(/\/$/, '');
    const acct = currentTenantAccount() || '';
    const path = `/api/webhook${acct ? `/t/${encodeURIComponent(acct)}` : ''}`;
    return { ...(await getWebhookConfig()), endpoint: base ? base + path : path };
}

app.get('/api/integrations/webhook', requireAdmin, async (req, res) => {
    try {
        res.json(await webhookConfigResponse());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Live "is it actually configured in NetBird" status for the Webhook page badges. Reads NetBird's own
// integration state for the current account (main or managed tenant) - the honest on/off signal, not a
// guess from whether rows arrived. Kept separate from the fast DB-only config GET because these NetBird
// calls can be slow or fail on a plan without the feature; the UI shows it with its own loading state.
app.get('/api/integrations/webhook/nb-status', requireAdmin, async (req, res) => {
    try {
        res.json(await getNetbirdWebhookStatus());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/integrations/webhook', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        await setWebhookConfig({
            token: body.token, clear: body.clear === true,
            notifToken: body.notifToken, clearNotif: body.clearNotif === true,
        });
        // Never log the tokens themselves - only that auth was changed.
        audit(await getViewer(req), 'settings.webhook', '', {
            tokenChanged: !!(body.token && String(body.token).trim()), cleared: body.clear === true,
            notifTokenChanged: !!(body.notifToken && String(body.notifToken).trim()), notifCleared: body.clearNotif === true,
        });
        res.json(await webhookConfigResponse());
    } catch (err) {
        console.error('Error saving webhook config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Traffic Events API pull (per account; the alternative to webhook event streaming) ──
// GET returns config AND status together - the card shows one thing, so it fetches one thing.
app.get('/api/traffic-pull', requireAdmin, async (req, res) => {
    try {
        res.json(await getTrafficPullStatus());
    } catch (err) {
        console.error('Error loading traffic-pull config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/traffic-pull', requireAdmin, async (req, res) => {
    try {
        const enabled = !!(req.body && req.body.enabled);
        await setTrafficPullConfig({ enabled });
        audit(await getViewer(req), 'settings.traffic_pull', '', { enabled });
        // Enabling kicks ONE immediate sync so data shows up now instead of at the next 5-minute
        // tick. Fire-and-forget, pinned to the account being managed (the response must not wait
        // on a NetBird round-trip that may walk many pages).
        if (enabled) {
            const acct = currentTenantAccount();
            const run = acct ? () => runWithTenant(acct, syncTrafficEvents) : syncTrafficEvents;
            run().catch(e => console.error('[TrafficPull] initial sync error:', e.message));
        }
        res.json(await getTrafficPullStatus());
    } catch (err) {
        console.error('Error saving traffic-pull config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Audit Events API pull (per account; the alternative to webhook event streaming for admin events) ──
// GET returns config AND status together - the card shows one thing, so it fetches one thing.
app.get('/api/audit-pull', requireAdmin, async (req, res) => {
    try {
        res.json(await getAuditPullStatus());
    } catch (err) {
        console.error('Error loading audit-pull config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/audit-pull', requireAdmin, async (req, res) => {
    try {
        const enabled = !!(req.body && req.body.enabled);
        await setAuditPullConfig({ enabled });
        audit(await getViewer(req), 'settings.audit_pull', '', { enabled });
        // Enabling kicks ONE immediate sync so data shows up now instead of at the next 5-minute
        // tick. Fire-and-forget, pinned to the account being managed (the response must not wait
        // on a NetBird round-trip that may walk many pages).
        if (enabled) {
            const acct = currentTenantAccount();
            const run = acct ? () => runWithTenant(acct, syncAuditEvents) : syncAuditEvents;
            run().catch(e => console.error('[AuditPull] initial sync error:', e.message));
        }
        res.json(await getAuditPullStatus());
    } catch (err) {
        console.error('Error saving audit-pull config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// One-click: point NetBird's Account Notifications at our receiver for the CURRENT account.
// '/api/integrations/webhook' is tenant-allowlisted, so this runs IN the active account's context -
// it configures the main account or whichever tenant is being managed, using that account's own
// receiver URL. Always rotates the notifications ingest token (a stored token's plaintext can't be
// recovered), then creates or updates the account's single NetBird webhook channel with ALL event
// types. Response documents the rotation via `rotatedToken`.
app.post('/api/integrations/webhook/notifications-auto', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const base = (process.env.BASE_URL || '').replace(/\/$/, '');
        if (!base) return res.status(400).json({ error: 'BASE_URL is not set - it is required to build the notifications webhook URL.' });
        const acct = currentTenantAccount() || '';
        const url = base + `/api/integrations/netbird-notifications${acct ? `/t/${encodeURIComponent(acct)}` : ''}`;
        const out = await autoConfigureNbNotifications(url);
        audit(await getViewer(req), 'webhook.nbsetup', acct ? tenantNameOf(acct) : 'main account', { created: out.created, rotatedToken: out.rotatedToken });
        res.json(out);
    } catch (err) {
        console.error('Error auto-configuring NetBird notifications:', err.message);
        res.status(502).json({ error: err.message || 'Failed to configure NetBird notifications' });
    }
});

// One-click: point NetBird's Event Streaming (the Generic HTTP integration) at our activity-events
// receiver for the CURRENT account. Same tenant-allowlisted '/api/integrations/webhook' prefix, so it
// runs IN the active account's context (main or the managed tenant) and uses that account's own
// receiver URL. The events ingest token is rotated UNLESS the main account's token is env-managed
// (WEBHOOK_AUTH_TOKEN), in which case the env token is reused as-is - see autoConfigureNbEventStreaming;
// `rotatedToken` documents which happened. Bubbles NetBird's own error (e.g. a plan without event
// streaming) up as a 502 with the message.
app.post('/api/integrations/webhook/events-auto', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const base = (process.env.BASE_URL || '').replace(/\/$/, '');
        if (!base) return res.status(400).json({ error: 'BASE_URL is not set - it is required to build the events webhook URL.' });
        const acct = currentTenantAccount() || '';
        const url = base + `/api/webhook${acct ? `/t/${encodeURIComponent(acct)}` : ''}`;
        const out = await autoConfigureNbEventStreaming(url);
        audit(await getViewer(req), 'webhook.nbstream', acct ? tenantNameOf(acct) : 'main account', { created: out.created, rotatedToken: out.rotatedToken });
        res.json(out);
    } catch (err) {
        console.error('Error auto-configuring NetBird event streaming:', err.message);
        res.status(502).json({ error: err.message || 'Failed to configure NetBird event streaming' });
    }
});

// Telegram notifications - admin only. GET returns the config (bot token never included) plus
// the distinct NetBird activity types seen, for the event-selection checklist.
app.get('/api/integrations/telegram', requireAdmin, async (req, res) => {
    try {
        const eventTypes = await getAdminEventTypes().catch(() => []);
        res.json({ ...getTelegramConfig(), eventTypes });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/integrations/telegram', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        // account defaults (inside setTelegramConfig) to the acting account: main or the tenant
        // being managed. tenantActivity is honored only for main; a tenant PUT drops it.
        const out = await setTelegramConfig({ enabled: b.enabled, chatId: b.chatId, categories: b.categories, netbirdEvents: b.netbirdEvents, token: b.token, tenantActivity: b.tenantActivity });
        // The callback webhook (Approve/Deny button presses) is a MAIN-account feature - never
        // touch it from a tenant save.
        if (!currentTenantAccount()) {
            if (out.enabled && out.hasToken && process.env.BASE_URL) telegramSetWebhook(process.env.BASE_URL).catch(() => { });
            else if (!out.enabled) telegramDeleteWebhook().catch(() => { });
        }
        audit(await getViewer(req), 'settings.telegram', '', { enabled: !!out.enabled, tokenChanged: !!(b.token && String(b.token).trim()) });
        res.json(out);
    } catch (err) {
        console.error('Error saving Telegram config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Manually (re)register the Telegram webhook (for the "Register webhook" button in Settings).
app.post('/api/integrations/telegram/webhook', requireAdmin, async (req, res) => {
    try {
        // Operates on MAIN's callback webhook - never runs from a tenant context (the telegram
        // prefix is tenant-allowlisted for the config routes, so guard this sub-route explicitly).
        if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'Telegram webhook registration runs from the main account only' });
        if (!process.env.BASE_URL) return res.status(400).json({ error: 'BASE_URL is not set - it is required for the Telegram webhook.' });
        res.json(await telegramSetWebhook(process.env.BASE_URL));
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to register webhook' });
    }
});

// ─── MSP tenants (admin) - the NetBird Cloud MSP portal, mirrored in-app ───
// Availability: /api/integrations/msp answers with an activated MSP object only for an MSP
// parent account - everyone else gets { available: false } and the UI hides the feature.
// Read-only MSP endpoints the tenant switcher needs - open to admins and tenants.support
// holders. Every other /api/msp route (create/update/delete/token/provision) stays admin-only.
app.get('/api/msp/status', requirePerm('tenants.support'), async (req, res) => {
    try {
        res.json({ ...(await getMspStatus()), hasProvisioningToken: !!getMspProvisioningToken() });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// The MSP provisioning token (write-only): a USER token of an MSP admin, used ONLY to
// create each tenant's own service user + token. Empty = clear.
app.put('/api/msp/provisioning-token', requireAdmin, async (req, res) => {
    try {
        const out = await setMspProvisioningToken((req.body || {}).token);
        audit(await getViewer(req), 'settings.msp_provisioning', 'MSP provisioning token', { set: out.hasProvisioningToken });
        res.json(out);
    } catch (err) {
        console.error('Error saving provisioning token:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Provision (or rotate) the tenant's managed service user + token.
app.post('/api/msp/tenants/:id/provision', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await provisionTenantServiceUser(req.params.id);
        audit(await getViewer(req), 'tenant.provision', String(req.params.id), { serviceUser: out.serviceUser, expiresAt: out.expiresAt });
        res.json(out);
    } catch (err) {
        console.error('Error provisioning tenant service user:', err.message);
        res.status(502).json({ error: err.message || 'Failed to provision' });
    }
});

app.get('/api/msp/tenants', requirePerm('tenants.support'), async (req, res) => {
    try {
        res.json(await listMspTenants());
    } catch (err) {
        console.error('Error listing MSP tenants:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// The switchable accounts (the official switcher's own endpoint) - drives the app's
// tenant switcher; its item `id` is what goes into the account switch.
app.get('/api/msp/switcher', requirePerm('tenants.support'), async (req, res) => {
    try {
        res.json(await listMspSwitcher());
    } catch (err) {
        console.error('Error listing MSP switcher:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/msp/tenants', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const b = req.body || {};
        // Optional "Initial Setup" toggles from the Add Tenant modal (create only). Defaults match
        // today's behavior + notifications: seed/provision/notifications on, events off (Business plan).
        const setup = b.setup || {};
        // createMspTenant provisions the tenant's managed service user + token itself (awaited,
        // best-effort) BEFORE seeding, gated by setup.provision/setup.seed. The seed summary it returns
        // (rules/blocklist/retention/nbSettings copied) extends the audit; out.provisioned reports the
        // provision step (null = skipped, true/false = attempted).
        const out = await createMspTenant({ name: b.name, domain: b.domain, groups: b.groups }, setup);
        // Point NetBird at OUR receivers for the new tenant. Both run AFTER creation (they need the
        // tenant id + BASE_URL) inside runWithTenant so every NetBird call targets the tenant. Each is
        // its own try/catch, best-effort - a webhook failure must never fail creation. They depend on
        // the tenant's credentials: if provisioning was skipped/failed they fall back to the main token's
        // ?account= switch, which may not be honored - a failure there is reported, not fatal.
        const base = (process.env.BASE_URL || '').replace(/\/$/, '');
        // Account Notifications receiver (checked by default). null = not requested; bool = attempted.
        let notifications = null;
        if (setup.notifications !== false) {
            notifications = false;
            try {
                if (!base) throw new Error('BASE_URL is not set');
                const url = base + `/api/integrations/netbird-notifications/t/${encodeURIComponent(out.id)}`;
                await runWithTenant(out.id, () => autoConfigureNbNotifications(url));
                notifications = true;
            } catch (e) { console.error(`[MSP] auto-notifications -> ${out.id}:`, e.message); }
        }
        // Activity Events / event streaming (UNCHECKED by default - needs a Business plan). Only runs
        // when explicitly requested. null = not requested; bool = attempted.
        let events = null;
        if (setup.events === true) {
            events = false;
            try {
                if (!base) throw new Error('BASE_URL is not set');
                const url = base + `/api/webhook/t/${encodeURIComponent(out.id)}`;
                await runWithTenant(out.id, () => autoConfigureNbEventStreaming(url));
                events = true;
            } catch (e) { console.error(`[MSP] auto-events -> ${out.id}:`, e.message); }
        }
        // Compact setup summary for the response + audit: null = skipped/not requested, bool = attempted
        // result. seeded is null when "Sync Settings From Defaults" was unchecked, else true/false.
        const setupSummary = {
            provisioned: out.provisioned,
            seeded: setup.seed === false ? null : !!out.seeded,
            notifications,
            events,
        };
        audit(await getViewer(req), 'tenant.create', String(b.name || ''), { domain: String(b.domain || ''), ...(out.seeded ? { seeded: out.seeded } : {}), setup: setupSummary });
        res.json({ ...out, setup: setupSummary });
    } catch (err) {
        console.error('Error creating MSP tenant:', err.message);
        res.status(502).json({ error: err.message || 'Failed to create tenant' });
    }
});

app.put('/api/msp/tenants/:id', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const b = req.body || {};
        const out = await updateMspTenant(req.params.id, { name: b.name, groups: b.groups });
        audit(await getViewer(req), 'tenant.update', String(b.name || req.params.id), {});
        res.json(out);
    } catch (err) {
        console.error('Error updating MSP tenant:', err.message);
        res.status(502).json({ error: err.message || 'Failed to update tenant' });
    }
});

app.delete('/api/msp/tenants/:id', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await deleteMspTenant(req.params.id);
        audit(await getViewer(req), 'tenant.delete', String(req.params.id), {});
        res.json(out);
    } catch (err) {
        console.error('Error deleting MSP tenant:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete tenant' });
    }
});

// Per-tenant API token (write-only): a PAT created INSIDE the tenant account. NetBird's
// permission groups can't contain service users, so this is the reliable way to give the
// app tenant access. Empty token = clear.
app.put('/api/msp/tenants/:id/token', requireAdmin, async (req, res) => {
    try {
        const out = await setMspTenantToken(req.params.id, (req.body || {}).token);
        audit(await getViewer(req), 'tenant.token', String(req.params.id), { set: out.hasApiToken });
        res.json(out);
    } catch (err) {
        console.error('Error saving tenant token:', err.message);
        res.status(500).json({ error: err.message || 'Failed to save token' });
    }
});

// Domain ownership check - success activates the tenant; failure returns the TXT challenge.
app.post('/api/msp/tenants/:id/dns', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await verifyMspTenantDomain(req.params.id);
        if (out.verified) audit(await getViewer(req), 'tenant.verify', String(req.params.id), {});
        res.json(out);
    } catch (err) {
        console.error('Error verifying MSP tenant domain:', err.message);
        res.status(502).json({ error: err.message || 'Failed to verify domain' });
    }
});

app.get('/api/msp/tenants/:id/overview', requireAdmin, async (req, res) => {
    try {
        res.json(await getMspTenantOverview(req.params.id));
    } catch (err) {
        console.error('Error loading MSP tenant overview:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Plan tab: the billing plan catalog (main account only, read-only) ───
// The catalog belongs to the MSP's own billing context; /api/msp is a tenant-PLAIN prefix, so an
// X-Tenant-Account is refused here explicitly. Cached ~10 min in db.js.
app.get('/api/msp/billing-plans', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'Billing plans are read from the main account only' });
    try {
        res.json(await getMspBillingPlans());
    } catch (err) {
        console.error('Error loading MSP billing plans:', err.message);
        res.status(502).json({ error: err.message || 'Failed to load billing plans' });
    }
});

// ─── Subscribe ONE tenant to a paid plan (main account only) ───
// THIS CHARGES MONEY: the plan is billed to the MSP account. free/trial tenants get a POST (initial
// MSP subscription), everyone else a PUT - decided in db.js from the tenant's own subscription.
app.post('/api/msp/tenants/:id/subscription', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true) - subscribing would change billing.' });
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'Subscription changes run from the main account only' });
    try {
        const out = await setMspTenantSubscription(req.params.id, (req.body || {}).priceId);
        audit(await getViewer(req), 'tenant.plan', tenantNameOf(req.params.id), {
            plan: out.plan, tier: out.tier, priceId: String((req.body || {}).priceId || ''),
            previousTier: out.previousTier, method: out.method,
        });
        res.json(out.body);
    } catch (err) {
        console.error('Error changing tenant subscription:', err.message);
        res.status(502).json({ error: err.message || 'Failed to change the subscription plan' });
    }
});

// ─── Apply main's default config to ONE tenant (REPLACE semantics) - main account only ───
// Reseeds the tenant's filter rules + noise, blocklist, and retention from main. Refused in tenant
// context (the X-Tenant-Account header) - it must run against main's config as the source.
app.post('/api/msp/tenants/:id/apply-defaults', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'Applying defaults runs from the main account only' });
    try {
        const out = await seedTenantDefaults(req.params.id);
        audit(await getViewer(req), 'tenant.defaults', tenantNameOf(req.params.id), out);
        res.json(out);
    } catch (err) {
        console.error('Error applying tenant defaults:', err.message);
        res.status(500).json({ error: err.message || 'Failed to apply defaults' });
    }
});

// ─── Config drift of ONE tenant vs main (main account only, read-only) ───
// Content-wise comparison (never mutates). /api/msp is a tenant-PLAIN prefix, so this always runs in
// main context and the comparison SQL passes the tenant id explicitly.
app.get('/api/msp/tenants/:id/drift', requireAdmin, async (req, res) => {
    try {
        res.json(await computeTenantDrift(req.params.id));
    } catch (err) {
        console.error('Error computing tenant drift:', err.message);
        res.status(500).json({ error: err.message || 'Failed to compute drift' });
    }
});

// ─── Fleet Report (main account only, read-only) - a management snapshot across every tenant ───
// Built entirely from the app's own DB + settings (no per-tenant NetBird calls). /api/msp is a
// tenant-PLAIN prefix, so the middleware passes it through here where an X-Tenant-Account is refused.
app.get('/api/msp/fleet-report', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'The fleet report runs from the main account only' });
    try {
        res.json(await getFleetReport());
    } catch (err) {
        console.error('Error building fleet report:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Weekly MSP digest (main account only) - config + immediate Send Now ───
// Disabled by default (production kill switch). /api/msp-digest is a tenant-PLAIN prefix so the
// middleware passes it through to these explicit 400 guards.
app.get('/api/msp-digest', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'The MSP digest is managed from the main account only' });
    try {
        res.json(await getMspDigestConfig());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.put('/api/msp-digest', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'The MSP digest is managed from the main account only' });
    try {
        const cfg = await setMspDigestConfig(req.body || {});
        audit(await getViewer(req), 'settings.msp-digest', 'MSP Weekly Digest', {
            enabled: cfg.enabled ? `day ${cfg.day} @ ${cfg.hour}:00` : 'off',
            telegram: cfg.telegram ? 'on' : 'off',
            emails: cfg.emails.length,
        });
        res.json(cfg);
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save' });
    }
});
// Send the digest RIGHT NOW (does not require enabled; still stamps the daily gate so today's
// scheduled run won't duplicate it). Admin only, audited.
app.post('/api/msp-digest/send', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'The MSP digest is managed from the main account only' });
    try {
        const out = await sendMspDigest({ force: true });
        audit(await getViewer(req), 'msp-digest.send', '', out || {});
        res.json(out || { telegram: false, emails: 0 });
    } catch (err) {
        console.error('Error sending MSP digest:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Tenant Defaults profile (main account only) ───
// The EXPLICIT admin-defined reference that seeding/apply/drift read - curated in Settings → Tenant
// Defaults (MSP only), NOT "copy main's live config". An unset profile falls back to deriving main's
// live config. Runs from the main account only; /api/tenant-defaults is a tenant-PLAIN prefix so the
// middleware passes it through here, where an X-Tenant-Account header is refused with 400.
app.get('/api/tenant-defaults', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'Tenant defaults are managed from the main account only' });
    try {
        const profile = await getTenantDefaults();
        const mainCurrent = await deriveDefaultsFromMain(); // powers the "Load Current Main Values" button
        // mfaSupported: the cloud MFA service is not served by every NetBird API base - the UI
        // disables the MFA controls when it is unavailable instead of silently doing nothing.
        res.json({ configured: !!profile, profile: profile || null, mainCurrent, mfaSupported: await mfaSupported() });
    } catch (err) {
        console.error('Error loading tenant defaults:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/tenant-defaults', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'Tenant defaults are managed from the main account only' });
    try {
        const saved = await setTenantDefaults(req.body || {});
        const nb = saved.nb || {};
        audit(await getViewer(req), 'settings.tenant-defaults', 'Tenant Defaults', {
            nb: nb.enabled ? 'on' : 'off',
            retentionDays: saved.retentionDays,
            copyFilterRules: saved.copyFilterRules,
            copyBlocklist: saved.copyBlocklist,
        });
        res.json(saved);
    } catch (err) {
        console.error('Error saving tenant defaults:', err.message);
        res.status(400).json({ error: err.message || 'Invalid tenant defaults' });
    }
});

// ─── LIVE NetBird account settings (main OR managed tenant) ───
// Reads/writes the CURRENT account's ACTUAL NetBird settings via the ALS context: main in main mode,
// the managed tenant's own account in tenant mode (/api/netbird-settings is tenant-allowlisted). This
// is the account's REAL settings object - unlike Tenant Defaults, which is a stored template for NEW
// tenants. The infra fields (DNS domain / IP ranges) re-allocate peer IPs and are sent only when the
// live value actually changed (saveNetbirdSettings); MFA availability follows mfaSupported().
app.get('/api/netbird-settings', requireAdmin, async (req, res) => {
    try {
        res.json(await getNetbirdSettings());
    } catch (err) {
        console.error('Error loading NetBird settings:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/netbird-settings', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await saveNetbirdSettings((req.body || {}).nb || {});
        // audit() tags the tenant id automatically in tenant mode, so the log shows WHICH account changed.
        audit(await getViewer(req), 'settings.netbird_account', 'NetBird Settings', out.summary);
        res.json({ nb: out.nb, mfaSupported: out.mfaSupported });
    } catch (err) {
        console.error('Error saving NetBird settings:', err.message);
        res.status(err.status || 502).json({ error: err.message || 'Failed to save NetBird settings' });
    }
});

// ─── System Health (admin) - scheduler status, DB size, integrations, retention ───
// The root VERSION file is the source of truth (copied to /app/VERSION in Docker;
// one level up when running from backend/ locally). version.txt is a legacy fallback.
const APP_VERSION = (() => {
    for (const p of [path.join(__dirname, 'VERSION'), path.join(__dirname, '..', 'VERSION'), path.join(__dirname, 'version.txt')]) {
        try { const v = fs.readFileSync(p, 'utf8').trim(); if (v) return v; } catch { /* try next */ }
    }
    return '';
})();
app.get('/api/system-health', requireAdmin, async (req, res) => {
    try {
        const stats = await getSystemStats();
        res.json({
            version: APP_VERSION,
            node: process.version,
            uptimeSec: Math.floor((Date.now() - _bootAt) / 1000),
            authEnabled: AUTH_ENABLED,
            schedulers: _schedHealth,
            integrations: {
                netbird: stats.netbird,
                telegram: { enabled: !!getTelegramConfig().enabled, hasToken: !!getTelegramConfig().hasToken, queue: getTelegramQueueStats() },
                smtp: { enabled: !!getSmtpConfig().enabled },
            },
            db: stats.db,
            activeGrants: stats.activeGrants,
            pendingRequests: stats.pendingRequests,
            scheduledBypasses: stats.scheduledBypasses,
            bypassedPeers: stats.bypassedPeers,
            retention: stats.retention,
        });
    } catch (err) {
        console.error('Error building system health:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Security & alerts settings (session limits, escalation, review digest, anomaly alerts) ───
app.get('/api/security-config', requireAdmin, async (req, res) => {
    try {
        res.json(getSecurityConfig());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
// Send the weekly review digest RIGHT NOW (skips the schedule; still stamps the daily
// marker so today's scheduled send won't duplicate it). Admin only, audited.
app.post('/api/security-config/send-digest', requireAdmin, async (req, res) => {
    try {
        const out = await sendAccessReviewDigest({ force: true });
        audit(await getViewer(req), 'review.send', '', out || {});
        res.json(out || { telegram: false, emails: 0 });
    } catch (err) {
        console.error('Error sending review digest:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/security-config', requireAdmin, async (req, res) => {
    try {
        const out = await setSecurityConfig(req.body || {});
        audit(await getViewer(req), 'settings.security', '', {
            sessions: `${out.sessionIdleHours}h idle / ${out.sessionMaxHours}h user / ${out.adminSessionMaxHours}h admin`,
            escalation: `${out.requestReminderMinutes}m reminder / ${out.requestExpireHours}h expiry`,
            review: out.reviewEnabled ? `day ${out.reviewDay} @ ${out.reviewHour}:00` : 'off',
            anomalies: out.anomalyEnabled ? 'on' : 'off',
            jobAlerts: out.schedAlertsEnabled ? 'on' : 'off',
            retention: out.retentionDays ? `${out.retentionDays} days` : 'off',
        });
        res.json(out);
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save' });
    }
});

// ─── Automatic EDR bypass by OS (admin) - per account ───
// Devices that can never run the EDR agent (phones, Linux servers) otherwise sit compliance-
// blocked until someone bypasses each one by hand. These rules do it automatically, per OS,
// using the same mechanism and bookkeeping as a manual bypass. Off by default.
// NETBIRD_READONLY does NOT block writing the CONFIG (it is app-side state); the apply step
// itself is a NetBird write and is skipped in read-only mode.
app.get('/api/edr-auto-bypass', requireAdmin, async (req, res) => {
    try {
        res.json(await getEdrAutoBypassConfig());
    } catch (err) {
        console.error('Error loading the automatic EDR bypass config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/edr-auto-bypass', requireAdmin, async (req, res) => {
    try {
        const out = await setEdrAutoBypassConfig(req.body || {});
        const summary = out.rules.length
            ? out.rules.map(r => `${EDR_OS_LABELS[r.os] || r.os}: ${r.durationDays ? `${r.durationDays}d` : 'unlimited'}`).join(', ')
            : 'no rules';
        audit(await getViewer(req), 'settings.edr_auto_bypass', '', {
            state: out.enabled ? 'on' : 'off',
            rules: summary,
        });
        res.json(out);
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save' });
    }
});

// ─── Data Retention (admin) - per-account event-retention window ───
// A tiny, tenant-aware slice of retention that is safe to expose while managing a tenant (the
// rest of security-config stays main-only). Main reads/writes the shared security blob's
// retentionDays (unchanged); a tenant reads/writes its own retention_days:<tenant> setting.
app.get('/api/data-retention', requireAdmin, async (req, res) => {
    try {
        res.json(await getRetentionStatus());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/data-retention', requireAdmin, async (req, res) => {
    try {
        const days = await setRetentionDays((req.body || {}).days);
        audit(await getViewer(req), 'settings.retention', '', { retention: days ? `${days} days` : 'off' });
        res.json(await getRetentionStatus());
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save' });
    }
});

// ─── Access recertification (admin) - periodic keep/revoke attestation of standing access ───
app.get('/api/recertification', requireAdmin, async (req, res) => {
    try {
        res.json(await getRecertification());
    } catch (err) {
        console.error('Error loading recertification:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// Open a round on demand (outside the schedule) - e.g. before an audit.
app.post('/api/recertification/start', requireAdmin, async (req, res) => {
    try {
        const state = await getRecertification();
        if (state.open) return res.status(400).json({ error: 'a review round is already open' });
        const viewer = await getViewer(req);
        res.json(await openRecertRound(viewer.name || viewer.email || 'admin'));
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to start review' });
    }
});
// Completed-round history + a single round's full report (who decided what, when).
app.get('/api/recertification/rounds', requireAdmin, async (req, res) => {
    try {
        res.json(await listRecertRounds());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.get('/api/recertification/rounds/:id', requireAdmin, async (req, res) => {
    try {
        res.json(await getRecertRound(parseInt(req.params.id, 10)));
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to load round' });
    }
});

// Cancel the open round (discards its items) so a fresh snapshot can be started.
app.post('/api/recertification/cancel', requireAdmin, async (req, res) => {
    try {
        res.json(await cancelRecertRound(await getViewer(req)));
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to cancel' });
    }
});
app.post('/api/recertification/items/:id/:decision', requireAdmin, async (req, res) => {
    try {
        const decision = req.params.decision === 'revoke' ? 'revoke' : req.params.decision === 'keep' ? 'keep' : null;
        if (!decision) return res.status(400).json({ error: 'decision must be keep or revoke' });
        res.json(await decideRecertItem(parseInt(req.params.id, 10), decision, await getViewer(req)));
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to decide' });
    }
});

// ─── Settings backup / restore (admin) - config only; secrets never leave the server ───
app.get('/api/settings-export', requireAdmin, async (req, res) => {
    try {
        const data = await exportAppSettings();
        audit(await getViewer(req), 'settings.export', 'app settings', { keys: Object.keys(data.settings).length });
        res.setHeader('Content-Disposition', `attachment; filename="netbird-companion-settings-${new Date().toISOString().slice(0, 10)}.json"`);
        res.json(data);
    } catch (err) {
        console.error('Error exporting settings:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.post('/api/settings-import', express.json({ limit: '10mb' }), requireAdmin, async (req, res) => {
    try {
        res.json(await importAppSettings(req.body || {}, await getViewer(req)));
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to import' });
    }
});

// ─── Internal ENVELOPE-ENCRYPTED backup (tier 2) - full config + ALL secrets, encrypted with a
// public key on a schedule; only the admin passphrase can decrypt (the server itself cannot). Main
// account only - every route rejects an X-Tenant-Account header. NOT tenant-allowlisted. ───
const rejectTenant = (req, res) => req.headers['x-tenant-account']
    ? (res.status(400).json({ error: 'Internal backup is managed from the main account only' }), true) : false;

app.get('/api/internal-backup', requireAdmin, async (req, res) => {
    if (rejectTenant(req, res)) return;
    try { res.json(await getInternalBackupStatus()); }
    catch (err) { console.error('Error loading internal backup status:', err.message); res.status(500).json({ error: 'Internal server error' }); }
});

// Set / change / reset the encryption passphrase. Audit records the MODE only - never the passphrase.
app.post('/api/internal-backup/passphrase', requireAdmin, async (req, res) => {
    if (rejectTenant(req, res)) return;
    try {
        const { passphrase, currentPassphrase, reset } = req.body || {};
        const { mode } = await setBackupPassphrase({ passphrase, currentPassphrase, reset: !!reset });
        audit(await getViewer(req), 'backup.passphrase', 'Internal Backup Encryption', { mode });
        res.json({ ok: true, mode });
    } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Failed to set passphrase' }); }
});

app.put('/api/internal-backup/config', requireAdmin, async (req, res) => {
    if (rejectTenant(req, res)) return;
    try {
        const cfg = await setInternalBackupConfig(req.body || {});
        audit(await getViewer(req), 'settings.internal-backup', 'Internal Backup Schedule', cfg);
        res.json(cfg);
    } catch (err) { res.status(400).json({ error: err.message || 'Failed to save' }); }
});

app.post('/api/internal-backup/run', requireAdmin, async (req, res) => {
    if (rejectTenant(req, res)) return;
    try {
        const out = await runInternalBackup();
        audit(await getViewer(req), 'backup.run', out.file, { file: out.file, size: out.size });
        res.json(out);
    } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Backup failed' }); }
});

app.post('/api/internal-backup/restore', requireAdmin, async (req, res) => {
    if (rejectTenant(req, res)) return;
    try {
        const { name, passphrase } = req.body || {};
        const fileBuf = await readBackupFile(name); // validates the name (traversal-proof)
        const result = await restoreInternalBackup(fileBuf, passphrase);
        audit(await getViewer(req), 'backup.restore', backupFilePath(name).split(/[\\/]/).pop(), { settings: result.settings, tables: result.tables, skipped: result.skipped });
        res.json(result);
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'Backup file not found' });
        res.status(err.status || 400).json({ error: err.message || 'Restore failed' });
    }
});

// Uploaded restore: raw encrypted bytes in the body (route-local parser), passphrase in a header
// (the raw body can't carry JSON fields). Path is exempt from the global json wrapper (see above).
app.post('/api/internal-backup/upload', requireAdmin, express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
    if (rejectTenant(req, res)) return;
    try {
        const passphrase = String(req.headers['x-backup-passphrase'] || '');
        // express.raw yields a Buffer only for an application/octet-stream body. Anything else is
        // refused as-is (no conversion) before the file is read or anything changes.
        const fileBuf = req.body;
        if (typeof fileBuf !== 'object' || !Buffer.isBuffer(fileBuf) || !fileBuf.length) return res.status(400).json({ error: 'No file uploaded' });
        const result = await restoreInternalBackup(fileBuf, passphrase);
        audit(await getViewer(req), 'backup.restore', 'uploaded file', { settings: result.settings, tables: result.tables, skipped: result.skipped, source: 'upload' });
        res.json(result);
    } catch (err) { res.status(err.status || 400).json({ error: err.message || 'Restore failed' }); }
});

app.get('/api/internal-backup/download/:name', requireAdmin, async (req, res) => {
    if (rejectTenant(req, res)) return;
    try {
        const filePath = backupFilePath(req.params.name); // validates the name (traversal-proof)
        const name = filePath.split(/[\\/]/).pop();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        fs.createReadStream(filePath).on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Backup file not found' }); }).pipe(res);
    } catch (err) { res.status(400).json({ error: err.message || 'Invalid file name' }); }
});

// ─── Feature permissions - grant specific capabilities to non-admin users/groups ───
app.get('/api/feature-permissions', requireAdmin, async (req, res) => {
    try {
        res.json(getFeaturePermsConfig());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.put('/api/feature-permissions', requireAdmin, async (req, res) => {
    try {
        const out = await setFeaturePermsConfig(req.body || {});
        audit(await getViewer(req), 'settings.permissions', '', {
            grants: Object.entries(out).map(([k, v]) => `${k}: ${v.users.length}u/${v.groupIds.length}g`).join(', '),
        });
        res.json(out);
    } catch (err) {
        console.error('Error saving feature permissions:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Approvals config - who may approve access requests (Entra groups + Telegram) ───
app.get('/api/approver-config', requireAdmin, async (req, res) => {
    try {
        res.json({ ...getApproverConfig(), webhookConfigured: !!getTelegramConfig().webhookConfigured });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.put('/api/approver-config', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await setApproverConfig({ groupIds: b.groupIds, telegramChatId: b.telegramChatId, telegramApprovers: b.telegramApprovers });
        // Make sure the callback webhook is registered so Telegram approvals work.
        if (getTelegramConfig().enabled && getTelegramConfig().hasToken && process.env.BASE_URL) telegramSetWebhook(process.env.BASE_URL).catch(() => { });
        audit(await getViewer(req), 'settings.approvers', '', { groups: out.groupIds.length, tgApprovers: out.telegramApprovers.length });
        res.json({ ...out, webhookConfigured: !!getTelegramConfig().webhookConfigured });
    } catch (err) {
        console.error('Error saving approver config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Auto-approval config - which requests skip human review (trusted groups + per-target rules) ───
app.get('/api/auto-approval-config', requireAdmin, async (req, res) => {
    try {
        res.json(getAutoApprovalConfig());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.put('/api/auto-approval-config', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await setAutoApprovalConfig({ trusted: b.trusted, rules: b.rules });
        audit(await getViewer(req), 'settings.auto_approval', '', { trustedEntries: out.trusted.length, rules: out.rules.length });
        res.json(out);
    } catch (err) {
        console.error('Error saving auto-approval config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send a test message with the currently-saved config (the UI saves first, then tests).
app.post('/api/integrations/telegram/test', requireAdmin, async (req, res) => {
    try {
        res.json(await telegramTest());
    } catch (err) {
        console.error('Telegram test error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Auto-create a forum topic per category and store the thread ids. Body: { categories: { key: name } }.
app.post('/api/integrations/telegram/create-topics', requireAdmin, async (req, res) => {
    try {
        const out = await telegramCreateTopics((req.body && req.body.categories) || {});
        audit(await getViewer(req), 'settings.telegram', '', { topicsCreated: out.created || 0 });
        res.json(out);
    } catch (err) {
        console.error('Telegram create-topics error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Email (SMTP) notifications - so requesters learn their access was approved/denied/ended ───
app.get('/api/integrations/smtp', requireAdmin, async (req, res) => {
    try {
        res.json({
            ...getSmtpConfig(),
            complianceBlockedEmail: (await getSetting('compliance_blocked_email')) !== 'false',
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.put('/api/integrations/smtp', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await setSmtpConfig({ enabled: b.enabled, host: b.host, port: b.port, secure: b.secure, user: b.user, from: b.from, pass: b.pass });
        if (b.complianceBlockedEmail !== undefined) {
            await setSetting('compliance_blocked_email', b.complianceBlockedEmail ? 'true' : 'false');
        }
        audit(await getViewer(req), 'settings.smtp', '', { enabled: !!out.enabled, host: out.host || undefined, passwordChanged: !!(b.pass && String(b.pass).trim()), complianceBlockedEmail: b.complianceBlockedEmail === undefined ? undefined : !!b.complianceBlockedEmail });
        res.json({ ...out, complianceBlockedEmail: (await getSetting('compliance_blocked_email')) !== 'false' });
    } catch (err) {
        console.error('Error saving SMTP config:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// Send a test email to a chosen address (defaults to the current admin's own email).
app.post('/api/integrations/smtp/test', requireAdmin, async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const to = (req.body && String(req.body.to || '').trim()) || (viewer && viewer.email) || '';
        res.json(await smtpTest(to));
    } catch (err) {
        console.error('SMTP test error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Access requests (self-service request → admin approval, in-app or via Telegram) ───

// Typeahead over grantable things - available to any logged-in user building a request.
app.get('/api/request-targets', async (req, res) => {
    try {
        res.json(await searchRequestTargets(req.query.q || ''));
    } catch (e) {
        console.error('Error searching request targets:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a request (any logged-in user).
app.post('/api/access-requests', async (req, res) => {
    try {
        res.json(await createAccessRequest(req.body || {}, await getViewer(req)));
    } catch (e) {
        console.error('Error creating access request:', e.message);
        res.status(400).json({ error: e.message || 'Failed to create request' });
    }
});

// A user's own requests (any logged-in user).
app.get('/api/access-requests/mine', async (req, res) => {
    try {
        const v = await getViewer(req);
        res.json(await listAccessRequests({ requesterId: v.user_id || v.oid || '__none__' }));
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Cancel one's own pending request (or admin).
app.post('/api/access-requests/:id/cancel', async (req, res) => {
    try {
        res.json(await cancelAccessRequest(parseInt(req.params.id, 10), await getViewer(req)));
    } catch (e) {
        res.status(400).json({ error: e.message || 'Failed to cancel request' });
    }
});

// Approvers (admins + Entra approver group): list requests + pending count for the nav badge.
app.get('/api/access-requests', requireApprover, async (req, res) => {
    try {
        res.json(await listAccessRequests({ status: req.query.status || undefined }));
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.get('/api/access-requests/pending-count', requireApprover, async (req, res) => {
    try {
        res.json({ count: await countPendingRequests() });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Approvers: approve (creates the temporary-access grant) / deny.
app.post('/api/access-requests/:id/approve', requireApprover, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true) - approving would grant NetBird access.' });
    try {
        const b = req.body || {};
        res.json(await approveAccessRequest(parseInt(req.params.id, 10), { durationMinutes: b.durationMinutes, expiresAt: b.expiresAt, targets: b.targets, actor: await getViewer(req) }));
    } catch (e) {
        console.error('Error approving access request:', e.message);
        res.status(400).json({ error: e.message || 'Failed to approve request' });
    }
});
app.post('/api/access-requests/:id/deny', requireApprover, async (req, res) => {
    try {
        res.json(await denyAccessRequest(parseInt(req.params.id, 10), { reason: (req.body && req.body.reason) || '', actor: await getViewer(req) }));
    } catch (e) {
        res.status(400).json({ error: e.message || 'Failed to deny request' });
    }
});

// ─── Access Profiles (a named source-groups + protocol/ports bundle = group + policy) ───
// Listing is available to any editor (to assign a profile to a resource); managing is admin.
app.get('/api/access-profiles', async (req, res) => {
    try {
        res.json(await listAccessProfiles());
    } catch (err) {
        console.error('Error listing access profiles:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/access-profiles', requireAdmin, async (req, res) => {
    try {
        const { name, sources, protocol, ports, shared, postureChecks } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
        const out = await createAccessProfile({ name: String(name).trim(), shared: shared !== false, sources, protocol, ports, postureChecks });
        audit(await getViewer(req), 'profile.create', String(name).trim(), { type: shared !== false ? 'shared' : 'direct', protocol });
        res.json(out);
    } catch (err) {
        console.error('Error creating access profile:', err.message);
        res.status(502).json({ error: err.message || 'Failed to create profile' });
    }
});

app.put('/api/access-profiles/:id', requireAdmin, async (req, res) => {
    try {
        const { name, sources, protocol, ports, postureChecks } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
        await updateAccessProfile(parseInt(req.params.id, 10), { name: String(name).trim(), sources, protocol, ports, postureChecks });
        audit(await getViewer(req), 'profile.update', String(name).trim());
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error updating access profile:', err.message);
        res.status(502).json({ error: err.message || 'Failed to update profile' });
    }
});

app.delete('/api/access-profiles/:id', requireAdmin, async (req, res) => {
    try {
        await deleteAccessProfile(parseInt(req.params.id, 10));
        audit(await getViewer(req), 'profile.delete', `#${req.params.id}`);
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error deleting access profile:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete profile' });
    }
});

// Per-network default Access Profiles (admin) - pre-selected when adding a resource.
app.get('/api/network-default-profiles', requireAdmin, async (req, res) => {
    try {
        res.json(await getAllNetworkDefaultProfiles());
    } catch (err) {
        console.error('Error listing network default profiles:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/networks/:id/default-profiles', requireAdmin, async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.profileIds) ? req.body.profileIds : [];
        const saved = await setNetworkDefaultProfiles(req.params.id, ids);
        // Record the profile NAMES (not just a count) so the audit + notification are meaningful.
        let meta = { count: saved.length };
        try {
            const byId = new Map((await listAccessProfiles()).map(p => [p.id, p.name]));
            const names = saved.map(id => byId.get(id) || id).filter(Boolean).join(', ');
            meta = names ? { profiles: names } : { profiles: 'none (cleared)' };
        } catch { /* fall back to count */ }
        audit(await getViewer(req), 'network.default_profiles', req.params.id, meta);
        res.json({ status: 'ok', profileIds: saved });
    } catch (err) {
        console.error('Error saving network default profiles:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Posture Checks (proxied to NetBird) - list for any editor, manage for admins ───
app.get('/api/posture-checks', async (req, res) => {
    try {
        res.json(await listPostureChecks());
    } catch (err) {
        console.error('Error listing posture checks:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Certificate check helper: parse pasted CA certificates and return each one's subject, validity,
// CA flag and SHA-256 fingerprint. Pure parsing (no NetBird call, nothing stored), so it is open to
// every signed-in user - the policy editor shows the fingerprints to non-admin network editors too -
// and works in read-only mode. Inputs are capped (20 entries, 16k characters each).
app.post('/api/posture-checks/inspect-certificates', (req, res) => {
    const pems = req.body && req.body.pems;
    if (!Array.isArray(pems) || pems.length > 20 || pems.some(p => typeof p !== 'string')) {
        return res.status(400).json({ error: 'Send up to 20 PEM certificates as { pems: [...] }.' });
    }
    res.json(require('./lib/pure').inspectCaCertificates(pems));
});

app.post('/api/posture-checks', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
        const out = await createPostureCheck(req.body);
        audit(await getViewer(req), 'posture.create', String(name).trim());
        res.json(out);
    } catch (err) {
        console.error('Error creating posture check:', err.message);
        res.status(502).json({ error: err.message || 'Failed to create posture check' });
    }
});

app.put('/api/posture-checks/:id', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
        const out = await updatePostureCheck(req.params.id, req.body);
        audit(await getViewer(req), 'posture.update', String(name).trim());
        res.json(out);
    } catch (err) {
        console.error('Error updating posture check:', err.message);
        res.status(502).json({ error: err.message || 'Failed to update posture check' });
    }
});

app.delete('/api/posture-checks/:id', requireAdmin, async (req, res) => {
    try {
        const label = await labelBeforeDelete('posture', req.params.id);
        await deletePostureCheck(req.params.id);
        audit(await getViewer(req), 'posture.delete', label);
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error deleting posture check:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete posture check' });
    }
});

// Geo data for the geo-location posture check editor.
app.get('/api/locations/countries', async (req, res) => {
    try {
        res.json(await getCountries());
    } catch (err) {
        console.error('Error listing countries:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/locations/countries/:code/cities', async (req, res) => {
    try {
        res.json(await getCities(req.params.code));
    } catch (err) {
        console.error('Error listing cities:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Automations: external HTTP source → auto-provisioned resources (admin only) ───
app.get('/api/automations', requireAdmin, async (req, res) => {
    try {
        res.json(await listAutomations());
    } catch (err) {
        console.error('Error listing automations:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/automations', requireAdmin, async (req, res) => {
    try {
        const { name, endpointUrl } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
        if (!endpointUrl || !String(endpointUrl).trim()) return res.status(400).json({ error: 'endpoint URL is required' });
        const out = await createAutomation(req.body);
        audit(await getViewer(req), 'automation.create', String(name).trim());
        res.json(out);
    } catch (err) {
        console.error('Error creating automation:', err.message);
        res.status(500).json({ error: err.message || 'Failed to create automation' });
    }
});

app.put('/api/automations/:id', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
        await updateAutomation(parseInt(req.params.id, 10), req.body);
        audit(await getViewer(req), 'automation.update', String(name).trim());
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error updating automation:', err.message);
        res.status(500).json({ error: err.message || 'Failed to update automation' });
    }
});

app.delete('/api/automations/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const row = await getAutomationRow(id);
        await deleteAutomation(id);
        audit(await getViewer(req), 'automation.delete', row ? row.name : `#${id}`);
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error deleting automation:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Manual "Sync now".
app.post('/api/automations/:id/run', requireAdmin, async (req, res) => {
    try {
        if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true) - automations are disabled.' });
        const viewer = await getViewer(req);
        const result = await runAutomation(parseInt(req.params.id, 10), { trigger: 'manual', actor: viewer });
        res.json(result);
    } catch (err) {
        console.error('Error running automation:', err.message);
        res.status(500).json({ error: err.message || 'Failed to run automation' });
    }
});

// Dry run: the full sync decision walk with zero writes - "what would happen right now"
// (create / re-enable / adopt / conflict / blocked / delete / disable per item). Works
// in read-only mode too, since it never writes.
app.post('/api/automations/:id/dry-run', requireAdmin, async (req, res) => {
    try {
        res.json(await dryRunAutomation(parseInt(req.params.id, 10)));
    } catch (err) {
        console.error('Error dry-running automation:', err.message);
        res.status(400).json({ error: err.message || 'Failed to dry-run automation' });
    }
});

// Test the connection + field mapping without creating anything (drives the preview).
app.post('/api/automations/:id/test', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const result = await testAutomation({ ...(req.body || {}), id: Number.isFinite(id) ? id : undefined });
        res.json(result);
    } catch (err) {
        console.error('Error testing automation:', err.message);
        res.status(500).json({ error: err.message || 'Failed to test automation' });
    }
});

// Test a not-yet-saved automation (create form).
app.post('/api/automations/test', requireAdmin, async (req, res) => {
    try {
        res.json(await testAutomation(req.body || {}));
    } catch (err) {
        console.error('Error testing automation:', err.message);
        res.status(500).json({ error: err.message || 'Failed to test automation' });
    }
});

app.get('/api/automations/:id/runs', requireAdmin, async (req, res) => {
    try {
        res.json(await getAutomationRuns(parseInt(req.params.id, 10), 20));
    } catch (err) {
        console.error('Error listing automation runs:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Resources this automation manages, with orphan detection (diagnostics).
app.get('/api/automations/:id/managed', requireAdmin, async (req, res) => {
    try {
        res.json(await getAutomationManaged(parseInt(req.params.id, 10)));
    } catch (err) {
        console.error('Error listing managed resources:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Reconcile the ledger - drop entries whose NetBird resource no longer exists.
app.post('/api/automations/:id/repair', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const out = await repairAutomation(id);
        const row = await getAutomationRow(id);
        audit(await getViewer(req), 'automation.repair', row ? row.name : `#${id}`, { removed: out.removed });
        res.json(out);
    } catch (err) {
        console.error('Error repairing automation:', err.message);
        res.status(500).json({ error: err.message || 'Failed to repair' });
    }
});

// Stop managing all resources (clears the ledger; resources stay in NetBird).
app.post('/api/automations/:id/forget', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const out = await forgetAutomation(id);
        const row = await getAutomationRow(id);
        audit(await getViewer(req), 'automation.forget', row ? row.name : `#${id}`, { forgotten: out.forgotten });
        res.json(out);
    } catch (err) {
        console.error('Error forgetting automation state:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Audit log of changes made through this app - admin only.
app.get('/api/audit', requirePerm('audit.view'), async (req, res) => {
    try {
        const { search, from, to, category, sort, dir, page, per_page } = req.query;
        res.json(await getAuditLog({
            search: search || undefined,
            from: from || undefined,
            to: to || undefined,
            category: category || undefined,
            sort: sort || undefined,
            dir: dir || undefined,
            page: parseInt(page, 10) || 1,
            per_page: Math.min(parseInt(per_page, 10) || 20, 200),
        }));
    } catch (err) {
        console.error('Error loading audit log:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Outbound log - every email / Telegram message the app actually sent (Admin → Notifications).
app.get('/api/outbound-log', requirePerm('audit.view'), async (req, res) => {
    try {
        const { search, channel, status, from, to, sort, dir, page, per_page } = req.query;
        res.json(await getOutboundLog({
            search: search || undefined,
            channel: channel || undefined,
            status: status || undefined,
            from: from || undefined,
            to: to || undefined,
            sort: sort || undefined,
            dir: dir || undefined,
            page: parseInt(page, 10) || 1,
            per_page: Math.min(parseInt(per_page, 10) || 25, 200),
        }));
    } catch (err) {
        console.error('Error loading outbound log:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// The full rendered body of one sent message, for the Preview modal. Same permission as the list
// (audit.view). Main-account admin log - NOT tenant-allowlisted (the Notifications tab is dropped
// in tenant mode). Bodies are large, so they are fetched on demand, one row at a time.
app.get('/api/outbound-log/:id/body', requirePerm('audit.view'), async (req, res) => {
    try {
        const row = await getOutboundBody(parseInt(req.params.id, 10) || 0);
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(row);
    } catch (err) {
        console.error('Error loading outbound body:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get logs with filtering & pagination. Non-admins are restricted to their own events.
app.get('/api/logs', async (req, res) => {
    try {
        // Keep the NetBird caches warm so user_id and reporter_id resolve to names
        ensureUsersFresh().catch(err => console.error('User refresh error:', err.message));
        ensurePeersFresh().catch(err => console.error('Peer refresh error:', err.message));

        const viewer = await getViewer(req);
        const { search, source, destination, type, protocol, from, to, user, exclude_addr, page, per_page, sort, dir } = req.query;
        const result = await queryEvents({
            search,
            source,
            destination,
            type,
            protocol,
            from,
            to,
            user,
            sort, dir,
            exclude_addr: exclude_addr || undefined,
            // Restrict to own events unless admin or granted 'View All Activity'
            viewer_oid: (viewer.isAdmin || (viewer.perms && viewer.perms['activity.all'])) ? undefined : (viewer.oid || '__no_match__'),
            page: parseInt(page, 10) || 1,
            per_page: Math.min(200, parseInt(per_page, 10) || 10)
        });

        // Resolve user identities for the returned events
        const users = await resolveUsersForEvents(result.events);
        result.users = users;

        res.json(result);
    } catch (err) {
        console.error('Error querying logs:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Distinct users (Activity filter) - admin only; others don't filter by user
app.get('/api/logs/users', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        if (!viewer.isAdmin && !(viewer.perms && viewer.perms['activity.all'])) return res.json([]);
        res.json(await getDistinctUsers());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Distinct source names - admin only
app.get('/api/logs/sources', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        if (!viewer.isAdmin && !(viewer.perms && viewer.perms['activity.all'])) return res.json([]);
        res.json(await getDistinctSources());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Stats - admin only
app.get('/api/logs/stats', requireAdmin, async (req, res) => {
    try {
        res.json(await getStats());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin logs - admin only
app.get('/api/admin-logs', requirePerm('audit.view'), async (req, res) => {
    try {
        const { search, from, to, category, sort, dir, page, per_page } = req.query;
        // Keep the users cache warm so initiator_id resolves to a name/email (per-account).
        ensureUsersFresh().catch(err => console.error('User refresh error:', err.message));

        const result = await queryAdminEvents({
            search: search || undefined,
            from: from || undefined,
            to: to || undefined,
            category: category || undefined,
            sort: sort || undefined,
            dir: dir || undefined,
            page: parseInt(page, 10) || 1,
            per_page: Math.min(200, parseInt(per_page, 10) || 10)
        });
        result.users = await resolveUsersForAdminEvents(result.events);
        // The app's own NetBird user (its API token) - lets the UI tag app-driven events.
        result.appUserId = await getOwnNetbirdUserId().catch(() => '');
        res.json(result);
    } catch (err) {
        console.error('Error querying admin logs:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Traffic summary - the filtered events aggregated per source→destination pair. Same filters
// and viewer scoping as /api/logs; powers the Activity page's Summary view.
app.get('/api/logs/summary', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const { search, source, destination, type, protocol, from, to, user, page, per_page, sort, dir } = req.query;
        const result = await queryTrafficSummary({
            search, source, destination, type, protocol,
            sort, dir,
            from: from || undefined,
            to: to || undefined,
            user: user || undefined,
            viewer_oid: (viewer.isAdmin || (viewer.perms && viewer.perms['activity.all'])) ? undefined : (viewer.oid || '__no_match__'),
            page: parseInt(page, 10) || 1,
            per_page: Math.min(parseInt(per_page, 10) || 25, 200),
        });
        // Resolve each pair's user_id to a display name/email (same resolver as /api/logs).
        result.users = await resolveUsersForEvents(result.rows.map(r => ({ user_id: r.userId })));
        res.json(result);
    } catch (err) {
        console.error('Error querying traffic summary:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Reverse-proxy (NetBird Cloud ingress) status: clusters + published services. Cloud-only;
// `available: false` on self-hosted so the dashboard card hides itself.
// Reverse-proxy ACCESS logs (which host/path each request hit), enriched with service and
// user names. Cloud-only; on self-hosted the endpoint is absent → { available: false }.
// Admins + holders of the 'proxy.manage' feature permission.
app.get('/api/reverse-proxy-logs', requirePerm('proxy.manage'), async (req, res) => {
    try {
        res.json(await getProxyAccessLogs({
            page: req.query.page, per_page: req.query.per_page, search: req.query.search,
            status: req.query.status, method: req.query.method,
            user: req.query.user, user_id: req.query.user_id, user_empty: req.query.user_empty,
            service_id: req.query.service_id, location: req.query.location,
            from: req.query.from, to: req.query.to,
        }));
    } catch (err) {
        console.error('Error loading reverse-proxy access logs:', err.message);
        res.status(500).json({ error: err.message || 'Failed to load access logs' });
    }
});

// Summary view: the filtered access logs aggregated per service (same filters as the list).
app.get('/api/reverse-proxy-logs/summary', requirePerm('proxy.manage'), async (req, res) => {
    try {
        res.json(await getProxyLogsSummary({
            search: req.query.search, status: req.query.status, method: req.query.method,
            user: req.query.user, user_id: req.query.user_id, location: req.query.location,
            from: req.query.from, to: req.query.to,
        }));
    } catch (err) {
        console.error('Error loading proxy logs summary:', err.message);
        res.status(500).json({ error: err.message || 'Failed to load summary' });
    }
});

// Per-service totals over the whole stored history (Services tab row statistics).
app.get('/api/reverse-proxy-logs/service-stats', requirePerm('proxy.manage'), async (req, res) => {
    try {
        res.json(await getProxyServiceStats());
    } catch (err) {
        console.error('Error loading proxy service stats:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Custom domains available as bases for new reverse-proxy services.
app.get('/api/reverse-proxy-domains', requirePerm('proxy.manage'), async (req, res) => {
    try {
        res.json(await getProxyDomains());
    } catch (err) {
        console.error('Error loading reverse-proxy domains:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a reverse-proxy service (Add Service).
app.post('/api/reverse-proxy-services', requirePerm('proxy.manage'), async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await createProxyService(req.body || {});
        const t = (req.body && req.body.target) || {};
        audit(await getViewer(req), 'proxy.create', out.domain, {
            cluster: String((req.body && req.body.cluster) || ''), targetType: String(t.type || ''), port: t.port, protocol: t.protocol || 'http',
        });
        res.json(out);
    } catch (err) {
        console.error('Error creating reverse-proxy service:', err.message);
        res.status(502).json({ error: err.message || 'Failed to create service' });
    }
});

// Flat peers + resources inventory for the unified target picker.
app.get('/api/reverse-proxy-target-options', requirePerm('proxy.manage'), async (req, res) => {
    try {
        res.json(await getProxyTargetOptions());
    } catch (err) {
        console.error('Error loading proxy target options:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// One service, browser-safe (auth secrets stripped - only "set" flags survive).
app.get('/api/reverse-proxy-services/:id', requirePerm('proxy.manage'), async (req, res) => {
    try {
        res.json(sanitizeProxyService(await getProxyServiceRaw(req.params.id)));
    } catch (err) {
        console.error('Error loading reverse-proxy service:', err.message);
        res.status(502).json({ error: err.message || 'Failed to load service' });
    }
});

// Partial update (name / enabled / targets / auth / access restrictions / NetBird-only).
app.put('/api/reverse-proxy-services/:id', requirePerm('proxy.manage'), async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await updateProxyService(req.params.id, req.body || {});
        audit(await getViewer(req), 'proxy.update', String((req.body && req.body.domain) || req.params.id), {
            fields: Object.keys(req.body || {}).filter(k => k !== 'domain').join(', ') || 'nothing',
            ...(out.syncedResources && out.syncedResources.length ? { linkedResources: out.syncedResources.join(', ') } : {}),
        });
        res.json(out);
    } catch (err) {
        console.error('Error updating reverse-proxy service:', err.message);
        res.status(err.status === 409 || err.status === 400 ? err.status : 502).json({ error: err.message || 'Failed to update service' });
    }
});

app.delete('/api/reverse-proxy-services/:id', requirePerm('proxy.manage'), async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        // Resolve the domain BEFORE deletion so the audit names the service, not an id.
        let label = req.params.id;
        try { label = (await getProxyServiceRaw(req.params.id)).domain || label; } catch { /* keep id */ }
        const out = await deleteProxyService(req.params.id);
        audit(await getViewer(req), 'proxy.delete', label,
            out.cleanedResources && out.cleanedResources.length ? { deletedResources: out.cleanedResources.join(', ') } : undefined);
        res.json(out);
    } catch (err) {
        console.error('Error deleting reverse-proxy service:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete service' });
    }
});

// Expose a Docker container: [routing peer] → domain resource → service, with rollback.
app.post('/api/reverse-proxy-services/expose-docker', requirePerm('proxy.manage'), async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await exposeDockerService(req.body || {});
        audit(await getViewer(req), 'proxy.expose', String((req.body && req.body.serviceDomain) || ''), {
            container: String((req.body && req.body.containerDomain) || ''),
            network: await netLabel(String((req.body && req.body.networkId) || '')),
            routerAttached: req.body && req.body.routerPeerId ? 'yes' : 'no',
        });
        res.json(out);
    } catch (err) {
        console.error('Error exposing docker container:', err.message);
        res.status(502).json({ error: err.message || 'Failed to expose container' });
    }
});

// Pull new access logs from NetBird RIGHT NOW (the page's refresh button) - same sync the
// scheduler runs every 5 minutes, just on demand. Read-only against NetBird.
app.post('/api/reverse-proxy-logs/sync', requirePerm('proxy.manage'), async (req, res) => {
    try {
        await syncProxyAccessLogs();
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error syncing proxy access logs:', err.message);
        res.status(500).json({ error: err.message || 'Failed to sync access logs' });
    }
});

// Distinct users seen in the stored proxy logs (user filter dropdown).
app.get('/api/reverse-proxy-logs/users', requirePerm('proxy.manage'), async (req, res) => {
    try {
        res.json(await getProxyLogUsers());
    } catch (err) {
        console.error('Error loading proxy log users:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Manual refresh: bust the 60s status cache and answer with a fresh pull from the API.
app.post('/api/reverse-proxy-status/refresh', requirePerm('proxy.manage'), async (req, res) => {
    try {
        bustReverseProxyCache();
        res.json(await getReverseProxyStatus());
    } catch (err) {
        console.error('Error refreshing reverse-proxy status:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/reverse-proxy-status', requirePerm('proxy.manage'), async (req, res) => {
    try {
        res.json(await getReverseProxyStatus());
    } catch (err) {
        console.error('Error loading reverse-proxy status:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Live NetBird activity events for the tenant currently being managed. Only valid IN tenant
// context (the middleware allows this route there); pulls straight from the tenant's NetBird
// Events-per-hour for the dashboard chart. Admins see all traffic; restricted users only theirs.
app.get('/api/stats/hourly', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        res.json(await getHourlyEventCounts({
            viewerOid: (viewer.isAdmin || (viewer.perms && viewer.perms['activity.all'])) ? undefined : (viewer.oid || '__no_match__'),
            hours: req.query.hours,
        }));
    } catch (err) {
        console.error('Error loading hourly stats:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// IP-assignment history - who held a NetBird IP at a given time (forensic lookup, admin only).
app.get('/api/ip-history', requirePerm('audit.view'), async (req, res) => {
    try {
        const { q, at, user, sort, dir, page, per_page } = req.query;
        res.json(await queryIpHistory({
            q: q || undefined,
            at: at || undefined,
            user: user || undefined,
            sort: sort || undefined,
            dir: dir || undefined,
            page: parseInt(page, 10) || 1,
            per_page: Math.min(parseInt(per_page, 10) || 25, 200),
        }));
    } catch (err) {
        console.error('Error querying IP history:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Distinct users in the IP history (for the page's user filter).
app.get('/api/ip-history/users', requirePerm('audit.view'), async (req, res) => {
    try {
        res.json(await getIpHistoryUsers());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/admin-logs/stats', requirePerm('audit.view'), async (req, res) => {
    try {
        res.json(await getAdminStats());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Full users list (NetBird /api/users cache) - admin only
app.get('/api/users', requirePerm('temp.manage'), async (req, res) => {
    try {
        await ensureUsersFresh();
        res.json(await getAllUsers());
    } catch (err) {
        console.error('Error listing users:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Default Auto-Assigned Groups for invitations (admin only) - the invite modal pre-selects them.
// MUST stay ABOVE /api/users/:id, or the param route swallows the literal path. /api/users* is
// tenant-allowlisted, so each account (main or tenant) reads and writes its OWN defaults.
app.get('/api/users/invite-defaults', requireAdmin, async (req, res) => {
    try {
        res.json({ groups: await getInviteDefaultGroups() });
    } catch (err) {
        console.error('Error loading invite defaults:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/users/invite-defaults', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        if (!Array.isArray(b.groups)) return res.status(400).json({ error: 'Groups must be a list' });
        const groups = await setInviteDefaultGroups(b.groups);
        audit(await getViewer(req), 'settings.invite_defaults', '', { groups: groups.length });
        res.json({ groups });
    } catch (err) {
        console.error('Error saving invite defaults:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Expanded detail for one user (user detail page). Admins can view anyone; a
// regular user may view only their own profile (so each user sees their own data).
app.get('/api/users/:id', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const isSelf = !!viewer.user_id && req.params.id === viewer.user_id;
        if (!viewer.isAdmin && !isSelf) return res.status(403).json({ error: 'Forbidden' });
        await Promise.all([ensureUsersFresh(), ensurePeersFresh()]);
        const detail = await getUserDetail(req.params.id);
        if (!detail) return res.status(404).json({ error: 'User not found' });
        res.json(detail);
    } catch (err) {
        console.error('Error loading user detail:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Invite a user (admin only). NetBird Cloud creates the user in the "invited" state and
// sends the invitation e-mail itself. Runs in the current account context, so it also works
// while managing an MSP tenant (/api/users* is in TENANT_CTX_PREFIXES).
app.post('/api/users/invite', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const b = req.body || {};
        const name = String(b.name || '').trim().slice(0, 100);
        const email = String(b.email || '').trim();
        const role = String(b.role || 'user');
        const autoGroups = Array.isArray(b.autoGroups) ? b.autoGroups.map(g => String(g || '')).filter(Boolean) : [];
        // Validate here (400) so a bad form never reaches NetBird - real API failures stay 502.
        if (!name) return res.status(400).json({ error: 'A name is required' });
        if (!isPlausibleEmail(email)) return res.status(400).json({ error: 'A valid e-mail address is required' });
        if (!USER_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
        if (b.autoGroups !== undefined && !Array.isArray(b.autoGroups)) return res.status(400).json({ error: 'Auto-assigned groups must be a list' });
        const user = await inviteUser({ name, email, role, autoGroups });
        audit(await getViewer(req), 'user.invite', email, { role, groups: autoGroups.length });
        res.json(user);
    } catch (err) {
        console.error('Error inviting user:', err.message);
        res.status(502).json({ error: err.message || 'Failed to invite the user' });
    }
});

// Re-send a pending invitation (admin only) - the dashboard's "Resend" action.
app.post('/api/users/:id/resend-invite', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        // Resolve the target's name/e-mail from the mirror BEFORE the call, so the audit
        // names the person instead of an opaque NetBird id.
        let label = req.params.id;
        try {
            const u = (await getAllUsers()).find(x => x && x.id === req.params.id);
            if (u) label = u.email || u.name || label;
        } catch { /* keep the id */ }
        const out = await resendUserInvite(req.params.id);
        audit(await getViewer(req), 'user.invite.resend', label);
        res.json(out);
    } catch (err) {
        console.error('Error resending invitation:', err.message);
        res.status(502).json({ error: err.message || 'Failed to resend the invitation' });
    }
});

// Delete a user (admin only) - NetBird also deletes THE USER'S PEERS. deleteUser resolves the
// name/e-mail before the call so the audit names the person, and refuses the account owner and
// the app's own service user (those throw with status 400; real API failures stay 502).
// /api/users* is tenant-allowlisted, so in MSP tenant mode this deletes the TENANT's user.
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await deleteUser(req.params.id);
        audit(await getViewer(req), 'user.delete', out.label);
        res.json(out);
    } catch (err) {
        console.error('Error deleting user:', err.message);
        res.status(err.status || 502).json({ error: err.message || 'Failed to delete the user' });
    }
});

// Block / unblock a user (admin only) - the dashboard's user block toggle. setUserBlocked resends
// role + auto_groups so NetBird's PUT doesn't wipe them, and refuses the account owner and the
// app's own service user (those throw with status 400; real API failures stay 502). The identity
// is resolved for the audit. /api/users* is tenant-allowlisted, so this targets the TENANT's user.
app.post('/api/users/:id/block', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const blocked = !!(req.body || {}).blocked;
        const out = await setUserBlocked(req.params.id, blocked);
        audit(await getViewer(req), blocked ? 'user.block' : 'user.unblock', out.label);
        res.json(out);
    } catch (err) {
        console.error('Error updating user block state:', err.message);
        res.status(err.status || 502).json({ error: err.message || 'Failed to update the user' });
    }
});

// Reset a user's MFA (admin only). Available only when NetBird serves the cloud MFA service on this
// API base (resetUserMfa probes mfaSupported) - otherwise it throws 501 and the UI disables the
// button with an explanatory tooltip. Real API failures stay 502.
app.post('/api/users/:id/reset-mfa', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await resetUserMfa(req.params.id);
        audit(await getViewer(req), 'user.mfa_reset', out.label);
        res.json(out);
    } catch (err) {
        console.error('Error resetting user MFA:', err.message);
        res.status(err.status || 502).json({ error: err.message || 'Failed to reset MFA' });
    }
});

// Peers list (NetBird /api/peers cache). Admins see all; regular users see only
// their own devices (peers they own).
app.get('/api/peers', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        await ensurePeersFresh();
        // Own devices only, unless admin or granted 'View All Peers' - or 'Manage All Networks',
        // which needs the full list to pick routing peers. `?own=1` marks the TROUBLESHOOT
        // picker: there, 'Troubleshoot All Peers' (support desk) also unlocks the full list -
        // without granting the Peers page itself (plain /api/peers ignores that permission).
        const p = viewer.perms || {};
        const seesAll = viewer.isAdmin || p['peers.all'] || p['networks.manage']
            || (String(req.query.own || '') === '1' && p['troubleshoot.all']);
        const viewerOid = seesAll ? null : (viewer.oid || '__no_match__');
        res.json(await getAllPeers(viewerOid));
    } catch (err) {
        console.error('Error listing peers:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a setup key (admin only). Two callers share this route:
//   • "Add Peer → Server" sends only { name } → the official one-off / 24h / single-use key.
//   • The group Setup Keys tab sends the full official field set (type / expiresInDays /
//     usageLimit / ephemeral / autoGroups / allowExtraDnsLabels) so a key auto-assigns the group.
// createSetupKey defaults every omitted field back to the Add-Peer shape, so both stay correct.
// NetBird returns the PLAINTEXT key exactly once; it is handed straight to the modal and is never
// stored or logged (the audit entry keeps the name + shape only). Runs in the current account
// context, so an MSP can create a tenant's key from tenant mode.
app.post('/api/setup-keys', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const b = req.body || {};
        const name = String(b.name || '').trim().slice(0, 100);
        const key = await createSetupKey({
            name,
            type: b.type === 'reusable' ? 'reusable' : 'one-off',
            expiresInDays: b.expiresInDays,
            usageLimit: b.usageLimit,
            ephemeral: !!b.ephemeral,
            autoGroups: Array.isArray(b.autoGroups) ? b.autoGroups : [],
            allowExtraDnsLabels: !!b.allowExtraDnsLabels,
        });
        audit(await getViewer(req), 'peer.setupkey', key.name || name, {
            type: key.type, usage_limit: key.usage_limit, ephemeral: !!key.ephemeral,
            auto_groups: (key.auto_groups || []).length,
        });
        res.json(key);
    } catch (err) {
        console.error('Error creating setup key:', err.message);
        res.status(502).json({ error: err.message || 'Failed to create the setup key' });
    }
});

// Delete a peer (admin only).
app.delete('/api/peers/:id', requireAdmin, async (req, res) => {
    try {
        const label = await labelBeforeDelete('peer', req.params.id);
        const out = await deletePeer(req.params.id);
        audit(await getViewer(req), 'peer.delete', label);
        res.json(out);
    } catch (err) {
        console.error('Error deleting peer:', err.message);
        res.status(400).json({ error: err.message || 'Failed to delete peer' });
    }
});

// Bulk-delete several peers at once (admin only).
app.post('/api/peers/bulk-delete', requireAdmin, async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const ids = Array.isArray(req.body && req.body.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
        if (!ids.length) return res.status(400).json({ error: 'ids is required' });
        let deleted = 0;
        const failed = [];
        for (const pid of ids) {
            try { await deletePeer(pid); deleted++; }
            catch (e) { failed.push({ id: pid, error: e.message }); }
        }
        audit(viewer, 'peer.bulk_delete', `${deleted} peer(s)`, { deleted, failed: failed.length, ids });
        res.json({ deleted, failed });
    } catch (err) {
        console.error('Error bulk-deleting peers:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete peers' });
    }
});

// Expanded detail for one peer. Admins see any peer; a regular user only their own.
app.get('/api/peers/:id', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        await ensurePeersFresh();
        const peer = await getPeerDetail(req.params.id);
        if (!peer) return res.status(404).json({ error: 'Peer not found' });
        if (!viewer.isAdmin && !(viewer.perms && (viewer.perms['peers.all'] || viewer.perms['networks.manage']))) {
            const ownsByOid = viewer.oid && (peer.user_id === viewer.oid || peer.user_id.endsWith('|' + viewer.oid));
            const ownsById = viewer.user_id && peer.user_id === viewer.user_id;
            if (!ownsByOid && !ownsById) return res.status(403).json({ error: 'Forbidden' });
        }
        res.json(peer);
    } catch (err) {
        console.error('Error loading peer detail:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Connectivity diagnostics (Troubleshoot page) - all read-only ───
// A regular user may diagnose only their OWN devices; admins - and holders of View All
// Peers / Manage All Networks / Troubleshoot All Peers (support desk) - any device.
async function canDiagnosePeer(viewer, peerId) {
    if (viewer.isAdmin || (viewer.perms && (viewer.perms['peers.all'] || viewer.perms['networks.manage'] || viewer.perms['troubleshoot.all']))) return true;
    const peer = await getPeerDetail(peerId);
    if (!peer) return true; // let the handler 404 with a consistent message
    const ownsByOid = viewer.oid && (peer.user_id === viewer.oid || String(peer.user_id || '').endsWith('|' + viewer.oid));
    const ownsById = viewer.user_id && peer.user_id === viewer.user_id;
    return !!(ownsByOid || ownsById);
}

// Known-issue notices (routing peers down; integration sync problems for admins) -
// shown as a banner on Troubleshoot and in the dashboard's Needs Attention.
app.get('/api/diagnostics/notices', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        res.json({ notices: await getNbNotices({ forAdmin: !!viewer.isAdmin }) });
    } catch (err) {
        console.error('Error loading diagnostics notices:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin "Ignore": hides the notice (and older rows of the same issue) for EVERYONE.
app.post('/api/diagnostics/notices/:id/dismiss', requireAdmin, async (req, res) => {
    try {
        const out = await dismissNbNotification(req.params.id);
        audit(await getViewer(req), 'notice.dismiss', String(req.params.id), { hidden: out.dismissed });
        res.json({ ok: true, ...out });
    } catch (err) {
        console.error('Error dismissing notice:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Hosts for the browser-side checks + "which device am I probably on" (request-IP match).
app.get('/api/diagnostics/info', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const seesAll = viewer.isAdmin || (viewer.perms && (viewer.perms['peers.all'] || viewer.perms['networks.manage'] || viewer.perms['troubleshoot.all']));
        const who = await diagWhoAmI(req.ip, seesAll ? null : (viewer.oid || viewer.user_id || '__none__'));
        res.json({ hosts: diagHosts(), ...who });
    } catch (err) {
        console.error('Error loading diagnostics info:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Server-side health picture of one device.
app.get('/api/diagnostics/device', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const peerId = String(req.query.peer_id || '');
        if (!peerId) return res.status(400).json({ error: 'peer_id is required' });
        if (!(await canDiagnosePeer(viewer, peerId))) return res.status(403).json({ error: 'Forbidden' });
        const out = await diagnoseDevice(peerId);
        if (!out) return res.status(404).json({ error: 'Peer not found' });
        res.json(out);
    } catch (err) {
        console.error('Error diagnosing device:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Access-path analysis: can this device reach that target, and if not - why.
app.get('/api/diagnostics/target', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const peerId = String(req.query.peer_id || '');
        const type = String(req.query.type || 'resource');
        const id = String(req.query.id || '');
        if (!peerId || !id) return res.status(400).json({ error: 'peer_id and id are required' });
        if (!(await canDiagnosePeer(viewer, peerId))) return res.status(403).json({ error: 'Forbidden' });
        const out = await diagnoseTarget(peerId, { type, id });
        if (!out) return res.status(404).json({ error: 'Peer not found' });
        res.json(out);
    } catch (err) {
        console.error('Error diagnosing target:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Free-form address check: "is 10.20.0.5:8080 routed through NetBird, and do I have
// access?" The address is validated here and only ever compared/probed against declared
// NetBird resources and routes (diagnoseAddress refuses to probe uncovered hosts).
app.get('/api/diagnostics/address', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const peerId = String(req.query.peer_id || '');
        const address = String(req.query.address || '').trim().slice(0, 260);
        if (!peerId || !address) return res.status(400).json({ error: 'peer_id and address are required' });
        if (!/^[A-Za-z0-9.:*/_-]+$/.test(address)) return res.status(400).json({ error: 'Invalid address' });
        if (!(await canDiagnosePeer(viewer, peerId))) return res.status(403).json({ error: 'Forbidden' });
        const out = await diagnoseAddress(peerId, address);
        if (!out) return res.status(404).json({ error: 'Peer not found' });
        res.json(out);
    } catch (err) {
        console.error('Error diagnosing address:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// The Windows diagnostics script, for the local checks a browser cannot perform
// (service state, tunnel adapter, firewall, client log, MTU probing). Lives in
// backend/scripts (tracked in git; the Dockerfile copies it to ./scripts in the image,
// which is the same path relative to server.js in both dev and the container).
app.get('/api/diagnostics/script', (req, res) => {
    const path = require('path');
    const fs = require('fs');
    const p = path.join(__dirname, 'scripts', 'Diagnose-NetBird.ps1');
    if (fs.existsSync(p)) return res.download(p, 'Diagnose-NetBird.ps1');
    res.status(404).json({ error: 'Script not available on this deployment' });
});

// Remove a compliance bypass (EDR) so the device is blocked again until it passes the
// checks. Admins may remove any bypass; a regular user only on their OWN device.
app.post('/api/peers/:id/revoke-bypass', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        await ensurePeersFresh();
        const peer = await getPeerDetail(req.params.id);
        if (!peer) return res.status(404).json({ error: 'Peer not found' });
        if (!viewer.isAdmin) {
            const ownsByOid = viewer.oid && (peer.user_id === viewer.oid || peer.user_id.endsWith('|' + viewer.oid));
            const ownsById = viewer.user_id && peer.user_id === viewer.user_id;
            if (!ownsByOid && !ownsById) return res.status(403).json({ error: 'Forbidden' });
        }
        await revokePeerBypass(req.params.id);
        // REVOKE MEMORY: if this bypass was applied AUTOMATICALLY by an OS rule, remember the peer
        // for this account - it is never auto-bypassed again (no war with the admin). A timed auto
        // bypass that merely EXPIRED is not affected and still renews while the rule stays on.
        const wasAuto = await noteEdrAutoBypassRevoked(req.params.id).catch(() => false);
        audit(viewer, 'peer.bypass_revoke', peer.name || req.params.id, {
            device: peer.name || req.params.id, ip: peer.ip || '',
            auto: wasAuto ? 'was applied automatically - this device is now excluded from automatic EDR bypass' : undefined,
        });
        res.json({ ok: true, autoBypassExcluded: wasAuto });
    } catch (err) {
        console.error('Error removing bypass:', err.message);
        res.status(400).json({ error: err.message || 'Failed to remove the bypass' });
    }
});

// ─── Device tags & notes (operational metadata, stored app-side) ───
app.put('/api/peers/:id/meta', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        res.json(await setPeerMeta(req.params.id, { note: b.note, tags: b.tags }, await getViewer(req)));
    } catch (err) {
        console.error('Error saving peer meta:', err.message);
        res.status(400).json({ error: err.message || 'Failed to save' });
    }
});
// Bulk-add tags to the selected devices (merge - existing tags and notes untouched).
app.post('/api/peers/bulk-tags', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        res.json(await bulkTagPeers(b.ids, b.tags, await getViewer(req)));
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to tag devices' });
    }
});

// Distinct tags in use (for the Peers tag filter + editor suggestions). Only meaningful
// for viewers who see the whole fleet - others get an empty list.
app.get('/api/peer-tags', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const seesAll = viewer.isAdmin || (viewer.perms && (viewer.perms['peers.all'] || viewer.perms['networks.manage']));
        res.json(seesAll ? await getAllPeerTags() : []);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Groups list (NetBird /api/groups) with usage counts - admin only. Keeps the
// users cache warm first so users_count is accurate.
app.get('/api/groups', async (req, res, next) => {
    // Needed by Temporary Access (group targets) AND by network management (routing peers by
    // peer-group) - either capability unlocks it; admins always pass.
    const viewer = await getViewer(req).catch(() => null);
    if (viewer && (viewer.isAdmin || (viewer.perms && (viewer.perms['temp.manage'] || viewer.perms['networks.manage'])))) return next();
    return res.status(403).json({ error: 'Forbidden' });
}, async (req, res) => {
    try {
        await ensureUsersFresh();
        res.json(await getGroups());
    } catch (err) {
        console.error('Error listing groups:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Expanded detail for one group (group detail page) - admin only.
app.get('/api/groups/:id', requireAdmin, async (req, res) => {
    try {
        await Promise.all([ensureUsersFresh(), ensurePeersFresh()]);
        const detail = await getGroupDetail(req.params.id);
        if (!detail) return res.status(404).json({ error: 'Group not found' });
        res.json(detail);
    } catch (err) {
        console.error('Error loading group detail:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete a group (admin only). Blocks the "All" group and surfaces NetBird's in-use error.
// Create a group (admin; official-dashboard parity). Works in tenant context too.
app.post('/api/groups', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const g = await createGroup((req.body || {}).name);
        audit(await getViewer(req), 'group.create', (g && g.name) || String((req.body || {}).name || ''));
        res.json(g);
    } catch (err) {
        console.error('Error creating group:', err.message);
        res.status(err.message && /required|too long/.test(err.message) ? 400 : 502).json({ error: err.message || 'Failed to create group' });
    }
});

app.delete('/api/groups/:id', requireAdmin, async (req, res) => {
    try {
        const label = await labelBeforeDelete('group', req.params.id);
        const out = await deleteGroup(req.params.id);
        audit(await getViewer(req), 'group.delete', label);
        res.json(out);
    } catch (err) {
        console.error('Error deleting group:', err.message);
        res.status(400).json({ error: err.message || 'Failed to delete group' });
    }
});

// Bulk-delete several groups at once (admin only). Each goes through deleteGroup, so the
// "All" group and groups still referenced by policies/routes/DNS are skipped with a reason.
app.post('/api/groups/bulk-delete', requireAdmin, async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const ids = Array.isArray(req.body && req.body.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
        if (!ids.length) return res.status(400).json({ error: 'ids is required' });
        let deleted = 0;
        const failed = [];
        for (const gid of ids) {
            try { await deleteGroup(gid); deleted++; }
            catch (e) { failed.push({ id: gid, error: e.message }); }
        }
        audit(viewer, 'group.bulk_delete', `${deleted} group(s)`, { deleted, failed: failed.length, ids });
        res.json({ deleted, failed });
    } catch (err) {
        console.error('Error bulk-deleting groups:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete groups' });
    }
});

// Replace a group's PEER membership (official dashboard: PUT /api/groups/{id} with the FULL desired
// peer id list - the frontend computes it for both add and remove). Admin only, read-only-guarded.
// The auto-managed "All" group is rejected (400) inside setGroupPeers.
// Rename a group (official: the header pencil). Only API-created groups; the "All" group and
// IdP-issued groups are rejected (400).
app.post('/api/groups/:id/rename', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await renameGroup(req.params.id, (req.body || {}).name);
        audit(await getViewer(req), 'group.rename', out.name, {});
        res.json(out);
    } catch (err) {
        console.error('Error renaming group:', err.message);
        res.status(err.status || 502).json({ error: err.message || 'Failed to rename the group' });
    }
});

app.post('/api/groups/:id/peers', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const peers = Array.isArray(req.body && req.body.peers) ? req.body.peers : null;
        if (!peers) return res.status(400).json({ error: 'peers (array) is required' });
        const out = await setGroupPeers(req.params.id, peers);
        audit(await getViewer(req), 'group.peers', out.name, { count: out.count });
        res.json(out);
    } catch (err) {
        console.error('Error setting group peers:', err.message);
        res.status(err.status || 502).json({ error: err.message || 'Failed to update the group' });
    }
});

// Add/remove USERS to/from a group (official dashboard: per-user PUT /api/users/{id} with the
// updated auto_groups - group membership for users lives on the user, not the group). Body:
// { add?: string[], remove?: string[] } of user ids. Admin only, read-only-guarded. Best-effort
// per user; failures are reported. The auto-managed "All" group is rejected (400).
app.post('/api/groups/:id/users', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const add = Array.isArray(req.body && req.body.add) ? req.body.add : [];
        const remove = Array.isArray(req.body && req.body.remove) ? req.body.remove : [];
        if (!add.length && !remove.length) return res.status(400).json({ error: 'add or remove (array) is required' });
        const gid = req.params.id;
        const g = await netbirdGet('/api/groups/' + encodeURIComponent(gid)).catch(() => null);
        if (g && g.name === 'All') return res.status(400).json({ error: 'The "All" group is managed automatically - its members cannot be changed.' });
        const label = (g && g.name) || gid;
        const addRes = add.length ? await addUsersToGroup(gid, add) : { updated: 0, failed: [] };
        const remRes = remove.length ? await removeUsersFromGroup(gid, remove) : { updated: 0, failed: [] };
        const failed = [...addRes.failed, ...remRes.failed];
        audit(await getViewer(req), 'group.users', label, { added: addRes.updated, removed: remRes.updated, failed: failed.length });
        res.json({ ok: true, added: addRes.updated, removed: remRes.updated, failed });
    } catch (err) {
        console.error('Error updating group users:', err.message);
        res.status(err.status || 502).json({ error: err.message || 'Failed to update the group users' });
    }
});

// Networks list. Admins see all (with the AD groups granted edit access); regular
// users see only the networks they may edit. Each item carries a `canEdit` flag.
app.get('/api/networks', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const [networks, grants] = await Promise.all([getNetworks(), getAllGrants()]);
        // Resolve granted AD group ids → names for the admin UI
        let groupNames = {};
        if (viewer.isAdmin) {
            const adGroups = await getAdGroups().catch(() => []);
            for (const g of adGroups) groupNames[g.id] = g.name;
        }
        const out = networks
            .map(n => {
                const grantedList = grants[n.id] || [];
                return {
                    ...n,
                    canEdit: canEditNetwork(viewer, n.id, grants),
                    canView: canViewNetwork(viewer, n.id, grants),
                    grants: viewer.isAdmin ? grantedList.map(g => ({ id: g.id, name: groupNames[g.id] || g.id, access: g.access })) : undefined,
                };
            })
            .filter(n => viewer.isAdmin || n.canView);

        // Diagnostic: a non-admin who sees nothing while grants exist usually means a
        // group-id mismatch (or Graph/NetBird groups not synced for this user).
        if (!viewer.isAdmin && out.length === 0) {
            const allGranted = [...new Set(Object.values(grants).flat().map(g => g.id))];
            if (allGranted.length) {
                console.log(`[Networks] ${viewer.email || viewer.oid || 'user'} sees no networks. ` +
                    `sources → graph:${(viewer.adGroups || []).length} auto_groups:${(viewer.netbirdGroups || []).length} peerGroups:${(viewer.peerGroups || []).length} | ` +
                    `viewer groups (${(viewer.groups || []).length}): ${(viewer.groups || []).join(', ') || '∅'} | ` +
                    `granted ids: ${allGranted.join(', ')}`);
            }
        }
        res.json(out);
    } catch (err) {
        console.error('Error listing networks:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a new network (admin, or the 'networks.manage' permission)
app.post('/api/networks', requirePerm('networks.manage'), async (req, res) => {
    try {
        const { name, description } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
        const out = await createNetwork({ name: String(name).trim(), description: description || '' });
        audit(await getViewer(req), 'network.create', String(name).trim());
        res.json(out);
    } catch (err) {
        console.error('Error creating network:', err.message);
        res.status(502).json({ error: err.message || 'Failed to create network' });
    }
});

// Update a network (admin only): name/description go to NetBird; allowDuplicates is the
// app-side per-network opt-out of the duplicate/overlapping-address guard.
app.put('/api/networks/:id', requirePerm('networks.manage'), async (req, res) => {
    try {
        const { name, description, allowDuplicates } = req.body || {};
        let out = null;
        if (name !== undefined || description !== undefined) {
            if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
            out = await updateNetwork(req.params.id, { name: String(name).trim(), description: description || '' });
        }
        if (allowDuplicates !== undefined) await setNetworkAllowDuplicates(req.params.id, !!allowDuplicates);
        audit(await getViewer(req), 'network.update', (name && String(name).trim()) || req.params.id,
            allowDuplicates !== undefined ? { allowDuplicates: !!allowDuplicates } : undefined);
        res.json(out || { ok: true });
    } catch (err) {
        console.error('Error updating network:', err.message);
        res.status(502).json({ error: err.message || 'Failed to update network' });
    }
});

// Delete a network and everything in it (admin, or the 'networks.manage' permission).
// Cascades resources + routers, cleaning up each resource's auto-created policy/group.
app.delete('/api/networks/:id', requirePerm('networks.manage'), async (req, res) => {
    try {
        const label = await labelBeforeDelete('network', req.params.id);
        const out = await deleteNetwork(req.params.id);
        audit(await getViewer(req), 'network.delete', label);
        res.json(out);
    } catch (err) {
        console.error('Error deleting network:', err.message);
        res.status(400).json({ error: err.message || 'Failed to delete network' });
    }
});

// AD groups available for granting edit access (admin only)
app.get('/api/ad-groups', requireAdmin, async (req, res) => {
    try {
        res.json(await getAdGroups());
    } catch (err) {
        console.error('Error listing AD groups:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Set which AD groups may edit/view a network (admin only). Body: { grants: [{id, access}] };
// a legacy { groupIds: [...] } body is accepted as all-edit grants.
app.put('/api/networks/:id/grants', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const grants = Array.isArray(body.grants)
            ? body.grants
            : (Array.isArray(body.groupIds) ? body.groupIds.map(id => ({ id, access: 'edit' })) : []);
        const saved = await setNetworkGrants(req.params.id, grants);
        const viewCount = saved.filter(g => g.access === 'view').length;
        audit(await getViewer(req), 'network.grants', await netLabel(req.params.id), { groupCount: saved.length, viewCount });
        res.json({ network_id: req.params.id, grants: saved });
    } catch (err) {
        console.error('Error saving network grants:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Template options (for the Add-resource form) - any logged-in user
app.get('/api/templates', async (req, res) => {
    try {
        res.json({ templates: await getTemplates() });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Template management (admin only)
app.post('/api/templates', requireAdmin, async (req, res) => {
    try {
        const { name, protocol, ports, description } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required' });
        const t = await createTemplate({ name, protocol, ports, description });
        audit(await getViewer(req), 'template.create', name, { protocol, ports });
        res.json(t);
    } catch (err) {
        console.error('Error creating template:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/templates/:id', requireAdmin, async (req, res) => {
    try {
        const { name, protocol, ports, description } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required' });
        const t = await updateTemplate(parseInt(req.params.id, 10), { name, protocol, ports, description });
        audit(await getViewer(req), 'template.update', name, { protocol, ports });
        res.json(t);
    } catch (err) {
        console.error('Error updating template:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/templates/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const existing = await getTemplate(id);
        await deleteTemplate(id);
        audit(await getViewer(req), 'template.delete', existing ? existing.name : String(id));
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error deleting template:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Event filtering rules (admin) - which webhook traffic events are discarded ──
const FILTER_FIELDS = ['any_addr', 'source_addr', 'destination_addr', 'source_name', 'destination_name', 'protocol', 'direction', 'port'];
const FILTER_OPERATORS = ['contains', 'equals', 'starts_with', 'ends_with', 'regex'];

app.get('/api/filter-rules', requireAdmin, async (req, res) => {
    try {
        res.json({ rules: await getFilterRules(), builtinNoise: await getBuiltinNoise(), fields: FILTER_FIELDS, operators: FILTER_OPERATORS });
    } catch (err) {
        console.error('Error loading filter rules:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function validateRule(body) {
    const { field, operator, value } = body || {};
    if (!FILTER_FIELDS.includes(field)) return 'invalid field';
    if (!FILTER_OPERATORS.includes(operator || 'contains')) return 'invalid operator';
    if (operator !== 'regex' && !String(value || '').trim()) return 'value is required';
    return null;
}

app.post('/api/filter-rules', requireAdmin, async (req, res) => {
    try {
        const err = validateRule(req.body);
        if (err) return res.status(400).json({ error: err });
        const b = req.body || {};
        const r = await createFilterRule(b);
        audit(await getViewer(req), 'filter.create', `${b.field} ${b.operator} ${b.value}`.trim());
        res.json(r);
    } catch (e) {
        console.error('Error creating filter rule:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/filter-rules/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const out = await updateFilterRule(id, req.body || {});
        const b = req.body || {};
        audit(await getViewer(req), 'filter.update', `${b.field || ''} ${b.operator || ''} ${b.value || ''}`.trim() || `#${id}`);
        res.json(out);
    } catch (e) {
        console.error('Error updating filter rule:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/filter-rules/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await deleteFilterRule(id);
        audit(await getViewer(req), 'filter.delete', `#${id}`);
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Error deleting filter rule:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Toggle the built-in broadcast/multicast noise filter
app.put('/api/filter-rules/settings/builtin-noise', requireAdmin, async (req, res) => {
    try {
        const enabled = !(req.body && req.body.enabled === false);
        await setBuiltinNoise(enabled);
        audit(await getViewer(req), 'filter.builtin_noise', enabled ? 'enabled' : 'disabled');
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Error saving builtin-noise setting:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Purge stored events that match the filters (already-ingested "garbage") ───
// Restricted beyond requireAdmin to the EVENT_PURGE_ADMINS allow-list (destructive).
const SCAN_BATCH = 5000;

// Preview: scan the whole events table in batches, count rows that match the current filters,
// and return a small sample so the operator can verify before deleting.
app.get('/api/filter-rules/matching', requirePurgeAdmin, async (req, res) => {
    try {
        const cfg = await getFilterConfig();
        const SAMPLE = 100;
        let after = '', total = 0, scanned = 0;
        const sample = [];
        for (;;) {
            const rows = await scanEvents(after, SCAN_BATCH);
            if (!rows.length) break;
            scanned += rows.length;
            for (const row of rows) {
                if (eventMatchesFilters(row, cfg)) {
                    total++;
                    if (sample.length < SAMPLE) sample.push(row);
                }
            }
            after = rows[rows.length - 1].id;
            if (rows.length < SCAN_BATCH) break;
        }
        res.json({ total, scanned, sample });
    } catch (e) {
        console.error('Error scanning matching events:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete every stored event that matches the current filters. Audited.
app.post('/api/filter-rules/purge', requirePurgeAdmin, async (req, res) => {
    try {
        const cfg = await getFilterConfig();
        let after = '', deleted = 0;
        for (;;) {
            const rows = await scanEvents(after, SCAN_BATCH);
            if (!rows.length) break;
            after = rows[rows.length - 1].id;
            const ids = rows.filter(r => eventMatchesFilters(r, cfg)).map(r => r.id);
            if (ids.length) deleted += await deleteEventsByIds(ids);
            if (rows.length < SCAN_BATCH) break;
        }
        audit(await getViewer(req), 'events.purge_matched', '', { deleted });
        res.json({ deleted });
    } catch (e) {
        console.error('Error purging matching events:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Apply main's filter rules to every tenant (REPLACE semantics) - main account only ───
// Overwrites each tenant's own rules + built-in-noise toggle with a copy of main's. Refused in
// tenant context (the X-Tenant-Account header is present) - propagation runs from main only.
app.post('/api/filter-rules/propagate', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'Propagation runs from the main account only' });
    try {
        const out = await propagateFilterRules();
        audit(await getViewer(req), 'filter.propagate', '', { tenants: out.tenants, rules: out.rules });
        res.json(out);
    } catch (e) {
        console.error('Error propagating filter rules:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Address blocklist - list readable by any editor (for inline checks); admin manages ───
app.get('/api/blocklist', async (req, res) => {
    try {
        res.json(await getBlocklist());
    } catch (e) {
        console.error('Error listing blocklist:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/blocklist', requireAdmin, async (req, res) => {
    try {
        const value = req.body && req.body.value;
        if (!value || !String(value).trim()) return res.status(400).json({ error: 'value is required' });
        const out = await addBlocklistEntry(req.body);
        audit(await getViewer(req), 'blocklist.add', String(value).trim());
        res.json(out);
    } catch (e) {
        console.error('Error adding blocklist entry:', e.message);
        res.status(500).json({ error: e.message || 'Failed to add entry' });
    }
});

// Bulk add - e.g. addresses picked from a network's existing resources. Duplicates are skipped.
app.post('/api/blocklist/bulk', requireAdmin, async (req, res) => {
    try {
        const values = (req.body && req.body.values) || [];
        if (!Array.isArray(values) || !values.length) return res.status(400).json({ error: 'values is required' });
        const out = await addBlocklistEntries(values, req.body);
        const preview = values.slice(0, 8).map(v => String(v).trim()).filter(Boolean).join(', ');
        audit(await getViewer(req), 'blocklist.add',
            `${out.added} added${out.skipped ? ` · ${out.skipped} already blocked` : ''}: ${preview}${values.length > 8 ? '…' : ''}`);
        res.json(out);
    } catch (e) {
        console.error('Error bulk-adding blocklist entries:', e.message);
        res.status(500).json({ error: e.message || 'Failed to add entries' });
    }
});

app.put('/api/blocklist/:id', requireAdmin, async (req, res) => {
    try {
        const value = req.body && req.body.value;
        if (!value || !String(value).trim()) return res.status(400).json({ error: 'value is required' });
        await updateBlocklistEntry(parseInt(req.params.id, 10), req.body);
        audit(await getViewer(req), 'blocklist.update', String(value).trim());
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Error updating blocklist entry:', e.message);
        res.status(500).json({ error: e.message || 'Failed to update entry' });
    }
});

app.delete('/api/blocklist/:id', requireAdmin, async (req, res) => {
    try {
        await deleteBlocklistEntry(parseInt(req.params.id, 10));
        audit(await getViewer(req), 'blocklist.delete', `#${req.params.id}`);
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Error deleting blocklist entry:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Apply main's blocklist to every tenant (REPLACE semantics) - main account only ───
// Overwrites each tenant's own entries with a copy of main's, SKIPPING network-scoped entries
// ('only'/'except' reference main-account network ids that do not exist under a tenant). Refused
// in tenant context (the X-Tenant-Account header is present) - propagation runs from main only.
app.post('/api/blocklist/propagate', requireAdmin, async (req, res) => {
    if (req.headers['x-tenant-account']) return res.status(400).json({ error: 'Propagation runs from the main account only' });
    try {
        const out = await propagateBlocklist();
        audit(await getViewer(req), 'blocklist.propagate', '', { tenants: out.tenants, copied: out.copied, skipped: out.skipped });
        res.json(out);
    } catch (e) {
        console.error('Error propagating blocklist:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Scan existing NetBird resources for addresses matching an "enforce" blocklist entry (admin, read-only).
app.get('/api/blocklist/matching', requireAdmin, async (req, res) => {
    try {
        res.json(await scanBlockedResources());
    } catch (e) {
        console.error('Error scanning blocked resources:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Apply the blocklist to EXISTING resources - disable/delete matches. Destructive; blocked in read-only.
app.post('/api/blocklist/enforce', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true) - enforcing the blocklist would modify NetBird resources.' });
    try {
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
        const out = await enforceBlockedResources(ids);
        audit(await getViewer(req), 'blocklist.enforce', `${out.disabled} disabled · ${out.deleted} deleted`,
            { disabled: out.disabled, deleted: out.deleted, skipped: out.skipped, failed: out.failed, total: out.total });
        res.json(out);
    } catch (e) {
        console.error('Error enforcing blocklist:', e.message);
        res.status(500).json({ error: e.message || 'Failed to enforce blocklist' });
    }
});

// ─── Temporary access grants (admin only; NetBird writes blocked in read-only) ───
// ─── Recurring access rules (spawn a normal temp grant on each scheduled window) ───
app.get('/api/recurring-access', requirePerm('temp.manage'), async (req, res) => {
    try {
        res.json(await listRecurringAccess());
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.post('/api/recurring-access', requirePerm('temp.manage'), async (req, res) => {
    try {
        res.json(await createRecurringAccess(req.body || {}, await getViewer(req)));
    } catch (e) {
        res.status(400).json({ error: e.message || 'Failed to create rule' });
    }
});
app.put('/api/recurring-access/:id', requirePerm('temp.manage'), async (req, res) => {
    try {
        res.json(await updateRecurringAccess(parseInt(req.params.id, 10), req.body || {}, await getViewer(req)));
    } catch (e) {
        res.status(400).json({ error: e.message || 'Failed to update rule' });
    }
});
app.delete('/api/recurring-access/:id', requirePerm('temp.manage'), async (req, res) => {
    try {
        res.json(await deleteRecurringAccess(parseInt(req.params.id, 10), await getViewer(req)));
    } catch (e) {
        res.status(400).json({ error: e.message || 'Failed to delete rule' });
    }
});

app.get('/api/temporary-access', requirePerm('temp.manage'), async (req, res) => {
    try {
        res.json(await listTemporaryAccessGrants());
    } catch (e) {
        console.error('Error listing temporary access grants:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/temporary-access', requirePerm('temp.manage'), async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true) - granting access is disabled.' });
    try {
        const out = await createTemporaryAccessGrant(req.body || {}, await getViewer(req));
        res.json(out);
    } catch (e) {
        console.error('Error creating temporary access grant:', e.message);
        res.status(400).json({ error: e.message || 'Failed to grant access' });
    }
});

app.put('/api/temporary-access/:id', requirePerm('temp.manage'), async (req, res) => {
    try {
        const out = await extendTemporaryAccessGrant(parseInt(req.params.id, 10), req.body || {}, await getViewer(req));
        res.json(out);
    } catch (e) {
        console.error('Error extending temporary access grant:', e.message);
        res.status(400).json({ error: e.message || 'Failed to extend grant' });
    }
});

app.post('/api/temporary-access/:id/revoke', requirePerm('temp.manage'), async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true) - revoking access is disabled.' });
    try {
        const out = await revokeTemporaryAccessGrant(parseInt(req.params.id, 10), { trigger: 'manual', actor: await getViewer(req) });
        if (out && out.error) return res.status(500).json({ error: out.error });
        res.json(out);
    } catch (e) {
        console.error('Error revoking temporary access grant:', e.message);
        res.status(500).json({ error: e.message || 'Failed to revoke grant' });
    }
});

app.delete('/api/temporary-access/:id', requirePerm('temp.manage'), async (req, res) => {
    try {
        res.json(await deleteTemporaryAccessGrant(parseInt(req.params.id, 10)));
    } catch (e) {
        console.error('Error deleting temporary access grant:', e.message);
        res.status(400).json({ error: e.message || 'Failed to delete grant' });
    }
});

// Create a new client (resource + policy) in a network - admins or permitted users
app.post('/api/networks/:id/resources', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const grants = await getAllGrants();
        if (!canEditNetwork(viewer, req.params.id, grants)) {
            return res.status(403).json({ error: 'Forbidden - you cannot edit this network' });
        }
        const { name, address, description, groups, policies } = req.body || {};
        if (!name || !address) return res.status(400).json({ error: 'name and address are required' });
        // Blocklist blocks everyone EXCEPT admins - an admin may knowingly override (audited).
        const blocked = addressBlockedForNetwork(address, req.params.id, await getBlocklist());
        if (blocked && !viewer.isAdmin) return res.status(400).json({ error: `Address "${address}" is blocked for this network (matches "${blocked}" on the blocklist).` });
        if (blocked) audit(viewer, 'blocklist.override', name, { network: await netLabel(req.params.id), address, rule: blocked });

        const finalPolicies = await resolvePolicySources(viewer, req.params.id, grants, policies);
        const result = await createClientResource(req.params.id, { name, address, description, groups, policies: finalPolicies, allowBlocked: viewer.isAdmin });
        console.log(`[${new Date().toISOString()}] ${viewer.email || 'user'} added resource "${name}" (${address}) to network ${req.params.id}`);
        audit(viewer, 'resource.create', name, { network: await netLabel(req.params.id), address, policies: (finalPolicies || []).length });
        res.json({ status: 'ok', ...result });
    } catch (err) {
        console.error('Error creating resource:', err.message);
        res.status(err.status === 400 ? 400 : 502).json({ error: err.message || 'Failed to create resource' });
    }
});

// Edit a resource - admins or permitted users
app.put('/api/networks/:id/resources/:rid', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const grants = await getAllGrants();
        if (!canEditNetwork(viewer, req.params.id, grants)) return res.status(403).json({ error: 'Forbidden' });
        const { name, address, description, groups, policies, enabled } = req.body || {};
        if (!name || !address) return res.status(400).json({ error: 'name and address are required' });
        // Blocklist blocks everyone EXCEPT admins - an admin may knowingly override (audited).
        const blocked = addressBlockedForNetwork(address, req.params.id, await getBlocklist());
        if (blocked && !viewer.isAdmin) return res.status(400).json({ error: `Address "${address}" is blocked for this network (matches "${blocked}" on the blocklist).` });
        if (blocked) audit(viewer, 'blocklist.override', name, { network: await netLabel(req.params.id), address, rule: blocked });
        // The policy replacement below must not change access it can't reproduce - check it BEFORE
        // saving anything, so a refusal leaves the resource and its policies untouched.
        if (policies !== undefined) await checkResourcePolicySync(req.params.rid, policies);
        const out = await editResource(req.params.id, req.params.rid, { name, address, description, groups, enabled, allowBlocked: viewer.isAdmin });
        // Replace the resource's access policies (source groups / protocol / ports) if provided
        let policyError = null;
        if (policies !== undefined) {
            const finalPolicies = await resolvePolicySources(viewer, req.params.id, grants, policies);
            await syncResourcePolicies(req.params.id, req.params.rid, finalPolicies).catch(e => { console.error('Policy sync:', e.message); policyError = e; });
        }
        audit(viewer, 'resource.update', name, { network: await netLabel(req.params.id), address, ...(policyError ? { policySyncFailed: policyError.message } : {}) });
        // The resource itself is saved at this point; say plainly that its access policies are not.
        if (policyError) {
            const what = policyError.partial
                ? 'its access policies were only partly updated - review them on the Policies page'
                : 'its access policies were not changed';
            return res.status(policyError.status === 409 ? 409 : 502).json({ error: `The resource was saved, but ${what}: ${policyError.message}`, partial: true, resource: out });
        }
        res.json({ status: 'ok', resource: out });
    } catch (err) {
        console.error('Error editing resource:', err.message);
        res.status(err.status === 400 || err.status === 409 ? err.status : 502).json({ error: err.message || 'Failed to edit resource' });
    }
});

// Enable / disable a resource (the official dashboard's Disable action) - admins or permitted
// users. A disabled resource stays configured but is unreachable until re-enabled.
app.post('/api/networks/:id/resources/:rid/enabled', async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const viewer = await getViewer(req);
        const grants = await getAllGrants();
        if (!canEditNetwork(viewer, req.params.id, grants)) return res.status(403).json({ error: 'Forbidden' });
        const enabled = !!(req.body && req.body.enabled);
        const out = await setResourceEnabled(req.params.id, req.params.rid, enabled);
        audit(viewer, 'resource.update', (out && out.name) || req.params.rid, { network: await netLabel(req.params.id), enabled });
        res.json({ status: 'ok', resource: out });
    } catch (err) {
        console.error('Error toggling resource:', err.message);
        res.status(502).json({ error: err.message || 'Failed to update resource' });
    }
});

// Delete a resource (+ cleanup of its auto-created policy/group) - admins or permitted users
app.delete('/api/networks/:id/resources/:rid', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const grants = await getAllGrants();
        if (!canEditNetwork(viewer, req.params.id, grants)) return res.status(403).json({ error: 'Forbidden' });
        // Resolve the resource's NAME before it's gone - the audit target should be readable.
        let rname = req.params.rid;
        try { rname = (((await getNetworkDetail(req.params.id)).resources || []).find(r => r && r.id === req.params.rid) || {}).name || rname; } catch { /* keep the id */ }
        await deleteResource(req.params.id, req.params.rid);
        console.log(`[${new Date().toISOString()}] ${viewer.email || 'user'} deleted resource ${req.params.rid} from network ${req.params.id}`);
        audit(viewer, 'resource.delete', rname, { network: await netLabel(req.params.id) });
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error deleting resource:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete resource' });
    }
});

// Billed users (from the latest stored NetBird "billing usage updated" event) - admin only.
app.get('/api/billing-summary', requireAdmin, async (req, res) => {
    try {
        res.json(await getBillingSummary());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Duplicate-address conflict scan: same-address resources whose audiences overlap - the
// users named here get nondeterministic access. Feeds the network-page warning banner
// and the dashboard's Needs Attention feed.
app.get('/api/resource-conflicts', requirePerm('networks.manage'), async (req, res) => {
    try {
        res.json({ conflicts: await scanResourceConflicts() });
    } catch (err) {
        console.error('Error scanning resource conflicts:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Report-only hygiene sweep (Cleanup page): dangling policies, groups unused everywhere,
// unreachable resources, long-unseen devices. Reads caches only - never deletes anything.
app.get('/api/cleanup-scan', requireAdmin, async (req, res) => {
    try {
        res.json(await scanCleanup({ staleDays: parseInt(req.query.stale_days, 10) || 30 }));
    } catch (err) {
        console.error('Error running cleanup scan:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Mark / unmark a Cleanup finding as deliberately ignored (e.g. a resource kept WITHOUT
// default policies on purpose, reachable only via access requests). Audited.
app.post('/api/cleanup-scan/ignore', requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const viewer = await getViewer(req);
        const ignore = b.ignore !== false;
        await setCleanupIgnore({ category: b.category, id: b.id, ignore }, viewer);
        audit(viewer, ignore ? 'cleanup.ignore' : 'cleanup.unignore', `${b.category}: ${b.name || b.id}`);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to update ignore' });
    }
});

// Merge duplicate resources (identical address) into one: policies re-pointed at the
// survivor, group memberships unioned, the rest deleted. Fixes NetBird's nondeterministic
// handling of several resources sharing one address.
app.post('/api/networks/:id/resources/merge', requirePerm('networks.manage'), async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
        const out = await mergeResources(req.params.id, ids, req.body && req.body.keepId);
        audit(await getViewer(req), 'resource.merge', out.keptName, {
            network: await netLabel(out.keptNetworkId || req.params.id),
            merged: out.deleted.join(', '),
            movedPolicies: out.movedPolicies,
            ...(out.crossNetwork ? { crossNetwork: 'yes - all traffic now routes via the surviving network' } : {}),
        });
        res.json(out);
    } catch (err) {
        console.error('Error merging resources:', err.message);
        res.status(err.status === 409 ? 409 : 502).json({ error: err.message || 'Failed to merge resources' });
    }
});

// Move resources to ANOTHER network: recreate there (name/address/groups/enabled), re-point
// every policy targeting them, delete the originals - per-resource, with rollback on failure.
app.post('/api/networks/:id/resources/move', requirePerm('networks.manage'), async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
        const out = await moveResources(req.params.id, ids, req.body && req.body.targetNetworkId);
        audit(await getViewer(req), 'resource.move', out.moved.join(', ') || `${ids.length} resource(s)`, {
            from: await netLabel(req.params.id),
            to: out.targetNetworkName,
            ...(out.failed.length ? { failed: out.failed.map(f => `${f.name} (${f.error})`).join(' · ') } : {}),
        });
        res.json(out);
    } catch (err) {
        console.error('Error moving resources:', err.message);
        res.status(err.status === 409 ? 409 : 502).json({ error: err.message || 'Failed to move resources' });
    }
});

// Bulk-delete several resources at once (each removes its dedicated policy/group too).
// Admin only - regular network editors can still delete resources one at a time.
app.post('/api/networks/:id/resources/bulk-delete', requirePerm('networks.manage'), async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const ids = Array.isArray(req.body && req.body.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
        if (!ids.length) return res.status(400).json({ error: 'ids is required' });
        let deleted = 0;
        const failed = [];
        for (const rid of ids) {
            try { await deleteResource(req.params.id, rid); deleted++; }
            catch (e) { failed.push({ id: rid, error: e.message }); }
        }
        console.log(`[${new Date().toISOString()}] ${viewer.email || 'user'} bulk-deleted ${deleted}/${ids.length} resources from network ${req.params.id}`);
        audit(viewer, 'resource.bulk_delete', `${deleted} resource(s)`, { network: await netLabel(req.params.id), deleted, failed: failed.length });
        res.json({ deleted, failed });
    } catch (err) {
        console.error('Error bulk-deleting resources:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete resources' });
    }
});

// All network grants (admin panel) - admin only
app.get('/api/network-grants', requireAdmin, async (req, res) => {
    try {
        res.json(await getAllGrants());
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add a routing peer (router) to a network - peer or peer group(s)
app.post('/api/networks/:id/routers', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const grants = await getAllGrants();
        if (!canEditNetwork(viewer, req.params.id, grants)) return res.status(403).json({ error: 'Forbidden - you cannot edit this network' });
        const { peer, peerGroups, metric, masquerade, enabled } = req.body || {};
        if (!peer && !(Array.isArray(peerGroups) && peerGroups.length)) {
            return res.status(400).json({ error: 'a peer or at least one peer group is required' });
        }
        const out = await createNetworkRouter(req.params.id, { peer, peerGroups, metric, masquerade, enabled });
        audit(viewer, 'router.create', peer || (peerGroups || []).join(', '), { network: await netLabel(req.params.id) });
        res.json({ status: 'ok', router: out });
    } catch (err) {
        console.error('Error adding routing peer:', err.message);
        res.status(502).json({ error: err.message || 'Failed to add routing peer' });
    }
});

// Delete a routing peer (router) from a network
app.delete('/api/networks/:id/routers/:rid', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const grants = await getAllGrants();
        if (!canEditNetwork(viewer, req.params.id, grants)) return res.status(403).json({ error: 'Forbidden' });
        await deleteNetworkRouter(req.params.id, req.params.rid);
        audit(viewer, 'router.delete', req.params.rid, { network: await netLabel(req.params.id) });
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Error deleting routing peer:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete routing peer' });
    }
});

// Source-group options for the resource policy editor. Both admins and regular editors
// get the network's granted groups pre-selected by default; admins may additionally
// pick from all NetBird groups and edit the selection, regular editors are locked to it.
app.get('/api/networks/:id/policy-options', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const grants = await getAllGrants();
        if (!canEditNetwork(viewer, req.params.id, grants) && !viewer.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const rows = grants[req.params.id] || [];
        const grantGroups = await resolveGrantGroups(rows.filter(g => g.access === 'edit' && g.policySource !== false).map(g => g.id));
        const defaultIds = grantGroups.map(g => g.id);
        const defaultProfileIds = await getNetworkDefaultProfiles(req.params.id);
        if (viewer.isAdmin || managesNetworks(viewer)) {
            res.json({ canChoose: true, groups: await getNetbirdGroups(), defaultIds, defaultProfileIds });
        } else {
            // Editors: the admin-curated 'source' (grantable) groups unlock a REAL picker,
            // limited to defaults + grantable. No grantable groups configured = the old
            // locked behavior.
            const grantable = await resolveGrantGroups(rows.filter(g => g.access === 'source').map(g => g.id));
            const seen = new Set();
            const groups = [...grantGroups, ...grantable].filter(g => !seen.has(g.id) && seen.add(g.id));
            res.json({ canChoose: grantable.length > 0, groups, defaultIds, defaultProfileIds });
        }
    } catch (err) {
        console.error('Error loading policy options:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Full detail of one network - admins, or users granted edit OR view access. The page
// renders read-only for view-only users (driven by the list item's `canEdit` flag).
app.get('/api/networks/:id/detail', async (req, res) => {
    try {
        const viewer = await getViewer(req);
        const grants = await getAllGrants();
        if (!canViewNetwork(viewer, req.params.id, grants)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        res.json(await getNetworkDetail(req.params.id));
    } catch (err) {
        console.error('Error loading network detail:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// All access-control policies (read-only overview). Admin-only - this is global config.
app.get('/api/policies', requireAdmin, async (req, res) => {
    try {
        res.json(await getAllPolicies());
    } catch (err) {
        console.error('Error loading policies:', err.message);
        res.status(500).json({ error: 'Failed to load policies' });
    }
});

// Validate the admin policy editor payload (shared by create + update).
function validatePolicyInput(body) {
    const b = body || {};
    if (!b.name || !String(b.name).trim()) return 'A policy name is required.';
    // preserveRules = multi-rule policy saved by the single-rule editor: only name /
    // description / enabled / posture change, the existing rules are kept verbatim -
    // there's nothing else to validate here.
    if (b.preserveRules) return null;
    // rulesFromPolicyId = Duplicate: the rules are copied server-side from that policy.
    if (b.rulesFromPolicyId) return typeof b.rulesFromPolicyId === 'string' && b.rulesFromPolicyId.trim() ? null : 'Invalid policy to duplicate.';
    if (!Array.isArray(b.sources) || !b.sources.filter(Boolean).length) return 'At least one source group is required.';
    // A rule targets EITHER destination groups OR one specific resource (destinationResource) -
    // resource-targeted policies (a resource's Access Control edited from the Policies page)
    // legitimately have no destination groups.
    const resourceTargeted = !!(b.destinationResource && (b.destinationResource.id || typeof b.destinationResource === 'string'));
    if (!resourceTargeted && (!Array.isArray(b.destinations) || !b.destinations.filter(Boolean).length)) return 'At least one destination group is required.';
    return null;
}

// Create an access-control policy (admin only).
app.post('/api/policies', requireAdmin, async (req, res) => {
    try {
        const err = validatePolicyInput(req.body);
        if (err) return res.status(400).json({ error: err });
        const out = await createPolicy(req.body);
        audit(await getViewer(req), 'policy.create', String(req.body.name).trim());
        res.json(out);
    } catch (err) {
        console.error('Error creating policy:', err.message);
        res.status(err.status === 400 ? 400 : 502).json({ error: err.message || 'Failed to create policy' });
    }
});

// Update an access-control policy (admin only).
app.put('/api/policies/:id', requireAdmin, async (req, res) => {
    try {
        const err = validatePolicyInput(req.body);
        if (err) return res.status(400).json({ error: err });
        const out = await updatePolicy(req.params.id, req.body);
        audit(await getViewer(req), 'policy.update', String(req.body.name || req.params.id).trim());
        res.json(out);
    } catch (err) {
        console.error('Error updating policy:', err.message);
        res.status(err.status === 400 ? 400 : 502).json({ error: err.message || 'Failed to update policy' });
    }
});

// Tidy Names: preview which resource policies would be renamed by the naming template.
app.get('/api/policies/tidy-names', requireAdmin, async (req, res) => {
    try {
        res.json(await policyRenamePlan());
    } catch (e) {
        console.error('Error planning policy renames:', e.message);
        res.status(500).json({ error: e.message || 'Failed to plan renames' });
    }
});

// Apply the selected renames. Re-plans server-side, so only current proposals are applied.
app.post('/api/policies/tidy-names', requireAdmin, async (req, res) => {
    if (NETBIRD_READONLY) return res.status(403).json({ error: 'This instance is read-only (NETBIRD_READONLY=true).' });
    try {
        const out = await applyPolicyRenames((req.body && req.body.ids) || []);
        audit(await getViewer(req), 'policy.rename', `${out.renamed} renamed${out.failed ? ` · ${out.failed} failed` : ''}`);
        res.json(out);
    } catch (e) {
        console.error('Error applying policy renames:', e.message);
        res.status(500).json({ error: e.message || 'Failed to rename policies' });
    }
});

// Delete an access-control policy (admin only).
app.delete('/api/policies/:id', requireAdmin, async (req, res) => {
    try {
        const label = await labelBeforeDelete('policy', req.params.id);
        const out = await deletePolicy(req.params.id);
        audit(await getViewer(req), 'policy.delete', label);
        res.json(out);
    } catch (err) {
        console.error('Error deleting policy:', err.message);
        res.status(502).json({ error: err.message || 'Failed to delete policy' });
    }
});

// Interactive API docs (Swagger UI) at /api/docs. The OpenAPI spec is introspected from the
// live router above, so it always matches the current routes. Admin-only (requireAdmin) so the
// endpoint list isn't exposed to regular users; "Try it out" reuses the admin's session.
{
    const swaggerUi = require('swagger-ui-express');
    const { buildOpenApiSpec } = require('./openapi');
    const spec = buildOpenApiSpec(app, { version: readVersion() });
    app.get('/api/docs/openapi.json', requireAdmin, (req, res) => res.json(spec));
    app.use('/api/docs', requireAdmin, swaggerUi.serve, swaggerUi.setup(spec, {
        customSiteTitle: 'NetBird Control API',
        customCss: '.swagger-ui .topbar { display: none }',
    }));
}

// Fallback to index.html for SPA
app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Last-resort error handler ───
// OIDC callback failures are usually transient: two concurrent logins raced, and one overwrote
// (state mismatch, rejected code) or consumed (missing auth_verification cookie) the other's
// transaction. A fresh attempt succeeds, so restart the login instead of showing an error.
// Up to MAX_LOGIN_RETRIES times: each restart goes through /login?retry=N, which stores N in the
// new login's state (getLoginState above), and a failure past the limit stops with a message.
// The count travels in the state URL parameter, not a cookie, so a browser that drops cookies
// can't loop. More than one retry because a session cap expiring sends every open tab to login at
// once, and the tabs keep overwriting each other's transaction until one finishes; the others
// then find a session (/login bounces them back). OAUTH_INVALID_RESPONSE also covers real
// provider errors (wrong alg, no id_token) - the limit bounds those too. Everything else gets a
// clean 500 - stack traces never reach the browser.
function oidcCallbackRecoverable(err) {
    if (!err) return false;
    if (err.error === 'invalid_grant' || err.error === 'OAUTH_INVALID_RESPONSE') return true;
    return String(err.message || '').startsWith('"auth_verification" cookie not found');
}
// The page a failed login started from. A login started by /login carries '/login?returnTo=<page>'
// (or '/login?retry=N&returnTo=<page>'): unwrap it, so restarts don't nest one level per attempt.
function loginStateReturnTo(state) {
    try {
        const url = new URL(String(state.returnTo || '/'), 'http://app.invalid');
        const rt = url.pathname === '/login' ? (url.searchParams.get('returnTo') || '/') : url.pathname + url.search + url.hash;
        encodeURIComponent(rt); // throws on a lone surrogate - fall back to Home below
        return rt;
    } catch {
        return '/';
    }
}
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (req.path === '/callback' && oidcCallbackRecoverable(err)) {
        let state = {};
        try { state = JSON.parse(Buffer.from(String(req.query.state || ''), 'base64url').toString()) || {}; } catch { /* no usable state */ }
        const tries = Math.max(0, Number.parseInt(state.retry, 10) || 0);
        const returnTo = loginStateReturnTo(state);
        const reason = `${err.error || 'error'}: ${String(err.message || '').split('\n')[0]}`;
        if (tries >= MAX_LOGIN_RETRIES) {
            // Another tab signed in meanwhile: this one just goes back to the app.
            if (req.oidc && req.oidc.isAuthenticated()) {
                let origin = 'http://app.invalid';
                try { origin = new URL(process.env.BASE_URL).origin; } catch { /* keep the placeholder */ }
                return res.redirect(safeReturnTo(returnTo, origin));
            }
            console.error(`OIDC callback failed after ${tries} retries - stopping:`, reason);
            return res.status(400).send('Sign-in failed. <a href="/">Go to the start page</a> to try again; if it keeps failing, ask your administrator to check the SSO settings.');
        }
        console.warn(`OIDC callback failed (transient login race) - restarting login (retry ${tries + 1}):`, reason);
        // Tabs that fail together would restart together and keep breaking each other's login (a
        // failing callback also clears the other tab's transaction cookie). A short random delay
        // lets one finish first; the others then find a session at /login and go back to the app.
        setTimeout(() => res.redirect(`/login?retry=${tries + 1}&returnTo=${encodeURIComponent(returnTo)}`), crypto.randomInt(100, 900));
        return;
    }
    console.error('Unhandled error on', req.method, req.path, '-', err);
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' });
    res.status(500).send('Something went wrong. Please go back and try again.');
});

// ─── Scheduler health tracking ───
// Every background job runs through tracked() so a failure is (a) logged and (b) kept
// in memory for the System Health page - a silently-broken expiry loop was previously
// invisible (.catch(() => {})). In-memory is fine: this app is single-instance.
const _schedHealth = {}; // name → { runs, failures, lastRunAt, lastOkAt, lastError, lastMs, consecFails, alerted }
const _bootAt = Date.now();
// Telegram alert fires on the TRANSITION into "repeatedly failing" (this many consecutive
// failures), and once more on recovery - never on every failing tick (a broken 60s job
// would otherwise spam an alert a minute) and not on a single transient blip.
const SCHED_ALERT_AFTER = 3;
async function tracked(name, fn) {
    const s = _schedHealth[name] || (_schedHealth[name] = { runs: 0, failures: 0, lastRunAt: null, lastOkAt: null, lastError: '', lastMs: 0, consecFails: 0, alerted: false });
    // Overlap guard: with N tenants a tick can outlast its interval - never run the same job
    // concurrently with itself (the skipped tick is simply picked up by the next interval).
    if (s.inFlight) return;
    s.inFlight = true;
    try { return await trackedRun(name, s, fn); } finally { s.inFlight = false; }
}
async function trackedRun(name, s, fn) {
    s.lastRunAt = new Date().toISOString();
    const t0 = Date.now();
    try {
        await fn();
        s.lastOkAt = new Date().toISOString();
        s.lastError = '';
        if (s.alerted) notifySchedJobAlert(name, { failed: false }).catch(() => { });
        s.consecFails = 0;
        s.alerted = false;
    } catch (e) {
        s.failures++;
        s.consecFails = (s.consecFails || 0) + 1;
        s.lastError = e.message || String(e);
        console.error('[Scheduler] job failed:', name, e.message);
        if (s.consecFails === SCHED_ALERT_AFTER && !s.alerted) {
            s.alerted = true;
            notifySchedJobAlert(name, { failed: true, failures: s.consecFails, error: s.lastError }).catch(() => { });
        }
    }
    s.lastMs = Date.now() - t0;
    s.runs++;
}

// Start server after DB initialization
async function start() {
    try {
        await initializeDatabase();
        // One-time: fill approved_minutes on old approved requests from grants/bypass evidence.
        backfillApprovedDurations().catch(err => console.error('Approved-durations backfill error:', err.message));
        // Warm the NetBird caches at startup (user + router name resolution)
        ensureUsersFresh().catch(err => console.error('Initial user refresh error:', err.message));
        ensurePeersFresh().catch(err => console.error('Initial peer refresh error:', err.message));
        // Automation scheduler - clear crash-stuck 'running' flags, then poll due jobs. Skipped
        // entirely in read-only mode (it would only attempt blocked NetBird writes).
        if (!NETBIRD_READONLY) {
            // App-owned features (automations, grants, recurring, recertification) run per
            // account: forEachTenant services main ('') then each tenant in its own context, so
            // every account gets identical treatment against its OWN NetBird API + DB rows. A
            // single tenant iteration failing never blocks the rest - forEachTenant collects the
            // errors and throws one summary (which tracked() raises as the job alert, naming the
            // tenant). Request escalation / the weekly digest / anomaly alerts stay MAIN-only.
            await tracked('resetStuckAutomations', () => forEachTenant(resetStuckAutomations));
            const autoTick = () => tracked('automations', () => forEachTenant(runDueAutomations));
            setTimeout(autoTick, 15000);
            setInterval(autoTick, 60000);
            // Temporary-access expiry: revoke expired grants + keep active grants' groups in
            // sync with the users' current devices, on the same 60s cadence.
            await tracked('resetStuckGrants', () => forEachTenant(resetStuckGrants));
            const grantsTick = async () => {
                await tracked('grantExpiry', () => forEachTenant(revokeExpiredGrants));
                await tracked('grantReconcile', () => forEachTenant(reconcileActiveGrants));
                await tracked('grantCrashCleanup', () => forEachTenant(cleanupStuckCreatingGrants));
                await tracked('bypassExpiry', () => forEachTenant(revokeExpiredBypasses));
                await tracked('requestEscalation', escalatePendingRequests);
                await tracked('accessReviewDigest', sendAccessReviewDigest);
                await tracked('trafficAnomalies', checkTrafficAnomalies);
                await tracked('recurringAccess', () => forEachTenant(runRecurringAccess));
                await tracked('recertification', () => forEachTenant(runRecertification));
            };
            setTimeout(grantsTick, 20000);
            setInterval(grantsTick, 60000);
        }

        // IP-assignment history: keep the ip↔user intervals current from the peers cache. Runs
        // in read-only mode too - it only reads NetBird and writes the app's own DB.
        const ipTick = () => tracked('ipHistorySync', () => forEachTenant(async () => { await ensurePeersFresh(); await syncIpAssignments(); }));
        setTimeout(ipTick, 10000);
        setInterval(ipTick, 60000);

        // Reverse-proxy access logs: copy NetBird Cloud's 7-day window into the app's own DB
        // (proxy_access_logs), so the app's Data Retention governs them. Read-only safe.
        const proxyLogsTick = () => tracked('proxyLogsSync', () => forEachTenant(syncProxyAccessLogs));
        setTimeout(proxyLogsTick, 15000);
        setInterval(proxyLogsTick, 5 * 60 * 1000);

        // Traffic Events API pull: the same 5-minute cadence, staggered off the proxy sync so two
        // multi-page NetBird walks never start together. Each account self-gates on its own opt-in
        // setting (disabled by default), so this is a no-op until someone turns it on. Read-only safe.
        const trafficPullTick = () => tracked('trafficPull', () => forEachTenant(syncTrafficEvents));
        setTimeout(trafficPullTick, 25000);
        setInterval(trafficPullTick, 5 * 60 * 1000);

        // Audit Events API pull: the same 5-minute cadence, staggered off the traffic pull (25s) so
        // two multi-page NetBird walks never start together. Each account self-gates on its own
        // opt-in setting (disabled by default), so this is a no-op until someone turns it on.
        const auditPullTick = () => tracked('auditPull', () => forEachTenant(syncAuditEvents));
        setTimeout(auditPullTick, 35000);
        setInterval(auditPullTick, 5 * 60 * 1000);

        // Event retention purge - once per account (main + each tenant), each self-gating to once
        // per day and to ITS OWN configured window. Only touches the app's own DB (read-only safe);
        // per-account DELETEs are scoped to that account's rows.
        const retentionTick = () => tracked('retentionPurge', () => forEachTenant(purgeOldEvents));
        setTimeout(retentionTick, 30000);
        setInterval(retentionTick, 10 * 60 * 1000);

        // Weekly MSP digest: hourly tick that self-gates on enabled + the configured day/hour and a
        // once-a-day marker (msp_digest_last), sending the fleet snapshot to main's Telegram/emails.
        // Disabled by default (kill switch). Read-only safe (reads DB + sends notifications only).
        // Hour-precision jobs must fire AT the top of the hour - a boot-anchored hourly interval
        // drifts by the boot minute (a container started at 02:53 ran the "03:00" backup at 03:53).
        // One catch-up tick soon after boot (their at-or-after gates self-heal a missed window),
        // then ticks aligned to the next full hour + a small stagger.
        const scheduleHourlyAligned = (fn, bootDelayMs, staggerMs) => {
            setTimeout(fn, bootDelayMs);
            const msToNextHour = 3600_000 - (Date.now() % 3600_000);
            setTimeout(() => { fn(); setInterval(fn, 3600_000); }, msToNextHour + staggerMs);
        };
        const mspDigestTick = () => tracked('mspDigest', sendMspDigest);
        scheduleHourlyAligned(mspDigestTick, 50000, 15000);

        // Internal encrypted backup: hourly tick that self-gates on enabled + the configured hour + a
        // once-a-day marker (internal_backup_last), writing an envelope-encrypted full backup to
        // BACKUP_DIR. Disabled by default (kill switch). Main-only, read-only safe (reads the DB +
        // writes a file); no passphrase needed at backup time (the public key encrypts).
        const internalBackupTickJob = () => tracked('internalBackup', internalBackupTick);
        scheduleHourlyAligned(internalBackupTickJob, 55000, 20000);

        // MSP tenant token rotation: re-issues each tenant's managed service-user token when
        // it is within 30 days of its 365-day expiry. Hourly check; quiet when nothing is due.
        // Writes to NetBird (token create/delete) - skipped in read-only mode.
        if (!NETBIRD_READONLY) {
            const tenantTokenTick = () => tracked('tenantTokenRotation', rotateTenantTokens);
            setTimeout(tenantTokenTick, 45000);
            setInterval(tenantTokenTick, 60 * 60 * 1000);
        }

        // Register the Telegram callback webhook so Approve/Deny buttons work after a restart.
        if (getTelegramConfig().enabled && getTelegramConfig().hasToken && process.env.BASE_URL) {
            telegramSetWebhook(process.env.BASE_URL)
                .then(r => console.log(`Telegram webhook: ${r && r.ok ? 'registered' : 'FAILED to register'}`))
                .catch(() => { });
        }

        app.listen(PORT, '0.0.0.0', async () => {
            console.log(`NetBird Logs server running on port ${PORT}`);
            // The (tenant, timestamp DESC) log indexes are built HERE, after the port is open, and
            // CONCURRENTLY - on a multi-GB events table each build takes minutes, so it must never
            // gate the boot or lock out webhook ingest. Fire-and-forget: it logs its own progress
            // and self-heals an interrupted build on the next start.
            ensureLogIndexes().catch(err => console.error('[Index] log index maintenance error:', err.message));
            console.log(`Webhook endpoint: POST /api/webhook`);
            console.log(`Web UI: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
            if (NETBIRD_READONLY) console.log('NetBird writes: READ-ONLY (NETBIRD_READONLY=true) - all create/update/delete + automations are blocked');
            console.log(`Automation scheduler: ${NETBIRD_READONLY ? 'DISABLED (read-only mode)' : 'ENABLED (60s tick)'}`);
            if (await getWebhookToken()) { // boot log runs in the main account context (tnt() === '')
                console.log(`Webhook authentication: ENABLED (${WEBHOOK_AUTH_TOKEN ? 'env' : 'Settings → Webhook'})`);
            } else {
                console.log('Webhook authentication: DISABLED (set a token in Settings → Webhook or WEBHOOK_AUTH_TOKEN)');
            }
            if (AUTH_ENABLED) {
                console.log(`SSO authentication: ENABLED (Azure AD / OIDC) - admins by NetBird role`);
                if (!process.env.SESSION_SECRET) {
                    console.warn('!! SESSION_SECRET is not set - a random per-boot secret is used, so EVERY');
                    console.warn('!! restart logs all users out. Set SESSION_SECRET in .env to fix this.');
                }
            } else {
                console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
                console.warn('!! SSO authentication: DISABLED - EVERYONE who can reach this app has FULL');
                console.warn('!! ADMIN access, including NetBird management writes. Never expose this');
                console.warn('!! instance beyond localhost. Set OIDC_* + BASE_URL to enable login.');
                console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            }
        });
    } catch (err) {
        console.error('Failed to start server:', err.message);
        process.exit(1);
    }
}

// Tests load the app without starting it (no database, schedulers or listener).
if (require.main === module) start();

module.exports = { app };
