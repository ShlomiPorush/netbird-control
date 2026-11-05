'use strict';
// API keys for the versioned public API (/api/v1): machine access for other systems, such as the
// customer file that opens browser remote sessions. Admins create keys in Settings -> API Keys.
//
// - A key is "nbc_" + 32 random bytes (base64url). It is shown once; only its SHA-256 is stored
//   (a 256-bit random key needs no slow hash). The first KEY_PREFIX_LEN characters are stored too,
//   to find the row and to show which key is which.
// - A key may call only the actions its scopes name, optionally only from listed addresses, and
//   only until it expires or is revoked.
// - Creating and revoking a key, and every action a key takes, is recorded in app_audit with a
//   STRICT write: if the record can't be written, the action doesn't happen.

const crypto = require('crypto');
const net = require('net');
const { pool } = require('./core');

const SCOPES = Object.freeze({
    'remote-access:launch': 'Open browser remote sessions (RDP / SSH) for a user from another system',
});
const KEY_PREFIX = 'nbc_';
const KEY_RE = /^nbc_[A-Za-z0-9_-]{43}$/;
const KEY_PREFIX_LEN = 12;
const MAX_NAME = 80;
const MAX_ALLOWED_IPS = 50;
const TOUCH_EVERY_MS = 60_000;
// The longest a database read or write that a caller without a valid key can cause may take
// (pg's query_timeout: the query fails and the pool drops that connection).
const QUERY_TIMEOUT_MS = 5000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function apiError(status, code, message) {
    const e = new Error(message || code);
    e.status = status; e.code = code;
    return e;
}

// A STRICT audit record: throws when it can't be written (recordAudit in db.js logs and goes on).
// `q` is the pool or a transaction client; `timeoutMs` bounds the write (pg's query_timeout).
async function writeAuditStrict(q, { actorId = '', actorEmail = '', actorName = '', action, target = '', meta = null, timeoutMs = 0 }) {
    const text = `INSERT INTO app_audit (actor_id, actor_email, actor_name, action, target, meta, tenant)
         VALUES ($1, $2, $3, $4, $5, $6, '')`;
    const values = [actorId, actorEmail, actorName, action, target, meta ? JSON.stringify(meta) : null];
    await (timeoutMs ? q.query({ text, values, query_timeout: timeoutMs }) : q.query(text, values));
}

// The audit actor for a change made by a signed-in admin.
const viewerActor = (v) => ({
    actorId: (v && (v.user_id || v.oid)) || '', actorEmail: (v && v.email) || '', actorName: (v && v.name) || '',
});
// The audit actor for an action a key takes.
const keyActor = (k) => ({ actorId: `apikey:${k.id}`, actorEmail: '', actorName: `API key "${k.name}"` });

// "::ffff:10.0.0.1" -> "10.0.0.1", so an IPv4 client matches an IPv4 entry whatever socket it used.
function normalizeIp(ip) {
    const s = String(ip || '').trim();
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
    return m ? m[1] : s;
}

// Validate the allowed-address list: IPv4/IPv6 addresses or CIDR ranges. Returns the normalized list.
function parseAllowedIps(list) {
    if (list == null || list === '') return [];
    const items = (Array.isArray(list) ? list : String(list).split(/[\s,]+/)).map(x => String(x).trim()).filter(Boolean);
    if (items.length > MAX_ALLOWED_IPS) throw apiError(400, 'INVALID_ALLOWED_IPS', `List at most ${MAX_ALLOWED_IPS} addresses or ranges.`);
    const out = [];
    for (const raw of items) {
        const [addr, bits, extra] = raw.split('/');
        const ip = normalizeIp(addr);
        const fam = net.isIP(ip);
        const max = fam === 4 ? 32 : 128;
        const ok = fam && extra === undefined && (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= max));
        if (!ok) throw apiError(400, 'INVALID_ALLOWED_IPS', `"${raw.slice(0, 60)}" is not an IP address or a CIDR range.`);
        out.push(bits === undefined ? ip : `${ip}/${Number(bits)}`);
    }
    return [...new Set(out)];
}

