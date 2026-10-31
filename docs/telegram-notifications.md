# Telegram Notifications

Send alerts to Telegram for **actions taken through this app** (the change audit) and for a **selectable set of NetBird events** - each routed to its own **forum topic**.

*Where:* **Settings → Telegram**. *Backed by:* `app_settings` (config) + the audit/event write paths.

## Setup

1. Create a bot with **@BotFather**; put the token in `.env` (`TELEGRAM_BOT_TOKEN`) or in-app (write-only).
2. Add the bot to a **forum-enabled group** and set the **chat ID** in-app.
3. Enable categories and (optionally) let the app **auto-create the topics** for you.

## How routing works

Every notification has a **category**, which maps to a forum **topic** (a `message_thread_id`); if no topic is set it goes to the group's default thread.

- **App actions (audit)** - the audit action's prefix picks the category: `resource`/`router` → *resources*, `network` → *networks*, `policy` → *policies*, `peer`/`group`/`access` → *inventory*, `automation` → *automation*, everything else → *settings*.
- **NetBird events** - split into **sub-topics by kind** via a heuristic on the message text: setup keys, policies/posture, network/DNS/routes, groups, peers, users/login, or other.

You choose which categories are enabled and which NetBird event types to forward.

## Rich formatting

**Every** message - app-audit actions, NetBird events, and access-request notifications - shares one designed style (via `tgFormatFields`): a bold title with a per-category emoji, a `👤` identity line, then one field per line as `<emoji> <b>Label:</b> value`. Specifically:
- IDs are **resolved to names** - both the initiator and any `*_id` in the metadata (`group_id`, `resource_id`, `network_id`, `peer_id`, `policy_id`, `user_id`); unresolvable ids are dropped.
- Action codes become **Title-Case labels** (`access.grant` → "Granted temporary access").
- `location_*` fields fold into **one line** with the **country flag** (e.g. `🌍 Location: 🇩🇪 Berlin, Germany`), plus a `🌐 Source IP` line; geo-name-id noise is dropped.
- timestamps (`until`, `*_at`, `timestamp`, …) are formatted to the app's configured **time zone / format**.
- each field gets a fitting **emoji** (🖥 Device, 📍 IP, 🏷 Type, 👥 Group, 🎯 Targets, ⏳ Until, 📝 Reason, …); config changes show **old → new** values.

## Flow

`recordAudit()` and the NetBird-event writer call the Telegram notifier **fire-and-forget** - a Telegram outage never blocks or fails the underlying action. Notifications only send when Telegram is enabled *and* the relevant category is enabled.

## MSP: per-tenant Telegram & the main mirror

In an [MSP](msp-tenants.md) setup, Telegram is configured **per account**. The bot token, chat ID, per-category topics and event selections are stored independently for the main account and for each tenant:

- **Main** (`telegram_config` / `telegram_bot_token`, env `TELEGRAM_BOT_TOKEN` still wins) - unchanged.
- **Each tenant** (`telegram_config:<tenant>` / `telegram_bot_token:<tenant>`, settings-only - **never** env) - set it in **Settings → Telegram while managing the tenant**. A tenant gets its own bot, group, topics and event choices.

A tenant with **no config (or disabled)** simply sends nothing for its own events - it **never** falls back to main's bot.

Which account a message uses is decided by **who is acting**: the tenant's own events (its audit actions, its NetBird/webhook events, its access-review alerts) send through the **tenant's** config; a message queued in a tenant context captures that tenant's token at enqueue time, so the send is correct even after the request context is gone.

**Main mirror of tenant activity (the "Tenant Activity" toggle, main-only, default on).** So the MSP admin sees tenant activity in their own channel, an **app-audit** event in a tenant is *additionally* sent to **main's** Telegram - using main's own topics/categories and titled with a ` [tenant name]` suffix - whenever main is enabled and **Tenant Activity** is on. The same mirror covers the **access-review** scheduler alerts (opened/overdue/completed), which the MSP wants as operational alerts; the tenant's own copy carries no tag, only the main copy does.

