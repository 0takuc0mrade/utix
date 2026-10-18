/**
 * Operator-safe backfill (#201).
 *
 * A backfill rewrites existing records to a new shape. This module makes that
 * safe to run by hand against live data:
 *
 * - **dry-run first.** The default mode scans everything, writes nothing, and
 *   returns the counts plus a bounded sample of before/after diffs. Applying
 *   is an explicit choice (`apply: true`);
 * - **checkpointed.** Applying saves a checkpoint after every batch. A run that
 *   stops (crash, halt, Ctrl-C) resumes after the last committed record;
 * - **idempotent.** A record the transform leaves unchanged is counted as
 *   `unchanged` and not written, so re-running a backfill, or resuming one
 *   whose last batch half-landed, never rewrites finished records;
 * - **reported, not hidden.** Records the transform declines are `skipped` with
 *   a reason; records that throw, or whose write fails, are `failed`. The run
 *   halts at the end of the batch in which more than `maxFailures` records
 *   have failed since it started;
 * - **single operator.** Checkpoints carry a revision and are saved with
 *   compare-and-set, so two operators running the same backfill cannot both
 *   advance it: the loser stops with `backfill_checkpoint_conflict`;
 * - **reversible.** Every applied update journals the record's before-image in
 *   the checkpoint, and `rollbackBackfill` writes those images back.
 *
 * Records are visited in ascending `id` order through an injected target, and
 * the clock and stores are injected too, so a test can assert an exact run.
 * See `docs/BACKFILL.md` for operating procedure and failure modes.
 */

import { hasPermission, type Role } from "@/core/auth/types";
import { canonicalize } from "@/core/idempotency/idempotency";
import { err, ok, type Result } from "@/core/result/result";
import { redact } from "@/core/telemetry/telemetry";
import type { MigrationDiff } from "./types";

export type BackfillErrorCode =
  | "backfill_invalid_options"
  | "backfill_unauthorized"
  | "backfill_version_mismatch"
  | "backfill_already_completed"
  | "backfill_checkpoint_conflict"
  | "backfill_source_unavailable"
  | "backfill_no_checkpoint";

