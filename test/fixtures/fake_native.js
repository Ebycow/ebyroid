/* eslint-disable no-underscore-dangle */
// `node -r ./test/fixtures/fake_native.js bin/main.js start ...` で使う preload。
// ビルドしたネイティブアドオン (dll/ebyroid.node) の代わりに、VOICEROID なしで
// 決まった PCM を返す偽物を読み込ませる。cluster のワーカーにも execArgv で引き継がれる。
//
// 本文の中の目印で動きを変える (ネイティブには Shift_JIS のバイト列で届く)
//   #throw  convert/convertStream の呼び出しで同期的に例外を投げる
//   #fail   コールバックでエラーを返す
//   #slow   ストリームで最初のチャンクを返したあと少し待ってから続きを返す
// エラーメッセージには本文を含めない (本物のネイティブも本文を含めない前提)
const Module = require('module');

function mode(input) {
  const text = Buffer.from(input).toString('latin1');
  if (text.includes('#throw')) return 'throw';
  if (text.includes('#fail')) return 'fail';
  if (text.includes('#slow')) return 'slow';
  return 'ok';
}

function nativeError(message) {
  return Object.assign(new Error(message), { code: 'FAKE_NATIVE' });
}

const fakeNative = {
  init() {},
  convert(input, options, callback) {
    const m = mode(input);
    if (m === 'throw') throw nativeError('fake native threw');
    setImmediate(() => {
      if (m === 'fail') callback(nativeError('fake native failed'), null);
      else callback(null, new Int16Array([0, 1, -1, 2]));
    });
  },
  convertStream(input, options, callback) {
    const m = mode(input);
    if (m === 'throw') throw nativeError('fake native threw');
    setImmediate(() => {
      if (m === 'fail') {
        callback(nativeError('fake native failed'), null);
        return;
      }
      callback(null, Buffer.from([0, 0, 1, 0]));
      const finish = () => {
        callback(null, Buffer.from([2, 0, 3, 0]));
        callback(null, null);
      };
      if (m === 'slow') setTimeout(finish, 300);
      else finish();
    });
  },
  reinterpret(input, dummy, callback) {
    setImmediate(() => callback(null, Buffer.from(input)));
  },
  speech(input, dummy, callback) {
    setImmediate(() => callback(null, new Int16Array([0, 1])));
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (/[\\/]dll[\\/]ebyroid\.node$/.test(request)) return fakeNative;
  return originalLoad.call(this, request, parent, isMain);
};
