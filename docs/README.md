# Documentation

In-depth docs for the app's special features - the "under the hood" mechanics that aren't obvious from the UI. For install/config/env vars see the [root README](../README.md).

## The one mental model that explains everything

Almost every feature here is built on **two NetBird primitives**:

- **Groups** - a named bucket of **peers** (devices), **resources**, and/or **users** (users are added via their *auto-assigned groups*; their devices then inherit the group).
- **Policies** - a rule `sources → destinations`, where sources/destinations are **groups** (or a policy can target a single **resource** directly via `destinationResource`). A peer can reach something only if a policy connects a group it's in (source) to the target (destination).

So **"give someone access to X"** always reduces to: *put the user (their peers) in a group, and make sure a policy connects that group to X.* Access Profiles, Temporary Access, and the blocklist are all conveniences on top of this.

Two things that look like "access" but are **not** data-plane access:
- **Network Access grants** (`network_grants`) - who may *edit a network in this app*. App-level permission, not NetBird connectivity. See [permissions](permissions-and-security.md).
- **Blocklist** - which addresses may *not be added as resources*. A guardrail, not a grant. See [blocklist](blocklist.md).

## Contents

| Doc | What it covers |
|---|---|
| [Features in detail](features.md) | The full feature reference, how to connect NetBird events, the architecture and the key endpoints. |
| [SSO and AD groups](sso-entra-id.md) | Registering the app in Entra ID, the Graph permission for group-based admin, and verifying it. |
| [Access Profiles](access-profiles.md) | Reusable "who can reach what, how" bundles (group + policy). Shared vs Direct, default profiles. |
| [Temporary Access](temporary-access.md) | Time-boxed user access to resources, auto-revoked. How each target type is wired. |
| [Access Requests](access-requests.md) | Self-service request → admin approval (in-app or via Telegram buttons), which creates a temporary grant. |
| [Address Blocklist](blocklist.md) | Addresses that may not be added as resources; enforcing the block on existing resources. |
| [Automation](automation.md) | Auto-provision NetBird resources from an external HTTP source, on a schedule. |
| [Telegram Notifications](telegram-notifications.md) | Alerts for app actions + NetBird events, routed to per-category forum topics. |
| [Email Notifications (SMTP)](email-notifications.md) | Emails users when access is approved / denied / granted / ends. SMTP via env or in-app. |
| [Event Filtering & Cleanup](event-filtering.md) | Drop noise before storage; purge already-stored noise (gated). |
| [Permissions & Security](permissions-and-security.md) | SSO, admin vs restricted, network grants, read-only mode, write-only secrets. |

## Conventions across features

- **Admin-only + audited.** Management actions require admin and are written to the change **audit log** (visible under *Admin*), which also drives Telegram.
- **Read-only mode.** `NETBIRD_READONLY=true` blocks every write to the NetBird API (and the automation + temporary-access schedulers). Reads and app-only data stay editable.
- **Write-only secrets.** The NetBird API token, webhook token, and Telegram bot token are never returned to the browser - only a `hasToken` flag. An env-provided value wins and locks the field.
- **We only touch what we created.** Automations, temporary-access grants, and blocklist-enforcement keep ledgers/ownership so they never disable, delete, or unassign something a human set up by hand.
