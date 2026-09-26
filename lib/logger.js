const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: Infinity,
});

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return {
    name: err.name,
    code: err.code,
    message: err.message,
    stack: err.stack,
  };
}

function normalize(fields) {
  return Object.keys(fields).reduce((result, key) => {
    const value = fields[key];
    if (typeof value !== 'undefined') {
      return { ...result, [key]: serializeError(value) };
    }
    return result;
  }, {});
}

class Logger {
  constructor(options = {}, bindings = {}) {
    const level = options.level || 'info';
    if (!Object.prototype.hasOwnProperty.call(LEVELS, level)) {
      throw new Error(`Unknown log level: ${level}`);
    }
    this.level = level;
    this.format = options.format || 'json';
    this.write = options.write || (line => process.stdout.write(`${line}\n`));
    this.bindings = { pid: process.pid, ...bindings };
  }

  child(bindings) {
    return new Logger(
      { level: this.level, format: this.format, write: this.write },
      { ...this.bindings, ...bindings }
    );
  }

  enabled(level) {
    return LEVELS[level] >= LEVELS[this.level];
  }

  log(level, event, fields = {}) {
    if (!this.enabled(level)) return;
    const record = normalize({
      ts: new Date().toISOString(),
      level,
      event,
      ...this.bindings,
      ...fields,
    });
    if (this.format === 'pretty') {
      const details = Object.keys(record)
        .filter(key => !['ts', 'level', 'event'].includes(key))
        .map(key => `${key}=${JSON.stringify(record[key])}`)
        .join(' ');
      this.write(
        `${record.ts} ${level.toUpperCase()} ${event}${
          details ? ` ${details}` : ''
        }`
      );
      return;
    }
    this.write(JSON.stringify(record));
  }

  trace(event, fields) {
    this.log('trace', event, fields);
  }

  debug(event, fields) {
    this.log('debug', event, fields);
  }

  info(event, fields) {
    this.log('info', event, fields);
  }

  warn(event, fields) {
    this.log('warn', event, fields);
  }

  error(event, fields) {
    this.log('error', event, fields);
  }
}

function silentLogger() {
  return new Logger({ level: 'silent', write: () => {} });
}

module.exports = { Logger, silentLogger };
