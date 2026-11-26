'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const { pool } = require('./core');
const { addEvent } = require('./events');
const ra = require('./remote-access');
const { evaluateExitNodeEntitlement, browserGateProblem, browserLiveProblem } = require('./remote-access-auth');

const DEFAULT_ENDPOINTS = {
    supervisor: '/run/nbc-control/supervisor.sock',
    connections: '/run/nbc-connections/connections.sock',
    guacd: { host: '172.31.250.4', port: 4822 },
};
const INSTANCE = crypto.randomUUID();
const SUPERVISOR_TIMEOUT_MS = 10_000;
const SUPERVISOR_STOP_TIMEOUT_MS = 30_000;
const SUPERVISOR_REPLY_MAX = 4 * 1024 * 1024;
const TOKEN_TTL_S = 30;
const GUACD_PROBE_TIMEOUT_MS = 2000;
const VIEWER_LEASE_S = 150;
const AUTH_GRACE_MS = 150_000;
const LOOP_INTERVAL_MS = 60_000;
const WATCH_INTERVAL_MS = 5_000;
const STARTING_STALE_MS = 2 * 60_000;
const DISPLAY_TIMEOUT_MS = 20_000;
const HEALTH_TTL_MS = 15_000;
const ENDED_KEEP_DAYS = 30;
const CAPACITY_LOCK = 0x4e424252;
const SCREEN = { minWidth: 320, minHeight: 240, maxWidth: 1920, maxHeight: 1080 };
const CONNECTIONS_PER_SESSION = 2000;
const QUEUED_RECORDS_MAX = 5000;
const LEADER_CONCURRENCY = 5;
const PENDING_RECORD_MS = 30_000;
const PENDING_RECORDS_MAX = 5000;
const UID_LOOKUP_GAP_MS = 1000;
const COLLECTOR_LINE_MAX = 64 * 1024;
const SOURCE_TYPE = 'BROWSER_GATEWAY';
const SESSION_REFERENCE = 'remote-access:web';
const CONNECTION_REFERENCE = 'remote-access:web-connection';
const OPEN_STATES = ['active', 'detached'];
const CODE = { ended: 0x020B, takenOver: 0x0205, denied: 0x0303, restarting: 0x0201, lost: 0x0208 };
const TAKEN_OVER = 'Your browser was opened in another window.';
const BROWSER_CLOSED = 'The browser was closed.';
const BROWSER_RESTARTED = 'The remote browser restarted, so the session ended.';
const UNVERIFIED = "Your access couldn't be verified with NetBird, so the session ended.";

const MESSAGES = {
    BROWSER_DISABLED: 'Web sessions are turned off. Ask an administrator to turn them on in Settings > Remote Access.',
    USER_NOT_FOUND: "Your account wasn't found in NetBird, so your access can't be checked. Ask an administrator to check your NetBird account.",
    USER_BLOCKED: 'Your NetBird account is blocked. Ask an administrator to unblock it.',
    NO_EXIT_NODE: 'Web sessions are only for people whose device may use the office exit node in NetBird. Ask an administrator if you need it.',
    SNAPSHOT_FAILED: "Remote Access couldn't read NetBird to check your access. Try again in a minute.",
    GATEWAY_NOT_READY: "The browser gateway isn't ready, so web sessions can't open right now. Try again later, or tell an administrator.",
    GUACD_UNREACHABLE: "NetBird Control can't reach the remote browser's display service, so web sessions can't open right now. Try again later, or tell an administrator.",
    BROWSER_CAPACITY: 'Every web session is in use right now. Try again later.',
    BROWSER_UNAVAILABLE: "The remote browser isn't answering right now. Try again in a minute, or tell an administrator.",
    RECORD_FAILED: "Remote Access couldn't record the session, so it wasn't opened. Try again.",
    SESSION_NOT_FOUND: 'This web session was not found.',
    BROWSER_ENDED: 'This web session has ended.',
    SESSION_ENDING: 'This web session is ending.',
    SESSION_STARTING: 'This web session is still opening. Try again in a moment.',
    SESSION_CLOSED: 'The session was closed before it finished opening. Open a new one.',
    SERVER_RESTARTING: 'NetBird Control is restarting or shutting down. Try again in a minute.',
};

const GATE_REASONS = {
    WEB_NOT_SET_UP: "The NetBird objects for web sessions aren't set up. Save the Remote Access settings.",
    WEB_ROUTER_GROUP_MISSING: 'Choose the routing group for web sessions. The chosen group may no longer exist in NetBird.',
    WEB_PEER_NOT_ENROLLED: "The browser gateway isn't enrolled. Create its setup key and start it.",
    WEB_GROUP_CHANGED: 'The browser gateway group holds another peer than the enrolled browser gateway.',
    WEB_ACL_CHANGED: "The access control group of the web route isn't empty.",
    WEB_ROUTE_CHANGED: 'The internet route of the web sessions was changed or deleted in NetBird. Save the Remote Access settings to repair it.',
    WEB_POLICY_CHANGED: 'A policy of the web sessions was changed or deleted in NetBird. Save the Remote Access settings to repair it.',
    BROWSER_UNAVAILABLE: "The remote browser service isn't answering.",
    GATEWAY_STATUS_MISSING: "The browser gateway hasn't reported its status.",
    GATEWAY_STATUS_STALE: 'The browser gateway stopped reporting its status.',
    GATEWAY_NETNS_CHANGED: 'The remote browser runs in another network namespace than the browser gateway.',
    GATEWAY_LOCK_MISSING: "The browser gateway's network lock isn't in place.",
    GATEWAY_ADDRESS_CHANGED: "The browser gateway's NetBird address doesn't match the enrolled peer.",
    GATEWAY_ROUTES_CHANGED: 'The browser gateway received another route than the internet route of the web sessions.',
    GUACD_UNREACHABLE: "NetBird Control can't reach the remote browser's guacd (172.31.250.4:4822). Check that the remote-browser-guacd container runs.",
    SNAPSHOT_FAILED: "NetBird couldn't be read.",
};

let _endpoints = { ...DEFAULT_ENDPOINTS };
let _deps = {};
let _shuttingDown = false;
let _supervisorInstance = '';
const _attached = new Map();

const httpError = (status, code, message) => ra.httpError(status, code, message || MESSAGES[code]);
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const rowsOf = (r) => (r && Array.isArray(r.rows) ? r.rows : []);
const msOf = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : 0; };
const iso = (v) => (msOf(v) ? new Date(msOf(v)).toISOString() : null);
const browserActive = () => ra.remoteAccessAvailable() && ra.browserWanted();
const config = () => ra.getRemoteAccessConfig();

function setRemoteBrowserDeps(deps) { _deps = { ..._deps, ...deps }; }