function ipAllowed(ip, allowed) {
    if (!allowed || !allowed.length) return true;
    const addr = normalizeIp(ip);
    const fam = net.isIP(addr);
    if (!fam) return false;
    const type = fam === 4 ? 'ipv4' : 'ipv6';
    const list = new net.BlockList();
    for (const entry of allowed) {
        const [a, bits] = entry.split('/');
        const efam = net.isIP(a);
        if (!efam) continue;
        const etype = efam === 4 ? 'ipv4' : 'ipv6';
        if (bits === undefined) list.addAddress(a, etype);
        else list.addSubnet(a, Number(bits), etype);
    }
    return list.check(addr, type);
}

// The row as the admin UI shows it (never the hash).
function publicRow(r) {
    return {
        id: r.id, name: r.name, prefix: r.key_prefix, scopes: r.scopes || [], allowedIps: r.allowed_ips || [],
        createdBy: r.created_by || '', createdAt: r.created_at, expiresAt: r.expires_at || null,
        lastUsedAt: r.last_used_at || null, lastUsedIp: r.last_used_ip || '',
        revokedAt: r.revoked_at || null, revokedBy: r.revoked_by || '',
    };
}

async function listApiKeys() {
    const r = await pool.query('SELECT * FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC');
    return r.rows.map(publicRow);
}

