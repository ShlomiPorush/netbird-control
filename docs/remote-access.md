# Browser Remote Access (RDP and SSH)

Users open RDP and SSH sessions from the browser, on the **Remote Access** page. They need no
NetBird client on their device, and the servers need no NetBird client either: sessions reach
Network resources through their routing peers, like any other NetBird traffic.

A user can connect only to a server that their own NetBird access already reaches, on a port
their policies already open. Remote Access never grants new access.

## How it works

```
Browser ──WSS──> NetBird Control ──(internal Docker network)──> guacd
                                                                  │  (same network namespace)
                                                       Browser Gateway peer ──NetBird──> routing peer ──> server
```

- **The Browser Gateway** is a NetBird client container (a peer) with
  [Apache Guacamole's](https://guacamole.apache.org) `guacd` in its network namespace. It runs
  next to the app, from `docker-compose.remote-access.yml`, which is added on top of the main
  compose file. Without that file an existing deployment does not change.
- **NetBird sees every browser session as traffic from the gateway peer**, not from the user.
  So NetBird Control decides who may connect where, for every session.
- **One standing policy** that the app manages, named *Browser Gateway*, lets the gateway reach the
  networks that an administrator selects. The app puts a *Browser Gateway Targets* group on the IPv4
  host and subnet resources of those networks. No temporary policies are created per session.

## Who may connect where

A session opens only when **all** of these are true. Anything the check does not positively
understand is refused.

1. SSO is on, and the user is an existing NetBird user who is not blocked.
2. The user may use Remote Access: they have the **Browser Remote Access** permission
   (Settings → Permissions), or the feature is open to every signed-in user.
3. The address is an IPv4 address inside an enabled host or subnet resource of a network that is
   open to the gateway. Host names are not supported yet.
4. An enabled *accept* policy rule connects one of the user's groups to that resource and opens the
   TCP port. The user's groups are their own groups, the groups of their peers, and *All*. A
   matching *drop* rule refuses the session.
5. **Policies with posture checks do not count.** A browser session cannot prove anything about
   the user's device, and the portal is reachable from the internet. Those users connect with the
   NetBird client instead.
6. A temporary grant counts only while it is active, not expired, and no revoke has started.
7. The gateway reaches the address through that resource **only**: no other route the gateway
   receives is as specific, and the gateway receives no domain-based route.
8. The gateway peer is online, and a routing peer of the network is online.

Rules 1 to 7 decide who may connect; rule 8 (the path is up) is checked only when a session
opens. Every 60 seconds the app reads NetBird again and checks every open session against rules
1 to 7. A session closes when the user loses access, is blocked, loses the permission (an Entra
group that grants it must be confirmed by a fresh Microsoft Graph lookup), when the network is
removed from the gateway, or when Remote Access is turned off. A router that goes down does not
close a session by itself: the connection simply stops working until it comes back. Sessions also close when access
cannot be verified with NetBird for 2.5 minutes, when the user's sign-in ends, after the idle
timeout, and after the maximum session length.

## Known limits and accepted risks

- **RDP server certificates are not verified.** Most internal Windows servers use self-signed
  certificates. Someone who can take over the server's address inside the network could receive
  the password the user types.
- **SSH host keys are verified only when an administrator enters one** for the server
  (Settings → Remote Access → SSH Host Keys).
- **RDP server redirection.** An RDP server can tell the client to reconnect to another server.
  guacd follows it, and the new connection leaves from the gateway, so it is not checked against
  the user's access. It stays inside the networks the gateway can reach. Keep that list small.
- **IPv4 addresses only** in this version. Peers (100.x addresses) and host names are not targets.
- **Main account only.** MSP tenants are not supported.
- **Connections go through NetBird relays.** The host firewall rule below blocks direct
  connections to routing peers on the local network, as for the exit nodes.
- **guacd has no authentication of its own.** It listens only on the gateway's address on an
  internal Docker network that only the app shares, and the gateway runs with `--block-inbound`.

## Set it up

1. **Turn on SSO.** Without sign-in there is no NetBird identity to check.
2. **Settings → Remote Access:** select the networks to open to the gateway, choose who can use it,
   turn on **Enable Browser Remote Access**, and save. The app creates the *Browser Gateway* and
   *Browser Gateway Targets* groups and the *Browser Gateway* policy in NetBird.
3. **Create a gateway setup key** on the same page. It is valid for one day and one use.
4. **Set the gateway variables** in `.env`:

   ```bash
   REMOTE_GATEWAY_SETUP_KEY=<the key>
   # Self-hosted NetBird: your management URL. NetBird Cloud: leave the default.
   REMOTE_GATEWAY_MANAGEMENT_URL=https://netbird.example.com:443
   ```

5. **Add the host firewall rules** (next section), then start the gateway:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.remote-access.yml up -d
   ```

6. **Check the status** on Settings → Remote Access: the gateway is online, guacd is reachable, and
   no warning about domain routes or extra reach is shown.
7. **Reverse proxy.** The session runs over a WebSocket at `/api/remote-access/tunnel`. Traefik and
   Caddy pass WebSockets through by default. nginx needs the `Upgrade` and `Connection` headers:

   ```nginx
   location /api/remote-access/tunnel {
       proxy_pass http://netbird-control:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_read_timeout 1h;
   }
   ```

   The one-time token travels in the tunnel URL. It is valid for 30 seconds and a single use, but
   avoid logging query strings for this path in the reverse proxy.

## Host firewall rules (required)

`docker-compose.yml` cannot enforce these. They keep the gateway from reaching anything except
through NetBird. Replace `10.0.0.0/8` with your internal ranges (one rule per range).

```bash
# 1. The gateway's way out may not reach internal addresses directly - only through NetBird.
iptables -I DOCKER-USER -s 172.31.251.0/24 -d 10.0.0.0/8 -j DROP
# 2. The gateway may not open connections to the app or anything else on the internal network
#    (replies to the app's connections to guacd are still allowed).
iptables -I DOCKER-USER -s 172.31.250.2 -m conntrack --ctstate NEW -j DROP
# 3. The gateway may not reach the Docker host itself.
iptables -I INPUT -s 172.31.251.0/24 -j DROP
iptables -I INPUT -s 172.31.250.2 -j DROP
```

If your NetBird management, signal or relay servers are reachable only at internal addresses, add
an `ACCEPT` rule for exactly those addresses and ports **before** rule 1, for example
`iptables -I DOCKER-USER -s 172.31.251.0/24 -d 10.0.0.20 -p tcp --dport 443 -j ACCEPT`.

These rules do not survive a reboot on their own. Save them with `iptables-persistent` or a systemd
unit, and check them after every reboot:

```bash
iptables -S DOCKER-USER
iptables -S INPUT | grep 172.31.25
```

## Verify the isolation

Run these after setup and after every reboot or gateway re-creation:

```bash
# guacd listens only on the internal address (expect 172.31.250.2:4822, never 0.0.0.0:4822).
docker exec netbird-control-remote-gateway netstat -ltn
# The gateway runs with inbound blocked and NetBird DNS off (expect both true).
docker exec netbird-control-remote-gateway sh -c 'grep -rhoE "\"(BlockInbound|DisableDNS)\": *(true|false)" /var/lib/netbird/'
# A direct connection to a LAN host fails (expect a timeout).
docker exec netbird-control-remote-gateway sh -c 'timeout 5 nc -zv 10.0.0.1 22' || echo blocked
```

From another NetBird peer, a connection to the gateway's NetBird IP on port 4822 must fail.

## Session records

Each session appears on the **Activity** page, in the same format as NetBird traffic events:
a start record and an end record that share the session id (`flow_id`). They carry the real
NetBird user, the browser's address, the server and port, and on the end record the bytes that
went through the session tunnel. These are Guacamole tunnel bytes, not RDP or SSH bytes. The
source is shown as *Browser Gateway*. NetBird's own traffic events for the gateway peer are
stored as usual.

When the app restarts during a session, the session is closed on start-up and its end record says
that the real end time is unknown.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Enable Browser Remote Access | Off | Turning it off closes every session and disables the gateway policy. |
| Who Can Use It | Permission only | Or every signed-in user. Either way, each user reaches only what their access allows. |
| Networks Open To The Gateway | None | IPv4 host and subnet resources of these networks become gateway targets. |
| Sessions Per User / In Total | 2 / 20 | Sessions that are still opening count too. |
| Idle Timeout | 30 minutes | No keyboard or mouse input. |
| Maximum Session Length | 8 hours | |
| Allow Clipboard | On | Text only. File transfer is always off. |
| guacd Address / Port | `remote-gateway` / 4822 | The gateway container as the app reaches it. |
| SSH Host Keys | None | Per IPv4 address; enforced when present. |

The gateway's NetBird object ids are account-specific, so they are not part of the settings
export.
