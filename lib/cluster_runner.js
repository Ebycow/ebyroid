const clusterModule = require('cluster');

const LOG_MESSAGE = 'ebyroid:log';
const METRICS_MESSAGE = 'ebyroid:metrics';
const READY_MESSAGE = 'ebyroid:ready';
const SHUTDOWN_MESSAGE = 'ebyroid:shutdown';
const VOICE_ENV = 'EBYROID_WORKER_VOICE';

/**
 * Supervises one worker process per voice.
 *
 * The default voice always has a worker and it is restarted when it exits.
 * Workers for other voices start on demand, stop after being idle for
 * `idleTimeoutMs` (0 keeps them), and are handed over to another voice when
 * `workers` processes are already running.
 */
function startCluster(options) {
  const cluster = options.cluster || clusterModule;
  const { logger, workers, defaultVoice } = options;
  const idleTimeoutMs = options.idleTimeoutMs || 0;
  const queueTimeoutMs = options.queueTimeoutMs || 0;
  const restartDelayMs = options.restartDelayMs || 1000;
  const crashBackoffMs = options.crashBackoffMs || 30000;
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const now = options.now || Date.now;
  const writeLine =
    options.writeLine || (line => process.stdout.write(`${line}\n`));
  const packaged =
    typeof options.packaged === 'boolean'
      ? options.packaged
      : Boolean(process.pkg);
  const metricsByWorker = new Map();
  /** @type {Map<string, object>} voice name -> worker entry */
  const entries = new Map();
  /** @type {Map<number, object>} worker id -> worker entry */
  const entriesByWorker = new Map();
  const waiters = [];
  const recentExits = [];
  const pendingRestarts = new Set();
  let stopping = false;
  let metricsTimer = null;

  if (cluster.setupMaster) {
    cluster.setupMaster({ execArgv: packaged ? [] : process.execArgv });
  }

  function clearIdleTimer(entry) {
    if (entry.idleTimer === null) return;
    cancelSchedule(entry.idleTimer);
    // eslint-disable-next-line no-param-reassign
    entry.idleTimer = null;
  }

  function stopEntry(entry, reason) {
    if (entry.stopping) return;
    clearIdleTimer(entry);
    // eslint-disable-next-line no-param-reassign
    entry.stopping = true;
    logger.info('worker.stopping', {
      voice: entry.voice,
      workerId: entry.worker.id,
      reason,
    });
    if (entry.worker.isConnected()) {
      entry.worker.send({ type: SHUTDOWN_MESSAGE });
    }
  }

  function attach(entry) {
    const { worker } = entry;
    worker.on('message', message => {
      if (!message) return;
      if (message.type === LOG_MESSAGE && typeof message.line === 'string') {
        writeLine(message.line);
      } else if (message.type === METRICS_MESSAGE) {
        metricsByWorker.set(worker.id, {
          voice: entry.voice,
          ...message.metrics,
        });
      } else if (message.type === READY_MESSAGE && entry.port === null) {
        // eslint-disable-next-line no-param-reassign
        entry.port = message.port;
        logger.info('worker.ready', {
          voice: entry.voice,
          workerId: worker.id,
          workerPid: worker.process && worker.process.pid,
          port: message.port,
          startupMs: now() - entry.startedAt,
        });
        entry.resolveReady(message.port);
      }
    });
  }

  function spawn(voice) {
    const worker = cluster.fork({ [VOICE_ENV]: voice });
    const entry = {
      voice,
      worker,
      port: null,
      inflight: 0,
      startedAt: now(),
      lastUsedAt: now(),
      idleTimer: null,
      stopping: false,
      exited: false,
    };
    entry.ready = new Promise((resolve, reject) => {
      entry.resolveReady = resolve;
      entry.rejectReady = reject;
    });
    // Leases await `ready`; a worker that dies first must not leave an
    // unhandled rejection behind when nobody is waiting yet.
    entry.ready.catch(() => {});
    entries.set(voice, entry);
    entriesByWorker.set(worker.id, entry);
    attach(entry);
    logger.info('worker.started', {
      voice,
      workerId: worker.id,
      workerPid: worker.process && worker.process.pid,
      workersRunning: entriesByWorker.size,
    });
    return entry;
  }

  function release(entry) {
    // eslint-disable-next-line no-param-reassign
    entry.inflight -= 1;
    // eslint-disable-next-line no-param-reassign
    entry.lastUsedAt = now();
    if (
      entry.inflight === 0 &&
      entry.voice !== defaultVoice &&
      idleTimeoutMs > 0 &&
      !entry.stopping &&
      !entry.exited
    ) {
      // eslint-disable-next-line no-param-reassign
      entry.idleTimer = schedule(() => {
        // eslint-disable-next-line no-param-reassign
        entry.idleTimer = null;
        if (entry.inflight === 0) stopEntry(entry, 'idle');
      }, idleTimeoutMs);
    }
    // eslint-disable-next-line no-use-before-define
    pump();
  }

  function lease(entry) {
    clearIdleTimer(entry);
    // eslint-disable-next-line no-param-reassign
    entry.inflight += 1;
    // eslint-disable-next-line no-param-reassign
    entry.lastUsedAt = now();
    let released = false;
    return entry.ready.then(
      port => ({
        port,
        voice: entry.voice,
        workerId: entry.worker.id,
        release() {
          if (released) return;
          released = true;
          release(entry);
        },
      }),
      err => {
        release(entry);
        throw err;
      }
    );
  }

  function evictionCandidate() {
    let candidate = null;
    entries.forEach(entry => {
      if (
        entry.voice === defaultVoice ||
        entry.stopping ||
        entry.inflight > 0
      ) {
        return;
      }
      if (candidate === null || entry.lastUsedAt < candidate.lastUsedAt) {
        candidate = entry;
      }
    });
    return candidate;
  }

  /**
   * Hands an idle worker over to another voice. Every request routed to a
   * non-default voice names it, so the worker loads the new voice library on
   * its first request: a reload within the process, much cheaper than
   * starting a new process under wine.
   */
  function reassign(entry, voice) {
    clearIdleTimer(entry);
    logger.info('worker.reassigned', {
      from: entry.voice,
      voice,
      workerId: entry.worker.id,
    });
    entries.delete(entry.voice);
    // eslint-disable-next-line no-param-reassign
    entry.voice = voice;
    entries.set(voice, entry);
    return entry;
  }

  /**
   * Serves waiting requests in arrival order as far as capacity allows.
   * A request whose voice already has a worker never waits behind one that
   * needs a new worker. Workers that are shutting down still hold their
   * slot until they exit.
   */
  function pump() {
    if (stopping) return;
    let index = 0;
    while (index < waiters.length) {
      const waiter = waiters[index];
      const existing = entries.get(waiter.voice);
      // The default voice always owns a slot, even while it is restarting,
      // and only the restart schedule brings it back.
      const reserved = entries.has(defaultVoice) ? 0 : 1;
      let entry = null;
      if (existing && !existing.stopping) {
        entry = existing;
      } else if (!existing && waiter.voice !== defaultVoice) {
        if (entriesByWorker.size + reserved < workers) {
          entry = spawn(waiter.voice);
        } else {
          const victim = evictionCandidate();
          if (victim) entry = reassign(victim, waiter.voice);
        }
      }
      if (entry) {
        waiters.splice(index, 1);
        cancelSchedule(waiter.timer);
        waiter.resolve(lease(entry));
      } else {
        index += 1;
      }
    }
  }

  /**
   * Reserves the worker for `voice`, starting it if needed.
   * Call `release()` on the result once the request has finished.
   *
   * @param {string} voice
   * @returns {{ promise: Promise<{port:number,voice:string,workerId:number,release:function():void}>, cancel: function():void }}
   */
  function acquire(voice) {
    let waiter = null;
    const promise = new Promise((resolve, reject) => {
      if (stopping) {
        const err = new Error('server is shutting down');
        err.statusCode = 503;
        reject(err);
        return;
      }
      waiter = { voice, resolve, reject, timer: null };
      if (queueTimeoutMs > 0) {
        waiter.timer = schedule(() => {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          const err = new Error('no worker became available in time');
          err.statusCode = 503;
          logger.warn('worker.wait_timeout', { voice, queueTimeoutMs });
          reject(err);
        }, queueTimeoutMs);
      }
      waiters.push(waiter);
      pump();
    });
    return {
      promise,
      cancel() {
        const index = waiters.indexOf(waiter);
        if (index === -1) return;
        waiters.splice(index, 1);
        cancelSchedule(waiter.timer);
        const err = new Error('request aborted');
        err.code = 'REQUEST_ABORTED';
        waiter.reject(err);
      },
    };
  }

  function scheduleRestart(delayMs) {
    const handle = schedule(() => {
      pendingRestarts.delete(handle);
      if (stopping || entries.has(defaultVoice)) return;
      spawn(defaultVoice);
      pump();
    }, delayMs);
    pendingRestarts.add(handle);
  }

  cluster.on('exit', (worker, code, signal) => {
    metricsByWorker.delete(worker.id);
    const entry = entriesByWorker.get(worker.id);
    if (!entry) return;
    entriesByWorker.delete(worker.id);
    if (entries.get(entry.voice) === entry) entries.delete(entry.voice);
    clearIdleTimer(entry);
    entry.exited = true;
    const err = new Error(`worker for "${entry.voice}" exited before ready`);
    err.code = 'WORKER_EXITED';
    entry.rejectReady(err);

    const intended = entry.stopping || stopping;
    const restarting = !stopping && entry.voice === defaultVoice;
    let delayMs;
    if (restarting) {
      const at = now();
      recentExits.push(at);
      while (recentExits.length > 0 && recentExits[0] < at - 30000) {
        recentExits.shift();
      }
      const crashLooping = recentExits.length > 3;
      delayMs = crashLooping ? crashBackoffMs : restartDelayMs;
      if (crashLooping) {
        // Keep restarting so the default voice recovers, but slowly enough
        // that a persistent failure such as a broken library does not spin.
        logger.error('cluster.restart_delayed', {
          exitsIn30Seconds: recentExits.length,
          restartDelayMs: delayMs,
        });
      }
    }
    const fields = {
      voice: entry.voice,
      workerId: worker.id,
      workerPid: worker.process && worker.process.pid,
      code,
      signal,
      restarting,
      restartDelayMs: delayMs,
      workersRunning: entriesByWorker.size,
    };
    if (intended) logger.info('worker.exited', fields);
    else logger.warn('worker.exited', fields);
    if (restarting) scheduleRestart(delayMs);
    pump();
  });

  function stop(signal) {
    if (stopping) return;
    stopping = true;
    if (metricsTimer) clearInterval(metricsTimer);
    pendingRestarts.forEach(handle => cancelSchedule(handle));
    pendingRestarts.clear();
    waiters.splice(0).forEach(waiter => {
      cancelSchedule(waiter.timer);
      const err = new Error('server is shutting down');
      err.statusCode = 503;
      waiter.reject(err);
    });
    logger.info('server.shutdown.started', { signal });
    entriesByWorker.forEach(entry => {
      clearIdleTimer(entry);
      if (entry.worker.isConnected()) {
        entry.worker.send({ type: SHUTDOWN_MESSAGE });
      }
    });
  }

  spawn(defaultVoice);
  if (options.metricsIntervalMs > 0) {
    metricsTimer = setInterval(() => {
      const snapshots = Array.from(metricsByWorker.values());
      const sum = field =>
        snapshots.reduce((total, metrics) => total + (metrics[field] || 0), 0);
      logger.info('cluster.metrics', {
        workersOnline: entriesByWorker.size,
        workersReporting: snapshots.length,
        workerVoices: Array.from(entries.keys()),
        waiting: waiters.length,
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

  logger.info('cluster.started', {
    ...options.startedFields,
    workers,
    defaultVoice,
    workerIdleTimeoutMs: idleTimeoutMs,
  });
  return {
    acquire,
    stop,
    /** @returns {{voice:string,workerId:number,inflight:number,ready:boolean,stopping:boolean}[]} */
    status() {
      return Array.from(entriesByWorker.values()).map(entry => ({
        voice: entry.voice,
        workerId: entry.worker.id,
        inflight: entry.inflight,
        ready: entry.port !== null,
        stopping: entry.stopping,
      }));
    },
  };
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

/** Tells the primary which local port this worker serves on. */
function workerReadyNotifier(
  send = process.send && process.send.bind(process)
) {
  if (!send) return undefined;
  return port => send({ type: READY_MESSAGE, port });
}

module.exports = {
  LOG_MESSAGE,
  METRICS_MESSAGE,
  READY_MESSAGE,
  SHUTDOWN_MESSAGE,
  VOICE_ENV,
  startCluster,
  workerLogWriter,
  workerMetricsWriter,
  workerReadyNotifier,
};
