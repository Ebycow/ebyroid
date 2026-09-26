const http = require('http');
const semver = require('semver');

const STREAMING_PATH = '/api/v2/audiostream';
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** @typedef {import('./wave_object')} WaveObject */
/** @typedef {import('./ebyroid')} Ebyroid */

function unused(...x) {
  return x;
}

/**
 * @param {http.ServerResponse} res
 * @param {number} code
 * @param {string} message
 */
function error4x(res, code, message) {
  const json = JSON.stringify({ error: message });
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
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
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {NodeJS.ReadableStream & {sampleRate:number,bitDepth:number,numChannels:number}} pcm
 * @returns {Promise<void>}
 */
function pipePcmStream(req, res, pcm) {
  return new Promise(resolve => {
    let settled = false;
    const writeHeaders = () => {
      if (res.headersSent) return;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Ebyroid-PCM-Sample-Rate': pcm.sampleRate,
        'Ebyroid-PCM-Bit-Depth': pcm.bitDepth,
        'Ebyroid-PCM-Number-Of-Channels': pcm.numChannels,
      });
    };
    function finish() {
      if (settled) return;
      settled = true;
      resolve();
    }
    function onData(chunk) {
      writeHeaders();
      if (!res.write(chunk)) pcm.pause();
    }
    function onEnd() {
      writeHeaders();
      res.end();
      finish();
    }
    function onError(err) {
      if (res.headersSent) res.destroy(err);
      else error500(res, err.code, err.message);
      finish();
    }
    function onClose() {
      if (!res.writableEnded && !res.destroyed) res.destroy();
      finish();
    }

    pcm.on('data', onData);
    res.on('drain', () => pcm.resume());
    pcm.once('end', onEnd);
    pcm.once('error', onError);
    pcm.once('close', onClose);
    req.once('aborted', () => pcm.destroy());
    res.once('close', () => {
      if (!res.writableEnded) pcm.destroy();
    });
  });
}

/**
 * @this MiniServer
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function onPostAudioStreamF(req, res) {
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

  try {
    const pcm =
      body.name && body.name !== this.defaultName
        ? await this.ebyroid.convertStreamEx(body.text, body.name)
        : await this.ebyroid.convertStream(body.text);
    return pipePcmStream(req, res, pcm);
  } catch (err) {
    return error500(res, err.code, err.message);
  }
}

/**
 * @this MiniServer
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URLSearchParams} params
 */
async function onGetAudioStreamF(req, res, params) {
  unused(req);
  const text = params.get('text');
  if (!text) {
    return error4x(res, 400, 'text was not given');
  }
  try {
    /** @type {WaveObject} */ let pcm;
    const name = params.get('name');
    if (name && name !== this.defaultName) {
      pcm = await this.ebyroid.convertEx(text, name);
    } else {
      pcm = await this.ebyroid.convert(text);
    }
    const buffer = Buffer.from(pcm.data.buffer);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.byteLength,
      'Ebyroid-PCM-Sample-Rate': pcm.sampleRate,
      'Ebyroid-PCM-Bit-Depth': pcm.bitDepth,
      'Ebyroid-PCM-Number-Of-Channels': pcm.numChannels,
    };
    res.writeHead(200, headers);
    res.write(buffer);
    res.end();
    return Promise.resolve();
  } catch (e) {
    return error500(res, e.code, e.message);
  }
}

/**
 * @this MiniServer
 * @param {http.ServerResponse} res
 * @param {URLSearchParams} params
 */
async function onGetAudioFileF(req, res, params) {
  if (killWrongSFD(req, res, 'audio/wav')) {
    return Promise.resolve();
  }

  const text = params.get('text');
  if (!text) {
    return error4x(res, 400, 'text was not given');
  }
  try {
    /** @type {WaveObject} */ let pcm;
    const name = params.get('name');
    if (name && name !== this.defaultName) {
      pcm = await this.ebyroid.convertEx(text, name);
    } else {
      pcm = await this.ebyroid.convert(text);
    }
    const dataBuffer = Buffer.from(pcm.data.buffer);
    const headerBuffer = pcm.waveFileHeader();
    const waveBuffer = Buffer.concat([headerBuffer, dataBuffer]);
    const headers = {
      'Content-Type': 'audio/wav',
      'Content-Length': waveBuffer.byteLength,
    };
    res.writeHead(200, headers);
    res.write(waveBuffer);
    res.end();
    return Promise.resolve();
  } catch (e) {
    return error500(res, e.code, e.message);
  }
}

/**
 * @this MiniServer
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function onRequestF(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}/`);
  if (url.pathname === STREAMING_PATH) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return error4x(res, 405, 'method not allowed');
    }
    return onPostAudioStreamF.call(this, req, res);
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
      return ok(res);
    case '/audiostream':
      return onGetAudioStreamF.call(this, req, res, url.searchParams);
    case '/audiofile':
      return onGetAudioFileF.call(this, req, res, url.searchParams);
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
  constructor(ebyroid, maxHeaderSize = 65536) {
    this.ebyroid = ebyroid;
    this.basePath = '/api/v1';

    let options = {};
    if (semver.gte(process.version, '13.3.0')) {
      // Setting maxHeaderSize on runtime was added in v13.3.0
      // https://github.com/nodejs/node/blob/master/doc/changelogs/CHANGELOG_V13.md#13.3.0
      options = { maxHeaderSize };
    }
    this.server = http.createServer(options, (req, res) => {
      onRequestF.call(this, req, res).catch(err => {
        if (res.headersSent) {
          res.destroy(err);
        } else {
          error500(res, err.code, err.message);
        }
      });
    });
  }

  /**
   * @param {number} port
   */
  start(port) {
    this.defaultName = this.ebyroid.using.name;
    this.server.listen(port);
  }
}

module.exports = MiniServer;
