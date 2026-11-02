// 本番と同じ起動経路 (bin/main.js start) を、偽のネイティブアドオン
// (test/fixtures/fake_native.js) を preload した子プロセスとして動かすためのヘルパー
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FAKE_NATIVE = path.join(__dirname, '..', 'fixtures', 'fake_native.js');

const CONFIG = [
  {
    version: 'VOICEROID+',
    name: 'aoi',
    baseDirPath: 'C:\\voiceroid\\Aoi',
    voiceDirName: 'aoi_22',
    default: true,
  },
  {
    version: 'VOICEROID+',
    name: 'akane',
    baseDirPath: 'C:\\voiceroid\\Akane',
    voiceDirName: 'akane_22',
  },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
function request(port, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers },
      res => {
        const chunks = [];
        const done = () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', done);
        // 途中で切れたストリームも結果として扱う
        res.on('aborted', done);
        res.on('error', done);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function postJson(port, value, headers = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return request(port, {
    method: 'POST',
    path: '/api/v2/audiostream',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...headers,
    },
    body,
  });
}

async function waitHealthy(port, child, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited early (code ${child.exitCode}):\n${output()}`
      );
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(port, { path: '/api/v1/health' });
      if (res.status === 200) return;
    } catch (err) {
      // まだ listen していない
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy:\n${output()}`);
}

function stopChild(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * サーバーを起動し、/api/v1/health が 200 を返すまで待つ
 *
 * @param {{ workers?: number, logLevel?: string, logFormat?: string, args?: string[], env?: object }} options
 * @returns {Promise<{ port: number, output: () => string, stop: () => Promise<void> }>}
 */
async function startServer(options = {}) {
  const {
    workers = 1,
    logLevel = 'info',
    logFormat = 'json',
    args = [],
    env = {},
  } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebyroid-test-'));
  const config = path.join(dir, 'ebyroid.conf.json');
  fs.writeFileSync(config, JSON.stringify(CONFIG));
  const port = await freePort();

  const child = spawn(
    process.execPath,
    [
      '-r',
      FAKE_NATIVE,
      path.join(ROOT, 'bin', 'main.js'),
      'start',
      '--config',
      config,
      '--port',
      String(port),
      '--workers',
      String(workers),
      '--log-level',
      logLevel,
      '--log-format',
      logFormat,
      ...args,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  const output = () => Buffer.concat(chunks).toString('utf8');
  const stop = async () => {
    await stopChild(child);
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    await waitHealthy(port, child, output);
  } catch (err) {
    await stop();
    throw err;
  }
  return { port, output, stop };
}

module.exports = { CONFIG, startServer, request, postJson };
