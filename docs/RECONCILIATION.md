# Reconciliation

Utix stores records (worker jobs, notifications, export envelopes, idempotency
claims) and it also *shows* numbers it read from a Stellar ledger. Nothing
guaranteed those two worlds stayed in agreement: a cached balance could drift
from the ledger, a job could sit in `retrying` for an hour, an envelope could
outlive its retention window, an idempotency claim could never settle.

`core/reconciliation/` compares the source of truth with the cached and derived
projections in three steps, each safer than the next one is powerful:

1. **Detect** — `reconcile(snapshot)` produces a read-only dry-run report.
2. **Explain** — every finding carries a `rootCause` hint derived from evidence
   in the same snapshot.
3. **Repair (optional)** — `planRepairs(report, snapshot)` produces a dry-run
   plan; `applyRepairPlan(plan, …)` executes it only with maintainer
   permission, explicit confirmation, and a fresh re-check of the source.

The ledger is authoritative and is never written. Every repair moves a cached
or derived record toward the source of truth.

## The four drift kinds

| Kind | Means | Example invariant |
| --- | --- | --- |
| `missing` | a record exists on one side, not the other | a stored balance with no ledger entry |
| `duplicate` | two records claim one identity | two pending jobs sharing a `dedupeKey` |
| `stale` | a record is still open past its deadline | a `retrying` job past its backoff, an expired idempotency record |
| `inconsistent` | two fields of one record disagree | stored balance ≠ ledger balance; a job past its retry budget that is not terminal |

Every invariant is declared once, in `RECONCILIATION_INVARIANTS`, with its
statement and its repair guidance. A finding copies the guidance onto itself, so
a report is actionable without the source open.

## Running a dry run

```ts
import { reconcile, formatReport } from "@/core/reconciliation/reconciliation";

const report = reconcile({
  storedBalances,   // what the app stored and showed
  ledgerBalances,   // what Horizon reports now, with a settlement reference
  jobs,             // JobPayload[]
  notifications,    // Notification[]
  idempotencyRecords,
  exportEnvelopes,
  operations,       // retained measured operations
  now: Date.now(),
  staleAfterMs: 5 * 60_000
});

console.log(formatReport(report));
report.dryRun; // always true
report.clean;  // false when any finding is `critical` (i.e. inconsistent)
```

As a registered worker operation, which is how it runs in the app:

```ts
import { registerReconciliation, RECONCILIATION_DRY_RUN_OP } from "@/core/reconciliation/job";
import { createWorkerFramework } from "@/core/workers/queue";

const framework = createWorkerFramework();
const runNow = registerReconciliation({ framework, providers: { read: () => snapshot() } });

framework.enqueue({ operation: RECONCILIATION_DRY_RUN_OP, delayMs: 1_000 });
framework.drainDueJobs();

// Or synchronously, which is what a CLI or a test wants:
const result = runNow();
```

The run itself has a lifecycle (`reconciliation_run`: `pending → collecting →
analyzing → reported`, with `failed` and `cancelled` as terminal states), so a
crashed run is as inspectable as a job.

## Root-cause hints

A finding says *that* a record drifted; `finding.rootCause` says *why it
probably did*:

```ts
{
  code: "cache_stale",          // stable, switchable
  confidence: "likely",         // or "possible"
  hint: "The line was cached 3600s ago, longer than the staleness window; …",
  evidence: ["cache_age_s=3600", "reference=ledger:100"]
}
```

Hints are computed only from the snapshot, so they are cheap, deterministic and
testable, and they are scrubbed for secrets like the rest of the finding.
`likely` means the evidence points one way; `possible` means it is the best of
several explanations and a human should confirm it.