function supervisorRequest(request, timeoutMs = SUPERVISOR_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(_endpoints.supervisor);
        let buffered = '';
        let done = false;
        const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sock.destroy();
            if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('the remote browser did not answer in time')), timeoutMs);
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
        sock.on('data', (chunk) => {
            buffered += chunk;
            const newline = buffered.indexOf('\n');
            if (newline < 0) {
                if (buffered.length > SUPERVISOR_REPLY_MAX) finish(new Error('the remote browser sent an answer that is too long'));
                return;
            }
            let reply;
            try { reply = JSON.parse(buffered.slice(0, newline)); } catch { return finish(new Error('the remote browser sent an answer that could not be read')); }
            if (!reply || typeof reply !== 'object') return finish(new Error('the remote browser sent an answer that could not be read'));
            noteInstance(reply);
            finish(null, reply);
        });
        sock.on('error', (e) => finish(e));
        sock.on('close', () => finish(new Error('the remote browser closed the connection')));
    });
}

function noteInstance(reply) {
    const instance = typeof reply.instance === 'string' ? reply.instance : '';
    if (!instance || instance === _supervisorInstance) return;
    _supervisorInstance = instance;
    for (const [uid, s] of _uidSessions) if (s.instance !== instance) _uidSessions.delete(uid);
}

const isExpired = (reply) => !!reply && reply.ok !== true && reply.error === 'EXPIRED';
const isGone = (reply) => !!reply && reply.ok !== true && (reply.error === 'ENDED' || reply.error === 'UNKNOWN');

function guacdReachable() {
    return new Promise((resolve) => {
        const sock = net.connect(_endpoints.guacd);
        const done = (ok) => { clearTimeout(timer); sock.destroy(); resolve(ok); };
        const timer = setTimeout(() => done(false), GUACD_PROBE_TIMEOUT_MS);
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
    });
}

const peerOf = (snap, peerId) => (peerId ? (snap.peers || []).find(p => p && p.id === peerId) : null) || null;

async function checkGate(snap, { probeGuacd = true } = {}) {
    const gate = await ra.readBrowserGate();
    const peer = peerOf(snap, gate.ids.webPeerId);
    const base = { ids: gate.ids, peer };
    const apiProblem = browserGateProblem(snap, gate.ids, gate.want);
    if (apiProblem) return { ...base, ok: false, code: apiProblem };
    let ready = null;
    try { ready = await supervisorRequest({ op: 'ready' }); } catch (e) { console.error('[remote-browser] the supervisor did not answer "ready":', e.message); }
    const liveProblem = browserLiveProblem(ready, { peerIp: peer ? String(peer.ip || '') : '', nowSec: Math.floor(Date.now() / 1000) });
    if (liveProblem) return { ...base, ok: false, code: liveProblem };
    if (probeGuacd && !(await guacdReachable())) return { ...base, ok: false, code: 'GUACD_UNREACHABLE' };
    return { ...base, ok: true, code: 'OK' };
}

function entitlementCfg() {
    const managed = config().managed || {};
    return {
        webRouteId: managed.webRouteId || '',
        managedPolicyIds: [managed.policyId, managed.namesPolicyId, managed.webPolicyId, managed.webRoutingPolicyId].filter(Boolean),
    };
}

const notReadyMessage = (gateCode) => (gateCode === 'GUACD_UNREACHABLE' ? MESSAGES.GUACD_UNREACHABLE : MESSAGES.GATEWAY_NOT_READY);

async function authorize(viewer) {
    if (!browserActive()) throw httpError(403, 'BROWSER_DISABLED');
    if (_shuttingDown) throw httpError(503, 'SERVER_RESTARTING');
    let snap;
    try { snap = await ra.freshSnapshot(ra.CHECK_SNAPSHOT_TTL_MS); } catch { throw httpError(503, 'SNAPSHOT_FAILED'); }
    const entitlement = evaluateExitNodeEntitlement(snap, entitlementCfg(), { userId: viewer.user_id });
    if (!entitlement.ok) throw httpError(403, entitlement.code);
    const gate = await checkGate(snap);
    if (!gate.ok) {
        console.warn('[remote-browser] the browser gateway is not ready: %s', gate.code);
        throw httpError(503, 'GATEWAY_NOT_READY', notReadyMessage(gate.code));
    }
    if (_shuttingDown) throw httpError(503, 'SERVER_RESTARTING');
    return entitlement;
}

async function checkWebAccess(viewer) {
    const ready = (code, retry = false, message = MESSAGES[code]) => ({ steps: [{ key: 'ready', status: 'fail', code, message, retry }] });
    if (!browserActive()) return ready('BROWSER_DISABLED');
    if (_shuttingDown) return ready('SERVER_RESTARTING', true);
    let snap;
    try { snap = await ra.freshSnapshot(ra.CHECK_SNAPSHOT_TTL_MS); } catch { return ready('SNAPSHOT_FAILED', true); }
    const entitlement = evaluateExitNodeEntitlement(snap, entitlementCfg(), { userId: viewer.user_id });
    if (!entitlement.ok) return { steps: [{ key: 'access', status: 'fail', code: entitlement.code, message: MESSAGES[entitlement.code] }] };
    const gate = await checkGate(snap);
    if (!gate.ok) return ready('GATEWAY_NOT_READY', false, notReadyMessage(gate.code));
    return {
        ok: true,
        steps: [
            { key: 'access', status: 'pass', detail: 'Your device may use the office exit node' },
            { key: 'path', status: 'pass', detail: 'The browser gateway is ready' },
        ],
    };
}

function screen(body) {
    const b = body && typeof body === 'object' ? body : {};
    return {
        width: clampInt(b.width, SCREEN.minWidth, SCREEN.maxWidth, 1280),
        height: clampInt(b.height, SCREEN.minHeight, SCREEN.maxHeight, 720),
        dpi: clampInt(b.dpi, 72, 480, 96),
        timezone: /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(b.timezone || '')) ? String(b.timezone) : '',
    };
}

const fitSize = (w, h) => (w > 0 && h > 0 ? [Math.min(Math.floor(w), SCREEN.maxWidth), Math.min(Math.floor(h), SCREEN.maxHeight)] : null);

async function reserveSlot(row, max) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_LOCK]);
        const n = Number((rowsOf(await client.query(`SELECT COUNT(*)::int AS n FROM browser_sessions WHERE state <> 'ended'`))[0] || {}).n) || 0;
        if (n >= max) {
            await client.query('ROLLBACK');
            return false;
        }
        await client.query(
            `INSERT INTO browser_sessions (id, user_id, user_email, user_name, oid, client_ip, state, width, height, dpi, attachment, last_auth_ok_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'starting', $7, $8, $9, $10, $11, NOW())`,
            [row.id, row.userId, row.userEmail, row.userName, row.oid, row.clientIp, row.width, row.height, row.dpi, row.attachment, row.authorizedAt]);
        await client.query('COMMIT');
        return true;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => { });
        throw e;
    } finally {
        client.release();
    }
}

