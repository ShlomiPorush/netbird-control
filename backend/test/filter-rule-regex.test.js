// Regex filter rules run off the main thread with a time limit, so a slow pattern can never
// block the process. Each check runs lib/events.js in a child process with a kill timeout: a
// regression fails the test instead of hanging it, and the child must also exit on its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

// Run `body` (the inside of an async function) in a child; it can use `ev` (lib/events.js),
// `runWithTenant`, `cfg(...rules)`, `row(fields)` and `timed(fn)`, and returns a JSON value.
function inChild(body, timeout = 15000) {
    const script = `
const ev = require(${JSON.stringify(path.join(LIB, 'events.js'))});
const { runWithTenant } = require(${JSON.stringify(path.join(LIB, 'netbird.js'))});
let nextId = 1;
const cfg = (...rules) => ({ builtinNoise: false, rules: rules.map((r) => ({ id: nextId++, enabled: true, ...r })) });
const row = (f) => ({ source_addr: '100.64.0.1:5000', destination_addr: '100.64.0.2:443', protocol: 6, ...f });
const timed = async (fn) => { const t = Date.now(); const result = await fn(); return { result, ms: Date.now() - t }; };
(async () => { ${body} })().then(
    (r) => { process.stdout.write('DONE ' + JSON.stringify(r) + '\\n'); },
    (e) => { console.error(e); process.exitCode = 1; });`;
    const out = execFileSync(process.execPath, ['-e', script], { timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const line = out.split('\n').find((l) => l.startsWith('DONE '));
    assert.ok(line, 'the child finished');
    return JSON.parse(line.slice(5));
}

const SLOW = '^(a+)+$';
const SLOW_VALUE = 'a'.repeat(40) + '!';

test('regex filter rules: a slow pattern returns no match within the time limit', () => {
    const r = inChild(`
        const c = cfg({ field: 'source_name', operator: 'regex', value: ${JSON.stringify(SLOW)} });
        return timed(() => ev.eventMatchesFilters(row({ source_name: ${JSON.stringify(SLOW_VALUE)} }), c));
    `);
    assert.equal(r.result, false);
    assert.ok(r.ms < 2000, `took ${r.ms} ms`);
});

test('regex filter rules: the main thread keeps running while a pattern is slow to compile or match', () => {
    const r = inChild(`
        let maxLag = 0, last = Date.now();
        const tick = setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last); last = now; }, 5);
        const huge = '(' + 'a|'.repeat(400000) + 'b)';
        const c = cfg(
            { field: 'source_name', operator: 'regex', value: ${JSON.stringify(SLOW)} },
            { field: 'destination_name', operator: 'regex', value: huge });
        const results = [];
        for (let i = 0; i < 3; i++) results.push(await ev.eventMatchesFilters(row({ source_name: ${JSON.stringify(SLOW_VALUE)}, destination_name: 'x' }), c));
        await new Promise((res) => setTimeout(res, 50));
        clearInterval(tick);
        return { results, maxLag };
    `);
    assert.deepEqual(r.results, [false, false, false]);
    assert.ok(r.maxLag < 200, `the main thread stalled for ${r.maxLag} ms`);
});

test('regex filter rules: ordinary patterns match as before, invalid ones never match', () => {
    const r = inChild(`
        const one = (rule, f) => ev.eventMatchesFilters(row(f), cfg(rule));
        return [
            await one({ field: 'source_name', operator: 'regex', value: '^web-\\\\d+$' }, { source_name: 'WEB-12' }),
            await one({ field: 'source_name', operator: 'regex', value: '^web-\\\\d+$' }, { source_name: 'db-1' }),
            await one({ field: 'any_addr', operator: 'regex', value: ':443$' }, {}),
            await one({ field: 'source_name', operator: 'regex', value: '(' }, { source_name: '(' }),
            await one({ field: 'source_name', operator: 'contains', value: 'web' }, { source_name: 'my-web-1' }),
        ];
    `);
    assert.deepEqual(r, [true, false, true, false, true]);
});

test('regex filter rules: other regex rules keep matching once a slow rule is skipped', () => {
    const r = inChild(`
        const c = cfg(
            { field: 'source_name', operator: 'regex', value: ${JSON.stringify(SLOW)} },
            { field: 'destination_addr', operator: 'regex', value: '^100\\\\.64\\\\.0\\\\.2:' });
        const out = [await ev.eventMatchesFilters(row({ source_name: 'aaaa' }), c)];
        for (let i = 0; i < 3; i++) out.push(await ev.eventMatchesFilters(row({ source_name: ${JSON.stringify(SLOW_VALUE)} }), c));
        return out;
    `);
    // Over the time limit the event counts as not matched; after two strikes the slow rule is
    // skipped and the second rule matches again.
    assert.deepEqual(r, [true, false, false, true]);
});

test('regex filter rules: a rule that is slow twice is skipped for that account only', () => {
    const r = inChild(`
        const warnings = [];
        console.warn = (...a) => warnings.push(a.join(' '));
        const c = cfg({ field: 'source_name', operator: 'regex', value: ${JSON.stringify(SLOW)} });
        const slowRow = row({ source_name: ${JSON.stringify(SLOW_VALUE)} });
        const main = [];
        for (let i = 0; i < 3; i++) main.push(await timed(() => ev.eventMatchesFilters(slowRow, c)));
        const other = await runWithTenant('acct-b', () => timed(() => ev.eventMatchesFilters(slowRow, c)));
        return { main, other, warnings };
    `);
    assert.ok(r.main[0].ms >= 20 && r.main[1].ms >= 20, JSON.stringify(r.main));
    assert.ok(r.main[2].ms < 15, `the skipped rule still took ${r.main[2].ms} ms`);
    assert.ok(r.other.ms >= 20, 'another account with the same rule is still evaluated');
    assert.equal(r.warnings.length, 1);
});
