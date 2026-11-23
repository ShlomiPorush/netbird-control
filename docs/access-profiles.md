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

- **Posture checks** can be attached to a shared profile - they become the policy's `source_posture_checks`, so the access only applies to compliant devices. Browser sessions in Remote Access don't run posture checks, so the profile's policy opens them whatever the checks.
- Editing a shared profile's sources/protocol/ports **rewrites its NetBird policy** in place, so all inheriting resources update together.

## Per-network default profiles

Each network can pre-select one or more **shared** profiles as defaults. When you add a new resource in that network, those profiles are pre-checked - so new resources inherit the standard access without manual wiring. Stored in `network_default_profiles`.

## Using it

- **Operations → Access Profiles** - create/edit. Choose *Shared* to bundle source groups + a policy; *Direct* for a plain protocol/ports preset.
- **Network detail → per-network defaults** - pick which shared profiles auto-apply to new resources.
- When adding/editing a resource, assign it one or more profiles; a shared profile makes the resource join that profile's group (inheriting its policy).
- **Settings > Remote Access > Servers From Launch Links** - one shared profile decides who reaches the servers that launch links add: they join its group ([Remote Access](remote-access.md#resources-created-by-the-launch-api)).

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
| **Remote Access launch links** use it: it is the profile chosen in **Settings > Remote Access > Servers From Launch Links**, also while that is off. | Shared, main account |

Grants and recurring rules are checked in the account you are managing. Requests, auto-approval and Remote Access exist in the main account only. NetBird is read once per list, whatever the number of profiles. If a read fails, the delete is refused and nothing is deleted. Try again. A NetBird without legacy routes or without Reverse Proxy (a `404` from those lists) has no such uses.

An unused profile is deleted in this order:

1. Its row and its stale network defaults.
2. Its NetBird policy and group. When NetBird refuses a delete or doesn't answer, the profile stays deleted and the page says which object is left: "The profile was deleted. NetBird didn't confirm removing group Payroll; delete it in NetBird." The audit record names it too. The profile was unused, so the object left behind grants nothing.

On a read-only instance (`NETBIRD_READONLY=true`) a profile can't be deleted.

**Editing a profile Remote Access uses.** The profile chosen for launch links can be edited as
usual; its policy changes apply to the servers they add.

## Profiles and resource changes

- **Deleting a resource never deletes a profile group or policy**, even when the resource was the last one in the group. The profile stays, with no resources.
- **Editing a profile's policy from a resource.** If a profile's policy targets a resource directly, the resource's **Access Control** tab lists it as one of the resource's own policies with the note "This policy is also the policy of Access Profile Payroll. Changes here apply to the profile." Saving updates that policy in place, so the profile keeps it. Removing it there is refused: change or delete it in Access Profiles. Only an admin can change it from a resource; a network editor can save the resource with it unchanged.
- **The profile follows its policy.** When NetBird confirms a change to a profile's policy, from a resource or on the Policies page, the profile takes its posture checks, and, when the policy has one enabled accept rule to the profile's group (or to the resource it points at), its protocol, ports and source groups. Temporary grants and requests use them from then on. Access that was already granted doesn't change.

## Gotchas

- Only **Shared** profiles have a group/policy - Direct profiles can't be used anywhere that needs group membership (e.g. as a Temporary Access target).
- The source groups are **real, shared** groups. Anyone/anything you put in a source group gains the profile's access (that's the point) - and possibly whatever *else* that group grants elsewhere.
- A profile picked in a network default, an automation, or a recurring rule, auto-approval rule or grant that is on must still exist when you save; a deleted one is refused.
