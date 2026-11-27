'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Supervisor } = require('../supervisor/supervisor');
const { memoryStore } = require('../supervisor/state');
const { deferred, fakeRuntime } = require('./fake-runtime');

const FAR = 10 ** 13;
const INSTANCE = 'instance-1';
const STOPPED = { ok: true, state: 'stopped', code: null };

function setup(options = {}) {
  const runtime = fakeRuntime();
  let clock = 1_000;
  const supervisor = new Supervisor({ runtime, instance: INSTANCE, now: () => clock, ...options });
  const startOf = (session, extra = {}) => supervisor.handle({ op: 'start', session, width: 1280, height: 720, scale: 1, terminal: false, until: FAR, ...extra });
  const renewOf = (session, until = FAR) => supervisor.handle({ op: 'renew', session, until });
  return {
    runtime,
    supervisor,
    startOf,
    renewOf,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));


test('a new browser gets the language of its start, English when the start has none', async () => {
  const { startOf, runtime } = setup();
  await startOf('a', { language: 'he' });
  await startOf('b');
  assert.deepEqual(runtime.launches.map((launch) => launch.language), ['he', 'en-US']);
});

test('a new browser gets the theme of its start, light when the start has none', async () => {
  const { startOf, runtime } = setup();
  await startOf('a', { theme: 'dark' });
  await startOf('b');
  assert.deepEqual(runtime.launches.map((launch) => launch.theme), ['dark', 'light']);
});

test('start returns the port, password and Chromium uid of the first free slot', async () => {
  const { startOf } = setup();
  assert.deepEqual(await startOf('a'), { ok: true, port: 5901, password: 'pw0', uid: 62000, instance: INSTANCE, startedAt: 1_000 });
  assert.deepEqual(await startOf('b'), { ok: true, port: 5902, password: 'pw1', uid: 62001, instance: INSTANCE, startedAt: 1_000 });
});

test('start for a running session returns the same credentials without a second launch', async () => {
  const { startOf, runtime } = setup();
  const first = await startOf('a');
  assert.deepEqual(await startOf('a', { width: 800, height: 600 }), first);
  assert.deepEqual(runtime.calls, ['launch 0']);
});

test('a terminal session is refused', async () => {
  const { startOf, runtime } = setup();
  assert.equal((await startOf('a', { terminal: true })).error, 'TERMINAL');
  assert.deepEqual(runtime.calls, []);
});

test('stop tears the session down and leaves a tombstone', async () => {
  const { startOf, renewOf, supervisor, runtime } = setup();
  await startOf('a');
  assert.deepEqual(await supervisor.handle({ op: 'stop', session: 'a' }), STOPPED);
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
  assert.equal((await startOf('a')).error, 'ENDED');
  assert.equal((await renewOf('a')).error, 'ENDED');
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions, []);
});

test('stop of an unknown session succeeds and still refuses a later start', async () => {
  const { startOf, supervisor, runtime } = setup();
  assert.deepEqual(await supervisor.handle({ op: 'stop', session: 'x' }), STOPPED);
  assert.equal((await startOf('x')).error, 'ENDED');
  assert.deepEqual(runtime.calls, []);
});

test('renew of a session never seen is UNKNOWN', async () => {
  const { renewOf } = setup();
  assert.equal((await renewOf('nobody')).error, 'UNKNOWN');
});

test('the lease expires 150 s after the last start or renew', async () => {
  const { startOf, renewOf, supervisor, runtime, advance } = setup();
  await startOf('a');
  advance(100_000);
  assert.deepEqual(await renewOf('a'), { ok: true });
  advance(149_000);
  supervisor.expireLeases();
  await flush();
  assert.equal((await supervisor.handle({ op: 'list' })).sessions.length, 1);
  advance(1_000);
  supervisor.expireLeases();
  await flush();
  await flush();
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions, []);
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
  assert.equal((await startOf('a')).error, 'ENDED');
});

