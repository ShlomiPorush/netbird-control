'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { isFileName, isSessionId } = require('./protocol');

const CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const JSON_MAX_BYTES = 4096;
const PARTIAL_SUFFIX = '.crdownload';
const LISTED_FILES_MAX = 500;

const REFUSALS = {
  NO_ROUTE: [404, 'No such route.'],
  NO_SESSION: [404, 'The browser session is not running.'],
  FILES_OFF: [403, 'Files in the browser are turned off.'],
  TRANSFER_OFF: [403, 'Transfer to and from computers is turned off.'],
  BAD_NAME: [400, 'The file name is not allowed.'],
  BAD_REQUEST: [400, 'The request body must be a JSON object of at most 4096 bytes.'],
  BAD_SIZE: [400, 'The size does not fit the file.'],
  NOT_FOUND: [404, 'No such file.'],
  PARTIAL: [409, 'The file is still downloading.'],
  BUSY: [409, 'The file is being downloaded to a computer.'],
  NAME_TAKEN: [409, 'A file with this name already exists.'],
  OFFSET: [409, 'The upload continues from another offset.'],
  NO_UPLOAD: [404, 'No such upload.'],
  TOO_LARGE: [413, `A chunk may hold at most ${CHUNK_MAX_BYTES} bytes.`],
  FILES_LIMIT: [507, 'The file does not fit in the space left for this browser.'],
  INTERNAL: [500, 'The supervisor could not handle the request.'],
};

class Refusal extends Error {
  constructor(code, extra = {}) {
    super(REFUSALS[code][1]);
    this.code = code;
    this.status = REFUSALS[code][0];
    this.extra = extra;
  }
}

