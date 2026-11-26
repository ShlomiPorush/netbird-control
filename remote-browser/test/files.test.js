'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Supervisor } = require('../supervisor/supervisor');
const { filesServer } = require('../supervisor/files');
const { deferred, fakeRuntime } = require('./fake-runtime');

const FAR = 10 ** 13;
const GIB = 1024 ** 3;
const MIB = 1024 * 1024;

async function setup(t, { files = true, transfer = true, filesLimit = GIB } = {}) {
  const runtime = fakeRuntime();
  let clock = 1_000;
  const logged = [];
  const supervisor = new Supervisor({ runtime, now: () => clock, log: (line) => logged.push(line) });
  await supervisor.handle({ op: 'files', enabled: files, transfer, rev: 0 });
  await supervisor.handle({ op: 'start', session: 's1', width: 1280, height: 720, scale: 1, terminal: false, until: FAR, filesLimit });
  const server = filesServer(supervisor, (line) => logged.push(line));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const json = /json/.test(res.headers['content-type'] ?? '') ? JSON.parse(raw.toString()) : undefined;
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
  return {
    runtime,
    supervisor,
    logged,
    call,
    port,
    folder: () => runtime.folder(0),
    advance: (ms) => {
      clock += ms;
    },
  };
}

const refusal = (status, error) => (response) => {
  assert.equal(response.status, status, JSON.stringify(response.json));
  assert.equal(response.json.error, error);
  assert.equal(typeof response.json.message, 'string');
  return true;
};

const startUpload = (call, name, size) => call('POST', '/sessions/s1/uploads', { name, size });
const uploadOf = (supervisor) => {
  const upload = supervisor.sessions.get('s1').upload;
  return upload && { id: upload.id, name: upload.name, size: upload.size, received: upload.received };
};

test('the list shows visible files with partial marks, their total, the bytes used and the limit', async (t) => {
  const { call, folder } = await setup(t);
  folder().set('b.out', Buffer.alloc(3));
  folder().set('a.out.crdownload', Buffer.alloc(2));
  folder().set('.hidden', Buffer.alloc(1));
  const before = await call('GET', '/sessions/s1/files');
  assert.equal(before.status, 200);
  assert.deepEqual(before.json, {
    files: [
      { name: 'a.out.crdownload', size: 2, partial: true },
      { name: 'b.out', size: 3, partial: false },
    ],
    total: 2,
    used: 6,
    limit: GIB,
  });
});

test('the list holds the newest 500 files and the full count, while the bytes used stay exact', async (t) => {
  const { call, folder, runtime } = await setup(t);
  const scanFiles = runtime.scanFiles;
  runtime.scanFiles = async (ids) => {
    const scan = await scanFiles(ids);
    return { ...scan, files: scan.files.map((file) => ({ ...file, mtime: Number(file.name.slice(1)) })) };
  };
  for (let i = 0; i < 1200; i += 1) folder().set(`f${i}`, Buffer.alloc(1));
  const listed = (await call('GET', '/sessions/s1/files')).json;
  assert.equal(listed.files.length, 500);
  assert.deepEqual([listed.files[0].name, listed.files[499].name], ['f1199', 'f700']);
  assert.deepEqual([listed.total, listed.used], [1200, 1200]);
});

test('every route is refused for a session that is unknown, stopped or past its lease', async (t) => {
  const { call, supervisor, advance } = await setup(t);
  const routes = [['GET', 'files'], ['GET', 'files/x'], ['DELETE', 'files/x'], ['POST', 'uploads'], ['PUT', 'uploads/u?offset=0'], ['DELETE', 'uploads/u']];
  for (const [method, rest] of routes) {
    refusal(404, 'NO_SESSION')(await call(method, `/sessions/nobody/${rest}`));
    refusal(404, 'NO_SESSION')(await call(method, `/sessions/a%2Fb/${rest}`));
  }
  advance(150_000);
  refusal(404, 'NO_SESSION')(await call('GET', '/sessions/s1/files'));
  advance(-150_000);
  await supervisor.handle({ op: 'stop', session: 's1' });
  refusal(404, 'NO_SESSION')(await call('GET', '/sessions/s1/files'));
});

