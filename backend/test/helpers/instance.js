const path = require('path');

const releases = new Map();

function send(msg) { if (process.send) process.send(msg); }

const ctx = {
    event(name, data) { send({ event: name, data }); },
    hold(name, data) {
        return new Promise((resolve) => {
            const waiting = releases.get(name) || [];
            waiting.push(resolve);
            releases.set(name, waiting);
            ctx.event(`held:${name}`, data);
        });
    },
};

if (require.main === module) process.on('message', async (msg) => {
    if (msg.release) {
        const waiting = releases.get(msg.release) || [];
        releases.set(msg.release, []);
        for (const resolve of waiting) resolve(msg.value);
        return;
    }
    if (!msg.op) return;
    try {
        const value = await ctx.ops[msg.op](msg.args);
        send({ id: msg.id, ok: true, value: value === undefined ? null : value });
    } catch (e) {
        send({ id: msg.id, ok: false, error: e && e.message ? e.message : String(e) });
    }
});

if (require.main === module && process.send && process.argv[2]) {
    (async () => {
        const scenario = require(path.resolve(process.argv[2]));
        ctx.ops = await scenario(ctx);
        send({ event: 'ready' });
    })().catch((e) => { console.error(e); process.exit(1); });
}