function webSessionEvent(row, kind, { reason = '', at = new Date() } = {}) {
    const end = kind === 'end';
    return {
        ID: `${row.id}:${kind}`,
        Timestamp: (end ? at : new Date(msOf(row.created_at) || Date.now())).toISOString(),
        Message: end ? 'TYPE_END' : 'TYPE_START',
        reference: SESSION_REFERENCE,
        meta: {
            flow_id: row.id, protocol: 6, direction: 'EGRESS',
            source_addr: row.client_ip || '', source_name: 'Browser Gateway', source_type: SOURCE_TYPE,
            destination_addr: '', destination_name: 'Remote Browser', destination_id: '', destination_type: '',
            user_id: row.user_id, rx_bytes: 0, tx_bytes: 0,
        },
        remoteAccess: { protocol: 'web', user: row.user_email || row.user_name || '', gateway: 'web', endReason: reason || undefined },
    };
}

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const keepAliveMin = () => config().browser.keepAliveMin;
const keepAliveText = () => `The session ended after ${keepAliveMin()} minutes without a connection.`;
const RESUMABLE = `state = ANY($2) AND (state <> 'detached' OR detached_at > NOW() - $3 * interval '1 minute')`;

async function issueToken(id) {
    const token = crypto.randomBytes(32).toString('base64url');
    const r = await pool.query(
        `UPDATE browser_sessions SET token_hash = $4, token_expires = NOW() + interval '${TOKEN_TTL_S} seconds' WHERE id = $1 AND ${RESUMABLE} RETURNING id`,
        [id, OPEN_STATES, keepAliveMin(), tokenHash(token)]);
    return rowsOf(r).length ? token : null;
}

async function takeToken(token) {
    const value = String(token || '');
    if (!value) return null;
    let row;
    try {
        row = rowsOf(await pool.query(
            `UPDATE browser_sessions SET token_hash = NULL, token_expires = NULL WHERE token_hash = $1 AND token_expires > NOW() AND state = ANY($2)
             RETURNING id, user_id, attachment, width, height, dpi`,
            [tokenHash(value), OPEN_STATES]))[0];
    } catch (e) {
        console.error('[remote-browser] could not check a session token:', e.message);
        return null;
    }
    if (!row || !browserActive() || _shuttingDown) return null;
    return { sessionId: row.id, attachment: row.attachment, userId: row.user_id, width: row.width, height: row.height, dpi: row.dpi };
}

async function createWebSession(viewer, body, clientIp) {
    const authorizedAt = new Date();
    await authorize(viewer);
    const size = screen(body);
    const row = {
        id: crypto.randomUUID(), attachment: crypto.randomUUID(), authorizedAt,
        userId: viewer.user_id, userEmail: viewer.email || '', userName: viewer.name || '', oid: viewer.oid || '',
        clientIp: String(clientIp || ''), ...size,
    };
    let reserved;
    try { reserved = await reserveSlot(row, config().browser.maxSessions); } catch (e) {
        console.error('[remote-browser] could not reserve a session:', e.message);
        throw httpError(503, 'RECORD_FAILED');
    }
    if (!reserved) throw httpError(429, 'BROWSER_CAPACITY');
    try {
        let started;
        try {
            started = await supervisorRequest({ op: 'start', session: row.id, width: row.width, height: row.height, dpi: row.dpi, terminal: false, until: authorizedAt.getTime() + AUTH_GRACE_MS });
        } catch (e) {
            console.error('[remote-browser] start failed:', e.message);
            throw httpError(503, 'BROWSER_UNAVAILABLE');
        }
        if (!started || started.ok !== true) throw httpError(started && started.error === 'CAPACITY' ? 429 : 503, started && started.error === 'CAPACITY' ? 'BROWSER_CAPACITY' : 'BROWSER_UNAVAILABLE');
        const u = await pool.query(
            `UPDATE browser_sessions SET state = 'detached', detached_at = NOW(), uid = $2, port = $3, supervisor_instance = $4, browser_started_at = $5
             WHERE id = $1 AND state = 'starting' RETURNING *`,
            [row.id, started.uid, started.port, String(started.instance || ''), Number.isFinite(started.startedAt) ? new Date(started.startedAt) : null]);
        const stored = rowsOf(u)[0];
        if (!stored) throw httpError(409, 'SESSION_CLOSED');
        if (_connServer) noteUid(stored);
        try {
            await addEvent(webSessionEvent(stored, 'start'));
            await pool.query('UPDATE browser_sessions SET recorded = true WHERE id = $1', [row.id]);
        } catch (e) {
            console.error('[remote-browser] could not record the session start:', e.message);
            throw httpError(503, 'RECORD_FAILED');
        }
        if (_shuttingDown) throw httpError(503, 'SERVER_RESTARTING');
        const token = await issueToken(row.id);
        if (!token) throw httpError(409, 'SESSION_CLOSED');
        return { sessionId: row.id, token, attachment: row.attachment, protocol: 'web', keepAliveMin: keepAliveMin() };
    } catch (e) {
        await endWebSession(row.id, _shuttingDown ? 'The server is restarting.' : 'The session did not open.').catch(() => { });
        throw e;
    }
}

async function sessionRow(id) {
    return rowsOf(await pool.query('SELECT * FROM browser_sessions WHERE id = $1', [String(id)]))[0] || null;
}

async function browserCredentials(id, until) {
    try {
        const r = await supervisorRequest({ op: 'credentials', session: id, until });
        if (r && r.ok === true) return r;
        if (isGone(r)) return 'gone';
        if (isExpired(r)) return 'expired';
        console.error('[remote-browser] session %s: credentials refused: %s', id, (r && r.error) || 'no answer');
    } catch (e) {
        console.error('[remote-browser] session %s: credentials failed: %s', id, e.message);
    }
    return null;
}

async function endIfKeepAlivePassed(id) {
    const r = await pool.query(
        `SELECT id FROM browser_sessions WHERE id = $1 AND state = 'detached' AND detached_at <= NOW() - $2 * interval '1 minute'`,
        [id, keepAliveMin()]);
    if (!rowsOf(r).length) return false;
    await endWebSession(id, keepAliveText()).catch(() => { });
    return true;
}

