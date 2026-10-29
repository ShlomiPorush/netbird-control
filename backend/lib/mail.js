// SMTP transport layer, extracted verbatim from db.js. Owns the SMTP config state, the
// nodemailer transport, the low-level send, and the shared mail HTML shell. The domain
// notify*Email helpers stay in db.js and call sendMail/mailLayout/mailRows/htmlEsc from here.
//
// Dependency direction is one-way (db.js -> lib/mail.js, never the reverse). The settings accessors
// come straight from lib/core.js (mail -> core, also one-way), so there is no injection to wire up.

const nodemailer = require('nodemailer');
const { getSetting, setSetting } = require('./core');

// ─── SMTP email notifications ─────────────────────────────────────────────────────────────
// So a requester learns their access was approved/denied/ended - Telegram only reaches approvers.
// Env-managed when SMTP_HOST is set (the whole config comes from env and the UI is read-only);
// otherwise it's configured in-app. The password is a write-only secret, never returned.
const _smtpEnv = {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 0,
    secure: /^(true|1|yes|on)$/i.test(process.env.SMTP_SECURE || ''),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
};
const _smtpEnvManaged = !!_smtpEnv.host;
const _smtp = { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '' };

async function loadSmtp() {
    try {
        const v = await getSetting('smtp_config');
        if (v) {
            const c = JSON.parse(v) || {};
            _smtp.enabled = !!c.enabled;
            _smtp.host = c.host || '';
            _smtp.port = parseInt(c.port, 10) || 587;
            _smtp.secure = !!c.secure;
            _smtp.user = c.user || '';
            _smtp.from = c.from || '';
        }
        const p = await getSetting('smtp_pass');
        if (p) _smtp.pass = p;
    } catch (e) {
        console.error('[SMTP] config load error:', e.message);
    }
}

// The effective connection settings (an env-managed instance overrides the DB config entirely).
function smtpEffective() {
    if (_smtpEnvManaged) {
        return {
            enabled: true, host: _smtpEnv.host, port: _smtpEnv.port || (_smtpEnv.secure ? 465 : 587),
            secure: _smtpEnv.secure, user: _smtpEnv.user, pass: _smtpEnv.pass, from: _smtpEnv.from || _smtpEnv.user,
        };
    }
    return { ..._smtp, from: _smtp.from || _smtp.user };
}
// UI-safe config - never returns the password.
function getSmtpConfig() {
    const e = smtpEffective();
    return {
        enabled: !!(e.enabled && e.host), host: e.host, port: e.port, secure: e.secure,
        user: e.user, from: e.from, hasPass: !!e.pass, envManaged: _smtpEnvManaged,
    };
}
async function persistSmtp() {
    await setSetting('smtp_config', JSON.stringify({
        enabled: _smtp.enabled, host: _smtp.host, port: _smtp.port, secure: _smtp.secure, user: _smtp.user, from: _smtp.from,
    }));
}
async function setSmtpConfig({ enabled, host, port, secure, user, from, pass } = {}) {
    if (_smtpEnvManaged) return getSmtpConfig(); // env-managed: nothing to change here
    if (enabled !== undefined) _smtp.enabled = !!enabled;
    if (host !== undefined) _smtp.host = String(host || '').trim();
    if (port !== undefined) _smtp.port = parseInt(port, 10) || 587;
    if (secure !== undefined) _smtp.secure = !!secure;
    if (user !== undefined) _smtp.user = String(user || '').trim();
    if (from !== undefined) _smtp.from = String(from || '').trim();
    await persistSmtp();
    if (pass !== undefined && String(pass).trim() !== '') {
        _smtp.pass = String(pass);
        await setSetting('smtp_pass', _smtp.pass);
    }
    _mailer = null; // force a fresh transport on the next send
    return getSmtpConfig();
}

