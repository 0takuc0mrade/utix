/**
 * Deterministic recovery for interrupted multi-step operations.
 *
 * The contract is one entry point — `runOperation` — that both starts and
 * resumes a flow. Given the same record and the same definitions it makes the
 * same decision, because every decision is derived from the checkpoint on disk
 * rather than from an in-memory step index:
 *
 * - a step whose checkpoint says `succeeded` is never run again;
 * - a step that reported its effect landed (`sideEffectCommitted`) is never run
 *   again either — the flow stops and asks a human to confirm the outcome;
 * - a step that stopped without reporting is retried *with the same idempotency
 *   key*, so the outside world sees one request, not two.
 *
 * Nothing here retries on a timer or in the background. Recovery is driven by a
 * caller that deliberately resumes an operation, which keeps the flow testable
 * and keeps a stuck operation visible instead of silently looping.
 */

import {
  applyTransition,
  createLifecycle,
  type LifecycleMachine,
  type TransitionContext
} from "@/core/lifecycle/lifecycle";
import { newCorrelationId } from "@/core/telemetry/telemetry";
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, isErr, ok, type Result } from "@/core/result/result";
import {
  OPERATION_STATES,
  TERMINAL_OPERATION_STATES,
  type OperationDefinition,
  type OperationErrorCode,
  type OperationEvent,
  type OperationProgress,
  type OperationRecord,
  type OperationState,
  type OperationStorage,
  type RecoveryAction,
  type RunOperationOptions,
  type StepCheckpoint,
  type StepOutcome
} from "@/core/operations/types";

/**
 * The operation state machine. `failed` is recoverable on purpose: a failed
 * step reported that nothing landed, so an operator may retry it with the same
 * idempotency key.
 */
export const operationMachine: LifecycleMachine = createLifecycle({
  name: "recoverable_operation",
  initial: "pending",
  states: OPERATION_STATES,
  terminal: TERMINAL_OPERATION_STATES,
  transitions: [
    { from: "pending", event: "start", to: "running" },
    { from: "pending", event: "abandon", to: "abandoned" },
    { from: "running", event: "interrupt", to: "interrupted" },
    { from: "running", event: "complete", to: "completed" },
    { from: "running", event: "fail", to: "failed" },
    { from: "running", event: "abandon", to: "abandoned" },
    { from: "interrupted", event: "resume", to: "running" },
    { from: "interrupted", event: "complete", to: "completed" },
    { from: "interrupted", event: "fail", to: "failed" },
    { from: "interrupted", event: "abandon", to: "abandoned" },
    { from: "failed", event: "retry", to: "running" },
    { from: "failed", event: "abandon", to: "abandoned" }
  ]
});

export type StepDecision = "skip" | "run" | "confirm";

export function defaultIdempotencyKey(operationId: string, stepId: string): string {
  return `operation:${operationId}:step:${stepId}`;
}

/**
 * The whole recovery policy, in four lines. It reads only the checkpoint, which
 * is what makes a resume deterministic: there is no in-memory step counter to
 * drift out of sync with what actually happened.
 */
export function decideStep(checkpoint: StepCheckpoint): StepDecision {
  if (checkpoint.status === "succeeded" || checkpoint.status === "skipped") return "skip";
  if (checkpoint.sideEffectCommitted) return "confirm";
  return "run";
}

/** What the caller should do about a record that is not finished. */
export function nextActionFor(record: OperationRecord): RecoveryAction | null {
  if (record.state === "completed" || record.state === "abandoned") return null;
  const step = record.steps.find((checkpoint) => decideStep(checkpoint) !== "skip");
  if (!step) {
    return {
      code: "retry_step",
      stepId: null,
      message: "Every step of this operation is recorded as finished. Run it again to close it out.",
      maintainerHint: "The run stopped between the last checkpoint and the closing transition."
    };
  }
  return decideStep(step) === "confirm" ? confirmAction(step) : retryAction(step);
}

function retryAction(checkpoint: StepCheckpoint): RecoveryAction {
  return {
    code: "retry_step",
    stepId: checkpoint.id,
    idempotencyKey: checkpoint.idempotencyKey,
    message: `This operation stopped at step "${checkpoint.id}". Run it again to retry the step.`,
    maintainerHint:
      "Safe to retry: the step reported that no side effect landed, so the retry reuses the same idempotency key."
  };
}

