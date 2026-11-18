// An in-memory stand-in for the remote_access_targets table (Browser Gateway target holds), for
// tests that stub pool.query. It understands the statements lib/remote-access.js sends to that
// table; `query` answers anything else with no rows (or what `other` returns).
function holdTable(other = () => ({ rows: [] })) {
    const rows = new Map(); // resource id -> { resource_id, network_id, address, added_at, expires_at }
    const log = [];
    let fail = null; // (sql) => Error to throw, for a test that makes the database fail
    async function query(sql, params = []) {
        if (!/remote_access_targets/.test(sql)) return other(sql, params);
        log.push({ sql, params });
        const err = fail && fail(sql, params);
        if (err) throw err;
        const [id] = params;
        if (/^\s*SELECT/i.test(sql)) return { rows: [...rows.values()].map(r => ({ ...r })) };
        if (/^\s*INSERT/i.test(sql)) {
            rows.set(id, { resource_id: id, network_id: params[1], address: params[2], added_at: params[3], expires_at: params[4] });
            return { rows: [] };
        }
        if (/SET added_at/.test(sql)) {
            if (rows.has(id)) rows.get(id).added_at = params[1];
            return { rows: [] };
        }
        if (/SET expires_at = GREATEST/.test(sql)) {
            const r = rows.get(id);
            if (r && r.network_id === params[1] && r.address === params[2]) r.expires_at = new Date(Math.max(new Date(r.expires_at).getTime(), new Date(params[3]).getTime()));
            return { rows: [] };
        }
        if (/^\s*DELETE/i.test(sql)) {
            const r = rows.get(id);
            if (r && new Date(r.expires_at).getTime() <= new Date(params[1]).getTime()) rows.delete(id);
            return { rows: [] };
        }
        throw new Error('hold-table: unexpected statement ' + sql);
    }
    return {
        query, rows, log,
        set(id, { networkId, address, addedAt = null, expiresAt }) {
            rows.set(id, { resource_id: id, network_id: networkId, address, added_at: addedAt ? new Date(addedAt) : null, expires_at: new Date(expiresAt) });
        },
        failWith(fn) { fail = fn; },
        clear() { rows.clear(); log.length = 0; fail = null; },
    };
}

module.exports = { holdTable };
