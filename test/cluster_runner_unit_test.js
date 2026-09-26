/* eslint-disable no-console, max-classes-per-file */
const assert = require('assert').strict;
const { EventEmitter } = require('events');
const { Logger } = require('../lib/logger');
const {
  LOG_MESSAGE,
  METRICS_MESSAGE,
  startCluster,
  workerLogWriter,
  workerMetricsWriter,
} = require('../lib/cluster_runner');

class FakeWorker extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.process = { pid: 1000 + id };
    this.sent = [];
  }

  isConnected() {
    return Boolean(this.id);
  }

  send(message) {
    this.sent.push(message);
  }
}

class FakeCluster extends EventEmitter {
  constructor() {
    super();
    this.SCHED_RR = 2;
    this.workers = {};
    this.forks = 0;
  }

  fork() {
    this.forks += 1;
    const worker = new FakeWorker(this.forks);
    this.workers[worker.id] = worker;
    return worker;
  }

  setupMaster(settings) {
    this.settings = settings;
  }
}

function main() {
  const cluster = new FakeCluster();
  const output = [];
  const logs = [];
  const scheduled = [];
  const logger = new Logger({ write: line => logs.push(line) });
  const supervisor = startCluster({
    cluster,
    workers: 2,
    logger,
    writeLine: line => output.push(line),
    schedule: callback => scheduled.push(callback),
    handleSignals: false,
    startedFields: { url: 'http://localhost:4090/', version: '9.9.9' },
  });
  const clusterStarted = logs
    .map(line => JSON.parse(line))
    .find(record => record.event === 'cluster.started');
  assert.equal(clusterStarted.url, 'http://localhost:4090/');
  assert.equal(clusterStarted.version, '9.9.9');
  assert.equal(clusterStarted.workers, 2);

  assert.equal(cluster.forks, 2);
  assert.equal(cluster.schedulingPolicy, cluster.SCHED_RR);
  assert.deepEqual(cluster.settings.execArgv, process.execArgv);
  cluster.workers[1].emit('message', {
    type: LOG_MESSAGE,
    line: '{"event":"request.received"}',
  });
  assert.deepEqual(output, ['{"event":"request.received"}']);
  cluster.workers[1].emit('message', {
    type: METRICS_MESSAGE,
    metrics: { active: 1, queued: 2 },
  });

  cluster.emit('exit', cluster.workers[1], 1, null);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(cluster.forks, 3);

  supervisor.stop('test');
  assert.deepEqual(cluster.workers[2].sent, [{ type: 'ebyroid:shutdown' }]);
  cluster.emit('exit', cluster.workers[2], 0, null);
  assert.equal(scheduled.length, 0);
  assert(logs.some(line => line.includes('worker.exited')));

  const messages = [];
  const write = workerLogWriter(message => messages.push(message));
  write('line');
  assert.deepEqual(messages, [{ type: LOG_MESSAGE, line: 'line' }]);
  const writeMetrics = workerMetricsWriter(message => messages.push(message));
  writeMetrics({ active: 1 });
  assert.deepEqual(messages[1], {
    type: METRICS_MESSAGE,
    metrics: { active: 1 },
  });

  // A restart that was already scheduled must not outlive shutdown.
  const stoppingCluster = new FakeCluster();
  const pending = [];
  const cancelled = [];
  const stoppingSupervisor = startCluster({
    cluster: stoppingCluster,
    workers: 1,
    logger,
    schedule: callback => {
      pending.push(callback);
      return callback;
    },
    cancelSchedule: handle => cancelled.push(handle),
    handleSignals: false,
  });
  stoppingCluster.emit('exit', stoppingCluster.workers[1], 1, null);
  assert.equal(pending.length, 1);
  stoppingSupervisor.stop('test');
  assert.deepEqual(cancelled, [pending[0]]);
  pending[0]();
  assert.equal(stoppingCluster.forks, 1);

  // A crash loop slows restarts down instead of stopping them for good.
  const crashingCluster = new FakeCluster();
  const delays = [];
  const restarts = [];
  const crashingSupervisor = startCluster({
    cluster: crashingCluster,
    workers: 1,
    logger,
    crashBackoffMs: 30000,
    schedule: (callback, delayMs) => {
      delays.push(delayMs);
      restarts.push(callback);
    },
    handleSignals: false,
  });
  for (let i = 0; i < 4; i += 1) {
    crashingCluster.emit(
      'exit',
      crashingCluster.workers[crashingCluster.forks],
      1,
      null
    );
    restarts.shift()();
  }
  assert.deepEqual(delays, [1000, 1000, 1000, 30000]);
  assert.equal(crashingCluster.forks, 5);
  assert(logs.some(line => line.includes('cluster.restart_delayed')));
  crashingSupervisor.stop('test');

  const packagedCluster = new FakeCluster();
  const packagedSupervisor = startCluster({
    cluster: packagedCluster,
    workers: 1,
    logger,
    packaged: true,
    handleSignals: false,
  });
  assert.deepEqual(packagedCluster.settings.execArgv, []);
  packagedSupervisor.stop('test');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
