/* eslint-disable no-console */
const assert = require('assert').strict;
const { Logger } = require('../lib/logger');

function main() {
  const lines = [];
  const logger = new Logger(
    { level: 'info', write: line => lines.push(line) },
    {
      workerId: 3,
    }
  );
  const child = logger.child({ requestId: 'request-1' });

  child.debug('hidden', { secret: 'must not be written' });
  child.info('request.received', { route: '/api/v2/audiostream' });
  child.error('synthesis.failed', {
    err: Object.assign(new Error('native failure'), { code: 'TEST_ERROR' }),
  });

  assert.equal(lines.length, 2);
  const received = JSON.parse(lines[0]);
  assert.equal(received.level, 'info');
  assert.equal(received.event, 'request.received');
  assert.equal(received.workerId, 3);
  assert.equal(received.requestId, 'request-1');
  assert.equal(received.route, '/api/v2/audiostream');
  assert.equal(received.secret, undefined);

  const failed = JSON.parse(lines[1]);
  assert.equal(failed.err.code, 'TEST_ERROR');
  assert.equal(failed.err.message, 'native failure');
  assert.equal(typeof failed.err.stack, 'string');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
