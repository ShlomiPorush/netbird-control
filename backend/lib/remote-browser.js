'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const { pool } = require('./core');
const { addEvent } = require('./events');
const ra = require('./remote-access');
const { netbirdApiConfigured } = require('./netbird');
const { browserGateProblem, browserLiveProblem } = require('./remote-access-auth');
const { fileEvent, journalEventId } = require('./remote-browser-files');

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
const FILE_REQUESTS_INTERVAL_MS = 500;
const STARTING_STALE_MS = 2 * 60_000;
const DISPLAY_TIMEOUT_MS = 20_000;
const HEALTH_TTL_MS = 15_000;
const ENDED_KEEP_DAYS = 30;
const CAPACITY_LOCK = 0x4e424252;
const SCREEN = { minWidth: 320, minHeight: 240, maxWidth: 1920, maxHeight: 1080 };
const CONNECTIONS_PER_SESSION = 2000;
const QUEUED_RECORDS_MAX = 5000;
const SESSION_CONCURRENCY = 5;
const IDENTITY_CONCURRENCY = 25;
const RECORD_HOLD_MS = 5000;
const DISPLAY_LOCK_MS = 15_000;
const COLLECTOR_LINE_MAX = 64 * 1024;
const SOURCE_TYPE = 'BROWSER_GATEWAY';
const SESSION_REFERENCE = 'remote-access:web';
const CONNECTION_REFERENCE = 'remote-access:web-connection';
const OPEN_STATES = ['active', 'detached'];
const GIB = 1024 ** 3;
const ACKS_PER_LIST = 40;
const ENDED_LIST_MIN = 10;
const JOURNAL_ROUNDS_PER_TICK = 20;
const CODE = { ended: 0x020B, takenOver: 0x0205, denied: 0x0303, restarting: 0x0201, lost: 0x0208 };
const TAKEN_OVER = 'Your browser was opened in another window.';
const BROWSER_CLOSED = 'The browser was closed.';
const BROWSER_RESTARTED = 'The remote browser restarted, so the session ended.';
const UNVERIFIED = "Your access couldn't be verified with NetBird, so the session ended.";
const filesFullText = ({ limit }) => (Number.isSafeInteger(limit) && limit > 0
    ? `This browser's files passed its ${Math.round(limit / GIB)} GB limit, so it was closed.`
    : "This browser's files passed their limit, so it was closed.");

