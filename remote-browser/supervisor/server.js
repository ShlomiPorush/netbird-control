'use strict';

const { MAX_LINE_BYTES, RequestError, failure, parseRequest } = require('./protocol');

const tooLong = () => failure('BAD_REQUEST', `A request line may hold at most ${MAX_LINE_BYTES} bytes.`);

async function answer(supervisor, line, log) {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return tooLong();
  try {
    return await supervisor.handle(parseRequest(line));
  } catch (error) {
    if (error instanceof RequestError) return failure(error.code, error.message);
    log(`request failed: ${error.stack}`);
    return failure('INTERNAL', 'The supervisor could not handle the request.');
  }
}

function serve(supervisor, socket, log = () => {}) {
  let buffered = '';
  let refused = false;
  let queue = Promise.resolve();
  const reply = (response) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  };
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    if (refused) return;
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      queue = queue.then(() => answer(supervisor, line, log)).then(reply);
    }
    if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) {
      refused = true;
      buffered = '';
      queue = queue.then(() => {
        reply(tooLong());
        socket.end();
      });
    }
  });
}

module.exports = { serve };
