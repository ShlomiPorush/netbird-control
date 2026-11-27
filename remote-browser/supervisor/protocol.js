'use strict';

const MAX_LINE_BYTES = 4096;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCREEN = { minWidth: 320, minHeight: 240, maxWidth: 1920, maxHeight: 1080 };
const BASE_DPI = 96;
const SCALE = { min: 1, max: 3 };
const SLOT_COUNT = 1000;
const DISPLAY_UID_BASE = 61000;
const CHROMIUM_UID_BASE = 62000;
const VNC_PORT_BASE = 5900;
const START_PAGE_MAX = 2048;
const GIB = 1024 ** 3;
const FILES_LIMIT = { min: GIB, max: 10 * GIB, fallback: 2 * GIB };
const FILE_NAME_MAX_BYTES = 255;
const LANGUAGES = ['en-US', 'he'];
const REQUESTS_WAIT_MAX_MS = 30_000;

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const failure = (code, message) => ({ ok: false, error: code, message });

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

function sessionId(value) {
  if (!isSessionId(value)) {
    throw new RequestError('BAD_REQUEST', 'session must be 1-64 characters of A-Z, a-z, 0-9, _ or -.');
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RequestError('BAD_REQUEST', `${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RequestError('BAD_REQUEST', `${name} must be a non-negative integer.`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new RequestError('BAD_REQUEST', `${name} must be true or false.`);
  return value;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function screenSize(width, height) {
  return {
    width: clamp(positiveInteger(width, 'width'), SCREEN.minWidth, SCREEN.maxWidth),
    height: clamp(positiveInteger(height, 'height'), SCREEN.minHeight, SCREEN.maxHeight),
  };
}

function startPage(value) {
  if (value === undefined || value === '') return '';
  const fail = () => { throw new RequestError('BAD_REQUEST', `startPage must be an http or https address of at most ${START_PAGE_MAX} characters.`); };
  if (typeof value !== 'string' || value.length > START_PAGE_MAX) fail();
  let url;
  try { url = new URL(value); } catch { fail(); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.href.length > START_PAGE_MAX) fail();
  return url.href;
}

function filesLimit(value) {
  if (value === undefined) return FILES_LIMIT.fallback;
  if (!Number.isInteger(value) || value < FILES_LIMIT.min || value > FILES_LIMIT.max) {
    throw new RequestError('BAD_REQUEST', `filesLimit must be an integer number of bytes from ${FILES_LIMIT.min} to ${FILES_LIMIT.max}.`);
  }
  return value;
}

function language(value) {
  if (value === undefined) return 'en-US';
  if (!LANGUAGES.includes(value)) throw new RequestError('BAD_REQUEST', `language must be one of ${LANGUAGES.join(', ')}.`);
  return value;
}

function requestsWait(value) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > REQUESTS_WAIT_MAX_MS) {
    throw new RequestError('BAD_REQUEST', `wait must be an integer number of milliseconds from 0 to ${REQUESTS_WAIT_MAX_MS}.`);
  }
  return value;
}

function acks(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError('BAD_REQUEST', 'ack must map session ids to sequence numbers.');
  }
  const result = {};
  for (const [session, seq] of Object.entries(value)) {
    result[sessionId(session)] = nonNegativeInteger(seq, 'Each ack');
  }
  return result;
}

function isFileName(name) {
  return typeof name === 'string'
    && name.length > 0
    && !name.startsWith('.')
    && !name.includes('/')
    && !name.includes('\0')
    && Buffer.byteLength(name) <= FILE_NAME_MAX_BYTES;
}

function scaleFactor(dpi) {
  const raw = positiveInteger(dpi, 'dpi') / BASE_DPI;
  return Math.round(clamp(raw, SCALE.min, SCALE.max) * 100) / 100;
}

function parseRequest(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    throw new RequestError('BAD_REQUEST', 'The request is not valid JSON.');
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new RequestError('BAD_REQUEST', 'The request must be a JSON object.');
  }
  switch (request.op) {
    case 'start':
      return {
        op: 'start',
        session: sessionId(request.session),
        ...screenSize(request.width, request.height),
        scale: scaleFactor(request.dpi),
        terminal: boolean(request.terminal, 'terminal'),
        until: positiveInteger(request.until, 'until'),
        startPage: startPage(request.startPage),
        filesLimit: filesLimit(request.filesLimit),
        language: language(request.language),
      };
    case 'renew':
    case 'credentials':
      return { op: request.op, session: sessionId(request.session), until: positiveInteger(request.until, 'until') };
    case 'status':
    case 'stop':
      return { op: request.op, session: sessionId(request.session) };
    case 'list':
      return { op: 'list', ack: acks(request.ack) };
    case 'ready':
      return { op: 'ready' };
    case 'requests':
      return { op: 'requests', wait: requestsWait(request.wait) };
    case 'files':
      return {
        op: 'files',
        enabled: boolean(request.enabled, 'enabled'),
        transfer: boolean(request.transfer, 'transfer'),
        rev: nonNegativeInteger(request.rev, 'rev'),
      };
    default:
      throw new RequestError('BAD_REQUEST', 'op must be start, renew, status, credentials, stop, list, ready, files or requests.');
  }
}

function slotIds(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new RangeError(`slot ${slot} is outside 0-${SLOT_COUNT - 1}`);
  }
  return {
    slot,
    displayUid: DISPLAY_UID_BASE + slot,
    chromiumUid: CHROMIUM_UID_BASE + slot,
    display: slot + 1,
    port: VNC_PORT_BASE + slot + 1,
  };
}

module.exports = {
  FILES_LIMIT,
  MAX_LINE_BYTES,
  SCREEN,
  SLOT_COUNT,
  RequestError,
  failure,
  isFileName,
  isSessionId,
  parseRequest,
  scaleFactor,
  screenSize,
  slotIds,
};
