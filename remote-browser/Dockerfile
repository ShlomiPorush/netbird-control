FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS node

FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium \
      tigervnc-standalone-server \
      tigervnc-tools \
      matchbox-window-manager \
      x11-xserver-utils \
      x11-xkb-utils \
      xauth \
      fonts-noto-core \
      ulogd2 \
      ulogd2-json \
      iproute2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY policies/managed.json /etc/chromium/policies/managed/managed.json
COPY ulogd.conf /etc/ulogd.conf
COPY --chmod=0755 hebrew-keymap.sh /usr/local/bin/hebrew-keymap
COPY --chmod=0755 collector.sh /usr/local/bin/collector
COPY supervisor/ /opt/supervisor/
ENV LANG=C.UTF-8
LABEL netbird-control.zero-downtime-update="1"
CMD ["node", "/opt/supervisor/main.js"]
