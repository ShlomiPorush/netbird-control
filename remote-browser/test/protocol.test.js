'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_LINE_BYTES, isFileName, parseRequest, scaleFactor, slotIds } = require('../supervisor/protocol');

const start = (fields) => JSON.stringify({ op: 'start', session: 'abc', width: 1280, height: 720, dpi: 96, terminal: false, until: 2_000_000, ...fields });
const GIB = 1024 ** 3;
const rejects = (line, code = 'BAD_REQUEST') => assert.throws(() => parseRequest(line), (error) => error.code === code);

test('a start request is parsed with its screen and scale', () => {
  assert.deepEqual(parseRequest(start()), { op: 'start', session: 'abc', width: 1280, height: 720, scale: 1, terminal: false, until: 2_000_000, startPage: '', filesLimit: 2 * GIB, language: 'en-US' });
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
  assert.deepEqual(parseRequest('{"op":"credentials","session":"s1","until":5000}'), { op: 'credentials', session: 's1', until: 5000 });
  assert.deepEqual(parseRequest('{"op":"stop","session":"s1"}'), { op: 'stop', session: 's1' });
  assert.deepEqual(parseRequest('{"op":"list","session":"ignored"}'), { op: 'list', ack: {} });
  assert.deepEqual(parseRequest('{"op":"ready"}'), { op: 'ready' });
  assert.deepEqual(parseRequest('{"op":"requests","session":"ignored"}'), { op: 'requests', wait: 0 });
  assert.deepEqual(parseRequest('{"op":"requests","wait":25000}'), { op: 'requests', wait: 25000 });
  rejects('{"op":"requests","wait":30001}');
  rejects('{"op":"requests","wait":-1}');
  rejects('{"op":"requests","wait":"25000"}');
  rejects('{"op":"renew","until":5000}');
  rejects('{"op":"status"}');
  rejects('{"op":"credentials","session":"a b"}');
});

test('start, renew and credentials require until as a positive integer', () => {
  for (const until of [undefined, null, '5000', 0, -1, 1.5]) {
    rejects(start({ until }));
    rejects(JSON.stringify({ op: 'renew', session: 's1', until }));
    rejects(JSON.stringify({ op: 'credentials', session: 's1', until }));
  }
});

test('an unknown op names every op', () => {
  assert.throws(() => parseRequest('{"op":"explode"}'), { message: 'op must be start, renew, status, credentials, stop, list, ready, files or requests.' });
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

test('a start page is an http or https address, never a switch, a file or a sign-in', () => {
  assert.equal(parseRequest(start({ startPage: 'https://portal.example.com/login?a=1' })).startPage, 'https://portal.example.com/login?a=1');
  assert.equal(parseRequest(start({ startPage: 'http://Example.com' })).startPage, 'http://example.com/');
  assert.equal(parseRequest(start({ startPage: '' })).startPage, '');
  for (const bad of ['--remote-debugging-port=9222', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'https://user:pass@example.com/', 'example.com', 42, `https://example.com/${'a'.repeat(2048)}`]) {
    assert.throws(() => parseRequest(start({ startPage: bad })), { code: 'BAD_REQUEST' });
  }
});

test('the files limit of a start is a whole number of bytes from 1 to 10 GiB', () => {
  assert.equal(parseRequest(start({ filesLimit: GIB })).filesLimit, GIB);
  assert.equal(parseRequest(start({ filesLimit: 10 * GIB })).filesLimit, 10 * GIB);
  for (const filesLimit of [GIB - 1, 10 * GIB + 1, 1.5 * GIB + 0.5, '2147483648', null, 0]) {
    rejects(start({ filesLimit }));
  }
});

test('the browser language of a start is one of four, and English when it is missing', () => {
  for (const language of ['en-US', 'he']) assert.equal(parseRequest(start({ language })).language, language);
  for (const language of ['ar', 'ru']) assert.throws(() => parseRequest(start({ language })), { code: 'BAD_REQUEST' });
  assert.equal(parseRequest(start()).language, 'en-US');
  for (const language of ['fr', 'en', 'HE', 'he,en-US', '', null, 7, ['he']]) rejects(start({ language }));
});

test('a files request carries enabled, transfer and a non-negative rev', () => {
  assert.deepEqual(parseRequest('{"op":"files","enabled":true,"transfer":false,"rev":0,"extra":1}'), { op: 'files', enabled: true, transfer: false, rev: 0 });
  for (const fields of [{ enabled: 'true' }, { transfer: 1 }, { rev: -1 }, { rev: 1.5 }, { rev: '3' }, { rev: undefined }]) {
    rejects(JSON.stringify({ op: 'files', enabled: true, transfer: true, rev: 1, ...fields }));
  }
});

test('list acks map session ids to sequence numbers', () => {
  assert.deepEqual(parseRequest('{"op":"list","ack":{"s1":3,"s2":0}}'), { op: 'list', ack: { s1: 3, s2: 0 } });
  for (const ack of [[], null, 'x', { s1: -1 }, { s1: 1.5 }, { 'a b': 1 }]) {
    rejects(JSON.stringify({ op: 'list', ack }));
  }
});

test('a file name is one visible path segment of at most 255 bytes', () => {
  for (const name of ['firmware.out', 'FGT_60F-v7.4.4.out', 'קובץ.pdf', 'a b', 'x'.repeat(255), 'ü'.repeat(127)]) {
    assert.equal(isFileName(name), true, name);
  }
  for (const name of ['', '.', '..', '.hidden', '.upload-1', 'a/b', '/', 'a\0b', 'x'.repeat(256), 'ü'.repeat(128), null, 7]) {
    assert.equal(isFileName(name), false, String(name));
  }
});
