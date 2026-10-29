// Event store + queries, extracted verbatim from db.js. All pure pool work over the events /
// admin_events / ip_assignments / filter_rules tables: ingest, the detailed + summary + IP-history
// + stats queries, the shared WHERE builder, the event filter-rules CRUD (+ its cache + the noise
// FILTER EVALUATION shared by both ingestion paths), the API-traffic-event → webhook-payload
// mapper, and the admin purge scan/delete. Requires only lib/core.js (events -> core, one-way; never db.js, no
// cycle). The domain-coupled event functions stay in db.js: addAdminEvent (Telegram notify),
// queryAdminEvents (NetBird category SQL), purgeOldEvents (retention/audit), getAuditLog, and
// syncIpAssignments (peers cache).

const { pool, onSettingChange, setSetting, cappedCount } = require('./core');
// For resolving "proxy-<id>" ingress peer names to service/cluster names at read time, and the
// tenant ALS so every read/write here scopes to the active account (events -> netbird -> core,
// still one-way; netbird.js never requires events.js).
const { getReverseProxyStatus, currentTenantAccount } = require('./netbird');
// The active account for DB queries: '' = main, else a tenant. Every events/admin_events/
// ip_assignments query filters on this so one account's rows never surface under another.
const tnt = () => currentTenantAccount() || '';

// ─── Ingress peer name resolution ───
// NetBird-managed reverse-proxy peers are named "proxy-<20-char id>" - an opaque id in every
// traffic view. Resolve the id against the reverse-proxy inventory (service ids, cluster ids)
// and show the real name instead. Applied at READ time so stored history benefits too.
const PROXY_PEER_RE = /^proxy-([a-z0-9]{16,})$/i;
async function proxyLabelMap() {
    try {
        const st = await getReverseProxyStatus();
        const m = new Map();
        for (const c of (st && st.clusters) || []) if (c.id) m.set(String(c.id), c.address || '');
        for (const s of (st && st.services) || []) if (s.id) m.set(String(s.id), s.name || s.domain || '');
        return m;
    } catch { return new Map(); }
}
function resolveProxyPeerName(name, map) {
    const m = PROXY_PEER_RE.exec(String(name || ''));
    if (!m) return name;
    const label = map.get(m[1]);
    if (label) return `Proxy - ${label}`;
    // The id is a proxy INSTANCE id - NetBird has no API listing instances by name, so the
    // best readable label is a generic one; the short suffix keeps instances distinguishable.
    return `NetBird Proxy (${m[1].slice(-6)})`;
}

// ─── NetBird API traffic events → the WEBHOOK payload shape ───
// The opt-in API pull (GET /api/events/network-traffic; syncTrafficEvents in db.js) must produce
// rows indistinguishable from streamed webhook events, so every existing consumer - Activity
// detailed + summary, the filters, retention, the capped counts, the purge tool - works unchanged.
// Shape difference to bridge: the webhook streams ONE payload per flow state change (Message =
// TYPE_START / TYPE_END / TYPE_DROP), while the API returns ONE aggregated object per flow window
// carrying the window's byte/packet TOTALS plus a nested events[] of {type,timestamp}. So one API
// object maps to exactly ONE payload - the flow's first observed state, with the window totals.
// That single row is a constraint, not a shortcut: the Summary view SUMs rx_bytes/tx_bytes and
// counts COUNT(DISTINCT flow_id), so emitting a second row per flow would double every byte figure.
const API_EVENT_TYPES = ['TYPE_START', 'TYPE_END', 'TYPE_DROP'];
function mapApiTrafficEvent(e) {
    if (!e || typeof e !== 'object') return null;
    const flowId = String(e.flow_id || '');
    if (!flowId) return null; // no stable key - not ingestable
    const obj = (x) => (x && typeof x === 'object') ? x : {};
    const src = obj(e.source), dst = obj(e.destination);
    const sgeo = obj(src.geo_location), dgeo = obj(dst.geo_location);
    const user = obj(e.user), policy = obj(e.policy), icmp = obj(e.icmp);
    const list = Array.isArray(e.events) ? e.events.filter(x => x && x.timestamp) : [];
    const first = list[0] || null;
    // Message is what the Activity views read for the state dot and the description line, so it
    // must carry the same TYPE_* vocabulary the webhook sends. num_of_* is the fallback when a
    // response omits events[].
    const type = (first && API_EVENT_TYPES.includes(String(first.type)) && String(first.type))
        || (Number(e.num_of_drops) > 0 ? 'TYPE_DROP' : Number(e.num_of_ends) > 0 && !Number(e.num_of_starts) ? 'TYPE_END' : 'TYPE_START');
    const winStart = e.window_start ? String(e.window_start) : '';
    const timestamp = (first && String(first.timestamp)) || winStart || (e.window_end ? String(e.window_end) : '') || new Date().toISOString();
    return {
        // Synthetic but STABLE id: the same flow window always maps to the same id, so the
        // (tenant, id) ON CONFLICT DO NOTHING in addEvent makes the deliberately overlapping
        // re-pulls idempotent - a flow can never be stored twice.
        ID: `${flowId}@${winStart || timestamp}`,
        Timestamp: timestamp,
        Message: type,
        InitiatorID: '', // traffic events have no initiator - webhook parity
        target_id: '',
        reference: '',
        meta: {
            flow_id: flowId,
            protocol: Number(e.protocol) || 0,
            direction: String(e.direction || ''),
            source_addr: String(src.address || ''),
            source_name: String(src.name || ''),
            source_dns_label: String(src.dns_label || ''),
            source_id: String(src.id || ''),
            source_type: String(src.type || ''),
            source_geo_country: String(sgeo.country_code || ''),
            source_geo_city: String(sgeo.city_name || ''),
            destination_addr: String(dst.address || ''),
            destination_name: String(dst.name || ''),
            destination_dns_label: String(dst.dns_label || ''),
            destination_id: String(dst.id || ''),
            destination_type: String(dst.type || ''),
            destination_geo_country: String(dgeo.country_code || ''),
            destination_geo_city: String(dgeo.city_name || ''),
            policy_id: String(policy.id || ''),
            policy_name: String(policy.name || ''),
            icmp_type: Number(icmp.type) || 0,
            icmp_code: Number(icmp.code) || 0,
            rx_bytes: Number(e.rx_bytes) || 0,
            rx_packets: Number(e.rx_packets) || 0,
            tx_bytes: Number(e.tx_bytes) || 0,
            tx_packets: Number(e.tx_packets) || 0,
            user_id: String(user.id || ''),
            reporter_id: String(e.reporter_id || ''),
        },
        // The untouched API object rides along so the Activity Raw viewer shows exactly what
        // NetBird returned - source.os, num_of_*, window_end and the full events[] have no
        // dedicated column, and this is where they stay readable.
        netbird_api_event: e,
    };
}

