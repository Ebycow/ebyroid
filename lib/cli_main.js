/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const inquirer = require('inquirer');
const root = require('yargs');
const {
  VOICE_ENV,
  startCluster,
  workerLogWriter,
  workerMetricsWriter,
  workerReadyNotifier,
} = require('./cluster_runner');
const { loadConfig } = require('./config');
const { Logger } = require('./logger');
const {
  processRole,
  serverStartedFields,
  clusterStartedFields,
} = require('./startup_info');

/** @typedef {root.Argv<{}>} Yargs */
/** @typedef {{ [key in keyof root.Arguments<{}>]: Arguments<{}>[key] }} Argv */

function defaultPath(version) {
  return version === 'VOICEROID+'
    ? 'C:\\Program Files (x86)\\AHS\\VOICEROID+'
    : 'C:\\Program Files (x86)\\AHS\\VOICEROID2';
}

function validateVoiceroidPath(vrpath, { version }) {
  const fsopt = { withFileTypes: true };
  try {
    let files;
    if (version === 'VOICEROID+') {
      files = fs
        .readdirSync(vrpath, fsopt)
        .map(dirent =>
          dirent.isDirectory() && dirent.name !== 'VOICEROID2'
            ? fs.readdirSync(path.join(vrpath, dirent.name), fsopt)
            : []
        )
        .flat()
        .filter(dirent => dirent.isFile());
    } else {
      files = fs
        .readdirSync(vrpath, { withFileTypes: true })
        .filter(dirent => dirent.isFile());
    }
    return files.some(file => file.name === 'aitalked.dll')
      ? true
      : `That is not a valid ${version} directory.`;
  } catch (e) {
    if (e.code === 'ENOENT') {
      return 'There is no such a directory.';
    }
    return `Something went wrong. Possibly an expception related to file access (code=${e.code})`;
  }
}

function configureObject(answers) {
  const o = {};
  o.version = answers.version;
  o.name = answers.name;

  const base = answers.usesDefaultPath
    ? defaultPath(answers.version)
    : answers.customPath;
  o.baseDirPath =
    o.version === 'VOICEROID+' ? path.join(base, answers.vpDirName) : base;

  o.voiceDirName = answers.voiceDirName;

  return o;
}

/** @param {Argv} argv */
function configure(argv) {
  const names = new Map();
  const questions = [
    {
      type: 'list',
      name: 'version',
      message: 'Which version of VOICEROID do you use?',
      choices: ['VOICEROID+', 'VOICEROID2'],
    },
    {
      type: 'confirm',
      name: 'usesDefaultPath',
      message: answers =>
        `Is your VOICEROID installed in "${defaultPath(answers.version)}"?`,
      when: answers => {
        const vrpath = defaultPath(answers.version);
        return typeof validateVoiceroidPath(vrpath, answers) !== 'string';
      },
    },
    {
      type: 'input',
      name: 'customPath',
      message: 'In which directory is it installed?',
      when: answers => !answers.usesDefaultPath,
      filter: value => path.normalize(value),
      validate: validateVoiceroidPath,
    },
    {
      type: 'list',
      name: 'vpDirName',
      message: 'Which VOICEROID+ do you like to use?',
      choices: answers => {
        const base = answers.usesDefaultPath
          ? defaultPath(answers.version)
          : answers.customPath;
        return fs
          .readdirSync(base, { withFileTypes: true })
          .filter(
            dirent => dirent.isDirectory() && !dirent.name.startsWith('.')
          )
          .map(dirent => dirent.name);
      },
      when: answers => answers.version === 'VOICEROID+',
    },
    {
      type: 'list',
      name: 'voiceDirName',
      message: 'Which voice library do you like to use?',
      choices: answers => {
        const base = answers.usesDefaultPath
          ? defaultPath(answers.version)
          : answers.customPath;
        const voiceBase =
          answers.version === 'VOICEROID+'
            ? path.join(base, answers.vpDirName, 'voice')
            : path.join(base, 'Voice');
        return fs
          .readdirSync(voiceBase, { withFileTypes: true })
          .filter(
            dirent => dirent.isDirectory() && !dirent.name.startsWith('.')
          )
          .map(dirent => dirent.name);
      },
    },
    {
      type: 'input',
      name: 'name',
      message: 'Give an unique name to this voiceroid settings!',
      validate: name => {
        if (name.length < 1) {
          return 'Name cannot be empty.';
        }
        if (names.has(name)) {
          return 'That name is already used.';
        }
        names.set(name, true);
        return true;
      },
    },
    {
      type: 'confirm',
      name: 'continue',
      message: 'Add one more settings for another voiceroid?',
      default: false,
    },
  ];

  function ask(arr = []) {
    return inquirer.prompt(questions).then(answers => {
      arr.push(answers);
      if (answers.continue) {
        console.log(`---------- No.${arr.length + 1} ----------`);
        return ask(arr);
      }
      return Promise.resolve(arr.map(configureObject));
    });
  }

  function finalAsk(objects) {
    return inquirer
      .prompt([
        {
          type: 'list',
          name: 'which',
          message: 'Which one of the voiceroids should be used as default?',
          choices: objects.map(o => o.name),
        },
      ])
      .then(answers => {
        const od = objects.find(o => o.name === answers.which);
        od.default = true;
        return Promise.resolve(objects);
      });
  }

  function writeJson(objects) {
    console.log(`Writing to "${argv.output}"...\n`);
    const json = JSON.stringify(objects, null, 2);
    fs.writeFileSync(argv.output, json);
    return Promise.resolve();
  }

  return ask()
    .then(finalAsk)
    .then(writeJson)
    .catch(e => console.error('\nSorry, an error occured!', e));
}

