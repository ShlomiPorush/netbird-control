#!/bin/sh
set -eu
dir=/run/nbc-connections
if [ "$(stat -c %u:%g:%a "$dir")" != 1000:1000:700 ]; then
  chown 0:0 "$dir"
  chmod 0700 "$dir"
  chown 1000:1000 "$dir"
fi
until [ -S "$dir/connections.sock" ]; do sleep 2; done
exec ulogd -c /etc/ulogd.conf