const MESSAGES = {
    BROWSER_DISABLED: 'Web sessions are turned off. Ask an administrator to turn them on in Settings > Remote Access.',
    SNAPSHOT_FAILED: "Remote Access couldn't read NetBird to check your access. Try again in a minute.",
    GATEWAY_NOT_READY: "The browser gateway isn't ready, so web sessions can't open right now. Try again later, or tell an administrator.",
    GUACD_UNREACHABLE: "NetBird Control can't reach the remote browser's display service, so web sessions can't open right now. Try again later, or tell an administrator.",
    BROWSER_CAPACITY: 'Every web session is in use right now. Try again later.',
    BROWSER_USER_LIMIT: 'You already have the most browsers you may open. Resume one, or close one to open a new one.',
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
const leading = () => !_deps.isLeader || _deps.isLeader();

const _sessionLocks = new Map();
function withSessionLock(id, task) {
    const result = (_sessionLocks.get(id) || Promise.resolve()).then(task);
    const tail = result.catch(() => { });
    _sessionLocks.set(id, tail);
    tail.then(() => { if (_sessionLocks.get(id) === tail) _sessionLocks.delete(id); });
    return result;
}

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
const filesFull = (status) => !!status && status.code === 'FILES_FULL';
const closedReason = (status, fallback = BROWSER_CLOSED) => (filesFull(status) ? filesFullText(status) : fallback);
const statusOf = (id) => supervisorRequest({ op: 'status', session: id }).catch(() => null);

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

const notReadyMessage = (gateCode) => (gateCode === 'GUACD_UNREACHABLE' ? MESSAGES.GUACD_UNREACHABLE : MESSAGES.GATEWAY_NOT_READY);

async function authorize() {
    if (!browserActive()) throw httpError(403, 'BROWSER_DISABLED');
    if (_shuttingDown) throw httpError(503, 'SERVER_RESTARTING');
    let snap;
    try { snap = await ra.freshSnapshot(ra.CHECK_SNAPSHOT_TTL_MS); } catch { throw httpError(503, 'SNAPSHOT_FAILED'); }
    const gate = await checkGate(snap);
    if (!gate.ok) {
        console.warn('[remote-browser] the browser gateway is not ready: %s', gate.code);
        throw httpError(503, 'GATEWAY_NOT_READY', notReadyMessage(gate.code));
    }
    if (_shuttingDown) throw httpError(503, 'SERVER_RESTARTING');
}

async function checkWebAccess() {
    const ready = (code, retry = false, message = MESSAGES[code]) => ({ steps: [{ key: 'ready', status: 'fail', code, message, retry }] });
    if (!browserActive()) return ready('BROWSER_DISABLED');
    if (_shuttingDown || !leading()) return ready('SERVER_RESTARTING', true);
    let snap;
    try { snap = await ra.freshSnapshot(ra.CHECK_SNAPSHOT_TTL_MS); } catch { return ready('SNAPSHOT_FAILED', true); }
    const gate = await checkGate(snap);
    if (!gate.ok) return ready('GATEWAY_NOT_READY', false, notReadyMessage(gate.code));
    return {
        ok: true,
        steps: [
            { key: 'access', status: 'pass', detail: 'You may use Remote Access' },
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

async function reserveSlot(row, { max, perUser }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_LOCK]);
        const counts = rowsOf(await client.query(
            `SELECT COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE user_id = $1))::int AS mine FROM browser_sessions WHERE state <> 'ended'`, [row.userId]))[0] || {};
        const full = (Number(counts.mine) || 0) >= perUser ? 'BROWSER_USER_LIMIT' : (Number(counts.n) || 0) >= max ? 'BROWSER_CAPACITY' : '';
        if (full) {
            await client.query('ROLLBACK');
            return full;
        }
        await client.query(
            `INSERT INTO browser_sessions (id, user_id, user_email, user_name, oid, client_ip, state, width, height, dpi, attachment, last_auth_ok_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'starting', $7, $8, $9, $10, $11, NOW())`,
            [row.id, row.userId, row.userEmail, row.userName, row.oid, row.clientIp, row.width, row.height, row.dpi, row.attachment, row.authorizedAt]);
        await client.query('COMMIT');
        return '';
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
    if (!leading()) throw httpError(503, 'SERVER_RESTARTING');
    const authorizedAt = new Date();
    await authorize();
    const size = screen(body);
    const row = {
        id: crypto.randomUUID(), attachment: crypto.randomUUID(), authorizedAt,
        userId: viewer.user_id, userEmail: viewer.email || '', userName: viewer.name || '', oid: viewer.oid || '',
        clientIp: String(clientIp || ''), ...size,
    };
    let full;
    try { full = await reserveSlot(row, { max: config().browser.maxSessions, perUser: config().browser.maxPerUser }); } catch (e) {
        console.error('[remote-browser] could not reserve a session:', e.message);
        throw httpError(503, 'RECORD_FAILED');
    }
    if (full) throw httpError(429, full);
    try {
        let started;
        try {
            started = await supervisorRequest({
                op: 'start', session: row.id, width: row.width, height: row.height, dpi: row.dpi, terminal: false, until: authorizedAt.getTime() + AUTH_GRACE_MS,
                filesLimit: config().browser.filesLimitGb * GIB,
                language: config().browser.language,
                ...(config().browser.startPage ? { startPage: config().browser.startPage } : {}),
            });
        } catch (e) {
            console.error('[remote-browser] start failed:', e.message);
            throw httpError(503, 'BROWSER_UNAVAILABLE');
        }
        if (!started || started.ok !== true) throw httpError(started && started.error === 'CAPACITY' ? 429 : 503, started && started.error === 'CAPACITY' ? 'BROWSER_CAPACITY' : 'BROWSER_UNAVAILABLE');
        mapFromSupervisor({ id: row.id, user_id: row.userId, user_email: row.userEmail, user_name: row.userName }, started);
        const u = await pool.query(
            `UPDATE browser_sessions SET state = 'detached', detached_at = NOW(), uid = $2, port = $3, supervisor_instance = $4 WHERE id = $1 AND state = 'starting' RETURNING *`,
            [row.id, started.uid, started.port, String(started.instance || '')]);
        const stored = rowsOf(u)[0];
        if (!stored) throw httpError(409, 'SESSION_CLOSED');
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
    if (!leading()) throw httpError(503, 'SERVER_RESTARTING');
    return withSessionLock(row.id, () => resumeLocked(viewer, row, body));
}

async function resumeLocked(viewer, row, body) {
    const authorizedAt = new Date();
    await authorize();
    const creds = await browserCredentials(row.id, authorizedAt.getTime() + AUTH_GRACE_MS);
    if (creds === 'expired') throw httpError(410, 'BROWSER_ENDED');
    if (creds === 'gone') {
        await endWebSession(row.id, closedReason(await statusOf(row.id))).catch(() => { });
        throw httpError(410, 'BROWSER_ENDED');
    }
    if (!creds) throw httpError(503, 'BROWSER_UNAVAILABLE');
    mapFromSupervisor(row, creds);
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

async function ownedWebSession(viewer, id) {
    const row = await sessionRow(id);
    if (!row || row.user_id !== viewer.user_id) throw httpError(404, 'SESSION_NOT_FOUND');
    if (!OPEN_STATES.includes(row.state)) throw httpError(410, 'BROWSER_ENDED');
    return { id: row.id, userId: row.user_id, user: row.user_email || row.user_name || '' };
}

async function endWebSessionByUser(viewer, id) {
    const row = await sessionRow(id);
    if (!row || row.user_id !== viewer.user_id) return null;
    if (row.state === 'ended') throw httpError(410, 'BROWSER_ENDED');
    if (!leading()) throw httpError(503, 'SERVER_RESTARTING');
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
    if (s.settle) s.settle();
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

function onTunnelEnd(s, from, message, code) {
    if (s.closed || s.ending) return;
    s.ending = true;
    if (s.settle) s.settle();
    if (!s.detachOnClose) { release(s, code); return; }
    if (from === 'browser' || from === 'disconnect') {
        release(s, 0);
        detach(s);
        return;
    }
    statusOf(s.id).then(async (status) => {
        if (s.closed) return;
        if (isGone(status)) {
            const reason = closedReason(status);
            await endWebSession(s.id, reason).catch(() => { });
            if (!s.closed) closeLocal(s, reason, CODE.ended);
            return;
        }
        ra.sendError(s.ws, message || 'The connection to the remote browser was lost. Resume the session to continue.', code || CODE.lost);
        release(s, code || CODE.lost);
        await detach(s);
    });
}

function refuseTunnel(ws, message, code) {
    ra.sendError(ws, message, code);
    try { ws.close(1000, String(code)); } catch { }
}

function attachWebTunnel(entry, ws) {
    if (!leading()) {
        refuseTunnel(ws, MESSAGES.SERVER_RESTARTING, CODE.restarting);
        return Promise.resolve();
    }
    return withSessionLock(entry.sessionId, () => attachLocked(entry, ws));
}

async function attachLocked(entry, ws) {
    const refuse = (message, code) => refuseTunnel(ws, message, code);
    let row;
    try { row = await sessionRow(entry.sessionId); } catch { return refuse(MESSAGES.BROWSER_UNAVAILABLE, CODE.lost); }
    if (!row || row.user_id !== entry.userId || row.attachment !== entry.attachment || !OPEN_STATES.includes(row.state)) {
        const takenOver = !!row && row.attachment !== entry.attachment && OPEN_STATES.includes(row.state);
        return refuse(takenOver ? TAKEN_OVER : (row && row.end_reason) || 'This session is no longer available.', takenOver ? CODE.takenOver : (row && row.end_code) || CODE.ended);
    }
    let creds = await browserCredentials(row.id, msOf(row.last_auth_ok_at) + AUTH_GRACE_MS);
    if (creds === 'expired') return refuse(UNVERIFIED, CODE.denied);
    if (creds === 'gone') {
        const reason = closedReason(await statusOf(row.id));
        await endWebSession(row.id, reason).catch(() => { });
        return refuse(reason, CODE.ended);
    }
    if (!creds) return refuse(MESSAGES.BROWSER_UNAVAILABLE, CODE.lost);
    mapFromSupervisor(row, creds);
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
    if (_shuttingDown || !leading()) {
        await detach({ id: row.id, attachment: entry.attachment });
        return refuse(MESSAGES.SERVER_RESTARTING, CODE.restarting);
    }
    const previous = _attached.get(row.id);
    if (previous) closeLocal(previous, TAKEN_OVER, CODE.takenOver);
    const s = {
        id: row.id, attachment: entry.attachment, protocol: 'web',
        width: entry.width, height: entry.height, dpi: entry.dpi, timezone: '',
        state: 'connecting', closed: false, ending: false, detachOnClose: true, rx: 0, tx: 0, lastInputAt: Date.now(), creds: {}, ws: null, guacd: null,
    };
    _attached.set(row.id, s);
    const displayed = new Promise((resolve) => {
        const timer = setTimeout(resolve, DISPLAY_LOCK_MS);
        if (timer.unref) timer.unref();
        s.settle = () => { clearTimeout(timer); resolve(); };
    });
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
        onSync: () => s.settle(),
        displayTimeoutMs: DISPLAY_TIMEOUT_MS,
        displayFailedMessage: "The remote browser's screen didn't open. Resume the session to try again.",
        fail: (message, code, detail) => {
            if (detail) console.error('[remote-browser] session %s: %s (%s)', s.id, message, detail);
            onTunnelEnd(s, 'error', message, code);
        },
        close: (reason, from) => onTunnelEnd(s, from, '', 0),
    });
    return displayed;
}

async function watchAttached() {
    if (leading()) return;
    for (const s of [..._attached.values()]) closeLocal(s, MESSAGES.SERVER_RESTARTING, CODE.restarting);
}

async function pollFileRequests() {
    if (_shuttingDown || !leading() || _attached.size === 0) return;
    const reply = await supervisorRequest({ op: 'requests' }).catch(() => null);
    if (!reply || reply.ok !== true || !Array.isArray(reply.sessions)) return;
    for (const id of reply.sessions) {
        const s = _attached.get(id);
        if (s && !s.closed && s.ws && s.ws.readyState === 1) s.ws.send(ra.encodeInstruction('nbc-files'));
    }
}

let _fileRequests = null;
function startFileRequests() {
    if (_fileRequests) return;
    const next = () => {
        _fileRequests = setTimeout(() => pollFileRequests()
            .catch(e => console.error('[remote-browser] files requests:', e.message))
            .finally(() => { if (_fileRequests) next(); }), FILE_REQUESTS_INTERVAL_MS);
    };
    next();
}

function stopFileRequests() {
    clearTimeout(_fileRequests);
    _fileRequests = null;
}

async function shutdownWebTunnels(message) {
    _shuttingDown = true;
    stopFileRequests();
    const open = [..._attached.values()];
    for (const s of open) closeLocal(s, message, CODE.restarting);
    await Promise.allSettled(open.map(detach));
    if (_connServer) _connServer.close();
}

async function endAllWebSessions(reason, code) {
    const rows = rowsOf(await pool.query(`SELECT id FROM browser_sessions WHERE state <> 'ended'`));
    for (const row of rows) await endWebSession(row.id, reason, code).catch(e => console.error('[remote-browser] session %s: %s', row.id, e.message));
}

async function sendFilesSetting(saved) {
    const enabled = !!(saved.enabled && saved.browser.enabled && saved.browser.files) && netbirdApiConfigured();
    const request = { op: 'files', enabled, transfer: enabled && !!saved.browser.transfer, rev: saved.rev };
    const reply = await supervisorRequest(request).catch((e) => {
        if (e.code !== 'ENOENT') console.error('[remote-browser] could not send the files setting:', e.message);
        return undefined;
    });
    if (reply !== undefined && (!reply || reply.ok !== true)) console.error('[remote-browser] the files setting was refused: %s', (reply && reply.error) || 'no answer');
}

async function onConfigChanged() {
    await sendFilesSetting(config());
    if (browserActive() || !leading()) return;
    await endAllWebSessions('Web sessions were turned off by an administrator.', CODE.denied)
        .catch(e => console.error('[remote-browser] could not end the web sessions:', e.message));
}

async function userVerdict(snap, row) {
    if (!_deps.stillPermitted) return { ok: true };
    const permitted = await ra.withDeadline(Promise.resolve(_deps.stillPermitted({ oid: row.oid, email: row.user_email, userId: row.user_id, snap })), 15_000, 'Checking the permission')
        .then(ok => ok, () => null);
    if (permitted !== true && permitted !== false) return { unknown: true };
    return permitted ? { ok: true } : { denied: 'Your session ended because your Remote Access permission was removed. Ask an administrator if you need it.' };
}

function limiter(limit) {
    let running = 0;
    const waiting = [];
    const next = () => {
        while (running < limit && waiting.length) {
            const { task, resolve, reject } = waiting.shift();
            running++;
            Promise.resolve().then(task).then(resolve, reject).finally(() => { running--; next(); });
        }
    };
    const run = (task) => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next(); });
    return run;
}

const _stopKeys = new Set();
const _stops = limiter(SESSION_CONCURRENCY);

function queueStop(key, task) {
    if (_stopKeys.has(key)) return;
    _stopKeys.add(key);
    _stops(task)
        .catch(e => console.error('[remote-browser] %s: %s', key, e.message))
        .finally(() => _stopKeys.delete(key));
}

const queueEnd = (id, reason, code) => queueStop(id, () => endWebSession(id, reason, code));

async function stopsIdle() {
    while (_stopKeys.size) await new Promise(resolve => setTimeout(resolve, 5));
}

async function readAuthorization() {
    const checkedAt = new Date();
    let snap;
    try { snap = await ra.readSnapshotNow(); } catch (e) {
        console.error('[remote-browser] re-check could not read NetBird:', e.message);
        return null;
    }
    const gate = await checkGate(snap, { probeGuacd: false });
    if (!gate.ok) {
        console.warn('[remote-browser] the browser gateway is not ready (%s): ending the web sessions', gate.code);
        return { gateReason: `The session ended because the browser gateway isn't ready. ${GATE_REASONS[gate.code] || ''}`.trim() };
    }
    return { checkedAt, snap };
}

async function superviseSession(row, now, auth, verdict) {
    if (!browserActive()) return queueEnd(row.id, 'Web sessions were turned off by an administrator.', CODE.denied);
    if (row.state === 'ending') return queueEnd(row.id, row.end_reason || 'The session ended.');
    if (row.state === 'starting') {
        if (now - msOf(row.created_at) > STARTING_STALE_MS) queueEnd(row.id, 'The session did not open.');
        return undefined;
    }
    if (auth && auth.gateReason) return queueEnd(row.id, auth.gateReason, CODE.denied);
    if (verdict && verdict.denied) return queueEnd(row.id, verdict.denied, CODE.denied);
    let authorizedAt = msOf(row.last_auth_ok_at);
    if (verdict && verdict.ok) {
        const updated = rowsOf(await pool.query(
            `UPDATE browser_sessions SET last_auth_ok_at = GREATEST(last_auth_ok_at, $2) WHERE id = $1 AND state <> 'ended' RETURNING last_auth_ok_at`,
            [row.id, auth.checkedAt]))[0];
        if (updated) authorizedAt = msOf(updated.last_auth_ok_at);
    }
    let state = row.state;
    let detachedAt = msOf(row.detached_at);
    if (state === 'active' && msOf(row.lease_expires_at) < now) {
        const d = await pool.query(
            `UPDATE browser_sessions SET state = 'detached', detached_at = lease_expires_at, owner_instance = '' WHERE id = $1 AND state = 'active' AND lease_expires_at < NOW() RETURNING detached_at`,
            [row.id]);
        const detached = rowsOf(d)[0];
        if (detached) {
            state = 'detached';
            detachedAt = msOf(detached.detached_at);
            const local = _attached.get(row.id);
            if (local) closeLocal(local, 'Your sign-in ended or the page stopped responding, so the session was disconnected. Resume it to continue.', CODE.denied);
        }
    }
    if (state === 'detached' && now - detachedAt > keepAliveMin() * 60_000) return queueEnd(row.id, keepAliveText());
    const request = verdict && verdict.ok
        ? { op: 'renew', session: row.id, until: authorizedAt + AUTH_GRACE_MS }
        : { op: 'status', session: row.id };
    const answer = await supervisorRequest(request).catch((e) => {
        console.error('[remote-browser] session %s: %s failed: %s', row.id, request.op, e.message);
        return null;
    });
    if (isGone(answer)) {
        const status = request.op === 'status' ? answer : await statusOf(row.id);
        const lapsed = !filesFull(status) && Date.now() - msOf(row.last_auth_ok_at) > AUTH_GRACE_MS;
        queueEnd(row.id, lapsed ? UNVERIFIED : closedReason(status), lapsed ? CODE.denied : CODE.ended);
    }
    return undefined;
}

async function superviseWebSessions(now = Date.now()) {
    const rows = rowsOf(await pool.query(`SELECT * FROM browser_sessions WHERE state <> 'ended'`));
    if (!rows.length) return;
    const open = rows.filter(r => OPEN_STATES.includes(r.state));
    const auth = browserActive() && open.length ? await readAuthorization() : null;
    const ops = limiter(SESSION_CONCURRENCY);
    const supervise = (row, verdict) => ops(() => superviseSession(row, now, auth, verdict)
        .catch(e => console.error('[remote-browser] session %s: %s', row.id, e.message)));
    const work = rows.filter(r => !open.includes(r)).map(row => supervise(row, null));
    if (auth && auth.snap) {
        const checks = limiter(IDENTITY_CONCURRENCY);
        const byIdentity = new Map();
        for (const row of open) {
            const key = JSON.stringify([row.user_id, row.oid || '', row.user_email || '']);
            if (!byIdentity.has(key)) byIdentity.set(key, []);
            byIdentity.get(key).push(row);
        }
        for (const group of byIdentity.values()) {
            work.push(checks(() => userVerdict(auth.snap, group[0]))
                .then(verdict => Promise.all(group.map(row => supervise(row, verdict)))));
        }
    } else {
        work.push(...open.map(row => supervise(row, null)));
    }
    await Promise.all(work);
}

async function reconcileWithSupervisor(now = Date.now()) {
    const rows = rowsOf(await pool.query(`SELECT * FROM browser_sessions WHERE state <> 'ended'`));
    const ack = acksToSend();
    let listed;
    try { listed = await supervisorRequest({ op: 'list', ...(ack ? { ack } : {}) }); } catch (e) {
        console.error('[remote-browser] reconcile: the supervisor did not answer:', e.message);
        return null;
    }
    if (!listed || listed.ok !== true || !Array.isArray(listed.sessions)) return null;
    acksSent(ack);
    const instance = typeof listed.instance === 'string' ? listed.instance : '';
    const byId = new Map(rows.map(r => [r.id, r]));
    const running = new Set();
    for (const s of listed.sessions) {
        if (!s || typeof s.session !== 'string') continue;
        running.add(s.session);
        const row = byId.get(s.session);
        if (row && row.state !== 'ending') continue;
        if (row) { queueEnd(row.id, row.end_reason || 'The session ended.'); continue; }
        const fresh = await sessionRow(s.session).catch(() => undefined);
        if (fresh === undefined || (fresh && fresh.state !== 'ended')) continue;
        queueStop(s.session, () => supervisorRequest({ op: 'stop', session: s.session }, SUPERVISOR_STOP_TIMEOUT_MS));
    }
    const ops = limiter(SESSION_CONCURRENCY);
    await Promise.all(rows.filter(row => !running.has(row.id)).map(row => ops(async () => {
        if (row.state === 'starting' && now - msOf(row.created_at) <= STARTING_STALE_MS) return;
        const status = row.state === 'ending' ? null : await statusOf(row.id);
        if (row.state !== 'ending' && !isGone(status)) return;
        const reason = row.end_reason
            || (row.state === 'starting' ? 'The session did not open.' : closedReason(status, row.supervisor_instance === instance ? BROWSER_CLOSED : BROWSER_RESTARTED));
        queueEnd(row.id, reason);
    })));
    return listed;
}

const _acks = new Map();

function noteAck(session, seq) {
    if (seq > (_acks.get(session) || 0)) _acks.set(session, seq);
}

function acksToSend() {
    if (!_acks.size) return null;
    return Object.fromEntries([..._acks].slice(0, ACKS_PER_LIST));
}

function acksSent(ack) {
    for (const [session, seq] of Object.entries(ack || {})) if (_acks.get(session) === seq) _acks.delete(session);
}

const journalEntries = (files) => (Array.isArray(files) ? files : [])
    .filter(f => f && Number.isSafeInteger(f.seq) && f.seq > 0 && typeof f.name === 'string')
    .sort((a, b) => a.seq - b.seq);

async function recordJournal(row, files) {
    const session = { id: row.id, userId: row.user_id || '', user: row.user_email || row.user_name || '' };
    for (const f of journalEntries(files)) {
        try { await addEvent(fileEvent(session, 'saved', { id: journalEventId(row.id, f.seq), name: f.name, size: f.size })); } catch (e) {
            console.error('[remote-browser] session %s: could not record a file: %s', row.id, e.message);
            return;
        }
        noteAck(row.id, f.seq);
    }
}

async function drainJournals(listed) {
    for (let round = 1; ; round++) {
        await recordListedJournals(listed);
        const ack = acksToSend();
        if (!ack || round >= JOURNAL_ROUNDS_PER_TICK) return;
        try { listed = await supervisorRequest({ op: 'list', ack }); } catch (e) {
            console.error('[remote-browser] file log: the supervisor did not answer:', e.message);
            return;
        }
        if (!listed || listed.ok !== true || !Array.isArray(listed.sessions)) return;
        acksSent(ack);
    }
}

async function recordListedJournals(listed) {
    const batches = [...listed.sessions, ...(Array.isArray(listed.ended) ? listed.ended : [])]
        .filter(b => b && typeof b.session === 'string' && journalEntries(b.files).length);
    if (!batches.length) return;
    let rows;
    try {
        rows = rowsOf(await pool.query('SELECT id, user_id, user_email, user_name FROM browser_sessions WHERE id = ANY($1)', [batches.map(b => b.session)]));
    } catch (e) {
        console.error('[remote-browser] could not read the sessions of new files:', e.message);
        return;
    }
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const b of batches) await recordJournal(byId.get(b.session) || { id: b.session }, b.files);
}