test('requests for one session run in arrival order', async () => {
  const { startOf, renewOf, supervisor, runtime } = setup();
  runtime.launchGate = deferred();
  const started = startOf('a');
  const stopped = supervisor.handle({ op: 'stop', session: 'a' });
  const renewed = renewOf('a');
  await flush();
  assert.deepEqual(runtime.calls, ['launch 0']);
  runtime.launchGate.resolve();
  assert.equal((await started).ok, true);
  assert.deepEqual(await stopped, STOPPED);
  assert.equal((await renewed).error, 'ENDED');
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('different sessions start at the same time on different slots', async () => {
  const { startOf, runtime } = setup();
  runtime.launchGate = deferred();
  const a = startOf('a');
  const b = startOf('b');
  await flush();
  assert.deepEqual(runtime.calls, ['launch 0', 'launch 1']);
  runtime.launchGate.resolve();
  assert.equal((await a).uid, 62000);
  assert.equal((await b).uid, 62001);
});

test('slots are handed out in order and are not reused at once', async () => {
  const { startOf, supervisor } = setup();
  await startOf('a');
  await supervisor.handle({ op: 'stop', session: 'a' });
  assert.equal((await startOf('b')).uid, 62001);
});

test('allocation wraps around only to a slot that is free and whose session ended at least 10 minutes ago', async () => {
  const { startOf, supervisor, runtime, advance } = setup({ slotCount: 3 });
  await startOf('a');
  await startOf('b');
  await startOf('c');
  await supervisor.handle({ op: 'stop', session: 'b' });
  runtime.busy.add(0);
  assert.equal((await startOf('d')).error, 'CAPACITY', 'the freed slot cools down');
  advance(10 * 60_000 - 1);
  assert.equal((await startOf('d')).error, 'CAPACITY');
  advance(1);
  assert.equal((await startOf('d')).uid, 62001);
  assert.equal((await startOf('e')).error, 'CAPACITY');
});

test('a slot whose leftovers remain is skipped', async () => {
  const { startOf, runtime } = setup();
  runtime.busy.add(0);
  runtime.busy.add(1);
  assert.equal((await startOf('a')).uid, 62002);
});

test('the number of sessions is capped', async () => {
  const { startOf } = setup({ maxSessions: 2 });
  await startOf('a');
  await startOf('b');
  assert.equal((await startOf('c')).error, 'CAPACITY');
});

test('a failed launch is cleaned up and the id is not reused', async () => {
  const { startOf, runtime, supervisor } = setup();
  runtime.launchError = new Error('Xvnc exited during start');
  assert.equal((await startOf('a')).error, 'START_FAILED');
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions, []);
  runtime.launchError = null;
  assert.equal((await startOf('a')).error, 'ENDED');
});

test('a teardown that leaves processes keeps the slot and reports STOP_FAILED until it succeeds', async () => {
  const { startOf, renewOf, supervisor, runtime, advance } = setup({ slotCount: 2 });
  await startOf('a');
  runtime.teardownResult = false;
  assert.equal((await supervisor.handle({ op: 'stop', session: 'a' })).error, 'STOP_FAILED');
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions.map((s) => s.state), ['stopping']);
  assert.equal((await renewOf('a')).error, 'ENDED');
  await startOf('b');
  assert.equal((await startOf('c')).error, 'CAPACITY');
  runtime.teardownResult = true;
  assert.deepEqual(await supervisor.handle({ op: 'stop', session: 'a' }), STOPPED);
  assert.equal((await startOf('c')).error, 'CAPACITY');
  advance(10 * 60_000);
  assert.equal((await startOf('c')).uid, 62000);
});

test('a session whose browser exits is stopped', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a');
  runtime.exits.get(0)('Chromium exited (0)');
  await flush();
  await flush();
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions, []);
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('a browser that exits while it starts fails the start', async () => {
  const { startOf, runtime } = setup();
  runtime.launchGate = deferred();
  const started = startOf('a');
  await flush();
  runtime.exits.get(0)('Chromium exited (1)');
  runtime.launchGate.resolve();
  assert.equal((await started).error, 'START_FAILED');
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('list shows each session with its state, uid, port and start time', async () => {
  const { startOf, supervisor } = setup();
  await startOf('a');
  assert.deepEqual(await supervisor.handle({ op: 'list' }), {
    ok: true,
    instance: INSTANCE,
    sessions: [{ session: 'a', state: 'running', uid: 62000, port: 5901, startedAt: 1_000, files: [] }],
    ended: [],
  });
});

test('ready reports the runtime state', async () => {
  const { supervisor } = setup();
  assert.deepEqual(await supervisor.handle({ op: 'ready' }), { ok: true, instance: INSTANCE, netns: 1, gateway: null, table7120: [] });
});

test('the oldest tombstones are dropped past the cap', async () => {
  const { supervisor, startOf } = setup({ maxTombstones: 2 });
  for (const session of ['a', 'b', 'c']) await supervisor.handle({ op: 'stop', session });
  assert.equal((await startOf('a')).ok, true);
  assert.equal((await startOf('c')).error, 'ENDED');
});

const expire = async (supervisor) => {
  supervisor.expireLeases();
  await flush();
  await flush();
};
const sessionsOf = async (supervisor) => (await supervisor.handle({ op: 'list' })).sessions.map((s) => s.session);

test('start with an earlier until caps the first lease', async () => {
  const { startOf, supervisor, now, advance } = setup();
  await startOf('a', { until: now() + 60_000 });
  advance(59_999);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), ['a']);
  advance(1);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), []);
});

