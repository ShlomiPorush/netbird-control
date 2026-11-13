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
  next to the app, from `netbird-docker-compose-files/docker-compose-remote-access.yml`, which is
  added on top of the main compose file. Without that file an existing deployment does not change.
- **There are two gateways.**
  - **The IP gateway** serves IPv4 addresses. NetBird DNS is off on it, so it receives only static
    routes to the IPv4 host and subnet resources of the selected networks.
  - **The names gateway** is optional (compose profile `remote-names`). It serves host names of
    NetBird **domain resources**, such as `server.example.com`. NetBird DNS is on, and it receives
    only the domain resources of the selected networks, so it reaches them the same way any
    NetBird client does: the name resolves through the resource's routing peer, which also routes
    the traffic.
- **NetBird sees every browser session as traffic from a gateway peer**, not from the user.
  So NetBird Control decides who may connect where, for every session.
- **One standing policy per gateway** that the app manages (*Browser Gateway* and
  *Browser Gateway Names*) lets each gateway reach its targets in the networks that an
  administrator selects. The app puts the *Browser Gateway Targets* group on the IPv4 host and
  subnet resources of those networks, and *Browser Gateway Name Targets* on their exact domain
  resources (never on a wildcard such as `*.example.com`). No temporary policies are created per
  session.
- **Every object name ends with the installation name** in parentheses, taken from the
  **Application Name** in **Settings → General**, for example
  *Browser Gateway (NetBird Control DEV)*. Two installations that share one NetBird account, such
  as production and a test instance, each get their own objects. When the Application Name
  changes, the next save on the Remote Access page (or the background reconcile within 10
  minutes) renames them. Members, resources and setup keys stay. Objects from before this naming
  are renamed the same way. The Application Name may be at most 60 characters, so the longest
  object name stays within NetBird's limit.
- **The gateway groups, their policies and the gateway peers belong to the app.** Only the app
  decides which resources carry the target groups, whoever edits, creates, moves or merges a
  resource: groups sent for a resource are ignored for those, and the app sets them by the rule
  above. No temporary grant, approved request or recurring rule can put a user into a gateway
  group. A gateway peer can't be a routing peer, and neither can a group it is in, nor *All*
  (a gateway that enrolls later joins it). Deleting a resource never deletes these groups or
  policies, and merging, moving or editing a resource never changes these policies. The Groups
  page, user invitations and setup keys can't add anyone to these groups, rename them or delete
  them, and the Groups page can't change their devices; taking a user out still works. This is
  the same for administrators, and covers the groups of every installation on the NetBird
  account.
- **Members added outside the app are removed.** Only the gateways belong in these groups. When
  someone adds a member in the NetBird dashboard or through its API, the app takes it out again:
  - a user who has one of these groups among their own groups loses it;
  - a device that a user enrolled (by signing in) is taken out of a gateway group, and its owner
    loses the group too, so their next device is not added. A gateway enrolled with a setup key
    from the Remote Access page has no user and stays. A gateway that was enrolled by signing in
    as a user is removed as well and has to be enrolled again with a setup key;
  - any device is taken out of a target group, which holds only resources.

  The app does this when it reads users or devices from NetBird anyway: when a session starts,
  every minute while sessions are open, and on its regular users and devices refresh (about every
  10 minutes). It does not poll NetBird for this, so the time until a removal is not fixed. Until
  then, the added member has the gateway policy's access through NetBird itself. Each removal is
  recorded in the audit log and shown on the Remote Access settings page. Only this installation's
  groups are cleaned up; another installation cleans up its own.

  Removing a group from a user rewrites the user in NetBird (role, groups and blocked state, read
  right before the write). If NetBird does not answer and the write lands late, after someone
  else changed the same user (for example blocked them), it can undo that change. Every user
  update the app makes has this limit; check the user in NetBird if a write timed out.
- **Sessions open as tabs** in one full-screen view. They keep running while the user moves around
  the portal, and a button brings them back. Closing the browser tab ends them.

