// NetBird Cloud status: the summary parser, the incident alerts (sent only when the set of open
// incidents changes against the stored one) and the cached read for the pages.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCloudStatus, parseSummary, usesNetbirdCloud, buildAlert } = require('../lib/cloud-status');

// Trimmed from a real status.netbird.io/api/v2/summary.json answer (2026-11-24).
function summaryBody({ incidents = [] } = {}) {
    return {
        page: { id: 'P1', name: 'NetBird', url: 'https://status.netbird.io/', updated_at: '2026-11-24T16:03:16Z' },
        status: { description: incidents.length ? 'Partial System Outage' : 'All Systems Operational', indicator: incidents.length ? 'major' : 'none' },
        components: [
            { id: 'c2', name: 'Signal Service', status: incidents.length ? 'partial_outage' : 'operational', position: 1 },
            { id: 'c1', name: 'Management Service', status: 'operational', position: 0 },
        ],
        incidents,
    };
}
function incident(id, name) {
    return {
        id, name, status: 'identified', impact: 'major', created_at: '2026-11-24T15:32:43Z', updated_at: '2026-11-24T16:03:16Z',
        incident_updates: [
            { body: 'We are investigating.', display_at: '2026-11-24T15:32:43Z', status: 'investigating' },
            { body: 'We have identified the cause.', display_at: '2026-11-24T16:03:16Z', status: 'identified' },
        ],
    };
}

function memoryStore(initial = null) {
    const data = { value: initial, writes: 0 };
    return {
        data,
        get: async () => data.value,
        set: async (_key, value) => { data.value = value; data.writes++; },
    };
}

function harness({ stored = null } = {}) {
    let next = summaryBody();
    const store = memoryStore(stored);
    const alerts = [];
    const cs = createCloudStatus({
        fetchSummary: async () => {
            if (next instanceof Error) throw next;
            return parseSummary(next);
        },
        store,
        alert: (a, emails) => alerts.push({ ...a, emails }),
    });
    return { cs, store, alerts, answer: (body) => { next = body; } };
}

test('the parser keeps the overall state, the services in page order and the open incidents', () => {
    const s = parseSummary(summaryBody({ incidents: [incident('01M87306H8SWN7D02RN72A6CAM', 'Signal service instability')] }));
    assert.equal(s.indicator, 'major');
    assert.equal(s.description, 'Partial System Outage');
    assert.deepEqual(s.components.map(c => c.name), ['Management Service', 'Signal Service']);
    assert.equal(s.incidents.length, 1);
    assert.equal(s.incidents[0].url, 'https://status.netbird.io/incidents/01M87306H8SWN7D02RN72A6CAM');
    assert.equal(s.incidents[0].latestUpdate, 'We have identified the cause.');
});

test('an answer without the components and incidents lists is refused, never read as "no incidents"', () => {
    assert.throws(() => parseSummary(null));
    assert.throws(() => parseSummary({ status: { indicator: 'none' } }));
    assert.throws(() => parseSummary({ components: [], incidents: {} }));
});

test('an unknown overall state reads as unknown, and an incident with an unusable id is left out', () => {
    const body = summaryBody({ incidents: [incident('../../evil', 'Bad'), incident('ok-1', 'Good')] });
    body.status.indicator = 'on_fire';
    const s = parseSummary(body);
    assert.equal(s.indicator, 'unknown');
    assert.deepEqual(s.incidents.map(i => i.id), ['ok-1']);
});

test('only NetBird Cloud management URLs use the cloud status', () => {
    assert.equal(usesNetbirdCloud('https://api.netbird.io'), true);
    assert.equal(usesNetbirdCloud('https://api.netbird.io:443/'), true);
    assert.equal(usesNetbirdCloud('https://netbird.example.com'), false);
    assert.equal(usesNetbirdCloud('https://netbird.io.example.com'), false);
    assert.equal(usesNetbirdCloud(''), false);
});

test('the first check records the open incidents and sends nothing', async () => {
    const h = harness();
    h.answer(summaryBody({ incidents: [incident('i1', 'Signal service instability')] }));
    assert.deepEqual(await h.cs.checkForChanges({ alertsEnabled: true }), { started: 0, resolved: 0 });
    assert.equal(h.alerts.length, 0);
    assert.deepEqual(JSON.parse(h.store.data.value), { i1: 'Signal service instability' });
});

