/* eslint-disable no-console */
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../lib/config');

function withConfig(value, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebyroid-config-'));
  const file = path.join(dir, 'ebyroid.conf.json');
  try {
    fs.writeFileSync(file, JSON.stringify(value));
    check(file);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
}

function main() {
  withConfig([{ name: 'akane' }, { name: 'aoi', default: true }], file => {
    const config = loadConfig(file);
    assert.equal(config.defaultName, 'aoi');
    assert.equal(config.voices.length, 2);
  });
  withConfig([{ name: 'aoi' }], file => {
    assert.throws(() => loadConfig(file), /must mark one voice as default/);
  });
  withConfig([], file => {
    assert.throws(() => loadConfig(file), /at least one voice/);
  });
  withConfig({ name: 'aoi', default: true }, file => {
    assert.throws(() => loadConfig(file), /at least one voice/);
  });
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