function confirmAction(checkpoint: StepCheckpoint): RecoveryAction {
  return {
    code: "confirm_external_state",
    stepId: checkpoint.id,
    idempotencyKey: checkpoint.idempotencyKey,
    message: `Step "${checkpoint.id}" reported that its effect was submitted but its result was not confirmed. Confirm the outcome before continuing.`,
    maintainerHint:
      'Confirm the external outcome, then call resolveInterruptedStep(id, stepId, "applied") if it landed or "not_applied" if it did not.'
  };
}

function validateDefinition<TContext>(definition: OperationDefinition<TContext>): boolean {
  if (definition.kind.length === 0 || definition.steps.length === 0) return false;
  const ids = new Set<string>();
  for (const step of definition.steps) {
    // Duplicate ids would make "which checkpoint is this?" order-dependent.
    if (step.id.length === 0 || ids.has(step.id)) return false;
    ids.add(step.id);
  }
  return true;
}

function createRecord<TContext>(
  operationId: string,
  definition: OperationDefinition<TContext>,
  correlationId: string,
  at: string
): OperationRecord {
  return {
    id: operationId,
    kind: definition.kind,
    state: "pending",
    correlationId,
    createdAt: at,
    updatedAt: at,
    steps: definition.steps.map((step) => ({
      id: step.id,
      status: "pending",
      attempt: 0,
      idempotencyKey: step.idempotencyKey
        ? step.idempotencyKey(operationId)
        : defaultIdempotencyKey(operationId, step.id),
      sideEffectCommitted: false,
      updatedAt: at
    }))
  };
}

function findStep(record: OperationRecord, stepId: string): StepCheckpoint | undefined {
  return record.steps.find((checkpoint) => checkpoint.id === stepId);
}

function withStep(
  record: OperationRecord,
  checkpoint: StepCheckpoint,
  at: string
): OperationRecord {
  return {
    ...record,
    updatedAt: at,
    steps: record.steps.map((current) => (current.id === checkpoint.id ? checkpoint : current))
  };
}

/** Output of the most recently successful step before `stepId`. */
function previousOutput(record: OperationRecord, stepId: string): unknown {
  let previous: unknown;
  for (const checkpoint of record.steps) {
    if (checkpoint.id === stepId) break;
    if (checkpoint.status === "succeeded" && checkpoint.output !== undefined) {
      previous = checkpoint.output;
    }
  }
  return previous;
}

function advance(
  record: OperationRecord,
  event: OperationEvent,
  context: TransitionContext
): Result<OperationRecord, OperationErrorCode> {
  const outcome = applyTransition(operationMachine, record, event, context);
  if (isErr(outcome)) return err("invalid_operation");
  const to = outcome.value.to;
  if (!operationMachine.isState(to)) return err("invalid_operation");
  return ok({ ...record, state: to as OperationState, updatedAt: outcome.value.transition.at });
}

function persist(storage: OperationStorage, record: OperationRecord): boolean {
  try {
    storage.write(record);
    return true;
  } catch {
    return false;
  }
}

interface StepApplication {
  readonly checkpoint: StepCheckpoint;
  /** `null` when the step moved the operation forward. */
  readonly stop: {
    readonly event: OperationEvent;
    readonly errorCode: string;
    readonly committed: boolean;
  } | null;
}

/**
 * Folds a step's report into its checkpoint. A failure that happened *after*
 * the effect landed is an interruption, not a plain failure: retrying it blindly
 * is exactly the double-apply this module exists to prevent.
 */
function applyOutcome(
  checkpoint: StepCheckpoint,
  outcome: StepOutcome,
  at: string
): StepApplication {
  switch (outcome.status) {
    case "succeeded":
      return {
        checkpoint: {
          ...checkpoint,
          status: "succeeded",
          sideEffectCommitted: outcome.committed ?? true,
          output: outcome.output,
          errorCode: undefined,
          updatedAt: at
        },
        stop: null
      };
    case "skipped":
      return {
        checkpoint: { ...checkpoint, status: "skipped", errorCode: undefined, updatedAt: at },
        stop: null
      };
    case "failed":
      if (outcome.committed) {
        return {
          checkpoint: {
            ...checkpoint,
            status: "interrupted",
            sideEffectCommitted: true,
            errorCode: outcome.errorCode,
            updatedAt: at
          },
          stop: { event: "interrupt", errorCode: outcome.errorCode, committed: true }
        };
      }
      return {
        checkpoint: {
          ...checkpoint,
          status: "failed",
          sideEffectCommitted: false,
          errorCode: outcome.errorCode,
          updatedAt: at
        },
        stop: { event: "fail", errorCode: outcome.errorCode, committed: false }
      };
    case "interrupted":
      return {
        checkpoint: {
          ...checkpoint,
          status: "interrupted",
          sideEffectCommitted: outcome.committed ?? false,
          errorCode: outcome.errorCode,
          updatedAt: at
        },
        stop: {
          event: "interrupt",
          errorCode: outcome.errorCode,
          committed: outcome.committed ?? false
        }
      };
  }
}