**Boundary:** only **app-audit** events (and the access-review scheduler alerts) mirror to main. A tenant's **NetBird/webhook event notifications** and its **security/anomaly alerts** go **solely to the tenant's own Telegram** - they are never mirrored. The approvals **callback webhook** (Approve/Deny buttons) remains a **main-account** feature.

Bot tokens - main and per-tenant - are write-only secrets: never returned by the config API and excluded from settings export/backup.

## Proactive alerts & digests

Beyond mirroring events, the app sends its own messages:

All of these are configured in **Settings → Security**:

- **🚨 Anomaly alerts** (with an on/off switch): a device **switching country**, a **new device from a country the user was never seen in**, an **admin action outside working days/hours** (default Sun-Thu 06:00-22:00, app time zone), and **traffic spikes** (a device moving more than the configured multiplier × its own 7-day hourly average and above the MB floor, checked hourly). These route through the **Security alerts** category - give it its own topic (or auto-create it) under Settings → Telegram.
- **⏰ Request reminders** - a pending [access request](access-requests.md) gets one reminder (reply-threaded to its approval message) after the configured minutes.
- **📋 Weekly access review** - a digest of active grants, active bypasses, auto-approval rules, feature permissions and pending requests, sent on the configured day/hour (default Monday 08:00, app time zone) to the approvals chat - plus optional email recipients when SMTP is on.

## Inbound: approving from Telegram

The integration is not only outbound. [Access Requests](access-requests.md) post **Approve/Deny buttons**, and presses come back via a **Telegram webhook** - a public endpoint (`POST /api/integrations/telegram/callback`) registered automatically when Telegram is enabled with a bot token and a public `BASE_URL`. The webhook subscribes to both `callback_query` (button presses) and `message` updates - the latter so an approver can **reply with a denial reason**. The flow is interactive: **Approve** opens a duration submenu (keep the requested length or override it with a preset), multi-target requests add an **Edit Targets** submenu (toggle requested targets off before approving), and **Deny** offers a typed reason (via a force-reply) or none. Every action is authenticated by a **secret token** (Telegram-signed header) and checked against the **Telegram-id→system-user mapping** (Settings → Approvals → *Approver Telegram users*); the decision is logged under the mapped system user. The buttons post to the main group's *Access requests* topic by default, or to a **separate approvals group** if an *Approvals group chat ID* is set (so approvals stay out of the logs group). See [Access Requests](access-requests.md) for the full flow.

**New requirement:** the endpoint accepts updates only after this deployment has registered the webhook, which stores the secret token. Until then it rejects every update, so the buttons and denial-reason replies do nothing. A deployment can be left without a registered webhook, for example after you import settings into a new deployment (the export leaves out the secret and the bot token). To register it:

1. Make sure the server has a public HTTPS `BASE_URL`.
2. In the **main account** (not while managing a tenant), open **Settings → Telegram**, make sure a bot token is set and Telegram is enabled, and select **Save**. Restarting the server also registers the webhook when these conditions are already met.
3. Press a button on a pending request to confirm that it works. The *Webhook: registered* status on the Approvals tab means a secret is stored, not that Telegram accepted the registration. If presses still do nothing, check the server log for `setWebhook failed`, fix the cause and save again.

Telegram retries a rejected update for a limited time only, so presses made before the webhook was registered may be lost. Press the button again.

## Gotchas

- Messages are sent through an internal **FIFO queue**. A message counts as sent only when Telegram answers with a 2xx status. On any other result (a network error or timeout, a rate limit, a rejection such as bad request or bot kicked, or a server error) the whole queue pauses for 1 minute, or for Telegram's `retry_after` if that is longer, and the message is **retried in place** (up to 5 attempts). Bursts like the weekly digest are never dropped. After the last attempt the message is reported as failed; every final outcome still lands in the [outbound log](README.md). A message that keeps failing holds the messages behind it for about 4 minutes. After a timeout, Telegram may already have delivered the message, so a retry can post it twice.
- The bot token is **write-only** (never returned to the browser); an env value locks the field.
- Topics require a **forum-type** Telegram group. "Auto-create topics" skips any that already exist.
- Use **Send test** to verify connectivity + chat ID before relying on it.
- A bot can have only **one webhook**; this integration claims it for `callback_query` (button) updates.
