// Event store + queries, extracted verbatim from db.js. All pure pool work over the events /
// admin_events / ip_assignments / filter_rules tables: ingest, the detailed + summary + IP-history
// + stats queries, the shared WHERE builder, the event filter-rules CRUD (+ its cache + the noise
// FILTER EVALUATION shared by both ingestion paths), the API-traffic-event → webhook-payload
// mapper, and the admin purge scan/delete. Requires only lib/core.js (events -> core, one-way; never db.js, no
// cycle). The domain-coupled event functions stay in db.js: addAdminEvent (Telegram notify),
// queryAdminEvents (NetBird category SQL), purgeOldEvents (retention/audit), getAuditLog, and
// syncIpAssignments (peers cache).

const { pool, onSettingChange, setSetting, cappedCount, capTotal } = require('./core');
// For resolving "proxy-<id>" ingress peer names to service/cluster names at read time, and the
// tenant ALS so every read/write here scopes to the active account (events -> netbird -> core,
// still one-way; netbird.js never requires events.js).
const { getReverseProxyStatus, currentTenantAccount, netbirdGet } = require('./netbird');
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

// ─── Endpoint type + flow state recovery ───
// NetBird's event stream (the webhook) started sending source_type / destination_type "UNKNOWN"
// for real peers and network resources, and Message "TYPE_UNKNOWN" with num_of_* counters. The
// endpoint ids are still correct, so the type is recovered from them: a network resource id gets
// its resource type, a peer id gets PEER. Without this the P2P and Routed filters stay empty.
// The stored raw_json always keeps the payload exactly as NetBird sent it.
const ROUTED_TYPES = ['HOST_RESOURCE', 'DOMAIN_RESOURCE', 'SUBNET_RESOURCE'];
const RESOURCE_TYPE_OF = { host: 'HOST_RESOURCE', subnet: 'SUBNET_RESOURCE', domain: 'DOMAIN_RESOURCE' };

// Per-account index of known endpoint ids: { peers: Set | null, resources: Map<id, type> | null }.
// ONLY the reclassify sweep fills it (inside forEachTenant, which verifies the tenant context), so
// ingestion never calls NetBird and can never pick up another account's resources. Each source is
// replaced only when it was read successfully; a failed read keeps the previous one.
const _typeIndex = new Map();
function setEndpointTypeIndex(tenant, { peers, resources } = {}) {
    const cur = _typeIndex.get(tenant) || { peers: null, resources: null };
    const next = { peers: peers || cur.peers, resources: resources || cur.resources };
    _typeIndex.set(tenant, next);
    return next;
}

// A real type from NetBird is kept as is (PEER, BROWSER_GATEWAY, ...). Only an empty or UNKNOWN
// type with a string id found in this account's index is replaced. Anything that is not a string
// is passed on exactly as before this recovery existed, and never classified.
function resolveEndpointType(id, given, idx) {
    if (given == null) given = ''; // a missing type is an unknown one
    if (typeof given !== 'string') return given || '';
    if (given && given !== 'UNKNOWN') return given;
    if (typeof id !== 'string' || !id || !idx) return given;
    const res = idx.resources && idx.resources.get(id);
    if (res) return res;
    if (idx.peers && idx.peers.has(id)) return 'PEER';
    return given;
}

// NetBird's resource list → Map<id, type>, or null when the response is not a list. Entries
// without a string id and a known type are skipped, so one odd entry never fails the whole read.
function parseResourceTypes(list) {
    if (!Array.isArray(list)) return null;
    const out = new Map();
    for (const r of list) {
        if (!r || typeof r.id !== 'string' || !r.id || typeof r.type !== 'string') continue;
        const key = r.type.toLowerCase();
        if (Object.hasOwn(RESOURCE_TYPE_OF, key)) out.set(r.id, RESOURCE_TYPE_OF[key]);
    }
    return out;
}