test('a refusal before the body is read still reaches a client sending a full chunk', async (t) => {
  const { call, supervisor } = await setup(t);
  const { json: { id } } = await startUpload(call, 'x.bin', 20 * MIB);
  await supervisor.handle({ op: 'stop', session: 's1' });
  refusal(404, 'NO_SESSION')(await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.alloc(8 * MIB)));
});

test('list and delete need files; download and uploads also need transfer', async (t) => {
  const off = await setup(t, { files: false, transfer: true });
  for (const [method, rest] of [['GET', 'files'], ['GET', 'files/x'], ['DELETE', 'files/x'], ['POST', 'uploads'], ['PUT', 'uploads/u?offset=0'], ['DELETE', 'uploads/u']]) {
    refusal(403, 'FILES_OFF')(await off.call(method, `/sessions/s1/${rest}`));
  }
  const noTransfer = await setup(t, { files: true, transfer: false });
  noTransfer.folder().set('x', Buffer.alloc(1));
  assert.equal((await noTransfer.call('GET', '/sessions/s1/files')).status, 200);
  for (const [method, rest] of [['GET', 'files/x'], ['POST', 'uploads'], ['PUT', 'uploads/u?offset=0'], ['DELETE', 'uploads/u']]) {
    refusal(403, 'TRANSFER_OFF')(await noTransfer.call(method, `/sessions/s1/${rest}`));
  }
  assert.deepEqual((await noTransfer.call('DELETE', '/sessions/s1/files/x')).json, { ok: true, size: 1 });
});

test('the checks run in order: session, files, transfer, then the name', async (t) => {
  const off = await setup(t, { files: false });
  refusal(404, 'NO_SESSION')(await off.call('GET', '/sessions/nobody/files/..'));
  refusal(403, 'FILES_OFF')(await off.call('GET', '/sessions/s1/files/..'));
  const noTransfer = await setup(t, { transfer: false });
  refusal(403, 'TRANSFER_OFF')(await noTransfer.call('GET', '/sessions/s1/files/.hidden'));
  refusal(403, 'TRANSFER_OFF')(await startUpload(noTransfer.call, '../x', 1));
  refusal(400, 'BAD_NAME')(await noTransfer.call('DELETE', '/sessions/s1/files/.hidden'));
});

test('names that are not one visible segment are refused', async (t) => {
  const { call, folder } = await setup(t);
  folder().set('.hidden', Buffer.alloc(1));
  for (const raw of ['.hidden', '..', '%2E%2E', 'a%2Fb', 'a%00b', '%E0%A4%A', 'x'.repeat(256), encodeURIComponent('ü'.repeat(128)), '']) {
    refusal(400, 'BAD_NAME')(await call('GET', `/sessions/s1/files/${raw}`));
    refusal(400, 'BAD_NAME')(await call('DELETE', `/sessions/s1/files/${raw}`));
  }
  for (const name of ['.hidden', '..', 'a/b', 'a\0b', '', 7, null]) {
    refusal(400, 'BAD_NAME')(await startUpload(call, name, 1));
  }
  assert.ok(folder().has('.hidden'));
});

