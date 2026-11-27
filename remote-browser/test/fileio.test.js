'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { appendUpload, createUpload, dropUpload, publishUpload, removeFile } = require('../supervisor/fileio');

const onLinux = { skip: process.platform !== 'linux' && 'needs O_NOFOLLOW, FIFOs and Linux file modes' };
const FILEIO = path.join(__dirname, '..', 'supervisor', 'fileio.js');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbc-fileio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function helper(args, input) {
  const result = spawnSync(process.execPath, [FILEIO, ...args], { input });
  return { status: result.status, stdout: result.stdout };
}

const replyOf = (args, input) => {
  const { status, stdout } = helper(args, input);
  assert.equal(status, 0);
  return JSON.parse(stdout.toString());
};

function readOf(dir, name) {
  const { status, stdout } = helper(['read', dir, name]);
  const newline = stdout.indexOf(10);
  return { status, header: JSON.parse(stdout.subarray(0, newline).toString()), body: stdout.subarray(newline + 1) };
}

function hostileEntries(dir) {
  fs.writeFileSync(path.join(dir, 'secret'), 'secret');
  fs.symlinkSync(path.join(dir, 'secret'), path.join(dir, 'link'));
  execFileSync('mkfifo', [path.join(dir, 'fifo')]);
  fs.mkdirSync(path.join(dir, 'folder'));
}

test('read sends the size and then exactly the bytes of a regular file', onLinux, (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'firmware.out'), Buffer.from([0, 1, 2, 10, 255]));
  fs.writeFileSync(path.join(dir, 'empty'), '');
  assert.deepEqual(readOf(dir, 'firmware.out'), { status: 0, header: { size: 5 }, body: Buffer.from([0, 1, 2, 10, 255]) });
  assert.deepEqual(readOf(dir, 'empty'), { status: 0, header: { size: 0 }, body: Buffer.alloc(0) });
});

test('read refuses symlinks, FIFOs, folders and missing files without blocking', onLinux, (t) => {
  const dir = scratch(t);
  hostileEntries(dir);
  for (const name of ['link', 'fifo', 'folder', 'missing']) {
    assert.deepEqual(readOf(dir, name), { status: 0, header: { error: 'NOT_FOUND' }, body: Buffer.alloc(0) }, name);
  }
});

test('delete removes a regular file only and reports its size', onLinux, (t) => {
  const dir = scratch(t);
  hostileEntries(dir);
  for (const name of ['link', 'fifo', 'folder', 'missing']) {
    assert.deepEqual(removeFile(path.join(dir, name)), { error: 'NOT_FOUND' }, name);
  }
  assert.ok(fs.lstatSync(path.join(dir, 'link')).isSymbolicLink());
  assert.deepEqual(removeFile(path.join(dir, 'secret')), { size: 6 });
  assert.equal(fs.existsSync(path.join(dir, 'secret')), false);
});

test('an upload is written write-only at its offset and published read-only under its name', onLinux, async (t) => {
  const dir = scratch(t);
  const temporary = path.join(dir, '.upload-1');
  const final = path.join(dir, 'firmware.out');
  assert.deepEqual(createUpload(temporary, final), { ok: true });
  assert.equal(fs.statSync(temporary).mode & 0o777, 0o200);
  assert.deepEqual(await appendUpload(temporary, 0, Readable.from([Buffer.from('abc')])), { received: 3 });
  assert.deepEqual(await appendUpload(temporary, 2, Readable.from([Buffer.from('zz')])), { error: 'OFFSET', received: 3 });
  assert.deepEqual(await appendUpload(temporary, 3, Readable.from([Buffer.from('de')])), { received: 5 });
  assert.deepEqual(publishUpload(temporary, final), { received: 5 });
  assert.equal(fs.readFileSync(final, 'utf8'), 'abcde');
  assert.equal(fs.statSync(final).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(temporary), false);
});

test('an upload never replaces an existing name', onLinux, (t) => {
  const dir = scratch(t);
  const temporary = path.join(dir, '.upload-2');
  fs.writeFileSync(path.join(dir, 'taken'), 'old');
  fs.symlinkSync('/nowhere', path.join(dir, 'dangling'));
  assert.deepEqual(createUpload(temporary, path.join(dir, 'taken')), { error: 'NAME_TAKEN' });
  assert.deepEqual(createUpload(temporary, path.join(dir, 'dangling')), { error: 'NAME_TAKEN' });
  assert.deepEqual(createUpload(temporary, path.join(dir, 'new')), { ok: true });
  fs.writeFileSync(path.join(dir, 'new'), 'raced');
  assert.deepEqual(publishUpload(temporary, path.join(dir, 'new')), { error: 'NAME_TAKEN' });
  assert.equal(fs.readFileSync(path.join(dir, 'new'), 'utf8'), 'raced');
  assert.equal(fs.existsSync(temporary), false);
});

test('a publish whose temporary file is gone answers NAME_TAKEN when the name exists, otherwise NO_UPLOAD', onLinux, (t) => {
  const dir = scratch(t);
  const temporary = path.join(dir, '.upload-5');
  const final = path.join(dir, 'fw.bin');
  assert.deepEqual(createUpload(temporary, final), { ok: true });
  assert.deepEqual(publishUpload(temporary, final), { received: 0 });
  assert.deepEqual(publishUpload(temporary, final), { error: 'NAME_TAKEN' });
  assert.deepEqual(publishUpload(temporary, path.join(dir, 'other.bin')), { error: 'NO_UPLOAD' });
});

test('appending or publishing through a swapped temporary file is refused', onLinux, async (t) => {
  const dir = scratch(t);
  hostileEntries(dir);
  for (const name of ['link', 'fifo', 'folder', 'missing']) {
    const temporary = path.join(dir, name);
    assert.deepEqual(await appendUpload(temporary, 0, Readable.from([Buffer.from('x')])), { error: 'NO_UPLOAD' }, name);
    assert.deepEqual(publishUpload(temporary, path.join(dir, `published-${name}`)), { error: 'NO_UPLOAD' }, name);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'secret'), 'utf8'), 'secret');
});

test('the helper answers each operation as one JSON line', onLinux, (t) => {
  const dir = scratch(t);
  assert.deepEqual(replyOf(['create', dir, '.upload-3', 'x.bin']), { ok: true });
  assert.deepEqual(replyOf(['append', dir, '.upload-3', '0'], Buffer.from('12345')), { received: 5 });
  assert.deepEqual(replyOf(['append', dir, '.upload-3', '0'], Buffer.from('6')), { error: 'OFFSET', received: 5 });
  assert.deepEqual(replyOf(['publish', dir, '.upload-3', 'x.bin']), { received: 5 });
  assert.deepEqual(replyOf(['delete', dir, 'x.bin']), { size: 5 });
  assert.deepEqual(replyOf(['create', dir, '.upload-4', 'y.bin']), { ok: true });
  assert.deepEqual(replyOf(['drop', dir, '.upload-4']), { ok: true });
  assert.deepEqual(dropUpload(path.join(dir, '.upload-4')), { ok: true });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(helper(['explode', dir]).status, 1);
});
