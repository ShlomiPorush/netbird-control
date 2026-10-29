# Address Blocklist

Addresses (IPs / CIDRs / domains) that may **not** be added as network resources - a guardrail enforced on manual create/edit **and** on [automation](automation.md) imports. Optionally, it can also act on resources that **already exist**.

*Where:* **Operations → Blocklist**. *Backed by:* the `address_blocklist` table.

## An entry

| Field | Meaning |
|---|---|
| **value** | An exact IP/domain, a **CIDR** (`10.0.0.0/8` also blocks `10.1.2.3`), or a domain (also blocks its subdomains). |
| **mode** | `block` (default) - nothing matching may be added · `limit` - see **Limit mode** below. |
| **max prefix** | Limit mode only: the narrowest CIDR width still allowed inside the range. |
| **scope** | `all` networks · `only` selected · `except` selected - so you can block globally yet allow where needed. |
| **enforce** | What to do with **existing** matches: `none` (block new only) · `disable` · `delete`. |
| **enabled** | Pause switch - a disabled entry keeps its config but blocks/enforces nothing. |

Matching (block mode): exact string, IPv4 CIDR containment, or domain/subdomain.

### Limit mode

The problem it solves: editors may add resources, and nothing classic-blocking can stop `10.0.0.0/8` **without** also blocking every legitimate host inside it. A Limit entry protects the range's **width** instead of its contents:

> Entry `10.0.0.0/8`, mode limit, max prefix `/24` →
> `10.5.3.17` ✅ · `10.5.3.0/28` ✅ · `10.5.0.0/24` ✅ · `10.0.0.0/16` ❌ · `0.0.0.0/1` (covers the range from outside) ❌

A candidate is rejected when it is an IPv4/CIDR that **overlaps** the entry's range and is **broader** than the max prefix. Domains are never affected; bare IPs count as `/32`. The error names the rule: `matches "10.0.0.0/8 (max /24 allowed)" on the blocklist`. Limit entries support scope, enforce-on-existing (matches = existing too-broad resources) and the pause switch like any other entry.

## Adding entries

- **Add** - type a single value by hand.
- **Add From Network** - pick a network and multi-select addresses from its **existing resources**; all picked addresses are added at once (`POST /api/blocklist/bulk`) with a shared scope / enforce / note. Addresses already covered by the blocklist are shown but can't be re-selected, and values already present are skipped server-side (never duplicated). Audited as `blocklist.add` with a count + preview.
- **From a network's page** - on a network's Resources tab, select rows and click **Add To Blocklist** (admins only) - it opens the same modal with the network and the selected addresses preselected.

## Two layers

1. **Prevent new** (always on) - creating/editing a resource, or an automation import, checks the address against every entry whose scope covers the target network. A match is rejected (automations count it as `blocked` and skip it). **Admins are the exception**: they see a warning instead of a hard stop and may knowingly save anyway - every such save is audited as `blocklist.override`. Automations and non-admin editors are always blocked.
2. **Enforce on existing** (opt-in per entry) - set an entry's *enforce* to **Disable** or **Delete**, then run **Enforce on existing**.

## Enforce on existing - scan → review → apply

Because touching live resources is destructive, it's a deliberate three-step flow:

1. **Scan** (`GET /api/blocklist/matching`) - walks every network's resources and lists those matching an *enforcing* entry (respecting each entry's scope). Read-only.
2. **Review** - the modal groups matches by network and shows the action (disable/delete) per row; you can uncheck any to keep.
3. **Apply** (`POST /api/blocklist/enforce`) - re-scans (so it only acts on current matches) and disables/deletes the selected ones. Returns counts; audited as `blocklist.enforce`.

Guards: admin-only, **blocked in read-only mode**, and it only ever touches resources that currently match a live entry.

## Gotchas

- The two automation-facing behaviours differ: the **automation sync** skips blocked addresses only for *new* creates/adopts (already-managed resources aren't re-checked). The **Test** in an automation now flags blocked addresses too, so the preview matches the real sync.
- `disable` is reversible (sets `enabled=false`, keeps the resource); `delete` is permanent.
- Built-in-noise event filtering is a different feature - see [Event Filtering](event-filtering.md).