function toVR(o) {
  // Keep the VOICEROID/native dependency out of the cluster primary process.
  // eslint-disable-next-line global-require
  const Voiceroid = require('./voiceroid');
  return new Voiceroid(o.name, o.baseDirPath, o.voiceDirName);
}

function validateStartOptions(argv) {
  const integers = [
    ['workers', argv.workers, 1],
    ['queue-limit', argv.queueLimit, 0],
    ['queue-timeout-ms', argv.queueTimeoutMs, 0],
    ['metrics-interval-ms', argv.metricsIntervalMs, 0],
    ['worker-idle-timeout-ms', argv.workerIdleTimeoutMs, 0],
  ];
  integers.forEach(([name, value, minimum]) => {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(
        `--${name} must be an integer greater than or equal to ${minimum}`
      );
    }
  });
}

function createLogger(argv, primary) {
  const bindings = processRole(primary, cluster.worker);
  const write = primary ? undefined : workerLogWriter();
  return new Logger(
    { level: argv.logLevel, format: argv.logFormat, write },
    bindings
  );
}

/** @param {Argv} argv */
function startWorker(argv, logger) {
  // These imports load the native addon, so they must stay worker-only.
  // eslint-disable-next-line global-require
  const Ebyroid = require('./ebyroid');
  // eslint-disable-next-line global-require
  const MiniServer = require('./mini_server');

  logger.info('config.loading', { config: path.basename(argv.config) });
  const { voices, defaultName: defname } = loadConfig(argv.config);
  const vrs = voices.map(toVR);
  logger.info('config.loaded', {
    voices: vrs.length,
    voiceNames: vrs.map(v => v.name),
  });
  // A cluster worker serves the one voice the primary assigned to it.
  const voice = cluster.worker ? process.env[VOICE_ENV] : defname;
  const ebyroid = new Ebyroid(...vrs).setLogger(logger);
  ebyroid.use(voice);
  logger.info('voice.default.selected', { voice });
  const mini = new MiniServer(ebyroid, {
    logger,
    queueLimit: argv.queueLimit,
    queueTimeoutMs: argv.queueTimeoutMs,
    metricsIntervalMs: argv.metricsIntervalMs,
    metricsSink: workerMetricsWriter(),
  });
  // Workers are reached only through the primary on the loopback interface.
  mini.start(
    cluster.worker ? { port: 0, host: '127.0.0.1', exclusive: true } : argv.port
  );
  mini.server.once('listening', () => {
    const address = mini.server.address();
    logger.info('server.started', serverStartedFields(argv, address));
    const notifyReady = workerReadyNotifier();
    if (cluster.worker && notifyReady) notifyReady(address.port);
  });
  mini.server.once('error', err => {
    logger.error('server.failed', { port: argv.port, err });
    // Nothing is being served, so let the process exit and report failure.
    // Exiting naturally keeps queued IPC log lines from being dropped.
    process.exitCode = 1;
    mini.stop().catch(() => {});
    if (cluster.worker) process.disconnect();
  });

  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    logger.info('server.shutdown.started', { signal });
    mini
      .stop()
      .then(() => {
        logger.info('server.shutdown.completed', { signal });
        if (cluster.worker) process.disconnect();
      })
      .catch(err => {
        logger.error('server.shutdown.failed', { signal, err });
        process.exitCode = 1;
        if (cluster.worker) process.disconnect();
      });
  };
  if (cluster.worker) {
    process.on('message', message => {
      if (message && message.type === 'ebyroid:shutdown') stop('primary');
    });
  } else {
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }
  return mini;
}

