/* eslint-disable no-console, no-underscore-dangle */
const assert = require('assert').strict;
const Module = require('module');
const { once } = require('events');

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
  convertStream(input, options, callback) {
    if (this.mode === 'throw') {
      throw new Error('synchronous native failure');
    }
    setImmediate(() => {
      if (this.mode === 'reload-error' && options.needs_reload) {
        callback(new Error('voice reload failed'), null);
      } else if (this.mode === 'slow-stream') {
        callback(null, Buffer.from([1, 1]));
        this.finishStream = () => {
          callback(null, Buffer.from([2, 2]));
          callback(null, null);
        };
      } else {
        callback(null, Buffer.from([0, 0]));
        callback(null, null);
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
const { Logger } = require('../lib/logger');
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

  const lines = [];
  ebyroid.setLogger(
    new Logger({ level: 'trace', write: line => lines.push(line) })
  );
  const requestLogger = ebyroid.logger.child({ requestId: 'request-1' });
  const pcm = await withTimeout(
    ebyroid.convertStream('secret streamed speech', { logger: requestLogger })
  );
  const chunks = [];
  pcm.on('data', chunk => chunks.push(chunk));
  await withTimeout(once(pcm, 'end'));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 0]));
  assert(lines.some(line => line.includes('synthesis.started')));
  assert(lines.some(line => line.includes('synthesis.first_chunk')));
  assert(lines.some(line => line.includes('synthesis.completed')));
  assert(lines.every(line => !line.includes('secret streamed speech')));
  assert(
    lines
      .map(line => JSON.parse(line))
      .every(record => record.requestId === 'request-1')
  );

  // A consumer may destroy the stream while native synthesis continues.
  fakeNative.mode = 'slow-stream';
  const abandoned = await withTimeout(ebyroid.convertStream('abandoned'));
  let ended = false;
  abandoned.on('end', () => {
    ended = true;
  });
  abandoned.once('data', () => abandoned.destroy());
  await withTimeout(once(abandoned, 'close'));
  fakeNative.finishStream();
  const completion = await withTimeout(abandoned.completion);
  assert.equal(completion.chunks, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, false, 'a destroyed stream must not emit end');

  fakeNative.mode = 'success';
  await withTimeout(ebyroid.convertStream('slot was released'));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