export interface BackfillRecord {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface BackfillDefinition<T extends BackfillRecord> {
  /** Stable name; also the checkpoint key. */
  readonly id: string;
  /** Bump when the transform changes. A checkpoint from another version is refused. */
  readonly version: string;
  /**
   * Returns the new record, or `err(reason)` to skip a record this backfill
   * does not apply to. Must be idempotent: transforming its own output
   * returns the same record. Must keep `id`.
   */
  readonly transform: (record: T) => Result<T, string>;
}

/** Where records live. `readBatch` returns records with `id` > `afterId`, ascending. */
export interface BackfillTarget<T extends BackfillRecord> {
  readBatch(afterId: string | null, limit: number): Promise<readonly T[]>;
  write(record: T): Promise<void>;
}

export type BackfillStatus = "running" | "halted" | "completed" | "rolled_back";

export interface BackfillSkip {
  readonly id: string;
  readonly reason: string;
}

export interface BackfillFailure {
  readonly id: string;
  readonly error: string;
}

export interface BackfillCheckpoint<T extends BackfillRecord> {
  readonly backfillId: string;
  readonly version: string;
  /** Incremented on every save; the compare-and-set token. */
  readonly revision: number;
  readonly status: BackfillStatus;
  /** Last record whose batch was committed. Resume continues after it. */
  readonly lastId: string | null;
  readonly scanned: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  /** First `BACKFILL_MAX_REPORTED` entries; the counts above are exact. */
  readonly skipped: readonly BackfillSkip[];
  readonly failed: readonly BackfillFailure[];
  /** Before-images of every applied update, in write order. */
  readonly journal: readonly { readonly id: string; readonly before: T }[];
  readonly updatedAt: string;
}

export interface CheckpointStore<T extends BackfillRecord> {
  load(backfillId: string): Promise<BackfillCheckpoint<T> | undefined>;
  /**
   * Stores `checkpoint` only if the stored revision equals `expectedRevision`
   * (`null` meaning none stored). Must be atomic. Returns false on a mismatch.
   */
  save(checkpoint: BackfillCheckpoint<T>, expectedRevision: number | null): Promise<boolean>;
}

export const BACKFILL_DEFAULT_BATCH_SIZE = 100;
export const BACKFILL_MAX_BATCH_SIZE = 10_000;
export const BACKFILL_DEFAULT_MAX_FAILURES = 10;
export const BACKFILL_DEFAULT_SAMPLE_SIZE = 20;
export const BACKFILL_MAX_REPORTED = 1_000;

export interface BackfillOptions<T extends BackfillRecord> {
  /** Backfills need `admin:recovery`. */
  readonly role: Role;
  /** Writes only when true. The default is a dry run. */
  readonly apply?: boolean;
  /** Required to apply. */
  readonly checkpoints?: CheckpointStore<T>;
  /** Apply from the start even if a checkpoint exists (or is completed). */
  readonly restart?: boolean;
  readonly batchSize?: number;
  /** The run halts after the batch in which more than this many records have failed. */
  readonly maxFailures?: number;
  /** How many before/after diffs the report carries. */
  readonly sampleSize?: number;
  readonly now?: () => number;
}

export interface BackfillReport {
  readonly backfillId: string;
  readonly version: string;
  readonly mode: "dry_run" | "apply";
  readonly status: "completed" | "halted";
  /** Id the run resumed after, or `null` when it started from the beginning. */
  readonly resumedAfter: string | null;
  readonly lastId: string | null;
  readonly scanned: number;
  /** Records changed (dry run: records that would change). */
  readonly updated: number;
  readonly unchanged: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly skipped: readonly BackfillSkip[];
  readonly failed: readonly BackfillFailure[];
  /** Bounded sample of the changes, redacted for display. */
  readonly diffs: readonly MigrationDiff[];
  readonly checkpointRevision: number | null;
}

function failureMessage(error: unknown): string {
  return String(redact(error instanceof Error ? error.message : String(error)));
}

function validate<T extends BackfillRecord>(options: BackfillOptions<T>): string | undefined {
  const batchSize = options.batchSize ?? BACKFILL_DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > BACKFILL_MAX_BATCH_SIZE) {
    return `batchSize must be an integer from 1 to ${BACKFILL_MAX_BATCH_SIZE}`;
  }
  const maxFailures = options.maxFailures ?? BACKFILL_DEFAULT_MAX_FAILURES;
  if (!Number.isInteger(maxFailures) || maxFailures < 0) return "maxFailures must be a non-negative integer";
  const sampleSize = options.sampleSize ?? BACKFILL_DEFAULT_SAMPLE_SIZE;
  if (!Number.isInteger(sampleSize) || sampleSize < 0) return "sampleSize must be a non-negative integer";
  if (options.apply && !options.checkpoints) return "applying requires a checkpoint store";
  return undefined;
}

function fresh<T extends BackfillRecord>(definition: BackfillDefinition<T>, at: string): BackfillCheckpoint<T> {
  return {
    backfillId: definition.id,
    version: definition.version,
    revision: 0,
    status: "running",
    lastId: null,
    scanned: 0,
    updated: 0,
    unchanged: 0,
    skippedCount: 0,
    failedCount: 0,
    skipped: [],
    failed: [],
    journal: [],
    updatedAt: at
  };
}

/**
 * Runs a backfill. A dry run (the default) never writes and ignores any
 * checkpoint; it always scans from the start so the diff is complete.
 */
