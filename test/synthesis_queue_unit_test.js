/* eslint-disable no-console */
const assert = require('assert').strict;
const { SynthesisQueue } = require('../lib/synthesis_queue');

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rejectsWithCode(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.equal(err.code, code);
  }
}

async function main() {
  const first = deferred();
  const order = [];
  let active = 0;
  let maximumActive = 0;
  const queue = new SynthesisQueue({ concurrency: 1, limit: 2 });
  const task = (name, gate = Promise.resolve()) => async () => {
    order.push(name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate;
    active -= 1;
    return name;
  };

  const one = queue.add(task('one', first.promise));
  const two = queue.add(task('two'));
  const three = queue.add(task('three'));
  const full = queue.add(task('full'));
  assert.equal(queue.active, 1);
  assert.equal(queue.depth, 2);
  await rejectsWithCode(full.promise, 'QUEUE_FULL');

  first.resolve();
  assert.deepEqual(
    await Promise.all([one.promise, two.promise, three.promise]),
    ['one', 'two', 'three']
  );
  assert.deepEqual(order, ['one', 'two', 'three']);
  assert.equal(maximumActive, 1);

  const blocker = deferred();
  const timedQueue = new SynthesisQueue({ limit: 2, timeoutMs: 10 });
  const running = timedQueue.add(() => blocker.promise);
  const timed = timedQueue.add(() => Promise.resolve());
  await rejectsWithCode(timed.promise, 'QUEUE_TIMEOUT');
  blocker.resolve();
  await running.promise;

  const cancelBlocker = deferred();
  const cancelQueue = new SynthesisQueue({ limit: 1 });
  const cancelRunning = cancelQueue.add(() => cancelBlocker.promise);
  const cancelled = cancelQueue.add(() => Promise.resolve());
  assert.equal(cancelled.cancel(), true);
  await rejectsWithCode(cancelled.promise, 'REQUEST_ABORTED');
  cancelBlocker.resolve();
  await cancelRunning.promise;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
