# Access Requests

Self-service access with a human in the loop: a (usually non-admin) user **requests** access to something, an admin **approves** it - **in-app or from the Telegram group with a button** - and approval simply creates a [Temporary Access](temporary-access.md) grant that auto-expires.

*Where:* **Request Access** (all logged-in users) and **Access Requests** (admin, with a pending-count badge). *Backed by:* the `access_requests` table + the Telegram webhook.

## Requesting (any user)

The requester uses a **typeahead** to find what they need - resources, networks, or shared access profiles - without browsing a full catalog. They add one or more targets, a **proposed duration**, and an optional **reason**, then submit. The **Request Access** page also lists their own requests with live status, and lets them cancel a pending one. When a resource has **port policies** (a policy targeting it with a specific protocol/ports), each policy also appears as its own requestable entry - e.g. one host running several services shows "Host · Veeam (TCP 9392)" next to the plain resource. Picking such an entry scopes the eventual grant to **exactly that policy's protocol/ports** (the entry is derived live from NetBird policies - nothing extra to configure).

> The typeahead (`GET /api/request-targets`) searches by name/address, requires ≥2 characters, and is capped - it is **not** filtered by the requester's current grants (they're asking for what they lack). It exposes only names of grantable items to logged-in users; a curated "requestable" set can be layered on later if needed.

**Targets are checked against the catalogue.** Only resources, networks and shared access profiles can be requested. The server takes each target's details from the same catalogue the typeahead uses, both when the request is submitted and again when it is approved (in-app, from Telegram, or by auto-approval). These details are the name shown to approvers and in the audit log, the resource's network, the profile's destination group, and the port scope. A port scope must be one of the resource's port-policy entries. The only exception is a scope that an auto-approval rule pinned on the request itself. A target or port scope that the catalogue no longer offers is rejected with "no longer offered - pick it again from search". The approver can then pick it again in the review modal or deny the request.

## Who can approve

Approving is **not** limited to full admins. An **approver** is either an admin **or** a member of a configured **Entra (Azure AD) approver group** - so you can give people the ability to approve requests **without** granting them admin. Approvers see the **Access Requests** page (with a pending-count badge) and can act on the Telegram buttons, but nothing else admin-only. Configured in **Settings → Approvals** (admin-only). Entra-group approval relies on the app's Microsoft Graph group-read permission (see [Permissions & Security](permissions-and-security.md)).

**Delegation** - to cover an approver's absence, **Settings → Approvals → Approval Delegation** grants a chosen user **time-boxed** approval rights: active from the start date through the end date (both inclusive, app time zone), then it **expires by itself** - nothing to remember to undo. To end a delegation early, remove its row and save: the delegation ends at once. A delegate gets exactly what a group approver gets (the Access Requests page and its actions), no admin rights. A delegation applies only while the delegate is an existing, unblocked NetBird user, and deleting the user removes it. Malformed entries (missing user, bad or reversed dates) are rejected server-side, and active delegations are listed in the weekly review digest so they stay visible.

## Approving

The **Access Requests** page lists pending requests (requester · targets · reason · when). **Approve** opens a duration modal **prefilled with the requested length** (adjustable) and, on confirm, calls `createTemporaryAccessGrant()` - so the outcome is a normal temporary grant that appears under **Temporary Access** and auto-expires. **Deny** records an optional reason shown back to the requester.

Every step is audited (`request.create` / `request.approve` / `request.deny` / `request.cancel`) and approving also audits `access.grant`.

## Approving from Telegram

When a request is created, the bot posts a message to the **Access requests** topic with **✅ Approve / ⛔ Deny** buttons. The flow is interactive - the buttons swap to a submenu rather than acting instantly:

