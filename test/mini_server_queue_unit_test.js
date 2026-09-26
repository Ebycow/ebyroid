/* eslint-disable no-console */
const assert = require('assert').strict;
const http = require('http');
const { Logger } = require('../lib/logger');
const MiniServer = require('../lib/mini_server');

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    // Give the local HTTP server a chance to admit the request.
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}

function wave() {
  return {
    data: new Int16Array([1, 2]),
    sampleRate: 22050,
    bitDepth: 16,
    numChannels: 1,
  };
}

async function main() {
  const gate = deferred();
  const started = deferred();
  const logs = [];
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const ebyroid = {
    using: { name: 'default' },
    async convert() {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) {
        started.resolve();
        await gate.promise;
      }
      active -= 1;
      return wave();
    },
    convertEx() {
      return this.convert();
    },
  };
  const logger = new Logger({
    level: 'debug',
    write: line => logs.push(line),
  });
  const mini = new MiniServer(ebyroid, {
    logger,
    queueLimit: 1,
    queueTimeoutMs: 1000,
  });
  mini.start(0);
  await new Promise(resolve => mini.server.once('listening', resolve));

  try {
    const { port } = mini.server.address();
    const first = request(port, '/api/v1/audiostream?text=private-one');
    await started.promise;
    const second = request(port, '/api/v1/audiostream?text=private-two');
    await waitFor(() => mini.queue.depth === 1);
    const overloaded = await request(
      port,
      '/api/v1/audiostream?text=private-three'
    );
    assert.equal(overloaded.res.statusCode, 503);
    assert.equal(overloaded.res.headers['retry-after'], '1');

    gate.resolve();
    assert.equal((await first).res.statusCode, 200);
    assert.equal((await second).res.statusCode, 200);
    assert.equal(maximumActive, 1);
    assert(logs.some(line => line.includes('queue.enqueued')));
    assert(logs.some(line => line.includes('queue_full')));
    assert(logs.every(line => !line.includes('private-')));
  } finally {
    await new Promise(resolve => mini.server.close(resolve));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
