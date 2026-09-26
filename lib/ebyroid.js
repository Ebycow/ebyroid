const assert = require('assert').strict;
const iconv = require('iconv-lite');
const { PassThrough } = require('stream');
/** @type {import("./module_def")} */
const native = require('../dll/ebyroid.node'); // eslint-disable-line node/no-unpublished-require
const { silentLogger } = require('./logger');
const Semaphore = require('./semaphore');
const WaveObject = require('./wave_object');

/** @typedef {import("./module_def").NativeOptions} NativeOptions */

/** @typedef {import("./voiceroid")} Voiceroid */

// shift-jis
const SHIFT_JIS = 'shiftjis';

/**
 * Class-wise global semaphore object.
 *
 * @type {Semaphore}
 */
const semaphore = new Semaphore(1);

/**
 * @type {Voiceroid[]}
 */
const fifo = [];

/**
 * The voiceroid that is currently used **in the native library**.
 *
 * @type {Voiceroid?}
 */
let current = null;

/**
 * @type {Ebyroid?}
 */
let singleton = null;

/**
 * @param {Ebyroid} self
 */
function validateOpCall(self) {
  assert(self.using !== null, 'operation calls must be called after .use()');
  assert(current !== null, 'ebyroid native module must have been initialized');
}

/**
 * @param {Voiceroid} vr
 * @param {Error} err
 * @returns {Voiceroid}
 */
function errorroid(vr, err) {
  // FIXME more graceful way to handle errors?
  return Object.assign(Object.create(Object.getPrototypeOf(vr)), vr, {
    baseDirPath: 'error',
    voiceDirName: err.message,
  });
}

/**
 * @returns {Voiceroid?}
 */
function lastRegistered() {
  const vr = fifo[fifo.length - 1];
  return vr || null;
}

/**
 * @param {Voiceroid} vr
 */
function register(vr) {
  fifo.push(vr);
}

/**
 * @param {Voiceroid} vr
 */
function unregister(vr) {
  assert(vr === fifo[0], 'unregisteration is equivalent to fifo.shift()');
  fifo.shift();
}

function loggerFor(self, context) {
  return (context && context.logger) || self.logger;
}

function pcmDurationMs(bytes, sampleRate) {
  return Math.round((bytes / (sampleRate * 2)) * 1000);
}

/**
 * @param {Voiceroid} vr
 * @returns {boolean}
 */
function needsLibraryReload(vr) {
  const lastreg = lastRegistered();
  const comparison = lastreg || current;
  return !vr.usesSameLibrary(comparison);
}

/**
 * @this Ebyroid
 * @param {string} text
 * @param {Voiceroid} vr
 * @returns {Promise<WaveObject>}
 */
async function internalConvertF(text, vr, context) {
  const logger = loggerFor(this, context);
  const buffer = iconv.encode(text, SHIFT_JIS);
  const waitingAt = Date.now();
  logger.debug('native.slot.waiting', { voice: vr.name });
  await semaphore.acquire();
  logger.debug('native.slot.acquired', {
    voice: vr.name,
    waitMs: Date.now() - waitingAt,
  });
  const startedAt = Date.now();
  logger.info('synthesis.started', {
    voice: vr.name,
    textChars: text.length,
    streaming: false,
  });

  try {
    assert(vr.usesSameLibrary(current), 'it must not need to reload');
    current = vr;

    // TODO setup full options here
    const options = {
      needs_reload: false,
      volume: vr.outputVolume,
    };

    const pcmOut = await new Promise((resolve, reject) => {
      native.convert(buffer, options, (err, output) => {
        if (err) {
          reject(err);
        } else {
          resolve(output);
        }
      });
    });
    const result = new WaveObject(pcmOut, vr.outputSampleRate);
    logger.info('synthesis.completed', {
      voice: vr.name,
      durationMs: Date.now() - startedAt,
      pcmBytes: result.data.byteLength,
      audioMs: pcmDurationMs(result.data.byteLength, result.sampleRate),
    });
    return result;
  } catch (err) {
    logger.error('synthesis.failed', {
      voice: vr.name,
      durationMs: Date.now() - startedAt,
      err,
    });
    throw err;
  } finally {
    semaphore.release();
    logger.debug('native.slot.released', { voice: vr.name });
  }
}

/**
 * Start a native PCM stream and run finalization exactly once.
 *
 * @param {Buffer} buffer Shift-JIS input
 * @param {NativeOptions} options native conversion options
 * @param {Voiceroid} vr voice metadata
 * @param {function(Error?):void} finalize releases the native-operation permit
 * @returns {PassThrough}
 */