test('a download streams the bytes with their length, and an encoded name is decoded', async (t) => {
  const { call, folder } = await setup(t);
  folder().set('FGT 60F v7.4.out', Buffer.from('firmware-bytes'));
  const response = await call('GET', `/sessions/s1/files/${encodeURIComponent('FGT 60F v7.4.out')}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/octet-stream');
  assert.equal(response.headers['content-length'], '14');
  assert.equal(response.raw.toString(), 'firmware-bytes');
  refusal(404, 'NOT_FOUND')(await call('GET', '/sessions/s1/files/missing'));
});

test('a file still downloading can be neither fetched nor deleted', async (t) => {
  const { call, folder } = await setup(t);
  folder().set('big.iso.crdownload', Buffer.alloc(3));
  refusal(409, 'PARTIAL')(await call('GET', '/sessions/s1/files/big.iso.crdownload'));
  refusal(409, 'PARTIAL')(await call('DELETE', '/sessions/s1/files/big.iso.crdownload'));
  assert.ok(folder().has('big.iso.crdownload'));
});

test('a download asked for while a delete of its file runs waits for the delete and finds no file', async (t) => {
  const { call, folder, runtime } = await setup(t);
  folder().set('image.bin', Buffer.from('abcdef'));
  const deleteFile = runtime.deleteFile;
  const gate = deferred();
  let deleting = false;
  runtime.deleteFile = async (...args) => {
    deleting = true;
    await gate.promise;
    return deleteFile(...args);
  };
  const removal = call('DELETE', '/sessions/s1/files/image.bin');
  while (!deleting) await new Promise((resolve) => setImmediate(resolve));
  const download = call('GET', '/sessions/s1/files/image.bin');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.reads.length, 0, 'no read helper while the delete runs');
  gate.resolve();
  assert.deepEqual((await removal).json, { ok: true, size: 6 });
  refusal(404, 'NOT_FOUND')(await download);
});

test('a file being streamed cannot be deleted until its stream ends', async (t) => {
  const { call, folder, runtime } = await setup(t);
  folder().set('image.bin', Buffer.from('abcdef'));
  runtime.holdReads = true;
  const download = call('GET', '/sessions/s1/files/image.bin');
  while (runtime.reads.length === 0) await new Promise((resolve) => setImmediate(resolve));
  refusal(409, 'BUSY')(await call('DELETE', '/sessions/s1/files/image.bin'));
  const [read] = runtime.reads;
  read.stream.end(read.data.subarray(1));
  assert.equal((await download).raw.toString(), 'abcdef');
  assert.deepEqual((await call('DELETE', '/sessions/s1/files/image.bin')).json, { ok: true, size: 6 });
  refusal(404, 'NOT_FOUND')(await call('DELETE', '/sessions/s1/files/image.bin'));
});

test('a download whose helper fails is cut short, never ended as complete', async (t) => {
  const { call, folder, runtime } = await setup(t);
  folder().set('image.bin', Buffer.from('abcdef'));
  runtime.holdReads = true;
  const download = call('GET', '/sessions/s1/files/image.bin').then(() => 'complete', (error) => error.code);
  while (runtime.reads.length === 0) await new Promise((resolve) => setImmediate(resolve));
  runtime.reads[0].exit.resolve(1);
  assert.equal(await download, 'ECONNRESET');
  assert.deepEqual((await call('DELETE', '/sessions/s1/files/image.bin')).json, { ok: true, size: 6 }, 'the stream is released');
});

test('an upload goes in chunks at the received offset and is published on its last byte', async (t) => {
  const { call, folder, supervisor } = await setup(t);
  const started = await startUpload(call, 'firmware.out', 6);
  assert.equal(started.status, 200);
  const { id } = started.json;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(started.json, { id, received: 0 });
  assert.ok(folder().has(`.upload-${id}`));
  assert.deepEqual((await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.from('abc'))).json, { received: 3, done: false });
  const behind = await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.from('abc'));
  refusal(409, 'OFFSET')(behind);
  assert.equal(behind.json.received, 3);
  refusal(409, 'OFFSET')(await call('PUT', `/sessions/s1/uploads/${id}?offset=x`, Buffer.from('d')));
  refusal(409, 'OFFSET')(await call('PUT', `/sessions/s1/uploads/${id}`, Buffer.from('d')));
  refusal(400, 'BAD_SIZE')(await call('PUT', `/sessions/s1/uploads/${id}?offset=3`, Buffer.from('defg')));
  const published = { received: 6, done: true, name: 'firmware.out', size: 6 };
  assert.deepEqual((await call('PUT', `/sessions/s1/uploads/${id}?offset=3`, Buffer.from('def'))).json, published);
  assert.equal(folder().get('firmware.out').toString(), 'abcdef');
  assert.equal(folder().has(`.upload-${id}`), false);
  assert.deepEqual((await call('PUT', `/sessions/s1/uploads/${id}?offset=3`, Buffer.from('def'))).json, published, 'a retried last chunk gets the kept answer');
  assert.equal(uploadOf(supervisor), null);
});

test('the received offset follows the file when an earlier write went missing', async (t) => {
  const { call, folder } = await setup(t);
  const { json: { id } } = await startUpload(call, 'x.bin', 10);
  folder().set(`.upload-${id}`, Buffer.from('ab'));
  const resync = await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.from('zz'));
  refusal(409, 'OFFSET')(resync);
  assert.equal(resync.json.received, 2);
  assert.deepEqual((await call('PUT', `/sessions/s1/uploads/${id}?offset=2`, Buffer.from('cd'))).json, { received: 4, done: false });
});

test('an empty file is published by an empty chunk at offset 0', async (t) => {
  const { call, folder } = await setup(t);
  const { json: { id } } = await startUpload(call, 'empty.txt', 0);
  assert.deepEqual((await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.alloc(0))).json, { received: 0, done: true, name: 'empty.txt', size: 0 });
  assert.equal(folder().get('empty.txt').length, 0);
});

test('a publish whose helper fails keeps the upload, and a retried last chunk publishes it', async (t) => {
  const { call, folder, runtime, supervisor } = await setup(t);
  const { json: { id } } = await startUpload(call, 'fw.bin', 3);
  const publishUpload = runtime.publishUpload;
  runtime.publishUpload = async () => {
    throw new Error('the helper timed out');
  };
  refusal(500, 'INTERNAL')(await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.from('abc')));
  assert.deepEqual(uploadOf(supervisor), { id, name: 'fw.bin', size: 3, received: 3 });
  runtime.publishUpload = publishUpload;
  assert.deepEqual((await call('PUT', `/sessions/s1/uploads/${id}?offset=3`, Buffer.alloc(0))).json, { received: 3, done: true, name: 'fw.bin', size: 3 });
  assert.equal(folder().get('fw.bin').toString(), 'abc');
  assert.equal(folder().has(`.upload-${id}`), false);
  assert.equal(uploadOf(supervisor), null);
});

test('a publish that failed after the file got its name answers NAME_TAKEN on retry and drops the upload', async (t) => {
  const { call, folder, runtime, supervisor } = await setup(t);
  const { json: { id } } = await startUpload(call, 'fw.bin', 3);
  const publishUpload = runtime.publishUpload;
  runtime.publishUpload = async (...args) => {
    await publishUpload(...args);
    throw new Error('the helper timed out');
  };
  refusal(500, 'INTERNAL')(await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.from('abc')));
  runtime.publishUpload = publishUpload;
  refusal(409, 'NAME_TAKEN')(await call('PUT', `/sessions/s1/uploads/${id}?offset=3`, Buffer.alloc(0)));
  assert.equal(uploadOf(supervisor), null);
  refusal(404, 'NO_UPLOAD')(await call('PUT', `/sessions/s1/uploads/${id}?offset=3`, Buffer.alloc(0)));
  assert.equal(folder().get('fw.bin').toString(), 'abc');
});

test('a session has one active upload: a new one cancels the old and frees its reservation', async (t) => {
  const { call, folder } = await setup(t, { filesLimit: GIB });
  const first = (await startUpload(call, 'one.bin', GIB)).json.id;
  const second = await startUpload(call, 'two.bin', GIB);
  assert.equal(second.status, 200);
  assert.equal(folder().has(`.upload-${first}`), false);
  refusal(404, 'NO_UPLOAD')(await call('PUT', `/sessions/s1/uploads/${first}?offset=0`, Buffer.from('a')));
  assert.deepEqual((await call('DELETE', `/sessions/s1/uploads/${second.json.id}`)).json, { ok: true });
  assert.equal(folder().has(`.upload-${second.json.id}`), false);
  assert.deepEqual((await call('DELETE', '/sessions/s1/uploads/unknown')).json, { ok: true });
  refusal(404, 'NO_UPLOAD')(await call('PUT', `/sessions/s1/uploads/${second.json.id}?offset=0`, Buffer.from('a')));
});

test('an upload must fit in the limit left after the files already there', async (t) => {
  const { call, runtime } = await setup(t, { filesLimit: GIB });
  runtime.padding = GIB - 100;
  refusal(507, 'FILES_LIMIT')(await startUpload(call, 'x.bin', 101));
  assert.equal((await startUpload(call, 'x.bin', 100)).status, 200);
});

test('an upload size must be a whole number of bytes', async (t) => {
  const { call } = await setup(t);
  for (const size of [-1, 1.5, '10', null, undefined, 2 ** 53]) {
    refusal(400, 'BAD_SIZE')(await startUpload(call, 'x.bin', size));
  }
  for (const body of [Buffer.from('not json'), Buffer.from('[]'), Buffer.alloc(5000, 32)]) {
    refusal(400, 'BAD_REQUEST')(await call('POST', '/sessions/s1/uploads', body));
  }
});

test('an upload never replaces an existing file, also when the name appears during the upload', async (t) => {
  const { call, folder } = await setup(t);
  folder().set('taken.bin', Buffer.alloc(1));
  refusal(409, 'NAME_TAKEN')(await startUpload(call, 'taken.bin', 1));
  const { json: { id } } = await startUpload(call, 'later.bin', 2);
  folder().set('later.bin', Buffer.from('xx'));
  refusal(409, 'NAME_TAKEN')(await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.from('ab')));
  assert.equal(folder().get('later.bin').toString(), 'xx');
  refusal(404, 'NO_UPLOAD')(await call('PUT', `/sessions/s1/uploads/${id}?offset=2`, Buffer.alloc(0)));
});

test('a chunk over 8 MiB is refused as TOO_LARGE, by its length or by its bytes', async (t) => {
  const { call, port } = await setup(t);
  const { json: { id } } = await startUpload(call, 'big.bin', 20 * MIB);
  refusal(413, 'TOO_LARGE')(await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.alloc(8 * MIB + 1)));
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/sessions/s1/uploads/${id}?offset=0`, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    for (let part = 0; part < 9; part += 1) req.write(Buffer.alloc(MIB));
    req.end();
  });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.json.error, 'TOO_LARGE');
  assert.deepEqual((await call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.alloc(8 * MIB))).json, { received: 8 * MIB, done: false });
});