export async function runBackfill<T extends BackfillRecord>(
  definition: BackfillDefinition<T>,
  target: BackfillTarget<T>,
  options: BackfillOptions<T>
): Promise<Result<BackfillReport, BackfillErrorCode, string>> {
  const invalid = validate(options);
  if (invalid) return err("backfill_invalid_options", invalid);
  if (!hasPermission(options.role, "admin:recovery")) return err("backfill_unauthorized");

  const apply = options.apply === true;
  const store = options.checkpoints;
  const now = options.now ?? (() => Date.now());
  const batchSize = options.batchSize ?? BACKFILL_DEFAULT_BATCH_SIZE;
  const maxFailures = options.maxFailures ?? BACKFILL_DEFAULT_MAX_FAILURES;
  const sampleSize = options.sampleSize ?? BACKFILL_DEFAULT_SAMPLE_SIZE;
  const at = () => new Date(now()).toISOString();

  let state = fresh(definition, at());
  let storedRevision: number | null = null;
  let resumedAfter: string | null = null;

  if (apply && store) {
    const existing = await store.load(definition.id);
    if (existing) {
      storedRevision = existing.revision;
      if (!options.restart) {
        if (existing.version !== definition.version) return err("backfill_version_mismatch");
        if (existing.status === "completed" || existing.status === "rolled_back") {
          return err("backfill_already_completed");
        }
        state = existing;
        resumedAfter = existing.lastId;
      } else {
        // A restart rescans from the start but keeps the earlier before-images,
        // so the original data stays recoverable.
        state = { ...state, journal: existing.journal };
      }
    }
  }

  const diffs: MigrationDiff[] = [];
  const skipped: BackfillSkip[] = [...state.skipped];
  const failed: BackfillFailure[] = [...state.failed];
  const journal = [...state.journal];
  let { scanned, updated, unchanged, skippedCount, failedCount } = state;
  /** Failures in this invocation only, so resuming a halted run is not halted again at once. */
  let runFailures = 0;
  let lastId = state.lastId;
  let status: "completed" | "halted" = "completed";
  let revision = storedRevision;

  const snapshot = (running: BackfillStatus): BackfillCheckpoint<T> => ({
    backfillId: definition.id,
    version: definition.version,
    revision: (revision ?? 0) + 1,
    status: running,
    lastId,
    scanned,
    updated,
    unchanged,
    skippedCount,
    failedCount,
    skipped,
    failed,
    journal,
    updatedAt: at()
  });

  const persist = async (running: BackfillStatus): Promise<boolean> => {
    if (!apply || !store) return true;
    const next = snapshot(running);
    if (!(await store.save(next, revision))) return false;
    revision = next.revision;
    return true;
  };

  const recordFailure = (id: string, error: string) => {
    failedCount += 1;
    runFailures += 1;
    if (failed.length < BACKFILL_MAX_REPORTED) failed.push({ id, error });
  };

  for (;;) {
    let batch: readonly T[];
    try {
      batch = await target.readBatch(lastId, batchSize);
    } catch {
      // Progress so far is already saved; the operator resumes once the source is back.
      await persist("halted");
      return err("backfill_source_unavailable");
    }

    let previous = lastId;
    for (const record of batch) {
      if (previous !== null && !(record.id > previous)) {
        await persist("halted");
        return err("backfill_source_unavailable", `records out of order at ${record.id}`);
      }
      previous = record.id;
      scanned += 1;

      let outcome: Result<T, string>;
      try {
        outcome = definition.transform(record);
      } catch (error) {
        recordFailure(record.id, failureMessage(error));
        continue;
      }
      if (!outcome.ok) {
        skippedCount += 1;
        if (skipped.length < BACKFILL_MAX_REPORTED) skipped.push({ id: record.id, reason: outcome.code });
        continue;
      }
      if (outcome.value.id !== record.id) {
        recordFailure(record.id, "transform changed the record id");
        continue;
      }
      if (canonicalize(outcome.value) === canonicalize(record)) {
        unchanged += 1;
        continue;
      }

      if (apply) {
        try {
          await target.write(outcome.value);
        } catch (error) {
          recordFailure(record.id, failureMessage(error));
          continue;
        }
        journal.push({ id: record.id, before: record });
      }
      updated += 1;
      if (diffs.length < sampleSize) {
        diffs.push({
          recordId: record.id,
          action: "update",
          before: redact(record) as Record<string, unknown>,
          after: redact(outcome.value) as Record<string, unknown>
        });
      }
    }

    if (batch.length > 0) lastId = batch[batch.length - 1].id;
    const halted = runFailures > maxFailures;
    const done = batch.length < batchSize;
    status = halted ? "halted" : "completed";
    if (!(await persist(halted ? "halted" : done ? "completed" : "running"))) {
      return err("backfill_checkpoint_conflict");
    }
    if (halted || done) break;
  }

  return ok({
    backfillId: definition.id,
    version: definition.version,
    mode: apply ? "apply" : "dry_run",
    status,
    resumedAfter,
    lastId,
    scanned,
    updated,
    unchanged,
    skippedCount,
    failedCount,
    skipped,
    failed,
    diffs,
    checkpointRevision: apply ? revision : null
  });
}

