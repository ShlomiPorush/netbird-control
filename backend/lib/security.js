// Security & alerts config, extracted verbatim from db.js. Owns the in-memory _security state
// (session limits, request escalation, the weekly access review, anomaly alerts, event retention
// and access recertification) plus its normalize/load/get/set accessors. Everything here is a
// plain number/flag backed by app_settings - no env vars, no domain calls.
//
// db.js binds the LIVE _security object (`const { _security } = require('./lib/security')`) and
// reads _security.foo in many places; applySecurityConfig mutates the object key-by-key and never
// reassigns it, so those reads keep working through the shared reference. Dependencies are one-way
// (db.js -> lib/security.js -> lib/core.js; never the reverse, no cycle).

const { getSetting, setSetting } = require('./core');

// ─── Security & alerts config (in-app: Settings → Security; app_settings-backed) ───
// Session limits, access-request escalation, the weekly access review and anomaly alerts.
// Everything here is a plain number/flag with a safe default - no env vars involved.
const SECURITY_DEFAULTS = {
    // Sessions (hours; 0 disables that limit)
    sessionIdleHours: 1,        // signed out after this much inactivity
    sessionMaxHours: 6,         // absolute cap for regular users
    adminSessionMaxHours: 2,    // stricter absolute cap for admins
    // Access-request escalation (0 disables)
    requestReminderMinutes: 30, // one Telegram reminder for a still-pending request
    requestExpireHours: 24,     // auto-expire an undecided request
    // Weekly access review digest
    reviewEnabled: true,
    reviewDay: 1,               // 0=Sunday … 6=Saturday (app time zone)
    reviewHour: 8,              // 0-23
    reviewEmails: [],           // optional email recipients (requires SMTP)
    // Anomaly alerts (Telegram)
    anomalyEnabled: true,
    // Telegram alert when a background job fails repeatedly (and when it recovers)
    schedAlertsEnabled: true,
    workDays: [0, 1, 2, 3, 4],  // 0=Sunday … 6=Saturday; admin actions on other days alert
    workStart: 6,               // admin actions outside [workStart, workEnd) alert
    workEnd: 22,
    trafficMult: 5,             // spike = > mult × the device's 7-day hourly average…
    trafficFloorMb: 500,        // …AND above this floor (MB/hour)
    // Event retention in DAYS - fully admin-controlled. 0 = keep forever. Values below
    // RETENTION_WARN_DAYS are legal but the UI shows a compliance warning (24 months).
    retentionDays: 0,
    // Periodic access recertification: every N days a review round opens listing all
    // STANDING access (unlimited bypasses, feature permissions, auto-approval rules,
    // recurring access) - each item must be explicitly kept or revoked.
    recertEnabled: true,
    recertIntervalDays: 90,
};
// Below this the Data Retention UI shows a compliance warning (~24 months) - advisory
// only; the admin's choice always wins.
const RETENTION_WARN_DAYS = 730;
const _security = { ...SECURITY_DEFAULTS };

function secNum(v, def, min, max) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}
// Copy a normalized config into the module state key-by-key. Only the FIXED key set of
// SECURITY_DEFAULTS is ever assigned (never keys from the input), so parsed JSON can't
// introduce foreign/prototype properties (mass-assignment safe).
function applySecurityConfig(normalized) {
    for (const k of Object.keys(SECURITY_DEFAULTS)) _security[k] = normalized[k];
}
async function loadSecurityConfig() {
    try {
        const v = await getSetting('security_config');
        if (v) applySecurityConfig(normSecurityConfig(JSON.parse(v)));
    } catch (e) {
        console.error('[Security] config load error:', e.message);
    }
}
function normSecurityConfig(cfg) {
    cfg = cfg || {};
    return {
        sessionIdleHours: secNum(cfg.sessionIdleHours, SECURITY_DEFAULTS.sessionIdleHours, 0, 168),
        sessionMaxHours: secNum(cfg.sessionMaxHours, SECURITY_DEFAULTS.sessionMaxHours, 0, 168),
        adminSessionMaxHours: secNum(cfg.adminSessionMaxHours, SECURITY_DEFAULTS.adminSessionMaxHours, 0, 168),
        requestReminderMinutes: Math.round(secNum(cfg.requestReminderMinutes, SECURITY_DEFAULTS.requestReminderMinutes, 0, 10080)),
        requestExpireHours: secNum(cfg.requestExpireHours, SECURITY_DEFAULTS.requestExpireHours, 0, 720),
        reviewEnabled: cfg.reviewEnabled !== false,
        reviewDay: Math.round(secNum(cfg.reviewDay, SECURITY_DEFAULTS.reviewDay, 0, 6)),
        reviewHour: Math.round(secNum(cfg.reviewHour, SECURITY_DEFAULTS.reviewHour, 0, 23)),
        reviewEmails: (Array.isArray(cfg.reviewEmails) ? cfg.reviewEmails : String(cfg.reviewEmails || '').split(','))
            .map(s => String(s).trim().toLowerCase()).filter(Boolean),
        anomalyEnabled: cfg.anomalyEnabled !== false,
        schedAlertsEnabled: cfg.schedAlertsEnabled !== false,
        workDays: (() => {
            const d = [...new Set((Array.isArray(cfg.workDays) ? cfg.workDays : []).map(x => parseInt(x, 10)).filter(x => x >= 0 && x <= 6))].sort();
            return d.length ? d : [...SECURITY_DEFAULTS.workDays]; // never allow an empty week
        })(),
        workStart: Math.round(secNum(cfg.workStart, SECURITY_DEFAULTS.workStart, 0, 23)),
        workEnd: Math.round(secNum(cfg.workEnd, SECURITY_DEFAULTS.workEnd, 1, 24)),
        trafficMult: secNum(cfg.trafficMult, SECURITY_DEFAULTS.trafficMult, 2, 100),
        trafficFloorMb: Math.round(secNum(cfg.trafficFloorMb, SECURITY_DEFAULTS.trafficFloorMb, 10, 1024 * 100)),
        // 0 = disabled (keep forever). Admin-controlled in days, capped at 10 years.
        // Legacy configs stored months - convert once (30-day months) so an existing
        // setting keeps its meaning across the upgrade.
        retentionDays: (() => {
            const legacy = (cfg.retentionDays === undefined && cfg.retentionMonths > 0) ? Math.round(cfg.retentionMonths * 30) : undefined;
            return Math.round(secNum(legacy !== undefined ? legacy : cfg.retentionDays, SECURITY_DEFAULTS.retentionDays, 0, 3650));
        })(),
        recertEnabled: cfg.recertEnabled !== false,
        recertIntervalDays: Math.round(secNum(cfg.recertIntervalDays, SECURITY_DEFAULTS.recertIntervalDays, 30, 365)),
    };
}
function getSecurityConfig() { return { ..._security }; }
async function setSecurityConfig(cfg) {
    applySecurityConfig(normSecurityConfig({ ...(_security), ...(cfg || {}) }));
    await setSetting('security_config', JSON.stringify(_security));
    return getSecurityConfig();
}

module.exports = {
    // The live state object - db.js binds this reference and reads _security.foo directly.
    _security, RETENTION_WARN_DAYS,
    loadSecurityConfig, normSecurityConfig, getSecurityConfig, setSecurityConfig,
};