// Cached nodemailer transport, rebuilt only when the connection settings change.
let _mailer = null, _mailerKey = '';
function getMailer() {
    const e = smtpEffective();
    if (!e.host) return null;
    const key = JSON.stringify([e.host, e.port, e.secure, e.user, e.pass]);
    if (_mailer && _mailerKey === key) return _mailer;
    _mailer = nodemailer.createTransport({
        host: e.host, port: e.port, secure: e.secure,
        auth: e.user ? { user: e.user, pass: e.pass } : undefined,
    });
    _mailerKey = key;
    return _mailer;
}
// Optional observer called after every ACTUAL send attempt (success or transport failure) -
// db.js registers the outbound log here. Config-missing early returns are NOT reported: nothing
// left the server, and logging them would flood the log whenever SMTP is simply off.
// The one-way dependency holds: mail.js only calls whatever function was handed in.
let _onSend = null;
function setMailObserver(fn) { _onSend = typeof fn === 'function' ? fn : null; }

// Send one email. Call sites are fire-and-forget. Returns { ok, error }.
// `tag` labels the sending feature in the outbound log; it is never sent to the recipient.
async function sendMail({ to, subject, html, text, tag }) {
    const e = smtpEffective();
    if (!e.enabled || !e.host || !to) return { ok: false, error: 'SMTP is not configured' };
    const from = e.from || e.user;
    if (!from) return { ok: false, error: 'No From address is configured' };
    try {
        const t = getMailer();
        if (!t) return { ok: false, error: 'SMTP is not configured' };
        await t.sendMail({ from, to, subject, html, text: text || undefined });
        // Pass the rendered html + plain text so the outbound log can preview what went out.
        try { _onSend && _onSend({ to, subject, tag, ok: true, html, text }); } catch { /* observer must never break sends */ }
        return { ok: true };
    } catch (err) {
        console.error('[SMTP] send error:', err.message);
        // Carry the body on the failure path too, so a failed send still previews what would have gone out.
        try { _onSend && _onSend({ to, subject, tag, ok: false, error: err.message, html, text }); } catch { /* ditto */ }
        return { ok: false, error: err.message };
    }
}
async function smtpTest(to) {
    if (!to) return { ok: false, error: 'A recipient address is required' };
    return sendMail({ to, subject: 'NetBird Control - SMTP test', html: mailLayout('SMTP Test', '<p>✅ Your SMTP settings work - this is a test message from NetBird Control.</p>'), tag: 'test' });
}

// ── Notification email templates (a small branded HTML shell + label/value rows) ──
// Table-based + a single flat white background so email clients (Outlook especially) render it
// consistently; the color-scheme hints tell clients not to re-tint it into their own dark mode
// (which was banding the old two-tone layout).
const MAIL_FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
function htmlEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function mailLayout(heading, bodyHtml) {
    const appUrl = process.env.BASE_URL || '';
    const link = appUrl ? `<p style="margin:20px 0 0;font-size:13px;color:#8a8f98">Open <a href="${htmlEsc(appUrl)}" style="color:#f68330;text-decoration:none">NetBird Control</a></p>` : '';
    return `<!doctype html><html><head><meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">`
        + `</head>`
        + `<body style="margin:0;padding:0;background-color:#ffffff;">`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">`
        + `<tr><td align="center" style="padding:24px;">`
        + `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;background-color:#ffffff;border:1px solid #e6e8eb;border-radius:12px;">`
        + `<tr><td style="padding:18px 24px;border-bottom:1px solid #eef0f2;font-family:${MAIL_FONT};font-size:16px;font-weight:600;color:#1a1d21;">${htmlEsc(heading)}</td></tr>`
        + `<tr><td style="padding:24px;font-family:${MAIL_FONT};font-size:14px;line-height:1.6;color:#33373d;">${bodyHtml}${link}</td></tr>`
        + `</table></td></tr></table></body></html>`;
}
function mailRows(rows) {
    const cells = rows.filter(Boolean).map(([k, v]) =>
        `<tr><td style="padding:3px 12px 3px 0;font-family:${MAIL_FONT};font-size:14px;color:#8a8f98;vertical-align:top;background-color:#ffffff;">${htmlEsc(k)}</td><td style="padding:3px 0;font-family:${MAIL_FONT};font-size:14px;color:#1a1d21;background-color:#ffffff;">${htmlEsc(v)}</td></tr>`).join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:10px 0 0;background-color:#ffffff;">${cells}</table>`;
}

module.exports = {
    loadSmtp, getSmtpConfig, setSmtpConfig, smtpTest, sendMail, setMailObserver,
    htmlEsc, mailLayout, mailRows,
};
