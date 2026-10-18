# Versioned Event Replay

`core/replay/` rebuilds read-model projections from the append-only event log.
It complements [STALE_CACHE_REPAIR.md](./STALE_CACHE_REPAIR.md): the stale
detector tells you *that* a projection is wrong; replay is how you rebuild it.

```ts
import { createMemoryProjectionStore, createUpcasterRegistry, replayProjection, rollbackProjection } from "@/core/replay";

const result = await replayProjection(balancesV2, { source, store, auth, upcasters }, { promote: true });
if (!result.ok) console.error(result.code, result.detail); // detail.checkpoint is where `resume` continues
```

Run the suite with `npm run verify:replay`.

## Model

Two independent version numbers:

| Version                  | Lives on                       | Changes when                                  |
| ------------------------ | ------------------------------ | --------------------------------------------- |
| **Event schema version** | `ReplayEvent.version`          | an event's payload shape changes              |
| **Projection version**   | `ProjectionDefinition.version` | the reducer or the projected state changes    |

- **Events are never rewritten.** A projection declares the schema version it
  expects per event type (`eventVersions`); older events are lifted one step at
  a time by registered `Upcaster`s on read. Types a projection does not list
  are ignored (they still advance the checkpoint).
- **Each projection version is built in its own slot** (`name@vN`). Readers
  follow an *active pointer* (`{ version, previousVersion }`). A rebuild never
  writes the live slot, so readers never see a half-built projection.
- **Promotion is one atomic pointer write** (`store.setActive`), after the build
  reaches the head of the log *and* `validate(state)` returns no violations.
- **Rollback is the same pointer write in reverse.** The previous slot is kept.

## Modes

| Mode / flag     | Behaviour                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------- |
| `rebuild`       | Default. Starts from sequence 0 and discards any partial slot of that version. Refuses the live version (`version_active`). |
| `resume`        | Continues a `building`/`failed` slot from its checkpoint. On the **live** version it is a catch-up: the new state is committed once, after validation, so the live slot only ever moves between validated states. |
| `dryRun`        | Builds in memory and returns `state` in the report. No slot writes, no lock, no promotion. Audited with reason `dry_run`. |
| `promote`       | Swap the active pointer after a successful build. Without it the slot ends `ready` and can be promoted later with `promoteProjection`. |
| `untilSequence` | Point-in-time build: stop after this sequence (useful to bisect a bad event). |

## Failure handling

All expected failures return `Result` codes (see `ReplayErrorCode`); nothing
throws through the runner. Every failure detail carries `checkpoint` — the last
event durably folded into the slot.

| Code                        | Cause                                                       | Retried? | Recovery |
| --------------------------- | ----------------------------------------------------------- | -------- | -------- |
| `source_unavailable`        | Event source read kept failing                              | Yes: `maxRetries` (default 3), backoff `retryDelayMs · 2^n` | Fix the source, then `resume`. |
| `poison_event`              | `apply` or an upcaster threw for one event                  | No — `apply` is pure, so a retry would fail identically | Ship a forward fix to the reducer/upcaster, then `resume`; or rerun with `poisonPolicy: "skip"` and an explicit `maxSkipped`. |
| `too_many_skipped`          | `skip` policy exceeded `maxSkipped`                         | No       | Investigate `detail.eventId`; raise the bound only deliberately. |
| `unsupported_event_version` | No upcaster path, or event newer than the projection        | No, and **never skipped** — it is a deploy gap, not bad data | Register the missing upcaster or bump `eventVersions`, then `resume`. |
| `sequence_out_of_order`     | Source returned a sequence ≤ the checkpoint (duplicate or reorder) | No | Source bug; fix it before resuming. Gaps in the sequence are fine. |
| `validation_failed`         | `validate(state)` reported violations                       | No       | Slot is left `failed` with its state for inspection; nothing is promoted. |
| `replay_in_progress`        | Another run holds the projection lock, or this run lost it after a pause | No | Wait for the owner. A run that lost the lock writes nothing, so `resume` continues from the owner's checkpoint. |
| `version_active`            | `rebuild` targeted the live version                         | No       | Bump the projection version, or use `resume` to catch up. |
| `nothing_to_resume`         | `resume` with no slot for that version                      | No       | Use `rebuild`. |
| `replay_unauthorized`       | Caller lacks `admin:replay`                                 | No       | Audited with outcome `denied`. |
| `invalid_options`           | Bad batch size, retry bound, `dryRun`+`promote`, …          | No       | Fix the call. Not audited — no work was attempted. |

