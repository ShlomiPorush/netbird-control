#!/bin/sh
# Keeps the NetBird exit node away from internal networks and from this VM.
#
# A user who turns on the exit node sends 0.0.0.0/0 through a container that sits inside your
# network. Without these rules that user reaches internal addresses directly and skips every
# NetBird policy.
#
# The rules are in the raw table's PREROUTING chain and match the exit node's bridge interface.
# So they:
# - are in place before Docker starts the container (docker.service runs this script first),
#   and Docker never changes them;
# - see every packet the container sends, to other hosts and to this VM, whatever its source
#   address (also when NetBird does not masquerade the exit node's traffic);
# - match only the destination, so internet traffic and its replies are not affected.
#
# Every run replaces the rules of the chain in one transaction: a range removed here is removed
# from the firewall on the next run. A failed run exits with an error, which keeps Docker down.
set -eu

# The bridge name pinned in docker-compose-exit-node.yml (com.docker.network.bridge.name).
BRIDGE=br-nb-exit
CHAIN=NB-EXIT-ISOLATION

# Private, shared (CGNAT), loopback, link-local, benchmarking, documentation, multicast and
# reserved IPv4 ranges. A new internal range inside any of them needs no change here.
RANGES="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4"

# With --noflush, iptables-restore creates the chain or empties it, and commits the new rules
# in one transaction. The other chains of the raw table are left alone.
{
  echo '*raw'
  echo ":$CHAIN - [0:0]"
  for range in $RANGES; do
    echo "-A $CHAIN -d $range -j DROP"
  done
  echo 'COMMIT'
} | iptables-restore -w --noflush

iptables -w -t raw -C PREROUTING -i "$BRIDGE" -j "$CHAIN" 2>/dev/null ||
  iptables -w -t raw -I PREROUTING 1 -i "$BRIDGE" -j "$CHAIN"
