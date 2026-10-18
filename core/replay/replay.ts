/**
 * Versioned Event Replay Runner
 *
 * Rebuilds a projection from the event log into its own versioned slot, then
 * promotes it by swapping the active pointer. The live projection is never
 * written by a rebuild, so a failed or abandoned run leaves readers on the
 * previous version, and rollback is a pointer swap back.
 *
 * Expected failures are returned as `Result` codes, never thrown.
 */

import { recordAudit, type AuditActor } from "@/core/audit/audit";
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission, type Permission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";
import { newCorrelationId } from "@/core/telemetry/telemetry";
import { createUpcasterRegistry, type UpcasterRegistry } from "./upcast";
import type {
  EventSource,
  ProjectionDefinition,
  ProjectionSlot,
  ProjectionStore,
  ReplayErrorCode,
  ReplayEvent,
  ReplayFailure,
  ReplayOptions,
  ReplayReport,
  RollbackReport,
  SkippedEvent
} from "./types";

/** Replaying rewrites a read model, so it is a maintainer-only operation. */
export const REPLAY_PERMISSION: Permission = "admin:replay";

export const REPLAY_DEFAULTS = {
  batchSize: 500,
  maxRetries: 3,
  retryDelayMs: 200,
  maxSkipped: 0,
  lockTtlMs: 5 * 60_000
} as const;

const MAX_BATCH_SIZE = 10_000;
const MAX_RETRIES = 10;

export interface ReplayDeps {
  readonly source: EventSource;
  readonly store: ProjectionStore;
  readonly auth: AuthContext;
  readonly upcasters?: UpcasterRegistry;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type ReplayResult<S> = Result<ReplayReport<S>, ReplayErrorCode, ReplayFailure>;

function auditActor(auth: AuthContext): AuditActor {
  if (auth.role === "maintainer") return { kind: "maintainer", id: auth.userId ?? "maintainer" };
  if (auth.role === "service") return { kind: "system", id: auth.userId ?? "service" };
  return { kind: "user", id: auth.userId ?? auth.role };
}

function isNonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

type ResolvedOptions = Required<Omit<ReplayOptions, "untilSequence" | "runId">> & Pick<ReplayOptions, "untilSequence">;

function resolveOptions(options: ReplayOptions): ResolvedOptions {
  return {
    mode: options.mode ?? "rebuild",
    dryRun: options.dryRun ?? false,
    promote: options.promote ?? false,
    poisonPolicy: options.poisonPolicy ?? "halt",
    batchSize: options.batchSize ?? REPLAY_DEFAULTS.batchSize,
    maxRetries: options.maxRetries ?? REPLAY_DEFAULTS.maxRetries,
    retryDelayMs: options.retryDelayMs ?? REPLAY_DEFAULTS.retryDelayMs,
    maxSkipped: options.maxSkipped ?? REPLAY_DEFAULTS.maxSkipped,
    lockTtlMs: options.lockTtlMs ?? REPLAY_DEFAULTS.lockTtlMs,
    untilSequence: options.untilSequence
  };
}

function validateOptions(def: ProjectionDefinition<unknown>, opts: ResolvedOptions): string | undefined {
  if (!def.name || !Number.isInteger(def.version) || def.version < 1) return "projection needs a name and a version >= 1";
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1 || opts.batchSize > MAX_BATCH_SIZE) {
    return `batchSize must be an integer in 1..${MAX_BATCH_SIZE}`;
  }
  if (!isNonNegativeInt(opts.maxRetries) || opts.maxRetries > MAX_RETRIES) return `maxRetries must be an integer in 0..${MAX_RETRIES}`;
  if (!(opts.retryDelayMs >= 0)) return "retryDelayMs must be >= 0";
  if (!isNonNegativeInt(opts.maxSkipped)) return "maxSkipped must be a non-negative integer";
  if (!(opts.lockTtlMs > 0)) return "lockTtlMs must be > 0";
  if (opts.untilSequence !== undefined && !isNonNegativeInt(opts.untilSequence)) return "untilSequence must be a non-negative integer";
  if (opts.dryRun && opts.promote) return "a dry run cannot promote";
  return undefined;
}