let _ticking = false;
let _drain = null;
function drainInBackground(listed) {
    if (_drain) return;
    _drain = drainJournals(listed).catch(e => console.error('[remote-browser] file log:', e.message)).finally(() => { _drain = null; });
}
let _lastPurge = 0;
async function leaderTick() {
    if (_ticking || _shuttingDown) return;
    _ticking = true;
    try {
        const saved = await ra.reloadSavedConfig().catch((e) => {
            console.error('[remote-browser] could not read the saved settings:', e.message);
            return null;
        });
        if (saved) await sendFilesSetting(saved);
        const busy = browserActive() || rowsOf(await pool.query(
            `SELECT 1 FROM browser_sessions WHERE state <> 'ended' OR ended_at > NOW() - interval '${ENDED_LIST_MIN} minutes' LIMIT 1`)).length > 0;
        if (browserActive()) await bindConnections().catch(e => console.error('[remote-browser] connection log:', e.message));
        const listed = busy ? await reconcileWithSupervisor().catch((e) => {
            console.error('[remote-browser] reconcile:', e.message);
            return null;
        }) : null;
        await superviseWebSessions().catch(e => console.error('[remote-browser] supervise:', e.message));
        if (listed) drainInBackground(listed);
        if (_connServer && _mapNeedsRebuild) await refreshUidMap().catch(e => console.error('[remote-browser] connection log map:', e.message));
        flushMissed();
        if (Date.now() - _lastPurge > 3_600_000) {
            _lastPurge = Date.now();
            await pool.query(`DELETE FROM browser_sessions WHERE state = 'ended' AND ended_at < NOW() - interval '${ENDED_KEEP_DAYS} days'`).catch(() => { });
        }
    } finally {
        _ticking = false;
    }
}

