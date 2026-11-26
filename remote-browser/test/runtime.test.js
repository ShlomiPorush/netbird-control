'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BLOCKED_POLICY,
  ENABLED_POLICY,
  chromiumCommand,
  exited,
  parseScan,
  temporaryLeftovers,
  watchChild,
  wipeLeftoverFiles,
  writeFilesPolicy,
  xvncArgs,
} = require('../supervisor/runtime');

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

test('Xvnc never shares a session, so a new viewer disconnects the one before', () => {
  const args = xvncArgs({ display: 1, port: 5901, dir: '/run/browser/display-0', width: 1280, height: 720 });
  assert.ok(args.includes('-NeverShared'));
  assert.ok(!args.some((a) => /AlwaysShared|DisconnectClients/.test(a)), 'DisconnectClients keeps its default, on');
  assert.deepEqual(args.slice(0, 3), [':1', '-localhost', '-rfbport']);
});

const onLinux = { skip: process.platform !== 'linux' && 'needs Linux file modes and owners' };

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbc-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('the files policy is replaced whole, blocked or enabled, and no temporary file remains', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'files.json');
  const temporary = path.join(dir, 'files.json.tmp');
  writeFilesPolicy(false, file, temporary);
  assert.deepEqual(readJson(file), { DownloadRestrictions: 3, AllowFileSelectionDialogs: false });
  writeFilesPolicy(true, file, temporary);
  assert.deepEqual(readJson(file), {
    DownloadRestrictions: 0,
    AllowFileSelectionDialogs: true,
    DownloadDirectory: '/var/lib/browser-files/${user_name}',
    DefaultFileSystemReadGuardSetting: 2,
    DefaultFileSystemWriteGuardSetting: 2,
  });
  assert.equal(fs.existsSync(temporary), false);
});

test('the policy file is world-readable even under the supervisor umask', onLinux, (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'files.json');
  const previous = process.umask(0o077);
  t.after(() => process.umask(previous));
  writeFilesPolicy(true, file, path.join(dir, 'files.json.tmp'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test('the image ships the blocked files policy, and the base policy leaves both keys to it', () => {
  assert.deepEqual(readJson(path.join(__dirname, '..', 'policies', 'files.json')), BLOCKED_POLICY);
  const managed = readJson(path.join(__dirname, '..', 'policies', 'managed.json'));
  for (const key of Object.keys(ENABLED_POLICY)) assert.equal(key in managed, false, key);
});

test('Chromium runs under the files limit with SIGXFSZ ignored', () => {
  assert.deepEqual(chromiumCommand(2 * 1024 ** 3, ['--no-first-run', 'https://example.com/']), [
    'prlimit',
    ['--fsize=2147483648', '--', 'sh', '-c', 'trap "" XFSZ; exec chromium "$@"', 'chromium', '--no-first-run', 'https://example.com/'],
  ]);
});

test('a scan sums the blocks of the whole tree and lists visible top-level regular files', () => {
  const line = (depth, type, size, blocks, mtime, name) => `${depth}\t${type}\t${size}\t${blocks}\t${mtime}\t${name}\0`;
  const scan = parseScan([
    line(0, 'd', 4096, 8, '1700000000.5', 'chromium-0'),
    line(1, 'f', 1000, 8, '1700000001.25', 'z.bin'),
    line(1, 'f', 5, 8, '1700000002.0', 'a\ttab.out.crdownload'),
    line(1, 'f', 9, 8, '1700000003.0', '.upload-1'),
    line(1, 'd', 4096, 8, '1700000004.0', 'page_files'),
    line(2, 'f', 7, 16, '1700000005.0', 'inner.png'),
    line(1, 'l', 4, 0, '1700000006.0', 'link'),
  ].join(''));
  assert.equal(scan.used, (8 * 5 + 16) * 512);
  assert.deepEqual(scan.files, [
    { name: 'a\ttab.out.crdownload', size: 5, mtime: 1_700_000_002_000, partial: true },
    { name: 'z.bin', size: 1000, mtime: 1_700_000_001_250, partial: false },
  ]);
});

test('a scan without the folder itself has no result', () => {
  assert.equal(parseScan(''), null);
  assert.equal(parseScan('1\tf\t1\t8\t1.0\tx\0'), null);
});

test('leftover files folders are wiped as their slot uid and anything else is reported', async (t) => {
  const root = scratch(t);
  for (const name of ['chromium-0', 'chromium-999', 'chromium-1000', 'other']) fs.mkdirSync(path.join(root, name));
  const wiped = [];
  const problems = await wipeLeftoverFiles(root, async (entry) => {
    wiped.push(entry);
    if (entry.uid === 62999) throw new Error('find failed');
  });
  assert.deepEqual(wiped.sort((a, b) => a.uid - b.uid), [
    { dir: path.join(root, 'chromium-0'), uid: 62000 },
    { dir: path.join(root, 'chromium-999'), uid: 62999 },
  ]);
  assert.equal(problems.length, 3);
  assert.ok(problems.some((line) => /chromium-999 could not be wiped: find failed/.test(line)));
  assert.ok(problems.some((line) => /chromium-1000 is not a session's files folder/.test(line)));
});

test('temporary leftovers are found by owner at any depth', onLinux, (t) => {
  const root = scratch(t);
  const uid = process.getuid();
  assert.equal(temporaryLeftovers([uid], [root]), false);
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  assert.equal(temporaryLeftovers([uid], [root]), true);
  assert.equal(temporaryLeftovers([uid + 1], [root]), false);
  assert.equal(temporaryLeftovers([uid], [path.join(root, 'missing')]), false);
});