test('start of a running session leaves its lease as it was', async () => {
  const { startOf, supervisor, advance } = setup();
  await startOf('a');
  advance(100_000);
  assert.equal((await startOf('a')).ok, true);
  advance(50_000);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), []);
});

test('renew never extends the lease past 150 s', async () => {
  const { startOf, renewOf, supervisor, advance } = setup();
  await startOf('a');
  advance(10_000);
  await renewOf('a', FAR);
  advance(149_999);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), ['a']);
  advance(1);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), []);
});

test('status reports running, UNKNOWN and ENDED', async () => {
  const { startOf, supervisor } = setup();
  await startOf('a');
  assert.deepEqual(await supervisor.handle({ op: 'status', session: 'a' }), { ok: true, state: 'running' });
  assert.equal((await supervisor.handle({ op: 'status', session: 'nobody' })).error, 'UNKNOWN');
  await supervisor.handle({ op: 'stop', session: 'a' });
  assert.equal((await supervisor.handle({ op: 'status', session: 'a' })).error, 'ENDED');
});

test('status does not extend the lease', async () => {
  const { startOf, supervisor, advance } = setup();
  await startOf('a');
  advance(149_999);
  assert.equal((await supervisor.handle({ op: 'status', session: 'a' })).ok, true);
  advance(1);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), []);
});

test('credentials with a newer authorization extend the lease like renew, up to 150 s and never past it', async () => {
  const { startOf, supervisor, advance, now } = setup();
  await startOf('a', { until: now() + 100_000 });
  advance(90_000);
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'a', until: now() + 60_000 })).ok, true);
  advance(59_999);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), ['a'], 'extended past the first authorization');
  advance(1);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), []);
});

test('status answers at once during a start while credentials waits for it', async () => {
  const { startOf, supervisor, runtime } = setup();
  runtime.launchGate = deferred();
  const started = startOf('a');
  await flush();
  assert.deepEqual(await supervisor.handle({ op: 'status', session: 'a' }), { ok: true, state: 'starting' });
  let answered = null;
  const credentials = supervisor.handle({ op: 'credentials', session: 'a', until: FAR }).then((response) => {
    answered = response;
  });
  await flush();
  assert.equal(answered, null);
  runtime.launchGate.resolve();
  await credentials;
  assert.deepEqual(answered, await started);
});