## Who may connect where

A session opens only when **all** of these are true. Anything the check does not positively
understand is refused.

1. SSO is on, and the user is an existing NetBird user who is not blocked.
2. The user may use Remote Access: they have the **Browser Remote Access** permission
   (Settings → Permissions), or the feature is open to every signed-in user.
3. The address is one of:
   - an IPv4 address inside an enabled host or subnet resource of a network that is open to the
     gateways;
   - the exact host name of an enabled **domain resource** in such a network. Two equally good
     matches are refused. **Wildcard domain resources are never targets:** a name that only a
     wildcard covers (`*.example.com` covers names below `example.com`) is refused, because the
     user could pick any name below it and the names gateway connects to whatever that name
     resolves to. Add the exact name as a domain resource, or use the server's address. An exact
     resource still wins over a wildcard that also covers the name;
   - any other host name. The app looks it up with the server's own DNS settings, and each IPv4
     answer is checked as if the user had typed it. The first allowed address is used, and the
     session goes to that address, never to the name again.

   Some addresses are never targets, whatever the resources and policies say, typed or looked up:
   `0.0.0.0/8`, loopback `127.0.0.0/8`, link-local `169.254.0.0/16`, NetBird peers
   `100.64.0.0/10`, multicast `224.0.0.0/4`, reserved `240.0.0.0/4`, and the gateways' own Docker
   networks `172.31.250.0/24` and `172.31.251.0/24`.
4. An enabled *accept* policy rule connects one of the user's groups to that resource and opens the
   TCP port. The user's groups are their own groups, the groups of their peers, and *All*. A
   matching *drop* rule refuses the session.
5. **Policies with posture checks do not count.** A browser session cannot prove anything about
   the user's device, and the portal is reachable from the internet. Those users connect with the
   NetBird client instead.
6. A temporary grant counts only while it is active, not expired, and no revoke has started.
7. The gateway reaches the target through that resource **only**:
   - on the IP gateway, no other route is as specific, and the gateway receives no domain-based
     route;
   - on the names gateway, it receives no address routes at all, and no other domain resource or
     domain route matches the name as specifically or more.

   A rule counts toward the gateway's routes when its source is one of the gateway's groups
   (including *All*) or the gateway peer itself. A policy rule whose source the app can't read
   (for example a network resource as the source) blocks every session, and Settings → Remote
   Access names the problem.
8. The gateway peer is online, and a routing peer of the network is online. A gateway peer never
   counts as a routing peer.

Rules 1 to 7 decide who may connect; rule 8 (the path is up) is checked only when a session
opens. Every 60 seconds the app reads NetBird again and checks every open session against rules
1 to 7 (by name for a domain resource, by the address used otherwise; a name is not looked up
again). A session closes when the user loses access, is blocked, loses the permission (an Entra
group that grants it must be confirmed by a fresh Microsoft Graph lookup), when the network is
removed from the gateway, or when Remote Access is turned off. A router that goes down does not
close a session by itself: the connection simply stops working until it comes back. Sessions also
close when access cannot be verified with NetBird for 2.5 minutes, when the user's sign-in ends,
after the idle timeout, and after the maximum session length. A session that went through a
wildcard domain resource (possible before this rule existed) closes at the next check.

**After a restart, and after a resource change that NetBird did not answer,** new sessions wait:
for 90 seconds, and then until the app has synced the target groups again (about a minute and a
half after a restart). The user is told to try again in a minute. A change that NetBird did not
answer may still be applied later, and the app can't tell when, so it does not approve sessions
from what it read before. A change applied more than 90 seconds after it was sent is caught by
the next check of open sessions or the next sync.

Every check is for one user. A session that another user opened to the same server gives nobody
else access, and only the user who opened a session can keep it alive or end it. When the check
refuses a user because no policy opens the server or its port, **Request Access** opens with that
server's resource already chosen.

## Known limits and accepted risks

- **RDP server certificates are not verified.** Most internal Windows servers use self-signed
  certificates. Someone who can take over the server's address inside the network could receive
  the password the user types.