/** @param {Argv} argv */
function startPrimary(argv, logger) {
  // Unlike the workers, the primary never loads the native addon.
  // eslint-disable-next-line global-require
  const VoiceRouter = require('./voice_router');

  const { voices, defaultName } = loadConfig(argv.config);
  const supervisor = startCluster({
    workers: argv.workers,
    defaultVoice: defaultName,
    idleTimeoutMs: argv.workerIdleTimeoutMs,
    queueTimeoutMs: argv.queueTimeoutMs,
    logger,
    metricsIntervalMs: argv.metricsIntervalMs,
    startedFields: clusterStartedFields(argv),
    handleSignals: false,
  });
  const router = new VoiceRouter(supervisor, {
    voiceNames: voices.map(o => o.name),
    defaultName,
    logger,
  });
  router.start(argv.port);
  router.server.once('error', err => {
    logger.error('server.failed', { port: argv.port, err });
    process.exitCode = 1;
    supervisor.stop('server.failed');
  });

  const stop = signal => {
    supervisor.stop(signal);
    router.stop().catch(() => {});
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  return router;
}

/** @param {Argv} argv */
function start(argv) {
  validateStartOptions(argv);
  const primary = argv.workers > 1 && cluster.isMaster;
  const logger = createLogger(argv, primary);
  if (primary) {
    return startPrimary(argv, logger);
  }
  return startWorker(argv, logger);
}

const c = {
  command: 'configure',
  desc: 'create a configuration file',

  /** @param {Yargs} yargs */
  builder(yargs) {
    return yargs
      .option('output', {
        alias: 'o',
        describe: 'specify a path to output config file',
        default: './ebyroid.conf.json',
      })
      .normalize('output')
      .demandOption('output');
  },

  handler: configure,
};

const s = {
  command: 'start',
  desc: 'start the audiostream server',

  /** @param {Yargs} yargs */
  builder(yargs) {
    return yargs
      .option('config', {
        alias: 'c',
        describe: 'provide a path to config file',
        default: './ebyroid.conf.json',
      })
      .option('port', {
        alias: 'p',
        describe: 'specify a port to listen',
        default: 4090,
      })
      .option('workers', {
        alias: 'w',
        describe:
          'maximum number of worker processes, each serving one voice (1 serves every voice in one process)',
        default: 1,
      })
      .option('worker-idle-timeout-ms', {
        describe:
          'stop a non-default voice worker after this long without requests (0 keeps it)',
        default: 600000,
      })
      .option('queue-limit', {
        describe: 'maximum queued synthesis requests per worker',
        default: 20,
      })
      .option('queue-timeout-ms', {
        describe: 'maximum time a synthesis request may wait in queue',
        default: 10000,
      })
      .option('log-level', {
        describe: 'minimum structured log level',
        choices: ['trace', 'debug', 'info', 'warn', 'error', 'silent'],
        default: 'info',
      })
      .option('log-format', {
        describe: 'structured log output format',
        choices: ['json', 'pretty'],
        default: 'json',
      })
      .option('metrics-interval-ms', {
        describe: 'interval for runtime metrics logs (0 disables)',
        default: 10000,
      })
      .normalize('config')
      .number([
        'port',
        'workers',
        'queue-limit',
        'queue-timeout-ms',
        'metrics-interval-ms',
        'worker-idle-timeout-ms',
      ])
      .demandOption('config');
  },

  handler: start,
};

function main() {
  const m = [
    'For more specific details:',
    '  ebyroid configure --help',
    '  ebyroid start --help',
    '',
    'Or just try:',
    '  ebyroid configure && ebyroid start',
  ];
  return root
    .scriptName('ebyroid')
    .command(c.command, c.desc, c.builder, c.handler)
    .command(s.command, s.desc, s.builder, s.handler)
    .demandCommand(1, m.join('\n'))
    .help().argv;
}

module.exports = main;
