/* eslint-disable max-classes-per-file, no-param-reassign */
const { silentLogger } = require('./logger');

class QueueError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class SynthesisQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 1;
    this.limit = Number.isInteger(options.limit) ? options.limit : 20;
    this.timeoutMs = Number.isInteger(options.timeoutMs)
      ? options.timeoutMs
      : 10000;
    this.logger = options.logger || silentLogger();
    this.active = 0;
    this.waiting = [];
  }

  get depth() {
    return this.waiting.length;
  }

  add(task, options = {}) {
    const logger = options.logger || this.logger;
    const item = {
      task,
      logger,
      enqueuedAt: Date.now(),
      started: false,
      settled: false,
      timer: null,
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });

    if (this.active < this.concurrency) {
      this.start(item);
    } else if (this.waiting.length >= this.limit) {
      item.settled = true;
      const err = new QueueError('QUEUE_FULL', 'synthesis queue is full', 503);
      logger.warn('request.rejected', {
        reason: 'queue_full',
        active: this.active,
        queued: this.depth,
      });
      item.reject(err);
    } else {
      this.waiting.push(item);
      logger.debug('queue.enqueued', {
        active: this.active,
        queued: this.depth,
      });
      if (this.timeoutMs > 0) {
        item.timer = setTimeout(() => this.timeout(item), this.timeoutMs);
      }
    }

    return {
      promise,
      cancel: () => this.cancel(item),
    };
  }

  start(item) {
    if (item.settled) return;
    item.started = true;
    if (item.timer) clearTimeout(item.timer);
    this.active += 1;
    item.logger.debug('queue.dequeued', {
      waitMs: Date.now() - item.enqueuedAt,
      active: this.active,
      queued: this.depth,
    });
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        item.settled = true;
        this.active -= 1;
        this.drain();
      });
  }

  drain() {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const item = this.waiting.shift();
      this.start(item);
    }
  }

  remove(item) {
    const index = this.waiting.indexOf(item);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    if (item.timer) clearTimeout(item.timer);
    return true;
  }

  timeout(item) {
    if (!this.remove(item)) return;
    item.settled = true;
    const err = new QueueError(
      'QUEUE_TIMEOUT',
      'synthesis queue wait timed out',
      503
    );
    item.logger.warn('request.rejected', {
      reason: 'queue_timeout',
      waitMs: Date.now() - item.enqueuedAt,
      active: this.active,
      queued: this.depth,
    });
    item.reject(err);
  }

  cancel(item) {
    if (item.started || item.settled || !this.remove(item)) return false;
    item.settled = true;
    const err = new QueueError(
      'REQUEST_ABORTED',
      'request aborted while waiting for synthesis',
      499
    );
    item.logger.warn('request.aborted', {
      phase: 'queued',
      waitMs: Date.now() - item.enqueuedAt,
      active: this.active,
      queued: this.depth,
    });
    item.reject(err);
    return true;
  }
}

module.exports = { QueueError, SynthesisQueue };
