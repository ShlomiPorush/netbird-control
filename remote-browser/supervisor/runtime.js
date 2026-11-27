'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SLOT_COUNT, slotIds } = require('./protocol');

const SESSIONS_DIR = '/run/browser';
const FILES_ROOT = '/var/lib/browser-files';
const TMP_DIR = '/tmp';
const X_SOCKET_DIR = '/tmp/.X11-unix';
const SHM_DIR = '/dev/shm';
const POLICY_FILE = '/etc/chromium/policies/managed/files.json';
const POLICY_TEMPORARY = '/etc/chromium/policies/files.json.tmp';
const FILEIO = path.join(__dirname, 'fileio.js');
const GATEWAY_STATUS = '/run/nbc-status/gateway.json';
const KEYMAP_SCRIPT = '/usr/local/bin/hebrew-keymap';
const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 8;
const START_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 10_000;
const DISK_CACHE_BYTES = 64 * 1024 * 1024;
const HEADER_MAX_BYTES = 256;
const ROOT_UID = 0;

const BLOCKED_POLICY = { DownloadRestrictions: 3, AllowFileSelectionDialogs: false };
const ENABLED_POLICY = {
  DownloadRestrictions: 0,
  AllowFileSelectionDialogs: true,
  DownloadDirectory: `${FILES_ROOT}/\${user_name}`,
  DefaultFileSystemReadGuardSetting: 2,
  DefaultFileSystemWriteGuardSetting: 2,
  URLAllowlist: [`file://${FILES_ROOT}/`],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomPassword() {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let password = '';
  while (password.length < PASSWORD_LENGTH) {
    for (const byte of crypto.randomBytes(16)) {
      if (byte < limit && password.length < PASSWORD_LENGTH) password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
    }
  }
  return password;
}

function run(command, args, { input, env = { PATH: PATH_ENV }, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      if (code === 0) return resolve(out);
      const detail = Buffer.concat(stderr).toString().trim().split('\n').pop();
      reject(new Error(`${path.basename(command)} ${args[0] ?? ''} failed (${signal ?? code})${detail ? `: ${detail}` : ''}`));
    });
    child.stdin.end(input ?? '');
  });
}

const asUser = (uid) => ['--reuid', String(uid), '--regid', String(uid), '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--'];

function runAs(uid, command, args, options) {
  return run('setpriv', [...asUser(uid), command, ...args], options);
}

function spawnAs(uid, command, args, env) {
  return spawn('setpriv', [...asUser(uid), command, ...args], { env: { PATH: PATH_ENV, ...env }, stdio: 'ignore', detached: true });
}

function processesOf(uids) {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let status;
    try {
      status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
    } catch {
      continue;
    }
    const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (match && match.slice(1).some((uid) => uids.includes(Number(uid)))) found.push(Number(entry));
  }
  return found;
}

function listeningOnLoopback(port) {
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  return fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === local && fields[3] === '0A';
  });
}

function portInUse(port) {
  const suffix = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  return fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1]?.endsWith(suffix) && fields[3] === '0A';
  });
}

function abstractSocketBound(display) {
  const name = `@${X_SOCKET_DIR}/X${display}`;
  return fs.readFileSync('/proc/net/unix', 'utf8').split('\n').some((line) => line.trim().split(/\s+/)[7] === name);
}

const sessionDirs = ({ slot, displayUid, chromiumUid }) => [
  { dir: path.join(SESSIONS_DIR, `display-${slot}`), uid: displayUid },
  { dir: path.join(SESSIONS_DIR, `chromium-${slot}`), uid: chromiumUid },
];

const filesEntry = ({ slot, chromiumUid }) => ({ dir: path.join(FILES_ROOT, `chromium-${slot}`), uid: chromiumUid });

const ownedDirs = (ids) => [filesEntry(ids), ...sessionDirs(ids)];

const xFiles = (display) => [`/tmp/.X${display}-lock`, path.join(X_SOCKET_DIR, `X${display}`)];

function removeIfPresent(file) {
  fs.rmSync(file, { force: true });
}

function ownedEntryUnder(root, uids) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return false;
  }
  for (const name of names) {
    const file = path.join(root, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (uids.includes(stat.uid)) return true;
    if (stat.isDirectory() && ownedEntryUnder(file, uids)) return true;
  }
  return false;
}

const temporaryLeftovers = (uids, roots = [TMP_DIR, SHM_DIR]) => roots.some((root) => ownedEntryUnder(root, uids));

function writeFilesPolicy(enabled, file = POLICY_FILE, temporary = POLICY_TEMPORARY) {
  fs.writeFileSync(temporary, `${JSON.stringify(enabled ? ENABLED_POLICY : BLOCKED_POLICY)}\n`, { mode: 0o644 });
  fs.chmodSync(temporary, 0o644);
  fs.renameSync(temporary, file);
}