async function addEvent(payload) {
    const meta = payload.meta || {};
    const query = `
    INSERT INTO events (
      tenant, id, timestamp, message, initiator_id, target_id,
      flow_id, protocol, direction,
      source_addr, source_name, source_dns_label, source_id, source_type,
      source_geo_country, source_geo_city,
      destination_addr, destination_name, destination_dns_label, destination_id, destination_type,
      destination_geo_country, destination_geo_city,
      policy_id, policy_name, icmp_type, icmp_code,
      rx_bytes, rx_packets, tx_bytes, tx_packets,
      user_id, reporter_id, reference, raw_json
    ) VALUES (
      $35, $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11, $12, $13,
      $14, $15,
      $16, $17, $18, $19, $20,
      $21, $22,
      $23, $24, $25, $26,
      $27, $28, $29, $30,
      $31, $32, $33, $34
    ) ON CONFLICT (tenant, id) DO NOTHING
  `;

    const values = [
        payload.ID,
        payload.Timestamp,
        payload.Message,
        payload.InitiatorID || '',
        payload.target_id || '',
        meta.flow_id || '',
        meta.protocol || 0,
        meta.direction || '',
        meta.source_addr || '',
        meta.source_name || '',
        meta.source_dns_label || '',
        meta.source_id || '',
        meta.source_type || '',
        meta.source_geo_country || '',
        meta.source_geo_city || '',
        meta.destination_addr || '',
        meta.destination_name || '',
        meta.destination_dns_label || '',
        meta.destination_id || '',
        meta.destination_type || '',
        meta.destination_geo_country || '',
        meta.destination_geo_city || '',
        meta.policy_id || '',
        meta.policy_name || '',
        meta.icmp_type || 0,
        meta.icmp_code || 0,
        meta.rx_bytes || 0,
        meta.rx_packets || 0,
        meta.tx_bytes || 0,
        meta.tx_packets || 0,
        meta.user_id || '',
        meta.reporter_id || '',
        payload.reference || '',
        JSON.stringify(payload),
        tnt(), // the active account - main ('') or a tenant (webhook resolved from its token)
    ];

    return pool.query(query, values);
}