function startNativeStream(buffer, options, vr, finalize, logger, startedAt) {
  const stream = new PassThrough();
  stream.sampleRate = vr.outputSampleRate;
  stream.bitDepth = 16;
  stream.numChannels = 1;

  let finalized = false;
  let chunks = 0;
  let pcmBytes = 0;
  let firstChunkAt = null;
  let lastProgressAt = startedAt;
  const finish = err => {
    if (finalized) return;
    finalized = true;
    try {
      finalize(err);
    } finally {
      const fields = {
        voice: vr.name,
        durationMs: Date.now() - startedAt,
        chunks,
        pcmBytes,
        audioMs: pcmDurationMs(pcmBytes, vr.outputSampleRate),
      };
      if (err) {
        logger.error('synthesis.failed', { ...fields, err });
        stream.destroy(err);
      } else {
        logger.info('synthesis.completed', fields);
        stream.end();
      }
    }
  };

  native.convertStream(buffer, options, (err, chunk) => {
    if (err) {
      finish(err);
    } else if (chunk === null) {
      finish();
    } else if (!stream.destroyed) {
      chunks += 1;
      pcmBytes += chunk.byteLength;
      if (firstChunkAt === null) {
        firstChunkAt = Date.now();
        logger.info('synthesis.first_chunk', {
          voice: vr.name,
          firstChunkMs: firstChunkAt - startedAt,
          pcmBytes: chunk.byteLength,
        });
      }
      logger.trace('synthesis.chunk', {
        voice: vr.name,
        chunk: chunks,
        pcmBytes: chunk.byteLength,
      });
      if (Date.now() - lastProgressAt >= 500) {
        lastProgressAt = Date.now();
        logger.debug('synthesis.progress', {
          voice: vr.name,
          chunks,
          pcmBytes,
          audioMs: pcmDurationMs(pcmBytes, vr.outputSampleRate),
        });
      }
      stream.write(chunk);
    }
  });
  return stream;
}

/**
 * @this Ebyroid
 * @param {string} text
 * @param {Voiceroid} vr
 * @returns {Promise<PassThrough>}
 */
async function internalConvertStreamF(text, vr, context) {
  const logger = loggerFor(this, context);
  const buffer = iconv.encode(text, SHIFT_JIS);
  const waitingAt = Date.now();
  logger.debug('native.slot.waiting', { voice: vr.name });
  await semaphore.acquire();
  logger.debug('native.slot.acquired', {
    voice: vr.name,
    waitMs: Date.now() - waitingAt,
  });
  const startedAt = Date.now();
  logger.info('synthesis.started', {
    voice: vr.name,
    textChars: text.length,
    streaming: true,
  });

  try {
    assert(vr.usesSameLibrary(current), 'it must not need to reload');
    current = vr;
    const options = {
      needs_reload: false,
      volume: vr.outputVolume,
    };
    return startNativeStream(
      buffer,
      options,
      vr,
      () => {
        semaphore.release();
        logger.debug('native.slot.released', { voice: vr.name });
      },
      logger,
      startedAt
    );
  } catch (err) {
    semaphore.release();
    logger.debug('native.slot.released', { voice: vr.name });
    logger.error('synthesis.failed', {
      voice: vr.name,
      durationMs: Date.now() - startedAt,
      err,
    });
    throw err;
  }
}

/**
 * Ebyroid class provides an access to the native VOICEROID+/VOICEROID2 libraries.
 */
class Ebyroid {
  /**
   * Construct an Ebyroid instance.
   *
   * @param  {...Voiceroid} voiceroids voiceroids to use.
   */
  constructor(...voiceroids) {
    assert(voiceroids.length > 0, 'at least one voiceroid must be given');
    this.logger = silentLogger();

    /**
     * voiceroids to use.
     *
     * @type {Map<string, Voiceroid>}
     */
    this.voiceroids = new Map();
    voiceroids.forEach(vr => this.voiceroids.set(vr.name, vr));

    /**
     * the voiceroid currently used **by this instance**.
     *
     * @type {Voiceroid?}
     */
    this.using = null;
  }

