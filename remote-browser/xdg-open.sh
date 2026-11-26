#!/bin/sh
slot=$(($(id -u) - 62000))
folder=/var/lib/browser-files/chromium-$slot
case "$1" in
  file://*) target=${1#file://} ;;
  [A-Za-z]*:*) exit 0 ;;
  /*) target=$1 ;;
  *) target=$PWD/$1 ;;
esac
target=$(realpath -m -- "$target") || exit 0
case "$target" in
  "$folder" | "$folder"/*) ;;
  *) exit 0 ;;
esac
node -e "require('net').connect(process.argv[1]).end()" "/run/browser/files-request-$slot.sock" 2>/dev/null
exit 0