// Split into scalar subqueries on purpose: earliest/latest are then single index probes on
// idx_admin_events_tenant_ts (first/last entry of this tenant's slice) instead of riding along a
// full aggregate pass. Only the exact COUNT still walks the slice - and it walks the index, not
// the heap.
async function getAdminStats() {
    const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM admin_events WHERE tenant = $1) AS total_events,
      (SELECT timestamp FROM admin_events WHERE tenant = $1 ORDER BY timestamp ASC LIMIT 1) AS earliest,
      (SELECT timestamp FROM admin_events WHERE tenant = $1 ORDER BY timestamp DESC LIMIT 1) AS latest
  `, [tnt()]);
    return result.rows[0];
}

const IP_SORT_COLS = {
    ip: 'ip', external: 'connection_ip', user: 'user_name', device: 'peer_name',
    firstSeen: 'first_seen', lastSeen: 'last_seen', status: '(released_at IS NULL)',
};

// Search the history. `q` matches the NetBird IP, public connection IP, peer or user; `at` is a
// point in time - only intervals covering that instant match ("who had this IP then?"). `user`
// filters by the holder's NetBird user id (exact or |oid-tail).
async function queryIpHistory({ q, at, user, sort, dir, page = 1, per_page = 25 } = {}) {
    // Scope to the active account - main ('') or a tenant, identically (each has its own history).
    const conds = ['tenant = $1'], params = [tnt()];
    let i = 2;
    if (q) {
        conds.push(`(ip ILIKE $${i} OR connection_ip ILIKE $${i} OR peer_name ILIKE $${i} OR dns_label ILIKE $${i} OR user_name ILIKE $${i} OR user_email ILIKE $${i})`);
        params.push(`%${q}%`); i++;
    }
    if (at) {
        conds.push(`first_seen <= $${i} AND COALESCE(released_at, NOW()) >= $${i}`);
        params.push(at); i++;
    }
    if (user) {
        conds.push(`(user_id = $${i} OR user_id LIKE '%|' || $${i})`);
        params.push(String(user)); i++;
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const col = IP_SORT_COLS[sort];
    const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    // Deterministic tiebreak by id so paging is stable when the sort key repeats.
    const orderBy = col ? `${col} ${d} NULLS LAST, id DESC` : `(released_at IS NULL) DESC, last_seen DESC, id DESC`;
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM ip_assignments ${where}`, params)).rows[0].n;
    const offset = (Math.max(1, page) - 1) * per_page;
    const r = await pool.query(
        `SELECT * FROM ip_assignments ${where} ORDER BY ${orderBy} LIMIT $${i} OFFSET $${i + 1}`,
        [...params, per_page, offset]
    );
    return {
        rows: r.rows.map(x => ({
            id: x.id, ip: x.ip, connectionIp: x.connection_ip || '',
            peerId: x.peer_id, peerName: x.peer_name || '', dnsLabel: x.dns_label || '',
            region: x.region || '', countryCode: x.country_code || '',
            userId: x.user_id || '', userName: x.user_name || '', userEmail: x.user_email || '',
            firstSeen: x.first_seen, lastSeen: x.last_seen, releasedAt: x.released_at || null,
        })),
        total, page, per_page, total_pages: Math.ceil(total / per_page),
    };
}

// Distinct users that appear in the IP history, for the page's user filter (audit-gated, so it
// can't reuse the activity-gated /logs/users list). Shaped like getDistinctUsers().
async function getIpHistoryUsers() {
    const r = await pool.query(`
        SELECT user_id, MAX(user_name) AS display_name, MAX(user_email) AS email
        FROM ip_assignments WHERE COALESCE(user_id, '') <> '' AND tenant = $1
        GROUP BY user_id ORDER BY display_name NULLS LAST, user_id
    `, [tnt()]).catch(() => ({ rows: [] }));
    return r.rows.map(x => ({ user_id: x.user_id, display_name: x.display_name || '', email: x.email || '' }));
}

