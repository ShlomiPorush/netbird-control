'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { exited, watchChild } = require('../supervisor/runtime');

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unrefed = false;
  child.unref = () => {
    child.unrefed = true;
  };
  return child;
}

test('a child that cannot start ends the session and counts as exited', () => {
  const child = fakeChild();
  const reasons = [];
  watchChild(child, 'Xvnc', (reason) => reasons.push(reason));
  assert.equal(child.unrefed, true);
  assert.equal(exited(child), false);
  const error = Object.assign(new Error('spawn setpriv EAGAIN'), { code: 'EAGAIN' });
  assert.doesNotThrow(() => child.emit('error', error));
  assert.deepEqual(reasons, ['Xvnc could not start (EAGAIN)']);
  assert.equal(exited(child), true);
});

test('an error without a code is reported by its message', () => {
  const child = fakeChild();
  const reasons = [];
  watchChild(child, 'Chromium', (reason) => reasons.push(reason));
  child.emit('error', new Error('no such file'));
  assert.deepEqual(reasons, ['Chromium could not start (no such file)']);
});

test('a child that exits ends the session with its code or signal', () => {
  const child = fakeChild();
  const reasons = [];
  watchChild(child, 'the window manager', (reason) => reasons.push(reason));
  child.emit('exit', 1, null);
  child.emit('exit', null, 'SIGKILL');
  assert.deepEqual(reasons, ['the window manager exited (1)', 'the window manager exited (SIGKILL)']);
});
