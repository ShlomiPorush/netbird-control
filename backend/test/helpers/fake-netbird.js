const http = require('http');
const crypto = require('crypto');

function startFakeNetbird(names = ['a', 'b']) {
    const state = { users: [], groups: [], peers: [], policies: [], networks: [], resources: [], setup_keys: [], posture_checks: [], bypassed: new Set() };
    const log = [];
    const holds = [];
    const token = crypto.randomBytes(16).toString('hex');
    let seq = 0;

    const collectionOf = (parts) => {
        if (parts[0] === 'networks' && parts[2] === 'resources') return { name: 'resources', id: parts[3], networkId: parts[1] };
        if (parts[0] === 'networks' && parts[1] === 'resources') return { name: 'resources', id: parts[2] };
        return { name: parts[0], id: parts[1] };
    };

    function handle(method, path, query, body) {
        if (method === 'GET' && path === '/api/peers/edr/bypassed') return { status: 200, body: [...state.bypassed].map((id) => ({ peer_id: id })) };
        const bypass = /^\/api\/peers\/([^/]+)\/edr\/bypass$/.exec(path);
        if (bypass && method === 'POST') { state.bypassed.add(bypass[1]); return { status: 200, body: {} }; }
        if (bypass && method === 'DELETE') return state.bypassed.delete(bypass[1]) ? { status: 200, body: {} } : { status: 404, body: { message: 'not bypassed' } };
        const parts = path.replace(/^\/api\//, '').split('/').filter(Boolean);
        const { name, id, networkId } = collectionOf(parts);
        const list = state[name];
        if (!list) return { status: 404, body: { message: `no ${name}` } };
        const find = (x) => list.findIndex((o) => o.id === x);
        if (method === 'GET' && !id) {
            let rows = networkId ? list.filter((r) => r.network_id === networkId) : list;
            if (name === 'users') rows = rows.filter((u) => !!u.is_service_user === (query.get('service_user') === 'true'));
            return { status: 200, body: rows };
        }
        if (method === 'GET') { const i = find(id); return i < 0 ? { status: 404, body: { message: 'not found' } } : { status: 200, body: list[i] }; }
        if (method === 'POST') {
            const row = { ...body, id: `${name}-${++seq}`, ...(networkId ? { network_id: networkId } : {}) };
            list.push(row);
            return { status: 200, body: row };
        }
        if (method === 'PUT') {
            const i = find(id);
            if (i < 0) return { status: 404, body: { message: 'not found' } };
            list[i] = { ...list[i], ...body, id };
            return { status: 200, body: list[i] };
        }
        if (method === 'DELETE') {
            const i = find(id);
            if (i < 0) return { status: 404, body: { message: 'not found' } };
            list.splice(i, 1);
            return { status: 200, body: {} };
        }
        return { status: 405, body: {} };
    }

    const handler = (who) => (req, res) => {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', async () => {
            const url = new URL(req.url, 'http://x');
            const path = url.pathname;
            const body = raw ? JSON.parse(raw) : undefined;
            if (req.headers.authorization !== `Token ${token}`) { res.writeHead(401); res.end('{}'); return; }
            const entry = { who, method: req.method, path, body, at: Date.now() };
            log.push(entry);
            const hold = holds.find((h) => !h.used && h.method === req.method && h.match.test(path) && (!h.who || h.who === who));
            if (hold) hold.used = true;
            if (hold && hold.when === 'before') {
                hold.reached(entry);
                if ((await hold.released) === 'drop') { entry.status = 'dropped'; req.socket.destroy(); return; }
            }
            const out = handle(req.method, path, url.searchParams, body);
            entry.status = out.status;
            if (hold && hold.when === 'after') { hold.reached(entry); const action = await hold.released; if (action === 'drop') { req.socket.destroy(); return; } }
            res.writeHead(out.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.body));
        });
    };

    const servers = {};
    const listen = (who) => new Promise((resolve) => {
        const srv = http.createServer(handler(who));
        srv.listen(0, '127.0.0.1', () => { servers[who] = srv; resolve(); });
    });
    return Promise.all(names.map(listen)).then(() => {
        const portOf = (who) => servers[who].address().port;
        return ({
            state, log, token,
            envFor(who) { return { NETBIRD_API_URL: `http://127.0.0.1:${portOf(who)}`, NETBIRD_API_TOKEN: token }; },
            hold(method, match, { who = null, when = 'before' } = {}) {
                let reached, release;
                const h = { method, match, who, when, used: false };
                h.reachedPromise = new Promise((r) => { reached = r; });
                h.reached = reached;
                h.released = new Promise((r) => { release = r; });
                holds.push(h);
                return { reached: h.reachedPromise, release: (action) => release(action) };
            },
            close() { return Promise.all(Object.values(servers).map((srv) => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }))); },
        });
    });
}

module.exports = { startFakeNetbird };
