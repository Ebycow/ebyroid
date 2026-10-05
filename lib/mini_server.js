const http = require('http');
const semver = require('semver');
const { silentLogger } = require('./logger');
const { SynthesisQueue } = require('./synthesis_queue');

const STREAMING_PATH = '/api/v2/audiostream';
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** @typedef {import('./wave_object')} WaveObject */
/** @typedef {import('./ebyroid')} Ebyroid */

/**
 * @param {http.ServerResponse} res
 * @param {number} code
 * @param {string} message
 */
function error4x(res, code, message, extraHeaders = {}) {
  const json = JSON.stringify({ error: message });
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    ...extraHeaders,
  };
  res.writeHead(code, headers);
  res.write(json);
  res.end();
}

/**
 * check if invalid Sec-Fetch-Dest
 *
 * @this MiniServer
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} minetype
 * @returns {boolean} true if killed
 */
function killWrongSFD(req, res, minetype) {
  const sfd = req.headers['sec-fetch-dest'];
  if (!sfd) {
    return false;
  }

  const invalids = ['document'];
  if (!invalids.includes(sfd)) {
    return false;
  }

  // a dummy response to the dickhead browser that sends us the same fucking request twice
  const headers = {
    'Content-Type': minetype,
    'Content-Length': 0,
  };
  res.writeHead(200, headers);
  res.end();
  return true;
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} ecode
 * @param {string} emessage
 */
function error500(res, ecode, emessage) {
  const json = JSON.stringify({
    error: 'internal server error',
    code: ecode,
    message: emessage,
  });
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  };
  res.writeHead(500, headers);
  res.write(json);
  res.end();
}

function failResponse(res, err) {
  if (res.headersSent) {
    if (!res.destroyed) res.destroy(err);
    return undefined;
  }
  return error500(res, err.code, err.message);
}

function ok(res) {
  const json = JSON.stringify({ status: 'ok' });
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  };
  res.writeHead(200, headers);
  res.write(json);
  res.end();
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('request body is too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          value === null ||
          typeof value !== 'object' ||
          Array.isArray(value)
        ) {
          throw new TypeError('request body must be a JSON object');
        }
        resolve(value);
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {http.ServerResponse} res
 * @returns {boolean}
 */
function responseClosed(res) {
  return res.destroyed === true || !res.socket || res.socket.destroyed === true;
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {NodeJS.ReadableStream & {sampleRate:number,bitDepth:number,numChannels:number}} pcm
 * @returns {Promise<void>}
 */
function pipePcmStream(req, res, pcm, context) {
  return new Promise(resolve => {
    let settled = false;
    let bytes = 0;
    let backpressureCount = 0;
    let drainStartedAt = null;
    let drainWaitMs = 0;
    const writeHeaders = () => {
      if (res.headersSent) return;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Ebyroid-PCM-Sample-Rate': pcm.sampleRate,
        'Ebyroid-PCM-Bit-Depth': pcm.bitDepth,
        'Ebyroid-PCM-Number-Of-Channels': pcm.numChannels,
      });
      context.logger.info('response.started', {
        statusCode: 200,
        firstByteMs: Date.now() - context.startedAt,
      });
    };
    function finish() {
      if (settled) return;
      settled = true;
      resolve();
    }
    function onData(chunk) {
      writeHeaders();
      bytes += chunk.byteLength;
      if (!res.write(chunk)) {
        backpressureCount += 1;
        drainStartedAt = Date.now();
        context.logger.debug('response.backpressure', {
          backpressureCount,
          bytes,
        });
        pcm.pause();
      }
    }
    function onEnd() {
      if (settled) return;
      writeHeaders();
      res.end();
      context.logger.info('response.completed', {
        bytes,
        backpressureCount,
        drainWaitMs,
      });
      finish();
    }
    function onError(err) {
      context.logger.error('request.failed', { err });
      if (res.headersSent) res.destroy(err);
      else error500(res, err.code, err.message);
      finish();
    }
    function onClose() {
      if (!res.writableEnded && !res.destroyed) res.destroy();
      finish();
    }

    pcm.on('data', onData);
    res.on('drain', () => {
      if (drainStartedAt !== null) {
        drainWaitMs += Date.now() - drainStartedAt;
        drainStartedAt = null;
      }
      pcm.resume();
    });
    pcm.once('end', onEnd);
    pcm.once('error', onError);
    pcm.once('close', onClose);
    req.once('aborted', () => pcm.destroy());
    res.once('close', () => {
      if (!res.writableEnded) pcm.destroy();
    });
    // The client may have gone away while this request waited for the
    // native engine; 'close' has then already fired and will not repeat.
    if (responseClosed(res)) pcm.destroy();
  });
}

function waitForSynthesis(pcm) {
  if (pcm.completion) return pcm.completion;
  return new Promise(resolve => {
    pcm.once('end', () => resolve({}));
    pcm.once('error', err => resolve({ err }));
  });
}

/**
 * Runs a synthesis task through the queue and maps queue and task failures
 * to an HTTP response.
 *
 * @this MiniServer
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {() => Promise<void>} task
 */