// Shared WHERE builder for the events table - used by the detailed query AND the summary
// aggregation, so both views always filter identically (including viewer scoping).
function buildEventConds({ search, source, destination, type, protocol, from, to, user, exclude_addr, viewer_oid } = {}) {
    let conditions = [];
    let params = [];
    let paramIndex = 1;

    // Scope to the active account - main ('') or a tenant, identically. Applied first so every
    // events query built from this WHERE (detailed + summary) filters by tenant.
    conditions.push(`tenant = $${paramIndex}`);
    params.push(tnt());
    paramIndex++;

    // SSO: restrict a regular user to their own events. The event user_id is
    // "oauth2|azure-oauth2|<oid>", so match by exact id or by the oid suffix.
    if (viewer_oid) {
        conditions.push(`(user_id = $${paramIndex} OR user_id LIKE '%|' || $${paramIndex})`);
        params.push(viewer_oid);
        paramIndex++;
    }

    if (search) {
        conditions.push(`(
      source_name ILIKE $${paramIndex} OR
      destination_name ILIKE $${paramIndex} OR
      source_addr ILIKE $${paramIndex} OR
      destination_addr ILIKE $${paramIndex} OR
      source_dns_label ILIKE $${paramIndex} OR
      destination_dns_label ILIKE $${paramIndex} OR
      policy_name ILIKE $${paramIndex}
    )`);
        params.push(`%${search}%`);
        paramIndex++;
    }

    if (source) {
        conditions.push(`(
      source_name ILIKE $${paramIndex} OR
      source_addr ILIKE $${paramIndex} OR
      source_dns_label ILIKE $${paramIndex}
    )`);
        params.push(`%${source}%`);
        paramIndex++;
    }

    if (destination) {
        conditions.push(`(
      destination_name ILIKE $${paramIndex} OR
      destination_addr ILIKE $${paramIndex} OR
      destination_dns_label ILIKE $${paramIndex}
    )`);
        params.push(`%${destination}%`);
        paramIndex++;
    }

    if (type === 'P2P') {
        conditions.push(`destination_type = $${paramIndex}`);
        params.push('PEER');
        paramIndex++;
    } else if (type === 'Routed') {
        conditions.push(`destination_type = $${paramIndex}`);
        params.push('HOST_RESOURCE');
        paramIndex++;
    } else if (type === 'Proxy') {
        // Reverse-proxy (ingress) traffic has no explicit marker in NetBird's flow events - the
        // proxy participates as a regular peer. NetBird-managed ingress peers are always named
        // "proxy-<20-char id>", so match events where either side is such a peer.
        conditions.push(`(source_name ~* $${paramIndex} OR destination_name ~* $${paramIndex})`);
        params.push('^proxy-[a-z0-9]{16,}$');
        paramIndex++;
    }

    if (protocol) {
        conditions.push(`protocol = $${paramIndex}`);
        params.push(parseInt(protocol, 10));
        paramIndex++;
    }

    if (from) {
        conditions.push(`timestamp >= $${paramIndex}`);
        params.push(from);
        paramIndex++;
    }

    if (to) {
        conditions.push(`timestamp <= $${paramIndex}`);
        params.push(to);
        paramIndex++;
    }

    if (user) {
        conditions.push(`user_id = $${paramIndex}`);
        params.push(user);
        paramIndex++;
    }

    if (exclude_addr) {
        conditions.push(`(source_addr NOT ILIKE $${paramIndex} AND destination_addr NOT ILIKE $${paramIndex})`);
        params.push(`%${exclude_addr}%`);
        paramIndex++;
    }

    return { whereClause: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '', params, paramIndex };
}

// Column sort for the Activity views. Flows are grouped, so events sort at the FLOW
// level (an aggregate per group); summary sorts on its aggregate expressions. Both maps
// are fixed whitelists - user input selects an entry, it is never interpolated raw.
const EVENT_SORT_COLS = {
    time: 'MAX(timestamp)',
    source: `MAX(source_name)`,
    destination: `MAX(destination_name)`,
    protocol: 'MAX(protocol)',
    user: `MAX(user_id)`,
};
const SUMMARY_SORT_COLS = {
    source: 'MAX(source_name)',
    destination: 'MAX(destination_name)',
    connections: `COUNT(DISTINCT COALESCE(NULLIF(flow_id, ''), id))`,
    rx: 'COALESCE(SUM(rx_bytes), 0)',
    tx: 'COALESCE(SUM(tx_bytes), 0)',
    firstSeen: 'MIN(timestamp)',
    lastSeen: 'MAX(timestamp)',
};

