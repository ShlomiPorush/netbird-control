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
  every time a link is opened. If that record can't be written, the action doesn't happen. Calls
  that are refused (a bad key, bad input, no access) are not in the audit log.

| Scope | Allows |
| --- | --- |
| `remote-access:launch` | `POST /api/v1/remote-access/launch` |

## Authentication

Send the key in the `Authorization` header:

```
Authorization: Bearer nbc_...
```

The app checks the key before it reads the request body. Failed attempts count toward a per-address
limit that the webhook receivers share: 20 failures in 10 minutes block that address for the rest
of the window (`429 TOO_MANY_FAILURES`). A valid key may make 30 calls a minute (`429`).

Request bodies are JSON, up to 64 KB.

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
| 429 | `TOO_MANY_FAILURES`, or no code | Too many failed attempts from this address, or too many calls with this key. |
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

Send the user's browser to `url`. The link:

- works once, even if opening it fails;
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
