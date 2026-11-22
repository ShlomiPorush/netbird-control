# Access Profiles

A **reusable access definition** - "**who** (source groups) can reach **what** (the resources tagged with this profile) and **how** (protocol/ports)". Edit it once; every resource that uses it inherits the change.

## Two kinds

| Kind | What it is | Under the hood |
|---|---|---|
| **Shared** | A real, group-backed policy that many resources inherit. | Creates a NetBird **group** (the *destination*) + a **policy** `sources → that group`. Resources assigned to the profile **join the destination group**, so the policy grants access to all of them at once. |
| **Direct** | Just a **protocol/ports preset** for a single resource. | No group, no policy. It only pre-fills the fields when you add a per-resource policy. |

So a **Shared** profile is the interesting one: it is literally `{ group_id, policy_id, sources[], protocol, ports }` stored in the `access_profiles` table, mirrored to one NetBird group + one NetBird policy.

## How access actually flows (Shared profile)

```
[source groups]  ──policy(accept, proto/ports)──▶  [profile's group]  ◀── resources join here
   (the "who")                                        (the "what")
```

A peer reaches the profile's resources **iff a policy connects a group it's in to the profile's group**. The profile's own policy uses its *source* groups for this; [Temporary Access](temporary-access.md) instead points an isolated temp group at the profile's group, so it grants *only* the profile's resources without touching the shared source groups.

- **Posture checks** can be attached to a shared profile - they become the policy's `source_posture_checks`, so the access only applies to compliant devices.
- Editing a shared profile's sources/protocol/ports **rewrites its NetBird policy** in place, so all inheriting resources update together.

## Per-network default profiles

Each network can pre-select one or more **shared** profiles as defaults. When you add a new resource in that network, those profiles are pre-checked - so new resources inherit the standard access without manual wiring. Stored in `network_default_profiles`.

## Using it

- **Operations → Access Profiles** - create/edit. Choose *Shared* to bundle source groups + a policy; *Direct* for a plain protocol/ports preset.
- **Network detail → per-network defaults** - pick which shared profiles auto-apply to new resources.
- When adding/editing a resource, assign it one or more profiles; a shared profile makes the resource join that profile's group (inheriting its policy).

## Deleting a profile

A profile that is **in use can't be deleted**. On **Operations → Access Profiles** its Delete button is muted; pressing it opens **Can't Delete Profile** with the list of uses. Remove the profile from each of them first. The server checks again at delete time and answers `409 PROFILE_IN_USE` with the same reasons.

A profile is in use when any of these is true. Each one is read fresh when you delete, never from a cache:

| Use | Applies to |
|---|---|
| The profile group has **resources** or **peers**. | Shared |
| The profile's policy was edited to grant something besides the profile group (another destination group, or a resource that still exists). | Shared |
| The profile group is referenced elsewhere in NetBird: a setup key's or a user's auto groups, a network router's peer groups, a route, a DNS nameserver group, another policy, or a reverse-proxy service's NetBird-Only Access or SSO groups. | Shared |
| A temporary grant (active or being created) to the profile or to its group. | Shared |
| A **recurring access** rule that targets the profile or its group, enabled or not. (A rule can only target a Shared profile.) | Shared |
| A **pending** access request for the profile. A denied or approved one doesn't count. | Shared |
| An **auto-approval** rule that targets the profile, paused rules included. A trusted entry's excluded targets don't count. (A rule can only target a Shared profile.) | Shared |
| A **network default** of a network that still exists. Defaults of a network that no longer exists don't count and are removed with the profile. | Any |
| An **automation** that assigns the profile. | Any |

Grants and recurring rules are checked in the account you are managing. Requests and auto-approval exist in the main account only, so they are checked there. NetBird is read once per list (groups, policies, setup keys, routers, routes, DNS nameservers, users, reverse-proxy services, and networks or resources when needed), whatever the number of profiles. If any of these reads fails, the delete is refused with `502` and nothing is deleted. Try again. Three exceptions: a `404` from the routes list (a deprecated endpoint) counts as no routes, a `404` from the reverse-proxy services list (a NetBird without that feature) counts as no services, and a `404` from the account-wide routers list is answered by reading each network's routers instead.

An unused profile is deleted in this order:

1. Its row, its stale network defaults and the `profile.delete` audit entry (with the profile's group and policy ids) are saved in one database transaction. If the audit entry can't be written, nothing is deleted. If the database connection drops while the transaction is being saved, the outcome is unknown: the page says "The delete may have been saved. Reload the page to check." (`PROFILE_DELETE_UNCONFIRMED`) and nothing is deleted in NetBird.
2. Then the app deletes the profile's NetBird policy and group, each sent once. A group or policy that another profile row (of any account) also uses is kept.
3. If NetBird refuses a delete or doesn't answer, the profile stays deleted and the page says which object is left: "The profile was deleted. NetBird didn't confirm removing group Payroll; delete it in NetBird." The app records it as `profile.delete_leftover`. The profile was unused, so the object left behind grants nothing.

On a read-only instance (`NETBIRD_READONLY=true`) a profile can't be deleted.

## Profiles and resource changes

- **Deleting a resource never deletes a profile group or policy**, even when the resource was the last one in the group. The profile stays, with no resources.
- **Editing a profile's policy from a resource.** If a profile's policy targets a resource directly, the resource's **Access Control** tab lists it as one of the resource's own policies with the note "This policy is also the policy of Access Profile Payroll. Changes here apply to the profile." Saving updates that policy in place, so the profile keeps it, and the profile takes the protocol, ports, source groups and posture checks NetBird then holds for that policy (temporary grants and requests use them from then on). If the app can't confirm them, the save says "The profile's settings may be out of date. Save again to refresh them."; saving again brings the profile in line, even when nothing in the policy changed. Removing it there is refused: change or delete it in Access Profiles. Only an admin can change it from a resource; a network editor can save the resource with it unchanged, and a change is refused with "Only an admin can change the policy of Access Profile <name>."

## Gotchas

- Only **Shared** profiles have a group/policy - Direct profiles can't be used anywhere that needs group membership (e.g. as a Temporary Access target).
- The source groups are **real, shared** groups. Anyone/anything you put in a source group gains the profile's access (that's the point) - and possibly whatever *else* that group grants elsewhere.
- A profile picked in a network default, an automation, a recurring rule, an auto-approval rule, a grant or a request must still exist when you save; a deleted one is refused with `400 PROFILE_NOT_FOUND`. A profile id must be written the plain way (`7`, not `007`); another form is refused with `400 INVALID_PROFILE_ID`.
