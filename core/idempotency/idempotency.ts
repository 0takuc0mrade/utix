/**
 * Idempotency keys and replay protection for high-risk write operations.
 *
 * Some Utix writes are retried. A network hiccup makes a caller submit the
 * same job twice; a user double-clicks "mark all read"; an export is generated,
 * the tab reloads before the response lands, and the artifact is requested
 * again. Each of those is a *new* HTTP-shaped attempt at a side effect that
 * already happened.
 *
 * A caller that opts a write into this module sends an `IdempotencyKey` with
 * the request. The store keeps the outcome of the first attempt and replays it
 * for every later attempt with the same key, so the side effect happens once.
 * The rules are deliberately strict:
 *
 * - the same key with a **different** request payload is a conflict, not a
 *   replay (`idempotency_key_conflict`) — silently returning the first
 *   response would be worse than an error;
 * - an **expired** key is an explicit error (`idempotency_key_expired`), never
 *   a silent second execution;
 * - a key whose first attempt is still in flight cannot be started twice
 *   (`idempotency_in_flight`);
 * - a recorded failure replays as a recorded failure, so a retry after an
 *   error does not re-run the work;
 * - outcomes are **persisted** through a pluggable storage adapter, so they
 *   survive a reload the way `localStorage` already does for notifications.
 *
 * The clock and the id factory are injected, so a test can replay the exact
 * same sequence and get byte-identical records.
 */

import { recordAudit } from "@/core/audit/audit";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId, redact } from "@/core/telemetry/telemetry";

export type IdempotencyErrorCode =
  | "idempotency_key_missing"
  | "idempotency_key_invalid"
  | "idempotency_key_expired"
  | "idempotency_key_conflict"
  | "idempotency_in_flight"
  | "idempotency_not_found";

/** Where a recorded attempt stands. `in_flight` is the only non-final state. */
export type IdempotencyStatus = "in_flight" | "completed" | "failed";

export interface IdempotencyRecord<T = unknown> {
  readonly key: string;
  /** The operation the key belongs to, e.g. `worker.enqueue`. */
  readonly operation: string;
  /** Stable digest of the request. A mismatch is a conflict. */
  readonly requestHash: string;
  readonly status: IdempotencyStatus;
  /** The persisted outcome, replayed verbatim on every later attempt. */
  readonly response?: T;
  /** Failure code when `status` is `failed`. */
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** How many times a completed record was served again. */
  readonly replays: number;
  readonly correlationId: string;
}

export interface IdempotencyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Key storage prefix; the version is bumped if the record shape changes. */
export const IDEMPOTENCY_STORAGE_PREFIX = "utix:idempotency:v1:";

/** How long a recorded outcome is replayable. */
export const IDEMPOTENCY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface IdempotencyOptions {
  ttlMs?: number;
  /** Injected clock. Defaults to the wall clock. */
  now?: () => number;
  /** Injected key factory, so records are reproducible in a test. */
  newId?: () => string;
  storage?: IdempotencyStorage;
}

export interface BeginRequest {
  key: string | undefined;
  operation: string;
  /** The request being protected. Canonicalised, then digested. */
  request?: unknown;
  correlationId?: string;
}

export type BeginOutcome<T> =
  | { readonly replay: false; readonly record: IdempotencyRecord<T> }
  | { readonly replay: true; readonly record: IdempotencyRecord<T> };

export interface IdempotencyStore {
  /** Claims the key, or replays the recorded outcome. */
  begin<T = unknown>(request: BeginRequest): Result<BeginOutcome<T>, IdempotencyErrorCode>;
  /** Records a success. The response is what later attempts replay. */
  complete<T>(key: string, response: T): Result<IdempotencyRecord<T>, IdempotencyErrorCode>;
  /** Records a failure. Later attempts replay the failure, they do not re-run. */
  fail(key: string, errorCode: string): Result<IdempotencyRecord, IdempotencyErrorCode>;
  /** Releases a claim whose work never started, so the caller may try again. */
  abandon(key: string): Result<true, IdempotencyErrorCode>;
  lookup<T = unknown>(key: string): Result<IdempotencyRecord<T>, IdempotencyErrorCode>;
  /** Drops expired records and returns how many went. */
  sweep(now?: number): number;
  list(): IdempotencyRecord[];
  reset(): void;
}

