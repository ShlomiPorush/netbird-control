// A fetch()-like request that a browser page load would make. Node's fetch() always sends
// Sec-Fetch-Mode: cors (and replaces a given one), which the server rightly treats as a script's
// request that can't sign in; this sends only the headers it is given, like an older browser or a
// page load (pass sec-fetch-mode: navigate and sec-fetch-dest: document for a modern one).
// Redirects are not followed. Resolves to { status, headers (a Headers), text() }.
const http = require('http');

function pageLoad(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        // Node sends a DELETE body without framing unless its length is given.
        if (body !== undefined) headers = { ...headers, 'content-length': Buffer.byteLength(body) };
        const req = http.request(url, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const h = new Headers();
                for (let i = 0; i < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
                const text = Buffer.concat(chunks).toString();
                resolve({ status: res.statusCode, headers: h, text: async () => text });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
}

module.exports = { pageLoad };
