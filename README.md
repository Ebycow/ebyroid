# ebyroid
Ebyroid is a node native addon for `VOICEROID+` and `VOICEROID2` supports.\
It provides access from Node.js Javascript to VOICEROIDs through N-API and native codes, which is fast.\
We also provide a standalone HTTP server as Win32 executable so you can avoid [a certain difficult problem](https://github.com/nanokina/ebyroid#why-do-i-have-to-use-32-bit-node).

### Supported VOICEROIDs
- `VOICEROID2`
- `VOICEROID+` (partially)
  - Tohoku Zunko, Tohoku KiritanEx, Kotonoha Akane, Kotonoha Aoi

### Requirements (as npm package)
- Windows (10 or Server recommended)
- **Node.js for Windows x86 (win32-ia32)** - `^12.13.1`
- [CMake for Windows](https://cmake.org/download/) - `^3.16.4`
- MSVC `^2017`, or just get the latest [Visual Studio Community](https://visualstudio.microsoft.com/ja/free-developer-offers/) if you aren't certain what it would mean
- Powershell `^3`
- Voiceroid libraries installed with a valid and legitimate license

### Requirements (as a standalone server)
- Windows (10 or Server recommended)
- Voiceroid libraries installed with a valid and legitimate license

## Install
### npm package
After you fulfilled the requirements above:
```
npm i ebyroid
```

### standalone server
Go to [Releases](https://github.com/nanokina/ebyroid/releases) and download the latest `ebyroid-v*.zip`. Then unzip it to wherever you want (e.g. `C:\ebyroid`).


## Usage
### npm package

```js
const { Ebyroid, Voiceroid } = require('ebyroid');

const akari = new Voiceroid('akari-chan', 'C:\\Program Files (x86)\\AHS\\VOICEROID2', 'akari_44');
const kiritan = new Voiceroid('kiritan-chan', 'C:\\Program Files (x86)\\AHS\\VOICEROID+\\KiritanEX', 'kiritan_22');

const ebyroid = new Ebyroid(akari, kiritan);

ebyroid.use('akari-chan');

async function main() {
  const pcm1 = await ebyroid.convert('こんにちは');
  const pcm2 = await ebyroid.convertEx('東京特許許可局東京特きょきょきゃこく', 'kiritan-chan');
  // and your code goes here...
}

main();
```

### standalone server

on CMD

```
C:\ebyroid> ebyroid.exe configure
C:\ebyroid> ebyroid.exe start --port 3333
```

on Powershell

```
PS C:\ebyroid> ./ebyroid configure
PS C:\ebyroid> ./ebyroid start --port 4567
```

For a worker process per voice, a bounded queue, and JSON logs:

```powershell
PS C:\ebyroid> ./ebyroid start --workers 3 --worker-idle-timeout-ms 600000 --queue-limit 20 --queue-timeout-ms 10000 --log-level info
```

`--workers` defaults to `1`: one process serves every voice and reloads the
voice library whenever the requested voice changes, which blocks every other
request for a few hundred milliseconds.

With `--workers N` greater than `1`, `N` is the maximum number of worker
processes, and each worker serves a single voice so a voice change never
reloads anything. The primary process receives every request, reads the voice
name from the `name` query parameter or JSON field, and forwards the request to
that voice's worker over the loopback interface.

- The default voice's worker starts with the server, is never stopped, and is
  restarted if it exits unexpectedly.
- Another voice gets a worker on its first request. The worker stops after
  `--worker-idle-timeout-ms` without requests (10 minutes by default; `0` keeps
  it running).
- When `N` workers are already running, the least recently used idle worker
  takes over the new voice and reloads its library, which is much cheaper than
  starting a process. If every worker is busy, the request waits for up to
  `--queue-timeout-ms`.

Each worker runs exactly one native synthesis at a time. `--queue-limit` is the
number of waiting requests per worker, in addition to the one active request.
When that queue is full, or a request waits longer than
`--queue-timeout-ms`, the server responds with `503 Service Unavailable` and
`Retry-After: 1`. Health checks do not enter the synthesis queue.

### Logging

Server logs are JSON Lines on standard output by default. In multi-process
mode workers send log records to the primary process over IPC, and only the
primary writes them to standard output. Use `--log-format pretty` for
human-readable output and `--log-level trace|debug|info|warn|error|silent` to
control verbosity.

Every record carries `role`: `single` for a one-process server, `primary` for
the supervisor in multi-process mode, or `worker` together with `workerId`.
When the server is ready, `server.started` reports the listening `url`,
`address`, and `port` along with the ebyroid `version`, Node.js version,
architecture, and queue and log settings. In multi-process mode the primary
also writes `cluster.started` with the same URL and version.

Important lifecycle events include `request.received`, `request.validated`,
`queue.enqueued`, `queue.dequeued`, `synthesis.started`,
`synthesis.first_chunk`, `synthesis.progress`, `synthesis.completed`,
`response.started`, `response.backpressure`, and `request.completed`.
Per-worker `metrics.snapshot` and aggregate `cluster.metrics` records are
written every `--metrics-interval-ms` (10 seconds by default; `0` disables
them).

Speech text, JSON request bodies, URL queries, and User-Agent values are never
included in these logs. Request records contain text length and voice name for
diagnostics instead. `trace` writes one record per PCM chunk and can be noisy;
`debug` writes queue and periodic generation progress details.


### Docker (Linux / wine)

The standalone server also runs on Linux under 32-bit wine with Docker Compose,
without Windows or `ebyroid.exe`. The image cross-builds `ebyroid.node` with
MinGW-w64 and runs the JavaScript sources with the Windows (ia32) `node.exe`.
Copy `C:\Program Files (x86)\AHS` from Windows to `AHS/` in this repository
(it is git-ignored), then:

```sh
cp docker/ebyroid.conf.example.json docker/ebyroid.conf.json
docker compose up -d --build
```

`AHS/VOICEROID+` is mounted at `/voiceroid` (set `VOICEROID_DIR` in `.env` to
use another directory), which wine sees as `Z:\voiceroid`,
so `baseDirPath` in `docker/ebyroid.conf.json` must look like
`Z:\\voiceroid\\KiritanEX`. The server listens on port 4090
(`EBYROID_HOST_PORT` changes the host side) and `EBYROID_WORKERS` sets
`--workers` (3 by default here). `EBYROID_WORKER_IDLE_TIMEOUT_MS` sets
`--worker-idle-timeout-ms`.

`bin/`, `lib/`, `index.js` and `package.json` are mounted into the container,
so `docker compose restart` applies changes to them and to the config file.
Run `docker compose up -d --build` after changing `src/`, `CMakeLists.txt` or
the dependencies.

Node.js under wine cannot write to a Unix pipe, so the container writes the
server log to a file and streams it to `docker compose logs`.


## API Endpoints of Standalone Server

### `POST /api/v2/audiostream`

This is the streaming endpoint recommended for new clients. It accepts the
speech text in a JSON request body, so the text is not exposed in the URL, and
starts a chunked PCM response as soon as the native engine emits audio.

#### request

`Content-Type: application/json`

```json
{
  "text": "Text to speak",
  "name": "kiritan-chan"
}
```

`text` is required. `name` is optional and selects the configured voice. The
maximum JSON request-body size is 64 KiB.

The response content type, PCM headers, and raw PCM format are the same as
`GET /api/v1/audiostream`. The response uses HTTP chunked transfer rather than
waiting for the complete speech buffer. The legacy v1 endpoints remain
available for compatibility.

### `GET /api/v1/audiostream`

#### query parameters

|  id   |  type  | required | desc             | example                      |
| :---: | :----: | :------: | :--------------- | :--------------------------- |
| text  | string | **yes**  | TTS content      | `text=今日は%20はじめまして` |
| name  | string |    no    | Voiceroid to use | `name=kiritan-chan`          |

#### response types

- `200 OK` => `application/octet-stream`
- `4xx` and `5xx` => `application/json`

#### extra response headers

|               id               |        value        | desc            |
| :----------------------------: | :-----------------: | :-------------- |
|    Ebyroid-PCM-Sample-Rate     | `22050\|44100\|48000` | Samples per sec |
|     Ebyroid-PCM-Bit-Depth      |        `16`         | Fixed to 16-bit |
| Ebyroid-PCM-Number-Of-Channels |        `1\|2`        | Mono or Stereo  |

Note that these headers will be sent only with `200 OK`.

#### response body

A byte stream of the [Linear PCM](http://soundfile.sapp.org/doc/WaveFormat/) data.\
The stream doesn't contain file header bytes since this endpoint is rather for those who want to deal with raw audio data.\
Use `GET /api/v1/audiofile` instead if you demand `.wav` file.

### `GET /api/v1/audiofile`

#### query parameters

|  id   |  type  | required | desc             | example                    |
| :---: | :----: | :------: | :--------------- | :------------------------- |
| text  | string | **yes**  | TTS content      | `text=今晩は%20さようなら` |
| name  | string |    no    | Voiceroid to use | `name=akane-chan`          |

#### response types

- `200 OK` => `audio/wav`
- `4xx` and `5xx` => `application/json`

#### extra response headers

None.

#### response body

Complete data for a `.wav` file.\
Any modern browser should support either to play or to download it.

### `GET /api/v1/voices`

#### response types

- `200 OK` => `application/json`

#### response body

Every configured voice in config order, with the default voice marked.
Use a `name` from this list as the `name` parameter of the other endpoints.

```json
{
  "default": "kiritan",
  "voices": [
    { "name": "kiritan", "default": true },
    { "name": "aoi", "default": false }
  ]
}
```

In multi-process mode the primary answers from the config, so this never starts
a worker.

## FAQ

### Why do I have to use 32-bit node?

Because Ebyroid is a native addon that interacts with VOICEROID's 32-bit native code.\
When you need to interact with 32-bit code, it is necessary that your code also runs in 32-bit.

### How do I switch 64-bit node and 32-bit node?

Use [nvm](https://github.com/coreybutler/nvm-windows). Also, consider using Ebyroid's standalone server.

### VOICEROID+ support looks poor, why?

As of `VOICEROID2`, the software design is sophisticated and there's only one executable while voice library varies.\
That's why `VOICEROID2` is fully supported. Just making a support for the one executable works fine.

In contrast, every `VOICEROID+` has its own executable, which means I need to write individual support for each library.\
And I just ran out of money after buying 4 of them.

I'd appreciate your support as in making a pull request, opening an issue or emailing me.

### Does Ebyroid support concurrency?

The Node.js API is asynchronous, but one Ebyroid process serializes native
synthesis jobs because the underlying VOICEROID API accepts only one active
job reliably. With `--workers N` the standalone server runs one worker per
voice, so different voices synthesize in parallel and never wait for each
other's voice changes. Requests for the same voice are still handled one at a
time by that voice's worker.

For reference, one process handled about 21-22 short requests per second in a
local packaged-executable benchmark. These numbers depend on the CPU, voice,
and input text. Queueing smooths bursts but does not increase sustained
capacity, so overload still returns `503`.

The v2 endpoint improves time to first audio rather than total synthesis time.
With the native engine's minimum accepted 128 KiB PCM callback buffer, short
utterances may still fit in one chunk and see little latency improvement.

That said, however, switching voiceroid within one process acquires the inter-thread lock and takes a couple of hundreds of millis (200ms-400ms practically on Windows, about 800ms under wine) by itself. With `--workers 1`, frequent voice changes slow the whole app down; give each frequently used voice its own worker with `--workers N` instead.


## License
MIT. See LICENSE.

## Disclaimer
Since Ebyroid is merely an ad-hoc, non-profit, open-source and free library that interacts with VOICEROID, it doesn't contain any data with commercial value nor has any intent to exploit. Ebyroid only uses information loaded to RAM in human-readable format, such as a string, considered to be public, as means of Fair Use of public information.

I will never be responsible for any consequences in connection with any use of Ebyroid or anyone that uses Ebyroid. I will only be concerned with calls of the US federal courts through Github, Inc. thus any other call and request from other authority or a company shall be ignored and immediately removed.

FAIR-USE COPYRIGHT DISCLAIMER

Copyright Disclaimer Under Section 107 of the Copyright Act 1976, allowance is made for "fair use" for purposes such as criticism, commenting, news reporting, teaching, scholarship, and research. Fair use is a use permitted by copyright statute that might otherwise be infringing. Non-profit, educational or personal use tips the balance in favor of fair use.

## catgirl

![ebyroid](https://user-images.githubusercontent.com/24854132/76497659-c90dc080-647e-11ea-9249-33bcc8d74f64.png)

### sister project

- [Hanako](https://www.github.com/Ebycow/hanako) - Discord TTS Bot for Wide-Use
