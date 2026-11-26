'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const NOT_A_FILE = new Set(['ENOENT', 'ELOOP', 'ENXIO', 'ENOTDIR', 'EISDIR', 'EACCES']);
const UPLOAD_MODE = 0o200;
const PUBLISHED_MODE = 0o644;

class Refused extends Error {}

function openRegular(file, flags) {
  let fd;
  try {
    fd = fs.openSync(file, flags | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (NOT_A_FILE.has(error.code)) throw new Refused();
    throw error;
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw new Refused();
  }
  return { fd, size: stat.size };
}

function refusedAs(code, task) {
  try {
    return task();
  } catch (error) {
    if (error instanceof Refused) return { error: code };
    throw error;
  }
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return { error: 'NOT_FOUND' };
    fs.unlinkSync(file);
    return { size: stat.size };
  } catch (error) {
    if (error.code === 'ENOENT') return { error: 'NOT_FOUND' };
    throw error;
  }
}

function createUpload(temporary, final) {
  if (exists(final)) return { error: 'NAME_TAKEN' };
  const fd = fs.openSync(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, UPLOAD_MODE);
  fs.fchmodSync(fd, UPLOAD_MODE);
  fs.closeSync(fd);
  return { ok: true };
}

async function appendUpload(temporary, offset, input) {
  const opened = refusedAs('NO_UPLOAD', () => openRegular(temporary, O_WRONLY | O_APPEND));
  if (opened.error) return opened;
  try {
    if (opened.size !== offset) return { error: 'OFFSET', received: opened.size };
    await pipeline(input, fs.createWriteStream(null, { fd: opened.fd, autoClose: false }));
    return { received: fs.fstatSync(opened.fd).size };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function publishUpload(temporary, final) {
  const opened = refusedAs('NO_UPLOAD', () => openRegular(temporary, O_WRONLY));
  if (opened.error) return exists(final) ? { error: 'NAME_TAKEN' } : opened;
  fs.fchmodSync(opened.fd, PUBLISHED_MODE);
  fs.closeSync(opened.fd);
  try {
    fs.linkSync(temporary, final);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fs.unlinkSync(temporary);
    return { error: 'NAME_TAKEN' };
  }
  fs.unlinkSync(temporary);
  return { received: opened.size };
}

function dropUpload(temporary) {
  fs.rmSync(temporary, { force: true });
  return { ok: true };
}

async function readFile(file, output) {
  const opened = refusedAs('NOT_FOUND', () => openRegular(file, O_RDONLY));
  if (opened.error) {
    output.write(`${JSON.stringify(opened)}\n`);
    return true;
  }
  output.write(`${JSON.stringify({ size: opened.size })}\n`);
  if (opened.size === 0) {
    fs.closeSync(opened.fd);
    return true;
  }
  let sent = 0;
  const source = fs.createReadStream(null, { fd: opened.fd, start: 0, end: opened.size - 1 });
  source.on('data', (chunk) => {
    sent += chunk.length;
  });
  await pipeline(source, output, { end: false });
  return sent === opened.size;
}

async function main([op, dir, ...args]) {
  const inDir = (name) => path.join(dir, name);
  const reply = (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return true;
  };
  switch (op) {
    case 'read':
      return readFile(inDir(args[0]), process.stdout);
    case 'delete':
      return reply(removeFile(inDir(args[0])));
    case 'create':
      return reply(createUpload(inDir(args[0]), inDir(args[1])));
    case 'append':
      return reply(await appendUpload(inDir(args[0]), Number(args[1]), process.stdin));
    case 'publish':
      return reply(publishUpload(inDir(args[0]), inDir(args[1])));
    case 'drop':
      return reply(dropUpload(inDir(args[0])));
    default:
      throw new Error(`unknown operation ${op}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((complete) => {
    if (complete === false) process.exitCode = 1;
  }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { appendUpload, createUpload, dropUpload, publishUpload, readFile, removeFile };