/**
 * Replays the event log into `definition`'s versioned slot.
 *
 * - `rebuild` starts from sequence 0 and refuses to overwrite the live version.
 * - `resume` continues a building/failed slot from its checkpoint, or catches
 *   up the live slot (committed once, after validation).
 */
export async function replayProjection<S>(
  definition: ProjectionDefinition<S>,
  deps: ReplayDeps,
  options: ReplayOptions = {}
): Promise<ReplayResult<S>> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const upcasters = deps.upcasters ?? createUpcasterRegistry();
  const opts = resolveOptions(options);
  const runId = options.runId ?? newCorrelationId();
  const { name, version } = definition;
  const target = { kind: "projection", id: `${name}@v${version}` };
  const actor = auditActor(deps.auth);
  const reason = opts.dryRun ? "dry_run" : opts.mode;
  const startedAt = new Date(now()).toISOString();

  const failure = (
    code: ReplayErrorCode,
    detail: Omit<ReplayFailure, "runId" | "projection" | "version">,
    audited = true
  ): ReplayResult<S> => {
    if (audited) {
      recordAudit({
        action: "projection.replayed",
        actor,
        scope: "maintainer",
        target,
        reason,
        outcome: code === "replay_unauthorized" ? "denied" : "allowed",
        after: { status: "failed", checkpoint: detail.checkpoint, sequence: detail.sequence ?? null, retries: detail.retries },
        errorCode: code,
        correlationId: runId
      });
    }
    return err(code, { runId, projection: name, version, ...detail });
  };

  const invalid = validateOptions(definition as ProjectionDefinition<unknown>, opts);
  if (invalid) return failure("invalid_options", { checkpoint: 0, message: invalid, retries: 0 }, false);

  if (!hasPermission(deps.auth.role, REPLAY_PERMISSION)) {
    return failure("replay_unauthorized", {
      checkpoint: 0,
      message: `role ${deps.auth.role} lacks ${REPLAY_PERMISSION}`,
      retries: 0
    });
  }

  const active = deps.store.getActive(name);
  const live = active?.version === version;
  if (live && opts.mode === "rebuild" && !opts.dryRun) {
    return failure("version_active", {
      checkpoint: 0,
      message: `v${version} is live; rebuild into a new version, or resume to catch up`,
      retries: 0
    });
  }

  let state: S;
  let checkpoint: number;
  let eventsApplied: number;
  if (opts.mode === "resume") {
    const slot = deps.store.getSlot<S>(name, version);
    if (!slot) {
      return failure("nothing_to_resume", { checkpoint: 0, message: `no slot for ${target.id}`, retries: 0 });
    }
    ({ state, checkpoint, eventsApplied } = slot);
  } else {
    state = definition.initial();
    checkpoint = 0;
    eventsApplied = 0;
  }
  const fromSequence = checkpoint;

  // The live slot is committed once, after validation; a staging slot after every batch.
  const commitPerBatch = !opts.dryRun && !live;
  const lockOwner = runId;
  if (!opts.dryRun && !deps.store.acquireLock(name, lockOwner, now(), opts.lockTtlMs)) {
    return failure("replay_in_progress", { checkpoint, message: `another replay holds the lock for ${name}`, retries: 0 });
  }

  const writeSlot = (status: ProjectionSlot["status"]) =>
    deps.store.putSlot<S>({ name, version, state, checkpoint, status, eventsApplied, updatedAt: new Date(now()).toISOString() });

  /**
   * Refreshes our hold on the projection lock. A run that has been paused past
   * `lockTtlMs` and finds another owner here must not write: the new owner's
   * slot is authoritative, and a late write would clobber it.
   */
  const ownsLock = (): boolean =>
    opts.dryRun || deps.store.acquireLock(name, lockOwner, now(), opts.lockTtlMs);

  /**
   * Stops without touching the slot, because another run owns it now. The
   * reported checkpoint is the durable one: this run may have applied a batch
   * in memory, but it was never committed.
   */
  const lostLock = () =>
    failure("replay_in_progress", {
      checkpoint: deps.store.getSlot(name, version)?.checkpoint ?? 0,
      message: `lost the replay lock for ${name} to another run`,
      retries
    });

  const appliedBefore = eventsApplied;
  let retries = 0;
  let batches = 0;
  let eventsRead = 0;
  let eventsIgnored = 0;
  let eventsUpcast = 0;
  const skipped: SkippedEvent[] = [];

  /**
   * Fails the run, leaving a staging slot at the last good checkpoint for
   * `resume`. The slot is only written while this run still owns the lock: a
   * run that lost it must leave the new owner's slot untouched.
   */
  const halt = (code: ReplayErrorCode, detail: Omit<ReplayFailure, "runId" | "projection" | "version" | "checkpoint" | "retries">) => {
    if (commitPerBatch && ownsLock()) writeSlot("failed");
    return failure(code, { checkpoint, retries, ...detail });
  };

  try {
    if (!ownsLock()) return lostLock();
    if (commitPerBatch && opts.mode === "rebuild") writeSlot("building");

    let done = false;
    while (!done) {
      if (!ownsLock()) return lostLock();
      if (opts.untilSequence !== undefined && checkpoint >= opts.untilSequence) break;

      let batch: readonly ReplayEvent[] | undefined;
      let lastError = "";
      for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
        try {
          batch = await deps.source.read(checkpoint, opts.batchSize);
          break;
        } catch (cause) {
          lastError = cause instanceof Error ? cause.message : String(cause);
          if (attempt < opts.maxRetries) {
            retries += 1;
            await sleep(opts.retryDelayMs * 2 ** attempt);
          }
        }
      }
      if (!batch) return halt("source_unavailable", { message: `event source read failed: ${lastError}` });
      if (batch.length === 0) break;
      batches += 1;

      for (const event of batch) {
        if (opts.untilSequence !== undefined && event.sequence > opts.untilSequence) {
          done = true;
          break;
        }
        if (!Number.isInteger(event.sequence) || event.sequence <= checkpoint) {
          return halt("sequence_out_of_order", {
            eventId: event.id,
            sequence: event.sequence,
            message: `sequence ${event.sequence} is not after checkpoint ${checkpoint}`
          });
        }
        eventsRead += 1;

        const targetVersion = definition.eventVersions[event.type];
        if (targetVersion === undefined) {
          eventsIgnored += 1;
          checkpoint = event.sequence;
          continue;
        }

        const lifted = upcasters.upcast(event, targetVersion);
        let poison: string | undefined;
        if (!lifted.ok) {
          // A missing upcaster is a deploy gap, not bad data: never skip it.
          if (lifted.code === "unsupported_event_version") {
            return halt("unsupported_event_version", { eventId: event.id, sequence: event.sequence, message: lifted.detail ?? "" });
          }
          poison = lifted.detail;
        } else {
          if (lifted.value !== event) eventsUpcast += 1;
          try {
            state = definition.apply(state, lifted.value);
            eventsApplied += 1;
          } catch (cause) {
            poison = `apply threw: ${cause instanceof Error ? cause.message : String(cause)}`;
          }
        }

        if (poison !== undefined) {
          if (opts.poisonPolicy === "halt") {
            return halt("poison_event", { eventId: event.id, sequence: event.sequence, message: poison });
          }
          skipped.push({ eventId: event.id, sequence: event.sequence, reason: poison });
          if (skipped.length > opts.maxSkipped) {
            return halt("too_many_skipped", {
              eventId: event.id,
              sequence: event.sequence,
              message: `${skipped.length} events skipped, limit ${opts.maxSkipped}`
            });
          }
        }
        checkpoint = event.sequence;
      }

      if (!ownsLock()) return lostLock();
      if (commitPerBatch) writeSlot("building");
    }

    if (!ownsLock()) return lostLock();
    const violations = definition.validate?.(state) ?? [];
    if (violations.length > 0) {
      return halt("validation_failed", { message: `${violations.length} invariant violation(s)`, violations });
    }

    let status: ReplayReport["status"] = "dry_run";
    if (!opts.dryRun) {
      writeSlot("ready");
      status = "ready";
      if (opts.promote && !live) {
        deps.store.setActive(name, { version, previousVersion: active?.version });
        status = "promoted";
      }
    }

    const finishedAt = new Date(now()).toISOString();
    recordAudit({
      action: "projection.replayed",
      actor,
      scope: "maintainer",
      target,
      reason,
      before: { activeVersion: active?.version ?? null, checkpoint: fromSequence },
      after: { status, checkpoint, applied: eventsApplied - appliedBefore, skipped: skipped.length, retries },
      at: finishedAt,
      correlationId: runId
    });

    return ok({
      runId,
      projection: name,
      version,
      mode: opts.mode,
      status,
      fromSequence,
      toSequence: checkpoint,
      batches,
      eventsRead,
      eventsApplied: eventsApplied - appliedBefore,
      eventsIgnored,
      eventsUpcast,
      skipped,
      retries,
      previousActiveVersion: active?.version,
      startedAt,
      finishedAt,
      ...(opts.dryRun ? { state } : {})
    });
  } finally {
    if (!opts.dryRun) deps.store.releaseLock(name, lockOwner);
  }
}

