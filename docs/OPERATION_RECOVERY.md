# Recovering interrupted multi-step operations

A flow with three steps in it is a flow that can stop with two of them done. A
wallet rejects the signature on the last step, a relayer stops answering after
accepting the request, a worker dies between two writes, or the user simply
closes the tab while a transfer is in flight. The next question is always the
same and always urgent: **what already happened, and what do I do now?**

`core/operations/` answers it. A recoverable operation writes a checkpoint
*before* each step is attempted, decides what to do next from that checkpoint
alone, and hands the caller a plain-language action whenever a human has to make
a call.

## What this is not

| Module              | Question it answers                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- |
| `core/idempotency`  | "This single request arrived twice — how do I do the work once?"                      |
| `core/operations`   | "This multi-step flow stopped half way — what already happened, and what now?"        |
| `core/recovery`     | "After a restore, is the stored data still internally consistent?"                    |

`core/operations` lifts the idempotency idea from the request to the flow: each
step carries a stable key, so a retry after a crash is presented to the outside
world as *the same request*, never a second one.

## Mapping onto a real flow

The repo already has write-shaped flows that are multi-step operations: a worker
job that is claimed, run, and then completed or dead-lettered; a webhook
delivery that is built, sent, and acknowledged; an export that is generated,
uploaded, and recorded. Each is `prepare → perform → confirm`, and any of those
steps can stop half way with the earlier ones already done.

The examples below use a ticket redemption (`issue → transfer → redeem`)
because it makes the external side effect obvious, but the states, the
checkpoints and the recovery rule are identical for any of those flows.

## Operation states

The states and the moves between them are declared once, in
`operationMachine`, and enforced by `core/lifecycle`. Every transition is
audited, so "who moved this operation, and why" is answerable later.

| State         | Meaning                                                                 | Exits                             |
| ------------- | ----------------------------------------------------------------------- | --------------------------------- |
| `pending`     | created, nothing attempted yet                                          | `start`, `abandon`                |
| `running`     | a step is being attempted                                               | `complete`, `interrupt`, `fail`, `abandon` |
| `interrupted` | stopped part-way; a decision or a confirmation is needed                | `resume`, `complete`, `fail`, `abandon` |
| `completed`   | every step succeeded (terminal)                                         | —                                 |
| `failed`      | a step reported a definite failure, and nothing landed                  | `retry`, `abandon`                |
| `abandoned`   | given up on deliberately, record kept for the audit trail (terminal)    | —                                 |

`failed` is recoverable on purpose: a step that *reports* a failure is telling
the flow that its side effect did not happen, so retrying it is safe.
`completed` and `abandoned` never move again.

## Checkpoints

One checkpoint per declared step, in declaration order. The record is plain
JSON, so it survives a reload and can be replayed in a test.

| Field                | Why it exists                                                                   |
| -------------------- | ------------------------------------------------------------------------------- |
| `id`                 | the declared step id                                                            |
| `status`             | `pending` / `running` / `succeeded` / `failed` / `skipped` / `interrupted`       |
| `attempt`            | 1-based, bumped only when the step is actually attempted again                   |
| `idempotencyKey`     | stable for the life of the operation, handed to the external call               |
| `sideEffectCommitted`| `true` once the step reported that its effect reached the outside world         |
| `output`             | what the step produced, replayed instead of re-running the step                 |
| `errorCode`          | the code the step reported, e.g. `confirmation_timeout`                         |

## The recovery rule

The whole policy is four lines, and it reads only the checkpoint:

```ts
function decideStep(checkpoint: StepCheckpoint): StepDecision {
  if (checkpoint.status === "succeeded" || checkpoint.status === "skipped") return "skip";
  if (checkpoint.sideEffectCommitted) return "confirm";
  return "run";
}
```

That gives the three interruption timings the acceptance criteria ask about:

| When the step stopped                                            | Checkpoint                       | What the next run does                                  |
| ---------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| **before** the effect — the step reported a failure              | `failed`, not committed          | retries the step with the same idempotency key           |
| **during** it — no report at all: throw, crash, closed tab       | `running`, not committed         | retries the step with the same idempotency key           |
| **after** it — reported submitted, result never confirmed        | `interrupted`, committed         | stops; a human confirms the external outcome first       |

The third row is the one that protects funds. When a step says "the request
left but I could not confirm it", running it again could apply the effect twice,
so the flow refuses to guess and waits for
`resolveInterruptedStep(id, stepId, "applied" | "not_applied")`.

Nothing here retries on a timer or in the background. `runOperation` is called
by a caller that deliberately starts or resumes a flow, which keeps a stuck
operation visible instead of silently looping.

## Using it

