// HTTP API の外部仕様テスト
//
// クライアントから見える振る舞い (ステータス、ヘッダ、WAV/PCM の形式、エラー時の JSON) を固定する。
// 本番と同じ起動経路を偽のネイティブアドオンで動かし、単一プロセス (--workers 1) と
// cluster (--workers 3、前段のプロセスがワーカーへ中継する) の両方で同じ表を確かめたうえで、
// 両者の応答が一致することも確かめる。
// API 側 (64bit) と音声側 (32bit) をプロセスで分けるときも、このテストがそのまま通ることを目標にする。
const assert = require('assert').strict;
const { describe, test, before, after } = require('node:test'); // eslint-disable-line import/no-unresolved, node/no-missing-require
const { startServer, request, postJson } = require('./helpers/server');

// test/fixtures/fake_native.js が返す PCM
const CONVERT_PCM = Buffer.from(new Int16Array([0, 1, -1, 2]).buffer);
const STREAM_PCM = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
const JSON_TYPE = 'application/json; charset=utf-8';

function json(res) {
  assert.equal(res.headers['content-type'], JSON_TYPE);
  return JSON.parse(res.body.toString('utf8'));
}

function assertPcmHeaders(res) {
  assert.equal(res.headers['ebyroid-pcm-sample-rate'], '22050');
  assert.equal(res.headers['ebyroid-pcm-bit-depth'], '16');
  assert.equal(res.headers['ebyroid-pcm-number-of-channels'], '1');
}

/** 44 バイトの RIFF/WAVE ヘッダ (16bit リニア PCM、モノラル、22050Hz) */
function assertWave(body, pcm) {
  assert.equal(body.length, 44 + pcm.length);
  assert.equal(body.toString('ascii', 0, 4), 'RIFF');
  assert.equal(body.readUInt32LE(4), 36 + pcm.length);
  assert.equal(body.toString('ascii', 8, 12), 'WAVE');
  assert.equal(body.toString('ascii', 12, 16), 'fmt ');
  assert.equal(body.readUInt32LE(16), 16);
  assert.equal(body.readUInt16LE(20), 1, 'PCM');
  assert.equal(body.readUInt16LE(22), 1, 'channels');
  assert.equal(body.readUInt32LE(24), 22050, 'sample rate');
  assert.equal(body.readUInt32LE(28), 22050 * 2, 'byte rate');
  assert.equal(body.readUInt16LE(32), 2, 'block align');
  assert.equal(body.readUInt16LE(34), 16, 'bits per sample');
  assert.equal(body.toString('ascii', 36, 40), 'data');
  assert.equal(body.readUInt32LE(40), pcm.length);
  assert.deepEqual(body.subarray(44), pcm);
}

const q = encodeURIComponent;

/**
 * 仕様の表。send がリクエストを送り、check が応答を確かめる
 */
