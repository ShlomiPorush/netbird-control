// NetBird Cloud status (status.netbird.io, hosted on incident.io). The page answers the
// Statuspage v2 summary format, which incident.io does not document: parseSummary refuses any
// answer without the components and incidents arrays, so a changed format reads as "unknown"
// and never as "no incidents" (which would send a false "resolved" alert).

const { httpJson } = require('./http');
const { getSetting, setSetting } = require('./core');
const { sendTelegram, getTelegramConfig, tgEsc } = require('./telegram');
const { sendMail, getSmtpConfig, htmlEsc, mailLayout, mailRows } = require('./mail');

const STATUS_ORIGIN = 'https://status.netbird.io';
const SUMMARY_URL = `${STATUS_ORIGIN}/api/v2/summary.json`;
const BASELINE_KEY = 'netbird_cloud_incidents';
const DISPLAY_TTL_MS = 60_000;
const INDICATORS = new Set(['none', 'minor', 'major', 'critical', 'maintenance']);
const INCIDENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ITEMS = 50;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Only NetBird Cloud accounts depend on these services; a self-hosted management URL does not.
function usesNetbirdCloud(apiUrl) {
    try {
        const host = new URL(String(apiUrl || '')).hostname.toLowerCase();
        return host === 'netbird.io' || host.endsWith('.netbird.io');
    } catch {
        return false;
    }
}

function latestUpdate(updates) {
    const list = Array.isArray(updates) ? updates.filter(u => u && typeof u === 'object') : [];
    const at = (u) => Date.parse(u.display_at || u.created_at || '') || 0;
    const newest = list.reduce((best, u) => (!best || at(u) > at(best) ? u : best), null);
    return newest ? text(newest.body, 1000) : '';
}

function parseSummary(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.components) || !Array.isArray(body.incidents)) {
        throw new Error('status.netbird.io sent an answer in an unexpected format');
    }
    const status = body.status && typeof body.status === 'object' ? body.status : {};
    const components = body.components
        .filter(c => c && typeof c === 'object' && text(c.name, 120))
        .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
        .slice(0, MAX_ITEMS)
        .map(c => ({ name: text(c.name, 120), status: text(c.status, 40) || 'unknown' }));
    const incidents = body.incidents
        .filter(i => i && typeof i === 'object' && INCIDENT_ID.test(String(i.id || '')) && text(i.name, 200))
        .slice(0, MAX_ITEMS)
        .map(i => ({
            id: i.id,
            name: text(i.name, 200),
            status: text(i.status, 40),
            impact: text(i.impact, 40),
            startedAt: text(i.created_at, 40) || null,
            updatedAt: text(i.updated_at, 40) || null,
            latestUpdate: latestUpdate(i.incident_updates),
            url: `${STATUS_ORIGIN}/incidents/${i.id}`,
        }));
    return {
        indicator: INDICATORS.has(status.indicator) ? status.indicator : 'unknown',
        description: text(status.description, 120),
        components,
        incidents,
        updatedAt: text(body.page && body.page.updated_at, 40) || null,
        pageUrl: `${STATUS_ORIGIN}/`,
    };
}

async function fetchSummaryFromNetbird() {
    // noteOk: false - an answer from the status page must not count as a NetBird API contact.
    const r = await httpJson('GET', SUMMARY_URL, { timeoutMs: 10_000, deadlineMs: 15_000, maxBytes: 1024 * 1024, noteOk: false });
    if (r.status !== 200) throw new Error(`status.netbird.io did not answer (${r.error || `HTTP ${r.status}`})`);
    return parseSummary(r.body);
}

function incidentWord(n) { return n === 1 ? 'incident' : 'incidents'; }

function degradedComponents(summary) {
    return summary.components.filter(c => c.status !== 'operational').map(c => `${c.name} (${c.status.replace(/_/g, ' ')})`);
}