```ts
import { createAdapterOperationStorage, runOperation } from "@/core/operations";
import type { OperationDefinition, StepDefinition, StepRunInput } from "@/core/operations";
import type { Result } from "@/core/result/result";

/** Adapts a Result-returning call — the repo's convention — to a step outcome. */
function step<C>(
  id: string,
  run: (input: StepRunInput<C>) => Promise<Result<unknown, string>>
): StepDefinition<C> {
  return {
    id,
    async run(input) {
      const outcome = await run(input);
      return outcome.ok
        ? { status: "succeeded", output: outcome.value }
        : { status: "failed", errorCode: outcome.code };
    }
  };
}

const definition: OperationDefinition<Ctx> = {
  kind: "ticket_redemption",
  steps: [
    step("issue", (input) => issueTicket(input.context, input.idempotencyKey)),
    step("transfer", (input) => transferTicket(input.context.recipient, input.idempotencyKey)),
    step("redeem", (input) => redeemTicket(input.idempotencyKey))
  ]
};

// Persist checkpoints across reloads. Anything with getItem/setItem works.
const storage = createAdapterOperationStorage(globalThis.localStorage);

const result = await runOperation(definition, {
  operationId: `redeem:${eventId}`,
  context: { recipient },
  storage,
  actor: `account:${publicKey}`
});

if (!result.ok) return reportBug(result.code); // storage_error / invalid_operation
if (result.value.state === "completed") return showSuccess("Ticket redeemed");

// `action.message` is written for the person looking at the screen.
return showBanner(result.value.action?.message ?? "This redemption stopped.");
```

Calling `runOperation` again is the recovery path: it replays the checkpoints
instead of the steps. A step already recorded as `succeeded` is never called a
second time.

## What the user sees

`RecoveryAction.message` is user-facing copy; the other fields are for the
diagnostics surface.

| `action.code`           | Shown when                                     | Suggested UI                                            |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `retry_step`            | the step stopped before anything landed        | a "Try again" button that re-runs the operation          |
| `confirm_external_state`| an effect was submitted but not confirmed      | "We are checking your transfer" + a support path         |
| `abandon_operation`     | reserved for a caller that decides to give up  | close the flow, keep the record                          |

## Maintainer diagnostics

```ts
import { stuckOperations, summarizeOperation } from "@/core/operations";

// Unfinished operations, oldest first, each with the action that unblocks it.
const stuck = stuckOperations(storage.list(), { now: () => Date.now() });
for (const entry of stuck) {
  console.warn(entry.operationId, entry.state, entry.ageMs, entry.action.code);
}

// One record, rendered for a support thread or a bug report.
const { headline, stepLines, nextAction } = summarizeOperation(record);
```

An operator who confirmed what happened outside the app then unblocks the
operation and lets the flow continue from where it stopped:

```ts
resolveInterruptedStep(`redeem:${eventId}`, "transfer", "applied", {
  storage,
  actor: "maintainer:ana",
  reason: "confirmed transfer on-chain"
});

await runOperation(definition, { operationId: `redeem:${eventId}`, context, storage });
// → resumes at `redeem`; `issue` and `transfer` are not run again.
```

`abandonOperation(id, { storage, actor, reason })` closes an operation that
should not continue. The record is kept, so the audit trail still explains what
was attempted.

At a request boundary, use `resolveInterruptedStepAuthorized(auth, ...)` and
`abandonOperationAuthorized(auth, ...)`. Both require `admin:recovery`, deny
unknown/non-maintainer roles before reading or writing a checkpoint, and leave
the record byte-for-byte unchanged on denial. The unguarded functions are kept
for trusted workers and backwards compatibility.

## Design decisions and tradeoffs

- **One entry point.** Starting and resuming are the same call, so there is no
  separate recovery path that can drift from the happy path.
- **Nothing retries itself.** A stuck operation waits for a caller. That makes
  the flow testable and keeps a failure loud instead of invisible.
- **Stall rather than duplicate.** Whenever a side effect may have landed, the
  flow stops and asks. The bias is deliberate: a stuck operation is cheap to
  resolve, a double-applied transfer is not.
- **The retry key is derived, not generated.** `operation:<id>:step:<id>` is
  stable across processes, so a crashed attempt and its retry are the same
  request to the outside world. This is a contract: a step's external call must
  honour the key.
- **Checkpoint before the call.** The `running` write happens before the step
  runs, so a process that dies mid-step still leaves evidence that the step was
  attempted.
- **Plain data.** A record is JSON with no closures, so it can be stored,
  exported, replayed in a test, and reasoned about by a maintainer.
- **Reuses the existing machinery.** States and events are declared in one table
  and enforced by `core/lifecycle`, so an illegal move (`completed` → `retry`)
  is refused and audited, and transitions reach telemetry and the audit trail
  like every other record kind.
- **Tradeoff: the module ships the seam, not the backend.** `OperationStorage`
  is one `getItem`-shaped interface; the in-memory and adapter implementations
  cover tests, a browser tab, and a single-process worker. A host with many
  concurrent operations should put a real store behind it.
- **Tradeoff: an interruption is only as good as the code that reports it.** A
  step that omits `committed: true` after submitting a transfer gets a retry
  rather than a stall, so steps that touch the outside world must report
  honestly. The types make the flag visible at every call site.

## Validation

```bash
npx vitest run core/operations
```

The suite covers interruption **before**, **during**, and **after** a side
effect, plus the guarantees around them: a resumed run never re-runs a
succeeded step, a step with a submitted effect is never called again until a
human resolves it, retries reuse one idempotency key, a storage failure is
reported instead of swallowed, and records round-trip through a
`localStorage`-shaped adapter. `stuckOperations` and `summarizeOperation` are
covered directly.
