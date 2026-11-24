# NetBird Docker Compose Files

This folder holds two kinds of Compose files:

- **An add-on for NetBird Control itself:** `docker-compose-remote-access.yml`. You always run it
  together with the main `docker-compose.yml` in the repository root.
- **Standalone NetBird infrastructure files:** the routing peer, the exit node and the reverse
  proxy. They run on your NetBird VMs, not with the app, and NetBird Control does not need them.
  They are reference setups for the infrastructure that the app manages.

| File | Runs on | What it starts |
|---|---|---|
| [`docker-compose-remote-access.yml`](#docker-compose-remote-accessyml) | The NetBird Control host, with the main compose file | The Browser Gateways for RDP and SSH in the browser |
| [`docker-compose-netbird.yml`](#docker-compose-netbirdyml) | A NetBird VM | A NetBird routing peer on the host network |
| [`docker-compose-exit-node.yml`](#docker-compose-exit-nodeyml) | A NetBird VM | A NetBird exit node, isolated from the internal network |
| [`exit-node-isolation`](#isolate-the-exit-node) | The exit node's VM, on the host (not Docker) | The firewall rules that keep the exit node away from internal networks, applied before Docker starts |
| [`docker-compose-reverse-proxy.yml`](#docker-compose-reverse-proxyyml) | A NetBird VM | The NetBird reverse proxy, published directly on ports 80 and 443 |
| [`docker-compose-reverse-proxy-traefik.yml`](#docker-compose-reverse-proxy-traefikyml) | A NetBird VM | The NetBird reverse proxy behind Traefik, with its own LAN address |

## docker-compose-remote-access.yml

The optional Browser Remote Access feature: users open RDP and SSH sessions from the browser. It
adds two pairs of containers next to the app:

- **A gateway:** a NetBird client container, which is a peer in your NetBird network.
- **guacd:** Apache Guacamole's daemon. It translates RDP and SSH for the browser. It shares the
  gateway's network namespace, so its connections leave only through the NetBird tunnel.

The IP gateway (`remote-gateway` and `remote-guacd`) always starts with this file. The names
gateway (`remote-names-gateway` and `remote-names-guacd`) starts only with the `remote-names`
profile and reaches NetBird domain resources by host name.

Run it from the repository root, with the main file first. Compose then reads `.env` from the
repository root:

```sh
docker compose -f docker-compose.yml -f netbird-docker-compose-files/docker-compose-remote-access.yml up -d
# With the names gateway:
docker compose -f docker-compose.yml -f netbird-docker-compose-files/docker-compose-remote-access.yml --profile remote-names up -d
```

It needs `REMOTE_GATEWAY_SETUP_KEY` (and `REMOTE_NAMES_GATEWAY_SETUP_KEY` for the names gateway)
in `.env`, created in **Settings → Remote Access**. It also needs host firewall rules that this
file cannot set. The setup, the firewall rules and the security model are in
[docs/remote-access.md](../docs/remote-access.md).

## docker-compose-netbird.yml

A NetBird routing peer: the client that routes NetBird traffic into the VM's network.

- It uses **host networking**, so it is not behind Docker's NAT and can connect peer to peer
  instead of through relays. Only one NetBird container per VM can use host networking.
- It uses the kernel TUN device (`/dev/net/tun`), so it creates a real `wt0` interface on the VM.
- The VM must have IP forwarding on, and its firewall must allow outbound UDP to the NetBird
  STUN and TURN servers. The steps are in the comments at the top of the file.
- Set `SETUP_KEY` in a `.env` file next to the compose file. The peer's identity is kept in
  `./data`.

## docker-compose-exit-node.yml

A NetBird exit node: users who turn it on send all their internet traffic through this VM.

- It **must** stay on its bridge network, not on host networking. Its isolation from the internal
  network depends on firewall rules that match the network's bridge interface (`br-nb-exit`),
  which host networking would skip.
- **This file does not isolate it on its own.** Install the rules in
  [`exit-node-isolation`](exit-node-isolation) on the VM first, as described in
  [Isolate the Exit Node](#isolate-the-exit-node). Without them, a user of the exit node reaches
  internal resources and skips every NetBird policy.
- Set `SETUP_KEY` in a `.env` file next to the compose file. The peer's identity is kept in
  `./data`.

### Isolate the Exit Node

[`netbird-exit-isolation.sh`](exit-node-isolation/netbird-exit-isolation.sh) drops every packet
that the exit node sends to:

- **The private and reserved IPv4 ranges:** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  the shared address space `100.64.0.0/10` (which NetBird also uses), loopback, link-local,
  benchmarking, documentation, multicast and reserved ranges. When your network gets a new
  internal range inside them, you do not need to change the rules.
- **The VM itself**, through its internal addresses, such as its SSH server.

The rules are in the `raw` table, in a chain of their own (`NB-EXIT-ISOLATION`) that the
`PREROUTING` chain sends the bridge's traffic to. So they:

- **Are in place before the exit node starts.**
  [`netbird-exit-isolation.conf`](exit-node-isolation/netbird-exit-isolation.conf) is a drop-in
  for `docker.service` that runs the script every time before Docker starts. If the script fails,
  Docker does not start, so it does not start the exit node without the rules either. Run
  `sudo /usr/local/sbin/netbird-exit-isolation.sh` to see why.
- **Catch every packet from the exit node**, whatever its source address, also when NetBird does
  not masquerade the exit node's traffic.
- **Match only the destination**, so internet traffic and its replies keep working.
- **Are not changed by Docker or ufw.** They must stay in place the whole time the exit node runs.
  A firewall manager that clears all tables when it reloads, such as firewalld with its `iptables`
  backend, `netfilter-persistent reload`, or an nftables configuration that starts with
  `flush ruleset`, removes them, together with Docker's own rules. Do not run one on this VM.

Each run replaces the rules of the chain in one transaction, so running the script again is safe,
and a range that you remove from the script is removed from the firewall on the next run.

What the rules do not cover:

- **Internal servers at public addresses**, such as a server that the office router publishes
  through a port forward.
- **A public address on the VM.** The rules match destinations, so every address of the VM must
  be inside the ranges above.
- **IPv6.** The Compose file keeps IPv6 off on the exit node's network. Check it with
  `docker network inspect netbird-exit-node -f '{{.EnableIPv6}}'`, which must print `false`.
- **NetBird servers at internal addresses.** The exit node cannot reach a self-hosted NetBird
  management, signal, relay or STUN server at an internal address. This setup assumes public
  servers, such as NetBird Cloud. Direct connections to peers at internal addresses are blocked
  too, so those connections use a relay.

#### Install

If an exit node from an earlier setup runs on the VM, remove its container and its network first,
so that the network is created again with the pinned bridge name. Its `./data` folder is kept.
Run:

```sh
sudo sh -e <<'EOF_STOP'
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT
containers=$(docker ps -a --format '{{.Names}}')
if printf '%s\n' "$containers" | grep -qx netbird-exit-node; then docker rm -f netbird-exit-node; fi
networks=$(docker network ls --format '{{.Name}}')
if printf '%s\n' "$networks" | grep -qx netbird-exit-node; then docker network rm netbird-exit-node; fi
echo "No exit node container or network is left from the earlier setup."
EOF_STOP
```

The block removes only the container and the network named `netbird-exit-node`. Docker refuses to
remove the network while another container still uses it, and the block stops there. If your
earlier exit node container has another name, remove it with `docker rm -f <name>` and run the
block again. Its users lose the exit node until the Start block below has run.

Copy the `exit-node-isolation` folder to the VM. In that folder, run:

```sh
sudo sh -e <<'EOF_INSTALL'
put() {
  tmp=$(mktemp "$(dirname "$3")/.netbird-exit-isolation.XXXXXX")
  install -m "$1" "$2" "$tmp"
  mv -f "$tmp" "$3"
}
sh ./netbird-exit-isolation.sh
install -d -m 0755 /etc/systemd/system/docker.service.d
put 0755 netbird-exit-isolation.sh /usr/local/sbin/netbird-exit-isolation.sh
put 0644 netbird-exit-isolation.conf /etc/systemd/system/docker.service.d/netbird-exit-isolation.conf
systemctl daemon-reload
systemctl show docker.service -p ExecStartPre | grep -q netbird-exit-isolation.sh
echo "Installed: Docker runs the isolation script before it starts, and the rules are active."
EOF_INSTALL
```

The block stops at the first error. It first runs the script from the folder, which applies the
rules right away, and installs the script and the drop-in only when that run works, so a script
that fails never reaches the next Docker start. Each file is written under a temporary name of its
own next to its final name and then renamed in one step, so an interrupted update leaves the
previous file in place. To change the rules later, edit the script and run the block again.

Rules from an earlier setup, such as `DOCKER-USER` rules for `172.20.0.0/24` and whatever restores
them at boot, do not conflict with these. Remove them after the Check below passes.

#### Start

Start the exit node with this block, from the folder of its Compose file:

```sh
sudo sh -e <<'EOF_START'
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT
systemctl show docker.service -p ExecStartPre | grep -q netbird-exit-isolation.sh
/usr/local/sbin/netbird-exit-isolation.sh
owned=$(docker ps -a --filter label=com.docker.compose.project=netbird-exit-node --format '{{.Names}}')
if [ -n "$owned" ] && [ "$owned" != netbird-exit-node ]; then echo "Compose project netbird-exit-node already holds other containers: $owned. Compose would replace them. Nothing started." >&2; exit 1; fi
docker compose -p netbird-exit-node -f docker-compose-exit-node.yml up --no-start
net=$(docker network inspect netbird-exit-node -f '{{index .Options "com.docker.network.bridge.name"}} ipv6={{.EnableIPv6}}')
if [ "$net" != "br-nb-exit ipv6=false" ]; then echo "The netbird-exit-node network is '$net', not 'br-nb-exit ipv6=false'. Remove it with the first block in Install and start again. Nothing started." >&2; exit 1; fi
docker compose -p netbird-exit-node -f docker-compose-exit-node.yml start
echo "The exit node runs on br-nb-exit without IPv6, and the isolation rules are active."
EOF_START
```

The block uses the VM's own Docker, applies the current rules, and stops if the Compose project
already holds a container other than the exit node, such as a routing peer started from a folder
with the same name. It creates the exit node without starting it, and starts it only when its
network has the pinned bridge name and no IPv6.

#### Check

After setup and after every reboot:

```sh
sudo iptables -t raw -S PREROUTING | grep NB-EXIT-ISOLATION      # -i br-nb-exit -j NB-EXIT-ISOLATION
sudo iptables -t raw -S NB-EXIT-ISOLATION | grep -c DROP         # 13
docker network inspect netbird-exit-node -f '{{index .Options "com.docker.network.bridge.name"}}'   # br-nb-exit
INTERNAL=10.0.0.1   # replace with an internal address that answers ping from this VM
ping -c1 -W2 "$INTERNAL"                                         # from the VM: answers
docker exec netbird-exit-node ping -c1 -W2 "$INTERNAL"           # from the exit node: no answer
docker exec netbird-exit-node ping -c1 -W2 1.1.1.1               # answers
docker exec netbird-exit-node nslookup api.netbird.io            # resolves
docker exec netbird-exit-node netbird status | grep -E '^(Management|Signal): Connected'   # 2 lines
sudo iptables -t raw -L NB-EXIT-ISOLATION -v -n                  # the DROP counter of that range grew
```

Then test from a NetBird client outside the office network that has this exit node turned on and
no NetBird route to `$INTERNAL`: `$INTERNAL` does not answer, and the DROP counter of its range
grows by the client's packets. A website that shows your address shows the office address.

**DNS:** the Compose file sets public DNS servers for the exit node with `dns:`. Keep them outside
your network. Without `dns:`, Docker can send the exit node's lookups from the VM to the VM's own
DNS server, which is often internal and which the rules do not see.

To remove the isolation, stop and remove the exit node first. Then delete the drop-in, run
`systemctl daemon-reload`, delete every `NB-EXIT-ISOLATION` jump from the raw `PREROUTING` chain,
and delete the chain.

## docker-compose-reverse-proxy.yml

The NetBird reverse proxy (`netbirdio/reverse-proxy`), published directly on ports 80 and 443 of
the VM. Use this file when nothing else on the VM needs those ports.

- Set `NB_PROXY_DOMAIN` and `NB_PROXY_TOKEN` in a `.env` file next to the compose file.
- Certificates are kept in `./certs`. Your own wildcard certificates and the MaxMind GeoIP data are
  read from `../../files/certs` and `../../files/maxmind`, two folders above the compose file.
- It trusts PROXY protocol headers from all private ranges. If the device that forwards ports 80
  and 443 to the VM has a fixed address, narrow `NB_PROXY_TRUSTED_PROXIES` to that address.
  Otherwise anything inside those ranges can fake client addresses in the access logs.

## docker-compose-reverse-proxy-traefik.yml

The same NetBird reverse proxy, behind Traefik. Use this file instead of
`docker-compose-reverse-proxy.yml`, not together with it: both create the `netbird-proxy`
container and network.

- Traefik owns ports 80 and 443. It redirects HTTP to HTTPS and passes TLS through, without
  decrypting it, to the proxy on port 8443 with PROXY protocol v2.
- The proxy reaches your LAN from its own address on an `ipvlan` network. Set
  `PROXY_EGRESS_PARENT`, `PROXY_EGRESS_SUBNET`, `PROXY_EGRESS_GATEWAY` and `PROXY_EGRESS_IP` in
  `.env`. The comments in the file describe each value.
- The rest of the settings and folders are the same as in `docker-compose-reverse-proxy.yml`.

## Running the Infrastructure Files

- Put each infrastructure file in **its own folder** on the VM, with its own `.env`. The routing
  peer and the exit node both name their service `netbird` and both keep state in `./data`, so in
  one folder they would overwrite each other.
- Make each `.env` readable only by its owner (`chmod 600 .env`). It holds setup keys and tokens.
- Start a file from its folder with `docker compose -f <file> up -d`. The exit node is the
  exception: install its isolation and start it as described in [Isolate the Exit Node](#isolate-the-exit-node).
