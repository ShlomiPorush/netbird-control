# Event Filtering & Cleanup

Keep the activity database useful by **dropping known-noise traffic** before it's stored, and **purging** noise that's already stored.

*Where:* **Operations → Event Filtering**. *Backed by:* filter rules + the `events` table.

## Filtering on ingest

Incoming NetBird [webhook](features.md#connecting-netbird-events) events are checked before insert:

- **Built-in noise** - broadcast/multicast, common health-check probes, IPv6 multicast (`ff00::/8`), etc. Toggle on/off.
- **Custom rules** - your own match conditions (by source/destination/type/protocol/…). Matching flow events are discarded so they never hit the DB.

This runs on the write path, so filtered events cost nothing downstream.

## Purging already-stored noise (gated)

If noise slipped in before a rule existed, the **purge tool** removes it - but it's **destructive**, so it's gated separately from normal admin:

1. **Scan** (`GET /api/filter-rules/matching`) - counts + samples stored events that match the current filters.
2. **Confirm** - review the count/sample.
3. **Purge** (`POST /api/filter-rules/purge`) - deletes them and refreshes the activity view. Audited as `events.purge_matched`.

**Who can purge:** only emails in the `EVENT_PURGE_ADMINS` allow-list - *not* every admin. With SSO on and the list empty, **nobody** can purge. This is deliberate: deleting audit history should be a named, limited capability.

## Gotchas

- Filtering only affects **flow/traffic** noise; management/audit events are always kept.
- **Regex rules have a time limit.** All regex rules for one event get 25 ms together. If they take longer, the event is kept, as if no regex rule matched (the purge tool leaves such a stored row in place too). A rule that is too slow twice is skipped for that account for 10 minutes, and the server log names it (`Filter rule #<id> … skipped`). Keep patterns simple, or use the other match types.
- Purge acts on the **current** filter definition - widen or narrow the rules first to control exactly what it will match.
- The scan is a preview; nothing is deleted until you confirm the purge.
