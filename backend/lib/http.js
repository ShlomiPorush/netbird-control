// Shared low-level HTTP helper, extracted verbatim from db.js. httpJson is the generic
// JSON request used by the Telegram transport and the automations endpoint pollers. It also
// records the last successful outbound round-trip, which the NetBird raw callers reuse.
//
// This module requires only Node's http/https builtins - never db.js and never any other lib/
// module (keep the dependency direction one-way: callers -> lib/http.js).

const https = require('https');
const http = require('http');

// Last successful NetBird API round-trip - surfaced on the System Health page so a
// broken token/URL shows up as "no contact since X" instead of silently stale caches.
// httpJson records it here directly; the NetBird raw callers (lib/netbird.js) record it via
// noteNetbirdOk() so _nbLastOkAt has a single owner and there is no shared cross-module state.
let _nbLastOkAt = 0;
function getNetbirdLastOk() { return _nbLastOkAt ? new Date(_nbLastOkAt).toISOString() : null; }
function noteNetbirdOk() { _nbLastOkAt = Date.now(); }

// timeoutMs is the socket idle timeout. deadlineMs bounds the whole request (connect, headers and
// body) and maxBytes bounds the response body; crossing either destroys the request and resolves
// with status 0 and an error, so a slow or oversized response can never hold the caller.
const HTTP_DEADLINE_MS = 30000;
const HTTP_MAX_BYTES = 10 * 1024 * 1024;

function httpJson(method, urlStr, { headers = {}, body = undefined, timeoutMs = 15000, deadlineMs = HTTP_DEADLINE_MS, maxBytes = HTTP_MAX_BYTES } = {}) {
    return new Promise((resolve) => {
        let deadline = null;
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; clearTimeout(deadline); resolve(v); };
        let url;
        try { url = new URL(urlStr); } catch (e) { resolve({ status: 0, error: 'Invalid URL' }); return; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') { resolve({ status: 0, error: 'URL must be http(s)' }); return; }
        const transport = url.protocol === 'https:' ? https : http;
        const h = { 'Accept': 'application/json', ...headers };
        const payload = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        if (payload !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
        const req = transport.request(url, { method, headers: h, timeout: timeoutMs }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > maxBytes) { req.destroy(); finish({ status: 0, error: `response larger than ${maxBytes} bytes` }); return; }
                chunks.push(c);
            });
            res.on('error', e => finish({ status: 0, error: e.message }));
            res.on('end', () => { if (settled) return; const d =Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(d); } catch (e) { } if (res.statusCode >= 200 && res.statusCode < 300) _nbLastOkAt = Date.now(); finish({ status: res.statusCode, body: j, raw: d }); });
        });
        deadline = setTimeout(() => { req.destroy(); finish({ status: 0, error: `response not completed within ${deadlineMs / 1000} s` }); }, deadlineMs);
        req.on('error', e => finish({ status: 0, error: e.message }));
        req.on('timeout', () => { req.destroy(); finish({ status: 0, error: 'timeout' }); });
        if (payload !== null) req.write(payload);
        req.end();
    });
}

module.exports = { httpJson, getNetbirdLastOk, noteNetbirdOk };