/**
 * Starts or resumes an operation. Calling it twice with the same definition and
 * record is safe: the second call replays the checkpoints instead of the steps.
 */
export async function runOperation<TContext>(
  definition: OperationDefinition<TContext>,
  options: RunOperationOptions<TContext>
): Promise<Result<OperationProgress, OperationErrorCode>> {
  if (!validateDefinition(definition)) return err("invalid_operation");

  const now = options.now ?? (() => Date.now());
  const stamp = (): string => new Date(now()).toISOString();
  const actor = options.actor ?? "system";

  let stored: OperationRecord | undefined;
  try {
    stored = options.storage.read(options.operationId);
  } catch {
    return err("storage_error");
  }

  if (stored && stored.kind !== definition.kind) return err("invalid_operation");

  let record: OperationRecord;
  if (stored) {
    record = stored;
  } else {
    const at = stamp();
    record = createRecord(
      options.operationId,
      definition,
      (options.newCorrelationId ?? newCorrelationId)(),
      at
    );
  }

  if (record.state === "completed" || record.state === "abandoned") {
    return ok({
      state: record.state,
      record,
      errorCode: record.lastErrorCode ?? null,
      action: null
    });
  }

  if (record.state !== "running") {
    const event: OperationEvent =
      record.state === "interrupted" ? "resume" : record.state === "failed" ? "retry" : "start";
    const advanced = advance(record, event, { at: stamp(), actor, reason: `operation.${event}` });
    if (isErr(advanced)) return advanced;
    record = advanced.value;
    if (!persist(options.storage, record)) return err("storage_error");
  }

  for (const step of definition.steps) {
    const checkpoint = findStep(record, step.id);
    if (!checkpoint) return err("invalid_operation");

    const decision = decideStep(checkpoint);
    if (decision === "skip") continue;
    if (decision === "confirm") {
      return ok({
        state: "interrupted",
        record,
        errorCode: checkpoint.errorCode ?? "operation_interrupted",
        action: confirmAction(checkpoint)
      });
    }

    const attemptAt = stamp();
    const running: StepCheckpoint = {
      ...checkpoint,
      status: "running",
      attempt: checkpoint.attempt + 1,
      errorCode: undefined,
      updatedAt: attemptAt
    };
    // The checkpoint is written *before* the step runs, so a process that dies
    // mid-step still leaves a record saying the step was attempted.
    record = withStep(record, running, attemptAt);
    if (!persist(options.storage, record)) return err("storage_error");

    let outcome: StepOutcome;
    try {
      outcome = await step.run({
        operationId: record.id,
        stepId: step.id,
        attempt: running.attempt,
        idempotencyKey: running.idempotencyKey,
        previous: previousOutput(record, step.id),
        context: options.context
      });
    } catch {
      // The step threw before it could report. Whether the effect landed is
      // unknown, so the operation stops and the next run retries the step with
      // the same idempotency key rather than inventing a second request.
      outcome = { status: "interrupted", errorCode: "step_threw" };
    }

    const applied = applyOutcome(running, outcome, stamp());
    record = withStep(record, applied.checkpoint, applied.checkpoint.updatedAt);

    if (applied.stop === null) {
      if (!persist(options.storage, record)) return err("storage_error");
      continue;
    }

    const stalled = advance(record, applied.stop.event, {
      at: applied.checkpoint.updatedAt,
      actor,
      reason: `operation.step.${applied.stop.event}`
    });
    if (isErr(stalled)) return stalled;
    record = { ...stalled.value, lastErrorCode: applied.stop.errorCode };
    if (!persist(options.storage, record)) return err("storage_error");

    return ok({
      state: applied.stop.event === "interrupt" ? "interrupted" : "failed",
      record,
      errorCode: applied.stop.errorCode,
      action: applied.stop.committed
        ? confirmAction(applied.checkpoint)
        : retryAction(applied.checkpoint)
    });
  }

  const completed = advance(record, "complete", {
    at: stamp(),
    actor,
    reason: "operation.complete"
  });
  if (isErr(completed)) return completed;
  record = { ...completed.value, lastErrorCode: undefined };
  if (!persist(options.storage, record)) return err("storage_error");

  return ok({ state: "completed", record, errorCode: null, action: null });
}