async function resumeWebSession(viewer, id, body) {
    const row = await sessionRow(id);
    if (!row || row.user_id !== viewer.user_id) throw httpError(404, 'SESSION_NOT_FOUND');
    if (row.state === 'ended') throw httpError(410, 'BROWSER_ENDED');
    if (row.state === 'ending') throw httpError(409, 'SESSION_ENDING');
    if (row.state === 'starting') throw httpError(409, 'SESSION_STARTING');
    const authorizedAt = new Date();
    await authorize(viewer);
    const creds = await browserCredentials(row.id, authorizedAt.getTime() + AUTH_GRACE_MS);
    if (creds === 'gone' || creds === 'expired') {
        await endWebSession(row.id, creds === 'gone' ? BROWSER_CLOSED : UNVERIFIED, creds === 'gone' ? CODE.ended : CODE.denied).catch(() => { });
        throw httpError(410, 'BROWSER_ENDED');
    }
    if (!creds) throw httpError(503, 'BROWSER_UNAVAILABLE');
    const size = screen(body);
    const attachment = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const u = await pool.query(
        `UPDATE browser_sessions SET attachment = $5, last_auth_ok_at = GREATEST(last_auth_ok_at, $10), width = $6, height = $7, dpi = $8,
            token_hash = $9, token_expires = NOW() + interval '${TOKEN_TTL_S} seconds'
         WHERE id = $1 AND user_id = $4 AND ${RESUMABLE} RETURNING id`,
        [row.id, OPEN_STATES, keepAliveMin(), viewer.user_id, attachment, size.width, size.height, size.dpi, tokenHash(token), authorizedAt]);
    if (!rowsOf(u).length) {
        await endIfKeepAlivePassed(row.id);
        throw httpError(410, 'BROWSER_ENDED');
    }
    const local = _attached.get(row.id);
    if (local) closeLocal(local, TAKEN_OVER, CODE.takenOver);
    return { sessionId: row.id, token, attachment, protocol: 'web', keepAliveMin: keepAliveMin() };
}

async function listWebSessions(viewer) {
    const r = await pool.query(
        `SELECT id, state, width, height, created_at, detached_at FROM browser_sessions WHERE user_id = $1 AND state <> 'ended' ORDER BY created_at`,
        [viewer.user_id]);
    const keepAliveMs = keepAliveMin() * 60_000;
    return {
        keepAliveMin: keepAliveMin(),
        sessions: rowsOf(r).map(x => ({
            sessionId: x.id, state: x.state, width: x.width, height: x.height, createdAt: iso(x.created_at),
            detachedAt: x.state === 'detached' ? iso(x.detached_at) : null,
            expiresAt: x.state === 'detached' && msOf(x.detached_at) ? new Date(msOf(x.detached_at) + keepAliveMs).toISOString() : null,
        })),
    };
}

async function renewWebLease(viewer, id, attachment) {
    if (!attachment) return false;
    const r = await pool.query(
        `UPDATE browser_sessions SET lease_expires_at = CASE WHEN state = 'active' THEN NOW() + interval '${VIEWER_LEASE_S} seconds' ELSE lease_expires_at END
         WHERE id = $1 AND user_id = $2 AND attachment = $4 AND state = ANY($3) RETURNING id`,
        [String(id), viewer.user_id, [...OPEN_STATES, 'starting'], String(attachment)]);
    return rowsOf(r).length > 0;
}

async function endWebSessionByUser(viewer, id) {
    const row = await sessionRow(id);
    if (!row || row.user_id !== viewer.user_id) return null;
    if (row.state === 'ended') throw httpError(410, 'BROWSER_ENDED');
    return (await endWebSession(row.id, 'Closed by the user.')) ? 'stopped' : 'ending';
}

async function endWebSession(id, reason, code = CODE.ended) {
    const marked = rowsOf(await pool.query(
        `UPDATE browser_sessions SET state = 'ending', token_hash = NULL, token_expires = NULL,
            end_code = CASE WHEN COALESCE(end_reason, '') = '' THEN $3 ELSE end_code END,
            end_reason = CASE WHEN COALESCE(end_reason, '') = '' THEN $2 ELSE end_reason END
         WHERE id = $1 AND state <> 'ended' RETURNING *`, [id, reason, code]))[0];
    if (!marked) return true;
    forgetUid(marked);
    const local = _attached.get(id);
    if (local) closeLocal(local, marked.end_reason || reason, marked.end_code || code);
    let stopped = null;
    try { stopped = await supervisorRequest({ op: 'stop', session: id }, SUPERVISOR_STOP_TIMEOUT_MS); } catch (e) {
        console.error('[remote-browser] session %s: stop failed: %s', id, e.message);
        return false;
    }
    if (!stopped || stopped.ok !== true) {
        console.error('[remote-browser] session %s: stop failed: %s', id, (stopped && stopped.error) || 'no answer');
        return false;
    }
    if (marked.recorded) await addEvent(webSessionEvent(marked, 'end', { reason: marked.end_reason || reason }));
    await pool.query(`UPDATE browser_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1 AND state = 'ending'`, [id]);
    return true;
}

function vncArgs(names, creds) {
    const clipboard = config().clipboard;
    const map = {
        hostname: '127.0.0.1', port: String(creds.port), password: String(creds.password || ''),
        'color-depth': '24',
        'disable-copy': clipboard ? '' : 'true', 'disable-paste': clipboard ? '' : 'true',
        'enable-sftp': '', 'enable-audio': '',
    };
    return names.map(name => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : ''));
}

function closeLocal(s, message, code) {
    if (s.closed) return;
    s.detachOnClose = false;
    if (message) ra.sendError(s.ws, message, code);
    release(s, code);
}

function release(s, code = 0) {
    if (s.closed) return false;
    s.closed = true;
    if (_attached.get(s.id) === s) _attached.delete(s.id);
    try { if (s.guacd) s.guacd.destroy(); } catch { }
    try { if (s.ws && s.ws.readyState <= 1) s.ws.close(1000, String(code)); } catch { }
    return true;
}

async function detach(s) {
    await pool.query(
        `UPDATE browser_sessions SET state = 'detached', detached_at = NOW(), owner_instance = '' WHERE id = $1 AND attachment = $2 AND state = 'active'`,
        [s.id, s.attachment]).catch(e => console.error('[remote-browser] session %s: could not record the detach: %s', s.id, e.message));
}

async function browserClosed(id) {
    try {
        return isGone(await supervisorRequest({ op: 'status', session: id }));
    } catch {
        return false;
    }
}

function onTunnelEnd(s, from, message, code) {
    if (s.closed || s.ending) return;
    s.ending = true;
    if (!s.detachOnClose) { release(s, code); return; }
    if (from === 'browser' || from === 'disconnect') {
        release(s, 0);
        detach(s);
        return;
    }
    browserClosed(s.id).then(async (closed) => {
        if (s.closed) return;
        if (closed) {
            await endWebSession(s.id, BROWSER_CLOSED).catch(() => { });
            if (!s.closed) closeLocal(s, BROWSER_CLOSED, CODE.ended);
            return;
        }
        ra.sendError(s.ws, message || 'The connection to the remote browser was lost. Resume the session to continue.', code || CODE.lost);
        release(s, code || CODE.lost);
        await detach(s);
    });
}

