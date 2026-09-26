const fs = require('fs');

/**
 * Reads and validates an ebyroid.conf.json file.
 *
 * @param {string} configPath
 * @returns {{ voices: object[], defaultName: string }}
 */
function loadConfig(configPath) {
  const voices = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(voices) || voices.length === 0) {
    throw new Error(`${configPath} must contain at least one voice`);
  }
  const defaultVoice = voices.find(o => o && o.default);
  if (!defaultVoice || typeof defaultVoice.name !== 'string') {
    throw new Error(`${configPath} must mark one voice as default`);
  }
  return { voices, defaultName: defaultVoice.name };
}

module.exports = { loadConfig };