  /**
   * Let ebyroid use a specific voiceroid library.
   * Distinctively, this operation may take a few seconds to complete when called first time.
   *
   * @param {string} voiceroidName a name identifier of the voiceroid to use
   * @example
   * const yukari = new Voiceroid('Yukari-chan', 'C:\\Program Files (x86)\\AHS\\VOICEROID2', 'yukari_44');
   * const kiritan = new Voiceroid('Kiritan-chan', 'C:\\Program Files (x86)\\AHS\\VOICEROID+\\KiritanEX', 'kiritan_22');
   * const ebyroid = new Ebyroid(yukari, kiritan);
   * ebyroid.use('Kiritan-chan');
   */
  use(voiceroidName) {
    const vr = this.voiceroids.get(voiceroidName);
    if (!vr) {
      throw new Error(`Could not find a voiceroid by name "${voiceroidName}".`);
    }

    if (current === null) {
      const startedAt = Date.now();
      this.logger.info('native.init.started', { voice: vr.name });
      try {
        native.init(vr.baseDirPath, vr.voiceDirName, vr.outputVolume);
      } catch (err) {
        this.logger.error('native.init.failed', { voice: vr.name, err });
        throw err;
      }
      current = vr;
      this.logger.info('native.init.completed', {
        voice: vr.name,
        durationMs: Date.now() - startedAt,
      });
    }
    this.using = vr;
  }

  setLogger(logger) {
    this.logger = logger || silentLogger();
    return this;
  }

  /**
   * Convert text to a PCM buffer.
   * When a voiceroid corresponding to the given voiceroidName uses a different voice library than
   * the one currently used in the native library, it will acquire a mutex lock and reload native library.
   * In which case it may block all of other requests for fair amount of time like a two or three seconds.
   * See {@link Voiceroid} for further details.
   *
   * @param {string} text Raw utf-8 text to convert
   * @param {string} voiceroidName a name identifier of the voiceroid to use
   * @returns {Promise<WaveObject>} object that consists of a raw PCM buffer and format information
   */
  async convertEx(text, voiceroidName, context) {
    if (this.using === null) {
      // only when a user called this method without calling .use() once
      this.use(voiceroidName);
    }
    validateOpCall(this);

    const vr = this.voiceroids.get(voiceroidName);
    if (!vr) {
      throw new Error(`Could not find a voiceroid by name "${voiceroidName}".`);
    }

    if (!needsLibraryReload(vr)) {
      return internalConvertF.call(this, text, vr, context);
    }

    const logger = loggerFor(this, context);
    const buffer = iconv.encode(text, SHIFT_JIS);

    register(vr);

    const waitingAt = Date.now();
    logger.debug('native.slot.waiting', { voice: vr.name, reload: true });
    await semaphore.lock();
    logger.debug('native.slot.acquired', {
      voice: vr.name,
      reload: true,
      waitMs: Date.now() - waitingAt,
    });
    const startedAt = Date.now();
    logger.info('voice.reload.started', { voice: vr.name });

    try {
      assert(!vr.usesSameLibrary(current), 'it must need to reload');

      /** @type {NativeOptions} */
      const options = {
        needs_reload: true,
        base_dir: vr.baseDirPath,
        voice: vr.voiceDirName,
        volume: vr.outputVolume,
      };

      const pcmOut = await new Promise((resolve, reject) => {
        native.convert(buffer, options, (err, output) => {
          if (err) {
            reject(err);
          } else {
            resolve(output);
          }
        });
      });
      current = vr;
      const result = new WaveObject(pcmOut, vr.outputSampleRate);
      logger.info('voice.reload.completed', {
        voice: vr.name,
        durationMs: Date.now() - startedAt,
      });
      logger.info('synthesis.completed', {
        voice: vr.name,
        durationMs: Date.now() - startedAt,
        pcmBytes: result.data.byteLength,
        audioMs: pcmDurationMs(result.data.byteLength, result.sampleRate),
      });
      return result;
    } catch (err) {
      current = errorroid(vr, err);
      logger.error('synthesis.failed', {
        voice: vr.name,
        durationMs: Date.now() - startedAt,
        err,
      });
      throw err;
    } finally {
      try {
        unregister(vr);
      } finally {
        semaphore.unlock();
        logger.debug('native.slot.released', { voice: vr.name, reload: true });
      }
    }
  }

  /**
   * Convert text to a PCM buffer. Prefer using this method whenever you can.
   *
   * @param {string} text Raw utf-8 text to convert
   * @returns {Promise<WaveObject>} object that consists of a raw PCM buffer and format information
   */
  convert(text, context) {
    validateOpCall(this);
    if (needsLibraryReload(this.using)) {
      return this.convertEx(text, this.using.name, context);
    }
    return internalConvertF.call(this, text, this.using, context);
  }

