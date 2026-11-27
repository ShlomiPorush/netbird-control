'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BLOCKED_POLICY,
  ENABLED_POLICY,
  chromiumArgs,
  chromiumCommand,
  chromiumEnv,
  chromiumHomeFiles,
  createOwnedDir,
  exited,
  parseScan,
  scanCommand,
  temporaryLeftovers,
  watchChild,
  wipe,
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
    URLAllowlist: ['file:///var/lib/browser-files/'],
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
  assert.equal('URLAllowlist' in BLOCKED_POLICY, false);
  assert.deepEqual(managed.URLBlocklist, ['file://*']);
});

test('Chromium runs under the files limit with SIGXFSZ ignored', () => {
  assert.deepEqual(chromiumCommand(2 * 1024 ** 3, ['--no-first-run', 'https://example.com/']), [
    'prlimit',
    ['--fsize=2147483648', '--', 'sh', '-c', 'trap "" XFSZ; exec chromium "$@"', 'chromium', '--no-first-run', 'https://example.com/'],
  ]);
});

test('a new browser home points the file dialogs and a Downloads bookmark at its own files folder', () => {
  const files = chromiumHomeFiles({ slot: 4 }, 'cookie');
  assert.deepEqual(Object.keys(files).sort(), ['.config/gtk-3.0/bookmarks', 'profile/Default/Preferences', 'xauth']);
  assert.equal(files.xauth, 'cookie');
  assert.equal(files['.config/gtk-3.0/bookmarks'], 'file:///var/lib/browser-files/chromium-4 Downloads\n');
  assert.deepEqual(JSON.parse(files['profile/Default/Preferences']), {
    selectfile: { last_directory: '/var/lib/browser-files/chromium-4' },
    savefile: { default_directory: '/var/lib/browser-files/chromium-4' },
  });
});

test('every folder and file of a new browser home belongs to its user, folders 0700 and files 0600', onLinux, (t) => {
  const root = scratch(t);
  const previous = process.umask(0o077);
  t.after(() => process.umask(previous));
  const uid = process.getuid() === 0 ? 62004 : process.getuid();
  const dir = path.join(root, 'chromium-4');
  createOwnedDir(dir, uid, chromiumHomeFiles({ slot: 4 }, 'cookie'));
  const expected = [
    ['.', 0o700],
    ['.config', 0o700],
    ['.config/gtk-3.0', 0o700],
    ['.config/gtk-3.0/bookmarks', 0o600],
    ['profile', 0o700],
    ['profile/Default', 0o700],
    ['profile/Default/Preferences', 0o600],
    ['xauth', 0o600],
  ];
  for (const [name, mode] of expected) {
    const stat = fs.statSync(path.join(dir, name));
    assert.deepEqual([stat.mode & 0o777, stat.uid, stat.gid], [mode, uid, uid], name);
  }
  assert.equal(fs.readFileSync(path.join(dir, '.config/gtk-3.0/bookmarks'), 'utf8'), 'file:///var/lib/browser-files/chromium-4 Downloads\n');
});

test('Chromium gets the browser language in its environment and asks websites for it before English', () => {
  const dir = '/run/browser/chromium-4';
  const hebrew = chromiumArgs({ dir, scale: 1.5, startPage: 'https://example.com/', language: 'he' });
  assert.ok(hebrew.includes('--accept-lang=he,en-US'));
  assert.equal(hebrew.at(-1), 'https://example.com/');
  assert.ok(chromiumArgs({ dir, scale: 1, startPage: '', language: 'en-US' }).includes('--accept-lang=en-US'));
  assert.equal(hebrew.filter((arg) => arg.startsWith('--accept-lang=')).length, 1);
  assert.deepEqual(chromiumEnv({ display: 5, dir, language: 'he' }), {
    DISPLAY: ':5',
    XAUTHORITY: path.join(dir, 'xauth'),
    HOME: dir,
    TMPDIR: dir,
    LANG: 'C.UTF-8',
    LANGUAGE: 'he',
  });
  assert.equal(chromiumEnv({ display: 5, dir, language: 'en-US' }).LANGUAGE, 'en-US');
});

test('a dark browser gets a dark Chromium and dark GTK windows, and a light one gets neither', () => {
  const dir = '/run/browser/chromium-4';
  assert.ok(chromiumArgs({ dir, scale: 1, startPage: '', language: 'en-US', theme: 'dark' }).includes('--force-dark-mode'));
  assert.equal(chromiumEnv({ display: 5, dir, language: 'en-US', theme: 'dark' }).GTK_THEME, 'Adwaita:dark');
  assert.ok(!chromiumArgs({ dir, scale: 1, startPage: '', language: 'en-US', theme: 'light' }).includes('--force-dark-mode'));
  assert.equal('GTK_THEME' in chromiumEnv({ display: 5, dir, language: 'en-US', theme: 'light' }), false);
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

test('the scan runs find itself, so its errors and exit code reach the supervisor', () => {
  const [command, args] = scanCommand('/var/lib/browser-files/chromium-3');
  assert.equal(command, 'find');
  assert.deepEqual(args.slice(0, 3), ['/var/lib/browser-files/chromium-3', '-ignore_readdir_race', '-printf']);
  assert.equal(args.length, 4);
});

const asNonRoot = { skip: (process.platform !== 'linux' && 'needs GNU find and Linux file modes') || (process.getuid?.() === 0 && 'root reads any folder') };

test('a folder the scan cannot read fails the scan instead of being left out', asNonRoot, (t) => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, 'a.bin'), 'x');
  const [command, args] = scanCommand(root);
  const clean = spawnSync(command, args);
  assert.equal(clean.status, 0);
  assert.deepEqual(parseScan(clean.stdout.toString()).files.map((file) => file.name), ['a.bin']);
  const hidden = path.join(root, 'hidden');
  fs.mkdirSync(hidden);
  fs.writeFileSync(path.join(hidden, 'big.bin'), Buffer.alloc(1024 * 1024));
  fs.chmodSync(hidden, 0);
  try {
    assert.notEqual(spawnSync(command, args).status, 0);
  } finally {
    fs.chmodSync(hidden, 0o700);
  }
});

test('a files folder still owned by root is removed with rmdir as root, and is never read', async (t) => {
  const root = scratch(t);
  const empty = path.join(root, 'chromium-0');
  fs.mkdirSync(empty);
  await wipe({ dir: empty, uid: 62000 }, () => 0);
  assert.equal(fs.existsSync(empty), false);
  const full = path.join(root, 'chromium-1');
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'kept'), 'x');
  await assert.rejects(wipe({ dir: full, uid: 62001 }, () => 0), { code: 'ENOTEMPTY' });
  assert.equal(fs.readFileSync(path.join(full, 'kept'), 'utf8'), 'x');
  await wipe({ dir: path.join(root, 'missing'), uid: 62002 }, () => null);
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
