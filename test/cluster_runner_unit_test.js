/* eslint-disable no-console, max-classes-per-file, class-methods-use-this */
const assert = require('assert').strict;
const { EventEmitter } = require('events');
const { Logger } = require('../lib/logger');
const {
  LOG_MESSAGE,
  METRICS_MESSAGE,
  READY_MESSAGE,
  SHUTDOWN_MESSAGE,
  VOICE_ENV,
  startCluster,
  workerLogWriter,
  workerMetricsWriter,
  workerReadyNotifier,
} = require('../lib/cluster_runner');

class FakeWorker extends EventEmitter {
  constructor(id, env) {
    super();
    this.id = id;
    this.env = env;
    this.process = { pid: 1000 + id };
    this.sent = [];
  }

  get voice() {
    return this.env[VOICE_ENV];
  }

  isConnected() {
    return true;
  }

  send(message) {
    this.sent.push(message);
  }

  ready(port = 5000 + this.id) {
    this.emit('message', { type: READY_MESSAGE, port });
  }

  shutdownRequested() {
    return this.sent.some(message => message.type === SHUTDOWN_MESSAGE);
  }
}

class FakeCluster extends EventEmitter {
  constructor() {
    super();
    this.workers = {};
    this.forks = [];
  }

  fork(env) {
    const worker = new FakeWorker(this.forks.length + 1, env);
    this.forks.push(worker);
    this.workers[worker.id] = worker;
    return worker;
  }

  exit(worker, code = 0) {
    delete this.workers[worker.id];
    this.emit('exit', worker, code, null);
  }

  setupMaster(settings) {
    this.settings = settings;
  }

  latest(voice) {
    return this.forks.filter(worker => worker.voice === voice).pop();
  }
}

class FakeTimers {
  constructor() {
    this.pending = [];
    this.schedule = (callback, delayMs) => {
      const handle = { callback, delayMs, cancelled: false };
      this.pending.push(handle);
      return handle;
    };
    this.cancel = handle => {
      if (handle) handle.cancelled = true; // eslint-disable-line no-param-reassign
    };
  }

  active(delayMs) {
    return this.pending.filter(
      handle => !handle.cancelled && handle.delayMs === delayMs
    );
  }

