'use strict';

function browserTable() {
    const rows = new Map();
    const sql = [];
    const open = (r) => r.state !== 'ended';
    const now = () => new Date();
    const copy = (r) => ({ ...r });
    const one = (r) => ({ rows: r ? [copy(r)] : [], rowCount: r ? 1 : 0 });
    const many = (list) => ({ rows: list.map(copy), rowCount: list.length });

    function query(text, params = []) {
        const s = text.replace(/\s+/g, ' ').trim();
        sql.push(s);
        const p = params;
        if (/^SELECT pg_advisory_xact_lock/.test(s) || /^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return { rows: [] };
        if (/^SELECT COUNT\(\*\)::int AS n FROM browser_sessions WHERE state <> 'ended'$/.test(s)) return { rows: [{ n: [...rows.values()].filter(open).length }] };
        if (/^INSERT INTO browser_sessions/.test(s)) {
            if (rows.has(p[0])) throw new Error('duplicate key');
            rows.set(p[0], {
                id: p[0], user_id: p[1], user_email: p[2], user_name: p[3], oid: p[4], client_ip: p[5], state: 'starting',
                width: p[6], height: p[7], dpi: p[8], attachment: p[9], uid: null, port: null, owner_instance: '', recorded: false,
                created_at: now(), last_auth_ok_at: now(), lease_expires_at: null, detached_at: null, ended_at: null, end_reason: '', end_code: null,
            });
            return { rows: [], rowCount: 1 };
        }
        if (/^UPDATE browser_sessions SET state = 'detached', detached_at = NOW\(\), uid = \$2, port = \$3 WHERE id = \$1 AND state = 'starting'/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.state !== 'starting') return one(null);
            Object.assign(r, { state: 'detached', detached_at: now(), uid: p[1], port: p[2] });
            return one(r);
        }
        if (/^UPDATE browser_sessions SET recorded = true/.test(s)) { const r = rows.get(p[0]); if (r) r.recorded = true; return one(r); }
        if (/^SELECT \* FROM browser_sessions WHERE id = \$1$/.test(s)) return one(rows.get(p[0]));
        if (/^UPDATE browser_sessions SET attachment = \$3, last_auth_ok_at = NOW\(\)/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.user_id !== p[1] || !p[3].includes(r.state)) return one(null);
            Object.assign(r, { attachment: p[2], last_auth_ok_at: now() });
            return one(r);
        }
        if (/^SELECT id, state, width, height, created_at, detached_at FROM browser_sessions WHERE user_id = \$1/.test(s)) {
            return many([...rows.values()].filter(r => open(r) && r.user_id === p[0]));
        }
        if (/^UPDATE browser_sessions SET lease_expires_at = CASE/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.user_id !== p[1] || !p[2].includes(r.state)) return one(null);
            if (r.state === 'active') r.lease_expires_at = new Date(Date.now() + 150_000);
            return one(r);
        }
        if (/^UPDATE browser_sessions SET state = 'ending'/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.state === 'ended') return one(null);
            if (!r.end_reason) { r.end_reason = p[1]; r.end_code = p[2]; }
            r.state = 'ending';
            return one(r);
        }
        if (/^UPDATE browser_sessions SET state = 'ended', ended_at = NOW\(\) WHERE id = \$1 AND state = 'ending'/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.state !== 'ending') return one(null);
            Object.assign(r, { state: 'ended', ended_at: now() });
            return one(r);
        }
        if (/^UPDATE browser_sessions SET state = 'detached', detached_at = NOW\(\), owner_instance = '' WHERE id = \$1 AND attachment = \$2 AND state = 'active'$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.attachment !== p[1] || r.state !== 'active') return one(null);
            Object.assign(r, { state: 'detached', detached_at: now(), owner_instance: '' });
            return one(r);
        }
        if (/^UPDATE browser_sessions SET state = 'active', owner_instance = \$3/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.attachment !== p[1] || !p[3].includes(r.state)) return one(null);
            Object.assign(r, { state: 'active', owner_instance: p[2], detached_at: null, lease_expires_at: new Date(Date.now() + 150_000) });
            return one(r);
        }
        if (/^SELECT id, state, attachment, end_reason, end_code FROM browser_sessions WHERE id = ANY\(\$1\)$/.test(s)) return many(p[0].map(id => rows.get(id)).filter(Boolean));
        if (/^SELECT id FROM browser_sessions WHERE state <> 'ended'$/.test(s)) return many([...rows.values()].filter(open));
        if (/^SELECT \* FROM browser_sessions WHERE state = ANY\(\$1\)$/.test(s)) return many([...rows.values()].filter(r => p[0].includes(r.state)));
        if (/^UPDATE browser_sessions SET last_auth_ok_at = \$2 WHERE id = ANY\(\$1\)/.test(s)) {
            for (const id of p[0]) { const r = rows.get(id); if (r && open(r)) r.last_auth_ok_at = p[1]; }
            return { rows: [], rowCount: p[0].length };
        }
        if (/^SELECT \* FROM browser_sessions WHERE state <> 'ended'$/.test(s)) return many([...rows.values()].filter(open));
        if (/^UPDATE browser_sessions SET state = 'detached', detached_at = lease_expires_at/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.state !== 'active' || !(r.lease_expires_at < now())) return one(null);
            Object.assign(r, { state: 'detached', detached_at: r.lease_expires_at, owner_instance: '' });
            return one(r);
        }
        if (/^SELECT 1 FROM browser_sessions WHERE state <> 'ended' LIMIT 1$/.test(s)) return many([...rows.values()].filter(open).slice(0, 1));
        if (/^DELETE FROM browser_sessions WHERE state = 'ended'/.test(s)) return { rows: [], rowCount: 0 };
        if (/^SELECT id, uid, user_id, user_email, user_name FROM browser_sessions WHERE state <> 'ended'/.test(s)) {
            const uidOnly = /uid IS NOT NULL/.test(s);
            return many([...rows.values()].filter(r => open(r) && (!uidOnly || r.uid !== null)));
        }
        if (/^SELECT id, user_id, user_email, user_name FROM browser_sessions WHERE id = ANY\(\$1\)$/.test(s)) return many(p[0].map(id => rows.get(id)).filter(Boolean));
        if (/^SELECT state, COUNT\(\*\)::int AS n FROM browser_sessions/.test(s)) {
            const counts = new Map();
            for (const r of rows.values()) if (open(r)) counts.set(r.state, (counts.get(r.state) || 0) + 1);
            return { rows: [...counts].map(([state, n]) => ({ state, n })) };
        }
        return null;
    }

    const client = { query: async (text, params) => query(text, params) || { rows: [] }, release: () => { } };
    return { rows, sql, query, connect: async () => client };
}

module.exports = { browserTable };
