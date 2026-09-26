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

function postText(port) {
  return new Promise((resolve, reject) => {
    const req = post(port);
    req.on('response', res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ text: 'x' }));
  });
}

async function failBeforeFirstChunk(harness) {
  const err = Object.assign(new Error('TextToSpeech failed'), {
    code: 'NATIVE_ERROR',
  });
  harness.convertStream = async () => {
    const stream = pcmStream();
    let resolveCompletion;
    stream.completion = new Promise(resolve => {
      resolveCompletion = resolve;
    });
    // Same order as startNativeStream's finish(err).
    setImmediate(() => {
      resolveCompletion({ err });
      stream.destroy(err);
    });
    return stream;
  };
  const before = harness.logs.length;
  let destroyed = 0;
  const spy = (req, res) => {
    const destroy = res.destroy.bind(res);
    res.destroy = (...args) => {
      destroyed += 1;
      return destroy(...args);
    };
  };
  harness.mini.server.prependListener('request', spy);
  const { res, body } = await postText(harness.port);
  await new Promise(resolve => setImmediate(resolve));
  harness.mini.server.removeListener('request', spy);
  assert.equal(destroyed, 0, 'a completed 500 response must not be destroyed');
  assert.equal(res.statusCode, 500);
  assert.equal(Number(res.headers['content-length']), body.byteLength);
  assert.equal(JSON.parse(body.toString('utf8')).code, 'NATIVE_ERROR');
  const failures = harness.logs
    .slice(before)
    .filter(line => line.includes('"request.failed"'));
  assert.equal(failures.length, 1);
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
    await failBeforeFirstChunk(harness);
  } finally {
    await new Promise(resolve => harness.mini.server.close(resolve));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