async function attachWebTunnel(entry, ws) {
    const refuse = (message, code) => { ra.sendError(ws, message, code); try { ws.close(1000, String(code)); } catch { } };
    let row;
    try { row = await sessionRow(entry.sessionId); } catch { return refuse(MESSAGES.BROWSER_UNAVAILABLE, CODE.lost); }
    if (!row || row.user_id !== entry.userId || row.attachment !== entry.attachment || !OPEN_STATES.includes(row.state)) {
        const takenOver = !!row && row.attachment !== entry.attachment && OPEN_STATES.includes(row.state);
        return refuse(takenOver ? TAKEN_OVER : (row && row.end_reason) || 'This session is no longer available.', takenOver ? CODE.takenOver : (row && row.end_code) || CODE.ended);
    }
    let creds = await browserCredentials(row.id, msOf(row.last_auth_ok_at) + AUTH_GRACE_MS);
    if (creds === 'gone' || creds === 'expired') {
        const [reason, code] = creds === 'gone' ? [BROWSER_CLOSED, CODE.ended] : [UNVERIFIED, CODE.denied];
        await endWebSession(row.id, reason, code).catch(() => { });
        return refuse(reason, code);
    }
    if (!creds) return refuse(MESSAGES.BROWSER_UNAVAILABLE, CODE.lost);
    const u = await pool.query(
        `UPDATE browser_sessions SET state = 'active', owner_instance = $5, detached_at = NULL, lease_expires_at = NOW() + interval '${VIEWER_LEASE_S} seconds'
         WHERE id = $1 AND attachment = $4 AND ${RESUMABLE} RETURNING id`,
        [row.id, OPEN_STATES, keepAliveMin(), entry.attachment, INSTANCE]).catch(() => null);
    if (!u || !rowsOf(u).length) {
        const expired = await endIfKeepAlivePassed(row.id).catch(() => false);
        return refuse(expired ? keepAliveText() : 'This session is no longer available.', CODE.ended);
    }
    if (ws.readyState !== 1) {
        await detach({ id: row.id, attachment: entry.attachment });
        return undefined;
    }
    const previous = _attached.get(row.id);
    if (previous) closeLocal(previous, TAKEN_OVER, CODE.takenOver);
    const s = {
        id: row.id, attachment: entry.attachment, protocol: 'web',
        width: entry.width, height: entry.height, dpi: entry.dpi, timezone: '',
        state: 'connecting', closed: false, ending: false, detachOnClose: true, rx: 0, tx: 0, lastInputAt: Date.now(), creds: {}, ws: null, guacd: null,
    };
    _attached.set(row.id, s);
    ra.pipeTunnel(s, ws, {
        guacd: _endpoints.guacd,
        select: 'vnc',
        connectArgs: (names) => {
            const values = vncArgs(names, creds);
            creds = null;
            return values;
        },
        argv: [],
        fitSize,
        displayTimeoutMs: DISPLAY_TIMEOUT_MS,
        displayFailedMessage: "The remote browser's screen didn't open. Resume the session to try again.",
        fail: (message, code, detail) => {
            if (detail) console.error('[remote-browser] session %s: %s (%s)', s.id, message, detail);
            onTunnelEnd(s, 'error', message, code);
        },
        close: (reason, from) => onTunnelEnd(s, from, '', 0),
    });
    return undefined;
}

async function watchAttached() {
    if (!_attached.size) return;
    const watched = [..._attached.entries()];
    let rows;
    try { rows = rowsOf(await pool.query('SELECT id, state, attachment, end_reason, end_code FROM browser_sessions WHERE id = ANY($1)', [watched.map(([id]) => id)])); } catch { return; }
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const [id, s] of watched) {
        if (s.closed || _attached.get(id) !== s) continue;
        const row = byId.get(id);
        if (!row || row.state === 'ending' || row.state === 'ended') closeLocal(s, (row && row.end_reason) || 'The session ended.', (row && row.end_code) || CODE.ended);
        else if (row.attachment !== s.attachment) closeLocal(s, TAKEN_OVER, CODE.takenOver);
        else if (row.state === 'detached') closeLocal(s, 'Your sign-in ended or the page stopped responding, so the session was disconnected. Resume it to continue.', CODE.denied);
    }
}

async function shutdownWebTunnels(message) {
    _shuttingDown = true;
    const open = [..._attached.values()];
    for (const s of open) closeLocal(s, message, CODE.restarting);
    await Promise.allSettled(open.map(detach));
    if (_connServer) _connServer.close();
}

async function endAllWebSessions(reason, code) {
    const rows = rowsOf(await pool.query(`SELECT id FROM browser_sessions WHERE state <> 'ended'`));
    for (const row of rows) await endWebSession(row.id, reason, code).catch(e => console.error('[remote-browser] session %s: %s', row.id, e.message));
}

function onConfigChanged() {
    if (browserActive()) return Promise.resolve();
    return endAllWebSessions('Web sessions were turned off by an administrator.', CODE.denied)
        .catch(e => console.error('[remote-browser] could not end the web sessions:', e.message));
}

async function recheckWebSessions() {
    const rows = rowsOf(await pool.query(`SELECT * FROM browser_sessions WHERE state = ANY($1)`, [OPEN_STATES]));
    if (!rows.length) return;
    if (!browserActive()) return;
    const checkedAt = new Date();
    let snap;
    try { snap = await ra.readSnapshotNow(); } catch (e) {
        console.error('[remote-browser] re-check could not read NetBird:', e.message);
        return;
    }
    const gate = await checkGate(snap, { probeGuacd: false });
    if (!gate.ok) {
        console.warn('[remote-browser] the browser gateway is not ready (%s): ending the web sessions', gate.code);
        await forEachLimited(rows, async (row) => {
            await endWebSession(row.id, `The session ended because the browser gateway isn't ready. ${GATE_REASONS[gate.code] || ''}`.trim(), CODE.denied).catch(() => { });
        });
        return;
    }
    const cfg = entitlementCfg();
    const verdicts = new Map();
    const verdictFor = (row) => {
        if (!verdicts.has(row.user_id)) verdicts.set(row.user_id, userVerdict(snap, cfg, row));
        return verdicts.get(row.user_id);
    };
    const kept = [];
    await forEachLimited(rows, async (row) => {
        const reason = await verdictFor(row);
        if (reason) await endWebSession(row.id, reason, CODE.denied).catch(() => { });
        else kept.push(row.id);
    });
    if (kept.length) await pool.query(`UPDATE browser_sessions SET last_auth_ok_at = $2 WHERE id = ANY($1) AND state <> 'ended'`, [kept, checkedAt]);
}

