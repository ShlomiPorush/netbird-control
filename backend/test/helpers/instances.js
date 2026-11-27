const { fork } = require('child_process');
const path = require('path');

function startInstance(env, scenarioPath, { name = 'instance' } = {}) {
    const child = fork(path.join(__dirname, 'instance.js'), [scenarioPath], {
        env: { ...process.env, ...env },
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const logs = [];
    child.stdout.on('data', (d) => logs.push(String(d)));
    child.stderr.on('data', (d) => logs.push(String(d)));
    let seq = 0;
    const pending = new Map();
    const seen = [];
    const waiters = [];
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.on('message', (msg) => {
        if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.ok) resolve(msg.value); else reject(new Error(`${name}: ${msg.error}`));
            return;
        }
        if (msg.event) {
            seen.push(msg);
            for (const w of [...waiters]) if (w.name === msg.event) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.data); }
        }
    });
    exited.then(({ code, signal }) => {
        for (const { reject } of pending.values()) reject(new Error(`${name} exited (${code ?? signal}): ${logs.join('').slice(-2000)}`));
        pending.clear();
    });
    const api = {
        name, child, logs, exited,
        call(op, args) {
            const id = ++seq;
            return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, op, args }); });
        },
        waitFor(event, timeoutMs = 20000) {
            const hit = seen.find((m) => m.event === event);
            if (hit) { seen.splice(seen.indexOf(hit), 1); return Promise.resolve(hit.data); }
            return new Promise((resolve, reject) => {
                const w = { name: event, resolve };
                waiters.push(w);
                setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`${name}: no ${event} within ${timeoutMs} ms; log: ${logs.join('').slice(-2000)}`)); } }, timeoutMs).unref();
            });
        },
        release(event, value) { child.send({ release: event, value }); },
        kill(signal = 'SIGKILL') { child.kill(signal); return exited; },
        async stop() { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } },
    };
    return api.waitFor('ready', 30000).then(() => api);
}

module.exports = { startInstance };
