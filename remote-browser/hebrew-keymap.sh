#!/bin/sh
set -eu
setxkbmap -layout us
spare=$(xmodmap -pke | awk '
  NF == 3 && $2 >= 8 { print $2 }
  $4 ~ /^(XF86Launch[0-9A-F]|XF86Tools|F1[3-9]|F2[0-4])$/ { print $2 }
')
set -- $spare
if [ "$#" -lt 27 ]; then
  echo "Only $# spare keycodes for the 27 Hebrew letters." >&2
  exit 1
fi
for codepoint in $(seq 1488 1514); do
  xmodmap -e "keycode $1 = U$(printf '%04X' "$codepoint")"
  shift
done