function buildAlert(event, summary) {
    const inc = event.incident;
    const started = event.kind === 'started';
    const affected = degradedComponents(summary);
    const heading = started ? 'NetBird Cloud Incident' : 'NetBird Cloud Incident Resolved';
    const rows = started
        ? [
            ['Incident', inc.name],
            inc.impact && ['Impact', inc.impact],
            inc.status && ['Status', inc.status],
            affected.length && ['Affected', affected.join(', ')],
        ]
        : [
            ['Incident', inc.name],
            summary.incidents.length && ['Still Open', `${summary.incidents.length} ${incidentWord(summary.incidents.length)}`],
        ];
    let tg = `${started ? '🚨' : '✅'} <b>${heading}</b>\n\n`;
    tg += rows.filter(Boolean).map(([k, v]) => `<b>${k}:</b> ${tgEsc(v)}`).join('\n');
    if (started && inc.latestUpdate) tg += `\n\n${tgEsc(inc.latestUpdate)}`;
    tg += `\n\n${inc.url}`;
    let mail = mailRows(rows);
    if (started && inc.latestUpdate) mail += `<p>${htmlEsc(inc.latestUpdate)}</p>`;
    mail += `<p><a href="${htmlEsc(inc.url)}" style="color:#f68330;text-decoration:none">Open the incident on status.netbird.io</a></p>`;
    return {
        telegram: tg,
        subject: `${started ? 'NetBird Cloud incident' : 'NetBird Cloud incident resolved'}: ${inc.name}`,
        mailHtml: mailLayout(heading, mail),
    };
}

// Admin alerts: the Telegram Security Alerts topic (honoring its opt-out) and the optional
// recipients list, the same channels as the other admin alerts.
function sendAlertToAdmins(alert, emails) {
    const cat = getTelegramConfig().categories?.alerts;
    if (!cat || cat.enabled !== false) sendTelegram('alerts', alert.telegram).catch(() => { });
    if (emails.length && getSmtpConfig().enabled) {
        for (const to of emails) {
            sendMail({ to, subject: alert.subject, html: alert.mailHtml, tag: 'netbird-cloud-status' }).catch(() => { });
        }
    }
}

function readBaseline(raw) {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        return Object.fromEntries(Object.entries(v).filter(([id]) => INCIDENT_ID.test(id)));
    } catch {
        return null;
    }
}

function sameIncidents(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k));
}

function createCloudStatus({
    fetchSummary = fetchSummaryFromNetbird,
    store = { get: getSetting, set: setSetting },
    alert = sendAlertToAdmins,
    now = Date.now,
} = {}) {
    let cached = null;
    let inFlight = null;

    // For the pages: every instance reads for itself (only the leader runs the alert job), with a
    // short cache so many open dashboards make one request a minute.
    async function getDisplayStatus() {
        if (cached && now() - cached.at < DISPLAY_TTL_MS) return cached.value;
        if (!inFlight) {
            inFlight = fetchSummary()
                .then(summary => ({ summary, error: null }), err => ({ summary: null, error: err.message || String(err) }))
                .then(result => {
                    const value = { ...result, checkedAt: new Date(now()).toISOString() };
                    cached = { at: now(), value };
                    return value;
                })
                .finally(() => { inFlight = null; });
        }
        return inFlight;
    }

    // The alert job. The last seen set of open incidents is kept in the database, so a restart or
    // a new leader compares against it instead of alerting on what was already open. Without a
    // stored set (first run, or the check was off) it only records the current one.
    async function checkForChanges({ alertsEnabled, emails = [] }) {
        const summary = await fetchSummary();
        const previous = readBaseline(await store.get(BASELINE_KEY));
        const current = Object.fromEntries(summary.incidents.map(i => [i.id, i.name]));
        if (!previous || !sameIncidents(previous, current)) await store.set(BASELINE_KEY, JSON.stringify(current));
        if (!previous || !alertsEnabled) return { started: 0, resolved: 0 };
        const started = summary.incidents.filter(i => !Object.prototype.hasOwnProperty.call(previous, i.id));
        const resolved = Object.keys(previous).filter(id => !Object.prototype.hasOwnProperty.call(current, id));
        for (const incident of started) alert(buildAlert({ kind: 'started', incident }, summary), emails);
        for (const id of resolved) {
            const incident = { id, name: String(previous[id] || 'Unnamed incident'), url: `${STATUS_ORIGIN}/incidents/${id}` };
            alert(buildAlert({ kind: 'resolved', incident }, summary), emails);
        }
        return { started: started.length, resolved: resolved.length };
    }

    // Turning the check off forgets the stored set, so turning it on again starts silently.
    async function forgetIncidents() {
        if (await store.get(BASELINE_KEY)) await store.set(BASELINE_KEY, '');
    }

    return { getDisplayStatus, checkForChanges, forgetIncidents };
}

module.exports = { createCloudStatus, parseSummary, usesNetbirdCloud, buildAlert, STATUS_ORIGIN };
