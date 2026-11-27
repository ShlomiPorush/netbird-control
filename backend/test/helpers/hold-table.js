function coordinationAnswer(coordination, sql, params) {
    if (/^\s*SELECT key, value FROM coordination WHERE key = ANY\(\$1\) OR key LIKE \$2/.test(sql)) {
        const prefix = params[1].replace(/%$/, '');
        return { rows: [...coordination].filter(([k]) => params[0].includes(k) || k.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
    }
    if (/^\s*INSERT INTO coordination \(key, value\) VALUES \(\$1, \$2\)\s*$/.test(sql)) {
        coordination.set(params[0], String(params[1]));
        return { rows: [], rowCount: 1 };
    }
    if (/^\s*DELETE FROM coordination WHERE key = \$1/.test(sql)) {
        const had = coordination.has(params[0]) && (params.length < 2 || coordination.get(params[0]) === params[1]);
        if (had) coordination.delete(params[0]);
        return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (/^\s*INSERT INTO coordination/.test(sql) && /coordination\.value::bigint \+ 1/.test(sql)) {
        coordination.set(params[0], String(Number(coordination.get(params[0]) || 0) + 1));
        return { rows: [], rowCount: 1 };
    }
    if (/^\s*INSERT INTO coordination/.test(sql) && /GREATEST\(coordination\.value::bigint, EXCLUDED\.value::bigint\)/.test(sql)) {
        coordination.set(params[0], String(Math.max(Number(coordination.get(params[0]) || 0), Number(params[1]))));
        return { rows: [], rowCount: 1 };
    }
    if (/^\s*UPDATE coordination SET value = \$2 WHERE key = \$1/.test(sql)) {
        const had = coordination.has(params[0]);
        if (had) coordination.set(params[0], String(params[1]));
        return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (/^\s*DELETE FROM coordination WHERE key = ANY\(\$1\)/.test(sql)) {
        for (const k of params[0]) coordination.delete(k);
        return { rows: [], rowCount: 0 };
    }
    return null;
}

function sessionsAnswer(sessions, sql, params) {
    if (/^\s*SELECT COUNT\(\*\)::int AS total, \(COUNT\(\*\) FILTER \(WHERE user_id = \$1\)\)::int AS mine\s+FROM remote_sessions/.test(sql)) {
        const open = [...sessions.values()];
        return { rows: [{ total: open.length, mine: open.filter(r => r.user_id === params[0]).length }] };
    }
    if (/^\s*INSERT INTO remote_sessions/.test(sql)) {
        sessions.set(params[0], { id: params[0], user_id: params[1], resource_id: params[8] });
        return { rows: [], rowCount: 1 };
    }
    if (/^\s*DELETE FROM remote_sessions WHERE id = \$1/.test(sql)) {
        const had = sessions.delete(params[0]);
        return { rows: [], rowCount: had ? 1 : 0 };
    }
    return null;
}

function holdTable(other = () => ({ rows: [] })) {
    const rows = new Map(); // resource id -> { resource_id, network_id, address, added_at, expires_at, updated_at }
    const coordination = new Map();
    const sessions = new Map();
    const log = [];
    let fail = null; // (sql) => Error to throw, for a test that makes the database fail
    const ms = (v) => new Date(v).getTime();
    const out = (r) => ({ resource_id: r.resource_id, network_id: r.network_id, address: r.address, added_at: r.added_at, expires_at: r.expires_at });
    async function query(sql, params = []) {
        if (!/remote_access_targets/.test(sql)) return coordinationAnswer(coordination, sql, params) || sessionsAnswer(sessions, sql, params) || other(sql, params);
        log.push({ sql, params });
        const err = fail && fail(sql, params);
        if (err) throw err;
        const [id] = params;
        const now = new Date();
        if (/^\s*SELECT/i.test(sql)) {
            let list = [...rows.values()];
            if (/WHERE resource_id = \$1 AND network_id = \$2/.test(sql)) list = list.filter(r => r.resource_id === id && r.network_id === params[1]);
            else if (params.length) throw new Error('hold-table: unexpected SELECT ' + sql);
            return { rows: list.map(r => ({ ...r })), rowCount: list.length };
        }
        if (/^\s*INSERT/i.test(sql) && /ON CONFLICT \(resource_id\) DO UPDATE/.test(sql)) {
            const [, networkId, address, expiresAt] = params;
            const cur = rows.get(id);
            const same = cur && cur.network_id === networkId && cur.address === address;
            const next = {
                resource_id: id, network_id: networkId, address,
                added_at: same ? cur.added_at : null,
                expires_at: same ? new Date(Math.max(ms(cur.expires_at), ms(expiresAt))) : new Date(expiresAt),
                updated_at: now,
            };
            rows.set(id, next);
            return { rows: [out(next)], rowCount: 1 };
        }
        if (/SET added_at = \$4/.test(sql)) {
            const r = rows.get(id);
            if (!r || r.network_id !== params[1] || r.address !== params[2]) return { rows: [], rowCount: 0 };
            r.added_at = params[3]; r.updated_at = now;
            return { rows: [], rowCount: 1 };
        }
        if (/SET expires_at = GREATEST\(expires_at, \$4\)/.test(sql)) {
            const r = rows.get(id);
            if (!r || r.network_id !== params[1] || r.address !== params[2]) return { rows: [], rowCount: 0 };
            r.expires_at = new Date(Math.max(ms(r.expires_at), ms(params[3]))); r.updated_at = now;
            return { rows: [], rowCount: 1 };
        }
        if (/^\s*DELETE/i.test(sql)) {
            const r = rows.get(id);
            const grace = /updated_at < NOW\(\) - interval '(\d+) minutes'/.exec(sql);
            const ok = r && ms(r.expires_at) <= ms(params[1]) && (!grace || ms(r.updated_at) < Date.now() - Number(grace[1]) * 60_000);
            if (ok) rows.delete(id);
            return { rows: [], rowCount: ok ? 1 : 0 };
        }
        throw new Error('hold-table: unexpected statement ' + sql);
    }
    return {
        query, rows, coordination, sessions, log,
        // A row as another instance (or an earlier session) left it; updatedAt defaults to long ago.
        set(id, { networkId, address, addedAt = null, expiresAt, updatedAt = Date.now() - 3_600_000 }) {
            rows.set(id, { resource_id: id, network_id: networkId, address, added_at: addedAt ? new Date(addedAt) : null, expires_at: new Date(expiresAt), updated_at: new Date(updatedAt) });
        },
        failWith(fn) { fail = fn; },
        clear() { rows.clear(); coordination.clear(); sessions.clear(); log.length = 0; fail = null; },
    };
}

module.exports = { holdTable };
