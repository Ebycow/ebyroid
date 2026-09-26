const clusterModule = require('cluster');

const LOG_MESSAGE = 'ebyroid:log';

function startCluster(options) {
  const cluster = options.cluster || clusterModule;
  const { logger, workers } = options;
  const restartDelayMs = options.restartDelayMs || 1000;
  const schedule = options.schedule || setTimeout;
  const writeLine =
    options.writeLine || (line => process.stdout.write(`${line}\n`));
  let stopping = false;

  if (typeof cluster.SCHED_RR !== 'undefined') {
    cluster.schedulingPolicy = cluster.SCHED_RR;
  }

  function attach(worker) {
    logger.info('worker.started', {
      workerId: worker.id,
      workerPid: worker.process && worker.process.pid,
    });
    worker.on('message', message => {
      if (
        message &&
        message.type === LOG_MESSAGE &&
        typeof message.line === 'string'
      ) {
        writeLine(message.line);
      }
    });
  }

  function fork() {
    const worker = cluster.fork();
    attach(worker);
    return worker;
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.warn('worker.exited', {
      workerId: worker.id,
      workerPid: worker.process && worker.process.pid,
      code,
      signal,
      restarting: !stopping,
    });
    if (!stopping) {
      schedule(fork, restartDelayMs);
    }
  });

  function stop(signal) {
    if (stopping) return;
    stopping = true;
    logger.info('server.shutdown.started', { signal });
    Object.keys(cluster.workers || {}).forEach(id => {
      const worker = cluster.workers[id];
      if (worker && worker.isConnected()) {
        worker.send({ type: 'ebyroid:shutdown' });
      }
    });
  }

  for (let i = 0; i < workers; i += 1) fork();
  if (options.handleSignals !== false) {
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }

  logger.info('cluster.started', { workers });
  return { stop };
}

function workerLogWriter(send = process.send && process.send.bind(process)) {
  if (!send) return undefined;
  return line => send({ type: LOG_MESSAGE, line });
}

module.exports = { LOG_MESSAGE, startCluster, workerLogWriter };
