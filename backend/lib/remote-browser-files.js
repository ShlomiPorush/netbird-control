'use strict';

const crypto = require('crypto');
const http = require('http');
const { Transform, pipeline } = require('stream');
const events = require('./events');

const DEFAULT_SOCKET = '/run/nbc-control/files.sock';
const CHUNK_MAX = 8 * 1024 * 1024;
const REPLY_MAX = 1024 * 1024;
const REPLY_TIMEOUT_MS = 30_000;
const STREAM_IDLE_MS = 60_000;
const SOURCE_TYPE = 'BROWSER_GATEWAY';
const FILE_REFERENCE = 'remote-access:web-connection';
const UPLOAD_CHUNK_PATH = /^\/api\/remote-access\/sessions\/[^/]+\/uploads\/[^/]+\/?$/i;
const UNAVAILABLE = { status: 503, body: { error: 'BROWSER_UNAVAILABLE', message: "The remote browser isn't answering right now. Try again in a minute, or tell an administrator." } };
const TOO_LARGE = { status: 413, body: { error: 'TOO_LARGE', message: 'A part of the upload was larger than 8 MiB.' } };

let _socketPath = DEFAULT_SOCKET;

const sessionPath = (sessionId, ...segments) => ['/sessions', sessionId, ...segments].map((s, i) => (i ? encodeURIComponent(s) : s)).join('/');
const journalEventId = (sessionId, seq) => `web-file:${sessionId}:${seq}`;

function fileEvent(session, action, { id = `web-file:${session.id}:${action}:${crypto.randomUUID()}`, name, size, complete } = {}) {
    return {
        ID: id,
        Timestamp: new Date().toISOString(),
        Message: 'TYPE_UNKNOWN',
        reference: FILE_REFERENCE,
        meta: { flow_id: id, protocol: 0, direction: 'EGRESS', source_name: 'Browser Gateway Web', source_type: SOURCE_TYPE, user_id: session.userId },
        remoteAccess: {
            protocol: 'web', kind: 'file', action, sessionId: session.id, user: session.user,
            name: String(name || ''), size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
            ...(complete === false ? { complete } : {}),
        },
    };
}

function record(event) {
    events.addEvent(event).catch(e => console.error('[remote-browser] could not record a file %s: %s', event.remoteAccess.action, e.message));
}

function readJson(res) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let length = 0;
        res.on('data', (chunk) => {
            length += chunk.length;
            if (length > REPLY_MAX) { res.destroy(); reject(new Error('the remote browser sent an answer that is too long')); return; }
            parts.push(chunk);
        });
        res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || 'null')); } catch { reject(new Error('the remote browser sent an answer that could not be read')); }
        });
        res.on('error', reject);
    });
}

function filesRequest(method, path, json) {
    return new Promise((resolve, reject) => {
        const payload = json === undefined ? null : Buffer.from(JSON.stringify(json));
        const req = http.request({
            socketPath: _socketPath, method, path, timeout: REPLY_TIMEOUT_MS,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        });
        req.on('timeout', () => req.destroy(new Error('the remote browser did not answer in time')));
        req.on('error', reject);
        req.on('response', (res) => readJson(res).then(body => resolve({ status: res.statusCode, body }), reject));
        req.end(payload || undefined);
    });
}

function ask(method, path, json) {
    return filesRequest(method, path, json).catch((e) => {
        console.error('[remote-browser] files %s %s: %s', method, path, e.message);
        return UNAVAILABLE;
    });
}

function appBody(status, body) {
    if (status < 400) return body;
    const { error, message, ...rest } = body && typeof body === 'object' ? body : {};
    const code = typeof error === 'string' && error ? error : 'BROWSER_UNAVAILABLE';
    return { ...rest, error: typeof message === 'string' && message ? message : UNAVAILABLE.body.message, code };
}

function relay(res, reply) {
    if (res.headersSent || res.writableEnded) return;
    res.set('Cache-Control', 'no-store');
    res.status(reply.status).json(appBody(reply.status, reply.body));
}

async function listFiles(req, res, session) {
    relay(res, await ask('GET', sessionPath(session.id, 'files')));
}

async function deleteFile(req, res, session) {
    const name = String(req.params.name);
    const reply = await ask('DELETE', sessionPath(session.id, 'files', name));
    relay(res, reply);
    if (reply.status === 200) record(fileEvent(session, 'deleted', { name, size: reply.body && reply.body.size }));
}