const _uidSessions = new Map();
const _missed = new Map();
const _held = [];
let _mapGeneration = 0;
let _mapNeedsRebuild = false;
let _holdTimer = null;
let _queued = 0;

let _connServer = null;
let _eventChain = Promise.resolve();

function noteUid(row) {
    const uid = Number(row && row.uid);
    if (!Number.isInteger(uid) || !row.id || !Number.isFinite(row.startedAt)) return;
    if (!_supervisorInstance || row.supervisor_instance !== _supervisorInstance) return;
    const known = _uidSessions.get(uid);
    if (known && known.id === row.id) return;
    _uidSessions.set(uid, {
        id: row.id, startedAt: row.startedAt, userId: row.user_id, user: row.user_email || row.user_name || '',
        seen: new Set(), capped: false, generation: ++_mapGeneration,
    });
    if (_held.length) releaseHeld();
}

function mapFromSupervisor(row, reply) {
    if (_connServer) noteUid({ ...row, uid: reply.uid, startedAt: reply.startedAt, supervisor_instance: reply.instance });
}

function forgetUid(row) {
    const uid = Number(row && row.uid);
    const known = _uidSessions.get(uid);
    if (known && known.id === row.id) _uidSessions.delete(uid);
}

async function refreshUidMap() {
    const generationAtStart = _mapGeneration;
    const listed = await supervisorRequest({ op: 'list' });
    if (!listed || listed.ok !== true || !Array.isArray(listed.sessions)) throw new Error('the remote browser did not list its sessions');
    const ids = listed.sessions.filter(s => s && typeof s.session === 'string').map(s => s.session);
    const rows = ids.length
        ? rowsOf(await pool.query('SELECT id, user_id, user_email, user_name FROM browser_sessions WHERE id = ANY($1) AND state = ANY($2)', [ids, ['starting', ...OPEN_STATES]]))
        : [];
    const byId = new Map(rows.map(r => [r.id, r]));
    const live = new Set();
    for (const s of listed.sessions) {
        const row = s && byId.get(s.session);
        if (!row) continue;
        live.add(row.id);
        noteUid({ ...row, uid: s.uid, startedAt: s.startedAt, supervisor_instance: listed.instance });
    }
    for (const [uid, s] of _uidSessions) if (!live.has(s.id) && s.generation <= generationAtStart) _uidSessions.delete(uid);
    _mapNeedsRebuild = false;
}


