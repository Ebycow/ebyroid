#!/bin/sh
# ebyroid の Docker イメージの速さを、どの機械でも同じ条件で測る
#
#   bench/run.sh            # --workers 3 と --workers 1 を順に測る
#   bench/run.sh 3          # --workers 3 だけ
#   bench/run.sh -p ebyroid-bench   # 本番が動いている機械で、別プロジェクトの捨てコンテナで測る
#
# リポジトリ直下（compose.yaml のあるところ）で docker compose が使える状態で動かす。
# 話者は kiritan（デフォルト）, aoi, akane の 3 つ（VOICEROID+）が設定されている前提。
# ワーカー数ごとにコンテナを作り直して測り、生の結果と集計を
# bench/results/<ホスト名>-<日時>.txt に書く。終わったら .env の設定で立ち上げ直す。
#
# -p を付けると、その名前の compose プロジェクトで測る。ホスト側のポートは
# 127.0.0.1:14090 にだけ出し（EBYROID_HOST_PORT で変更可）、終わったら down で消す。
# 本番の VOICEROID や設定を借りるときは VOICEROID_DIR と EBYROID_CONFIG を指定する
#
# 測るもの（README の arm64 performance の表と同じ）
#   --workers 3: 起動から healthy まで / aoi・akane への最初のリクエスト（ワーカー起動）/
#                話者ごとに短文 20 回・長文 5 回 / 3 話者に 10 回ずつ同時 / プロセスごとのメモリ
#   --workers 1: 起動から healthy まで / kiritan の短文 20 回 / 話者を交互に 8 回
set -eu

cd "$(dirname "$0")/.."
PROJECT=
while getopts p: opt; do
  case "$opt" in
    p) PROJECT=$OPTARG ;;
    *) echo "usage: $0 [-p project] [workers ...]" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[ $# -gt 0 ] || set -- 3 1
if [ -n "$PROJECT" ]; then
  EBYROID_HOST_PORT=${EBYROID_HOST_PORT:-127.0.0.1:14090}
  export EBYROID_HOST_PORT
fi

mkdir -p bench/results
OUT=bench/results/$(hostname -s)-$(date +%Y%m%d-%H%M%S).txt
RAW=$(mktemp)

dc() { docker compose ${PROJECT:+-p "$PROJECT"} "$@"; }
# 途中で失敗しても、捨てコンテナは消し、いつものコンテナは .env の設定に戻す
cleanup() {
  rm -f "$RAW"
  if [ -n "$PROJECT" ]; then dc down > /dev/null 2>&1 || true
  else dc up -d --no-build > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log() { echo "$*" | tee -a "$OUT"; }
in_container() { dc exec -T ebyroid sh -s -- "$@" < bench/requests.sh; }

# rows <label...>: 指定したラベルの行（失敗は除く）
rows() { awk -v ls=" $* " 'index(ls, " " $1 " ") && $6 == 200' "$RAW"; }
# med <列番号>: 標準入力の行のその列の中央値
med() {
  awk -v c="$1" '{ print $c }' | sort -n | awk '{ a[NR] = $1 }
    END { if (NR == 0) { print "-"; exit }
          if (NR % 2) printf "%.2f\n", a[(NR + 1) / 2]
          else printf "%.2f\n", (a[NR / 2] + a[NR / 2 + 1]) / 2 }'
}
# audio <label>: そのラベルの音声の長さ（秒）の中央値
audio() { rows "$1" | awk '$7 > 0 { printf "%.6f\n", $5 / ($7 * 2) }' | med 1; }

model() {
  if [ -r /proc/device-tree/model ]; then tr -d '\0' < /proc/device-tree/model
  elif sysctl -n hw.model > /dev/null 2>&1; then
    printf '%s, %s' "$(sysctl -n hw.model)" "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
  else uname -m
  fi
}

image=$(dc config --images | head -n 1)
log "# ebyroid bench $(date '+%Y-%m-%d %H:%M:%S %z')"
log "host:   $(model) / $(uname -srm)"
log "docker: $(docker version --format '{{.Server.Version}}'), $(docker info --format '{{.NCPU}} CPUs, {{.MemTotal}} bytes of memory')"
log "image:  $image $(docker image inspect --format '{{index .RepoDigests 0}}' "$image" 2>/dev/null || docker image inspect --format '{{.Id}}' "$image")"

for W in "$@"; do
  : > "$RAW"
  log ""
  log "## --workers $W"
  dc rm -sf ebyroid > /dev/null 2>&1
  t0=$(date +%s)
  EBYROID_WORKERS=$W dc up -d --no-build > /dev/null 2>&1
  in_container wait-health
  log "start until healthy:            $(( $(date +%s) - t0 )) s"
  log "page size:                      $(dc exec -T ebyroid getconf PAGESIZE)"

  if [ "$W" -ge 3 ]; then
    in_container cold >> "$RAW"
    in_container warm >> "$RAW"
    in_container par >> "$RAW"
  else
    in_container warm kiritan >> "$RAW"
    in_container switch >> "$RAW"
  fi

  failed=$(awk '$1 != "par_wall" && $6 != 200' "$RAW" | wc -l | tr -d ' ')
  short=$(rows short | med 4)
  if [ "$W" -ge 3 ]; then
    log "worker start (first request):   $(rows cold | awk '{ printf "%s%s %.1f s", (NR > 1 ? ", " : ""), $2, $4 }')"
  fi
  log "short ($(audio short) s of audio):        $short s (first audio $(rows short | med 3) s, n=$(rows short | wc -l | tr -d ' '))"
  log "long ($(audio long) s of audio):        $(rows long | med 4) s (first audio $(rows long | med 3) s, n=$(rows long | wc -l | tr -d ' '))"
  if [ "$W" -ge 3 ]; then
    log "3 voices in parallel, short:    $(rows par | med 4) s, $(awk '$1 == "par_wall" { printf "%.1f", $2 / $3 }' "$RAW") requests/s"
    log "late finish (end - first audio > 0.3 s), short and parallel: $(rows short par | awk '$4 - $3 > 0.3 { s++ } END { printf "%d of %d", s, NR }')"
  else
    # 最初の kiritan は切り替えなし
    sw=$(rows switch | awk 'NR > 1' | med 4)
    log "voice change, short:            $sw s (extra $(awk -v a="$sw" -v b="$short" 'BEGIN { printf "%.1f", a - b }') s per change)"
    log "late finish (end - first audio > 0.3 s), short: $(rows short | awk '$4 - $3 > 0.3 { s++ } END { printf "%d of %d", s, NR }')"
  fi

  cid=$(dc ps -q ebyroid)
  # node.exe のプロセスを PID 順に。いちばん小さいのがプライマリ（--workers 1 では 1 プロセスだけ）
  log "memory (RSS, primary first):    $(docker top "$cid" -eo pid,rss,args | awk '/node\.exe/ && !/xvfb-run/ { print $1, int($2 / 1024) }' \
    | sort -n | awk '{ printf "%s%d MB", (NR > 1 ? ", " : ""), $2 }')"
  log "meminfo:                        $(in_container meminfo | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
  log "failed requests:                $failed"
  log "restarts / OOM killed:          $(docker inspect --format '{{.RestartCount}} / {{.State.OOMKilled}}' "$cid")"
  { echo "### raw ($W workers): label voice first_audio total bytes http_code sample_rate"; cat "$RAW"; } >> "$OUT"
done

log ""
log "written to $OUT"
