# Email Notifications (SMTP)

Telegram reaches the **approvers**. Email closes the loop with the **user**: it tells a requester when their access request is approved or denied, and tells anyone given temporary access when it starts and when it ends. Optional - nothing is sent until SMTP is configured.

*Where:* **Settings → Email (SMTP)** (admin-only), or `SMTP_*` environment variables.

## When emails are sent

| Event | Recipient | Subject |
|---|---|---|
| Temporary access **granted** (a direct grant **or** an approved request) | the user who received access | `Access granted: <targets>` |
| Access request **denied** | the requester | `Access request denied: <targets>` |
| Temporary access **ends** (expiry **or** manual revoke) | the user who had access | `Temporary access ended: <targets>` |
| Device **blocked by compliance** on a login attempt | the device's owner | `Device blocked by compliance: <device>` |

The compliance email includes the block reason, both ways forward (**request a bypass**, or tick **Temporary device** for a loaner that auto-removes when its period ends) and a button to the Request Access page. It fires **only on a login observed right now** - a transition between two peer syncs: an existing device whose `last_login` just changed, or a brand-new device enrolling. Pure state ("this device is blocked") never emails, so deploys/restarts can never mass-mail the backlog. Kill switch: **Settings → Email → Email owners when a device is blocked by compliance**.

An **approved** request doesn't send a separate email - approval creates the temporary grant, and the "Access granted" email (with the resources and the expiry time) *is* the notification. Denials, which create no grant, get their own email.

The recipient address is captured when the grant is created (`user_email` on the grant), so the "ended" email needs no live lookup. It's resolved from the request's requester email, else the user's device owner email, else the NetBird user's email.

## Configuration

Two ways, mutually exclusive:

- **In-app** (default): fill in **Settings → Email (SMTP)** - host, port, implicit-TLS toggle, username, password (write-only, never returned), and a From address. A **Send test** button emails a chosen address (or yourself) using the current settings.
- **Environment**: set `SMTP_HOST` (and the other `SMTP_*` vars). When `SMTP_HOST` is set, the **whole** config is env-managed and the in-app form is read-only.

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | SMTP server hostname. **Setting this switches to env-managed mode.** |
| `SMTP_PORT` | Port (default `587`, or `465` when `SMTP_SECURE=true`). |
| `SMTP_SECURE` | `true` = implicit TLS (port 465); `false`/empty = STARTTLS (port 587). |
| `SMTP_USER` / `SMTP_PASS` | Auth credentials. Leave empty for an unauthenticated relay. |
| `SMTP_FROM` | Sender shown to recipients (e.g. `NetBird Control <notifier@example.com>`). Defaults to `SMTP_USER`. |

## Formatting

Emails use a small branded HTML card (heading + a label/value table) and, when `BASE_URL` is set, a link back to the app. Times are rendered in the app's configured **time zone / format** (the same as everywhere else).

## Security & gotchas

- The password is **write-only** - stored on the server, never returned to the browser; an env value locks the field.
- Admin-only to configure; saving is audited as `settings.smtp`. Send-test is admin-only.
- Sends are **fire-and-forget**: a mail failure is logged and never blocks the grant/approval/denial itself.
- Uses [nodemailer](https://nodemailer.com). The transport is cached and rebuilt only when the connection settings change.

## Related

- [Access Requests](access-requests.md) - the request → approve/deny flow these emails accompany.
- [Temporary Access](temporary-access.md) - grants, expiry and revoke.
- [Telegram Notifications](telegram-notifications.md) - the approver-facing side.