async function userVerdict(snap, cfg, row) {
    const entitlement = evaluateExitNodeEntitlement(snap, cfg, { userId: row.user_id });
    if (!entitlement.ok) return `Your session ended. ${MESSAGES[entitlement.code] || ''}`.trim();
    if (!_deps.stillPermitted) return '';
    const permitted = await ra.withDeadline(Promise.resolve(_deps.stillPermitted({ oid: row.oid, email: row.user_email, userId: row.user_id, snap })), 15_000, 'Checking the permission')
        .then(ok => !!ok, () => false);
    return permitted ? '' : "Your session ended because your Remote Access permission was removed or couldn't be confirmed. Ask an administrator if you need it.";
}

async function forEachLimited(items, task, limit = LEADER_CONCURRENCY) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await task(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function maintainWebSessions(now = Date.now()) {
    const rows = rowsOf(await pool.query(`SELECT * FROM browser_sessions WHERE state <> 'ended'`));
    const keepAliveMs = config().browser.keepAliveMin * 60_000;
    await forEachLimited(rows, async (row) => {
        try {
            if (!browserActive()) { await endWebSession(row.id, 'Web sessions were turned off by an administrator.', CODE.denied); return; }
            if (row.state === 'ending') { await endWebSession(row.id, row.end_reason || 'The session ended.'); return; }
            if (row.state === 'starting') {
                if (now - msOf(row.created_at) > STARTING_STALE_MS) await endWebSession(row.id, 'The session did not open.');
                return;
            }
            if (now - msOf(row.last_auth_ok_at) > AUTH_GRACE_MS) {
                await endWebSession(row.id, UNVERIFIED, CODE.denied);
                return;
            }
            let state = row.state;
            let detachedAt = msOf(row.detached_at);
            if (state === 'active' && msOf(row.lease_expires_at) < now) {
                const d = await pool.query(
                    `UPDATE browser_sessions SET state = 'detached', detached_at = lease_expires_at, owner_instance = '' WHERE id = $1 AND state = 'active' AND lease_expires_at < NOW() RETURNING detached_at`,
                    [row.id]);
                const updated = rowsOf(d)[0];
                if (updated) { state = 'detached'; detachedAt = msOf(updated.detached_at); }
            }
            if (state === 'detached' && now - detachedAt > keepAliveMs) {
                await endWebSession(row.id, keepAliveText());
                return;
            }
            const renewed = await supervisorRequest({ op: 'renew', session: row.id, until: msOf(row.last_auth_ok_at) + AUTH_GRACE_MS }).catch((e) => {
                console.error('[remote-browser] session %s: renew failed: %s', row.id, e.message);
                return null;
            });
            if (isGone(renewed)) await endWebSession(row.id, BROWSER_CLOSED);
            else if (isExpired(renewed)) await endWebSession(row.id, UNVERIFIED, CODE.denied);
        } catch (e) {
            console.error('[remote-browser] session %s: %s', row.id, e.message);
        }
    });
}

async function reconcileWithSupervisor(now = Date.now()) {
    const rows = rowsOf(await pool.query(`SELECT * FROM browser_sessions WHERE state <> 'ended'`));
    let listed;
    try { listed = await supervisorRequest({ op: 'list' }); } catch (e) {
        console.error('[remote-browser] reconcile: the supervisor did not answer:', e.message);
        return false;
    }
    if (!listed || listed.ok !== true || !Array.isArray(listed.sessions)) return false;
    const instance = typeof listed.instance === 'string' ? listed.instance : '';
    const byId = new Map(rows.map(r => [r.id, r]));
    const running = new Set();
    for (const s of listed.sessions) {
        if (!s || typeof s.session !== 'string') continue;
        running.add(s.session);
        const row = byId.get(s.session);
        if (row && row.state !== 'ending') continue;
        if (row) { await endWebSession(row.id, row.end_reason || 'The session ended.').catch(() => { }); continue; }
        const fresh = await sessionRow(s.session).catch(() => undefined);
        if (fresh === undefined || (fresh && fresh.state !== 'ended')) continue;
        await supervisorRequest({ op: 'stop', session: s.session }, SUPERVISOR_STOP_TIMEOUT_MS).catch(e => console.error('[remote-browser] reconcile: could not stop %s: %s', s.session, e.message));
    }
    await forEachLimited(rows.filter(row => !running.has(row.id)), async (row) => {
        if (row.state === 'starting' && now - msOf(row.created_at) <= STARTING_STALE_MS) return;
        if (row.state !== 'ending' && !(await browserClosed(row.id))) return;
        const reason = row.end_reason
            || (row.state === 'starting' ? 'The session did not open.' : row.supervisor_instance === instance ? BROWSER_CLOSED : BROWSER_RESTARTED);
        await endWebSession(row.id, reason).catch(() => { });
    });
    return true;
}

let _ticking = false;
let _lastPurge = 0;
async function leaderTick() {
    if (_ticking || _shuttingDown) return;
    _ticking = true;
    try {
        const busy = browserActive() || rowsOf(await pool.query(`SELECT 1 FROM browser_sessions WHERE state <> 'ended' LIMIT 1`)).length > 0;
        if (browserActive()) await bindConnections().catch(e => console.error('[remote-browser] connection log:', e.message));
        if (busy) await reconcileWithSupervisor().catch(e => console.error('[remote-browser] reconcile:', e.message));
        await recheckWebSessions().catch(e => console.error('[remote-browser] re-check:', e.message));
        await maintainWebSessions();
        await refreshUidMap().catch(() => { });
        for (const session of _uidSessions.values()) if (!session.queued) flushDropped(session);
        if (Date.now() - _lastPurge > 3_600_000) {
            _lastPurge = Date.now();
            await pool.query(`DELETE FROM browser_sessions WHERE state = 'ended' AND ended_at < NOW() - interval '${ENDED_KEEP_DAYS} days'`).catch(() => { });
        }
    } finally {
        _ticking = false;
    }
}

const _uidSessions = new Map();
const _pending = new Map();
let _pendingCount = 0;
let _unattributed = 0;
let _queued = 0;
let _lookupTimer = null;
let _lastLookup = 0;
let _connServer = null;
let _eventChain = Promise.resolve();

function noteUid(row) {
    const uid = Number(row && row.uid);
    if (!Number.isInteger(uid) || !row.id) return;
    if (!_supervisorInstance || row.supervisor_instance !== _supervisorInstance) return;
    const startedAt = msOf(row.browser_started_at) || (Number.isFinite(row.startedAt) ? row.startedAt : 0);
    if (!startedAt) return;
    const known = _uidSessions.get(uid);
    if (known && known.id === row.id) return;
    _uidSessions.set(uid, {
        id: row.id, instance: row.supervisor_instance, startedAt, userId: row.user_id, user: row.user_email || row.user_name || '',
        seen: new Set(), capped: false, queued: 0, dropped: 0,
    });
    flushPending(uid);
}

function forgetUid(row) {
    const uid = Number(row && row.uid);
    const known = _uidSessions.get(uid);
    if (!known || known.id !== row.id) return;
    _uidSessions.delete(uid);
    if (!known.queued) flushDropped(known);
}

async function refreshUidMap() {
    const rows = rowsOf(await pool.query(
        `SELECT id, uid, user_id, user_email, user_name, supervisor_instance, browser_started_at FROM browser_sessions WHERE state = ANY($1) AND uid IS NOT NULL`, [OPEN_STATES]));
    const live = new Set(rows.map(r => r.id));
    for (const [uid, s] of _uidSessions) if (!live.has(s.id)) _uidSessions.delete(uid);
    for (const r of rows) noteUid(r);
}

function enqueue(task) {
    _eventChain = _eventChain.then(task).catch(e => console.error('[remote-browser] could not record a connection:', e.message));
    return _eventChain;
}
const writeEvent = (event) => enqueue(() => addEvent(event));

function gapEvent(session, reason, { id = `${session.id}:gap:${crypto.randomUUID()}`, missed } = {}) {
    return {
        ID: id,
        Timestamp: new Date().toISOString(),
        Message: 'TYPE_UNKNOWN',
        reference: CONNECTION_REFERENCE,
        meta: { flow_id: id, protocol: 0, direction: 'EGRESS', source_name: 'Browser Gateway Web', source_type: SOURCE_TYPE, user_id: session.userId },
        remoteAccess: { protocol: 'web', kind: 'gap', sessionId: session.id, user: session.user, reason, ...(missed ? { missed } : {}) },
    };
}

function unattributedGapEvent(missed) {
    const id = `web-gap:unattributed:${crypto.randomUUID()}`;
    return {
        ID: id,
        Timestamp: new Date().toISOString(),
        Message: 'TYPE_UNKNOWN',
        reference: CONNECTION_REFERENCE,
        meta: { flow_id: id, protocol: 0, direction: 'EGRESS', source_name: 'Browser Gateway Web', source_type: SOURCE_TYPE, user_id: '' },
        remoteAccess: { protocol: 'web', kind: 'gap', missed, reason: `${missed} connection${missed === 1 ? '' : 's'} could not be matched to an open web session, so they were not recorded.` },
    };
}

const tupleOf = (rec) => `${rec.protocol}|${rec.srcIp}|${rec.srcPort}|${rec.destIp}|${rec.destPort}`;

function connectionEvent(session, rec) {
    const id = `web-conn:${session.id}:${crypto.createHash('sha256').update(tupleOf(rec)).digest('hex')}`;
    return {
        ID: id,
        Timestamp: rec.at.toISOString(),
        Message: 'TYPE_START',
        reference: CONNECTION_REFERENCE,
        meta: {
            flow_id: id, protocol: rec.protocol, direction: 'EGRESS',
            source_addr: rec.srcIp ? `${rec.srcIp}:${rec.srcPort}` : '', source_name: 'Browser Gateway Web', source_type: SOURCE_TYPE,
            destination_addr: `${rec.destIp}:${rec.destPort}`, destination_name: rec.destIp,
            user_id: session.userId,
        },
        remoteAccess: { protocol: 'web', kind: 'connection', sessionId: session.id, user: session.user },
    };
}

function parseRecord(line) {
    let r;
    try { r = JSON.parse(line); } catch { return null; }
    if (!r || typeof r !== 'object') return null;
    const uid = Number(r['oob.uid']);
    const protocol = Number(r['ip.protocol']);
    const destIp = typeof r.dest_ip === 'string' ? r.dest_ip : '';
    if (!Number.isInteger(uid) || !Number.isInteger(protocol) || !destIp) return null;
    const at = new Date(r.timestamp);
    const port = (v) => (Number.isInteger(Number(v)) ? Number(v) : 0);
    return {
        uid, protocol, destIp, destPort: port(r.dest_port),
        srcIp: typeof r.src_ip === 'string' ? r.src_ip : '', srcPort: port(r.src_port),
        at: Number.isFinite(at.getTime()) ? at : new Date(),
    };
}

const wholeSeconds = (ms) => Math.floor(ms / 1000);

function countUnattributed(n) {
    _unattributed += n;
    scheduleUidLookup();
}

function flushDropped(session) {
    if (!session.dropped) return;
    const missed = session.dropped;
    session.dropped = 0;
    writeEvent(gapEvent(session, `${missed} connection${missed === 1 ? '' : 's'} arrived faster than they could be recorded, so they were not recorded.`, { missed }));
}

function logConnection(session, rec) {
    if (wholeSeconds(rec.at.getTime()) < wholeSeconds(session.startedAt)) { countUnattributed(1); return; }
    if (session.capped) return;
    const tuple = tupleOf(rec);
    if (session.seen.has(tuple)) return;
    if (_queued >= QUEUED_RECORDS_MAX || session.queued >= CONNECTIONS_PER_SESSION) { session.dropped++; return; }
    session.seen.add(tuple);
    session.queued++;
    _queued++;
    enqueue(async () => {
        try {
            await recordConnection(session, rec);
        } catch (e) {
            session.seen.delete(tuple);
            throw e;
        } finally {
            session.queued--;
            _queued--;
            if (!session.queued) flushDropped(session);
        }
    });
}

async function recordConnection(session, rec) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const row = rowsOf(await client.query('SELECT conn_count FROM browser_sessions WHERE id = $1 FOR UPDATE', [session.id]))[0];
        const count = row ? Number(row.conn_count) || 0 : -1;
        if (count < 0 || count > CONNECTIONS_PER_SESSION) {
            await client.query('ROLLBACK');
            if (count >= 0) session.capped = true;
            return;
        }
        const atCap = count === CONNECTIONS_PER_SESSION;
        const event = atCap
            ? gapEvent(session, `More than ${CONNECTIONS_PER_SESSION} connections: the later connections of this session are not recorded.`, { id: `web-gap:${session.id}:cap` })
            : connectionEvent(session, rec);
        const inserted = await addEvent(event, client);
        if (inserted && inserted.rowCount === 1) await client.query('UPDATE browser_sessions SET conn_count = conn_count + 1 WHERE id = $1', [session.id]);
        await client.query('COMMIT');
        if (atCap) {
            session.capped = true;
            session.seen.clear();
        }
    } catch (e) {
        await client.query('ROLLBACK').catch(() => { });
        throw e;
    } finally {
        client.release();
    }
}

