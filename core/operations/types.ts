/**
 * Vocabulary for recoverable multi-step operations.
 *
 * A multi-step operation is any flow that touches the outside world more than
 * once: issuing a ticket, submitting a payment, redeeming a receipt. Each step
 * writes a checkpoint *before* it is attempted, so an interruption — a closed
 * tab, a reload, a relayer timeout — leaves enough behind to answer the only
 * question that matters: what exactly already happened?
 *
 * Everything here is plain data. A record read back from storage can be
 * replayed by a test or reasoned about by a maintainer without running code.
 */

export type OperationState =
  | "pending"
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "abandoned";

export const OPERATION_STATES: readonly OperationState[] = [
  "pending",
  "running",
  "interrupted",
  "completed",
  "failed",
  "abandoned"
];

/**
 * States an operation cannot move out of. `failed` is deliberately absent: a
 * failed step reported that its side effect did *not* land, so the operator can
 * retry the operation with the same idempotency key.
 */
export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
  "completed",
  "abandoned"
];

export type OperationEvent =
  | "start"
  | "interrupt"
  | "resume"
  | "retry"
  | "complete"
  | "fail"
  | "abandon";

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted";

export const STEP_STATUSES: readonly StepStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "interrupted"
];

/**
 * What the flow knows about one step after the last attempt to run it.
 *
 * `sideEffectCommitted` is the load-bearing field. It means "the step reported
 * that its effect reached the outside world". The runner will not touch such a
 * step on its own, because re-running it could double-apply; a human has to
 * confirm the external outcome first.
 */
export interface StepCheckpoint {
  readonly id: string;
  readonly status: StepStatus;
  /** 1-based, incremented only when the step is actually attempted again. */
  readonly attempt: number;
  /**
   * Stable for the lifetime of the operation, so a retry after an interruption
   * is presented to the outside world as the *same* request, not a new one.
   */
  readonly idempotencyKey: string;
  readonly sideEffectCommitted: boolean;
  readonly updatedAt: string;
  /** Result persisted by the step, replayed on resume instead of re-running. */
  readonly output?: unknown;
  readonly errorCode?: string;
}

export interface OperationRecord {
  readonly id: string;
  readonly kind: string;
  readonly state: OperationState;
  /** One entry per declared step, in declaration order. */
  readonly steps: readonly StepCheckpoint[];
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastErrorCode?: string;
}

export interface OperationStorage {
  read(id: string): OperationRecord | undefined;
  write(record: OperationRecord): void;
  remove(id: string): void;
  list(): readonly OperationRecord[];
}

/** What a step reports back. Everything a recovery decision needs is here. */
export type StepOutcome =
  | {
      readonly status: "succeeded";
      readonly output?: unknown;
      /** Defaults to `true`; set `false` for a step with no side effect. */
      readonly committed?: boolean;
    }
  | { readonly status: "skipped" }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      /** `true` when the failure happened *after* the effect landed. */
      readonly committed?: boolean;
    }
  | {
      readonly status: "interrupted";
      readonly errorCode: string;
      /** `true` when the effect landed but its result was not confirmed. */
      readonly committed?: boolean;
    };

export type RecoveryActionCode =
  | "retry_step"
  | "confirm_external_state"
  | "abandon_operation";

/** "What do I do now", in the form a UI banner or a maintainer can consume. */
export interface RecoveryAction {
  readonly code: RecoveryActionCode;
  readonly stepId: string | null;
  readonly message: string;
  readonly idempotencyKey?: string;
  readonly maintainerHint?: string;
}

export interface StepRunInput<TContext> {
  readonly operationId: string;
  readonly stepId: string;
  /** 1-based attempt counter, stable across resumes. */
  readonly attempt: number;
  readonly idempotencyKey: string;
  /** Output of the most recent successful step, if it produced one. */
  readonly previous: unknown;
  readonly context: TContext;
}

export interface StepDefinition<TContext> {
  readonly id: string;
  /** Override the derived key. Defaults to `operation:<id>:step:<id>`. */
  readonly idempotencyKey?: (operationId: string) => string;
  run(input: StepRunInput<TContext>): StepOutcome | Promise<StepOutcome>;
}

export interface OperationDefinition<TContext> {
  readonly kind: string;
  readonly steps: readonly StepDefinition<TContext>[];
}

export interface RunOperationOptions<TContext> {
  readonly operationId: string;
  readonly context: TContext;
  readonly storage: OperationStorage;
  /** Injected clock in ms since the epoch, so a run is reproducible. */
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  /** Audit actor for the transitions, e.g. `account:G…`. */
  readonly actor?: string;
}

export type OperationOutcomeState =
  | "completed"
  | "failed"
  | "interrupted"
  | "abandoned";

export interface OperationProgress {
  readonly state: OperationOutcomeState;
  readonly record: OperationRecord;
  /** Non-null unless the operation completed. */
  readonly errorCode: string | null;
  /** Non-null unless the operation completed or was abandoned. */
  readonly action: RecoveryAction | null;
}

export type OperationErrorCode =
  | "invalid_operation"
  | "unknown_operation"
  | "unknown_step"
  | "terminal_operation"
  | "permission_denied"
  | "storage_error";
