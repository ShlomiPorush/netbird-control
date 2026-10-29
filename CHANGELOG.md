# Changelog

All notable changes to NetBird Control. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project uses `MAJOR.MINOR.PATCH` versioning.

New changes go under `## [Unreleased]`. A release turns that section into `## [X.Y.Z] - YYYY-MM-DD`,
and the GitHub release for `vX.Y.Z` uses it as its notes.

---

## [Unreleased] - First public release

The first public version of NetBird Control. Versions before it were private; their history is
summarized under [Before the public release](https://github.com/shlomiporush/netbird-control/blob/main/CHANGELOG.md#before-the-public-release). The entries below are
the changes since the last private version (2.1.2).

### Added
- **Reverse Proxy - per-path access.** Each HTTP target has an **Access** setting under Optional
  Settings: Use Service Authentication, **Bypass Authentication** or **Block Access** (NetBird
  `access_action`). Targets that override the service's authentication get a badge in the editor, in
  the Targets sub-table and on the service row. A bypass shows which path opens without login and
  asks for confirmation; a bypass on `/` with no access-control rules counts as "No Protection"
  (CrowdSec **Observe** only logs, so it no longer counts as protection - Enforce does).
  NetBird's own rules are checked before saving: HTTP services only, and a NetBird-Only service
  allows Block but not Bypass. Every proxy in the cluster must run v0.81+ to enforce it.
- **Certificate posture check.** Paste one or more root or intermediate CA certificates (PEM); each
  one is parsed on the server and shown with its subject and SHA-256 fingerprint, and flagged when
  it is expired or not a CA. The policy editor's posture-check details show the same. Mobile clients
  (iOS / Android) always fail this check; management and clients need v0.81+.
- **Duplicate policy** (Policies row menu). Opens the create dialog prefilled from the source;
  nothing is saved until **Add Policy**. When the source has rules the single-rule editor can't
  reproduce exactly (several rules, a disabled or Drop rule, an SSH rule, a source resource), the
  duplicate copies those rules verbatim on the server.
- **Peer search by MAC address** (any separator style, digits-only MACs included), and a **Network Interfaces** row (IP + MAC)
  on the peer detail page - from NetBird v0.81 `network_addresses`.
- **Reject Hostname Collisions** account setting (NetBird Settings, Clients). Shown only when the
  account's NetBird exposes it. In Tenant Defaults it is **Keep Tenant Setting** / On / Off - saved
  profiles keep it unmanaged, tenants on an older NetBird are skipped and their drift row reads
  "Not Supported" instead of counting as drift.
- **CrowdSec verdicts in proxy access logs** - a CrowdSec badge (Ban / Captcha / Throttle /
  Unavailable) with an **Observe** marker when the request was only logged, read from the log
  metadata so it also shows on rows without an identified user.

### Changed
- **The image is now published as `ghcr.io/shlomiporush/nbcontrol`.** `docker-compose.yml` pulls the
  new name; update the `image:` line of an existing deployment when you upgrade.
- **The NetBird compose templates are generic.** Container names are neutral, and the reverse proxy's
  LAN egress (`proxy-egress`) is set with `PROXY_EGRESS_PARENT`, `PROXY_EGRESS_SUBNET`,
  `PROXY_EGRESS_GATEWAY` and `PROXY_EGRESS_IP`. The exit-node LAN isolation rule is unchanged.
- Third-party notices are in `NOTICE`, and the flag-icons MIT license ships with the flags.

### Fixed
- **`docker-compose.yml` works with any `PORT`.** `PORT` in `.env` was also passed to the app, so any
  value other than 3000 made it listen on a port the mapping did not publish. The app now always
  listens on 3000 inside the container, and `PORT` sets only the host port.
- **Saving through the app no longer erases NetBird fields it doesn't edit.** Reverse-proxy target
  fields (e.g. a path's access action, custom options), unknown posture-check types, and policy rule
  fields (SSH authorized groups, source resource, rule descriptions) are now kept on save, rename,
  merge and move. A target is matched to its stored version by upstream host and path; when two
  stored targets are indistinguishable but differ in such fields, the save is refused with a clear
  message instead of guessing.
- **Editing a policy no longer changes rules the editor can't show.** An SSH rule (`netbird-ssh`) was
  rebuilt as allow-all, a single Drop rule as Accept, and a disabled rule was switched on. Such
  policies (and multi-rule ones) now save their name, description, status and posture checks only,
  with the rule fields shown read-only, and the server refuses a rebuild that would change them. A
  policy save also stops, with nothing written, when its current rules can't be read from NetBird.
  The same applies to the **resource editor** (it replaces a resource's policies, and now refuses -
  before saving anything - when one of them is such a policy, and sends the policy list only when it
  changed), and to **copy / paste**: a protocol the editor can't express is refused instead of being
  saved as allow-all. **Duplicate Resource** no longer copies such policies (a Drop rule came back as
  Accept) and says which ones it skipped, and when a resource is saved but its policy update fails,
  the error says so - including when the update was only partly applied.
- **Merge / Move resources** are refused, before any change, when a policy uses one of the affected
  resources as its **source** (those references are not re-pointed yet, so the policy would be left
  pointing at a deleted resource).
- **Rules with a source resource** are sent with that source only (NetBird rejects a rule carrying
  both a source resource and source groups).
- **Changing a user's groups no longer unblocks a blocked user** (or re-blocks an unblocked one). The
  user's role, groups and block state are read fresh from NetBird right before the write; if they
  can't be read, nothing is changed.
- **Policies** - Edit, Duplicate, Add and Tidy Names are shown to Tenant Support users managing a
  tenant (the server already allowed them).

### Security
- Closed the open Dependabot alerts: nodemailer 10.1.4 (a major upgrade; Node.js 20 or newer, which
  the image already uses), express 4.22.3 with body-parser 1.20.9, proxy-addr 2.0.8 and qs 6.16.2,
  joi 17.13.9, brace-expansion 5.0.12, vite 8.1.6, source-map-js 1.2.2 and postcss-selector-parser
  6.1.5. The `qs` npm override is removed, because express and body-parser now require a fixed `qs`
  themselves.
- Hardened input handling flagged by code scanning: the `/login` return address is checked against
  a fixed origin after URL normalization (paths such as `/a/..//evil.example` now go to Home), a
  backup upload must be raw file bytes, and the e-mail, Telegram subject and routing peer name checks
  run in linear time.

---

## Before the public release

The project was developed privately before its first public version. These entries were
reconstructed from that history; each one summarizes a minor cycle of the private versions (its
patch releases are rolled up), and its dates are the first and last release of that cycle. The
private version numbers are unrelated to the public ones.

### Private 2.1 - Audit Events API pull - 2026-07-29 → 2026-09-11

#### Added
- **Audit Events API pull** (opt-in, per account, Settings → Webhook). For accounts whose plan has no
  event streaming, the app polls `GET /api/events/audit` every 5 minutes and feeds the admin events
  through the same ingest path as the webhook, so the Change Audit Log, its filters and retention work
  on them unchanged. Off by default; the first run backfills existing history without notifications.
  The card shows an On / Off pill, and says so when the account's plan does not expose the endpoint.
  New endpoint: `GET`/`PUT /api/audit-pull`.

#### Fixed
- **Admin events in a managed tenant name the right person.** The initiator is looked up in the
  active tenant's users first, then in the main account, and finally from the name and email that the
  audit pull carries on the event itself.

#### Security
- Closed all open Dependabot alerts (#4): nodemailer 9.1.1, qs 6.16.0 (through an npm override),
  joi 17.13.7, brace-expansion 5.0.9, react-router 7.18.3, browserslist 4.28.9, nanoid 3.3.19 and
  baseline-browser-mapping 2.11.22.

---

### Private 2.0 - MSP multi-tenancy - 2026-07-22 → 2026-07-29

The largest cycle: the app became a full **MSP platform** where a managed customer tenant behaves
*exactly* like the main account - same pages, same synced-to-DB pipeline, same features - with every
row tenant-scoped so nothing from one tenant can surface in another. Alongside the MSP work, this
cycle added the official NetBird onboarding flows (Add Peer, Invite/Delete User), an encrypted backup
tier, an API-pull ingestion fallback, automatic EDR bypass, and a large performance pass on the log
tables.

#### Added - MSP Tenants
- **Tenants page** replicating the official NetBird Cloud MSP portal (auto-hidden on non-MSP accounts):
  create/manage customer tenants, TXT-record domain verification, per-tenant permission groups, usage
  and **Plan** columns, and a per-tenant **Readiness** checklist (`N/5` chip: domain verified, service
  user, events webhook, notifications webhook, Telegram).
- **Manage** switches the whole app onto a customer's account - every page, background job and settings
  surface operates on that tenant, framed by an orange top bar, with full DB isolation via a `tenant`
  column on every relevant table.
- **Tenant Defaults profile** (Settings → Tenant Defaults, MSP only) - an explicit admin-defined
  reference that new tenants are seeded from on creation: event-filter rules, blocklist, retention, and
  the **full official NetBird account-settings set** (peer/user approval, cloud MFA with remember-browser,
  peer session + reconnect expiration, groups propagation, JWT group sync, restrict-regular-users,
  routing-peer DNS, traffic events + kernel reporting, automatic updates, peer expose, lazy connections,
  optional DNS domain / network ranges). Curated per field, so what suits your own account never leaks
  onto customers; falls back to copying main's live config when no profile is saved.
- **Add Tenant → Initial Setup** checklist - optional, re-runnable steps that run right after creation:
  sync from defaults, provision the managed service user, configure account notifications (on by
  default) and configure activity events (off; needs a Business plan).
- **Apply Defaults + Settings Sync drift** per tenant (replace semantics) - re-seed one tenant and see
  exactly which setting differs from the profile; **Apply to All Tenants** from main pushes event-filter
  rules or the blocklist to every tenant at once.
- **Plan tab** on the tenant editor - the official Team / Business plan cards (price per user/month in
  your MSP billing currency, limits, feature list); **Upgrade** is a real billing change on your MSP
  account, behind an explicit confirmation and audited (`tenant.plan`).
- **Self-managed tenant credentials** - the app provisions a service user + 365-day token inside each
  tenant and rotates it hourly; a separate **MSP Provisioning Token** (a real admin's PAT) is used for
  provisioning and for issuing user invitations.
- **Fleet Report** tab - a one-screen snapshot of every tenant (peers total/online/offline-30d, outdated
  clients, known issues, webhook/Telegram/service-user status, last event), built entirely from the
  local DB so it is instant.
- **Weekly Digest** (Fleet Report → Digest) - a per-tenant summary to main's Telegram and/or emails on a
  chosen day/hour, disabled by default with a **Send Now** action.
- **Tenant Support** feature permission - lets a non-admin switch into tenants and manage each one like
  an admin *inside* that tenant, with no admin rights on the main account and no tenant create/delete.
- Per-tenant **Telegram** (own bot/chat/topics), with a main-account **Tenant Activity** toggle that
  mirrors managed tenants' audit + scheduler alerts into main's group, tagged per tenant.
- Per-tenant **event ingestion** - each tenant's activity-events and account-notifications webhooks
  carry the tenant id in the endpoint URL (`/api/webhook/t/<id>`), routing straight into its own rows.

#### Added - NetBird onboarding flows (official replicas)
- **Add Peer** - the official install dialog in two modes: **User Device** (Linux/Windows/macOS/iOS/
  Android, opening on your browser's OS) and **Server** (Linux/Windows/macOS/Docker with an inline
  one-off setup-key generator), exact per-OS commands + copy buttons. Empty accounts show a "Get Started
  with NetBird" screen.
- **Invite User** - invite by name + email with a role and auto-assigned groups; NetBird Cloud sends the
  email. Sent as the provisioning token's real user (NetBird refuses service-user invitations), with a
  **Resend Invitation** action and per-account **Save Selection As Default** for the groups.
- **Delete User** - row action + detail-page button, with the official "also removes their devices"
  warning; the owner, your own account and the app's service user are never deletable.
- **Create Group** - the official Create Group dialog; plus a **Refresh** button on the Users & Groups page.

#### Added - Ingestion, backup, security
- **Traffic Events API pull** (opt-in, per account) - for plans without event streaming, polls
  `GET /api/events/network-traffic` every 5 minutes and stores flows exactly like streamed events, so
  every Activity view/filter/retention rule works on them unchanged. Off by default.
- **Internal encrypted backup** (Tier 2) - a complete backup (all config **plus every secret**) written
  to a mounted folder on a daily schedule and **envelope-encrypted**: a server-held public key encrypts
  each backup, but only the admin **passphrase** (set in the UI, never in env) can decrypt it - the
  server cannot open its own backups. The settings export (Tier 1) also grew to include the
  app-configuration tables across all tenants (filter rules, blocklist, automations, recurring access,
  access profiles + defaults, network grants, templates, cleanup ignores) and stays secret-free.
- **Automatic EDR bypass by OS** (Settings → Security, off by default, per account) - devices that can
  never run the EDR agent are bypassed automatically per platform, timed or unlimited, using the exact
  same mechanism/bookkeeping as a manual bypass (unlimited ones enter recertification). Capped at 25
  devices/sync, audited and Telegram-alerted; explicitly revoking one excludes that device permanently.
- **One-click "Configure In NetBird Automatically"** on both webhook cards - creates/updates the NetBird
  event-streaming integration and the account-notifications channel for the current account.

#### Changed
- **Log-table performance** - big log tables are now indexed on `(tenant, timestamp DESC)`, built after
  boot and `CONCURRENTLY` (no boot delay, no write lock); paginated lists cap the count at `50,000+`
  so a page load never pays for a full count. The Activity default window is now the last 7 days.
- **Branded log loading** - the log pages show an animated network panel with an estimated progress
  percentage, plus a slim top-of-window progress bar during heavy queries (both light/dark and
  reduced-motion aware).
- **Peers Online** dashboard tile deep-links to the Peers page pre-filtered to online devices;
  breadcrumbs added to the Users & Groups, Admin and Reverse Proxy pages.
- The tenant-mode indicator became an orange tint on the top bar (no extra banner), account switching
  hard-reloads for an atomic switch, and the Tenants row actions collapsed into a `⋯` menu to keep the
  table from scrolling horizontally.

#### Fixed
- Cross-tenant data-isolation audit fixes (the largest: tenant NetBird notices were being stored under
  the main account; several user/group/peer read paths were reading the main account in tenant mode).
- Migration safety: PK rebuilds on large event tables are now atomic and self-healing; a scheduler-side
  honored-switch guard stops a tokenless tenant from mirroring main's inventory; a background overlap
  guard prevents a slow job from running concurrently with itself.
- Secret-handling: the Telegram callback secret and the backup keypair are excluded from the plaintext
  export; per-tenant webhook receivers require a token; empty-token open ingestion closed.
- Scheduled backup/digest jobs now fire at the configured hour regardless of boot time (were drifting by
  the boot minute).
- Weekly Digest email field now commits a typed address on blur (was lost if you clicked Save directly).
- Tenant usage counts and the "User Not Found" detail bug both traced to the silently-ignored `?account=`
  switch - now resolved by using each tenant's own token.
- **Troubleshoot - client-version check is now per operating system.** NetBird versions its desktop
  and mobile clients on separate tracks, so an Android 0.71 was being flagged as "behind" a Windows
  0.75. The check now compares a device only against other clients of the **same** OS, and names the
  platform in the verdict.
- **Troubleshoot - the downloadable diagnostics script is offered only for Windows devices.** It is a
  Windows PowerShell script, so it is now hidden when a non-Windows device (Android, macOS, Linux, iOS)
  is selected instead of being shown to everyone.

---

### Private 1.4 - Operations & Access hubs - 2026-07-17 → 2026-07-21

#### Added
- **Troubleshoot page** (every user) - guided diagnostics: server-side device checks (connection,
  session, compliance, version, groups), browser-side network checks (management/signal reachability,
  real WebRTC STUN with triage) and an access-path analysis for a chosen resource or free-typed
  `IP:port`, with a plain-language verdict and a Request Access shortcut. Downloadable Windows
  diagnostics script for the local checks a browser can't run.
- **Cleanup page** (Operations) - report-only hygiene sweep for orphaned/ineffective policies, unused
  groups, unreachable resources and stale devices; nothing deleted automatically, findings can be
  marked Ignored (audited, excluded from the digest).
- **Outbound notifications log** (Admin → Notifications) - every email/Telegram message the app sends,
  with recipient, feature, subject and sent/failed status.
- **NetBird account notifications** - ingests NetBird's own notification webhook (routing peer
  down/deleted, IdP/EDR sync expiry, pending approvals) with its own Bearer token; forwarded to
  Telegram and shown as a self-clearing Known Issues banner on Troubleshoot and in Needs Attention.
- **Background job alerts** - Telegram alert when a scheduled job fails 3 consecutive runs, and a
  recovery notice once it succeeds (transition-only).
- **Blocklist Limit mode** - protect a range's width instead of its contents (e.g. `10.0.0.0/8` max
  `/24`).
- Two feature permissions: **Manage Reverse Proxy** and **Troubleshoot All Peers**.
- **Grantable source groups** - an admin-curated short list editors may pick as policy sources without
  seeing the full group directory.

#### Changed
- **Navigation reorganized** into an **Operations hub** (System Health, Automation, Access Profiles,
  Posture Checks, Network Access, Blocklist, Event Filtering, Cleanup) and an **Access Management hub**
  (Requests, Temporary Access, Access Review), leaving Settings to pure configuration.
- **Telegram sends go through a FIFO queue** that pauses and retries in place on rate limits (429), so
  bursts like the weekly digest are never dropped.
- **Weekly review digest** expanded with a This Week section (new devices, request outcomes,
  billed-users change) and a Hygiene section (Cleanup counters, conflicts), plus a Send Now button.
- **Admins may knowingly override a blocklist block** (warned inline, audited as `blocklist.override`);
  automations and non-admin editors are still always blocked.
- **Reverse Proxy** gained a Clusters & Domains tab and can target a Docker container by DNS name on edit.
- **Data Retention** purge now also covers reverse-proxy access logs and the outbound notifications log.

---

### Private 1.3 - Resource moves & conflict detection - 2026-07-15 → 2026-07-17

#### Added
- **Move To Network** - relocate selected resources to another network; each is recreated with its
  groups and enabled state, policies follow, and the original is removed (per-resource rollback on
  failure).
- **Merge Into One** - collapse duplicate resources sharing an identical address into a chosen survivor;
  policies re-point, group memberships combine, the rest are deleted.
- **Address-conflict detection** - when one user can reach the same address through two resources, a red
  banner names the address, the resources and the affected users with a one-click Merge fix; surfaces on
  the Networks list and in Needs Attention, and works across networks.
- **Automatic compliance-block email** - a device that fails compliance on a login attempt emails its
  owner (once per attempt) with the reason and a Request-a-Bypass button; fires only on a real-time
  login so deploys never mass-mail. Kill switch under Settings → Email.
- **Per-port-policy access requests** - each of a resource's port policies becomes its own requestable
  entry that scopes the grant to exactly that policy's protocol/ports.
- Peer detail now shows the device's SSO session expiry.

#### Changed
- Dashboard fleet tiles split peers online into **servers vs end-user devices** and show the account's
  current **billed-users** count.
- Access Requests record **how** each was decided (App / Telegram / Auto-approval); the approver table
  gains Type and For (granted vs requested) columns.
- Telegram outcome messages show requested vs granted duration on approvals and the deny reason on denials.

---

### Private 1.2 - Reverse Proxy management - 2026-07-15

A short, same-day cycle focused on reverse-proxy service management.

#### Added
- **Create Reverse Proxy services** from the app - an Add Service dialog with a searchable domain picker
  and a configurable Default Proxy Domain setting.
- **Expose Docker Container wizard** - automates the full recipe (attach routing peer, create domain
  resource, create the service) with full rollback if any step fails.
- **Manage existing services** - per-row Edit / Enable-Disable / Delete with linked network resources
  following the service, and a full tabbed editor (targets, Authentication incl. HTTP headers, Access
  Control by country/IP with CrowdSec, Advanced Settings).
- **Manage Reverse Proxy** feature permission gating all proxy writes (audited, blocked in read-only mode).

#### Changed
- Command palette now jumps to reverse-proxy services; My Requests shows the duration actually granted;
  country flags are served locally as bundled SVGs.

---

### Private 1.1 - Recertification, Reverse Proxy, Retention - 2026-07-12 → 2026-07-14

#### Added
- **Device Tags & Notes** - app-side tags and a note per device, filterable/searchable and bulk-taggable.
- **Access Recertification** - periodic (default 90-day) review rounds on a new Access Review page where
  every standing grant, permission, bypass and rule must be explicitly kept or revoked, with full
  decision context, audit trail and Past Reviews history.
- **Approval Delegation** - time-boxed approval rights to cover an approver's absence.
- **Reverse Proxy page** (NetBird Cloud) - a Services table plus an Access Logs tab that ingests
  NetBird's reverse-proxy access logs into the app's DB every 5 minutes.
- **Automation Dry Run** - a full zero-write report of what a sync would do, with per-item verdicts and
  CSV export.
- **System Health** tab, **Data Retention** (optional daily purge), and **Backup & Restore** of the whole
  configuration as JSON (secrets excluded).

#### Changed
- **One policy editor everywhere**; policy **copy/paste**, name templates and a **Tidy Names** bulk-rename.
- Blocklist bulk entry (Add From Network); auto-approval rules can pin exact ports.
- Consistent sortable/paginated tables across the app; Settings restructured into vertical tabs;
  accessible dialogs and menus throughout.

#### Fixed / Hardening
- Route-level code splitting for a fast first load; constant-time webhook-token compare + per-IP
  throttling; hardened HTTP security headers; crash-safe temporary-grant cleanup; a backend unit-test
  suite (`npm test`).

---

### Private 1.0 - Foundation - 2026-06-29 → 2026-07-09

The initial release: a self-hosted NetBird companion that ingests activity events into PostgreSQL and
adds a delegated management UI on top of the NetBird API.

#### Activity & audit
- **Webhook receiver** for NetBird Generic HTTP event streaming (traffic flows + management events) into
  PostgreSQL.
- **Activity log** with search, filters (type / protocol / date / user), flow grouping with aggregated
  RX/TX, raw-JSON inspector and pagination; plus a server-side **Summary view** (one row per
  source→destination conversation).
- **Change audit log** of every action taken through the app, with IDs resolved to names.
- **IP History** forensics - who held each NetBird IP and when, searchable at a point in time.
- **Event filtering** rules to drop noise before storage, plus a gated **purge** tool.

#### Network & access management (delegated via the NetBird API)
- Browse/manage **Networks, Peers, Users & Groups** with detail pages; create/edit/delete networks.
- **Resources** - create/edit/duplicate/enable-disable/delete, bulk delete, and duplicate/overlapping
  address blocking.
- **Access Profiles** (Shared/Direct), per-network default profiles, **Posture Checks**, per-network edit
  grants with policy-source separation, and an **Address Blocklist**.

#### Temporary access & requests
- **Temporary Access** - time-boxed least-privilege grants auto-revoked on expiry, with countdown, revoke
  and extend.
- **Access Requests** - self-service request/approve/deny, approvable in-app or from Telegram, with
  Entra-group approvers.
- **Device bypass requests**, request escalation, recurring access schedules, and auto-approval.

#### Automation, notifications, interface
- **Automation engine** - auto-provision resources from an external HTTP source with adopt/disable/delete
  lifecycle.
- **Telegram** and **Email/SMTP** notifications, anomaly alerts, and a weekly access-review digest.
- **Overview dashboard** (fleet tiles, Needs Attention, 24h traffic chart), global **⌘K** command palette,
  and a Reverse Proxy health card.

#### Auth, config & platform
- Optional **Azure AD / Entra SSO** (OIDC), **feature permissions** for non-admins, short session
  timeouts, **read-only NetBird mode**, and webhook bearer auth.
- DB-backed settings editable without redeploy, interactive **Swagger** docs at `/api/docs`, container
  healthchecks, and per-feature docs under `docs/`.
