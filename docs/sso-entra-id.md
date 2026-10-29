# SSO and AD groups (Azure AD / Entra ID)

SSO is optional (see [Security model](../README.md#security)), but to require login **and** to grant admin / network-edit access by AD group, register an app in Entra and give it Microsoft Graph permission to read group membership. **One app registration covers both** login (OIDC) and group resolution (Graph) - the app reuses the same client ID/secret for each.

## 1. Register the application

1. **Entra admin center** → **App registrations** → **New registration**.
   - **Name:** e.g. `NetBird Control`.
   - **Supported account types:** *Accounts in this organizational directory only* (single tenant) - typical.
   - **Redirect URI:** platform **Web**, value `{BASE_URL}/callback` - e.g. `https://logs.example.com/callback` (must match `BASE_URL` exactly, no trailing slash on `BASE_URL`).
   - **Register.**
2. On **Overview**, copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Certificates & secrets** → **New client secret** → copy the secret **Value** immediately (not the *Secret ID*). Set an expiry you can track.

## 2. Grant Graph permission to read groups

Group-based admin (`ADMIN_GROUP_ID`) and AD-group **network grants** work by reading each signed-in user's **transitive group membership** from Microsoft Graph (`GET /users/{id}/transitiveMemberOf`), using the app's own client credentials. Without this, login still works, but **no one becomes admin via a group** (only the NetBird `owner`/`admin` role does) and AD-group grants match nothing.

1. **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions** (⚠️ *not* Delegated - the app calls Graph as itself, not on-behalf-of the user).
2. Add **`GroupMember.Read.All`** (or the broader `Directory.Read.All` if your org standardizes on it).
3. Click **Grant admin consent for &lt;tenant&gt;** and confirm the row shows a green **Granted** check. This step needs a Global Administrator / Privileged Role Administrator - a missing or un-consented permission is the #1 reason group lookups return empty.

## 3. Map the values to environment variables

| Entra value | Environment variable |
|---|---|
| Directory (tenant) ID | inside `OIDC_ISSUER_BASE_URL=https://login.microsoftonline.com/<TENANT_ID>/v2.0` |
| Application (client) ID | `OIDC_CLIENT_ID` |
| Client secret **Value** | `OIDC_CLIENT_SECRET` |
| Public URL of this app (no trailing slash) | `BASE_URL` |
| Object ID of your admin group (Entra → **Groups** → the group → *Object Id*) | `ADMIN_GROUP_ID` |
| `openssl rand -hex 32` | `SESSION_SECRET` |

The app derives the Graph tenant from `OIDC_ISSUER_BASE_URL` (it strips the trailing `/v2.0`) and requests the `openid profile email` scopes at login - **no separate Graph app registration is required.** `ADMIN_GROUP_ID` is optional: leave it blank to rely solely on the NetBird role, or set it to make a group's members admins.

## 4. Verify group resolution

After logging in, open **`/api/me?debug`** - it runs the *live* Graph lookup and reports `graphConfigured`, whether a token was acquired, the resolved **group count**, and the exact error if any. Use it to confirm groups resolve **before** wiring `ADMIN_GROUP_ID`:

- `graphConfigured: false` → one of `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_ISSUER_BASE_URL` is missing.
- token error → wrong client secret or tenant.
- `groupCount: 0` with a `403` / `Authorization_RequestDenied` → the **`GroupMember.Read.All` application permission is missing or wasn't admin-consented** (step 2).

The same reasons are logged server-side as `[Graph] …`.
