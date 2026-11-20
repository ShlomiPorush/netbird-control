# Public API reference

NetBird Control has a versioned API for other systems under `/api/v1`. It is separate from the
`/api` routes the app's own pages use, which can change between releases.

For a step-by-step integration, see [Open remote sessions from another system](remote-launch-integration.md).

## API keys

An admin creates keys in **Settings → API Keys**, in the main account.

- A key looks like `nbc_` followed by 43 characters. The app shows it once, when it is created. It
  stores only the key's SHA-256 and its first 12 characters, which the list shows.
- A key has one or more permissions (scopes). A call that needs a permission the key lacks gets
  `403 SCOPE_MISSING`.
- A key can be limited to IP addresses or CIDR ranges. Behind a reverse proxy, set `TRUST_PROXY` to
  the proxy's address, or the app sees every call as coming from the proxy.
- A key can have an expiry date. **Revoke** stops a key at once. **Replace** creates a new key with
  the same settings. The old key keeps working until you revoke it, so you can move the other
  system to the new key first.
- The audit log records keys being created and revoked, every connection link a key makes, and
  every time a link is opened. If that record can't be written, the action doesn't happen.
- A link request that a valid key makes and the app refuses (bad input, no access, remote access
  turned off, too many waiting links) is recorded as `remote_access.launch_refused`, with the key,
  the error code and the target. The target holds only values that passed the field checks;
  anything else shows as `invalid`, and the credential fields are never recorded. Repeats are
  collapsed per key and code: within 10 minutes, a record is written at about the 1st, 10th, 100th
  (and so on) refusal, with the number so far. A refusal that arrives while a record is being
  written, or within a minute after a write failed, is only counted; the next refusal after that
  writes the record. Calls refused before the key is accepted (a missing or bad key, a
  missing permission), and bodies that are not JSON, are not in the audit log.

| Scope | Allows |
| --- | --- |
| `remote-access:launch` | `POST /api/v1/remote-access/launch` |
| `remote-access:create-resource` | `"createResource": true` on `POST /api/v1/remote-access/launch`: add a missing server as a temporary resource. The key needs `remote-access:launch` too. New keys don't get it unless an admin ticks it. |

## Authentication

Send the key in the `Authorization` header:

```
Authorization: Bearer nbc_...
```

The app checks the key before it reads the request body. A missing, malformed, unknown or expired
key is a failed attempt. Failed attempts count toward a per-address limit that the webhook receivers
and the Telegram callback share: after 20 failures in 10 minutes, every failed attempt from that
address gets `429 TOO_MANY_FAILURES` for the rest of the window, including a revoked key and a key
used from an address it may not use. A revoked key, or a key used from such an address, is refused
but does not count as a failure. The failure limit never refuses a valid key: the key is checked
first, so a valid key works from a blocked address too. A valid key may make 30 calls a minute
(`429`, no code).

Each client address may make 300 calls a minute to `/api/v1` in total, with any key or none. This
limit is checked before the key, so a flood of guessed keys never reaches the database; past it,
every call from that address gets `429` with no code, a valid key's too, until the minute is over.
IPv6 addresses count per /56 network, so addresses in one /56 share the limit. The client address is
the connection's, unless `TRUST_PROXY` names the proxy in front of the app.

Request bodies are JSON (`Content-Type: application/json`), up to 64 KB. A form or any other
body type gets `415 UNSUPPORTED_MEDIA_TYPE`.

## Errors

Every error is JSON with a message for people and a stable code for programs:

```json
{ "error": "This API key was revoked.", "code": "KEY_REVOKED" }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_JSON` | The body is not valid JSON. |
| 400 | `INVALID_PROTOCOL`, `INVALID_ADDRESS`, `INVALID_PORT`, `INVALID_FIELD`, `INVALID_USER`, `USERNAME_REQUIRED` | A field is missing or wrong. The message names it. |
| 401 | `MISSING_KEY` | No `Authorization: Bearer` header. |
| 401 | `INVALID_KEY`, `KEY_REVOKED`, `KEY_EXPIRED` | The key can't be used. |
| 403 | `IP_NOT_ALLOWED` | The key may not be used from this address. |
| 403 | `SCOPE_MISSING` | The key lacks the permission for this action. |
| 403 | `DISABLED`, `NO_SSO` | Browser remote access is turned off, or SSO is not set up. |
| 403 | `USER_BLOCKED` | The named NetBird user is blocked. |
| 403 | `NO_ACCESS`, `PORT_NOT_ALLOWED`, `NETWORK_NOT_ENABLED`, `UNKNOWN_ADDRESS`, and the other access codes in [Browser remote access](remote-access.md) | The named user may not reach this target. |
| 404 | `USER_NOT_FOUND` | No NetBird user has this email address. |
| 404 | `NOT_FOUND` | No such API path. |
| 409 | `USER_AMBIGUOUS` | More than one NetBird user has this email address. |
| 413 | `TOO_LARGE` | The body is over 64 KB. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | The body is not sent as JSON. |
| 429 | `TOO_MANY_FAILURES`, or no code | Too many failed attempts from this address (only a failed attempt gets this), or too many calls with this key. |
| 403 | `CREATE_DISABLED` | `createResource: true`, but adding servers is turned off (or this instance is read-only). |
| 403 | `ADDRESS_NOT_PUBLIC`, `NAME_NOT_PUBLIC`, `ADDRESS_BLOCKED` | `createResource: true` for an address that isn't public, a name with an answer that isn't public, or an address or name on the blocklist. Nothing was created. |
| 403 | `NAME_NOT_FOUND` | The host name has no IPv4 address in the DNS. |
| 409 | `CREATE_LIMIT` | Too many servers added by links still exist (Settings > Remote Access sets the maximum). |
| 409 | `CREATE_IN_PROGRESS` | Another request is adding or removing this server right now. Try again in a minute. |
| 502 | `RESOURCE_CREATE_FAILED` | NetBird refused the new resource (also when it answered "too many requests"; the create is sent once). Nothing was created. |
| 502, 503 | `CREATE_UNCONFIRMED` | NetBird didn't confirm the new resource (502, with `resourceCreated`), or an earlier request for this server is still unconfirmed (503). Try again in a few minutes. |
| 503 | `CREATE_PAUSED` | Adding servers is paused because the Browser Gateway can reach their group. An admin sees why in Settings > Remote Access. |
| 503 | `NAME_LOOKUP_FAILED`, `TARGETS_SETTLING` | The DNS didn't answer, or Remote Access is getting ready after a change. Try again shortly. |
| 503 | `BUSY`, `SNAPSHOT_FAILED`, `AUDIT_FAILED`, `UNAVAILABLE` | Try again shortly. |

## `POST /api/v1/remote-access/launch`

Scope: `remote-access:launch`.

Makes a one-time link that opens a browser RDP or SSH session with the credentials you send. The
credentials stay on the NetBird Control server: they are not in the link, and they never reach the
browser.