- **SSH host keys are verified only when an administrator enters one** for the server's address or
  host name (Settings → Remote Access → SSH Host Keys).
- **RDP server redirection.** An RDP server can tell the client to reconnect to another server.
  guacd follows it, and the new connection leaves from the gateway, so it is not checked against
  the user's access. It stays inside what the gateway can reach. Keep that list small.
- **Two host names that resolve to the same private address.** On the names gateway, NetBird keeps
  an address with the routing peer that claimed it first, until it is released. If two domain
  resources in two different networks resolve to the same private address, a session to the
  second name can reach the first network's server. Don't open such networks together. The same
  address configured in two networks is a resource conflict, shown in Networks and on
  Settings → Remote Access.
- **Host names the server can't look up.** A name that is not a NetBird domain resource is looked
  up with the server's own DNS settings. A name that only NetBird's DNS knows (a nameserver group)
  is refused unless the server's DNS resolves it too; users can type the address instead.
- **RDP to a looked-up name uses NTLM.** The session connects to the address, not the name, so
  Network Level Authentication cannot use Kerberos. Servers that refuse NTLM can't be reached by a
  name that is not a domain resource.
- **IPv4 only.** Peers (100.64.0.0/10 addresses) are not targets.
- **Host names of domain resources are resolved by the names gateway.** The app checks the name,
  not the address it resolves to there. That is why wildcard domain resources are refused: keep
  the DNS records of exact domain resources in hands you trust.
- **Main account only.** MSP tenants are not supported.
- **Connections go through NetBird relays.** The host firewall rules below block direct
  connections to routing peers on the local network, as for the exit nodes.
- **guacd has no authentication of its own.** It listens only on its gateway's address on an
  internal Docker network that only the app shares, and the gateways run with `--block-inbound`.
- **The app filters what the browser sends to guacd.** It passes only user input, the screen
  size, the clipboard and the sign-in values that guacd asks for (and, over SSH, the terminal's
  font and colors). The server address and port always come from the checked session, never from
  the browser. A browser message is limited to 16 KiB, which is twice the largest message the
  bundled client sends; a larger or malformed one closes the session.
- **Copy and paste.** Text copied on the remote side goes to the local clipboard, and the local
  clipboard is offered to the remote side when the session comes into use. Browsers that ask before
  every read (Firefox) use the Clipboard panel instead. Text only; file transfer is off.
- **A failed sign-in asks again.** When the server refuses the user name or password (RDP with
  Network Level Authentication, or SSH), the tab shows the sign-in form again with the user name
  kept. Signing in opens a new session to the same server, checked like any other, and the
  Activity page keeps a record of each attempt. Over RDP, a locked, disabled or expired account
  ends the session instead; SSH servers report every refused sign-in the same way, so SSH always
  asks again. SSH asks for a user name and password only; to use a private key, connect again
  from the Remote Access page. Every password field has a button that shows what was typed.
- **The session bar.** It hides itself a few seconds after a session comes to the front. A click
  on its handle at the top of the screen, or the pointer resting there for half a second, brings it
  back. Pinned, it stays, and the session moves down below it and is resized to the space left.
  Resizing needs Windows 8.1 or Windows Server 2012 R2 or later; an older server's screen is scaled
  down to fit instead.
- **Scaled screens.** The session uses the screen's real resolution and scaling (like the official
  Guacamole client), so text stays sharp at 125% or 150%. That means more pixels to send than at
  100%. A session keeps the scaling it opened with; moved to a screen with other scaling, it is
  shown larger or smaller rather than reopened.

## Set it up

1. **Turn on SSO.** Without sign-in there is no NetBird identity to check.
2. **Settings → Remote Access:** select the networks to open to the gateways, choose who can use it,
   turn on **Enable Browser Remote Access**, and save. The app creates the gateway groups and
   policies in NetBird. It uses only the objects it created and recorded: if NetBird already has
   a group or policy with one of their names that the app has no record of (for example after
   restoring settings into a new database), the save stops and says which one. Delete or rename
   it in NetBird and save again; if it was the gateway's group, enroll the gateway again with a
   new setup key afterwards. A group with that name is never taken over, even an empty one.
