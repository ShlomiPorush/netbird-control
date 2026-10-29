# Temporary Access

Grant a user **time-boxed** access to resources - applied immediately and **automatically revoked when it expires**. Limited to admins or holders of the **Manage Temporary Access** [feature permission](permissions-and-security.md#feature-permissions-per-capability-grants), audited, blocked in read-only mode.

*Where:* the **Temporary Access** page (sidebar). *Backed by:* the `temporary_access_grants` table + a 60-second scheduler.

## Least privilege: the grant mirrors existing policies

A temporary grant **never opens more than the target already allows**. When the policy is created, the app reads each target's *existing* exposure and copies it:

- A **resource** whose only policy is, say, `TCP 39001` → the temporary policy is also `TCP 39001` (both direct policies and ones inherited via the resource's groups count).
- Resources with **different** protocol/port combinations are split into separate destination groups + policies - each mirroring its own combo (a resource reachable by several combos gets all of them, and no more).
- An **Access Profile** target mirrors the profile's own protocol/ports definition.
- A resource with **no policies at all** has nothing to mirror and gets `all` - otherwise the grant would be inert (such a resource is reachable by no one).
- Other grants' temporary policies and disabled policies are **excluded** from the mirror, so one broad grant can't leak `all` into the next.

This is automatic - not a choice the granter (or requester) makes.

## Recurring access

The **Recurring** tab holds standing schedules: a user + targets + weekdays + a daily window (e.g. workdays 09:00-17:00, in the app's configured time zone). At each window start the 60-second scheduler creates a **normal temporary grant** that expires at the window end - so activation, teardown, audit, emails and Telegram all reuse the regular grant machinery, and the live window shows up in the Grants tab like any other grant (with an **active now** chip on the rule).

- Each rule activates **once per day** (a failed activation is retried the next scheduled day, and logged).
- A rule can carry an optional **Until Date** (inclusive, app time zone): past it the scheduler stops activating the rule and **auto-disables** it (audited as `recurring.expire`). A window that is already active when the date passes still ends at its own window end.
- **Disabling or deleting** a rule revokes its currently active window immediately.
- Rules are audited (`recurring.create` / `update` / `delete`) and skipped entirely in read-only mode.

## The core idea

Access = group membership + a policy (see the [mental model](README.md#the-one-mental-model-that-explains-everything)). So a grant does one of two things depending on what you target, and undoes exactly that on expiry.

## What each target type does

| Target | What happens on grant | What's created |
|---|---|---|
| **Group** | The user is **added directly to that group** (via the user's *auto-assigned groups*). They appear in the group's **Users** tab; their devices inherit it. | nothing - reuses the group |
| **Access Profile** | The user is assigned to a **temp source group**, and one policy connects it to the **profile's own group** - so they reach **exactly** the profile's resources, nothing else. | shared source group + 1 policy |
| **Resource(s)** | Every chosen resource is dropped into **one shared temp destination group**; the user is assigned to the **temp source group**; one policy connects source → destination. | source group + destination group + 1 policy |
| **Whole network** | Same as resources, expanded to **every resource in the network** (snapshot at grant time), all in the same destination group. | source group + destination group + 1 policy |

You can mix target types in one grant. Only a **group** target is direct membership. Everything else is served by **one source group** (the user), **one destination group** (all the loose resources), and **one policy** (`source → [destination group, ...profile groups]`) - regardless of how many resources you pick.

### Why one policy, not one per resource

NetBird keeps only a **single `destinationResource` per policy**, so pointing a policy at N resources directly would silently keep only the first. Instead we put the resources in a group and target the *group* - the [Access Profile pattern](access-profiles.md). One group pair + one policy scales to any number of resources, and access **follows** the group rather than a snapshot.

### How an Access Profile target works (and why it's isolated)

A shared [Access Profile](access-profiles.md) grants access to its resources - which live in the profile's **destination group** - to whoever is in its **source groups**.

The naive approach would be to drop the user into those source groups. **We don't**, because source groups are real, shared groups that may grant *other* things too - the user would get more than the profile (over-grant). Instead we create an isolated temp group for the user and a policy `temp group → the profile's destination group`. Result:

- The user reaches **exactly** the profile's resources, and **nothing else**.
- Because the policy targets the *group* (not a snapshot of resources), access **follows** resources added/removed from the profile during the window.
- On expiry the temp group + policy are deleted; the profile's own group and source groups are never touched.

Only **Shared** profiles are offered (Direct profiles have no group/policy).

> A **group** target is different on purpose: there you explicitly chose that group, so the user is added to it directly and gets everything it grants - that's the intent of picking a group.

## Lifecycle

- **Grant** - pick a user, one or more targets, and a duration (**preset/custom length** *or* an exact **date-time**). Applied immediately. Audited as `access.grant` (→ Telegram). Targets can be added two ways: a **global search** across all resources / networks / access profiles (the fast path, the same typeahead as [Request Access](access-requests.md)), or the structured **type → network → target** pickers below it.
- **Expire** - the scheduler revokes it within ~60s of `expires_at`: removes the user from every group we added them to, deletes the policy, detaches the resources from the temp destination group, deletes both temp groups. Audited as `access.expire`.
- **Revoke now** - the same teardown on demand (`access.revoke`).
- **Extend / renew** - push `expires_at` out (preset/custom or exact time). No NetBird change. `access.extend`.

The list shows a **live countdown**; expired/revoked grants stay as history until you delete the row.

## Under the hood (safety)

Each grant row records:
- `assigned_groups` - every group we added the user to (target groups + the temp source group).
- `group_id` - the **temp source group** we created (deleted on teardown; never the user's own target groups).
- `dest_group_id` - the **temp destination group** holding the loose resources (deleted on teardown).
- `dest_resources` - the `{networkId, resourceId}` pairs we attached to the destination group (detached on teardown).
- `policy_ids` - policies we created.

The temp groups and policy are **app-managed**, so they're named by the grant id, not a long label: `Temp access #<id> (until <date>)` (source group), `Temp resources #<id> (until <date>)` (destination group), and `Temporary access #<id>` (policy). The `#<id>` matches the grant's row id, so anything you see in NetBird maps straight back to a row here. The id is reserved from the table's sequence *before* the NetBird objects are created, so the name is stable.

Guarantees:
- **Never strips a pre-existing membership.** We only track a group in `assigned_groups` if *we* actually added the user to it (`setUserGroupMembership` returns whether it changed anything). On expiry we remove only those.
- **Never touches a pre-existing resource membership.** Resources are only *detached* from the temp destination group we created; their other groups are untouched.
- **Self-contained teardown.** Deleting the policy, detaching the resources, and removing the two temp groups + the assignment leaves nothing behind.
- **Crash-safe.** A `last_status='running'` flag is cleared on startup so a half-done revoke retries.
- **Crash-safe creation too.** A `status='creating'` placeholder row is written *before* any NetBird call. If the process dies mid-creation, a scheduler (`cleanupStuckCreatingGrants`, rows older than 15 min) finds the orphaned NetBird objects **by name** (`Temp access #id…` / `Temp resources #id…` / `Temporary access #id`), deletes them, removes any memberships, and drops the row - audited as `grant.cleanup`. A thrown error during creation compensates in-line and removes the placeholder immediately.
- **Loud failures.** The user→group assignment (`PUT /api/users` `auto_groups`) is verified against NetBird's response; if the token can't modify users, the grant fails clearly instead of creating an empty group.
- **Reconcile.** Every tick re-asserts each active grant's assignments, so an IdP group-sync that strips `auto_groups` can't silently drop access mid-window.

## Requirements & gotchas

- The **NetBird API token** must belong to an **Admin/Owner** service user - assigning users to groups requires user-management permission (the dashboard works because it uses your admin login; the app uses the token).
- A **whole-network** target needs at least one **resource** in that network (routing-only networks have nothing to grant → clear error). It's a **snapshot**: resources added mid-window aren't auto-covered.
- A user with **no devices** can still be granted - the assignment sticks and takes effect when they enroll a device.
- Blocked entirely when `NETBIRD_READONLY=true`.
