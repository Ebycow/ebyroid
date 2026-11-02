#!/usr/bin/env bash
# Docker イメージのスモークテスト (CI の image ジョブで使う)
# 使い方: test/image/smoke.sh <image>
#
# 1. wine 上の node.exe で、ビルドした ebyroid.node と JS の依存が読み込めること
# 2. 偽のネイティブアドオンを NODE_OPTIONS で差し込んで entrypoint から起動し、
#    cluster (3 ワーカー) で API が応答すること、本文がログに出ないこと
# VOICEROID 本体は使わない
set -euo pipefail

IMAGE=${1:?usage: test/image/smoke.sh <image>}
HERE=$(cd "$(dirname "$0")" && pwd)
FIXTURES=$(cd "$HERE/../fixtures" && pwd)
WORK=$(mktemp -d)
NAME="ebyroid-smoke-$$"
BASE=http://127.0.0.1:4090

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "::error::$*"
  echo "--- container logs"
  docker logs "$NAME" 2>&1 | tail -n 100 || true
  exit 1
}

in_container() {
  docker exec "$NAME" "$@"
}

echo "::group::native addon and dependencies load under wine"
# wine 上の Node.js は stdout が Unix パイプだと落ちるので、ファイルに書かせてから表示する
docker run --rm --entrypoint /bin/sh -v "$HERE:/smoke:ro" "$IMAGE" -c \
  "xvfb-run -a wine 'Z:\\opt\\node\\node.exe' 'Z:\\smoke\\native_load.js' > /tmp/out.txt 2>&1; code=\$?; cat /tmp/out.txt; exit \$code"
echo "::endgroup::"

echo "::group::server starts with the fake native addon"
cat > "$WORK/ebyroid.conf.json" <<'JSON'
[
  { "version": "VOICEROID+", "name": "aoi", "baseDirPath": "Z:\\voiceroid\\Aoi", "voiceDirName": "aoi_22", "default": true },
  { "version": "VOICEROID+", "name": "akane", "baseDirPath": "Z:\\voiceroid\\Akane", "voiceDirName": "akane_22" }
]
JSON
docker run -d --name "$NAME" \
  -e NODE_OPTIONS='--require Z:/smoke/fake_native.js' \
  -e EBYROID_WORKERS=3 \
  -v "$FIXTURES:/smoke:ro" \
  -v "$WORK/ebyroid.conf.json:/etc/ebyroid/ebyroid.conf.json:ro" \
  "$IMAGE" --log-level trace >/dev/null

healthy=
for _ in $(seq 1 90); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    fail "container exited before becoming healthy"
  fi
  if in_container curl -fsS -m 5 -o /dev/null "$BASE/api/v1/health" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
[ -n "$healthy" ] || fail "server did not become healthy"
echo "::endgroup::"

echo "::group::API answers"
voices=$(in_container curl -fsS "$BASE/api/v1/voices")
[ "$voices" = '{"default":"aoi","voices":[{"name":"aoi","default":true},{"name":"akane","default":false}]}' ] ||
  fail "unexpected /api/v1/voices: $voices"

in_container curl -fsS -o /tmp/a.wav "$BASE/api/v1/audiofile?text=a&name=akane" ||
  fail "audiofile failed"
[ "$(in_container head -c 4 /tmp/a.wav)" = RIFF ] || fail "audiofile is not a WAV file"
[ "$(in_container stat -c %s /tmp/a.wav)" = 52 ] || fail "unexpected WAV size"

pcm_bytes=$(in_container curl -fsS -X POST -H 'Content-Type: application/json' \
  -d '{"text":"a"}' "$BASE/api/v2/audiostream" | wc -c)
[ "$pcm_bytes" = 8 ] || fail "unexpected streamed PCM size: $pcm_bytes"
echo "::endgroup::"

echo "::group::request text never reaches the logs"
canary="k$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
in_container curl -fsS -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d "{\"text\":\"$canary 秘密の本文\"}" "$BASE/api/v2/audiostream" ||
  fail "streaming request failed"
in_container curl -fsS -o /dev/null "$BASE/api/v1/audiostream?text=$canary" ||
  fail "audiostream request failed"
in_container curl -sS -o /dev/null "$BASE/api/v1/audiofile?text=$canary%20%23fail" || true
in_container curl -sS -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d "$canary" "$BASE/api/v2/audiostream" || true
# entrypoint はログをファイル経由で流すので、少し待つ
sleep 3
logs=$(docker logs "$NAME" 2>&1)
grep -q 'synthesis.started' <<<"$logs" || fail "no synthesis logs were written"
grep -q 'textChars' <<<"$logs" || fail "no textChars in the logs"
if grep -q "${canary:0:9}" <<<"$logs"; then
  fail "the request text leaked into the container logs"
fi
echo "::endgroup::"

echo "image smoke test passed"