test('credentials return the start credentials without a launch', async () => {
  const { startOf, supervisor, runtime } = setup();
  const started = await startOf('a');
  assert.deepEqual(await supervisor.handle({ op: 'credentials', session: 'a', until: FAR }), started);
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'nobody', until: FAR })).error, 'UNKNOWN');
  await supervisor.handle({ op: 'stop', session: 'a' });
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'a', until: FAR })).error, 'ENDED');
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('a new supervisor continues the slot counter of the one before', async () => {
  const store = memoryStore();
  const first = new Supervisor({ runtime: fakeRuntime(), store });
  const second = () => new Supervisor({ runtime: fakeRuntime(), store });
  const start = (supervisor) => supervisor.handle({ op: 'start', session: 'a', width: 1280, height: 720, scale: 1, terminal: false, until: FAR });
  assert.equal((await start(first)).uid, 62000);
  const next = second();
  const started = await start(next);
  assert.equal(started.uid, 62001);
  assert.notEqual(started.instance, first.instance);
  assert.match(started.instance, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('a stored slot outside the range starts at slot 0', async () => {
  for (const saved of [1000, -1, 1.5, '3', null]) {
    const { startOf } = setup({ store: { load: () => saved, save() {} } });
    assert.equal((await startOf('a')).uid, 62000);
  }
});

test('a start whose state cannot be recorded fails before any launch and frees its slot', async () => {
  let broken = true;
  const saved = [];
  const store = {
    load: () => null,
    save(slot) {
      if (broken) throw new Error('disk full');
      saved.push(slot);
    },
  };
  const logged = [];
  const { startOf, supervisor, runtime } = setup({ store, log: (line) => logged.push(line) });
  assert.deepEqual(await startOf('a'), { ok: false, error: 'START_FAILED', message: 'The supervisor could not record its state.' });
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(await sessionsOf(supervisor), []);
  assert.match(logged[0], /disk full/);
  broken = false;
  assert.equal((await startOf('a')).uid, 62000);
  assert.deepEqual(saved, [1]);
});

test('the lease follows the newest authorization: an older until neither shortens nor stops it', async () => {
  const { startOf, supervisor, runtime, advance } = setup();
  assert.equal((await startOf('late', { until: 1_000 })).error, 'EXPIRED');
  assert.deepEqual(runtime.calls, []);
  await startOf('a', { until: 100_000 });
  advance(10_000);
  assert.deepEqual(await supervisor.handle({ op: 'renew', session: 'a', until: 5_000 }), { ok: true });
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'a', until: 6_000 })).ok, true);
  advance(80_000);
  supervisor.expireLeases();
  await flush();
  assert.equal((await supervisor.handle({ op: 'list' })).sessions.length, 1);
  assert.deepEqual(await supervisor.handle({ op: 'renew', session: 'a', until: 200_000 }), { ok: true });
  advance(100_000);
  supervisor.expireLeases();
  await flush();
  assert.equal((await supervisor.handle({ op: 'list' })).sessions.length, 1, 'still within the newest authorization');
  advance(10_001);
  supervisor.expireLeases();
  await flush();
  await flush();
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions, [], 'the lease timer stops it when the newest authorization passes');
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('renew and credentials answer EXPIRED only when the newest authorization has passed, and leave the stop to the lease timer', async () => {
  const { startOf, supervisor, runtime, advance } = setup({ leaseMs: 1_000_000 });
  await startOf('a', { until: 20_000 });
  advance(30_000);
  assert.equal((await supervisor.handle({ op: 'renew', session: 'a', until: 25_000 })).error, 'EXPIRED');
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'a', until: 25_000 })).error, 'EXPIRED');
  assert.deepEqual(runtime.calls, ['launch 0'], 'no stop from the request itself');
  supervisor.expireLeases();
  await flush();
  await flush();
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('a start whose authorization passes while the browser launches is stopped and answers EXPIRED', async () => {
  const { startOf, runtime, advance } = setup();
  runtime.launchGate = deferred();
  const started = startOf('a', { until: 5_000 });
  await flush();
  advance(10_000);
  runtime.launchGate.resolve();
  assert.equal((await started).error, 'EXPIRED');
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('credentials report when the session started', async () => {
  const { startOf, supervisor, advance } = setup();
  await startOf('a');
  advance(5_000);
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'a', until: FAR })).startedAt, 1_000);
});

const GIB = 1024 ** 3;
const filesOp = (supervisor, fields) => supervisor.handle({ op: 'files', enabled: true, transfer: true, rev: 0, ...fields });
const poll = async (supervisor) => {
  supervisor.pollFiles();
  await flush();
  await flush();
};
const settleStops = async () => {
  for (let step = 0; step < 5; step += 1) await flush();
};

test('the files policy is written only when it changes, and an older rev is ignored', async () => {
  const { supervisor, runtime } = setup();
  assert.deepEqual(await filesOp(supervisor, { rev: 0 }), { ok: true, rev: 0 });
  assert.deepEqual(await filesOp(supervisor, { rev: 1, transfer: false }), { ok: true, rev: 1 });
  assert.deepEqual(runtime.policyWrites, [true]);
  assert.deepEqual(supervisor.filesPolicy, { enabled: true, transfer: false, rev: 1 });
  assert.deepEqual(await filesOp(supervisor, { rev: 0, enabled: false }), { ok: true, rev: 1 });
  assert.deepEqual(runtime.policyWrites, [true]);
  assert.deepEqual(await filesOp(supervisor, { rev: 1, enabled: false }), { ok: true, rev: 1 });
  assert.deepEqual(runtime.policyWrites, [true, false]);
  assert.deepEqual(await filesOp(supervisor, { rev: 3, enabled: false, transfer: true }), { ok: true, rev: 3 });
  assert.deepEqual(supervisor.filesPolicy, { enabled: false, transfer: false, rev: 3 }, 'transfer counts only with files');
  assert.deepEqual(runtime.policyWrites, [true, false]);
});

