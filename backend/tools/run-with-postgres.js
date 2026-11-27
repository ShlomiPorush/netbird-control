const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { dbPasswordProblem } = require('../lib/db-config');

const IMAGE = 'postgres:17-alpine';

function docker(args, opts = {}) {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

async function waitReady(id, password) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        try {
            docker(['exec', '-e', `PGPASSWORD=${password}`, id, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-tAc', 'SELECT 1']);
            return;
        } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    throw new Error('the test PostgreSQL did not become ready within 60 s');
}

async function main() {
    const password = crypto.randomBytes(24).toString('hex');
    const problem = dbPasswordProblem({ DB_PASSWORD: password });
    if (problem) throw new Error(problem);
    const name = `agent-test-netbird-control-${crypto.randomBytes(4).toString('hex')}`;
    const port = await freePort();
    const id = docker(['run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`,
        '-p', `127.0.0.1:${port}:5432`, IMAGE]);
    let code = 1;
    try {
        await waitReady(id, password);
        const env = {
            ...process.env,
            TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: String(port), TEST_DB_USER: 'postgres', TEST_DB_PASSWORD: password,
        };
        const args = ['--test', '--require', './test/helpers/in-process-locks.js', ...process.argv.slice(2)];
        code = await new Promise((resolve) => {
            const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
            child.on('exit', (c) => resolve(c === null ? 1 : c));
        });
    } finally {
        try { docker(['rm', '-f', '-v', id]); } catch (e) { console.error(`could not remove ${name}: ${e.message}`); }
    }
    process.exitCode = code;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
