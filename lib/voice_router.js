const http = require('http');
const { silentLogger } = require('./logger');
const { voiceList } = require('./voice_list');

const STREAMING_PATH = '/api/v2/audiostream';
const MAX_JSON_BODY_BYTES = 64 * 1024;

function sendJson(res, code, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    ...extraHeaders,
  });
  res.end(json);
}

// Headers that describe a single connection and must not be forwarded.
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
];

function withoutHopByHop(headers) {
  const copy = { ...headers };
  HOP_BY_HOP_HEADERS.forEach(name => delete copy[name]);
  return copy;
}

/**
 * Buffers a JSON body so the voice name can be read before forwarding.
 * Bodies over the limit are rejected here exactly as the worker would.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<Buffer|null>} null when the body is too large
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_JSON_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(size > MAX_JSON_BODY_BYTES ? null : Buffer.concat(chunks))
    );
    req.on('error', reject);
  });
}

function nameFromJson(body) {
  try {
    const value = JSON.parse(body.toString('utf8'));
    return value && typeof value.name === 'string' ? value.name : null;
  } catch (err) {
    return null;
  }
}

/**
 * Forwards one request to a worker and relays its response as it arrives.
 * The worker lease is released once the exchange is over, whichever way.
 */
function forward(req, res, body, worker, logger) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      worker.release();
      resolve();
    };
    const headers = withoutHopByHop(req.headers);
    // One connection per request, so a stopping worker never waits for
    // idle keep-alive sockets.
    headers.connection = 'close';
    if (body) {
      delete headers['transfer-encoding'];
      headers['content-length'] = body.length;
    }
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: worker.port,
        method: req.method,
        path: req.url,
        headers,
      },
      upstreamRes => {
        res.writeHead(
          upstreamRes.statusCode,
          withoutHopByHop(upstreamRes.headers)
        );
        upstreamRes.pipe(res);
        upstreamRes.once('end', finish);
        upstreamRes.once('aborted', () => {
          res.destroy();
          finish();
        });
      }
    );
    upstream.once('error', err => {
      logger.error('request.forward_failed', { voice: worker.voice, err });
      if (res.headersSent) res.destroy(err);
      else sendJson(res, 502, { error: 'voice worker is unavailable' });
      finish();
    });
    // The worker stops synthesising for a client that has gone away.
    res.once('close', () => {
      if (!res.writableEnded) upstream.destroy();
      finish();
    });
    if (body) upstream.end(body);
    else req.pipe(upstream);
  });
}

/**
 * The primary process's HTTP front. It answers health checks itself and
 * forwards every other request unchanged to the worker of the requested
 * voice, so the workers keep doing validation, queueing and synthesis.
 * Requests for unknown voices go to the default worker, which reports the
 * error exactly as a single-process server would.
 */
class VoiceRouter {
  /**
   * @param {{ acquire: function(string): { promise: Promise<object>, cancel: function():void } }} pool
   * @param {{ voiceNames: string[], defaultName: string, logger?: object }} options
   */
  constructor(pool, options) {
    this.pool = pool;
    this.voiceNames = new Set(options.voiceNames);
    this.defaultName = options.defaultName;
    this.logger = options.logger || silentLogger();
    this.requestSequence = 0;
    this.server = http.createServer((req, res) => {
      this.requestSequence += 1;
      const logger = this.logger.child({
        requestId: `${process.pid}-${this.requestSequence}`,
      });
      this.route(req, res, logger).catch(err => {
        logger.error('request.failed', { err });
        if (res.headersSent) res.destroy(err);
        else sendJson(res, 500, { error: 'internal server error' });
      });
    });
  }

  voiceFor(name) {
    return name && this.voiceNames.has(name) ? name : this.defaultName;
  }

  async route(req, res, logger) {
    const url = new URL(req.url, `http://${req.headers.host}/`);
    if (
      req.method === 'GET' &&
      (url.pathname === '/api/v1' || url.pathname === '/api/v1/')
    ) {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    // Liveness for monitoring: healthy only while the default voice's
    // worker is up, since that is the one expected to always be serving.
    if (req.method === 'GET' && url.pathname === '/api/v1/health') {
      const ready = this.pool
        .status()
        .some(w => w.voice === this.defaultName && w.ready && !w.stopping);
      sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ok' : 'unavailable',
      });
      return;
    }
    // The voice list comes from the config, so it never wakes a worker.
    if (req.method === 'GET' && url.pathname === '/api/v1/voices') {
      sendJson(
        res,
        200,
        voiceList(Array.from(this.voiceNames), this.defaultName)
      );
      return;
    }

    let body = null;
    let voice;
    if (url.pathname === STREAMING_PATH && req.method === 'POST') {
      body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { error: 'request body is too large' });
        return;
      }
      voice = this.voiceFor(nameFromJson(body));
    } else {
      voice = this.voiceFor(url.searchParams.get('name'));
    }

    const ticket = this.pool.acquire(voice);
    const cancel = () => ticket.cancel();
    req.once('aborted', cancel);
    let worker;
    try {
      worker = await ticket.promise;
    } catch (err) {
      if (err.code === 'REQUEST_ABORTED') return;
      if (err.statusCode === 503) {
        sendJson(res, 503, { error: err.message }, { 'Retry-After': '1' });
        return;
      }
      if (err.code === 'WORKER_EXITED') {
        logger.error('request.forward_failed', { voice, err });
        sendJson(res, 502, { error: 'voice worker is unavailable' });
        return;
      }
      throw err;
    } finally {
      req.removeListener('aborted', cancel);
    }
    logger.debug('request.routed', { voice, workerId: worker.workerId });
    await forward(req, res, body, worker, logger);
  }

  /**
   * @param {number} port
   */
  start(port) {
    this.server.listen(port);
  }

  stop() {
    return new Promise((resolve, reject) => {
      this.server.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

module.exports = VoiceRouter;