const CASES = [
  {
    name: 'GET /api/v1 answers ok',
    send: port => request(port, { path: '/api/v1' }),
    check: res => {
      assert.equal(res.status, 200);
      assert.deepEqual(json(res), { status: 'ok' });
    },
  },
  {
    name: 'GET /api/v1/ answers ok',
    send: port => request(port, { path: '/api/v1/' }),
    check: res => {
      assert.equal(res.status, 200);
      assert.deepEqual(json(res), { status: 'ok' });
    },
  },
  {
    name: 'GET /api/v1/health answers ok',
    send: port => request(port, { path: '/api/v1/health' }),
    check: res => {
      assert.equal(res.status, 200);
      assert.deepEqual(json(res), { status: 'ok' });
    },
  },
  {
    name: 'GET /api/v1/voices lists the configured voices in order',
    send: port => request(port, { path: '/api/v1/voices' }),
    check: res => {
      assert.equal(res.status, 200);
      assert.deepEqual(json(res), {
        default: 'aoi',
        voices: [
          { name: 'aoi', default: true },
          { name: 'akane', default: false },
        ],
      });
    },
  },
  {
    name: 'GET /api/v1/audiostream returns raw PCM with format headers',
    send: port => request(port, { path: `/api/v1/audiostream?text=${q('a')}` }),
    check: res => {
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'application/octet-stream');
      assert.equal(res.headers['content-length'], String(CONVERT_PCM.length));
      assertPcmHeaders(res);
      assert.deepEqual(res.body, CONVERT_PCM);
    },
  },
  {
    name: 'GET /api/v1/audiostream with another voice',
    send: port =>
      request(port, { path: `/api/v1/audiostream?text=${q('a')}&name=akane` }),
    check: res => {
      assert.equal(res.status, 200);
      assertPcmHeaders(res);
      assert.deepEqual(res.body, CONVERT_PCM);
    },
  },
  {
    name: 'GET /api/v1/audiofile returns a WAV file',
    send: port =>
      request(port, { path: `/api/v1/audiofile?text=${q('こんにちは')}` }),
    check: res => {
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'audio/wav');
      assert.equal(
        res.headers['content-length'],
        String(44 + CONVERT_PCM.length)
      );
      assertWave(res.body, CONVERT_PCM);
    },
  },
  {
    name: 'GET /api/v1/audiofile with another voice',
    send: port =>
      request(port, { path: `/api/v1/audiofile?text=${q('a')}&name=akane` }),
    check: res => {
      assert.equal(res.status, 200);
      assertWave(res.body, CONVERT_PCM);
    },
  },
  {
    name:
      'GET /api/v1/audiofile answers a document navigation with an empty body',
    send: port =>
      request(port, {
        path: `/api/v1/audiofile?text=${q('a')}`,
        headers: { 'Sec-Fetch-Dest': 'document' },
      }),
    check: res => {
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'audio/wav');
      assert.equal(res.body.length, 0);
    },
  },
  {
    name: 'POST /api/v2/audiostream streams PCM',
    send: port => postJson(port, { text: 'こんにちは' }),
    check: res => {
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'application/octet-stream');
      assert.equal(res.headers['cache-control'], 'no-store');
      assertPcmHeaders(res);
      assert.deepEqual(res.body, STREAM_PCM);
    },
  },
  {
    name: 'POST /api/v2/audiostream with another voice',
    send: port => postJson(port, { text: 'a', name: 'akane' }),
    check: res => {
      assert.equal(res.status, 200);
      assertPcmHeaders(res);
      assert.deepEqual(res.body, STREAM_PCM);
    },
  },
  {
    name: 'POST /api/v2/audiostream accepts a charset in the content type',
    send: port =>
      postJson(
        port,
        { text: 'a' },
        { 'Content-Type': 'application/json; charset=utf-8' }
      ),
    check: res => {
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, STREAM_PCM);
    },
  },

  // 入力の誤り
  {
    name: 'GET /api/v1/audiostream without text is 400',
    send: port => request(port, { path: '/api/v1/audiostream' }),
    check: res => {
      assert.equal(res.status, 400);
      assert.deepEqual(json(res), { error: 'text was not given' });
    },
  },
  {
    name: 'GET /api/v1/audiofile without text is 400',
    send: port => request(port, { path: '/api/v1/audiofile?text=' }),
    check: res => {
      assert.equal(res.status, 400);
      assert.deepEqual(json(res), { error: 'text was not given' });
    },
  },
  {
    name: 'POST /api/v2/audiostream without text is 400',
    send: port => postJson(port, { name: 'aoi' }),
    check: res => {
      assert.equal(res.status, 400);
      assert.deepEqual(json(res), { error: 'text was not given' });
    },
  },
  {
    name: 'POST /api/v2/audiostream with empty text is 400',
    send: port => postJson(port, { text: '' }),
    check: res => {
      assert.equal(res.status, 400);
      assert.deepEqual(json(res), { error: 'text was not given' });
    },
  },
  {
    name: 'POST /api/v2/audiostream with a non-string name is 400',
    send: port => postJson(port, { text: 'a', name: 1 }),
    check: res => {
      assert.equal(res.status, 400);
      assert.deepEqual(json(res), { error: 'name must be a string' });
    },
  },
  {
    name: 'POST /api/v2/audiostream with a JSON array is 400',
    send: port => postJson(port, '["a"]'),
    check: res => {
      assert.equal(res.status, 400);
      assert.deepEqual(json(res), {
        error: 'request body must be a JSON object',
      });
    },
  },
  {
    name: 'POST /api/v2/audiostream with broken JSON is 400',
    send: port => postJson(port, '{"text":'),
    check: res => {
      assert.equal(res.status, 400);
      assert.equal(typeof json(res).error, 'string');
    },
  },
  {
    name: 'POST /api/v2/audiostream without a JSON content type is 415',
    send: port =>
      request(port, {
        method: 'POST',
        path: '/api/v2/audiostream',
        headers: { 'Content-Type': 'text/plain' },
        body: 'a',
      }),
    check: res => {
      assert.equal(res.status, 415);
      assert.deepEqual(json(res), {
        error: 'content-type must be application/json',
      });
    },
  },
  {
    name: 'POST /api/v2/audiostream over 64KiB is 413',
    send: port => postJson(port, { text: 'x'.repeat(64 * 1024) }),
    check: res => {
      assert.equal(res.status, 413);
      assert.deepEqual(json(res), { error: 'request body is too large' });
    },
  },
  {
    name: 'GET /api/v2/audiostream is 405',
    send: port => request(port, { path: '/api/v2/audiostream' }),
    check: res => {
      assert.equal(res.status, 405);
      assert.equal(res.headers.allow, 'POST');
      assert.deepEqual(json(res), { error: 'method not allowed' });
    },
  },
  {
    name: 'POST to a v1 synthesis endpoint is 400',
    send: port =>
      request(port, {
        method: 'POST',
        path: `/api/v1/audiostream?text=${q('a')}`,
      }),
    check: res => {
      assert.equal(res.status, 400);
      assert.deepEqual(json(res), { error: 'bad request' });
    },
  },
  {
    name: 'an unknown path under /api/v1 is 404',
    send: port => request(port, { path: '/api/v1/nope' }),
    check: res => {
      assert.equal(res.status, 404);
      assert.deepEqual(json(res), { error: 'not found' });
    },
  },
  {
    name: 'a path outside the API is 404',
    send: port => request(port, { path: '/' }),
    check: res => {
      assert.equal(res.status, 404);
      assert.deepEqual(json(res), { error: 'not found' });
    },
  },

  // ネイティブ側の失敗 (偽のネイティブは本文の目印で失敗する)
  {
    name: 'a native exception is 500',
    send: port =>
      request(port, { path: `/api/v1/audiostream?text=${q('a #throw')}` }),
    check: res => {
      assert.equal(res.status, 500);
      assert.equal(json(res).error, 'internal server error');
    },
  },
  {
    name: 'a native callback error is 500',
    send: port =>
      request(port, { path: `/api/v1/audiofile?text=${q('a #fail')}` }),
    check: res => {
      assert.equal(res.status, 500);
      assert.equal(json(res).error, 'internal server error');
    },
  },
  {
    name: 'a native error before the first chunk of a stream is 500',
    send: port => postJson(port, { text: 'a #fail' }),
    check: res => {
      assert.equal(res.status, 500);
      assert.equal(json(res).error, 'internal server error');
    },
  },
];