| Invariant | Cause codes |
| --- | --- |
| `balance.ledger_entry_present` | `ledger_read_empty`, `trustline_removed`, `account_not_loaded` |
| `balance.amount_agrees` | `precision_mismatch`, `cache_stale`, `cache_age_unknown`, `write_race` |
| `balance.single_line_per_asset` | `concurrent_cache_write`, `duplicate_write_path` |
| `worker_job.state_declared` | `legacy_status`, `bypassed_lifecycle` |
| `worker_job.budget_consistent` | `handler_failing`, `attempt_counter_drift` |
| `worker_job.dedupe_unique` | `double_submit`, `missing_idempotency_key` |
| `worker_job.progress` | `scheduler_not_draining`, `backoff_not_rescheduled`, `job_not_picked_up` |
| `idempotency.claim_fresh` | `sweep_not_scheduled`, `claim_abandoned` |
| `export_envelope.count_matches` | `truncated_write`, `count_not_updated` |
| `export_envelope.retention` | `retention_sweep_missing` |
| `notification.state_declared` | `bypassed_lifecycle` |
| `notification.identity_unique` | `double_publish` |
| `operation.settles` | `process_interrupted`, `unknown_state` |

Some hints are correlated across the snapshot on purpose. `ledger_read_empty`
fires when the snapshot holds no ledger lines at all, which almost always means
the ledger read failed rather than that every balance vanished.
`scheduler_not_draining` fires when *every* pending job is overdue, which is a
queue outage rather than one stuck job. The planner relies on both (see below).

`formatReport` prints the hint as a `cause:` line under each finding.

## Repair: dry run first, always

```ts
import { createRepairWorkflow, formatRepairPlan } from "@/core/reconciliation";

const workflow = createRepairWorkflow({ read: snapshot, handlers });

// 1. Dry run: one read, a report and a plan. Writes nothing.
const dry = workflow.dryRun();
if (!dry.ok) throw new Error(dry.code);
console.log(formatRepairPlan(dry.value.plan));

// 2. A maintainer reviews the plan, then applies it by echoing its id back.
const applied = workflow.apply(dry.value.plan, {
  auth: { role: "maintainer", userId: "ada" },
  confirm: dry.value.plan.planId,
  // only: ["recache_balance:G1|USDC"],   // optional subset
  // allowIrreversible: true,             // opt in to terminal moves
});

// 3. If needed, undo a completed repair from its journal.
if (applied.ok) workflow.rollback(applied.value, { role: "maintainer", userId: "ada" });
```

There is no single call that plans and applies, and the worker queue never
applies a plan. Scheduled runs only report and plan.

### What a plan contains

Each `RepairAction` names its `kind`, its `target` (the raw identity a handler
needs), the `before` state the dry run saw, the `after` state it will write,
the `lifecycleEvent` when the move is a transition, `reversible`, a `risk` and
human `rollback` text. `plan.manual` lists every finding the planner refused to
touch, with the reason. `plan.fingerprint` is a SHA-256 over the actions.

| Invariant | Strategy | Reversible | Refused (→ manual) when |
| --- | --- | --- | --- |
| `balance.amount_agrees` | `recache_balance` to the ledger amount | yes | the asset is on several lines (dedupe first) |
| `balance.ledger_entry_present` | `drop_balance_line` | yes | the cause is not `trustline_removed`, i.e. the ledger may not have been read |
| `balance.single_line_per_asset` | `dedupe_balance_lines`, keep newest `cachedAt` | yes | — |
| `worker_job.budget_consistent` | `dead_letter_job` | no | — |
| `worker_job.dedupe_unique` | `cancel_duplicate_job`, keep oldest | no | every duplicate is already being dead-lettered |
| `worker_job.progress` | `requeue_job` (`retry` event) | yes | the cause is `scheduler_not_draining`, or the job is being dead-lettered |
| `idempotency.claim_fresh` | `sweep_idempotency` | no | the claim is unexpired: its work may still be running |
| `export_envelope.retention` | `purge_envelope` | no | — |
| `notification.state_declared` | `drop_notification` | no | — |
| `notification.identity_unique` | `collapse_notification` | no | — |
| `worker_job.state_declared` | manual | — | always: needs a lifecycle decision |
| `export_envelope.count_matches` | manual | — | always: regenerate under a fresh idempotency key |
| `operation.settles` | manual | — | always: re-run the read-only operation |

Any finding whose identity was redacted (a secret pasted into a key field) is
always manual: it is a security incident, not a cache repair.

### The guards on apply

`applyRepairPlan` checks all of these before its first write, in this order,
and returns a `Result` code instead of throwing:

