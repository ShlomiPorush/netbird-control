const { pool } = require('./core');

const MIGRATIONS_LOCK_KEY = 0x4e424d47;
const SCHEMA_BUDGET_MS = 240000;
const SAFE_LOCK_TIMEOUT = '200ms';
const NAME = /^[a-z_][a-z0-9_]*$/;
const TYPES = new Set(['TEXT', 'INTEGER', 'BIGINT', 'BOOLEAN', 'TIMESTAMPTZ', 'JSONB', 'BIGSERIAL', 'JSON', 'TIMESTAMP(6)', 'VARCHAR']);

const MIGRATIONS = [
    {
        id: 1,
        overlapSafe: true,
        ops: [{
            createTable: {
                name: 'coordination',
                columns: [
                    { name: 'key', type: 'TEXT', primaryKey: true },
                    { name: 'value', type: 'TEXT', notNull: true, default: '' },
                ],
            },
        }],
    },
    {
        id: 2,
        overlapSafe: false,
        async run(client) {
            await client.query('BEGIN');
            try {
                await client.query(`INSERT INTO coordination (key, value) VALUES ('settings_version', '1') ON CONFLICT (key) DO NOTHING`);
                await client.query(`
                    CREATE OR REPLACE FUNCTION nbc_bump_settings_version() RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN
                        UPDATE coordination SET value = (value::bigint + 1)::text WHERE key = 'settings_version';
                        RETURN NULL;
                    END $$`);
                await client.query('DROP TRIGGER IF EXISTS app_settings_changed ON app_settings');
                await client.query('DROP TRIGGER IF EXISTS app_settings_updated ON app_settings');
                await client.query(`CREATE TRIGGER app_settings_changed AFTER INSERT OR DELETE ON app_settings
                    FOR EACH ROW EXECUTE FUNCTION nbc_bump_settings_version()`);
                await client.query(`CREATE TRIGGER app_settings_updated AFTER UPDATE ON app_settings
                    FOR EACH ROW WHEN (OLD.value IS DISTINCT FROM NEW.value OR OLD.key IS DISTINCT FROM NEW.key)
                    EXECUTE FUNCTION nbc_bump_settings_version()`);
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK').catch(() => { });
                throw e;
            }
        },
    },
    {
        id: 3,
        overlapSafe: true,
        ops: [{
            createTable: {
                name: 'user_intents',
                columns: [
                    { name: 'tenant', type: 'TEXT', notNull: true },
                    { name: 'user_id', type: 'TEXT', notNull: true },
                    { name: 'kind', type: 'TEXT', notNull: true },
                    { name: 'email', type: 'TEXT', notNull: true, default: '' },
                    { name: 'created_at', type: 'TIMESTAMPTZ', notNull: true },
                ],
                primaryKey: ['tenant', 'user_id'],
            },
        }],
    },
    {
        id: 4,
        overlapSafe: true,
        ops: [{
            createTable: {
                name: 'outbox',
                columns: [
                    { name: 'id', type: 'BIGSERIAL', primaryKey: true },
                    { name: 'tenant', type: 'TEXT', notNull: true, default: '' },
                    { name: 'channel', type: 'TEXT', notNull: true },
                    { name: 'payload', type: 'JSONB', notNull: true },
                    { name: 'status', type: 'TEXT', notNull: true, default: 'pending' },
                    { name: 'attempts', type: 'INTEGER', notNull: true, default: 0 },
                    { name: 'last_error', type: 'TEXT', notNull: true, default: '' },
                    { name: 'created_at', type: 'TIMESTAMPTZ', notNull: true },
                    { name: 'next_at', type: 'TIMESTAMPTZ', notNull: true },
                ],
                indexes: [{ name: 'outbox_due', columns: ['status', 'next_at'] }],
            },
        }],
    },
    {
        id: 5,
        overlapSafe: true,
        ops: [{
            createTable: {
                name: 'automation_pending_creates',
                columns: [
                    { name: 'tenant', type: 'TEXT', notNull: true, default: '' },
                    { name: 'automation_id', type: 'INTEGER', notNull: true },
                    { name: 'external_key', type: 'TEXT', notNull: true },
                    { name: 'network_id', type: 'TEXT', notNull: true },
                    { name: 'address', type: 'TEXT', notNull: true },
                    { name: 'name', type: 'TEXT', notNull: true },
                ],
                primaryKey: ['tenant', 'automation_id', 'external_key'],
            },
        }],
    },
    {
        id: 6,
        overlapSafe: true,
        ops: [{
            createTable: {
                name: 'browser_sessions',
                columns: [
                    { name: 'id', type: 'TEXT', primaryKey: true },
                    { name: 'user_id', type: 'TEXT', notNull: true },
                    { name: 'user_email', type: 'TEXT', default: '' },
                    { name: 'user_name', type: 'TEXT', default: '' },
                    { name: 'oid', type: 'TEXT', default: '' },
                    { name: 'client_ip', type: 'TEXT', default: '' },
                    { name: 'state', type: 'TEXT', notNull: true },
                    { name: 'uid', type: 'INTEGER' },
                    { name: 'port', type: 'INTEGER' },
                    { name: 'width', type: 'INTEGER', notNull: true },
                    { name: 'height', type: 'INTEGER', notNull: true },
                    { name: 'dpi', type: 'INTEGER', notNull: true, default: 96 },
                    { name: 'attachment', type: 'TEXT', default: '' },
                    { name: 'owner_instance', type: 'TEXT', default: '' },
                    { name: 'recorded', type: 'BOOLEAN', notNull: true, default: false },
                    { name: 'created_at', type: 'TIMESTAMPTZ', notNull: true },
                    { name: 'last_auth_ok_at', type: 'TIMESTAMPTZ', notNull: true },
                    { name: 'lease_expires_at', type: 'TIMESTAMPTZ' },
                    { name: 'detached_at', type: 'TIMESTAMPTZ' },
                    { name: 'ended_at', type: 'TIMESTAMPTZ' },
                    { name: 'end_reason', type: 'TEXT', default: '' },
                    { name: 'end_code', type: 'INTEGER' },
                    { name: 'supervisor_instance', type: 'TEXT', default: '' },
                    { name: 'token_hash', type: 'TEXT' },
                    { name: 'token_expires', type: 'TIMESTAMPTZ' },
                    { name: 'conn_count', type: 'INTEGER', notNull: true, default: 0 },
                ],
                indexes: [
                    { name: 'idx_browser_sessions_open', columns: ['state'], where: { column: 'state', notEqual: 'ended' } },
                    { name: 'idx_browser_sessions_user', columns: ['user_id'], where: { column: 'state', notEqual: 'ended' } },
                    { name: 'idx_browser_sessions_token', columns: ['token_hash'], unique: true, where: { column: 'token_hash', notNull: true } },
                ],
            },
        }],
    },
];

