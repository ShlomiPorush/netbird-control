'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_LINE_BYTES, parseRequest, scaleFactor, slotIds } = require('../supervisor/protocol');

const start = (fields) => JSON.stringify({ op: 'start', session: 'abc', width: 1280, height: 720, dpi: 96, terminal: false, until: 2_000_000, ...fields });
const rejects = (line, code = 'BAD_REQUEST') => assert.throws(() => parseRequest(line), (error) => error.code === code);

test('a start request is parsed with its screen and scale', () => {
  assert.deepEqual(parseRequest(start()), { op: 'start', session: 'abc', width: 1280, height: 720, scale: 1, terminal: false, until: 2_000_000 });
});

test('the screen is capped at 1920x1080 and raised to the minimum', () => {
  const big = parseRequest(start({ width: 3840, height: 2160 }));
  assert.equal(big.width, 1920);
  assert.equal(big.height, 1080);
  const small = parseRequest(start({ width: 10, height: 10 }));
  assert.equal(small.width, 320);
  assert.equal(small.height, 240);
});

test('width, height and dpi must be positive integers', () => {
  for (const fields of [{ width: '1280' }, { height: 720.5 }, { width: 0 }, { height: -1 }, { dpi: null }, { dpi: 0 }]) {
    rejects(start(fields));
  }
});

test('the scale follows the dpi between 1 and 3', () => {
  assert.equal(scaleFactor(96), 1);
  assert.equal(scaleFactor(144), 1.5);
  assert.equal(scaleFactor(48), 1);
  assert.equal(scaleFactor(960), 3);
  assert.equal(scaleFactor(100), 1.04);
});

test('terminal must be a boolean', () => {
  rejects(start({ terminal: 'false' }));
  rejects(JSON.stringify({ op: 'start', session: 'abc', width: 1, height: 1, dpi: 96 }));
});

test('session ids are limited to 64 safe characters', () => {
  assert.equal(parseRequest(start({ session: 'A-z_09'.padEnd(64, 'x') })).session.length, 64);
  for (const session of ['', 'a'.repeat(65), 'a b', '../x', 'ü', 7, null]) {
    rejects(start({ session }));
  }
});

test('renew, status, credentials, stop, list and ready keep only what they need', () => {
  assert.deepEqual(parseRequest('{"op":"renew","session":"s1","until":5000,"extra":1}'), { op: 'renew', session: 's1', until: 5000 });
  assert.deepEqual(parseRequest('{"op":"status","session":"s1","until":5000}'), { op: 'status', session: 's1' });
  assert.deepEqual(parseRequest('{"op":"credentials","session":"s1"}'), { op: 'credentials', session: 's1' });
  assert.deepEqual(parseRequest('{"op":"stop","session":"s1"}'), { op: 'stop', session: 's1' });
  assert.deepEqual(parseRequest('{"op":"list","session":"ignored"}'), { op: 'list' });
  assert.deepEqual(parseRequest('{"op":"ready"}'), { op: 'ready' });
  rejects('{"op":"renew","until":5000}');
  rejects('{"op":"status"}');
  rejects('{"op":"credentials","session":"a b"}');
});

test('start and renew require until as a positive integer', () => {
  for (const until of [undefined, null, '5000', 0, -1, 1.5]) {
    rejects(start({ until }));
    rejects(JSON.stringify({ op: 'renew', session: 's1', until }));
  }
});

test('an unknown op names every op', () => {
  assert.throws(() => parseRequest('{"op":"explode"}'), { message: 'op must be start, renew, status, credentials, stop, list or ready.' });
});

test('malformed requests are refused', () => {
  for (const line of ['', 'not json', '[]', 'null', '"start"', '{"op":"explode"}', '{}']) {
    rejects(line);
  }
});

test('the line limit is 4 KiB', () => {
  assert.equal(MAX_LINE_BYTES, 4096);
});

test('a slot pairs a display uid, a Chromium uid, a display and a VNC port', () => {
  assert.deepEqual(slotIds(0), { slot: 0, displayUid: 61000, chromiumUid: 62000, display: 1, port: 5901 });
  assert.deepEqual(slotIds(999), { slot: 999, displayUid: 61999, chromiumUid: 62999, display: 1000, port: 6900 });
  assert.throws(() => slotIds(1000), RangeError);
  assert.throws(() => slotIds(-1), RangeError);
  assert.throws(() => slotIds(1.5), RangeError);
});