export interface RollbackReport {
  readonly backfillId: string;
  readonly restored: number;
  /** Records that could not be restored; they stay journaled for another attempt. */
  readonly failed: readonly BackfillFailure[];
}

/**
 * Writes the journaled before-images back, newest first. Restored entries are
 * removed from the journal, so a partly failed rollback can simply be re-run.
 * It overwrites the whole record, including changes made since the backfill.
 */
export async function rollbackBackfill<T extends BackfillRecord>(
  backfillId: string,
  target: BackfillTarget<T>,
  checkpoints: CheckpointStore<T>,
  options: { readonly role: Role; readonly now?: () => number }
): Promise<Result<RollbackReport, BackfillErrorCode>> {
  if (!hasPermission(options.role, "admin:recovery")) return err("backfill_unauthorized");
  const checkpoint = await checkpoints.load(backfillId);
  if (!checkpoint) return err("backfill_no_checkpoint");

  const remaining = [...checkpoint.journal];
  const failures: BackfillFailure[] = [];
  let restored = 0;
  for (let index = checkpoint.journal.length - 1; index >= 0; index -= 1) {
    const entry = checkpoint.journal[index];
    try {
      await target.write(entry.before);
      remaining.splice(index, 1);
      restored += 1;
    } catch (error) {
      failures.push({ id: entry.id, error: failureMessage(error) });
    }
  }

  const now = options.now ?? (() => Date.now());
  const saved = await checkpoints.save(
    {
      ...checkpoint,
      revision: checkpoint.revision + 1,
      status: remaining.length === 0 ? "rolled_back" : checkpoint.status,
      journal: remaining,
      updatedAt: new Date(now()).toISOString()
    },
    checkpoint.revision
  );
  if (!saved) return err("backfill_checkpoint_conflict");
  return ok({ backfillId, restored, failed: failures });
}

/** In-memory checkpoint store: the reference implementation for tests. */
export function createMemoryCheckpointStore<T extends BackfillRecord>(): CheckpointStore<T> {
  const stored = new Map<string, BackfillCheckpoint<T>>();
  return {
    async load(backfillId) {
      return stored.get(backfillId);
    },
    async save(checkpoint, expectedRevision) {
      const current = stored.get(checkpoint.backfillId);
      if ((current?.revision ?? null) !== expectedRevision) return false;
      stored.set(checkpoint.backfillId, checkpoint);
      return true;
    }
  };
}

/** In-memory target over an id-keyed record set: the reference implementation for tests. */
export function createMemoryBackfillTarget<T extends BackfillRecord>(
  initial: readonly T[]
): BackfillTarget<T> & { readonly records: () => readonly T[] } {
  const rows = new Map(initial.map((record) => [record.id, record]));
  const sorted = () => [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    async readBatch(afterId, limit) {
      return sorted()
        .filter((record) => afterId === null || record.id > afterId)
        .slice(0, limit);
    },
    async write(record) {
      rows.set(record.id, record);
    },
    records: sorted
  };
}
