/**
 * Versioned Event Replay Types
 *
 * Types for rebuilding read-model projections from the event log. Events
 * carry a schema version and are upcast before a projection sees them;
 * projections carry a build version and are rebuilt side-by-side with the
 * live one, then promoted atomically (blue/green), so readers never observe a
 * half-built projection and rollback is a pointer swap.
 */

/** One entry of the append-only event log. */
export interface ReplayEvent<P = unknown> {
  readonly id: string;
  /** Global position in the log. Strictly increasing; gaps are allowed. */
  readonly sequence: number;
  readonly type: string;
  /** Schema version of `payload`. */
  readonly version: number;
  readonly payload: P;
  readonly occurredAt: string;
}

/** Read side of the event log. Reads may fail transiently and are retried. */
export interface EventSource {
  /** Events with `sequence > afterSequence`, ascending, at most `limit`. */
  read(afterSequence: number, limit: number): Promise<readonly ReplayEvent[]>;
}

/** Lifts one event type from `fromVersion` to `fromVersion + 1`. Must be pure. */
export interface Upcaster {
  readonly type: string;
  readonly fromVersion: number;
  readonly upcast: (payload: unknown) => unknown;
}

export interface ProjectionDefinition<S> {
  readonly name: string;
  /** Build version. Bump it whenever `apply` or the state shape changes. */
  readonly version: number;
  /**
   * The event types this projection consumes, mapped to the schema version
   * `apply` expects. Older events are upcast; other types are ignored.
   */
  readonly eventVersions: Readonly<Record<string, number>>;
  readonly initial: () => S;
  /** Pure reducer. Must not mutate `state`; a throw marks the event as poison. */
  readonly apply: (state: S, event: ReplayEvent) => S;
  /** Invariant check run before promotion. Returns the violations, if any. */
  readonly validate?: (state: S) => readonly string[];
}

export type ProjectionSlotStatus = "building" | "ready" | "failed";

/** One materialised build of a projection at a given version. */
export interface ProjectionSlot<S = unknown> {
  readonly name: string;
  readonly version: number;
  readonly state: S;
  /** Sequence of the last event processed (applied, ignored or skipped). 0 means none. */
  readonly checkpoint: number;
  readonly status: ProjectionSlotStatus;
  readonly eventsApplied: number;
  readonly updatedAt: string;
}

export interface ActivePointer {
  readonly version: number;
  /** The version that was live before the last promotion; the rollback target. */
  readonly previousVersion?: number;
}

/**
 * Durable storage for projection slots, the active pointer and the replay
 * lock. Each method must be atomic on its own; `setActive` is the commit point
 * of a promotion.
 */
export interface ProjectionStore {
  getSlot<S>(name: string, version: number): ProjectionSlot<S> | undefined;
  putSlot<S>(slot: ProjectionSlot<S>): void;
  getActive(name: string): ActivePointer | undefined;
  setActive(name: string, pointer: ActivePointer): void;
  /** Returns false while another live owner holds the lock. */
  acquireLock(name: string, owner: string, now: number, ttlMs: number): boolean;
  releaseLock(name: string, owner: string): void;
}

export type ReplayMode =
  /** Discard any partial build of this version and start from sequence 0. */
  | "rebuild"
  /** Continue a building/failed slot from its checkpoint, or catch up a ready one. */
  | "resume";

export type PoisonPolicy = "halt" | "skip";

export interface ReplayOptions {
  readonly mode?: ReplayMode;
  /** Build in memory only: no slot writes, no promotion, no lock. */
  readonly dryRun?: boolean;
  /** Swap the active pointer to this version once the build is ready. */
  readonly promote?: boolean;
  readonly batchSize?: number;
  /** Retries per source read after the first attempt. */
  readonly maxRetries?: number;
  /** Base backoff; attempt `n` waits `retryDelayMs * 2^(n-1)`. */
  readonly retryDelayMs?: number;
  readonly poisonPolicy?: PoisonPolicy;
  /** With `skip`, the run fails once more than this many events are skipped. */
  readonly maxSkipped?: number;
  /** Stop after this sequence instead of at the head of the log. */
  readonly untilSequence?: number;
  /** A lock older than this is considered abandoned by a crashed run. */
  readonly lockTtlMs?: number;
  readonly runId?: string;
}

export type ReplayErrorCode =
  | "replay_unauthorized"
  | "invalid_options"
  | "replay_in_progress"
  | "version_active"
  | "nothing_to_resume"
  | "source_unavailable"
  | "sequence_out_of_order"
  | "unsupported_event_version"
  | "poison_event"
  | "too_many_skipped"
  | "validation_failed"
  | "no_previous_version";

export interface SkippedEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly reason: string;
}

export interface ReplayFailure {
  readonly runId: string;
  readonly projection: string;
  readonly version: number;
  /** Last sequence durably folded into the slot; `resume` continues from here. */
  readonly checkpoint: number;
  readonly eventId?: string;
  readonly sequence?: number;
  readonly message: string;
  readonly retries: number;
  readonly violations?: readonly string[];
}

export type ReplayStatus = "promoted" | "ready" | "dry_run";

/** Counters cover this run only; the slot's `eventsApplied` is the running total. */
export interface ReplayReport<S = unknown> {
  readonly runId: string;
  readonly projection: string;
  readonly version: number;
  readonly mode: ReplayMode;
  readonly status: ReplayStatus;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly batches: number;
  readonly eventsRead: number;
  readonly eventsApplied: number;
  readonly eventsIgnored: number;
  readonly eventsUpcast: number;
  readonly skipped: readonly SkippedEvent[];
  readonly retries: number;
  readonly previousActiveVersion?: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Final state; present for dry runs so the result can be inspected. */
  readonly state?: S;
}

export interface RollbackReport {
  readonly projection: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** The restored slot's checkpoint; resume it to catch up on newer events. */
  readonly checkpoint: number;
  readonly at: string;
}
