'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { Supervisor } = require('./supervisor');
const { serve } = require('./server');
const { filesServer } = require('./files');
const { fileStore } = require('./state');
const runtime = require('./runtime');

const SOCKET_PATH = '/run/nbc-control/supervisor.sock';
const FILES_SOCKET_PATH = '/run/nbc-control/files.sock';
const STATE_PATH = '/run/nbc-control/state.json';
const APP_UID = 1000;
const LEASE_CHECK_MS = 5_000;
const FILES_POLL_MS = 3_000;

const log = (message) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);

function listenOn(server, socketPath) {
  fs.rmSync(socketPath, { force: true });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    fs.chownSync(socketPath, APP_UID, APP_UID);
    log(`listening on ${socketPath}`);
  });
}

async function main() {
  process.umask(0o077);
  for (const problem of await runtime.prepareHost()) log(problem);
  const supervisor = new Supervisor({ runtime, store: fileStore(STATE_PATH, log), log });
  const leases = setInterval(() => supervisor.expireLeases(), LEASE_CHECK_MS);
  const polls = setInterval(() => supervisor.pollFiles(), FILES_POLL_MS);

  const control = net.createServer((socket) => serve(supervisor, socket, log));
  const files = filesServer(supervisor, log);
  listenOn(control, SOCKET_PATH);
  listenOn(files, FILES_SOCKET_PATH);

  const shutdown = (signal) => {
    log(`${signal}: stopping every session`);
    clearInterval(leases);
    clearInterval(polls);
    control.close();
    files.close();
    const sessions = [...supervisor.sessions.keys()];
    Promise.allSettled(sessions.map((session) => supervisor.handle({ op: 'stop', session })))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  log(`could not start: ${error.stack}`);
  process.exit(1);
});
