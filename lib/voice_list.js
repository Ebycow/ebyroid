/**
 * The body of GET /api/v1/voices: every configured voice in config order,
 * with the default voice marked, so clients can offer a choice of voices.
 *
 * @param {string[]} voiceNames
 * @param {string} defaultName
 * @returns {{ default: string, voices: { name: string, default: boolean }[] }}
 */
function voiceList(voiceNames, defaultName) {
  return {
    default: defaultName,
    voices: voiceNames.map(name => ({ name, default: name === defaultName })),
  };
}

module.exports = { voiceList };