function handleRecord(line) {
    const rec = parseRecord(line);
    if (!rec) return;
    const session = _uidSessions.get(rec.uid);
    if (session) { logConnection(session, rec); return; }
    if (_pendingCount >= PENDING_RECORDS_MAX) { _unattributed++; scheduleUidLookup(); return; }
    if (!_pending.has(rec.uid)) _pending.set(rec.uid, []);
    _pending.get(rec.uid).push({ rec, until: Date.now() + PENDING_RECORD_MS });
    _pendingCount++;
    scheduleUidLookup();
}

function flushPending(uid) {
    const list = _pending.get(uid);
    if (!list) return;
    _pending.delete(uid);
    _pendingCount -= list.length;
    const session = _uidSessions.get(uid);
    for (const { rec } of list) logConnection(session, rec);
}

function scheduleUidLookup() {
    if (_lookupTimer) return;
    const wait = Math.max(0, _lastLookup + UID_LOOKUP_GAP_MS - Date.now());
    _lookupTimer = setTimeout(() => {
        _lookupTimer = null;
        _lastLookup = Date.now();
        lookupPendingUids().catch(e => console.error('[remote-browser] connection log lookup:', e.message));
    }, wait);
    if (_lookupTimer.unref) _lookupTimer.unref();
}

function flushUnattributed() {
    if (!_unattributed) return;
    const missed = _unattributed;
    _unattributed = 0;
    writeEvent(unattributedGapEvent(missed));
}

