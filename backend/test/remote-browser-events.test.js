const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../lib/core');
const seen = [];
core.pool.query = async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; };
const events = require('../lib/events');

test('connection events of web sessions never reach the traffic summary, also on a page past the last pair', async () => {
    await events.queryTrafficSummary({ page: 3, per_page: 25 });
    const summary = seen.filter(q => /FROM events/.test(q.sql));
    assert.equal(summary.length, 2);
    for (const q of summary) assert.match(q.sql, /COALESCE\(reference, ''\) <> 'remote-access:web-connection'/);
});