| Code | Guard |
| --- | --- |
| `repair_denied` | caller lacks `admin:recovery`; an unknown role fails closed |
| `confirmation_required` | `confirm` is not the plan's `planId` |
| `plan_tampered` | the actions no longer hash to `plan.fingerprint` |
| `plan_expired` | the plan is older than `REPAIR_PLAN_TTL_MS` (15 min) |
| `nothing_selected` | `only` and the irreversible filter left nothing to run |
| `blast_radius_exceeded` | more than `maxActions` (default 50) actions selected |
| `handler_missing` | a selected kind has no handler, or a reversible one has no `revert` |
| `snapshot_unavailable` | the fresh re-read threw or returned no snapshot |
| `plan_stale` | re-planning against the fresh read no longer yields an approved action with the same target, `before` and `after` (clock fields aside) |

Then it applies actions in order, journaling each. On the first handler error
it reverts the journal newest-first and returns `repair_failed` with
`failedAction`, `rolledBack` and `rollbackFailed`. After a successful run it
reads the source again and splits targeted findings into `verified` (gone) and
`stillDrifting` (still reported).

Every applied, reverted or refused action is audited as
`reconciliation.repaired` with primitive `before`/`after` context, and each run
emits one `reconciliation.repair` telemetry record.

### Writing handlers

The module owns no storage. A deployment supplies `RepairHandlers`:

```ts
const handlers: RepairHandlers = {
  recache_balance: {
    apply: (action) => balanceCache.put(action.target.account, action.target.asset, action.after),
    revert: (action) => balanceCache.put(action.target.account, action.target.asset, action.before)
  },
  dead_letter_job: {
    apply: (action) => framework.deadLetter(action.target.jobId) // through the lifecycle table
  }
};
```

Rules for a handler:

- **Go through the lifecycle** when `action.lifecycleEvent` is set, so the move
  is legal and audited as `record.state_changed` like any other.
- **Throw on failure.** A swallowed error is reported as applied and only shows
  up later as `stillDrifting`.
- **Be idempotent.** Re-applying an action whose `after` is already in place
  must be a no-op, because a crash between the write and the journal is
  possible.
- **Make `revert` restore `before` exactly.** It is what the automatic
  rollback and `rollbackRepair` call.

## Operational edge cases

- **Partial ledger read.** An empty `ledgerBalances` makes every stored line
  look `missing`. The cause is `ledger_read_empty` and the planner refuses to
  drop anything. Fix the read and re-run.
- **Unfunded or merged account.** No ledger lines for one account gives
  `account_not_loaded`, which is manual. Re-read the account before dropping its
  cache.
- **Ledger moved during the run.** A recache writes the ledger amount the dry
  run saw. If the ledger closes again before apply, the re-plan wants a
  different `after`, so the apply refuses with `plan_stale`. Only clock-stamped
  fields (`cachedAt`, `nextAttemptAt`) may differ. If the ledger moves *after*
  the re-check, the verification read reports it as `stillDrifting`, and the
  next run picks it up. An apply is not atomic with the ledger.
- **Someone fixed it in between.** If a record changed or the finding vanished
  after the dry run, the apply refuses with `plan_stale` and writes nothing.
  Run a new dry run.
- **Several findings, one record.** A job that is both overdue and over budget
  is only dead-lettered, never requeued. Three lines for one asset produce one
  dedupe action, not two.
- **Duplicate jobs.** The oldest pending job by `enqueuedAt` survives. If the
  newest one carries newer params, cancel manually instead.
- **Clock skew.** Every age check uses the injected `now`. A worker with a fast
  clock sees jobs as stale early. Pass the same clock to `dryRun` and `apply`.
- **Large drift.** More than 50 actions is treated as an incident, not a
  routine repair. Raise `maxActions` deliberately, or apply in `only` batches.
- **Precision.** Amounts are compared as decimal strings, never floats. A side
  with more than 7 decimal places is flagged `precision_mismatch`. Fix the
  converter, not the number.

## Failure modes

