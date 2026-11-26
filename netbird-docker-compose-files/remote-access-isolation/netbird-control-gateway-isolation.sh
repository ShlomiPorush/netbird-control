#!/bin/sh
set -eu

# The subnets pinned in docker-compose-remote-access.yml.
EGRESS=172.31.251.0/24
# The lower half of the internal network holds the gateways' fixed addresses (.2 and .3). The app
# takes its address from the upper half.
GATEWAYS=172.31.250.0/25
FORWARD_CHAIN=NBC-GATEWAY-FORWARD
INPUT_CHAIN=NBC-GATEWAY-INPUT

# Private, shared (CGNAT), loopback, link-local, protocol assignments, benchmarking,
# documentation, multicast and reserved IPv4 ranges. A new internal range inside any of them
# needs no change here.
RANGES="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4"

forward_rules() {
  echo "-A $FORWARD_CHAIN -s $EGRESS -o br-+ -j DROP"
  echo "-A $FORWARD_CHAIN -s $EGRESS -o docker0 -j DROP"
  for range in $RANGES; do
    echo "-A $FORWARD_CHAIN -s $EGRESS -d $range -j DROP"
  done
}

input_rules() {
  echo "-A $INPUT_CHAIN -s $EGRESS -j DROP"
  echo "-A $INPUT_CHAIN -s $GATEWAYS -j DROP"
}

check() {
  ok=1
  [ "$(iptables -w -t mangle -S "$FORWARD_CHAIN" 2>/dev/null | grep '^-A')" = "$(forward_rules)" ] ||
    { echo "MISSING: the rules of $FORWARD_CHAIN differ"; ok=0; }
  [ "$(iptables -w -t mangle -S "$INPUT_CHAIN" 2>/dev/null | grep '^-A')" = "$(input_rules)" ] ||
    { echo "MISSING: the rules of $INPUT_CHAIN differ"; ok=0; }
  [ "$(iptables -w -t mangle -S FORWARD | grep -m1 '^-A')" = "-A FORWARD -j $FORWARD_CHAIN" ] ||
    { echo "MISSING: $FORWARD_CHAIN is not the first rule of mangle FORWARD"; ok=0; }
  [ "$(iptables -w -t mangle -S INPUT | grep -m1 '^-A')" = "-A INPUT -j $INPUT_CHAIN" ] ||
    { echo "MISSING: $INPUT_CHAIN is not the first rule of mangle INPUT"; ok=0; }
  [ "$ok" = 1 ] && echo "OK: the isolation rules are in place"
  [ "$ok" = 1 ]
}

if [ "${1:-}" = check ]; then
  check
  exit
fi

{
  echo '*mangle'
  echo ":$FORWARD_CHAIN - [0:0]"
  echo ":$INPUT_CHAIN - [0:0]"
  forward_rules
  input_rules
  echo 'COMMIT'
} | iptables-restore -w --noflush

for chain in FORWARD INPUT; do
  target=NBC-GATEWAY-$chain
  iptables -w -t mangle -C "$chain" -j "$target" 2>/dev/null ||
    iptables -w -t mangle -I "$chain" 1 -j "$target"
done

check
