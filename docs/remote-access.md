# Browser Remote Access (RDP and SSH)

Users open RDP and SSH sessions from the browser, on the **Remote Access** page. The page opens
on its own, without the portal's menu: only **Back To Portal**, the theme switch and the account
menu stay above the connection form. They need no
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

Settings → Remote Access lists the servers that are open right now: **In Use** when a session of
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

The connect card ends with one line: **NetBird** and **Browser Gateways**, each **Online**,
**Offline** or **Unknown**, with a refresh button that turns while it checks. Browser Gateways is one
item for both gateways (the names gateway counts only when it is set up): **Online** when every one
is up, **Offline** when every one is down, **Partly Online** when some are up.
`GET /api/remote-access/health` answers `{ netbird, gateway, namesGateway? }` (each `up`, `down` or
`unknown`) and nothing else. It is refused to a user blocked in NetBird.

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
  every read (Firefox) use the Clipboard panel instead, which opens right under its button in the
  session bar. Text only; file transfer is off.
- **A failed sign-in asks again.** When the server refuses the user name or password (RDP with
  Network Level Authentication, or SSH), the tab shows the sign-in form again with the user name
  kept. Signing in opens a new session to the same server, checked like any other, and the
  Activity page keeps a record of each attempt. Over RDP, a locked, disabled or expired account
  ends the session instead; SSH servers report every refused sign-in the same way, so SSH always
  asks again. SSH asks for a user name and password only; to use a private key, connect again
  from the Remote Access page. Every password field has a button that shows what was typed.
