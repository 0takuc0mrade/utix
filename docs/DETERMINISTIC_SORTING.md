# Deterministic mixed-status sorting

`core/sorting` provides immutable sort helpers for operational records and
events. Record lists put actionable failures first, followed by interrupted,
pending, running, successful, skipped, and abandoned records. Within a status
they use newest timestamp, highest sequence, status text, then id. Event streams
remain newest-first and use status, sequence, and id only as tie-breakers.

Unknown statuses sort after known statuses by their literal value. Missing or
invalid timestamps sort as the oldest value. These rules make a retry, reversed
input, or an engine with an unstable native sort produce the same result.

Authorization must happen before sorting. The helpers are deliberately pure and
cannot grant visibility; pass only the records the actor may see. They return a
copy and never mutate source data, so failure or rollback means discarding the
result. Adding a new status is backwards compatible (it initially sorts in the
unknown group); add it to `STATUS_PRIORITY` only when its operational priority
has been agreed, and update cursor/version contracts if persisted pagination
depends on the old order.

Verification: `npx vitest run core/sorting`.
