# Automation

Connect an **external HTTP source** that returns IP addresses and **auto-provision NetBird resources** from it - on a schedule or on demand - so a network's inventory stays in sync with an external source of truth.

*Where:* the **Automation** page (sidebar). *Backed by:* `automations`, `automation_resources`, `automation_runs` + a 60-second scheduler.

## Configuring an integration

- **Connection** - endpoint URL + auth (`none` / `bearer` / custom `header`; the secret is **write-only**).
  The source must send its **complete response within 30 seconds** and **at most 10 MiB** (10,485,760 bytes). A slower or larger response stops the request, and the run (or the test) fails with an error before any resource changes.
- **Source format** -
  - **JSON**: an *items path* (dot-path to the array) + field mapping (**address**, name, description, and a **key** = stable external id used for dedupe; falls back to the address).
  - **Text**: one IP per line (`#` comments ignored), optional name prefix.
- **Target** - one network + one or more shared [Access Profiles](access-profiles.md); created resources join those profiles' groups and inherit their policy.
- **Schedule** - `interval_minutes` (0 = manual only) + a manual **Sync now**.
- **Removal mode** - what to do when an item **disappears** from the source: `disable` (default, reversible) · `none` (leave) · `delete`.
- **Safety floor** (`min_items`) - if the source returns fewer than N valid items (or 0 while resources are managed), the **entire sync is skipped** so a broken/partial response can't wipe the inventory.

## The sync engine (per run)

1. Fetch + parse the source; map each item to `{ key, address, name, description }`.
2. Apply the **safety floor** - bail out entirely if the response looks broken.
3. Diff against the **ownership ledger** (`automation_resources` - every resource this automation created or adopted):
   - **Known key** → keep in sync; re-enable if the removal mode had disabled it.
   - **New key, address already exists (not ours)** → **adopt** it into management (from now on its lifecycle is managed). A resource that is already disabled stays disabled until someone enables it in NetBird; after that, it is managed like any other.
   - **New key, new address** → **create** the resource (joined to the profile groups).
   - **On the blocklist** for the target network → **skip** (counted `blocked`).
   - **Name already taken** by a different resource → **conflict**, skipped.
   - **Ours, not seen this run** → apply the **removal mode**. With `delete`, the ledger row goes only after the delete succeeded or NetBird confirmed the resource is gone (a 404 in the network the row recorded, which may differ from the automation's current target). A refused or unanswered delete keeps the row, counts as failed, and the next run tries again. Only NetBird's own 404 for the resource counts as "gone". A row from before rows recorded their network is never deleted in the automation's current network: the resource is deleted in the network that holds it (the row goes once that delete succeeds or NetBird answers 404 there), the row goes at once when the resource is in no network, and it stays, failed, when the network can't be determined.
4. Write an `automation_runs` row (created/adopted/updated/disabled/skipped/conflicts/blocked/failed) + audit `automation.run` (→ Telegram).

**Key guarantee:** the automation only ever mutates resources in its **own ledger**, so it never touches manually-added resources it didn't create/adopt.

## Diagnostics

- **Test connection & mapping** - fetches + maps **without** creating anything; shows a preview of mapped items, marks invalid addresses and **blocklisted** ones, and flags duplicate keys.
- **Sync now** - runs immediately and reports counts.
- **Repair / Forget** - reconcile the ledger against reality / stop managing everything (leaves resources in NetBird as-is). The tracking list marks a row as an orphan the same way (an unreadable network shows as unknown, not orphan). Repair checks each row in the network it recorded; if a network's resource list can't be read, it changes nothing. Rows of a network that was deleted (NetBird answers 404 for the network itself) are removed as orphans, and a row without a recorded network is checked against every network.
- An automation can only be saved with Access Profiles that exist (`400 PROFILE_NOT_FOUND` otherwise), and a profile an automation uses can't be deleted.
- Per-run history is kept for observability.

## Gotchas

- Blocked entirely in **read-only mode** (the scheduler is disabled and manual runs return 403).
- The scheduler is a single-process 60-second tick with an in-memory guard (no overlapping runs of the same automation) and clears crash-stuck `running` flags on startup.
- Adopting means the automation will later **disable/delete** that resource per the removal mode - only adopt sources you trust to be authoritative.