test('a chunk that waits for the queue sees a session that stopped meanwhile', async (t) => {
  const { call, supervisor, runtime } = await setup(t);
  const { json: { id } } = await startUpload(call, 'x.bin', 2);
  const gate = deferred();
  supervisor.serialize('s1', () => gate.promise);
  const chunk = call('PUT', `/sessions/s1/uploads/${id}?offset=0`, Buffer.from('ab'));
  const stopped = supervisor.handle({ op: 'stop', session: 's1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  refusal(404, 'NO_SESSION')(await chunk);
  assert.equal((await stopped).ok, true);
  assert.deepEqual(runtime.calls, ['launch 0', 'teardown 0']);
});

test('an unknown route is refused and an internal failure hides its details', async (t) => {
  const { call, runtime, logged } = await setup(t);
  refusal(404, 'NO_ROUTE')(await call('GET', '/sessions/s1'));
  refusal(404, 'NO_ROUTE')(await call('PATCH', '/sessions/s1/files'));
  refusal(404, 'NO_ROUTE')(await call('GET', '/other/s1/files'));
  runtime.scanFiles = async () => {
    throw new Error('secret detail');
  };
  const failed = await call('GET', '/sessions/s1/files');
  refusal(500, 'INTERNAL')(failed);
  assert.doesNotMatch(failed.raw.toString(), /secret/);
  assert.ok(logged.some((line) => /secret detail/.test(line)));
});
