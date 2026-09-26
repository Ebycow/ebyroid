/* eslint-disable no-console, max-classes-per-file */
const assert = require('assert').strict;
const { EventEmitter } = require('events');
const { Logger } = require('../lib/logger');
const {
  LOG_MESSAGE,
  startCluster,
  workerLogWriter,
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
  });

  assert.equal(cluster.forks, 2);
  assert.equal(cluster.schedulingPolicy, cluster.SCHED_RR);
  cluster.workers[1].emit('message', {
    type: LOG_MESSAGE,
    line: '{"event":"request.received"}',
  });
  assert.deepEqual(output, ['{"event":"request.received"}']);

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
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