class MemoryStorage implements IdempotencyStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function browserStorage(): IdempotencyStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    return new MemoryStorage();
  }
  return new MemoryStorage();
}

/**
 * Sorted-key JSON, so `{a:1,b:2}` and `{b:2,a:1}` hash identically.
 *
 * Total over any input: a BigInt is written with its `n` suffix and a cycle as
 * `#cycle`. Neither token is valid JSON, so neither collides with a JSON value,
 * and every input `JSON.stringify` accepts keeps its previous form. Tracking
 * only the current path (not every visited node) keeps shared, acyclic
 * references expanded as before. O(n) time, O(depth) extra space.
 */
export function canonicalize(value: unknown): string {
  const path = new Set<object>();
  const visit = (node: unknown): string => {
    if (typeof node === "bigint") return `${node}n`;
    if (node === null || typeof node !== "object") return JSON.stringify(node) ?? "null";
    if (path.has(node)) return "#cycle";
    path.add(node);
    const body = Array.isArray(node)
      ? `[${node.map(visit).join(",")}]`
      : `{${Object.entries(node as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => `${JSON.stringify(key)}:${visit(entry)}`)
          .join(",")}}`;
    path.delete(node);
    return body;
  };
  return visit(value);
}

/** FNV-1a over the canonical form. A digest, not a signature. */
export function requestDigest(request: unknown): string {
  const source = canonicalize(request);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  }
  return `req-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function isRecord<T>(value: unknown): value is IdempotencyRecord<T> {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<IdempotencyRecord<T>>;
  return (
    typeof item.key === "string" &&
    typeof item.operation === "string" &&
    typeof item.requestHash === "string" &&
    (item.status === "in_flight" || item.status === "completed" || item.status === "failed") &&
    typeof item.createdAt === "string" &&
    typeof item.expiresAt === "string" &&
    typeof item.replays === "number" &&
    typeof item.correlationId === "string"
  );
}

export function createIdempotencyStore(options: IdempotencyOptions = {}): IdempotencyStore {
  const ttlMs = options.ttlMs ?? IDEMPOTENCY_DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? newCorrelationId;
  const storage = options.storage ?? browserStorage();
  const storageKey = (key: string) => `${IDEMPOTENCY_STORAGE_PREFIX}${key}`;

  function read<T>(key: string): IdempotencyRecord<T> | undefined {
    const raw = storage.getItem(storageKey(key));
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord<T>(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  function write<T>(record: IdempotencyRecord<T>): void {
    // Only the recorded *response* is redacted. The envelope's own `key` is the
    // idempotency key, not a secret, and redacting it would make the record
    // unreadable on the next attempt.
    const persistable: IdempotencyRecord<T> = {
      ...record,
      response:
        typeof record.response === "object" && record.response !== null
          ? (redact(record.response) as T)
          : record.response
    };
    storage.setItem(storageKey(record.key), JSON.stringify(persistable));
  }

  function remove(key: string): void {
    storage.removeItem(storageKey(key));
  }

  function all(): IdempotencyRecord[] {
    const records: IdempotencyRecord[] = [];
    if (typeof (storage as { keys?: unknown }).keys === "function") {
      const local = storage as Storage;
      for (let index = 0; index < local.length; index += 1) {
        const storageKeyValue = local.key(index);
        if (!storageKeyValue?.startsWith(IDEMPOTENCY_STORAGE_PREFIX)) continue;
        const raw = local.getItem(storageKeyValue);
        if (!raw) continue;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed)) records.push(parsed);
        } catch {
          // A corrupt entry is dropped rather than blocking a sweep.
        }
      }
      return records;
    }
    // In-memory storage is enumerable through the records we write ourselves.
    for (const key of knownKeys) {
      const record = read(key);
      if (record) records.push(record);
    }
    return records;
  }

  const knownKeys = new Set<string>();

  function claim(request: BeginRequest): IdempotencyRecord {
    const startedAt = now();
    const record: IdempotencyRecord = {
      key: request.key!,
      operation: request.operation,
      requestHash: requestDigest(request.request ?? null),
      status: "in_flight",
      createdAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(startedAt + ttlMs).toISOString(),
      replays: 0,
      correlationId: request.correlationId ?? newId()
    };
    knownKeys.add(record.key);
    write(record);
    return record;
  }

  function telemetry(op: string, payload: Record<string, unknown>, result: "success" | "failure", errorCode?: string): void {
    emitTelemetry({ op, actorType: "system", result, errorCode, payload });
  }

  return {
    begin<T>(request: BeginRequest): Result<BeginOutcome<T>, IdempotencyErrorCode> {
      if (typeof request.key !== "string" || request.key.length === 0) {
        telemetry("idempotency.rejected", { operation: request.operation }, "failure", "idempotency_key_missing");
        return err("idempotency_key_missing");
      }
      if (!isValidIdempotencyKey(request.key)) {
        telemetry(
          "idempotency.rejected",
          { operation: request.operation },
          "failure",
          "idempotency_key_invalid"
        );
        return err("idempotency_key_invalid");
      }

      const existing = read<T>(request.key);
      if (!existing) {
        const record = claim(request) as IdempotencyRecord<T>;
        telemetry("idempotency.claimed", { operation: record.operation, key: record.key }, "success");
        return ok({ replay: false, record });
      }

      // Expired: the caller must present a fresh key. Replaying here would
      // either duplicate the side effect or hide the gap.
      if (Date.parse(existing.expiresAt) <= now()) {
        remove(existing.key);
        telemetry(
          "idempotency.rejected",
          { operation: existing.operation, key: existing.key },
          "failure",
          "idempotency_key_expired"
        );
        return err("idempotency_key_expired");
      }

      // Same key, different request: refuse rather than answer with the wrong
      // response body.
      if (existing.requestHash !== requestDigest(request.request ?? null)) {
        telemetry(
          "idempotency.rejected",
          { operation: existing.operation, key: existing.key },
          "failure",
          "idempotency_key_conflict"
        );
        return err("idempotency_key_conflict");
      }

      // A different operation reusing a key is a collision, not a replay.
      if (existing.operation !== request.operation) {
        telemetry(
          "idempotency.rejected",
          { operation: existing.operation, key: existing.key },
          "failure",
          "idempotency_key_conflict"
        );
        return err("idempotency_key_conflict");
      }

      if (existing.status === "in_flight") {
        telemetry(
          "idempotency.rejected",
          { operation: existing.operation, key: existing.key },
          "failure",
          "idempotency_in_flight"
        );
        return err("idempotency_in_flight");
      }

      const replayed: IdempotencyRecord<T> = { ...existing, replays: existing.replays + 1 };
      write(replayed);
      telemetry(
        "idempotency.replayed",
        { operation: replayed.operation, key: replayed.key, status: replayed.status },
        "success"
      );
      return ok({ replay: true, record: replayed });
    },

    complete<T>(key: string, response: T): Result<IdempotencyRecord<T>, IdempotencyErrorCode> {
      const existing = read<T>(key);
      if (!existing) return err("idempotency_not_found");
      if (existing.status !== "in_flight") return err("idempotency_in_flight");

      const record: IdempotencyRecord<T> = { ...existing, status: "completed", response };
      write(record);
      telemetry("idempotency.completed", { operation: record.operation, key: record.key }, "success");
      return ok(record);
    },

    fail(key: string, errorCode: string): Result<IdempotencyRecord, IdempotencyErrorCode> {
      const existing = read(key);
      if (!existing) return err("idempotency_not_found");
      if (existing.status !== "in_flight") return err("idempotency_in_flight");

      const record: IdempotencyRecord = { ...existing, status: "failed", errorCode };
      write(record);
      telemetry(
        "idempotency.failed",
        { operation: record.operation, key: record.key },
        "failure",
        errorCode
      );
      return ok(record);
    },

    abandon(key: string): Result<true, IdempotencyErrorCode> {
      const existing = read(key);
      if (!existing) return err("idempotency_not_found");
      if (existing.status !== "in_flight") return err("idempotency_in_flight");
      // Releasing a claim lets the same key run again, so it is auditable.
      recordAudit({
        action: "idempotency.claim_released",
        actor: { kind: "system", id: existing.operation },
        target: { kind: "idempotency_record", id: existing.key },
        reason: "claim_abandoned",
        before: { status: existing.status, operation: existing.operation },
        at: existing.createdAt,
        correlationId: existing.correlationId
      });
      remove(key);
      return ok(true);
    },

    lookup<T>(key: string): Result<IdempotencyRecord<T>, IdempotencyErrorCode> {
      const record = read<T>(key);
      if (!record) return err("idempotency_not_found");
      if (Date.parse(record.expiresAt) <= now()) {
        remove(record.key);
        return err("idempotency_key_expired");
      }
      return ok(record);
    },

    sweep(at = now()): number {
      let dropped = 0;
      for (const record of all()) {
        if (Date.parse(record.expiresAt) <= at) {
          remove(record.key);
          knownKeys.delete(record.key);
          dropped += 1;
        }
      }
      if (dropped > 0) {
        telemetry("idempotency.swept", { dropped }, "success");
      }
      return dropped;
    },

    list(): IdempotencyRecord[] {
      return all();
    },

    reset(): void {
      for (const record of all()) remove(record.key);
      knownKeys.clear();
    }
  };
}

/** Outcome of `withIdempotency`. `replayed` tells the caller it was a duplicate. */
export interface IdempotentOutcome<T> {
  readonly value: T;
  readonly replayed: boolean;
  readonly record: IdempotencyRecord<T>;
}

export interface WithIdempotencyRequest<T> {
  key: string | undefined;
  operation: string;
  request?: unknown;
  correlationId?: string;
  run: () => Result<T, string> | Promise<Result<T, string>>;
}

/**
 * The one-call wrapper: claim the key, run the work, persist the outcome, and
 * replay that outcome for every later attempt. A thrown error is treated as a
 * failed attempt and recorded, so a retry replays the failure instead of
 * repeating a side effect that may already have landed.
 */
export async function withIdempotency<T>(
  store: IdempotencyStore,
  request: WithIdempotencyRequest<T>
): Promise<Result<IdempotentOutcome<T>, IdempotencyErrorCode | string>> {
  const begun = store.begin<T>({ key: request.key, operation: request.operation, request: request.request, correlationId: request.correlationId });
  if (!begun.ok) return begun;

  if (begun.value.replay) {
    const record = begun.value.record;
    if (record.status === "failed") return err(record.errorCode ?? "idempotency_replay_failed");
    return ok({ value: record.response as T, replayed: true, record });
  }

  try {
    const result = await request.run();
    if (result.ok) {
      const completed = store.complete(request.key!, result.value);
      if (!completed.ok) return completed;
      return ok({ value: result.value, replayed: false, record: completed.value });
    }
    const failed = store.fail(request.key!, result.code);
    if (!failed.ok) return failed;
    return err(result.code);
  } catch (error) {
    const code = error instanceof Error ? error.name : "unknown";
    store.fail(request.key!, code);
    return err(code);
  }
}