export type PointerDeps = Pick<ReplayDeps, "store" | "auth" | "now">;

/**
 * Points readers at an already-built `ready` slot. Used to promote a build
 * made with `promote: false` after a manual review.
 */
export function promoteProjection(
  name: string,
  version: number,
  deps: PointerDeps
): Result<RollbackReport, ReplayErrorCode, string> {
  return swapActive(name, () => version, "promote", deps);
}

/**
 * Points readers back at the version that was live before the last
 * promotion. Rolling back twice rolls forward again.
 */
export function rollbackProjection(name: string, deps: PointerDeps): Result<RollbackReport, ReplayErrorCode, string> {
  return swapActive(name, (active) => active?.previousVersion, "rollback", deps);
}

function swapActive(
  name: string,
  pick: (active: ReturnType<ProjectionStore["getActive"]>) => number | undefined,
  reason: "promote" | "rollback",
  deps: PointerDeps
): Result<RollbackReport, ReplayErrorCode, string> {
  const now = deps.now ?? Date.now;
  const at = new Date(now()).toISOString();
  const actor = auditActor(deps.auth);
  const active = deps.store.getActive(name);
  const toVersion = pick(active);
  const target = { kind: "projection", id: name };

  if (!hasPermission(deps.auth.role, REPLAY_PERMISSION)) {
    recordAudit({ action: "projection.activated", actor, scope: "maintainer", target, reason, outcome: "denied", errorCode: "replay_unauthorized", at });
    return err("replay_unauthorized", `role ${deps.auth.role} lacks ${REPLAY_PERMISSION}`);
  }

  const slot = toVersion === undefined ? undefined : deps.store.getSlot(name, toVersion);
  if (toVersion === undefined || !slot || slot.status !== "ready" || toVersion === active?.version) {
    return err("no_previous_version", `no ready version to ${reason} ${name} to`);
  }

  deps.store.setActive(name, { version: toVersion, previousVersion: active?.version });
  recordAudit({
    action: "projection.activated",
    actor,
    scope: "maintainer",
    target,
    reason,
    before: { version: active?.version ?? null },
    after: { version: toVersion, checkpoint: slot.checkpoint },
    at
  });
  return ok({ projection: name, fromVersion: active?.version ?? 0, toVersion, checkpoint: slot.checkpoint, at });
}
