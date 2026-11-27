'use strict';

const crypto = require('node:crypto');
const { FILES_LIMIT, SLOT_COUNT, failure, slotIds } = require('./protocol');
const { memoryStore } = require('./state');

const LEASE_MS = 150_000;
const MAX_SESSIONS = 50;
const MAX_TOMBSTONES = 10_000;
const SLOT_COOLDOWN_MS = 10 * 60_000;
const ENDED_RECORD_MS = 10 * 60_000;
const JOURNAL_PER_LIST = 20;
const SESSIONS_WITH_FILES_PER_LIST = 20;

const expiredFailure = () => failure('EXPIRED', "The user's authorization has expired.");

const newJournal = () => ({ entries: [], nextSeq: 1, seen: new Set() });

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
    this.filesPolicy = { enabled: false, transfer: false, rev: -1 };
    this.policyFailed = false;
    this.failedRev = -1;
    this.endings = new Map();
    this.requestWaiters = new Set();
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
        return Promise.resolve(this.list(request.ack));
      case 'files':
        return this.setFilesPolicy(request);
      case 'requests':
        return this.requests(request.wait);
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

  async setFilesPolicy({ enabled, transfer, rev }) {
    if (rev < this.filesPolicy.rev || rev < this.failedRev) return { ok: true, rev: this.filesPolicy.rev };
    if (this.policyFailed || this.filesPolicy.enabled !== enabled) {
      try {
        this.runtime.writeFilesPolicy(enabled);
      } catch (error) {
        this.log(`files policy (rev ${rev}) could not be written: ${error.message}`);
        if (!enabled) {
          this.policyFailed = true;
          this.failedRev = rev;
          this.endAll('the files policy could not be blocked');
        }
        return failure('POLICY_FAILED', 'The files policy could not be written.');
      }
      this.policyFailed = false;
      this.log(`files in the browser ${enabled ? 'enabled' : 'blocked'} (rev ${rev})`);
    }
    this.filesPolicy = { enabled, transfer: enabled && transfer, rev };
    return { ok: true, rev };
  }

  endAll(reason) {
    for (const [session, record] of this.sessions) this.endWith(session, record, reason, null);
  }

  async start({ session, width, height, scale, terminal, until, startPage = '', filesLimit = FILES_LIMIT.fallback, language = 'en-US' }) {
    if (terminal) return failure('TERMINAL', 'The session has ended and cannot start again.');
    if (this.policyFailed) return failure('POLICY_FAILED', 'The files policy could not be blocked, so no browser starts.');
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
      filesLimit,
      journal: newJournal(),
      upload: null,
      published: new Map(),
      streams: new Map(),
      polling: false,
      filesRequested: false,
    };
    this.sessions.set(session, record);
    try {
      const { password } = await this.runtime.launch({
        ids,
        width,
        height,
        scale,
        startPage,
        filesLimit,
        language,
        onExit: (reason) => this.ended(session, record, reason),
        onFilesRequest: () => this.noteFilesRequest(record),
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

  noteFilesRequest(record) {
    if (!this.filesPolicy.enabled || this.policyFailed) return;
    record.filesRequested = true;
    for (const wake of [...this.requestWaiters]) wake();
  }

  takeRequests() {
    const sessions = [];
    for (const record of this.sessions.values()) {
      if (!record.filesRequested) continue;
      record.filesRequested = false;
      sessions.push(record.session);
    }
    return sessions;
  }

  requests(wait = 0) {
    const sessions = this.takeRequests();
    if (sessions.length > 0 || wait === 0) return Promise.resolve({ ok: true, sessions });
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.requestWaiters.delete(wake);
        resolve({ ok: true, sessions: this.takeRequests() });
      };
      const timer = setTimeout(wake, wait);
      this.requestWaiters.add(wake);
    });
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

  running(record) {
    return record.state === 'running' && !record.ending;
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
    if (refusal) {
      const ending = this.endings.get(session);
      return ending?.code ? { ...refusal, code: ending.code, limit: ending.limit } : refusal;
    }
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

  recordEnding(session, record, code) {
    const ending = this.endings.get(session);
    if (ending) {
      ending.code = ending.code ?? code;
      return;
    }
    this.endings.set(session, { code, limit: record.filesLimit, journal: record.journal, endedAt: this.now() });
  }

  stopped(session) {
    return { ok: true, state: 'stopped', code: this.endings.get(session)?.code ?? null };
  }

  async stop(session, reason) {
    this.bury(session);
    const record = this.sessions.get(session);
    if (!record) return this.stopped(session);
    record.state = 'stopping';
    this.recordEnding(session, record, null);
    let clean = false;
    try {
      clean = await this.runtime.teardown(record.ids, () => this.finalScan(session, record));
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
    return this.stopped(session);
  }

  endWith(session, record, reason, code) {
    if (record.ending || record.state === 'stopping' || this.sessions.get(session) !== record) return;
    record.ending = true;
    if (code) this.recordEnding(session, record, code);
    if (record.state === 'starting') return;
    this.log(`session ${session}: ${reason}`);
    this.serialize(session, () => this.stop(session, reason));
  }

  ended(session, record, reason) {
    this.endWith(session, record, reason, null);
  }

  expireLeases() {
    const now = this.now();
    for (const [session, record] of this.sessions) {
      if (record.ending || record.state === 'stopping' || record.leaseExpiresAt > now) continue;
      this.ended(session, record, 'lease expired');
    }
    this.pruneEndings();
  }

  noteFiles(journal, files) {
    const complete = new Set();
    for (const { name, size, partial } of files) {
      if (partial) continue;
      complete.add(name);
      if (journal.seen.has(name)) continue;
      journal.seen.add(name);
      journal.entries.push({ seq: journal.nextSeq, name, size });
      journal.nextSeq += 1;
    }
    for (const name of journal.seen) {
      if (!complete.has(name)) journal.seen.delete(name);
    }
  }

  reservedBy(record) {
    return record.upload ? record.upload.size - record.upload.received : 0;
  }

  pollFiles() {
    for (const [session, record] of this.sessions) {
      if (!this.running(record) || record.polling) continue;
      record.polling = true;
      this.serialize(session, () => this.pollSession(session, record))
        .catch((error) => this.log(`session ${session}: files poll failed: ${error.message}`))
        .finally(() => {
          record.polling = false;
        });
    }
  }

  async pollSession(session, record) {
    if (this.sessions.get(session) !== record || !this.running(record)) return;
    let scan;
    try {
      scan = await this.runtime.scanFiles(record.ids);
    } catch (error) {
      this.endWith(session, record, `files could not be measured: ${error.message}`, 'FILES_FULL');
      return;
    }
    if (!scan) return;
    this.noteFiles(record.journal, scan.files);
    const charged = scan.used + this.reservedBy(record);
    if (charged > record.filesLimit) {
      this.endWith(session, record, `files take ${charged} of ${record.filesLimit} bytes`, 'FILES_FULL');
    }
  }

  async finalScan(session, record) {
    try {
      const scan = await this.runtime.scanFiles(record.ids);
      if (scan) this.noteFiles(record.journal, scan.files);
    } catch (error) {
      this.log(`session ${session}: final files scan failed: ${error.message}`);
    }
  }

  filesAccess(session, needsTransfer) {
    const record = this.sessions.get(session);
    if (!record || !this.running(record) || record.leaseExpiresAt <= this.now()) return { refusal: 'NO_SESSION' };
    if (!this.filesPolicy.enabled || this.policyFailed) return { refusal: 'FILES_OFF' };
    if (needsTransfer && !this.filesPolicy.transfer) return { refusal: 'TRANSFER_OFF' };
    return { record };
  }

  acknowledge(acks) {
    for (const [session, seq] of Object.entries(acks)) {
      const journal = this.sessions.get(session)?.journal ?? this.endings.get(session)?.journal;
      if (journal) journal.entries = journal.entries.filter((entry) => entry.seq > seq);
    }
  }

  pruneEndings() {
    const now = this.now();
    for (const [session, ending] of this.endings) {
      if (this.sessions.has(session)) continue;
      const settled = ending.code === null && ending.journal.entries.length === 0;
      if (settled || now - ending.endedAt >= ENDED_RECORD_MS) this.endings.delete(session);
    }
  }

  list(acks = {}) {
    this.acknowledge(acks);
    this.pruneEndings();
    let sessionsLeft = SESSIONS_WITH_FILES_PER_LIST;
    const pending = ({ entries }) => {
      if (entries.length === 0 || sessionsLeft === 0) return [];
      sessionsLeft -= 1;
      return entries.slice(0, JOURNAL_PER_LIST);
    };
    const ended = [...this.endings].map(([session, ending]) => ({ session, code: ending.code, limit: ending.limit, files: pending(ending.journal) }));
    return {
      ok: true,
      instance: this.instance,
      sessions: [...this.sessions.values()].map((record) => ({
        session: record.session,
        state: record.state,
        uid: record.ids.chromiumUid,
        port: record.ids.port,
        startedAt: record.startedAt,
        files: this.endings.has(record.session) ? [] : pending(record.journal),
      })),
      ended,
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

module.exports = { Supervisor, LEASE_MS, MAX_SESSIONS, ENDED_RECORD_MS, JOURNAL_PER_LIST, SESSIONS_WITH_FILES_PER_LIST };