async function lookupPendingUids(now = Date.now()) {
    for (const [uid, list] of _pending) {
        const fresh = list.filter(x => x.until > now);
        const expired = list.length - fresh.length;
        _pendingCount -= expired;
        _unattributed += expired;
        if (fresh.length) _pending.set(uid, fresh); else _pending.delete(uid);
    }
    flushUnattributed();
    if (!_pending.size) return;
    await refreshUidMap();
    if (!_pending.size) return;
    const listed = await supervisorRequest({ op: 'list' }).catch(() => null);
    const sessions = listed && Array.isArray(listed.sessions) ? listed.sessions : [];
    const ids = sessions.filter(s => s && _pending.has(Number(s.uid))).map(s => s.session);
    if (ids.length) {
        const rows = rowsOf(await pool.query(
            'SELECT id, user_id, user_email, user_name, supervisor_instance, browser_started_at FROM browser_sessions WHERE id = ANY($1) AND state = ANY($2)', [ids, OPEN_STATES]));
        for (const s of sessions) {
            const row = rows.find(r => r.id === s.session);
            if (row) noteUid({ ...row, uid: s.uid, startedAt: s.startedAt });
        }
    }
    if (_pending.size) scheduleUidLookup();
}

function onCollector(sock) {
    let buffered = '';
    sock.setEncoding('utf8');
    sock.on('error', () => { });
    sock.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (line.trim()) handleRecord(line);
        }
        if (buffered.length > COLLECTOR_LINE_MAX) buffered = '';
    });
}

async function bindConnections() {
    if (_connServer) return false;
    const socketPath = _endpoints.connections;
    try { fs.unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const server = net.createServer(onCollector);
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => { server.off('error', reject); resolve(); });
        });
    } catch (e) {
        if (e.code === 'ENOENT') return false;
        throw e;
    }
    server.on('error', (e) => console.error('[remote-browser] connection log socket:', e.message));
    _connServer = server;
    await refreshUidMap().catch(() => { });
    const open = rowsOf(await pool.query(`SELECT id, uid, user_id, user_email, user_name FROM browser_sessions WHERE state <> 'ended'`).catch(() => null));
    for (const row of open) {
        writeEvent(gapEvent({ id: row.id, userId: row.user_id, user: row.user_email || row.user_name || '' },
            'The connection log was not available for a while, so connections of this session may be missing.'));
    }
    return true;
}

let _health = null;
async function getBrowserStatus() {
    const cfg = config();
    const out = {
        enabled: browserActive(), routerGroupId: cfg.browser.routerGroupId, maxSessions: cfg.browser.maxSessions, keepAliveMin: cfg.browser.keepAliveMin,
        enrolled: false, online: false, ready: false, code: '', reason: '', peer: null,
        sessions: { active: 0, detached: 0, total: 0 },
    };
    const counts = rowsOf(await pool.query(`SELECT state, COUNT(*)::int AS n FROM browser_sessions WHERE state <> 'ended' GROUP BY state`).catch(() => null));
    for (const c of counts) {
        if (c.state === 'active' || c.state === 'detached') out.sessions[c.state] = Number(c.n) || 0;
        out.sessions.total += Number(c.n) || 0;
    }
    if (!out.enabled) return out;
    let snap;
    try { snap = await ra.freshSnapshot(30_000); } catch {
        return { ...out, code: 'SNAPSHOT_FAILED', reason: GATE_REASONS.SNAPSHOT_FAILED };
    }
    const gate = await checkGate(snap);
    if (gate.peer) {
        out.enrolled = true;
        out.online = !!gate.peer.connected;
        out.peer = { id: gate.peer.id, name: gate.peer.name || gate.peer.id, ip: gate.peer.ip || '', connected: !!gate.peer.connected };
    }
    out.ready = gate.ok;
    if (!gate.ok) { out.code = gate.code; out.reason = GATE_REASONS[gate.code] || gate.code; }
    return out;
}

async function getBrowserHealth() {
    if (!browserActive()) return null;
    if (_health && Date.now() - _health.at < HEALTH_TTL_MS) return _health.value;
    let value = 'unknown';
    try {
        const status = await getBrowserStatus();
        value = status.ready ? 'up' : status.code === 'SNAPSHOT_FAILED' ? 'unknown' : 'down';
    } catch { value = 'unknown'; }
    _health = { at: Date.now(), value };
    return value;
}

module.exports = {
    setRemoteBrowserDeps, checkWebAccess, createWebSession, resumeWebSession, listWebSessions, renewWebLease, endWebSessionByUser, endWebSession,
    takeToken, attachWebTunnel, watchAttached, shutdownWebTunnels, onConfigChanged, leaderTick, getBrowserStatus, getBrowserHealth,
    LOOP_INTERVAL_MS, WATCH_INTERVAL_MS, MESSAGES, GATE_REASONS, CODE,
    _internal: {
        setEndpointsForTest: (p) => { _endpoints = { ...DEFAULT_ENDPOINTS, ...(p || {}) }; },
        resetForTest: () => {
            _attached.clear(); _uidSessions.clear(); _pending.clear(); _pendingCount = 0; _unattributed = 0; _queued = 0;
            _ticking = false; _shuttingDown = false; _health = null; _supervisorInstance = '';
            clearTimeout(_lookupTimer); _lookupTimer = null; _lastLookup = 0;
        },
        closeConnectionsForTest: () => new Promise(r => { if (!_connServer) return r(); _connServer.close(() => r()); _connServer = null; }),
        eventsIdleForTest: () => _eventChain,
        queuedForTest: () => _queued,
        attachedForTest: (id) => _attached.get(id),
        supervisorRequest, checkGate, reconcileWithSupervisor, maintainWebSessions, recheckWebSessions, bindConnections, handleRecord, parseRecord, lookupPendingUids,
        vncArgs, fitSize, webSessionEvent, CAPACITY_LOCK, CONNECTIONS_PER_SESSION, INSTANCE,
    },
};
