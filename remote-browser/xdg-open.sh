#!/bin/sh
slot=$(($(id -u) - 62000))
folder=/var/lib/browser-files/chromium-$slot
grep -q '"AllowFileSelectionDialogs":true' /etc/chromium/policies/managed/files.json || exit 0
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
[ -d "$target" ] && target=$target/
pkill -x -u "$(id -u)" zenity
setsid zenity --file-selection --title=Downloads --filename="$target" >/dev/null 2>&1 &
exit 0
