# Permissions & Security

How the app decides **who sees what** and **who can change what**, and how it protects secrets and NetBird itself.

## Identity & admin

- **SSO (OIDC / Entra ID)** - when configured, every page requires login. See the [SSO guide](sso-entra-id.md) for the Azure app-registration + Graph permission walkthrough.
- **Admin** = the NetBird `owner`/`admin` role, **or** membership in `ADMIN_GROUP_ID` (resolved from Microsoft Graph).
- **Approver** (a scoped role, not full admin) = an admin **or** a member of a configured **Entra approver group** (Settings → Approvals). Approvers can approve/deny [Access Requests](access-requests.md) and see that page - nothing else admin-only. Like the admin group, it needs the Graph group-read permission to resolve membership.
- **Restricted users** (everyone else) see only their **own** activity and peers, and only the networks they've been **granted** edit/view access to.
- **Open mode** - if OIDC isn't configured, SSO is **disabled and the app is fully open** (everyone is admin). Only for a trusted/private network.

## Feature permissions (per-capability grants)

**Settings → Permissions** lets an admin hand out specific capabilities to non-admin **users** and/or **Entra groups** (picked from lists - no raw Object IDs), without making anyone an admin:

| Permission | What it unlocks |
|---|---|
| **View All Activity** | Traffic events of **every** user/device on the Activity page (instead of only their own), plus the user filter. |
| **View All Peers** | **All** peers on the Peers page, with the full User Devices / Servers tabs and filters. |
| **View Audit Logs** | The **Admin** page: app change audit, NetBird admin activity, statistics, IP history, and the outbound notifications log (Admin → Notifications) - which now includes a full **Preview** of each sent email / Telegram message, rendered inside a sandboxed iframe. |
| **Manage Temporary Access** | The **Temporary Access** page - create, extend, and revoke grants, including recurring rules (plus the user/group pickers it needs). |
| **Manage All Networks** | Admin-grade access to **every** network: view/edit all resources, routing peers and per-resource policies, and create/rename/delete networks. Implies seeing **all peers** (needed to pick routing peers). |
| **Manage Reverse Proxy** | The **Reverse Proxy** page (services + access logs) and creating/editing proxy services, including the Expose Docker Container wizard. |
| **Troubleshoot All Peers** | Support desk: pick **any** device on the **Troubleshoot** page and run diagnostics on it. Read-only - grants no management rights and does **not** unlock the Peers page. |
| **Tenant Support** | MSP support desk: see the tenant switcher and manage any linked tenant *like an admin - but only inside the tenant* (all in-context pages incl. Troubleshoot). No admin rights on the main account, no tenant creation/edit/deletion. See [MSP Tenants - Support users](msp-tenants.md#support-users). |

Notes:

- **Server-side enforcement** - each permission gates its API routes (403 without it); the sidebar and routes follow along in the UI. Hiding a page is cosmetic, the API check is the real guard.
- A user qualifies by being selected **directly** or via **any selected group** (group membership is resolved the same way as admin/approver groups, so the Graph group-read permission applies).
- **Admins always have every capability**; permission changes are **audited** (`Updated feature permissions`).
- Manage Temporary Access still respects **read-only mode** - grants can't be created or revoked while `NETBIRD_READONLY=true`.

## Three different "access" concepts (don't confuse them)

| Concept | Grants | Where |
|---|---|---|
| **NetBird data-plane access** | A device can *reach a resource*. Group membership + a policy. | [Access Profiles](access-profiles.md), [Temporary Access](temporary-access.md) |
| **Network Access grants** (`network_grants`) | An AD group may *edit/view a network in this app*. App permission, **not** connectivity. | Network detail → Access grants |
| **Blocklist** | Which addresses may *not be added as resources*. A guardrail. | [Blocklist](blocklist.md) |

A restricted user in an AD group that has an **edit** grant on a network can manage that network's resources in the app - but this changes nothing about their own device's connectivity.

**Who can read the access profiles, posture checks and blocklist.** Network editors need these lists when they add or edit resources and their policies. A network editor is an admin, a **Manage All Networks** holder, or a member of a group with an **edit** grant on a network that still exists. **Manage Temporary Access** holders can also read the access profiles, because shared profiles are grant targets. Every other signed-in user gets `403` from `GET /api/access-profiles`, `GET /api/posture-checks` and `GET /api/blocklist`. Managing these lists stays admin-only.

**Policy sources are a separate choice.** For each network, of the edit-granted groups you pick which are **Policy Source Groups** - only those are auto-added as sources of *new* policies created there (and offered to non-admin editors in the policy editor). An edit group left out can manage the network without its members being granted access by every new policy. Default: every edit group is a policy source (the legacy behavior).

## Session limits

Signed-in sessions are deliberately short to reduce exposure. All three limits are configured in **Settings → Security** (hours; 0 disables a limit):

| Limit | Default | Applies to |
|---|---|---|
| Idle Timeout | 1h | Everyone - signed out after this much **inactivity** (activity extends the session) |
| User Session Cap | 6h | Regular users - **absolute** cap; re-login required this long after signing in, active or not |
| Admin Session Cap | 2h | Admins, and Tenant Support users while they manage a tenant - a **stricter absolute** cap |

The absolute caps are measured from the ID token's issue time - stamped at the actual login and *not* extended by activity - so past a cap the session cookie is dropped, the API answers 401 and the app redirects to sign-in. A stolen session cookie is therefore useful for at most the remaining window, and an admin cookie for at most the admin cap. (Note: if the user's Entra session is still alive, the re-login may complete silently via SSO - the protection targets the app's own cookie, not the IdP session.)

A session that ended by the idle timeout stays ended: the same cookie is refused on every later request, also after the timeout is raised or turned off, and only a new sign-in gets back in. The app keeps the idle clock and the list of ended sessions in memory, so a restart clears both. The caps keep applying because they are measured from the login time.

## Automatic EDR bypass by OS

Some devices can **never** run the EDR agent - phones, appliance-style Linux servers - so each one lands in the compliance-blocked queue (`approval_required`) and needs an admin to click **Bypass** by hand, forever. **Settings → Security → Automatic EDR Bypass** automates that decision **per operating system**, with guardrails.

> ⚠️ **The operating system is self-reported by the client and can be spoofed.** A device that claims to be an iPhone gets whatever an `ios` rule grants. Use this only for platforms your EDR genuinely cannot support - it is a deliberate, audited trade-off, not a convenience.

- **Off by default.** `enabled: false` is the kill switch; with it off (or with no rules) nothing is ever applied.
- **Rules** are `{ os, durationDays }` over five platforms: `ios` (iOS/iPadOS), `android`, `linux`, `windows`, `macos`. One rule per platform, matched case-insensitively against the device's reported OS string. Android is tested **before** Linux, so an Android device can never fall through to a Linux rule.
- **`durationDays: null` = unlimited**, exactly like an unlimited manual bypass - it therefore **enters every access recertification round** and must be re-attested. A number (1-365) creates a **timed** bypass, revoked by the same 60-second scheduler that expires manual ones.
- **Identical mechanism to a manual bypass**: the same NetBird `POST /api/peers/<id>/edr/bypass` call and the same `bypass_expirations` row, so expiry, System Health counters, the Peers page **Bypassed** badge, the bypass-extension flow and recertification all behave exactly as before.
- **When it runs**: on every peers mirror sync, for **every account** - main and each managed tenant evaluate their own `edr_auto_bypass[:tenant]` rules against their own devices.
- **Throttle**: at most **25** devices per sync run per account, with a warning in the log - a bad rule cannot mass-bypass a fleet in one tick.
- **Read-only mode**: `NETBIRD_READONLY` does not block *configuring* the rules (app-side state), but the apply step is a NetBird write and is skipped entirely.
- **Revoke memory (the important semantic)**: when an admin **explicitly revokes** an automatically-applied bypass - on the Peers page or as an Access Review **Revoke** decision - that device is remembered per account (capped at 500) and is **never auto-bypassed again**. The automation does not fight the admin. A **timed** bypass that merely **expired** is different: the device is blocked again and the rule re-applies on the next sync (rolling renewal for as long as the rule stays on). Only an explicit human revoke is permanent.
- **Trail**: every application writes `peer.bypass_auto` to the app audit log (device, matched rule, reported OS string, duration) and sends a Telegram notice to the **Security Alerts** category. Rule changes are audited as `settings.edr_auto_bypass`.

## Access recertification

The weekly digest *shows* what's open; recertification forces a *decision*. Configured in **Settings → Security** (on by default, every 90 days; 30-365):

- A round snapshots all **standing access**: unlimited device bypasses (including ones applied by an **automatic EDR bypass** rule - the bookkeeping is identical), feature permissions (one item per user and per group, per capability), auto-approval entries (trusted-requester groups and self-service rules) and enabled recurring-access rules.
- Each item is decided on the **Access Review** page (admin-only): **Keep** attests it, **Revoke** performs the real removal - revoking a bypass blocks the device, revoking a permission/rule edits the live config, revoking a recurring rule disables it (tearing down an active window). Items whose underlying object already disappeared revoke as a no-op.
- Rounds are **due 14 days** after opening (one Telegram reminder when overdue), auto-complete when the last item is decided, and can also be opened **on demand** (e.g. before an audit). Everything is audited: `recert.open` / `recert.keep` / `recert.revoke` / `recert.complete`, with who decided what and when.
- Auto-approval items are matched by **content** at revoke time (stable, key-order-independent), so a config that changed since the round opened can't cause the wrong entry to be removed.

## Event retention

Configured in **Settings → Data Retention** (its own tab; off by default = keep forever). The window is **fully admin-controlled, in days** - when enabled, a daily scheduler purges **traffic events**, **NetBird events**, **reverse-proxy access logs** and the **outbound notifications log** older than it, deleting in batches so a large backlog never holds a long lock. The tab shows the current data volume (row counts, oldest event) and the last purge's outcome, so the decision is made with real numbers; values under 24 months (730 days) get an **advisory** compliance warning, but the admin's choice wins. Legacy month-based configs convert automatically.

- **App audit and IP history are never purged** - the trail of who changed what, and who held which IP, is kept in full.

Each purge is audited (`retention.purge`, with row counts) and its outcome also shows on **Operations → System Health**.

## System Health

**Operations → System Health** shows the app's own liveness: every background job (grant/bypass expiry, reconcile, request escalation, digests, anomaly scan, recurring access, IP-history sync, retention purge) with last run, last success, duration and the **actual error text** when one fails - a broken expiry loop is visible instead of silent. Plus: database table sizes and oldest-event dates, NetBird API connectivity (last successful call), integration status, and open-exposure counters (active grants, bypassed devices, pending requests). Refreshes every 30 seconds.

On top of the passive visibility, **background job alerts** (Settings → Security, on by default) send a Telegram 🚨 to the Security Alerts topic when a job fails **3 consecutive runs**, and a ✅ once it recovers - fired on the transition only, never per failing run, so nobody has to keep the System Health page open to notice a broken scheduler.

## HTTP hardening

Every response carries security headers (hand-rolled, dependency-free): a **Content-Security-Policy** that loads every script, style, font and image from the app's own origin only (the image bundles all of them, with no CDN or external fonts; the only other origins are the NetBird management and signal hosts, which the Troubleshoot page's reachability checks connect to), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and **HSTS** when `BASE_URL` is https. Secret comparisons (webhook token, Telegram webhook secret) are **constant-time**, and repeated failed authentication attempts against the public endpoints are throttled per IP (legitimate traffic is never rate-limited - only failures count). The two log endpoints cap `per_page` at 200 like the rest of the API.