function enqueueWrite(task) {
    if (_queued >= QUEUED_RECORDS_MAX) return false;
    _queued++;
    _eventChain = _eventChain.then(task)
        .catch(e => console.error('[remote-browser] could not record a connection:', e.message))
        .then(() => { _queued--; });
    return true;
}
const writeEvent = (event) => enqueueWrite(() => addEvent(event));

function countMissed(session, n) {
    const key = session ? session.id : '';
    const entry = _missed.get(key) || { session, missed: 0 };
    entry.missed += n;
    _missed.set(key, entry);
}

function flushMissed() {
    for (const [key, { session, missed }] of _missed) {
        const event = session
            ? gapEvent(session, `${missed} connection${missed === 1 ? '' : 's'} of this session arrived faster than they could be recorded, so they were not recorded.`, { missed })
            : unattributedGapEvent(missed);
        const queued = enqueueWrite(async () => {
            try { await addEvent(event); } catch (e) {
                countMissed(session, missed);
                throw e;
            }
        });
        if (!queued) return;
        _missed.delete(key);
    }
}

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

function logConnection(session, rec) {
    if (wholeSeconds(rec.at.getTime()) < wholeSeconds(session.startedAt)) { countMissed(null, 1); return; }
    if (session.capped) return;
    const tuple = tupleOf(rec);
    if (session.seen.has(tuple)) return;
    session.seen.add(tuple);
    const queued = enqueueWrite(async () => {
        try { await recordConnection(session, rec); } catch (e) {
            session.seen.delete(tuple);
            throw e;
        }
    });
    if (!queued) {
        session.seen.delete(tuple);
        countMissed(session, 1);
    }
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
    if (_queued >= QUEUED_RECORDS_MAX) { countMissed(null, 1); return; }
    _queued++;
    _held.push({ rec, until: Date.now() + RECORD_HOLD_MS });
    scheduleHeldRelease();
}