### Request body

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `protocol` | string | yes | `rdp` or `ssh`. |
| `address` | string | yes | An IPv4 address or a host name, as on the **Remote Access** page. |
| `port` | integer | yes | 1 to 65535. |
| `user` | string | no | The email address of the person who will open the link. See below. |
| `username` | string | SSH: yes | The user name on the target server. Up to 256 characters. |
| `password` | string | no | Up to 1024 characters. |
| `domain` | string | no | RDP only. Up to 256 characters. A domain inside `username` (`CORP\admin`) works too. |
| `privateKey` | string | no | SSH only. An OpenSSH or PEM private key, up to 16384 characters. |
| `passphrase` | string | no | SSH only. The private key's passphrase. |
| `createResource` | boolean | no | `true`: add the server as a temporary NetBird resource when NetBird has none for it. Needs the `remote-access:create-resource` scope. Default `false`. Any other type is refused with `400 INVALID_FIELD`. See [Adding a missing server](#adding-a-missing-server-createresource). |

**With `user`:** the app finds the one NetBird user with that email address (letter case doesn't
matter) and checks now that this user may reach the target, with the same rules as the **Remote
Access** page. Only that user can open the link.

**Without `user`:** the app checks nothing at this point. Whoever opens the link first gets the
session, if their own access allows the target when they open it. A link that reaches someone else
within its five minutes, for example when it is forwarded, works for them too.

In both cases, the person who opens the link must sign in to NetBird Control with SSO and hold the
**Browser Remote Access** permission. Their access is checked again when the session opens, and
every minute while it stays open.

### Response

`201 Created`:

```json
{
	"url": "https://control.example.com/remote-access?launch=Xk9...",
	"expiresAt": "2026-11-05T10:05:00.000Z"
}
```

With `createResource: true` the answer also has `resource` (see below).

Send the user's browser to `url`. The link:

- works once, even if opening it fails (while remote access is getting ready after a change or a
  restart, the page waits until it is ready before it opens the link, usually within a minute);
- expires after five minutes;
- stops working when the key that made it is revoked or expires.

If the credentials are wrong, the session asks the user to sign in again in the same tab.

### Example

```bash
curl -sS https://control.example.com/api/v1/remote-access/launch \
	-H "Authorization: Bearer $NBC_API_KEY" \
	-H "Content-Type: application/json" \
	-d '{"user":"tech@example.com","protocol":"rdp","address":"10.0.0.5","port":3389,"username":"admin","password":"..."}'
```

### Adding a missing server (`createResource`)

With `"createResource": true`, and a key with the `remote-access:create-resource` scope, the app adds
a server that NetBird has no resource for, so the person can connect without waiting for an
administrator. An admin turns this on in **Settings > Remote Access > Resources Created By Links**
and chooses the network and the group the new resources go into. The app never creates or changes a
policy: an admin's policy to that group (for example *CRM users -> that group*) decides who reaches
the new servers.

The key must have the scope first (`403 SCOPE_MISSING`, before any other check). Then the app
checks, in this order, and stops at the first refusal:

1. **Does NetBird cover the target already?** For an IPv4 address: a resource or an enabled legacy
   route covers it. For a host name: a domain resource or an enabled domain route covers the name;
   otherwise the name is looked up and any of its addresses is covered. Then nothing is created and
   the request goes on exactly as without `createResource`, whatever the settings below say and
   whether or not the address is public. An integration can send `createResource: true` on every
   launch: private servers that already have a resource keep working. When NetBird or the DNS can't
   be read and adding servers is off, the request also goes on as without `createResource`.
2. Adding servers is on, not paused, and the instance is not read-only (`CREATE_DISABLED`,
   `CREATE_PAUSED`). The app reads these settings from the database on every request, so turning
   the feature off stops it on every instance at once.
3. The target is public. An IPv4 address must not be in the IANA IPv4 Special-Purpose Address
   Registry (every entry), multicast, or be a Browser Gateway's own address (`ADDRESS_NOT_PUBLIC`). For a host name every IPv4 answer must be
   public (`NAME_NOT_PUBLIC`), and the app uses the first one. A name with no IPv4 answer is
   `NAME_NOT_FOUND`. Neither the address nor the name may be on the blocklist (`ADDRESS_BLOCKED`;
   names compare without regard to letter case, a trailing dot or international spelling).
4. With `user`: the user exists, only once, and is not blocked.
5. Fewer than the maximum servers added by links exist (`CREATE_LIMIT`), and no other request is
   adding the same address.
6. Right before the one send (inside the resource writer, after its own checks, its wait for the
   lock and any wait for NetBird's rate limit), the key is checked again (`401 KEY_REVOKED`), and so
   are the settings (`CREATE_DISABLED` when adding was turned off meanwhile) and the pause
   (`CREATE_PAUSED`). Then nothing is sent.

Addresses that are never a Remote Access target (loopback, NetBird peers, multicast, reserved) go
on as without `createResource`, and the usual checks refuse them. A host name with such an answer
next to a public one is `NAME_NOT_PUBLIC`.

The new resource is a host resource (`x.x.x.x/32`) named after the address (or `name (address)`
for a host name), in the chosen network and group, with no policy. Then the usual checks follow:
with `user`, that user's access to the address. The link connects to the address, also when the
request sent a host name; it then keeps the name for the SSH host key set for it.

The `201` answer then has:

```json
{
	"url": "https://control.example.com/remote-access?launch=Xk9...",
	"expiresAt": "2026-11-05T10:05:00.000Z",
	"resource": { "created": true, "id": "d2l5...", "address": "203.0.113.10" }
}
```

`created` is `true` only when this request made the resource. `false` means NetBird already had one
(`id` is set when the app knows it).

An error answered after the resource was sent to NetBird carries `resourceCreated`: `true` when the
resource was made (for example the named user has no access, `403 NO_ACCESS`), or `"unknown"` when
NetBird didn't answer clearly. The resource stays either way:

```json
{ "error": "You don't have access to this resource. Request access if you need it.", "code": "NO_ACCESS", "resourceCreated": true }
```

A refusal before anything was sent, or a definite refusal by NetBird, has no `resourceCreated`.

The new resources are temporary. Once their **Keep Opened Servers Available For** time (10 hours
by default) has passed since they were created and no session holds them, the app deletes them (the
resource only; the group and its policies stay). A resource that someone changed, or that a policy
names directly, is kept and left to an admin. See
[Browser remote access](remote-access.md#servers-added-by-launch-links).

The audit log records `resource.create_intent` before the write, then `resource.create`,
`resource.create_unconfirmed` or `resource.create_failed`, and later `resource.delete` or
`resource.kept`.