// Create a key. Returns { key, apiKey } - the only time the key itself leaves this module.
async function createApiKey(body, viewer) {
    const name = String((body && body.name) || '').trim();
    if (!name || name.length > MAX_NAME) throw apiError(400, 'INVALID_NAME', `Enter a name of up to ${MAX_NAME} characters.`);
    const scopes = [...new Set(Array.isArray(body && body.scopes) ? body.scopes.map(String) : [])];
    if (!scopes.length || scopes.some(s => !Object.hasOwn(SCOPES, s))) throw apiError(400, 'INVALID_SCOPES', 'Choose at least one permission.');
    const allowedIps = parseAllowedIps(body && body.allowedIps);
    let expiresAt = null;
    if (body && body.expiresAt) {
        const t = new Date(body.expiresAt);
        if (Number.isNaN(t.getTime()) || t.getTime() <= Date.now()) throw apiError(400, 'INVALID_EXPIRY', 'Choose an expiry date in the future.');
        expiresAt = t;
    }
    const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query(
            `INSERT INTO api_keys (name, key_prefix, key_hash, scopes, allowed_ips, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [name, key.slice(0, KEY_PREFIX_LEN), sha256(key), scopes, allowedIps, (viewer && viewer.email) || '', expiresAt]);
        const row = r.rows[0];
        await writeAuditStrict(client, {
            ...viewerActor(viewer), action: 'apikey.create', target: name,
            meta: { id: row.id, prefix: row.key_prefix, scopes, allowedIps, expiresAt },
        });
        await client.query('COMMIT');
        return { key, apiKey: publicRow(row) };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => { });
        throw e;
    } finally {
        client.release();
    }
}

// A key id exactly as stored (SERIAL: 1 to 2147483647), as a number or a string of digits.
// Anything else ("1abc", "1.5", "1e3", "01", " 1") is no id, so no key can match it.
const MAX_KEY_ID = 2147483647;
function parseKeyId(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : NaN);
    return Number.isSafeInteger(n) && n >= 1 && n <= MAX_KEY_ID ? n : null;
}

async function revokeApiKey(id, viewer) {
    const n = parseKeyId(id);
    if (n === null) throw apiError(404, 'NOT_FOUND', 'This key does not exist.');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query(
            'UPDATE api_keys SET revoked_at = NOW(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *',
            [n, (viewer && viewer.email) || '']);
        if (!r.rows.length) {
            // Already revoked, or no such key. Asked on the same connection, so repeated revokes
            // never hold one connection while they wait for another.
            const exists = await client.query('SELECT 1 FROM api_keys WHERE id = $1', [n]);
            await client.query('ROLLBACK');
            if (!exists.rows.length) throw apiError(404, 'NOT_FOUND', 'This key does not exist.');
            return { ok: true, alreadyRevoked: true };
        }
        const row = r.rows[0];
        await writeAuditStrict(client, { ...viewerActor(viewer), action: 'apikey.revoke', target: row.name, meta: { id: row.id, prefix: row.key_prefix } });
        await client.query('COMMIT');
        return { ok: true, apiKey: publicRow(row) };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => { });
        throw e;
    } finally {
        client.release();
    }
}

const isUsable = (row, now = Date.now()) => !row.revoked_at && !(row.expires_at && new Date(row.expires_at).getTime() <= now);

// Find the key a caller presented. Returns the row, or throws an apiError.
async function authenticateKey(raw, ip) {
    const key = String(raw || '');
    if (!KEY_RE.test(key)) throw apiError(401, 'INVALID_KEY', 'The API key is not valid.');
    const r = await pool.query({ text: 'SELECT * FROM api_keys WHERE key_prefix = $1', values: [key.slice(0, KEY_PREFIX_LEN)], query_timeout: QUERY_TIMEOUT_MS });
    const want = Buffer.from(sha256(key), 'hex');
    const row = r.rows.find(x => {
        const have = Buffer.from(String(x.key_hash || ''), 'hex');
        return have.length === want.length && crypto.timingSafeEqual(have, want);
    });
    if (!row) throw apiError(401, 'INVALID_KEY', 'The API key is not valid.');
    if (row.revoked_at) throw apiError(401, 'KEY_REVOKED', 'This API key was revoked.');
    if (!isUsable(row)) throw apiError(401, 'KEY_EXPIRED', 'This API key has expired.');
    if (!ipAllowed(ip, row.allowed_ips)) throw apiError(403, 'IP_NOT_ALLOWED', 'This API key may not be used from this address.');
    return row;
}

// Last use, at most once a minute per key (never blocks the request).
function touchKey(row, ip) {
    const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
    if (Date.now() - last < TOUCH_EVERY_MS) return;
    pool.query('UPDATE api_keys SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1', [row.id, normalizeIp(ip)])
        .catch((e) => console.error('[api-keys] could not record last use:', e.message));
}

// Is the key still usable for this scope? (A launch link is checked again when it is opened.)
async function keyStillValid(id, scope) {
    const r = await pool.query('SELECT * FROM api_keys WHERE id = $1', [id]);
    const row = r.rows[0];
    return !!(row && isUsable(row) && (row.scopes || []).includes(scope));
}

// Refusals of a real key (its hash matched a stored key): the caller holds that key and is not
// guessing, so these don't count toward the failed-auth throttle.
const KNOWN_KEY_REFUSALS = new Set(['KEY_REVOKED', 'IP_NOT_ALLOWED']);

// Express middleware: a valid key holding `scope` on req.apiKey, else a JSON error. The key is
// checked first, so a valid key always works. Only a failed attempt consults the caller's per-IP
// failed-auth throttle (shared with the webhooks): while that address is blocked every failed
// attempt gets 429, else a missing, malformed, unknown or expired key counts toward it.
function requireApiKey(scope, { tooManyAuthFails, noteAuthFail }) {
    return async (req, res, next) => {
        const refuse = (status, code, error) => {
            if (tooManyAuthFails(req.ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again later.', code: 'TOO_MANY_FAILURES' });
            if (!KNOWN_KEY_REFUSALS.has(code)) noteAuthFail(req.ip);
            return res.status(status).json({ error, code });
        };
        try {
            const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
            if (!m) return refuse(401, 'MISSING_KEY', 'Send the API key as "Authorization: Bearer <key>".');
            let row;
            try { row = await authenticateKey(m[1], req.ip); } catch (e) {
                if (!e.status) throw e;
                return refuse(e.status, e.code, e.message);
            }
            if (!(row.scopes || []).includes(scope)) return res.status(403).json({ error: 'This API key has no permission for this action.', code: 'SCOPE_MISSING' });
            req.apiKey = { id: row.id, name: row.name, prefix: row.key_prefix, scopes: row.scopes || [] };
            touchKey(row, req.ip);
            next();
        } catch (e) {
            console.error('[api-keys] auth error:', e.message);
            res.status(503).json({ error: 'The API key could not be checked. Try again.', code: 'UNAVAILABLE' });
        }
    };
}

module.exports = {
    SCOPES, KEY_PREFIX_LEN, QUERY_TIMEOUT_MS, apiError, writeAuditStrict, keyActor,
    listApiKeys, createApiKey, revokeApiKey, authenticateKey, keyStillValid, requireApiKey,
    _internal: { normalizeIp, parseAllowedIps, ipAllowed, sha256, isUsable, parseKeyId },
};
