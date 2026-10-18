# Background Worker Framework

Long-running and retryable work does not belong inside request handlers.
`core/workers/` provides a small, dependency-free, in-process queue for
delayed and retryable jobs, produced by `createWorkerFramework()`.

- **Job payload** — `{ id, operation, params, dedupeKey?, maxAttempts,
  attempts, status, enqueuedAt, nextAttemptAt?, lastError?, correlationId }`.
- **Retry policy** — exponential backoff (`delay * 2^(attempt-1)`); when a job
  exhausts its attempts it is **dead-lettered**, keeping its payload and error
  context for inspection.
- **Dead-letter behavior** — `status: "dead_lettered"` with `lastError`
  preserved; jobs never silently disappear.
- **Idempotent reprocessing** — `dedupeKey` makes re-enqueueing a pending job a
  no-op, and `processJob(id)` leaves a finished job untouched.
- **Guarded transitions** — every status change goes through the `worker_job`
  lifecycle table in `core/lifecycle/records.ts`. A move the table omits is
  refused with a stable code (`terminal_state`, `invalid_transition`) instead of
  silently writing a status; see [LIFECYCLE.md](./LIFECYCLE.md).

## Lifecycle

```
enqueue ──► queued ──► running ──► succeeded          (terminal)
                │          │
                │          └─► retrying ──► running (again)
                │              │    │
                │              │    └─retry─► queued
                │              └─exhaust─┐
                └───dead_letter───────────┴──► dead_lettered (terminal)
```

## Using it

```ts
import { createWorkerFramework } from "@/core/workers/queue";

const workers = createWorkerFramework({ retryDelayMs: 250, maxAttempts: 3 });

workers.register("mail.send", async (params, { correlationId }) => {
  // work…
}, { maxAttempts: 5, retryDelayMs: 500 });

const job = workers.enqueue({
  operation: "mail.send",
  params: { to: "alice@example.com" },
  dedupeKey: "mail/alice/2026-09-25",
  delayMs: 5_000
});

// somewhere that owns the run loop:
workers.drainDueJobs();
```

Inspect with `inspect()`, `getById(id)` and `retryJob(id)`.

`retryJob(id)` and `deadLetter(id)` return a `Result`, not a bare payload,
because a settled job cannot be moved:

```ts
const retried = workers.retryJob(job.id);
if (!retried.ok && retried.code === "terminal_state") {
  // `succeeded` / `dead_lettered` — the handler will not run again.
}
```

`canTransition(status, event)` answers the same question without mutating
anything, and `stateView("worker_job", job.status)` is what a UI badge or an API
response should render.

## Retried submissions

`submit()` is the guarded enqueue: it takes an `idempotencyKey`, records the
outcome and replays it for a retried request, so a double submission cannot
queue the job twice. See [IDEMPOTENCY.md](./IDEMPOTENCY.md).

```ts
const first = workers.submit({ operation: "mail.send", idempotencyKey: requestId });
// …the response is lost and the client retries with the same key…
const retry = workers.submit({ operation: "mail.send", idempotencyKey: requestId });
retry.ok && retry.value.replayed; // true — same job id, one queued job
```

## Reconciliation dry run

`core/reconciliation/` registers `reconciliation.dry_run`: a read-only job that
compares stored records against derived balances and emits a drift report. The
job never repairs: a repair is planned from the report and applied only by an
explicit, confirmed call outside the worker queue — see
[RECONCILIATION.md](./RECONCILIATION.md).

## Moving one operation in already

The Horizon client cache prune was previously a plain call inside request
handlers. It is now the registered `maintenance.prune_horizon_clients` job in
`core/workers/maintenance.ts`. `NetworkProvider.setNetwork()` enqueues it with
a 1s delay so a rapid network switch settles before the cache is torn down.

## Local development

Workers run in-process, so there is no separate daemon. Two workflows:

```bash
npm run test:workers      # the worker suite: retry exhaustion, dedupe, idempotence
npm run check             # full CI gate, includes these tests
```

To watch a job live during development, run the maintenance test in watch mode:

```bash
npm run test:watch -- core/workers
```

To observe a live drain, switch networks in the running app (the prune job is
enqueued) and call `drainDueJobs()` from your console — the job and its
telemetry will appear as structured lines.

## Telemetry

Each job emits `worker.run` (success) or `worker.retry` / `worker.exhausted`
(failure) telemetry with latency, error code and the job's correlation id. See
[docs/TELEMETRY.md](./TELEMETRY.md) for the dashboard queries.