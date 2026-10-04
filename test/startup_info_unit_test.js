/* eslint-disable no-console */
const assert = require('assert').strict;
const { version } = require('../package.json');
const {
  processRole,
  serverStartedFields,
  clusterStartedFields,
} = require('../lib/startup_info');

function main() {
  assert.deepEqual(processRole(true, undefined), { role: 'primary' });
  assert.deepEqual(processRole(false, { id: 2 }), {
    role: 'worker',
    workerId: 2,
  });
  assert.deepEqual(processRole(false, undefined), { role: 'single' });

  const argv = {
    port: 4090,
    workers: 1,
    workerIdleTimeoutMs: 600000,
    queueLimit: 20,
    queueTimeoutMs: 10000,
    logLevel: 'info',
  };
  const started = serverStartedFields(argv, {
    address: '::',
    family: 'IPv6',
    port: 4091,
  });
  assert.deepEqual(started, {
    url: 'http://localhost:4091/',
    address: '::',
    port: 4091,
    version,
    node: process.version,
    arch: process.arch,
    workers: 1,
    workerIdleTimeoutMs: 600000,
    queueLimit: 20,
    queueTimeoutMs: 10000,
    logLevel: 'info',
  });

  const fallback = serverStartedFields(argv, null);
  assert.equal(fallback.url, 'http://localhost:4090/');
  assert.equal(fallback.port, 4090);

  const cluster = clusterStartedFields({ ...argv, workers: 3 });
  assert.equal(cluster.url, 'http://localhost:4090/');
  assert.equal(cluster.version, version);
  assert.equal(cluster.workers, 3);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