// A counter counts only as a whole number below 2^53, given as a JSON number or a digit string.
// Anything else counts as 0. The sweep applies the same pattern in SQL (POSITIVE_COUNTER_SQL), so
// a stored row is a candidate exactly when this function finds evidence in it.
const COUNTER_RE = /^(0|[1-9][0-9]{0,14})$/;
function counterValue(v) {
    const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : null;
    return s !== null && COUNTER_RE.test(s) ? Number(s) : 0;
}
// The flow state for a TYPE_UNKNOWN event, from its counters - the same rule mapApiTrafficEvent
// uses for API windows. null when no counter is positive: then there is no evidence and the
// stored value stays TYPE_UNKNOWN.
function deriveTrafficMessage(meta) {
    const m = meta || {};
    const starts = counterValue(m.num_of_starts), ends = counterValue(m.num_of_ends), drops = counterValue(m.num_of_drops);
    if (drops > 0) return 'TYPE_DROP';
    if (ends > 0 && starts === 0) return 'TYPE_END';
    if (starts > 0 || ends > 0) return 'TYPE_START';
    return null;
}

async function addEvent(payload) {
    const meta = payload.meta || {};
    const idx = _typeIndex.get(tnt());
    const message = payload.Message === 'TYPE_UNKNOWN' ? (deriveTrafficMessage(meta) || payload.Message) : payload.Message;
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
        message,
        payload.InitiatorID || '',
        payload.target_id || '',
        meta.flow_id || '',
        meta.protocol || 0,
        meta.direction || '',
        meta.source_addr || '',
        meta.source_name || '',
        meta.source_dns_label || '',
        meta.source_id || '',
        resolveEndpointType(meta.source_id, meta.source_type, idx),
        meta.source_geo_country || '',
        meta.source_geo_city || '',
        meta.destination_addr || '',
        meta.destination_name || '',
        meta.destination_dns_label || '',
        meta.destination_id || '',
        resolveEndpointType(meta.destination_id, meta.destination_type, idx),
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
        // Every network resource kind is routed through a routing peer, not only single hosts.
        conditions.push(`destination_type = ANY($${paramIndex})`);
        params.push(ROUTED_TYPES);
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
    // A cancellable request passes its own client (see opts.db); everything else uses the pool.
    const db = (opts && opts.db) || pool;

    // Page = the per_page most recent flows; then every matching event of those flows, ordered
    // by flow recency so the client-side grouping reassembles them in the same order. The peers
    // join resolves the router (reporter_id) name.
    const offset = (page - 1) * per_page;
    const dataParams = [...params, per_page, offset];
    // sortval is the whitelisted flow-level aggregate; ts stays the stable tiebreak so
    // grouped sub-events still reassemble under their flow in a deterministic order.
    const flowSort = sortCol ? `${sortCol} ` : 'MAX(timestamp) ';
    // The flow total comes from the same aggregation as the page: COUNT(*) OVER () runs after
    // GROUP BY and before LIMIT, so it counts every flow at the cost of a small window over the
    // grouped rows. A separate count query read the whole filtered slice from disk a second time.
    const dataResult = await db.query(
        // The events table is read TWICE here (once aggregated into flows, once for the rows of the
        // chosen flows) instead of through one `matched` CTE referenced twice: a multiply-referenced
        // CTE is MATERIALIZED by Postgres, which spooled the entire filtered slice - raw_json and
        // all - into a tuplestore on every page load. Two plain scans of the same WHERE (identical
        // $n placeholders, same params array) let the planner use the indexes and keep the second
        // scan hash-joined to the 10-25 flows it actually needs.
        // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- GKEY/whereClause/flowSort/sortDir are internal fixed fragments (flowSort comes from the EVENT_SORT_COLS whitelist, sortDir is a two-value ternary); user values are parameterized via dataParams.
        `WITH flows AS (
             SELECT ${GKEY} AS gkey, MAX(timestamp) AS ts, ${flowSort} AS sortval,
                    COUNT(*) OVER () AS flow_total
             FROM events ${whereClause}
             GROUP BY 1
             ORDER BY sortval ${sortDir} NULLS LAST, ts DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
         )
         SELECT e.*, p.name AS reporter_name, f.flow_total AS _flow_total
         FROM flows f
         JOIN (SELECT * FROM events ${whereClause}) e ON COALESCE(NULLIF(e.flow_id, ''), e.id) = f.gkey
         LEFT JOIN peers p ON p.tenant = e.tenant AND p.peer_id = e.reporter_id
         ORDER BY f.sortval ${sortDir} NULLS LAST, f.ts DESC, e.timestamp DESC`,
        dataParams
    );

    // Past the cap the footer shows "50,000+", as before. A page past the last flow has no row to
    // carry the window count, so only then is the total counted on its own.
    const { total, totalCapped } = dataResult.rows.length
        ? capTotal(Number(dataResult.rows[0]._flow_total) || 0)
        : offset > 0
            ? await cappedCount(
                // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- GKEY is a const SQL fragment defined above; whereClause is assembled by buildEventConds from fixed fragments with $n placeholders - every user value travels in `params`.
                `SELECT 1 FROM events ${whereClause} GROUP BY ${GKEY}`,
                params, db)
            : { total: 0, totalCapped: false };

    // Ingress peers ("proxy-<id>") → readable labels for display.
    const pmap = await proxyLabelMap();
    const events = dataResult.rows.map(({ _flow_total, ...r }) => ({
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
    // The users that appear in the account's events, with display names from the users cache.
    // A plain DISTINCT walked every event the account ever had (about a million rows for a few
    // dozen users). Postgres 17 has no skip scan, so this walks idx_events_tenant_user_ts one
    // distinct user_id at a time instead: each step is one index probe for the next larger id.
    // The walk includes '' (events with no user) and the outer WHERE drops it, as before.
    const result = await pool.query(`
        WITH RECURSIVE ids AS (
            (SELECT user_id FROM events WHERE tenant = $1 AND user_id IS NOT NULL ORDER BY user_id LIMIT 1)
            UNION ALL
            SELECT (SELECT e.user_id FROM events e
                    WHERE e.tenant = $1 AND e.user_id > ids.user_id
                    ORDER BY e.user_id LIMIT 1)
            FROM ids WHERE ids.user_id IS NOT NULL
        )
        SELECT DISTINCT i.user_id, u.display_name, u.email, COALESCE(u.display_name, i.user_id) AS sort_name
        FROM ids i
        LEFT JOIN users u ON u.tenant = $1 AND u.user_id = i.user_id
        WHERE i.user_id IS NOT NULL AND i.user_id != ''
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

    const db = (opts && opts.db) || pool;
    const offset = (Math.max(1, page) - 1) * per_page;
    // pair_total counts every pair in the same pass as the page (see queryEvents): a separate
    // count query read the whole filtered slice from disk a second time.
    const r = await db.query(
        // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- SRC/DST/whereClause are internal fixed fragments (see above); user values are parameterized.
        `SELECT
            MAX(source_name) AS source_name,
            MAX(NULLIF(source_id, '')) AS source_id,
            MAX(source_dns_label) AS source_dns,
            regexp_replace(MAX(source_addr), ':[0-9]+$', '') AS source_host,
            MAX(destination_name) AS destination_name,
            MAX(NULLIF(destination_id, '')) AS destination_id,
            MAX(destination_dns_label) AS destination_dns,
            -- A known type wins over UNKNOWN or empty in the same pair (plain MAX would pick UNKNOWN).
            COALESCE(MAX(NULLIF(NULLIF(destination_type, 'UNKNOWN'), '')), MAX(destination_type)) AS destination_type,
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
            -- The FILTER keeps only addresses ending in ":<digits>", so the text after the last
            -- ':' is exactly that port. split_part costs a fraction of a capture-group
            -- substring(... from ':([0-9]+)$'), which was most of this query's CPU time.
            array_agg(DISTINCT split_part(destination_addr, ':', -1))
                FILTER (WHERE destination_addr ~ ':[0-9]+$') AS ports,
            array_agg(DISTINCT protocol) AS protocols,
            COUNT(*) OVER () AS pair_total
         FROM events ${whereClause}
         GROUP BY ${SRC}, ${DST}
         ORDER BY ${sumSort} ${sumDir} NULLS LAST, MAX(timestamp) DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, per_page, offset]
    );

    // Capped like every log list. Only a page past the last pair has no row to carry the count.
    const { total, totalCapped } = r.rows.length
        ? capTotal(Number(r.rows[0].pair_total) || 0)
        : offset > 0
            ? await cappedCount(
                // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- SRC/DST are const SQL fragments defined above; whereClause comes from buildEventConds (fixed fragments, $n placeholders); user values ride in `params`.
                `SELECT 1 FROM events ${whereClause} GROUP BY ${SRC}, ${DST}`,
                params, db)
            : { total: 0, totalCapped: false };

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
    regexStrikes.delete(regexRuleKey(tnt(), id));
    return r.rows[0];
}

async function deleteFilterRule(id) {
    await pool.query('DELETE FROM filter_rules WHERE id = $1 AND tenant = $2', [id, tnt()]);
    invalidateFilterCache();
    regexStrikes.delete(regexRuleKey(tnt(), id));
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

// Does a single value satisfy a rule's operator? (Regex rules run in a worker, see below.)
function ruleMatchesValue(rule, value) {
    if (value == null) return false;
    const hay = String(value).toLowerCase();
    const needle = String(rule.value).toLowerCase();
    if (!needle) return false;
    switch (rule.operator) {
        case 'equals': return hay === needle;
        case 'starts_with': return hay.startsWith(needle);
        case 'ends_with': return hay.endsWith(needle);
        case 'contains':
        default: return hay.includes(needle);
    }
}

// ─── Regex rules: compiled and run in a worker thread, under a time limit ───
// A pattern can take very long to compile or match, and the main thread can't interrupt that,
// so regex rules never run here. All regex rules for one event go to lib/regex-worker.js as a
// single request; when the request runs over REGEX_BUDGET_MS the event counts as not matched
// (it is kept), the worker is replaced, and the rule that was running gets a strike. A rule
// with two strikes is skipped for that account for REGEX_SKIP_MS and logged once.
const path = require('path');
const { Worker } = require('worker_threads');

const REGEX_BUDGET_MS = 25;            // per event, all of its regex rules together
const REGEX_SLOW_MS = 10;              // one rule evaluation this slow is a strike
const REGEX_STRIKES = 2;               // two, so a single pause (e.g. GC) never skips a rule
const REGEX_SKIP_MS = 10 * 60 * 1000;
const REGEX_MAX_QUEUE = 1000;          // waiting events beyond this count as not matched
const REGEX_MAX_THREADS = 3;           // live worker threads, including ones still shutting down
const REGEX_MAX_KNOWN = 2000;          // rule patterns cached by one worker before it is recycled
const REGEX_START_MS = 5000;           // a worker not ready by then is replaced

const regexRuleKey = (account, id) => `${account}\n${id}`;
// Rule key -> Map(pattern -> { strikes, until }). Per pattern, so an evaluation from an older
// rule snapshot can only add strikes to that older pattern.
const regexStrikes = new Map();

function regexSkipped(job) {
    const e = regexStrikes.get(job.key)?.get(job.pattern);
    return !!e && e.strikes >= REGEX_STRIKES && e.until > Date.now();
}

function regexStrike(job) {
    const now = Date.now();
    for (const [key, byPattern] of regexStrikes) {
        for (const [p, e] of byPattern) if (e.until <= now) byPattern.delete(p);
        if (!byPattern.size) regexStrikes.delete(key);
    }
    if (!regexStrikes.has(job.key)) regexStrikes.set(job.key, new Map());
    const byPattern = regexStrikes.get(job.key);
    const e = byPattern.get(job.pattern) || { strikes: 0, until: 0 };
    e.strikes++;
    e.until = now + REGEX_SKIP_MS;
    byPattern.set(job.pattern, e);
    if (e.strikes === REGEX_STRIKES) {
        console.warn(`Filter rule #${job.id}${job.account ? ` (account ${job.account})` : ''}: the regex is too slow and is skipped for ${REGEX_SKIP_MS / 60000} minutes`);
    }
}

let regexThreads = 0;   // live worker threads
let regexWorker = null; // { worker, online, known: Map(rule key -> pattern sent) }
let regexInflight = null;
let regexSeq = 0;
let regexQueueFullLoggedAt = 0;
const regexQueue = [];

function spawnRegexWorker() {
    const worker = new Worker(path.join(__dirname, 'regex-worker.js'));
    const rw = { worker, online: false, known: new Map() };
    regexThreads++;
    // A worker that never reports ready is replaced, so queued events are never stuck on it.
    const startTimer = setTimeout(() => { if (!rw.online) retireRegexWorker(rw); }, REGEX_START_MS);
    startTimer.unref();
    worker.on('message', (m) => {
        if (m.ready) {
            rw.online = true;
            clearTimeout(startTimer);
            if (regexInflight && regexInflight.rw === rw) armRegexDeadline();
        } else if (regexInflight && regexInflight.rw === rw && m.seq === regexInflight.seq) {
            // The reply can be read after the time limit when the main thread was busy; it counts
            // only if the worker's own run of the request stayed within the limit.
            finishRegexRequest(m.hit && m.ms <= REGEX_BUDGET_MS);
        }
    });
    worker.on('error', (err) => {
        console.error('Regex filter worker error:', err.message);
        retireRegexWorker(rw);
    });
    worker.on('exit', () => {
        regexThreads--;
        if (regexWorker === rw) regexWorker = null;
        if (regexInflight && regexInflight.rw === rw) finishRegexRequest(false);
        pumpRegexQueue();
    });
    worker.unref(); // only referenced while it has a request (see pumpRegexQueue)
    return rw;
}

function retireRegexWorker(rw) {
    if (regexWorker === rw) regexWorker = null;
    rw.retired = true;
    // terminate() keeps the worker referenced until it exits, so queued events waiting for a free
    // thread are never abandoned.
    rw.worker.terminate().catch(() => {});
}

// Strike every rule of the in-flight request that was slow: finished ones by duration, and the
// one still running (if any) by how long it has been running.
function strikeSlowRegexJobs(req) {
    const counters = new Int32Array(req.state, 0, 2);
    const times = new Float64Array(req.state, 8);
    const started = Atomics.load(counters, 0);
    const finished = Atomics.load(counters, 1);
    for (let i = 0; i < finished; i++) if (times[2 * i + 1] >= REGEX_SLOW_MS) regexStrike(req.jobs[i]);
    if (started > finished && Date.now() - times[2 * (started - 1)] >= REGEX_SLOW_MS) regexStrike(req.jobs[started - 1]);
}

function armRegexDeadline() {
    const req = regexInflight;
    req.timer = setTimeout(() => {
        if (regexInflight !== req) return;
        retireRegexWorker(req.rw);
        finishRegexRequest(false);
    }, REGEX_BUDGET_MS);
}

function finishRegexRequest(hit) {
    const req = regexInflight;
    regexInflight = null;
    clearTimeout(req.timer);
    strikeSlowRegexJobs(req);
    if (!req.rw.retired) req.rw.worker.unref();
    req.resolve(hit);
    pumpRegexQueue();
}

function pumpRegexQueue() {
    while (!regexInflight && regexQueue.length) {
        if (regexWorker && regexWorker.known.size > REGEX_MAX_KNOWN) retireRegexWorker(regexWorker);
        if (!regexWorker) {
            if (regexThreads >= REGEX_MAX_THREADS) return; // resumes when a thread exits
            try {
                regexWorker = spawnRegexWorker();
            } catch (err) {
                console.error('Regex filter worker could not start:', err.message);
                for (const waiting of regexQueue.splice(0)) waiting.resolve(false);
                return;
            }
        }
        const next = regexQueue.shift();
        // Rules skipped while this event waited are left out.
        const jobs = next.jobs.filter((j) => !regexSkipped(j));
        if (!jobs.length) { next.resolve(false); continue; }
        const rw = regexWorker;
        const msg = jobs.map((j) => {
            if (rw.known.get(j.key) === j.pattern) return { key: j.key, value: j.value };
            rw.known.set(j.key, j.pattern);
            return { key: j.key, pattern: j.pattern, value: j.value };
        });
        const state = new SharedArrayBuffer(8 + 16 * jobs.length);
        regexInflight = { rw, seq: ++regexSeq, jobs, state, resolve: next.resolve, timer: null };
        rw.worker.ref();
        rw.worker.postMessage({ seq: regexInflight.seq, jobs: msg, state });
        // Worker start-up never counts against a rule: the clock starts once it is ready.
        if (rw.online) armRegexDeadline();
    }
}

// Does any of these regex jobs match? Resolves false when the time limit is reached.
function runRegexJobs(jobs) {
    if (regexQueue.length >= REGEX_MAX_QUEUE) {
        if (Date.now() - regexQueueFullLoggedAt > 60000) {
            regexQueueFullLoggedAt = Date.now();
            console.warn('Regex filter rules are falling behind; some events are kept without regex filtering');
        }
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        regexQueue.push({ jobs, resolve });
        pumpRegexQueue();
    });
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
// The result is an OR over the rules, so regex rules can run after the others, in one request.
async function fieldsMatchFilters(f, cfg) {
    if (cfg.builtinNoise && isBuiltinNoise(f.destination_addr)) return true;
    const account = tnt();
    const regexJobs = [];
    for (const rule of cfg.rules) {
        if (rule.enabled === false) continue;
        const values = rule.field === 'any_addr' ? [f.source_addr, f.destination_addr] : [f[rule.field]];
        if (rule.operator === 'regex') {
            const job = { key: regexRuleKey(account, rule.id), account, id: rule.id, pattern: String(rule.value) };
            if (regexSkipped(job)) continue;
            for (const v of values) if (v != null) regexJobs.push({ ...job, value: String(v).slice(0, 2000) });
        } else if (values.some((v) => ruleMatchesValue(rule, v))) {
            return true;
        }
    }
    return regexJobs.length > 0 && runRegexJobs(regexJobs);
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

// ─── Reclassify sweep: fix stored rows with an UNKNOWN type or TYPE_UNKNOWN state ───
// Runs per account (forEachTenant) after boot and on a fixed interval. It picks rows by their
// STATE, never by time: a row is fixed on the first run where its id is known, however old it
// is, and a run cut short (time budget, restart, lock) simply leaves the rest to the next run.
// Each candidate predicate below is also the WHERE clause of a partial index in LOG_INDEXES
// (db.js), so the sweep reads only rows it can fix; the texts must stay identical.
const DST_UNRESOLVED_SQL = `destination_type IN ('', 'UNKNOWN') AND destination_id <> ''`;
const SRC_UNRESOLVED_SQL = `source_type IN ('', 'UNKNOWN') AND source_id <> ''`;
const POSITIVE_COUNTER_SQL = `'^[1-9][0-9]{0,14}$'`;
const MSG_UNKNOWN_SQL = `message = 'TYPE_UNKNOWN' AND (`
    + `(raw_json->'meta'->>'num_of_starts') ~ ${POSITIVE_COUNTER_SQL}`
    + ` OR (raw_json->'meta'->>'num_of_ends') ~ ${POSITIVE_COUNTER_SQL}`
    + ` OR (raw_json->'meta'->>'num_of_drops') ~ ${POSITIVE_COUNTER_SQL})`;
const EVENT_TYPE_INDEXES = [
    { name: 'idx_events_dst_unresolved', table: 'events', cols: `(tenant, destination_id) WHERE ${DST_UNRESOLVED_SQL}` },
    { name: 'idx_events_src_unresolved', table: 'events', cols: `(tenant, source_id) WHERE ${SRC_UNRESOLVED_SQL}` },
    { name: 'idx_events_msg_unknown', table: 'events', cols: `(tenant, id) WHERE ${MSG_UNKNOWN_SQL}` },
];

const SWEEP_BATCH = 1000;
const SWEEP_PHASE_BUDGET_MS = 20000; // per phase, so a busy phase never starves the next one
// Namespace for the per-account advisory lock (pg_try_advisory_lock(int, int) = (namespace, account)).
const SWEEP_LOCK_NS = 0x4e425431;

// Read this account's peer ids (local mirror) and network resource ids (NetBird API) into the
// index ingestion uses. The two sources are independent: one failing never blocks the other.
async function loadEndpointTypeIndex() {
    const t = tnt();
    let peers = null, resources = null;
    try {
        const r = await pool.query('SELECT peer_id FROM peers WHERE tenant = $1', [t]);
        peers = new Set(r.rows.map(x => String(x.peer_id)));
    } catch (e) {
        console.error('[EventTypes] peers read failed:', e.message);
    }
    try {
        resources = parseResourceTypes(await netbirdGet('/api/networks/resources'));
    } catch (e) {
        console.error('[EventTypes] resources read failed:', e.message);
    }
    return setEndpointTypeIndex(t, { peers, resources });
}

async function eventTypeIndexesValid() {
    const names = EVENT_TYPE_INDEXES.map(i => i.name);
    const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname = ANY($1) AND i.indisvalid`, [names]);
    return r.rows[0].n === names.length;
}

// One short transaction with bounded waits: a batch never queues behind a long lock and never
// runs long itself. Returns the number of rows changed.
async function shortTx(fn) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '5s'`);
        await c.query(`SET LOCAL statement_timeout = '30s'`);
        const n = await fn(c);
        await c.query('COMMIT');
        return n;
    } catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        throw e;
    } finally {
        c.release();
    }
}

// Set <side>_type for rows whose id is in `known` (Map id → type). SKIP LOCKED leaves rows another
// writer holds to a later batch; a fixed row leaves the partial index, so every batch progresses.
async function reclassifyTypeColumn(side, known, deadline) {
    if (!known.size) return 0;
    const col = side === 'destination' ? 'destination_type' : 'source_type';
    const idc = side === 'destination' ? 'destination_id' : 'source_id';
    const ids = [...known.keys()], types = [...known.values()];
    let total = 0;
    while (Date.now() < deadline) {
        const n = await shortTx(async (c) => (await c.query(
            // The inner WHERE is DST_/SRC_UNRESOLVED_SQL with the e. alias, so the partial index applies.
            // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- col/idc are fixed internal column names chosen above; values are parameterized.
            // LATERAL = one (tenant, id) index probe per known id, so rows with ids nobody knows
            // (deleted peers/resources) are never read, however many pile up.
            `WITH m AS (SELECT * FROM unnest($2::text[], $3::text[]) AS m(id, type)),
                  b AS (SELECT x.tenant, x.id, m.type FROM m CROSS JOIN LATERAL (
                            SELECT e.tenant, e.id FROM events e
                            WHERE e.tenant = $1 AND e.${idc} = m.id AND e.${col} IN ('', 'UNKNOWN') AND e.${idc} <> ''
                            LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED) x
                        LIMIT ${SWEEP_BATCH})
             UPDATE events e SET ${col} = b.type FROM b WHERE e.tenant = b.tenant AND e.id = b.id`,
            [tnt(), ids, types])).rowCount);
        total += n;
        if (n < SWEEP_BATCH) break;
    }
    return total;
}

// Replace TYPE_UNKNOWN with the state its counters show. Candidates are exactly the rows with a
// positive counter, so each batch fixes every row it reads.
async function reclassifyMessages(deadline) {
    let total = 0;
    while (Date.now() < deadline) {
        const n = await shortTx(async (c) => {
            const r = await c.query(
                // nosemgrep: javascript.lang.security.audit.sqli.node-postgres-sqli.node-postgres-sqli -- MSG_UNKNOWN_SQL is a fixed internal fragment; values are parameterized.
                `SELECT id, raw_json->'meta'->>'num_of_starts' AS s, raw_json->'meta'->>'num_of_ends' AS en,
                        raw_json->'meta'->>'num_of_drops' AS d
                 FROM events WHERE tenant = $1 AND ${MSG_UNKNOWN_SQL}
                 LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED`, [tnt()]);
            const ids = [], msgs = [];
            for (const row of r.rows) {
                const msg = deriveTrafficMessage({ num_of_starts: row.s, num_of_ends: row.en, num_of_drops: row.d });
                if (msg) { ids.push(row.id); msgs.push(msg); }
            }
            if (!ids.length) return 0;
            await c.query(
                `UPDATE events e SET message = m.msg FROM unnest($2::text[], $3::text[]) AS m(id, msg)
                 WHERE e.tenant = $1 AND e.id = m.id AND e.message = 'TYPE_UNKNOWN'`,
                [tnt(), ids, msgs]);
            return r.rows.length;
        });
        total += n;
        if (n < SWEEP_BATCH) break;
    }
    return total;
}

// The per-account sweep. Refreshes the index first (ingestion benefits even when the partial
// indexes are not built yet), then fixes stored rows only when those indexes are valid, so it
// never falls back to a full scan of the events table. One run per account at a time across
// every app instance (advisory lock on a dedicated connection).
async function reclassifyEventTypes() {
    const idx = await loadEndpointTypeIndex();
    if (!(await eventTypeIndexesValid())) return { skipped: 'indexes' };
    const t = tnt();
    const lockClient = await pool.connect();
    let unlockError = null;
    try {
        const got = (await lockClient.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [SWEEP_LOCK_NS, t])).rows[0].ok;
        if (!got) return { skipped: 'locked' };
        try {
            const known = new Map();
            if (idx && idx.peers) for (const id of idx.peers) known.set(id, 'PEER');
            if (idx && idx.resources) for (const [id, type] of idx.resources) known.set(id, type);
            const out = {
                destination: await reclassifyTypeColumn('destination', known, Date.now() + SWEEP_PHASE_BUDGET_MS),
                source: await reclassifyTypeColumn('source', known, Date.now() + SWEEP_PHASE_BUDGET_MS),
                message: await reclassifyMessages(Date.now() + SWEEP_PHASE_BUDGET_MS),
            };
            if (out.destination || out.source || out.message) {
                console.log(`[EventTypes] ${t || 'main'}: fixed ${out.destination} destination types, ${out.source} source types, ${out.message} states`);
            }
            return out;
        } finally {
            await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2))', [SWEEP_LOCK_NS, t]).catch(e => { unlockError = e; });
        }
    } finally {
        // A connection that may still hold the lock must not go back to the pool.
        lockClient.release(unlockError || undefined);
    }
}

module.exports = {
    addEvent, mapApiTrafficEvent, getAdminStats,
    ROUTED_TYPES, resolveEndpointType, parseResourceTypes, deriveTrafficMessage, counterValue, setEndpointTypeIndex,
    EVENT_TYPE_INDEXES, reclassifyEventTypes,
    isNoiseTraffic, eventMatchesFilters,
    IP_SORT_COLS, queryIpHistory, getIpHistoryUsers,
    buildEventConds, queryEvents, getDistinctUsers, getDistinctSources, queryTrafficSummary,
    getStats, getHourlyEventCounts,
    invalidateFilterCache, getFilterConfig, getBuiltinNoise, setBuiltinNoise, getFilterRules, createFilterRule, updateFilterRule, deleteFilterRule,
    scanEvents, deleteEventsByIds,
};