test('blocking files closes the Downloads window of every open browser, and allowing them closes none', async () => {
  const { supervisor, runtime, startOf } = setup();
  await filesOp(supervisor, { rev: 0 });
  await startOf('a');
  await startOf('b');
  assert.deepEqual(runtime.closedWindows, []);
  await filesOp(supervisor, { rev: 1, enabled: false });
  assert.deepEqual(runtime.closedWindows.sort(), [0, 1]);
  await filesOp(supervisor, { rev: 2 });
  assert.deepEqual(runtime.closedWindows.length, 2);
});

test('files allowed again while blocked windows are still closing stay allowed', async () => {
  const { supervisor, runtime, startOf } = setup();
  await filesOp(supervisor, { rev: 0 });
  await startOf('a');
  runtime.closeGate = deferred();
  const blocking = filesOp(supervisor, { rev: 1, enabled: false });
  await flush();
  assert.deepEqual(await filesOp(supervisor, { rev: 2 }), { ok: true, rev: 2 });
  runtime.closeGate.resolve();
  assert.deepEqual(await blocking, { ok: true, rev: 1 });
  assert.deepEqual(runtime.policyWrites, [true, false, true]);
  assert.deepEqual(supervisor.filesPolicy, { enabled: true, transfer: true, rev: 2 });
});

test('a browser whose Downloads window cannot be closed when files are blocked is ended', async () => {
  const { supervisor, runtime, startOf } = setup();
  await filesOp(supervisor, { rev: 0 });
  await startOf('a');
  runtime.closeError = new Error('fork failed');
  assert.deepEqual(await filesOp(supervisor, { rev: 1, enabled: false }), { ok: true, rev: 1 });
  await settleStops();
  assert.ok(runtime.calls.includes('teardown 0'));
});

test('a policy write that fails is refused, keeps the held settings and is retried by the next files op', async () => {
  const { supervisor, runtime, startOf } = setup();
  await startOf('a');
  runtime.writeFilesPolicy = () => {
    throw new Error('read-only');
  };
  const refused = await filesOp(supervisor, { rev: 0 });
  assert.deepEqual([refused.ok, refused.error], [false, 'POLICY_FAILED']);
  assert.deepEqual(supervisor.filesPolicy, { enabled: false, transfer: false, rev: -1 });
  assert.deepEqual(supervisor.filesAccess('a', false), { refusal: 'FILES_OFF' });
  await settleStops();
  assert.deepEqual(runtime.calls, ['launch 0'], 'a failed write toward more access stops nothing');
  const written = [];
  runtime.writeFilesPolicy = (enabled) => written.push(enabled);
  assert.deepEqual(await filesOp(supervisor, { rev: 0 }), { ok: true, rev: 0 });
  assert.deepEqual(written, [true]);
  assert.deepEqual(supervisor.filesPolicy, { enabled: true, transfer: true, rev: 0 });
});

test('a policy write that fails to block files stops every session, refuses new ones and the files channel until a later write succeeds', async () => {
  const { supervisor, runtime, startOf } = setup();
  await filesOp(supervisor, { rev: 0 });
  await startOf('a');
  await startOf('b');
  const writeFilesPolicy = runtime.writeFilesPolicy;
  runtime.writeFilesPolicy = () => {
    throw new Error('no space left on device');
  };
  const refused = await filesOp(supervisor, { rev: 1, enabled: false });
  assert.deepEqual([refused.ok, refused.error], [false, 'POLICY_FAILED']);
  assert.deepEqual(supervisor.filesPolicy, { enabled: true, transfer: true, rev: 0 });
  await settleStops();
  assert.deepEqual(runtime.calls, ['launch 0', 'launch 1', 'teardown 0', 'teardown 1']);
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions, []);
  assert.equal((await startOf('c')).error, 'POLICY_FAILED');
  assert.deepEqual(runtime.calls, ['launch 0', 'launch 1', 'teardown 0', 'teardown 1']);
  assert.equal((await filesOp(supervisor, { rev: 2 })).error, 'POLICY_FAILED', 'turning files back on still has to write');
  runtime.writeFilesPolicy = writeFilesPolicy;
  assert.deepEqual(await filesOp(supervisor, { rev: 2 }), { ok: true, rev: 2 });
  assert.deepEqual(runtime.policyWrites, [true, true]);
  assert.equal((await startOf('c')).ok, true);
  assert.equal(supervisor.filesAccess('c', true).record, supervisor.sessions.get('c'));
});