function literal(v) {
    if (v === null) return 'NULL';
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
    throw new Error(`not a constant default: ${JSON.stringify(v)}`);
}

function columnSql(c) {
    if (!NAME.test(c.name)) throw new Error(`bad column name ${c.name}`);
    if (!TYPES.has(c.type)) throw new Error(`type ${c.type} is not allowed in a migration`);
    const parts = [c.name, c.type];
    if (c.primaryKey) parts.push('PRIMARY KEY');
    if (c.notNull) parts.push('NOT NULL');
    if (Object.prototype.hasOwnProperty.call(c, 'default')) parts.push(`DEFAULT ${literal(c.default)}`);
    return parts.join(' ');
}

function indexWhere(where) {
    if (!where) return '';
    if (!NAME.test(where.column)) throw new Error(`bad index condition column ${where.column}`);
    if (where.notNull === true) return ` WHERE ${where.column} IS NOT NULL`;
    if (Object.prototype.hasOwnProperty.call(where, 'notEqual')) return ` WHERE ${where.column} <> ${literal(where.notEqual)}`;
    throw new Error(`unknown index condition ${JSON.stringify(where)}`);
}

function opStatements(op) {
    if (op.createTable) {
        const t = op.createTable;
        if (!NAME.test(t.name)) throw new Error(`bad table name ${t.name}`);
        if (t.primaryKey && !t.primaryKey.every((c) => NAME.test(c))) throw new Error(`bad primary key of ${t.name}`);
        const pk = t.primaryKey ? [`PRIMARY KEY (${t.primaryKey.join(', ')})`] : [];
        const stmts = [`CREATE TABLE IF NOT EXISTS ${t.name} (${[...t.columns.map(columnSql), ...pk].join(', ')})`];
        for (const ix of t.indexes || []) {
            if (!NAME.test(ix.name) || !ix.columns.every((c) => NAME.test(c))) throw new Error(`bad index ${ix.name}`);
            stmts.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${ix.name} ON ${t.name} (${ix.columns.join(', ')})${indexWhere(ix.where)}`);
        }
        return stmts;
    }
    if (op.addColumn) {
        const a = op.addColumn;
        if (!NAME.test(a.table)) throw new Error(`bad table name ${a.table}`);
        if (a.column.notNull && !Object.prototype.hasOwnProperty.call(a.column, 'default')) throw new Error(`${a.table}.${a.column.name}: NOT NULL needs a constant default`);
        if (a.column.primaryKey) throw new Error(`${a.table}.${a.column.name}: a new column can't be a primary key`);
        if (a.column.type === 'BIGSERIAL') throw new Error(`${a.table}.${a.column.name}: a serial column rewrites the table`);
        return [`ALTER TABLE ${a.table} ADD COLUMN IF NOT EXISTS ${columnSql(a.column)}`];
    }
    throw new Error(`unknown migration operation ${Object.keys(op).join(',')}`);
}

function validateMigrations(list) {
    let last = 0;
    for (const m of list) {
        if (!Number.isInteger(m.id) || m.id <= last) throw new Error(`migration ids must increase: ${m.id} after ${last}`);
        last = m.id;
        if (typeof m.overlapSafe !== 'boolean') throw new Error(`migration ${m.id} must declare overlapSafe`);
        if (m.overlapSafe) {
            if (m.run || !Array.isArray(m.ops) || !m.ops.length) throw new Error(`overlap-safe migration ${m.id} must list declarative ops only`);
            for (const op of m.ops) opStatements(op);
        } else if (typeof m.run !== 'function') {
            throw new Error(`migration ${m.id} without overlapSafe needs a run function`);
        }
    }
    return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const migrationId = (m) => `m${m.id}`;

async function appliedIds(client) {
    return new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
}

async function applySafe(client, m, deadline) {
    let wait = 200;
    for (;;) {
        await client.query('BEGIN');
        try {
            await client.query(`SET LOCAL lock_timeout = '${SAFE_LOCK_TIMEOUT}'`);
            await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, deadline - Date.now())}`);
            for (const op of m.ops) for (const sql of opStatements(op)) await client.query(sql);
            await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migrationId(m)]);
            await client.query('COMMIT');
            return;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => { });
            if (e.code !== '55P03' || Date.now() + wait > deadline) throw e;
            await sleep(wait);
            wait = Math.min(wait * 2, 2000);
        }
    }
}

async function runSchema({ baseline, migrations = MIGRATIONS, budgetMs = SCHEMA_BUDGET_MS, log = console } = {}) {
    validateMigrations(migrations);
    const deadline = Date.now() + budgetMs;
    const client = await pool.connect();
    let locked = false;
    try {
        await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
        let applied = await appliedIds(client);
        if (applied.has('baseline') && migrations.every((m) => applied.has(migrationId(m)))) return { ran: [] };
        while (!(await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATIONS_LOCK_KEY])).rows[0].ok) {
            if (Date.now() > deadline) throw new Error('another instance holds the schema lock');
            await sleep(500);
        }
        locked = true;
        applied = await appliedIds(client);
        const ran = [];
        if (!applied.has('baseline')) {
            await baseline();
            await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING', ['baseline']);
            ran.push('baseline');
        }
        for (const m of migrations) {
            if (applied.has(migrationId(m))) continue;
            if (m.overlapSafe) {
                await applySafe(client, m, deadline);
            } else {
                await m.run(client);
                await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migrationId(m)]);
            }
            log.log(`[schema] applied migration ${m.id}`);
            ran.push(migrationId(m));
        }
        return { ran };
    } finally {
        let unlockError;
        if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_KEY]).catch((e) => { unlockError = e; });
        client.release(unlockError);
    }
}

module.exports = { MIGRATIONS, runSchema, validateMigrations, opStatements, SCHEMA_BUDGET_MS };
