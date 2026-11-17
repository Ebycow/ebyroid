# VOICEROID+ と ebyroid (win32-ia32) を wine で動かすイメージ
# ネイティブアドオンは MinGW-w64 でクロスビルドし、Windows 版 node.exe で JS をそのまま動かす
# 32bit Windows 版 (win-x86) が配布されているのは 22 系まで (23 以降は廃止)
#
# linux/amd64: Debian の wine32 (i386) で動かす
# linux/arm64: Hangover (ARM64 向けの wine) の WoW64 で動かし、x86 のコードは Box64 でエミュレーションする
#              (Raspberry Pi 4 など。カーネルのページサイズが 4K である必要がある)
ARG NODE_VERSION=22.23.4
ARG HANGOVER_VERSION=11.16

# ---- ebyroid.node (win32-ia32) を MinGW-w64 でビルド ----
# 出力は Windows 用の DLL なので、ビルドするマシンのアーキテクチャで 1 回だけ作る
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS addon
ARG NODE_VERSION
# パイプの途中 (curl など) で失敗したらビルドを止める
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      g++-mingw-w64-i686-posix cmake make curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# N-API のヘッダと、node.exe のエクスポートを指す import library
# GNU ld は MSVC の node.lib をうまく扱えない (import table が空になる) ので、
# node.lib から napi_* の名前だけ取り出して dlltool で作り直す
RUN mkdir -p /opt/node \
 && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-headers.tar.gz \
    | tar -xz -C /opt/node --strip-components=1 \
 && curl -fsSLo /tmp/node.lib https://nodejs.org/dist/v${NODE_VERSION}/win-x86/node.lib \
 && { echo 'LIBRARY node.exe'; echo 'EXPORTS'; \
      i686-w64-mingw32-nm /tmp/node.lib | awk '$2 == "T" && $3 ~ /^_napi_/ { print substr($3, 2) }' | sort -u; \
    } > /opt/node/node.def \
 && i686-w64-mingw32-dlltool -d /opt/node/node.def -l /opt/node/libnode.a \
 && rm /tmp/node.lib
WORKDIR /src
COPY CMakeLists.txt ./
COPY docker/mingw-i686.cmake docker/
COPY src src
RUN cmake -S . -B build \
      -DCMAKE_TOOLCHAIN_FILE=docker/mingw-i686.cmake \
      -DCMAKE_BUILD_TYPE=Release \
      -DNODE_INCLUDE_DIR=/opt/node/include/node \
      -DNODE_LIB=/opt/node/libnode.a \
 && cmake --build build -j"$(nproc)"

# ---- node_modules (中身は JS だけなので Linux の npm で入れる) ----
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
# package.json の os/arch (win32/ia32) チェックと、cmake-js による install ビルドは飛ばす
RUN npm ci --omit=dev --ignore-scripts --force --no-audit --no-fund

# ---- wine (amd64): Debian の 32bit wine ----
FROM debian:bookworm-slim AS wine-amd64
ENV WINEARCH=win32
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends wine wine32 \
 && rm -rf /var/lib/apt/lists/*

# ---- wine (arm64): Hangover ----
# 32bit の Windows アプリは 64bit プレフィックスの WoW64 で動く。
FROM debian:trixie-slim AS wine-arm64
ARG HANGOVER_VERSION
# SHELL を bash にするとこのあとのステージにも引き継がれ、docker build の RUN で xvfb-run が止まるので、
# pipefail は使わずに、ファイルに保存してから展開する
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && mkdir /tmp/hangover \
 && curl -fsSLo /tmp/hangover.tar https://github.com/AndreRH/hangover/releases/download/hangover-${HANGOVER_VERSION}/hangover_${HANGOVER_VERSION}_debian13_trixie_arm64.tar \
 && tar -x -C /tmp/hangover -f /tmp/hangover.tar \
      hangover-wine_${HANGOVER_VERSION}~trixie_arm64.deb \
      hangover-libarm64ecfex_${HANGOVER_VERSION}_arm64.deb \
      hangover-libwow64fex_${HANGOVER_VERSION}_arm64.deb \
      hangover-wowbox64_${HANGOVER_VERSION}_arm64.deb \
 && apt-get install -y --no-install-recommends /tmp/hangover/*.deb \
 && rm -rf /tmp/hangover /tmp/hangover.tar /var/lib/apt/lists/*
# x86 のエミュレータ。wowbox64.dll: Box64 / libwow64fex.dll: FEX
# FEX (Hangover 11.16) では、プライマリが転送したあとに次のワーカーを起動すると
# プライマリの node.exe がアクセス違反で落ちる。Box64 ではこれが起きず、合成も速い (Pi 4 で 1 文 0.3 秒ほど)
ENV HODLL=wowbox64.dll

# ---- 実行環境 ----
# 上の wine-amd64 / wine-arm64 のどちらか。hadolint 2.15 は変数入りのステージ名を解決できないので DL3006 を止める
# hadolint ignore=DL3006
FROM wine-${TARGETARCH}
ARG NODE_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=ja_JP.UTF-8 \
    LC_ALL=ja_JP.UTF-8 \
    WINEPREFIX=/wine \
    WINEDEBUG=-all

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
      locales xvfb xauth tini \
 && sed -i 's/^# *ja_JP.UTF-8/ja_JP.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# プレフィックスを作る (amd64 は 32bit、arm64 は 64bit の WoW64)
# (VOICEROID+ 側の msvcr100/msvcp100 はインストールディレクトリに同梱されている)
# win32 プレフィックスの既定は Windows 7 で、Node.js 22 は 8.1 未満だと起動しないので Windows 10 にする
# mscoree/mshtml を無効にして、Wine Mono / Gecko のインストール確認ダイアログで止まらないようにする (node も VOICEROID も使わない)
RUN WINEDLLOVERRIDES='mscoree,mshtml=' xvfb-run -a sh -c 'wineboot --init && winecfg /v win10 && wineserver -w'

# Windows 版 node.exe (ia32)
RUN curl -fsSLo /tmp/node.zip https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x86.zip \
 && unzip -j /tmp/node.zip "node-v${NODE_VERSION}-win-x86/node.exe" -d /opt/node \
 && rm /tmp/node.zip

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=addon /src/build/ebyroid.node /app/dll/ebyroid.node
COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh
# 開発では compose.override.yaml でマウントし、作り直さずに差し替える
COPY package.json index.js /app/
COPY bin /app/bin
COPY lib /app/lib

WORKDIR /app
EXPOSE 4090
# -g: 停止時の SIGTERM をプロセスグループ全体 (wine, Xvfb, tail) に送る
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