function releaseHeld(now = Date.now()) {
    const waiting = _held.splice(0);
    for (const held of waiting) {
        const session = _uidSessions.get(held.rec.uid);
        if (!session && held.until > now) { _held.push(held); continue; }
        _queued--;
        if (session) logConnection(session, held.rec); else countMissed(null, 1);
    }
    scheduleHeldRelease();
}

function scheduleHeldRelease() {
    if (_holdTimer || !_held.length) return;
    _holdTimer = setTimeout(() => { _holdTimer = null; releaseHeld(); }, Math.max(0, _held[0].until - Date.now()));
    if (_holdTimer.unref) _holdTimer.unref();
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
    _mapNeedsRebuild = true;
    await refreshUidMap().catch(e => console.error('[remote-browser] connection log map:', e.message));
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
        enabled: browserActive(), routerGroupId: cfg.browser.routerGroupId, maxSessions: cfg.browser.maxSessions, maxPerUser: cfg.browser.maxPerUser, keepAliveMin: cfg.browser.keepAliveMin, startPage: cfg.browser.startPage,
        files: cfg.browser.files, transfer: cfg.browser.transfer, filesLimitGb: cfg.browser.filesLimitGb,
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
    setRemoteBrowserDeps, checkWebAccess, createWebSession, resumeWebSession, listWebSessions, renewWebLease, endWebSessionByUser, endWebSession, ownedWebSession,
    takeToken, attachWebTunnel, watchAttached, startFileRequests, shutdownWebTunnels, onConfigChanged, leaderTick, getBrowserStatus, getBrowserHealth,
    LOOP_INTERVAL_MS, WATCH_INTERVAL_MS, MESSAGES, GATE_REASONS, CODE,
    _internal: {
        setEndpointsForTest: (p) => { _endpoints = { ...DEFAULT_ENDPOINTS, ...(p || {}) }; },
        resetForTest: () => {
            _attached.clear(); _uidSessions.clear(); _missed.clear(); _sessionLocks.clear();
            _queued -= _held.length; _held.length = 0; clearTimeout(_holdTimer); _holdTimer = null;
            _ticking = false; _shuttingDown = false; _health = null; _supervisorInstance = ''; _acks.clear();
        },
        stopsIdleForTest: stopsIdle,
        releaseHeldForTest: releaseHeld,
        flushMissedForTest: flushMissed,
        closeConnectionsForTest: () => new Promise(r => { if (!_connServer) return r(); _connServer.close(() => r()); _connServer = null; }),
        eventsIdleForTest: () => _eventChain,
        drainIdleForTest: () => _drain || Promise.resolve(),
        queuedForTest: () => _queued,
        attachedForTest: (id) => _attached.get(id),
        pollFileRequests,
        stopFileRequestsForTest: stopFileRequests,
        reconcileWithSupervisor: async (now) => {
            const listed = await reconcileWithSupervisor(now);
            if (listed) await recordListedJournals(listed);
            await stopsIdle();
            return !!listed;
        },
        superviseWebSessions: async (now) => { await superviseWebSessions(now); await stopsIdle(); },
        supervisorRequest, checkGate, bindConnections, handleRecord, parseRecord, refreshUidMap,
        vncArgs, fitSize, webSessionEvent, CAPACITY_LOCK, CONNECTIONS_PER_SESSION, INSTANCE,
    },
};