const refuse = (code, extra) => {
  throw new Refusal(code, extra);
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, maxBytes, tooLarge) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length <= maxBytes) chunks.push(chunk);
    });
    req.on('end', () => (length > maxBytes ? reject(new Refusal(tooLarge)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function afterBody(req, send) {
  if (req.complete) {
    send();
    return;
  }
  req.on('end', send);
  req.resume();
}

async function readJson(req) {
  const body = await readBody(req, JSON_MAX_BYTES, 'BAD_REQUEST');
  let value;
  try {
    value = JSON.parse(body.toString());
  } catch {
    refuse('BAD_REQUEST');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('BAD_REQUEST');
  return value;
}

function decodeSegment(segment, refusal) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return refuse(refusal);
  }
}

const newestFirst = (a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

async function dropActiveUpload(runtime, record) {
  const { upload } = record;
  if (!upload) return;
  record.upload = null;
  await runtime.dropUpload(record.ids, upload.temporary);
}

async function listFiles({ queued, runtime }) {
  return queued(async (record) => {
    const scan = (await runtime.scanFiles(record.ids)) ?? { used: 0, files: [] };
    const files = [...scan.files].sort(newestFirst).slice(0, LISTED_FILES_MAX).map(({ name, size, partial }) => ({ name, size, partial }));
    return { files, total: scan.files.length, used: scan.used, limit: record.filesLimit };
  });
}

async function downloadFile({ queued, record, runtime, name, res }) {
  if (name.endsWith(PARTIAL_SUFFIX)) refuse('PARTIAL');
  let registered = false;
  let released = false;
  const release = () => {
    if (!registered || released) return;
    released = true;
    const left = record.streams.get(name) - 1;
    if (left > 0) record.streams.set(name, left);
    else record.streams.delete(name);
  };
  let opened;
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
    opened?.stop();
    release();
  });
  await queued(async () => {
    if (clientGone) return;
    record.streams.set(name, (record.streams.get(name) ?? 0) + 1);
    registered = true;
  });
  if (clientGone) return null;
  try {
    opened = await runtime.readFile(record.ids, name);
  } catch (error) {
    release();
    throw error;
  }
  if (opened.error || clientGone) {
    release();
    opened.stop();
    if (opened.error) refuse(opened.error);
    return null;
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': opened.size });
  opened.stream.pipe(res, { end: false });
  const code = await opened.exited;
  release();
  if (code === 0) res.end();
  else res.destroy();
  return null;
}

async function deleteFile({ queued, runtime, name }) {
  if (name.endsWith(PARTIAL_SUFFIX)) refuse('PARTIAL');
  return queued(async (record) => {
    if (record.streams.has(name)) refuse('BUSY');
    const result = await runtime.deleteFile(record.ids, name);
    if (result.error) refuse(result.error);
    return { ok: true, size: result.size };
  });
}

async function startUpload({ queued, runtime, req }) {
  const { name, size } = await readJson(req);
  if (!isFileName(name)) refuse('BAD_NAME');
  if (!Number.isSafeInteger(size) || size < 0) refuse('BAD_SIZE');
  return queued(async (record) => {
    await dropActiveUpload(runtime, record);
    const scan = await runtime.scanFiles(record.ids);
    if (size > record.filesLimit - (scan?.used ?? 0)) refuse('FILES_LIMIT');
    const id = crypto.randomUUID();
    const temporary = `.upload-${id}`;
    const created = await runtime.createUpload(record.ids, temporary, name);
    if (created.error) refuse(created.error);
    record.upload = { id, name, size, received: 0, temporary };
    return { id, received: 0 };
  });
}

function offsetOf(searchParams) {
  const value = searchParams.get('offset');
  return value !== null && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

async function writeChunk({ queued, runtime, item: id, req, searchParams }) {
  const chunk = await readBody(req, CHUNK_MAX_BYTES, 'TOO_LARGE');
  const offset = offsetOf(searchParams);
  return queued(async (record) => {
    const kept = record.published.get(id);
    if (kept) return kept;
    const { upload } = record;
    if (!upload || upload.id !== id) refuse('NO_UPLOAD');
    if (offset !== upload.received) refuse('OFFSET', { received: upload.received });
    if (offset + chunk.length > upload.size) refuse('BAD_SIZE');
    if (chunk.length > 0) {
      const appended = await runtime.appendUpload(record.ids, upload.temporary, offset, chunk);
      if (appended.error === 'NO_UPLOAD') record.upload = null;
      if (appended.received !== undefined) upload.received = appended.received;
      if (appended.error) refuse(appended.error, appended.error === 'OFFSET' ? { received: upload.received } : {});
    }
    if (upload.received < upload.size) return { received: upload.received, done: false };
    const result = await runtime.publishUpload(record.ids, upload.temporary, upload.name);
    record.upload = null;
    if (result.error) refuse(result.error);
    const published = { received: upload.size, done: true, name: upload.name, size: upload.size };
    record.published.set(id, published);
    return published;
  });
}

async function cancelUpload({ queued, runtime, item: id }) {
  return queued(async (record) => {
    if (record.upload?.id === id) await dropActiveUpload(runtime, record);
    return { ok: true };
  });
}

const ROUTES = {
  'GET files': { transfer: false, run: listFiles },
  'GET files/:item': { transfer: true, named: true, run: downloadFile },
  'DELETE files/:item': { transfer: false, named: true, run: deleteFile },
  'POST uploads': { transfer: true, run: startUpload },
  'PUT uploads/:item': { transfer: true, run: writeChunk },
  'DELETE uploads/:item': { transfer: true, run: cancelUpload },
};

function routeOf(req) {
  const queryAt = req.url.indexOf('?');
  const pathname = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
  const searchParams = new URLSearchParams(queryAt === -1 ? '' : req.url.slice(queryAt + 1));
  const parts = pathname.split('/');
  if (parts.length < 4 || parts.length > 5 || parts[0] !== '' || parts[1] !== 'sessions') refuse('NO_ROUTE');
  const item = parts[4];
  const route = ROUTES[`${req.method} ${parts[3]}${item === undefined ? '' : '/:item'}`];
  if (!route) refuse('NO_ROUTE');
  return { route, rawSession: parts[2], rawItem: item, searchParams };
}

async function answer(supervisor, req, res) {
  const { route, rawSession, rawItem, searchParams } = routeOf(req);
  const session = decodeSegment(rawSession, 'NO_SESSION');
  if (!isSessionId(session)) refuse('NO_SESSION');
  const access = supervisor.filesAccess(session, route.transfer);
  if (access.refusal) refuse(access.refusal);
  const item = rawItem === undefined ? undefined : decodeSegment(rawItem, route.named ? 'BAD_NAME' : 'NO_UPLOAD');
  if (route.named && !isFileName(item)) refuse('BAD_NAME');
  const queued = (task) => supervisor.serialize(session, () => {
    const current = supervisor.filesAccess(session, route.transfer);
    if (current.refusal) refuse(current.refusal);
    if (current.record !== access.record) refuse('NO_SESSION');
    return task(current.record);
  });
  return route.run({ queued, runtime: supervisor.runtime, record: access.record, name: item, item, req, res, searchParams });
}

function filesServer(supervisor, log = () => {}) {
  return http.createServer((req, res) => {
    answer(supervisor, req, res).then((body) => {
      if (body !== null) afterBody(req, () => sendJson(res, 200, body));
    }, (error) => {
      const refusal = error instanceof Refusal ? error : new Refusal('INTERNAL');
      if (refusal.code === 'INTERNAL') log(`files request ${req.method} ${req.url} failed: ${error.stack}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      afterBody(req, () => sendJson(res, refusal.status, { error: refusal.code, message: refusal.message, ...refusal.extra }));
    });
  });
}

module.exports = { CHUNK_MAX_BYTES, filesServer };
