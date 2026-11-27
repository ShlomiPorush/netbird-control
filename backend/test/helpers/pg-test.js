const crypto = require('crypto');
const { Client } = require('pg');
const { dbPasswordProblem } = require('../../lib/db-config');

function serverConfig() {
    const { TEST_DB_HOST, TEST_DB_PORT, TEST_DB_USER, TEST_DB_PASSWORD } = process.env;
    if (!TEST_DB_HOST) return null;
    const problem = dbPasswordProblem({ DB_PASSWORD: TEST_DB_PASSWORD });
    if (problem) throw new Error(`TEST_DB_PASSWORD: ${problem}`);
    return { host: TEST_DB_HOST, port: Number(TEST_DB_PORT), user: TEST_DB_USER, password: TEST_DB_PASSWORD };
}

function seamSkipReason() {
    if (serverConfig()) return false;
    if (process.env.CI) throw new Error('These tests need PostgreSQL: run them with `npm run test:all`.');
    return 'needs PostgreSQL (npm run test:all)';
}

async function createDatabase() {
    const server = serverConfig();
    const database = `t_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Client({ ...server, database: 'postgres' });
    await admin.connect();
    try { await admin.query(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
    const config = { ...server, database };
    return {
        config,
        env: { DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user, DB_PASSWORD: config.password, DB_NAME: database },
        async client() { const c = new Client(config); await c.connect(); return c; },
        async drop() {
            const a = new Client({ ...server, database: 'postgres' });
            await a.connect();
            try { await a.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await a.end(); }
        },
    };
}

function cleanups(t) {
    const steps = [];
    t.after(async () => { for (const step of steps.reverse()) await step(); });
    return (step) => steps.push(step);
}

module.exports = { seamSkipReason, createDatabase, cleanups };