test('a late setting older than a block that failed to write cannot lift the block', async () => {
  const { supervisor, runtime, startOf } = setup();
  await filesOp(supervisor, { rev: 4 });
  const writeFilesPolicy = runtime.writeFilesPolicy;
  runtime.writeFilesPolicy = () => {
    throw new Error('no space left on device');
  };
  assert.equal((await filesOp(supervisor, { rev: 5, enabled: false })).error, 'POLICY_FAILED');
  runtime.writeFilesPolicy = writeFilesPolicy;
  assert.deepEqual(await filesOp(supervisor, { rev: 4 }), { ok: true, rev: 4 });
  assert.equal(supervisor.policyFailed, true);
  assert.equal((await startOf('a')).error, 'POLICY_FAILED');
  assert.deepEqual(await filesOp(supervisor, { rev: 5, enabled: false }), { ok: true, rev: 5 });
  assert.equal(supervisor.policyFailed, false);
  assert.deepEqual(supervisor.filesPolicy, { enabled: false, transfer: false, rev: 5 });
});

test('while a failed block is pending the files channel is off for a session that is still running', async () => {
  const { supervisor, runtime, startOf } = setup();
  await filesOp(supervisor, { rev: 0 });
  runtime.teardownResult = false;
  await startOf('a');
  runtime.writeFilesPolicy = () => {
    throw new Error('read-only');
  };
  await filesOp(supervisor, { rev: 1, enabled: false });
  const record = supervisor.sessions.get('a');
  record.ending = false;
  record.state = 'running';
  assert.deepEqual(supervisor.filesAccess('a', false), { refusal: 'FILES_OFF' });
});

test('the files limit of a start reaches the launch and defaults to 2 GiB', async () => {
  const { startOf, runtime } = setup();
  await startOf('a', { filesLimit: 3 * GIB });
  await startOf('b');
  assert.deepEqual(runtime.launches.map((launch) => launch.filesLimit), [3 * GIB, 2 * GIB]);
});

test('the poll journals each new complete file once, without partial or hidden ones', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a');
  const folder = runtime.folder(0);
  folder.set('firmware.out.crdownload', Buffer.alloc(5));
  folder.set('.upload-x', Buffer.alloc(2));
  await poll(supervisor);
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions[0].files, []);
  folder.delete('firmware.out.crdownload');
  folder.set('firmware.out', Buffer.alloc(5));
  await poll(supervisor);
  await poll(supervisor);
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions[0].files, [{ seq: 1, name: 'firmware.out', size: 5 }]);
  folder.delete('firmware.out');
  await poll(supervisor);
  folder.set('firmware.out', Buffer.alloc(7));
  await poll(supervisor);
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions[0].files.map((entry) => entry.seq), [1, 2], 'a file that returns is new again');
});

test('acked journal entries are dropped and acks for unknown sessions are ignored', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a');
  runtime.folder(0).set('one', Buffer.alloc(1));
  await poll(supervisor);
  runtime.folder(0).set('two', Buffer.alloc(2));
  await poll(supervisor);
  const listed = await supervisor.handle({ op: 'list', ack: { a: 1, nobody: 4 } });
  assert.deepEqual(listed.sessions[0].files, [{ seq: 2, name: 'two', size: 2 }]);
  assert.deepEqual((await supervisor.handle({ op: 'list', ack: { a: 2 } })).sessions[0].files, []);
});

test('the poll stops a session whose files pass its limit, with FILES_FULL recorded before the teardown', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a', { filesLimit: GIB });
  runtime.folder(0).set('big.iso', Buffer.alloc(10));
  runtime.padding = GIB - 10;
  await poll(supervisor);
  assert.deepEqual(runtime.calls, ['launch 0'], 'exactly at the limit is allowed');
  const seenAtTeardown = [];
  runtime.onTeardown = () => seenAtTeardown.push(supervisor.status('a'));
  runtime.padding += 1;
  await poll(supervisor);
  await settleStops();
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
  assert.deepEqual(seenAtTeardown, [{ ok: false, error: 'ENDED', message: 'The session is ending.', code: 'FILES_FULL', limit: GIB }]);
  assert.deepEqual(supervisor.status('a'), { ok: false, error: 'ENDED', message: 'The session has ended.', code: 'FILES_FULL', limit: GIB });
  const listed = await supervisor.handle({ op: 'list' });
  assert.deepEqual(listed.sessions, []);
  assert.deepEqual(listed.ended, [{ session: 'a', code: 'FILES_FULL', limit: GIB, files: [{ seq: 1, name: 'big.iso', size: 10 }] }]);
  assert.deepEqual(await supervisor.handle({ op: 'stop', session: 'a' }), { ok: true, state: 'stopped', code: 'FILES_FULL' });
});