export interface ResolveOperationOptions {
  readonly storage: OperationStorage;
  /** `maintainer:…` for an operator, `account:G…` for the affected user. */
  readonly actor?: string;
  readonly now?: () => number;
  readonly reason?: string;
}

export type StepResolution = "applied" | "not_applied";

function readForResolution(
  operationId: string,
  options: ResolveOperationOptions
): Result<OperationRecord, OperationErrorCode> {
  let record: OperationRecord | undefined;
  try {
    record = options.storage.read(operationId);
  } catch {
    return err("storage_error");
  }
  if (!record) return err("unknown_operation");
  if (operationMachine.isTerminal(record.state)) return err("terminal_operation");
  return ok(record);
}

/**
 * Clears an interruption on one step after a human confirmed what happened
 * outside the app. `"applied"` marks the step done so the flow moves on;
 * `"not_applied"` makes it runnable again, which is only safe because the
 * outcome is known and the idempotency key is unchanged.
 */
export function resolveInterruptedStep(
  operationId: string,
  stepId: string,
  resolution: StepResolution,
  options: ResolveOperationOptions
): Result<OperationRecord, OperationErrorCode> {
  const read = readForResolution(operationId, options);
  if (isErr(read)) return read;

  const checkpoint = findStep(read.value, stepId);
  if (!checkpoint) return err("unknown_step");

  const at = new Date((options.now ?? (() => Date.now()))()).toISOString();
  const actor = options.actor ?? "system";
  const resolved: StepCheckpoint =
    resolution === "applied"
      ? {
          ...checkpoint,
          status: "succeeded",
          sideEffectCommitted: true,
          errorCode: undefined,
          updatedAt: at
        }
      : {
          ...checkpoint,
          status: "pending",
          sideEffectCommitted: false,
          errorCode: undefined,
          updatedAt: at
        };

  let next = withStep(read.value, resolved, at);
  if (next.state === "interrupted" || next.state === "failed") {
    const event: OperationEvent = next.state === "interrupted" ? "resume" : "retry";
    const advanced = advance(next, event, {
      at,
      actor,
      scope: "maintainer",
      audited: true,
      reason: options.reason ?? `operation.step.${resolution}`
    });
    if (isErr(advanced)) return advanced;
    next = advanced.value;
  }

  if (!persist(options.storage, next)) return err("storage_error");
  return ok(next);
}

/**
 * Server-side boundary for the destructive recovery decision.  The original
 * resolver remains available for trusted/internal callers; request handlers
 * should use this function so a viewer cannot assert that an external effect
 * did or did not land.
 */
export function resolveInterruptedStepAuthorized(
  auth: AuthContext,
  operationId: string,
  stepId: string,
  resolution: StepResolution,
  options: ResolveOperationOptions
): Result<OperationRecord, OperationErrorCode> {
  if (!hasPermission(auth.role, "admin:recovery")) return err("permission_denied");
  return resolveInterruptedStep(operationId, stepId, resolution, {
    ...options,
    actor: options.actor ?? `maintainer:${auth.userId ?? "unknown"}`
  });
}

/** Gives up on an operation on purpose. The record is kept for the audit trail. */
export function abandonOperation(
  operationId: string,
  options: ResolveOperationOptions
): Result<OperationRecord, OperationErrorCode> {
  const read = readForResolution(operationId, options);
  if (isErr(read)) return read;

  const at = new Date((options.now ?? (() => Date.now()))()).toISOString();
  const advanced = advance(read.value, "abandon", {
    at,
    actor: options.actor ?? "system",
    scope: "maintainer",
    audited: true,
    reason: options.reason ?? "operation.abandon"
  });
  if (isErr(advanced)) return advanced;
  if (!persist(options.storage, advanced.value)) return err("storage_error");
  return ok(advanced.value);
}

/** Authorization boundary for abandoning a recoverable operation. */
export function abandonOperationAuthorized(
  auth: AuthContext,
  operationId: string,
  options: ResolveOperationOptions
): Result<OperationRecord, OperationErrorCode> {
  if (!hasPermission(auth.role, "admin:recovery")) return err("permission_denied");
  return abandonOperation(operationId, {
    ...options,
    actor: options.actor ?? `maintainer:${auth.userId ?? "unknown"}`
  });
}
