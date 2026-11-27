'use strict';

const crypto = require('node:crypto');
const { SLOT_COUNT, failure, slotIds } = require('./protocol');
const { memoryStore } = require('./state');

const LEASE_MS = 150_000;
const MAX_SESSIONS = 50;
const MAX_TOMBSTONES = 10_000;
const SLOT_COOLDOWN_MS = 10 * 60_000;

const expiredFailure = () => failure('EXPIRED', "The user's authorization has expired.");

class Supervisor {
  constructor({ runtime, store = memoryStore(), instance = crypto.randomUUID(), now = Date.now, log = () => {}, leaseMs = LEASE_MS, maxSessions = MAX_SESSIONS, slotCount = SLOT_COUNT, maxTombstones = MAX_TOMBSTONES, slotCooldownMs = SLOT_COOLDOWN_MS }) {
    this.runtime = runtime;
    this.store = store;
    this.instance = instance;
    this.now = now;
    this.log = log;
    this.leaseMs = leaseMs;
    this.maxSessions = maxSessions;
    this.slotCount = slotCount;
    this.maxTombstones = maxTombstones;
    this.sessions = new Map();
    this.tombstones = new Set();
    this.queues = new Map();
    this.heldSlots = new Set();
    this.freedAt = new Map();
    this.slotCooldownMs = slotCooldownMs;
    const saved = store.load();
    this.nextSlot = Number.isInteger(saved) && saved >= 0 && saved < slotCount ? saved : 0;
  }

  handle(request) {
    switch (request.op) {
      case 'start':
        return this.serialize(request.session, () => this.start(request));
      case 'renew':
        return this.serialize(request.session, () => this.renew(request.session, request.until));
      case 'status':
        return Promise.resolve(this.status(request.session));
      case 'credentials':
        return this.serialize(request.session, () => this.credentials(request.session, request.until));
      case 'stop':
        return this.serialize(request.session, () => this.stop(request.session, 'requested'));
      case 'list':
        return Promise.resolve(this.list());
      case 'ready':
        return this.runtime.ready().then((state) => ({ ok: true, instance: this.instance, ...state }));
      default:
        return Promise.resolve(failure('BAD_REQUEST', 'Unknown op.'));
    }
  }

  serialize(id, task) {
    const previous = this.queues.get(id) || Promise.resolve();
    const result = previous.then(task);
    const tail = result.catch(() => {});
    this.queues.set(id, tail);
    tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return result;
  }

  async start({ session, width, height, scale, terminal, until, startPage = '' }) {
    if (terminal) return failure('TERMINAL', 'The session has ended and cannot start again.');
    if (this.expired(until)) return expiredFailure();
    if (this.tombstones.has(session)) return failure('ENDED', 'The session has ended and cannot start again.');
    const existing = this.sessions.get(session);
    if (existing) {
      if (existing.state !== 'running') return failure('ENDED', 'The session is ending.');
      return this.grant(existing);
    }
    if (this.sessions.size >= this.maxSessions) return failure('CAPACITY', 'The browser container runs its maximum number of sessions.');
    const slot = await this.allocate();
    if (slot === null) return failure('CAPACITY', 'No free display is available.');
    const advancedTo = this.nextSlot;
    try {
      this.store.save(advancedTo);
    } catch (error) {
      this.log(`session ${session}: could not record the next slot ${advancedTo}: ${error.message}`);
      this.heldSlots.delete(slot);
      if (this.nextSlot === advancedTo) this.nextSlot = slot;
      return failure('START_FAILED', 'The supervisor could not record its state.');
    }
    const ids = slotIds(slot);
    const record = {
      session,
      ids,
      state: 'starting',
      startedAt: this.now(),
      until,
      leaseExpiresAt: this.leaseUntil(until),
      password: null,
      ending: false,
    };
    this.sessions.set(session, record);
    try {
      const { password } = await this.runtime.launch({
        ids,
        width,
        height,
        scale,
        startPage,
        onExit: (reason) => this.ended(session, record, reason),
      });
      record.password = password;
    } catch (error) {
      this.log(`session ${session}: start failed on slot ${slot}: ${error.message}`);
      await this.stop(session, 'start failed');
      return failure('START_FAILED', 'The browser could not start.');
    }
    if (record.ending) {
      await this.stop(session, 'exited while starting');
      return failure('START_FAILED', 'The browser exited while it started.');
    }
    if (this.expired(record.until)) {
      await this.stop(session, 'authorization expired while starting');
      return expiredFailure();
    }
    record.state = 'running';
    this.log(`session ${session}: running on display :${ids.display} as uid ${ids.chromiumUid}`);
    return this.grant(record);
  }

