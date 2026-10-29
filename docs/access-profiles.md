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

## Gotchas

- Only **Shared** profiles have a group/policy - Direct profiles can't be used anywhere that needs group membership (e.g. as a Temporary Access target).
- The source groups are **real, shared** groups. Anyone/anything you put in a source group gains the profile's access (that's the point) - and possibly whatever *else* that group grants elsewhere.
- Deleting a profile removes its NetBird group + policy; resources that were in the group lose that inherited access.
