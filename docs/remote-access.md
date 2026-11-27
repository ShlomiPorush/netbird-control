# Browser Remote Access (RDP, SSH and Web)

Users open RDP and SSH sessions from the browser, on the **Remote Access** page, and a remote web
browser for public websites (see [Web sessions](#web-sessions-remote-browser)). The page opens
on its own, without the portal's menu: only **Back To Portal**, the theme switch and the account
menu stay above the connection form. They need no
NetBird client on their device, and the servers need no NetBird client either: sessions reach
Network resources through their routing peers, like any other NetBird traffic.

A user can connect only to a server that their own NetBird access already reaches, on a port
their policies already open. Remote Access never grants new access. The posture checks of those
policies are not applied to browser sessions (see [Who may connect where](#who-may-connect-where), item 5).

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
    routes to the IPv4 host and subnet resources that sessions opened (see
    [Opening servers to the gateways](#opening-servers-to-the-gateways)).
  - **The names gateway** is optional (compose profile `remote-names`). It serves host names of
    NetBird **domain resources**, such as `server.example.com`. NetBird DNS is on, and it receives
    only the domain resources that sessions opened, so it reaches them the same way any
    NetBird client does: the name resolves through the resource's routing peer, which also routes
    the traffic.
- **NetBird sees every browser session as traffic from a gateway peer**, not from the user.
  So NetBird Control decides who may connect where, for every session.
- **One standing policy per gateway** that the app manages (*Browser Gateway* and
  *Browser Gateway Names*) lets each gateway reach the members of its target group:
  *Browser Gateway Targets* holds IPv4 host and subnet resources, and *Browser Gateway Name Targets*
  holds exact domain resources (never a wildcard such as `*.example.com`). The networks an
  administrator selects only say which resources **may** become targets. A resource joins its
  target group only when a user who may reach it opens a session to it, and leaves it some hours
  later (see [Opening servers to the gateways](#opening-servers-to-the-gateways)). No temporary
  policies are created per session.
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
  resource: groups sent for a resource are ignored for those. A resource write never adds a target
  group. It keeps one the resource has only while the resource's network is selected and the write
  doesn't change its address, so a new address or a closed network takes it off in the same write
  (an expired hold is left to the target sync). A new resource, and the copy that a move creates,
  never gets one. No temporary grant, approved request or recurring rule can put a user into a gateway
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

## Opening servers to the gateways

A big network can have hundreds of resources, and a target group that holds all of them is
fragile. So a server joins its gateway's target group only when it is needed:

1. **The checks before a session** (the Remote Access page, and a launch link for a named user)
   write nothing to NetBird. A server is always judged as a member of its target group, whether
   it is one yet or not: the other routes the gateway receives and the drop rules to the target
   group count as they will once it is added. The gateway's standing policy must exist, be
   enabled and open the TCP port to the target group (on a read-only instance too), so a missing,
   disabled or re-pointed one refuses the session before anything is written.
2. **A session start opens the server.** The session counts toward the session limits from now on.
   The app reads the resource again first: if its network, address or type changed since the
   checks, or it is gone, nothing is written and the session is refused. Then it records a
   **hold** for the resource (its network and its address as NetBird has it, for example
   `10.0.0.0/24` or `srv.example.com`), valid for **Keep Opened Servers Available For** (10 hours
   by default) from the start; a hold for the same network and address keeps the later expiry. If
   the resource doesn't carry its target group yet, the app adds the group to the resource, in one
   write of that resource, so two sessions opening different servers at once (also on two
   instances) never undo each other.
3. **The route reaches the gateway.** NetBird needs a moment to send the new route to the gateway
   (on a real account it arrived 0.5 to 1.1 seconds after the write). The session waits until
   2 seconds after the resource was added. When the resource was already in its group but its add
   was recorded less than 30 seconds earlier (that write may still have been on its way), the
   session waits 2 seconds from when it saw the membership. The user sees this as **Opening
   Route To Server**, for RDP and SSH alike.
4. **The session is approved again** from a fresh read of NetBird: the same resource, network and
   address; the gateway has a real route to that resource, and no other route as specific or more;
   and the gateway's standing policy exists, is enabled, and has an enabled accept rule from the
   gateway group to the target group that opens the TCP port. A drop rule to the target group still counts even if the resource left its group
   meanwhile. Only then does the browser get its one-time token. Any failure ends the attempt and
   frees its place in the session limits. When this instance runs a target sync, saves the Remote
   Access settings, or sends a write of a gateway group, a resource or a network after that read,
   no token is given either; the user tries again.
5. **While a session is open**, the check every 60 seconds extends its server's hold to now plus
   the hold time (read-only instances too), so a server in use stays open. A session closes when
   the gateway has no real route to its resource any more, or the resource now has another network
   or address. Losing the target group alone doesn't close it while another policy still gives the
   gateway a route there (on a read-only instance it does: such an instance serves only members).
6. **The target sync never adds anything.** NetBird is the source of truth: the sync keeps a
   member only while its network is selected, its address still qualifies for that group, and it
   has a valid hold for its current network and address. Every other member is taken out, in one
   write per group, recorded in the audit log. When a resource changes in NetBird during the sync,
   the app reads again and writes once more; if NetBird still differs afterwards, or a write's
   answer is not a success, new sessions wait for a follow-up sync about 90 seconds later.
   The holds are read again after each group read, so a member another instance has just added
   keeps its place. Afterwards the sync deletes the holds that expired, and those whose resource is
   not in its group once they are 10 minutes old (a hold that another instance has just written,
   while its add is still on the way, stays); such a resource is not added back. The sync runs
   when the Remote Access settings are saved and every 10 minutes on the instance that runs the background jobs, **also while Remote Access is
   turned off**, so the groups drain (the policies stay disabled).

The first sync after upgrading from 1.4.x takes out, in one write per group, every resource that
1.4.x added for the selected networks: there are no holds yet. Sessions don't survive the restart,
so nothing in use is lost; the next session to a server opens it again.

Operations → Remote Access lists the servers that are open right now: **In Use** when a session of
the instance that answered uses it, otherwise until when it stays open. When NetBird can't be read,
the list is empty and the page shows the error.

A read-only instance (`NETBIRD_READONLY=true`) can't add a server to a target group. It accepts
only servers that are already members, and refuses any other with a message saying so. Otherwise
a session start runs the same steps as on any instance (the fresh read of the resource, the hold
in the database, the wait and the approval), without the NetBird write.

**Rolling back.** Roll back to 1.4.1, which puts the resources of the selected networks back into
the target groups in one write per group. The setting **Networks Open To The Gateway** keeps its
name and meaning, so 1.4.1 sees the same networks. Don't roll back to 1.4.0: it writes each
resource separately, which runs into NetBird's rate limit on large networks.

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
   matching *drop* rule refuses the session. An accept rule that reaches the resource **only**
   through a Browser Gateway target group (of this or another installation) never counts: a
   resource is in such a group only because some session opened it. A drop rule through one still
   refuses.
5. **Posture checks are not applied.** A policy with posture checks counts like any other policy,
   but its checks are not run: they run on the NetBird client, and a browser session has none. A
   policy that requires a country, an OS version or a network range therefore doesn't limit
   browser sessions.
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
again), counting only the gateway's real routes (no simulated target group), and extends the hold
of each session that passes. A session closes when the user loses access, is blocked, loses the permission (an Entra
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

## Adding a missing server

When the check refuses an address because **nothing in NetBird covers it**, a user who may edit a
network that Remote Access uses sees **Add As Resource** on the failed check. "Nothing covers it"
means:

- for an IPv4 address: no host or subnet resource in any network contains it, and no enabled legacy
  network route does. A default route (`0.0.0.0/0`, such as an exit node) and a disabled route
  don't count;
- for a host name: no domain resource matches it (exact or wildcard), no enabled legacy domain
  route lists it, and every IPv4 address the DNS returned is uncovered by the rule above. A name
  the DNS doesn't know is offered only when the names gateway is set up (its group has a gateway
  peer), since NetBird DNS answers it there. A temporary DNS failure is never offered.

The button needs a fresh, complete read of NetBird, confirmed by a read of the resources and the
routes that both answered with success (a failed answer is never read as an empty list); it never
shows on a read-only instance
(`NETBIRD_READONLY`), and it belongs to the address and port that were checked, so changing either
hides it. The suggested address is the IP address, or the host name when the names gateway is set
up (otherwise the first address it resolved to).

The button sits on the failed step, under its message. It opens one modal: first the network, when
the user may add to more than one (only networks open to Remote Access, Settings → Remote Access,
that the user may edit: `GET /api/remote-access/add-networks`), then the Networks page's own **Add
Resource** form for it. The save is the ordinary `POST /api/networks/:id/resources`,
with its permission, blocklist, duplicate and policy source checks. After the save, the page runs
the checks again and stops after **Checking Path**: it shows **Ready To Connect**, and the user
presses **Connect** to open the session.

When NetBird's answer is only partly known, the form keeps **Create** off and links to the network:

| What happened | The server answers | The form says |
|---|---|---|
| The resource was added, but an access rule was refused or answered without a rule | `RESOURCE_CREATED_POLICY_FAILED`, with the resource id | The resource was added, but its access rules weren't all saved. Open the network to finish them. |
| NetBird gave no answer, a server error (5xx), or a success without an id | `RESOURCE_UNCONFIRMED` | NetBird didn't confirm the resource was saved. Check the network before you try again. |
| The browser lost the answer (a network error, no answer within 60 seconds, or a 5xx from a proxy, such as a 504) | - | The same as the row above. |
| A definite failure (refused before any write, or a 4xx from NetBird) | `RESOURCE_CREATE_FAILED` | The error itself; **Create** stays on. |

The first case is audited as `resource.create` with the resource id, the account and
`policiesSaved: false`. The page offers nothing more for that address until a new check.

**Troubleshoot** offers the same button for a free-typed address (with or without `:port`) whose
check finds nothing in NetBird, by the same rule, for the networks the user may edit. The address
check (`GET /api/diagnostics/address`) answers `coverage: { addable }`, true only when the
resources and routes were read fresh, the address is valid as typed (a port from 1 to 65535, not
cut to the length limit) and the instance is not read-only. A host name follows the same rule as
above: found in the DNS with every address uncovered, or unknown to the DNS while the names gateway
is set up (main account only; never while managing a tenant). Unlike Remote Access, an enabled
default route (`0.0.0.0/0`, an exit node) counts here: the device reaches the address through it,
so nothing that resolves to an address is offered then. This counts only when that route is offered
to the selected device (it is in one of the route's distribution groups); a default route for other
groups doesn't block the offer.
After the save, only the address check runs again.

After any create that may have added a resource, the app drops the cached NetBird lists of the
account that was written, and for the main account the Remote Access snapshot too, so the next
check reads the new resource.

## Service status

The connect card ends with one line: **NetBird**, **Gateways** and, while web sessions are on,
**Browser**, each **Online**, **Offline** or **Unknown**, with a refresh button that turns while it
checks. Gateways is one item for the RDP and SSH gateways (the names gateway counts only when it is
set up): **Online** when every one is up, **Offline** when every one is down, **Partly Online** when
some are up. Browser is the remote browser's readiness gate.
`GET /api/remote-access/health` answers `{ netbird, gateway, namesGateway?, browserGateway? }` (each
`up`, `down` or `unknown`) and nothing else. It is refused to a user blocked in NetBird.

- **NetBird**: is NetBird reachable? One request to the main account's NetBird URL, to an API path
  that needs a sign-in, sent **without** the token. Any answer below 500 (401 included) is up: NetBird
  is reachable and answering. No answer, a timeout or a server error (5xx) is down. Online does not
  say that the app's own token is valid.
- **Each gateway**: every peer of its group is read from NetBird (up to 50, a few at a time) and its
  guacd is probed over TCP. Up when a gateway peer is connected and guacd answers; down when either
  is known to be bad; unknown when NetBird couldn't be read. A names gateway whose group can't be
  read shows as unknown when the last read had shown a gateway peer, and is left out otherwise.

The probe is direct (no retry, no cache, independent of the session checks), runs once at a time and
is kept for 15 seconds. Each part (NetBird, each gateway) has its own time limit of 9 seconds: a part
that runs out of time is down for NetBird, and unknown for a gateway (down when its guacd is known to
be down); the others keep their answers, and no peer read starts after the limit. The gateway peer
reads are ordinary signed-in NetBird reads, like every other NetBird call of the app. A change of the
NetBird URL or the gateway settings starts a new probe, and only the latest probe keeps its answer.
The page asks only when
it opens, when a check starts and when the user presses refresh, so the line never keeps an idle
sign-in alive, and the status request never refreshes the app's copy of the NetBird users and
peers: it uses the copy as it is.

## Known limits and accepted risks

- **Overlapping resources right after a server is opened.** The session waits 2 seconds after its
  server joins the target group. If the gateway already receives a less specific route that covers
  the same address (another open server's subnet, say), that route may carry the connection until
  the more specific one arrives, usually within the first second. The more specific route wins once
  it is there. The app doesn't handle such overlaps specially.
- **A session start writes the resource.** To open a server it reads the resource and writes it
  back with the target group added, like every resource write in the app. NetBird has no
  conditional write, so an edit made in NetBird in the same instant can be overwritten.
- **Two instances during an update.** While an update without downtime runs two instances side by
  side, a sync on one can take out a server the other has just opened. Its session closes at the
  next check, and the user connects again.
- **A move and a session at the same moment.** A move creates the copy, deletes the original and
  then renames the copy. A session opened to the copy in the milliseconds before that rename loses
  its target and has to connect again.

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
- **Connections go through NetBird relays.** The host isolation rules below block direct
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
  every read (Firefox) use the Clipboard panel instead, which opens right under its button in the
  session bar. Text only; file transfer is off.
- **A failed sign-in asks again.** When the server refuses the user name or password (RDP with
  Network Level Authentication, or SSH), the tab shows the sign-in form again with the user name
  kept. Signing in opens a new session to the same server, checked like any other, and the
  Activity page keeps a record of each attempt. Over RDP, a locked, disabled or expired account
  ends the session instead; SSH servers report every refused sign-in the same way, so SSH always
  asks again. SSH asks for a user name and password only; to use a private key, connect again
  from the Remote Access page. Every password field has a button that shows what was typed.
- **The session bar.** It follows the portal's light or dark theme, and so do its menus and the
  Clipboard and Files panels. It hides itself a few seconds after a session comes to the front. A click
  on its handle at the top of the screen, or the pointer resting there for half a second, brings it
  back. Pinned, it stays on top of the session; the session keeps the whole window. The NetBird
  mark at its start goes back to the portal while the sessions keep running. On a narrow screen,
  Keep The Bar Open and New Session move to the **More** menu, and so does Full Screen, except on
  a touch screen at least 400 pixels wide, where it stays in the bar. The browser's own
  right-click menu does not open anywhere on the Remote Access page or in the session view (the
  remote screen gets the right click), except in text fields such as the server address or the
  Clipboard panel's, so pasting there still works.
- **Special keys.** The **Special Keys** menu (⌘) sends key combinations that the local system
  would take for itself or that a phone has no key for. RDP: Ctrl+Alt+Del, the Windows key,
  Alt+Tab, Ctrl+Shift+Esc (Task Manager), Win+R, Win+L (locks the remote session), Alt+F4 and
  Print Screen. SSH: Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Esc and Tab. A bar menu takes the keys while
  it is open (the arrows, Enter, Space, Escape and Tab); closed, it gives them back to the session.
- **Keyboards.** The keyboard button opens the official Guacamole on-screen keyboard (US layout)
  at the bottom of the screen, with Ctrl, Alt, the Windows key, F1 to F12 and the arrows; Shift,
  Ctrl and Alt stay down until pressed again, and closing the keyboard lets go of them. While it
  is open the session uses the rest of the window, so nothing typed is hidden behind it; its keys
  take at most 40% of the window's height, and an RDP server gets the new screen size (except on
  a touch screen, where RDP keeps its size and the view follows the pointer). On a
  tablet the button also offers the **Device Keyboard**, the device's own keyboard (Guacamole's
  InputSink), which types any language (Hebrew too) as Unicode text. On a phone the button opens
  the device keyboard in one tap, and the on-screen keyboard is in **More**. Only one keyboard is
  open at a time. Most phone keyboards send a word when it is finished, not each letter.
- **Above the device keyboard.** While the device keyboard is open, the session ends where the
  keyboard starts, and a row of extra keys sits above it: Esc, Tab, Ctrl, Alt, the Windows key
  (RDP), the arrows and Del. Ctrl, Alt and Win are pressed for the next key only, from the row or
  the device keyboard, and let go right after it. RDP on a touch screen keeps its scale when a
  keyboard opens: the view scrolls so the pointer stays in sight.
- **Phones.** An RDP session from a phone asks for a desktop-sized screen at 100% scaling: 720
  pixels on the short side, in the shape of the phone's window, so a phone held upright gets a
  tall desktop (about 720x1600) and one held sideways a wide one. Turning the phone resizes the
  remote desktop. A launch link opened on a phone does the same for RDP.
- **Touch.** RDP on a touch screen has two modes, chosen in **More** and remembered by the browser.
  **Touchpad Mode**, the default on a phone, works like a laptop touchpad: moving a finger moves
  the pointer, a tap clicks, a tap with two fingers is a right click, two fingers moving up or
  down scroll, and a tap followed at once by a touch that moves drags. The **Zoom** button in the
  bar zooms in and out around the pointer (up to two screen pixels per remote pixel) and fits the
  screen again; the view follows the pointer. **Direct Touch Mode**, the default on a tablet, fits
  the whole screen: a tap is a click where the finger is, a long press is a right click, and a tap
  followed at once by a touch that moves drags. Over SSH a finger moving up or down scrolls the
  terminal's history, and a tap opens the device keyboard.
- **Add to the home screen.** Chrome's **Add to Home screen** (or **Install app**) puts the portal
  on the home screen; opened from there it runs in its own window, without the address bar.
- **Screenshot and text size.** **More → Save A Screenshot** saves the remote screen, at its full
  size, as a PNG on the user's device, once the session shows something. Over SSH, **Text Size** in
  the same menu makes the terminal text smaller or larger for that tab; a session starts at the
  size set in the settings, and a sign-in retry in the tab keeps the chosen size.
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
5. **Install the host isolation rules** ([next section](#host-isolation-rules-required)), then
   start the gateways. The command starts them only when the rules are in place:

   ```bash
   sudo /usr/local/sbin/netbird-control-gateway-isolation.sh check && docker compose -f docker-compose.yml -f netbird-docker-compose-files/docker-compose-remote-access.yml --profile remote-names up -d
   ```

   Leave out `--profile remote-names` to run without the names gateway; host names of domain
   resources are then refused.
6. **Check the status:** Settings → Remote Access shows **Gateways Online**. Operations → Remote
   Access has the details: both gateways online, both guacd reachable, and no warning.
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

   With **Transfer Files To And From Computers** on, uploads reach
   `/api/remote-access/sessions/<id>/uploads/<upload>` in parts of up to 8 MiB. The reverse proxy
   must allow request bodies of at least 1 MiB there; 8 MiB is recommended. When it refuses a part,
   the browser falls back to 1 MiB parts. nginx allows only 1 MiB by default:

   ```nginx
   location ~ ^/api/remote-access/sessions/[^/]+/uploads/ {
       proxy_pass http://netbird-control:3000;
       client_max_body_size 8m;
       proxy_request_buffering off;
   }
   ```

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
- **Connections to routing peers stay open** (`NB_LAZY_CONN=false`): the gateway opens its tunnels
  to a server's routing peers as soon as the server's route arrives, within the wait before the
  session connects. With NetBird's lazy connections, the first packet of a session would wake the
  routing peers, and NetBird could switch between a server's routing peers in the middle of that
  session's TLS handshake, so the first session to a server that was just opened failed.
- **The health check** fails when `wt0` is missing, the lock is missing, or the stored NetBird
  settings differ. guacd starts only after its gateway is healthy.
- **The peer's identity** (its NetBird private key) is kept in a Docker volume
  (`remote-gateway-state`, `remote-names-gateway-state`), never in the work tree.

guacd joins its gateway's network namespace when it starts, so it has to follow the gateway:

- **A gateway restarted:** restart its guacd. Until then guacd stays in the old namespace, its
  container is unhealthy and **Operations → Remote Access** shows "guacd Not Reachable". Both guacd
  services carry the label `autoheal=true`, so a host that runs
  [autoheal](https://github.com/willfarrell/docker-autoheal) with its default label restarts them.
  Without autoheal the label does nothing. If the gateway is still down when autoheal restarts
  guacd, guacd cannot join its network and stays stopped. Once the gateway is healthy, run
  `docker restart netbird-control-remote-guacd` (or `netbird-control-remote-names-guacd`).
- **A gateway container re-created:** re-create its guacd too.

## Host isolation rules (required)

The Compose files cannot enforce these rules. They keep the gateways from reaching anything
except through NetBird. Without them, a gateway reaches internal addresses directly through
Docker's network, where neither NetBird's policies nor NetBird Control's checks apply.

[`netbird-control-gateway-isolation.sh`](../netbird-docker-compose-files/remote-access-isolation/netbird-control-gateway-isolation.sh)
sets them, and
[`netbird-control-gateway-isolation.service`](../netbird-docker-compose-files/remote-access-isolation/netbird-control-gateway-isolation.service)
runs it at every boot before Docker starts. The rules match the gateways' own subnets, so the other
containers on the Docker host are not affected:

- **The gateways' way out** (`172.31.251.0/24`) may not reach another Docker network on the host
  (`docker0` or `br-<id>`, the bridge names Docker gives), whatever addresses it uses, or any
  private or reserved IPv4 address: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, the shared
  address space `100.64.0.0/10`, loopback, link-local, multicast and the other special-purpose
  ranges.
- **The Docker host itself** accepts nothing from the gateways, on either network.

On the internal network, guacd cannot open connections to the app: the gateway's start script
locks guacd's TCP to NetBird (see above).

The rules are in the `mangle` table, in the chains `NBC-GATEWAY-FORWARD` and `NBC-GATEWAY-INPUT`,
which are the first rules of its `FORWARD` and `INPUT` chains. These run after Docker's address
translation, so they see the address a packet is really delivered to, and neither Docker nor ufw
changes them. Each run replaces the rules of both chains in one transaction, so running the
script again is safe.

If the script fails at boot, Docker still starts, because the host may run other services. The
gateways then run without these rules, with guacd's lock in place. The failure shows in
`systemctl --failed`, and the check below reports it.

Requirements:

- **The gateways run in the Docker that systemd starts as `docker.service`**, not in rootless Docker,
  Docker Desktop or the Docker snap. The install block checks that `docker.service` runs.
- **Nothing else uses `172.31.250.0/24` or `172.31.251.0/24`**, on the host or in your networks. The
  subnets are fixed: the Compose file, these rules and the app's own target check all use them. The
  rules would block another network that has the same addresses.
- **The gateways reach NetBird and DNS at public addresses outside this host.** The rules block a
  self-hosted NetBird management, signal, relay or STUN server at an internal address or on this
  host, including one that an `ACCEPT` rule from an earlier version of this page allowed. They also
  block DNS servers at internal addresses that Docker queries from the gateway's own network. These
  are the `dns` servers in Docker's `daemon.json`, or else the host's own servers (with
  systemd-resolved, the ones in `/run/systemd/resolve/resolv.conf`). If this does not fit your
  setup, do not install these rules, and keep the ones you added by hand.
- **ufw, if used, keeps `MANAGE_BUILTINS=no`** (its default) in `/etc/default/ufw` and
  `/etc/ufw/ufw.conf`. With `yes`, a ufw reload can remove the jumps. The install block checks it.
- **Only Docker's bridges are named `br-*`.** The rules drop everything the gateways send to an
  interface named `br-*`, so if the host's own way out to the internet were named like that (such
  as `br-ex`), the gateways would lose NetBird.

What the rules do not cover:

- **Internal servers at public addresses**, such as a server that the office router publishes
  through a port forward.
- **A gateway whose NetBird process is taken over.** The gateway has `NET_ADMIN` and could change
  its own addresses. guacd, which handles the remote sessions, has no such right.
- **Docker networks with a custom bridge name** (`com.docker.network.bridge.name`) at public
  addresses.
- **A tool that loads a saved rule set or clears every table**, such as `netfilter-persistent
  reload` with a saved `mangle` table, firewalld with its `iptables` backend, or an nftables
  configuration that starts with `flush ruleset`. Do not save these rules with
  `iptables-persistent`; the unit applies them at every boot. After such a reload, run
  `systemctl restart netbird-control-gateway-isolation` and the check below.

### Install

Check the requirements above. Then copy the
`netbird-docker-compose-files/remote-access-isolation` folder to the Docker host, and in that folder
run:

```sh
sudo sh -e <<'EOF_INSTALL'
builtins=$( for f in /etc/default/ufw /etc/ufw/ufw.conf; do [ ! -f "$f" ] || . "$f"; done; echo "${MANAGE_BUILTINS:-no}" )
if [ "$builtins" = yes ]; then echo "ufw has MANAGE_BUILTINS=yes, so every ufw reload could remove the rules. Nothing was installed." >&2; exit 1; fi
if ! systemctl is-active --quiet docker.service; then echo "docker.service is not running, so the unit would not run before Docker at boot. Nothing was installed." >&2; exit 1; fi
settings() { grep -E '^(EGRESS|GATEWAYS|RANGES)=' "$1"; }
installed=/usr/local/sbin/netbird-control-gateway-isolation.sh
if [ -f "$installed" ] && [ "$(settings "$installed")" != "$(settings ./netbird-control-gateway-isolation.sh)" ]; then
  echo "The installed script has other settings than this one. EGRESS and GATEWAYS must match the subnets that the running gateways use. Set the values you need in both scripts, then run this block again. Nothing was changed. The installed settings:" >&2
  settings "$installed" >&2
  exit 1
fi
timeout 60 sh ./netbird-control-gateway-isolation.sh
put() {
  tmp=$(mktemp "$(dirname "$3")/.netbird-control-gateway-isolation.XXXXXX")
  install -m "$1" "$2" "$tmp"
  mv -f "$tmp" "$3"
}
put 0755 netbird-control-gateway-isolation.sh "$installed"
put 0644 netbird-control-gateway-isolation.service /etc/systemd/system/netbird-control-gateway-isolation.service
systemctl enable netbird-control-gateway-isolation.service
systemctl restart netbird-control-gateway-isolation.service
echo "Installed: the isolation rules are active and are applied again at every boot."
EOF_INSTALL
```

The block stops at the first error. It changes nothing when an installed script has other settings,
so an update does not replace values you adapted. It applies the rules from the copied script before
it installs anything, so a script that fails never replaces the installed one. Each file is written
under a temporary name next to its final name and then renamed in one step, so an interrupted update
leaves the previous file in place. The rules take effect right away, without restarting Docker or
the gateways.

Rules added by hand from an earlier version of this page are no longer needed. Remove each of them
with `iptables -D` and the same arguments it was added with, and remove them from
`iptables-persistent` if you saved them there.

### Check

After setup and after every reboot:

```sh
systemctl is-active netbird-control-gateway-isolation           # active
sudo /usr/local/sbin/netbird-control-gateway-isolation.sh check # OK: the isolation rules are in place
```

The check changes nothing. It compares the active rules with the script's own, and prints each
part that differs. Running the script again restores missing rules. If it still says that a chain is
not the first rule, another tool put a rule before it. Keep that rule, and move it below the jump.

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
# A direct connection from the gateway to a LAN address fails (expect "blocked"). Use an address
# and port that you know are open from the Docker host, such as another server's SSH, and that is
# not a NetBird resource open to browser access: "blocked" also appears for a closed port or a
# NetBird policy.
docker exec netbird-control-remote-gateway sh -c 'command -v nc >/dev/null || { echo "nc is missing"; exit 1; }; nc -z -w5 10.0.0.1 22 && echo OPEN || echo blocked'
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

## Web sessions (remote browser)

A **Browser** session opens a Chromium browser that runs next to the app and shows it on the
Remote Access page, in the same viewer as RDP. Users browse public websites with the normal address
bar and tabs, and the sites see the office's public address. Typical use: a customer portal that
accepts only the office's address.

### What a web session can and cannot reach

- **The public internet only.** Every private, shared (CGNAT), loopback, link-local and other
  special-purpose IPv4 range is refused, and so are the Docker networks, Docker's DNS and the NetBird
  addresses of other peers. There is no access to internal servers in this version.
- **Through the office.** The browser's own NetBird peer (the *browser gateway*) sends everything
  through a route that the app creates: `0.0.0.0/0` through the routing peers you choose in
  Settings (for example *Office Peers*), distributed only to the browser gateway's group. The route
  has its own access-control group, so the routing peers forward this traffic only for the browser
  gateway and for no other peer. The shared Exit Node route is never changed.
- **One layer protects the LAN, by design.** The routing peers can reach the office LAN. What keeps
  the browser away from it is the egress lock in the browser gateway's network namespace, installed
  before NetBird starts and checked every 10 seconds. When the lock is missing or changed, no web
  session opens and the open ones close.
- **When the route disappears, nothing leaves.** Without the route, the browser's traffic has no
  way out (it never falls back to the Docker host's own internet connection).

### Who may open one

Anyone who may use RDP and SSH: sign-in, a live and unblocked NetBird user, and the Remote Access
permission. The user's own devices and their Exit Node access play no part, because the browser goes
out through its own gateway. The check runs when the session opens and every minute after.

Each user may have one browser open at a time, and all users together five. Both limits are settings
(**Browsers Per User**, 1 to 10, and **Browsers At A Time**, 1 to 50). A disconnected browser that
still runs counts, so a user at the limit resumes it or closes it first.

A new browser opens on the **Start Page** set in the same card, or on a blank page when it is empty.
Only an `http` or `https` address without a user name or password is accepted. A resumed browser
keeps its own tabs.

**Browser Language** in the same card (English or Hebrew; default English) is the
language of a new browser's menus. Websites are asked for that language first and English second,
so a site that offers it shows it. A changed language applies to browsers opened after the change;
a resumed browser keeps the language it started with.

A new browser opens in the portal's theme at that moment, light or dark. In dark, its toolbar,
menus and file windows are dark, and websites are told the user prefers dark. A browser keeps the
theme it started with: Chromium can't change it while it runs.

### Disconnect, resume and close

- Closing the tab, refreshing the page or losing the network **disconnects** the browser: it keeps
  running, with its tabs and sign-ins, for the keep-alive time (default 15 minutes). The Remote
  Access page lists the user's open browsers with **Resume** and **Close Browser**. Only the same
  user can resume, and the access checks run again first.
- **Close Browser** ends the browser at once and wipes its profile. When the remote browser does not
  confirm that it stopped, the browser shows as **Closing...** until the app has stopped it (it tries
  again every minute). A browser also ends when the user closes its last window, when the keep-alive
  passes, or when access is lost. When NetBird can't be read to check access, the browser keeps
  running for up to 2.5 minutes after the last successful check, then ends.
- Opening the same browser in another window moves it there; the first window shows that it moved.
- **During an update** the browser view disconnects and the open browsers keep running. Resume them
  when the update finishes: web sessions are run only by the app instance that leads, so opening,
  resuming and closing a browser waits for the new instance.

### Inside the browser

- Printing, developer tools, extensions and saved passwords are blocked by Chromium's managed
  policies. Downloads, saving pages and uploads (file dialogs) are blocked too, unless **Files In
  The Browser** is on (see [Files](#files)). Websites cannot read the clipboard by themselves.
- The browser opens on a blank page.
- Self-signed certificates show Chromium's usual warning, and **Proceed** works.
- Copy and paste follow the Remote Access clipboard setting, like RDP. **Pasting Hebrew text is not
  supported yet** (guacd 1.6.0 sends VNC clipboard text as Latin-1; the fix is expected in guacd
  1.6.1). Typing Hebrew works.
- Every session runs as its own Linux users (one for the display, one for Chromium), with Chromium's
  sandbox on and no capabilities. A session cannot see another session's screen or connect to it.
- The browser container's seccomp profile, `remote-browser/seccomp.json`, is Docker's default
  profile from moby `docker-v29.8.2`, with `clone` allowed without its namespace-flag filter and
  `chroot` and `unshare` allowed, which Chromium's sandbox needs.

### Files

Two settings in **Settings → Remote Access → Remote Browser → Files**, both off by default:

- **Files In The Browser.** The browser may download files and upload them to websites through its
  file dialog. Each browser saves into a folder of its own, which no other browser can read, and the
  folder is deleted when the browser closes. The browser's file dialogs (a website's upload button,
  **Save Page As**) open in that folder, and their sidebar has a **Downloads** shortcut to it. In the session
  bar, **Files** lists the folder's files and their size, shows how much of the storage is used, and
  can delete a file. A file that is still downloading shows as *Downloading…* and cannot be deleted.
- **Transfer Files To And From Computers** (only with the first setting). The **Files** panel also
  copies a file from the browser to the user's computer (**Download**) and from the computer into the
  browser's folder (**Upload From This Computer**). An upload is sent in parts of 8 MiB, shows its
  progress, can be cancelled, and continues after a short network break while the browser runs. Only
  one upload per browser runs at a time; a new one cancels the earlier one. An upload never replaces
  a file of the same name.

Anyone who may open a web session gets these features when they are on. Turning a setting off takes
effect in open browsers within about a minute; a download that already started finishes.

**Show in folder and Open.** With **Files In The Browser** on, **Show in folder** on a download
opens a **Downloads** window over the browser, showing the browser's own folder. **Open** on a file
the browser can't show itself opens the same window with that file selected. A file can be dragged
from the window onto a website, for example onto a firmware upload area. The window only shows and
selects files: **OK** and **Cancel** close it, and the session bar's **Files** panel deletes files
and moves them to and from the computer. **Open** on a file the browser can show, such as a PDF,
shows it in a browser tab. This works only for the browser's own folder: other local files stay
blocked, and another browser's folder can't be read. Other requests to open something outside the
browser, such as a `mailto:` link, do nothing. When **Files In The Browser** is turned off,
**Show in folder** and **Open** do nothing and an open **Downloads** window closes.

**Storage Per Browser** (1 to 10 GB, default 2 GB) limits each browser's files. A single file larger
than the limit fails to download. The total is checked every 3 seconds, and a browser whose files
pass the limit, or can't be measured completely, is closed: its user sees *This browser's files
passed its N GB limit, so it was closed.* The limit is an estimate, not a hard bound: a fast
download can pass it by what arrives between two checks. A changed limit applies to browsers opened
after the change.

**Disk sizing.** The files are on the `remote-browser-files` Docker volume. The Docker host needs
about **Browsers At A Time × Storage Per Browser** free space (for example 5 × 2 GB = 10 GB). For a
hard bound, put the volume on a filesystem of its own with a fixed size (for example a host
directory on a separate partition, mounted at `/var/lib/browser-files` in the `remote-browser`
service). The app does not manage that filesystem.

**What is recorded**, in the connection records of the session, with its user:

- Each file that lands in the browser's folder (downloaded by the browser, or uploaded through the
  portal): its name and size.
- Each copy to a computer (name and size; a copy the user broke off is recorded as partly copied),
  each upload from a computer, and each delete from the Files panel, when it happens.

Recording the files that land in the folder is best-effort. The remote browser keeps the list for
10 minutes after a browser closes; entries are lost when the app or its database is down for longer
than that, or when the `remote-browser` container restarts.

**Accepted risks**

- Files a website receives through the browser's file dialog are not recorded (the connection
  records show which sites the browser reached).
- Files are not scanned for malware.
- **Save Page As** (Ctrl+S) can still write into the browser's temporary folders in memory. They are
  limited by the container's memory and wiped when the browser closes.
- A download that already started continues when the setting is turned off.
- The storage limit is an estimate (see above).

### Session and connection records

A web session has start and end records like RDP and SSH (destination *Remote Browser*). Each new
connection the browser opens is also recorded once: the destination address, port and protocol,
with the session and the user. Connections are not counted in the traffic summaries. When the
recorder misses connections (for example while the app restarts), a gap record says so.

### Set it up

1. **Settings → Remote Access → Remote Browser:** choose the routing-peer group (the office routing
   peers) and turn web sessions on. The app creates its groups, route and policies in NetBird.
2. **Create Setup Key** in the same card and put it in `.env` as
   `REMOTE_BROWSER_GATEWAY_SETUP_KEY` (one-time key, valid for one day). Keep `.env` readable by its
   owner only. A new key revokes the earlier unused ones, so only one browser gateway can enroll.
3. `.env` must also set `TAG` (the release `update.sh` installs), because the browser image follows
   the app's version.
4. Start the browser gateway and its containers together, from the folder that holds
   `docker-compose.yml` (the files `remote-browser/seccomp.json` and `remote-browser/resolv.conf` are
   read from there):

   ```bash
   docker compose -f docker-compose.yml -f netbird-docker-compose-files/docker-compose-remote-access.yml --profile remote-browser up -d
   ```

   Add `--profile remote-names` if you use the names gateway.
5. The host isolation rules (below) already cover the browser gateway (`172.31.250.4` and the
   gateways' egress network).
6. **Check the sandbox on the host.** Chromium's sandbox needs unprivileged user namespaces. If the
   host restricts them (for example Ubuntu's AppArmor setting
   `kernel.apparmor_restrict_unprivileged_userns=1`), browsers do not start and Settings shows the
   gateway as not ready.

**Settings → Remote Access → Remote Browser** shows whether the gateway is enrolled, online and
ready, and why not. Before a web session opens, the app also checks that it reaches the browser
gateway's guacd.

**Enroll the browser gateway again** (for example after its peer was deleted in NetBird): delete the
old browser gateway peer in NetBird (**Peers**), create a new setup key in the card, put it in `.env`
and start the four containers again with the command above. The card refuses a new key while the
browser gateway group still has a peer.

### Known limits

- Pasting Hebrew text does not work (see above).
- Restarting the `remote-browser` container ends every open browser.
- Re-create the browser gateway's four containers together (the command above); re-creating only
  the gateway leaves the others stopped.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Enable Browser Remote Access | Off | Turning it off closes every session and disables the gateway policies. |
| Who Can Use It | Permission only | Or every signed-in user. Either way, each user reaches only what their access allows. |
| Networks Open To The Gateway | None | Which resources may become targets: IPv4 host and subnet resources of these networks through the IP gateway, their exact domain resources through the names gateway. A resource joins its target group only when a session opens to it. |
| Keep Opened Servers Available For | 10 hours | 1 to 72. How long a server stays in its target group after a session to it starts. Each check of an open session extends it. |
| Sessions Per User / In Total | 5 / 20 | Sessions that are still opening count too. |
| Idle Timeout | 30 minutes | No keyboard or mouse input. A session in a background tab gets none. |
| Maximum Session Length | 8 hours | |
| Allow Clipboard | On | Text only. RDP and SSH file transfer is always off; web sessions have their own [file settings](#files). |
| RDP Display: Colors | 32-bit | 8, 16, 24 or 32-bit. guacd's graphics pipeline (GFX) always runs at 32-bit, so a lower depth turns it off. |
| RDP Display: Keyboard Layout | English (US) | The remote server's layout, from guacd's built-in list. Characters it doesn't have, such as Hebrew, are sent as Unicode text. |
| RDP Display: Font Smoothing | On | ClearType. |
| RDP Display: Wallpaper, Themes, Window Contents While Dragging, Desktop Composition, Menu Animations | Off | Each costs bandwidth. |
| SSH Terminal: Font Size / Colors | 12 / Gray On Black | |
| guacd Address / Port | `remote-gateway` / 4822 | The IP gateway's guacd as the app reaches it. |
| Names guacd Address / Port | `remote-names-gateway` / 4822 | The names gateway's guacd as the app reaches it. |
| SSH Host Keys | None | Per IPv4 address or host name; enforced when present. |
| Servers From Launch Links: the switch | Off | Lets launch links add a resource for a missing public server (see [Resources created by the launch API](#resources-created-by-the-launch-api)). Turn it on only after every instance runs this version. It turns on only once a network and an Access Profile are set. |
| Servers From Launch Links: Network | None | Set in the **Choose Network** window (**Create New** or **Use Existing**), changed with **Change Network** and cleared with **Stop Using This Network** in the row's menu, never by **Save** (see [Resources created by the launch API](#resources-created-by-the-launch-api)). While creating is on, or servers launch links added are still in use there, the app changes its servers no other way; it stays open to the gateway while it is set. |
| Servers From Launch Links: Who Can Reach Them | None | A Shared Access Profile. The servers join its group, and its policy decides who reaches them. Its ports must include 3389 for RDP and 22 for SSH. |
| Servers From Launch Links: Limit | 50 | Up to this many servers at a time, 1 to 500. Resources added by launch links that still exist (or may). |

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

## Resources created by the launch API

A launch request may ask the app to add a server that NetBird has no resource for
(`"createResource": true`, with the API key scope `remote-access:create-resource`), so the person
can connect without waiting for an administrator. The
[public API reference](api.md#creating-a-missing-resource-createresource) describes the request and the
answers.

**Access stays with NetBird.** In **Settings > Remote Access > Servers From Launch Links** you
choose a Shared [Access Profile](access-profiles.md), for example *CRM Users -> Linked Servers*. The
new resources join that profile's group, and the profile's policy decides who reaches them. The app
never creates or changes a policy and never grants access. A resource that a request added stays
when the link is then refused (for example, the user has no access); the answer says so with
`resourceCreated`. Posture checks of the profile apply to NetBird clients, not to browser sessions.

The profile is checked when a save chooses it or turns adding servers on. It must be a Shared
profile of the main account whose group exists in NetBird, and whose policy exists, is on, and has
an enabled accept rule to that group. The group is taken from the profile; the page never sends it.
Turning adding servers off, or changing the limit, never reads the profile or NetBird. Before every
create the profile row is read again: when it is gone, no longer Shared or has another group (a
settings import can reuse a profile id), nothing is created (`CREATE_DISABLED`). While a profile is
chosen it is in use and can't be deleted (see
[Deleting a profile](access-profiles.md#deleting-a-profile)). It can't be replaced while servers
added by launch links are in use.

**The network** is set in the same section, never by **Save**:

- **Create New** (in the **Choose Network** window) creates `Remote Access Resources (<application name>)`
  with the routing peers you choose (single peers and peer groups; masquerade on, metric 9999). The
  network is stored right after NetBird creates it, then the routing peers are added, and the page
  lists any that couldn't be. Check the Networks page before adding one again: a request without
  an answer may have been saved.
- **Use Existing** takes a network that has **no resources**. It keeps its name and routing
  peers, and the app adds none. A network with resources shows **Clear In Networks**, a link to its
  page, where selecting all rows and **Delete** clear it. Refused: a network an automation targets, a
  network that a recurring access rule, a pending access request, an auto-approval rule or a live
  temporary grant names ("Network Sales is used by recurring access for Dana. Remove it there
  first."), and a network whose routing peers include a Browser Gateway or a group that holds one.
  When it has no active routing peer, the page says so: add one in Networks.

**The app never deletes a network here.** A failure leaves what exists and says what to do. With a
network stored, **Change Network** (in the network row's menu) opens the same window and replaces
it, and **Stop Using This Network** clears it (and turns adding servers off). Both change only this
setting: nothing in NetBird is deleted or changed, and the old network stays among the networks open
to the gateway. Both are refused while servers launch links added are still in use (`409
CREATED_RESOURCES_EXIST`: kept ones can be deleted in Networks); servers of a network that was
deleted in NetBird don't count. They are audited as `remote_access.network_attach` and
`remote_access.network_release`. A read-only instance refuses both.

**Only public IPv4 addresses.** Every address in the
[IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
(private, shared, loopback, link-local, documentation, benchmarking, reserved and the others) and
multicast are refused. A host name is looked up here and used only when every IPv4 answer is
public; the resource is a host resource for the first answer (`x.x.x.x/32`), never a domain
resource. The session connects to that address and keeps the host name for the SSH host key set
for it. The blocklist applies to the address and to the name, with no override (letter case, a
trailing dot and international spelling don't matter). When a resource or an enabled legacy route
already covers the target, nothing is created. Because only public servers are added, the app
doesn't check whether a Browser Gateway can reach the group through a policy of its own: that would
expose nothing that isn't public already.

**Each create is recorded** in the `ra_created_resources` table, with a `resource.create_intent`
audit record, before NetBird is called. The table holds one active row per address, so two requests
for one server at the same moment add it once. The resource's description holds the request's id
(`Created by the Remote Access API (<id>)`). When NetBird doesn't answer clearly (no answer, a
server error, or "too many requests" to the end), the row is *unconfirmed*: the next sync adopts a
resource that carries that id only when it is exactly as asked (name, address, description, enabled,
group), and marks one that isn't *kept*. An administrator's resource at the same address is never
adopted. With no such resource after 10 minutes, the row is marked failed.

**Created resources are temporary.** The target sync on the leader instance deletes a created
resource when all of these hold:

- its hold has ended (or it never had one) and no session uses it, checked again under the target
  lock right before the delete;
- it was created more than **Keep Opened Servers Available For** ago (10 hours by default);
- a fresh read shows it exactly as it was created (the marker in the description, the name, the
  address, enabled, and its group; the Browser Gateway target group doesn't count), and no policy
  names it directly.

Only the resource is deleted: its group and the policies to the group stay. The audit log records
`resource.delete` by *Remote Access*, or `resource.delete_unconfirmed` when NetBird didn't answer
clearly; the next sync tries again. A resource that someone changed, that a policy names, or that
NetBird refused to delete is marked *kept* (`resource.kept`) and never deleted by the app. One that
is no longer in NetBird is marked *gone*. At most 20 resources are deleted per sync. Any instance may
create resources for a launch link; only the leader recovers and deletes them. A read-only instance
does neither.

**The network is managed by the app while adding servers is on.** Any network is managed while servers
launch links added are still in use there (active or kept). Otherwise it is an ordinary network. Turning it on
checks the network again: no resources but the ones launch links added (else `409
NETWORK_NOT_EMPTY`, "Clear it in Networks, or choose another one"), and the same refusals as **Use
Existing**. While it is managed, every other write of the app to the resources of that network is
refused:
adding, editing, enabling or disabling, deleting, moving or merging them, deleting the network,
using them as a Reverse Proxy target, and adding them, or the network, to temporary grants, access
requests, and recurring access or auto-approval rules that are on. Request Access doesn't offer
them, and an automation can't be pointed at the network. Policies, Access Profiles and Tidy Names
work as everywhere else. Only an admin can change the network's name and description, or add and
delete its routing peers, whatever network permissions someone else has. The Networks page shows it as **Managed By Remote Access**.

The exception is an admin on the Networks pages. An admin may delete (never change) any resource
there, also one Remote Access added and still manages, one by one or selected: only that resource
is deleted, no policy that names it and no group. NetBird's confirmation finishes the row Remote
Access kept for it ("Deleted by an admin in Networks."). The confirm says when someone is connected
to the server through Remote Access (deleting it disconnects them). When NetBird refuses because a
policy still uses it, the page shows NetBird's answer; delete or change that policy first.

An admin may also delete the whole network. Adding servers is turned off first (audited as a
settings change), then the network is deleted as any other (a failure stops it, and the setting then
stays with adding servers off). Once NetBird confirms the network is deleted, the setting lets go of
it and every server row of that network is finished. The
confirm says that Remote Access uses the network, that its servers are removed and anyone using
them is disconnected, and that adding servers is turned off. Anyone else is refused. A stored
network that isn't managed at the moment is deleted like any network, and the setting lets go of it.

**Settings import and backups.** A settings import or a backup restore never turns adding servers
on. Turn it on with a save on this page, which checks the profile and the network. The internal
(encrypted) backup carries the `ra_created_resources` table; the plaintext settings export doesn't.
A restore adds the backup's rows that aren't there yet and never removes the rows tracked now.

**The list.** Operations > Remote Access lists every resource created by the API that still exists (or may),
and the latest 50 finished entries (failed, removed, gone), with a note when older ones were left
out.

**Turn it on only after every instance runs this version.** An older instance doesn't know the
network is managed and would let its pages change it.

### Accepted risks

- **Changes made directly in NetBird** in the same seconds as a create or a delete are not detected
  by that create or delete. The next sync reads the resource again and keeps one that changed.
- **Two admins who change these settings at the same moment.** The last save wins.
- **A delete and a session start at the same moment.** The session fails and the user connects again.
- **A key revoked, or adding servers turned off, while a create waits for NetBird.** The server may
  still be added. It is public and temporary, and the link is refused.
- **More requests than the limit at the same moment** may add a few servers more than the limit.
- **A Browser Gateway that reaches the group** through a policy of its own reaches every resource created
  by the API, not only the ones a session opened. They are public servers, so this exposes nothing
  that isn't public already; the app doesn't check for it.
