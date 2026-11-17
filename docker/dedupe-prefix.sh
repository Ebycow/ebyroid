#!/bin/sh
# wineboot がプレフィックスへコピーした wine の DLL や EXE を、元のファイルへのハードリンクに置き換える
# 使い方: dedupe-prefix.sh <プレフィックス>
# 元のファイルは /usr/lib の下の wine/<アーキテクチャ>-windows (Debian の amd64 は i386-linux-gnu/wine/i386-windows)。
# 同じ名前で中身もまったく同じものだけを置き換えるので、wine が書き換えたファイルはそのまま残る
set -eu

prefix=$1
dirs=$(find /usr/lib -type d -path '*wine/*-windows')
[ -n "$dirs" ] || { echo "dedupe-prefix: no wine *-windows directory under /usr/lib" >&2; exit 1; }

find "$prefix/drive_c" -type f | {
  linked=0
  bytes=0
  while IFS= read -r f; do
    name=${f##*/}
    for d in $dirs; do
      if [ -f "$d/$name" ] && cmp -s "$f" "$d/$name"; then
        bytes=$((bytes + $(stat -c %s "$f")))
        ln -f "$d/$name" "$f"
        linked=$((linked + 1))
        break
      fi
    done
  done
  echo "dedupe-prefix: linked $linked files ($((bytes / 1048576)) MiB) in $prefix to $(echo $dirs | tr '\n' ' ')"
  [ "$linked" -gt 0 ] || { echo "dedupe-prefix: nothing was linked" >&2; exit 1; }
}
