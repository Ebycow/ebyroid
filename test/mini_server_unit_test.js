/* eslint-disable no-console */
const assert = require('assert').strict;
const http = require('http');
const MiniServer = require('../lib/mini_server');

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

async function main() {
  const conversionError = Object.assign(new Error('日本語のエラー'), {
    code: 'TEST_ERROR',
  });
  const ebyroid = {
    using: { name: 'default' },
    convert: () => Promise.reject(conversionError),
    convertEx: () => Promise.reject(conversionError),
  };
  const mini = new MiniServer(ebyroid);

  mini.start(0);
  await new Promise(resolve => mini.server.once('listening', resolve));

  try {
    const { port } = mini.server.address();
    const { res, body } = await request(port, '/api/v1/audiofile?text=test');
    assert.equal(res.statusCode, 500);
    assert.equal(Number(res.headers['content-length']), body.byteLength);
    assert.equal(
      JSON.parse(body.toString('utf8')).message,
      conversionError.message
    );

    const malformed = await request(port, 'http://[invalid');
    assert.equal(malformed.res.statusCode, 500);
  } finally {
    await new Promise(resolve => mini.server.close(resolve));
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