async function runQueued(req, res, context, task) {
  const ticket = this.queue.add(task, { logger: context.logger });
  req.once('aborted', ticket.cancel);
  try {
    return await ticket.promise;
  } catch (err) {
    if (err.code === 'REQUEST_ABORTED') return undefined;
    if (err.statusCode === 503) {
      return error4x(res, 503, err.message, { 'Retry-After': '1' });
    }
    context.logger.error('request.failed', { err });
    return failResponse(res, err);
  }
}

/**
 * @this MiniServer
 * @param {string} text
 * @param {string|null|undefined} name
 * @returns {Promise<WaveObject>}
 */
function synthesize(text, name, context) {
  const options = { logger: context.logger };
  return name && name !== this.defaultName
    ? this.ebyroid.convertEx(text, name, options)
    : this.ebyroid.convert(text, options);
}

/**
 * @param {http.ServerResponse} res
 * @param {Buffer} buffer
 * @param {object} headers
 */
function sendBuffer(res, context, buffer, headers) {
  res.writeHead(200, { ...headers, 'Content-Length': buffer.byteLength });
  context.logger.info('response.started', {
    statusCode: 200,
    firstByteMs: Date.now() - context.startedAt,
  });
  res.write(buffer);
  res.end();
  context.logger.info('response.completed', { bytes: buffer.byteLength });
}

/**
 * @this MiniServer
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function onPostAudioStreamF(req, res, context) {
  const contentType = String(req.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    return error4x(res, 415, 'content-type must be application/json');
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return error4x(res, err.statusCode || 400, err.message);
  }
  if (typeof body.text !== 'string' || body.text.length === 0) {
    return error4x(res, 400, 'text was not given');
  }
  if (typeof body.name !== 'undefined' && typeof body.name !== 'string') {
    return error4x(res, 400, 'name must be a string');
  }

  const voice = body.name || this.defaultName;
  context.logger.info('request.validated', {
    textChars: body.text.length,
    voice,
  });

  let delivery;
  await runQueued.call(this, req, res, context, async () => {
    const options = { logger: context.logger };
    const pcm =
      body.name && body.name !== this.defaultName
        ? await this.ebyroid.convertStreamEx(body.text, body.name, options)
        : await this.ebyroid.convertStream(body.text, options);
    // From here on pipePcmStream owns the response, including errors; the
    // queue slot is held only until the native engine is free again.
    delivery = pipePcmStream(req, res, pcm, context);
    await waitForSynthesis(pcm);
  });
  return delivery;
}

/**
 * @this MiniServer
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URLSearchParams} params
 */
async function onGetAudioStreamF(req, res, params, context) {
  const text = params.get('text');
  if (!text) {
    return error4x(res, 400, 'text was not given');
  }
  const name = params.get('name');
  const voice = name || this.defaultName;
  context.logger.info('request.validated', { textChars: text.length, voice });
  return runQueued.call(this, req, res, context, async () => {
    const pcm = await synthesize.call(this, text, name, context);
    sendBuffer(res, context, Buffer.from(pcm.data.buffer), {
      'Content-Type': 'application/octet-stream',
      'Ebyroid-PCM-Sample-Rate': pcm.sampleRate,
      'Ebyroid-PCM-Bit-Depth': pcm.bitDepth,
      'Ebyroid-PCM-Number-Of-Channels': pcm.numChannels,
    });
  });
}

/**
 * @this MiniServer
 * @param {http.ServerResponse} res
 * @param {URLSearchParams} params
 */
async function onGetAudioFileF(req, res, params, context) {
  if (killWrongSFD(req, res, 'audio/wav')) {
    return Promise.resolve();
  }

  const text = params.get('text');
  if (!text) {
    return error4x(res, 400, 'text was not given');
  }
  const name = params.get('name');
  const voice = name || this.defaultName;
  context.logger.info('request.validated', { textChars: text.length, voice });
  return runQueued.call(this, req, res, context, async () => {
    const pcm = await synthesize.call(this, text, name, context);
    const waveBuffer = Buffer.concat([
      pcm.waveFileHeader(),
      Buffer.from(pcm.data.buffer),
    ]);
    sendBuffer(res, context, waveBuffer, { 'Content-Type': 'audio/wav' });
  });
}