3. **Create the setup keys** on the same page: **Create IP Gateway Setup Key**, and
   **Create Names Gateway Setup Key** if users should connect by host name. Each is valid for one
   day and one use.
4. **Put the keys in `.env`, and keep them there.** Create `.env` with owner-only permissions if
   it does not exist yet (`install -m 600 /dev/null .env`; never overwrite an existing one):

   ```bash
   REMOTE_GATEWAY_SETUP_KEY=<the IP gateway key>
   REMOTE_NAMES_GATEWAY_SETUP_KEY=<the names gateway key>
   # Self-hosted NetBird: your management URL. NetBird Cloud: leave the default.
   REMOTE_GATEWAY_MANAGEMENT_URL=https://netbird.example.com:443
   ```

   A gateway needs its key at every start: it refuses to start without one, and NetBird uses the
   key only when the peer still has to enroll. A used key can't enroll anything else. If a
   gateway's peer is deleted in NetBird, create a new key for it.
5. **Add the host firewall rules** (next section), then start the gateways:

   ```bash
   docker compose -f docker-compose.yml -f netbird-docker-compose-files/docker-compose-remote-access.yml --profile remote-names up -d
   ```

   Leave out `--profile remote-names` to run without the names gateway; host names of domain
   resources are then refused.
6. **Check the status** on Settings → Remote Access: both gateways are online, both guacd are
   reachable, and no warning is shown.
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

## What the gateways enforce on every start

Each gateway container runs a short start script (in
`netbird-docker-compose-files/docker-compose-remote-access.yml`) before NetBird:

- **guacd's way out is locked to NetBird.** guacd runs as uid 1000 in its own container, in the
  gateway's network namespace. Its TCP connections may only leave through NetBird (`wt0`), or
  answer the app on the internal network. When a NetBird route is missing (the gateway is still
  syncing, or the target is not a resource), the connection fails instead of leaving through
  Docker's network.
- **NetBird's settings are given every time**: `netbird up --foreground-mode` with
  `--disable-dns=true` (IP gateway) or `--disable-dns=false` (names gateway) and
  `--block-inbound=true`. A setting changed later in the environment would not reach an already
  enrolled peer otherwise.
- **The health check** fails when `wt0` is missing, the lock is missing, or the stored NetBird
  settings differ. guacd starts only after its gateway is healthy.
- **The peer's identity** (its NetBird private key) is kept in a Docker volume
  (`remote-gateway-state`, `remote-names-gateway-state`), never in the work tree.

If a gateway container is re-created, re-create its guacd too: guacd joins the gateway's network
namespace when it starts.

## Host firewall rules (required)

`docker-compose.yml` cannot enforce these. They keep the gateways from reaching anything except
through NetBird. Replace `10.0.0.0/8` with your internal ranges (one rule per range).

```bash
# 1. The gateways' way out may not reach internal addresses directly - only through NetBird.
iptables -I DOCKER-USER -s 172.31.251.0/24 -d 10.0.0.0/8 -j DROP
# 2. The gateways (172.31.250.2 and .3) may not open connections to the app or anything else on
#    the internal network (replies to the app's connections to guacd are still allowed).
iptables -I DOCKER-USER -s 172.31.250.0/25 -m conntrack --ctstate NEW -j DROP
# 3. The gateways may not reach the Docker host itself.
iptables -I INPUT -s 172.31.251.0/24 -j DROP
iptables -I INPUT -s 172.31.250.0/25 -j DROP
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

Run these after setup and after every reboot or gateway re-creation. The gateways run NetBird in
the foreground, so `netbird status` is not available in them.

```bash
for gw in netbird-control-remote-gateway netbird-control-remote-names-gateway; do
  echo "== $gw"
  # guacd listens only on the internal address (172.31.250.2 or .3, port 4822), never 0.0.0.0.
  docker exec $gw netstat -ltn | grep 4822
  # Inbound is blocked; DNS is off on the IP gateway and on on the names gateway.
  docker exec $gw sh -c 'grep -rhoE "\"(BlockInbound|DisableDNS)\": *(true|false)" /var/lib/netbird/ | sort -u'
  # guacd's TCP is locked to NetBird.
  docker exec $gw iptables -S NBC_GUACD_EGRESS
