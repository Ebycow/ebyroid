/* eslint-disable no-console */
const assert = require('assert').strict;
const Semaphore = require('../lib/semaphore');

async function main() {
  const semaphore = new Semaphore(2);

  await semaphore.acquire();

  let hasLock = false;
  const lock = semaphore.lock().then(() => {
    hasLock = true;
  });
  await Promise.resolve();
  assert.equal(hasLock, false);

  semaphore.release();
  await lock;
  assert.equal(hasLock, true);

  let hasPermit = false;
  const permit = semaphore.acquire().then(() => {
    hasPermit = true;
  });
  await Promise.resolve();
  assert.equal(hasPermit, false);

  semaphore.unlock();
  await permit;
  assert.equal(hasPermit, true);
  semaphore.release();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
