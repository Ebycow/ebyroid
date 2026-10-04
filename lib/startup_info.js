const { version } = require('../package.json');

function processRole(isPrimary, worker) {
  if (isPrimary) return { role: 'primary' };
  if (worker) return { role: 'worker', workerId: worker.id };
  return { role: 'single' };
}

function serverUrl(port) {
  return `http://localhost:${port}/`;
}

function runtimeFields(argv) {
  return {
    version,
    node: process.version,
    arch: process.arch,
    workers: argv.workers,
    workerIdleTimeoutMs: argv.workerIdleTimeoutMs,
    queueLimit: argv.queueLimit,
    queueTimeoutMs: argv.queueTimeoutMs,
    logLevel: argv.logLevel,
  };
}

function serverStartedFields(argv, address) {
  const bound =
    address && typeof address === 'object'
      ? address
      : { address: undefined, port: argv.port };
  return {
    url: serverUrl(bound.port),
    address: bound.address,
    port: bound.port,
    ...runtimeFields(argv),
  };
}

function clusterStartedFields(argv) {
  return {
    url: serverUrl(argv.port),
    port: argv.port,
    ...runtimeFields(argv),
  };
}

module.exports = {
  processRole,
  serverUrl,
  serverStartedFields,
  clusterStartedFields,
};
