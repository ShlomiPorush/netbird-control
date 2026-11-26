'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSIONS_DIR = '/run/browser';
const X_SOCKET_DIR = '/tmp/.X11-unix';
const SHM_DIR = '/dev/shm';
const GATEWAY_STATUS = '/run/nbc-status/gateway.json';
const KEYMAP_SCRIPT = '/usr/local/bin/hebrew-keymap';
const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 8;
const START_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 10_000;
const DISK_CACHE_BYTES = 64 * 1024 * 1024;

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

const xFiles = (display) => [`/tmp/.X${display}-lock`, path.join(X_SOCKET_DIR, `X${display}`)];

function removeIfPresent(file) {
  fs.rmSync(file, { force: true });
}

function createOwnedDir(dir, uid, files) {
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    fs.chownSync(file, uid, uid);
  }
  fs.chownSync(dir, uid, uid);
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

async function launch({ ids, width, height, scale, onExit }) {
  const { display, port, displayUid, chromiumUid } = ids;
  const [displayDir, chromiumDir] = sessionDirs(ids);
  xFiles(display).forEach(removeIfPresent);

  const password = randomPassword();
  const cookie = crypto.randomBytes(16).toString('hex');
  const vncPassword = await run('vncpasswd', ['-f'], { input: `${password}\n` });
  const auth = await xauthority(display, cookie);
  createOwnedDir(displayDir.dir, displayUid, { passwd: vncPassword, xauth: auth });
  createOwnedDir(chromiumDir.dir, chromiumUid, { xauth: auth });

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

  const chromium = spawnAs(chromiumUid, 'chromium', [
    `--user-data-dir=${path.join(chromiumDir.dir, 'profile')}`,
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    `--force-device-scale-factor=${scale}`,
    `--disk-cache-size=${DISK_CACHE_BYTES}`,
  ], {
    DISPLAY: `:${display}`,
    XAUTHORITY: path.join(chromiumDir.dir, 'xauth'),
    HOME: chromiumDir.dir,
    TMPDIR: chromiumDir.dir,
    LANG: 'C.UTF-8',
  });
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

function removeShmOf(uids) {
  for (const name of fs.readdirSync(SHM_DIR)) {
    const file = path.join(SHM_DIR, name);
    try {
      if (uids.includes(fs.lstatSync(file).uid)) fs.rmSync(file, { force: true });
    } catch {
      continue;
    }
  }
}

async function wipe({ dir, uid }) {
  if (!fs.existsSync(dir)) return;
  await runAs(uid, 'sh', ['-c', 'chmod -R u+rwx -- "$1" && find "$1" -mindepth 1 -delete', 'wipe', dir]);
  fs.rmdirSync(dir);
}

async function teardown(ids) {
  const uids = [ids.chromiumUid, ids.displayUid];
  const killed = await killAll(uids);
  xFiles(ids.display).forEach(removeIfPresent);
  removeShmOf(uids);
  for (const entry of sessionDirs(ids)) {
    await wipe(entry);
  }
  return killed && processesOf(uids).length === 0 && sessionDirs(ids).every(({ dir }) => !fs.existsSync(dir));
}

async function slotIsFree(ids) {
  const uids = [ids.chromiumUid, ids.displayUid];
  return processesOf(uids).length === 0
    && sessionDirs(ids).every(({ dir }) => !fs.existsSync(dir))
    && !abstractSocketBound(ids.display)
    && !portInUse(ids.port);
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

function prepareHost() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o711 });
  fs.mkdirSync(X_SOCKET_DIR, { recursive: true });
  fs.chmodSync(X_SOCKET_DIR, 0o1777);
}

module.exports = { launch, teardown, slotIsFree, ready, prepareHost, randomPassword, watchChild, exited, xvncArgs };