| Symptom | Likely cause | What happens | Recovery |
| --- | --- | --- | --- |
| `snapshot_unavailable` on dry run | provider threw (Horizon or storage down) | no report, no plan | fix the provider; never act on a partial report |
| `plan_stale` | state moved after the dry run | no writes | new dry run, review, apply again |
| `plan_expired` | review took longer than 15 min | no writes | new dry run |
| `plan_tampered` | plan edited or rebuilt by hand | no writes | apply only plans `planRepairs` produced |
| `handler_missing` | deployment lacks a handler or a `revert` | no writes | add the handler, or apply with `only` |
| `repair_failed`, `rollbackFailed` empty | a handler threw mid-run | applied actions reverted | fix the handler and re-run from a new dry run |
| `repair_failed`, `rollbackFailed` non-empty | a revert also failed | some writes remain | see *Recovery* below |
| `ok` with `stillDrifting` | a handler did not actually write, or the source moved | applied, not fixed | inspect the handler; re-run the dry run |
| `ok` with `verificationRan: false` | the verification read failed | applied, not verified | run a fresh dry run once the source is back |

## Rollback and recovery

1. **Automatic rollback.** A failed apply reverts every journaled action in
   reverse order before it returns. The audit trail shows `<kind>.applied` and
   no matching `<kind>.reverted` for anything that stayed.
2. **Rolling back a successful apply.** Keep the `RepairOutcome` and call
   `workflow.rollback(outcome, auth)`. Reversible actions are reverted
   newest-first. Irreversible ones come back in `manual`, and each action's
   `rollback` text says what to do. The drift reappears, which is expected:
   rollback restores the projection, not the truth.
3. **Rolling back without the outcome object.** Filter the audit trail for
   `reconciliation.repaired` by the run's `correlationId`. Each `applied` event
   holds the action's `before` context; restore it through the same handler.
4. **When `rollbackFailed` is non-empty.** Those records hold `after` values.
   Every `after` moves toward the ledger, so leaving them is safe for balances.
   For job and notification moves, read the action's `rollback` text. Then run
   a dry run to confirm the state is consistent.
5. **Irreversible actions.** Dead-lettering, sweeps and purges cannot be undone
   through the lifecycle. That is why they are opt-in (`allowIrreversible`) and
   why the plan marks them. Recover by re-enqueueing, or regenerating under a
   fresh idempotency key.
6. **Disabling repair entirely.** Remove the handlers or stop calling `apply`.
   Detection and planning keep working, and nothing else depends on repair.

## Why detection is safe to run anywhere

- **Pure.** Every check, every hint and the planner are functions of the
  supplied snapshot. The engine contains no storage write, no filesystem write
  and no assignment into the snapshot, and the suites freeze the snapshot to
  prove it.
- **Injected clock and sources.** `now` and the provider are arguments, so CI
  can point a run at a fixture and get the same report every time.
- **Read failure is loud.** A provider that throws yields
  `snapshot_unavailable` and no report at all, rather than a partial one that
  looks clean.
- **Redacted.** A finding quotes record values, so an embedded secret is
  scrubbed (`scrubSecrets`) before the report is built, and the report passes
  through `core/telemetry`'s `redact()` on the way out.

`npm run verify:reconciliation` is the CI guard. It fails if:

- an invariant is declared but never checked, or checked but never declared;
- an invariant has no repair strategy;
- a drift kind disappears;
- the engine or job grows a write path;
- the repair path loses a guard: confirmation, stale-plan refusal, tamper
  check, permission check, rollback, or irreversible opt-in.

## Compatibility

Every change to the existing surface is additive. `rootCause` is an optional
field on a finding, `formatReport` gains a `cause:` line, and the new
`reconciliation.repaired` audit action and `reconciliation.repair_plan`
contract sit beside the old ones. `reconcile()`, `ReconciliationReport` and the
`reconciliation.dry_run` job keep their shape and behavior, so no migration is
needed. A consumer that parses `formatReport` line by line should ignore
unknown indented lines.

## Adding an invariant

1. Add the entry to `RECONCILIATION_INVARIANTS` with its `kind` and `repair`.
2. Add a check to the `checks` table using `finding(invariant, …)` and pass a
   `rootCause`. The helper throws if the invariant is undeclared.
3. Add the invariant to `REPAIR_STRATEGIES`. Use `"manual"` unless the repair
   is safe to automate from the snapshot alone.
4. Add scenarios to the suites: the drift, its cause, and its repair or its
   refusal.
5. Run `npm run verify:reconciliation` and `npm test -- core/reconciliation`.

```bash
npm run verify:reconciliation   # invariants wired, no write path, repair guards intact
npm test -- core/reconciliation # drift, causes, plan/apply/rollback
```
