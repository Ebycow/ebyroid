/* eslint-disable no-console, no-underscore-dangle */
const assert = require('assert').strict;
const Module = require('module');

const fakeNative = {
  mode: 'success',
  init() {},
  convert(input, options, callback) {
    if (this.mode === 'throw') {
      throw new Error('synchronous native failure');
    }
    setImmediate(() => {
      if (this.mode === 'reload-error' && options.needs_reload) {
        callback(new Error('voice reload failed'));
      } else {
        callback(null, new Int16Array([0, 1]));
      }
    });
  },
  reinterpret(input, options, callback) {
    setImmediate(() => callback(null, Buffer.from(input)));
  },
  speech(input, options, callback) {
    setImmediate(() => callback(null, new Int16Array([0, 1])));
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../dll/ebyroid.node') {
    return fakeNative;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Ebyroid = require('../lib/ebyroid');
const Voiceroid = require('../lib/voiceroid');

Module._load = originalLoad;

function withTimeout(promise, milliseconds = 1000) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('operation timed out')),
      milliseconds
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const a = new Voiceroid('a', 'C:\\VoiceA', 'aoi_22');
  const b = new Voiceroid('b', 'C:\\VoiceB', 'akane_22');
  const ebyroid = new Ebyroid(a, b);
  ebyroid.use('a');

  fakeNative.mode = 'throw';
  const synchronousFailures = await withTimeout(
    Promise.allSettled([ebyroid.convert('one'), ebyroid.convert('two')])
  );
  assert(synchronousFailures.every(result => result.status === 'rejected'));

  fakeNative.mode = 'success';
  await withTimeout(ebyroid.convert('semaphore permits were returned'));

  fakeNative.mode = 'reload-error';
  const reloadFailures = await withTimeout(
    Promise.allSettled([
      ebyroid.convertEx('one', 'b'),
      ebyroid.convertEx('two', 'b'),
      ebyroid.convertEx('three', 'b'),
    ])
  );
  assert(reloadFailures.every(result => result.status === 'rejected'));

  fakeNative.mode = 'success';
  await withTimeout(ebyroid.convertEx('lock was released', 'a'));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
