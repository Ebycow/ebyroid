# VOICEROID+ と ebyroid.exe (win32-ia32) を wine で動かすイメージ
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=ja_JP.UTF-8 \
    LC_ALL=ja_JP.UTF-8 \
    WINEARCH=win32 \
    WINEPREFIX=/wine \
    WINEDEBUG=-all

RUN dpkg --add-architecture i386 \
 && sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      wine wine32 winetricks cabextract ca-certificates curl \
      locales xvfb xauth tini \
 && sed -i 's/^# *ja_JP.UTF-8/ja_JP.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# 32bit プレフィックスを作り、ebyroid.node が使う VC++ 2015-2022 ランタイムを入れる
# (VOICEROID+ 側の msvcr100/msvcp100 はインストールディレクトリに同梱されている)
RUN xvfb-run -a sh -c 'wineboot --init && wineserver -w \
 && winetricks -q --unattended vcrun2022 && wineserver -w' \
 && rm -rf /root/.cache/winetricks

COPY docker/entrypoint.sh /entrypoint.sh

WORKDIR /ebyroid
EXPOSE 4090
# -g: 停止時の SIGTERM をプロセスグループ全体 (wine, Xvfb, tail) に送る
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