function createOwnedDir(dir, uid, files) {
  fs.mkdirSync(dir, { mode: 0o700 });
  try {
    const created = new Set();
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
      for (let entry = file; entry !== dir; entry = path.dirname(entry)) created.add(entry);
    }
    for (const entry of [...created].sort((a, b) => b.length - a.length)) fs.chownSync(entry, uid, uid);
    fs.chownSync(dir, uid, uid);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function chromiumHomeFiles({ slot }, auth) {
  const downloads = `${FILES_ROOT}/chromium-${slot}`;
  const preferences = { selectfile: { last_directory: downloads }, savefile: { default_directory: downloads } };
  return {
    xauth: auth,
    '.config/gtk-3.0/bookmarks': `file://${downloads} Downloads\n`,
    'profile/Default/Preferences': `${JSON.stringify(preferences)}\n`,
  };
}

async function xauthority(display, cookie) {
  const scratch = fs.mkdtempSync(path.join(SESSIONS_DIR, 'xauth-'));
  try {
    const file = path.join(scratch, 'xauth');
    await run('xauth', ['-q', '-f', file, 'source', '-'], { input: `add :${display} MIT-MAGIC-COOKIE-1 ${cookie}\n` });
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function assertOwnedBy(uid, pid, display, port) {
  const listeners = (await runAs(uid, 'ss', ['-H', '-l', '-n', '-p', '-x', '-t'])).toString().split('\n');
  const owner = `pid=${pid},`;
  for (const address of [`@${X_SOCKET_DIR}/X${display}`, `127.0.0.1:${port}`]) {
    const lines = listeners.filter((line) => line.split(/\s+/).includes(address));
    if (lines.length === 0 || !lines.every((line) => line.includes(owner))) {
      throw new Error(`${address} is not held by Xvnc`);
    }
  }
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const childrenThatFailedToStart = new WeakSet();

function exited(child) {
  return childrenThatFailedToStart.has(child) || child.exitCode !== null || child.signalCode !== null;
}

function watchChild(child, name, onExit) {
  child.on('exit', (code, signal) => onExit(`${name} exited (${signal ?? code})`));
  child.on('error', (error) => {
    childrenThatFailedToStart.add(child);
    onExit(`${name} could not start (${error.code || error.message})`);
  });
  child.unref();
}

function xvncArgs({ display, port, dir, width, height }) {
  return [
    `:${display}`,
    '-localhost',
    '-rfbport', String(port),
    '-SecurityTypes', 'VncAuth',
    '-PasswordFile', path.join(dir, 'passwd'),
    '-auth', path.join(dir, 'xauth'),
    '-geometry', `${width}x${height}`,
    '-depth', '24',
    '-nolisten', 'tcp',
    '-NeverShared',
  ];
}

const acceptLanguage = (language) => (language === 'en-US' ? 'en-US' : `${language},en-US`);

function chromiumArgs({ dir, scale, startPage, language, theme }) {
  return [
    `--user-data-dir=${path.join(dir, 'profile')}`,
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    `--force-device-scale-factor=${scale}`,
    `--disk-cache-size=${DISK_CACHE_BYTES}`,
    `--accept-lang=${acceptLanguage(language)}`,
    ...(theme === 'dark' ? ['--force-dark-mode'] : []),
    ...(startPage ? [startPage] : []),
  ];
}

function chromiumEnv({ display, dir, language, theme }) {
  return {
    DISPLAY: `:${display}`,
    XAUTHORITY: path.join(dir, 'xauth'),
    HOME: dir,
    TMPDIR: dir,
    LANG: 'C.UTF-8',
    LANGUAGE: language,
    ...(theme === 'dark' ? { GTK_THEME: 'Adwaita:dark' } : {}),
  };
}

function chromiumCommand(filesLimit, args) {
  return ['prlimit', [`--fsize=${filesLimit}`, '--', 'sh', '-c', 'trap "" XFSZ; exec chromium "$@"', 'chromium', ...args]];
}

async function launch({ ids, width, height, scale, startPage = '', filesLimit, language = 'en-US', theme = 'light', onExit }) {
  const { display, port, displayUid, chromiumUid } = ids;
  const [displayDir, chromiumDir] = sessionDirs(ids);
  xFiles(display).forEach(removeIfPresent);

  const password = randomPassword();
  const cookie = crypto.randomBytes(16).toString('hex');
  const vncPassword = await run('vncpasswd', ['-f'], { input: `${password}\n` });
  const auth = await xauthority(display, cookie);
  createOwnedDir(displayDir.dir, displayUid, { passwd: vncPassword, xauth: auth });
  createOwnedDir(chromiumDir.dir, chromiumUid, chromiumHomeFiles(ids, auth));
  createOwnedDir(filesEntry(ids).dir, chromiumUid, {});

  const displayEnv = { DISPLAY: `:${display}`, XAUTHORITY: path.join(displayDir.dir, 'xauth'), HOME: displayDir.dir };
  const xvnc = spawnAs(displayUid, 'Xvnc', xvncArgs({ display, port, dir: displayDir.dir, width, height }), displayEnv);
  watchChild(xvnc, 'Xvnc', onExit);

  await waitFor(
    () => exited(xvnc) || (fs.existsSync(xFiles(display)[1]) && abstractSocketBound(display) && listeningOnLoopback(port)),
    START_TIMEOUT_MS,
    'Xvnc',
  );
  if (exited(xvnc)) throw new Error('Xvnc exited during start');
  await assertOwnedBy(displayUid, xvnc.pid, display, port);

  await runAs(displayUid, KEYMAP_SCRIPT, [], { env: { PATH: PATH_ENV, ...displayEnv } });
  const windowManager = spawnAs(displayUid, 'matchbox-window-manager', ['-use_titlebar', 'no'], displayEnv);
  watchChild(windowManager, 'the window manager', onExit);

  const chromium = spawnAs(
    chromiumUid,
    ...chromiumCommand(filesLimit, chromiumArgs({ dir: chromiumDir.dir, scale, startPage, language, theme })),
    chromiumEnv({ display, dir: chromiumDir.dir, language, theme }),
  );
  watchChild(chromium, 'Chromium', onExit);
  return { password };
}

async function killAll(uids) {
  const deadline = Date.now() + KILL_TIMEOUT_MS;
  while (processesOf(uids).length > 0) {
    if (Date.now() > deadline) return false;
    for (const uid of uids) {
      await runAs(uid, 'sh', ['-c', 'kill -KILL -1 2>/dev/null; exit 0']).catch(() => {});
    }
    await sleep(100);
  }
  return true;
}

const SWEEP_SCRIPT = [
  'find "$@" -xdev -user "$(id -u)" -type d -exec chmod u+rwx {} \\; 2>/dev/null',
  'find "$@" -xdev -depth -user "$(id -u)" -delete 2>/dev/null',
  'exit 0',
].join('\n');

async function sweepTemporary(uids) {
  for (const uid of uids) {
    await runAs(uid, 'sh', ['-c', SWEEP_SCRIPT, 'sweep', TMP_DIR, SHM_DIR]);
  }
}

function ownerOf(dir) {
  try {
    return fs.lstatSync(dir).uid;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function wipe({ dir, uid }, owner = ownerOf) {
  const found = owner(dir);
  if (found === null) return;
  if (found !== ROOT_UID) await runAs(uid, 'sh', ['-c', 'chmod -R u+rwx -- "$1" && find "$1" -mindepth 1 -delete', 'wipe', dir]);
  fs.rmdirSync(dir);
}

const ignoreFailure = () => {};

async function closeFileWindows({ chromiumUid }) {
  await runAs(chromiumUid, 'sh', ['-c', 'pkill -x zenity; exit 0']);
}

async function teardown(ids, afterKill = async () => {}) {
  const uids = [ids.chromiumUid, ids.displayUid];
  const killed = await killAll(uids);
  await afterKill();
  await wipe(filesEntry(ids)).catch(ignoreFailure);
  await sweepTemporary(uids).catch(ignoreFailure);
  xFiles(ids.display).forEach(removeIfPresent);
  for (const entry of sessionDirs(ids)) {
    await wipe(entry).catch(ignoreFailure);
  }
  return killed
    && processesOf(uids).length === 0
    && ownedDirs(ids).every(({ dir }) => !fs.existsSync(dir))
    && !temporaryLeftovers(uids);
}

async function slotIsFree(ids) {
  const uids = [ids.chromiumUid, ids.displayUid];
  return processesOf(uids).length === 0
    && ownedDirs(ids).every(({ dir }) => !fs.existsSync(dir))
    && !temporaryLeftovers(uids)
    && !abstractSocketBound(ids.display)
    && !portInUse(ids.port);
}

const SCAN_FORMAT = '%d\\t%y\\t%s\\t%b\\t%T@\\t%f\\0';
const SCAN_FIELDS = 5;

function parseScan(text) {
  let used = 0;
  let sawRoot = false;
  const files = [];
  for (const entry of text.split('\0')) {
    const fields = [];
    let rest = entry;
    while (fields.length < SCAN_FIELDS && rest.includes('\t')) {
      const tab = rest.indexOf('\t');
      fields.push(rest.slice(0, tab));
      rest = rest.slice(tab + 1);
    }
    if (fields.length < SCAN_FIELDS) continue;
    const [depth, type, size, blocks, mtime] = fields;
    used += Number(blocks) * 512;
    if (depth === '0') sawRoot = true;
    if (depth === '1' && type === 'f' && !rest.startsWith('.')) {
      files.push({ name: rest, size: Number(size), mtime: Math.round(Number(mtime) * 1000), partial: rest.endsWith('.crdownload') });
    }
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sawRoot ? { used, files } : null;
}

const scanCommand = (dir) => ['find', [dir, '-ignore_readdir_race', '-printf', SCAN_FORMAT]];

async function scanFiles(ids) {
  const { dir, uid } = filesEntry(ids);
  if (!fs.existsSync(dir)) return null;
  const out = await runAs(uid, ...scanCommand(dir));
  const scan = parseScan(out.toString());
  if (!scan) throw new Error('the scan did not list the files folder');
  return scan;
}

async function fileio(ids, op, args, input) {
  const { dir, uid } = filesEntry(ids);
  const out = await runAs(uid, process.execPath, [FILEIO, op, dir, ...args], { input });
  return JSON.parse(out.toString());
}

const deleteFile = (ids, name) => fileio(ids, 'delete', [name]);
const createUpload = (ids, temporary, name) => fileio(ids, 'create', [temporary, name]);
const appendUpload = (ids, temporary, offset, chunk) => fileio(ids, 'append', [temporary, String(offset)], chunk);
const publishUpload = (ids, temporary, name) => fileio(ids, 'publish', [temporary, name]);
const dropUpload = (ids, temporary) => fileio(ids, 'drop', [temporary]);

function readFile(ids, name) {
  const { dir, uid } = filesEntry(ids);
  const child = spawn('setpriv', [...asUser(uid), process.execPath, FILEIO, 'read', dir, name], {
    env: { PATH: PATH_ENV },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    const fail = (error) => {
      child.kill('SIGKILL');
      reject(error);
    };
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const newline = head.indexOf(10);
      if (newline === -1) {
        if (head.length > HEADER_MAX_BYTES) fail(new Error('the file helper sent no header'));
        return;
      }
      child.stdout.off('data', onData);
      child.stdout.pause();
      const rest = head.subarray(newline + 1);
      if (rest.length > 0) child.stdout.unshift(rest);
      let header;
      try {
        header = JSON.parse(head.subarray(0, newline).toString());
      } catch {
        fail(new Error('the file helper sent a malformed header'));
        return;
      }
      resolve({ ...header, stream: child.stdout, exited, stop: () => child.kill('SIGKILL') });
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    exited.then(() => reject(new Error('the file helper ended before its header')));
  });
}

function readGateway() {
  try {
    return JSON.parse(fs.readFileSync(GATEWAY_STATUS, 'utf8'));
  } catch {
    return null;
  }
}

async function routesOf(table) {
  try {
    const out = await run('ip', ['route', 'show', 'table', String(table)]);
    return out.toString().split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function ready() {
  return {
    netns: fs.statSync('/proc/self/ns/net').ino,
    gateway: readGateway(),
    table7120: await routesOf(7120),
  };
}

function leftoverSlot(name) {
  const match = /^chromium-(\d{1,4})$/.exec(name);
  const slot = match ? Number(match[1]) : -1;
  return slot >= 0 && slot < SLOT_COUNT ? slot : null;
}

async function wipeLeftoverFiles(root = FILES_ROOT, wipeEntry = wipe) {
  const problems = [];
  for (const name of fs.readdirSync(root)) {
    const slot = leftoverSlot(name);
    if (slot === null) {
      problems.push(`${root}/${name} is not a session's files folder; left as it is`);
      continue;
    }
    try {
      await wipeEntry({ dir: path.join(root, name), uid: slotIds(slot).chromiumUid });
    } catch (error) {
      problems.push(`${root}/${name} could not be wiped: ${error.message}`);
    }
  }
  return problems;
}

async function prepareHost() {
  writeFilesPolicy(false);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o711 });
  fs.mkdirSync(X_SOCKET_DIR, { recursive: true });
  fs.chmodSync(X_SOCKET_DIR, 0o1777);
  fs.mkdirSync(FILES_ROOT, { recursive: true, mode: 0o711 });
  return wipeLeftoverFiles();
}

module.exports = {
  BLOCKED_POLICY,
  ENABLED_POLICY,
  appendUpload,
  chromiumArgs,
  chromiumCommand,
  chromiumEnv,
  chromiumHomeFiles,
  closeFileWindows,
  createOwnedDir,
  createUpload,
  deleteFile,
  dropUpload,
  exited,
  launch,
  parseScan,
  prepareHost,
  publishUpload,
  randomPassword,
  readFile,
  ready,
  scanCommand,
  scanFiles,
  slotIsFree,
  teardown,
  temporaryLeftovers,
  watchChild,
  wipe,
  wipeLeftoverFiles,
  writeFilesPolicy,
  xvncArgs,
};
