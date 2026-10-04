# VOICEROID+ と ebyroid (win32-ia32) を wine で動かすイメージ
# ネイティブアドオンは MinGW-w64 でクロスビルドし、Windows 版 node.exe で JS をそのまま動かす
ARG NODE_VERSION=12.13.1

# ---- ebyroid.node (win32-ia32) を MinGW-w64 でビルド ----
FROM debian:bookworm-slim AS addon
ARG NODE_VERSION
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
FROM node:12-bullseye-slim AS deps
WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
# package.json の os/arch (win32/ia32) チェックと、cmake-js による install ビルドは飛ばす
RUN npm ci --only=production --ignore-scripts --force --no-audit --no-fund

# ---- 実行環境 ----
FROM debian:bookworm-slim
ARG NODE_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=ja_JP.UTF-8 \
    LC_ALL=ja_JP.UTF-8 \
    WINEARCH=win32 \
    WINEPREFIX=/wine \
    WINEDEBUG=-all

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      wine wine32 ca-certificates curl unzip \
      locales xvfb xauth tini \
 && sed -i 's/^# *ja_JP.UTF-8/ja_JP.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# 32bit プレフィックスを作る
# (VOICEROID+ 側の msvcr100/msvcp100 はインストールディレクトリに同梱されている)
RUN xvfb-run -a sh -c 'wineboot --init && wineserver -w'

# Windows 版 node.exe (ia32)
RUN curl -fsSLo /tmp/node.zip https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x86.zip \
 && unzip -j /tmp/node.zip "node-v${NODE_VERSION}-win-x86/node.exe" -d /opt/node \
 && rm /tmp/node.zip

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=addon /src/build/ebyroid.node /app/dll/ebyroid.node
COPY docker/entrypoint.sh /entrypoint.sh

# bin/ lib/ index.js package.json は compose でマウントする
WORKDIR /app
EXPOSE 4090
# -g: 停止時の SIGTERM をプロセスグループ全体 (wine, Xvfb, tail) に送る
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
