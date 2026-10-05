/* eslint-disable no-console */
const assert = require('assert').strict;
const http = require('http');
const VoiceRouter = require('../lib/voice_router');

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  // A stand-in for a voice worker that echoes what it received.
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Ebyroid-PCM-Sample-Rate': 22050,
      });
      res.end('pcm');
    });
  });
  const upstreamPort = await listen(upstream);

  const acquired = [];
  let released = 0;
  let nextError = null;
  let workerPort = upstreamPort;
  let workers = [];
  const pool = {
    status() {
      return workers;
    },
    acquire(voice) {
      acquired.push(voice);
      const err = nextError;
      nextError = null;
      return {
        promise: err
          ? Promise.reject(err)
          : Promise.resolve({
              port: workerPort,
              voice,
              workerId: 1,
              release() {
                released += 1;
              },
            }),
        cancel() {},
      };
    },
  };
  const router = new VoiceRouter(pool, {
    voiceNames: ['kiritan', 'aoi'],
    defaultName: 'kiritan',
  });
  router.start(0);
  await new Promise(resolve => router.server.once('listening', resolve));
  const { port } = router.server.address();

  // Health checks never wake a worker.
  const health = await request(port, { path: '/api/v1/' });
  assert.equal(health.res.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.deepEqual(acquired, []);

  // The monitoring health check follows the default voice's worker.
  const healthStatus = async () =>
    (await request(port, { path: '/api/v1/health' })).res.statusCode;
  assert.equal(await healthStatus(), 503);
  workers = [{ voice: 'aoi', ready: true, stopping: false }];
  assert.equal(await healthStatus(), 503);
  workers.push({ voice: 'kiritan', ready: false, stopping: false });
  assert.equal(await healthStatus(), 503);
  workers[1].ready = true;
  const up = await request(port, { path: '/api/v1/health' });
  assert.equal(up.res.statusCode, 200);
  assert.deepEqual(JSON.parse(up.body), { status: 'ok' });
  workers[1].stopping = true;
  assert.equal(await healthStatus(), 503);
  assert.deepEqual(acquired, []);

  // GET requests go to the named voice and come back unchanged.
  const get = await request(port, {
    path: '/api/v1/audiostream?text=a&name=aoi',
  });
  assert.equal(get.res.statusCode, 200);
  assert.equal(get.body.toString(), 'pcm');
  assert.equal(get.res.headers['ebyroid-pcm-sample-rate'], '22050');
  assert.equal(seen[0].url, '/api/v1/audiostream?text=a&name=aoi');
  assert.equal(seen[0].headers.connection, 'close');
  assert.deepEqual(acquired, ['aoi']);
  assert.equal(released, 1);

  // No name or an unknown name goes to the default voice's worker.
  await request(port, { path: '/api/v1/audiofile?text=a' });
  await request(port, { path: '/api/v1/audiofile?text=a&name=nobody' });
  assert.deepEqual(acquired.slice(1), ['kiritan', 'kiritan']);

  // The v2 body is read for the voice name and forwarded intact.
  const json = JSON.stringify({ text: 'こんにちは', name: 'aoi' });
  const post = await request(port, {
    method: 'POST',
    path: '/api/v2/audiostream',
    headers: {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked',
    },
    body: json,
  });
  assert.equal(post.res.statusCode, 200);
  const forwarded = seen[seen.length - 1];
  assert.equal(forwarded.body, json);
  assert.equal(
    forwarded.headers['content-length'],
    String(Buffer.byteLength(json))
  );
  assert.equal(forwarded.headers['transfer-encoding'], undefined);
  assert.equal(acquired[acquired.length - 1], 'aoi');

  // Invalid JSON is still forwarded so the worker reports the error.
  await request(port, {
    method: 'POST',
    path: '/api/v2/audiostream',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(acquired[acquired.length - 1], 'kiritan');
  assert.equal(seen[seen.length - 1].body, '{');

  // Oversized bodies are rejected before choosing a worker.
  const count = acquired.length;
  const large = await request(port, {
    method: 'POST',
    path: '/api/v2/audiostream',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.alloc(64 * 1024 + 1, 'a'),
  });
  assert.equal(large.res.statusCode, 413);
  assert.equal(acquired.length, count);

  // No worker in time: 503 with Retry-After, like the worker queue.
  nextError = Object.assign(new Error('no worker became available in time'), {
    statusCode: 503,
  });
  const busy = await request(port, { path: '/api/v1/audiofile?text=a' });
  assert.equal(busy.res.statusCode, 503);
  assert.equal(busy.res.headers['retry-after'], '1');

  // A worker that died while starting is a 502 as well.
  nextError = Object.assign(new Error('worker exited before ready'), {
    code: 'WORKER_EXITED',
  });
  const died = await request(port, { path: '/api/v1/audiofile?text=a' });
  assert.equal(died.res.statusCode, 502);

  // A worker that cannot be reached is a 502 and still releases its lease.
  const before = released;
  await close(upstream);
  workerPort = upstreamPort;
  const down = await request(port, { path: '/api/v1/audiofile?text=a' });
  assert.equal(down.res.statusCode, 502);
  assert.equal(released, before + 1);

  await router.stop();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
