// Automations engine, extracted verbatim from db.js: external HTTP source → auto-provisioned
// NetBird resources. Owns the automations CRUD, the source poller (fetch/map/validate), the
// test + dry-run diagnostics, and the sync engine (runAutomation / runDueAutomations), plus the
// two resource helpers used exclusively by automations (resourceHasGroups, setResourceNameFrom).
//
// Dependencies are one-way: lib/automations.js -> lib/{core,http,netbird,blocklist}.js, never
// db.js. The domain functions the sync engine needs (createClientResource, deleteResource,
// setResourceEnabled, addResourceGroups, getNetworkDetail, listAccessProfiles, recordAudit) stay
// in db.js and are injected once via initAutomations(deps), called from db.js at load time before
// any automation runs. Hoisted function declarations make those bindings safe to reference at
// runtime even though they're assigned after this module is required.

const { pool } = require('./core');
const { httpJson } = require('./http');
const { netbirdApiConfigured, netbirdReq, bustNbCaches, currentTenantAccount } = require('./netbird');
const { getBlocklist, addressBlockedForNetwork, addressesOverlap, addressesEquivalent } = require('./blocklist');

// DB scope of the current context: '' = main account, else the active tenant. Every automations
// table carries a `tenant` column; each query filters on tnt() so a tenant's automations, their
// managed-resource ledger and run history can never surface under - or be mutated by - another.
const tnt = () => currentTenantAccount() || '';

// Domain functions that stay in db.js (they call setResourceEnabled/deleteResource/getNetworkDetail
// /createClientResource/addResourceGroups/listAccessProfiles/recordAudit, which are domain-coupled).
// db.js injects them once via initAutomations; the sync engine references them by these bindings.
let listAccessProfiles, getNetworkDetail, addResourceGroups, setResourceEnabled, createClientResource, deleteResource, recordAudit, getDupAllowedNetworkIds;
function initAutomations(deps) {
    ({ listAccessProfiles, getNetworkDetail, addResourceGroups, setResourceEnabled, createClientResource, deleteResource, recordAudit, getDupAllowedNetworkIds } = deps);
}

// Find an existing UNMANAGED resource this source item should ADOPT: exact address hit
// first, then an EQUIVALENT one - the same host written differently (1.2.3.4 vs
// 1.2.3.4/32). Without the equivalence pass, such items tried to CREATE and died on the
// uniqueness guard instead of adopting.
function findAdoptable(address, existingByAddr, ownResourceIds) {
    const exact = existingByAddr.get(address);
    if (exact && !ownResourceIds.has(exact.id)) return exact;
    for (const r of existingByAddr.values()) {
        if (r && r.address && !ownResourceIds.has(r.id) && addressesEquivalent(address, String(r.address))) return r;
    }
    return null;
}

// True if `res` (a resource from getNetworkDetail) already belongs to every wanted group.
function resourceHasGroups(res, wantGroupIds) {
    const have = new Set((res && Array.isArray(res.groups) ? res.groups : []).map(g => (g && g.id) || g).filter(Boolean));
    return (wantGroupIds || []).every(g => have.has(g));
}

// True if a ledger row's resource is off: the removal mode disabled it ('disabled'), or it was
// already disabled when adopted ('adopted-disabled') and still is (`live` = the resource from
// getNetworkDetail, missing if it's gone).
function ledgerRowOff(own, live) {
    if (own.status === 'disabled') return true;
    return own.status === 'adopted-disabled' && !(live && live.enabled !== false);
}

// Update an existing resource's name/description from the source, preserving its
// address, groups and enabled state. `current` is the resource as returned by getNetworkDetail.
async function setResourceNameFrom(networkId, current, name, description) {
    const groups = Array.isArray(current.groups) ? current.groups.map(g => (g && g.id) || g).filter(Boolean) : [];
    const body = {
        name, address: current.address,
        description: description || current.description || '',
        enabled: current.enabled !== false, groups,
    };
    const resp = await netbirdReq('PUT', `/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(current.id)}`, body);
    if (!resp || resp.status >= 300) throw new Error('Failed to rename resource: ' + (resp && (resp.raw || resp.error || resp.status)));
    bustNbCaches('policies');
    return resp.body;
}

// ─── Automations: external HTTP source → auto-provisioned NetBird resources ───

// httpJson (the generic JSON HTTP request used to poll the external source) lives in
// lib/http.js and is imported at the top of this file.

