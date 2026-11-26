'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { Supervisor } = require('./supervisor');
const { serve } = require('./server');
const runtime = require('./runtime');

const SOCKET_PATH = '/run/nbc-control/supervisor.sock';
const APP_UID = 1000;
const LEASE_CHECK_MS = 5_000;

const log = (message) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);

function main() {
  process.umask(0o077);
  runtime.prepareHost();
  const supervisor = new Supervisor({ runtime, log });
  const leases = setInterval(() => supervisor.expireLeases(), LEASE_CHECK_MS);

  fs.rmSync(SOCKET_PATH, { force: true });
  const server = net.createServer((socket) => serve(supervisor, socket, log));
  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
    fs.chownSync(SOCKET_PATH, APP_UID, APP_UID);
    log(`listening on ${SOCKET_PATH}`);
  });

  const shutdown = (signal) => {
    log(`${signal}: stopping every session`);
    clearInterval(leases);
    server.close();
    const sessions = [...supervisor.sessions.keys()];
    Promise.allSettled(sessions.map((session) => supervisor.handle({ op: 'stop', session })))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
