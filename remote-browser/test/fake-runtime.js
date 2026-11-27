'use strict';

const { PassThrough } = require('node:stream');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const visible = (name) => !name.startsWith('.');

function fakeRuntime() {
  const runtime = {
    calls: [],
    exits: new Map(),
    busy: new Set(),
    launches: [],
    policyWrites: [],
    closedWindows: [],
    folders: new Map(),
    padding: 0,
    scans: 0,
    holdReads: false,
    reads: [],
    teardownResult: true,
    launchGate: null,
    launchError: null,
    onTeardown: () => {},
    folder: (slot = 0) => runtime.folders.get(slot),
    async launch(options) {
      const { ids, onExit } = options;
      runtime.calls.push(`launch ${ids.slot}`);
      runtime.launches.push(options);
      runtime.exits.set(ids.slot, onExit);
      runtime.folders.set(ids.slot, new Map());
      if (runtime.launchGate) await runtime.launchGate.promise;
      if (runtime.launchError) throw runtime.launchError;
      return { password: `pw${ids.slot}` };
    },
    async teardown(ids, afterKill) {
      runtime.calls.push(`teardown ${ids.slot}`);
      runtime.onTeardown(ids);
      await afterKill();
      if (runtime.teardownResult) runtime.folders.delete(ids.slot);
      return runtime.teardownResult;
    },
    async slotIsFree(ids) {
      return !runtime.busy.has(ids.slot);
    },
    async ready() {
      return { netns: 1, gateway: null, table7120: [] };
    },
    writeFilesPolicy(enabled) {
      runtime.policyWrites.push(enabled);
    },
    async closeFileWindows(ids) {
      runtime.closedWindows.push(ids.slot);
      if (runtime.closeGate) await runtime.closeGate.promise;
      if (runtime.closeError) throw runtime.closeError;
    },
    async scanFiles(ids) {
      runtime.scans += 1;
      const folder = runtime.folder(ids.slot);
      if (!folder) return null;
      let used = runtime.padding;
      const files = [];
      for (const [name, data] of folder) {
        used += data.length;
        if (visible(name)) files.push({ name, size: data.length, mtime: 5_000, partial: name.endsWith('.crdownload') });
      }
      return { used, files };
    },
    async readFile(ids, name) {
      const data = runtime.folder(ids.slot).get(name);
      if (!data) return { error: 'NOT_FOUND', stop() {} };
      const stream = new PassThrough();
      const exit = deferred();
      stream.on('end', () => exit.resolve(0));
      const read = { name, stream, exit, data };
      runtime.reads.push(read);
      if (runtime.holdReads) stream.write(data.subarray(0, 1));
      else stream.end(data);
      return {
        size: data.length,
        stream,
        exited: exit.promise,
        stop: () => {
          read.stopped = true;
          exit.resolve(null);
        },
      };
    },
    async deleteFile(ids, name) {
      const folder = runtime.folder(ids.slot);
      const data = folder.get(name);
      if (!data) return { error: 'NOT_FOUND' };
      folder.delete(name);
      return { size: data.length };
    },
    async createUpload(ids, temporary, name) {
      const folder = runtime.folder(ids.slot);
      if (folder.has(name)) return { error: 'NAME_TAKEN' };
      folder.set(temporary, Buffer.alloc(0));
      return { ok: true };
    },
    async appendUpload(ids, temporary, offset, chunk) {
      const folder = runtime.folder(ids.slot);
      const data = folder.get(temporary);
      if (!data) return { error: 'NO_UPLOAD' };
      if (data.length !== offset) return { error: 'OFFSET', received: data.length };
      folder.set(temporary, Buffer.concat([data, chunk]));
      return { received: data.length + chunk.length };
    },
    async publishUpload(ids, temporary, name) {
      const folder = runtime.folder(ids.slot);
      const data = folder.get(temporary);
      if (!data) return { error: folder.has(name) ? 'NAME_TAKEN' : 'NO_UPLOAD' };
      folder.delete(temporary);
      if (folder.has(name)) return { error: 'NAME_TAKEN' };
      folder.set(name, data);
      return { received: data.length };
    },
    async dropUpload(ids, temporary) {
      runtime.folder(ids.slot)?.delete(temporary);
      return { ok: true };
    },
  };
  return runtime;
}

module.exports = { deferred, fakeRuntime };
