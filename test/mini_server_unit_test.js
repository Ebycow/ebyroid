/* eslint-disable no-console */
const assert = require('assert').strict;
const http = require('http');
const { PassThrough } = require('stream');
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

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const logLines = [];
  const logger = new Logger({
    level: 'trace',
    write: line => logLines.push(line),
  });
  const conversionError = Object.assign(new Error('日本語のエラー'), {
    code: 'TEST_ERROR',
  });
  const ebyroid = {
    using: { name: 'default' },
    convert: () => Promise.reject(conversionError),
    convertEx: () => Promise.reject(conversionError),
    convertStream: () => Promise.reject(conversionError),
    convertStreamEx: () => Promise.reject(conversionError),
  };
  const mini = new MiniServer(ebyroid, { logger });

  mini.start(0);
  await new Promise(resolve => mini.server.once('listening', resolve));

  try {
    const { port } = mini.server.address();
    const health = await request(port, '/api/v1/health');
    assert.equal(health.res.statusCode, 200);

    const { res, body } = await request(port, '/api/v1/audiofile?text=test');
    assert.equal(res.statusCode, 500);
    assert.equal(Number(res.headers['content-length']), body.byteLength);
    assert.equal(
      JSON.parse(body.toString('utf8')).message,
      conversionError.message
    );

    const stream = new PassThrough();
    stream.sampleRate = 22050;
    stream.bitDepth = 16;
    stream.numChannels = 1;
    ebyroid.convertStream = async text => {
      assert.equal(text, 'secret speech');
      setImmediate(() => {
        stream.write(Buffer.from([1, 2]));
        stream.end(Buffer.from([3, 4]));
      });
      return stream;
    };
    const streamed = await postJson(port, '/api/v2/audiostream', {
      text: 'secret speech',
    });
    assert.equal(streamed.res.statusCode, 200);
    assert.equal(streamed.res.headers['content-length'], undefined);
    assert.equal(streamed.res.headers['transfer-encoding'], 'chunked');
    assert.equal(streamed.res.headers['ebyroid-pcm-sample-rate'], '22050');
    assert.deepEqual(streamed.body, Buffer.from([1, 2, 3, 4]));

    const wrongMethod = await request(port, '/api/v2/audiostream');
    assert.equal(wrongMethod.res.statusCode, 405);
    assert.equal(wrongMethod.res.headers.allow, 'POST');

    const invalidBody = await postJson(port, '/api/v2/audiostream', {});
    assert.equal(invalidBody.res.statusCode, 400);

    const malformed = await request(port, 'http://[invalid');
    assert.equal(malformed.res.statusCode, 500);

    const metrics = mini.logMetrics();
    assert(metrics.received >= 4);
    assert(metrics.completed >= 4);
    assert.equal(metrics.active, 0);
    assert.equal(metrics.queued, 0);

    assert(logLines.some(line => line.includes('request.received')));
    assert(logLines.some(line => line.includes('request.validated')));
    assert(logLines.some(line => line.includes('response.completed')));
    assert(logLines.some(line => line.includes('metrics.snapshot')));
    assert(logLines.every(line => !line.includes('secret speech')));
  } finally {
    await new Promise(resolve => mini.server.close(resolve));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