async function queryEvents(opts) {
    const { page = 1, per_page = 10 } = opts || {};
    const { whereClause, params, paramIndex } = buildEventConds(opts);
    const sortCol = EVENT_SORT_COLS[opts && opts.sort] || null;
    const sortDir = String((opts && opts.dir) || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // The UI groups events that share a flow_id into ONE row (with expandable sub-events), so
    // both the total and the page window count FLOWS, not raw events - otherwise a "page of 10"
    // renders fewer rows and the footer over-counts. Group key: the flow_id, or the event's own
    // id when it has none (a solo event is its own group).
    const GKEY = `COALESCE(NULLIF(flow_id, ''), id)`;

    // CAPPED count - see cappedCount() in lib/core.js. The events table is multi-GB, so an exact
    // COUNT(DISTINCT flow) per page load scanned the whole filtered slice every time. Past the cap
    // the footer shows "50,000+"; narrowing the filters is the way to a precise number.
    const { total, totalCapped } = await cappedCount(
        // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- GKEY is a const SQL fragment defined above; whereClause is assembled by buildEventConds from fixed fragments with $n placeholders - every user value travels in `params`.
        `SELECT 1 FROM events ${whereClause} GROUP BY ${GKEY}`,
        params
    );

    // Page = the per_page most recent flows; then every matching event of those flows, ordered
    // by flow recency so the client-side grouping reassembles them in the same order. The peers
    // join resolves the router (reporter_id) name.
    const offset = (page - 1) * per_page;
    const dataParams = [...params, per_page, offset];
    // sortval is the whitelisted flow-level aggregate; ts stays the stable tiebreak so
    // grouped sub-events still reassemble under their flow in a deterministic order.
    const flowSort = sortCol ? `${sortCol} ` : 'MAX(timestamp) ';
    const dataResult = await pool.query(
        // The events table is read TWICE here (once aggregated into flows, once for the rows of the
        // chosen flows) instead of through one `matched` CTE referenced twice: a multiply-referenced
        // CTE is MATERIALIZED by Postgres, which spooled the entire filtered slice - raw_json and
        // all - into a tuplestore on every page load. Two plain scans of the same WHERE (identical
        // $n placeholders, same params array) let the planner use the indexes and keep the second
        // scan hash-joined to the 10-25 flows it actually needs.
        // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- GKEY/whereClause/flowSort/sortDir are internal fixed fragments (flowSort comes from the EVENT_SORT_COLS whitelist, sortDir is a two-value ternary); user values are parameterized via dataParams.
        `WITH flows AS (
             SELECT ${GKEY} AS gkey, MAX(timestamp) AS ts, ${flowSort} AS sortval
             FROM events ${whereClause}
             GROUP BY 1
             ORDER BY sortval ${sortDir} NULLS LAST, ts DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
         )
         SELECT e.*, p.name AS reporter_name
         FROM flows f
         JOIN (SELECT * FROM events ${whereClause}) e ON COALESCE(NULLIF(e.flow_id, ''), e.id) = f.gkey
         LEFT JOIN peers p ON p.tenant = e.tenant AND p.peer_id = e.reporter_id
         ORDER BY f.sortval ${sortDir} NULLS LAST, f.ts DESC, e.timestamp DESC`,
        dataParams
    );

    // Ingress peers ("proxy-<id>") → readable labels for display.
    const pmap = await proxyLabelMap();
    const events = dataResult.rows.map(r => ({
        ...r,
        source_name: resolveProxyPeerName(r.source_name, pmap),
        destination_name: resolveProxyPeerName(r.destination_name, pmap),
    }));

    return {
        events,
        total,
        totalCapped,
        page: parseInt(page, 10),
        per_page: parseInt(per_page, 10),
        total_pages: Math.ceil(total / per_page)
    };
}

async function getDistinctUsers() {
    // Return users with display names from the cache
    const result = await pool.query(`
        SELECT DISTINCT e.user_id, u.display_name, u.email, COALESCE(u.display_name, e.user_id) AS sort_name
        FROM events e
        LEFT JOIN users u ON u.tenant = e.tenant AND e.user_id = u.user_id
        WHERE e.user_id != '' AND e.tenant = $1
        ORDER BY sort_name
    `, [tnt()]);
    return result.rows.map(r => ({
        user_id: r.user_id,
        display_name: r.display_name || '',
        email: r.email || '',
    }));
}

async function getDistinctSources() {
    const result = await pool.query(
        `SELECT DISTINCT source_name FROM events WHERE source_name != '' AND tenant = $1 ORDER BY source_name`,
        [tnt()]
    );
    return result.rows.map(r => r.source_name);
}

// Traffic summary: the filtered events aggregated into one row per source→destination pair
// ("conversation"), so the log reads as WHO talked to WHAT instead of an event firehose.
// Uses the exact same filters/scoping as the detailed view (buildEventConds).
async function queryTrafficSummary(opts) {
    const { page = 1, per_page = 25 } = opts || {};
    const { whereClause, params, paramIndex } = buildEventConds(opts);
    const sumSort = SUMMARY_SORT_COLS[opts && opts.sort] || SUMMARY_SORT_COLS.lastSeen;
    const sumDir = String((opts && opts.dir) || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Pair keys: prefer the stable id; fall back to the address with the ephemeral :port
    // stripped (otherwise every source port would become its own "pair").
    const SRC = `COALESCE(NULLIF(source_id, ''), regexp_replace(source_addr, ':[0-9]+$', ''))`;
    const DST = `COALESCE(NULLIF(destination_id, ''), NULLIF(destination_name, ''), regexp_replace(destination_addr, ':[0-9]+$', ''))`;

    // CAPPED count of the pair groups - see cappedCount() in lib/core.js.
    const { total, totalCapped } = await cappedCount(
        // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- SRC/DST are const SQL fragments defined above; whereClause comes from buildEventConds (fixed fragments, $n placeholders); user values ride in `params`.
        `SELECT 1 FROM events ${whereClause} GROUP BY ${SRC}, ${DST}`,
        params
    );

    const offset = (Math.max(1, page) - 1) * per_page;
    const r = await pool.query(
        // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- SRC/DST/whereClause are internal fixed fragments (see above); user values are parameterized.
        `SELECT
            MAX(source_name) AS source_name,
            MAX(NULLIF(source_id, '')) AS source_id,
            MAX(source_dns_label) AS source_dns,
            regexp_replace(MAX(source_addr), ':[0-9]+$', '') AS source_host,
            MAX(destination_name) AS destination_name,
            MAX(NULLIF(destination_id, '')) AS destination_id,
            MAX(destination_dns_label) AS destination_dns,
            MAX(destination_type) AS destination_type,
            regexp_replace(MAX(destination_addr), ':[0-9]+$', '') AS destination_host,
            MAX(NULLIF(user_id, '')) AS user_id,
            MAX(source_geo_country) AS src_country, MAX(source_geo_city) AS src_city,
            MAX(destination_geo_country) AS dst_country, MAX(destination_geo_city) AS dst_city,
            COUNT(DISTINCT COALESCE(NULLIF(flow_id, ''), id))::int AS connections,
            COUNT(*)::int AS event_count,
            COALESCE(SUM(rx_bytes), 0)::bigint AS rx,
            COALESCE(SUM(tx_bytes), 0)::bigint AS tx,
            MIN(timestamp) AS first_seen,
            MAX(timestamp) AS last_seen,
            array_agg(DISTINCT substring(destination_addr from ':([0-9]+)$'))
                FILTER (WHERE destination_addr ~ ':[0-9]+$') AS ports,
            array_agg(DISTINCT protocol) AS protocols
         FROM events ${whereClause}
         GROUP BY ${SRC}, ${DST}
         ORDER BY ${sumSort} ${sumDir} NULLS LAST, MAX(timestamp) DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, per_page, offset]
    );

    const pmap = await proxyLabelMap();
    return {
        rows: r.rows.map(x => ({
            // sourceName/destinationName stay RAW - the expanded row and "jump to Detailed"
            // filter the DB by these values. The *Label fields are what the UI displays.
            sourceName: x.source_name || '', sourceId: x.source_id || null, sourceDns: x.source_dns || '', sourceHost: x.source_host || '',
            sourceLabel: resolveProxyPeerName(x.source_name || '', pmap),
            destinationLabel: resolveProxyPeerName(x.destination_name || '', pmap),
            destinationName: x.destination_name || '', destinationId: x.destination_id || null,
            destinationDns: x.destination_dns || '', destinationType: x.destination_type || '', destinationHost: x.destination_host || '',
            userId: x.user_id || '',
            sourceGeo: [x.src_country, x.src_city].filter(Boolean).join(', '),
            destinationGeo: [x.dst_country, x.dst_city].filter(Boolean).join(', '),
            connections: x.connections, eventCount: x.event_count,
            rx: Number(x.rx) || 0, tx: Number(x.tx) || 0,
            firstSeen: x.first_seen, lastSeen: x.last_seen,
            ports: (x.ports || []).filter(Boolean).sort((a, b) => Number(a) - Number(b)).slice(0, 12),
            protocols: (x.protocols || []).filter(p => p != null),
        })),
        total, totalCapped, page, per_page, total_pages: Math.ceil(total / per_page),
    };
}

// Scalar subqueries, same reasoning as getAdminStats(): earliest/latest become index probes on
// idx_events_tenant_ts rather than a full aggregate pass over the tenant's events.
async function getStats() {
    const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM events WHERE tenant = $1) AS total_events,
      (SELECT timestamp FROM events WHERE tenant = $1 ORDER BY timestamp ASC LIMIT 1) AS earliest,
      (SELECT timestamp FROM events WHERE tenant = $1 ORDER BY timestamp DESC LIMIT 1) AS latest
  `, [tnt()]);
    return result.rows[0];
}

// Events-per-hour for the dashboard chart: the last `hours` full hours (including empty ones,
// zero-filled here so the chart has a continuous axis). Restricted users get only their own.
async function getHourlyEventCounts({ viewerOid, hours = 24 } = {}) {
    const h = Math.min(Math.max(parseInt(hours, 10) || 24, 1), 168);
    const params = [tnt()];
    let where = `tenant = $1 AND timestamp >= date_trunc('hour', NOW()) - make_interval(hours => ${h - 1})`;
    if (viewerOid) {
        params.push(viewerOid);
        where += ` AND (user_id = $2 OR user_id LIKE '%|' || $2)`;
    }
    const r = await pool.query(
        // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- `where` is built above from fixed fragments; `h` is a clamped integer; tenant ($1) and viewerOid ($2) are parameterized.
        `SELECT date_trunc('hour', timestamp) AS hour, COUNT(*)::int AS count
         FROM events WHERE ${where} GROUP BY 1`,
        params
    );
    const byHour = new Map(r.rows.map(x => [new Date(x.hour).getTime(), x.count]));
    const out = [];
    const start = new Date(); start.setMinutes(0, 0, 0);
    for (let i = h - 1; i >= 0; i--) {
        const t = new Date(start.getTime() - i * 3600_000);
        out.push({ hour: t.toISOString(), count: byHour.get(t.getTime()) || 0 });
    }
    return out;
}

// ─── Event filtering rules + app settings (DB-backed; replaces env config) ───
// Per-account: filter_rules carries a `tenant` column and the built-in noise toggle is a keyed
// setting (`builtin_noise` for main, `builtin_noise:<tenant>` for a tenant), so every account
// filters its OWN webhook traffic by its OWN rules. The config cache is a Map keyed by account
// (10s TTL per slot); any rule/settings write clears the whole map (simple + always correct).
const _filterCache = new Map(); // account -> { at, cfg }

// Built-in noise toggle key for the active account (bare for main, suffixed for a tenant).
const builtinNoiseKey = () => (tnt() ? `builtin_noise:${tnt()}` : 'builtin_noise');

function invalidateFilterCache() { _filterCache.clear(); }

// Cached config used by the high-frequency webhook path (scoped to the active account).
async function getFilterConfig() {
    const acct = tnt();
    const slot = _filterCache.get(acct);
    if (slot && Date.now() - slot.at < 10000) return slot.cfg;
    const [rules, setting] = await Promise.all([
        pool.query('SELECT id, field, operator, value, enabled FROM filter_rules WHERE tenant = $1 ORDER BY sort_order, id', [acct]),
        pool.query('SELECT value FROM app_settings WHERE key = $1', [builtinNoiseKey()]),
    ]);
    const cfg = {
        rules: rules.rows,
        builtinNoise: setting.rows[0] ? setting.rows[0].value !== 'false' : true,
    };
    _filterCache.set(acct, { at: Date.now(), cfg });
    return cfg;
}

// Is the built-in broadcast/multicast noise filter enabled for the active account? (default: yes)
async function getBuiltinNoise() {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [builtinNoiseKey()]);
    return r.rows[0] ? r.rows[0].value !== 'false' : true;
}

// Persist the built-in noise toggle for the active account. setSetting fires onSettingChange,
// which is wired to invalidateFilterCache below - so the cache is busted automatically.
async function setBuiltinNoise(enabled) {
    await setSetting(builtinNoiseKey(), enabled ? 'true' : 'false');
}

async function getFilterRules() {
    const r = await pool.query('SELECT id, field, operator, value, enabled, sort_order FROM filter_rules WHERE tenant = $1 ORDER BY sort_order, id', [tnt()]);
    return r.rows;
}

async function createFilterRule({ field, operator, value, enabled }) {
    const r = await pool.query(
        `INSERT INTO filter_rules (tenant, field, operator, value, enabled, sort_order)
         VALUES ($5, $1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM filter_rules WHERE tenant = $5))
         RETURNING id, field, operator, value, enabled, sort_order`,
        [field, operator || 'contains', value || '', enabled !== false, tnt()]
    );
    invalidateFilterCache();
    return r.rows[0];
}

async function updateFilterRule(id, { field, operator, value, enabled }) {
    // AND tenant = $6 so an account can never mutate another account's rule id.
    const r = await pool.query(
        `UPDATE filter_rules SET field = COALESCE($2, field), operator = COALESCE($3, operator),
         value = COALESCE($4, value), enabled = COALESCE($5, enabled) WHERE id = $1 AND tenant = $6
         RETURNING id, field, operator, value, enabled, sort_order`,
        [id, field, operator, value, enabled, tnt()]
    );
    invalidateFilterCache();
    return r.rows[0];
}

async function deleteFilterRule(id) {
    await pool.query('DELETE FROM filter_rules WHERE id = $1 AND tenant = $2', [id, tnt()]);
    invalidateFilterCache();
}

// setSetting (lib/core.js) invalidates this cache after any settings write - the filter config is
// partly settings-backed (the builtin_noise flag). Register the invalidator here so the dependency
// stays one-way (events -> core) instead of core reaching back into this module.
onSettingChange(invalidateFilterCache);

// ─── Traffic noise filter evaluation (DB-backed rules; managed in Settings) ───
// Lives HERE, next to getFilterConfig, because there are now TWO ingestion paths that must drop
// exactly the same traffic: the webhook receiver in server.js and the opt-in API pull in db.js
// (db.js can never require server.js). One implementation = the two paths can't drift.
const PROTO_NAMES = { 1: 'icmp', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'esp', 58: 'icmpv6' };

// Pull the filterable fields out of a webhook traffic payload (the API pull is mapped into that
// same shape by mapApiTrafficEvent first, so it is filtered identically).
function eventFields(payload) {
    const m = payload.meta || {};
    const src = m.source_addr || '';
    const dst = m.destination_addr || '';
    return {
        source_addr: src,
        destination_addr: dst,
        source_name: m.source_name || '',
        destination_name: m.destination_name || '',
        protocol: PROTO_NAMES[Number(m.protocol)] || String(m.protocol || ''),
        direction: String(m.direction || '').toLowerCase(),
        port: dst.includes(':') ? dst.split(':').pop() : '',
    };
}

// Does a single value satisfy a rule's operator?
function ruleMatchesValue(rule, value) {
    if (value == null) return false;
    const hay = String(value).toLowerCase();
    const needle = String(rule.value).toLowerCase();
    if (!needle && rule.operator !== 'regex') return false;
    switch (rule.operator) {
        case 'equals': return hay === needle;
        case 'starts_with': return hay.startsWith(needle);
        case 'ends_with': return hay.endsWith(needle);
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the pattern is an admin-configured filter rule (not end-user input); input is length-bounded and the call is wrapped in try/catch so a bad/slow pattern can't run away.
        case 'regex': try { return new RegExp(rule.value, 'i').test(String(value).slice(0, 2000)); } catch { return false; }
        case 'contains':
        default: return hay.includes(needle);
    }
}

// Built-in broadcast / multicast noise (toggleable in Settings).
function isBuiltinNoise(dstAddr) {
    const a = String(dstAddr || '').trim();
    // IPv6 multicast (ff00::/8) - e.g. ff02::1 / ff02::2 NDP & router-solicitation noise, the
    // v6 equivalent of broadcast. The address may be bracketed and carry a :port ("[ff02::2]:0").
    const v6 = a.startsWith('[') && a.includes(']') ? a.slice(1, a.indexOf(']')) : a;
    if (/^ff[0-9a-f]{2}:/i.test(v6)) return true;
    // IPv4 broadcast / multicast.
    const dstIp = a.split(':')[0];
    if (dstIp === '255.255.255.255') return true;
    if (dstIp.endsWith('.255.255')) return true;
    const firstOctet = parseInt(dstIp.split('.')[0], 10);
    return firstOctet >= 224 && firstOctet <= 239;
}

// Evaluate one rule set against the already-extracted fields. Shared by the live-payload check
// and the stored-row check so "would this have been dropped?" is answered by one piece of code.
function fieldsMatchFilters(f, cfg) {
    if (cfg.builtinNoise && isBuiltinNoise(f.destination_addr)) return true;
    for (const rule of cfg.rules) {
        if (rule.enabled === false) continue;
        if (rule.field === 'any_addr') {
            if (ruleMatchesValue(rule, f.source_addr) || ruleMatchesValue(rule, f.destination_addr)) return true;
        } else if (ruleMatchesValue(rule, f[rule.field])) {
            return true;
        }
    }
    return false;
}

async function isNoiseTraffic(payload) {
    return fieldsMatchFilters(eventFields(payload), await getFilterConfig());
}

// Same filter evaluation, but for an ALREADY-STORED event row (the "purge garbage" tool).
// The stored columns already hold what eventFields() derives from a live webhook payload, so
// this matches ingestion exactly - a row matches iff it WOULD have been dropped on the way in.
function storedEventFields(row) {
    const dst = row.destination_addr || '';
    return {
        source_addr: row.source_addr || '',
        destination_addr: dst,
        source_name: row.source_name || '',
        destination_name: row.destination_name || '',
        protocol: PROTO_NAMES[Number(row.protocol)] || String(row.protocol || ''),
        direction: String(row.direction || '').toLowerCase(),
        port: dst.includes(':') ? dst.split(':').pop() : '',
    };
}

function eventMatchesFilters(row, cfg) {
    return fieldsMatchFilters(storedEventFields(row), cfg);
}

// ─── Stream / delete stored traffic events (the admin "purge garbage" tool) ───
// Keyset pagination over the events PK so the whole table can be scanned in batches without
// a costly OFFSET. `afterId` is the last id seen; '' starts from the beginning.
async function scanEvents(afterId, limit) {
    const r = await pool.query(
        `SELECT id, timestamp, message, source_name, source_addr, destination_name, destination_addr, protocol, direction
         FROM events WHERE tenant = $3 AND id > $1 ORDER BY id ASC LIMIT $2`,
        [afterId || '', limit, tnt()],
    );
    return r.rows;
}

async function deleteEventsByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const r = await pool.query('DELETE FROM events WHERE id = ANY($1) AND tenant = $2', [ids, tnt()]);
    return r.rowCount || 0;
}

module.exports = {
    addEvent, mapApiTrafficEvent, getAdminStats,
    isNoiseTraffic, eventMatchesFilters,
    IP_SORT_COLS, queryIpHistory, getIpHistoryUsers,
    buildEventConds, queryEvents, getDistinctUsers, getDistinctSources, queryTrafficSummary,
    getStats, getHourlyEventCounts,
    invalidateFilterCache, getFilterConfig, getBuiltinNoise, setBuiltinNoise, getFilterRules, createFilterRule, updateFilterRule, deleteFilterRule,
    scanEvents, deleteEventsByIds,
};