- **✅ Approve** opens a **duration** submenu: *As requested (the length the user asked for)* or an override preset (1h / 4h / 8h / 1d / 3d / 1w), plus **⬅ Back**. Picking one creates the grant with that duration.
- **⛔ Deny** opens: **✍️ Deny with reason**, **⛔ Deny (no reason)**, or **⬅ Back**.
  - *Deny with reason* → the bot sends a **force-reply prompt**; the approver **replies with the reason** as a normal chat message, and that text becomes the denial reason (shown in-app and in the requester's email). This is why the webhook also subscribes to `message` updates.
  - *Deny (no reason)* → denies immediately with a generic reason.

Every press/reply:

1. Reaches the app via the **Telegram webhook** (a public endpoint, `POST /api/integrations/telegram/callback`).
2. Is authenticated two ways: the **secret token** Telegram echoes in a header (set when the webhook is registered), **and** the presser's/replier's Telegram user id must be **mapped to a system user** in the approver list. Until the webhook is registered, every press and reply is rejected (see [Telegram](telegram-notifications.md#inbound-approving-from-telegram)).
3. On a final decision the original message is **edited** to show the outcome and the button press is answered. It's idempotent - a second press or an already-decided request just re-shows the result.

The decision is **attributed to the mapped system user** - both the audit log (`request.approve` / `request.deny`) and the grant's `access.grant` record that person, not the Telegram handle. The message still shows `via: Telegram`.

### Setup (Settings → Approvals)

Everything about *who can approve and where* lives on the **Approvals** tab (admin-only):

- **In-app approvers** - one or more **Entra group Object IDs**; members can approve in the app without admin.
- **Approvals group chat ID** *(optional)* - post the buttons to a **separate group** to keep approvals out of the noisy logs group (add the bot there too; it posts to that group's default thread). Empty = the main group's *Access requests* topic (enable it on the Telegram tab).
- **Approver Telegram users** - a list mapping each approver's **Telegram user ID** (from `@userinfobot`) to a **system user**. Only mapped IDs may act on the buttons, and each approval is logged under the mapped system user. No rows = nobody can approve from Telegram.

The **webhook** registers automatically when Telegram is enabled with a bot token and a public **`BASE_URL`**; its status is shown on the tab.

## Auto-approval (skip human review)

Some requests don't need a human. In the **Auto-Approval** tab on the **Access Requests** page (admin-only) you can make matching requests **approve instantly** - the temporary grant is created the moment the request is submitted (exactly as if an approver had clicked Approve). Two mechanisms:

- **Trusted Requesters** - entries of Entra groups whose members are auto-approved for **any** target (e.g. senior staff), each entry with its **own max-duration cap**, an optional list of **blocked targets** (critical resources, networks or access profiles that always go to review; a blocked resource also covers its network and every access profile whose group contains it, and a blocked network also covers its resources and the access profiles that contain them), and an optional **network scope**: *Only These Networks* (auto-approve exclusively inside the selected networks - anything else, including profiles/groups which aren't network-bound, goes to review) or *Any Except These Networks* (the selected networks **and every resource in them** go to review). The scope covers whole-network targets and their resources alike.
- **Self-Service Resources** - rules designating **one or more** resources / networks / access profiles as self-service for chosen groups, each rule with its **own max-duration cap** and an optional **Granted Access** spec. Both tables are managed with pickers (no raw IDs); adding/removing a row saves immediately.

Details:

- **Evaluation is per target.** A request from a user in Entra groups `G` auto-approves a target `T` when `G` intersects a trusted entry's groups (and `T` isn't blocked by that entry - neither listed, nor containing or inside a blocked resource or network), **or** a rule containing `T` lists a group in `G`. When several entries match, the **most permissive cap wins** (no-cap beats any number). A blocked target can still auto-approve if a self-service rule explicitly allows it - the rule is the more specific, deliberate grant.
- **Split.** If a request mixes qualifying and non-qualifying targets, the qualifying ones are **auto-approved** and the rest become a **separate pending request** for normal review - both show up under *My Requests*. Auto targets with different effective durations are granted separately, so each rule's cap is honored.
- **Duration.** The requester's proposed duration is honored, clamped by the matching entry's/rule's cap (blank cap = as requested).
- **Granted Access (per rule).** By default the grant mirrors each target's **existing** policy exposure (and a target with no policies gets full access). A rule can instead pin **exactly** what opens: TCP ports, UDP ports, and/or ICMP (ping) - empty port list = every port of that protocol. Behind the scenes each protocol becomes its **own temporary policy**, since a NetBird rule can't mix TCP/UDP/ICMP. When several matching entries disagree, the most permissive wins: a matching trusted entry or a rule *without* a spec means unrestricted (mirror), otherwise the specs union (port lists merge, "all ports" beats a list, ping is sticky). Pinned ports keep the posture checks of the target's existing policies that cover them. Specs don't apply to **group** targets (those are direct memberships, not policies).
- **Attribution.** Auto-approved decisions are logged as `request.approve` by **Auto-approval** (`via: auto-approval`), the grant is audited as usual, and the requester still gets the "Access granted" email. An informational (button-less) note is posted to the Telegram approvals topic for visibility.
- **Pause without deleting.** Every trusted entry and self-service rule has an on/off switch in its row - a paused entry keeps its full configuration (groups, targets, caps, access spec) but never matches, so it can be re-enabled later with one click. Editing a paused entry does not re-enable it.
- **Safe by default.** Nothing auto-approves when the requester's groups can't be resolved (no Graph permission / open mode) or under `NETBIRD_READONLY` (grants can't be created) - such requests fall back to human review. For a trusted entry with blocked targets, the networks, resources and their groups are read from NetBird when the request is submitted; if they can't be read completely, that entry doesn't auto-approve network, resource or access-profile targets (a self-service rule that lists the exact target still does). If grant creation fails for an auto target, that portion becomes a pending request instead of being lost.

## Device bypass requests

Besides access to targets, a user can request a **bypass for their own non-compliant device** (one blocked by posture/EDR checks). The **Request Access** page lists the requester's devices that are `approval_required` with a **Request Bypass** button (reason required). Rules:

- The device must **belong to the requester** and actually need approval (both enforced server-side); one pending bypass request per device.
- **Never auto-approved** - a compliance decision always goes to a human. The requester **proposes a duration** with the same control access requests use (presets / custom / until-a-time); the approver picks the final **bypass duration** - in-app via the review modal's select (defaults to the proposal; an off-preset proposal gets its own "As Requested" entry), in Telegram via the duration submenu with an **✅ As requested** quick button. Unlimited stays approver-only (and unavailable for temporary devices). A timed bypass is **revoked automatically by the scheduler** when it lapses (audited as `peer.bypass_expire`, the requester is emailed), and the remaining time shows on the peer's compliance banner and tooltip. Unlimited = until removed manually or the device becomes compliant.
- On approval the app calls NetBird's **EDR bypass** (`POST /api/peers/{id}/edr/bypass` - the same call the official dashboard's Bypass action makes), the requester gets a "Device approved" email, and the audit records `request.approve` with `kind: device bypass`. Deny works exactly like a normal request.
- **Revoking a bypass** - three places: the Request Access page shows the requester's **Bypassed Devices** with a **Revoke Bypass** button; the Peers page row menu (⋮) offers **Revoke Bypass** on bypassed devices; and the peer's detail page has the same button under the compliance banner. Bypass state is read from NetBird's `GET /api/peers/edr/bypassed` list (the peer object itself doesn't reflect an EDR bypass) - the same source the official dashboard uses. It calls `DELETE /api/peers/{id}/edr/bypass` (admin or the device owner only, enforced server-side), the device is blocked again until it passes the checks, and the audit records `peer.bypass_revoke`. Bypassed devices also show under the Peers page's **Bypassed** filter.
- The device list is always filtered to the **requester's own devices** - also for admins and holders of the *View All Peers* [feature permission](permissions-and-security.md#feature-permissions-per-capability-grants), whose `/api/peers` response contains everyone's peers.
- **Temporary Device** - an optional checkbox on the request: when the approved bypass period ends, the scheduler **deletes the device from NetBird** (`DELETE /api/peers/{id}`) instead of just re-blocking it, so it must re-enroll to ever come back. The flag is visible to the approver everywhere (an amber note in the review modal, a `temp device` badge in the requests list, a 🗑 line in the Telegram message), and because deletion happens **on expiry**, Unlimited is not offered for such requests - in-app the option is hidden, in Telegram the ♾ button is dropped, and the server rejects a 0-duration approval regardless. The deletion is audited as `peer.temp_delete`, the requester gets a "Temporary device deleted" email, and until then the peer's compliance banner/tooltip shows *"Temporary device - deleted automatically on <date>"*. Revoking the bypass manually before expiry cancels the scheduled deletion (the device stays, just blocked again).
- **Extending a timed bypass** - a device whose bypass has an expiry gets a **Request Extension** button on the *Bypassed Devices* card (reason required, one pending request per device). The extension goes through the **same human approval**: the request is marked `bypass extension` everywhere (list badge, review modal, Telegram message - which also shows when the current bypass ends), and approval simply restarts the bypass with the newly picked duration. Extensions of a temporary device **inherit the temp flag** (it will still be deleted when the extended period ends - the requester can't drop it, and Unlimited stays unavailable). An unlimited bypass has nothing to extend, so it never offers the button. If a temporary device is deleted while its extension request is still pending, the scheduler **auto-expires the request** with a "device was deleted" note so it doesn't hang in the approvers' queue.

## Adjusting targets at approval

The approver decides **what** is actually granted, not just for how long:

- **In-app** - the review modal's *Granted Targets* field is prefilled with the request and fully editable: remove any target, or add others via the same typeahead. Added targets are marked, removed ones are listed in an amber note, and at least one target must remain (otherwise deny).
- **Telegram** - multi-target requests get an **🎯 Edit Targets** button in the Approve submenu: each target is a ✅/❌ toggle, then *Approve Selected* continues to the duration picker. Backing out to the main menu resets the toggles (adding new targets needs search, so that part is in-app only).
- The grant, the outcome message and the audit all use the **adjusted** list; when it differs from the request, the audit records both (`targets` vs `requested`). The request keeps the original ask for history **and** stores what was actually granted - approved requests display the granted list (with a "requested but not granted" note) in both the requester's *My Requests* and the approver's detail view.
- The same applies to **duration**: on approval the request stores the minutes **actually granted** (`approved_minutes`; `0` = an unlimited device bypass), and *My Requests* shows that value - with a "Requested N min" note when the approver changed it - instead of the original ask. The Telegram message that gets edited with the outcome now also shows the **requested vs granted** duration on approvals and the **deny reason** on denials. The request also records **how** it was decided (`decided_via`: App / Telegram / Auto-approval) - the approver's table shows a Type column (Access / Bypass) with a matching filter and a For column (granted vs requested duration), and the request detail popup shows the granted duration and the decision channel.

## Reminders & auto-expiry

Both are configured in **Settings → Security** (0 disables either step):

- A request still pending after the **reminder threshold** (default 30 minutes) gets **one Telegram reminder**, threaded as a reply to the original approval message.
- A request nobody decided within the **expiry threshold** (default 24 hours) is **expired by the scheduler**: the requester is emailed, the Telegram message's buttons are replaced with the outcome, and the audit records `request.expire`.

## Lifecycle & states

`pending → approved` (grant created) · `denied` · `cancelled` (by the requester) · `expired` (requester never got a decision in time). Approved requests link to their grant; the grant's own expiry/revoke is handled by [Temporary Access](temporary-access.md).

## Telling the requester (email)

Telegram notifies the *approvers*; to close the loop with the *requester*, configure [Email Notifications (SMTP)](email-notifications.md). Then an **approval** emails the requester "access granted" (with the resources and expiry), a **denial** emails them the reason, and the grant **ending** emails them too. Without SMTP configured, no email is sent (the request status still updates in-app).

## Security & gotchas

- The callback endpoint is **public** (Telegram can't log in) but gated by the secret token **and** the Telegram-id→user mapping - a forged POST fails the secret; a press from an unmapped Telegram id is refused.
- In-app approve/deny require the **approver** role (admin or Entra approver group) and are **blocked in read-only mode** (`NETBIRD_READONLY`); a Telegram approve in read-only answers with a "cannot approve" notice. Configuring *who* the approvers are is admin-only.
- The webhook needs a **public HTTPS `BASE_URL`** (already required for SSO). A Telegram bot can have only one webhook - this uses it for `callback_query` updates.
- Approval assigns users to groups, so the NetBird API token must be **Admin/Owner** (same as Temporary Access).