  fire(delayMs) {
    const due = this.active(delayMs);
    this.pending = this.pending.filter(handle => !due.includes(handle));
    due.forEach(handle => handle.callback());
    return due.length;
  }
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function setup(overrides = {}) {
  const cluster = new FakeCluster();
  const timers = new FakeTimers();
  const logs = [];
  const output = [];
  const logger = new Logger({ write: line => logs.push(line) });
  const supervisor = startCluster({
    cluster,
    workers: 2,
    defaultVoice: 'kiritan',
    idleTimeoutMs: 600000,
    queueTimeoutMs: 10000,
    logger,
    writeLine: line => output.push(line),
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    handleSignals: false,
    startedFields: { url: 'http://localhost:4090/', version: '9.9.9' },
    ...overrides,
  });
  const events = name =>
    logs.map(line => JSON.parse(line)).filter(record => record.event === name);
  return { cluster, timers, logs, output, supervisor, events };
}

async function startsTheDefaultVoiceAndForwardsMessages() {
  const { cluster, output, supervisor, events } = setup();
  const [started] = events('cluster.started');
  assert.equal(started.url, 'http://localhost:4090/');
  assert.equal(started.version, '9.9.9');
  assert.equal(started.workers, 2);
  assert.equal(started.defaultVoice, 'kiritan');
  assert.equal(started.workerIdleTimeoutMs, 600000);
  assert.deepEqual(cluster.settings.execArgv, process.execArgv);

  assert.equal(cluster.forks.length, 1);
  const kiritan = cluster.forks[0];
  assert.equal(kiritan.voice, 'kiritan');

  // A request that arrives during startup waits for the worker's port.
  let leased = null;
  supervisor.acquire('kiritan').promise.then(lease => {
    leased = lease;
  });
  await flush();
  assert.equal(leased, null);
  kiritan.ready(5001);
  await flush();
  assert.equal(leased.port, 5001);
  assert.equal(leased.voice, 'kiritan');
  assert.equal(events('worker.ready').length, 1);
  leased.release();

  kiritan.emit('message', {
    type: LOG_MESSAGE,
    line: '{"event":"request.received"}',
  });
  assert.deepEqual(output, ['{"event":"request.received"}']);
  kiritan.emit('message', { type: METRICS_MESSAGE, metrics: { active: 1 } });
  supervisor.stop('test');
}

async function startsOtherVoicesOnDemandAndStopsThemWhenIdle() {
  const { cluster, timers, supervisor, events } = setup();
  cluster.forks[0].ready();

  const lease = supervisor.acquire('aoi').promise;
  assert.equal(cluster.forks.length, 2);
  const aoi = cluster.latest('aoi');
  aoi.ready(5002);
  const first = await lease;
  assert.equal(first.port, 5002);

  // While a request is in flight there is no idle timer.
  assert.equal(timers.active(600000).length, 0);
  first.release();
  first.release(); // releasing twice must not count twice
  assert.equal(timers.active(600000).length, 1);

  // A new request cancels the idle timer and reuses the worker.
  const second = await supervisor.acquire('aoi').promise;
  assert.equal(cluster.forks.length, 2);
  assert.equal(timers.active(600000).length, 0);
  second.release();

  // The default voice never gets an idle timer.
  (await supervisor.acquire('kiritan').promise).release();
  assert.equal(timers.active(600000).length, 1);

  timers.fire(600000);
  assert(aoi.shutdownRequested());
  assert.equal(events('worker.stopping')[0].reason, 'idle');
  cluster.exit(aoi);
  const [exited] = events('worker.exited');
  assert.equal(exited.voice, 'aoi');
  assert.equal(exited.restarting, false);
  assert.equal(timers.active(1000).length, 0);

  // The next request for the voice starts a fresh worker.
  supervisor.acquire('aoi');
  assert.equal(cluster.forks.length, 3);
  supervisor.stop('test');
}

async function idleTimeoutZeroKeepsWorkers() {
  const { cluster, timers, supervisor } = setup({ idleTimeoutMs: 0 });
  cluster.forks[0].ready();
  const lease = supervisor.acquire('aoi').promise;
  cluster.latest('aoi').ready();
  (await lease).release();
  assert.equal(timers.pending.filter(h => !h.cancelled).length, 0);
  supervisor.stop('test');
}

async function reassignsTheLeastRecentlyUsedIdleWorkerAtCapacity() {
  let clock = 0;
  const { cluster, supervisor, events } = setup({
    workers: 3,
    now: () => clock,
  });
  cluster.forks[0].ready();
  const aoiLease = supervisor.acquire('aoi').promise;
  cluster.latest('aoi').ready();
  clock = 1;
  (await aoiLease).release();
  const akaneLease = supervisor.acquire('akane').promise;
  cluster.latest('akane').ready();
  clock = 2;
  const akane = await akaneLease;
  assert.equal(cluster.forks.length, 3);

  // akane is busy and the default voice is never taken, so aoi's worker
  // switches to zunko without starting a new process.
  const aoiWorker = cluster.latest('aoi');
  const zunko = await supervisor.acquire('zunko').promise;
  assert.equal(zunko.voice, 'zunko');
  assert.equal(zunko.workerId, aoiWorker.id);
  assert.equal(cluster.forks.length, 3);
  assert.equal(aoiWorker.shutdownRequested(), false);
  const [reassigned] = events('worker.reassigned');
  assert.equal(reassigned.from, 'aoi');
  assert.equal(reassigned.voice, 'zunko');
  assert.deepEqual(
    supervisor.status().map(worker => worker.voice),
    ['kiritan', 'zunko', 'akane']
  );

  // aoi is gone from the pool; asking for it again takes the next idle one.
  zunko.release();
  const aoi = await supervisor.acquire('aoi').promise;
  assert.equal(aoi.workerId, aoiWorker.id);
  aoi.release();
  akane.release();
  supervisor.stop('test');
}

async function waitsWhenEveryWorkerIsBusy() {
  const { cluster, timers, supervisor, events } = setup();
  cluster.forks[0].ready();
  const aoiLease = supervisor.acquire('aoi').promise;
  cluster.latest('aoi').ready();
  const aoi = await aoiLease;

  let akane = null;
  supervisor.acquire('akane').promise.then(lease => {
    akane = lease;
  });
  assert.equal(cluster.forks.length, 2);
  assert.equal(cluster.latest('aoi').shutdownRequested(), false);

  // A voice that already has a worker does not wait behind akane.
  const kiritan = await supervisor.acquire('kiritan').promise;
  kiritan.release();

  // Once aoi is free its worker takes over the waiting voice.
  aoi.release();
  await flush();
  assert.equal(akane.voice, 'akane');
  assert.equal(akane.workerId, cluster.latest('aoi').id);
  assert.equal(cluster.forks.length, 2);
  akane.release();

  // A request that cannot get a worker in time is rejected with 503.
  const busy = await supervisor.acquire('akane').promise;
  const late = supervisor.acquire('aoi').promise;
  timers.fire(10000);
  await assert.rejects(late, err => err.statusCode === 503);
  assert.equal(events('worker.wait_timeout').length, 1);

  // A client that goes away stops waiting.
  const ticket = supervisor.acquire('aoi');
  ticket.cancel();
  await assert.rejects(ticket.promise, err => err.code === 'REQUEST_ABORTED');
  busy.release();
  supervisor.stop('test');
}

async function restartsOnlyTheDefaultVoice() {
  const { cluster, timers, supervisor, events } = setup();
  cluster.forks[0].ready();

  // A worker that dies during startup fails the requests waiting for it.
  const failing = supervisor.acquire('aoi').promise;
  cluster.exit(cluster.latest('aoi'), 1);
  await assert.rejects(failing, err => err.code === 'WORKER_EXITED');
  assert.equal(timers.active(1000).length, 0);

  cluster.exit(cluster.forks[0], 1);
  assert.equal(events('worker.exited')[1].restarting, true);
  // Requests for the default voice wait for the scheduled restart.
  let restarted = null;
  supervisor.acquire('kiritan').promise.then(lease => {
    restarted = lease;
  });
  assert.equal(cluster.forks.length, 2);
  timers.fire(1000);
  assert.equal(cluster.latest('kiritan').id, 3);
  cluster.latest('kiritan').ready(5003);
  await flush();
  assert.equal(restarted.port, 5003);
  restarted.release();

  // A crash loop slows restarts down instead of stopping them for good.
  const delays = [];
  for (let i = 0; i < 4; i += 1) {
    cluster.exit(cluster.latest('kiritan'), 1);
    const [handle] = timers.pending.filter(h => !h.cancelled);
    delays.push(handle.delayMs);
    timers.fire(handle.delayMs);
  }
  assert.deepEqual(delays, [1000, 1000, 30000, 30000]);
  assert.equal(events('cluster.restart_delayed').length, 2);
  supervisor.stop('test');
}

async function stopShutsEverythingDown() {
  const { cluster, timers, supervisor } = setup();
  cluster.forks[0].ready();
  const aoiLease = supervisor.acquire('aoi').promise;
  cluster.latest('aoi').ready();
  const aoi = await aoiLease;
  const waiting = supervisor.acquire('akane').promise;

  // The crashed default voice keeps its slot, so akane still waits.
  cluster.exit(cluster.forks[0], 1);
  assert.equal(timers.active(1000).length, 1);
  assert.equal(cluster.forks.length, 2);
  supervisor.stop('test');
  assert.equal(timers.active(1000).length, 0);
  assert(cluster.latest('aoi').shutdownRequested());
  await assert.rejects(waiting, err => err.statusCode === 503);
  await assert.rejects(
    supervisor.acquire('kiritan').promise,
    err => err.statusCode === 503
  );
  aoi.release();
  cluster.exit(cluster.latest('aoi'));
  assert.equal(cluster.forks.length, 2);
}

function packagedExecutableDropsExecArgv() {
  const { cluster, supervisor } = setup({ packaged: true });
  assert.deepEqual(cluster.settings.execArgv, []);
  supervisor.stop('test');
}

function workerHelpersSendMessages() {
  const messages = [];
  const send = message => messages.push(message);
  workerLogWriter(send)('line');
  workerMetricsWriter(send)({ active: 1 });
  workerReadyNotifier(send)(5000);
  assert.deepEqual(messages, [
    { type: LOG_MESSAGE, line: 'line' },
    { type: METRICS_MESSAGE, metrics: { active: 1 } },
    { type: READY_MESSAGE, port: 5000 },
  ]);
}

async function main() {
  await startsTheDefaultVoiceAndForwardsMessages();
  await startsOtherVoicesOnDemandAndStopsThemWhenIdle();
  await idleTimeoutZeroKeepsWorkers();
  await reassignsTheLeastRecentlyUsedIdleWorkerAtCapacity();
  await waitsWhenEveryWorkerIsBusy();
  await restartsOnlyTheDefaultVoice();
  await stopShutsEverythingDown();
  packagedExecutableDropsExecArgv();
  workerHelpersSendMessages();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
