#!/bin/sh
case "$1" in
  /var/lib/browser-files/* | file:///var/lib/browser-files/*) ;;
  *) exit 0 ;;
esac
node -e "require('net').connect(process.argv[1]).end()" "/run/browser/files-request-$(($(id -u) - 62000)).sock" 2>/dev/null
exit 0