test('the ended record carries the limit the session ran with', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a', { filesLimit: 3 * GIB });
  await startOf('b', { filesLimit: 5 * GIB });
  runtime.padding = 3 * GIB + 1;
  await poll(supervisor);
  await settleStops();
  assert.equal(supervisor.status('a').limit, 3 * GIB);
  assert.deepEqual((await supervisor.handle({ op: 'list' })).ended.map((ending) => [ending.session, ending.limit]), [['a', 3 * GIB]]);
});

test('the poll counts the rest of an active upload as reserved', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a', { filesLimit: GIB });
  const record = supervisor.sessions.get('a');
  record.upload = { id: 'u', name: 'x', size: 100, received: 40, temporary: '.upload-u' };
  runtime.folder(0).set('.upload-u', Buffer.alloc(40));
  runtime.padding = GIB - 100;
  await poll(supervisor);
  assert.deepEqual(runtime.calls, ['launch 0']);
  runtime.padding += 1;
  await poll(supervisor);
  await settleStops();
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('the poll runs whatever the files setting, skips a session without its folder and never overlaps itself', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a');
  await filesOp(supervisor, { enabled: false });
  await poll(supervisor);
  assert.equal(runtime.scans, 1);
  runtime.folders.delete(0);
  await poll(supervisor);
  assert.deepEqual(runtime.calls, ['launch 0']);
  const gate = deferred();
  const scanned = [];
  runtime.scanFiles = async () => {
    scanned.push(1);
    await gate.promise;
    return null;
  };
  supervisor.pollFiles();
  supervisor.pollFiles();
  await flush();
  assert.equal(scanned.length, 1);
  gate.resolve();
  await flush();
  await poll(supervisor);
  assert.equal(scanned.length, 2);
});

test('a scan that does not complete counts as over the limit and stops only that session with FILES_FULL', async () => {
  const logged = [];
  const { startOf, supervisor, runtime } = setup({ log: (line) => logged.push(line) });
  await startOf('a');
  await startOf('b');
  const scanFiles = runtime.scanFiles;
  runtime.scanFiles = async (ids) => {
    if (ids.slot === 0) throw new Error("find failed (1): '/var/lib/browser-files/chromium-0/hidden': Permission denied");
    return scanFiles(ids);
  };
  await poll(supervisor);
  await settleStops();
  assert.deepEqual(runtime.calls, ['launch 0', 'launch 1', 'teardown 0']);
  assert.equal(supervisor.status('a').code, 'FILES_FULL');
  assert.ok(logged.some((line) => /files could not be measured: find failed/.test(line)));
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions.map((s) => s.session), ['b']);
});

test('the final scan at teardown journals files the poll has not seen yet, and list returns them under ended, not stop', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a');
  runtime.folder(0).set('last.bin', Buffer.alloc(3));
  assert.deepEqual(await supervisor.handle({ op: 'stop', session: 'a' }), { ok: true, state: 'stopped', code: null });
  const listed = await supervisor.handle({ op: 'list' });
  assert.deepEqual(listed.ended, [{ session: 'a', code: null, limit: 2 * GIB, files: [{ seq: 1, name: 'last.bin', size: 3 }] }]);
  assert.deepEqual(supervisor.status('a'), { ok: false, error: 'ENDED', message: 'The session has ended.' }, 'no code for a plain stop');
});

test('an ended record is dropped once its files are acked and it has no code, or after 10 minutes', async () => {
  const { startOf, supervisor, runtime, advance } = setup();
  await startOf('a');
  runtime.folder(0).set('a.bin', Buffer.alloc(1));
  await supervisor.handle({ op: 'stop', session: 'a' });
  assert.deepEqual((await supervisor.handle({ op: 'list', ack: { a: 1 } })).ended, []);

  await startOf('b', { filesLimit: GIB });
  runtime.padding = GIB + 1;
  await poll(supervisor);
  await settleStops();
  assert.deepEqual((await supervisor.handle({ op: 'list', ack: { b: 5 } })).ended, [{ session: 'b', code: 'FILES_FULL', limit: GIB, files: [] }]);
  advance(10 * 60_000 - 1);
  assert.equal((await supervisor.handle({ op: 'list' })).ended.length, 1);
  advance(1);
  assert.deepEqual((await supervisor.handle({ op: 'list' })).ended, []);
  assert.deepEqual(supervisor.status('b'), { ok: false, error: 'ENDED', message: 'The session has ended.' });
});

