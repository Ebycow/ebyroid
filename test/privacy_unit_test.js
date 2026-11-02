// プライバシー方針: 読み上げる本文はログに出さない (文字数だけを記録する)
//
// 本番と同じ起動経路 (bin/main.js start) を、偽のネイティブアドオンで子プロセスとして動かす。
// 目印 (カナリア) を本文に入れて、正常系・エラー系・中断をひととおり通したあと、
// 子プロセスの stdout/stderr のどこにも目印が出ていないことを確かめる。
// ログレベルは trace、出力形式は json と pretty の両方、単一プロセスと cluster の両方で試す。
const assert = require('assert').strict;
const crypto = require('crypto');
const http = require('http');
const { test } = require('node:test'); // eslint-disable-line import/no-unresolved, node/no-missing-require
const { startServer, request, postJson } = require('./helpers/server');

// 最初のチャンクを受け取った時点でクライアントが切断する
function abortAfterFirstChunk(port, text) {
  return new Promise(resolve => {
    const body = JSON.stringify({ text });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/v2/audiostream',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
        res.once('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.end(body);
  });
}

/**
 * 本文の目印が、そのままでも、URL エンコードされても、JSON 文字列としても
 * 出力に現れていないことを確かめる。V8 の JSON.parse のエラーメッセージのように
 * 本文の一部だけが切り出されることもあるので、ランダム部分は 8 文字の断片でも探す
 */
function assertNoCanary(output, canary) {
  const forms = new Set([
    canary.text,
    encodeURIComponent(canary.text),
    JSON.stringify(canary.text).slice(1, -1),
  ]);
  canary.tokens.forEach(token => {
    forms.add(encodeURIComponent(token));
    for (let i = 0; i + 8 <= token.length; i += 1) {
      forms.add(token.slice(i, i + 8));
    }
  });
  forms.forEach(form => {
    assert.equal(
      output.includes(form),
      false,
      `the request text leaked into the server output as ${JSON.stringify(
        form
      )}`
    );
  });
}

/**
 * 英数字だけの部分と、日本語 (Shift_JIS に変換される) の部分を持つ目印。
 * どちらもランダムな 16 進で、偶然ほかのログと一致しない
 */
function makeCanary() {
  // 英字で始める (数字だと JSON.parse が数値として読み、断片を含むエラーにならない)
  const ascii = `k${crypto.randomBytes(12).toString('hex')}`;
  const japanese = `秘密の読み上げ本文${crypto.randomBytes(6).toString('hex')}`;
  return { text: `${ascii} ${japanese}`, tokens: [ascii, japanese] };
}

async function exercise(port, canary) {
  const q = text => encodeURIComponent(text);
  const results = {};

  // 正常系
  results.getStream = await request(port, {
    path: `/api/v1/audiostream?text=${q(canary)}`,
  });
  results.getFileOtherVoice = await request(port, {
    path: `/api/v1/audiofile?text=${q(canary)}&name=akane`,
  });
  results.postStream = await postJson(port, { text: canary });
  results.postStreamOtherVoice = await postJson(port, {
    text: canary,
    name: 'akane',
  });

  // ネイティブ側の失敗
  results.nativeThrow = await request(port, {
    path: `/api/v1/audiostream?text=${q(`${canary} #throw`)}`,
  });
  results.nativeFail = await request(port, {
    path: `/api/v1/audiofile?text=${q(`${canary} #fail`)}`,
  });
  results.streamThrow = await postJson(port, { text: `${canary} #throw` });
  results.streamFail = await postJson(port, { text: `${canary} #fail` });

  // 入力の検証エラー
  // 壊れた JSON (V8 はエラーメッセージに入力の一部を含めることがある)
  results.brokenJson = await postJson(port, `{"text": "${canary}"`);
  results.bareText = await postJson(port, `${canary}`);
  results.unquotedText = await postJson(port, `{"text": ${canary}}`);
  results.trailingText = await postJson(port, `{"text": 1} ${canary}`);
  results.wrongContentType = await request(port, {
    method: 'POST',
    path: '/api/v2/audiostream',
    headers: { 'Content-Type': 'text/plain' },
    body: canary,
  });
  results.tooLarge = await postJson(port, {
    text: `${canary} ${'x'.repeat(70 * 1024)}`,
  });
  results.badName = await postJson(port, { text: canary, name: 1 });
  results.unknownPath = await request(port, {
    path: `/api/v1/nope?text=${q(canary)}`,
  });
  results.wrongMethod = await request(port, {
    method: 'POST',
    path: `/api/v1/audiostream?text=${q(canary)}`,
  });

  // 合成中のクライアント切断
  await abortAfterFirstChunk(port, `${canary} #slow`);
  // 切断の後始末とメトリクスのログを待つ
  await new Promise(resolve => setTimeout(resolve, 500));

  return results;
}

function expectStatuses(results) {
  assert.equal(results.getStream.status, 200);
  assert.equal(results.getFileOtherVoice.status, 200);
  assert.equal(results.postStream.status, 200);
  assert.equal(results.postStreamOtherVoice.status, 200);
  assert.equal(results.nativeThrow.status, 500);
  assert.equal(results.nativeFail.status, 500);
  assert.equal(results.streamThrow.status, 500);
  assert.equal(results.brokenJson.status, 400);
  assert.equal(results.bareText.status, 400);
  assert.equal(results.unquotedText.status, 400);
  assert.equal(results.trailingText.status, 400);
  assert.equal(results.wrongContentType.status, 415);
  assert.equal(results.tooLarge.status, 413);
  assert.equal(results.badName.status, 400);
  assert.equal(results.unknownPath.status, 404);
  assert.equal(results.wrongMethod.status, 400);
}

async function runServer({ workers, format }) {
  const canary = makeCanary();
  const server = await startServer({
    workers,
    logLevel: 'trace',
    logFormat: format,
    args: ['--metrics-interval-ms', '100'],
    // debug モジュールの出力も含めて確かめる
    env: { DEBUG: '*' },
  });
  try {
    const results = await exercise(server.port, canary.text);
    await server.stop();
    return { canary, output: server.output(), results };
  } finally {
    await server.stop();
  }
}

[
  { workers: 1, format: 'json' },
  { workers: 1, format: 'pretty' },
  { workers: 3, format: 'json' },
  { workers: 3, format: 'pretty' },
].forEach(options => {
  test(`request text never reaches the logs (workers=${options.workers}, format=${options.format})`, async () => {
    const { canary, output, results } = await runServer(options);

    expectStatuses(results);
    // 何も出力されていないせいで通っていないこと
    assert.match(output, /synthesis\.started/);
    assert.match(output, /textChars/);
    assert.match(output, /synthesis\.failed/);
    assert.match(output, /request\.aborted|response\.aborted|aborted/);

    assertNoCanary(output, canary);
  });
});