  grant(record) {
    return { ok: true, port: record.ids.port, password: record.password, uid: record.ids.chromiumUid, instance: this.instance, startedAt: record.startedAt };
  }

  expired(until) {
    return until <= this.now();
  }

  leaseUntil(until) {
    return Math.min(this.now() + this.leaseMs, until);
  }

  authorizedUntil(record, until) {
    record.until = Math.max(record.until, until);
    return !this.expired(record.until);
  }

  live(session) {
    const record = this.sessions.get(session);
    if (!record) {
      return {
        refusal: this.tombstones.has(session)
          ? failure('ENDED', 'The session has ended.')
          : failure('UNKNOWN', 'No such session.'),
      };
    }
    if (record.state === 'stopping' || record.ending) return { refusal: failure('ENDED', 'The session is ending.') };
    return { record };
  }

  renew(session, until) {
    const { record, refusal } = this.live(session);
    if (refusal) return refusal;
    if (!this.authorizedUntil(record, until)) return expiredFailure();
    record.leaseExpiresAt = this.leaseUntil(record.until);
    return { ok: true };
  }

  status(session) {
    const { record, refusal } = this.live(session);
    if (refusal) return refusal;
    return { ok: true, state: record.state };
  }

  credentials(session, until) {
    const { record, refusal } = this.live(session);
    if (refusal) return refusal;
    if (record.state !== 'running') return failure('ENDED', 'The session is ending.');
    if (!this.authorizedUntil(record, until)) return expiredFailure();
    record.leaseExpiresAt = this.leaseUntil(record.until);
    return this.grant(record);
  }

  async stop(session, reason) {
    this.bury(session);
    const record = this.sessions.get(session);
    if (!record) return { ok: true, state: 'stopped' };
    record.state = 'stopping';
    let clean = false;
    try {
      clean = await this.runtime.teardown(record.ids);
    } catch (error) {
      this.log(`session ${session}: teardown error: ${error.message}`);
    }
    if (!clean) {
      this.log(`session ${session}: processes or files of slot ${record.ids.slot} remain; the slot stays held`);
      return failure('STOP_FAILED', 'The session could not be cleaned up completely. Stop it again.');
    }
    this.sessions.delete(session);
    this.heldSlots.delete(record.ids.slot);
    this.freedAt.set(record.ids.slot, this.now());
    this.log(`session ${session}: stopped (${reason})`);
    return { ok: true, state: 'stopped' };
  }

  ended(session, record, reason) {
    if (record.ending || record.state === 'stopping' || this.sessions.get(session) !== record) return;
    record.ending = true;
    if (record.state === 'starting') return;
    this.log(`session ${session}: ${reason}`);
    this.serialize(session, () => this.stop(session, reason));
  }

  expireLeases() {
    const now = this.now();
    for (const [session, record] of this.sessions) {
      if (record.ending || record.state === 'stopping' || record.leaseExpiresAt > now) continue;
      this.ended(session, record, 'lease expired');
    }
  }

  list() {
    return {
      ok: true,
      instance: this.instance,
      sessions: [...this.sessions.values()].map((record) => ({
        session: record.session,
        state: record.state,
        uid: record.ids.chromiumUid,
        port: record.ids.port,
        startedAt: record.startedAt,
      })),
    };
  }

  bury(session) {
    this.tombstones.delete(session);
    this.tombstones.add(session);
    while (this.tombstones.size > this.maxTombstones) {
      this.tombstones.delete(this.tombstones.values().next().value);
    }
  }

  coolingDown(slot) {
    const freedAt = this.freedAt.get(slot);
    if (freedAt === undefined) return false;
    if (this.now() - freedAt < this.slotCooldownMs) return true;
    this.freedAt.delete(slot);
    return false;
  }

  async allocate() {
    for (let step = 0; step < this.slotCount; step += 1) {
      const slot = (this.nextSlot + step) % this.slotCount;
      if (this.heldSlots.has(slot) || this.coolingDown(slot)) continue;
      this.heldSlots.add(slot);
      let free = false;
      try {
        free = await this.runtime.slotIsFree(slotIds(slot));
      } catch (error) {
        this.log(`slot ${slot}: check failed: ${error.message}`);
      }
      if (free) {
        this.nextSlot = (slot + 1) % this.slotCount;
        return slot;
      }
      this.heldSlots.delete(slot);
    }
    return null;
  }
}

module.exports = { Supervisor, LEASE_MS, MAX_SESSIONS };
