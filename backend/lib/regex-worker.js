// Worker thread for regex filter rules (see runRegexJobs in lib/events.js). Patterns are
// compiled and run here, never on the main thread, so a slow pattern can't block the process;
// the main thread enforces the time limit and replaces this worker when it runs over.
//
// Each request carries a SharedArrayBuffer laid out as: Int32 [started, finished], then a
// Float64 pair per job [start time, duration]. A job's pair is written once, before the
// counter that covers it, so the main thread can read a consistent picture at any moment.
const { parentPort } = require('worker_threads');

// Rule key -> { pattern, re }. The main thread sends a pattern only the first time this worker
// sees it for a rule; re is compiled on first use (null = invalid pattern, never matches).
const rules = new Map();

parentPort.on('message', ({ seq, jobs, state }) => {
    const counters = new Int32Array(state, 0, 2);
    const times = new Float64Array(state, 8);
    for (const job of jobs) {
        if (job.pattern !== undefined) rules.set(job.key, { pattern: job.pattern, re: undefined });
    }
    const begin = performance.now();
    let hit = false;
    for (let i = 0; i < jobs.length && !hit; i++) {
        const rule = rules.get(jobs[i].key);
        const start = Date.now();
        times[2 * i] = start;
        Atomics.store(counters, 0, i + 1);
        try {
            // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the pattern is an admin-configured filter rule; it runs only in this worker, under the main thread's time limit.
            if (rule.re === undefined) { rule.re = null; rule.re = new RegExp(rule.pattern, 'i'); }
            // Flag 'i' only (no g/y), so test() keeps no lastIndex state between values.
            hit = rule.re !== null && rule.re.test(jobs[i].value);
        } catch { /* invalid pattern: never matches */ }
        times[2 * i + 1] = Date.now() - start;
        Atomics.store(counters, 1, i + 1);
    }
    // ms = how long this whole request took here, for the main thread's time limit.
    parentPort.postMessage({ seq, hit, ms: performance.now() - begin });
});

// Ready to take requests: the main thread starts a request's time limit only after this.
parentPort.postMessage({ ready: true });
