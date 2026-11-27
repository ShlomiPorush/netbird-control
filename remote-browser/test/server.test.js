'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { serve } = require('../supervisor/server');

function fakeSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.ended = false;
  socket.destroyed = false;
  socket.setEncoding = () => {};
  socket.write = (text) => socket.written.push(JSON.parse(text));
  socket.end = () => {
    socket.ended = true;
  };
  return socket;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('each line gets one response, in order, also when split across chunks', async () => {
  const handled = [];
  const supervisor = {
    async handle(request) {
      handled.push(request.op);
      if (request.op === 'list') await settle();
      return { ok: true, op: request.op };
    },
  };
  const socket = fakeSocket();
  serve(supervisor, socket);
  socket.emit('data', '{"op":"list"}\n{"op":"re');
  socket.emit('data', 'ady"}\nnot json\n');
  await settle();
  await settle();
  assert.deepEqual(handled, ['list', 'ready']);
  assert.deepEqual(socket.written.map((r) => r.op ?? r.error), ['list', 'ready', 'BAD_REQUEST']);
});

test('a line longer than 4 KiB is refused and the connection is closed', async () => {
  const supervisor = { handle: async () => ({ ok: true }) };
  const socket = fakeSocket();
  serve(supervisor, socket);
  socket.emit('data', 'x'.repeat(5000));
  socket.emit('data', '\n{"op":"list"}\n');
  await settle();
  assert.deepEqual(socket.written, [{ ok: false, error: 'BAD_REQUEST', message: 'A request line may hold at most 4096 bytes.' }]);
  assert.equal(socket.ended, true);
});

test('an unexpected error becomes INTERNAL without its details', async () => {
  const logged = [];
  const supervisor = {
    handle: async () => {
      throw new Error('secret detail');
    },
  };
  const socket = fakeSocket();
  serve(supervisor, socket, (line) => logged.push(line));
  socket.emit('data', '{"op":"list"}\n');
  await settle();
  assert.deepEqual(socket.written, [{ ok: false, error: 'INTERNAL', message: 'The supervisor could not handle the request.' }]);
  assert.match(logged[0], /secret detail/);
});
