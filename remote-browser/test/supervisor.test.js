'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Supervisor } = require('../supervisor/supervisor');
const { memoryStore } = require('../supervisor/state');

const FAR = 10 ** 13;
const INSTANCE = 'instance-1';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeRuntime() {
  const runtime = {
    calls: [],
    exits: new Map(),
    busy: new Set(),
    teardownResult: true,
    launchGate: null,
    launchError: null,
    async launch({ ids, onExit }) {
      runtime.calls.push(`launch ${ids.slot}`);
      runtime.exits.set(ids.slot, onExit);
      if (runtime.launchGate) await runtime.launchGate.promise;
      if (runtime.launchError) throw runtime.launchError;
      return { password: `pw${ids.slot}` };
    },
    async teardown(ids) {
      runtime.calls.push(`teardown ${ids.slot}`);
      return runtime.teardownResult;
    },
    async slotIsFree(ids) {
      return !runtime.busy.has(ids.slot);
    },
    async ready() {
      return { netns: 1, gateway: null, table7120: [] };
    },
  };
  return runtime;
}

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
  assert.deepEqual(await supervisor.handle({ op: 'stop', session: 'a' }), { ok: true, state: 'stopped' });
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
  assert.equal((await startOf('a')).error, 'ENDED');
  assert.equal((await renewOf('a')).error, 'ENDED');
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions, []);
});

test('stop of an unknown session succeeds and still refuses a later start', async () => {
  const { startOf, supervisor, runtime } = setup();
  assert.deepEqual(await supervisor.handle({ op: 'stop', session: 'x' }), { ok: true, state: 'stopped' });
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
  assert.deepEqual(await stopped, { ok: true, state: 'stopped' });
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

test('allocation wraps around only to a slot that is free', async () => {
  const { startOf, supervisor, runtime } = setup({ slotCount: 3 });
  await startOf('a');
  await startOf('b');
  await startOf('c');
  await supervisor.handle({ op: 'stop', session: 'b' });
  runtime.busy.add(0);
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
  const { startOf, renewOf, supervisor, runtime } = setup({ slotCount: 2 });
  await startOf('a');
  runtime.teardownResult = false;
  assert.equal((await supervisor.handle({ op: 'stop', session: 'a' })).error, 'STOP_FAILED');
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions.map((s) => s.state), ['stopping']);
  assert.equal((await renewOf('a')).error, 'ENDED');
  await startOf('b');
  assert.equal((await startOf('c')).error, 'CAPACITY');
  runtime.teardownResult = true;
  assert.deepEqual(await supervisor.handle({ op: 'stop', session: 'a' }), { ok: true, state: 'stopped' });
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
    sessions: [{ session: 'a', state: 'running', uid: 62000, port: 5901, startedAt: 1_000 }],
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

test('renew with an earlier until shortens the lease', async () => {
  const { startOf, renewOf, supervisor, now, advance } = setup();
  await startOf('a');
  advance(10_000);
  assert.deepEqual(await renewOf('a', now() + 30_000), { ok: true });
  advance(29_999);
  await expire(supervisor);
  assert.deepEqual(await sessionsOf(supervisor), ['a']);
  advance(1);
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

test('status and credentials do not extend the lease', async () => {
  const { startOf, supervisor, advance } = setup();
  await startOf('a');
  advance(149_999);
  assert.equal((await supervisor.handle({ op: 'status', session: 'a' })).ok, true);
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'a', until: FAR })).ok, true);
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

test('start, renew and credentials refuse an authorization that has already expired, and the last two stop the session', async () => {
  const { startOf, supervisor, runtime, advance } = setup();
  assert.equal((await startOf('late', { until: 1_000 })).error, 'EXPIRED');
  assert.deepEqual(runtime.calls, []);
  await startOf('a');
  await startOf('b');
  advance(10_000);
  assert.equal((await supervisor.handle({ op: 'renew', session: 'a', until: 11_000 })).error, 'EXPIRED');
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'b', until: 5_000 })).error, 'EXPIRED');
  assert.deepEqual((await supervisor.handle({ op: 'list' })).sessions, []);
  assert.deepEqual(runtime.calls, ['launch 0', 'launch 1', 'teardown 0', 'teardown 1']);
  assert.equal((await startOf('a')).error, 'ENDED');
});

test('credentials report when the session started', async () => {
  const { startOf, supervisor, advance } = setup();
  await startOf('a');
  advance(5_000);
  assert.equal((await supervisor.handle({ op: 'credentials', session: 'a', until: FAR })).startedAt, 1_000);
});
