# Automation

Connect an **external HTTP source** that returns IP addresses and **auto-provision NetBird resources** from it - on a schedule or on demand - so a network's inventory stays in sync with an external source of truth.

*Where:* the **Automation** page (sidebar). *Backed by:* `automations`, `automation_resources`, `automation_runs` + a 60-second scheduler.

## Configuring an integration

- **Connection** - endpoint URL + auth (`none` / `bearer` / custom `header`; the secret is **write-only**).
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
   - **Known key** → keep in sync; re-enable if it had been disabled.
   - **New key, address already exists (not ours)** → **adopt** it into management (from now on its lifecycle is managed).
   - **New key, new address** → **create** the resource (joined to the profile groups).
   - **On the blocklist** for the target network → **skip** (counted `blocked`).
   - **Name already taken** by a different resource → **conflict**, skipped.
   - **Ours, not seen this run** → apply the **removal mode**.
4. Write an `automation_runs` row (created/adopted/updated/disabled/skipped/conflicts/blocked/failed) + audit `automation.run` (→ Telegram).

**Key guarantee:** the automation only ever mutates resources in its **own ledger**, so it never touches manually-added resources it didn't create/adopt.

## Diagnostics

- **Test connection & mapping** - fetches + maps **without** creating anything; shows a preview of mapped items, marks invalid addresses and **blocklisted** ones, and flags duplicate keys.
- **Sync now** - runs immediately and reports counts.
- **Repair / Forget** - reconcile the ledger against reality / stop managing everything (leaves resources in NetBird as-is).
- Per-run history is kept for observability.

## Gotchas

- Blocked entirely in **read-only mode** (the scheduler is disabled and manual runs return 403).
- The scheduler is a single-process 60-second tick with an in-memory guard (no overlapping runs of the same automation) and clears crash-stuck `running` flags on startup.
- Adopting means the automation will later **disable/delete** that resource per the removal mode - only adopt sources you trust to be authoritative.