## Operational edge cases

- **Crash mid-run.** The staging slot is written after every batch, so at most
  one batch is replayed again on `resume`. The lock is refreshed before each
  batch and expires after `lockTtlMs`; a crashed run blocks others for at most
  that long. Choose `lockTtlMs` comfortably above one batch plus its retry
  budget.
- **Events appended during a rebuild.** The runner reads until the source
  returns an empty batch, so a promoted slot is caught up to the moment of
  promotion. Events after that are the live projector's job, starting from the
  slot's `checkpoint`; `resume` on the live version does the same thing on demand.
  A write that becomes visible before the final empty read is included; a write
  that lands after promotion is not silently folded into that build.
- **Concurrent replays.** The lock is per projection name, not per version, so a
  rebuild of `balances@v2` and a catch-up of the live `balances@v1` serialise,
  while different projections run concurrently. A `dryRun` takes no lock and
  writes nothing, so it can be used for a read-only comparison beside a build.
- **A run that loses its lock stops without writing.** The lock is re-checked
  before every slot write and before the final ready/promote commit. If this
  process paused past `lockTtlMs` and another run acquired the lock, the stale
  run returns `replay_in_progress` and leaves the new owner's slot untouched —
  it does not even write a `failed` marker over it. If the lock expired but no
  one took it, the same owner simply reacquires it and continues.
- **Promotion and rollback are pointer writes, not lock-protected.**
  `promoteProjection` and `rollbackProjection` perform one atomic `setActive`;
  they do not take the replay lock. Operator tooling must serialise a pointer
  change with a running replay, because the last pointer write wins. Only a
  `ready` slot can be a target, so a failed or half-built version can never be
  promoted or rolled back to.
- **Retries are per read, not per run.** `report.retries` is the total across
  the run; a flapping source can succeed overall while still retrying. A retry
  does not release the lock, so a competing run cannot slip between attempts.
- **Skipped events are permanent holes** in that build. They are listed in
  `report.skipped` and counted in the audit event; the default `maxSkipped` is 0.
- **Ignored and skipped events advance the checkpoint**; a halted event does not.
- **Reports count the current run only**; the slot's `eventsApplied` is the
  running total across resumes.
- **The store contract.** `createMemoryProjectionStore` is the reference. A
  durable adapter must make `putSlot`, `setActive` and `acquireLock` each atomic
  on their own; `setActive` is the commit point of a promotion. `acquireLock`
  must return `false` for a live owner other than the caller, and the runner
  treats that as “stop, write nothing”.

## Deterministic concurrency and retry tests

The replay suite has two layers:

| File | What it proves |
| --- | --- |
| `core/replay/__tests__/replay.test.ts` | The normal, failure, retry, authorization and rollback contracts. |
| `core/replay/__tests__/replay.deterministic.test.ts` | The same paths under interleaved writes, lock contention and scripted source failures. |

Run the focused suite with `npm run verify:replay-concurrency`, or run both
with `npm run verify:replay` / `npm test -- core/replay`.

The deterministic harness (`__tests__/deterministicHarness.ts`) removes the two
sources of flakiness in a concurrency test:

- **Time.** Every run gets an injected clock; no test waits or reads
  `Date.now()`. Advancing the clock is an explicit step, so lock expiry and TTL
  refresh are deterministic.
