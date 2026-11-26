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

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const failure = (code, message) => ({ ok: false, error: code, message });

function sessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function screenSize(width, height) {
  return {
    width: clamp(positiveInteger(width, 'width'), SCREEN.minWidth, SCREEN.maxWidth),
    height: clamp(positiveInteger(height, 'height'), SCREEN.minHeight, SCREEN.maxHeight),
  };
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
    case 'start': {
      if (typeof request.terminal !== 'boolean') {
        throw new RequestError('BAD_REQUEST', 'terminal must be true or false.');
      }
      return {
        op: 'start',
        session: sessionId(request.session),
        ...screenSize(request.width, request.height),
        scale: scaleFactor(request.dpi),
        terminal: request.terminal,
      };
    }
    case 'renew':
    case 'stop':
      return { op: request.op, session: sessionId(request.session) };
    case 'list':
    case 'ready':
      return { op: request.op };
    default:
      throw new RequestError('BAD_REQUEST', 'op must be start, renew, stop, list or ready.');
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
  MAX_LINE_BYTES,
  SCREEN,
  SLOT_COUNT,
  RequestError,
  failure,
  parseRequest,
  scaleFactor,
  screenSize,
  slotIds,
};
