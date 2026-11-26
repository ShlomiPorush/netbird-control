'use strict';

function browserTable() {
    const rows = new Map();
    const sql = [];
    const open = (r) => r.state !== 'ended';
    const now = () => new Date();
    const copy = (r) => ({ ...r });
    const one = (r) => ({ rows: r ? [copy(r)] : [], rowCount: r ? 1 : 0 });
    const many = (list) => ({ rows: list.map(copy), rowCount: list.length });
    const resumable = (r, states, keepAliveMin) => states.includes(r.state)
        && (r.state !== 'detached' || r.detached_at > new Date(Date.now() - keepAliveMin * 60_000));
    const tokenUntil = () => new Date(Date.now() + 30_000);

    function query(text, params = []) {
        const s = text.replace(/\s+/g, ' ').trim();
        sql.push(s);
        const p = params;
        if (/^SELECT pg_advisory_xact_lock/.test(s) || /^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return { rows: [] };
        if (!/browser_sessions/.test(s)) return null;
        if (/^SELECT COUNT\(\*\)::int AS n, \(COUNT\(\*\) FILTER \(WHERE user_id = \$1\)\)::int AS mine FROM browser_sessions WHERE state <> 'ended'$/.test(s)) {
            const live = [...rows.values()].filter(open);
            return { rows: [{ n: live.length, mine: live.filter(r => r.user_id === p[0]).length }] };
        }
        if (/^INSERT INTO browser_sessions/.test(s)) {
            if (rows.has(p[0])) throw new Error('duplicate key');
            rows.set(p[0], {
                id: p[0], user_id: p[1], user_email: p[2], user_name: p[3], oid: p[4], client_ip: p[5], state: 'starting',
                width: p[6], height: p[7], dpi: p[8], attachment: p[9], uid: null, port: null, owner_instance: '', recorded: false,
                created_at: now(), last_auth_ok_at: p[10], lease_expires_at: null, detached_at: null, ended_at: null, end_reason: '', end_code: null,
                supervisor_instance: '', token_hash: null, token_expires: null, conn_count: 0,
            });
            return { rows: [], rowCount: 1 };
        }
        if (/^UPDATE browser_sessions SET state = 'detached', detached_at = NOW\(\), uid = \$2, port = \$3, supervisor_instance = \$4 WHERE id = \$1 AND state = 'starting' RETURNING \*$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.state !== 'starting') return one(null);
            Object.assign(r, { state: 'detached', detached_at: now(), uid: p[1], port: p[2], supervisor_instance: p[3] });
            return one(r);
        }
        if (/^UPDATE browser_sessions SET recorded = true WHERE id = \$1$/.test(s)) { const r = rows.get(p[0]); if (r) r.recorded = true; return one(r); }
        if (/^SELECT \* FROM browser_sessions WHERE id = \$1$/.test(s)) return one(rows.get(p[0]));
        if (/^UPDATE browser_sessions SET token_hash = \$4, token_expires = NOW\(\) \+ interval '30 seconds' WHERE id = \$1 AND state = ANY\(\$2\) AND \(state <> 'detached' OR detached_at > NOW\(\) - \$3 \* interval '1 minute'\) RETURNING id$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || !resumable(r, p[1], p[2])) return one(null);
            Object.assign(r, { token_hash: p[3], token_expires: tokenUntil() });
            return one(r);
        }
        if (/^UPDATE browser_sessions SET token_hash = NULL, token_expires = NULL WHERE token_hash = \$1 AND token_expires > NOW\(\) AND state = ANY\(\$2\) RETURNING id, user_id, attachment, width, height, dpi$/.test(s)) {
            const r = [...rows.values()].find(x => x.token_hash === p[0] && x.token_expires > now() && p[1].includes(x.state));
            if (!r) return one(null);
            Object.assign(r, { token_hash: null, token_expires: null });
            return one(r);
        }
        if (/^UPDATE browser_sessions SET attachment = \$5, last_auth_ok_at = GREATEST\(last_auth_ok_at, \$10\), width = \$6, height = \$7, dpi = \$8, token_hash = \$9, token_expires = NOW\(\) \+ interval '30 seconds' WHERE id = \$1 AND user_id = \$4 AND state = ANY\(\$2\) AND \(state <> 'detached' OR detached_at > NOW\(\) - \$3 \* interval '1 minute'\) RETURNING id$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.user_id !== p[3] || !resumable(r, p[1], p[2])) return one(null);
            Object.assign(r, { attachment: p[4], last_auth_ok_at: new Date(Math.max(r.last_auth_ok_at.getTime(), p[9].getTime())), width: p[5], height: p[6], dpi: p[7], token_hash: p[8], token_expires: tokenUntil() });
            return one(r);
        }
        if (/^SELECT id FROM browser_sessions WHERE id = \$1 AND state = 'detached' AND detached_at <= NOW\(\) - \$2 \* interval '1 minute'$/.test(s)) {
            const r = rows.get(p[0]);
            return one(r && r.state === 'detached' && r.detached_at <= new Date(Date.now() - p[1] * 60_000) ? r : null);
        }
        if (/^SELECT id, state, width, height, created_at, detached_at FROM browser_sessions WHERE user_id = \$1 AND state <> 'ended' ORDER BY created_at$/.test(s)) {
            return many([...rows.values()].filter(r => open(r) && r.user_id === p[0]));
        }
        if (/^UPDATE browser_sessions SET lease_expires_at = CASE .* WHERE id = \$1 AND user_id = \$2 AND attachment = \$4 AND state = ANY\(\$3\) RETURNING id$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.user_id !== p[1] || r.attachment !== p[3] || !p[2].includes(r.state)) return one(null);
            if (r.state === 'active') r.lease_expires_at = new Date(Date.now() + 150_000);
            return one(r);
        }
        if (/^UPDATE browser_sessions SET state = 'ending', token_hash = NULL, token_expires = NULL, .* WHERE id = \$1 AND state <> 'ended' RETURNING \*$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.state === 'ended') return one(null);
            if (!r.end_reason) { r.end_reason = p[1]; r.end_code = p[2]; }
            Object.assign(r, { state: 'ending', token_hash: null, token_expires: null });
            return one(r);
        }
        if (/^UPDATE browser_sessions SET state = 'ended', ended_at = NOW\(\) WHERE id = \$1 AND state = 'ending'$/.test(s)) {
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
        if (/^UPDATE browser_sessions SET state = 'active', owner_instance = \$5, detached_at = NULL, lease_expires_at = NOW\(\) \+ interval '150 seconds' WHERE id = \$1 AND attachment = \$4 AND state = ANY\(\$2\) AND \(state <> 'detached' OR detached_at > NOW\(\) - \$3 \* interval '1 minute'\) RETURNING id$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.attachment !== p[3] || !resumable(r, p[1], p[2])) return one(null);
            Object.assign(r, { state: 'active', owner_instance: p[4], detached_at: null, lease_expires_at: new Date(Date.now() + 150_000) });
            return one(r);
        }
        if (/^SELECT id, state, attachment, end_reason, end_code FROM browser_sessions WHERE id = ANY\(\$1\)$/.test(s)) return many(p[0].map(id => rows.get(id)).filter(Boolean));
        if (/^SELECT id FROM browser_sessions WHERE state <> 'ended'$/.test(s)) return many([...rows.values()].filter(open));
        if (/^UPDATE browser_sessions SET last_auth_ok_at = GREATEST\(last_auth_ok_at, \$2\) WHERE id = \$1 AND state <> 'ended' RETURNING last_auth_ok_at$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || !open(r)) return one(null);
            if (p[1] > r.last_auth_ok_at) r.last_auth_ok_at = p[1];
            return one(r);
        }
        if (/^SELECT \* FROM browser_sessions WHERE state <> 'ended'$/.test(s)) return many([...rows.values()].filter(open));
        if (/^UPDATE browser_sessions SET state = 'detached', detached_at = lease_expires_at, owner_instance = '' WHERE id = \$1 AND state = 'active' AND lease_expires_at < NOW\(\) RETURNING detached_at$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r || r.state !== 'active' || !(r.lease_expires_at < now())) return one(null);
            Object.assign(r, { state: 'detached', detached_at: r.lease_expires_at, owner_instance: '' });
            return one(r);
        }
        if (/^SELECT 1 FROM browser_sessions WHERE state <> 'ended' LIMIT 1$/.test(s)) return many([...rows.values()].filter(open).slice(0, 1));
        if (/^DELETE FROM browser_sessions WHERE state = 'ended'/.test(s)) return { rows: [], rowCount: 0 };
        if (/^SELECT id, uid, user_id, user_email, user_name FROM browser_sessions WHERE state <> 'ended'$/.test(s)) return many([...rows.values()].filter(open));
        if (/^SELECT id, user_id, user_email, user_name FROM browser_sessions WHERE id = ANY\(\$1\) AND state = ANY\(\$2\)$/.test(s)) {
            return many(p[0].map(id => rows.get(id)).filter(r => r && p[1].includes(r.state)));
        }
        if (/^SELECT conn_count FROM browser_sessions WHERE id = \$1 FOR UPDATE$/.test(s)) return one(rows.get(p[0]));
        if (/^UPDATE browser_sessions SET conn_count = conn_count \+ 1 WHERE id = \$1$/.test(s)) {
            const r = rows.get(p[0]);
            if (!r) return one(null);
            r.conn_count += 1;
            return one(r);
        }
        if (/^SELECT state, COUNT\(\*\)::int AS n FROM browser_sessions/.test(s)) {
            const counts = new Map();
            for (const r of rows.values()) if (open(r)) counts.set(r.state, (counts.get(r.state) || 0) + 1);
            return { rows: [...counts].map(([state, n]) => ({ state, n })) };
        }
        throw new Error(`browser-table: unexpected SQL: ${s}`);
    }

    const client = { query: async (text, params) => query(text, params) || { rows: [] }, release: () => { } };
    return { rows, sql, query, connect: async () => client };
}

module.exports = { browserTable };