// 単一プロセスと cluster で一致しなければならない部分
const COMPARED_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'allow',
  'retry-after',
  'ebyroid-pcm-sample-rate',
  'ebyroid-pcm-bit-depth',
  'ebyroid-pcm-number-of-channels',
];

function comparable(res) {
  const headers = {};
  COMPARED_HEADERS.forEach(name => {
    if (typeof res.headers[name] !== 'undefined') {
      headers[name] = res.headers[name];
    }
  });
  return { status: res.status, headers, body: res.body.toString('base64') };
}

const MODES = [
  { label: 'single process', workers: 1 },
  { label: 'cluster', workers: 3 },
];
const responses = {};

MODES.forEach(mode => {
  describe(mode.label, () => {
    let server;
    before(async () => {
      server = await startServer({ workers: mode.workers });
    });
    after(async () => {
      if (server) await server.stop();
    });

    CASES.forEach(c => {
      test(c.name, async () => {
        const res = await c.send(server.port);
        responses[mode.label] = responses[mode.label] || {};
        responses[mode.label][c.name] = comparable(res);
        c.check(res);
      });
    });
  });
});

test('single process and cluster answer every request the same way', () => {
  CASES.forEach(c => {
    assert.deepEqual(
      responses.cluster[c.name],
      responses['single process'][c.name],
      c.name
    );
  });
});