async function startUpload(req, res, session) {
    const body = req.body || {};
    relay(res, await ask('POST', sessionPath(session.id, 'uploads'), { name: body.name, size: body.size }));
}

async function cancelUpload(req, res, session) {
    relay(res, await ask('DELETE', sessionPath(session.id, 'uploads', String(req.params.uploadId))));
}

async function uploadChunk(req, res, session) {
    const uploadId = String(req.params.uploadId);
    const declared = req.headers['content-length'];
    if (Number(declared) > CHUNK_MAX) return relay(res, TOO_LARGE);
    const offset = encodeURIComponent(String(req.query.offset ?? ''));
    return new Promise((resolve) => {
        let received = 0;
        let answered = false;
        const upstream = http.request({
            socketPath: _socketPath, method: 'PUT', path: `${sessionPath(session.id, 'uploads', uploadId)}?offset=${offset}`, timeout: STREAM_IDLE_MS,
            headers: { 'Content-Type': 'application/octet-stream', ...(declared !== undefined ? { 'Content-Length': declared } : {}) },
        });
        const answer = (reply) => {
            if (answered) return;
            answered = true;
            if (!req.complete) req.resume();
            relay(res, reply);
            if (reply.status === 200 && reply.body && reply.body.done === true) {
                record(fileEvent(session, 'uploaded', { id: `web-file:${session.id}:upload:${uploadId}`, name: reply.body.name, size: reply.body.size }));
            }
            resolve();
        };
        upstream.on('timeout', () => upstream.destroy(new Error('the remote browser did not answer in time')));
        upstream.on('error', (e) => {
            if (answered) return;
            console.error('[remote-browser] files PUT %s: %s', uploadId, e.message);
            answer(UNAVAILABLE);
        });
        upstream.on('response', (up) => readJson(up).then(body => answer({ status: up.statusCode, body }), () => answer(UNAVAILABLE)));
        res.on('close', () => {
            if (answered) return;
            answered = true;
            upstream.destroy();
            resolve();
        });
        req.on('data', (chunk) => {
            if (answered) return;
            received += chunk.length;
            if (received > CHUNK_MAX) {
                upstream.destroy();
                answer(TOO_LARGE);
                return;
            }
            if (!upstream.write(chunk)) {
                req.pause();
                upstream.once('drain', () => req.resume());
            }
        });
        req.on('end', () => upstream.end());
    });
}

function downloadFile(req, res, session) {
    const name = String(req.params.name);
    return new Promise((resolve) => {
        const upstream = http.request({ socketPath: _socketPath, method: 'GET', path: sessionPath(session.id, 'files', name), timeout: STREAM_IDLE_MS });
        upstream.on('timeout', () => upstream.destroy(new Error('the remote browser did not answer in time')));
        upstream.on('error', (e) => {
            console.error('[remote-browser] files download: %s', e.message);
            if (res.headersSent) res.destroy(); else relay(res, UNAVAILABLE);
            resolve();
        });
        res.on('close', () => upstream.destroy());
        upstream.on('response', (up) => {
            if (up.statusCode !== 200) {
                readJson(up).then(body => relay(res, { status: up.statusCode, body }), () => relay(res, UNAVAILABLE)).finally(resolve);
                return;
            }
            try {
                res.attachment(name);
                res.set('Content-Type', 'application/octet-stream');
                res.set('Cache-Control', 'no-store');
                if (up.headers['content-length']) res.set('Content-Length', up.headers['content-length']);
            } catch (e) {
                up.destroy();
                console.error('[remote-browser] files download headers: %s', e.message);
                relay(res, { status: 400, body: { error: 'BAD_NAME', message: "This file's name can't be sent to the browser." } });
                resolve();
                return;
            }
            let sent = 0;
            const counter = new Transform({ transform(chunk, encoding, done) { sent += chunk.length; done(null, chunk); } });
            pipeline(up, counter, res, (err) => {
                if (sent > 0 || !err) record(fileEvent(session, 'downloaded', { name, size: sent, complete: !err }));
                resolve();
            });
        });
        upstream.end();
    });
}

module.exports = {
    listFiles, downloadFile, deleteFile, startUpload, uploadChunk, cancelUpload, fileEvent, journalEventId, UPLOAD_CHUNK_PATH, CHUNK_MAX,
    _internal: {
        setSocketForTest: (p) => { _socketPath = p || DEFAULT_SOCKET; },
    },
};
