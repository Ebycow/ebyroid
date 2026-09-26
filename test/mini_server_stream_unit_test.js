/* eslint-disable no-console, no-param-reassign */
const assert = require('assert').strict;
const http = require('http');
const { PassThrough } = require('stream');
const { Logger } = require('../lib/logger');
const MiniServer = require('../lib/mini_server');

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

function pcmStream() {
  const stream = new PassThrough();
  stream.sampleRate = 22050;
  stream.bitDepth = 16;
  stream.numChannels = 1;
  return stream;
}

function post(port) {
  return http.request({
    host: '127.0.0.1',
    port,
    path: '/api/v2/audiostream',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

async function disconnectBeforeSynthesisStarts(harness) {
  const called = deferred();
  const gate = deferred();
  const stream = pcmStream();
  const nativeDone = deferred();
  // Native synthesis cannot be interrupted; it finishes on its own schedule.
  stream.completion = nativeDone.promise;
  harness.convertStream = async () => {
    called.resolve();
    await gate.promise;
    return stream;
  };

  const req = post(harness.port);
  req.on('error', () => {});
  req.end(JSON.stringify({ text: 'x' }));
  await called.promise;
  req.destroy();
  await waitFor(() =>
    harness.logs.some(line => line.includes('"phase":"response"'))
  );

  gate.resolve();
  stream.write(Buffer.alloc(1024 * 1024));
  await waitFor(() => stream.destroyed);
  assert.equal(harness.mini.queue.active, 1);
  nativeDone.resolve({});
  await waitFor(() => harness.mini.queue.active === 0);
}

async function main() {
  const harness = { logs: [], convertStream: null };
  const logger = new Logger({ write: line => harness.logs.push(line) });
  const ebyroid = {
    using: { name: 'default' },
    convertStream: (...args) => harness.convertStream(...args),
  };
  harness.mini = new MiniServer(ebyroid, { logger });
  harness.mini.start(0);
  await new Promise(resolve => harness.mini.server.once('listening', resolve));
  try {
    harness.port = harness.mini.server.address().port;
    await disconnectBeforeSynthesisStarts(harness);
  } finally {
    await new Promise(resolve => harness.mini.server.close(resolve));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
