#!/bin/sh
# ebyroid コンテナの中で動かすリクエスト側。bench/run.sh から
#   docker compose exec -T ebyroid sh -s -- <mode> < bench/requests.sh
# として呼ばれる。ネットワークの差が入らないよう、curl はコンテナ内から 127.0.0.1 に投げる
#
# 1 リクエストにつき 1 行:
#   label voice time_to_first_byte time_total bytes http_code sample_rate
# 並列の全体時間は "par_wall <件数> <秒>" の 1 行
set -eu

BASE=http://127.0.0.1:4090
# README の arm64 performance の表（Raspberry Pi 4 / Jetson Nano）を測ったときと同じ文。
# 変えると過去の結果と比べられなくなる
SHORT='こんにちは、今日はいい天気ですね。'
LONG='東北きりたんです。きょうは、ラズベリーパイではなくジェットソンナノの上で、ワインとボックス64を使って、ボイスロイドを動かしています。思ったより、ちゃんと喋れていますね。'
VOICES='kiritan aoi akane'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# req <label> <voice> <text>
req() {
  id=$1.$2.$(date +%s%N)
  printf '{"text":"%s","name":"%s"}' "$3" "$2" > "$TMP/$id.json"
  r=$(curl -sS -o /dev/null -D "$TMP/$id.h" -H 'Content-Type: application/json' \
    --data-binary @"$TMP/$id.json" \
    -w '%{time_starttransfer} %{time_total} %{size_download} %{http_code}' \
    "$BASE/api/v2/audiostream") || r="0 0 0 000"
  rate=$(tr -d '\r' < "$TMP/$id.h" 2>/dev/null | awk -F': ' 'tolower($1) == "ebyroid-pcm-sample-rate" { print $2 }')
  echo "$1 $2 $r ${rate:-0}"
}

# repeat <n> <label> <voice> <text>
repeat() {
  i=0
  while [ "$i" -lt "$1" ]; do req "$2" "$3" "$4"; i=$((i + 1)); done
}

case "$1" in
  # デフォルト話者のワーカーが応答するまで待つ（compose の healthcheck と同じ URL）
  wait-health)
    until curl -fsS -m 5 -o /dev/null "$BASE/api/v1/health" 2>/dev/null; do sleep 0.5; done
    ;;
  # デフォルト以外の話者への最初のリクエスト（--workers 3 ではワーカーの起動を含む）
  cold)
    for v in aoi akane; do req cold "$v" "$SHORT"; done
    ;;
  # 話者ごとに慣らし 1 回、短文 20 回、長文 5 回
  warm)
    for v in ${2:-$VOICES}; do
      req warmup "$v" "$SHORT"
      repeat 20 short "$v" "$SHORT"
      repeat 5 long "$v" "$LONG"
    done
    ;;
  # 3 話者に 10 回ずつ同時に投げる
  par)
    s=$(date +%s.%N)
    for v in $VOICES; do repeat 10 par "$v" "$SHORT" > "$TMP/par.$v" & done
    wait
    e=$(date +%s.%N)
    for v in $VOICES; do cat "$TMP/par.$v"; done
    awk -v s="$s" -v e="$e" 'BEGIN { printf "par_wall 30 %.6f\n", e - s }'
    ;;
  # --workers 1 で 1 プロセスのまま話者を切り替える（最初の kiritan 以外は毎回切り替え）
  switch)
    for v in kiritan aoi kiritan akane kiritan aoi kiritan akane; do req switch "$v" "$SHORT"; done
    ;;
  # メモリの状況（Colima などでは VM の値になる）
  meminfo)
    awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ { printf "%s %d MB\n", $1, $2 / 1024 }' /proc/meminfo
    ;;
  *)
    echo "unknown mode: $1" >&2
    exit 2
    ;;
esac
