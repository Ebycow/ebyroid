const assert = require('assert').strict;
const WaveObject = require('../lib/wave_object');

const pcm = new Int16Array([0, 1, -1]);
const header = new WaveObject(pcm, 22050).waveFileHeader();

assert.equal(header.length, 44);
assert.equal(header.toString('ascii', 0, 4), 'RIFF');
assert.equal(header.readUInt32LE(4), pcm.byteLength + 36);
assert.equal(header.toString('ascii', 8, 12), 'WAVE');
assert.equal(header.readUInt32LE(24), 22050);
assert.equal(header.readUInt32LE(28), 44100);
assert.equal(header.readUInt16LE(32), 2);
assert.equal(header.readUInt16LE(34), 16);
assert.equal(header.readUInt32LE(40), pcm.byteLength);