## Protecting NetBird & secrets

- **Read-only mode** - `NETBIRD_READONLY=true` blocks **every** write to the NetBird Management API (create/update/delete of networks, resources, routers, policies, groups, posture checks, profiles, and **user invitations / resends**) and disables the **automation** + **temporary-access** schedulers. Reads and app-only data (blocklist, grants, filter rules, config) stay editable. For an instance that shares a NetBird tenant but must not change it.
- **Write-only secrets** - DB password, OIDC secret, session secret, and the **NetBird API token / webhook token / Telegram bot token** are read from the environment and **never returned to the browser**. The three tokens can alternatively be set in-app (write-only); an env value takes precedence and locks the field.
- **Backup & Restore** (Settings, admin-only, audited) - **two tiers** with opposite trust models. **Tier 1, the settings export** - export/import the whole app configuration as one JSON file, applied without a restart. It carries the `app_settings` key/values **and** the app-configuration tables (across all tenants): Event Filtering rules, Blocklist, Automations, Recurring Access, Access Profiles + per-network defaults, Network Grants, Templates and Cleanup Ignores. **Secrets are never included** - the NetBird API token, webhook/Telegram tokens, SMTP password, the Telegram callback secret, and **automation source credentials** (the auth token/header value) are stripped on export and never overwritten on import, so those must be re-entered after a restore; the file is **secret-free and safe to share**. A restore also **skips a NetBird API URL or SMTP server** (host, port, security, user) that differs from the stored one: the current value stays and the setting is listed as skipped in the restore result - change it in **Settings → NetBird API** or **Settings → Email (SMTP)** (on a new server, enter the NetBird API URL there after the restore). The restore discards any Telegram callback secret in the file and skips a Telegram config that is not a JSON object. On import each **section present in the file replaces** that table (its rows are deleted and replaced by the file's, with original ids preserved for referential integrity); a section absent from the file leaves its live table untouched; malformed rows are skipped and counted. **State and history are never exported** - events, admin/audit logs, IP history, temporary-access grants, bypasses, recertification rounds, NetBird notifications, proxy logs and automation run history stay put.
- **Internal encrypted backup** (Tier 2 - Settings, admin-only, main account only, audited) - a **complete** backup (all config **plus every secret**) written to a mounted folder (`BACKUP_DIR`) on a daily schedule, **envelope-encrypted** so that **the server cannot decrypt its own backups**. An admin sets a passphrase (min 12 chars) in the UI; from it the server derives an RSA-4096 keypair - the **public key** encrypts each backup on schedule (no passphrase needed at backup time), while the **private key is stored only passphrase-encrypted** (AES-256-GCM under scrypt), so a **restore always requires the human passphrase**. The passphrase itself is never stored in any form, and never lives in env. Each file wraps a random AES-256-GCM data key with the public key and embeds the passphrase-encrypted private key, so a **fresh server can restore from the file + passphrase alone**. A **forgotten passphrase means the backups are unreadable, by design** (a "Reset" issues a fresh keypair, after which old backups open only with the old passphrase). Restore is a **full replace** of every setting and config section across all tenants and reloads live config immediately; the restoring server keeps its **own** backup keypair rather than adopting the file's. Disabled by default (kill switch) until a passphrase and a writable folder are configured.
- **Destructive actions are extra-gated** - the [event purge](event-filtering.md) tool is limited to the `EVENT_PURGE_ADMINS` allow-list; [blocklist enforcement](blocklist.md) and [temporary-access](temporary-access.md) revoke are admin-only, audited, and blocked in read-only mode.
- **Change audit log** - every management action through the app is recorded (who did what) under *Admin*, and drives [Telegram notifications](telegram-notifications.md).

## The NetBird API token needs the right role

Several features write to NetBird as the **token's service user**, not as your dashboard login. In particular, [Temporary Access](temporary-access.md) assigns users to groups (`PUT /api/users`), which requires **user-management permission** - so the token should belong to an **Admin/Owner** service user. Group/policy/resource management also requires admin. If a write is silently ignored or 403s, check the token's role first.