done
# As guacd's user, a public address that is not a NetBird resource is refused (expect "blocked").
docker exec -u 1000 netbird-control-remote-guacd sh -c 'nc -z -w5 1.1.1.1 443 && echo OPEN || echo blocked'
docker exec -u 1000 netbird-control-remote-names-guacd sh -c 'nc -z -w5 1.1.1.1 443 && echo OPEN || echo blocked'
# A direct connection from the gateway to a LAN host fails (expect a timeout).
docker exec netbird-control-remote-gateway sh -c 'timeout 5 nc -zv 10.0.0.1 22' || echo blocked
```

From another NetBird peer, a connection to a gateway's NetBird IP on port 4822 must fail.

## Session records

Each session appears on the **Activity** page, in the same format as NetBird traffic events:
a start record and an end record that share the session id (`flow_id`). They carry the real
NetBird user, the browser's address, the server (the address used, or the host name of a domain
resource) and port, the host name the user typed, and on the end record the bytes that went
through the session tunnel. These are Guacamole tunnel bytes, not RDP or SSH bytes. The source is
shown as *Browser Gateway*. NetBird's own traffic events for the gateway peers are stored as
usual.

When the app restarts during a session, the session is closed on start-up and its end record says
that the real end time is unknown.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Enable Browser Remote Access | Off | Turning it off closes every session and disables the gateway policies. |
| Who Can Use It | Permission only | Or every signed-in user. Either way, each user reaches only what their access allows. |
| Networks Open To The Gateway | None | IPv4 host and subnet resources of these networks become IP gateway targets, and their domain resources names gateway targets. |
| Sessions Per User / In Total | 5 / 20 | Sessions that are still opening count too. |
| Idle Timeout | 30 minutes | No keyboard or mouse input. A session in a background tab gets none. |
| Maximum Session Length | 8 hours | |
| Allow Clipboard | On | Text only. File transfer is always off. |
| RDP Display: Colors | 32-bit | 8, 16, 24 or 32-bit. guacd's graphics pipeline (GFX) always runs at 32-bit, so a lower depth turns it off. |
| RDP Display: Keyboard Layout | English (US) | The remote server's layout, from guacd's built-in list. Characters it doesn't have, such as Hebrew, are sent as Unicode text. |
| RDP Display: Font Smoothing | On | ClearType. |
| RDP Display: Wallpaper, Themes, Window Contents While Dragging, Desktop Composition, Menu Animations | Off | Each costs bandwidth. |
| SSH Terminal: Font Size / Colors | 12 / Gray On Black | |
| guacd Address / Port | `remote-gateway` / 4822 | The IP gateway's guacd as the app reaches it. |
| Names guacd Address / Port | `remote-names-gateway` / 4822 | The names gateway's guacd as the app reaches it. |
| SSH Host Keys | None | Per IPv4 address or host name; enforced when present. |

The gateways' NetBird object ids are account-specific, so they are not part of the settings
export.

## Sessions opened from another system

Another system can open a session with stored credentials through
`POST /api/v1/remote-access/launch` and an API key from **Settings → API Keys**. It gets a one-time
link that expires after five minutes. The credentials stay on this server and go to guacd; the
browser never sees them. The person who opens the link goes through every check on this page, as
for a manual connection. When the request names a user by email, only that user can open the link.
When it names nobody, the first signed-in user whose access allows the target gets the session.
See the [public API reference](api.md) and the [integration guide](remote-launch-integration.md).
