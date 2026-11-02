/* eslint-disable no-console, global-require, import/no-dynamic-require, import/no-unresolved, node/no-missing-require */
// イメージの中で、wine 上の Windows 版 node.exe (ia32) から実行する (test/image/smoke.sh)。
// ビルドした ebyroid.node と、JS の依存 (node_modules) が読み込めることを確かめる。
// VOICEROID 本体は使わない (init は呼ばない)
const assert = require('assert').strict;

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'ia32');

const native = require('Z:\\app\\dll\\ebyroid.node');

['init', 'convert', 'convertStream', 'reinterpret', 'speech'].forEach(name =>
  assert.equal(typeof native[name], 'function', `native.${name}`)
);

[
  'ebyroid',
  'mini_server',
  'cli_main',
  'cluster_runner',
  'voice_router',
].forEach(name => require(`Z:\\app\\lib\\${name}.js`));

console.log(
  JSON.stringify({
    ok: true,
    node: process.version,
    arch: process.arch,
    napi: process.versions.napi,
  })
);
