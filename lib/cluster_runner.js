const clusterModule = require('cluster');

const LOG_MESSAGE = 'ebyroid:log';
const METRICS_MESSAGE = 'ebyroid:metrics';

function startCluster(options) {
  const cluster = options.cluster || clusterModule;
  const { logger, workers } = options;
  const restartDelayMs = options.restartDelayMs || 1000;
  const schedule = options.schedule || setTimeout;
  const writeLine =
    options.writeLine || (line => process.stdout.write(`${line}\n`));
  const packaged =
    typeof options.packaged === 'boolean'
      ? options.packaged
      : Boolean(process.pkg);
  const metricsByWorker = new Map();
  const recentExits = [];
  let stopping = false;
  let metricsTimer = null;

  if (typeof cluster.SCHED_RR !== 'undefined') {
    cluster.schedulingPolicy = cluster.SCHED_RR;
  }
  if (cluster.setupMaster) {
    cluster.setupMaster({ execArgv: packaged ? [] : process.execArgv });
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
      } else if (message && message.type === METRICS_MESSAGE) {
        metricsByWorker.set(worker.id, message.metrics);
      }
    });
  }

  function fork() {
    const worker = cluster.fork();
    attach(worker);
    return worker;
  }

  cluster.on('exit', (worker, code, signal) => {
    metricsByWorker.delete(worker.id);
    const now = Date.now();
    recentExits.push(now);
    while (recentExits.length > 0 && recentExits[0] < now - 30000) {
      recentExits.shift();
    }
    const restartSuppressed = recentExits.length > workers * 3;
    logger.warn('worker.exited', {
      workerId: worker.id,
      workerPid: worker.process && worker.process.pid,
      code,
      signal,
      restarting: !stopping && !restartSuppressed,
    });
    if (restartSuppressed) {
      logger.error('cluster.restart_suppressed', {
        exitsIn30Seconds: recentExits.length,
      });
    } else if (!stopping) {
      schedule(fork, restartDelayMs);
    }
  });

  function stop(signal) {
    if (stopping) return;
    stopping = true;
    if (metricsTimer) clearInterval(metricsTimer);
    logger.info('server.shutdown.started', { signal });
    Object.keys(cluster.workers || {}).forEach(id => {
      const worker = cluster.workers[id];
      if (worker && worker.isConnected()) {
        worker.send({ type: 'ebyroid:shutdown' });
      }
    });
  }

  for (let i = 0; i < workers; i += 1) fork();
  if (options.metricsIntervalMs > 0) {
    metricsTimer = setInterval(() => {
      const snapshots = Array.from(metricsByWorker.values());
      const sum = field =>
        snapshots.reduce((total, metrics) => total + (metrics[field] || 0), 0);
      logger.info('cluster.metrics', {
        workersOnline: Object.keys(cluster.workers || {}).length,
        workersReporting: snapshots.length,
        active: sum('active'),
        queued: sum('queued'),
        rps: Number(sum('rps').toFixed(2)),
        received: sum('received'),
        completed: sum('completed'),
        failed: sum('failed'),
        rejected: sum('rejected'),
        aborted: sum('aborted'),
        requestP95MaxMs: Math.max(
          0,
          ...snapshots.map(metrics => metrics.requestP95Ms || 0)
        ),
      });
    }, options.metricsIntervalMs);
    if (metricsTimer.unref) metricsTimer.unref();
  }
  if (options.handleSignals !== false) {
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }

  logger.info('cluster.started', { ...options.startedFields, workers });
  return { stop };
}

function workerLogWriter(send = process.send && process.send.bind(process)) {
  if (!send) return undefined;
  return line => send({ type: LOG_MESSAGE, line });
}

function workerMetricsWriter(
  send = process.send && process.send.bind(process)
) {
  if (!send) return undefined;
  return metrics => send({ type: METRICS_MESSAGE, metrics });
}

module.exports = {
  LOG_MESSAGE,
  METRICS_MESSAGE,
  startCluster,
  workerLogWriter,
  workerMetricsWriter,
};