  /**
   * Convert text while exposing PCM chunks as soon as the native engine emits them.
   *
   * @param {string} text Raw UTF-8 text to convert
   * @returns {Promise<PassThrough>} raw 16-bit mono PCM stream with format properties
   */
  convertStream(text, context) {
    validateOpCall(this);
    if (needsLibraryReload(this.using)) {
      return this.convertStreamEx(text, this.using.name, context);
    }
    return internalConvertStreamF.call(this, text, this.using, context);
  }

  /**
   * Convert text with a selected voice while exposing native PCM chunks.
   *
   * @param {string} text Raw UTF-8 text to convert
   * @param {string} voiceroidName voice identifier
   * @returns {Promise<PassThrough>} raw 16-bit mono PCM stream with format properties
   */
  async convertStreamEx(text, voiceroidName, context) {
    if (this.using === null) this.use(voiceroidName);
    validateOpCall(this);

    const vr = this.voiceroids.get(voiceroidName);
    if (!vr) {
      throw new Error(`Could not find a voiceroid by name "${voiceroidName}".`);
    }
    if (!needsLibraryReload(vr)) {
      return internalConvertStreamF.call(this, text, vr, context);
    }

    const logger = loggerFor(this, context);
    const buffer = iconv.encode(text, SHIFT_JIS);
    register(vr);
    const waitingAt = Date.now();
    logger.debug('native.slot.waiting', { voice: vr.name, reload: true });
    await semaphore.lock();
    logger.debug('native.slot.acquired', {
      voice: vr.name,
      reload: true,
      waitMs: Date.now() - waitingAt,
    });
    const startedAt = Date.now();
    logger.info('voice.reload.started', { voice: vr.name });

    let cleanedUp = false;
    const cleanup = err => {
      if (cleanedUp) return;
      cleanedUp = true;
      current = err ? errorroid(vr, err) : vr;
      try {
        unregister(vr);
      } finally {
        semaphore.unlock();
        logger.debug('native.slot.released', { voice: vr.name, reload: true });
      }
    };

    try {
      const options = {
        needs_reload: true,
        base_dir: vr.baseDirPath,
        voice: vr.voiceDirName,
        volume: vr.outputVolume,
      };
      return startNativeStream(buffer, options, vr, cleanup, logger, startedAt);
    } catch (err) {
      cleanup(err);
      throw err;
    }
  }

  /**
   * (Not Recommended) Compile text to an certain intermediate representation called 'AI Kana' that VOICEROID uses internally.
   * This method exists only to gratify your curiosity. No other use for it.
   *
   * @param {string} rawText Raw utf-8 text to reinterpret into 'AI Kana' representation
   * @returns {Promise<string>} AI Kana representation of the text
   */
  async rawApiCallTextToKana(rawText) {
    validateOpCall(this);
    const buffer = iconv.encode(rawText, SHIFT_JIS);
    await semaphore.acquire();

    try {
      const output = await new Promise((resolve, reject) => {
        native.reinterpret(buffer, {}, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      });
      return iconv.decode(output, SHIFT_JIS);
    } finally {
      semaphore.release();
    }
  }

  /**
   * (Not Recommended) Read out the given text __written in an intermediate representation called 'AI Kana'__ that VOICEROID uses internally.
   * This method exists only to gratify your curiosity. No other use for it.
   *
   * @param {string} aiKana AI Kana representation to read out
   * @returns {Promise<WaveObject>} object that consists of a raw PCM buffer and format information
   */
  async rawApiCallAiKanaToSpeech(aiKana) {
    validateOpCall(this);
    const buffer = iconv.encode(aiKana, SHIFT_JIS);
    await semaphore.acquire();

    try {
      const pcmOut = await new Promise((resolve, reject) => {
        native.speech(buffer, {}, (err, output) => {
          if (err) {
            reject(err);
          } else {
            resolve(output);
          }
        });
      });
      return new WaveObject(pcmOut, current.baseSampleRate);
    } finally {
      semaphore.release();
    }
  }

  /**
   * Supportive static method for the case in which you like to use it as singleton.
   *
   * @param {Ebyroid} instance instance to save as singleton
   */
  static setInstance(instance) {
    singleton = instance;
  }

  /**
   * Supportive static method for the case in which you like to use it as singleton.
   *
   * @returns {Ebyroid?} the singleton instance (if set)
   */
  static getInstance() {
    return singleton;
  }
}

module.exports = Ebyroid;
