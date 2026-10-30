// Automation sync and dry run (lib/automations.js) against an in-memory ledger and network:
// a resource that is already disabled when an automation adopts it stays disabled, while
// resources the removal mode turned off are still re-enabled when they return to the source.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ledger = new Map();      // external_key -> automation_resources row
const resources = new Map();   // resource id -> NetBird network resource
const enableCalls = [];        // [resourceId, enabled] per setResourceEnabled call
let sourceText = '';
let failQuery = null;          // RegExp: the next matching query throws once
let removalMode = 'disable';

// Applies the automation_resources writes the engine issues; everything else is a no-op.
function ledgerQuery(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM automation_resources')) return { rows: [...ledger.values()].map(r => ({ ...r })) };
    if (s.startsWith('INSERT INTO automation_resources')) {
        const [, key, address, resource_id, network_id] = params;
        const status = s.includes('$6,NOW(),$7') ? params[5] : 'active';
        ledger.set(key, { automation_id: 1, external_key: key, address, resource_id, network_id, status });
        return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE automation_resources')) {
        const [, set, where] = s.match(/SET (.*) WHERE (.*)$/);
        const row = ledger.get(params[Number(where.match(/external_key=\$(\d+)/)[1]) - 1]);
        const onlyIf = where.match(/status='([^']+)'/);
        if (!row || (onlyIf && row.status !== onlyIf[1])) return { rows: [], rowCount: 0 };
        for (const part of set.split(',')) {
            const [col, val] = part.split('=').map(x => x.trim());
            if (val === 'NOW()') continue;
            row[col] = val.startsWith('$') ? params[Number(val.slice(1)) - 1] : val.replace(/'/g, '');
        }
        return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM automation_resources')) { ledger.delete(params[1]); return { rows: [], rowCount: 1 }; }
    return null;
}

const pool = {
    async query(sql, params = []) {
        if (failQuery && failQuery.test(sql)) { failQuery = null; throw new Error('database unavailable'); }
        if (/FROM automations WHERE id/.test(sql)) {
            return {
                rows: [{
                    id: 1, name: 'Source', endpoint_url: 'https://source.test/list', source_format: 'text',
                    network_id: 'net1', removal_mode: removalMode, min_items: 0, profile_ids: [], name_prefix: '',
                }],
            };
        }
        return ledgerQuery(sql, params) || { rows: [], rowCount: 0 };
    },
};

const stub = (rel, exports) => {
    const filename = require.resolve(rel);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
stub('../lib/core', { pool });
stub('../lib/http', { httpJson: async () => ({ status: 200, raw: sourceText }) });
stub('../lib/netbird', {
    netbirdApiConfigured: () => true,
    netbirdReq: async () => ({ status: 200 }),
    bustNbCaches: () => { },
    currentTenantAccount: () => '',
});

const { initAutomations, runAutomation, dryRunAutomation, getAutomationManaged } = require('../lib/automations');
initAutomations({
    listAccessProfiles: async () => [],
    getNetworkDetail: async () => ({ resources: [...resources.values()].map(r => ({ ...r })) }),
    addResourceGroups: async () => false,
    setResourceEnabled: async (networkId, id, enabled) => {
        enableCalls.push([id, enabled]);
        resources.get(id).enabled = enabled;
    },
    createClientResource: async (networkId, { name, address }) => {
        const id = `c${resources.size + 1}`;
        resources.set(id, { id, name, address, enabled: true, groups: [] });
        return { resource: { id } };
    },
    deleteResource: async (networkId, id) => { resources.delete(id); },
    recordAudit: async () => { },
    getDupAllowedNetworkIds: async () => [],
});

function reset(list) {
    ledger.clear();
    resources.clear();
    enableCalls.length = 0;
    failQuery = null;
    removalMode = 'disable';
    for (const r of list) resources.set(r.id, { groups: [], ...r });
}

async function sync(text) {
    sourceText = text;
    const out = await runAutomation(1);
    assert.equal(out.status, 'ok', out.error);
    return out;
}

test('a resource that is disabled when adopted stays disabled on later syncs', async () => {
    reset([{ id: 'u1', name: 'legacy-db', address: '10.8.8.8', enabled: false }]);
    assert.equal((await sync('10.8.8.8 legacy-db')).adopted, 1);
    await sync('10.8.8.8 legacy-db');
    await sync('10.8.8.8 legacy-db');
    assert.equal(resources.get('u1').enabled, false);
    assert.deepEqual(enableCalls, []);
});

test('the same holds when the source writes the address in an equivalent form', async () => {
    reset([{ id: 'u2', name: 'host', address: '10.8.8.9/32', enabled: false }]);
    assert.equal((await sync('10.8.8.9')).adopted, 1);
    await sync('10.8.8.9');
    assert.equal(resources.get('u2').enabled, false);
    assert.deepEqual(enableCalls, []);
});

test('the dry run plans no re-enable for an adopted disabled resource', async () => {
    reset([{ id: 'u1', name: 'legacy-db', address: '10.8.8.8', enabled: false }]);
    await sync('10.8.8.8 legacy-db');
    const plan = await dryRunAutomation(1);
    assert.equal(plan.summary['re-enable'], undefined);
    assert.equal(plan.summary.unchanged, 1);
});

test('the managed list reports an adopted disabled resource as disabled', async () => {
    reset([{ id: 'u1', name: 'legacy-db', address: '10.8.8.8', enabled: false }]);
    await sync('10.8.8.8 legacy-db');
    const { resources: rows } = await getAutomationManaged(1);
    assert.equal(rows[0].status, 'disabled');
});

test('a resource the removal mode disabled is re-enabled when it returns to the source', async () => {
    reset([]);
    await sync('10.7.7.7 web\n10.7.7.8 keep');
    const id = ledger.get('10.7.7.7').resource_id;
    assert.equal((await sync('10.7.7.8 keep')).disabled, 1);
    assert.equal(resources.get(id).enabled, false);
    assert.equal((await dryRunAutomation(1)).summary['re-enable'], undefined);
    sourceText = '10.7.7.7 web\n10.7.7.8 keep';
    assert.equal((await dryRunAutomation(1)).summary['re-enable'], 1);
    assert.equal((await sync('10.7.7.7 web\n10.7.7.8 keep')).updated, 1);
    assert.equal(resources.get(id).enabled, true);
    assert.equal(ledger.get('10.7.7.7').status, 'active');
});

test('an adopted disabled resource that leaves and returns to the source stays disabled', async () => {
    reset([{ id: 'u1', name: 'legacy-db', address: '10.8.8.8', enabled: false }]);
    await sync('10.8.8.8 legacy-db\n10.7.7.8 keep');
    const gone = await sync('10.7.7.8 keep');
    assert.equal(gone.disabled, 0);
    assert.equal((await dryRunAutomation(1)).summary.disable, undefined);
    await sync('10.8.8.8 legacy-db\n10.7.7.8 keep');
    assert.equal(resources.get('u1').enabled, false);
    assert.deepEqual(enableCalls, []);
});

test('an adopted resource that was enabled later follows the removal mode again', async () => {
    reset([{ id: 'u1', name: 'legacy-db', address: '10.8.8.8', enabled: false }]);
    await sync('10.8.8.8 legacy-db\n10.7.7.8 keep');
    resources.get('u1').enabled = true;
    // Leaves the source with no sync in between.
    assert.equal((await dryRunAutomation(1)).summary['re-enable'], undefined);
    sourceText = '10.7.7.8 keep';
    assert.equal((await dryRunAutomation(1)).summary.disable, 1);
    assert.equal((await sync('10.7.7.8 keep')).disabled, 1);
    assert.equal(resources.get('u1').enabled, false);
    await sync('10.8.8.8 legacy-db\n10.7.7.8 keep');
    assert.equal(resources.get('u1').enabled, true);
    assert.deepEqual(enableCalls, [['u1', false], ['u1', true]]);
});

test('an adopted resource that was enabled later is managed as active while in the source', async () => {
    reset([{ id: 'u1', name: 'legacy-db', address: '10.8.8.8', enabled: false }]);
    await sync('10.8.8.8 legacy-db\n10.7.7.8 keep');
    resources.get('u1').enabled = true;
    await sync('10.8.8.8 legacy-db\n10.7.7.8 keep');
    assert.equal(ledger.get('10.8.8.8').status, 'active');
    assert.deepEqual(enableCalls, []);
});

test('a removal that stops after disabling the resource is completed on the next sync', async () => {
    reset([{ id: 'u1', name: 'legacy-db', address: '10.8.8.8', enabled: false }]);
    await sync('10.8.8.8 legacy-db\n10.7.7.8 keep');
    resources.get('u1').enabled = true;
    sourceText = '10.7.7.8 keep';
    failQuery = /SET status='disabled'/;
    assert.equal((await runAutomation(1)).failed, 1);
    assert.equal(resources.get('u1').enabled, false);
    await sync('10.7.7.8 keep');
    assert.equal(ledger.get('10.8.8.8').status, 'disabled');
    await sync('10.8.8.8 legacy-db\n10.7.7.8 keep');
    assert.equal(resources.get('u1').enabled, true);
});
