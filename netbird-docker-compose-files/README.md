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

- It **must** stay on its bridge network (`172.20.0.0/24`), not on host networking. Its isolation
  from the internal network depends on a `DOCKER-USER` rule that host networking would skip.
- **This file does not isolate it on its own.** Add the `DOCKER-USER` rule from the end of the
  file on the VM, one rule for each internal range, and make it survive reboots. Without it, a
  user of the exit node reaches internal resources and skips every NetBird policy.
- Set `SETUP_KEY` in a `.env` file next to the compose file. The peer's identity is kept in
  `./data`.

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
- Start a file from its folder with `docker compose -f <file> up -d`.