test('an ended session still tearing down is listed under ended, and its files only there', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a');
  runtime.folder(0).set('a.bin', Buffer.alloc(1));
  await poll(supervisor);
  runtime.teardownResult = false;
  assert.equal((await supervisor.handle({ op: 'stop', session: 'a' })).error, 'STOP_FAILED');
  const listed = await supervisor.handle({ op: 'list' });
  assert.deepEqual(listed.sessions.map((s) => [s.state, s.files]), [['stopping', []]]);
  assert.deepEqual(listed.ended, [{ session: 'a', code: null, limit: 2 * GIB, files: [{ seq: 1, name: 'a.bin', size: 1 }] }]);
});

test('list returns at most 20 journal entries per session, oldest first, and the rest after the ack', async () => {
  const { startOf, supervisor, runtime } = setup();
  await startOf('a');
  for (let i = 1; i <= 25; i += 1) runtime.folder(0).set(`f${String(i).padStart(2, '0')}`, Buffer.alloc(1));
  await poll(supervisor);
  const first = (await supervisor.handle({ op: 'list' })).sessions[0].files;
  assert.deepEqual(first.map((entry) => entry.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  const rest = (await supervisor.handle({ op: 'list', ack: { a: 20 } })).sessions[0].files;
  assert.deepEqual(rest.map((entry) => entry.seq), [21, 22, 23, 24, 25]);
  await supervisor.handle({ op: 'stop', session: 'a' });
  assert.deepEqual((await supervisor.handle({ op: 'list' })).ended[0].files.map((entry) => entry.seq), [21, 22, 23, 24, 25]);
});

test('list gives entries to at most 20 sessions, ended ones first, and stays far below the reply limit of the backend', async () => {
  const { startOf, supervisor, runtime } = setup();
  const sessions = Array.from({ length: 30 }, (_, i) => `s${i}`);
  for (const session of sessions) await startOf(session);
  const worstName = (i, j) => `${'\u0001'.repeat(250)}${String(i).padStart(2, '0')}${String(j).padStart(2, '0')}`;
  sessions.forEach((_, i) => {
    for (let j = 0; j < 25; j += 1) runtime.folder(i).set(worstName(i, j), Buffer.alloc(1));
  });
  await poll(supervisor);
  for (const session of sessions.slice(25)) await supervisor.handle({ op: 'stop', session });
  const listed = await supervisor.handle({ op: 'list' });
  const withFiles = [...listed.ended, ...listed.sessions].filter((entry) => entry.files.length > 0);
  assert.equal(withFiles.length, 20);
  assert.ok(withFiles.every((entry) => entry.files.length === 20));
  assert.deepEqual(listed.ended.filter((entry) => entry.files.length > 0).map((entry) => entry.session), sessions.slice(25));
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 1024 * 1024);
});

test('a start that fails leaves no ended record behind', async () => {
  const { startOf, supervisor, runtime } = setup();
  runtime.launchError = new Error('Xvnc exited during start');
  await startOf('a');
  assert.deepEqual((await supervisor.handle({ op: 'list' })).ended, []);
});

test('files access needs a running session with a live lease and the held settings', async () => {
  const { startOf, supervisor, advance } = setup();
  assert.deepEqual(supervisor.filesAccess('a', false), { refusal: 'NO_SESSION' });
  await startOf('a');
  assert.deepEqual(supervisor.filesAccess('a', false), { refusal: 'FILES_OFF' });
  await filesOp(supervisor, { transfer: false });
  assert.equal(supervisor.filesAccess('a', false).record, supervisor.sessions.get('a'));
  assert.deepEqual(supervisor.filesAccess('a', true), { refusal: 'TRANSFER_OFF' });
  await filesOp(supervisor, { rev: 1 });
  assert.equal(supervisor.filesAccess('a', true).record, supervisor.sessions.get('a'));
  advance(150_000);
  assert.deepEqual(supervisor.filesAccess('a', true), { refusal: 'NO_SESSION' });
});