function safeRoute(pathname) {
  const routes = [
    STREAMING_PATH,
    '/api/v1',
    '/api/v1/',
    '/api/v1/audiostream',
    '/api/v1/audiofile',
    '/api/v1/health',
  ];
  return routes.includes(pathname) ? pathname : 'unknown';
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

/**
 * @this MiniServer
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function onRequestF(req, res, context) {
  const url = new URL(req.url, `http://${req.headers.host}/`);
  // The response lifecycle handlers share this request-scoped context.
  // eslint-disable-next-line no-param-reassign
  context.route = safeRoute(url.pathname);
  // eslint-disable-next-line no-param-reassign
  context.logger = context.logger.child({ route: context.route });
  context.logger.info('request.received', { method: req.method });
  if (url.pathname === STREAMING_PATH) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return error4x(res, 405, 'method not allowed');
    }
    return onPostAudioStreamF.call(this, req, res, context);
  }

  if (req.method !== 'GET') {
    return error4x(res, 400, 'bad request');
  }
  if (!url.pathname.startsWith(this.basePath)) {
    return error4x(res, 404, 'not found');
  }

  const pathname = url.pathname.slice(this.basePath.length);
  switch (pathname) {
    case '':
    case '/':
    case '/health':
      return ok(res);
    case '/audiostream':
      return onGetAudioStreamF.call(this, req, res, url.searchParams, context);
    case '/audiofile':
      return onGetAudioFileF.call(this, req, res, url.searchParams, context);
    default:
      return error4x(res, 404, 'not found');
  }
}

/**
 * Ebyroid's built-in audiostream server
 */
class MiniServer {
  /**
   * @param {Ebyroid} ebyroid
   * @param {number} maxHeaderSize requires Node v13.3.0 or higher
   */
  constructor(ebyroid, options = {}) {
    this.ebyroid = ebyroid;
    this.basePath = '/api/v1';
    const normalized =
      typeof options === 'number' ? { maxHeaderSize: options } : options;
    this.logger = normalized.logger || silentLogger();
    this.requestSequence = 0;
    this.metrics = {
      startedAt: Date.now(),
      lastSnapshotAt: Date.now(),
      lastCompleted: 0,
      received: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      aborted: 0,
      requestDurations: [],
    };
    this.metricsSink = normalized.metricsSink;
    this.metricsTimer = null;
    this.queue =
      normalized.queue ||
      new SynthesisQueue({
        concurrency: 1,
        limit: normalized.queueLimit,
        timeoutMs: normalized.queueTimeoutMs,
        logger: this.logger,
      });

    let serverOptions = {};
    if (semver.gte(process.version, '13.3.0')) {
      // Setting maxHeaderSize on runtime was added in v13.3.0
      // https://github.com/nodejs/node/blob/master/doc/changelogs/CHANGELOG_V13.md#13.3.0
      serverOptions = { maxHeaderSize: normalized.maxHeaderSize || 65536 };
    }
    this.server = http.createServer(serverOptions, (req, res) => {
      this.requestSequence += 1;
      const context = {
        startedAt: Date.now(),
        logger: this.logger.child({
          requestId: `${process.pid}-${this.requestSequence}`,
        }),
        route: 'unknown',
      };
      this.metrics.received += 1;
      let completed = false;
      res.once('finish', () => {
        completed = true;
        const durationMs = Date.now() - context.startedAt;
        this.metrics.completed += 1;
        if (res.statusCode >= 500) this.metrics.failed += 1;
        if (res.statusCode === 503) this.metrics.rejected += 1;
        this.metrics.requestDurations.push(durationMs);
        if (this.metrics.requestDurations.length > 1000) {
          this.metrics.requestDurations.shift();
        }
        context.logger.info('request.completed', {
          statusCode: res.statusCode,
          durationMs,
        });
      });
      res.once('close', () => {
        if (!completed) {
          this.metrics.aborted += 1;
          context.logger.warn('request.aborted', {
            phase: 'response',
            durationMs: Date.now() - context.startedAt,
          });
        }
      });
      onRequestF.call(this, req, res, context).catch(err => {
        context.logger.error('request.failed', { err });
        if (res.headersSent) {
          res.destroy(err);
        } else {
          error500(res, err.code, err.message);
        }
      });
    });
    if (normalized.metricsIntervalMs > 0) {
      this.metricsTimer = setInterval(
        () => this.logMetrics(),
        normalized.metricsIntervalMs
      );
      if (this.metricsTimer.unref) this.metricsTimer.unref();
    }
  }

  logMetrics() {
    const now = Date.now();
    const elapsedSeconds = Math.max(
      (now - this.metrics.lastSnapshotAt) / 1000,
      0.001
    );
    const completedSinceLast =
      this.metrics.completed - this.metrics.lastCompleted;
    const snapshot = {
      uptimeMs: now - this.metrics.startedAt,
      active: this.queue.active,
      queued: this.queue.depth,
      rps: Number((completedSinceLast / elapsedSeconds).toFixed(2)),
      received: this.metrics.received,
      completed: this.metrics.completed,
      failed: this.metrics.failed,
      rejected: this.metrics.rejected,
      aborted: this.metrics.aborted,
      requestP50Ms: percentile(this.metrics.requestDurations, 0.5),
      requestP95Ms: percentile(this.metrics.requestDurations, 0.95),
    };
    this.metrics.lastSnapshotAt = now;
    this.metrics.lastCompleted = this.metrics.completed;
    this.logger.info('metrics.snapshot', snapshot);
    if (this.metricsSink) this.metricsSink(snapshot);
    return snapshot;
  }

  /**
   * @param {number} port
   */
  start(port) {
    this.defaultName = this.ebyroid.using.name;
    this.server.listen(port);
  }

  stop() {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    return new Promise((resolve, reject) => {
      this.server.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

module.exports = MiniServer;