test('a new incident sends one alert, and its end sends one more', async () => {
    const h = harness({ stored: '{}' });
    h.answer(summaryBody({ incidents: [incident('i1', 'Signal service instability')] }));
    await h.cs.checkForChanges({ alertsEnabled: true, emails: ['ops@example.com'] });
    await h.cs.checkForChanges({ alertsEnabled: true, emails: ['ops@example.com'] });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0].subject, /^NetBird Cloud incident: Signal service instability$/);
    assert.match(h.alerts[0].telegram, /Signal Service \(partial outage\)/);
    assert.deepEqual(h.alerts[0].emails, ['ops@example.com']);

    h.answer(summaryBody());
    await h.cs.checkForChanges({ alertsEnabled: true, emails: [] });
    assert.equal(h.alerts.length, 2);
    assert.match(h.alerts[1].subject, /^NetBird Cloud incident resolved: Signal service instability$/);
    assert.equal(h.store.data.value, '{}');
});

test('a failed read sends nothing and keeps the stored incidents', async () => {
    const stored = JSON.stringify({ i1: 'Signal service instability' });
    const h = harness({ stored });
    h.answer(new Error('status.netbird.io did not answer (timeout)'));
    await assert.rejects(h.cs.checkForChanges({ alertsEnabled: true }), /did not answer/);
    h.answer({ status: { indicator: 'none' } });
    await assert.rejects(h.cs.checkForChanges({ alertsEnabled: true }), /unexpected format/);
    assert.equal(h.alerts.length, 0);
    assert.equal(h.store.data.value, stored);
    assert.equal(h.store.data.writes, 0);
});

test('with alerts off the stored incidents still follow the page, so turning alerts on is silent', async () => {
    const h = harness({ stored: '{}' });
    h.answer(summaryBody({ incidents: [incident('i1', 'Signal service instability')] }));
    await h.cs.checkForChanges({ alertsEnabled: false });
    await h.cs.checkForChanges({ alertsEnabled: true });
    assert.equal(h.alerts.length, 0);
});

test('the stored incidents are written only when they change', async () => {
    const h = harness({ stored: '{}' });
    await h.cs.checkForChanges({ alertsEnabled: true });
    await h.cs.checkForChanges({ alertsEnabled: true });
    assert.equal(h.store.data.writes, 0);
});

test('turning the check off forgets the incidents, so the next check is silent', async () => {
    const h = harness({ stored: JSON.stringify({ old: 'Old incident' }) });
    await h.cs.forgetIncidents();
    assert.equal(h.store.data.value, '');
    h.answer(summaryBody({ incidents: [incident('i2', 'Management availability')] }));
    await h.cs.checkForChanges({ alertsEnabled: true });
    assert.equal(h.alerts.length, 0);
});

test('incident text from the status page is escaped in Telegram and email', () => {
    const summary = parseSummary(summaryBody({ incidents: [incident('i1', '<b>x</b> & <script>')] }));
    const a = buildAlert({ kind: 'started', incident: summary.incidents[0] }, summary);
    assert.ok(!a.telegram.includes('<script>'));
    assert.match(a.telegram, /&lt;b&gt;x&lt;\/b&gt; &amp; &lt;script&gt;/);
    assert.ok(!a.mailHtml.includes('<script>'));
});

test('the pages share one read a minute, and a failed read shows as an error', async () => {
    let calls = 0;
    let fail = false;
    let clock = 0;
    const cs = createCloudStatus({
        fetchSummary: async () => { calls++; if (fail) throw new Error('down'); return parseSummary(summaryBody()); },
        store: memoryStore(),
        alert: () => { },
        now: () => clock,
    });
    const [a, b] = await Promise.all([cs.getDisplayStatus(), cs.getDisplayStatus()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.equal(a.summary.indicator, 'none');
    clock += 30_000;
    await cs.getDisplayStatus();
    assert.equal(calls, 1);
    clock += 31_000;
    fail = true;
    const c = await cs.getDisplayStatus();
    assert.equal(calls, 2);
    assert.equal(c.summary, null);
    assert.equal(c.error, 'down');
});
