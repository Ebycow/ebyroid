#!/bin/sh
set -e
# wine 上の Node.js は stdout が Unix パイプだと uv_pipe_open で落ち、疑似端末だと
# wine のコンソールが 80 桁で折り返す。普通のファイルに書かせて tail で docker のログへ流す。
LOG=/tmp/ebyroid.log
LOG_MAX_BYTES=${EBYROID_LOG_MAX_BYTES:-10485760}
: > "$LOG"
tail -n +1 -F "$LOG" 2>/dev/null &

# aitalked.dll が USER32 をリンクしているので念のため仮想ディスプレイ上で起動する
# 追記モード (>>) なので、下でファイルを空にしても書き込み位置が先頭に戻る
xvfb-run -a wine 'Z:\opt\node\node.exe' 'Z:\app\bin\main.js' start \
  --config 'Z:\etc\ebyroid\ebyroid.conf.json' \
  --port "${EBYROID_PORT:-4090}" \
  --workers "${EBYROID_WORKERS:-1}" \
  "$@" >> "$LOG" 2>&1 &
pid=$!

# ログファイルが大きくなりすぎたら空にする（中身は tail がもう docker に流している）
while kill -0 "$pid" 2>/dev/null; do
  if [ "$(stat -c %s "$LOG")" -gt "$LOG_MAX_BYTES" ]; then
    sleep 2
    : > "$LOG"
  fi
  sleep 30 &
  wait $! || true
done

wait "$pid"