// Walk a dot-path (e.g. "data.results") into a parsed JSON object; empty = the object itself.
function dig(obj, path) {
    if (!path) return obj;
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function normalizeAutomationCfg(cfg) {
    const c = cfg || {};
    const authType = ['none', 'bearer', 'header'].includes(c.authType) ? c.authType : 'none';
    const removalMode = ['disable', 'none', 'delete'].includes(c.removalMode) ? c.removalMode : 'disable';
    let iv = parseInt(c.intervalMinutes, 10); if (!Number.isFinite(iv) || iv < 0) iv = 0;
    let mi = parseInt(c.minItems, 10); if (!Number.isFinite(mi) || mi < 0) mi = 0;
    return {
        name: String(c.name || '').trim(),
        enabled: c.enabled !== false,
        endpointUrl: String(c.endpointUrl || '').trim(),
        authType, authHeader: String(c.authHeader || '').trim(),
        secret: c.secret,
        sourceFormat: c.sourceFormat === 'text' ? 'text' : 'json',
        namePrefix: String(c.namePrefix || ''),
        itemsPath: String(c.itemsPath || '').trim(),
        addressField: String(c.addressField || '').trim(),
        nameField: String(c.nameField || '').trim(),
        descriptionField: String(c.descriptionField || '').trim(),
        keyField: String(c.keyField || '').trim(),
        networkId: String(c.networkId || '').trim(),
        profileIds: Array.isArray(c.profileIds) ? c.profileIds.map(Number).filter(n => Number.isInteger(n)) : [],
        intervalMinutes: iv,
        removalMode,
        minItems: mi,
    };
}

// DB row → client-safe shape (never exposes auth_secret).
function automationToApi(row) {
    return {
        id: row.id, name: row.name, enabled: row.enabled !== false,
        endpointUrl: row.endpoint_url || '', authType: row.auth_type || 'none', authHeader: row.auth_header || '',
        hasSecret: !!row.auth_secret,
        sourceFormat: row.source_format === 'text' ? 'text' : 'json',
        namePrefix: row.name_prefix || '',
        itemsPath: row.items_path || '', addressField: row.address_field || '', nameField: row.name_field || '',
        descriptionField: row.description_field || '', keyField: row.key_field || '',
        networkId: row.network_id || '', profileIds: Array.isArray(row.profile_ids) ? row.profile_ids : [],
        intervalMinutes: row.interval_minutes == null ? 60 : row.interval_minutes, removalMode: row.removal_mode || 'disable',
        minItems: row.min_items || 0,
        lastRunAt: row.last_run_at, lastStatus: row.last_status || '', lastError: row.last_error || '',
    };
}

async function getAutomationRow(id) {
    const r = await pool.query('SELECT * FROM automations WHERE id = $1 AND tenant = $2', [id, tnt()]);
    return r.rows[0] || null;
}

async function listAutomations() {
    const r = await pool.query('SELECT * FROM automations WHERE tenant = $1 ORDER BY name', [tnt()]);
    return r.rows.map(automationToApi);
}

async function createAutomation(cfg) {
    const c = normalizeAutomationCfg(cfg);
    const r = await pool.query(
        `INSERT INTO automations (name, enabled, endpoint_url, auth_type, auth_header, auth_secret, items_path, address_field, name_field, description_field, key_field, network_id, profile_ids, interval_minutes, removal_mode, min_items, source_format, name_prefix, tenant)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [c.name, c.enabled, c.endpointUrl, c.authType, c.authHeader, c.secret ? String(c.secret).trim() : '', c.itemsPath, c.addressField, c.nameField, c.descriptionField, c.keyField, c.networkId, JSON.stringify(c.profileIds), c.intervalMinutes, c.removalMode, c.minItems, c.sourceFormat, c.namePrefix, tnt()]
    );
    return { id: r.rows[0].id };
}

async function updateAutomation(id, cfg) {
    const c = normalizeAutomationCfg(cfg);
    // Secret is write-only: overwrite only when a non-empty value is provided.
    const setSecret = c.secret !== undefined && String(c.secret).trim() !== '';
    const base = [id, c.name, c.enabled, c.endpointUrl, c.authType, c.authHeader, c.itemsPath, c.addressField, c.nameField, c.descriptionField, c.keyField, c.networkId, JSON.stringify(c.profileIds), c.intervalMinutes, c.removalMode, c.minItems, c.sourceFormat, c.namePrefix];
    const params = setSecret ? [...base, String(c.secret).trim()] : base;
    const tenantIdx = params.length + 1; // scope the write to the current account (after the optional secret param)
    params.push(tnt());
    await pool.query(
        `UPDATE automations SET name=$2, enabled=$3, endpoint_url=$4, auth_type=$5, auth_header=$6,
            items_path=$7, address_field=$8, name_field=$9, description_field=$10, key_field=$11,
            network_id=$12, profile_ids=$13, interval_minutes=$14, removal_mode=$15, min_items=$16, source_format=$17, name_prefix=$18${setSecret ? ', auth_secret=$19' : ''}
         WHERE id=$1 AND tenant=$${tenantIdx}`,
        params
    );
}

async function deleteAutomation(id) {
    await pool.query('DELETE FROM automation_resources WHERE automation_id=$1 AND tenant=$2', [id, tnt()]);
    await pool.query('DELETE FROM automation_runs WHERE automation_id=$1 AND tenant=$2', [id, tnt()]);
    await pool.query('DELETE FROM automations WHERE id=$1 AND tenant=$2', [id, tnt()]);
}

async function getAutomationRuns(id, limit = 20) {
    const r = await pool.query('SELECT * FROM automation_runs WHERE automation_id=$1 AND tenant=$3 ORDER BY started_at DESC LIMIT $2', [id, limit, tnt()]);
    return r.rows.map(x => ({
        id: x.id, startedAt: x.started_at, finishedAt: x.finished_at, status: x.status || '', trigger: x.trigger || '',
        created: x.created || 0, updated: x.updated || 0, adopted: x.adopted || 0, disabled: x.disabled || 0, skipped: x.skipped || 0, conflicts: x.conflicts || 0, blocked: x.blocked || 0, failed: x.failed || 0, error: x.error || '',
        errors: Array.isArray(x.errors) ? x.errors : [],
    }));
}

// Map our Access Profile ids → their NetBird group ids (shared profiles only).
async function getProfileGroupIds(ids) {
    const want = new Set((ids || []).map(Number));
    if (!want.size) return [];
    const profiles = await listAccessProfiles();
    return profiles.filter(p => want.has(p.id) && p.shared && p.groupId).map(p => p.groupId);
}

function automationAuthHeaders(row) {
    const h = {};
    const secret = row.auth_secret || '';
    if (row.auth_type === 'bearer' && secret) h['Authorization'] = `Bearer ${secret}`;
    else if (row.auth_type === 'header' && row.auth_header && secret) h[row.auth_header] = secret;
    return h;
}

// Split a plain-text body into items: one non-empty, non-comment (#) line each.
function parseTextLines(raw) {
    return String(raw || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

async function fetchAutomationItems(row) {
    if (!row.endpoint_url) return { error: 'no endpoint URL configured' };
    const resp = await httpJson('GET', row.endpoint_url, { headers: automationAuthHeaders(row) });
    if (!resp || resp.status === 0) return { error: (resp && resp.error) || 'request failed' };
    if (resp.status >= 300) return { error: `HTTP ${resp.status}` };
    if (row.source_format === 'text') {
        return { items: parseTextLines(resp.raw) };
    }
    if (resp.body == null) return { error: 'response is not JSON' };
    const arr = dig(resp.body, row.items_path);
    if (!Array.isArray(arr)) return { error: row.items_path ? `path "${row.items_path}" is not an array` : 'response is not a JSON array (set an items path)' };
    return { items: arr };
}

function mapAutomationItem(row, item) {
    // Text format: each item is a line - "address" or "address <name>" / "address,name".
    if (row.source_format === 'text') {
        const line = String(item || '').trim();
        const sep = line.search(/[\s,]/);
        const address = (sep === -1 ? line : line.slice(0, sep)).trim();
        const baseName = (sep === -1 ? '' : line.slice(sep + 1).trim()) || address;
        // Optional prefix forms the resource name (e.g. "Client-" + 10.0.0.5).
        const name = (row.name_prefix || '') + baseName;
        return { key: address, address, name, description: '' };
    }
    const address = String(dig(item, row.address_field) ?? '').trim();
    const name = (row.name_field ? String(dig(item, row.name_field) ?? '').trim() : '') || address;
    const description = row.description_field ? String(dig(item, row.description_field) ?? '').trim() : '';
    const key = (row.key_field ? String(dig(item, row.key_field) ?? '').trim() : '') || address;
    return { key, address, name, description };
}

// Basic address sanity check (NetBird is the final arbiter; this flags obvious problems).
function addressIssue(addr) {
    const s = String(addr || '').trim();
    if (!s) return 'empty address';
    if (/\s/.test(s)) return 'contains whitespace';
    const slash = s.indexOf('/');
    const host = slash === -1 ? s : s.slice(0, slash);
    const mask = slash === -1 ? null : s.slice(slash + 1);
    if (mask !== null && !/^\d{1,3}$/.test(mask)) return 'invalid CIDR suffix';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return host.split('.').some(o => Number(o) > 255) ? 'invalid IPv4 octet' : '';
    }
    if (host.includes(':')) return ''; // assume IPv6 - let NetBird validate
    if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host)) return '';
    return 'not a valid IP, CIDR or domain';
}

// Fetch + map without creating anything - full stage-by-stage diagnostics for the UI.
async function testAutomation(cfg) {
    const c = normalizeAutomationCfg(cfg);
    let secret = (c.secret !== undefined && String(c.secret).trim() !== '') ? String(c.secret).trim() : '';
    if (!secret && cfg && cfg.id) { const saved = await getAutomationRow(cfg.id); if (saved) secret = saved.auth_secret || ''; }
    const row = {
        endpoint_url: c.endpointUrl, auth_type: c.authType, auth_header: c.authHeader, auth_secret: secret,
        source_format: c.sourceFormat, name_prefix: c.namePrefix,
        items_path: c.itemsPath, address_field: c.addressField, name_field: c.nameField,
        description_field: c.descriptionField, key_field: c.keyField,
    };
    if (!row.endpoint_url) return { ok: false, stage: 'request', error: 'no endpoint URL configured' };
    const resp = await httpJson('GET', row.endpoint_url, { headers: automationAuthHeaders(row) });
    if (!resp || resp.status === 0) return { ok: false, stage: 'request', error: (resp && resp.error) || 'request failed' };
    const httpStatus = resp.status;
    const rawSnippet = String(resp.raw || '').slice(0, 600);
    if (httpStatus >= 300) return { ok: false, stage: 'request', error: `HTTP ${httpStatus}${httpStatus === 401 || httpStatus === 403 ? ' - check the auth token/header' : ''}`, httpStatus, rawSnippet };
    let mappedAll, availableFields = [], itemsFound;
    if (row.source_format === 'text') {
        const lines = parseTextLines(resp.raw);
        itemsFound = lines.length;
        mappedAll = lines.map(l => mapAutomationItem(row, l));
    } else {
        if (resp.body == null) return { ok: false, stage: 'parse', error: 'response is not valid JSON', httpStatus, rawSnippet };
        const arr = dig(resp.body, row.items_path);
        if (!Array.isArray(arr)) {
            const topFields = (resp.body && typeof resp.body === 'object' && !Array.isArray(resp.body)) ? Object.keys(resp.body).slice(0, 40) : [];
            return { ok: false, stage: 'items', error: row.items_path ? `path "${row.items_path}" is not an array` : 'response is not a JSON array - set an items path', httpStatus, rawSnippet, availableFields: topFields };
        }
        availableFields = (arr.length && arr[0] && typeof arr[0] === 'object') ? Object.keys(arr[0]).slice(0, 40) : [];
        itemsFound = arr.length;
        mappedAll = arr.map(it => mapAutomationItem(row, it));
    }
    const keyCount = new Map(), addrCount = new Map();
    for (const m of mappedAll) {
        if (m.key) keyCount.set(m.key, (keyCount.get(m.key) || 0) + 1);
        if (m.address) addrCount.set(m.address, (addrCount.get(m.address) || 0) + 1);
    }
    const dupKeys = [...keyCount.values()].filter(v => v > 1).length;
    const dupAddrs = [...addrCount.values()].filter(v => v > 1).length;
    // Flag addresses that the sync would SKIP because they're on the blocklist (scoped to
    // the target network), so the preview matches what runAutomation actually does.
    const blocklist = await getBlocklist();
    let invalid = 0, blocked = 0;
    const preview = [];
    for (let i = 0; i < mappedAll.length; i++) {
        const m = mappedAll[i];
        const reason = addressIssue(m.address);
        if (reason) invalid++;
        const blockedBy = (!reason && m.address) ? addressBlockedForNetwork(m.address, c.networkId, blocklist) : null;
        if (blockedBy) blocked++;
        if (preview.length < 15) preview.push({ key: m.key, address: m.address, name: m.name, description: m.description, valid: !reason, blocked: !!blockedBy, blockedBy: blockedBy || undefined, reason: reason || undefined });
    }
    return {
        ok: true, stage: 'ok', httpStatus, itemsFound, total: mappedAll.length,
        valid: mappedAll.length - invalid, invalid, blocked,
        duplicates: { keys: dupKeys, addresses: dupAddrs },
        availableFields, preview,
    };
}

// The resources this automation manages, with orphan detection (resource gone from NetBird).
async function getAutomationManaged(id) {
    const row = await getAutomationRow(id);
    if (!row) return { resources: [] };
    const rows = await pool.query('SELECT * FROM automation_resources WHERE automation_id=$1 AND tenant=$2 ORDER BY address', [id, tnt()]);
    const detail = row.network_id ? await getNetworkDetail(row.network_id).catch(() => null) : null;
    const live = new Map(((detail && detail.resources) || []).map(r => [r.id, r]));
    return {
        networkKnown: !!detail,
        resources: rows.rows.map(x => {
            const r = live.get(x.resource_id);
            return {
                key: x.external_key, address: x.address, resourceId: x.resource_id,
                status: x.status === 'adopted-disabled' ? 'disabled' : (x.status || 'active'),
                lastSeenAt: x.last_seen_at,
                orphan: detail ? !r : false,
                liveEnabled: r ? r.enabled !== false : null,
                name: r ? r.name : '',
            };
        }),
    };
}

// Reconcile the ledger: drop rows whose NetBird resource no longer exists (orphans),
// so the next sync re-creates/re-evaluates them.
async function repairAutomation(id) {
    const row = await getAutomationRow(id);
    if (!row) throw new Error('not found');
    if (!row.network_id) throw new Error('no target network configured');
    const detail = await getNetworkDetail(row.network_id).catch(() => null);
    if (!detail) throw new Error('could not read network resources');
    const live = new Set((detail.resources || []).map(r => r.id));
    const rows = await pool.query('SELECT external_key, resource_id FROM automation_resources WHERE automation_id=$1 AND tenant=$2', [id, tnt()]);
    let removed = 0;
    for (const r of rows.rows) {
        if (!live.has(r.resource_id)) {
            await pool.query('DELETE FROM automation_resources WHERE automation_id=$1 AND external_key=$2 AND tenant=$3', [id, r.external_key, tnt()]);
            removed++;
        }
    }
    return { removed };
}

// Stop managing everything (clears the ownership ledger). Resources stay in NetBird as-is.
async function forgetAutomation(id) {
    const r = await pool.query('DELETE FROM automation_resources WHERE automation_id=$1 AND tenant=$2', [id, tnt()]);
    return { forgotten: r.rowCount || 0 };
}

// ─── Dry-run: runAutomation's exact decision walk with every write replaced by a plan
// entry. Answers "what would happen if this ran right now": create / re-enable / adopt
// (incl. rename) / conflict / blocked / skip per source item, plus what the removal
// mode would do to managed rows that vanished from the source. Read-only by
// construction - the only outbound calls are GETs; no DB writes, no NetBird writes.
// Must be kept in lockstep with runAutomation's decision order.
async function dryRunAutomation(id) {
    const row = await getAutomationRow(id);
    if (!row) throw new Error('automation not found');
    const networkId = row.network_id;
    if (!networkId) throw new Error('no target network configured');
    const res = await fetchAutomationItems(row);
    if (res.error) throw new Error(res.error);
    const groups = await getProfileGroupIds(row.profile_ids);
    const blocklist = await getBlocklist();
    // Networks that opted into duplicate addresses skip the overlap guard - mirror that.
    const dupAllowed = (await getDupAllowedNetworkIds().catch(() => [])).includes(String(networkId));
    const detail = await getNetworkDetail(networkId).catch(() => null);
    if (!detail) throw new Error('could not read existing network resources');
    const existing = Array.isArray(detail.resources) ? detail.resources : [];
    const existingByAddr = new Map(existing.map(r => [String(r.address), r]));
    const existingById = new Map(existing.map(r => [r.id, r]));
    const existingByName = new Set(existing.map(r => String(r.name || '').toLowerCase()));
    const ours = await pool.query('SELECT * FROM automation_resources WHERE automation_id=$1 AND tenant=$2', [id, tnt()]);
    const ownByKey = new Map(ours.rows.map(x => [x.external_key, x]));
    const ownResourceIds = new Set(ours.rows.map(x => x.resource_id));

    const mapped = res.items.map(it => mapAutomationItem(row, it));
    const validCount = mapped.filter(m => m.address).length;
    const managedActive = ours.rows.filter(r => r.status !== 'disabled').length;
    const floor = Math.max(parseInt(row.min_items, 10) || 0, 0);
    const belowFloor = (floor > 0 && validCount < floor) || (validCount === 0 && managedActive > 0);

    const base = { itemsFound: res.items.length, validCount, floor, managed: ours.rows.length };
    if (belowFloor) {
        return {
            ok: true, ...base, belowFloor: true, summary: {}, actions: [],
            warn: `source returned ${validCount} valid item(s)${floor ? ` (below the safety minimum of ${floor})` : ''} - a real run would skip the entire sync (nothing created, updated or disabled)`,
        };
    }

    // The plan is a FULL report, not just the deltas: every item appears with BOTH sides -
    // what the source wants (name/address/description) and what exists right now (current
    // resource name/address/enabled). A very high row cap only protects the browser from
    // pathological sources; summary counts everything regardless.
    const actions = [];
    const summary = {};
    // Snapshot of the CURRENT resource behind an item (for managed/adopt/removal rows).
    const snap = (res, ownRow) => (res || ownRow) ? {
        id: (ownRow && ownRow.resource_id) || (res && res.id) || '',
        name: (res && res.name) || '',
        address: (res && res.address) || (ownRow && ownRow.address) || '',
        enabled: res ? res.enabled !== false : undefined,
    } : undefined;
    const add = (action, m, note, current) => {
        summary[action] = (summary[action] || 0) + 1;
        if (actions.length < 20000) {
            actions.push({
                action, key: m.key || '', name: m.name || '', address: m.address || '',
                description: m.description || '', note: note || '', current,
            });
        }
    };
    const seen = new Set();
    for (const m of mapped) {
        if (!m.address) { add('skip', m, 'no usable address'); continue; }
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        const own = ownByKey.get(m.key);
        if (own) {
            const cur = snap(existingById.get(own.resource_id), own);
            if (own.status === 'disabled') { add('re-enable', m, 'managed resource returned to the source', cur); continue; }
            if (groups.length && !resourceHasGroups(existingById.get(own.resource_id), groups)) {
                add('profile', m, 'will attach the configured Access Profile', cur);
                continue;
            }
            add('unchanged', m, '', cur);
            continue;
        }
        if (addressBlockedForNetwork(m.address, networkId, blocklist)) { add('blocked', m, 'address is on the blocklist'); continue; }
        const existingRes = findAdoptable(m.address, existingByAddr, ownResourceIds);
        if (existingRes) {
            const rename = m.name && m.name.toLowerCase() !== String(existingRes.name || '').toLowerCase() && !existingByName.has(m.name.toLowerCase());
            add('adopt', m, `takes over existing "${existingRes.name || existingRes.address}"${rename ? ` and renames it to "${m.name}"` : ''}`, snap(existingRes));
            ownResourceIds.add(existingRes.id);
        } else if (existingByName.has(m.name.toLowerCase())) {
            add('conflict', m, 'name is taken by a different resource (different address)');
        } else {
            // Mirror createClientResource's SMART overlap guard (1.2.3.4 vs 1.2.3.4/32, host
            // inside a CIDR, wildcard domains). Without this the plan says "create" for an
            // item the real run rejects with "address overlaps an existing resource".
            const overlapping = !dupAllowed && [...existingByAddr.values()].find(r => r && r.address && addressesOverlap(m.address, String(r.address)));
            if (overlapping) {
                add('overlap', m, `address overlaps existing "${overlapping.name || overlapping.address}" (${overlapping.address}) - a real run fails on this item`, snap(overlapping));
                continue;
            }
            add('create', m, '');
            // Track within the walk so two source items can't both claim the same name/address
            // - exactly like the real run does.
            existingByAddr.set(m.address, { id: `dry:${m.key}`, name: m.name, address: m.address, enabled: true });
            existingByName.add(m.name.toLowerCase());
        }
    }
    // Managed rows that disappeared from the source → the removal mode's verdict.
    for (const own of ours.rows) {
        if (seen.has(own.external_key)) continue;
        const cur = snap(existingById.get(own.resource_id), own);
        const m = { key: own.external_key, name: (cur && cur.name) || '', address: own.address };
        if (row.removal_mode === 'delete') add('delete', m, 'gone from the source - the resource will be DELETED', cur);
        else if (row.removal_mode === 'disable') { if (!ledgerRowOff(own, existingById.get(own.resource_id))) add('disable', m, 'gone from the source', cur); }
        else add('keep', m, 'gone from the source - removal mode keeps it untouched', cur);
    }

    const totalPlanned = Object.values(summary).reduce((a, b) => a + b, 0);
    return { ok: true, ...base, belowFloor: false, summary, actions, truncated: totalPlanned > actions.length };
}

const _runningAutomations = new Set();

// The sync engine: pull the source, diff against what we created, create/enable/disable.
async function runAutomation(id, { trigger = 'schedule', actor = null } = {}) {
    if (_runningAutomations.has(id)) return { skipped: true, reason: 'already running' };
    const row = await getAutomationRow(id);
    if (!row) return { error: 'not found' };
    _runningAutomations.add(id);
    await pool.query(`UPDATE automations SET last_status='running' WHERE id=$1 AND tenant=$2`, [id, tnt()]);
    const counts = { created: 0, updated: 0, adopted: 0, disabled: 0, skipped: 0, conflicts: 0, blocked: 0, failed: 0, profiled: 0 };
    const itemErrors = [];
    let runErr = '';
    let warn = '';
    try {
        const networkId = row.network_id;
        if (!networkId) throw new Error('no target network configured');
        const res = await fetchAutomationItems(row);
        if (res.error) throw new Error(res.error);
        const groups = await getProfileGroupIds(row.profile_ids);
        const blocklist = await getBlocklist();

        // Existing resources in the network - used to avoid colliding with a resource we
        // didn't create (e.g. a manually-added IP, or a name already taken). Fail safe:
        // if we can't read the current state, abort rather than risk duplicates.
        const detail = await getNetworkDetail(networkId).catch(() => null);
        if (!detail) throw new Error('could not read existing network resources - aborting to avoid duplicates');
        const existing = Array.isArray(detail.resources) ? detail.resources : [];
        const existingByAddr = new Map(existing.map(r => [String(r.address), r]));
        const existingById = new Map(existing.map(r => [r.id, r]));
        const existingByName = new Set(existing.map(r => String(r.name || '').toLowerCase()));

        // Make sure a resource the automation touches carries its configured Access Profile
        // group(s). No-op when no profile is set or the group is already present.
        const ensureProfile = async (resourceId, snapshot, label) => {
            if (!groups.length || resourceHasGroups(snapshot, groups)) return;
            try { if (await addResourceGroups(networkId, resourceId, groups)) counts.profiled++; }
            catch (e) { console.error('[automation %s] access-profile assign %s "%s" failed:', id, label, resourceId, e.message); }
        };

        const ours = await pool.query('SELECT * FROM automation_resources WHERE automation_id=$1 AND tenant=$2', [id, tnt()]);
        const ownByKey = new Map(ours.rows.map(x => [x.external_key, x]));
        const ownResourceIds = new Set(ours.rows.map(x => x.resource_id));
        const seen = new Set();

        const mapped = res.items.map(it => mapAutomationItem(row, it));
        const validCount = mapped.filter(m => m.address).length;

        // Safety gate: treat a response below the configured minimum (or empty while we
        // manage resources) as broken/partial, and skip the ENTIRE sync - create nothing,
        // update nothing, disable nothing - so a flaky API can't corrupt the inventory.
        const managedActive = ours.rows.filter(r => r.status !== 'disabled').length;
        const floor = Math.max(parseInt(row.min_items, 10) || 0, 0);
        const belowFloor = (floor > 0 && validCount < floor) || (validCount === 0 && managedActive > 0);

        if (belowFloor) {
            warn = `source returned ${validCount} valid item(s)${floor ? ` (below the safety minimum of ${floor})` : ''} - skipped this sync entirely; nothing was created, updated or disabled.`;
            console.warn(`[automation ${id}] ${warn}`);
        } else {
        for (const m of mapped) {
            if (!m.address) { counts.skipped++; continue; }
            if (seen.has(m.key)) continue;
            seen.add(m.key);
            try {
                const own = ownByKey.get(m.key);
                if (own) {
                    // Already managed by us → keep it in sync (re-enable if the removal mode disabled it).
                    if (own.status === 'disabled') {
                        await setResourceEnabled(networkId, own.resource_id, true);
                        await pool.query(`UPDATE automation_resources SET status='active', address=$3, last_seen_at=NOW() WHERE automation_id=$1 AND external_key=$2 AND tenant=$4`, [id, m.key, m.address, tnt()]);
                        counts.updated++;
                    } else if (own.status === 'adopted-disabled') {
                        // Already disabled when adopted: never enable it here. Once it's enabled
                        // in NetBird, manage it like any active row.
                        const enabled = !ledgerRowOff(own, existingById.get(own.resource_id));
                        await pool.query(`UPDATE automation_resources SET ${enabled ? "status='active', " : ''}address=$3, last_seen_at=NOW() WHERE automation_id=$1 AND external_key=$2 AND tenant=$4 AND status='adopted-disabled'`, [id, m.key, m.address, tnt()]);
                    } else {
                        await pool.query(`UPDATE automation_resources SET address=$3, last_seen_at=NOW() WHERE automation_id=$1 AND external_key=$2 AND tenant=$4`, [id, m.key, m.address, tnt()]);
                    }
                    // Reconcile the Access Profile (e.g. one added to the automation after this
                    // resource was first created/adopted).
                    await ensureProfile(own.resource_id, existingById.get(own.resource_id), 'managed');
                    continue;
                }
                // Blocklist applies to NEW creates/adopts only (already-managed ones above are untouched).
                if (addressBlockedForNetwork(m.address, networkId, blocklist)) { counts.blocked++; continue; }
                const existingRes = findAdoptable(m.address, existingByAddr, ownResourceIds);
                if (existingRes) {
                    // A resource with this address exists but we don't manage it yet (e.g. a
                    // manually-added IP). Adopt it - from now on its lifecycle is managed, so
                    // it'll be disabled when it disappears from the source. One that's already
                    // disabled stays disabled until it's enabled in NetBird.
                    const adoptStatus = existingRes.enabled === false ? 'adopted-disabled' : 'active';
                    await pool.query(
                        `INSERT INTO automation_resources (automation_id, external_key, address, resource_id, network_id, status, last_seen_at, tenant)
                         VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
                         ON CONFLICT (automation_id, external_key) DO UPDATE SET address=EXCLUDED.address, resource_id=EXCLUDED.resource_id, status=EXCLUDED.status, last_seen_at=NOW()`,
                        [id, m.key, m.address, existingRes.id, networkId, adoptStatus, tnt()]
                    );
                    ownResourceIds.add(existingRes.id);
                    counts.adopted++;
                    // Bring the resource's name in line with the source (skip if the name is
                    // already taken by a different resource, to avoid a duplicate-name error).
                    const curName = String(existingRes.name || '');
                    if (m.name && m.name.toLowerCase() !== curName.toLowerCase() && !existingByName.has(m.name.toLowerCase())) {
                        try {
                            await setResourceNameFrom(networkId, existingRes, m.name, m.description);
                            existingByName.delete(curName.toLowerCase());
                            existingByName.add(m.name.toLowerCase());
                            existingRes.name = m.name;
                        } catch (e) {
                            console.error('[automation %s] adopt-rename "%s" failed:', id, m.key, e.message);
                        }
                    }
                    // Apply the configured Access Profile to the freshly-adopted resource.
                    await ensureProfile(existingRes.id, existingRes, 'adopt');
                } else if (existingByName.has(m.name.toLowerCase())) {
                    // The name is taken by a different resource (different address) - NetBird
                    // won't allow a duplicate name, and we can't safely adopt. Real conflict.
                    counts.conflicts++;
                } else {
                    const out = await createClientResource(networkId, { name: m.name, address: m.address, description: m.description, groups, policies: [] });
                    const rid = out && out.resource && out.resource.id;
                    if (!rid) throw new Error('no resource id returned');
                    await pool.query(
                        `INSERT INTO automation_resources (automation_id, external_key, address, resource_id, network_id, status, last_seen_at, tenant)
                         VALUES ($1,$2,$3,$4,$5,'active',NOW(),$6)
                         ON CONFLICT (automation_id, external_key) DO UPDATE SET address=EXCLUDED.address, resource_id=EXCLUDED.resource_id, status='active', last_seen_at=NOW()`,
                        [id, m.key, m.address, rid, networkId, tnt()]
                    );
                    // Track within this run so two source items can't collide with each other.
                    existingByAddr.set(m.address, { id: rid, name: m.name, address: m.address, enabled: true });
                    existingByName.add(m.name.toLowerCase());
                    ownResourceIds.add(rid);
                    counts.created++;
                }
            } catch (e) {
                counts.failed++;
                if (itemErrors.length < 10) itemErrors.push(`"${m.name || m.address || m.key}": ${e.message}`);
                console.error('[automation %s] item "%s" failed:', id, m.key, e.message);
            }
        }

            // Rows that disappeared from the source → apply the removal mode.
            for (const own of ours.rows) {
                if (seen.has(own.external_key)) continue;
                try {
                    if (row.removal_mode === 'delete') {
                        // Keep tracking the resource (retried on the next run) unless NetBird confirms it is gone.
                        await deleteResource(networkId, own.resource_id).catch((e) => { if (e.unconfirmed) throw e; });
                        await pool.query('DELETE FROM automation_resources WHERE automation_id=$1 AND external_key=$2 AND tenant=$3', [id, own.external_key, tnt()]);
                        counts.disabled++;
                    } else if (row.removal_mode === 'disable' && !ledgerRowOff(own, existingById.get(own.resource_id))) {
                        // Mark it active first, so a failure before the 'disabled' write below
                        // leaves a row the next sync disables again rather than one it skips.
                        if (own.status === 'adopted-disabled') {
                            await pool.query(`UPDATE automation_resources SET status='active' WHERE automation_id=$1 AND external_key=$2 AND tenant=$3 AND status='adopted-disabled'`, [id, own.external_key, tnt()]);
                        }
                        await setResourceEnabled(networkId, own.resource_id, false);
                        await pool.query(`UPDATE automation_resources SET status='disabled' WHERE automation_id=$1 AND external_key=$2 AND tenant=$3`, [id, own.external_key, tnt()]);
                        counts.disabled++;
                    }
                } catch (e) {
                    counts.failed++;
                    if (itemErrors.length < 10) itemErrors.push(`removal "${own.address || own.external_key}": ${e.message}`);
                    console.error('[automation %s] removal of "%s" failed:', id, own.external_key, e.message);
                }
            }
        }
    } catch (e) {
        runErr = e.message || String(e);
    } finally {
        _runningAutomations.delete(id);
    }
    const failNote = itemErrors.length ? `${counts.failed} item(s) failed: ${itemErrors.slice(0, 3).join(' | ')}` : '';
    const status = runErr ? 'error' : (warn || itemErrors.length) ? 'warning' : 'ok';
    const note = runErr || [warn, failNote].filter(Boolean).join(' | ');
    await pool.query(
        `INSERT INTO automation_runs (automation_id, finished_at, status, trigger, created, updated, adopted, disabled, skipped, conflicts, blocked, failed, error, errors, tenant)
         VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, status, trigger, counts.created, counts.updated, counts.adopted, counts.disabled, counts.skipped, counts.conflicts, counts.blocked, counts.failed, note, JSON.stringify(itemErrors), tnt()]
    );
    await pool.query(`UPDATE automations SET last_run_at=NOW(), last_status=$2, last_error=$3 WHERE id=$1 AND tenant=$4`, [id, status, note, tnt()]);
    recordAudit({
        actorId: (actor && (actor.user_id || actor.oid)) || '',
        actorEmail: (actor && actor.email) || 'system',
        actorName: (actor && actor.name) || 'Automation',
        action: 'automation.run', target: row.name,
        meta: { trigger, ...counts, status, error: note || undefined },
    }).catch(() => { });
    return { status, ...counts, error: note };
}

// Startup: clear any 'running' flags left by a crash so they can run again.
async function resetStuckAutomations() {
    await pool.query(`UPDATE automations SET last_status='' WHERE last_status='running' AND tenant=$1`, [tnt()]).catch(() => { });
}

// Scheduler tick: run every enabled, scheduled automation whose interval has elapsed.
async function runDueAutomations() {
    if (!netbirdApiConfigured()) return;
    const r = await pool.query(
        `SELECT id FROM automations
         WHERE enabled = TRUE AND interval_minutes > 0 AND tenant = $1
           AND (last_run_at IS NULL OR last_run_at < NOW() - make_interval(mins => interval_minutes))
         ORDER BY id`,
        [tnt()]
    ).catch(() => ({ rows: [] }));
    for (const a of r.rows) {
        await runAutomation(a.id, { trigger: 'schedule' }).catch(e => console.error('[automation tick]', e.message));
    }
}

module.exports = {
    initAutomations,
    listAutomations, getAutomationRow, createAutomation, updateAutomation, deleteAutomation,
    getAutomationRuns, runAutomation, testAutomation, runDueAutomations, resetStuckAutomations,
    getAutomationManaged, repairAutomation, forgetAutomation, dryRunAutomation,
};
