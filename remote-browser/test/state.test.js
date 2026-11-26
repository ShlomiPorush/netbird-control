'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileStore } = require('../supervisor/state');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbc-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

test('a saved slot loads back and no temporary file remains', (t) => {
  const file = scratch(t);
  const store = fileStore(file, () => {});
  store.save(42);
  assert.equal(store.load(), 42);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { nextSlot: 42 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  store.save(7);
  assert.equal(fileStore(file, () => {}).load(), 7);
});

test('a missing file loads as null without a log line', (t) => {
  const logged = [];
  assert.equal(fileStore(scratch(t), (line) => logged.push(line)).load(), null);
  assert.deepEqual(logged, []);
});

test('invalid JSON or a wrong type loads as null and is logged', (t) => {
  const file = scratch(t);
  for (const content of ['not json', '{"nextSlot":"3"}', '{"nextSlot":1.5}', 'null', '[]']) {
    const logged = [];
    fs.writeFileSync(file, content);
    assert.equal(fileStore(file, (line) => logged.push(line)).load(), null);
    assert.equal(logged.length, 1);
  }
});