- **The session bar.** It hides itself a few seconds after a session comes to the front. A click
  on its handle at the top of the screen, or the pointer resting there for half a second, brings it
  back. Pinned, it stays on top of the session; the session keeps the whole window. The NetBird
  mark at its start goes back to the portal while the sessions keep running. On a narrow screen,
  Full Screen, Keep The Bar Open and New Session move to the **More** menu. The browser's own
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
  take at most 40% of the window's height, and an RDP server gets the new screen size. On a
  phone or a tablet the button also offers the **Device Keyboard**, the device's own keyboard
  (Guacamole's InputSink), which types any language (Hebrew too) as Unicode text. Most phone
  keyboards send a word when it is finished, not each letter; a tap on the session bar hides it.
  On a phone held upright the on-screen keyboard's keys are small.
- **Touch.** On a touch screen a tap is a click and a long press is a right click. To drag, tap,
  then touch again at once and move.
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
- **Connections to routing peers stay open** (`NB_LAZY_CONN=false`): the gateway opens its tunnels
  to a server's routing peers as soon as the server's route arrives, within the wait before the
  session connects. With NetBird's lazy connections, the first packet of a session would wake the
  routing peers, and NetBird could switch between a server's routing peers in the middle of that
  session's TLS handshake, so the first session to a server that was just opened failed.
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
| Networks Open To The Gateway | None | Which resources may become targets: IPv4 host and subnet resources of these networks through the IP gateway, their exact domain resources through the names gateway. A resource joins its target group only when a session opens to it. |
| Keep Opened Servers Available For | 10 hours | 1 to 72. How long a server stays in its target group after a session to it starts. Each check of an open session extends it. |
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
| Resources Created By Links: Turn On | Off | Lets launch links add a missing public server (see [Servers added by launch links](#servers-added-by-launch-links)). Turn it on only after every instance runs this version. |
| Resources Created By Links: Network | None | One of the networks selected above. It holds only the servers that links add, and the app changes it no other way. |
| Resources Created By Links: Group | None | An existing group, not *All* and not a Browser Gateway group. Your policy to this group decides who reaches the servers. |
| Maximum Active Created Resources | 50 | 1 to 500. Servers added by links that still exist (or may). |

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

## Servers added by launch links

A launch request may ask the app to add a server that NetBird has no resource for
(`"createResource": true`, with the API key scope `remote-access:create-resource`), so the person
can connect without waiting for an administrator. The
[public API reference](api.md#adding-a-missing-server-createresource) describes the request and the
answers.

**Access stays with NetBird.** The new resources go into one group that you choose in
**Settings > Remote Access > Resources Created By Links**, in one network that you choose there.
You make one policy for that group, for example *CRM users -> Linked Servers*, and it decides who
reaches the servers. The app never creates a policy or grants access. A resource that a request
added stays when the link is then refused (for example, the user has no access); the answer says so
with `resourceCreated`.

**Only public IPv4 addresses.** Every address in the
[IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
(private, shared, loopback, link-local, the IETF protocol assignments, documentation, AS112, AMT, the
6to4 relay anycast, benchmarking, reserved and broadcast), multicast, and the Browser Gateways' own
addresses are refused. A host name is looked up here and used only when every IPv4 answer is
public; the resource is a host resource for the first answer (`x.x.x.x/32`), never a domain
resource. The session connects to that address and keeps the host name for the SSH host key set
for it. The blocklist applies to the address and to the name, with no override; a name entry is
compared in the same form as the name (letter case, a trailing dot and international names don't
matter). When a resource or an enabled legacy route already covers the target, nothing is created.

**Each create is recorded** in the `ra_created_resources` table before NetBird is called, together
with a `resource.create_intent` audit record, in one transaction under a database lock. Two requests
can't take the last place below the maximum, or create the same address, at the same time. The create is
sent once: NetBird's "too many requests" (429) is a refusal, never sent again. Right before that
send, after the writer's own checks, under the same lock as every resource write and after any
wait for NetBird's rate limit, the key, these settings and the pause are checked again: when the
key was revoked, adding servers was turned off or paused meanwhile, nothing is sent. The resource's description holds the request's id
(`Created by a Remote Access link (<id>)`). When NetBird doesn't answer clearly, the row is
*unconfirmed*: the next sync adopts a resource that carries that id only when it is exactly as asked
(name, address, description, enabled, group), and marks one that isn't *kept*. An administrator's
resource at the same address is never adopted. With no such resource after 10 minutes, the row is
marked failed. Each change of a row is written first and then audited; an audit record that couldn't
be written is written by the next sync. Known limit: when the audit record was written but the
note that it was can't be cleared, the next sync writes it a second time.

**Created resources are temporary.** The target sync on the leader instance deletes a created
resource when all of these hold:

- its hold has ended (or it never had one), no session row uses it, and no session of this
  instance (also one still opening) uses it, checked again under the target lock right before the
  delete;
- it was created more than **Keep Opened Servers Available For** ago (10 hours by default);
- a fresh read shows it exactly as it was created (the marker in the description, the name, the
  address, enabled, and its group; the Browser Gateway target group doesn't count), and no policy
  names it directly.

Only the resource is deleted (`DELETE /api/networks/{network}/resources/{id}`): its group and the
policies to the group stay. The audit log records `resource.delete` by *Remote Access*, with the
reason *created by a launch link, hold ended*. A delete without a clear answer is read again by the
next sync. A resource that someone changed, that a policy names, or that NetBird refused to delete
is marked *kept* (recorded once as `resource.kept`) and never deleted by the app. At most 20
resources are deleted per sync. Any instance may add servers for a launch link; only the leader
recovers and deletes them. A read-only instance does neither.

**The network is managed by the app.** Every other write of the app to that network is refused with
"This network holds resources created by Remote Access links; it is managed automatically.": adding,
editing, enabling or disabling, deleting, moving or merging its resources, deleting the network,
using its resources as a Reverse Proxy target, adding them to temporary grants or access requests,
and policies that name one of its resources as source or destination (creating, editing, enabling
or duplicating one; deleting such a policy stays possible). This includes automations and the
blocklist's enforcement. A Reverse Proxy change that keeps a service's targets is refused when one
of them is such a resource. Tidy Names skips policies that name one (they are listed as skipped).
Routing peers of the network stay editable. Reading stays possible, and the
Networks page shows the network as **Managed By Remote Access Links**.

One exception: an administrator may delete (never change) a resource there that the app no longer
manages, a *kept* or *gone* one or one the app never created, with the delete button on the
network's page. Only that resource is deleted: no policy that names it and no group. When NetBird
refuses because a policy still uses it, the page shows NetBird's answer; delete or change that
policy first. While a create for that address is still unresolved (or the resource carries the
marker of a row that isn't finished), the delete waits until the next sync has resolved it. Choose a
network that holds nothing else. Neither the network nor the group can be changed while servers
added by links still exist; that check and the save run under the same database lock as a
launch's reservation, so a launch can't reserve in the old network during the change.

**The group.** The Browser Gateway must never reach the group through a policy of its own: then the
gateway could reach every server that links added, not only the ones a session opened.

- Saving with **Turn On** is refused when an enabled accept rule whose source carries gateway traffic
  (a group a gateway peer is in, *All*, or a gateway peer itself) has the group as a destination, or
  when such a rule's source can't be read.
- The app's policy editor refuses such a policy too (creating, editing, enabling or duplicating;
  a disabled policy gives no reach, so turning one off is always allowed), an Access Profile change
  that would give a gateway source reach to the group, and a temporary grant of an Access Profile
  whose group is this group.
- The group can't be one that an Access Profile uses (its group or a source): the picker leaves
  those out and the save refuses them.
- The sync runs the same check. When it fails, or when NetBird can't be read for it, adding servers
  is paused (`CREATE_PAUSED`), and Settings > Remote Access and System Health show why. A later sync
  that passes, or a save of this section that passes the check, resumes it. A save of other fields
leaves the pause as it is.

**The settings are read from the database** each time, not from the instance's memory: by the
create path, the sync, the guard and this page. Turning **Turn On** off on one instance stops adding
servers on every instance at once (the deletion of servers already added goes on), and every
instance guards the same network. The guard compares ids only: a stored network that doesn't exist
in NetBird protects nothing and blocks nothing. When the settings can't be read (a short time
limit), the guard uses the last network and group it knew, so other writes go on. The page sends
this section only when it changed; a save of other fields, and any save on a read-only instance,
leaves the stored section as it is.

**Settings import and backups.** A settings import or a backup restore never turns adding servers
on: the imported `createResources.enabled` is set to off, and while servers added by links still
exist, the stored network stays. The other fields are kept. Turn it on with a save on this page,
which runs the gateway check. The internal (encrypted) backup carries the `ra_created_resources`
table, so a restore keeps tracking the servers it lists; the plaintext settings export doesn't. A
restore always turns adding servers off, also when the backup has no Remote Access settings, and
sets the stored network and group to those of the restored rows. When those rows are in more than
one network or group, that table is not restored (the current list stays) and the restore says so.

**The list.** Settings > Remote Access lists every server added by links that still exists (or may),
and the latest 50 finished entries (failed, removed, gone), with a note when older ones were left
out.

**Turn it on only after every instance runs this version.** An older instance doesn't know the
network is managed and would let its pages change it.

### Accepted risks

- **Changes made directly in NetBird** in the same seconds as a create or a delete are not detected
  by that create or delete. The next sync reads the resource again and keeps one that changed.
- **A delete and a session start on two instances at the same moment.** The session fails and the
  user connects again.
- **A gateway added to a policy's source group through the Groups page.** The next sync detects it,
  pauses adding servers and shows why.