- **Ordering.** An append-only log exposes scripted write windows: events are
  appended immediately before a chosen read attempt, so a write lands at an
  exact point in the replay. A seeded PRNG (`mulberry32`) places the same writes
  in different windows or generates the same plan twice. Source failures are
  scripted by read index, so the retry/backoff trace is reproducible.

The matrix below is covered:

| Path | Interleaving under test |
| --- | --- |
| Normal rebuild | Writes appended while source reads are in flight; the final state equals a serial fold and the checkpoint reaches the head. |
| Point-in-time rebuild | `untilSequence` ignores writes appended after the snapshot. |
| Determinism | The same seed produces an identical read trace, backoff schedule, apply order and slot; the same writes in different windows converge to one state. |
| Lock contention | Two simultaneous rebuilds: one wins, the loser reads nothing and writes nothing; it can resume after the lock is released. |
| Lock scope | Different projections run concurrently; the same projection serialises rebuild and catch-up. |
| Lost lock | A run that pauses past its TTL and loses the lock to a new owner stops with `replay_in_progress` and does not overwrite that owner's slot. |
| Retrying lock | A source failure backs off while the lock stays owned; a competitor is refused between attempts. |
| Poison event | A halt leaves the last good checkpoint; a resume after the forward fix includes writes appended during the halt. |
| Racing source | A duplicate/out-of-order sequence is refused and the slot stays unpromoted. |
| Retry exhaustion | The checkpoint is durable; a second run resumes from it and converges over writes the first run never saw. |
| Authorization | Viewer/service runs are refused before they can take the lock, and a denied rollback cannot race an authorized promotion. |
| Rollback recovery | Rollback restores the previous ready checkpoint; resuming it catches up over writes appended after the rollback. |

## Rollback

```ts
rollbackProjection("balances", { store, auth });      // v2 -> v1
rollbackProjection("balances", { store, auth });      // v1 -> v2 again (roll forward)
promoteProjection("balances", 3, { store, auth });     // any `ready` slot
```

- Only a `ready` slot can become active (`no_previous_version` otherwise), so a
  failed or half-built version can never be rolled *to*.
- The restored slot stops at its own checkpoint. After a rollback, run
  `replayProjection(v1, deps, { mode: "resume" })` to catch it up — it commits
  once, after validation.
- Both promotion and rollback are audited as `projection.activated` with the
  before/after version.

## Authorization and audit

- All entry points require the `admin:replay` permission, held by `maintainer`
  only (not `viewer`, not `service`). Denials return `replay_unauthorized` and
  are recorded with outcome `denied`. See [RBAC.md](./RBAC.md).
- `projection.replayed` is recorded for every authorized run (success or
  failure, including dry runs) with counts and checkpoints only — never event
  payloads or state. See [AUDIT.md](./AUDIT.md).

## Compatibility and migration

This is additive; no existing contract changes:

- New permission `admin:replay` is granted to `maintainer` only. Existing role
  checks are unaffected.
- Two new audit actions are appended to `SENSITIVE_ACTIONS`; `verify:audit`
  checks their emitters.
- **Adopting replay for an existing projection:** wrap it as a
  `ProjectionDefinition` with `version: 1`, `rebuild` with `promote: false`,
  compare the slot's state to the current read model (a `dryRun` works too),
  then `promoteProjection`. Until promotion nothing reads from the new slot.
- **Changing an event schema:** bump the event's `version` for new writes,
  register an `Upcaster` from the old version, and bump the projection's
  `eventVersions` entry and `version`. Rebuild, promote; keep the old slot until
  you are confident, then roll back with one call if needed.
- **Lock ownership is now re-checked before every slot write.** This tightens
  behaviour for a run that outlives its lock; it adds no error code (`replay_in_progress`
  already existed), record shape or permission. Existing callers need no change.
  A durable `ProjectionStore` adapter must implement `acquireLock` atomically
  and return `false` when another live owner holds the lock. There is no data
  migration: failed/lost-lock runs now simply leave the slot to the new owner.
